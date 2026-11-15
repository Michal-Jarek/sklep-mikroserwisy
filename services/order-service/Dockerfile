FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# Dependencies first: this layer is rebuilt only when requirements.txt changes.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app app

# A numeric user without root: Kubernetes (runAsNonRoot) can check it without /etc/passwd.
USER 10001

EXPOSE 8086

# Exec form: Python gets SIGTERM directly. Requests get at most 5 s after SIGTERM (stop < 10 s).
# No access log of uvicorn: the service writes one JSON line per request itself.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8086", "--no-access-log", "--timeout-graceful-shutdown", "5"]
