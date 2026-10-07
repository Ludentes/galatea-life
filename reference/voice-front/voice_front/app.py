"""The voice front's process.

    uv run python -m voice_front.app --config voice-front.toml

Loads the configuration, the recogniser, and serves the browser link on
`ws://<host>:<port>/stream`. Any other path is closed with 1008.

A bad configuration or a missing model prints one line to stderr and exits 2,
before any socket is opened; so does a port that cannot be bound.
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

from websockets.asyncio.server import ServerConnection, serve

from voice_front.config import Config, ConfigError, load
from voice_front.links.browser import PATH, handle_stream
from voice_front.speech import GIGAAM_DIR_NAME, SILERO_FILE_NAME
from voice_front.speech.asr import Asr
from voice_front.speech.vad import Endpointer

log = logging.getLogger("voice-front")


def _die(message: str) -> None:
    print(" ".join(message.split()), file=sys.stderr)
    raise SystemExit(2)


async def _serve(cfg: Config, asr: Asr) -> None:
    silero = cfg.models_dir / SILERO_FILE_NAME

    async def handler(ws: ServerConnection) -> None:
        # ws.request is set by the time the handler runs (after the opening
        # handshake completed); None only prior to that.
        path = ws.request.path if ws.request is not None else None
        if path == PATH:
            await handle_stream(ws, asr=asr, rules=cfg.wake_rules,
                                make_endpointer=lambda: Endpointer(silero))
            return
        await ws.close(1008, f"unknown path, expected {PATH}")

    async with serve(handler, cfg.host, cfg.port):
        log.info("listening on ws://%s:%d%s", cfg.host, cfg.port, PATH)
        await asyncio.Future()  # run forever


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="The voice front.")
    parser.add_argument("--config", required=True, type=Path,
                        help="the configuration file (see voice-front.example.toml)")
    args = parser.parse_args(argv)

    try:
        cfg = load(args.config)
    except ConfigError as exc:
        _die(str(exc))

    logging.basicConfig(level=logging.INFO)
    silero = cfg.models_dir / SILERO_FILE_NAME
    if not silero.exists():
        _die(f"missing VAD model at {silero}: run ./fetch-models.sh first")
    log.info("loading GigaAM-v3 CTC ...")
    try:
        asr = Asr(cfg.models_dir / GIGAAM_DIR_NAME)
    except FileNotFoundError as exc:
        _die(str(exc))
    try:
        asyncio.run(_serve(cfg, asr))
    except OSError as exc:   # the port is taken, or the host cannot be bound
        _die(f"{args.config.name}: cannot listen on {cfg.host}:{cfg.port}: "
             f"{exc.strerror or exc}")


if __name__ == "__main__":
    main()
