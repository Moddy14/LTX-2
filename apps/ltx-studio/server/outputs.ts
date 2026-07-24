import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  migrateGenerationRequest,
  outputNameSchema,
  type GenerationRequest,
} from "../shared/pipelines.js";
import {
  normalizeJobQualityReview,
  qualityReviewInputSchema,
  type JobQualityReview,
  type QualityReviewInput,
} from "../shared/quality.js";
import type { StudioOutput } from "../shared/outputs.js";
import type { StudioJob } from "./jobs.js";
import { readOutputAnalysis } from "./analysisStore.js";

const SIDECAR_SUFFIX = ".ltx-settings.json";
const MAX_OUTPUTS = 500;

type OutputSettingsRecord = {
  schemaVersion: "ltx-studio-output.v3";
  outputName: string;
  jobId: string;
  completedAt: string;
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number | null;
  fileId: string | null;
  request: GenerationRequest;
  qualityReview: JobQualityReview | null;
};

type StrongOutputSettingsRecord = OutputSettingsRecord & {
  changedAtMs: number;
  fileId: string;
};

export type OutputAnalysisTarget = {
  outputName: string;
  outputPath: string;
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number;
  fileId: string;
  jobId: string;
  request: GenerationRequest;
};

export class OutputQualityError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409,
  ) {
    super(message);
    this.name = "OutputQualityError";
  }
}

function settingsPath(root: string, outputName: string): string {
  return join(root, `${outputName}${SIDECAR_SUFFIX}`);
}

function readRecord(root: string, outputName: string): OutputSettingsRecord | null {
  const path = settingsPath(root, outputName);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OutputSettingsRecord>;
    const request = migrateGenerationRequest(parsed.request);
    const schemaVersion = String(parsed.schemaVersion);
    if (!["ltx-studio-output.v1", "ltx-studio-output.v2", "ltx-studio-output.v3"].includes(schemaVersion)
      || parsed.outputName !== outputName
      || typeof parsed.jobId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(parsed.jobId)
      || typeof parsed.completedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.completedAt))
      || typeof parsed.sizeBytes !== "number"
      || !Number.isFinite(parsed.sizeBytes)
      || typeof parsed.modifiedAtMs !== "number"
      || !Number.isFinite(parsed.modifiedAtMs)
      || (schemaVersion === "ltx-studio-output.v3"
        && (typeof parsed.changedAtMs !== "number"
          || !Number.isFinite(parsed.changedAtMs)
          || typeof parsed.fileId !== "string"
          || !/^\d{1,64}$/.test(parsed.fileId)))
      || !request) return null;
    return {
      schemaVersion: "ltx-studio-output.v3",
      outputName,
      jobId: parsed.jobId,
      completedAt: parsed.completedAt,
      sizeBytes: parsed.sizeBytes,
      modifiedAtMs: parsed.modifiedAtMs,
      changedAtMs: schemaVersion === "ltx-studio-output.v3" ? parsed.changedAtMs ?? null : null,
      fileId: schemaVersion === "ltx-studio-output.v3" ? parsed.fileId ?? null : null,
      request,
      qualityReview: ["ltx-studio-output.v2", "ltx-studio-output.v3"].includes(schemaVersion)
        ? normalizeJobQualityReview(parsed.qualityReview)
        : null,
    };
  } catch {
    return null;
  }
}

function writeRecord(root: string, record: OutputSettingsRecord): void {
  const path = settingsPath(root, record.outputName);
  const temporaryPath = `${path}.tmp`;
  const serialized = hasStrongRevision(record)
    ? record
    : {
        schemaVersion: "ltx-studio-output.v2",
        outputName: record.outputName,
        jobId: record.jobId,
        completedAt: record.completedAt,
        sizeBytes: record.sizeBytes,
        modifiedAtMs: record.modifiedAtMs,
        request: record.request,
        qualityReview: record.qualityReview,
      };
  writeFileSync(temporaryPath, `${JSON.stringify(serialized, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}

function recordMatchesFile(
  record: OutputSettingsRecord,
  stats: { size: number; mtimeMs: number; ctimeMs: number; ino: number },
): boolean {
  return record.sizeBytes === stats.size
    && Math.abs(record.modifiedAtMs - stats.mtimeMs) < 1
    && (record.changedAtMs === null || Math.abs(record.changedAtMs - stats.ctimeMs) < 1)
    && (record.fileId === null || record.fileId === String(stats.ino));
}

function hasStrongRevision(record: OutputSettingsRecord): record is StrongOutputSettingsRecord {
  return record.changedAtMs !== null && record.fileId !== null;
}

function supportsSpeechQuality(request: GenerationRequest): boolean {
  return request.mode === "lipdub" || request.mode === "audio-to-video";
}

export class OutputLibrary {
  constructor(private readonly root: string) {}

  recordCompleted(jobs: readonly StudioJob[]): void {
    for (const job of jobs) {
      if (job.status !== "completed" || !job.finishedAt) continue;
      const outputPath = join(this.root, job.outputName);
      if (!existsSync(outputPath)) continue;
      const stats = statSync(outputPath);
      if (!stats.isFile() || stats.size <= 0) continue;
      const existing = readRecord(this.root, job.outputName);
      if (existing) {
        if (!hasStrongRevision(existing)
          && existing.jobId === job.id
          && recordMatchesFile(existing, stats)) {
          writeRecord(this.root, {
            ...existing,
            schemaVersion: "ltx-studio-output.v3",
            changedAtMs: stats.ctimeMs,
            fileId: String(stats.ino),
          });
        }
        continue;
      }
      if (existsSync(settingsPath(this.root, job.outputName))) continue;
      const record: StrongOutputSettingsRecord = {
        schemaVersion: "ltx-studio-output.v3",
        outputName: job.outputName,
        jobId: job.id,
        completedAt: job.finishedAt,
        sizeBytes: stats.size,
        modifiedAtMs: stats.mtimeMs,
        changedAtMs: stats.ctimeMs,
        fileId: String(stats.ino),
        request: job.request,
        qualityReview: null,
      };
      writeRecord(this.root, record);
    }
  }

  setQualityReview(
    outputName: string,
    input: QualityReviewInput,
    jobs: readonly StudioJob[],
  ): StudioOutput {
    const validated = qualityReviewInputSchema.parse(input);
    if (!outputNameSchema.safeParse(outputName).success) {
      throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    }
    const outputPath = join(this.root, outputName);
    if (!existsSync(outputPath)) {
      throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    }
    const stats = statSync(outputPath);
    const record = readRecord(this.root, outputName);
    if (!record || !stats.isFile() || stats.size <= 0 || !recordMatchesFile(record, stats)) {
      throw new OutputQualityError(
        "Die Ausgabe hat keine passende Studio-Provenienz oder wurde nachträglich verändert.",
        409,
      );
    }
    if (!supportsSpeechQuality(record.request)) {
      throw new OutputQualityError("Nur ein fertiges Sprachvideo kann mit der LipSync-Scorecard bewertet werden.", 409);
    }
    writeRecord(this.root, {
      ...record,
      schemaVersion: "ltx-studio-output.v3",
      qualityReview: {
        scores: { ...validated.scores },
        note: validated.note,
        updatedAt: new Date().toISOString(),
      },
    });
    const updated = this.list(jobs).find((output) => output.name === outputName);
    if (!updated?.settingsAvailable || !updated.qualityReview) {
      throw new OutputQualityError("Ausgabe ist nach dem Speichern nicht mehr unverändert verfügbar.", 409);
    }
    return updated;
  }

  resolveAnalysisTarget(outputName: string): OutputAnalysisTarget {
    if (!outputNameSchema.safeParse(outputName).success) {
      throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    }
    const outputPath = join(this.root, outputName);
    if (!existsSync(outputPath)) throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    const stats = statSync(outputPath);
    const record = readRecord(this.root, outputName);
    if (!record || !stats.isFile() || stats.size <= 0 || !recordMatchesFile(record, stats)) {
      throw new OutputQualityError(
        "Die Ausgabe hat keine passende Studio-Provenienz oder wurde nachträglich verändert.",
        409,
      );
    }
    if (!hasStrongRevision(record)) {
      throw new OutputQualityError(
        "Die Ausgabe benötigt eine aktuelle, inhaltsgebundene Studio-Provenienz für die objektive Analyse.",
        409,
      );
    }
    if (!supportsSpeechQuality(record.request)) {
      throw new OutputQualityError("Nur ein fertiges Audio- oder LipDub-Video kann analysiert werden.", 409);
    }
    return {
      outputName,
      outputPath,
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      changedAtMs: stats.ctimeMs,
      fileId: String(stats.ino),
      jobId: record.jobId,
      request: record.request,
    };
  }

  list(jobs: readonly StudioJob[]): StudioOutput[] {
    this.recordCompleted(jobs);
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && outputNameSchema.safeParse(entry.name).success)
      .map((entry): StudioOutput | null => {
        const path = join(this.root, entry.name);
        const stats = statSync(path);
        if (stats.size <= 0) return null;
        const record = readRecord(this.root, entry.name);
        const settingsMatch = Boolean(record && recordMatchesFile(record, stats));
        return {
          name: entry.name,
          url: `/api/outputs/${encodeURIComponent(entry.name)}`,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          changedAt: stats.ctime.toISOString(),
          fileId: String(stats.ino),
          jobId: settingsMatch ? record?.jobId ?? null : null,
          jobStatus: settingsMatch ? "completed" : "external",
          request: settingsMatch ? record?.request ?? null : null,
          settingsAvailable: settingsMatch,
          qualityReview: settingsMatch ? record?.qualityReview ?? null : null,
          analysis: settingsMatch && record && hasStrongRevision(record)
            ? readOutputAnalysis(this.root, entry.name, {
                sizeBytes: stats.size,
                modifiedAtMs: stats.mtimeMs,
                changedAtMs: stats.ctimeMs,
                fileId: String(stats.ino),
                jobId: record.jobId,
              })
            : null,
        };
      })
      .filter((output): output is StudioOutput => output !== null)
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, MAX_OUTPUTS);
  }
}
