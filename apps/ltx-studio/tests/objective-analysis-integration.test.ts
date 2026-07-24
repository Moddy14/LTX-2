import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { appRoot, pythonExecutable } from "../server/config.js";
import { writeOutputAnalysis } from "../server/analysisStore.js";
import type { StudioJob } from "../server/jobs.js";
import {
  buildObjectiveQualityAnalysis,
  cleanupAnalysisTempRoot,
  OutputAnalysisManager,
} from "../server/outputAnalysis.js";
import { OutputLibrary } from "../server/outputs.js";
import type { ObjectiveWorkerResult } from "../shared/objectiveQuality.js";
import { validRequest } from "./fixtures.js";

const faceModel = join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
const identityModel = join(appRoot, "models", "face_recognition_sface_2021dec.onnx");
const runtimeAvailable = existsSync(faceModel)
  && existsSync(identityModel)
  && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
  && spawnSync(pythonExecutable, ["-c", "import cv2"], { stdio: "ignore" }).status === 0;
const integrationIt = runtimeAvailable ? it : it.skip;
const roots: string[] = [];
const syntheticWorkerResult: ObjectiveWorkerResult = {
  technical: {
    durationSeconds: 1,
    fps: 24,
    frames: 24,
    hasAudio: true,
    constantFrameRate: true,
    audioVideoDurationDeltaSeconds: 0,
    audioVideoStartDeltaSeconds: 0,
  },
  face: {
    sampledFrames: 24,
    detectedFrames: 24,
    validGeometryFrames: 24,
    detectionCoverage: 1,
    geometryCoverage: 1,
    medianConfidence: 0.95,
    medianEyeSpanPixels: 80,
    medianFaceAreaRatio: 0.15,
    noseVelocityP95PerSecond: 1,
    noseAccelerationP95PerSecond2: 2,
    mouthAngleMedianDegrees: 0,
    mouthAngleVelocityP95DegreesPerSecond: 1,
    mouthSpanCoefficientOfVariation: 0.01,
  },
  identity: {
    status: "not-applicable",
    error: null,
    modelName: null,
    modelSha256: null,
    modelRevision: null,
    preprocessingVersion: null,
    embeddingDimensions: null,
    referenceCount: 0,
    sampledReferenceFrames: 0,
    embeddedReferenceFrames: 0,
    sampledOutputFrames: 0,
    matchedOutputFrames: 0,
    outputCoverage: 0,
    ambiguousOutputFrames: 0,
    referenceSelfConsistencyMedian: null,
    referenceSelfConsistencyP10: null,
    cosineMedian: null,
    cosineP10: null,
    cosineMinimum: null,
    outputTemporalConsistencyMedian: null,
  },
};

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
    identityEvidence: null,
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
    "parser.add_argument('--identity-model', required=True)",
    "parser.add_argument('--identity-status', required=True)",
    "parser.add_argument('--identity-reference', nargs=2, action='append', default=[])",
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
    analysisTempRoot: join(root, "analysis-tmp"),
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
  expect(await readdir(join(root, "analysis-tmp"))).toEqual([]);
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
    "--identity-model", identityModel,
    "--identity-status", "not-applicable",
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

integrationIt("fails closed when bound identity evidence changes while the worker is running", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-evidence-race-"));
  roots.push(root);
  const outputName = "evidence-race.mp4";
  await writeFile(join(root, outputName), "synthetic-output");
  const workerScript = join(root, "worker.py");
  await writeFile(workerScript, [
    "import time",
    "time.sleep(0.05)",
    `print(${JSON.stringify(JSON.stringify(syntheticWorkerResult))})`,
  ].join("\n"));
  const completedJob = job(outputName);
  completedJob.identityEvidence = {
    schemaVersion: "ltx-studio-identity-evidence.v1",
    status: "verified",
    source: "image-conditioning",
    capturedAt: "2026-07-24T18:00:00.000Z",
    verifiedAt: "2026-07-24T18:00:01.000Z",
    reason: null,
    references: [{
      assetId: "6d6d624b-12c3-4a97-9e4e-152a69423b6c",
      kind: "image",
      sizeBytes: 100,
      modifiedAtMs: 1,
      changedAtMs: 2,
      fileId: "123",
      sha256: "a".repeat(64),
    }],
  };
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  let verifications = 0;
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    workerScript,
    identityReferenceResolver: () => [{ path: join(root, "reference.png"), sha256: "a".repeat(64) }],
    identityEvidenceVerifier: async () => {
      verifications += 1;
      return verifications === 1 ? null : "Prüfsumme stimmt nicht mehr.";
    },
  });
  manager.start(outputName);

  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 200 && current && ["queued", "running"].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }

  expect(verifications).toBe(2);
  expect(current).toMatchObject({
    status: "failed",
    error: {
      code: "analysis-failed",
      message: expect.stringContaining("nach der Analyse verändert"),
    },
  });
}, 20_000);

integrationIt("rejects a stale analysis cancellation token without stopping the active worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-stale-cancel-"));
  roots.push(root);
  const outputName = "stale-cancel.mp4";
  await writeFile(join(root, outputName), "synthetic-output");
  const workerScript = join(root, "worker.py");
  await writeFile(workerScript, [
    "import time",
    "time.sleep(60)",
  ].join("\n"));
  const completedJob = job(outputName);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    workerScript,
    terminationGraceMs: 10,
  });
  const active = manager.start(outputName);
  for (let attempt = 0; attempt < 100 && manager.get(outputName)?.status !== "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(manager.get(outputName)?.status).toBe("running");

  expect(() => manager.cancel(
    outputName,
    "3c8a5dc6-8864-49f7-a639-85caef911111",
  )).toThrow("inzwischen ersetzt");
  expect(manager.get(outputName)?.status).not.toBe("cancelled");

  manager.cancel(outputName, active.analysisId);
  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 100 && current?.status !== "cancelled"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }
  expect(current?.status).toBe("cancelled");
}, 20_000);

integrationIt("replaces a completed pre-track v2 cache with a fresh analysis attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-cache-upgrade-"));
  roots.push(root);
  const outputName = "stale-track-cache.mp4";
  await writeFile(join(root, outputName), "synthetic-output");
  const completedJob = job(outputName);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const target = library.resolveAnalysisTarget(outputName);
  const staleWorker = structuredClone(syntheticWorkerResult);
  staleWorker.identity = {
    status: "measured",
    error: null,
    modelName: "OpenCV SFace 2021dec",
    modelSha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    modelRevision: "3d7082438a6e4551e840c9b2bb60b71e8da4b524",
    preprocessingVersion: "yunet5-aligncrop-112.v1",
    embeddingDimensions: 128,
    referenceCount: 1,
    sampledReferenceFrames: 1,
    embeddedReferenceFrames: 1,
    sampledOutputFrames: 24,
    matchedOutputFrames: 24,
    outputCoverage: 1,
    ambiguousOutputFrames: 0,
    referenceSelfConsistencyMedian: 1,
    referenceSelfConsistencyP10: 1,
    cosineMedian: 0.8,
    cosineP10: 0.75,
    cosineMinimum: 0.7,
    outputTemporalConsistencyMedian: 0.98,
  };
  const timestamp = "2026-07-24T18:30:00.000Z";
  const staleAnalysisId = "3c8a5dc6-8864-49f7-a639-85caef918888";
  writeOutputAnalysis(root, {
    schemaVersion: "ltx-studio-output-analysis.v2",
    outputName,
    sizeBytes: target.sizeBytes,
    modifiedAtMs: target.modifiedAtMs,
    changedAtMs: target.changedAtMs,
    fileId: target.fileId,
    jobId: target.jobId,
    analysisId: staleAnalysisId,
    attempt: 1,
    status: "completed",
    progress: 100,
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    updatedAt: timestamp,
    error: null,
    result: buildObjectiveQualityAnalysis(staleWorker, timestamp),
  });
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    analysisTempRoot: join(root, "analysis-tmp"),
  });

  const fresh = manager.start(outputName);

  expect(fresh.analysisId).not.toBe(staleAnalysisId);
  expect(fresh.attempt).toBe(2);
  expect(fresh.status).toBe("queued");
  manager.cancel(outputName, fresh.analysisId);
}, 20_000);

it("cleans only stale managed analysis directories during Studio startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-startup-cleanup-"));
  roots.push(root);
  await mkdir(join(root, "analysis-stale"), { recursive: true });
  await writeFile(join(root, "analysis-stale", "private-snapshot.mp4"), "data");
  await mkdir(join(root, "unrelated"), { recursive: true });

  cleanupAnalysisTempRoot(root);

  expect(await readdir(root)).toEqual(["unrelated"]);
});
