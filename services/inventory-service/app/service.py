"""Logika biznesowa magazynu: stany, rezerwacje, zwalnianie.

Rezerwacja to jedna transakcja z blokadą wierszy (SELECT ... FOR UPDATE), żeby dwa
zamówienia nie sprzedały tej samej sztuki. Wiersze blokujemy zawsze w kolejności
rosnącego product_id, co wyklucza zakleszczenia między równoległymi rezerwacjami.
"""
import logging

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.errors import ApiError
from app.models import ACTIVE, RELEASED, InventoryItem, ProcessedEvent, Reservation

logger = logging.getLogger(__name__)


def _lock_items(db: Session, product_ids: list[int]) -> dict[int, InventoryItem]:
    stmt = (
        select(InventoryItem)
        .where(InventoryItem.product_id.in_(product_ids))
        .order_by(InventoryItem.product_id)
        .with_for_update()
    )
    return {item.product_id: item for item in db.scalars(stmt)}


def set_stock(db: Session, product_id: int, quantity: int, _retry: bool = True) -> InventoryItem:
    item = db.get(InventoryItem, product_id, with_for_update=True)
    if item is None:
        item = InventoryItem(product_id=product_id, quantity=quantity, reserved=0)
        db.add(item)
    else:
        if quantity < item.reserved:
            reserved = item.reserved
            db.rollback()
            raise ApiError(409, "CONFLICT", f"Nowy stan ({quantity}) jest mniejszy niż zarezerwowana ilość ({reserved})")
        item.quantity = quantity
    try:
        db.commit()
    except IntegrityError:
        # równoległe utworzenie tego samego produktu - powtarzamy jako aktualizację
        db.rollback()
        if _retry:
            return set_stock(db, product_id, quantity, _retry=False)
        raise
    return item


def _existing_reservations(db: Session, order_id: str) -> list[Reservation]:
    stmt = select(Reservation).where(Reservation.order_id == order_id).order_by(Reservation.product_id)
    return list(db.scalars(stmt))


def reserve(db: Session, order_id: str, items: list[tuple[int, int]]) -> tuple[list[Reservation], bool]:
    """Zwraca (rezerwacje, utworzono_nowe). Powtórzone żądanie dla tego samego zamówienia jest idempotentne."""
    wanted: dict[int, int] = {}
    for product_id, qty in items:
        wanted[product_id] = wanted.get(product_id, 0) + qty

    existing = _existing_reservations(db, order_id)
    if existing:
        if any(r.status != ACTIVE for r in existing):
            raise ApiError(409, "CONFLICT", "Rezerwacja dla tego zamówienia została już zwolniona")
        return existing, False

    ids = sorted(wanted)
    stock = _lock_items(db, ids)

    problems = []
    for pid in ids:
        item = stock.get(pid)
        available = item.available if item else 0
        if available < wanted[pid]:
            problems.append(f"produkt {pid} (dostępne {available}, żądane {wanted[pid]})")
    if problems:
        db.rollback()
        raise ApiError(409, "INSUFFICIENT_STOCK", "Brak wystarczającej ilości towaru: " + "; ".join(problems))

    rows = []
    for pid in ids:
        stock[pid].reserved += wanted[pid]
        row = Reservation(order_id=order_id, product_id=pid, quantity=wanted[pid], status=ACTIVE)
        db.add(row)
        rows.append(row)
    try:
        db.commit()
    except IntegrityError:
        # to samo zamówienie zarezerwowane równolegle przez inne żądanie
        db.rollback()
        existing = _existing_reservations(db, order_id)
        if existing:
            return existing, False
        raise
    return rows, True


def release(db: Session, order_id: str, event_id: str | None = None) -> int:
    """Zwalnia rezerwacje zamówienia (idempotentnie). Zwraca liczbę zwolnionych pozycji.

    Gdy podano event_id, zdarzenie jest zapisywane jako przetworzone w tej samej transakcji.
    """
    if event_id and db.get(ProcessedEvent, event_id) is not None:
        logger.info("Zdarzenie %s było już przetworzone, pomijam", event_id)
        return 0

    stmt = (
        select(Reservation)
        .where(Reservation.order_id == order_id, Reservation.status == ACTIVE)
        .order_by(Reservation.product_id)
        .with_for_update()
    )
    rows = list(db.scalars(stmt))
    if rows:
        stock = _lock_items(db, [r.product_id for r in rows])
        for row in rows:
            item = stock.get(row.product_id)
            if item is not None:
                item.reserved = max(0, item.reserved - row.quantity)
            row.status = RELEASED

    if event_id:
        db.add(ProcessedEvent(event_id=event_id))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()  # to samo zdarzenie przetworzone równolegle przez inną instancję
        return 0
    return len(rows)
