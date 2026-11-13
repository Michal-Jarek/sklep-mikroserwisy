"""Settings of the service: environment variables > Consul KV > defaults (D14).

Passwords come only from environment variables (D6): DB_PASSWORD, RABBITMQ_PASSWORD. When started from
VS Code or a terminal, a local .env file in the service folder (never committed) fills in variables
that are not set.
"""

import os
import socket
from dataclasses import dataclass
from pathlib import Path

SERVICE_NAME = "notification-service"
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
    # HTTP server: 127.0.0.1 from VS Code (patterns.md, section 1); the image sets HOST=0.0.0.0.
    host: str = "127.0.0.1"
    port: int = 8087
    # Consul (D13, D14)
    consul_host: str = "consul"
    consul_port: int = 8500
    consul_enabled: bool = True
    service_address: str = ""
    instance_id: str = ""
    # MongoDB notification_db (D6): authSource = the database of the service.
    db_host: str = "mongo"
    db_port: int = 27017
    db_name: str = "notification_db"
    db_user: str = "notification_service"
    db_password: str = ""
    # RabbitMQ (docs/events.md): empty host = consumer off (only tests and local work, with a warning).
    rabbitmq_host: str = ""
    rabbitmq_port: int = 5672
    rabbitmq_user: str = "notification-service"
    rabbitmq_password: str = ""
    # SMTP: Mailpit, no login and no TLS (D6).
    smtp_host: str = "mailpit"
    smtp_port: int = 1025
    mail_from: str = "Sklep <sklep@sklep.local>"
    # Tunables, also from KV (keys logLevel, mail.from)
    log_level: str = "info"
    # Fixed address of User instead of Consul: only for tests and local experiments.
    user_service_url: str = ""

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
            db_host=env.get("DB_HOST", cls.db_host),
            db_port=int(env.get("DB_PORT", cls.db_port)),
            db_name=env.get("DB_NAME", cls.db_name),
            db_user=env.get("DB_USER", cls.db_user),
            db_password=env.get("DB_PASSWORD", ""),
            rabbitmq_host=env.get("RABBITMQ_HOST", ""),
            rabbitmq_port=int(env.get("RABBITMQ_PORT", cls.rabbitmq_port)),
            rabbitmq_user=env.get("RABBITMQ_USER", cls.rabbitmq_user),
            rabbitmq_password=env.get("RABBITMQ_PASSWORD", ""),
            smtp_host=env.get("SMTP_HOST", cls.smtp_host),
            smtp_port=int(env.get("SMTP_PORT", cls.smtp_port)),
            user_service_url=env.get("USER_SERVICE_URL", ""),
        )
        if env.get("MAIL_FROM"):
            settings.mail_from = env["MAIL_FROM"]
        if env.get("LOG_LEVEL"):
            settings.log_level = env["LOG_LEVEL"]
        return settings

    def apply_kv(self, values: dict) -> None:
        """Values from Consul KV; an environment variable with the same meaning still wins."""
        if "logLevel" in values and not os.environ.get("LOG_LEVEL"):
            self.log_level = str(values["logLevel"])
        mail = values.get("mail")
        if isinstance(mail, dict) and mail.get("from") and not os.environ.get("MAIL_FROM"):
            self.mail_from = str(mail["from"])
        self.log_level = self.log_level.lower()
        if self.log_level not in LOG_LEVELS:
            self.log_level = "info"

    @property
    def consumer_enabled(self) -> bool:
        return bool(self.rabbitmq_host)
