FROM python:3.12-slim

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_XET_HIGH_PERFORMANCE=1

RUN python3 -m pip install --no-cache-dir "huggingface_hub[hf_xet]==0.36.2"

ENTRYPOINT ["hf"]
