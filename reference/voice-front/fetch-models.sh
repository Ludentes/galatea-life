#!/usr/bin/env bash
# Downloads the model chain. Idempotent. Run once, after ./bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p models

ASR_DIR=models/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16
REL=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models
GIGAAM_SHA256=e1291d704460cab4a01716081170c86c12f6b15338a1534f71cc5956922adb52

# GigaAM-v3 CTC (MIT), not the transducer or *-punct variants: its token set
# is a space, 32 Cyrillic letters and a blank, with no punctuation or case to
# normalise away.
if [ ! -f "${ASR_DIR}/model.int8.onnx" ]; then
  echo "==> GigaAM-v3 CTC (~156 MB)"
  TMP_TAR="$(mktemp -t gigaam.XXXXXX.tar.bz2)"
  trap 'rm -f "${TMP_TAR}"' EXIT
  curl -fL --retry 3 -o "${TMP_TAR}" \
    "${REL}/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16.tar.bz2"
  echo "${GIGAAM_SHA256}  ${TMP_TAR}" | sha256sum -c -
  tar xjf "${TMP_TAR}" -C models
  rm -f "${TMP_TAR}"
  trap - EXIT
fi

SILERO_URL=https://github.com/snakers4/silero-vad/raw/v6.0/src/silero_vad/data/silero_vad.onnx
SILERO_SHA256=597d30b3ec076608d059477bb14cfeffdf951bf5cae370d38f65d33bbfe82004

if [ ! -f models/silero_vad_v6.onnx ]; then
  echo "==> Silero VAD v6.0"
  curl -fL --retry 3 -o models/silero_vad_v6.onnx.part "${SILERO_URL}"
  echo "${SILERO_SHA256}  models/silero_vad_v6.onnx.part" | sha256sum -c -
  mv models/silero_vad_v6.onnx.part models/silero_vad_v6.onnx
fi

echo
echo "models:"
du -sh models/* 2>/dev/null
