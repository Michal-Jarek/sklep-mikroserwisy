import logging

from fastapi import APIRouter, Depends, Path, Request, Response
from sqlalchemy.orm import Session

from app import db as database
from app import service
from app.db import get_db
from app.errors import ApiError
from app.ids import uuid_or_400
from app.models import InventoryItem
from app.schemas import ReservationIn, ReservationItem, ReservationOut, StockIn, StockOut
from app.security import admin_only, service_only

logger = logging.getLogger(__name__)

router = APIRouter()
health = APIRouter(tags=["health"])


def _stock_out(item: InventoryItem) -> StockOut:
    return StockOut(
        product_id=item.product_id,
        quantity=item.quantity,
        reserved=item.reserved,
        available=item.available,
        in_stock=item.available > 0,
    )


@health.get("/health/live")
def live():
    return {"status": "UP"}


@health.get("/health/ready")
def ready(request: Request):
    consumer_task = getattr(request.app.state, "consumer_task", None)
    if consumer_task is not None and consumer_task.done():
        raise ApiError(503, "SERVICE_UNAVAILABLE", "Odbiorca zdarzeń zakończył pracę")
    try:
        database.ping()
    except Exception:
        logger.warning("Baza danych niedostępna", exc_info=True)
        raise ApiError(503, "SERVICE_UNAVAILABLE", "Baza danych niedostępna")
    return {"status": "UP"}


@router.head("/inventory/{product_id}", include_in_schema=False)
@router.get("/inventory/{product_id}", response_model=StockOut, tags=["inventory"])
def get_stock(product_id: str, db: Session = Depends(get_db)):
    product_id = uuid_or_400(product_id)
    item = db.get(InventoryItem, product_id)
    if item is None:
        raise ApiError(404, "NOT_FOUND", "Brak informacji o stanie magazynowym produktu")
    return _stock_out(item)


@router.put("/inventory/{product_id}", response_model=StockOut, tags=["inventory"])
def put_stock(
    body: StockIn,
    product_id: str,
    db: Session = Depends(get_db),
    _=Depends(admin_only),
):
    """Ustawia stan magazynowy (tworzy wpis, jeśli produkt nie ma jeszcze stanu). Tylko ADMIN."""
    product_id = uuid_or_400(product_id)
    return _stock_out(service.set_stock(db, product_id, body.quantity))


@router.post("/inventory/reservations", response_model=ReservationOut, status_code=201, tags=["reservations"])
def create_reservation(
    body: ReservationIn,
    response: Response,
    db: Session = Depends(get_db),
    _=Depends(service_only),
):
    """Rezerwuje towar dla zamówienia (wewnętrzne, rola SERVICE). 201 = nowa rezerwacja, 200 = powtórzone żądanie."""
    rows, created = service.reserve(db, body.order_id, [(i.product_id, i.quantity) for i in body.items])
    if not created:
        response.status_code = 200
    return ReservationOut(
        order_id=body.order_id,
        status=rows[0].status,
        items=[ReservationItem(product_id=r.product_id, quantity=r.quantity) for r in rows],
    )


@router.delete("/inventory/reservations/{order_id}", status_code=204, tags=["reservations"])
def delete_reservation(
    order_id: str = Path(min_length=1, max_length=64),
    db: Session = Depends(get_db),
    _=Depends(service_only),
):
    """Zwalnia rezerwację zamówienia (wewnętrzne, idempotentne - brak rezerwacji też daje 204)."""
    service.release(db, order_id)
    return Response(status_code=204)
