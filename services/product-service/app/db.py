"""SQLAlchemy engine and the readiness check of the own database (D15)."""

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

from .config import Settings


def make_engine(settings: Settings) -> Engine:
    url = settings.database_url
    sqlite = str(url).startswith("sqlite")
    return create_engine(
        url,
        pool_pre_ping=True,
        # Values of statements never go to logs or error messages (D16).
        hide_parameters=True,
        connect_args={"check_same_thread": False} if sqlite else {"connect_timeout": 2},
    )


def database_ok(engine: Engine) -> bool:
    """A short query to the own database; the tables must exist (migrations applied)."""
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1 FROM categories LIMIT 1"))
        return True
    except Exception:
        return False
