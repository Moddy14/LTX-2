import type { ControlledExperiment } from "../shared/experiments.js";
import type { QueueJobState, QueueListResponse } from "./admission.js";
import { ExperimentConflictError } from "./experimentStore.js";

export const activeRemoteQueueStates = new Set<QueueJobState>([
  "submitted",
  "accepted",
  "queued",
  "starting",
  "running",
  "pausing",
  "paused",
  "resuming",
]);

const RETRYABLE_JOB_STATUSES = new Set(["failed", "cancelled", "interrupted"]);

export type ExperimentArmRetryDeps = {
  getJob: (jobId: string) => { status: string; dgxJobId: string | null } | undefined;
  hasVerifiedArmOutput: (experiment: ControlledExperiment, arm: "baseline" | "candidate") => boolean;
  listRemoteJobs: () => Promise<QueueListResponse>;
  releaseArm: (
    experimentId: string,
    arm: "baseline" | "candidate",
    previousJobId: string,
  ) => ControlledExperiment;
};

export async function releaseRetryableExperimentArm(
  experiment: ControlledExperiment,
  arm: "baseline" | "candidate",
  deps: ExperimentArmRetryDeps,
): Promise<ControlledExperiment> {
  const selected = experiment.arms[arm === "baseline" ? 0 : 1];
  if (!selected.jobId) return experiment;
  const previous = deps.getJob(selected.jobId);
  if (previous && !RETRYABLE_JOB_STATUSES.has(previous.status)) return experiment;
  // A pruned job history must not block the retry: only a verified output for
  // this exact frozen arm proves the vanished job completed its run.
  if (!previous && deps.hasVerifiedArmOutput(experiment, arm)) return experiment;

  let remoteJobs;
  try {
    remoteJobs = (await deps.listRemoteJobs()).jobs;
  } catch {
    throw new ExperimentConflictError(
      "Der frühere Experimentlauf ist terminal, aber sein DGX-Queue-Zustand kann nicht sicher geprüft werden.",
    );
  }
  const remote = previous?.dgxJobId
    ? remoteJobs.find((job) => job.job_id === previous.dgxJobId)
    : remoteJobs.find((job) => job.requested_by === `ltx-studio:${selected.jobId}`);
  if (remote && activeRemoteQueueStates.has(remote.state)) {
    throw new ExperimentConflictError(
      `Der frühere Experimentlauf besitzt noch den aktiven DGX-Queue-Job ${remote.job_id} (${remote.state}).`,
    );
  }
  return deps.releaseArm(experiment.id, arm, selected.jobId);
}
