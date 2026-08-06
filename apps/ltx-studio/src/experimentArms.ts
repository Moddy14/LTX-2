import type { StudioJob, StudioOutput } from "./types.js";

// A bound arm stays retryable when its job vanished from the pruned history,
// unless a verified output proves the run completed; the server re-checks the
// DGX queue before actually releasing the arm.
export function armRetryable(
  arm: { jobId: string | null },
  job: StudioJob | undefined,
  verifiedOutput: StudioOutput | undefined,
): boolean {
  if (!arm.jobId) return false;
  if (job) return ["failed", "cancelled", "interrupted"].includes(job.status);
  return !verifiedOutput;
}
