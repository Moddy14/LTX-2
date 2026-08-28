import { canonicalJson } from "../shared/canonicalJson.js";
import {
  publicExecutionDecisionSummarySchema,
  publicRunProvenanceSummarySchema,
  type PublicExecutionDecisionSummary,
  type PublicRunProvenanceSummary,
} from "../shared/jobPublic.js";
import type {
  PublicExperimentRunSummary,
  PublicProjectRunSummary,
} from "../shared/outputPublic.js";
import {
  normalizeJobExecutionDecision,
  type JobExecutionDecision,
} from "../shared/jobExecution.js";
import type { RunProvenance } from "../shared/provenance.js";
import type { StudioJob } from "./jobs.js";
import {
  toPublicExperimentRunSummary,
  toPublicProjectRunSummary,
} from "./publicOutput.js";
import { normalizePublicDgxMemoryWait } from "../shared/dgxMemoryWait.js";

export type PublicStudioJob = Omit<
  StudioJob,
  | "identityEvidence"
  | "runProvenance"
  | "executionDecision"
  | "outputPublication"
  | "experiment"
  | "project"
> & {
  experiment: PublicExperimentRunSummary | null;
  project: PublicProjectRunSummary | null;
  runProvenanceSummary: PublicRunProvenanceSummary | null;
  executionDecisionSummary: PublicExecutionDecisionSummary | null;
};

const MAX_PUBLIC_REASON_LENGTH = 240;

function publicReason(reason: string): string {
  const withoutControlCharacters = Array.from(reason, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f ? " " : character;
  }).join("");
  const normalized = withoutControlCharacters
    .replace(/(^|[\s('"`])\/[\w@%+.,:=~-]+(?:\/[\w@%+.,:=~-]+)+/g, "$1<redacted-path>")
    .replace(/\b[0-9a-f]{64}\b/gi, "<redacted-digest>")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = normalized.slice(0, MAX_PUBLIC_REASON_LENGTH).trim();
  return bounded || "Interne Ausführungsentscheidung vorhanden.";
}

function summarizeRunProvenance(
  provenance: RunProvenance | null,
): PublicRunProvenanceSummary | null {
  if (!provenance) return null;
  return publicRunProvenanceSummarySchema.parse({
    schemaVersion: "ltx-studio-public-run-provenance-summary.v1",
    status: provenance.verifiedAt ? "verified" : "captured-unverified",
    capturedAt: provenance.capturedAt,
    verifiedAt: provenance.verifiedAt,
    release: provenance.release
      ? { sealed: provenance.release.sealed, verified: provenance.release.verified }
      : null,
  });
}

function decisionMatchesVerifiedProvenance(
  decision: JobExecutionDecision,
  provenance: RunProvenance | null,
): boolean {
  const bound = provenance?.verifiedAt && provenance.executionDecision
    ? normalizeJobExecutionDecision(provenance.executionDecision)
    : null;
  return Boolean(bound && canonicalJson(bound) === canonicalJson(decision));
}

function summarizeExecutionDecision(
  rawDecision: JobExecutionDecision | undefined,
  provenance: RunProvenance | null,
): PublicExecutionDecisionSummary | null {
  const decision = normalizeJobExecutionDecision(rawDecision);
  if (!decision) return null;
  return publicExecutionDecisionSummarySchema.parse({
    schemaVersion: "ltx-studio-public-execution-decision-summary.v1",
    executionClass: decision.executionClass,
    decidedAt: decision.decidedAt,
    reason: publicReason(decision.reason),
    verificationStatus: decision.executionClass === "pending"
      ? "pending"
      : decisionMatchesVerifiedProvenance(decision, provenance) ? "verified" : "unverified",
    cpuReuse: decision.executionClass === "cpu-only"
      ? {
          baselineLabel: decision.cpuReuse.baselineOutputName,
          operationKind: decision.operation.kind,
          sourceProgramAudioDelayMs: decision.operation.kind === "ffmpeg-audio-retime"
            && !("reuseKind" in decision.cpuReuse)
            ? decision.cpuReuse.sourceProgramAudioDelayMs
            : null,
          appliedDeltaMs: decision.operation.kind === "ffmpeg-audio-retime"
            ? decision.operation.deltaMs
            : null,
          operationState: decision.operation.state,
          preparedAt: decision.operation.preparedAt,
          startedAt: decision.operation.startedAt,
          completedAt: decision.operation.completedAt,
        }
      : null,
  });
}

/**
 * Explicit API/SSE allowlist. Never spread a StudioJob across a trust boundary.
 *
 * Request, command and logs intentionally remain local operator data required
 * by the single-user Studio UI and can contain configured model/upload/output
 * paths. They are not authority documents. The security boundary here is that
 * held-FD snapshots, stat identities and artifact digests from internal
 * ExecutionDecision/RunProvenance records can only cross through the strict,
 * non-authoritative summaries above.
 */
export function toPublicStudioJob(job: StudioJob): PublicStudioJob {
  const dgxMemoryWait = normalizePublicDgxMemoryWait(job.dgxMemoryWait);
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    prompt: job.prompt,
    outputName: job.outputName,
    outputUrl: job.outputUrl,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    progress: job.progress,
    error: job.error,
    logs: [...job.logs],
    command: job.command,
    request: structuredClone(job.request),
    favorite: job.favorite,
    variantOf: job.variantOf,
    experiment: job.experiment ? toPublicExperimentRunSummary(job.experiment) : null,
    project: job.project ? toPublicProjectRunSummary(job.project) : null,
    runtimeMs: job.runtimeMs,
    cancelledBy: job.cancelledBy,
    cancellationState: job.cancellationState ?? null,
    thermalProfile: job.thermalProfile ? structuredClone(job.thermalProfile) : null,
    dgxJobId: job.dgxJobId,
    dgxMemoryWait,
    historyStatus: job.historyStatus,
    historicalDgxJobId: job.historicalDgxJobId,
    executionClass: job.executionClass,
    runProvenanceSummary: summarizeRunProvenance(job.runProvenance),
    executionDecisionSummary: summarizeExecutionDecision(job.executionDecision, job.runProvenance),
  };
}

export function toPublicStudioJobs(jobs: readonly StudioJob[]): PublicStudioJob[] {
  return jobs.map(toPublicStudioJob);
}
