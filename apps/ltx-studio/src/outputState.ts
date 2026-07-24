import type { StudioOutput } from "../shared/outputs.js";

function sameOutputRevision(left: StudioOutput, right: StudioOutput): boolean {
  return left.name === right.name
    && left.sizeBytes === right.sizeBytes
    && left.modifiedAt === right.modifiedAt
    && left.jobId === right.jobId
    && left.settingsAvailable === right.settingsAvailable;
}

export function mergeOutputRefresh(
  current: readonly StudioOutput[],
  incoming: readonly StudioOutput[],
): StudioOutput[] {
  const currentByName = new Map(current.map((output) => [output.name, output]));
  return incoming.map((next) => {
    const previous = currentByName.get(next.name);
    if (!previous?.qualityReview || !sameOutputRevision(previous, next)) return next;
    const previousUpdatedAt = Date.parse(previous.qualityReview.updatedAt);
    const nextUpdatedAt = next.qualityReview ? Date.parse(next.qualityReview.updatedAt) : Number.NEGATIVE_INFINITY;
    return previousUpdatedAt > nextUpdatedAt
      ? { ...next, qualityReview: previous.qualityReview }
      : next;
  });
}
