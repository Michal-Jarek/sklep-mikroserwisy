import socket
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Konfiguracja z zmiennych środowiskowych (nazwy w .env.example)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", env_ignore_empty=True)

    service_name: str = "inventory-service"
    service_port: int = 8084
    service_address: str = ""  
    instance_id: str = ""
    log_level: str = "INFO"

    database_url: str = ""  

    rabbitmq_host: str = ""
    rabbitmq_port: int = 5672
    rabbitmq_user: str = ""
    rabbitmq_password: str = ""

    consul_enabled: bool = True
    consul_host: str = "consul"
    consul_port: int = 8500


    @property
    def effective_instance_id(self) -> str:
        """ID instancji w Consulu i w nagłówku X-Instance-Id: <usługa>-<hostname>."""
        return self.instance_id or f"{self.service_name}-{socket.gethostname()}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
