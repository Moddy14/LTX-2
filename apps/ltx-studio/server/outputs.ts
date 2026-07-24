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

const SIDECAR_SUFFIX = ".ltx-settings.json";
const MAX_OUTPUTS = 500;

type OutputSettingsRecord = {
  schemaVersion: "ltx-studio-output.v2";
  outputName: string;
  jobId: string;
  completedAt: string;
  sizeBytes: number;
  modifiedAtMs: number;
  request: GenerationRequest;
  qualityReview: JobQualityReview | null;
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
    if (!["ltx-studio-output.v1", "ltx-studio-output.v2"].includes(String(parsed.schemaVersion))
      || parsed.outputName !== outputName
      || typeof parsed.jobId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(parsed.jobId)
      || typeof parsed.completedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.completedAt))
      || typeof parsed.sizeBytes !== "number"
      || !Number.isFinite(parsed.sizeBytes)
      || typeof parsed.modifiedAtMs !== "number"
      || !Number.isFinite(parsed.modifiedAtMs)
      || !request) return null;
    return {
      schemaVersion: "ltx-studio-output.v2",
      outputName,
      jobId: parsed.jobId,
      completedAt: parsed.completedAt,
      sizeBytes: parsed.sizeBytes,
      modifiedAtMs: parsed.modifiedAtMs,
      request,
      qualityReview: parsed.schemaVersion === "ltx-studio-output.v2"
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
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}

function recordMatchesFile(
  record: OutputSettingsRecord,
  stats: { size: number; mtimeMs: number },
): boolean {
  return record.sizeBytes === stats.size && Math.abs(record.modifiedAtMs - stats.mtimeMs) < 1;
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
      if (!existsSync(outputPath) || existsSync(settingsPath(this.root, job.outputName))) continue;
      const stats = statSync(outputPath);
      if (!stats.isFile() || stats.size <= 0) continue;
      const record: OutputSettingsRecord = {
        schemaVersion: "ltx-studio-output.v2",
        outputName: job.outputName,
        jobId: job.id,
        completedAt: job.finishedAt,
        sizeBytes: stats.size,
        modifiedAtMs: stats.mtimeMs,
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
      schemaVersion: "ltx-studio-output.v2",
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
          jobId: settingsMatch ? record?.jobId ?? null : null,
          jobStatus: settingsMatch ? "completed" : "external",
          request: settingsMatch ? record?.request ?? null : null,
          settingsAvailable: settingsMatch,
          qualityReview: settingsMatch ? record?.qualityReview ?? null : null,
        };
      })
      .filter((output): output is StudioOutput => output !== null)
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, MAX_OUTPUTS);
  }
}
