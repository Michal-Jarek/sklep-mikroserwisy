"""Konfiguracja z env; stałe adresy zależności to tylko lokalne nadpisania."""
from uuid import uuid4
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    redis_url: str = "redis://localhost:6379/0"
    consul_url: str = "http://localhost:8500"
    consul_enabled: bool = True
    service_address: str = "127.0.0.1"
    port: int = 8085
    instance_id: str = "cart-service-" + str(uuid4())
    product_service_url: str | None = None
    inventory_service_url: str | None = None
