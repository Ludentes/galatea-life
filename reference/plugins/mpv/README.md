# org.galatea.mpv

The reference build's first plugin (`docs/specs/2026-09-27-pc-reference-build-design.md`, *The
mpv plugin*): one device, a `player`, whose MCP server drives mpv through its JSON IPC.

- `media.launch(search: { title, kind? })` plays the best match for the title among the video files
  in the folders listed in `~/.config/galatea-mpv/folders` (one absolute path a line; `~/Videos`
  when absent). It never takes a path or a URL.
- `media.pause`, `media.resume`, `media.set_volume(volume: 0–100)`.
- State, at `mpv://player/state`: `playing`, `volume`, `title`, `started_at`.

Build the package: `pnpm --filter @ludentes/galatea-life-plugin-mpv pack:plugin`. It prints the `.tar.gz`'s path
and SHA-256, the pair an owner's `install` names. Tests: `pnpm --filter @ludentes/galatea-life-plugin-mpv test`
(needs `mpv` and `ffmpeg`). A manual check: `docs/guides/2026-09-27-mpv-plugin-manual-check.md`.
