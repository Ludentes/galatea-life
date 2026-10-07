import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { buildTemplate } from "./db.js";

declare module "vitest" {
  export interface ProvidedContext {
    /** The file of the migrated data directory every `memoryDb` starts from. */
    pgliteTemplate: string;
  }
}

/**
 * Migrates one PGlite for the whole run and leaves its data directory in a file, so no worker spends
 * a blank start and the migrations on its first test (each test file runs in a fresh worker).
 */
export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), "galatea-pglite-"));
  const file = join(dir, "template.tar");
  writeFileSync(file, Buffer.from(await (await buildTemplate()).arrayBuffer()));
  project.provide("pgliteTemplate", file);
  return () => rmSync(dir, { recursive: true, force: true });
}
