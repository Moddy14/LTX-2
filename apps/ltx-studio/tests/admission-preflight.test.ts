import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  admissionPreflightPlan,
  refinerAdmissionMemoryGiB,
} from "../shared/admissionPreflight.js";
import { admissionPreflight, type AdmissionDecision } from "../server/admission.js";
import { armRetryable } from "../src/experimentArms.js";
import type { StudioJob, StudioOutput } from "../src/types.js";
import { validRequest } from "./fixtures.js";

describe("admissionPreflightPlan", () => {
  it("plans a single render step without refiners", () => {
    const { steps } = admissionPreflightPlan(validRequest());

    expect(steps).toHaveLength(1);
    expect(steps[0].label).toContain("LTX-Render");
    expect(steps[0].estimatedMemoryGiB).toBeGreaterThan(0);
  });

  it("adds the LipForcing budget the job runner will submit later", () => {
    const request = validRequest();
    request.postprocess.lipForcing.enabled = true;

    const { steps } = admissionPreflightPlan(request);

    expect(steps).toHaveLength(2);
    expect(steps[1]).toMatchObject({ label: "LipForcing-Refiner", estimatedMemoryGiB: 52 });
  });

  it("mirrors the refiner precedence of the job runner", () => {
    const request = validRequest();
    expect(refinerAdmissionMemoryGiB(request)).toBeNull();
    request.postprocess.museTalk.enabled = true;
    expect(refinerAdmissionMemoryGiB(request)).toBe(16);
    request.postprocess.latentSync.enabled = true;
    expect(refinerAdmissionMemoryGiB(request)).toBe(24);
    request.postprocess.lipForcing.enabled = true;
    expect(refinerAdmissionMemoryGiB(request)).toBe(52);
  });

  it("marks the separately supervised LongCat stage in the notes", () => {
    const request = validRequest();
    request.postprocess.longcatLipsync.enabled = true;

    const { notes } = admissionPreflightPlan(request);

    expect(notes.some((note) => note.includes("LongCat"))).toBe(true);
  });
});

describe("admissionPreflight", () => {
  const accepted: AdmissionDecision = {
    decision: "accepted",
    message_for_humans: "DGX admission accepted",
  };
  const rejected: AdmissionDecision = {
    decision: "rejected_insufficient_resources",
    message_for_humans: "estimated memory 52.0 GiB would leave less than 12.0 GiB headroom",
  };

  it("reports start-frei when every step would be admitted now", async () => {
    const request = validRequest();
    request.postprocess.lipForcing.enabled = true;

    const report = await admissionPreflight(request, async () => accepted);

    expect(report.verdict).toBe("start-frei");
    expect(report.steps.every((step) => step.accepted)).toBe(true);
    expect(report.notes.at(-1)).toContain("Momentaufnahme");
  });

  it("reports wartet with the orchestrator's own message when a step is rejected", async () => {
    const request = validRequest();
    request.postprocess.lipForcing.enabled = true;

    const report = await admissionPreflight(request, async (_request, estimatedMemoryGiB) =>
      estimatedMemoryGiB === 52 ? rejected : accepted);

    expect(report.verdict).toBe("wartet");
    expect(report.steps[0].accepted).toBe(true);
    expect(report.steps[1].accepted).toBe(false);
    expect(report.steps[1].message).toContain("12.0 GiB headroom");
  });

  it("fails closed to nicht-pruefbar when the runtime API is unreachable", async () => {
    const report = await admissionPreflight(validRequest(), async () => {
      throw new Error("Runtime-API nicht erreichbar");
    });

    expect(report.verdict).toBe("nicht-pruefbar");
    expect(report.steps[0].message).toContain("nicht erreichbar");
  });
});

describe("preflight wiring", () => {
  it("registers the preflight endpoint on the server", () => {
    const indexSource = readFileSync(fileURLToPath(new URL("../server/index.ts", import.meta.url)), "utf8");

    expect(indexSource).toContain("app.post(\"/api/admission/preflight\"");
    expect(indexSource).toContain("admissionPreflight(payload)");
  });

  it("keeps the job runner's refiner budget on the shared source", () => {
    const jobsSource = readFileSync(fileURLToPath(new URL("../server/jobs.ts", import.meta.url)), "utf8");

    expect(jobsSource).toContain("refinerAdmissionMemoryGiB(job.request)");
    expect(jobsSource).not.toMatch(/lipForcingEnabled \? 52 :/);
  });
});

describe("armRetryable", () => {
  const arm = { jobId: "99999999-8888-4777-a666-555544443333" };

  it("stays retryable when the bound job vanished without a verified output", () => {
    expect(armRetryable(arm, undefined, undefined)).toBe(true);
  });

  it("is not retryable when a verified output proves the vanished run", () => {
    expect(armRetryable(arm, undefined, {} as StudioOutput)).toBe(false);
  });

  it("follows the job status while the job is known", () => {
    expect(armRetryable(arm, { status: "cancelled" } as StudioJob, undefined)).toBe(true);
    expect(armRetryable(arm, { status: "running" } as StudioJob, undefined)).toBe(false);
    expect(armRetryable(arm, { status: "completed" } as StudioJob, {} as StudioOutput)).toBe(false);
  });

  it("is never retryable for an unbound arm", () => {
    expect(armRetryable({ jobId: null }, undefined, undefined)).toBe(false);
  });
});
