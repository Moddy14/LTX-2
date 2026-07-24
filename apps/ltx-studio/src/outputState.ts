import type { OutputAnalysisRecord } from "../shared/objectiveQuality.js";
import type { StudioOutput } from "../shared/outputs.js";

function sameOutputRevision(left: StudioOutput, right: StudioOutput): boolean {
  return left.name === right.name
    && left.sizeBytes === right.sizeBytes
    && left.modifiedAt === right.modifiedAt
    && left.changedAt === right.changedAt
    && left.fileId === right.fileId
    && left.jobId === right.jobId
    && left.settingsAvailable === right.settingsAvailable;
}

function analysisStatusRank(status: OutputAnalysisRecord["status"]): number {
  if (status === "queued") return 0;
  if (status === "running") return 1;
  return 2;
}

function isNewerAnalysis(
  current: OutputAnalysisRecord,
  incoming: OutputAnalysisRecord,
): boolean {
  if (incoming.attempt !== current.attempt) return incoming.attempt > current.attempt;
  if (incoming.analysisId !== current.analysisId) {
    return Date.parse(incoming.createdAt) > Date.parse(current.createdAt);
  }
  const statusDelta = analysisStatusRank(incoming.status) - analysisStatusRank(current.status);
  if (statusDelta !== 0) return statusDelta > 0;
  if (incoming.progress !== current.progress) return incoming.progress > current.progress;
  return Date.parse(incoming.updatedAt) > Date.parse(current.updatedAt);
}

export function mergeOutputRefresh(
  current: readonly StudioOutput[],
  incoming: readonly StudioOutput[],
): StudioOutput[] {
  const currentByName = new Map(current.map((output) => [output.name, output]));
  return incoming.map((next) => {
    const previous = currentByName.get(next.name);
    if (!previous || !sameOutputRevision(previous, next)) return next;
    let merged = next;
    if (previous.qualityReview) {
      const previousUpdatedAt = Date.parse(previous.qualityReview.updatedAt);
      const nextUpdatedAt = next.qualityReview ? Date.parse(next.qualityReview.updatedAt) : Number.NEGATIVE_INFINITY;
      if (previousUpdatedAt > nextUpdatedAt) merged = { ...merged, qualityReview: previous.qualityReview };
    }
    if (previous.analysis) {
      if (!next.analysis || !isNewerAnalysis(previous.analysis, next.analysis)) {
        merged = { ...merged, analysis: previous.analysis };
      }
    }
    return merged;
  });
}

export function mergeOutputAnalysis(
  output: StudioOutput,
  analysis: OutputAnalysisRecord,
): StudioOutput {
  if (output.name !== analysis.outputName
    || output.sizeBytes !== analysis.sizeBytes
    || output.jobId !== analysis.jobId
    || Math.abs(Date.parse(output.modifiedAt) - analysis.modifiedAtMs) >= 1
    || Math.abs(Date.parse(output.changedAt) - analysis.changedAtMs) >= 1
    || output.fileId !== analysis.fileId) return output;
  if (output.analysis && !isNewerAnalysis(output.analysis, analysis)) return output;
  return { ...output, analysis };
}
