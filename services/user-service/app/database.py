"""Silnik SQLAlchemy oraz sesja ograniczona do jednego żądania."""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from fastapi import Request
from .config import Settings

def make_engine(settings: Settings):
    url = settings.database_url
    sqlite = str(url).startswith("sqlite")
    engine = create_engine(url, pool_pre_ping=True, hide_parameters=True,
        connect_args={"check_same_thread": False} if sqlite else {
            "connect_timeout": 2, "tcp_user_timeout": 3000,
            "keepalives": 1, "keepalives_idle": 2, "keepalives_interval": 1,
            "keepalives_count": 2, "options": "-c statement_timeout=2000 -c lock_timeout=1000"},
        **({} if sqlite else {"pool_timeout": 2, "pool_size": 5, "max_overflow": 5}))
    if sqlite:
        @event.listens_for(engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
    return engine


def session_dependency(request: Request):
    factory: sessionmaker = request.app.state.session_factory
    with factory() as session:
        yield session
