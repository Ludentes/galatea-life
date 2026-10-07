import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A throw nobody expected while a command or request is handled (plan 4b, *The desktop run*: a
 * deployed bundle's `validate` threw): the command still gets its one ack (GA-BRIDGE-4), and the
 * request its reply, and the bridge goes on.
 */
const throwing = vi.hoisted(() => ({ next: undefined as Error | undefined }));
vi.mock("@ludentes/galatea-life-schemas", async (original) => {
  const real = await original<typeof import("@ludentes/galatea-life-schemas")>();
  return {
    ...real,
    validate: (id: string, value: unknown) => {
      const err = throwing.next;
      if (err) {
        throwing.next = undefined;
        throw err;
      }
      return real.validate(id, value);
    },
  };
});

const { validate } = await import("@ludentes/galatea-life-schemas");
const { COMPUTER, PcBridge, UNEXPECTED_ACK_REASON, UNEXPECTED_REPLY_REASON } = await import("../src/bridge.js");
const { StateStore } = await import("../src/state-store.js");
const { DETAIL_MAX_BYTES } = await import("../src/plugins/state.js");
const { FakeClock, FakePort, FakeWire } = await import("./fakes.js");

const ROOT = "home";
const BASE = `${ROOT}/bridges/desk-pc`;
const COMMAND = `${BASE}/devices/${COMPUTER}/command`;
const ACK = `${BASE}/devices/${COMPUTER}/ack`;

let dir: string;
const bridges: InstanceType<typeof PcBridge>[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pc-bridge-"));
  throwing.next = undefined;
});
afterEach(async () => {
  for (const b of bridges.splice(0)) await b.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function bridge() {
  const clock = new FakeClock();
  const wire = new FakeWire();
  const port = new FakePort();
  port.pluginsPath = join(dir, "plugins");
  const b = new PcBridge({ bridgeId: "desk-pc", instanceId: randomUUID(), root: ROOT, clock, port, wire, store: StateStore.load(dir) });
  bridges.push(b);
  await b.start();
  return { b, wire, port };
}

const command = (value: Record<string, unknown>) => ({
  commandId: randomUUID(), issuedAt: new Date().toISOString(), resultWithinMs: 5000, value,
});
const request = () => ({ requestId: randomUUID(), issuedAt: new Date().toISOString() });

describe("an unexpected throw", () => {
  it("in a command's handling is acked failed with the bridge's reason, the error's message its detail, once", async () => {
    const { wire, port } = await bridge();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    throwing.next = new Error("no schema bridge/command.json");
    const cmd = command({ action: "power.sleep" });
    await wire.deliver(COMMAND, cmd);
    expect(port.asked).toEqual([]);
    expect(wire.all(ACK).map((a) => a.payload)).toEqual([expect.objectContaining({
      commandId: cmd.commandId, source: "desk-pc", result: "failed", reason: UNEXPECTED_ACK_REASON, detail: "no schema bridge/command.json",
    })]);
    expect(validate("bridge/ack.json", wire.last(ACK)!.payload)).toEqual([]);
    expect(errors).toHaveBeenCalled();
    // A repeat gets the same ack and does nothing more (GA-BRIDGE-4).
    await wire.deliver(COMMAND, cmd);
    expect(wire.all(ACK).map((a) => a.payload)).toHaveLength(2);
    expect(wire.all(ACK)[1]!.payload).toEqual(wire.all(ACK)[0]!.payload);
    expect(port.asked).toEqual([]);
    errors.mockRestore();
  });

  it("cuts a long message as an ack's detail is cut, and the bridge serves the next command", async () => {
    const { wire, port } = await bridge();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    throwing.next = new Error("x".repeat(3000));
    await wire.deliver(COMMAND, command({ action: "power.sleep" }));
    const detail = wire.last(ACK)!.payload.detail as string;
    expect(Buffer.byteLength(detail, "utf8")).toBeLessThanOrEqual(DETAIL_MAX_BYTES);
    expect(detail.endsWith("…")).toBe(true);
    await wire.deliver(COMMAND, command({ action: "power.sleep" }));
    expect(port.asked).toEqual(["sleep"]);
    expect(wire.last(ACK)!.payload).toMatchObject({ result: "applied" });
    errors.mockRestore();
  });

  it("in a request's handling is replied failed with the bridge's reason, once, and the next request is served", async () => {
    const { wire } = await bridge();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    throwing.next = new Error("no schema bridge/request.json");
    const req = request();
    await wire.deliver(`${BASE}/request/snapshot`, req);
    await wire.deliver(`${BASE}/request/snapshot`, req);
    const replies = wire.all(`${BASE}/reply`).map((r) => r.payload);
    expect(replies).toEqual([
      { requestId: req.requestId, op: "snapshot", status: "failed", reason: UNEXPECTED_REPLY_REASON },
      { requestId: req.requestId, op: "snapshot", status: "failed", reason: UNEXPECTED_REPLY_REASON },
    ]);
    expect(validate("bridge/reply.json", replies[0])).toEqual([]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("no schema bridge/request.json"));
    const next = request();
    await wire.deliver(`${BASE}/request/snapshot`, next);
    expect(wire.last(`${BASE}/reply`)!.payload).toEqual({ requestId: next.requestId, op: "snapshot", status: "ok", data: {} });
    errors.mockRestore();
  });
});
