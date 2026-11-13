# Product Service image (docs/patterns.md, section 2; D17).
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
# Dependencies first: this layer is rebuilt only when requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore -r requirements.txt
COPY alembic.ini .
COPY migrations ./migrations
COPY app ./app
# A numeric user without root: Kubernetes (runAsNonRoot) can check it without /etc/passwd.
USER 10001
EXPOSE 8083
# All interfaces in a container: Consul and the Gateway connect from other containers.
# The code defaults to 127.0.0.1 (safe when started from VS Code).
ENV HOST=0.0.0.0 PORT=8083
# Exec form: Python is process 1 and gets SIGTERM directly. Migrations: a separate one-off container
# with the same image and the command ["alembic", "upgrade", "head"] (product-migrate).
CMD ["python", "-m", "app"]
