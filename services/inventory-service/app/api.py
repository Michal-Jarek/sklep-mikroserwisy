import asyncio
import logging

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app import db as database
from app import service
from app.errors import ApiError
from app.ids import uuid_or_400
from app.models import InventoryItem
from app.schemas import ReservationIn, ReservationItem, ReservationOut, StockIn, StockOut
from app.security import admin_only, service_only

logger = logging.getLogger(__name__)

router = APIRouter()
health = APIRouter(tags=["health"])

READY_DB_TIMEOUT = 1.5  # krócej niż timeout sprawdzenia w Consulu (2 s) i w Kubernetesie


def _stock_out(item: InventoryItem) -> StockOut:
    return StockOut(
        product_id=item.product_id,
        quantity=item.quantity,
        reserved=item.reserved,
        available=item.available,
        in_stock=item.available > 0,
    )


@health.get("/health/live")
async def live():
    """Proces żyje: bez bazy i bez wątków, więc odpowiada także przy zawieszonej bazie."""
    return {"status": "UP"}


@health.get("/health/ready")
async def ready(request: Request):
    # zadanie odbiorcy ponawia połączenie samo, więc kończy się tylko przy błędzie programu (zabezpieczenie)
    consumer_task = getattr(request.app.state, "consumer_task", None)
    if consumer_task is not None and consumer_task.done():
        raise ApiError(503, "SERVICE_UNAVAILABLE", "Odbiorca zdarzeń zakończył pracę")
    try:
        await asyncio.wait_for(asyncio.to_thread(database.ping), READY_DB_TIMEOUT)
    except Exception as exc:  # także TimeoutError: baza nie odpowiada
        logger.warning("Baza danych niedostępna", extra={"fields": {"reason": type(exc).__name__}})
        raise ApiError(503, "SERVICE_UNAVAILABLE", "Baza danych niedostępna")
    return {"status": "UP"}


@router.head("/inventory/{product_id}", include_in_schema=False)
@router.get("/inventory/{product_id}", response_model=StockOut, tags=["inventory"])
async def get_stock(product_id: str):
    product_id = uuid_or_400(product_id)

    def work(db: Session) -> StockOut | None:
        item = db.get(InventoryItem, product_id)
        return None if item is None else _stock_out(item)

    stock = await database.run(work)
    if stock is None:
        raise ApiError(404, "NOT_FOUND", "Brak informacji o stanie magazynowym produktu")
    return stock


@router.put("/inventory/{product_id}", response_model=StockOut, tags=["inventory"])
async def put_stock(body: StockIn, product_id: str, _=Depends(admin_only)):
    """Ustawia stan magazynowy (tworzy wpis, jeśli produkt nie ma jeszcze stanu). Tylko ADMIN."""
    product_id = uuid_or_400(product_id)
    return await database.run(lambda db: _stock_out(service.set_stock(db, product_id, body.quantity)))


@router.post("/inventory/reservations", response_model=ReservationOut, status_code=201, tags=["reservations"])
async def create_reservation(body: ReservationIn, response: Response, _=Depends(service_only)):
    """Rezerwuje towar dla zamówienia (wewnętrzne, rola SERVICE). 201 = nowa rezerwacja, 200 = powtórzone żądanie."""

    def work(db: Session) -> tuple[list[ReservationItem], str, bool]:
        rows, created = service.reserve(db, body.order_id, [(i.product_id, i.quantity) for i in body.items])
        items = [ReservationItem(product_id=r.product_id, quantity=r.quantity) for r in rows]
        return items, rows[0].status, created

    items, status, created = await database.run(work)
    if not created:
        response.status_code = 200
    return ReservationOut(order_id=body.order_id, status=status, items=items)


@router.delete("/inventory/reservations/{order_id}", status_code=204, tags=["reservations"])
async def delete_reservation(order_id: str, _=Depends(service_only)):
    """Zwalnia rezerwację zamówienia (wewnętrzne, idempotentne - brak rezerwacji też daje 204)."""
    order_id = uuid_or_400(order_id, "orderId")
    await database.run(lambda db: service.release(db, order_id))
    return Response(status_code=204)
