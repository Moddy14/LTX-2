import type { GenerationRequest, PipelineDefinition } from "../shared/pipelines";
import type { StudioAsset } from "../shared/assets";
export type { StudioOutput } from "../shared/outputs";
export type { ResourceEstimate } from "../shared/estimates";
export type { ModelInventory, ModelInventoryItem, ModelKind } from "../shared/models";

export type Health = {
  state: "ready" | "blocked";
  resources: {
    availableMemoryGiB: number | null;
    totalMemoryGiB: number | null;
    swapFreeGiB: number | null;
    swapTotalGiB: number | null;
    outputFreeGiB: number | null;
  };
  engine: "available" | "missing";
  orchestrator: "available" | "missing" | "disabled";
  qwen: "ready" | "busy" | "offline";
  runtimeOverall: string;
  workloads: Array<{
    id: "qwen" | "avatar" | "comfyui";
    label: string;
    state: string;
    protected: boolean;
    estimatedMemoryGiB: number | null;
  }>;
  queueDepth: number;
};

export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";

export type StudioJob = {
  id: string;
  status: JobStatus;
  mode: GenerationRequest["mode"];
  prompt: string;
  outputName: string;
  outputUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: number | null;
  error: string | null;
  logs: string[];
  command: string;
  request: GenerationRequest;
  favorite: boolean;
  variantOf: string | null;
  runtimeMs: number | null;
  cancelledBy: "studio" | null;
  dgxJobId: string | null;
  thermalProfile: {
    baselineC: number;
    currentC: number | null;
    peakC: number;
    riseC: number;
    pauseAtC: number;
    resumeBelowC: number;
    updatedAt: string;
  } | null;
};

export type StudioConfig = {
  pipelines: PipelineDefinition[];
  runtime: {
    minAvailableGiB: number;
    minResidualMemoryGiB: number;
    minSwapFreeGiB: number;
    outputRoot: string;
    maxUploadGiB: number;
    admissionRequired: boolean;
  };
};

export type UploadedFile = StudioAsset;
export type { AssetKind, StudioAsset } from "../shared/assets";

export type ApiIssue = { path: string; message: string };

export class ApiError extends Error {
  issues: ApiIssue[];

  constructor(message: string, issues: ApiIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.issues = issues;
  }
}
