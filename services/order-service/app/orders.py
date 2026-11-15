"""Order REST API (docs/frontend-api.md "Order", wytyczne etapu 8 section 3.1).

Purchase: snapshot (Cart, Shipping, Product) → NEW → reservation in Inventory → payment mock → PAID with
order.created in one conditional transaction; steps 1-5 within PURCHASE_SECONDS. The cart is emptied after PAID,
outside that deadline. When the reservation or the deadline fails, the purchase is compensated (reservation released,
NEW deleted; CR-1: without a DELETE when the reservation request never left; CR-3: one more DELETE after
LATE_RELEASE_SECONDS when its result is unknown). Database work runs in threads and never across a call to another
service.
"""
import asyncio
import logging
from decimal import Decimal
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy.exc import SQLAlchemyError

from . import store
from .models import Order
from .peers import Unavailable, rejected
from .schemas import Checkout
from .security import Caller, current_user, service_caller

log = logging.getLogger("app.orders")
router = APIRouter(prefix="/orders")
User = Annotated[Caller, Depends(current_user)]

PURCHASE_SECONDS = 8.0
COMPENSATION_SECONDS = 1.5
CART_CLEANUP_SECONDS = 1.5
# CR-3 (A4): Inventory may still save a reservation after its own answer (or our timeout) — one more idempotent DELETE
# this long after the compensation closes that window; Inventory itself stops saving after its 2 s deadline.
LATE_RELEASE_SECONDS = 3.0
# CR-1: reasons of Unavailable for which the reservation request never reached Inventory (no time left, no instance,
# open breaker, no connection; a POST is retried only while the connection is never made, so the last reason tells).
# Nothing can be reserved then, so nothing is released: the DELETE would fail the same way and keep NEW for nothing.
NOT_SENT = frozenset({"deadline", "NoInstances", "CircuitOpen", "ConnectError", "ConnectTimeout", "PoolTimeout"})
LATE_RELEASES: set[asyncio.Task] = set()  # references to running late releases (a bare task may be collected)

NOT_CREATED = "Zamówienie nie powstało; spróbuj ponownie"
RETRY_SAME_KEY = "Nie udało się dokończyć zakupu; ponów z tym samym kluczem"
IN_PROGRESS = "Zakup jest w toku; ponów z tym samym kluczem"
NOT_CANCELLABLE = {"error": "ORDER_NOT_CANCELLABLE", "message": "Nie można anulować zamówienia"}
INSUFFICIENT_STOCK = {"error": "INSUFFICIENT_STOCK", "message": "Brak zapasu"}


def view(order: Order) -> dict:
    body = dict(order.snapshot)
    lines = [dict(line, subtotal=format(Decimal(line["unitPrice"]) * line["quantity"], ".2f"))
             for line in body["items"]]
    body.update(items=lines, itemsTotal=format(Decimal(body["total"]) - Decimal(body["shippingCost"]), ".2f"))
    return dict(id=order.id, userId=order.user_id, status=order.status, **body)


def reservation_items(order: Order) -> list[dict]:
    return [{key: line[key] for key in ("productId", "quantity")} for line in order.snapshot["items"]]


async def release(order: Order, caller: Caller, peers, deadline: float) -> bool:
    """DELETE of the reservation; 2xx, 404 and 409 mean "nothing left to release"."""
    try:
        response = await peers.call("inventory", "DELETE", f"/inventory/reservations/{order.id}", caller, deadline)
    except Unavailable:
        return False
    if response.is_success or response.status_code in (404, 409):
        return True
    rejected("inventory", response)
    return False


async def keep_new(factory, order: Order, reason: str, deadline: float) -> HTTPException:
    """Compensation failed: NEW stays for a retry with the same Idempotency-Key, which finishes the purchase."""
    log.error("Compensation failed, NEW order kept", extra={"fields": {"orderId": order.id, "reason": reason}})
    try:
        async with asyncio.timeout_at(deadline):
            await asyncio.to_thread(store.release_claim, factory, order.id)
    except (TimeoutError, SQLAlchemyError):
        pass  # the claim expires by itself after store.ATTEMPT_SECONDS
    return HTTPException(503, RETRY_SAME_KEY)


async def compensate(factory, peers, order: Order, caller: Caller, reason: str, sent: bool = True,
                     unknown: bool = False) -> HTTPException:
    """S4: release the reservation, then delete NEW → 503 "not created"; within COMPENSATION_SECONDS.

    sent=False (CR-1): the reservation request never reached Inventory, so NEW is deleted without a DELETE.
    unknown=True (CR-3): the request went out and no answer tells what Inventory did; after NEW is deleted one more
    DELETE follows LATE_RELEASE_SECONDS later. Not when NEW is kept: a retry with the same key needs the reservation.
    """
    deadline = asyncio.get_running_loop().time() + COMPENSATION_SECONDS
    if sent and not await release(order, caller, peers, deadline):
        return await keep_new(factory, order, f"{reason}; reservation not released", deadline)
    try:
        async with asyncio.timeout_at(deadline):
            await asyncio.to_thread(store.delete_new, factory, order.id)
    except (TimeoutError, SQLAlchemyError) as exc:
        return await keep_new(factory, order, f"{reason}; {type(exc).__name__}", deadline)
    if unknown:
        task = asyncio.create_task(release_later(order, caller, peers))
        LATE_RELEASES.add(task)
        task.add_done_callback(LATE_RELEASES.discard)
    log.warning("Purchase compensated", extra={"fields": {"orderId": order.id, "reason": reason}})
    return HTTPException(503, NOT_CREATED)


async def release_later(order: Order, caller: Caller, peers) -> None:
    """CR-3: the one late, idempotent DELETE of a compensated reservation whose result was unknown."""
    await asyncio.sleep(LATE_RELEASE_SECONDS)
    if await release(order, caller, peers, asyncio.get_running_loop().time() + COMPENSATION_SECONDS):
        log.info("Reservation released again after compensation", extra={"fields": {"orderId": order.id}})
    else:
        log.warning("Late release of the reservation failed", extra={"fields": {"orderId": order.id}})


async def take_order(factory, peers, caller: Caller, data: Checkout, key: str, deadline: float,
                     stage: dict) -> tuple[Order, bool]:
    """Steps 1-2: the order of this key, or a new NEW from the snapshot; True when this attempt may continue it."""
    user_id = str(caller.user_id)
    order = await asyncio.to_thread(store.find_by_key, factory, user_id, key)
    owned = False
    if order is None:
        snapshot = await peers.snapshot(caller, data, deadline)
        snapshot["createdAt"] = snapshot["updatedAt"] = store.now_text()
        stage["saving_new"] = True  # from here a timeout does not stop the thread: NEW may still be saved
        order, owned = await asyncio.to_thread(store.create_new, factory, user_id, key, snapshot)
        if order is None:
            raise HTTPException(503, NOT_CREATED)
    if any(order.snapshot[k] != v for k, v in data.model_dump(exclude={"payment"}).items()):
        raise HTTPException(409, "Klucz zakupu został użyty z innymi danymi")
    if order.status != "NEW" or owned:
        return order, owned
    if await asyncio.to_thread(store.claim, factory, order.id):
        return order, True  # the earlier attempt ended or was abandoned
    current = await asyncio.to_thread(store.get, factory, order.id)
    if current is None:
        raise HTTPException(503, NOT_CREATED)  # deleted by the compensation of the other attempt
    if current.status != "NEW":
        return current, False
    raise HTTPException(503, IN_PROGRESS)


@router.post("", status_code=201)
async def checkout(data: Checkout, request: Request, caller: User,
                   key: Annotated[UUID | None, Header(alias="Idempotency-Key")] = None):
    factory = request.app.state.session_factory
    peers = request.app.state.peers
    loop = asyncio.get_running_loop()
    deadline = loop.time() + PURCHASE_SECONDS
    stage = {"saving_new": False}
    try:
        async with asyncio.timeout_at(deadline):
            order, owned = await take_order(factory, peers, caller, data, str(key or uuid4()), deadline, stage)
    except TimeoutError:
        # Nothing reserved yet. CR-5: during the save of NEW the order may still appear; a retry with the same key
        # finishes it, so the client is told to retry with it.
        raise HTTPException(503, RETRY_SAME_KEY if stage["saving_new"] else NOT_CREATED) from None
    except Unavailable as exc:
        raise HTTPException(503, f"Usługa {exc.service} niedostępna") from None
    if not owned:
        return view(order)  # same key again: the same order
    try:
        return await purchase(factory, peers, order, data, caller, deadline)
    except SQLAlchemyError:
        try:
            await asyncio.wait_for(asyncio.to_thread(store.release_claim, factory, order.id), 1)
        except (TimeoutError, SQLAlchemyError):
            pass
        raise


async def purchase(factory, peers, order: Order, data: Checkout, caller: Caller, deadline: float) -> dict:
    """Steps 3-6 for a NEW order owned by this attempt."""
    loop = asyncio.get_running_loop()
    try:
        async with asyncio.timeout_at(deadline):
            response = await peers.call("inventory", "POST", "/inventory/reservations", caller, deadline,
                                        json={"orderId": order.id, "items": reservation_items(order)})
            if response.status_code in (404, 409):
                await asyncio.to_thread(store.delete_new, factory, order.id)  # no reservation was made
                raise HTTPException(409, INSUFFICIENT_STOCK)
            if not response.is_success:
                raise rejected("inventory", response)
    except (Unavailable, TimeoutError) as exc:
        reason = exc.reason if isinstance(exc, Unavailable) else "purchase deadline"
        sent = reason not in NOT_SENT
        # Unknown result: the request went out, but no answer says what Inventory did (timeout, broken connection,
        # 5xx). A 4xx answer is a refusal: nothing reserved.
        unknown = sent and not reason.startswith("HTTP 4")
        raise await compensate(factory, peers, order, caller, f"reservation: {reason}", sent, unknown)

    if loop.time() >= deadline:
        raise await compensate(factory, peers, order, caller, "deadline before payment")
    if data.payment.cardNumber.endswith("0"):
        # Payment mock refused the card: PAYMENT_FAILED only after the reservation is released.
        if not await release(order, caller, peers, deadline):
            raise await keep_new(factory, order, "payment failed; reservation not released",
                                 loop.time() + COMPENSATION_SECONDS)
        failed = await asyncio.to_thread(store.change_status, factory, order.id, ("NEW",), "PAYMENT_FAILED")
        return view(failed or await current_or_gone(factory, order))

    try:
        async with asyncio.timeout_at(deadline):
            paid = await asyncio.to_thread(store.change_status, factory, order.id, ("NEW",), "PAID",
                                           "order.created", caller.request_id)
    except TimeoutError:
        # The database did not answer in time; PAID may still be saved, so nothing is released.
        log.error("Saving PAID timed out", extra={"fields": {"orderId": order.id}})
        raise HTTPException(503, RETRY_SAME_KEY) from None
    if paid is None:
        # Cancelled during the purchase: the cancellation wins, the reservation goes back.
        current = await current_or_gone(factory, order)
        if current.status != "PAID" and not await release(order, caller, peers,
                                                          loop.time() + COMPENSATION_SECONDS):
            log.error("Reservation of a cancelled order not released", extra={"fields": {"orderId": order.id}})
        return view(current)

    # Step 6: PAID is saved, so the answer is 201 PAID whatever happens to the cart (S3); never retried,
    # a late deletion could remove products the customer has added since.
    try:
        response = await peers.call("cart", "DELETE", f"/cart/{caller.user_id}", caller,
                                    loop.time() + CART_CLEANUP_SECONDS)
        if not response.is_success:
            log.warning("Cart not emptied after purchase", extra={"fields": {
                "orderId": paid.id, "status": response.status_code}})
    except Unavailable as exc:
        log.warning("Cart not emptied after purchase", extra={"fields": {"orderId": paid.id, "reason": exc.reason}})
    return view(paid)


async def current_or_gone(factory, order: Order) -> Order:
    current = await asyncio.to_thread(store.get, factory, order.id)
    if current is None:
        raise HTTPException(503, NOT_CREATED)
    return current


@router.get("")
@router.head("", include_in_schema=False)
async def orders(request: Request, caller: User, page: Annotated[int, Query(ge=1)] = 1,
                 size: Annotated[int, Query(ge=1, le=100)] = 20):
    rows, total = await asyncio.to_thread(store.list_orders, request.app.state.session_factory,
                                          str(caller.user_id), page, size)
    items = [dict(id=o.id, status=o.status, total=o.snapshot["total"], currency=o.snapshot["currency"],
                  itemCount=len(o.snapshot["items"]), createdAt=o.snapshot.get("createdAt")) for o in rows]
    return dict(items=items, page=page, size=size, total=total)


@router.get("/purchased", dependencies=[Depends(service_caller)])
@router.head("/purchased", dependencies=[Depends(service_caller)], include_in_schema=False)
async def purchased(userId: UUID, productId: UUID, request: Request):
    found = await asyncio.to_thread(store.purchased, request.app.state.session_factory, str(userId), str(productId))
    return {"purchased": found}


async def owned_order(request: Request, order_id: UUID, caller: Caller) -> Order:
    order = await asyncio.to_thread(store.get_owned, request.app.state.session_factory, str(order_id),
                                    str(caller.user_id), "ADMIN" in caller.roles)
    if order is None:
        raise HTTPException(404, "Nie znaleziono zamówienia")
    return order


@router.get("/{order_id}")
@router.head("/{order_id}", include_in_schema=False)
async def detail(order_id: UUID, request: Request, caller: User):
    return view(await owned_order(request, order_id, caller))


@router.post("/{order_id}/cancel")
async def cancel(order_id: UUID, request: Request, caller: User):
    """Variant B: Shipping decides first (under its row lock), then Order saves CANCELLED + order.cancelled."""
    factory = request.app.state.session_factory
    order = await owned_order(request, order_id, caller)
    if order.status not in store.OPEN_STATES:
        raise HTTPException(409, NOT_CANCELLABLE)
    try:
        response = await request.app.state.peers.call("shipping", "POST", "/shipments/cancel", caller,
                                                      json={"orderId": order.id})
    except Unavailable as exc:
        raise HTTPException(503, f"Usługa {exc.service} niedostępna") from None
    if response.status_code == 409:
        raise HTTPException(409, NOT_CANCELLABLE)  # already dispatched
    try:
        confirmed = response.status_code == 200 and response.json().get("status") == "CANCELLED"
    except (ValueError, AttributeError):
        confirmed = False
    if not confirmed:
        rejected("shipping", response)
        raise HTTPException(503, "Usługa shipping niedostępna")
    cancelled = await asyncio.to_thread(store.change_status, factory, order.id, store.OPEN_STATES, "CANCELLED",
                                        "order.cancelled", caller.request_id)
    if cancelled is not None:
        return view(cancelled)
    current = await asyncio.to_thread(store.get, factory, order.id)
    if current is not None and current.status == "CANCELLED":
        return view(current)  # cancelled meanwhile (e.g. self-repair from shipment.status_changed)
    raise HTTPException(409, NOT_CANCELLABLE)
