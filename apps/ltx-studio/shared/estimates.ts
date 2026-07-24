import type { GenerationRequest } from "./pipelines.js";
import { videoDurationSeconds } from "./presets.js";

export type ResourceEstimate = {
  memoryGiB: number;
  outputGiB: number;
  etaSeconds: number | null;
  etaSamples: number;
};

const MODEL_MEMORY_GIB: Record<GenerationRequest["mode"], number> = {
  "two-stage": 50,
  "two-stage-hq": 58,
  "one-stage": 42,
  distilled: 46,
  "ic-lora": 48,
  keyframes: 50,
  "audio-to-video": 50,
  lipdub: 56,
  retake: 48,
};

const ACTIVATION_MEMORY_GIB: Record<GenerationRequest["mode"], number> = {
  "two-stage": 18,
  "two-stage-hq": 22,
  "one-stage": 16,
  distilled: 16,
  "ic-lora": 18,
  keyframes: 18,
  "audio-to-video": 18,
  lipdub: 18,
  retake: 14,
};

// A native FP8 checkpoint reduces residency, but its unified-memory cold load
// still peaked at 42.6 GiB for a 320x576 one-stage smoke run on the GB10.
const NATIVE_FP8_COLD_LOAD_FACTOR = 0.95;

function selectedCheckpointPath(request: GenerationRequest): string {
  if (request.mode === "distilled" || request.mode === "ic-lora" || request.mode === "lipdub") {
    return request.models.distilledCheckpointPath;
  }
  if (request.mode === "retake" && request.retake.distilled) {
    return request.models.distilledCheckpointPath;
  }
  return request.models.checkpointPath;
}

function isNativeFp8Checkpoint(request: GenerationRequest): boolean {
  if (request.quantization.mode === "none") return false;
  const filename = selectedCheckpointPath(request).split("/").at(-1)?.toLowerCase() ?? "";
  return /(?:^|[-_.])fp8(?:[-_.]|$)/.test(filename);
}

export function requestComputeUnits(request: GenerationRequest): number {
  const frames = request.mode === "retake"
    ? Math.max(1, Math.round((request.retake.endTime - request.retake.startTime) * 24))
    : request.numFrames;
  const steps = ["distilled", "ic-lora", "lipdub"].includes(request.mode) || (request.mode === "retake" && request.retake.distilled)
    ? 8
    : request.numInferenceSteps;
  const stageFactor = ["two-stage", "two-stage-hq", "keyframes", "audio-to-video", "lipdub"].includes(request.mode)
    ? 1.7
    : 1;
  return Math.max(1, request.width * request.height * frames * steps * stageFactor);
}

export function estimateResources(request: GenerationRequest): ResourceEstimate {
  const referencePixels = 1536 * 1024;
  const pixelFactor = Math.max(0.35, (request.width * request.height) / referencePixels) ** 0.7;
  const frameFactor = request.mode === "retake"
    ? Math.max(0.4, ((request.retake.endTime - request.retake.startTime) / 5) ** 0.58)
    : Math.max(0.4, (request.numFrames / 121) ** 0.58);
  const tilingFactor = request.tiling && request.mode !== "one-stage" ? 0.75 : 1;
  // Runtime casting still cold-loads the full BF16 checkpoint before conversion.
  // A native FP8 file gets only the measured conservative cold-load discount.
  const modelFactor = isNativeFp8Checkpoint(request) ? NATIVE_FP8_COLD_LOAD_FACTOR : 1;
  const rawMemory = MODEL_MEMORY_GIB[request.mode] * modelFactor
    + ACTIVATION_MEMORY_GIB[request.mode] * pixelFactor * frameFactor * tilingFactor;
  const memoryGiB = Math.max(32, Math.ceil(rawMemory / 2) * 2);

  const duration = request.mode === "retake"
    ? Math.max(0.1, request.retake.endTime - request.retake.startTime)
    : videoDurationSeconds(request.numFrames, request.frameRate);
  const fps = request.mode === "retake" ? 24 : request.frameRate;
  const videoBytes = request.width * request.height * fps * 0.08 * duration / 8;
  const audioBytes = 256_000 * duration / 8;
  const outputGiB = Math.max(0.01, Math.ceil(((videoBytes + audioBytes) / 1024 ** 3) * 100) / 100);

  return { memoryGiB, outputGiB, etaSeconds: null, etaSamples: 0 };
}
