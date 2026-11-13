import logging
import time
from contextlib import contextmanager

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base

logger = logging.getLogger(__name__)


class _State:
    engine: Engine | None = None
    factory: sessionmaker | None = None


def configure(engine: Engine) -> None:
    _State.engine = engine
    _State.factory = sessionmaker(bind=engine, expire_on_commit=False)


def init_engine(url: str) -> None:
    if not url:
        raise RuntimeError("Brak DATABASE_URL")
    configure(create_engine(url, pool_pre_ping=True))


def create_schema(retries: int = 30, delay: float = 2.0) -> None:
    """Tworzy tabele; czeka na bazę, bo przy starcie poda Postgres może jeszcze nie odpowiadać."""
    for attempt in range(1, retries + 1):
        try:
            Base.metadata.create_all(_State.engine)
            return
        except OperationalError:
            if attempt == retries:
                raise
            logger.warning("Baza niedostępna (próba %s/%s), czekam", attempt, retries)
            time.sleep(delay)


def get_db():
    session: Session = _State.factory()
    try:
        yield session
    finally:
        session.close()


@contextmanager
def session_scope():
    session: Session = _State.factory()
    try:
        yield session
    finally:
        session.close()


def ping() -> None:
    with _State.engine.connect() as conn:
        conn.execute(text("SELECT 1"))


def dispose() -> None:
    if _State.engine is not None:
        _State.engine.dispose()
