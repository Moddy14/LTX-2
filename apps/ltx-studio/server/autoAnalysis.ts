import type { GenerationRequest } from "../shared/pipelines.js";
import type { JobStatus } from "./jobs.js";
import { supportsSpeechQuality } from "./outputs.js";

type AnalysisJobSignal = {
  status: JobStatus;
  request: GenerationRequest;
};

export function shouldAutoAnalyzeCompletedJob(
  previousStatus: JobStatus | undefined,
  job: AnalysisJobSignal,
): boolean {
  return previousStatus !== "completed"
    && job.status === "completed"
    && supportsSpeechQuality(job.request);
}
