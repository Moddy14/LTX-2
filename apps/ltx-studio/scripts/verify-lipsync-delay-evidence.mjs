#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(scriptRoot, "..");
const defaultEvidencePath = join(
  studioRoot,
  "docs/evidence/lipsync-delay-calibration-2026-08-25.json",
);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function fail(message) {
  throw new Error(`Lip-sync evidence invalid: ${message}`);
}

function object(value, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mediaStreamSha256(path, stream) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v", "error",
      "-i", path,
      "-map", `0:${stream}:0`,
      "-c", "copy",
      "-f", "hash",
      "-hash", "sha256",
      "-",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.error || result.status !== 0) {
    fail(
      `cannot hash ${stream === "v" ? "video" : "audio"} stream for ${basename(path)}: ${
        result.error?.message ?? result.stderr.trim() ?? `ffmpeg exited ${result.status}`
      }`,
    );
  }
  const match = /^SHA256=([0-9a-f]{64})$/m.exec(result.stdout.trim());
  if (!match) fail(`invalid ffmpeg stream hash for ${basename(path)}`);
  return match[1];
}

function safeChild(root, name, suffix = "") {
  if (typeof name !== "string" || name !== basename(name) || !name.endsWith(".mp4")) {
    fail(`unsafe output name: ${String(name)}`);
  }
  const path = resolve(root, `${name}${suffix}`);
  const pathRelative = relative(root, path);
  if (pathRelative.startsWith("..") || isAbsolute(pathRelative)) fail(`path escapes data root: ${name}`);
  return path;
}

function equal(actual, expected, context) {
  if (!Object.is(actual, expected)) {
    fail(`${context} differs: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function analysisMeasurement(analysis, outputName) {
  const record = object(analysis, `${outputName} analysis`);
  equal(record.schemaVersion, "ltx-studio-output-analysis.v7", `${outputName} analysis schema`);
  equal(record.status, "completed", `${outputName} analysis status`);
  const result = object(record.result, `${outputName} analysis result`);
  const phonemeViseme = object(result.phonemeViseme, `${outputName} phoneme/viseme result`);
  return {
    result,
    measurement: object(phonemeViseme.measurement, `${outputName} phoneme/viseme measurement`),
  };
}

function verifyRun(outputsRoot, run, shared) {
  const record = object(run, "run");
  const outputPath = safeChild(outputsRoot, record.outputName);
  const analysisPath = safeChild(outputsRoot, record.outputName, ".ltx-analysis.json");
  const settingsPath = safeChild(outputsRoot, record.outputName, ".ltx-settings.json");
  equal(sha256(outputPath), record.outputSha256, `${record.outputName} output SHA-256`);
  equal(
    mediaStreamSha256(outputPath, "a"),
    record.audioStreamSha256,
    `${record.outputName} audio-stream SHA-256`,
  );
  equal(sha256(analysisPath), record.analysisSha256, `${record.outputName} analysis SHA-256`);
  equal(sha256(settingsPath), record.settingsSha256, `${record.outputName} settings SHA-256`);

  const analysis = JSON.parse(readFileSync(analysisPath, "utf8"));
  const { result, measurement } = analysisMeasurement(analysis, record.outputName);
  equal(analysis.evaluatorFingerprint, shared.evaluatorFingerprint, `${record.outputName} evaluator fingerprint`);
  equal(measurement.runnerFingerprint, shared.runnerFingerprint, `${record.outputName} runner fingerprint`);
  equal(measurement.expectedDialogueSha256, shared.expectedDialogueSha256, `${record.outputName} dialogue hash`);
  equal(measurement.usableDurationSeconds, shared.measurementContract.durationSeconds, `${record.outputName} duration`);
  equal(measurement.sampledFrames, shared.measurementContract.sampledFrames, `${record.outputName} sampled frames`);
  equal(result.technical.fps, shared.measurementContract.fps, `${record.outputName} fps`);
  equal(result.dialogue.wordErrorRate, shared.measurementContract.wordErrorRate, `${record.outputName} WER`);
  equal(measurement.phoneCoverage, shared.measurementContract.phoneCoverage, `${record.outputName} phone coverage`);
  equal(measurement.faceTrackCoverage, shared.measurementContract.faceTrackCoverage, `${record.outputName} face coverage`);
  equal(measurement.mouthTrackCoverage, shared.measurementContract.mouthTrackCoverage, `${record.outputName} mouth coverage`);
  equal(measurement.multiFaceFrameRatio, shared.measurementContract.multiFaceFrameRatio, `${record.outputName} multi-face ratio`);

  for (const [evidenceKey, measurementKey] of Object.entries({
    globalAvLagMilliseconds: "globalAvLagMilliseconds",
    lagConfidence: "lagConfidence",
    bilabialClosureF1: "bilabialClosureF1",
    openingCorrelation: "openingCorrelation",
    roundingCorrelation: "roundingCorrelation",
    speechMotionRecall: "speechMotionRecall",
    pauseLeakRatio: "pauseLeakRatio",
  })) {
    equal(measurement[measurementKey], record[evidenceKey], `${record.outputName} ${evidenceKey}`);
  }

  const settings = object(JSON.parse(readFileSync(settingsPath, "utf8")), `${record.outputName} settings`);
  const request = object(settings.request, `${record.outputName} request`);
  const lipForcing = object(object(request.postprocess, "postprocess").lipForcing, "lipForcing");
  equal(lipForcing.mouthDelayMs, record.controlDelayMilliseconds, `${record.outputName} control delay`);
  equal(lipForcing.programAudioDelayMs, record.audioDelayMilliseconds, `${record.outputName} audio delay`);
  return { record, result, videoStreamSha256: mediaStreamSha256(outputPath, "v") };
}

function verifyVisualStream(groupName, visual, verifiedRun) {
  const record = object(visual, `${groupName} visual stream`);
  const { result, videoStreamSha256 } = verifiedRun;
  equal(record.videoStreamSha256, videoStreamSha256, `${groupName} video-stream SHA-256`);
  const face = object(result.face, `${groupName} face metrics`);
  const identity = object(result.identity, `${groupName} identity metrics`);
  for (const [evidenceKey, source] of Object.entries({
    mouthSkinWarpResidualP95: face.mouthSkinWarpResidualP95,
    mouthSkinLuminanceDeltaP95: face.mouthSkinLuminanceDeltaP95,
    mouthSkinFlowDeformationP95: face.mouthSkinFlowDeformationP95,
    mouthSkinValidPixelCoverageP10: face.mouthSkinValidPixelCoverageP10,
    identityCosineMedian: identity.cosineMedian,
    identityCosineP10: identity.cosineP10,
    identityCosineMinimum: identity.cosineMinimum,
  })) equal(record[evidenceKey], source, `${groupName} ${evidenceKey}`);
}

function verifyRelativeSensitivity(evidence, control125Runs) {
  const relative = object(evidence.measurementContract.relativeSensitivity, "relative sensitivity");
  const sorted = [...control125Runs].sort(
    (left, right) => left.record.audioDelayMilliseconds - right.record.audioDelayMilliseconds,
  );
  equal(
    JSON.stringify(sorted.map(({ record }) => record.audioDelayMilliseconds)),
    JSON.stringify(evidence.measurementContract.knownAudioDelayMilliseconds),
    "known audio-delay grid",
  );
  equal(
    JSON.stringify(sorted.map(({ record }) => record.globalAvLagMilliseconds)),
    JSON.stringify(relative.measuredLagMilliseconds),
    "measured lag grid",
  );
  const xs = sorted.map(({ record }) => record.audioDelayMilliseconds);
  const ys = sorted.map(({ record }) => record.globalAvLagMilliseconds);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  const slope = xs.reduce((sum, value, index) => sum + (value - meanX) * (ys[index] - meanY), 0)
    / xs.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  const intercept = meanY - slope * meanX;
  const residual = ys.reduce(
    (sum, value, index) => sum + (value - (intercept + slope * xs[index])) ** 2,
    0,
  );
  const total = ys.reduce((sum, value) => sum + (value - meanY) ** 2, 0);
  equal(Number(slope.toFixed(4)), relative.linearSlope, "relative sensitivity slope");
  equal(Number((1 - residual / total).toFixed(4)), relative.coefficientOfDetermination, "relative sensitivity R²");
  equal(Number((-intercept / slope).toFixed(1)), relative.estimatedZeroCrossingMilliseconds, "relative zero crossing");
}

function verifyGuiExperiment(dataRoot, evidence, verifiedRuns) {
  const gui = object(evidence.guiExperiment, "guiExperiment");
  const experimentPath = resolve(dataRoot, "experiments", `${gui.experimentId}.json`);
  equal(sha256(experimentPath), gui.experimentFileSha256, "GUI experiment SHA-256");
  const experiment = object(JSON.parse(readFileSync(experimentPath, "utf8")), "GUI experiment");
  equal(experiment.id, gui.experimentId, "GUI experiment id");
  equal(experiment.protocolSha256, gui.protocolSha256, "GUI protocol SHA-256");
  equal(experiment.claimScope, gui.claimScope, "GUI claim scope");
  equal(experiment.changedRequestPaths?.length, 1, "GUI controlled path count");
  equal(experiment.changedRequestPaths?.[0], gui.controlledPath, "GUI controlled path");

  const baseline = object(experiment.arms?.[0], "GUI baseline arm");
  const candidate = object(experiment.arms?.[1], "GUI candidate arm");
  equal(baseline.jobId, gui.baseline.jobId, "GUI baseline job id");
  equal(baseline.requestSha256, gui.baseline.requestSha256, "GUI baseline request SHA-256");
  equal(baseline.request?.postprocess?.lipForcing?.programAudioDelayMs, gui.baseline.delayMilliseconds, "GUI baseline delay");
  equal(candidate.jobId, gui.candidate.jobId, "GUI candidate job id");
  equal(candidate.requestSha256, gui.candidate.requestSha256, "GUI candidate request SHA-256");
  equal(candidate.request?.postprocess?.lipForcing?.programAudioDelayMs, gui.candidate.delayMilliseconds, "GUI candidate delay");

  const outputsRoot = resolve(dataRoot, "outputs");
  const outputPath = safeChild(outputsRoot, gui.candidate.outputName);
  const analysisPath = safeChild(outputsRoot, gui.candidate.outputName, ".ltx-analysis.json");
  const settingsPath = safeChild(outputsRoot, gui.candidate.outputName, ".ltx-settings.json");
  equal(sha256(outputPath), gui.candidate.outputSha256, "GUI candidate output SHA-256");
  equal(sha256(analysisPath), gui.candidate.analysisSha256, "GUI candidate analysis SHA-256");
  equal(sha256(settingsPath), gui.candidate.settingsSha256, "GUI candidate settings SHA-256");
  const settings = object(JSON.parse(readFileSync(settingsPath, "utf8")), "GUI candidate settings");
  equal(settings.jobId, gui.candidate.jobId, "GUI candidate settings job id");
  equal(settings.experiment?.experimentId, gui.experimentId, "GUI candidate experiment binding");
  equal(settings.experiment?.protocolSha256, gui.protocolSha256, "GUI candidate protocol binding");
  equal(settings.experiment?.requestSha256, gui.candidate.requestSha256, "GUI candidate request binding");
  equal(settings.runProvenance?.fingerprint, gui.candidate.runProvenanceFingerprint, "GUI candidate provenance");
  const matchedRun = verifiedRuns.find(({ record }) =>
    record.controlDelayMilliseconds === gui.baseline.delayMilliseconds
    && record.audioDelayMilliseconds === gui.candidate.delayMilliseconds);
  if (!matchedRun) fail("GUI candidate has no matching matrix run");
  equal(gui.candidate.outputSha256, matchedRun.record.outputSha256, "GUI candidate matrix-byte identity");
  const guiVideoStreamSha256 = mediaStreamSha256(outputPath, "v");
  equal(gui.candidate.videoStreamSha256, guiVideoStreamSha256, "GUI candidate video-stream SHA-256");
  equal(
    gui.candidate.videoStreamSha256,
    evidence.visualStreams.control125.videoStreamSha256,
    "GUI candidate visual-stream identity",
  );
}

const evidencePath = resolve(argument("--evidence") ?? defaultEvidencePath);
const dataRootArgument = argument("--data-root") ?? process.env.LTX_STUDIO_DATA_DIR;
if (!dataRootArgument) fail("pass --data-root or set LTX_STUDIO_DATA_DIR");
const dataRoot = resolve(dataRootArgument);
const evidence = object(JSON.parse(readFileSync(evidencePath, "utf8")), "evidence");
equal(evidence.schemaVersion, "ltx-studio-lipsync-delay-calibration.v1", "evidence schema");
equal(evidence.status, "engineering-candidate-not-product-go", "evidence status");
if (!Array.isArray(evidence.runs) || evidence.runs.length === 0) fail("runs must be non-empty");
const outputsRoot = resolve(dataRoot, "outputs");
const verifiedRuns = evidence.runs.map((run) => verifyRun(outputsRoot, run, evidence));
const control125Runs = verifiedRuns.filter(({ record }) => record.controlDelayMilliseconds === 125);
verifyRelativeSensitivity(evidence, control125Runs);
const control125VisualRun = verifiedRuns.find(({ record }) =>
  record.controlDelayMilliseconds === 125 && record.audioDelayMilliseconds === 125);
const control175VisualRun = verifiedRuns.find(({ record }) =>
  record.controlDelayMilliseconds === 175 && record.audioDelayMilliseconds === 175);
if (!control125VisualRun || !control175VisualRun) fail("visual control anchors are missing");
verifyVisualStream("control125", evidence.visualStreams.control125, control125VisualRun);
verifyVisualStream("control175", evidence.visualStreams.control175, control175VisualRun);
verifyGuiExperiment(dataRoot, evidence, verifiedRuns);
console.log(`lipsync-delay-evidence-valid:${evidence.runs.length}/${evidence.runs.length};gui=1/1`);
