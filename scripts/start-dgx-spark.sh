#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

ACTION="start"
ACCEPT_MODEL_LICENSES=false
SKIP_BUILD=false
SKIP_DOWNLOAD=false
DEPLOY_APP=true

usage() {
  cat <<'EOF'
Usage: ./scripts/start-dgx-spark.sh [start|status|stop] [options]

Set up and run SparklingKit's reference six-model stack on a 128 GB DGX Spark.

Options:
  --accept-model-licenses  Confirm that you reviewed and accept each model's terms
  --skip-build             Reuse existing local container images
  --skip-download          Reuse model files already present under data/dgx-models
  --models-only            Run the six models and monitor without SparklingKit
  -h, --help               Show this help

Examples:
  ./scripts/start-dgx-spark.sh --accept-model-licenses
  ./scripts/start-dgx-spark.sh --models-only --accept-model-licenses
  ./scripts/start-dgx-spark.sh status
  ./scripts/start-dgx-spark.sh stop
EOF
}

while (($#)); do
  case "$1" in
    start|status|stop)
      ACTION="$1"
      ;;
    --accept-model-licenses)
      ACCEPT_MODEL_LICENSES=true
      ;;
    --skip-build)
      SKIP_BUILD=true
      ;;
    --skip-download)
      SKIP_DOWNLOAD=true
      ;;
    --models-only)
      DEPLOY_APP=false
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

COMPOSE=(
  docker compose
  --project-name sparklingkit
  --file compose.yaml
  --file compose.spark.yaml
  --file compose.dgx.yaml
)

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$1" >&2
    exit 1
  fi
}

require_command docker
require_command curl

if ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Compose v2 is required.\n' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf 'The Docker daemon is not available.\n' >&2
  exit 1
fi

if [[ "$ACTION" == "stop" ]]; then
  if [[ "$DEPLOY_APP" == "true" ]]; then
    "${COMPOSE[@]}" stop
    printf 'SparklingKit and the DGX model services are stopped. Persistent data was kept.\n'
  else
    "${COMPOSE[@]}" stop qwen36 qwen3-asr unlimited-ocr hy-mt2 locateanything z-image dgx-status
    printf 'The DGX model services are stopped. Persistent model data was kept.\n'
  fi
  exit 0
fi

endpoint_status() {
  local label="$1"
  local url="$2"
  if curl --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; then
    printf '  %-18s ready\n' "$label"
  else
    printf '  %-18s unavailable\n' "$label"
  fi
}

show_status() {
  "${COMPOSE[@]}" ps
  printf '\nEndpoints\n'
  endpoint_status "System status" "http://127.0.0.1:8330/health"
  endpoint_status "Multimodal LLM" "http://127.0.0.1:8331/v1/models"
  endpoint_status "OCR" "http://127.0.0.1:8332/v1/models"
  endpoint_status "Transcription" "http://127.0.0.1:8333/v1/models"
  endpoint_status "Translation" "http://127.0.0.1:8334/health"
  endpoint_status "Grounding" "http://127.0.0.1:8335/health"
  endpoint_status "Image generation" "http://127.0.0.1:8336/health"
  if [[ "$DEPLOY_APP" == "true" ]]; then
    endpoint_status "SparklingKit" "http://127.0.0.1:54321/api/health"
  fi
}

if [[ "$ACTION" == "status" ]]; then
  show_status
  exit 0
fi

machine_arch="$(uname -m)"
if [[ "$(uname -s)" != "Linux" || "$machine_arch" != "aarch64" ]]; then
  printf 'This reference stack is validated for the ARM64 NVIDIA DGX Spark (detected %s/%s).\n' "$(uname -s)" "$machine_arch" >&2
  printf 'Use compose.yaml with your own service endpoints on other systems.\n' >&2
  exit 1
fi

require_command nvidia-smi
if ! nvidia-smi >/dev/null 2>&1; then
  printf 'NVIDIA GPU access is unavailable. Check the DGX driver and container runtime.\n' >&2
  exit 1
fi

if [[ ! -x /usr/local/cuda-13.0/bin/ptxas ]]; then
  printf 'CUDA 13 ptxas was not found at /usr/local/cuda-13.0/bin/ptxas.\n' >&2
  printf 'Update DGX OS/CUDA or adjust the ASR mount in compose.dgx.yaml.\n' >&2
  exit 1
fi

model_root="$PROJECT_DIR/data/dgx-models"
license_marker="$model_root/.model-licenses-accepted"
mkdir -p "$model_root" "$PROJECT_DIR/data/dgx-runtime" "$PROJECT_DIR/data/dgx-outputs/images"

if [[ "$ACCEPT_MODEL_LICENSES" == "true" ]]; then
  touch "$license_marker"
elif [[ ! -f "$license_marker" ]]; then
  cat >&2 <<'EOF'
The model weights are not covered by SparklingKit's Apache 2.0 license.
Review the six publishers' model cards before downloading. In particular,
nvidia/LocateAnything-3B is currently licensed for non-commercial/research use.
EOF
  if [[ -t 0 ]]; then
    printf 'Have you reviewed and accepted the model terms? [y/N] ' >&2
    read -r answer
    if [[ "$answer" == "y" || "$answer" == "Y" ]]; then
      touch "$license_marker"
    else
      printf 'Setup cancelled. Re-run with --accept-model-licenses after reviewing the terms.\n' >&2
      exit 1
    fi
  else
    printf 'Re-run with --accept-model-licenses after reviewing the terms.\n' >&2
    exit 1
  fi
fi

if [[ "$SKIP_BUILD" != "true" ]]; then
  printf '\nBuilding SparklingKit and DGX service images...\n'
  build_targets=(model-downloader qwen3-asr hy-mt2 locateanything z-image dgx-status)
  if [[ "$DEPLOY_APP" == "true" ]]; then build_targets+=(app); fi
  "${COMPOSE[@]}" --profile tools build "${build_targets[@]}"
  pull_targets=(qwen36 unlimited-ocr)
  if [[ "$DEPLOY_APP" == "true" ]]; then pull_targets+=(redis); fi
  "${COMPOSE[@]}" pull "${pull_targets[@]}"
fi

download_model() {
  local repository="$1"
  local revision="$2"
  local destination="$3"
  local completion_marker="$model_root/$destination/.sparklingkit-$revision.complete"

  if [[ -f "$completion_marker" ]]; then
    printf 'Using existing %-34s %s\n' "$repository" "$revision"
    return
  fi

  printf 'Downloading %-34s %s\n' "$repository" "$revision"
  mkdir -p "$model_root/$destination"
  "${COMPOSE[@]}" --profile tools run --rm --no-deps \
    --user "$(id -u):$(id -g)" \
    model-downloader \
    download "$repository" \
    --revision "$revision" \
    --local-dir "/models/$destination" \
    --max-workers 8

  if [[ ! -s "$model_root/$destination/config.json" && ! -s "$model_root/$destination/model_index.json" ]]; then
    printf 'Download validation failed for %s: no model configuration found\n' "$repository" >&2
    exit 1
  fi
  touch "$completion_marker"
}

if [[ "$SKIP_DOWNLOAD" != "true" ]]; then
  printf '\nDownloading pinned model revisions (existing downloads are reused)...\n'
  download_model \
    "nvidia/Qwen3.6-35B-A3B-NVFP4" \
    "491c2f1ea524c639598bf8fa787a93fed5a6fbce" \
    "nvidia/Qwen3.6-35B-A3B-NVFP4"
  download_model \
    "baidu/Unlimited-OCR" \
    "27a5997fa0524f9adcf9e2f3d5e7d3f784434fa5" \
    "baidu/Unlimited-OCR"
  download_model \
    "Qwen/Qwen3-ASR-1.7B" \
    "7278e1e70fe206f11671096ffdd38061171dd6e5" \
    "Qwen/Qwen3-ASR-1.7B"
  download_model \
    "tencent/Hy-MT2-1.8B-FP8" \
    "b3f6f590920726d69a5504293bd4f36d50e5f681" \
    "tencent/Hy-MT2-1.8B-FP8"
  download_model \
    "nvidia/LocateAnything-3B" \
    "c32291ca5e996f5a7a485845b4f57a233936bba0" \
    "nvidia/LocateAnything-3B"
  download_model \
    "Tongyi-MAI/Z-Image-Turbo" \
    "f332072aa78be7aecdf3ee76d5c247082da564a6" \
    "Tongyi-MAI/Z-Image-Turbo"
fi

wait_for_endpoint() {
  local service="$1"
  local label="$2"
  local url="$3"
  local timeout_seconds="$4"
  local started_at
  started_at="$(date +%s)"

  printf 'Waiting for %s' "$label"
  while ! curl --fail --silent --show-error --max-time 3 "$url" >/dev/null 2>&1; do
    if (( $(date +%s) - started_at >= timeout_seconds )); then
      printf '\n%s did not become ready within %s seconds.\n' "$label" "$timeout_seconds" >&2
      "${COMPOSE[@]}" logs --tail 120 "$service" >&2
      exit 1
    fi
    printf '.'
    sleep 5
  done
  printf ' ready\n'
}

start_service() {
  local service="$1"
  local label="$2"
  local url="$3"
  local timeout_seconds="$4"

  printf '\nStarting %s...\n' "$label"
  "${COMPOSE[@]}" up -d --no-deps "$service"
  wait_for_endpoint "$service" "$label" "$url" "$timeout_seconds"
}

printf '\nStarting the six models sequentially...\n'
start_service qwen36 "Multimodal LLM" "http://127.0.0.1:8331/v1/models" 900
start_service qwen3-asr "Transcription" "http://127.0.0.1:8333/v1/models" 600
start_service unlimited-ocr "OCR" "http://127.0.0.1:8332/v1/models" 600
start_service hy-mt2 "Translation" "http://127.0.0.1:8334/health" 600
start_service locateanything "Grounding" "http://127.0.0.1:8335/health" 900
start_service z-image "Image generation" "http://127.0.0.1:8336/health" 1200
start_service dgx-status "System status" "http://127.0.0.1:8330/health" 120

if [[ "$DEPLOY_APP" == "true" ]]; then
  printf '\nStarting Redis and SparklingKit...\n'
  "${COMPOSE[@]}" up -d redis app
  wait_for_endpoint app "SparklingKit" "http://127.0.0.1:54321/api/health" 180
  printf '\nSparklingKit is ready at http://localhost:54321\n\n'
else
  dgx_address="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  printf '\nThe DGX model stack is ready.\n'
  if [[ -n "$dgx_address" ]]; then
    printf 'Use %s as the model host when setting up SparklingKit on another server.\n\n' "$dgx_address"
  else
    printf 'Use this DGX Spark hostname or LAN address when setting up SparklingKit.\n\n'
  fi
fi
show_status
