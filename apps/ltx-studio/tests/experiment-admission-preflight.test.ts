import { describe, expect, it, vi } from "vitest";

import { experimentAdmissionPreflight } from "../server/experimentAdmissionPreflight.js";
import { sha256Json, requestSettingsSha256 } from "../server/experimentStore.js";
import type { IdentityInputEvidence } from "../server/inputEvidence.js";
import type { ReusableLtxBaseCandidate } from "../server/jobs.js";
import type {
  ControlledExperiment,
  ExperimentRunBinding,
} from "../shared/experiments.js";
import type { StudioOutput } from "../shared/outputs.js";
import type { RunProvenance } from "../shared/provenance.js";
import { validRequest } from "./fixtures.js";

const BASELINE_JOB_ID = "11111111-1111-4111-8111-111111111111";
const EXPERIMENT_ID = "22222222-2222-4222-8222-222222222222";
const CHECKED_AT = "2026-08-25T12:00:00.000Z";

function identityEvidence(): IdentityInputEvidence {
  return {
    schemaVersion: "ltx-studio-identity-evidence.v1",
    status: "verified",
    source: "image-conditioning",
    capturedAt: "2026-08-25T10:00:00.000Z",
    verifiedAt: "2026-08-25T10:01:00.000Z",
    reason: null,
    references: [{
      assetId: "33333333-3333-4333-8333-333333333333",
      kind: "image",
      sizeBytes: 2_048,
      modifiedAtMs: 1_777_000_000_000,
      changedAtMs: 1_777_000_000_001,
      fileId: "42",
      sha256: "3".repeat(64),
    }],
  };
}

function runProvenance(): RunProvenance {
  return {
    schemaVersion: "ltx-studio-run-provenance.v1",
    capturedAt: "2026-08-25T10:00:00.000Z",
    verifiedAt: "2026-08-25T10:05:00.000Z",
    files: [],
    code: [],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "test",
      nodeVersion: "test",
      pythonExecutable: "/python",
      pythonVersion: "3.12",
      packages: {},
      ffmpegVersion: "test",
      fingerprint: "4".repeat(64),
    },
    fingerprint: "5".repeat(64),
  };
}

function fixture(): {
  experiment: ControlledExperiment;
  binding: ExperimentRunBinding;
  output: StudioOutput;
  sidecar: ReusableLtxBaseCandidate;
} {
  const baseline = validRequest("image-audio-to-video");
  baseline.outputName = "verified-lipforcing-baseline.mp4";
  baseline.postprocess.lipForcing.enabled = true;
  baseline.postprocess.lipForcing.mouthDelayMs = 125;
  baseline.postprocess.lipForcing.programAudioDelayMs = 125;
  const candidate = structuredClone(baseline);
  candidate.outputName = "verified-lipforcing-candidate.mp4";
  candidate.postprocess.lipForcing.programAudioDelayMs = 150;
  const provenance = runProvenance();
  const evidence = identityEvidence();
  const baselineRequestSha256 = sha256Json(baseline);
  const output: StudioOutput = {
    name: baseline.outputName,
    url: `/api/outputs/${baseline.outputName}`,
    sizeBytes: 4_096,
    modifiedAt: "2026-08-25T10:10:00.000Z",
    changedAt: "2026-08-25T10:10:00.000Z",
    fileId: "77",
    jobId: BASELINE_JOB_ID,
    jobStatus: "completed",
    request: baseline,
    settingsAvailable: true,
    qualityReview: null,
    analysis: null,
    provenance,
    experiment: null,
    project: null,
    experimentRequestVerified: false,
  };
  const experiment: ControlledExperiment = {
    schemaVersion: "ltx-studio-experiment.v1",
    id: EXPERIMENT_ID,
    title: "Hörbarer Tonversatz 125 gegen 150 ms",
    claimScope: "development",
    status: "frozen",
    kind: "ablation",
    candidate: { variable: "lipforcing-program-audio-delay-ms", value: 150 },
    changedRequestPaths: ["postprocess.lipForcing.programAudioDelayMs"],
    createdAt: "2026-08-25T11:00:00.000Z",
    frozenAt: "2026-08-25T11:01:00.000Z",
    supersededAt: null,
    supersededReason: null,
    replacementExperimentId: null,
    baselineEvidence: {
      outputName: output.name,
      jobId: BASELINE_JOB_ID,
      sizeBytes: output.sizeBytes,
      changedAt: output.changedAt,
      fileId: output.fileId,
      provenanceFingerprint: provenance.fingerprint,
    },
    protocolSha256: "6".repeat(64),
    arms: [{
      arm: "baseline",
      request: baseline,
      requestSha256: baselineRequestSha256,
      settingsSha256: requestSettingsSha256(baseline),
      jobId: BASELINE_JOB_ID,
      attemptJobIds: [BASELINE_JOB_ID],
    }, {
      arm: "candidate",
      request: candidate,
      requestSha256: sha256Json(candidate),
      settingsSha256: requestSettingsSha256(candidate),
      jobId: null,
      attemptJobIds: [],
    }],
  };
  const binding: ExperimentRunBinding = {
    schemaVersion: "ltx-studio-experiment-run.v1",
    experimentId: experiment.id,
    protocolSha256: experiment.protocolSha256!,
    arm: "candidate",
    kind: experiment.kind,
    variableId: experiment.candidate.variable,
    changedRequestPaths: experiment.changedRequestPaths,
    baselineRequestSha256: experiment.arms[0].requestSha256,
    requestSha256: experiment.arms[1].requestSha256,
    baselineJobId: BASELINE_JOB_ID,
    baselineOutputName: baseline.outputName,
    adoptedBaseline: true,
  };
  return {
    experiment,
    binding,
    output,
    sidecar: {
      outputName: output.name,
      outputPath: `/outputs/${output.name}`,
      jobId: BASELINE_JOB_ID,
      request: baseline,
      identityEvidence: evidence,
      runProvenance: provenance,
    },
  };
}

describe("experimentAdmissionPreflight", () => {
  it("short-circuits a regular DFR arm before any admission call", async () => {
    const value = fixture();
    value.experiment.candidate = { variable: "replicate-seed", value: 23_072_027 };
    value.experiment.changedRequestPaths = ["seed"];
    value.experiment.arms[1].request = validRequest("dfr");
    const regular = vi.fn();

    const report = await experimentAdmissionPreflight(
      value.experiment,
      "candidate",
      { binding: value.binding, outputs: [], reusableCandidates: [] },
      regular,
      CHECKED_AT,
    );

    expect(regular).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      checkedAt: CHECKED_AT,
      verdict: "hold",
      steps: [{ decision: "dfr-v1.3-qualification-hold", accepted: false }],
    });
  });

  it("short-circuits DFR before the CPU-only raw-mux authority path", async () => {
    const value = fixture();
    value.experiment.candidate = { variable: "lipforcing-raw-output-profile" };
    value.experiment.changedRequestPaths = ["postprocess.lipForcing.rawOutputProfile"];
    value.experiment.arms[1].request = validRequest("dfr");
    const regular = vi.fn();
    const verifyRawMuxPairAuthority = vi.fn(() => ({ description: "must not run" }));

    const report = await experimentAdmissionPreflight(
      value.experiment,
      "candidate",
      {
        binding: value.binding,
        outputs: [],
        reusableCandidates: [],
        verifyRawMuxPairAuthority,
      },
      regular,
      CHECKED_AT,
    );

    expect(regular).not.toHaveBeenCalled();
    expect(verifyRawMuxPairAuthority).not.toHaveBeenCalled();
    expect(report.verdict).toBe("hold");
    expect(report.executionClass).toBeUndefined();
  });

  it("reports CPU-only only for the exact bound, verified baseline sidecar", async () => {
    const { experiment, binding, output, sidecar } = fixture();
    const regular = vi.fn();

    const report = await experimentAdmissionPreflight(
      experiment,
      "candidate",
      { binding, outputs: [output], reusableCandidates: [sidecar], fileReady: () => true },
      regular,
      CHECKED_AT,
    );

    expect(regular).not.toHaveBeenCalled();
    expect(report).toMatchObject({
      checkedAt: CHECKED_AT,
      verdict: "start-frei",
      executionClass: "cpu-only",
      steps: [{
        label: "CPU-only Audio-Retime",
        estimatedMemoryGiB: 0,
        decision: "cpu-only-provenance-reuse",
        accepted: true,
      }],
    });
    expect(report.steps[0].message).toContain("+25 ms");
    expect(report.notes.join(" ")).toContain("eingefrorene Experiment");
  });

  it("reports a verified raw-mux candidate only as zero-GiB paired artifact promotion", async () => {
    const value = fixture();
    value.experiment.candidate = { variable: "lipforcing-raw-output-profile" };
    value.experiment.changedRequestPaths = ["postprocess.lipForcing.rawOutputProfile"];
    value.experiment.baselineEvidence = null;
    value.experiment.arms[0].request.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-crf18-v1";
    value.experiment.arms[0].requestSha256 = sha256Json(value.experiment.arms[0].request);
    value.experiment.arms[1].request = structuredClone(value.experiment.arms[0].request);
    value.experiment.arms[1].request.outputName = "paired-candidate.mp4";
    value.experiment.arms[1].request.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
    value.experiment.arms[1].requestSha256 = sha256Json(value.experiment.arms[1].request);
    value.binding.variableId = "lipforcing-raw-output-profile";
    value.binding.changedRequestPaths = ["postprocess.lipForcing.rawOutputProfile"];
    value.binding.baselineRequestSha256 = value.experiment.arms[0].requestSha256;
    value.binding.requestSha256 = value.experiment.arms[1].requestSha256;
    delete value.binding.adoptedBaseline;
    const regular = vi.fn();
    const verifyRawMuxPairAuthority = vi.fn(() => ({
      description: "versiegelte Baseline bindet Candidate, Raw- und Timeline-Receipts",
    }));

    const report = await experimentAdmissionPreflight(
      value.experiment,
      "candidate",
      {
        binding: value.binding,
        outputs: [],
        reusableCandidates: [],
        verifyRawMuxPairAuthority,
      },
      regular,
      CHECKED_AT,
    );

    expect(regular).not.toHaveBeenCalled();
    expect(verifyRawMuxPairAuthority).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      verdict: "start-frei",
      executionClass: "cpu-only",
      steps: [{
        label: "Gepaarte Raw-Mux-Artefakt-Promotion",
        estimatedMemoryGiB: 0,
        decision: "paired-artifact-promotion",
        accepted: true,
      }],
    });
    expect(report.notes.join(" ")).toContain("ohne DGX-Fallback");
  });

  it("never falls a raw-mux candidate back to regular DGX preflight when authority is missing", async () => {
    const value = fixture();
    value.experiment.candidate = { variable: "lipforcing-raw-output-profile" };
    value.experiment.changedRequestPaths = ["postprocess.lipForcing.rawOutputProfile"];
    value.binding.variableId = "lipforcing-raw-output-profile";
    value.binding.changedRequestPaths = ["postprocess.lipForcing.rawOutputProfile"];
    const regular = vi.fn();

    const report = await experimentAdmissionPreflight(
      value.experiment,
      "candidate",
      { binding: value.binding, outputs: [], reusableCandidates: [] },
      regular,
      CHECKED_AT,
    );

    expect(regular).not.toHaveBeenCalled();
    expect(report.verdict).toBe("nicht-pruefbar");
    expect(report.executionClass).toBeUndefined();
    expect(report.steps[0]).toMatchObject({ estimatedMemoryGiB: 0, accepted: false });
    expect(report.notes.join(" ")).toContain("niemals auf DGX");
  });

  it.each([
    ["changed output metadata", (value: ReturnType<typeof fixture>) => {
      value.output.fileId = "78";
    }],
    ["missing sidecar", (value: ReturnType<typeof fixture>) => {
      value.sidecar.outputName = "unbound-output.mp4";
    }],
    ["mismatched frozen-arm binding", (value: ReturnType<typeof fixture>) => {
      value.binding.requestSha256 = "9".repeat(64);
    }],
    ["unverified identity", (value: ReturnType<typeof fixture>) => {
      value.sidecar.identityEvidence.status = "captured";
    }],
    ["changed visual request", (value: ReturnType<typeof fixture>) => {
      value.experiment.arms[1].request.postprocess.lipForcing.mouthDelayMs = 150;
      value.experiment.arms[1].requestSha256 = sha256Json(value.experiment.arms[1].request);
    }],
    ["unreadable output", (value: ReturnType<typeof fixture>) => {
      value.sidecar.outputPath = "/outputs/unreadable.mp4";
    }],
  ])("fails closed instead of claiming CPU-only for %s", async (_label, mutate) => {
    const value = fixture();
    mutate(value);
    const regular = vi.fn();

    const report = await experimentAdmissionPreflight(
      value.experiment,
      "candidate",
      {
        outputs: [value.output],
        binding: value.binding,
        reusableCandidates: [value.sidecar],
        fileReady: (path) => !path.endsWith("unreadable.mp4"),
      },
      regular,
      CHECKED_AT,
    );

    expect(regular).not.toHaveBeenCalled();
    expect(report.verdict).toBe("nicht-pruefbar");
    expect(report.executionClass).toBeUndefined();
    expect(report.steps).toEqual([
      expect.objectContaining({ decision: "nicht-pruefbar", accepted: false }),
    ]);
    expect(report.notes.join(" ")).toContain("CPU-only wird nicht zugesagt");
  });

  it("keeps unrelated experiment arms on the unchanged regular DGX preflight", async () => {
    const { experiment, binding } = fixture();
    experiment.candidate = { variable: "lipforcing-mouth-delay-ms", value: 150 };
    experiment.changedRequestPaths = ["postprocess.lipForcing.mouthDelayMs"];
    const regularReport = {
      checkedAt: CHECKED_AT,
      verdict: "wartet" as const,
      notes: ["regular"],
      steps: [{
        label: "LTX-Render",
        estimatedMemoryGiB: 66,
        decision: "queued",
        accepted: false,
        message: "queued",
      }],
    };
    const regular = vi.fn(async () => regularReport);

    const report = await experimentAdmissionPreflight(
      experiment,
      "candidate",
      { binding, outputs: [], reusableCandidates: [] },
      regular,
      CHECKED_AT,
    );

    expect(report).toBe(regularReport);
    expect(regular).toHaveBeenCalledOnce();
    expect(regular).toHaveBeenCalledWith(experiment.arms[1].request);
  });

  it("keeps a LipForcing decoder arm on the regular provenance-aware DGX preflight", async () => {
    const { experiment, binding } = fixture();
    experiment.candidate = {
      variable: "lipforcing-decoder",
      value: "streaming-taehv",
    };
    experiment.changedRequestPaths = ["postprocess.lipForcing.decoder"];
    experiment.arms[1].request.postprocess.lipForcing.decoder = "streaming-taehv";
    binding.variableId = "lipforcing-decoder";
    binding.changedRequestPaths = ["postprocess.lipForcing.decoder"];
    const regularReport = {
      checkedAt: CHECKED_AT,
      verdict: "wartet" as const,
      notes: ["regular decoder admission"],
      steps: [{
        label: "LipForcing-Render",
        estimatedMemoryGiB: 52,
        decision: "queued",
        accepted: false,
        message: "queued",
      }],
    };
    const regular = vi.fn(async () => regularReport);

    const report = await experimentAdmissionPreflight(
      experiment,
      "candidate",
      { binding, outputs: [], reusableCandidates: [] },
      regular,
      CHECKED_AT,
    );

    expect(report).toBe(regularReport);
    expect(report.executionClass).toBeUndefined();
    expect(regular).toHaveBeenCalledOnce();
    expect(regular).toHaveBeenCalledWith(experiment.arms[1].request);
  });
});
