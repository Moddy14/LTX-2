import type { GenerationRequest, PipelineDefinition } from "../shared/pipelines.js";
import type { PublicStudioAsset } from "../shared/assetPublic.js";
import type { PublicHealth } from "../shared/healthPublic.js";
import type { JobExecutionClass } from "../shared/jobExecution.js";
import type { PublicDgxMemoryWait } from "../shared/dgxMemoryWait.js";
import type {
  PublicExecutionDecisionSummary,
  PublicRunProvenanceSummary,
} from "../shared/jobPublic.js";
import type {
  PublicExperimentRunSummary,
  PublicProjectRunSummary,
} from "../shared/outputPublic.js";
export type { PublicStudioOutput as StudioOutput } from "../shared/outputPublic.js";
export type { ResourceEstimate } from "../shared/estimates.js";
export type {
  PublicModelInventory as ModelInventory,
  PublicModelInventoryItem as ModelInventoryItem,
} from "../shared/modelPublic.js";
export type { ModelKind } from "../shared/models.js";

export type Health = PublicHealth;

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
  experiment: PublicExperimentRunSummary | null;
  project: PublicProjectRunSummary | null;
  runtimeMs: number | null;
  cancelledBy: "studio" | null;
  /** Backend-proven cancellation settlement; missing only for legacy/stub data. */
  cancellationState?: "requested" | "settling" | "settled" | null;
  dgxJobId: string | null;
  dgxMemoryWait?: PublicDgxMemoryWait | null;
  thermalProfile: {
    baselineC: number;
    currentC: number | null;
    peakC: number;
    riseC: number;
    pauseAtC: number;
    resumeBelowC: number;
    updatedAt: string;
  } | null;
  runProvenanceSummary: PublicRunProvenanceSummary | null;
  /** Missing means legacy history and must remain visibly unclassified. */
  executionClass?: JobExecutionClass;
  executionDecisionSummary: PublicExecutionDecisionSummary | null;
  historyStatus?: "legacy-unattested";
  historicalDgxJobId?: string | null;
};

export type StudioConfig = {
  pipelines: PipelineDefinition[];
  features?: {
    qualityGuidedSceneReference?: boolean;
  };
  runtime: {
    minAvailableGiB: number;
    minResidualMemoryGiB: number;
    minSwapFreeGiB: number;
    outputRoot: string;
    maxUploadGiB: number;
    admissionRequired: boolean;
  };
};

export type UploadedFile = PublicStudioAsset;
export type { AssetKind } from "../shared/assets.js";
export type StudioAsset = PublicStudioAsset;

export type ApiIssue = { path: string; message: string };

export class ApiError extends Error {
  issues: ApiIssue[];

  constructor(message: string, issues: ApiIssue[] = []) {
    super(message);
    this.name = "ApiError";
    this.issues = issues;
  }
}
