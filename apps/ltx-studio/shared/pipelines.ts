import { z } from "zod";

import { videoDurationSeconds } from "./presets.js";

export const pipelineModes = [
  "two-stage",
  "two-stage-hq",
  "one-stage",
  "distilled",
  "ic-lora",
  "keyframes",
  "audio-to-video",
  "lipdub",
  "retake",
] as const;

export type PipelineMode = (typeof pipelineModes)[number];

export const sourceModes = ["text", "image"] as const;
export type SourceMode = (typeof sourceModes)[number];

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
    label: "Text / Bild zu Video",
    shortLabel: "Zwei Stufen",
    description: "Produktionsmodus mit Upscaling und multimodaler Guidance.",
    family: "generate",
    quality: "Empfohlen",
    defaultHeight: 1024,
    defaultWidth: 1536,
    defaultSteps: 30,
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
    quality: "8 + 4 Schritte",
    defaultHeight: 1024,
    defaultWidth: 1536,
    defaultSteps: 8,
    needsNegativePrompt: false,
    needsSpatialUpscaler: true,
    needsDistilledLora: false,
  },
  {
    id: "ic-lora",
    label: "IC-LoRA Kontrolle",
    shortLabel: "IC-LoRA",
    description: "Video- und Bildkontrolle mit optionaler räumlicher Maske.",
    family: "condition",
    quality: "Kontrolliert",
    defaultHeight: 1024,
    defaultWidth: 1536,
    defaultSteps: 8,
    needsNegativePrompt: false,
    needsSpatialUpscaler: true,
    needsDistilledLora: false,
  },
  {
    id: "keyframes",
    label: "Keyframe Interpolation",
    shortLabel: "Keyframes",
    description: "Verbindet mehrere Bild-Keyframes mit kontrollierter Bewegung.",
    family: "condition",
    quality: "Präzise",
    defaultHeight: 1024,
    defaultWidth: 1536,
    defaultSteps: 30,
    needsNegativePrompt: true,
    needsSpatialUpscaler: true,
    needsDistilledLora: true,
  },
  {
    id: "audio-to-video",
    label: "Audio zu Video",
    shortLabel: "Audio",
    description: "Erzeugt die Bildspur passend zu einer vorhandenen Audiospur.",
    family: "condition",
    quality: "Audio-synchron",
    defaultHeight: 1024,
    defaultWidth: 1536,
    defaultSteps: 30,
    needsNegativePrompt: true,
    needsSpatialUpscaler: true,
    needsDistilledLora: true,
  },
  {
    id: "lipdub",
    label: "LipDub / Lipsync",
    shortLabel: "LipDub",
    description: "Spezialisierter Lippen- und Sprachabgleich aus einem Referenzvideo mit Audiospur.",
    family: "condition",
    quality: "Lipsync",
    defaultHeight: 1024,
    defaultWidth: 576,
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

export const outputNameSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.mp4$/);

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
      checkpointPath: pathValue,
      distilledCheckpointPath: pathValue,
      gemmaRoot: pathValue,
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
    icLora: z.object({
      videoConditioning: z.array(videoConditioningSchema).max(16),
      attentionMaskPath: pathValue,
      attentionStrength: z.number().finite().min(0).max(1),
      skipStage2: z.boolean(),
    }),
    audio: z.object({
      path: pathValue,
      name: z.string().trim().max(255),
      startTime: z.number().finite().min(0).max(86_400),
      maxDuration: z.number().finite().positive().max(86_400).nullable(),
    }),
    lipDub: z.object({
      referenceVideo: videoConditioningSchema,
      lora: loraSchema,
    }),
    postprocess: z.object({
      longcatLipsync: z.object({
        enabled: z.boolean(),
        resolution: z.enum(["480p", "720p"]),
        blend: z.number().finite().min(0).max(1),
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

    value.images.forEach((image, index) => requirePath(image.path, ["images", index, "path"], `Bild ${index + 1}`));
    value.models.loras.forEach((lora, index) => requirePath(lora.path, ["models", "loras", index, "path"], `LoRA ${index + 1}`));
    value.icLora.videoConditioning.forEach((video, index) =>
      requirePath(video.path, ["icLora", "videoConditioning", index, "path"], `Kontrollvideo ${index + 1}`),
    );

    if (["distilled", "ic-lora", "lipdub"].includes(value.mode) || (value.mode === "retake" && value.retake.distilled)) {
      requirePath(value.models.distilledCheckpointPath, ["models", "distilledCheckpointPath"], "Distilled Checkpoint");
    } else {
      requirePath(value.models.checkpointPath, ["models", "checkpointPath"], "Checkpoint");
    }
    if (["two-stage", "two-stage-hq", "one-stage", "distilled"].includes(value.mode)) {
      if (value.sourceMode === "image" && value.images.length === 0) {
        context.addIssue({ code: "custom", path: ["images"], message: "Für Bild-zu-Video ist ein Referenzbild erforderlich." });
      }
      if (value.sourceMode === "text" && value.images.length > 0) {
        context.addIssue({ code: "custom", path: ["images"], message: "Im Text-zu-Video-Modus dürfen keine Referenzbilder aktiv sein." });
      }
    }
    requirePath(value.models.gemmaRoot, ["models", "gemmaRoot"], "Gemma Root");
    if (definition.needsSpatialUpscaler) {
      requirePath(value.models.spatialUpscalerPath, ["models", "spatialUpscalerPath"], "Spatial Upscaler");
    }
    if (definition.needsDistilledLora) {
      requirePath(value.models.distilledLora.path, ["models", "distilledLora", "path"], "Distilled LoRA");
    }
    if (value.mode === "keyframes" && value.images.length < 2) {
      context.addIssue({ code: "custom", path: ["images"], message: "Mindestens zwei Keyframes sind erforderlich." });
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
      if (value.icLora.videoConditioning.length === 0) {
        context.addIssue({ code: "custom", path: ["icLora", "videoConditioning"], message: "Ein Kontrollvideo fehlt." });
      }
      if (value.models.loras.length === 0) {
        context.addIssue({ code: "custom", path: ["models", "loras"], message: "Ein IC-LoRA-Modell fehlt." });
      }
    }
    if (value.mode === "audio-to-video") {
      requirePath(value.audio.path, ["audio", "path"], "Audiodatei");
    }
    if (value.mode === "lipdub") {
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
      if (value.mode !== "audio-to-video") {
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
      const divisor = value.mode === "one-stage" ? 32 : 64;
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
    if (value.quantization.mode === "fp8-scaled-mm" && !value.quantization.amaxPath) {
      context.addIssue({ code: "custom", path: ["quantization", "amaxPath"], message: "AMAX-Datei fehlt." });
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
  return {
    mode,
    sourceMode: ["keyframes", "ic-lora"].includes(mode) ? "image" : "text",
    prompt: "",
    promptParts: { ...defaultPromptParts },
    negativePrompt: "",
    enhancePrompt: mode === "lipdub" ? false : true,
    seed: 10,
    height: definition.defaultHeight,
    width: definition.defaultWidth,
    numFrames: 121,
    frameRate: 24,
    numInferenceSteps: definition.defaultSteps,
    outputName: `ltx-${mode}.mp4`,
    tiling: true,
    longClipAcknowledged: false,
    continuity: { project: "", notes: "" },
    models: {
      checkpointPath: "",
      distilledCheckpointPath: "",
      gemmaRoot: "",
      spatialUpscalerPath: "",
      distilledLora: { path: "", strength: 1 },
      loras: [],
    },
    images: [],
    quantization: { mode: "none", amaxPath: "" },
    videoGuidance: { ...defaultGuidance },
    audioGuidance: { ...defaultGuidance, cfgScale: 7 },
    hq: { distilledLoraStrengthStage1: 0.25, distilledLoraStrengthStage2: 0.5 },
    icLora: { videoConditioning: [], attentionMaskPath: "", attentionStrength: 1, skipStage2: false },
    audio: { path: "", name: "", startTime: 0, maxDuration: null },
    lipDub: {
      referenceVideo: { path: "", name: "", strength: 1 },
      lora: { path: "", strength: 1 },
    },
    postprocess: {
      longcatLipsync: { enabled: false, resolution: "480p", blend: 0.9 },
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
      distilledLora: { ...defaults.models.distilledLora, ...stored.models?.distilledLora },
      loras: stored.models?.loras ?? defaults.models.loras,
    },
    images,
    quantization: { ...defaults.quantization, ...stored.quantization },
    videoGuidance: { ...defaults.videoGuidance, ...stored.videoGuidance },
    audioGuidance: { ...defaults.audioGuidance, ...stored.audioGuidance },
    hq: { ...defaults.hq, ...stored.hq },
    icLora: { ...defaults.icLora, ...stored.icLora },
    audio: { ...defaults.audio, ...stored.audio },
    lipDub: {
      ...defaults.lipDub,
      ...stored.lipDub,
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
