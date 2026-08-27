import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { basename, join } from "node:path";

import { z } from "zod";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  generationRequestSchema,
  migrateGenerationRequest,
  outputNameSchema,
  type GenerationRequest,
} from "../shared/pipelines.js";
import {
  bindT2aAudioQualityClaimScope,
  t2aAudioClaimScopeSchema,
  t2aAudioQualitySchema,
  type T2aAudioClaimScope,
  type T2aFailedAudioQuality,
  type T2aMeasuredAudioQuality,
  type T2aAudioQuality,
} from "../shared/t2aAudioQuality.js";
import {
  T2A_AUDIO_PUBLIC_ANALYSIS_VERSION,
  T2A_AUDIO_PUBLIC_QUALITY_VERSION,
  publicPronunciationMeasurementSchema,
  t2aAudioPublicAnalysisRecordSchema,
  t2aAudioPublicQualitySchema,
  type PublicIndependentIpaMeasurement,
  type PublicPronunciationMeasurement,
  type T2aAudioPublicAnalysisRecord,
  type T2aAudioPublicQuality,
} from "../shared/t2aAudioPublic.js";
import {
  normalizeJobExecutionDecision,
  type ExecutionFileRevision,
} from "../shared/jobExecution.js";
import { analysisTempRoot, outputRoot } from "./config.js";
import type {
  CurrentOutputAuthorityJob,
  OutputAuthorityJob,
} from "./jobs.js";
import {
  normalizeOutputPublicationAuthority,
  openValidOutputPublicationAuthority,
  readStatBoundOutputPublicationAuthority,
  terminalJobAuthoritySha256,
  type OutputPublicationAuthority,
} from "./outputPublication.js";
import { OutputQualityError } from "./outputs.js";
import { runProvenanceFingerprintMatches } from "./runProvenance.js";
import {
  assertMatchingT2aAudioEvaluatorBindings,
  recoverT2aAudioSandboxUnits,
  resolveT2aAudioEvaluatorBinding,
  runT2aAudioEvaluator,
  T2aAudioEvaluatorCancelledError,
  T2aAudioEvaluatorTerminationError,
  type T2aAudioEvaluatorBinding,
  type T2aAudioEvaluationTarget,
} from "./t2aAudioEvaluator.js";

export const T2A_AUDIO_ANALYSIS_RECORD_VERSION = "ltx-studio-t2a-audio-analysis.v3" as const;
const ANALYSIS_SUFFIX = ".ltx-t2a-audio-analysis.json";
const SETTINGS_SUFFIX = ".ltx-settings.json";
const MAX_AUDIO_BYTES = 256 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 8 * 1024 * 1024;
const MAX_ANALYSIS_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const fileRevisionSchema = z.object({
  sizeBytes: z.number().int().positive().max(MAX_AUDIO_BYTES),
  modifiedAtMs: z.number().finite().nonnegative(),
  changedAtMs: z.number().finite().nonnegative(),
  fileId: z.string().regex(/^\d{1,64}$/u),
  deviceId: z.string().regex(/^\d{1,64}$/u),
  mode: z.number().int().nonnegative(),
  uid: z.number().int().nonnegative(),
  gid: z.number().int().nonnegative(),
  nlink: z.literal(1),
}).strict();

export const t2aAudioTargetBindingSchema = z.object({
  outputName: outputNameSchema.refine((value) => value.toLowerCase().endsWith(".wav")),
  jobId: z.string().uuid(),
  outputSha256: sha256Schema,
  outputRevision: fileRevisionSchema,
  publicationSha256: sha256Schema,
  executionDecisionSha256: sha256Schema,
  rawRequestSha256: sha256Schema,
  normalizedRequestSha256: sha256Schema,
  dialogueSha256: sha256Schema,
  settingsSha256: sha256Schema,
  settingsRevision: fileRevisionSchema,
  peakCeilingDbfs: z.number().finite().min(-60).max(0),
}).strict();

export type T2aAudioTargetBinding = z.infer<typeof t2aAudioTargetBindingSchema>;

const analysisErrorSchema = z.object({
  code: z.enum(["analysis-failed", "cancelled"]),
  message: z.string().min(1).max(500),
}).strict();

export const t2aAudioAnalysisRecordSchema = z.object({
  schemaVersion: z.literal(T2A_AUDIO_ANALYSIS_RECORD_VERSION),
  analysisKind: z.literal("t2a-audio-qa"),
  mediaKind: z.literal("audio"),
  analysisId: z.string().uuid(),
  claimScope: t2aAudioClaimScopeSchema,
  evaluatorFingerprint: sha256Schema,
  targetBinding: t2aAudioTargetBindingSchema,
  attempt: z.number().int().positive(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  progress: z.number().int().min(0).max(100),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  error: analysisErrorSchema.nullable(),
  result: t2aAudioQualitySchema.nullable(),
}).strict().superRefine((value, context) => {
  const completed = value.status === "completed";
  const failed = value.status === "failed";
  const cancelled = value.status === "cancelled";
  if (completed && (value.progress !== 100 || value.finishedAt === null
    || value.error !== null || value.result?.analysisStatus !== "measured")) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Eine abgeschlossene T2A-Analyse benoetigt ein vollstaendiges Ergebnis.",
    });
  }
  if (failed && (value.finishedAt === null
    || value.error?.code !== "analysis-failed"
    || value.result?.analysisStatus === "measured")) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Eine fehlgeschlagene T2A-Analyse benoetigt genau einen Fehler.",
    });
  }
  if (cancelled && (value.finishedAt === null
    || value.error?.code !== "cancelled" || value.result !== null)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Eine abgebrochene T2A-Analyse benoetigt einen Abbruchgrund ohne Ergebnis.",
    });
  }
  if (!completed && !failed && !cancelled && (value.finishedAt !== null
    || value.error !== null || value.result !== null || value.progress === 100)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Eine aktive T2A-Analyse darf kein terminales Ergebnis enthalten.",
    });
  }
  if (value.status === "queued" && (value.progress !== 0 || value.startedAt !== null)) {
    context.addIssue({
      code: "custom",
      path: ["progress"],
      message: "Eine wartende T2A-Analyse darf noch nicht gestartet sein.",
    });
  }
  if (value.status === "running" && value.startedAt === null) {
    context.addIssue({
      code: "custom",
      path: ["startedAt"],
      message: "Eine laufende T2A-Analyse benoetigt eine Startzeit.",
    });
  }
  if (value.result?.analysisStatus === "measured") {
    if (value.result.sourceSnapshot.sha256 !== value.targetBinding.outputSha256
      || value.result.sourceSnapshot.byteLength !== value.targetBinding.outputRevision.sizeBytes
      || value.result.policy.peakCeilingDbfs !== value.targetBinding.peakCeilingDbfs
      || value.result.dialogueEvaluation.expectedTranscriptSha256
        !== value.targetBinding.dialogueSha256) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "T2A-Messergebnis und persistierte Authority-Bindung widersprechen einander.",
      });
    }
  }
  if (value.result !== null) {
    const blockers = value.result.ia2vEligibility.status === "blocked"
      ? value.result.ia2vEligibility.blockers
      : [];
    const developmentBlocked = blockers.includes("development-runtime-unattested");
    if ((value.claimScope === "development" && !developmentBlocked)
      || (value.claimScope === "sealed-release" && developmentBlocked)) {
      context.addIssue({
        code: "custom",
        path: ["result", "ia2vEligibility"],
        message: "T2A-Claim-Scope und IA2V-Runtime-Blocker widersprechen einander.",
      });
    }
  }
});

export type T2aAudioAnalysisRecord = z.infer<typeof t2aAudioAnalysisRecordSchema>;

export type T2aAudioAnalysisTarget = {
  binding: T2aAudioTargetBinding;
  request: GenerationRequest;
  dialogue: string;
  sourceOutputPath: string;
};

export type T2aAudioAnalysisLease = {
  target: T2aAudioAnalysisTarget & T2aAudioEvaluationTarget;
  verify: (jobs?: readonly OutputAuthorityJob[]) => void;
  release: () => void;
};

function now(): string {
  return new Date().toISOString();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonDigest(value: unknown): string {
  return digest(canonicalJson(value));
}

function revisionsEqual(left: ExecutionFileRevision, right: ExecutionFileRevision): boolean {
  return left.sizeBytes === right.sizeBytes
    && left.modifiedAtMs === right.modifiedAtMs
    && left.changedAtMs === right.changedAtMs
    && left.fileId === right.fileId
    && left.deviceId === right.deviceId
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink;
}

function revision(stats: Stats): ExecutionFileRevision {
  return {
    sizeBytes: stats.size,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
    fileId: String(stats.ino),
    deviceId: String(stats.dev),
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    nlink: stats.nlink as 1,
  };
}

function hashDescriptor(descriptor: number, size: number): string {
  const hasher = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (count <= 0) throw new OutputQualityError("Audio-Snapshot endete vorzeitig.", 409);
    hasher.update(buffer.subarray(0, count));
    offset += count;
  }
  return hasher.digest("hex");
}

type OpenSettingsAuthority = {
  descriptor: number;
  path: string;
  revision: ExecutionFileRevision;
  sha256: string;
  document: Record<string, unknown>;
};

function readDescriptorBytes(descriptor: number, size: number): Buffer {
  const content = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, content, offset, size - offset, offset);
    if (count <= 0) throw new OutputQualityError("T2A-Settings-Sidecar endete vorzeitig.", 409);
    offset += count;
  }
  return content;
}

function openSettingsAuthority(root: string, outputName: string): OpenSettingsAuthority {
  const path = join(root, `${outputName}${SETTINGS_SUFFIX}`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const pathStats = lstatSync(path);
    if (!before.isFile()
      || before.nlink !== 1
      || before.size <= 0
      || before.size > MAX_SETTINGS_BYTES
      || before.uid !== (process.getuid?.() ?? before.uid)
      || before.gid !== (process.getgid?.() ?? before.gid)
      || (before.mode & 0o777) !== 0o600
      || pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || !revisionsEqual(revision(before), revision(pathStats))) {
      throw new OutputQualityError("T2A-Settings-Sidecar besitzt keine starke private Dateibindung.", 409);
    }
    const content = readDescriptorBytes(descriptor, before.size);
    const after = fstatSync(descriptor);
    if (!revisionsEqual(revision(before), revision(after))) {
      throw new OutputQualityError("T2A-Settings-Sidecar aenderte sich waehrend des Lesens.", 409);
    }
    const parsed = JSON.parse(content.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OutputQualityError("T2A-Settings-Sidecar ist strukturell ungueltig.", 409);
    }
    const result = {
      descriptor,
      path,
      revision: revision(after),
      sha256: createHash("sha256").update(content).digest("hex"),
      document: parsed as Record<string, unknown>,
    };
    descriptor = null;
    return result;
  } catch (error) {
    if (error instanceof OutputQualityError) throw error;
    throw new OutputQualityError(
      "T2A-Settings-Sidecar konnte nicht autoritativ gelesen werden.",
      409,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function verifySettingsAuthority(
  settings: OpenSettingsAuthority,
  expectedSha256 = settings.sha256,
  expectedRevision = settings.revision,
): void {
  const fdStats = fstatSync(settings.descriptor);
  const pathStats = lstatSync(settings.path);
  if (!fdStats.isFile()
    || fdStats.nlink !== 1
    || (fdStats.mode & 0o777) !== 0o600
    || pathStats.isSymbolicLink()
    || !pathStats.isFile()
    || !revisionsEqual(revision(fdStats), expectedRevision)
    || !revisionsEqual(revision(pathStats), expectedRevision)
    || hashDescriptor(settings.descriptor, fdStats.size) !== expectedSha256
    || !revisionsEqual(revision(fstatSync(settings.descriptor)), expectedRevision)) {
    throw new OutputQualityError("T2A-Settings-Sidecar wurde ersetzt oder veraendert.", 409);
  }
}

function rawPeakCeiling(request: unknown): number | null {
  if (!request || typeof request !== "object" || Array.isArray(request)) return null;
  const textToAudio = (request as Record<string, unknown>).textToAudio;
  if (!textToAudio || typeof textToAudio !== "object" || Array.isArray(textToAudio)
    || !Object.hasOwn(textToAudio, "peakCeilingDbfs")) return null;
  const value = (textToAudio as Record<string, unknown>).peakCeilingDbfs;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isCurrentJob(job: OutputAuthorityJob): job is CurrentOutputAuthorityJob {
  return !("schemaVersion" in job);
}

function resolveAuthorityJob(
  authority: OutputPublicationAuthority,
  jobs: readonly OutputAuthorityJob[],
  outputPath: string,
): {
  job: CurrentOutputAuthorityJob;
  request: GenerationRequest;
  rawRequest: unknown;
  binding: Omit<T2aAudioTargetBinding, "settingsSha256" | "settingsRevision">;
} {
  const matchingJobs = jobs.filter((job) => job.id === authority.jobId);
  if (matchingJobs.length !== 1 || !isCurrentJob(matchingJobs[0])) {
    throw new OutputQualityError(
      "Nur neue, vollstaendig request-gebundene T2A-Ausgaben koennen analysiert werden.",
      409,
    );
  }
  const job = matchingJobs[0];
  if (job.status !== "completed"
    || !job.finishedAt
    || job.outputName !== authority.outputName
    || job.outputName.toLowerCase().endsWith(".wav") === false
    || job.request.mode !== "text-to-audio"
    || job.id !== authority.jobId
    || job.finishedAt !== authority.publishedAt
    || !Object.hasOwn(job, "authorityBoundRequest")
    || !Object.hasOwn(job, "authorityRequestSha256")
    || typeof job.authorityRequestSha256 !== "string") {
    throw new OutputQualityError("T2A-Job- und Publikationsautoritaet sind unvollstaendig.", 409);
  }
  const rawRequest = structuredClone(job.authorityBoundRequest);
  const rawRequestSha256 = jsonDigest(rawRequest);
  const rawPeak = rawPeakCeiling(rawRequest);
  if (rawPeak === null) {
    throw new OutputQualityError(
      "Legacy-T2A-Ausgabe ohne historisch explizite Sample-Peak-Policy wird nicht still analysiert.",
      409,
    );
  }
  const migratedRequest = migrateGenerationRequest(structuredClone(rawRequest));
  const parsedRequest = generationRequestSchema.safeParse(job.request);
  if (!migratedRequest
    || !parsedRequest.success
    || migratedRequest.mode !== "text-to-audio"
    || canonicalJson(migratedRequest) !== canonicalJson(parsedRequest.data)
    || rawPeak !== parsedRequest.data.textToAudio.peakCeilingDbfs
    || rawRequestSha256 !== job.authorityRequestSha256) {
    throw new OutputQualityError("Roher und normalisierter T2A-Request widersprechen einander.", 409);
  }
  const request = parsedRequest.data;
  const normalizedRequestSha256 = jsonDigest(request);
  const decision = normalizeJobExecutionDecision(job.executionDecision);
  if (!decision
    || decision.executionClass === "pending"
    || decision.executionClass !== job.executionClass
    || decision.requestSha256 !== rawRequestSha256
    || decision.protocolSha256 !== (job.experiment?.protocolSha256 ?? null)
    || !job.runProvenance
    || !runProvenanceFingerprintMatches(job.runProvenance)
    || canonicalJson(job.runProvenance.executionDecision) !== canonicalJson(decision)) {
    throw new OutputQualityError("T2A-ExecutionDecision oder Laufprovenienz ist ungueltig.", 409);
  }
  const executionDecisionSha256 = jsonDigest(decision);
  const boundPublication = job.outputPublication
    ? normalizeOutputPublicationAuthority(job.outputPublication, outputPath)
    : null;
  const expectedJobAuthoritySha256 = terminalJobAuthoritySha256({
    jobId: job.id,
    status: "completed",
    outputName: job.outputName,
    finishedAt: job.finishedAt,
    executionClass: decision.executionClass,
    executionDecisionSha256,
    requestSha256: rawRequestSha256,
    protocolSha256: decision.protocolSha256,
    jobPersistenceRevision: authority.jobPersistenceRevision,
  });
  if (!boundPublication
    || canonicalJson(boundPublication) !== canonicalJson(authority)
    || authority.executionDecisionSha256 !== executionDecisionSha256
    || authority.jobAuthoritySha256 !== expectedJobAuthoritySha256
    || (decision.executionClass === "cpu-only"
      && (decision.operation.state !== "succeeded"
        || decision.operation.output === null
        || decision.operation.output.sha256 !== authority.output.sha256))) {
    throw new OutputQualityError("T2A-Publikation ist nicht terminal an den Job gebunden.", 409);
  }
  const dialogue = request.promptParts.dialogue;
  const binding: Omit<T2aAudioTargetBinding, "settingsSha256" | "settingsRevision"> = {
    outputName: authority.outputName,
    jobId: authority.jobId,
    outputSha256: authority.output.sha256,
    outputRevision: authority.output.revision,
    publicationSha256: jsonDigest(authority),
    executionDecisionSha256,
    rawRequestSha256,
    normalizedRequestSha256,
    dialogueSha256: digest(dialogue),
    peakCeilingDbfs: request.textToAudio.peakCeilingDbfs,
  };
  return { job, request, binding, rawRequest };
}

function bindSettingsAuthority(
  settings: OpenSettingsAuthority,
  resolved: ReturnType<typeof resolveAuthorityJob>,
  authority: OutputPublicationAuthority,
): T2aAudioTargetBinding {
  const document = settings.document;
  const settingsDecision = normalizeJobExecutionDecision(document.executionDecision);
  if (document.schemaVersion !== "ltx-studio-output.v7"
    || document.outputName !== authority.outputName
    || document.jobId !== authority.jobId
    || document.completedAt !== authority.publishedAt
    || document.sizeBytes !== authority.output.revision.sizeBytes
    || typeof document.modifiedAtMs !== "number"
    || Math.abs(document.modifiedAtMs - authority.output.revision.modifiedAtMs) >= 1
    || typeof document.changedAtMs !== "number"
    || Math.abs(document.changedAtMs - authority.output.revision.changedAtMs) >= 1
    || document.fileId !== authority.output.revision.fileId
    || canonicalJson(document.request) !== canonicalJson(resolved.rawRequest)
    || jsonDigest(document.request) !== resolved.binding.rawRequestSha256
    || !settingsDecision
    || jsonDigest(settingsDecision) !== resolved.binding.executionDecisionSha256
    || canonicalJson(document.runProvenance) !== canonicalJson(resolved.job.runProvenance)) {
    throw new OutputQualityError(
      "T2A-Settings-Sidecar widerspricht Raw-Request, Job, Decision oder Publikation.",
      409,
    );
  }
  return t2aAudioTargetBindingSchema.parse({
    ...resolved.binding,
    settingsSha256: settings.sha256,
    settingsRevision: settings.revision,
  });
}

export function resolveT2aAudioAnalysisTarget(
  root: string,
  outputName: string,
  jobs: readonly OutputAuthorityJob[],
): T2aAudioAnalysisTarget {
  if (!outputNameSchema.safeParse(outputName).success
    || !outputName.toLowerCase().endsWith(".wav")
    || basename(outputName) !== outputName) {
    throw new OutputQualityError("T2A-Audioausgabe nicht gefunden.", 404);
  }
  const source = openValidOutputPublicationAuthority(root, outputName);
  if (!source) throw new OutputQualityError("T2A-Audioausgabe nicht gefunden.", 404);
  let settings: OpenSettingsAuthority | null = null;
  try {
    if (source.authority.output.revision.sizeBytes > MAX_AUDIO_BYTES) {
      throw new OutputQualityError("T2A-Audioausgabe ueberschreitet das Analyselimit.", 409);
    }
    const resolved = resolveAuthorityJob(source.authority, jobs, source.outputPath);
    settings = openSettingsAuthority(root, outputName);
    const binding = bindSettingsAuthority(settings, resolved, source.authority);
    verifySettingsAuthority(settings);
    return {
      binding,
      request: resolved.request,
      dialogue: resolved.request.promptParts.dialogue,
      sourceOutputPath: source.outputPath,
    };
  } finally {
    if (settings !== null) closeSync(settings.descriptor);
    closeSync(source.fd);
  }
}

function resolveT2aAudioListingBinding(
  root: string,
  outputName: string,
  jobs: readonly OutputAuthorityJob[],
): T2aAudioTargetBinding {
  if (!outputNameSchema.safeParse(outputName).success
    || !outputName.toLowerCase().endsWith(".wav")
    || basename(outputName) !== outputName) {
    throw new OutputQualityError("T2A-Audioausgabe nicht gefunden.", 404);
  }
  const authority = readStatBoundOutputPublicationAuthority(root, outputName);
  if (!authority) throw new OutputQualityError("T2A-Audioausgabe nicht gefunden.", 404);
  if (authority.output.revision.sizeBytes > MAX_AUDIO_BYTES) {
    throw new OutputQualityError("T2A-Audioausgabe ueberschreitet das Analyselimit.", 409);
  }
  let settings: OpenSettingsAuthority | null = null;
  try {
    const resolved = resolveAuthorityJob(authority, jobs, authority.output.path);
    settings = openSettingsAuthority(root, outputName);
    const binding = bindSettingsAuthority(settings, resolved, authority);
    verifySettingsAuthority(settings);
    return binding;
  } finally {
    if (settings !== null) closeSync(settings.descriptor);
  }
}

function assertPrivateTempRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stats = lstatSync(root);
  if (stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.uid !== (process.getuid?.() ?? stats.uid)
    || stats.gid !== (process.getgid?.() ?? stats.gid)
    || (stats.mode & 0o077) !== 0) {
    throw new OutputQualityError("T2A-Analyse-Temporaerbereich ist nicht privat.", 409);
  }
}

export function cleanupT2aAudioSnapshots(root = analysisTempRoot): number {
  assertPrivateTempRoot(root);
  const managedName = /^t2a-audio-[A-Za-z0-9]{6}$/u;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !managedName.test(entry.name)) continue;
    const path = join(root, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()
      || !stats.isDirectory()
      || stats.uid !== (process.getuid?.() ?? stats.uid)
      || stats.gid !== (process.getgid?.() ?? stats.gid)) continue;
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

function verifySnapshot(
  descriptor: number,
  path: string,
  expectedRevision: ExecutionFileRevision,
  expectedSha256: string,
  label = "Audio",
): void {
  const fdStats = fstatSync(descriptor);
  const pathStats = lstatSync(path);
  const fdRevision = revision(fdStats);
  if (!fdStats.isFile()
    || fdStats.nlink !== 1
    || (fdStats.mode & 0o777) !== 0o444
    || pathStats.isSymbolicLink()
    || !pathStats.isFile()
    || !revisionsEqual(fdRevision, revision(pathStats))
    || !revisionsEqual(fdRevision, expectedRevision)
    || hashDescriptor(descriptor, fdStats.size) !== expectedSha256
    || !revisionsEqual(revision(fstatSync(descriptor)), fdRevision)) {
    throw new OutputQualityError(`Privater T2A-${label}-Snapshot wurde ersetzt oder veraendert.`, 409);
  }
}

function writeReadonlySnapshot(path: string, bytes: Buffer): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (written <= 0) throw new OutputQualityError("T2A-Text-Snapshot blieb unvollstaendig.", 409);
      offset += written;
    }
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o444);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

class T2aAudioLeaseCleanupError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = "T2aAudioLeaseCleanupError";
  }
}

function cleanupT2aAudioLeaseResources(
  descriptors: readonly (number | null)[],
  privateRoot: string | null,
): void {
  const failures: unknown[] = [];
  for (const descriptor of descriptors) {
    if (descriptor === null) continue;
    try {
      closeSync(descriptor);
    } catch (error) {
      failures.push(error);
    }
  }
  if (privateRoot !== null) {
    try {
      rmSync(privateRoot, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new T2aAudioLeaseCleanupError(
      failures,
      "Private T2A-Analyseressourcen konnten nicht vollstaendig freigegeben werden.",
    );
  }
}

export function openT2aAudioAnalysisTarget(
  root: string,
  outputName: string,
  jobs: readonly OutputAuthorityJob[],
  tempRoot = analysisTempRoot,
): T2aAudioAnalysisLease {
  assertPrivateTempRoot(tempRoot);
  const source = openValidOutputPublicationAuthority(root, outputName);
  if (!source) throw new OutputQualityError("T2A-Audioausgabe nicht gefunden.", 404);
  let snapshotDescriptor: number | null = null;
  let transcriptDescriptor: number | null = null;
  let snapshotRoot: string | null = null;
  let settings: OpenSettingsAuthority | null = null;
  let sourceClosed = false;
  try {
    if (source.authority.output.revision.sizeBytes > MAX_AUDIO_BYTES) {
      throw new OutputQualityError("T2A-Audioausgabe ueberschreitet das Analyselimit.", 409);
    }
    const resolved = resolveAuthorityJob(source.authority, jobs, source.outputPath);
    settings = openSettingsAuthority(root, outputName);
    const binding = bindSettingsAuthority(settings, resolved, source.authority);
    verifySettingsAuthority(settings);
    const sourceBefore = fstatSync(source.fd);
    if (!sourceBefore.isFile()
      || !revisionsEqual(revision(sourceBefore), source.authority.output.revision)
      || hashDescriptor(source.fd, sourceBefore.size) !== source.authority.output.sha256) {
      throw new OutputQualityError("T2A-Audioausgabe stimmt nicht mit der Publikationsautoritaet ueberein.", 409);
    }
    snapshotRoot = mkdtempSync(join(tempRoot, "t2a-audio-"));
    chmodSync(snapshotRoot, 0o700);
    const snapshotPath = join(snapshotRoot, "authority.wav");
    const writableDescriptor = openSync(
      snapshotPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < sourceBefore.size) {
        const count = readSync(
          source.fd,
          buffer,
          0,
          Math.min(buffer.length, sourceBefore.size - offset),
          offset,
        );
        if (count <= 0) throw new OutputQualityError("T2A-Audioquelle endete vorzeitig.", 409);
        let written = 0;
        while (written < count) {
          const writeCount = writeSync(
            writableDescriptor,
            buffer,
            written,
            count - written,
            offset + written,
          );
          if (writeCount <= 0) throw new OutputQualityError("T2A-Audio-Snapshot blieb unvollstaendig.", 409);
          written += writeCount;
        }
        offset += count;
      }
      fsyncSync(writableDescriptor);
      fchmodSync(writableDescriptor, 0o444);
      fsyncSync(writableDescriptor);
    } finally {
      closeSync(writableDescriptor);
    }
    const sourceAfter = fstatSync(source.fd);
    if (!revisionsEqual(revision(sourceBefore), revision(sourceAfter))
      || hashDescriptor(source.fd, sourceAfter.size) !== source.authority.output.sha256) {
      throw new OutputQualityError("T2A-Audioquelle aenderte sich waehrend der Snapshot-Erzeugung.", 409);
    }
    snapshotDescriptor = openSync(snapshotPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const snapshotRevision = revision(fstatSync(snapshotDescriptor));
    verifySnapshot(
      snapshotDescriptor,
      snapshotPath,
      snapshotRevision,
      source.authority.output.sha256,
    );
    const transcriptText = resolved.request.promptParts.dialogue;
    if (digest(transcriptText) !== binding.dialogueSha256) {
      throw new OutputQualityError("Gebundener T2A-Dialogtext ist ungueltig.", 409);
    }
    const transcriptBytes = Buffer.from(`${canonicalJson({
      schemaVersion: "ltx-studio-private-transcript.v1",
      text: transcriptText,
    })}\n`, "utf8");
    if (transcriptBytes.length > MAX_TRANSCRIPT_BYTES) {
      throw new OutputQualityError("Gebundener T2A-Dialogtext ist zu gross.", 409);
    }
    const transcriptSnapshotSha256 = createHash("sha256").update(transcriptBytes).digest("hex");
    const transcriptSnapshotPath = join(snapshotRoot, "transcript.utf8");
    writeReadonlySnapshot(transcriptSnapshotPath, transcriptBytes);
    transcriptDescriptor = openSync(
      transcriptSnapshotPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const transcriptRevision = revision(fstatSync(transcriptDescriptor));
    verifySnapshot(
      transcriptDescriptor,
      transcriptSnapshotPath,
      transcriptRevision,
      transcriptSnapshotSha256,
      "Dialogtext",
    );
    closeSync(source.fd);
    sourceClosed = true;
    const target: T2aAudioAnalysisLease["target"] = {
      binding,
      request: resolved.request,
      dialogue: resolved.request.promptParts.dialogue,
      sourceOutputPath: source.outputPath,
      audioSnapshotPath: snapshotPath,
      transcriptSnapshotPath,
      transcriptSnapshotSha256,
      audioSha256: binding.outputSha256,
      dialogueSha256: binding.dialogueSha256,
      peakCeilingDbfs: binding.peakCeilingDbfs,
    };
    let released = false;
    const verify = (currentJobs: readonly OutputAuthorityJob[] = jobs) => {
      if (released || snapshotDescriptor === null || transcriptDescriptor === null) {
        throw new OutputQualityError("T2A-Audio-Analyselease ist bereits geschlossen.", 409);
      }
      verifySnapshot(
        snapshotDescriptor,
        snapshotPath,
        snapshotRevision,
        target.binding.outputSha256,
      );
      verifySnapshot(
        transcriptDescriptor,
        transcriptSnapshotPath,
        transcriptRevision,
        target.transcriptSnapshotSha256,
        "Dialogtext",
      );
      if (settings === null) {
        throw new OutputQualityError("T2A-Settings-Authority ist nicht mehr geoeffnet.", 409);
      }
      verifySettingsAuthority(
        settings,
        target.binding.settingsSha256,
        target.binding.settingsRevision,
      );
      const current = resolveT2aAudioAnalysisTarget(root, outputName, currentJobs);
      if (canonicalJson(current.binding) !== canonicalJson(target.binding)) {
        throw new OutputQualityError("T2A-Authority aenderte sich waehrend der Analyse.", 409);
      }
    };
    const release = () => {
      if (released) return;
      released = true;
      const audioDescriptor = snapshotDescriptor;
      snapshotDescriptor = null;
      const dialogueDescriptor = transcriptDescriptor;
      transcriptDescriptor = null;
      const settingsDescriptor = settings?.descriptor ?? null;
      settings = null;
      const privateRoot = snapshotRoot;
      snapshotRoot = null;
      cleanupT2aAudioLeaseResources(
        [audioDescriptor, dialogueDescriptor, settingsDescriptor],
        privateRoot,
      );
    };
    return { target, verify, release };
  } catch (error) {
    try {
      cleanupT2aAudioLeaseResources([
        sourceClosed ? null : source.fd,
        snapshotDescriptor,
        transcriptDescriptor,
        settings?.descriptor ?? null,
      ], snapshotRoot);
    } catch (cleanupError) {
      throw new T2aAudioLeaseCleanupError(
        [error, cleanupError],
        "T2A-Analyselease konnte nach einem Akquisitionsfehler nicht sicher bereinigt werden.",
      );
    }
    throw error;
  }
}

export function t2aAudioAnalysisPath(root: string, outputName: string): string {
  return join(root, `${outputName}${ANALYSIS_SUFFIX}`);
}

function parseRecord(path: string, expectedOutputName?: string): T2aAudioAnalysisRecord | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const pathStats = lstatSync(path);
    if (!before.isFile()
      || before.nlink !== 1
      || before.size <= 0
      || before.size > MAX_ANALYSIS_RECORD_BYTES
      || before.uid !== (process.getuid?.() ?? before.uid)
      || before.gid !== (process.getgid?.() ?? before.gid)
      || (before.mode & 0o777) !== 0o600
      || pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || !revisionsEqual(revision(before), revision(pathStats))) return null;
    const bytes = readDescriptorBytes(descriptor, before.size);
    const after = fstatSync(descriptor);
    if (!revisionsEqual(revision(before), revision(after))) return null;
    const parsed = t2aAudioAnalysisRecordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success
      || (expectedOutputName !== undefined
        && parsed.data.targetBinding.outputName !== expectedOutputName)) return null;
    return parsed.data;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function readT2aAudioAnalysis(
  root: string,
  target: Pick<T2aAudioAnalysisTarget, "binding">,
  evaluatorFingerprint: string,
  claimScope: T2aAudioClaimScope,
): T2aAudioAnalysisRecord | null {
  const record = parseRecord(
    t2aAudioAnalysisPath(root, target.binding.outputName),
    target.binding.outputName,
  );
  if (!record
    || record.evaluatorFingerprint !== evaluatorFingerprint
    || record.claimScope !== claimScope
    || canonicalJson(record.targetBinding) !== canonicalJson(target.binding)) return null;
  return record;
}

export function writeT2aAudioAnalysis(root: string, record: T2aAudioAnalysisRecord): void {
  const parsed = t2aAudioAnalysisRecordSchema.parse(record);
  const path = t2aAudioAnalysisPath(root, parsed.targetBinding.outputName);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let descriptor: number | null = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, path);
    const rootDescriptor = openSync(root, "r");
    try {
      fsyncSync(rootDescriptor);
    } finally {
      closeSync(rootDescriptor);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // Preserve the primary write/rename failure; startup recovery never treats
      // random-UUID .tmp files as analysis authority.
    }
  }
}

export function removeT2aAudioAnalysis(root: string, outputName: string): void {
  if (!outputNameSchema.safeParse(outputName).success
    || !outputName.toLowerCase().endsWith(".wav")
    || basename(outputName) !== outputName) {
    throw new OutputQualityError("T2A-Audioausgabe nicht gefunden.", 404);
  }
  let removed = false;
  try {
    unlinkSync(t2aAudioAnalysisPath(root, outputName));
    removed = true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new Error("T2A-Analyseartefakt konnte nicht sicher entfernt werden.");
    }
  }
  if (removed) {
    let rootDescriptor: number | null = null;
    try {
      rootDescriptor = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
      fsyncSync(rootDescriptor);
    } catch {
      throw new Error("T2A-Analyseartefakt wurde entfernt, aber nicht dauerhaft bestaetigt.");
    } finally {
      if (rootDescriptor !== null) closeSync(rootDescriptor);
    }
  }
}

function safeManagerBoundaryError(error: unknown, operation: string): Error {
  if (error instanceof OutputQualityError) return error;
  return new Error(`T2A-Audioanalyse: ${operation} konnte nicht sicher ausgefuehrt werden.`);
}

export function recoverInterruptedT2aAudioAnalyses(
  root: string,
  interruptedAt = now(),
  evaluatorBindingResolver?: () => T2aAudioEvaluatorBinding,
): number {
  const interrupted: T2aAudioAnalysisRecord[] = [];
  let recovered = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(ANALYSIS_SUFFIX)) continue;
    const outputName = entry.name.slice(0, -ANALYSIS_SUFFIX.length);
    if (!outputNameSchema.safeParse(outputName).success
      || !outputName.toLowerCase().endsWith(".wav")
      || basename(outputName) !== outputName) continue;
    const record = parseRecord(join(root, entry.name), outputName);
    if (!record || !["queued", "running"].includes(record.status)) continue;
    interrupted.push(record);
  }
  let currentBinding: T2aAudioEvaluatorBinding | null = null;
  if (interrupted.length > 0 && evaluatorBindingResolver) {
    try {
      currentBinding = evaluatorBindingResolver();
      assertMatchingT2aAudioEvaluatorBindings(currentBinding, currentBinding);
    } catch {
      // Recovery may terminalize an interrupted private record without claiming
      // that its evaluator authority is current. Start/read remain fail-closed
      // through the live combined resolver after initialization.
      currentBinding = null;
    }
  }
  for (const record of interrupted) {
    const bindingChanged = currentBinding !== null && (
      record.evaluatorFingerprint !== currentBinding.evaluatorFingerprint
      || record.claimScope !== currentBinding.claimScope
    );
    writeT2aAudioAnalysis(root, {
      ...record,
      status: "failed",
      finishedAt: interruptedAt,
      updatedAt: interruptedAt,
      error: {
        code: "analysis-failed",
        message: bindingChanged
          ? "Studio wurde neu gestartet; die kombinierte T2A-Evaluator-Bindung hat sich geaendert."
          : "Studio wurde waehrend der T2A-Audioanalyse neu gestartet.",
      },
      result: null,
    });
    recovered += 1;
  }
  return recovered;
}

type AnalysisTask = {
  lease: T2aAudioAnalysisLease;
  record: T2aAudioAnalysisRecord;
  abortController: AbortController;
  cancellationRequested: boolean;
};

export type T2aAudioAnalysisManagerOptions = {
  tempRoot?: string;
  evaluator?: typeof runT2aAudioEvaluator;
  evaluatorBinding?: () => T2aAudioEvaluatorBinding;
  expectedEvaluatorBinding?: T2aAudioEvaluatorBinding;
  /** @deprecated Test-only compatibility; production resolves the combined binding. */
  evaluatorFingerprint?: () => string;
  /** @deprecated Test-only compatibility; production resolves the combined binding. */
  evaluatorClaimScope?: () => T2aAudioClaimScope;
  sandboxRecovery?: () => Promise<void>;
};

export class T2aAudioAnalysisManager {
  private readonly queue: string[] = [];
  private readonly tasks = new Map<string, AnalysisTask>();
  private readonly activeByOutput = new Map<string, string>();
  private runningId: string | null = null;
  private lifecycleFailure: Error | null = null;
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    private readonly jobs: () => readonly OutputAuthorityJob[],
    private readonly root = outputRoot,
    private readonly options: T2aAudioAnalysisManagerOptions = {},
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializationPromise) {
      this.initializationPromise = (async () => {
        await (this.options.sandboxRecovery ?? recoverT2aAudioSandboxUnits)();
        cleanupT2aAudioSnapshots(this.options.tempRoot ?? analysisTempRoot);
        recoverInterruptedT2aAudioAnalyses(
          this.root,
          now(),
          () => this.evaluatorBinding(),
        );
        this.initialized = true;
      })().catch((error: unknown) => {
        this.lifecycleFailure = error instanceof Error ? error : new Error(String(error));
        throw this.lifecycleFailure;
      });
    }
    await this.initializationPromise;
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("T2A-Analysemanager wurde noch nicht sicher initialisiert.");
    }
  }

  private evaluatorBinding(): {
    evaluatorFingerprint: string;
    claimScope: T2aAudioClaimScope;
  } {
    let binding: T2aAudioEvaluatorBinding;
    if (this.options.evaluatorBinding) {
      if (this.options.evaluatorFingerprint || this.options.evaluatorClaimScope) {
        throw new Error(
          "Kombiniertes T2A-Evaluator-Binding darf nicht mit Legacy-Injektionen gemischt werden.",
        );
      }
      binding = this.options.evaluatorBinding();
    } else if (this.options.evaluatorFingerprint) {
      const evaluatorFingerprint = this.options.evaluatorFingerprint();
      const claimScope = t2aAudioClaimScopeSchema.parse(
        this.options.evaluatorClaimScope?.() ?? "sealed-release",
      );
      if (!sha256Schema.safeParse(evaluatorFingerprint).success) {
        throw new Error("T2A-Evaluator-Fingerprint ist ungueltig.");
      }
      binding = { evaluatorFingerprint, claimScope };
    } else if (this.options.evaluatorClaimScope) {
      throw new Error("T2A-Evaluator-Claim-Scope darf nicht ohne Fingerprint injiziert werden.");
    } else {
      binding = resolveT2aAudioEvaluatorBinding();
    }
    assertMatchingT2aAudioEvaluatorBindings(binding, binding);
    if (this.options.expectedEvaluatorBinding) {
      assertMatchingT2aAudioEvaluatorBindings(this.options.expectedEvaluatorBinding, binding);
    }
    return binding;
  }

  private rememberLifecycleFailure(error: unknown): Error {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.lifecycleFailure ??= failure;
    return failure;
  }

  private failQueuedTasksAfterLifecycleFailure(): void {
    const queuedIds = this.queue.splice(0);
    for (const analysisId of queuedIds) {
      const task = this.tasks.get(analysisId);
      if (!task) continue;
      try {
        if (task.record.status === "queued") {
          const finishedAt = now();
          task.record = t2aAudioAnalysisRecordSchema.parse({
            ...task.record,
            status: "failed",
            finishedAt,
            updatedAt: finishedAt,
            error: {
              code: "analysis-failed",
              message: "T2A-Audioanalyse wurde nach einem Lifecycle-Fehler nicht gestartet.",
            },
            result: null,
          });
          writeT2aAudioAnalysis(this.root, task.record);
        }
      } catch (error) {
        this.rememberLifecycleFailure(error);
      } finally {
        try {
          task.lease.release();
        } catch (error) {
          this.rememberLifecycleFailure(error);
        } finally {
          this.tasks.delete(analysisId);
          if (this.activeByOutput.get(task.lease.target.binding.outputName) === analysisId) {
            this.activeByOutput.delete(task.lease.target.binding.outputName);
          }
        }
      }
    }
  }

  getStored(outputName: string): T2aAudioAnalysisRecord | null {
    this.assertInitialized();
    if (!outputNameSchema.safeParse(outputName).success
      || !outputName.toLowerCase().endsWith(".wav")) return null;
    const record = parseRecord(t2aAudioAnalysisPath(this.root, outputName));
    return record?.targetBinding.outputName === outputName ? record : null;
  }

  get(outputName: string): T2aAudioAnalysisRecord | null {
    this.assertInitialized();
    try {
      const target = resolveT2aAudioAnalysisTarget(this.root, outputName, this.jobs());
      const authority = this.evaluatorBinding();
      return readT2aAudioAnalysis(
        this.root,
        target,
        authority.evaluatorFingerprint,
        authority.claimScope,
      );
    } catch (error) {
      throw safeManagerBoundaryError(error, "Lesen");
    }
  }

  /**
   * Metadata-only library path. It still binds the private analysis record to
   * the current evaluator, job, publication stat revision and settings
   * authority, but deliberately leaves WAV byte hashing to get()/start().
   */
  getForListing(outputName: string): T2aAudioAnalysisRecord | null {
    this.assertInitialized();
    try {
      const record = this.getStored(outputName);
      const authority = this.evaluatorBinding();
      if (!record
        || record.evaluatorFingerprint !== authority.evaluatorFingerprint
        || record.claimScope !== authority.claimScope) return null;
      const binding = resolveT2aAudioListingBinding(this.root, outputName, this.jobs());
      return canonicalJson(record.targetBinding) === canonicalJson(binding) ? record : null;
    } catch (error) {
      throw safeManagerBoundaryError(error, "Auflisten");
    }
  }

  isActive(outputName: string): boolean {
    this.assertInitialized();
    return this.activeByOutput.has(outputName);
  }

  start(outputName: string, force = false): T2aAudioAnalysisRecord {
    this.assertInitialized();
    try {
      return this.startInternal(outputName, force);
    } catch (error) {
      throw safeManagerBoundaryError(error, "Start");
    }
  }

  private startInternal(outputName: string, force: boolean): T2aAudioAnalysisRecord {
    if (this.lifecycleFailure) {
      throw new Error(
        `T2A-Analysemanager ist nach einem Lifecycle-Fehler gesperrt: ${this.lifecycleFailure.message}`,
      );
    }
    let lease: T2aAudioAnalysisLease;
    try {
      lease = openT2aAudioAnalysisTarget(
        this.root,
        outputName,
        this.jobs(),
        this.options.tempRoot,
      );
    } catch (error) {
      if (error instanceof T2aAudioLeaseCleanupError) this.rememberLifecycleFailure(error);
      throw error;
    }
    let transferred = false;
    let result: T2aAudioAnalysisRecord;
    try {
      const authority = this.evaluatorBinding();
      const current = readT2aAudioAnalysis(
        this.root,
        lease.target,
        authority.evaluatorFingerprint,
        authority.claimScope,
      );
      const stored = this.getStored(outputName);
      if ((current && ["queued", "running"].includes(current.status))
        || (current?.status === "completed" && !force)) {
        result = current;
      } else {
        const createdAt = now();
        const record = t2aAudioAnalysisRecordSchema.parse({
          schemaVersion: T2A_AUDIO_ANALYSIS_RECORD_VERSION,
          analysisKind: "t2a-audio-qa",
          mediaKind: "audio",
          analysisId: randomUUID(),
          claimScope: authority.claimScope,
          evaluatorFingerprint: authority.evaluatorFingerprint,
          targetBinding: lease.target.binding,
          attempt: Math.max(current?.attempt ?? 0, stored?.attempt ?? 0) + 1,
          status: "queued",
          progress: 0,
          createdAt,
          startedAt: null,
          finishedAt: null,
          updatedAt: createdAt,
          error: null,
          result: null,
        });
        writeT2aAudioAnalysis(this.root, record);
        this.tasks.set(record.analysisId, {
          lease,
          record,
          abortController: new AbortController(),
          cancellationRequested: false,
        });
        this.activeByOutput.set(outputName, record.analysisId);
        this.queue.push(record.analysisId);
        transferred = true;
        setImmediate(() => void this.pump().catch((error: unknown) => {
          this.rememberLifecycleFailure(error);
          this.failQueuedTasksAfterLifecycleFailure();
        }));
        result = record;
      }
    } catch (error) {
      try {
        lease.release();
      } catch (releaseError) {
        throw this.rememberLifecycleFailure(releaseError);
      }
      throw error;
    }
    if (!transferred) {
      try {
        lease.release();
      } catch (error) {
        throw this.rememberLifecycleFailure(error);
      }
    }
    return result;
  }

  cancel(outputName: string, expectedAnalysisId: string): T2aAudioAnalysisRecord | null {
    this.assertInitialized();
    try {
      return this.cancelInternal(outputName, expectedAnalysisId);
    } catch (error) {
      throw safeManagerBoundaryError(error, "Abbruch");
    }
  }

  private cancelInternal(
    outputName: string,
    expectedAnalysisId: string,
  ): T2aAudioAnalysisRecord | null {
    const analysisId = this.activeByOutput.get(outputName);
    if (!analysisId) {
      return this.currentAnalysisForCancellation(outputName, expectedAnalysisId);
    }
    if (analysisId !== expectedAnalysisId) {
      throw new OutputQualityError(
        "T2A-Analyselauf wurde ersetzt; der neuere Lauf wurde nicht abgebrochen.",
        409,
      );
    }
    const task = this.tasks.get(analysisId);
    if (!task) {
      return this.currentAnalysisForCancellation(outputName, expectedAnalysisId);
    }
    if (task.record.status === "queued" && this.runningId !== analysisId) {
      let cancelled: T2aAudioAnalysisRecord | null = null;
      let cancellationError: Error | null = null;
      try {
        const finishedAt = now();
        cancelled = t2aAudioAnalysisRecordSchema.parse({
          ...task.record,
          status: "cancelled",
          finishedAt,
          updatedAt: finishedAt,
          error: { code: "cancelled", message: "T2A-Audioanalyse wurde manuell abgebrochen." },
          result: null,
        });
        writeT2aAudioAnalysis(this.root, cancelled);
        task.record = cancelled;
      } catch (error) {
        cancellationError = this.rememberLifecycleFailure(error);
      } finally {
        const queueIndex = this.queue.indexOf(analysisId);
        if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
        try {
          task.lease.release();
        } catch (error) {
          const releaseError = this.rememberLifecycleFailure(error);
          cancellationError ??= releaseError;
        } finally {
          if (this.activeByOutput.get(outputName) === analysisId) {
            this.activeByOutput.delete(outputName);
          }
          this.tasks.delete(analysisId);
        }
      }
      if (cancellationError) throw cancellationError;
      if (!cancelled) throw this.rememberLifecycleFailure(new Error(
        "T2A-Abbruch endete ohne terminalen Record.",
      ));
      return cancelled;
    }
    // A running analysis remains visibly running until the evaluator confirms
    // that its unit and process group are terminal. The run() catch below is
    // the sole authority allowed to persist terminal cancellation.
    task.cancellationRequested = true;
    task.abortController.abort();
    return task.record;
  }

  private currentAnalysisForCancellation(
    outputName: string,
    expectedAnalysisId: string,
  ): T2aAudioAnalysisRecord | null {
    const stored = this.getStored(outputName);
    if (stored && stored.analysisId !== expectedAnalysisId) {
      throw new OutputQualityError(
        "T2A-Analyselauf wurde ersetzt; der neuere Lauf wurde nicht abgebrochen.",
        409,
      );
    }
    const current = this.get(outputName);
    if (!current || current.analysisId !== expectedAnalysisId) {
      if (!stored && !current) return null;
      throw new OutputQualityError(
        "T2A-Analyselauf ist nicht mehr an die aktuelle Ausgabe gebunden.",
        409,
      );
    }
    return current;
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    await this.initialize();
    for (const [analysisId, task] of [...this.tasks]) {
      if (["queued", "running"].includes(task.record.status)) {
        try {
          this.cancel(task.lease.target.binding.outputName, analysisId);
        } catch (error) {
          this.rememberLifecycleFailure(error);
        }
      }
    }
    if (this.lifecycleFailure) this.failQueuedTasksAfterLifecycleFailure();
    const deadline = Date.now() + timeoutMs;
    let budgetExceeded = false;
    while (this.runningId !== null) {
      if (Date.now() >= deadline) budgetExceeded = true;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    if (this.lifecycleFailure) {
      throw new Error(
        `T2A-Audio-Sandbox-Shutdown blieb ohne bestaetigte Terminierung: ${this.lifecycleFailure.message}`,
      );
    }
    if (budgetExceeded) {
      throw new Error(
        "T2A-Audio-Sandbox ueberschritt das Shutdown-Zeitbudget, wurde aber vor der Rueckkehr terminal.",
      );
    }
  }

  private async pump(): Promise<void> {
    if (this.runningId !== null) return;
    if (this.lifecycleFailure) {
      this.failQueuedTasksAfterLifecycleFailure();
      return;
    }
    const analysisId = this.queue.shift();
    if (!analysisId) return;
    const task = this.tasks.get(analysisId);
    if (!task || task.record.status !== "queued") return void this.pump();
    this.runningId = analysisId;
    try {
      await this.run(task);
    } catch (error) {
      this.rememberLifecycleFailure(error);
    } finally {
      let releaseError: Error | null = null;
      try {
        task.lease.release();
      } catch (error) {
        releaseError = error instanceof Error ? error : new Error(String(error));
      } finally {
        this.tasks.delete(analysisId);
        if (this.activeByOutput.get(task.lease.target.binding.outputName) === analysisId) {
          this.activeByOutput.delete(task.lease.target.binding.outputName);
        }
        this.runningId = null;
        if (releaseError) this.rememberLifecycleFailure(releaseError);
        if (this.lifecycleFailure) {
          this.failQueuedTasksAfterLifecycleFailure();
        } else {
          void this.pump().catch((error: unknown) => {
            this.rememberLifecycleFailure(error);
            this.failQueuedTasksAfterLifecycleFailure();
          });
        }
      }
    }
  }

  private async run(task: AnalysisTask): Promise<void> {
    try {
      const startedAt = now();
      task.record = t2aAudioAnalysisRecordSchema.parse({
        ...task.record,
        status: "running",
        progress: 10,
        startedAt,
        updatedAt: startedAt,
      });
      writeT2aAudioAnalysis(this.root, task.record);
      task.lease.verify(this.jobs());
      const evaluated = await (this.options.evaluator ?? runT2aAudioEvaluator)(
        task.lease.target,
        { signal: task.abortController.signal },
      );
      if (task.cancellationRequested) {
        const finishedAt = now();
        task.record = t2aAudioAnalysisRecordSchema.parse({
          ...task.record,
          status: "cancelled",
          finishedAt,
          updatedAt: finishedAt,
          error: { code: "cancelled", message: "T2A-Audioanalyse wurde manuell abgebrochen." },
          result: null,
        });
        writeT2aAudioAnalysis(this.root, task.record);
        return;
      }
      if (evaluated.evaluatorFingerprint !== task.record.evaluatorFingerprint) {
        throw new Error("T2A-Evaluator-Authority aenderte sich waehrend der Analyse.");
      }
      if (evaluated.claimScope !== task.record.claimScope) {
        throw new Error("T2A-Evaluator-Claim-Scope aenderte sich waehrend der Analyse.");
      }
      task.lease.verify(this.jobs());
      const finishedAt = now();
      const boundResult = bindT2aAudioQualityClaimScope(
        evaluated.result,
        task.record.claimScope,
      );
      if (boundResult.analysisStatus === "failed") {
        task.record = t2aAudioAnalysisRecordSchema.parse({
          ...task.record,
          status: "failed",
          finishedAt,
          updatedAt: finishedAt,
          error: {
            code: "analysis-failed",
            message: boundResult.error.message,
          },
          result: boundResult,
        });
        writeT2aAudioAnalysis(this.root, task.record);
        return;
      }
      task.record = t2aAudioAnalysisRecordSchema.parse({
        ...task.record,
        status: "completed",
        progress: 100,
        finishedAt,
        updatedAt: finishedAt,
        error: null,
        result: boundResult,
      });
    } catch (error) {
      const finishedAt = now();
      if (task.cancellationRequested && error instanceof T2aAudioEvaluatorCancelledError) {
        task.record = t2aAudioAnalysisRecordSchema.parse({
          ...task.record,
          status: "cancelled",
          finishedAt,
          updatedAt: finishedAt,
          error: { code: "cancelled", message: "T2A-Audioanalyse wurde manuell abgebrochen." },
          result: null,
        });
        writeT2aAudioAnalysis(this.root, task.record);
        return;
      }
      if (task.cancellationRequested || error instanceof T2aAudioEvaluatorTerminationError) {
        this.rememberLifecycleFailure(error);
      }
      task.record = t2aAudioAnalysisRecordSchema.parse({
        ...task.record,
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        error: {
          code: "analysis-failed",
          message: (error instanceof Error
            ? error.message
            : "T2A-Audioanalyse ist fehlgeschlagen.").slice(0, 500),
        },
        result: null,
      });
    }
    writeT2aAudioAnalysis(this.root, task.record);
  }
}

function publicAnalysisErrorMessage(code: "analysis-failed" | "cancelled"): string {
  return code === "cancelled"
    ? "T2A-Audioanalyse wurde abgebrochen."
    : "T2A-Audioanalyse konnte nicht sicher abgeschlossen werden.";
}

function publicWorkerFailureMessage(code: T2aFailedAudioQuality["error"]["code"]): string {
  const messages = {
    "arguments-invalid": "Audioanalyse erhielt ungueltige gebundene Eingaben.",
    "audio-snapshot-invalid": "Der gebundene Audio-Snapshot ist ungueltig.",
    "audio-hash-mismatch": "Der Audio-Snapshot stimmt nicht mit seiner Ausgabeautoritaet ueberein.",
    "wav-container-invalid": "Die Ausgabe ist kein gueltiger RIFF/WAVE-Container.",
    "wav-format-unsupported": "Das WAV-Format wird von der Qualitaetspruefung nicht unterstuetzt.",
    "wav-data-invalid": "Die PCM-Nutzdaten des WAV sind ungueltig.",
    "audio-silent": "Die Audioausgabe enthaelt kein messbares Signal.",
    "ffmpeg-unverified": "Die Loudness-Messruntime konnte nicht verifiziert werden.",
    "whisper-unverified": "Das lokale Spracherkennungsmodell konnte nicht verifiziert werden.",
    "loudness-measurement-failed": "Die Loudness-Messung konnte nicht abgeschlossen werden.",
    "offline-runtime-unverified": "Die Offline-Isolation der Audioanalyse konnte nicht verifiziert werden.",
    "internal-error": "Die Audioanalyse ist intern fehlgeschlagen.",
  } as const;
  return messages[code];
}

function publicDialogueError(
  blockerCode: T2aMeasuredAudioQuality["dialogueEvaluation"]["blockerCode"],
): string | null {
  if (blockerCode === "none") return null;
  const messages = {
    "target-transcript-missing": "Fuer diese Ausgabe ist kein gebundener Dialogtext vorhanden.",
    "target-transcript-too-long": "Der gebundene Dialogtext ueberschreitet das Analysefenster.",
    "audio-missing": "Im Analysefenster fehlt verwertbares Audio.",
    "duration-out-of-range": "Die Audiodauer liegt ausserhalb des unterstuetzten Analysefensters.",
    "model-missing": "Das lokale Spracherkennungsmodell ist nicht verfuegbar.",
    "model-invalid": "Das lokale Spracherkennungsmodell ist nicht verifiziert.",
    "runtime-unavailable": "Die lokale Sprachanalyse-Runtime ist nicht verfuegbar.",
    "alignment-insufficient": "Die Wortausrichtung ist fuer eine Freigabe nicht vollstaendig genug.",
    "evaluator-failed": "Die lokale Wortausrichtung konnte nicht abgeschlossen werden.",
  } as const;
  return messages[blockerCode];
}

function toPublicIndependentIpaMeasurement(
  result: T2aMeasuredAudioQuality,
): PublicIndependentIpaMeasurement {
  const gate = result.spokenContentGate;
  const phase = gate.independentIpa.phase;
  const releaseQualification = {
    status: gate.releaseQualification.status,
    requiredPositiveHoldoutCases: gate.releaseQualification.requiredPositiveHoldoutCases,
    requiredNegativeHoldoutCases: gate.releaseQualification.requiredNegativeHoldoutCases,
    maximumFalseAccepts: gate.releaseQualification.maximumFalseAccepts,
  } as const;
  if (phase.status === "measured") {
    return {
      evaluationMode: gate.evaluationMode,
      status: phase.status,
      targetConditioned: phase.observation.targetConditioned,
      reasonCode: phase.reasonCode,
      method: phase.observation.method,
      modelFingerprint: phase.observation.modelFingerprint,
      decodedIpa: phase.observation.observation.decodedIpa,
      tokenCount: phase.observation.observation.tokens.length,
      unknownTokenCount: phase.observation.observation.unknownTokenCount,
      specialTokenCount: phase.observation.observation.specialTokenCount,
      blankFrameRatio: phase.observation.observation.blankFrameRatio,
      releaseQualification,
    };
  }
  if (phase.status === "insufficient") {
    return {
      evaluationMode: gate.evaluationMode,
      status: phase.status,
      targetConditioned: false,
      reasonCode: phase.reasonCode,
      method: null,
      modelFingerprint: null,
      decodedIpa: null,
      tokenCount: null,
      unknownTokenCount: null,
      specialTokenCount: null,
      blankFrameRatio: null,
      releaseQualification,
    };
  }
  return {
    evaluationMode: gate.evaluationMode,
    status: phase.status,
    targetConditioned: false,
    reasonCode: phase.reasonCode,
    method: null,
    modelFingerprint: null,
    decodedIpa: null,
    tokenCount: null,
    unknownTokenCount: null,
    specialTokenCount: null,
    blankFrameRatio: null,
    releaseQualification,
  };
}

function toPublicPronunciationMeasurement(
  result: T2aMeasuredAudioQuality,
): PublicPronunciationMeasurement | null {
  if (result.spokenContentGate.ipaAdjudication === undefined) return null;
  const verification = result.dialogueEvaluation.phonemeVerification;
  if (verification.status === "not-available") return null;

  const common = {
    status: verification.status,
    sourcePhaseStatus: verification.sourcePhaseStatus,
    method: verification.method,
    evaluationMode: verification.evaluationMode,
  } as const;
  if (verification.status === "unavailable") {
    return publicPronunciationMeasurementSchema.parse({
      ...common,
      substitutions: null,
      deletions: null,
      insertions: null,
      editDistance: null,
      referenceTokenCount: null,
      hypothesisTokenCount: null,
      normalizedPhoneErrorRate: null,
    });
  }

  return publicPronunciationMeasurementSchema.parse({
    ...common,
    ...verification.measurement,
  });
}

export function toPublicT2aAudioQuality(result: T2aAudioQuality): T2aAudioPublicQuality {
  if (result.analysisStatus === "failed") {
    return t2aAudioPublicQualitySchema.parse({
      schemaVersion: T2A_AUDIO_PUBLIC_QUALITY_VERSION,
      mediaKind: "audio",
      analysisKind: "t2a-audio-qa",
      analysisStatus: "failed",
      error: { ...result.error, message: publicWorkerFailureMessage(result.error.code) },
      ia2vEligibility: result.ia2vEligibility,
    });
  }
  const dialogue = result.dialogueEvaluation;
  return t2aAudioPublicQualitySchema.parse({
    schemaVersion: T2A_AUDIO_PUBLIC_QUALITY_VERSION,
    mediaKind: "audio",
    analysisKind: "t2a-audio-qa",
    analysisStatus: "measured",
    wav: result.wav,
    pcm: result.pcm,
    loudness: {
      method: result.loudness.method,
      integratedLufs: result.loudness.integratedLufs,
      truePeakDbtp: result.loudness.truePeakDbtp,
    },
    dialogue: {
      status: dialogue.status,
      blockerCode: dialogue.blockerCode,
      error: publicDialogueError(dialogue.blockerCode),
      detectedLanguage: dialogue.detectedLanguage,
      expectedWordCount: dialogue.expectedWordCount,
      recognizedWordCount: dialogue.recognizedWordCount,
      wordErrorRate: dialogue.wordErrorRate,
      substitutions: dialogue.substitutions,
      deletions: dialogue.deletions,
      insertions: dialogue.insertions,
      guidedAlignedWordCount: dialogue.guidedAlignedWordCount,
      guidedWordCoverage: dialogue.guidedWordCoverage,
      usableAlignedWordCount: dialogue.usableAlignedWordCount,
      usableGuidedWordCoverage: dialogue.usableGuidedWordCoverage,
      medianGuidedWordProbability: dialogue.medianGuidedWordProbability,
      p10GuidedWordProbability: dialogue.p10GuidedWordProbability,
      lowConfidenceAlignedWords: dialogue.lowConfidenceAlignedWords,
      alignmentStatus: dialogue.alignmentStatus,
      alignmentError: dialogue.alignmentError === null
        ? null
        : publicDialogueError(dialogue.blockerCode),
      timePrecisionMilliseconds: dialogue.timePrecisionMilliseconds,
    },
    policy: result.policy,
    independentIpa: toPublicIndependentIpaMeasurement(result),
    pronunciationMeasurement: toPublicPronunciationMeasurement(result),
    ia2vEligibility: result.ia2vEligibility,
  });
}

export function toPublicT2aAudioAnalysis(
  record: T2aAudioAnalysisRecord,
  outputRevisionToken: string,
): T2aAudioPublicAnalysisRecord {
  return t2aAudioPublicAnalysisRecordSchema.parse({
    schemaVersion: T2A_AUDIO_PUBLIC_ANALYSIS_VERSION,
    analysisKind: record.analysisKind,
    mediaKind: record.mediaKind,
    outputName: record.targetBinding.outputName,
    outputRevisionToken,
    jobId: record.targetBinding.jobId,
    analysisId: record.analysisId,
    claimScope: record.claimScope,
    attempt: record.attempt,
    status: record.status,
    progress: record.progress,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    updatedAt: record.updatedAt,
    error: record.error
      ? { ...record.error, message: publicAnalysisErrorMessage(record.error.code) }
      : null,
    result: record.result ? toPublicT2aAudioQuality(record.result) : null,
  });
}

export type { T2aAudioQuality };
