import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { syncDir } from "../state-store.js";

/** The bridge's own caps on a package (a standards candidate, with the design's other size caps). */
export const PACKAGE_MAX_BYTES = 100 * 1024 * 1024;
/** What the archive may unpack to, headers included, and how many entries it may hold: a small archive must not fill the disk. */
export const UNPACKED_MAX_BYTES = 512 * 1024 * 1024;
export const ENTRIES_MAX = 20_000;
/** Redirects followed, each checked for its scheme as the first URL is. */
export const REDIRECTS_MAX = 5;
/** A pax or GNU long-name header's own data is small: a path. */
const HEADER_DATA_MAX = 64 * 1024;

/** The bridge's own reasons (standards candidates): a fetch that failed, and a package it will not unpack. */
export type PackageReason = "fetch_failed" | "hash_mismatch" | "invalid_package";

/** Why a package is not installed: the `install_failed` reason, and what to say in its `detail`. */
export class PackageError extends Error {
  constructor(readonly reason: PackageReason, message: string) {
    super(message);
  }
}

export interface FetchOptions {
  /** `http:` as well as `https:`: only under a run, whose harness serves packages over plain HTTP. */
  allowHttp: boolean;
  signal?: AbortSignal;
  maxBytes?: number;
}

const failed = (m: string) => new PackageError("fetch_failed", m);
const invalid = (m: string) => new PackageError("invalid_package", m);
const why = (err: unknown) => {
  const e = err as Error & { cause?: Error };
  return e.cause?.message ? `${e.message}: ${e.cause.message}` : String(e.message ?? err);
};

/**
 * Fetches the package at `url` into `dest` (a new file), hashing as it writes, and checks its
 * SHA-256 against `sha256` before anything is unpacked. `https:` always, `http:` only under a run,
 * each redirect checked the same; a fetch that fails or a non-2xx status is `fetch_failed`, a body
 * over the cap `invalid_package`, another SHA-256 `hash_mismatch`.
 */
export async function fetchPackage(url: string, sha256: string, dest: string, o: FetchOptions): Promise<void> {
  const max = o.maxBytes ?? PACKAGE_MAX_BYTES;
  let at: URL;
  try {
    at = new URL(url);
  } catch {
    throw failed(`${JSON.stringify(url)} is not a URL`);
  }
  for (let hops = 0; ; hops++) {
    if (at.protocol !== "https:" && !(o.allowHttp && at.protocol === "http:")) {
      throw failed(`${at.protocol} is not fetched${o.allowHttp ? "" : "; http: only under a test run"}`);
    }
    let res: Response;
    try {
      // The body as it is: fetch would undo a `Content-Encoding: gzip` a server put on a .tar.gz, and the hash would not match.
      res = await fetch(at, { redirect: "manual", headers: { "accept-encoding": "identity" }, ...(o.signal ? { signal: o.signal } : {}) });
    } catch (err) {
      throw failed(`fetching ${at.href}: ${why(err)}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location !== null) {
      await res.body?.cancel().catch(() => {});
      if (hops >= REDIRECTS_MAX) throw failed(`more than ${REDIRECTS_MAX} redirects`);
      try {
        at = new URL(location, at);
      } catch {
        throw failed(`${at.href} redirected to ${JSON.stringify(location)}, which is not a URL`);
      }
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw failed(`${at.href} answered HTTP ${res.status}`);
    }
    const encoding = res.headers.get("content-encoding");
    if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
      await res.body.cancel().catch(() => {});
      throw failed(`${at.href} answered with Content-Encoding ${encoding}`);
    }
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (declared > max) {
      await res.body.cancel().catch(() => {});
      throw invalid(`the package is ${declared} bytes, over ${max}`);
    }
    const hash = createHash("sha256");
    const reader = res.body[Symbol.asyncIterator]();
    const f = await open(dest, "wx", 0o600);
    let size = 0;
    try {
      for (;;) {
        let r: IteratorResult<Uint8Array>;
        try {
          r = await reader.next();
        } catch (err) {
          throw failed(`the download broke off: ${why(err)}`);
        }
        if (r.done) break;
        size += r.value.length;
        if (size > max) {
          await reader.return?.();
          throw invalid(`the package is over ${max} bytes`);
        }
        hash.update(r.value);
        await f.write(r.value);
      }
      await f.sync();
    } finally {
      await f.close();
    }
    const got = hash.digest("hex");
    if (got !== sha256.toLowerCase()) throw new PackageError("hash_mismatch", `the package's SHA-256 is ${got}`);
    return;
  }
}

/** Reads a decompressed stream a block at a time, counting what it unpacks against the cap. */
class Blocks {
  private buf: Buffer = Buffer.alloc(0);
  private total = 0;

  constructor(private readonly it: AsyncIterator<Buffer>, private readonly max: number) {}

  private async more(): Promise<boolean> {
    let r: IteratorResult<Buffer>;
    try {
      r = await this.it.next();
    } catch (err) {
      throw invalid(`not a gzip stream: ${why(err)}`);
    }
    if (r.done) return false;
    this.total += r.value.length;
    if (this.total > this.max) throw invalid(`the archive unpacks to more than ${this.max} bytes`);
    this.buf = r.value;
    return true;
  }

  /** Exactly `n` bytes; with `orNone`, null when the stream ends before the first of them. */
  async take(n: number, orNone = false): Promise<Buffer | null> {
    const parts: Buffer[] = [];
    for await (const piece of this.pieces(n, orNone)) parts.push(piece);
    return n > 0 && parts.length === 0 ? null : Buffer.concat(parts);
  }

  /** `n` bytes in the pieces they came in; the stream ending first is a truncated archive, except before the first byte when `orNone`. */
  async *pieces(n: number, orNone = false): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (!this.buf.length && !(await this.more())) {
        if (orNone && left === n) return;
        throw invalid("the archive is truncated");
      }
      const piece = this.buf.subarray(0, Math.min(left, this.buf.length));
      this.buf = this.buf.subarray(piece.length);
      left -= piece.length;
      yield piece;
    }
  }
}

const TYPES: Record<string, string> = { "1": "a hard link", "2": "a symbolic link", "3": "a character device", "4": "a block device", "6": "a FIFO" };

/** A NUL-terminated field. */
function field(b: Buffer, off: number, len: number): string {
  const f = b.subarray(off, off + len);
  const end = f.indexOf(0);
  return (end < 0 ? f : f.subarray(0, end)).toString("utf8");
}

function octal(b: Buffer, off: number, len: number, what: string): number {
  if (b[off]! & 0x80) throw invalid(`${what} is in base-256`);
  const s = field(b, off, len).trim();
  if (s === "") return 0;
  if (!/^[0-7]+$/.test(s)) throw invalid(`${what} is not octal`);
  return parseInt(s, 8);
}

/** A pax header's records, `<len> <key>=<value>\n` each. */
function pax(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    const len = Number(data.subarray(at, space).toString("latin1"));
    if (space < 0 || !Number.isInteger(len) || len <= 0 || at + len > data.length) throw invalid("a pax header is malformed");
    const rec = data.subarray(space + 1, at + len - 1).toString("utf8");
    const eq = rec.indexOf("=");
    if (eq < 0) throw invalid("a pax record has no =");
    out[rec.slice(0, eq)] = rec.slice(eq + 1);
    at += len;
  }
  return out;
}

/** The path from the package's root, or why it is refused: absolute, or leaving through `..`. */
function relative(name: string): string {
  if (name.startsWith("/")) throw invalid(`${JSON.stringify(name)} is an absolute path`);
  const parts = name.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) throw invalid(`${JSON.stringify(name)} leaves the package through ..`);
  return parts.join("/");
}

/**
 * Unpacks a `.tar.gz` (ustar, GNU or pax) into `dir`, an empty directory, and gives each file's
 * SHA-256 by its path from the package's root. Only files and directories: an absolute path, a
 * `..`, a link of either kind, a device or a FIFO refuses the whole package, and so does anything
 * else it cannot read as one of those, so nothing lands outside `dir`. Files are written 0644, or
 * 0755 where the archive marks them executable, and directories 0755, whatever the archive says.
 */
export async function unpack(archive: string, dir: string, o: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<Record<string, string>> {
  const gunzip = createGunzip();
  const source = createReadStream(archive);
  source.on("error", (err) => gunzip.destroy(err));
  source.pipe(gunzip);
  const blocks = new Blocks(gunzip[Symbol.asyncIterator](), o.maxBytes ?? UNPACKED_MAX_BYTES);
  const hashes: Record<string, string> = {};
  const made = new Set<string>([""]);
  const mkdirs = async (rel: string) => {
    const parts = rel.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join("/");
      if (made.has(sub)) continue;
      if (Object.hasOwn(hashes, sub)) throw invalid(`${sub} is both a file and a directory`);
      await mkdir(join(dir, sub), { mode: 0o755 }).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      });
      await chmod(join(dir, sub), 0o755);
      made.add(sub);
    }
  };
  let next: { path?: string; size?: number } = {};
  let entries = 0;
  try {
    for (;;) {
      if (o.signal?.aborted) throw o.signal.reason;
      const h = await blocks.take(512, true);
      if (h === null) throw invalid("the archive has no end-of-archive block");
      if (h.every((x) => x === 0)) {
        // On disk before the record says installed: a power cut must not leave a recorded version's files empty.
        for (const sub of made) await syncDir(join(dir, sub));
        return hashes;
      }
      if (++entries > ENTRIES_MAX) throw invalid(`the archive holds more than ${ENTRIES_MAX} entries`);
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
      if (sum !== octal(h, 148, 8, "a header's checksum")) throw invalid("a header's checksum does not match");
      const magic = h.toString("latin1", 257, 263);
      if (magic !== "ustar\0" && magic !== "ustar ") throw invalid("not a ustar, GNU or pax archive");
      const type = String.fromCharCode(h[156]!);
      const own = octal(h, 124, 12, "a size");
      const readData = async (): Promise<Buffer> => {
        if (own > HEADER_DATA_MAX) throw invalid("a long-name or pax header is too large");
        return (await blocks.take(Math.ceil(own / 512) * 512))!.subarray(0, own);
      };
      if (type === "x") {
        const records = pax(await readData());
        // A sparse file's pax records map its data; unpacked as a plain file, it would be written wrong.
        if (Object.keys(records).some((k) => k.startsWith("GNU.sparse."))) throw invalid(`${JSON.stringify(records.path ?? field(h, 0, 100))} is a GNU sparse file`);
        next = { ...next, ...(records.path !== undefined ? { path: records.path } : {}),
          ...(records.size !== undefined ? { size: Number(records.size) } : {}) };
        if (next.size !== undefined && !(Number.isSafeInteger(next.size) && next.size >= 0)) throw invalid("a pax size is not a size");
        continue;
      }
      if (type === "g") {
        // A global header (git archive's comment) may carry only a comment: nothing that changes what follows.
        const other = Object.keys(pax(await readData())).filter((k) => k !== "comment");
        if (other.length) throw invalid(`a global pax header sets ${other.join(", ")}`);
        continue;
      }
      if (type === "L") {
        next = { ...next, path: field(await readData(), 0, own) };
        continue;
      }
      const name = next.path ?? (magic === "ustar\0" && h[345] !== 0 ? `${field(h, 345, 155)}/${field(h, 0, 100)}` : field(h, 0, 100));
      const size = next.size ?? own;
      const padded = Math.ceil(size / 512) * 512;
      next = {};
      if (TYPES[type]) throw invalid(`${JSON.stringify(name)} is ${TYPES[type]}`);
      const rel = relative(name);
      if (type === "5") {
        if (rel) await mkdirs(rel);
        for await (const _ of blocks.pieces(padded)) void _;
        continue;
      }
      if (type !== "0" && type !== "\0" && type !== "7") throw invalid(`${JSON.stringify(name)} is of type ${JSON.stringify(type)}, not a file or a directory`);
      if (!rel) throw invalid("a file with no name");
      if (Object.hasOwn(hashes, rel) || made.has(rel)) throw invalid(`${rel} is in the archive twice`);
      const slash = rel.lastIndexOf("/");
      if (slash > 0) await mkdirs(rel.slice(0, slash));
      const mode = octal(h, 100, 8, "a mode") & 0o111 ? 0o755 : 0o644;
      const hash = createHash("sha256");
      const f = await open(join(dir, rel), "wx", mode);
      try {
        let left = size;
        for await (const piece of blocks.pieces(padded)) {
          const data = piece.subarray(0, Math.max(0, Math.min(piece.length, left)));
          left -= data.length;
          if (data.length) {
            hash.update(data);
            await f.write(data);
          }
        }
        await f.chmod(mode);
        await f.sync();
      } finally {
        await f.close();
      }
      hashes[rel] = hash.digest("hex");
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}
