import { describe, expect, it } from "vitest";
import { Keys } from "../src/core/keys.js";
import { FakeClock } from "./fake-clock.js";

describe("Keys", () => {
  it("claims a key once: held with the same body after it is kept, wait before, another body a conflict, free after 3600 s", () => {
    const clock = new FakeClock();
    const keys = new Keys<string>(() => clock.now());
    const first = keys.claim("owner", "k", "{a}");
    if (first.kind !== "new") throw new Error("a new key");
    expect(keys.claim("owner", "k", "{a}").kind).toBe("wait");
    expect(() => keys.claim("owner", "k", "{b}")).toThrow(/another body/);
    keys.kept(first.claim, "r-1", clock.now());
    expect(keys.claim("owner", "k", "{a}").kind).toBe("wait");      // kept, its request still running
    keys.release(first.claim);
    expect(keys.claim("owner", "k", "{a}")).toEqual({ kind: "held", record: "r-1" });
    expect(keys.claim("client", "k", "{a}").kind).toBe("new");      // scopes apart
    clock.advance(3_599_999);
    expect(keys.claim("owner", "k", "{a}").kind).toBe("held");
    clock.advance(1);
    expect(keys.claim("owner", "k", "{b}").kind).toBe("new");
  });

  it("frees a key never kept when its claim is released, and a kept one when it is forgotten", () => {
    const keys = new Keys<string>(() => 0);
    const c = keys.claim("owner", "k", "{a}");
    if (c.kind !== "new") throw new Error("new");
    keys.release(c.claim);
    const d = keys.claim("owner", "k", "{b}");
    if (d.kind !== "new") throw new Error("new");
    keys.kept(d.claim, "r-2", 0);
    keys.forget(d.claim);
    expect(keys.claim("owner", "k", "{c}").kind).toBe("new");
  });

  it("holds a loaded key until its 3600 s, and prunes it after", () => {
    const clock = new FakeClock();
    const keys = new Keys<string>(() => clock.now());
    keys.hold("owner", "k", "{a}", "r-3", clock.now() - 1000);
    expect(keys.claim("owner", "k", "{a}")).toEqual({ kind: "held", record: "r-3" });
    keys.prune(clock.now() + 3_599_000);
    expect(keys.claim("owner", "k", "{b}").kind).toBe("new");
  });
});
