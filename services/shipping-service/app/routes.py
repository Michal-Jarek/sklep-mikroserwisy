import logging
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from .database import session_dependency
from .models import History, Shipment, change_status
from .security import Caller, current_user, service_caller

log = logging.getLogger("shipping.routes")
router = APIRouter()
DB = Annotated[Session, Depends(session_dependency)]
User = Annotated[Caller, Depends(current_user)]
Service = Annotated[Caller, Depends(service_caller)]
NEXT = {"PREPARING": "SHIPPED", "SHIPPED": "IN_TRANSIT", "IN_TRANSIT": "DELIVERED"}


Status = Literal["PREPARING", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CANCELLED"]


class Update(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Status


class Cancellation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    orderId: UUID


def view(db, row):
    history = [dict(status=h.status, at=h.at) for h in db.scalars(select(History)
               .where(History.shipment_id == row.id).order_by(History.seq))]
    return dict(id=row.id, orderId=row.order_id, userId=row.user_id, status=row.status,
                method=row.method, trackingNumber=row.tracking, history=history,
                createdAt=history[0]["at"] if history else None,
                updatedAt=history[-1]["at"] if history else None)


def visible(user):
    statement = select(Shipment).where(Shipment.id.is_not(None))
    if "ADMIN" not in user.roles:
        statement = statement.where(Shipment.user_id == str(user.user_id))
    return statement


@router.head("/shipping/methods", include_in_schema=False)
@router.get("/shipping/methods")
def methods(request: Request):
    return [dict(code=code, name=name, price=price, currency="PLN", estimatedDays=days)
            for code, name, price, days in (
                ("COURIER", "Kurier", request.app.state.courier_cost, 2),
                ("PARCEL_LOCKER", "Paczkomat", "9.99", 2),
                ("PICKUP", "Odbiór osobisty", "0.00", 1))]


@router.head("/shipping/methods/{code}", include_in_schema=False)
@router.get("/shipping/methods/{code}")
def method(code: str, request: Request):
    for item in methods(request):
        if item["code"] == code:
            return item
    raise HTTPException(404, "Nieznana metoda dostawy")


@router.get("/shipments")
def shipments(db: DB, user: User, orderId: UUID | None = None, status: Status | None = None,
              page: Annotated[int, Query(ge=1)] = 1, size: Annotated[int, Query(ge=1, le=100)] = 20):
    statement = visible(user)
    if orderId:
        statement = statement.where(Shipment.order_id == str(orderId))
    if status:
        statement = statement.where(Shipment.status == status)
    total = db.scalar(select(func.count()).select_from(statement.subquery()))
    first_event = select(func.min(History.seq)).where(History.shipment_id == Shipment.id).scalar_subquery()
    rows = db.scalars(statement.order_by(first_event.desc(), Shipment.id).offset((page-1)*size).limit(size))
    return dict(items=[view(db, row) for row in rows], page=page, size=size, total=total)


@router.get("/shipments/{shipment_id}")
def detail(shipment_id: UUID, db: DB, user: User):
    shipment = db.scalar(visible(user).where(Shipment.id == str(shipment_id)))
    if shipment is None:
        raise HTTPException(404, "Nie znaleziono przesyłki")
    return view(db, shipment)


@router.patch("/shipments/{shipment_id}/status")
def update(shipment_id: UUID, data: Update, db: DB, user: User):
    if "ADMIN" not in user.roles:
        raise HTTPException(403, "Wymagana rola ADMIN")
    shipment = db.scalar(select(Shipment).where(Shipment.id == str(shipment_id)).with_for_update())
    if shipment is None:
        raise HTTPException(404, "Nie znaleziono przesyłki")
    if NEXT.get(shipment.status) != data.status:
        raise HTTPException(409, {"error": "INVALID_STATUS_TRANSITION", "message": "Niedozwolona zmiana statusu"})
    if data.status == "SHIPPED":
        shipment.tracking = "PL" + UUID(shipment.id).hex.upper()
    change_status(db, shipment, data.status, user.request_id)
    db.commit()
    return view(db, shipment)


@router.post("/shipments/cancel")
def cancel(data: Cancellation, db: DB, caller: Service):
    """Internal (SERVICE only): Order asks before cancelling an order. The row lock serializes this with
    PATCH .../status and with order.created, so a shipment is never both cancelled and dispatched."""
    order_id = str(data.orderId)
    insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
    # Placeholder without a user: X-User-Id of the caller may belong to an admin, order.created fills it in.
    db.execute(insert(Shipment).values(order_id=order_id, status="NEW").on_conflict_do_nothing(index_elements=["order_id"]))
    shipment = db.scalar(select(Shipment).where(Shipment.order_id == order_id).with_for_update())
    if shipment.status in ("SHIPPED", "IN_TRANSIT", "DELIVERED"):
        db.rollback()
        raise HTTPException(409, {"error": "INVALID_STATUS_TRANSITION", "message": "Przesyłka została już nadana"})
    if shipment.status == "NEW":
        shipment.status = "CANCELLED"  # a late order.created creates the shipment as CANCELLED, one event (Z10)
    elif shipment.status == "PREPARING":
        change_status(db, shipment, "CANCELLED", caller.request_id)
    db.commit()
    log.info("Shipment cancelled", extra={"fields": {"orderId": order_id, "shipmentId": shipment.id}})
    return dict(orderId=order_id, shipmentId=shipment.id, status="CANCELLED")
