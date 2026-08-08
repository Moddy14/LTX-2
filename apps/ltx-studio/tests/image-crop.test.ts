import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildImageCropFilter,
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

/** Mittlere Helligkeit eines 16×16-Blocks — trennt Bokeh-Fläche von schwarzem Balken. */
function cornerLuma(path: string, x: number, y: number): number {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", path,
    "-vf", `crop=16:16:${x}:${y}`,
    "-f", "rawvideo", "-pix_fmt", "gray", "-",
  ], { timeout: 10_000, maxBuffer: 1 << 20 });
  expect(result.status, result.stderr?.toString()).toBe(0);
  const pixels = result.stdout;
  expect(pixels.length).toBe(256);
  return pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
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

  it("fits a portrait into a widescreen frame without bars or distortion", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source.png");
    // Durchgehend weiße Quelle: Weichzeichnen von Weiß bleibt weiß, während
    // Balken schwarz wären. Die Eckhelligkeit trennt beide Fälle eindeutig.
    ffmpeg(["-f", "lavfi", "-i", "color=size=512x512:color=white", "-frames:v", "1", source]);

    const prepared = await prepareImageCrop({
      path: source,
      sourceName: "portrait.png",
      x: 0,
      y: 0,
      width: 512,
      height: 512,
      outputWidth: 1280,
      outputHeight: 704,
      fit: "bokeh",
    }, join(root, "uploads"));

    expect(probeVideoMetadata(prepared.file.path)).toMatchObject({ width: 1280, height: 704 });
    expect(prepared).toMatchObject({
      target: { width: 1280, height: 704 },
      fit: "bokeh",
      coverage: 0.94,
      feather: 90,
    });
    for (const [x, y] of [[0, 0], [1264, 0], [0, 688], [1264, 688]]) {
      expect(cornerLuma(prepared.file.path, x, y),
        `Ecke ${x},${y} ist dunkel — dort steht ein Balken statt Bokeh`).toBeGreaterThan(200);
    }
  });

  it("keeps the stretch filter unchanged and switches structure only for bokeh", () => {
    const base = {
      path: "/tmp/x.png", x: 10, y: 20, width: 300, height: 300,
      outputWidth: 1280, outputHeight: 704,
    };

    const stretch = buildImageCropFilter(base);
    expect(stretch).toMatchObject({ flag: "-vf", fit: "stretch", coverage: null, feather: null });
    expect(stretch.filter).toBe(
      "crop=300:300:10:20:exact=1,scale=1280:704:flags=lanczos,setsar=1");

    const bokeh = buildImageCropFilter({ ...base, fit: "bokeh", coverage: 0.8, feather: 40 });
    expect(bokeh).toMatchObject({ flag: "-filter_complex", fit: "bokeh", coverage: 0.8, feather: 40 });
    // Vordergrund proportional eingepasst, Hintergrund formatfüllend ohne Verzerrung.
    expect(bokeh.filter).toContain("scale=1024:563:force_original_aspect_ratio=decrease");
    expect(bokeh.filter).toContain("force_original_aspect_ratio=increase");
    expect(bokeh.filter).toContain("/40)");
  });

  it("makes the foreground fully opaque when no feather is requested", () => {
    const plan = buildImageCropFilter({
      path: "/tmp/x.png", x: 0, y: 0, width: 100, height: 100,
      outputWidth: 640, outputHeight: 360, fit: "bokeh", feather: 0,
    });
    expect(plan.filter).toContain("a='255'");
    expect(plan.feather).toBe(0);
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
