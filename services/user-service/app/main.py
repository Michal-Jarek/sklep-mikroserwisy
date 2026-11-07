"""Składanie aplikacji; migracje wykonuje osobne polecenie Alembic."""
import logging
from contextlib import asynccontextmanager
import httpx
from fastapi import FastAPI, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.orm import sessionmaker
from .config import Settings
from .database import make_engine
from .discovery import Discovery
from .http_support import configure_http, error_response
from .models import UserProfile
from .routes import router


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings()
    engine = make_engine(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Infrastruktura wewnętrzna nie korzysta z internetowego proxy.
        # Nie służy to dostępowi do zablokowanych domen zewnętrznych.
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            discovery = Discovery(client, settings.consul_url, settings.consul_enabled,
                "user-service", settings.instance_id, settings.service_address, settings.port)
            try:
                await discovery.register()
                yield
            finally:
                await discovery.deregister()
                engine.dispose()

    app = FastAPI(title="User Service", version="1.0.0", lifespan=lifespan)
    app.state.engine = engine
    app.state.session_factory = sessionmaker(engine, expire_on_commit=False)
    configure_http(app, "user-service", settings.instance_id)
    app.include_router(router)

    @app.exception_handler(IntegrityError)
    async def conflict(request: Request, exc: IntegrityError):
        return error_response(request, 409, "Profil o takim ID lub e-mailu już istnieje")

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, exc: SQLAlchemyError):
        return error_response(request, 503, "Baza profili jest niedostępna")

    @app.get("/health/live", tags=["health"])
    def live():
        return {"status": "UP"}

    @app.get("/health/ready", tags=["health"])
    def ready():
        try:
            with engine.connect() as connection:
                connection.execute(select(UserProfile.id).limit(0))
            return {"status": "UP"}
        except SQLAlchemyError:
            raise HTTPException(503, "Baza lub schemat profili są niedostępne") from None

    return app

logging.basicConfig(level=logging.INFO, format="%(message)s")
app = create_app()
