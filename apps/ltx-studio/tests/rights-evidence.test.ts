import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { candidateReleaseSurfaceSchema } from "../shared/releaseSurface.js";
import { recommendedModelAssets } from "../shared/models.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { rightsEvidenceCatalogSchema } from "../shared/rightsEvidence.js";

const catalogPath = new URL("../release/rights-evidence.v1.json", import.meta.url);
const catalogBytes = readFileSync(catalogPath, "utf8");
const catalog = rightsEvidenceCatalogSchema.parse(JSON.parse(catalogBytes));
const surface = candidateReleaseSurfaceSchema.parse(JSON.parse(readFileSync(
  new URL("../release/candidate-release-surface.v1.json", import.meta.url),
  "utf8",
)));

describe("release rights evidence", () => {
  it("is stored in canonical JSON form", () => {
    expect(catalogBytes).toBe(canonicalJson(catalog));
  });

  it("resolves every evidence id used by the candidate surface", () => {
    const evidenceIds = new Set(catalog.evidence.map(({ evidenceId }) => evidenceId));
    for (const entry of surface.entries) {
      for (const evidenceId of entry.rights.evidenceIds) {
        expect(evidenceIds.has(evidenceId), `${entry.id}: ${evidenceId}`).toBe(true);
      }
    }
  });

  it("binds rights evidence for every model in the static SBOM recipe", () => {
    const componentIds = new Set(catalog.evidence.flatMap(({ componentIds }) => componentIds));
    for (const model of recommendedModelAssets) {
      expect(componentIds.has(`model.${model.id}`), model.id).toBe(true);
    }
  });

  it("never leaves blocked evidence on a candidate entry and explains independent target blocks", () => {
    const decisions = new Map(catalog.evidence.map(({ evidenceId, decision }) => [evidenceId, decision]));
    for (const entry of surface.entries) {
      const hasBlockedEvidence = entry.rights.evidenceIds.some((id) => decisions.get(id) === "blocked");
      if (hasBlockedEvidence) expect(entry.targetStatus, entry.id).toBe("blocked");
      if (entry.targetStatus === "candidate") {
        expect(hasBlockedEvidence, entry.id).toBe(false);
        expect(entry.targetReason, entry.id).toBeNull();
      } else if (!hasBlockedEvidence) {
        expect(entry.targetReason, entry.id).not.toBeNull();
      }
    }
  });

  it("pins every upstream source to the revision present in its URL", () => {
    for (const entry of catalog.evidence) {
      for (const source of entry.sources) {
        expect(source.url, `${entry.evidenceId}: ${source.url}`).toContain(source.revision);
      }
    }
  });

  it("binds an upstream contact source for every remediable VBench license block", () => {
    const expectedContacts = new Map([
      ["evaluator-vbench-amt-noncommercial", "MCG-NKU/AMT"],
      ["evaluator-vbench-pyiqa-noncommercial", "chaofengc/IQA-PyTorch"],
    ]);
    for (const [evidenceId, repository] of expectedContacts) {
      const evidence = catalog.evidence.find((entry) => entry.evidenceId === evidenceId);
      expect(evidence?.decision, evidenceId).toBe("blocked");
      expect(evidence?.sources, evidenceId).toContainEqual(expect.objectContaining({
        authority: "upstream-git",
        repository,
        path: "README.md",
      }));
    }
  });
});
