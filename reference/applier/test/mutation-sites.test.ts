// The reach lint (docs/plans/2026-10-06-harness-reach.md): a mutation reaches a check only if the
// check evaluates one of its sites, which holds only while every mutation is read through a direct
// comparison with its name. Every mutation the matrix runs has a site, as many built as written.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { lint } from "@ludentes/galatea-life-harness/reach";

const here = join(import.meta.dirname, "..");
const walk = (dir: string, ext: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name), ext) : e.name.endsWith(ext) && !e.name.endsWith(".d.ts") ? [join(dir, e.name)] : []);
const read = (file: string) => ({ file, text: readFileSync(file, "utf8") });
const json = (f: string) => JSON.parse(readFileSync(join(here, f), "utf8"));

describe("mutation sites", () => {
  it("are direct comparisons, one at least per mutation of subject.json and proposed-rows.json, all built", () => {
    const mutations = [...json("subject.json").mutations, ...json("proposed-rows.json").rows.map((r: { mutation: string }) => r.mutation)];
    expect(lint({ mutations, sources: walk(join(here, "src"), ".ts").map(read), built: walk(join(here, "dist"), ".js").map(read),
      declarations: ["mutations.ts", "mutations.js"] })).toEqual([]);
  });
});
