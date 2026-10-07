import { describe, expect, it } from "vitest";
import { emptyConfig, loadConfig, modelKey, saveConfig } from "../src/config/config.js";
import { memoryStore } from "./db.js";

describe("config", () => {
  it("saves and loads clients, bridges, adoptions, replaced identifiers and the time source, and saving twice is safe", async () => {
    const s = await memoryStore();
    const c = emptyConfig();
    c.clients.set("h", { id: "h", credential: "credential-1", kind: "steward", token_key: "k".repeat(16) });
    c.bridges.set("b", { id: "b", identity: "b" });
    c.adoptions.set("b:lamp", { class: "light" });
    c.previous.set("b:lamp", ["test:old", "test:older"]);
    c.timeSource = "127.0.0.1:1234";
    await s.write((tx) => saveConfig(tx, c));
    await s.write((tx) => saveConfig(tx, c));
    const back = await loadConfig(s);
    expect([...back.clients.values()]).toEqual([...c.clients.values()]);
    expect([...back.bridges.values()]).toEqual([...c.bridges.values()]);
    expect([...back.adoptions.entries()]).toEqual([["b:lamp", { class: "light" }]]);
    expect([...back.previous.entries()]).toEqual([["b:lamp", ["test:old", "test:older"]]]);
    expect(back.timeSource).toBe("127.0.0.1:1234");
  });

  it("gives the same model key whatever the time source or a client's secrets", () => {
    const a = emptyConfig();
    const b = emptyConfig();
    b.timeSource = "127.0.0.1:1";
    expect(modelKey(a)).toBe(modelKey(b));
    a.clients.set("h", { id: "h", credential: "h-credential", kind: "steward" });
    b.clients.set("h", { id: "h", credential: "rotated-credential", kind: "steward", token_key: "a-new-token-key-0001" });
    expect(modelKey(a)).toBe(modelKey(b));
    b.clients.set("h", { id: "h", credential: "rotated-credential", kind: "parent" });
    expect(modelKey(a)).not.toBe(modelKey(b));
    const adopted = emptyConfig();
    adopted.adoptions.set("b:lamp", { class: "light" });
    expect(modelKey(adopted)).not.toBe(modelKey(emptyConfig()));
    const replaced = emptyConfig();
    replaced.previous.set("b:lamp", ["test:old"]);
    expect(modelKey(replaced)).not.toBe(modelKey(emptyConfig()));
  });
});
