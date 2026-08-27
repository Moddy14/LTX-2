import type { ProjectRevisionEnvelope } from "../shared/projects.js";

export type LegacyMutationAuthority = {
  assertHistoricalOutputReferenceMutationAllowed: (jobId: string, outputName: string) => void;
};

export function assertProjectOutputReferenceMutationAllowed(
  project: ProjectRevisionEnvelope | null,
  outputId: string,
  authority: LegacyMutationAuthority,
): void {
  const evidence = project?.project.shots
    .flatMap((shot) => shot.outputHistory)
    .find((output) => output.id === outputId);
  if (!evidence) return;
  authority.assertHistoricalOutputReferenceMutationAllowed(evidence.jobId, evidence.outputName);
}

/**
 * Resolve every historical medium that grants the current shot either visual
 * continuity or retake authority. Imported legacy evidence remains readable,
 * but the caller's authority callbacks must reject it before a new run.
 */
export function assertProjectRunSourcesMutationAllowed(
  project: ProjectRevisionEnvelope | null,
  shotId: string,
  authority: LegacyMutationAuthority,
): void {
  const shot = project?.project.shots.find((candidate) => candidate.id === shotId);
  if (!shot) return;
  if (shot.continuity) {
    assertProjectOutputReferenceMutationAllowed(
      project,
      shot.continuity.referenceOutputId,
      authority,
    );
  }
  const currentRequest = shot.requestRevisions.find(({ id }) => id === shot.currentRequestRevisionId);
  if (currentRequest?.sourceOutputId) {
    assertProjectOutputReferenceMutationAllowed(project, currentRequest.sourceOutputId, authority);
  }
}
