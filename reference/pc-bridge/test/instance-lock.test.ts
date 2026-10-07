import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InstanceError, InstanceLock } from "../src/instance-lock.js";
describe("InstanceLock", () => {
  let dir: string;
  const held: InstanceLock[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pc-bridge-lock-"));
  });
  afterEach(async () => {
    for (const l of held.splice(0)) await l.release();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a second bridge on the same state directory until the first lets go", async () => {
    const first = await InstanceLock.acquire(dir);
    await expect(InstanceLock.acquire(dir)).rejects.toThrow(InstanceError);
    await first.release();
    held.push(await InstanceLock.acquire(dir));
  });

  it("lets bridges on two state directories run side by side", async () => {
    const other = mkdtempSync(join(tmpdir(), "pc-bridge-lock-"));
    try {
      held.push(await InstanceLock.acquire(dir), await InstanceLock.acquire(other));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("makes its key once, readable by the bridge alone, and keeps it", async () => {
    const first = await InstanceLock.acquire(dir);
    const key = readFileSync(join(dir, "instance.key"), "utf8");
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(statSync(join(dir, "instance.key")).mode & 0o777).toBe(0o600);
    await first.release();
    held.push(await InstanceLock.acquire(dir));
    expect(readFileSync(join(dir, "instance.key"), "utf8")).toBe(key);
  });

  it("removes a key's temporary file left by a process that died, and leaves a live one's", async () => {
    // Pid 2^22 + 1 is above Linux's pid_max ceiling, so no process holds it.
    writeFileSync(join(dir, "instance.key.4194305.tmp"), "half");
    writeFileSync(join(dir, `instance.key.${process.ppid}.tmp`), "busy");
    held.push(await InstanceLock.acquire(dir));
    expect(readdirSync(dir).sort()).toEqual(["instance.key", `instance.key.${process.ppid}.tmp`]);
  });

  it("refuses a key it did not write", async () => {
    writeFileSync(join(dir, "instance.key"), "not a key");
    await expect(InstanceLock.acquire(dir)).rejects.toThrow(/not a key/);
  });

  it("is free again once its holder is killed, with no stale lock left behind", async () => {
    const module = pathToFileURL(join(import.meta.dirname, "../src/instance-lock.ts")).href;
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `const { InstanceLock } = await import(${JSON.stringify(module)});
       await InstanceLock.acquire(${JSON.stringify(dir)});
       console.log("held");
       setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (b: Buffer) => { if (b.toString().includes("held")) resolve(); });
      child.once("exit", (code) => reject(new Error(`the holder exited early (${code})`)));
    });
    await expect(InstanceLock.acquire(dir)).rejects.toThrow(/another bridge/);
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGKILL");
    await exited;
    held.push(await InstanceLock.acquire(dir));
  });
});
