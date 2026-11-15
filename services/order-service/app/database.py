"""SQLAlchemy engine. Sessions are used only in short synchronous functions run through asyncio.to_thread,
never across a call to another service (the event loop and the connection pool stay free)."""
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from .config import ConfigError, Settings
from .models import Base

log = logging.getLogger("app.database")
SCHEMA_RETRY_SECONDS = 2
SCHEMA_LOG_EVERY = 15  # attempts: one warning per 30 s while the database is unavailable at start


# CR-13: a server that vanished without closing the connection (network cut, pod restarted elsewhere) gets noticed
# after a few seconds (keepalive probes and the limit for unacknowledged data, ms) instead of after ~15 min of TCP
# retransmissions; otherwise the outbox relay or the consumer hangs on such a connection without any error.
PG_TCP_ARGS = {"keepalives": 1, "keepalives_idle": 5, "keepalives_interval": 2, "keepalives_count": 2,
               "tcp_user_timeout": 5000}


def make_engine(settings: Settings):
    url = settings.database_url
    sqlite = url.get_backend_name() == "sqlite"
    try:
        engine = create_engine(url, pool_pre_ping=True, hide_parameters=True,
            connect_args={"check_same_thread": False} if sqlite else {"connect_timeout": 2, **PG_TCP_ARGS})
    except Exception:
        raise ConfigError("DB_URL has an invalid format (value not shown)") from None
    if sqlite:
        @event.listens_for(engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
    return engine


def make_factory(engine) -> sessionmaker:
    return sessionmaker(engine, expire_on_commit=False)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def create_schema(engine) -> None:
    with engine.begin() as connection:
        if engine.dialect.name == "postgresql":
            # Several instances starting at once create the tables one after another.
            connection.execute(text("SELECT pg_advisory_xact_lock(8086)"))
        Base.metadata.create_all(connection)
        if engine.dialect.name == "postgresql":
            # CR-2 (A1): orders of the first version (PR #17) has no attempt_until, and create_all keeps an existing
            # table as it is. Idempotent, under the same lock; the old order_outbox is no longer read (README).
            connection.execute(text("ALTER TABLE orders ADD COLUMN IF NOT EXISTS attempt_until TIMESTAMP WITH TIME ZONE"))


async def wait_for_schema(engine) -> None:
    """The database may start after the service: retry every 2 s until the tables exist (a wrong host in DB_URL
    looks the same, so the warning is repeated only every SCHEMA_LOG_EVERY attempts)."""
    attempt = 0
    while True:
        try:
            await asyncio.to_thread(create_schema, engine)
            return
        except Exception as exc:  # noqa: BLE001 - only the class is logged (no address, no password)
            if attempt % SCHEMA_LOG_EVERY == 0:
                log.warning("Database unavailable at start, retrying every %s s", SCHEMA_RETRY_SECONDS,
                            extra={"fields": {"reason": type(exc).__name__}})
            attempt += 1
            await asyncio.sleep(SCHEMA_RETRY_SECONDS)
