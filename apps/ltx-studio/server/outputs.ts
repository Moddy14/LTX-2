import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  migrateGenerationRequest,
  outputNameSchema,
  type GenerationRequest,
} from "../shared/pipelines.js";
import { usesOfficialSpeechStack } from "../shared/models.js";
import {
  normalizeJobQualityReview,
  qualityReviewInputSchema,
  type JobQualityReview,
  type QualityReviewInput,
} from "../shared/quality.js";
import type { DeletedStudioOutput, StudioOutput } from "../shared/outputs.js";
import {
  experimentRunBindingSchema,
  type ExperimentRunBinding,
} from "../shared/experiments.js";
import {
  projectOutputEvidenceSchema,
  projectRunBindingSchema,
  type ProjectOutputEvidence,
  type ProjectRunBinding,
} from "../shared/projects.js";
import type { ReusableLtxBaseCandidate, StudioJob } from "./jobs.js";
import {
  normalizeIdentityInputEvidence,
  type IdentityInputEvidence,
} from "./inputEvidence.js";
import { readOutputAnalysis } from "./analysisStore.js";
import type { RunProvenance } from "../shared/provenance.js";
import { normalizeRunProvenance } from "./runProvenance.js";
import { sha256Json } from "./experimentStore.js";

const SIDECAR_SUFFIX = ".ltx-settings.json";
const MAX_OUTPUTS = 500;

async function hashUnchangedRegularFile(path: string): Promise<{
  sha256: string;
  sizeBytes: number;
  changedAtMs: number;
  fileId: string;
}> {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
    throw new OutputQualityError("Projektartefakt ist keine reguläre, nichtleere Datei.", 409);
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = lstatSync(path);
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
    || before.ctimeMs !== after.ctimeMs
  ) {
    throw new OutputQualityError("Projektartefakt änderte sich während der Hash-Erfassung.", 409);
  }
  return {
    sha256: digest.digest("hex"),
    sizeBytes: after.size,
    changedAtMs: after.ctimeMs,
    fileId: String(after.ino),
  };
}

type OutputSettingsRecord = {
  schemaVersion: "ltx-studio-output.v7";
  outputName: string;
  jobId: string;
  completedAt: string;
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number | null;
  fileId: string | null;
  request: GenerationRequest;
  qualityReview: JobQualityReview | null;
  identityEvidence: IdentityInputEvidence | null;
  runProvenance: RunProvenance | null;
  experiment: ExperimentRunBinding | null;
  project: ProjectRunBinding | null;
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
  identityEvidence: IdentityInputEvidence | null;
  runProvenance: RunProvenance | null;
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

export class OutputDeleteError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409,
  ) {
    super(message);
    this.name = "OutputDeleteError";
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
    if (![
      "ltx-studio-output.v1",
      "ltx-studio-output.v2",
      "ltx-studio-output.v3",
      "ltx-studio-output.v4",
      "ltx-studio-output.v5",
      "ltx-studio-output.v6",
      "ltx-studio-output.v7",
    ].includes(schemaVersion)
      || parsed.outputName !== outputName
      || typeof parsed.jobId !== "string"
      || !/^[0-9a-f-]{36}$/i.test(parsed.jobId)
      || typeof parsed.completedAt !== "string"
      || !Number.isFinite(Date.parse(parsed.completedAt))
      || typeof parsed.sizeBytes !== "number"
      || !Number.isFinite(parsed.sizeBytes)
      || typeof parsed.modifiedAtMs !== "number"
      || !Number.isFinite(parsed.modifiedAtMs)
      || (["ltx-studio-output.v3", "ltx-studio-output.v4", "ltx-studio-output.v5", "ltx-studio-output.v6", "ltx-studio-output.v7"].includes(schemaVersion)
        && (typeof parsed.changedAtMs !== "number"
          || !Number.isFinite(parsed.changedAtMs)
          || typeof parsed.fileId !== "string"
          || !/^\d{1,64}$/.test(parsed.fileId)))
      || !request) return null;
    return {
      schemaVersion: "ltx-studio-output.v7",
      outputName,
      jobId: parsed.jobId,
      completedAt: parsed.completedAt,
      sizeBytes: parsed.sizeBytes,
      modifiedAtMs: parsed.modifiedAtMs,
      changedAtMs: ["ltx-studio-output.v3", "ltx-studio-output.v4", "ltx-studio-output.v5", "ltx-studio-output.v6", "ltx-studio-output.v7"].includes(schemaVersion)
        ? parsed.changedAtMs ?? null
        : null,
      fileId: ["ltx-studio-output.v3", "ltx-studio-output.v4", "ltx-studio-output.v5", "ltx-studio-output.v6", "ltx-studio-output.v7"].includes(schemaVersion)
        ? parsed.fileId ?? null
        : null,
      request,
      qualityReview: [
        "ltx-studio-output.v2",
        "ltx-studio-output.v3",
        "ltx-studio-output.v4",
        "ltx-studio-output.v5",
        "ltx-studio-output.v6",
        "ltx-studio-output.v7",
      ].includes(schemaVersion)
        ? normalizeJobQualityReview(parsed.qualityReview)
        : null,
      identityEvidence: ["ltx-studio-output.v4", "ltx-studio-output.v5", "ltx-studio-output.v6", "ltx-studio-output.v7"].includes(schemaVersion)
        ? normalizeIdentityInputEvidence(parsed.identityEvidence)
        : null,
      runProvenance: ["ltx-studio-output.v5", "ltx-studio-output.v6", "ltx-studio-output.v7"].includes(schemaVersion)
        ? normalizeRunProvenance(parsed.runProvenance)
        : null,
      experiment: ["ltx-studio-output.v6", "ltx-studio-output.v7"].includes(schemaVersion)
        ? (() => {
            const experiment = experimentRunBindingSchema.safeParse(parsed.experiment);
            return experiment.success ? experiment.data : null;
          })()
        : null,
      project: schemaVersion === "ltx-studio-output.v7"
        ? (() => {
            const project = projectRunBindingSchema.safeParse(parsed.project);
            return project.success ? project.data : null;
          })()
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

export function supportsSpeechQuality(request: GenerationRequest): boolean {
  return request.mode !== "text-to-audio" && usesOfficialSpeechStack(request);
}

export class OutputLibrary {
  constructor(private readonly root: string) {}

  delete(outputName: string, jobs: readonly StudioJob[]): DeletedStudioOutput {
    if (!outputNameSchema.safeParse(outputName).success) {
      throw new OutputDeleteError("Ausgabe nicht gefunden.", 404);
    }
    const activeJob = jobs.find((job) =>
      job.outputName === outputName && ["queued", "running", "paused"].includes(job.status));
    if (activeJob) {
      throw new OutputDeleteError(
        `Die Ausgabe gehört zum aktiven Job ${activeJob.id.slice(0, 8)} und kann erst danach gelöscht werden.`,
        409,
      );
    }

    const outputPath = join(this.root, outputName);
    if (!existsSync(outputPath)) throw new OutputDeleteError("Ausgabe nicht gefunden.", 404);
    const stats = lstatSync(outputPath);
    if (!stats.isFile()) throw new OutputDeleteError("Ausgabe nicht gefunden.", 404);

    const reportName = outputName.replace(/\.(?:mp4|wav)$/i, ".report.json");
    const artifactNames = [
      outputName,
      `${outputName}${SIDECAR_SUFFIX}`,
      `${outputName}.ltx-analysis.json`,
      reportName,
    ];
    const deletedArtifacts: string[] = [];
    for (const artifactName of artifactNames) {
      const artifactPath = join(this.root, artifactName);
      if (!existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) continue;
      unlinkSync(artifactPath);
      deletedArtifacts.push(artifactName);
    }
    return {
      name: outputName,
      sizeBytes: stats.size,
      deletedArtifacts,
    };
  }

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
            schemaVersion: "ltx-studio-output.v7",
            changedAtMs: stats.ctimeMs,
            fileId: String(stats.ino),
            identityEvidence: null,
            runProvenance: null,
            experiment: null,
            project: null,
          });
        }
        continue;
      }
      if (existsSync(settingsPath(this.root, job.outputName))) continue;
      const record: StrongOutputSettingsRecord = {
        schemaVersion: "ltx-studio-output.v7",
        outputName: job.outputName,
        jobId: job.id,
        completedAt: job.finishedAt,
        sizeBytes: stats.size,
        modifiedAtMs: stats.mtimeMs,
        changedAtMs: stats.ctimeMs,
        fileId: String(stats.ino),
        request: job.request,
        qualityReview: null,
        identityEvidence: job.identityEvidence,
        runProvenance: job.runProvenance,
        experiment: job.experiment,
        project: job.project,
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
      schemaVersion: "ltx-studio-output.v7",
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

  reusableLtxBaseCandidates(): ReusableLtxBaseCandidate[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && outputNameSchema.safeParse(entry.name).success)
      .flatMap((entry): ReusableLtxBaseCandidate[] => {
        const outputPath = join(this.root, entry.name);
        let stats;
        try {
          stats = statSync(outputPath);
        } catch {
          return [];
        }
        if (!stats.isFile() || stats.size <= 0) return [];
        const record = readRecord(this.root, entry.name);
        if (!record || !hasStrongRevision(record) || !recordMatchesFile(record, stats)) return [];
        if (!record.identityEvidence || !record.runProvenance) return [];
        return [{
          outputName: record.outputName,
          outputPath,
          jobId: record.jobId,
          request: record.request,
          identityEvidence: record.identityEvidence,
          runProvenance: record.runProvenance,
        }];
      });
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
      throw new OutputQualityError("Nur ein fertiges Sprachvideo kann analysiert werden.", 409);
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
      identityEvidence: record.identityEvidence,
      runProvenance: record.runProvenance,
    };
  }

  async captureProjectOutputEvidence(
    outputName: string,
    expectedProject: Pick<ProjectRunBinding, "projectId" | "shotId" | "requestRevisionId">,
    jobs: readonly StudioJob[],
    recordedAt = new Date().toISOString(),
  ): Promise<ProjectOutputEvidence> {
    if (!outputNameSchema.safeParse(outputName).success) {
      throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    }
    this.recordCompleted(jobs);
    const outputPath = join(this.root, outputName);
    const sidecarPath = settingsPath(this.root, outputName);
    if (!existsSync(outputPath) || !existsSync(sidecarPath)) {
      throw new OutputQualityError("Ausgabe oder Einstellungs-Sidecar fehlt.", 404);
    }
    const stats = lstatSync(outputPath);
    const record = readRecord(this.root, outputName);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.size <= 0
      || !record
      || !hasStrongRevision(record)
      || !recordMatchesFile(record, stats)
      || record.runProvenance?.schemaVersion !== "ltx-studio-run-provenance.v2"
      || !record.runProvenance.verifiedAt
      || !/^[0-9a-f]{64}$/.test(record.runProvenance.fingerprint)
      || record.project?.projectId !== expectedProject.projectId
      || record.project.shotId !== expectedProject.shotId
      || record.project.requestRevisionId !== expectedProject.requestRevisionId
    ) {
      throw new OutputQualityError(
        "Die Projektausgabe benötigt unveränderte Datei-, Sidecar-, Projekt- und v2-Laufprovenienz.",
        409,
      );
    }
    const [exportEvidence, sidecarEvidence] = await Promise.all([
      hashUnchangedRegularFile(outputPath),
      hashUnchangedRegularFile(sidecarPath),
    ]);
    const after = lstatSync(outputPath);
    const afterSidecar = lstatSync(sidecarPath);
    const afterRecord = readRecord(this.root, outputName);
    if (
      after.isSymbolicLink()
      || afterSidecar.isSymbolicLink()
      || !afterSidecar.isFile()
      || !afterRecord
      || !hasStrongRevision(afterRecord)
      || !recordMatchesFile(afterRecord, after)
      || afterRecord.jobId !== record.jobId
      || sha256Json(afterRecord.request) !== sha256Json(record.request)
      || afterRecord.runProvenance?.fingerprint !== record.runProvenance.fingerprint
      || exportEvidence.sizeBytes !== after.size
      || exportEvidence.fileId !== String(after.ino)
      || Math.abs(exportEvidence.changedAtMs - after.ctimeMs) >= 1
      || sidecarEvidence.sizeBytes !== afterSidecar.size
      || sidecarEvidence.fileId !== String(afterSidecar.ino)
      || Math.abs(sidecarEvidence.changedAtMs - afterSidecar.ctimeMs) >= 1
    ) {
      throw new OutputQualityError(
        "Projektausgabe oder Sidecar änderte sich während der Evidenzerfassung.",
        409,
      );
    }
    return projectOutputEvidenceSchema.parse({
      id: randomUUID(),
      projectRun: record.project,
      requestRevisionId: expectedProject.requestRevisionId,
      requestSha256: sha256Json(record.request),
      jobId: record.jobId,
      outputName,
      sizeBytes: after.size,
      changedAt: after.ctime.toISOString(),
      fileId: String(after.ino),
      provenanceFingerprint: record.runProvenance.fingerprint,
      settingsSidecarSha256: sidecarEvidence.sha256,
      exportSha256: exportEvidence.sha256,
      recordedAt,
    });
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
          provenance: settingsMatch ? record?.runProvenance ?? null : null,
          experiment: settingsMatch ? record?.experiment ?? null : null,
          project: settingsMatch ? record?.project ?? null : null,
          experimentRequestVerified: Boolean(
            settingsMatch
            && record?.experiment
            && record.request
            && sha256Json(record.request) === record.experiment.requestSha256,
          ),
        };
      })
      .filter((output): output is StudioOutput => output !== null)
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, MAX_OUTPUTS);
  }
}
