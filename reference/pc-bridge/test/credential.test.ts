import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CredentialError, LINUX_CREDENTIAL, readCredential } from "../src/credential.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function credential(text: string, mode: number): string {
  const d = mkdtempSync(join(tmpdir(), "galatea-cred-"));
  dirs.push(d);
  const p = join(d, "credential");
  writeFileSync(p, text);
  chmodSync(p, mode);
  return p;
}

describe("readCredential", () => {
  it("is /etc/galatea-pc-bridge/credential on Linux", () => {
    expect(LINUX_CREDENTIAL).toBe("/etc/galatea-pc-bridge/credential");
  });

  it("reads the password of a file only its owner reaches, without the trailing newline", () => {
    expect(readCredential(credential("s3cret-not-real\n", 0o600))).toBe("s3cret-not-real");
    expect(readCredential(credential("s3cret-not-real", 0o400))).toBe("s3cret-not-real");
  });

  it("refuses a file other accounts can read or write, without saying what it holds", () => {
    for (const mode of [0o640, 0o604, 0o620, 0o644]) {
      const p = credential("s3cret-not-real\n", mode);
      expect(() => readCredential(p)).toThrow(CredentialError);
      expect(() => readCredential(p)).toThrow(/other accounts must not reach it/);
      try {
        readCredential(p);
      } catch (err) {
        expect(String(err)).not.toContain("s3cret");
      }
    }
  });

  it("refuses a file another account owns, one that is empty, and one that is not there", () => {
    const p = credential("s3cret-not-real\n", 0o600);
    expect(() => readCredential(p, process.geteuid!() + 1)).toThrow(/is owned by uid/);
    expect(() => readCredential(credential("\n", 0o600))).toThrow(/is empty/);
    expect(() => readCredential("/nonexistent/galatea/credential")).toThrow(/ENOENT/);
  });
});
