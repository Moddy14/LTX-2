import { describe, expect, it } from "vitest";

import {
  LTX25_MODEL_REVISION,
  LTX25_TRANSFORMER_CANDIDATES,
  LTX25_WORKFLOW_CATALOG,
  LTX25_WORKFLOW_COMMIT,
  ltx25WorkflowContract,
} from "../shared/ltx25Catalog.js";

describe("LTX-2.5 catalog", () => {
  it("pins all ten official example workflows without duplicate identity", () => {
    expect(LTX25_WORKFLOW_CATALOG).toHaveLength(10);
    expect(new Set(LTX25_WORKFLOW_CATALOG.map(({ id }) => id)).size).toBe(10);
    expect(new Set(LTX25_WORKFLOW_CATALOG.map(({ filename }) => filename)).size).toBe(10);
    expect(new Set(LTX25_WORKFLOW_CATALOG.map(({ sha256 }) => sha256)).size).toBe(10);
    expect(LTX25_WORKFLOW_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    for (const entry of LTX25_WORKFLOW_CATALOG) expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps community FullRes candidates outside the official catalog", () => {
    expect(LTX25_WORKFLOW_CATALOG.some(({ filename }) => /fullres/i.test(filename))).toBe(false);
  });

  it("marks only BF16 as accepted by the current native runtime", () => {
    expect(LTX25_MODEL_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(LTX25_TRANSFORMER_CANDIDATES).toEqual([
      expect.objectContaining({ id: "bf16", nativeRuntimeStatus: "supported" }),
      expect.objectContaining({ id: "comfy-int8-convrot", nativeRuntimeStatus: "blocked-comfy-format" }),
      expect.objectContaining({ id: "nvfp4", nativeRuntimeStatus: "blocked-no-native-loader-proof" }),
    ]);
  });

  it("builds immutable upstream provenance from catalog identity", () => {
    expect(ltx25WorkflowContract("ic-lora-motion-track")).toMatchObject({
      commit: LTX25_WORKFLOW_COMMIT,
      path: "example_workflows/2.5/LTX-2.5_ICLoRA_Motion_Track_Distilled.json",
      sha256: "6ff1604c041771f9be6a375c27f5fcb5689ffe94194f56d188ce1d3c2e809ecd",
    });
  });
});
