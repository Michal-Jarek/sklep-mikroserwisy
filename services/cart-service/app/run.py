"""Container entry point: Python is PID 1 and uvicorn handles SIGTERM."""
import uvicorn

if __name__ == "__main__":
    from .config import Settings
    from .http_support import JsonFormatter
    settings = Settings()
    service = "cart-service"
    log_config = {
        "version": 1, "disable_existing_loggers": False,
        "formatters": {"json": {"()": JsonFormatter, "service": service}},
        "handlers": {"stdout": {"class": "logging.StreamHandler", "stream": "ext://sys.stdout", "formatter": "json"}},
        "root": {"handlers": ["stdout"], "level": "WARNING"},
        "loggers": {"uvicorn": {"handlers": ["stdout"], "level": settings.log_level.upper(), "propagate": False}},
    }
    uvicorn.run("app.main:app", host="0.0.0.0", port=settings.port,
                access_log=False, timeout_graceful_shutdown=5, log_config=log_config)
