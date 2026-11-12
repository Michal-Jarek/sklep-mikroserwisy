"""Konfiguracja z env; stałe adresy zależności to tylko lokalne nadpisania."""
from typing import Literal
from socket import gethostname
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    redis_url: str = "redis://localhost:6379/0"
    consul_url: str = "http://localhost:8500"
    consul_enabled: bool = True
    service_address: str = ""
    port: int = 8085
    instance_id: str = Field(default_factory=lambda: "cart-service-" + gethostname())
    log_level: Literal["debug", "info", "warning", "error"] = "info"
    product_service_url: str | None = None
    inventory_service_url: str | None = None
