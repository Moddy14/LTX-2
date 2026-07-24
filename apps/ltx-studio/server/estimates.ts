import { estimateResources, requestComputeUnits, type ResourceEstimate } from "../shared/estimates.js";
import type { GenerationRequest } from "../shared/pipelines.js";
import type { StudioJob } from "./jobs.js";

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function estimateRequest(
  request: GenerationRequest,
  jobs: readonly Pick<StudioJob, "status" | "mode" | "runtimeMs" | "request">[],
): ResourceEstimate {
  const base = estimateResources(request);
  const samples = jobs.filter((job) =>
    job.status === "completed" && job.mode === request.mode && job.runtimeMs !== null && job.runtimeMs > 0,
  );
  if (samples.length < 2) return { ...base, etaSamples: samples.length };
  const targetUnits = requestComputeUnits(request);
  const normalizedSeconds = samples.map((job) =>
    (job.runtimeMs! / 1_000) * (targetUnits / requestComputeUnits(job.request)),
  );
  return {
    ...base,
    etaSeconds: Math.max(1, Math.round(median(normalizedSeconds))),
    etaSamples: samples.length,
  };
}
