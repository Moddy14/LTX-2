import {
  supportsA2vGuidanceExperiment,
  supportsPositivePromptExperiment,
  type ControlledExperiment,
} from "../shared/experiments.js";
import {
  assertAuthoritativeQueueAbsence,
  assertAuthoritativeQueueList,
  type QueueJobState,
  type QueueListResponse,
} from "./admission.js";
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
  getJob: (jobId: string) => {
    status: string;
    dgxJobId: string | null;
    settlementPending?: boolean;
  } | undefined;
  hasVerifiedArmOutput: (experiment: ControlledExperiment, arm: "baseline" | "candidate") => boolean;
  listRemoteJobs: () => Promise<QueueListResponse>;
  releaseArm: (
    experimentId: string,
    arm: "baseline" | "candidate",
    previousJobId: string,
  ) => ControlledExperiment;
};

export type ExperimentArmRetryReadDeps = Omit<ExperimentArmRetryDeps, "releaseArm">;

/**
 * Read-only proof that the currently bound arm may be retried.
 *
 * Returning the previous job id is deliberately distinct from releasing the
 * arm.  Preflight can therefore inspect the exact same local/output/remote
 * evidence as launch without changing the frozen experiment or its audit
 * history.  Launch performs the release separately and rechecks the store-side
 * compare-and-swap before attaching a new job.
 */
export async function inspectRetryableExperimentArm(
  experiment: ControlledExperiment,
  arm: "baseline" | "candidate",
  deps: ExperimentArmRetryReadDeps,
): Promise<string | null> {
  if (
    experiment.candidate.variable === "a2v-guidance"
    && !supportsA2vGuidanceExperiment(experiment.arms[0].request)
  ) {
    throw new ExperimentConflictError(
      "Der historische IA2V-Guidance-Arm bleibt als Evidenz lesbar, darf aber nicht erneut gestartet werden: "
      + "der offizielle SimpleDenoiser-Vertrag konsumiert die kontrollierte Variable nicht.",
    );
  }
  if (
    experiment.candidate.variable === "positive-prompt"
    && !supportsPositivePromptExperiment(experiment.arms[0].request)
  ) {
    throw new ExperimentConflictError(
      "Der Positive-Beschreibung-Arm darf nicht erneut gestartet werden: "
      + "sein Request liegt außerhalb des freigegebenen LTX-2.5-Split-IA2V-Vertrags.",
    );
  }
  const selected = experiment.arms[arm === "baseline" ? 0 : 1];
  if (!selected.jobId) return null;
  const previous = deps.getJob(selected.jobId);
  if (previous && !RETRYABLE_JOB_STATUSES.has(previous.status)) return null;
  if (previous?.settlementPending) {
    throw new ExperimentConflictError(
      "Der frühere Experimentlauf ist lokal abgebrochen, aber seine Prozess-/DGX-Abschlussautorität ist noch nicht vollständig bestätigt.",
    );
  }
  // A verified output for this exact frozen arm proves that the attempt ran,
  // regardless of whether its local history entry is still present.
  if (deps.hasVerifiedArmOutput(experiment, arm)) return null;

  let remoteQueue: QueueListResponse;
  try {
    remoteQueue = await deps.listRemoteJobs();
    assertAuthoritativeQueueList(remoteQueue);
  } catch {
    throw new ExperimentConflictError(
      "Der frühere Experimentlauf ist terminal, aber sein DGX-Queue-Zustand kann nicht sicher geprüft werden.",
    );
  }
  const requestedBy = `ltx-studio:${selected.jobId}`;
  const activeRemotes = remoteQueue.jobs
    .filter((job) => activeRemoteQueueStates.has(job.state))
    .filter((job) => job.job_id === previous?.dgxJobId || job.requested_by === requestedBy)
    .sort((left, right) => left.job_id.localeCompare(right.job_id));
  const remote = activeRemotes[0];
  if (remote) {
    throw new ExperimentConflictError(
      `Der frühere Experimentlauf besitzt noch ${activeRemotes.length === 1 ? "den aktiven DGX-Queue-Job" : `${activeRemotes.length} aktive DGX-Queue-Jobs; zuerst`} ${remote.job_id} (${remote.state}).`,
    );
  }
  try {
    assertAuthoritativeQueueAbsence(remoteQueue);
  } catch {
    throw new ExperimentConflictError(
      "Der frühere Experimentlauf ist terminal, aber seine Abwesenheit ist bei belegter Queue-Lane nicht beweisbar.",
    );
  }
  return selected.jobId;
}

export async function releaseRetryableExperimentArm(
  experiment: ControlledExperiment,
  arm: "baseline" | "candidate",
  deps: ExperimentArmRetryDeps,
): Promise<ControlledExperiment> {
  const previousJobId = await inspectRetryableExperimentArm(experiment, arm, deps);
  if (!previousJobId) return experiment;
  return deps.releaseArm(experiment.id, arm, previousJobId);
}
