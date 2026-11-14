"""Silnik SQLAlchemy oraz sesja ograniczona do jednego żądania."""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from fastapi import Request
from .config import Settings

def make_engine(settings: Settings):
    url = settings.database_url
    sqlite = str(url).startswith("sqlite")
    engine = create_engine(url, pool_pre_ping=True, hide_parameters=True,
        connect_args={"check_same_thread": False} if sqlite else {"connect_timeout": 2})
    if sqlite:
        @event.listens_for(engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
    return engine


def session_dependency(request: Request):
    factory: sessionmaker = request.app.state.session_factory
    with factory() as session:
        yield session
