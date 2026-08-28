import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { toPublicStudioJob } from "../server/publicJob.js";
import {
  executionDescriptorThreatModel,
  type JobExecutionDecision,
} from "../shared/jobExecution.js";
import type { RunProvenance } from "../shared/provenance.js";
import type { StudioJob } from "../server/jobs.js";
import { validRequest } from "./fixtures.js";

function privateCpuDecision(): JobExecutionDecision {
  const revision = {
    sizeBytes: 1_024,
    modifiedAtMs: 1_777_000_000_000,
    changedAtMs: 1_777_000_000_001,
    fileId: "42",
    deviceId: "7",
    mode: 0o100400,
    uid: 1000,
    gid: 1000,
    nlink: 1 as const,
  };
  return {
    schemaVersion: "ltx-studio-execution-decision.v5",
    executionClass: "cpu-only",
    decidedAt: "2026-08-25T10:00:00.000Z",
    reason: `Verified source at /private/authority/snapshot.mp4 digest ${"f".repeat(64)} ${"bounded ".repeat(80)}`,
    requestSha256: "1".repeat(64),
    protocolSha256: "2".repeat(64),
    cpuReuse: {
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "baseline-visible-label.mp4",
      baselineRequestSha256: "3".repeat(64),
      sourceOutputPath: "/private/source/baseline.mp4",
      outputSha256: "4".repeat(64),
      outputRevision: revision,
      settingsSidecarPath: "/private/source/baseline.ltx-settings.json",
      settingsSidecarSha256: "5".repeat(64),
      settingsSidecarRevision: { ...revision, fileId: "43" },
      analysisSidecarPath: "/private/source/baseline.ltx-analysis.json",
      analysisSidecarSha256: "6".repeat(64),
      analysisSidecarRevision: { ...revision, fileId: "44" },
      sourceProvenanceFingerprint: "7".repeat(64),
      sourceProgramAudioDelayMs: 125,
      snapshotOutputPath: "/private/authority/reused.mp4",
      snapshotOutputSha256: "4".repeat(64),
      snapshotOutputRevision: { ...revision, fileId: "45" },
      snapshotSettingsSidecarPath: "/private/authority/reused.ltx-settings.json",
      snapshotSettingsSidecarSha256: "5".repeat(64),
      snapshotSettingsSidecarRevision: { ...revision, fileId: "46" },
      snapshotAnalysisSidecarPath: "/private/authority/reused.ltx-analysis.json",
      snapshotAnalysisSidecarSha256: "6".repeat(64),
      snapshotAnalysisSidecarRevision: { ...revision, fileId: "47" },
    },
    operation: {
      kind: "ffmpeg-audio-retime",
      state: "succeeded",
      descriptorThreatModel: executionDescriptorThreatModel,
      executable: {
        path: "/private/toolchain/ffmpeg",
        sha256: "8".repeat(64),
        revision: { ...revision, fileId: "100", mode: 0o100755 },
      },
      ffmpegVersion: "ffmpeg private-build 7.1",
      argsSha256: "9".repeat(64),
      deltaMs: 25,
      preparedAt: "2026-08-25T10:00:01.000Z",
      startedAt: "2026-08-25T10:00:02.000Z",
      completedAt: "2026-08-25T10:00:03.000Z",
      exitCode: 0,
      signal: null,
      errorSha256: null,
      output: {
        path: "/private/authority/retimed.mp4",
        sha256: "a".repeat(64),
        revision: { ...revision, fileId: "101" },
      },
    },
  };
}

function privatePairedDecision(): JobExecutionDecision {
  const revision = {
    sizeBytes: 1_024,
    modifiedAtMs: 1_777_000_000_000,
    changedAtMs: 1_777_000_000_001,
    fileId: "200",
    deviceId: "7",
    mode: 0o100400,
    uid: 1000,
    gid: 1000,
    nlink: 1 as const,
  };
  const file = (path: string, sha256: string, fileId: string) => ({
    path, sha256, revision: { ...revision, fileId },
  });
  return {
    schemaVersion: "ltx-studio-execution-decision.v6",
    executionClass: "cpu-only",
    decidedAt: "2026-08-26T10:00:00.000Z",
    reason: "Private /sealed/raw-mux-pair authority was verified.",
    requestSha256: "1".repeat(64),
    protocolSha256: "2".repeat(64),
    cpuReuse: {
      reuseKind: "lipforcing-raw-mux-pair",
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "paired-baseline.mp4",
      baselineRequestSha256: "3".repeat(64),
      sourceProvenanceFingerprint: "4".repeat(64),
      authority: file("/sealed/raw-mux-pair/authority.json", "5".repeat(64), "201"),
      receipt: file("/sealed/raw-mux-pair/pair-receipt.json", "6".repeat(64), "202"),
      timelineReceipt: file("/sealed/raw-mux-pair/timeline-receipt.json", "7".repeat(64), "203"),
      preMux: file("/sealed/raw-mux-pair/pre-mux.mp4", "8".repeat(64), "204"),
      preMuxReceipt: file("/sealed/raw-mux-pair/pre-mux-receipt.json", "a".repeat(64), "206"),
      candidateFinal: file("/sealed/raw-mux-pair/candidate-final.mp4", "9".repeat(64), "205"),
      snapshotAuthority: file("/sealed/candidate/authority.json", "5".repeat(64), "211"),
      snapshotReceipt: file("/sealed/candidate/pair-receipt.json", "6".repeat(64), "212"),
      snapshotTimelineReceipt: file("/sealed/candidate/timeline-receipt.json", "7".repeat(64), "213"),
      snapshotPreMux: file("/sealed/candidate/pre-mux.mp4", "8".repeat(64), "214"),
      snapshotPreMuxReceipt: file("/sealed/candidate/pre-mux-receipt.json", "a".repeat(64), "216"),
      snapshotCandidateFinal: file("/sealed/candidate/candidate-final.mp4", "9".repeat(64), "215"),
    },
    operation: {
      kind: "paired-artifact-promotion",
      state: "succeeded",
      descriptorThreatModel: executionDescriptorThreatModel,
      authoritySha256: "5".repeat(64),
      preparedAt: "2026-08-26T10:00:01.000Z",
      startedAt: "2026-08-26T10:00:02.000Z",
      completedAt: "2026-08-26T10:00:03.000Z",
      exitCode: 0,
      signal: null,
      errorSha256: null,
      output: file("/sealed/candidate/promoted.mp4", "9".repeat(64), "216"),
    },
  };
}

function privateProvenance(decision: JobExecutionDecision): RunProvenance {
  return {
    schemaVersion: "ltx-studio-run-provenance.v2",
    capturedAt: "2026-08-25T10:00:00.000Z",
    verifiedAt: "2026-08-25T10:00:04.000Z",
    files: [{
      role: "private-snapshot",
      path: "/private/authority/reused.mp4",
      kind: "file",
      sizeBytes: 1_024,
      modifiedAtMs: 1,
      changedAtMs: 2,
      fileId: "42",
      sha256: "b".repeat(64),
      entries: [],
    }],
    code: [],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "private-kernel",
      nodeVersion: "private-node",
      pythonExecutable: "/private/runtime/python",
      pythonVersion: "private-python",
      packages: { private: "1.0" },
      ffmpegVersion: "private-ffmpeg",
      fingerprint: "c".repeat(64),
    },
    upstreamContracts: [{
      role: "private-upstream",
      repository: "private-repository",
      commit: "private-commit",
      path: "/private/upstream/workflow.json",
      sha256: "d".repeat(64),
    }],
    release: {
      sealed: true,
      verified: true,
      releaseDigest: "e".repeat(64),
      manifestSha256: "f".repeat(64),
      surfaceDigest: "0".repeat(64),
      sourceCommit: "private-source-commit",
      runtimeInstallSealSha256: "1".repeat(64),
      runtimeTreeSha256: "2".repeat(64),
      runtimePolicySha256: "3".repeat(64),
      nodeExecutableSha256: "4".repeat(64),
      expectedHostTcbAttestationSha256: "5".repeat(64),
    },
    executionDecision: structuredClone(decision),
    fingerprint: "6".repeat(64),
  };
}

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
}

describe("public StudioJob DTO", () => {
  it("publishes only the normalized DGX memory-wait allowlist", () => {
    const request = validRequest();
    const internal = {
      id: "33333333-3333-4333-8333-333333333335",
      status: "queued",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: "2026-08-28T06:25:00.000Z",
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      logs: [],
      command: "",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: null,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: "dgx-job-20260828-083000-0123456789ab",
      dgxMemoryWait: {
        schemaVersion: "ltx-studio-dgx-memory-wait.v1",
        kind: "memory",
        observedAt: "2026-08-28T06:30:00.000Z",
        availableGiB: 43.32,
        pendingReservationsGiB: 0,
        requiredAvailableGiB: 94,
        currentShortfallGiB: 50.68,
        qwenPagingReservedGiB: null,
        qwenRestoreReservedGiB: null,
        raw_secret: "must-not-cross-public-boundary",
      },
      identityEvidence: null,
      runProvenance: null,
    } as unknown as StudioJob;

    const dto = toPublicStudioJob(internal);

    expect(dto.dgxMemoryWait).toEqual({
      schemaVersion: "ltx-studio-dgx-memory-wait.v1",
      kind: "memory",
      observedAt: "2026-08-28T06:30:00.000Z",
      availableGiB: 43.32,
      pendingReservationsGiB: 0,
      requiredAvailableGiB: 94,
      currentShortfallGiB: 50.68,
      qwenPagingReservedGiB: null,
      qwenRestoreReservedGiB: null,
    });
    expect(JSON.stringify(dto)).not.toContain("raw_secret");
    expect(JSON.stringify(dto)).not.toContain("must-not-cross-public-boundary");
  });

  it.each(["settling", "settled"] as const)(
    "preserves the non-sensitive cancellation settlement state %s",
    (cancellationState) => {
      const request = validRequest();
      const dto = toPublicStudioJob({
        id: "33333333-3333-4333-8333-333333333334",
        status: "cancelled",
        mode: request.mode,
        prompt: request.prompt,
        outputName: request.outputName,
        outputUrl: null,
        createdAt: "2026-08-25T10:00:00.000Z",
        startedAt: "2026-08-25T10:00:01.000Z",
        finishedAt: "2026-08-25T10:00:02.000Z",
        progress: 42,
        error: null,
        logs: [],
        command: "",
        request,
        favorite: false,
        variantOf: null,
        experiment: null,
        project: null,
        runtimeMs: 1_000,
        cancelledBy: "studio",
        cancellationState,
        thermalProfile: null,
        dgxJobId: null,
        identityEvidence: null,
        runProvenance: null,
      } as StudioJob);

      expect(dto.cancellationState).toBe(cancellationState);
    },
  );

  it("recursively excludes private authority documents while preserving bounded UI summaries", () => {
    const decision = privateCpuDecision();
    const request = validRequest("audio-to-video");
    const internal = {
      id: "22222222-2222-4222-8222-222222222222",
      status: "completed",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: "/api/jobs/22222222-2222-4222-8222-222222222222/output",
      createdAt: "2026-08-25T09:59:00.000Z",
      startedAt: "2026-08-25T10:00:00.000Z",
      finishedAt: "2026-08-25T10:00:03.000Z",
      progress: 100,
      error: null,
      logs: ["Renderer read local operator input /uploads/reference.png."],
      command: "/usr/bin/python -m ltx_pipelines --image /uploads/reference.png",
      request,
      favorite: false,
      variantOf: null,
      experiment: {
        schemaVersion: "ltx-studio-experiment-run.v1",
        experimentId: "44444444-4444-4444-8444-444444444444",
        protocolSha256: "7".repeat(64),
        arm: "candidate",
        kind: "ablation",
        variableId: "a2v-guidance",
        changedRequestPaths: ["videoGuidance.modalityScale"],
        baselineRequestSha256: "8".repeat(64),
        requestSha256: "9".repeat(64),
        baselineJobId: "11111111-1111-4111-8111-111111111111",
        baselineOutputName: "baseline-visible-label.mp4",
      },
      project: {
        schemaVersion: "ltx-studio-project-run.v1",
        projectId: "55555555-5555-4555-8555-555555555555",
        projectRevision: 3,
        projectRevisionSha256: "a".repeat(64),
        shotId: "66666666-6666-4666-8666-666666666666",
        requestRevisionId: "77777777-7777-4777-8777-777777777777",
        requestSha256: "b".repeat(64),
        continuity: null,
      },
      runtimeMs: 3_000,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: null,
      identityEvidence: { private: "authority-input" },
      runProvenance: privateProvenance(decision),
      executionClass: "cpu-only",
      executionDecision: decision,
      outputPublication: { private: "publication-authority" },
    } as unknown as StudioJob;

    const dto = toPublicStudioJob(internal);
    const keys = new Set(allKeys(dto));
    const forbiddenKeys = [
      "identityEvidence", "runProvenance", "executionDecision", "outputPublication",
      "sourceOutputPath", "settingsSidecarPath", "analysisSidecarPath",
      "snapshotOutputPath", "snapshotSettingsSidecarPath", "snapshotAnalysisSidecarPath",
      "sourceProvenanceFingerprint", "executable", "revision", "uid", "gid",
      "fileId", "deviceId", "requestSha256", "protocolSha256", "argsSha256",
      "outputSha256", "settingsSidecarSha256", "analysisSidecarSha256",
      "baselineRequestSha256", "projectRevisionSha256", "provenanceFingerprint",
    ];
    for (const key of forbiddenKeys) expect(keys.has(key), key).toBe(false);

    const serialized = JSON.stringify(dto);
    for (const privateAuthorityValue of [
      "/private/authority/", "/private/source/", "/private/toolchain/",
      "/private/runtime/", "/private/upstream/",
    ]) {
      expect(serialized).not.toContain(privateAuthorityValue);
    }
    expect(serialized).not.toContain("private-source-commit");
    for (const authorityDigest of ["7", "8", "9", "a", "b"]) {
      expect(serialized).not.toContain(authorityDigest.repeat(64));
    }
    // Local operator data remains intentionally visible; this mapper is not a
    // generic path scrubber and must not be described as one.
    expect(dto.command).toContain("/uploads/reference.png");
    expect(dto.logs[0]).toContain("/uploads/reference.png");
    expect(dto.runProvenanceSummary).toEqual({
      schemaVersion: "ltx-studio-public-run-provenance-summary.v1",
      status: "verified",
      capturedAt: "2026-08-25T10:00:00.000Z",
      verifiedAt: "2026-08-25T10:00:04.000Z",
      release: { sealed: true, verified: true },
    });
    expect(dto.executionDecisionSummary).toMatchObject({
      executionClass: "cpu-only",
      verificationStatus: "verified",
      cpuReuse: {
        baselineLabel: "baseline-visible-label.mp4",
        sourceProgramAudioDelayMs: 125,
        appliedDeltaMs: 25,
        operationState: "succeeded",
      },
    });
    expect(dto.executionDecisionSummary?.reason).toContain("<redacted-path>");
    expect(dto.executionDecisionSummary?.reason).toContain("<redacted-digest>");
    expect(dto.executionDecisionSummary?.reason).not.toContain("f".repeat(64));
    expect(dto.executionDecisionSummary?.reason.length).toBeLessThanOrEqual(240);
    expect(dto.experiment).toMatchObject({
      schemaVersion: "ltx-studio-public-experiment-run.v1",
      experimentId: "44444444-4444-4444-8444-444444444444",
      protocolEqualityToken: expect.stringMatching(/^eq1_/),
      baselineRequestEqualityToken: expect.stringMatching(/^eq1_/),
      requestEqualityToken: expect.stringMatching(/^eq1_/),
    });
    expect(dto.project).toMatchObject({
      schemaVersion: "ltx-studio-public-project-run.v1",
      projectId: "55555555-5555-4555-8555-555555555555",
      projectRevisionEqualityToken: expect.stringMatching(/^eq1_/),
      requestEqualityToken: expect.stringMatching(/^eq1_/),
    });
  });

  it("exposes paired promotion only as a bounded CPU summary with no private authority fields", () => {
    const decision = privatePairedDecision();
    const request = validRequest("image-audio-to-video");
    const job = {
      id: "22222222-2222-4222-8222-222222222222",
      status: "completed",
      mode: request.mode,
      prompt: request.prompt,
      outputName: "paired-candidate.mp4",
      outputUrl: "/api/jobs/22222222-2222-4222-8222-222222222222/output",
      createdAt: "2026-08-26T09:59:00.000Z",
      startedAt: "2026-08-26T10:00:00.000Z",
      finishedAt: "2026-08-26T10:00:03.000Z",
      progress: 100,
      error: null,
      logs: [],
      command: "paired-artifact-promotion",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: 3_000,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: null,
      identityEvidence: null,
      runProvenance: privateProvenance(decision),
      executionClass: "cpu-only",
      executionDecision: decision,
    } as StudioJob;

    const dto = toPublicStudioJob(job);
    expect(dto.executionDecisionSummary).toMatchObject({
      executionClass: "cpu-only",
      verificationStatus: "verified",
      cpuReuse: {
        baselineLabel: "paired-baseline.mp4",
        operationKind: "paired-artifact-promotion",
        sourceProgramAudioDelayMs: null,
        appliedDeltaMs: null,
        operationState: "succeeded",
      },
    });
    const keys = new Set(allKeys(dto));
    for (const key of [
      "authority", "receipt", "timelineReceipt", "preMux", "candidateFinal",
      "snapshotAuthority", "snapshotCandidateFinal", "authoritySha256", "revision",
    ]) expect(keys.has(key), key).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("/sealed/");
  });

  it("fails closed to no decision summary for malformed internal authority", () => {
    const request = validRequest();
    const dto = toPublicStudioJob({
      id: "33333333-3333-4333-8333-333333333333",
      status: "failed",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: "2026-08-25T10:00:00.000Z",
      startedAt: null,
      finishedAt: "2026-08-25T10:00:01.000Z",
      progress: null,
      error: "invalid authority",
      logs: [],
      command: "",
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
      executionClass: "cpu-only",
      executionDecision: { schemaVersion: "forged" } as unknown as JobExecutionDecision,
    });
    expect(dto.executionDecisionSummary).toBeNull();
  });

  it("routes every REST job response and the SSE stream through the public allowlist", () => {
    const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    expect(source).toContain("response.json({ jobs: toPublicStudioJobs(jobs.list()) })");
    expect(source).toContain("job: toPublicStudioJob(jobs.create(run.request, { project: run.binding }))");
    expect(source).toContain("job: toPublicStudioJob(job)");
    expect(source).toContain("deleted: toPublicStudioJob(job)");
    expect(source).toContain("JSON.stringify(toPublicStudioJobs(value))");
    expect(source).not.toContain("response.json({ jobs: jobs.list() })");
    expect(source).not.toContain("release: releaseIdentity,");
  });
});
