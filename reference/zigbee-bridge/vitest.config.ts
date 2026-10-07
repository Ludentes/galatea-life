import { defineConfig } from "vitest/config";

// Each store test starts its own PGlite, whose first start in a worker compiles Postgres to
// WebAssembly: about 3 s alone, and past vitest's default 5 s when every package's tests run at once.
// Each worker holds its PGlites: four at most, so a whole test run cannot take the desktop down
// (2026-10-05, two out-of-memory kills with a worker per core).
export default defineConfig({ test: { testTimeout: 30_000, globalSetup: ["test/global-setup.ts"], maxWorkers: 4 } });
