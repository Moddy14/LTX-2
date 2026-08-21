import { z } from "zod";

import { framesForDuration, videoDurationSeconds } from "./presets.js";
import { LTX25_MODEL_COMPONENTS } from "./ltx25Catalog.js";

export const pipelineModes = [
  "two-stage",
  "two-stage-hq",
  "one-stage",
  "distilled",
  "text-to-audio",
  "ic-lora",
  "id-lora",
  "keyframes",
  "image-audio-to-video",
  "audio-to-video",
  "lipdub",
  "retake",
] as const;

export type PipelineMode = (typeof pipelineModes)[number];

export function isAudioConditionedMode(mode: PipelineMode): boolean {
  return mode === "image-audio-to-video" || mode === "audio-to-video";
}

export function isAudioOnlyMode(mode: PipelineMode): boolean {
  return mode === "text-to-audio";
}

export function isReferenceAudioMode(mode: PipelineMode): boolean {
  return mode === "id-lora";
}

export function needsGemmaAbliteratedLora(mode: PipelineMode): boolean {
  return [
    "two-stage",
    "two-stage-hq",
    "image-audio-to-video",
    "audio-to-video",
  ].includes(mode);
}

export function supportsGemmaAbliteratedLoraForRequest(
  input: { mode: PipelineMode; icLora: { profile: ICLoraProfile } },
): boolean {
  return needsGemmaAbliteratedLora(input.mode)
    || (input.mode === "ic-lora" && input.icLora.profile === "union-control");
}

export function needsGemmaAbliteratedLoraForRequest(
  input: {
    mode: PipelineMode;
    icLora: { profile: ICLoraProfile };
    models: { gemmaLora: { enabled: boolean } };
  },
): boolean {
  return supportsGemmaAbliteratedLoraForRequest(input) && input.models.gemmaLora.enabled;
}

export const sourceModes = ["text", "image"] as const;
export type SourceMode = (typeof sourceModes)[number];

export const modelLayouts = ["monolith", "split"] as const;
export type ModelLayout = (typeof modelLayouts)[number];

export const modelGenerations = ["2.3", "2.5"] as const;
export type ModelGeneration = (typeof modelGenerations)[number];

export function usesSplitModelPack(
  input: Pick<GenerationRequest, "models">,
): boolean {
  return input.models.layout === "split";
}

export const icLoraProfiles = [
  "union-control",
  "ingredients",
  "motion-track",
  "pixel-upscaler",
  "v2v-instant-shave",
  "inpainting",
  "outpainting",
  "hdr",
] as const;
export type ICLoraProfile = (typeof icLoraProfiles)[number];

export const lipDubPipelineProfiles = ["official-comfy-hq", "native-distilled"] as const;
export type LipDubPipelineProfile = (typeof lipDubPipelineProfiles)[number];

export function usesOfficialComfyLipDub(
  input: Pick<GenerationRequest, "mode" | "lipDub">,
): boolean {
  return input.mode === "lipdub" && input.lipDub.pipelineProfile === "official-comfy-hq";
}

const promptPart = z.string().max(2_000).refine(
  (value) => !value.includes("\0"),
  { message: "NUL-Zeichen sind nicht erlaubt." },
);

export const promptPartsSchema = z.object({
  subject: promptPart,
  action: promptPart,
  environment: promptPart,
  camera: promptPart,
  lighting: promptPart,
  dialogue: promptPart,
  ambience: promptPart,
  music: promptPart,
});

export type PromptParts = z.infer<typeof promptPartsSchema>;

const DIALOGUE_INTENT_PATTERN =
  /\b(?:says?|said|saying|speaks?|speaking|talks?|talking|asks?|asking|answers?|answering|replies|replied|replying|shouts?|shouting|whispers?|whispering|murmurs?|murmuring|mutters?|muttering|sings?|singing|sagt|sagen|spricht|sprechen|redet|reden|fragt|fragen|antwortet|antworten|ruft|rufen|schreit|schreien|flüstert|flüstern|murmelt|murmeln|singt|singen|erzählt|erzählen)\b/i;
const DIALOGUE_LABEL_PATTERN = /\bdialogue\s*:/i;

export function hasDialogueIntent(
  input: Pick<GenerationRequest, "mode" | "prompt" | "promptParts">,
): boolean {
  return input.mode === "lipdub"
    || input.promptParts.dialogue.trim().length > 0
    || DIALOGUE_INTENT_PATTERN.test(input.prompt)
    || DIALOGUE_LABEL_PATTERN.test(input.prompt);
}

export function isNativeDialogueRequest(
  input: Pick<GenerationRequest, "mode" | "prompt" | "promptParts">,
): boolean {
  return ["two-stage", "two-stage-hq", "one-stage", "distilled"].includes(input.mode)
    && hasDialogueIntent(input);
}

export type PipelineDefinition = {
  id: PipelineMode;
  label: string;
  shortLabel: string;
  description: string;
  family: "generate" | "condition" | "edit";
  quality: string;
  defaultHeight: number;
  defaultWidth: number;
  defaultSteps: number;
  needsNegativePrompt: boolean;
  needsSpatialUpscaler: boolean;
  needsDistilledLora: boolean;
};

export const PIPELINES: readonly PipelineDefinition[] = [
  {
    id: "two-stage",
    label: "Offiziell Text / Bild zu Video",
    shortLabel: "T2V / I2V",
    description: "Offizieller LTX-2.3-ComfyUI-Ablauf mit festem 8+3-Schedule und Spatial Upscaling.",
    family: "generate",
    quality: "Offiziell · 8 + 3",
    // The Comfy template uses 1280x720. Native LTX requires dimensions
    // divisible by 32, so Studio keeps the aspect ratio at 1280x704.
    defaultHeight: 704,
    defaultWidth: 1280,
    defaultSteps: 8,
    needsNegativePrompt: true,
    needsSpatialUpscaler: true,
    needsDistilledLora: true,
  },
  {
    id: "two-stage-hq",
    label: "HQ Zwei-Stufen",
    shortLabel: "HQ",
    description: "1920 x 1088 Preset mit Res2S-Sampling und getrennten LoRA-Stärken.",
    family: "generate",
    quality: "Maximale Qualität",
    defaultHeight: 1088,
    defaultWidth: 1920,
    defaultSteps: 15,
    needsNegativePrompt: true,
    needsSpatialUpscaler: true,
    needsDistilledLora: true,
  },
  {
    id: "one-stage",
    label: "Schneller Entwurf",
    shortLabel: "Eine Stufe",
    description: "Direkte Generation für Entwurf und schnelle Iteration.",
    family: "generate",
    quality: "Schnell",
    defaultHeight: 512,
    defaultWidth: 768,
    defaultSteps: 30,
    needsNegativePrompt: true,
    needsSpatialUpscaler: false,
    needsDistilledLora: false,
  },
  {
    id: "distilled",
    label: "Distilled",
    shortLabel: "Distilled",
    description: "Feste schnelle Sigma-Schedules für hohe Durchsatzleistung.",
    family: "generate",
    quality: "8 + 3 Schritte",
    defaultHeight: 1024,
    defaultWidth: 1536,
    defaultSteps: 8,
    needsNegativePrompt: false,
    needsSpatialUpscaler: true,
    needsDistilledLora: false,
  },
  {
    id: "text-to-audio",
    label: "Offiziell Text zu Audio",
    shortLabel: "T2A",
    description: "Offizieller LTX-2.3-Audio-Only-Ablauf mit 8-Sigma-Schedule und Euler-Ancestral-CFG++.",
    family: "generate",
    quality: "Offiziell · Audio",
    defaultHeight: 512,
    defaultWidth: 512,
    defaultSteps: 8,
    needsNegativePrompt: true,
    needsSpatialUpscaler: false,
    needsDistilledLora: true,
  },
  {
    id: "ic-lora",
    label: "Offiziell IC-LoRA Kontrolle",
    shortLabel: "IC-LoRA",
    description: "Dokumentierte LTX-2.3-Abläufe für Union Control, Referenzkontrolle und Video-Edits.",
    family: "condition",
    quality: "Offiziell · 8 Schritte",
    defaultHeight: 704,
    defaultWidth: 1280,
    defaultSteps: 8,
    needsNegativePrompt: true,
    needsSpatialUpscaler: false,
    needsDistilledLora: true,
  },
  {
    id: "id-lora",
    label: "ID-LoRA Person + Stimme",
    shortLabel: "ID-LoRA",
    description: "Offizieller LTX-2.3-Pfad für Personen- und Stimmidentität aus Bild und Referenzton.",
    family: "condition",
    quality: "Identität + Sprache",
    defaultHeight: 704,
    defaultWidth: 1280,
    defaultSteps: 8,
    needsNegativePrompt: false,
    needsSpatialUpscaler: true,
    needsDistilledLora: true,
  },
  {
    id: "keyframes",
    label: "Erstes + letztes Bild",
    shortLabel: "FLF2V",
    description: "Offizieller LTX-2.3-FLF2V-Pfad mit einem Start- und einem Endbild.",
    family: "condition",
    quality: "Distilled · 8 Schritte",
    // The Comfy template exposes a 1280x720 guide crop, but the native
    // one-stage model requires dimensions divisible by 32.
    defaultHeight: 704,
    defaultWidth: 1280,
    defaultSteps: 8,
    needsNegativePrompt: false,
    needsSpatialUpscaler: false,
    needsDistilledLora: false,
  },
  {
    id: "image-audio-to-video",
    label: "Bild + Audio zu Video",
    shortLabel: "IA2V",
    description: "Offizieller LTX-2.3-IA2V-Pfad mit Referenzbild und fester Audiospur.",
    family: "condition",
    quality: "LipSync",
    defaultHeight: 704,
    defaultWidth: 1280,
    defaultSteps: 30,
    needsNegativePrompt: false,
    needsSpatialUpscaler: true,
    needsDistilledLora: true,
  },
  {
    id: "audio-to-video",
    label: "Audio zu Video",
    shortLabel: "Audio",
    description: "Lokaler externer Audio-Pfad mit derzeit begrenzter Lippenpräzision.",
    family: "condition",
    quality: "Experimentell",
    defaultHeight: 1024,
    defaultWidth: 1536,
    defaultSteps: 30,
    needsNegativePrompt: true,
    needsSpatialUpscaler: true,
    needsDistilledLora: true,
  },
  {
    id: "lipdub",
    label: "LipDub / Text-Redubbing",
    shortLabel: "LipDub",
    description: "Offizieller Comfy-HQ-Ablauf für Redubbing mit Referenzvideo, Sprache und neuem Zieltext.",
    family: "condition",
    quality: "Offiziell · HQ",
    defaultHeight: 1920,
    defaultWidth: 1088,
    defaultSteps: 8,
    needsNegativePrompt: false,
    needsSpatialUpscaler: true,
    needsDistilledLora: false,
  },
  {
    id: "retake",
    label: "Retake / Bereich ersetzen",
    shortLabel: "Retake",
    description: "Regeneriert einen Zeitbereich in einem bestehenden Video.",
    family: "edit",
    quality: "Nicht-destruktiv",
    defaultHeight: 1024,
    defaultWidth: 1536,
    defaultSteps: 40,
    needsNegativePrompt: true,
    needsSpatialUpscaler: false,
    needsDistilledLora: false,
  },
] as const;

const withoutNul = <T extends z.ZodType<string>>(schema: T) => schema.refine(
  (value) => !value.includes("\0"),
  { message: "NUL-Zeichen sind nicht erlaubt." },
);
const pathValue = withoutNul(z.string().trim().max(4096));

export const loraSchema = z.object({
  path: pathValue,
  strength: z.number().finite().min(-4).max(4),
});

export const imageInputSchema = z.object({
  path: pathValue,
  name: z.string().trim().max(255),
  frameIndex: z.number().int().min(0),
  strength: z.number().finite().min(0).max(1),
  crf: z.number().int().min(0).max(51),
});

export const videoConditioningSchema = z.object({
  path: pathValue,
  name: z.string().trim().max(255),
  strength: z.number().finite().min(0).max(2),
});

export const outputNameSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:mp4|wav)$/,
    "Ausgabedatei muss mit einer Zahl oder einem Buchstaben beginnen, darf nur A-Z, 0-9, Punkt, "
      + "Bindestrich und Unterstrich enthalten und muss auf .mp4 oder .wav enden.",
  );

export const guidanceSchema = z.object({
  cfgScale: z.number().finite().min(0).max(30),
  stgScale: z.number().finite().min(0).max(10),
  rescaleScale: z.number().finite().min(0).max(2),
  modalityScale: z.number().finite().min(0).max(20),
  skipStep: z.number().int().min(0).max(20),
  stgBlocks: z.array(z.number().int().min(0).max(255)).max(64),
});

export const generationRequestSchema = z
  .object({
    mode: z.enum(pipelineModes),
    sourceMode: z.enum(sourceModes),
    prompt: withoutNul(z.string().trim().min(1).max(16_000)),
    promptParts: promptPartsSchema,
    negativePrompt: withoutNul(z.string().max(16_000)),
    enhancePrompt: z.boolean(),
    seed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    height: z.number().int().min(64).max(4096),
    width: z.number().int().min(64).max(4096),
    numFrames: z.number().int().min(1).max(2049),
    frameRate: z.number().finite().min(1).max(120),
    numInferenceSteps: z.number().int().min(1).max(200),
    outputName: outputNameSchema,
    tiling: z.boolean(),
    longClipAcknowledged: z.boolean(),
    continuity: z.object({
      project: withoutNul(z.string().trim().max(120)),
      notes: withoutNul(z.string().max(2_000)),
    }),
    models: z.object({
      layout: z.enum(modelLayouts),
      generation: z.enum(modelGenerations),
      checkpointPath: pathValue,
      distilledCheckpointPath: pathValue,
      gemmaRoot: pathValue,
      transformerPath: pathValue,
      textEncoderPath: pathValue,
      videoVaePath: pathValue,
      audioVaePath: pathValue,
      durationHeadPath: pathValue,
      promptEnhancerGemmaRoot: pathValue,
      gemmaLora: loraSchema.extend({ enabled: z.boolean() }),
      spatialUpscalerPath: pathValue,
      distilledLora: loraSchema,
      loras: z.array(loraSchema).max(16),
    }),
    images: z.array(imageInputSchema).max(32),
    quantization: z.object({
      mode: z.enum(["none", "fp8-cast", "fp8-scaled-mm"]),
      amaxPath: pathValue,
    }),
    videoGuidance: guidanceSchema,
    audioGuidance: guidanceSchema,
    hq: z.object({
      distilledLoraStrengthStage1: z.number().finite().min(0).max(2),
      distilledLoraStrengthStage2: z.number().finite().min(0).max(2),
    }),
    distilled: z.object({
      singleStage: z.boolean(),
    }),
    icLora: z.object({
      profile: z.enum(icLoraProfiles).default("union-control"),
      controlType: z.enum(["prepared", "depth", "canny", "pose"]),
      lora: loraSchema,
      mogeModelPath: pathValue,
      videoConditioning: z.array(videoConditioningSchema).max(16),
      attentionMaskPath: pathValue,
      attentionStrength: z.number().finite().min(0).max(1),
      skipStage2: z.boolean(),
      hdrTextEmbeddingsPath: pathValue,
      hdrHighQuality: z.boolean(),
    }),
    idLora: z.object({
      referenceAudio: z.object({
        path: pathValue,
        name: z.string().trim().max(255),
      }),
      lora: loraSchema,
      distilledLoraStrength: z.number().finite().min(0).max(2),
      identityGuidanceScale: z.number().finite().min(0).max(20),
      identityGuidanceStart: z.number().finite().min(0).max(1),
      identityGuidanceEnd: z.number().finite().min(0).max(1),
      stage1ImageStrength: z.number().finite().min(0).max(1),
    }),
    audio: z.object({
      path: pathValue,
      name: z.string().trim().max(255),
      startTime: z.number().finite().min(0).max(86_400),
      maxDuration: z.number().finite().positive().max(86_400).nullable(),
      finalMix: z.object({
        path: pathValue,
        name: z.string().trim().max(255),
      }),
    }),
    lipDub: z.object({
      pipelineProfile: z.enum(lipDubPipelineProfiles),
      referenceVideo: videoConditioningSchema,
      lora: loraSchema,
      targetLanguage: withoutNul(z.string().trim().max(80)),
      singleSpeakerAcknowledged: z.boolean(),
    }),
    postprocess: z.object({
      longcatLipsync: z.object({
        enabled: z.boolean(),
        resolution: z.enum(["480p", "720p"]),
        blend: z.number().finite().min(0).max(1),
      }),
      latentSync: z.object({
        enabled: z.boolean(),
        steps: z.number().int().min(20).max(50),
        guidance: z.number().finite().min(1).max(3),
      }),
      museTalk: z.object({
        enabled: z.boolean(),
        extraMargin: z.number().int().min(0).max(80),
        cheekWidth: z.number().int().min(20).max(200),
        audioPaddingLeft: z.number().int().min(0).max(12),
        audioPaddingRight: z.number().int().min(0).max(12),
      }),
      lipForcing: z.object({
        enabled: z.boolean(),
        decoder: z.enum(["wan-vae", "streaming-taehv"]),
      }),
    }),
    retake: z.object({
      videoPath: pathValue,
      videoName: z.string().trim().max(255),
      startTime: z.number().finite().min(0).max(86_400),
      endTime: z.number().finite().positive().max(86_400),
      regenerateVideo: z.boolean(),
      regenerateAudio: z.boolean(),
      distilled: z.boolean(),
    }),
  })
  .strict()
  .superRefine((value, context) => {
    const definition = PIPELINES.find((pipeline) => pipeline.id === value.mode);
    if (!definition) return;

    const requirePath = (path: string, field: (string | number)[], label: string) => {
      if (!path) context.addIssue({ code: "custom", path: field, message: `${label} fehlt.` });
    };
    const requireFilename = (
      path: string,
      field: (string | number)[],
      label: string,
      allowed: readonly string[],
    ) => {
      if (!path) return;
      const filename = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
      if (!allowed.includes(filename)) {
        context.addIssue({
          code: "custom",
          path: field,
          message: `${label} ist für den nativen LTX-2.5-Vertrag nicht freigegeben: ${filename}`,
        });
      }
    };

    value.images.forEach((image, index) => requirePath(image.path, ["images", index, "path"], `Bild ${index + 1}`));
    value.models.loras.forEach((lora, index) => requirePath(lora.path, ["models", "loras", index, "path"], `LoRA ${index + 1}`));
    value.icLora.videoConditioning.forEach((video, index) =>
      requirePath(video.path, ["icLora", "videoConditioning", index, "path"], `Kontrollvideo ${index + 1}`),
    );

    if (value.models.layout === "split") {
      if (value.models.generation !== "2.5") {
        context.addIssue({
          code: "custom",
          path: ["models", "generation"],
          message: "Der Split-Pack-Vertrag ist derzeit ausschließlich für LTX-2.5 freigegeben.",
        });
      }
      requirePath(value.models.transformerPath, ["models", "transformerPath"], "Transformer");
      requirePath(value.models.textEncoderPath, ["models", "textEncoderPath"], "Textencoder");
      if (value.mode !== "text-to-audio") {
        requirePath(value.models.videoVaePath, ["models", "videoVaePath"], "Video-VAE");
      }
      requirePath(value.models.audioVaePath, ["models", "audioVaePath"], "Audio-VAE");
      requireFilename(
        value.models.transformerPath,
        ["models", "transformerPath"],
        "Transformer",
        [LTX25_MODEL_COMPONENTS.transformer.path.split("/").at(-1)!],
      );
      requireFilename(
        value.models.textEncoderPath,
        ["models", "textEncoderPath"],
        "Textencoder",
        [LTX25_MODEL_COMPONENTS.textEncoder.path.split("/").at(-1)!],
      );
      requireFilename(
        value.models.videoVaePath,
        ["models", "videoVaePath"],
        "Video-VAE",
        [
          LTX25_MODEL_COMPONENTS.videoVaeDiffusion.path.split("/").at(-1)!,
          LTX25_MODEL_COMPONENTS.videoVaeConv.path.split("/").at(-1)!,
        ],
      );
      requireFilename(
        value.models.audioVaePath,
        ["models", "audioVaePath"],
        "Audio-VAE",
        [LTX25_MODEL_COMPONENTS.audioVae.path.split("/").at(-1)!],
      );
      requireFilename(
        value.models.durationHeadPath,
        ["models", "durationHeadPath"],
        "Duration-Head",
        [LTX25_MODEL_COMPONENTS.durationHead.path.split("/").at(-1)!],
      );
      if (value.quantization.mode !== "none") {
        context.addIssue({
          code: "custom",
          path: ["quantization", "mode"],
          message: "Der freigegebene native LTX-2.5-BF16-Vertrag verwendet keine zusätzliche Quantisierung.",
        });
      }
      if (value.models.gemmaLora.enabled) {
        context.addIssue({
          code: "custom",
          path: ["models", "gemmaLora", "enabled"],
          message: "Der offizielle LTX-2.5-Split-Pack-Vertrag verwendet keine Gemma Abliterated LoRA.",
        });
      }
      if (value.enhancePrompt) {
        requirePath(
          value.models.promptEnhancerGemmaRoot,
          ["models", "promptEnhancerGemmaRoot"],
          "Prompt-Enhancer Gemma Root",
        );
      }
      if (definition.needsSpatialUpscaler && !(value.mode === "distilled" && value.distilled.singleStage)) {
        requireFilename(
          value.models.spatialUpscalerPath,
          ["models", "spatialUpscalerPath"],
          "Spatial Upscaler",
          [LTX25_MODEL_COMPONENTS.spatialUpscaler.path.split("/").at(-1)!],
        );
      }
      const supportedOfficialProfile = value.mode === "ic-lora"
        && ["union-control", "ingredients", "motion-track", "v2v-instant-shave"].includes(
          value.icLora.profile,
        );
      if (!["distilled", "text-to-audio"].includes(value.mode) && !supportedOfficialProfile) {
        context.addIssue({
          code: "custom",
          path: ["models", "layout"],
          message: "Dieser Modus besitzt noch keinen verifizierten nativen LTX-2.5-Split-Pack-Vertrag.",
        });
      }
    } else {
      if (value.models.generation !== "2.3") {
        context.addIssue({
          code: "custom",
          path: ["models", "generation"],
          message: "LTX-2.5 muss als explizites Split-Pack geladen werden.",
        });
      }
      if (["distilled", "keyframes"].includes(value.mode)
        || (value.mode === "ic-lora" && value.icLora.profile === "hdr")
        || (value.mode === "lipdub" && value.lipDub.pipelineProfile === "native-distilled")
        || (value.mode === "retake" && value.retake.distilled)) {
        requirePath(
          value.models.distilledCheckpointPath,
          ["models", "distilledCheckpointPath"],
          "Distilled Checkpoint",
        );
      } else {
        requirePath(value.models.checkpointPath, ["models", "checkpointPath"], "Checkpoint");
      }
    }
    if (["two-stage", "two-stage-hq", "one-stage", "distilled"].includes(value.mode)) {
      if (value.sourceMode === "image" && value.images.length === 0) {
        context.addIssue({ code: "custom", path: ["images"], message: "Für Bild-zu-Video ist ein Referenzbild erforderlich." });
      }
      if (value.sourceMode === "text" && value.images.length > 0) {
        context.addIssue({ code: "custom", path: ["images"], message: "Im Text-zu-Video-Modus dürfen keine Referenzbilder aktiv sein." });
      }
    }
    if (value.mode === "text-to-audio") {
      if (!value.outputName.toLowerCase().endsWith(".wav")) {
        context.addIssue({
          code: "custom",
          path: ["outputName"],
          message: "Text zu Audio benötigt eine WAV-Ausgabedatei.",
        });
      }
      if (value.images.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: "Text zu Audio verwendet keine Bildkonditionierung.",
        });
      }
      if (
        value.postprocess.longcatLipsync.enabled
        || value.postprocess.latentSync.enabled
        || value.postprocess.museTalk.enabled
        || value.postprocess.lipForcing.enabled
      ) {
        context.addIssue({
          code: "custom",
          path: ["postprocess"],
          message: "Lippen-Nachbearbeitung ist nur für Videoausgaben verfügbar.",
        });
      }
    } else if (!value.outputName.toLowerCase().endsWith(".mp4")) {
      context.addIssue({
        code: "custom",
        path: ["outputName"],
        message: "Videopipelines benötigen eine MP4-Ausgabedatei.",
      });
    }
    if (value.models.layout === "monolith" && !(value.mode === "ic-lora" && value.icLora.profile === "hdr")) {
      requirePath(value.models.gemmaRoot, ["models", "gemmaRoot"], "Gemma Root");
    }
    if (needsGemmaAbliteratedLoraForRequest(value)) {
      requirePath(value.models.gemmaLora.path, ["models", "gemmaLora", "path"], "Gemma Abliterated LoRA");
    }
    if (definition.needsSpatialUpscaler && !(value.mode === "distilled" && value.distilled.singleStage)) {
      requirePath(value.models.spatialUpscalerPath, ["models", "spatialUpscalerPath"], "Spatial Upscaler");
    }
    if (
      definition.needsDistilledLora
      && value.models.layout === "monolith"
      && !(value.mode === "ic-lora" && ["hdr", "union-control"].includes(value.icLora.profile))
    ) {
      requirePath(value.models.distilledLora.path, ["models", "distilledLora", "path"], "Distilled LoRA");
    }
    if (value.mode === "keyframes" && value.images.length !== 2) {
      context.addIssue({ code: "custom", path: ["images"], message: "FLF2V benötigt genau ein Start- und ein Endbild." });
    }
    if (value.mode !== "retake") {
      value.images.forEach((image, index) => {
        if (image.frameIndex >= value.numFrames) {
          context.addIssue({
            code: "custom",
            path: ["images", index, "frameIndex"],
            message: `Der Frame-Index muss kleiner als ${value.numFrames} sein.`,
          });
        }
      });
    }
    if (value.mode === "keyframes") {
      if (value.images[0]?.frameIndex !== 0) {
        context.addIssue({
          code: "custom",
          path: ["images", 0, "frameIndex"],
          message: "Das Startbild muss auf Frame 0 liegen.",
        });
      }
      if (value.images[1]?.frameIndex !== value.numFrames - 1) {
        context.addIssue({
          code: "custom",
          path: ["images", 1, "frameIndex"],
          message: `Das Endbild muss auf dem letzten Frame ${value.numFrames - 1} liegen.`,
        });
      }
      for (let index = 1; index < value.images.length; index += 1) {
        if (value.images[index].frameIndex <= value.images[index - 1].frameIndex) {
          context.addIssue({
            code: "custom",
            path: ["images", index, "frameIndex"],
            message: "Keyframe-Indizes müssen in der eingegebenen Reihenfolge strikt ansteigen.",
          });
        }
      }
    }
    if (value.mode === "ic-lora") {
      const requiresReferenceImage = [
        "union-control",
        "ingredients",
        "motion-track",
      ].includes(value.icLora.profile);
      if (requiresReferenceImage && value.images.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: value.icLora.profile === "ingredients"
            ? "Der offizielle Ingredients-Modus benötigt genau ein Referenzbild."
            : "Der offizielle Union-Control-Modus benötigt ein Referenzbild.",
        });
      }
      if (value.icLora.profile === "ingredients" && value.images.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: "Ingredients benötigt genau ein Referenzbild.",
        });
      }
      if (value.icLora.profile === "motion-track" && value.images.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: "Motion Track benötigt genau ein Referenzbild.",
        });
      }
      if (
        ["pixel-upscaler", "v2v-instant-shave", "inpainting", "outpainting", "hdr"].includes(value.icLora.profile)
        && value.images.length > 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: "Dieser Video-zu-Video-Ablauf verwendet kein separates Referenzbild.",
        });
      }
      if (value.icLora.profile !== "ingredients" && value.icLora.videoConditioning.length === 0) {
        context.addIssue({ code: "custom", path: ["icLora", "videoConditioning"], message: "Ein Kontrollvideo fehlt." });
      }
      if (
        ["pixel-upscaler", "v2v-instant-shave", "inpainting", "outpainting", "hdr"].includes(value.icLora.profile)
        && value.icLora.videoConditioning.length !== 1
      ) {
        context.addIssue({
          code: "custom",
          path: ["icLora", "videoConditioning"],
          message: "Dieser offizielle Ablauf benötigt genau ein Quellvideo.",
        });
      }
      requirePath(
        value.icLora.lora.path,
        ["icLora", "lora", "path"],
        value.icLora.profile === "ingredients" ? "Ingredients IC-LoRA" : "Union-Control IC-LoRA",
      );
      if (value.icLora.profile === "union-control" && value.icLora.controlType === "depth") {
        requirePath(value.icLora.mogeModelPath, ["icLora", "mogeModelPath"], "MoGe-Geometriemodell");
      }
      if (value.icLora.profile === "inpainting") {
        requirePath(
          value.icLora.attentionMaskPath,
          ["icLora", "attentionMaskPath"],
          "Inpainting-Maskenvideo",
        );
      }
      if (value.icLora.profile === "hdr") {
        if (value.icLora.lora.strength !== 1) {
          context.addIssue({
            code: "custom",
            path: ["icLora", "lora", "strength"],
            message: "Der offizielle native HDR-Pfad verwendet die IC-LoRA mit Stärke 1,0.",
          });
        }
        requirePath(
          value.icLora.hdrTextEmbeddingsPath,
          ["icLora", "hdrTextEmbeddingsPath"],
          "HDR-Szenen-Embeddings",
        );
      }
    }
    if (isAudioConditionedMode(value.mode)) {
      requirePath(value.audio.path, ["audio", "path"], "Audiodatei");
    }
    if (value.mode === "image-audio-to-video" && value.images.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["images"],
        message: "Der offizielle IA2V-Modus benötigt ein Referenzbild.",
      });
    }
    if (value.mode === "id-lora") {
      if (value.images.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: "Der offizielle ID-LoRA-Modus benötigt ein Referenzbild.",
        });
      }
      requirePath(value.idLora.referenceAudio.path, ["idLora", "referenceAudio", "path"], "ID-LoRA-Referenzton");
      requirePath(value.idLora.lora.path, ["idLora", "lora", "path"], "ID-LoRA TalkVid");
      if (!value.promptParts.dialogue.trim()) {
        context.addIssue({
          code: "custom",
          path: ["promptParts", "dialogue"],
          message: "ID-LoRA benötigt den exakt zu sprechenden Text.",
        });
      }
      if (value.idLora.identityGuidanceStart > value.idLora.identityGuidanceEnd) {
        context.addIssue({
          code: "custom",
          path: ["idLora", "identityGuidanceEnd"],
          message: "Das Ende der Identitätsführung muss nach ihrem Start liegen.",
        });
      }
      if (value.enhancePrompt) {
        context.addIssue({
          code: "custom",
          path: ["enhancePrompt"],
          message: "ID-LoRA verwendet den exakten Dialog; Promptverbesserung muss ausgeschaltet sein.",
        });
      }
    }
    if (value.mode === "lipdub") {
      if (value.lipDub.pipelineProfile === "official-comfy-hq") {
        requirePath(value.models.distilledLora.path, ["models", "distilledLora", "path"], "Distilled LoRA");
      }
      requirePath(value.lipDub.referenceVideo.path, ["lipDub", "referenceVideo", "path"], "LipDub-Referenzvideo");
      requirePath(value.lipDub.lora.path, ["lipDub", "lora", "path"], "LipDub IC-LoRA");
      const hasDialogue = value.promptParts.dialogue.trim().length > 0
        || /(?:["“][^"”]{2,}["”]|speaks|says|spricht|sagt|saying exactly)/i.test(value.prompt);
      if (!hasDialogue) {
        context.addIssue({
          code: "custom",
          path: ["promptParts", "dialogue"],
          message: "LipDub braucht einen exakten gesprochenen Text im Dialogfeld oder im Prompt.",
        });
      }
      if (value.images.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: "LipDub verwendet das Referenzvideo; zusätzliche Bildkonditionierung wird nicht an die CLI übergeben.",
        });
      }
      if (value.models.loras.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["models", "loras"],
          message: "LipDub erlaubt genau das eigene LipDub IC-LoRA-Feld, keine weiteren LoRAs.",
        });
      }
    }
    if (value.postprocess.longcatLipsync.enabled) {
      if (!isAudioConditionedMode(value.mode)) {
        context.addIssue({
          code: "custom",
          path: ["postprocess", "longcatLipsync", "enabled"],
          message: "Der LongCat-Lippenpass ist nur bei Audio zu Video verfügbar.",
        });
      }
      if (value.images.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["images"],
          message: "Für den LongCat-Lippenpass ist ein Referenzbild erforderlich.",
        });
      }
      requirePath(value.audio.path, ["audio", "path"], "Audiodatei für LongCat");
    }
    if (value.postprocess.latentSync.enabled) {
      if (!hasDialogueIntent(value) && !isAudioConditionedMode(value.mode)) {
        context.addIssue({
          code: "custom",
          path: ["postprocess", "latentSync", "enabled"],
          message: "LatentSync benötigt einen Lauf mit gesprochener Sprache oder eine Audio-zu-Video-Pipeline.",
        });
      }
      if (
        value.postprocess.longcatLipsync.enabled
        || value.postprocess.museTalk.enabled
        || value.postprocess.lipForcing.enabled
      ) {
        context.addIssue({
          code: "custom",
          path: ["postprocess", "latentSync", "enabled"],
          message: "Es darf immer nur eine Lippen-Nachbearbeitung aktiv sein.",
        });
      }
    }
    if (value.postprocess.museTalk.enabled) {
      if (!hasDialogueIntent(value) && !isAudioConditionedMode(value.mode)) {
        context.addIssue({
          code: "custom",
          path: ["postprocess", "museTalk", "enabled"],
          message: "MuseTalk benötigt einen Lauf mit gesprochener Sprache oder eine Audio-zu-Video-Pipeline.",
        });
      }
      if (
        value.postprocess.longcatLipsync.enabled
        || value.postprocess.latentSync.enabled
        || value.postprocess.lipForcing.enabled
      ) {
        context.addIssue({
          code: "custom",
          path: ["postprocess", "museTalk", "enabled"],
          message: "Es darf immer nur eine Lippen-Nachbearbeitung aktiv sein.",
        });
      }
    }
    if (value.postprocess.lipForcing.enabled) {
      if (!hasDialogueIntent(value) && !isAudioConditionedMode(value.mode)) {
        context.addIssue({
          code: "custom",
          path: ["postprocess", "lipForcing", "enabled"],
          message: "LipForcing benötigt einen Lauf mit gesprochener Sprache oder eine Audio-zu-Video-Pipeline.",
        });
      }
      if (
        value.postprocess.longcatLipsync.enabled
        || value.postprocess.latentSync.enabled
        || value.postprocess.museTalk.enabled
      ) {
        context.addIssue({
          code: "custom",
          path: ["postprocess", "lipForcing", "enabled"],
          message: "Es darf immer nur eine Lippen-Nachbearbeitung aktiv sein.",
        });
      }
    }
    if (value.mode === "retake") {
      requirePath(value.retake.videoPath, ["retake", "videoPath"], "Quellvideo");
      if (!value.retake.regenerateVideo && !value.retake.regenerateAudio) {
        context.addIssue({
          code: "custom",
          path: ["retake", "regenerateVideo"],
          message: "Mindestens Video oder Audio muss regeneriert werden.",
        });
      }
      if (value.retake.startTime >= value.retake.endTime) {
        context.addIssue({ code: "custom", path: ["retake", "endTime"], message: "Ende muss nach dem Start liegen." });
      }
    } else {
      // The in/outpaint IC profiles run the two-stage InOutpaintPipeline, which
      // asserts the 64er grid; the remaining official IC profiles are single-stage.
      const inOutpaintICLora = value.mode === "ic-lora"
        && ["inpainting", "outpainting"].includes(value.icLora.profile);
      const divisor = ["one-stage", "ic-lora"].includes(value.mode) && !inOutpaintICLora ? 32 : 64;
      if (value.height % divisor !== 0 || value.width % divisor !== 0) {
        context.addIssue({
          code: "custom",
          path: ["width"],
          message: `Breite und Höhe müssen durch ${divisor} teilbar sein.`,
        });
      }
      if (value.mode !== "lipdub") {
        if ((value.numFrames - 1) % 8 !== 0) {
          context.addIssue({ code: "custom", path: ["numFrames"], message: "Frames müssen dem Muster 8k+1 folgen." });
        }
        if (videoDurationSeconds(value.numFrames, value.frameRate) > 10 && !value.longClipAcknowledged) {
          context.addIssue({
            code: "custom",
            path: ["longClipAcknowledged"],
            message: "Clips über 10 Sekunden müssen als Langclip bestätigt werden.",
          });
        }
      }
    }
  });

export type GenerationRequest = z.infer<typeof generationRequestSchema>;

const defaultGuidance = {
  cfgScale: 3,
  stgScale: 1,
  rescaleScale: 0.7,
  modalityScale: 3,
  skipStep: 0,
  stgBlocks: [28],
};

const defaultPromptParts: PromptParts = {
  subject: "",
  action: "",
  environment: "",
  camera: "",
  lighting: "",
  dialogue: "",
  ambience: "",
  music: "",
};

export function createDefaultRequest(mode: PipelineMode = "two-stage"): GenerationRequest {
  const definition = PIPELINES.find((pipeline) => pipeline.id === mode) ?? PIPELINES[0];
  const frameRate = ["two-stage", "keyframes", "ic-lora", "id-lora"].includes(mode) ? 25 : 24;
  const durationSeconds = mode === "image-audio-to-video" ? 9 : mode === "id-lora" ? 10 : 5;
  return {
    mode,
    sourceMode: ["keyframes", "ic-lora", "id-lora", "image-audio-to-video"].includes(mode) ? "image" : "text",
    prompt: "",
    promptParts: { ...defaultPromptParts },
    negativePrompt: "",
    enhancePrompt: ["lipdub", "id-lora", "keyframes", "ic-lora", "text-to-audio"].includes(mode) ? false : true,
    seed: 10,
    height: definition.defaultHeight,
    width: definition.defaultWidth,
    numFrames: framesForDuration(durationSeconds, frameRate),
    frameRate,
    numInferenceSteps: definition.defaultSteps,
    outputName: `ltx-${mode}.${mode === "text-to-audio" ? "wav" : "mp4"}`,
    tiling: true,
    longClipAcknowledged: false,
    continuity: { project: "", notes: "" },
    models: {
      layout: "monolith",
      generation: "2.3",
      checkpointPath: "",
      distilledCheckpointPath: "",
      gemmaRoot: "",
      transformerPath: "",
      textEncoderPath: "",
      videoVaePath: "",
      audioVaePath: "",
      durationHeadPath: "",
      promptEnhancerGemmaRoot: "",
      gemmaLora: { enabled: false, path: "", strength: 1 },
      spatialUpscalerPath: "",
      distilledLora: { path: "", strength: mode === "lipdub" ? 0.5 : 1 },
      loras: [],
    },
    images: [],
    quantization: { mode: "none", amaxPath: "" },
    videoGuidance: { ...defaultGuidance },
    audioGuidance: mode === "text-to-audio"
      ? { cfgScale: 1, stgScale: 0, rescaleScale: 0, modalityScale: 1, skipStep: 0, stgBlocks: [] }
      : { ...defaultGuidance, cfgScale: 7 },
    hq: { distilledLoraStrengthStage1: 0.25, distilledLoraStrengthStage2: 0.5 },
    distilled: { singleStage: false },
    icLora: {
      profile: "union-control",
      controlType: "depth",
      lora: { path: "", strength: 1 },
      mogeModelPath: "",
      videoConditioning: [],
      attentionMaskPath: "",
      attentionStrength: 1,
      skipStage2: false,
      hdrTextEmbeddingsPath: "",
      hdrHighQuality: false,
    },
    idLora: {
      referenceAudio: { path: "", name: "" },
      lora: { path: "", strength: 1 },
      distilledLoraStrength: 0.5,
      identityGuidanceScale: 3,
      identityGuidanceStart: 0,
      identityGuidanceEnd: 1,
      stage1ImageStrength: 0.7,
    },
    audio: {
      path: "",
      name: "",
      startTime: 0,
      maxDuration: null,
      finalMix: { path: "", name: "" },
    },
    lipDub: {
      pipelineProfile: "official-comfy-hq",
      referenceVideo: { path: "", name: "", strength: 1 },
      lora: { path: "", strength: 1 },
      targetLanguage: "",
      singleSpeakerAcknowledged: false,
    },
    postprocess: {
      longcatLipsync: { enabled: false, resolution: "480p", blend: 0.9 },
      latentSync: { enabled: false, steps: 30, guidance: 2 },
      museTalk: {
        enabled: false,
        extraMargin: 10,
        cheekWidth: 90,
        audioPaddingLeft: 2,
        audioPaddingRight: 2,
      },
      lipForcing: { enabled: false, decoder: "wan-vae" },
    },
    retake: {
      videoPath: "",
      videoName: "",
      startTime: 0,
      endTime: 2,
      regenerateVideo: true,
      regenerateAudio: true,
      distilled: false,
    },
  };
}

export function mergeGenerationRequest(value: unknown, fallbackMode: PipelineMode = "two-stage"): GenerationRequest {
  const storedRecord = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const storedMode = storedRecord.mode;
  const requestedMode = typeof storedMode === "string" && pipelineModes.includes(storedMode as PipelineMode)
    ? storedMode as PipelineMode
    : fallbackMode;
  const defaults = createDefaultRequest(requestedMode);
  const stored = Object.fromEntries(
    Object.keys(defaults)
      .filter((key) => Object.hasOwn(storedRecord, key))
      .map((key) => [key, storedRecord[key]]),
  ) as Partial<GenerationRequest>;
  const mode = stored.mode && pipelineModes.includes(stored.mode) ? stored.mode : fallbackMode;
  const images = Array.isArray(stored.images) ? stored.images : defaults.images;
  const inferredSourceMode = ["two-stage", "two-stage-hq", "one-stage", "distilled"].includes(mode) && images.length > 0
    ? "image"
    : defaults.sourceMode;
  const frameRate = typeof stored.frameRate === "number" ? stored.frameRate : defaults.frameRate;
  const numFrames = typeof stored.numFrames === "number" ? stored.numFrames : defaults.numFrames;
  const storedLipDub = storedRecord.lipDub && typeof storedRecord.lipDub === "object"
    ? storedRecord.lipDub as Record<string, unknown>
    : null;
  const storedModelsRecord = storedRecord.models && typeof storedRecord.models === "object"
    && !Array.isArray(storedRecord.models)
    ? storedRecord.models as Record<string, unknown>
    : {};
  const storedGemmaLoraRecord = storedModelsRecord.gemmaLora
    && typeof storedModelsRecord.gemmaLora === "object"
    && !Array.isArray(storedModelsRecord.gemmaLora)
    ? storedModelsRecord.gemmaLora as Record<string, unknown>
    : {};
  const storedGemmaLoraEnabled = typeof storedGemmaLoraRecord.enabled === "boolean"
    ? storedGemmaLoraRecord.enabled
    : typeof storedGemmaLoraRecord.path === "string" && storedGemmaLoraRecord.path.trim().length > 0;
  const storedIdLoraRecord = storedRecord.idLora && typeof storedRecord.idLora === "object"
    ? storedRecord.idLora as Partial<GenerationRequest["idLora"]> & { stage2ImageStrength?: unknown }
    : {};
  const {
    stage2ImageStrength: legacyStage2ImageStrength,
    ...storedIdLora
  } = storedIdLoraRecord;
  const stage1ImageStrength = typeof storedIdLora.stage1ImageStrength === "number"
    ? storedIdLora.stage1ImageStrength
    : typeof legacyStage2ImageStrength === "number"
      ? legacyStage2ImageStrength
      : defaults.idLora.stage1ImageStrength;
  const lipDubPipelineProfile = mode === "lipdub"
    && storedLipDub
    && !Object.hasOwn(storedLipDub, "pipelineProfile")
    ? "native-distilled" as const
    : stored.lipDub?.pipelineProfile ?? defaults.lipDub.pipelineProfile;
  return {
    ...defaults,
    ...stored,
    seed: typeof stored.seed === "number" && Number.isInteger(stored.seed) && stored.seed >= 0
      ? stored.seed
      : defaults.seed,
    sourceMode: stored.sourceMode ?? inferredSourceMode,
    promptParts: { ...defaults.promptParts, ...stored.promptParts },
    models: {
      ...defaults.models,
      ...stored.models,
      gemmaLora: {
        ...defaults.models.gemmaLora,
        ...stored.models?.gemmaLora,
        enabled: storedGemmaLoraEnabled,
      },
      distilledLora: { ...defaults.models.distilledLora, ...stored.models?.distilledLora },
      loras: stored.models?.loras ?? defaults.models.loras,
    },
    images,
    quantization: { ...defaults.quantization, ...stored.quantization },
    videoGuidance: { ...defaults.videoGuidance, ...stored.videoGuidance },
    audioGuidance: { ...defaults.audioGuidance, ...stored.audioGuidance },
    hq: { ...defaults.hq, ...stored.hq },
    distilled: { ...defaults.distilled, ...stored.distilled },
    icLora: {
      ...defaults.icLora,
      ...stored.icLora,
      lora: {
        ...defaults.icLora.lora,
        ...(mode === "ic-lora" ? stored.models?.loras?.[0] : undefined),
        ...stored.icLora?.lora,
      },
    },
    idLora: {
      ...defaults.idLora,
      ...storedIdLora,
      stage1ImageStrength,
      referenceAudio: { ...defaults.idLora.referenceAudio, ...storedIdLora.referenceAudio },
      lora: { ...defaults.idLora.lora, ...storedIdLora.lora },
    },
    audio: {
      ...defaults.audio,
      ...stored.audio,
      finalMix: { ...defaults.audio.finalMix, ...stored.audio?.finalMix },
    },
    lipDub: {
      ...defaults.lipDub,
      ...stored.lipDub,
      pipelineProfile: lipDubPipelineProfile,
      referenceVideo: { ...defaults.lipDub.referenceVideo, ...stored.lipDub?.referenceVideo },
      lora: { ...defaults.lipDub.lora, ...stored.lipDub?.lora },
    },
    postprocess: {
      ...defaults.postprocess,
      ...stored.postprocess,
      longcatLipsync: {
        ...defaults.postprocess.longcatLipsync,
        ...stored.postprocess?.longcatLipsync,
      },
      latentSync: {
        ...defaults.postprocess.latentSync,
        ...stored.postprocess?.latentSync,
      },
      museTalk: {
        ...defaults.postprocess.museTalk,
        ...stored.postprocess?.museTalk,
      },
      lipForcing: {
        ...defaults.postprocess.lipForcing,
        ...stored.postprocess?.lipForcing,
      },
    },
    retake: { ...defaults.retake, ...stored.retake },
    continuity: { ...defaults.continuity, ...stored.continuity },
    longClipAcknowledged: stored.longClipAcknowledged ?? videoDurationSeconds(numFrames, frameRate) > 10,
  };
}

export function withLongCatLipsyncDisabled(request: GenerationRequest): GenerationRequest {
  return {
    ...request,
    postprocess: {
      ...request.postprocess,
      longcatLipsync: {
        ...request.postprocess.longcatLipsync,
        enabled: false,
      },
    },
  };
}

export function migrateGenerationRequest(value: unknown): GenerationRequest | null {
  const merged = mergeGenerationRequest(value);
  const parsed = generationRequestSchema.safeParse(merged);
  return parsed.success ? parsed.data : null;
}
