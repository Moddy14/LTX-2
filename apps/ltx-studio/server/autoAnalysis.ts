import type { GenerationRequest } from "../shared/pipelines.js";
import type { JobStatus } from "./jobs.js";
import { supportsSpeechQuality } from "./outputs.js";

type AnalysisJobSignal = {
  status: JobStatus;
  request: GenerationRequest;
};

export type AutomaticAnalysisKind = "video" | "t2a-audio";

export function shouldAutoAnalyzeCompletedJob(
  previousStatus: JobStatus | undefined,
  job: AnalysisJobSignal,
): boolean {
  return previousStatus !== "completed"
    && job.status === "completed"
    && supportsSpeechQuality(job.request);
}

export function shouldAutoAnalyzeCompletedT2aJob(
  previousStatus: JobStatus | undefined,
  job: AnalysisJobSignal,
): boolean {
  return previousStatus !== "completed"
    && job.status === "completed"
    && job.request.mode === "text-to-audio";
}

export function reconcileCompletedAnalysisTransitions<
  T extends AnalysisJobSignal & { id: string },
>(
  observedStatuses: Map<string, JobStatus>,
  jobs: readonly T[],
): Array<{ job: T; kind: AutomaticAnalysisKind }> {
  const transitions: Array<{ job: T; kind: AutomaticAnalysisKind }> = [];
  for (const job of jobs) {
    const previousStatus = observedStatuses.get(job.id);
    observedStatuses.set(job.id, job.status);
    if (shouldAutoAnalyzeCompletedT2aJob(previousStatus, job)) {
      transitions.push({ job, kind: "t2a-audio" });
    } else if (shouldAutoAnalyzeCompletedJob(previousStatus, job)) {
      transitions.push({ job, kind: "video" });
    }
  }
  return transitions;
}
