import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

/** One entry of an archive a test writes by hand, malformed on purpose where it says so. */
export interface Entry {
  name: string;
  /** The ustar type flag: "0" a file (the default), "5" a directory, "2" a symbolic link … */
  type?: string;
  body?: Buffer | string;
  mode?: number;
  /** A pax header before the entry, with these records. */
  pax?: Record<string, string>;
  /** Written in the header's prefix field, the name after it. */
  prefix?: string;
  badChecksum?: boolean;
}

function header(e: { name: string; type: string; size: number; mode: number; prefix?: string; badChecksum?: boolean }): Buffer {
  const h = Buffer.alloc(512);
  const put = (s: string, off: number, len: number) => h.write(s, off, len, "utf8");
  const oct = (n: number, off: number, len: number) => put(`${n.toString(8).padStart(len - 1, "0")}\0`, off, len);
  put(e.name, 0, 100);
  oct(e.mode, 100, 8);
  oct(0, 108, 8);
  oct(0, 116, 8);
  oct(e.size, 124, 12);
  oct(0, 136, 12);
  put(e.type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  if (e.prefix) put(e.prefix, 345, 155);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${(e.badChecksum ? sum + 1 : sum).toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);

/** A pax record, `<len> <key>=<value>\n`, whose length counts itself. */
function record(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const b = Buffer.byteLength(rest);
  let len = b + String(b).length;
  if (String(len).length !== String(b).length) len = b + String(len).length;
  return `${len}${rest}`;
}

/** A ustar archive, entry by entry, ended by two zero blocks. */
export function tar(entries: Entry[]): Buffer {
  const out: Buffer[] = [];
  for (const e of entries) {
    if (e.pax) {
      const data = Buffer.from(Object.entries(e.pax).map(([k, v]) => record(k, v)).join(""));
      out.push(header({ name: "PaxHeader", type: e.type === "g" ? "g" : "x", size: data.length, mode: 0o644 }), pad(data));
      if (e.type === "g") continue;
    }
    const body = Buffer.from(e.body ?? "");
    const type = e.type ?? "0";
    out.push(header({ name: e.name, type, size: type === "0" ? body.length : 0, mode: e.mode ?? 0o644,
      ...(e.prefix ? { prefix: e.prefix } : {}), ...(e.badChecksum ? { badChecksum: true } : {}) }));
    if (type === "0") out.push(pad(body));
  }
  out.push(Buffer.alloc(1024));
  return Buffer.concat(out);
}

export const tgz = (entries: Entry[]) => gzipSync(tar(entries));
export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/**
 * A package as GNU tar makes one, as the mpv plugin's packaging does (`--format=gnu`, root's
 * owner, mtime 0; `pax` for the POSIX format): `files` written to a directory, archived by name.
 */
export function gnuTar(files: Record<string, string | { body: string; mode: number }>, format: "gnu" | "pax" = "gnu"): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "pc-bridge-tar-"));
  try {
    const stage = join(dir, "stage");
    for (const [name, f] of Object.entries(files)) {
      mkdirSync(dirname(join(stage, name)), { recursive: true });
      writeFileSync(join(stage, name), typeof f === "string" ? f : f.body, { mode: typeof f === "string" ? 0o644 : f.mode });
    }
    const out = join(dir, "p.tar.gz");
    const r = spawnSync("tar", [`--format=${format}`, "--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=@0", "-C", stage,
      "-czf", out, ...Object.keys(files)]);
    if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** An archive GNU tar makes of a directory prepared by `prepare`, for links and FIFOs a hand-written one would only imitate. */
export function tarOf(prepare: (stage: string) => void): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "pc-bridge-tar-"));
  try {
    const stage = join(dir, "stage");
    mkdirSync(stage);
    prepare(stage);
    const out = join(dir, "p.tar.gz");
    const r = spawnSync("tar", ["--format=gnu", "-C", stage, "-czf", out, "."]);
    if (r.status !== 0) throw new Error(`tar: ${r.stderr}`);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** How the test server answers a path: a body, a status, a redirect, or a download that stalls after `stallAfter` bytes. */
export interface Route {
  body?: Buffer;
  status?: number;
  location?: string;
  stallAfter?: number;
  /** The Content-Length it declares, whatever it sends; with `chunked`, none. */
  length?: number;
  chunked?: boolean;
  /** Headers it adds to its answer, as a server labelling the body `Content-Encoding: gzip`. */
  headers?: Record<string, string>;
}

export interface Served {
  url(path: string): string;
  routes: Record<string, Route>;
  /** Every path asked, in order. */
  hits: string[];
  /** Each request's headers, in the same order. */
  headers: Record<string, string | string[] | undefined>[];
  close(): Promise<void>;
}

/** A plain HTTP server on loopback, as the harness serves packages under a run. */
export async function serve(routes: Record<string, Route> = {}): Promise<Served> {
  const hits: string[] = [];
  const headers: Record<string, string | string[] | undefined>[] = [];
  const open = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    headers.push(req.headers);
    const r = routes[req.url ?? ""];
    if (!r) {
      res.writeHead(404).end();
      return;
    }
    if (r.location) {
      res.writeHead(r.status ?? 302, { location: r.location }).end();
      return;
    }
    const body = r.body ?? Buffer.alloc(0);
    res.writeHead(r.status ?? 200, { ...(r.chunked ? {} : { "content-length": String(r.length ?? body.length) }), ...r.headers });
    if (r.stallAfter !== undefined) {
      open.add(res);
      res.write(body.subarray(0, r.stallAfter));
      return;
    }
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    routes,
    hits,
    headers,
    close: async () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
