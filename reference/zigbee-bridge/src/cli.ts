#!/usr/bin/env node
import { run } from "./herdsman/cli.js";
import { useHerdsmanLogger } from "./herdsman/log.js";

/**
 * `zigbee-bridge`, the owner's commands (the design, *The network guard*): `form --channel N` and
 * `backup --out FILE`. Every file herdsman writes is the owner's alone, and herdsman's log goes through
 * the bridge's redaction, which never lets the network key through (GA-BRIDGE-24).
 */
process.umask(0o077);
useHerdsmanLogger({ write: (line) => console.error(line), debug: process.env.GALATEA_ZIGBEE_DEBUG === "1" });
process.exitCode = await run(process.argv.slice(2), process.env, { out: (l) => console.log(l), err: (l) => console.error(l) });
