import os
from pathlib import Path
import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from app.config import Settings
from app.main import create_app

@pytest.fixture(scope="session")
def database_url(tmp_path_factory):
    # PostgreSQL podaj przez TEST_DATABASE_URL; domyślnie izolowana SQLite.
    url = os.getenv("TEST_DATABASE_URL") or f"sqlite:///{tmp_path_factory.mktemp('db') / 'users.db'}"
    cfg = Config(str(Path(__file__).parents[1] / "alembic.ini"))
    cfg.attributes["database_url"] = url
    command.upgrade(cfg, "head")
    command.upgrade(cfg, "head")  # Ponowne uruchomienie migracji niczego nie niszczy.
    return url

@pytest.fixture
def client(database_url):
    app = create_app(Settings(db_url=database_url, consul_enabled=False))
    with TestClient(app) as client:
        yield client
