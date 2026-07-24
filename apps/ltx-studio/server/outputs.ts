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
  generationRequestSchema,
  outputNameSchema,
  type GenerationRequest,
} from "../shared/pipelines.js";
import type { StudioOutput } from "../shared/outputs.js";
import type { StudioJob } from "./jobs.js";

const SIDECAR_SUFFIX = ".ltx-settings.json";
const MAX_OUTPUTS = 500;

type OutputSettingsRecord = {
  schemaVersion: "ltx-studio-output.v1";
  outputName: string;
  jobId: string;
  completedAt: string;
  sizeBytes: number;
  modifiedAtMs: number;
  request: GenerationRequest;
};

function settingsPath(root: string, outputName: string): string {
  return join(root, `${outputName}${SIDECAR_SUFFIX}`);
}

function readRecord(root: string, outputName: string): OutputSettingsRecord | null {
  const path = settingsPath(root, outputName);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OutputSettingsRecord>;
    const request = generationRequestSchema.safeParse(parsed.request);
    if (parsed.schemaVersion !== "ltx-studio-output.v1"
      || parsed.outputName !== outputName
      || typeof parsed.jobId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(parsed.jobId)
      || typeof parsed.completedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.completedAt))
      || typeof parsed.sizeBytes !== "number"
      || !Number.isFinite(parsed.sizeBytes)
      || typeof parsed.modifiedAtMs !== "number"
      || !Number.isFinite(parsed.modifiedAtMs)
      || !request.success) return null;
    return {
      schemaVersion: "ltx-studio-output.v1",
      outputName,
      jobId: parsed.jobId,
      completedAt: parsed.completedAt,
      sizeBytes: parsed.sizeBytes,
      modifiedAtMs: parsed.modifiedAtMs,
      request: request.data,
    };
  } catch {
    return null;
  }
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
        schemaVersion: "ltx-studio-output.v1",
        outputName: job.outputName,
        jobId: job.id,
        completedAt: job.finishedAt,
        sizeBytes: stats.size,
        modifiedAtMs: stats.mtimeMs,
        request: job.request,
      };
      const path = settingsPath(this.root, job.outputName);
      const temporaryPath = `${path}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, path);
    }
  }

  list(jobs: readonly StudioJob[]): StudioOutput[] {
    this.recordCompleted(jobs);
    const completedJobs = new Map(
      jobs
        .filter((job) => job.status === "completed")
        .map((job) => [job.id, job] as const),
    );
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && outputNameSchema.safeParse(entry.name).success)
      .map((entry): StudioOutput | null => {
        const path = join(this.root, entry.name);
        const stats = statSync(path);
        if (stats.size <= 0) return null;
        const record = readRecord(this.root, entry.name);
        const job = record ? completedJobs.get(record.jobId) : undefined;
        const settingsMatch = Boolean(
          record
          && record.sizeBytes === stats.size
          && Math.abs(record.modifiedAtMs - stats.mtimeMs) < 1,
        );
        return {
          name: entry.name,
          url: `/api/outputs/${encodeURIComponent(entry.name)}`,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          jobId: settingsMatch ? record?.jobId ?? null : null,
          jobStatus: settingsMatch && job ? "completed" : "external",
          request: settingsMatch ? record?.request ?? null : null,
          settingsAvailable: settingsMatch,
        };
      })
      .filter((output): output is StudioOutput => output !== null)
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, MAX_OUTPUTS);
  }
}
