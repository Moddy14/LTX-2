import type { GenerationRequest } from "./pipelines.js";

export type StudioOutput = {
  name: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  jobId: string | null;
  jobStatus: "completed" | "external";
  request: GenerationRequest | null;
  settingsAvailable: boolean;
};
