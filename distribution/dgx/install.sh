#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${SPARKLINGKIT_DGX_DIR:-$PWD/sparklingkit-dgx}"
RELEASE_BASE_URL="${SPARKLINGKIT_DGX_RELEASE_URL:-https://run.sparklingkit.com/dgx/stable}"
PASSTHROUGH=()
UPDATE_EXISTING=false

usage() {
  cat <<'EOF'
Usage: dgx-install.sh [options] [model-stack options]

Download the current immutable DGX model-stack release and start its six
services. The application itself is not installed on this machine.

Installer options:
  --dir PATH                 Installation directory (default: ./sparklingkit-dgx)
  --update                   Bootstrap the latest updater, then upgrade in place
  -h, --help                 Show this help

Model-stack options are passed through, including:
  --accept-model-licenses    Confirm review of the six publishers' terms
  --skip-download            Reuse an existing model directory
  --skip-build               Reuse existing service images
EOF
}

while (($#)); do
  case "$1" in
    --dir)
      if (($# < 2)); then printf '%s requires a path.\n' "$1" >&2; exit 2; fi
      INSTALL_DIR="$2"
      shift
      ;;
    --update)
      UPDATE_EXISTING=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      PASSTHROUGH+=("$1")
      ;;
  esac
  shift
done

for command in docker curl tar sha256sum; do
  if ! command -v "$command" >/dev/null 2>&1; then
    printf 'Required command not found: %s\n' "$command" >&2
    exit 1
  fi
done
if ! docker compose version >/dev/null 2>&1; then
  printf 'Docker Compose v2 is required.\n' >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

if [[ -e "$INSTALL_DIR/scripts/start-dgx-models.sh" ]]; then
  if [[ "$UPDATE_EXISTING" != "true" ]]; then
    if [[ -x "$INSTALL_DIR/sparklingkit-dgx" ]]; then
      printf 'A DGX stack already exists at %s. Re-run this installer with --update to bootstrap the latest verified updater first.\n' "$INSTALL_DIR" >&2
    else
      printf 'A legacy DGX stack exists at %s. Re-run this installer with --update to add the updater and refresh it safely.\n' "$INSTALL_DIR" >&2
    fi
    exit 1
  fi

  printf 'Bootstrapping the verified DGX stack updater...\n'
  curl --fail --silent --show-error --location "$RELEASE_BASE_URL/sparklingkit-dgx" --output "$temp_dir/sparklingkit-dgx"
  curl --fail --silent --show-error --location "$RELEASE_BASE_URL/SHA256SUMS" --output "$temp_dir/SHA256SUMS"
  expected_manager="$(awk '$2 == "sparklingkit-dgx" { print $1 }' "$temp_dir/SHA256SUMS")"
  actual_manager="$(sha256sum "$temp_dir/sparklingkit-dgx" | awk '{print $1}')"
  if [[ -z "$expected_manager" || "$actual_manager" != "$expected_manager" ]]; then
    printf 'DGX updater checksum verification failed. No local files were replaced.\n' >&2
    exit 1
  fi
  if ! bash -n "$temp_dir/sparklingkit-dgx"; then
    printf 'DGX updater syntax validation failed. No local files were replaced.\n' >&2
    exit 1
  fi
  chmod +x "$temp_dir/sparklingkit-dgx"
  mv "$temp_dir/sparklingkit-dgx" "$INSTALL_DIR/.sparklingkit-dgx-next"
  mv "$INSTALL_DIR/.sparklingkit-dgx-next" "$INSTALL_DIR/sparklingkit-dgx"
  rm -rf "$temp_dir"
  trap - EXIT
  cd "$INSTALL_DIR"
  if ((${#PASSTHROUGH[@]})); then
    exec ./sparklingkit-dgx update "${PASSTHROUGH[@]}"
  else
    exec ./sparklingkit-dgx update
  fi
fi

printf 'Downloading the SparklingKit DGX model stack...\n'
curl --fail --silent --show-error --location \
  "$RELEASE_BASE_URL/sparklingkit-dgx-stack.tar.gz" \
  --output "$temp_dir/sparklingkit-dgx-stack.tar.gz"
curl --fail --silent --show-error --location \
  "$RELEASE_BASE_URL/SHA256SUMS" \
  --output "$temp_dir/SHA256SUMS"

expected="$(awk '$2 == "sparklingkit-dgx-stack.tar.gz" { print $1 }' "$temp_dir/SHA256SUMS")"
if [[ -z "$expected" ]]; then
  printf 'The release checksum manifest does not contain the DGX bundle.\n' >&2
  exit 1
fi
actual="$(sha256sum "$temp_dir/sparklingkit-dgx-stack.tar.gz" | awk '{print $1}')"
if [[ "$actual" != "$expected" ]]; then
  printf 'DGX bundle checksum verification failed.\n' >&2
  exit 1
fi

tar -xzf "$temp_dir/sparklingkit-dgx-stack.tar.gz" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/sparklingkit-dgx" "$INSTALL_DIR/scripts/start-dgx-models.sh" "$INSTALL_DIR/scripts/start-dgx-spark.sh"
rm -rf "$temp_dir"
trap - EXIT
cd "$INSTALL_DIR"
if ((${#PASSTHROUGH[@]})); then
  exec ./sparklingkit-dgx start "${PASSTHROUGH[@]}"
else
  exec ./sparklingkit-dgx start
fi
