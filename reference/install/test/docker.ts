// These tests need Docker. Without it they fail with this message; they
// are never skipped, so a green run always means the store was tested.
// The applier's and the steward's images are built once here, from this checkout, before any file
// starts a stack: test files run side by side, and two builds of one tag at once would race.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export default function setup(): void {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    throw new Error("reference/install's tests need Docker with the compose plugin, and a running daemon");
  }
  for (const build of ["applier", "steward"]) {
    execFileSync("docker", ["build", "-q", "-f", `reference/${build}/Dockerfile`, "-t", `galatea-${build}:local`, "."],
      { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
  }
}
