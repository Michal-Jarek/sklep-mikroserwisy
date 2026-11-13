# Notification Service image (docs/patterns.md, section 2; D17).
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
# Dependencies first: this layer is rebuilt only when requirements.txt changes.
COPY requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore -r requirements.txt
COPY app ./app
# A numeric user without root: Kubernetes (runAsNonRoot) can check it without /etc/passwd.
USER 10001
EXPOSE 8087
# All interfaces in a container: Consul connects from another container. The code defaults to 127.0.0.1.
ENV HOST=0.0.0.0 PORT=8087
# Exec form: Python is process 1 and gets SIGTERM directly; uvicorn stops the consumer and deregisters.
CMD ["python", "-m", "app"]
