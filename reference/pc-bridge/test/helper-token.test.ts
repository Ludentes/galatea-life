import { fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readToken } from "../src/helper/token.js";

/** The helper's start token (review N1), read from the descriptor the service handed it: here a file's. */
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fdOf = (text: string) => {
  const d = mkdtempSync(join(tmpdir(), "galatea-token-"));
  dirs.push(d);
  writeFileSync(join(d, "t"), text);
  return openSync(join(d, "t"), "r");
};
const closed = (fd: number) => {
  try {
    fstatSync(fd);
    return false;
  } catch {
    return true;
  }
};

describe("the helper's start token", () => {
  it("is read to the descriptor's end, and the descriptor closed", async () => {
    const fd = fdOf("ab".repeat(32));
    expect(await readToken(fd)).toBe("ab".repeat(32));
    expect(closed(fd)).toBe(true);
  });

  it("is refused when it is not 64 hex digits, or more than the service ever writes, the descriptor closed all the same", async () => {
    for (const text of ["", "ab".repeat(31), `${"ab".repeat(32)}\n`, "x".repeat(64), "a".repeat(10_000)]) {
      const fd = fdOf(text);
      await expect(readToken(fd)).rejects.toThrow(/start token/);
      expect(closed(fd)).toBe(true);
    }
  });

  it("is refused from a descriptor that is not open", async () => {
    await expect(readToken(9999)).rejects.toThrow(/start token/);
  });
});
