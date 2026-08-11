import type { AdmissionPreflightReport } from "../shared/admissionPreflight";
import type { GenerationRequest } from "../shared/pipelines";
import type { QualityReviewInput } from "../shared/quality";
import type { OutputAnalysisRecord } from "../shared/objectiveQuality";
import type { DeletedStudioOutput } from "../shared/outputs";
import type {
  ControlledExperiment,
  ExperimentCreateInput,
} from "../shared/experiments";
import type {
  ProjectArchiveRequest,
  ProjectCreateRequest,
  ProjectOutputApprovalRequest,
  ProjectOutputCaptureRequest,
  ProjectRevisionEnvelope,
  ProjectRunBinding,
  ProjectRunRequest,
  ProjectShotCreateRequest,
  ProjectShotRevisionRequest,
} from "../shared/projects";
import type {
  LipDubReferenceDiagnostics,
  PlanSuggestion,
  PreparedImageCrop,
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

export async function deleteOutput(outputName: string): Promise<DeletedStudioOutput> {
  const body = await decode<{ deleted: DeletedStudioOutput }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}`, { method: "DELETE" }),
  );
  return body.deleted;
}

export async function getExperiments(): Promise<{
  experiments: ControlledExperiment[];
  warnings: string[];
}> {
  return decode<{ experiments: ControlledExperiment[]; warnings: string[] }>(await fetch("/api/experiments"));
}

export async function getProjects(): Promise<{
  projects: ProjectRevisionEnvelope[];
  warnings: string[];
}> {
  return decode<{ projects: ProjectRevisionEnvelope[]; warnings: string[] }>(await fetch("/api/projects"));
}

export async function getProjectHistory(id: string): Promise<ProjectRevisionEnvelope[]> {
  const body = await decode<{ revisions: ProjectRevisionEnvelope[] }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/history`),
  );
  return body.revisions;
}

export async function createProject(input: ProjectCreateRequest): Promise<ProjectRevisionEnvelope> {
  const body = await decode<{ project: ProjectRevisionEnvelope }>(
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function addProjectShot(
  id: string,
  input: ProjectShotCreateRequest,
): Promise<ProjectRevisionEnvelope> {
  const body = await decode<{ project: ProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function reviseProjectShot(
  id: string,
  shotId: string,
  input: ProjectShotRevisionRequest,
): Promise<ProjectRevisionEnvelope> {
  const body = await decode<{ project: ProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function captureProjectShotOutput(
  id: string,
  shotId: string,
  input: ProjectOutputCaptureRequest,
): Promise<ProjectRevisionEnvelope> {
  const body = await decode<{ project: ProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/outputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function launchProjectShot(
  id: string,
  shotId: string,
  input: ProjectRunRequest,
): Promise<{ project: ProjectRunBinding; job: StudioJob }> {
  return decode<{ project: ProjectRunBinding; job: StudioJob }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function approveProjectShotOutput(
  id: string,
  shotId: string,
  input: ProjectOutputApprovalRequest,
): Promise<ProjectRevisionEnvelope> {
  const body = await decode<{ project: ProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function archiveProject(
  id: string,
  input: ProjectArchiveRequest,
): Promise<ProjectRevisionEnvelope> {
  const body = await decode<{ project: ProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function createExperiment(input: ExperimentCreateInput): Promise<ControlledExperiment> {
  const body = await decode<{ experiment: ControlledExperiment }>(
    await fetch("/api/experiments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.experiment;
}

export async function freezeExperiment(id: string): Promise<ControlledExperiment> {
  const body = await decode<{ experiment: ControlledExperiment }>(
    await fetch(`/api/experiments/${id}/freeze`, { method: "POST" }),
  );
  return body.experiment;
}

export async function supersedeExperiment(
  id: string,
  reason: string,
  replacementExperimentId: string | null = null,
): Promise<ControlledExperiment> {
  const body = await decode<{ experiment: ControlledExperiment }>(
    await fetch(`/api/experiments/${id}/supersede`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, replacementExperimentId }),
    }),
  );
  return body.experiment;
}

export async function launchExperimentArm(
  id: string,
  arm: "baseline" | "candidate",
): Promise<{ experiment: ControlledExperiment; job: StudioJob }> {
  return decode<{ experiment: ControlledExperiment; job: StudioJob }>(
    await fetch(`/api/experiments/${id}/runs/${arm}`, { method: "POST" }),
  );
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

export async function preflightAdmission(request: GenerationRequest): Promise<AdmissionPreflightReport> {
  return decode<AdmissionPreflightReport>(
    await fetch("/api/admission/preflight", {
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

export async function deleteJob(id: string): Promise<StudioJob> {
  const body = await decode<{ deleted: StudioJob }>(
    await fetch(`/api/jobs/${id}`, { method: "DELETE" }),
  );
  return body.deleted;
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

export async function takeOutputFrame(output: string, atSeconds: number): Promise<StudioAsset> {
  const body = await decode<{ asset: StudioAsset }>(
    await fetch("/api/images/from-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output, atSeconds }),
    }),
  );
  return body.asset;
}

export type RecommendedOutputFrame = {
  asset: StudioAsset;
  recommendation: {
    atSeconds: number;
    score: number;
    sampledFrames: number;
    eligibleFrames: number;
    metrics: {
      faceSharpness: number;
      faceAreaRatio: number;
      faceConfidence: number;
      stability: number;
      exposure: number;
      frontalness: number;
      prominentFaceCount: number;
    };
  };
};

export async function takeRecommendedOutputFrame(output: string): Promise<RecommendedOutputFrame> {
  return decode<RecommendedOutputFrame>(
    await fetch("/api/images/from-output", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ output, strategy: "best-face" }),
    }),
  );
}

export async function prepareImageCrop(input: {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
}): Promise<PreparedImageCrop> {
  return decode<PreparedImageCrop>(
    await fetch("/api/images/crop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function inspectLipDubReference(input: {
  path: string;
  width: number;
  height: number;
  dialogue: string;
  prompt: string;
  pipelineProfile: GenerationRequest["lipDub"]["pipelineProfile"];
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
