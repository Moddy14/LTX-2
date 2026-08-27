import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import type { ExecutionFileBinding, ExecutionFileRevision } from "../shared/jobExecution.js";
import { canonicalJson } from "../shared/canonicalJson.js";

export const OUTPUT_PUBLICATION_SUFFIX = ".ltx-publication.json";

export type OutputPublicationAuthority = {
  schemaVersion: "ltx-studio-output-publication.v2";
  state: "published";
  outputName: string;
  jobId: string;
  publishedAt: string;
  executionDecisionSha256: string;
  jobPersistenceRevision: string;
  jobAuthoritySha256: string;
  output: ExecutionFileBinding;
};

export type OpenOutputPublicationAuthority = {
  authority: OutputPublicationAuthority;
  fd: number;
  outputPath: string;
  snapshotBackend?: "source" | "o-tmpfile" | "unlinked-tempfile";
};

export type OutputPublicationDurabilityOperations = {
  fsync: typeof fsyncSync;
  link: typeof linkSync;
  unlink: typeof unlinkSync;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_ID_PATTERN = /^\d{1,64}$/;

export type TerminalJobAuthorityInput = {
  jobId: string;
  status: "completed";
  outputName: string;
  finishedAt: string;
  executionClass: "dgx" | "cpu-only";
  executionDecisionSha256: string;
  requestSha256: string;
  protocolSha256: string | null;
  jobPersistenceRevision: string;
};

export function terminalJobAuthoritySha256(input: TerminalJobAuthorityInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
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

function hashDescriptor(fd: number, size: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (count <= 0) throw new Error("Ausgabedatei endete während der Hash-Erfassung vorzeitig.");
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

function descriptorBinding(fd: number, path: string): ExecutionFileBinding {
  const before = fstatSync(fd);
  if (!before.isFile() || before.size <= 0 || before.nlink !== 1) {
    throw new Error("Publikationsartefakt ist keine reguläre, nichtleere Datei mit exakt einem Link.");
  }
  const beforeRevision = revision(before);
  const sha256 = hashDescriptor(fd, before.size);
  const afterRevision = revision(fstatSync(fd));
  if (!revisionsEqual(beforeRevision, afterRevision)) {
    throw new Error("Publikationsartefakt änderte sich während der Hash-Erfassung.");
  }
  return { path, sha256, revision: afterRevision };
}

function pathStillBinds(path: string, expected: ExecutionFileRevision): boolean {
  try {
    const stats = lstatSync(path);
    return !stats.isSymbolicLink() && stats.isFile() && revisionsEqual(revision(stats), expected);
  } catch {
    return false;
  }
}

type FileIdentity = {
  deviceId: string;
  fileId: string;
  uid: number;
  gid: number;
};

function fileIdentity(stats: {
  dev: number | bigint;
  ino: number | bigint;
  uid: number | bigint;
  gid: number | bigint;
}): FileIdentity {
  const uid = Number(stats.uid);
  const gid = Number(stats.gid);
  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("Publikationsmarker hat keine sicher darstellbare Eigentümeridentität.");
  }
  return {
    deviceId: String(stats.dev),
    fileId: String(stats.ino),
    uid,
    gid,
  };
}

function pathStillHasIdentity(path: string, expected: FileIdentity): boolean {
  try {
    const stats = lstatSync(path);
    return !stats.isSymbolicLink()
      && stats.isFile()
      && String(stats.dev) === expected.deviceId
      && String(stats.ino) === expected.fileId
      && stats.uid === expected.uid
      && stats.gid === expected.gid;
  } catch {
    return false;
  }
}

export function outputPublicationPath(outputPath: string): string {
  return `${outputPath}${OUTPUT_PUBLICATION_SUFFIX}`;
}

function syncDirectory(path: string, fsync: typeof fsyncSync = fsyncSync): void {
  const descriptor = openSync(path, "r");
  try {
    fsync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function unlinkIfPresent(path: string, fsync: typeof fsyncSync = fsyncSync): boolean {
  try {
    unlinkSync(path);
    syncDirectory(dirname(path), fsync);
    return true;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return false;
  }
}

function unlinkIfExactIdentity(
  path: string,
  expected: FileIdentity,
  fsync: typeof fsyncSync = fsyncSync,
): boolean {
  if (!pathStillHasIdentity(path, expected)) return false;
  unlinkSync(path);
  syncDirectory(dirname(path), fsync);
  return true;
}

export function removeOutputPublicationAuthority(
  outputPath: string,
  durabilityOverrides: Pick<Partial<OutputPublicationDurabilityOperations>, "fsync"> = {},
): void {
  unlinkIfPresent(outputPublicationPath(outputPath), durabilityOverrides.fsync ?? fsyncSync);
}

export function prepareOutputPublicationAuthority(
  outputPath: string,
  input: Pick<OutputPublicationAuthority,
    "jobId" | "publishedAt" | "executionDecisionSha256" | "jobPersistenceRevision" | "jobAuthoritySha256">,
): OutputPublicationAuthority {
  if (!UUID_PATTERN.test(input.jobId)
    || !Number.isFinite(Date.parse(input.publishedAt))
    || !SHA256_PATTERN.test(input.executionDecisionSha256)
    || !UUID_PATTERN.test(input.jobPersistenceRevision)
    || !SHA256_PATTERN.test(input.jobAuthoritySha256)) {
    throw new Error("Publikationsautorität ist strukturell ungültig.");
  }
  const descriptor = openSync(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = descriptorBinding(descriptor, outputPath);
    if (!pathStillBinds(outputPath, output.revision)) {
      throw new Error("Publikationsartefakt wurde während der Vorbereitung ersetzt.");
    }
    return {
      schemaVersion: "ltx-studio-output-publication.v2",
      state: "published",
      outputName: basename(outputPath),
      jobId: input.jobId,
      publishedAt: input.publishedAt,
      executionDecisionSha256: input.executionDecisionSha256,
      jobPersistenceRevision: input.jobPersistenceRevision,
      jobAuthoritySha256: input.jobAuthoritySha256,
      output,
    };
  } finally {
    closeSync(descriptor);
  }
}

export function persistOutputPublicationAuthority(
  outputPath: string,
  input: Pick<OutputPublicationAuthority,
    "jobId" | "publishedAt" | "executionDecisionSha256" | "jobPersistenceRevision" | "jobAuthoritySha256">,
  durabilityOverrides: Partial<OutputPublicationDurabilityOperations> = {},
  expectedAuthority?: OutputPublicationAuthority,
  releaseFence: () => void = () => undefined,
): OutputPublicationAuthority {
  if (!UUID_PATTERN.test(input.jobId)
    || !Number.isFinite(Date.parse(input.publishedAt))
    || !SHA256_PATTERN.test(input.executionDecisionSha256)
    || !UUID_PATTERN.test(input.jobPersistenceRevision)
    || !SHA256_PATTERN.test(input.jobAuthoritySha256)) {
    throw new Error("Publikationsautorität ist strukturell ungültig.");
  }
  const descriptor = openSync(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const durability: OutputPublicationDurabilityOperations = {
    fsync: durabilityOverrides.fsync ?? fsyncSync,
    link: durabilityOverrides.link ?? linkSync,
    unlink: durabilityOverrides.unlink ?? unlinkSync,
  };
  try {
    const output = descriptorBinding(descriptor, outputPath);
    if (expectedAuthority
      && (expectedAuthority.schemaVersion !== "ltx-studio-output-publication.v2"
        || expectedAuthority.state !== "published"
        || expectedAuthority.outputName !== basename(outputPath)
        || expectedAuthority.jobId !== input.jobId
        || expectedAuthority.publishedAt !== input.publishedAt
        || expectedAuthority.executionDecisionSha256 !== input.executionDecisionSha256
        || expectedAuthority.jobPersistenceRevision !== input.jobPersistenceRevision
        || expectedAuthority.jobAuthoritySha256 !== input.jobAuthoritySha256
        || JSON.stringify(expectedAuthority.output) !== JSON.stringify(output))) {
      throw new Error("Publikationsartefakt widerspricht der zuvor dauerhaft im Job gebundenen Autorität.");
    }
    durability.fsync(descriptor);
    if (!pathStillBinds(outputPath, output.revision)) {
      throw new Error("Publikationsartefakt wurde vor dem Marker ersetzt.");
    }
    const authority: OutputPublicationAuthority = {
      schemaVersion: "ltx-studio-output-publication.v2",
      state: "published",
      outputName: basename(outputPath),
      jobId: input.jobId,
      publishedAt: input.publishedAt,
      executionDecisionSha256: input.executionDecisionSha256,
      jobPersistenceRevision: input.jobPersistenceRevision,
      jobAuthoritySha256: input.jobAuthoritySha256,
      output,
    };
    const markerPath = outputPublicationPath(outputPath);
    const temporaryPath = join(dirname(markerPath), `.${basename(markerPath)}.${randomUUID()}.tmp`);
    let markerIdentity: FileIdentity | null = null;
    let markerDescriptor: number | null = null;
    try {
      const serializedMarker = `${JSON.stringify(authority, null, 2)}\n`;
      markerDescriptor = openSync(temporaryPath, "wx+", 0o600);
      markerIdentity = fileIdentity(fstatSync(markerDescriptor));
      try {
        writeFileSync(markerDescriptor, serializedMarker, "utf8");
        fchmodSync(markerDescriptor, 0o400);
        durability.fsync(markerDescriptor);
        const markerStats = fstatSync(markerDescriptor);
        const markerRevision = revision(markerStats);
        if (!markerStats.isFile()
          || markerStats.nlink !== 1
          || markerStats.uid !== (process.getuid?.() ?? markerStats.uid)
          || markerStats.gid !== (process.getgid?.() ?? markerStats.gid)
          || (markerStats.mode & 0o777) !== 0o400
          || markerStats.size !== Buffer.byteLength(serializedMarker)
          || hashDescriptor(markerDescriptor, markerStats.size)
            !== createHash("sha256").update(serializedMarker).digest("hex")
          || !pathStillBinds(temporaryPath, markerRevision)) {
          throw new Error("Publikationsmarker wurde während der Persistenz ersetzt oder verändert.");
        }
        if (!pathStillBinds(outputPath, output.revision)) {
          throw new Error("Publikationsartefakt wurde während der Marker-Persistenz ersetzt.");
        }
        // The output hash above may be expensive enough to starve the Node
        // event loop. Revalidate the caller's live release authority directly
        // beside the no-replace link that makes the marker visible.
        releaseFence();
        // link(2) is the no-replace publication primitive: unlike rename(2),
        // it fails with EEXIST instead of overwriting an authority created in
        // the absence-check race window. Until the temp name is unlinked both
        // names are intentionally rejected by readers because nlink is two.
        durability.link(temporaryPath, markerPath);
        const linkedMarker = lstatSync(markerPath);
        const linkedTemporary = lstatSync(temporaryPath);
        const linkedHeld = fstatSync(markerDescriptor);
        if (!pathStillHasIdentity(markerPath, markerIdentity)
          || !pathStillHasIdentity(temporaryPath, markerIdentity)
          || linkedMarker.nlink !== 2
          || linkedTemporary.nlink !== 2
          || linkedHeld.nlink !== 2) {
          throw new Error("No-replace-Publikationsmarker bindet nicht exakt das gehaltene temporäre Artefakt.");
        }
        durability.unlink(temporaryPath);
        const publishedStats = fstatSync(markerDescriptor);
        if (!publishedStats.isFile()
          || publishedStats.nlink !== 1
          || publishedStats.uid !== markerIdentity.uid
          || publishedStats.gid !== markerIdentity.gid
          || (publishedStats.mode & 0o777) !== 0o400
          || publishedStats.size !== Buffer.byteLength(serializedMarker)
          || hashDescriptor(markerDescriptor, publishedStats.size)
            !== createHash("sha256").update(serializedMarker).digest("hex")
          || !pathStillBinds(markerPath, revision(publishedStats))
          || !pathStillBinds(outputPath, output.revision)) {
          throw new Error("Publikationsmarker driftete während der gehaltenen no-replace-Persistenz.");
        }
        syncDirectory(dirname(markerPath), durability.fsync);
      } finally {
        closeSync(markerDescriptor);
        markerDescriptor = null;
      }
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (markerDescriptor !== null) {
        try {
          closeSync(markerDescriptor);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        markerDescriptor = null;
      }
      if (markerIdentity) {
        for (const path of [markerPath, temporaryPath]) {
          try {
            unlinkIfExactIdentity(path, markerIdentity, fsyncSync);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Publikationsmarker und temporäre Datei konnten nicht fail-closed bereinigt werden.",
        );
      }
      throw error;
    }
    // The held output descriptor remains the publication byte authority until
    // the directory fsync above has made the no-replace link/unlink durable.
    return authority;
  } finally {
    closeSync(descriptor);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRevision(value: unknown): value is ExecutionFileRevision {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return exactKeys(item, [
    "sizeBytes", "modifiedAtMs", "changedAtMs", "fileId", "deviceId", "mode",
    "uid", "gid", "nlink",
  ])
    && typeof item.sizeBytes === "number"
    && Number.isSafeInteger(item.sizeBytes)
    && item.sizeBytes > 0
    && typeof item.modifiedAtMs === "number"
    && Number.isFinite(item.modifiedAtMs)
    && item.modifiedAtMs >= 0
    && typeof item.changedAtMs === "number"
    && Number.isFinite(item.changedAtMs)
    && item.changedAtMs >= 0
    && typeof item.fileId === "string"
    && INTEGER_ID_PATTERN.test(item.fileId)
    && typeof item.deviceId === "string"
    && INTEGER_ID_PATTERN.test(item.deviceId)
    && typeof item.mode === "number"
    && Number.isSafeInteger(item.mode)
    && item.mode >= 0
    && item.mode <= 0xffff_ffff
    && typeof item.uid === "number"
    && Number.isSafeInteger(item.uid)
    && item.uid >= 0
    && typeof item.gid === "number"
    && Number.isSafeInteger(item.gid)
    && item.gid >= 0
    && item.nlink === 1;
}

export function normalizeOutputPublicationAuthority(
  value: unknown,
  outputPath: string,
): OutputPublicationAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, [
    "schemaVersion", "state", "outputName", "jobId", "publishedAt", "executionDecisionSha256",
    "jobPersistenceRevision", "jobAuthoritySha256", "output",
  ])
    || item.schemaVersion !== "ltx-studio-output-publication.v2"
    || item.state !== "published"
    || item.outputName !== basename(outputPath)
    || typeof item.jobId !== "string"
    || !UUID_PATTERN.test(item.jobId)
    || typeof item.publishedAt !== "string"
    || !Number.isFinite(Date.parse(item.publishedAt))
    || typeof item.executionDecisionSha256 !== "string"
    || !SHA256_PATTERN.test(item.executionDecisionSha256)
    || typeof item.jobPersistenceRevision !== "string"
    || !UUID_PATTERN.test(item.jobPersistenceRevision)
    || typeof item.jobAuthoritySha256 !== "string"
    || !SHA256_PATTERN.test(item.jobAuthoritySha256)
    || !item.output
    || typeof item.output !== "object"
    || Array.isArray(item.output)) return null;
  const output = item.output as Record<string, unknown>;
  if (!exactKeys(output, ["path", "sha256", "revision"])
    || output.path !== outputPath
    || typeof output.sha256 !== "string"
    || !SHA256_PATTERN.test(output.sha256)
    || !isRevision(output.revision)) return null;
  return structuredClone(item) as OutputPublicationAuthority;
}

export function openValidOutputPublicationAuthority(
  root: string,
  outputName: string,
): OpenOutputPublicationAuthority | null {
  if (!outputName || basename(outputName) !== outputName || outputName.includes("\\")) return null;
  const outputPath = join(root, outputName);
  const markerPath = outputPublicationPath(outputPath);
  let markerDescriptor: number | null = null;
  let outputDescriptor: number | null = null;
  let outputLeaseReturned = false;
  try {
    markerDescriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const markerStats = fstatSync(markerDescriptor);
    if (!markerStats.isFile()
      || markerStats.nlink !== 1
      || markerStats.uid !== (process.getuid?.() ?? markerStats.uid)
      || markerStats.gid !== (process.getgid?.() ?? markerStats.gid)
      || (markerStats.mode & 0o777) !== 0o400
      || markerStats.size <= 0
      || markerStats.size > 64 * 1024) return null;
    const authority = normalizeOutputPublicationAuthority(
      JSON.parse(readFileSync(markerDescriptor, "utf8")),
      outputPath,
    );
    if (!authority) return null;
    outputDescriptor = openSync(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const binding = descriptorBinding(outputDescriptor, outputPath);
    if (binding.sha256 !== authority.output.sha256
      || !revisionsEqual(binding.revision, authority.output.revision)
      || !pathStillBinds(outputPath, authority.output.revision)) return null;
    outputLeaseReturned = true;
    return { authority, fd: outputDescriptor, outputPath };
  } catch {
    return null;
  } finally {
    if (outputDescriptor !== null && !outputLeaseReturned) closeSync(outputDescriptor);
    if (markerDescriptor !== null) closeSync(markerDescriptor);
  }
}

/**
 * Metadata-only fast path for library listing. It proves the marker, complete
 * stat revision and pathname still agree, but deliberately makes no fresh
 * byte-content claim. Every byte consumer must use the full open/snapshot API.
 */
export function readStatBoundOutputPublicationAuthority(
  root: string,
  outputName: string,
): OutputPublicationAuthority | null {
  if (!outputName || basename(outputName) !== outputName || outputName.includes("\\")) return null;
  const outputPath = join(root, outputName);
  const markerPath = outputPublicationPath(outputPath);
  let markerDescriptor: number | null = null;
  try {
    markerDescriptor = openSync(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const markerStats = fstatSync(markerDescriptor);
    if (!markerStats.isFile()
      || markerStats.nlink !== 1
      || markerStats.uid !== (process.getuid?.() ?? markerStats.uid)
      || markerStats.gid !== (process.getgid?.() ?? markerStats.gid)
      || (markerStats.mode & 0o777) !== 0o400
      || markerStats.size <= 0
      || markerStats.size > 64 * 1024) return null;
    const authority = normalizeOutputPublicationAuthority(
      JSON.parse(readFileSync(markerDescriptor, "utf8")),
      outputPath,
    );
    if (!authority || !pathStillBinds(outputPath, authority.output.revision)) return null;
    return authority;
  } catch {
    return null;
  } finally {
    if (markerDescriptor !== null) closeSync(markerDescriptor);
  }
}

export function readValidOutputPublicationAuthority(
  root: string,
  outputName: string,
): OutputPublicationAuthority | null {
  const lease = openValidOutputPublicationAuthority(root, outputName);
  if (!lease) return null;
  try {
    return lease.authority;
  } finally {
    closeSync(lease.fd);
  }
}

// Linux exposes O_TMPFILE in the kernel ABI even though Node's constants do
// not currently export it. The value is stable across the supported Linux
// architectures and already includes O_DIRECTORY.
const LINUX_O_TMPFILE = 0o20000000 | constants.O_DIRECTORY;

export function openAnonymousOutputSnapshot(root: string): {
  fd: number;
  backend: "o-tmpfile" | "unlinked-tempfile";
} {
  if (process.platform === "linux") {
    try {
      return {
        fd: openSync(root, constants.O_RDWR | LINUX_O_TMPFILE, 0o600),
        backend: "o-tmpfile",
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["EOPNOTSUPP", "EINVAL", "EISDIR", "EPERM"].includes(code)) throw error;
    }
  }
  const temporaryPath = join(root, `.ltx-output-snapshot.${randomUUID()}.tmp`);
  const fd = openSync(temporaryPath, "wx+", 0o600);
  try {
    unlinkSync(temporaryPath);
    syncDirectory(root);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkIfPresent(temporaryPath);
    } catch {
      // Preserve the primary failure; the caller never receives the descriptor.
    }
    throw error;
  }
  return { fd, backend: "unlinked-tempfile" };
}

const SNAPSHOT_MATERIALIZATION_ERROR_CODES = new Set([
  "EACCES",
  "EDQUOT",
  "EFBIG",
  "EIO",
  "EMFILE",
  "ENOMEM",
  "ENFILE",
  "ENOENT",
  "ENOSPC",
  "EROFS",
]);

/**
 * Distinguishes storage/descriptor failures from authority or hash drift.
 * Callers may expose only a redacted retryable error; the original error stays
 * available as an internal cause for diagnostics.
 */
export function isOutputSnapshotMaterializationSystemError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return error instanceof Error
    && typeof (error as NodeJS.ErrnoException).code === "string"
    && SNAPSHOT_MATERIALIZATION_ERROR_CODES.has((error as NodeJS.ErrnoException).code!);
}

export type OutputSnapshotOperations = {
  openAnonymousSnapshot: typeof openAnonymousOutputSnapshot;
};

const DEFAULT_OUTPUT_SNAPSHOT_OPERATIONS: OutputSnapshotOperations = Object.freeze({
  openAnonymousSnapshot: openAnonymousOutputSnapshot,
});

/**
 * Copies a fully validated source lease into an anonymous, read-only snapshot.
 * The complete source and snapshot hashes are checked before the returned FD
 * can be used by HTTP or another consumer, so no source byte is streamed while
 * same-inode mutation could still change the response.
 */
export function createVerifiedOutputSnapshot(
  source: OpenOutputPublicationAuthority,
  snapshotRoot: string,
  operations: OutputSnapshotOperations = DEFAULT_OUTPUT_SNAPSHOT_OPERATIONS,
): OpenOutputPublicationAuthority {
  let snapshot: ReturnType<typeof openAnonymousOutputSnapshot> | null = null;
  let snapshotWriterOpen = false;
  let readOnlySnapshot: number | null = null;
  try {
    // Source ownership transfers to this function before snapshot allocation.
    // Allocation may itself fail (ENOSPC/EACCES/ENOENT), so it must be inside
    // the same finally that closes the already-held source descriptor.
    snapshot = operations.openAnonymousSnapshot(snapshotRoot);
    snapshotWriterOpen = true;
    const sourceBefore = fstatSync(source.fd);
    const sourceBeforeRevision = revision(sourceBefore);
    if (!sourceBefore.isFile()
      || sourceBefore.nlink !== 1
      || !revisionsEqual(sourceBeforeRevision, source.authority.output.revision)) {
      throw new Error("Ausgabe änderte sich vor der Snapshot-Erzeugung.");
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < sourceBefore.size) {
      const count = readSync(
        source.fd,
        buffer,
        0,
        Math.min(buffer.length, sourceBefore.size - position),
        position,
      );
      if (count <= 0) throw new Error("Ausgabe endete während der Snapshot-Erzeugung vorzeitig.");
      digest.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) {
        const writeCount = writeSync(snapshot.fd, buffer, written, count - written, position + written);
        if (writeCount <= 0) throw new Error("Ausgabe-Snapshot konnte nicht vollständig geschrieben werden.");
        written += writeCount;
      }
      position += count;
    }
    const sourceAfterRevision = revision(fstatSync(source.fd));
    if (!revisionsEqual(sourceBeforeRevision, sourceAfterRevision)
      || digest.digest("hex") !== source.authority.output.sha256) {
      throw new Error("Ausgabe änderte sich während der Snapshot-Erzeugung.");
    }
    const snapshotStats = fstatSync(snapshot.fd);
    if (!snapshotStats.isFile()
      || snapshotStats.size !== source.authority.output.revision.sizeBytes
      || hashDescriptor(snapshot.fd, snapshotStats.size) !== source.authority.output.sha256) {
      throw new Error("Ausgabe-Snapshot stimmt nicht bytegenau mit der Autorität überein.");
    }
    fchmodSync(snapshot.fd, 0o400);
    fsyncSync(snapshot.fd);
    const sealedSnapshotStats = fstatSync(snapshot.fd);
    if (!sealedSnapshotStats.isFile()
      || sealedSnapshotStats.nlink !== 0
      || sealedSnapshotStats.size !== source.authority.output.revision.sizeBytes
      || (sealedSnapshotStats.mode & 0o777) !== 0o400
      || hashDescriptor(snapshot.fd, sealedSnapshotStats.size) !== source.authority.output.sha256) {
      throw new Error("Ausgabe-Snapshot änderte sich während der Versiegelung.");
    }
    // chmod does not revoke write access from the already-open O_RDWR writer.
    // Re-open the exact held anonymous inode read-only and close the writer
    // before any HTTP/cache consumer can receive a descriptor.
    readOnlySnapshot = openSync(`/proc/self/fd/${snapshot.fd}`, constants.O_RDONLY);
    const readOnlyStats = fstatSync(readOnlySnapshot);
    if (!readOnlyStats.isFile()
      || readOnlyStats.dev !== sealedSnapshotStats.dev
      || readOnlyStats.ino !== sealedSnapshotStats.ino
      || readOnlyStats.nlink !== 0
      || readOnlyStats.size !== sealedSnapshotStats.size
      || (readOnlyStats.mode & 0o777) !== 0o400) {
      throw new Error("Ausgabe-Snapshot konnte nicht read-only gebunden werden.");
    }
    closeSync(snapshot.fd);
    snapshotWriterOpen = false;
    const returnedFd = readOnlySnapshot;
    readOnlySnapshot = null;
    return {
      authority: source.authority,
      fd: returnedFd,
      outputPath: `/proc/${process.pid}/fd/${returnedFd}`,
      snapshotBackend: snapshot.backend,
    };
  } finally {
    closeSync(source.fd);
    if (readOnlySnapshot !== null) closeSync(readOnlySnapshot);
    if (snapshotWriterOpen && snapshot !== null) closeSync(snapshot.fd);
  }
}
