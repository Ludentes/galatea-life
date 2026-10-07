import { execFileSync } from "node:child_process";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { open } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPackage, PackageError, unpack } from "../src/plugins/package.js";
import { gnuTar, type Served, serve, sha256, tar, tarOf, tgz } from "./packages.js";

let dir: string;
let server: Served;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pc-bridge-package-"));
  server = await serve();
});

afterEach(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** What a call rejected with: the reason and message of a PackageError. */
async function refusal(p: Promise<unknown>): Promise<{ reason: string; message: string }> {
  const err = await p.then(() => undefined, (e: unknown) => e);
  if (!(err instanceof PackageError)) throw new Error(`expected a PackageError, got ${String(err)}`);
  return { reason: err.reason, message: err.message };
}

describe("fetchPackage", () => {
  const body = Buffer.from("a package's bytes");
  const dest = () => join(dir, "package.tar.gz");

  it("fetches over HTTP under a run into a new file, and checks its SHA-256", async () => {
    server.routes["/p.tar.gz"] = { body };
    await fetchPackage(server.url("/p.tar.gz"), sha256(body), dest(), { allowHttp: true });
    expect(readFileSync(dest())).toEqual(body);
  });

  it("takes the SHA-256 in either case", async () => {
    server.routes["/p.tar.gz"] = { body };
    await fetchPackage(server.url("/p.tar.gz"), sha256(body).toUpperCase(), dest(), { allowHttp: true });
    expect(readFileSync(dest())).toEqual(body);
  });

  it("names a package whose SHA-256 is another hash_mismatch", async () => {
    server.routes["/p.tar.gz"] = { body };
    expect(await refusal(fetchPackage(server.url("/p.tar.gz"), sha256("other"), dest(), { allowHttp: true })))
      .toEqual({ reason: "hash_mismatch", message: `the package's SHA-256 is ${sha256(body)}` });
  });

  it("refuses http: outside a run, and any scheme but https:, fetching nothing", async () => {
    server.routes["/p.tar.gz"] = { body };
    expect(await refusal(fetchPackage(server.url("/p.tar.gz"), sha256(body), dest(), { allowHttp: false })))
      .toEqual({ reason: "fetch_failed", message: "http: is not fetched; http: only under a test run" });
    expect((await refusal(fetchPackage("file:///etc/passwd", sha256(body), dest(), { allowHttp: true }))).message).toBe("file: is not fetched");
    expect((await refusal(fetchPackage("ftp://example.org/p.tar.gz", sha256(body), dest(), { allowHttp: true }))).reason).toBe("fetch_failed");
    expect((await refusal(fetchPackage("not a url", sha256(body), dest(), { allowHttp: true }))).reason).toBe("fetch_failed");
    expect(server.hits).toEqual([]);
  });

  it("names a status other than 2xx, and a server that is not there, fetch_failed", async () => {
    expect(await refusal(fetchPackage(server.url("/missing"), sha256(body), dest(), { allowHttp: true })))
      .toEqual({ reason: "fetch_failed", message: `${server.url("/missing")} answered HTTP 404` });
    const url = server.url("/p.tar.gz");
    await server.close();
    expect((await refusal(fetchPackage(url, sha256(body), dest(), { allowHttp: true }))).reason).toBe("fetch_failed");
    server = await serve();
  });

  it("follows a redirect, checking its scheme as the first URL's, and at most five", async () => {
    server.routes["/p.tar.gz"] = { body };
    server.routes["/moved"] = { location: "/p.tar.gz" };
    await fetchPackage(server.url("/moved"), sha256(body), dest(), { allowHttp: true });
    expect(server.hits).toEqual(["/moved", "/p.tar.gz"]);
    server.routes["/to-file"] = { location: "file:///etc/passwd" };
    expect((await refusal(fetchPackage(server.url("/to-file"), sha256(body), join(dir, "b"), { allowHttp: true }))).message)
      .toBe("file: is not fetched");
    server.routes["/loop"] = { location: "/loop" };
    expect((await refusal(fetchPackage(server.url("/loop"), sha256(body), join(dir, "c"), { allowHttp: true }))).message)
      .toBe("more than 5 redirects");
  });

  it("asks for the body as it is, and refuses one the server says it encoded, fetch_failed", async () => {
    server.routes["/p.tar.gz"] = { body };
    await fetchPackage(server.url("/p.tar.gz"), sha256(body), dest(), { allowHttp: true });
    expect(server.headers[0]!["accept-encoding"]).toBe("identity");
    server.routes["/gz"] = { body: gzipSync(body), headers: { "content-encoding": "gzip" } };
    expect(await refusal(fetchPackage(server.url("/gz"), sha256(body), join(dir, "b"), { allowHttp: true })))
      .toEqual({ reason: "fetch_failed", message: `${server.url("/gz")} answered with Content-Encoding gzip` });
  });

  it("names a redirect to a Location that is not a URL fetch_failed", async () => {
    server.routes["/bad"] = { location: "http://[" };
    expect(await refusal(fetchPackage(server.url("/bad"), sha256(body), dest(), { allowHttp: true })))
      .toEqual({ reason: "fetch_failed", message: `${server.url("/bad")} redirected to "http://[", which is not a URL` });
  });

  it("names a package over the cap invalid_package, whether it says so or not", async () => {
    server.routes["/big"] = { body: Buffer.alloc(2000) };
    expect(await refusal(fetchPackage(server.url("/big"), sha256(body), dest(), { allowHttp: true, maxBytes: 1000 })))
      .toEqual({ reason: "invalid_package", message: "the package is 2000 bytes, over 1000" });
    server.routes["/quiet"] = { body: Buffer.alloc(2000), chunked: true };
    expect((await refusal(fetchPackage(server.url("/quiet"), sha256(body), join(dir, "b"), { allowHttp: true, maxBytes: 1000 }))).reason)
      .toBe("invalid_package");
  });

  it("stops a stalled download when its signal aborts", async () => {
    server.routes["/slow"] = { body, stallAfter: 3 };
    const abort = new AbortController();
    const fetching = fetchPackage(server.url("/slow"), sha256(body), dest(), { allowHttp: true, signal: abort.signal });
    await new Promise((r) => setTimeout(r, 50));
    abort.abort(new Error("timeout"));
    expect((await refusal(fetching)).reason).toBe("fetch_failed");
  });
});

describe("unpack", () => {
  const unpacked = (archive: Buffer, opts: { maxBytes?: number } = {}) => {
    writeFileSync(join(dir, "p.tar.gz"), archive);
    mkdirSync(join(dir, "v"));
    return unpack(join(dir, "p.tar.gz"), join(dir, "v"), opts);
  };
  const mode = (rel: string) => statSync(join(dir, "v", rel)).mode & 0o777;

  it("unpacks a package as GNU tar makes it, a long path included, and gives each file's SHA-256 from the package's root", async () => {
    const long = `lib/${"d".repeat(60)}/${"f".repeat(60)}.py`;
    const files = await unpacked(gnuTar({ "manifest.json": "{}", "server.py": { body: "print(1)", mode: 0o755 }, [long]: "x = 1" }));
    expect(files).toEqual({ "manifest.json": sha256("{}"), "server.py": sha256("print(1)"), [long]: sha256("x = 1") });
    expect(readFileSync(join(dir, "v", long), "utf8")).toBe("x = 1");
    expect(mode("manifest.json")).toBe(0o644);
    expect(mode("server.py")).toBe(0o755);
    expect(mode(`lib/${"d".repeat(60)}`)).toBe(0o755);
  });

  it("unpacks a pax archive, its long names in pax headers", async () => {
    const long = `${"p".repeat(120)}.js`;
    expect(await unpacked(gnuTar({ [long]: "ok", "a/b/c.txt": "c" }, "pax"))).toEqual({ [long]: sha256("ok"), "a/b/c.txt": sha256("c") });
  });

  it("unpacks the mpv plugin's package as its packaging makes it", async () => {
    const mpv = gnuTar({ "manifest.json": "{\"id\":\"org.galatea.mpv\"}", "package.json": "{\"type\":\"module\"}", "server.js": "export {};" });
    expect(Object.keys(await unpacked(mpv))).toEqual(["manifest.json", "package.json", "server.js"]);
  });

  it("takes a ustar prefix, a directory entry, ./ and a git archive's global comment", async () => {
    const files = await unpacked(tgz([
      { name: "", type: "g", pax: { comment: "0123456789abcdef" } },
      { name: "./", type: "5" },
      { name: "lib/", type: "5", mode: 0o700 },
      { name: "kodi.py", prefix: "lib/deep", body: "k" },
      { name: "./server.py", body: "s" },
    ]));
    expect(files).toEqual({ "lib/deep/kodi.py": sha256("k"), "server.py": sha256("s") });
    expect(mode("lib")).toBe(0o755);
  });

  it.each([
    ["an absolute path", [{ name: "/etc/cron.d/evil", body: "x" }], "is an absolute path"],
    ["a .. component", [{ name: "lib/../../evil.py", body: "x" }], "leaves the package through .."],
    ["a .. in a pax path", [{ name: "ok.py", body: "x", pax: { path: "../evil.py" } }], "leaves the package through .."],
    ["a symbolic link", [{ name: "lib", type: "2" }], "is a symbolic link"],
    ["a hard link", [{ name: "copy", type: "1" }], "is a hard link"],
    ["a character device", [{ name: "tty", type: "3" }], "is a character device"],
    ["a block device", [{ name: "sda", type: "4" }], "is a block device"],
    ["a FIFO", [{ name: "pipe", type: "6" }], "is a FIFO"],
    ["an entry of an unknown type", [{ name: "sparse", type: "S" }], "not a file or a directory"],
    ["a file twice", [{ name: "a.py", body: "1" }, { name: "./a.py", body: "2" }], "in the archive twice"],
    ["a file where a directory is", [{ name: "lib/a.py", body: "1" }, { name: "lib", body: "2" }], "in the archive twice"],
    ["a directory where a file is", [{ name: "lib", body: "1" }, { name: "lib/a.py", body: "2" }], "both a file and a directory"],
    ["a bad header checksum", [{ name: "a.py", body: "1", badChecksum: true }], "checksum"],
    ["a global header that sets a path", [{ name: "", type: "g", pax: { path: "evil" } }], "global pax header sets path"],
    ["a GNU sparse file in pax records", [{ name: "a.py", body: "x", pax: { "GNU.sparse.size": "1" } }], "is a GNU sparse file"],
    ["a pax header over its cap", [{ name: "a.py", body: "x", pax: { comment: "x".repeat(70 * 1024) } }], "header is too large"],
  ])("refuses %s, writing nothing outside the directory", async (_what, entries, message) => {
    const r = await refusal(unpacked(tgz(entries as Parameters<typeof tgz>[0])));
    expect(r.reason).toBe("invalid_package");
    expect(r.message).toContain(message);
    expect(readdirSync(dir).sort()).toEqual(["p.tar.gz", "v"]);
  });

  it("refuses the links and the FIFO GNU tar itself writes", async () => {
    const withSymlink = tarOf((s) => {
      writeFileSync(join(s, "server.py"), "x");
      symlinkSync("/etc", join(s, "etc"));
    });
    expect((await refusal(unpacked(withSymlink))).message).toContain("is a symbolic link");
    rmSync(join(dir, "v"), { recursive: true });
    const withHardLink = tarOf((s) => {
      writeFileSync(join(s, "a.py"), "x");
      linkSync(join(s, "a.py"), join(s, "b.py"));
    });
    expect((await refusal(unpacked(withHardLink))).message).toContain("is a hard link");
    rmSync(join(dir, "v"), { recursive: true });
    const withFifo = tarOf((s) => execFileSync("mkfifo", [join(s, "pipe")]));
    expect((await refusal(unpacked(withFifo))).message).toContain("is a FIFO");
  });

  it("refuses what is not a gzip, a truncated archive, and one with no end block", async () => {
    expect((await refusal(unpacked(Buffer.from("plain text")))).message).toMatch(/^not a gzip stream/);
    rmSync(join(dir, "v"), { recursive: true });
    const whole = tar([{ name: "a.py", body: "x".repeat(2000) }]);
    expect((await refusal(unpacked(gzipSync(whole.subarray(0, 1024)))))).toEqual({ reason: "invalid_package", message: "the archive is truncated" });
    rmSync(join(dir, "v"), { recursive: true });
    expect((await refusal(unpacked(gzipSync(whole.subarray(0, whole.length - 1024)))))).toEqual({
      reason: "invalid_package", message: "the archive has no end-of-archive block" });
  });

  it("refuses an archive of more entries than the cap", async () => {
    const many = tgz(Array.from({ length: 20_001 }, (_, i) => ({ name: `d${i}`, type: "5" })));
    expect((await refusal(unpacked(many))).message).toBe("the archive holds more than 20000 entries");
    // About 2 s on an idle machine, building and reading 20 001 entries: room for a loaded one.
  }, 60_000);

  it("syncs each file and each directory it made before it returns", async () => {
    const handle = await open(join(dir, "probe"), "w");
    const proto = Object.getPrototypeOf(handle) as { sync: () => Promise<void> };
    await handle.close();
    const sync = vi.spyOn(proto, "sync");
    try {
      await unpacked(tgz([{ name: "lib/a.py", body: "1" }, { name: "b.py", body: "2" }]));
      // Two files, and two directories: the package's root and lib.
      expect(sync.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      sync.mockRestore();
    }
  });

  it("refuses an archive that unpacks to more than the cap", async () => {
    const bomb = tgz([{ name: "zeros", body: Buffer.alloc(64 * 1024) }]);
    expect(bomb.length).toBeLessThan(1024);
    expect((await refusal(unpacked(bomb, { maxBytes: 32 * 1024 }))).message).toBe("the archive unpacks to more than 32768 bytes");
  });
});
