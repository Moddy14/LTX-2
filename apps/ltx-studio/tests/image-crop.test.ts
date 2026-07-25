import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  ImageCropPreparationError,
  prepareImageCrop,
} from "../server/imageCrop.js";
import { probeVideoMetadata } from "../server/mediaProbe.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-image-crop-"));
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

describe("deterministic image crop preparation", () => {
  it("creates a dimension-verified PNG and reports the exact transform", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.png");
    ffmpeg(["-f", "lavfi", "-i", "testsrc=size=704x1248:rate=1", "-frames:v", "1", source]);

    const prepared = await prepareImageCrop({
      path: source,
      sourceName: "portrait-reference.png",
      x: 180,
      y: 0,
      width: 344,
      height: 344,
      outputWidth: 576,
      outputHeight: 576,
    }, join(root, "uploads"));

    expect(prepared.file.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(prepared.file.originalname).toBe("portrait-reference-crop-180-0-344x344-to-576x576.png");
    expect(probeVideoMetadata(prepared.file.path)).toMatchObject({ width: 576, height: 576 });
    expect(prepared).toMatchObject({
      source: { width: 704, height: 1248 },
      crop: { x: 180, y: 0, width: 344, height: 344 },
      target: { width: 576, height: 576 },
      scaleFilter: "lanczos",
    });
    expect(prepared.command).toContain("crop=344:344:180:0:exact=1");
    expect(prepared.command).toContain("scale=576:576:flags=lanczos");
  });

  it("rejects a crop that extends beyond the source image", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.png");
    ffmpeg(["-f", "lavfi", "-i", "color=size=320x240:color=black", "-frames:v", "1", source]);

    const failure = prepareImageCrop({
      path: source,
      x: 200,
      y: 0,
      width: 160,
      height: 160,
      outputWidth: 576,
      outputHeight: 576,
    }, join(root, "uploads"));
    await expect(failure).rejects.toMatchObject({
      name: ImageCropPreparationError.name,
      statusCode: 400,
    });
  });
});
