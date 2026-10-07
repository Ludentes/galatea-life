// The build stands on its own, as it is exported (the public code repository holds no conformance/
// folder): it reaches the harness, the sim and the manifests by package name, never by a path.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = join(import.meta.dirname, "..");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : /\.(m?js|ts|json)$/.test(e.name) ? [join(dir, e.name)] : []);
// A path into the standard's folder: a relative path through it, or its name as a segment given to join.
const REACH = /\.\.\/conformance\b|["']conformance["']\s*,/;
const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));

describe("the build stands without conformance/ beside it", () => {
  it("no script, source or test reaches into conformance/ by path", () => {
    const files = [join(here, "package.json"), ...["scripts", "src", "test"].flatMap((d) => walk(join(here, d)))];
    expect(files.filter((f) => REACH.test(readFileSync(f, "utf8"))).map((f) => f.slice(here.length + 1))).toEqual([]);
  });

  it("takes the harness as a devDependency and calls its bins", () => {
    expect(pkg.devDependencies["@ludentes/galatea-life-harness"]).toBeDefined();
    for (const [name, script] of Object.entries<string>(pkg.scripts)) {
      if (/^(conformance|first-light)/.test(name)) expect(script, name).toMatch(/^galatea-with-postgres node scripts\//);
    }
  });
});
