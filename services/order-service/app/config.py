import socket

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL
from sqlalchemy.engine import make_url

SERVICE_NAME = "order-service"


class ConfigError(RuntimeError):
    """Invalid configuration. The text is written here and never contains the value (it may hold a password)."""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    db_url: str | None = None
    db_host: str = "localhost"
    db_password: str = Field(default="", validation_alias="ORDER_DB_PASSWORD")
    rabbitmq_host: str = "localhost"
    rabbitmq_port: int = 5672
    rabbitmq_user: str = SERVICE_NAME
    rabbitmq_password: str = ""
    consul_url: str = "http://localhost:8500"
    consul_enabled: bool = True
    broker_enabled: bool = True
    # Empty: the IP address of this instance on the route to Consul (discovery.own_address).
    service_address: str | None = None
    # Empty: order-service-<hostname> (D13); in k8s the pod name.
    instance_id: str | None = None
    port: int = 8086
    log_level: str | None = None
    shipping_service_url: str | None = None
    cart_service_url: str | None = None
    product_service_url: str | None = None
    inventory_service_url: str | None = None

    @property
    def effective_instance_id(self) -> str:
        return self.instance_id or f"{SERVICE_NAME}-{socket.gethostname()}"

    @property
    def database_url(self) -> URL:
        if not self.db_url:
            return URL.create("postgresql+psycopg", username="order_service",
                              password=self.db_password, host=self.db_host, database="order_db")
        try:
            return make_url(self.db_url)
        except Exception:
            # The parser error repeats the whole address together with the password.
            raise ConfigError("DB_URL has an invalid format (value not shown)") from None
