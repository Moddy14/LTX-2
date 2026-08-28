import { effectiveA2vTimeline, type EffectiveA2vTimeline } from "./a2vDuration.js";
import {
  dfrOutputGeometry,
  dfrSettings,
  usesOfficialComfyLipDub,
  type GenerationRequest,
} from "./pipelines.js";
import { videoDurationSeconds } from "./presets.js";
import { qualificationHoldForRequest } from "./qualificationHold.js";

export type ResourceEstimate = {
  memoryGiB: number;
  outputGiB: number;
  etaSeconds: number | null;
  etaSamples: number;
  memoryBasis?: string;
  qualificationHold?: true;
  a2vTimeline?: EffectiveA2vTimeline;
};

export type EstimateOptions = {
  audioSourceDurationSeconds?: number | null;
};

export type StartMemoryGate = {
  minAvailableGiB: number;
  minResidualMemoryGiB: number;
};

const MODEL_MEMORY_GIB: Record<GenerationRequest["mode"], number> = {
  "two-stage": 50,
  "two-stage-hq": 58,
  "one-stage": 42,
  distilled: 46,
  dfr: 64,
  "text-to-audio": 30,
  "ic-lora": 48,
  "id-lora": 58,
  keyframes: 46,
  "image-audio-to-video": 50,
  "audio-to-video": 50,
  lipdub: 56,
  retake: 48,
};

const ACTIVATION_MEMORY_GIB: Record<GenerationRequest["mode"], number> = {
  "two-stage": 18,
  "two-stage-hq": 22,
  "one-stage": 16,
  distilled: 16,
  dfr: 20,
  "text-to-audio": 6,
  "ic-lora": 18,
  "id-lora": 22,
  keyframes: 16,
  "image-audio-to-video": 18,
  "audio-to-video": 18,
  lipdub: 18,
  retake: 14,
};

// A native FP8 checkpoint reduces residency, but its unified-memory cold load
// still peaked at 42.6 GiB for a 320x576 one-stage smoke run on the GB10.
const NATIVE_FP8_COLD_LOAD_FACTOR = 0.95;
export const DFR_UNMEASURED_BOOTSTRAP_MEMORY_GIB = 86;
export const DFR_MEMORY_BASIS = "unmeasured-bootstrap:official-dfr-v1.3.0-single-call.v2";
// Four complete LTX-2.5 split-BF16 T2A GUI cold starts succeeded with
// 83.83-87.01 GiB available, while a 77.46-GiB start OOMed while loading the
// duration head. The DGX orchestrator adds its canonical 12-GiB non-Qwen
// safety headroom to this 72-GiB workload reservation, producing an 84-GiB
// start fence rounded conservatively above the lowest successful observation.
// Keep this scoped to the audited split-BF16 contract; persisted LTX-2.3
// monolith requests retain their prior estimate.
export const LTX25_SPLIT_BF16_T2A_MEMORY_GIB = 72;
export const LTX25_SPLIT_BF16_T2A_MEMORY_BASIS =
  "measured-cold-start:ltx-2.5-split-bf16-t2a.v1";
// The first full-size native IA2V qualification run uses the same sequential
// split-BF16 transformer, spatial upscaler and video VAE loads as the measured
// 1024x1536 / 289-frame distilled baseline. IA2V adds a 0.365-GB audio VAE and
// small frozen audio latents, but the historical generic A2V 50/18 constants
// have no local peak measurement behind them. Reserve the baseline's 66-GiB
// workload budget for this one audited, refiner-free profile and let the DGX
// orchestrator add its canonical 12-GiB start headroom. This is deliberately a
// provisional proxy, not a measured IA2V profile; every profile deviation
// falls back to the generic estimator until the first run records a real peak.
export const LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_GIB = 66;
export const LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_BASIS =
  "provisional-proxy:ltx-2.5-split-bf16-ia2v-1024x1536-289f-24fps-tiled-explicit-1img-no-lora-no-refiner.v1";

function isLtx25SplitBf16TextToAudio(request: GenerationRequest): boolean {
  return request.mode === "text-to-audio"
    && request.models.layout === "split"
    && request.models.generation === "2.5"
    && request.quantization.mode === "none";
}

function isLtx25SplitBf16Ia2vCalibrationProfile(
  request: GenerationRequest,
  resourceFrames: number,
): boolean {
  const postprocess = request.postprocess;
  return request.mode === "image-audio-to-video"
    && request.models.layout === "split"
    && request.models.generation === "2.5"
    && request.quantization.mode === "none"
    && request.width === 1024
    && request.height === 1536
    && request.numFrames === 289
    && resourceFrames === 289
    && request.frameRate === 24
    && request.audio.maxDuration === null
    && request.audio.finalMix.path === ""
    && request.audio.finalMix.name === ""
    && request.tiling
    && !request.enhancePrompt
    && request.images.length === 1
    && request.images[0]?.frameIndex === 0
    && request.models.loras.length === 0
    && !request.models.gemmaLora.enabled
    && !postprocess.longcatLipsync.enabled
    && !postprocess.latentSync.enabled
    && !postprocess.museTalk.enabled
    && !postprocess.lipForcing.enabled;
}

function selectedCheckpointPath(request: GenerationRequest): string {
  if (["distilled", "ic-lora", "keyframes"].includes(request.mode)
    || (request.mode === "lipdub" && !usesOfficialComfyLipDub(request))) {
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

export function requestComputeUnits(request: GenerationRequest, options: EstimateOptions = {}): number {
  const a2vTimeline = effectiveA2vTimeline(request, options.audioSourceDurationSeconds);
  const frames = request.mode === "retake"
    ? Math.max(1, Math.round((request.retake.endTime - request.retake.startTime) * 24))
    : a2vTimeline?.frameCount ?? request.numFrames;
  const steps = ["distilled", "dfr", "ic-lora", "keyframes", "lipdub", "text-to-audio"].includes(request.mode)
    || (request.mode === "retake" && request.retake.distilled)
    ? 8
    : request.numInferenceSteps;
  const stageFactor = [
    "two-stage",
    "two-stage-hq",
    "image-audio-to-video",
    "audio-to-video",
    "id-lora",
    "lipdub",
    "dfr",
  ].includes(request.mode)
    ? 1.7
    : 1;
  const temporalFactor = request.mode === "dfr"
    ? 1 + (2 ** dfrSettings(request).temporalUpscalings - 1) * 0.5
    : 1;
  const spatialFactor = request.mode === "dfr" && dfrSettings(request).spatialUpscalings === 2
    ? 1.05
    : 1;
  return Math.max(
    1,
    request.width * request.height * frames * steps * stageFactor * temporalFactor * spatialFactor,
  );
}

export function estimateResources(request: GenerationRequest, options: EstimateOptions = {}): ResourceEstimate {
  const qualificationHold = qualificationHoldForRequest(request);
  const a2vTimeline = effectiveA2vTimeline(request, options.audioSourceDurationSeconds);
  // Admission and RAM planning retain the cap-based upper bound even when an
  // EOF probe reports a shorter file. The input path is not a sealed identity,
  // so using the smaller value here would permit a later path replacement to
  // understate the actual allocation. Timeline/output estimates may use EOF.
  const resourceFrames = a2vTimeline?.upperBoundFrameCount ?? request.numFrames;
  const referencePixels = 1536 * 1024;
  const pixelFactor = Math.max(0.35, (request.width * request.height) / referencePixels) ** 0.7;
  const frameFactor = request.mode === "retake"
    ? Math.max(0.4, ((request.retake.endTime - request.retake.startTime) / 5) ** 0.58)
    : Math.max(0.4, (resourceFrames / 121) ** 0.58);
  const tilingFactor = request.tiling && request.mode !== "one-stage" ? 0.75 : 1;
  // Runtime casting still cold-loads the full BF16 checkpoint before conversion.
  // A native FP8 file gets only the measured conservative cold-load discount.
  const modelFactor = isNativeFp8Checkpoint(request) ? NATIVE_FP8_COLD_LOAD_FACTOR : 1;
  const rawMemory = MODEL_MEMORY_GIB[request.mode] * modelFactor
    + ACTIVATION_MEMORY_GIB[request.mode] * pixelFactor * frameFactor * tilingFactor;
  // The released LipForcing 14B postprocessor peaks around 37 GiB on H200
  // with precomputed text embeddings. Reserve 52 GiB on shared-memory GB10
  // until a local peak measurement justifies a lower profile.
  const postprocessFloorGiB = request.postprocess.lipForcing.enabled ? 52 : 32;
  const roundedMemoryGiB = Math.max(postprocessFloorGiB, Math.ceil(rawMemory / 2) * 2);
  const dfr = dfrSettings(request);
  const dfrBootstrapFloor = DFR_UNMEASURED_BOOTSTRAP_MEMORY_GIB
    + dfr.temporalUpscalings * 12
    + (dfr.spatialUpscalings === 2 ? 8 : 0);
  const ltx25T2aSplitBf16 = isLtx25SplitBf16TextToAudio(request);
  const ltx25Ia2vCalibration = isLtx25SplitBf16Ia2vCalibrationProfile(request, resourceFrames);
  const memoryGiB = request.mode === "dfr"
    ? Math.max(dfrBootstrapFloor, roundedMemoryGiB)
    : ltx25T2aSplitBf16
      ? Math.max(LTX25_SPLIT_BF16_T2A_MEMORY_GIB, roundedMemoryGiB)
      : ltx25Ia2vCalibration
        ? LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_GIB
        : roundedMemoryGiB;

  const dfrOutput = request.mode === "dfr" ? dfrOutputGeometry(request) : null;
  const duration = request.mode === "retake"
    ? Math.max(0.1, request.retake.endTime - request.retake.startTime)
    : a2vTimeline?.durationSeconds
      ?? dfrOutput?.durationSeconds
      ?? videoDurationSeconds(request.numFrames, request.frameRate);
  const fps = request.mode === "retake" ? 24 : dfrOutput?.frameRate ?? request.frameRate;
  const videoBytes = (dfrOutput?.width ?? request.width)
    * (dfrOutput?.height ?? request.height)
    * fps * 0.08 * duration / 8;
  const audioBytes = 256_000 * duration / 8;
  const outputGiB = Math.max(0.01, Math.ceil(((videoBytes + audioBytes) / 1024 ** 3) * 100) / 100);

  return {
    memoryGiB,
    outputGiB,
    etaSeconds: null,
    etaSamples: 0,
    ...(a2vTimeline ? { a2vTimeline } : {}),
    ...(request.mode === "dfr" ? {
      memoryBasis: DFR_MEMORY_BASIS,
      ...(qualificationHold ? { qualificationHold: true as const } : {}),
    } : ltx25T2aSplitBf16 ? {
      memoryBasis: LTX25_SPLIT_BF16_T2A_MEMORY_BASIS,
    } : ltx25Ia2vCalibration ? {
      memoryBasis: LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_BASIS,
    } : {}),
  };
}

export function requiredStartMemoryForRequests(
  requests: readonly GenerationRequest[],
  gate: StartMemoryGate,
): number | null {
  if (requests.some((request) => request.mode === "lipdub")) return null;
  const largestEstimateGiB = requests.reduce(
    (largest, request) => Math.max(largest, estimateResources(request).memoryGiB),
    0,
  );
  return Math.max(
    gate.minAvailableGiB,
    largestEstimateGiB + gate.minResidualMemoryGiB,
  );
}
