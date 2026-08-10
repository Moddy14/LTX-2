import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appRoot } from "../server/config.js";
import {
  recommendSceneReferenceFrame,
  SCENE_REFERENCE_YUNET_SHA256,
} from "../server/sceneReferenceFrame.js";
import { MIN_SCENE_REFERENCE_FACE_SHARPNESS } from "../shared/sceneReferenceQuality.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ltx-scene-reference-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const validResult = {
  schemaVersion: "ltx-studio-scene-reference-frame.v1",
  atSeconds: 1.88,
  score: 0.81,
  sampledFrames: 40,
  eligibleFrames: 32,
  metrics: {
    frameIndex: 47,
    atSeconds: 1.88,
    score: 0.81,
    faceConfidence: 0.95,
    faceAreaRatio: 0.08,
    faceSharpness: 91.2,
    brightness: 103,
    exposure: 0.72,
    stability: 0.94,
    frontalness: 0.88,
    prominentFaceCount: 1,
  },
  candidates: [] as unknown[],
};
validResult.candidates = [validResult.metrics];

describe("quality-guided scene reference selection", () => {
  it("pins the YuNet model used to choose a person's reference frame", () => {
    const model = join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
    expect(createHash("sha256").update(readFileSync(model)).digest("hex")).toBe(
      SCENE_REFERENCE_YUNET_SHA256,
    );
  });

  it("parses a bounded selector result and records the exact command", async () => {
    const directory = temporaryDirectory();
    const video = join(directory, "input.mp4");
    const model = join(directory, "yunet.onnx");
    const script = join(directory, "selector.py");
    writeFileSync(video, "video");
    writeFileSync(model, "model");
    writeFileSync(script, `import json\nprint(json.dumps(${JSON.stringify(validResult)}))\n`);

    const result = await recommendSceneReferenceFrame(video, {
      python: "/usr/bin/python3",
      script,
      faceModel: model,
      maxSamples: 40,
    });

    expect(result).toMatchObject(validResult);
    expect(result.command).toContain("--max-samples 40");
    expect(result.command).toContain(`--min-face-sharpness ${MIN_SCENE_REFERENCE_FACE_SHARPNESS}`);
    expect(result.faceModelPath).toBe(model);
  });

  it("fails closed when the selector output does not match the evidence schema", async () => {
    const directory = temporaryDirectory();
    const video = join(directory, "input.mp4");
    const model = join(directory, "yunet.onnx");
    const script = join(directory, "selector.py");
    writeFileSync(video, "video");
    writeFileSync(model, "model");
    writeFileSync(script, "print('{\"atSeconds\": 1.0}')\n");

    await expect(recommendSceneReferenceFrame(video, {
      python: "/usr/bin/python3",
      script,
      faceModel: model,
    })).rejects.toThrow("kein gültiges Ergebnis");
  });

  it("selects the sharp middle of a real blurred-sharp-blurred portrait clip", async () => {
    const directory = temporaryDirectory();
    const video = join(directory, "quality-window.mp4");
    const source = join(appRoot, "docs", "evidence", "figur-b-closeup-1280x704.png");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", source, "-t", "4",
      "-filter_complex",
      "[0:v]scale=640:352,split=3[a0][b0][c0];"
        + "[a0]trim=start=0:end=1.4,setpts=PTS-STARTPTS,boxblur=8:2[a];"
        + "[b0]trim=start=1.4:end=2.8,setpts=PTS-STARTPTS[b];"
        + "[c0]trim=start=2.8:end=4,setpts=PTS-STARTPTS,boxblur=8:2[c];"
        + "[a][b][c]concat=n=3:v=1:a=0,fps=25,format=yuv420p[v]",
      "-map", "[v]", "-c:v", "libx264", "-crf", "18", video,
    ], { timeout: 20_000 });

    const result = await recommendSceneReferenceFrame(video, { maxSamples: 40 });

    expect(result.atSeconds).toBeGreaterThanOrEqual(1.4);
    expect(result.atSeconds).toBeLessThan(2.8);
    expect(result.metrics.faceSharpness).toBeGreaterThan(50);
    expect(result.metrics.prominentFaceCount).toBe(1);
  }, 30_000);

  it("refuses a real encoded clip when every detected face is too soft", async () => {
    const directory = temporaryDirectory();
    const video = join(directory, "soft-throughout.mp4");
    const source = join(appRoot, "docs", "evidence", "figur-b-closeup-1280x704.png");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", source, "-t", "2",
      "-vf", "scale=640:352,boxblur=12:3,fps=25,format=yuv420p",
      "-c:v", "libx264", "-crf", "18", video,
    ], { timeout: 20_000 });

    await expect(recommendSceneReferenceFrame(video, { maxSamples: 24 })).rejects.toThrow(
      "Gesicht ist im gesamten Video zu weich",
    );
  }, 30_000);
});
