import type {
  PublicOutputAnalysisRecord as OutputAnalysisRecord,
  PublicStudioOutput as StudioOutput,
} from "../shared/outputPublic.js";
import type { T2aAudioPublicAnalysisRecord } from "../shared/t2aAudioPublic.js";

type BrowserAnalysisRecord = OutputAnalysisRecord | T2aAudioPublicAnalysisRecord;

function sameOutputRevision(left: StudioOutput, right: StudioOutput): boolean {
  return left.name === right.name
    && left.revisionToken === right.revisionToken
    && left.settingsAvailable === right.settingsAvailable;
}

function analysisStatusRank(status: BrowserAnalysisRecord["status"]): number {
  if (status === "queued") return 0;
  if (status === "running") return 1;
  return 2;
}

function isNewerAnalysis(
  current: BrowserAnalysisRecord,
  incoming: BrowserAnalysisRecord,
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
      if (next.analysis && !isNewerAnalysis(previous.analysis, next.analysis)) {
        merged = { ...merged, analysis: previous.analysis };
      }
    }
    if (previous.audioAnalysis) {
      if (next.audioAnalysis && !isNewerAnalysis(previous.audioAnalysis, next.audioAnalysis)) {
        merged = { ...merged, audioAnalysis: previous.audioAnalysis };
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
    || output.jobId !== analysis.jobId
    || output.revisionToken !== analysis.outputRevisionToken) return output;
  if (output.analysis && !isNewerAnalysis(output.analysis, analysis)) return output;
  return { ...output, analysis };
}

export function mergeT2aAudioAnalysis(
  output: StudioOutput,
  analysis: T2aAudioPublicAnalysisRecord,
): StudioOutput {
  if (output.name !== analysis.outputName
    || output.jobId !== analysis.jobId
    || output.revisionToken !== analysis.outputRevisionToken) return output;
  if (output.audioAnalysis && !isNewerAnalysis(output.audioAnalysis, analysis)) return output;
  return { ...output, audioAnalysis: analysis };
}
