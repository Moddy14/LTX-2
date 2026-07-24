import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  outputAnalysisRecordSchema,
  type OutputAnalysisRecord,
} from "../shared/objectiveQuality.js";
import { outputNameSchema } from "../shared/pipelines.js";

const ANALYSIS_SUFFIX = ".ltx-analysis.json";

export type OutputRevision = {
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number;
  fileId: string;
  jobId: string;
};

export function outputAnalysisPath(root: string, outputName: string): string {
  return join(root, `${outputName}${ANALYSIS_SUFFIX}`);
}

function parseRecord(path: string): OutputAnalysisRecord | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = outputAnalysisRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function readOutputAnalysis(
  root: string,
  outputName: string,
  revision: OutputRevision,
): OutputAnalysisRecord | null {
  const record = parseRecord(outputAnalysisPath(root, outputName));
  if (!record
    || record.outputName !== outputName
    || record.sizeBytes !== revision.sizeBytes
    || Math.abs(record.modifiedAtMs - revision.modifiedAtMs) >= 1
    || Math.abs(record.changedAtMs - revision.changedAtMs) >= 1
    || record.fileId !== revision.fileId
    || record.jobId !== revision.jobId) return null;
  return record;
}

export function writeOutputAnalysis(root: string, record: OutputAnalysisRecord): void {
  const parsed = outputAnalysisRecordSchema.parse(record);
  const path = outputAnalysisPath(root, parsed.outputName);
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}

export function recoverInterruptedOutputAnalyses(root: string, interruptedAt = new Date().toISOString()): number {
  let recovered = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(ANALYSIS_SUFFIX)) continue;
    const outputName = entry.name.slice(0, -ANALYSIS_SUFFIX.length);
    if (!outputNameSchema.safeParse(outputName).success) continue;
    const record = parseRecord(join(root, entry.name));
    if (!record || record.outputName !== outputName || !["queued", "running"].includes(record.status)) continue;
    writeOutputAnalysis(root, {
      ...record,
      status: "failed",
      progress: record.progress,
      finishedAt: interruptedAt,
      updatedAt: interruptedAt,
      error: {
        code: "studio-restarted",
        message: "Studio wurde während der objektiven Analyse neu gestartet.",
      },
      result: null,
    });
    recovered += 1;
  }
  return recovered;
}
