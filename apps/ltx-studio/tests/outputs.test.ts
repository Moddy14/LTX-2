import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { appendFile, link, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { StudioJob } from "../server/jobs.js";
import type { RunProvenance } from "../shared/provenance.js";
import type { ProjectRunBinding } from "../shared/projects.js";
import { writeOutputAnalysis } from "../server/analysisStore.js";
import { sha256Json } from "../server/experimentStore.js";
import {
  OutputLibrary,
  OutputSnapshotCapacityError,
  OutputSnapshotMaterializationError,
} from "../server/outputs.js";
import {
  createVerifiedOutputSnapshot,
  outputPublicationPath,
  persistOutputPublicationAuthority,
  prepareOutputPublicationAuthority,
  terminalJobAuthoritySha256,
} from "../server/outputPublication.js";
import { bindRunExecutionDecision } from "../server/runProvenance.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { isLegacyDfrRequest, migrateGenerationRequest } from "../shared/pipelines.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-outputs-"));
  roots.push(root);
  return root;
}

function snapshotOutputTree(root: string): Record<string, string> {
  return Object.fromEntries(
    (readdirSync(root, { recursive: true }) as string[])
      .sort()
      .map((relativePath) => {
        const absolutePath = join(root, relativePath);
        const stats = lstatSync(absolutePath);
        if (stats.isDirectory()) return [relativePath, "directory"];
        if (stats.isSymbolicLink()) return [relativePath, `symlink:${readlinkSync(absolutePath)}`];
        return [
          relativePath,
          `file:${createHash("sha256").update(readFileSync(absolutePath)).digest("hex")}`,
        ];
      }),
  );
}

function completedJob(
  outputName: string,
  finishedAt: string,
  mode: Parameters<typeof validRequest>[0] = "two-stage",
): StudioJob {
  const request = validRequest(mode);
  request.outputName = outputName;
  return {
    id: "2c8a5dc6-8864-49f7-a639-85caef918888",
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName,
    outputUrl: `/api/jobs/2c8a5dc6-8864-49f7-a639-85caef918888/output`,
    createdAt: finishedAt,
    startedAt: finishedAt,
    finishedAt,
    progress: 100,
    error: null,
    logs: [],
    command: "python -m ltx_pipelines.ti2vid_two_stages",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: 1000,
    cancelledBy: null,
    dgxJobId: null,
    thermalProfile: null,
    identityEvidence: null,
    runProvenance: null,
  };
}

function runProvenance(): RunProvenance {
  return {
    schemaVersion: "ltx-studio-run-provenance.v1",
    capturedAt: "2026-07-24T09:30:00.000Z",
    verifiedAt: "2026-07-24T09:35:00.000Z",
    files: [{
      role: "input:conditioning-audio",
      path: "/inputs/speech.wav",
      kind: "file",
      sizeBytes: 1024,
      modifiedAtMs: 1_721_813_400_000,
      changedAtMs: 1_721_813_400_001,
      fileId: "123",
      sha256: "a".repeat(64),
      entries: [],
    }],
    code: [{
      repositoryRoot: "/repo",
      commit: "b".repeat(40),
      dirty: false,
      trackedDiffSha256: "c".repeat(64),
      untracked: [],
      fingerprint: "d".repeat(64),
    }],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "test",
      nodeVersion: "test",
      pythonExecutable: "/python",
      pythonVersion: "3.12",
      packages: { torch: "test" },
      ffmpegVersion: "test",
      fingerprint: "e".repeat(64),
    },
    fingerprint: "f".repeat(64),
  };
}

function v2RunProvenance(): RunProvenance {
  return {
    ...runProvenance(),
    schemaVersion: "ltx-studio-run-provenance.v2",
    upstreamContracts: [],
    release: {
      sealed: false,
      verified: false,
      releaseDigest: null,
      manifestSha256: null,
      surfaceDigest: null,
      sourceCommit: null,
      runtimeInstallSealSha256: null,
      runtimeTreeSha256: null,
      runtimePolicySha256: null,
      nodeExecutableSha256: null,
      expectedHostTcbAttestationSha256: null,
    },
  };
}

function publishCompletedJob(root: string, job: StudioJob): void {
  if (!job.finishedAt) throw new Error("fixture requires terminal time");
  const decision = job.executionDecision ?? {
    schemaVersion: "ltx-studio-execution-decision.v5" as const,
    executionClass: "dgx" as const,
    decidedAt: job.startedAt ?? job.createdAt,
    reason: "Fixture DGX decision persisted before publication.",
    requestSha256: createHash("sha256").update(canonicalJson(job.request)).digest("hex"),
    protocolSha256: job.experiment?.protocolSha256 ?? null,
    cpuReuse: null,
    operation: null,
  };
  if (decision.executionClass === "pending") throw new Error("fixture cannot publish pending");
  job.executionClass = decision.executionClass;
  job.executionDecision = decision;
  const provenance = job.runProvenance ?? runProvenance();
  const verifiedAt = provenance.verifiedAt;
  job.runProvenance = bindRunExecutionDecision(provenance, decision);
  job.runProvenance.verifiedAt = verifiedAt;
  const executionDecisionSha256 = createHash("sha256").update(canonicalJson(decision)).digest("hex");
  const jobPersistenceRevision = randomUUID();
  const jobAuthoritySha256 = terminalJobAuthoritySha256({
    jobId: job.id,
    status: "completed",
    outputName: job.outputName,
    finishedAt: job.finishedAt,
    executionClass: decision.executionClass,
    executionDecisionSha256,
    requestSha256: decision.requestSha256,
    protocolSha256: decision.protocolSha256,
    jobPersistenceRevision,
  });
  job.outputPublication = prepareOutputPublicationAuthority(join(root, job.outputName), {
    jobId: job.id,
    publishedAt: job.finishedAt,
    executionDecisionSha256,
    jobPersistenceRevision,
    jobAuthoritySha256,
  });
  persistOutputPublicationAuthority(join(root, job.outputName), {
    jobId: job.id,
    publishedAt: job.finishedAt,
    executionDecisionSha256,
    jobPersistenceRevision,
    jobAuthoritySha256,
  }, {}, job.outputPublication);
}

function projectRunBinding(requestSha256: string): ProjectRunBinding {
  return {
    schemaVersion: "ltx-studio-project-run.v1",
    projectId: "11111111-1111-4111-8111-111111111111",
    projectRevision: 2,
    projectRevisionSha256: "1".repeat(64),
    shotId: "22222222-2222-4222-8222-222222222222",
    requestRevisionId: "55555555-5555-4555-8555-555555555555",
    requestSha256,
    continuity: null,
  };
}

describe("generated output library", () => {
  it("closes the transferred modern source FD when anonymous snapshot allocation repeatedly fails", async () => {
    const root = await outputRoot();
    const outputName = "snapshot-allocation-failure.mp4";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "allocation failure source bytes");
    const authority = prepareOutputPublicationAuthority(outputPath, {
      jobId: "2c8a5dc6-8864-49f7-a639-85caef918888",
      publishedAt: "2026-08-25T10:00:00.000Z",
      executionDecisionSha256: "1".repeat(64),
      jobPersistenceRevision: "11111111-1111-4111-8111-111111111111",
      jobAuthoritySha256: "2".repeat(64),
    });
    const missingSnapshotRoot = join(root, "missing", "snapshot-root");
    const descriptorsBefore = readdirSync("/proc/self/fd").length;

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const sourceFd = openSync(outputPath, "r");
      expect(() => createVerifiedOutputSnapshot({
        authority,
        fd: sourceFd,
        outputPath,
      }, missingSnapshotRoot)).toThrow();
      expect(() => fstatSync(sourceFd)).toThrow();
    }
    expect(readdirSync("/proc/self/fd").length).toBe(descriptorsBefore);
  });

  it("reports modern snapshot storage failure as a redacted retryable API error", async () => {
    const root = await outputRoot();
    const outputName = "snapshot-storage-failure.mp4";
    await writeFile(join(root, outputName), "authorized source bytes");
    const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(root, job);
    for (const code of ["ENOSPC", "ENOENT", "EFBIG", "ENOMEM", "EACCES", "EROFS"]) {
      const storageFailure = Object.assign(
        new Error(`${code} at secret snapshot path ${root}`),
        { code },
      );
      const library = new OutputLibrary(root, {
        openAnonymousReadableSnapshot: () => { throw storageFailure; },
      });

      let exposed: unknown;
      try {
        library.openReadableOutput(outputName, [job], job.id);
      } catch (error) {
        exposed = error;
      }
      expect(exposed).toBeInstanceOf(OutputSnapshotMaterializationError);
      expect(exposed).toMatchObject({
        statusCode: 503,
        retryAfterSeconds: 1,
        cause: storageFailure,
      });
      expect((exposed as Error).message).not.toContain(root);
    }

    await writeFile(join(root, outputName), "malicious source bytes!");
    expect(new OutputLibrary(root).openReadableOutput(outputName, [job], job.id)).toBeNull();
  });

  it("closes an uninstalled snapshot candidate when its identity stat fails", async () => {
    const root = await outputRoot();
    const outputName = "snapshot-install-stat-failure.mp4";
    await writeFile(join(root, outputName), "candidate ownership bytes");
    const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(root, job);
    const statFailure = Object.assign(new Error("synthetic candidate fstat EIO"), { code: "EIO" });
    let candidateFd: number | null = null;
    const library = new OutputLibrary(root, {
      statReadableSnapshotFd: (descriptor) => {
        candidateFd = descriptor;
        throw statFailure;
      },
    });

    let exposed: unknown;
    try {
      library.openReadableOutput(outputName, [job], job.id);
    } catch (error) {
      exposed = error;
    }
    expect(exposed).toBeInstanceOf(OutputSnapshotMaterializationError);
    expect(exposed).toMatchObject({ cause: statFailure, statusCode: 503, retryAfterSeconds: 1 });
    expect(candidateFd).not.toBeNull();
    expect(() => fstatSync(candidateFd!)).toThrow();
  });

  it.each(["EMFILE", "ENFILE", "EIO"])(
    "reports an immediate response-FD open %s as retryable and closes the installed master",
    async (code) => {
      const root = await outputRoot();
      const outputName = `response-open-${code.toLowerCase()}.mp4`;
      await writeFile(join(root, outputName), "response duplicate source bytes");
      const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
      publishCompletedJob(root, job);
      const failure = Object.assign(new Error(`${code} at private proc descriptor`), { code });
      let masterFd: number | null = null;
      const library = new OutputLibrary(root, {
        statReadableSnapshotFd: (descriptor) => {
          masterFd = descriptor;
          return fstatSync(descriptor);
        },
        duplicateReadableSnapshotFd: () => { throw failure; },
      });

      let exposed: unknown;
      try {
        library.openReadableOutput(outputName, [job], job.id);
      } catch (error) {
        exposed = error;
      }
      expect(exposed).toBeInstanceOf(OutputSnapshotMaterializationError);
      expect(exposed).toMatchObject({ cause: failure, statusCode: 503, retryAfterSeconds: 1 });
      expect((exposed as Error).message).not.toContain("private proc descriptor");
      expect(masterFd).not.toBeNull();
      expect(() => fstatSync(masterFd!)).toThrow();
    },
  );

  it.each(["EMFILE", "ENFILE", "EIO"])(
    "reports an immediate response-FD fstat %s as retryable without leaking either descriptor",
    async (code) => {
      const root = await outputRoot();
      const outputName = `response-fstat-${code.toLowerCase()}.mp4`;
      await writeFile(join(root, outputName), "response fstat source bytes");
      const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
      publishCompletedJob(root, job);
      const failure = Object.assign(new Error(`${code} at private duplicate descriptor`), { code });
      let masterFd: number | null = null;
      let responseFd: number | null = null;
      const library = new OutputLibrary(root, {
        statReadableSnapshotFd: (descriptor) => {
          masterFd = descriptor;
          return fstatSync(descriptor);
        },
        duplicateReadableSnapshotFd: (descriptor) => {
          responseFd = openSync(`/proc/self/fd/${descriptor}`, "r");
          return responseFd;
        },
        statReadableSnapshotDuplicateFd: () => { throw failure; },
      });

      let exposed: unknown;
      try {
        library.openReadableOutput(outputName, [job], job.id);
      } catch (error) {
        exposed = error;
      }
      expect(exposed).toBeInstanceOf(OutputSnapshotMaterializationError);
      expect(exposed).toMatchObject({ cause: failure, statusCode: 503, retryAfterSeconds: 1 });
      expect((exposed as Error).message).not.toContain("private duplicate descriptor");
      expect(masterFd).not.toBeNull();
      expect(responseFd).not.toBeNull();
      expect(() => fstatSync(masterFd!)).toThrow();
      expect(() => fstatSync(responseFd!)).toThrow();
    },
  );

  it.each([
    ["open", "EMFILE"],
    ["open", "ENFILE"],
    ["open", "EIO"],
    ["fstat", "EMFILE"],
    ["fstat", "ENFILE"],
    ["fstat", "EIO"],
  ] as const)(
    "keeps a valid cached master after a response-FD %s %s and retries without rebuilding",
    async (phase, code) => {
      const root = await outputRoot();
      const outputName = `cached-response-${phase}-${code.toLowerCase()}.mp4`;
      const outputPath = join(root, outputName);
      await writeFile(outputPath, "cached response duplicate bytes");
      const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
      publishCompletedJob(root, job);
      const failure = Object.assign(new Error(`${code} at private cached descriptor`), { code });
      let injectFailure = false;
      let masterFd: number | null = null;
      let failedResponseFd: number | null = null;
      let builds = 0;
      const library = new OutputLibrary(root, {
        onReadableSnapshotBuild: () => { builds += 1; },
        duplicateReadableSnapshotFd: (descriptor) => {
          masterFd = descriptor;
          if (injectFailure && phase === "open") throw failure;
          const responseDescriptor = openSync(`/proc/self/fd/${descriptor}`, "r");
          if (injectFailure) failedResponseFd = responseDescriptor;
          return responseDescriptor;
        },
        statReadableSnapshotDuplicateFd: (descriptor) => {
          if (injectFailure && phase === "fstat") throw failure;
          return fstatSync(descriptor);
        },
      });
      const seed = library.openReadableOutput(outputName, [job], job.id)!;
      const masterStats = fstatSync(masterFd!);
      seed.release();

      injectFailure = true;
      let exposed: unknown;
      try {
        library.openReadableOutput(outputName, [job], job.id);
      } catch (error) {
        exposed = error;
      }
      expect(exposed).toBeInstanceOf(OutputSnapshotMaterializationError);
      expect(exposed).toMatchObject({ cause: failure, statusCode: 503, retryAfterSeconds: 1 });
      expect(fstatSync(masterFd!)).toMatchObject({ dev: masterStats.dev, ino: masterStats.ino });
      if (phase === "fstat") {
        expect(failedResponseFd).not.toBeNull();
        expect(() => fstatSync(failedResponseFd!)).toThrow();
      }

      injectFailure = false;
      const retry = library.openReadableOutput(outputName, [job], job.id)!;
      expect(fstatSync(retry.fd)).toMatchObject({ dev: masterStats.dev, ino: masterStats.ino });
      expect(builds).toBe(1);
      retry.release();

      expect(library.delete(outputName, [job]).name).toBe(outputName);
      expect(() => fstatSync(masterFd!)).toThrow();
    },
  );

  it("keeps response-FD EBADF and identity drift on the closed 404 path", async () => {
    for (const failureKind of ["ebadf", "identity"] as const) {
      const root = await outputRoot();
      const outputName = `response-${failureKind}-closed.mp4`;
      await writeFile(join(root, outputName), "closed response failure bytes");
      const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
      publishCompletedJob(root, job);
      let foreignFd: number | null = null;
      let masterFd: number | null = null;
      const library = new OutputLibrary(root, {
        statReadableSnapshotFd: (descriptor) => {
          masterFd = descriptor;
          return fstatSync(descriptor);
        },
        duplicateReadableSnapshotFd: failureKind === "ebadf"
          ? () => {
              throw Object.assign(new Error("closed duplicate descriptor"), { code: "EBADF" });
            }
          : () => {
              foreignFd = openSync("/dev/null", "r");
              return foreignFd;
            },
      });

      expect(library.openReadableOutput(outputName, [job], job.id)).toBeNull();
      expect(masterFd).not.toBeNull();
      expect(() => fstatSync(masterFd!)).toThrow();
      if (failureKind === "identity") {
        expect(foreignFd).not.toBeNull();
        expect(() => fstatSync(foreignFd!)).toThrow();
      }
    }
  });

  it("keeps a pre-v1.3 DFR output visible with immutable raw settings and a non-executable legacy view", async () => {
    const root = await outputRoot();
    const outputName = "legacy-dfr-output.mp4";
    await writeFile(join(root, outputName), "historical DFR video bytes");
    const library = new OutputLibrary(root);
    const baseJob = completedJob(outputName, "2026-08-25T20:00:00.000Z", "dfr");
    const rawRequest = structuredClone(baseJob.request) as unknown as {
      models: { transformerPath: string };
      dfr: unknown;
      [key: string]: unknown;
    };
    rawRequest.models.transformerPath =
      "/models/ltx-2.5/ltx-2.5-22b-dev-transformer-bf16.safetensors";
    rawRequest.dfr = {
      temporalUpsampleRounds: 0,
      detailingLora: { enabled: false, path: "", strength: 1 },
    };
    const requestSha256 = createHash("sha256")
      .update(canonicalJson(rawRequest))
      .digest("hex");
    const migratedRequest = migrateGenerationRequest(rawRequest)!;
    expect(isLegacyDfrRequest(migratedRequest)).toBe(true);
    baseJob.request = migratedRequest;
    baseJob.executionDecision = {
      schemaVersion: "ltx-studio-execution-decision.v5",
      executionClass: "dgx",
      decidedAt: "2026-08-25T19:59:00.000Z",
      reason: "Historical DFR execution predates the pinned v1.3 contract.",
      requestSha256,
      protocolSha256: null,
      cpuReuse: null,
      operation: null,
    };
    const job = Object.assign(baseJob, {
      authorityBoundRequest: rawRequest,
      authorityRequestSha256: requestSha256,
    });
    publishCompletedJob(root, job);
    library.recordCompleted([job]);
    const sidecarPath = join(root, `${outputName}.ltx-settings.json`);
    const originalSidecar = await readFile(sidecarPath, "utf8");

    const listed = library.list([job]).find((output) => output.name === outputName);

    expect(listed?.settingsAvailable).toBe(true);
    expect(isLegacyDfrRequest(listed!.request!)).toBe(true);
    expect(JSON.parse(originalSidecar).request).toMatchObject({
      models: { transformerPath: rawRequest.models.transformerPath },
      dfr: { temporalUpsampleRounds: 0 },
    });
    expect(JSON.parse(originalSidecar).request).not.toHaveProperty("legacyExecution");
    await expect(readFile(sidecarPath, "utf8")).resolves.toBe(originalSidecar);
  });

  it("keeps a legacy raw sidecar authorized while rejecting raw-request swaps", async () => {
    const root = await outputRoot();
    const outputName = "legacy-raw-authority.wav";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "legacy audio bytes");
    const library = new OutputLibrary(root);
    const baseJob = completedJob(outputName, "2026-08-25T20:30:00.000Z", "text-to-audio");
    const rawRequest = structuredClone(baseJob.request) as Record<string, unknown>;
    delete rawRequest.textToAudio;
    const rawRequestSha256 = createHash("sha256").update(canonicalJson(rawRequest)).digest("hex");
    baseJob.executionDecision = {
      schemaVersion: "ltx-studio-execution-decision.v5",
      executionClass: "dgx",
      decidedAt: "2026-08-25T20:29:00.000Z",
      reason: "Legacy T2A was classified before the peak-ceiling field existed.",
      requestSha256: rawRequestSha256,
      protocolSha256: null,
      cpuReuse: null,
      operation: null,
    };
    const job = Object.assign(baseJob, {
      authorityBoundRequest: rawRequest,
      authorityRequestSha256: rawRequestSha256,
    });
    publishCompletedJob(root, job);
    library.recordCompleted([job]);
    const sidecarPath = join(root, `${outputName}.ltx-settings.json`);
    const originalSidecar = await readFile(sidecarPath, "utf8");

    const listed = library.list([job]).find((output) => output.name === outputName);

    expect(listed).toMatchObject({
      settingsAvailable: true,
      request: { textToAudio: { peakCeilingDbfs: -3 } },
      executionDecision: { requestSha256: rawRequestSha256 },
    });
    expect(Object.hasOwn(JSON.parse(originalSidecar).request, "textToAudio")).toBe(false);
    await expect(readFile(sidecarPath, "utf8")).resolves.toBe(originalSidecar);

    const swappedRawRequest = { ...rawRequest, prompt: "foreign raw request" };
    const swappedJob = {
      ...job,
      authorityBoundRequest: swappedRawRequest,
      authorityRequestSha256: createHash("sha256")
        .update(canonicalJson(swappedRawRequest))
        .digest("hex"),
    };
    expect(library.resolvePublishedPath(outputName, [swappedJob])).toBeNull();

    const mutatedSidecar = JSON.parse(originalSidecar);
    mutatedSidecar.request.prompt = "tampered sidecar request";
    await writeFile(sidecarPath, JSON.stringify(mutatedSidecar, null, 2));
    expect(library.list([job]).find((output) => output.name === outputName)).toMatchObject({
      settingsAvailable: false,
      request: null,
    });
  });

  it("keeps raw output private until a durable digest/revision publication marker exists", async () => {
    const root = await outputRoot();
    const outputName = "unbound-raw.mp4";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "private until publication is durable");
    const library = new OutputLibrary(root);

    expect(library.list([])).toEqual([]);
    expect(library.resolvePublishedPath(outputName, [])).toBeNull();

    persistOutputPublicationAuthority(outputPath, {
      jobId: "2c8a5dc6-8864-49f7-a639-85caef918888",
      executionDecisionSha256: "1".repeat(64),
      publishedAt: "2026-08-25T10:00:00.000Z",
      jobPersistenceRevision: "11111111-1111-4111-8111-111111111111",
      jobAuthoritySha256: "2".repeat(64),
    });
    // A structurally valid marker is not its own authority without the exact
    // current terminal job record that durably committed it.
    expect(library.resolvePublishedPath(outputName, [])).toBeNull();
    expect(library.list([])).toEqual([]);
    expect((await stat(outputPublicationPath(outputPath))).mode & 0o777).toBe(0o400);
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);

    await appendFile(outputPath, "tampered");
    expect(library.resolvePublishedPath(outputName, [])).toBeNull();
    expect(library.list([])).toEqual([]);
  });

  it("reads experiment-preflight outputs without materializing sidecars or accepting invalid authority", async () => {
    const root = await outputRoot();
    const library = new OutputLibrary(root);
    const verifiedName = "preflight-verified.mp4";
    const missingSidecarName = "preflight-no-sidecar.mp4";
    const tamperedName = "preflight-tampered.mp4";
    await Promise.all([
      writeFile(join(root, verifiedName), "verified preflight bytes"),
      writeFile(join(root, missingSidecarName), "published without settings"),
      writeFile(join(root, tamperedName), "original authority bytes"),
    ]);
    const verifiedJob = completedJob(verifiedName, "2026-08-25T21:00:00.000Z");
    const rawVerifiedRequest = structuredClone(verifiedJob.request) as unknown as {
      audio: Record<string, unknown>;
    };
    delete rawVerifiedRequest.audio.outputDelayMs;
    const rawVerifiedRequestAuthoritySha256 = createHash("sha256")
      .update(canonicalJson(rawVerifiedRequest))
      .digest("hex");
    verifiedJob.executionDecision = {
      schemaVersion: "ltx-studio-execution-decision.v5",
      executionClass: "dgx",
      decidedAt: "2026-08-25T20:59:00.000Z",
      reason: "Fixture predates the native output-delay request field.",
      requestSha256: rawVerifiedRequestAuthoritySha256,
      protocolSha256: null,
      cpuReuse: null,
      operation: null,
    };
    Object.assign(verifiedJob, {
      authorityBoundRequest: rawVerifiedRequest,
      authorityRequestSha256: rawVerifiedRequestAuthoritySha256,
    });
    verifiedJob.identityEvidence = {
      schemaVersion: "ltx-studio-identity-evidence.v1",
      status: "verified",
      source: "image-conditioning",
      capturedAt: "2026-08-25T20:58:00.000Z",
      verifiedAt: "2026-08-25T20:59:00.000Z",
      reason: null,
      references: [{
        assetId: "5c8a5dc6-8864-49f7-a639-85caef918888",
        kind: "image",
        sizeBytes: 2_048,
        modifiedAtMs: 1_777_000_000_000,
        changedAtMs: 1_777_000_000_001,
        fileId: "42",
        sha256: "9".repeat(64),
      }],
    };
    const missingSidecarJob = completedJob(missingSidecarName, "2026-08-25T21:01:00.000Z");
    missingSidecarJob.id = "3c8a5dc6-8864-49f7-a639-85caef918888";
    const tamperedJob = completedJob(tamperedName, "2026-08-25T21:02:00.000Z");
    tamperedJob.id = "4c8a5dc6-8864-49f7-a639-85caef918888";
    publishCompletedJob(root, verifiedJob);
    publishCompletedJob(root, missingSidecarJob);
    publishCompletedJob(root, tamperedJob);
    library.recordCompleted([verifiedJob, tamperedJob]);
    await appendFile(join(root, tamperedName), " changed after publication");
    const missingSidecarPath = join(root, `${missingSidecarName}.ltx-settings.json`);
    await expect(stat(missingSidecarPath)).rejects.toThrow();
    const before = snapshotOutputTree(root);

    const evidence = library.inspectExperimentPreflightEvidence(
      [verifiedName, missingSidecarName, tamperedName],
      [verifiedJob, missingSidecarJob, tamperedJob],
    );
    const listed = evidence.outputs;

    expect(listed.find(({ name }) => name === verifiedName)).toMatchObject({
      jobId: verifiedJob.id,
      settingsAvailable: true,
      request: verifiedJob.request,
    });
    expect(listed.find(({ name }) => name === missingSidecarName)).toMatchObject({
      jobId: missingSidecarJob.id,
      settingsAvailable: false,
      request: null,
    });
    expect(listed.some(({ name }) => name === tamperedName)).toBe(false);
    expect(evidence.reusableCandidates).toEqual([
      expect.objectContaining({
        outputName: verifiedName,
        jobId: verifiedJob.id,
        request: verifiedJob.request,
        authorityBoundRequest: rawVerifiedRequest,
        authorityRequestSha256: sha256Json(rawVerifiedRequest),
      }),
    ]);
    await expect(stat(missingSidecarPath)).rejects.toThrow();
    expect(snapshotOutputTree(root)).toEqual(before);
  });

  it("never exposes raw bytes when marker fsync fails before no-replace publication", async () => {
    const root = await outputRoot();
    const outputName = "marker-fsync-failure.mp4";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "must remain private");
    const library = new OutputLibrary(root);
    let fsyncCalls = 0;

    expect(() => persistOutputPublicationAuthority(outputPath, {
      jobId: "2c8a5dc6-8864-49f7-a639-85caef918888",
      executionDecisionSha256: "1".repeat(64),
      publishedAt: "2026-08-25T10:00:00.000Z",
      jobPersistenceRevision: "11111111-1111-4111-8111-111111111111",
      jobAuthoritySha256: "2".repeat(64),
    }, {
      fsync: () => {
        fsyncCalls += 1;
        if (fsyncCalls === 2) throw new Error("synthetic marker fsync failure");
      },
    })).toThrow("synthetic marker fsync failure");

    expect(fsyncCalls).toBe(2);
    expect(library.resolvePublishedPath(outputName, [])).toBeNull();
    expect(library.list([])).toEqual([]);
    await expect(stat(outputPublicationPath(outputPath))).rejects.toThrow();
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("runs the final release fence immediately before the no-replace marker link", async () => {
    const root = await outputRoot();
    const outputName = "marker-release-fence.mp4";
    const outputPath = join(root, outputName);
    const markerPath = outputPublicationPath(outputPath);
    await writeFile(outputPath, "hashed but still private");
    let fenceCalls = 0;

    expect(() => persistOutputPublicationAuthority(outputPath, {
      jobId: "2c8a5dc6-8864-49f7-a639-85caef918888",
      executionDecisionSha256: "1".repeat(64),
      publishedAt: "2026-08-25T10:00:00.000Z",
      jobPersistenceRevision: "11111111-1111-4111-8111-111111111111",
      jobAuthoritySha256: "2".repeat(64),
    }, {}, undefined, () => {
      fenceCalls += 1;
      expect(() => lstatSync(markerPath)).toThrow();
      throw new Error("synthetic final release fence denial");
    })).toThrow("synthetic final release fence denial");

    expect(fenceCalls).toBe(1);
    await expect(stat(markerPath)).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rolls back a visible marker when the post-link directory fsync fails", async () => {
    const root = await outputRoot();
    const outputName = "marker-directory-fsync-failure.mp4";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "must remain private");
    let fsyncCalls = 0;

    expect(() => persistOutputPublicationAuthority(outputPath, {
      jobId: "2c8a5dc6-8864-49f7-a639-85caef918888",
      executionDecisionSha256: "1".repeat(64),
      publishedAt: "2026-08-25T10:00:00.000Z",
      jobPersistenceRevision: "11111111-1111-4111-8111-111111111111",
      jobAuthoritySha256: "2".repeat(64),
    }, {
      fsync: () => {
        fsyncCalls += 1;
        if (fsyncCalls === 3) throw new Error("synthetic marker-directory fsync failure");
      },
    })).toThrow("synthetic marker-directory fsync failure");

    expect(fsyncCalls).toBe(3);
    await expect(stat(outputPublicationPath(outputPath))).rejects.toThrow();
    expect((await readdir(root)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("never overwrites a publication marker created in the no-replace race window", async () => {
    const root = await outputRoot();
    const outputName = "marker-no-replace-race.mp4";
    const outputPath = join(root, outputName);
    const markerPath = outputPublicationPath(outputPath);
    await writeFile(outputPath, "must remain private");

    expect(() => persistOutputPublicationAuthority(outputPath, {
      jobId: "2c8a5dc6-8864-49f7-a639-85caef918888",
      executionDecisionSha256: "1".repeat(64),
      publishedAt: "2026-08-25T10:00:00.000Z",
      jobPersistenceRevision: "11111111-1111-4111-8111-111111111111",
      jobAuthoritySha256: "2".repeat(64),
    }, {
      link: (temporaryPath, publicationPath) => {
        writeFileSync(publicationPath, "foreign authority", { mode: 0o400, flag: "wx" });
        linkSync(temporaryPath, publicationPath);
      },
    })).toThrow();

    await expect(readFile(markerPath, "utf8")).resolves.toBe("foreign authority");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("cleans both names if unlinking the linked marker temp fails", async () => {
    const root = await outputRoot();
    const outputName = "marker-temp-unlink-failure.mp4";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "must remain private");

    expect(() => persistOutputPublicationAuthority(outputPath, {
      jobId: "2c8a5dc6-8864-49f7-a639-85caef918888",
      executionDecisionSha256: "1".repeat(64),
      publishedAt: "2026-08-25T10:00:00.000Z",
      jobPersistenceRevision: "11111111-1111-4111-8111-111111111111",
      jobAuthoritySha256: "2".repeat(64),
    }, {
      unlink: () => {
        throw new Error("synthetic linked-temp unlink failure");
      },
    })).toThrow("synthetic linked-temp unlink failure");

    await expect(stat(outputPublicationPath(outputPath))).rejects.toThrow();
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects a hard-linked raw output before publication", async () => {
    const root = await outputRoot();
    const outputPath = join(root, "hardlinked-output.mp4");
    await writeFile(outputPath, "same inode has two names");
    await link(outputPath, join(root, "second-name.mp4"));

    expect(() => persistOutputPublicationAuthority(outputPath, {
      jobId: "2c8a5dc6-8864-49f7-a639-85caef918888",
      executionDecisionSha256: "1".repeat(64),
      publishedAt: "2026-08-25T10:00:00.000Z",
      jobPersistenceRevision: "11111111-1111-4111-8111-111111111111",
      jobAuthoritySha256: "2".repeat(64),
    })).toThrow("exakt einem Link");
    await expect(stat(outputPublicationPath(outputPath))).rejects.toThrow();
  });

  it("serves a validated held output FD instead of a later pathname replacement", async () => {
    const root = await outputRoot();
    const outputName = "held-publication.mp4";
    const outputPath = join(root, outputName);
    const openedPath = join(root, "held-publication.opened.mp4");
    await writeFile(outputPath, "authorized bytes");
    const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(root, job);
    const library = new OutputLibrary(root);
    const lease = library.openPublishedOutput(outputName, [job]);
    expect(lease).not.toBeNull();
    try {
      await rename(outputPath, openedPath);
      await writeFile(outputPath, "unbound replacement");

      expect(library.resolvePublishedPath(outputName, [job])).toBeNull();
      await expect(readFile(`/proc/self/fd/${lease!.fd}`, "utf8")).resolves.toBe("authorized bytes");
    } finally {
      if (lease) closeSync(lease.fd);
    }
  });

  it("serves only the verified anonymous snapshot after a same-inode source write", async () => {
    const root = await outputRoot();
    const outputName = "same-inode-publication.mp4";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "authorized bytes");
    const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(root, job);
    const library = new OutputLibrary(root);
    const lease = library.openPublishedOutput(outputName, [job]);
    expect(lease?.snapshotBackend).toMatch(/^(?:o-tmpfile|unlinked-tempfile)$/);
    try {
      await writeFile(outputPath, "malicious! bytes");
      await expect(readFile(`/proc/self/fd/${lease!.fd}`, "utf8")).resolves.toBe("authorized bytes");
      expect(library.resolvePublishedPath(outputName, [job])).toBeNull();
    } finally {
      if (lease) closeSync(lease.fd);
    }
  });

  it("shares the same bounded read-only snapshot cache with modern Range-style playback", async () => {
    const root = await outputRoot();
    const outputName = "cached-modern-publication.mp4";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "authorized modern bytes");
    const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(root, job);
    const library = new OutputLibrary(root);

    const first = library.openReadableOutput(outputName, [job], job.id);
    const second = library.openReadableOutput(outputName, [job], job.id);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    try {
      const firstStats = fstatSync(first!.fd);
      const secondStats = fstatSync(second!.fd);
      expect(first!.fd).not.toBe(second!.fd);
      expect({ dev: firstStats.dev, ino: firstStats.ino, nlink: firstStats.nlink, mode: firstStats.mode & 0o777 })
        .toEqual({ dev: secondStats.dev, ino: secondStats.ino, nlink: 0, mode: 0o400 });
      expect(readFileSync(first!.fd, "utf8")).toBe("authorized modern bytes");
      expect(readFileSync(second!.fd, "utf8")).toBe("authorized modern bytes");
      expect(() => writeSync(first!.fd, Buffer.from("x"), 0, 1, 0)).toThrow();
    } finally {
      first?.release();
      second?.release();
    }

    await writeFile(outputPath, "malicious modern bytes!");
    expect(library.openReadableOutput(outputName, [job], job.id)).toBeNull();
  });

  it("materializes one real 10-MiB snapshot and reuses it for Range-style reads", async () => {
    const root = await outputRoot();
    const outputName = "cached-modern-10mib.mp4";
    await writeFile(join(root, outputName), Buffer.alloc(10 * 1024 * 1024, 0x5a));
    const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(root, job);
    let builds = 0;
    const library = new OutputLibrary(root, {
      onReadableSnapshotBuild: () => { builds += 1; },
    });

    const firstStartedAt = performance.now();
    const first = library.openReadableOutput(outputName, [job], job.id)!;
    const firstMs = performance.now() - firstStartedAt;
    const firstStats = fstatSync(first.fd);
    first.release();

    const rangeStartedAt = performance.now();
    const rangeBuffer = Buffer.alloc(4096);
    for (let range = 0; range < 32; range += 1) {
      const lease = library.openReadableOutput(outputName, [job], job.id)!;
      expect(fstatSync(lease.fd).ino).toBe(firstStats.ino);
      expect(readSync(lease.fd, rangeBuffer, 0, rangeBuffer.length, range * 128 * 1024))
        .toBe(rangeBuffer.length);
      lease.release();
    }
    const rangesMs = performance.now() - rangeStartedAt;

    expect(builds).toBe(1);
    if (process.env.LTX_RANGE_SMOKE_REPORT === "1") {
      console.info(JSON.stringify({
        bytes: firstStats.size,
        firstMs: Number(firstMs.toFixed(2)),
        cachedRanges: 32,
        cachedRangesMs: Number(rangesMs.toFixed(2)),
        builds,
      }));
    }
  });

  it("admits one oversize snapshot, reuses it, and blocks A-B-A amplification while leases are active", async () => {
    const root = await outputRoot();
    const firstName = "oversize-a.mp4";
    const secondName = "oversize-b.mp4";
    await writeFile(join(root, firstName), "oversize A without allocating GiB");
    await writeFile(join(root, secondName), "oversize B without allocating GiB");
    const firstJob = completedJob(firstName, "2026-08-25T10:00:00.000Z");
    const secondJob = completedJob(secondName, "2026-08-25T10:01:00.000Z");
    publishCompletedJob(root, firstJob);
    publishCompletedJob(root, secondJob);
    const builds: string[] = [];
    const library = new OutputLibrary(root, {
      readableSnapshotCacheMaxBytes: 1,
      onReadableSnapshotBuild: (key) => builds.push(key),
    });

    const firstA = library.openReadableOutput(firstName, [firstJob, secondJob], firstJob.id)!;
    const secondA = library.openReadableOutput(firstName, [firstJob, secondJob], firstJob.id)!;
    expect(builds).toHaveLength(1);
    expect(fstatSync(firstA.fd).ino).toBe(fstatSync(secondA.fd).ino);
    expect(() => writeSync(firstA.fd, Buffer.from("x"), 0, 1, 0)).toThrow();

    expect(() => library.openReadableOutput(secondName, [firstJob, secondJob], secondJob.id))
      .toThrow(expect.objectContaining({
        name: "OutputSnapshotCapacityError",
        statusCode: 503,
        retryAfterSeconds: 1,
      }));
    expect(builds).toHaveLength(1);
    firstA.release();
    expect(() => library.openReadableOutput(secondName, [firstJob, secondJob], secondJob.id))
      .toThrow(OutputSnapshotCapacityError);
    secondA.release();

    const firstB = library.openReadableOutput(secondName, [firstJob, secondJob], secondJob.id)!;
    const secondB = library.openReadableOutput(secondName, [firstJob, secondJob], secondJob.id)!;
    expect(builds).toHaveLength(2);
    expect(fstatSync(firstB.fd).ino).toBe(fstatSync(secondB.fd).ino);
    expect(() => library.openReadableOutput(firstName, [firstJob, secondJob], firstJob.id))
      .toThrow(OutputSnapshotCapacityError);
    expect(builds).toHaveLength(2);
    firstB.release();
    secondB.release();

    const rebuiltA = library.openReadableOutput(firstName, [firstJob, secondJob], firstJob.id)!;
    expect(builds).toHaveLength(3);
    rebuiltA.release();
  });

  it("isolates cache identity and resident inodes across different output roots", async () => {
    const firstRoot = await outputRoot();
    const secondRoot = await outputRoot();
    const outputName = "same-authority-name.mp4";
    await writeFile(join(firstRoot, outputName), "root one bytes");
    await writeFile(join(secondRoot, outputName), "root two bytes");
    const firstJob = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    const secondJob = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(firstRoot, firstJob);
    publishCompletedJob(secondRoot, secondJob);
    let firstBuilds = 0;
    let secondBuilds = 0;
    const firstLibrary = new OutputLibrary(firstRoot, {
      onReadableSnapshotBuild: () => { firstBuilds += 1; },
    });
    const secondLibrary = new OutputLibrary(secondRoot, {
      onReadableSnapshotBuild: () => { secondBuilds += 1; },
    });

    const first = firstLibrary.openReadableOutput(outputName, [firstJob], firstJob.id)!;
    const second = secondLibrary.openReadableOutput(outputName, [secondJob], secondJob.id)!;
    expect(firstBuilds).toBe(1);
    expect(secondBuilds).toBe(1);
    expect({ dev: fstatSync(first.fd).dev, ino: fstatSync(first.fd).ino })
      .not.toEqual({ dev: fstatSync(second.fd).dev, ino: fstatSync(second.fd).ino });
    expect(readFileSync(first.fd, "utf8")).toBe("root one bytes");
    expect(readFileSync(second.fd, "utf8")).toBe("root two bytes");
    first.release();
    second.release();
  });

  it("retries a failed lease close internally without losing resident-byte accounting", async () => {
    const root = await outputRoot();
    const outputName = "close-retry.mp4";
    await writeFile(join(root, outputName), "close retry bytes");
    const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(root, job);
    let failDescriptor: number | null = null;
    let injectedFailures = 0;
    const library = new OutputLibrary(root, {
      closeReadableSnapshotFd: (descriptor) => {
        if (descriptor === failDescriptor && injectedFailures === 0) {
          injectedFailures += 1;
          throw new Error("synthetic first lease close failure");
        }
        closeSync(descriptor);
      },
    });
    const lease = library.openReadableOutput(outputName, [job], job.id)!;
    failDescriptor = lease.fd;

    lease.release();
    lease.release();
    expect(fstatSync(lease.fd).isFile()).toBe(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    expect(injectedFailures).toBe(1);
    expect(() => fstatSync(lease.fd)).toThrow();
  });

  it("retries a failed master close after TTL without another request and releases residency", async () => {
    const root = await outputRoot();
    const firstName = "master-close-retry-a.mp4";
    const secondName = "master-close-retry-b.mp4";
    await writeFile(join(root, firstName), "oversize master A");
    await writeFile(join(root, secondName), "oversize master B");
    const firstJob = completedJob(firstName, "2026-08-25T10:00:00.000Z");
    const secondJob = completedJob(secondName, "2026-08-25T10:01:00.000Z");
    publishCompletedJob(root, firstJob);
    publishCompletedJob(root, secondJob);
    let leaseFd: number | null = null;
    let targetIdentity: { dev: number; ino: number } | null = null;
    let failedMasterFd: number | null = null;
    let injectedFailures = 0;
    const library = new OutputLibrary(root, {
      readableSnapshotCacheMaxBytes: 1,
      readableSnapshotCacheTtlMs: 20,
      closeReadableSnapshotFd: (descriptor) => {
        const stats = fstatSync(descriptor);
        if (descriptor !== leaseFd
          && targetIdentity !== null
          && stats.dev === targetIdentity.dev
          && stats.ino === targetIdentity.ino
          && injectedFailures === 0) {
          injectedFailures += 1;
          failedMasterFd = descriptor;
          throw new Error("synthetic first master close failure");
        }
        closeSync(descriptor);
      },
    });
    const first = library.openReadableOutput(firstName, [firstJob, secondJob], firstJob.id)!;
    leaseFd = first.fd;
    const firstStats = fstatSync(first.fd);
    targetIdentity = { dev: firstStats.dev, ino: firstStats.ino };
    first.release();

    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(injectedFailures).toBe(1);
    expect(failedMasterFd).not.toBeNull();
    expect(() => fstatSync(failedMasterFd!)).toThrow();
    const second = library.openReadableOutput(secondName, [firstJob, secondJob], secondJob.id)!;
    expect(readFileSync(second.fd, "utf8")).toBe("oversize master B");
    second.release();
  });

  it("never closes a foreign FD that reuses a failed master descriptor number", async () => {
    const root = await outputRoot();
    const outputName = "master-close-reused-fd.mp4";
    await writeFile(join(root, outputName), "master reused FD bytes");
    const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(root, job);
    let leaseFd: number | null = null;
    let targetIdentity: { dev: number; ino: number } | null = null;
    let resolveFailure!: (descriptor: number) => void;
    const firstFailure = new Promise<number>((resolve) => { resolveFailure = resolve; });
    let injected = false;
    const library = new OutputLibrary(root, {
      readableSnapshotCacheTtlMs: 20,
      closeReadableSnapshotFd: (descriptor) => {
        const stats = fstatSync(descriptor);
        if (!injected
          && descriptor !== leaseFd
          && targetIdentity !== null
          && stats.dev === targetIdentity.dev
          && stats.ino === targetIdentity.ino) {
          injected = true;
          resolveFailure(descriptor);
          throw new Error("synthetic master close failure before FD reuse");
        }
        closeSync(descriptor);
      },
    });
    const lease = library.openReadableOutput(outputName, [job], job.id)!;
    leaseFd = lease.fd;
    const stats = fstatSync(lease.fd);
    targetIdentity = { dev: stats.dev, ino: stats.ino };
    lease.release();
    const failedMasterFd = await firstFailure;
    closeSync(failedMasterFd);
    const foreignFds: number[] = [];
    try {
      while (!foreignFds.includes(failedMasterFd)) {
        foreignFds.push(openSync("/dev/null", "r"));
      }

      await new Promise<void>((resolve) => setTimeout(resolve, 80));

      expect(fstatSync(failedMasterFd).isCharacterDevice()).toBe(true);
    } finally {
      foreignFds.forEach((descriptor) => closeSync(descriptor));
    }
  });

  it("retires an inactive snapshot after TTL and invalidates a cached master on delete", async () => {
    const root = await outputRoot();
    const ttlName = "ttl-modern.mp4";
    await writeFile(join(root, ttlName), "ttl bytes");
    const ttlJob = completedJob(ttlName, "2026-08-25T10:00:00.000Z");
    publishCompletedJob(root, ttlJob);
    let builds = 0;
    const ttlLibrary = new OutputLibrary(root, {
      readableSnapshotCacheTtlMs: 20,
      onReadableSnapshotBuild: () => { builds += 1; },
    });
    const beforeTtl = ttlLibrary.openReadableOutput(ttlName, [ttlJob], ttlJob.id)!;
    beforeTtl.release();
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    const afterTtl = ttlLibrary.openReadableOutput(ttlName, [ttlJob], ttlJob.id)!;
    expect(builds).toBe(2);
    afterTtl.release();

    const deleteName = "delete-cached-modern.mp4";
    await writeFile(join(root, deleteName), "delete cache bytes");
    const deleteJob = completedJob(deleteName, "2026-08-25T10:02:00.000Z");
    publishCompletedJob(root, deleteJob);
    const deleteLibrary = new OutputLibrary(root);
    const held = deleteLibrary.openReadableOutput(deleteName, [deleteJob], deleteJob.id)!;
    expect(deleteLibrary.delete(deleteName, [deleteJob]).name).toBe(deleteName);
    expect(deleteLibrary.openReadableOutput(deleteName, [deleteJob], deleteJob.id)).toBeNull();
    expect(readFileSync(held.fd, "utf8")).toBe("delete cache bytes");
    held.release();
    expect(() => fstatSync(held.fd)).toThrow();
  });

  it("persists a self-contained execution class and operation provenance in the output sidecar", async () => {
    const root = await outputRoot();
    const outputName = "decision-bound.mp4";
    await writeFile(join(root, outputName), "video");
    const job = completedJob(outputName, "2026-08-25T10:00:00.000Z");
    const decision = {
      schemaVersion: "ltx-studio-execution-decision.v5" as const,
      executionClass: "dgx" as const,
      decidedAt: "2026-08-25T09:59:00.000Z",
      reason: "DGX render plan persisted before admission.",
      requestSha256: createHash("sha256").update(canonicalJson(job.request)).digest("hex"),
      protocolSha256: null,
      cpuReuse: null,
      operation: null,
    };
    job.executionClass = "dgx";
    job.executionDecision = decision;
    job.runProvenance = bindRunExecutionDecision(runProvenance(), decision);
    publishCompletedJob(root, job);
    const library = new OutputLibrary(root);

    library.recordCompleted([job]);

    expect(library.list([job]).find((output) => output.name === outputName)?.executionDecision)
      .toEqual(decision);
    const sidecar = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));
    expect(sidecar.executionDecision).toEqual(decision);
    expect(sidecar.runProvenance.executionDecision).toEqual(decision);

    sidecar.executionDecision.reason = "Top-level and nested decision were rewritten together.";
    sidecar.runProvenance.executionDecision.reason = sidecar.executionDecision.reason;
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify(sidecar));
    expect(library.list([job]).find((output) => output.name === outputName)).toMatchObject({
      settingsAvailable: false,
      executionDecision: null,
    });
  });

  it("lists every MP4 and exposes settings only with matching provenance", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:00:00.000Z");
    const studioName = "studio-output.mp4";
    const externalName = "external-output.mp4";
    await writeFile(join(root, studioName), "video");
    await writeFile(join(root, externalName), "external");
    await utimes(join(root, studioName), completedAt, completedAt);
    const library = new OutputLibrary(root);
    const job = completedJob(studioName, completedAt.toISOString());
    publishCompletedJob(root, job);

    library.recordCompleted([job]);
    const outputs = library.list([job]);
    const studioOutput = outputs.find((output) => output.name === studioName)!;

    expect(studioOutput.settingsAvailable).toBe(true);
    expect(studioOutput.request).toEqual(job.request);
    expect(studioOutput.qualityReview).toBeNull();
    expect(studioOutput.analysis).toBeNull();
    expect(outputs.some((output) => output.name === externalName)).toBe(false);

    await appendFile(join(root, studioName), "changed");
    const modified = library.list([job]).find((output) => output.name === studioName);
    expect(modified).toBeUndefined();
  });

  it("backfills settings for completed Studio jobs even when filesystem mtime drifted", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:00:00.000Z");
    const driftedMtime = new Date("2026-07-24T08:30:00.000Z");
    const outputName = "drifted-output.mp4";
    await writeFile(join(root, outputName), "video");
    await utimes(join(root, outputName), driftedMtime, driftedMtime);
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString());
    publishCompletedJob(root, job);

    const output = library.list([job]).find((candidate) => candidate.name === outputName)!;

    expect(output.settingsAvailable).toBe(true);
    expect(output.request).toEqual(job.request);
  });

  it("loads older settings sidecars through the current request migration", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:00:00.000Z");
    const outputName = "legacy-settings.mp4";
    await writeFile(join(root, outputName), "video");
    const stats = await stat(join(root, outputName));
    const job = completedJob(outputName, completedAt.toISOString());
    publishCompletedJob(root, job);
    const legacyRequest = structuredClone(job.request) as Partial<typeof job.request>;
    delete legacyRequest.lipDub;
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify({
      schemaVersion: "ltx-studio-output.v1",
      outputName,
      jobId: job.id,
      completedAt: completedAt.toISOString(),
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      request: legacyRequest,
    }));

    const output = new OutputLibrary(root).list([job]).find((candidate) => candidate.name === outputName)!;

    expect(output.settingsAvailable).toBe(true);
    expect(output.request?.lipDub).toMatchObject({
      referenceVideo: { path: "", name: "", strength: 1 },
      lora: { path: "", strength: 1 },
    });
    expect(output.qualityReview).toBeNull();
    const migrated = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));
    expect(migrated).toMatchObject({
      schemaVersion: "ltx-studio-output.v7",
      changedAtMs: expect.any(Number),
      fileId: expect.stringMatching(/^\d+$/),
      identityEvidence: null,
      runProvenance: {
        fingerprint: job.runProvenance?.fingerprint,
        executionDecision: job.executionDecision,
      },
      executionDecision: job.executionDecision,
    });
  });

  it("rebinds legacy settings only from a current terminal job authority", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:30:00.000Z");
    const outputName = "legacy-unbound-speech.mp4";
    await writeFile(join(root, outputName), "video");
    const stats = await stat(join(root, outputName));
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    publishCompletedJob(root, job);
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify({
      schemaVersion: "ltx-studio-output.v2",
      outputName,
      jobId: job.id,
      completedAt: completedAt.toISOString(),
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      request: job.request,
      qualityReview: null,
    }));
    const library = new OutputLibrary(root);

    expect(library.list([]).find((output) => output.name === outputName)).toBeUndefined();
    expect(library.list([job]).find((output) => output.name === outputName)?.settingsAvailable).toBe(true);
    library.setQualityReview(outputName, {
      scores: {
        lipSync: 5,
        identity: 5,
        mouthNaturalness: 5,
        skinStability: 5,
        motion: 5,
        audio: 5,
      },
      note: "Legacy wird ausschließlich aus der aktuellen Jobautorität neu gebunden.",
    }, [job]);
    const afterReview = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));
    expect(afterReview).toMatchObject({
      schemaVersion: "ltx-studio-output.v7",
      changedAtMs: expect.any(Number),
      fileId: expect.stringMatching(/^\d+$/),
      executionDecision: job.executionDecision,
    });
    expect(library.resolveAnalysisTarget(outputName, [job]).jobId).toBe(job.id);
  });

  it("reads v6 sidecars as explicitly project-unbound instead of inventing a run binding", async () => {
    const root = await outputRoot();
    const outputName = "v6-project-unbound.mp4";
    const completedAt = "2026-07-24T07:40:00.000Z";
    await writeFile(join(root, outputName), "video");
    const stats = await stat(join(root, outputName));
    const job = completedJob(outputName, completedAt, "audio-to-video");
    publishCompletedJob(root, job);
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify({
      schemaVersion: "ltx-studio-output.v6",
      outputName,
      jobId: job.id,
      completedAt,
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      changedAtMs: stats.ctimeMs,
      fileId: String(stats.ino),
      request: job.request,
      qualityReview: null,
      identityEvidence: null,
      runProvenance: v2RunProvenance(),
      experiment: null,
    }));

    const output = new OutputLibrary(root).list([job]).find((candidate) => candidate.name === outputName);

    expect(output?.settingsAvailable).toBe(true);
    expect(output?.project).toBeNull();
    await expect(new OutputLibrary(root).captureProjectOutputEvidence(
      outputName,
      projectRunBinding(sha256Json(job.request)),
      [job],
    )).rejects.toThrow("Projekt- und v2-Laufprovenienz");
  });

  it("upgrades a strong v3 speech sidecar to v7 without inventing evidence", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:45:00.000Z");
    const outputName = "v3-speech.mp4";
    await writeFile(join(root, outputName), "video");
    const stats = await stat(join(root, outputName));
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    publishCompletedJob(root, job);
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify({
      schemaVersion: "ltx-studio-output.v3",
      outputName,
      jobId: job.id,
      completedAt: completedAt.toISOString(),
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      changedAtMs: stats.ctimeMs,
      fileId: String(stats.ino),
      request: job.request,
      qualityReview: null,
    }));
    const library = new OutputLibrary(root);

    expect(library.list([job]).find((output) => output.name === outputName)?.settingsAvailable).toBe(true);
    expect(library.resolveAnalysisTarget(outputName, [job]).identityEvidence).toBeNull();
    library.setQualityReview(outputName, {
      scores: {
        lipSync: 5,
        identity: 5,
        mouthNaturalness: 5,
        skinStability: 5,
        motion: 5,
        audio: 5,
      },
      note: "Alte Ausgabe ohne beweisbare Identitätsreferenz.",
    }, [job]);

    const upgraded = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));
    expect(upgraded).toMatchObject({
      schemaVersion: "ltx-studio-output.v7",
      identityEvidence: null,
      runProvenance: {
        fingerprint: job.runProvenance?.fingerprint,
        executionDecision: job.executionDecision,
      },
      executionDecision: job.executionDecision,
    });
  });

  it("fails closed when neither a current job nor an archived authority is supplied", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T08:00:00.000Z");
    const outputName = "historic-output.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    publishCompletedJob(root, job);
    library.recordCompleted([job]);

    expect(library.list([]).find((output) => output.name === outputName)).toBeUndefined();
  });

  it("persists a validated speech quality scorecard in a revision-bound v7 sidecar", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:00:00.000Z");
    const outputName = "speech-scorecard.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    publishCompletedJob(root, job);
    library.recordCompleted([job]);

    const updated = library.setQualityReview(outputName, {
      scores: {
        lipSync: 8,
        identity: 9,
        mouthNaturalness: 7,
        skinStability: 6,
        motion: 8,
        audio: 10,
      },
      note: "1,8 s: Lippen leicht zu spät.",
    }, [job]);

    expect(updated.qualityReview).toMatchObject({
      scores: {
        lipSync: 8,
        identity: 9,
        mouthNaturalness: 7,
        skinStability: 6,
        motion: 8,
        audio: 10,
      },
      note: "1,8 s: Lippen leicht zu spät.",
    });
    expect(Number.isFinite(Date.parse(updated.qualityReview!.updatedAt))).toBe(true);
    const sidecar = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));
    expect(sidecar.schemaVersion).toBe("ltx-studio-output.v7");
    expect(sidecar.changedAtMs).toEqual(expect.any(Number));
    expect(sidecar.fileId).toMatch(/^\d+$/);
    expect(sidecar.request).toEqual(job.request);
    expect(sidecar.qualityReview.scores.lipSync).toBe(8);

    const restored = new OutputLibrary(root).list([job]).find((output) => output.name === outputName)!;
    expect(restored.qualityReview).toEqual(updated.qualityReview);
  });

  it("refuses scorecards for external, changed, and non-speech outputs", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:00:00.000Z");
    const score = {
      scores: {
        lipSync: 5,
        identity: 5,
        mouthNaturalness: 5,
        skinStability: 5,
        motion: 5,
        audio: 5,
      },
      note: "",
    };
    const externalName = "external-score.mp4";
    await writeFile(join(root, externalName), "video");
    const library = new OutputLibrary(root);
    expect(() => library.setQualityReview(externalName, score, [])).toThrow("Ausgabe nicht gefunden");

    const silentName = "silent-score.mp4";
    await writeFile(join(root, silentName), "video");
    const silentJob = completedJob(silentName, completedAt.toISOString());
    publishCompletedJob(root, silentJob);
    library.recordCompleted([silentJob]);
    expect(() => library.setQualityReview(silentName, score, [silentJob])).toThrow("Nur ein fertiges Sprachvideo");

    const changedName = "changed-score.mp4";
    await writeFile(join(root, changedName), "video");
    const speechJob = completedJob(changedName, completedAt.toISOString(), "audio-to-video");
    publishCompletedJob(root, speechJob);
    library.recordCompleted([speechJob]);
    await appendFile(join(root, changedName), "changed");
    expect(() => library.setQualityReview(changedName, score, [speechJob])).toThrow("Ausgabe nicht gefunden");
  });

  it("resolves analysis targets only for unchanged Studio speech outputs", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:30:00.000Z");
    const outputName = "speech-analysis.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "lipdub");
    publishCompletedJob(root, job);
    library.recordCompleted([job]);

    expect(library.resolveAnalysisTarget(outputName)).toMatchObject({
      outputName,
      jobId: job.id,
      request: { mode: "lipdub" },
    });

    const silentName = "silent-analysis.mp4";
    await writeFile(join(root, silentName), "video");
    const silentJob = completedJob(silentName, completedAt.toISOString(), "two-stage");
    publishCompletedJob(root, silentJob);
    library.recordCompleted([silentJob]);
    expect(() => library.resolveAnalysisTarget(silentName)).toThrow(
      "Nur ein fertiges Sprachvideo",
    );

    const nativeName = "native-dialogue-analysis.mp4";
    await writeFile(join(root, nativeName), "video");
    const nativeJob = completedJob(nativeName, completedAt.toISOString(), "two-stage");
    nativeJob.request.promptParts.dialogue = "Dieser Satz wird nativ gesprochen.";
    publishCompletedJob(root, nativeJob);
    library.recordCompleted([nativeJob]);
    expect(library.resolveAnalysisTarget(nativeName)).toMatchObject({
      outputName: nativeName,
      request: { mode: "two-stage" },
    });

    await appendFile(join(root, outputName), "changed");
    expect(() => library.resolveAnalysisTarget(outputName)).toThrow("Ausgabe nicht gefunden");
  });

  it("persists verified identity evidence without persisting a reference path", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:35:00.000Z");
    const outputName = "speech-identity-evidence.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    job.identityEvidence = {
      schemaVersion: "ltx-studio-identity-evidence.v1",
      status: "verified",
      source: "image-conditioning",
      capturedAt: "2026-07-24T09:30:00.000Z",
      verifiedAt: "2026-07-24T09:35:00.000Z",
      reason: null,
      references: [{
        assetId: "6d6d624b-12c3-4a97-9e4e-152a69423b6c",
        kind: "image",
        sizeBytes: 1_024,
        modifiedAtMs: 1_721_813_400_000,
        changedAtMs: 1_721_813_400_001,
        fileId: "12345",
        sha256: "a".repeat(64),
      }],
    };

    publishCompletedJob(root, job);
    library.recordCompleted([job]);
    expect(library.resolveAnalysisTarget(outputName).identityEvidence).toEqual(job.identityEvidence);
    const sidecar = await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8");
    expect(sidecar).not.toContain("/uploads/");
    expect(sidecar).toContain(job.identityEvidence.references[0].sha256);
  });

  it("persists full run provenance in the output sidecar and analysis target", async () => {
    const root = await outputRoot();
    const outputName = "speech-run-provenance.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, "2026-07-24T09:35:00.000Z", "audio-to-video");
    job.runProvenance = runProvenance();

    publishCompletedJob(root, job);
    library.recordCompleted([job]);

    expect(library.list([job]).find((output) => output.name === outputName)?.provenance).toEqual(job.runProvenance);
    expect(library.resolveAnalysisTarget(outputName).runProvenance).toEqual(job.runProvenance);
    const sidecar = await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8");
    expect(sidecar).toContain(job.runProvenance.fingerprint);
    expect(sidecar).toContain("input:conditioning-audio");
  });

  it("captures project export and sidecar hashes only from unchanged v2-provenance outputs", async () => {
    const root = await outputRoot();
    const outputName = "project-bound-output.mp4";
    const outputPath = join(root, outputName);
    const sidecarPath = join(root, `${outputName}.ltx-settings.json`);
    await writeFile(outputPath, "project-video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, "2026-07-24T09:36:00.000Z", "audio-to-video");
    job.runProvenance = v2RunProvenance();
    job.project = projectRunBinding(sha256Json(job.request));
    publishCompletedJob(root, job);
    library.recordCompleted([job]);
    const recordedAt = new Date().toISOString();

    const evidence = await library.captureProjectOutputEvidence(
      outputName,
      job.project,
      [job],
      recordedAt,
    );

    expect(evidence).toMatchObject({
      requestRevisionId: job.project.requestRevisionId,
      projectRun: job.project,
      requestSha256: sha256Json(job.request),
      jobId: job.id,
      outputName,
      provenanceFingerprint: job.runProvenance.fingerprint,
      recordedAt,
    });
    expect(evidence.exportSha256).toBe(
      createHash("sha256").update(await readFile(outputPath)).digest("hex"),
    );
    expect(evidence.settingsSidecarSha256).toBe(
      createHash("sha256").update(await readFile(sidecarPath)).digest("hex"),
    );
    expect(JSON.parse(await readFile(sidecarPath, "utf8"))).toMatchObject({
      schemaVersion: "ltx-studio-output.v7",
      project: job.project,
    });

    await appendFile(outputPath, "changed");
    await expect(library.captureProjectOutputEvidence(
      outputName,
      job.project,
      [job],
    )).rejects.toThrow("Ausgabe nicht gefunden");
  });

  it("does not promote legacy provenance into project export evidence", async () => {
    const root = await outputRoot();
    const outputName = "legacy-project-output.mp4";
    await writeFile(join(root, outputName), "project-video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, "2026-07-24T09:37:00.000Z", "audio-to-video");
    job.runProvenance = runProvenance();
    job.project = projectRunBinding(sha256Json(job.request));
    publishCompletedJob(root, job);
    library.recordCompleted([job]);

    await expect(library.captureProjectOutputEvidence(
      outputName,
      job.project,
      [job],
    )).rejects.toThrow("v2-Laufprovenienz");
  });

  it("keeps the frozen experiment sidecar but hides bytes without job authority", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:40:00.000Z");
    const outputName = "experiment-bound.mp4";
    await writeFile(join(root, outputName), "video");
    await utimes(join(root, outputName), completedAt, completedAt);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    const requestSha256 = sha256Json(job.request);
    job.experiment = {
      schemaVersion: "ltx-studio-experiment-run.v1",
      experimentId: "33333333-3333-4333-8333-333333333333",
      protocolSha256: "a".repeat(64),
      arm: "baseline",
      kind: "ablation",
      variableId: "a2v-guidance",
      changedRequestPaths: ["videoGuidance.modalityScale"],
      baselineRequestSha256: requestSha256,
      requestSha256,
      baselineJobId: null,
      baselineOutputName: outputName,
    };
    const library = new OutputLibrary(root);

    publishCompletedJob(root, job);
    library.recordCompleted([job]);
    const output = library.list([]).find((item) => item.name === outputName);
    const sidecar = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));

    expect(output).toBeUndefined();
    expect(sidecar).toMatchObject({
      schemaVersion: "ltx-studio-output.v7",
      experiment: job.experiment,
    });
  });

  it("drops an analysis when same-sized output bytes replace the original with restored mtime", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:45:00.000Z");
    const outputName = "content-revision.mp4";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "video-a");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    publishCompletedJob(root, job);
    library.recordCompleted([job]);
    const target = library.resolveAnalysisTarget(outputName);
    writeOutputAnalysis(root, {
      schemaVersion: "ltx-studio-output-analysis.v1",
      outputName,
      sizeBytes: target.sizeBytes,
      modifiedAtMs: target.modifiedAtMs,
      changedAtMs: target.changedAtMs,
      fileId: target.fileId,
      jobId: target.jobId,
      analysisId: "3c8a5dc6-8864-49f7-a639-85caef918888",
      attempt: 1,
      status: "failed",
      progress: 10,
      createdAt: "2026-07-24T09:45:01.000Z",
      startedAt: "2026-07-24T09:45:01.000Z",
      finishedAt: "2026-07-24T09:45:02.000Z",
      updatedAt: "2026-07-24T09:45:02.000Z",
      error: { code: "test", message: "Test record." },
      result: null,
    });
    expect(library.list([job]).find((output) => output.name === outputName)?.analysis).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(outputPath, "video-b");
    await utimes(outputPath, target.modifiedAtMs / 1_000, target.modifiedAtMs / 1_000);

    const replaced = library.list([job]).find((output) => output.name === outputName);
    expect(replaced).toBeUndefined();
  });

  it("ignores invalid quality data while retaining valid v2 provenance", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:00:00.000Z");
    const outputName = "invalid-scorecard.mp4";
    await writeFile(join(root, outputName), "video");
    const stats = await stat(join(root, outputName));
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    publishCompletedJob(root, job);
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify({
      schemaVersion: "ltx-studio-output.v2",
      outputName,
      jobId: job.id,
      completedAt: completedAt.toISOString(),
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      request: job.request,
      qualityReview: {
        scores: {
          lipSync: 11,
          identity: 9,
          mouthNaturalness: 7,
          skinStability: 6,
          motion: 8,
          audio: 10,
        },
        note: "invalid",
        updatedAt: completedAt.toISOString(),
      },
    }));

    const output = new OutputLibrary(root).list([job]).find((candidate) => candidate.name === outputName)!;
    expect(output.settingsAvailable).toBe(true);
    expect(output.request).toEqual(job.request);
    expect(output.qualityReview).toBeNull();
  });

  it("deletes an output together with settings, analysis, and matching report", async () => {
    const root = await outputRoot();
    const outputName = "obsolete-speech.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, "2026-07-24T10:00:00.000Z", "audio-to-video");
    publishCompletedJob(root, job);
    library.recordCompleted([job]);
    const target = library.resolveAnalysisTarget(outputName);
    writeOutputAnalysis(root, {
      schemaVersion: "ltx-studio-output-analysis.v1",
      outputName,
      sizeBytes: target.sizeBytes,
      modifiedAtMs: target.modifiedAtMs,
      changedAtMs: target.changedAtMs,
      fileId: target.fileId,
      jobId: target.jobId,
      analysisId: "4c8a5dc6-8864-49f7-a639-85caef918888",
      attempt: 1,
      status: "failed",
      progress: 10,
      createdAt: "2026-07-24T10:00:01.000Z",
      startedAt: "2026-07-24T10:00:01.000Z",
      finishedAt: "2026-07-24T10:00:02.000Z",
      updatedAt: "2026-07-24T10:00:02.000Z",
      error: { code: "test", message: "Test record." },
      result: null,
    });
    await writeFile(join(root, "obsolete-speech.report.json"), "{}");

    const deleted = library.delete(outputName, [job]);

    expect(deleted).toMatchObject({ name: outputName, sizeBytes: 5 });
    expect(deleted.deletedArtifacts.sort()).toEqual([
      outputName,
      `${outputName}.ltx-analysis.json`,
      `${outputName}.ltx-publication.json`,
      `${outputName}.ltx-settings.json`,
      "obsolete-speech.report.json",
    ].sort());
    await expect(stat(join(root, outputName))).rejects.toMatchObject({ code: "ENOENT" });
    expect(library.list([job])).toEqual([]);
  });

  it("refuses deletion for invalid names, missing files, and active jobs", async () => {
    const root = await outputRoot();
    const outputName = "active-output.mp4";
    await writeFile(join(root, outputName), "video");
    const activeJob = completedJob(outputName, "2026-07-24T10:05:00.000Z");
    activeJob.status = "running";
    const library = new OutputLibrary(root);

    expect(() => library.delete("../active-output.mp4", [])).toThrow("Ausgabe nicht gefunden");
    expect(() => library.delete("missing-output.mp4", [])).toThrow("Ausgabe nicht gefunden");
    expect(() => library.delete(outputName, [activeJob])).toThrow("aktiven Job");
    expect((await stat(join(root, outputName))).isFile()).toBe(true);
  });
});
