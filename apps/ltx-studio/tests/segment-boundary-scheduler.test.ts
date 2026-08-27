import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validRequest } from "./fixtures.js";
import { buildAdmissionRequests } from "../server/admission.js";
import { canonicalJson } from "../shared/canonicalJson.js";

process.env.LTX_STUDIO_SEGMENT_BOUNDARY_PAUSED_POLL_MS = "10";
const { JobManager } = await import("../server/jobs.js");

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-segment-scheduler-"));
  roots.push(root);
  return join(root, "jobs.json");
}

type BoundaryDecision = {
  schema_version: "dgx-segment-schedule-decision.v1";
  action: "continue_current" | "yield_to_waiting_job" | "wait_for_successor" | "resume_current";
  current_job_id: string;
  next_job_id: string | null;
  reason: string;
  retry_after_seconds: number;
};

const studioJobId = "11111111-1111-4111-8111-111111111111";
const dgxJobId = "dgx-job-20260827-120000-aaaaaaaaaaaa";

async function managerWith(decide: () => Promise<BoundaryDecision>) {
  return new JobManager(
    await statePath(),
    false,
    null,
    undefined,
    undefined,
    null,
    { submit: vi.fn() as never },
    undefined,
    { decide: decide as never },
  );
}

function pausedJobStub() {
  const request = validRequest();
  const [preparedAdmission] = buildAdmissionRequests(request, 58, studioJobId);
  return {
    id: studioJobId,
    status: "paused",
    logs: [] as string[],
    request,
    dgxJobId,
    dgxLeaseReceipt: {
      schemaVersion: "ltx-studio-dgx-lease-receipt.v1",
      studioJobId,
      dgxJobId,
      requestedBy: `ltx-studio:${studioJobId}`,
      sourceApp: "LTX Studio",
      idempotencyKey: `ltx-studio:${studioJobId}`,
      preparedAdmission,
      preparedAdmissionSha256: createHash("sha256")
        .update(canonicalJson(preparedAdmission))
        .digest("hex"),
      submitStartedAt: "2026-08-27T10:00:00.000Z",
      observedState: "accepted",
      observedCreatedAt: "2026-08-27T10:00:01.000Z",
      evidence: {
        kind: "submit-response",
        schemaVersion: "dgx-queue-submit.v0",
      },
      confirmedAt: "2026-08-27T10:00:02.000Z",
    },
  };
}

async function runWait(manager: InstanceType<typeof JobManager>, job: unknown): Promise<boolean> {
  const wait = Reflect.get(manager, "waitForSchedulerResume") as (job: unknown) => Promise<boolean>;
  return wait.call(manager, job);
}

describe("paused segment scheduler", () => {
  it("resumes only when the canonical scheduler returns resume_current", async () => {
    const decide = vi.fn()
      .mockResolvedValueOnce({
        schema_version: "dgx-segment-schedule-decision.v1",
        action: "wait_for_successor",
        current_job_id: dgxJobId,
        next_job_id: "dgx-job-20260827-120001-bbbbbbbbbbbb",
        reason: "selected_successor_active",
        retry_after_seconds: 0,
      })
      .mockResolvedValueOnce({
        schema_version: "dgx-segment-schedule-decision.v1",
        action: "resume_current",
        current_job_id: dgxJobId,
        next_job_id: dgxJobId,
        reason: "scheduler_policy",
        retry_after_seconds: 0,
      });
    const manager = await managerWith(decide);
    const job = pausedJobStub();

    await expect(runWait(manager, job)).resolves.toBe(true);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(job.logs.some((line) => line.includes("wait_for_dgx-job-20260827-120001-bbbbbbbbbbbb"))).toBe(true);
  });

  it("remains paused on transport errors and invalid running-state actions", async () => {
    const decide = vi.fn()
      .mockRejectedValueOnce(new Error("runtime API offline"))
      .mockResolvedValueOnce({
        schema_version: "dgx-segment-schedule-decision.v1",
        action: "continue_current",
        current_job_id: dgxJobId,
        next_job_id: null,
        reason: "wrong state",
        retry_after_seconds: 0,
      })
      .mockResolvedValueOnce({
        schema_version: "dgx-segment-schedule-decision.v1",
        action: "resume_current",
        current_job_id: dgxJobId,
        next_job_id: dgxJobId,
        reason: "scheduler_policy",
        retry_after_seconds: 0,
      });
    const manager = await managerWith(decide);
    const job = pausedJobStub();

    await expect(runWait(manager, job)).resolves.toBe(true);
    expect(job.logs.some((line) => line.includes("scheduler_unavailable"))).toBe(true);
    expect(job.logs.some((line) => line.includes("invalid_paused_action_continue_current"))).toBe(true);
  });

  it("does not resume blindly while the scheduler remains unavailable", async () => {
    const manager = await managerWith(async () => {
      throw new Error("runtime API offline");
    });
    const job = pausedJobStub();
    setTimeout(() => {
      job.status = "cancelled";
    }, 35);

    await expect(runWait(manager, job)).resolves.toBe(false);
  });
});
