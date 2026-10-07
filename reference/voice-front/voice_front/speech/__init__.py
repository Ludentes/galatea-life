"""Speech detection and recognition: Silero VAD endpointing + GigaAM-v3 CTC decoding.

The names `fetch-models.sh` writes into `models/`, so callers can locate the
model files without each hard-coding the layout.
"""
from __future__ import annotations

GIGAAM_DIR_NAME = "sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16"
SILERO_FILE_NAME = "silero_vad_v6.onnx"
