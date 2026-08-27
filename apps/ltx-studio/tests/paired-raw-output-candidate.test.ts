import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, readFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hybridRoot, outputRoot, repoRoot } from "../server/config.js";
import {
  captureLipForcingImageIdentity,
  LIPFORCING_IMAGE_ARTIFACT_PATHS,
  LIPFORCING_IMAGE_PATCH_SET_ID,
  LIPFORCING_IMAGE_SOURCE_REVISION,
} from "../server/dockerImageIdentity.js";
import { JobManager, type StudioJob } from "../server/jobs.js";
import { notApplicableIdentityEvidence } from "../server/inputEvidence.js";
import {
  outputPublicationPath,
  readValidOutputPublicationAuthority,
} from "../server/outputPublication.js";
import {
  captureRawMuxPairFile,
  type RawMuxBaselineAuthority,
} from "../server/rawMuxBaselineAuthority.js";
import { bindRunProvenanceFile } from "../server/runProvenance.js";
import { bootstrapJobStartEnforcer } from "../server/startEnforcer.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import type { CpuOperationState, JobExecutionDecision } from "../shared/jobExecution.js";
import type { ExperimentRunBinding } from "../shared/experiments.js";
import type { RunProvenance } from "../shared/provenance.js";
import { experimentRequestSha256V1 } from "../server/experimentDigest.js";
import { validRequest } from "./fixtures.js";
import { publishCompletedOutputFixture } from "./output-publication-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runProvenance(): RunProvenance {
  return {
    schemaVersion: "ltx-studio-run-provenance.v1",
    capturedAt: "2026-08-26T10:00:00.000Z",
    verifiedAt: "2026-08-26T10:00:01.000Z",
    files: [],
    code: [{
      repositoryRoot: repoRoot,
      commit: "a".repeat(40),
      dirty: false,
      trackedDiffSha256: "b".repeat(64),
      untracked: [],
      fingerprint: "c".repeat(64),
    }],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "test",
      nodeVersion: "test",
      pythonExecutable: "/python-that-must-not-run",
      pythonVersion: "test",
      packages: {},
      ffmpegVersion: "test",
      fingerprint: "d".repeat(64),
    },
    fingerprint: "e".repeat(64),
  };
}

function testLipForcingContainerIdentity() {
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
  return captureLipForcingImageIdentity("ltx-studio-lipforcing:test", {
    inspect: () => ({
      id: `sha256:${"a".repeat(64)}`,
      repoDigests: [],
      labels: {
        "org.opencontainers.image.revision": LIPFORCING_IMAGE_SOURCE_REVISION,
        "com.moddy.ltx-studio.lipforcing.patchset": LIPFORCING_IMAGE_PATCH_SET_ID,
      },
    }),
    copyArtifacts: () => new Map([...copied].map(([path, bytes]) => [path, Buffer.from(bytes)])),
  }, { rawOutputMux, containerRunner, runtimePatchProvenance });
}

type RuntimeJobHarness = StudioJob & {
  plan: { outputPath: string };
  process?: unknown;
  localProcessGroupPending?: boolean;
};

type RouteFixture = {
  manager: JobManager;
  statePath: string;
  baseline: RuntimeJobHarness;
  candidate: RuntimeJobHarness;
  authority: RawMuxBaselineAuthority;
  authorityBinding: ReturnType<typeof captureRawMuxPairFile>;
  candidateFinalBytes: string;
  persistedOperationStates: CpuOperationState[];
  operationStates: CpuOperationState[];
  spies: Record<string, ReturnType<typeof vi.fn>>;
  run(): Promise<void>;
};

async function writeBoundFile(path: string, bytes: string) {
  await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o400);
  return captureRawMuxPairFile(path);
}

async function routeFixture(runtimeTrust: () => void = vi.fn()): Promise<RouteFixture> {
  const root = await mkdtemp(join(tmpdir(), "ltx-paired-candidate-route-"));
  roots.push(root);
  const statePath = join(root, "jobs.json");
  const spies = {
    identityCapture: vi.fn(async () => notApplicableIdentityEvidence()),
    identityVerify: vi.fn(async (evidence) => ({ evidence, error: null })),
    queueRead: vi.fn(async () => { throw new Error("DGX read must not run"); }),
    queueTransition: vi.fn(async () => { throw new Error("DGX transition must not run"); }),
    queueHeartbeat: vi.fn(async () => { throw new Error("DGX heartbeat must not run"); }),
    admissionSubmit: vi.fn(async () => { throw new Error("DGX submit must not run"); }),
    admissionList: vi.fn(async () => { throw new Error("DGX list must not run"); }),
    provenanceCapture: vi.fn(async () => { throw new Error("Python/Docker provenance capture must not run"); }),
    provenanceVerify: vi.fn(async () => { throw new Error("Python/Docker provenance verify must not run"); }),
    provenanceBind: vi.fn(bindRunProvenanceFile),
    schedulerDecide: vi.fn(async () => { throw new Error("DGX scheduler must not run"); }),
    inventoryRead: vi.fn(async () => { throw new Error("DGX model inventory must not run"); }),
    spawnBoundProcess: vi.fn(() => { throw new Error("No process may be spawned"); }),
    runLoggedProcess: vi.fn(async () => { throw new Error("No Python/Docker process may run"); }),
  };
  const manager = new JobManager(
    statePath,
    false,
    null,
    { capture: spies.identityCapture, verify: spies.identityVerify } as never,
    {
      read: spies.queueRead,
      transition: spies.queueTransition,
      heartbeat: spies.queueHeartbeat,
    } as never,
    null,
    { submit: spies.admissionSubmit, list: spies.admissionList } as never,
    {
      capture: spies.provenanceCapture,
      verify: spies.provenanceVerify,
      bindFile: spies.provenanceBind,
    } as never,
    { decide: spies.schedulerDecide } as never,
    { read: spies.inventoryRead } as never,
    bootstrapJobStartEnforcer(false),
    runtimeTrust,
  );
  Reflect.set(manager, "spawnBoundProcess", spies.spawnBoundProcess);
  Reflect.set(manager, "runLoggedProcess", spies.runLoggedProcess);

  const experimentId = "22222222-2222-4222-8222-222222222222";
  const protocolSha256 = "f".repeat(64);
  const prefix = `paired-route-${randomUUID()}`;
  const baselineRequest = validRequest("image-audio-to-video");
  baselineRequest.outputName = `${prefix}-exp-22222222-a.mp4`;
  baselineRequest.postprocess.lipForcing.enabled = true;
  const baselineRequestSha256 = experimentRequestSha256V1(baselineRequest);
  const baselineBinding: ExperimentRunBinding = {
    schemaVersion: "ltx-studio-experiment-run.v1",
    experimentId,
    protocolSha256,
    arm: "baseline",
    kind: "ablation",
    variableId: "lipforcing-raw-output-profile",
    changedRequestPaths: ["postprocess.lipForcing.rawOutputProfile"],
    baselineRequestSha256,
    requestSha256: baselineRequestSha256,
    baselineJobId: null,
    baselineOutputName: baselineRequest.outputName,
  };
  const createdBaseline = manager.create(baselineRequest, {
    experiment: baselineBinding,
    deferStart: true,
  });
  const jobs = Reflect.get(manager, "jobs") as Map<string, RuntimeJobHarness>;
  const baseline = jobs.get(createdBaseline.id)!;
  await Promise.all([
    mkdir(outputRoot, { recursive: true }),
    mkdir(hybridRoot, { recursive: true }),
  ]);
  await writeFile(baseline.plan.outputPath, "published paired baseline bytes", { mode: 0o400, flag: "wx" });
  await chmod(baseline.plan.outputPath, 0o400);
  baseline.status = "completed";
  baseline.startedAt = "2026-08-26T10:00:00.000Z";
  baseline.finishedAt = "2026-08-26T10:01:00.000Z";
  baseline.progress = 100;
  const image = testLipForcingContainerIdentity();
  baseline.runProvenance = { ...runProvenance(), containerImages: [image] };
  baseline.executionClass = undefined;
  baseline.executionDecision = undefined;
  publishCompletedOutputFixture(outputRoot, baseline);
  baseline.runProvenance = {
    ...baseline.runProvenance!,
    verifiedAt: "2026-08-26T10:00:30.000Z",
  };

  const candidateRequest = structuredClone(baselineRequest);
  candidateRequest.outputName = `${prefix}-exp-22222222-b.mp4`;
  candidateRequest.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
  const candidateRequestSha256 = experimentRequestSha256V1(candidateRequest);
  const createdCandidate = manager.create(candidateRequest, {
    experiment: {
      ...baselineBinding,
      arm: "candidate",
      requestSha256: candidateRequestSha256,
      baselineJobId: baseline.id,
    },
    deferStart: true,
  });
  const candidate = jobs.get(createdCandidate.id)!;

  for (const path of [
    baseline.plan.outputPath,
    outputPublicationPath(baseline.plan.outputPath),
    candidate.plan.outputPath,
    outputPublicationPath(candidate.plan.outputPath),
    join(hybridRoot, candidate.id),
  ]) roots.push(path);

  const evidenceRoot = join(root, "pair-authority");
  await mkdir(evidenceRoot, { mode: 0o700 });
  const candidateFinalBytes = "exact sealed candidate-final bytes";
  const evidenceFiles = {
    preMux: await writeBoundFile(join(evidenceRoot, "pre-mux-crf13.mp4"), "pre-mux"),
    preMuxReceipt: await writeBoundFile(join(evidenceRoot, "pre-mux-receipt.json"), "pre-mux receipt"),
    baselineRaw: await writeBoundFile(join(evidenceRoot, "baseline-raw.mp4"), "baseline raw"),
    candidateRaw: await writeBoundFile(join(evidenceRoot, "candidate-raw.mp4"), "candidate raw"),
    candidateFinal: await writeBoundFile(join(evidenceRoot, "candidate-final.mp4"), candidateFinalBytes),
    receipt: await writeBoundFile(join(evidenceRoot, "pair-receipt.json"), "pair receipt"),
    timelineReceipt: await writeBoundFile(join(evidenceRoot, "timeline-receipt.json"), "timeline receipt"),
    ltxBase: await writeBoundFile(join(evidenceRoot, "ltx-base.mp4"), "ltx base"),
    controlAudio: await writeBoundFile(join(evidenceRoot, "control.wav"), "control audio"),
    programAudio: await writeBoundFile(join(evidenceRoot, "program.wav"), "program audio"),
    baselineFinal: captureRawMuxPairFile(baseline.plan.outputPath),
  };
  const authorityBase: Omit<RawMuxBaselineAuthority, "fingerprint"> = {
    schemaVersion: "ltx-studio-raw-mux-baseline-authority.v1",
    createdAt: "2026-08-26T10:01:00.000Z",
    experimentId,
    protocolSha256,
    baselineJobId: baseline.id,
    baselineOutputName: baseline.outputName,
    baselineRequestSha256,
    candidateRequestSha256,
    containerImageFingerprint: image.fingerprint,
    mouthDelayMs: baseline.request.postprocess.lipForcing.mouthDelayMs,
    programAudioDelayMs: baseline.request.postprocess.lipForcing.programAudioDelayMs,
    rawOutputProfiles: {
      baseline: "h264-crf13-mux-crf18-v1",
      candidate: "h264-crf13-mux-copy-v1",
    },
    files: evidenceFiles,
  };
  const authority: RawMuxBaselineAuthority = {
    ...authorityBase,
    fingerprint: createHash("sha256").update(canonicalJson(authorityBase)).digest("hex"),
  };
  const authorityPath = join(evidenceRoot, "baseline-authority.v1.json");
  await writeFile(authorityPath, `${JSON.stringify(authority, null, 2)}\n`, { mode: 0o400, flag: "wx" });
  await chmod(authorityPath, 0o400);
  const authorityBinding = captureRawMuxPairFile(authorityPath);

  Reflect.set(manager, "rawOutputPairAuthority", vi.fn(() => ({
    authority,
    authorityBinding,
    baselineRunProvenance: baseline.runProvenance,
    baselineProvenanceFingerprint: baseline.runProvenance!.fingerprint,
    error: null,
  })));

  const operationStates: CpuOperationState[] = [];
  const persistedOperationStates: CpuOperationState[] = [];
  const commit = Reflect.get(manager, "commitExecutionDecision") as (
    job: RuntimeJobHarness,
    decision: JobExecutionDecision,
  ) => boolean;
  Reflect.set(manager, "commitExecutionDecision", (
    job: RuntimeJobHarness,
    decision: JobExecutionDecision,
  ) => {
    const committed = commit.call(manager, job, decision);
    if (committed
      && decision.executionClass === "cpu-only"
      && decision.operation.kind === "paired-artifact-promotion") {
      operationStates.push(decision.operation.state);
      const persisted = JSON.parse(readFileSync(statePath, "utf8")) as StudioJob[];
      const persistedDecision = persisted.find(({ id }) => id === job.id)?.executionDecision;
      if (persistedDecision?.executionClass === "cpu-only"
        && persistedDecision.operation.kind === "paired-artifact-promotion") {
        persistedOperationStates.push(persistedDecision.operation.state);
      }
    }
    return committed;
  });

  return {
    manager,
    statePath,
    baseline,
    candidate,
    authority,
    authorityBinding,
    candidateFinalBytes,
    operationStates,
    persistedOperationStates,
    spies,
    run: async () => {
      const run = Reflect.get(manager, "run") as (job: RuntimeJobHarness) => Promise<void>;
      await run.call(manager, candidate);
    },
  };
}

function expectNoDgxOrProcessOperations(fixture: RouteFixture): void {
  for (const name of [
    "queueRead",
    "queueTransition",
    "queueHeartbeat",
    "admissionSubmit",
    "admissionList",
    "schedulerDecide",
    "inventoryRead",
    "provenanceCapture",
    "provenanceVerify",
    "spawnBoundProcess",
    "runLoggedProcess",
  ] as const) {
    expect(fixture.spies[name], `${name} must remain unused`).not.toHaveBeenCalled();
  }
  expect(fixture.candidate.dgxJobId).toBeNull();
  expect(fixture.candidate.process).toBeUndefined();
  expect(fixture.candidate.localProcessGroupPending).toBeUndefined();
}

async function expectNoPublicCandidate(fixture: RouteFixture): Promise<void> {
  await expect(access(fixture.candidate.plan.outputPath)).rejects.toThrow();
  await expect(access(outputPublicationPath(fixture.candidate.plan.outputPath))).rejects.toThrow();
  const publicTemps = (await readdir(outputRoot)).filter((name) =>
    name.includes(fixture.candidate.id) || name.startsWith(`.${fixture.candidate.outputName}`));
  expect(publicTemps).toEqual([]);
}

describe("paired raw-output candidate production route", () => {
  it("persists prepared/running/succeeded and publishes the exact snapshot without DGX, Docker, Python or spawn", async () => {
    const fixture = await routeFixture();

    await fixture.run();

    expect(fixture.manager.get(fixture.candidate.id)).toMatchObject({
      status: "completed",
      executionClass: "cpu-only",
      dgxJobId: null,
      executionDecision: {
        schemaVersion: "ltx-studio-execution-decision.v6",
        executionClass: "cpu-only",
        operation: {
          kind: "paired-artifact-promotion",
          state: "succeeded",
          exitCode: 0,
        },
      },
    });
    expect(fixture.operationStates).toEqual(["prepared", "running", "succeeded"]);
    expect(fixture.persistedOperationStates).toEqual(["prepared", "running", "succeeded"]);
    await expect(readFile(fixture.candidate.plan.outputPath, "utf8"))
      .resolves.toBe(fixture.candidateFinalBytes);
    const published = await stat(fixture.candidate.plan.outputPath);
    expect(published.mode & 0o7777).toBe(0o400);
    expect(published.nlink).toBe(1);
    expect(readValidOutputPublicationAuthority(outputRoot, fixture.candidate.outputName))
      .toMatchObject({ jobId: fixture.candidate.id, state: "published" });
    expect((await readdir(join(hybridRoot, fixture.candidate.id)))
      .some((name) => name.endsWith(".tmp.mp4"))).toBe(false);
    expect(fixture.spies.provenanceBind).toHaveBeenCalledTimes(6);
    expect(fixture.spies.identityCapture).toHaveBeenCalledTimes(1);
    expect(fixture.spies.identityVerify).toHaveBeenCalledTimes(2);
    expectNoDgxOrProcessOperations(fixture);
  });

  it("fails before classification when the sealed source drifts before snapshot copy", async () => {
    const fixture = await routeFixture();
    await chmod(fixture.authority.files.candidateFinal.path, 0o600);
    appendFileSync(fixture.authority.files.candidateFinal.path, "drift-before-snapshot");

    await fixture.run();

    expect(fixture.manager.get(fixture.candidate.id)).toMatchObject({
      status: "failed",
      executionClass: "pending",
      error: expect.stringContaining("gesnapshottet"),
    });
    expect(fixture.operationStates).toEqual([]);
    await expectNoPublicCandidate(fixture);
    expectNoDgxOrProcessOperations(fixture);
  });

  it("detects snapshot drift after the private copy and quarantines every unreleased byte", async () => {
    const fixture = await routeFixture();
    const terminalize = Reflect.get(fixture.manager, "terminalizeCpuOperation") as (
      job: RuntimeJobHarness,
      state: CpuOperationState,
      ...rest: unknown[]
    ) => boolean;
    Reflect.set(fixture.manager, "terminalizeCpuOperation", (
      job: RuntimeJobHarness,
      state: CpuOperationState,
      ...rest: unknown[]
    ) => {
      const result = terminalize.call(fixture.manager, job, state, ...rest);
      if (result && state === "succeeded") {
        const snapshot = join(hybridRoot, fixture.candidate.id, "raw-mux-pair-reuse", "candidate-final.mp4");
        chmodSync(snapshot, 0o600);
        appendFileSync(snapshot, "drift-after-private-copy");
      }
      return result;
    });

    await fixture.run();

    expect(fixture.manager.get(fixture.candidate.id)).toMatchObject({
      status: "failed",
      executionClass: "cpu-only",
      executionDecision: {
        schemaVersion: "ltx-studio-execution-decision.v6",
        operation: { kind: "paired-artifact-promotion", state: "succeeded" },
      },
      error: expect.stringContaining("Snapshot"),
    });
    expect(fixture.operationStates).toEqual(["prepared", "running", "succeeded"]);
    await expectNoPublicCandidate(fixture);
    await expect(readFile(join(hybridRoot, fixture.candidate.id, "unreleased-output.mp4"), "utf8"))
      .resolves.toBe(fixture.candidateFinalBytes);
    expectNoDgxOrProcessOperations(fixture);
  });

  it("revokes the marker and quarantines the public inode if publication authority persistence fails", async () => {
    const fixture = await routeFixture();
    Reflect.set(fixture.manager, "buildPublicationAuthority", () => {
      throw new Error("synthetic publication-authority failure");
    });

    await fixture.run();

    expect(fixture.manager.get(fixture.candidate.id)).toMatchObject({
      status: "failed",
      executionClass: "cpu-only",
      executionDecision: {
        schemaVersion: "ltx-studio-execution-decision.v6",
        operation: { kind: "paired-artifact-promotion", state: "succeeded" },
      },
      error: expect.stringContaining("Publikationsautorität"),
    });
    await expectNoPublicCandidate(fixture);
    await expect(readFile(join(hybridRoot, fixture.candidate.id, "unreleased-output.mp4"), "utf8"))
      .resolves.toBe(fixture.candidateFinalBytes);
    expectNoDgxOrProcessOperations(fixture);
  });
});
