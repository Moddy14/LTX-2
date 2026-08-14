import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  m0BaselineSchema,
  m0ContractInventorySchema,
  m0VerificationSchema,
} from "../shared/m0Evidence.js";

function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8"));
}

describe("M0 evidence", () => {
  it("keeps the verification report schema-valid", () => {
    expect(m0VerificationSchema.parse(readJson("../docs/evidence/m0-verification-2026-08-14.json")))
      .toMatchObject({ schemaVersion: "ltx-studio-m0-verification.v1" });
  });

  it("keeps the non-self-referential baseline schema-valid", () => {
    const baseline = m0BaselineSchema.parse(readJson("../docs/evidence/m0-baseline-2026-08-14.json"));
    expect(baseline.identities.map(({ role }) => role)).toEqual([
      "pre_plan_baseline",
      "reviewed_plan_source_commit",
    ]);
    expect(baseline.activeJobs.running).toBe(0);
  });

  it("covers the local contract families and concrete API surface", () => {
    const inventory = m0ContractInventorySchema.parse(
      readJson("../docs/evidence/m0-contract-inventory-2026-08-14.json"),
    );
    const contractIds = new Set(inventory.contracts.map(({ id }) => id));
    for (const required of [
      "capability-release-surface",
      "http-api-routes",
      "request-sidecar-schema",
      "scheduler-admission",
      "release-provenance",
      "release-audit-rights",
      "evaluator-bindings",
      "project-history",
      "av-evaluator-cli",
      "pipeline-exports",
    ]) expect(contractIds.has(required), required).toBe(true);
    expect(inventory.httpRoutes.some(({ method, path }) => method === "POST" && path === "/api/jobs")).toBe(true);
    expect(inventory.schemas.length).toBeGreaterThan(20);
    expect(inventory.cliPrograms.flatMap(({ commands }) => commands).length).toBeGreaterThan(10);
  });
});
