import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validRequest } from "./fixtures.js";

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
  action: "continue_current" | "yield_to_waiting_job" | "wait_for_successor" | "resume_current";
  current_job_id: string;
  next_job_id: string | null;
  reason: string;
  retry_after_seconds: number;
};

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
  return {
    status: "paused",
    logs: [] as string[],
    request: validRequest(),
    dgxJobId: "dgx-job-paused",
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
        action: "wait_for_successor",
        current_job_id: "dgx-job-paused",
        next_job_id: "dgx-job-waiter",
        reason: "selected_successor_active",
        retry_after_seconds: 0,
      })
      .mockResolvedValueOnce({
        action: "resume_current",
        current_job_id: "dgx-job-paused",
        next_job_id: "dgx-job-paused",
        reason: "scheduler_policy",
        retry_after_seconds: 0,
      });
    const manager = await managerWith(decide);
    const job = pausedJobStub();

    await expect(runWait(manager, job)).resolves.toBe(true);
    expect(decide).toHaveBeenCalledTimes(2);
    expect(job.logs.some((line) => line.includes("wait_for_dgx-job-waiter"))).toBe(true);
  });

  it("remains paused on transport errors and invalid running-state actions", async () => {
    const decide = vi.fn()
      .mockRejectedValueOnce(new Error("runtime API offline"))
      .mockResolvedValueOnce({
        action: "continue_current",
        current_job_id: "dgx-job-paused",
        next_job_id: null,
        reason: "wrong state",
        retry_after_seconds: 0,
      })
      .mockResolvedValueOnce({
        action: "resume_current",
        current_job_id: "dgx-job-paused",
        next_job_id: "dgx-job-paused",
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
