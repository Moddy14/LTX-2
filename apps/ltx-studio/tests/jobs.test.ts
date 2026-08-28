import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLipForcingAudioRetimeArgs,
  buildRefinerAudioArgs,
  describeLipForcingFailure,
  isActiveJobStatus,
  frameProcessLogChunk,
  genericLtxBaseReuseAllowed,
  DEVELOPMENT_LIPFORCING_RAW_OUTPUT_SURFACE_ID,
  DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS,
  DGX_OWNER_HEARTBEAT_INTERVAL_MS,
  DGX_OWNER_NO_PROGRESS_TIMEOUT_MS,
  jobSurfaceEntryId,
  JobConflictError,
  JobManager,
  JobPersistenceHoldError,
  MAX_ACTIVE_JOBS,
  OWNED_DOCKER_THERMAL_WORKLOADS,
  openBoundExecutable,
  PipelineProgressTracker,
  progressFromPipelineLog,
  positivePromptCandidateEnvironmentError,
  publishedOutputIsReusableLtxBase,
  publishedOutputIsReusableLipForcingVisual,
  quarantineRestoredUnpublishedArtifact,
  quarantineUnreleasedArtifact,
  runProvenanceSharesLtxBase,
  runProvenanceUsesExactLipForcingImage,
  requestsShareLtxBase,
  requestsShareLipForcingVisual,
  resolveRenderOutputPaths,
  validPositivePromptExperimentBinding,
  validRawOutputExperimentBinding,
  validRequestBoundExperimentBinding,
  type StudioJob,
} from "../server/jobs.js";
import { ltxResourceTelemetryMeasurementBlockers } from "../server/ltxResourceTelemetryEvidence.js";
import type {
  LocalProcessResourceObserverIdentity,
  LocalProcessResourceTelemetrySummary,
} from "../server/localProcessResourceTelemetry.js";
import { hybridRoot, outputRoot, repoRoot, thermalPollIntervalMs } from "../server/config.js";
import { notApplicableIdentityEvidence } from "../server/inputEvidence.js";
import { NATIVE_RUNTIME_SOURCE_CONTRACTS } from "../server/nativeRuntimeSourceGate.js";
import {
  outputPublicationPath,
  removeOutputPublicationAuthority,
} from "../server/outputPublication.js";
import { bindRunExecutionDecision } from "../server/runProvenance.js";
import {
  captureLipForcingImageIdentity,
  LIPFORCING_IMAGE_ARTIFACT_PATHS,
  LIPFORCING_IMAGE_PATCH_SET_ID,
  LIPFORCING_IMAGE_SOURCE_REVISION,
} from "../server/dockerImageIdentity.js";
import { canonicalizeJson, canonicalJson } from "../shared/canonicalJson.js";
import {
  PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
  PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
} from "../shared/healthPublic.js";
import { isLegacyDfrRequest } from "../shared/pipelines.js";
import {
  executionDescriptorThreatModel,
  type CpuAudioRetimeReuseSourceBinding,
  type CpuFfmpegOperation,
  type CpuPairedArtifactPromotionOperation,
  type CpuPairedArtifactReuseSourceBinding,
  type CpuReuseSourceBinding,
  type ExecutionFileBinding,
  type ExecutionFileRevision,
  type JobExecutionDecision,
} from "../shared/jobExecution.js";
import type { RunProvenance } from "../shared/provenance.js";
import {
  recommendedModelAsset,
  recommendedModelAssets,
  withOfficialSpeechModelPaths,
  type ModelInventory,
} from "../shared/models.js";
import { RuntimeApiError } from "../server/runtimeApi.js";
import { dgxRuntimeRequestSha256 } from "../server/dgxRequestDigest.js";
import {
  buildAdmissionRequests,
  type AdmissionRequest,
  QueueAdmissionState,
  QueueJobState,
  QueueJobSummary,
  QueueListResponse,
  QueueLockLaneSummary,
  QueueTransitionState,
} from "../server/admission.js";
import { projectValueSha256 } from "../server/projectStore.js";
import { experimentRequestSha256V1 } from "../server/experimentDigest.js";
import { ExperimentStore } from "../server/experimentStore.js";
import { reconcileExperimentsBeforeServerStart } from "../server/startupExperimentReconciliation.js";
import { bootstrapJobStartEnforcer } from "../server/startEnforcer.js";
import { validLtx25SplitRequest, validRequest } from "./fixtures.js";
import { publishCompletedOutputFixture } from "./output-publication-fixture.js";

const roots: string[] = [];

/**
 * Keep DGX contract fixtures deterministic and recognizable while satisfying
 * the exact public Runtime API identity grammar.
 */
function testDgxJobId(label: string): string {
  const suffix = createHash("sha256").update(label).digest("hex").slice(0, 12);
  return `dgx-job-20260827-120000-${suffix}`;
}

function dgxCaller(studioJobId: string): string {
  return `ltx-studio:${studioJobId}`;
}

function exactDgxRequestSha256(request: AdmissionRequest): string {
  const digest = dgxRuntimeRequestSha256(request);
  if (digest === null) throw new Error("test AdmissionRequest is not canonically digestible");
  return digest;
}

function boundDgxJob(
  studioJobId: string,
  dgxJobId: string,
  state: QueueJobState,
  overrides: Partial<QueueJobSummary> = {},
): QueueJobSummary {
  const caller = dgxCaller(studioJobId);
  return {
    job_id: dgxJobId,
    state,
    requested_by: caller,
    source_app: "LTX Studio",
    job_type: "ltx2_native_two_stage",
    runtime: "ltx2_native",
    priority: "normal",
    exclusive_runtime: "ltx2_native",
    created_at: new Date().toISOString(),
    started_at: null,
    durable_waiter: true,
    segment_waiter: true,
    reservation_active: state === "accepted",
    idempotency_key: caller,
    ...overrides,
  };
}

function boundDgxRead(studioJobId: string, dgxJobId: string, state: QueueJobState) {
  return {
    schema_version: "dgx-job-read.v0" as const,
    job: boundDgxJob(studioJobId, dgxJobId, state),
  };
}

function boundDgxTransition(studioJobId: string, dgxJobId: string, state: QueueJobState) {
  return {
    schema_version: "dgx-job-transition.v0" as const,
    transition_applied: true as const,
    job: boundDgxJob(studioJobId, dgxJobId, state),
  };
}

function boundDgxHeartbeat(studioJobId: string, dgxJobId: string, state: QueueJobState) {
  return {
    schema_version: "dgx-job-heartbeat.v0" as const,
    heartbeat_applied: true as const,
    job: boundDgxJob(studioJobId, dgxJobId, state),
  };
}

const STATE_SENSITIVE_DGX_TRANSITIONS: Partial<
  Record<QueueJobState, ReadonlySet<QueueTransitionState>>
> = {
  accepted: new Set(["starting", "cancelled"]),
  queued: new Set(["starting", "cancelled"]),
  starting: new Set(["running", "failed"]),
  running: new Set(["pausing", "completed", "failed", "cancelled"]),
  pausing: new Set(["paused", "failed"]),
  paused: new Set(["resuming", "cancelled"]),
  resuming: new Set(["running", "failed"]),
};

function applyStateSensitiveDgxTransition(
  current: QueueJobState,
  requested: QueueTransitionState,
): QueueJobState {
  if (current === requested && !["completed", "failed", "cancelled"].includes(current)) {
    return current;
  }
  if (!STATE_SENSITIVE_DGX_TRANSITIONS[current]?.has(requested)) {
    throw new Error(`invalid transition ${current} -> ${requested}`);
  }
  return requested;
}

function dgxJobIdentityFromAdmission(
  admissionRequest: AdmissionRequest,
): Partial<QueueJobSummary> {
  return {
    requested_by: admissionRequest.requested_by,
    source_app: admissionRequest.source_app,
    job_type: admissionRequest.job_type,
    runtime: admissionRequest.runtime,
    priority: admissionRequest.priority,
    exclusive_runtime: admissionRequest.resource_profile.exclusive_runtime,
    idempotency_key: admissionRequest.idempotency_key,
    durable_waiter: admissionRequest.scheduling?.mode === "segmented",
    segment_waiter: admissionRequest.scheduling?.mode === "segmented",
  };
}

function boundDgxSubmit(
  studioJobId: string,
  dgxJobId: string,
  state: QueueJobState = "accepted",
  admissionRequest?: AdmissionRequest,
) {
  return {
    schema_version: "dgx-queue-submit.v0" as const,
    job: boundDgxJob(
      studioJobId,
      dgxJobId,
      state,
      admissionRequest ? dgxJobIdentityFromAdmission(admissionRequest) : {},
    ),
    admission: { decision: state === "rejected" ? "rejected" : "accepted" },
  };
}

function boundDgxReplay(
  studioJobId: string,
  dgxJobId: string,
  state: QueueJobState,
  admissionRequest: AdmissionRequest,
  observedCreatedAt: string,
  retryAfterSeconds = 30,
) {
  const response = boundDgxSubmit(
    studioJobId,
    dgxJobId,
    state,
    admissionRequest,
  );
  response.job.created_at = observedCreatedAt;
  if (state === "accepted") response.job.reservation_active = false;
  return {
    ...response,
    admission: {
      ...response.admission,
      decision: state === "queued" ? "queued" : response.admission.decision,
      idempotent_replay: true as const,
      replay_bound_job_id: dgxJobId,
      retry_after_seconds: retryAfterSeconds,
    },
  };
}

function queueListJobHint(
  studioJobId: string,
  dgxJobId: string,
  state: QueueJobState,
  overrides: Partial<QueueJobSummary> = {},
): QueueJobSummary {
  return boundDgxJob(studioJobId, dgxJobId, state, overrides);
}

function queueListJobHintForAdmission(
  studioJobId: string,
  dgxJobId: string,
  state: QueueJobState,
  admissionRequest: AdmissionRequest,
  overrides: Partial<QueueJobSummary> = {},
): QueueJobSummary {
  return boundDgxJob(studioJobId, dgxJobId, state, {
    ...dgxJobIdentityFromAdmission(admissionRequest),
    ...overrides,
  });
}

function authoritativeQueueList(
  jobs: QueueJobSummary[] = [],
  overrides: {
    queueReadable?: boolean;
    admissionState?: QueueAdmissionState;
    lockLane?: QueueLockLaneSummary;
    discardedJobLikeEntries?: number;
    discardedCoolingEntries?: number;
  } = {},
): QueueListResponse {
  return {
    schemaVersion: "dgx-queue-read.v0",
    jobs,
    queueReadable: true,
    admissionState: "local_queue_v0",
    lockLane: { state: "free", waiters: 0 },
    ...overrides,
  };
}

function testDgxLeaseReceipt(
  studioJobId: string,
  dgxJobId: string,
  request = validRequest(),
) {
  const [preparedAdmission] = buildAdmissionRequests(request, 58, studioJobId);
  const caller = dgxCaller(studioJobId);
  const observedNow = Date.now();
  return {
    schemaVersion: "ltx-studio-dgx-lease-receipt.v1" as const,
    studioJobId,
    dgxJobId,
    requestedBy: caller,
    sourceApp: "LTX Studio" as const,
    idempotencyKey: caller,
    preparedAdmission,
    preparedAdmissionSha256: createHash("sha256")
      .update(canonicalJson(preparedAdmission))
      .digest("hex"),
    submitStartedAt: new Date(observedNow - 2).toISOString(),
    observedState: "accepted" as const,
    observedCreatedAt: new Date(observedNow - 1).toISOString(),
    evidence: {
      kind: "submit-response" as const,
      schemaVersion: "dgx-queue-submit.v0" as const,
    },
    confirmedAt: new Date(observedNow).toISOString(),
  };
}

function bindTestDgxLease(
  job: Record<string, unknown>,
  studioJobId: string,
  dgxJobId: string,
  request = validRequest(),
): void {
  job.dgxJobId = dgxJobId;
  job.dgxLeaseReceipt = testDgxLeaseReceipt(studioJobId, dgxJobId, request);
}

function bindActiveTestDgxLease(
  manager: JobManager,
  studioJobId: string,
  dgxJobId: string,
): Record<string, unknown> {
  const job = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
    .get(studioJobId)!;
  job.status = "running";
  bindTestDgxLease(
    job,
    studioJobId,
    dgxJobId,
    job.request as ReturnType<typeof validRequest>,
  );
  return job;
}

function bindTestPendingDgxSubmit(
  job: Record<string, unknown>,
  studioJobId: string,
  request = validRequest(),
  submitStartedAt = new Date().toISOString(),
): void {
  const [preparedAdmission] = buildAdmissionRequests(request, 58, studioJobId);
  job.dgxJobId = null;
  job.dgxSubmitPending = true;
  job.dgxSubmitStartedAt = submitStartedAt;
  job.dgxPreparedAdmission = preparedAdmission;
  job.dgxPreparedAdmissionSha256 = createHash("sha256")
    .update(canonicalJson(preparedAdmission))
    .digest("hex");
}

function verifiedModelInventory(): ModelInventory {
  return {
    roots: [],
    scannedAt: new Date(0).toISOString(),
    truncated: false,
    errors: [],
    items: [],
    recommendations: recommendedModelAssets.map((asset) => ({
      ...asset,
      present: true,
      integrity: "verified" as const,
    })),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-jobs-"));
  roots.push(root);
  return join(root, "jobs.json");
}

function runProvenance(
  overrides: {
    modelSha?: string;
    runtimeSha?: string;
    codeSha?: string;
    verified?: boolean;
    includeLongCat?: boolean;
    includeFinalMix?: boolean;
  } = {},
): RunProvenance {
  const file = (role: string, sha256: string) => ({
    role,
    path: `/evidence/${role.replaceAll(":", "-")}`,
    kind: "file" as const,
    sizeBytes: 1,
    modifiedAtMs: 1,
    changedAtMs: 1,
    fileId: "1",
    sha256,
    entries: [],
  });
  return {
    schemaVersion: "ltx-studio-run-provenance.v1",
    capturedAt: "2026-07-25T00:00:00.000Z",
    verifiedAt: overrides.verified === false ? null : "2026-07-25T00:01:00.000Z",
    files: [
      file("model:checkpoint:1", overrides.modelSha ?? "a".repeat(64)),
      ...(overrides.includeLongCat ? [file("code:longcat-adapter", "d".repeat(64))] : []),
      ...(overrides.includeFinalMix ? [file("input:final-audio-mix", "e".repeat(64))] : []),
    ],
    code: [{
      repositoryRoot: repoRoot,
      commit: "a".repeat(40),
      dirty: false,
      trackedDiffSha256: "b".repeat(64),
      untracked: [],
      fingerprint: overrides.codeSha ?? "c".repeat(64),
    }],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "test",
      nodeVersion: "test",
      pythonExecutable: "/python",
      pythonVersion: "test",
      packages: {},
      ffmpegVersion: "test",
      fingerprint: overrides.runtimeSha ?? "f".repeat(64),
    },
    fingerprint: "0".repeat(64),
  };
}

function testLipForcingContainerIdentity(imageHex = "a") {
  const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
  const rawOutputMux = Buffer.from("def mux_video_with_audio():\n    return 'test'\n");
  const containerRunner = Buffer.from("# verified container runner\n");
  const loader = Buffer.from("# patched loader\n");
  const common = Buffer.from("# patched common\n");
  const faceDetector = Buffer.from("# patched face detector\n");
  const license = Buffer.from("Apache License 2.0 fixture\n");
  const runtimePatchProvenance = Buffer.from(JSON.stringify({
    schemaVersion: "ltx-studio-lipforcing-runtime-patch.v1",
    patchSetId: LIPFORCING_IMAGE_PATCH_SET_ID,
    upstream: {
      repository: "https://github.com/cvlab-kaist/LipForcing",
      commit: LIPFORCING_IMAGE_SOURCE_REVISION,
      license: { path: "LICENSE", sha256: sha256(license), spdx: "Apache-2.0" },
    },
    patchedFiles: [
      { path: "scripts/inference/_loader.py", patchedSha256: sha256(loader) },
      { path: "scripts/inference/_common.py", patchedSha256: sha256(common) },
      { path: "OmniAvatar/utils/latentsync/face_detector.py", patchedSha256: sha256(faceDetector) },
    ],
    localArtifacts: [
      {
        path: "raw_output_mux.py",
        sha256: sha256(rawOutputMux),
        role: "paired-premux-export-and-legacy-audio-mux",
      },
      {
        path: "lipforcing-runner.py",
        sha256: sha256(containerRunner),
        role: "verified-offline-container-entrypoint",
      },
    ],
  }));
  const copied = new Map<string, Buffer>([
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[0], rawOutputMux],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[1], runtimePatchProvenance],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[2], loader],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[3], common],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[4], faceDetector],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[5], license],
    [LIPFORCING_IMAGE_ARTIFACT_PATHS[6], containerRunner],
  ]);
  const imageId = `sha256:${imageHex.repeat(64)}`;
  return captureLipForcingImageIdentity("ltx-studio-lipforcing:test", {
    inspect: () => ({
      id: imageId,
      repoDigests: [],
      labels: {
        "org.opencontainers.image.revision": LIPFORCING_IMAGE_SOURCE_REVISION,
        "com.moddy.ltx-studio.lipforcing.patchset": LIPFORCING_IMAGE_PATCH_SET_ID,
      },
    }),
    copyArtifacts: () => new Map([...copied].map(([path, bytes]) => [path, Buffer.from(bytes)])),
  }, { rawOutputMux, containerRunner, runtimePatchProvenance });
}

const testRunProvenanceOperations = {
  capture: async () => runProvenance(),
  verify: async (evidence: RunProvenance) => ({ evidence, error: null }),
};

function ownedDockerFixture(
  name: string,
  dgxJobId: string,
  options: {
    exists?: boolean;
    containerId?: string;
    paused?: boolean;
    failStop?: boolean;
    failRemove?: boolean;
    sourceAppLabel?: string;
    dgxJobLabel?: string;
  } = {},
) {
  let exists = options.exists !== false;
  const containerId = options.containerId ?? "d".repeat(64);
  let paused = options.paused === true;
  let running = true;
  const commands: string[][] = [];
  const operations = {
    run: (rawArgs: readonly string[]) => {
      const args = [...rawArgs];
      commands.push(args);
      if (args[0] === "container" && args[1] === "inspect") {
        const inspectTarget = args.at(-1)!;
        if (!exists) {
          return {
            status: 1,
            stdout: "",
            stderr: `Error response from daemon: No such container: ${inspectTarget}`,
            error: null,
          };
        }
        if (inspectTarget !== name && inspectTarget !== containerId) {
          return {
            status: 1,
            stdout: "",
            stderr: `Error response from daemon: No such container: ${inspectTarget}`,
            error: null,
          };
        }
        return {
          status: 0,
          stdout: JSON.stringify({
            Id: containerId,
            Name: `/${name}`,
            Config: {
              Labels: {
                "dgx.source_app": options.sourceAppLabel ?? "ltx-studio",
                "dgx.job": options.dgxJobLabel ?? dgxJobId,
                "dgx.runtime": "ltx2_native",
              },
            },
            State: { Paused: paused, Running: running },
          }),
          stderr: "",
          error: null,
        };
      }
      if (args.at(-1) !== containerId) {
        return { status: 2, stdout: "", stderr: "mutation did not target immutable ID", error: null };
      }
      if (args[0] === "pause") paused = true;
      else if (args[0] === "unpause") paused = false;
      else if (args[0] === "stop") {
        if (options.failStop) {
          return { status: 1, stdout: "", stderr: "synthetic stop failure", error: null };
        }
        exists = false;
        paused = false;
        running = false;
      } else if (args[0] === "rm" && args[1] === "-f") {
        if (options.failRemove) {
          return { status: 1, stdout: "", stderr: "synthetic rm failure", error: null };
        }
        exists = false;
        paused = false;
        running = false;
      } else {
        return { status: 2, stdout: "", stderr: `unexpected docker args: ${args.join(" ")}`, error: null };
      }
      return { status: 0, stdout: "", stderr: "", error: null };
    },
  };
  return {
    operations,
    commands,
    exists: () => exists,
    mutationCommands: () => commands.filter((args) => args[0] !== "container"),
  };
}

async function archivedOutputFixture() {
  const path = await statePath();
  const manager = new JobManager(path, false);
  const request = validRequest();
  request.outputName = `archive-authority-${process.pid}-${roots.length}-${Date.now()}.mp4`;
  const created = manager.create(request, { deferStart: true });
  const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
    .get(created.id)!;
  runtimeJob.status = "completed";
  runtimeJob.startedAt = "2026-08-26T20:00:00.000Z";
  runtimeJob.finishedAt = "2026-08-26T20:01:00.000Z";
  runtimeJob.progress = 100;
  runtimeJob.outputUrl = `/api/jobs/${created.id}/output`;
  runtimeJob.executionClass = undefined;
  runtimeJob.executionDecision = undefined;
  const outputPath = join(outputRoot, request.outputName);
  const markerPath = outputPublicationPath(outputPath);
  roots.push(outputPath, markerPath);
  await mkdir(outputRoot, { recursive: true });
  await writeFile(outputPath, "archive authority output bytes");
  publishCompletedOutputFixture(outputRoot, runtimeJob as unknown as StudioJob);
  (Reflect.get(manager, "changed") as () => void).call(manager);
  (Reflect.get(manager, "archivePublishedJob") as (job: unknown) => void)
    .call(manager, runtimeJob);
  return { manager, runtimeJob, outputPath, markerPath };
}

async function preparedDgxPublicationFixture(persistMarker: boolean) {
  const path = await statePath();
  const manager = new JobManager(path, false);
  const request = validRequest("two-stage");
  request.outputName = `prepared-publication-${persistMarker ? "marker" : "no-marker"}-${Date.now()}-${roots.length}.mp4`;
  const created = manager.create(request, { deferStart: true });
  const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
    .get(created.id)!;
  runtimeJob.runProvenance = runProvenance();
  const classify = Reflect.get(manager, "classifyExecution") as (
    job: Record<string, unknown>,
    executionClass: "dgx",
  ) => boolean;
  expect(classify.call(manager, runtimeJob, "dgx")).toBe(true);
  runtimeJob.status = "running";
  runtimeJob.startDeferred = false;
  runtimeJob.startedAt = "2026-08-27T18:00:00.000Z";
  const dgxJobId = testDgxJobId(`prepared-publication-${persistMarker}-${created.id}`);
  bindTestDgxLease(runtimeJob, created.id, dgxJobId, request);
  runtimeJob.dgxOwnerHeartbeat = {
    jobId: dgxJobId,
    phase: "synthetic publication boundary",
    progressEpoch: 1,
    acknowledgedProgressEpoch: 1,
    acknowledgedOnce: true,
    lastAcknowledgedAt: Date.now(),
    lastProgressAt: Date.now(),
    consecutiveFailures: 0,
    stopped: false,
  };
  const outputPath = join(outputRoot, request.outputName);
  const markerPath = outputPublicationPath(outputPath);
  roots.push(outputPath, markerPath, join(hybridRoot, created.id));
  await mkdir(outputRoot, { recursive: true });
  await writeFile(outputPath, "prepared publication crash-boundary bytes");
  const completedAt = "2026-08-27T18:01:00.000Z";
  const buildPublicationAuthority = Reflect.get(manager, "buildPublicationAuthority") as (
    job: Record<string, unknown>,
    publishedAt: string,
  ) => Record<string, unknown>;
  runtimeJob.finishedAt = completedAt;
  const publicationAuthority = buildPublicationAuthority.call(manager, runtimeJob, completedAt);
  runtimeJob.outputPublication = publicationAuthority;
  runtimeJob.outputPublicationCommitPending = {
    schemaVersion: "ltx-studio-output-publication-commit.v1",
    completedAt,
    completionMetadata: {
      current_step: "synthetic durable publication crash boundary",
      artifact: {
        type: "video",
        path: outputPath,
        note: "prepared publication recovery fixture",
      },
    },
  };
  (Reflect.get(manager, "changed") as () => void).call(manager);
  if (persistMarker) {
    (Reflect.get(manager, "persistPublicationAuthority") as (
      job: Record<string, unknown>,
    ) => void).call(manager, runtimeJob);
  }
  return {
    path,
    manager,
    runtimeJob,
    created,
    dgxJobId,
    outputPath,
    markerPath,
    completedAt,
    publicationAuthority,
  };
}

async function persistActiveRawDgxRestoreCase(options: {
  dgxJobId: string | null;
  submitPending?: boolean;
  submitStartedAt?: string;
}): Promise<{ path: string; jobId: string; admissionRequest: AdmissionRequest }> {
  const path = await statePath();
  const manager = new JobManager(path, false);
  const request = validRequest("image-audio-to-video");
  request.outputName = `restore-active-raw-${roots.length}.mp4`;
  request.postprocess.lipForcing.enabled = true;
  request.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
  const requestSha256 = experimentRequestSha256V1(request);
  const binding = {
    schemaVersion: "ltx-studio-experiment-run.v1" as const,
    experimentId: "22222222-2222-4222-8222-222222222222",
    protocolSha256: "a".repeat(64),
    arm: "candidate" as const,
    kind: "ablation" as const,
    variableId: "lipforcing-raw-output-profile",
    changedRequestPaths: ["postprocess.lipForcing.rawOutputProfile"],
    baselineRequestSha256: "b".repeat(64),
    requestSha256,
    baselineJobId: "11111111-1111-4111-8111-111111111111",
    baselineOutputName: "fresh-baseline.mp4",
  };
  const created = manager.create(request, { experiment: binding, deferStart: true });
  const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
    .get(created.id)!;
  runtimeJob.runProvenance = runProvenance();
  const forgedDecision: JobExecutionDecision = {
    schemaVersion: "ltx-studio-execution-decision.v6",
    executionClass: "dgx",
    decidedAt: "2026-08-26T09:59:00.000Z",
    reason: "Forged historical raw-candidate DGX authority for restore rejection test.",
    requestSha256,
    protocolSha256: binding.protocolSha256,
    cpuReuse: null,
    operation: null,
  };
  runtimeJob.executionClass = "dgx";
  runtimeJob.executionDecision = forgedDecision;
  runtimeJob.runProvenance = bindRunExecutionDecision(
    runtimeJob.runProvenance as RunProvenance,
    forgedDecision,
  );
  runtimeJob.status = "running";
  runtimeJob.startDeferred = false;
  runtimeJob.startedAt = "2026-08-26T10:00:00.000Z";
  if (options.submitPending) {
    bindTestPendingDgxSubmit(
      runtimeJob,
      created.id,
      request,
      options.submitStartedAt ?? "2026-08-26T10:00:01.000Z",
    );
  } else if (options.dgxJobId) {
    bindTestDgxLease(runtimeJob, created.id, options.dgxJobId, request);
  }
  (Reflect.get(manager, "changed") as () => void).call(manager);
  const stored = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
  stored[0].experiment = {
    ...(stored[0].experiment as Record<string, unknown>),
    variableId: "lipforcing-decoder",
    changedRequestPaths: ["postprocess.lipForcing.decoder"],
  };
  await writeFile(path, JSON.stringify(stored));
  const [admissionRequest] = buildAdmissionRequests(request, 58, created.id);
  return { path, jobId: created.id, admissionRequest };
}

function executionRevision(mode = 0o100600): ExecutionFileRevision {
  return {
    sizeBytes: 1,
    modifiedAtMs: 1,
    changedAtMs: 1,
    fileId: "1",
    deviceId: "1",
    mode,
    uid: 1000,
    gid: 1000,
    nlink: 1,
  };
}

function cpuReuseFixture(
  baselineJobId: string,
  baselineOutputName: string,
  baselineRequestSha256: string,
): CpuReuseSourceBinding {
  return {
    baselineJobId,
    baselineOutputName,
    baselineRequestSha256,
    sourceOutputPath: "/private/source.mp4",
    outputSha256: "1".repeat(64),
    outputRevision: executionRevision(),
    settingsSidecarPath: "/private/source.ltx-settings.json",
    settingsSidecarSha256: "2".repeat(64),
    settingsSidecarRevision: executionRevision(),
    analysisSidecarPath: "/private/source.ltx-analysis.json",
    analysisSidecarSha256: "3".repeat(64),
    analysisSidecarRevision: executionRevision(),
    sourceProvenanceFingerprint: "4".repeat(64),
    sourceProgramAudioDelayMs: 0,
    snapshotOutputPath: "/private/snapshot.mp4",
    snapshotOutputSha256: "1".repeat(64),
    snapshotOutputRevision: executionRevision(),
    snapshotSettingsSidecarPath: "/private/snapshot.ltx-settings.json",
    snapshotSettingsSidecarSha256: "2".repeat(64),
    snapshotSettingsSidecarRevision: executionRevision(),
    snapshotAnalysisSidecarPath: "/private/snapshot.ltx-analysis.json",
    snapshotAnalysisSidecarSha256: "3".repeat(64),
    snapshotAnalysisSidecarRevision: executionRevision(),
  };
}

function preparedCpuOperation(): CpuFfmpegOperation {
  return {
    kind: "ffmpeg-audio-retime",
    state: "prepared",
    descriptorThreatModel: executionDescriptorThreatModel,
    executable: {
      path: "/usr/bin/ffmpeg",
      sha256: "5".repeat(64),
      revision: executionRevision(0o100755),
    },
    ffmpegVersion: "ffmpeg test",
    argsSha256: "6".repeat(64),
    deltaMs: 80,
    preparedAt: "2026-08-25T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    exitCode: null,
    signal: null,
    errorSha256: null,
    output: null,
  };
}

function pairedReuseFixture(
  baselineJobId: string,
  baselineOutputName: string,
  baselineRequestSha256: string,
): CpuPairedArtifactReuseSourceBinding {
  const file = (path: string, sha256: string, fileId: string): ExecutionFileBinding => ({
    path,
    sha256,
    revision: { ...executionRevision(0o100400), fileId },
  });
  return {
    reuseKind: "lipforcing-raw-mux-pair",
    baselineJobId,
    baselineOutputName,
    baselineRequestSha256,
    sourceProvenanceFingerprint: "4".repeat(64),
    authority: file("/private/baseline/authority.json", "5".repeat(64), "201"),
    receipt: file("/private/baseline/pair-receipt.json", "6".repeat(64), "202"),
    timelineReceipt: file("/private/baseline/timeline-receipt.json", "7".repeat(64), "203"),
    preMux: file("/private/baseline/pre-mux.mp4", "8".repeat(64), "204"),
    preMuxReceipt: file("/private/baseline/pre-mux-receipt.json", "a".repeat(64), "206"),
    candidateFinal: file("/private/baseline/candidate-final.mp4", "9".repeat(64), "205"),
    snapshotAuthority: file("/private/candidate/authority.json", "5".repeat(64), "211"),
    snapshotReceipt: file("/private/candidate/pair-receipt.json", "6".repeat(64), "212"),
    snapshotTimelineReceipt: file("/private/candidate/timeline-receipt.json", "7".repeat(64), "213"),
    snapshotPreMux: file("/private/candidate/pre-mux.mp4", "8".repeat(64), "214"),
    snapshotPreMuxReceipt: file("/private/candidate/pre-mux-receipt.json", "a".repeat(64), "216"),
    snapshotCandidateFinal: file("/private/candidate/candidate-final.mp4", "9".repeat(64), "215"),
  };
}

function preparedPairedOperation(): CpuPairedArtifactPromotionOperation {
  return {
    kind: "paired-artifact-promotion",
    state: "prepared",
    descriptorThreatModel: executionDescriptorThreatModel,
    authoritySha256: "5".repeat(64),
    preparedAt: "2026-08-26T10:00:00.000Z",
    startedAt: null,
    completedAt: null,
    exitCode: null,
    signal: null,
    errorSha256: null,
    output: null,
  };
}

async function persistPairedRestoreCase(
  state: "prepared" | "running" | "succeeded",
): Promise<{ path: string; id: string }> {
  const path = await statePath();
  const request = validRequest("image-audio-to-video");
  request.outputName = `paired-restore-${state}.mp4`;
  request.postprocess.lipForcing.enabled = true;
  request.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
  const requestSha256 = experimentRequestSha256V1(request);
  const baselineJobId = "11111111-1111-4111-8111-111111111111";
  const baselineRequestSha256 = "b".repeat(64);
  const binding = {
    schemaVersion: "ltx-studio-experiment-run.v1" as const,
    experimentId: "22222222-2222-4222-8222-222222222222",
    protocolSha256: "a".repeat(64),
    arm: "candidate" as const,
    kind: "ablation" as const,
    variableId: "lipforcing-raw-output-profile" as const,
    changedRequestPaths: ["postprocess.lipForcing.rawOutputProfile"],
    baselineRequestSha256,
    requestSha256,
    baselineJobId,
    baselineOutputName: "baseline.mp4",
  };
  const manager = new JobManager(path, false);
  const created = manager.create(request, { experiment: binding, deferStart: true });
  const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
    .get(created.id)!;
  runtimeJob.runProvenance = runProvenance();
  const classify = Reflect.get(manager, "classifyExecution") as (
    job: Record<string, unknown>,
    executionClass: "cpu-only",
    cpuReuse: CpuPairedArtifactReuseSourceBinding,
    operation: CpuPairedArtifactPromotionOperation,
  ) => boolean;
  expect(classify.call(
    manager,
    runtimeJob,
    "cpu-only",
    pairedReuseFixture(baselineJobId, binding.baselineOutputName, baselineRequestSha256),
    preparedPairedOperation(),
  )).toBe(true);
  const commit = Reflect.get(manager, "commitExecutionDecision") as (
    job: Record<string, unknown>,
    decision: JobExecutionDecision,
  ) => boolean;
  const prepared = runtimeJob.executionDecision as JobExecutionDecision;
  if (prepared.executionClass !== "cpu-only"
    || prepared.operation.kind !== "paired-artifact-promotion") throw new Error("paired fixture");
  const preparedPaired = prepared as JobExecutionDecision & {
    schemaVersion: "ltx-studio-execution-decision.v6";
    cpuReuse: CpuPairedArtifactReuseSourceBinding;
    operation: CpuPairedArtifactPromotionOperation;
  };
  const running: JobExecutionDecision = {
    ...preparedPaired,
    operation: {
      ...preparedPaired.operation,
      state: "running",
      startedAt: "2026-08-26T10:00:01.000Z",
    },
  };
  if (state !== "prepared") expect(commit.call(manager, runtimeJob, running)).toBe(true);
  if (state === "succeeded") {
    if (running.executionClass !== "cpu-only"
      || running.operation.kind !== "paired-artifact-promotion") throw new Error("paired fixture");
    const runningPaired = running as JobExecutionDecision & {
      schemaVersion: "ltx-studio-execution-decision.v6";
      cpuReuse: CpuPairedArtifactReuseSourceBinding;
      operation: CpuPairedArtifactPromotionOperation;
    };
    const succeeded: JobExecutionDecision = {
      ...runningPaired,
      operation: {
        ...runningPaired.operation,
        state: "succeeded",
        completedAt: "2026-08-26T10:00:02.000Z",
        exitCode: 0,
        output: {
          path: "/private/candidate/promoted.tmp.mp4",
          sha256: "9".repeat(64),
          revision: { ...executionRevision(0o100400), fileId: "216" },
        },
      },
    };
    expect(commit.call(manager, runtimeJob, succeeded)).toBe(true);
    runtimeJob.status = "failed";
    runtimeJob.finishedAt = "2026-08-26T10:00:03.000Z";
    runtimeJob.error = "Late publication gate denied paired output.";
  } else {
    runtimeJob.status = "running";
    runtimeJob.startedAt = "2026-08-26T10:00:01.000Z";
  }
  runtimeJob.runProvenance = bindRunExecutionDecision(
    runtimeJob.runProvenance as RunProvenance,
    runtimeJob.executionDecision as JobExecutionDecision,
  );
  runtimeJob.startDeferred = false;
  (Reflect.get(manager, "changed") as () => void).call(manager);
  return { path, id: created.id };
}

async function persistCpuRestoreCase(
  state: "prepared" | "running" | "succeeded",
): Promise<{ path: string; id: string }> {
  const path = await statePath();
  const request = validRequest();
  request.outputName = `cpu-restore-${state}.mp4`;
  request.postprocess.lipForcing.programAudioDelayMs = 80;
  const requestSha256 = experimentRequestSha256V1(request);
  const baselineJobId = "11111111-1111-4111-8111-111111111111";
  const binding = {
    schemaVersion: "ltx-studio-experiment-run.v1" as const,
    experimentId: "22222222-2222-4222-8222-222222222222",
    protocolSha256: "a".repeat(64),
    arm: "candidate" as const,
    kind: "ablation" as const,
    variableId: "lipforcing-program-audio-delay-ms" as const,
    changedRequestPaths: ["postprocess.lipForcing.programAudioDelayMs"],
    baselineRequestSha256: "b".repeat(64),
    requestSha256,
    baselineJobId,
    baselineOutputName: "baseline.mp4",
  };
  const manager = new JobManager(path, false);
  const created = manager.create(request, { experiment: binding, deferStart: true });
  const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
  runtimeJob.runProvenance = runProvenance();
  const classify = Reflect.get(manager, "classifyExecution") as (
    job: Record<string, unknown>,
    executionClass: "cpu-only",
    cpuReuse: CpuReuseSourceBinding,
    operation: CpuFfmpegOperation,
  ) => boolean;
  expect(classify.call(
    manager,
    runtimeJob,
    "cpu-only",
    cpuReuseFixture(baselineJobId, binding.baselineOutputName, binding.baselineRequestSha256),
    preparedCpuOperation(),
  )).toBe(true);
  const commit = Reflect.get(manager, "commitExecutionDecision") as (
    job: Record<string, unknown>,
    decision: JobExecutionDecision,
  ) => boolean;
  const prepared = runtimeJob.executionDecision as JobExecutionDecision;
  if (prepared.executionClass !== "cpu-only"
    || prepared.operation.kind !== "ffmpeg-audio-retime") {
    throw new Error("CPU fixture was not classified");
  }
  const preparedAudio = prepared as JobExecutionDecision & {
    cpuReuse: CpuAudioRetimeReuseSourceBinding;
    operation: CpuFfmpegOperation;
  };
  const running: JobExecutionDecision = {
    ...preparedAudio,
    operation: {
      ...preparedAudio.operation,
      state: "running",
      startedAt: "2026-08-25T10:00:01.000Z",
    },
  } as JobExecutionDecision;
  if (state !== "prepared") expect(commit.call(manager, runtimeJob, running)).toBe(true);
  if (state === "succeeded") {
    const output: ExecutionFileBinding = {
      path: "/private/retimed-output.tmp.mp4",
      sha256: "7".repeat(64),
      revision: executionRevision(),
    };
    if (running.executionClass !== "cpu-only"
      || running.operation.kind !== "ffmpeg-audio-retime") {
      throw new Error("CPU fixture lost its FFmpeg operation");
    }
    const runningAudio = running as JobExecutionDecision & {
      cpuReuse: CpuAudioRetimeReuseSourceBinding;
      operation: CpuFfmpegOperation;
    };
    const succeeded: JobExecutionDecision = {
      ...runningAudio,
      operation: {
        ...runningAudio.operation,
        state: "succeeded",
        completedAt: "2026-08-25T10:00:02.000Z",
        exitCode: 0,
        output,
      },
    } as JobExecutionDecision;
    expect(commit.call(manager, runtimeJob, succeeded)).toBe(true);
    runtimeJob.status = "failed";
    runtimeJob.finishedAt = "2026-08-25T10:00:03.000Z";
    runtimeJob.error = "Late Activation-/Rights-Gate denied publication.";
    runtimeJob.outputUrl = null;
  } else {
    runtimeJob.status = "running";
    runtimeJob.startedAt = "2026-08-25T10:00:01.000Z";
  }
  runtimeJob.runProvenance = bindRunExecutionDecision(
    runtimeJob.runProvenance as RunProvenance,
    runtimeJob.executionDecision as JobExecutionDecision,
  );
  runtimeJob.startDeferred = false;
  const changed = Reflect.get(manager, "changed") as () => void;
  changed.call(manager);
  return { path, id: created.id };
}

describe("job persistence and reservations", () => {
  it("rejects a current DFR request before persistence or queueing", async () => {
    const manager = new JobManager(await statePath(), false);

    expect(() => manager.create(validRequest("dfr"), { deferStart: true }))
      .toThrow(/Qualification-HOLD/u);
    expect(manager.list()).toEqual([]);
    expect(Reflect.get(manager, "queue")).toEqual([]);
  });

  it("admits mux-copy only on the unsealed controlled-experiment development surface", async () => {
    const baseline = validRequest("image-audio-to-video");
    baseline.postprocess.lipForcing.enabled = true;
    const releaseSurfaceId = jobSurfaceEntryId(baseline, "direct", false);
    expect(releaseSurfaceId).not.toContain("development:");

    const candidate = structuredClone(baseline);
    candidate.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
    const requestSha256 = experimentRequestSha256V1(candidate);
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "22222222-2222-4222-8222-222222222222",
      protocolSha256: "a".repeat(64),
      arm: "candidate" as const,
      kind: "ablation" as const,
      variableId: "lipforcing-raw-output-profile",
      changedRequestPaths: ["postprocess.lipForcing.rawOutputProfile"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256,
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "fresh-baseline.mp4",
    };
    expect(validRequestBoundExperimentBinding(candidate, binding)).toEqual(binding);
    expect(validRawOutputExperimentBinding(candidate, binding)).toEqual(binding);
    expect(jobSurfaceEntryId(candidate, "experiment", false, binding))
      .toBe(DEVELOPMENT_LIPFORCING_RAW_OUTPUT_SURFACE_ID);
    expect(() => jobSurfaceEntryId(candidate, "direct", false))
      .toThrow("kontrollierten Development-Experiments");
    expect(() => jobSurfaceEntryId(candidate, "experiment", true, binding))
      .toThrow("kontrollierten Development-Experiments");
    expect(validRawOutputExperimentBinding(candidate, {
      ...binding,
      baselineJobId: null,
    })).toBeNull();
    expect(validRawOutputExperimentBinding(candidate, {
      ...binding,
      adoptedBaseline: true,
    })).toBeNull();
    expect(validRawOutputExperimentBinding(candidate, {
      ...binding,
      requestSha256: "0".repeat(64),
    })).toBeNull();
    expect(validRawOutputExperimentBinding(candidate, {
      ...binding,
      variableId: "lipforcing-decoder",
      changedRequestPaths: ["postprocess.lipForcing.decoder"],
    })).toBeNull();
    expect(() => jobSurfaceEntryId(candidate, "experiment", false, {
      ...binding,
      variableId: "lipforcing-decoder",
      changedRequestPaths: ["postprocess.lipForcing.decoder"],
    })).toThrow("kontrollierten Development-Experiments");

    const manager = new JobManager(await statePath(), false);
    expect(() => manager.create(candidate, { startSource: "experiment" } as never))
      .toThrow("kontrollierten Development-Experiments");

    candidate.postprocess.lipForcing.enabled = false;
    expect(() => jobSurfaceEntryId(candidate, "experiment", false, binding))
      .toThrow("Unbekanntes oder inaktives");
  });

  it("accepts a positive-prompt candidate only with the exact fresh ablation binding", () => {
    const candidate = validLtx25SplitRequest("image-audio-to-video");
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "22222222-2222-4222-8222-222222222222",
      protocolSha256: "a".repeat(64),
      arm: "candidate" as const,
      kind: "ablation" as const,
      variableId: "positive-prompt",
      changedRequestPaths: ["prompt"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256: experimentRequestSha256V1(candidate),
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "fresh-prompt-baseline.mp4",
    };

    expect(validPositivePromptExperimentBinding(candidate, binding)).toEqual(binding);
    expect(validPositivePromptExperimentBinding(candidate, {
      ...binding,
      changedRequestPaths: ["promptParts.dialogue"],
    })).toBeNull();
    expect(validPositivePromptExperimentBinding(candidate, {
      ...binding,
      adoptedBaseline: true,
    })).toBeNull();
    expect(validPositivePromptExperimentBinding(candidate, {
      ...binding,
      requestSha256: "0".repeat(64),
    })).toBeNull();

    const unsupportedGeneration = structuredClone(candidate);
    unsupportedGeneration.models.generation = "2.3";
    expect(validPositivePromptExperimentBinding(unsupportedGeneration, {
      ...binding,
      requestSha256: experimentRequestSha256V1(unsupportedGeneration),
    })).toBeNull();

    const unsupportedLayout = structuredClone(candidate);
    unsupportedLayout.models.layout = "monolith";
    expect(validPositivePromptExperimentBinding(unsupportedLayout, {
      ...binding,
      requestSha256: experimentRequestSha256V1(unsupportedLayout),
    })).toBeNull();

    const unsupportedMode = structuredClone(candidate);
    unsupportedMode.mode = "audio-to-video";
    expect(validPositivePromptExperimentBinding(unsupportedMode, {
      ...binding,
      requestSha256: experimentRequestSha256V1(unsupportedMode),
    })).toBeNull();

    const matching = {
      ...bindRunExecutionDecision(runProvenance({ verified: false }), {
        schemaVersion: "ltx-studio-execution-decision.v5" as const,
        executionClass: "dgx" as const,
        decidedAt: "2026-08-28T03:00:00.000Z",
        reason: "Fresh prompt baseline.",
        requestSha256: "d".repeat(64),
        protocolSha256: binding.protocolSha256,
        cpuReuse: null,
        operation: null,
      }),
      verifiedAt: "2026-08-28T03:20:00.000Z",
    };
    expect(positivePromptCandidateEnvironmentError({
      request: candidate,
      experiment: binding,
      runProvenance: matching,
    }, {
      status: "completed",
      runProvenance: matching,
    })).toBeNull();
    expect(positivePromptCandidateEnvironmentError({
      request: candidate,
      experiment: binding,
      runProvenance: {
        ...matching,
        code: [{ ...matching.code[0], fingerprint: "e".repeat(64) }],
      },
    }, {
      status: "completed",
      runProvenance: matching,
    })).toContain("vor DGX-Admission abgewiesen");
    expect(positivePromptCandidateEnvironmentError({
      request: candidate,
      experiment: binding,
      runProvenance: matching,
    }, null)).toContain("vor DGX-Admission abgewiesen");

    candidate.postprocess.lipForcing.enabled = true;
    expect(genericLtxBaseReuseAllowed({ request: candidate, experiment: binding })).toBe(false);
    expect(genericLtxBaseReuseAllowed({
      request: candidate,
      experiment: {
        ...binding,
        arm: "baseline",
        baselineJobId: null,
        baselineRequestSha256: binding.requestSha256,
      },
    })).toBe(false);
    expect(genericLtxBaseReuseAllowed({ request: candidate, experiment: null })).toBe(true);
  });

  it("protects prompt A/B outputs from deletion without blocking analysis mutations", async () => {
    const manager = new JobManager(await statePath(), false);
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.outputName = "protected-prompt-candidate.mp4";
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "22222222-2222-4222-8222-222222222222",
      protocolSha256: "a".repeat(64),
      arm: "candidate" as const,
      kind: "ablation" as const,
      variableId: "positive-prompt",
      changedRequestPaths: ["prompt"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256: experimentRequestSha256V1(request),
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "protected-prompt-baseline.mp4",
    };
    const created = manager.create(request, { experiment: binding, deferStart: true });

    expect(() => manager.assertOutputMutationAllowed(request.outputName)).not.toThrow();
    expect(() => manager.assertOutputDeletionAllowed(request.outputName))
      .toThrow("hashgebundenen Prompt-A/B-Experiments");

    manager.cancel(created.id);
    expect(() => manager.remove(created.id))
      .toThrow("hashgebundenen Prompt-A/B-Experiments");
    expect(manager.get(created.id)).toBeDefined();
    expect(() => manager.assertOutputDeletionAllowed(request.outputName))
      .toThrow("hashgebundenen Prompt-A/B-Experiments");
  });

  it("keeps the private attach-failure cleanup limited to a never-armed prompt prepare", async () => {
    const manager = new JobManager(await statePath(), false);
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.outputName = "detached-prompt-prepare.mp4";
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "22222222-2222-4222-8222-222222222222",
      protocolSha256: "a".repeat(64),
      arm: "candidate" as const,
      kind: "ablation" as const,
      variableId: "positive-prompt",
      changedRequestPaths: ["prompt"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256: experimentRequestSha256V1(request),
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "detached-prompt-baseline.mp4",
    };
    const created = manager.create(request, { experiment: binding, deferStart: true });

    manager.cancel(created.id);
    expect(manager.removeDetachedDeferredExperimentJob(created.id)).toMatchObject({
      id: created.id,
      status: "cancelled",
    });
    expect(manager.get(created.id)).toBeUndefined();
  });

  it("submits no DGX admission when a prompt candidate input artifact differs from its baseline", async () => {
    let submits = 0;
    const baselineProvenance = {
      ...bindRunExecutionDecision(runProvenance({ verified: false }), {
        schemaVersion: "ltx-studio-execution-decision.v5" as const,
        executionClass: "dgx" as const,
        decidedAt: "2026-08-28T03:00:00.000Z",
        reason: "Fresh prompt baseline.",
        requestSha256: "d".repeat(64),
        protocolSha256: "a".repeat(64),
        cpuReuse: null,
        operation: null,
      }),
      verifiedAt: "2026-08-28T03:20:00.000Z",
    };
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      {
        capture: async () => notApplicableIdentityEvidence(),
        verify: async (evidence) => ({ evidence, error: null }),
      },
      undefined,
      null,
      {
        submit: async () => {
          submits += 1;
          throw new Error("DGX submit must remain unreachable");
        },
      },
      {
        capture: async () => runProvenance({ modelSha: "f".repeat(64), verified: false }),
        verify: async (evidence) => ({ evidence, error: null }),
      },
    );
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.outputName = "prompt-input-drift-candidate.mp4";
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "22222222-2222-4222-8222-222222222222",
      protocolSha256: "a".repeat(64),
      arm: "candidate" as const,
      kind: "ablation" as const,
      variableId: "positive-prompt",
      changedRequestPaths: ["prompt"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256: experimentRequestSha256V1(request),
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "prompt-input-drift-baseline.mp4",
    };
    const created = manager.create(request, { experiment: binding, deferStart: true });
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    (runtimeJob.plan as { requiredPaths: unknown[] }).requiredPaths = [];
    Reflect.set(manager, "verifyNativeRuntimeSourceBeforeAdmission", () => true);
    Reflect.set(manager, "modelInventoryOperations", {
      read: async () => verifiedModelInventory(),
    });
    Reflect.set(manager, "positivePromptBaselineAuthority", () => ({
      baseline: { status: "completed", runProvenance: baselineProvenance },
      error: null,
    }));
    Reflect.set(manager, "waitForDgxQueueStart", async () => {
      submits += 1;
      return true;
    });

    const run = Reflect.get(manager, "run") as (job: unknown) => Promise<void>;
    await run.call(manager, runtimeJob);

    expect(submits).toBe(0);
    expect(manager.get(created.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Ausführungsinputs, Code oder Runtime-Provenienz"),
      dgxJobId: null,
    });
  });

  it("never classifies a bound mux-copy candidate as DGX fallback", async () => {
    const manager = new JobManager(await statePath(), false);
    const request = validRequest("image-audio-to-video");
    request.outputName = `raw-no-dgx-fallback-${roots.length}.mp4`;
    request.postprocess.lipForcing.enabled = true;
    request.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
    const requestSha256 = experimentRequestSha256V1(request);
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "22222222-2222-4222-8222-222222222222",
      protocolSha256: "a".repeat(64),
      arm: "candidate" as const,
      kind: "ablation" as const,
      variableId: "lipforcing-raw-output-profile" as const,
      changedRequestPaths: ["postprocess.lipForcing.rawOutputProfile"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256,
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "fresh-baseline.mp4",
    };
    const created = manager.create(request, { experiment: binding, deferStart: true });
    const runtime = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    const classify = Reflect.get(manager, "classifyExecution") as (
      job: Record<string, unknown>,
      executionClass: "dgx",
    ) => boolean;

    expect(classify.call(manager, runtime, "dgx")).toBe(false);
    expect(manager.get(created.id)).toMatchObject({
      status: "failed",
      executionClass: "pending",
      error: expect.stringContaining("Fallback ist verboten"),
    });
  });

  it("denies a mux-copy candidate unless its fresh baseline also has sealed pair authority", async () => {
    const manager = new JobManager(await statePath(), false);
    const experimentId = "22222222-2222-4222-8222-222222222222";
    const protocolSha256 = "a".repeat(64);
    const baselineRequest = validRequest("image-audio-to-video");
    baselineRequest.outputName = `raw-live-${process.pid}-${roots.length}-exp-22222222-a.mp4`;
    baselineRequest.postprocess.lipForcing.enabled = true;
    const baselineRequestSha256 = experimentRequestSha256V1(baselineRequest);
    const baselineBinding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId,
      protocolSha256,
      arm: "baseline" as const,
      kind: "ablation" as const,
      variableId: "lipforcing-raw-output-profile",
      changedRequestPaths: ["postprocess.lipForcing.rawOutputProfile"],
      baselineRequestSha256,
      requestSha256: baselineRequestSha256,
      baselineJobId: null,
      baselineOutputName: baselineRequest.outputName,
    };
    const baseline = manager.create(baselineRequest, {
      experiment: baselineBinding,
      deferStart: true,
    });
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, StudioJob & {
      plan: { outputPath: string };
      authorityRequestSha256: string;
    }>;
    const baselineJob = internalJobs.get(baseline.id)!;
    await mkdir(outputRoot, { recursive: true });
    await writeFile(baselineJob.plan.outputPath, "published raw baseline bytes");
    baselineJob.status = "completed";
    baselineJob.startedAt = "2026-08-25T10:00:00.000Z";
    baselineJob.finishedAt = "2026-08-25T10:01:00.000Z";
    baselineJob.progress = 100;
    const baselineImage = testLipForcingContainerIdentity();
    baselineJob.runProvenance = {
      ...runProvenance(),
      containerImages: [baselineImage],
    };
    baselineJob.executionClass = undefined;
    baselineJob.executionDecision = undefined;
    publishCompletedOutputFixture(outputRoot, baselineJob);
    baselineJob.runProvenance = {
      ...baselineJob.runProvenance!,
      verifiedAt: "2026-08-25T10:00:30.000Z",
    };

    const candidateRequest = structuredClone(baselineRequest);
    candidateRequest.outputName = `raw-live-${process.pid}-${roots.length}-exp-22222222-b.mp4`;
    candidateRequest.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
    const candidateRequestSha256 = experimentRequestSha256V1(candidateRequest);
    const candidate = manager.create(candidateRequest, {
      experiment: {
        ...baselineBinding,
        arm: "candidate",
        requestSha256: candidateRequestSha256,
        baselineJobId: baseline.id,
      },
      deferStart: true,
    });
    const candidateJob = internalJobs.get(candidate.id)!;
    candidateJob.runProvenance = {
      ...runProvenance(),
      containerImages: [baselineImage],
    };
    const jobStartDecision = Reflect.get(manager, "jobStartDecision") as (
      job: typeof candidateJob,
    ) => { allowed: boolean; reason: string };

    try {
      expect(jobStartDecision.call(manager, candidateJob)).toMatchObject({
        allowed: false,
        reason: expect.stringMatching(/Artefakte|Authority/u),
      });
      await rm(baselineJob.plan.outputPath, { force: true });
      expect(jobStartDecision.call(manager, candidateJob)).toMatchObject({
        allowed: false,
        reason: expect.stringContaining("frisch gerenderten"),
      });
    } finally {
      await rm(baselineJob.plan.outputPath, { force: true });
      await rm(outputPublicationPath(baselineJob.plan.outputPath), { force: true });
    }
  });

  it("binds executable bytes/revision/mode and executes the held FD after pathname replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-bound-executable-"));
    roots.push(root);
    const executablePath = join(root, "ffmpeg");
    const originalPath = join(root, "ffmpeg.opened");
    await copyFile(process.execPath, executablePath);
    await chmod(executablePath, 0o755);

    const executable = openBoundExecutable(executablePath, ["--version"]);
    try {
      expect(executable.binding.path).toBe(executablePath);
      expect(executable.binding.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(executable.binding.revision).toMatchObject({
        sizeBytes: expect.any(Number),
        deviceId: expect.stringMatching(/^\d+$/),
        fileId: expect.stringMatching(/^\d+$/),
        mode: expect.any(Number),
      });
      expect(executable.binding.revision.mode & 0o777).toBe(0o755);
      expect(executable.version).toBe(process.version);

      await rename(executablePath, originalPath);
      await writeFile(executablePath, "path replacement must never execute\n");
      await chmod(executablePath, 0o755);
      const result = spawnSync("/proc/self/fd/3", ["-e", "process.stdout.write('held-fd')"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe", executable.fd],
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("held-fd");
    } finally {
      closeSync(executable.fd);
    }
  });

  it.each([
    ["Activation-/Rights denial", "activation"],
    ["RuntimeTrust failure", "runtime-trust"],
  ] as const)(
    "keeps the final publication marker private after a late %s at the release fence",
    async (_case, fault) => {
      const path = await statePath();
      let denyAtRelease = false;
      let failRuntimeTrustAtRelease = false;
      const enforcerStatus = () => ({
        productStartsAllowed: !denyAtRelease,
        mode: "development" as const,
        reason: denyAtRelease
          ? "synthetic late Activation-/Rights denial"
          : "synthetic initial release authorization",
        schemaVersion: "ltx-studio-bootstrap-start-enforcer.v3" as const,
        generation: null,
        activationHeadSha256: null,
      });
      const startEnforcer = {
        decide: vi.fn(() => ({ ...enforcerStatus(), allowed: !denyAtRelease })),
        inspect: vi.fn(() => enforcerStatus()),
      };
      const runtimeTrustRevalidation = vi.fn(() => {
        if (failRuntimeTrustAtRelease) {
          throw new Error("synthetic late RuntimeTrust drift");
        }
      });
      const manager = new JobManager(
        path,
        false,
        null,
        undefined,
        undefined,
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        startEnforcer,
        runtimeTrustRevalidation,
      );
      const request = validRequest();
      request.outputName = `late-marker-fence-${fault}-${Date.now()}-${roots.length}.mp4`;
      const created = manager.create(request, { deferStart: true });
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      active.runProvenance = runProvenance();
      const classify = Reflect.get(manager, "classifyExecution") as (
        job: Record<string, unknown>,
        executionClass: "dgx",
      ) => boolean;
      expect(classify.call(manager, active, "dgx")).toBe(true);
      const outputPath = join(outputRoot, request.outputName);
      const markerPath = outputPublicationPath(outputPath);
      roots.push(outputPath, markerPath);
      await mkdir(outputRoot, { recursive: true });
      await writeFile(outputPath, "publication bytes remain private without their marker");
      active.status = "running";
      active.startDeferred = false;
      active.startedAt = "2026-08-27T18:00:00.000Z";
      active.finishedAt = "2026-08-27T18:01:00.000Z";
      active.progress = 95;
      active.outputUrl = null;
      const queue = Reflect.get(manager, "queue") as string[];
      queue.splice(queue.indexOf(created.id), 1);
      const buildPublicationAuthority = Reflect.get(manager, "buildPublicationAuthority") as (
        job: Record<string, unknown>,
        publishedAt: string,
      ) => Record<string, unknown>;
      active.outputPublication = buildPublicationAuthority.call(
        manager,
        active,
        active.finishedAt as string,
      );
      active.outputPublicationCommitPending = {
        schemaVersion: "ltx-studio-output-publication-commit.v1",
        completedAt: active.finishedAt,
        completionMetadata: {
          current_step: "synthetic late release-fence test",
        },
      };
      (Reflect.get(manager, "changed") as () => void).call(manager);
      const jobStartDecision = Reflect.get(manager, "jobStartDecision") as (
        job: Record<string, unknown>,
      ) => { allowed: boolean };
      expect(jobStartDecision.call(manager, active)).toMatchObject({ allowed: true });
      expect(runtimeTrustRevalidation).not.toHaveBeenCalled();

      denyAtRelease = fault === "activation";
      failRuntimeTrustAtRelease = fault === "runtime-trust";
      const persistPublicationAuthority = Reflect.get(manager, "persistPublicationAuthority") as (
        job: Record<string, unknown>,
      ) => void;
      expect(() => persistPublicationAuthority.call(manager, active)).toThrow(
        fault === "activation" ? /Activation-\/Rights-Gate/u : /Runtime-Trust-Revalidierung/u,
      );

      expect(runtimeTrustRevalidation).toHaveBeenCalledTimes(1);
      await expect(access(markerPath)).rejects.toThrow();
      await expect(readFile(outputPath, "utf8")).resolves.toContain("remain private");
      const temporaryMarkerPrefix = `.${request.outputName}.ltx-publication.json.`;
      expect((await readdir(outputRoot)).filter((name) => name.startsWith(temporaryMarkerPrefix)))
        .toEqual([]);
    },
  );

  it("recovers a crash after marker fsync as completed and only then creates remote-completed intent", async () => {
    const fixture = await preparedDgxPublicationFixture(true);

    const restored = new JobManager(fixture.path, false, null, undefined, undefined, null);
    const publicJob = restored.get(fixture.created.id);
    const runtimeJob = (Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>)
      .get(fixture.created.id)!;
    const persisted = JSON.parse(await readFile(fixture.path, "utf8")) as Array<Record<string, unknown>>;
    const persistedJob = persisted.find((entry) => entry.id === fixture.created.id)!;

    expect(publicJob).toMatchObject({
      status: "completed",
      progress: 100,
      outputUrl: `/api/jobs/${fixture.created.id}/output`,
    });
    expect(runtimeJob.outputPublicationCommitPending).toBeUndefined();
    expect(runtimeJob.dgxTerminalDelivery).toMatchObject({
      state: "completed",
      metadata: { current_step: "synthetic durable publication crash boundary" },
    });
    expect(persistedJob).not.toHaveProperty("outputPublicationCommitPending");
    expect(persistedJob.dgxTerminalDelivery).toMatchObject({ state: "completed" });
    await expect(readFile(fixture.outputPath, "utf8"))
      .resolves.toBe("prepared publication crash-boundary bytes");
    await expect(readFile(fixture.markerPath, "utf8")).resolves.toContain(fixture.created.id);
  });

  it("never invents remote-completed when a crash leaves only the prepared snapshot without a marker", async () => {
    const fixture = await preparedDgxPublicationFixture(false);

    const restored = new JobManager(fixture.path, false, null, undefined, undefined, null);
    const publicJob = restored.get(fixture.created.id);
    const runtimeJob = (Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>)
      .get(fixture.created.id)!;
    const persisted = JSON.parse(await readFile(fixture.path, "utf8")) as Array<Record<string, unknown>>;
    const persistedJob = persisted.find((entry) => entry.id === fixture.created.id)!;

    expect(publicJob).toMatchObject({
      status: "interrupted",
      outputUrl: null,
    });
    expect(runtimeJob.outputPublicationCommitPending).toBeUndefined();
    expect(runtimeJob.outputPublication).toBeUndefined();
    expect(runtimeJob.dgxTerminalDelivery).toMatchObject({ state: "cancelled" });
    expect(runtimeJob.dgxTerminalDelivery).not.toMatchObject({ state: "completed" });
    expect(persistedJob).not.toHaveProperty("outputPublicationCommitPending");
    expect(persistedJob).not.toHaveProperty("outputPublication");
    expect(persistedJob.dgxTerminalDelivery).toMatchObject({ state: "cancelled" });
    await expect(access(fixture.outputPath)).rejects.toThrow();
    await expect(access(fixture.markerPath)).rejects.toThrow();
  });

  it("rolls back a proven first prepared-snapshot failure, quarantines raw bytes, and restarts without HOLD", async () => {
    const fixture = await preparedDgxPublicationFixture(false);
    delete fixture.runtimeJob.outputPublicationCommitPending;
    delete fixture.runtimeJob.outputPublication;
    fixture.runtimeJob.finishedAt = null;
    const realChanged = (Reflect.get(fixture.manager, "changed") as () => void)
      .bind(fixture.manager);
    realChanged();
    const previousLogs = [...fixture.runtimeJob.logs as string[]];

    const base = Reflect.get(fixture.manager, "jobPersistenceFileOperations") as {
      rename: (source: string, target: string) => void;
      [key: string]: unknown;
    };
    let failPreparedRename = true;
    Reflect.set(fixture.manager, "jobPersistenceFileOperations", {
      ...base,
      rename: (source: string, target: string) => {
        if (failPreparedRename && target === fixture.path) {
          failPreparedRename = false;
          throw new Error("synthetic first prepared snapshot pre-rename failure");
        }
        base.rename(source, target);
      },
    });
    const commitPreparedPublication = Reflect.get(
      fixture.manager,
      "commitPreparedPublication",
    ) as (
      job: Record<string, unknown>,
      authority: Record<string, unknown>,
      completedAt: string,
      metadata: Record<string, unknown>,
      successLog: string,
      failureMessage: string,
      quarantineRoot: string,
    ) => boolean;

    expect(commitPreparedPublication.call(
      fixture.manager,
      fixture.runtimeJob,
      fixture.publicationAuthority,
      fixture.completedAt,
      { current_step: "first prepared snapshot rollback test" },
      "Publication should not be reported as prepared.",
      "First prepared snapshot must be durable",
      join(hybridRoot, fixture.created.id),
    )).toBe(false);

    expect(fixture.manager.get(fixture.created.id)).toMatchObject({
      status: "failed",
      outputUrl: null,
    });
    expect(fixture.runtimeJob.outputPublicationCommitPending).toBeUndefined();
    expect(fixture.runtimeJob.outputPublication).toBeUndefined();
    expect(fixture.runtimeJob.logs).not.toContain(
      "Ausgabe lokal dauerhaft zum Marker-Commit vorbereitet; DGX completed ist bis nach dem Marker-Fsync gesperrt.",
    );
    expect((fixture.runtimeJob.logs as string[]).slice(0, previousLogs.length)).toEqual(previousLogs);
    await expect(access(fixture.outputPath)).rejects.toThrow();
    await expect(access(fixture.markerPath)).rejects.toThrow();
    await expect(readFile(join(hybridRoot, fixture.created.id, "unreleased-output.mp4"), "utf8"))
      .resolves.toBe("prepared publication crash-boundary bytes");

    const persisted = JSON.parse(await readFile(fixture.path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted.find((entry) => entry.id === fixture.created.id)).toMatchObject({ status: "failed" });
    expect(persisted.find((entry) => entry.id === fixture.created.id))
      .not.toHaveProperty("outputPublicationCommitPending");
    const restored = new JobManager(fixture.path, false, null, undefined, undefined, null);
    expect(restored.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    expect(restored.get(fixture.created.id)).toMatchObject({ status: "failed", outputUrl: null });
  });

  it("keeps the exact first prepared claim and raw bytes untouched when snapshot durability enters HOLD", async () => {
    const fixture = await preparedDgxPublicationFixture(false);
    delete fixture.runtimeJob.outputPublicationCommitPending;
    delete fixture.runtimeJob.outputPublication;
    fixture.runtimeJob.finishedAt = null;
    (Reflect.get(fixture.manager, "changed") as () => void).call(fixture.manager);
    const enterPersistenceHold = Reflect.get(fixture.manager, "enterPersistenceHold") as (
      error: unknown,
      details: string,
    ) => JobPersistenceHoldError;
    Reflect.set(fixture.manager, "changed", () => {
      throw enterPersistenceHold.call(
        fixture.manager,
        new Error("synthetic ambiguous first prepared snapshot durability"),
        "synthetic first prepared snapshot HOLD",
      );
    });
    const commitPreparedPublication = Reflect.get(
      fixture.manager,
      "commitPreparedPublication",
    ) as (
      job: Record<string, unknown>,
      authority: Record<string, unknown>,
      completedAt: string,
      metadata: Record<string, unknown>,
      successLog: string,
      failureMessage: string,
      quarantineRoot: string,
    ) => boolean;

    expect(() => commitPreparedPublication.call(
      fixture.manager,
      fixture.runtimeJob,
      fixture.publicationAuthority,
      fixture.completedAt,
      { current_step: "first prepared snapshot HOLD test" },
      "Publication remains recovery-bound.",
      "Publication must not compensate an ambiguous snapshot",
      join(hybridRoot, fixture.created.id),
    )).toThrow(JobPersistenceHoldError);

    expect(fixture.manager.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(fixture.runtimeJob.outputPublicationCommitPending).toMatchObject({
      completedAt: fixture.completedAt,
    });
    expect(fixture.runtimeJob.outputPublication).toEqual(fixture.publicationAuthority);
    expect(fixture.runtimeJob.finishedAt).toBe(fixture.completedAt);
    expect(fixture.runtimeJob.logs).toContain(
      "Ausgabe lokal dauerhaft zum Marker-Commit vorbereitet; DGX completed ist bis nach dem Marker-Fsync gesperrt.",
    );
    await expect(readFile(fixture.outputPath, "utf8"))
      .resolves.toBe("prepared publication crash-boundary bytes");
    await expect(access(fixture.markerPath)).rejects.toThrow();
    await expect(access(join(hybridRoot, fixture.created.id, "unreleased-output.mp4"))).rejects.toThrow();
  });

  it("retries a proven pre-rename final snapshot failure before exposing remote-completed", async () => {
    const fixture = await preparedDgxPublicationFixture(false);
    delete fixture.runtimeJob.outputPublicationCommitPending;
    delete fixture.runtimeJob.outputPublication;
    fixture.runtimeJob.finishedAt = null;
    const realChanged = (Reflect.get(fixture.manager, "changed") as () => void)
      .bind(fixture.manager);
    let changedCalls = 0;
    Reflect.set(fixture.manager, "changed", () => {
      changedCalls += 1;
      if (changedCalls === 2) throw new Error("synthetic final completed snapshot pre-rename failure");
      realChanged();
    });
    const commitPreparedPublication = Reflect.get(
      fixture.manager,
      "commitPreparedPublication",
    ) as (
      job: Record<string, unknown>,
      authority: Record<string, unknown>,
      completedAt: string,
      metadata: Record<string, unknown>,
      successLog: string,
      failureMessage: string,
      quarantineRoot: string,
    ) => boolean;

    expect(commitPreparedPublication.call(
      fixture.manager,
      fixture.runtimeJob,
      fixture.publicationAuthority,
      fixture.completedAt,
      { current_step: "final snapshot retry test" },
      "Publication committed after exact retry.",
      "Publication must not escape without a durable completed snapshot",
      join(hybridRoot, fixture.created.id),
    )).toBe(true);

    const persisted = JSON.parse(await readFile(fixture.path, "utf8")) as Array<Record<string, unknown>>;
    const persistedJob = persisted.find((entry) => entry.id === fixture.created.id)!;
    expect(changedCalls).toBe(3);
    expect(persistedJob).toMatchObject({
      status: "completed",
      outputUrl: `/api/jobs/${fixture.created.id}/output`,
      dgxTerminalDelivery: {
        state: "completed",
        metadata: { current_step: "final snapshot retry test" },
      },
    });
    expect(persistedJob).not.toHaveProperty("outputPublicationCommitPending");
    expect(fixture.manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    await expect(readFile(fixture.markerPath, "utf8")).resolves.toContain(fixture.created.id);
  });

  it("moves a denied final artifact out of the public output root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-unreleased-output-"));
    roots.push(root);
    const output = join(root, "outputs", "result.mp4");
    const quarantine = join(root, "private", "job-1");
    await mkdir(join(root, "outputs"), { recursive: true });
    await writeFile(output, "unreleased");

    const quarantined = quarantineUnreleasedArtifact(output, quarantine);

    expect(quarantined).toBe(join(quarantine, "unreleased-output.mp4"));
    await expect(access(output)).rejects.toThrow();
    await expect(readFile(quarantined!, "utf8")).resolves.toBe("unreleased");
  });

  it("revokes a marker and quarantines an unpublishable artifact during restore", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-restore-quarantine-"));
    roots.push(root);
    const output = join(root, "outputs", "result.mp4");
    const quarantine = join(root, "private", "job-1");
    await mkdir(join(root, "outputs"), { recursive: true });
    await writeFile(output, "raw crash artifact");
    await writeFile(outputPublicationPath(output), "stale marker");

    const quarantined = quarantineRestoredUnpublishedArtifact(output, quarantine);

    expect(quarantined).toBe(join(quarantine, "unreleased-output.mp4"));
    await expect(access(output)).rejects.toThrow();
    await expect(access(outputPublicationPath(output))).rejects.toThrow();
    await expect(readFile(quarantined!, "utf8")).resolves.toBe("raw crash artifact");
  });

  it("preserves an older recovery artifact when another restore output needs quarantine", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-restore-quarantine-generation-"));
    roots.push(root);
    const output = join(root, "outputs", "result.mp4");
    const quarantine = join(root, "private", "job-1");
    const older = join(quarantine, "unreleased-output.mp4");
    await mkdir(join(root, "outputs"), { recursive: true });
    await mkdir(quarantine, { recursive: true });
    await writeFile(output, "new raw crash artifact");
    await writeFile(older, "older recovery artifact");

    const quarantined = quarantineRestoredUnpublishedArtifact(output, quarantine);

    expect(quarantined).not.toBe(older);
    await expect(readFile(older, "utf8")).resolves.toBe("older recovery artifact");
    await expect(readFile(quarantined!, "utf8")).resolves.toBe("new raw crash artifact");
    await expect(access(output)).rejects.toThrow();
  });

  it("preserves raw bytes and terminalizes restart when restore quarantine cannot revoke or move them", async () => {
    const path = await statePath();
    const request = validRequest();
    request.outputName = `restore-preserved-${Date.now()}.mp4`;
    const manager = new JobManager(path, false);
    const created = manager.create(request);
    const outputPath = join(outputRoot, request.outputName);
    const markerPath = outputPublicationPath(outputPath);
    roots.push(outputPath, markerPath, join(hybridRoot, created.id));
    await mkdir(outputRoot, { recursive: true });
    await writeFile(outputPath, "raw bytes that recovery must never delete");
    await writeFile(markerPath, "untrusted marker that recovery cannot remove");
    const rawBefore = await readFile(outputPath);
    const markerBefore = await readFile(markerPath);
    const rawStatsBefore = await stat(outputPath);
    let markerRemovalAttempts = 0;
    let quarantineAttempts = 0;
    const storage = {
      path,
      outputAuthorityReconciliationOperations: {
        removePublicationAuthority: (candidatePath: string) => {
          if (candidatePath === outputPath) {
            markerRemovalAttempts += 1;
            throw new Error("synthetic restore marker revocation failure");
          }
          removeOutputPublicationAuthority(candidatePath);
        },
        quarantineUnreleased: (candidatePath: string, quarantineRoot: string) => {
          if (candidatePath === outputPath) {
            quarantineAttempts += 1;
            throw new Error("synthetic restore quarantine failure");
          }
          return quarantineUnreleasedArtifact(candidatePath, quarantineRoot);
        },
      },
    };

    const firstRestore = new JobManager(storage, false);
    const firstJob = firstRestore.get(created.id)!;
    expect(firstJob).toMatchObject({
      status: "interrupted",
      outputUrl: null,
    });
    expect(firstJob.logs).toContain(
      "Studio-Neustart: Ausgabe ohne gültige Publikationsautorität konnte nicht privat "
        + "quarantänisiert werden; Rohdaten bleiben unverändert am reservierten Pfad, "
        + "sind 404/fail-closed und der Job wird nicht automatisch wieder gestartet.",
    );
    expect(firstJob).not.toHaveProperty("outputPublication");
    expect(Reflect.get(firstRestore, "queue")).toEqual([]);
    expect(await readFile(outputPath)).toEqual(rawBefore);
    expect(await readFile(markerPath)).toEqual(markerBefore);
    expect(await stat(outputPath)).toMatchObject({
      dev: rawStatsBefore.dev,
      ino: rawStatsBefore.ino,
      size: rawStatsBefore.size,
      mtimeMs: rawStatsBefore.mtimeMs,
      ctimeMs: rawStatsBefore.ctimeMs,
    });
    const persistedAfterFirst = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persistedAfterFirst[0]).toMatchObject({
      id: created.id,
      status: "interrupted",
      outputUrl: null,
    });
    expect(persistedAfterFirst[0]).not.toHaveProperty("outputPublication");

    // A second normal-autostart constructor must preserve the terminal fence:
    // no queue entry, process, overwrite, or recovered publication authority.
    const secondRestore = new JobManager(storage, true);
    expect(secondRestore.get(created.id)).toMatchObject({
      status: "interrupted",
      outputUrl: null,
      finishedAt: firstJob.finishedAt,
    });
    expect(secondRestore.get(created.id)).not.toHaveProperty("outputPublication");
    expect(Reflect.get(secondRestore, "queue")).toEqual([]);
    expect(Reflect.get(secondRestore, "runningId")).toBeNull();
    expect(Reflect.get(secondRestore, "activeRunPromise")).toBeNull();
    expect(markerRemovalAttempts).toBeGreaterThanOrEqual(4);
    expect(quarantineAttempts).toBeGreaterThanOrEqual(2);
    expect(await readFile(outputPath)).toEqual(rawBefore);
    expect(await readFile(markerPath)).toEqual(markerBefore);
    expect(() => secondRestore.create(request, { deferStart: true }))
      .toThrow("bereits publiziert oder durch eine dauerhafte Output-Autorität belegt");
    expect(await readFile(outputPath)).toEqual(rawBefore);
    expect(await readFile(markerPath)).toEqual(markerBefore);
  });

  it.each(["queued", "running", "failed"] as const)(
    "quarantines raw bytes and a marker restored beside a %s job",
    async (status) => {
      const path = await statePath();
      const request = validRequest();
      request.outputName = `restore-${status}-${Date.now()}.mp4`;
      const manager = new JobManager(path, false);
      const created = manager.create(request, { deferStart: true });
      const persisted = JSON.parse(await readFile(path, "utf8"));
      persisted[0].status = status;
      persisted[0].startedAt = status === "queued" ? null : "2026-08-25T10:00:00.000Z";
      persisted[0].finishedAt = status === "failed" ? "2026-08-25T10:01:00.000Z" : null;
      persisted[0].error = status === "failed" ? "synthetic failed job" : null;
      if (status !== "queued") delete persisted[0].startDeferred;
      await writeFile(path, JSON.stringify(persisted));
      const outputPath = join(outputRoot, request.outputName);
      roots.push(outputPath, outputPublicationPath(outputPath), join(hybridRoot, created.id));
      await mkdir(outputRoot, { recursive: true });
      await writeFile(outputPath, `raw-${status}`);
      await writeFile(outputPublicationPath(outputPath), `marker-${status}`);

      const restored = new JobManager(path, false);

      await expect(access(outputPath)).rejects.toThrow();
      await expect(access(outputPublicationPath(outputPath))).rejects.toThrow();
      expect(restored.get(created.id)).not.toMatchObject({ status: "completed" });
      expect(restored.get(created.id)?.outputUrl).toBeNull();
    },
  );

  it("heartbeats an active DGX owner and claims progress only once per real Euler advance", async () => {
    vi.useFakeTimers();
    try {
      const dgxJobId = testDgxJobId("heartbeat-test");
      let studioJobId = "";
      const heartbeats: Array<{ jobId: string; payload: Record<string, unknown> }> = [];
      let failNextHeartbeat = false;
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read: async (jobId) => ({
          ...boundDgxRead(studioJobId, jobId, "running"),
        }),
        transition: async (jobId, state) => boundDgxTransition(studioJobId, jobId, state),
        heartbeat: async (jobId, payload) => {
          heartbeats.push({ jobId, payload });
          if (failNextHeartbeat) {
            failNextHeartbeat = false;
            throw new Error("synthetic heartbeat outage");
          }
          return boundDgxHeartbeat(studioJobId, jobId, "running");
        },
      }, null);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
      active.status = "running";
      bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);

      const startHeartbeat = Reflect.get(manager, "startDgxOwnerHeartbeat") as (
        job: unknown,
        phase: string,
      ) => void;
      const markProgress = Reflect.get(manager, "markDgxOwnerProgress") as (job: unknown) => void;
      const stopHeartbeat = Reflect.get(manager, "stopDgxOwnerHeartbeat") as (job: unknown) => Promise<void>;

      startHeartbeat.call(manager, active, "ltx_rendering");
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeats).toEqual([{
        jobId: dgxJobId,
        payload: { runtime_status: { phase: "ltx_rendering" } },
      }]);

      markProgress.call(manager, active);
      failNextHeartbeat = true;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(heartbeats.at(-1)?.payload).toEqual({
        runtime_status: { phase: "ltx_rendering" },
        progressed: true,
      });

      await vi.advanceTimersByTimeAsync(45_000);
      expect(heartbeats.at(-1)?.payload).toEqual({
        runtime_status: { phase: "ltx_rendering" },
        progressed: true,
      });

      await vi.advanceTimersByTimeAsync(45_000);
      expect(heartbeats.at(-1)?.payload).toEqual({
        runtime_status: { phase: "ltx_rendering" },
      });

      await stopHeartbeat.call(manager, active);
      const stoppedAt = heartbeats.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(heartbeats).toHaveLength(stoppedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never turns thermal phase oscillation into progress or extends the no-progress deadline", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const dgxJobId = testDgxJobId("heartbeat-phase-is-not-progress");
      let studioJobId = "";
      const heartbeats: Array<Record<string, unknown>> = [];
      let remoteState: QueueJobState = "running";
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
        transition: async (jobId, state) => {
          remoteState = state;
          return boundDgxTransition(studioJobId, jobId, state);
        },
        heartbeat: async (jobId, payload) => {
          heartbeats.push(structuredClone(payload) as Record<string, unknown>);
          return boundDgxHeartbeat(studioJobId, jobId, "running");
        },
      }, null);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);
      const startHeartbeat = Reflect.get(manager, "startDgxOwnerHeartbeat") as (
        job: unknown,
        phase: string,
      ) => void;
      const setHeartbeatPhase = Reflect.get(manager, "setDgxOwnerHeartbeatPhase") as (
        job: unknown,
        phase: string,
      ) => void;

      startHeartbeat.call(manager, active, "ltx_rendering");
      await vi.advanceTimersByTimeAsync(0);
      const heartbeatState = active.dgxOwnerHeartbeat as Record<string, unknown>;
      expect(heartbeatState).toMatchObject({
        progressEpoch: 0,
        acknowledgedProgressEpoch: 0,
        lastProgressAt: startedAt,
      });

      const phaseStepMs = Math.floor(DGX_OWNER_NO_PROGRESS_TIMEOUT_MS / 10);
      for (let step = 0; step < 9; step += 1) {
        setHeartbeatPhase.call(
          manager,
          active,
          step % 2 === 0 ? "thermal_pause" : "ltx_rendering",
        );
        startHeartbeat.call(
          manager,
          active,
          step % 2 === 0 ? "ltx_rendering" : "thermal_pause",
        );
        await vi.advanceTimersByTimeAsync(phaseStepMs);
        expect(heartbeatState.progressEpoch).toBe(0);
        expect(heartbeatState.lastProgressAt).toBe(startedAt);
      }

      setHeartbeatPhase.call(manager, active, "thermal_pause");
      startHeartbeat.call(manager, active, "ltx_rendering");
      await vi.advanceTimersByTimeAsync(
        DGX_OWNER_NO_PROGRESS_TIMEOUT_MS - (phaseStepMs * 9) - 1,
      );
      expect(manager.get(created.id)?.status).toBe("running");
      expect(heartbeatState.progressEpoch).toBe(0);
      expect(heartbeatState.lastProgressAt).toBe(startedAt);
      expect(heartbeats.length).toBeGreaterThan(1);
      expect(heartbeats.every((payload) => payload.progressed === undefined)).toBe(true);

      await vi.advanceTimersByTimeAsync(1);
      for (let attempt = 0; attempt < 10
        && manager.get(created.id)?.status === "running"; attempt += 1) {
        await Promise.resolve();
      }

      expect(manager.get(created.id)).toMatchObject({
        status: "failed",
        outputUrl: null,
        error: expect.stringContaining("No-Progress-Frist"),
      });
      expect(active.dgxOwnerHeartbeat).toBeUndefined();
      expect(heartbeats.every((payload) => payload.progressed === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts an exactly bound heartbeat response when heartbeat_applied is omitted", async () => {
    vi.useFakeTimers();
    try {
      const dgxJobId = testDgxJobId("heartbeat-optional-applied");
      let studioJobId = "";
      const heartbeat = vi.fn(async (jobId: string) => ({
        schema_version: "dgx-job-heartbeat.v0" as const,
        job: boundDgxJob(studioJobId, jobId, "running"),
      }));
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
        transition: async (jobId, state) => boundDgxTransition(studioJobId, jobId, state),
        heartbeat,
      }, null);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);

      (Reflect.get(manager, "startDgxOwnerHeartbeat") as (
        job: unknown,
        phase: string,
      ) => void).call(manager, active, "ltx_rendering");
      await vi.advanceTimersByTimeAsync(0);

      expect(heartbeat).toHaveBeenCalledTimes(1);
      expect(active.dgxOwnerHeartbeat).toMatchObject({
        acknowledgedOnce: true,
        consecutiveFailures: 0,
      });
      expect(active.dgxOwnerHeartbeat).not.toHaveProperty("failureStartedAt");
      expect(manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
      await (Reflect.get(manager, "stopDgxOwnerHeartbeat") as (
        job: unknown,
      ) => Promise<void>).call(manager, active);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail-stops immediately when heartbeat_applied is explicitly false", async () => {
    vi.useFakeTimers();
    try {
      const dgxJobId = testDgxJobId("heartbeat-explicit-false");
      let studioJobId = "";
      let remoteState: QueueJobState = "running";
      const transition = vi.fn(async (jobId: string, state: QueueTransitionState) => {
        remoteState = state;
        return boundDgxTransition(studioJobId, jobId, state);
      });
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
        transition,
        heartbeat: async (jobId) => ({
          ...boundDgxHeartbeat(studioJobId, jobId, "running"),
          heartbeat_applied: false,
        }) as never,
      }, null);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);

      (Reflect.get(manager, "startDgxOwnerHeartbeat") as (
        job: unknown,
        phase: string,
      ) => void).call(manager, active, "ltx_rendering");
      await vi.advanceTimersByTimeAsync(0);

      expect(manager.get(created.id)).toMatchObject({
        status: "failed",
        outputUrl: null,
        error: expect.stringContaining("explizit nicht"),
      });
      expect(active.dgxOwnerHeartbeat).toBeUndefined();
      expect(transition).toHaveBeenCalledTimes(1);
      expect(manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([0, "false", null] as const)(
    "enters HOLD for malformed heartbeat_applied=%s instead of treating it as an ack",
    async (heartbeatApplied) => {
      vi.useFakeTimers();
      try {
        const dgxJobId = testDgxJobId(`heartbeat-malformed-${String(heartbeatApplied)}`);
        let studioJobId = "";
        const read = vi.fn(async (jobId: string) => boundDgxRead(studioJobId, jobId, "running"));
        const transition = vi.fn(async (jobId: string, state: QueueTransitionState) =>
          boundDgxTransition(studioJobId, jobId, state));
        const manager = new JobManager(await statePath(), false, null, undefined, {
          read,
          transition,
          heartbeat: async (jobId) => ({
            schema_version: "dgx-job-heartbeat.v0",
            heartbeat_applied: heartbeatApplied,
            job: boundDgxJob(studioJobId, jobId, "running"),
          }) as never,
        }, null);
        const created = manager.create(validRequest());
        studioJobId = created.id;
        const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);

        (Reflect.get(manager, "startDgxOwnerHeartbeat") as (
          job: unknown,
          phase: string,
        ) => void).call(manager, active, "ltx_rendering");
        await vi.advanceTimersByTimeAsync(0);

        expect(manager.persistenceHealth()).toMatchObject({
          status: "hold",
          restartRequired: true,
        });
        expect(read).not.toHaveBeenCalled();
        expect(transition).not.toHaveBeenCalled();
        await (Reflect.get(manager, "stopDgxOwnerHeartbeat") as (
          job: unknown,
        ) => Promise<void>).call(manager, active);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([404, 409] as const)(
    "fail-stops local compute immediately on an authoritative heartbeat HTTP %i",
    async (statusCode) => {
      vi.useFakeTimers();
      try {
        const dgxJobId = testDgxJobId(`heartbeat-http-${statusCode}`);
        const read = vi.fn(async () => await new Promise<never>(() => undefined));
        const transition = vi.fn();
        const manager = new JobManager(await statePath(), false, null, undefined, {
          read,
          transition,
          heartbeat: async () => {
            throw new RuntimeApiError("heartbeat lease lost", statusCode, {
              error: statusCode === 404 ? "job_not_found" : "heartbeat_requires_active_job",
            });
          },
        }, null);
        const created = manager.create(validRequest());
        const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);

        (Reflect.get(manager, "startDgxOwnerHeartbeat") as (
          job: unknown,
          phase: string,
        ) => void).call(manager, active, "ltx_rendering");
        await vi.advanceTimersByTimeAsync(0);
        for (let attempt = 0; attempt < 10
          && manager.get(created.id)?.status === "running"; attempt += 1) {
          await Promise.resolve();
        }

        expect(manager.get(created.id)).toMatchObject({
          status: "failed",
          outputUrl: null,
          error: expect.stringContaining(`HTTP ${statusCode}`),
        });
        expect(active.dgxOwnerHeartbeat).toBeUndefined();
        expect(read).toHaveBeenCalledTimes(1);
        expect(transition).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("blocks publication authority after a generic heartbeat outage until an exact re-ack", async () => {
    vi.useFakeTimers();
    try {
      const dgxJobId = testDgxJobId("heartbeat-reack-publication");
      let studioJobId = "";
      let heartbeatCalls = 0;
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
        transition: async (jobId, state) => boundDgxTransition(studioJobId, jobId, state),
        heartbeat: async (jobId) => {
          heartbeatCalls += 1;
          if (heartbeatCalls === 2) throw new Error("synthetic transient heartbeat outage");
          return boundDgxHeartbeat(studioJobId, jobId, "running");
        },
      }, null);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);
      const startHeartbeat = Reflect.get(manager, "startDgxOwnerHeartbeat") as (
        job: unknown,
        phase: string,
      ) => void;
      const stopHeartbeat = Reflect.get(manager, "stopDgxOwnerHeartbeat") as (
        job: unknown,
      ) => Promise<void>;

      startHeartbeat.call(manager, active, "ltx_rendering");
      await vi.advanceTimersByTimeAsync(0);
      expect(active.dgxOwnerHeartbeat).toMatchObject({ acknowledgedOnce: true });

      await vi.advanceTimersByTimeAsync(DGX_OWNER_HEARTBEAT_INTERVAL_MS);
      expect(active.dgxOwnerHeartbeat).toMatchObject({
        acknowledgedOnce: true,
        failureStartedAt: expect.any(Number),
        consecutiveFailures: 1,
      });

      await vi.advanceTimersByTimeAsync(DGX_OWNER_HEARTBEAT_INTERVAL_MS);
      expect(active.dgxOwnerHeartbeat).not.toHaveProperty("failureStartedAt");
      expect((Reflect.get(manager, "hasOutputReleaseAuthority") as (
        job: unknown,
        boundary: string,
      ) => boolean).call(manager, active, "dem Test-Publikations-Commit")).toBe(true);
      await stopHeartbeat.call(manager, active);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the independent ack deadline while heartbeat failure recovery GET is hung", async () => {
    vi.useFakeTimers();
    try {
      const dgxJobId = testDgxJobId("heartbeat-independent-deadline");
      let studioJobId = "";
      let heartbeatCalls = 0;
      const requestFailureDelayMs = Math.max(
        1,
        Math.min(
          30_000,
          DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS - DGX_OWNER_HEARTBEAT_INTERVAL_MS - 1,
        ),
      );
      const read = vi.fn(async () => await new Promise<never>(() => undefined));
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read,
        transition: vi.fn(),
        heartbeat: async (jobId) => {
          heartbeatCalls += 1;
          if (heartbeatCalls === 1) {
            return boundDgxHeartbeat(studioJobId, jobId, "running");
          }
          return await new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error("synthetic heartbeat request timeout")), requestFailureDelayMs);
          });
        },
      }, null);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);

      (Reflect.get(manager, "startDgxOwnerHeartbeat") as (
        job: unknown,
        phase: string,
      ) => void).call(manager, active, "ltx_rendering");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(
        DGX_OWNER_HEARTBEAT_INTERVAL_MS + requestFailureDelayMs,
      );

      expect(active.dgxOwnerHeartbeat).toMatchObject({
        failureStartedAt: expect.any(Number),
        consecutiveFailures: 1,
      });
      expect(read).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(
        DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS
          - DGX_OWNER_HEARTBEAT_INTERVAL_MS
          - requestFailureDelayMs,
      );
      for (let attempt = 0; attempt < 10
        && manager.get(created.id)?.status === "running"; attempt += 1) {
        await Promise.resolve();
      }

      expect(manager.get(created.id)).toMatchObject({
        status: "failed",
        outputUrl: null,
        error: expect.stringContaining("unabhängige Sicherheitsfrist"),
      });
      expect(active.dgxOwnerHeartbeat).toBeUndefined();
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enters HOLD when heartbeat fail-stop cannot prove an owned Docker container stopped", async () => {
    vi.useFakeTimers();
    try {
      const dgxJobId = testDgxJobId("heartbeat-docker-stop-hold");
      let studioJobId = "";
      const transition = vi.fn(async (jobId: string, state: QueueTransitionState) =>
        boundDgxTransition(studioJobId, jobId, state));
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
        transition,
        heartbeat: async (jobId) => ({
          ...boundDgxHeartbeat(studioJobId, jobId, "running"),
          heartbeat_applied: false,
        }) as never,
      }, null);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);
      const containerName = `ltx-latentsync-${created.id}`;
      const fixture = ownedDockerFixture(containerName, dgxJobId, {
        failStop: true,
        failRemove: true,
      });
      Reflect.set(manager, "ownedDockerOperations", fixture.operations);
      (Reflect.get(manager, "bindOwnedDockerContainer") as (
        job: unknown,
        name: string,
        workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
      ) => void).call(
        manager,
        active,
        containerName,
        OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
      );
      (Reflect.get(manager, "markOwnedDockerStartGateReleased") as (
        job: unknown,
      ) => void).call(manager, active);

      (Reflect.get(manager, "startDgxOwnerHeartbeat") as (
        job: unknown,
        phase: string,
      ) => void).call(manager, active, "latentsync_refinement");
      await vi.advanceTimersByTimeAsync(0);
      for (let attempt = 0; attempt < 10
        && manager.persistenceHealth().status !== "hold"; attempt += 1) {
        await Promise.resolve();
      }

      expect(manager.get(created.id)).toMatchObject({ status: "failed", outputUrl: null });
      expect(manager.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
      expect(active.ownedDockerContainer).toBeDefined();
      expect(fixture.exists()).toBe(true);
      const dockerMutations = fixture.mutationCommands().map((args) => args[0]);
      expect(dockerMutations.slice(0, 2)).toEqual(["stop", "rm"]);
      expect(dockerMutations.every((action) => action === "stop" || action === "rm")).toBe(true);
      expect(transition).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not mutate heartbeat authority when a deferred response resolves after HOLD", async () => {
    const dgxJobId = testDgxJobId("deferred-heartbeat-hold");
    let studioJobId = "";
    let heartbeatStartedResolve!: () => void;
    const heartbeatStarted = new Promise<void>((resolvePromise) => {
      heartbeatStartedResolve = resolvePromise;
    });
    let releaseHeartbeatResolve!: () => void;
    const releaseHeartbeat = new Promise<void>((resolvePromise) => {
      releaseHeartbeatResolve = resolvePromise;
    });
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (jobId, state) => boundDgxTransition(studioJobId, jobId, state),
      heartbeat: async (jobId) => {
        heartbeatStartedResolve();
        await releaseHeartbeat;
        return boundDgxHeartbeat(studioJobId, jobId, "running");
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "running";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const logsBefore = [...active.logs as string[]];
    (Reflect.get(manager, "startDgxOwnerHeartbeat") as (
      job: unknown,
      phase: string,
    ) => void).call(manager, active, "ltx_rendering");
    await heartbeatStarted;
    const heartbeatState = active.dgxOwnerHeartbeat as Record<string, unknown>;
    Reflect.set(
      manager,
      "persistenceHold",
      new JobPersistenceHoldError("synthetic heartbeat HOLD", new Error("synthetic")),
    );
    const changed = vi.fn(() => {
      throw new Error("heartbeat continuation must not persist in HOLD");
    });
    Reflect.set(manager, "changed", changed);

    releaseHeartbeatResolve();
    for (let attempt = 0; attempt < 20 && heartbeatState.inFlight; attempt += 1) {
      await Promise.resolve();
    }
    await (Reflect.get(manager, "stopDgxOwnerHeartbeat") as (
      job: unknown,
    ) => Promise<void>).call(manager, active);

    expect(changed).not.toHaveBeenCalled();
    expect(heartbeatState.acknowledgedProgressEpoch).toBe(0);
    expect(active.logs).toEqual(logsBefore);
  });

  it("terminalizes a non-cooperative run when its activation becomes invalid between heartbeats", async () => {
    vi.useFakeTimers();
    try {
      let allowed = true;
      const decide = () => ({
        allowed,
        mode: allowed ? "production_stable" as const : "hold" as const,
        reason: allowed ? "released" : "runtime rights snapshot revoked",
        schemaVersion: "ltx-studio-activation-start-enforcer.v3" as const,
        generation: 2,
        activationHeadSha256: "a".repeat(64),
      });
      const heartbeats: string[] = [];
      const dgxJobId = testDgxJobId("rights-revoke");
      let studioJobId = "";
      const manager = new JobManager(
        await statePath(),
        false,
        null,
        undefined,
        {
          read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
          transition: async (jobId, state) => boundDgxTransition(studioJobId, jobId, state),
          heartbeat: async (jobId) => {
            heartbeats.push(jobId);
            return boundDgxHeartbeat(studioJobId, jobId, "running");
          },
        },
        null,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          decide,
          inspect: () => ({ ...decide(), productStartsAllowed: allowed }),
        },
      );
      const created = manager.create(validRequest("two-stage-hq"));
      studioJobId = created.id;
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
      active.status = "running";
      bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
      const startHeartbeat = Reflect.get(manager, "startDgxOwnerHeartbeat") as (job: unknown, phase: string) => void;

      startHeartbeat.call(manager, active, "ltx_rendering");
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeats).toHaveLength(1);
      allowed = false;
      await vi.advanceTimersByTimeAsync(45_000);

      expect(manager.get(created.id)).toMatchObject({
        status: "failed",
        outputUrl: null,
      });
      expect(manager.get(created.id)?.error).toContain("runtime rights snapshot revoked");
      expect(heartbeats).toHaveLength(1);
      expect(Reflect.get(active, "dgxOwnerHeartbeat")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds one exact audio window contract for every optional lip refiner", () => {
    const request = validRequest();
    request.mode = "image-audio-to-video";
    request.audio.path = "/inputs/clean.flac";
    request.audio.startTime = 1.25;
    request.audio.maxDuration = 3.5;
    expect(buildRefinerAudioArgs(request)).toEqual([
      "--audio", "/inputs/clean.flac",
      "--audio-start", "1.25",
      "--audio-duration", "3.5",
    ]);
    request.audio.maxDuration = null;
    expect(buildRefinerAudioArgs(request)).toEqual([
      "--audio", "/inputs/clean.flac",
      "--audio-start", "1.25",
    ]);
    request.audio.path = "";
    expect(buildRefinerAudioArgs(request)).toEqual([]);

    // The ID-LoRA reference audio is a voice-cloning sample, never the spoken
    // content: the native speech stack renders the dialogue into the base
    // video, so the refiner must sync against the base video's own track.
    request.mode = "id-lora";
    request.idLora.referenceAudio = {
      path: "/inputs/id-reference.flac",
      name: "id-reference.flac",
    };
    expect(buildRefinerAudioArgs(request)).toEqual([]);

    request.mode = "lipdub";
    request.lipDub.referenceVideo = {
      path: "/inputs/lipdub-reference.mp4",
      name: "lipdub-reference.mp4",
      strength: 1,
    };
    expect(buildRefinerAudioArgs(request)).toEqual([
      "--audio", "/inputs/lipdub-reference.mp4",
      "--audio-start", "0",
    ]);

    request.mode = "two-stage";
    request.audio.path = "/inputs/stale-form-value.flac";
    expect(buildRefinerAudioArgs(request)).toEqual([]);
  });

  it("explains a LipForcing unified-memory failure without a cryptic exit code", () => {
    expect(describeLipForcingFailure(
      [
        "Loading SF checkpoint from /models/lipforcing/lipforcing_14b.pth ...",
        "torch.AcceleratorError: CUDA error: out of memory",
        "LipForcing: Fehler: LipForcing-Container endete mit Code 1.",
      ],
      { code: 1, signal: null, error: null },
    )).toContain("gemeinsamen CPU-/GPU-Speicher");
  });

  it("reuses an LTX base only when generation settings are otherwise identical", () => {
    const original = validRequest();
    const hybrid = structuredClone(original);
    hybrid.outputName = "hybrid.mp4";
    hybrid.postprocess.longcatLipsync.enabled = true;
    hybrid.postprocess.longcatLipsync.blend = 0.55;
    hybrid.continuity.notes = "Refiner-Vergleich mit identischer LTX-Basis.";

    expect(requestsShareLtxBase(original, hybrid)).toBe(true);
    hybrid.audio.finalMix = { path: "/inputs/final-mix.wav", name: "final-mix.wav" };
    expect(requestsShareLtxBase(original, hybrid)).toBe(true);
    expect(publishedOutputIsReusableLtxBase(hybrid, original)).toBe(false);
    expect(publishedOutputIsReusableLtxBase(original, hybrid)).toBe(true);
    hybrid.seed += 1;
    expect(requestsShareLtxBase(original, hybrid)).toBe(false);
  });

  it("reuses a LipForcing picture stream only when the audible timing is the sole change", () => {
    const source = validRequest();
    source.postprocess.lipForcing.enabled = true;
    source.postprocess.lipForcing.mouthDelayMs = 125;
    const target = structuredClone(source);
    target.outputName = "retimed.mp4";
    target.postprocess.lipForcing.programAudioDelayMs = 125;

    expect(requestsShareLipForcingVisual(source, target)).toBe(true);
    expect(publishedOutputIsReusableLipForcingVisual(source, target)).toBe(true);
    target.postprocess.lipForcing.mouthDelayMs = 0;
    expect(requestsShareLipForcingVisual(source, target)).toBe(false);
    expect(publishedOutputIsReusableLipForcingVisual(source, target)).toBe(false);
  });

  it("builds a video-copy-only remux for positive and negative speech timing corrections", () => {
    const delayed = buildLipForcingAudioRetimeArgs("source.mp4", "target.mp4", 125);
    expect(delayed).toContain("copy");
    expect(delayed).toContain("adelay=125:all=1,aresample=48000,apad");
    expect(delayed).toContain("-shortest");

    const advanced = buildLipForcingAudioRetimeArgs("source.mp4", "target.mp4", -125);
    expect(advanced).toContain("atrim=start=0.125000000,asetpts=PTS-STARTPTS,aresample=48000,apad");
    expect(() => buildLipForcingAudioRetimeArgs("source.mp4", "target.mp4", 1_001)).toThrow();
  });

  it("reuses a rendered LTX base with matching verified model and runtime provenance", () => {
    const baseline = runProvenance();
    expect(runProvenanceSharesLtxBase(
      runProvenance({ includeFinalMix: true }),
      runProvenance({ includeLongCat: true }),
    )).toBe(true);
    expect(runProvenanceSharesLtxBase(baseline, runProvenance({ modelSha: "1".repeat(64) }))).toBe(false);
    expect(runProvenanceSharesLtxBase(baseline, runProvenance({ codeSha: "2".repeat(64) }))).toBe(true);
    expect(runProvenanceSharesLtxBase(baseline, runProvenance({ runtimeSha: "3".repeat(64) }))).toBe(false);
    expect(runProvenanceSharesLtxBase(baseline, runProvenance({ verified: false }))).toBe(true);
    expect(runProvenanceSharesLtxBase(runProvenance({ verified: false }), baseline)).toBe(false);
    expect(runProvenanceSharesLtxBase(null, baseline)).toBe(false);
  });

  it("requires the candidate provenance to retain the exact baseline image identity", () => {
    const imageA = testLipForcingContainerIdentity("a");
    const imageB = testLipForcingContainerIdentity("b");
    const candidateProvenance = {
      ...runProvenance(),
      containerImages: [imageA],
    };

    expect(runProvenanceUsesExactLipForcingImage(candidateProvenance, imageA)).toBe(true);
    expect(runProvenanceUsesExactLipForcingImage(candidateProvenance, imageB)).toBe(false);
    expect(runProvenanceUsesExactLipForcingImage(null, imageA)).toBe(false);
  });

  it("keeps every pre-remux video outside the public output path", () => {
    const finalOutput = "/outputs/final.mp4";
    const stageRoot = "/staging/job";

    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      refinedOutput: "/staging/job/latentsync-refined.mp4",
      remuxInput: "/staging/job/ltx-base.mp4",
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, true, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      refinedOutput: "/staging/job/latentsync-refined.mp4",
      remuxInput: "/staging/job/longcat-composite.mp4",
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, false, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      refinedOutput: finalOutput,
      remuxInput: finalOutput,
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, true, false, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      refinedOutput: "/staging/job/musetalk-refined.mp4",
      remuxInput: "/staging/job/musetalk-refined.mp4",
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, false).ltxOutput).toBe(finalOutput);
  });

  it("treats thermally paused jobs as active", () => {
    expect(isActiveJobStatus("paused")).toBe(true);
  });

  it("restores a purely local queued job without inventing an interruption", async () => {
    const path = await statePath();
    const request = withOfficialSpeechModelPaths(validRequest());
    const id = "00000000-0000-4000-8000-000000000099";
    await writeFile(path, JSON.stringify([{
      id,
      status: "queued",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      logs: ["waiting locally"],
      command: "ignored",
      request,
      localProcessProtocol: "fd-gate.v1",
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: null,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: null,
      identityEvidence: null,
      runProvenance: null,
    }]));

    const restored = new JobManager(path, false);

    expect(restored.get(id)).toMatchObject({
      status: "queued",
      dgxJobId: null,
      error: null,
    });
    expect(restored.get(id)?.logs.at(-1)).toContain("automatisch fortgesetzt");
    expect(restored.get(id)?.executionClass).toBeUndefined();
    expect(Reflect.get(restored, "queue")).toEqual([id]);
  });

  it("enters startup HOLD for an existing truncated authority snapshot instead of starting fresh", async () => {
    const path = await statePath();
    await writeFile(
      path,
      '[{"id":"11111111-1111-4111-8111-111111111111","dgxJobId":"dgx-job-orphan","ownedDockerContainer":',
    );
    const submit = vi.fn(async () => {
      throw new Error("corrupt restore must never submit");
    });
    const manager = new JobManager(path, true, null, undefined, undefined, null, { submit });

    expect(manager.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(() => manager.create(validRequest())).toThrow(JobPersistenceHoldError);
    expect(() => manager.outputAuthorityList()).toThrow(JobPersistenceHoldError);
    expect(submit).not.toHaveBeenCalled();
    expect(Reflect.get(manager, "queue")).toEqual([]);
  });

  it.each([
    ["invalid request with DGX lease", (entry: Record<string, unknown>) => {
      entry.request = {};
      entry.status = "running";
      entry.dgxJobId = "dgx-job-invalid-request";
    }],
    ["invalid UUID with PG marker", (entry: Record<string, unknown>) => {
      entry.id = "------------------------------------";
      entry.status = "running";
      entry.localProcessGroupPending = true;
      entry.localProcessGroupIdentity = {
        bootId: "11111111-1111-4111-8111-111111111111",
        processGroupId: 12345,
        leaderStartTicks: "1",
      };
    }],
    ["invalid request with owned Docker marker", (entry: Record<string, unknown>) => {
      entry.request = {};
      entry.status = "cancelled";
      entry.dgxJobId = "dgx-job-invalid-docker-request";
      entry.ownedDockerContainer = {
        schemaVersion: "ltx-studio-owned-docker-container.v2",
        name: `ltx-latentsync-${String(entry.id)}`,
        containerId: null,
        dgxJobId: entry.dgxJobId,
        workload: "latentsync",
        state: "bound",
        startGateReleasedAt: null,
        absenceProofStartedAt: null,
        absenceProofCount: 0,
      };
    }],
    ["unknown status with DGX lease", (entry: Record<string, unknown>) => {
      entry.status = "runing";
      entry.dgxJobId = "dgx-job-status-typo";
    }],
    ["malformed DGX ID on queued job", (entry: Record<string, unknown>) => {
      entry.status = "queued";
      entry.dgxJobId = "not-a-dgx-job";
    }],
    ["invalid output publication owner", (entry: Record<string, unknown>) => {
      entry.id = "------------------------------------";
      entry.status = "completed";
      entry.request = {};
      entry.dgxJobId = null;
      delete entry.executionClass;
      delete entry.executionDecision;
      entry.outputPublication = { schemaVersion: "forged" };
    }],
    ["malformed output publication marker", (entry: Record<string, unknown>) => {
      entry.status = "completed";
      entry.finishedAt = new Date().toISOString();
      entry.dgxJobId = null;
      delete entry.executionClass;
      delete entry.executionDecision;
      entry.outputPublication = { schemaVersion: "forged" };
    }],
    ["malformed active execution marker", (entry: Record<string, unknown>) => {
      entry.status = "running";
      entry.startedAt = new Date().toISOString();
      entry.dgxJobId = "dgx-job-malformed-execution-authority";
      entry.executionClass = "dgx";
      entry.executionDecision = { executionClass: "dgx", requestSha256: "broken" };
    }],
    ["non-boolean start fence", (entry: Record<string, unknown>) => {
      entry.status = "queued";
      entry.startDeferred = "yes";
    }],
    ["start fence contradicts a remote start", (entry: Record<string, unknown>) => {
      entry.status = "running";
      entry.startDeferred = true;
      entry.startedAt = new Date().toISOString();
      entry.dgxJobId = "dgx-job-contradictory-start-fence";
    }],
    ["spawn marker conflicts with a process-group marker", (entry: Record<string, unknown>) => {
      entry.status = "running";
      entry.localProcessProtocol = "fd-gate.v1";
      entry.localProcessSpawnPending = true;
      entry.localProcessGroupPending = true;
      entry.localProcessGroupIdentity = {
        bootId: "11111111-1111-4111-8111-111111111111",
        processGroupId: 12345,
        leaderStartTicks: "1",
      };
    }],
    ["completed job still claims an unsettled local spawn", (entry: Record<string, unknown>) => {
      entry.status = "completed";
      entry.startedAt = new Date(Date.now() - 1_000).toISOString();
      entry.finishedAt = new Date().toISOString();
      entry.localProcessProtocol = "fd-gate.v1";
      entry.localProcessSpawnPending = true;
    }],
  ] as const)("enters startup HOLD for raw authority preflight: %s", async (_case, mutate) => {
    const path = await statePath();
    const seed = new JobManager(path, false);
    seed.create(validRequest());
    const stored = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    mutate(stored[0]!);
    await writeFile(path, JSON.stringify(stored));
    const read = vi.fn(async () => {
      throw new Error("raw authority preflight must not read DGX");
    });
    const transition = vi.fn(async () => {
      throw new Error("raw authority preflight must not transition DGX");
    });
    const submit = vi.fn(async () => {
      throw new Error("raw authority preflight must not submit DGX");
    });

    const restored = new JobManager(path, true, null, undefined, { read, transition }, null, { submit });

    expect(restored.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(restored.list()).toEqual([]);
    expect(Reflect.get(restored, "queue")).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(() => restored.create(validRequest())).toThrow(JobPersistenceHoldError);
  });

  it.each([
    ["wrong Studio ID", (entry: Record<string, unknown>) => {
      (entry.dgxTerminalReceipt as Record<string, unknown>).studioJobId =
        "11111111-1111-4111-8111-111111111111";
    }],
    ["wrong DGX ID", (entry: Record<string, unknown>) => {
      (entry.dgxTerminalReceipt as Record<string, unknown>).dgxJobId = "dgx-job-other-receipt";
    }],
    ["wrong caller binding", (entry: Record<string, unknown>) => {
      (entry.dgxTerminalReceipt as Record<string, unknown>).idempotencyKey = "ltx-studio:other";
    }],
    ["active remote state", (entry: Record<string, unknown>) => {
      (entry.dgxTerminalReceipt as Record<string, unknown>).remoteTerminalState = "running";
    }],
    ["wrong evidence schema", (entry: Record<string, unknown>) => {
      ((entry.dgxTerminalReceipt as Record<string, unknown>).evidence as Record<string, unknown>)
        .schemaVersion = "dgx-job-read.v1";
    }],
    ["non-canonical confirmation time", (entry: Record<string, unknown>) => {
      const receipt = entry.dgxTerminalReceipt as Record<string, unknown>;
      receipt.confirmedAt = String(receipt.confirmedAt).replace("Z", "+00:00");
    }],
    ["receipt plus pending delivery", (entry: Record<string, unknown>) => {
      entry.dgxTerminalDelivery = {
        state: "cancelled",
        metadata: { current_step: "contradictory delivery" },
        attempts: 0,
        lastError: null,
        updatedAt: new Date().toISOString(),
      };
    }],
    ["receipt plus ambiguous submit", (entry: Record<string, unknown>) => {
      entry.dgxSubmitPending = true;
      entry.dgxSubmitStartedAt = new Date().toISOString();
    }],
    ["receipt plus local spawn authority", (entry: Record<string, unknown>) => {
      entry.localProcessSpawnPending = true;
    }],
    ["receipt attached to an active job", (entry: Record<string, unknown>) => {
      entry.status = "running";
      entry.finishedAt = null;
    }],
    ["receipt with an extra field", (entry: Record<string, unknown>) => {
      (entry.dgxTerminalReceipt as Record<string, unknown>).trusted = true;
    }],
  ] as const)("enters startup HOLD for an invalid DGX terminal receipt: %s", async (
    _case,
    mutate,
  ) => {
    const path = await statePath();
    const dgxJobId = testDgxJobId(`strict-receipt-${_case}`);
    let studioJobId = "";
    const seed = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "cancelled"),
      transition: async () => {
        throw new Error("terminal GET should prevent PATCH while seeding the receipt");
      },
    }, null);
    const created = seed.create(validRequest());
    studioJobId = created.id;
    const seedJob = (Reflect.get(seed, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    seedJob.runProvenance = runProvenance();
    expect((Reflect.get(seed, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(seed, seedJob, "dgx")).toBe(true);
    seedJob.status = "cancelled";
    seedJob.cancelledBy = "studio";
    seedJob.startedAt = new Date(Date.now() - 1_000).toISOString();
    seedJob.finishedAt = new Date().toISOString();
    bindTestDgxLease(
      seedJob,
      created.id,
      dgxJobId,
      seedJob.request as ReturnType<typeof validRequest>,
    );
    (Reflect.get(seed, "queue") as string[]).splice(
      (Reflect.get(seed, "queue") as string[]).indexOf(created.id),
      1,
    );
    (Reflect.get(seed, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(seed, seedJob, "cancelled", { current_step: "strict receipt seed" });
    (Reflect.get(seed, "changed") as () => void).call(seed);
    const seedFlush = Reflect.get(seed, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;
    await expect(seedFlush.call(seed, seedJob)).resolves.toBe(true);

    const stored = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(stored[0]).toHaveProperty("dgxTerminalReceipt");
    mutate(stored[0]!);
    await writeFile(path, JSON.stringify(stored));
    const read = vi.fn(async () => {
      throw new Error("invalid receipt preflight must not read DGX");
    });
    const transition = vi.fn(async () => {
      throw new Error("invalid receipt preflight must not transition DGX");
    });
    const submit = vi.fn(async () => {
      throw new Error("invalid receipt preflight must not submit DGX");
    });

    const restored = new JobManager(path, true, null, undefined, { read, transition }, null, { submit });

    expect(restored.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(restored.list()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(["running", "paused"] as const)(
    "enters startup HOLD for a markerless legacy %s execution",
    async (status) => {
      const path = await statePath();
      const seed = new JobManager(path, false);
      const created = seed.create(validRequest());
      const active = (Reflect.get(seed, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      active.runProvenance = runProvenance();
      expect((Reflect.get(seed, "classifyExecution") as (
        job: unknown,
        executionClass: "dgx",
      ) => boolean).call(seed, active, "dgx")).toBe(true);
      active.status = status;
      active.startedAt = new Date().toISOString();
      active.dgxJobId = testDgxJobId(`markerless-${status}`);
      delete active.localProcessProtocol;
      const queue = Reflect.get(seed, "queue") as string[];
      queue.splice(queue.indexOf(created.id), 1);
      (Reflect.get(seed, "changed") as () => void).call(seed);
      const read = vi.fn(async () => {
        throw new Error("markerless legacy preflight must not read DGX");
      });
      const transition = vi.fn(async () => {
        throw new Error("markerless legacy preflight must not transition DGX");
      });
      const submit = vi.fn(async () => {
        throw new Error("markerless legacy preflight must not submit DGX");
      });

      const restored = new JobManager(path, true, null, undefined, { read, transition }, null, { submit });

      expect(restored.persistenceHealth()).toEqual({
        status: "hold",
        restartRequired: true,
        code: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
        reason: PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
      });
      expect(restored.list()).toEqual([]);
      expect(Reflect.get(restored, "queue")).toEqual([]);
      expect(read).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("enters startup HOLD before duplicate IDs can overwrite an earlier execution authority", async () => {
    const path = await statePath();
    const seed = new JobManager(path, false);
    seed.create(validRequest());
    const stored = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    const duplicate = structuredClone(stored[0]!);
    duplicate.status = "failed";
    duplicate.dgxJobId = null;
    duplicate.finishedAt = new Date().toISOString();
    delete duplicate.localProcessGroupPending;
    delete duplicate.localProcessGroupIdentity;
    delete duplicate.ownedDockerContainer;
    delete duplicate.dgxTerminalDelivery;
    stored[0]!.status = "running";
    stored[0]!.dgxJobId = testDgxJobId("duplicate-first");
    stored.push(duplicate);
    await writeFile(path, JSON.stringify(stored));
    const transition = vi.fn();
    const submit = vi.fn();

    const restored = new JobManager(
      path,
      true,
      null,
      undefined,
      { read: vi.fn(), transition },
      null,
      { submit },
    );

    expect(restored.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(restored.list()).toEqual([]);
    expect(transition).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it("fails a restored queued DFR at the pump boundary before any runner starts", async () => {
    const path = await statePath();
    const request = withOfficialSpeechModelPaths(validRequest("dfr"));
    request.models.distilledLora.path = "";
    const id = "00000000-0000-4000-8000-000000000098";
    await writeFile(path, JSON.stringify([{
      id,
      status: "queued",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      logs: ["historically queued before the qualification gate"],
      command: "ignored",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: null,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: null,
      identityEvidence: null,
      runProvenance: null,
    }]));
    const restored = new JobManager(path, false);
    expect(restored.get(id)?.status).toBe("queued");
    expect(Reflect.get(restored, "queue")).toEqual([id]);

    const pump = Reflect.get(restored, "pump") as () => Promise<void>;
    await pump.call(restored);

    expect(restored.get(id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Qualification-HOLD"),
    });
    expect(Reflect.get(restored, "queue")).toEqual([]);
    expect(Reflect.get(restored, "runningId")).toBeNull();
    expect(() => restored.rerun(id, "exact")).toThrow(/Qualification-HOLD/u);
  });

  it("persists monotone ExecutionDecision.v6 and never guesses a legacy class", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());

    expect(created.executionClass).toBe("pending");
    expect(JSON.parse(await readFile(path, "utf8"))[0]).toMatchObject({
      id: created.id,
      executionClass: "pending",
      executionDecision: {
        schemaVersion: "ltx-studio-execution-decision.v6",
        executionClass: "pending",
        requestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        protocolSha256: null,
      },
    });
    expect(new JobManager(path, false).get(created.id)?.executionClass).toBe("pending");

    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    runtimeJob.runProvenance = runProvenance();
    const classify = Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx" | "cpu-only",
    ) => boolean;
    expect(classify.call(manager, runtimeJob, "dgx")).toBe(true);
    expect(manager.get(created.id)?.executionClass).toBe("dgx");
    expect(manager.get(created.id)?.executionDecision).toMatchObject({
      executionClass: "dgx",
      cpuReuse: null,
      operation: null,
    });
    expect(new JobManager(path, false).get(created.id)?.executionClass).toBe("dgx");

    expect(classify.call(manager, runtimeJob, "cpu-only")).toBe(false);
    expect(manager.get(created.id)).toMatchObject({
      executionClass: "dgx",
      status: "failed",
    });
    expect(manager.get(created.id)?.error).toContain("fail-closed");
  });

  it("keeps raw Decision.v5 immutable but blocks an active migrated working copy", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const request = validRequest("two-stage");
    request.outputName = "legacy-authority-working-copy.mp4";
    const created = manager.create(request, { deferStart: true });
    const stored = JSON.parse(await readFile(path, "utf8"));
    delete stored[0].request.textToAudio;
    const rawRequest = structuredClone(stored[0].request);
    const rawRequestSha256 = createHash("sha256").update(canonicalJson(rawRequest)).digest("hex");
    stored[0].executionDecision.requestSha256 = rawRequestSha256;
    await writeFile(path, JSON.stringify(stored, null, 2));

    const restored = new JobManager(path, false);
    const publicRestored = restored.get(created.id)!;
    const runtimeJob = (Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;

    expect(publicRestored).toMatchObject({
      status: "failed",
      executionClass: "pending",
      request: { textToAudio: { peakCeilingDbfs: -3 } },
      executionDecision: { requestSha256: rawRequestSha256 },
      error: expect.stringContaining("Request-Migration"),
    });
    expect(Object.hasOwn(publicRestored, "authorityBoundRequest")).toBe(false);
    expect(runtimeJob.authorityBoundRequest).toEqual(rawRequest);
    expect(runtimeJob.authorityRequestSha256).toBe(rawRequestSha256);

    expect(Reflect.get(restored, "queue")).toEqual([]);
    const repersisted = JSON.parse(await readFile(path, "utf8"));
    expect(repersisted[0].request).toEqual(rawRequest);
    expect(Object.hasOwn(repersisted[0].request, "textToAudio")).toBe(false);
    expect(repersisted[0].executionDecision.requestSha256).toBe(rawRequestSha256);
  });

  it.each([true, false])(
    "handles a queued legacy model-path rewrite only with an existing Decision.v5=%s authority",
    async (withDecision) => {
      const path = await statePath();
      const manager = new JobManager(path, false);
      const request = validRequest("two-stage");
      request.outputName = `legacy-model-path-${withDecision ? "v5" : "pre-v5"}.mp4`;
      request.promptParts.dialogue = "Guten Morgen.";
      const created = manager.create(request, { deferStart: true });
      const stored = JSON.parse(await readFile(path, "utf8"));
      stored[0].request.enhancePrompt = true;
      stored[0].request.models.checkpointPath = "/legacy/dev.safetensors";
      stored[0].request.models.gemmaRoot = "/legacy/gemma";
      stored[0].request.models.distilledLora.path = "/legacy/distilled-lora.safetensors";
      stored[0].request.models.spatialUpscalerPath = "/legacy/upscaler.safetensors";
      if (withDecision) {
        stored[0].executionDecision.requestSha256 = createHash("sha256")
          .update(canonicalJson(stored[0].request))
          .digest("hex");
      } else {
        delete stored[0].executionClass;
        delete stored[0].executionDecision;
      }
      await writeFile(path, JSON.stringify(stored));

      const restored = new JobManager(path, false);
      const runtimeJob = (Reflect.get(restored, "jobs") as Map<string, {
        plan: { args: string[] };
      }>).get(created.id)!;

      expect(restored.get(created.id)).toMatchObject({
        status: "failed",
        request: {
          enhancePrompt: true,
          models: { checkpointPath: "/legacy/dev.safetensors" },
        },
        error: expect.stringContaining("Request-Migration"),
        ...(withDecision ? { executionClass: "pending" } : { executionClass: undefined }),
      });
      expect(runtimeJob.plan.args).toContain("/legacy/dev.safetensors");
      expect(runtimeJob.plan.args).not.toContain(recommendedModelAsset("ltx23-dev-fp8-checkpoint").localPath);
      expect(Reflect.get(restored, "queue")).toEqual([]);
    },
  );

  it("still rejects genuine raw-request mutation after legacy default migration", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const request = validRequest("two-stage");
    request.outputName = "legacy-authority-tamper.mp4";
    const created = manager.create(request, { deferStart: true });
    const stored = JSON.parse(await readFile(path, "utf8"));
    delete stored[0].request.textToAudio;
    stored[0].executionDecision.requestSha256 = createHash("sha256")
      .update(canonicalJson(stored[0].request))
      .digest("hex");
    stored[0].request.prompt = "unauthorized mutation";
    await writeFile(path, JSON.stringify(stored));

    const restored = new JobManager(path, false);

    expect(restored.get(created.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Request- oder Protokollbindung"),
    });
    expect(Reflect.get(restored, "queue")).toEqual([]);
  });

  it("preserves a completed legacy output publication instead of quarantining it", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const request = validRequest("two-stage");
    request.outputName = "legacy-authority-completed.mp4";
    const created = manager.create(request, { deferStart: true });
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const rawRequest = structuredClone(runtimeJob.request) as Record<string, unknown>;
    delete rawRequest.textToAudio;
    const rawRequestSha256 = createHash("sha256").update(canonicalJson(rawRequest)).digest("hex");
    const decision: JobExecutionDecision = {
      schemaVersion: "ltx-studio-execution-decision.v5",
      executionClass: "dgx",
      decidedAt: "2026-08-25T20:00:00.000Z",
      reason: "Legacy fixture was classified before publication.",
      requestSha256: rawRequestSha256,
      protocolSha256: null,
      cpuReuse: null,
      operation: null,
    };
    runtimeJob.authorityBoundRequest = rawRequest;
    runtimeJob.authorityRequestSha256 = rawRequestSha256;
    runtimeJob.executionClass = "dgx";
    runtimeJob.executionDecision = decision;
    runtimeJob.runProvenance = runProvenance();
    runtimeJob.status = "completed";
    runtimeJob.startDeferred = false;
    runtimeJob.startedAt = "2026-08-25T20:00:00.000Z";
    runtimeJob.finishedAt = "2026-08-25T20:01:00.000Z";
    runtimeJob.progress = 100;
    const outputPath = join(outputRoot, request.outputName);
    roots.push(outputPath, outputPublicationPath(outputPath), join(hybridRoot, created.id));
    await mkdir(outputRoot, { recursive: true });
    await writeFile(outputPath, "legacy published video");
    publishCompletedOutputFixture(outputRoot, runtimeJob as unknown as StudioJob);
    const changed = Reflect.get(manager, "changed") as () => void;
    changed.call(manager);

    const restored = new JobManager(path, false);
    const persisted = JSON.parse(await readFile(path, "utf8"));

    expect(restored.get(created.id)).toMatchObject({
      status: "completed",
      outputUrl: `/api/jobs/${created.id}/output`,
      executionDecision: { requestSha256: rawRequestSha256 },
    });
    expect(persisted[0].request).toEqual(rawRequest);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("legacy published video");
    await expect(readFile(outputPublicationPath(outputPath), "utf8")).resolves.toContain(created.id);
  });

  it("blocks both rerun modes for legacy T2A instead of silently adding the -3 dBFS ceiling", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const request = validRequest("text-to-audio");
    request.outputName = "legacy-no-peak.wav";
    const created = manager.create(request, { deferStart: true });
    const stored = JSON.parse(await readFile(path, "utf8"));
    delete stored[0].request.textToAudio;
    const rawRequestSha256 = createHash("sha256")
      .update(canonicalJson(stored[0].request))
      .digest("hex");
    stored[0].executionDecision.requestSha256 = rawRequestSha256;
    await writeFile(path, JSON.stringify(stored));

    const restored = new JobManager(path, false);
    const beforeCount = restored.list().length;

    expect(restored.get(created.id)).toMatchObject({
      status: "failed",
      request: { textToAudio: { peakCeilingDbfs: -3 } },
      executionDecision: { requestSha256: rawRequestSha256 },
      error: expect.stringContaining("ohne gebundene Peak-Grenze"),
    });
    expect(() => restored.rerun(created.id, "exact")).toThrow("semantisch exakt wiederholt");
    expect(() => restored.rerun(created.id, "random-seed")).toThrow("semantisch exakt wiederholt");
    expect(restored.list()).toHaveLength(beforeCount);
    const repersisted = JSON.parse(await readFile(path, "utf8"));
    expect(Object.hasOwn(repersisted[0].request, "textToAudio")).toBe(false);
    expect(repersisted[0].executionDecision.requestSha256).toBe(rawRequestSha256);
  });

  it("persists DGX classification before the normal admission path", async () => {
    const path = await statePath();
    const manager = new JobManager(
      path,
      false,
      null,
      {
        capture: async () => notApplicableIdentityEvidence(),
        verify: async (evidence) => ({ evidence, error: null }),
      },
      undefined,
      null,
      undefined,
      testRunProvenanceOperations,
      undefined,
      { read: async () => verifiedModelInventory() },
    );
    const created = manager.create(validRequest());
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, {
      executionClass?: string;
      plan: { requiredPaths: unknown[] };
    }>).get(created.id)!;
    runtimeJob.plan.requiredPaths = [];
    let classAtAdmission: string | undefined;
    Reflect.set(manager, "waitForDgxQueueStart", async (job: { executionClass?: string }) => {
      classAtAdmission = job.executionClass;
      return false;
    });

    const run = Reflect.get(manager, "run") as (job: unknown) => Promise<void>;
    await run.call(manager, runtimeJob);

    expect(classAtAdmission).toBe("dgx");
    expect(manager.get(created.id)?.executionClass).toBe("dgx");
    expect(new JobManager(path, false).get(created.id)?.executionClass).toBe("dgx");
  });

  it("terminally rejects invalid and contradictory restored execution authority", async () => {
    const invalidPath = await statePath();
    const invalidManager = new JobManager(invalidPath, false);
    const invalidCreated = invalidManager.create(validRequest());
    const invalidStored = JSON.parse(await readFile(invalidPath, "utf8"));
    invalidStored[0].executionDecision.reason = 42;
    await writeFile(invalidPath, JSON.stringify(invalidStored));

    const invalidRestored = new JobManager(invalidPath, false);
    expect(invalidRestored.get(invalidCreated.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("ExecutionDecision.v5/v6"),
    });
    expect(Reflect.get(invalidRestored, "queue")).toEqual([]);

    const contradictoryPath = await statePath();
    const contradictoryManager = new JobManager(contradictoryPath, false);
    const contradictoryCreated = contradictoryManager.create(validRequest());
    const runtimeJob = (Reflect.get(contradictoryManager, "jobs") as Map<string, object>)
      .get(contradictoryCreated.id)!;
    const classify = Reflect.get(contradictoryManager, "classifyExecution") as (
      job: object,
      executionClass: "dgx",
    ) => boolean;
    expect(classify.call(contradictoryManager, runtimeJob, "dgx")).toBe(true);
    const contradictoryStored = JSON.parse(await readFile(contradictoryPath, "utf8"));
    contradictoryStored[0].executionClass = "cpu-only";
    await writeFile(contradictoryPath, JSON.stringify(contradictoryStored));

    const contradictoryRestored = new JobManager(contradictoryPath, false);
    expect(contradictoryRestored.get(contradictoryCreated.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("widerspricht"),
    });
    expect(Reflect.get(contradictoryRestored, "queue")).toEqual([]);
  });

  it("fails old ExecutionDecision.v4 history closed without silently migrating it", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const stored = JSON.parse(await readFile(path, "utf8"));
    stored[0].executionDecision.schemaVersion = "ltx-studio-execution-decision.v4";
    await writeFile(path, JSON.stringify(stored));

    const restored = new JobManager(path, false);

    expect(restored.get(created.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("ältere Versionen werden nicht still migriert"),
      executionDecision: undefined,
    });
    expect(Reflect.get(restored, "queue")).toEqual([]);
  });

  it("restores a succeeded CPU operation independently from a later publication-gate failure", async () => {
    const { path, id } = await persistCpuRestoreCase("succeeded");

    const restored = new JobManager(path, false);

    expect(restored.get(id)).toMatchObject({
      status: "failed",
      error: "Late Activation-/Rights-Gate denied publication.",
      executionClass: "cpu-only",
      executionDecision: {
        executionClass: "cpu-only",
        operation: {
          state: "succeeded",
          completedAt: "2026-08-25T10:00:02.000Z",
          exitCode: 0,
          signal: null,
          errorSha256: null,
          output: {
            sha256: "7".repeat(64),
            revision: { mode: 0o100600 },
          },
        },
      },
    });
    expect(Reflect.get(restored, "queue")).toEqual([]);
  });

  it("durably terminalizes a running CPU operation as interrupted on restore", async () => {
    const { path, id } = await persistCpuRestoreCase("running");

    const restored = new JobManager(path, false);
    const job = restored.get(id)!;

    expect(job).toMatchObject({
      status: "interrupted",
      executionClass: "cpu-only",
      executionDecision: {
        operation: {
          state: "interrupted",
          completedAt: expect.any(String),
          exitCode: null,
          signal: null,
          errorSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          output: null,
        },
      },
    });
    expect(job.runProvenance?.executionDecision).toEqual(job.executionDecision);
    expect(job.logs).toContainEqual(expect.stringContaining("niemals automatisch wiederholt"));
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted[0].executionDecision.operation.state).toBe("interrupted");
    expect(Reflect.get(restored, "queue")).toEqual([]);
  });

  it("keeps a prepared CPU operation unchanged and terminally fails it closed on restore", async () => {
    const { path, id } = await persistCpuRestoreCase("prepared");

    const restored = new JobManager(path, false);
    const job = restored.get(id)!;

    expect(job).toMatchObject({
      status: "failed",
      executionClass: "cpu-only",
      executionDecision: {
        operation: {
          state: "prepared",
          startedAt: null,
          completedAt: null,
          output: null,
        },
      },
      error: expect.stringContaining("monoton belegbaren running-Zustand"),
    });
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted[0].executionDecision.operation.state).toBe("prepared");
    expect(Reflect.get(restored, "queue")).toEqual([]);
  });

  it.each([
    ["prepared", "failed", "prepared"],
    ["running", "failed", "interrupted"],
    ["succeeded", "failed", "succeeded"],
  ] as const)(
    "restores a v6 paired-artifact %s operation fail-closed as %s/%s",
    async (storedState, expectedJobStatus, expectedOperationState) => {
      const { path, id } = await persistPairedRestoreCase(storedState);

      const restored = new JobManager(path, false);
      const job = restored.get(id)!;

      expect(job).toMatchObject({
        status: expectedJobStatus,
        executionClass: "cpu-only",
        executionDecision: {
          schemaVersion: "ltx-studio-execution-decision.v6",
          operation: {
            kind: "paired-artifact-promotion",
            state: expectedOperationState,
          },
        },
      });
      expect(job.runProvenance?.executionDecision).toEqual(job.executionDecision);
      expect(Reflect.get(restored, "queue")).toEqual([]);
    },
  );

  it("lets durable decision persistence win immediately before process spawn", async () => {
    const path = await statePath();
    const marker = `${path}.spawned`;
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    runtimeJob.runProvenance = runProvenance();
    const classify = Reflect.get(manager, "classifyExecution") as (
      job: object,
      executionClass: "dgx",
    ) => boolean;
    expect(classify.call(manager, runtimeJob, "dgx")).toBe(true);
    Reflect.set(manager, "persist", () => {
      throw new Error("synthetic fsync failure");
    });
    const spawnBound = Reflect.get(manager, "spawnBoundProcess") as (
      job: object,
      executable: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ) => unknown;

    expect(() => spawnBound.call(
      manager,
      runtimeJob,
      process.execPath,
      ["-e", "require('node:fs').writeFileSync(process.argv[1], 'spawned')", marker],
      { cwd: repoRoot, env: { ...process.env } },
    )).toThrow("synthetic fsync failure");
    await expect(access(marker)).rejects.toThrow();
  });

  it("does not persist a direct job denied by the sealed-release start enforcer", async () => {
    const path = await statePath();
    const manager = new JobManager(
      path,
      false,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bootstrapJobStartEnforcer(true),
    );

    expect(() => manager.create(validRequest())).toThrow(JobConflictError);
    expect(manager.list()).toEqual([]);
    await expect(access(path)).rejects.toThrow();
  });

  it("rechecks and fails a persisted queued job before runner side effects", async () => {
    const path = await statePath();
    const created = new JobManager(path, false).create(validRequest());
    const restored = new JobManager(
      path,
      false,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      bootstrapJobStartEnforcer(true),
    );
    const pump = Reflect.get(restored, "pump") as () => Promise<void>;

    await pump.call(restored);

    expect(restored.get(created.id)).toMatchObject({
      status: "failed",
      startedAt: null,
      outputUrl: null,
    });
    expect(restored.get(created.id)?.error).toContain("fail-closed");
    expect(Reflect.get(restored, "runningId")).toBeNull();
  });

  it("resumes a resource-free paused slice with the same orchestrator job id", async () => {
    const transitions: Array<{ jobId: string; state: string }> = [];
    const dgxJobId = testDgxJobId("old-slice");
    let studioJobId = "";
    let remoteState: QueueJobState = "running";
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async (jobId, state) => {
        transitions.push({ jobId, state });
        remoteState = state;
        return boundDgxTransition(studioJobId, jobId, state);
      },
    });
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      status: string;
      dgxJobId: string | null;
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.status = "running";
    bindTestDgxLease(
      runtimeJob as unknown as Record<string, unknown>,
      created.id,
      dgxJobId,
      (runtimeJob as unknown as Record<string, unknown>).request as ReturnType<typeof validRequest>,
    );
    Reflect.set(manager, "waitForSchedulerResume", async () => true);
    const pauseAndResume = Reflect.get(manager, "pauseAndResumeDgxSlice") as (
      job: unknown,
      artifact: { type: string; path: string },
    ) => Promise<boolean>;

    expect(await pauseAndResume.call(manager, runtimeJob, {
      type: "ltx-cooperative-checkpoint",
      path: "/checkpoints/job/manifest.json",
    })).toBe(true);
    expect(transitions).toEqual([
      { jobId: dgxJobId, state: "pausing" },
      { jobId: dgxJobId, state: "paused" },
      { jobId: dgxJobId, state: "resuming" },
    ]);
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
  });

  it.each(["pausing", "paused"] as const)(
    "keeps cancellation terminal while the cooperative %s transition is in flight",
    async (blockedState) => {
      const dgxJobId = testDgxJobId(`cancel-during-${blockedState}`);
      let studioJobId = "";
      let transitionStartedResolve!: () => void;
      const transitionStarted = new Promise<void>((resolve) => {
        transitionStartedResolve = resolve;
      });
      let releaseTransitionResolve!: () => void;
      const releaseTransition = new Promise<void>((resolve) => {
        releaseTransitionResolve = resolve;
      });
      let remoteState: QueueJobState = "running";
      const transitions: string[] = [];
      const manager = new JobManager(await statePath(), false, null, {
        capture: async () => notApplicableIdentityEvidence(),
        verify: async (evidence) => ({ evidence, error: null }),
      }, {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
        transition: async (jobId, state) => {
          transitions.push(state);
          if (state === blockedState) {
            transitionStartedResolve();
            await releaseTransition;
          }
          remoteState = state;
          return boundDgxTransition(studioJobId, jobId, state);
        },
      });
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      runtimeJob.status = "running";
      bindTestDgxLease(
        runtimeJob,
        created.id,
        dgxJobId,
        runtimeJob.request as ReturnType<typeof validRequest>,
      );
      const schedulerWait = vi.fn(async () => true);
      Reflect.set(manager, "waitForSchedulerResume", schedulerWait);
      const pauseAndResume = Reflect.get(manager, "pauseAndResumeDgxSlice") as (
        job: unknown,
        artifact: { type: string; path: string },
      ) => Promise<boolean>;

      const pausing = pauseAndResume.call(manager, runtimeJob, {
        type: "ltx-cooperative-checkpoint",
        path: "/checkpoints/job/manifest.json",
      });
      await transitionStarted;
      expect(manager.cancel(created.id)).toMatchObject({
        status: "cancelled",
        cancellationState: "settling",
      });
      releaseTransitionResolve();

      expect(await pausing).toBe(false);
      for (let attempt = 0; attempt < 100
        && manager.experimentRetryAuthority(created.id)?.settlementPending; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      expect(schedulerWait).not.toHaveBeenCalled();
      expect(manager.get(created.id)).toMatchObject({
        status: "cancelled",
        cancelledBy: "studio",
        error: null,
        cancellationState: "settled",
      });
      expect(transitions).toContain(blockedState);
      expect(transitions).not.toContain("resuming");
    },
  );

  it("requests a fresh canonical decision for every Euler boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-boundary-watcher-"));
    roots.push(root);
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("boundary");
    const waiterDgxJobId = testDgxJobId("boundary-waiter");
    let studioJobId = "";
    let remoteState: QueueJobState = "running";
    const decide = vi.fn()
      .mockResolvedValueOnce({
        schema_version: "dgx-segment-schedule-decision.v1",
        action: "continue_current",
        current_job_id: dgxJobId,
        next_job_id: null,
        reason: "no_waiting_job",
        retry_after_seconds: 5,
      })
      .mockResolvedValueOnce({
        schema_version: "dgx-segment-schedule-decision.v1",
        action: "yield_to_waiting_job",
        current_job_id: dgxJobId,
        next_job_id: waiterDgxJobId,
        reason: "selected_waiter",
        retry_after_seconds: 5,
      });
    const manager = new JobManager(join(root, "jobs.json"), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async (jobId, state) => {
        transitions.push(state);
        remoteState = state;
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null, undefined, undefined, { decide });
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    runtimeJob.status = "running";
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    runtimeJob.runProvenance = runProvenance();
    const child = spawn("/usr/bin/python3", ["-c", "import time; time.sleep(30)"], {
      detached: true,
      stdio: "ignore",
    });
    runtimeJob.process = child;
    const checkpointRoot = join(root, "checkpoint");
    await mkdir(checkpointRoot, { recursive: true });
    const watch = Reflect.get(manager, "watchSegmentBoundaries") as (
      job: unknown,
      path: string,
      fingerprint: string,
      generation: number,
    ) => { stop: () => Promise<void> };
    const watcher = watch.call(
      manager,
      runtimeJob,
      checkpointRoot,
      (runtimeJob.runProvenance as RunProvenance).fingerprint,
      0,
    );
    const decisionPath = join(checkpointRoot, "boundary-decision.json");
    const readyPath = join(checkpointRoot, "boundary-ready.json");
    const waitForDecision = async (): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          return JSON.parse(await readFile(decisionPath, "utf8")) as Record<string, unknown>;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      throw new Error("segment decision was not written");
    };
    try {
      await writeFile(readyPath, JSON.stringify({
        schema_version: "ltx-segment-boundary-ready.v1",
        job_fingerprint: (runtimeJob.runProvenance as RunProvenance).fingerprint,
        dgx_job_id: dgxJobId,
        generation: 0,
        boundary_id: "0:0:1",
        loop_index: 0,
        next_step_index: 1,
      }));
      await expect(waitForDecision()).resolves.toMatchObject({
        boundary_id: "0:0:1",
        action: "continue_current",
      });
      await rm(readyPath, { force: true });
      await rm(decisionPath, { force: true });

      await writeFile(readyPath, JSON.stringify({
        schema_version: "ltx-segment-boundary-ready.v1",
        job_fingerprint: (runtimeJob.runProvenance as RunProvenance).fingerprint,
        dgx_job_id: dgxJobId,
        generation: 0,
        boundary_id: "0:0:2",
        loop_index: 0,
        next_step_index: 2,
      }));
      await expect(waitForDecision()).resolves.toMatchObject({
        boundary_id: "0:0:2",
        action: "yield_to_waiting_job",
      });
      expect(decide).toHaveBeenCalledTimes(2);
      expect(transitions).toEqual(["pausing"]);
    } finally {
      await watcher.stop();
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Process already ended.
        }
      }
    }
  });

  it("accepts only a complete checkpoint bound to the current run provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-checkpoint-"));
    roots.push(root);
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      runProvenance: RunProvenance | null;
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.runProvenance = runProvenance();
    await writeFile(join(root, "state.pt"), "state");
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      schema_version: "ltx-cooperative-checkpoint.v1",
      job_fingerprint: runtimeJob.runProvenance.fingerprint,
      request_id: "yield-1",
      state_file: "state.pt",
      loop_index: 0,
      next_step_index: 4,
    }));
    const validate = Reflect.get(manager, "validateCooperativeCheckpoint") as (
      job: unknown,
      manifestPath: string,
      requestId: string,
    ) => { type: string } | null;

    expect(validate.call(manager, runtimeJob, join(root, "manifest.json"), "yield-1")).toMatchObject({
      type: "ltx-cooperative-checkpoint",
    });
    expect(validate.call(manager, runtimeJob, join(root, "manifest.json"), "different")).toBeNull();
  });

  it("recognizes only complete tqdm records", () => {
    expect(progressFromPipelineLog(" 87%|########7 | 26/30")).toBe(87);
    expect(progressFromPipelineLog("100%|##########| 30/30")).toBe(100);
    expect(progressFromPipelineLog("GPU-Speicher 90% belegt")).toBeNull();
    expect(progressFromPipelineLog("Checkpoint 42% geladen")).toBeNull();
    expect(progressFromPipelineLog("Transformer geladen")).toBeNull();
  });

  it("frames carriage-return tqdm streams across arbitrary chunks", () => {
    const first = frameProcessLogChunk("", "  7%|#");
    expect(first.records).toEqual([]);
    const second = frameProcessLogChunk(
      first.rest,
      "      | 2/30\r 10%|##        | 3/30\rGPU-Speicher 90%",
    );
    expect(second.records).toEqual([
      "  7%|#      | 2/30",
      " 10%|##        | 3/30",
    ]);
    expect(frameProcessLogChunk(second.rest, "", true)).toEqual({
      records: ["GPU-Speicher 90%"],
      rest: "",
    });
  });

  it("maps multiple pipeline phases monotonically below final completion", () => {
    const tracker = new PipelineProgressTracker(0, 95, 2);
    const values = [
      tracker.update("INFO: Building text encoder from /models/gemma"),
      tracker.update("INFO: Prompt encoding complete"),
      tracker.update("INFO: Running denoising loop (30 steps, 256x256 97 frames @ 24 fps)"),
      tracker.update("100%|##########| 30/30"),
      tracker.update("INFO: Running denoising loop (3 steps, 512x512 97 frames @ 24 fps)"),
      tracker.update(" 33%|###3      | 1/3"),
      tracker.update("INFO: Building video decoder from /models/checkpoint"),
      tracker.update("100%|##########| 2/2"),
      tracker.update("INFO: Video saved to /outputs/test.mp4"),
    ].filter((value): value is number => value !== null);

    expect(values).toEqual([...values].sort((left, right) => left - right));
    expect(values.at(-1)).toBe(95);
    expect(values).not.toContain(100);
  });

  it("rejects two active jobs reserving the same output", async () => {
    const manager = new JobManager(await statePath(), false);
    const request = validRequest();
    manager.create(request);
    expect(() => manager.create(structuredClone(request))).toThrow(JobConflictError);
  });

  it("records queued cancellation as a manual Studio action", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const cancelled = manager.cancel(created.id)!;

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledBy).toBe("studio");
    expect(cancelled.logs.at(-1)).toContain("Studio-Abbruchfunktion");
  });

  it("never trims a terminal job whose submit settlement is still pending", async () => {
    const manager = new JobManager(await statePath(), false);
    let oldestJobId = "";
    for (let index = 0; index < 100; index += 1) {
      const request = validRequest();
      request.outputName = `trim-settlement-${index}.mp4`;
      const created = manager.create(request);
      manager.cancel(created.id);
      if (index === 0) oldestJobId = created.id;
    }
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
    const oldest = internalJobs.get(oldestJobId)!;
    oldest.createdAt = "2000-01-01T00:00:00.000Z";
    bindTestPendingDgxSubmit(
      oldest,
      oldestJobId,
      oldest.request as ReturnType<typeof validRequest>,
    );
    (Reflect.get(manager, "changed") as () => void).call(manager);

    const newestRequest = validRequest();
    newestRequest.outputName = "trim-settlement-newest.mp4";
    manager.cancel(manager.create(newestRequest).id);

    expect(manager.get(oldestJobId)).toBeDefined();
    expect(manager.experimentRetryAuthority(oldestJobId)).toMatchObject({
      status: "cancelled",
      settlementPending: true,
    });
  });

  it("removes only terminal jobs and persists the shortened history", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());

    expect(() => manager.remove(created.id)).toThrow("noch aktiv");
    expect(manager.get(created.id)).toBeDefined();

    manager.cancel(created.id);
    const deleted = manager.remove(created.id);

    expect(deleted).toMatchObject({ id: created.id, status: "cancelled" });
    expect(manager.get(created.id)).toBeUndefined();
    expect(manager.list()).toEqual([]);
    expect(new JobManager(path, false).list()).toEqual([]);
  });

  it("stops the complete process group before releasing its lease during shutdown", async () => {
    const path = await statePath();
    const root = join(path, "..");
    const readyPath = join(root, "parent.ready");
    const childReadyPath = join(root, "child.ready");
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("shutdown-order");
    let studioJobId = "";
    let processGroupId = 0;
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (remoteJobId) => {
        expect(() => process.kill(-processGroupId, 0)).toThrow();
        transitions.push("read-after-local-exit");
        return boundDgxRead(studioJobId, remoteJobId, "running");
      },
      transition: async (remoteJobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, remoteJobId, state);
      },
    }, null);
    const first = manager.create(validRequest());
    studioJobId = first.id;
    const secondRequest = validRequest();
    secondRequest.outputName = "shutdown-preserved.mp4";
    const second = manager.create(secondRequest);
    const child = spawn("/usr/bin/python3", ["-c", [
      "import pathlib,signal,subprocess,sys,time",
      `child_ready=${JSON.stringify(childReadyPath)}`,
      "code='import pathlib,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        + `pathlib.Path(${JSON.stringify(childReadyPath)}).write_text("ready"); time.sleep(30)'`,
      "subprocess.Popen([sys.executable,'-c',code],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)",
      "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      "for _ in range(200):",
      "    if pathlib.Path(child_ready).exists(): break",
      "    time.sleep(0.01)",
      `pathlib.Path(${JSON.stringify(readyPath)}).write_text("ready")`,
      "time.sleep(30)",
    ].join("\n")], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Test-Prozessgruppe konnte nicht gestartet werden.");
    processGroupId = child.pid;
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
          await readFile(readyPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
      const active = internalJobs.get(first.id)!;
      active.status = "running";
      active.startedAt = new Date().toISOString();
      bindTestDgxLease(
        active,
        first.id,
        dgxJobId,
        active.request as ReturnType<typeof validRequest>,
      );
      active.process = child;
      Reflect.set(manager, "runningId", first.id);

      const report = await manager.shutdown(2_000);

      expect(report).toMatchObject({
        queuedPreserved: 1,
        localGroupsStopped: 1,
        remoteConfirmed: 1,
        remotePending: 0,
      });
      expect(transitions).toEqual(["read-after-local-exit", "cancelled"]);
      expect(manager.get(first.id)).toMatchObject({
        status: "interrupted",
        cancelledBy: null,
      });
      expect(manager.get(second.id)?.status).toBe("queued");
      expect(() => manager.create(validRequest())).toThrow("nimmt keine neuen Aufträge");

      const restored = new JobManager(path, false);
      expect(restored.get(second.id)?.status).toBe("queued");
    } finally {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The shutdown path should already have removed the complete group.
      }
    }
  }, 10_000);

  it("preserves the queue item already pulled by the pump when no remote or local process exists", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const queue = Reflect.get(manager, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    Reflect.set(manager, "runningId", created.id);
    Reflect.set(manager, "activeRunPromise", Promise.resolve());

    const report = await manager.shutdown(250);

    expect(report).toMatchObject({ queuedPreserved: 1, remotePending: 0 });
    expect(manager.get(created.id)?.status).toBe("queued");
    const restored = new JobManager(path, false);
    expect(restored.get(created.id)?.status).toBe("queued");
    expect(Reflect.get(restored, "queue")).toContain(created.id);
  });

  it.each(["data", "close"] as const)(
    "contains a first persistence HOLD raised by trailing process-log %s without starving close listeners",
    async (trigger) => {
      const manager = new JobManager(await statePath(), false);
      const created = manager.create(validRequest());
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
      active.status = "running";
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      const safetyStop = vi.fn(async () => undefined);
      Reflect.set(manager, "safetyStopAfterPersistenceHold", safetyStop);
      (Reflect.get(manager, "consumeProcessLogs") as (
        job: unknown,
        process: unknown,
      ) => void).call(manager, active, child);
      const waitForProcess = (Reflect.get(manager, "waitForProcess") as (
        process: unknown,
      ) => Promise<{ code: number | null }>).call(manager, child);
      const base = Reflect.get(manager, "jobPersistenceFileOperations") as Record<string, (...args: never[]) => unknown>;
      let fsyncCalls = 0;
      Reflect.set(manager, "jobPersistenceFileOperations", {
        ...base,
        fsync: (...args: never[]) => {
          fsyncCalls += 1;
          if (fsyncCalls >= 2) throw new Error(`synthetic ${trigger} log directory fsync failure`);
          return base.fsync(...args);
        },
      });

      expect(() => child.stdout.write(trigger === "data" ? "trailing stdout\n" : "close-only partial"))
        .not.toThrow();
      expect(() => child.emit("close", 0, null)).not.toThrow();
      await expect(waitForProcess).resolves.toMatchObject({ code: 0 });
      await Promise.resolve();
      await Promise.resolve();

      expect(manager.persistenceHealth()).toMatchObject({ status: "hold" });
      expect(safetyStop).toHaveBeenCalledTimes(1);
    },
  );

  it("rolls back log, progress and tracker state after a proven pre-rename log persistence failure", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "running";
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    const tracker = new PipelineProgressTracker(0, 80, 1);
    const trackerBefore = tracker.snapshot();
    const logsBefore = [...active.logs as string[]];
    const progressBefore = active.progress;
    (Reflect.get(manager, "consumeProcessLogs") as (
      job: unknown,
      process: unknown,
      progress: PipelineProgressTracker,
    ) => void).call(manager, active, child, tracker);
    const originalPersist = (Reflect.get(manager, "persist") as () => void).bind(manager);
    let failOnce = true;
    Reflect.set(manager, "persist", () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("synthetic pre-rename log persistence failure");
      }
      originalPersist();
    });

    expect(() => child.stdout.write("Running denoising loop\n 50%|#####| 1/2\n")).not.toThrow();

    expect(active.logs).toEqual(logsBefore);
    expect(active.progress).toBe(progressBefore);
    expect(tracker.snapshot()).toEqual(trackerBefore);
    expect(manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
  });

  it("restores the no-progress clock and safety deadline when Euler progress persistence rolls back", async () => {
    vi.useFakeTimers();
    try {
      const baselineNow = Date.now();
      const dgxJobId = testDgxJobId("progress-clock-rollback");
      let studioJobId = "";
      let remoteState: QueueJobState = "running";
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
        transition: async (jobId, state) => {
          remoteState = state;
          return boundDgxTransition(studioJobId, jobId, state);
        },
      }, null);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);
      const heartbeatState = {
        jobId: dgxJobId,
        phase: "ltx_rendering",
        progressEpoch: 4,
        acknowledgedProgressEpoch: 4,
        acknowledgedOnce: true,
        // Keep the acknowledgement deadline later than the no-progress
        // deadline so this test isolates the restored progress clock.
        lastAcknowledgedAt: baselineNow + DGX_OWNER_NO_PROGRESS_TIMEOUT_MS,
        lastProgressAt: baselineNow,
        consecutiveFailures: 0,
        stopped: false,
      };
      active.dgxOwnerHeartbeat = heartbeatState;
      (Reflect.get(manager, "armDgxOwnerHeartbeatSafetyDeadline") as (
        job: unknown,
        state: unknown,
      ) => void).call(manager, active, heartbeatState);

      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      const tracker = new PipelineProgressTracker(0, 80, 1);
      (Reflect.get(manager, "consumeProcessLogs") as (
        job: unknown,
        process: unknown,
        progress: PipelineProgressTracker,
      ) => void).call(manager, active, child, tracker);
      const originalPersist = (Reflect.get(manager, "persist") as () => void).bind(manager);
      let failOnce = true;
      Reflect.set(manager, "persist", () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("synthetic Euler progress persistence failure");
        }
        originalPersist();
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(() => child.stdout.write("Running denoising loop\n 50%|#####| 1/2\n"))
        .not.toThrow();

      expect(heartbeatState.progressEpoch).toBe(4);
      expect(heartbeatState.lastProgressAt).toBe(baselineNow);

      await vi.advanceTimersByTimeAsync(DGX_OWNER_NO_PROGRESS_TIMEOUT_MS - 1_000);
      for (let attempt = 0; attempt < 10
        && manager.get(created.id)?.status === "running"; attempt += 1) {
        await Promise.resolve();
      }

      expect(manager.get(created.id)).toMatchObject({
        status: "failed",
        outputUrl: null,
        error: expect.stringContaining("No-Progress-Frist"),
      });
      expect(active.dgxOwnerHeartbeat).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gates trailing logs, a ready Euler boundary and thermal resume together in HOLD", async () => {
    vi.useFakeTimers();
    try {
      const root = await mkdtemp(join(tmpdir(), "ltx-hold-watchers-"));
      roots.push(root);
      const dgxJobId = testDgxJobId("hold-watchers");
      const decide = vi.fn(async () => ({
        schema_version: "dgx-segment-schedule-decision.v1" as const,
        action: "continue_current" as const,
        current_job_id: dgxJobId,
        next_job_id: null,
        reason: "no_waiter",
        retry_after_seconds: 5,
      }));
      const manager = new JobManager(
        join(root, "jobs.json"),
        false,
        null,
        undefined,
        undefined,
        null,
        undefined,
        undefined,
        { decide },
      );
      const created = manager.create(validRequest());
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
      active.status = "paused";
      bindTestDgxLease(
        active,
        created.id,
        dgxJobId,
        active.request as ReturnType<typeof validRequest>,
      );
      active.runProvenance = runProvenance();
      active.thermalProfile = {
        baselineC: 58.6,
        currentC: 66,
        peakC: 91,
        riseC: 32.4,
        pauseAtC: 90,
        resumeBelowC: 66,
        updatedAt: new Date().toISOString(),
      };
      const thermalBefore = structuredClone(active.thermalProfile);
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.signalCode = null;
      active.process = child;
      (Reflect.get(manager, "consumeProcessLogs") as (job: unknown, process: unknown) => void)
        .call(manager, active, child);
      const checkpointRoot = join(root, "checkpoint");
      await mkdir(checkpointRoot, { recursive: true });
      const boundary = (Reflect.get(manager, "watchSegmentBoundaries") as (
        job: unknown,
        path: string,
        fingerprint: string,
        generation: number,
      ) => { stop: () => Promise<void> }).call(
        manager,
        active,
        checkpointRoot,
        (active.runProvenance as RunProvenance).fingerprint,
        0,
      );
      const signals: NodeJS.Signals[] = [];
      const stopThermals = (Reflect.get(manager, "watchThermals") as (
        job: unknown,
        process: unknown,
        baseline: number,
        operations: Record<string, unknown>,
      ) => () => void).call(manager, active, child, 58.6, {
        readTemperatureC: () => 66,
        processIsAlive: () => true,
        signalProcessGroup: (_process: unknown, signal: NodeJS.Signals) => {
          signals.push(signal);
          return true;
        },
      });
      Reflect.set(
        manager,
        "persistenceHold",
        new JobPersistenceHoldError("synthetic watcher HOLD", new Error("synthetic")),
      );
      const changed = vi.fn(() => {
        throw new Error("changed must not run in watcher HOLD");
      });
      Reflect.set(manager, "changed", changed);
      await writeFile(join(checkpointRoot, "boundary-ready.json"), JSON.stringify({
        schema_version: "ltx-segment-boundary-ready.v1",
        job_fingerprint: (active.runProvenance as RunProvenance).fingerprint,
        dgx_job_id: active.dgxJobId,
        generation: 0,
        boundary_id: "hold:0:1",
        loop_index: 0,
        next_step_index: 1,
      }));

      expect(() => child.stdout.write("ignored trailing output\n")).not.toThrow();
      expect(() => child.emit("close", 0, null)).not.toThrow();
      await vi.advanceTimersByTimeAsync(thermalPollIntervalMs * 6);
      stopThermals();
      await boundary.stop();

      expect(signals).toEqual([]);
      expect(decide).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
      expect(active.thermalProfile).toEqual(thermalBefore);
      await expect(access(join(checkpointRoot, "boundary-decision.json"))).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("wires the native watcher to three hot polls and five inclusive 66 C resume polls", async () => {
    vi.useFakeTimers();
    try {
      const manager = new JobManager(await statePath(), false);
      const created = manager.create(validRequest());
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
      active.status = "running";
      active.thermalProfile = {
        baselineC: 58.6,
        currentC: 58.6,
        peakC: 58.6,
        riseC: 0,
        pauseAtC: 90,
        resumeBelowC: 66,
        updatedAt: new Date().toISOString(),
      };
      const readings = [91, 91, 91, 66, 66, 66, 66, 66];
      const signals: NodeJS.Signals[] = [];
      const phases: string[] = [];
      const watch = Reflect.get(manager, "watchThermals") as (
        job: unknown,
        child: unknown,
        baselineC: number,
        operations: Record<string, unknown>,
      ) => () => void;
      const stop = watch.call(manager, active, {}, 58.6, {
        readTemperatureC: () => readings.shift() ?? null,
        processIsAlive: () => true,
        signalProcessGroup: (_child: unknown, signal: NodeJS.Signals) => {
          signals.push(signal);
          return true;
        },
        setHeartbeatPhase: (phase: string) => phases.push(phase),
      });
      try {
        await vi.advanceTimersByTimeAsync(thermalPollIntervalMs * 2);
        expect(signals).toEqual([]);
        await vi.advanceTimersByTimeAsync(thermalPollIntervalMs);
        expect(signals).toEqual(["SIGSTOP"]);
        expect(active.status).toBe("paused");
        await vi.advanceTimersByTimeAsync(thermalPollIntervalMs * 4);
        expect(signals).toEqual(["SIGSTOP"]);
        await vi.advanceTimersByTimeAsync(thermalPollIntervalMs);
        expect(signals).toEqual(["SIGSTOP", "SIGCONT"]);
        expect(active.status).toBe("running");
      } finally {
        stop();
      }

      expect(phases).toEqual(["thermal_pause", "ltx_rendering"]);
      expect((active.logs as string[]).join("\n")).toContain(
        "5 Messungen bei oder unter der Wiederanlaufschwelle 66.0 °C. LTX läuft ohne Neustart weiter.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["LatentSync", OWNED_DOCKER_THERMAL_WORKLOADS.latentSync],
    ["MuseTalk", OWNED_DOCKER_THERMAL_WORKLOADS.museTalk],
    ["LipForcing", OWNED_DOCKER_THERMAL_WORKLOADS.lipForcing],
  ] as const)("wires the %s Docker watcher to inclusive resume, exact actions, phase and labels", async (label, workload) => {
    vi.useFakeTimers();
    try {
      const manager = new JobManager(await statePath(), false);
      const created = manager.create(validRequest());
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
      active.status = "running";
      active.thermalProfile = {
        baselineC: 58.6,
        currentC: 58.6,
        peakC: 58.6,
        riseC: 0,
        pauseAtC: 90,
        resumeBelowC: 66,
        updatedAt: new Date().toISOString(),
      };
      const readings = [91, 91, 91, 66, 66, 66, 66, 66];
      const actions: string[] = [];
      const phases: string[] = [];
      const watch = Reflect.get(manager, "watchOwnedDockerThermals") as (
        job: unknown,
        child: unknown,
        baselineC: number,
        containerName: string,
        selectedWorkload: typeof workload,
        operations: Record<string, unknown>,
      ) => () => void;
      const stop = watch.call(manager, active, {}, 58.6, "owned-refiner", workload, {
        readTemperatureC: () => readings.shift() ?? null,
        processIsAlive: () => true,
        dockerAction: (action: string, containerName: string) => {
          actions.push(`${action}:${containerName}`);
          return true;
        },
        setHeartbeatPhase: (phase: string) => phases.push(phase),
      });
      try {
        await vi.advanceTimersByTimeAsync(thermalPollIntervalMs * 3);
        expect(actions).toEqual(["pause:owned-refiner"]);
        expect(active.status).toBe("paused");
        await vi.advanceTimersByTimeAsync(thermalPollIntervalMs * 4);
        expect(actions).toEqual(["pause:owned-refiner"]);
        await vi.advanceTimersByTimeAsync(thermalPollIntervalMs);
        expect(actions).toEqual(["pause:owned-refiner", "unpause:owned-refiner"]);
        expect(active.status).toBe("running");
      } finally {
        stop();
      }

      expect(phases).toEqual(["thermal_pause", workload.resumeHeartbeatPhase]);
      const logs = (active.logs as string[]).join("\n");
      expect(logs).toContain(`Der ${label}-Container bleibt vollständig im Speicher`);
      expect(logs).toContain(`66.0 °C. ${label} läuft ohne Neustart weiter.`);
      expect(logs).toContain(`${label}-Thermalprofil (gesamter Host)`);
      for (const other of ["LatentSync", "MuseTalk", "LipForcing"].filter((value) => value !== label)) {
        expect(logs).not.toContain(`Der ${other}-Container`);
        expect(logs).not.toContain(`${other}-Thermalprofil`);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a thermally paused owned refiner only after exact unpause, stop and absence proof", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("owned-thermal-cancel");
    let studioJobId = "";
    let remoteState: "running" | "completed" | "failed" | "cancelled" = "running";
    const transitions: Array<{ state: string; containerExists: boolean }> = [];
    const manager = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async (jobId, state) => {
        transitions.push({ state, containerExists: fixture.exists() });
        remoteState = state as "cancelled";
        return boundDgxTransition(studioJobId, jobId, remoteState);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const containerName = `ltx-latentsync-${created.id}`;
    const fixture = ownedDockerFixture(containerName, dgxJobId);
    Reflect.set(manager, "ownedDockerOperations", fixture.operations);
    active.status = "running";
    bindTestDgxLease(
      active,
      created.id,
      dgxJobId,
      active.request as ReturnType<typeof validRequest>,
    );
    const bind = Reflect.get(manager, "bindOwnedDockerContainer") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
    ) => void;
    bind.call(manager, active, containerName, OWNED_DOCKER_THERMAL_WORKLOADS.latentSync);
    const thermalAction = Reflect.get(manager, "controlOwnedDockerThermalState") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
      action: "pause",
    ) => boolean;
    expect(thermalAction.call(
      manager,
      active,
      containerName,
      OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
      "pause",
    )).toBe(true);
    active.status = "paused";
    const cancellationStates: string[] = [];
    manager.on("changed", (jobs: StudioJob[]) => {
      const state = jobs.find((job) => job.id === created.id)?.cancellationState;
      if (state) cancellationStates.push(state);
    });

    expect(manager.cancel(created.id)).toMatchObject({
      status: "cancelled",
      cancellationState: "settling",
    });
    for (let attempt = 0; attempt < 100
      && manager.get(created.id)?.cancellationState !== "settled"; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    expect(fixture.mutationCommands().map((args) => args[0])).toEqual([
      "pause",
      "unpause",
      "stop",
    ]);
    expect(fixture.exists()).toBe(false);
    expect(transitions).toEqual([{ state: "cancelled", containerExists: false }]);
    expect(cancellationStates[0]).toBe("settling");
    expect(cancellationStates.at(-1)).toBe("settled");
    expect(manager.get(created.id)).not.toHaveProperty("ownedDockerContainer");
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]).not.toHaveProperty("ownedDockerContainer");
  });

  it("keeps local and DGX settlement fail-closed when owned container stop and rm both fail", async () => {
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("owned-cleanup-failure");
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (_jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, _jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const containerName = `ltx-musetalk-${created.id}`;
    const fixture = ownedDockerFixture(containerName, dgxJobId, {
      paused: true,
      failStop: true,
      failRemove: true,
    });
    Reflect.set(manager, "ownedDockerOperations", fixture.operations);
    active.status = "paused";
    bindTestDgxLease(
      active,
      created.id,
      dgxJobId,
      active.request as ReturnType<typeof validRequest>,
    );
    const bind = Reflect.get(manager, "bindOwnedDockerContainer") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.museTalk,
    ) => void;
    bind.call(manager, active, containerName, OWNED_DOCKER_THERMAL_WORKLOADS.museTalk);
    (active.ownedDockerContainer as Record<string, unknown>).state = "paused";

    manager.cancel(created.id);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

    expect(fixture.mutationCommands().map((args) => args.slice(0, 2).join(" "))).toEqual([
      `unpause ${"d".repeat(64)}`,
      "stop --time",
      "rm -f",
    ]);
    expect(fixture.exists()).toBe(true);
    expect(transitions).toEqual([]);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      cancellationState: "settling",
    });
    expect(manager.experimentRetryAuthority(created.id)?.settlementPending).toBe(true);
  });

  it("never mutates a same-name container whose Studio or DGX labels mismatch", async () => {
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async () => { throw new Error("remote delivery must remain fenced"); },
      transition: async () => { throw new Error("remote delivery must remain fenced"); },
    }, null);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const dgxJobId = testDgxJobId("owned-label-mismatch");
    const containerName = `ltx-lipforcing-${created.id}`;
    const fixture = ownedDockerFixture(containerName, dgxJobId, {
      paused: true,
      sourceAppLabel: "foreign-app",
    });
    Reflect.set(manager, "ownedDockerOperations", fixture.operations);
    active.status = "paused";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const bind = Reflect.get(manager, "bindOwnedDockerContainer") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.lipForcing,
    ) => void;
    bind.call(manager, active, containerName, OWNED_DOCKER_THERMAL_WORKLOADS.lipForcing);
    (active.ownedDockerContainer as Record<string, unknown>).state = "paused";

    manager.cancel(created.id);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));

    expect(fixture.mutationCommands()).toEqual([]);
    expect(fixture.exists()).toBe(true);
    expect(manager.get(created.id)?.cancellationState).toBe("settling");
  });

  it("reconciles a persisted paused owned container after restart before releasing its DGX lease", async () => {
    const path = await statePath();
    const first = new JobManager(path, false);
    const created = first.create(validRequest());
    const active = (Reflect.get(first, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const dgxJobId = testDgxJobId("owned-restart-cleanup");
    const containerName = `ltx-lipforcing-${created.id}`;
    active.status = "interrupted";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    delete active.executionClass;
    delete active.executionDecision;
    const bind = Reflect.get(first, "bindOwnedDockerContainer") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.lipForcing,
    ) => void;
    bind.call(first, active, containerName, OWNED_DOCKER_THERMAL_WORKLOADS.lipForcing);
    const markGateReleased = Reflect.get(first, "markOwnedDockerStartGateReleased") as (
      job: unknown,
    ) => void;
    markGateReleased.call(first, active);
    const setContainerState = Reflect.get(first, "setOwnedDockerContainerState") as (
      job: unknown,
      state: "paused",
    ) => void;
    setContainerState.call(first, active, "paused");
    const prepareTerminal = Reflect.get(first, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void;
    prepareTerminal.call(first, active, "cancelled", { current_step: "restart cleanup test" });
    (Reflect.get(first, "changed") as () => void).call(first);

    const fixture = ownedDockerFixture(containerName, dgxJobId, { paused: true });
    const transitions: Array<{ state: string; containerExists: boolean }> = [];
    const restored = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(created.id, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push({ state, containerExists: fixture.exists() });
        return boundDgxTransition(created.id, jobId, state);
      },
    }, null);
    Reflect.set(restored, "ownedDockerOperations", fixture.operations);
    for (let attempt = 0; attempt < 100
      && restored.get(created.id)?.cancellationState !== "settled"; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    expect(fixture.mutationCommands().map((args) => args[0])).toEqual(["unpause", "stop"]);
    expect(transitions).toEqual([{ state: "cancelled", containerExists: false }]);
    expect(restored.get(created.id)?.cancellationState).toBe("settled");
    expect((Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)).not.toHaveProperty("ownedDockerContainer");
  });

  it("clears an owned-container marker on normal wrapper exit only after inspect proves absence", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const dgxJobId = testDgxJobId("owned-normal-exit");
    const containerName = `ltx-latentsync-${created.id}`;
    const fixture = ownedDockerFixture(containerName, dgxJobId, { exists: false });
    Reflect.set(manager, "ownedDockerOperations", fixture.operations);
    active.status = "running";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const bind = Reflect.get(manager, "bindOwnedDockerContainer") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
    ) => void;
    bind.call(manager, active, containerName, OWNED_DOCKER_THERMAL_WORKLOADS.latentSync);
    active.localProcessGroupPending = true;
    const confirm = Reflect.get(manager, "confirmProcessGroupGone") as (
      job: unknown,
      child: unknown,
    ) => Promise<void>;

    await confirm.call(manager, active, {});

    expect(fixture.mutationCommands()).toEqual([]);
    expect(active.localProcessGroupPending).toBeUndefined();
    expect(active.ownedDockerContainer).toBeUndefined();
  });

  it("keeps DGX fenced when Docker create appears only after two fresh name-absence inspections", async () => {
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("owned-late-create");
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const containerName = `ltx-latentsync-${created.id}`;
    const containerId = "e".repeat(64);
    let inspectCalls = 0;
    let present = false;
    const dockerCommands: string[][] = [];
    Reflect.set(manager, "ownedDockerOperations", {
      run: (rawArgs: readonly string[]) => {
        const args = [...rawArgs];
        dockerCommands.push(args);
        if (args[0] === "container") {
          inspectCalls += 1;
          if (inspectCalls === 3) present = true;
          const target = args.at(-1)!;
          if (!present || (target !== containerName && target !== containerId)) {
            return {
              status: 1,
              stdout: "",
              stderr: `Error response from daemon: No such container: ${target}`,
              error: null,
            };
          }
          return {
            status: 0,
            stdout: JSON.stringify({
              Id: containerId,
              Name: `/${containerName}`,
              Config: { Labels: {
                "dgx.source_app": "ltx-studio",
                "dgx.job": dgxJobId,
                "dgx.runtime": "ltx2_native",
              } },
              State: { Paused: false, Running: true },
            }),
            stderr: "",
            error: null,
          };
        }
        if (args[0] === "stop" && args.at(-1) === containerId) {
          present = false;
          return { status: 0, stdout: "", stderr: "", error: null };
        }
        return { status: 2, stdout: "", stderr: "unexpected mutation", error: null };
      },
    });
    active.status = "running";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const bind = Reflect.get(manager, "bindOwnedDockerContainer") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
    ) => void;
    bind.call(manager, active, containerName, OWNED_DOCKER_THERMAL_WORKLOADS.latentSync);
    (Reflect.get(manager, "markOwnedDockerStartGateReleased") as (job: unknown) => void)
      .call(manager, active);
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    const prepare = Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void;
    prepare.call(manager, active, "cancelled", { current_step: "late-create test" });
    (Reflect.get(manager, "changed") as () => void).call(manager);
    const cleanup = Reflect.get(manager, "cleanupOwnedDockerContainer") as (
      job: unknown,
    ) => Promise<boolean>;
    const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await flush.call(manager, active)).toBe(false);
    expect(await cleanup.call(manager, active)).toBe(false);
    expect(inspectCalls).toBe(2);
    expect(transitions).toEqual([]);
    expect(active.ownedDockerContainer).toBeDefined();

    expect(await cleanup.call(manager, active)).toBe(true);
    expect(dockerCommands.filter((args) => args[0] === "stop"))
      .toEqual([["stop", "--time", "20", containerId]]);
    expect(await flush.call(manager, active)).toBe(true);
    expect(transitions).toEqual(["cancelled"]);
    expect(active.ownedDockerContainer).toBeUndefined();
  });

  it("durably binds the exact owned-container authority before the refiner wrapper spawn", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const dgxJobId = testDgxJobId("owned-pre-spawn-fence");
    const containerName = `ltx-musetalk-${created.id}`;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    active.status = "running";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const child = {
      stdio: [null, null, null, {
        once: () => undefined,
        off: () => undefined,
        end: (_token: string, callback: () => void) => callback(),
      }],
    } as unknown as ReturnType<typeof spawn>;
    let persistedAtSpawn: unknown;
    Reflect.set(manager, "spawnBoundProcess", () => {
      const entries = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
      persistedAtSpawn = entries[0]?.ownedDockerContainer;
      return child;
    });
    Reflect.set(manager, "markProcessStarted", async () => undefined);
    Reflect.set(manager, "pinStartedOwnedDockerContainer", async () => undefined);
    const start = Reflect.get(manager, "spawnOwnedDockerRefiner") as (
      job: unknown,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.museTalk,
      name: string,
      executable: string,
      args: string[],
      options: Record<string, unknown>,
    ) => Promise<ReturnType<typeof spawn>>;

    expect(await start.call(
      manager,
      active,
      OWNED_DOCKER_THERMAL_WORKLOADS.museTalk,
      containerName,
      "/usr/bin/python3",
      ["wrapper.py", "--container-name", containerName],
      { cwd: "/tmp", env: { DGX_JOB_ID: dgxJobId } },
    )).toBe(child);

    expect(persistedAtSpawn).toEqual({
      schemaVersion: "ltx-studio-owned-docker-container.v2",
      name: containerName,
      containerId: null,
      dgxJobId,
      workload: "musetalk",
      state: "bound",
      startGateReleasedAt: null,
      absenceProofStartedAt: null,
      absenceProofCount: 0,
    });
    const persistedAfterSpawn = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persistedAfterSpawn[0]?.ownedDockerContainer).toMatchObject({ state: "running" });
  });

  it("rejects refiner wrapper drift before binding or spawning any Docker authority", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const dgxJobId = testDgxJobId("owned-wrapper-contract");
    const containerName = `ltx-musetalk-${created.id}`;
    active.status = "running";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const spawnBound = vi.fn();
    Reflect.set(manager, "spawnBoundProcess", spawnBound);
    const start = Reflect.get(manager, "spawnOwnedDockerRefiner") as (
      job: unknown,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.museTalk,
      name: string,
      executable: string,
      args: string[],
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    const invalidContracts = [
      { args: ["wrapper.py"], env: { DGX_JOB_ID: dgxJobId } },
      {
        args: ["wrapper.py", "--container-name", containerName, "--container-name", containerName],
        env: { DGX_JOB_ID: dgxJobId },
      },
      { args: ["wrapper.py", `--container-name=${containerName}`], env: { DGX_JOB_ID: dgxJobId } },
      {
        args: ["wrapper.py", "--container-name", containerName],
        env: { DGX_JOB_ID: "dgx-job-foreign" },
      },
    ];

    for (const contract of invalidContracts) {
      await expect(start.call(
        manager,
        active,
        OWNED_DOCKER_THERMAL_WORKLOADS.museTalk,
        containerName,
        "/usr/bin/python3",
        contract.args,
        { cwd: "/tmp", env: contract.env },
      )).rejects.toThrow("persistierten Autorität");
      expect(active.ownedDockerContainer).toBeUndefined();
    }
    expect(spawnBound).not.toHaveBeenCalled();
  });

  it("keeps all owned-refiner signal paths free of name-based Docker mutations", async () => {
    const scriptRoot = join(repoRoot, "apps", "ltx-studio", "scripts");
    for (const script of [
      "latentsync-refiner.py",
      "musetalk-refiner.py",
      "lipforcing-refiner.py",
    ]) {
      const source = await readFile(join(scriptRoot, script), "utf8");
      expect(source).not.toMatch(/stop_owned_container|signal\.signal/u);
      expect(source).not.toMatch(/docker[^\n]{0,80}stop[^\n]{0,80}container_name/iu);
    }
  });

  it("keeps the refiner child behind an inherited-FD gate until process-group persistence succeeds", async () => {
    const path = await statePath();
    const wrapper = join(path, "..", "gated-refiner.py");
    const sideEffect = join(path, "..", "gated-refiner-side-effect");
    await writeFile(wrapper, `from pathlib import Path\nPath(${JSON.stringify(sideEffect)}).write_text('docker-run')\n`);
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const dgxJobId = testDgxJobId("owned-start-gate-crash");
    const containerName = `ltx-latentsync-${created.id}`;
    const docker = ownedDockerFixture(containerName, dgxJobId, { exists: false });
    Reflect.set(manager, "ownedDockerOperations", docker.operations);
    active.status = "running";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    let spawnedChild: ReturnType<typeof spawn> | undefined;
    Reflect.set(
      manager,
      "spawnBoundProcess",
      (_job: unknown, executable: string, args: string[], options: { genericGate?: boolean }) => {
        expect(options.genericGate).toBe(true);
        spawnedChild = spawn(process.execPath, [
          "-e",
          "const fs=require('node:fs');const cp=require('node:child_process');"
            + "const token=Buffer.alloc(1);fs.readSync(3,token,0,1,null);"
            + "if(token.toString()!=='1')process.exit(125);"
            + "const result=cp.spawnSync(process.argv[1],process.argv.slice(2),{stdio:'inherit'});"
            + "process.exit(result.status ?? 125);",
          executable,
          ...args,
        ], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        });
        return spawnedChild;
      },
    );
    let markEnteredResolve!: () => void;
    const markEntered = new Promise<void>((resolvePromise) => { markEnteredResolve = resolvePromise; });
    let failMarkResolve!: () => void;
    const failMark = new Promise<void>((resolvePromise) => { failMarkResolve = resolvePromise; });
    Reflect.set(manager, "markProcessStarted", async () => {
      markEnteredResolve();
      await failMark;
      throw new Error("synthetic crash before process-group persistence");
    });
    const start = Reflect.get(manager, "spawnOwnedDockerRefiner") as (
      job: unknown,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
      name: string,
      executable: string,
      args: string[],
      options: Record<string, unknown>,
    ) => Promise<ReturnType<typeof spawn>>;

    const starting = start.call(
      manager,
      active,
      OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
      containerName,
      "/usr/bin/python3",
      [wrapper, "--container-name", containerName],
      { cwd: "/tmp", env: { DGX_JOB_ID: dgxJobId } },
    );
    await markEntered;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    await expect(access(sideEffect)).rejects.toThrow();

    failMarkResolve();
    await expect(starting).rejects.toThrow("synthetic crash before process-group persistence");
    if (spawnedChild && spawnedChild.exitCode === null && spawnedChild.signalCode === null) {
      await new Promise<void>((resolvePromise) => spawnedChild!.once("close", () => resolvePromise()));
    }

    await expect(access(sideEffect)).rejects.toThrow();
    expect(docker.mutationCommands()).toEqual([]);
    expect(active.ownedDockerContainer).toBeUndefined();
  }, 10_000);

  it("keeps every relative-path target behind the durable PG gate until its identity commit", async () => {
    const path = await statePath();
    const root = join(path, "..");
    const targetName = "relative-gated-target";
    const targetPath = join(root, targetName);
    const sideEffect = join(root, "generic-gate-side-effect");
    await writeFile(targetPath, `#!/bin/sh\nprintf committed > ${JSON.stringify(sideEffect)}\n`);
    await chmod(targetPath, 0o755);
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    active.status = "running";
    const originalMark = (Reflect.get(manager, "markProcessStarted") as (
      job: unknown,
      process: ReturnType<typeof spawn>,
    ) => Promise<void>).bind(manager);
    let markEnteredResolve!: () => void;
    const markEntered = new Promise<void>((resolvePromise) => { markEnteredResolve = resolvePromise; });
    let allowCommitResolve!: () => void;
    const allowCommit = new Promise<void>((resolvePromise) => { allowCommitResolve = resolvePromise; });
    Reflect.set(manager, "markProcessStarted", async (job: unknown, child: ReturnType<typeof spawn>) => {
      markEnteredResolve();
      await allowCommit;
      await originalMark(job, child);
    });
    const start = (Reflect.get(manager, "spawnProcessWithDurableGate") as (
      job: unknown,
      executable: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ) => Promise<ReturnType<typeof spawn>>).call(
      manager,
      active,
      targetName,
      [],
      { cwd: root, env: { PATH: `${root}:/usr/bin:/bin`, LC_ALL: "C" } },
    );

    await markEntered;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    await expect(access(sideEffect)).rejects.toThrow();
    const persistedWhileGated = JSON.parse(await readFile(path, "utf8"))[0];
    expect(persistedWhileGated).toMatchObject({ localProcessSpawnPending: true });
    expect(persistedWhileGated).not.toHaveProperty("localProcessGroupPending");

    allowCommitResolve();
    const child = await start;
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
    }
    await expect(readFile(sideEffect, "utf8")).resolves.toBe("committed");
    await (Reflect.get(manager, "confirmProcessGroupGone") as (
      job: unknown,
      process: ReturnType<typeof spawn>,
    ) => Promise<void>).call(manager, active, child);
    expect(active.localProcessSpawnPending).toBeUndefined();
    expect(active.localProcessGroupPending).toBeUndefined();
  }, 10_000);

  it("remaps a held CPU executable and media descriptor behind the generic FD gate", async () => {
    const path = await statePath();
    const root = join(path, "..");
    const mediaPath = join(root, "held-media.txt");
    const sideEffect = join(root, "fd-remap-side-effect.txt");
    await writeFile(mediaPath, "descriptor-bound-media");
    const executable = openBoundExecutable(process.execPath, ["--version"]);
    const mediaFd = openSync(mediaPath, "r");
    try {
      const request = validRequest();
      request.outputName = `fd-remap-${roots.length}.mp4`;
      request.postprocess.lipForcing.programAudioDelayMs = 80;
      const requestSha256 = experimentRequestSha256V1(request);
      const baselineJobId = "11111111-1111-4111-8111-111111111111";
      const baselineOutputName = "fd-remap-baseline.mp4";
      const baselineRequestSha256 = "b".repeat(64);
      const binding = {
        schemaVersion: "ltx-studio-experiment-run.v1" as const,
        experimentId: "22222222-2222-4222-8222-222222222222",
        protocolSha256: "a".repeat(64),
        arm: "candidate" as const,
        kind: "ablation" as const,
        variableId: "lipforcing-program-audio-delay-ms" as const,
        changedRequestPaths: ["postprocess.lipForcing.programAudioDelayMs"],
        baselineRequestSha256,
        requestSha256,
        baselineJobId,
        baselineOutputName,
      };
      const manager = new JobManager(path, false);
      const created = manager.create(request, { experiment: binding });
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      active.runProvenance = runProvenance();
      const args = [
        "-e",
        `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(sideEffect)},fs.readFileSync(4,'utf8'))`,
      ];
      const operation: CpuFfmpegOperation = {
        ...preparedCpuOperation(),
        executable: executable.binding,
        ffmpegVersion: executable.version,
        argsSha256: createHash("sha256").update(canonicalJson(args)).digest("hex"),
      };
      const classify = Reflect.get(manager, "classifyExecution") as (
        job: Record<string, unknown>,
        executionClass: "cpu-only",
        cpuReuse: CpuReuseSourceBinding,
        operation: CpuFfmpegOperation,
      ) => boolean;
      expect(classify.call(
        manager,
        active,
        "cpu-only",
        cpuReuseFixture(baselineJobId, baselineOutputName, baselineRequestSha256),
        operation,
      )).toBe(true);
      active.status = "running";
      active.startedAt = new Date().toISOString();
      const queue = Reflect.get(manager, "queue") as string[];
      queue.splice(queue.indexOf(created.id), 1);

      const waitForProcess = Reflect.get(manager, "waitForProcess") as (
        process: ReturnType<typeof spawn>,
      ) => Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>;
      let completion: ReturnType<typeof waitForProcess> | null = null;
      const child = await (Reflect.get(manager, "spawnProcessWithDurableGate") as (
        job: unknown,
        executable: string,
        args: string[],
        options: {
          cwd: string;
          env: NodeJS.ProcessEnv;
          inheritedFds: readonly number[];
          boundExecutable: ReturnType<typeof openBoundExecutable>;
        },
        beforeRelease: (process: ReturnType<typeof spawn>) => void,
      ) => Promise<ReturnType<typeof spawn>>).call(
        manager,
        active,
        "/proc/self/fd/3",
        args,
        {
          cwd: root,
          env: { ...process.env, LC_ALL: "C" },
          inheritedFds: [mediaFd],
          boundExecutable: executable,
        },
        (gatedChild) => {
          completion = waitForProcess.call(manager, gatedChild);
        },
      );
      const result = await (completion ?? waitForProcess.call(manager, child));

      expect(result).toMatchObject({ code: 0, signal: null, error: null });
      await (Reflect.get(manager, "confirmProcessGroupGone") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
      ) => Promise<void>).call(manager, active, child);
      await expect(readFile(sideEffect, "utf8")).resolves.toBe("descriptor-bound-media");
      expect(active.localProcessSpawnPending).toBeUndefined();
      expect(active.localProcessGroupPending).toBeUndefined();
    } finally {
      closeSync(mediaFd);
      closeSync(executable.fd);
    }
  }, 10_000);

  it.each([
    ["ExecutionDecision drift", "decision", /aktuelle persistierte ExecutionDecision/u],
    ["bound executable descriptor drift", "bound-executable", /EBADF|bad file descriptor/u],
    ["recheck descriptor drift", "recheck-descriptor", /EBADF|bad file descriptor/u],
    ["Activation-/Rights drift", "activation", /Activation-\/Rights-Gate/u],
    ["RuntimeTrust drift", "runtime-trust", /Runtime-Trust-Revalidierung/u],
  ] as const)(
    "never writes the generic FD3 exec token after late %s",
    async (_case, fault, expectedError) => {
      const path = await statePath();
      const root = join(path, "..");
      const sideEffect = join(root, `late-fd3-${fault}-side-effect.txt`);
      const snapshotPath = join(root, `late-fd3-${fault}-snapshot.txt`);
      await writeFile(snapshotPath, "descriptor bytes pinned before the gate");
      const executable = openBoundExecutable(process.execPath, ["--version"]);
      const snapshotFd = openSync(snapshotPath, "r");
      let executableClosed = false;
      let snapshotClosed = false;
      let denyAtRelease = false;
      let failRuntimeTrustAtRelease = false;
      const enforcerStatus = () => ({
        productStartsAllowed: !denyAtRelease,
        mode: "development" as const,
        reason: denyAtRelease
          ? "synthetic late Activation-/Rights drift"
          : "synthetic initial process authorization",
        schemaVersion: "ltx-studio-bootstrap-start-enforcer.v3" as const,
        generation: null,
        activationHeadSha256: null,
      });
      const startEnforcer = {
        decide: vi.fn(() => ({ ...enforcerStatus(), allowed: !denyAtRelease })),
        inspect: vi.fn(() => enforcerStatus()),
      };
      const runtimeTrustRevalidation = vi.fn(() => {
        if (failRuntimeTrustAtRelease) throw new Error("synthetic late RuntimeTrust drift");
      });
      try {
        const snapshotStats = fstatSync(snapshotFd);
        const recheckDescriptor = {
          fd: snapshotFd,
          revision: {
            sizeBytes: snapshotStats.size,
            modifiedAtMs: snapshotStats.mtimeMs,
            changedAtMs: snapshotStats.ctimeMs,
            fileId: String(snapshotStats.ino),
            deviceId: String(snapshotStats.dev),
            mode: snapshotStats.mode,
            uid: snapshotStats.uid,
            gid: snapshotStats.gid,
            nlink: 1 as const,
          },
          sha256: createHash("sha256").update(readFileSync(snapshotPath)).digest("hex"),
        };
        expect(snapshotStats.nlink).toBe(1);
        const manager = new JobManager(
          path,
          false,
          null,
          undefined,
          undefined,
          null,
          undefined,
          undefined,
          undefined,
          undefined,
          startEnforcer,
          runtimeTrustRevalidation,
        );
        const request = validRequest();
        request.outputName = `late-fd3-${fault}-${Date.now()}-${roots.length}.mp4`;
        request.postprocess.lipForcing.programAudioDelayMs = 80;
        const requestSha256 = experimentRequestSha256V1(request);
        const baselineJobId = "11111111-1111-4111-8111-111111111111";
        const baselineOutputName = "late-fd3-baseline.mp4";
        const baselineRequestSha256 = "b".repeat(64);
        const created = manager.create(request, {
          experiment: {
            schemaVersion: "ltx-studio-experiment-run.v1",
            experimentId: "22222222-2222-4222-8222-222222222222",
            protocolSha256: "a".repeat(64),
            arm: "candidate",
            kind: "ablation",
            variableId: "lipforcing-program-audio-delay-ms",
            changedRequestPaths: ["postprocess.lipForcing.programAudioDelayMs"],
            baselineRequestSha256,
            requestSha256,
            baselineJobId,
            baselineOutputName,
          },
        });
        const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
          .get(created.id)!;
        active.runProvenance = runProvenance();
        const args = [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(sideEffect)}, 'unsafe target exec')`,
        ];
        const operation: CpuFfmpegOperation = {
          ...preparedCpuOperation(),
          executable: executable.binding,
          ffmpegVersion: executable.version,
          argsSha256: createHash("sha256").update(canonicalJson(args)).digest("hex"),
        };
        const classify = Reflect.get(manager, "classifyExecution") as (
          job: Record<string, unknown>,
          executionClass: "cpu-only",
          cpuReuse: CpuReuseSourceBinding,
          cpuOperation: CpuFfmpegOperation,
        ) => boolean;
        expect(classify.call(
          manager,
          active,
          "cpu-only",
          cpuReuseFixture(baselineJobId, baselineOutputName, baselineRequestSha256),
          operation,
        )).toBe(true);
        active.status = "running";
        active.startedAt = new Date().toISOString();
        const queue = Reflect.get(manager, "queue") as string[];
        queue.splice(queue.indexOf(created.id), 1);
        let gateEndObserved = false;
        const spawnProcessWithDurableGate = Reflect.get(manager, "spawnProcessWithDurableGate") as (
          job: Record<string, unknown>,
          executablePath: string,
          processArgs: string[],
          options: {
            cwd: string;
            env: NodeJS.ProcessEnv;
            boundExecutable: typeof executable;
            recheckDescriptors: readonly [typeof recheckDescriptor] | readonly [];
          },
          beforeRelease: (child: ReturnType<typeof spawn>) => void,
        ) => Promise<ReturnType<typeof spawn>>;
        const spawning = spawnProcessWithDurableGate.call(
          manager,
          active,
          "/proc/self/fd/3",
          args,
          {
            cwd: root,
            env: { ...process.env, LC_ALL: "C" },
            boundExecutable: executable,
            recheckDescriptors: fault === "recheck-descriptor" ? [recheckDescriptor] : [],
          },
          (gatedChild) => {
            const gate = gatedChild.stdio[3] as PassThrough;
            gate.end = (() => {
              gateEndObserved = true;
              throw new Error("generic FD3 exec token was unexpectedly written");
            }) as typeof gate.end;
            if (fault === "decision") {
              active.executionDecision = undefined;
            } else if (fault === "bound-executable") {
              closeSync(executable.fd);
              executableClosed = true;
            } else if (fault === "recheck-descriptor") {
              closeSync(snapshotFd);
              snapshotClosed = true;
            } else if (fault === "activation") {
              denyAtRelease = true;
            } else {
              failRuntimeTrustAtRelease = true;
            }
          },
        );

        await expect(spawning).rejects.toThrow(expectedError);

        expect(gateEndObserved).toBe(false);
        expect(runtimeTrustRevalidation).toHaveBeenCalledTimes(fault === "runtime-trust" ? 2 : 1);
        await expect(access(sideEffect)).rejects.toThrow();
        expect(active.localProcessSpawnPending).toBeUndefined();
        expect(active.localProcessGroupPending).toBeUndefined();
        expect(active.localProcessGroupIdentity).toBeUndefined();
        expect(active.ownedDockerContainer).toBeUndefined();
      } finally {
        if (!snapshotClosed) closeSync(snapshotFd);
        if (!executableClosed) closeSync(executable.fd);
      }
    },
    10_000,
  );

  it("rejects inherited descriptors outside a CPU-only execution before spawning", async () => {
    const path = await statePath();
    const descriptor = openSync("/dev/null", "r");
    try {
      const manager = new JobManager(path, false);
      const created = manager.create(validRequest());
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      active.runProvenance = runProvenance();
      expect((Reflect.get(manager, "classifyExecution") as (
        job: unknown,
        executionClass: "dgx",
      ) => boolean).call(manager, active, "dgx")).toBe(true);
      active.status = "running";
      active.startedAt = new Date().toISOString();

      await expect((Reflect.get(manager, "spawnProcessWithDurableGate") as (
        job: unknown,
        executable: string,
        args: string[],
        options: { cwd: string; env: NodeJS.ProcessEnv; inheritedFds: readonly number[] },
      ) => Promise<ReturnType<typeof spawn>>).call(
        manager,
        active,
        "/bin/true",
        [],
        { cwd: "/tmp", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, inheritedFds: [descriptor] },
      )).rejects.toThrow("Nur eine CPU-Operation darf gebundene Executable-, Medien- oder Prüf-FDs übergeben");
      expect(active.localProcessSpawnPending).toBeUndefined();
      expect(active.localProcessGroupPending).toBeUndefined();
      expect(active.process).toBeUndefined();
    } finally {
      closeSync(descriptor);
    }
  });

  it.each([
    ["an immediately exiting target", "/bin/true", 0],
    ["a missing target", "/definitely/missing/ltx-studio-gated-target", 1],
  ] as const)("settles %s without hanging or losing process completion", async (_case, target, code) => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    const runLoggedProcess = (Reflect.get(manager, "runLoggedProcess") as (
      job: unknown,
      executable: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ) => Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>);
    let timeout: NodeJS.Timeout | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("generic process gate did not settle")), 3_000);
      timeout.unref();
    });
    try {
      await expect(Promise.race([
        runLoggedProcess.call(manager, active, target, [], {
          cwd: "/tmp",
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        }),
        timeoutFailure,
      ])).resolves.toMatchObject({ code, signal: null, error: null });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    expect(active.localProcessSpawnPending).toBeUndefined();
    expect(active.localProcessGroupPending).toBeUndefined();
    expect(active.localProcessGroupIdentity).toBeUndefined();
  });

  it("contains an early child spawn error without an unhandled event or stale authority", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    const runLoggedProcess = Reflect.get(manager, "runLoggedProcess") as (
      job: unknown,
      executable: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ) => Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>;
    let timeout: NodeJS.Timeout | undefined;
    const timeoutFailure = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("early spawn error did not settle")), 3_000);
      timeout.unref();
    });
    try {
      const result = await Promise.race([
        runLoggedProcess.call(manager, active, "/bin/true", [], {
          cwd: join(path, "missing-cwd"),
          env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        }),
        timeoutFailure,
      ]);
      expect(result).toMatchObject({ code: null, signal: null, error: expect.any(Error) });
      expect(result.error?.message).toContain("dauerhaften Startgate");
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    await Promise.resolve();
    expect(active.localProcessSpawnPending).toBeUndefined();
    expect(active.localProcessGroupPending).toBeUndefined();
    expect(active.localProcessGroupIdentity).toBeUndefined();
    expect(active.process).toBeUndefined();
  });

  it("kills the generic gate without target exec when the PG-bind commit fails pre-rename", async () => {
    const path = await statePath();
    const root = join(path, "..");
    const target = join(root, "never-exec-target.sh");
    const sideEffect = join(root, "never-exec-side-effect");
    await writeFile(target, `#!/bin/sh\nprintf unsafe > ${JSON.stringify(sideEffect)}\n`);
    await chmod(target, 0o755);
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    active.status = "running";
    const originalPersist = (Reflect.get(manager, "persist") as () => void).bind(manager);
    Reflect.set(manager, "persist", () => {
      if (active.localProcessGroupPending === true && active.localProcessSpawnPending === undefined) {
        throw new Error("synthetic generic PG-bind pre-rename failure");
      }
      originalPersist();
    });

    await expect((Reflect.get(manager, "spawnProcessWithDurableGate") as (
      job: unknown,
      executable: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ) => Promise<ReturnType<typeof spawn>>).call(
      manager,
      active,
      target,
      [],
      { cwd: root, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
    )).rejects.toThrow("synthetic generic PG-bind pre-rename failure");

    await expect(access(sideEffect)).rejects.toThrow();
    expect(active.localProcessSpawnPending).toBeUndefined();
    expect(active.localProcessGroupPending).toBeUndefined();
    expect(active.localProcessGroupIdentity).toBeUndefined();
  }, 10_000);

  it("delivers cancellation exactly once after a pre-spawn gate marker is cleared", async () => {
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("cancel-at-spawn-gate");
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "running";
    active.startedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const queue = Reflect.get(manager, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    (Reflect.get(manager, "prepareLocalProcessSpawn") as (job: unknown) => void).call(manager, active);

    expect(manager.cancel(created.id)).toMatchObject({
      status: "cancelled",
      cancellationState: "settling",
    });
    expect(transitions).toEqual([]);

    (Reflect.get(manager, "clearLocalProcessSpawnPending") as (job: unknown) => void)
      .call(manager, active);
    for (let attempt = 0; attempt < 100 && transitions.length === 0; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    expect(transitions).toEqual(["cancelled"]);
    expect(manager.get(created.id)?.cancellationState).toBe("settled");
    expect(active.localProcessSpawnPending).toBeUndefined();
  });

  it("restores a real pre-PG spawn snapshot without ever executing the gated target", async () => {
    const sourcePath = await statePath();
    const restorePath = await statePath();
    const root = join(sourcePath, "..");
    const target = join(root, "crash-window-target.sh");
    const sideEffect = join(root, "crash-window-side-effect");
    await writeFile(target, `#!/bin/sh\nprintf unsafe > ${JSON.stringify(sideEffect)}\n`);
    await chmod(target, 0o755);
    const source = new JobManager(sourcePath, false);
    const created = source.create(validRequest());
    const dgxJobId = testDgxJobId("real-spawn-pending-restore");
    const active = (Reflect.get(source, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(source, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(source, active, "dgx")).toBe(true);
    active.status = "running";
    active.startedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const queue = Reflect.get(source, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    (Reflect.get(source, "changed") as () => void).call(source);

    let gatedChild!: ReturnType<typeof spawn>;
    let markEnteredResolve!: () => void;
    const markEntered = new Promise<void>((resolvePromise) => { markEnteredResolve = resolvePromise; });
    let simulateCrashResolve!: () => void;
    const simulateCrash = new Promise<void>((resolvePromise) => { simulateCrashResolve = resolvePromise; });
    Reflect.set(source, "markProcessStarted", async (_job: unknown, child: ReturnType<typeof spawn>) => {
      gatedChild = child;
      markEnteredResolve();
      await simulateCrash;
      throw new Error("synthetic parent crash before PG identity commit");
    });
    const starting = (Reflect.get(source, "spawnProcessWithDurableGate") as (
      job: unknown,
      executable: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
    ) => Promise<ReturnType<typeof spawn>>).call(
      source,
      active,
      target,
      [],
      { cwd: root, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
    );
    await markEntered;

    const crashSnapshot = await readFile(sourcePath, "utf8");
    expect(JSON.parse(crashSnapshot)[0]).toMatchObject({
      id: created.id,
      status: "running",
      localProcessProtocol: "fd-gate.v1",
      localProcessSpawnPending: true,
      dgxJobId,
    });
    await writeFile(restorePath, crashSnapshot);
    const closed = new Promise<void>((resolvePromise) => gatedChild.once("close", () => resolvePromise()));
    (gatedChild.stdio[3] as { destroy: () => void }).destroy();
    await closed;
    simulateCrashResolve();
    await expect(starting).rejects.toThrow("synthetic parent crash before PG identity commit");
    await expect(access(sideEffect)).rejects.toThrow();

    const transitions: string[] = [];
    const restored = new JobManager(restorePath, false, null, undefined, {
      read: async (jobId) => boundDgxRead(created.id, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(created.id, jobId, state);
      },
    }, null);
    const restoredInternal = (Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    expect(restored.get(created.id)).toMatchObject({
      status: "interrupted",
      dgxJobId,
      cancellationState: null,
      logs: expect.arrayContaining([
        expect.stringContaining("Parent-FD-Gate"),
      ]),
    });
    expect(restored.experimentRetryAuthority(created.id)?.settlementPending).toBe(true);
    expect(restoredInternal.localProcessSpawnPending).toBeUndefined();
    expect(Reflect.get(restored, "queue")).not.toContain(created.id);
    expect(JSON.parse(await readFile(restorePath, "utf8"))[0])
      .not.toHaveProperty("localProcessSpawnPending");

    const flush = Reflect.get(restored, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;
    await expect(flush.call(restored, restoredInternal)).resolves.toBe(true);
    await expect(flush.call(restored, restoredInternal)).resolves.toBe(true);
    expect(transitions).toEqual(["cancelled"]);
    expect(restored.experimentRetryAuthority(created.id)?.settlementPending).toBe(false);
    await expect(access(sideEffect)).rejects.toThrow();
  }, 10_000);

  it("does not spawn LTX after shutdown wins the thermal-baseline race", async () => {
    const path = await statePath();
    const marker = join(path, "..", "spawned-after-shutdown");
    const executable = join(path, "..", "spawn-marker.sh");
    await writeFile(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(executable, 0o755);
    let releaseBaseline!: () => void;
    let baselineStartedResolve!: () => void;
    const baselineStarted = new Promise<void>((resolve) => {
      baselineStartedResolve = resolve;
    });
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    const manager = new JobManager(
      path,
      false,
      null,
      {
        capture: async () => notApplicableIdentityEvidence(),
        verify: async (evidence) => ({ evidence, error: null }),
      },
      undefined,
      null,
      undefined,
      {
        capture: async () => runProvenance(),
        verify: async (evidence) => ({ evidence, error: null }),
      },
    );
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      plan: { executable: string; outputPath: string; requiredPaths: unknown[] };
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.plan.requiredPaths = [];
    runtimeJob.plan.outputPath = join(path, "..", "thermal-race-output.mp4");
    Reflect.set(manager, "waitForDgxQueueStart", async () => true);
    Reflect.set(manager, "verifyJobIdentityEvidence", async () => true);
    Reflect.set(manager, "verifyJobRunProvenance", async () => true);
    Reflect.set(manager, "modelInventoryOperations", {
      read: async () => verifiedModelInventory(),
    });
    Reflect.set(manager, "readThermalBaseline", async () => {
      runtimeJob.plan.executable = executable;
      baselineStartedResolve();
      await baselineGate;
      return 50;
    });
    const queue = Reflect.get(manager, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    Reflect.set(manager, "runningId", created.id);
    const run = Reflect.get(manager, "run") as (job: unknown) => Promise<void>;
    const running = run.call(manager, runtimeJob);
    Reflect.set(manager, "activeRunPromise", running);
    await baselineStarted;

    const shutdown = manager.shutdown(500);
    releaseBaseline();
    const report = await shutdown;
    await running;

    expect(report.queuedPreserved).toBe(1);
    expect(manager.get(created.id)?.status).toBe("queued");
    await expect(access(marker)).rejects.toThrow();
  });

  it("enters startup HOLD rather than releasing a lease with an unproven process group", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async () => {
        throw new Error("remote read must remain fenced");
      },
      transition: async () => {
        throw new Error("remote transition must remain fenced");
      },
    }, null);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
    const active = internalJobs.get(created.id)!;
    active.status = "running";
    bindTestDgxLease(
      active,
      created.id,
      testDgxJobId("unproven-local-group"),
      active.request as ReturnType<typeof validRequest>,
    );
    active.localProcessGroupPending = true;
    Reflect.set(manager, "runningId", created.id);

    const report = await manager.shutdown(250);

    expect(report).toMatchObject({
      localGroupsStopped: 0,
      remoteConfirmed: 0,
      remotePending: 1,
    });
    const restored = new JobManager(path, false, null, undefined, undefined, null);
    expect(restored.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(restored.get(created.id)).toBeUndefined();
    expect(() => restored.create(validRequest())).toThrow(JobPersistenceHoldError);
  });

  it("rolls back a running cancellation on persist failure and signals exactly once after retry", async () => {
    const path = await statePath();
    const signalReceipt = join(path, "..", "sigterm-receipt.txt");
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("running-persist-rollback");
    let studioJobId = "";
    const manager = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const child = spawn(process.execPath, [
      "-e",
      `const fs=require('node:fs');process.on('SIGTERM',()=>{fs.appendFileSync(${JSON.stringify(signalReceipt)},'term\\n');process.exit(0)});process.stdout.write('ready\\n');setInterval(()=>{},1000)`,
    ], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (!child.pid || !child.stdout) throw new Error("Cancellation-Testprozess besitzt keine PID/stdout.");
    const processGroupId = child.pid;
    try {
      await new Promise<void>((resolvePromise) => child.stdout!.once("data", () => resolvePromise()));
      active.status = "running";
      active.startedAt = new Date().toISOString();
      bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
      const queue = Reflect.get(manager, "queue") as string[];
      queue.splice(queue.indexOf(created.id), 1);
      const markProcessStarted = Reflect.get(manager, "markProcessStarted") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
      ) => Promise<void>;
      await markProcessStarted.call(manager, active, child);
      const publicBefore = structuredClone(manager.get(created.id));
      const logsBefore = [...active.logs as string[]];
      const originalPersist = (Reflect.get(manager, "persist") as () => void).bind(manager);
      let failPersistOnce = true;
      Reflect.set(manager, "persist", () => {
        if (failPersistOnce) {
          failPersistOnce = false;
          throw new Error("synthetic running cancellation persistence failure");
        }
        originalPersist();
      });

      expect(() => manager.cancel(created.id)).toThrow(
        "synthetic running cancellation persistence failure",
      );
      expect(manager.get(created.id)).toEqual(publicBefore);
      expect(active.logs).toEqual(logsBefore);
      expect(active.dgxTerminalDelivery).toBeUndefined();
      expect(() => process.kill(-processGroupId, 0)).not.toThrow();
      await expect(access(signalReceipt)).rejects.toThrow();

      const cancellationStates: string[] = [];
      manager.on("changed", (jobs: StudioJob[]) => {
        const state = jobs.find((job) => job.id === created.id)?.cancellationState;
        if (state) cancellationStates.push(state);
      });
      expect(manager.cancel(created.id)).toMatchObject({
        status: "cancelled",
        cancellationState: "settling",
      });
      await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
      for (let attempt = 0; attempt < 100
        && manager.get(created.id)?.cancellationState !== "settled"; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      expect(await readFile(signalReceipt, "utf8")).toBe("term\n");
      expect(transitions).toEqual(["cancelled"]);
      expect(manager.get(created.id)?.cancellationState).toBe("settled");
      expect(cancellationStates[0]).toBe("settling");
      expect(cancellationStates.at(-1)).toBe("settled");
    } finally {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // Expected after the successful retry has terminated the process group.
      }
    }
  }, 10_000);

  it("reconciles a persisted process group after restart without risking PID-reuse signalling", async () => {
    const path = await statePath();
    const first = new JobManager(path, false);
    const created = first.create(validRequest());
    const dgxJobId = testDgxJobId("restart-process-group");
    const internalJobs = Reflect.get(first, "jobs") as Map<string, Record<string, unknown>>;
    const active = internalJobs.get(created.id)!;
    const child = spawn("/usr/bin/python3", ["-c", "import time; time.sleep(30)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Recovery-Testprozess besitzt keine PID.");
    const processGroupId = child.pid;
    try {
      active.status = "interrupted";
      bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
      const markProcessStarted = Reflect.get(first, "markProcessStarted") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
      ) => Promise<void>;
      await markProcessStarted.call(first, active, child);
      const prepareTerminal = Reflect.get(first, "prepareDgxTerminalDelivery") as (
        job: unknown,
        state: string,
        metadata: Record<string, string>,
      ) => void;
      prepareTerminal.call(first, active, "cancelled", {
        current_step: "synthetic restart recovery",
      });
      (Reflect.get(first, "changed") as () => void).call(first);

      const transitions: string[] = [];
      const restored = new JobManager(path, false, null, undefined, {
        read: async (jobId) => boundDgxRead(created.id, jobId, "running"),
        transition: async (jobId, state) => {
          transitions.push(state);
          return boundDgxTransition(created.id, jobId, state);
        },
      }, null);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(transitions).toEqual([]);

      process.kill(-processGroupId, "SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      for (let attempt = 0; attempt < 300 && transitions.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(transitions).toEqual(["cancelled"]);
      const recovered = Reflect.get(restored, "jobs").get(created.id);
      expect(recovered.localProcessGroupPending).toBeUndefined();
      expect(recovered.localProcessGroupIdentity).toBeUndefined();
      expect(recovered.dgxJobTerminal).toBe(true);
    } finally {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The test intentionally removes the old process group before reconciliation.
      }
    }
  }, 10_000);

  it("treats a same-boot PGID with different leader start ticks as safe reuse", async () => {
    const path = await statePath();
    const first = new JobManager(path, false);
    const created = first.create(validRequest());
    const dgxJobId = testDgxJobId("reused-process-group");
    const active = (Reflect.get(first, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "interrupted";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    active.localProcessGroupPending = true;
    active.localProcessGroupIdentity = {
      bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      processGroupId: process.pid,
      leaderStartTicks: "0",
    };
    const prepareTerminal = Reflect.get(first, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: string,
      metadata: Record<string, string>,
    ) => void;
    prepareTerminal.call(first, active, "cancelled", {
      current_step: "synthetic PGID reuse recovery",
    });
    (Reflect.get(first, "changed") as () => void).call(first);

    const transitions: string[] = [];
    const restored = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(created.id, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(created.id, jobId, state);
      },
    }, null);
    for (let attempt = 0; attempt < 100 && transitions.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(transitions).toEqual(["cancelled"]);
    const recovered = Reflect.get(restored, "jobs").get(created.id);
    expect(recovered.localProcessGroupPending).toBeUndefined();
    expect(recovered.dgxJobTerminal).toBe(true);
  });

  it("persists an ambiguous in-flight submit and terminalizes a late acceptance", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("submit-after-shutdown-deadline");
    let studioJobId = "";
    let submitStartedResolve!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      submitStartedResolve = resolve;
    });
    let releaseSubmitResolve!: () => void;
    const releaseSubmit = new Promise<void>((resolve) => {
      releaseSubmitResolve = resolve;
    });
    const transitions: string[] = [];
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "accepted"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null, {
      submit: async (admissionRequest) => {
        submitStartedResolve();
        await releaseSubmit;
        return boundDgxSubmit(studioJobId, dgxJobId, "accepted", admissionRequest);
      },
    });
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, unknown>).get(created.id)!;
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;
    const waiting = waitForDgxQueueStart.call(manager, runtimeJob);
    Reflect.set(manager, "runningId", created.id);
    Reflect.set(manager, "activeRunPromise", waiting.then(() => undefined));
    await submitStarted;

    const report = await manager.shutdown(25);
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(report).toMatchObject({ queuedPreserved: 0, remotePending: 1 });
    expect(persisted[0]).toMatchObject({
      id: created.id,
      status: "interrupted",
      dgxSubmitPending: true,
    });

    releaseSubmitResolve();
    expect(await waiting).toBe(false);
    expect(transitions).toEqual(["cancelled"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "interrupted",
      dgxJobId,
    });
  });

  it("allows the orchestrator to see a job before the local swap start gate is met", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 80,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 0.25,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));

    const waitForPreAdmission = Reflect.get(manager, "waitForLocalPreAdmissionResources") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await waitForPreAdmission.call(manager, runtimeJob)).toBe(true);
    expect(manager.get(created.id)?.logs).toEqual(expect.arrayContaining([
      expect.stringContaining("Queue-Vorab-Gate erfüllt"),
      expect.stringContaining("vom DGX-Orchestrator entschieden"),
    ]));
  });

  it("submits a low-swap job so the orchestrator can make the start decision", async () => {
    let submits = 0;
    let submittedMemoryGiB: number | undefined;
    const dgxJobId = testDgxJobId("low-swap-visible");
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, undefined, null, {
      submit: async (admissionRequest) => {
        submits += 1;
        submittedMemoryGiB = admissionRequest.estimated_memory_gib;
        return boundDgxSubmit(studioJobId, dgxJobId, "accepted", admissionRequest);
      },
    });
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 80,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 0.25,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));
    Reflect.set(manager, "startAcceptedDgxJob", async () => "started");

    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await waitForDgxQueueStart.call(manager, runtimeJob)).toBe(true);
    expect(submits).toBe(1);
    expect(submittedMemoryGiB).toBe(58);
    expect(manager.get(created.id)).toMatchObject({
      status: "queued",
      dgxJobId,
    });
  });

  it("persists the provisional IA2V memory basis in the actual queue log", async () => {
    let submitted: AdmissionRequest | null = null;
    const dgxJobId = testDgxJobId("ia2v-provisional-memory-basis");
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, undefined, null, {
      submit: async (admissionRequest) => {
        submitted = admissionRequest;
        return boundDgxSubmit(studioJobId, dgxJobId, "accepted", admissionRequest);
      },
    });
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.width = 1024;
    request.height = 1536;
    request.numFrames = 289;
    request.frameRate = 24;
    request.audio.maxDuration = null;
    request.tiling = true;
    request.enhancePrompt = false;
    request.longClipAcknowledged = true;
    const created = manager.create(request);
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, unknown>).get(created.id)!;
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 80,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 1,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));
    Reflect.set(manager, "startAcceptedDgxJob", async () => "started");

    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;
    expect(await waitForDgxQueueStart.call(manager, runtimeJob)).toBe(true);

    expect(submitted).toMatchObject({
      estimated_memory_gib: 82,
      resource_profile: { required_gib: 82 },
    });
    expect(manager.get(created.id)?.logs).toEqual(expect.arrayContaining([
      expect.stringContaining(
        "RAM-Basis provisional-proxy:ltx-2.5-split-bf16-ia2v-1024x1536-289f-observed-conservative-floor-82gib.v2",
      ),
    ]));
  });

  it("fails every incomplete, resumed, swapped, or forcibly cleaned telemetry calibration closed", () => {
    const observer: LocalProcessResourceObserverIdentity = {
      schemaVersion: "ltx-studio-local-process-resource-observer.v1",
      executable: "/usr/bin/nvidia-smi",
      executableSha256: "a".repeat(64),
      versionArguments: ["--version"],
      versionOutputSha256: "b".repeat(64),
      versionFirstLine: "NVIDIA-SMI fixture",
      queryArguments: [
        "--query-compute-apps=pid,used_memory",
        "--format=csv,noheader,nounits",
      ],
      queryTimeoutMs: 750,
      environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
      dynamicLibraries: [{
        name: "nvml",
        path: "/usr/lib/aarch64-linux-gnu/libnvidia-ml.so.580.173.02",
        sha256: "e".repeat(64),
        licensePath: "/usr/share/doc/libnvidia-compute-580/copyright",
        licenseSha256: "f".repeat(64),
      }],
      residentAccounting: "vmrss-plus-nvidia-used-memory-conservative-envelope.v1",
    };
    const summary: LocalProcessResourceTelemetrySummary = {
      schemaVersion: "ltx-studio-local-process-resource-summary.v1",
      identity: {
        bootId: "11111111-1111-4111-8111-111111111111",
        processGroupId: 100,
        leaderStartTicks: "1000",
      },
      startedAt: "2026-08-28T00:00:00.000Z",
      finishedAt: "2026-08-28T00:00:01.000Z",
      intervalMs: 1_000,
      maximumPermittedGapMs: 3_000,
      observer,
      sampleCount: 2,
      lastSuccessfulSequence: 2,
      terminalGapMs: 0,
      maxGapMs: 1_000,
      quality: "sufficient",
      qualityReasons: [],
      sourceErrors: [],
      jsonl: {
        name: "local-process-resources.v1.jsonl",
        bytes: 2,
        sha256: "c".repeat(64),
      },
      metrics: {
        host: {
          minimumMemFreeKiB: 20 * 1_048_576,
          minimumMemAvailableKiB: 40 * 1_048_576,
          swapTotalKiB: 1,
          minimumSwapFreeKiB: 1,
          pswpinDeltaPages: 0,
          pswpoutDeltaPages: 0,
        },
        processGroup: {
          maximumProcessCount: 1,
          maximumRssAnonKiB: 1,
          maximumVmRssKiB: 1,
          maximumVmHwmKiB: 1,
          maximumVmSwapKiB: 0,
          maximumNvidiaUsedMemoryMiB: 1,
          maximumAccountedResidentKiB: 1,
        },
      },
    };
    const valid = {
      binding: {
        cooperativeGeneration: 0,
        declaredMemoryGiB: 82,
        requiredMemoryGiB: 82,
        memoryBasis:
          "provisional-proxy:ltx-2.5-split-bf16-ia2v-1024x1536-289f-observed-conservative-floor-82gib.v2",
        processIdentity: summary.identity,
        observerIdentity: observer,
      },
      summary,
      observerError: null,
      result: { code: 0, signal: null, error: null },
      processGroupGone: true,
      processGroupExitedNaturally: true,
      thermalPauseCount: 0,
      outputBound: true,
      outputTechnicalValid: true,
    };
    expect(ltxResourceTelemetryMeasurementBlockers(valid)).toEqual([]);

    const cases = [
      [{ binding: { ...valid.binding, cooperativeGeneration: 1 } }, "resumed_generation_requires_job_rollup"],
      [{ processGroupExitedNaturally: false }, "process_group_required_forced_cleanup"],
      [{ thermalPauseCount: 1 }, "thermal_pause_observed"],
      [{ summary: { ...summary, sampleCount: 1 } }, "fewer_than_two_samples"],
      [{ summary: {
        ...summary,
        metrics: {
          ...summary.metrics,
          processGroup: { ...summary.metrics.processGroup, maximumVmSwapKiB: 1 },
        },
      } }, "process_group_swap_observed"],
      [{ summary: {
        ...summary,
        metrics: {
          ...summary.metrics,
          host: { ...summary.metrics.host, pswpoutDeltaPages: 1 },
        },
      } }, "host_swap_out_observed"],
      [{ summary: {
        ...summary,
        metrics: {
          ...summary.metrics,
          host: { ...summary.metrics.host, minimumMemAvailableKiB: 12 * 1_048_576 - 1 },
        },
      } }, "host_minimum_available_below_12_gib"],
      [{ summary: {
        ...summary,
        metrics: {
          ...summary.metrics,
          processGroup: {
            ...summary.metrics.processGroup,
            maximumAccountedResidentKiB: 82 * 1_048_576 + 1,
          },
        },
      } }, "resident_peak_exceeds_declared_memory"],
      [{ observerError: "observer failed" }, "observer failed"],
      [{ outputBound: false }, "output_unbound"],
      [{ outputTechnicalValid: false }, "output_technical_contract_invalid"],
      [{ result: { code: 1, signal: null, error: null } }, "process_exit_1"],
      [{ result: { code: 0, signal: "SIGTERM", error: null } }, "process_signal_SIGTERM"],
      [{ binding: {
        ...valid.binding,
        observerIdentity: { ...observer, executableSha256: "d".repeat(64) },
      } }, "observer_identity_mismatch"],
    ] as const;
    for (const [override, expectedBlocker] of cases) {
      expect(ltxResourceTelemetryMeasurementBlockers({ ...valid, ...override }))
        .toContain(expectedBlocker);
    }
  });

  it("binds an ineligible pre-start telemetry attempt without releasing the FD3 target", async () => {
    const path = await statePath();
    const root = join(path, "..");
    const sideEffect = join(root, "ia2v-prestart-telemetry-target-started");
    const target = join(root, "ia2v-prestart-telemetry-target.sh");
    await writeFile(target, `#!/bin/sh
printf started > ${JSON.stringify(sideEffect)}
`);
    await chmod(target, 0o755);

    const manager = new JobManager(path, false);
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.width = 1024;
    request.height = 1536;
    request.numFrames = 289;
    request.frameRate = 24;
    request.audio.maxDuration = null;
    request.tiling = true;
    request.enhancePrompt = false;
    request.longClipAcknowledged = true;
    request.outputName = `ia2v-prestart-telemetry-${Date.now()}.mp4`;
    const created = manager.create(request);
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: Record<string, unknown>,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    active.status = "running";
    active.startedAt = new Date().toISOString();

    const dgxJobId = testDgxJobId(`ia2v-prestart-telemetry-${created.id}`);
    const [preparedAdmission] = buildAdmissionRequests(request, undefined, created.id);
    const admissionSha256 = createHash("sha256")
      .update(canonicalJson(preparedAdmission))
      .digest("hex");
    const leaseReceipt = {
      ...testDgxLeaseReceipt(created.id, dgxJobId, request),
      preparedAdmission,
      preparedAdmissionSha256: admissionSha256,
    };
    active.dgxSubmitPending = true;
    active.dgxSubmitStartedAt = leaseReceipt.submitStartedAt;
    active.dgxPreparedAdmission = preparedAdmission;
    active.dgxPreparedAdmissionSha256 = admissionSha256;
    (Reflect.get(manager, "commitDgxLeaseReceipt") as (
      job: Record<string, unknown>,
      remote: QueueJobSummary,
      receipt: typeof leaseReceipt,
      terminalIntent: boolean,
    ) => void).call(
      manager,
      active,
      boundDgxJob(created.id, dgxJobId, "accepted"),
      leaseReceipt,
      false,
    );
    const queue = Reflect.get(manager, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    (Reflect.get(manager, "changed") as () => void).call(manager);

    const capture = vi.fn(() => ({
      sourceErrors: [{ source: "nvidia_smi", message: "synthetic first-sample failure" }],
      identityVerified: false,
      processGroup: {
        attributionVerified: false,
        accountedResidentKiB: null,
      },
    }));
    const run = vi.fn();
    Reflect.set(manager, "createLocalProcessResourceTelemetry", (options: {
      evidenceDirectory: string;
    }) => {
      mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
      return {
        observerIdentity: {
          schemaVersion: "ltx-studio-local-process-resource-observer.v1" as const,
          executable: "/usr/bin/nvidia-smi",
          executableSha256: "c".repeat(64),
          versionArguments: ["--version"] as ["--version"],
          versionOutputSha256: "d".repeat(64),
          versionFirstLine: "NVIDIA-SMI fixture",
          queryArguments: [
            "--query-compute-apps=pid,used_memory",
            "--format=csv,noheader,nounits",
          ] as const,
          queryTimeoutMs: 750 as const,
          environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } as const,
          dynamicLibraries: [{
            name: "nvml" as const,
            path: "/usr/lib/aarch64-linux-gnu/libnvidia-ml.so.580.173.02",
            sha256: "e".repeat(64),
            licensePath: "/usr/share/doc/libnvidia-compute-580/copyright" as const,
            licenseSha256: "f".repeat(64),
          }],
          residentAccounting: "vmrss-plus-nvidia-used-memory-conservative-envelope.v1" as const,
        },
        capture,
        run,
        finalize: () => {
          throw new Error("synthetic summary unavailable");
        },
      };
    });

    const startTelemetry = Reflect.get(manager, "startLtxResourceTelemetry") as (
      job: Record<string, unknown>,
      generation: number,
      executable: string,
      args: readonly string[],
    ) => Promise<unknown>;
    const spawnWithGate = Reflect.get(manager, "spawnProcessWithDurableGate") as (
      job: Record<string, unknown>,
      executable: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
      beforeRelease: () => Promise<void>,
    ) => Promise<ReturnType<typeof spawn>>;
    await expect(spawnWithGate.call(
      manager,
      active,
      target,
      [],
      { cwd: root, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
      async () => {
        await startTelemetry.call(manager, active, 0, target, []);
      },
    )).rejects.toThrow(/Peak-RAM-Telemetrie hält das Startgate geschlossen/u);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(await access(sideEffect).then(() => true, () => false)).toBe(false);

    const manifestPath = join(
      root,
      "resource-telemetry",
      created.id,
      "ltx-g0",
      "ltx-resource-telemetry.manifest.v1.json",
    );
    const manifestBytes = await readFile(manifestPath);
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    expect(manifest).toMatchObject({
      schemaVersion: "ltx-studio-ltx-resource-telemetry-manifest.v1",
      binding: {
        studioJobId: created.id,
        dgxJobId,
        cooperativeGeneration: 0,
      },
      telemetry: null,
      processOutcome: { code: null, signal: null },
      processGroupGone: false,
      processGroupExitedNaturally: false,
      output: null,
      measurementEligibleForCalibration: false,
    });
    expect(manifest.observerError).toContain("synthetic summary unavailable");

    const evidenceRole = "evidence:resource-telemetry:g0";
    const evidenceFiles = (active.runProvenance as RunProvenance).files
      .filter((file) => file.role === evidenceRole);
    expect(evidenceFiles).toHaveLength(1);
    expect(evidenceFiles[0]).toMatchObject({
      kind: "file",
      role: evidenceRole,
      path: manifestPath,
      sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    });
  });

  it("durably samples the provisional IA2V process group before writing the FD3 token", async () => {
    const path = await statePath();
    const root = join(path, "..");
    const sideEffect = join(root, "ia2v-telemetry-gated-output.mp4");
    const target = join(root, "ia2v-telemetry-gated-target.sh");
    await writeFile(target, `#!/bin/sh
exec /usr/bin/ffmpeg -hide_banner -loglevel error \\
  -f lavfi -i color=c=black:s=1024x1536:r=24:d=12.041667 \\
  -f lavfi -i anullsrc=r=48000:cl=stereo:d=12.041667 \\
  -frames:v 289 -c:v libx264 -preset ultrafast -pix_fmt yuv420p \\
  -c:a aac -ar 48000 -ac 2 -shortest ${JSON.stringify(sideEffect)}
`);
    await chmod(target, 0o755);
    const manager = new JobManager(path, false);
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.width = 1024;
    request.height = 1536;
    request.numFrames = 289;
    request.frameRate = 24;
    request.audio.maxDuration = null;
    request.tiling = true;
    request.enhancePrompt = false;
    request.longClipAcknowledged = true;
    request.outputName = `ia2v-telemetry-gate-${Date.now()}.mp4`;
    const created = manager.create(request);
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: Record<string, unknown>,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    active.status = "running";
    active.startedAt = new Date().toISOString();
    const dgxJobId = testDgxJobId(`ia2v-telemetry-gate-${created.id}`);
    const [preparedAdmission] = buildAdmissionRequests(request, undefined, created.id);
    const admissionSha256 = createHash("sha256")
      .update(canonicalJson(preparedAdmission))
      .digest("hex");
    const leaseReceipt = {
      ...testDgxLeaseReceipt(created.id, dgxJobId, request),
      preparedAdmission,
      preparedAdmissionSha256: admissionSha256,
    };
    active.dgxSubmitPending = true;
    active.dgxSubmitStartedAt = leaseReceipt.submitStartedAt;
    active.dgxPreparedAdmission = preparedAdmission;
    active.dgxPreparedAdmissionSha256 = admissionSha256;
    (Reflect.get(manager, "commitDgxLeaseReceipt") as (
      job: Record<string, unknown>,
      remote: QueueJobSummary,
      receipt: typeof leaseReceipt,
      terminalIntent: boolean,
    ) => void).call(
      manager,
      active,
      boundDgxJob(created.id, dgxJobId, "accepted"),
      leaseReceipt,
      false,
    );
    expect(active.dgxPreparedAdmission).toBeUndefined();
    expect(active.dgxPreparedAdmissionSha256).toBeUndefined();
    const queue = Reflect.get(manager, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    (Reflect.get(manager, "changed") as () => void).call(manager);

    const capture = vi.fn();
    Reflect.set(manager, "createLocalProcessResourceTelemetry", (options: {
      identity: { bootId: string; processGroupId: number; leaderStartTicks: string };
      evidenceDirectory: string;
    }) => {
      const observerIdentity = {
        schemaVersion: "ltx-studio-local-process-resource-observer.v1" as const,
        executable: "/usr/bin/nvidia-smi",
        executableSha256: "c".repeat(64),
        versionArguments: ["--version"] as ["--version"],
        versionOutputSha256: "d".repeat(64),
        versionFirstLine: "NVIDIA-SMI fixture",
        queryArguments: [
          "--query-compute-apps=pid,used_memory",
          "--format=csv,noheader,nounits",
        ] as const,
        queryTimeoutMs: 750 as const,
        environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" } as const,
        dynamicLibraries: [{
          name: "nvml" as const,
          path: "/usr/lib/aarch64-linux-gnu/libnvidia-ml.so.580.173.02",
          sha256: "e".repeat(64),
          licensePath: "/usr/share/doc/libnvidia-compute-580/copyright" as const,
          licenseSha256: "f".repeat(64),
        }] as [{
          name: "nvml";
          path: string;
          sha256: string;
          licensePath: "/usr/share/doc/libnvidia-compute-580/copyright";
          licenseSha256: string;
        }],
        residentAccounting: "vmrss-plus-nvidia-used-memory-conservative-envelope.v1" as const,
      };
      const sample = (sequence: 1 | 2) => ({
        schemaVersion: "ltx-studio-local-process-resource-sample.v1" as const,
        sequence,
        capturedAt: sequence === 1
          ? "2026-08-28T00:00:00.000Z"
          : "2026-08-28T00:00:01.000Z",
        monotonicMs: (sequence - 1) * 1_000,
        gapMs: sequence === 1 ? null : 1_000,
        identity: options.identity,
        identityVerified: true,
        host: {
          memFreeKiB: 20 * 1_048_576,
          memAvailableKiB: 40 * 1_048_576,
          swapTotalKiB: 16 * 1_048_576,
          swapFreeKiB: 15 * 1_048_576,
          pswpinPages: 0,
          pswpoutPages: 0,
        },
        processGroup: {
          attributionVerified: true,
          pids: [options.identity.processGroupId],
          processCount: 1,
          rssAnonKiB: 1_024,
          vmRssKiB: 1_024,
          vmHwmKiB: 1_024,
          vmSwapKiB: 0,
          nvidiaUsedMemoryMiB: 1,
          accountedResidentKiB: 2_048,
          nvidiaPids: [{ pid: options.identity.processGroupId, usedMemoryMiB: 1 }],
        },
        sourceErrors: [],
      });
      const samples = [sample(1), sample(2)];
      const jsonlBytes = Buffer.from(
        samples.map((value) => JSON.stringify(canonicalizeJson(value))).join("\n") + "\n",
        "utf8",
      );
      const jsonlSha256 = createHash("sha256").update(jsonlBytes).digest("hex");
      const summary = {
        schemaVersion: "ltx-studio-local-process-resource-summary.v1" as const,
        identity: options.identity,
        startedAt: "2026-08-28T00:00:00.000Z",
        finishedAt: "2026-08-28T00:00:01.000Z",
        intervalMs: 1_000 as const,
        maximumPermittedGapMs: 3_000 as const,
        observer: observerIdentity,
        sampleCount: 2,
        lastSuccessfulSequence: 2,
        terminalGapMs: 1,
        maxGapMs: 1_000,
        quality: "sufficient" as const,
        qualityReasons: [],
        sourceErrors: [],
        jsonl: {
          name: "local-process-resources.v1.jsonl" as const,
          bytes: jsonlBytes.byteLength,
          sha256: jsonlSha256,
        },
        metrics: {
          host: {
            minimumMemFreeKiB: 20 * 1_048_576,
            minimumMemAvailableKiB: 40 * 1_048_576,
            swapTotalKiB: 16 * 1_048_576,
            minimumSwapFreeKiB: 15 * 1_048_576,
            pswpinDeltaPages: 0,
            pswpoutDeltaPages: 0,
          },
          processGroup: {
            maximumProcessCount: 1,
            maximumRssAnonKiB: 1_024,
            maximumVmRssKiB: 1_024,
            maximumVmHwmKiB: 1_024,
            maximumVmSwapKiB: 0,
            maximumNvidiaUsedMemoryMiB: 1,
            maximumAccountedResidentKiB: 2_048,
          },
        },
      };
      const jsonlPath = join(options.evidenceDirectory, "local-process-resources.v1.jsonl");
      const summaryPath = join(options.evidenceDirectory, "local-process-resources.summary.v1.json");
      const summaryBytes = Buffer.from(canonicalJson(summary), "utf8");
      mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
      writeFileSync(jsonlPath, jsonlBytes, { mode: 0o600, flag: "wx" });
      writeFileSync(summaryPath, summaryBytes, { mode: 0o600, flag: "wx" });
      const receipt = {
        schemaVersion: "ltx-studio-local-process-resource-evidence.v1" as const,
        jsonlPath,
        jsonlSha256,
        summaryPath,
        summarySha256: createHash("sha256").update(summaryBytes).digest("hex"),
        summary,
      };
      return {
        observerIdentity,
        capture: () => {
          capture();
          return sample(1);
        },
        run: (signal: AbortSignal) => new Promise((resolvePromise) => {
          const finish = () => resolvePromise(receipt);
          if (signal.aborted) finish();
          else signal.addEventListener("abort", finish, { once: true });
        }),
        finalize: () => receipt,
      };
    });

    const waitForProcess = Reflect.get(manager, "waitForProcess") as (
      process: ReturnType<typeof spawn>,
    ) => Promise<{ code: number | null; signal: NodeJS.Signals | null; error: Error | null }>;
    const startTelemetry = Reflect.get(manager, "startLtxResourceTelemetry") as (
      job: Record<string, unknown>,
      generation: number,
      executable: string,
      args: readonly string[],
    ) => Promise<unknown>;
    let telemetry: unknown = null;
    let completion: ReturnType<typeof waitForProcess> | null = null;
    const child = await (Reflect.get(manager, "spawnProcessWithDurableGate") as (
      job: Record<string, unknown>,
      executable: string,
      args: string[],
      options: { cwd: string; env: NodeJS.ProcessEnv },
      beforeRelease: (process: ReturnType<typeof spawn>) => Promise<void>,
    ) => Promise<ReturnType<typeof spawn>>).call(
      manager,
      active,
      target,
      [],
      { cwd: root, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } },
      async (gatedChild) => {
        completion = waitForProcess.call(manager, gatedChild);
        telemetry = await startTelemetry.call(manager, active, 0, target, []);
        const gate = gatedChild.stdio[3] as PassThrough;
        const originalEnd = gate.end.bind(gate);
        gate.end = ((chunk: string, callback: () => void) => {
          expect(capture).toHaveBeenCalledTimes(1);
          return originalEnd(chunk, callback);
        }) as typeof gate.end;
      },
    );
    const result = await (completion ?? waitForProcess.call(manager, child));
    const finishTelemetry = Reflect.get(manager, "finishLtxResourceTelemetry") as (
      activeTelemetry: unknown,
    ) => Promise<unknown>;
    const settlement = await finishTelemetry.call(manager, telemetry);
    await (Reflect.get(manager, "confirmProcessGroupGone") as (
      job: Record<string, unknown>,
      process: ReturnType<typeof spawn>,
    ) => Promise<void>).call(manager, active, child);
    await (Reflect.get(manager, "recordLtxResourceTelemetry") as (
      job: Record<string, unknown>,
      activeTelemetry: unknown,
      telemetrySettlement: unknown,
      processResult: typeof result,
      processGroupGone: boolean,
      processGroupExitedNaturally: boolean,
      outputPath: string,
    ) => Promise<void>).call(manager, active, telemetry, settlement, result, true, true, sideEffect);

    const manifestPath = join(
      root,
      "resource-telemetry",
      created.id,
      "ltx-g0",
      "ltx-resource-telemetry.manifest.v1.json",
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const outputBytes = await readFile(sideEffect);
    expect(result).toMatchObject({ code: 0, signal: null, error: null });
    expect(outputBytes.byteLength).toBeGreaterThan(0);
    expect(manifest).toMatchObject({
      schemaVersion: "ltx-studio-ltx-resource-telemetry-manifest.v1",
      binding: {
        studioJobId: created.id,
        dgxJobId,
        declaredMemoryGiB: 82,
        requiredMemoryGiB: 82,
        memoryBasis: expect.stringMatching(/^provisional-proxy:/u),
        cooperativeGeneration: 0,
      },
      processOutcome: { code: 0, signal: null, error: null },
      processGroupGone: true,
      processGroupExitedNaturally: true,
      measurementEligibleForCalibration: true,
      output: {
        path: sideEffect,
        sizeBytes: outputBytes.byteLength,
        sha256: createHash("sha256").update(outputBytes).digest("hex"),
        technical: {
          schemaVersion: "ltx-studio-ltx-resource-output-contract.v1",
          blockers: [],
        },
      },
    });
    expect(active.logs).toEqual(expect.arrayContaining([
      expect.stringContaining("erste Prozessgruppenprobe ist vor dem Starttoken fsync-persistiert"),
      expect.stringContaining("Peak-RAM-Einzelmessung kryptografisch verifiziert"),
    ]));
    expect((active.runProvenance as RunProvenance).files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "evidence:resource-telemetry:g0",
        path: manifestPath,
        sha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex"),
      }),
    ]));
  }, 10_000);

  it("continues an adopted ambiguous lease when only its diagnostic log write fails", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("adopted-lease-diagnostic-write");
    let studioJobId = "";
    let preparedAdmission: AdmissionRequest | null = null;
    const submit = vi.fn();
    const list = vi.fn(async () => authoritativeQueueList(preparedAdmission ? [
      queueListJobHintForAdmission(studioJobId, dgxJobId, "accepted", preparedAdmission),
    ] : []));
    const manager = new JobManager(
      path,
      false,
      null,
      {
        capture: async () => notApplicableIdentityEvidence(),
        verify: async (evidence) => ({ evidence, error: null }),
      },
      undefined,
      null,
      { submit, list },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    runtimeJob.runProvenance = runProvenance();
    const classify = Reflect.get(manager, "classifyExecution") as (
      job: Record<string, unknown>,
      executionClass: "dgx",
    ) => boolean;
    expect(classify.call(manager, runtimeJob, "dgx")).toBe(true);
    bindTestPendingDgxSubmit(
      runtimeJob,
      created.id,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    preparedAdmission = runtimeJob.dgxPreparedAdmission as AdmissionRequest;
    (Reflect.get(manager, "changed") as () => void).call(manager);

    const originalPersist = (Reflect.get(manager, "persist") as () => void).bind(manager);
    let diagnosticWriteFailures = 0;
    Reflect.set(manager, "persist", () => {
      const diagnosticLeaseAlreadyBound = runtimeJob.dgxSubmitPending === undefined
        && (runtimeJob.logs as string[]).at(-1)?.includes(
          "atomar per positiver Queue-Evidenz gebunden",
        );
      if (diagnosticLeaseAlreadyBound && diagnosticWriteFailures === 0) {
        diagnosticWriteFailures += 1;
        throw new Error("synthetic post-lease diagnostic persistence failure");
      }
      originalPersist();
    });
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    const startAcceptedDgxJob = vi.fn(async () => "started" as const);
    Reflect.set(manager, "startAcceptedDgxJob", startAcceptedDgxJob);
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: Record<string, unknown>,
    ) => Promise<boolean>;

    await expect(waitForDgxQueueStart.call(manager, runtimeJob)).resolves.toBe(true);

    expect(diagnosticWriteFailures).toBe(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    expect(startAcceptedDgxJob).toHaveBeenCalledOnce();
    expect(manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    expect(manager.get(created.id)).toMatchObject({ dgxJobId });
    expect(runtimeJob.dgxSubmitPending).toBeUndefined();
    expect(runtimeJob.logs).not.toEqual(expect.arrayContaining([
      expect.stringContaining("atomar per positiver Queue-Evidenz gebunden"),
    ]));
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]).toMatchObject({ dgxJobId });
    expect(persisted[0]).not.toHaveProperty("dgxSubmitPending");
  });

  it.each([
    ["empty legacy marker", "", true],
    ["malformed marker", "not-a-timestamp", false],
  ] as const)(
    "treats %s correctly during positive ambiguous-submit discovery",
    async (_case, startedAt, shouldRecover) => {
      const dgxJobId = testDgxJobId(`ambiguous-started-at-${_case}`);
      const manager = new JobManager(
        await statePath(),
        false,
        null,
        undefined,
        undefined,
        null,
        { submit: vi.fn(), list: vi.fn() },
      );
      const created = manager.create(validRequest());
      const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      bindTestPendingDgxSubmit(
        runtimeJob,
        created.id,
        runtimeJob.request as ReturnType<typeof validRequest>,
      );
      const preparedAdmission = runtimeJob.dgxPreparedAdmission as AdmissionRequest;
      const list = vi.fn(async () => authoritativeQueueList([
        queueListJobHintForAdmission(
          created.id,
          dgxJobId,
          "accepted",
          preparedAdmission,
          { started_at: startedAt },
        ),
      ]));
      Reflect.set(manager, "dgxAdmissionOperations", { submit: vi.fn(), list });
      Reflect.set(manager, "waitForDelay", async () => false);
      const reconcile = Reflect.get(manager, "reconcilePendingDgxSubmit") as (
        job: Record<string, unknown>,
      ) => Promise<QueueJobSummary | null | undefined>;

      const recovered = await reconcile.call(manager, runtimeJob);

      if (shouldRecover) {
        expect(recovered).toMatchObject({ job_id: dgxJobId, started_at: "" });
        expect(runtimeJob).toMatchObject({ dgxJobId });
        expect(runtimeJob.dgxSubmitPending).toBeUndefined();
      } else {
        expect(recovered).toBeUndefined();
        expect(runtimeJob.dgxJobId).toBeNull();
        expect(runtimeJob.dgxSubmitPending).toBe(true);
      }
      expect(list).toHaveBeenCalledOnce();
    },
  );

  it.each(["requested_by", "source_app", "idempotency_key"] as const)(
    "never grants a DGX lease from a direct Submit response with wrong %s",
    async (fault) => {
      const path = await statePath();
      const dgxJobId = testDgxJobId(`direct-submit-${fault}`);
      let studioJobId = "";
      const read = vi.fn();
      const transition = vi.fn();
      const list = vi.fn(async () => authoritativeQueueList());
      const submit = vi.fn(async (admissionRequest: AdmissionRequest) => {
        const response = boundDgxSubmit(
          studioJobId,
          dgxJobId,
          "accepted",
          admissionRequest,
        );
        Object.assign(response.job, {
          [fault]: fault === "source_app" ? "Foreign Studio" : "ltx-studio:foreign",
        });
        return response;
      });
      const manager = new JobManager(path, false, null, undefined, {
        read,
        transition,
      }, null, { submit, list });
      Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
      Reflect.set(manager, "waitForDelay", async () => false);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
        job: unknown,
      ) => Promise<boolean>;

      await expect(waitForDgxQueueStart.call(manager, active)).resolves.toBe(false);

      expect(submit).toHaveBeenCalledTimes(1);
      expect(list).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
      expect(active).toMatchObject({
        dgxJobId: null,
        dgxSubmitPending: true,
        dgxSubmitStartedAt: expect.any(String),
      });
      expect(active).not.toHaveProperty("dgxLeaseReceipt");
      expect(manager.get(created.id)?.logs.join("\n")).toContain(
        "keine exakt caller- und idempotenzgebundene Antwort",
      );
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted[0]).toMatchObject({
        dgxJobId: null,
        dgxSubmitPending: true,
      });
      expect(persisted[0]).not.toHaveProperty("dgxLeaseReceipt");
    },
  );

  it("uses the orchestrator start fence immediately after acceptance", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      testDgxJobId("authoritative-start-fence"),
    );
    const transitions: string[] = [];
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 40,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 0.25,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));
    Reflect.set(manager, "transitionDgxJob", async (_job: unknown, state: string) => {
      transitions.push(state);
      return true;
    });

    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (
      job: unknown,
      acceptedQueueJob: QueueJobSummary,
    ) => Promise<string>;

    expect(await startAccepted.call(
      manager,
      runtimeJob,
      boundDgxJob(created.id, runtimeJob.dgxJobId as string, "accepted"),
    )).toBe("started");
    expect(transitions).toEqual(["starting"]);
    expect(manager.get(created.id)?.logs).toEqual(expect.arrayContaining([
      expect.stringContaining("Start-Fence wird jetzt autoritativ beim Orchestrator geprüft"),
      expect.stringContaining("40.00 GiB RAM"),
      expect.stringContaining("0.25 GiB Swap"),
    ]));
  });

  it("starts a cooperative LTX allocation only after explicit true/true waiter confirmation", async () => {
    const dgxJobId = testDgxJobId("cooperative-true-true");
    let studioJobId = "";
    let remoteState: QueueJobState = "accepted";
    const transitions: QueueTransitionState[] = [];
    const submit = vi.fn(async (admissionRequest: AdmissionRequest) =>
      boundDgxSubmit(studioJobId, dgxJobId, "accepted", admissionRequest));
    const read = vi.fn(async (jobId: string) =>
      boundDgxRead(studioJobId, jobId, remoteState));
    const transition = vi.fn(async (jobId: string, state: QueueTransitionState) => {
      transitions.push(state);
      remoteState = applyStateSensitiveDgxTransition(remoteState, state);
      return boundDgxTransition(studioJobId, jobId, remoteState);
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      { read, transition },
      null,
      { submit },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;

    await expect(waitForDgxQueueStart.call(manager, active)).resolves.toBe(true);

    expect(submit).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(transitions).toEqual(["starting"]);
    expect(active).not.toHaveProperty("process");
    expect(manager.get(created.id)).toMatchObject({ status: "queued", dgxJobId });
  });

  it.each([
    ["accepted", "missing"],
    ["accepted", "mismatched"],
    ["queued", "missing"],
    ["queued", "mismatched"],
  ] as const)(
    "fails closed and cancels a cooperative %s record with %s waiter markers",
    async (initialState, contractShape) => {
      const dgxJobId = testDgxJobId(`cooperative-${initialState}-${contractShape}`);
      let studioJobId = "";
      let remoteState: QueueJobState = initialState;
      const transitions: QueueTransitionState[] = [];
      const submit = vi.fn(async (admissionRequest: AdmissionRequest) => {
        const response = boundDgxSubmit(
          studioJobId,
          dgxJobId,
          initialState,
          admissionRequest,
        );
        if (contractShape === "missing") {
          delete response.job.durable_waiter;
          delete response.job.segment_waiter;
        } else {
          response.job.durable_waiter = true;
          response.job.segment_waiter = false;
        }
        return response;
      });
      const applyContractShape = (remote: QueueJobSummary): void => {
        if (contractShape === "missing") {
          delete remote.durable_waiter;
          delete remote.segment_waiter;
        } else {
          remote.durable_waiter = true;
          remote.segment_waiter = false;
        }
      };
      const read = vi.fn(async (jobId: string) => {
        const response = boundDgxRead(studioJobId, jobId, remoteState);
        applyContractShape(response.job);
        return response;
      });
      const transition = vi.fn(async (jobId: string, state: QueueTransitionState) => {
        transitions.push(state);
        remoteState = applyStateSensitiveDgxTransition(remoteState, state);
        const response = boundDgxTransition(studioJobId, jobId, remoteState);
        applyContractShape(response.job);
        return response;
      });
      const manager = new JobManager(
        await statePath(),
        false,
        null,
        undefined,
        { read, transition },
        null,
        { submit },
      );
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
      const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
        job: unknown,
      ) => Promise<boolean>;

      await expect(waitForDgxQueueStart.call(manager, active)).resolves.toBe(false);

      expect(submit).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
      expect(transitions).toEqual(["cancelled"]);
      expect(active).not.toHaveProperty("process");
      expect(active).not.toHaveProperty("localProcessSpawnPending");
      expect(active).not.toHaveProperty("localProcessGroupPending");
      expect(active).toMatchObject({
        status: "failed",
        dgxJobId,
        dgxJobTerminal: true,
        dgxTerminalReceipt: {
          remoteTerminalState: "cancelled",
        },
      });
      expect(manager.get(created.id)?.error).toContain(
        "durable_waiter=true und segment_waiter=true",
      );
      expect(manager.get(created.id)?.logs.join("\n")).toContain(
        "Lokale GPU-Allokation bleibt fail-closed gesperrt",
      );
    },
  );

  it("cancels an accepted record whose true/true contract drifts at the last prestart GET", async () => {
    const dgxJobId = testDgxJobId("cooperative-start-fence-drift");
    let studioJobId = "";
    let remoteState: QueueJobState = "accepted";
    const transitions: QueueTransitionState[] = [];
    const submit = vi.fn(async (admissionRequest: AdmissionRequest) =>
      boundDgxSubmit(studioJobId, dgxJobId, "accepted", admissionRequest));
    const read = vi.fn(async (jobId: string) => {
      const response = boundDgxRead(studioJobId, jobId, remoteState);
      delete response.job.durable_waiter;
      delete response.job.segment_waiter;
      return response;
    });
    const transition = vi.fn(async (jobId: string, state: QueueTransitionState) => {
      transitions.push(state);
      remoteState = applyStateSensitiveDgxTransition(remoteState, state);
      return boundDgxTransition(studioJobId, jobId, remoteState);
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      { read, transition },
      null,
      { submit },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;

    await expect(waitForDgxQueueStart.call(manager, active)).resolves.toBe(false);

    expect(submit).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(transitions).toEqual(["cancelled"]);
    expect(active).not.toHaveProperty("process");
    expect(active).toMatchObject({
      status: "failed",
      dgxJobTerminal: true,
      dgxTerminalReceipt: { remoteTerminalState: "cancelled" },
    });
    expect(manager.get(created.id)?.error).toContain("im letzten starting-GET");
  });

  it("fails a starting record whose positive PATCH response loses the cooperative contract", async () => {
    const dgxJobId = testDgxJobId("cooperative-starting-patch-drift");
    let studioJobId = "";
    let remoteState: QueueJobState = "accepted";
    const transitions: QueueTransitionState[] = [];
    const submit = vi.fn(async (admissionRequest: AdmissionRequest) =>
      boundDgxSubmit(studioJobId, dgxJobId, "accepted", admissionRequest));
    const read = vi.fn(async (jobId: string) => {
      const response = boundDgxRead(studioJobId, jobId, remoteState);
      if (remoteState === "starting") {
        delete response.job.durable_waiter;
        delete response.job.segment_waiter;
      }
      return response;
    });
    const transition = vi.fn(async (jobId: string, state: QueueTransitionState) => {
      transitions.push(state);
      remoteState = applyStateSensitiveDgxTransition(remoteState, state);
      const response = boundDgxTransition(studioJobId, jobId, remoteState);
      if (remoteState === "starting") {
        delete response.job.durable_waiter;
        delete response.job.segment_waiter;
      }
      return response;
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      { read, transition },
      null,
      { submit },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;

    await expect(waitForDgxQueueStart.call(manager, active)).resolves.toBe(false);

    expect(transitions).toEqual(["starting", "failed"]);
    expect(active).not.toHaveProperty("process");
    expect(active).not.toHaveProperty("localProcessSpawnPending");
    expect(active).toMatchObject({
      status: "failed",
      dgxJobTerminal: true,
      dgxTerminalReceipt: { remoteTerminalState: "failed" },
    });
    expect(manager.get(created.id)?.error).toContain("positiven starting-PATCH-Antwort");
  });

  it("fails a resuming record whose positive PATCH response loses the cooperative contract", async () => {
    const dgxJobId = testDgxJobId("cooperative-resuming-patch-drift");
    let studioJobId = "";
    let remoteState: QueueJobState = "running";
    const transitions: QueueTransitionState[] = [];
    const read = vi.fn(async (jobId: string) => {
      const response = boundDgxRead(studioJobId, jobId, remoteState);
      if (remoteState === "resuming") {
        delete response.job.durable_waiter;
        delete response.job.segment_waiter;
      }
      return response;
    });
    const transition = vi.fn(async (jobId: string, state: QueueTransitionState) => {
      transitions.push(state);
      remoteState = applyStateSensitiveDgxTransition(remoteState, state);
      const response = boundDgxTransition(studioJobId, jobId, remoteState);
      if (remoteState === "resuming") {
        delete response.job.durable_waiter;
        delete response.job.segment_waiter;
      }
      return response;
    });
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read,
      transition,
    });
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.status = "running";
    bindTestDgxLease(
      active,
      created.id,
      dgxJobId,
      active.request as ReturnType<typeof validRequest>,
    );
    Reflect.set(manager, "waitForSchedulerResume", async () => true);
    const pauseAndResume = Reflect.get(manager, "pauseAndResumeDgxSlice") as (
      job: unknown,
      artifact: { type: string; path: string },
    ) => Promise<boolean>;

    await expect(pauseAndResume.call(manager, active, {
      type: "ltx-cooperative-checkpoint",
      path: "/checkpoints/job/manifest.json",
    })).resolves.toBe(false);

    expect(transitions).toEqual(["pausing", "paused", "resuming", "failed"]);
    expect(active).not.toHaveProperty("process");
    expect(active).not.toHaveProperty("localProcessSpawnPending");
    expect(active).toMatchObject({
      status: "failed",
      dgxJobTerminal: true,
      dgxTerminalReceipt: { remoteTerminalState: "failed" },
    });
    expect(manager.get(created.id)?.error).toContain("positiven resuming-PATCH-Antwort");
  });

  it("wakes a DGX retry delay immediately on HOLD without another GET or persistence mutation", async () => {
    const dgxJobId = testDgxJobId("hold-retry-delay");
    let studioJobId = "";
    const read = vi.fn(async (jobId: string) => boundDgxRead(studioJobId, jobId, "queued"));
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read,
      transition: async (jobId, state) => boundDgxTransition(studioJobId, jobId, state),
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "running";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const originalChanged = (Reflect.get(manager, "changed") as () => void).bind(manager);
    const changed = vi.fn(() => originalChanged());
    Reflect.set(manager, "changed", changed);
    const waiting = (Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>).call(manager, active, 30_000);
    for (let attempt = 0; attempt < 20 && changed.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    expect(changed).toHaveBeenCalledTimes(1);

    (Reflect.get(manager, "enterPersistenceHold") as (
      error: unknown,
      details: string,
    ) => JobPersistenceHoldError).call(manager, new Error("synthetic retry HOLD"), "retry-delay test");
    await expect(waiting).resolves.toBe("stopped");

    expect(read).not.toHaveBeenCalled();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(active.dgxSubmitPending).toBeUndefined();
    expect(active.dgxAdmissionAbortController).toBeUndefined();
  });

  it("does not create a DGX lease after cancellation while waiting for pre-admission resources", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 80,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 8,
      swapTotalGiB: 16,
      outputFreeGiB: 0.25,
    }));
    Reflect.set(manager, "waitForDelay", async () => {
      manager.cancel(created.id);
      return false;
    });

    const waitForPreAdmission = Reflect.get(manager, "waitForLocalPreAdmissionResources") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await waitForPreAdmission.call(manager, runtimeJob)).toBe(false);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      dgxJobId: null,
    });
  });

  it("adopts and cancels a remote lease created while queue submit was in flight", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("submit-cancel-race");
    let studioJobId = "";
    let submitStartedResolve!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      submitStartedResolve = resolve;
    });
    let releaseSubmitResolve!: () => void;
    const releaseSubmit = new Promise<void>((resolve) => {
      releaseSubmitResolve = resolve;
    });
    const transitions: string[] = [];
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "accepted"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null, {
      submit: async (admissionRequest) => {
        submitStartedResolve();
        await releaseSubmit;
        const response = boundDgxSubmit(studioJobId, dgxJobId, "accepted", admissionRequest);
        response.job.blocker = {
          kind: "memory",
          available_gib: 43.32,
          pending_reservations_gib: 0,
          required_available_gib: 94,
          current_shortfall_gib: 50.68,
        };
        return response;
      },
    });
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;

    const waiting = waitForDgxQueueStart.call(manager, runtimeJob);
    await submitStarted;
    expect(manager.cancel(created.id)?.status).toBe("cancelled");
    expect(manager.experimentRetryAuthority(created.id)).toMatchObject({
      status: "cancelled",
      settlementPending: true,
    });
    releaseSubmitResolve();

    expect(await waiting).toBe(false);
    expect(transitions).toEqual(["cancelled"]);
    expect(manager.experimentRetryAuthority(created.id)).toMatchObject({
      status: "cancelled",
      settlementPending: false,
    });
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      dgxJobId,
      dgxMemoryWait: null,
      outputUrl: null,
    });
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]?.dgxMemoryWait).toBeNull();
  });

  it("keeps terminal delivery fenced when HOLD wins a deferred cancellation GET", async () => {
    const dgxJobId = testDgxJobId("deferred-terminal-get");
    let studioJobId = "";
    let readStartedResolve!: () => void;
    const readStarted = new Promise<void>((resolvePromise) => {
      readStartedResolve = resolvePromise;
    });
    let releaseReadResolve!: () => void;
    const releaseRead = new Promise<void>((resolvePromise) => {
      releaseReadResolve = resolvePromise;
    });
    const transitions: string[] = [];
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => {
        readStartedResolve();
        await releaseRead;
        return boundDgxRead(studioJobId, jobId, "running");
      },
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(
      active,
      created.id,
      dgxJobId,
      active.request as ReturnType<typeof validRequest>,
    );
    (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(manager, active, "cancelled", { current_step: "deferred terminal GET" });
    (Reflect.get(manager, "changed") as () => void).call(manager);
    const delivery = (Reflect.get(manager, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>).call(manager, active);
    await readStarted;
    Reflect.set(
      manager,
      "persistenceHold",
      new JobPersistenceHoldError("synthetic terminal GET HOLD", new Error("synthetic")),
    );

    releaseReadResolve();
    await expect(delivery).resolves.toBe(false);

    expect(transitions).toEqual([]);
    expect(active).toMatchObject({
      dgxJobId,
      dgxTerminalDelivery: { state: "cancelled" },
    });
    expect(manager.get(created.id)?.cancellationState).toBe("settling");
  });

  it("restores a cancelled late-submit race from one atomic pending snapshot and cancels the lease once", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("atomic-late-submit");
    let studioJobId = "";
    let submitStartedResolve!: () => void;
    const submitStarted = new Promise<void>((resolvePromise) => {
      submitStartedResolve = resolvePromise;
    });
    let releaseSubmitResolve!: () => void;
    const releaseSubmit = new Promise<void>((resolvePromise) => {
      releaseSubmitResolve = resolvePromise;
    });
    const first = new JobManager(path, false, null, undefined, undefined, null, {
      submit: async (admissionRequest) => {
        submitStartedResolve();
        await releaseSubmit;
        return boundDgxSubmit(studioJobId, dgxJobId, "accepted", admissionRequest);
      },
    });
    const created = first.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(first, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    Reflect.set(first, "waitForLocalPreAdmissionResources", async () => true);
    const waiting = (Reflect.get(first, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>).call(first, active);
    await submitStarted;
    active.dgxSubmitStartedAt = "2026-08-25T00:00:00.000Z";
    expect(first.cancel(created.id)).toMatchObject({ status: "cancelled" });
    // Simulate the old process disappearing immediately after the first
    // cancelled snapshot; this also prevents its live retry timer from racing
    // the restart fixture below.
    Reflect.set(first, "shuttingDown", true);
    const originalPersist = (Reflect.get(first, "persist") as () => void).bind(first);
    let failedAtomicContinuation = false;
    Reflect.set(first, "persist", () => {
      if (!failedAtomicContinuation
        && active.dgxJobId === dgxJobId
        && active.dgxTerminalDelivery) {
        failedAtomicContinuation = true;
        throw new Error("synthetic atomic late-submit continuation failure");
      }
      originalPersist();
    });
    releaseSubmitResolve();
    await expect(waiting).rejects.toThrow("synthetic atomic late-submit continuation failure");

    const crashSnapshot = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(crashSnapshot[0]).toMatchObject({
      status: "cancelled",
      dgxSubmitPending: true,
    });
    expect(crashSnapshot[0]?.dgxJobId).toBeNull();
    expect(crashSnapshot[0]).not.toHaveProperty("dgxTerminalDelivery");

    const transitions: string[] = [];
    const list = vi.fn(async () => authoritativeQueueList([
      queueListJobHint(created.id, dgxJobId, "accepted"),
    ]));
    const restored = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(created.id, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(created.id, jobId, state);
      },
    }, null, {
      submit: async () => {
        throw new Error("restored reconciliation must not submit a second lease");
      },
      list,
    });
    for (let attempt = 0; attempt < 200
      && restored.get(created.id)?.cancellationState !== "settled"; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    expect(transitions).toEqual(["cancelled"]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(restored.get(created.id)).toMatchObject({
      status: "failed",
      cancelledBy: "studio",
      dgxJobId,
      cancellationState: "settled",
    });
  });

  it("enters startup HOLD for a cancelled DGX lease missing its durable terminal delivery", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("missing-terminal-delivery");
    const first = new JobManager(path, false);
    const created = first.create(validRequest());
    const seeded = (Reflect.get(first, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    seeded.status = "cancelled";
    seeded.cancelledBy = "studio";
    seeded.finishedAt = new Date().toISOString();
    bindTestDgxLease(
      seeded,
      created.id,
      dgxJobId,
      seeded.request as ReturnType<typeof validRequest>,
    );
    delete seeded.dgxTerminalDelivery;
    (Reflect.get(first, "changed") as () => void).call(first);
    const read = vi.fn(async (jobId: string) => boundDgxRead(created.id, jobId, "running"));
    const transition = vi.fn(async (jobId: string, state: QueueTransitionState) =>
      boundDgxTransition(created.id, jobId, state));
    const restored = new JobManager(path, false, null, undefined, {
      read,
      transition,
    }, 1);

    expect(restored.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(restored.get(created.id)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    const unchanged = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(unchanged[0]).toMatchObject({
      status: "cancelled",
      dgxJobId,
      dgxLeaseReceipt: {
        schemaVersion: "ltx-studio-dgx-lease-receipt.v1",
        studioJobId: created.id,
        dgxJobId,
      },
    });
    expect(unchanged[0]).not.toHaveProperty("dgxTerminalDelivery");
    expect(unchanged[0]).not.toHaveProperty("dgxTerminalReceipt");
  });

  it("does not clear terminal authority when a deferred PATCH response returns after HOLD", async () => {
    const dgxJobId = testDgxJobId("deferred-terminal-patch");
    let studioJobId = "";
    let transitionStartedResolve!: () => void;
    const transitionStarted = new Promise<void>((resolvePromise) => {
      transitionStartedResolve = resolvePromise;
    });
    let releaseTransitionResolve!: () => void;
    const releaseTransition = new Promise<void>((resolvePromise) => {
      releaseTransitionResolve = resolvePromise;
    });
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (jobId, state) => {
        transitionStartedResolve();
        await releaseTransition;
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(manager, active, "cancelled", { current_step: "deferred terminal PATCH" });
    (Reflect.get(manager, "changed") as () => void).call(manager);
    const delivery = (Reflect.get(manager, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>).call(manager, active);
    await transitionStarted;
    Reflect.set(
      manager,
      "persistenceHold",
      new JobPersistenceHoldError("synthetic terminal PATCH HOLD", new Error("synthetic")),
    );

    releaseTransitionResolve();
    await expect(delivery).resolves.toBe(false);

    expect(active).toMatchObject({
      dgxJobId,
      dgxTerminalDelivery: { state: "cancelled" },
    });
    expect(manager.get(created.id)?.cancellationState).toBe("settling");
  });

  it("aborts a hanging DGX submit after durable cancellation and keeps one pending intent", async () => {
    let submitStartedResolve!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      submitStartedResolve = resolve;
    });
    const captured: { signal?: AbortSignal } = {};
    const submit = vi.fn(async (
      _request: unknown,
      signal?: AbortSignal,
    ) => {
      if (!signal) throw new Error("AbortSignal fehlt im DGX-Submit-Test.");
      captured.signal = signal;
      submitStartedResolve();
      return await new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("submit aborted by Studio")), {
          once: true,
        });
      });
    });
    const list = vi.fn(async () => authoritativeQueueList());
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, undefined, null, { submit, list });
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;

    const waiting = waitForDgxQueueStart.call(manager, runtimeJob);
    await submitStarted;
    // Make the no-match proof immediately conclusive instead of waiting out
    // the production visibility window.
    runtimeJob.dgxSubmitStartedAt = "2026-08-26T00:00:00.000Z";

    const queueBefore = [...Reflect.get(manager, "queue") as string[]];
    const publicBefore = structuredClone(manager.get(created.id));
    const logsBefore = [...runtimeJob.logs as string[]];
    let abortEvents = 0;
    captured.signal?.addEventListener("abort", () => { abortEvents += 1; });
    const originalPersist = (Reflect.get(manager, "persist") as () => void).bind(manager);
    let failPersistOnce = true;
    Reflect.set(manager, "persist", () => {
      if (failPersistOnce) {
        failPersistOnce = false;
        throw new Error("synthetic cancellation persistence failure");
      }
      originalPersist();
    });

    expect(() => manager.cancel(created.id)).toThrow("synthetic cancellation persistence failure");
    expect(captured.signal?.aborted).toBe(false);
    expect(abortEvents).toBe(0);
    expect(Reflect.get(manager, "queue")).toEqual(queueBefore);
    expect(manager.get(created.id)).toEqual(publicBefore);
    expect(runtimeJob.logs).toEqual(logsBefore);
    expect(runtimeJob.dgxTerminalDelivery).toBeUndefined();

    const cancellationStates: string[] = [];
    manager.on("changed", (jobs: StudioJob[]) => {
      const state = jobs.find((job) => job.id === created.id)?.cancellationState;
      if (state) cancellationStates.push(state);
    });

    expect(manager.cancel(created.id)).toMatchObject({
      status: "cancelled",
      cancellationState: "settling",
    });
    expect(captured.signal?.aborted).toBe(true);
    expect(abortEvents).toBe(1);
    expect(await waiting).toBe(false);

    for (let attempt = 0; attempt < 100 && list.mock.calls.length === 0; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    expect(submit).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalled();
    expect(manager.experimentRetryAuthority(created.id)).toMatchObject({
      status: "cancelled",
      settlementPending: true,
    });
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      dgxJobId: null,
      cancellationState: "settling",
    });
    expect(cancellationStates[0]).toBe("settling");
    expect(cancellationStates.at(-1)).toBe("settling");
  });

  it("does not roll back a durably persisted cancellation when a changed listener throws", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    manager.on("changed", () => {
      throw new Error("synthetic observer failure after persistence");
    });

    expect(() => manager.cancel(created.id)).not.toThrow();

    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      cancellationState: "settled",
    });
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]).toMatchObject({ status: "cancelled", cancelledBy: "studio" });
    expect(Reflect.get(manager, "queue")).not.toContain(created.id);
  });

  it.each([
    "temporary-open",
    "temporary-write",
    "temporary-fsync",
    "temporary-close",
    "target-rename",
  ] as const)("rolls back a proven pre-rename %s failure and cancels exactly on retry", async (phase) => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const base = Reflect.get(manager, "jobPersistenceFileOperations") as Record<string, (...args: never[]) => unknown>;
    let armed = true;
    const operations = { ...base } as Record<string, (...args: never[]) => unknown>;
    if (phase === "temporary-open") {
      operations.open = ((...args: unknown[]) => {
        if (armed && args[1] === "wx") {
          armed = false;
          throw new Error(`synthetic ${phase}`);
        }
        return base.open(...args as never[]);
      }) as typeof operations.open;
    } else if (phase === "temporary-write") {
      operations.write = ((...args: unknown[]) => {
        if (armed) {
          armed = false;
          throw new Error(`synthetic ${phase}`);
        }
        return base.write(...args as never[]);
      }) as typeof operations.write;
    } else if (phase === "temporary-fsync") {
      operations.fsync = ((...args: unknown[]) => {
        if (armed) {
          armed = false;
          throw new Error(`synthetic ${phase}`);
        }
        return base.fsync(...args as never[]);
      }) as typeof operations.fsync;
    } else if (phase === "temporary-close") {
      operations.close = ((...args: unknown[]) => {
        if (armed) {
          armed = false;
          throw new Error(`synthetic ${phase}`);
        }
        return base.close(...args as never[]);
      }) as typeof operations.close;
    } else {
      operations.rename = ((..._args: unknown[]) => {
        if (armed) {
          armed = false;
          throw new Error(`synthetic ${phase}`);
        }
        return base.rename(..._args as never[]);
      }) as typeof operations.rename;
    }
    Reflect.set(manager, "jobPersistenceFileOperations", operations);

    expect(() => manager.cancel(created.id)).toThrow(`synthetic ${phase}`);
    expect(manager.get(created.id)).toMatchObject({ status: "queued", cancelledBy: null });
    expect(Reflect.get(manager, "queue")).toContain(created.id);
    expect(manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });

    expect(manager.cancel(created.id)).toMatchObject({
      status: "cancelled",
      cancellationState: "settled",
    });
    const stored = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(stored[0]).toMatchObject({ status: "cancelled", cancelledBy: "studio" });
  });

  it.each([
    "target-rename-after-effect",
    "directory-open",
    "directory-fsync",
    "directory-close",
  ] as const)("recovers a post-rename %s failure by read-back and a fresh directory fsync", async (phase) => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const base = Reflect.get(manager, "jobPersistenceFileOperations") as Record<string, (...args: never[]) => unknown>;
    const operations = { ...base } as Record<string, (...args: never[]) => unknown>;
    let armed = true;
    let fsyncCalls = 0;
    let closeCalls = 0;
    if (phase === "target-rename-after-effect") {
      operations.rename = ((...args: unknown[]) => {
        const result = base.rename(...args as never[]);
        if (armed) {
          armed = false;
          throw new Error(`synthetic ${phase}`);
        }
        return result;
      }) as typeof operations.rename;
    } else if (phase === "directory-open") {
      operations.open = ((...args: unknown[]) => {
        if (armed && args[1] === "r") {
          armed = false;
          throw new Error(`synthetic ${phase}`);
        }
        return base.open(...args as never[]);
      }) as typeof operations.open;
    } else if (phase === "directory-fsync") {
      operations.fsync = ((...args: unknown[]) => {
        fsyncCalls += 1;
        if (fsyncCalls === 2) throw new Error(`synthetic ${phase}`);
        return base.fsync(...args as never[]);
      }) as typeof operations.fsync;
    } else {
      operations.close = ((...args: unknown[]) => {
        closeCalls += 1;
        if (closeCalls === 2) throw new Error(`synthetic ${phase}`);
        return base.close(...args as never[]);
      }) as typeof operations.close;
    }
    Reflect.set(manager, "jobPersistenceFileOperations", operations);

    expect(() => manager.cancel(created.id)).not.toThrow();
    expect(manager.get(created.id)).toMatchObject({ status: "cancelled", cancelledBy: "studio" });
    expect(manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    const stored = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(stored[0]).toMatchObject({ status: "cancelled", cancelledBy: "studio" });
  });

  it("enters sticky HOLD without rollback when intended bytes cannot receive directory durability", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const base = Reflect.get(manager, "jobPersistenceFileOperations") as Record<string, (...args: never[]) => unknown>;
    let fsyncCalls = 0;
    Reflect.set(manager, "jobPersistenceFileOperations", {
      ...base,
      fsync: (...args: never[]) => {
        fsyncCalls += 1;
        if (fsyncCalls >= 2) throw new Error("synthetic permanent directory fsync failure");
        return base.fsync(...args);
      },
    });

    expect(() => manager.cancel(created.id)).toThrow(JobPersistenceHoldError);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      cancelledBy: "studio",
      cancellationState: "settling",
    });
    expect(manager.cancel(created.id)).toMatchObject({ cancellationState: "settling" });
    expect(Reflect.get(manager, "queue")).not.toContain(created.id);
    expect(manager.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(() => manager.create(validRequest())).toThrow(JobPersistenceHoldError);
    const stored = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(stored[0]).toMatchObject({ status: "cancelled", cancelledBy: "studio" });
    const restored = new JobManager(path, false);
    expect(restored.get(created.id)).toMatchObject({ cancellationState: "settled" });
  });

  it("emits exactly one live settling snapshot when a post-rename cancel enters HOLD", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const snapshots: StudioJob[][] = [];
    manager.on("changed", (jobs) => snapshots.push(jobs));
    const base = Reflect.get(manager, "jobPersistenceFileOperations") as Record<string, (...args: never[]) => unknown>;
    let fsyncCalls = 0;
    Reflect.set(manager, "jobPersistenceFileOperations", {
      ...base,
      fsync: (...args: never[]) => {
        fsyncCalls += 1;
        if (fsyncCalls >= 2) throw new Error("synthetic live HOLD fsync failure");
        return base.fsync(...args);
      },
    });

    expect(() => manager.cancel(created.id)).toThrow(JobPersistenceHoldError);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.find(({ id }) => id === created.id)).toMatchObject({
      status: "cancelled",
      cancelledBy: "studio",
      cancellationState: "settling",
    });
  });

  it("requires a fresh startup file and directory fsync before trusting intended-visible bytes", async () => {
    const path = await statePath();
    const first = new JobManager(path, false);
    const created = first.create(validRequest());
    const base = Reflect.get(first, "jobPersistenceFileOperations") as Record<string, (...args: never[]) => unknown>;
    let firstFsyncCalls = 0;
    Reflect.set(first, "jobPersistenceFileOperations", {
      ...base,
      fsync: (...args: never[]) => {
        firstFsyncCalls += 1;
        if (firstFsyncCalls >= 2) throw new Error("synthetic unresolved initial directory fsync");
        return base.fsync(...args);
      },
    });
    expect(() => first.cancel(created.id)).toThrow(JobPersistenceHoldError);
    expect(JSON.parse(await readFile(path, "utf8"))[0]).toMatchObject({ status: "cancelled" });

    const transition = vi.fn();
    const submit = vi.fn();
    const startupFailure = new JobManager({
      path,
      fileOperations: {
        ...base,
        fsync: () => {
          throw new Error("synthetic restart fsync failure");
        },
      } as never,
    }, true, null, undefined, { read: vi.fn(), transition }, null, { submit });
    expect(startupFailure.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(startupFailure.list()).toEqual([]);
    expect(transition).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();

    const provenRestart = new JobManager(path, false);
    expect(provenRestart.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    expect(provenRestart.get(created.id)).toMatchObject({
      status: "cancelled",
      cancellationState: "settled",
    });
  });

  it("safety-stops an active process and pinned paused container in HOLD without releasing DGX", async () => {
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("hold-safety-stop");
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (_jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, _jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const containerName = `ltx-lipforcing-${created.id}`;
    const docker = ownedDockerFixture(containerName, dgxJobId, {
      paused: true,
      failStop: true,
    });
    Reflect.set(manager, "ownedDockerOperations", docker.operations);
    active.status = "running";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const queue = Reflect.get(manager, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    (Reflect.get(manager, "bindOwnedDockerContainer") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.lipForcing,
    ) => void).call(manager, active, containerName, OWNED_DOCKER_THERMAL_WORKLOADS.lipForcing);
    (Reflect.get(manager, "markOwnedDockerStartGateReleased") as (job: unknown) => void)
      .call(manager, active);
    const authority = active.ownedDockerContainer as object;
    (Reflect.get(manager, "inspectOwnedDockerContainer") as (
      job: unknown,
      authority: object,
    ) => unknown).call(manager, active, authority);
    (Reflect.get(manager, "setOwnedDockerContainerState") as (
      job: unknown,
      state: "paused",
    ) => void).call(manager, active, "paused");

    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    if (!child.pid || !child.stdout) throw new Error("HOLD-Safety-Testprozess besitzt keine PID/stdout.");
    const processGroupId = child.pid;
    try {
      await new Promise<void>((resolvePromise) => child.stdout!.once("data", () => resolvePromise()));
      await (Reflect.get(manager, "markProcessStarted") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
      ) => Promise<void>).call(manager, active, child);
      active.status = "paused";

      const hold = (Reflect.get(manager, "enterPersistenceHold") as (
        error: unknown,
        details: string,
      ) => JobPersistenceHoldError).call(manager, new Error("synthetic HOLD"), "safety-stop test");
      expect(hold).toBeInstanceOf(JobPersistenceHoldError);
      await new Promise<void>((resolvePromise) => child.once("close", () => resolvePromise()));
      for (let attempt = 0; attempt < 100 && docker.exists(); attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      await (Reflect.get(manager, "reconcileLocalProcessGroup") as (
        job: unknown,
      ) => Promise<void>).call(manager, active);
      await (Reflect.get(manager, "confirmProcessGroupGone") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
      ) => Promise<void>).call(manager, active, child);

      expect(docker.mutationCommands().map((args) => args.slice(0, 2).join(" "))).toEqual([
        `unpause ${"d".repeat(64)}`,
        "stop --time",
        "rm -f",
      ]);
      expect(docker.exists()).toBe(false);
      expect(transitions).toEqual([]);
      expect(active).toMatchObject({
        process: child,
        localProcessGroupPending: true,
        ownedDockerContainer: { containerId: "d".repeat(64) },
      });
      expect(manager.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    } finally {
      try { process.kill(-processGroupId, "SIGKILL"); } catch { /* already stopped */ }
    }
  }, 10_000);

  it("safety-stops an orphaned descendant group in HOLD after its bound leader exits", async () => {
    const transitions: string[] = [];
    const path = await statePath();
    const root = join(path, "..");
    const readyPath = join(root, "orphan-group.ready");
    const exitPath = join(root, "orphan-group.exit");
    const dgxJobId = testDgxJobId("hold-orphan-group");
    let studioJobId = "";
    const manager = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "running";
    active.startedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const queue = Reflect.get(manager, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);

    const leader = spawn("/usr/bin/python3", ["-c", [
      "import pathlib,subprocess,sys,time",
      `ready=pathlib.Path(${JSON.stringify(readyPath)})`,
      `exit_marker=pathlib.Path(${JSON.stringify(exitPath)})`,
      "subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)",
      "ready.write_text('ready')",
      "while not exit_marker.exists(): time.sleep(0.01)",
    ].join("\n")], { detached: true, stdio: "ignore" });
    if (!leader.pid) throw new Error("Orphan-Gruppen-Test besitzt keine Leader-PID.");
    const processGroupId = leader.pid;
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
          await readFile(readyPath);
          break;
        } catch {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
      }
      await (Reflect.get(manager, "markProcessStarted") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
      ) => Promise<void>).call(manager, active, leader);
      await writeFile(exitPath, "exit");
      await new Promise<void>((resolvePromise) => leader.once("close", () => resolvePromise()));
      expect(leader.exitCode).not.toBeNull();
      expect(() => process.kill(-processGroupId, 0)).not.toThrow();

      active.status = "cancelled";
      active.cancelledBy = "studio";
      active.finishedAt = new Date().toISOString();
      (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
        job: unknown,
        state: "cancelled",
        metadata: Record<string, string>,
      ) => void).call(manager, active, "cancelled", { current_step: "orphan HOLD safety" });
      (Reflect.get(manager, "changed") as () => void).call(manager);

      (Reflect.get(manager, "enterPersistenceHold") as (
        error: unknown,
        details: string,
      ) => JobPersistenceHoldError).call(manager, new Error("synthetic orphan HOLD"), "orphan safety test");
      await (Reflect.get(manager, "safetyStopAfterPersistenceHold") as (
        job: unknown,
      ) => Promise<void>).call(manager, active);

      expect(() => process.kill(-processGroupId, 0)).toThrow();
      expect(transitions).toEqual([]);
      expect(active).toMatchObject({
        process: leader,
        localProcessGroupPending: true,
        localProcessGroupIdentity: { processGroupId },
        dgxJobId,
      });
      expect(manager.get(created.id)?.cancellationState).toBe("settling");
      const stored = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
      expect(stored[0]).toMatchObject({
        localProcessGroupPending: true,
        localProcessGroupIdentity: { processGroupId },
        dgxJobId,
      });
    } finally {
      try { process.kill(-processGroupId, "SIGKILL"); } catch { /* already stopped */ }
    }
  }, 20_000);

  it("unconditionally stops a spawned process group when every PG-bind write fails pre-rename", async () => {
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("pg-bind-write-failure");
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: vi.fn(),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "running";
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    const child = spawn("/usr/bin/python3", ["-c", [
      "import subprocess,sys,time",
      "subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)",
      "time.sleep(30)",
    ].join("\n")], { detached: true, stdio: "ignore" });
    if (!child.pid) throw new Error("PG-Bindefehler-Test besitzt keine PID.");
    const processGroupId = child.pid;
    Reflect.set(manager, "persist", () => {
      throw new Error("synthetic permanent pre-rename PG bind failure");
    });
    try {
      await expect((Reflect.get(manager, "markProcessStarted") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
      ) => Promise<void>).call(manager, active, child)).rejects.toThrow("synthetic permanent pre-rename");

      expect(() => process.kill(-processGroupId, 0)).toThrow();
      expect(active.process).toBeUndefined();
      expect(active.localProcessGroupPending).toBeUndefined();
      expect(active.localProcessGroupIdentity).toBeUndefined();
      expect(transitions).toEqual([]);
    } finally {
      try { process.kill(-processGroupId, "SIGKILL"); } catch { /* already stopped */ }
    }
  }, 10_000);

  it("keeps deferred identity capture, provenance capture and file binding out of authority RAM after HOLD", async () => {
    let releaseIdentity!: (value: ReturnType<typeof notApplicableIdentityEvidence>) => void;
    let identityStartedResolve!: () => void;
    const identityStarted = new Promise<void>((resolvePromise) => {
      identityStartedResolve = resolvePromise;
    });
    const identityResult = new Promise<ReturnType<typeof notApplicableIdentityEvidence>>((resolvePromise) => {
      releaseIdentity = resolvePromise;
    });
    const identityManager = new JobManager(await statePath(), false, null, {
      capture: async () => {
        identityStartedResolve();
        return identityResult;
      },
      verify: async (evidence) => ({ evidence, error: null }),
    });
    const identityCreated = identityManager.create(validRequest());
    const identityJob = (Reflect.get(identityManager, "jobs") as Map<string, Record<string, unknown>>)
      .get(identityCreated.id)!;
    const identityLogs = [...identityJob.logs as string[]];
    const identityCapture = (Reflect.get(identityManager, "captureInitialIdentityEvidence") as (
      job: unknown,
    ) => Promise<boolean>).call(identityManager, identityJob);
    await identityStarted;
    Reflect.set(
      identityManager,
      "persistenceHold",
      new JobPersistenceHoldError("identity capture HOLD", new Error("synthetic")),
    );
    releaseIdentity(notApplicableIdentityEvidence());
    await expect(identityCapture).resolves.toBe(false);
    expect(identityJob.identityEvidence).toBeNull();
    expect(identityJob.logs).toEqual(identityLogs);
    expect(identityJob.outputPublication).toBeUndefined();

    let releaseProvenance!: (value: RunProvenance) => void;
    let provenanceStartedResolve!: () => void;
    const provenanceStarted = new Promise<void>((resolvePromise) => {
      provenanceStartedResolve = resolvePromise;
    });
    const provenanceResult = new Promise<RunProvenance>((resolvePromise) => {
      releaseProvenance = resolvePromise;
    });
    const provenanceManager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        capture: async () => {
          provenanceStartedResolve();
          return provenanceResult;
        },
        verify: async (evidence) => ({ evidence, error: null }),
        bindFile: async (evidence) => evidence,
      },
    );
    const provenanceCreated = provenanceManager.create(validRequest());
    const provenanceJob = (Reflect.get(provenanceManager, "jobs") as Map<string, Record<string, unknown>>)
      .get(provenanceCreated.id)!;
    const provenanceLogs = [...provenanceJob.logs as string[]];
    const provenanceCapture = (Reflect.get(provenanceManager, "captureInitialRunProvenance") as (
      job: unknown,
    ) => Promise<boolean>).call(provenanceManager, provenanceJob);
    await provenanceStarted;
    Reflect.set(
      provenanceManager,
      "persistenceHold",
      new JobPersistenceHoldError("provenance capture HOLD", new Error("synthetic")),
    );
    releaseProvenance(runProvenance());
    await expect(provenanceCapture).resolves.toBe(false);
    expect(provenanceJob.runProvenance).toBeNull();
    expect(provenanceJob.logs).toEqual(provenanceLogs);
    expect(provenanceJob.outputPublication).toBeUndefined();

    let releaseBinding!: (value: RunProvenance) => void;
    let bindingStartedResolve!: () => void;
    const bindingStarted = new Promise<void>((resolvePromise) => {
      bindingStartedResolve = resolvePromise;
    });
    const bindingResult = new Promise<RunProvenance>((resolvePromise) => {
      releaseBinding = resolvePromise;
    });
    const bindingManager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        capture: async () => runProvenance(),
        verify: async (evidence) => ({ evidence, error: null }),
        bindFile: async () => {
          bindingStartedResolve();
          return bindingResult;
        },
      },
    );
    const bindingCreated = bindingManager.create(validRequest());
    const bindingJob = (Reflect.get(bindingManager, "jobs") as Map<string, Record<string, unknown>>)
      .get(bindingCreated.id)!;
    const originalProvenance = runProvenance();
    bindingJob.runProvenance = originalProvenance;
    const binding = (Reflect.get(bindingManager, "bindJobRunProvenanceFile") as (
      job: unknown,
      path: string,
      role: string,
    ) => Promise<boolean>).call(bindingManager, bindingJob, "/private/deferred", "input:test");
    await bindingStarted;
    Reflect.set(
      bindingManager,
      "persistenceHold",
      new JobPersistenceHoldError("provenance binding HOLD", new Error("synthetic")),
    );
    releaseBinding({ ...runProvenance(), fingerprint: "f".repeat(64) });
    await expect(binding).resolves.toBe(false);
    expect(bindingJob.runProvenance).toBe(originalProvenance);
    expect(bindingJob.outputPublication).toBeUndefined();
  });

  it("retries a proven pre-rename process-marker clear and delivers one DGX cancellation", async () => {
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("process-clear-retry");
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (_jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, _jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM',()=>process.exit(0));process.stdout.write('ready\\n');setInterval(()=>{},1000)",
    ], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    if (!child.pid || !child.stdout) throw new Error("Settlement-Testprozess besitzt keine PID/stdout.");
    const processGroupId = child.pid;
    try {
      await new Promise<void>((resolvePromise) => child.stdout!.once("data", () => resolvePromise()));
      active.status = "cancelled";
      active.cancelledBy = "studio";
      active.finishedAt = new Date().toISOString();
      bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
      (Reflect.get(manager, "queue") as string[]).splice(
        (Reflect.get(manager, "queue") as string[]).indexOf(created.id),
        1,
      );
      await (Reflect.get(manager, "markProcessStarted") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
      ) => Promise<void>).call(manager, active, child);
      (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
        job: unknown,
        state: "cancelled",
        metadata: Record<string, string>,
      ) => void).call(manager, active, "cancelled", { current_step: "process clear retry" });
      (Reflect.get(manager, "changed") as () => void).call(manager);
      const originalPersist = (Reflect.get(manager, "persist") as () => void).bind(manager);
      let failClearOnce = true;
      Reflect.set(manager, "persist", () => {
        if (failClearOnce && active.localProcessGroupPending === undefined) {
          failClearOnce = false;
          throw new Error("synthetic pre-rename process marker clear failure");
        }
        originalPersist();
      });

      await (Reflect.get(manager, "stopProcessBeforeTerminalDelivery") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
        wasPaused: boolean,
      ) => Promise<void>).call(manager, active, child, false).catch(() => undefined);
      for (let attempt = 0; attempt < 100
        && manager.get(created.id)?.cancellationState !== "settled"; attempt += 1) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }

      expect(failClearOnce).toBe(false);
      expect(transitions).toEqual(["cancelled"]);
      expect(manager.get(created.id)?.cancellationState).toBe("settled");
      const persisted = JSON.parse(readFileSync(Reflect.get(manager, "storagePath"), "utf8"));
      expect(persisted[0]).not.toHaveProperty("localProcessGroupPending");
    } finally {
      try { process.kill(-processGroupId, "SIGKILL"); } catch { /* already stopped */ }
    }
  }, 10_000);

  it("retries a pre-rename marker-clear failure from the detached PG reconciler without an unhandled rejection", async () => {
    const transitions: string[] = [];
    const path = await statePath();
    const dgxJobId = testDgxJobId("detached-pg-retry");
    let studioJobId = "";
    const manager = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    active.localProcessGroupPending = true;
    active.localProcessGroupIdentity = {
      bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      processGroupId: process.pid,
      // A different leader start tick is an authoritative same-boot PID/PGID
      // reuse proof and therefore avoids signalling this test process.
      leaderStartTicks: "0",
    };
    (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(manager, active, "cancelled", { current_step: "detached PG retry" });
    (Reflect.get(manager, "changed") as () => void).call(manager);
    const originalPersist = (Reflect.get(manager, "persist") as () => void).bind(manager);
    let failClearOnce = true;
    Reflect.set(manager, "persist", () => {
      if (failClearOnce && active.localProcessGroupPending === undefined) {
        failClearOnce = false;
        throw new Error("synthetic detached PG marker pre-rename failure");
      }
      originalPersist();
    });

    (Reflect.get(manager, "scheduleLocalProcessGroupReconciliation") as (
      job: unknown,
      delay: number,
    ) => void).call(manager, active, 0);
    for (let attempt = 0; attempt < 200 && transitions.length === 0; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }

    expect(failClearOnce).toBe(false);
    expect(transitions).toEqual(["cancelled"]);
    expect(active.localProcessGroupPending).toBeUndefined();
    expect(active.localProcessGroupIdentity).toBeUndefined();
    expect(manager.get(created.id)?.cancellationState).toBe("settled");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted[0]).not.toHaveProperty("localProcessGroupPending");
  });

  it("restores and retries an owned marker after one pre-rename final-absence write failure", async () => {
    const transitions: string[] = [];
    const path = await statePath();
    const dgxJobId = testDgxJobId("container-clear-retry");
    let studioJobId = "";
    const manager = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (_jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, _jobId, state);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    const containerName = `ltx-musetalk-${created.id}`;
    const docker = ownedDockerFixture(containerName, dgxJobId);
    Reflect.set(manager, "ownedDockerOperations", docker.operations);
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId, active.request as ReturnType<typeof validRequest>);
    (Reflect.get(manager, "bindOwnedDockerContainer") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.museTalk,
    ) => void).call(manager, active, containerName, OWNED_DOCKER_THERMAL_WORKLOADS.museTalk);
    (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(manager, active, "cancelled", { current_step: "container clear retry" });
    (Reflect.get(manager, "changed") as () => void).call(manager);
    const originalPersist = (Reflect.get(manager, "persist") as () => void).bind(manager);
    let failClearOnce = true;
    Reflect.set(manager, "persist", () => {
      if (failClearOnce && active.ownedDockerContainer === undefined) {
        failClearOnce = false;
        throw new Error("synthetic pre-rename container marker clear failure");
      }
      originalPersist();
    });
    const cleanup = Reflect.get(manager, "cleanupOwnedDockerContainer") as (
      job: unknown,
    ) => Promise<boolean>;
    const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await cleanup.call(manager, active)).toBe(false);
    expect(active.ownedDockerContainer).toBeDefined();
    expect(await cleanup.call(manager, active)).toBe(true);
    expect(await flush.call(manager, active)).toBe(true);
    expect(transitions).toEqual(["cancelled"]);
    expect(manager.get(created.id)?.cancellationState).toBe("settled");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted[0]).not.toHaveProperty("ownedDockerContainer");
  });

  it("emits one final settled snapshot even when its runtime-only clear cannot persist", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    active.dgxTerminalDeliveryInFlight = Promise.resolve(true);
    const states: string[] = [];
    manager.on("changed", (jobs: StudioJob[]) => {
      const state = jobs.find((job) => job.id === created.id)?.cancellationState;
      if (state) states.push(state);
    });
    Reflect.set(manager, "persist", () => {
      throw new Error("synthetic final runtime-only event persistence failure");
    });

    (Reflect.get(manager, "clearCancellationSettlementTransient") as (
      job: unknown,
      clear: () => void,
    ) => void).call(manager, active, () => delete active.dgxTerminalDeliveryInFlight);

    expect(states).toEqual(["settled"]);
    expect(manager.get(created.id)?.cancellationState).toBe("settled");
  });

  it("restores the complete output-authority map after a proven pre-rename revoke failure", async () => {
    const { manager, runtimeJob } = await archivedOutputFixture();
    const archive = Reflect.get(manager, "outputAuthorityArchive") as Map<string, unknown>;
    const before = canonicalJson([...archive.entries()]);
    const base = Reflect.get(manager, "jobPersistenceFileOperations") as Record<string, (...args: never[]) => unknown>;
    let failRenameOnce = true;
    Reflect.set(manager, "jobPersistenceFileOperations", {
      ...base,
      rename: (...args: never[]) => {
        if (failRenameOnce) {
          failRenameOnce = false;
          throw new Error("synthetic archive pre-rename failure");
        }
        return base.rename(...args);
      },
    });

    expect(() => manager.revokeOutputAuthority(
      runtimeJob.outputName as string,
      runtimeJob.id as string,
    )).toThrow("synthetic archive pre-rename failure");
    expect(canonicalJson([...archive.entries()])).toBe(before);
    expect(manager.persistenceHealth()).toMatchObject({ status: "ok" });

    expect(() => manager.revokeOutputAuthority(
      runtimeJob.outputName as string,
      runtimeJob.id as string,
    )).not.toThrow();
    expect(archive.size).toBe(0);
  });

  it("keeps intended archive/revoke RAM and publication bytes fail-closed in post-rename HOLD", async () => {
    const first = await archivedOutputFixture();
    const firstArchive = Reflect.get(first.manager, "outputAuthorityArchive") as Map<string, unknown>;
    const firstBase = Reflect.get(first.manager, "jobPersistenceFileOperations") as Record<string, (...args: never[]) => unknown>;
    let firstFsyncCalls = 0;
    Reflect.set(first.manager, "jobPersistenceFileOperations", {
      ...firstBase,
      fsync: (...args: never[]) => {
        firstFsyncCalls += 1;
        if (firstFsyncCalls >= 2) throw new Error("synthetic revoke directory durability failure");
        return firstBase.fsync(...args);
      },
    });

    expect(() => first.manager.revokeOutputAuthority(
      first.runtimeJob.outputName as string,
      first.runtimeJob.id as string,
    )).toThrow(JobPersistenceHoldError);
    expect(firstArchive.size).toBe(0);
    expect(first.manager.persistenceHealth()).toMatchObject({ status: "hold" });
    expect(() => first.manager.outputAuthorityList()).toThrow(JobPersistenceHoldError);
    await expect(readFile(first.outputPath, "utf8")).resolves.toBe("archive authority output bytes");
    await expect(readFile(first.markerPath, "utf8")).resolves.toContain(first.runtimeJob.id as string);

    const second = await archivedOutputFixture();
    const secondArchive = Reflect.get(second.manager, "outputAuthorityArchive") as Map<string, Record<string, unknown>>;
    const current = structuredClone(secondArchive.get(second.runtimeJob.id as string)!);
    const evictedId = "11111111-1111-4111-8111-111111111111";
    secondArchive.set(evictedId, { ...current, id: evictedId });
    const secondBase = Reflect.get(second.manager, "jobPersistenceFileOperations") as Record<string, (...args: never[]) => unknown>;
    let secondFsyncCalls = 0;
    Reflect.set(second.manager, "jobPersistenceFileOperations", {
      ...secondBase,
      fsync: (...args: never[]) => {
        secondFsyncCalls += 1;
        if (secondFsyncCalls >= 2) throw new Error("synthetic archive directory durability failure");
        return secondBase.fsync(...args);
      },
    });

    expect(() => (Reflect.get(second.manager, "archivePublishedJob") as (
      job: unknown,
    ) => void).call(second.manager, second.runtimeJob)).toThrow(JobPersistenceHoldError);
    expect(secondArchive.has(evictedId)).toBe(false);
    expect(secondArchive.has(second.runtimeJob.id as string)).toBe(true);
    expect(second.manager.persistenceHealth()).toMatchObject({ status: "hold" });
    expect(() => second.manager.outputAuthorityList()).toThrow(JobPersistenceHoldError);
    await expect(readFile(second.outputPath, "utf8")).resolves.toBe("archive authority output bytes");
    await expect(readFile(second.markerPath, "utf8")).resolves.toContain(second.runtimeJob.id as string);
  });

  it("routes all three publication paths through one no-compensation prepared-commit helper", async () => {
    const source = await readFile(
      join(repoRoot, "apps", "ltx-studio", "server", "jobs.ts"),
      "utf8",
    );
    const helperCalls = source.match(/this\.commitPreparedPublication\(/gu) ?? [];
    expect(helperCalls).toHaveLength(3);
    const helperStart = source.indexOf("private commitPreparedPublication(");
    const helperEnd = source.indexOf("private async verifyJobIdentityEvidence", helperStart);
    const helper = source.slice(helperStart, helperEnd);
    expect(helper).toContain("if (isJobPersistenceHoldError(error))");
    expect(helper).toContain("kein Remote-completed wurde vorgemerkt");
    const holdBranch = helper.match(
      /if \(isJobPersistenceHoldError\(error\)\) \{[\s\S]{0,320}?throw error;/u,
    )?.[0];
    expect(holdBranch).toBeDefined();
    expect(holdBranch).not.toMatch(/removeOutputPublicationAuthority|quarantine|failJob|failDgxJob/u);
  });

  it.each([
    ["bound-with-release", {
      state: "bound",
      startGateReleasedAt: "2026-08-26T20:00:00.000Z",
      absenceProofStartedAt: null,
      absenceProofCount: 0,
    }],
    ["running-without-release", {
      state: "running",
      startGateReleasedAt: null,
      absenceProofStartedAt: null,
      absenceProofCount: 0,
    }],
    ["forged-old-proof", {
      state: "cleanup",
      startGateReleasedAt: "2026-08-26T20:00:05.000Z",
      absenceProofStartedAt: "2026-08-26T20:00:00.000Z",
      absenceProofCount: 3,
    }],
    ["oversized-proof-count", {
      state: "cleanup",
      startGateReleasedAt: "2026-08-26T20:00:00.000Z",
      absenceProofStartedAt: "2026-08-26T20:00:01.000Z",
      absenceProofCount: 4,
    }],
  ] as const)("enters startup HOLD for tampered v2 Docker authority %s", async (_case, tamper) => {
    const path = await statePath();
    const first = new JobManager(path, false);
    const created = first.create(validRequest());
    const active = (Reflect.get(first, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(
      active,
      created.id,
      testDgxJobId(`v2-tamper-${_case}`),
      active.request as ReturnType<typeof validRequest>,
    );
    const containerName = `ltx-latentsync-${created.id}`;
    (Reflect.get(first, "bindOwnedDockerContainer") as (
      job: unknown,
      name: string,
      workload: typeof OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
    ) => void).call(first, active, containerName, OWNED_DOCKER_THERMAL_WORKLOADS.latentSync);
    Object.assign(active.ownedDockerContainer as object, tamper);
    (Reflect.get(first, "changed") as () => void).call(first);

    const restored = new JobManager(path, false, null, undefined, undefined, null);
    expect(restored.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(restored.get(created.id)).toBeUndefined();
    expect(() => restored.create(validRequest())).toThrow(JobPersistenceHoldError);
  });

  it("retries a transient queued-job GET failure without failing the Studio job", async () => {
    let reads = 0;
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => {
        reads += 1;
        if (reads === 1) throw new Error("temporary runtime API disconnect");
        return boundDgxRead(studioJobId, jobId, "accepted");
      },
      transition: async () => {
        throw new Error("not expected");
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      testDgxJobId("queued-transient-get"),
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", async () => "started");
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    expect(await waitForQueuedDgxJob.call(manager, runtimeJob, 0)).toBe("started");
    expect(reads).toBe(2);
    expect(manager.get(created.id)).toMatchObject({
      status: "queued",
      error: null,
    });
    expect(manager.get(created.id)?.logs).toEqual(expect.arrayContaining([
      expect.stringContaining("vorübergehend nicht lesbar"),
      expect.stringContaining("temporary runtime API disconnect"),
    ]));
  });

  it("replays only the exact receipt-bound admission and accepts the same lease before reservation activation", async () => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId("receipt-bound-replay");
    let submittedRequest: AdmissionRequest | null = null;
    let submittedExpectedJobId: string | null = null;
    let submittedSignal: AbortSignal | undefined;
    const initialSubmit = vi.fn(async () => {
      throw new Error("initial submit must not run for a bound lease");
    });
    const replay = vi.fn(async (
      admissionRequest: AdmissionRequest,
      expectedDgxJobId: string,
      signal?: AbortSignal,
    ) => {
      submittedRequest = structuredClone(admissionRequest);
      submittedExpectedJobId = expectedDgxJobId;
      submittedSignal = signal;
      const receipt = runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>;
      const response = boundDgxReplay(
        studioJobId,
        dgxJobId,
        "accepted",
        admissionRequest,
        receipt.observedCreatedAt,
      );
      response.job.started_at = "";
      return response;
    });
    const read = vi.fn(async (jobId: string) =>
      boundDgxRead(studioJobId, jobId, "queued"));
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read,
        transition: async () => {
          throw new Error("start transition is stubbed in this replay test");
        },
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const receiptBefore = structuredClone(
      runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>,
    );
    const startAccepted = vi.fn(async (_job: unknown, remote: QueueJobSummary) => {
      expect(remote).toMatchObject({
        job_id: dgxJobId,
        state: "accepted",
        started_at: "",
        reservation_active: false,
      });
      return "started";
    });
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("started");

    expect(read).toHaveBeenCalledOnce();
    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(startAccepted).toHaveBeenCalledOnce();
    expect(submittedExpectedJobId).toBe(dgxJobId);
    expect(submittedSignal).toBeInstanceOf(AbortSignal);
    expect(submittedRequest).not.toBe(receiptBefore.preparedAdmission);
    expect(canonicalJson(submittedRequest)).toBe(canonicalJson(receiptBefore.preparedAdmission));
    expect(createHash("sha256").update(canonicalJson(submittedRequest)).digest("hex"))
      .toBe(receiptBefore.preparedAdmissionSha256);
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
    expect(canonicalJson(runtimeJob.dgxLeaseReceipt)).toBe(canonicalJson(receiptBefore));
    expect(runtimeJob).not.toHaveProperty("dgxPreparedAdmission");
    expect(runtimeJob).not.toHaveProperty("dgxPreparedAdmissionSha256");
  });

  it.each([
    "missing-replay-marker",
    "missing-replay-bound-id",
    "different-admission-job-id",
    "different-job-id",
    "different-created-at",
    "different-caller",
    "accepted-wrong-decision",
    "accepted-missing-reservation",
    "queued-wrong-decision",
    "queued-active-reservation",
    "malformed-started-at",
    "missing-cooperative-capability",
  ] as const)("fails closed without starting for a %s queue replay", async (fault) => {
    let studioJobId = "";
    let remoteState: QueueJobState = "queued";
    const dgxJobId = testDgxJobId(`malformed-replay-${fault}`);
    const otherDgxJobId = testDgxJobId(`malformed-replay-other-${fault}`);
    const transitions: QueueTransitionState[] = [];
    const initialSubmit = vi.fn(async () => {
      throw new Error("initial submit must not run for a bound lease");
    });
    const replay = vi.fn(async (
      admissionRequest: AdmissionRequest,
      expectedDgxJobId: string,
    ) => {
      expect(expectedDgxJobId).toBe(dgxJobId);
      const receipt = runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>;
      const replayState = fault.startsWith("queued-") ? "queued" : "accepted";
      const response = boundDgxReplay(
        studioJobId,
        dgxJobId,
        replayState,
        admissionRequest,
        receipt.observedCreatedAt,
      );
      if (fault === "missing-replay-marker") {
        delete (response.admission as Record<string, unknown>).idempotent_replay;
      }
      if (fault === "missing-replay-bound-id") {
        delete (response.admission as Record<string, unknown>).replay_bound_job_id;
      }
      if (fault === "different-admission-job-id") {
        (response.admission as Record<string, unknown>).job_id = otherDgxJobId;
      }
      if (fault === "different-job-id") response.job.job_id = otherDgxJobId;
      if (fault === "different-created-at") {
        response.job.created_at = new Date(Date.parse(receipt.observedCreatedAt) + 1_000).toISOString();
      }
      if (fault === "different-caller") response.job.requested_by = "ltx-studio:foreign-caller";
      if (fault === "accepted-wrong-decision") response.admission.decision = "queued";
      if (fault === "accepted-missing-reservation") {
        delete response.job.reservation_active;
      }
      if (fault === "queued-wrong-decision") response.admission.decision = "accepted";
      if (fault === "queued-active-reservation") response.job.reservation_active = true;
      if (fault === "malformed-started-at") response.job.started_at = "not-a-timestamp";
      if (fault === "missing-cooperative-capability") response.job.segment_waiter = false;
      return response;
    });
    const read = vi.fn(async (jobId: string) =>
      boundDgxRead(studioJobId, jobId, remoteState));
    const transition = vi.fn(async (jobId: string, state: QueueTransitionState) => {
      transitions.push(state);
      remoteState = applyStateSensitiveDgxTransition(remoteState, state);
      return boundDgxTransition(studioJobId, jobId, remoteState);
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      { read, transition },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const receiptBefore = canonicalJson(runtimeJob.dgxLeaseReceipt);
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("stopped");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(startAccepted).not.toHaveBeenCalled();
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
    expect(runtimeJob).not.toHaveProperty("process");
    expect(runtimeJob).not.toHaveProperty("localProcessSpawnPending");
    if (fault === "missing-cooperative-capability") {
      expect(transitions).toEqual(["cancelled"]);
      expect(runtimeJob).toMatchObject({
        status: "failed",
        dgxJobTerminal: true,
        dgxTerminalReceipt: {
          dgxJobId,
          remoteTerminalState: "cancelled",
        },
      });
      expect(runtimeJob).not.toHaveProperty("dgxLeaseReceipt");
    } else {
      expect(transitions).toEqual([]);
      expect(canonicalJson(runtimeJob.dgxLeaseReceipt)).toBe(receiptBefore);
      expect(manager.persistenceHealth()).toMatchObject({ status: "hold" });
    }
  });

  it("keeps the durable lease and continues GET polling after an ambiguous replay transport failure", async () => {
    let studioJobId = "";
    let reads = 0;
    const dgxJobId = testDgxJobId("ambiguous-replay-transport");
    const initialSubmit = vi.fn(async () => {
      throw new Error("initial submit must not run for a bound lease");
    });
    const replay = vi.fn(async () => {
      throw Object.assign(new Error("socket hang up during exact replay"), { code: "ECONNRESET" });
    });
    const read = vi.fn(async (jobId: string) => {
      reads += 1;
      return boundDgxRead(studioJobId, jobId, reads === 1 ? "queued" : "accepted");
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read,
        transition: async () => {
          throw new Error("start transition is stubbed in this replay test");
        },
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const receiptBefore = canonicalJson(runtimeJob.dgxLeaseReceipt);
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("started");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(startAccepted).toHaveBeenCalledOnce();
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
    expect(canonicalJson(runtimeJob.dgxLeaseReceipt)).toBe(receiptBefore);
    expect(manager.persistenceHealth()).toMatchObject({ status: "ok" });
    expect(manager.get(created.id)?.logs.join("\n")).toContain(
      "die vorhandene Lease bleibt unverändert und wird per GET weiter geprüft",
    );
  });

  it("never falls back to the lease-creating submit endpoint when replay transport is unavailable", async () => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId("missing-replay-transport");
    const initialSubmit = vi.fn(async () => {
      throw new Error("the lease-creating endpoint must never be a replay fallback");
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, "queued"),
        transition: async () => {
          throw new Error("missing replay transport must prevent PATCH");
        },
      },
      null,
      { submit: initialSubmit },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const receiptBefore = canonicalJson(runtimeJob.dgxLeaseReceipt);
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("stopped");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(startAccepted).not.toHaveBeenCalled();
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
    expect(canonicalJson(runtimeJob.dgxLeaseReceipt)).toBe(receiptBefore);
    expect(manager.persistenceHealth()).toMatchObject({ status: "hold" });
  });

  it("reconciles an exact replay target-mismatch race by GET without creating a replacement lease", async () => {
    let studioJobId = "";
    let reads = 0;
    const waits: number[] = [];
    const dgxJobId = testDgxJobId("replay-target-mismatch");
    const initialSubmit = vi.fn(async () => {
      throw new Error("the lease-creating endpoint must never resolve a replay race");
    });
    const replay = vi.fn(async () => {
      throw new RuntimeApiError("replay target moved before conditional POST", 409, {
        schema_version: "dgx-queue-replay-conflict.v0",
        error: "replay_target_mismatch",
        expected_job_id: dgxJobId,
        observed_job_id: null,
        client_action: "poll_expected_job_status",
      });
    });
    const read = vi.fn(async (jobId: string) => {
      reads += 1;
      return boundDgxRead(studioJobId, jobId, reads === 1 ? "queued" : "accepted");
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read,
        transition: async () => {
          throw new Error("start transition is stubbed in this replay-race test");
        },
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const receiptBefore = canonicalJson(runtimeJob.dgxLeaseReceipt);
    Reflect.set(manager, "waitForDelay", async (_job: unknown, delayMs: number) => {
      waits.push(delayMs);
      return true;
    });
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("started");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([0, 1_000]);
    expect(startAccepted).toHaveBeenCalledOnce();
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
    expect(canonicalJson(runtimeJob.dgxLeaseReceipt)).toBe(receiptBefore);
    expect(manager.persistenceHealth()).toMatchObject({ status: "ok" });
    expect(manager.get(created.id)?.logs.join("\n")).toContain(
      "der Replay-only-Vertrag hat keinen Ersatzjob erzeugt",
    );
  });

  it.each([
    ["wrong observed ID", {
      observed_job_id: testDgxJobId("replay-target-mismatch-foreign"),
    }],
    ["wrong schema", {
      schema_version: "dgx-queue-submit.v0",
    }],
  ] as const)("enters HOLD for an unbound replay target-mismatch conflict: %s", async (
    _case,
    override,
  ) => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId(`invalid-replay-target-mismatch-${_case}`);
    const initialSubmit = vi.fn(async () => {
      throw new Error("the lease-creating endpoint must never resolve a replay race");
    });
    const replay = vi.fn(async () => {
      throw new RuntimeApiError("unbound replay target mismatch", 409, {
        schema_version: "dgx-queue-replay-conflict.v0",
        error: "replay_target_mismatch",
        expected_job_id: dgxJobId,
        observed_job_id: null,
        client_action: "poll_expected_job_status",
        ...override,
      });
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, "queued"),
        transition: async () => {
          throw new Error("an unbound replay conflict must prevent PATCH");
        },
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const receiptBefore = canonicalJson(runtimeJob.dgxLeaseReceipt);
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("stopped");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(startAccepted).not.toHaveBeenCalled();
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
    expect(canonicalJson(runtimeJob.dgxLeaseReceipt)).toBe(receiptBefore);
    expect(manager.persistenceHealth()).toMatchObject({ status: "hold" });
  });

  it("settles an exact replay-endpoint HTTP 410 tombstone without entering global HOLD", async () => {
    let studioJobId = "";
    let observedCreatedAt = "";
    let requestSha256 = "";
    const dgxJobId = testDgxJobId("replay-exact-gone");
    const initialSubmit = vi.fn(async () => {
      throw new Error("initial submit must not run for a bound lease");
    });
    const replay = vi.fn(async (admissionRequest: AdmissionRequest) => {
      requestSha256 = exactDgxRequestSha256(admissionRequest);
      throw new RuntimeApiError("job_gone", 410, {
        error: "job_gone",
        job_id: dgxJobId,
        schema_version: "dgx-job-gone.v0",
        terminal: true,
        state: "cancelled",
        reason: "terminal_record_bound_to_key",
        finished_at: observedCreatedAt,
        reaped_at: observedCreatedAt,
        idempotency_key: `ltx-studio:${studioJobId}`,
        request_sha256: requestSha256,
      });
    });
    const transition = vi.fn(async () => {
      throw new Error("an exact 410 tombstone must prevent PATCH");
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, "queued"),
        transition,
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    observedCreatedAt = (
      runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>
    ).observedCreatedAt;
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("stopped");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();
    expect(startAccepted).not.toHaveBeenCalled();
    expect(manager.persistenceHealth()).toMatchObject({ status: "ok" });
    expect(runtimeJob).toMatchObject({
      status: "failed",
      dgxJobId,
      dgxJobTerminal: true,
      dgxTerminalReceipt: {
        dgxJobId,
        localIntentState: "failed",
        remoteTerminalState: "cancelled",
        evidence: {
          kind: "job-gone",
          schemaVersion: "ltx-studio-dgx-job-gone-evidence.v1",
          runtimeSchemaVersion: "dgx-job-gone.v0",
          idempotencyKey: dgxCaller(created.id),
          requestSha256,
        },
      },
    });
    expect(runtimeJob).not.toHaveProperty("dgxLeaseReceipt");
    expect(manager.get(created.id)?.logs.join("\n")).toContain(
      "Queue-Replay bestätigte per 410-Beleg",
    );
  });

  it("persists a retained exact terminal replay as replay-bound evidence without PATCH or HOLD", async () => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId("retained-terminal-replay");
    const path = await statePath();
    const initialSubmit = vi.fn(async () => {
      throw new Error("a retained terminal replay must never use the lease-creating endpoint");
    });
    const replay = vi.fn(async (
      admissionRequest: AdmissionRequest,
      expectedDgxJobId: string,
    ) => {
      expect(expectedDgxJobId).toBe(dgxJobId);
      const receipt = runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>;
      return boundDgxReplay(
        studioJobId,
        dgxJobId,
        "cancelled",
        admissionRequest,
        receipt.observedCreatedAt,
      );
    });
    const transition = vi.fn(async () => {
      throw new Error("a retained terminal replay must never issue a PATCH");
    });
    const manager = new JobManager(
      path,
      false,
      null,
      undefined,
      {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, "queued"),
        transition,
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("stopped");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();
    expect(startAccepted).not.toHaveBeenCalled();
    expect(manager.persistenceHealth()).toMatchObject({ status: "ok" });
    expect(runtimeJob).toMatchObject({
      status: "failed",
      dgxJobId,
      dgxJobTerminal: true,
      dgxTerminalReceipt: {
        dgxJobId,
        localIntentState: "failed",
        remoteTerminalState: "cancelled",
        evidence: {
          kind: "queue-replay",
          schemaVersion: "dgx-queue-submit.v0",
          requestedBy: dgxCaller(created.id),
          sourceApp: "LTX Studio",
          idempotencyKey: dgxCaller(created.id),
          replayBoundJobId: dgxJobId,
          idempotentReplay: true,
        },
      },
    });
    expect(runtimeJob).not.toHaveProperty("dgxLeaseReceipt");

    const restarted = new JobManager(path, false);
    const restored = (Reflect.get(restarted, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    expect(restored.dgxTerminalReceipt).toMatchObject({
      dgxJobId,
      evidence: {
        kind: "queue-replay",
        replayBoundJobId: dgxJobId,
        idempotentReplay: true,
      },
    });
    expect(restored.dgxLeaseReceipt).toBeUndefined();
  });

  it.each([
    "missing-marker",
    "wrong-bound-id",
    "different-created-at",
    "active-reservation",
    "missing-reservation",
  ] as const)("enters HOLD for a malformed retained terminal replay: %s", async (fault) => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId(`malformed-retained-terminal-${fault}`);
    const foreignDgxJobId = testDgxJobId(`malformed-retained-terminal-foreign-${fault}`);
    const initialSubmit = vi.fn(async () => {
      throw new Error("a malformed terminal replay must never use the lease-creating endpoint");
    });
    const replay = vi.fn(async (
      admissionRequest: AdmissionRequest,
      expectedDgxJobId: string,
    ) => {
      expect(expectedDgxJobId).toBe(dgxJobId);
      const receipt = runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>;
      const response = boundDgxReplay(
        studioJobId,
        dgxJobId,
        "cancelled",
        admissionRequest,
        receipt.observedCreatedAt,
      );
      if (fault === "missing-marker") {
        delete (response.admission as Record<string, unknown>).idempotent_replay;
      } else if (fault === "wrong-bound-id") {
        response.admission.replay_bound_job_id = foreignDgxJobId;
      } else if (fault === "different-created-at") {
        response.job.created_at = new Date(
          Date.parse(receipt.observedCreatedAt) + 1_000,
        ).toISOString();
      } else if (fault === "active-reservation") {
        response.job.reservation_active = true;
      } else {
        delete response.job.reservation_active;
      }
      return response;
    });
    const transition = vi.fn(async () => {
      throw new Error("a malformed terminal replay must prevent PATCH");
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, "queued"),
        transition,
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const receiptBefore = canonicalJson(runtimeJob.dgxLeaseReceipt);
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("stopped");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();
    expect(startAccepted).not.toHaveBeenCalled();
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
    expect(canonicalJson(runtimeJob.dgxLeaseReceipt)).toBe(receiptBefore);
    expect(runtimeJob).not.toHaveProperty("dgxTerminalReceipt");
    expect(manager.persistenceHealth()).toMatchObject({ status: "hold" });
  });

  it.each([
    "wrong job",
    "wrong caller",
    "non-terminal",
    "finished before lease creation",
    "reaped before finished",
    "future timestamp",
    "timestamp without offset",
    "missing request digest",
    "uppercase request digest",
    "malformed request digest",
    "wrong-request digest",
  ] as const)("enters HOLD for an unbound replay-endpoint 410 tombstone: %s", async (_case) => {
    let studioJobId = "";
    let observedCreatedAt = "";
    const dgxJobId = testDgxJobId(`replay-invalid-gone-${_case}`);
    const foreignDgxJobId = testDgxJobId("replay-gone-foreign");
    const initialSubmit = vi.fn(async () => {
      throw new Error("initial submit must not run for a bound lease");
    });
    const replay = vi.fn(async (admissionRequest: AdmissionRequest) => {
      const observedCreatedAtMs = Date.parse(observedCreatedAt);
      const requestSha256 = exactDgxRequestSha256(admissionRequest);
      const payload: Record<string, unknown> = {
        error: "job_gone",
        job_id: dgxJobId,
        schema_version: "dgx-job-gone.v0",
        terminal: true,
        state: "cancelled",
        finished_at: observedCreatedAt,
        reaped_at: observedCreatedAt,
        idempotency_key: `ltx-studio:${studioJobId}`,
        request_sha256: requestSha256,
      };
      if (_case === "wrong job") payload.job_id = foreignDgxJobId;
      if (_case === "wrong caller") payload.idempotency_key = "ltx-studio:foreign-caller";
      if (_case === "non-terminal") payload.terminal = false;
      if (_case === "finished before lease creation") {
        payload.finished_at = new Date(observedCreatedAtMs - 1).toISOString();
      }
      if (_case === "reaped before finished") {
        payload.reaped_at = new Date(observedCreatedAtMs - 1).toISOString();
      }
      if (_case === "future timestamp") {
        const future = new Date(Date.now() + 60_000).toISOString();
        payload.finished_at = future;
        payload.reaped_at = future;
      }
      if (_case === "timestamp without offset") {
        payload.finished_at = observedCreatedAt.replace(/Z$/u, "");
        payload.reaped_at = observedCreatedAt.replace(/Z$/u, "");
      }
      if (_case === "missing request digest") delete payload.request_sha256;
      if (_case === "uppercase request digest") {
        payload.request_sha256 = requestSha256.toUpperCase();
      }
      if (_case === "malformed request digest") payload.request_sha256 = "not-a-sha256";
      if (_case === "wrong-request digest") {
        payload.request_sha256 = exactDgxRequestSha256({
          ...admissionRequest,
          estimated_memory_gib: admissionRequest.estimated_memory_gib + 1,
        });
      }
      throw new RuntimeApiError("untrusted job_gone", 410, {
        ...payload,
      });
    });
    const transition = vi.fn(async () => {
      throw new Error("an invalid 410 tombstone must prevent PATCH");
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, "queued"),
        transition,
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    observedCreatedAt = (
      runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>
    ).observedCreatedAt;
    const receiptBefore = canonicalJson(runtimeJob.dgxLeaseReceipt);
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("stopped");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(transition).not.toHaveBeenCalled();
    expect(startAccepted).not.toHaveBeenCalled();
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
    expect(canonicalJson(runtimeJob.dgxLeaseReceipt)).toBe(receiptBefore);
    expect(manager.persistenceHealth()).toMatchObject({ status: "hold" });
  });

  it.each([
    ["short 5-second", 5, [0, 5_000], 2],
    ["long 120-second", 120, [0, 30_000, 30_000, 30_000, 30_000], 5],
  ] as const)("honors a %s replay backoff while GET heartbeats remain at most 30 seconds", async (
    _case,
    retryAfterSeconds,
    expectedWaits,
    expectedReads,
  ) => {
    let studioJobId = "";
    let clock = Date.now();
    const waits: number[] = [];
    const dgxJobId = testDgxJobId("independent-replay-backoff");
    const initialSubmit = vi.fn(async () => {
      throw new Error("initial submit must not run for a bound lease");
    });
    const replay = vi.fn(async (
      admissionRequest: AdmissionRequest,
      expectedDgxJobId: string,
    ) => {
      expect(expectedDgxJobId).toBe(dgxJobId);
      const receipt = runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>;
      const replayNumber = replay.mock.calls.length;
      return boundDgxReplay(
        studioJobId,
        dgxJobId,
        replayNumber === 1 ? "queued" : "accepted",
        admissionRequest,
        receipt.observedCreatedAt,
        retryAfterSeconds,
      );
    });
    const read = vi.fn(async (jobId: string) =>
      boundDgxRead(studioJobId, jobId, "queued"));
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read,
        transition: async () => {
          throw new Error("start transition is stubbed in this replay test");
        },
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    clock = Date.parse(
      (runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>).confirmedAt,
    ) + 100;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    Reflect.set(manager, "waitForDelay", async (_job: unknown, delayMs: number) => {
      waits.push(delayMs);
      clock += delayMs;
      return true;
    });
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    const outcome = await waitForQueuedDgxJob.call(manager, runtimeJob, 0);

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(expectedReads);
    expect(waits).toEqual(expectedWaits);
    expect(startAccepted).toHaveBeenCalledOnce();
    expect(outcome).toBe("started");
  });

  it("does not start when Studio cancellation wins an in-flight exact replay", async () => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId("cancelled-replay-race");
    let replayStartedResolve!: () => void;
    const replayStarted = new Promise<void>((resolvePromise) => {
      replayStartedResolve = resolvePromise;
    });
    let releaseReplayResolve!: () => void;
    const releaseReplay = new Promise<void>((resolvePromise) => {
      releaseReplayResolve = resolvePromise;
    });
    let replaySignal: AbortSignal | undefined;
    const initialSubmit = vi.fn(async () => {
      throw new Error("initial submit must not run for a bound lease");
    });
    const replay = vi.fn(async (
      admissionRequest: AdmissionRequest,
      expectedDgxJobId: string,
      signal?: AbortSignal,
    ) => {
      expect(expectedDgxJobId).toBe(dgxJobId);
      replaySignal = signal;
      replayStartedResolve();
      await releaseReplay;
      const receipt = runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>;
      return boundDgxReplay(
        studioJobId,
        dgxJobId,
        "accepted",
        admissionRequest,
        receipt.observedCreatedAt,
      );
    });
    let remoteState: QueueJobState = "queued";
    const transition = vi.fn(async (jobId: string, state: QueueTransitionState) => {
      remoteState = applyStateSensitiveDgxTransition(remoteState, state);
      return boundDgxTransition(studioJobId, jobId, remoteState);
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
        transition,
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    const waiting = waitForQueuedDgxJob.call(manager, runtimeJob, 0);
    await replayStarted;
    expect(manager.cancel(created.id)).toMatchObject({ status: "cancelled" });
    expect(replaySignal?.aborted).toBe(true);
    releaseReplayResolve();

    await expect(waiting).resolves.toBe("stopped");
    expect(initialSubmit).not.toHaveBeenCalled();
    expect(startAccepted).not.toHaveBeenCalled();
    expect(runtimeJob.dgxJobId).toBe(dgxJobId);
    expect(runtimeJob).toMatchObject({
      dgxTerminalReceipt: {
        dgxJobId,
        remoteTerminalState: "cancelled",
      },
    });
    expect(runtimeJob).not.toHaveProperty("dgxLeaseReceipt");
    expect(manager.get(created.id)).toMatchObject({ status: "cancelled", outputUrl: null });
  });

  it.each([
    ["foreign response job ID", "response-foreign-id", true],
    ["different response created_at", "response-created-at", true],
    ["missing response replay marker", "response-missing-marker", true],
    ["malformed authoritative 409", "error-malformed-409", true],
    ["malformed authoritative 410", "error-malformed-410", true],
    ["exact safe 409", "error-safe-409", false],
    ["exact safe 410", "error-safe-410", false],
  ] as const)(
    "validates an in-flight replay after cancellation and applies HOLD semantics for %s",
    async (_case, outcome, expectHold) => {
      let studioJobId = "";
      const dgxJobId = testDgxJobId(`cancelled-replay-contract-${outcome}`);
      const foreignDgxJobId = testDgxJobId(`cancelled-replay-contract-foreign-${outcome}`);
      let observedCreatedAt = "";
      let replayStartedResolve!: () => void;
      const replayStarted = new Promise<void>((resolvePromise) => {
        replayStartedResolve = resolvePromise;
      });
      let releaseReplayResolve!: () => void;
      const releaseReplay = new Promise<void>((resolvePromise) => {
        releaseReplayResolve = resolvePromise;
      });
      let replaySignal: AbortSignal | undefined;
      const initialSubmit = vi.fn(async () => {
        throw new Error("cancellation reconciliation must never use the lease-creating endpoint");
      });
      const replay = vi.fn(async (
        admissionRequest: AdmissionRequest,
        expectedDgxJobId: string,
        signal?: AbortSignal,
      ) => {
        expect(expectedDgxJobId).toBe(dgxJobId);
        replaySignal = signal;
        replayStartedResolve();
        await releaseReplay;
        if (outcome.startsWith("response-")) {
          const response = boundDgxReplay(
            studioJobId,
            dgxJobId,
            "accepted",
            admissionRequest,
            observedCreatedAt,
          );
          if (outcome === "response-foreign-id") {
            response.job.job_id = foreignDgxJobId;
          } else if (outcome === "response-created-at") {
            response.job.created_at = new Date(
              Date.parse(observedCreatedAt) + 1_000,
            ).toISOString();
          } else {
            delete (response.admission as Record<string, unknown>).idempotent_replay;
          }
          return response;
        }
        if (outcome.endsWith("409")) {
          throw new RuntimeApiError("conditional replay target mismatch", 409, {
            schema_version: "dgx-queue-replay-conflict.v0",
            error: "replay_target_mismatch",
            expected_job_id: dgxJobId,
            observed_job_id: outcome === "error-safe-409" ? null : foreignDgxJobId,
            client_action: "poll_expected_job_status",
          });
        }
        throw new RuntimeApiError("conditional replay target is gone", 410, {
          error: "job_gone",
          job_id: outcome === "error-safe-410" ? dgxJobId : foreignDgxJobId,
          schema_version: "dgx-job-gone.v0",
          terminal: true,
          state: "cancelled",
          reason: "terminal_record_bound_to_key",
          finished_at: observedCreatedAt,
          reaped_at: observedCreatedAt,
          idempotency_key: `ltx-studio:${studioJobId}`,
          request_sha256: exactDgxRequestSha256(admissionRequest),
        });
      });
      let remoteState: QueueJobState = "queued";
      const transition = vi.fn(async (jobId: string, state: QueueTransitionState) => {
        expect(jobId).toBe(dgxJobId);
        remoteState = applyStateSensitiveDgxTransition(remoteState, state);
        return boundDgxTransition(studioJobId, jobId, remoteState);
      });
      const manager = new JobManager(
        await statePath(),
        false,
        null,
        undefined,
        {
          read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
          transition,
        },
        null,
        { submit: initialSubmit, replay },
      );
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      bindTestDgxLease(
        runtimeJob,
        created.id,
        dgxJobId,
        runtimeJob.request as ReturnType<typeof validRequest>,
      );
      observedCreatedAt = (
        runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>
      ).observedCreatedAt;
      const startAccepted = vi.fn(async () => "started");
      Reflect.set(manager, "waitForDelay", async () => true);
      Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
      const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
        job: unknown,
        delayMs: number,
      ) => Promise<string>;

      const waiting = waitForQueuedDgxJob.call(manager, runtimeJob, 0);
      await replayStarted;
      expect(manager.cancel(created.id)).toMatchObject({ status: "cancelled" });
      expect(replaySignal?.aborted).toBe(true);
      releaseReplayResolve();

      await expect(waiting).resolves.toBe("stopped");
      expect(initialSubmit).not.toHaveBeenCalled();
      expect(replay).toHaveBeenCalledOnce();
      expect(startAccepted).not.toHaveBeenCalled();
      expect(runtimeJob.dgxJobId).toBe(dgxJobId);
      expect(manager.get(created.id)).toMatchObject({ status: "cancelled", outputUrl: null });
      expect(manager.persistenceHealth()).toMatchObject({
        status: expectHold ? "hold" : "ok",
      });
    },
  );

  it.each([
    ["retained terminal response", "response"],
    ["exact HTTP 410 tombstone", "gone"],
  ] as const)(
    "persists %s when cancellation wins and the parallel PATCH/GET settlement is unavailable",
    async (_case, outcome) => {
      let studioJobId = "";
      let observedCreatedAt = "";
      let readCount = 0;
      const dgxJobId = testDgxJobId(`cancel-terminal-evidence-${outcome}`);
      let replayStartedResolve!: () => void;
      const replayStarted = new Promise<void>((resolvePromise) => {
        replayStartedResolve = resolvePromise;
      });
      let releaseReplayResolve!: () => void;
      const releaseReplay = new Promise<void>((resolvePromise) => {
        releaseReplayResolve = resolvePromise;
      });
      let terminalReadStartedResolve!: () => void;
      const terminalReadStarted = new Promise<void>((resolvePromise) => {
        terminalReadStartedResolve = resolvePromise;
      });
      const initialSubmit = vi.fn(async () => {
        throw new Error("cancellation reconciliation must never create a replacement lease");
      });
      const replay = vi.fn(async (
        admissionRequest: AdmissionRequest,
        expectedDgxJobId: string,
      ) => {
        expect(expectedDgxJobId).toBe(dgxJobId);
        replayStartedResolve();
        await releaseReplay;
        if (outcome === "response") {
          return boundDgxReplay(
            studioJobId,
            dgxJobId,
            "cancelled",
            admissionRequest,
            observedCreatedAt,
          );
        }
        throw new RuntimeApiError("exact replay target is retained only as a tombstone", 410, {
          error: "job_gone",
          job_id: dgxJobId,
          schema_version: "dgx-job-gone.v0",
          terminal: true,
          state: "cancelled",
          reason: "terminal_record_bound_to_key",
          finished_at: observedCreatedAt,
          reaped_at: observedCreatedAt,
          idempotency_key: `ltx-studio:${studioJobId}`,
          request_sha256: exactDgxRequestSha256(admissionRequest),
        });
      });
      const read = vi.fn(async (jobId: string) => {
        readCount += 1;
        if (readCount === 1) return boundDgxRead(studioJobId, jobId, "queued");
        terminalReadStartedResolve();
        throw new Error("parallel terminal GET is unavailable");
      });
      const transition = vi.fn(async () => {
        throw new Error("parallel terminal PATCH is unavailable");
      });
      const path = await statePath();
      const manager = new JobManager(
        path,
        false,
        null,
        undefined,
        { read, transition },
        null,
        { submit: initialSubmit, replay },
      );
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      runtimeJob.runProvenance = runProvenance();
      expect((Reflect.get(manager, "classifyExecution") as (
        job: unknown,
        executionClass: "dgx",
      ) => boolean).call(manager, runtimeJob, "dgx")).toBe(true);
      bindTestDgxLease(
        runtimeJob,
        created.id,
        dgxJobId,
        runtimeJob.request as ReturnType<typeof validRequest>,
      );
      observedCreatedAt = (
        runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>
      ).observedCreatedAt;
      Reflect.set(manager, "waitForDelay", async () => true);
      const startAccepted = vi.fn(async () => "started");
      Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
      const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
        job: unknown,
        delayMs: number,
      ) => Promise<string>;

      const waiting = waitForQueuedDgxJob.call(manager, runtimeJob, 0);
      await replayStarted;
      expect(manager.cancel(created.id)).toMatchObject({ status: "cancelled" });
      const terminalDelivery = runtimeJob.dgxTerminalDeliveryInFlight as Promise<boolean>;
      await terminalReadStarted;
      releaseReplayResolve();

      await expect(waiting).resolves.toBe("stopped");
      await expect(terminalDelivery).resolves.toBe(false);
      expect(initialSubmit).not.toHaveBeenCalled();
      expect(replay).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(3);
      expect(transition).not.toHaveBeenCalled();
      expect(startAccepted).not.toHaveBeenCalled();
      expect(runtimeJob).toMatchObject({
        status: "cancelled",
        dgxJobId,
        dgxJobTerminal: true,
        dgxTerminalReceipt: {
          dgxJobId,
          localIntentState: "cancelled",
          remoteTerminalState: "cancelled",
          evidence: {
            kind: outcome === "response" ? "queue-replay" : "job-gone",
          },
        },
      });
      expect(runtimeJob).not.toHaveProperty("dgxLeaseReceipt");
      expect(runtimeJob).not.toHaveProperty("dgxTerminalDelivery");
      expect(manager.get(created.id)).toMatchObject({
        status: "cancelled",
        cancellationState: "settled",
      });
      expect(manager.persistenceHealth()).toMatchObject({ status: "ok" });

      const restartRead = vi.fn(async () => {
        throw new Error("persisted cancel-replay receipt must suppress GET after restart");
      });
      const restartTransition = vi.fn(async () => {
        throw new Error("persisted cancel-replay receipt must suppress PATCH after restart");
      });
      const restarted = new JobManager(path, false, null, undefined, {
        read: restartRead,
        transition: restartTransition,
      }, null);
      expect(restarted.get(created.id)).toMatchObject({
        status: "cancelled",
        cancellationState: "settled",
      });
      const restartedRuntimeJob = (
        Reflect.get(restarted, "jobs") as Map<string, Record<string, unknown>>
      ).get(created.id)!;
      expect(restartedRuntimeJob.dgxTerminalReceipt).toMatchObject({
        dgxJobId,
        localIntentState: "cancelled",
        remoteTerminalState: "cancelled",
        evidence: {
          kind: outcome === "response" ? "queue-replay" : "job-gone",
        },
      });
      expect(restartedRuntimeJob.dgxLeaseReceipt).toBeUndefined();
      expect(restartedRuntimeJob.dgxTerminalDelivery).toBeUndefined();
      expect(restartRead).not.toHaveBeenCalled();
      expect(restartTransition).not.toHaveBeenCalled();
    },
  );

  it("enters HOLD before replay HTTP when the local Runtime-Trust preflight fails", async () => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId("replay-runtime-trust-preflight");
    const initialSubmit = vi.fn(async () => {
      throw new Error("a bound replay must never call the lease-creating endpoint");
    });
    const replay = vi.fn(async () => {
      throw new Error("Runtime-Trust denial must prevent replay HTTP");
    });
    const read = vi.fn(async (jobId: string) =>
      boundDgxRead(studioJobId, jobId, "queued"));
    const transition = vi.fn(async () => {
      throw new Error("Runtime-Trust denial must prevent PATCH");
    });
    const runtimeTrustRevalidation = vi.fn(() => {
      throw new Error("synthetic local Runtime-Trust drift before replay HTTP");
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      { read, transition },
      null,
      { submit: initialSubmit, replay },
      undefined,
      undefined,
      undefined,
      undefined,
      runtimeTrustRevalidation,
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const receiptBefore = canonicalJson(runtimeJob.dgxLeaseReceipt);
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("stopped");

    expect(read).toHaveBeenCalledOnce();
    expect(runtimeTrustRevalidation).toHaveBeenCalledOnce();
    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(startAccepted).not.toHaveBeenCalled();
    expect(canonicalJson(runtimeJob.dgxLeaseReceipt)).toBe(receiptBefore);
    expect(manager.persistenceHealth()).toMatchObject({ status: "hold" });
  });

  it("performs a GET one second after a synthetic 25-second replay timeout without resubmitting", async () => {
    let studioJobId = "";
    let clock = Date.now();
    let reads = 0;
    const readAt: number[] = [];
    const waits: number[] = [];
    const dgxJobId = testDgxJobId("slow-replay-timeout-get-cadence");
    const initialSubmit = vi.fn(async () => {
      throw new Error("a replay timeout must never fall back to lease-creating submit");
    });
    const replay = vi.fn(async () => {
      clock += 25_000;
      throw new RuntimeApiError("DGX Runtime API Timeout.", null);
    });
    const read = vi.fn(async (jobId: string) => {
      readAt.push(clock);
      reads += 1;
      return boundDgxRead(studioJobId, jobId, reads === 1 ? "queued" : "accepted");
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      {
        read,
        transition: async () => {
          throw new Error("start transition is stubbed in the timeout cadence test");
        },
      },
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      dgxJobId,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    clock = Date.parse(
      (runtimeJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>).confirmedAt,
    ) + 100;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    Reflect.set(manager, "waitForDelay", async (_job: unknown, delayMs: number) => {
      waits.push(delayMs);
      clock += delayMs;
      return true;
    });
    const startAccepted = vi.fn(async () => "started");
    Reflect.set(manager, "startAcceptedDgxJob", startAccepted);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    await expect(waitForQueuedDgxJob.call(manager, runtimeJob, 0)).resolves.toBe("started");

    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledTimes(2);
    expect(readAt[1] - readAt[0]).toBe(26_000);
    expect(waits).toEqual([0, 1_000]);
    expect(startAccepted).toHaveBeenCalledOnce();
    expect(manager.persistenceHealth()).toMatchObject({ status: "ok" });
  });

  it("never exact-replays an ambiguous submit intent before a lease receipt is bound", async () => {
    const initialSubmit = vi.fn(async () => {
      throw new Error("initial submit must not run through the replay helper");
    });
    const replay = vi.fn(async () => {
      throw new Error("unbound admission must not be replayed");
    });
    const manager = new JobManager(
      await statePath(),
      false,
      null,
      undefined,
      undefined,
      null,
      { submit: initialSubmit, replay },
    );
    const created = manager.create(validRequest());
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestPendingDgxSubmit(
      runtimeJob,
      created.id,
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    const replayBoundDgxQueueAdmission = Reflect.get(
      manager,
      "replayBoundDgxQueueAdmission",
    ) as (job: unknown) => Promise<unknown>;

    await expect(replayBoundDgxQueueAdmission.call(manager, runtimeJob))
      .rejects.toThrow(/kein gültiges dauerhaftes Submit-Receipt/u);
    expect(initialSubmit).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();
    expect(runtimeJob).toMatchObject({ dgxJobId: null, dgxSubmitPending: true });
  });

  it("maps a failed accepted-to-starting transition to remote cancellation before compute", async () => {
    let remoteState: "accepted" | "cancelled" = "accepted";
    const transitions: string[] = [];
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async (jobId, state) => {
        transitions.push(state);
        if (state === "starting") throw new Error("remote end closed connection");
        remoteState = "cancelled";
        return boundDgxTransition(studioJobId, jobId, remoteState);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob,
      created.id,
      testDgxJobId("starting-transition-failure"),
      runtimeJob.request as ReturnType<typeof validRequest>,
    );
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 121,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 8,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));
    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (
      job: unknown,
      acceptedQueueJob: QueueJobSummary,
    ) => Promise<string>;

    expect(await startAccepted.call(
      manager,
      runtimeJob,
      boundDgxJob(created.id, runtimeJob.dgxJobId as string, "accepted"),
    )).toBe("stopped");
    expect(transitions).toEqual(["starting", "cancelled"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "failed",
      error: "DGX-Queue-Start-Fence wurde nicht freigegeben.",
      outputUrl: null,
    });
  });

  it("cannot resume a cancelled job after an asynchronous evidence hash finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-cancel-evidence-"));
    roots.push(root);
    const modelRoot = join(root, "models");
    const gemmaRoot = join(modelRoot, "gemma");
    await mkdir(gemmaRoot, { recursive: true });
    const checkpoint = join(modelRoot, "checkpoint.safetensors");
    await writeFile(checkpoint, "model");
    await writeFile(join(gemmaRoot, "preprocessor_config.json"), "{}");
    const request = validRequest("one-stage");
    request.models.checkpointPath = checkpoint;
    request.models.gemmaRoot = gemmaRoot;
    request.outputName = `cancel-evidence-${Date.now()}.mp4`;

    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let finishResolve!: (value: ReturnType<typeof notApplicableIdentityEvidence>) => void;
    const finish = new Promise<ReturnType<typeof notApplicableIdentityEvidence>>((resolve) => {
      finishResolve = resolve;
    });
    const manager = new JobManager(join(root, "jobs.json"), true, null, {
      capture: async () => {
        enteredResolve();
        return finish;
      },
      verify: async (evidence) => ({ evidence, error: null }),
    });
    const created = manager.create(request);
    await entered;

    manager.cancel(created.id);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      cancellationState: "settling",
    });
    expect(manager.rerun(created.id, "exact")).toBeUndefined();
    finishResolve(notApplicableIdentityEvidence());
    for (let attempt = 0;
      attempt < 40 && manager.get(created.id)?.cancellationState !== "settled";
      attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      cancelledBy: "studio",
      cancellationState: "settled",
      outputUrl: null,
    });
  });

  it("does not overwrite an orchestrator cancellation with failed during evidence verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-cancel-verification-"));
    roots.push(root);
    const modelRoot = join(root, "models");
    const gemmaRoot = join(modelRoot, "gemma");
    const checkpoint = join(modelRoot, "checkpoint.safetensors");
    await mkdir(gemmaRoot, { recursive: true });
    await writeFile(checkpoint, "model");
    await writeFile(join(gemmaRoot, "preprocessor_config.json"), "{}");
    const request = validRequest("one-stage");
    request.models.checkpointPath = checkpoint;
    request.models.gemmaRoot = gemmaRoot;
    request.outputName = `cancel-verification-${Date.now()}.mp4`;

    let verificationStartedResolve!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      verificationStartedResolve = resolve;
    });
    let finishVerificationResolve!: () => void;
    const finishVerification = new Promise<void>((resolve) => {
      finishVerificationResolve = resolve;
    });
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("cancel-verification");
    let studioJobId = "";
    const manager = new JobManager(join(root, "jobs.json"), true, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => {
        verificationStartedResolve();
        await finishVerification;
        return { evidence, error: null };
      },
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (jobId, state) => {
        transitions.push(state);
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null, undefined, testRunProvenanceOperations);
    Reflect.set(manager, "waitForDgxQueueStart", async (job: Record<string, unknown>) => {
      bindTestDgxLease(job, job.id as string, dgxJobId, request);
      return true;
    });
    const created = manager.create(request);
    studioJobId = created.id;
    await verificationStarted;

    manager.cancel(created.id);
    finishVerificationResolve();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(manager.get(created.id)?.status).toBe("cancelled");
    expect(transitions).toContain("cancelled");
    expect(transitions).not.toContain("failed");
  });

  it("keeps the DGX job running through final audio and identity verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-queue-finalization-"));
    roots.push(root);
    await mkdir(outputRoot, { recursive: true });
    const request = validRequest("audio-to-video");
    request.models.checkpointPath = recommendedModelAsset("ltx23-dev-checkpoint").localPath;
    request.models.gemmaRoot = recommendedModelAsset("ltx23-gemma").localPath;
    request.models.distilledLora.path = recommendedModelAsset("ltx23-distilled-lora").localPath;
    request.models.spatialUpscalerPath = recommendedModelAsset("ltx23-spatial-upscaler").localPath;
    request.audio.finalMix = {
      path: join(root, "final-mix.wav"),
      name: "final-mix.wav",
    };
    request.outputName = `queue-finalization-${Date.now()}.mp4`;
    const finalOutput = join(outputRoot, request.outputName);
    roots.push(finalOutput, outputPublicationPath(finalOutput));
    const events: string[] = [];
    let verificationCount = 0;
    let completedTransitionStartedResolve!: () => void;
    const completedTransitionStarted = new Promise<void>((resolve) => {
      completedTransitionStartedResolve = resolve;
    });
    let releaseCompletedTransitionResolve!: () => void;
    const releaseCompletedTransition = new Promise<void>((resolve) => {
      releaseCompletedTransitionResolve = resolve;
    });
    let createdId = "";
    const dgxJobId = testDgxJobId("final-audio-verification");
    let remoteState: "starting" | "running" | "completed" = "starting";
    const manager = new JobManager(join(root, "jobs.json"), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => {
        verificationCount += 1;
        events.push(verificationCount === 1 ? "pre-identity" : "final-identity");
        return { evidence, error: null };
      },
    }, {
      read: async (jobId) => boundDgxRead(createdId, jobId, remoteState),
      transition: async (jobId, state) => {
        if (state === "completed") {
          expect(events.at(-1)).toBe("final-identity");
          expect(await readFile(finalOutput, "utf8")).toBe("final-video");
          expect(manager.get(createdId)?.status).toBe("completed");
          completedTransitionStartedResolve();
          await releaseCompletedTransition;
        }
        remoteState = state as typeof remoteState;
        events.push(state);
        return boundDgxTransition(createdId, jobId, state);
      },
    }, null, undefined, testRunProvenanceOperations);
    Reflect.set(manager, "modelInventoryOperations", {
      read: async () => verifiedModelInventory(),
    });
    Reflect.set(manager, "nativeRuntimeSourceProbeOperations", {
      run: () => ({
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          schemaVersion: "ltx-studio-native-runtime-source-probe.v2",
          distribution: "ltx-pipelines",
          distributionVersion: "1.3.0",
          sources: NATIVE_RUNTIME_SOURCE_CONTRACTS.a2v.sources.map((source) => ({
            distributionRelativePath: source.distributionRelativePath,
            moduleName: source.moduleName,
            moduleFile: `/runtime/lib/python3.12/site-packages/${source.distributionRelativePath}`,
            moduleSizeBytes: 42_000,
            runtimeSourceSha256: source.runtimeSourceSha256,
          })),
        }),
        stderr: "",
      }),
    });
    const created = manager.create(request);
    createdId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      dgxJobId: string | null;
      plan: {
        executable: string;
        args: string[];
        outputPath: string;
        requiredPaths: unknown[];
      };
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.plan.executable = process.execPath;
    runtimeJob.plan.args = [
      "-e",
      "const fs=require('node:fs');const i=process.argv.indexOf('--output-path');fs.writeFileSync(process.argv[i+1],'ltx-base');",
      "--",
      "--output-path",
      "replaced-by-runner",
    ];
    runtimeJob.plan.outputPath = finalOutput;
    runtimeJob.plan.requiredPaths = [];

    Reflect.set(manager, "waitForDgxQueueStart", async (job: Record<string, unknown>) => {
      bindTestDgxLease(job, job.id as string, dgxJobId, request);
      return true;
    });
    Reflect.set(manager, "readThermalBaseline", async () => 50);
    Reflect.set(manager, "watchThermals", () => () => undefined);
    Reflect.set(
      manager,
      "runLoggedProcess",
      async (_job: unknown, executable: string, args: string[]) => {
        expect(executable).toBe("ffmpeg");
        events.push("final-audio-remux");
        await writeFile(args.at(-1)!, "final-video");
        return { code: 0, signal: null, error: null };
      },
    );
    const runJob = Reflect.get(manager, "run") as (job: unknown) => Promise<void>;
    const running = runJob.call(manager, runtimeJob);
    await completedTransitionStarted;
    expect(manager.cancel(created.id)?.status).toBe("completed");
    releaseCompletedTransitionResolve();
    await running;

    expect(events).toEqual([
      "pre-identity",
      "running",
      "final-audio-remux",
      "final-identity",
      "completed",
    ]);
    expect(manager.get(created.id)?.status).toBe("completed");
    await rm(join(hybridRoot, created.id), { recursive: true, force: true });
  });

  it("reconciles a lost completed response without failing the finished Studio job", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("lost-completed-response");
    let studioJobId = "";
    let remoteState: "running" | "completed" = "running";
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async (_jobId, state) => {
        expect(state).toBe("completed");
        remoteState = "completed";
        throw new Error("connection closed after commit");
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      dgxJobId: string | null;
      dgxJobTerminal?: boolean;
      dgxTerminalDelivery?: unknown;
      dgxTerminalReceipt?: Record<string, unknown>;
      runProvenance?: RunProvenance;
      status: string;
      progress: number | null;
      finishedAt: string | null;
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(manager, runtimeJob, "dgx")).toBe(true);
    bindTestDgxLease(
      runtimeJob as unknown as Record<string, unknown>,
      created.id,
      dgxJobId,
    );
    runtimeJob.status = "completed";
    runtimeJob.progress = 100;
    runtimeJob.finishedAt = new Date().toISOString();
    (Reflect.get(manager, "queue") as string[]).splice(
      (Reflect.get(manager, "queue") as string[]).indexOf(created.id),
      1,
    );

    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: string,
      metadata?: object,
    ) => Promise<boolean>;
    expect(await transition.call(manager, runtimeJob, "completed", {
      current_step: "finished",
    })).toBe(true);

    expect(runtimeJob.dgxJobTerminal).toBe(true);
    expect(runtimeJob.dgxTerminalDelivery).toBeUndefined();
    expect(runtimeJob.dgxTerminalReceipt).toMatchObject({
      localIntentState: "completed",
      remoteTerminalState: "completed",
      evidence: {
        kind: "job-read",
        schemaVersion: "dgx-job-read.v0",
        requestedBy: dgxCaller(created.id),
        sourceApp: "LTX Studio",
        idempotencyKey: dgxCaller(created.id),
      },
    });
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]).toMatchObject({
      dgxTerminalReceipt: {
        dgxJobId,
        localIntentState: "completed",
        remoteTerminalState: "completed",
        evidence: {
          kind: "job-read",
          schemaVersion: "dgx-job-read.v0",
          requestedBy: dgxCaller(created.id),
          sourceApp: "LTX Studio",
          idempotencyKey: dgxCaller(created.id),
        },
      },
    });
    expect(manager.get(created.id)?.logs.at(-1)).toContain("per GET abgeglichen");
  });

  it("waits on a Qwen start fence while the remote job remains accepted", async () => {
    const path = await statePath();
    let transitions = 0;
    let remoteState: "accepted" | "starting" = "accepted";
    let studioJobId = "";
    const dgxJobId = testDgxJobId("qwen-fence");
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async (jobId, state) => {
        transitions += 1;
        if (transitions === 1) {
          throw new RuntimeApiError("lease_cordon", 409, {
            error: "qwen_gate_active",
            retry_after_seconds: 30,
          });
        }
        remoteState = "starting";
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    Reflect.set(manager, "waitForDelay", async () => true);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob as unknown as Record<string, unknown>,
      created.id,
      dgxJobId,
    );
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
      metadata?: object,
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(true);
    expect(transitions).toBe(2);
    expect(manager.get(created.id)?.logs.join("\n")).toContain("Queue-Job bleibt accepted");
  });

  it("persists and logs a validated memory start-fence blocker", async () => {
    const path = await statePath();
    let studioJobId = "";
    const dgxJobId = testDgxJobId("memory-fence-diagnostic");
    const memoryBlocker = {
      kind: "memory",
      available_gib: 43.32,
      pending_reservations_gib: 0,
      required_available_gib: 94,
      current_shortfall_gib: 50.68,
    };
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0" as const,
        job: boundDgxJob(studioJobId, jobId, "queued", {
          reason: "insufficient_memory",
          reservation_active: false,
        }),
      }),
      transition: async () => {
        throw new RuntimeApiError("insufficient_memory", 409, {
          error: "start_gate_active",
          reason: "insufficient_memory",
          retry_after_seconds: 30,
          blocker: memoryBlocker,
        });
      },
    }, null);
    Reflect.set(manager, "waitForDelay", async () => false);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob as unknown as Record<string, unknown>,
      created.id,
      dgxJobId,
    );
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(false);
    expect(manager.get(created.id)?.dgxMemoryWait).toMatchObject({
      schemaVersion: "ltx-studio-dgx-memory-wait.v1",
      currentShortfallGiB: 50.68,
      availableGiB: 43.32,
      requiredAvailableGiB: 94,
    });
    expect(manager.get(created.id)?.logs.join("\n")).toContain(
      "DGX-Speicher: aktuell fehlen 50,68 GiB",
    );
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]?.dgxMemoryWait).toMatchObject({
      currentShortfallGiB: 50.68,
      qwenPagingReservedGiB: null,
      qwenRestoreReservedGiB: null,
    });
  });

  it("keeps a fresh resuming-409 memory blocker over a historical paused GET reason", async () => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId("resuming-memory-fence-diagnostic");
    const memoryBlocker = {
      kind: "memory",
      available_gib: 70,
      pending_reservations_gib: 4,
      required_available_gib: 94,
      current_shortfall_gib: 28,
    };
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0" as const,
        job: boundDgxJob(studioJobId, jobId, "paused", {
          reason: "selected segment waiter passed fresh start gate",
          reservation_active: false,
        }),
      }),
      transition: async () => {
        throw new RuntimeApiError("insufficient_memory", 409, {
          error: "start_gate_active",
          reason: "insufficient_memory",
          retry_after_seconds: 30,
          blocker: memoryBlocker,
        });
      },
    }, null);
    Reflect.set(manager, "waitForDelay", async () => false);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    runtimeJob.status = "paused";
    bindTestDgxLease(runtimeJob, created.id, dgxJobId);
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "resuming",
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "resuming")).toBe(false);
    expect(manager.get(created.id)?.dgxMemoryWait).toMatchObject({
      currentShortfallGiB: 28,
      availableGiB: 70,
      pendingReservationsGiB: 4,
      requiredAvailableGiB: 94,
    });
  });

  it("clears a stale memory blocker when an ordinary queue GET reports another reason", async () => {
    const path = await statePath();
    let studioJobId = "";
    const dgxJobId = testDgxJobId("memory-fence-cleared-by-queue-reason");
    const read = vi.fn(async (jobId: string) => ({
      schema_version: "dgx-job-read.v0" as const,
      job: boundDgxJob(studioJobId, jobId, "queued", {
        reason: "not_selected_queue_winner",
        reservation_active: false,
      }),
    }));
    const manager = new JobManager(path, false, null, undefined, {
      read,
      transition: async (jobId, state) => boundDgxTransition(studioJobId, jobId, state),
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(runtimeJob, created.id, dgxJobId);
    (Reflect.get(manager, "observeDgxMemoryWait") as (
      job: unknown,
      blocker: unknown,
    ) => boolean).call(manager, runtimeJob, {
      kind: "memory",
      available_gib: 43.32,
      pending_reservations_gib: 0,
      required_available_gib: 94,
      current_shortfall_gib: 50.68,
    });
    (Reflect.get(manager, "changed") as () => void).call(manager);
    let delays = 0;
    Reflect.set(manager, "waitForDelay", async () => {
      delays += 1;
      return delays === 1;
    });

    const waitForQueued = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;
    expect(await waitForQueued.call(manager, runtimeJob, 30_000)).toBe("stopped");
    expect(read).toHaveBeenCalledTimes(1);
    expect(manager.get(created.id)?.dgxMemoryWait).toBeNull();
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]?.dgxMemoryWait).toBeNull();
  });

  it("treats an explicit queue blocker null as a clear instead of reviving admission data", async () => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId("explicit-null-memory-clear");
    const memoryBlocker = {
      kind: "memory",
      available_gib: 43.32,
      pending_reservations_gib: 0,
      required_available_gib: 94,
      current_shortfall_gib: 50.68,
    };
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, undefined, null, {
      submit: async (admissionRequest) => {
        const response = boundDgxSubmit(studioJobId, dgxJobId, "queued", admissionRequest);
        return {
          ...response,
          job: { ...response.job, blocker: null },
          admission: { ...response.admission, blocker: memoryBlocker },
        };
      },
    });
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    Reflect.set(manager, "waitForDelay", async () => false);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await waitForDgxQueueStart.call(manager, runtimeJob)).toBe(false);
    expect(manager.get(created.id)?.dgxMemoryWait).toBeNull();
    expect(manager.get(created.id)?.logs.join("\n")).not.toContain("DGX-Speicher:");
  });

  it("clears a previous memory blocker after an authoritative successful start", async () => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId("memory-fence-cleared-by-start");
    const staleMemoryBlocker = {
      kind: "memory",
      available_gib: 43.32,
      pending_reservations_gib: 0,
      required_available_gib: 94,
      current_shortfall_gib: 50.68,
    };
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "accepted"),
      transition: async (jobId, state) => {
        const response = boundDgxTransition(studioJobId, jobId, state);
        response.job.blocker = staleMemoryBlocker;
        return response;
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    bindTestDgxLease(runtimeJob, created.id, dgxJobId);
    (Reflect.get(manager, "observeDgxMemoryWait") as (
      job: unknown,
      blocker: unknown,
    ) => boolean).call(manager, runtimeJob, staleMemoryBlocker);
    expect(manager.get(created.id)?.dgxMemoryWait).not.toBeNull();

    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
    ) => Promise<boolean>;
    expect(await transition.call(manager, runtimeJob, "starting")).toBe(true);
    expect(manager.get(created.id)?.dgxMemoryWait).toBeNull();
  });

  it("does not refresh the measurement time for an identical persisted blocker", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    const observe = Reflect.get(manager, "observeDgxMemoryWait") as (
      job: unknown,
      blocker: unknown,
      options: { observedAt: string },
    ) => boolean;
    const blocker = {
      kind: "memory",
      available_gib: 43.32,
      pending_reservations_gib: 0,
      required_available_gib: 94,
      current_shortfall_gib: 50.68,
    };

    expect(observe.call(manager, runtimeJob, blocker, {
      observedAt: "2026-08-28T06:30:00.000Z",
    })).toBe(true);
    expect(observe.call(manager, runtimeJob, blocker, {
      observedAt: "2026-08-28T07:30:00.000Z",
    })).toBe(false);
    expect(manager.get(created.id)?.dgxMemoryWait?.observedAt)
      .toBe("2026-08-28T06:30:00.000Z");
    expect(manager.get(created.id)?.logs.filter((line) => line.startsWith("DGX-Speicher:")))
      .toHaveLength(1);
  });

  it("does not revive a stale start blocker while a running job enters pausing", async () => {
    let studioJobId = "";
    const dgxJobId = testDgxJobId("stale-memory-blocker-during-pausing");
    const staleMemoryBlocker = {
      kind: "memory",
      available_gib: 43.32,
      pending_reservations_gib: 0,
      required_available_gib: 94,
      current_shortfall_gib: 50.68,
    };
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async (jobId, state) => {
        const response = boundDgxTransition(studioJobId, jobId, state);
        response.job.blocker = staleMemoryBlocker;
        return response;
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    runtimeJob.status = "running";
    bindTestDgxLease(runtimeJob, created.id, dgxJobId);
    (Reflect.get(manager, "observeDgxMemoryWait") as (
      job: unknown,
      blocker: unknown,
    ) => boolean).call(manager, runtimeJob, staleMemoryBlocker);
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "pausing",
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "pausing")).toBe(true);
    expect(manager.get(created.id)?.dgxMemoryWait).toBeNull();
  });

  it("waits when the Orchestrator has not selected the accepted job as queue winner", async () => {
    const path = await statePath();
    let transitions = 0;
    let remoteState: "accepted" | "starting" = "accepted";
    let studioJobId = "";
    const dgxJobId = testDgxJobId("waiting-for-winner");
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async (jobId, state) => {
        transitions += 1;
        if (transitions === 1) {
          throw new RuntimeApiError("DGX start gate active: not_selected_queue_winner", 409, {
            error: "start_gate_active",
            reason: "not_selected_queue_winner",
            retry_after_seconds: 5,
          });
        }
        remoteState = "starting";
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    Reflect.set(manager, "waitForDelay", async () => true);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob as unknown as Record<string, unknown>,
      created.id,
      dgxJobId,
    );
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
      metadata?: object,
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(true);
    expect(transitions).toBe(2);
    expect(manager.get(created.id)).toMatchObject({
      status: "queued",
      error: null,
      dgxJobId,
    });
    expect(manager.get(created.id)?.logs.join("\n")).toContain("not_selected_queue_winner");
  });

  it("retries the start fence when a queued job is not yet the selected winner", async () => {
    const path = await statePath();
    let transitions = 0;
    let remoteState: "queued" | "starting" = "queued";
    let studioJobId = "";
    const dgxJobId = testDgxJobId("queued-winner");
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async (jobId, state) => {
        transitions += 1;
        if (transitions === 1) {
          throw new RuntimeApiError("DGX start gate active: not_selected_queue_winner", 409, {
            error: "start_gate_active",
            reason: "not_selected_queue_winner",
            retry_after_seconds: 5,
          });
        }
        remoteState = "starting";
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null);
    Reflect.set(manager, "waitForDelay", async () => true);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob as unknown as Record<string, unknown>,
      created.id,
      dgxJobId,
    );
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(true);
    expect(transitions).toBe(2);
    expect(manager.get(created.id)?.logs.join("\n")).toContain("auf seine Auswahl");
  });

  it("reconciles a dropped starting response before retrying the transition", async () => {
    const path = await statePath();
    let transitions = 0;
    let remoteState: "accepted" | "starting" = "accepted";
    let studioJobId = "";
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async () => {
        transitions += 1;
        remoteState = "starting";
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob as unknown as Record<string, unknown>,
      created.id,
      testDgxJobId("lost-starting-response"),
    );
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(true);
    expect(transitions).toBe(1);
    expect(manager.get(created.id)?.logs.at(-1)).toContain(
      "per exakt gebundenem GET bestätigt",
    );
  });

  it("does not retry a non-Qwen transition conflict", async () => {
    const path = await statePath();
    let reads = 0;
    let studioJobId = "";
    const transitionRemote = vi.fn(async () => {
      throw new RuntimeApiError("invalid transition", 409, {
        error: "invalid_transition",
      });
    });
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => {
        reads += 1;
        return boundDgxRead(studioJobId, jobId, "accepted");
      },
      transition: transitionRemote,
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob as unknown as Record<string, unknown>,
      created.id,
      testDgxJobId("invalid-transition"),
    );
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(false);
    expect(transitionRemote).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
  });

  it("rearms terminal delivery retry when an in-flight state transition rejects", async () => {
    const read = vi.fn();
    const transition = vi.fn();
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read,
      transition,
    }, 100);
    const created = manager.create(validRequest());
    const dgxJobId = testDgxJobId("rejected-state-transition-retry");
    const active = bindActiveTestDgxLease(manager, created.id, dgxJobId);
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(manager, active, "cancelled", {
      current_step: "in-flight transition rejection",
    });
    (Reflect.get(manager, "changed") as () => void).call(manager);
    const rejectedTransition = Promise.reject<boolean>(
      new Error("synthetic in-flight DGX transition rejection"),
    );
    active.dgxStateTransitionInFlight = rejectedTransition;
    const scheduleRetry = vi.fn();
    Reflect.set(manager, "scheduleDgxTerminalRetry", scheduleRetry);
    const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;

    await expect(flush.call(manager, active)).rejects.toThrow(
      "synthetic in-flight DGX transition rejection",
    );

    expect(scheduleRetry).toHaveBeenCalledTimes(1);
    expect(active.dgxTerminalDelivery).toMatchObject({ state: "cancelled" });
    expect(active.dgxTerminalDeliveryInFlight).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    delete active.dgxStateTransitionInFlight;
  });

  it("rearms terminal delivery after a proven pre-network target-rename failure", async () => {
    const path = await statePath();
    let remoteState: QueueJobState = "running";
    let studioJobId = "";
    const dgxJobId = testDgxJobId("pre-network-retry");
    const read = vi.fn(async (jobId: string) => boundDgxRead(studioJobId, jobId, remoteState));
    const transition = vi.fn(async (
      jobId: string,
      state: QueueTransitionState,
    ) => {
      remoteState = state;
      return boundDgxTransition(studioJobId, jobId, state);
    });
    const manager = new JobManager(path, false, null, undefined, { read, transition }, 100);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId);
    (Reflect.get(manager, "queue") as string[]).splice(
      (Reflect.get(manager, "queue") as string[]).indexOf(created.id),
      1,
    );
    (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(manager, active, "cancelled", { current_step: "pre-network retry" });
    (Reflect.get(manager, "changed") as () => void).call(manager);

    const base = Reflect.get(manager, "jobPersistenceFileOperations") as Record<
      string,
      (...args: never[]) => unknown
    >;
    let failRenameOnce = true;
    Reflect.set(manager, "jobPersistenceFileOperations", {
      ...base,
      rename: (...args: never[]) => {
        if (failRenameOnce) {
          failRenameOnce = false;
          throw new Error("synthetic terminal-attempt target-rename failure");
        }
        return base.rename(...args);
      },
    });
    const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;

    await expect(flush.call(manager, active)).rejects.toThrow(
      "synthetic terminal-attempt target-rename failure",
    );
    expect(manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    expect(read).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
    expect(active.dgxTerminalDelivery).toMatchObject({ attempts: 0 });

    for (let attempt = 0; attempt < 150
      && manager.get(created.id)?.cancellationState !== "settled"; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(read).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(manager.get(created.id)?.cancellationState).toBe("settled");
  });

  it("rolls back a pre-rename terminal-receipt commit and settles on its GET-first retry", async () => {
    const path = await statePath();
    let remoteState: QueueJobState = "running";
    let studioJobId = "";
    const dgxJobId = testDgxJobId("receipt-commit-retry");
    const read = vi.fn(async (jobId: string) => boundDgxRead(studioJobId, jobId, remoteState));
    const transition = vi.fn(async (
      jobId: string,
      state: QueueTransitionState,
    ) => {
      remoteState = state;
      return boundDgxTransition(studioJobId, jobId, state);
    });
    const manager = new JobManager(path, false, null, undefined, { read, transition }, 100);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId);
    (Reflect.get(manager, "queue") as string[]).splice(
      (Reflect.get(manager, "queue") as string[]).indexOf(created.id),
      1,
    );
    (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(manager, active, "cancelled", { current_step: "receipt commit retry" });
    (Reflect.get(manager, "changed") as () => void).call(manager);

    const base = Reflect.get(manager, "jobPersistenceFileOperations") as Record<
      string,
      (...args: never[]) => unknown
    >;
    let failReceiptRenameOnce = true;
    Reflect.set(manager, "jobPersistenceFileOperations", {
      ...base,
      rename: (...args: never[]) => {
        if (failReceiptRenameOnce && active.dgxTerminalReceipt !== undefined) {
          failReceiptRenameOnce = false;
          throw new Error("synthetic receipt target-rename failure");
        }
        return base.rename(...args);
      },
    });
    const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;

    await expect(flush.call(manager, active)).rejects.toThrow(
      "synthetic receipt target-rename failure",
    );
    expect(manager.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    expect(read).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(active.dgxTerminalReceipt).toBeUndefined();
    expect(active.dgxJobTerminal).toBeUndefined();
    expect(active.dgxTerminalDelivery).toMatchObject({ state: "cancelled", attempts: 1 });
    const beforeRetry = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(beforeRetry[0]).not.toHaveProperty("dgxTerminalReceipt");
    expect(beforeRetry[0]).toHaveProperty("dgxTerminalDelivery");

    for (let attempt = 0; attempt < 150
      && manager.get(created.id)?.cancellationState !== "settled"; attempt += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    expect(read).toHaveBeenCalledTimes(2);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(manager.get(created.id)?.cancellationState).toBe("settled");
    const settled = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(settled[0]).not.toHaveProperty("dgxTerminalDelivery");
    expect(settled[0]).toMatchObject({
      dgxTerminalReceipt: {
        localIntentState: "cancelled",
        remoteTerminalState: "cancelled",
        evidence: {
          kind: "job-read",
          schemaVersion: "dgx-job-read.v0",
          requestedBy: dgxCaller(created.id),
          sourceApp: "LTX Studio",
          idempotencyKey: dgxCaller(created.id),
        },
      },
    });
  });

  it("keeps a post-rename terminal receipt in HOLD and trusts it only after restart", async () => {
    const path = await statePath();
    let studioJobId = "";
    const dgxJobId = testDgxJobId("receipt-post-rename-hold");
    const read = vi.fn(async (jobId: string) => boundDgxRead(studioJobId, jobId, "running"));
    const transition = vi.fn(async (jobId: string, state: QueueTransitionState) =>
      boundDgxTransition(studioJobId, jobId, state));
    const manager = new JobManager(path, false, null, undefined, { read, transition }, 10);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(manager, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(manager, active, "dgx")).toBe(true);
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(active, created.id, dgxJobId);
    (Reflect.get(manager, "queue") as string[]).splice(
      (Reflect.get(manager, "queue") as string[]).indexOf(created.id),
      1,
    );
    (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(manager, active, "cancelled", { current_step: "post-rename receipt HOLD" });
    (Reflect.get(manager, "changed") as () => void).call(manager);

    const base = Reflect.get(manager, "jobPersistenceFileOperations") as Record<
      string,
      (...args: never[]) => unknown
    >;
    let receiptFsyncCalls = 0;
    Reflect.set(manager, "jobPersistenceFileOperations", {
      ...base,
      fsync: (...args: never[]) => {
        if (active.dgxTerminalReceipt !== undefined) {
          receiptFsyncCalls += 1;
          if (receiptFsyncCalls >= 2) {
            throw new Error("synthetic permanent receipt directory fsync failure");
          }
        }
        return base.fsync(...args);
      },
    });
    const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;

    await expect(flush.call(manager, active)).resolves.toBe(false);
    expect(manager.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(read).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(active.dgxTerminalDelivery).toBeUndefined();
    expect(active.dgxTerminalReceipt).toBeDefined();
    expect(active.dgxTerminalRetry).toBeUndefined();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    expect(read).toHaveBeenCalledTimes(1);
    expect(transition).toHaveBeenCalledTimes(1);
    expect(manager.get(created.id)?.cancellationState).toBe("settling");

    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]).toHaveProperty("dgxTerminalReceipt");
    expect(persisted[0]).not.toHaveProperty("dgxTerminalDelivery");
    const restartRead = vi.fn(async () => {
      throw new Error("restart must trust the complete receipt without GET");
    });
    const restartTransition = vi.fn(async () => {
      throw new Error("restart must trust the complete receipt without PATCH");
    });
    const restarted = new JobManager(path, false, null, undefined, {
      read: restartRead,
      transition: restartTransition,
    }, null);
    expect(restarted.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    expect(restarted.get(created.id)?.cancellationState).toBe("settled");
    expect(restartRead).not.toHaveBeenCalled();
    expect(restartTransition).not.toHaveBeenCalled();
  });

  it("persists and redelivers a failed cancelled transition after restart", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("cancel-retry");
    let studioJobId = "";
    const identityOperations = {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence: ReturnType<typeof notApplicableIdentityEvidence>) => ({ evidence, error: null }),
    };
    const failingOperations = {
      read: async (jobId: string) => boundDgxRead(studioJobId, jobId, "running"),
      transition: async () => {
        throw new Error("temporary connection failure");
      },
    };
    const manager = new JobManager(path, false, null, identityOperations, failingOperations, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const firstInternalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
    bindTestDgxLease(firstInternalJobs.get(created.id)!, created.id, dgxJobId);

    manager.cancel(created.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = JSON.parse(await readFile(path, "utf8")) as Array<{
      dgxTerminalDelivery?: { state: string; attempts: number; lastError: string | null };
    }>;
    expect(pending[0].dgxTerminalDelivery).toMatchObject({
      state: "cancelled",
      attempts: 1,
    });
    expect(pending[0].dgxTerminalDelivery?.lastError).toContain("temporary connection failure");

    const deliveredStates: string[] = [];
    const restored = new JobManager(path, false, null, identityOperations, {
      read: failingOperations.read,
      transition: async (jobId, state) => {
        deliveredStates.push(state);
        return boundDgxTransition(created.id, jobId, state);
      },
    }, null);
    const restoredInternalJobs = Reflect.get(restored, "jobs") as Map<string, unknown>;
    const restoredJob = restoredInternalJobs.get(created.id)!;
    const flush = Reflect.get(restored, "flushDgxTerminalDelivery") as (job: unknown) => Promise<boolean>;
    const cancellationStates: string[] = [];
    restored.on("changed", (jobs: StudioJob[]) => {
      const state = jobs.find((job) => job.id === created.id)?.cancellationState;
      if (state) cancellationStates.push(state);
    });

    expect(await flush.call(restored, restoredJob)).toBe(true);
    expect(deliveredStates).toEqual(["cancelled"]);
    const delivered = JSON.parse(await readFile(path, "utf8")) as Array<{
      dgxTerminalDelivery?: unknown;
      dgxTerminalReceipt?: Record<string, unknown>;
    }>;
    expect(delivered[0].dgxTerminalDelivery).toBeUndefined();
    expect(delivered[0].dgxTerminalReceipt).toMatchObject({
      schemaVersion: "ltx-studio-dgx-terminal-receipt.v1",
      studioJobId: created.id,
      dgxJobId,
      idempotencyKey: `ltx-studio:${created.id}`,
      localIntentState: "cancelled",
      remoteTerminalState: "cancelled",
      evidence: {
        kind: "job-transition",
        schemaVersion: "dgx-job-transition.v0",
        requestedBy: dgxCaller(created.id),
        sourceApp: "LTX Studio",
        idempotencyKey: dgxCaller(created.id),
      },
    });
    expect(restored.get(created.id)?.cancellationState).toBe("settled");
    expect(cancellationStates.at(-1)).toBe("settled");

    const restartRead = vi.fn(failingOperations.read);
    const restartTransition = vi.fn(async () => {
      throw new Error("persisted PATCH receipt must suppress redelivery");
    });
    const restarted = new JobManager(path, false, null, identityOperations, {
      read: restartRead,
      transition: restartTransition,
    }, null);
    expect(restarted.get(created.id)?.cancellationState).toBe("settled");
    expect(restartRead).not.toHaveBeenCalled();
    expect(restartTransition).not.toHaveBeenCalled();
  });

  it("settles a reaped cancelled lease from an exact caller-bound HTTP 410 tombstone", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("reaped-cancelled");
    const seed = new JobManager(path, false, null, undefined, undefined, null);
    const created = seed.create(validRequest());
    const seedJob = (Reflect.get(seed, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    seedJob.runProvenance = runProvenance();
    expect((Reflect.get(seed, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(seed, seedJob, "dgx")).toBe(true);
    seedJob.status = "cancelled";
    seedJob.cancelledBy = "studio";
    seedJob.startedAt = new Date(Date.now() - 1_000).toISOString();
    seedJob.finishedAt = new Date().toISOString();
    bindTestDgxLease(seedJob, created.id, dgxJobId);
    const leaseReceipt = seedJob.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>;
    const leaseObservedCreatedAt = leaseReceipt.observedCreatedAt;
    const leaseRequestSha256 = exactDgxRequestSha256(leaseReceipt.preparedAdmission);
    const queue = Reflect.get(seed, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    (Reflect.get(seed, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(seed, seedJob, "cancelled", { current_step: "reaped cancellation proof" });
    (Reflect.get(seed, "changed") as () => void).call(seed);

    let reads = 0;
    const transition = vi.fn(async () => {
      throw new Error("a valid tombstone must prevent PATCH");
    });
    const restored = new JobManager(path, false, null, undefined, {
      read: async (jobId) => {
        reads += 1;
        throw new RuntimeApiError("job_gone", 410, {
          error: "job_gone",
          job_id: jobId,
          schema_version: "dgx-job-gone.v0",
          terminal: true,
          state: "cancelled",
          reason: "terminal_record_bound_to_key",
          finished_at: leaseObservedCreatedAt,
          reaped_at: leaseObservedCreatedAt,
          idempotency_key: `ltx-studio:${created.id}`,
          request_sha256: leaseRequestSha256,
        });
      },
      transition,
    }, null);
    const restoredJob = (Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    const flush = Reflect.get(restored, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(restored.get(created.id)?.cancellationState).toBe("settling");
    await expect(flush.call(restored, restoredJob)).resolves.toBe(true);
    await expect(flush.call(restored, restoredJob)).resolves.toBe(true);
    expect(reads).toBe(1);
    expect(transition).not.toHaveBeenCalled();
    expect(restoredJob.dgxTerminalDelivery).toBeUndefined();
    expect(restored.get(created.id)?.cancellationState).toBe("settled");
    expect(restored.get(created.id)).not.toHaveProperty("dgxTerminalReceipt");
    expect(restored.get(created.id)?.logs.at(-1)).toContain("HTTP-410-Gone-Terminalbeleg");
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted[0]).not.toHaveProperty("dgxTerminalDelivery");
    expect(persisted[0]).toMatchObject({
      dgxTerminalReceipt: {
        schemaVersion: "ltx-studio-dgx-terminal-receipt.v1",
        studioJobId: created.id,
        dgxJobId,
        idempotencyKey: `ltx-studio:${created.id}`,
        localIntentState: "cancelled",
        remoteTerminalState: "cancelled",
        confirmedAt: expect.any(String),
        evidence: {
          kind: "job-gone",
          schemaVersion: "ltx-studio-dgx-job-gone-evidence.v1",
          runtimeSchemaVersion: "dgx-job-gone.v0",
          requestSha256: leaseRequestSha256,
          finishedAt: leaseObservedCreatedAt,
          reapedAt: leaseObservedCreatedAt,
          reason: "terminal_record_bound_to_key",
          idempotencyKey: dgxCaller(created.id),
        },
      },
    });

    const restartRead = vi.fn(async () => {
      throw new Error("a durable terminal receipt must prevent GET after restart");
    });
    const restartTransition = vi.fn(async () => {
      throw new Error("a durable terminal receipt must prevent PATCH after restart");
    });
    const restartedTwice = new JobManager(path, false, null, undefined, {
      read: restartRead,
      transition: restartTransition,
    }, null);
    expect(restartedTwice.get(created.id)?.cancellationState).toBe("settled");
    expect(restartRead).not.toHaveBeenCalled();
    expect(restartTransition).not.toHaveBeenCalled();

    const restartedThrice = new JobManager(path, false, null, undefined, {
      read: restartRead,
      transition: restartTransition,
    }, null);
    expect(restartedThrice.get(created.id)?.cancellationState).toBe("settled");
    expect(restartRead).not.toHaveBeenCalled();
    expect(restartTransition).not.toHaveBeenCalled();

    const legacyPersisted = structuredClone(persisted);
    const legacyReceipt = legacyPersisted[0]!.dgxTerminalReceipt as Record<string, unknown>;
    legacyReceipt.evidence = {
      kind: "job-gone",
      schemaVersion: "dgx-job-gone.v0",
      idempotencyKey: dgxCaller(created.id),
      finishedAt: leaseObservedCreatedAt,
      reapedAt: leaseObservedCreatedAt,
      reason: "terminal_record_bound_to_key",
    };
    await writeFile(path, JSON.stringify(legacyPersisted));
    const legacyRead = vi.fn(async () => {
      throw new Error("a readable legacy terminal receipt must suppress GET");
    });
    const legacyTransition = vi.fn(async () => {
      throw new Error("a readable legacy terminal receipt must suppress PATCH");
    });
    const legacyRestored = new JobManager(path, false, null, undefined, {
      read: legacyRead,
      transition: legacyTransition,
    }, null);
    expect(legacyRestored.persistenceHealth()).toEqual({ status: "ok", restartRequired: false });
    expect(legacyRestored.get(created.id)?.cancellationState).toBe("settled");
    expect(legacyRead).not.toHaveBeenCalled();
    expect(legacyTransition).not.toHaveBeenCalled();
  });

  it.each([
    ["ambiguous 404", 404, { error: "job_not_found" }],
    ["wrong caller binding", 410, { idempotency_key: "ltx-studio:wrong-job" }],
    ["non-terminal claim", 410, { terminal: false }],
    ["active state", 410, { state: "running" }],
  ] as const)("keeps cancellation unsettled for an invalid %s tombstone", async (
    _case,
    statusCode,
    override,
  ) => {
    let leaseObservedCreatedAt = "";
    let leaseRequestSha256 = "";
    const manager = new JobManager(await statePath(), false, null, undefined, {
      read: async (jobId) => {
        throw new RuntimeApiError("untrusted gone response", statusCode, {
          error: "job_gone",
          job_id: jobId,
          schema_version: "dgx-job-gone.v0",
          terminal: true,
          state: "cancelled",
          finished_at: leaseObservedCreatedAt,
          reaped_at: leaseObservedCreatedAt,
          idempotency_key: `ltx-studio:${created.id}`,
          request_sha256: leaseRequestSha256,
          ...override,
        });
      },
      transition: async () => {
        throw new Error("initial GET failure must prevent PATCH");
      },
    }, null);
    const created = manager.create(validRequest());
    const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(
      active,
      created.id,
      testDgxJobId(`invalid-gone-${statusCode}-${_case}`),
    );
    const leaseReceipt = active.dgxLeaseReceipt as ReturnType<typeof testDgxLeaseReceipt>;
    leaseObservedCreatedAt = leaseReceipt.observedCreatedAt;
    leaseRequestSha256 = exactDgxRequestSha256(leaseReceipt.preparedAdmission);
    (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(manager, active, "cancelled", { current_step: "invalid gone proof" });
    (Reflect.get(manager, "changed") as () => void).call(manager);
    const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>;

    await expect(flush.call(manager, active)).resolves.toBe(false);
    expect(active.dgxTerminalDelivery).toMatchObject({ state: "cancelled" });
    expect(manager.get(created.id)?.cancellationState).toBe("settling");
  });

  it.each([
    "wrong schema",
    "foreign job",
    "wrong requested_by",
    "wrong source_app",
    "wrong idempotency_key",
  ] as const)(
    "never creates a terminal receipt from a GET with %s",
    async (fault) => {
      let studioJobId = "";
      const transition = vi.fn(async () => {
        throw new Error("an unbound GET must prevent PATCH");
      });
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read: async (jobId) => ({
          schema_version: fault === "wrong schema" ? "dgx-job-read.v1" : "dgx-job-read.v0",
          job: boundDgxJob(studioJobId, jobId, "cancelled", {
            ...(fault === "foreign job" ? { job_id: testDgxJobId("foreign-get") } : {}),
            ...(fault === "wrong requested_by" ? { requested_by: "ltx-studio:foreign" } : {}),
            ...(fault === "wrong source_app" ? { source_app: "Foreign Studio" } : {}),
            ...(fault === "wrong idempotency_key" ? { idempotency_key: "ltx-studio:foreign" } : {}),
          }),
        }) as never,
        transition,
      }, null);
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      active.status = "cancelled";
      active.cancelledBy = "studio";
      active.finishedAt = new Date().toISOString();
      bindTestDgxLease(active, created.id, testDgxJobId(`invalid-get-${fault}`));
      (Reflect.get(manager, "queue") as string[]).splice(
        (Reflect.get(manager, "queue") as string[]).indexOf(created.id),
        1,
      );
      (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
        job: unknown,
        state: "cancelled",
        metadata: Record<string, string>,
      ) => void).call(manager, active, "cancelled", { current_step: "invalid GET receipt" });
      (Reflect.get(manager, "changed") as () => void).call(manager);

      const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
        job: unknown,
      ) => Promise<boolean>;
      await expect(flush.call(manager, active)).resolves.toBe(false);

      expect(transition).not.toHaveBeenCalled();
      expect(active.dgxTerminalReceipt).toBeUndefined();
      expect(active.dgxTerminalDelivery).toMatchObject({ state: "cancelled" });
      expect(manager.get(created.id)?.cancellationState).toBe("settling");
    },
  );

  it.each([
    "wrong schema",
    "foreign job",
    "wrong requested_by",
    "wrong source_app",
    "wrong idempotency_key",
  ] as const)(
    "never creates a terminal receipt from a PATCH with %s",
    async (fault) => {
      let studioJobId = "";
      const read = vi.fn(async (jobId: string) => boundDgxRead(studioJobId, jobId, "running"));
      const transition = vi.fn(async (jobId: string) => ({
        schema_version: fault === "wrong schema" ? "dgx-job-transition.v1" : "dgx-job-transition.v0",
        transition_applied: true,
        job: boundDgxJob(studioJobId, jobId, "cancelled", {
          ...(fault === "foreign job" ? { job_id: testDgxJobId("foreign-patch") } : {}),
          ...(fault === "wrong requested_by" ? { requested_by: "ltx-studio:foreign" } : {}),
          ...(fault === "wrong source_app" ? { source_app: "Foreign Studio" } : {}),
          ...(fault === "wrong idempotency_key" ? { idempotency_key: "ltx-studio:foreign" } : {}),
        }),
      }) as never);
      const manager = new JobManager(
        await statePath(),
        false,
        null,
        undefined,
        { read, transition },
        null,
      );
      const created = manager.create(validRequest());
      studioJobId = created.id;
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>)
        .get(created.id)!;
      active.status = "cancelled";
      active.cancelledBy = "studio";
      active.finishedAt = new Date().toISOString();
      bindTestDgxLease(active, created.id, testDgxJobId(`invalid-patch-${fault}`));
      (Reflect.get(manager, "queue") as string[]).splice(
        (Reflect.get(manager, "queue") as string[]).indexOf(created.id),
        1,
      );
      (Reflect.get(manager, "prepareDgxTerminalDelivery") as (
        job: unknown,
        state: "cancelled",
        metadata: Record<string, string>,
      ) => void).call(manager, active, "cancelled", { current_step: "invalid PATCH receipt" });
      (Reflect.get(manager, "changed") as () => void).call(manager);

      const flush = Reflect.get(manager, "flushDgxTerminalDelivery") as (
        job: unknown,
      ) => Promise<boolean>;
      await expect(flush.call(manager, active)).resolves.toBe(false);

      expect(read).toHaveBeenCalledTimes(1);
      expect(transition).toHaveBeenCalledTimes(1);
      expect(active.dgxTerminalReceipt).toBeUndefined();
      expect(active.dgxTerminalDelivery).toMatchObject({ state: "cancelled" });
      expect(manager.get(created.id)?.cancellationState).toBe("settling");
    },
  );

  it("keeps cancellation authoritative while an older running transition is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-running-cancel-race-"));
    roots.push(root);
    const request = validRequest("one-stage");
    request.outputName = `running-cancel-race-${Date.now()}.mp4`;
    let runningTransitionStartedResolve!: () => void;
    const runningTransitionStarted = new Promise<void>((resolve) => {
      runningTransitionStartedResolve = resolve;
    });
    let releaseRunningTransitionResolve!: () => void;
    const releaseRunningTransition = new Promise<void>((resolve) => {
      releaseRunningTransitionResolve = resolve;
    });
    let cancellationDeliveredResolve!: () => void;
    const cancellationDelivered = new Promise<void>((resolve) => {
      cancellationDeliveredResolve = resolve;
    });
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("running-cancel-race");
    let studioJobId = "";
    let reads = 0;
    const manager = new JobManager(join(root, "jobs.json"), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => {
        reads += 1;
        if (reads === 1) return boundDgxRead(studioJobId, jobId, "starting");
        cancellationDeliveredResolve();
        return boundDgxRead(studioJobId, jobId, "cancelled");
      },
      transition: async (jobId, state) => {
        transitions.push(state);
        if (state === "running") {
          runningTransitionStartedResolve();
          await releaseRunningTransition;
          throw new Error("running transition lost to cancellation");
        }
        return boundDgxTransition(studioJobId, jobId, state);
      },
    }, null, undefined, testRunProvenanceOperations);
    const created = manager.create(request);
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      dgxJobId: string | null;
      plan: {
        executable: string;
        args: string[];
        outputPath: string;
        requiredPaths: unknown[];
      };
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.plan.executable = process.execPath;
    runtimeJob.plan.args = [
      "-e",
      "setTimeout(()=>{},10000)",
      "--",
      "--output-path",
      "replaced-by-runner",
    ];
    runtimeJob.plan.outputPath = join(root, request.outputName);
    runtimeJob.plan.requiredPaths = [];
    Reflect.set(manager, "waitForDgxQueueStart", async (job: Record<string, unknown>) => {
      bindTestDgxLease(job, job.id as string, dgxJobId, request);
      return true;
    });
    Reflect.set(manager, "readThermalBaseline", async () => 50);
    Reflect.set(manager, "watchThermals", () => () => undefined);

    const runJob = Reflect.get(manager, "run") as (job: unknown) => Promise<void>;
    const running = runJob.call(manager, runtimeJob);
    await runningTransitionStarted;
    expect(manager.cancel(created.id)?.status).toBe("cancelled");
    releaseRunningTransitionResolve();
    await cancellationDelivered;
    await running;

    expect(transitions).toEqual(["running"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      error: null,
    });
  });

  it("serializes cancellation against accepted to starting without launching compute", async () => {
    let remoteState: "accepted" | "starting" | "failed" = "accepted";
    let startingTransitionResolve!: () => void;
    const startingTransition = new Promise<void>((resolve) => {
      startingTransitionResolve = resolve;
    });
    let releaseStartingResolve!: () => void;
    const releaseStarting = new Promise<void>((resolve) => {
      releaseStartingResolve = resolve;
    });
    let terminalTransitionResolve!: () => void;
    const terminalTransition = new Promise<void>((resolve) => {
      terminalTransitionResolve = resolve;
    });
    const transitions: string[] = [];
    const dgxJobId = testDgxJobId("starting-cancel-race");
    let studioJobId = "";
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, remoteState),
      transition: async (jobId, state) => {
        transitions.push(state);
        if (state === "starting") {
          startingTransitionResolve();
          await releaseStarting;
          remoteState = "starting";
        } else if (state === "failed") {
          remoteState = "failed";
          terminalTransitionResolve();
        }
        return boundDgxTransition(studioJobId, jobId, remoteState);
      },
    }, null);
    const created = manager.create(validRequest());
    studioJobId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestDgxLease(
      runtimeJob as unknown as Record<string, unknown>,
      created.id,
      dgxJobId,
    );
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 121,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 8,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));

    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (
      job: unknown,
      acceptedQueueJob: QueueJobSummary,
    ) => Promise<string>;
    const starting = startAccepted.call(
      manager,
      runtimeJob,
      boundDgxJob(created.id, dgxJobId, "accepted"),
    );
    await startingTransition;
    expect(manager.cancel(created.id)?.status).toBe("cancelled");
    releaseStartingResolve();

    expect(await starting).toBe("stopped");
    await terminalTransition;
    expect(transitions).toEqual(["starting", "failed"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      outputUrl: null,
    });
  });

  it("restores pending terminal deliveries beyond the bounded normal history", async () => {
    const path = await statePath();
    const pendingId = "00000000-0000-4000-8000-000000000100";
    const dgxJobId = testDgxJobId("old-pending");
    const entries = Array.from({ length: 101 }, (_, index) => {
      const request = validRequest();
      request.outputName = `history-${index}.mp4`;
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return {
        id,
        status: "cancelled",
        mode: request.mode,
        prompt: request.prompt,
        outputName: request.outputName,
        outputUrl: null,
        createdAt: new Date(Date.now() - index * 1000).toISOString(),
        startedAt: null,
        finishedAt: new Date().toISOString(),
        progress: null,
        error: null,
        logs: [],
        command: "",
        request,
        favorite: false,
        variantOf: null,
        runtimeMs: null,
        cancelledBy: "studio",
        thermalProfile: null,
        dgxJobId: index === 100 ? dgxJobId : null,
        identityEvidence: null,
        ...(index === 100 ? {
          dgxLeaseReceipt: testDgxLeaseReceipt(id, dgxJobId, request),
          dgxTerminalDelivery: {
            state: "cancelled",
            metadata: { current_step: "old pending cancellation" },
            attempts: 3,
            lastError: "offline",
            updatedAt: new Date().toISOString(),
          },
        } : {}),
      };
    });
    await writeFile(path, JSON.stringify(entries));

    const restored = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => boundDgxRead(pendingId, jobId, "running"),
      transition: async () => {
        throw new Error("not expected");
      },
    }, null);

    expect(restored.list()).toHaveLength(101);
    expect(restored.get(pendingId)?.dgxJobId).toBe(dgxJobId);
  });

  it("does not retain an old completed terminal receipt as pending settlement authority", async () => {
    const path = await statePath();
    const dgxJobId = testDgxJobId("old-terminal-receipt");
    let studioJobId = "";
    const seed = new JobManager(path, false, null, undefined, {
      read: async (jobId) => boundDgxRead(studioJobId, jobId, "cancelled"),
      transition: async () => {
        throw new Error("terminal GET should prevent PATCH while seeding retention receipt");
      },
    }, null);
    const receiptJob = seed.create(validRequest());
    studioJobId = receiptJob.id;
    const active = (Reflect.get(seed, "jobs") as Map<string, Record<string, unknown>>)
      .get(receiptJob.id)!;
    active.runProvenance = runProvenance();
    expect((Reflect.get(seed, "classifyExecution") as (
      job: unknown,
      executionClass: "dgx",
    ) => boolean).call(seed, active, "dgx")).toBe(true);
    active.status = "cancelled";
    active.cancelledBy = "studio";
    active.finishedAt = new Date().toISOString();
    bindTestDgxLease(
      active,
      receiptJob.id,
      dgxJobId,
      active.request as ReturnType<typeof validRequest>,
    );
    (Reflect.get(seed, "queue") as string[]).splice(
      (Reflect.get(seed, "queue") as string[]).indexOf(receiptJob.id),
      1,
    );
    (Reflect.get(seed, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: "cancelled",
      metadata: Record<string, string>,
    ) => void).call(seed, active, "cancelled", { current_step: "retention receipt" });
    (Reflect.get(seed, "changed") as () => void).call(seed);
    await (Reflect.get(seed, "flushDgxTerminalDelivery") as (
      job: unknown,
    ) => Promise<boolean>).call(seed, active);
    const [persistedReceiptJob] = JSON.parse(await readFile(path, "utf8")) as Array<
      Record<string, unknown>
    >;
    expect(persistedReceiptJob).toHaveProperty("dgxTerminalReceipt");

    const history = Array.from({ length: 100 }, (_, index) => {
      const request = validRequest();
      request.outputName = `settled-history-${index}.mp4`;
      return {
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        status: "cancelled",
        mode: request.mode,
        prompt: request.prompt,
        outputName: request.outputName,
        outputUrl: null,
        createdAt: new Date(Date.now() - index * 1_000).toISOString(),
        startedAt: null,
        finishedAt: new Date().toISOString(),
        progress: null,
        error: null,
        logs: [],
        command: "",
        request,
        localProcessProtocol: "fd-gate.v1",
        favorite: false,
        variantOf: null,
        runtimeMs: null,
        cancelledBy: "studio",
        thermalProfile: null,
        dgxJobId: null,
        identityEvidence: null,
      };
    });
    await writeFile(path, JSON.stringify([...history, persistedReceiptJob]));
    const read = vi.fn(async () => {
      throw new Error("retained receipt must never trigger a remote read");
    });
    const transition = vi.fn(async () => {
      throw new Error("retained receipt must never trigger a remote transition");
    });

    const restored = new JobManager(path, false, null, undefined, { read, transition }, null);

    expect(restored.list()).toHaveLength(100);
    expect(restored.get(receiptJob.id)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("retains and clears an old spawn-pending crash fence beyond normal history", async () => {
    const path = await statePath();
    const pendingId = "00000000-0000-4000-8000-000000000100";
    const entries = Array.from({ length: 101 }, (_, index) => {
      const request = validRequest();
      request.outputName = `spawn-history-${index}.mp4`;
      return {
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        status: "cancelled",
        mode: request.mode,
        prompt: request.prompt,
        outputName: request.outputName,
        outputUrl: null,
        createdAt: new Date(Date.now() - index * 1_000).toISOString(),
        startedAt: null,
        finishedAt: new Date().toISOString(),
        progress: null,
        error: null,
        logs: [],
        command: "",
        request,
        localProcessProtocol: "fd-gate.v1" as const,
        favorite: false,
        variantOf: null,
        runtimeMs: null,
        cancelledBy: "studio",
        thermalProfile: null,
        dgxJobId: null,
        identityEvidence: null,
        ...(index === 100 ? { localProcessSpawnPending: true } : {}),
      };
    });
    await writeFile(path, JSON.stringify(entries));

    const restored = new JobManager(path, false);
    const restoredInternal = (Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>)
      .get(pendingId)!;
    expect(restored.list()).toHaveLength(101);
    expect(restored.get(pendingId)).toMatchObject({
      status: "cancelled",
      logs: expect.arrayContaining([expect.stringContaining("Parent-FD-Gate")]),
    });
    expect(restoredInternal.localProcessSpawnPending).toBeUndefined();
    expect(Reflect.get(restored, "queue")).not.toContain(pendingId);
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(persisted.find((entry) => entry.id === pendingId))
      .not.toHaveProperty("localProcessSpawnPending");
  });

  it("preserves an explicitly enabled LongCat pass on exact reruns", async () => {
    const manager = new JobManager(await statePath(), false);
    const request = validRequest("audio-to-video");
    request.images = [{ path: "/inputs/face.png", name: "face.png", frameIndex: 0, strength: 1, crf: 33 }];
    request.postprocess.longcatLipsync.enabled = true;
    request.postprocess.longcatLipsync.resolution = "720p";
    request.postprocess.longcatLipsync.blend = 0.65;

    const created = manager.create(request);
    manager.cancel(created.id);
    const variant = manager.rerun(created.id, "exact");

    expect(variant?.request.postprocess.longcatLipsync).toEqual({
      enabled: true,
      resolution: "720p",
      blend: 0.65,
    });
  });

  it("migrates a recoverable queued native-dialogue job to the official speech stack", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "Guten Morgen.";
    request.enhancePrompt = true;
    request.models.checkpointPath = "/legacy/dev.safetensors";
    request.models.gemmaRoot = "/legacy/gemma";
    request.models.distilledLora.path = "/legacy/distilled-lora.safetensors";
    request.models.spatialUpscalerPath = "/legacy/upscaler.safetensors";

    const created = manager.create(request);
    const restored = new JobManager(path, false).get(created.id)!;

    expect(restored.status).toBe("queued");
    expect(restored.request.enhancePrompt).toBe(false);
    expect(restored.request.models.checkpointPath).toBe(
      recommendedModelAsset("ltx23-dev-fp8-checkpoint").localPath,
    );
    expect(restored.request.quantization.mode).toBe("fp8-scaled-mm");
    expect(restored.request.models.gemmaRoot).toBe(
      recommendedModelAsset("ltx23-gemma").localPath,
    );
    expect(restored.request.models.distilledLora.path).toBe(
      recommendedModelAsset("ltx23-comfy-distilled-lora").localPath,
    );
    expect(restored.request.models.spatialUpscalerPath).toBe(
      recommendedModelAsset("ltx23-spatial-upscaler").localPath,
    );
  });

  it("retains a restored pre-v1.3 DFR job as terminal visible legacy without queueing it", async () => {
    const path = await statePath();
    const request = validRequest("dfr") as unknown as {
      prompt: string;
      outputName: string;
      models: { transformerPath: string };
      dfr: unknown;
      [key: string]: unknown;
    };
    request.models.transformerPath =
      "/models/ltx-2.5/ltx-2.5-22b-dev-transformer-bf16.safetensors";
    request.dfr = {
      temporalUpsampleRounds: 0,
      detailingLora: { enabled: false, path: "", strength: 1 },
    };
    const id = "00000000-0000-4000-8000-000000000097";
    await writeFile(path, JSON.stringify([{
      id,
      status: "queued",
      mode: "dfr",
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      logs: [],
      command: "ignored",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: null,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: null,
      identityEvidence: null,
      runProvenance: null,
    }]));

    const restoredManager = new JobManager(path, false);
    const restored = restoredManager.get(id)!;
    expect(isLegacyDfrRequest(restored.request)).toBe(true);
    expect(restored.status).toBe("failed");
    expect(Reflect.get(restoredManager, "queue")).not.toContain(id);
    expect(() => restoredManager.rerun(id, "exact")).toThrow("nicht ausführbar");
  });

  it("does not rewrite model paths from a frozen experiment binding", async () => {
    const request = validRequest("id-lora");
    request.models.distilledLora.path = "/models/historical-distilled-lora.safetensors";
    const requestSha256 = experimentRequestSha256V1(request);
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "22222222-2222-4222-8222-222222222222",
      protocolSha256: "a".repeat(64),
      arm: "candidate" as const,
      kind: "ablation" as const,
      variableId: "lipforcing-enabled",
      changedRequestPaths: ["postprocess.lipForcing.enabled"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256,
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "historical-baseline.mp4",
    };
    const manager = new JobManager(await statePath(), false);

    expect(() => manager.create(request, {
      experiment: { ...binding, requestSha256: "0".repeat(64) },
    })).toThrow("gebundenen Request-Revision");
    const created = manager.create(request, { experiment: binding });

    expect(created.request.models.distilledLora.path).toBe(
      "/models/historical-distilled-lora.safetensors",
    );
  });

  it("persists a frozen experiment binding across a Studio restart", async () => {
    const path = await statePath();
    const request = validRequest("audio-to-video");
    const requestSha256 = experimentRequestSha256V1(request);
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "33333333-3333-4333-8333-333333333333",
      protocolSha256: "a".repeat(64),
      arm: "baseline" as const,
      kind: "ablation" as const,
      variableId: "a2v-guidance",
      changedRequestPaths: ["videoGuidance.modalityScale"],
      baselineRequestSha256: requestSha256,
      requestSha256,
      baselineJobId: null,
      baselineOutputName: request.outputName,
    };
    const manager = new JobManager(path, false);

    const created = manager.create(request, { experiment: binding });
    const restored = new JobManager(path, false);

    expect(created.experiment).toEqual(binding);
    expect(restored.get(created.id)?.experiment).toEqual(binding);
  });

  it.each([
    ["fehlende Bindung", (entry: Record<string, unknown>) => { entry.experiment = null; }],
    ["falsche Variable", (entry: Record<string, unknown>) => {
      entry.experiment = {
        ...(entry.experiment as Record<string, unknown>),
        variableId: "lipforcing-decoder",
        changedRequestPaths: ["postprocess.lipForcing.decoder"],
      };
    }],
    ["falscher Request-Hash", (entry: Record<string, unknown>) => {
      entry.experiment = {
        ...(entry.experiment as Record<string, unknown>),
        requestSha256: "0".repeat(64),
      };
    }],
    ["fehlender Baseline-Job", (entry: Record<string, unknown>) => {
      entry.experiment = {
        ...(entry.experiment as Record<string, unknown>),
        baselineJobId: null,
      };
    }],
  ] as const)("terminalizes a restored mux-copy candidate with %s before queueing", async (_label, tamper) => {
    const path = await statePath();
    const request = validRequest("image-audio-to-video");
    request.outputName = `restore-raw-authority-${roots.length}.mp4`;
    request.postprocess.lipForcing.enabled = true;
    request.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
    const requestSha256 = experimentRequestSha256V1(request);
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "22222222-2222-4222-8222-222222222222",
      protocolSha256: "a".repeat(64),
      arm: "candidate" as const,
      kind: "ablation" as const,
      variableId: "lipforcing-raw-output-profile",
      changedRequestPaths: ["postprocess.lipForcing.rawOutputProfile"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256,
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "fresh-baseline.mp4",
    };
    const manager = new JobManager(path, false);
    const created = manager.create(request, { experiment: binding });
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    persisted[0].startSource = "experiment";
    tamper(persisted[0]);
    await writeFile(path, JSON.stringify(persisted));

    const restored = new JobManager(path, false);
    expect(restored.get(created.id)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Kandidatenarm-Autorität"),
    });
    expect(Reflect.get(restored, "queue")).not.toContain(created.id);
    expect(Reflect.get(restored, "runningId")).toBeNull();
  });

  it("cancels an existing DGX lease when restored raw experiment authority is semantically invalid", async () => {
    const dgxJobId = testDgxJobId("invalid-raw-lease");
    const { path, jobId } = await persistActiveRawDgxRestoreCase({
      dgxJobId,
    });
    const transitions: string[] = [];
    const submit = vi.fn();
    const restored = new JobManager(path, false, null, undefined, {
      read: async (remoteJobId) => boundDgxRead(jobId, remoteJobId, "running"),
      transition: async (remoteJobId, state) => {
        transitions.push(`${remoteJobId}:${state}`);
        return boundDgxTransition(jobId, remoteJobId, state);
      },
    }, 1, { submit });
    for (let attempt = 0; attempt < 100 && transitions.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(restored.get(jobId)).toMatchObject({
      status: "failed",
      executionClass: undefined,
      error: expect.stringContaining("Kandidatenarm-Autorität"),
      runProvenance: expect.any(Object),
    });
    expect(Reflect.get(restored, "queue")).toEqual([]);
    expect(Reflect.get(restored, "runningId")).toBeNull();
    expect(Reflect.get(restored, "activeRunPromise")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(transitions).toEqual([`${dgxJobId}:cancelled`]);
  });

  it.each([
    ["bekannte Lease", false],
    ["unklarer Submit ohne Lease-ID", true],
  ] as const)("awaits restored %s cleanup before a production-order experiment reconcile error escapes", async (
    _label,
    submitPending,
  ) => {
    const root = await mkdtemp(join(tmpdir(), "ltx-startup-experiment-reconcile-"));
    roots.push(root);
    const path = join(root, "jobs.json");
    const store = new ExperimentStore(join(root, "experiments"));
    const baselineRequest = validRequest("image-audio-to-video");
    baselineRequest.outputName = `startup-order-raw-baseline-${submitPending ? "pending" : "known"}.mp4`;
    baselineRequest.postprocess.lipForcing.enabled = true;
    const frozen = store.freeze(store.create({
      title: "Startup-Reihenfolge mit Remote-Lease",
      baselineRequest,
      candidate: { variable: "lipforcing-raw-output-profile" },
    }).id);
    store.attachJob(
      frozen.id,
      "baseline",
      "11111111-1111-4111-8111-111111111111",
    );
    const candidateBinding = store.bindingFor(frozen.id, "candidate");
    const candidateRequest = store.get(frozen.id)!.arms[1].request;
    const first = new JobManager(path, false);
    const created = first.create(candidateRequest, {
      experiment: candidateBinding,
      deferStart: true,
    });
    const dgxJobId = testDgxJobId(`startup-order-invalid-raw-${submitPending}`);
    const firstRuntimeJob = (Reflect.get(first, "jobs") as Map<string, Record<string, unknown>>)
      .get(created.id)!;
    firstRuntimeJob.runProvenance = runProvenance();
    const forgedDecision: JobExecutionDecision = {
      schemaVersion: "ltx-studio-execution-decision.v6",
      executionClass: "dgx",
      decidedAt: "2026-08-26T09:59:00.000Z",
      reason: "Forged historical raw-candidate DGX authority for startup rejection test.",
      requestSha256: experimentRequestSha256V1(candidateRequest),
      protocolSha256: candidateBinding.protocolSha256,
      cpuReuse: null,
      operation: null,
    };
    firstRuntimeJob.executionClass = "dgx";
    firstRuntimeJob.executionDecision = forgedDecision;
    firstRuntimeJob.runProvenance = bindRunExecutionDecision(
      firstRuntimeJob.runProvenance as RunProvenance,
      forgedDecision,
    );
    firstRuntimeJob.status = "running";
    firstRuntimeJob.startDeferred = false;
    firstRuntimeJob.startedAt = "2026-08-26T10:00:00.000Z";
    if (submitPending) {
      bindTestPendingDgxSubmit(
        firstRuntimeJob,
        created.id,
        candidateRequest,
        "2026-08-26T10:00:01.000Z",
      );
    } else {
      bindTestDgxLease(firstRuntimeJob, created.id, dgxJobId, candidateRequest);
    }
    (Reflect.get(first, "changed") as () => void).call(first);
    const stored = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    stored[0].experiment = {
      ...(stored[0].experiment as Record<string, unknown>),
      variableId: "lipforcing-decoder",
      changedRequestPaths: ["postprocess.lipForcing.decoder"],
    };
    await writeFile(path, JSON.stringify(stored));

    const transitions: string[] = [];
    let remoteState: "running" | "cancelled" = "running";
    const [candidateAdmission] = buildAdmissionRequests(candidateRequest, 58, created.id);
    const list = vi.fn(async () => authoritativeQueueList([
      queueListJobHintForAdmission(created.id, dgxJobId, "accepted", candidateAdmission),
    ]));
    const restored = new JobManager(path, false, null, undefined, {
      read: async (remoteJobId) => boundDgxRead(created.id, remoteJobId, remoteState),
      transition: async (remoteJobId, state) => {
        transitions.push(`${remoteJobId}:${state}`);
        remoteState = "cancelled";
        return boundDgxTransition(created.id, remoteJobId, state);
      },
    }, undefined, { submit: vi.fn(), list });

    await expect(reconcileExperimentsBeforeServerStart(restored, store, 1_000))
      .rejects.toThrow("passt nicht zum eingefrorenen Experimentprotokoll");
    expect(transitions).toEqual([`${dgxJobId}:cancelled`]);
    expect(restored.get(created.id)).toMatchObject({ status: "failed" });
    expect(Reflect.get(restored, "queue")).toEqual([]);
    expect(Reflect.get(restored, "runningId")).toBeNull();
    expect(Reflect.get(restored, "activeRunPromise")).toBeNull();
    expect(list).toHaveBeenCalledTimes(submitPending ? 1 : 0);
  });

  it("reconciles an ambiguous DGX submit for invalid restored raw authority and cancels without resubmit", async () => {
    const { path, jobId, admissionRequest } = await persistActiveRawDgxRestoreCase({
      dgxJobId: null,
      submitPending: true,
    });
    const dgxJobId = testDgxJobId("invalid-raw-ambiguous-submit");
    let remoteState: "running" | "cancelled" = "running";
    const list = vi.fn(async () => authoritativeQueueList([
      queueListJobHintForAdmission(jobId, dgxJobId, "accepted", admissionRequest),
    ]));
    const submit = vi.fn();
    const transitions: string[] = [];
    const restored = new JobManager(path, false, null, undefined, {
      read: async (remoteJobId) => boundDgxRead(jobId, remoteJobId, remoteState),
      transition: async (remoteJobId, state) => {
        transitions.push(`${remoteJobId}:${state}`);
        remoteState = "cancelled";
        return boundDgxTransition(jobId, remoteJobId, state);
      },
    }, 1, { submit, list });
    const internalJobs = Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>;
    for (let attempt = 0; attempt < 100
      && internalJobs.get(jobId)?.dgxSubmitPending !== undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const runtimeJob = internalJobs.get(jobId)!;
    expect(restored.get(jobId)).toMatchObject({
      status: "failed",
      dgxJobId,
      executionClass: undefined,
      error: expect.stringContaining("Kandidatenarm-Autorität"),
      runProvenance: expect.any(Object),
    });
    expect(runtimeJob.dgxSubmitPending).toBeUndefined();
    expect(runtimeJob.dgxSubmitStartedAt).toBeUndefined();
    expect(Reflect.get(restored, "queue")).toEqual([]);
    expect(Reflect.get(restored, "runningId")).toBeNull();
    expect(Reflect.get(restored, "activeRunPromise")).toBeNull();
    expect(submit).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(transitions).toEqual([`${dgxJobId}:cancelled`]);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted[0].dgxSubmitPending).toBeUndefined();
    expect(persisted[0].dgxSubmitStartedAt).toBeUndefined();
  });

  it("retries an adopted ambiguous raw lease after the first durable write fails", async () => {
    const { path, jobId, admissionRequest } = await persistActiveRawDgxRestoreCase({
      dgxJobId: null,
      submitPending: true,
    });
    const dgxJobId = testDgxJobId("invalid-raw-transient-persist");
    let remoteState: "running" | "cancelled" = "running";
    const list = vi.fn(async () => authoritativeQueueList([
      queueListJobHintForAdmission(jobId, dgxJobId, "accepted", admissionRequest),
    ]));
    const transitions: string[] = [];
    const restored = new JobManager(path, false, null, undefined, {
      read: async (remoteJobId) => boundDgxRead(jobId, remoteJobId, remoteState),
      transition: async (remoteJobId, state) => {
        transitions.push(`${remoteJobId}:${state}`);
        remoteState = "cancelled";
        return boundDgxTransition(jobId, remoteJobId, state);
      },
    }, 1, { submit: vi.fn(), list });
    const originalPersist = (Reflect.get(restored, "persist") as () => void).bind(restored);
    let injectedFailures = 0;
    Reflect.set(restored, "persist", () => {
      if (injectedFailures === 0) {
        injectedFailures += 1;
        throw new Error("synthetic one-shot terminal-reconcile persist failure");
      }
      originalPersist();
    });
    const internalJobs = Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>;
    for (let attempt = 0; attempt < 400
      && internalJobs.get(jobId)?.dgxSubmitPending !== undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const runtimeJob = internalJobs.get(jobId)!;
    expect(injectedFailures).toBe(1);
    expect(runtimeJob.dgxSubmitPending).toBeUndefined();
    expect(runtimeJob.dgxTerminalDelivery).toBeUndefined();
    expect(runtimeJob.dgxTerminalRetry).toBeUndefined();
    expect(transitions).toEqual([`${dgxJobId}:cancelled`]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(Reflect.get(restored, "queue")).toEqual([]);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted[0].dgxSubmitPending).toBeUndefined();
  });

  it("enters HOLD when positive Submit discovery has two exact active matches", async () => {
    const { path, jobId, admissionRequest } = await persistActiveRawDgxRestoreCase({
      dgxJobId: null,
      submitPending: true,
    });
    const firstDgxJobId = testDgxJobId("invalid-raw-duplicate-a");
    const secondDgxJobId = testDgxJobId("invalid-raw-duplicate-b");
    const states = new Map<string, "accepted" | "queued">([
      [firstDgxJobId, "accepted"],
      [secondDgxJobId, "queued"],
    ]);
    const list = vi.fn(async () => authoritativeQueueList(
      [...states].map(([remoteJobId, state]) => queueListJobHintForAdmission(
        jobId,
        remoteJobId,
        state,
        admissionRequest,
      )),
    ));
    const submit = vi.fn();
    const read = vi.fn();
    const transition = vi.fn();
    const restored = new JobManager(path, false, null, undefined, {
      read,
      transition,
    }, 1, { submit, list });
    for (let attempt = 0; attempt < 100
      && restored.persistenceHealth().status !== "hold"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(restored.persistenceHealth()).toMatchObject({
      status: "hold",
      restartRequired: true,
    });
    expect(submit).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("enters HOLD when Submit discovery contains a terminal caller collision", async () => {
    const fixedNow = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => fixedNow);
    const { path, jobId, admissionRequest } = await persistActiveRawDgxRestoreCase({
      dgxJobId: null,
      submitPending: true,
      submitStartedAt: new Date(fixedNow - 124_950).toISOString(),
    });
    const priorDgxJobId = testDgxJobId("invalid-raw-prior-terminal");
    const list = vi.fn(async () => authoritativeQueueList([
      queueListJobHintForAdmission(
        jobId,
        priorDgxJobId,
        "cancelled",
        admissionRequest,
      ),
    ]));
    const read = vi.fn();
    const transition = vi.fn();
    const restored = new JobManager(path, false, null, undefined, {
      read,
      transition,
    }, 1, { submit: vi.fn(), list });
    for (let attempt = 0; attempt < 100
      && restored.persistenceHealth().status !== "hold"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(restored.persistenceHealth()).toMatchObject({ status: "hold", restartRequired: true });
    expect(list).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("never clears an expired ambiguous Submit from authoritative queue absence", async () => {
    const { path, jobId } = await persistActiveRawDgxRestoreCase({
      dgxJobId: null,
      submitPending: true,
      submitStartedAt: new Date(Date.now() - 126_000).toISOString(),
    });
    const list = vi.fn(async () => authoritativeQueueList());
    const submit = vi.fn();
    const transition = vi.fn();
    const restored = new JobManager(path, false, null, undefined, {
      read: async (remoteJobId) => boundDgxRead(jobId, remoteJobId, "running"),
      transition,
    }, 1, { submit, list });
    const internalJobs = Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>;
    const runtimeJob = internalJobs.get(jobId)!;
    const pendingRetry = runtimeJob.dgxSubmitReconcileRetry as NodeJS.Timeout | undefined;
    if (pendingRetry) clearTimeout(pendingRetry);
    delete runtimeJob.dgxSubmitReconcileRetry;
    const reconcile = Reflect.get(restored, "reconcileTerminalPendingDgxSubmit") as (
      job: Record<string, unknown>,
    ) => Promise<void>;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await reconcile.call(restored, runtimeJob);
    }
    Reflect.set(restored, "shuttingDown", true);

    expect(internalJobs.get(jobId)?.dgxSubmitPending).toBe(true);
    expect(list.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(transition).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(Reflect.get(restored, "queue")).toEqual([]);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted[0].dgxSubmitPending).toBe(true);
  });

  it.each([
    { state: "held", seconds: 12, waiters: 1, holders: 1 },
    { state: "stalled", seconds: 45, waiters: 2, holders: 1 },
  ] satisfies QueueLockLaneSummary[])(
    "never concludes Submit absence while the queue lock lane is $state",
    async (lockLane) => {
      const { path, jobId } = await persistActiveRawDgxRestoreCase({
        dgxJobId: null,
        submitPending: true,
        submitStartedAt: new Date(Date.now() - 126_000).toISOString(),
      });
      const list = vi.fn(async () => authoritativeQueueList([], { lockLane }));
      const submit = vi.fn();
      const read = vi.fn();
      const transition = vi.fn();
      const restored = new JobManager(path, false, null, undefined, {
        read,
        transition,
      }, 1, { submit, list });
      const internalJobs = Reflect.get(restored, "jobs") as Map<string, Record<string, unknown>>;
      const runtimeJob = internalJobs.get(jobId)!;
      const pendingRetry = runtimeJob.dgxSubmitReconcileRetry as NodeJS.Timeout | undefined;
      if (pendingRetry) clearTimeout(pendingRetry);
      delete runtimeJob.dgxSubmitReconcileRetry;
      const reconcile = Reflect.get(restored, "reconcileTerminalPendingDgxSubmit") as (
        job: Record<string, unknown>,
      ) => Promise<void>;

      await reconcile.call(restored, runtimeJob);
      Reflect.set(restored, "shuttingDown", true);

      expect(list).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(transition).not.toHaveBeenCalled();
      expect(runtimeJob.dgxSubmitPending).toBe(true);
      expect(runtimeJob.dgxLeaseReceipt).toBeUndefined();
      const persisted = JSON.parse(await readFile(path, "utf8"));
      expect(persisted[0].dgxSubmitPending).toBe(true);
      expect(persisted[0].dgxLeaseReceipt).toBeUndefined();
    },
  );

  it("keeps an expired ambiguous submit pending when queue diagnostics are not authoritative", async () => {
    const path = await statePath();
    const list = vi.fn(async () => authoritativeQueueList([], { discardedJobLikeEntries: 1 }));
    const submit = vi.fn();
    const manager = new JobManager(
      path,
      false,
      null,
      undefined,
      undefined,
      null,
      { submit, list },
    );
    const created = manager.create(validRequest());
    manager.cancel(created.id);
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
    const runtimeJob = internalJobs.get(created.id)!;
    bindTestPendingDgxSubmit(
      runtimeJob,
      created.id,
      runtimeJob.request as ReturnType<typeof validRequest>,
      new Date(Date.now() - 126_000).toISOString(),
    );
    const reconcile = Reflect.get(manager, "reconcileTerminalPendingDgxSubmit") as (
      job: Record<string, unknown>,
    ) => Promise<void>;

    await reconcile.call(manager, runtimeJob);

    expect(runtimeJob.dgxSubmitPending).toBe(true);
    expect(runtimeJob.dgxSubmitStartedAt).toEqual(expect.any(String));
    expect(manager.experimentRetryAuthority(created.id)?.settlementPending).toBe(true);
    expect(manager.get(created.id)?.logs.join("\n")).toContain(
      "Terminaler DGX-Submit-Abgleich bleibt vorgemerkt",
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(submit).not.toHaveBeenCalled();
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted[0].dgxSubmitPending).toBe(true);
  });

  it("persists an exact project binding and rejects request drift or mixed authority", async () => {
    const path = await statePath();
    const request = validRequest("id-lora");
    request.models.distilledLora.path = "/models/project-bound-distilled-lora.safetensors";
    const binding = {
      schemaVersion: "ltx-studio-project-run.v1" as const,
      projectId: "44444444-4444-4444-8444-444444444444",
      projectRevision: 7,
      projectRevisionSha256: "a".repeat(64),
      shotId: "55555555-5555-4555-8555-555555555555",
      requestRevisionId: "66666666-6666-4666-8666-666666666666",
      requestSha256: projectValueSha256(request),
      continuity: null,
    };
    const manager = new JobManager(path, false);

    const created = manager.create(request, { project: binding });
    const restored = new JobManager(path, false);

    expect(created.project).toEqual(binding);
    expect(created.request.models.distilledLora.path).toBe(
      "/models/project-bound-distilled-lora.safetensors",
    );
    expect(restored.get(created.id)?.project).toEqual(binding);
    expect(restored.get(created.id)?.request.models.distilledLora.path).toBe(
      "/models/project-bound-distilled-lora.safetensors",
    );
    expect(restored.get(created.id)?.status).toBe("queued");

    const drifted = structuredClone(request);
    drifted.seed += 1;
    drifted.outputName = "project-drifted.mp4";
    expect(() => manager.create(drifted, { project: binding })).toThrow(
      "gebundenen Request-Revision",
    );
    expect(() => manager.create(request, {
      experiment: {
        schemaVersion: "ltx-studio-experiment-run.v1",
        experimentId: "77777777-7777-4777-8777-777777777777",
        protocolSha256: "b".repeat(64),
        arm: "baseline",
        kind: "ablation",
        variableId: "a2v-guidance",
        changedRequestPaths: ["videoGuidance.modalityScale"],
        baselineRequestSha256: "c".repeat(64),
        requestSha256: "c".repeat(64),
        baselineJobId: null,
        baselineOutputName: request.outputName,
      },
      project: binding,
    })).toThrow("gleichzeitig Experiment- und Projektlauf");

    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted[0].request.seed += 1;
    await writeFile(path, JSON.stringify(persisted));
    const broken = new JobManager(path, false);
    expect(broken.get(created.id)).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("Projektbindung"),
    });
    expect(Reflect.get(broken, "queue")).not.toContain(created.id);
  });

  it("bounds the persisted active queue", async () => {
    const manager = new JobManager(await statePath(), false);
    for (let index = 0; index < MAX_ACTIVE_JOBS; index += 1) {
      const request = validRequest();
      request.outputName = `queue-${index}.mp4`;
      manager.create(request);
    }
    const overflow = validRequest();
    overflow.outputName = "queue-overflow.mp4";
    expect(() => manager.create(overflow)).toThrow(`auf ${MAX_ACTIVE_JOBS} aktive Aufträge begrenzt`);
    expect(manager.list()).toHaveLength(MAX_ACTIVE_JOBS);
  });

  it("restores authority fields from the validated request", async () => {
    const path = await statePath();
    const request = validRequest();
    const id = "2c8a5dc6-8864-49f7-a639-85caef912345";
    await writeFile(path, JSON.stringify([{
      id,
      status: "failed",
      mode: "retake",
      prompt: "tampered",
      outputName: "../../outside.mp4",
      outputUrl: "/outside",
      createdAt: "invalid",
      startedAt: null,
      finishedAt: null,
      progress: 999,
      error: null,
      logs: ["valid", 42],
      command: "malicious command",
      request,
    }]));

    const restored = new JobManager(path, false).get(id)!;
    expect(restored.mode).toBe(request.mode);
    expect(restored.prompt).toBe(request.prompt);
    expect(restored.outputName).toBe(request.outputName);
    expect(restored.outputUrl).toBeNull();
    expect(restored.progress).toBe(95);
    expect(restored.logs).toEqual([
      "valid",
      expect.stringContaining("Legacy-Import v1.1"),
    ]);
    expect(restored.cancelledBy).toBeNull();
    expect(restored.command).toContain("ltx_pipelines.ti2vid_two_stages");
    expect(Number.isFinite(Date.parse(restored.createdAt))).toBe(true);

    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toHaveLength(1);
  });

  it("marks a persisted thermal pause interrupted after a Studio restart", async () => {
    const path = await statePath();
    const request = validRequest();
    await writeFile(path, JSON.stringify([{
      id: "2c8a5dc6-8864-49f7-a639-85caef916666",
      status: "paused",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: 42,
      error: null,
      logs: ["Thermalpause"],
      command: "ignored",
      request,
      localProcessProtocol: "fd-gate.v1",
      favorite: false,
      variantOf: null,
      runtimeMs: null,
    }]));
    const restored = new JobManager(path, false).list()[0];
    expect(restored.status).toBe("interrupted");
    expect(restored.error).toContain("Studio wurde während des Jobs neu gestartet");
  });

  it("restores an active remote lease with a durable cancellation delivery", async () => {
    const path = await statePath();
    const request = validRequest();
    const jobId = "2c8a5dc6-8864-49f7-a639-85caef916667";
    const dgxJobId = testDgxJobId("studio-restart");
    await writeFile(path, JSON.stringify([{
      id: jobId,
      status: "queued",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      logs: ["accepted lease"],
      command: "ignored",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: null,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId,
      dgxLeaseReceipt: testDgxLeaseReceipt(jobId, dgxJobId, request),
      identityEvidence: null,
      runProvenance: null,
    }]));
    const transitions: string[] = [];
    const restored = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (remoteJobId) => boundDgxRead(jobId, remoteJobId, "accepted"),
      transition: async (remoteJobId, state) => {
        transitions.push(state);
        return boundDgxTransition(jobId, remoteJobId, state);
      },
    }, null);
    const internalJobs = Reflect.get(restored, "jobs") as Map<string, unknown>;
    const restoredJob = internalJobs.get(jobId)!;
    const flush = Reflect.get(restored, "flushDgxTerminalDelivery") as (job: unknown) => Promise<boolean>;

    expect(restored.get(jobId)).toMatchObject({
      status: "interrupted",
      dgxJobId,
    });
    expect(restored.get(jobId)?.logs).toContain("Studio-Neustart: Remote-Queue-Lease wird als cancelled abgemeldet.");
    expect(await flush.call(restored, restoredJob)).toBe(true);
    expect(transitions).toEqual(["cancelled"]);
  });

  it("preserves a historic structured thermal threshold with its persisted pause boundary", async () => {
    const path = await statePath();
    const request = validRequest();
    await writeFile(path, JSON.stringify([{
      id: "2c8a5dc6-8864-49f7-a639-85caef917776",
      status: "cancelled",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progress: 60,
      error: null,
      logs: ["Historischer Lauf"],
      command: "ignored",
      request,
      favorite: false,
      variantOf: null,
      runtimeMs: 10_000,
      thermalProfile: {
        baselineC: 95,
        currentC: null,
        peakC: 101,
        riseC: 6,
        pauseAtC: 100,
        updatedAt: "2026-08-01T10:00:00.000Z",
      },
    }]));

    const restored = new JobManager(path, false).list()[0];

    expect(restored.thermalProfile).toMatchObject({
      baselineC: 95,
      pauseAtC: 100,
      resumeBelowC: 95.1,
    });
  });

  it("migrates historic thermal log lines into structured GUI data", async () => {
    const path = await statePath();
    const request = validRequest();
    await writeFile(path, JSON.stringify([{
      id: "2c8a5dc6-8864-49f7-a639-85caef917777",
      status: "cancelled",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progress: null,
      error: null,
      logs: [
        "Abbruch angefordert.",
        "Thermalprofil (gesamter Host): Basis 42.8 °C, Peak 67.9 °C, beobachteter Anstieg 25.1 °C.",
      ],
      command: "ignored",
      request,
      favorite: false,
      variantOf: null,
      runtimeMs: 10_000,
    }]));

    const restored = new JobManager(path, false).list()[0];
    expect(restored.cancelledBy).toBe("studio");
    expect(restored.thermalProfile).toMatchObject({
      baselineC: 42.8,
      peakC: 67.9,
      riseC: 25.1,
      pauseAtC: 90,
      resumeBelowC: 42.9,
    });
  });
});
