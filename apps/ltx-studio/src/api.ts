import type { GenerationRequest } from "../shared/pipelines";
import type { QualityReviewInput } from "../shared/quality";
import type { OutputAnalysisRecord } from "../shared/objectiveQuality";
import type {
  LipDubReferenceDiagnostics,
  PlanSuggestion,
  PreparedLipDubReference,
} from "../shared/plan";
import {
  ApiError,
  type AssetKind,
  type Health,
  type ModelInventory,
  type ResourceEstimate,
  type StudioAsset,
  type StudioConfig,
  type StudioJob,
  type StudioOutput,
  type UploadedFile,
} from "./types";

async function decode<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { error?: string; issues?: { path: string; message: string }[] } & T;
  if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`, body.issues ?? []);
  return body;
}

export async function getConfig(): Promise<StudioConfig> {
  return decode<StudioConfig>(await fetch("/api/config"));
}

export async function getHealth(): Promise<Health> {
  return decode<Health>(await fetch("/api/health"));
}

export async function getJobs(): Promise<StudioJob[]> {
  const body = await decode<{ jobs: StudioJob[] }>(await fetch("/api/jobs"));
  return body.jobs;
}

export async function getOutputs(): Promise<StudioOutput[]> {
  const body = await decode<{ outputs: StudioOutput[] }>(await fetch("/api/outputs"));
  return body.outputs;
}

export async function getModels(refresh = false): Promise<ModelInventory> {
  return decode<ModelInventory>(await fetch(`/api/models${refresh ? "?refresh=1" : ""}`));
}

export async function getEstimate(request: GenerationRequest): Promise<ResourceEstimate> {
  return decode<ResourceEstimate>(
    await fetch("/api/estimates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}

export async function createJob(request: GenerationRequest): Promise<StudioJob> {
  const body = await decode<{ job: StudioJob }>(
    await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
  return body.job;
}

export async function planJob(
  request: GenerationRequest,
): Promise<{
  command: string;
  outputPath: string;
  pathErrors: string[];
  pathWarnings: string[];
  suggestions?: PlanSuggestion[];
}> {
  return decode(
    await fetch("/api/jobs/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}

export async function cancelJob(id: string): Promise<StudioJob> {
  const body = await decode<{ job: StudioJob }>(await fetch(`/api/jobs/${id}/cancel`, { method: "POST" }));
  return body.job;
}

export async function rerunJob(id: string, mode: "exact" | "random-seed"): Promise<StudioJob> {
  const body = await decode<{ job: StudioJob }>(
    await fetch(`/api/jobs/${id}/rerun`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  );
  return body.job;
}

export async function setJobFavorite(id: string, favorite: boolean): Promise<StudioJob> {
  const body = await decode<{ job: StudioJob }>(
    await fetch(`/api/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorite }),
    }),
  );
  return body.job;
}

export async function setOutputQualityReview(outputName: string, input: QualityReviewInput): Promise<StudioOutput> {
  const body = await decode<{ output: StudioOutput }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}/quality-review`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.output;
}

export async function startOutputAnalysis(outputName: string, force = false): Promise<OutputAnalysisRecord> {
  const body = await decode<{ analysis: OutputAnalysisRecord }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}/analysis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    }),
  );
  return body.analysis;
}

export async function cancelOutputAnalysis(outputName: string, analysisId: string): Promise<OutputAnalysisRecord> {
  const body = await decode<{ analysis: OutputAnalysisRecord }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}/analysis/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId }),
    }),
  );
  return body.analysis;
}

export async function uploadFile(kind: UploadedFile["kind"], file: File): Promise<UploadedFile> {
  const data = new FormData();
  data.append("file", file);
  return decode<UploadedFile>(await fetch(`/api/uploads/${kind}`, { method: "POST", body: data }));
}

export async function getAssets(kind?: AssetKind): Promise<StudioAsset[]> {
  const body = await decode<{ assets: StudioAsset[] }>(
    await fetch(`/api/assets${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`),
  );
  return body.assets;
}

export async function inspectLipDubReference(input: {
  path: string;
  width: number;
  height: number;
  dialogue: string;
  prompt: string;
}): Promise<LipDubReferenceDiagnostics> {
  return decode<LipDubReferenceDiagnostics>(
    await fetch("/api/lipdub/reference/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function prepareLipDubReference(
  request: GenerationRequest,
  trim?: { startSeconds: number; durationSeconds: number },
): Promise<PreparedLipDubReference> {
  return decode<PreparedLipDubReference>(
    await fetch("/api/lipdub/reference/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, trim }),
    }),
  );
}
