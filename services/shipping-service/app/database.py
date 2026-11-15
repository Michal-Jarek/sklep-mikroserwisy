"""SQLAlchemy engine and a session limited to one request."""
from fastapi import Request
from sqlalchemy import create_engine, event
from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.orm import sessionmaker

from .config import Settings


# PostgreSQL connections (CR-13): a new connection gives up after 2 s; a connection whose peer vanished from the
# network (no answer at all) is detected by TCP keepalive probes (5 s idle, 2 x 2 s) and by tcp_user_timeout (data not
# acknowledged within 5 s) instead of hanging for the kernel default of minutes.
PG_CONNECT_ARGS = {"connect_timeout": 2, "keepalives": 1, "keepalives_idle": 5, "keepalives_interval": 2,
                   "keepalives_count": 2, "tcp_user_timeout": 5000}


def make_engine(settings: Settings):
    try:
        url = make_url(settings.database_url)
    except ArgumentError:
        # SQLAlchemy quotes the whole address, password included: neither the message nor the cause reach the log.
        raise RuntimeError("DB_URL has an invalid format") from None
    sqlite = url.get_backend_name() == "sqlite"
    engine = create_engine(url, pool_pre_ping=True, hide_parameters=True,
        connect_args={"check_same_thread": False} if sqlite else dict(PG_CONNECT_ARGS))
    if sqlite:
        @event.listens_for(engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
    return engine


def session_dependency(request: Request):
    factory: sessionmaker = request.app.state.session_factory
    with factory() as session:
        yield session
