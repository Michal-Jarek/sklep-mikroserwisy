import socket
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Konfiguracja z zmiennych środowiskowych (nazwy w .env.example)."""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore", env_ignore_empty=True)

    service_name: str = "review-service"
    service_port: int = 8088
    service_address: str = ""  # adres rejestrowany w Consulu (w K8s z fieldRef status.podIP); pusty = własny IP
    instance_id: str = ""
    log_level: str = "INFO"

    mongodb_url: str = ""  # np. mongodb://review_service:<hasło>@mongo:27017/review_db
    mongodb_database: str = "review_db"

    # Order Service: adres z Consula; ORDER_SERVICE_URL to opcjonalny adres zapasowy (np. lokalnie)
    order_service_name: str = "order-service"
    order_service_url: str = ""
    http_timeout_seconds: float = 2.0

    consul_enabled: bool = True
    consul_host: str = "consul"
    consul_port: int = 8500

    @property
    def effective_instance_id(self) -> str:
        """ID instancji w Consulu i w nagłówku X-Instance-Id.

        INSTANCE_ID jest pełnym ID (w Kubernetesie nazwa poda, bez dopisywania przedrostka); bez niego <usługa>-<hostname>.
        """
        return self.instance_id or f"{self.service_name}-{socket.gethostname()}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
