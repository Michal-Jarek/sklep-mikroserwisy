FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app ./app

# numeryczny UID, żeby Kubernetes (runAsNonRoot) mógł zweryfikować brak roota
RUN useradd --system --uid 10001 --no-create-home appuser
USER 10001

EXPOSE 8084

# po SIGTERM żądania mają najwyżej 5 s, więc zatrzymanie trwa < 10 s; w kontenerze wszystkie interfejsy (Consul i Gateway łączą się z innych kontenerów)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8084", "--no-access-log", "--timeout-graceful-shutdown", "5"]
