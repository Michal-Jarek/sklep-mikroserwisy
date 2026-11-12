# syntax=docker/dockerfile:1
FROM python:3.12.14-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock
RUN groupadd --gid 1000 app && useradd --uid 1000 --gid app --create-home app
COPY --chown=1000:1000 app/ app/
COPY --chown=1000:1000 alembic.ini ./
COPY --chown=1000:1000 migrations/ migrations/
USER 1000:1000
EXPOSE 8082
CMD ["python", "-m", "app.run"]
