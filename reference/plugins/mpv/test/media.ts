import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** A silent test-pattern video: a video stream only, never audio (the repository holds no audio). */
export function makeVideo(path: string, seconds = 30): void {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=64x48:rate=5`,
    "-an", "-c:v", "mpeg4", path,
  ]);
}
