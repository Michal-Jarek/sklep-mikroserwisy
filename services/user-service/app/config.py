"""Konfiguracja ze środowiska; poświadczenia nigdy nie trafiają do logów."""
from typing import Literal
from socket import gethostname
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    db_url: str | None = None
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "user_db"
    db_user: str = "user_service"
    db_password: str = ""
    consul_url: str = "http://localhost:8500"
    consul_enabled: bool = True
    service_address: str = ""
    port: int = 8082
    instance_id: str = Field(default_factory=lambda: "user-service-" + gethostname())
    log_level: Literal["debug", "info", "warning", "error"] = "info"

    @property
    def database_url(self) -> str | URL:
        # URL.create poprawnie koduje znaki specjalne w haśle.
        return self.db_url or URL.create("postgresql+psycopg", username=self.db_user,
            password=self.db_password, host=self.db_host, port=self.db_port, database=self.db_name)
