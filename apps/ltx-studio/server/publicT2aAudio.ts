import type { StudioOutput } from "../shared/outputs.js";
import type { T2aAudioPublicAnalysisRecord } from "../shared/t2aAudioPublic.js";
import {
  toPublicT2aAudioAnalysis,
  type T2aAudioAnalysisRecord,
} from "./t2aAudioAnalysis.js";
import { publicOutputRevisionToken } from "./publicOutput.js";

function analysisRevisionToken(record: T2aAudioAnalysisRecord): string {
  const revision = record.targetBinding.outputRevision;
  return publicOutputRevisionToken({
    outputName: record.targetBinding.outputName,
    sizeBytes: revision.sizeBytes,
    modifiedAtMs: revision.modifiedAtMs,
    changedAtMs: revision.changedAtMs,
    fileId: revision.fileId,
    jobId: record.targetBinding.jobId,
  });
}

function outputRevisionToken(output: StudioOutput): string {
  return publicOutputRevisionToken({
    outputName: output.name,
    sizeBytes: output.sizeBytes,
    modifiedAtMs: Date.parse(output.modifiedAt),
    changedAtMs: Date.parse(output.changedAt),
    fileId: output.fileId,
    jobId: output.jobId,
  });
}

export function toBoundPublicT2aAudioAnalysis(
  record: T2aAudioAnalysisRecord,
): T2aAudioPublicAnalysisRecord {
  return toPublicT2aAudioAnalysis(record, analysisRevisionToken(record));
}

export function publicT2aAudioAnalysisResponse(
  record: T2aAudioAnalysisRecord | null,
): { analysis: T2aAudioPublicAnalysisRecord | null } {
  return { analysis: record ? toBoundPublicT2aAudioAnalysis(record) : null };
}

export function collectPublicT2aAudioAnalyses(
  outputs: readonly StudioOutput[],
  resolveAnalysis: (outputName: string) => T2aAudioAnalysisRecord | null,
): ReadonlyMap<string, T2aAudioPublicAnalysisRecord> {
  const result = new Map<string, T2aAudioPublicAnalysisRecord>();
  for (const output of outputs) {
    if (!output.name.toLowerCase().endsWith(".wav")) continue;
    let record: T2aAudioAnalysisRecord | null;
    try {
      record = resolveAnalysis(output.name);
    } catch {
      // Listing outputs must remain available when the sealed evaluator is
      // unavailable. Starting the analysis still returns the exact blocker.
      continue;
    }
    if (!record || record.targetBinding.jobId !== output.jobId) continue;
    const publicRecord = toBoundPublicT2aAudioAnalysis(record);
    if (publicRecord.outputRevisionToken !== outputRevisionToken(output)) continue;
    result.set(output.name, publicRecord);
  }
  return result;
}
