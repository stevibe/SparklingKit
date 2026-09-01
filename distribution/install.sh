#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${SPARKLINGKIT_INSTALL_DIR:-$PWD/sparklingkit}"
ASSET_BASE_URL="${SPARKLINGKIT_ASSET_BASE_URL:-https://run.sparklingkit.com/stable}"
FROM_SOURCE=false
NO_START=false

usage() {
  cat <<'EOF'
Usage: install.sh [--dir PATH] [--from-source] [--no-start]

Install the prebuilt SparklingKit application and Redis with Docker Compose.
The installer never installs Docker and never removes an existing data folder.

Options:
  --dir PATH   Installation directory (default: ./sparklingkit)
  --from-source  Copy distribution assets from this source checkout
  --no-start    Install files without starting containers
  -h, --help   Show this help
EOF
}

while (($#)); do
  case "$1" in
    --dir)
      if (($# < 2)); then printf '%s requires a path.\n' "$1" >&2; exit 2; fi
      INSTALL_DIR="$2"
      shift
      ;;
    --from-source)
      FROM_SOURCE=true
      ;;
    --no-start)
      NO_START=true
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

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  printf 'Install Docker Engine with Docker Compose v2 first.\n' >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required.\n' >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR/data/.redis"

if [[ -e "$INSTALL_DIR/compose.yaml" || -e "$INSTALL_DIR/sparklingkit" ]]; then
  printf 'An installation already exists at %s. Use ./sparklingkit update there.\n' "$INSTALL_DIR" >&2
  exit 1
fi

asset_temp_dir="$(mktemp -d "$INSTALL_DIR/.install.XXXXXX")"
trap 'rm -rf "$asset_temp_dir"' EXIT

install_asset() {
  local name="$1"
  local source="$SCRIPT_DIR/$name"
  local destination="$asset_temp_dir/$name"
  if [[ "$FROM_SOURCE" == "true" ]]; then
    if [[ ! -f "$source" ]]; then
      printf 'Source distribution asset not found: %s\n' "$source" >&2
      exit 1
    fi
    cp "$source" "$destination"
  else
    curl --fail --silent --show-error --location "$ASSET_BASE_URL/$name" --output "$destination"
  fi
}

install_asset compose.yaml
install_asset sparklingkit
if [[ "$FROM_SOURCE" != "true" ]]; then
  curl --fail --silent --show-error --location "$ASSET_BASE_URL/SHA256SUMS" --output "$asset_temp_dir/SHA256SUMS"
  for asset in compose.yaml sparklingkit; do
    expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$asset_temp_dir/SHA256SUMS")"
    if [[ -z "$expected" ]]; then
      printf 'Release checksum not found for %s.\n' "$asset" >&2
      exit 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$asset_temp_dir/$asset" | awk '{print $1}')"
    elif command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$asset_temp_dir/$asset" | awk '{print $1}')"
    else
      printf 'sha256sum or shasum is required to verify release assets.\n' >&2
      exit 1
    fi
    if [[ "$actual" != "$expected" ]]; then
      printf 'Checksum verification failed for %s.\n' "$asset" >&2
      exit 1
    fi
  done
fi
mv "$asset_temp_dir/compose.yaml" "$INSTALL_DIR/compose.yaml"
mv "$asset_temp_dir/sparklingkit" "$INSTALL_DIR/sparklingkit"
if [[ -f "$asset_temp_dir/SHA256SUMS" ]]; then mv "$asset_temp_dir/SHA256SUMS" "$INSTALL_DIR/SHA256SUMS"; fi
trap - EXIT
rm -rf "$asset_temp_dir"
chmod +x "$INSTALL_DIR/sparklingkit"
if [[ "$FROM_SOURCE" == "true" && -f "$SCRIPT_DIR/.env.example" ]]; then
  cp "$SCRIPT_DIR/.env.example" "$INSTALL_DIR/.env.example"
fi

printf 'Installing SparklingKit in %s\n' "$INSTALL_DIR"
cd "$INSTALL_DIR"
if [[ "$NO_START" == "true" ]]; then
  printf 'Installation files are ready. Run ./sparklingkit start when you are ready.\n'
else
  ./sparklingkit start
fi
