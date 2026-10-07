import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBest, readFolders, scan, tokenize, type LibraryItem } from "../src/library.js";

function tree(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "lib-"));
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "");
  }
  return root;
}

const item = (path: string, episode = false): LibraryItem => ({ path, tokens: tokenize(path), episode });

describe("tokenize", () => {
  it("lowercases, splits on anything not a letter or digit, any script", () => {
    expect(tokenize("Дюна (2021)/Дюна.Part_Two-1080p")).toEqual(["дюна", "2021", "дюна", "part", "two", "1080p"]);
  });
  it("gives nothing for punctuation alone", () => {
    expect(tokenize(" -- ")).toEqual([]);
  });
});

describe("readFolders", () => {
  it("defaults to ~/Videos when the file is absent", async () => {
    expect(await readFolders("/nonexistent/folders", "/home/a")).toEqual(["/home/a/Videos"]);
  });
  it("reads absolute paths and ~/, skipping blanks, comments and relative paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const cfg = join(dir, "folders");
    writeFileSync(cfg, "# films\n/srv/films\n\n~/Series\nrelative/path\n");
    expect(await readFolders(cfg, "/home/a")).toEqual(["/srv/films", "/home/a/Series"]);
  });
});

describe("scan", () => {
  it("finds video files at any depth below each folder, and marks episodes", async () => {
    const root = tree([
      "Films/Дюна (2021)/Дюна.mkv",
      "Series/Show/Show S01E02.mp4",
      "Films/notes.txt",
      "Films/.hidden/Secret.mkv",
    ]);
    const items = await scan([join(root, "Films"), join(root, "Series"), join(root, "Missing")]);
    const byName = Object.fromEntries(items.map((i) => [i.path.slice(root.length), i]));
    expect(Object.keys(byName).sort()).toEqual(["/Films/Дюна (2021)/Дюна.mkv", "/Series/Show/Show S01E02.mp4"]);
    expect(byName["/Films/Дюна (2021)/Дюна.mkv"]!.tokens).toEqual(["дюна", "2021", "дюна"]);
    expect(byName["/Films/Дюна (2021)/Дюна.mkv"]!.episode).toBe(false);
    expect(byName["/Series/Show/Show S01E02.mp4"]!.episode).toBe(true);
  });
  it("returns nothing reached through a symbolic link, file or directory, leading outside", async () => {
    // Final review T-a: GA-BRIDGE-54 keeps launch to the configured folders.
    const outside = tree(["Elsewhere/Outside.mkv"]);
    const root = tree(["Films/Inside.mkv"]);
    symlinkSync(join(outside, "Elsewhere"), join(root, "Films", "Linked Dir"));
    symlinkSync(join(outside, "Elsewhere", "Outside.mkv"), join(root, "Films", "Linked.mkv"));
    const items = await scan([join(root, "Films")]);
    expect(items.map((i) => i.path)).toEqual([join(root, "Films", "Inside.mkv")]);
  });

  it("stops at the depth limit", async () => {
    const root = tree(["a/b/c/Deep.mkv"]);
    // The folder's own entries are depth 1, so the file inside a/b/c is at depth 4.
    expect(await scan([root], 3)).toEqual([]);
    expect((await scan([root], 4)).length).toBe(1);
  });
});

describe("findBest", () => {
  const items = [
    item("/v/Dune (2021)/Dune.mkv"),
    item("/v/Dune Part Two (2024)/Dune Part Two.mkv"),
    item("/v/Show/Show s01e02.mkv", true),
    item("/v/Show Movie/Show.mkv"),
  ];
  it("needs every word of the title", () => {
    expect(findBest(items, { title: "Dune Two" })?.path).toBe("/v/Dune Part Two (2024)/Dune Part Two.mkv");
    expect(findBest(items, { title: "Dune Three" })).toBeUndefined();
  });
  it("prefers the match with the fewest words", () => {
    expect(findBest(items, { title: "dune" })?.path).toBe("/v/Dune (2021)/Dune.mkv");
  });
  it("filters by kind", () => {
    expect(findBest(items, { title: "Show", kind: "episode" })?.path).toBe("/v/Show/Show s01e02.mkv");
    expect(findBest(items, { title: "Show", kind: "movie" })?.path).toBe("/v/Show Movie/Show.mkv");
  });
  it("matches nothing without a title", () => {
    expect(findBest(items, {})).toBeUndefined();
    expect(findBest(items, { title: "  " })).toBeUndefined();
  });
});
