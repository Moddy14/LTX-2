import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { GenerationRequest, PipelineMode } from "../shared/pipelines.js";
import type { PlanSuggestion } from "../shared/plan.js";
import { outputRoot, pythonExecutable } from "./config.js";
import { probeVideoMetadata, type VideoMetadata } from "./mediaProbe.js";

const MODULES: Record<PipelineMode, string> = {
  "two-stage": "ltx_pipelines.ti2vid_two_stages",
  "two-stage-hq": "ltx_pipelines.ti2vid_two_stages_hq",
  "one-stage": "ltx_pipelines.ti2vid_one_stage",
  distilled: "ltx_pipelines.distilled",
  "ic-lora": "ltx_pipelines.ic_lora",
  keyframes: "ltx_pipelines.keyframe_interpolation",
  "audio-to-video": "ltx_pipelines.a2vid_two_stage",
  lipdub: "ltx_pipelines.lipdub",
  retake: "ltx_pipelines.retake",
};

export type PathRequirement = {
  path: string;
  label: string;
  kind: "file" | "directory";
};

export type CommandPlan = {
  executable: string;
  args: string[];
  displayCommand: string;
  outputPath: string;
  requiredPaths: PathRequirement[];
};

const LIPDUB_MIN_REFERENCE_SECONDS = 1;
const LIPDUB_MAX_REFERENCE_SECONDS = 20;
const LIPDUB_MIN_REFERENCE_FPS = 12;
const LIPDUB_MAX_REFERENCE_FPS = 60;
const LIPDUB_MIN_REFERENCE_DIMENSION = 256;
const LIPDUB_MAX_ASPECT_RATIO_DRIFT = 0.15;
const LIPDUB_MIN_DIALOGUE_WPM = 65;
const LIPDUB_MAX_DIALOGUE_WPM = 220;
const LIPDUB_EXPECTED_DISTILLED_CHECKPOINT = "ltx-2.3-22b-distilled-1.1.safetensors";
const LIPDUB_EXPECTED_SPATIAL_UPSCALER = "ltx-2.3-spatial-upscaler-x2-1.1.safetensors";
const LIPDUB_OUTPUT_SIZE_MULTIPLE = 64;
const LIPDUB_OUTPUT_SIZE_CANDIDATE_RADIUS = 1;

function appendFlag(args: string[], flag: string, value: string | number): void {
  args.push(flag, String(value));
}

function appendBoolean(args: string[], enabled: boolean, flag: string): void {
  if (enabled) args.push(flag);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function appendCommonGenerationArgs(request: GenerationRequest, args: string[]): void {
  appendFlag(args, "--gemma-root", request.models.gemmaRoot);
  appendFlag(args, "--prompt", request.prompt);
  appendFlag(args, "--output-path", join(outputRoot, request.outputName));
  appendFlag(args, "--seed", request.seed);
  appendFlag(args, "--height", request.height);
  appendFlag(args, "--width", request.width);
  appendFlag(args, "--num-frames", request.numFrames);
  appendFlag(args, "--frame-rate", request.frameRate);
  appendFlag(args, "--num-inference-steps", request.numInferenceSteps);
  appendBoolean(args, request.enhancePrompt, "--enhance-prompt");
  appendBoolean(args, request.mode !== "one-stage" && !request.tiling, "--disable-tiling");

  for (const image of request.images) {
    args.push("--image", image.path, String(image.frameIndex), String(image.strength), String(image.crf));
  }
  for (const lora of request.models.loras) {
    args.push("--lora", lora.path, String(lora.strength));
  }
  if (request.quantization.mode !== "none") {
    args.push("--quantization", request.quantization.mode);
    if (request.quantization.mode === "fp8-scaled-mm") args.push(request.quantization.amaxPath);
  }
}

function appendGuidanceArgs(request: GenerationRequest, args: string[], includeAudio = true): void {
  const pairs = [
    ["video", request.videoGuidance],
    ...(includeAudio ? [["audio", request.audioGuidance] as const] : []),
  ] as const;
  for (const [prefix, guidance] of pairs) {
    appendFlag(args, `--${prefix}-cfg-guidance-scale`, guidance.cfgScale);
    appendFlag(args, `--${prefix}-stg-guidance-scale`, guidance.stgScale);
    appendFlag(args, `--${prefix}-rescale-scale`, guidance.rescaleScale);
    appendFlag(args, prefix === "video" ? "--a2v-guidance-scale" : "--v2a-guidance-scale", guidance.modalityScale);
    appendFlag(args, `--${prefix}-skip-step`, guidance.skipStep);
    if (guidance.stgBlocks.length > 0) {
      args.push(`--${prefix}-stg-blocks`, ...guidance.stgBlocks.map(String));
    }
  }
}

function snappedFramesTo8k1(frames: number): number {
  return Math.max(1, Math.floor((Math.max(1, frames) - 1) / 8) * 8 + 1);
}

function nearestMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function sizeCandidatesAround(value: number): number[] {
  const center = nearestMultiple(value, LIPDUB_OUTPUT_SIZE_MULTIPLE);
  const candidates = new Set<number>();
  for (
    let offset = -LIPDUB_OUTPUT_SIZE_CANDIDATE_RADIUS;
    offset <= LIPDUB_OUTPUT_SIZE_CANDIDATE_RADIUS;
    offset += 1
  ) {
    const candidate = center + offset * LIPDUB_OUTPUT_SIZE_MULTIPLE;
    if (candidate >= LIPDUB_MIN_REFERENCE_DIMENSION && candidate <= 4096) candidates.add(candidate);
  }
  return [...candidates].sort((left, right) => left - right);
}

function recommendedLipDubOutputSize(metadata: VideoMetadata): { width: number; height: number } | null {
  if (metadata.width === null || metadata.height === null) return null;
  const referenceAspect = metadata.width / metadata.height;
  const referenceArea = metadata.width * metadata.height;
  let best: { width: number; height: number; score: number } | null = null;

  for (const width of sizeCandidatesAround(metadata.width)) {
    for (const height of sizeCandidatesAround(metadata.height)) {
      const aspectDrift = Math.abs(Math.log((width / height) / referenceAspect));
      const areaDrift = Math.abs(Math.log((width * height) / referenceArea));
      const score = aspectDrift * 100 + areaDrift;
      if (best === null || score < best.score) best = { width, height, score };
    }
  }

  return best ? { width: best.width, height: best.height } : null;
}

function metadataDurationSeconds(metadata: VideoMetadata): number | null {
  if (metadata.durationSeconds !== null) return metadata.durationSeconds;
  if (metadata.frames !== null && metadata.fps !== null && metadata.fps > 0) return metadata.frames / metadata.fps;
  return null;
}

function dialogueFromRequest(request: GenerationRequest): string {
  const explicit = request.promptParts.dialogue.trim();
  if (explicit) return explicit;
  const quoted = [...request.prompt.matchAll(/["“]([^"”]{2,})["”]/g)]
    .map((match) => match[1].trim())
    .sort((left, right) => right.length - left.length);
  return quoted[0] ?? "";
}

function countDialogueWords(dialogue: string): number {
  return dialogue.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function validateLipDubReference(request: GenerationRequest): string[] {
  const errors: string[] = [];
  const path = request.lipDub.referenceVideo.path;
  if (!path) return errors;

  const metadata = probeVideoMetadata(path);
  if (!metadata) {
    return [`LipDub-Referenzvideo konnte nicht dekodiert werden oder enthält keine lesbare Videospur (${path})`];
  }
  if (metadata.hasAudio === false) {
    errors.push(`LipDub-Referenzvideo enthält keine Audiospur (${path})`);
  } else if (metadata.hasAudio !== true) {
    errors.push(`LipDub-Referenzvideo-Audiospur konnte nicht verlässlich geprüft werden (${path})`);
  }

  const durationSeconds = metadataDurationSeconds(metadata);
  if (durationSeconds === null) {
    errors.push(`LipDub-Referenzvideo-Dauer konnte nicht verlässlich bestimmt werden (${path})`);
  } else {
    if (durationSeconds < LIPDUB_MIN_REFERENCE_SECONDS) {
      errors.push(
        `LipDub-Referenzvideo ist zu kurz (${durationSeconds.toFixed(2)} s); mindestens ${LIPDUB_MIN_REFERENCE_SECONDS.toFixed(0)} s verwenden.`,
      );
    }
    if (durationSeconds > LIPDUB_MAX_REFERENCE_SECONDS) {
      errors.push(
        `LipDub-Referenzvideo ist zu lang (${durationSeconds.toFixed(2)} s); für reproduzierbare Tests maximal ${LIPDUB_MAX_REFERENCE_SECONDS.toFixed(0)} s verwenden.`,
      );
    }

    const words = countDialogueWords(dialogueFromRequest(request));
    if (words > 0) {
      const wordsPerMinute = words / (durationSeconds / 60);
      if (wordsPerMinute < LIPDUB_MIN_DIALOGUE_WPM) {
        errors.push(
          `LipDub-Dialog ist für die Referenzdauer zu kurz (${words} Wörter in ${durationSeconds.toFixed(2)} s, ca. ${wordsPerMinute.toFixed(0)} WPM).`,
        );
      } else if (wordsPerMinute > LIPDUB_MAX_DIALOGUE_WPM) {
        errors.push(
          `LipDub-Dialog ist für die Referenzdauer zu lang (${words} Wörter in ${durationSeconds.toFixed(2)} s, ca. ${wordsPerMinute.toFixed(0)} WPM).`,
        );
      }
    }
  }

  if (metadata.fps === null) {
    errors.push(`LipDub-Referenzvideo-FPS konnte nicht verlässlich bestimmt werden (${path})`);
  } else if (metadata.fps < LIPDUB_MIN_REFERENCE_FPS || metadata.fps > LIPDUB_MAX_REFERENCE_FPS) {
    errors.push(
      `LipDub-Referenzvideo hat ungeeignete FPS (${metadata.fps.toFixed(2)}); empfohlen sind ${LIPDUB_MIN_REFERENCE_FPS}-${LIPDUB_MAX_REFERENCE_FPS} FPS.`,
    );
  }

  if (metadata.frames !== null && snappedFramesTo8k1(metadata.frames) < 9) {
    errors.push("LipDub-Referenzvideo liefert nach 8k+1-Snapping weniger als 9 Frames.");
  }

  if (metadata.width === null || metadata.height === null) {
    errors.push(`LipDub-Referenzvideo-Maße konnten nicht verlässlich bestimmt werden (${path})`);
  } else {
    if (metadata.width < LIPDUB_MIN_REFERENCE_DIMENSION || metadata.height < LIPDUB_MIN_REFERENCE_DIMENSION) {
      errors.push(
        `LipDub-Referenzvideo ist zu klein (${metadata.width} x ${metadata.height}); mindestens ${LIPDUB_MIN_REFERENCE_DIMENSION} px pro Kante verwenden.`,
      );
    }
    const referenceAspect = metadata.width / metadata.height;
    const outputAspect = request.width / request.height;
    const drift = Math.abs(Math.log(referenceAspect / outputAspect));
    if (drift > LIPDUB_MAX_ASPECT_RATIO_DRIFT) {
      errors.push(
        `LipDub-Ausgabeformat passt nicht zum Referenzvideo (${request.width} x ${request.height} vs. ${metadata.width} x ${metadata.height}); Seitenverhältnis angleichen oder Referenz passend zuschneiden.`,
      );
    }
  }

  return errors;
}

function warnLipDubReference(request: GenerationRequest): string[] {
  const path = request.lipDub.referenceVideo.path;
  const warnings: string[] = [];

  const distilledName = basename(request.models.distilledCheckpointPath);
  if (distilledName && distilledName !== LIPDUB_EXPECTED_DISTILLED_CHECKPOINT) {
    warnings.push(
      `LipDub-Checkpoint ist ${distilledName}; offizieller Referenzstand ist ${LIPDUB_EXPECTED_DISTILLED_CHECKPOINT}.`,
    );
  }
  const upscalerName = basename(request.models.spatialUpscalerPath);
  if (upscalerName && upscalerName !== LIPDUB_EXPECTED_SPATIAL_UPSCALER) {
    warnings.push(
      `LipDub-Spatial-Upscaler ist ${upscalerName}; offizieller Referenzstand ist ${LIPDUB_EXPECTED_SPATIAL_UPSCALER}.`,
    );
  }

  if (!path) return warnings;

  const metadata = probeVideoMetadata(path);
  if (!metadata) return warnings;

  if (metadata.width !== null && metadata.height !== null) {
    const referenceLabel = `${metadata.width} x ${metadata.height}`;
    const outputLabel = `${request.width} x ${request.height}`;
    const referenceAspect = metadata.width / metadata.height;
    const outputAspect = request.width / request.height;
    const aspectDelta = Math.abs(referenceAspect - outputAspect) / referenceAspect;
    const recommendedSize = recommendedLipDubOutputSize(metadata);
    const matchesRecommendedSize = recommendedSize !== null
      && recommendedSize.width === request.width
      && recommendedSize.height === request.height;

    if ((metadata.width !== request.width || metadata.height !== request.height) && !matchesRecommendedSize) {
      warnings.push(
        `LipDub-Referenz ist ${referenceLabel}, Ausgabe ist ${outputLabel}. `
        + "Für höchste Qualität sollte die Ausgabe der Referenzauflösung oder dem nächstliegenden durch 64 teilbaren Format entsprechen.",
      );
    }
    if (aspectDelta > 0.02) {
      warnings.push(
        `LipDub-Seitenverhältnis weicht um ${(aspectDelta * 100).toFixed(1)} % ab; `
        + "das kann Gesicht, Mundposition und Identität sichtbar reskalieren.",
      );
    }
  }

  if (metadata.frames !== null) {
    const snappedFrames = snappedFramesTo8k1(metadata.frames);
    if (snappedFrames !== metadata.frames) {
      warnings.push(
        `Die native LipDub-Pipeline snappt ${metadata.frames} Referenzframes auf ${snappedFrames} Frames nach 8k+1; `
        + "das Clipende kann dadurch wegfallen.",
      );
    }
  }

  if (metadata.fps !== null && Math.abs(metadata.fps - Math.round(metadata.fps)) > 0.001) {
    warnings.push(
      `Referenz-FPS ist ${metadata.fps.toFixed(3)}. Die native Ausgabe kodiert derzeit mit ganzzahliger FPS; `
      + "für präzisen LipSync vorher auf konstante 24, 25 oder 30 FPS transkodieren.",
    );
  }

  const durationSeconds = metadataDurationSeconds(metadata);
  if (durationSeconds !== null && durationSeconds > 5) {
    warnings.push(
      `Referenzdauer ist ${durationSeconds.toFixed(1)} s. Für die Kalibrierung zuerst einen 2-5-s-Ausschnitt prüfen, `
      + "danach dieselben Einstellungen auf längere Clips übertragen.",
    );
  }

  return warnings;
}

export function buildCommand(request: GenerationRequest): CommandPlan {
  const outputPath = resolve(outputRoot, request.outputName);
  const args = ["-m", MODULES[request.mode]];
  const requiredPaths: PathRequirement[] = [{ path: request.models.gemmaRoot, label: "Gemma Root", kind: "directory" }];
  if (request.enhancePrompt) {
    requiredPaths.push({
      path: join(request.models.gemmaRoot, "preprocessor_config.json"),
      label: "Gemma Prozessorkonfiguration für Promptverbesserung",
      kind: "file",
    });
  }

  if (request.mode === "lipdub") {
    args.push(
      "--distilled-checkpoint-path",
      request.models.distilledCheckpointPath,
      "--gemma-root",
      request.models.gemmaRoot,
      "--prompt",
      request.prompt,
      "--output-path",
      outputPath,
      "--seed",
      String(request.seed),
      "--height",
      String(request.height),
      "--width",
      String(request.width),
      "--spatial-upsampler-path",
      request.models.spatialUpscalerPath,
      "--reference-video",
      request.lipDub.referenceVideo.path,
      "--reference-strength",
      String(request.lipDub.referenceVideo.strength),
      "--lora",
      request.lipDub.lora.path,
      String(request.lipDub.lora.strength),
    );
    appendBoolean(args, request.enhancePrompt, "--enhance-prompt");
    if (request.quantization.mode !== "none") {
      args.push("--quantization", request.quantization.mode);
      if (request.quantization.mode === "fp8-scaled-mm") args.push(request.quantization.amaxPath);
    }
    requiredPaths.push(
      { path: request.models.distilledCheckpointPath, label: "Distilled Checkpoint", kind: "file" },
      { path: request.models.spatialUpscalerPath, label: "Spatial Upscaler", kind: "file" },
      { path: request.lipDub.referenceVideo.path, label: "LipDub-Referenzvideo", kind: "file" },
      { path: request.lipDub.lora.path, label: "LipDub IC-LoRA", kind: "file" },
    );
  } else if (request.mode === "retake") {
    const checkpointPath = request.retake.distilled
      ? request.models.distilledCheckpointPath
      : request.models.checkpointPath;
    args.push(
      "--video-path",
      request.retake.videoPath,
      "--prompt",
      request.prompt,
      "--start-time",
      String(request.retake.startTime),
      "--end-time",
      String(request.retake.endTime),
      "--output-path",
      outputPath,
      "--checkpoint-path",
      checkpointPath,
      "--gemma-root",
      request.models.gemmaRoot,
      "--seed",
      String(request.seed),
    );
    if (!request.retake.distilled) {
      appendFlag(args, "--negative-prompt", request.negativePrompt);
      appendFlag(args, "--num-inference-steps", request.numInferenceSteps);
      appendGuidanceArgs(request, args);
    }
    appendBoolean(args, request.enhancePrompt, "--enhance-prompt");
    appendBoolean(args, request.retake.distilled, "--distilled");
    appendBoolean(args, !request.retake.regenerateVideo, "--no-regenerate-video");
    appendBoolean(args, !request.retake.regenerateAudio, "--no-regenerate-audio");
    appendBoolean(args, !request.tiling, "--disable-tiling");
    for (const lora of request.models.loras) args.push("--lora", lora.path, String(lora.strength));
    if (request.quantization.mode !== "none") {
      args.push("--quantization", request.quantization.mode);
      if (request.quantization.mode === "fp8-scaled-mm") args.push(request.quantization.amaxPath);
    }
    requiredPaths.push(
      { path: checkpointPath, label: request.retake.distilled ? "Distilled Checkpoint" : "Checkpoint", kind: "file" },
      { path: request.retake.videoPath, label: "Quellvideo", kind: "file" },
    );
  } else {
    const distilled = request.mode === "distilled" || request.mode === "ic-lora";
    const checkpointPath = distilled ? request.models.distilledCheckpointPath : request.models.checkpointPath;
    appendFlag(args, distilled ? "--distilled-checkpoint-path" : "--checkpoint-path", checkpointPath);
    appendCommonGenerationArgs(request, args);
    requiredPaths.push({ path: checkpointPath, label: distilled ? "Distilled Checkpoint" : "Checkpoint", kind: "file" });

    if (["two-stage", "two-stage-hq", "one-stage", "keyframes", "audio-to-video"].includes(request.mode)) {
      appendFlag(args, "--negative-prompt", request.negativePrompt);
      appendGuidanceArgs(request, args, request.mode !== "audio-to-video");
    }
    if (["two-stage", "two-stage-hq", "keyframes", "audio-to-video"].includes(request.mode)) {
      args.push("--distilled-lora", request.models.distilledLora.path, String(request.models.distilledLora.strength));
      requiredPaths.push({ path: request.models.distilledLora.path, label: "Distilled LoRA", kind: "file" });
    }
    if (!["one-stage"].includes(request.mode)) {
      appendFlag(args, "--spatial-upsampler-path", request.models.spatialUpscalerPath);
      requiredPaths.push({ path: request.models.spatialUpscalerPath, label: "Spatial Upscaler", kind: "file" });
    }
    if (request.mode === "two-stage-hq") {
      appendFlag(args, "--distilled-lora-strength-stage-1", request.hq.distilledLoraStrengthStage1);
      appendFlag(args, "--distilled-lora-strength-stage-2", request.hq.distilledLoraStrengthStage2);
    }
    if (request.mode === "ic-lora") {
      for (const video of request.icLora.videoConditioning) {
        args.push("--video-conditioning", video.path, String(video.strength));
        requiredPaths.push({ path: video.path, label: `Kontrollvideo ${video.name}`, kind: "file" });
      }
      if (request.icLora.attentionMaskPath) {
        args.push(
          "--conditioning-attention-mask",
          request.icLora.attentionMaskPath,
          String(request.icLora.attentionStrength),
        );
        requiredPaths.push({ path: request.icLora.attentionMaskPath, label: "Kontrollmaske", kind: "file" });
      }
      appendBoolean(args, request.icLora.skipStage2, "--skip-stage-2");
    }
    if (request.mode === "audio-to-video") {
      appendFlag(args, "--audio-path", request.audio.path);
      appendFlag(args, "--audio-start-time", request.audio.startTime);
      if (request.audio.maxDuration !== null) appendFlag(args, "--audio-max-duration", request.audio.maxDuration);
      requiredPaths.push({ path: request.audio.path, label: "Audiodatei", kind: "file" });
    }
  }

  if (request.mode !== "lipdub") {
    for (const image of request.images) {
      requiredPaths.push({ path: image.path, label: `Bild ${image.name}`, kind: "file" });
    }
    for (const lora of request.models.loras) {
      requiredPaths.push({ path: lora.path, label: "LoRA", kind: "file" });
    }
  }
  if (request.quantization.mode === "fp8-scaled-mm") {
    requiredPaths.push({ path: request.quantization.amaxPath, label: "AMAX-Datei", kind: "file" });
  }

  return {
    executable: pythonExecutable,
    args,
    displayCommand: [pythonExecutable, ...args].map(shellQuote).join(" "),
    outputPath,
    requiredPaths,
  };
}

export function validatePlanPaths(plan: CommandPlan): string[] {
  const errors: string[] = [];
  for (const requirement of plan.requiredPaths) {
    try {
      const stats = statSync(requirement.path);
      const matches = requirement.kind === "file" ? stats.isFile() : stats.isDirectory();
      if (!matches) errors.push(`${requirement.label}: falscher Pfadtyp (${requirement.path})`);
    } catch {
      errors.push(`${requirement.label}: nicht gefunden (${requirement.path})`);
    }
  }
  if (existsSync(plan.outputPath)) errors.push(`Ausgabedatei existiert bereits (${plan.outputPath})`);
  return errors;
}

export function validateRequestPlan(request: GenerationRequest, plan: CommandPlan): string[] {
  const errors = validatePlanPaths(plan);
  if (request.mode === "lipdub") errors.push(...validateLipDubReference(request));
  return errors;
}

export function warnRequestPlan(request: GenerationRequest): string[] {
  return request.mode === "lipdub" ? warnLipDubReference(request) : [];
}

export function suggestRequestPlan(request: GenerationRequest): PlanSuggestion[] {
  if (request.mode !== "lipdub" || !request.lipDub.referenceVideo.path) return [];
  const metadata = probeVideoMetadata(request.lipDub.referenceVideo.path);
  if (!metadata) return [];
  const recommendedSize = recommendedLipDubOutputSize(metadata);
  if (!recommendedSize) return [];
  if (recommendedSize.width === request.width && recommendedSize.height === request.height) return [];

  return [{
    id: "lipdub-reference-format",
    level: "info",
    label: `Format ${recommendedSize.width} x ${recommendedSize.height} übernehmen`,
    message:
      `Referenzvideo ${metadata.width} x ${metadata.height}; empfohlenes 64er-LipDub-Format `
      + `${recommendedSize.width} x ${recommendedSize.height} mit möglichst geringer Seitenverhältnisdrift.`,
    patch: recommendedSize,
  }];
}
