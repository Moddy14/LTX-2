import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { canonicalJson } from "../shared/canonicalJson.js";
import type { ExecutionFileBinding, ExecutionFileRevision } from "../shared/jobExecution.js";
import { migrateGenerationRequest, type GenerationRequest } from "../shared/pipelines.js";
import {
  isOutputSnapshotMaterializationSystemError,
  openAnonymousOutputSnapshot,
} from "./outputPublication.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DGX_JOB_ID_PATTERN = /^dgx-job-[A-Za-z0-9._:-]{1,120}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const INTEGER_ID_PATTERN = /^\d{1,64}$/;
const LEGACY_SETTINGS_SCHEMA = "ltx-studio-output.v6";
const LEGACY_SETTINGS_SUFFIX = ".ltx-settings.json";
const MAX_SETTINGS_BYTES = 128 * 1024 * 1024;

export type LegacyTerminalStatus = "completed" | "failed" | "cancelled" | "interrupted";

export type LegacyOutputArtifactEvidence = {
  output: ExecutionFileBinding;
  settings: ExecutionFileBinding;
  settingsSchemaVersion: typeof LEGACY_SETTINGS_SCHEMA;
  /** Import-time audit fact only; never recomputed as durable playback authority. */
  migratedRequestSha256: string;
};

export type VerifiedLegacyOutputSnapshot = {
  fd: number;
  /**
   * Process-local TOCTOU fences captured while the receipt digests were
   * re-verified. They are deliberately not durable preservation identity:
   * inode/device/ctime legitimately change across a byte-identical restore.
   */
  sourceOutputRevision: ExecutionFileRevision;
  sourceSettingsRevision: ExecutionFileRevision;
};

export type LegacyOutputSnapshotOperations = {
  openAnonymousSnapshot: typeof openAnonymousOutputSnapshot;
};

const DEFAULT_LEGACY_OUTPUT_SNAPSHOT_OPERATIONS: LegacyOutputSnapshotOperations = Object.freeze({
  openAnonymousSnapshot: openAnonymousOutputSnapshot,
});

/**
 * A preservation receipt, never execution or publication provenance.
 *
 * It records what the pre-v1.1 Studio had on disk during the one-time import.
 * It intentionally cannot satisfy an ExecutionDecision, DGX lease, experiment,
 * objective-analysis, reuse, or quality-GO gate.
 */
export type LegacyTerminalHistory = {
  schemaVersion: "ltx-studio-legacy-terminal-history.v1";
  trust: "legacy-unattested";
  jobId: string;
  originalStatus: LegacyTerminalStatus;
  outputName: string;
  finishedAt: string | null;
  historicalDgxJobId: string | null;
  requestSha256: string;
  importedAt: string;
  artifact: LegacyOutputArtifactEvidence | null;
  artifactUnavailableReason:
    | "not-completed"
    | "missing-or-invalid-artifact"
    | "legacy-sidecar-mismatch"
    | null;
};

type LegacyImportInput = {
  jobId: string;
  status: LegacyTerminalStatus;
  outputName: string;
  finishedAt: string | null;
  dgxJobId: string | null;
  rawRequest: unknown;
  migratedRequest: GenerationRequest;
  runProvenance: unknown;
  identityEvidence: unknown;
  experiment: unknown;
  importedAt: string;
};

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function revision(stats: {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number | bigint;
  dev: number | bigint;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
}): ExecutionFileRevision {
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

export function legacyRevisionsEqual(
  left: ExecutionFileRevision,
  right: ExecutionFileRevision,
): boolean {
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

function hashDescriptor(fd: number, size: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (count <= 0) throw new Error("legacy artifact ended during hashing");
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

function pathStillBinds(path: string, expected: ExecutionFileRevision): boolean {
  try {
    const stats = lstatSync(path);
    return !stats.isSymbolicLink()
      && stats.isFile()
      && legacyRevisionsEqual(revision(stats), expected);
  } catch {
    return false;
  }
}

function captureFile(
  path: string,
  maximumBytes: number | null = null,
): { binding: ExecutionFileBinding; content: Buffer | null } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()
      || before.size <= 0
      || before.nlink !== 1
      || (maximumBytes !== null && before.size > maximumBytes)) {
      throw new Error("legacy artifact is not a bounded regular file");
    }
    const beforeRevision = revision(before);
    const content = maximumBytes === null ? null : readFileSync(descriptor);
    const sha256 = content
      ? createHash("sha256").update(content).digest("hex")
      : hashDescriptor(descriptor, before.size);
    const afterRevision = revision(fstatSync(descriptor));
    if (!legacyRevisionsEqual(beforeRevision, afterRevision)
      || !pathStillBinds(path, afterRevision)) {
      throw new Error("legacy artifact changed during capture");
    }
    return { binding: { path, sha256, revision: afterRevision }, content };
  } finally {
    closeSync(descriptor);
  }
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

type LegacyDefaultEvolution = {
  path: readonly string[];
  values: readonly unknown[];
};

/**
 * One-way additions made by known Studio request-schema releases. These are
 * not a general migration: only an absent sidecar field may be filled, and
 * only when the raw job already contains one of these exact inert defaults.
 * Explicit sidecar values are never rewritten.
 */
const LEGACY_SIDECAR_DEFAULT_EVOLUTIONS: readonly LegacyDefaultEvolution[] = [
  { path: ["icLora", "profile"], values: ["union-control"] },
  { path: ["icLora", "controlType"], values: ["depth"] },
  { path: ["icLora", "lora"], values: [{ path: "", strength: 1 }] },
  { path: ["icLora", "mogeModelPath"], values: [""] },
  { path: ["icLora", "hdrTextEmbeddingsPath"], values: [""] },
  { path: ["icLora", "hdrHighQuality"], values: [false] },
  {
    path: ["idLora"],
    values: [{
      referenceAudio: { path: "", name: "" },
      lora: { path: "", strength: 1 },
      distilledLoraStrength: 0.5,
      identityGuidanceScale: 3,
      identityGuidanceStart: 0,
      identityGuidanceEnd: 1,
      stage1ImageStrength: 0.7,
    }],
  },
  {
    path: ["models", "gemmaLora"],
    values: [
      { path: "", strength: 1 },
      { enabled: false, path: "", strength: 1 },
    ],
  },
  {
    path: ["postprocess", "latentSync"],
    values: [{ enabled: false, steps: 30, guidance: 2 }],
  },
  {
    path: ["postprocess", "museTalk"],
    values: [{
      enabled: false,
      extraMargin: 10,
      cheekWidth: 90,
      audioPaddingLeft: 2,
      audioPaddingRight: 2,
    }],
  },
  {
    path: ["postprocess", "lipForcing"],
    values: [{ enabled: false, decoder: "wan-vae" }],
  },
] as const;

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function ownPath(
  root: Record<string, unknown>,
  path: readonly string[],
): { present: boolean; value: unknown; parent: Record<string, unknown> | null } {
  let parent = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!Object.hasOwn(parent, path[index])) return { present: false, value: undefined, parent: null };
    const child = objectRecord(parent[path[index]]);
    if (!child) return { present: false, value: undefined, parent: null };
    parent = child;
  }
  const key = path.at(-1);
  return key && Object.hasOwn(parent, key)
    ? { present: true, value: parent[key], parent }
    : { present: false, value: undefined, parent };
}

function matchesAllowedValue(value: unknown, allowed: readonly unknown[]): boolean {
  const encoded = canonicalJson(value);
  return allowed.some((candidate) => canonicalJson(candidate) === encoded);
}

function addKnownLegacyDefault(
  sidecar: Record<string, unknown>,
  job: Record<string, unknown>,
  evolution: LegacyDefaultEvolution,
): void {
  const sidecarPath = ownPath(sidecar, evolution.path);
  if (sidecarPath.present || !sidecarPath.parent) return;
  const jobPath = ownPath(job, evolution.path);
  if (!jobPath.present || !matchesAllowedValue(jobPath.value, evolution.values)) return;
  sidecarPath.parent[evolution.path.at(-1)!] = structuredClone(jobPath.value);
}

function addKnownLegacyLipDubProfile(
  sidecar: Record<string, unknown>,
  job: Record<string, unknown>,
): void {
  const path = ["lipDub", "pipelineProfile"] as const;
  const sidecarPath = ownPath(sidecar, path);
  if (sidecarPath.present || !sidecarPath.parent) return;
  const jobPath = ownPath(job, path);
  const mode = typeof sidecar.mode === "string" ? sidecar.mode : null;
  const expected = mode === "lipdub" ? "native-distilled" : "official-comfy-hq";
  if (!jobPath.present || jobPath.value !== expected) return;
  sidecarPath.parent.pipelineProfile = expected;
}

function renameKnownLegacyIdLoraStrength(
  sidecar: Record<string, unknown>,
  job: Record<string, unknown>,
): void {
  const sidecarIdLora = objectRecord(sidecar.idLora);
  const jobIdLora = objectRecord(job.idLora);
  if (!sidecarIdLora || !jobIdLora
    || Object.hasOwn(sidecarIdLora, "stage1ImageStrength")
    || !Object.hasOwn(sidecarIdLora, "stage2ImageStrength")
    || Object.hasOwn(jobIdLora, "stage2ImageStrength")
    || !Object.hasOwn(jobIdLora, "stage1ImageStrength")) return;
  const oldValue = sidecarIdLora.stage2ImageStrength;
  if (typeof oldValue !== "number" || !Number.isFinite(oldValue) || oldValue < 0 || oldValue > 1
    || jobIdLora.stage1ImageStrength !== oldValue) return;
  sidecarIdLora.stage1ImageStrength = oldValue;
  delete sidecarIdLora.stage2ImageStrength;
}

function legacySidecarRequestMatchesRawJob(sidecarRequest: unknown, rawJobRequest: unknown): boolean {
  if (canonicalJson(sidecarRequest) === canonicalJson(rawJobRequest)) return true;
  const sidecarRecord = objectRecord(sidecarRequest);
  const jobRecord = objectRecord(rawJobRequest);
  if (!sidecarRecord || !jobRecord) return false;
  const normalized = structuredClone(sidecarRecord);
  renameKnownLegacyIdLoraStrength(normalized, jobRecord);
  for (const evolution of LEGACY_SIDECAR_DEFAULT_EVOLUTIONS) {
    addKnownLegacyDefault(normalized, jobRecord, evolution);
  }
  addKnownLegacyLipDubProfile(normalized, jobRecord);
  return canonicalJson(normalized) === canonicalJson(jobRecord);
}

function legacySidecarMatches(
  raw: unknown,
  input: LegacyImportInput,
  output: ExecutionFileBinding,
): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const item = raw as Record<string, unknown>;
  if (item.schemaVersion !== LEGACY_SETTINGS_SCHEMA
    || item.outputName !== input.outputName
    || item.jobId !== input.jobId
    || item.completedAt !== input.finishedAt
    || item.sizeBytes !== output.revision.sizeBytes
    // v6 recorded local inode/ctime/mtime observations, not portable content
    // identity. A byte-identical Borg/rsync restore legitimately changes any
    // of them before the first v1.1 import. Keep their shape as evidence that
    // this really is a v6 sidecar, but never compare them to the restored
    // file. The import captures fresh nofollow revisions and SHA-256 receipts
    // for both files below.
    || typeof item.fileId !== "string"
    || !INTEGER_ID_PATTERN.test(item.fileId)
    || typeof item.modifiedAtMs !== "number"
    || !Number.isFinite(item.modifiedAtMs)
    || typeof item.changedAtMs !== "number"
    || !Number.isFinite(item.changedAtMs)
    || Object.hasOwn(item, "executionDecision")
    || canonicalJson(item.runProvenance ?? null) !== canonicalJson(input.runProvenance ?? null)
    || canonicalJson(item.identityEvidence ?? null) !== canonicalJson(input.identityEvidence ?? null)
    || canonicalJson(item.experiment ?? null) !== canonicalJson(input.experiment ?? null)
    // Migration is intentionally many-to-one as defaults evolve. Bind raw
    // requests exactly, except for the closed one-way evolution table above,
    // before using migration merely as a current-parser sanity check.
    || !legacySidecarRequestMatchesRawJob(item.request, input.rawRequest)) return false;
  try {
    const sidecarRequest = migrateGenerationRequest(structuredClone(item.request));
    return sidecarRequest !== null
      && canonicalJson(sidecarRequest) === canonicalJson(input.migratedRequest);
  } catch {
    return false;
  }
}

export function captureLegacyTerminalHistory(
  outputRoot: string,
  input: LegacyImportInput,
): LegacyTerminalHistory {
  const requestSha256 = createHash("sha256").update(canonicalJson(input.rawRequest)).digest("hex");
  const base: Omit<LegacyTerminalHistory, "artifact" | "artifactUnavailableReason"> = {
    schemaVersion: "ltx-studio-legacy-terminal-history.v1",
    trust: "legacy-unattested",
    jobId: input.jobId,
    originalStatus: input.status,
    outputName: input.outputName,
    finishedAt: input.finishedAt,
    historicalDgxJobId: input.dgxJobId,
    requestSha256,
    importedAt: input.importedAt,
  };
  if (input.status !== "completed") {
    return { ...base, artifact: null, artifactUnavailableReason: "not-completed" };
  }
  try {
    const outputPath = join(outputRoot, input.outputName);
    const settingsPath = join(outputRoot, `${input.outputName}${LEGACY_SETTINGS_SUFFIX}`);
    const output = captureFile(outputPath);
    const settings = captureFile(settingsPath, MAX_SETTINGS_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(settings.content!.toString("utf8"));
    } catch {
      return { ...base, artifact: null, artifactUnavailableReason: "legacy-sidecar-mismatch" };
    }
    if (!legacySidecarMatches(parsed, input, output.binding)) {
      return { ...base, artifact: null, artifactUnavailableReason: "legacy-sidecar-mismatch" };
    }
    return {
      ...base,
      artifact: {
        output: output.binding,
        settings: settings.binding,
        settingsSchemaVersion: LEGACY_SETTINGS_SCHEMA,
        migratedRequestSha256: createHash("sha256")
          .update(canonicalJson(input.migratedRequest))
          .digest("hex"),
      },
      artifactUnavailableReason: null,
    };
  } catch {
    return { ...base, artifact: null, artifactUnavailableReason: "missing-or-invalid-artifact" };
  }
}

function normalizeRevision(value: unknown): ExecutionFileRevision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, [
    "sizeBytes", "modifiedAtMs", "changedAtMs", "fileId", "deviceId", "mode",
    "uid", "gid", "nlink",
  ])
    || typeof item.sizeBytes !== "number"
    || !Number.isSafeInteger(item.sizeBytes)
    || item.sizeBytes <= 0
    || typeof item.modifiedAtMs !== "number"
    || !Number.isFinite(item.modifiedAtMs)
    || typeof item.changedAtMs !== "number"
    || !Number.isFinite(item.changedAtMs)
    || typeof item.fileId !== "string"
    || !INTEGER_ID_PATTERN.test(item.fileId)
    || typeof item.deviceId !== "string"
    || !INTEGER_ID_PATTERN.test(item.deviceId)
    || typeof item.mode !== "number"
    || !Number.isSafeInteger(item.mode)
    || typeof item.uid !== "number"
    || !Number.isSafeInteger(item.uid)
    || item.uid < 0
    || typeof item.gid !== "number"
    || !Number.isSafeInteger(item.gid)
    || item.gid < 0
    || item.nlink !== 1) return null;
  return structuredClone(item) as ExecutionFileRevision;
}

function normalizeBinding(value: unknown, expectedPath: string): ExecutionFileBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const normalizedRevision = normalizeRevision(item.revision);
  if (!exactKeys(item, ["path", "sha256", "revision"])
    || item.path !== expectedPath
    || typeof item.sha256 !== "string"
    || !SHA256_PATTERN.test(item.sha256)
    || !normalizedRevision) return null;
  return { path: expectedPath, sha256: item.sha256, revision: normalizedRevision };
}

export function normalizeLegacyTerminalHistory(
  value: unknown,
  outputRoot: string,
): LegacyTerminalHistory | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, [
    "schemaVersion", "trust", "jobId", "originalStatus", "outputName", "finishedAt",
    "historicalDgxJobId", "requestSha256", "importedAt", "artifact",
    "artifactUnavailableReason",
  ])
    || item.schemaVersion !== "ltx-studio-legacy-terminal-history.v1"
    || item.trust !== "legacy-unattested"
    || typeof item.jobId !== "string"
    || !UUID_PATTERN.test(item.jobId)
    || !["completed", "failed", "cancelled", "interrupted"].includes(String(item.originalStatus))
    || typeof item.outputName !== "string"
    || basename(item.outputName) !== item.outputName
    || (item.finishedAt !== null && !validTimestamp(item.finishedAt))
    || (item.historicalDgxJobId !== null
      && (typeof item.historicalDgxJobId !== "string"
        || !DGX_JOB_ID_PATTERN.test(item.historicalDgxJobId)))
    || typeof item.requestSha256 !== "string"
    || !SHA256_PATTERN.test(item.requestSha256)
    || !validTimestamp(item.importedAt)) return null;

  const unavailableReasons = [
    "not-completed", "missing-or-invalid-artifact", "legacy-sidecar-mismatch",
  ];
  if (item.artifact === null) {
    if (typeof item.artifactUnavailableReason !== "string"
      || !unavailableReasons.includes(item.artifactUnavailableReason)) return null;
    return structuredClone(item) as LegacyTerminalHistory;
  }
  if (item.artifactUnavailableReason !== null
    || !item.artifact
    || typeof item.artifact !== "object"
    || Array.isArray(item.artifact)) return null;
  const artifact = item.artifact as Record<string, unknown>;
  const expectedOutputPath = join(outputRoot, item.outputName);
  const expectedSettingsPath = join(outputRoot, `${item.outputName}${LEGACY_SETTINGS_SUFFIX}`);
  const output = normalizeBinding(artifact.output, expectedOutputPath);
  const settings = normalizeBinding(artifact.settings, expectedSettingsPath);
  if (!exactKeys(artifact, [
    "output", "settings", "settingsSchemaVersion", "migratedRequestSha256",
  ])
    || !output
    || !settings
    || artifact.settingsSchemaVersion !== LEGACY_SETTINGS_SCHEMA
    || typeof artifact.migratedRequestSha256 !== "string"
    || !SHA256_PATTERN.test(artifact.migratedRequestSha256)) return null;
  return {
    ...(structuredClone(item) as Omit<LegacyTerminalHistory, "artifact">),
    artifact: {
      output,
      settings,
      settingsSchemaVersion: LEGACY_SETTINGS_SCHEMA,
      migratedRequestSha256: artifact.migratedRequestSha256,
    },
  };
}

export function legacyArtifactStatsStillMatch(history: LegacyTerminalHistory): boolean {
  if (!history.artifact) return false;
  const plausiblyRestored = (binding: ExecutionFileBinding): boolean => {
    try {
      const stats = lstatSync(binding.path);
      return !stats.isSymbolicLink()
        && stats.isFile()
        && stats.nlink === 1
        && stats.size === binding.revision.sizeBytes;
    } catch {
      return false;
    }
  };
  // This is only the metadata/listing fast path. Persisted inode/device/ctime
  // describe the original import capture, not portable media identity. Every
  // byte consumer below re-opens O_NOFOLLOW and proves both receipt digests.
  return plausiblyRestored(history.artifact.output)
    && plausiblyRestored(history.artifact.settings);
}

function openVerifiedLegacyArtifact(
  binding: ExecutionFileBinding,
): { fd: number; revision: ExecutionFileRevision } | null {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    const beforeRevision = revision(before);
    if (!before.isFile()
      || before.nlink !== 1
      || before.size !== binding.revision.sizeBytes
      || hashDescriptor(descriptor, before.size) !== binding.sha256
      || !legacyRevisionsEqual(revision(fstatSync(descriptor)), beforeRevision)
      || !pathStillBinds(binding.path, beforeRevision)) {
      closeSync(descriptor);
      return null;
    }
    return { fd: descriptor, revision: beforeRevision };
  } catch {
    if (descriptor !== null) closeSync(descriptor);
    return null;
  }
}

export function openVerifiedLegacyOutputSource(
  history: LegacyTerminalHistory,
): { fd: number; revision: ExecutionFileRevision } | null {
  if (!history.artifact) return null;
  return openVerifiedLegacyArtifact(history.artifact.output);
}

/**
 * Returns an immutable, unlinked copy. The caller owns and must close the FD.
 * Historical bytes are never streamed from a pathname that can mutate after
 * verification.
 */
export function createVerifiedLegacyOutputSnapshot(
  history: LegacyTerminalHistory,
  operations: LegacyOutputSnapshotOperations = DEFAULT_LEGACY_OUTPUT_SNAPSHOT_OPERATIONS,
): VerifiedLegacyOutputSnapshot | null {
  const source = openVerifiedLegacyOutputSource(history);
  if (source === null || !history.artifact) return null;
  const settings = openVerifiedLegacyArtifact(history.artifact.settings);
  if (settings === null) {
    closeSync(source.fd);
    return null;
  }
  let snapshot: ReturnType<typeof openAnonymousOutputSnapshot> | null = null;
  let snapshotWriterOpen = false;
  let readOnlySnapshot: number | null = null;
  try {
    // Allocation belongs inside the descriptor-owning try/finally. The shared
    // primitive returns O_TMPFILE or unlinks its fallback before any video byte
    // is copied, so SIGKILL cannot strand a named full-output temporary.
    snapshot = operations.openAnonymousSnapshot(dirname(history.artifact.output.path));
    snapshotWriterOpen = true;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < source.revision.sizeBytes) {
      const count = readSync(
        source.fd,
        buffer,
        0,
        Math.min(buffer.length, source.revision.sizeBytes - position),
        position,
      );
      if (count <= 0) return null;
      let written = 0;
      while (written < count) {
        const writeCount = writeSync(
          snapshot.fd,
          buffer,
          written,
          count - written,
          position + written,
        );
        if (writeCount <= 0) return null;
        written += writeCount;
      }
      position += count;
    }
    if (!legacyRevisionsEqual(revision(fstatSync(source.fd)), source.revision)
      || !pathStillBinds(history.artifact.output.path, source.revision)
      || !legacyRevisionsEqual(revision(fstatSync(settings.fd)), settings.revision)
      || !pathStillBinds(history.artifact.settings.path, settings.revision)) {
      return null;
    }
    const before = fstatSync(snapshot.fd);
    const beforeRevision = revision(before);
    if (!before.isFile()
      || before.nlink !== 0
      || before.size !== history.artifact.output.revision.sizeBytes
      || hashDescriptor(snapshot.fd, before.size) !== history.artifact.output.sha256
      || !legacyRevisionsEqual(revision(fstatSync(snapshot.fd)), beforeRevision)) {
      return null;
    }
    fchmodSync(snapshot.fd, 0o400);
    fsyncSync(snapshot.fd);
    const sealed = fstatSync(snapshot.fd);
    if (!sealed.isFile()
      || sealed.nlink !== 0
      || sealed.size !== history.artifact.output.revision.sizeBytes
      || (sealed.mode & 0o777) !== 0o400
      || hashDescriptor(snapshot.fd, sealed.size) !== history.artifact.output.sha256) return null;
    readOnlySnapshot = openSync(`/proc/self/fd/${snapshot.fd}`, constants.O_RDONLY);
    const readOnlyStats = fstatSync(readOnlySnapshot);
    if (!readOnlyStats.isFile()
      || readOnlyStats.dev !== sealed.dev
      || readOnlyStats.ino !== sealed.ino
      || readOnlyStats.nlink !== 0
      || readOnlyStats.size !== sealed.size
      || (readOnlyStats.mode & 0o777) !== 0o400) return null;
    closeSync(snapshot.fd);
    snapshotWriterOpen = false;
    const result = readOnlySnapshot;
    readOnlySnapshot = null;
    return {
      fd: result,
      sourceOutputRevision: source.revision,
      sourceSettingsRevision: settings.revision,
    };
  } catch (error) {
    if (isOutputSnapshotMaterializationSystemError(error)) throw error;
    return null;
  } finally {
    closeSync(source.fd);
    closeSync(settings.fd);
    if (readOnlySnapshot !== null) closeSync(readOnlySnapshot);
    if (snapshotWriterOpen && snapshot !== null) closeSync(snapshot.fd);
  }
}
