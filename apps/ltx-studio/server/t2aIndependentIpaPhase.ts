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
  independentIpaPhaseSchema,
  type IndependentIpaPhase,
} from "../shared/independentIpa.js";
import {
  capturePinnedPathRevision,
  openPinnedPaths,
  type PinnedPathRevision,
} from "./evaluatorBindings.js";

export const INDEPENDENT_IPA_OBSERVATION_BASENAME =
  "independent-ipa-observation.json" as const;

const AUTHORITY_AUDIO_BASENAME = "authority.wav";
const PRIVATE_TRANSCRIPT_BASENAME = "transcript.utf8";
const MAX_PHASE_BYTES = 512 * 1024;
const MAX_AUTHORITY_AUDIO_BYTES = 256 * 1024 * 1024;
const MAX_PRIVATE_TRANSCRIPT_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type IndependentIpaPhaseExecution = {
  code: number | null;
  stdout: string;
};

export type IndependentIpaPhaseAuthority = {
  authorityAudioSha256: string;
  runnerSha256: string;
  modelManifestSha256: string;
  modelWeightSha256: string;
};

export type ParsedIndependentIpaPhaseExecution = {
  phase: IndependentIpaPhase;
  canonicalBytes: Buffer;
  sha256: string;
};

export type MaterializedIndependentIpaPhase = {
  path: string;
  revision: PinnedPathRevision;
  sha256: string;
};

function assertSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`${label} ist keine gueltige SHA-256.`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function parseIndependentIpaPhaseExecution(
  execution: IndependentIpaPhaseExecution,
  authority: IndependentIpaPhaseAuthority,
): ParsedIndependentIpaPhaseExecution {
  assertSha256(authority.authorityAudioSha256, "Authority-Audio-Digest");
  if (typeof execution.stdout !== "string"
    || Buffer.byteLength(execution.stdout, "utf8") === 0
    || Buffer.byteLength(execution.stdout, "utf8") > MAX_PHASE_BYTES) {
    throw new Error("Die unabhaengige IPA-Phase lieferte kein einzelnes begrenztes JSON-Dokument.");
  }

  let rawPhase: unknown;
  try {
    rawPhase = JSON.parse(execution.stdout) as unknown;
  } catch (error) {
    throw new Error(`Die unabhaengige IPA-Phase lieferte ungueltiges JSON: ${String(error)}`);
  }
  const phase = independentIpaPhaseSchema.parse(rawPhase);
  const expectedExitCode = phase.status === "failed" ? 2 : 0;
  if (execution.code !== expectedExitCode) {
    throw new Error("Exitcode und Status der unabhaengigen IPA-Phase widersprechen einander.");
  }
  if (phase.authorityAudioSha256 !== authority.authorityAudioSha256) {
    throw new Error("Die unabhaengige IPA-Phase ist an ein anderes Authority-Audio gebunden.");
  }
  if (phase.status === "measured") {
    assertSha256(authority.runnerSha256, "IPA-Runner-Digest");
    assertSha256(authority.modelManifestSha256, "IPA-Modellmanifest-Digest");
    assertSha256(authority.modelWeightSha256, "IPA-Modellgewicht-Digest");
    if (phase.observation.runnerSha256 !== authority.runnerSha256
      || phase.observation.modelManifestSha256 !== authority.modelManifestSha256
      || phase.observation.modelWeightSha256 !== authority.modelWeightSha256) {
      throw new Error("Die gemessene IPA-Beobachtung widerspricht den Server-Pins.");
    }
  }

  const canonicalBytes = Buffer.from(canonicalJson(phase), "utf8");
  return {
    phase,
    canonicalBytes,
    sha256: sha256(canonicalBytes),
  };
}

function processOwner(): { uid: bigint; gid: bigint } {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) {
    throw new Error("Private IPA-Snapshots benoetigen eine POSIX-Serveridentitaet.");
  }
  return { uid: BigInt(uid), gid: BigInt(gid) };
}

function sameInode(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateSnapshotRoot(
  details: BigIntStats,
  owner: { uid: bigint; gid: bigint },
): void {
  if (!details.isDirectory()
    || details.isSymbolicLink()
    || details.uid !== owner.uid
    || details.gid !== owner.gid
    || (details.mode & 0o777n) !== 0o700n) {
    throw new Error("Der IPA-Snapshot-Root ist kein server-eigener privater 0700-Ordner.");
  }
}

function assertHeldSnapshotRoot(
  root: string,
  descriptor: number,
  expected: BigIntStats,
  owner: { uid: bigint; gid: bigint },
): void {
  const held = fstatSync(descriptor, { bigint: true });
  const fromPath = lstatSync(root, { bigint: true });
  assertPrivateSnapshotRoot(held, owner);
  assertPrivateSnapshotRoot(fromPath, owner);
  if (!sameInode(held, expected) || !sameInode(held, fromPath)) {
    throw new Error("Der private IPA-Snapshot-Root wurde waehrend der Materialisierung ersetzt.");
  }
}

function assertCanonicalExecution(
  execution: ParsedIndependentIpaPhaseExecution,
): Buffer {
  if (!Buffer.isBuffer(execution.canonicalBytes)
    || execution.canonicalBytes.length === 0
    || execution.canonicalBytes.length > MAX_PHASE_BYTES) {
    throw new Error("Die kanonischen IPA-Phasenbytes sind ungueltig.");
  }
  assertSha256(execution.sha256, "IPA-Phasendokument-Digest");
  const bytes = Buffer.from(execution.canonicalBytes);
  if (sha256(bytes) !== execution.sha256) {
    throw new Error("Die kanonischen IPA-Phasenbytes wurden veraendert.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Die kanonischen IPA-Phasenbytes enthalten ungueltiges JSON: ${String(error)}`);
  }
  const phase = independentIpaPhaseSchema.parse(parsed);
  const canonical = canonicalJson(phase);
  if (canonical !== bytes.toString("utf8")
    || canonicalJson(execution.phase) !== canonical) {
    throw new Error("Das IPA-Phasendokument ist nicht mehr exakt kanonisch gebunden.");
  }
  return bytes;
}

function assertCanonicalSnapshotPath(path: string, expectedBasename: string): void {
  if (!isAbsolute(path)
    || resolve(path) !== path
    || basename(path) !== expectedBasename
    || path.includes("\0")
    || path.includes("\n")) {
    throw new Error(`Ungueltiger privater IPA-Snapshot-Pfad: ${expectedBasename}.`);
  }
}

function assertReadonlySnapshotFile(
  path: string,
  expectedBasename: string,
  expectedRoot: string,
  owner: { uid: bigint; gid: bigint },
): PinnedPathRevision {
  assertCanonicalSnapshotPath(path, expectedBasename);
  if (dirname(path) !== expectedRoot) {
    throw new Error("Audio und privater Dialog muessen im selben IPA-Snapshot-Root liegen.");
  }
  const revision = capturePinnedPathRevision(path, "file");
  const details = lstatSync(path, { bigint: true });
  if (!details.isFile()
    || details.isSymbolicLink()
    || details.nlink !== 1n
    || details.uid !== owner.uid
    || details.gid !== owner.gid
    || (details.mode & 0o777n) !== 0o444n
    || revision.device !== details.dev.toString()
    || revision.inode !== details.ino.toString()
    || revision.size !== details.size.toString()
    || revision.modifiedAtNs !== details.mtimeNs.toString()
    || revision.changedAtNs !== details.ctimeNs.toString()) {
    throw new Error(`Der private Snapshot ${expectedBasename} besitzt keine starke Dateibindung.`);
  }
  return revision;
}

function assertMaterializedFile(
  path: string,
  expected: BigIntStats,
  owner: { uid: bigint; gid: bigint },
  expectedSize: number,
): void {
  const details = lstatSync(path, { bigint: true });
  if (!details.isFile()
    || details.isSymbolicLink()
    || details.nlink !== 1n
    || details.uid !== owner.uid
    || details.gid !== owner.gid
    || (details.mode & 0o777n) !== 0o444n
    || details.size !== BigInt(expectedSize)
    || !sameInode(details, expected)) {
    throw new Error("Das materialisierte IPA-Phasendokument besitzt keine starke Dateibindung.");
  }
}

function writeFully(descriptor: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written <= 0) {
      throw new Error("Das IPA-Phasendokument wurde nicht vollstaendig geschrieben.");
    }
    offset += written;
  }
}

export function materializeIndependentIpaPhaseObservation(options: {
  audioSnapshotPath: string;
  transcriptSnapshotPath: string;
  execution: ParsedIndependentIpaPhaseExecution;
}): MaterializedIndependentIpaPhase {
  const bytes = assertCanonicalExecution(options.execution);
  assertCanonicalSnapshotPath(options.audioSnapshotPath, AUTHORITY_AUDIO_BASENAME);
  assertCanonicalSnapshotPath(options.transcriptSnapshotPath, PRIVATE_TRANSCRIPT_BASENAME);
  const root = dirname(options.audioSnapshotPath);
  if (dirname(options.transcriptSnapshotPath) !== root) {
    throw new Error("Audio und privater Dialog muessen im selben IPA-Snapshot-Root liegen.");
  }

  const owner = processOwner();
  const rootFromPath = lstatSync(root, { bigint: true });
  assertPrivateSnapshotRoot(rootFromPath, owner);
  const rootDescriptor = openSync(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let snapshotPins: ReturnType<typeof openPinnedPaths> | null = null;
  let materialized = false;
  let published = false;
  const observationPath = join(root, INDEPENDENT_IPA_OBSERVATION_BASENAME);
  const heldObservationPath = `/proc/${process.pid}/fd/${rootDescriptor}/${INDEPENDENT_IPA_OBSERVATION_BASENAME}`;
  try {
    assertHeldSnapshotRoot(root, rootDescriptor, rootFromPath, owner);
    const audioRevision = assertReadonlySnapshotFile(
      options.audioSnapshotPath,
      AUTHORITY_AUDIO_BASENAME,
      root,
      owner,
    );
    const transcriptRevision = assertReadonlySnapshotFile(
      options.transcriptSnapshotPath,
      PRIVATE_TRANSCRIPT_BASENAME,
      root,
      owner,
    );
    snapshotPins = openPinnedPaths([audioRevision, transcriptRevision]);
    if (snapshotPins.sha256(options.audioSnapshotPath, MAX_AUTHORITY_AUDIO_BYTES)
      !== options.execution.phase.authorityAudioSha256) {
      throw new Error("Authority-Audio und unabhaengige IPA-Phase widersprechen einander.");
    }
    snapshotPins.sha256(options.transcriptSnapshotPath, MAX_PRIVATE_TRANSCRIPT_BYTES);

    const descriptor = openSync(
      heldObservationPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_RDWR
        | constants.O_NOFOLLOW,
      0o600,
    );
    materialized = true;
    let materializedStats: BigIntStats;
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile()
        || opened.nlink !== 1n
        || opened.uid !== owner.uid
        || opened.gid !== owner.gid
        || (opened.mode & 0o777n) !== 0o600n) {
        throw new Error("Das neue IPA-Phasendokument ist keine private regulaere Datei.");
      }
      writeFully(descriptor, bytes);
      fsyncSync(descriptor);
      fchmodSync(descriptor, 0o444);
      fsyncSync(descriptor);
      materializedStats = fstatSync(descriptor, { bigint: true });
      if (!materializedStats.isFile()
        || materializedStats.nlink !== 1n
        || materializedStats.size !== BigInt(bytes.length)
        || (materializedStats.mode & 0o777n) !== 0o444n) {
        throw new Error("Das IPA-Phasendokument wurde nicht vollstaendig versiegelt.");
      }
    } finally {
      closeSync(descriptor);
    }

    fsyncSync(rootDescriptor);
    assertHeldSnapshotRoot(root, rootDescriptor, rootFromPath, owner);
    assertMaterializedFile(observationPath, materializedStats, owner, bytes.length);
    const revision = capturePinnedPathRevision(observationPath, "file");
    if (revision.device !== materializedStats.dev.toString()
      || revision.inode !== materializedStats.ino.toString()
      || revision.size !== materializedStats.size.toString()) {
      throw new Error("Das sichtbare IPA-Phasendokument stimmt nicht mit dem geschriebenen Inode ueberein.");
    }
    const observationPins = openPinnedPaths([revision]);
    try {
      if (observationPins.sha256(observationPath, MAX_PHASE_BYTES) !== options.execution.sha256) {
        throw new Error("Das materialisierte IPA-Phasendokument besitzt einen falschen Digest.");
      }
      observationPins.verifyUnchanged();
    } finally {
      observationPins.close();
    }
    snapshotPins.verifyUnchanged();
    assertHeldSnapshotRoot(root, rootDescriptor, rootFromPath, owner);
    published = true;
    return { path: observationPath, revision, sha256: options.execution.sha256 };
  } finally {
    snapshotPins?.close();
    if (materialized && !published) {
      try {
        unlinkSync(heldObservationPath);
        fsyncSync(rootDescriptor);
      } catch {
        // The primary fail-closed error remains authoritative. A private lease
        // cleanup will remove the whole snapshot root if this best effort fails.
      }
    }
    closeSync(rootDescriptor);
  }
}
