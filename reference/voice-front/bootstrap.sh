#!/usr/bin/env bash
# voice-front bootstrap. Idempotent. Run after uv sync.
#
# Why this exists: the sherpa-onnx 1.13.7 wheel does NOT bundle
# libonnxruntime. Its native module links against symbol version
# VERS_1.27.1, and onnxruntime 1.27.1 was never published to PyPI (PyPI
# jumps 1.27.0 -> 1.28.0). Linking against 1.27.0 fails at import with:
#     version `VERS_1.27.1' not found
# So we vendor the upstream C release and point the wheel's RPATH dir at it.
set -euo pipefail
cd "$(dirname "$0")"

ORT_VER=1.27.1
ORT_DIR="vendor/onnxruntime-linux-x64-${ORT_VER}"
SP="$(uv run python -c 'import site; print(site.getsitepackages()[0])')"

if [ ! -f "${ORT_DIR}/lib/libonnxruntime.so" ]; then
  echo "==> fetching onnxruntime ${ORT_VER} (C release)"
  mkdir -p vendor
  curl -fL --retry 3 -o "vendor/ort.tgz" \
    "https://github.com/microsoft/onnxruntime/releases/download/v${ORT_VER}/onnxruntime-linux-x64-${ORT_VER}.tgz"
  tar xzf vendor/ort.tgz -C vendor
  rm vendor/ort.tgz
fi

echo "==> linking libonnxruntime into sherpa_onnx.libs"
mkdir -p "${SP}/sherpa_onnx.libs"
ln -sf "$(pwd)/${ORT_DIR}/lib/libonnxruntime.so.${ORT_VER}" \
       "${SP}/sherpa_onnx.libs/libonnxruntime.so"

uv run python -c 'import sherpa_onnx; print("sherpa-onnx OK", sherpa_onnx.__file__)'
