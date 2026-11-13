from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .database import session_dependency
from .models import History, Shipment, change_status
from .security import Caller, current_user

router = APIRouter()
DB = Annotated[Session, Depends(session_dependency)]
User = Annotated[Caller, Depends(current_user)]
NEXT = {"PREPARING": "SHIPPED", "SHIPPED": "IN_TRANSIT", "IN_TRANSIT": "DELIVERED"}


Status = Literal["PREPARING", "SHIPPED", "IN_TRANSIT", "DELIVERED", "CANCELLED"]


class Update(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Status


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


@router.get("/shipping/methods")
def methods(request: Request):
    return [dict(code=code, name=name, price=price, currency="PLN", estimatedDays=days)
            for code, name, price, days in (
                ("COURIER", "Kurier", request.app.state.courier_cost, 2),
                ("PARCEL_LOCKER", "Paczkomat", "9.99", 2),
                ("PICKUP", "Odbiór osobisty", "0.00", 1))]


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
