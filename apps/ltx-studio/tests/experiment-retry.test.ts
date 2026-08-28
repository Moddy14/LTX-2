import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExperimentConflictError,
  ExperimentStore,
  outputVerifiesExperimentArmRun,
} from "../server/experimentStore.js";
import {
  inspectRetryableExperimentArm,
  releaseRetryableExperimentArm,
  type ExperimentArmRetryDeps,
} from "../server/experimentRetry.js";
import type { ControlledExperiment } from "../shared/experiments.js";
import type { StudioOutput } from "../shared/outputs.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FINGERPRINT = "c".repeat(64);
const BASELINE_JOB_ID = "11111111-2222-4333-8444-555555555555";
const OLD_CANDIDATE_JOB_ID = "99999999-8888-4777-a666-555544443333";

function authoritativeQueue(
  jobs: Awaited<ReturnType<ExperimentArmRetryDeps["listRemoteJobs"]>>["jobs"] = [],
  extra: Partial<Awaited<ReturnType<ExperimentArmRetryDeps["listRemoteJobs"]>>> = {},
): Awaited<ReturnType<ExperimentArmRetryDeps["listRemoteJobs"]>> {
  return {
    schemaVersion: "dgx-queue-read.v0",
    jobs,
    queueReadable: true,
    admissionState: "local_queue_v0",
    lockLane: { state: "free", waiters: 0 },
    ...extra,
  };
}

async function frozenExperimentWithCandidate(): Promise<{
  store: ExperimentStore;
  experiment: ControlledExperiment;
}> {
  const root = await mkdtemp(join(tmpdir(), "ltx-experiment-retry-"));
  roots.push(root);
  const store = new ExperimentStore(root);
  const baseline = validRequest("audio-to-video");
  baseline.outputName = "adopted-baseline.mp4";
  baseline.videoGuidance.modalityScale = 5;
  const created = store.create(
    {
      title: "Retry nach Historienverlust",
      baselineRequest: baseline,
      baselineOutputName: baseline.outputName,
      candidate: { variable: "a2v-guidance", value: 3 },
    },
    new Date(0).toISOString(),
    {
      outputName: baseline.outputName,
      jobId: BASELINE_JOB_ID,
      sizeBytes: 1024,
      changedAt: new Date(0).toISOString(),
      fileId: "1",
      provenanceFingerprint: FINGERPRINT,
    },
  );
  store.freeze(created.id, new Date(1).toISOString());
  const experiment = store.attachJob(created.id, "candidate", OLD_CANDIDATE_JOB_ID);
  return { store, experiment };
}

function deps(overrides: Partial<ExperimentArmRetryDeps>, released: ControlledExperiment): ExperimentArmRetryDeps {
  return {
    getJob: () => undefined,
    hasVerifiedArmOutput: () => false,
    listRemoteJobs: async () => authoritativeQueue(),
    releaseArm: vi.fn(() => released),
    ...overrides,
  };
}

describe("releaseRetryableExperimentArm", () => {
  it("keeps a historical official-IA2V guidance arm readable but permanently non-retryable", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    experiment.arms[0].request.mode = "image-audio-to-video";
    experiment.arms[1].request.mode = "image-audio-to-video";
    const wired = deps({ getJob: () => ({ status: "cancelled", dgxJobId: null }) }, experiment);

    await expect(inspectRetryableExperimentArm(experiment, "candidate", wired))
      .rejects.toThrow("darf aber nicht erneut gestartet werden");
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });

  it("proves a cancelled retry read-only without releasing the stored arm", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const wired = deps({ getJob: () => ({ status: "cancelled", dgxJobId: null }) }, experiment);

    const retryableJobId = await inspectRetryableExperimentArm(experiment, "candidate", wired);

    expect(retryableJobId).toBe(OLD_CANDIDATE_JOB_ID);
    expect(wired.releaseArm).not.toHaveBeenCalled();
    expect(experiment.arms[1].jobId).toBe(OLD_CANDIDATE_JOB_ID);
  });

  it("does not call the remote queue for an arm whose local job is still active", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const listRemoteJobs = vi.fn(async () => ({ jobs: [] }));
    const wired = deps({
      getJob: () => ({ status: "running", dgxJobId: null }),
      listRemoteJobs,
    }, experiment);

    await expect(inspectRetryableExperimentArm(experiment, "candidate", wired)).resolves.toBeNull();
    expect(listRemoteJobs).not.toHaveBeenCalled();
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });

  it("fails closed while cancellation settlement is still pending", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const listRemoteJobs = vi.fn(async () => ({ jobs: [] }));
    const wired = deps({
      getJob: () => ({
        status: "cancelled",
        dgxJobId: "dgx-job-20260826-pending",
        settlementPending: true,
      }),
      listRemoteJobs,
    }, experiment);

    await expect(inspectRetryableExperimentArm(experiment, "candidate", wired))
      .rejects.toThrow("Abschlussautorität ist noch nicht vollständig bestätigt");
    expect(listRemoteJobs).not.toHaveBeenCalled();
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });

  it("releases the arm when the bound job vanished from the history without a verified output", async () => {
    const { store, experiment } = await frozenExperimentWithCandidate();
    const released = store.releaseArmForRetry(experiment.id, "candidate", OLD_CANDIDATE_JOB_ID);
    const wired = deps({}, released);

    const result = await releaseRetryableExperimentArm(experiment, "candidate", wired);

    expect(wired.releaseArm).toHaveBeenCalledWith(experiment.id, "candidate", OLD_CANDIDATE_JOB_ID);
    expect(result.arms[1].jobId).toBeNull();
  });

  it("keeps the arm bound when a verified output proves the vanished job ran", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const wired = deps({ hasVerifiedArmOutput: () => true }, experiment);

    const result = await releaseRetryableExperimentArm(experiment, "candidate", wired);

    expect(result).toBe(experiment);
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });

  it("keeps the arm bound while the known job is still active", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const wired = deps({ getJob: () => ({ status: "running", dgxJobId: null }) }, experiment);

    const result = await releaseRetryableExperimentArm(experiment, "candidate", wired);

    expect(result).toBe(experiment);
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });

  it("keeps a completed job bound instead of releasing it", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const wired = deps({ getJob: () => ({ status: "completed", dgxJobId: null }) }, experiment);

    const result = await releaseRetryableExperimentArm(experiment, "candidate", wired);

    expect(result).toBe(experiment);
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });

  it("releases a cancelled job that no longer owns an active queue lease", async () => {
    const { store, experiment } = await frozenExperimentWithCandidate();
    const released = store.releaseArmForRetry(experiment.id, "candidate", OLD_CANDIDATE_JOB_ID);
    const wired = deps({ getJob: () => ({ status: "cancelled", dgxJobId: null }) }, released);

    const result = await releaseRetryableExperimentArm(experiment, "candidate", wired);

    expect(wired.releaseArm).toHaveBeenCalledWith(experiment.id, "candidate", OLD_CANDIDATE_JOB_ID);
    expect(result.arms[1].jobId).toBeNull();
  });

  it("refuses while the vanished job still owns an active remote queue job", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const wired = deps({
      listRemoteJobs: async () => authoritativeQueue([{
          job_id: "dgx-job-20260804-120000-000000000001",
          state: "running",
          requested_by: `ltx-studio:${OLD_CANDIDATE_JOB_ID}`,
        } as never]),
    }, experiment);

    await expect(releaseRetryableExperimentArm(experiment, "candidate", wired))
      .rejects.toThrow(ExperimentConflictError);
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });

  it("does not treat a resource-free cooling order as an active remote lease", async () => {
    const { store, experiment } = await frozenExperimentWithCandidate();
    const released = store.releaseArmForRetry(experiment.id, "candidate", OLD_CANDIDATE_JOB_ID);
    const wired = deps({
      listRemoteJobs: async () => authoritativeQueue([], {
        coolingOrders: [{
          order_id: "c".repeat(64),
          state: "cooling",
          source_app: "minimax-h3-dgx",
          job_type: "comfyui_minimax_h3_workflow",
          runtime: "comfyui_minimax_h3",
          created_at: "2026-08-27T08:00:00+00:00",
          updated_at: "2026-08-27T08:01:00+00:00",
          current_step: "durable order waiting for stable cooling",
          queue_position: null,
        }],
      }),
    }, released);

    const result = await releaseRetryableExperimentArm(experiment, "candidate", wired);

    expect(wired.releaseArm).toHaveBeenCalledWith(
      experiment.id,
      "candidate",
      OLD_CANDIDATE_JOB_ID,
    );
    expect(result.arms[1].jobId).toBeNull();
  });

  it("refuses every active requested_by lease even when the known DGX job is terminal", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const wired = deps({
      getJob: () => ({
        status: "cancelled",
        dgxJobId: "dgx-job-20260826-120000-000000000001",
        settlementPending: false,
      }),
      listRemoteJobs: async () => authoritativeQueue([{
          job_id: "dgx-job-20260826-120000-000000000001",
          state: "cancelled",
          requested_by: `ltx-studio:${OLD_CANDIDATE_JOB_ID}`,
        }, {
          job_id: "dgx-job-20260826-120000-000000000002",
          state: "starting",
          requested_by: `ltx-studio:${OLD_CANDIDATE_JOB_ID}`,
        }] as never),
    }, experiment);

    await expect(inspectRetryableExperimentArm(experiment, "candidate", wired))
      .rejects.toThrow("dgx-job-20260826-120000-000000000002 (starting)");
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });

  it("refuses when the remote queue state cannot be checked", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const wired = deps({
      listRemoteJobs: async () => {
        throw new Error("Runtime-API nicht erreichbar");
      },
    }, experiment);

    await expect(releaseRetryableExperimentArm(experiment, "candidate", wired))
      .rejects.toThrow(ExperimentConflictError);
  });

  it("refuses when queue normalization discarded an unknown job state", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const wired = deps({
      getJob: () => ({ status: "cancelled", dgxJobId: null }),
      listRemoteJobs: async () => authoritativeQueue([], { discardedJobLikeEntries: 1 }),
    }, experiment);

    await expect(inspectRetryableExperimentArm(experiment, "candidate", wired))
      .rejects.toThrow("DGX-Queue-Zustand kann nicht sicher geprüft werden");
  });

  it("keeps the arm fail-closed while the queue lock lane can hide an in-flight submit", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const wired = deps({
      getJob: () => ({ status: "cancelled", dgxJobId: null }),
      listRemoteJobs: async () => authoritativeQueue([], {
        lockLane: { state: "held", seconds: 1, waiters: 0, holders: 1 },
      }),
    }, experiment);

    await expect(inspectRetryableExperimentArm(experiment, "candidate", wired))
      .rejects.toThrow("Abwesenheit ist bei belegter Queue-Lane nicht beweisbar");
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });

  it("returns untouched when the arm was never started", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-experiment-retry-"));
    roots.push(root);
    const store = new ExperimentStore(root);
    const baseline = validRequest("audio-to-video");
    baseline.outputName = "adopted-baseline.mp4";
    baseline.videoGuidance.modalityScale = 5;
    const created = store.create(
      {
        title: "Ohne Kandidatenlauf",
        baselineRequest: baseline,
        baselineOutputName: baseline.outputName,
        candidate: { variable: "a2v-guidance", value: 3 },
      },
      new Date(0).toISOString(),
      {
        outputName: baseline.outputName,
        jobId: BASELINE_JOB_ID,
        sizeBytes: 1024,
        changedAt: new Date(0).toISOString(),
        fileId: "1",
        provenanceFingerprint: FINGERPRINT,
      },
    );
    const experiment = store.freeze(created.id, new Date(1).toISOString());
    const wired = deps({}, experiment);

    const result = await releaseRetryableExperimentArm(experiment, "candidate", wired);

    expect(result).toBe(experiment);
    expect(wired.releaseArm).not.toHaveBeenCalled();
  });
});

describe("outputVerifiesExperimentArmRun", () => {
  function candidateOutput(experiment: ControlledExperiment, overrides: Partial<StudioOutput> = {}): StudioOutput {
    const selected = experiment.arms[1];
    return {
      name: selected.request.outputName,
      jobId: OLD_CANDIDATE_JOB_ID,
      experiment: {
        schemaVersion: "ltx-studio-experiment-run.v1",
        experimentId: experiment.id,
        protocolSha256: experiment.protocolSha256,
        arm: "candidate",
        requestSha256: selected.requestSha256,
      },
      experimentRequestVerified: true,
      provenance: { verifiedAt: new Date(2).toISOString(), fingerprint: FINGERPRINT },
      ...overrides,
    } as StudioOutput;
  }

  it("accepts a verified candidate output bound to the frozen protocol", async () => {
    const { experiment } = await frozenExperimentWithCandidate();

    expect(outputVerifiesExperimentArmRun(candidateOutput(experiment), experiment, "candidate")).toBe(true);
  });

  it("rejects a candidate output without verified provenance", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const output = candidateOutput(experiment, {
      provenance: { verifiedAt: null, fingerprint: FINGERPRINT },
    } as Partial<StudioOutput>);

    expect(outputVerifiesExperimentArmRun(output, experiment, "candidate")).toBe(false);
  });

  it("rejects a candidate output whose request binding was not verified", async () => {
    const { experiment } = await frozenExperimentWithCandidate();
    const output = candidateOutput(experiment, { experimentRequestVerified: false });

    expect(outputVerifiesExperimentArmRun(output, experiment, "candidate")).toBe(false);
  });
});
