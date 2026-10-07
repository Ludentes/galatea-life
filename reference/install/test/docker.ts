// These tests need Docker. Without it they fail with this message; they
// are never skipped, so a green run always means the store was tested.
import { execFileSync } from "node:child_process";

export default function setup(): void {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    throw new Error("reference/install's tests need Docker with the compose plugin, and a running daemon");
  }
}
