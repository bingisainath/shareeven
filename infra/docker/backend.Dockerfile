# Build from the backend folder: docker build -f ../infra/docker/backend.Dockerfile .
# The same image runs the worker with: python -m app.worker
FROM python:3.12-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app

# System deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini .
COPY scripts ./scripts

# Receipt OCR models (~30 MB) baked into the image, so the first scan doesn't download them
RUN python scripts/ocr_receipt.py --download

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
