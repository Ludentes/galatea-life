import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The entry point's refusals before any broker or store is touched (plan 2b review M8), run from its
 * source: Node strips the types, and a resolve hook maps the sources' `.js` specifiers to `.ts`.
 */
const HOOK = `import { register } from "node:module";
register("data:text/javascript," + encodeURIComponent(
  "export async function resolve(s, c, n) { try { return await n(s, c); } catch (e) {" +
  " if (s.startsWith('.') && s.endsWith('.js')) return n(s.slice(0, -3) + '.ts', c); throw e; } }"));`;

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "zigbee-main-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function run(coordinator: string, extra: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--no-warnings", "--experimental-transform-types",
      "--import", `data:text/javascript,${encodeURIComponent(HOOK)}`, join(import.meta.dirname, "../src/main.ts")], {
      // Nothing listens on port 1: a refusal that came after the broker or the store would show as a hang or another message.
      env: { PATH: process.env.PATH, GALATEA_BROKER: "mqtt://zigbee@127.0.0.1:1", GALATEA_ROOT: "galatea", GALATEA_STATE_DIR: dir,
        GALATEA_DATABASE_URL: "postgres://zigbee@127.0.0.1:1/zigbee", GALATEA_ZIGBEE_COORDINATOR: coordinator, ...extra },
    });
    let out = "";
    child.stdout.on("data", (b) => { out += b; });
    child.stderr.on("data", (b) => { out += b; });
    child.on("exit", (code) => resolve({ code, out }));
  });
}

describe("the entry point's early refusals", () => {
  it("refuses a coordinator that is no tcp://host:port, never repeating it", async () => {
    await chmod(dir, 0o700);
    const r = await run("tcp://coordinator.test:6638 s3cret");
    expect(r.code).toBe(2);
    expect(r.out).toContain("refusing to start: GALATEA_ZIGBEE_COORDINATOR");
    expect(r.out).not.toContain("s3cret");
  }, 20_000);

  it("refuses a data directory other accounts can read: it holds the network key", async () => {
    await chmod(dir, 0o755);
    const r = await run("tcp://coordinator.test:6638");
    expect(r.code).toBe(2);
    expect(r.out).toContain("can be read by other accounts");
  }, 20_000);

  it("refuses the owner's PINs in a file other accounts can read, or a malformed one, never quoting a PIN", async () => {
    await chmod(dir, 0o700);
    await writeFile(join(dir, "pins.json"), '{"0x00000000000a000d": "40719263"}');
    await chmod(join(dir, "pins.json"), 0o644);
    let r = await run("tcp://coordinator.test:6638");
    expect(r.code).toBe(2);
    expect(r.out).toContain("refusing to start: pins.json can be read by other accounts");
    await writeFile(join(dir, "pins.json"), '{"0x00000000000a000d": 40719263}');
    await chmod(join(dir, "pins.json"), 0o600);
    r = await run("tcp://coordinator.test:6638");
    expect(r.code).toBe(2);
    expect(r.out).toContain("refusing to start: pins.json: the PIN for 0x00000000000a000d is not");
    expect(r.out).not.toContain("40719263");
    // A PIN where a device id goes is refused, never quoted (plan 2c-2 review M5).
    await writeFile(join(dir, "pins.json"), '{"40719263": "0x00000000000a000d"}');
    r = await run("tcp://coordinator.test:6638");
    expect(r.code).toBe(2);
    expect(r.out).toContain("refusing to start: pins.json names a lock by something that is no device id");
    expect(r.out).not.toContain("40719263");
  }, 60_000);

  it("refuses a broker password or a store password in a file other accounts can reach, never quoting it (plan 4a)", async () => {
    await chmod(dir, 0o700);
    const secret = join(dir, "..", `${dir.split("/").pop()}-secret`);
    await writeFile(secret, "Zx81s3cretPassw0rd");
    try {
      await chmod(secret, 0o644);
      let r = await run("tcp://coordinator.test:6638", { GALATEA_CREDENTIAL_FILE: secret });
      expect(r.code).toBe(2);
      expect(r.out).toContain("refusing to start: GALATEA_CREDENTIAL_FILE");
      expect(r.out).toContain("can be reached by other accounts");
      expect(r.out).not.toContain("Zx81s3cret");
      r = await run("tcp://coordinator.test:6638", { GALATEA_DATABASE_PASSWORD_FILE: secret });
      expect(r.code).toBe(2);
      expect(r.out).toContain("refusing to start: GALATEA_DATABASE_PASSWORD_FILE");
      expect(r.out).not.toContain("Zx81s3cret");
    } finally {
      await rm(secret, { force: true });
    }
  }, 40_000);

  it("refuses a switch for withholding actions that is neither 1 nor 0, rather than guess (plan 2c-2 review M6)", async () => {
    await chmod(dir, 0o700);
    const r = await run("tcp://coordinator.test:6638", { GALATEA_ZIGBEE_NO_ACTIONS: "true" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("refusing to start: GALATEA_ZIGBEE_NO_ACTIONS is 1 (withhold every action) or 0");
  }, 20_000);
});
