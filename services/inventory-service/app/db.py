import asyncio
import logging
import time
from contextlib import contextmanager
from typing import Callable, TypeVar

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import ArgumentError, OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.models import Base

logger = logging.getLogger(__name__)

T = TypeVar("T")

# limit całej pracy z bazą w jednym żądaniu; wołający (Product, Cart, Order) czekają najwyżej 2 s
DB_CALL_TIMEOUT = 2.0
# najdłuższe czekanie na wolne połączenie z puli (domyślnie SQLAlchemy czeka 30 s)
POOL_TIMEOUT = 2
# limity po stronie PostgreSQL (ms): czekanie na blokadę wiersza i pojedyncze zapytanie kończą się w bazie
# przed DB_CALL_TIMEOUT, więc praca, na którą wołający już nie czeka, nie wisi w bazie dalej
PG_OPTIONS = "-c lock_timeout=1500 -c statement_timeout=1800"
# serwer, który zniknął bez zamknięcia połączenia (zerwana sieć, restart poda): keepalive i limit niepotwierdzonych
# danych (ms) zrywają połączenie po kilku sekundach, zamiast po ~15 min ponowień TCP (wątek odbiorcy wisiałby bez błędu)
PG_TCP_ARGS = {"keepalives": 1, "keepalives_idle": 5, "keepalives_interval": 2, "keepalives_count": 2, "tcp_user_timeout": 5000}


class DatabaseTimeout(Exception):
    """Baza nie odpowiedziała w DB_CALL_TIMEOUT (np. zawieszony serwer: połączenie jest, odpowiedzi brak)."""


class _State:
    engine: Engine | None = None
    factory: sessionmaker | None = None


def configure(engine: Engine) -> None:
    _State.engine = engine
    _State.factory = sessionmaker(bind=engine, expire_on_commit=False)


def init_engine(url: str) -> None:
    if not url:
        raise RuntimeError("Brak DATABASE_URL")
    # libpq traktuje każdą wartość connect_timeout poniżej 2 jako 2 s
    connect_args = {"connect_timeout": 2, "options": PG_OPTIONS, **PG_TCP_ARGS} if url.startswith("postgresql") else {}
    try:
        engine = create_engine(url, pool_pre_ping=True, pool_timeout=POOL_TIMEOUT, connect_args=connect_args)
    except (ArgumentError, ValueError):  # ValueError: np. port, który nie jest liczbą
        # komunikat SQLAlchemy zawiera cały adres razem z hasłem, więc nie może trafić do logu
        logger.error("Niepoprawny format DATABASE_URL (adres pominięty w logu, bo zawiera hasło)")
        raise RuntimeError("Niepoprawny format DATABASE_URL") from None
    configure(engine)


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


@contextmanager
def session_scope():
    session: Session = _State.factory()
    try:
        yield session
    finally:
        session.close()


async def run(work: Callable[[Session], T]) -> T:
    """Wykonuje work(sesja) w wątku z własną sesją i zwraca wynik.

    Zawieszona baza (połączenie jest, odpowiedzi brak) blokowałaby żądanie bez końca, bo psycopg2 nie ma limitu
    czasu zapytania po stronie klienta. Po DB_CALL_TIMEOUT żądanie dostaje 503, a wątek kończy się sam po powrocie bazy.
    Wątek nie może wtedy niczego zapisać: termin trafia do sesji, a commit po terminie jest wycofywany
    (_reject_late_commit). Inaczej np. rezerwacja zapisałaby się po tym, jak Order dostał 503 i już ją zwolnił.
    """
    # termin liczony przy wywołaniu, nie w wątku: wątek z puli może ruszyć dopiero po chwili
    deadline = time.monotonic() + DB_CALL_TIMEOUT

    def call() -> T:
        with session_scope() as session:
            session.info["deadline"] = deadline
            return work(session)

    try:
        return await asyncio.wait_for(asyncio.to_thread(call), DB_CALL_TIMEOUT)
    except TimeoutError:
        raise DatabaseTimeout() from None


@event.listens_for(Session, "before_commit")
def _reject_late_commit(session: Session) -> None:
    """Wołający dostał już 503 (DB_CALL_TIMEOUT minął), więc zapis nie może się udać za jego plecami."""
    deadline = session.info.get("deadline")
    if deadline is not None and time.monotonic() > deadline:
        logger.warning("Operacja na bazie skończyła się po limicie %g s, zmiany wycofane", DB_CALL_TIMEOUT)
        raise DatabaseTimeout()


def ping() -> None:
    with _State.engine.connect() as conn:
        conn.execute(text("SELECT 1"))


def dispose() -> None:
    if _State.engine is not None:
        _State.engine.dispose()
