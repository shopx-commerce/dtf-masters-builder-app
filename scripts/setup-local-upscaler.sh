#!/usr/bin/env bash
set -euo pipefail

VERSION="${REALESRGAN_NCNN_VERSION:-v0.2.5.0}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_DIR="${REALESRGAN_NCNN_DIR:-$ROOT_DIR/vendor/realesrgan-ncnn-vulkan}"
ARCHIVE_DATE="${REALESRGAN_NCNN_DATE:-20220424}"
ARCHIVE_URL="https://github.com/xinntao/Real-ESRGAN/releases/download/${VERSION}/realesrgan-ncnn-vulkan-${ARCHIVE_DATE}-ubuntu.zip"
ARCHIVE_PATH="${TMPDIR:-/tmp}/realesrgan-ncnn-vulkan-${VERSION}.zip"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to download the official Real-ESRGAN release." >&2
  exit 1
fi
if ! command -v unzip >/dev/null 2>&1; then
  echo "unzip is required to install the official Real-ESRGAN release." >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
echo "Downloading Real-ESRGAN ncnn Vulkan ${VERSION}..."
curl --fail --location --retry 3 --output "$ARCHIVE_PATH" "$ARCHIVE_URL"
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
unzip -o "$ARCHIVE_PATH" -d "$INSTALL_DIR" >/dev/null

BINARY="$(find "$INSTALL_DIR" -type f -name 'realesrgan-ncnn-vulkan' -print -quit)"
if [[ -z "$BINARY" ]]; then
  echo "The release did not contain realesrgan-ncnn-vulkan." >&2
  exit 1
fi
chmod +x "$BINARY"
MODEL_DIR="$(find "$(dirname "$BINARY")" -type d -name models -print -quit)"
if [[ -z "$MODEL_DIR" || ! -f "$MODEL_DIR/realesrgan-x4plus.param" || ! -f "$MODEL_DIR/realesrgan-x4plus.bin" ]]; then
  echo "The release did not contain the realesrgan-x4plus model files." >&2
  exit 1
fi

echo
echo "Local Real-ESRGAN is installed."
echo "Set these environment variables for the application:"
echo "  export UPSCALE_PROVIDER=local"
echo "  export REAL_ESRGAN_BIN=$BINARY"
echo "  export REAL_ESRGAN_MODEL_DIR=$MODEL_DIR"
echo
echo "Optional tuning variables:"
echo "  REAL_ESRGAN_TILE=0       # use a smaller tile such as 256 if GPU memory is limited"
echo "  REAL_ESRGAN_GPU=0        # select a Vulkan GPU"
echo "  REAL_ESRGAN_THREADS=1:2:2"