import { afterEach, describe, expect, it } from "vitest";
import { setLogger } from "zigbee-herdsman";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { logger } from "zigbee-herdsman/dist/utils/logger.js";
import { logger as convertersLogger } from "zigbee-herdsman-converters/lib/logger";
import { herdsmanLogger, redact, useHerdsmanLogger } from "../src/herdsman/log.js";

/** A made-up network key: no bench's. */
const KEY = [0x3a, 0x91, 0x07, 0xc4, 0x5e, 0x22, 0xf0, 0x18, 0x6b, 0xd9, 0x40, 0xa7, 0x13, 0x8e, 0x55, 0xec];
const hex = Buffer.from(KEY).toString("hex");

/** Every form the key was found in, or could be: none may survive. */
const FORMS = {
  hex,
  HEX: hex.toUpperCase(),
  "0x hex": `0x${hex}`,
  "spaced hex": KEY.map((b) => b.toString(16).padStart(2, "0")).join(" "),
  "colon hex": KEY.map((b) => b.toString(16).padStart(2, "0")).join(":"),
  list: KEY.join(","),
  "spaced list": KEY.join(", "),
  "JSON array": JSON.stringify(KEY),
  "Buffer JSON": JSON.stringify(Buffer.from(KEY)),
  base64: Buffer.from(KEY).toString("base64"),
};

const leaks = (text: string) => Object.entries(FORMS).filter(([, v]) => text.includes(v)).map(([k]) => k);

describe("redact", () => {
  it.each(Object.entries(FORMS))("takes out the key as %s", (_, form) => {
    const out = redact(`before ${form} after`);
    expect(leaks(out)).toEqual([]);
    expect(out).toMatch(/^before .* after$/);
    expect(KEY.every((b) => !out.includes(`${b},`))).toBe(true);
  });

  it("takes out the key inside a longer frame of decimal bytes", () => {
    const frame = [254, 37, 97, 8, 0, 0, ...KEY, 1, 0, 0, 0, 12].join(",");
    expect(leaks(redact(`frame [${frame}]`))).toEqual([]);
  });

  it("takes out herdsman's own line for a configuration that does not match the coordinator", () => {
    const line = `- Network Key: configured=${hex}, adapter:active=${hex} adapter:preconfigured=${hex}, adapter:alternate=${hex}`;
    expect(leaks(redact(line))).toEqual([]);
  });

  it("takes out the key as 0x byte lists, as two 8-byte halves, and in unpadded base64 (plan 2b review M4)", () => {
    const hex = KEY.map((b) => b.toString(16).padStart(2, "0"));
    const forms = [
      hex.map((h) => `0x${h}`).join(","),
      hex.map((h) => `0x${h}`).join(", "),
      hex.map((h) => `0x${h}`).join(" "),
      `${hex.slice(0, 8).join("")} ${hex.slice(8).join("")}`,
      `${hex.slice(0, 8).join("")}:${hex.slice(8).join("")}`,
      Buffer.from(KEY).toString("base64url"),
      Buffer.from(KEY).toString("base64").replace(/=+$/, ""),
    ];
    for (const f of forms) {
      const out = redact(`key=${f} end`);
      expect(out, f).not.toContain(hex.slice(0, 4).join(""));
      expect(out, f).not.toContain(Buffer.from(KEY).toString("base64").slice(0, 8));
      expect(out, f).not.toMatch(/0x3a.*0x91/);
    }
  });

  it("takes out a key whose unpadded base64 has no digit (re-review N2)", () => {
    // Made up, chosen so that its base64 has letters only.
    const key = Buffer.from([60, 169, 98, 162, 153, 65, 44, 20, 204, 207, 25, 204, 153, 55, 3, 23]);
    for (const f of [key.toString("base64").replace(/=+$/, ""), key.toString("base64url")]) {
      expect(redact(`key=${f} end`)).toBe("key=<base64> end");
    }
  });

  it("keeps two IEEE addresses side by side, and a long word", () => {
    const text = "0x00124b0012345678 0xa4c1380000000001 acceptJoiningDeviceHand";
    expect(redact(text)).toBe(text);
  });

  it("keeps an IEEE address, a network address and a channel", () => {
    expect(redact("Device '0x00158d0001a2b3c4' joined at 49312 on channel 25")).toBe("Device '0x00158d0001a2b3c4' joined at 49312 on channel 25");
  });
});

describe("herdsmanLogger", () => {
  const lines: string[] = [];
  afterEach(() => { lines.splice(0); });
  const log = (debug = false) => herdsmanLogger({ write: (l) => lines.push(l), debug, now: () => Date.parse("2026-10-04T12:00:00Z") });

  it("stamps each line with its time, level and namespace, redacted", () => {
    const l = log();
    l.error(`mismatch ${hex}`, "zh:zstack:adapter");
    l.warning(() => `warn ${KEY.join(",")}`, "zh:controller");
    l.info("Wrote coordinator backup", "zh:controller");
    expect(lines).toEqual([
      "2026-10-04T12:00:00.000Z error zh:zstack:adapter mismatch <hex>",
      "2026-10-04T12:00:00.000Z warn zh:controller warn <bytes>",
      "2026-10-04T12:00:00.000Z info zh:controller Wrote coordinator backup",
    ]);
  });

  it("drops the Z-Stack frame dumps even with debug kept, and every debug line without it", () => {
    log(true).debug(`--> frame ${KEY.join(",")}`, "zh:zstack:unpi:writer");
    log(true).debug(() => `nv ${JSON.stringify(Buffer.from(KEY))}`, "zh:zstack:znp");
    log(false).debug("Device announce", "zh:controller");
    expect(lines).toEqual([]);
    log(true).debug("Device announce", "zh:controller");
    expect(lines).toEqual(["2026-10-04T12:00:00.000Z debug zh:controller Device announce"]);
  });

  it("logs a line whose making throws, instead of throwing into herdsman", () => {
    log().info(() => { throw new Error("no"); }, "zh:controller");
    expect(lines).toEqual(["2026-10-04T12:00:00.000Z info zh:controller (a log line that could not be made: no)"]);
  });

  it("is what the converters' own logger writes through too, once used, a lambda error included", () => {
    useHerdsmanLogger({ write: (l) => lines.push(l), now: () => Date.parse("2026-10-04T12:00:00Z") });
    convertersLogger.error(() => `Failed to sync time (${hex})`, "zhc:tuya");
    logger.warning(`key ${KEY.join(",")}`, "zh:controller");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^2026-10-04T12:00:00.000Z error zhc:tuya Failed to sync time \(/);
    expect(lines.flatMap(leaks)).toEqual([]);
  });

  it("is what herdsman's own logger writes through, once set", () => {
    setLogger(log());
    logger.error(`- Network Key: configured=${hex.toUpperCase()}`, "zh:zstack:adapter:manager");
    expect(lines).toHaveLength(1);
    expect(leaks(lines[0]!)).toEqual([]);
  });
});

describe("the converters' herdsman", () => {
  it("is the bridge's own copy, pinned at 10.10.0: one copy, as the pnpm override makes it", () => {
    const fromBridge = createRequire(import.meta.url);
    const fromConverters = createRequire(fromBridge.resolve("zigbee-herdsman-converters"));
    const herdsman = (r: NodeJS.Require) => dirname(r.resolve("zigbee-herdsman/package.json"));
    expect(herdsman(fromConverters)).toBe(herdsman(fromBridge));
    expect(fromBridge("zigbee-herdsman/package.json").version).toBe("10.10.0");
    expect(fromBridge("zigbee-herdsman-converters/package.json").version).toBe("26.114.0");
  });
});
