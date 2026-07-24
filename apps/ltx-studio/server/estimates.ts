import { estimateResources, requestComputeUnits, type ResourceEstimate } from "../shared/estimates.js";
import type { GenerationRequest } from "../shared/pipelines.js";
import type { StudioJob } from "./jobs.js";
import * as mediaProbe from "./mediaProbe.js";

function snapFramesTo8k1(frames: number): number {
  return Math.max(1, Math.floor((Math.max(1, frames) - 1) / 8) * 8 + 1);
}

function requestWithReferenceVideoSizing(request: GenerationRequest): GenerationRequest {
  if (request.mode !== "lipdub") return request;
  const metadata = mediaProbe.probeVideoMetadata(request.lipDub.referenceVideo.path);
  if (!metadata) return request;
  const fps = metadata.fps ?? request.frameRate;
  const frames = metadata.frames
    ?? (metadata.durationSeconds !== null && fps > 0 ? Math.round(metadata.durationSeconds * fps) : null);
  if (frames === null || frames <= 0 || fps <= 0) return request;
  return {
    ...request,
    frameRate: fps,
    numFrames: snapFramesTo8k1(frames),
    longClipAcknowledged: true,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function estimateRequest(
  request: GenerationRequest,
  jobs: readonly Pick<StudioJob, "status" | "mode" | "runtimeMs" | "request">[],
): ResourceEstimate {
  const sizedRequest = requestWithReferenceVideoSizing(request);
  const base = estimateResources(sizedRequest);
  const samples = jobs.filter((job) =>
    job.status === "completed" && job.mode === request.mode && job.runtimeMs !== null && job.runtimeMs > 0,
  );
  if (samples.length < 2) return { ...base, etaSamples: samples.length };
  const targetUnits = requestComputeUnits(sizedRequest);
  const normalizedSeconds = samples.map((job) =>
    (job.runtimeMs! / 1_000) * (targetUnits / requestComputeUnits(requestWithReferenceVideoSizing(job.request))),
  );
  return {
    ...base,
    etaSeconds: Math.max(1, Math.round(median(normalizedSeconds))),
    etaSamples: samples.length,
  };
}
