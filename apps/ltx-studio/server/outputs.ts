import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  mkdtempSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
import type {
  ArchivedOutputAuthority,
  CurrentOutputAuthorityJob,
  OutputAuthorityJob,
  ReusableLtxBaseCandidate,
} from "./jobs.js";
import {
  normalizeIdentityInputEvidence,
  type IdentityInputEvidence,
} from "./inputEvidence.js";
import { readOutputAnalysis } from "./analysisStore.js";
import type { RunProvenance } from "../shared/provenance.js";
import { normalizeRunProvenance, runProvenanceFingerprintMatches } from "./runProvenance.js";
import { sha256Json } from "./experimentStore.js";
import { DataRecoveryCoordinator } from "./dataRecoveryJournal.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import {
  normalizeJobExecutionDecision,
  type ExecutionFileRevision,
  type JobExecutionDecision,
} from "../shared/jobExecution.js";
import {
  OUTPUT_PUBLICATION_SUFFIX,
  createVerifiedOutputSnapshot,
  isOutputSnapshotMaterializationSystemError,
  normalizeOutputPublicationAuthority,
  openValidOutputPublicationAuthority,
  removeOutputPublicationAuthority,
  readStatBoundOutputPublicationAuthority,
  terminalJobAuthoritySha256,
  type OpenOutputPublicationAuthority,
  type OutputPublicationAuthority,
  type OutputSnapshotOperations,
} from "./outputPublication.js";
import {
  createVerifiedLegacyOutputSnapshot,
  legacyArtifactStatsStillMatch,
  normalizeLegacyTerminalHistory,
  type LegacyTerminalHistory,
} from "./legacyOutput.js";

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

function materializedRevision(stats: Stats): ExecutionFileRevision {
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

type ReadableSnapshotLease = {
  fd: number;
  release: () => void;
};

type ReadableSnapshotLeaseRecord = {
  dev: number;
  ino: number;
  releaseRequested: boolean;
  retryTimer?: NodeJS.Timeout;
};

type ReadableSnapshotCacheEntry = {
  key: string;
  masterFd: number | null;
  masterIdentity: { dev: number; ino: number } | null;
  masterCloseRetryTimer?: NodeJS.Timeout;
  sizeBytes: number;
  sourceBindings: readonly {
    path: string;
    revision: ExecutionFileRevision;
  }[];
  leases: Map<number, ReadableSnapshotLeaseRecord>;
  retired: boolean;
  expiresAtMs: number;
  ttlMs: number;
  expiryTimer?: NodeJS.Timeout;
  closeFd: (descriptor: number) => void;
  duplicateFd: (descriptor: number) => number;
  statDuplicateFd: (descriptor: number) => Stats;
};

// Browsers issue several Range requests for one playback/seek session. Keep a
// tiny process-global LRU of already verified anonymous snapshots so neither
// legacy nor modern media pays another full hash/copy/hash cycle per Range.
// Response FDs are read-only duplicates; eviction closes only the held master,
// so an in-flight response remains valid. Two entries bound disk/FD retention
// while covering the current video and one immediately previous seek target.
// Known performance boundary: the first miss still performs synchronous full
// source verification, copy and snapshot verification. Moving that work to an
// abortable, coalesced worker is a separate architecture change; cache hits do
// not repeat it for later Range requests.
const MAX_READABLE_SNAPSHOT_CACHE_ENTRIES = 2;
const MAX_READABLE_SNAPSHOT_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
const READABLE_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1_000;
const readableSnapshotCache = new Map<string, ReadableSnapshotCacheEntry>();
const residentReadableSnapshots = new Set<ReadableSnapshotCacheEntry>();

function finalizeRetiredReadableSnapshot(entry: ReadableSnapshotCacheEntry): void {
  if (entry.retired && entry.masterFd === null && entry.leases.size === 0) {
    residentReadableSnapshots.delete(entry);
  }
}

function forgetReadableSnapshotMaster(entry: ReadableSnapshotCacheEntry): void {
  if (entry.masterCloseRetryTimer) clearTimeout(entry.masterCloseRetryTimer);
  entry.masterCloseRetryTimer = undefined;
  entry.masterFd = null;
  entry.masterIdentity = null;
}

function scheduleReadableSnapshotMasterCloseRetry(entry: ReadableSnapshotCacheEntry): void {
  if (entry.masterCloseRetryTimer || entry.masterFd === null || entry.masterIdentity === null) return;
  entry.masterCloseRetryTimer = setTimeout(() => {
    entry.masterCloseRetryTimer = undefined;
    closeReadableSnapshotMaster(entry);
    finalizeRetiredReadableSnapshot(entry);
  }, 25);
  entry.masterCloseRetryTimer.unref();
}

function closeReadableSnapshotMaster(entry: ReadableSnapshotCacheEntry): boolean {
  if (entry.masterFd === null || entry.masterIdentity === null) {
    forgetReadableSnapshotMaster(entry);
    return true;
  }
  const descriptor = entry.masterFd;
  const expected = entry.masterIdentity;
  try {
    const current = fstatSync(descriptor);
    if (current.dev !== expected.dev || current.ino !== expected.ino) {
      // The numeric FD was externally closed and reused. Forget our stale
      // ownership, but never close an unrelated descriptor.
      forgetReadableSnapshotMaster(entry);
      return true;
    }
  } catch {
    // EBADF means the descriptor is already gone; ownership/accounting can be
    // released without issuing another close against a reusable FD number.
    forgetReadableSnapshotMaster(entry);
    return true;
  }
  try {
    entry.closeFd(descriptor);
    forgetReadableSnapshotMaster(entry);
    return true;
  } catch {
    try {
      const current = fstatSync(descriptor);
      if (current.dev !== expected.dev || current.ino !== expected.ino) {
        forgetReadableSnapshotMaster(entry);
        return true;
      }
    } catch {
      // The close may have succeeded before its wrapper threw. Treat EBADF as
      // released, and never retry the now-reusable numeric descriptor.
      forgetReadableSnapshotMaster(entry);
      return true;
    }
    // Keep the exact inode resident/accounted and retry autonomously even when
    // no later request or admission reaches the cache.
    scheduleReadableSnapshotMasterCloseRetry(entry);
    return false;
  }
}

function retireReadableSnapshot(entry: ReadableSnapshotCacheEntry): void {
  if (readableSnapshotCache.get(entry.key) === entry) {
    readableSnapshotCache.delete(entry.key);
  }
  entry.retired = true;
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  entry.expiryTimer = undefined;
  closeReadableSnapshotMaster(entry);
  finalizeRetiredReadableSnapshot(entry);
}

function touchReadableSnapshot(entry: ReadableSnapshotCacheEntry): void {
  if (entry.retired) return;
  if (entry.expiryTimer) clearTimeout(entry.expiryTimer);
  entry.expiresAtMs = Date.now() + entry.ttlMs;
  entry.expiryTimer = setTimeout(() => {
    entry.expiryTimer = undefined;
    reapReadableSnapshotLeases();
    if (!entry.retired && entry.leases.size === 0) retireReadableSnapshot(entry);
  }, entry.ttlMs);
  entry.expiryTimer.unref();
}

function releaseReadableSnapshotLease(
  entry: ReadableSnapshotCacheEntry,
  descriptor: number,
  expected: ReadableSnapshotLeaseRecord,
): void {
  const tracked = entry.leases.get(descriptor);
  if (!tracked || tracked.dev !== expected.dev || tracked.ino !== expected.ino) return;
  tracked.releaseRequested = true;
  try {
    const stats = fstatSync(descriptor);
    if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
      entry.leases.delete(descriptor);
    } else {
      entry.closeFd(descriptor);
      entry.leases.delete(descriptor);
    }
    // A descriptor number reused for another inode is no longer ours and must
    // never be closed by a stale release callback.
  } catch {
    // EBADF means an external test/consumer already closed it. If the exact FD
    // is still open after a close failure, retain residency and retry even when
    // no later request/admission occurs.
    try {
      const stats = fstatSync(descriptor);
      if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
        entry.leases.delete(descriptor);
      } else if (!tracked.retryTimer) {
        tracked.retryTimer = setTimeout(() => {
          tracked.retryTimer = undefined;
          releaseReadableSnapshotLease(entry, descriptor, tracked);
        }, 25);
        tracked.retryTimer.unref();
      }
    } catch {
      entry.leases.delete(descriptor);
    }
  }
  if (!entry.leases.has(descriptor) && tracked.retryTimer) clearTimeout(tracked.retryTimer);
  if (!entry.retired && entry.leases.size === 0 && Date.now() >= entry.expiresAtMs) {
    retireReadableSnapshot(entry);
    return;
  }
  finalizeRetiredReadableSnapshot(entry);
}

function reapReadableSnapshotLeases(): void {
  for (const entry of residentReadableSnapshots) {
    for (const [descriptor, expected] of entry.leases) {
      try {
        const stats = fstatSync(descriptor);
        if (stats.dev !== expected.dev || stats.ino !== expected.ino) {
          entry.leases.delete(descriptor);
        } else if (expected.releaseRequested) {
          releaseReadableSnapshotLease(entry, descriptor, expected);
        }
      } catch {
        entry.leases.delete(descriptor);
      }
    }
    if (!entry.retired && entry.leases.size === 0 && Date.now() >= entry.expiresAtMs) {
      retireReadableSnapshot(entry);
      continue;
    }
    if (entry.retired) closeReadableSnapshotMaster(entry);
    finalizeRetiredReadableSnapshot(entry);
  }
}

function sourceBindingStillMatches(
  binding: ReadableSnapshotCacheEntry["sourceBindings"][number],
): boolean {
  try {
    const stats = lstatSync(binding.path);
    return !stats.isSymbolicLink()
      && stats.isFile()
      && revisionsEqual(materializedRevision(stats), binding.revision);
  } catch {
    return false;
  }
}

function duplicateReadableSnapshot(entry: ReadableSnapshotCacheEntry): ReadableSnapshotLease | null {
  if (entry.masterFd === null || entry.masterIdentity === null || entry.retired) return null;
  let duplicate: number | null = null;
  try {
    const masterStats = fstatSync(entry.masterFd);
    if (!masterStats.isFile()
      || masterStats.nlink !== 0
      || masterStats.size !== entry.sizeBytes
      || (masterStats.mode & 0o777) !== 0o400
      || masterStats.dev !== entry.masterIdentity.dev
      || masterStats.ino !== entry.masterIdentity.ino
      || !entry.sourceBindings.every(sourceBindingStillMatches)) return null;
    duplicate = entry.duplicateFd(entry.masterFd);
    const duplicateStats = entry.statDuplicateFd(duplicate);
    if (!duplicateStats.isFile()
      || duplicateStats.dev !== masterStats.dev
      || duplicateStats.ino !== masterStats.ino
      || duplicateStats.nlink !== 0
      || duplicateStats.size !== entry.sizeBytes
      || (duplicateStats.mode & 0o777) !== 0o400) {
      closeSync(duplicate);
      return null;
    }
    const expected: ReadableSnapshotLeaseRecord = {
      dev: duplicateStats.dev,
      ino: duplicateStats.ino,
      releaseRequested: false,
    };
    entry.leases.set(duplicate, expected);
    let released = false;
    return {
      fd: duplicate,
      release: () => {
        if (released) return;
        released = true;
        releaseReadableSnapshotLease(entry, duplicate!, expected);
      },
    };
  } catch (error) {
    if (duplicate !== null) {
      try {
        closeSync(duplicate);
      } catch {
        // Preserve the primary duplicate/open/fstat failure. The descriptor
        // was never exposed or entered lease accounting.
      }
    }
    if (isOutputSnapshotMaterializationSystemError(error)) {
      throw new OutputSnapshotMaterializationError(error);
    }
    return null;
  }
}

function takeReadableSnapshotFromCache(key: string): ReadableSnapshotLease | null {
  reapReadableSnapshotLeases();
  const entry = readableSnapshotCache.get(key);
  if (!entry) return null;
  const duplicate = duplicateReadableSnapshot(entry);
  if (duplicate === null) {
    retireReadableSnapshot(entry);
    return null;
  }
  readableSnapshotCache.delete(key);
  readableSnapshotCache.set(key, entry);
  touchReadableSnapshot(entry);
  return duplicate;
}

function residentReadableSnapshotBytes(): number {
  return [...residentReadableSnapshots]
    .reduce((total, entry) => total + entry.sizeBytes, 0);
}

function evictOldestInactiveReadableSnapshot(): boolean {
  for (const entry of readableSnapshotCache.values()) {
    if (entry.leases.size !== 0) continue;
    retireReadableSnapshot(entry);
    return true;
  }
  return false;
}

function admitReadableSnapshotBuild(sizeBytes: number, maximumBytes: number): boolean {
  reapReadableSnapshotLeases();
  if (sizeBytes > maximumBytes) {
    // Exactly one oversize exception is allowed, and only while no other
    // unique snapshot inode remains resident (including retired active FDs).
    while (evictOldestInactiveReadableSnapshot()) {
      // Drain every inactive LRU entry before evaluating active residency.
    }
    return residentReadableSnapshots.size === 0;
  }
  while (residentReadableSnapshots.size >= MAX_READABLE_SNAPSHOT_CACHE_ENTRIES
    || residentReadableSnapshotBytes() + sizeBytes > maximumBytes) {
    if (!evictOldestInactiveReadableSnapshot()) return false;
  }
  return true;
}

function invalidateReadableSnapshotsForPath(path: string): void {
  reapReadableSnapshotLeases();
  for (const entry of residentReadableSnapshots) {
    if (entry.sourceBindings.some((binding) => binding.path === path)) {
      retireReadableSnapshot(entry);
    }
  }
}

function installReadableSnapshotCacheEntry(
  candidate: Omit<ReadableSnapshotCacheEntry,
    "masterFd" | "masterIdentity" | "masterCloseRetryTimer" | "leases" | "retired"
      | "expiresAtMs" | "expiryTimer"> & {
        fd: number;
        statFd: (descriptor: number) => Stats;
      },
): ReadableSnapshotLease | null {
  let masterStats: Stats;
  try {
    masterStats = candidate.statFd(candidate.fd);
  } catch (error) {
    // The candidate has not entered cache accounting yet. Close it directly;
    // cleanup failure must not replace the original fstat/materialization
    // failure that explains why installation could not proceed.
    try {
      closeSync(candidate.fd);
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
  const previous = readableSnapshotCache.get(candidate.key);
  if (previous) retireReadableSnapshot(previous);
  const entry: ReadableSnapshotCacheEntry = {
    key: candidate.key,
    masterFd: candidate.fd,
    masterIdentity: { dev: masterStats.dev, ino: masterStats.ino },
    sizeBytes: candidate.sizeBytes,
    sourceBindings: candidate.sourceBindings,
    leases: new Map(),
    retired: false,
    expiresAtMs: Date.now() + candidate.ttlMs,
    ttlMs: candidate.ttlMs,
    closeFd: candidate.closeFd,
    duplicateFd: candidate.duplicateFd,
    statDuplicateFd: candidate.statDuplicateFd,
  };
  residentReadableSnapshots.add(entry);
  readableSnapshotCache.set(entry.key, entry);
  touchReadableSnapshot(entry);
  try {
    const duplicate = duplicateReadableSnapshot(entry);
    if (duplicate === null) retireReadableSnapshot(entry);
    return duplicate;
  } catch (error) {
    // A first response descriptor could not be acquired after the master was
    // installed. Retire it immediately so a failed request does not strand a
    // cache-only descriptor until TTL expiry.
    retireReadableSnapshot(entry);
    throw error;
  }
}

function readableSnapshotCacheKey(
  root: string,
  kind: "modern" | "legacy",
  authority: unknown,
): string {
  return `${kind}:${createHash("sha256")
    .update(root)
    .update("\0")
    .update(canonicalJson(authority))
    .digest("hex")}`;
}

function hashDescriptor(fd: number, size: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (count <= 0) throw new OutputQualityError("Snapshot endete waehrend der Verifikation vorzeitig.", 409);
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

function verifyMaterializedOutput(binding: MaterializedOutputBinding): void {
  const before = fstatSync(binding.fd);
  const beforeRevision = materializedRevision(before);
  let pathStats;
  try {
    pathStats = lstatSync(binding.path);
  } catch {
    throw new OutputQualityError(`Snapshot von ${binding.outputName} ist nicht mehr vorhanden.`, 409);
  }
  if (!before.isFile()
    || before.nlink !== 1
    || (before.mode & 0o777) !== 0o444
    || pathStats.isSymbolicLink()
    || !pathStats.isFile()
    || !revisionsEqual(beforeRevision, materializedRevision(pathStats))
    || !revisionsEqual(beforeRevision, binding.revision)
    || before.size !== binding.authority.output.revision.sizeBytes) {
    throw new OutputQualityError(`Snapshot von ${binding.outputName} wurde ersetzt oder veraendert.`, 409);
  }
  const digest = hashDescriptor(binding.fd, before.size);
  const afterRevision = materializedRevision(fstatSync(binding.fd));
  if (digest !== binding.authority.output.sha256
    || !revisionsEqual(beforeRevision, afterRevision)) {
    throw new OutputQualityError(`Snapshot von ${binding.outputName} stimmt nicht mit der Jobautoritaet ueberein.`, 409);
  }
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
  /** Exact persisted request bytes after canonicalization, before schema defaults. */
  authorityBoundRequest: unknown;
  authorityRequestSha256: string;
  qualityReview: JobQualityReview | null;
  identityEvidence: IdentityInputEvidence | null;
  runProvenance: RunProvenance | null;
  experiment: ExperimentRunBinding | null;
  project: ProjectRunBinding | null;
  executionDecision: JobExecutionDecision | null;
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

export type OutputAnalysisLease = {
  target: OutputAnalysisTarget;
  authority: OutputPublicationAuthority;
  verify: (jobs?: readonly OutputAuthorityJob[]) => void;
  release: () => void;
};

export type MaterializedPublishedOutputs = {
  root: string;
  authorities: ReadonlyMap<string, OutputPublicationAuthority>;
  verify: (jobs?: readonly OutputAuthorityJob[]) => void;
  release: () => void;
};

type MaterializedOutputBinding = {
  outputName: string;
  path: string;
  fd: number;
  authority: OutputPublicationAuthority;
  revision: ExecutionFileRevision;
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

export class OutputSnapshotCapacityError extends Error {
  readonly statusCode = 503 as const;
  readonly retryAfterSeconds = 1;

  constructor() {
    super("Video-Snapshot-Kapazität ist durch aktive Wiedergaben belegt. Bitte erneut versuchen.");
    this.name = "OutputSnapshotCapacityError";
  }
}

export class OutputSnapshotMaterializationError extends Error {
  readonly statusCode = 503 as const;
  readonly retryAfterSeconds = 1;

  constructor(cause: unknown) {
    super("Video-Snapshot konnte vorübergehend nicht erstellt werden. Bitte erneut versuchen.", { cause });
    this.name = "OutputSnapshotMaterializationError";
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
    const authorityBoundRequest = structuredClone(parsed.request);
    const authorityRequestSha256 = createHash("sha256")
      .update(canonicalJson(authorityBoundRequest))
      .digest("hex");
    const request = migrateGenerationRequest(structuredClone(authorityBoundRequest));
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
    const executionDecision = Object.prototype.hasOwnProperty.call(parsed, "executionDecision")
      ? normalizeJobExecutionDecision(parsed.executionDecision)
      : null;
    if (Object.prototype.hasOwnProperty.call(parsed, "executionDecision") && !executionDecision) return null;
    const normalizedRunProvenance = ["ltx-studio-output.v5", "ltx-studio-output.v6", "ltx-studio-output.v7"]
      .includes(schemaVersion)
      ? normalizeRunProvenance(parsed.runProvenance)
      : null;
    if (executionDecision
      && (canonicalJson(normalizedRunProvenance?.executionDecision) !== canonicalJson(executionDecision)
        || !normalizedRunProvenance
        || !runProvenanceFingerprintMatches(normalizedRunProvenance))) return null;
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
      authorityBoundRequest,
      authorityRequestSha256,
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
      runProvenance: normalizedRunProvenance,
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
      executionDecision,
    };
  } catch {
    return null;
  }
}

function serializedRecord(record: OutputSettingsRecord): object {
  const authorityBoundRequest = record.authorityBoundRequest;
  const persisted = { ...record } as Partial<OutputSettingsRecord>;
  delete persisted.authorityBoundRequest;
  delete persisted.authorityRequestSha256;
  if (hasStrongRevision(record)) {
    if (record.executionDecision) return { ...persisted, request: authorityBoundRequest };
    return { ...persisted, request: authorityBoundRequest, executionDecision: undefined };
  }
  return {
    schemaVersion: "ltx-studio-output.v2",
    outputName: record.outputName,
    jobId: record.jobId,
    completedAt: record.completedAt,
    sizeBytes: record.sizeBytes,
    modifiedAtMs: record.modifiedAtMs,
    request: authorityBoundRequest,
    qualityReview: record.qualityReview,
  };
}

function writeRecord(root: string, record: OutputSettingsRecord): void {
  const path = settingsPath(root, record.outputName);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const serialized = serializedRecord(record);
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  const directoryDescriptor = openSync(root, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
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

function isArchivedOutputAuthority(job: OutputAuthorityJob): job is ArchivedOutputAuthority {
  return "schemaVersion" in job
    && job.schemaVersion === "ltx-studio-archived-output-authority.v1";
}

function currentAuthorityRequestBinding(
  job: Exclude<OutputAuthorityJob, ArchivedOutputAuthority>,
): { request: unknown; sha256: string } | null {
  const hasRaw = Object.hasOwn(job, "authorityBoundRequest");
  const hasDigest = Object.hasOwn(job, "authorityRequestSha256");
  if (hasRaw !== hasDigest) return null;
  if (!hasRaw) {
    return {
      request: job.request,
      sha256: createHash("sha256").update(canonicalJson(job.request)).digest("hex"),
    };
  }
  if (typeof job.authorityRequestSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(job.authorityRequestSha256)) return null;
  const digest = createHash("sha256").update(canonicalJson(job.authorityBoundRequest)).digest("hex");
  return digest === job.authorityRequestSha256
    ? { request: job.authorityBoundRequest, sha256: digest }
    : null;
}

function legacyHistoryForJob(
  job: OutputAuthorityJob,
  root: string,
): { history: LegacyTerminalHistory; job: CurrentOutputAuthorityJob } | null {
  if (isArchivedOutputAuthority(job) || !job.legacyHistory) return null;
  const history = normalizeLegacyTerminalHistory(job.legacyHistory, root);
  const requestBinding = currentAuthorityRequestBinding(job);
  if (!history
    || canonicalJson(history) !== canonicalJson(job.legacyHistory)
    || history.trust !== "legacy-unattested"
    || history.originalStatus !== "completed"
    || job.status !== "completed"
    || job.id !== history.jobId
    || job.outputName !== history.outputName
    || job.finishedAt !== history.finishedAt
    || job.dgxJobId !== null
    || job.executionClass !== undefined
    || job.executionDecision !== undefined
    || job.outputPublication !== undefined
    || !requestBinding
    // The receipt binds the exact raw persisted request. Its migrated digest
    // is an import-time audit fact, not a future schema-version authority:
    // recomputing it here would revoke byte-identical historical media merely
    // because a later release added a migration default.
    || requestBinding.sha256 !== history.requestSha256) return null;
  return { history, job };
}

function publicationJobAuthorityMatches(
  authority: OutputPublicationAuthority,
  job: OutputAuthorityJob,
): boolean {
  if (job.status !== "completed"
    || !job.finishedAt
    || job.outputName !== authority.outputName
    || job.id !== authority.jobId
    || job.finishedAt !== authority.publishedAt) return false;
  if (isArchivedOutputAuthority(job)) {
    const bound = normalizeOutputPublicationAuthority(job.outputPublication, authority.output.path);
    return authority.executionDecisionSha256 === job.executionDecisionSha256
      && authority.executionDecisionSha256 === job.outputPublication.executionDecisionSha256
      && bound !== null
      && canonicalJson(bound) === canonicalJson(authority)
      && authority.jobAuthoritySha256 === terminalJobAuthoritySha256({
        jobId: job.id,
        status: "completed",
        outputName: job.outputName,
        finishedAt: job.finishedAt,
        executionClass: job.executionClass,
        executionDecisionSha256: job.executionDecisionSha256,
        requestSha256: job.requestSha256,
        protocolSha256: job.protocolSha256,
        jobPersistenceRevision: authority.jobPersistenceRevision,
      })
      && (job.executionClass !== "cpu-only"
        || job.cpuOutputSha256 === authority.output.sha256);
  }
  const decision = normalizeJobExecutionDecision(job.executionDecision);
  const requestBinding = currentAuthorityRequestBinding(job);
  if (!decision
    || !requestBinding
    || decision.executionClass === "pending"
    || decision.executionClass !== job.executionClass
    || decision.requestSha256 !== requestBinding.sha256
    || decision.protocolSha256 !== (job.experiment?.protocolSha256 ?? null)
    || canonicalJson(job.runProvenance?.executionDecision) !== canonicalJson(decision)) return false;
  const decisionSha256 = createHash("sha256").update(canonicalJson(decision)).digest("hex");
  if (authority.executionDecisionSha256 !== decisionSha256) return false;
  const bound = job.outputPublication
    ? normalizeOutputPublicationAuthority(job.outputPublication, authority.output.path)
    : null;
  if (!bound || canonicalJson(bound) !== canonicalJson(authority)) return false;
  const jobAuthoritySha256 = terminalJobAuthoritySha256({
    jobId: job.id,
    status: "completed",
    outputName: job.outputName,
    finishedAt: job.finishedAt,
    executionClass: decision.executionClass,
    executionDecisionSha256: decisionSha256,
    requestSha256: decision.requestSha256,
    protocolSha256: decision.protocolSha256,
    jobPersistenceRevision: authority.jobPersistenceRevision,
  });
  if (authority.jobAuthoritySha256 !== jobAuthoritySha256) return false;
  return decision.executionClass !== "cpu-only"
    || (decision.operation.state === "succeeded"
      && decision.operation.output !== null
      && decision.operation.output.sha256 === authority.output.sha256);
}

function recordMatchesAuthority(
  record: OutputSettingsRecord,
  job: OutputAuthorityJob,
): boolean {
  if (isArchivedOutputAuthority(job)) {
    const decision = normalizeJobExecutionDecision(record.executionDecision);
    return record.jobId === job.id
      && record.completedAt === job.finishedAt
      && decision !== null
      && createHash("sha256").update(canonicalJson(decision)).digest("hex")
        === job.executionDecisionSha256
      && record.authorityRequestSha256 === job.requestSha256
      && record.runProvenance !== null
      && createHash("sha256").update(canonicalJson(record.runProvenance)).digest("hex")
        === job.runProvenanceSha256
      && (record.identityEvidence === null
        ? null
        : createHash("sha256").update(canonicalJson(record.identityEvidence)).digest("hex"))
        === job.identityEvidenceSha256
      && (record.experiment === null
        ? null
        : createHash("sha256").update(canonicalJson(record.experiment)).digest("hex"))
        === job.experimentSha256
      && (record.project === null
        ? null
        : createHash("sha256").update(canonicalJson(record.project)).digest("hex"))
        === job.projectSha256;
  }
  const decision = normalizeJobExecutionDecision(job.executionDecision);
  const requestBinding = currentAuthorityRequestBinding(job);
  return record.jobId === job.id
    && record.completedAt === job.finishedAt
    && decision !== null
    && requestBinding !== null
    && canonicalJson(record.executionDecision) === canonicalJson(decision)
    && record.authorityRequestSha256 === requestBinding.sha256
    && record.authorityRequestSha256 === decision.requestSha256
    && canonicalJson(record.request) === canonicalJson(job.request);
}

export function supportsSpeechQuality(request: GenerationRequest): boolean {
  return request.mode !== "text-to-audio" && usesOfficialSpeechStack(request);
}

export type OutputLibraryStorage = {
  root: string;
  recovery: {
    coordinator: DataRecoveryCoordinator;
    targetPrefix: string;
  };
};

export type OutputLibraryOptions = {
  /** Test/operations override; production keeps the bounded 2-GiB residency budget. */
  readableSnapshotCacheMaxBytes?: number;
  /** Test/operations override for inactive master retention. */
  readableSnapshotCacheTtlMs?: number;
  /** Test-only observation after admission and immediately before materialization. */
  onReadableSnapshotBuild?: (key: string, sizeBytes: number) => void;
  /** Fault-injection seam for descriptor-release regression tests. */
  closeReadableSnapshotFd?: (descriptor: number) => void;
  /** Fault-injection seam shared by modern and legacy snapshot materialization. */
  openAnonymousReadableSnapshot?: OutputSnapshotOperations["openAnonymousSnapshot"];
  /** Fault-injection seam for cache-install descriptor ownership. */
  statReadableSnapshotFd?: (descriptor: number) => Stats;
  /** Fault-injection seam for the read-only response-FD duplicate. */
  duplicateReadableSnapshotFd?: (masterDescriptor: number) => number;
  /** Fault-injection seam for response-FD identity verification. */
  statReadableSnapshotDuplicateFd?: (descriptor: number) => Stats;
};

export type ExperimentPreflightOutputEvidence = {
  outputs: StudioOutput[];
  reusableCandidates: ReusableLtxBaseCandidate[];
};

export class OutputLibrary {
  private readonly root: string;
  private readonly recovery: OutputLibraryStorage["recovery"] | null;
  private latestJobs: readonly OutputAuthorityJob[] = [];
  private jobSource: (() => readonly OutputAuthorityJob[]) | null = null;
  private authorityRevoker: ((outputName: string, expectedJobId: string) => void) | null = null;
  private readonly readableSnapshotCacheMaxBytes: number;
  private readonly readableSnapshotCacheTtlMs: number;
  private readonly onReadableSnapshotBuild: OutputLibraryOptions["onReadableSnapshotBuild"];
  private readonly closeReadableSnapshotFd: (descriptor: number) => void;
  private readonly openAnonymousReadableSnapshot:
    NonNullable<OutputLibraryOptions["openAnonymousReadableSnapshot"]> | undefined;
  private readonly statReadableSnapshotFd: (descriptor: number) => Stats;
  private readonly duplicateReadableSnapshotFd: (masterDescriptor: number) => number;
  private readonly statReadableSnapshotDuplicateFd: (descriptor: number) => Stats;

  constructor(storage: string | OutputLibraryStorage, options: OutputLibraryOptions = {}) {
    this.root = typeof storage === "string" ? storage : storage.root;
    this.recovery = typeof storage === "string" ? null : storage.recovery;
    const maximumBytes = options.readableSnapshotCacheMaxBytes
      ?? MAX_READABLE_SNAPSHOT_CACHE_BYTES;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new Error("Readable-Snapshot-Cache-Limit muss eine positive sichere Ganzzahl sein.");
    }
    this.readableSnapshotCacheMaxBytes = maximumBytes;
    const ttlMs = options.readableSnapshotCacheTtlMs ?? READABLE_SNAPSHOT_CACHE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Readable-Snapshot-Cache-TTL muss eine positive sichere Ganzzahl sein.");
    }
    this.readableSnapshotCacheTtlMs = ttlMs;
    this.onReadableSnapshotBuild = options.onReadableSnapshotBuild;
    this.closeReadableSnapshotFd = options.closeReadableSnapshotFd ?? closeSync;
    this.openAnonymousReadableSnapshot = options.openAnonymousReadableSnapshot;
    this.statReadableSnapshotFd = options.statReadableSnapshotFd ?? fstatSync;
    this.duplicateReadableSnapshotFd = options.duplicateReadableSnapshotFd
      ?? ((descriptor) => openSync(`/proc/self/fd/${descriptor}`, constants.O_RDONLY));
    this.statReadableSnapshotDuplicateFd = options.statReadableSnapshotDuplicateFd ?? fstatSync;
    if (this.recovery) {
      this.recovery.coordinator.recover();
      this.recovery.coordinator.verifyCommittedTargets();
    }
  }

  wireJobSource(source: () => readonly OutputAuthorityJob[]): void {
    this.jobSource = source;
  }

  wireAuthorityRevoker(revoker: (outputName: string, expectedJobId: string) => void): void {
    this.authorityRevoker = revoker;
  }

  private authoritativeJobs(explicit?: readonly OutputAuthorityJob[]): readonly OutputAuthorityJob[] {
    return explicit ?? this.jobSource?.() ?? this.latestJobs;
  }

  private openAuthoritativeSource(
    outputName: string,
    jobs?: readonly OutputAuthorityJob[],
    expectedJobId?: string,
  ): { lease: OpenOutputPublicationAuthority; job: OutputAuthorityJob } | null {
    const lease = openValidOutputPublicationAuthority(this.root, outputName);
    if (!lease) return null;
    const candidates = this.authoritativeJobs(jobs).filter((job) =>
      job.id === lease.authority.jobId
      && job.outputName === outputName
      && (expectedJobId === undefined || job.id === expectedJobId));
    const job = candidates.length === 1 ? candidates[0] : null;
    if (!job || !publicationJobAuthorityMatches(lease.authority, job)) {
      closeSync(lease.fd);
      return null;
    }
    return { lease, job };
  }

  private readStatAuthoritative(
    outputName: string,
    jobs?: readonly OutputAuthorityJob[],
    expectedJobId?: string,
  ): { authority: OutputPublicationAuthority; job: OutputAuthorityJob } | null {
    const authority = readStatBoundOutputPublicationAuthority(this.root, outputName);
    if (!authority) return null;
    const candidates = this.authoritativeJobs(jobs).filter((job) =>
      job.id === authority.jobId
      && job.outputName === outputName
      && (expectedJobId === undefined || job.id === expectedJobId));
    const job = candidates.length === 1 ? candidates[0] : null;
    return job && publicationJobAuthorityMatches(authority, job)
      ? { authority, job }
      : null;
  }

  private readStatLegacy(
    outputName: string,
    jobs?: readonly OutputAuthorityJob[],
    expectedJobId?: string,
  ): { history: LegacyTerminalHistory; job: CurrentOutputAuthorityJob } | null {
    const candidates = this.authoritativeJobs(jobs).filter((job) =>
      job.outputName === outputName
      && (expectedJobId === undefined || job.id === expectedJobId))
      .flatMap((job) => {
        const legacy = legacyHistoryForJob(job, this.root);
        return legacy && legacyArtifactStatsStillMatch(legacy.history) ? [legacy] : [];
      });
    return candidates.length === 1 ? candidates[0] : null;
  }

  readPublishedOutputAuthority(
    outputName: string,
    jobs?: readonly OutputAuthorityJob[],
    expectedJobId?: string,
  ): OutputPublicationAuthority | null {
    if (!outputNameSchema.safeParse(outputName).success) return null;
    const opened = this.openAuthoritativeSource(outputName, jobs, expectedJobId);
    if (!opened) return null;
    try {
      return opened.lease.authority;
    } finally {
      closeSync(opened.lease.fd);
    }
  }

  delete(outputName: string, jobs: readonly OutputAuthorityJob[]): DeletedStudioOutput {
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

    const publication = this.readPublishedOutputAuthority(outputName, jobs);
    if (!publication) {
      throw new OutputDeleteError("Ausgabe nicht gefunden.", 404);
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
    // The durable marker unlink is the public revocation fence. If the
    // process crashes after it, neither the current job nor the archive can
    // resurrect the bytes during restore/reconciliation.
    removeOutputPublicationAuthority(outputPath);
    invalidateReadableSnapshotsForPath(outputPath);
    deletedArtifacts.push(`${outputName}${OUTPUT_PUBLICATION_SUFFIX}`);
    this.authorityRevoker?.(outputName, publication.jobId);
    for (const artifactName of artifactNames) {
      const artifactPath = join(this.root, artifactName);
      if (!existsSync(artifactPath) || !lstatSync(artifactPath).isFile()) continue;
      unlinkSync(artifactPath);
      deletedArtifacts.push(artifactName);
    }
    const directoryDescriptor = openSync(this.root, "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    return {
      name: outputName,
      sizeBytes: stats.size,
      deletedArtifacts,
    };
  }

  recordCompleted(jobs: readonly OutputAuthorityJob[]): void {
    this.latestJobs = jobs;
    for (const job of jobs) {
      if (isArchivedOutputAuthority(job)) continue;
      if (job.status !== "completed" || !job.finishedAt) continue;
      const executionDecision = job.executionDecision
        ? normalizeJobExecutionDecision(job.executionDecision)
        : null;
      const requestBinding = currentAuthorityRequestBinding(job);
      if (!executionDecision
        || !requestBinding
        || executionDecision.executionClass !== job.executionClass
        || executionDecision.executionClass === "pending"
        || executionDecision.requestSha256 !== requestBinding.sha256
        || executionDecision.protocolSha256 !== (job.experiment?.protocolSha256 ?? null)
        || (executionDecision.executionClass === "cpu-only"
          && executionDecision.operation.state !== "succeeded")
        || canonicalJson(job.runProvenance?.executionDecision) !== canonicalJson(executionDecision)) continue;
      const outputPath = join(this.root, job.outputName);
      const publication = this.readStatAuthoritative(job.outputName, jobs, job.id)?.authority ?? null;
      if (!publication
        || publication.jobId !== job.id
        || publication.publishedAt !== job.finishedAt
        || publication.executionDecisionSha256
          !== createHash("sha256").update(canonicalJson(executionDecision)).digest("hex")) continue;
      if (!existsSync(outputPath)) continue;
      const stats = statSync(outputPath);
      if (!stats.isFile() || stats.size <= 0) continue;
      const existing = readRecord(this.root, job.outputName);
      if (existing) {
        if (existing.executionDecision === null
          && existing.jobId === job.id
          && existing.completedAt === job.finishedAt
          && recordMatchesFile(existing, stats)) {
          this.writeRecord({
            schemaVersion: "ltx-studio-output.v7",
            outputName: job.outputName,
            jobId: job.id,
            completedAt: job.finishedAt,
            sizeBytes: stats.size,
            modifiedAtMs: stats.mtimeMs,
            changedAtMs: stats.ctimeMs,
            fileId: String(stats.ino),
            request: job.request,
            authorityBoundRequest: structuredClone(requestBinding.request),
            authorityRequestSha256: requestBinding.sha256,
            qualityReview: null,
            identityEvidence: job.identityEvidence,
            runProvenance: job.runProvenance,
            experiment: job.experiment,
            project: job.project,
            executionDecision,
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
        authorityBoundRequest: structuredClone(requestBinding.request),
        authorityRequestSha256: requestBinding.sha256,
        qualityReview: null,
        identityEvidence: job.identityEvidence,
        runProvenance: job.runProvenance,
        experiment: job.experiment,
        project: job.project,
        executionDecision,
      };
      this.writeRecord(record);
    }
  }

  setQualityReview(
    outputName: string,
    input: QualityReviewInput,
    jobs: readonly OutputAuthorityJob[],
  ): StudioOutput {
    const validated = qualityReviewInputSchema.parse(input);
    if (!outputNameSchema.safeParse(outputName).success) {
      throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    }
    const outputPath = join(this.root, outputName);
    const authority = this.readPublishedOutputAuthority(outputName, jobs);
    if (!authority) {
      throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    }
    const authoritativeJob = jobs.find((job) => job.id === authority.jobId);
    const stats = statSync(outputPath);
    const record = readRecord(this.root, outputName);
    if (!record
      || !authoritativeJob
      || !stats.isFile()
      || stats.size <= 0
      || !recordMatchesFile(record, stats)
      || !recordMatchesAuthority(record, authoritativeJob)) {
      throw new OutputQualityError(
        "Die Ausgabe hat keine passende Studio-Provenienz oder wurde nachträglich verändert.",
        409,
      );
    }
    if (!supportsSpeechQuality(record.request)) {
      throw new OutputQualityError("Nur ein fertiges Sprachvideo kann mit der LipSync-Scorecard bewertet werden.", 409);
    }
    this.writeRecord({
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

  private writeRecord(record: OutputSettingsRecord): void {
    if (!this.recovery) {
      writeRecord(this.root, record);
      return;
    }
    const path = settingsPath(this.root, record.outputName);
    this.recovery.coordinator.commitJson({
      targetKind: "provenance",
      targetRelativePath: [
        this.recovery.targetPrefix.replace(/\/$/, ""),
        `${record.outputName}${SIDECAR_SUFFIX}`,
      ].filter(Boolean).join("/"),
      expectedAbsolutePath: path,
      value: serializedRecord(record),
    });
  }

  reusableLtxBaseCandidates(jobs?: readonly OutputAuthorityJob[]): ReusableLtxBaseCandidate[] {
    const currentJobs = this.authoritativeJobs(jobs);
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && outputNameSchema.safeParse(entry.name).success)
      .flatMap((entry): ReusableLtxBaseCandidate[] => {
        const authority = this.readPublishedOutputAuthority(entry.name, currentJobs);
        if (!authority) return [];
        const authoritativeJob = currentJobs.find((job) => job.id === authority.jobId);
        if (!authoritativeJob) return [];
        const outputPath = join(this.root, entry.name);
        let stats;
        try {
          stats = statSync(outputPath);
        } catch {
          return [];
        }
        if (!stats.isFile() || stats.size <= 0) return [];
        const record = readRecord(this.root, entry.name);
        if (!record
          || !hasStrongRevision(record)
          || !recordMatchesFile(record, stats)
          || !recordMatchesAuthority(record, authoritativeJob)) return [];
        if (!record.identityEvidence || !record.runProvenance) return [];
        const analysis = readOutputAnalysis(this.root, entry.name, {
          sizeBytes: stats.size,
          modifiedAtMs: stats.mtimeMs,
          changedAtMs: stats.ctimeMs,
          fileId: String(stats.ino),
          jobId: record.jobId,
        });
        return [{
          outputName: record.outputName,
          outputPath,
          jobId: record.jobId,
          request: record.request,
          authorityBoundRequest: record.authorityBoundRequest,
          authorityRequestSha256: record.authorityRequestSha256,
          identityEvidence: record.identityEvidence,
          runProvenance: record.runProvenance,
          settingsSidecarPath: settingsPath(this.root, record.outputName),
          analysisSidecarPath: join(this.root, `${record.outputName}.ltx-analysis.json`),
          analysisSidecarVerified: analysis?.status === "completed",
        }];
      });
  }

  resolveAnalysisTarget(outputName: string, jobs?: readonly OutputAuthorityJob[]): OutputAnalysisTarget {
    if (!outputNameSchema.safeParse(outputName).success) {
      throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    }
    const currentJobs = this.authoritativeJobs(jobs);
    const outputPath = join(this.root, outputName);
    const authority = this.readPublishedOutputAuthority(outputName, currentJobs);
    if (!authority) throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    const authoritativeJob = currentJobs.find((job) => job.id === authority.jobId);
    const stats = statSync(outputPath);
    const record = readRecord(this.root, outputName);
    if (!record
      || !authoritativeJob
      || !stats.isFile()
      || stats.size <= 0
      || !recordMatchesFile(record, stats)
      || !recordMatchesAuthority(record, authoritativeJob)) {
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

  openAnalysisTarget(outputName: string, jobs?: readonly OutputAuthorityJob[]): OutputAnalysisLease {
    const currentJobs = this.authoritativeJobs(jobs);
    const sourceTarget = this.resolveAnalysisTarget(outputName, currentJobs);
    const materialized = this.createMaterializedPublishedOutputs([outputName], currentJobs);
    const authority = materialized.authorities.get(outputName);
    if (!authority) {
      materialized.release();
      throw new OutputQualityError("Ausgabe ist nicht autoritativ verfügbar.", 404);
    }
    if (authority.jobId !== sourceTarget.jobId
      || authority.output.revision.sizeBytes !== sourceTarget.sizeBytes
      || Math.abs(authority.output.revision.modifiedAtMs - sourceTarget.modifiedAtMs) >= 1
      || Math.abs(authority.output.revision.changedAtMs - sourceTarget.changedAtMs) >= 1
      || authority.output.revision.fileId !== sourceTarget.fileId) {
      materialized.release();
      throw new OutputQualityError("Ausgabe änderte sich während der Analyse-Bindung.", 409);
    }
    return {
      target: {
        ...sourceTarget,
        outputPath: join(materialized.root, outputName),
      },
      authority,
      verify: materialized.verify,
      release: materialized.release,
    };
  }

  async captureProjectOutputEvidence(
    outputName: string,
    expectedProject: Pick<ProjectRunBinding, "projectId" | "shotId" | "requestRevisionId">,
    jobs: readonly OutputAuthorityJob[],
    recordedAt = new Date().toISOString(),
  ): Promise<ProjectOutputEvidence> {
    if (!outputNameSchema.safeParse(outputName).success) {
      throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    }
    this.recordCompleted(jobs);
    const outputPath = join(this.root, outputName);
    const authority = this.readPublishedOutputAuthority(outputName, jobs);
    if (!authority) {
      throw new OutputQualityError("Ausgabe nicht gefunden.", 404);
    }
    const authoritativeJob = jobs.find((job) => job.id === authority.jobId);
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
      || !authoritativeJob
      || !hasStrongRevision(record)
      || !recordMatchesFile(record, stats)
      || !recordMatchesAuthority(record, authoritativeJob)
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
    const currentAuthority = this.readPublishedOutputAuthority(outputName, jobs);
    if (
      after.isSymbolicLink()
      || afterSidecar.isSymbolicLink()
      || !afterSidecar.isFile()
      || !afterRecord
      || !currentAuthority
      || canonicalJson(currentAuthority) !== canonicalJson(authority)
      || !hasStrongRevision(afterRecord)
      || !recordMatchesFile(afterRecord, after)
      || afterRecord.jobId !== record.jobId
      || sha256Json(afterRecord.authorityBoundRequest) !== sha256Json(record.authorityBoundRequest)
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
      requestSha256: sha256Json(record.authorityBoundRequest),
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

  list(jobs: readonly OutputAuthorityJob[]): StudioOutput[] {
    this.recordCompleted(jobs);
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && outputNameSchema.safeParse(entry.name).success)
      .map((entry): StudioOutput | null => {
        const opened = this.readStatAuthoritative(entry.name, jobs);
        if (!opened) {
          const legacy = this.readStatLegacy(entry.name, jobs);
          if (!legacy?.history.artifact) return null;
          const stats = statSync(join(this.root, entry.name));
          if (!stats.isFile()
            || stats.size <= 0
            || !legacyArtifactStatsStillMatch(legacy.history)) return null;
          return {
            name: entry.name,
            url: `/api/outputs/${encodeURIComponent(entry.name)}`,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            changedAt: stats.ctime.toISOString(),
            fileId: String(stats.ino),
            jobId: legacy.job.id,
            jobStatus: "completed",
            request: structuredClone(legacy.job.request),
            // The request remains visible for historical inspection, but is
            // deliberately not loadable as a trusted/rerunnable template.
            settingsAvailable: false,
            qualityReview: null,
            analysis: null,
            provenance: null,
            experiment: null,
            project: null,
            executionDecision: null,
            experimentRequestVerified: false,
            trustStatus: "legacy-unattested",
          };
        }
        {
          const publication = opened.authority;
          const stats = statSync(join(this.root, entry.name));
          if (stats.size <= 0) return null;
          const rechecked = this.readStatAuthoritative(entry.name, jobs, opened.job.id);
          if (!rechecked || canonicalJson(rechecked.authority) !== canonicalJson(publication)) return null;
          const record = readRecord(this.root, entry.name);
          const settingsMatch = Boolean(
            record
            && recordMatchesFile(record, stats)
            && recordMatchesAuthority(record, opened.job),
          );
          return {
            name: entry.name,
            url: `/api/outputs/${encodeURIComponent(entry.name)}`,
            sizeBytes: stats.size,
            modifiedAt: stats.mtime.toISOString(),
            changedAt: stats.ctime.toISOString(),
            fileId: String(stats.ino),
            jobId: settingsMatch ? record?.jobId ?? publication.jobId : publication.jobId,
            jobStatus: "completed",
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
            executionDecision: settingsMatch ? record?.executionDecision ?? null : null,
            experimentRequestVerified: Boolean(
              settingsMatch
              && record?.experiment
              && record.request
              && sha256Json(record.authorityBoundRequest) === record.experiment.requestSha256,
            ),
            trustStatus: "verified-publication",
          };
        }
      })
      .filter((output): output is StudioOutput => output !== null)
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
      .slice(0, MAX_OUTPUTS);
  }

  /**
   * Strictly read-only output view for the experiment admission preflight.
   *
   * Unlike list(), this must never reconcile or materialize a settings
   * sidecar.  It also takes the slower content-verifying authority path so a
   * preflight cannot accept a merely stat-matching output.  Missing or legacy
   * settings therefore stay unavailable until a normal reconciliation path
   * explicitly upgrades them.
   */
  inspectExperimentPreflightEvidence(
    outputNames: readonly string[],
    jobs: readonly OutputAuthorityJob[],
  ): ExperimentPreflightOutputEvidence {
    const outputs: StudioOutput[] = [];
    const reusableCandidates: ReusableLtxBaseCandidate[] = [];
    for (const outputName of new Set(outputNames)) {
      if (!outputNameSchema.safeParse(outputName).success) continue;
      const opened = this.openAuthoritativeSource(outputName, jobs);
      if (!opened) continue;
      try {
        const before = fstatSync(opened.lease.fd);
        if (before.size <= 0
          || !revisionsEqual(
            materializedRevision(before),
            opened.lease.authority.output.revision,
          )) continue;
        const record = readRecord(this.root, outputName);
        const settingsMatch = Boolean(
          record
          && recordMatchesFile(record, before)
          && recordMatchesAuthority(record, opened.job),
        );
        const analysis = settingsMatch && record && hasStrongRevision(record)
          ? readOutputAnalysis(this.root, outputName, {
              sizeBytes: before.size,
              modifiedAtMs: before.mtimeMs,
              changedAtMs: before.ctimeMs,
              fileId: String(before.ino),
              jobId: record.jobId,
            })
          : null;
        const after = fstatSync(opened.lease.fd);
        const rechecked = this.readStatAuthoritative(outputName, jobs, opened.job.id);
        if (!revisionsEqual(materializedRevision(before), materializedRevision(after))
          || !rechecked
          || canonicalJson(rechecked.authority) !== canonicalJson(opened.lease.authority)) continue;
        const publication = opened.lease.authority;
        outputs.push({
          name: outputName,
          url: `/api/outputs/${encodeURIComponent(outputName)}`,
          sizeBytes: after.size,
          modifiedAt: after.mtime.toISOString(),
          changedAt: after.ctime.toISOString(),
          fileId: String(after.ino),
          jobId: settingsMatch ? record?.jobId ?? publication.jobId : publication.jobId,
          jobStatus: "completed",
          request: settingsMatch ? record?.request ?? null : null,
          settingsAvailable: settingsMatch,
          qualityReview: settingsMatch ? record?.qualityReview ?? null : null,
          analysis,
          provenance: settingsMatch ? record?.runProvenance ?? null : null,
          experiment: settingsMatch ? record?.experiment ?? null : null,
          project: settingsMatch ? record?.project ?? null : null,
          executionDecision: settingsMatch ? record?.executionDecision ?? null : null,
          experimentRequestVerified: Boolean(
            settingsMatch
            && record?.experiment
            && record.request
            && sha256Json(record.authorityBoundRequest) === record.experiment.requestSha256,
          ),
        });
        if (settingsMatch
          && record
          && hasStrongRevision(record)
          && record.identityEvidence
          && record.runProvenance) {
          reusableCandidates.push({
            outputName,
            outputPath: join(this.root, outputName),
            jobId: record.jobId,
            request: record.request,
            identityEvidence: record.identityEvidence,
            runProvenance: record.runProvenance,
            settingsSidecarPath: settingsPath(this.root, outputName),
            analysisSidecarPath: join(this.root, `${outputName}.ltx-analysis.json`),
            analysisSidecarVerified: analysis?.status === "completed",
          });
        }
      } finally {
        closeSync(opened.lease.fd);
      }
    }
    return {
      outputs: outputs
        .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
        .slice(0, MAX_OUTPUTS),
      reusableCandidates,
    };
  }

  /** Returns a path only while current job state and its durable marker agree. */
  resolvePublishedPath(
    outputName: string,
    jobs?: readonly OutputAuthorityJob[],
    expectedJobId?: string,
  ): string | null {
    if (!outputNameSchema.safeParse(outputName).success) return null;
    if (!this.readPublishedOutputAuthority(outputName, jobs, expectedJobId)) return null;
    return join(this.root, outputName);
  }

  /** Returns only a fully copied and rehashed anonymous snapshot, never the mutable source FD. */
  openPublishedOutput(
    outputName: string,
    jobs?: readonly OutputAuthorityJob[],
    expectedJobId?: string,
  ): OpenOutputPublicationAuthority | null {
    if (!outputNameSchema.safeParse(outputName).success) return null;
    const opened = this.openAuthoritativeSource(outputName, jobs, expectedJobId);
    if (!opened) return null;
    try {
      return this.openAnonymousReadableSnapshot
        ? createVerifiedOutputSnapshot(opened.lease, this.root, {
            openAnonymousSnapshot: this.openAnonymousReadableSnapshot,
          })
        : createVerifiedOutputSnapshot(opened.lease, this.root);
    } catch (error) {
      // createVerifiedOutputSnapshot consumes/closes the source lease on every path.
      if (isOutputSnapshotMaterializationSystemError(error)) {
        throw new OutputSnapshotMaterializationError(error);
      }
      return null;
    }
  }

  /** Playback/download only. Legacy results remain excluded from every modern authority consumer. */
  openReadableOutput(
    outputName: string,
    jobs?: readonly OutputAuthorityJob[],
    expectedJobId?: string,
  ): ({ fd: number; outputPath: string; release: () => void }
    | (OpenOutputPublicationAuthority & { release: () => void })) | null {
    if (!outputNameSchema.safeParse(outputName).success) return null;
    const modern = this.readStatAuthoritative(outputName, jobs, expectedJobId);
    if (modern) {
      const key = readableSnapshotCacheKey(this.root, "modern", modern.authority);
      const cached = takeReadableSnapshotFromCache(key);
      if (cached !== null) {
        return {
          authority: modern.authority,
          fd: cached.fd,
          outputPath: `/proc/${process.pid}/fd/${cached.fd}`,
          release: cached.release,
        };
      }
      const sizeBytes = modern.authority.output.revision.sizeBytes;
      if (!admitReadableSnapshotBuild(sizeBytes, this.readableSnapshotCacheMaxBytes)) {
        throw new OutputSnapshotCapacityError();
      }
      this.onReadableSnapshotBuild?.(key, sizeBytes);
      const published = this.openPublishedOutput(outputName, jobs, expectedJobId);
      if (!published) return null;
      let duplicate: ReadableSnapshotLease | null;
      try {
        duplicate = installReadableSnapshotCacheEntry({
          key,
          fd: published.fd,
          sizeBytes,
          sourceBindings: [{
            path: published.authority.output.path,
            revision: published.authority.output.revision,
          }],
          ttlMs: this.readableSnapshotCacheTtlMs,
          closeFd: this.closeReadableSnapshotFd,
          duplicateFd: this.duplicateReadableSnapshotFd,
          statDuplicateFd: this.statReadableSnapshotDuplicateFd,
          statFd: this.statReadableSnapshotFd,
        });
      } catch (error) {
        if (isOutputSnapshotMaterializationSystemError(error)) {
          throw new OutputSnapshotMaterializationError(error);
        }
        throw error;
      }
      if (duplicate === null) return null;
      return {
        authority: published.authority,
        fd: duplicate.fd,
        outputPath: `/proc/${process.pid}/fd/${duplicate.fd}`,
        snapshotBackend: published.snapshotBackend,
        release: duplicate.release,
      };
    }
    const legacy = this.readStatLegacy(outputName, jobs, expectedJobId);
    if (!legacy) return null;
    const key = readableSnapshotCacheKey(this.root, "legacy", legacy.history);
    const cached = takeReadableSnapshotFromCache(key);
    if (cached !== null) {
      return {
        fd: cached.fd,
        outputPath: `/proc/${process.pid}/fd/${cached.fd}`,
        release: cached.release,
      };
    }
    const sizeBytes = legacy.history.artifact!.output.revision.sizeBytes;
    if (!admitReadableSnapshotBuild(sizeBytes, this.readableSnapshotCacheMaxBytes)) {
      throw new OutputSnapshotCapacityError();
    }
    this.onReadableSnapshotBuild?.(key, sizeBytes);
    let snapshot: ReturnType<typeof createVerifiedLegacyOutputSnapshot>;
    try {
      snapshot = this.openAnonymousReadableSnapshot
        ? createVerifiedLegacyOutputSnapshot(legacy.history, {
            openAnonymousSnapshot: this.openAnonymousReadableSnapshot,
          })
        : createVerifiedLegacyOutputSnapshot(legacy.history);
    } catch (error) {
      if (isOutputSnapshotMaterializationSystemError(error)) {
        throw new OutputSnapshotMaterializationError(error);
      }
      return null;
    }
    if (snapshot === null) return null;
    let duplicate: ReadableSnapshotLease | null;
    try {
      duplicate = installReadableSnapshotCacheEntry({
        key,
        fd: snapshot.fd,
        sizeBytes,
        sourceBindings: [{
          path: legacy.history.artifact!.output.path,
          revision: snapshot.sourceOutputRevision,
        }, {
          path: legacy.history.artifact!.settings.path,
          revision: snapshot.sourceSettingsRevision,
        }],
        ttlMs: this.readableSnapshotCacheTtlMs,
        closeFd: this.closeReadableSnapshotFd,
        duplicateFd: this.duplicateReadableSnapshotFd,
        statDuplicateFd: this.statReadableSnapshotDuplicateFd,
        statFd: this.statReadableSnapshotFd,
      });
    } catch (error) {
      if (isOutputSnapshotMaterializationSystemError(error)) {
        throw new OutputSnapshotMaterializationError(error);
      }
      throw error;
    }
    return duplicate === null
      ? null
      : {
          fd: duplicate.fd,
          outputPath: `/proc/${process.pid}/fd/${duplicate.fd}`,
          release: duplicate.release,
        };
  }

  private createMaterializedPublishedOutputs(
    outputNames: readonly string[],
    jobs?: readonly OutputAuthorityJob[],
  ): MaterializedPublishedOutputs {
    const snapshotRoot = mkdtempSync(join(tmpdir(), "ltx-output-consumer-"));
    chmodSync(snapshotRoot, 0o700);
    const authorities = new Map<string, OutputPublicationAuthority>();
    const bindings = new Map<string, MaterializedOutputBinding>();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const binding of bindings.values()) {
        try {
          closeSync(binding.fd);
        } catch {
          // Idempotent cleanup must continue through every held descriptor.
        }
      }
      bindings.clear();
      rmSync(snapshotRoot, { recursive: true, force: true });
    };
    try {
      for (const outputName of new Set(outputNames)) {
        const lease = this.openPublishedOutput(outputName, jobs);
        if (!lease) throw new OutputQualityError(`Ausgabe ${outputName} ist nicht autoritativ verfügbar.`, 404);
        const destination = join(snapshotRoot, outputName);
        try {
          copyFileSync(lease.outputPath, destination, constants.COPYFILE_EXCL);
        } finally {
          closeSync(lease.fd);
        }
        // The directory remains 0700 and the inode stays held/rehashed.  The
        // file itself must be world-readable so a systemd DynamicUser can read
        // the read-only bind mount without gaining access to the private parent.
        chmodSync(destination, 0o444);
        const descriptor = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          fsyncSync(descriptor);
          const stats = fstatSync(descriptor);
          const binding: MaterializedOutputBinding = {
            outputName,
            path: destination,
            fd: descriptor,
            authority: lease.authority,
            revision: materializedRevision(stats),
          };
          verifyMaterializedOutput(binding);
          bindings.set(outputName, binding);
        } catch (error) {
          closeSync(descriptor);
          throw error;
        }
        authorities.set(outputName, lease.authority);
      }
      const descriptor = openSync(snapshotRoot, "r");
      try {
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      const verify = (currentJobs?: readonly OutputAuthorityJob[]) => {
        if (released) throw new OutputQualityError("Ausgabe-Snapshot wurde bereits freigegeben.", 409);
        for (const binding of bindings.values()) verifyMaterializedOutput(binding);
        const authoritativeJobs = this.authoritativeJobs(currentJobs ?? jobs);
        for (const binding of bindings.values()) {
          const current = this.readPublishedOutputAuthority(
            binding.outputName,
            authoritativeJobs,
            binding.authority.jobId,
          );
          if (canonicalJson(current) !== canonicalJson(binding.authority)) {
            throw new OutputQualityError(
              `Job-/Publikationsautorität von ${binding.outputName} änderte sich während der Verarbeitung.`,
              409,
            );
          }
        }
      };
      const result: MaterializedPublishedOutputs = {
        root: snapshotRoot,
        authorities,
        verify,
        release,
      };
      result.verify(jobs);
      return result;
    } catch (error) {
      release();
      throw error;
    }
  }

  async materializePublishedOutputs(
    outputNames: readonly string[],
    jobs?: readonly OutputAuthorityJob[],
  ): Promise<MaterializedPublishedOutputs> {
    return this.createMaterializedPublishedOutputs(outputNames, jobs);
  }
}
