import { describe, expect, it } from "vitest";
import { checkArg, toolArguments, toOutcome } from "../src/plugins/command.js";
import type { ManifestAction } from "../src/plugins/manifest.js";

const act = (args?: Record<string, unknown>, confirms = true): ManifestAction =>
  ({ action: "media.launch", tool: "launch", idempotent: false, stateless: false, confirms, ...(args ? { args } : {}) });

describe("checkArg", () => {
  it("takes any scalar for \"any\", one of a list, a number within bounds, and an object's fields", () => {
    expect(checkArg("title", "any", "Up")).toBeNull();
    expect(checkArg("title", "any", { x: 1 })).toBe("title is not a string, a number or a boolean");
    expect(checkArg("kind", ["movie", "episode"], "movie")).toBeNull();
    expect(checkArg("kind", ["movie", "episode"], "song")).toBe('kind is none of ["movie","episode"]');
    expect(checkArg("volume", { min: 0, max: 100 }, 100)).toBeNull();
    expect(checkArg("volume", { min: 0, max: 100 }, 101)).toBe("volume is above 100");
    expect(checkArg("volume", { min: 0, max: 100 }, -1)).toBe("volume is below 0");
    expect(checkArg("volume", { min: 0, max: 100 }, "50")).toBe("volume is not a number");
    const search = { title: "any", kind: ["movie", "episode"], year: { min: 1900, optional: true } };
    expect(checkArg("search", search, { title: "Up", kind: "movie" })).toBeNull();
    // An object argument's fields are supported, not required (applier, *Capabilities and actions*; I5).
    expect(checkArg("search", search, { title: "Up" })).toBeNull();
    expect(checkArg("search", search, {})).toBeNull();
    expect(checkArg("search", search, { title: "Up", kind: "movie", path: "/" })).toBe("search has unknown keys: path");
    expect(checkArg("search", search, { title: "Up", kind: "movie", year: 1800 })).toBe("search.year is below 1900");
  });
});

describe("toolArguments", () => {
  it("carries none for an action of no argument, refusing a value", () => {
    expect(toolArguments(act(), false, undefined)).toEqual({ ok: true, args: {} });
    expect(toolArguments(act(), true, 1)).toEqual({ ok: false, why: "media.launch takes no argument" });
  });

  it("names the one argument's bare value as the manifest names it", () => {
    const a = act({ volume: { min: 0, max: 100 } });
    expect(toolArguments(a, true, 30)).toEqual({ ok: true, args: { volume: 30 } });
    expect(toolArguments(a, false, undefined)).toEqual({ ok: false, why: "volume is missing" });
    expect(toolArguments(act({ delay_s: { min: 0, optional: true } }), false, undefined)).toEqual({ ok: true, args: {} });
    const search = act({ search: { title: "any", kind: ["movie", "episode"] } });
    expect(toolArguments(search, true, { title: "Up", kind: "movie" })).toEqual({ ok: true, args: { search: { title: "Up", kind: "movie" } } });
    expect(toolArguments(search, true, { title: "Up" })).toEqual({ ok: true, args: { search: { title: "Up" } } });
  });

  it("takes several arguments as an object of them", () => {
    const a = act({ path: "any", depth: { min: 1, optional: true } });
    expect(toolArguments(a, true, { path: "/media" })).toEqual({ ok: true, args: { path: "/media" } });
    expect(toolArguments(a, true, "/media")).toEqual({ ok: false, why: "media.launch takes an object of path, depth" });
    expect(toolArguments(a, true, { path: "/media", shell: "rm" })).toEqual({ ok: false, why: "the value has unknown keys: shell" });
    expect(toolArguments(a, false, undefined)).toEqual({ ok: false, why: "path missing" });
  });
});

describe("toOutcome", () => {
  it("acks a success applied where the action confirms, else sent, never with its text, which may be the state, personal keys and all", () => {
    expect(toOutcome(act(), { kind: "ok", text: "{\"title\":\"Holiday 2025\"}" })).toEqual({ result: "applied" });
    expect(toOutcome(act(undefined, false), { kind: "ok", text: "" })).toEqual({ result: "sent" });
  });

  it("acks isError, a request for input and a failed call failed(no_confirmation), the text capped at 1 KiB", () => {
    expect(toOutcome(act(), { kind: "error", text: "nothing is loaded" })).toEqual({ result: "failed", reason: "no_confirmation", detail: "nothing is loaded" });
    expect(toOutcome(act(), { kind: "input", text: "asked" })).toMatchObject({ result: "failed", reason: "no_confirmation" });
    expect(toOutcome(act(), { kind: "failed", text: "closed" })).toMatchObject({ result: "failed", reason: "no_confirmation" });
    const long = toOutcome(act(), { kind: "error", text: "x".repeat(5000) });
    expect(Buffer.byteLength(long.detail!)).toBeLessThanOrEqual(1024);
    expect(long.detail!.endsWith("…")).toBe(true);
  });
});
