# voice-front

## What this is

The reference voice front for Galatea Home. Stage 1 of
`docs/specs/2026-09-27-voice-front-design.md`, seeded from an earlier ASR
sidecar. It hears speech, transcribes it, and hands over an utterance
addressed by a configured wake word or a tap. It claims no level of
[`standard/voice.md`](https://github.com/Ludentes/galatea-life-standard/blob/main/standard/voice.md) yet.

## What it is not yet

No device keys and no satellites: stages 2d to 6. Stage 2b added
the steward client (`steward.py`), the brain server (`brain.py`), the store
(`store.py`, on the installation's Postgres) and TLS (`serve.py`), with their configuration.
Stage 2c added speaking: the synthesiser's client (`synth.py`, Wyoming), the
fixed clips (`clips.py`) and the queues that play a brain's pieces and report
them `played` (`speaking.py`), with their configuration. The seed's
`app.py` starts none of them yet, and no link plays audio yet: stage 2d
composes them and gives the links a player. The seed's link
still matches a wake word anywhere in the utterance until 2d moves it onto
the begins-with rule (GA-VOICE-4).

## Run it

From `reference/voice-front/`:

```
uv sync
./bootstrap.sh
./fetch-models.sh
cp voice-front.example.toml voice-front.toml   # edit the wake word(s); never commit this file
uv run python -m voice_front.app --config voice-front.toml
```

`bootstrap.sh` vendors `libonnxruntime` next to the `sherpa-onnx` wheel (the
1.13.7 wheel does not bundle a compatible one). `fetch-models.sh` downloads
GigaAM-v3 CTC and Silero VAD v6.0 into `models/`, each checked against a
pinned sha256. Both scripts are idempotent.

The server binds `127.0.0.1:8765` by default (`[server].host` /
`[server].port` in the config) — port 8765, not 8123, so it never collides
with Home Assistant's own default port on the same box. It serves one path,
`ws://<host>:<port>/stream`; any other path is closed with code 1008.
`server.host` must resolve only to loopback addresses (checked by resolving
it, never by comparing the string) — the link has no TLS or device keys
until stage 2, so anything else is refused at startup.

A bad configuration file, a missing model, or a port that cannot be bound
each print one line to stderr and exit 2, before any socket opens.

## Test it

```
tools/with-postgres.sh uv run pytest -q
```

The store, the brain server and TLS tests are marked `pg` and need a Postgres
server. `reference/voice-front/tools/with-postgres.sh` starts a throwaway `postgres:18-alpine` on
this host's loopback (Docker), names it in `VOICE_FRONT_TEST_DATABASE_URL`,
and removes it afterwards; given that variable already, it uses your server.
Each test gets a database of its own. Without a server those tests fail, and
are never skipped. `uv run pytest -q -m "not pg"` runs the rest anywhere.

The front validates its messages against the standard's brain and steward
schemas, from the copy it ships in `voice_front/standard_schemas/`
(`VOICE_FRONT_SCHEMAS` names another folder). Where the standard's
[`conformance/schemas/`](https://github.com/Ludentes/galatea-life-standard/tree/main/conformance/schemas) sits beside the front, a test fails until the copy
matches it; `uv run python tools/copy_schemas.py` makes the copy again.

The synthesiser's tests run a fake Wyoming server on 127.0.0.1, on a free
port, in the test process; no synthesiser is needed. Speaking's tests run on a
fake clock, with a fake synthesiser and fake players, so hours of queue time
take a fraction of a second. No audio is committed: the clips' tests write
their WAVs into a temporary directory.

Most of the suite is pure-Python and needs no models. A handful of tests are
marked `models` and run the real GigaAM-v3 CTC and Silero VAD chain against
the public `test_wavs/example.wav` that ships with the GigaAM release
`fetch-models.sh` downloads; they are skipped automatically if the models
have not been fetched.

### Measured cases

The wake rule's measured cases are local data: transcripts of real speech,
kept outside git. `tests/test_wake_golden.py` skips without them. To run it,
set `VOICE_FRONT_WAKE_CASES` to your own copy, or put it at
`tests/cases/local/wake_cases_measured.json` (git-ignored):

```
VOICE_FRONT_WAKE_CASES=/path/to/wake_cases_measured.json uv run pytest -q
```

Never commit such a file.

## Check it by hand

All commands below run from `reference/voice-front/`, with the models
fetched and a `voice-front.toml` in place (copied from the example, as
above).

1. Start it:

   ```
   uv run python -m voice_front.app --config voice-front.toml
   ```

   Wait for `listening on ws://127.0.0.1:8765/stream` in the log.

2. In another terminal, connect and open an address window:

   ```
   printf '%s\n' '{"type":"address","ttl_ms":6000}' \
     | uv run python -m websockets ws://127.0.0.1:8765/stream
   ```

   The client prints no reply (address frames are never acknowledged over
   the socket). The server log gets one new line:

   ```
   INFO:voice-front:address window open for 6000 ms
   ```

   If your installed `websockets` has no `python -m websockets` CLI, use
   this one-liner instead:

   ```python
   import asyncio, websockets
   async def main():
       async with websockets.connect("ws://127.0.0.1:8765/stream") as ws:
           await ws.send('{"type":"address","ttl_ms":6000}')
   asyncio.run(main())
   ```

3. Send a malformed frame the same way:

   ```
   printf '%s\n' '{"type":"address","ttl_ms":"x"}' \
     | uv run python -m websockets ws://127.0.0.1:8765/stream
   ```

   The server log gets:

   ```
   WARNING:voice-front:refused an address frame: ttl_ms must be a number
   ```

   No window opens.

4. Record your own WAV outside this repository — 16 kHz mono PCM16, saying
   the configured wake word and then a command — and run:

   ```
   uv run python -m voice_front.selfcheck --config voice-front.toml /path/to/your.wav
   ```

   It prints the raw transcript, the matched command, the audio duration
   and the decode RTF, and exits 0.

5. Say something without the wake word (or reuse the public
   `models/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/test_wavs/example.wav`,
   which contains no wake word):

   ```
   uv run python -m voice_front.selfcheck --config voice-front.toml \
     models/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16/test_wavs/example.wav
   ```

   `match` prints `None`, the last line reads `-> NOT addressed to the
   device`, and the process exits 1. That WAV is a public reading with no
   wake word in it, so this is the expected result, not a defect — it does
   not exercise the positive case. Use your own recording (step 4) for that.

6. Stop the server, edit `voice-front.toml` to misspell a key (for example
   `port` to `poort`), and start it again:

   ```
   uv run python -m voice_front.app --config voice-front.toml
   ```

   It prints one line naming the key and exits 2, e.g.:

   ```
   voice-front.toml: unknown key server.'poort'
   ```

   No socket is opened.

Stop the server (Ctrl-C) when done.

## Known limitation carried from the seed

The reported end of speech is about 0.6 s late. The endpointer closes a
segment only after `MIN_SILENCE_S` (0.6 s) of silence, so every utterance
arrives at least that long after the speaker stopped, and the end the front
reports is an estimate from that late stamp, not a measurement. Silero also
detects speech roughly 0.26 s after it starts. Stage 2 fixes both.

## Privacy

Audio never leaves the machine. There is no upload path, no telemetry and no
cloud call, and none may be added. No audio, no voice profile and no model
file is committed to this repository — `models/`, `vendor/`,
`voice-front.toml` and `tests/cases/local/` are all git-ignored.

Reply text goes to the synthesiser on this host, and a `unix://` socket is
preferred over a loopback port.

Until stage 2 adds device keys, the link has no admission: any local process,
and any browser page open on this machine, can open the loopback socket and
stream audio to it. Decoding runs on the event loop and blocks it, so one
connection's decode stalls every other connection until it finishes.

## Licence

Apache-2.0, as the repository. The synthesiser is not part of it: the front
speaks Wyoming (the `wyoming` package, MIT) to whatever text-to-speech server
the installation runs, whose voices carry their own licences. The models are
fetched under their own licences, verified on their release pages:

- GigaAM-v3 CTC: MIT (`github.com/salute-developers/GigaAM`)
- Silero VAD v6.0: MIT (`github.com/snakers4/silero-vad`)
