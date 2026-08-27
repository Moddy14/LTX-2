import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
  type BigIntStats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  t2aIpaAdjudicationCanonicalJson,
  t2aIpaAdjudicationResultSchema,
  type T2aIpaAdjudicationResult,
} from "../shared/t2aIpaAdjudication.js";
import {
  capturePinnedPathRevision,
  openPinnedPaths,
  type PinnedPathRevision,
} from "./evaluatorBindings.js";

export const T2A_IPA_ADJUDICATION_RESULT_BASENAME =
  "ipa-adjudication-result.json" as const;
export const T2A_GERMAN_G2P_REQUEST_BASENAME = "german-g2p-request.json" as const;
export const T2A_IPA_ADJUDICATOR_REQUEST_BASENAME = "ipa-adjudicator-request.json" as const;

const AUTHORITY_AUDIO_BASENAME = "authority.wav";
const PRIVATE_TRANSCRIPT_BASENAME = "transcript.utf8";
const MAX_RESULT_BYTES = 512 * 1024;
const MAX_AUTHORITY_AUDIO_BYTES = 256 * 1024 * 1024;
const MAX_PRIVATE_TRANSCRIPT_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type ParsedT2aIpaAdjudicationExecution = Readonly<{
  result: T2aIpaAdjudicationResult;
  canonicalBytes: Buffer;
  sha256: string;
}>;

export type MaterializedT2aIpaAdjudicationResult = Readonly<{
  path: string;
  revision: PinnedPathRevision;
  sha256: string;
}>;

export type T2aPrivatePhaseRequestBasename =
  | typeof T2A_GERMAN_G2P_REQUEST_BASENAME
  | typeof T2A_IPA_ADJUDICATOR_REQUEST_BASENAME;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseT2aIpaAdjudicationExecution(
  execution: Readonly<{ code: number | null; stdout: string; stderr: string }>,
  expected: T2aIpaAdjudicationResult,
): ParsedT2aIpaAdjudicationExecution {
  if (execution.code !== 0
    || execution.stderr.length !== 0
    || Buffer.byteLength(execution.stdout, "utf8") === 0
    || Buffer.byteLength(execution.stdout, "utf8") > MAX_RESULT_BYTES) {
    throw new Error("IPA-Adjudicator lieferte keine einzelne, saubere und begrenzte Messung.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(execution.stdout) as unknown;
  } catch (error) {
    throw new Error(`IPA-Adjudicator lieferte ungueltiges JSON: ${String(error)}`);
  }
  const result = t2aIpaAdjudicationResultSchema.parse(raw);
  const canonical = t2aIpaAdjudicationCanonicalJson(result);
  if (execution.stdout !== canonical
    || canonical !== t2aIpaAdjudicationCanonicalJson(expected)) {
    throw new Error("IPA-Adjudicator-Ergebnis widerspricht der serverseitig gebundenen Rohmessung.");
  }
  const canonicalBytes = Buffer.from(canonical, "utf8");
  return Object.freeze({ result, canonicalBytes, sha256: sha256(canonicalBytes) });
}

function processOwner(): { uid: bigint; gid: bigint } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Private Adjudication-Snapshots benoetigen eine POSIX-Serveridentitaet.");
  }
  return { uid: BigInt(uid), gid: BigInt(gid) };
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertSnapshotRoot(
  details: BigIntStats,
  owner: { uid: bigint; gid: bigint },
): void {
  if (!details.isDirectory()
    || details.isSymbolicLink()
    || details.uid !== owner.uid
    || details.gid !== owner.gid
    || (details.mode & 0o777n) !== 0o700n) {
    throw new Error("Adjudication-Snapshot-Root ist kein server-eigener privater 0700-Ordner.");
  }
}

function assertCanonicalSnapshotPath(path: string, expectedBasename: string): void {
  if (!isAbsolute(path)
    || resolve(path) !== path
    || basename(path) !== expectedBasename
    || path.includes("\0")
    || path.includes("\n")) {
    throw new Error(`Ungueltiger privater Adjudication-Pfad: ${expectedBasename}.`);
  }
}

function writeFully(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) throw new Error("Adjudication-Ergebnis wurde nicht vollstaendig geschrieben.");
    offset += written;
  }
}

export function materializeT2aPrivatePhaseRequest(options: Readonly<{
  audioSnapshotPath: string;
  transcriptSnapshotPath: string;
  basename: T2aPrivatePhaseRequestBasename;
  canonicalJson: string;
  maximumBytes: number;
}>): MaterializedT2aIpaAdjudicationResult {
  const bytes = Buffer.from(options.canonicalJson, "utf8");
  if (!Number.isSafeInteger(options.maximumBytes)
    || options.maximumBytes <= 0
    || bytes.length === 0
    || bytes.length > options.maximumBytes) {
    throw new Error("Privater Phasenrequest liegt ausserhalb seines festen Groessenlimits.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(options.canonicalJson) as unknown;
  } catch (error) {
    throw new Error(`Privater Phasenrequest ist kein JSON: ${String(error)}`);
  }
  if (canonicalJson(raw) !== options.canonicalJson) {
    throw new Error("Privater Phasenrequest ist nicht kanonisch.");
  }
  assertCanonicalSnapshotPath(options.audioSnapshotPath, AUTHORITY_AUDIO_BASENAME);
  assertCanonicalSnapshotPath(options.transcriptSnapshotPath, PRIVATE_TRANSCRIPT_BASENAME);
  const root = dirname(options.audioSnapshotPath);
  if (dirname(options.transcriptSnapshotPath) !== root) {
    throw new Error("Privater Phasenrequest und Authority-Snapshots muessen denselben Root verwenden.");
  }
  const owner = processOwner();
  const rootFromPath = lstatSync(root, { bigint: true });
  assertSnapshotRoot(rootFromPath, owner);
  const rootDescriptor = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const requestPath = join(root, options.basename);
  const heldRequestPath = `/proc/${process.pid}/fd/${rootDescriptor}/${options.basename}`;
  let created = false;
  let published = false;
  let snapshotsPinned: ReturnType<typeof openPinnedPaths> | null = null;
  try {
    const heldRoot = fstatSync(rootDescriptor, { bigint: true });
    const visibleRoot = lstatSync(root, { bigint: true });
    assertSnapshotRoot(heldRoot, owner);
    assertSnapshotRoot(visibleRoot, owner);
    if (!sameInode(rootFromPath, heldRoot) || !sameInode(heldRoot, visibleRoot)) {
      throw new Error("Privater Request-Root wurde ersetzt.");
    }
    const audioRevision = capturePinnedPathRevision(options.audioSnapshotPath, "file");
    const transcriptRevision = capturePinnedPathRevision(options.transcriptSnapshotPath, "file");
    snapshotsPinned = openPinnedPaths([audioRevision, transcriptRevision]);
    snapshotsPinned.sha256(options.audioSnapshotPath, MAX_AUTHORITY_AUDIO_BYTES);
    snapshotsPinned.sha256(options.transcriptSnapshotPath, MAX_PRIVATE_TRANSCRIPT_BYTES);

    const descriptor = openSync(
      heldRequestPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    let writtenStats: BigIntStats;
    try {
      writeFully(descriptor, bytes);
      fsyncSync(descriptor);
      fchmodSync(descriptor, 0o444);
      fsyncSync(descriptor);
      writtenStats = fstatSync(descriptor, { bigint: true });
      if (!writtenStats.isFile()
        || writtenStats.nlink !== 1n
        || writtenStats.uid !== owner.uid
        || writtenStats.gid !== owner.gid
        || writtenStats.size !== BigInt(bytes.length)
        || (writtenStats.mode & 0o777n) !== 0o444n) {
        throw new Error("Privater Phasenrequest wurde nicht vollstaendig versiegelt.");
      }
    } finally {
      closeSync(descriptor);
    }
    fsyncSync(rootDescriptor);
    const visible = lstatSync(requestPath, { bigint: true });
    if (!sameInode(visible, writtenStats)) {
      throw new Error("Sichtbarer Phasenrequest weicht vom geschriebenen Inode ab.");
    }
    const revision = capturePinnedPathRevision(requestPath, "file");
    const requestPinned = openPinnedPaths([revision]);
    const requestSha256 = sha256(bytes);
    try {
      if (requestPinned.sha256(requestPath, options.maximumBytes) !== requestSha256) {
        throw new Error("Materialisierter Phasenrequest besitzt einen falschen Digest.");
      }
      requestPinned.verifyUnchanged();
    } finally {
      requestPinned.close();
    }
    snapshotsPinned.verifyUnchanged();
    published = true;
    return Object.freeze({ path: requestPath, revision, sha256: requestSha256 });
  } finally {
    snapshotsPinned?.close();
    if (created && !published) {
      try {
        unlinkSync(heldRequestPath);
        fsyncSync(rootDescriptor);
      } catch {
        // The private analysis lease removes the complete root on failure.
      }
    }
    closeSync(rootDescriptor);
  }
}

export function materializeT2aIpaAdjudicationResult(options: Readonly<{
  audioSnapshotPath: string;
  transcriptSnapshotPath: string;
  execution: ParsedT2aIpaAdjudicationExecution;
}>): MaterializedT2aIpaAdjudicationResult {
  const bytes = Buffer.from(options.execution.canonicalBytes);
  if (bytes.length === 0
    || bytes.length > MAX_RESULT_BYTES
    || sha256(bytes) !== options.execution.sha256
    || bytes.toString("utf8") !== t2aIpaAdjudicationCanonicalJson(options.execution.result)) {
    throw new Error("Kanonisches Adjudication-Ergebnis ist nicht mehr digestgebunden.");
  }
  if (!SHA256_PATTERN.test(options.execution.sha256)) {
    throw new Error("Adjudication-Ergebnis-Digest ist ungueltig.");
  }
  assertCanonicalSnapshotPath(options.audioSnapshotPath, AUTHORITY_AUDIO_BASENAME);
  assertCanonicalSnapshotPath(options.transcriptSnapshotPath, PRIVATE_TRANSCRIPT_BASENAME);
  const root = dirname(options.audioSnapshotPath);
  if (dirname(options.transcriptSnapshotPath) !== root) {
    throw new Error("Audio und privater Dialog muessen denselben Adjudication-Root verwenden.");
  }

  const owner = processOwner();
  const rootFromPath = lstatSync(root, { bigint: true });
  assertSnapshotRoot(rootFromPath, owner);
  const rootDescriptor = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const resultPath = join(root, T2A_IPA_ADJUDICATION_RESULT_BASENAME);
  const heldResultPath = `/proc/${process.pid}/fd/${rootDescriptor}/${T2A_IPA_ADJUDICATION_RESULT_BASENAME}`;
  let created = false;
  let published = false;
  let snapshotsPinned: ReturnType<typeof openPinnedPaths> | null = null;
  try {
    const heldRoot = fstatSync(rootDescriptor, { bigint: true });
    const visibleRoot = lstatSync(root, { bigint: true });
    assertSnapshotRoot(heldRoot, owner);
    assertSnapshotRoot(visibleRoot, owner);
    if (!sameInode(rootFromPath, heldRoot) || !sameInode(heldRoot, visibleRoot)) {
      throw new Error("Privater Adjudication-Root wurde ersetzt.");
    }
    const audioRevision = capturePinnedPathRevision(options.audioSnapshotPath, "file");
    const transcriptRevision = capturePinnedPathRevision(options.transcriptSnapshotPath, "file");
    snapshotsPinned = openPinnedPaths([audioRevision, transcriptRevision]);
    snapshotsPinned.sha256(options.audioSnapshotPath, MAX_AUTHORITY_AUDIO_BYTES);
    snapshotsPinned.sha256(options.transcriptSnapshotPath, MAX_PRIVATE_TRANSCRIPT_BYTES);

    const descriptor = openSync(
      heldResultPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    let writtenStats: BigIntStats;
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile()
        || opened.nlink !== 1n
        || opened.uid !== owner.uid
        || opened.gid !== owner.gid
        || (opened.mode & 0o777n) !== 0o600n) {
        throw new Error("Neue Adjudication-Datei besitzt keine private Inode-Authority.");
      }
      writeFully(descriptor, bytes);
      fsyncSync(descriptor);
      fchmodSync(descriptor, 0o444);
      fsyncSync(descriptor);
      writtenStats = fstatSync(descriptor, { bigint: true });
      if (!writtenStats.isFile()
        || writtenStats.nlink !== 1n
        || writtenStats.size !== BigInt(bytes.length)
        || (writtenStats.mode & 0o777n) !== 0o444n) {
        throw new Error("Adjudication-Ergebnis wurde nicht vollstaendig versiegelt.");
      }
    } finally {
      closeSync(descriptor);
    }
    fsyncSync(rootDescriptor);
    const visible = lstatSync(resultPath, { bigint: true });
    if (!sameInode(visible, writtenStats)
      || visible.uid !== owner.uid
      || visible.gid !== owner.gid
      || (visible.mode & 0o777n) !== 0o444n) {
      throw new Error("Sichtbares Adjudication-Ergebnis weicht vom geschriebenen Inode ab.");
    }
    const revision = capturePinnedPathRevision(resultPath, "file");
    const resultPinned = openPinnedPaths([revision]);
    try {
      if (resultPinned.sha256(resultPath, MAX_RESULT_BYTES) !== options.execution.sha256) {
        throw new Error("Materialisiertes Adjudication-Ergebnis besitzt einen falschen Digest.");
      }
      resultPinned.verifyUnchanged();
    } finally {
      resultPinned.close();
    }
    snapshotsPinned.verifyUnchanged();
    published = true;
    return Object.freeze({ path: resultPath, revision, sha256: options.execution.sha256 });
  } finally {
    snapshotsPinned?.close();
    if (created && !published) {
      try {
        unlinkSync(heldResultPath);
        fsyncSync(rootDescriptor);
      } catch {
        // The private analysis lease removes the complete root on failure.
      }
    }
    closeSync(rootDescriptor);
  }
}
