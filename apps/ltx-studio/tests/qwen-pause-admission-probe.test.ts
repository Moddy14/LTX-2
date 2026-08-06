import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { validRequest } from "./fixtures.js";

// Die Poll-/Probe-Intervalle werden beim Modul-Load gelesen; deshalb müssen
// die Testwerte vor dem dynamischen Import von server/jobs.js gesetzt sein.
process.env.LTX_STUDIO_QWEN_DEMAND_POLL_MS = "1000";
process.env.LTX_STUDIO_QWEN_ADMISSION_PROBE_MS = "1000";
process.env.LTX_STUDIO_QWEN_IDLE_GRACE_MS = "1";
const { JobManager } = await import("../server/jobs.js");

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-qwen-probe-"));
  roots.push(root);
  return join(root, "jobs.json");
}

type DemandRead = () => Promise<{ schema_version: string; visible: boolean }>;
type AdmissionCheck = (() => Promise<{ decision: string }>) | undefined;

async function managerWith(demandRead: DemandRead, check: AdmissionCheck) {
  return new JobManager(
    await statePath(),
    false,
    null,
    undefined,
    undefined,
    null,
    {
      submit: vi.fn() as never,
      ...(check ? { check: check as never } : {}),
    },
    undefined,
    { read: demandRead as never },
  );
}

function pausedJobStub() {
  return {
    status: "paused",
    logs: [] as string[],
    request: validRequest(),
  };
}

async function runWait(manager: InstanceType<typeof JobManager>, job: unknown): Promise<boolean> {
  const wait = Reflect.get(manager, "waitForQwenIdleGrace") as (job: unknown) => Promise<boolean>;
  return wait.call(manager, job);
}

describe("waitForQwenIdleGrace admission probe", () => {
  it("resumes via the read-only admission probe while foreign demand stays visible", async () => {
    const check = vi.fn(async () => ({ decision: "accepted" }));
    const manager = await managerWith(
      async () => ({ schema_version: "dgx-qwen-demand.v0", visible: true }),
      check,
    );
    const job = pausedJobStub();

    await expect(runWait(manager, job)).resolves.toBe(true);
    expect(check).toHaveBeenCalled();
    expect(job.logs.some((line) => line.includes("Admission-Probe akzeptiert"))).toBe(true);
  }, 15_000);

  it("keeps waiting while the admission probe stays rejected", async () => {
    const check = vi.fn(async () => ({ decision: "rejected_insufficient_resources" }));
    const manager = await managerWith(
      async () => ({ schema_version: "dgx-qwen-demand.v0", visible: true }),
      check,
    );
    const job = pausedJobStub();
    setTimeout(() => {
      job.status = "cancelled";
    }, 3_500);

    await expect(runWait(manager, job)).resolves.toBe(false);
    expect(check.mock.calls.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it("still resumes through the idle grace path once the demand disappears", async () => {
    const check = vi.fn(async () => ({ decision: "rejected_insufficient_resources" }));
    const manager = await managerWith(
      async () => ({ schema_version: "dgx-qwen-demand.v0", visible: false }),
      check,
    );

    await expect(runWait(manager, pausedJobStub())).resolves.toBe(true);
    expect(check).not.toHaveBeenCalled();
  }, 15_000);

  it("falls back to the demand-only wait when no check operation is wired", async () => {
    const manager = await managerWith(
      async () => ({ schema_version: "dgx-qwen-demand.v0", visible: true }),
      undefined,
    );
    const job = pausedJobStub();
    setTimeout(() => {
      job.status = "cancelled";
    }, 2_500);

    await expect(runWait(manager, job)).resolves.toBe(false);
  }, 15_000);
});
