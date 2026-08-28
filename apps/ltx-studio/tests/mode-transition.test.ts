import { describe, expect, it } from "vitest";

import {
  createDefaultRequest,
  createPreferredRequest,
} from "../shared/pipelines.js";
import { LTX25_WORKFLOW_CATALOG } from "../shared/ltx25Catalog.js";
import {
  recommendedModelAsset,
  recommendedModelAssets,
  type ModelInventory,
} from "../shared/models.js";
import { requestForModeChange } from "../src/modeTransition.js";

const completeLtx25Inventory: ModelInventory = {
  roots: ["/home/moddy/LTX-2.5"],
  scannedAt: new Date(0).toISOString(),
  truncated: false,
  errors: [],
  items: [],
  recommendations: recommendedModelAssets.map((asset) => ({
    ...asset,
    present: true,
    integrity: "verified" as const,
    actualSha256: "expectedSha256" in asset ? asset.expectedSha256 : null,
  })),
};

describe("editor mode transition", () => {
  it("starts a new editor on the official LTX-2.5 two-stage baseline", () => {
    const request = createPreferredRequest();

    expect(request).toMatchObject({
      mode: "distilled",
      distilled: { singleStage: false },
      enhancePrompt: false,
      models: { layout: "split", generation: "2.5" },
      quantization: { mode: "none", amaxPath: "" },
    });
  });

  it("switches an explicit LTX-2.3 draft to a clean LTX-2.5 contract", () => {
    const current = createDefaultRequest("two-stage");
    current.prompt = "Preserve this scene";
    current.promptParts.dialogue = "Exakter Wortlaut";
    current.models.checkpointPath = "/legacy/ltx-2.3.safetensors";
    current.models.gemmaRoot = "/legacy/gemma";
    current.quantization = { mode: "fp8-cast", amaxPath: "" };

    const next = requestForModeChange(current, "distilled", null);

    expect(next).toMatchObject({
      mode: "distilled",
      prompt: "Preserve this scene",
      promptParts: { dialogue: "Exakter Wortlaut" },
      enhancePrompt: false,
      models: {
        layout: "split",
        generation: "2.5",
        checkpointPath: "",
        gemmaRoot: "",
      },
      quantization: { mode: "none", amaxPath: "" },
    });
  });

  it.each(["distilled", "text-to-audio", "ic-lora", "image-audio-to-video"] as const)(
    "uses LTX-2.5 for a deliberate switch to %s",
    (mode) => {
      const next = requestForModeChange(createDefaultRequest("two-stage"), mode, null);
      expect(next.models).toMatchObject({ layout: "split", generation: "2.5" });
      expect(next.quantization.mode).toBe("none");
    },
  );

  it("drops controls that the official IA2V SimpleDenoiser cannot consume", () => {
    const current = createDefaultRequest("audio-to-video");
    current.negativePrompt = "legacy exclusions";
    current.videoGuidance.modalityScale = 9;
    current.audioGuidance.stgBlocks = [4, 12];

    const next = requestForModeChange(current, "image-audio-to-video", null);
    const defaults = createDefaultRequest("image-audio-to-video");
    expect(next.negativePrompt).toBe("");
    expect(next.videoGuidance).toEqual(defaults.videoGuidance);
    expect(next.audioGuidance).toEqual(defaults.audioGuidance);
  });

  it("uses an implemented single-stage Ingredients contract for latest-first IC-LoRA", () => {
    const request = createPreferredRequest("ic-lora");
    const workflow = LTX25_WORKFLOW_CATALOG.find(({ nativeBinding }) =>
      nativeBinding?.mode === "ic-lora"
      && nativeBinding.icLoraProfile === request.icLora.profile);

    expect(request).toMatchObject({
      mode: "ic-lora",
      width: 960,
      height: 544,
      frameRate: 24,
      models: { layout: "split", generation: "2.5" },
      icLora: {
        profile: "ingredients",
        controlType: "prepared",
        skipStage2: true,
      },
    });
    expect(workflow).toMatchObject({
      id: "ic-lora-ingredients",
      stages: 1,
      spatialUpscale: false,
      nativeStatus: "implemented-contract",
    });
  });

  it("does not promote hidden legacy Union-Control state into an LTX-2.5 mode switch", () => {
    const current = createDefaultRequest("two-stage");
    current.icLora.profile = "union-control";
    current.icLora.controlType = "depth";
    current.icLora.mogeModelPath = "/legacy/moge.safetensors";
    current.icLora.videoConditioning = [
      { path: "/legacy/control.mp4", name: "control.mp4", strength: 1 },
    ];

    const next = requestForModeChange(current, "ic-lora", null);

    expect(next).toMatchObject({
      mode: "ic-lora",
      width: 960,
      height: 544,
      frameRate: 24,
      models: { layout: "split", generation: "2.5" },
      icLora: {
        profile: "ingredients",
        controlType: "prepared",
        mogeModelPath: "",
        videoConditioning: [],
        skipStage2: true,
      },
    });
    expect(next.icLora.lora.path).toBe(
      recommendedModelAsset("ltx23-ingredients-lora").localPath,
    );
  });

  it("preserves runnable IC-LoRA settings across a temporary mode switch while repinning the model", () => {
    const configured = createPreferredRequest("ic-lora");
    configured.icLora.lora.path = "/custom/ingredients.safetensors";
    configured.icLora.lora.strength = 0.72;
    configured.icLora.attentionStrength = 0.63;
    configured.icLora.skipStage2 = true;
    const temporarilyDistilled = requestForModeChange(configured, "distilled", null);

    const restored = requestForModeChange(temporarilyDistilled, "ic-lora", null);

    expect(restored.icLora).toEqual({
      ...configured.icLora,
      lora: {
        ...configured.icLora.lora,
        path: recommendedModelAsset("ltx23-ingredients-lora").localPath,
      },
    });
    expect(restored.icLora).toMatchObject({
      profile: "ingredients",
      attentionStrength: 0.63,
      skipStage2: true,
      lora: { strength: 0.72 },
    });
  });

  it("fills the required LTX-2.5 spatial upscaler on the T2A to IA2V GUI transition", () => {
    const next = requestForModeChange(
      createPreferredRequest("text-to-audio"),
      "image-audio-to-video",
      completeLtx25Inventory,
    );

    expect(next.models.spatialUpscalerPath).toBe(
      recommendedModelAsset("ltx25-spatial-upscaler-bf16").localPath,
    );
  });

  it.each(["two-stage", "two-stage-hq", "one-stage"] as const)(
    "keeps the explicit compatibility mode %s on LTX-2.3",
    (mode) => {
      const next = requestForModeChange(createPreferredRequest(), mode, null);
      expect(next.models).toMatchObject({ layout: "monolith", generation: "2.3" });
    },
  );

  it("starts DFR with the complete default postprocess stack disabled", () => {
    const current = createDefaultRequest("image-audio-to-video");
    current.models.loras = [{ path: "/legacy/dfr-distilled-lora.safetensors", strength: 1 }];
    current.postprocess.longcatLipsync.enabled = true;
    current.postprocess.latentSync.enabled = true;
    current.postprocess.museTalk.enabled = true;
    current.postprocess.lipForcing.enabled = true;

    const dfr = requestForModeChange(current, "dfr", null);

    expect(dfr.postprocess).toEqual(createDefaultRequest("dfr").postprocess);
    expect(dfr.postprocess.longcatLipsync.enabled).toBe(false);
    expect(dfr.postprocess.latentSync.enabled).toBe(false);
    expect(dfr.postprocess.museTalk.enabled).toBe(false);
    expect(dfr.postprocess.lipForcing.enabled).toBe(false);
    expect(dfr.models.loras).toEqual([]);
    expect(dfr.models.transformerPath).toBe("");
    expect(dfr.dfr).toMatchObject({
      temporalUpscalings: 0,
      spatialUpscalings: 1,
      detailingLoraPath: "",
    });
  });
});
