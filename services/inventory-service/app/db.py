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
    # connect_timeout < 2 s, żeby /health/ready odpowiadał szybciej niż timeout Consula i Kubernetesa
    connect_args = {"connect_timeout": 1} if url.startswith("postgresql") else {}
    configure(create_engine(url, pool_pre_ping=True, connect_args=connect_args))


def create_schema(retries: int = 30, delay: float = 2.0) -> None:
    """Tworzy tabele; czeka na bazę, bo przy starcie poda Postgres może jeszcze nie odpowiadać."""
    for attempt in range(1, retries + 1):
        try:
            with _State.engine.begin() as conn:
                if conn.dialect.name == "postgresql":
                    # kilka instancji startujących naraz: tylko jedna tworzy tabele (blokada znika z końcem transakcji)
                    conn.execute(text("SELECT pg_advisory_xact_lock(7351845)"))
                Base.metadata.create_all(conn)
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
