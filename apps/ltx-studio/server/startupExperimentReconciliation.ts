import type { StudioJob } from "./jobs.js";

type StartupJobManager = {
  list(): StudioJob[];
  reconcileRestoredRemoteAuthority(timeoutMs?: number): Promise<void>;
  shutdown(timeoutMs?: number): Promise<{
    remotePending: number;
    localPending: number;
  }>;
};

type StartupExperimentStore = {
  reconcileJobs(jobs: readonly StudioJob[]): void;
};

/**
 * Experiment reconciliation is a synchronous integrity gate, while restored
 * remote-lease cancellation is asynchronous. Never let a protocol error tear
 * down the process before JobManager has durably delivered its cleanup.
 */
export function reconcileExperimentsBeforeServerStart(
  jobs: StartupJobManager,
  experiments: StartupExperimentStore,
  cleanupTimeoutMs = 140_000,
): Promise<never> | null {
  try {
    experiments.reconcileJobs(jobs.list());
    return null;
  } catch (reconciliationError) {
    return (async () => {
      let cleanup;
      let preShutdownCleanupError: unknown = null;
      try {
        await jobs.reconcileRestoredRemoteAuthority(cleanupTimeoutMs);
      } catch (error) {
        preShutdownCleanupError = error;
      }
      try {
        cleanup = await jobs.shutdown(cleanupTimeoutMs);
      } catch (cleanupError) {
        throw new AggregateError(
          [reconciliationError, ...(preShutdownCleanupError ? [preShutdownCleanupError] : []), cleanupError],
          "Experiment-Reconciliation schlug fehl und der Remote-Cleanup konnte nicht bestätigt werden.",
        );
      }
      if (cleanup.remotePending > 0 || cleanup.localPending > 0) {
        throw new AggregateError(
          [reconciliationError, ...(preShutdownCleanupError ? [preShutdownCleanupError] : [])],
          `Experiment-Reconciliation schlug fehl; ${cleanup.remotePending} Remote- und `
            + `${cleanup.localPending} lokale Cleanup-Aktion(en) bleiben dauerhaft vorgemerkt.`,
        );
      }
      if (preShutdownCleanupError) {
        throw new AggregateError(
          [reconciliationError, preShutdownCleanupError],
          "Experiment-Reconciliation schlug fehl; der nachfolgende Shutdown-Cleanup wurde bestätigt.",
        );
      }
      throw reconciliationError;
    })();
  }
}
