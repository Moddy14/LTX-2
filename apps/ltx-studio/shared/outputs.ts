import type { GenerationRequest } from "./pipelines.js";
import type { JobQualityReview } from "./quality.js";
import type { OutputAnalysisRecord } from "./objectiveQuality.js";
import type { RunProvenance } from "./provenance.js";
import type { ExperimentRunBinding } from "./experiments.js";
import type { ProjectRunBinding } from "./projects.js";
import type { JobExecutionDecision } from "./jobExecution.js";

export type StudioOutput = {
  name: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  changedAt: string;
  fileId: string;
  jobId: string | null;
  jobStatus: "completed" | "external";
  request: GenerationRequest | null;
  settingsAvailable: boolean;
  qualityReview: JobQualityReview | null;
  analysis: OutputAnalysisRecord | null;
  provenance?: RunProvenance | null;
  experiment?: ExperimentRunBinding | null;
  project?: ProjectRunBinding | null;
  executionDecision?: JobExecutionDecision | null;
  experimentRequestVerified?: boolean;
  /** Explicitly separates modern publication authority from preserved pre-v1.1 history. */
  trustStatus?: "verified-publication" | "legacy-unattested";
};

export type DeletedStudioOutput = {
  name: string;
  sizeBytes: number;
  deletedArtifacts: string[];
};
