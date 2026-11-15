FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv
# Dependencies first: this layer is rebuilt only when requirements.txt changes.
COPY requirements.txt .
RUN pip install --root-user-action=ignore -r requirements.txt
COPY app app

# A numeric user without root: Kubernetes (runAsNonRoot) can check it without /etc/passwd.
USER 10001
EXPOSE 8089
# Exec form: Python is process 1 and gets SIGTERM directly; requests get at most 5 s after it (stop < 10 s).
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8089", "--no-access-log", "--timeout-graceful-shutdown", "5"]
