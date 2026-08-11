import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { analysisTempRoot, appRoot, pythonExecutable } from "../server/config.js";
import { capturePinnedPathRevision } from "../server/evaluatorBindings.js";
import type { PhonemeVisemeEvaluatorState } from "../server/evaluatorManifest.js";
import { writeOutputAnalysis } from "../server/analysisStore.js";
import type { StudioJob } from "../server/jobs.js";
import {
  buildObjectiveQualityAnalysis,
  cleanupAnalysisTempRoot,
  combinedEvaluatorFingerprint,
  OutputAnalysisManager,
  recoverPhonemeVisemeSandboxState,
  stopSystemdUnit,
} from "../server/outputAnalysis.js";
import type { DialogueEvaluatorState } from "../server/dialogueEvaluator.js";
import { OutputLibrary } from "../server/outputs.js";
import {
  faceTrackingMetricsSchema,
  type ObjectiveWorkerResult,
} from "../shared/objectiveQuality.js";
import { unavailablePhonemeVisemeResult } from "../shared/phonemeVisemeEvaluator.js";
import { notApplicableDialogueEvaluation } from "../shared/dialogueEvaluator.js";
import { validRequest } from "./fixtures.js";

const faceModel = join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
const identityModel = join(appRoot, "models", "face_recognition_sface_2021dec.onnx");
const runtimeAvailable = existsSync(faceModel)
  && existsSync(identityModel)
  && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0
  && spawnSync(pythonExecutable, ["-c", "import cv2"], { stdio: "ignore" }).status === 0;
const integrationIt = runtimeAvailable ? it : it.skip;
const systemSandboxIt = spawnSync(
  "/usr/bin/sudo",
  ["-n", "/usr/bin/systemctl", "--version"],
  { stdio: "ignore" },
).status === 0 ? it : it.skip;
const roots: string[] = [];
const dialogueEvaluatorState: DialogueEvaluatorState = {
  status: "ready",
  blockerCode: "none",
  fingerprint: "dialogue-evaluator-test.v1",
  modelPath: "/tmp/whisper-small-test.pt",
  modelSha256: "9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794",
  packageVersion: "test",
  runnerSha256: "a".repeat(64),
  runtimeFingerprint: "b".repeat(64),
  error: null,
};
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
    mouthSkinPairCount: 23,
    mouthSkinPairCoverage: 1,
    mouthSkinWarpResidualMedian: 0.01,
    mouthSkinWarpResidualP95: 0.02,
    mouthSkinLuminanceDeltaP95: 0.01,
    mouthSkinFlowDeformationP95: 0.03,
    mouthSkinValidPixelCoverageP10: 0.9,
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
  avSync: {
    status: "insufficient",
    error: "Synthetic worker has no correlated mouth signal.",
    method: "classical-audio-mouth-motion.v1",
    sampledVideoFrames: 24,
    validMotionPairs: 0,
    motionCoverage: 0,
    audioWindowCount: 98,
    audioActivityRatio: 1,
    usableAudioActivitySeconds: 0,
    mouthCoverageDuringAudioActivity: 0,
    usableWindowCount: 0,
    estimatedAudioLeadMilliseconds: null,
    lagSearchLimitMilliseconds: 500,
    lagResolutionMilliseconds: null,
    effectiveVideoSampleMilliseconds: null,
    correlationPeak: null,
    zeroLagCorrelation: null,
    peakProminence: null,
    peakWidthMilliseconds: null,
    featureLagAgreementMilliseconds: null,
    windowLagIqrMilliseconds: null,
    nullP95Correlation: null,
  },
  conditioningAvSync: null,
  dialogue: notApplicableDialogueEvaluation(),
  phonemeViseme: unavailablePhonemeVisemeResult(),
};
const syntheticBaseWorkerResult = {
  technical: syntheticWorkerResult.technical,
  face: syntheticWorkerResult.face,
  identity: syntheticWorkerResult.identity,
  avSync: syntheticWorkerResult.avSync,
  conditioningAvSync: syntheticWorkerResult.conditioningAvSync,
  dialogue: syntheticWorkerResult.dialogue,
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
    experiment: null,
    project: null,
    runtimeMs: 1_000,
    cancelledBy: null,
    dgxJobId: null,
    thermalProfile: null,
    identityEvidence: null,
    runProvenance: null,
  };
}

async function writePythonScript(path: string, lines: string[]): Promise<string> {
  const source = lines.join("\n");
  await writeFile(path, source);
  return createHash("sha256").update(source).digest("hex");
}

async function writePhonemeVisemeResultRunner(
  path: string,
  result: Record<string, unknown>,
): Promise<string> {
  return writePythonScript(path, [
    "import hashlib,json,pathlib",
    `result=json.loads(${JSON.stringify(JSON.stringify(result))})`,
    "if result.get('measurement') is not None:",
    "    result['measurement']['runnerFingerprint']=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()",
    "print(json.dumps(result))",
    "",
  ]);
}

function evaluatorStateForRunner(
  root: string,
  runnerPath: string,
  runnerSha256: string,
  readOnlyPaths = [runnerPath],
): PhonemeVisemeEvaluatorState {
  const pythonRuntimeRoot = dirname(dirname(pythonExecutable));
  return {
    fingerprint: `manifest-v2-runner-fixture:${runnerSha256}`,
    result: {
      ...unavailablePhonemeVisemeResult("Measurement only.", "product-go-pending"),
      manifestReleaseId: "pv-runner-fixture",
      manifestSha256: "a".repeat(64),
      preprocessingVersion: "mfa-mediapipe-de-pts.v1",
      visemeMapVersion: "viseme15-en-de.v1",
    },
    execution: {
      method: "mfa-mediapipe-de.v1",
      sandbox: "systemd-system-sandbox.v1",
      artifactRoot: root,
      readOnlyPaths,
      manifestPath: join(root, "manifest.json"),
      manifestSha256: "a".repeat(64),
      legalApprovalSha256: "c".repeat(64),
      runnerPath,
      runnerSha256,
      pythonExecutable,
      pythonRuntimeRoot,
      boundPathRevisions: [
        ...readOnlyPaths.map((path) => capturePinnedPathRevision(path, "file")),
        capturePinnedPathRevision(pythonRuntimeRoot, "directory"),
      ],
      mfaExecutablePath: join(root, "mfa"),
      acousticModelPath: join(root, "acoustic.zip"),
      dictionaryPath: join(root, "dictionary.dict"),
      g2pModelPath: null,
      faceLandmarkerPath: join(root, "face.task"),
      visemeMappingPath: join(root, "viseme.json"),
      runtime: {
        pythonVersion: "3.12.3",
        mfaVersion: "3.3.9",
        mediaPipeVersion: "0.10.31",
        openCvVersion: "4.13.0",
        numpyVersion: "2.4.2",
        ffmpegVersion: "7.1.1",
        ffmpegSha256: "1".repeat(64),
        ffprobeSha256: "2".repeat(64),
      },
    },
  };
}

function measuredIdentity(
  preprocessingVersion: "yunet5-aligncrop-112.v1" | "yunet5-aligncrop-112-track.v2",
): ObjectiveWorkerResult["identity"] {
  return {
    status: "measured",
    error: null,
    modelName: "OpenCV SFace 2021dec",
    modelSha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    modelRevision: "3d7082438a6e4551e840c9b2bb60b71e8da4b524",
    preprocessingVersion,
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
}

function legacyFace(face: ObjectiveWorkerResult["face"]) {
  return faceTrackingMetricsSchema.strip().parse(face);
}

function v3Analysis(worker: ObjectiveWorkerResult, createdAt: string) {
  return {
    schemaVersion: "ltx-studio-objective-quality.v3" as const,
    analyzerVersion: "ffprobe-yunet5-sface-avmotion.v3" as const,
    createdAt,
    status: "insufficient" as const,
    technical: worker.technical,
    face: legacyFace(worker.face),
    identity: worker.identity,
    avSync: worker.avSync,
    capabilities: {
      avSync: "classical-av-insufficient" as const,
      identity: worker.identity.status === "measured"
        ? "sface-raw-measured" as const
        : "not-applicable" as const,
      dialogue: "whisper-not-run" as const,
    },
    findings: [],
    limitations: ["Pre-phoneme/viseme cache."],
  };
}

function v6Analysis(worker: ObjectiveWorkerResult, createdAt: string) {
  const current = buildObjectiveQualityAnalysis(worker, createdAt);
  return {
    ...current,
    schemaVersion: "ltx-studio-objective-quality.v6" as const,
    analyzerVersion: "ffprobe-yunet5-sface-dual-avmotion-whisper-pv.v6" as const,
    face: legacyFace(current.face),
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

it("executes and persists a measurement-only phoneme/viseme result without granting quality GO", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-pv-runner-"));
  roots.push(root);
  const outputName = "measurement-only.mp4";
  await writeFile(join(root, outputName), "synthetic video fixture");
  const completedJob = job(outputName);
  completedJob.request.promptParts.dialogue = "Hallo Welt.";
  const expectedDialogue = completedJob.request.promptParts.dialogue;
  const expectedDialogueHash = createHash("sha256").update(expectedDialogue, "utf8").digest("hex");
  const baseWorkerScript = join(root, "base-worker.py");
  const pvRunnerScript = join(root, "pv-runner.py");
  await writeFile(baseWorkerScript, [
    "import json",
    `print(${JSON.stringify(JSON.stringify(syntheticBaseWorkerResult))})`,
    "",
  ].join("\n"));
  const runnerMeasurementResult = {
    schemaVersion: "ltx-studio-mfa-mediapipe-runner.v1",
    status: "measurement-only",
    error: "MFA/MediaPipe raw evidence only; independent Product-GO remains blocked.",
    manifestReleaseId: "pv-measurement-test",
    manifestSha256: "a".repeat(64),
    preprocessingVersion: "mfa-mediapipe-de-pts.v1",
    visemeMapVersion: "viseme15-en-de.v1",
    offset: {
      status: "measured",
      estimatedOffsetMilliseconds: 42,
      confidence: 0.8,
    },
    measurement: {
      method: "mfa-mediapipe-de.v1",
      runnerFingerprint: "b".repeat(64),
      expectedDialogueSha256: expectedDialogueHash,
      globalAvLagMilliseconds: 42,
      lagConfidence: 0.8,
      bilabialClosureF1: 0.75,
      openingCorrelation: 0.7,
      roundingCorrelation: 0.6,
      speechMotionRecall: 0.9,
      pauseLeakRatio: 0.1,
      phoneCoverage: 1,
      unknownPhones: [],
      faceTrackCoverage: 1,
      mouthTrackCoverage: 1,
      multiFaceFrameRatio: 0,
      medianBlurVariance: 100,
      yawP95Degrees: 5,
      pitchP95Degrees: 4,
      usableDurationSeconds: 4,
      sampledFrames: 96,
    },
  };
  const initialRunnerSha = await writePhonemeVisemeResultRunner(
    pvRunnerScript,
    runnerMeasurementResult,
  );
  runnerMeasurementResult.measurement.runnerFingerprint = initialRunnerSha;
  const evaluatorState: PhonemeVisemeEvaluatorState = {
    fingerprint: "manifest-v2-measurement-ready:test",
    result: {
      ...unavailablePhonemeVisemeResult(
        "Measurement runner is ready; Product-GO remains blocked.",
        "product-go-pending",
      ),
      manifestReleaseId: "pv-measurement-test",
      manifestSha256: "a".repeat(64),
      preprocessingVersion: "mfa-mediapipe-de-pts.v1",
      visemeMapVersion: "viseme15-en-de.v1",
    },
    execution: evaluatorStateForRunner(root, pvRunnerScript, initialRunnerSha).execution!,
  };
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    workerScript: baseWorkerScript,
    pythonExecutable,
    phonemeVisemeSystemdSandbox: false,
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
  });

  manager.start(outputName);
  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 200
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    result: {
      status: "insufficient",
      capabilities: {
        phonemeViseme: "measurement-only",
      },
      phonemeViseme: {
        status: "measurement-only",
        blockerCode: "product-go-pending",
        productGo: { status: "blocked" },
        offset: {
          status: "measured",
          gatePassed: false,
          estimatedOffsetMilliseconds: 42,
          confidence: 0.8,
        },
        content: {
          status: "insufficient",
          gatePassed: false,
          frameMacroF1: null,
          transitionF1: null,
        },
        measurement: runnerMeasurementResult.measurement,
      },
    },
  });
  expect(current?.result?.findings).toContainEqual(expect.objectContaining({
    code: "phoneme-viseme-measurement-only",
  }));

  const unboundMeasurementResult = {
    ...runnerMeasurementResult,
    measurement: {
      ...runnerMeasurementResult.measurement,
      expectedDialogueSha256: "d".repeat(64),
    },
  };
  if (!evaluatorState.execution) throw new Error("Test-Evaluator muss ausführbar sein.");
  evaluatorState.execution.runnerSha256 = await writePhonemeVisemeResultRunner(
    pvRunnerScript,
    unboundMeasurementResult,
  );
  evaluatorState.execution.boundPathRevisions = [
    capturePinnedPathRevision(pvRunnerScript, "file"),
    capturePinnedPathRevision(evaluatorState.execution.pythonRuntimeRoot!, "directory"),
  ];
  manager.start(outputName, true);
  current = manager.get(outputName);
  for (let attempt = 0; attempt < 200
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    result: {
      status: "insufficient",
      phonemeViseme: {
        status: "failed",
        blockerCode: "evaluator-failed",
        error: "Phonem-/Visem-Runner lieferte ungebundene Runner- oder Dialogevidenz.",
      },
    },
  });

  const inconsistentOffsetResult = {
    ...runnerMeasurementResult,
    offset: {
      ...runnerMeasurementResult.offset,
      estimatedOffsetMilliseconds: 84,
    },
  };
  evaluatorState.execution.runnerSha256 = await writePhonemeVisemeResultRunner(
    pvRunnerScript,
    inconsistentOffsetResult,
  );
  evaluatorState.execution.boundPathRevisions = [
    capturePinnedPathRevision(pvRunnerScript, "file"),
    capturePinnedPathRevision(evaluatorState.execution.pythonRuntimeRoot!, "directory"),
  ];
  manager.start(outputName, true);
  current = manager.get(outputName);
  for (let attempt = 0; attempt < 200
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    result: {
      status: "insufficient",
      phonemeViseme: {
        status: "failed",
        blockerCode: "evaluator-failed",
        error: expect.stringContaining("Phonem-/Visem-Runner lieferte ungültige Messdaten"),
      },
    },
  });

  const forgedProductGo = {
    ...runnerMeasurementResult,
    status: "measured",
    productGo: { status: "passed", reason: "forged" },
    gateVersion: "ltx-pv-release-gates.v1",
    content: {
      status: "measured",
      gatePassed: true,
      frameMacroF1: 1,
      transitionF1: 1,
    },
  };
  evaluatorState.execution.runnerSha256 = await writePhonemeVisemeResultRunner(
    pvRunnerScript,
    forgedProductGo,
  );
  evaluatorState.execution.boundPathRevisions = [
    capturePinnedPathRevision(pvRunnerScript, "file"),
    capturePinnedPathRevision(evaluatorState.execution.pythonRuntimeRoot!, "directory"),
  ];
  manager.start(outputName, true);
  current = manager.get(outputName);
  for (let attempt = 0; attempt < 200
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    result: {
      status: "insufficient",
      phonemeViseme: {
        status: "failed",
        blockerCode: "evaluator-failed",
      },
    },
  });
  if (current?.result?.schemaVersion !== "ltx-studio-objective-quality.v7") {
    throw new Error("Aktuelles objektives Analyseschema erwartet.");
  }
  expect(current.result.phonemeViseme.error).toContain(
    "Phonem-/Visem-Runner lieferte ungültige Messdaten",
  );
});

systemSandboxIt("stops the complete transient measurement unit before cleaning an oversized runner", async () => {
  await mkdir(analysisTempRoot, { recursive: true });
  const root = await mkdtemp(join(analysisTempRoot, "systemd-test-"));
  roots.push(root);
  const outputName = "sandbox-oversized.mp4";
  const outputPath = join(root, outputName);
  const baseWorkerScript = join(root, "base-worker.py");
  const pvRunnerScript = join(root, "pv-runner.py");
  await writeFile(outputPath, "synthetic video fixture");
  await writeFile(baseWorkerScript, [
    "import json",
    `print(${JSON.stringify(JSON.stringify(syntheticBaseWorkerResult))})`,
    "",
  ].join("\n"));
  const pvRunnerSha = await writePythonScript(pvRunnerScript, [
    "import os",
    "chunk=b'x' * 65536",
    "while True:",
    "    os.write(1,chunk)",
    "",
  ]);
  const completedJob = job(outputName);
  completedJob.request.promptParts.dialogue = "Hallo Welt.";
  const evaluatorState: PhonemeVisemeEvaluatorState = {
    fingerprint: "manifest-v2-system-sandbox-test",
    result: {
      ...unavailablePhonemeVisemeResult(
        "Measurement runner is ready; Product-GO remains blocked.",
        "product-go-pending",
      ),
      manifestReleaseId: "pv-system-sandbox-test",
      manifestSha256: "a".repeat(64),
      preprocessingVersion: "mfa-mediapipe-de-pts.v1",
      visemeMapVersion: "viseme15-en-de.v1",
    },
    execution: evaluatorStateForRunner(root, pvRunnerScript, pvRunnerSha).execution!,
  };
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    analysisTempRoot: join(root, "analysis-temp"),
    workerScript: baseWorkerScript,
    pythonExecutable,
    phonemeVisemeRuntimeVerifier: () => undefined,
    phonemeVisemeTrustVerifier: () => undefined,
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
  });

  const started = manager.start(outputName);
  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 400
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    result: {
      phonemeViseme: {
        status: "failed",
        blockerCode: "evaluator-failed",
        error: "Phonem-/Visem-Ausgabe überschritt das Größenlimit.",
      },
    },
  });
  expect(spawnSync(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/systemctl", "is-active", "--quiet", `ltx-pv-${started.analysisId}`],
    { stdio: "ignore" },
  ).status).not.toBe(0);
  expect(await readdir(join(root, "analysis-temp"))).toEqual([]);
}, 20_000);

systemSandboxIt("stops a timed-out transient measurement unit through the PV timer", async () => {
  await mkdir(analysisTempRoot, { recursive: true });
  const root = await mkdtemp(join(analysisTempRoot, "systemd-timeout-"));
  roots.push(root);
  const outputName = "sandbox-timeout.mp4";
  const baseWorkerScript = join(root, "base-worker.py");
  const pvRunnerScript = join(root, "pv-runner.py");
  await writeFile(join(root, outputName), "synthetic video fixture");
  await writeFile(baseWorkerScript, [
    "import json",
    `print(${JSON.stringify(JSON.stringify(syntheticBaseWorkerResult))})`,
    "",
  ].join("\n"));
  const runnerSha = await writePythonScript(pvRunnerScript, [
    "import time",
    "time.sleep(30)",
    "",
  ]);
  const completedJob = job(outputName);
  completedJob.request.promptParts.dialogue = "Hallo Welt.";
  const evaluatorState = evaluatorStateForRunner(root, pvRunnerScript, runnerSha);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    analysisTempRoot: join(root, "analysis-temp"),
    workerScript: baseWorkerScript,
    pythonExecutable,
    phonemeVisemeTimeoutMs: 100,
    terminationGraceMs: 20,
    phonemeVisemeRuntimeVerifier: () => undefined,
    phonemeVisemeTrustVerifier: () => undefined,
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
  });

  const started = manager.start(outputName);
  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 400
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    result: {
      phonemeViseme: {
        status: "failed",
        error: expect.stringContaining("überschritt 1 Sekunden"),
      },
    },
  });
  expect(spawnSync(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/systemctl", "is-active", "--quiet", `ltx-pv-${started.analysisId}`],
    { stdio: "ignore" },
  ).status).not.toBe(0);
  expect(await readdir(join(root, "analysis-temp"))).toEqual([]);
}, 20_000);

integrationIt("terminates an unsandboxed measurement runner at its own timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-pv-unsandboxed-timeout-"));
  roots.push(root);
  const outputName = "unsandboxed-timeout.mp4";
  const baseWorkerScript = join(root, "base-worker.py");
  const pvRunnerScript = join(root, "pv-runner.py");
  await writeFile(join(root, outputName), "synthetic video fixture");
  await writeFile(baseWorkerScript, [
    "import json",
    `print(${JSON.stringify(JSON.stringify(syntheticBaseWorkerResult))})`,
    "",
  ].join("\n"));
  const runnerSha = await writePythonScript(pvRunnerScript, [
    "import time",
    "time.sleep(30)",
    "",
  ]);
  const completedJob = job(outputName);
  completedJob.request.promptParts.dialogue = "Hallo Welt.";
  const evaluatorState = evaluatorStateForRunner(root, pvRunnerScript, runnerSha);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    workerScript: baseWorkerScript,
    pythonExecutable,
    phonemeVisemeSystemdSandbox: false,
    phonemeVisemeTimeoutMs: 100,
    terminationGraceMs: 20,
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
  });

  manager.start(outputName);
  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 400
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    result: {
      phonemeViseme: {
        status: "failed",
        error: expect.stringContaining("überschritt 1 Sekunden"),
      },
    },
  });
}, 20_000);

integrationIt("kills an unsandboxed runner child that survives its parent on timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-pv-unsandboxed-child-timeout-"));
  roots.push(root);
  const outputName = "unsandboxed-child-timeout.mp4";
  const baseWorkerScript = join(root, "base-worker.py");
  const pvRunnerScript = join(root, "pv-runner.py");
  const childPidPath = join(root, "child.pid");
  const childReadyPath = join(root, "child.ready");
  await writeFile(join(root, outputName), "synthetic video fixture");
  await writeFile(baseWorkerScript, [
    "import json",
    `print(${JSON.stringify(JSON.stringify(syntheticBaseWorkerResult))})`,
    "",
  ].join("\n"));
  const runnerSha = await writePythonScript(pvRunnerScript, [
    "import pathlib",
    "import subprocess",
    "import sys",
    "import time",
    `pid_path = pathlib.Path(${JSON.stringify(childPidPath)})`,
    `ready_path = pathlib.Path(${JSON.stringify(childReadyPath)})`,
    "child = subprocess.Popen([",
    "    sys.executable,",
    "    '-c',",
    `    ${JSON.stringify([
      "import pathlib",
      "import signal",
      "import time",
      "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      `pathlib.Path(${JSON.stringify(childReadyPath)}).write_text('ready')`,
      "time.sleep(30)",
    ].join("; "))},`,
    "], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)",
    "pid_path.write_text(str(child.pid))",
    "for _ in range(200):",
    "    if ready_path.exists():",
    "        break",
    "    time.sleep(0.01)",
    "time.sleep(30)",
    "",
  ]);
  const completedJob = job(outputName);
  completedJob.request.promptParts.dialogue = "Hallo Welt.";
  const evaluatorState = evaluatorStateForRunner(root, pvRunnerScript, runnerSha);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    workerScript: baseWorkerScript,
    pythonExecutable,
    phonemeVisemeSystemdSandbox: false,
    phonemeVisemeTimeoutMs: 200,
    terminationGraceMs: 50,
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
  });

  manager.start(outputName);
  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 400
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    result: {
      phonemeViseme: {
        status: "failed",
        error: expect.stringContaining("überschritt 1 Sekunden"),
      },
    },
  });
  const childPid = Number.parseInt(await readFile(childPidPath, "utf8"), 10);
  expect(() => process.kill(childPid, 0)).toThrow();
}, 20_000);

integrationIt("fails a result when a bound artifact is changed and restored in-place", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-pv-toctou-"));
  roots.push(root);
  const outputName = "toctou.mp4";
  const baseWorkerScript = join(root, "base-worker.py");
  const pvRunnerScript = join(root, "pv-runner.py");
  const boundArtifact = join(root, "bound.model");
  await writeFile(join(root, outputName), "synthetic video fixture");
  await writeFile(boundArtifact, "original");
  await writeFile(baseWorkerScript, [
    "import json",
    `print(${JSON.stringify(JSON.stringify(syntheticBaseWorkerResult))})`,
    "",
  ].join("\n"));
  const runnerResult = {
    schemaVersion: "ltx-studio-mfa-mediapipe-runner.v1",
    status: "failed",
    error: "synthetic runner result",
    manifestReleaseId: "pv-runner-fixture",
    manifestSha256: "a".repeat(64),
    preprocessingVersion: "mfa-mediapipe-de-pts.v1",
    visemeMapVersion: "viseme15-en-de.v1",
    offset: {
      status: "not-run",
      estimatedOffsetMilliseconds: null,
      confidence: null,
    },
    measurement: null,
  };
  const runnerSha = await writePythonScript(pvRunnerScript, [
    "import json,pathlib",
    `path=pathlib.Path(${JSON.stringify(boundArtifact)})`,
    "original=path.read_bytes()",
    "path.write_bytes(b'changed!')",
    "path.write_bytes(original)",
    `print(${JSON.stringify(JSON.stringify(runnerResult))})`,
    "",
  ]);
  const completedJob = job(outputName);
  completedJob.request.promptParts.dialogue = "Hallo Welt.";
  const evaluatorState = evaluatorStateForRunner(
    root,
    pvRunnerScript,
    runnerSha,
    [pvRunnerScript, boundArtifact],
  );
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    workerScript: baseWorkerScript,
    pythonExecutable,
    phonemeVisemeSystemdSandbox: false,
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
  });

  manager.start(outputName);
  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 200
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }

  expect(current).toMatchObject({
    status: "completed",
    result: {
      phonemeViseme: {
        status: "failed",
        error: expect.stringContaining("Gebundene Phonem-/Visem-Evidenz wurde verändert"),
      },
    },
  });
  expect(await readFile(boundArtifact, "utf8")).toBe("original");
}, 20_000);

systemSandboxIt("stops an active measurement unit during manager shutdown", async () => {
  await mkdir(analysisTempRoot, { recursive: true });
  const root = await mkdtemp(join(analysisTempRoot, "systemd-shutdown-"));
  roots.push(root);
  const outputName = "sandbox-shutdown.mp4";
  const baseWorkerScript = join(root, "base-worker.py");
  const pvRunnerScript = join(root, "pv-runner.py");
  await writeFile(join(root, outputName), "synthetic video fixture");
  await writeFile(baseWorkerScript, [
    "import json",
    `print(${JSON.stringify(JSON.stringify(syntheticBaseWorkerResult))})`,
    "",
  ].join("\n"));
  const runnerSha = await writePythonScript(pvRunnerScript, [
    "import time",
    "time.sleep(30)",
    "",
  ]);
  const completedJob = job(outputName);
  completedJob.request.promptParts.dialogue = "Hallo Welt.";
  const evaluatorState = evaluatorStateForRunner(root, pvRunnerScript, runnerSha);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    analysisTempRoot: join(root, "analysis-temp"),
    workerScript: baseWorkerScript,
    pythonExecutable,
    phonemeVisemeRuntimeVerifier: () => undefined,
    phonemeVisemeTrustVerifier: () => undefined,
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
  });

  const started = manager.start(outputName);
  const unit = `ltx-pv-${started.analysisId}`;
  let unitActive = false;
  for (let attempt = 0; attempt < 200 && !unitActive; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    unitActive = spawnSync(
      "/usr/bin/sudo",
      ["-n", "/usr/bin/systemctl", "is-active", "--quiet", unit],
      { stdio: "ignore" },
    ).status === 0;
  }
  expect(unitActive).toBe(true);

  await manager.shutdown();

  expect(manager.get(outputName)?.status).toBe("cancelled");
  expect(spawnSync(
    "/usr/bin/sudo",
    ["-n", "/usr/bin/systemctl", "is-active", "--quiet", unit],
    { stdio: "ignore" },
  ).status).not.toBe(0);
}, 20_000);

it("bounds shutdown even when a sandbox stop never settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-shutdown-deadline-"));
  roots.push(root);
  const library = new OutputLibrary(root);
  const manager = new OutputAnalysisManager(library, () => [], root);
  const stops = Reflect.get(manager, "phonemeVisemeUnitStops") as Map<string, Promise<void>>;
  stops.set("synthetic-hung-unit", new Promise<void>(() => undefined));
  const startedAt = Date.now();

  await expect(manager.shutdown(25)).rejects.toThrow("Shutdown-Zeitlimit");

  expect(Date.now() - startedAt).toBeLessThan(500);
});

integrationIt("retries recovery without launching a measurement unit after cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-pv-cancel-"));
  roots.push(root);
  const outputName = "pv-cancel.mp4";
  const baseWorkerScript = join(root, "base-worker.py");
  const pvRunnerScript = join(root, "pv-runner.py");
  const runnerMarker = join(root, "runner-started");
  await writeFile(join(root, outputName), "synthetic video fixture");
  await writeFile(baseWorkerScript, [
    "import json",
    `print(${JSON.stringify(JSON.stringify(syntheticBaseWorkerResult))})`,
    "",
  ].join("\n"));
  await writeFile(pvRunnerScript, [
    "import pathlib",
    `pathlib.Path(${JSON.stringify(runnerMarker)}).write_text('started')`,
    "",
  ].join("\n"));
  const completedJob = job(outputName);
  completedJob.request.promptParts.dialogue = "Hallo Welt.";
  const evaluatorState: PhonemeVisemeEvaluatorState = {
    fingerprint: "manifest-v2-cancel-race-test",
    result: {
      ...unavailablePhonemeVisemeResult("Measurement only.", "product-go-pending"),
      manifestReleaseId: "pv-cancel-race-test",
      manifestSha256: "a".repeat(64),
      preprocessingVersion: "mfa-mediapipe-de-pts.v1",
      visemeMapVersion: "viseme15-en-de.v1",
    },
    execution: evaluatorStateForRunner(
      root,
      pvRunnerScript,
      createHash("sha256").update(await readFile(pvRunnerScript)).digest("hex"),
    ).execution!,
  };
  let releaseRecovery = () => {};
  let recoveryStarted = false;
  let recoveryCalls = 0;
  const recovery = new Promise<void>((resolve) => {
    releaseRecovery = resolve;
  });
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    analysisTempRoot: join(root, "analysis-temp"),
    workerScript: baseWorkerScript,
    pythonExecutable,
    phonemeVisemeRuntimeVerifier: () => undefined,
    phonemeVisemeTrustVerifier: () => undefined,
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
    phonemeVisemeUnitRecovery: () => {
      recoveryCalls += 1;
      if (recoveryCalls === 1) {
        return Promise.reject(new Error("synthetic transient recovery failure"));
      }
      recoveryStarted = true;
      return recovery;
    },
  });

  manager.start(outputName);
  let current = manager.get(outputName);
  for (let attempt = 0; attempt < 200
    && current
    && ["queued", "running"].includes(current.status);
  attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    current = manager.get(outputName);
  }
  expect(current).toMatchObject({
    status: "failed",
    error: { message: expect.stringContaining("transient recovery failure") },
  });

  const started = manager.start(outputName, true);
  for (let attempt = 0; attempt < 200 && !recoveryStarted; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(recoveryStarted).toBe(true);
  expect(recoveryCalls).toBe(2);
  manager.cancel(outputName, started.analysisId);
  releaseRecovery();
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(manager.get(outputName)?.status).toBe("cancelled");
  expect(existsSync(runnerMarker)).toBe(false);
  expect(await readdir(join(root, "analysis-temp"))).toEqual([]);
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
    "parser.add_argument('--expected-dialogue', required=True)",
    "parser.add_argument('--whisper-model', nargs=2, required=True)",
    "parser.add_argument('--dialogue-evaluator-state', required=True)",
    "parser.add_argument('--dialogue-evaluator-blocker', required=True)",
    "parser.add_argument('--dialogue-evaluator-error')",
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
    "--expected-dialogue", "",
    "--whisper-model", join(root, "missing-small.pt"), "0".repeat(64),
    "--dialogue-evaluator-state", "not-available",
    "--dialogue-evaluator-blocker", "runtime-unavailable",
    "--dialogue-evaluator-error", "test",
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

integrationIt("distinguishes stable mouth skin from synthetic local texture wobble", () => {
  const code = [
    "import importlib.util, json, pathlib, cv2, numpy as np",
    `script = pathlib.Path(${JSON.stringify(join(appRoot, "scripts", "analyze-face-quality.py"))})`,
    "spec = importlib.util.spec_from_file_location('ltx_objective_worker', script)",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "y, x = np.mgrid[0:96, 0:96].astype(np.float32)",
    "base = np.clip(45 + x * 1.3 + y * 0.7 + 18 * np.sin(x / 5) + 12 * np.cos(y / 7), 0, 255).astype(np.uint8)",
    "stable = [{'sampleIndex': i, 'timestamp': i / 24, 'stabilized_patch': base.copy()} for i in range(12)]",
    "rng = np.random.default_rng(20260725)",
    "wobbly = []",
    "for i in range(12):",
    "    patch = base.copy()",
    "    noise = rng.integers(-70, 71, size=(38, 72), dtype=np.int16)",
    "    patch[42:80, 12:84] = np.clip(patch[42:80, 12:84].astype(np.int16) + noise, 0, 255).astype(np.uint8)",
    "    wobbly.append({'sampleIndex': i, 'timestamp': i / 24, 'stabilized_patch': patch})",
    "bright = [{'sampleIndex': i, 'timestamp': i / 24, 'stabilized_patch': np.clip(base.astype(np.int16) + i * 5, 0, 255).astype(np.uint8)} for i in range(12)]",
    "translated = [{'sampleIndex': i, 'timestamp': i / 24, 'stabilized_patch': cv2.warpAffine(base, np.float32([[1, 0, i * 0.35], [0, 1, 0]]), (96, 96), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)} for i in range(12)]",
    "deformed = [{'sampleIndex': i, 'timestamp': i / 24, 'stabilized_patch': cv2.remap(base, x + 2.5 * np.sin(y / 7 + i * 0.45), y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)} for i in range(12)]",
    "rotated = [{'sampleIndex': i, 'timestamp': i / 24, 'stabilized_patch': cv2.warpAffine(base, cv2.getRotationMatrix2D((48, 48), i * 0.15, 1), (96, 96), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101)} for i in range(12)]",
    "sparse = [{'sampleIndex': i * 2, 'timestamp': i / 24, 'stabilized_patch': base.copy()} for i in range(6)]",
    "temporal = [{'sampleIndex': i, 'timestamp': i / 24, 'stabilized_patch': base.copy()} for i in range(50)]",
    "temporal[25]['stabilized_patch'] = rng.integers(0, 256, size=(96, 96), dtype=np.uint8)",
    "original_flow = cv2.calcOpticalFlowFarneback",
    "flow_calls = [0]",
    "def sparse_consistency_flow(_left, _right, *_args, **_kwargs):",
    "    flow_calls[0] += 1",
    "    flow = np.zeros((96, 96, 2), dtype=np.float32)",
    "    if flow_calls[0] % 2 == 0:",
    "        flow[..., 0] = 10",
    "        flow[40:86, 28:68, 0] = 0",
    "    return flow",
    "cv2.calcOpticalFlowFarneback = sparse_consistency_flow",
    "pixel_sparse = module.mouth_skin_stability(stable, 12)",
    "neighbor_calls = [0]",
    "def invalid_neighbor_flow(_left, _right, *_args, **_kwargs):",
    "    neighbor_calls[0] += 1",
    "    flow = np.zeros((96, 96, 2), dtype=np.float32)",
    "    if neighbor_calls[0] % 2 == 1:",
    "        flow[:, ::12, 0] = 5",
    "    return flow",
    "cv2.calcOpticalFlowFarneback = invalid_neighbor_flow",
    "neighbor_contaminated = module.mouth_skin_stability(stable, 12)",
    "cv2.calcOpticalFlowFarneback = original_flow",
    "print(json.dumps({'stable': module.mouth_skin_stability(stable, 12), 'wobbly': module.mouth_skin_stability(wobbly, 12), 'bright': module.mouth_skin_stability(bright, 12), 'translated': module.mouth_skin_stability(translated, 12), 'deformed': module.mouth_skin_stability(deformed, 12), 'rotated': module.mouth_skin_stability(rotated, 12), 'sparse': module.mouth_skin_stability(sparse, 12), 'pixelSparse': pixel_sparse, 'neighborContaminated': neighbor_contaminated, 'temporal': module.mouth_skin_stability(temporal, 50)}))",
  ].join("\n");
  const inspected = spawnSync(pythonExecutable, ["-c", code], {
    cwd: join(appRoot, "scripts"),
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(inspected.status, inspected.stderr).toBe(0);
  const result = JSON.parse(inspected.stdout) as {
    stable: { mouthSkinPairCoverage: number; mouthSkinWarpResidualP95: number; mouthSkinFlowDeformationP95: number };
    wobbly: { mouthSkinWarpResidualP95: number };
    bright: { mouthSkinLuminanceDeltaP95: number };
    translated: { mouthSkinWarpResidualP95: number; mouthSkinFlowDeformationP95: number };
    deformed: { mouthSkinFlowDeformationP95: number };
    rotated: { mouthSkinFlowDeformationP95: number };
    sparse: { mouthSkinPairCount: number; mouthSkinPairCoverage: number; mouthSkinWarpResidualP95: null };
    pixelSparse: { mouthSkinPairCoverage: number; mouthSkinValidPixelCoverageP10: number };
    neighborContaminated: { mouthSkinFlowDeformationP95: number; mouthSkinValidPixelCoverageP10: number };
    temporal: { mouthSkinWarpResidualP95: number };
  };

  expect(result.stable.mouthSkinPairCoverage).toBe(1);
  expect(result.stable.mouthSkinWarpResidualP95).toBeLessThan(0.001);
  expect(result.wobbly.mouthSkinWarpResidualP95).toBeGreaterThan(0.08);
  expect(result.bright.mouthSkinLuminanceDeltaP95).toBeGreaterThan(0.015);
  expect(result.translated.mouthSkinWarpResidualP95).toBeLessThan(0.02);
  expect(result.deformed.mouthSkinFlowDeformationP95).toBeGreaterThan(result.translated.mouthSkinFlowDeformationP95 * 2);
  expect(result.rotated.mouthSkinFlowDeformationP95).toBeLessThan(result.translated.mouthSkinFlowDeformationP95);
  expect(result.pixelSparse.mouthSkinPairCoverage).toBe(1);
  expect(result.pixelSparse.mouthSkinValidPixelCoverageP10).toBeLessThan(0.6);
  expect(result.neighborContaminated.mouthSkinValidPixelCoverageP10).toBeGreaterThan(0.6);
  expect(result.neighborContaminated.mouthSkinFlowDeformationP95).toBeLessThan(0.001);
  expect(result.temporal.mouthSkinWarpResidualP95).toBeLessThan(0.001);
  expect(result.sparse).toMatchObject({
    mouthSkinPairCount: 0,
    mouthSkinPairCoverage: 0,
    mouthSkinWarpResidualP95: null,
  });
});

integrationIt("preserves the signed audio stream PTS offset in the AV lag timebase", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-pts-offset-"));
  roots.push(root);
  const outputPath = join(root, "audio-offset.mp4");
  const generated = spawnSync("ffmpeg", [
    "-v", "error",
    "-f", "lavfi", "-i", "color=c=black:s=64x64:r=24:d=2",
    "-itsoffset", "0.125",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "mpeg4",
    "-c:a", "aac",
    "-y",
    outputPath,
  ], { encoding: "utf8", timeout: 15_000 });
  expect(generated.status, generated.stderr).toBe(0);

  const code = [
    "import importlib.util, json, pathlib, sys",
    `script = pathlib.Path(${JSON.stringify(join(appRoot, "scripts", "analyze-face-quality.py"))})`,
    "spec = importlib.util.spec_from_file_location('ltx_objective_worker', script)",
    "module = importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    "technical, signed_offset = module.probe_technical(pathlib.Path(sys.argv[1]))",
    "from av_sync_proxy import decode_audio_features",
    "base_times, _, _ = decode_audio_features(pathlib.Path(sys.argv[1]), 0.0)",
    "shifted_times, _, _ = decode_audio_features(pathlib.Path(sys.argv[1]), signed_offset)",
    "print(json.dumps({'technical': technical, 'signedOffset': signed_offset, 'decodedShift': float(shifted_times[0] - base_times[0])}))",
  ].join("\n");
  const inspected = spawnSync(pythonExecutable, ["-c", code, outputPath], {
    cwd: join(appRoot, "scripts"),
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(inspected.status, inspected.stderr).toBe(0);
  const result = JSON.parse(inspected.stdout) as {
    technical: { audioVideoStartDeltaSeconds: number };
    signedOffset: number;
    decodedShift: number;
  };

  expect(result.signedOffset).toBeGreaterThan(0.08);
  expect(result.technical.audioVideoStartDeltaSeconds).toBeCloseTo(
    Math.abs(result.signedOffset),
    6,
  );
  expect(result.decodedShift).toBeCloseTo(result.signedOffset, 6);
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
    `print(${JSON.stringify(JSON.stringify(syntheticBaseWorkerResult))})`,
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
  staleWorker.identity = measuredIdentity("yunet5-aligncrop-112.v1");
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
    result: {
      schemaVersion: "ltx-studio-objective-quality.v2",
      analyzerVersion: "ffprobe-yunet5-sface.v2",
      createdAt: timestamp,
      status: "measured",
      technical: staleWorker.technical,
      face: legacyFace(staleWorker.face),
      identity: staleWorker.identity,
      capabilities: {
        avSync: "syncnet-required",
        identity: "sface-raw-measured",
        dialogue: "whisper-not-run",
      },
      findings: [],
      limitations: ["Pre-AV-motion cache."],
    },
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

integrationIt("replaces a v3 cache that used obsolete SFace preprocessing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-v3-sface-upgrade-"));
  roots.push(root);
  const outputName = "stale-v3-sface-cache.mp4";
  await writeFile(join(root, outputName), "synthetic-output");
  const completedJob = job(outputName);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const target = library.resolveAnalysisTarget(outputName);
  const staleWorker = structuredClone(syntheticWorkerResult);
  staleWorker.identity = measuredIdentity("yunet5-aligncrop-112.v1");
  const timestamp = "2026-07-24T18:31:00.000Z";
  const staleAnalysisId = "3c8a5dc6-8864-49f7-a639-85caef918881";
  writeOutputAnalysis(root, {
    schemaVersion: "ltx-studio-output-analysis.v3",
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
    result: v3Analysis(staleWorker, timestamp),
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

integrationIt("replaces a completed v3 cache even with current SFace and AV preprocessing", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-v3-current-cache-"));
  roots.push(root);
  const outputName = "current-v3-cache.mp4";
  await writeFile(join(root, outputName), "synthetic-output");
  const completedJob = job(outputName);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const target = library.resolveAnalysisTarget(outputName);
  const currentWorker = structuredClone(syntheticWorkerResult);
  currentWorker.identity = measuredIdentity("yunet5-aligncrop-112-track.v2");
  const timestamp = "2026-07-24T18:32:00.000Z";
  const currentAnalysisId = "3c8a5dc6-8864-49f7-a639-85caef918882";
  writeOutputAnalysis(root, {
    schemaVersion: "ltx-studio-output-analysis.v3",
    outputName,
    sizeBytes: target.sizeBytes,
    modifiedAtMs: target.modifiedAtMs,
    changedAtMs: target.changedAtMs,
    fileId: target.fileId,
    jobId: target.jobId,
    analysisId: currentAnalysisId,
    attempt: 1,
    status: "completed",
    progress: 100,
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    updatedAt: timestamp,
    error: null,
    result: v3Analysis(currentWorker, timestamp),
  });
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    analysisTempRoot: join(root, "analysis-tmp"),
  });

  const fresh = manager.start(outputName);

  expect(fresh.analysisId).not.toBe(currentAnalysisId);
  expect(fresh.attempt).toBe(2);
  expect(fresh.status).toBe("queued");
  manager.cancel(outputName, fresh.analysisId);
}, 20_000);

integrationIt("invalidates a completed legacy v6 cache after the artifact analyzer upgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-v4-current-cache-"));
  roots.push(root);
  const outputName = "current-v4-cache.mp4";
  await writeFile(join(root, outputName), "synthetic-output");
  const completedJob = job(outputName);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const target = library.resolveAnalysisTarget(outputName);
  const currentWorker = structuredClone(syntheticWorkerResult);
  currentWorker.identity = measuredIdentity("yunet5-aligncrop-112-track.v2");
  const timestamp = "2026-07-24T18:33:00.000Z";
  const currentAnalysisId = "3c8a5dc6-8864-49f7-a639-85caef918883";
  const evaluatorState: PhonemeVisemeEvaluatorState = {
    fingerprint: "manifest-missing.v1",
    result: unavailablePhonemeVisemeResult(),
  };
  writeOutputAnalysis(root, {
    schemaVersion: "ltx-studio-output-analysis.v6",
    evaluatorFingerprint: combinedEvaluatorFingerprint(evaluatorState, dialogueEvaluatorState),
    conditioningAudioSha256: null,
    expectedDialogueSha256: createHash("sha256")
      .update(target.request.promptParts.dialogue)
      .digest("hex"),
    outputName,
    sizeBytes: target.sizeBytes,
    modifiedAtMs: target.modifiedAtMs,
    changedAtMs: target.changedAtMs,
    fileId: target.fileId,
    jobId: target.jobId,
    analysisId: currentAnalysisId,
    attempt: 1,
    status: "completed",
    progress: 100,
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    updatedAt: timestamp,
    error: null,
    result: v6Analysis(currentWorker, timestamp),
  });
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    analysisTempRoot: join(root, "analysis-tmp"),
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
  });

  const fresh = manager.start(outputName);
  expect(fresh.analysisId).not.toBe(currentAnalysisId);
  expect(fresh.attempt).toBe(2);
  expect(fresh.status).toBe("queued");
  manager.cancel(outputName, fresh.analysisId);
}, 20_000);

integrationIt("reuses a current v7 cache and invalidates it when only the evaluator fingerprint changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-v4-pv-cache-"));
  roots.push(root);
  const outputName = "pv-manifest-cache.mp4";
  await writeFile(join(root, outputName), "synthetic-output");
  const completedJob = job(outputName);
  const library = new OutputLibrary(root);
  library.recordCompleted([completedJob]);
  const target = library.resolveAnalysisTarget(outputName);
  const currentWorker = structuredClone(syntheticWorkerResult);
  currentWorker.identity = measuredIdentity("yunet5-aligncrop-112-track.v2");
  const timestamp = "2026-07-24T18:34:00.000Z";
  const currentAnalysisId = "3c8a5dc6-8864-49f7-a639-85caef918884";
  let evaluatorState: PhonemeVisemeEvaluatorState = {
    fingerprint: "manifest-missing.v1",
    result: unavailablePhonemeVisemeResult(),
  };
  writeOutputAnalysis(root, {
    schemaVersion: "ltx-studio-output-analysis.v7",
    evaluatorFingerprint: combinedEvaluatorFingerprint(evaluatorState, dialogueEvaluatorState),
    conditioningAudioSha256: null,
    expectedDialogueSha256: createHash("sha256")
      .update(target.request.promptParts.dialogue)
      .digest("hex"),
    outputName,
    sizeBytes: target.sizeBytes,
    modifiedAtMs: target.modifiedAtMs,
    changedAtMs: target.changedAtMs,
    fileId: target.fileId,
    jobId: target.jobId,
    analysisId: currentAnalysisId,
    attempt: 1,
    status: "completed",
    progress: 100,
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    updatedAt: timestamp,
    error: null,
    result: buildObjectiveQualityAnalysis(currentWorker, timestamp),
  });
  const manager = new OutputAnalysisManager(library, () => [completedJob], root, {
    analysisTempRoot: join(root, "analysis-tmp"),
    phonemeVisemeEvaluatorStateResolver: () => evaluatorState,
    dialogueEvaluatorStateResolver: () => dialogueEvaluatorState,
  });

  expect(manager.start(outputName).analysisId).toBe(currentAnalysisId);

  evaluatorState = {
    fingerprint: "manifest-missing.v2",
    result: unavailablePhonemeVisemeResult(),
  };
  const fresh = manager.start(outputName);

  expect(fresh.analysisId).not.toBe(currentAnalysisId);
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

it("retries an uncertain unit status before deleting private measurement remnants", async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-objective-pv-recovery-"));
  roots.push(root);
  const analysisId = "3c8a5dc6-8864-49f7-a639-85caef918888";
  const unit = `ltx-pv-${analysisId}.service`;
  const privateDirectory = join(root, `phoneme-viseme-${analysisId}`);
  await mkdir(privateDirectory, { recursive: true });
  await writeFile(join(privateDirectory, "request.json"), "private dialogue");
  let stateReads = 0;
  const controlCommand = async (args: string[]) => {
    if (args.includes("list-units")) {
      return { code: 0, stdout: `${unit} loaded active running fixture\n`, stderr: "" };
    }
    if (args.includes("stop")) return { code: 0, stdout: "", stderr: "" };
    stateReads += 1;
    if (stateReads === 1) {
      return { code: null, stdout: "", stderr: "synthetic D-Bus failure" };
    }
    return {
      code: 0,
      stdout: "LoadState=not-found\nActiveState=inactive\n",
      stderr: "",
    };
  };

  await recoverPhonemeVisemeSandboxState(root, controlCommand);

  expect(stateReads).toBe(2);
  expect(existsSync(privateDirectory)).toBe(false);
});

it("does not accept not-found before a starting unit was observed", async () => {
  let stateReads = 0;
  const controlCommand = async (args: string[]) => {
    if (args.includes("stop")) return { code: 0, stdout: "", stderr: "" };
    stateReads += 1;
    if (stateReads === 1) {
      return {
        code: 0,
        stdout: "LoadState=not-found\nActiveState=inactive\n",
        stderr: "",
      };
    }
    if (stateReads === 2) {
      return {
        code: 0,
        stdout: "LoadState=loaded\nActiveState=active\n",
        stderr: "",
      };
    }
    return {
      code: 0,
      stdout: "LoadState=not-found\nActiveState=inactive\n",
      stderr: "",
    };
  };

  await stopSystemdUnit("ltx-pv-start-race.service", controlCommand, {
    clientFinished: () => false,
  });

  expect(stateReads).toBe(3);
});

it("bounds persistent control-channel failures with a hard stop deadline", async () => {
  const startedAt = Date.now();
  const controlCommand = async () => ({
    code: null,
    stdout: "",
    stderr: "synthetic persistent D-Bus timeout",
  });

  await expect(stopSystemdUnit(
    "ltx-pv-control-timeout.service",
    controlCommand,
    {
      deadlineMs: 20,
      pollIntervalMs: 0,
      controlTimeoutMs: 1,
    },
  )).rejects.toThrow("unbestätigt");

  expect(Date.now() - startedAt).toBeLessThan(500);
});
