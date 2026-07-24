import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  LipDubReferencePreparationError,
  prepareLipDubReference,
} from "../server/lipdubPrep.js";
import { probeVideoMetadata } from "../server/mediaProbe.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-lipdub-prep-"));
  roots.push(root);
  return root;
}

function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

describe("LipDub reference preparation", () => {
  it("normalizes a reference video to a reusable H.264/AAC Studio asset", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=360x640:rate=24000/1001",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=1000:duration=1.1",
      "-t",
      "1.1",
      "-shortest",
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      source,
    ]);

    const request = validRequest("lipdub");
    request.lipDub.referenceVideo.path = source;
    request.width = 576;
    request.height = 1024;
    const prepared = await prepareLipDubReference(request, join(root, "uploads"));
    const metadata = probeVideoMetadata(prepared.file.path);

    expect(prepared.file.filename).toMatch(/^[0-9a-f-]{36}\.mp4$/);
    expect(prepared.file.originalname).toBe("source-lipdub-prep.mp4");
    expect(prepared.target.fps).toBe(24);
    expect(prepared.target.width % 64).toBe(0);
    expect(prepared.target.height % 64).toBe(0);
    expect(metadata).toMatchObject({
      width: prepared.target.width,
      height: prepared.target.height,
      hasAudio: true,
    });
    expect(metadata?.fps).toBeCloseTo(24, 2);
  });

  it("refuses to prepare LipDub references without audio", async () => {
    const root = await temporaryRoot();
    const source = join(root, "silent.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=360x640:rate=24",
      "-t",
      "1",
      "-an",
      "-c:v",
      "mpeg4",
      source,
    ]);

    const request = validRequest("lipdub");
    request.lipDub.referenceVideo.path = source;

    await expect(prepareLipDubReference(request, join(root, "uploads"))).rejects.toThrow(
      LipDubReferencePreparationError,
    );
  });
});
