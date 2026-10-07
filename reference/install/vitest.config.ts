import { defineConfig } from "vitest/config";

// Every test drives Docker: long timeouts, and one stack per file.
export default defineConfig({
  test: {
    testTimeout: 300_000,
    hookTimeout: 300_000,
    globalSetup: ["./test/docker.ts"],
  },
});
