ARG PYTORCH_IMAGE=nvcr.io/nvidia/pytorch:25.11-py3@sha256:4a85d8cf6fb3a943280960b8948cf4e9b6eca77b4414c68c9b2c7bb863f79b70
FROM ${PYTORCH_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    TOKENIZERS_PARALLELISM=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

RUN PIP_CONSTRAINT= python3 -m pip install --no-cache-dir --upgrade \
    "transformers==5.5.3" \
    "fastapi==0.124.4" \
    "uvicorn[standard]==0.38.0" \
    "python-multipart==0.0.20" \
    "hf-xet>=1.1.0"

WORKDIR /app
COPY server.py /app/server.py

ENTRYPOINT []
CMD ["python3", "/app/server.py"]
