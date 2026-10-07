import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brokerFromEnv, coordinatorFromEnv, databaseUrlWithPassword, endUnannounced, noActionsFromEnv, privateDirProblem, readPins, readSecret } from "../src/entry.js";

describe("GALATEA_BROKER", () => {
  it("names the broker and the bridge's identity", () => {
    expect(brokerFromEnv("mqtt://zigbee@broker.test:1883")).toEqual({ url: "mqtt://broker.test:1883", username: "zigbee" });
  });

  it("refuses a text that is no URL, without repeating it", () => {
    const r = brokerFromEnv("zigbee s3cret at the broker");
    expect(r).toEqual({ refused: "GALATEA_BROKER is no URL" });
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });

  it("refuses a user name that cannot be decoded, without repeating it", () => {
    expect(brokerFromEnv("mqtt://zig%E0bee:s3cret@broker.test")).toEqual({ refused: "GALATEA_BROKER is no URL" });
  });

  it("refuses a broker that names no identity, without repeating its password", () => {
    const r = brokerFromEnv("mqtt://:s3cret@broker.test");
    expect(r).toEqual({ refused: "GALATEA_BROKER names no identity" });
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });
});

describe("a stop before the bridge announced itself", () => {
  it("ends the connection cleanly, so that the broker discards the will", async () => {
    const calls: string[] = [];
    await endUnannounced({ end: async () => { calls.push("end"); }, drop: async () => { calls.push("drop"); } }, 50);
    expect(calls).toEqual(["end"]);
  });

  it("cuts the connection when the clean end does not finish in time", async () => {
    const calls: string[] = [];
    await endUnannounced({ end: () => new Promise(() => { calls.push("end"); }), drop: async () => { calls.push("drop"); } }, 50);
    expect(calls).toEqual(["end", "drop"]);
  });

  it("cuts the connection when the clean end fails", async () => {
    const calls: string[] = [];
    await endUnannounced({ end: async () => { calls.push("end"); throw new Error("closed"); }, drop: async () => { calls.push("drop"); } }, 50);
    expect(calls).toEqual(["end", "drop"]);
  });
});

describe("GALATEA_ZIGBEE_COORDINATOR", () => {
  it("names the coordinator herdsman reaches over TCP", () => {
    expect(coordinatorFromEnv("tcp://coordinator.test:6638")).toEqual({ coordinator: "tcp://coordinator.test:6638" });
    expect(coordinatorFromEnv("tcp://coordinator.test:6638/")).toEqual({ coordinator: "tcp://coordinator.test:6638" });
  });

  it.each([
    [undefined, "GALATEA_ZIGBEE_COORDINATOR names no coordinator (tcp://host:port)"],
    ["", "GALATEA_ZIGBEE_COORDINATOR names no coordinator (tcp://host:port)"],
    ["the coordinator", "GALATEA_ZIGBEE_COORDINATOR is no URL"],
    ["/dev/ttyUSB0", "GALATEA_ZIGBEE_COORDINATOR is no URL"],
    ["mqtt://coordinator.test:6638", "GALATEA_ZIGBEE_COORDINATOR is not tcp://host:port"],
    ["tcp://coordinator.test", "GALATEA_ZIGBEE_COORDINATOR is not tcp://host:port"],
    ["tcp://user:s3cret@coordinator.test:6638", "GALATEA_ZIGBEE_COORDINATOR is not tcp://host:port"],
    ["tcp://coordinator.test:6638/zstack", "GALATEA_ZIGBEE_COORDINATOR is not tcp://host:port"],
  ])("refuses %j", (text, why) => {
    expect(coordinatorFromEnv(text)).toEqual({ refused: why });
  });
});

describe("the private data directory", () => {
  it("is the bridge's alone: no other account may read or list it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zigbee-data-"));
    try {
      await chmod(dir, 0o700);
      expect(privateDirProblem(dir)).toBeUndefined();
      await chmod(dir, 0o750);
      expect(privateDirProblem(dir)).toBe(`${dir} can be read by other accounts (mode 750): it holds the network key and the coordinator's backup`);
      await chmod(dir, 0o701);
      expect(privateDirProblem(dir)).toMatch(/mode 701/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the owner's PINs for locks (GA-BRIDGE-36)", () => {
  const PIN = "40719263";
  const DOOR = "0x00000000000a000d";
  const NOT_AN_ID = "pins.json names a lock by something that is no device id (0x and 16 lower-case hex digits, then -n for a later admission)";
  const withFile = async (text: string | undefined, mode = 0o600) => {
    const dir = await mkdtemp(join(tmpdir(), "zigbee-pins-"));
    if (text !== undefined) {
      await writeFile(join(dir, "pins.json"), text);
      await chmod(join(dir, "pins.json"), mode);
    }
    try {
      return readPins(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("reads pins.json as the PINs by device id; no file is no PIN", async () => {
    expect(await withFile(JSON.stringify({ "0x00000000000a0005": PIN, "0x00000000000a0006-2": "1234" })))
      .toEqual({ pins: new Map([["0x00000000000a0005", PIN], ["0x00000000000a0006-2", "1234"]]) });
    expect(await withFile(undefined)).toEqual({ pins: new Map() });
  });

  it("refuses a file other accounts can read: it holds the PINs", async () => {
    expect(await withFile(JSON.stringify({ [DOOR]: PIN }), 0o640)).toEqual({ refused: "pins.json can be read by other accounts: it holds the locks' PINs" });
  });

  it("refuses a file that is no object of device ids to PINs, never quoting a PIN", async () => {
    for (const [text, why] of [
      [`{"${DOOR}": "${PIN}"`, "pins.json is no JSON"],
      [JSON.stringify([PIN]), "pins.json is no object of device ids to PINs"],
      [JSON.stringify({ [DOOR]: Number(PIN) }), `pins.json: the PIN for ${DOOR} is not 1 to 32 printable ASCII characters`],
      [JSON.stringify({ [DOOR]: `${PIN} ${PIN}` }), `pins.json: the PIN for ${DOOR} is not 1 to 32 printable ASCII characters`],
      [JSON.stringify({ [DOOR]: "" }), `pins.json: the PIN for ${DOOR} is not 1 to 32 printable ASCII characters`],
      [JSON.stringify({ "": PIN }), NOT_AN_ID],
      // A PIN where a device id goes, or the two swapped: refused, never quoting the key (plan 2c-2 review M5).
      [JSON.stringify({ [PIN]: null }), NOT_AN_ID],
      [JSON.stringify({ [PIN]: DOOR }), NOT_AN_ID],
      [JSON.stringify({ "front-door": PIN }), NOT_AN_ID],
      [JSON.stringify({ [`${DOOR}-x`]: PIN }), NOT_AN_ID],
      [JSON.stringify({ [DOOR.toUpperCase().replace("0X", "0x")]: PIN }), NOT_AN_ID],
    ] as const) {
      const r = await withFile(text);
      expect(r, text).toEqual({ refused: why });
      expect(JSON.stringify(r)).not.toContain(PIN);
    }
  });
});

describe("the owner's switch that withholds every action (plan 2c-2 review M6)", () => {
  it("withholds every action at 1, none when unset or 0, and refuses anything else rather than guess", () => {
    expect(noActionsFromEnv(undefined)).toEqual({ noActions: false });
    expect(noActionsFromEnv("")).toEqual({ noActions: false });
    expect(noActionsFromEnv("0")).toEqual({ noActions: false });
    expect(noActionsFromEnv("1")).toEqual({ noActions: true });
    for (const v of ["true", "yes", " 1"]) expect(noActionsFromEnv(v), v).toEqual({ refused: "GALATEA_ZIGBEE_NO_ACTIONS is 1 (withhold every action) or 0" });
  });
});

describe("the passwords the install keeps in files (plan 4a)", () => {
  const SECRET = "Zx81s3cretPassw0rd";
  const withSecret = async (text: string | undefined, mode = 0o600, what = "GALATEA_CREDENTIAL_FILE") => {
    const dir = await mkdtemp(join(tmpdir(), "zigbee-secret-"));
    const path = join(dir, "secret");
    if (text !== undefined) {
      await writeFile(path, text);
      await chmod(path, mode);
    }
    try {
      return { path, read: readSecret(path, what) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("reads the file's text, without its last line end", async () => {
    expect((await withSecret(`${SECRET}\n`)).read).toEqual({ secret: SECRET });
    expect((await withSecret(SECRET)).read).toEqual({ secret: SECRET });
  });

  it("refuses a file other accounts can reach, never quoting it", async () => {
    const { path, read } = await withSecret(SECRET, 0o640);
    expect(read).toEqual({ refused: `GALATEA_CREDENTIAL_FILE ${path} can be reached by other accounts (mode 0640); it must be this account's alone (0600)` });
  });

  it("refuses a file that is missing or empty, naming the setting", async () => {
    const missing = await withSecret(undefined, 0o600, "GALATEA_DATABASE_PASSWORD_FILE");
    expect(missing.read).toEqual({ refused: `GALATEA_DATABASE_PASSWORD_FILE ${missing.path} cannot be read (ENOENT)` });
    const empty = await withSecret("\n");
    expect(empty.read).toEqual({ refused: `GALATEA_CREDENTIAL_FILE ${empty.path} is empty` });
  });

  it("refuses a file another account owns", () => {
    // Any file on the box that is not this account's: /etc/hostname is root's, and readable.
    expect(readSecret("/etc/hostname", "GALATEA_CREDENTIAL_FILE", 4242)).toMatchObject({ refused: expect.stringContaining("is owned by uid 0, not by this account (uid 4242)") });
  });

  it("puts the store's password into GALATEA_DATABASE_URL, encoded, replacing any there", () => {
    expect(databaseUrlWithPassword("postgres://bridge_zigbee@postgres:5432/galatea", "a/b@c")).toEqual({ url: "postgres://bridge_zigbee:a%2Fb%40c@postgres:5432/galatea" });
    expect(databaseUrlWithPassword("postgres://bridge_zigbee:old@postgres:5432/galatea", SECRET)).toEqual({ url: `postgres://bridge_zigbee:${SECRET}@postgres:5432/galatea` });
  });

  it("refuses a GALATEA_DATABASE_URL that is no URL or names no user, without repeating it", () => {
    expect(databaseUrlWithPassword(`not a url ${SECRET}`, SECRET)).toEqual({ refused: "GALATEA_DATABASE_URL is no URL" });
    expect(databaseUrlWithPassword("postgres://postgres:5432/galatea", SECRET)).toEqual({ refused: "GALATEA_DATABASE_URL names no user for its password" });
  });
});
