import { describe, expect, it } from "vitest";

import {
  LTX25_DFR_DETAILING_REVISION,
  LTX25_DFR_PIPELINE_CONTRACT,
  LTX25_MODEL_COMPONENTS,
  LTX25_MODEL_REVISION,
  LTX25_TRANSFORMER_CANDIDATES,
  LTX25_V2V_DEBLUR_SEMANTIC_CONTRACT,
  LTX25_WORKFLOW_CATALOG,
  LTX25_WORKFLOW_COMMIT,
  ltx25WorkflowContract,
} from "../shared/ltx25Catalog.js";
import { icLoraModelAssetId, recommendedModelAsset } from "../shared/models.js";
import { createDefaultRequest } from "../shared/pipelines.js";
import { upstreamWorkflowContractsForRequest } from "../shared/upstreamWorkflowContracts.js";

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

  it("does not mislabel the executable two-stage Union Control graph as implemented", () => {
    expect(LTX25_WORKFLOW_CATALOG.find(({ id }) => id === "ic-lora-union-control")).toMatchObject({
      stages: 2,
      spatialUpscale: true,
      nativeStatus: "implementation-required",
    });
  });

  it("pins the official native DFR source and every core/optional artifact exactly", () => {
    expect(LTX25_DFR_PIPELINE_CONTRACT).toEqual({
      repository: "https://github.com/Lightricks/LTX-2",
      tag: "v1.3.0",
      commit: "598ab41247a77dbfe29b5186e915bcf4f9040ec7",
      path: "packages/ltx-pipelines/src/ltx_pipelines/dfr_pipeline.py",
      sha256: "227df4b2d0463bc543be87e8b7973ff76b0e2a423b2dd770ddd051f66e995e63",
      module: "ltx_pipelines.dfr_pipeline",
      scheduling: "single-call-non-cooperative",
      detailingLoraStrength: 0.5,
      temporalUpscalings: [0, 1, 2],
      spatialUpscalings: [1, 2],
    });
    expect(LTX25_MODEL_REVISION).toBe("6c7e5e573ac1667efc83407806fe9b0b93730e60");
    expect(LTX25_DFR_DETAILING_REVISION).toBe("74c4e68ee7dd99f3997d5a1bb1a3784941822222");
    expect(LTX25_MODEL_COMPONENTS).toMatchObject({
      transformer: {
        path: "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors",
        sizeBytes: 42_018_190_584,
        sha256: "31eb3cad89b9e54e99dd3baf286f70825ac4f6c660a70d9184d895be76d7bff4",
      },
      temporalUpscaler: {
        path: "latent_upscale_models/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors",
        sizeBytes: 261_944_000,
        sha256: "2bc3300f2b3c3c1834d72164fbf13a3b9fd73e5a741e8a2c3f4035f89a75c3fe",
      },
      dfrDetailingLora: {
        path: "ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors",
        sizeBytes: 327_322_640,
        sha256: "984851b769ea2bcb4c9e0a239a7676239e42c6a6001ddc69943b41ff0b283c1d",
      },
    });

    expect(upstreamWorkflowContractsForRequest(createDefaultRequest("dfr"))).toEqual([{
      role: "official-native-pipeline:ltx-2.5:dfr",
      repository: LTX25_DFR_PIPELINE_CONTRACT.repository,
      commit: LTX25_DFR_PIPELINE_CONTRACT.commit,
      path: LTX25_DFR_PIPELINE_CONTRACT.path,
      sha256: LTX25_DFR_PIPELINE_CONTRACT.sha256,
    }]);
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

  it("keeps the executable V2V workflow, profile and pinned Deblur model semantically aligned offline", () => {
    const semantic = LTX25_V2V_DEBLUR_SEMANTIC_CONTRACT;
    const workflow = LTX25_WORKFLOW_CATALOG.find(({ id }) => id === semantic.workflowId);
    const asset = recommendedModelAsset(semantic.model.assetId);
    const request = createDefaultRequest("ic-lora");
    request.icLora.profile = semantic.profile;
    request.models.layout = "split";
    request.models.generation = "2.5";

    expect(workflow).toMatchObject({
      sha256: semantic.auditedWorkflowSha256,
      nativeBinding: { mode: "ic-lora", icLoraProfile: semantic.profile },
    });
    expect(icLoraModelAssetId(request)).toBe(semantic.model.assetId);
    expect(upstreamWorkflowContractsForRequest(request)).toEqual([
      expect.objectContaining({
        path: `example_workflows/2.5/${workflow?.filename}`,
        sha256: semantic.auditedWorkflowSha256,
      }),
    ]);
    expect(asset).toMatchObject({
      repoId: semantic.model.repoId,
      revision: semantic.model.revision,
      filename: semantic.model.filename,
      expectedSizeBytes: semantic.model.sizeBytes,
      expectedSha256: semantic.model.sha256,
    });
    expect(semantic.model.strength).toBe(1);
  });
});
