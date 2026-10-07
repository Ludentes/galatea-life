---
title: The mpv plugin — manual check
status: draft
last_verified:
area: architecture
audience: dev
author: Galatea maintainers
related:
  - docs/plans/2026-09-27-pc-build-1-mpv-plugin.md
  - reference/plugins/mpv/README.md
---

# The mpv plugin — manual check

What the tests cannot show: a real window on your desktop, your own films, your hands on mpv. About
fifteen minutes. You need `mpv` (`sudo apt install mpv`), and a few video files of your own.

## Build and unpack the package

1. From the repository root:
       pnpm install
       pnpm --filter @ludentes/galatea-life-plugin-mpv pack:plugin
   Expected: one line of JSON with `package`, `sha256` and `bytes`. Note the `sha256`.
2. Check the hash as the bridge will:
       sha256sum reference/plugins/mpv/dist/org.galatea.mpv-0.1.0.tar.gz
   Expected: the same `sha256`.
3. Unpack it where the bridge would, but in your home:
       mkdir -p ~/galatea-try && tar -xzf reference/plugins/mpv/dist/org.galatea.mpv-0.1.0.tar.gz -C ~/galatea-try
       ls ~/galatea-try
   Expected: `manifest.json  package.json  server.js`, nothing else.

## Tell it where your films are

4. List one or two folders:
       mkdir -p ~/.config/galatea-mpv
       printf '%s\n' "$HOME/Videos" > ~/.config/galatea-mpv/folders
   (Add another line for each other folder, as an absolute path.)

## Happy path

5. Start the stand-in for the bridge:
       pnpm --filter @ludentes/galatea-life-plugin-mpv try ~/galatea-try
   Expected: `server up; tools match the manifest's hashes`, and a `>` prompt. No mpv window yet.
6. `state` → `{"playing":false,"volume":100}` (your volume may differ).
7. `launch <a few words of a film's title>` → `ok: {"playing":true,...,"title":"…","started_at":"…"}`,
   an mpv window playing that film, and `(state changed)` lines.
8. `pause` → `ok`, the film pauses, `"playing":false`. `resume` → it plays again.
9. `volume 30` → `ok`, `"volume":30`, and mpv's own volume display shows 30.

## Edge cases

10. `launch no such film at all` → `FAILED: nothing in the configured folders matches …`; the film
    playing before keeps playing.
11. `volume 150` → `FAILED: volume must be a whole number from 0 to 100`; nothing changes.
12. Press space in the mpv window. Expected: a `(state changed)` line with `"playing":false`: a
    change at the player itself reaches the state.
13. `launch <an episode's words> --episode` on a folder holding `Show S01E02.mkv` plays the episode;
    the same words with `--movie` fail if only episodes match.
14. From another terminal: `ls -l "$XDG_RUNTIME_DIR"` shows a `galatea-mpv-…` directory with
    `drwx------`: no other account can drive the player.

## Round trip

15. `launch` the same film twice. Expected: two different `started_at` values: the applier tells a
    new launch from an old report by it.
16. `quit`. Expected: the prompt ends, the mpv window closes, and the `galatea-mpv-…` directory is
    gone from `$XDG_RUNTIME_DIR`.
17. Close mpv's window while `try` runs (start again, `launch`, then close the window, or press `q`
    in it). Expected: at once, `mpv exited; the server exits so that the bridge starts it again`;
    the `galatea-mpv-…` directory is gone from `$XDG_RUNTIME_DIR`; and the next command prints
    `error: Not connected`. The server exited with mpv, nonzero, as it must, so that the bridge
    starts it again.

Clean up: `rm -r ~/galatea-try` (and `~/.config/galatea-mpv` if you made it for this).
