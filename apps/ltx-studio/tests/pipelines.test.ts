import { describe, expect, it } from "vitest";

import {
  createDefaultRequest,
  dfrOutputGeometry,
  generationRequestSchema,
  hasDialogueIntent,
  ia2vEditorNormalizationPaths,
  ia2vEditorNormalizationWarnings,
  mergeEditableGenerationRequest,
  mergeGenerationRequest,
  migrateGenerationRequest,
  isLegacyDfrRequest,
  pipelineModes,
  withLongCatLipsyncDisabled,
  type GenerationRequest,
} from "../shared/pipelines.js";
import { validLtx25SplitRequest, validRequest } from "./fixtures.js";

describe("generationRequestSchema", () => {
  it("uses the official prompt-enhancement defaults", () => {
    expect(createDefaultRequest("two-stage").enhancePrompt).toBe(true);
    expect(createDefaultRequest("image-audio-to-video").enhancePrompt).toBe(true);
    expect(createDefaultRequest("ic-lora").enhancePrompt).toBe(false);
    expect(createDefaultRequest("keyframes").enhancePrompt).toBe(false);
    expect(createDefaultRequest("id-lora").enhancePrompt).toBe(false);
    expect(createDefaultRequest("text-to-audio").enhancePrompt).toBe(false);
    expect(createDefaultRequest("text-to-audio").outputName).toBe("ltx-text-to-audio.wav");
    expect(createDefaultRequest("text-to-audio").audioGuidance.cfgScale).toBe(1);
    expect(createDefaultRequest("text-to-audio").audioGuidance.modalityScale).toBe(1);
    expect(createDefaultRequest("text-to-audio").textToAudio.peakCeilingDbfs).toBe(-3);
    expect(createDefaultRequest("two-stage").models.gemmaLora.enabled).toBe(false);
  });

  it("normalizes hidden inert IA2V controls only in the editable copy", () => {
    const historical = validLtx25SplitRequest("image-audio-to-video");
    historical.negativePrompt = "bad anatomy";
    historical.videoGuidance.modalityScale = 5;
    historical.audioGuidance.stgBlocks = [12];
    const original = structuredClone(historical);

    expect(ia2vEditorNormalizationPaths(historical)).toEqual([
      "negativePrompt",
      "videoGuidance.modalityScale",
      "audioGuidance.stgBlocks",
    ]);
    expect(ia2vEditorNormalizationWarnings(historical)[0]).toContain(
      "nicht in die Editierkopie übernommen",
    );
    const editable = mergeEditableGenerationRequest(historical, historical.mode);
    const defaults = createDefaultRequest("image-audio-to-video");
    expect(editable.negativePrompt).toBe("");
    expect(editable.videoGuidance).toEqual(defaults.videoGuidance);
    expect(editable.audioGuidance).toEqual(defaults.audioGuidance);
    expect(historical).toEqual(original);
  });

  it("preserves inert historical IA2V values in canonical server migration", () => {
    const historical = validLtx25SplitRequest("image-audio-to-video");
    historical.negativePrompt = "historical exclusions";
    historical.videoGuidance.modalityScale = 5;
    historical.audioGuidance.cfgScale = 9;

    expect(mergeGenerationRequest(historical, historical.mode)).toEqual(historical);
    expect(migrateGenerationRequest(historical)).toEqual(historical);
  });

  it("rejects a no-op cross-modal guidance override for audio-only T2A", () => {
    const request = validRequest("text-to-audio");
    request.audioGuidance.modalityScale = 3;

    const parsed = generationRequestSchema.safeParse(request);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["audioGuidance", "modalityScale"] }),
      ]));
    }
  });

  it("rejects ineffective or incomplete T2A guidance combinations", () => {
    const missingStgBlock = validRequest("text-to-audio");
    missingStgBlock.audioGuidance.stgScale = 0.5;
    expect(generationRequestSchema.safeParse(missingStgBlock).success).toBe(false);

    const inertStgBlock = validRequest("text-to-audio");
    inertStgBlock.audioGuidance.stgBlocks = [29];
    expect(generationRequestSchema.safeParse(inertStgBlock).success).toBe(false);

    const inertRescale = validRequest("text-to-audio");
    inertRescale.audioGuidance.rescaleScale = 0.7;
    expect(generationRequestSchema.safeParse(inertRescale).success).toBe(false);

    const activeCfgRescale = validRequest("text-to-audio");
    activeCfgRescale.audioGuidance.cfgScale = 1.1;
    activeCfgRescale.audioGuidance.rescaleScale = 0.7;
    expect(generationRequestSchema.safeParse(activeCfgRescale).success).toBe(true);

    const activeStg = validRequest("text-to-audio");
    activeStg.audioGuidance.stgScale = 0.5;
    activeStg.audioGuidance.stgBlocks = [29];
    expect(generationRequestSchema.safeParse(activeStg).success).toBe(true);
  });

  it("bounds T2A peak protection and rejects hidden no-op overrides in video modes", () => {
    const unsafe = validRequest("text-to-audio");
    unsafe.textToAudio.peakCeilingDbfs = 0;
    expect(generationRequestSchema.safeParse(unsafe).success).toBe(false);

    const hidden = validRequest("distilled");
    hidden.textToAudio.peakCeilingDbfs = -6;
    const parsed = generationRequestSchema.safeParse(hidden);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ["textToAudio", "peakCeilingDbfs"] }),
      ]));
    }
  });

  it("migrates stored requests without T2A peak protection to the safe default", () => {
    const legacy = structuredClone(validRequest("text-to-audio")) as Partial<GenerationRequest>;
    delete legacy.textToAudio;

    expect(migrateGenerationRequest(legacy)?.textToAudio).toEqual({ peakCeilingDbfs: -3 });
  });

  it("keeps Base-Gemma as the default and preserves legacy LoRA intent", () => {
    const base = validRequest("two-stage");
    base.models.gemmaLora.enabled = false;
    base.models.gemmaLora.path = "";
    expect(generationRequestSchema.safeParse(base).success).toBe(true);

    const legacy = structuredClone(validRequest("two-stage")) as unknown as {
      models: { gemmaLora: { enabled?: boolean; path: string; strength: number } };
    };
    delete legacy.models.gemmaLora.enabled;
    expect(mergeGenerationRequest(legacy).models.gemmaLora.enabled).toBe(true);

    legacy.models.gemmaLora.path = "";
    expect(mergeGenerationRequest(legacy).models.gemmaLora.enabled).toBe(false);

    const explicitlyDisabled = validRequest("two-stage");
    explicitlyDisabled.models.gemmaLora.enabled = false;
    expect(mergeGenerationRequest(explicitlyDisabled).models.gemmaLora.enabled).toBe(false);
  });

  it("uses the current native Comfy workflow frame rates and durations", () => {
    for (const mode of ["two-stage", "keyframes", "ic-lora"] as const) {
      expect(createDefaultRequest(mode)).toMatchObject({ frameRate: 25, numFrames: 129 });
    }
    expect(createDefaultRequest("image-audio-to-video")).toMatchObject({
      frameRate: 24,
      numFrames: 217,
    });
    expect(createDefaultRequest("id-lora")).toMatchObject({
      frameRate: 25,
      numFrames: 249,
    });
  });

  it("adapts the documented 1280x720 Comfy workflows to native-safe 1280x704", () => {
    for (const mode of [
      "two-stage",
      "keyframes",
      "image-audio-to-video",
      "ic-lora",
      "id-lora",
    ] as const) {
      expect(createDefaultRequest(mode)).toMatchObject({ width: 1280, height: 704 });
    }
  });

  it.each(pipelineModes)("accepts a complete %s request", (mode) => {
    expect(generationRequestSchema.safeParse(validRequest(mode)).success).toBe(true);
  });

  it.each(["distilled", "text-to-audio", "image-audio-to-video"] as const)(
    "accepts the explicit LTX-2.5 split-pack contract for %s",
    (mode) => {
      expect(generationRequestSchema.safeParse(validLtx25SplitRequest(mode)).success).toBe(true);
    },
  );

  it("defaults DFR to the pinned v1.3 split pack and an honest missing-detailer HOLD", () => {
    const request = createDefaultRequest("dfr");
    expect(request).toMatchObject({
      mode: "dfr",
      models: { layout: "split", generation: "2.5" },
      dfr: {
        temporalUpscalings: 0,
        spatialUpscalings: 1,
        temporalUpscalerPath: "",
        detailingLoraPath: "",
      },
    });
  });

  it("validates the v1.3 DFR assets, upscaling flags and 128er grid fail closed", () => {
    const request = validLtx25SplitRequest("dfr");
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    const monolith = structuredClone(request);
    monolith.models.layout = "monolith";
    monolith.models.generation = "2.3";
    expect(generationRequestSchema.safeParse(monolith).success).toBe(false);

    const devTransformer = structuredClone(request);
    devTransformer.models.transformerPath =
      "/models/ltx-2.5/ltx-2.5-22b-dev-transformer-bf16.safetensors";
    expect(generationRequestSchema.safeParse(devTransformer).success).toBe(false);

    const obsoleteDistilledLora = structuredClone(request);
    obsoleteDistilledLora.models.loras = [{
      path: "/models/ltx-2.5/ltx-2.5-22b-distilled-lora-450-bf16.safetensors",
      strength: 1,
    }];
    expect(generationRequestSchema.safeParse(obsoleteDistilledLora).success).toBe(false);

    const duplicateDetailer = structuredClone(request);
    duplicateDetailer.models.loras = [{
      path: duplicateDetailer.dfr!.detailingLoraPath,
      strength: 0.5,
    }];
    const duplicateResult = generationRequestSchema.safeParse(duplicateDetailer);
    expect(duplicateResult.success).toBe(false);
    if (!duplicateResult.success) {
      expect(duplicateResult.error.issues).toContainEqual(expect.objectContaining({
        path: ["models", "loras", 0, "path"],
        message: expect.stringContaining("nicht zusätzlich"),
      }));
    }

    const disabledTiling = structuredClone(request);
    disabledTiling.tiling = false;
    expect(generationRequestSchema.safeParse(disabledTiling).success).toBe(false);

    const temporal = structuredClone(request);
    temporal.dfr!.temporalUpscalings = 1;
    temporal.dfr!.temporalUpscalerPath = "";
    expect(generationRequestSchema.safeParse(temporal).success).toBe(false);
    temporal.dfr!.temporalUpscalerPath =
      "/models/ltx-2.5/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors";
    expect(generationRequestSchema.safeParse(temporal).success).toBe(true);

    const detailing = structuredClone(request);
    detailing.dfr!.detailingLoraPath = "";
    expect(generationRequestSchema.safeParse(detailing).success).toBe(false);
    detailing.dfr!.detailingLoraPath = "/models/unpinned-detailer.safetensors";
    expect(generationRequestSchema.safeParse(detailing).success).toBe(false);
    detailing.dfr!.detailingLoraPath =
      "/models/ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors";
    expect(generationRequestSchema.safeParse(detailing).success).toBe(true);

    const spatial = structuredClone(request);
    spatial.dfr!.spatialUpscalings = 2;
    spatial.height = 1088;
    expect(generationRequestSchema.safeParse(spatial).success).toBe(false);
    spatial.height = 1024;
    expect(generationRequestSchema.safeParse(spatial).success).toBe(true);

    const fractionalFps = structuredClone(request);
    fractionalFps.frameRate = 24_000 / 1_001;
    expect(generationRequestSchema.safeParse(fractionalFps).success).toBe(true);
  });

  it("derives exact DFR v1.3 final geometry for 0/1/2 temporal rounds", () => {
    const request = validLtx25SplitRequest("dfr");
    request.numFrames = 121;
    request.frameRate = 24_000 / 1_001;
    request.dfr!.spatialUpscalings = 2;

    expect(dfrOutputGeometry(request)).toMatchObject({
      width: request.width,
      height: request.height,
      numFrames: 121,
      frameRate: 24_000 / 1_001,
      temporalFactor: 1,
    });
    request.dfr!.temporalUpscalings = 1;
    expect(dfrOutputGeometry(request)).toMatchObject({
      numFrames: 241,
      frameRate: 48_000 / 1_001,
      temporalFactor: 2,
    });
    request.dfr!.temporalUpscalings = 2;
    const final = dfrOutputGeometry(request);
    expect(final).toMatchObject({
      numFrames: 481,
      frameRate: 96_000 / 1_001,
      temporalFactor: 4,
    });
    expect(final.durationSeconds).toBeCloseTo(120 / (24_000 / 1_001), 12);
  });

  it("migrates legacy DFR fields but clears the obsolete Dev-transformer authority", () => {
    const legacy = structuredClone(validLtx25SplitRequest("dfr")) as unknown as Record<string, unknown> & {
      models: GenerationRequest["models"];
      dfr: Record<string, unknown>;
    };
    legacy.models.transformerPath =
      "/models/ltx-2.5/ltx-2.5-22b-dev-transformer-bf16.safetensors";
    legacy.models.distilledLora = {
      path: "/models/ltx-2.5/ltx-2.5-22b-distilled-lora-450-bf16.safetensors",
      strength: 1,
    };
    legacy.models.loras = [
      {
        path: "/models/ltx-2.5/ltx-2.5-22b-distilled-lora-450-bf16.safetensors",
        strength: 1,
      },
      { path: "/models/custom-style.safetensors", strength: 0.6 },
    ];
    legacy.dfr = {
      distilledLora: {
        path: "/models/ltx-2.5/ltx-2.5-22b-distilled-lora-450-bf16.safetensors",
        strength: 1,
      },
      temporalUpsampleRounds: 2,
      temporalUpscalerPath:
        "/models/ltx-2.5/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors",
      detailingLora: {
        enabled: true,
        path: "/models/ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors",
        strength: 0.8,
      },
    };

    const migrated = mergeGenerationRequest(legacy);
    expect(migrated.models.transformerPath).toBe("");
    expect(migrated.models.distilledLora).toEqual({ path: "", strength: 1 });
    expect(migrated.models.loras).toEqual([
      { path: "/models/custom-style.safetensors", strength: 0.6 },
    ]);
    expect(migrated.dfr).toEqual({
      temporalUpscalings: 2,
      spatialUpscalings: 1,
      temporalUpscalerPath:
        "/models/ltx-2.5/ltx-2.5-latent-temporal-upscaler-x2-bf16-1.0.safetensors",
      detailingLoraPath:
        "/models/ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors",
    });
    expect(isLegacyDfrRequest(migrated)).toBe(true);
    expect(isLegacyDfrRequest(migrateGenerationRequest(legacy)!)).toBe(true);
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);

    migrated.models.transformerPath =
      "/models/ltx-2.5/ltx-2.5-22b-distilled-transformer-bf16.safetensors";
    delete migrated.legacyExecution;
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("keeps a formerly disabled legacy detailer on HOLD instead of enabling its stale path", () => {
    const legacy = structuredClone(validLtx25SplitRequest("dfr")) as unknown as {
      dfr: Record<string, unknown>;
    };
    legacy.dfr = {
      temporalUpsampleRounds: 0,
      temporalUpscalerPath: "",
      detailingLora: {
        enabled: false,
        path: "/models/ltx-2.5-22b-ic-lora-pixel-spatial-upscaler-x2-1.0.safetensors",
        strength: 1,
      },
    };

    const migrated = mergeGenerationRequest(legacy);
    expect(migrated.dfr?.detailingLoraPath).toBe("");
    expect(isLegacyDfrRequest(migrated)).toBe(true);
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("does not materialize DFR fields while parsing legacy frozen requests", () => {
    const legacy = structuredClone(validRequest("distilled")) as Record<string, unknown>;
    delete legacy.dfr;
    const parsed = generationRequestSchema.parse(legacy);
    expect(Object.hasOwn(parsed, "dfr")).toBe(false);
  });

  it("models the official single-stage preview without requiring an upscaler", () => {
    const request = validLtx25SplitRequest("distilled");
    request.distilled.singleStage = true;
    request.models.spatialUpscalerPath = "";
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.distilled.singleStage = false;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each(["comfy-int8-convrot", "nvfp4"])(
    "keeps the %s transformer outside the native BF16 contract",
    (variant) => {
      const request = validLtx25SplitRequest("distilled");
      request.models.transformerPath = `/models/ltx-2.5/ltx-2.5-22b-distilled-transformer-${variant}.safetensors`;
      expect(generationRequestSchema.safeParse(request).success).toBe(false);
    },
  );

  it("accepts only the verified official IC-LoRA subset with an LTX-2.5 split pack", () => {
    const request = validLtx25SplitRequest("ic-lora");
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.icLora.profile = "inpainting";
    request.images = [];
    request.icLora.attentionMaskPath = "/inputs/mask.mp4";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("fails closed when an LTX-2.5 split component is missing", () => {
    const request = validLtx25SplitRequest("distilled");
    request.models.audioVaePath = "";
    const parsed = generationRequestSchema.safeParse(request);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(expect.objectContaining({
        path: ["models", "audioVaePath"],
        message: "Audio-VAE fehlt.",
      }));
    }
  });

  it("migrates old projects to an explicit LTX-2.3 monolith contract", () => {
    const legacy = structuredClone(validRequest("distilled")) as unknown as {
      models: Partial<GenerationRequest["models"]>;
    };
    delete legacy.models.layout;
    delete legacy.models.generation;
    delete legacy.models.transformerPath;
    delete legacy.models.textEncoderPath;
    delete legacy.models.videoVaePath;
    delete legacy.models.audioVaePath;
    delete legacy.models.durationHeadPath;
    delete legacy.models.promptEnhancerGemmaRoot;

    const migrated = mergeGenerationRequest(legacy);
    expect(migrated.models).toMatchObject({ layout: "monolith", generation: "2.3" });
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("rejects unsafe output names", () => {
    const request = validRequest();
    request.outputName = "../outside.mp4";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("requires media-specific output extensions", () => {
    const audio = validRequest("text-to-audio");
    audio.outputName = "wrong.mp4";
    expect(generationRequestSchema.safeParse(audio).success).toBe(false);

    const video = validRequest("two-stage");
    video.outputName = "wrong.wav";
    expect(generationRequestSchema.safeParse(video).success).toBe(false);
  });

  it("migrates legacy negative random seeds to a concrete default", () => {
    const legacy = validRequest();
    legacy.seed = -1;
    const migrated = mergeGenerationRequest(legacy);
    expect(migrated.seed).toBe(10);
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("migrates audio jobs created before separate final mixes existed", () => {
    const legacy = structuredClone(validRequest("audio-to-video")) as unknown as {
      audio: {
        path: string;
        name: string;
        startTime: number;
        maxDuration: number | null;
        finalMix?: GenerationRequest["audio"]["finalMix"];
      };
    };
    delete legacy.audio.finalMix;

    const migrated = mergeGenerationRequest(legacy);

    expect(migrated.audio.finalMix).toEqual({ path: "", name: "" });
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("migrates the formerly reversed ID-LoRA image-strength field to stage 1", () => {
    const current = structuredClone(validRequest("id-lora"));
    const legacy = current as unknown as {
      idLora: Omit<GenerationRequest["idLora"], "stage1ImageStrength"> & {
        stage2ImageStrength: number;
        stage1ImageStrength?: number;
      };
    };
    delete legacy.idLora.stage1ImageStrength;
    legacy.idLora.stage2ImageStrength = 0.65;

    const migrated = mergeGenerationRequest(legacy);

    expect(migrated.idLora.stage1ImageStrength).toBe(0.65);
    expect("stage2ImageStrength" in migrated.idLora).toBe(false);
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("keeps legacy LipDub jobs readable while requiring the new contract only at plan time", () => {
    const legacy = structuredClone(validRequest("lipdub")) as unknown as {
      lipDub: {
        referenceVideo: GenerationRequest["lipDub"]["referenceVideo"];
        lora: GenerationRequest["lipDub"]["lora"];
        pipelineProfile?: GenerationRequest["lipDub"]["pipelineProfile"];
        targetLanguage?: string;
        singleSpeakerAcknowledged?: boolean;
      };
    };
    delete legacy.lipDub.pipelineProfile;
    delete legacy.lipDub.targetLanguage;
    delete legacy.lipDub.singleSpeakerAcknowledged;

    const migrated = mergeGenerationRequest(legacy);

    expect(migrated.lipDub.targetLanguage).toBe("");
    expect(migrated.lipDub.singleSpeakerAcknowledged).toBe(false);
    expect(migrated.lipDub.pipelineProfile).toBe("native-distilled");
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("uses the official Comfy HQ LipDub stack only for new requests", () => {
    const request = createDefaultRequest("lipdub");
    expect(request.lipDub.pipelineProfile).toBe("official-comfy-hq");
    expect(request.models.distilledLora.strength).toBe(0.5);
    expect([request.width, request.height]).toEqual([1088, 1920]);
  });

  it("uses the official single-stage IC-LoRA dimensions and migrates the profile", () => {
    const request = createDefaultRequest("ic-lora");
    expect([request.width, request.height]).toEqual([1280, 704]);
    expect(request.icLora.profile).toBe("union-control");
    expect(request.models.distilledLora.strength).toBe(1);

    const legacy = structuredClone(validRequest("ic-lora")) as unknown as {
      icLora: Omit<GenerationRequest["icLora"], "profile"> & {
        profile?: GenerationRequest["icLora"]["profile"];
      };
    };
    delete legacy.icLora.profile;
    expect(mergeGenerationRequest(legacy).icLora.profile).toBe("union-control");
  });

  it("does not require the separate distilled LoRA for native Union Control", () => {
    const union = validRequest("ic-lora");
    union.icLora.profile = "union-control";
    union.models.distilledLora.path = "";
    expect(generationRequestSchema.safeParse(union).success).toBe(true);

    const ingredients = structuredClone(union);
    ingredients.icLora.profile = "ingredients";
    ingredients.icLora.videoConditioning = [];
    expect(generationRequestSchema.safeParse(ingredients).success).toBe(false);
  });

  it("requires exactly one image but no control video for Ingredients", () => {
    const request = validRequest("ic-lora");
    request.icLora.profile = "ingredients";
    request.icLora.controlType = "prepared";
    request.icLora.videoConditioning = [];
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.images = [];
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.images = [
      { path: "/inputs/a.png", name: "a.png", frameIndex: 0, strength: 1, crf: 18 },
      { path: "/inputs/b.png", name: "b.png", frameIndex: 0, strength: 1, crf: 18 },
    ];
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each(["pixel-upscaler", "v2v-deblur", "v2v-instant-shave"] as const)(
    "requires exactly one source video and no separate image for %s",
    (profile) => {
      const request = profile === "v2v-deblur"
        ? validLtx25SplitRequest("ic-lora")
        : validRequest("ic-lora");
      request.icLora.profile = profile;
      request.icLora.controlType = "prepared";
      request.images = [];
      expect(generationRequestSchema.safeParse(request).success).toBe(true);

      request.images = [
        { path: "/inputs/hidden.png", name: "hidden.png", frameIndex: 0, strength: 1, crf: 18 },
      ];
      expect(generationRequestSchema.safeParse(request).success).toBe(false);
      request.images = [];
      request.icLora.videoConditioning = [];
      expect(generationRequestSchema.safeParse(request).success).toBe(false);
    },
  );

  it("binds Deblur strength 1 only to the current LTX-2.5 split V2V contract", () => {
    const split = validLtx25SplitRequest("ic-lora");
    split.icLora.profile = "v2v-deblur";
    split.images = [];
    expect(generationRequestSchema.safeParse(split).success).toBe(true);

    split.icLora.lora.strength = 0.9;
    expect(generationRequestSchema.safeParse(split).success).toBe(false);

    const legacyOnSplit = validLtx25SplitRequest("ic-lora");
    legacyOnSplit.icLora.profile = "v2v-instant-shave";
    legacyOnSplit.images = [];
    expect(generationRequestSchema.safeParse(legacyOnSplit).success).toBe(false);

    const deblurOnMonolith = validRequest("ic-lora");
    deblurOnMonolith.icLora.profile = "v2v-deblur";
    deblurOnMonolith.images = [];
    expect(generationRequestSchema.safeParse(deblurOnMonolith).success).toBe(false);
  });

  it("requires one image and a track sequence for Motion Track", () => {
    const request = validRequest("ic-lora");
    request.icLora.profile = "motion-track";
    request.icLora.controlType = "prepared";
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
    request.images = [];
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    ["inpainting", true],
    ["outpainting", false],
  ] as const)("requires the official source and mask contract for %s", (profile, needsMask) => {
    const request = validRequest("ic-lora");
    request.icLora.profile = profile;
    request.images = [];
    request.icLora.videoConditioning = [
      { path: "/inputs/source.mp4", name: "source.mp4", strength: 1 },
    ];
    request.icLora.attentionMaskPath = needsMask ? "/inputs/mask.mp4" : "";
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.icLora.videoConditioning = [];
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.icLora.videoConditioning = [
      { path: "/inputs/source.mp4", name: "source.mp4", strength: 1 },
    ];
    if (needsMask) {
      request.icLora.attentionMaskPath = "";
      expect(generationRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("requires one HDR source, scene embeddings and fixed LoRA strength", () => {
    const request = validRequest("ic-lora");
    request.icLora.profile = "hdr";
    request.images = [];
    request.icLora.hdrTextEmbeddingsPath = "/models/hdr-scene-emb.safetensors";
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.icLora.hdrTextEmbeddingsPath = "";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.icLora.hdrTextEmbeddingsPath = "/models/hdr-scene-emb.safetensors";
    request.icLora.lora.strength = 0.9;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("strips removed top-level fields while preserving valid legacy values", () => {
    const legacy = {
      ...validRequest(),
      prompt: "A preserved legacy prompt.",
      removedLegacyFlag: true,
    };
    const migrated = mergeGenerationRequest(legacy);
    expect(migrated.prompt).toBe("A preserved legacy prompt.");
    expect("removedLegacyFlag" in migrated).toBe(false);
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("rejects NUL bytes before values reach process spawning", () => {
    const promptRequest = validRequest();
    promptRequest.prompt = "valid prefix\0hidden suffix";
    expect(generationRequestSchema.safeParse(promptRequest).success).toBe(false);

    const pathRequest = validRequest();
    pathRequest.models.checkpointPath = "/models/checkpoint\0.safetensors";
    expect(generationRequestSchema.safeParse(pathRequest).success).toBe(false);
  });

  it("requires 8k+1 frames and mode-specific resolution divisors", () => {
    const request = validRequest("two-stage");
    request.numFrames = 120;
    request.width = 1500;
    const result = generationRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        "Frames müssen dem Muster 8k+1 folgen.",
        "Breite und Höhe müssen durch 64 teilbar sein.",
      ]));
    }
  });

  it("enforces the two-stage 64er grid for in/outpaint IC profiles", () => {
    const inpaint = validRequest("ic-lora");
    inpaint.icLora.profile = "inpainting";
    inpaint.icLora.attentionMaskPath = "/inputs/mask.mp4";
    inpaint.width = 736;
    const rejected = generationRequestSchema.safeParse(inpaint);
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(rejected.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        "Breite und Höhe müssen durch 64 teilbar sein.",
      ]));
    }

    const union = validRequest("ic-lora");
    union.width = 736;
    expect(generationRequestSchema.safeParse(union).success).toBe(true);
  });

  it("requires paths for every configured media and LoRA row", () => {
    const request = validRequest("ic-lora");
    request.images = [{ path: "", name: "empty", frameIndex: 0, strength: 1, crf: 33 }];
    request.models.loras = [{ path: "", strength: 1 }];
    request.icLora.lora.path = "";
    request.icLora.videoConditioning[0].path = "";
    const result = generationRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(expect.arrayContaining([
        "images.0.path",
        "models.loras.0.path",
        "icLora.lora.path",
        "icLora.videoConditioning.0.path",
      ]));
    }
  });

  it("requires one reference image only in explicit image-to-video mode", () => {
    const request = validRequest("two-stage");
    request.sourceMode = "image";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);

    request.images = [{ path: "/inputs/reference.png", name: "reference.png", frameIndex: 0, strength: 1, crf: 33 }];
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.sourceMode = "text";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("keeps legacy enhanced native-dialogue jobs readable for plan-time migration", () => {
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "Dieser Wortlaut muss erhalten bleiben";
    request.prompt = 'The woman says exactly: "Dieser Wortlaut muss erhalten bleiben".';
    request.enhancePrompt = true;

    expect(generationRequestSchema.safeParse(request).success).toBe(true);
    expect(migrateGenerationRequest(request)).not.toBeNull();
  });

  it("recognizes explicit speech verbs without treating a UI dialog as spoken dialogue", () => {
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "";
    request.prompt = 'A woman whispers, "Hello".';
    expect(hasDialogueIntent(request)).toBe(true);
    request.prompt = "Eine Frau flüstert: Guten Morgen.";
    expect(hasDialogueIntent(request)).toBe(true);
    request.prompt = 'A woman asks, "Are you ready?"';
    expect(hasDialogueIntent(request)).toBe(true);
    request.prompt = "A man shouts: Stop!";
    expect(hasDialogueIntent(request)).toBe(true);
    request.prompt = "Eine Frau antwortet: Ja.";
    expect(hasDialogueIntent(request)).toBe(true);
    request.prompt = 'Dialogue: "This legacy label remains supported."';
    expect(hasDialogueIntent(request)).toBe(true);
    request.prompt = "A settings dialog opens on screen.";
    expect(hasDialogueIntent(request)).toBe(false);
    request.prompt = "A dialogue box opens on screen.";
    expect(hasDialogueIntent(request)).toBe(false);
    request.prompt = 'A sign reads "OPEN".';
    expect(hasDialogueIntent(request)).toBe(false);
  });

  it("requires an explicit acknowledgement for clips longer than ten seconds", () => {
    const request = validRequest();
    request.numFrames = 481;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.longClipAcknowledged = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("requires the official FLF2V start and final frame indices", () => {
    const request = validRequest("keyframes");
    request.images[1].frameIndex = request.numFrames;
    let result = generationRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("images.1.frameIndex");
    }

    request.images[1].frameIndex = 64;
    result = generationRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        `Das Endbild muss auf dem letzten Frame ${request.numFrames - 1} liegen.`,
      );
    }
  });

  it("accepts scaled FP8 checkpoints without an external AMAX file", () => {
    const request = validRequest();
    request.quantization = { mode: "fp8-scaled-mm", amaxPath: "" };
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("requires at least one regenerated Retake modality", () => {
    const request = validRequest("retake");
    request.retake.regenerateVideo = false;
    request.retake.regenerateAudio = false;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("requires both a reference image and audio for the official IA2V mode", () => {
    const request = validRequest("image-audio-to-video");
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.images = [];
    expect(generationRequestSchema.safeParse(request).success).toBe(false);

    request.images = [{
      path: "/inputs/speaker.png",
      name: "speaker.png",
      frameIndex: 0,
      strength: 1,
      crf: 33,
    }];
    request.audio.path = "";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("requires the complete official ID-LoRA identity contract", () => {
    const request = validRequest("id-lora");
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.images = [];
    request.idLora.referenceAudio.path = "";
    request.idLora.lora.path = "";
    request.promptParts.dialogue = "";
    request.enhancePrompt = true;
    request.idLora.identityGuidanceStart = 0.8;
    request.idLora.identityGuidanceEnd = 0.2;
    const result = generationRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(expect.arrayContaining([
        "images",
        "idLora.referenceAudio.path",
        "idLora.lora.path",
        "promptParts.dialogue",
        "enhancePrompt",
        "idLora.identityGuidanceEnd",
      ]));
    }
  });

  it("keeps the LongCat lip pass optional and requires audio-to-video inputs when enabled", () => {
    const disabled = validRequest("audio-to-video");
    expect(generationRequestSchema.safeParse(disabled).success).toBe(true);

    const enabled = validRequest("audio-to-video");
    enabled.postprocess.longcatLipsync.enabled = true;
    expect(generationRequestSchema.safeParse(enabled).success).toBe(false);

    enabled.images = [{
      path: "/inputs/face.png",
      name: "face.png",
      frameIndex: 0,
      strength: 1,
      crf: 33,
    }];
    expect(generationRequestSchema.safeParse(enabled).success).toBe(true);

    enabled.mode = "two-stage";
    expect(generationRequestSchema.safeParse(enabled).success).toBe(false);
  });

  it("keeps LatentSync optional, bounded, and mutually exclusive with LongCat", () => {
    const request = validRequest("lipdub");
    request.postprocess.latentSync.enabled = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.postprocess.latentSync.steps = 19;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.postprocess.latentSync.steps = 30;
    request.postprocess.latentSync.guidance = 3.1;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.postprocess.latentSync.guidance = 2;
    request.postprocess.longcatLipsync.enabled = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("keeps MuseTalk optional, bounded, and exclusive from other lip refiners", () => {
    const request = validRequest("lipdub");
    expect(request.postprocess.museTalk.enabled).toBe(false);
    request.postprocess.museTalk.enabled = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.postprocess.museTalk.extraMargin = 81;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.postprocess.museTalk.extraMargin = 10;
    request.postprocess.museTalk.audioPaddingLeft = 13;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.postprocess.museTalk.audioPaddingLeft = 2;
    request.postprocess.latentSync.enabled = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("keeps LipForcing off by default and exclusive from every other lip refiner", () => {
    const request = validRequest("lipdub");
    expect(request.postprocess.lipForcing).toEqual({
      enabled: false,
      decoder: "wan-vae",
      rawOutputProfile: "h264-crf13-mux-crf18-v1",
      mouthDelayMs: 0,
      programAudioDelayMs: 0,
    });
    request.postprocess.lipForcing.enabled = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.postprocess.lipForcing.decoder = "streaming-taehv";
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
    request.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
    expect(generationRequestSchema.safeParse({
      ...request,
      postprocess: {
        ...request.postprocess,
        lipForcing: {
          ...request.postprocess.lipForcing,
          rawOutputProfile: "unregistered-mux-profile",
        },
      },
    }).success).toBe(false);
    request.postprocess.lipForcing.mouthDelayMs = 501;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.postprocess.lipForcing.mouthDelayMs = 125;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
    request.postprocess.lipForcing.programAudioDelayMs = -501;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.postprocess.lipForcing.programAudioDelayMs = 125;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
    request.postprocess.museTalk.enabled = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("defines a neutral bounded output-audio delay and migrates legacy requests to zero", () => {
    const request = validLtx25SplitRequest("image-audio-to-video");
    expect(request.audio.outputDelayMs).toBe(0);
    request.audio.outputDelayMs = 500;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
    request.audio.outputDelayMs = -1;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.audio.outputDelayMs = 501;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.audio.outputDelayMs = 0.5;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);

    const legacy = structuredClone(validLtx25SplitRequest("image-audio-to-video")) as unknown as {
      audio: Record<string, unknown>;
    };
    delete legacy.audio.outputDelayMs;
    expect(generationRequestSchema.safeParse(legacy).success).toBe(false);
    expect(migrateGenerationRequest(legacy)?.audio.outputDelayMs).toBe(0);
  });

  it("migrates a stored pre-profile request only to the command-compatible LipForcing default", () => {
    const legacy = structuredClone(validRequest("lipdub")) as unknown as {
      postprocess: { lipForcing: Record<string, unknown> };
    };
    delete legacy.postprocess.lipForcing.rawOutputProfile;

    expect(generationRequestSchema.safeParse(legacy).success).toBe(false);
    expect(migrateGenerationRequest(legacy)?.postprocess.lipForcing.rawOutputProfile)
      .toBe("h264-crf13-mux-crf18-v1");

    legacy.postprocess.lipForcing.rawOutputProfile = "unregistered-mux-profile";
    expect(migrateGenerationRequest(legacy)).toBeNull();
  });

  it("requires the native LipDub reference contract", () => {
    const request = validRequest("lipdub");
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.lipDub.referenceVideo.path = "";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);

    request.lipDub.referenceVideo.path = "/inputs/speaker-reference.mp4";
    request.lipDub.lora.path = "";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);

    request.lipDub.lora.path = "/models/ltx/ltx-lipdub-lora.safetensors";
    request.prompt = "A portrait with no exact speech.";
    request.promptParts.dialogue = "";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects LipDub inputs that are not sent to the native CLI", () => {
    const request = validRequest("lipdub");
    request.images = [{ path: "/inputs/reference.png", name: "reference.png", frameIndex: 0, strength: 1, crf: 33 }];
    request.models.loras = [{ path: "/models/extra.safetensors", strength: 1 }];
    const result = generationRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(expect.arrayContaining([
        "images",
        "models.loras",
      ]));
    }
  });

  it("turns off LongCat without dropping its stored tuning values", () => {
    const request = validRequest("audio-to-video");
    request.postprocess.longcatLipsync = { enabled: true, resolution: "720p", blend: 0.65 };

    const disabled = withLongCatLipsyncDisabled(request);

    expect(disabled.postprocess.longcatLipsync).toEqual({ enabled: false, resolution: "720p", blend: 0.65 });
  });

  it("rejects unknown top-level fields", () => {
    const request = { ...validRequest(), shellCommand: "rm -rf /" } as GenerationRequest;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });
});
