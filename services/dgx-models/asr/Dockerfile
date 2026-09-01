ARG VLLM_IMAGE=vllm/vllm-openai:v0.14.0@sha256:e43adb84c41b4581dd056532733e87870112074b3ce53f2949690d4aee16e1ae
FROM ${VLLM_IMAGE}

USER root

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        curl \
        libsndfile1 \
        libsox-fmt-all \
        sox \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --no-cache-dir --ignore-installed "blinker==1.9.0" \
    && python3 -m pip install --no-cache-dir "qwen-asr[vllm]==0.0.6"

ENTRYPOINT []
