import { defineConfig } from "vitest/config";

// Forks, not threads: `process.umask()` (Task 3) cannot be called in a worker thread.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 20_000, pool: "forks" } });
