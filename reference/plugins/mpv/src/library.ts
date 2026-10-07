import { readFile, readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";

export interface LibraryItem { path: string; tokens: string[]; episode: boolean }
export interface Search { title?: string; kind?: "movie" | "episode" }

const VIDEO = new Set([".mkv", ".mp4", ".avi", ".webm", ".mov", ".m4v", ".ts", ".wmv", ".mpg", ".mpeg"]);
const EPISODE = [/^s\d{1,2}e\d{1,3}$/, /^\d{1,2}x\d{1,3}$/];

export function tokenize(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** The folders the owner listed, one absolute path a line; `~/Videos` when there is no list. */
export async function readFolders(configPath: string, home: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return [join(home, "Videos")];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => (l.startsWith("~/") ? join(home, l.slice(2)) : l))
    .filter((l) => isAbsolute(l));
}

/** Every video file below each folder, hidden entries and symbolic links skipped. */
export async function scan(folders: string[], maxDepth = 6): Promise<LibraryItem[]> {
  const items: LibraryItem[] = [];
  async function walk(root: string, dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(root, path, depth + 1);
      } else if (e.isFile() && VIDEO.has(extname(e.name).toLowerCase())) {
        const rel = relative(root, path);
        const tokens = tokenize(rel.slice(0, rel.length - extname(rel).length));
        items.push({ path, tokens, episode: tokens.some((t) => EPISODE.some((re) => re.test(t))) });
      }
    }
  }
  for (const folder of folders) await walk(folder, folder, 1);
  return items;
}

/** The item holding every word of the title, the fewest words winning, then the path. */
export function findBest(items: LibraryItem[], search: Search): LibraryItem | undefined {
  const words = tokenize(search.title ?? "");
  if (words.length === 0) return undefined;
  return items
    .filter((i) => search.kind === undefined || i.episode === (search.kind === "episode"))
    .filter((i) => words.every((w) => i.tokens.includes(w)))
    .sort((a, b) => a.tokens.length - b.tokens.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))[0];
}
