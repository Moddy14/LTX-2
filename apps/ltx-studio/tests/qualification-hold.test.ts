import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildCommand, validateRequestPlan } from "../server/command.js";
import {
  DFR_LEGACY_EXECUTION_HOLD_CODE,
  DFR_QUALIFICATION_HOLD_CODE,
  qualificationHoldForRequest,
} from "../shared/qualificationHold.js";
import { validRequest } from "./fixtures.js";

describe("DFR qualification hold", () => {
  it("is pure, fail-closed for every DFR geometry, and cannot be cleared by request data", () => {
    for (const temporalUpscalings of [0, 1, 2] as const) {
      for (const spatialUpscalings of [1, 2] as const) {
        const request = validRequest("dfr");
        request.dfr!.temporalUpscalings = temporalUpscalings;
        request.dfr!.spatialUpscalings = spatialUpscalings;
        Object.assign(request, { qualificationHold: false, qualificationApproved: true });

        expect(qualificationHoldForRequest(request)).toMatchObject({
          code: DFR_QUALIFICATION_HOLD_CODE,
          mode: "dfr",
          reason: expect.stringContaining("DGX-Queue"),
        });
      }
    }
    const legacy = validRequest("dfr");
    legacy.legacyExecution = {
      schemaVersion: "ltx-studio-legacy-execution.v1",
      reason: "dfr-pre-v1.3.0",
      executable: false,
    };
    expect(qualificationHoldForRequest(legacy)?.code).toBe(DFR_LEGACY_EXECUTION_HOLD_CODE);
    expect(qualificationHoldForRequest(validRequest("two-stage"))).toBeNull();
  });

  it("keeps command planning diagnostic while reporting the hold as a plan error", () => {
    const request = validRequest("dfr");
    const plan = buildCommand(request);
    const errors = validateRequestPlan(request, plan, undefined, { enforceOfficialAssets: false });

    expect(plan.displayCommand).toContain("ltx_pipelines.dfr_pipeline");
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("Qualification-HOLD"),
    ]));

    const indexSource = readFileSync(
      fileURLToPath(new URL("../server/index.ts", import.meta.url)),
      "utf8",
    );
    const holdIndex = indexSource.indexOf("const qualificationHold = qualificationHoldForRequest(payload)");
    const sourceGateIndex = indexSource.indexOf(
      "if (!qualificationHold) verifyNativeRuntimeSource(payload, rendererPythonExecutable)",
      holdIndex,
    );
    expect(holdIndex).toBeGreaterThan(-1);
    expect(sourceGateIndex).toBeGreaterThan(holdIndex);
    expect(indexSource).toContain(
      'status: qualificationHold ? "qualification-hold" : "preview-only"',
    );
    expect(indexSource).toContain(
      "const inventory = !qualificationHold && requiredAssetIds.length > 0",
    );
  });

  it("checks a held experiment arm before retry release or queue inspection", () => {
    const indexSource = readFileSync(
      fileURLToPath(new URL("../server/index.ts", import.meta.url)),
      "utf8",
    );
    const route = indexSource.indexOf('app.post("/api/experiments/:id/runs/:arm"');
    const hold = indexSource.indexOf(
      "const qualificationHold = qualificationHoldForRequest(preReleaseRequest)",
      route,
    );
    const retryInspection = indexSource.indexOf("failedJobId = await inspectRetryableExperimentArm(", route);

    expect(route).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(route);
    expect(retryInspection).toBeGreaterThan(hold);
  });

  it("blocks every GUI start surface from the same shared policy", () => {
    const source = (relative: string) => readFileSync(
      fileURLToPath(new URL(relative, import.meta.url)),
      "utf8",
    );
    expect(source("../src/App.tsx")).toContain("!qualificationHold");
    expect(source("../src/components/RunPanel.tsx")).toContain("selectedJobQualificationHold");
    expect(source("../src/components/ProjectPanel.tsx")).toContain("Boolean(qualificationHold)");
    expect(source("../src/components/ExperimentPanel.tsx")).toContain("baselineQualificationHold");
    expect(source("../src/components/ExperimentPanel.tsx")).toContain("candidateQualificationHold");
  });
});
