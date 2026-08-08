import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { extractOutputFrame, OutputFrameError } from "../server/outputFrame.js";
import { probeVideoMetadata } from "../server/mediaProbe.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-output-frame-"));
  roots.push(root);
  return root;
}

/** Zweifarbiger Clip: die erste Sekunde rot, danach grün. */
function makeTwoToneClip(path: string): void {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=size=320x176:color=red:rate=25:duration=1",
    "-f", "lavfi", "-i", "color=size=320x176:color=green:rate=25:duration=1",
    "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
    "-map", "[v]", "-c:v", "libx264", "-pix_fmt", "yuv420p", path,
  ], { encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

/** Dominanter Farbkanal eines Bildes: "rot" oder "gruen". */
function dominantChannel(path: string): "rot" | "gruen" | "anders" {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", path,
    "-vf", "scale=1:1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
  ], { timeout: 10_000 });
  expect(result.status, result.stderr?.toString()).toBe(0);
  const [r, g] = result.stdout;
  if (r > g + 40) return "rot";
  if (g > r + 40) return "gruen";
  return "anders";
}

describe("taking a frame from a finished output", () => {
  it("grabs the frame at the requested time, not just the first one", async () => {
    const root = await temporaryRoot();
    makeTwoToneClip(join(root, "shot.mp4"));

    const early = await extractOutputFrame(
      { output: "shot.mp4", atSeconds: 0.2 }, root, join(root, "uploads"));
    const late = await extractOutputFrame(
      { output: "shot.mp4", atSeconds: 1.5 }, root, join(root, "uploads"));

    expect(dominantChannel(early.file.path)).toBe("rot");
    expect(dominantChannel(late.file.path)).toBe("gruen");
    expect(probeVideoMetadata(late.file.path)).toMatchObject({ width: 320, height: 176 });
    expect(late.file.originalname).toBe("shot-frame-1.50s.png");
    expect(late).toMatchObject({ outputName: "shot.mp4", width: 320, height: 176 });
  });

  it("refuses a time behind the end of the clip", async () => {
    const root = await temporaryRoot();
    makeTwoToneClip(join(root, "shot.mp4"));

    await expect(extractOutputFrame(
      { output: "shot.mp4", atSeconds: 9 }, root, join(root, "uploads"),
    )).rejects.toThrow(/liegt hinter dem Ende/);
  });

  it("refuses a missing output and an unsafe name", async () => {
    const root = await temporaryRoot();

    await expect(extractOutputFrame(
      { output: "fehlt.mp4", atSeconds: 0 }, root, join(root, "uploads"),
    )).rejects.toMatchObject({ name: OutputFrameError.name, statusCode: 404 });

    await expect(extractOutputFrame(
      { output: "../escape.mp4", atSeconds: 0 }, root, join(root, "uploads"),
    )).rejects.toThrow(/Unzulässiger Ausgabename/);
  });
});
