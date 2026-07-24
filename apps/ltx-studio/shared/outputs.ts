import type { GenerationRequest } from "./pipelines.js";
import type { JobQualityReview } from "./quality.js";

export type StudioOutput = {
  name: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  jobId: string | null;
  jobStatus: "completed" | "external";
  request: GenerationRequest | null;
  settingsAvailable: boolean;
  qualityReview: JobQualityReview | null;
};
