import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { GenerationRequest, PipelineMode } from "../shared/pipelines.js";
import { outputRoot, pythonExecutable } from "./config.js";
import { probeVideoMetadata } from "./mediaProbe.js";

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
  if (request.mode === "lipdub" && request.lipDub.referenceVideo.path) {
    const metadata = probeVideoMetadata(request.lipDub.referenceVideo.path);
    if (metadata?.hasAudio === false) {
      errors.push(`LipDub-Referenzvideo enthält keine Audiospur (${request.lipDub.referenceVideo.path})`);
    }
  }
  return errors;
}
