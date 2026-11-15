"""Database work as short synchronous functions (each its own transaction), run through asyncio.to_thread.

No function here waits for another service, so a database connection is never held during an HTTP call (W2).
Status changes are conditional (UPDATE ... WHERE status IN ...): of two concurrent changes only one wins, and an
event goes to the outbox in the same transaction as the change that won.
"""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from .database import utcnow
from .models import Order, Outbox, Processed

PAID_STATES = ("PAID", "SHIPPED", "DELIVERED")
OPEN_STATES = ("NEW", "PAID")
ATTEMPT_SECONDS = 10  # purchase deadline (8 s) + compensation (1.5 s), rounded up
LEASE_SECONDS = 30
BATCH_SIZE = 20


def now_text() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def envelope(kind: str, order: Order, request_id: str) -> dict:
    payload = dict(orderId=order.id, userId=order.user_id)
    if kind == "order.created":
        payload.update({k: v for k, v in order.snapshot.items() if k not in ("createdAt", "updatedAt")})
    else:
        payload["items"] = [{k: line[k] for k in ("productId", "quantity")} for line in order.snapshot["items"]]
    return dict(eventId=str(uuid4()), type=kind, version=1, occurredAt=now_text(), requestId=request_id,
                payload=payload)


def transition(db: Session, order: Order, allowed: tuple[str, ...], status: str,
               event: str | None = None, request_id: str | None = None) -> bool:
    """Conditional status change in an open transaction; with `event` the envelope goes to the outbox."""
    snapshot = {**order.snapshot, "updatedAt": now_text()}
    result = db.execute(update(Order).where(Order.id == order.id, Order.status.in_(allowed))
                        .values(status=status, snapshot=snapshot, attempt_until=None))
    if result.rowcount != 1:
        return False
    order.status, order.snapshot = status, snapshot
    if event:
        db.add(Outbox(envelope=envelope(event, order, request_id)))
    return True


def change_status(factory: sessionmaker, order_id: str, allowed: tuple[str, ...], status: str,
                  event: str | None = None, request_id: str | None = None) -> Order | None:
    """Returns the changed order, or None when the order is gone or no longer in an allowed status."""
    with factory.begin() as db:
        order = db.get(Order, order_id)
        if order is None or not transition(db, order, allowed, status, event, request_id):
            return None
        return order


def get(factory: sessionmaker, order_id: str) -> Order | None:
    with factory() as db:
        return db.get(Order, order_id)


def get_owned(factory: sessionmaker, order_id: str, user_id: str, admin: bool) -> Order | None:
    with factory() as db:
        order = db.get(Order, order_id)
        return order if order is not None and (admin or order.user_id == user_id) else None


def find_by_key(factory: sessionmaker, user_id: str, key: str) -> Order | None:
    with factory() as db:
        return db.scalar(select(Order).where(Order.user_id == user_id, Order.checkout_key == key))


def create_new(factory: sessionmaker, user_id: str, key: str, snapshot: dict) -> tuple[Order, bool]:
    """Saves NEW owned by this attempt; returns (order, True), or the order of a parallel request with the same key."""
    order = Order(id=str(uuid4()), user_id=user_id, checkout_key=key, status="NEW", snapshot=snapshot,
                  attempt_until=utcnow() + timedelta(seconds=ATTEMPT_SECONDS))
    with factory() as db:
        db.add(order)
        try:
            db.commit()
            return order, True
        except IntegrityError:
            db.rollback()
    return find_by_key(factory, user_id, key), False


def claim(factory: sessionmaker, order_id: str) -> bool:
    """Takes over a NEW order whose earlier attempt ended or was abandoned (attempt_until passed)."""
    now = utcnow()
    with factory.begin() as db:
        result = db.execute(update(Order).where(
            Order.id == order_id, Order.status == "NEW",
            or_(Order.attempt_until.is_(None), Order.attempt_until < now),
        ).values(attempt_until=now + timedelta(seconds=ATTEMPT_SECONDS)))
        return result.rowcount == 1


def release_claim(factory: sessionmaker, order_id: str) -> None:
    """NEW stays (compensation failed): a retry with the same key may continue at once."""
    with factory.begin() as db:
        db.execute(update(Order).where(Order.id == order_id, Order.status == "NEW").values(attempt_until=None))


def delete_new(factory: sessionmaker, order_id: str) -> bool:
    with factory.begin() as db:
        return db.execute(delete(Order).where(Order.id == order_id, Order.status == "NEW")).rowcount == 1


def list_orders(factory: sessionmaker, user_id: str, page: int, size: int) -> tuple[list[Order], int]:
    statement = select(Order).where(Order.user_id == user_id)
    with factory() as db:
        total = db.scalar(select(func.count()).select_from(statement.subquery()))
        rows = db.scalars(statement.order_by(Order.snapshot["createdAt"].as_string().desc(), Order.id)
                          .offset((page - 1) * size).limit(size)).all()
        return list(rows), total


def purchased(factory: sessionmaker, user_id: str, product_id: str) -> bool:
    with factory() as db:
        rows = db.scalars(select(Order).where(Order.user_id == user_id, Order.status.in_(PAID_STATES)))
        return any(item["productId"] == product_id for row in rows for item in row.snapshot["items"])


def mark_processed(db: Session, event_id: str) -> bool:
    """Idempotency of the consumer: False when the eventId was already processed (also by a parallel delivery)."""
    insert = sqlite_insert if db.get_bind().dialect.name == "sqlite" else pg_insert
    # RETURNING, not rowcount: SQLAlchemy with psycopg reports rowcount -1 for this insert (also on conflict).
    new = db.scalar(insert(Processed).values(id=event_id).on_conflict_do_nothing(index_elements=["id"])
                    .returning(Processed.id))
    return new is not None


def lease_outbox(factory: sessionmaker) -> list[tuple[int, dict]]:
    """Takes up to BATCH_SIZE free rows (oldest first) for LEASE_SECONDS; another instance skips them."""
    now = utcnow()
    with factory.begin() as db:
        rows = db.scalars(select(Outbox).where(or_(Outbox.locked_until.is_(None), Outbox.locked_until < now))
                          .order_by(Outbox.seq).limit(BATCH_SIZE).with_for_update(skip_locked=True)).all()
        for row in rows:
            row.locked_until = now + timedelta(seconds=LEASE_SECONDS)
        return [(row.seq, row.envelope) for row in rows]


def delete_outbox(factory: sessionmaker, seq: int) -> None:
    with factory.begin() as db:
        db.execute(delete(Outbox).where(Outbox.seq == seq))


def free_outbox(factory: sessionmaker, seqs: list[int]) -> None:
    with factory.begin() as db:
        db.execute(update(Outbox).where(Outbox.seq.in_(seqs)).values(locked_until=None))
