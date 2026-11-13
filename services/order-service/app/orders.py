import asyncio
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from .database import session_dependency
from .models import Order, Outbox
from .schemas import Checkout
from .security import Caller, current_user, service_caller

router = APIRouter(prefix="/orders")
DB = Annotated[Session, Depends(session_dependency)]
User = Annotated[Caller, Depends(current_user)]
PAID_STATES = ("PAID", "SHIPPED", "DELIVERED")


def now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def update_status(order, status):
    order.status = status
    order.snapshot = {**order.snapshot, "updatedAt": now()}


def view(order):
    body = dict(order.snapshot)
    lines = [dict(line, subtotal=format(Decimal(line["unitPrice"]) * line["quantity"], ".2f"))
             for line in body["items"]]
    body.update(items=lines, itemsTotal=format(Decimal(body["total"]) - Decimal(body["shippingCost"]), ".2f"))
    return dict(id=order.id, userId=order.user_id, status=order.status, **body)


def quantities(order):
    return [{key: line[key] for key in ("productId", "quantity")} for line in order.snapshot["items"]]


def enqueue(db, kind, order, caller):
    payload = dict(orderId=order.id, userId=order.user_id)
    payload.update({k:v for k,v in order.snapshot.items() if k not in ("createdAt","updatedAt")} if kind == "order.created" else {"items": quantities(order)})
    db.add(Outbox(envelope=dict(eventId=str(uuid4()), version=1, type=kind,
        occurredAt=datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), requestId=caller.request_id, payload=payload)))


def owned(db, order_id, caller, lock=False):
    statement = select(Order).where(Order.id == str(order_id))
    if "ADMIN" not in caller.roles:
        statement = statement.where(Order.user_id == str(caller.user_id))
    if lock:
        statement = statement.with_for_update(nowait=True)
    try:
        order = db.scalar(statement.execution_options(populate_existing=True))
    except OperationalError:
        raise HTTPException(503, "Spróbuj ponownie za chwilę") from None
    if order is None:
        raise HTTPException(404, "Nie znaleziono zamówienia")
    return order


@router.post("", status_code=201)
async def checkout(data: Checkout, request: Request, caller: User, db: DB,
                   key: Annotated[UUID | None, Header(alias="Idempotency-Key")] = None):
    key = key or uuid4()
    peers = request.app.state.peers
    existing = select(Order).where(Order.user_id == str(caller.user_id), Order.checkout_key == str(key))
    try:
        async with asyncio.timeout(8):
            order = db.scalar(existing)
            if order is None:
                snapshot = await peers.snapshot(caller, data)
                snapshot["createdAt"] = snapshot["updatedAt"] = now()
                order = Order(id=str(uuid4()), user_id=str(caller.user_id), checkout_key=str(key),
                              status="NEW", snapshot=snapshot)
                db.add(order)
                try:
                    db.commit()
                except IntegrityError:
                    db.rollback()
                    order = db.scalars(existing).one()
            order = owned(db, order.id, caller, lock=True)
            if any(order.snapshot[k] != v for k, v in data.model_dump(exclude={"payment"}).items()):
                raise HTTPException(409, "Klucz zakupu został użyty z innymi danymi")
            if order.status != "NEW":
                return view(order)
            # Inventory must treat a second reservation for the same orderId as a replay.
            try:
                await peers.call("inventory", "POST", "/inventory/reservations", caller,
                             json={"orderId": order.id, "items": quantities(order)})
            except HTTPException as exc:
                if exc.status_code in (400, 404, 409):
                    db.delete(order)
                    db.commit()
                raise
            if data.payment.cardNumber.endswith("0"):
                await peers.call("inventory", "DELETE", f"/inventory/reservations/{order.id}", caller)
                update_status(order, "PAYMENT_FAILED")
                db.commit()
                return view(order)
            update_status(order, "PAID")
            enqueue(db, "order.created", order, caller)
            db.commit()
            result = view(order)
            try:
                await peers.call("cart", "DELETE", f"/cart/{caller.user_id}", caller)
            except HTTPException:
                # Never replay a late cart deletion: the customer may already have added new items.
                logging.warning("Nie udało się opróżnić koszyka po rezerwacji")
            return result
    except TimeoutError:
        raise HTTPException(503, "Przekroczono czas zakupu; ponów z tym samym kluczem") from None


@router.get("")
def orders(db: DB, caller: User, page: Annotated[int, Query(ge=1)] = 1,
           size: Annotated[int, Query(ge=1, le=100)] = 20):
    statement = select(Order).where(Order.user_id == str(caller.user_id))
    total = db.scalar(select(func.count()).select_from(statement.subquery()))
    rows = db.scalars(statement.order_by(Order.snapshot["createdAt"].as_string().desc(), Order.id)
                      .offset((page-1)*size).limit(size))
    items = [dict(id=o.id, status=o.status, total=o.snapshot["total"], currency=o.snapshot["currency"],
                  itemCount=len(o.snapshot["items"]), createdAt=o.snapshot.get("createdAt")) for o in rows]
    return dict(items=items, page=page, size=size, total=total)


@router.get("/purchased", dependencies=[Depends(service_caller)])
def purchased(userId: UUID, productId: UUID, db: DB):
    rows = db.scalars(select(Order).where(Order.user_id == str(userId), Order.status.in_(PAID_STATES)))
    return {"purchased": any(item["productId"] == str(productId) for row in rows for item in row.snapshot["items"])}


@router.get("/{order_id}")
def detail(order_id: UUID, db: DB, caller: User):
    return view(owned(db, order_id, caller))


@router.post("/{order_id}/cancel")
def cancel(order_id: UUID, db: DB, caller: User):
    order = owned(db, order_id, caller, lock=True)
    if order.status not in ("NEW", "PAID"):
        raise HTTPException(409, {"error": "ORDER_NOT_CANCELLABLE", "message": "Nie można anulować zamówienia"})
    update_status(order, "CANCELLED")
    enqueue(db, "order.cancelled", order, caller)
    db.commit()
    return view(order)

