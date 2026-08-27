import { spawn } from "node:child_process";
import {
  createHash,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { extname, isAbsolute, resolve, sep } from "node:path";

import { z } from "zod";

import {
  BLIND_EVALUATION_LIMITATION,
  BLIND_EVALUATION_NORMALIZATION_ARGS_TEMPLATE,
  BLIND_EVALUATION_PADDING_BUCKET_BYTES,
  BLIND_EVALUATION_THREAT_MODEL,
  blindEvaluationCommitmentPreimageSchema,
  blindEvaluationCreatingPublicSchema,
  blindEvaluationInitialPinSchema,
  blindEvaluationInitialPublicState,
  blindEvaluationMediaAccessRecordSchema,
  blindEvaluationMeasuredMediaSchema,
  blindEvaluationNormalizationProfileSchema,
  blindEvaluationPublicSchema,
  blindEvaluationRecordSchema,
  blindEvaluationReleaseBindingSchema,
  blindEvaluationSubmissionInputSchema,
  blindEvaluationSubmissionPinSchema,
  blindEvaluationSubmissionPreimageSchema,
  blindEvaluationSubmissionRecordSchema,
  blindEvaluationTerminalRecordSchema,
  blindEvaluationTimelineRequirements,
  canonicalBlindEvaluationJson,
  type BlindEvaluationChannel,
  type BlindEvaluationCommitmentPreimage,
  type BlindEvaluationFileRevision,
  type BlindEvaluationInitialPin,
  type BlindEvaluationMediaAccessRecord,
  type BlindEvaluationMediaBinding,
  type BlindEvaluationMeasuredMedia,
  type BlindEvaluationNormalizationProfile,
  type BlindEvaluationPrivateFileRevision,
  type BlindEvaluationPublic,
  type BlindEvaluationRecord,
  type BlindEvaluationSnapshotBinding,
  type BlindEvaluationSubmissionInput,
  type BlindEvaluationSubmissionPin,
  type BlindEvaluationTerminalRecord,
  type BlindEvaluationToolBinding,
} from "../shared/blindEvaluation.js";
import type { ControlledExperiment } from "../shared/experiments.js";
import type { StudioOutput } from "../shared/outputs.js";
import {
  outputVerifiesExperimentArmRun,
  sha256Json,
} from "./experimentStore.js";
import { hostTcbExecutables } from "./config.js";
import { releaseIdentity } from "./releaseIdentity.js";
import type { OpenOutputPublicationAuthority } from "./outputPublication.js";

type Arm = "baseline" | "candidate";

export type BlindEvaluationPublishedOutputProvider = {
  outputs: readonly StudioOutput[];
  openPublishedOutput: (outputName: string, expectedJobId: string) => OpenOutputPublicationAuthority | null;
};
const MAX_SESSION_RECORD_BYTES = 2 * 1_024 * 1_024;
const MAX_SUBMISSION_RECORD_BYTES = 64 * 1_024;
const MAX_EVIDENCE_SIDECAR_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_MEDIA_BYTES = 8 * 1_024 ** 3;
const MAX_SESSION_FILES = 10_000;
const COPY_BUFFER_BYTES = 1_024 * 1_024;
const MAX_FFMPEG_STDERR_BYTES = 128 * 1_024;
const FFMPEG_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_RESERVATION_RECORD_BYTES = 64 * 1_024;
const MAX_GLOBAL_LOCK_BYTES = 32 * 1_024;
const MEDIA_CACHE_LIFETIME_MS = 5 * 60 * 1_000;
const MEDIA_RESPONSE_LIFETIME_MS = 30_000;
const MEDIA_CACHE_MAX_REQUESTS = 128;
const MEDIA_CACHE_MAX_CONCURRENT_RESPONSES = 4;
const MEDIA_CACHE_BYTE_MULTIPLIER = 8;
const MEDIA_SESSION_MAX_REQUESTS = 256;
const MAX_MEDIA_BUDGET_RECORD_BYTES = 16 * 1_024;
const RETENTION_SWEEP_INTERVAL_MS = 15 * 60 * 1_000;
export const BLIND_EVALUATION_STORAGE_MAX_BYTES = 64 * 1_024 ** 3;
export const BLIND_EVALUATION_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const BLIND_EVALUATION_TOMBSTONE_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
export const BLIND_EVALUATION_QUARANTINE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PROCESS_INSTANCE_ID = randomBytes(32).toString("hex");

function processStartTicks(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const fields = close >= 0 ? raw.slice(close + 2).split(" ") : [];
    const value = fields[19];
    return value && /^\d+$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

const CURRENT_PROCESS_START_TICKS = processStartTicks(process.pid)
  ?? (() => { throw new Error("Blind Evidence v5 requires Linux /proc process identity"); })();

const reservationOwnerSchema = z.object({
  pid: z.number().int().positive(),
  processStartTicks: z.string().regex(/^\d+$/),
  instanceId: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const blindEvaluationReservationSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-reservation.v5"),
  id: z.string().uuid(),
  experimentId: z.string().uuid(),
  protocolSha256: z.string().regex(/^[0-9a-f]{64}$/),
  creationRequestId: z.string().regex(/^[0-9a-f]{64}$/),
  evaluatorScopeCredential: z.string().regex(/^[0-9a-f]{64}$/),
  evaluatorScopeCredentialSha256: z.string().regex(/^[0-9a-f]{64}$/),
  creationTokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  lockNonce: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime({ offset: true }),
  owner: reservationOwnerSchema,
}).strict();

type BlindEvaluationReservation = z.infer<typeof blindEvaluationReservationSchema>;

const blindEvaluationClaimRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-claim.v5"),
  id: z.string().uuid(),
  creationTokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  claimedAt: z.string().datetime({ offset: true }),
  owner: reservationOwnerSchema,
}).strict();

type BlindEvaluationClaimRecord = z.infer<typeof blindEvaluationClaimRecordSchema>;

const blindEvaluationCreationOutcomeSchema = z.discriminatedUnion("outcome", [z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-creation-outcome.v5"),
  id: z.string().uuid(),
  outcome: z.literal("cancel"),
  cancelledAt: z.string().datetime({ offset: true }),
  reason: z.literal("evaluator-abort"),
}).strict(), z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-creation-outcome.v5"),
  id: z.string().uuid(),
  outcome: z.literal("publish"),
  recordSha256: z.string().regex(/^[0-9a-f]{64}$/),
  decidedAt: z.string().datetime({ offset: true }),
}).strict()]);

const blindEvaluationCreationIndexSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-creation-index.v5"),
  creationRequestId: z.string().regex(/^[0-9a-f]{64}$/),
  reservationId: z.string().uuid(),
  experimentId: z.string().uuid(),
  protocolSha256: z.string().regex(/^[0-9a-f]{64}$/),
  evaluatorScopeCredentialSha256: z.string().regex(/^[0-9a-f]{64}$/),
  creationTokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
  indexedAt: z.string().datetime({ offset: true }),
}).strict();

const blindEvaluationGlobalLockSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-global-lock.v5"),
  sessionId: z.string().uuid(),
  evaluatorScopeCredentialSha256: z.string().regex(/^[0-9a-f]{64}$/),
  lockNonce: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().datetime({ offset: true }),
}).strict();

type BlindEvaluationGlobalLock = z.infer<typeof blindEvaluationGlobalLockSchema>;

const blindEvaluationLockReleaseGuardSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-lock-release-guard.v5"),
  sessionId: z.string().uuid(),
  lockNonce: z.string().regex(/^[0-9a-f]{64}$/),
  owner: reservationOwnerSchema,
}).strict();

const reservationRevocationSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-reservation-revocation.v5"),
  id: z.string().uuid(),
  revokedAt: z.string().datetime({ offset: true }),
  reason: z.enum(["unclaimed-restart", "creation-interrupted", "creation-failed", "evaluator-abort"]),
}).strict();

type ReservationRevocationReason = z.infer<typeof reservationRevocationSchema>["reason"];

const blindEvaluationQuarantineRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-quarantine.v5"),
  quarantineName: z.string().min(1).max(255).regex(/^[A-Za-z0-9._-]+$/),
  sessionId: z.string().uuid().nullable(),
  stagingName: z.string().regex(/^\.staging-[0-9a-f-]{36}-[0-9a-f-]{36}$/i).nullable(),
  quarantinedAt: z.string().datetime({ offset: true }),
  reason: z.enum([
    "missing-publish-intent",
    "ambiguous-staging",
    "invalid-publish-intent",
    "invalid-published-bytes",
    "final-directory-conflict",
    "unmarked-quarantine",
  ]),
  publishRecordSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
}).strict().superRefine((value, context) => {
  if ((value.sessionId === null) !== (value.stagingName === null)) {
    context.addIssue({
      code: "custom",
      path: ["sessionId"],
      message: "Session-ID und Staging-Name müssen gemeinsam vorhanden oder null sein.",
    });
  }
  if (value.stagingName !== null && value.sessionId !== null
    && !value.stagingName.toLowerCase().startsWith(`.staging-${value.sessionId.toLowerCase()}-`)) {
    context.addIssue({
      code: "custom",
      path: ["stagingName"],
      message: "Der Staging-Name ist nicht an die Session-ID gebunden.",
    });
  }
  if (value.stagingName !== null) {
    const expectedPrefix = `${value.stagingName.slice(1)}-`;
    const suffix = value.quarantineName.slice(expectedPrefix.length);
    if (!value.quarantineName.startsWith(expectedPrefix)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suffix)) {
      context.addIssue({
        code: "custom",
        path: ["quarantineName"],
        message: "Das Quarantäneziel ist nicht eindeutig an den Staging-Namen gebunden.",
      });
    }
  }
  if (value.reason === "unmarked-quarantine"
    && (value.sessionId !== null || value.stagingName !== null || value.publishRecordSha256 !== null)) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "Eine rekonstruierte markerlose Quarantäne darf keine erfundene Session-Autorität tragen.",
    });
  }
  if (value.reason !== "unmarked-quarantine"
    && (value.sessionId === null || value.stagingName === null)) {
    context.addIssue({
      code: "custom",
      path: ["reason"],
      message: "Nur eine explizit rekonstruierte markerlose Quarantäne darf ohne Session-Bindung bleiben.",
    });
  }
});

const blindEvaluationMediaBudgetRecordSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-media-budget.v5"),
  sessionId: z.string().uuid(),
  commitment: z.string().regex(/^[0-9a-f]{64}$/),
  sequence: z.number().int().nonnegative().max(MEDIA_SESSION_MAX_REQUESTS - 1),
  channel: z.enum(["x", "y"]),
  reservedBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  reservedAt: z.string().datetime({ offset: true }),
}).strict();

export const blindEvaluationRetentionTombstoneSchema = z.object({
  schemaVersion: z.literal("ltx-studio-blind-evaluation-retention-tombstone.v5"),
  sessionId: z.string().uuid(),
  commitment: z.string().regex(/^[0-9a-f]{64}$/),
  outcome: z.enum(["submitted", "revoked"]),
  commitmentPreimageSha256: z.string().regex(/^[0-9a-f]{64}$/),
  terminalRecordSha256: z.string().regex(/^[0-9a-f]{64}$/),
  submissionSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  createdAt: z.string().datetime({ offset: true }),
  terminalAt: z.string().datetime({ offset: true }),
  minimizedAt: z.string().datetime({ offset: true }),
  purgeAfter: z.string().datetime({ offset: true }),
  removedPrivateMedia: z.literal(true),
  removedEvaluatorCredential: z.literal(true),
  removedSubmissionContent: z.literal(true),
}).strict();

function currentReservationOwner() {
  return {
    pid: process.pid,
    processStartTicks: CURRENT_PROCESS_START_TICKS,
    instanceId: PROCESS_INSTANCE_ID,
  } as const;
}

function reservationOwnerAlive(owner: z.infer<typeof reservationOwnerSchema>): boolean {
  return processStartTicks(owner.pid) === owner.processStartTicks;
}

type BlindEvaluationRandom = {
  id: () => string;
  nonce: () => string;
  credential: () => string;
  baselineFirst: () => boolean;
};

const defaultRandom: BlindEvaluationRandom = {
  id: randomUUID,
  nonce: () => randomBytes(32).toString("hex"),
  credential: () => randomBytes(32).toString("hex"),
  baselineFirst: () => randomInt(2) === 0,
};

export type BlindEvaluationMediaLease = {
  fd: number;
  sizeBytes: number;
  mimeType: "video/mp4";
  expectedRevision: BlindEvaluationPrivateFileRevision;
  responseDeadlineAtMs: number;
  reserveResponseBytes: (bytes: number) => void;
  releaseResponse: () => void;
};

type BlindEvaluationMediaCacheEntry = {
  cacheKey: string;
  commitment: string;
  fd: number;
  sizeBytes: number;
  expectedRevision: BlindEvaluationPrivateFileRevision;
  sourceRevision: BlindEvaluationPrivateFileRevision;
  createdAtMs: number;
  expiresAtMs: number;
  maximumResponseBytes: number;
  reservedResponseBytes: number;
  responseCount: number;
  activeResponses: number;
  retired: boolean;
};

function copyCommittedSnapshotToAnonymousCache(
  sourceFd: number,
  committedRevision: BlindEvaluationPrivateFileRevision,
  directory: string,
): Pick<BlindEvaluationMediaCacheEntry, "fd" | "sizeBytes" | "expectedRevision"> {
  const temporaryPath = safeChildPath(directory, `.media-lease-${randomUUID()}.v5.tmp`);
  let leaseFd: number | null = null;
  let temporaryLinked = false;
  try {
    assertBlindEvaluationMediaLeaseIntegrity({
      fd: sourceFd,
      sizeBytes: committedRevision.sizeBytes,
      mimeType: "video/mp4",
      expectedRevision: committedRevision,
    });
    const linuxOTmpfile = 0o20000000 | (constants.O_DIRECTORY ?? 0);
    try {
      leaseFd = openSync(directory, constants.O_RDWR | linuxOTmpfile, 0o600);
    } catch {
      leaseFd = openSync(
        temporaryPath,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      temporaryLinked = true;
      unlinkDurably(temporaryPath);
      temporaryLinked = false;
    }
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, committedRevision.sizeBytes));
    let position = 0;
    while (position < committedRevision.sizeBytes) {
      const requested = Math.min(buffer.length, committedRevision.sizeBytes - position);
      const read = readSync(sourceFd, buffer, 0, requested, position);
      if (read !== requested) {
        throw new BlindEvaluationConflictError("Der committed v5-Snapshot endete während der anonymen Volllese-Kopie.");
      }
      let written = 0;
      while (written < read) {
        const count = writeSync(leaseFd, buffer, written, read - written, position + written);
        if (count <= 0) throw new BlindEvaluationConflictError("Die anonyme v5-Media-Kopie ist unvollständig.");
        written += count;
      }
      position += read;
    }
    fchmodSync(leaseFd, 0o400);
    fsyncSync(leaseFd);
    assertBlindEvaluationMediaLeaseIntegrity({
      fd: sourceFd,
      sizeBytes: committedRevision.sizeBytes,
      mimeType: "video/mp4",
      expectedRevision: committedRevision,
    });
    const readOnlyFd = openSync(`/proc/self/fd/${leaseFd}`, constants.O_RDONLY);
    closeSync(leaseFd);
    leaseFd = readOnlyFd;
    const anonymousStats = fstatSync(readOnlyFd);
    const anonymousRevision = revision(anonymousStats, committedRevision.sha256);
    const cache = {
      fd: readOnlyFd,
      sizeBytes: committedRevision.sizeBytes,
      expectedRevision: anonymousRevision,
    };
    assertBlindEvaluationMediaLeaseIntegrity({
      ...cache,
      mimeType: "video/mp4",
    });
    leaseFd = null;
    return cache;
  } catch (error) {
    if (temporaryLinked && existsSync(temporaryPath)) {
      try { unlinkDurably(temporaryPath); } catch { /* Preserve the primary fail-closed error. */ }
    }
    if (error instanceof BlindEvaluationConflictError) throw error;
    throw new BlindEvaluationConflictError("Ein v5-Medium konnte nicht in einen anonymen verifizierten Lease kopiert werden.");
  } finally {
    if (leaseFd !== null) closeSync(leaseFd);
  }
}

export function assertBlindEvaluationMediaLeaseIntegrity(
  lease: Pick<BlindEvaluationMediaLease, "fd" | "expectedRevision">
    & Partial<Pick<BlindEvaluationMediaLease, "sizeBytes" | "mimeType">>,
  rehash = true,
): void {
  const before = fstatSync(lease.fd);
  if (!statsMatchBinding(before, lease.expectedRevision)
    || (rehash && hashOpenFileDescriptor(lease.fd, before.size) !== lease.expectedRevision.sha256)) {
    throw new BlindEvaluationConflictError("Der gehaltene v5-Media-FD stimmt nicht mehr mit seinem Commitment überein.");
  }
  const after = fstatSync(lease.fd);
  if (!sameStats(before, after) || !statsMatchBinding(after, lease.expectedRevision)) {
    throw new BlindEvaluationConflictError("Der gehaltene v5-Media-FD änderte sich während der Vollhash-Prüfung.");
  }
}

export class BlindEvaluationConflictError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409 | 412 | 429 = 409,
  ) {
    super(message);
    this.name = "BlindEvaluationConflictError";
  }
}

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalBlindEvaluationJson(value)).digest("hex");
}

function digestCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function reservationLockNonce(id: string, credential: string, creationRequestId: string): string {
  return digestCanonical({ kind: "blind-v5-global-lock", id, credential, creationRequestId });
}

function reservationCreationToken(id: string, credential: string, creationRequestId: string): string {
  return digestCanonical({ kind: "blind-v5-creation-authority", id, credential, creationRequestId });
}

function readHeldRegularFileDescriptor(
  fd: number,
  maximumBytes: number,
  immutableControlRecord = false,
  allowedLinkCounts: readonly number[] = [1],
): { raw: Buffer; stats: Stats } {
  const before = fstatSync(fd);
  if (!before.isFile() || before.size <= 0 || before.size > maximumBytes
    || (immutableControlRecord
      && ((before.mode & 0o7777) !== 0o400 || !allowedLinkCounts.includes(before.nlink)))) {
    throw new BlindEvaluationConflictError(
      immutableControlRecord
        ? "Ein v5-Steuerdatensatz ist nicht unveränderlich, einfach verlinkt und regulär."
        : "Eine gebundene Datei ist nicht regulär oder unzulässig groß.",
    );
  }
  const raw = Buffer.alloc(before.size);
  let offset = 0;
  while (offset < raw.length) {
    const count = readSync(fd, raw, offset, raw.length - offset, offset);
    if (count <= 0) throw new BlindEvaluationConflictError("Eine gebundene Datei endete während der Volllesung.");
    offset += count;
  }
  const after = fstatSync(fd);
  if (!sameStats(before, after)
    || (immutableControlRecord
      && ((after.mode & 0o7777) !== 0o400 || !allowedLinkCounts.includes(after.nlink)))) {
    throw new BlindEvaluationConflictError("Eine gebundene Datei änderte sich während der FD-gebundenen Volllesung.");
  }
  return { raw, stats: after };
}

function readHeldRegularFile(
  path: string,
  maximumBytes: number,
  immutableControlRecord = false,
): { raw: Buffer; stats: Stats } {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return readHeldRegularFileDescriptor(fd, maximumBytes, immutableControlRecord);
  } catch (error) {
    if (error instanceof BlindEvaluationConflictError) throw error;
    throw new BlindEvaluationConflictError(
      `Eine gebundene Datei ist nicht O_NOFOLLOW/FD-gebunden lesbar: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export function blindEvaluationCommitment(
  value: BlindEvaluationRecord | BlindEvaluationCommitmentPreimage,
): string {
  const preimage = "commitmentPreimage" in value ? value.commitmentPreimage : value;
  return digestCanonical(blindEvaluationCommitmentPreimageSchema.parse(preimage));
}

function hashAndParseUnchangedJson(path: string): { sha256: string; value: unknown } {
  try {
    const { raw } = readHeldRegularFile(path, MAX_EVIDENCE_SIDECAR_BYTES);
    return {
      sha256: createHash("sha256").update(raw).digest("hex"),
      value: JSON.parse(raw.toString("utf8")) as unknown,
    };
  } catch (error) {
    if (error instanceof BlindEvaluationConflictError) throw error;
    throw new BlindEvaluationConflictError("Ein gebundener Evidenz-Sidecar ist nicht unverändert lesbar.");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hashOpenFileDescriptor(fd: number, sizeBytes: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (position < sizeBytes) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, sizeBytes - position), position);
    if (count <= 0) throw new BlindEvaluationConflictError("Eine gebundene Datei endete unerwartet früh.");
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

function throwIfBlindOperationAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new BlindEvaluationConflictError("Die laufende v5-Materialisierung wurde dauerhaft abgebrochen.");
  }
}

function primaryBlindSettledFailure(
  results: readonly PromiseSettledResult<unknown>[],
): PromiseRejectedResult | undefined {
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  return rejected.find((result) => {
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return !/abgebrochen|AbortController/u.test(message);
  }) ?? rejected[0];
}

async function yieldBlindOperation(signal: AbortSignal): Promise<void> {
  throwIfBlindOperationAborted(signal);
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  throwIfBlindOperationAborted(signal);
}

async function hashOpenFileDescriptorAsync(
  fd: number,
  sizeBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  while (position < sizeBytes) {
    throwIfBlindOperationAborted(signal);
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, sizeBytes - position), position);
    if (count <= 0) throw new BlindEvaluationConflictError("Eine gebundene Datei endete unerwartet früh.");
    digest.update(buffer.subarray(0, count));
    position += count;
    await yieldBlindOperation(signal);
  }
  return digest.digest("hex");
}

export type BoundBlindExecutable = {
  fd: number;
  binding: BlindEvaluationToolBinding;
};

function toolStatsMatchBinding(stats: Stats, binding: BlindEvaluationToolBinding): boolean {
  const expected = binding.revision;
  return stats.isFile() && !stats.isSymbolicLink()
    && String(stats.dev) === expected.deviceId
    && String(stats.ino) === expected.fileId
    && stats.size === expected.sizeBytes
    && stats.mtimeMs === expected.modifiedAtMs
    && stats.ctimeMs === expected.changedAtMs
    && stats.mode === expected.mode
    && stats.uid === expected.uid
    && stats.gid === expected.gid
    && stats.nlink === expected.linkCount;
}

function toolPathStillBinds(path: string, expected: Stats | BlindEvaluationToolBinding): boolean {
  let pathFd: number | null = null;
  try {
    pathFd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const pathStats = fstatSync(pathFd);
    return "revision" in expected
      ? toolStatsMatchBinding(pathStats, expected)
      : sameStats(pathStats, expected);
  } catch {
    return false;
  } finally {
    if (pathFd !== null) closeSync(pathFd);
  }
}

/**
 * Opens and keeps the executable that every v5 child command will execute.
 * O_NOFOLLOW rejects a final-component symlink; the resulting FD, not the path,
 * is the authority used for version, encode and probe child processes.
 */
async function readBoundExecutableVersion(
  fd: number,
  signal: AbortSignal,
): Promise<string> {
  throwIfBlindOperationAborted(signal);
  return new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn("/proc/self/fd/3", ["-version"], {
      stdio: ["ignore", "pipe", "pipe", fd],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forcedError: Error | null = null;
    const kill = (error: Error) => {
      forcedError ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => kill(new BlindEvaluationConflictError(
      "Die initiale FD-gebundene v5-Toolprobe wurde durch ihren AbortController abgebrochen.",
    ));
    const timer = setTimeout(() => kill(new BlindEvaluationConflictError(
      "Die initiale FD-gebundene v5-Toolprobe überschritt ihr Zeitlimit.",
    )), 10_000);
    timer.unref();
    const finish = (code: number | null, childSignal: NodeJS.Signals | null, failure?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) {
        rejectPromise(failure);
        return;
      }
      if (forcedError) {
        rejectPromise(forcedError);
        return;
      }
      const version = Buffer.concat(stdout).toString("utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
      if (code !== 0 || childSignal !== null || !version) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        rejectPromise(new BlindEvaluationConflictError(
          detail || "Die initiale FD-gebundene v5-Toolprobe lieferte keine gültige Version.",
        ));
        return;
      }
      resolvePromise(version);
    };
    const collect = (target: Buffer[], chunkValue: Buffer | string, stdoutStream: boolean) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      if (stdoutStream) stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > 128 * 1_024 || stderrBytes > 128 * 1_024) {
        kill(new BlindEvaluationConflictError(
          "Die initiale FD-gebundene v5-Toolprobe überschritt ihr Ausgabelimit.",
        ));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk, false));
    child.once("error", (error) => finish(null, null, error));
    child.once("close", (code, childSignal) => finish(code, childSignal));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function openBoundBlindExecutable(
  path: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<BoundBlindExecutable> {
  if (!isAbsolute(path)) {
    throw new BlindEvaluationConflictError("Blind Evidence v5 benötigt einen absoluten Toolpfad.");
  }
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0
      || (before.mode & 0o111) === 0 || before.nlink < 1) {
      throw new BlindEvaluationConflictError("Ein v5-Medientool ist keine reguläre ausführbare Datei.");
    }
    const sha256 = await hashOpenFileDescriptorAsync(fd, before.size, signal);
    const afterHash = fstatSync(fd);
    if (!sameStats(before, afterHash) || !toolPathStillBinds(path, afterHash)) {
      throw new BlindEvaluationConflictError("Ein v5-Medientool änderte sich während seiner inkrementellen FD-Hashprüfung.");
    }
    const version = await readBoundExecutableVersion(fd, signal);
    const afterProbe = fstatSync(fd);
    if (!sameStats(afterHash, afterProbe) || !toolPathStillBinds(path, afterProbe)) {
      throw new BlindEvaluationConflictError("Ein v5-Medientool änderte sich während seiner abbrechbaren Versionsprüfung.");
    }
    const finalSha256 = await hashOpenFileDescriptorAsync(fd, afterProbe.size, signal);
    const after = fstatSync(fd);
    if (!sameStats(afterProbe, after)
      || !toolPathStillBinds(path, after)
      || finalSha256 !== sha256) {
      throw new BlindEvaluationConflictError("Ein v5-Medientool änderte sich während seiner FD-gebundenen Versionsprüfung.");
    }
    const binding: BlindEvaluationToolBinding = {
      path,
      sha256,
      version,
      revision: {
        deviceId: String(after.dev),
        fileId: String(after.ino),
        sizeBytes: after.size,
        modifiedAtMs: after.mtimeMs,
        changedAtMs: after.ctimeMs,
        mode: after.mode,
        uid: after.uid,
        gid: after.gid,
        linkCount: after.nlink,
      },
    };
    const result = { fd, binding };
    fd = null;
    return result;
  } catch (error) {
    if (error instanceof BlindEvaluationConflictError) throw error;
    throw new BlindEvaluationConflictError(
      `Ein v5-Medientool kann nicht O_NOFOLLOW-gebunden werden: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export async function assertBoundBlindExecutableUnchanged(
  tool: BoundBlindExecutable,
  signal: AbortSignal,
): Promise<void> {
  const before = fstatSync(tool.fd);
  if (!toolStatsMatchBinding(before, tool.binding)
    || !toolPathStillBinds(tool.binding.path, tool.binding)) {
    throw new BlindEvaluationConflictError("Ein FD-gebundenes v5-Medientool wurde ersetzt oder in-place verändert.");
  }
  const sha256 = await hashOpenFileDescriptorAsync(tool.fd, before.size, signal);
  const after = fstatSync(tool.fd);
  if (!sameStats(before, after) || !toolStatsMatchBinding(after, tool.binding)
    || !toolPathStillBinds(tool.binding.path, tool.binding)
    || sha256 !== tool.binding.sha256) {
    throw new BlindEvaluationConflictError("Ein FD-gebundenes v5-Medientool änderte sich während der Revalidierung.");
  }
}

type AsyncBoundToolResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

type BoundToolCloseTestHooks = {
  postCloseRevalidate?: (tool: BoundBlindExecutable, signal: AbortSignal) => Promise<void>;
  beforeFinalResolution?: (signal: AbortSignal) => Promise<void>;
};

async function runBoundToolAsync(
  tool: BoundBlindExecutable,
  args: readonly string[],
  signal: AbortSignal,
  mediaFd?: number,
  timeout = 30_000,
  maxBuffer = 512 * 1_024,
  testHooks?: BoundToolCloseTestHooks,
): Promise<AsyncBoundToolResult> {
  throwIfBlindOperationAborted(signal);
  await assertBoundBlindExecutableUnchanged(tool, signal);
  return new Promise<AsyncBoundToolResult>((resolvePromise, rejectPromise) => {
    const child = spawn("/proc/self/fd/3", [...args], {
      stdio: mediaFd === undefined
        ? ["ignore", "pipe", "pipe", tool.fd]
        : ["ignore", "pipe", "pipe", tool.fd, mediaFd],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let forcedError: Error | undefined;
    const kill = (error: Error) => {
      forcedError ??= error;
      child.kill("SIGKILL");
    };
    const abort = () => kill(new BlindEvaluationConflictError(
      "Ein laufender FD-gebundener v5-Probeprozess wurde abgebrochen.",
    ));
    const timer = setTimeout(() => kill(new BlindEvaluationConflictError(
      "Ein FD-gebundener v5-Probeprozess überschritt sein Zeitlimit.",
    )), timeout);
    timer.unref();
    const finish = async (result?: AsyncBoundToolResult, failure?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await (testHooks?.postCloseRevalidate ?? assertBoundBlindExecutableUnchanged)(tool, signal);
        await testHooks?.beforeFinalResolution?.(signal);
        throwIfBlindOperationAborted(signal);
      } catch (error) {
        rejectPromise(error);
        return;
      } finally {
        signal.removeEventListener("abort", abort);
      }
      if (failure) rejectPromise(failure);
      else resolvePromise(result!);
    };
    const collect = (target: Buffer[], chunkValue: Buffer | string, stdoutStream: boolean) => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      if (stdoutStream) stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) {
        kill(new BlindEvaluationConflictError("Ein FD-gebundener v5-Probeprozess überschritt sein Ausgabelimit."));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => collect(stdout, chunk, true));
    child.stderr?.on("data", (chunk: Buffer) => collect(stderr, chunk, false));
    child.once("error", (error) => { void finish(undefined, error); });
    child.once("close", (status, childSignal) => { void finish({
      status,
      signal: childSignal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
      ...(forcedError ? { error: forcedError } : {}),
    }); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

/** @internal Deterministic race seam for the Blind-v5 post-child-close abort contract. */
export async function runBoundBlindToolForTest(
  tool: BoundBlindExecutable,
  args: readonly string[],
  signal: AbortSignal,
  hooks: BoundToolCloseTestHooks = {},
): Promise<AsyncBoundToolResult> {
  if (process.env.NODE_ENV !== "test") {
    throw new BlindEvaluationConflictError("Der Blind-v5-Testpfad ist außerhalb der Tests gesperrt.");
  }
  return runBoundToolAsync(tool, args, signal, undefined, 30_000, 512 * 1_024, hooks);
}

function revision(stats: Stats, sha256: string): BlindEvaluationPrivateFileRevision {
  return {
    sha256,
    sizeBytes: stats.size,
    deviceId: String(stats.dev),
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
    fileId: String(stats.ino),
    mode: stats.mode,
  };
}

function publicRevision(value: BlindEvaluationPrivateFileRevision): BlindEvaluationFileRevision {
  return {
    sha256: value.sha256,
    deviceId: value.deviceId,
    modifiedAtMs: value.modifiedAtMs,
    changedAtMs: value.changedAtMs,
    fileId: value.fileId,
    mode: value.mode,
  };
}

function sameStats(left: Stats, right: Stats): boolean {
  return left.isFile() && !left.isSymbolicLink() && right.isFile() && !right.isSymbolicLink()
    && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
    && left.nlink === right.nlink;
}

async function hashUnchangedRegularFile(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<BlindEvaluationPrivateFileRevision> {
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > maxBytes) {
      throw new BlindEvaluationConflictError("Ein gebundenes Medium ist keine reguläre, zulässig große Datei.");
    }
    const sha256 = await hashOpenFileDescriptorAsync(fd, before.size, signal);
    const after = fstatSync(fd);
    if (!sameStats(before, after)) {
      throw new BlindEvaluationConflictError("Ein gebundenes Medium änderte sich während der Prüfung.");
    }
    return revision(after, sha256);
  } catch (error) {
    if (error instanceof BlindEvaluationConflictError) throw error;
    throw new BlindEvaluationConflictError("Ein gebundenes Medium ist nicht unverändert lesbar.");
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function exactOutputForArm(
  experiment: ControlledExperiment,
  outputs: readonly StudioOutput[],
  arm: Arm,
): StudioOutput {
  const matches = outputs.filter((output) => outputVerifiesExperimentArmRun(output, experiment, arm));
  if (matches.length !== 1) {
    throw new BlindEvaluationConflictError(
      `Der ${arm === "baseline" ? "Baseline" : "Kandidaten"}arm ist nicht eindeutig und unverändert gebunden.`,
    );
  }
  return matches[0];
}

function analysisVerifiesOutput(output: StudioOutput): boolean {
  const analysis = output.analysis;
  const technical = asRecord(analysis?.result?.technical);
  return Boolean(
    output.jobId
    && analysis?.schemaVersion === "ltx-studio-output-analysis.v7"
    && analysis.status === "completed"
    && analysis.result?.schemaVersion === "ltx-studio-objective-quality.v7"
    && analysis.outputName === output.name
    && analysis.jobId === output.jobId
    && analysis.sizeBytes === output.sizeBytes
    && analysis.fileId === output.fileId
    && Math.abs(analysis.modifiedAtMs - Date.parse(output.modifiedAt)) < 1
    && Math.abs(analysis.changedAtMs - Date.parse(output.changedAt)) < 1
    && technical?.hasAudio === true
    && typeof technical.durationSeconds === "number"
    && Number.isFinite(technical.durationSeconds)
    && technical.durationSeconds > 0,
  );
}

function safeChildPath(rootValue: string, child: string): string {
  const root = resolve(rootValue);
  const path = resolve(root, child);
  if (!path.startsWith(`${root}${sep}`)) {
    throw new BlindEvaluationConflictError("Ein Blind-Evidenzpfad liegt außerhalb seines geschützten Ordners.");
  }
  return path;
}

async function captureBinding<A extends Arm>(
  outputRoot: string,
  experiment: ControlledExperiment,
  output: StudioOutput,
  lease: OpenOutputPublicationAuthority,
  arm: A,
  maxMediaBytes: number,
  signal: AbortSignal,
): Promise<{
  binding: BlindEvaluationMediaBinding & { arm: A };
  privateRevision: BlindEvaluationPrivateFileRevision;
  sourceFd: number;
}> {
  let returned = false;
  try {
    const selected = experiment.arms[arm === "baseline" ? 0 : 1];
    const technical = asRecord(output.analysis?.result?.technical);
    const outputPath = safeChildPath(outputRoot, output.name);
    const authority = lease.authority;
    const publishedRevision = authority.output.revision;
    if (extname(output.name).toLowerCase() !== ".mp4") {
      throw new BlindEvaluationConflictError("Blind Evidence v5 akzeptiert ausschließlich MP4-Quellen.");
    }
    if (!output.jobId || output.jobId !== selected.jobId
      || output.provenance?.schemaVersion !== "ltx-studio-run-provenance.v2"
      || !output.provenance.verifiedAt
      || !/^[0-9a-f]{64}$/.test(output.provenance.fingerprint)
      || !analysisVerifiesOutput(output)
      || technical?.hasAudio !== true
      || typeof technical.durationSeconds !== "number") {
      throw new BlindEvaluationConflictError(
        `Der ${arm === "baseline" ? "Baseline" : "Kandidaten"}arm benötigt v2-Laufprovenienz, eine aktuelle v7-Analyse und eine bestätigte Audiospur.`,
      );
    }
    if (authority.schemaVersion !== "ltx-studio-output-publication.v2"
      || authority.state !== "published"
      || authority.outputName !== output.name
      || authority.jobId !== output.jobId
      || authority.output.path !== outputPath
      || authority.output.sha256.length !== 64
      || publishedRevision.sizeBytes !== output.sizeBytes
      || publishedRevision.fileId !== output.fileId
      || Math.abs(publishedRevision.modifiedAtMs - Date.parse(output.modifiedAt)) >= 1
      || Math.abs(publishedRevision.changedAtMs - Date.parse(output.changedAt)) >= 1
      || lease.snapshotBackend === "source") {
      throw new BlindEvaluationConflictError("Der Blind-v5-Arm besitzt keine exakt jobgebundene Publication-v2-Snapshotautorität.");
    }
    const before = fstatSync(lease.fd);
    if (!before.isFile() || before.nlink !== 0 || (before.mode & 0o777) !== 0o400
      || before.size <= 0 || before.size > maxMediaBytes
      || before.size !== publishedRevision.sizeBytes) {
      throw new BlindEvaluationConflictError("Der Publication-v2-Consumer lieferte keinen versiegelten anonymen Snapshot-FD.");
    }
    const snapshotSha256 = await hashOpenFileDescriptorAsync(lease.fd, before.size, signal);
    const after = fstatSync(lease.fd);
    if (!sameStats(before, after) || snapshotSha256 !== authority.output.sha256) {
      throw new BlindEvaluationConflictError("Der anonyme Publication-v2-Snapshot widerspricht seiner dauerhaften Autorität.");
    }
    const sourceRevision = revision(after, snapshotSha256);
    const settingsSidecar = hashAndParseUnchangedJson(safeChildPath(outputRoot, `${output.name}.ltx-settings.json`));
    const analysisSidecar = hashAndParseUnchangedJson(safeChildPath(outputRoot, `${output.name}.ltx-analysis.json`));
    const settings = asRecord(settingsSidecar.value);
    const sidecarRequest = asRecord(settings?.request);
    const sidecarProvenance = asRecord(settings?.runProvenance);
    if (settings?.schemaVersion !== "ltx-studio-output.v7" || settings.outputName !== output.name
      || settings.jobId !== output.jobId || settings.sizeBytes !== output.sizeBytes
      || settings.fileId !== output.fileId || typeof settings.modifiedAtMs !== "number"
      || typeof settings.changedAtMs !== "number" || sidecarRequest === null
      || Math.abs(settings.modifiedAtMs - publishedRevision.modifiedAtMs) >= 1
      || Math.abs(settings.changedAtMs - publishedRevision.changedAtMs) >= 1
      || sha256Json(sidecarRequest) !== selected.requestSha256
      || sha256Json(settings.experiment ?? null) !== sha256Json(output.experiment ?? null)
      || sidecarProvenance?.schemaVersion !== "ltx-studio-run-provenance.v2"
      || sidecarProvenance.verifiedAt !== output.provenance.verifiedAt
      || sidecarProvenance.fingerprint !== output.provenance.fingerprint
      || sha256Json(analysisSidecar.value) !== sha256Json(output.analysis)) {
      throw new BlindEvaluationConflictError(
        `Der ${arm === "baseline" ? "Baseline" : "Kandidaten"}arm stimmt nicht mit seinen Evidenz-Sidecars überein.`,
      );
    }
    returned = true;
    return {
      privateRevision: sourceRevision,
      sourceFd: lease.fd,
      binding: {
        arm,
        outputName: output.name,
        jobId: output.jobId,
        requestSha256: selected.requestSha256,
        settingsSha256: selected.settingsSha256,
        provenanceFingerprint: output.provenance.fingerprint,
        sourceSha256: sourceRevision.sha256,
        analysisSha256: sha256Json(output.analysis),
        settingsSidecarSha256: settingsSidecar.sha256,
        analysisSidecarSha256: analysisSidecar.sha256,
        publication: {
          schemaVersion: authority.schemaVersion,
          authoritySha256: digestCanonical(authority),
          publishedAt: authority.publishedAt,
          executionDecisionSha256: authority.executionDecisionSha256,
          jobPersistenceRevision: authority.jobPersistenceRevision,
          jobAuthoritySha256: authority.jobAuthoritySha256,
          outputSha256: authority.output.sha256,
          outputRevision: authority.output.revision,
        },
        sourceRevision: publicRevision(sourceRevision),
        durationSeconds: technical.durationSeconds,
        hasAudio: true,
      },
    };
  } finally {
    if (!returned) closeSync(lease.fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function immutableLinkFromTemporary(temporaryPath: string, finalPath: string): void {
  chmodSync(temporaryPath, 0o400);
  const durableFd = openSync(temporaryPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    fsyncSync(durableFd);
  } finally {
    closeSync(durableFd);
  }
  linkSync(temporaryPath, finalPath);
  unlinkSync(temporaryPath);
  fsyncDirectory(resolve(finalPath, ".."));
}

function currentNormalizationProfile(experiment: ControlledExperiment): BlindEvaluationNormalizationProfile {
  const baselineRequest = experiment.arms[0].request;
  const candidateRequest = experiment.arms[1].request;
  if (baselineRequest.numFrames !== candidateRequest.numFrames
    || baselineRequest.frameRate !== candidateRequest.frameRate) {
    throw new BlindEvaluationConflictError("Das eingefrorene Experiment verletzt den symmetrischen v5-Timeline-Vertrag.");
  }
  const protocolDurationSeconds = (baselineRequest.numFrames - 1) / baselineRequest.frameRate;
  const frameCount = Math.round(protocolDurationSeconds * 25);
  const durationSeconds = frameCount / 25;
  if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 2_500
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 100) {
    throw new BlindEvaluationConflictError("Die eingefrorene Protokoll-Timeline ist nicht in das feste v5-Zielprofil abbildbar.");
  }
  return blindEvaluationNormalizationProfileSchema.parse({
    schemaVersion: "ltx-studio-blind-evaluation-normalization-profile.v5",
    contractKind: "requested-encoder-settings",
    program: "ffmpeg",
    argsTemplate: [...BLIND_EVALUATION_NORMALIZATION_ARGS_TEMPLATE],
    containerProfile: "h264-high51-aac-lc-isom-cbr-measured.v5",
    fillerProfile: "iso-bmff-explicit-mdat-private-reconstruction.v2",
    target: {
      width: 1_280,
      height: 1_280,
      framesPerSecond: 25,
      frameCount,
      durationSeconds,
      videoCodec: "h264",
      videoProfile: "High",
      videoLevel: 51,
      pixelFormat: "yuv420p",
      sampleAspectRatio: "1:1",
      displayAspectRatio: "1:1",
      colorRange: "tv",
      colorSpace: "bt709",
      colorTransfer: "bt709",
      colorPrimaries: "bt709",
      rotation: "none",
      gopSize: 50,
      keyFrameMinimum: 50,
      sceneCutThreshold: 0,
      bFrames: 2,
      referenceFrames: 3,
      videoBitRate: 12_000_000,
      audioCodec: "aac",
      audioProfile: "LC",
      audioSampleFormat: "fltp",
      audioSampleRate: 48_000,
      audioChannels: 2,
      audioBitRate: 192_000,
      majorBrand: "isom",
      compatibleBrands: "isomiso2avc1mp41",
      streamLanguage: "und",
      defaultDisposition: true,
      startTimeSeconds: 0,
      videoTrackTimescale: 90_000,
      audioTrackTimescale: 48_000,
    },
  });
}

function normalizationArgs(profile: BlindEvaluationNormalizationProfile, targetPath: string): string[] {
  return BLIND_EVALUATION_NORMALIZATION_ARGS_TEMPLATE.map((value) => {
    if (value === "{source-fd}") return "/proc/self/fd/4";
    if (value === "{target}") return targetPath;
    return value
      .replaceAll("{frame-count}", String(profile.target.frameCount))
      .replaceAll("{duration}", profile.target.durationSeconds.toFixed(6));
  });
}

export async function runFfmpegNormalization(
  ffmpeg: BoundBlindExecutable,
  profile: BlindEvaluationNormalizationProfile,
  sourceFd: number,
  targetPath: string,
  signal: AbortSignal,
): Promise<void> {
  await assertBoundBlindExecutableUnchanged(ffmpeg, signal);
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("/proc/self/fd/3", normalizationArgs(profile, targetPath), {
      stdio: ["ignore", "ignore", "pipe", ffmpeg.fd, sourceFd],
    });
    let stderr = "";
    let settled = false;
    let forcedError: Error | null = null;
    const finish = async (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await assertBoundBlindExecutableUnchanged(ffmpeg, signal);
        throwIfBlindOperationAborted(signal);
        if (error) rejectPromise(error);
        else resolvePromise();
      } catch (verificationError) {
        rejectPromise(verificationError);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    };
    const abort = () => {
      forcedError ??= new Error("Laufende v5-Normalisierung wurde durch den gebundenen AbortController abgebrochen.");
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      forcedError = new Error("FFmpeg-Normalisierung überschritt das Zeitlimit.");
      child.kill("SIGKILL");
    }, FFMPEG_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_FFMPEG_STDERR_BYTES) stderr += chunk.toString("utf8");
      if (stderr.length >= MAX_FFMPEG_STDERR_BYTES) {
        forcedError = new Error("FFmpeg-Normalisierung erzeugte unzulässig viel Fehlerausgabe.");
        child.kill("SIGKILL");
      }
    });
    child.once("error", (error) => { void finish(error); });
    child.once("close", (code, childSignal) => {
      if (forcedError) void finish(forcedError);
      else if (code === 0 && !childSignal && stderr.length < MAX_FFMPEG_STDERR_BYTES) void finish();
      else void finish(new Error(
        stderr.trim() || `FFmpeg endete mit Code ${String(code)} / Signal ${String(childSignal)}.`,
      ));
    });
  });
}

type NormalizedSnapshot = {
  channel: BlindEvaluationChannel;
  sourceArm: Arm;
  temporaryPath: string;
  sourceBefore: BlindEvaluationFileRevision;
  sourceAfter: BlindEvaluationFileRevision;
  normalizedSha256: string;
  normalizedSizeBytes: number;
};

function statsMatchBinding(stats: Stats, expected: BlindEvaluationPrivateFileRevision): boolean {
  return stats.isFile() && !stats.isSymbolicLink() && stats.size === expected.sizeBytes
    && String(stats.dev) === expected.deviceId
    && String(stats.ino) === expected.fileId
    && Math.abs(stats.mtimeMs - expected.modifiedAtMs) < 1
    && Math.abs(stats.ctimeMs - expected.changedAtMs) < 1
    && stats.mode === expected.mode;
}

async function assertCanonicalSourceTimeline(
  ffprobe: BoundBlindExecutable,
  sourceFd: number,
  profile: BlindEvaluationNormalizationProfile,
  signal: AbortSignal,
): Promise<void> {
  const result = await runBoundToolAsync(ffprobe, [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,width,height,duration,sample_rate,channels",
    "-of", "json",
    "/proc/self/fd/4",
  ], signal, sourceFd, 30_000, 256 * 1_024);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new BlindEvaluationConflictError("Ein Quellmedium ist nicht als eindeutige Audio/Video-Timeline prüfbar.");
  }
  const probe = JSON.parse(result.stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string; sample_rate?: string; channels?: number }>;
  };
  const video = probe.streams?.filter((stream) => stream.codec_type === "video") ?? [];
  const audio = probe.streams?.filter((stream) => stream.codec_type === "audio") ?? [];
  const duration = Number(probe.format?.duration);
  if (video.length !== 1 || audio.length !== 1 || !video[0]?.width || !video[0]?.height
    || video[0].width > 8_192 || video[0].height > 8_192 || !Number.isFinite(duration)
    || duration + 0.04 < profile.target.durationSeconds) {
    throw new BlindEvaluationConflictError("Das Quellmedium verletzt den festen v5-Dimensions-/Timeline-Vertrag.");
  }
}

async function remuxVerifiedSnapshot(
  ffmpeg: BoundBlindExecutable,
  ffprobe: BoundBlindExecutable,
  sourceFd: number,
  sessionDirectory: string,
  channel: BlindEvaluationChannel,
  sourceArm: Arm,
  binding: BlindEvaluationMediaBinding,
  privateSourceRevision: BlindEvaluationPrivateFileRevision,
  profile: BlindEvaluationNormalizationProfile,
  signal: AbortSignal,
): Promise<NormalizedSnapshot> {
  const temporaryPath = safeChildPath(sessionDirectory, `${channel}.${randomUUID()}.normalized.v5.mp4`);
  try {
    const beforeStats = fstatSync(sourceFd);
    if (!statsMatchBinding(beforeStats, privateSourceRevision)) {
      throw new BlindEvaluationConflictError("Ein Quellmedium änderte sich vor der privaten v5-Normalisierung.");
    }
    const sourceBefore = revision(
      beforeStats,
      await hashOpenFileDescriptorAsync(sourceFd, beforeStats.size, signal),
    );
    if (canonicalBlindEvaluationJson(sourceBefore) !== canonicalBlindEvaluationJson(privateSourceRevision)) {
      throw new BlindEvaluationConflictError("Quellrevision und SHA stimmen vor der privaten v5-Normalisierung nicht mehr.");
    }
    await assertCanonicalSourceTimeline(ffprobe, sourceFd, profile, signal);
    await runFfmpegNormalization(ffmpeg, profile, sourceFd, temporaryPath, signal);
    sanitizeCanonicalUdtaToFree(temporaryPath);
    const afterStats = fstatSync(sourceFd);
    const sourceAfter = revision(
      afterStats,
      await hashOpenFileDescriptorAsync(sourceFd, afterStats.size, signal),
    );
    if (!statsMatchBinding(afterStats, privateSourceRevision)
      || canonicalBlindEvaluationJson(sourceAfter) !== canonicalBlindEvaluationJson(sourceBefore)) {
      throw new BlindEvaluationConflictError("Quellrevision oder SHA änderten sich während der privaten v5-Normalisierung.");
    }
    const normalized = await hashUnchangedRegularFile(
      temporaryPath,
      canonicalFinalSizeBytes(profile),
      signal,
    );
    const normalizedFd = openSync(temporaryPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      fsyncSync(normalizedFd);
    } finally {
      closeSync(normalizedFd);
    }
    return {
      channel,
      sourceArm,
      temporaryPath,
      sourceBefore: publicRevision(sourceBefore),
      sourceAfter: publicRevision(sourceAfter),
      normalizedSha256: normalized.sha256,
      normalizedSizeBytes: normalized.sizeBytes,
    };
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* Temporary may not exist. */ }
    if (error instanceof BlindEvaluationConflictError) throw error;
    throw new BlindEvaluationConflictError(
      `Private v5-MP4-Normalisierung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function canonicalFinalSizeBytes(profile: BlindEvaluationNormalizationProfile): number {
  const encodedBudget = Math.ceil(
    (profile.target.videoBitRate + profile.target.audioBitRate) * profile.target.durationSeconds / 8,
  );
  const target = Math.ceil((encodedBudget + 4 * 1_024 * 1_024) / BLIND_EVALUATION_PADDING_BUCKET_BYTES)
    * BLIND_EVALUATION_PADDING_BUCKET_BYTES;
  if (!Number.isSafeInteger(target) || target <= encodedBudget) {
    throw new BlindEvaluationConflictError("Das feste v5-Transportziel ist nicht sicher darstellbar.");
  }
  return target;
}

export type BlindIsoBmffTopLevelBox = {
  type: string;
  offset: number;
  sizeBytes: number;
  headerBytes: 8 | 16;
  extendsToEof: boolean;
};

export function inspectBlindIsoBmffTopLevel(path: string): BlindIsoBmffTopLevelBox[] {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size < 8) {
    throw new BlindEvaluationConflictError("Der normalisierte v5-Snapshot ist kein regulärer ISO-BMFF-Container.");
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const boxes: BlindIsoBmffTopLevelBox[] = [];
    let offset = 0;
    while (offset < stats.size) {
      const header = Buffer.alloc(16);
      if (readSync(fd, header, 0, 8, offset) !== 8) {
        throw new BlindEvaluationConflictError("Ein ISO-BMFF-Top-Level-Header ist abgeschnitten.");
      }
      const size32 = header.readUInt32BE(0);
      const type = header.toString("ascii", 4, 8);
      let headerBytes: 8 | 16 = 8;
      let sizeBytes: number;
      let extendsToEof = false;
      if (size32 === 0) {
        sizeBytes = stats.size - offset;
        extendsToEof = true;
      } else if (size32 === 1) {
        if (readSync(fd, header, 8, 8, offset + 8) !== 8) {
          throw new BlindEvaluationConflictError("Ein erweiterter ISO-BMFF-Header ist abgeschnitten.");
        }
        const extended = header.readBigUInt64BE(8);
        if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new BlindEvaluationConflictError("Eine ISO-BMFF-Box ist nicht sicher darstellbar.");
        }
        sizeBytes = Number(extended);
        headerBytes = 16;
      } else {
        sizeBytes = size32;
      }
      if (sizeBytes < headerBytes || offset + sizeBytes > stats.size) {
        throw new BlindEvaluationConflictError("Eine ISO-BMFF-Top-Level-Box ist strukturell ungültig.");
      }
      boxes.push({ type, offset, sizeBytes, headerBytes, extendsToEof });
      offset += sizeBytes;
    }
    if (offset !== stats.size) throw new BlindEvaluationConflictError("ISO-BMFF endet nicht an einer Boxgrenze.");
    return boxes;
  } finally {
    closeSync(fd);
  }
}

type BlindIsoBmffBox = BlindIsoBmffTopLevelBox;

function readIsoBox(fd: number, offset: number, end: number): BlindIsoBmffBox {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || end - offset < 8) {
    throw new BlindEvaluationConflictError("Eine verschachtelte ISO-BMFF-Box ist abgeschnitten.");
  }
  const header = Buffer.alloc(16);
  if (readSync(fd, header, 0, 8, offset) !== 8) {
    throw new BlindEvaluationConflictError("Ein verschachtelter ISO-BMFF-Header ist abgeschnitten.");
  }
  const size32 = header.readUInt32BE(0);
  const type = header.toString("ascii", 4, 8);
  if (!/^[\x20-\x7e]{4}$/.test(type)) {
    throw new BlindEvaluationConflictError("Eine ISO-BMFF-Box besitzt keinen kanonischen Vierzeichentyp.");
  }
  let headerBytes: 8 | 16 = 8;
  let extendsToEof = false;
  let sizeBytes: number;
  if (size32 === 0) {
    sizeBytes = end - offset;
    extendsToEof = true;
  } else if (size32 === 1) {
    if (readSync(fd, header, 8, 8, offset + 8) !== 8) {
      throw new BlindEvaluationConflictError("Ein erweiterter ISO-BMFF-Header ist abgeschnitten.");
    }
    const extended = header.readBigUInt64BE(8);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new BlindEvaluationConflictError("Eine ISO-BMFF-Box ist nicht sicher darstellbar.");
    }
    sizeBytes = Number(extended);
    headerBytes = 16;
  } else {
    sizeBytes = size32;
  }
  if (sizeBytes < headerBytes || offset + sizeBytes > end) {
    throw new BlindEvaluationConflictError("Eine verschachtelte ISO-BMFF-Box verlässt ihre Elternbox.");
  }
  return { type, offset, sizeBytes, headerBytes, extendsToEof };
}

function readIsoChildren(fd: number, start: number, end: number): BlindIsoBmffBox[] {
  const children: BlindIsoBmffBox[] = [];
  let offset = start;
  while (offset < end) {
    const box = readIsoBox(fd, offset, end);
    if (box.extendsToEof) {
      throw new BlindEvaluationConflictError("Verschachtelte ISO-BMFF-Boxen dürfen nicht bis EOF reichen.");
    }
    children.push(box);
    offset += box.sizeBytes;
  }
  if (offset !== end) throw new BlindEvaluationConflictError("Verschachtelte ISO-BMFF-Boxen enden nicht an einer Boxgrenze.");
  return children;
}

function assertIsoTypes(boxes: readonly BlindIsoBmffBox[], expected: readonly string[], scope: string): void {
  if (canonicalBlindEvaluationJson(boxes.map(({ type }) => type))
    !== canonicalBlindEvaluationJson(expected)) {
    throw new BlindEvaluationConflictError(
      `${scope} verletzt die rekursive v5-ISO-BMFF-Allowlist: ${boxes.map(({ type }) => type).join(",")}.`,
    );
  }
}

function assertZeroIsoPayload(fd: number, box: BlindIsoBmffBox): void {
  const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, Math.max(1, box.sizeBytes - box.headerBytes)));
  let position = box.offset + box.headerBytes;
  const end = box.offset + box.sizeBytes;
  while (position < end) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, end - position), position);
    if (count <= 0) throw new BlindEvaluationConflictError("Eine kanonische free-Box ist abgeschnitten.");
    if (buffer.subarray(0, count).some((byte) => byte !== 0)) {
      throw new BlindEvaluationConflictError("Eine kanonische free-Box darf keine verborgenen Metadaten tragen.");
    }
    position += count;
  }
}

function stsdEntry(fd: number, stsd: BlindIsoBmffBox): BlindIsoBmffBox {
  const header = Buffer.alloc(8);
  const payload = stsd.offset + stsd.headerBytes;
  if (readSync(fd, header, 0, 8, payload) !== 8 || header.readUInt32BE(4) !== 1) {
    throw new BlindEvaluationConflictError("v5 benötigt genau einen Sample-Description-Eintrag je Spur.");
  }
  const entries = readIsoChildren(fd, payload + 8, stsd.offset + stsd.sizeBytes);
  if (entries.length !== 1) throw new BlindEvaluationConflictError("v5 benötigt genau einen Sample-Description-Eintrag je Spur.");
  return entries[0]!;
}

function assertCanonicalTrack(fd: number, track: BlindIsoBmffBox, kind: "video" | "audio"): void {
  const trackChildren = readIsoChildren(fd, track.offset + track.headerBytes, track.offset + track.sizeBytes);
  assertIsoTypes(trackChildren, ["tkhd", "edts", "mdia"], `${kind}-trak`);
  const editChildren = readIsoChildren(
    fd,
    trackChildren[1]!.offset + trackChildren[1]!.headerBytes,
    trackChildren[1]!.offset + trackChildren[1]!.sizeBytes,
  );
  assertIsoTypes(editChildren, ["elst"], `${kind}-edts`);
  const media = trackChildren[2]!;
  const mediaChildren = readIsoChildren(fd, media.offset + media.headerBytes, media.offset + media.sizeBytes);
  assertIsoTypes(mediaChildren, ["mdhd", "hdlr", "minf"], `${kind}-mdia`);
  const minf = mediaChildren[2]!;
  const minfChildren = readIsoChildren(fd, minf.offset + minf.headerBytes, minf.offset + minf.sizeBytes);
  assertIsoTypes(minfChildren, [kind === "video" ? "vmhd" : "smhd", "dinf", "stbl"], `${kind}-minf`);
  const dinf = minfChildren[1]!;
  const dinfChildren = readIsoChildren(fd, dinf.offset + dinf.headerBytes, dinf.offset + dinf.sizeBytes);
  assertIsoTypes(dinfChildren, ["dref"], `${kind}-dinf`);
  const dref = dinfChildren[0]!;
  const drefHeader = Buffer.alloc(8);
  const drefPayload = dref.offset + dref.headerBytes;
  if (readSync(fd, drefHeader, 0, 8, drefPayload) !== 8 || drefHeader.readUInt32BE(4) !== 1) {
    throw new BlindEvaluationConflictError(`${kind}-dref besitzt nicht genau einen lokalen Datenverweis.`);
  }
  assertIsoTypes(
    readIsoChildren(fd, drefPayload + 8, dref.offset + dref.sizeBytes),
    ["url "],
    `${kind}-dref`,
  );
  const stbl = minfChildren[2]!;
  const stblChildren = readIsoChildren(fd, stbl.offset + stbl.headerBytes, stbl.offset + stbl.sizeBytes);
  assertIsoTypes(
    stblChildren,
    kind === "video"
      ? ["stsd", "stts", "stss", "ctts", "stsc", "stsz", "stco"]
      : ["stsd", "stts", "stsc", "stsz", "stco", "sgpd", "sbgp"],
    `${kind}-stbl`,
  );
  const entry = stsdEntry(fd, stblChildren[0]!);
  const expectedEntry = kind === "video" ? "avc1" : "mp4a";
  if (entry.type !== expectedEntry) {
    throw new BlindEvaluationConflictError(`${kind}-stsd enthält ${entry.type} statt ${expectedEntry}.`);
  }
  const childStart = entry.offset + (kind === "video" ? 86 : 36);
  if (childStart > entry.offset + entry.sizeBytes) {
    throw new BlindEvaluationConflictError(`${kind}-Sample-Entry ist abgeschnitten.`);
  }
  assertIsoTypes(
    readIsoChildren(fd, childStart, entry.offset + entry.sizeBytes),
    kind === "video" ? ["avcC", "colr", "pasp", "btrt"] : ["esds", "btrt"],
    `${kind}-${expectedEntry}`,
  );
}

function inspectCanonicalIsoBmffFd(fd: number, sizeBytes: number): BlindIsoBmffTopLevelBox[] {
  const top = readIsoChildren(fd, 0, sizeBytes);
  assertIsoTypes(top, ["ftyp", "moov", "free", "mdat"], "Top-Level");
  if (top.some((box) => box.extendsToEof)) {
    throw new BlindEvaluationConflictError("v5 verbietet ISO-BMFF-Boxen mit implizitem EOF-Ende.");
  }
  assertZeroIsoPayload(fd, top[2]!);
  const moov = top[1]!;
  const moovChildren = readIsoChildren(fd, moov.offset + moov.headerBytes, moov.offset + moov.sizeBytes);
  assertIsoTypes(moovChildren, ["mvhd", "trak", "trak", "free"], "moov");
  assertZeroIsoPayload(fd, moovChildren[3]!);
  assertCanonicalTrack(fd, moovChildren[1]!, "video");
  assertCanonicalTrack(fd, moovChildren[2]!, "audio");
  return top;
}

function readExactBytes(fd: number, offset: number, length: number): Buffer {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new BlindEvaluationConflictError("Eine ISO-BMFF-Lesegrenze ist nicht sicher darstellbar.");
  }
  const value = Buffer.alloc(length);
  if (length > 0 && readSync(fd, value, 0, length, offset) !== length) {
    throw new BlindEvaluationConflictError("Eine ISO-BMFF-Tabelle ist abgeschnitten.");
  }
  return value;
}

function videoSampleTable(fd: number, top: readonly BlindIsoBmffBox[]): BlindIsoBmffBox {
  const moov = top[1]!;
  const moovChildren = readIsoChildren(fd, moov.offset + moov.headerBytes, moov.offset + moov.sizeBytes);
  const track = moovChildren[1]!;
  const trackChildren = readIsoChildren(fd, track.offset + track.headerBytes, track.offset + track.sizeBytes);
  const media = trackChildren[2]!;
  const mediaChildren = readIsoChildren(fd, media.offset + media.headerBytes, media.offset + media.sizeBytes);
  const minf = mediaChildren[2]!;
  const minfChildren = readIsoChildren(fd, minf.offset + minf.headerBytes, minf.offset + minf.sizeBytes);
  return minfChildren[2]!;
}

async function inspectH264NalUnitCounts(
  fd: number,
  top: readonly BlindIsoBmffBox[],
  expectedFrames: number,
  signal: AbortSignal,
): Promise<{
  counts: { nonIdrSlice: number; idrSlice: number; sps: 1; pps: 1; filler: number; sei: number };
  spsNal: Buffer;
}> {
  const stbl = videoSampleTable(fd, top);
  const children = readIsoChildren(fd, stbl.offset + stbl.headerBytes, stbl.offset + stbl.sizeBytes);
  const stsd = children[0]!;
  const entry = stsdEntry(fd, stsd);
  const entryChildren = readIsoChildren(fd, entry.offset + 86, entry.offset + entry.sizeBytes);
  const avcC = entryChildren[0]!;
  const avcConfig = readExactBytes(fd, avcC.offset + avcC.headerBytes, avcC.sizeBytes - avcC.headerBytes);
  if (avcConfig.length < 10 || avcConfig[0] !== 1 || (avcConfig[4]! & 3) + 1 !== 4
    || (avcConfig[5]! & 0x1f) !== 1) {
    throw new BlindEvaluationConflictError("avcC bindet nicht exakt eine SPS und 4-Byte-NAL-Längen.");
  }
  let configOffset = 6;
  const spsLength = avcConfig.readUInt16BE(configOffset);
  configOffset += 2;
  if (spsLength <= 0 || configOffset + spsLength + 3 > avcConfig.length
    || (avcConfig[configOffset]! & 0x1f) !== 7) {
    throw new BlindEvaluationConflictError("avcC enthält keine eindeutige SPS.");
  }
  const spsNal = Buffer.from(avcConfig.subarray(configOffset, configOffset + spsLength));
  configOffset += spsLength;
  const ppsCount = avcConfig[configOffset];
  configOffset += 1;
  const ppsLength = avcConfig.readUInt16BE(configOffset);
  configOffset += 2;
  if (ppsCount !== 1 || ppsLength <= 0 || configOffset + ppsLength > avcConfig.length
    || (avcConfig[configOffset]! & 0x1f) !== 8) {
    throw new BlindEvaluationConflictError("avcC enthält keine eindeutige PPS.");
  }

  const stsc = children[4]!;
  const stsz = children[5]!;
  const stco = children[6]!;
  const stszHeader = readExactBytes(fd, stsz.offset + stsz.headerBytes, 12);
  const uniformSampleSize = stszHeader.readUInt32BE(4);
  const sampleCount = stszHeader.readUInt32BE(8);
  if (sampleCount !== expectedFrames) {
    throw new BlindEvaluationConflictError("Die Video-Sampletabelle stimmt nicht mit der gemessenen Framezahl überein.");
  }
  const sampleSizes = uniformSampleSize === 0
    ? Array.from({ length: sampleCount }, (_, index) => readExactBytes(
      fd, stsz.offset + stsz.headerBytes + 12 + index * 4, 4,
    ).readUInt32BE(0))
    : Array.from({ length: sampleCount }, () => uniformSampleSize);
  if (sampleSizes.some((size) => size <= 0 || size > 64 * 1_024 * 1_024)) {
    throw new BlindEvaluationConflictError("Eine Video-Samplegröße ist unzulässig.");
  }
  const stcoCount = readExactBytes(fd, stco.offset + stco.headerBytes + 4, 4).readUInt32BE(0);
  const chunkOffsets = Array.from({ length: stcoCount }, (_, index) => readExactBytes(
    fd, stco.offset + stco.headerBytes + 8 + index * 4, 4,
  ).readUInt32BE(0));
  const stscCount = readExactBytes(fd, stsc.offset + stsc.headerBytes + 4, 4).readUInt32BE(0);
  const stscEntries = Array.from({ length: stscCount }, (_, index) => {
    const row = readExactBytes(fd, stsc.offset + stsc.headerBytes + 8 + index * 12, 12);
    return {
      firstChunk: row.readUInt32BE(0),
      samplesPerChunk: row.readUInt32BE(4),
      descriptionIndex: row.readUInt32BE(8),
    };
  });
  if (chunkOffsets.length < 1 || stscEntries.length < 1
    || stscEntries[0]?.firstChunk !== 1
    || stscEntries.some((entryValue, index) => entryValue.samplesPerChunk < 1
      || entryValue.descriptionIndex !== 1
      || (index > 0 && entryValue.firstChunk <= stscEntries[index - 1]!.firstChunk))) {
    throw new BlindEvaluationConflictError("Die Video-Chunkzuordnung ist nicht kanonisch.");
  }
  const counts = new Map<number, number>();
  let sampleIndex = 0;
  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex += 1) {
    const chunkNumber = chunkIndex + 1;
    const mapping = [...stscEntries].reverse().find((entryValue) => entryValue.firstChunk <= chunkNumber);
    if (!mapping) throw new BlindEvaluationConflictError("Eine Video-Chunkzuordnung fehlt.");
    let position = chunkOffsets[chunkIndex]!;
    for (let inChunk = 0; inChunk < mapping.samplesPerChunk; inChunk += 1) {
      const sampleSize = sampleSizes[sampleIndex];
      if (sampleSize === undefined) throw new BlindEvaluationConflictError("Die Video-Chunkzuordnung enthält zu viele Samples.");
      const sample = readExactBytes(fd, position, sampleSize);
      let nalOffset = 0;
      while (nalOffset < sample.length) {
        if (nalOffset + 4 > sample.length) throw new BlindEvaluationConflictError("Eine H.264-NAL-Länge ist abgeschnitten.");
        const nalLength = sample.readUInt32BE(nalOffset);
        nalOffset += 4;
        if (nalLength <= 0 || nalOffset + nalLength > sample.length) {
          throw new BlindEvaluationConflictError("Eine H.264-NAL verlässt ihr gebundenes Sample.");
        }
        const type = sample[nalOffset]! & 0x1f;
        counts.set(type, (counts.get(type) ?? 0) + 1);
        nalOffset += nalLength;
      }
      position += sampleSize;
      sampleIndex += 1;
      await yieldBlindOperation(signal);
    }
  }
  if (sampleIndex !== sampleSizes.length || [...counts.keys()].some((type) => ![1, 5, 12].includes(type))) {
    throw new BlindEvaluationConflictError("Die fertigen Video-Samples enthalten zusätzliche oder fehlende NAL-Typen.");
  }
  return {
    counts: {
      nonIdrSlice: counts.get(1) ?? 0,
      idrSlice: counts.get(5) ?? 0,
      sps: 1,
      pps: 1,
      filler: counts.get(12) ?? 0,
      sei: counts.get(6) ?? 0,
    },
    spsNal,
  };
}

class H264BitReader {
  private bitOffset = 0;

  constructor(private readonly bytes: Buffer) {}

  bit(): number {
    if (this.bitOffset >= this.bytes.length * 8) {
      throw new BlindEvaluationConflictError("Die H.264-SPS ist abgeschnitten.");
    }
    const byte = this.bytes[Math.floor(this.bitOffset / 8)]!;
    const value = (byte >> (7 - (this.bitOffset % 8))) & 1;
    this.bitOffset += 1;
    return value;
  }

  bits(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 32) {
      throw new BlindEvaluationConflictError("Eine H.264-Bitfeldlänge ist ungültig.");
    }
    let value = 0;
    for (let index = 0; index < count; index += 1) value = value * 2 + this.bit();
    return value;
  }

  unsignedExpGolomb(): number {
    let leadingZeros = 0;
    while (this.bit() === 0) {
      leadingZeros += 1;
      if (leadingZeros > 30) throw new BlindEvaluationConflictError("Ein H.264-Exp-Golomb-Wert ist zu groß.");
    }
    return (2 ** leadingZeros) - 1 + this.bits(leadingZeros);
  }

  signedExpGolomb(): number {
    const code = this.unsignedExpGolomb();
    return code % 2 === 0 ? -(code / 2) : (code + 1) / 2;
  }
}

function skipH264ScalingList(reader: H264BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let index = 0; index < size; index += 1) {
    if (nextScale !== 0) {
      nextScale = (lastScale + reader.signedExpGolomb() + 256) % 256;
    }
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function parseH264Hrd(reader: H264BitReader): { cpbCount: number; cbr: boolean } {
  const cpbCount = reader.unsignedExpGolomb() + 1;
  if (cpbCount < 1 || cpbCount > 32) throw new BlindEvaluationConflictError("H.264-HRD besitzt eine unzulässige CPB-Anzahl.");
  reader.bits(4);
  reader.bits(4);
  let cbr = true;
  for (let index = 0; index < cpbCount; index += 1) {
    reader.unsignedExpGolomb();
    reader.unsignedExpGolomb();
    cbr = reader.bit() === 1 && cbr;
  }
  reader.bits(5);
  reader.bits(5);
  reader.bits(5);
  reader.bits(5);
  return { cpbCount, cbr };
}

function parseH264SpsFacts(spsNal: Buffer): {
  maxNumRefFrames: number;
  fixedFrameRate: boolean;
  nalHrd: boolean;
  cpbCount: number;
  cbr: boolean;
} {
  if (spsNal.length < 4 || (spsNal[0]! & 0x1f) !== 7) {
    throw new BlindEvaluationConflictError("Die avcC-SPS besitzt keinen SPS-NAL-Header.");
  }
  const rbsp: number[] = [];
  for (let index = 1; index < spsNal.length; index += 1) {
    if (index >= 3 && spsNal[index] === 0x03 && spsNal[index - 1] === 0x00 && spsNal[index - 2] === 0x00) continue;
    rbsp.push(spsNal[index]!);
  }
  const reader = new H264BitReader(Buffer.from(rbsp));
  const profileIdc = reader.bits(8);
  reader.bits(8);
  reader.bits(8);
  reader.unsignedExpGolomb();
  let chromaFormatIdc = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = reader.unsignedExpGolomb();
    if (chromaFormatIdc === 3) reader.bit();
    reader.unsignedExpGolomb();
    reader.unsignedExpGolomb();
    reader.bit();
    if (reader.bit() === 1) {
      const listCount = chromaFormatIdc === 3 ? 12 : 8;
      for (let index = 0; index < listCount; index += 1) {
        if (reader.bit() === 1) skipH264ScalingList(reader, index < 6 ? 16 : 64);
      }
    }
  }
  reader.unsignedExpGolomb();
  const picOrderCountType = reader.unsignedExpGolomb();
  if (picOrderCountType === 0) {
    reader.unsignedExpGolomb();
  } else if (picOrderCountType === 1) {
    reader.bit();
    reader.signedExpGolomb();
    reader.signedExpGolomb();
    const cycle = reader.unsignedExpGolomb();
    for (let index = 0; index < cycle; index += 1) reader.signedExpGolomb();
  } else if (picOrderCountType !== 2) {
    throw new BlindEvaluationConflictError("Die H.264-SPS besitzt einen unbekannten POC-Typ.");
  }
  const maxNumRefFrames = reader.unsignedExpGolomb();
  reader.bit();
  reader.unsignedExpGolomb();
  reader.unsignedExpGolomb();
  const frameMbsOnly = reader.bit();
  if (frameMbsOnly === 0) reader.bit();
  reader.bit();
  if (reader.bit() === 1) {
    reader.unsignedExpGolomb();
    reader.unsignedExpGolomb();
    reader.unsignedExpGolomb();
    reader.unsignedExpGolomb();
  }
  if (reader.bit() !== 1) {
    throw new BlindEvaluationConflictError("Die H.264-SPS besitzt keine messbaren VUI-Parameter.");
  }
  if (reader.bit() === 1) {
    const aspectRatioIdc = reader.bits(8);
    if (aspectRatioIdc === 255) {
      reader.bits(16);
      reader.bits(16);
    }
  }
  if (reader.bit() === 1) reader.bit();
  if (reader.bit() === 1) {
    reader.bits(3);
    reader.bit();
    if (reader.bit() === 1) {
      reader.bits(8);
      reader.bits(8);
      reader.bits(8);
    }
  }
  if (reader.bit() === 1) {
    reader.unsignedExpGolomb();
    reader.unsignedExpGolomb();
  }
  let fixedFrameRate = false;
  if (reader.bit() === 1) {
    reader.bits(32);
    reader.bits(32);
    fixedFrameRate = reader.bit() === 1;
  }
  const nalHrd = reader.bit() === 1;
  const nalFacts = nalHrd ? parseH264Hrd(reader) : { cpbCount: 0, cbr: false };
  const vclHrd = reader.bit() === 1;
  if (vclHrd) parseH264Hrd(reader);
  if (nalHrd || vclHrd) reader.bit();
  reader.bit();
  return { maxNumRefFrames, fixedFrameRate, nalHrd, ...nalFacts };
}

function sanitizeCanonicalUdtaToFree(path: string): void {
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const stats = fstatSync(fd);
    const top = readIsoChildren(fd, 0, stats.size);
    assertIsoTypes(top, ["ftyp", "moov", "free", "mdat"], "vorbereitete Top-Level-Boxen");
    const moov = top[1]!;
    const children = readIsoChildren(fd, moov.offset + moov.headerBytes, moov.offset + moov.sizeBytes);
    assertIsoTypes(children, ["mvhd", "trak", "trak", "udta"], "vorbereitete moov-Box");
    const udta = children[3]!;
    const udtaChildren = readIsoChildren(fd, udta.offset + udta.headerBytes, udta.offset + udta.sizeBytes);
    assertIsoTypes(udtaChildren, ["meta"], "vorbereitete udta-Box");
    const meta = udtaChildren[0]!;
    const metaChildren = readIsoChildren(
      fd,
      meta.offset + meta.headerBytes + 4,
      meta.offset + meta.sizeBytes,
    );
    assertIsoTypes(metaChildren, ["hdlr", "ilst"], "vorbereitete meta-Box");
    if (metaChildren[1]!.sizeBytes !== metaChildren[1]!.headerBytes) {
      throw new BlindEvaluationConflictError("Die vorbereitete ilst-Box ist nicht leer.");
    }
    if (writeSync(fd, Buffer.from("free", "ascii"), 0, 4, udta.offset + 4) !== 4) {
      throw new BlindEvaluationConflictError("Die kanonische Metadatenbox konnte nicht neutralisiert werden.");
    }
    const zeros = Buffer.alloc(Math.min(COPY_BUFFER_BYTES, Math.max(1, udta.sizeBytes - udta.headerBytes)));
    let position = udta.offset + udta.headerBytes;
    const end = udta.offset + udta.sizeBytes;
    while (position < end) {
      const count = Math.min(zeros.length, end - position);
      if (writeSync(fd, zeros, 0, count, position) !== count) {
        throw new BlindEvaluationConflictError("Die kanonische Metadatenbox wurde nicht vollständig neutralisiert.");
      }
      position += count;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

type BlindOriginalMdatBinding = {
  offsetBytes: number;
  sizeBytes: number;
  headerBytes: 8;
  sizeHeaderHex: string;
};

async function extendLastMdatWithRandomFiller(
  path: string,
  targetSizeBytes: number,
  signal: AbortSignal,
): Promise<BlindOriginalMdatBinding> {
  const boxes = inspectBlindIsoBmffTopLevel(path);
  const last = boxes.at(-1);
  const currentSize = lstatSync(path).size;
  const finalMdatSize = last ? targetSizeBytes - last.offset : 0;
  if (!last || last.type !== "mdat" || last.offset + last.sizeBytes !== currentSize
    || last.extendsToEof || last.headerBytes !== 8 || targetSizeBytes <= currentSize
    || finalMdatSize <= last.sizeBytes || finalMdatSize > 0xffff_ffff) {
    throw new BlindEvaluationConflictError("v5 benötigt eine explizite letzte 32-Bit-mdat, die ohne neue EOF-Box erweitert werden kann.");
  }
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    inspectCanonicalIsoBmffFd(fd, currentSize);
    const originalHeader = Buffer.alloc(4);
    if (readSync(fd, originalHeader, 0, 4, last.offset) !== 4
      || originalHeader.readUInt32BE(0) !== last.sizeBytes) {
      throw new BlindEvaluationConflictError("Die ursprüngliche mdat-Größe ist nicht explizit rekonstruierbar.");
    }
    const finalSizeHeader = Buffer.alloc(4);
    finalSizeHeader.writeUInt32BE(finalMdatSize, 0);
    if (writeSync(fd, finalSizeHeader, 0, finalSizeHeader.length, last.offset) !== finalSizeHeader.length) {
      throw new BlindEvaluationConflictError("Die letzte mdat konnte nicht auf das feste Transportende erweitert werden.");
    }
    let position = currentSize;
    while (position < targetSizeBytes) {
      const filler = randomBytes(Math.min(COPY_BUFFER_BYTES, targetSizeBytes - position));
      const written = writeSync(fd, filler, 0, filler.length, position);
      if (written !== filler.length) throw new BlindEvaluationConflictError("Der kryptografische mdat-Filler ist unvollständig.");
      position += written;
      await yieldBlindOperation(signal);
    }
    fsyncSync(fd);
    inspectCanonicalIsoBmffFd(fd, targetSizeBytes);
    return {
      offsetBytes: last.offset,
      sizeBytes: last.sizeBytes,
      headerBytes: 8,
      sizeHeaderHex: originalHeader.toString("hex"),
    };
  } finally {
    closeSync(fd);
  }
}

export type BlindCanonicalSnapshotProbe = {
  container: { majorBrand: string; compatibleBrands: string; startTime: string; duration: string };
  video: {
    codec: string; profile: string; level: number; codecTag: string; width: number; height: number;
    pixelFormat: string; sampleAspectRatio: string; displayAspectRatio: string; frameRate: string;
    timeBase: string; startTime: string; duration: string; frameCount: string; hasBFrames: number;
    colorRange: string; colorSpace: string; colorTransfer: string; colorPrimaries: string;
    language: string; handlerName: string; encoder: string; defaultDisposition: number; rotation: "none";
  };
  audio: {
    codec: string; profile: string; codecTag: string; sampleFormat: string; sampleRate: string;
    channels: number; channelLayout: string; timeBase: string; startTime: string; duration: string;
    language: string; handlerName: string; defaultDisposition: number;
  };
  measured: BlindEvaluationMeasuredMedia;
};

export async function probeBlindCanonicalSnapshot(
  path: string,
  profile: BlindEvaluationNormalizationProfile,
  tools?: { ffmpeg: BoundBlindExecutable; ffprobe: BoundBlindExecutable },
  signal: AbortSignal = new AbortController().signal,
): Promise<BlindCanonicalSnapshotProbe> {
  let ownedFfmpeg: BoundBlindExecutable | null = null;
  let ownedFfprobe: BoundBlindExecutable | null = null;
  let mediaFd: number | null = null;
  try {
    if (!tools) {
      ownedFfmpeg = await openBoundBlindExecutable(hostTcbExecutables.ffmpeg, signal);
      ownedFfprobe = await openBoundBlindExecutable(hostTcbExecutables.ffprobe, signal);
    }
    const ffmpeg = tools?.ffmpeg ?? ownedFfmpeg!;
    const ffprobe = tools?.ffprobe ?? ownedFfprobe!;
    mediaFd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = fstatSync(mediaFd);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0) {
      throw new BlindEvaluationConflictError("Der finale v5-Snapshot ist keine reguläre Datei.");
    }
    const beforeSha256 = await hashOpenFileDescriptorAsync(mediaFd, before.size, signal);
    const result = await runBoundToolAsync(ffprobe, [
      "-v", "error", "-show_streams", "-show_format", "-of", "json", "/proc/self/fd/4",
    ], signal, mediaFd);
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new BlindEvaluationConflictError("Der finale v5-Snapshot ist nicht mit dem FD-gebundenen ffprobe prüfbar.");
    }
    const parsed = JSON.parse(result.stdout) as {
      streams?: Array<Record<string, unknown>>;
      format?: Record<string, unknown>;
    };
    if (!parsed.streams || parsed.streams.length !== 2
      || parsed.streams[0]?.index !== 0 || parsed.streams[0]?.codec_type !== "video"
      || parsed.streams[1]?.index !== 1 || parsed.streams[1]?.codec_type !== "audio"
      || !parsed.format) {
      throw new BlindEvaluationConflictError("Der finale v5-Snapshot enthält nicht exakt zwei geordnete Video-/Audio-Streams.");
    }
    const video = parsed.streams[0]!;
    const audio = parsed.streams[1]!;
    const format = parsed.format;
    const videoTags = asRecord(video.tags) ?? {};
    const audioTags = asRecord(audio.tags) ?? {};
    const formatTags = asRecord(format.tags) ?? {};
    const videoDisposition = asRecord(video.disposition) ?? {};
    const audioDisposition = asRecord(audio.disposition) ?? {};
    const expectedFormatTags = {
      major_brand: "isom", minor_version: "512", compatible_brands: "isomiso2avc1mp41",
    };
    const expectedVideoTags = {
      language: "und", handler_name: "VideoHandler", vendor_id: "[0][0][0][0]", encoder: "Lavc libx264",
    };
    const expectedAudioTags = {
      language: "und", handler_name: "SoundHandler", vendor_id: "[0][0][0][0]",
    };
    const expectedDisposition = {
      default: 1, dub: 0, original: 0, comment: 0, lyrics: 0, karaoke: 0, forced: 0,
      hearing_impaired: 0, visual_impaired: 0, clean_effects: 0, attached_pic: 0,
      timed_thumbnails: 0, non_diegetic: 0, captions: 0, descriptions: 0, metadata: 0,
      dependent: 0, still_image: 0,
    };
    const sideDataEntries = [video, audio].reduce((count, stream) => (
      count + (Array.isArray(stream.side_data_list) ? stream.side_data_list.length : 0)
    ), 0);
    if (canonicalBlindEvaluationJson(formatTags) !== canonicalBlindEvaluationJson(expectedFormatTags)
      || canonicalBlindEvaluationJson(videoTags) !== canonicalBlindEvaluationJson(expectedVideoTags)
      || canonicalBlindEvaluationJson(audioTags) !== canonicalBlindEvaluationJson(expectedAudioTags)
      || canonicalBlindEvaluationJson(videoDisposition) !== canonicalBlindEvaluationJson(expectedDisposition)
      || canonicalBlindEvaluationJson(audioDisposition) !== canonicalBlindEvaluationJson(expectedDisposition)
      || sideDataEntries !== 0) {
      throw new BlindEvaluationConflictError(
        `Der finale v5-Snapshot besitzt zusätzliche Tags, Dispositions oder SideData: ${canonicalBlindEvaluationJson({ formatTags, videoTags, audioTags, videoDisposition, audioDisposition, sideDataEntries })}`,
      );
    }
    const duration = profile.target.durationSeconds.toFixed(6);
    const fingerprintBase = {
      container: {
        majorBrand: String(formatTags.major_brand ?? ""),
        compatibleBrands: String(formatTags.compatible_brands ?? ""),
        startTime: String(format.start_time ?? ""),
        duration: String(format.duration ?? ""),
      },
      video: {
        codec: String(video.codec_name ?? ""), profile: String(video.profile ?? ""), level: Number(video.level),
        codecTag: String(video.codec_tag_string ?? ""), width: Number(video.width), height: Number(video.height),
        pixelFormat: String(video.pix_fmt ?? ""), sampleAspectRatio: String(video.sample_aspect_ratio ?? ""),
        displayAspectRatio: String(video.display_aspect_ratio ?? ""), frameRate: String(video.avg_frame_rate ?? ""),
        timeBase: String(video.time_base ?? ""), startTime: String(video.start_time ?? ""),
        duration: String(video.duration ?? ""), frameCount: String(video.nb_frames ?? ""),
        hasBFrames: Number(video.has_b_frames), colorRange: String(video.color_range ?? ""),
        colorSpace: String(video.color_space ?? ""), colorTransfer: String(video.color_transfer ?? ""),
        colorPrimaries: String(video.color_primaries ?? ""), language: String(videoTags.language ?? ""),
        handlerName: String(videoTags.handler_name ?? ""), encoder: String(videoTags.encoder ?? ""),
        defaultDisposition: Number(videoDisposition.default), rotation: "none" as const,
      },
      audio: {
        codec: String(audio.codec_name ?? ""), profile: String(audio.profile ?? ""),
        codecTag: String(audio.codec_tag_string ?? ""), sampleFormat: String(audio.sample_fmt ?? ""),
        sampleRate: String(audio.sample_rate ?? ""), channels: Number(audio.channels),
        channelLayout: String(audio.channel_layout ?? ""), timeBase: String(audio.time_base ?? ""),
        startTime: String(audio.start_time ?? ""), duration: String(audio.duration ?? ""),
        language: String(audioTags.language ?? ""), handlerName: String(audioTags.handler_name ?? ""),
        defaultDisposition: Number(audioDisposition.default),
      },
    };
    const expectedFingerprint = {
      container: { majorBrand: "isom", compatibleBrands: "isomiso2avc1mp41", startTime: "0.000000", duration },
      video: {
        codec: "h264", profile: "High", level: 51, codecTag: "avc1", width: 1_280, height: 1_280,
        pixelFormat: "yuv420p", sampleAspectRatio: "1:1", displayAspectRatio: "1:1", frameRate: "25/1",
        timeBase: "1/90000", startTime: "0.000000", duration, frameCount: String(profile.target.frameCount),
        hasBFrames: 2, colorRange: "tv", colorSpace: "bt709", colorTransfer: "bt709", colorPrimaries: "bt709",
        language: "und", handlerName: "VideoHandler", encoder: "Lavc libx264", defaultDisposition: 1, rotation: "none",
      },
      audio: {
        codec: "aac", profile: "LC", codecTag: "mp4a", sampleFormat: "fltp", sampleRate: "48000",
        channels: 2, channelLayout: "stereo", timeBase: "1/48000", startTime: "0.000000", duration,
        language: "und", handlerName: "SoundHandler", defaultDisposition: 1,
      },
    };
    if (canonicalBlindEvaluationJson(fingerprintBase) !== canonicalBlindEvaluationJson(expectedFingerprint)) {
      throw new BlindEvaluationConflictError("Der finale v5-Snapshot weicht vom vollständigen kanonischen ffprobe-Profil ab.");
    }
    const videoBitRate = Number(video.bit_rate);
    const audioBitRate = Number(audio.bit_rate);
    if (!Number.isFinite(videoBitRate) || videoBitRate < profile.target.videoBitRate * 0.7
      || videoBitRate > profile.target.videoBitRate * 1.05
      || !Number.isFinite(audioBitRate) || audioBitRate < profile.target.audioBitRate * 0.85
      || audioBitRate > profile.target.audioBitRate * 1.1) {
      throw new BlindEvaluationConflictError("Der finale v5-Snapshot verletzt den gebundenen CBR/ABR-Bitratenvertrag.");
    }
    const framesResult = await runBoundToolAsync(ffprobe, [
      "-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "frame=key_frame",
      "-of", "json", "/proc/self/fd/4",
    ], signal, mediaFd, 30_000, 2 * 1_024 * 1_024);
    if (framesResult.error) throw framesResult.error;
    const frames = framesResult.status === 0
      ? (JSON.parse(framesResult.stdout) as { frames?: Array<{ key_frame?: number }> }).frames
      : undefined;
    if (!frames || frames.length !== profile.target.frameCount) {
      throw new BlindEvaluationConflictError("Der finale v5-Snapshot besitzt keine vollständig messbare Videoframefolge.");
    }
    const keyFramePositions = frames.flatMap((frame, index) => frame.key_frame === 1 ? [index] : []);
    const expectedKeyFramePositions = Array.from(
      { length: Math.ceil(profile.target.frameCount / profile.target.gopSize) },
      (_, index) => index * profile.target.gopSize,
    ).filter((position) => position < profile.target.frameCount);
    if (canonicalBlindEvaluationJson(keyFramePositions) !== canonicalBlindEvaluationJson(expectedKeyFramePositions)) {
      throw new BlindEvaluationConflictError("Gemessene GOP-/Keyframepositionen verletzen das angeforderte v5-Profil.");
    }
    const topLevel = inspectCanonicalIsoBmffFd(mediaFd, before.size);
    const nalInspection = await inspectH264NalUnitCounts(
      mediaFd,
      topLevel,
      profile.target.frameCount,
      signal,
    );
    const nalUnitCounts = nalInspection.counts;
    const { maxNumRefFrames, fixedFrameRate, nalHrd, cpbCount, cbr } = parseH264SpsFacts(nalInspection.spsNal);
    if (maxNumRefFrames !== 4 || !fixedFrameRate || !nalHrd || cpbCount !== 1 || !cbr
      || nalUnitCounts.sps !== 1 || nalUnitCounts.pps !== 1 || nalUnitCounts.sei !== 0
      || nalUnitCounts.idrSlice !== expectedKeyFramePositions.length
      || nalUnitCounts.nonIdrSlice + nalUnitCounts.idrSlice !== profile.target.frameCount
      || nalUnitCounts.filler !== profile.target.frameCount) {
      throw new BlindEvaluationConflictError("Gemessene SPS-/HRD-/Filler-/NAL-/SEI-Fakten verletzen den v5-Bitstreamvertrag.");
    }
    const decodeResult = await runBoundToolAsync(ffmpeg, [
      "-v", "error", "-xerror", "-i", "/proc/self/fd/4", "-map", "0:v:0", "-map", "0:a:0",
      "-f", "null", "-",
    ], signal, mediaFd, 60_000, 512 * 1_024);
    if (decodeResult.error) throw decodeResult.error;
    if (decodeResult.status !== 0 || decodeResult.stderr.trim()) {
      throw new BlindEvaluationConflictError("Der finale v5-Snapshot ist nicht vollständig fehlerfrei dekodierbar.");
    }
    const measured = blindEvaluationMeasuredMediaSchema.parse({
      schemaVersion: "ltx-studio-blind-evaluation-measured-media.v5",
      contractKind: "measured-finished-media",
      streamsTotal: 2,
      streamTypes: ["video", "audio"],
      formatTags: expectedFormatTags,
      videoTags: expectedVideoTags,
      audioTags: expectedAudioTags,
      dispositions: { video: expectedDisposition, audio: expectedDisposition },
      sideDataEntries,
      topLevelBoxTypes: topLevel.map(({ type }) => type),
      videoKeyFramePositions: keyFramePositions,
      sps: { maxNumRefFrames, fixedFrameRate, nalHrd, cpbCount, cbr },
      nalUnitCounts,
      decodedVideoFrames: frames.length,
      decodedAudioStreams: 1,
      ffprobeFingerprintSha256: digestCanonical(fingerprintBase),
      sampleTableResidualExcluded: true,
    });
    const after = fstatSync(mediaFd);
    if (!sameStats(before, after)
      || await hashOpenFileDescriptorAsync(mediaFd, after.size, signal) !== beforeSha256) {
      throw new BlindEvaluationConflictError("Der finale v5-Snapshot änderte sich während Probe und Decode.");
    }
    return { ...fingerprintBase, measured };
  } catch (error) {
    if (error instanceof BlindEvaluationConflictError) throw error;
    throw new BlindEvaluationConflictError(
      `Der finale v5-Snapshot ist nicht kanonisch prüfbar: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (mediaFd !== null) closeSync(mediaFd);
    if (ownedFfmpeg) closeSync(ownedFfmpeg.fd);
    if (ownedFfprobe) closeSync(ownedFfprobe.fd);
  }
}

async function finalizeSnapshot(
  tools: { ffmpeg: BoundBlindExecutable; ffprobe: BoundBlindExecutable },
  profile: BlindEvaluationNormalizationProfile,
  sessionDirectory: string,
  normalized: NormalizedSnapshot,
  targetSizeBytes: number,
  signal: AbortSignal,
): Promise<{ binding: BlindEvaluationSnapshotBinding; privateRevision: BlindEvaluationPrivateFileRevision }> {
  const finalPath = safeChildPath(sessionDirectory, `${normalized.channel}.snapshot.v5.mp4`);
  try {
    const originalMdat = await extendLastMdatWithRandomFiller(
      normalized.temporaryPath,
      targetSizeBytes,
      signal,
    );
    immutableLinkFromTemporary(normalized.temporaryPath, finalPath);
    const finalRevision = await hashUnchangedRegularFile(finalPath, targetSizeBytes, signal);
    const finalStats = lstatSync(finalPath);
    if (finalStats.isSymbolicLink() || !finalStats.isFile() || finalStats.size !== targetSizeBytes
      || (finalStats.mode & 0o222) !== 0) {
      throw new BlindEvaluationConflictError("Der finale private v5-Snapshot ist nicht unveränderlich gebunden.");
    }
    const measured = (await probeBlindCanonicalSnapshot(finalPath, profile, tools, signal)).measured;
    return {
      privateRevision: finalRevision,
      binding: {
        channel: normalized.channel,
        sourceArm: normalized.sourceArm,
        sourceBefore: normalized.sourceBefore,
        sourceAfter: normalized.sourceAfter,
        normalizedSha256: normalized.normalizedSha256,
        normalizedSizeBytes: normalized.normalizedSizeBytes,
        originalMdat,
        fillerProfile: "iso-bmff-explicit-mdat-private-reconstruction.v2",
        finalSnapshotSha256: finalRevision.sha256,
        finalRevision: publicRevision(finalRevision),
        mimeType: "video/mp4",
        measured,
      },
    };
  } catch (error) {
    try { unlinkSync(normalized.temporaryPath); } catch { /* Temporary may already be linked. */ }
    if (error instanceof BlindEvaluationConflictError) throw error;
    throw new BlindEvaluationConflictError("Der normalisierte v5-Snapshot konnte nicht finalisiert werden.");
  }
}

function writeImmutableJson(
  path: string,
  value: unknown,
  maximumBytes = MAX_SESSION_RECORD_BYTES,
): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    const raw = `${JSON.stringify(value, null, 2)}\n`;
    const sizeBytes = Buffer.byteLength(raw, "utf8");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || sizeBytes > maximumBytes) {
      throw new BlindEvaluationConflictError(
        `Der kanonische v5-Steuerdatensatz umfasst ${sizeBytes} Bytes und überschreitet sein Readerlimit von ${maximumBytes} Bytes.`,
        412,
      );
    }
    fd = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(fd, raw, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    immutableLinkFromTemporary(temporaryPath, path);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(temporaryPath); } catch { /* Temporary may not exist. */ }
    if (error instanceof BlindEvaluationConflictError) throw error;
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new BlindEvaluationConflictError("Dieser v5-Blind-Evidenzschritt ist bereits unveränderlich gespeichert.");
    }
    throw new BlindEvaluationConflictError("v5-Blind-Evidence konnte nicht unveränderlich und dauerhaft gespeichert werden.");
  }
}

function unlinkDurably(path: string): void {
  try {
    unlinkSync(path);
    fsyncDirectory(resolve(path, ".."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw new BlindEvaluationConflictError("Ein v5-Steuerdatensatz konnte nicht dauerhaft entfernt werden.");
    }
  }
}

function readBoundedJson(path: string, maximumBytes: number): unknown {
  try {
    const { raw } = readHeldRegularFile(path, maximumBytes, true);
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch (error) {
    if (error instanceof BlindEvaluationConflictError) throw error;
    throw new BlindEvaluationConflictError("Ein v5-Blind-Evidenzdatensatz ist beschädigt.");
  }
}

function credentialsEqual(provided: string, expectedSha256: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(provided)) return false;
  const actual = Buffer.from(digestCredential(provided), "hex");
  const expected = Buffer.from(expectedSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class BlindEvaluationStore {
  private creating = false;
  private readonly submitting = new Set<string>();
  private readonly mediaCaches = new Map<string, BlindEvaluationMediaCacheEntry>();
  private readonly materializationControllers = new Map<string, AbortController>();
  private readonly v5Root: string;
  private readonly sessionsRoot: string;
  private readonly reservationsRoot: string;
  private readonly creationIndexRoot: string;
  private readonly revocationsRoot: string;
  private readonly lockReleasesRoot: string;
  private readonly quarantineRoot: string;
  private readonly tombstonesRoot: string;
  private readonly globalLockPath: string;

  constructor(
    root: string,
    private readonly outputRoot: string,
    private readonly random: BlindEvaluationRandom = defaultRandom,
    private readonly maxMediaBytes = DEFAULT_MAX_MEDIA_BYTES,
    private readonly fault?: (point: string) => void,
  ) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootStats = lstatSync(root);
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new BlindEvaluationConflictError("Blind-Evaluation-Speicher ist kein geschütztes Verzeichnis.");
    }
    chmodSync(root, 0o700);
    this.v5Root = safeChildPath(root, "v5");
    mkdirSync(this.v5Root, { recursive: true, mode: 0o700 });
    const v5Stats = lstatSync(this.v5Root);
    if (v5Stats.isSymbolicLink() || !v5Stats.isDirectory()) {
      throw new BlindEvaluationConflictError("v5-Blind-Evaluation-Speicher ist kein geschütztes Verzeichnis.");
    }
    chmodSync(this.v5Root, 0o700);
    this.sessionsRoot = safeChildPath(this.v5Root, "sessions");
    this.reservationsRoot = safeChildPath(this.v5Root, "reservations");
    this.creationIndexRoot = safeChildPath(this.v5Root, "creation-index");
    this.revocationsRoot = safeChildPath(this.v5Root, "revocations");
    this.lockReleasesRoot = safeChildPath(this.v5Root, "lock-releases");
    this.quarantineRoot = safeChildPath(this.v5Root, "quarantine");
    this.tombstonesRoot = safeChildPath(this.v5Root, "retention-tombstones");
    this.globalLockPath = safeChildPath(this.v5Root, "global-lock.v5.json");
    for (const directory of [
      this.sessionsRoot,
      this.reservationsRoot,
      this.creationIndexRoot,
      this.revocationsRoot,
      this.lockReleasesRoot,
      this.quarantineRoot,
      this.tombstonesRoot,
    ]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const details = lstatSync(directory);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new BlindEvaluationConflictError("Ein v5-Blind-Evaluation-Unterverzeichnis ist nicht geschützt.");
      }
      chmodSync(directory, 0o700);
    }
    this.recoverPublishStaging();
    this.recoverReservations();
    this.recoverGlobalLock();
    this.enforceRetentionPolicy();
    const retentionSweep = setInterval(() => {
      try {
        this.enforceRetentionPolicy();
      } catch {
        // Retention remains fail-closed on the next explicit storage action;
        // a background sweep must never crash the long-lived Studio process.
      }
    }, RETENTION_SWEEP_INTERVAL_MS);
    retentionSweep.unref();
  }

  reserve(
    experiment: ControlledExperiment,
    creationRequestId: string,
    createdAt = new Date().toISOString(),
    providedCredential?: string,
  ): { evaluation: BlindEvaluationPublic; credential: string; creationToken: string | null } {
    this.assertExperimentReady(experiment);
    const anticipatedSessionBytes = canonicalFinalSizeBytes(currentNormalizationProfile(experiment)) * 2
      + MAX_SESSION_RECORD_BYTES + MAX_SUBMISSION_RECORD_BYTES;
    this.assertStorageQuota(anticipatedSessionBytes);
    if (!/^[0-9a-f]{64}$/.test(creationRequestId)) {
      throw new BlindEvaluationConflictError("Eine v5-Reservation benötigt eine kryptografische Creation-Request-ID.", 412);
    }
    const indexed = this.readCreationIndex(creationRequestId);
    if (indexed) return this.resolveIndexedCreation(indexed, experiment, providedCredential);
    if (this.hasActiveSession()) {
      throw new BlindEvaluationConflictError("Der persistente globale v5-Evaluator-Lock ist bereits belegt.");
    }
    const id = this.random.id();
    const credential = this.random.credential();
    const creationToken = reservationCreationToken(id, credential, creationRequestId);
    const directory = this.reservationDirectory(id);
    if (existsSync(directory) || existsSync(this.sessionDirectory(id))) {
      throw new BlindEvaluationConflictError("Die neue v5-Reservation-ID ist bereits belegt.");
    }
    mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(this.reservationsRoot);
    const reservation = blindEvaluationReservationSchema.parse({
      schemaVersion: "ltx-studio-blind-evaluation-reservation.v5",
      id,
      experimentId: experiment.id,
      protocolSha256: experiment.protocolSha256,
      creationRequestId,
      evaluatorScopeCredential: credential,
      evaluatorScopeCredentialSha256: digestCredential(credential),
      creationTokenSha256: digestCredential(creationToken),
      lockNonce: reservationLockNonce(id, credential, creationRequestId),
      createdAt,
      owner: currentReservationOwner(),
    });
    try {
      writeImmutableJson(this.reservationPath(id), reservation);
      fsyncDirectory(directory);
      const index = blindEvaluationCreationIndexSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-creation-index.v5",
        creationRequestId,
        reservationId: id,
        experimentId: experiment.id,
        protocolSha256: experiment.protocolSha256,
        evaluatorScopeCredentialSha256: reservation.evaluatorScopeCredentialSha256,
        creationTokenSha256: reservation.creationTokenSha256,
        indexedAt: createdAt,
      });
      try {
        this.fault?.("before-creation-index");
        writeImmutableJson(this.creationIndexPath(creationRequestId), index);
        return { evaluation: this.toCreatingPublic(reservation, null), credential, creationToken };
      } catch (error) {
        const concurrent = this.readCreationIndex(creationRequestId);
        if (!concurrent) throw error;
        this.removeReservationDirectory(id);
        return this.resolveIndexedCreation(concurrent, experiment, providedCredential);
      }
    } catch (error) {
      if (existsSync(directory)) this.removeReservationDirectory(id);
      throw error;
    }
  }

  async claim(
    id: string,
    credential: string,
    creationToken: string,
    experiment: ControlledExperiment,
    publishedOutputs: BlindEvaluationPublishedOutputProvider,
    onLockAcquired?: () => void,
  ): Promise<BlindEvaluationPublic> {
    const published = this.read(id);
    if (published) {
      if (!credentialsEqual(credential, published.commitmentPreimage.evaluatorScopeCredentialSha256)
        || !credentialsEqual(creationToken, published.commitmentPreimage.creationTokenSha256)) {
        throw new BlindEvaluationConflictError("v5-Blind-Session nicht gefunden.", 404);
      }
      return this.toPublic(published);
    }
    const reservation = this.requireReservation(id, credential);
    if (experiment.status !== "frozen" || experiment.id !== reservation.experimentId
      || experiment.protocolSha256 !== reservation.protocolSha256) {
      throw new BlindEvaluationConflictError("Reservation und eingefrorenes Experiment sind nicht identisch gebunden.");
    }
    if (!credentialsEqual(creationToken, reservation.creationTokenSha256)) {
      throw new BlindEvaluationConflictError("v5-Blind-Creation-Autorität nicht gefunden.", 404);
    }
    const existingClaim = this.readClaim(id);
    if (existingClaim) {
      if (existingClaim.creationTokenSha256 !== reservation.creationTokenSha256) {
        throw new BlindEvaluationConflictError("Der dauerhafte v5-Claim widerspricht seiner Creation-Autorität.");
      }
      return this.toCreatingPublic(reservation, existingClaim);
    }
    this.acquireGlobalLock(reservation);
    let claimedHere = false;
    try {
      const claim = blindEvaluationClaimRecordSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-claim.v5",
        id,
        creationTokenSha256: reservation.creationTokenSha256,
        claimedAt: new Date().toISOString(),
        owner: currentReservationOwner(),
      });
      try {
        writeImmutableJson(this.claimPath(id), claim);
      } catch (error) {
        const concurrent = this.readClaim(id);
        if (concurrent?.creationTokenSha256 === reservation.creationTokenSha256) {
          return this.toCreatingPublic(reservation, concurrent);
        }
        throw error;
      }
      claimedHere = true;
      onLockAcquired?.();
      if (this.creating) throw new BlindEvaluationConflictError("Eine v5-Blind-Session wird bereits materialisiert.");
      this.creating = true;
      const materializationController = new AbortController();
      this.materializationControllers.set(id, materializationController);
      try {
        const evaluation = await this.materializeReservation(
          reservation,
          experiment,
          publishedOutputs,
          materializationController.signal,
        );
        this.activateGlobalLock(reservation);
        this.removeReservationDirectory(id);
        return evaluation;
      } finally {
        this.materializationControllers.delete(id);
        this.creating = false;
      }
    } catch (error) {
      if (claimedHere && !this.read(id)) {
        this.revokeReservation(reservation, "creation-failed");
        this.releaseGlobalLock(id);
      } else if (!this.read(id) && !this.readClaim(id)) {
        const lock = this.readGlobalLock();
        if (lock?.sessionId === id) this.releaseGlobalLock(id);
      }
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError("Die v5-Blind-Erstellung ist fail-closed fehlgeschlagen.");
    }
  }

  async create(
    experiment: ControlledExperiment,
    publishedOutputs: BlindEvaluationPublishedOutputProvider,
    createdAt = new Date().toISOString(),
    creationRequestId = digestCanonical({ experimentId: experiment.id, createdAt }),
  ): Promise<BlindEvaluationPublic> {
    const reservation = this.reserve(experiment, creationRequestId, createdAt);
    if (!reservation.creationToken) {
      throw new BlindEvaluationConflictError("Die v5-Creation-Autorität wurde nicht neu ausgegeben.");
    }
    return this.claim(
      reservation.evaluation.id,
      reservation.credential,
      reservation.creationToken,
      experiment,
      publishedOutputs,
    );
  }

  private async materializeReservation(
    reservation: BlindEvaluationReservation,
    experiment: ControlledExperiment,
    publishedOutputs: BlindEvaluationPublishedOutputProvider,
    materializationSignal: AbortSignal,
  ): Promise<BlindEvaluationPublic> {
    const { id, evaluatorScopeCredential: credential, creationRequestId, createdAt } = reservation;
    let ffmpeg: BoundBlindExecutable | null = null;
    let ffprobe: BoundBlindExecutable | null = null;
    const sourceFds: number[] = [];
    try {
      this.assertReservationNotRevoked(id);
      ffmpeg = await openBoundBlindExecutable(hostTcbExecutables.ffmpeg, materializationSignal);
      ffprobe = await openBoundBlindExecutable(hostTcbExecutables.ffprobe, materializationSignal);
      const tools = { ffmpeg, ffprobe };
      this.assertExperimentReady(experiment);
      const existing = this.forExperiment(experiment.id, experiment.protocolSha256!);
      if (existing) {
        this.assertRecordIntegrity(existing);
        this.assertSnapshots(existing);
        throw new BlindEvaluationConflictError("Für dieses Protokoll besteht bereits eine aktive v5-Blind-Session; sie wird niemals neu ausgegeben.");
      }
      const baselineOutput = exactOutputForArm(experiment, publishedOutputs.outputs, "baseline");
      const candidateOutput = exactOutputForArm(experiment, publishedOutputs.outputs, "candidate");
      const baselineLease = publishedOutputs.openPublishedOutput(baselineOutput.name, baselineOutput.jobId!);
      const candidateLease = publishedOutputs.openPublishedOutput(candidateOutput.name, candidateOutput.jobId!);
      if (!baselineLease || !candidateLease) {
        if (baselineLease) closeSync(baselineLease.fd);
        if (candidateLease) closeSync(candidateLease.fd);
        throw new BlindEvaluationConflictError("Beide Blind-v5-Arme benötigen einen autoritativen anonymen Publication-v2-Snapshot.");
      }
      const capturedResults = await Promise.allSettled([
        captureBinding(
          this.outputRoot,
          experiment,
          baselineOutput,
          baselineLease,
          "baseline",
          this.maxMediaBytes,
          materializationSignal,
        ).catch((error) => {
          this.materializationControllers.get(id)?.abort();
          throw error;
        }),
        captureBinding(
          this.outputRoot,
          experiment,
          candidateOutput,
          candidateLease,
          "candidate",
          this.maxMediaBytes,
          materializationSignal,
        ).catch((error) => {
          this.materializationControllers.get(id)?.abort();
          throw error;
        }),
      ]);
      for (const result of capturedResults) {
        if (result.status === "fulfilled") sourceFds.push(result.value.sourceFd);
      }
      const captureFailure = primaryBlindSettledFailure(capturedResults);
      if (captureFailure) throw captureFailure.reason;
      const [capturedBaseline, capturedCandidate] = capturedResults.map(
        (result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof captureBinding>>>).value,
      );
      const normalization = currentNormalizationProfile(experiment);
      const mapping = this.random.baselineFirst()
        ? { x: "baseline" as const, y: "candidate" as const }
        : { x: "candidate" as const, y: "baseline" as const };
      const stagingDirectory = safeChildPath(this.sessionsRoot, `.staging-${id}-${randomUUID()}`);
      const finalDirectory = this.sessionDirectory(id);
      if (existsSync(finalDirectory)) throw new BlindEvaluationConflictError("Die neue v5-Session-ID ist bereits belegt.");
      mkdirSync(stagingDirectory, { mode: 0o700 });
      fsyncDirectory(this.sessionsRoot);
      const captured = { baseline: capturedBaseline, candidate: capturedCandidate };
      const arms = { baseline: capturedBaseline.binding, candidate: capturedCandidate.binding };
      try {
        const normalize = (channel: BlindEvaluationChannel) => {
          const arm = mapping[channel];
          return remuxVerifiedSnapshot(
            tools.ffmpeg,
            tools.ffprobe,
            captured[arm].sourceFd,
            stagingDirectory,
            channel,
            arm,
            arms[arm],
            captured[arm].privateRevision,
            normalization,
            materializationSignal,
          ).catch((error) => {
            this.materializationControllers.get(id)?.abort();
            throw error;
          });
        };
        const cancellationPoll = setInterval(() => {
          try {
            if (this.readCreationOutcome(id)?.outcome === "cancel") {
              this.materializationControllers.get(id)?.abort();
            }
          } catch {
            this.materializationControllers.get(id)?.abort();
          }
        }, 100);
        cancellationPoll.unref();
        const settled = await Promise.allSettled([normalize("x"), normalize("y")])
          .finally(() => clearInterval(cancellationPoll));
        const rejected = primaryBlindSettledFailure(settled);
        if (rejected) throw rejected.reason;
        this.assertReservationNotRevoked(id);
        const normalized = settled.map(
          (result) => (result as PromiseFulfilledResult<NormalizedSnapshot>).value,
        ) as [NormalizedSnapshot, NormalizedSnapshot];
        this.fault?.("after-normalization");
        const targetSizeBytes = canonicalFinalSizeBytes(normalization);
        if (normalized.some((snapshot) => snapshot.normalizedSizeBytes >= targetSizeBytes)) {
          throw new BlindEvaluationConflictError("Ein kanonischer v5-Encode überschreitet das vorab feste Transportziel.");
        }
        const finalized = await Promise.allSettled([
          finalizeSnapshot(
            tools,
            normalization,
            stagingDirectory,
            normalized[0],
            targetSizeBytes,
            materializationSignal,
          ).catch((error) => {
            this.materializationControllers.get(id)?.abort();
            throw error;
          }),
          finalizeSnapshot(
            tools,
            normalization,
            stagingDirectory,
            normalized[1],
            targetSizeBytes,
            materializationSignal,
          ).catch((error) => {
            this.materializationControllers.get(id)?.abort();
            throw error;
          }),
        ]);
        const finalizeFailure = primaryBlindSettledFailure(finalized);
        if (finalizeFailure) throw finalizeFailure.reason;
        const [snapshotXResult, snapshotYResult] = finalized.map(
          (result) => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof finalizeSnapshot>>>).value,
        ) as [
          Awaited<ReturnType<typeof finalizeSnapshot>>,
          Awaited<ReturnType<typeof finalizeSnapshot>>,
        ];
        if (canonicalBlindEvaluationJson(snapshotXResult.binding.measured)
          !== canonicalBlindEvaluationJson(snapshotYResult.binding.measured)) {
          throw new BlindEvaluationConflictError("X und Y besitzen nicht dieselben gemessenen v5-Medienfakten.");
        }
        const boxesX = inspectBlindIsoBmffTopLevel(safeChildPath(stagingDirectory, "x.snapshot.v5.mp4"));
        const boxesY = inspectBlindIsoBmffTopLevel(safeChildPath(stagingDirectory, "y.snapshot.v5.mp4"));
        const finalBox = boxesX.at(-1);
        if (canonicalBlindEvaluationJson(boxesX) !== canonicalBlindEvaluationJson(boxesY)
          || !finalBox || finalBox.type !== "mdat" || finalBox.extendsToEof
          || finalBox.offset + finalBox.sizeBytes !== targetSizeBytes) {
          throw new BlindEvaluationConflictError("X und Y besitzen nicht dasselbe endliche v5-Top-Level-Boxlayout.");
        }
        this.fault?.("after-filler-fsync");
        const snapshotX = snapshotXResult.binding;
        const snapshotY = snapshotYResult.binding;
      const commitmentPreimage = blindEvaluationCommitmentPreimageSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-commitment.v5",
        sessionId: id,
        experimentId: experiment.id,
        protocolSha256: experiment.protocolSha256!,
        claimScope: "development",
        createdAt,
        nonce: this.random.nonce(),
        evaluatorScopeCredentialSha256: digestCredential(credential),
        creationTokenSha256: reservation.creationTokenSha256,
        requirements: {
          speeds: [1, 0.5],
          bothMediaRequired: true,
          bothAudioRequired: true,
          evidenceNature: "human-attestation",
          transportProfile: "canonical-private-mp4.v5",
          threatModel: BLIND_EVALUATION_THREAT_MODEL,
          timelineCoverage: blindEvaluationTimelineRequirements(normalization.target.durationSeconds),
        },
        tools: {
          ffmpeg: tools.ffmpeg.binding,
          ffprobe: tools.ffprobe.binding,
        },
        release: blindEvaluationReleaseBindingSchema.parse(releaseIdentity),
        normalization,
        arms,
        mapping,
        snapshots: { x: snapshotX, y: snapshotY },
      });
      const record = blindEvaluationRecordSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation.v5",
        id,
        creationRequestId,
        commitment: blindEvaluationCommitment(commitmentPreimage),
        commitmentPreimage,
        privateState: {
          sourceRevisions: {
            baseline: capturedBaseline.privateRevision,
            candidate: capturedCandidate.privateRevision,
          },
          snapshotRevisions: {
            x: snapshotXResult.privateRevision,
            y: snapshotYResult.privateRevision,
          },
          finalSizeBytes: targetSizeBytes,
          lockNonce: reservation.lockNonce,
        },
      });
        this.fault?.("before-record-write");
        writeImmutableJson(
          safeChildPath(stagingDirectory, "session.v5.json"),
          record,
          MAX_SESSION_RECORD_BYTES,
        );
        this.fault?.("after-record-write");
        fsyncDirectory(stagingDirectory);
        this.fault?.("before-publish");
        const publishRecordSha256 = digestCanonical(record);
        const publishOutcome = blindEvaluationCreationOutcomeSchema.parse({
          schemaVersion: "ltx-studio-blind-evaluation-creation-outcome.v5",
          id,
          outcome: "publish",
          recordSha256: publishRecordSha256,
          decidedAt: new Date().toISOString(),
        });
        try {
          writeImmutableJson(this.creationOutcomePath(id), publishOutcome);
        } catch (error) {
          const concurrent = this.readCreationOutcome(id);
          if (!concurrent || concurrent.outcome !== "publish"
            || concurrent.recordSha256 !== publishRecordSha256) throw error;
        }
        this.fault?.("after-publish-intent");
        renameSync(stagingDirectory, finalDirectory);
        fsyncDirectory(this.sessionsRoot);
        return this.toPublic(record);
      } catch (error) {
        if (existsSync(stagingDirectory)) {
          const staging = {
            name: stagingDirectory.slice(stagingDirectory.lastIndexOf(sep) + 1),
            path: stagingDirectory,
            sessionId: id,
          };
          const outcome = this.readCreationOutcome(id);
          if (outcome?.outcome === "cancel") {
            // Both normalization promises have settled before this catch runs;
            // their SIGKILLed children can therefore no longer write into the
            // directory.  A durable cancel outcome is the authority to remove
            // these non-published private intermediates instead of retaining
            // them indefinitely as crash evidence.
            rmSync(stagingDirectory, { recursive: true, force: false });
            fsyncDirectory(this.sessionsRoot);
          } else if (outcome?.outcome === "publish") {
            try {
              const recovered = this.promoteVerifiedStaging(staging, reservation, outcome);
              return this.toPublic(recovered);
            } catch {
              this.quarantineStaging(staging, "invalid-published-bytes", outcome.recordSha256);
            }
          } else {
            this.quarantineStaging(
              staging,
              outcome ? "invalid-publish-intent" : "missing-publish-intent",
              null,
            );
          }
        }
        throw error;
      }
    } finally {
      for (const fd of sourceFds) closeSync(fd);
      if (ffmpeg) closeSync(ffmpeg.fd);
      if (ffprobe) closeSync(ffprobe.fd);
    }
  }

  get(id: string, credential: string): BlindEvaluationPublic {
    const record = this.read(id);
    if (record) {
      if (!credentialsEqual(credential, record.commitmentPreimage.evaluatorScopeCredentialSha256)) {
        throw new BlindEvaluationConflictError("v5-Blind-Session nicht gefunden.", 404);
      }
      return this.toPublic(record);
    }
    const reservation = this.requireReservation(id, credential);
    return this.toCreatingPublic(reservation, this.readClaim(id));
  }

  authorize(id: string, credential: string): void {
    const record = this.read(id);
    if (record && credentialsEqual(credential, record.commitmentPreimage.evaluatorScopeCredentialSha256)) {
      this.assertRecordIntegrity(record);
      return;
    }
    this.requireReservation(id, credential);
  }

  scopeForCredential(credential: string): BlindEvaluationPublic | null {
    const sessions = this.v5SessionIds().flatMap((id) => {
      const record = this.read(id);
      if (!record || !credentialsEqual(credential, record.commitmentPreimage.evaluatorScopeCredentialSha256)) return [];
      const terminal = this.readTerminal(id);
      return terminal?.outcome === "revoked" ? [] : [record];
    });
    const sessionIds = new Set(sessions.map(({ id }) => id));
    const reservations = this.reservationIds().flatMap((id) => {
      if (sessionIds.has(id)) return [];
      const reservation = this.readReservation(id);
      return reservation && credentialsEqual(credential, reservation.evaluatorScopeCredentialSha256)
        ? [reservation]
        : [];
    });
    if (sessions.length + reservations.length > 1) {
      throw new BlindEvaluationConflictError("Eine v5-Evaluator-Capability ist mehrdeutig gebunden.");
    }
    if (sessions[0]) return this.toPublic(sessions[0]);
    return reservations[0] ? this.toCreatingPublic(reservations[0], this.readClaim(reservations[0].id)) : null;
  }

  hasActiveSession(): boolean {
    this.recoverGlobalLock();
    return this.readGlobalLock() !== null;
  }

  private storageUsageBytes(directory = this.v5Root): number {
    let files = 0;
    const visit = (path: string): number => {
      const details = lstatSync(path);
      if (details.isSymbolicLink()) {
        throw new BlindEvaluationConflictError("Die v5-Speicherquote folgt niemals symbolischen Links.");
      }
      if (details.isFile()) {
        files += 1;
        if (files > MAX_SESSION_FILES * 20) {
          throw new BlindEvaluationConflictError("Der v5-Speicher enthält unzulässig viele Dateien.");
        }
        return details.size;
      }
      if (!details.isDirectory()) {
        throw new BlindEvaluationConflictError("Der v5-Speicher enthält einen unzulässigen Spezialdateityp.");
      }
      return readdirSync(path).reduce((total, name) => total + visit(safeChildPath(path, name)), 0);
    };
    return visit(directory);
  }

  private assertStorageQuota(additionalBytes = 0): void {
    const usedBytes = this.storageUsageBytes();
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0
      || usedBytes + additionalBytes > BLIND_EVALUATION_STORAGE_MAX_BYTES) {
      throw new BlindEvaluationConflictError(
        `Die explizite Blind-v5-Speicherquote von ${BLIND_EVALUATION_STORAGE_MAX_BYTES} Bytes wäre überschritten.`,
      );
    }
  }

  private quarantineRecord(
    entryName: string,
    directory: string,
    quarantinedAt: string,
  ): z.infer<typeof blindEvaluationQuarantineRecordSchema> {
    const details = lstatSync(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new BlindEvaluationConflictError("Ein v5-Quarantäneeintrag ist kein pfadsicheres Verzeichnis.");
    }
    const recordPath = safeChildPath(directory, "quarantine.v5.json");
    if (!existsSync(recordPath)) {
      // v5.1 could crash in the rename->marker window.  Recover such legacy or
      // adversarial markerless directories immediately without inventing a
      // session binding; the durable discovery time starts their bounded TTL.
      writeImmutableJson(recordPath, blindEvaluationQuarantineRecordSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-quarantine.v5",
        quarantineName: entryName,
        sessionId: null,
        stagingName: null,
        quarantinedAt,
        reason: "unmarked-quarantine",
        publishRecordSha256: null,
      }), MAX_RESERVATION_RECORD_BYTES);
      fsyncDirectory(directory);
    }
    const record = blindEvaluationQuarantineRecordSchema.parse(
      readBoundedJson(recordPath, MAX_RESERVATION_RECORD_BYTES),
    );
    if (record.quarantineName !== entryName) {
      throw new BlindEvaluationConflictError("Ein v5-Quarantänemarker ist nicht an seinen Verzeichnisnamen gebunden.");
    }
    return record;
  }

  private removeQuarantineDirectorySafely(directory: string): void {
    const removeNode = (path: string): void => {
      const details = lstatSync(path);
      if (details.isDirectory() && !details.isSymbolicLink()) {
        for (const name of readdirSync(path)) removeNode(safeChildPath(path, name));
        rmdirSync(path);
        return;
      }
      // unlink removes a symbolic link itself and never follows its target.
      unlinkSync(path);
    };
    const relative = directory.slice(`${this.quarantineRoot}${sep}`.length);
    if (!directory.startsWith(`${this.quarantineRoot}${sep}`)
      || relative.length === 0 || relative.includes(sep)) {
      throw new BlindEvaluationConflictError("Ein v5-Quarantäneverzeichnis liegt außerhalb seines festen Roots.");
    }
    removeNode(directory);
    fsyncDirectory(this.quarantineRoot);
  }

  enforceRetentionPolicy(nowMs = Date.now()): void {
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new BlindEvaluationConflictError("Die v5-Retention benötigt einen gültigen Referenzzeitpunkt.");
    }
    const minimizedAt = new Date(nowMs).toISOString();
    for (const id of this.v5SessionIds()) {
      const record = this.read(id);
      if (!record) continue;
      const terminal = this.readTerminal(id);
      if (!terminal) continue;
      this.minimizeTerminalPrivateMedia(record);
      const terminalAt = terminal.outcome === "submitted"
        ? terminal.submissionPreimage.submittedAt
        : terminal.revokedAt;
      const terminalAtMs = Date.parse(terminalAt);
      if (!Number.isFinite(terminalAtMs) || nowMs - terminalAtMs < BLIND_EVALUATION_TERMINAL_RETENTION_MS) {
        continue;
      }
      const tombstone = blindEvaluationRetentionTombstoneSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-retention-tombstone.v5",
        sessionId: id,
        commitment: record.commitment,
        outcome: terminal.outcome,
        commitmentPreimageSha256: digestCanonical(record.commitmentPreimage),
        terminalRecordSha256: digestCanonical(terminal),
        submissionSha256: terminal.outcome === "submitted" ? terminal.submissionSha256 : null,
        createdAt: record.commitmentPreimage.createdAt,
        terminalAt,
        minimizedAt,
        purgeAfter: new Date(nowMs + BLIND_EVALUATION_TOMBSTONE_RETENTION_MS).toISOString(),
        removedPrivateMedia: true,
        removedEvaluatorCredential: true,
        removedSubmissionContent: true,
      });
      const tombstonePath = this.retentionTombstonePath(id);
      if (existsSync(tombstonePath)) {
        const existing = blindEvaluationRetentionTombstoneSchema.parse(
          readBoundedJson(tombstonePath, MAX_RESERVATION_RECORD_BYTES),
        );
        if (existing.sessionId !== id || existing.commitment !== record.commitment
          || existing.terminalRecordSha256 !== tombstone.terminalRecordSha256) {
          throw new BlindEvaluationConflictError("Ein bestehender v5-Retention-Tombstone widerspricht der terminalen Session.");
        }
      } else {
        writeImmutableJson(tombstonePath, tombstone);
      }
      rmSync(this.sessionDirectory(id), { recursive: true, force: false });
      fsyncDirectory(this.sessionsRoot);
    }
    for (const entry of readdirSync(this.tombstonesRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f-]{36}\.retention-tombstone\.v5\.json$/i.test(entry.name)) continue;
      const path = safeChildPath(this.tombstonesRoot, entry.name);
      const tombstone = blindEvaluationRetentionTombstoneSchema.parse(
        readBoundedJson(path, MAX_RESERVATION_RECORD_BYTES),
      );
      if (Date.parse(tombstone.purgeAfter) <= nowMs) unlinkDurably(path);
    }
    for (const entry of readdirSync(this.quarantineRoot, { withFileTypes: true })) {
      const directory = safeChildPath(this.quarantineRoot, entry.name);
      if (entry.isSymbolicLink()) {
        // A hostile top-level link cannot contain owned private bytes and is
        // safely removed as a link, never traversed.
        unlinkDurably(directory);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const details = lstatSync(directory);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new BlindEvaluationConflictError("Die v5-Quarantäne enthält einen unzulässigen Dateityp.");
      }
      const quarantine = this.quarantineRecord(entry.name, directory, minimizedAt);
      const quarantinedAtMs = Date.parse(quarantine.quarantinedAt);
      if (Number.isFinite(quarantinedAtMs)
        && nowMs - quarantinedAtMs >= BLIND_EVALUATION_QUARANTINE_RETENTION_MS) {
        this.removeQuarantineDirectorySafely(directory);
      }
    }
    this.assertStorageQuota();
  }

  boundExperimentId(id: string, credential: string): string {
    const record = this.read(id);
    if (record) return this.requireAuthorized(id, credential).commitmentPreimage.experimentId;
    return this.requireReservation(id, credential).experimentId;
  }

  openMedia(
    id: string,
    channel: BlindEvaluationChannel,
    credential: string,
    accessedAt = new Date().toISOString(),
  ): BlindEvaluationMediaLease {
    const record = this.requireAuthorized(id, credential, true);
    const path = this.snapshotPath(id, channel);
    const bound = record.privateState.snapshotRevisions[channel];
    const cacheKey = `${id}:${channel}`;
    const nowMs = Date.now();
    let cache = this.mediaCaches.get(cacheKey);
    let fd: number | null = null;
    try {
      if (cache && (cache.retired || cache.expiresAtMs <= nowMs
        || cache.commitment !== record.commitment
        || canonicalBlindEvaluationJson(cache.sourceRevision) !== canonicalBlindEvaluationJson(bound))) {
        cache.retired = true;
        closeSync(cache.fd);
        this.mediaCaches.delete(cacheKey);
        cache = undefined;
      }
      if (!cache) {
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stats = fstatSync(fd);
        if (!stats.isFile() || stats.size !== bound.sizeBytes || String(stats.ino) !== bound.fileId
          || Math.abs(stats.mtimeMs - bound.modifiedAtMs) >= 1
          || Math.abs(stats.ctimeMs - bound.changedAtMs) >= 1 || (stats.mode & 0o222) !== 0) {
          throw new BlindEvaluationConflictError("Der private v5-Blind-Snapshot ist nicht mehr unverändert verfügbar.");
        }
        assertBlindEvaluationMediaLeaseIntegrity({
          fd,
          sizeBytes: record.privateState.finalSizeBytes,
          mimeType: "video/mp4",
          expectedRevision: bound,
        });
        const anonymous = copyCommittedSnapshotToAnonymousCache(fd, bound, this.sessionDirectory(id));
        cache = {
          cacheKey,
          commitment: record.commitment,
          ...anonymous,
          sourceRevision: bound,
          createdAtMs: nowMs,
          expiresAtMs: nowMs + MEDIA_CACHE_LIFETIME_MS,
          maximumResponseBytes: Math.min(
            Number.MAX_SAFE_INTEGER,
            anonymous.sizeBytes * MEDIA_CACHE_BYTE_MULTIPLIER,
          ),
          reservedResponseBytes: 0,
          responseCount: 0,
          activeResponses: 0,
          retired: false,
        };
        this.mediaCaches.set(cacheKey, cache);
        closeSync(fd);
        fd = null;
      }
      const responseFd = openSync(`/proc/self/fd/${cache.fd}`, constants.O_RDONLY);
      const responseDeadlineAtMs = Date.now() + MEDIA_RESPONSE_LIFETIME_MS;
      const responseLease = {
        fd: responseFd,
        sizeBytes: cache.sizeBytes,
        mimeType: "video/mp4" as const,
        expectedRevision: cache.expectedRevision,
      };
      assertBlindEvaluationMediaLeaseIntegrity(responseLease, false);
      let reserved = false;
      let released = false;
      return {
        ...responseLease,
        responseDeadlineAtMs,
        reserveResponseBytes: (bytes: number) => {
          if (reserved || released || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > cache!.sizeBytes) {
            throw new BlindEvaluationConflictError("Die v5-Media-Range-Reservation ist ungültig.");
          }
          const currentMs = Date.now();
          if (cache!.retired || currentMs > cache!.expiresAtMs || currentMs > responseDeadlineAtMs
            || cache!.activeResponses >= MEDIA_CACHE_MAX_CONCURRENT_RESPONSES
            || cache!.responseCount >= MEDIA_CACHE_MAX_REQUESTS
            || cache!.reservedResponseBytes + bytes > cache!.maximumResponseBytes) {
            throw new BlindEvaluationConflictError("Das begrenzte v5-Media-Lease-/Range-Budget ist erschöpft.", 429);
          }
          cache!.activeResponses += 1;
          cache!.responseCount += 1;
          cache!.reservedResponseBytes += bytes;
          reserved = true;
          try {
            this.reservePersistentMediaBudget(record, channel, bytes, accessedAt);
            this.recordMediaAccess(record, channel, accessedAt);
          } catch (error) {
            cache!.activeResponses -= 1;
            cache!.responseCount -= 1;
            cache!.reservedResponseBytes -= bytes;
            reserved = false;
            throw error;
          }
        },
        releaseResponse: () => {
          if (released) return;
          released = true;
          if (reserved) cache!.activeResponses = Math.max(0, cache!.activeResponses - 1);
        },
      };
    } catch (error) {
      if (fd !== null) closeSync(fd);
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError("Der private v5-Blind-Snapshot kann nicht sicher geöffnet werden.");
    }
  }

  async submit(
    id: string,
    credential: string,
    input: BlindEvaluationSubmissionInput,
    initialPinValue: BlindEvaluationInitialPin,
    experiment: ControlledExperiment,
    idempotencyKey: string,
    submittedAt = new Date().toISOString(),
    browserSubmissionPinValue?: BlindEvaluationSubmissionPin,
  ): Promise<BlindEvaluationPublic> {
    if (this.submitting.has(id)) {
      throw new BlindEvaluationConflictError("Diese v5-Blindbewertung wird bereits gespeichert.");
    }
    this.submitting.add(id);
    try {
      const submission = blindEvaluationSubmissionInputSchema.parse(input);
      const initialPin = blindEvaluationInitialPinSchema.parse(initialPinValue);
      if (!/^[0-9a-f]{64}$/.test(idempotencyKey)) {
        throw new BlindEvaluationConflictError("Blind-v5-Submit benötigt einen 64-stelligen Idempotency-Key.", 412);
      }
      const submissionInputSha256 = digestCanonical({ submission, initialPin });
      const record = this.requireAuthorized(id, credential);
      const browserSubmissionPin = blindEvaluationSubmissionPinSchema.parse(
        browserSubmissionPinValue ?? {
          schemaVersion: "ltx-studio-blind-evaluation-browser-submission-pin.v5",
          sessionId: id,
          commitment: record.commitment,
          idempotencyKey,
          initialPinSha256: digestCanonical(initialPin),
          submissionInputSha256,
          pinnedAt: submittedAt,
        },
      );
      if (browserSubmissionPin.sessionId !== id
        || browserSubmissionPin.commitment !== record.commitment
        || browserSubmissionPin.idempotencyKey !== idempotencyKey
        || browserSubmissionPin.initialPinSha256 !== digestCanonical(initialPin)
        || browserSubmissionPin.submissionInputSha256 !== submissionInputSha256) {
        throw new BlindEvaluationConflictError(
          "Der dauerhafte Browser-Submission-Pin stimmt nicht mit Session, Eingabe, Idempotency-Key und initialem Pin überein.",
          412,
        );
      }
      const existingTerminal = this.readTerminal(id);
      if (existingTerminal?.outcome === "submitted") {
        if (existingTerminal.submissionPreimage.idempotencyKey === idempotencyKey
          && existingTerminal.submissionPreimage.submissionInputSha256 === submissionInputSha256) {
          this.minimizeTerminalPrivateMedia(record);
          this.completeTerminalRelease(id);
          return this.toPublic(record);
        }
        throw new BlindEvaluationConflictError("Der v5-Submit-Idempotency-Key oder Eingabedigest steht im Konflikt mit dem dauerhaften Reveal.");
      }
      if (existingTerminal) {
        throw new BlindEvaluationConflictError("Die v5-Blind-Session ist bereits terminal abgeschlossen.");
      }
      const active = this.toPublic(record);
      const actualPublicStateSha256 = digestCanonical(blindEvaluationInitialPublicState(active));
      if (initialPin.id !== id || initialPin.commitment !== record.commitment
        || initialPin.publicStateSha256 !== actualPublicStateSha256) {
        throw new BlindEvaluationConflictError("Initialer Browser-Pin und v5-Session stimmen nicht überein.", 412);
      }
      if (experiment.status !== "frozen" || experiment.id !== record.commitmentPreimage.experimentId
        || experiment.protocolSha256 !== record.commitmentPreimage.protocolSha256) {
        throw new BlindEvaluationConflictError("Experiment und v5-Blind-Session sind nicht mehr identisch gebunden.");
      }
      this.assertSnapshots(record);
      const accessX = this.readMediaAccess(id, "x");
      const accessY = this.readMediaAccess(id, "y");
      if (!accessX || !accessY) {
        throw new BlindEvaluationConflictError("Beide privaten v5-Blind-Snapshots müssen vor der Abgabe geladen werden.");
      }
      if (accessX.commitment !== record.commitment || accessY.commitment !== record.commitment) {
        throw new BlindEvaluationConflictError("Der Medienzugriff ist nicht an dieses v5-Commitment gebunden.");
      }
      const timelineRequirements = record.commitmentPreimage.requirements.timelineCoverage;
      const latestMediaAccessMs = Math.max(Date.parse(accessX.accessedAt), Date.parse(accessY.accessedAt));
      const minimumReviewWallTimeMs = timelineRequirements.minimumReviewWallTimeSeconds * 1_000;
      const pinnedAtMs = Date.parse(browserSubmissionPin.pinnedAt);
      const submittedAtMs = Date.parse(submittedAt);
      if (!Number.isFinite(pinnedAtMs) || pinnedAtMs < latestMediaAccessMs || pinnedAtMs > submittedAtMs) {
        throw new BlindEvaluationConflictError(
          "Der dauerhafte Browser-Submission-Pin wurde nicht nach beiden Medienzugriffen und vor dem serverseitigen Submit fixiert.",
          412,
        );
      }
      if (submittedAtMs - latestMediaAccessMs + 1e-6 < minimumReviewWallTimeMs) {
        throw new BlindEvaluationConflictError(
          `Die serverseitige Mindestprüfzeit von ${(minimumReviewWallTimeMs / 1_000).toFixed(1)} Sekunden ist noch nicht erreicht.`,
        );
      }
      const expectedDurationMilliseconds = Math.round(
        record.commitmentPreimage.normalization.target.durationSeconds * 1_000,
      );
      const requiredCoverage = [
        ["normalSpeed", timelineRequirements.normalMinimumRatio],
        ["halfSpeed", timelineRequirements.halfMinimumRatio],
        ["audibleNormalSpeed", timelineRequirements.audibleNormalMinimumRatio],
        ["audibleHalfSpeed", timelineRequirements.audibleHalfMinimumRatio],
      ] as const;
      for (const channel of ["x", "y"] as const) {
        const playback = submission.playback[channel];
        if (playback.durationMilliseconds !== expectedDurationMilliseconds) {
          throw new BlindEvaluationConflictError(
            `Die gebundene Mediendauer der Playback-Coverage von ${channel.toUpperCase()} widerspricht dem v5-Commitment.`,
          );
        }
        for (const [field, minimumRatio] of requiredCoverage) {
          const coverage = playback[field];
          if (coverage.coverageRatio + 1e-9 < minimumRatio
            || (timelineRequirements.endedRequired && !coverage.ended)) {
            throw new BlindEvaluationConflictError(
              `X und Y müssen die eindeutige, hörbare Timeline-Coverage bei 1× und 0,5× vollständig nachweisen.`,
            );
          }
        }
      }
      const submissionPreimage = blindEvaluationSubmissionPreimageSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-submission.v5",
        sessionId: id,
        commitment: record.commitment,
        idempotencyKey,
        submissionInputSha256,
        initialPublicStateSha256: initialPin.publicStateSha256,
        browserSubmissionPin,
        mediaAccessedAt: { x: accessX.accessedAt, y: accessY.accessedAt },
        submittedAt,
        submission,
      });
      const stored = blindEvaluationSubmissionRecordSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-submission-record.v5",
        outcome: "submitted",
        sessionId: id,
        submissionSha256: digestCanonical(submissionPreimage),
        submissionPreimage,
      });
      this.fault?.("before-terminal-write");
      try {
        writeImmutableJson(this.terminalPath(id), stored, MAX_SUBMISSION_RECORD_BYTES);
      } catch (error) {
        const concurrent = this.readTerminal(id);
        if (concurrent?.outcome === "submitted"
          && concurrent.submissionPreimage.idempotencyKey === idempotencyKey
          && concurrent.submissionPreimage.submissionInputSha256 === submissionInputSha256) {
          this.minimizeTerminalPrivateMedia(record);
          this.completeTerminalRelease(id);
          return this.toPublic(record);
        }
        throw error;
      }
      this.minimizeTerminalPrivateMedia(record);
      this.releaseGlobalLock(id);
      return this.toPublic(record);
    } finally {
      this.submitting.delete(id);
    }
  }

  abort(
    id: string,
    credential: string,
    revokedAt = new Date().toISOString(),
  ): void {
    const record = this.read(id);
    if (!record) {
      const reservation = this.requireReservation(id, credential);
      const claimed = this.readClaim(id) !== null;
      if (claimed) {
        const cancellation = blindEvaluationCreationOutcomeSchema.parse({
          schemaVersion: "ltx-studio-blind-evaluation-creation-outcome.v5",
          id,
          outcome: "cancel",
          cancelledAt: revokedAt,
          reason: "evaluator-abort",
        });
        const existing = this.readCreationOutcome(id);
        if (existing?.outcome === "publish") {
          throw new BlindEvaluationConflictError(
            "Der v5-Publish-Intent ist bereits dauerhaft gewonnen; die Erstellung kann nicht mehr abgebrochen werden.",
          );
        }
        if (!existing) {
          try {
            writeImmutableJson(this.creationOutcomePath(id), cancellation);
          } catch (error) {
            const concurrent = this.readCreationOutcome(id);
            if (concurrent?.outcome === "publish") {
              throw new BlindEvaluationConflictError(
                "Der v5-Publish-Intent gewann gleichzeitig; die Erstellung kann nicht mehr abgebrochen werden.",
              );
            }
            if (concurrent?.outcome !== "cancel") throw error;
          }
        }
        this.materializationControllers.get(id)?.abort();
      } else {
        this.revokeReservation(reservation, "evaluator-abort", revokedAt);
        const lock = this.readGlobalLock();
        if (lock?.sessionId === id) this.releaseGlobalLock(id);
      }
      return;
    }
    const authorized = this.requireAuthorized(id, credential, true);
    const terminal = blindEvaluationTerminalRecordSchema.parse({
      schemaVersion: "ltx-studio-blind-evaluation-revocation-record.v5",
      outcome: "revoked",
      sessionId: id,
      commitment: authorized.commitment,
      revokedAt,
      reason: "evaluator-abort",
    });
    this.fault?.("before-terminal-write");
    writeImmutableJson(this.terminalPath(id), terminal, MAX_SUBMISSION_RECORD_BYTES);
    this.minimizeTerminalPrivateMedia(authorized);
    this.releaseGlobalLock(id);
  }

  private toPublic(record: BlindEvaluationRecord): BlindEvaluationPublic {
    this.assertRecordIntegrity(record);
    const base = {
      schemaVersion: "ltx-studio-blind-evaluation-public.v5" as const,
      id: record.id,
      claimScope: "development" as const,
      createdAt: record.commitmentPreimage.createdAt,
      commitment: record.commitment,
      evaluatorScope: {
        role: "blind-evaluator" as const,
        transport: "httponly-samesite-strict-session-cookie" as const,
      },
      media: {
        x: `/api/blind-evaluations/${record.id}/media/x`,
        y: `/api/blind-evaluations/${record.id}/media/y`,
      },
      requirements: {
        speeds: record.commitmentPreimage.requirements.speeds,
        bothMediaRequired: record.commitmentPreimage.requirements.bothMediaRequired,
        bothAudioRequired: record.commitmentPreimage.requirements.bothAudioRequired,
        evidenceNature: record.commitmentPreimage.requirements.evidenceNature,
        transportProfile: record.commitmentPreimage.requirements.transportProfile,
        timelineCoverage: record.commitmentPreimage.requirements.timelineCoverage,
      },
      threatModel: BLIND_EVALUATION_THREAT_MODEL,
      limitation: BLIND_EVALUATION_LIMITATION,
    };
    const terminal = this.readTerminal(record.id);
    if (!terminal) return blindEvaluationPublicSchema.parse({ ...base, status: "active", reveal: null });
    if (terminal.outcome === "revoked") {
      throw new BlindEvaluationConflictError("Die v5-Blind-Session wurde unwiderruflich abgebrochen.", 404);
    }
    const submission = terminal;
    if (submission.submissionPreimage.commitment !== record.commitment) {
      throw new BlindEvaluationConflictError("Die Submission ist nicht an dieses v5-Commitment gebunden.");
    }
    return blindEvaluationPublicSchema.parse({
      ...base,
      status: "submitted",
      reveal: {
        commitmentPreimage: record.commitmentPreimage,
        submissionPreimage: submission.submissionPreimage,
        submissionSha256: submission.submissionSha256,
      },
    });
  }

  private toCreatingPublic(
    reservation: BlindEvaluationReservation,
    claim: BlindEvaluationClaimRecord | null,
  ): BlindEvaluationPublic {
    return blindEvaluationCreatingPublicSchema.parse({
      schemaVersion: "ltx-studio-blind-evaluation-public.v5",
      id: reservation.id,
      claimScope: "development",
      createdAt: reservation.createdAt,
      commitment: null,
      evaluatorScope: {
        role: "blind-evaluator",
        transport: "httponly-samesite-strict-session-cookie",
      },
      creation: {
        phase: claim ? "claimed" : "reserved",
        claimPath: `/api/blind-evaluations/${reservation.id}/claim`,
      },
      status: "creating",
      reveal: null,
      threatModel: BLIND_EVALUATION_THREAT_MODEL,
      limitation: BLIND_EVALUATION_LIMITATION,
    });
  }

  private forExperiment(experimentId: string, protocolSha256: string): BlindEvaluationRecord | null {
    const matches = this.v5SessionIds()
      .flatMap((id) => {
        const record = this.read(id);
        const terminal = record ? this.readTerminal(record.id) : null;
        return record && !terminal && record.commitmentPreimage.experimentId === experimentId
          && record.commitmentPreimage.protocolSha256 === protocolSha256 ? [record] : [];
      });
    if (matches.length > 1) {
      throw new BlindEvaluationConflictError("Mehrere aktive v5-Blind-Sessions beanspruchen dasselbe Experimentprotokoll.");
    }
    return matches[0] ?? null;
  }

  private v5SessionIds(): string[] {
    const entries = readdirSync(this.sessionsRoot, { withFileTypes: true });
    if (entries.length > MAX_SESSION_FILES) {
      throw new BlindEvaluationConflictError("Der v5-Blind-Evaluation-Speicher enthält unzulässig viele Einträge.");
    }
    return entries
      .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
      .map((entry) => entry.name);
  }

  private reservationIds(): string[] {
    const entries = readdirSync(this.reservationsRoot, { withFileTypes: true });
    if (entries.length > MAX_SESSION_FILES) {
      throw new BlindEvaluationConflictError("Der v5-Reservation-Speicher enthält unzulässig viele Einträge.");
    }
    return entries
      .filter((entry) => entry.isDirectory() && /^[0-9a-f-]{36}$/i.test(entry.name))
      .map((entry) => entry.name);
  }

  private readReservation(id: string): BlindEvaluationReservation | null {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const path = this.reservationPath(id);
    if (!existsSync(path)) return null;
    try {
      const reservation = blindEvaluationReservationSchema.parse(
        readBoundedJson(path, MAX_RESERVATION_RECORD_BYTES),
      );
      if (reservation.id !== id
        || digestCredential(reservation.evaluatorScopeCredential)
          !== reservation.evaluatorScopeCredentialSha256) {
        throw new BlindEvaluationConflictError("Eine v5-Reservation ist nicht capability-konsistent.");
      }
      return reservation;
    } catch (error) {
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError("Eine v5-Reservation ist beschädigt.");
    }
  }

  private readCreationIndex(
    creationRequestId: string,
  ): z.infer<typeof blindEvaluationCreationIndexSchema> | null {
    if (!/^[0-9a-f]{64}$/.test(creationRequestId)) return null;
    const path = this.creationIndexPath(creationRequestId);
    if (!existsSync(path)) return null;
    try {
      const index = blindEvaluationCreationIndexSchema.parse(
        readBoundedJson(path, MAX_RESERVATION_RECORD_BYTES),
      );
      if (index.creationRequestId !== creationRequestId) {
        throw new BlindEvaluationConflictError("Ein v5-Creation-Index ist nicht an seinen Dateinamen gebunden.");
      }
      return index;
    } catch (error) {
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError("Ein v5-Creation-Index ist beschädigt.");
    }
  }

  private resolveIndexedCreation(
    index: z.infer<typeof blindEvaluationCreationIndexSchema>,
    experiment: ControlledExperiment,
    providedCredential?: string,
  ): { evaluation: BlindEvaluationPublic; credential: string; creationToken: string | null } {
    if (index.experimentId !== experiment.id || index.protocolSha256 !== experiment.protocolSha256) {
      throw new BlindEvaluationConflictError("Eine Creation-Request-ID ist bereits an ein anderes v5-Protokoll gebunden.");
    }
    const record = this.read(index.reservationId);
    if (record) {
      if (record.creationRequestId !== index.creationRequestId
        || record.commitmentPreimage.experimentId !== index.experimentId
        || record.commitmentPreimage.protocolSha256 !== index.protocolSha256
        || record.commitmentPreimage.evaluatorScopeCredentialSha256
          !== index.evaluatorScopeCredentialSha256
        || record.commitmentPreimage.creationTokenSha256 !== index.creationTokenSha256
        || !providedCredential
        || !credentialsEqual(providedCredential, index.evaluatorScopeCredentialSha256)) {
        throw new BlindEvaluationConflictError(
          "Eine bereits quellengebundene v5-Creation-Request-ID wird niemals neu ausgegeben.",
        );
      }
      return {
        evaluation: this.toPublic(record),
        credential: providedCredential,
        creationToken: null,
      };
    }
    const reservation = this.readReservation(index.reservationId);
    if (!reservation
      || reservation.creationRequestId !== index.creationRequestId
      || reservation.experimentId !== index.experimentId
      || reservation.protocolSha256 !== index.protocolSha256
      || reservation.evaluatorScopeCredentialSha256 !== index.evaluatorScopeCredentialSha256
      || reservation.creationTokenSha256 !== index.creationTokenSha256) {
      throw new BlindEvaluationConflictError(
        "Der dauerhafte v5-Creation-Index verweist auf keine intakte Reservation; die ID bleibt gesperrt.",
      );
    }
    const claim = this.readClaim(reservation.id);
    const outcome = this.readCreationOutcome(reservation.id);
    if (outcome?.outcome === "cancel") {
      throw new BlindEvaluationConflictError("Die v5-Creation-Request-ID wurde unwiderruflich abgebrochen.");
    }
    if (!providedCredential
      || !credentialsEqual(providedCredential, reservation.evaluatorScopeCredentialSha256)) {
      throw new BlindEvaluationConflictError(
        "Eine bestehende v5-Reservation wird ohne ihre bereits gesetzte Capability nicht neu ausgegeben.",
      );
    }
    const creationToken = reservationCreationToken(
      reservation.id,
      reservation.evaluatorScopeCredential,
      reservation.creationRequestId,
    );
    if (!credentialsEqual(creationToken, reservation.creationTokenSha256)) {
      throw new BlindEvaluationConflictError("Die v5-Creation-Autorität ist nicht mehr aus ihrer dauerhaften Bindung ableitbar.");
    }
    return {
      evaluation: this.toCreatingPublic(reservation, claim),
      credential: reservation.evaluatorScopeCredential,
      creationToken: claim || outcome ? null : creationToken,
    };
  }

  private readClaim(id: string): BlindEvaluationClaimRecord | null {
    const path = this.claimPath(id);
    if (!existsSync(path)) return null;
    try {
      const claim = blindEvaluationClaimRecordSchema.parse(
        readBoundedJson(path, MAX_RESERVATION_RECORD_BYTES),
      );
      if (claim.id !== id) throw new BlindEvaluationConflictError("Ein v5-Claim ist nicht an seine Reservation gebunden.");
      const reservation = this.readReservation(id);
      if (!reservation || claim.creationTokenSha256 !== reservation.creationTokenSha256) {
        throw new BlindEvaluationConflictError("Ein v5-Claim ist nicht an die Creation-Autorität seiner Reservation gebunden.");
      }
      return claim;
    } catch (error) {
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError("Ein v5-Claim ist beschädigt.");
    }
  }

  private requireReservation(id: string, credential: string): BlindEvaluationReservation {
    const reservation = this.readReservation(id);
    if (!reservation || !credentialsEqual(credential, reservation.evaluatorScopeCredentialSha256)) {
      throw new BlindEvaluationConflictError("v5-Blind-Reservation nicht gefunden.", 404);
    }
    return reservation;
  }

  private readGlobalLock(allowReleaseLink = false): BlindEvaluationGlobalLock | null {
    if (!existsSync(this.globalLockPath)) return null;
    try {
      const fd = openSync(this.globalLockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const held = readHeldRegularFileDescriptor(
          fd,
          MAX_GLOBAL_LOCK_BYTES,
          true,
          allowReleaseLink ? [1, 2] : [1],
        );
        return blindEvaluationGlobalLockSchema.parse(JSON.parse(held.raw.toString("utf8")) as unknown);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError("Der persistente globale v5-Evaluator-Lock ist beschädigt.");
    }
  }

  private acquireGlobalLock(reservation: BlindEvaluationReservation): void {
    const desired = blindEvaluationGlobalLockSchema.parse({
      schemaVersion: "ltx-studio-blind-evaluation-global-lock.v5",
      sessionId: reservation.id,
      evaluatorScopeCredentialSha256: reservation.evaluatorScopeCredentialSha256,
      lockNonce: reservation.lockNonce,
      createdAt: reservation.createdAt,
    });
    const existing = this.readGlobalLock();
    if (existing) {
      if (existing.sessionId === reservation.id
        && existing.evaluatorScopeCredentialSha256 === reservation.evaluatorScopeCredentialSha256
        && existing.lockNonce === reservation.lockNonce) return;
      throw new BlindEvaluationConflictError("Der persistente globale v5-Evaluator-Lock ist bereits belegt.");
    }
    try {
      writeImmutableJson(this.globalLockPath, desired);
    } catch (error) {
      const concurrent = this.readGlobalLock();
      if (concurrent?.sessionId === reservation.id
        && concurrent.evaluatorScopeCredentialSha256 === reservation.evaluatorScopeCredentialSha256
        && concurrent.lockNonce === reservation.lockNonce) return;
      throw error;
    }
  }

  private activateGlobalLock(reservation: BlindEvaluationReservation): void {
    const existing = this.readGlobalLock();
    if (!existing || existing.sessionId !== reservation.id
      || existing.evaluatorScopeCredentialSha256 !== reservation.evaluatorScopeCredentialSha256
      || existing.lockNonce !== reservation.lockNonce) {
      throw new BlindEvaluationConflictError("Der v5-Publish besitzt keinen identisch gebundenen globalen Lock.");
    }
  }

  private releaseGlobalLock(id: string): void {
    let heldFd: number | null = null;
    let markerFd: number | null = null;
    let currentFd: number | null = null;
    let guardPath: string | null = null;
    let guardOwned = false;
    try {
      try {
        heldFd = openSync(this.globalLockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return;
        throw error;
      }
      const held = readHeldRegularFileDescriptor(heldFd, MAX_GLOBAL_LOCK_BYTES, true, [1, 2]);
      const lock = blindEvaluationGlobalLockSchema.parse(JSON.parse(held.raw.toString("utf8")) as unknown);
      if (lock.sessionId !== id) {
        throw new BlindEvaluationConflictError("Ein fremder globaler v5-Evaluator-Lock darf nicht freigegeben werden.");
      }
      const markerPath = this.lockReleasePath(lock.lockNonce);
      guardPath = this.lockReleaseGuardPath(lock.lockNonce);
      for (let attempt = 0; attempt < 3 && !guardOwned; attempt += 1) {
        try {
          writeImmutableJson(guardPath, blindEvaluationLockReleaseGuardSchema.parse({
            schemaVersion: "ltx-studio-blind-evaluation-lock-release-guard.v5",
            sessionId: id,
            lockNonce: lock.lockNonce,
            owner: currentReservationOwner(),
          }));
          guardOwned = true;
        } catch (error) {
          const existingGuard = blindEvaluationLockReleaseGuardSchema.parse(
            readBoundedJson(guardPath, MAX_GLOBAL_LOCK_BYTES),
          );
          if (existingGuard.sessionId !== id || existingGuard.lockNonce !== lock.lockNonce) {
            throw new BlindEvaluationConflictError("Ein v5-Lock-Release-Guard ist nonce-widersprüchlich.");
          }
          if (reservationOwnerAlive(existingGuard.owner)) return;
          unlinkDurably(guardPath);
          if (attempt === 2) throw error;
        }
      }
      if (!guardOwned) return;
      try {
        linkSync(this.globalLockPath, markerPath);
        fsyncDirectory(this.lockReleasesRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }
      markerFd = openSync(markerPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const markerStats = fstatSync(markerFd);
      const heldAfterLink = fstatSync(heldFd);
      if (markerStats.dev !== held.stats.dev || markerStats.ino !== held.stats.ino
        || heldAfterLink.dev !== held.stats.dev || heldAfterLink.ino !== held.stats.ino
        || markerStats.nlink < 2 || heldAfterLink.nlink < 2) {
        throw new BlindEvaluationConflictError("Der globale v5-Lock wechselte vor dem CAS-Release seinen Inode.");
      }
      currentFd = openSync(this.globalLockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const currentStats = fstatSync(currentFd);
      if (currentStats.dev !== held.stats.dev || currentStats.ino !== held.stats.ino) {
        throw new BlindEvaluationConflictError("Der globale v5-Lock wechselte während des CAS-Release seinen Inode.");
      }
      this.fault?.("after-lock-release-link");
      unlinkSync(this.globalLockPath);
      fsyncDirectory(this.v5Root);
    } catch (error) {
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError(
        `Der globale v5-Lock konnte nicht CAS-sicher freigegeben werden: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (currentFd !== null) closeSync(currentFd);
      if (markerFd !== null) closeSync(markerFd);
      if (heldFd !== null) closeSync(heldFd);
      if (guardOwned && guardPath && existsSync(guardPath)) {
        try { unlinkDurably(guardPath); } catch { /* The retained lock tombstone remains fail-closed. */ }
      }
    }
  }

  private completeTerminalRelease(id: string): void {
    const current = this.readGlobalLock(true);
    if (!current || current.sessionId !== id) {
      // A different current lock proves this terminal session's unique old link is already gone.
      return;
    }
    this.releaseGlobalLock(id);
  }

  private stagingEntries(): Array<{ name: string; path: string; sessionId: string }> {
    const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
    const pattern = new RegExp(`^\\.staging-(${uuid})-(${uuid})$`, "i");
    return readdirSync(this.sessionsRoot, { withFileTypes: true }).flatMap((entry) => {
      const nameMatch = pattern.exec(entry.name);
      if (nameMatch && (!entry.isDirectory() || entry.isSymbolicLink())) {
        throw new BlindEvaluationConflictError("Ein benanntes v5-Staging ist kein pfadsicheres Verzeichnis.");
      }
      const matched = entry.isDirectory() ? nameMatch : null;
      return matched ? [{
        name: entry.name,
        path: safeChildPath(this.sessionsRoot, entry.name),
        sessionId: matched[1]!,
      }] : [];
    });
  }

  private quarantineStaging(
    staging: { name: string; path: string; sessionId: string },
    reason: z.infer<typeof blindEvaluationQuarantineRecordSchema>["reason"],
    publishRecordSha256: string | null,
  ): void {
    if (!existsSync(staging.path)) return;
    const stagingDetails = lstatSync(staging.path);
    if (stagingDetails.isSymbolicLink() || !stagingDetails.isDirectory()) {
      throw new BlindEvaluationConflictError("Ein v5-Staging kann nicht symlink- oder pfadunsicher quarantänisiert werden.");
    }
    const markerPath = safeChildPath(staging.path, "quarantine.v5.json");
    let record: z.infer<typeof blindEvaluationQuarantineRecordSchema>;
    if (existsSync(markerPath)) {
      record = blindEvaluationQuarantineRecordSchema.parse(
        readBoundedJson(markerPath, MAX_RESERVATION_RECORD_BYTES),
      );
      if (record.sessionId !== staging.sessionId || record.stagingName !== staging.name) {
        throw new BlindEvaluationConflictError("Ein vorbereiteter v5-Quarantänemarker widerspricht seinem Staging.");
      }
    } else {
      const quarantineName = `${staging.name.slice(1)}-${randomUUID()}`;
      record = blindEvaluationQuarantineRecordSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-quarantine.v5",
        quarantineName,
        sessionId: staging.sessionId,
        stagingName: staging.name,
        quarantinedAt: new Date().toISOString(),
        reason,
        publishRecordSha256,
      });
      // The marker is durable inside the source directory before rename.  A
      // crash at any later instruction therefore cannot create an unbounded,
      // markerless private quarantine directory.
      writeImmutableJson(markerPath, record, MAX_RESERVATION_RECORD_BYTES);
      fsyncDirectory(staging.path);
    }
    const target = safeChildPath(this.quarantineRoot, record.quarantineName);
    if (existsSync(target)) {
      throw new BlindEvaluationConflictError("Das vorbereitete v5-Quarantäneziel ist bereits belegt.");
    }
    chmodSync(staging.path, 0o700);
    renameSync(staging.path, target);
    fsyncDirectory(this.sessionsRoot);
    fsyncDirectory(this.quarantineRoot);
    this.fault?.("after-quarantine-rename");
  }

  private promoteVerifiedStaging(
    staging: { name: string; path: string; sessionId: string },
    reservation: BlindEvaluationReservation,
    outcome: Extract<z.infer<typeof blindEvaluationCreationOutcomeSchema>, { outcome: "publish" }>,
  ): BlindEvaluationRecord {
    const entries = readdirSync(staging.path, { withFileTypes: true });
    const exactNames = entries.map((entry) => entry.name).sort();
    if (entries.some((entry) => !entry.isFile())
      || canonicalBlindEvaluationJson(exactNames)
        !== canonicalBlindEvaluationJson(["session.v5.json", "x.snapshot.v5.mp4", "y.snapshot.v5.mp4"])) {
      throw new BlindEvaluationConflictError("Ein v5-Publish-Staging besitzt nicht exakt die drei gebundenen Artefakte.");
    }
    const record = blindEvaluationRecordSchema.parse(readBoundedJson(
      safeChildPath(staging.path, "session.v5.json"),
      MAX_SESSION_RECORD_BYTES,
    ));
    this.assertRecordIntegrity(record);
    if (record.id !== staging.sessionId || record.id !== reservation.id
      || record.creationRequestId !== reservation.creationRequestId
      || record.commitmentPreimage.experimentId !== reservation.experimentId
      || record.commitmentPreimage.protocolSha256 !== reservation.protocolSha256
      || record.commitmentPreimage.evaluatorScopeCredentialSha256
        !== reservation.evaluatorScopeCredentialSha256
      || record.commitmentPreimage.creationTokenSha256 !== reservation.creationTokenSha256
      || record.privateState.lockNonce !== reservation.lockNonce
      || outcome.id !== record.id
      || outcome.recordSha256 !== digestCanonical(record)) {
      throw new BlindEvaluationConflictError("Publish-Intent, Reservation und v5-Staging-Record sind nicht identisch gebunden.");
    }
    this.assertSnapshotsInDirectory(record, staging.path);
    const finalDirectory = this.sessionDirectory(record.id);
    if (existsSync(finalDirectory)) {
      throw new BlindEvaluationConflictError("Das finale v5-Sessionziel ist während Recovery bereits belegt.");
    }
    renameSync(staging.path, finalDirectory);
    fsyncDirectory(this.sessionsRoot);
    return record;
  }

  private recoverPublishStaging(): void {
    const entries = this.stagingEntries();
    const counts = new Map<string, number>();
    for (const entry of entries) counts.set(entry.sessionId, (counts.get(entry.sessionId) ?? 0) + 1);
    for (const staging of entries) {
      let reservation: BlindEvaluationReservation | null = null;
      let claim: BlindEvaluationClaimRecord | null = null;
      let outcome: z.infer<typeof blindEvaluationCreationOutcomeSchema> | null = null;
      try {
        reservation = this.readReservation(staging.sessionId);
        claim = reservation ? this.readClaim(staging.sessionId) : null;
        if (existsSync(safeChildPath(staging.path, "quarantine.v5.json"))) {
          // A durable pre-rename marker is an already decided quarantine
          // transition. Complete it even if a synthetic crash left an owner
          // PID alive in the current test process.
          this.quarantineStaging(staging, "invalid-publish-intent", null);
          if (reservation) this.revokeReservation(reservation, "creation-interrupted");
          const lock = this.readGlobalLock(true);
          if (lock?.sessionId === staging.sessionId) this.releaseGlobalLock(staging.sessionId);
          continue;
        }
        if (reservation && reservationOwnerAlive(claim?.owner ?? reservation.owner)) continue;
        outcome = reservation ? this.readCreationOutcome(staging.sessionId) : null;
        if ((counts.get(staging.sessionId) ?? 0) !== 1) {
          this.quarantineStaging(staging, "ambiguous-staging", outcome?.outcome === "publish" ? outcome.recordSha256 : null);
        } else if (!reservation || !claim || !outcome) {
          this.quarantineStaging(staging, "missing-publish-intent", null);
        } else if (outcome.outcome !== "publish") {
          this.quarantineStaging(staging, "invalid-publish-intent", null);
        } else {
          try {
            this.promoteVerifiedStaging(staging, reservation, outcome);
            this.removeReservationDirectory(staging.sessionId);
            continue;
          } catch {
            const reason = existsSync(this.sessionDirectory(staging.sessionId))
              ? "final-directory-conflict" as const
              : "invalid-published-bytes" as const;
            this.quarantineStaging(staging, reason, outcome.recordSha256);
          }
        }
      } catch {
        this.quarantineStaging(
          staging,
          "invalid-publish-intent",
          outcome?.outcome === "publish" ? outcome.recordSha256 : null,
        );
      }
      if (reservation) this.revokeReservation(reservation, "creation-interrupted");
      const lock = this.readGlobalLock(true);
      if (lock?.sessionId === staging.sessionId) this.releaseGlobalLock(staging.sessionId);
    }
  }

  private recoverReservations(): void {
    for (const id of this.reservationIds()) {
      const reservation = this.readReservation(id);
      if (!reservation) continue;
      if (this.read(id)) {
        this.removeReservationDirectory(id);
        continue;
      }
      const claim = this.readClaim(id);
      const owner = claim?.owner ?? reservation.owner;
      if (!reservationOwnerAlive(owner)) {
        this.revokeReservation(reservation, claim ? "creation-interrupted" : "unclaimed-restart");
        if (claim) this.releaseGlobalLock(id);
      }
    }
  }

  private recoverGlobalLock(): void {
    const existing = this.readGlobalLock(true);
    if (existing) {
      const record = this.read(existing.sessionId);
      if (record) {
        const terminal = this.readTerminal(existing.sessionId);
        if (terminal) {
          this.releaseGlobalLock(existing.sessionId);
        }
        return;
      }
      if (this.readReservation(existing.sessionId)) return;
      if (this.readReservationRevocation(existing.sessionId)) {
        this.releaseGlobalLock(existing.sessionId);
        return;
      }
      throw new BlindEvaluationConflictError("Der persistente globale v5-Lock verweist auf keine dauerhafte Reservation oder Session.");
    }
    const activeSessions = this.v5SessionIds().flatMap((id) => {
      const record = this.read(id);
      return record && !this.readTerminal(id) ? [record] : [];
    });
    const claimedReservations = this.reservationIds().flatMap((id) => {
      const reservation = this.readReservation(id);
      return reservation && this.readClaim(id) ? [reservation] : [];
    });
    if (activeSessions.length + claimedReservations.length > 1) {
      throw new BlindEvaluationConflictError("Mehrere v5-Sessions beanspruchen den fehlenden globalen Lock.");
    }
    if (activeSessions[0]) {
      const record = activeSessions[0];
      writeImmutableJson(this.globalLockPath, blindEvaluationGlobalLockSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-global-lock.v5",
        sessionId: record.id,
        evaluatorScopeCredentialSha256: record.commitmentPreimage.evaluatorScopeCredentialSha256,
        lockNonce: record.privateState.lockNonce,
        createdAt: record.commitmentPreimage.createdAt,
      }));
    } else if (claimedReservations[0]) {
      this.acquireGlobalLock(claimedReservations[0]);
    }
  }

  private revokeReservation(
    reservation: BlindEvaluationReservation,
    reason: ReservationRevocationReason,
    revokedAt = new Date().toISOString(),
  ): void {
    const path = this.revocationPath(reservation.id);
    if (!existsSync(path)) {
      writeImmutableJson(path, reservationRevocationSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-reservation-revocation.v5",
        id: reservation.id,
        revokedAt,
        reason,
      }));
    }
    this.removeReservationDirectory(reservation.id);
  }

  private readReservationRevocation(id: string): z.infer<typeof reservationRevocationSchema> | null {
    const path = this.revocationPath(id);
    if (!existsSync(path)) return null;
    try {
      const revocation = reservationRevocationSchema.parse(
        readBoundedJson(path, MAX_RESERVATION_RECORD_BYTES),
      );
      if (revocation.id !== id) {
        throw new BlindEvaluationConflictError("Eine v5-Reservationssperre ist nicht an ihre ID gebunden.");
      }
      return revocation;
    } catch (error) {
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError("Eine v5-Reservationssperre ist beschädigt.");
    }
  }

  private assertReservationNotRevoked(id: string): void {
    if (this.readReservationRevocation(id) || this.readCreationOutcome(id)?.outcome === "cancel") {
      throw new BlindEvaluationConflictError(
        "Die v5-Reservation wurde während der Erstellung unwiderruflich abgebrochen.",
      );
    }
  }

  private readCreationOutcome(
    id: string,
  ): z.infer<typeof blindEvaluationCreationOutcomeSchema> | null {
    const path = this.creationOutcomePath(id);
    if (!existsSync(path)) return null;
    try {
      const outcome = blindEvaluationCreationOutcomeSchema.parse(
        readBoundedJson(path, MAX_RESERVATION_RECORD_BYTES),
      );
      if (outcome.id !== id) {
        throw new BlindEvaluationConflictError("Ein v5-Erstellungsergebnis ist nicht an seine ID gebunden.");
      }
      return outcome;
    } catch (error) {
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError("Ein v5-Erstellungsergebnis ist beschädigt.");
    }
  }

  private removeReservationDirectory(id: string): void {
    const directory = this.reservationDirectory(id);
    if (existsSync(directory)) {
      rmSync(directory, { recursive: true, force: true });
      fsyncDirectory(this.reservationsRoot);
    }
  }

  private assertExperimentReady(experiment: ControlledExperiment): void {
    if (experiment.status !== "frozen" || !experiment.protocolSha256
      || !experiment.arms[0].jobId || !experiment.arms[1].jobId) {
      throw new BlindEvaluationConflictError(
        "Nur ein eingefrorenes Experiment mit zwei gebundenen Armen kann verblindet bewertet werden.",
      );
    }
  }

  private assertRecordIntegrity(record: BlindEvaluationRecord): void {
    if (blindEvaluationCommitment(record) !== record.commitment
      || !/^[0-9a-f]{64}$/.test(record.privateState.lockNonce)) {
      throw new BlindEvaluationConflictError("Der v5-Blind-Session-Datensatz ist nicht mehr hashkonsistent.");
    }
  }

  private assertSnapshots(record: BlindEvaluationRecord): void {
    this.assertSnapshotsInDirectory(record, this.sessionDirectory(record.id));
  }

  private assertSnapshotsInDirectory(record: BlindEvaluationRecord, directory: string): void {
    for (const channel of ["x", "y"] as const) {
      const bound = record.privateState.snapshotRevisions[channel];
      let fd: number | null = null;
      try {
        fd = openSync(safeChildPath(directory, `${channel}.snapshot.v5.mp4`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        assertBlindEvaluationMediaLeaseIntegrity({
          fd,
          sizeBytes: bound.sizeBytes,
          mimeType: "video/mp4",
          expectedRevision: bound,
        });
        const stats = fstatSync(fd);
        if ((stats.mode & 0o222) !== 0) {
          throw new BlindEvaluationConflictError("Ein privater v5-Blind-Snapshot ist wieder beschreibbar.");
        }
      } catch (error) {
        if (error instanceof BlindEvaluationConflictError) throw error;
        throw new BlindEvaluationConflictError("Ein privater v5-Blind-Snapshot ist nicht mehr unverändert gebunden.");
      } finally {
        if (fd !== null) closeSync(fd);
      }
    }
  }

  private retireMediaCaches(id: string): void {
    for (const channel of ["x", "y"] as const) {
      const key = `${id}:${channel}`;
      const cache = this.mediaCaches.get(key);
      if (!cache) continue;
      cache.retired = true;
      closeSync(cache.fd);
      this.mediaCaches.delete(key);
    }
  }

  private minimizeTerminalPrivateMedia(record: BlindEvaluationRecord): void {
    this.retireMediaCaches(record.id);
    for (const channel of ["x", "y"] as const) {
      const path = this.snapshotPath(record.id, channel);
      if (!existsSync(path)) continue;
      let fd: number | null = null;
      try {
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        assertBlindEvaluationMediaLeaseIntegrity({
          fd,
          expectedRevision: record.privateState.snapshotRevisions[channel],
        });
        unlinkSync(path);
        if (fstatSync(fd).nlink !== 0) {
          throw new BlindEvaluationConflictError("Ein terminales v5-Privatmedium wurde nicht anonymisiert.");
        }
      } finally {
        if (fd !== null) closeSync(fd);
      }
    }
    fsyncDirectory(this.sessionDirectory(record.id));
  }

  private requireAuthorized(id: string, credential: string, activeOnly = false): BlindEvaluationRecord {
    const record = this.read(id);
    if (!record || !credentialsEqual(credential, record.commitmentPreimage.evaluatorScopeCredentialSha256)) {
      throw new BlindEvaluationConflictError("v5-Blind-Session nicht gefunden.", 404);
    }
    this.assertRecordIntegrity(record);
    const terminal = this.readTerminal(id);
    if (terminal?.outcome === "revoked") {
      throw new BlindEvaluationConflictError("v5-Blind-Session nicht gefunden.", 404);
    }
    if (activeOnly && terminal) {
      throw new BlindEvaluationConflictError("Die v5-Blind-Session ist bereits terminal abgeschlossen.");
    }
    return record;
  }

  private read(id: string): BlindEvaluationRecord | null {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const path = this.recordPath(id);
    if (!existsSync(path)) return null;
    try {
      return blindEvaluationRecordSchema.parse(readBoundedJson(path, MAX_SESSION_RECORD_BYTES));
    } catch (error) {
      if (error instanceof BlindEvaluationConflictError) throw error;
      throw new BlindEvaluationConflictError("v5-Blind-Session-Datensatz ist beschädigt.");
    }
  }

  private readTerminal(id: string): BlindEvaluationTerminalRecord | null {
    const path = this.terminalPath(id);
    if (!existsSync(path)) return null;
    const record = blindEvaluationTerminalRecordSchema.parse(
      readBoundedJson(path, MAX_SUBMISSION_RECORD_BYTES),
    );
    if (record.sessionId !== id
      || (record.outcome === "submitted" && (digestCanonical(record.submissionPreimage) !== record.submissionSha256
        || record.submissionPreimage.sessionId !== id))) {
      throw new BlindEvaluationConflictError("Der unveränderliche v5-Terminaldatensatz ist nicht hashkonsistent.");
    }
    return record;
  }

  private readMediaAccess(id: string, channel: BlindEvaluationChannel): BlindEvaluationMediaAccessRecord | null {
    const path = this.mediaAccessPath(id, channel);
    if (!existsSync(path)) return null;
    const record = blindEvaluationMediaAccessRecordSchema.parse(readBoundedJson(path, 16 * 1_024));
    if (record.sessionId !== id || record.channel !== channel) {
      throw new BlindEvaluationConflictError("Der unveränderliche v5-Medienzugriff ist widersprüchlich.");
    }
    return record;
  }

  private recordMediaAccess(
    record: BlindEvaluationRecord,
    channel: BlindEvaluationChannel,
    accessedAt: string,
  ): void {
    const existing = this.readMediaAccess(record.id, channel);
    if (existing) {
      if (existing.commitment !== record.commitment) {
        throw new BlindEvaluationConflictError("Der Medienzugriff ist nicht an dieses v5-Commitment gebunden.");
      }
      return;
    }
    const access = blindEvaluationMediaAccessRecordSchema.parse({
      schemaVersion: "ltx-studio-blind-evaluation-media-access.v5",
      sessionId: record.id,
      commitment: record.commitment,
      channel,
      accessedAt,
    });
    try {
      writeImmutableJson(this.mediaAccessPath(record.id, channel), access);
    } catch (error) {
      const concurrent = this.readMediaAccess(record.id, channel);
      if (concurrent?.commitment === record.commitment) return;
      throw error;
    }
  }

  private reservePersistentMediaBudget(
    record: BlindEvaluationRecord,
    channel: BlindEvaluationChannel,
    reservedBytes: number,
    reservedAt: string,
  ): void {
    const directory = safeChildPath(this.sessionDirectory(record.id), "media-budget.v5");
    if (!existsSync(directory)) {
      try {
        mkdirSync(directory, { mode: 0o700 });
        fsyncDirectory(this.sessionDirectory(record.id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
      }
    }
    const directoryStats = lstatSync(directory);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
      throw new BlindEvaluationConflictError("Das persistente v5-Media-Budget ist kein geschütztes Verzeichnis.");
    }
    chmodSync(directory, 0o700);
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.some((entry) => !entry.isFile()
      || !/^\d{3}\.media-budget\.v5\.json$/.test(entry.name))) {
      throw new BlindEvaluationConflictError("Das persistente v5-Media-Budget enthält fremde Einträge.");
    }
    const records = entries.map((entry, index) => {
      const expectedName = `${String(index).padStart(3, "0")}.media-budget.v5.json`;
      if (entry.name !== expectedName) {
        throw new BlindEvaluationConflictError("Das persistente v5-Media-Budget besitzt keine lückenlose Sequenz.");
      }
      const item = blindEvaluationMediaBudgetRecordSchema.parse(readBoundedJson(
        safeChildPath(directory, entry.name),
        MAX_MEDIA_BUDGET_RECORD_BYTES,
      ));
      if (item.sessionId !== record.id || item.commitment !== record.commitment || item.sequence !== index) {
        throw new BlindEvaluationConflictError("Ein persistenter v5-Media-Budgeteintrag ist nicht an Session und Commitment gebunden.");
      }
      return item;
    });
    const maximumSessionBytes = record.privateState.finalSizeBytes * MEDIA_CACHE_BYTE_MULTIPLIER * 2;
    const usedBytes = records.reduce((total, item) => total + item.reservedBytes, 0);
    if (records.length >= MEDIA_SESSION_MAX_REQUESTS
      || !Number.isSafeInteger(maximumSessionBytes)
      || !Number.isSafeInteger(usedBytes + reservedBytes)
      || usedBytes + reservedBytes > maximumSessionBytes) {
      throw new BlindEvaluationConflictError(
        "Das persistente, cache- und restartübergreifende v5-Media-Range-Budget ist erschöpft.",
        429,
      );
    }
    const sequence = records.length;
    writeImmutableJson(
      safeChildPath(directory, `${String(sequence).padStart(3, "0")}.media-budget.v5.json`),
      blindEvaluationMediaBudgetRecordSchema.parse({
        schemaVersion: "ltx-studio-blind-evaluation-media-budget.v5",
        sessionId: record.id,
        commitment: record.commitment,
        sequence,
        channel,
        reservedBytes,
        reservedAt,
      }),
      MAX_MEDIA_BUDGET_RECORD_BYTES,
    );
  }

  private recordPath(id: string): string {
    return safeChildPath(this.sessionDirectory(id), "session.v5.json");
  }

  private sessionDirectory(id: string): string {
    return safeChildPath(this.sessionsRoot, id);
  }

  private reservationDirectory(id: string): string {
    return safeChildPath(this.reservationsRoot, id);
  }

  private reservationPath(id: string): string {
    return safeChildPath(this.reservationDirectory(id), "reservation.v5.json");
  }

  private claimPath(id: string): string {
    return safeChildPath(this.reservationDirectory(id), "claim.v5.json");
  }

  private creationOutcomePath(id: string): string {
    return safeChildPath(this.reservationDirectory(id), "creation-outcome.v5.json");
  }

  private creationIndexPath(creationRequestId: string): string {
    return safeChildPath(this.creationIndexRoot, `${creationRequestId}.v5.json`);
  }

  private lockReleasePath(lockNonce: string): string {
    return safeChildPath(this.lockReleasesRoot, `${lockNonce}.released.v5.json`);
  }

  private lockReleaseGuardPath(lockNonce: string): string {
    return safeChildPath(this.lockReleasesRoot, `${lockNonce}.guard.v5.json`);
  }

  private revocationPath(id: string): string {
    return safeChildPath(this.revocationsRoot, `${id}.reservation-revocation.v5.json`);
  }

  private snapshotPath(id: string, channel: BlindEvaluationChannel): string {
    return safeChildPath(this.sessionDirectory(id), `${channel}.snapshot.v5.mp4`);
  }

  private mediaAccessPath(id: string, channel: BlindEvaluationChannel): string {
    return safeChildPath(this.sessionDirectory(id), `media-${channel}.access.v5.json`);
  }

  private terminalPath(id: string): string {
    return safeChildPath(this.sessionDirectory(id), "terminal.v5.json");
  }

  private retentionTombstonePath(id: string): string {
    return safeChildPath(this.tombstonesRoot, `${id}.retention-tombstone.v5.json`);
  }
}
