import { defineConfig } from "vitest/config";

// The link tests start MCP servers on loopback and make a test CA with the host's openssl.
export default defineConfig({ test: { testTimeout: 30_000, maxWorkers: 2 } });
