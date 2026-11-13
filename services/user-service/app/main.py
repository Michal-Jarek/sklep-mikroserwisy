"""Składanie aplikacji; migracje wykonuje osobne polecenie Alembic."""
import asyncio
import logging
from contextlib import suppress
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
                await discovery.load_settings(settings)
                async def register_after_http():
                    # Lifespan starts before uvicorn listens. Check our own liveness
                    # in the background, then register, even if the database is down.
                    while True:
                        try:
                            response = await client.get(f"http://127.0.0.1:{settings.port}/health/live")
                            if response.status_code == 200:
                                break
                        except httpx.HTTPError:
                            pass
                        await asyncio.sleep(0.1)
                    await discovery.try_register()
                    await discovery.maintain_registration()
                registration = asyncio.create_task(register_after_http())
                try:
                    yield
                finally:
                    registration.cancel()
                    with suppress(asyncio.CancelledError):
                        await registration
            finally:
                await discovery.close()
                engine.dispose()

    app = FastAPI(title="User Service", version="1.0.0", lifespan=lifespan, redirect_slashes=False)
    app.state.engine = engine
    app.state.session_factory = sessionmaker(engine, expire_on_commit=False)
    configure_http(app, "user-service", settings.instance_id, settings.log_level)
    app.include_router(router)

    @app.exception_handler(IntegrityError)
    async def conflict(request: Request, exc: IntegrityError):
        request.state.error_type = type(exc).__name__
        return error_response(request, 409, "Profil o takim ID lub e-mailu już istnieje")

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, exc: SQLAlchemyError):
        request.state.error_type = type(exc).__name__
        return error_response(request, 503, "Baza profili jest niedostępna")

    @app.get("/health/live", tags=["health"])
    async def live():
        return {"status": "UP"}

    @app.get("/health/ready", tags=["health"])
    def ready():
        try:
            with engine.connect() as connection:
                connection.execute(select(UserProfile.id).limit(0))
            return {"status": "UP"}
        except SQLAlchemyError:
            raise HTTPException(503, "Baza lub schemat profili są niedostępne") from None

    for route in list(app.routes):
        if getattr(route, "methods", None) and "GET" in route.methods and "HEAD" not in route.methods:
            app.add_api_route(route.path, route.endpoint, methods=["HEAD"],
                              response_model=route.response_model, include_in_schema=False)
    return app

class LazyApplication:
    """Retain app.main:app compatibility without allocating resources on import."""
    def __init__(self):
        self.app = None

    async def __call__(self, scope, receive, send):
        if self.app is None:
            logging.basicConfig(level=logging.WARNING, format="%(message)s")
            self.app = create_app()
        await self.app(scope, receive, send)

app = LazyApplication()
