"""Settings of the service: environment variables > Consul KV > defaults (D14).

Passwords come only from environment variables (D6). When started from VS Code or a terminal,
a local .env file in the service folder (never committed) fills in variables that are not set.
"""

import os
import socket
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import URL

SERVICE_NAME = "product-service"
LOG_LEVELS = ("debug", "info", "warning", "error")


def load_dotenv(path: str | Path = ".env") -> None:
    """Reads KEY=VALUE lines of a local .env file. Variables already set in the environment win."""
    file = Path(path)
    if not file.is_file():
        return
    for line in file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _bool(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    # HTTP server. 127.0.0.1 by default: started from VS Code, the service is reachable only from
    # this laptop (patterns.md, section 1). The image sets HOST=0.0.0.0.
    host: str = "127.0.0.1"
    port: int = 8083
    # Consul (D13, D14)
    consul_host: str = "consul"
    consul_port: int = 8500
    consul_enabled: bool = True
    service_address: str = ""  # empty: own IP on the route to Consul; from VS Code host.docker.internal
    instance_id: str = ""
    # Database (D6). db_url only for tests (e.g. sqlite:///...).
    db_url: str = ""
    db_host: str = "postgres"
    db_port: int = 5432
    db_name: str = "product_db"
    db_user: str = "product_service"
    db_password: str = ""
    # Tunables, also from KV (keys logLevel, cacheTtlSeconds)
    log_level: str = "info"
    cache_ttl_seconds: int = 60
    # Fixed addresses of other services instead of Consul: only for tests and local experiments.
    review_service_url: str = ""
    inventory_service_url: str = ""

    def __post_init__(self) -> None:
        if not self.instance_id:
            self.instance_id = f"{SERVICE_NAME}-{socket.gethostname()}"

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv()
        env = os.environ
        settings = cls(
            host=env.get("HOST", cls.host),
            port=int(env.get("PORT", cls.port)),
            consul_host=env.get("CONSUL_HOST", cls.consul_host),
            consul_port=int(env.get("CONSUL_PORT", cls.consul_port)),
            consul_enabled=_bool(env.get("CONSUL_ENABLED", "true")),
            service_address=env.get("SERVICE_ADDRESS", ""),
            instance_id=env.get("INSTANCE_ID", ""),
            db_url=env.get("DB_URL", ""),
            db_host=env.get("DB_HOST", cls.db_host),
            db_port=int(env.get("DB_PORT", cls.db_port)),
            db_name=env.get("DB_NAME", cls.db_name),
            db_user=env.get("DB_USER", cls.db_user),
            db_password=env.get("DB_PASSWORD", ""),
            review_service_url=env.get("REVIEW_SERVICE_URL", ""),
            inventory_service_url=env.get("INVENTORY_SERVICE_URL", ""),
        )
        if env.get("LOG_LEVEL"):
            settings.log_level = env["LOG_LEVEL"]
        if env.get("CACHE_TTL_SECONDS"):
            settings.cache_ttl_seconds = int(env["CACHE_TTL_SECONDS"])
        return settings

    def apply_kv(self, values: dict) -> None:
        """Values from Consul KV; an environment variable with the same meaning still wins."""
        if "logLevel" in values and not os.environ.get("LOG_LEVEL"):
            self.log_level = str(values["logLevel"])
        if "cacheTtlSeconds" in values and not os.environ.get("CACHE_TTL_SECONDS"):
            self.cache_ttl_seconds = int(values["cacheTtlSeconds"])
        self.log_level = self.log_level.lower()
        if self.log_level not in LOG_LEVELS:
            self.log_level = "info"

    @property
    def database_url(self) -> str | URL:
        # URL.create encodes special characters of the password. Never log this value (D6, D16).
        return self.db_url or URL.create(
            "postgresql+psycopg",
            username=self.db_user,
            password=self.db_password,
            host=self.db_host,
            port=self.db_port,
            database=self.db_name,
        )
