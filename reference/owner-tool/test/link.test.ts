import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BadUrl, checkUrl, isLoopback, Link, Lost, NotTaken, Unreachable } from "../src/link.js";
import { type Handler, serveTest, testCa } from "./mcp-server.js";

const BEARER = "a-credential-of-thirty-two-chars";
const handler: Handler = async (tool, args) => {
  if (tool === "describe") return { ok: true, body: { revision: 7, args } };
  if (tool === "refuse") return { ok: false, body: { error: "stale_revision", message: "the revision moved", revision: 8 } };
  if (tool === "hold") throw new Error("held");
  if (tool === "fail") throw new Error("not-taken");
  throw new Error("boom");
};

const closing: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closing.length) await closing.pop()!().catch(() => undefined);
});

async function serve(o: Parameters<typeof serveTest>[1] = {}) {
  const s = await serveTest(handler, o);
  closing.push(s.close);
  return s;
}
async function link(url: string, ca?: string) {
  const l = await Link.connect({ what: "steward", url: new URL(url), bearer: BEARER, ca });
  closing.push(() => l.close());
  return l;
}

describe("checkUrl", () => {
  it("takes https anywhere and http on loopback only", () => {
    expect(checkUrl("https://box.example:18444/mcp", "steward").host).toBe("box.example:18444");
    expect(checkUrl("http://127.0.0.1:1/mcp", "steward").port).toBe("1");
    expect(checkUrl("http://localhost:1/mcp", "steward").hostname).toBe("localhost");
    expect(checkUrl("http://[::1]:1/mcp", "steward").hostname).toBe("[::1]");
    expect(() => checkUrl("http://198.51.100.5:18444/mcp", "steward")).toThrow(BadUrl);
    expect(() => checkUrl("not a url", "applier")).toThrow(/applier's URL is not a URL/);
  });

  it("takes as loopback only localhost or an IP literal in 127/8 or ::1, never a name that starts with 127. (review I1)", () => {
    expect(checkUrl("http://127.1.2.3:1/mcp", "steward").hostname).toBe("127.1.2.3");
    for (const raw of ["http://127.attacker.example/mcp", "http://127.0.0.1.nip.io/mcp", "http://localhost.attacker.example/mcp",
      "http://[::2]/mcp", "http://[::ffff:7f00:1]/mcp", "http://128.0.0.1/mcp"]) {
      expect(() => checkUrl(raw, "steward"), raw).toThrow(BadUrl);
    }
    expect(isLoopback("127.attacker.example")).toBe(false);
    expect(isLoopback("[::1]")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
  });
});

describe("Link over plain HTTP on loopback", () => {
  it("sends the bearer, and returns a body", async () => {
    const s = await serve();
    const l = await link(s.localhostUrl);
    expect(await l.call("describe", { since_revision: 3 })).toEqual({ kind: "ok", body: { revision: 7, args: { since_revision: 3 } } });
    expect(s.bearers.length).toBeGreaterThan(0);
    expect(s.bearers.every((b) => b === BEARER)).toBe(true);
    expect(l.protocolVersion).toBe("2026-07-28");
  });

  it("speaks the 2025 handshake with era legacy, the bearer sent through its own fetch (review M9)", async () => {
    const s = await serve({ legacyOnly: true });
    const l = await Link.connect({ what: "steward", url: new URL(s.url), bearer: BEARER, era: "legacy" });
    closing.push(() => l.close());
    expect(await l.call("describe")).toMatchObject({ kind: "ok", body: { revision: 7 } });
    expect(l.protocolVersion).toMatch(/^2025-/);
    expect(s.bearers.length).toBeGreaterThan(0);
    expect(s.bearers.every((b) => b === BEARER)).toBe(true);
    // And auto falls back to it against a server that serves only 2025.
    const auto = await link(s.url);
    expect((await auto.call("describe")).kind).toBe("ok");
    expect(auto.protocolVersion).toMatch(/^2025-/);
  });

  it("returns a refusal whole", async () => {
    const l = await link((await serve()).url);
    expect(await l.call("refuse")).toEqual({ kind: "refused", error: "stale_revision", message: "the revision moved",
      body: { error: "stale_revision", message: "the revision moved", revision: 8 } });
  });

  it("returns a held call as held, and any other protocol error as lost", async () => {
    const l = await link((await serve()).url);
    expect(await l.call("hold")).toEqual({ kind: "held", message: "the store did not answer" });
    await expect(l.call("other")).rejects.toThrow(Lost);
  });

  it("tells a call the server says it did not take (pending false) from one that may have been (no data) (review M2)", async () => {
    const l = await link((await serve()).url);
    const notTaken = await l.call("fail").catch((e) => e);
    expect(notTaken).toBeInstanceOf(NotTaken);
    expect(notTaken.message).toMatch(/the steward's fail: nothing was taken: the store did not answer/);
    const maybe = await l.call("other").catch((e) => e);
    expect(maybe).toBeInstanceOf(Lost);
    expect(maybe.answered).toBe(true);
  });

  it("says a server that is not there is unreachable, without the bearer", async () => {
    const s = await serve();
    await s.close();
    const err = await Link.connect({ what: "applier", url: new URL(s.url), bearer: BEARER }).catch((e) => e);
    expect(err).toBeInstanceOf(Unreachable);
    expect(err.message).toMatch(/the applier at http:\/\/127\.0\.0\.1:\d+ could not be reached/);
    expect(err.message).not.toContain(BEARER);
  });
});

describe("Link over TLS with a CA of its own", () => {
  let one: Awaited<ReturnType<typeof testCa>>;
  let other: Awaited<ReturnType<typeof testCa>>;
  beforeAll(async () => {
    [one, other] = await Promise.all([testCa(), testCa()]);
  });

  it("validates the server's certificate against the CA it is given", async () => {
    const s = await serve({ tls: { cert: one.cert, key: one.key } });
    const l = await link(s.url, one.ca);
    expect((await l.call("describe")).kind).toBe("ok");
    expect(s.bearers.every((b) => b === BEARER)).toBe(true);
    // localhost, as the installation's URLs name it.
    const l2 = await link(s.localhostUrl, one.ca);
    expect((await l2.call("describe")).kind).toBe("ok");
  });

  it("refuses a certificate from another CA, and one with no CA given", async () => {
    const s = await serve({ tls: { cert: one.cert, key: one.key } });
    const wrong = await Link.connect({ what: "steward", url: new URL(s.url), bearer: BEARER, ca: other.ca }).catch((e) => e);
    expect(wrong).toBeInstanceOf(Unreachable);
    expect(wrong.message).toMatch(/certificate/i);
    const none = await Link.connect({ what: "steward", url: new URL(s.url), bearer: BEARER }).catch((e) => e);
    expect(none).toBeInstanceOf(Unreachable);
    expect(s.bearers).toEqual([]);
  });

  it("keeps each link's CA its own: one link's trust is not another's", async () => {
    const a = await serve({ tls: { cert: one.cert, key: one.key } });
    const b = await serve({ tls: { cert: other.cert, key: other.key } });
    const la = await link(a.url, one.ca);
    expect((await la.call("describe")).kind).toBe("ok");
    await expect(Link.connect({ what: "applier", url: new URL(b.url), bearer: BEARER, ca: one.ca })).rejects.toBeInstanceOf(Unreachable);
    const lb = await link(b.url, other.ca);
    expect((await lb.call("describe")).kind).toBe("ok");
    // Nothing process-wide was changed: Node's own fetch still refuses the test CA's server.
    await expect(fetch(a.url, { method: "POST" })).rejects.toThrow();
  });
});
