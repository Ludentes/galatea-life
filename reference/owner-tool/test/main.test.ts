import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileProblem } from "../src/context.js";
import { main, readSecretFile } from "../src/main.js";
import { type Handler, serveTest, testCa } from "./mcp-server.js";

const APPLIER_OWNER = "applier-owner-secret-0123456789";
const STEWARD_OWNER = "steward-owner-secret-0123456789";

let dir: string;
const closing: (() => Promise<unknown>)[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "owner-tool-install-"));
  mkdirSync(join(dir, "secrets", "mcp"), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, "tls"), { recursive: true, mode: 0o755 });
  put("applier-owner", `${APPLIER_OWNER}\n`);
  put("steward-owner", STEWARD_OWNER);
});
afterEach(async () => {
  vi.restoreAllMocks();
  while (closing.length) await closing.pop()!().catch(() => undefined);
  rmSync(dir, { recursive: true, force: true });
});

function put(name: string, text: string, mode = 0o600) {
  const p = join(dir, "secrets", "mcp", name);
  writeFileSync(p, text, { mode });
  chmodSync(p, mode);
  return p;
}

/** What main said, out and err, while it ran. */
async function said(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((s) => (err.push(String(s)), true));
  const code = await main(argv, env);
  vi.restoreAllMocks();
  return { code, out: out.join(""), err: err.join("") };
}

const applierHandler: Handler = async (tool) => {
  if (tool === "describe") return { ok: true, body: { revision: 1, devices: [], transports: [] } };
  if (tool === "configure") return { ok: true, body: { revision: 2 } };
  return { ok: false, body: { error: "invalid_request", message: `no ${tool}` } };
};

describe("readSecretFile", () => {
  it("reads this account's 0600 file, dropping one trailing newline", () => {
    expect(readSecretFile(join(dir, "secrets", "mcp", "applier-owner"))).toBe(APPLIER_OWNER);
  });

  it("refuses a file other accounts can reach, another account's, an empty one, a missing one, never saying the text", () => {
    const open = put("open", "an-open-secret-0123456789", 0o640);
    expect(() => readSecretFile(open)).toThrow(/other accounts \(mode 0640\)/);
    expect(() => readSecretFile(join(dir, "secrets", "mcp", "applier-owner"), 12345)).toThrow(/owned by uid \d+, not by this account \(uid 12345\)/);
    expect(() => readSecretFile(put("empty", ""))).toThrow(/is empty/);
    expect(() => readSecretFile(join(dir, "nothing"))).toThrow(FileProblem);
    try {
      readSecretFile(open);
    } catch (e) {
      expect((e as Error).message).not.toContain("an-open-secret");
    }
  });
});

describe("main", () => {
  it("reaches the applier with the applier's owner credential, from --install and --applier", async () => {
    const s = await serveTest(applierHandler);
    closing.push(s.close);
    const r = await said(["register", "bridge", "sim-bridge", "--install", dir, "--applier", s.url]);
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toBe("registered bridge sim-bridge (broker identity sim-bridge) at the applier, revision 2\n");
    expect(new Set(s.bearers)).toEqual(new Set([APPLIER_OWNER]));
  });

  it("takes the installation and the URL from the environment, and the steward's credential for the steward", async () => {
    const s = await serveTest(async () => ({ ok: true, body: { revision: 3 } }));
    closing.push(s.close);
    writeFileSync(join(dir, "home.json"), JSON.stringify([{ op: "upsert", kind: "home", value: { timezone: "UTC" } }]));
    const r = await said(["define", join(dir, "home.json")], { GALATEA_INSTALL: dir, GALATEA_STEWARD_URL: s.url });
    expect(r).toMatchObject({ code: 0, out: "the steward's define: revision 3\n" });
    expect(new Set(s.bearers)).toEqual(new Set([STEWARD_OWNER]));
  });

  it("validates an https server against the installation's CA", async () => {
    const ca = await testCa();
    writeFileSync(join(dir, "tls", "ca.pem"), ca.ca, { mode: 0o644 });
    const s = await serveTest(applierHandler, { tls: { cert: ca.cert, key: ca.key } });
    closing.push(s.close);
    const r = await said(["register", "bridge", "sim-bridge", "--install", dir], { GALATEA_APPLIER_URL: s.localhostUrl });
    expect(r.code).toBe(0);
    rmSync(join(dir, "tls", "ca.pem"));
    const none = await said(["register", "bridge", "sim-bridge", "--install", dir], { GALATEA_APPLIER_URL: s.localhostUrl });
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/could not be reached/);
    // Said why (review M6): the CA file was not there, so the system's store was used.
    expect(none.err).toContain(`(no CA at ${join(dir, "tls", "ca.pem")}; the system's store was used)`);
    // A failure that is no certificate's says nothing of the CA.
    await s.close();
    const down = await said(["register", "bridge", "sim-bridge", "--install", dir], { GALATEA_APPLIER_URL: s.localhostUrl });
    expect(down.err).not.toMatch(/no CA at/);
  });

  it("refuses a credential file other accounts can read, and plain http off loopback, with 2 and nothing sent", async () => {
    const s = await serveTest(applierHandler);
    closing.push(s.close);
    chmodSync(join(dir, "secrets", "mcp", "applier-owner"), 0o644);
    const r = await said(["register", "bridge", "sim-bridge", "--install", dir, "--applier", s.url]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/can be reached by other accounts/);
    expect(r.err + r.out).not.toContain(APPLIER_OWNER);
    expect(s.bearers).toEqual([]);
    const off = await said(["status", "--install", dir, "--applier", "http://192.0.2.1:18443/mcp", "--steward", "http://192.0.2.1:18444/mcp"]);
    expect(off.code).toBe(2);
    expect(off.err).toMatch(/off loopback it must be https/);
  });

  it("names the installation's URLs by default", async () => {
    const r = await said(["devices", "--install", dir], {});
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/the applier at https:\/\/127\.0\.0\.1:18443 could not be reached/);
  });
});
