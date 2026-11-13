import socket
from uuid import uuid4

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
    db_url: str | None = None
    db_host: str = "localhost"
    db_password: str = Field(default="", validation_alias="ORDER_DB_PASSWORD")
    rabbitmq_host: str = "localhost"
    order_rabbitmq_password: str = ""
    consul_url: str = "http://localhost:8500"
    consul_enabled: bool = True
    broker_enabled: bool = True
    service_address: str = Field(default_factory=lambda: socket.gethostbyname(socket.gethostname()))
    instance_id: str = Field(default_factory=lambda: f"order-service-{uuid4()}")
    port: int = 8086
    log_level: str | None = None
    shipping_service_url: str | None = None
    cart_service_url: str | None = None
    product_service_url: str | None = None
    inventory_service_url: str | None = None

    @property
    def database_url(self):
        return self.db_url or URL.create("postgresql+psycopg", username="order_service",
            password=self.db_password, host=self.db_host, database="order_db")
