import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

import type { StudioJob } from "../server/jobs.js";
import {
  persistOutputPublicationAuthority,
  prepareOutputPublicationAuthority,
  terminalJobAuthoritySha256,
} from "../server/outputPublication.js";
import { bindRunExecutionDecision } from "../server/runProvenance.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import type { RunProvenance } from "../shared/provenance.js";

function baseRunProvenance(): RunProvenance {
  return {
    schemaVersion: "ltx-studio-run-provenance.v1",
    capturedAt: "2026-08-15T12:00:00.000Z",
    verifiedAt: "2026-08-15T12:00:30.000Z",
    files: [],
    code: [{
      repositoryRoot: "/repo",
      commit: "a".repeat(40),
      dirty: false,
      trackedDiffSha256: "b".repeat(64),
      untracked: [],
      fingerprint: "c".repeat(64),
    }],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "test",
      nodeVersion: "test",
      pythonExecutable: "/python",
      pythonVersion: "test",
      packages: {},
      ffmpegVersion: "test",
      fingerprint: "d".repeat(64),
    },
    fingerprint: "e".repeat(64),
  };
}

/** Gives test output bytes the same v5 decision and job-bound marker required in production. */
export function publishCompletedOutputFixture(root: string, job: StudioJob): void {
  if (job.status !== "completed" || !job.finishedAt) {
    throw new Error("Publication fixture requires a terminal completed job.");
  }
  const decision = job.executionDecision ?? {
    schemaVersion: "ltx-studio-execution-decision.v5" as const,
    executionClass: "dgx" as const,
    decidedAt: job.startedAt ?? job.createdAt,
    reason: "Test fixture DGX decision persisted before publication.",
    requestSha256: createHash("sha256").update(canonicalJson(job.request)).digest("hex"),
    protocolSha256: job.experiment?.protocolSha256 ?? null,
    cpuReuse: null,
    operation: null,
  };
  if (decision.executionClass === "pending") {
    throw new Error("Publication fixture cannot publish a pending decision.");
  }
  job.executionClass = decision.executionClass;
  job.executionDecision = decision;
  job.runProvenance = bindRunExecutionDecision(job.runProvenance ?? baseRunProvenance(), decision);
  const executionDecisionSha256 = createHash("sha256").update(canonicalJson(decision)).digest("hex");
  const jobPersistenceRevision = randomUUID();
  const jobAuthoritySha256 = terminalJobAuthoritySha256({
    jobId: job.id,
    status: "completed",
    outputName: job.outputName,
    finishedAt: job.finishedAt,
    executionClass: decision.executionClass,
    executionDecisionSha256,
    requestSha256: decision.requestSha256,
    protocolSha256: decision.protocolSha256,
    jobPersistenceRevision,
  });
  job.outputPublication = prepareOutputPublicationAuthority(join(root, job.outputName), {
    jobId: job.id,
    publishedAt: job.finishedAt,
    executionDecisionSha256,
    jobPersistenceRevision,
    jobAuthoritySha256,
  });
  persistOutputPublicationAuthority(join(root, job.outputName), {
    jobId: job.id,
    publishedAt: job.finishedAt,
    executionDecisionSha256,
    jobPersistenceRevision,
    jobAuthoritySha256,
  }, {}, job.outputPublication);
}
