import socket
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Konfiguracja z zmiennych środowiskowych (nazwy w .env.example)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", env_ignore_empty=True)

    service_name: str = "inventory-service"
    service_port: int = 8084
    service_address: str = ""  # adres poda (w K8s z fieldRef status.podIP)
    instance_id: str = ""
    log_level: str = "INFO"

    database_url: str = ""  # np. postgresql+psycopg2://user:haslo@host:5432/inventory_db

    rabbitmq_url: str = ""  # puste = konsument zdarzeń wyłączony
    rabbitmq_exchange: str = "shop.events"
    rabbitmq_queue: str = "inventory.q"
    rabbitmq_prefetch: int = 10
    rabbitmq_max_attempts: int = 3

    consul_enabled: bool = True
    consul_host: str = "consul"
    consul_port: int = 8500

    # Puste jwt_jwks_url = tryb "nagłówki z Gateway" (X-User-Id / X-User-Roles).
    jwt_jwks_url: str = ""
    jwt_issuer: str = ""
    jwt_audience: str = ""

    @property
    def effective_instance_id(self) -> str:
        return self.instance_id or socket.gethostname()

    @property
    def effective_address(self) -> str:
        return self.service_address or socket.gethostbyname(socket.gethostname())


@lru_cache
def get_settings() -> Settings:
    return Settings()
