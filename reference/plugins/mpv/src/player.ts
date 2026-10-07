import { EventEmitter } from "node:events";
import type { MpvEvent, MpvIpc, PropertyChange } from "./ipc.js";
import type { Search } from "./library.js";

export interface PlayerState { playing: boolean; volume: number; title?: string; started_at?: string }

/** A failure the tool reports with `isError`: the action may not have been carried out. */
export class ToolFailure extends Error {}

export interface PlayerOptions {
  findFile(search: Search): Promise<string | undefined>;
  confirmMs?: number;
  now?: () => Date;
}

export interface PlayerPort {
  state(): PlayerState;
  launch(search: Search): Promise<PlayerState>;
  pause(): Promise<PlayerState>;
  resume(): Promise<PlayerState>;
  setVolume(volume: number): Promise<PlayerState>;
  on(event: "change", fn: () => void): unknown;
}

const OBSERVED = ["pause", "volume", "idle-active", "media-title"] as const;

/** The bridge's cap on a string reading (*Plugins on Linux*, size caps). */
const MAX_TITLE_BYTES = 1024;

/** `title` cut to at most 1 KiB of UTF-8, at a character's boundary. */
function capTitle(title: string): string {
  if (Buffer.byteLength(title) <= MAX_TITLE_BYTES) return title;
  let bytes = 0;
  let out = "";
  for (const ch of title) {
    bytes += Buffer.byteLength(ch);
    if (bytes > MAX_TITLE_BYTES) break;
    out += ch;
  }
  return out;
}

export class Player extends EventEmitter implements PlayerPort {
  #paused = false;
  #volume = 0;
  #idle = true;
  #loaded = false;
  #title: string | undefined;
  /** mpv's latest `media-title`: the title of the item starting or loaded, not yet of the state. */
  #mediaTitle: string | undefined;
  #startedAt: string | undefined;
  #last = "";
  #queue: Promise<void> = Promise.resolve();
  readonly #confirmMs: number;
  readonly #now: () => Date;

  private constructor(private readonly ipc: MpvIpc, private readonly opts: PlayerOptions) {
    super();
    this.#confirmMs = opts.confirmMs ?? 10_000;
    this.#now = opts.now ?? (() => new Date());
    ipc.on("property", (p: PropertyChange) => this.#onProperty(p));
    ipc.on("event", (e: MpvEvent) => this.#onEvent(e));
  }

  static async attach(ipc: MpvIpc, opts: PlayerOptions): Promise<Player> {
    const p = new Player(ipc, opts);
    for (const [i, name] of OBSERVED.entries()) await p.#command(["observe_property", i + 1, name]);
    p.#last = JSON.stringify(p.state());
    return p;
  }

  state(): PlayerState {
    const s: PlayerState = { playing: this.#loaded && !this.#paused && !this.#idle, volume: Math.round(this.#volume) };
    if (this.#title !== undefined) s.title = this.#title;
    if (this.#startedAt !== undefined) s.started_at = this.#startedAt;
    return s;
  }

  async launch(search: Search): Promise<PlayerState> {
    return this.#serial(async () => {
      const file = await this.opts.findFile(search);
      if (!file) throw new ToolFailure(`nothing in the configured folders matches "${search.title ?? ""}"`);
      const pending = this.#nextLoad();
      // Its timer runs while `loadfile` is still unanswered; the `await` below still sees a rejection.
      pending.promise.catch(() => { /* handled below */ });
      try {
        await this.#command(["loadfile", file, "replace"]);
      } catch (err) {
        pending.cancel();
        throw err;
      }
      await pending.promise;
      if (this.#paused) {
        await this.#command(["set_property", "pause", false]);
        await this.#until(() => !this.#paused, "the resume after loading");
      }
      return this.state();
    });
  }

  async pause(): Promise<PlayerState> {
    return this.#serial(() => this.#setPause(true));
  }

  async resume(): Promise<PlayerState> {
    return this.#serial(() => this.#setPause(false));
  }

  async setVolume(volume: number): Promise<PlayerState> {
    return this.#serial(async () => {
      if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
        throw new ToolFailure(`volume must be a whole number from 0 to 100, not ${volume}`);
      }
      await this.#command(["set_property", "volume", volume]);
      await this.#until(() => Math.round(this.#volume) === volume, `the volume ${volume}`);
      return this.state();
    });
  }

  /** An IPC command bounded by `confirmMs`: an mpv that never answers cannot hold the queue. */
  #command(args: unknown[]): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ToolFailure(`mpv did not answer ${String(args[0])} within ${this.#confirmMs} ms`)),
        this.#confirmMs,
      );
    });
    return Promise.race([this.ipc.command(args), timeout]).finally(() => clearTimeout(timer));
  }

  /** Runs `fn` only after every earlier queued action has settled, success or failure alike. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn, fn);
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #setPause(pause: boolean): Promise<PlayerState> {
    if (!this.#loaded || this.#idle) throw new ToolFailure("nothing is loaded");
    if (this.#paused !== pause) {
      await this.#command(["set_property", "pause", pause]);
      await this.#until(() => this.#paused === pause, pause ? "the pause" : "the resume");
    }
    return this.state();
  }

  /**
   * Resolves on the next file loaded, with its title and start; rejects on a load that fails.
   * `cancel` detaches the listener and clears the timer without settling the promise, so a
   * `loadfile` the caller already knows failed (e.g. the command itself was rejected) can be
   * abandoned without leaving a listener attached or a rejection to surface later, unhandled.
   */
  #nextLoad(): { promise: Promise<void>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout>;
    let on: (e: MpvEvent) => void;
    const cancel = (): void => {
      clearTimeout(timer);
      this.ipc.off("event", on);
    };
    const promise = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        this.ipc.off("event", on);
        reject(new ToolFailure(`mpv did not confirm the file loaded within ${this.#confirmMs} ms`));
      }, this.#confirmMs);
      on = (e: MpvEvent) => {
        if (e.event === "end-file" && e.reason === "error") {
          clearTimeout(timer);
          this.ipc.off("event", on);
          reject(new ToolFailure("mpv could not play the file"));
        } else if (e.event === "file-loaded") {
          clearTimeout(timer);
          this.ipc.off("event", on);
          this.#command(["get_property", "media-title"]).then(
            (title) => {
              this.#title = typeof title === "string" ? capTitle(title) : undefined;
              this.#changed();
              resolve();
            },
            (err: Error) => reject(new ToolFailure(err.message)),
          );
        }
      };
      this.ipc.on("event", on);
    });
    return { promise, cancel };
  }

  #until(pred: () => boolean, what: string): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("update", on);
        reject(new ToolFailure(`mpv did not confirm ${what} within ${this.#confirmMs} ms`));
      }, this.#confirmMs);
      const on = () => {
        if (!pred()) return;
        clearTimeout(timer);
        this.off("update", on);
        resolve();
      };
      this.on("update", on);
    });
  }

  #onProperty(p: PropertyChange): void {
    if (p.name === "pause") this.#paused = p.data === true;
    else if (p.name === "volume" && typeof p.data === "number") this.#volume = p.data;
    else if (p.name === "idle-active") {
      this.#idle = p.data === true;
      if (this.#idle) this.#loaded = false;
    } else if (p.name === "media-title") {
      // Kept while nothing is loaded (mpv has none when idle), taken up when a file loads: any
      // load, a launch or not, so that `title` and `started_at` describe the same item.
      this.#mediaTitle = typeof p.data === "string" ? capTitle(p.data) : undefined;
      if (this.#loaded && this.#mediaTitle !== undefined) this.#title = this.#mediaTitle;
    }
    this.#changed();
  }

  #onEvent(e: MpvEvent): void {
    if (e.event === "file-loaded") {
      this.#loaded = true;
      this.#startedAt = this.#now().toISOString();
      // mpv sends the new `media-title` between start-file and file-loaded, and only on a change,
      // so the latest one seen is this file's.
      if (this.#mediaTitle !== undefined) this.#title = this.#mediaTitle;
    } else if (e.event === "end-file") {
      this.#loaded = false;
    } else {
      return;
    }
    this.#changed();
  }

  #changed(): void {
    this.emit("update");
    const now = JSON.stringify(this.state());
    if (now !== this.#last) {
      this.#last = now;
      this.emit("change");
    }
  }
}
