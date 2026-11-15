import socket

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import URL

SERVICE_NAME = "shipping-service"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", env_ignore_empty=True)
    db_url: str | None = None
    db_host: str = "localhost"
    db_password: str = Field(default="", validation_alias="SHIPPING_DB_PASSWORD")
    rabbitmq_host: str = "localhost"
    rabbitmq_port: int = 5672
    rabbitmq_user: str = SERVICE_NAME
    rabbitmq_password: str = ""
    consul_url: str = "http://localhost:8500"
    consul_enabled: bool = True
    broker_enabled: bool = True
    # Empty: the address of this instance on the route to Consul (consul_registration.own_address).
    service_address: str | None = None
    # Full instance ID (k8s: the pod name); empty: shipping-service-<hostname> (D13).
    instance_id: str | None = None
    port: int = 8089
    # Takes precedence over logLevel from Consul KV.
    log_level: str | None = None
    courier_cost: str = Field(default="14.99", pattern=r"^\d{1,6}\.\d{2}$")

    @property
    def effective_instance_id(self) -> str:
        return self.instance_id or f"{SERVICE_NAME}-{socket.gethostname()}"

    @property
    def database_url(self):
        return self.db_url or URL.create("postgresql+psycopg", username="shipping_service",
            password=self.db_password, host=self.db_host, database="shipping_db")
