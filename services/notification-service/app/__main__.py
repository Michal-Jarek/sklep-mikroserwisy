"""Start: python -m app (from the service folder). Settings from the environment and .env."""

import uvicorn

from .main import create_app

app = create_app()

if __name__ == "__main__":
    settings = app.state.settings
    # log_config=None: uvicorn's lines go through the JSON format. After SIGTERM requests get at most
    # 5 s, so the whole stop takes < 10 s (D17).
    uvicorn.run(app, host=settings.host, port=settings.port, log_config=None, access_log=False,
                timeout_graceful_shutdown=5)
