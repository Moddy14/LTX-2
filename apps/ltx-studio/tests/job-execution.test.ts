import { describe, expect, it } from "vitest";

import {
  executionDescriptorThreatModel,
  jobExecutionDecisionIsMonotone,
  normalizeJobExecutionDecision,
  type JobExecutionDecision,
} from "../shared/jobExecution.js";

function cpuDecision(
  state: "prepared" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted" = "prepared",
): JobExecutionDecision {
  const revision = {
    sizeBytes: 1024,
    modifiedAtMs: 1_777_000_000_000,
    changedAtMs: 1_777_000_000_001,
    fileId: "42",
    deviceId: "7",
    mode: 0o100400,
    uid: 1000,
    gid: 1000,
    nlink: 1 as const,
  };
  const running = state !== "prepared";
  const terminal = ["succeeded", "failed", "cancelled", "interrupted"].includes(state);
  return {
    schemaVersion: "ltx-studio-execution-decision.v5",
    executionClass: "cpu-only",
    decidedAt: "2026-08-25T10:00:00.000Z",
    reason: "Exact frozen baseline copied and reverified before FFmpeg.",
    requestSha256: "1".repeat(64),
    protocolSha256: "2".repeat(64),
    cpuReuse: {
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "baseline.mp4",
      baselineRequestSha256: "3".repeat(64),
      sourceOutputPath: "/outputs/baseline.mp4",
      outputSha256: "4".repeat(64),
      outputRevision: revision,
      settingsSidecarPath: "/outputs/baseline.mp4.ltx-settings.json",
      settingsSidecarSha256: "5".repeat(64),
      settingsSidecarRevision: { ...revision, fileId: "43" },
      analysisSidecarPath: "/outputs/baseline.mp4.ltx-analysis.json",
      analysisSidecarSha256: "6".repeat(64),
      analysisSidecarRevision: { ...revision, fileId: "44" },
      sourceProvenanceFingerprint: "7".repeat(64),
      sourceProgramAudioDelayMs: 0,
      snapshotOutputPath: "/private/job/reused-lipforcing-output.mp4",
      snapshotOutputSha256: "4".repeat(64),
      snapshotOutputRevision: { ...revision, fileId: "45" },
      snapshotSettingsSidecarPath: "/private/job/reused-lipforcing-output.ltx-settings.json",
      snapshotSettingsSidecarSha256: "5".repeat(64),
      snapshotSettingsSidecarRevision: { ...revision, fileId: "46" },
      snapshotAnalysisSidecarPath: "/private/job/reused-lipforcing-output.ltx-analysis.json",
      snapshotAnalysisSidecarSha256: "6".repeat(64),
      snapshotAnalysisSidecarRevision: { ...revision, fileId: "47" },
    },
    operation: {
      kind: "ffmpeg-audio-retime",
      state,
      descriptorThreatModel: executionDescriptorThreatModel,
      executable: {
        path: "/usr/bin/ffmpeg",
        sha256: "8".repeat(64),
        revision: { ...revision, fileId: "100", mode: 0o100755 },
      },
      ffmpegVersion: "ffmpeg version 7.1",
      argsSha256: "9".repeat(64),
      deltaMs: 80,
      preparedAt: "2026-08-25T10:00:01.000Z",
      startedAt: running ? "2026-08-25T10:00:02.000Z" : null,
      completedAt: terminal ? "2026-08-25T10:00:03.000Z" : null,
      exitCode: state === "succeeded" ? 0 : state === "failed" ? 70 : null,
      signal: null,
      errorSha256: state === "failed" ? "a".repeat(64) : null,
      output: state === "succeeded"
        ? {
            path: "/private/job/audio-retimed-output.mp4",
            sha256: "b".repeat(64),
            revision: { ...revision, fileId: "101" },
          }
        : null,
    },
  };
}

function pairedDecision(
  state: "prepared" | "running" | "succeeded" = "prepared",
): JobExecutionDecision {
  const revision = {
    sizeBytes: 1024,
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
    path,
    sha256,
    revision: { ...revision, fileId },
  });
  const running = state !== "prepared";
  const succeeded = state === "succeeded";
  return {
    schemaVersion: "ltx-studio-execution-decision.v6",
    executionClass: "cpu-only",
    decidedAt: "2026-08-26T10:00:00.000Z",
    reason: "Exact paired artifact promotion.",
    requestSha256: "1".repeat(64),
    protocolSha256: "2".repeat(64),
    cpuReuse: {
      reuseKind: "lipforcing-raw-mux-pair",
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "baseline.mp4",
      baselineRequestSha256: "3".repeat(64),
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
    },
    operation: {
      kind: "paired-artifact-promotion",
      state,
      descriptorThreatModel: executionDescriptorThreatModel,
      authoritySha256: "5".repeat(64),
      preparedAt: "2026-08-26T10:00:01.000Z",
      startedAt: running ? "2026-08-26T10:00:02.000Z" : null,
      completedAt: succeeded ? "2026-08-26T10:00:03.000Z" : null,
      exitCode: succeeded ? 0 : null,
      signal: null,
      errorSha256: null,
      output: succeeded
        ? file("/private/candidate/promoted.tmp.mp4", "9".repeat(64), "216")
        : null,
    },
  };
}

describe("ExecutionDecision.v5", () => {
  it("accepts prepared -> running -> succeeded and freezes every terminal operation", () => {
    const prepared = cpuDecision("prepared");
    const running = cpuDecision("running");
    const succeeded = cpuDecision("succeeded");

    expect(normalizeJobExecutionDecision(prepared)).toEqual(prepared);
    expect(normalizeJobExecutionDecision(running)).toEqual(running);
    expect(normalizeJobExecutionDecision(succeeded)).toEqual(succeeded);
    expect(jobExecutionDecisionIsMonotone(prepared, running)).toBe(true);
    expect(jobExecutionDecisionIsMonotone(running, succeeded)).toBe(true);
    expect(jobExecutionDecisionIsMonotone(succeeded, running)).toBe(false);
  });

  it("requires pending -> CPU prepared -> running -> terminal without shortcuts", () => {
    const pending: JobExecutionDecision = {
      schemaVersion: "ltx-studio-execution-decision.v5",
      executionClass: "pending",
      decidedAt: "2026-08-25T09:59:00.000Z",
      reason: "Durably admitted.",
      requestSha256: "1".repeat(64),
      protocolSha256: "2".repeat(64),
      cpuReuse: null,
      operation: null,
    };
    expect(jobExecutionDecisionIsMonotone(undefined, pending)).toBe(true);
    expect(jobExecutionDecisionIsMonotone(undefined, cpuDecision("prepared"))).toBe(false);
    expect(jobExecutionDecisionIsMonotone(pending, cpuDecision("prepared"))).toBe(true);
    expect(jobExecutionDecisionIsMonotone(pending, cpuDecision("running"))).toBe(false);
    expect(jobExecutionDecisionIsMonotone(pending, cpuDecision("succeeded"))).toBe(false);
    expect(jobExecutionDecisionIsMonotone(cpuDecision("prepared"), cpuDecision("succeeded"))).toBe(false);
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "accepts a durable %s terminal operation independently of publication/job success",
    (state) => {
      const running = cpuDecision("running");
      const terminal = cpuDecision(state);
      expect(normalizeJobExecutionDecision(terminal)).toEqual(terminal);
      expect(jobExecutionDecisionIsMonotone(running, terminal)).toBe(true);
    },
  );

  it("rejects old v3 authority, executable mode drift, and output on a failed operation", () => {
    const legacy = structuredClone(cpuDecision("prepared")) as unknown as Record<string, unknown>;
    legacy.schemaVersion = "ltx-studio-execution-decision.v3";
    expect(normalizeJobExecutionDecision(legacy)).toBeNull();

    const modeDrift = structuredClone(cpuDecision("prepared"));
    if (modeDrift.executionClass !== "cpu-only"
      || modeDrift.operation.kind !== "ffmpeg-audio-retime") throw new Error("fixture");
    modeDrift.operation.executable.revision.mode = -1;
    expect(normalizeJobExecutionDecision(modeDrift)).toBeNull();

    const hardlinked = structuredClone(cpuDecision("prepared"));
    if (hardlinked.executionClass !== "cpu-only"
      || hardlinked.operation.kind !== "ffmpeg-audio-retime") throw new Error("fixture");
    hardlinked.operation.executable.revision.nlink = 2 as 1;
    expect(normalizeJobExecutionDecision(hardlinked)).toBeNull();

    const failedWithOutput = structuredClone(cpuDecision("failed"));
    const succeeded = cpuDecision("succeeded");
    if (failedWithOutput.executionClass !== "cpu-only" || succeeded.executionClass !== "cpu-only") {
      throw new Error("fixture");
    }
    failedWithOutput.operation.output = succeeded.operation.output;
    expect(normalizeJobExecutionDecision(failedWithOutput)).toBeNull();
  });
});

describe("ExecutionDecision.v6 paired artifact authority", () => {
  it("accepts only pending -> prepared -> running -> succeeded monotonically", () => {
    const pending: JobExecutionDecision = {
      schemaVersion: "ltx-studio-execution-decision.v6",
      executionClass: "pending",
      decidedAt: "2026-08-26T09:59:00.000Z",
      reason: "Durably admitted.",
      requestSha256: "1".repeat(64),
      protocolSha256: "2".repeat(64),
      cpuReuse: null,
      operation: null,
    };
    const prepared = pairedDecision("prepared");
    const running = pairedDecision("running");
    const succeeded = pairedDecision("succeeded");
    expect(normalizeJobExecutionDecision(prepared)).toEqual(prepared);
    expect(normalizeJobExecutionDecision(running)).toEqual(running);
    expect(normalizeJobExecutionDecision(succeeded)).toEqual(succeeded);
    expect(jobExecutionDecisionIsMonotone(pending, prepared)).toBe(true);
    expect(jobExecutionDecisionIsMonotone(prepared, running)).toBe(true);
    expect(jobExecutionDecisionIsMonotone(running, succeeded)).toBe(true);
    expect(jobExecutionDecisionIsMonotone(prepared, succeeded)).toBe(false);
  });

  it("keeps v5 historical semantics closed and binds operation to the exact authority digest", () => {
    const wrongVersion = structuredClone(pairedDecision("prepared")) as unknown as Record<string, unknown>;
    wrongVersion.schemaVersion = "ltx-studio-execution-decision.v5";
    expect(normalizeJobExecutionDecision(wrongVersion)).toBeNull();

    const wrongAuthority = structuredClone(pairedDecision("prepared"));
    if (wrongAuthority.executionClass !== "cpu-only"
      || wrongAuthority.operation.kind !== "paired-artifact-promotion") throw new Error("fixture");
    wrongAuthority.operation.authoritySha256 = "f".repeat(64);
    expect(normalizeJobExecutionDecision(wrongAuthority)).toBeNull();
  });
});
