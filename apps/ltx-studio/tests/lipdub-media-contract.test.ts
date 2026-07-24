import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { buildCommand, validateRequestPlan } from "../server/command.js";
import { probeVideoMetadata } from "../server/mediaProbe.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryVideoPath(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-lipdub-media-"));
  roots.push(root);
  return join(root, name);
}

function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe("LipDub media contract", () => {
  it("detects whether the reference video contains an audio stream", async () => {
    const silent = await temporaryVideoPath("silent.mp4");
    const withAudio = await temporaryVideoPath("with-audio.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=24",
      "-frames:v",
      "9",
      "-an",
      "-c:v",
      "mpeg4",
      silent,
    ]);
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=0.4",
      "-shortest",
      "-frames:v",
      "9",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      withAudio,
    ]);

    expect(probeVideoMetadata(silent)).toMatchObject({ frames: 9, hasAudio: false });
    expect(probeVideoMetadata(withAudio)).toMatchObject({ frames: 9, hasAudio: true });
  });

  it("blocks native LipDub planning when the reference video has no audio stream", async () => {
    const silent = await temporaryVideoPath("silent.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=24",
      "-frames:v",
      "9",
      "-an",
      "-c:v",
      "mpeg4",
      silent,
    ]);
    const request = validRequest("lipdub");
    request.lipDub.referenceVideo.path = silent;
    const errors = validateRequestPlan(request, buildCommand(request));

    expect(errors).toContain(`LipDub-Referenzvideo enthält keine Audiospur (${silent})`);
  });
});
