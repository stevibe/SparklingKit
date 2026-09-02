#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

MODEL_HOST=""
CONFIGURE_LATER=false

usage() {
  cat <<'EOF'
Usage: ./scripts/start-sparklingkit.sh [options]

Start the SparklingKit application without installing models on this machine.

Options:
  --model-host HOST   Connect a fresh installation to the six-model DGX stack
  --configure-later  Start without endpoints and use the first-run setup screen
  -h, --help         Show this help

Examples:
  ./scripts/start-sparklingkit.sh --model-host dgx-spark.local
  ./scripts/start-sparklingkit.sh --configure-later
EOF
}

while (($#)); do
  case "$1" in
    --model-host)
      if (($# < 2)); then
        printf '%s requires a hostname or IP address.\n' "$1" >&2
        exit 2
      fi
      MODEL_HOST="$2"
      shift
      ;;
    --configure-later)
      CONFIGURE_LATER=true
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

if [[ -n "$MODEL_HOST" && "$CONFIGURE_LATER" == "true" ]]; then
  printf 'Choose either --model-host or --configure-later, not both.\n' >&2
  exit 2
fi

if [[ -z "$MODEL_HOST" && "$CONFIGURE_LATER" != "true" ]]; then
  printf 'Choose --model-host HOST or --configure-later.\n\n' >&2
  usage >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Engine with Docker Compose v2 is required.\n' >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required for the application readiness check.\n' >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  printf 'The Docker daemon is not available.\n' >&2
  exit 1
fi

EXISTING_SETTINGS=false
if [[ -f "$PROJECT_DIR/data/config/settings.json" ]]; then
  EXISTING_SETTINGS=true
  printf 'Existing SparklingKit settings were found and will be preserved.\n'
  printf 'Use Settings -> General -> Deployment after startup to change saved endpoints.\n\n'
fi

if [[ -n "$MODEL_HOST" ]]; then
  if [[ ! "$MODEL_HOST" =~ ^[a-zA-Z0-9._-]+$ ]]; then
    printf 'Use a hostname or IPv4 address without a scheme, port, or path.\n' >&2
    exit 2
  fi
  export SYSTEM_STATUS_BASE_URL="http://$MODEL_HOST:8330"
  export LLM_BASE_URL="http://$MODEL_HOST:8331/v1"
  export LLM_MODEL="qwen36-35b-a3b-nvfp4"
  export OCR_BASE_URL="http://$MODEL_HOST:8332/v1"
  export OCR_MODEL="Unlimited-OCR"
  export STT_BASE_URL="http://$MODEL_HOST:8333/v1"
  export STT_MODEL="Qwen3-ASR-1.7B"
  export TRANSLATION_BASE_URL="http://$MODEL_HOST:8334/v1"
  export TRANSLATION_MODEL="Hy-MT2-1.8B-FP8"
  export GROUNDING_BASE_URL="http://$MODEL_HOST:8335/v1"
  export GROUNDING_MODEL="nvidia/LocateAnything-3B"
  export IMAGE_GENERATION_BASE_URL="http://$MODEL_HOST:8336/v1"
  export IMAGE_GENERATION_MODEL="Z-Image-Turbo"
  export SPARKLINGKIT_SETUP_COMPLETE="true"
  export SPARKLINGKIT_DEPLOYMENT_MODE="split"
else
  export SYSTEM_STATUS_BASE_URL=""
  export LLM_BASE_URL=""
  export OCR_BASE_URL=""
  export STT_BASE_URL=""
  export TRANSLATION_BASE_URL=""
  export GROUNDING_BASE_URL=""
  export IMAGE_GENERATION_BASE_URL=""
  export SPARKLINGKIT_SETUP_COMPLETE="false"
  export SPARKLINGKIT_DEPLOYMENT_MODE="custom"
fi

docker compose --project-name sparklingkit up -d --build redis app

started_at="$(date +%s)"
printf 'Waiting for SparklingKit'
while ! curl --fail --silent --max-time 3 http://127.0.0.1:54321/api/health >/dev/null 2>&1; do
  if (( $(date +%s) - started_at >= 180 )); then
    printf '\nSparklingKit did not become ready within 180 seconds.\n' >&2
    docker compose --project-name sparklingkit logs --tail 120 app >&2
    exit 1
  fi
  printf '.'
  sleep 3
done
printf ' ready\n'

if [[ "$EXISTING_SETTINGS" == "true" ]]; then
  printf 'SparklingKit is ready at http://localhost:54321 using its existing saved configuration.\n'
elif [[ -n "$MODEL_HOST" ]]; then
  printf 'SparklingKit is ready at http://localhost:54321 and is configured for %s.\n' "$MODEL_HOST"
else
  printf 'SparklingKit is ready at http://localhost:54321. Complete setup in your browser.\n'
fi
