import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { appRoot, pythonExecutable } from "../server/config.js";
import type { StudioJob } from "../server/jobs.js";
import { OutputAnalysisManager } from "../server/outputAnalysis.js";
import { OutputLibrary } from "../server/outputs.js";
import { validRequest } from "./fixtures.js";

const faceModel = join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
const runtimeAvailable = existsSync(faceModel)
  && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
  && spawnSync(pythonExecutable, ["-c", "import cv2"], { stdio: "ignore" }).status === 0;
const integrationIt = runtimeAvailable ? it : it.skip;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function job(
  outputName: string,
  id = "2c8a5dc6-8864-49f7-a639-85caef918888",
): StudioJob {
  const request = validRequest("audio-to-video");
  request.outputName = outputName;
  return {
    id,
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName,
    outputUrl: `/api/jobs/2c8a5dc6-8864-49f7-a639-85caef918888/output`,
    createdAt: "2026-07-24T18:00:00.000Z",
    startedAt: "2026-07-24T18:00:00.000Z",
    finishedAt: "2026-07-24T18:00:01.000Z",
    progress: 100,
    error: null,
    logs: [],
    command: "python -m ltx_pipelines.a2vid",
    request,
    favorite: false,
    variantOf: null,
    runtimeMs: 1_000,
    cancelledBy: null,
    dgxJobId: null,
    thermalProfile: null,
  };
}

integrationIt("runs the bounded CPU worker through the persisted analysis queue", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-integration-"));
  roots.push(root);
  const outputName = "synthetic-speech.mp4";
  const outputPath = join(root, outputName);
  const generated = spawnSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=320x240:r=24:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=1",
    "-shortest",
    "-c:v", "mpeg4",
    "-c:a", "aac",
    "-y",
    outputPath,
  ], { encoding: "utf8", timeout: 15_000 });
  expect(generated.status, generated.stderr).toBe(0);

  const completedJob = job(outputName);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root);
  manager.start(outputName);

  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 200 && current && ["queued", "running"].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    progress: 100,
    result: {
      status: "insufficient",
      technical: {
        hasAudio: true,
      },
      face: {
        detectedFrames: 0,
      },
    },
  });
}, 20_000);

integrationIt("waits for a timed-out worker to close before starting the next queued analysis", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-timeout-"));
  roots.push(root);
  const firstName = "timeout-first.mp4";
  const secondName = "timeout-second.mp4";
  const firstPath = join(root, firstName);
  const secondPath = join(root, secondName);
  const generated = spawnSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=64x64:r=8:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=1",
    "-shortest",
    "-c:v", "mpeg4",
    "-c:a", "aac",
    "-y",
    firstPath,
  ], { encoding: "utf8", timeout: 15_000 });
  expect(generated.status, generated.stderr).toBe(0);
  await copyFile(firstPath, secondPath);

  const workerScript = join(root, "slow-worker.py");
  const startsPath = join(root, "starts.log");
  await writeFile(workerScript, [
    "import argparse, signal, sys, time",
    "parser = argparse.ArgumentParser()",
    "parser.add_argument('--video', required=True)",
    "parser.add_argument('--face-model', required=True)",
    "parser.add_argument('--max-frames')",
    "args = parser.parse_args()",
    "with open(args.face_model, 'a', encoding='utf-8') as handle:",
    "    handle.write(f'{time.monotonic()} {args.video}\\n')",
    "    handle.flush()",
    "def stop(_signal, _frame):",
    "    time.sleep(0.25)",
    "    raise SystemExit(1)",
    "signal.signal(signal.SIGTERM, stop)",
    "time.sleep(60)",
    "",
  ].join("\n"));

  const firstJob = job(firstName);
  const secondJob = job(secondName, "2c8a5dc6-8864-49f7-a639-85caef918889");
  const library = new OutputLibrary(root);
  library.recordCompleted([firstJob, secondJob]);
  const manager = new OutputAnalysisManager(library, () => [firstJob, secondJob], root, {
    workerScript,
    faceModel: startsPath,
    timeoutMs: 50,
    terminationGraceMs: 1_000,
  });
  manager.start(firstName);
  manager.start(secondName);

  let first = manager.get(firstName);
  let second = manager.get(secondName);
  for (let attempt = 0; attempt < 200
    && [first?.status, second?.status].some((status) => status === "queued" || status === "running");
    attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    first = manager.get(firstName);
    second = manager.get(secondName);
  }

  expect(first?.status).toBe("failed");
  expect(second?.status).toBe("failed");
  const starts = (await readFile(startsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => Number(line.split(" ", 1)[0]));
  expect(starts).toHaveLength(2);
  expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(0.2);
}, 20_000);

integrationIt("detects variable frame timing from actual frame timestamps", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-vfr-"));
  roots.push(root);
  const outputPath = join(root, "variable-frame-rate.mp4");
  const generated = spawnSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=size=64x64:rate=10:duration=1",
    "-vf", "setpts='if(lt(N,5),N/(10*TB),(5+(N-5)*2)/(10*TB))'",
    "-fps_mode", "vfr",
    "-c:v", "mpeg4",
    "-y",
    outputPath,
  ], { encoding: "utf8", timeout: 15_000 });
  expect(generated.status, generated.stderr).toBe(0);

  const analyzed = spawnSync(pythonExecutable, [
    join(appRoot, "scripts", "analyze-face-quality.py"),
    "--video", outputPath,
    "--face-model", faceModel,
    "--max-frames", "240",
  ], { encoding: "utf8", timeout: 15_000 });
  expect(analyzed.status, analyzed.stderr).toBe(0);
  const result = JSON.parse(analyzed.stdout) as {
    technical: {
      constantFrameRate: boolean | null;
      audioVideoDurationDeltaSeconds: number | null;
    };
  };
  expect(result.technical.constantFrameRate).toBe(false);
  expect(result.technical.audioVideoDurationDeltaSeconds).toBeNull();
}, 20_000);
