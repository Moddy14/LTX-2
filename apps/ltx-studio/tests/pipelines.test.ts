import { describe, expect, it } from "vitest";

import {
  createDefaultRequest,
  generationRequestSchema,
  hasDialogueIntent,
  mergeGenerationRequest,
  migrateGenerationRequest,
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
    expect(createDefaultRequest("two-stage").models.gemmaLora.enabled).toBe(false);
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

  it.each(["pixel-upscaler", "v2v-instant-shave"] as const)(
    "requires exactly one source video and no separate image for %s",
    (profile) => {
      const request = validRequest("ic-lora");
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
    });
    request.postprocess.lipForcing.enabled = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.postprocess.lipForcing.decoder = "streaming-taehv";
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
    request.postprocess.museTalk.enabled = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
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
