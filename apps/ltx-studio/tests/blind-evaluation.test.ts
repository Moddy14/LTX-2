import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BLIND_EVALUATION_PADDING_BUCKET_BYTES,
  blindEvaluationInitialPinSchema,
  createBlindEvaluationSubmissionPin,
  blindEvaluationMediaBindingSchema,
  blindEvaluationPublicSchema,
  blindEvaluationPublicStateSha256,
  blindEvaluationRecordSchema,
  canonicalBlindEvaluationJson,
  summarizeBlindPlaybackCoverage,
  verifyBlindEvaluationReveal,
  type BlindEvaluationInitialPin,
  type BlindEvaluationPublic,
  type BlindEvaluationSubmissionInput,
} from "../shared/blindEvaluation.js";
import type { ControlledExperiment, ExperimentRunBinding } from "../shared/experiments.js";
import type { StudioOutput } from "../shared/outputs.js";
import {
  assertBoundBlindExecutableUnchanged,
  blindEvaluationCommitment,
  BlindEvaluationConflictError,
  BlindEvaluationStore,
  BLIND_EVALUATION_STORAGE_MAX_BYTES,
  BLIND_EVALUATION_QUARANTINE_RETENTION_MS,
  BLIND_EVALUATION_TERMINAL_RETENTION_MS,
  BLIND_EVALUATION_TOMBSTONE_RETENTION_MS,
  blindEvaluationRetentionTombstoneSchema,
  inspectBlindIsoBmffTopLevel,
  openBoundBlindExecutable,
  probeBlindCanonicalSnapshot,
  runBoundBlindToolForTest,
  runFfmpegNormalization,
  type BlindEvaluationPublishedOutputProvider,
  type BlindEvaluationMediaLease,
} from "../server/blindEvaluationStore.js";
import { sendVerifiedBlindEvaluationMedia } from "../server/blindMediaResponse.js";
import { evaluateBlindV5ApiGate } from "../server/blindApiGate.js";
import { ExperimentStore } from "../server/experimentStore.js";
import {
  createVerifiedOutputSnapshot,
  prepareOutputPublicationAuthority,
  type OutputPublicationAuthority,
} from "../server/outputPublication.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];
const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASELINE_JOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CANDIDATE_JOB_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CREATED_AT = "2026-08-25T12:00:00.000Z";
const CREDENTIAL = "8".repeat(64);
const IDEMPOTENCY_KEY = "6".repeat(64);
const UNABORTED_SIGNAL = new AbortController().signal;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Fixture = {
  root: string;
  outputRoot: string;
  sessionRoot: string;
  store: BlindEvaluationStore;
  experiment: ControlledExperiment;
  outputs: [StudioOutput, StudioOutput];
  publishedOutputs: BlindEvaluationPublishedOutputProvider;
  sourceBefore: Array<{ sha256: string; size: number; ino: number; mtimeMs: number; ctimeMs: number }>;
};

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalBlindEvaluationJson(value)).digest("hex");
}

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function runProvenance(fingerprint: string) {
  return {
    schemaVersion: "ltx-studio-run-provenance.v2" as const,
    capturedAt: CREATED_AT,
    verifiedAt: CREATED_AT,
    files: [],
    code: [],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "test",
      nodeVersion: "test",
      pythonExecutable: "/test/python",
      pythonVersion: "test",
      packages: {},
      ffmpegVersion: "test",
      fingerprint: "f".repeat(64),
    },
    upstreamContracts: [],
    release: {
      sealed: false,
      verified: false,
      releaseDigest: null,
      manifestSha256: null,
      surfaceDigest: null,
      runtimeInstallSealSha256: null,
      runtimeTreeSha256: null,
      runtimePolicySha256: null,
      nodeExecutableSha256: null,
      expectedHostTcbAttestationSha256: null,
      sourceCommit: null,
    },
    fingerprint,
  };
}

function createSourceMp4(path: string, color: string, duration: number, title: string): void {
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `color=c=${color}:s=160x90:r=12:d=${duration}`,
    "-f", "lavfi", "-i", `sine=frequency=${color === "red" ? 440 : 660}:duration=${duration}`,
    "-c:v", "mpeg4", "-q:v", color === "red" ? "5" : "3",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    "-metadata", `title=${title}`,
    "-metadata", `comment=private-${color}`,
    "-timecode", "01:02:03:04",
    "-metadata:s:d:0", "handler_name=RAW-TIMECODE-SENTINEL",
    path,
  ], { timeout: 30_000, stdio: "pipe" });
}

function analyzedOutput(
  outputRoot: string,
  experiment: ControlledExperiment,
  armIndex: 0 | 1,
  binding: ExperimentRunBinding,
  duration: number,
): StudioOutput {
  const selected = experiment.arms[armIndex];
  const path = join(outputRoot, selected.request.outputName);
  createSourceMp4(
    path,
    armIndex === 0 ? "red" : "blue",
    duration,
    `private-${armIndex === 0 ? "baseline" : "candidate"}-metadata`,
  );
  const stats = statSync(path);
  const fingerprint = armIndex === 0 ? "1".repeat(64) : "2".repeat(64);
  const provenance = runProvenance(fingerprint);
  const analysis = {
    schemaVersion: "ltx-studio-output-analysis.v7",
    outputName: selected.request.outputName,
    sizeBytes: stats.size,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
    fileId: String(stats.ino),
    jobId: selected.jobId,
    analysisId: armIndex === 0
      ? "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
      : "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    attempt: 1,
    status: "completed",
    progress: 100,
    createdAt: CREATED_AT,
    startedAt: CREATED_AT,
    finishedAt: CREATED_AT,
    updatedAt: CREATED_AT,
    error: null,
    evaluatorFingerprint: "test-evaluator",
    conditioningAudioSha256: null,
    expectedDialogueSha256: "3".repeat(64),
    result: {
      schemaVersion: "ltx-studio-objective-quality.v7",
      technical: { durationSeconds: duration, hasAudio: true },
    },
  } as StudioOutput["analysis"];
  const output: StudioOutput = {
    name: selected.request.outputName,
    url: `/api/outputs/${encodeURIComponent(selected.request.outputName)}`,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    changedAt: stats.ctime.toISOString(),
    fileId: String(stats.ino),
    jobId: selected.jobId,
    jobStatus: "completed",
    request: selected.request,
    settingsAvailable: true,
    qualityReview: null,
    analysis,
    provenance,
    experiment: binding,
    project: null,
    experimentRequestVerified: true,
  };
  writeFileSync(`${path}.ltx-settings.json`, JSON.stringify({
    schemaVersion: "ltx-studio-output.v7",
    outputName: output.name,
    jobId: output.jobId,
    completedAt: CREATED_AT,
    sizeBytes: output.sizeBytes,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
    fileId: output.fileId,
    request: output.request,
    qualityReview: null,
    identityEvidence: null,
    runProvenance: provenance,
    experiment: binding,
    project: null,
  }));
  writeFileSync(`${path}.ltx-analysis.json`, JSON.stringify(analysis));
  return output;
}

async function fixture(maxMediaBytes?: number): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "ltx-blind-evaluation-v5-"));
  roots.push(root);
  const outputRoot = join(root, "outputs");
  const sessionRoot = join(root, "blind-evaluations");
  const experimentRoot = join(root, "experiments");
  await mkdir(outputRoot, { recursive: true });
  const experiments = new ExperimentStore(experimentRoot);
  const baseline = validRequest("audio-to-video");
  baseline.outputName = "blind-source.mp4";
  baseline.videoGuidance.modalityScale = 5;
  // Keep synthetic unit fixtures short while exercising the immutable production v5 profile.
  baseline.frameRate = 25;
  baseline.numFrames = 25;
  let experiment = experiments.create({
    title: "Verblindete Guidance-Ablation",
    baselineRequest: baseline,
    candidate: { variable: "a2v-guidance", value: 3 },
  }, CREATED_AT);
  experiment = experiments.freeze(experiment.id, "2026-08-25T12:01:00.000Z");
  const baselineBinding = experiments.bindingFor(experiment.id, "baseline");
  experiment = experiments.attachJob(experiment.id, "baseline", BASELINE_JOB_ID);
  const candidateBinding = experiments.bindingFor(experiment.id, "candidate");
  experiment = experiments.attachJob(experiment.id, "candidate", CANDIDATE_JOB_ID);
  const outputs: [StudioOutput, StudioOutput] = [
    analyzedOutput(outputRoot, experiment, 0, baselineBinding, 1),
    analyzedOutput(outputRoot, experiment, 1, candidateBinding, 1.35),
  ];
  const sourceBefore = outputs.map((output) => {
    const path = join(outputRoot, output.name);
    const stats = statSync(path);
    return {
      sha256: hashFile(path),
      size: stats.size,
      ino: stats.ino,
      mtimeMs: stats.mtimeMs,
      ctimeMs: stats.ctimeMs,
    };
  });
  const authorities = new Map<string, OutputPublicationAuthority>(outputs.map((output, index) => {
    const outputPath = join(outputRoot, output.name);
    return [output.name, prepareOutputPublicationAuthority(outputPath, {
      jobId: output.jobId!,
      publishedAt: CREATED_AT,
      executionDecisionSha256: String(index + 1).repeat(64),
      jobPersistenceRevision: index === 0
        ? "10101010-1010-4010-8010-101010101010"
        : "20202020-2020-4020-8020-202020202020",
      jobAuthoritySha256: String(index + 3).repeat(64),
    })];
  }));
  const publishedOutputs: BlindEvaluationPublishedOutputProvider = {
    outputs,
    openPublishedOutput: (outputName, expectedJobId) => {
      const authority = authorities.get(outputName);
      if (!authority || authority.jobId !== expectedJobId) return null;
      const source = openSync(authority.output.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      return createVerifiedOutputSnapshot({
        authority,
        fd: source,
        outputPath: authority.output.path,
        snapshotBackend: "source",
      }, outputRoot);
    },
  };
  const store = new BlindEvaluationStore(sessionRoot, outputRoot, {
    id: () => SESSION_ID,
    nonce: () => "9".repeat(64),
    credential: () => CREDENTIAL,
    baselineFirst: () => true,
  }, maxMediaBytes);
  return { root, outputRoot, sessionRoot, store, experiment, outputs, publishedOutputs, sourceBefore };
}

function validSubmission(durationMilliseconds = 960): BlindEvaluationSubmissionInput {
  const completeCoverage = () => summarizeBlindPlaybackCoverage(
    [{ startMilliseconds: 0, endMilliseconds: durationMilliseconds }],
    durationMilliseconds,
    true,
  );
  const playback = () => ({
    durationMilliseconds,
    normalSpeed: completeCoverage(),
    halfSpeed: completeCoverage(),
    audibleNormalSpeed: completeCoverage(),
    audibleHalfSpeed: completeCoverage(),
    mediaLoaded: true as const,
    playSucceeded: true as const,
    audioReviewed: true as const,
  });
  return {
    scores: {
      x: { timing: 8, mouthIntegration: 9, eyesIdentity: 8, resolutionDetail: 7 },
      y: { timing: 9, mouthIntegration: 8, eyesIdentity: 9, resolutionDetail: 9 },
    },
    preference: "y",
    confidence: 4,
    note: "Y wirkt bei Plosiven stabiler, X integriert den Mund etwas ruhiger.",
    playback: {
      x: playback(),
      y: playback(),
      normalSpeedReviewed: true,
      halfSpeedReviewed: true,
      humanObservationAttested: true,
    },
  };
}

async function pinFor(evaluation: BlindEvaluationPublic): Promise<BlindEvaluationInitialPin> {
  return blindEvaluationInitialPinSchema.parse({
    schemaVersion: "ltx-studio-blind-evaluation-initial-pin.v5",
    id: evaluation.id,
    commitment: evaluation.commitment,
    publicStateSha256: await blindEvaluationPublicStateSha256(evaluation),
  });
}

async function accessBoth(subject: Fixture): Promise<void> {
  const x = subject.store.openMedia(SESSION_ID, "x", CREDENTIAL, "2026-08-25T12:02:00.000Z");
  const y = subject.store.openMedia(SESSION_ID, "y", CREDENTIAL, "2026-08-25T12:02:01.000Z");
  x.reserveResponseBytes(1);
  y.reserveResponseBytes(1);
  x.releaseResponse();
  y.releaseResponse();
  closeSync(x.fd);
  closeSync(y.fd);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMilliseconds = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Zeitlimit beim Warten auf den adversarial Testzustand.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
}

type ServedMedia = { status: number; headers: Headers; body: Buffer };

async function serveLease(
  lease: BlindEvaluationMediaLease,
  range?: string,
  afterHeaders?: () => void,
): Promise<ServedMedia> {
  const app = express();
  app.get("/media", (request, response) => sendVerifiedBlindEvaluationMedia(request, response, lease));
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("listening", resolvePromise);
      server.once("error", rejectPromise);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Testserver hat keine TCP-Adresse.");
    const response = await fetch(`http://127.0.0.1:${address.port}/media`, {
      headers: range ? { Range: range } : undefined,
    });
    afterHeaders?.();
    return {
      status: response.status,
      headers: response.headers,
      body: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.close((error) => error ? rejectPromise(error) : resolvePromise());
    });
  }
}

describe("Blind Evidence v5", () => {
  it("enforces the exact HTTP method/path matrix before lock reads, including HEAD and OPTIONS", () => {
    const id = SESSION_ID;
    const routes = [
      ["/api/blind-evaluator-scope", "GET"],
      ["/api/blind-evaluations", "POST"],
      [`/api/blind-evaluations/${id}`, "GET"],
      [`/api/blind-evaluations/${id}/media/x`, "GET"],
      [`/api/blind-evaluations/${id}/media/y`, "GET"],
      [`/api/blind-evaluations/${id}/claim`, "POST"],
      [`/api/blind-evaluations/${id}/submission`, "POST"],
      [`/api/blind-evaluations/${id}/abort`, "POST"],
      [`/api/blind-evaluations/${id}/scope/release`, "POST"],
    ] as const;
    for (const [path, allowed] of routes) {
      for (const method of ["HEAD", "OPTIONS", allowed === "GET" ? "POST" : "GET"]) {
        let lockReads = 0;
        const result = evaluateBlindV5ApiGate({
          path,
          method,
          capabilityCookiePresent: true,
          readGlobalLock: () => { lockReads += 1; throw new Error("must not run"); },
        });
        expect(result.rejection).toMatchObject({ status: 405, allow: allowed });
        expect(lockReads).toBe(0);
      }
    }
    expect(evaluateBlindV5ApiGate({
      path: `/api/blind-evaluations/${id}/media/z`,
      method: "GET",
      capabilityCookiePresent: false,
      readGlobalLock: () => { throw new Error("must not run"); },
    }).rejection).toMatchObject({ status: 404 });
    for (const path of ["/api/jobs", "/api/outputs", "/api/events"]) {
      expect(evaluateBlindV5ApiGate({
        path,
        method: "GET",
        capabilityCookiePresent: false,
        readGlobalLock: () => true,
      }).rejection).toMatchObject({ status: 423 });
      expect(evaluateBlindV5ApiGate({
        path,
        method: "GET",
        capabilityCookiePresent: false,
        readGlobalLock: () => { throw new Error("corrupt durable lock"); },
      }).rejection).toMatchObject({ status: 423 });
    }
    expect(evaluateBlindV5ApiGate({
      path: "/api/jobs",
      method: "GET",
      capabilityCookiePresent: true,
      readGlobalLock: () => false,
    }).rejection).toMatchObject({ status: 403 });
    expect(evaluateBlindV5ApiGate({
      path: `/api/blind-evaluations/${id}/claim`,
      method: "POST",
      capabilityCookiePresent: true,
      readGlobalLock: () => true,
    }).rejection).toBeNull();
  });

  it("emits only mapper-generated strict public Blind DTOs and rejects nested authority extras", async () => {
    const subject = await fixture();
    const creationRequestId = "a".repeat(64);
    const reserved = subject.store.reserve(subject.experiment, creationRequestId, CREATED_AT);
    expect(blindEvaluationPublicSchema.parse(reserved.evaluation)).toEqual(reserved.evaluation);
    expect(JSON.stringify(reserved.evaluation)).not.toContain(reserved.credential);
    expect(JSON.stringify(reserved.evaluation)).not.toContain(reserved.creationToken!);
    expect(blindEvaluationPublicSchema.safeParse({
      ...reserved.evaluation,
      evaluatorScopeCredentialSha256: "b".repeat(64),
    }).success).toBe(false);
    expect(blindEvaluationPublicSchema.safeParse({
      ...reserved.evaluation,
      evaluatorScope: {
        ...reserved.evaluation.evaluatorScope,
        credential: reserved.credential,
      },
    }).success).toBe(false);

    const active = await subject.store.claim(
      reserved.evaluation.id,
      reserved.credential,
      reserved.creationToken!,
      subject.experiment,
      subject.publishedOutputs,
    );
    expect(blindEvaluationPublicSchema.parse(active)).toEqual(active);
    expect(blindEvaluationPublicSchema.safeParse({
      ...active,
      privateState: { lockNonce: "c".repeat(64) },
    }).success).toBe(false);
    if (active.status !== "active") throw new Error("Aktiver Public-DTO fehlt");
    expect(blindEvaluationPublicSchema.safeParse({
      ...active,
      media: { ...active.media, fileId: "private-inode" },
    }).success).toBe(false);
    subject.store.abort(active.id, reserved.credential);
  });

  it("binds an absolute executable path and rejects symlinks, path replacement and same-inode writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-blind-tool-v5-"));
    roots.push(root);
    const ffmpeg = realpathSync(execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim());
    const toolPath = join(root, "ffmpeg-v5");
    copyFileSync(ffmpeg, toolPath);
    chmodSync(toolPath, 0o755);
    const bound = await openBoundBlindExecutable(toolPath);
    try {
      expect(bound.binding.path).toBe(toolPath);
      const replacement = join(root, "same-version-replacement");
      copyFileSync(ffmpeg, replacement);
      chmodSync(replacement, 0o755);
      renameSync(replacement, toolPath);
      await expect(assertBoundBlindExecutableUnchanged(bound, UNABORTED_SIGNAL)).rejects.toThrow(BlindEvaluationConflictError);
    } finally {
      closeSync(bound.fd);
    }

    copyFileSync(ffmpeg, toolPath);
    chmodSync(toolPath, 0o755);
    const inPlace = await openBoundBlindExecutable(toolPath);
    try {
      let kernelRejectedWrite = false;
      try {
        const writable = openSync(toolPath, "r+");
        try {
          expect(writeSync(writable, Buffer.from([0]), 0, 1, 0)).toBe(1);
        } finally {
          closeSync(writable);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ETXTBSY") throw error;
        kernelRejectedWrite = true;
      }
      if (kernelRejectedWrite) {
        await expect(assertBoundBlindExecutableUnchanged(inPlace, UNABORTED_SIGNAL)).resolves.toBeUndefined();
      } else {
        await expect(assertBoundBlindExecutableUnchanged(inPlace, UNABORTED_SIGNAL)).rejects.toThrow(BlindEvaluationConflictError);
      }
      chmodSync(toolPath, 0o700);
      await expect(assertBoundBlindExecutableUnchanged(inPlace, UNABORTED_SIGNAL)).rejects.toThrow(BlindEvaluationConflictError);
    } finally {
      closeSync(inPlace.fd);
      chmodSync(toolPath, 0o755);
    }

    const symlinkPath = join(root, "ffmpeg-symlink");
    symlinkSync(ffmpeg, symlinkPath);
    await expect(openBoundBlindExecutable(symlinkPath)).rejects.toThrow(BlindEvaluationConflictError);
  });

  it("aborts and SIGKILLs the initial asynchronous executable version probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-blind-tool-abort-v5-"));
    roots.push(root);
    const markerPath = join(root, "initial-version-probe.pid");
    const toolPath = join(root, "hanging-version-tool");
    writeFileSync(toolPath, [
      "#!/bin/sh",
      `printf '%s\\n' "$$" > ${JSON.stringify(markerPath)}`,
      "exec sleep 30",
      "",
    ].join("\n"), { mode: 0o755 });
    chmodSync(toolPath, 0o755);
    const controller = new AbortController();
    const binding = openBoundBlindExecutable(toolPath, controller.signal);
    await waitForCondition(() => existsSync(markerPath));
    const childPid = Number(readFileSync(markerPath, "utf8").trim());
    const abortedAt = Date.now();
    controller.abort();
    await expect(binding).rejects.toThrow("AbortController");
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
    expect(existsSync(`/proc/${childPid}`)).toBe(false);
  });

  it("keeps the original AbortSignal authoritative before, during and after post-close revalidation", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-blind-tool-post-close-abort-v5-"));
    roots.push(root);
    const toolPath = join(root, "controlled-tool");
    writeFileSync(toolPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"-version\" ]; then echo 'controlled blind-v5 tool'; exit 0; fi",
      "printf '%s\\n' \"$$\" > \"$2\"",
      "if [ \"$1\" = \"block\" ]; then exec sleep 30; fi",
      "exit 0",
      "",
    ].join("\n"), { mode: 0o755 });
    chmodSync(toolPath, 0o755);
    const tool = await openBoundBlindExecutable(toolPath);

    try {
      const beforeCloseMarker = join(root, "before-close.pid");
      const beforeCloseController = new AbortController();
      const beforeCloseRun = runBoundBlindToolForTest(
        tool,
        ["block", beforeCloseMarker],
        beforeCloseController.signal,
      );
      await waitForCondition(() => existsSync(beforeCloseMarker));
      const childPid = Number(readFileSync(beforeCloseMarker, "utf8").trim());
      const beforeCloseAbortedAt = Date.now();
      beforeCloseController.abort();
      await expect(beforeCloseRun).rejects.toThrow(/abgebrochen/iu);
      expect(Date.now() - beforeCloseAbortedAt).toBeLessThan(2_000);
      expect(existsSync(`/proc/${childPid}`)).toBe(false);

      const duringHashMarker = join(root, "during-post-hash.pid");
      const duringHashController = new AbortController();
      let announcePostHash!: () => void;
      const postHashEntered = new Promise<void>((resolvePromise) => { announcePostHash = resolvePromise; });
      let releasePostHash: (() => void) | undefined;
      const duringHashRun = runBoundBlindToolForTest(
        tool,
        ["exit", duringHashMarker],
        duringHashController.signal,
        {
          postCloseRevalidate: async (_boundTool, signal) => {
            announcePostHash();
            await new Promise<void>((resolvePromise, rejectPromise) => {
              const cleanup = () => signal.removeEventListener("abort", onAbort);
              const onAbort = () => {
                cleanup();
                rejectPromise(new BlindEvaluationConflictError(
                  "Die Post-Close-Vollhashphase sah den gebundenen AbortController.",
                ));
              };
              releasePostHash = () => {
                cleanup();
                resolvePromise();
              };
              signal.addEventListener("abort", onAbort, { once: true });
              if (signal.aborted) onAbort();
            });
          },
        },
      );
      await postHashEntered;
      duringHashController.abort();
      const duringHashOutcome = await Promise.race([
        duringHashRun.then(() => "resolved", () => "aborted"),
        new Promise<"timeout">((resolvePromise) => setTimeout(() => resolvePromise("timeout"), 1_000)),
      ]);
      expect(duringHashOutcome).toBe("aborted");
      releasePostHash?.();

      const beforeResolveMarker = join(root, "before-resolution.pid");
      const beforeResolveController = new AbortController();
      let announceBeforeResolve!: () => void;
      const beforeResolveEntered = new Promise<void>((resolvePromise) => { announceBeforeResolve = resolvePromise; });
      let releaseBeforeResolve!: () => void;
      const beforeResolveRun = runBoundBlindToolForTest(
        tool,
        ["exit", beforeResolveMarker],
        beforeResolveController.signal,
        {
          beforeFinalResolution: async () => {
            announceBeforeResolve();
            await new Promise<void>((resolvePromise) => { releaseBeforeResolve = resolvePromise; });
          },
        },
      );
      await beforeResolveEntered;
      beforeResolveController.abort();
      releaseBeforeResolve();
      await expect(beforeResolveRun).rejects.toThrow(/abgebrochen/iu);
    } finally {
      closeSync(tool.fd);
    }
  });

  it("SIGKILLs an in-flight normalization child when its AbortController fires", async () => {
    const subject = await fixture();
    await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const record = blindEvaluationRecordSchema.parse(JSON.parse(readFileSync(join(
      subject.sessionRoot,
      "v5",
      "sessions",
      SESSION_ID,
      "session.v5.json",
    ), "utf8")));
    const markerPath = join(subject.root, "fake-normalizer.pid");
    const fakeToolPath = join(subject.root, "fake-ffmpeg");
    writeFileSync(fakeToolPath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"-version\" ]; then echo 'ffmpeg version blind-v5-test'; exit 0; fi",
      `printf '%s\\n' "$$" > ${JSON.stringify(markerPath)}`,
      "exec sleep 30",
      "",
    ].join("\n"), { mode: 0o755 });
    chmodSync(fakeToolPath, 0o755);
    const tool = await openBoundBlindExecutable(fakeToolPath);
    const sourceFd = openSync(join(subject.outputRoot, subject.outputs[0].name), constants.O_RDONLY);
    const controller = new AbortController();
    const startedAt = Date.now();
    try {
      const normalization = runFfmpegNormalization(
        tool,
        record.commitmentPreimage.normalization,
        sourceFd,
        join(subject.root, "never-produced.mp4"),
        controller.signal,
      );
      await waitForCondition(() => existsSync(markerPath));
      const childPid = Number(readFileSync(markerPath, "utf8").trim());
      expect(Number.isSafeInteger(childPid)).toBe(true);
      controller.abort();
      await expect(normalization).rejects.toThrow(/abgebrochen|AbortController/iu);
      expect(Date.now() - startedAt).toBeLessThan(2_000);
      expect(existsSync(`/proc/${childPid}`)).toBe(false);
    } finally {
      closeSync(sourceFd);
      closeSync(tool.fd);
    }
  });

  it("yields during full-media hashing and SIGKILLs an abortable probe child promptly", async () => {
    const subject = await fixture();
    await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const profile = blindEvaluationRecordSchema.parse(JSON.parse(readFileSync(join(
      subject.sessionRoot,
      "v5",
      "sessions",
      SESSION_ID,
      "session.v5.json",
    ), "utf8"))).commitmentPreimage.normalization;
    const sparse = join(subject.root, "large-probe-input.mp4");
    writeFileSync(sparse, "", { mode: 0o600 });
    truncateSync(sparse, 512 * 1_024 * 1_024);
    const hashController = new AbortController();
    const hashStartedAt = Date.now();
    const hashing = probeBlindCanonicalSnapshot(
      sparse,
      profile,
      undefined,
      hashController.signal,
    );
    setTimeout(() => hashController.abort(), 0);
    await expect(hashing).rejects.toThrow(/abgebrochen/);
    expect(Date.now() - hashStartedAt).toBeLessThan(2_000);

    const markerPath = join(subject.root, "fake-probe.pid");
    const fakeProbePath = join(subject.root, "fake-ffprobe");
    writeFileSync(fakeProbePath, [
      "#!/bin/sh",
      "if [ \"$1\" = \"-version\" ]; then echo 'ffprobe version blind-v5-test'; exit 0; fi",
      `printf '%s\\n' "$$" > ${JSON.stringify(markerPath)}`,
      "exec sleep 30",
      "",
    ].join("\n"), { mode: 0o755 });
    chmodSync(fakeProbePath, 0o755);
    const realFfmpeg = await openBoundBlindExecutable(
      realpathSync(execFileSync("which", ["ffmpeg"], { encoding: "utf8" }).trim()),
    );
    const fakeProbe = await openBoundBlindExecutable(fakeProbePath);
    const probeController = new AbortController();
    try {
      const probing = probeBlindCanonicalSnapshot(
        join(subject.sessionRoot, "v5", "sessions", SESSION_ID, "x.snapshot.v5.mp4"),
        profile,
        { ffmpeg: realFfmpeg, ffprobe: fakeProbe },
        probeController.signal,
      );
      await waitForCondition(() => existsSync(markerPath));
      const childPid = Number(readFileSync(markerPath, "utf8").trim());
      const probeStartedAt = Date.now();
      probeController.abort();
      await expect(probing).rejects.toThrow(/abgebrochen/);
      expect(Date.now() - probeStartedAt).toBeLessThan(2_000);
      expect(existsSync(`/proc/${childPid}`)).toBe(false);
    } finally {
      closeSync(realFfmpeg.fd);
      closeSync(fakeProbe.fd);
    }
  });

  it("publishes canonical equal-size MP4 snapshots in a fresh v5 namespace without public length leaks", async () => {
    const subject = await fixture();
    const compromisedV2 = join(subject.sessionRoot, "f731c675-31ce-4982-9989-c7383b4582a0.session.v2.json");
    writeFileSync(compromisedV2, "intentionally invalid and never readable by v5");
    const compromisedBefore = readFileSync(compromisedV2);

    const active = await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    expect(active).toMatchObject({
      schemaVersion: "ltx-studio-blind-evaluation-public.v5",
      id: SESSION_ID,
      status: "active",
      reveal: null,
      evaluatorScope: { role: "blind-evaluator", transport: "httponly-samesite-strict-session-cookie" },
      requirements: { bothAudioRequired: true, transportProfile: "canonical-private-mp4.v5" },
    });
    const publicJson = JSON.stringify(active);
    expect(publicJson).not.toContain(CREDENTIAL);
    expect(publicJson).not.toContain(subject.outputs[0].name);
    expect(publicJson).not.toContain(subject.outputs[1].name);
    expect(publicJson).not.toContain(BASELINE_JOB_ID);
    expect(publicJson).not.toContain('"baseline"');
    expect(publicJson).not.toContain('"sizeBytes"');
    expect(readFileSync(compromisedV2)).toEqual(compromisedBefore);
    await expect(subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT))
      .rejects.toThrow("niemals neu ausgegeben");

    const recordPath = join(subject.sessionRoot, "v5", "sessions", SESSION_ID, "session.v5.json");
    expect(statSync(recordPath).mode & 0o777).toBe(0o400);
    expect(existsSync(join(subject.sessionRoot, `${SESSION_ID}.session.v2.json`))).toBe(false);
    const record = blindEvaluationRecordSchema.parse(JSON.parse(readFileSync(recordPath, "utf8")));
    expect(record.commitment).toBe(blindEvaluationCommitment(record));
    expect(record.commitmentPreimage.normalization).toMatchObject({
      program: "ffmpeg",
      containerProfile: "h264-high51-aac-lc-isom-cbr-measured.v5",
      fillerProfile: "iso-bmff-explicit-mdat-private-reconstruction.v2",
      target: {
        width: 1_280,
        height: 1_280,
        framesPerSecond: 25,
        frameCount: 24,
        durationSeconds: 0.96,
        videoCodec: "h264",
        audioCodec: "aac",
      },
    });
    expect(record.commitmentPreimage.tools.ffmpeg.version).toMatch(/^ffmpeg version /);
    expect(record.commitmentPreimage.tools.ffprobe.version).toMatch(/^ffprobe version /);
    expect(record.commitmentPreimage.arms.baseline.outputName).toBe(subject.outputs[0].name);
    expect(record.commitmentPreimage.arms.candidate.outputName).toBe(subject.outputs[1].name);
    const snapshots = record.commitmentPreimage.snapshots;
    expect(record.privateState.snapshotRevisions.x.sizeBytes).toBe(record.privateState.snapshotRevisions.y.sizeBytes);
    expect(record.privateState.finalSizeBytes % BLIND_EVALUATION_PADDING_BUCKET_BYTES).toBe(0);
    expect(record.commitmentPreimage.snapshots.x.normalizedSizeBytes).toBeGreaterThan(0);

    for (const [index, channel] of (["x", "y"] as const).entries()) {
      const snapshotPath = join(subject.sessionRoot, "v5", "sessions", SESSION_ID, `${channel}.snapshot.v5.mp4`);
      expect(statSync(snapshotPath).mode & 0o777).toBe(0o400);
      expect(hashFile(snapshotPath)).toBe(snapshots[channel].finalSnapshotSha256);
      const probe = await probeBlindCanonicalSnapshot(snapshotPath, record.commitmentPreimage.normalization);
      expect(probe.video).toMatchObject({ codec: "h264", profile: "High", width: 1_280, height: 1_280 });
      expect(probe.audio).toMatchObject({ codec: "aac", profile: "LC", sampleRate: "48000", channelLayout: "stereo" });
      const boxes = inspectBlindIsoBmffTopLevel(snapshotPath);
      expect(boxes.at(-1)).toMatchObject({ type: "mdat", extendsToEof: false });
      expect(boxes.at(-1)!.offset + boxes.at(-1)!.sizeBytes).toBe(statSync(snapshotPath).size);
      const finalBytes = readFileSync(snapshotPath);
      const strings = finalBytes.toString("latin1");
      expect(strings).not.toContain("private-baseline-metadata");
      expect(strings).not.toContain("private-candidate-metadata");
      expect(strings).not.toContain("private-red");
      expect(strings).not.toContain("private-blue");
      expect(strings).not.toContain("RAW-TIMECODE-SENTINEL");
      expect(strings).not.toContain("TimeCodeHandler");
      const reconstructed = Buffer.from(finalBytes.subarray(0, snapshots[channel].normalizedSizeBytes));
      Buffer.from(snapshots[channel].originalMdat.sizeHeaderHex, "hex")
        .copy(reconstructed, snapshots[channel].originalMdat.offsetBytes);
      expect(createHash("sha256").update(reconstructed).digest("hex"))
        .toBe(snapshots[channel].normalizedSha256);
      const sourcePath = join(subject.outputRoot, subject.outputs[index].name);
      const after = statSync(sourcePath);
      expect({
        sha256: hashFile(sourcePath),
        size: after.size,
        ino: after.ino,
        mtimeMs: after.mtimeMs,
        ctimeMs: after.ctimeMs,
      }).toEqual(subject.sourceBefore[index]);
    }
  });

  it("requires the private creation token together with the cookie and never reissues it after claim", async () => {
    const subject = await fixture();
    const creationRequestId = "5".repeat(64);
    const reserved = subject.store.reserve(subject.experiment, creationRequestId, CREATED_AT);
    expect(reserved.creationToken).toMatch(/^[0-9a-f]{64}$/);
    const creationToken = reserved.creationToken!;
    const reservationPath = join(
      subject.sessionRoot,
      "v5",
      "reservations",
      reserved.evaluation.id,
      "reservation.v5.json",
    );
    expect(readFileSync(reservationPath, "utf8")).not.toContain(creationToken);
    expect(() => subject.store.reserve(subject.experiment, creationRequestId, CREATED_AT))
      .toThrow(BlindEvaluationConflictError);
    const authenticatedRetry = subject.store.reserve(
      subject.experiment,
      creationRequestId,
      CREATED_AT,
      reserved.credential,
    );
    expect(authenticatedRetry).toMatchObject({ creationToken, credential: reserved.credential });

    let publicationOpens = 0;
    const countedProvider: BlindEvaluationPublishedOutputProvider = {
      outputs: subject.publishedOutputs.outputs,
      openPublishedOutput: (name, jobId) => {
        publicationOpens += 1;
        return subject.publishedOutputs.openPublishedOutput(name, jobId);
      },
    };
    await expect(subject.store.claim(
      reserved.evaluation.id,
      reserved.credential,
      "",
      subject.experiment,
      countedProvider,
    )).rejects.toMatchObject({ statusCode: 404 });
    await expect(subject.store.claim(
      reserved.evaluation.id,
      reserved.credential,
      "7".repeat(64),
      subject.experiment,
      countedProvider,
    )).rejects.toMatchObject({ statusCode: 404 });
    expect(publicationOpens).toBe(0);

    const secondId = "45454545-4545-4454-8454-454545454545";
    const secondCredential = "4".repeat(64);
    const secondStore = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot, {
      id: () => secondId,
      nonce: () => "3".repeat(64),
      credential: () => secondCredential,
      baselineFirst: () => false,
    });
    const second = secondStore.reserve(subject.experiment, "a".repeat(64), CREATED_AT);
    await expect(subject.store.claim(
      reserved.evaluation.id,
      reserved.credential,
      second.creationToken!,
      subject.experiment,
      countedProvider,
    )).rejects.toMatchObject({ statusCode: 404 });
    expect(publicationOpens).toBe(0);

    const active = await subject.store.claim(
      reserved.evaluation.id,
      reserved.credential,
      creationToken,
      subject.experiment,
      countedProvider,
    );
    expect(active.status).toBe("active");
    expect(publicationOpens).toBe(2);
    expect(JSON.stringify(active)).not.toContain(creationToken);
    expect(readFileSync(join(
      subject.sessionRoot,
      "v5",
      "sessions",
      reserved.evaluation.id,
      "session.v5.json",
    ), "utf8")).not.toContain(creationToken);
    expect(subject.store.reserve(
      subject.experiment,
      creationRequestId,
      CREATED_AT,
      reserved.credential,
    ).creationToken).toBeNull();
    await expect(subject.store.claim(
      reserved.evaluation.id,
      reserved.credential,
      "7".repeat(64),
      subject.experiment,
      countedProvider,
    )).rejects.toMatchObject({ statusCode: 404 });
    expect((await subject.store.claim(
      reserved.evaluation.id,
      reserved.credential,
      creationToken,
      subject.experiment,
      countedProvider,
    )).status).toBe("active");
    subject.store.abort(reserved.evaluation.id, reserved.credential);
    subject.store.abort(second.evaluation.id, second.credential);
  });

  it("uses one immutable cross-store creation-index winner for concurrent duplicate reservation", async () => {
    const subject = await fixture();
    const creationRequestId = "d".repeat(64);
    const winnerId = "56565656-5656-4565-8565-565656565656";
    const loserId = "67676767-6767-4676-8676-676767676767";
    const winnerCredential = "c".repeat(64);
    const loserCredential = "d".repeat(64);
    const winnerStore = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot, {
      id: () => winnerId,
      nonce: () => "1".repeat(64),
      credential: () => winnerCredential,
      baselineFirst: () => true,
    });
    let winner: ReturnType<BlindEvaluationStore["reserve"]> | null = null;
    const loserStore = new BlindEvaluationStore(
      subject.sessionRoot,
      subject.outputRoot,
      {
        id: () => loserId,
        nonce: () => "2".repeat(64),
        credential: () => loserCredential,
        baselineFirst: () => false,
      },
      undefined,
      (point) => {
        if (point === "before-creation-index" && !winner) {
          winner = winnerStore.reserve(subject.experiment, creationRequestId, CREATED_AT);
        }
      },
    );
    expect(() => loserStore.reserve(subject.experiment, creationRequestId, CREATED_AT))
      .toThrow(BlindEvaluationConflictError);
    expect(winner).toMatchObject({
      evaluation: { id: winnerId, status: "creating" },
      credential: winnerCredential,
    });
    const authenticated = loserStore.reserve(
      subject.experiment,
      creationRequestId,
      CREATED_AT,
      winnerCredential,
    );
    expect(authenticated).toEqual(winner);
    const reservations = readdirSync(join(subject.sessionRoot, "v5", "reservations"));
    expect(reservations).toEqual([winnerId]);
    expect(readdirSync(join(subject.sessionRoot, "v5", "creation-index"))).toEqual([
      `${creationRequestId}.v5.json`,
    ]);
    const otherExperiment = structuredClone(subject.experiment);
    otherExperiment.id = "78787878-7878-4787-8787-787878787878";
    otherExperiment.protocolSha256 = "e".repeat(64);
    expect(() => winnerStore.reserve(
      otherExperiment,
      creationRequestId,
      CREATED_AT,
      winnerCredential,
    )).toThrow(BlindEvaluationConflictError);
    winnerStore.abort(winnerId, winnerCredential);
  });

  it("serves X/Y with an identical validator-free HTTP contract, valid ranges and descriptor TOCTOU safety", async () => {
    const subject = await fixture();
    await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const fullX = await serveLease(subject.store.openMedia(SESSION_ID, "x", CREDENTIAL));
    const fullY = await serveLease(subject.store.openMedia(SESSION_ID, "y", CREDENTIAL));
    expect(fullX.status).toBe(200);
    expect(fullY.status).toBe(200);
    for (const name of ["accept-ranges", "cache-control", "content-disposition", "content-type", "content-length", "x-content-type-options"]) {
      expect(fullX.headers.get(name), name).toBe(fullY.headers.get(name));
    }
    expect(fullX.headers.get("content-type")).toContain("video/mp4");
    expect(fullX.headers.get("content-length")).toBe(String(BLIND_EVALUATION_PADDING_BUCKET_BYTES));
    expect(fullX.headers.get("etag")).toBeNull();
    expect(fullY.headers.get("etag")).toBeNull();
    expect(fullX.headers.get("last-modified")).toBeNull();
    expect(fullY.headers.get("last-modified")).toBeNull();
    expect(fullX.body).toHaveLength(BLIND_EVALUATION_PADDING_BUCKET_BYTES);
    expect(fullY.body).toHaveLength(BLIND_EVALUATION_PADDING_BUCKET_BYTES);

    const rangeX = await serveLease(subject.store.openMedia(SESSION_ID, "x", CREDENTIAL), "bytes=0-1023");
    const rangeY = await serveLease(subject.store.openMedia(SESSION_ID, "y", CREDENTIAL), "bytes=0-1023");
    expect(rangeX.status).toBe(206);
    expect(rangeY.status).toBe(206);
    expect(rangeX.headers.get("content-range")).toBe(rangeY.headers.get("content-range"));
    expect(rangeX.headers.get("content-length")).toBe("1024");

    const snapshotPath = join(subject.sessionRoot, "v5", "sessions", SESSION_ID, "x.snapshot.v5.mp4");
    const lease = subject.store.openMedia(SESSION_ID, "x", CREDENTIAL);
    const committedBytes = readFileSync(snapshotPath);
    unlinkSync(snapshotPath);
    writeFileSync(snapshotPath, "attacker-replacement", { mode: 0o400 });
    const descriptorResponse = await serveLease(lease, "bytes=2-9");
    expect(descriptorResponse.status).toBe(206);
    expect(descriptorResponse.body).toEqual(committedBytes.subarray(2, 10));
    const cachedResponse = await serveLease(
      subject.store.openMedia(SESSION_ID, "x", CREDENTIAL),
      "bytes=2-9",
    );
    expect(cachedResponse.body).toEqual(committedBytes.subarray(2, 10));
    const restarted = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
    expect(() => restarted.openMedia(SESSION_ID, "x", CREDENTIAL)).toThrow("nicht mehr unverändert");
  });

  it("serves only the anonymous verified bytes when the committed inode mutates during response delivery", async () => {
    const subject = await fixture();
    await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const snapshotPath = join(subject.sessionRoot, "v5", "sessions", SESSION_ID, "x.snapshot.v5.mp4");
    const lease = subject.store.openMedia(SESSION_ID, "x", CREDENTIAL);
    const committedBytes = readFileSync(snapshotPath);
    const before = statSync(snapshotPath);
    const response = await serveLease(lease, "bytes=0-1023", () => {
      chmodSync(snapshotPath, 0o600);
      const writable = openSync(snapshotPath, "r+");
      try {
        writeSync(writable, Buffer.from([0x7f]), 0, 1, 512);
      } finally {
        closeSync(writable);
      }
      utimesSync(snapshotPath, before.atime, before.mtime);
      chmodSync(snapshotPath, 0o400);
    });
    expect(response.status).toBe(206);
    expect(response.body).toEqual(committedBytes.subarray(0, 1_024));
    const cachedResponse = await serveLease(
      subject.store.openMedia(SESSION_ID, "x", CREDENTIAL),
      "bytes=0-1023",
    );
    expect(cachedResponse.body).toEqual(committedBytes.subarray(0, 1_024));
    const restarted = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
    expect(() => restarted.openMedia(SESSION_ID, "x", CREDENTIAL)).toThrow("nicht mehr unverändert");
  });

  it("reuses one read-only sealed media cache and bounds tiny ranges, concurrency and request count", async () => {
    const subject = await fixture();
    await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const first = subject.store.openMedia(SESSION_ID, "x", CREDENTIAL);
    const second = subject.store.openMedia(SESSION_ID, "x", CREDENTIAL);
    expect(first.expectedRevision.fileId).toBe(second.expectedRevision.fileId);
    expect(() => writeSync(first.fd, Buffer.from([0]), 0, 1, 0)).toThrow();
    closeSync(first.fd);
    closeSync(second.fd);

    const held = Array.from({ length: 4 }, () => subject.store.openMedia(SESSION_ID, "x", CREDENTIAL));
    for (const lease of held) lease.reserveResponseBytes(1);
    const concurrent = subject.store.openMedia(SESSION_ID, "x", CREDENTIAL);
    expect(() => concurrent.reserveResponseBytes(1)).toThrow(/Budget|erschöpft/);
    concurrent.releaseResponse();
    closeSync(concurrent.fd);
    for (const lease of held) {
      lease.releaseResponse();
      closeSync(lease.fd);
    }

    for (let index = 4; index < 128; index += 1) {
      const lease = subject.store.openMedia(SESSION_ID, "x", CREDENTIAL);
      lease.reserveResponseBytes(1);
      lease.releaseResponse();
      closeSync(lease.fd);
    }
    const exhausted = subject.store.openMedia(SESSION_ID, "x", CREDENTIAL);
    expect(() => exhausted.reserveResponseBytes(1)).toThrow(/Budget|erschöpft/);
    exhausted.releaseResponse();
    closeSync(exhausted.fd);
  });

  it("keeps the media byte budget across cache replacement and process-style store restart", async () => {
    const subject = await fixture();
    await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const consumeCacheBudget = (store: BlindEvaluationStore) => {
      for (let index = 0; index < 8; index += 1) {
        const lease = store.openMedia(SESSION_ID, "x", CREDENTIAL);
        lease.reserveResponseBytes(lease.sizeBytes);
        lease.releaseResponse();
        closeSync(lease.fd);
      }
    };
    consumeCacheBudget(subject.store);
    const restarted = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
    consumeCacheBudget(restarted);
    const restartedAgain = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
    const exhausted = restartedAgain.openMedia(SESSION_ID, "x", CREDENTIAL);
    expect(() => exhausted.reserveResponseBytes(exhausted.sizeBytes))
      .toThrow(/restartübergreifende.*Budget|Budget.*erschöpft/);
    exhausted.releaseResponse();
    closeSync(exhausted.fd);
    expect(readdirSync(join(
      subject.sessionRoot,
      "v5",
      "sessions",
      SESSION_ID,
      "media-budget.v5",
    ))).toHaveLength(16);
  });

  it("rejects extra data/timecode tracks and a GOP that differs from the requested profile", async () => {
    const subject = await fixture();
    await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const record = blindEvaluationRecordSchema.parse(JSON.parse(readFileSync(
      join(subject.sessionRoot, "v5", "sessions", SESSION_ID, "session.v5.json"),
      "utf8",
    )));
    const original = join(subject.sessionRoot, "v5", "sessions", SESSION_ID, "x.snapshot.v5.mp4");
    const extraTrack = join(subject.root, "extra-timecode.mp4");
    execFileSync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", original,
      "-map", "0", "-c", "copy", "-timecode", "01:00:00:00",
      "-movflags", "+faststart", "-brand", "isom", extraTrack,
    ], { timeout: 30_000, stdio: "pipe" });
    await expect(probeBlindCanonicalSnapshot(extraTrack, record.commitmentPreimage.normalization))
      .rejects.toThrow(/zusätz|Stream|timecode|kanonisch/i);

    const gop12 = join(subject.root, "gop12.mp4");
    const args = [...record.commitmentPreimage.normalization.argsTemplate].map((value) => value
      .replaceAll("{source-fd}", join(subject.outputRoot, subject.outputs[0].name))
      .replaceAll("{target}", gop12)
      .replaceAll("{frame-count}", String(record.commitmentPreimage.normalization.target.frameCount))
      .replaceAll("{duration}", record.commitmentPreimage.normalization.target.durationSeconds.toFixed(6)));
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "-g" || args[index] === "-keyint_min") args[index + 1] = "12";
      if (args[index] === "-x264-params") {
        args[index + 1] = args[index + 1]!
          .replaceAll("keyint=50", "keyint=12")
          .replaceAll("min-keyint=50", "min-keyint=12");
      }
    }
    execFileSync("ffmpeg", args, { timeout: 30_000, stdio: "pipe" });
    await expect(probeBlindCanonicalSnapshot(gop12, record.commitmentPreimage.normalization))
      .rejects.toThrow(/GOP|Keyframe|keyint/i);
  });

  it("rejects range amplification, non-MP4, missing audio and oversized inputs", async () => {
    const multi = await fixture();
    await multi.store.create(multi.experiment, multi.publishedOutputs, CREATED_AT);
    const multiResponse = await serveLease(
      multi.store.openMedia(SESSION_ID, "x", CREDENTIAL),
      "bytes=0-1,4-5",
    );
    expect(multiResponse.status).toBe(416);
    expect(multiResponse.headers.get("content-range")).toBe(`bytes */${BLIND_EVALUATION_PADDING_BUCKET_BYTES}`);

    const stored = blindEvaluationRecordSchema.parse(JSON.parse(readFileSync(
      join(multi.sessionRoot, "v5", "sessions", SESSION_ID, "session.v5.json"),
      "utf8",
    )));
    expect(blindEvaluationMediaBindingSchema.safeParse({
      ...stored.commitmentPreimage.arms.baseline,
      outputName: "forbidden-source.webm",
    }).success).toBe(false);

    const noAudio = await fixture();
    noAudio.outputs[1].analysis!.result!.technical.hasAudio = false;
    await expect(noAudio.store.create(noAudio.experiment, noAudio.publishedOutputs)).rejects.toThrow("bestätigte Audiospur");

    const bounded = await fixture(8);
    await expect(bounded.store.create(bounded.experiment, bounded.publishedOutputs))
      .rejects.toThrow(BlindEvaluationConflictError);
  });

  it("binds submit and a fully self-consistent reveal to the initial browser pin", async () => {
    const subject = await fixture();
    const active = await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const pin = await pinFor(active);
    await accessBoth(subject);
    const wrongPin = { ...pin, publicStateSha256: "7".repeat(64) };
    await expect(subject.store.submit(
      SESSION_ID,
      CREDENTIAL,
      validSubmission(),
      wrongPin,
      subject.experiment,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:02:04.000Z",
    )).rejects.toMatchObject({ statusCode: 412 });
    const revealed = await subject.store.submit(
      SESSION_ID,
      CREDENTIAL,
      validSubmission(),
      pin,
      subject.experiment,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:02:07.000Z",
    );
    expect(revealed.status).toBe("submitted");
    const submissionPin = revealed.status === "submitted"
      ? revealed.reveal.submissionPreimage.browserSubmissionPin
      : null;
    expect(await verifyBlindEvaluationReveal(revealed, pin, submissionPin)).toMatchObject({ valid: true });
    if (revealed.status !== "submitted") throw new Error("Reveal fehlt");

    const swapped = structuredClone(revealed);
    const swappedId = "12121212-1212-4212-8212-121212121212";
    swapped.id = swappedId;
    swapped.reveal.commitmentPreimage.sessionId = swappedId;
    swapped.commitment = digest(swapped.reveal.commitmentPreimage);
    swapped.media.x = `/api/blind-evaluations/${swappedId}/media/x`;
    swapped.media.y = `/api/blind-evaluations/${swappedId}/media/y`;
    swapped.reveal.submissionPreimage.sessionId = swappedId;
    swapped.reveal.submissionPreimage.commitment = swapped.commitment;
    const swappedPin = await pinFor({ ...swapped, status: "active", reveal: null });
    swapped.reveal.submissionPreimage.initialPublicStateSha256 = swappedPin.publicStateSha256;
    const swappedSubmissionPin = await createBlindEvaluationSubmissionPin(
      swapped.reveal.submissionPreimage.submission,
      swappedPin,
      swapped.reveal.submissionPreimage.idempotencyKey,
      swapped.reveal.submissionPreimage.browserSubmissionPin.pinnedAt,
    );
    swapped.reveal.submissionPreimage.browserSubmissionPin = swappedSubmissionPin;
    swapped.reveal.submissionPreimage.submissionInputSha256 = swappedSubmissionPin.submissionInputSha256;
    swapped.reveal.submissionSha256 = digest(swapped.reveal.submissionPreimage);
    expect(await verifyBlindEvaluationReveal(swapped, swappedPin, swappedSubmissionPin)).toMatchObject({ valid: true });
    expect(await verifyBlindEvaluationReveal(swapped, pin, submissionPin)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([expect.stringContaining("Browser-Pin")]),
    });

    const renamed = structuredClone(revealed);
    renamed.reveal.commitmentPreimage.arms.baseline.outputName = "tampered-output.mp4";
    expect(await verifyBlindEvaluationReveal(renamed, pin, submissionPin)).toMatchObject({ valid: false });
  });

  it("requires both independent audible playback arms and minimum wall time", async () => {
    const subject = await fixture();
    const active = await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const pin = await pinFor(active);
    expect(() => subject.store.openMedia(SESSION_ID, "x", "7".repeat(64))).toThrow("nicht gefunden");
    await expect(subject.store.submit(
      SESSION_ID, CREDENTIAL, validSubmission(), pin, subject.experiment, IDEMPOTENCY_KEY,
    )).rejects.toThrow("Beide privaten v5-Blind-Snapshots");
    await accessBoth(subject);
    await expect(subject.store.submit(
      SESSION_ID, CREDENTIAL, validSubmission(), pin, subject.experiment, IDEMPOTENCY_KEY,
      "2026-08-25T12:02:06.759Z",
    )).rejects.toThrow("Mindestprüfzeit von 5.8 Sekunden");
    const insufficient = validSubmission();
    insufficient.playback.y.audibleHalfSpeed = summarizeBlindPlaybackCoverage(
      [{ startMilliseconds: 0, endMilliseconds: 470 }],
      960,
      true,
    );
    await expect(subject.store.submit(
      SESSION_ID, CREDENTIAL, insufficient, pin, subject.experiment, IDEMPOTENCY_KEY,
      "2026-08-25T12:02:07.000Z",
    )).rejects.toThrow(BlindEvaluationConflictError);
  });

  it("counts unique timeline coverage so repeated loops and seek-to-end jumps cannot satisfy review", async () => {
    const subject = await fixture();
    const active = await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const pin = await pinFor(active);
    await accessBoth(subject);

    const looped = validSubmission();
    looped.playback.x.normalSpeed = summarizeBlindPlaybackCoverage(
      Array.from({ length: 20 }, () => ({ startMilliseconds: 0, endMilliseconds: 200 })),
      960,
      true,
    );
    expect(looped.playback.x.normalSpeed).toMatchObject({
      intervals: [{ startMilliseconds: 0, endMilliseconds: 200 }],
      uniqueCoverageMilliseconds: 200,
    });
    await expect(subject.store.submit(
      SESSION_ID, CREDENTIAL, looped, pin, subject.experiment, IDEMPOTENCY_KEY,
      "2026-08-25T12:02:07.000Z",
    )).rejects.toThrow(BlindEvaluationConflictError);

    const seeked = validSubmission();
    seeked.playback.y.halfSpeed = summarizeBlindPlaybackCoverage([
      { startMilliseconds: 0, endMilliseconds: 20 },
      { startMilliseconds: 940, endMilliseconds: 960 },
    ], 960, true);
    await expect(subject.store.submit(
      SESSION_ID, CREDENTIAL, seeked, pin, subject.experiment, IDEMPOTENCY_KEY,
      "2026-08-25T12:02:08.000Z",
    )).rejects.toThrow(BlindEvaluationConflictError);

    const complete = await subject.store.submit(
      SESSION_ID, CREDENTIAL, validSubmission(), pin, subject.experiment, IDEMPOTENCY_KEY,
      "2026-08-25T12:02:09.000Z",
    );
    expect(complete.status).toBe("submitted");
  });

  it("resolves publish-versus-abort with one immutable creation outcome and quarantines interrupted intent", async () => {
    const cancelled = await fixture();
    const cancelId = "89898989-8989-4898-8989-898989898989";
    const cancelCredential = "8".repeat(64);
    const cancelCompetitor = new BlindEvaluationStore(cancelled.sessionRoot, cancelled.outputRoot);
    const cancellingStore = new BlindEvaluationStore(
      cancelled.sessionRoot,
      cancelled.outputRoot,
      {
        id: () => cancelId,
        nonce: () => "1".repeat(64),
        credential: () => cancelCredential,
        baselineFirst: () => true,
      },
      undefined,
      (point) => {
        if (point === "before-publish") {
          cancelCompetitor.abort(cancelId, cancelCredential, "2026-08-25T12:01:30.000Z");
        }
      },
    );
    const cancelReservation = cancellingStore.reserve(cancelled.experiment, "1".repeat(64), CREATED_AT);
    await expect(cancellingStore.claim(
      cancelId,
      cancelCredential,
      cancelReservation.creationToken!,
      cancelled.experiment,
      cancelled.publishedOutputs,
    )).rejects.toThrow(BlindEvaluationConflictError);
    expect(existsSync(join(cancelled.sessionRoot, "v5", "sessions", cancelId))).toBe(false);
    expect(existsSync(join(
      cancelled.sessionRoot,
      "v5",
      "revocations",
      `${cancelId}.reservation-revocation.v5.json`,
    ))).toBe(true);
    expect(cancellingStore.hasActiveSession()).toBe(false);

    const published = await fixture();
    const publishId = "90909090-9090-4909-8909-909090909090";
    const publishCredential = "9".repeat(64);
    const publishCompetitor = new BlindEvaluationStore(published.sessionRoot, published.outputRoot);
    let abortAfterIntent: unknown = null;
    const publishingStore = new BlindEvaluationStore(
      published.sessionRoot,
      published.outputRoot,
      {
        id: () => publishId,
        nonce: () => "2".repeat(64),
        credential: () => publishCredential,
        baselineFirst: () => false,
      },
      undefined,
      (point) => {
        if (point === "after-publish-intent") {
          try {
            publishCompetitor.abort(publishId, publishCredential, "2026-08-25T12:01:31.000Z");
          } catch (error) {
            abortAfterIntent = error;
          }
        }
      },
    );
    const publishReservation = publishingStore.reserve(published.experiment, "2".repeat(64), CREATED_AT);
    const active = await publishingStore.claim(
      publishId,
      publishCredential,
      publishReservation.creationToken!,
      published.experiment,
      published.publishedOutputs,
    );
    expect(active.status).toBe("active");
    expect(abortAfterIntent).toBeInstanceOf(BlindEvaluationConflictError);
    publishingStore.abort(publishId, publishCredential);

    const interrupted = await fixture();
    const interruptedId = "91919191-9191-4919-8919-919191919191";
    const interruptedCredential = "a".repeat(64);
    const interruptedStore = new BlindEvaluationStore(
      interrupted.sessionRoot,
      interrupted.outputRoot,
      {
        id: () => interruptedId,
        nonce: () => "3".repeat(64),
        credential: () => interruptedCredential,
        baselineFirst: () => true,
      },
      undefined,
      (point) => {
        if (point === "after-publish-intent") throw new Error("synthetic crash after durable publish intent");
      },
    );
    const interruptedReservation = interruptedStore.reserve(interrupted.experiment, "3".repeat(64), CREATED_AT);
    const recoveredPublish = await interruptedStore.claim(
      interruptedId,
      interruptedCredential,
      interruptedReservation.creationToken!,
      interrupted.experiment,
      interrupted.publishedOutputs,
    );
    expect(recoveredPublish).toMatchObject({ id: interruptedId, status: "active" });
    expect(existsSync(join(interrupted.sessionRoot, "v5", "sessions", interruptedId))).toBe(true);
    expect(interruptedStore.hasActiveSession()).toBe(true);
    interruptedStore.abort(interruptedId, interruptedCredential);
  });

  it("protects a live publish owner and promotes its verified intent after a real SIGKILL", async () => {
    const subject = await fixture();
    await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const sessionsRoot = join(subject.sessionRoot, "v5", "sessions");
    const reservationsRoot = join(subject.sessionRoot, "v5", "reservations");
    const finalDirectory = join(sessionsRoot, SESSION_ID);
    const stagingDirectory = join(
      sessionsRoot,
      `.staging-${SESSION_ID}-34343434-3434-4434-8434-343434343434`,
    );
    const reservationDirectory = join(reservationsRoot, SESSION_ID);
    const record = blindEvaluationRecordSchema.parse(JSON.parse(readFileSync(
      join(finalDirectory, "session.v5.json"),
      "utf8",
    )));
    const readyPath = join(subject.root, "publish-child.ready");
    const childConfigPath = join(subject.root, "publish-child.json");
    writeFileSync(childConfigPath, JSON.stringify({
      sessionsRoot,
      reservationsRoot,
      finalDirectory,
      stagingDirectory,
      reservationDirectory,
      readyPath,
      reservation: {
        schemaVersion: "ltx-studio-blind-evaluation-reservation.v5",
        id: SESSION_ID,
        experimentId: subject.experiment.id,
        protocolSha256: subject.experiment.protocolSha256,
        creationRequestId: record.creationRequestId,
        evaluatorScopeCredential: CREDENTIAL,
        evaluatorScopeCredentialSha256: record.commitmentPreimage.evaluatorScopeCredentialSha256,
        creationTokenSha256: record.commitmentPreimage.creationTokenSha256,
        lockNonce: record.privateState.lockNonce,
        createdAt: record.commitmentPreimage.createdAt,
      },
      claim: {
        schemaVersion: "ltx-studio-blind-evaluation-claim.v5",
        id: SESSION_ID,
        creationTokenSha256: record.commitmentPreimage.creationTokenSha256,
        claimedAt: "2026-08-25T12:01:30.000Z",
      },
      outcome: {
        schemaVersion: "ltx-studio-blind-evaluation-creation-outcome.v5",
        id: SESSION_ID,
        outcome: "publish",
        recordSha256: digest(record),
        decidedAt: "2026-08-25T12:01:31.000Z",
      },
    }), { mode: 0o400 });
    const crashChildScript = String.raw`
      const fs = require("node:fs");
      const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const proc = fs.readFileSync("/proc/" + process.pid + "/stat", "utf8");
      const fieldsAfterComm = proc.slice(proc.lastIndexOf(") ") + 2).trim().split(/\s+/);
      const owner = {
        pid: process.pid,
        processStartTicks: fieldsAfterComm[19],
        instanceId: "a".repeat(64),
      };
      const immutable = (path, value) => {
        const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o400);
        try {
          fs.writeFileSync(fd, JSON.stringify(value));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      };
      fs.renameSync(config.finalDirectory, config.stagingDirectory);
      const sessionsFd = fs.openSync(config.sessionsRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      fs.fsyncSync(sessionsFd); fs.closeSync(sessionsFd);
      fs.mkdirSync(config.reservationDirectory, { mode: 0o700 });
      immutable(config.reservationDirectory + "/reservation.v5.json", { ...config.reservation, owner });
      immutable(config.reservationDirectory + "/claim.v5.json", { ...config.claim, owner });
      immutable(config.reservationDirectory + "/creation-outcome.v5.json", config.outcome);
      const reservationFd = fs.openSync(config.reservationDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      fs.fsyncSync(reservationFd); fs.closeSync(reservationFd);
      const reservationsFd = fs.openSync(config.reservationsRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
      fs.fsyncSync(reservationsFd); fs.closeSync(reservationsFd);
      immutable(config.readyPath, { pid: process.pid });
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", crashChildScript, childConfigPath], {
      stdio: "ignore",
    });
    try {
      await waitForCondition(() => existsSync(readyPath));
      const liveRestart = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
      expect(existsSync(stagingDirectory)).toBe(true);
      expect(liveRestart.get(SESSION_ID, CREDENTIAL)).toMatchObject({
        status: "creating",
        creation: { phase: "claimed" },
      });
      expect(child.kill("SIGKILL")).toBe(true);
      await new Promise<void>((resolvePromise, rejectPromise) => {
        child.once("close", (_code, signal) => signal === "SIGKILL"
          ? resolvePromise()
          : rejectPromise(new Error(`Crash-Child endete unerwartet mit ${String(signal)}.`)));
        child.once("error", rejectPromise);
      });
      const recovered = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
      expect(existsSync(stagingDirectory)).toBe(false);
      expect(existsSync(finalDirectory)).toBe(true);
      expect(recovered.get(SESSION_ID, CREDENTIAL)).toMatchObject({ id: SESSION_ID, status: "active" });
      expect(readdirSync(join(subject.sessionRoot, "v5", "quarantine"))).toHaveLength(0);
      expect(recovered.reserve(
        subject.experiment,
        record.creationRequestId,
        CREATED_AT,
        CREDENTIAL,
      )).toMatchObject({ evaluation: { id: SESSION_ID, status: "active" }, creationToken: null });
      recovered.abort(SESSION_ID, CREDENTIAL);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("aborts running normalization promptly and cleans its lock and private staging", async () => {
    const subject = await fixture();
    const creationRequestId = "e".repeat(64);
    const reserved = subject.store.reserve(subject.experiment, creationRequestId, CREATED_AT);
    const competitor = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
    const claim = subject.store.claim(
      reserved.evaluation.id,
      reserved.credential,
      reserved.creationToken!,
      subject.experiment,
      subject.publishedOutputs,
    );
    const sessionsRoot = join(subject.sessionRoot, "v5", "sessions");
    await waitForCondition(() => readdirSync(sessionsRoot).some(
      (name) => name.startsWith(`.staging-${reserved.evaluation.id}-`),
    ));
    const abortedAt = Date.now();
    competitor.abort(
      reserved.evaluation.id,
      reserved.credential,
      "2026-08-25T12:01:30.000Z",
    );
    await expect(claim).rejects.toThrow(BlindEvaluationConflictError);
    expect(Date.now() - abortedAt).toBeLessThan(3_000);
    expect(readdirSync(sessionsRoot).some(
      (name) => name.startsWith(`.staging-${reserved.evaluation.id}-`),
    )).toBe(false);
    expect(existsSync(join(subject.sessionRoot, "v5", "global-lock.v5.json"))).toBe(false);
    expect(existsSync(join(
      subject.sessionRoot,
      "v5",
      "revocations",
      `${reserved.evaluation.id}.reservation-revocation.v5.json`,
    ))).toBe(true);
  });

  it("finishes an EEXIST lock-release CAS after link-before-unlink crash and never unlinks a foreign new lock", async () => {
    const subject = await fixture();
    let crashRelease = true;
    const faultingStore = new BlindEvaluationStore(
      subject.sessionRoot,
      subject.outputRoot,
      {
        id: () => SESSION_ID,
        nonce: () => "9".repeat(64),
        credential: () => CREDENTIAL,
        baselineFirst: () => true,
      },
      undefined,
      (point) => {
        if (point === "after-lock-release-link" && crashRelease) {
          crashRelease = false;
          throw new Error("synthetic crash after retained release link");
        }
      },
    );
    const active = await faultingStore.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const pin = await pinFor(active);
    const x = faultingStore.openMedia(SESSION_ID, "x", CREDENTIAL, "2026-08-25T12:02:00.000Z");
    const y = faultingStore.openMedia(SESSION_ID, "y", CREDENTIAL, "2026-08-25T12:02:01.000Z");
    x.reserveResponseBytes(1);
    y.reserveResponseBytes(1);
    x.releaseResponse();
    y.releaseResponse();
    closeSync(x.fd);
    closeSync(y.fd);
    await expect(faultingStore.submit(
      SESSION_ID,
      CREDENTIAL,
      validSubmission(),
      pin,
      subject.experiment,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:02:07.000Z",
    )).rejects.toThrow("synthetic crash after retained release link");
    const globalLockPath = join(subject.sessionRoot, "v5", "global-lock.v5.json");
    expect(statSync(globalLockPath).nlink).toBe(2);
    const releaseRoot = join(subject.sessionRoot, "v5", "lock-releases");
    const releaseMarker = readdirSync(releaseRoot).find((name) => name.endsWith(".released.v5.json"));
    expect(releaseMarker).toBeDefined();
    expect(statSync(join(releaseRoot, releaseMarker!)).nlink).toBe(2);

    const recovered = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
    expect(existsSync(globalLockPath)).toBe(false);
    expect(statSync(join(releaseRoot, releaseMarker!)).nlink).toBe(1);
    expect(recovered.get(SESSION_ID, CREDENTIAL).status).toBe("submitted");

    const nextId = "92929292-9292-4929-8929-929292929292";
    const nextCredential = "b".repeat(64);
    const nextStore = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot, {
      id: () => nextId,
      nonce: () => "4".repeat(64),
      credential: () => nextCredential,
      baselineFirst: () => false,
    });
    const next = await nextStore.create(
      subject.experiment,
      subject.publishedOutputs,
      "2026-08-25T12:04:00.000Z",
      "4".repeat(64),
    );
    expect(next.status).toBe("active");
    const foreignBefore = statSync(globalLockPath);
    expect(() => (recovered as unknown as { releaseGlobalLock: (id: string) => void })
      .releaseGlobalLock(SESSION_ID)).toThrow(BlindEvaluationConflictError);
    const retry = await recovered.submit(
      SESSION_ID,
      CREDENTIAL,
      validSubmission(),
      pin,
      subject.experiment,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:05:00.000Z",
    );
    expect(retry.status).toBe("submitted");
    expect(statSync(globalLockPath).ino).toBe(foreignBefore.ino);
    expect(nextStore.get(nextId, nextCredential).status).toBe("active");
    nextStore.abort(nextId, nextCredential);
  });

  it("preserves a live reservation but revokes dead unclaimed and claimed owners on restart", async () => {
    const unclaimed = await fixture();
    const creationRequestId = "a".repeat(64);
    const reservation = unclaimed.store.reserve(unclaimed.experiment, creationRequestId, CREATED_AT);
    const liveRestart = new BlindEvaluationStore(unclaimed.sessionRoot, unclaimed.outputRoot);
    expect(liveRestart.get(reservation.evaluation.id, reservation.credential)).toMatchObject({
      status: "creating",
      creation: { phase: "reserved" },
    });
    const reservationPath = join(
      unclaimed.sessionRoot,
      "v5",
      "reservations",
      reservation.evaluation.id,
      "reservation.v5.json",
    );
    const deadReservation = JSON.parse(readFileSync(reservationPath, "utf8")) as {
      owner: { pid: number; processStartTicks: string; instanceId: string };
    };
    deadReservation.owner = { pid: 2_000_000_000, processStartTicks: "1", instanceId: "0".repeat(64) };
    chmodSync(reservationPath, 0o600);
    writeFileSync(reservationPath, JSON.stringify(deadReservation));
    chmodSync(reservationPath, 0o400);
    const deadRestart = new BlindEvaluationStore(unclaimed.sessionRoot, unclaimed.outputRoot);
    expect(() => deadRestart.get(reservation.evaluation.id, reservation.credential))
      .toThrow(BlindEvaluationConflictError);
    expect(existsSync(join(
      unclaimed.sessionRoot,
      "v5",
      "revocations",
      `${reservation.evaluation.id}.reservation-revocation.v5.json`,
    ))).toBe(true);
    expect(() => deadRestart.reserve(
      unclaimed.experiment,
      creationRequestId,
      CREATED_AT,
      reservation.credential,
    )).toThrow(BlindEvaluationConflictError);

    const claimed = await fixture();
    const claimedReservation = claimed.store.reserve(claimed.experiment, "b".repeat(64), CREATED_AT);
    const claimedDirectory = join(
      claimed.sessionRoot,
      "v5",
      "reservations",
      claimedReservation.evaluation.id,
    );
    const claimedReservationPath = join(claimedDirectory, "reservation.v5.json");
    const claimedRaw = JSON.parse(readFileSync(claimedReservationPath, "utf8")) as {
      evaluatorScopeCredentialSha256: string;
      creationTokenSha256: string;
      lockNonce: string;
      createdAt: string;
      owner: { pid: number; processStartTicks: string; instanceId: string };
    };
    const deadOwner = { pid: 2_000_000_000, processStartTicks: "1", instanceId: "f".repeat(64) };
    claimedRaw.owner = deadOwner;
    chmodSync(claimedReservationPath, 0o600);
    writeFileSync(claimedReservationPath, JSON.stringify(claimedRaw));
    chmodSync(claimedReservationPath, 0o400);
    const claimPath = join(claimedDirectory, "claim.v5.json");
    writeFileSync(claimPath, JSON.stringify({
      schemaVersion: "ltx-studio-blind-evaluation-claim.v5",
      id: claimedReservation.evaluation.id,
      creationTokenSha256: claimedRaw.creationTokenSha256,
      claimedAt: CREATED_AT,
      owner: deadOwner,
    }), { mode: 0o400 });
    chmodSync(claimPath, 0o400);
    const outcomePath = join(claimedDirectory, "creation-outcome.v5.json");
    writeFileSync(outcomePath, JSON.stringify({
      schemaVersion: "ltx-studio-blind-evaluation-creation-outcome.v5",
      id: claimedReservation.evaluation.id,
      outcome: "publish",
      recordSha256: "f".repeat(64),
      decidedAt: CREATED_AT,
    }), { mode: 0o400 });
    chmodSync(outcomePath, 0o400);
    const globalLockPath = join(claimed.sessionRoot, "v5", "global-lock.v5.json");
    writeFileSync(globalLockPath, JSON.stringify({
      schemaVersion: "ltx-studio-blind-evaluation-global-lock.v5",
      sessionId: claimedReservation.evaluation.id,
      evaluatorScopeCredentialSha256: claimedRaw.evaluatorScopeCredentialSha256,
      lockNonce: claimedRaw.lockNonce,
      createdAt: claimedRaw.createdAt,
    }), { mode: 0o400 });
    chmodSync(globalLockPath, 0o400);
    const staging = join(
      claimed.sessionRoot,
      "v5",
      "sessions",
      `.staging-${claimedReservation.evaluation.id}-34343434-3434-4434-8434-343434343434`,
    );
    await mkdir(staging, { recursive: true });
    writeFileSync(join(staging, "partial"), "synthetic interrupted publish");
    const claimedRestart = new BlindEvaluationStore(claimed.sessionRoot, claimed.outputRoot);
    expect(existsSync(staging)).toBe(false);
    expect(readdirSync(join(claimed.sessionRoot, "v5", "quarantine")))
      .toHaveLength(1);
    expect(existsSync(globalLockPath)).toBe(false);
    expect(existsSync(join(
      claimed.sessionRoot,
      "v5",
      "revocations",
      `${claimedReservation.evaluation.id}.reservation-revocation.v5.json`,
    ))).toBe(true);
    expect(claimedRestart.hasActiveSession()).toBe(false);
  });

  it("fails closed for missing publication authority and turns a real corrupt disk lock into 423", async () => {
    const missingPublication = await fixture();
    const reservation = missingPublication.store.reserve(
      missingPublication.experiment,
      "c".repeat(64),
      CREATED_AT,
    );
    let publicationAttempts = 0;
    await expect(missingPublication.store.claim(
      reservation.evaluation.id,
      reservation.credential,
      reservation.creationToken!,
      missingPublication.experiment,
      {
        outputs: missingPublication.outputs,
        openPublishedOutput: () => { publicationAttempts += 1; return null; },
      },
    )).rejects.toThrow(BlindEvaluationConflictError);
    expect(publicationAttempts).toBe(2);
    expect(existsSync(join(
      missingPublication.sessionRoot,
      "v5",
      "sessions",
      reservation.evaluation.id,
    ))).toBe(false);

    const corrupt = await fixture();
    const globalLockPath = join(corrupt.sessionRoot, "v5", "global-lock.v5.json");
    writeFileSync(globalLockPath, "{synthetic-corrupt-lock", { mode: 0o400 });
    chmodSync(globalLockPath, 0o400);
    for (const path of ["/api/jobs", "/api/outputs"]) {
      const gate = evaluateBlindV5ApiGate({
        path,
        method: "GET",
        capabilityCookiePresent: false,
        readGlobalLock: () => corrupt.store.hasActiveSession(),
      });
      expect(gate).toMatchObject({ locked: true, rejection: { status: 423 } });
    }
    let wrongMethodLockReads = 0;
    expect(evaluateBlindV5ApiGate({
      path: `/api/blind-evaluations/${SESSION_ID}/media/x`,
      method: "HEAD",
      capabilityCookiePresent: true,
      readGlobalLock: () => { wrongMethodLockReads += 1; return corrupt.store.hasActiveSession(); },
    }).rejection).toMatchObject({ status: 405 });
    expect(wrongMethodLockReads).toBe(0);
  });

  it("allows exactly one atomic terminal outcome for parallel submit versus abort and never reissues it", async () => {
    const subject = await fixture();
    const active = await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const pin = await pinFor(active);
    await accessBoth(subject);
    const competing = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => subject.store.submit(
        SESSION_ID, CREDENTIAL, validSubmission(), pin, subject.experiment, IDEMPOTENCY_KEY,
        "2026-08-25T12:02:07.000Z",
      )),
      Promise.resolve().then(() => competing.abort(SESSION_ID, CREDENTIAL, "2026-08-25T12:02:07.000Z")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const terminalPath = join(subject.sessionRoot, "v5", "sessions", SESSION_ID, "terminal.v5.json");
    const before = statSync(terminalPath);
    expect(before.mode & 0o777).toBe(0o400);
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8")) as { outcome: "submitted" | "revoked" };
    if (terminal.outcome === "submitted") {
      expect(subject.store.get(SESSION_ID, CREDENTIAL).status).toBe("submitted");
      expect(() => competing.abort(SESSION_ID, CREDENTIAL)).toThrow("terminal abgeschlossen");
    } else {
      expect(() => subject.store.get(SESSION_ID, CREDENTIAL)).toThrow("nicht gefunden");
      await expect(subject.store.submit(
        SESSION_ID, CREDENTIAL, validSubmission(), pin, subject.experiment, IDEMPOTENCY_KEY,
        "2026-08-25T12:03:00.000Z",
      )).rejects.toThrow("nicht gefunden");
    }
    expect(statSync(terminalPath).ino).toBe(before.ino);

    const replacementId = "abababab-abab-4bab-8bab-abababababab";
    const replacement = new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot, {
      id: () => replacementId,
      nonce: () => "a".repeat(64),
      credential: () => "b".repeat(64),
      baselineFirst: () => false,
    });
    const next = await replacement.create(subject.experiment, subject.publishedOutputs, "2026-08-25T12:04:00.000Z");
    expect(next.id).toBe(replacementId);
    expect(next.commitment).not.toBe(active.commitment);
  });

  it("returns the same durable reveal for an identical submit retry and rejects a changed retry", async () => {
    const subject = await fixture();
    const active = await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const pin = await pinFor(active);
    await accessBoth(subject);
    const submission = validSubmission();
    const browserSubmissionPin = await createBlindEvaluationSubmissionPin(
      submission,
      pin,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:02:06.000Z",
    );
    await expect(subject.store.submit(
      SESSION_ID, CREDENTIAL, { ...submission, note: "Mutation vor dem ersten POST" }, pin,
      subject.experiment, IDEMPOTENCY_KEY, "2026-08-25T12:02:07.000Z", browserSubmissionPin,
    )).rejects.toMatchObject({ statusCode: 412 });
    const first = await subject.store.submit(
      SESSION_ID, CREDENTIAL, submission, pin, subject.experiment, IDEMPOTENCY_KEY,
      "2026-08-25T12:02:07.000Z", browserSubmissionPin,
    );
    const retry = await subject.store.submit(
      SESSION_ID, CREDENTIAL, submission, pin, subject.experiment, IDEMPOTENCY_KEY,
      "2026-08-25T12:03:00.000Z", browserSubmissionPin,
    );
    expect(retry).toEqual(first);
    expect(first.status).toBe("submitted");
    if (first.status !== "submitted") throw new Error("Reveal fehlt");
    expect(await verifyBlindEvaluationReveal(first, pin, browserSubmissionPin)).toMatchObject({ valid: true });
    await expect(subject.store.submit(
      SESSION_ID, CREDENTIAL, { ...submission, note: "anderer Retry" }, pin,
      subject.experiment, IDEMPOTENCY_KEY, "2026-08-25T12:03:01.000Z", browserSubmissionPin,
    )).rejects.toMatchObject({ statusCode: 412 });
  });

  it("rejects an oversized but schema-valid submission before terminal write and preserves the active lock", async () => {
    const subject = await fixture();
    const active = await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const pin = await pinFor(active);
    await accessBoth(subject);
    const fragmentedCoverage = summarizeBlindPlaybackCoverage(
      Array.from({ length: 96 }, (_, index) => ({
        startMilliseconds: index * 10,
        endMilliseconds: index * 10 + 9,
      })),
      960,
      true,
    );
    const oversized = validSubmission();
    oversized.note = "x".repeat(2_000);
    for (const channel of ["x", "y"] as const) {
      oversized.playback[channel].normalSpeed = structuredClone(fragmentedCoverage);
      oversized.playback[channel].halfSpeed = structuredClone(fragmentedCoverage);
      oversized.playback[channel].audibleNormalSpeed = structuredClone(fragmentedCoverage);
      oversized.playback[channel].audibleHalfSpeed = structuredClone(fragmentedCoverage);
    }
    const oversizedPin = await createBlindEvaluationSubmissionPin(
      oversized,
      pin,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:02:06.000Z",
    );
    const terminalPath = join(subject.sessionRoot, "v5", "sessions", SESSION_ID, "terminal.v5.json");
    await expect(subject.store.submit(
      SESSION_ID,
      CREDENTIAL,
      oversized,
      pin,
      subject.experiment,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:02:07.000Z",
      oversizedPin,
    )).rejects.toMatchObject({ statusCode: 412 });
    expect(existsSync(terminalPath)).toBe(false);
    expect(subject.store.hasActiveSession()).toBe(true);

    const retryKey = "7".repeat(64);
    const retry = validSubmission();
    const retryPin = await createBlindEvaluationSubmissionPin(
      retry,
      pin,
      retryKey,
      "2026-08-25T12:02:06.000Z",
    );
    const submitted = await subject.store.submit(
      SESSION_ID,
      CREDENTIAL,
      retry,
      pin,
      subject.experiment,
      retryKey,
      "2026-08-25T12:02:07.000Z",
      retryPin,
    );
    expect(submitted.status).toBe("submitted");
    expect(subject.store.hasActiveSession()).toBe(false);
  });

  it("rejects a cryptographically self-consistent reveal below the committed wall-time minimum", async () => {
    const subject = await fixture();
    const active = await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const pin = await pinFor(active);
    await accessBoth(subject);
    const submission = validSubmission();
    const submissionPin = await createBlindEvaluationSubmissionPin(
      submission,
      pin,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:02:06.000Z",
    );
    const submitted = await subject.store.submit(
      SESSION_ID,
      CREDENTIAL,
      submission,
      pin,
      subject.experiment,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:02:07.000Z",
      submissionPin,
    );
    if (submitted.status !== "submitted") throw new Error("Reveal fehlt");
    const tooFast = structuredClone(submitted);
    tooFast.reveal.submissionPreimage.mediaAccessedAt = {
      x: "2026-08-25T12:02:05.500Z",
      y: "2026-08-25T12:02:05.500Z",
    };
    tooFast.reveal.submissionSha256 = digest(tooFast.reveal.submissionPreimage);
    const verification = await verifyBlindEvaluationReveal(tooFast, pin, submissionPin);
    expect(verification.valid).toBe(false);
    expect(verification.errors).toContain(
      "Die aufgedeckte Abgabe unterschreitet die im Commitment gebundene Mindestprüfzeit.",
    );
  });

  it("enforces an explicit byte quota before creating any new reservation", async () => {
    const subject = await fixture();
    const quotaSentinel = join(subject.sessionRoot, "v5", "quarantine", "quota-sentinel.v5.bin");
    writeFileSync(quotaSentinel, "", { mode: 0o600 });
    truncateSync(quotaSentinel, BLIND_EVALUATION_STORAGE_MAX_BYTES);
    chmodSync(quotaSentinel, 0o400);
    expect(() => subject.store.reserve(subject.experiment, "f".repeat(64), CREATED_AT))
      .toThrow(/Speicherquote/);
    expect(readdirSync(join(subject.sessionRoot, "v5", "reservations"))).toHaveLength(0);
  });

  it("runs retention periodically in a long-lived store instead of only at construction", async () => {
    vi.useFakeTimers();
    try {
      const subject = await fixture();
      const sweep = vi.spyOn(subject.store, "enforceRetentionPolicy");
      await vi.advanceTimersByTimeAsync(15 * 60 * 1_000 + 1);
      expect(sweep).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("prewrites quarantine authority before rename and bounds legacy markerless directories without following symlinks", async () => {
    const subject = await fixture();
    const sessionsRoot = join(subject.sessionRoot, "v5", "sessions");
    const quarantineRoot = join(subject.sessionRoot, "v5", "quarantine");
    const orphanName = ".staging-12121212-1212-4212-8212-121212121212-34343434-3434-4434-8434-343434343434";
    const orphan = join(sessionsRoot, orphanName);
    await mkdir(orphan, { recursive: true });
    writeFileSync(join(orphan, "private.partial"), "synthetic private bytes", { mode: 0o600 });
    let renameFaultObserved = false;
    let markerPresentAtFault = false;
    new BlindEvaluationStore(
      subject.sessionRoot,
      subject.outputRoot,
      {
        id: () => SESSION_ID,
        nonce: () => "9".repeat(64),
        credential: () => CREDENTIAL,
        baselineFirst: () => true,
      },
      undefined,
      (point) => {
        if (point !== "after-quarantine-rename") return;
        renameFaultObserved = true;
        const entries = readdirSync(quarantineRoot);
        markerPresentAtFault = entries.length === 1
          && existsSync(join(quarantineRoot, entries[0]!, "quarantine.v5.json"));
        throw new Error("synthetic process crash immediately after quarantine rename");
      },
    );
    expect(renameFaultObserved).toBe(true);
    expect(markerPresentAtFault).toBe(true);
    expect(existsSync(orphan)).toBe(false);
    const crashedName = readdirSync(quarantineRoot)[0]!;
    const crashedMarker = join(quarantineRoot, crashedName, "quarantine.v5.json");
    expect(statSync(crashedMarker).mode & 0o777).toBe(0o400);
    const crashedRecord = JSON.parse(readFileSync(crashedMarker, "utf8")) as {
      quarantineName: string; quarantinedAt: string;
    };
    expect(crashedRecord.quarantineName).toBe(crashedName);

    const markerlessName = "legacy-markerless-private-v5";
    const markerless = join(quarantineRoot, markerlessName);
    await mkdir(markerless, { recursive: true });
    writeFileSync(join(markerless, "private.partial"), "legacy private bytes", { mode: 0o600 });
    const outside = join(subject.root, "outside-quarantine-target");
    await mkdir(outside, { recursive: true });
    writeFileSync(join(outside, "must-survive"), "outside", { mode: 0o600 });
    const hostileLink = join(quarantineRoot, "hostile-quarantine-link");
    symlinkSync(outside, hostileLink);

    const discoveredAt = Date.now();
    subject.store.enforceRetentionPolicy(discoveredAt);
    expect(existsSync(hostileLink)).toBe(false);
    expect(readFileSync(join(outside, "must-survive"), "utf8")).toBe("outside");
    const recoveredMarker = join(markerless, "quarantine.v5.json");
    expect(statSync(recoveredMarker).mode & 0o777).toBe(0o400);
    const recoveredRecord = JSON.parse(readFileSync(recoveredMarker, "utf8")) as {
      quarantineName: string; sessionId: null; stagingName: null; reason: string; quarantinedAt: string;
    };
    expect(recoveredRecord).toMatchObject({
      quarantineName: markerlessName,
      sessionId: null,
      stagingName: null,
      reason: "unmarked-quarantine",
    });

    const purgeAt = Math.max(
      Date.parse(crashedRecord.quarantinedAt),
      Date.parse(recoveredRecord.quarantinedAt),
    ) + BLIND_EVALUATION_QUARANTINE_RETENTION_MS + 1;
    subject.store.enforceRetentionPolicy(purgeAt);
    expect(existsSync(join(quarantineRoot, crashedName))).toBe(false);
    expect(existsSync(markerless)).toBe(false);
    expect(readFileSync(join(outside, "must-survive"), "utf8")).toBe("outside");
  });

  it("minimizes terminal credentials and private media, then compacts to hash-only retention evidence", async () => {
    const subject = await fixture();
    const active = await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const pin = await pinFor(active);
    await accessBoth(subject);
    const submission = validSubmission();
    const submissionPin = await createBlindEvaluationSubmissionPin(
      submission,
      pin,
      IDEMPOTENCY_KEY,
      "2026-08-25T12:02:06.000Z",
    );
    const submittedAt = "2026-08-25T12:02:07.000Z";
    const submitted = await subject.store.submit(
      SESSION_ID,
      CREDENTIAL,
      submission,
      pin,
      subject.experiment,
      IDEMPOTENCY_KEY,
      submittedAt,
      submissionPin,
    );
    expect(submitted.status).toBe("submitted");
    expect(await verifyBlindEvaluationReveal(submitted, pin, submissionPin)).toMatchObject({ valid: true });
    const sessionDirectory = join(subject.sessionRoot, "v5", "sessions", SESSION_ID);
    expect(existsSync(join(sessionDirectory, "x.snapshot.v5.mp4"))).toBe(false);
    expect(existsSync(join(sessionDirectory, "y.snapshot.v5.mp4"))).toBe(false);
    const terminalRaw = readFileSync(join(sessionDirectory, "terminal.v5.json"), "utf8");
    const recordRaw = readFileSync(join(sessionDirectory, "session.v5.json"), "utf8");
    expect(recordRaw).not.toContain(CREDENTIAL);
    expect(terminalRaw).not.toContain(CREDENTIAL);

    const compactAt = Date.parse(submittedAt) + BLIND_EVALUATION_TERMINAL_RETENTION_MS + 1;
    subject.store.enforceRetentionPolicy(compactAt);
    expect(existsSync(sessionDirectory)).toBe(false);
    const tombstonePath = join(
      subject.sessionRoot,
      "v5",
      "retention-tombstones",
      `${SESSION_ID}.retention-tombstone.v5.json`,
    );
    const tombstoneRaw = readFileSync(tombstonePath, "utf8");
    const tombstone = blindEvaluationRetentionTombstoneSchema.parse(JSON.parse(tombstoneRaw));
    expect(tombstone).toMatchObject({
      sessionId: SESSION_ID,
      outcome: "submitted",
      removedPrivateMedia: true,
      removedEvaluatorCredential: true,
      removedSubmissionContent: true,
    });
    expect(tombstoneRaw).not.toContain(CREDENTIAL);
    expect(tombstoneRaw).not.toContain(submission.note);
    expect(tombstoneRaw).not.toContain(subject.outputs[0].name);
    expect(Date.parse(tombstone.purgeAfter) - compactAt)
      .toBe(BLIND_EVALUATION_TOMBSTONE_RETENTION_MS);
    subject.store.enforceRetentionPolicy(Date.parse(tombstone.purgeAfter) + 1);
    expect(existsSync(tombstonePath)).toBe(false);
  });

  it("recovers only v5 staging orphans and fails closed for mutable records", async () => {
    const subject = await fixture();
    const orphan = join(
      subject.sessionRoot,
      "v5",
      "sessions",
      ".staging-12121212-1212-4212-8212-121212121212-34343434-3434-4434-8434-343434343434",
    );
    await mkdir(orphan, { recursive: true });
    writeFileSync(join(orphan, "partial"), "synthetic crash");
    new BlindEvaluationStore(subject.sessionRoot, subject.outputRoot);
    expect(existsSync(orphan)).toBe(false);
    expect(readdirSync(join(subject.sessionRoot, "v5", "quarantine"))).toHaveLength(1);
    subject.store.enforceRetentionPolicy(
      Date.now() + BLIND_EVALUATION_QUARANTINE_RETENTION_MS + 1_000,
    );
    expect(readdirSync(join(subject.sessionRoot, "v5", "quarantine"))).toHaveLength(0);
    await subject.store.create(subject.experiment, subject.publishedOutputs, CREATED_AT);
    const recordPath = join(subject.sessionRoot, "v5", "sessions", SESSION_ID, "session.v5.json");
    const recordBackup = join(subject.root, "session-backup.v5.json");
    renameSync(recordPath, recordBackup);
    symlinkSync(recordBackup, recordPath);
    expect(() => subject.store.get(SESSION_ID, CREDENTIAL)).toThrow(BlindEvaluationConflictError);
    unlinkSync(recordPath);
    renameSync(recordBackup, recordPath);
    const extraLink = join(subject.root, "session-extra-link.v5.json");
    linkSync(recordPath, extraLink);
    expect(() => subject.store.get(SESSION_ID, CREDENTIAL)).toThrow(BlindEvaluationConflictError);
    unlinkSync(extraLink);
    const stored = JSON.parse(readFileSync(recordPath, "utf8")) as {
      commitmentPreimage: { arms: { baseline: { outputName: string } } };
    };
    stored.commitmentPreimage.arms.baseline.outputName = "changed-name.mp4";
    chmodSync(recordPath, 0o600);
    writeFileSync(recordPath, JSON.stringify(stored));
    expect(() => subject.store.get(SESSION_ID, CREDENTIAL)).toThrow(BlindEvaluationConflictError);
  });
});
