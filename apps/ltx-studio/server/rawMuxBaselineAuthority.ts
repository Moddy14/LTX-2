import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { canonicalJson } from "../shared/canonicalJson.js";
import type {
  CpuPairedArtifactReuseSourceBinding,
  ExecutionFileBinding,
  ExecutionFileRevision,
} from "../shared/jobExecution.js";
import {
  defaultLipForcingRawOutputProfile,
  experimentalLipForcingRawOutputProfile,
} from "../shared/pipelines.js";
import { appRoot } from "./config.js";
import {
  validRawMuxDurationArg,
  verifyRawMuxRawReplay,
} from "./rawMuxRawReplay.js";
import {
  validRawMuxReplayTimeline,
  verifyRawMuxTimelineReplay,
} from "./rawMuxTimelineReplay.js";

export const RAW_MUX_PAIR_DIRECTORY = "raw-mux-pair";
export const RAW_MUX_PAIR_AUTHORITY_FILE = "baseline-authority.v1.json";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function rawMuxCommandSha256(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv), "utf8").digest("hex");
}

export type RawMuxPairPaths = {
  root: string;
  preMux: string;
  preMuxReceipt: string;
  baselineRaw: string;
  candidateRaw: string;
  candidateFinal: string;
  receipt: string;
  timelineReceipt: string;
  authority: string;
  ltxBase: string;
  controlAudio: string;
  programAudio: string;
};

export type RawMuxBaselineAuthority = {
  schemaVersion: "ltx-studio-raw-mux-baseline-authority.v1";
  createdAt: string;
  experimentId: string;
  protocolSha256: string;
  baselineJobId: string;
  baselineOutputName: string;
  baselineRequestSha256: string;
  candidateRequestSha256: string;
  containerImageFingerprint: string;
  mouthDelayMs: number;
  programAudioDelayMs: number;
  rawOutputProfiles: {
    baseline: typeof defaultLipForcingRawOutputProfile;
    candidate: typeof experimentalLipForcingRawOutputProfile;
  };
  files: {
    preMux: ExecutionFileBinding;
    preMuxReceipt: ExecutionFileBinding;
    baselineRaw: ExecutionFileBinding;
    candidateRaw: ExecutionFileBinding;
    candidateFinal: ExecutionFileBinding;
    receipt: ExecutionFileBinding;
    timelineReceipt: ExecutionFileBinding;
    ltxBase: ExecutionFileBinding;
    controlAudio: ExecutionFileBinding;
    programAudio: ExecutionFileBinding;
    baselineFinal: ExecutionFileBinding;
  };
  fingerprint: string;
};

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function revision(stats: ReturnType<typeof fstatSync>): ExecutionFileRevision {
  if (!stats.isFile() || stats.size <= 0 || stats.nlink !== 1) {
    throw new Error("Raw-Mux-Paarartefakt ist keine nichtleere reguläre Datei mit genau einem Link.");
  }
  return {
    sizeBytes: Number(stats.size),
    modifiedAtMs: Number(stats.mtimeMs),
    changedAtMs: Number(stats.ctimeMs),
    fileId: stats.ino.toString(),
    deviceId: stats.dev.toString(),
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    nlink: 1,
  };
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Raw-Mux-Paarautorität benötigt eine POSIX-UID.");
  }
  return process.getuid();
}

function sameRevision(left: ExecutionFileRevision, right: ExecutionFileRevision): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameFileBytesAndIdentity(
  left: ExecutionFileBinding,
  right: ExecutionFileBinding,
): boolean {
  return left.sha256 === right.sha256
    && left.revision.sizeBytes === right.revision.sizeBytes
    && left.revision.fileId === right.revision.fileId
    && left.revision.deviceId === right.revision.deviceId
    && left.revision.uid === right.revision.uid
    && left.revision.gid === right.revision.gid
    && left.revision.nlink === 1
    && right.revision.nlink === 1;
}

function hashDescriptor(descriptor: number, sizeBytes: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < sizeBytes) {
    const read = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, sizeBytes - position),
      position,
    );
    if (read <= 0) throw new Error("Raw-Mux-Paarartefakt endete während der Hashprüfung vorzeitig.");
    digest.update(buffer.subarray(0, read));
    position += read;
  }
  return digest.digest("hex");
}

export function captureRawMuxPairFile(path: string): ExecutionFileBinding {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = revision(fstatSync(descriptor));
    const digest = hashDescriptor(descriptor, before.sizeBytes);
    const after = revision(fstatSync(descriptor));
    const pathname = lstatSync(path);
    if (pathname.isSymbolicLink()
      || Number(pathname.uid) !== currentUid()
      || !sameRevision(before, after)
      || !sameRevision(after, revision(pathname))) {
      throw new Error(`Raw-Mux-Paarartefakt änderte sich während der Bindung: ${path}`);
    }
    return { path, sha256: digest, revision: after };
  } finally {
    closeSync(descriptor);
  }
}

function sealRawMuxPairFile(binding: ExecutionFileBinding): ExecutionFileBinding {
  const descriptor = openSync(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = revision(fstatSync(descriptor));
    if (!sameRevision(before, binding.revision)
      || hashDescriptor(descriptor, before.sizeBytes) !== binding.sha256) {
      throw new Error(`Raw-Mux-Paarartefakt driftete vor dem FD-Seal: ${binding.path}`);
    }
    const pathnameBefore = lstatSync(binding.path);
    if (pathnameBefore.isSymbolicLink()
      || Number(pathnameBefore.uid) !== currentUid()
      || !sameRevision(before, revision(pathnameBefore))) {
      throw new Error(`Raw-Mux-Paarpfad widerspricht seinem gehaltenen FD vor dem Seal: ${binding.path}`);
    }
    if ((before.mode & 0o7777) !== 0o400) fchmodSync(descriptor, 0o400);
    fsyncSync(descriptor);
    const after = revision(fstatSync(descriptor));
    const sealed: ExecutionFileBinding = {
      path: binding.path,
      sha256: hashDescriptor(descriptor, after.sizeBytes),
      revision: after,
    };
    const pathnameAfter = lstatSync(binding.path);
    if (!sameFileBytesAndIdentity(binding, sealed)
      || (after.mode & 0o7777) !== 0o400
      || pathnameAfter.isSymbolicLink()
      || Number(pathnameAfter.uid) !== currentUid()
      || !sameRevision(after, revision(pathnameAfter))) {
      throw new Error(`Raw-Mux-Paarartefakt driftete während des gehaltenen FD-Seals: ${binding.path}`);
    }
    return sealed;
  } finally {
    closeSync(descriptor);
  }
}

export function rawMuxPairPaths(stageRoot: string): RawMuxPairPaths {
  const root = join(stageRoot, RAW_MUX_PAIR_DIRECTORY);
  return {
    root,
    preMux: join(root, "pre-mux-crf13.mp4"),
    preMuxReceipt: join(root, "pre-mux-receipt.json"),
    baselineRaw: join(root, "baseline-raw.mp4"),
    candidateRaw: join(root, "candidate-raw.mp4"),
    candidateFinal: join(root, "candidate-final.mp4"),
    receipt: join(root, "pair-receipt.json"),
    timelineReceipt: join(root, "timeline-receipt.json"),
    authority: join(root, RAW_MUX_PAIR_AUTHORITY_FILE),
    ltxBase: join(stageRoot, "ltx-base.mp4"),
    controlAudio: join(stageRoot, "lipforcing-control-audio.wav"),
    programAudio: join(stageRoot, "lipforcing-program-audio.wav"),
  };
}

function authorityFingerprint(
  authority: Omit<RawMuxBaselineAuthority, "fingerprint">,
): string {
  return createHash("sha256").update(canonicalJson(authority)).digest("hex");
}

type RawMuxPairReceipt = {
  schemaVersion: "ltx-studio-lipforcing-raw-mux-pair-receipt.v1";
  profiles: { baseline: string; candidate: string };
  durationArg: string | null;
  ffmpeg: { path: string; sha256: string; version: string };
  inputs: {
    preMuxSourceSha256: string;
    preMuxExportSha256: string;
    preMuxSizeBytes: number;
    audioSha256: string;
    audioSizeBytes: number;
  };
  commands: {
    baseline: { argv: string[]; sha256: string };
    candidate: { argv: string[]; sha256: string };
  };
  outputs: {
    baselineRaw: { sha256: string; sizeBytes: number };
    candidateRaw: { sha256: string; sizeBytes: number };
  };
};

type PreMuxExportReceiptRevision = {
  deviceId: string;
  fileId: string;
  mode: number;
  uid: number;
  gid: number;
  nlink: 1;
  modifiedAtNs: string;
  changedAtNs: string;
};

type PreMuxExportReceipt = {
  schemaVersion: "ltx-studio-lipforcing-premux-export-receipt.v1";
  durationArg: string | null;
  source: { sha256: string; sizeBytes: number; revision: PreMuxExportReceiptRevision };
  export: { sha256: string; sizeBytes: number; revision: PreMuxExportReceiptRevision };
  byteIdentical: true;
  copy: {
    method: "python-os-read-write-held-fd-exclusive-v1";
    command: { argv: string[]; sha256: string };
  };
  code: { rawOutputMuxSha256: string; containerRunnerSha256: string };
};

type PairedTimelineReceipt = {
  schemaVersion: "ltx-studio-lipforcing-paired-timeline-receipt.v1";
  rawMuxReceiptSha256: string;
  programAudioDelayMs: number;
  inputs: {
    source: { sha256: string; sizeBytes: number };
    programAudio: { sha256: string; sizeBytes: number };
  };
  executables: {
    before: {
      ffmpeg: HostExecutableIdentity<"/usr/bin/ffmpeg">;
      ffprobe: HostExecutableIdentity<"/usr/bin/ffprobe">;
    };
    after: {
      ffmpeg: HostExecutableIdentity<"/usr/bin/ffmpeg">;
      ffprobe: HostExecutableIdentity<"/usr/bin/ffprobe">;
    };
  };
  commands: {
    baseline: { argv: string[]; sha256: string };
    candidate: { argv: string[]; sha256: string };
  };
  timeline: {
    baseline: { frameRate: string; frameCount: number; width: number; height: number; hasAudio: true };
    candidate: { frameRate: string; frameCount: number; width: number; height: number; hasAudio: true };
  };
  decodedPcm: {
    format: "s16le-mono-48000";
    commands: {
      baseline: { argv: string[]; sha256: string };
      candidate: { argv: string[]; sha256: string };
    };
  };
  outputs: {
    baselineFinal: { sha256: string; sizeBytes: number; decodedPcmSha256: string };
    candidateFinal: { sha256: string; sizeBytes: number; decodedPcmSha256: string };
  };
};

type HostExecutableIdentity<Path extends string = string> = {
  path: Path;
  sha256: string;
  version: string;
};

function captureAndReadSmallJson(
  path: string,
  limitBytes: number,
): { binding: ExecutionFileBinding; value: unknown } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = revision(fstatSync(descriptor));
    if (before.sizeBytes > limitBytes) throw new Error("Receipt/Authority überschreitet das Größenlimit.");
    const buffer = Buffer.alloc(before.sizeBytes);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (count <= 0) throw new Error("Receipt/Authority endete beim Lesen vorzeitig.");
      offset += count;
    }
    const digest = createHash("sha256").update(buffer).digest("hex");
    const after = revision(fstatSync(descriptor));
    const pathname = lstatSync(path);
    if (!sameRevision(before, after)
      || pathname.isSymbolicLink()
      || Number(pathname.uid) !== currentUid()
      || !sameRevision(after, revision(pathname))) {
      throw new Error("Receipt/Authority änderte sich während des gehaltenen FD-Lesens.");
    }
    return {
      binding: { path, sha256: digest, revision: after },
      value: JSON.parse(buffer.toString("utf8")),
    };
  } finally {
    closeSync(descriptor);
  }
}

function validFinalOutputReceipt(value: unknown): value is {
  sha256: string;
  sizeBytes: number;
  decodedPcmSha256: string;
} {
  return isRecord(value)
    && exactKeys(value, ["sha256", "sizeBytes", "decodedPcmSha256"])
    && typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)
    && typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0
    && typeof value.decodedPcmSha256 === "string" && SHA256_PATTERN.test(value.decodedPcmSha256);
}

function readSmallJsonFromBinding(binding: ExecutionFileBinding, limitBytes: number): unknown {
  const captured = captureAndReadSmallJson(binding.path, limitBytes);
  if (canonicalJson(captured.binding) !== canonicalJson(binding)) {
    throw new Error("Receipt/Authority widerspricht ihrer gebundenen Revision oder ihrem Digest.");
  }
  return captured.value;
}

function validHashSize(value: unknown): value is { sha256: string; sizeBytes: number } {
  return isRecord(value)
    && exactKeys(value, ["sha256", "sizeBytes"])
    && typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)
    && typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0;
}

function parseRawMuxPairReceipt(value: unknown): RawMuxPairReceipt | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "profiles", "durationArg", "ffmpeg", "inputs", "commands", "outputs",
  ]) || value.schemaVersion !== "ltx-studio-lipforcing-raw-mux-pair-receipt.v1"
    || !validRawMuxDurationArg(value.durationArg)) {
    return null;
  }
  if (!isRecord(value.profiles) || !exactKeys(value.profiles, ["baseline", "candidate"])
    || value.profiles.baseline !== defaultLipForcingRawOutputProfile
    || value.profiles.candidate !== experimentalLipForcingRawOutputProfile
    || !isRecord(value.ffmpeg) || !exactKeys(value.ffmpeg, ["path", "sha256", "version"])
    || value.ffmpeg.path !== "/usr/bin/ffmpeg"
    || typeof value.ffmpeg.sha256 !== "string" || !SHA256_PATTERN.test(value.ffmpeg.sha256)
    || typeof value.ffmpeg.version !== "string" || value.ffmpeg.version.length < 1 || value.ffmpeg.version.length > 1000
    || !isRecord(value.inputs) || !exactKeys(value.inputs, [
      "preMuxSourceSha256", "preMuxExportSha256", "preMuxSizeBytes", "audioSha256", "audioSizeBytes",
    ])
    || typeof value.inputs.preMuxSourceSha256 !== "string" || !SHA256_PATTERN.test(value.inputs.preMuxSourceSha256)
    || typeof value.inputs.preMuxExportSha256 !== "string" || !SHA256_PATTERN.test(value.inputs.preMuxExportSha256)
    || typeof value.inputs.preMuxSizeBytes !== "number" || !Number.isSafeInteger(value.inputs.preMuxSizeBytes) || value.inputs.preMuxSizeBytes <= 0
    || typeof value.inputs.audioSha256 !== "string" || !SHA256_PATTERN.test(value.inputs.audioSha256)
    || typeof value.inputs.audioSizeBytes !== "number" || !Number.isSafeInteger(value.inputs.audioSizeBytes) || value.inputs.audioSizeBytes <= 0
    || !isRecord(value.commands) || !exactKeys(value.commands, ["baseline", "candidate"])
    || !isRecord(value.outputs) || !exactKeys(value.outputs, ["baselineRaw", "candidateRaw"])
    || !validHashSize(value.outputs.baselineRaw)
    || !validHashSize(value.outputs.candidateRaw)) return null;
  for (const arm of ["baseline", "candidate"] as const) {
    const command = value.commands[arm];
    if (!isRecord(command) || !exactKeys(command, ["argv", "sha256"])
      || !Array.isArray(command.argv) || command.argv.length < 10 || command.argv.length > 128
      || !command.argv.every((argument) => typeof argument === "string" && argument.length <= 4096 && !argument.includes("\0"))
      || typeof command.sha256 !== "string" || !SHA256_PATTERN.test(command.sha256)
      || rawMuxCommandSha256(command.argv) !== command.sha256) return null;
  }
  return structuredClone(value) as RawMuxPairReceipt;
}

function validPreMuxExportRevision(value: unknown): value is PreMuxExportReceiptRevision {
  return isRecord(value)
    && exactKeys(value, [
      "deviceId", "fileId", "mode", "uid", "gid", "nlink", "modifiedAtNs", "changedAtNs",
    ])
    && typeof value.deviceId === "string" && /^\d{1,64}$/u.test(value.deviceId)
    && typeof value.fileId === "string" && /^\d{1,64}$/u.test(value.fileId)
    && typeof value.mode === "number" && Number.isSafeInteger(value.mode) && value.mode > 0
    && typeof value.uid === "number" && Number.isSafeInteger(value.uid) && value.uid >= 0
    && typeof value.gid === "number" && Number.isSafeInteger(value.gid) && value.gid >= 0
    && value.nlink === 1
    && typeof value.modifiedAtNs === "string" && /^\d{1,32}$/u.test(value.modifiedAtNs)
    && typeof value.changedAtNs === "string" && /^\d{1,32}$/u.test(value.changedAtNs);
}

function parsePreMuxExportReceipt(value: unknown): PreMuxExportReceipt | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "durationArg", "source", "export", "byteIdentical", "copy", "code",
  ]) || value.schemaVersion !== "ltx-studio-lipforcing-premux-export-receipt.v1"
    || !validRawMuxDurationArg(value.durationArg)
    || !isRecord(value.source) || !exactKeys(value.source, ["sha256", "sizeBytes", "revision"])
    || !isRecord(value.export) || !exactKeys(value.export, ["sha256", "sizeBytes", "revision"])
    || typeof value.source.sha256 !== "string" || !SHA256_PATTERN.test(value.source.sha256)
    || typeof value.source.sizeBytes !== "number" || !Number.isSafeInteger(value.source.sizeBytes) || value.source.sizeBytes <= 0
    || !validPreMuxExportRevision(value.source.revision)
    || typeof value.export.sha256 !== "string" || !SHA256_PATTERN.test(value.export.sha256)
    || typeof value.export.sizeBytes !== "number" || !Number.isSafeInteger(value.export.sizeBytes) || value.export.sizeBytes <= 0
    || !validPreMuxExportRevision(value.export.revision)
    || value.byteIdentical !== true
    || !isRecord(value.copy) || !exactKeys(value.copy, ["method", "command"])
    || value.copy.method !== "python-os-read-write-held-fd-exclusive-v1"
    || !isRecord(value.copy.command) || !exactKeys(value.copy.command, ["argv", "sha256"])
    || !Array.isArray(value.copy.command.argv)
    || !value.copy.command.argv.every((argument) =>
      typeof argument === "string" && argument.length <= 4096 && !argument.includes("\0"))
    || typeof value.copy.command.sha256 !== "string" || !SHA256_PATTERN.test(value.copy.command.sha256)
    || rawMuxCommandSha256(value.copy.command.argv as string[]) !== value.copy.command.sha256
    || !isRecord(value.code) || !exactKeys(value.code, ["rawOutputMuxSha256", "containerRunnerSha256"])
    || typeof value.code.rawOutputMuxSha256 !== "string" || !SHA256_PATTERN.test(value.code.rawOutputMuxSha256)
    || typeof value.code.containerRunnerSha256 !== "string" || !SHA256_PATTERN.test(value.code.containerRunnerSha256)) {
    return null;
  }
  const argv = value.copy.command.argv;
  const sourceFd = argv[2] ?? "";
  if (canonicalJson(argv) !== canonicalJson([
    "ltx-studio-internal-held-fd-copy-v1",
    "--source", sourceFd,
    "--output", "/paired/pre-mux-crf13.mp4",
    "--exclusive",
  ]) || !/^\/proc\/self\/fd\/\d+$/u.test(sourceFd)) return null;
  return structuredClone(value) as PreMuxExportReceipt;
}

function currentTrustedCodeSha256(path: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = revision(fstatSync(descriptor));
    if ((before.mode & 0o170000) !== 0o100000
      || (before.uid === 0 && (before.mode & 0o022) !== 0)
      || (before.uid !== 0 && before.uid !== currentUid())) {
      throw new Error(`Raw-Mux-Codeartefakt ist nicht vertrauenswürdig gebunden: ${path}`);
    }
    const sha256 = hashDescriptor(descriptor, before.sizeBytes);
    const after = revision(fstatSync(descriptor));
    const pathname = lstatSync(path);
    if (!sameRevision(before, after)
      || pathname.isSymbolicLink()
      || !sameRevision(after, revision(pathname))) {
      throw new Error(`Raw-Mux-Codeartefakt driftete während der FD-Prüfung: ${path}`);
    }
    return sha256;
  } finally {
    closeSync(descriptor);
  }
}

function verifyPreMuxExportReceiptAgainstFiles(
  receipt: PreMuxExportReceipt,
  preMux: ExecutionFileBinding,
  pairReceipt: RawMuxPairReceipt,
): void {
  const descriptor = openSync(preMux.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    const pathname = lstatSync(preMux.path, { bigint: true });
    const actualRevision: PreMuxExportReceiptRevision = {
      deviceId: stats.dev.toString(),
      fileId: stats.ino.toString(),
      mode: Number(stats.mode),
      uid: Number(stats.uid),
      gid: Number(stats.gid),
      nlink: 1,
      modifiedAtNs: stats.mtimeNs.toString(),
      changedAtNs: stats.ctimeNs.toString(),
    };
    if (!stats.isFile() || stats.nlink !== 1n
      || pathname.isSymbolicLink()
      || pathname.dev !== stats.dev || pathname.ino !== stats.ino
      || receipt.durationArg !== pairReceipt.durationArg
      || receipt.source.sha256 !== preMux.sha256
      || receipt.export.sha256 !== preMux.sha256
      || receipt.source.sizeBytes !== preMux.revision.sizeBytes
      || receipt.export.sizeBytes !== preMux.revision.sizeBytes
      || canonicalJson(receipt.export.revision) !== canonicalJson(actualRevision)
      || receipt.code.rawOutputMuxSha256
        !== currentTrustedCodeSha256(join(appRoot, "deploy", "lipforcing", "raw_output_mux.py"))
      || receipt.code.containerRunnerSha256
        !== currentTrustedCodeSha256(join(appRoot, "deploy", "lipforcing", "container_runner.py"))) {
      throw new Error("Pre-Mux-Export-Receipt beweist nicht die byteidentische gehaltene Containerquelle und den aktuellen gepinnten Patchcode.");
    }
  } finally {
    closeSync(descriptor);
  }
}

function verifyReceiptAgainstFiles(
  receipt: RawMuxPairReceipt,
  files: {
    preMux: ExecutionFileBinding;
    controlAudio: ExecutionFileBinding;
    baselineRaw: ExecutionFileBinding;
    candidateRaw: ExecutionFileBinding;
  },
): void {
  const currentFfmpeg = currentExecutableIdentity("/usr/bin/ffmpeg");
  const baselineArgv = receipt.commands.baseline.argv;
  const candidateArgv = receipt.commands.candidate.argv;
  const videoFd = baselineArgv[6];
  const audioFd = baselineArgv[8];
  const fdPattern = /^\/proc\/self\/fd\/\d+$/;
  const baselineOutput = baselineArgv.at(-1) ?? "";
  const candidateOutput = candidateArgv.at(-1) ?? "";
  const baselineOutputMatch = /^\/proc\/self\/fd\/(\d+)\/baseline-raw\.mp4$/u.exec(baselineOutput);
  const candidateOutputMatch = /^\/proc\/self\/fd\/(\d+)\/candidate-raw\.mp4$/u.exec(candidateOutput);
  const commonPrefix = [
    "/usr/bin/ffmpeg", "-n", "-loglevel", "error", "-nostdin",
    "-i", videoFd, "-i", audioFd,
    "-map", "0:v:0", "-map", "1:a:0",
  ];
  const commonSuffix = ["-c:a", "aac", "-q:v", "0", "-q:a", "0"];
  const duration = receipt.durationArg === null ? [] : ["-t", receipt.durationArg];
  const expectedBaseline = [
    ...commonPrefix,
    "-c:v", "libx264", "-crf", "18",
    ...commonSuffix,
    ...duration,
    baselineOutput,
  ];
  const expectedCandidate = [
    ...commonPrefix,
    "-c:v", "copy",
    ...commonSuffix,
    ...duration,
    candidateOutput,
  ];
  if (!fdPattern.test(videoFd ?? "")
    || !fdPattern.test(audioFd ?? "")
    || videoFd === audioFd
    || !baselineOutputMatch
    || !candidateOutputMatch
    || baselineOutputMatch[1] !== candidateOutputMatch[1]
    || new Set([
      videoFd,
      audioFd,
      `/proc/self/fd/${baselineOutputMatch?.[1] ?? ""}`,
    ]).size !== 3
    || canonicalJson(baselineArgv) !== canonicalJson(expectedBaseline)
    || canonicalJson(candidateArgv) !== canonicalJson(expectedCandidate)
    || canonicalJson(receipt.ffmpeg) !== canonicalJson(currentFfmpeg)
    || receipt.inputs.preMuxSourceSha256 !== files.preMux.sha256
    || receipt.inputs.preMuxExportSha256 !== files.preMux.sha256
    || receipt.inputs.preMuxSizeBytes !== files.preMux.revision.sizeBytes
    || receipt.inputs.audioSha256 !== files.controlAudio.sha256
    || receipt.inputs.audioSizeBytes !== files.controlAudio.revision.sizeBytes
    || receipt.outputs.baselineRaw.sha256 !== files.baselineRaw.sha256
    || receipt.outputs.baselineRaw.sizeBytes !== files.baselineRaw.revision.sizeBytes
    || receipt.outputs.candidateRaw.sha256 !== files.candidateRaw.sha256
    || receipt.outputs.candidateRaw.sizeBytes !== files.candidateRaw.revision.sizeBytes) {
    throw new Error("Raw-Mux-Paar-Receipt beweist nicht exakt denselben Pre-Mux-/Audio-Input und nur den registrierten A/B-Codecwechsel.");
  }
}

function validCommandReceipt(value: unknown): value is { argv: string[]; sha256: string } {
  return isRecord(value)
    && exactKeys(value, ["argv", "sha256"])
    && Array.isArray(value.argv)
    && value.argv.length >= 8
    && value.argv.length <= 128
    && value.argv.every((argument) =>
      typeof argument === "string" && argument.length <= 4096 && !argument.includes("\0"))
    && typeof value.sha256 === "string"
    && SHA256_PATTERN.test(value.sha256)
    && rawMuxCommandSha256(value.argv) === value.sha256;
}

function validExecutableReceipt<Path extends "/usr/bin/ffmpeg" | "/usr/bin/ffprobe">(
  value: unknown,
  path: Path,
): value is HostExecutableIdentity<Path> {
  return isRecord(value)
    && exactKeys(value, ["path", "sha256", "version"])
    && value.path === path
    && typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)
    && typeof value.version === "string" && value.version.length >= 1 && value.version.length <= 1000;
}

function validTimelinePayload(value: unknown): value is {
  frameRate: string;
  frameCount: number;
  width: number;
  height: number;
  hasAudio: true;
} {
  return isRecord(value)
    && exactKeys(value, ["frameRate", "frameCount", "width", "height", "hasAudio"])
    && validRawMuxReplayTimeline(value);
}

function parsePairedTimelineReceipt(value: unknown): PairedTimelineReceipt | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "rawMuxReceiptSha256", "programAudioDelayMs", "inputs", "executables",
    "commands", "timeline", "decodedPcm", "outputs",
  ]) || value.schemaVersion !== "ltx-studio-lipforcing-paired-timeline-receipt.v1"
    || typeof value.rawMuxReceiptSha256 !== "string" || !SHA256_PATTERN.test(value.rawMuxReceiptSha256)
    || typeof value.programAudioDelayMs !== "number" || !Number.isInteger(value.programAudioDelayMs)
    || value.programAudioDelayMs < -500 || value.programAudioDelayMs > 500
    || !isRecord(value.inputs) || !exactKeys(value.inputs, ["source", "programAudio"])
    || !validHashSize(value.inputs.source) || !validHashSize(value.inputs.programAudio)
    || !isRecord(value.executables) || !exactKeys(value.executables, ["before", "after"])
    || !isRecord(value.executables.before) || !exactKeys(value.executables.before, ["ffmpeg", "ffprobe"])
    || !isRecord(value.executables.after) || !exactKeys(value.executables.after, ["ffmpeg", "ffprobe"])
    || !validExecutableReceipt(value.executables.before.ffmpeg, "/usr/bin/ffmpeg")
    || !validExecutableReceipt(value.executables.before.ffprobe, "/usr/bin/ffprobe")
    || !validExecutableReceipt(value.executables.after.ffmpeg, "/usr/bin/ffmpeg")
    || !validExecutableReceipt(value.executables.after.ffprobe, "/usr/bin/ffprobe")
    || !isRecord(value.commands) || !exactKeys(value.commands, ["baseline", "candidate"])
    || !validCommandReceipt(value.commands.baseline) || !validCommandReceipt(value.commands.candidate)
    || !isRecord(value.timeline) || !exactKeys(value.timeline, ["baseline", "candidate"])
    || !validTimelinePayload(value.timeline.baseline) || !validTimelinePayload(value.timeline.candidate)
    || !isRecord(value.decodedPcm) || !exactKeys(value.decodedPcm, ["format", "commands"])
    || value.decodedPcm.format !== "s16le-mono-48000"
    || !isRecord(value.decodedPcm.commands)
    || !exactKeys(value.decodedPcm.commands, ["baseline", "candidate"])
    || !validCommandReceipt(value.decodedPcm.commands.baseline)
    || !validCommandReceipt(value.decodedPcm.commands.candidate)
    || !isRecord(value.outputs) || !exactKeys(value.outputs, ["baselineFinal", "candidateFinal"])
    || !validFinalOutputReceipt(value.outputs.baselineFinal)
    || !validFinalOutputReceipt(value.outputs.candidateFinal)) return null;
  return structuredClone(value) as PairedTimelineReceipt;
}

function currentExecutableIdentity<Path extends "/usr/bin/ffmpeg" | "/usr/bin/ffprobe">(
  path: Path,
): HostExecutableIdentity<Path> {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = revision(fstatSync(descriptor));
    if ((before.mode & 0o170000) !== 0o100000
      || (before.mode & 0o111) === 0
      || (before.mode & 0o022) !== 0
      || before.uid !== 0) {
      throw new Error(`Host-TCB-Executable ist nicht root-eigen, regulär, unveränderbar oder ausführbar: ${path}`);
    }
    const sha256 = hashDescriptor(descriptor, before.sizeBytes);
    const pathname = lstatSync(path);
    if (pathname.isSymbolicLink() || !sameRevision(before, revision(pathname))) {
      throw new Error(`Host-TCB-Executable-Pfad driftete während der FD-Bindung: ${path}`);
    }
    const result = spawnSync("/proc/self/fd/3", ["-version"], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      shell: false,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", descriptor],
    });
    const after = revision(fstatSync(descriptor));
    const version = result.status === 0
      ? `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? ""
      : "";
    if (!version || !sameRevision(before, after)
      || hashDescriptor(descriptor, after.sizeBytes) !== sha256) {
      throw new Error(`Host-TCB-Executable-Version/Bytes drifteten während der gehaltenen FD-Prüfung: ${path}`);
    }
    return { path, sha256, version };
  } finally {
    closeSync(descriptor);
  }
}

function expectedTimelineCommand(
  files: RawMuxBaselineAuthority["files"],
  timeline: PairedTimelineReceipt["timeline"]["baseline"],
  programAudioDelayMs: number,
  arm: "baseline" | "candidate",
  refinedFdPath: string,
  sourceFdPath: string,
  programAudioFdPath: string,
): string[] {
  const [rateNumeratorText, rateDenominatorText] = timeline.frameRate.split("/");
  const rateNumerator = Number(rateNumeratorText);
  const rateDenominator = Number(rateDenominatorText);
  const durationSeconds = timeline.frameCount * rateDenominator / rateNumerator;
  const padSeconds = Math.ceil(durationSeconds) + 1;
  const timingFilter = programAudioDelayMs > 0
    ? `adelay=${programAudioDelayMs}:all=1,`
    : programAudioDelayMs < 0
      ? `atrim=start=${(Math.abs(programAudioDelayMs) / 1000).toFixed(9)},asetpts=PTS-STARTPTS,`
      : "";
  const videoFilter = `fps=fps=${timeline.frameRate}:round=near,`
    + `tpad=stop_mode=clone:stop_duration=${padSeconds},`
    + `trim=end_frame=${timeline.frameCount},setpts=N/(${timeline.frameRate}*TB)`;
  const output = arm === "baseline" ? files.baselineFinal.path : files.candidateFinal.path;
  return [
    "/usr/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-n",
    "-i", refinedFdPath,
    "-i", sourceFdPath,
    "-i", programAudioFdPath,
    "-map", "0:v:0", "-map", "2:a:0",
    "-vf", videoFilter,
    "-frames:v", String(timeline.frameCount),
    "-c:v", "libx264", "-preset", "medium", "-crf", "8",
    "-pix_fmt", "yuv420p",
    "-af", `${timingFilter}aresample=48000,apad,`
      + `atrim=duration=${durationSeconds.toFixed(9)},asetpts=PTS-STARTPTS`,
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    output,
  ];
}

function expectedDecodedPcmCommand(finalFdPath: string): string[] {
  return [
    "/usr/bin/ffmpeg", "-v", "error", "-i", finalFdPath,
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000",
    "-f", "s16le", "pipe:1",
  ];
}

function decodedPcmSha256(
  binding: ExecutionFileBinding,
  expectedFfmpeg: HostExecutableIdentity<"/usr/bin/ffmpeg">,
): string {
  const ffmpegDescriptor = openSync("/usr/bin/ffmpeg", constants.O_RDONLY | constants.O_NOFOLLOW);
  const mediaDescriptor = openSync(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const ffmpegBefore = revision(fstatSync(ffmpegDescriptor));
    const mediaBefore = revision(fstatSync(mediaDescriptor));
    if (ffmpegBefore.uid !== 0
      || (ffmpegBefore.mode & 0o022) !== 0
      || (ffmpegBefore.mode & 0o111) === 0
      || !sameRevision(mediaBefore, binding.revision)
      || hashDescriptor(ffmpegDescriptor, ffmpegBefore.sizeBytes) !== expectedFfmpeg.sha256
      || hashDescriptor(mediaDescriptor, mediaBefore.sizeBytes) !== binding.sha256) {
      throw new Error("PCM-Prüfung konnte ihre gehaltenen FFmpeg-/Medien-FDs nicht binden.");
    }
    const result = spawnSync("/proc/self/fd/3", [
      "-v", "error", "-i", "/proc/self/fd/4",
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000",
      "-f", "s16le", "pipe:1",
    ], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      shell: false,
      timeout: 120_000,
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", ffmpegDescriptor, mediaDescriptor],
    });
    const ffmpegAfter = revision(fstatSync(ffmpegDescriptor));
    const mediaAfter = revision(fstatSync(mediaDescriptor));
    const ffmpegPath = lstatSync("/usr/bin/ffmpeg");
    const mediaPath = lstatSync(binding.path);
    if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length === 0
      || !sameRevision(ffmpegBefore, ffmpegAfter)
      || !sameRevision(mediaBefore, mediaAfter)
      || ffmpegPath.isSymbolicLink() || mediaPath.isSymbolicLink()
      || !sameRevision(ffmpegAfter, revision(ffmpegPath))
      || !sameRevision(mediaAfter, revision(mediaPath))
      || hashDescriptor(ffmpegDescriptor, ffmpegAfter.sizeBytes) !== expectedFfmpeg.sha256
      || hashDescriptor(mediaDescriptor, mediaAfter.sizeBytes) !== binding.sha256) {
      throw new Error("PCM-Prüfung scheiterte oder FFmpeg/Medienbytes drifteten während des gehaltenen FD-Decodes.");
    }
    return createHash("sha256").update(result.stdout).digest("hex");
  } finally {
    closeSync(mediaDescriptor);
    closeSync(ffmpegDescriptor);
  }
}

type ProbedTimeline = {
  frameRate: string;
  frameCount: number;
  width: number;
  height: number;
  hasAudio: true;
};

type VideoPacketEvidence = {
  stream: {
    index: number;
    codecName: "h264";
    codecTagString: string;
    width: number;
    height: number;
    timeBase: string;
    extradataSize: number;
    extradataHash: string;
  };
  packets: Array<{
    streamIndex: number;
    pts: number;
    dts: number;
    duration: number;
    size: string;
    flags: string;
    dataHash: string;
  }>;
};

function reducedFrameRate(value: string): string | null {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match) return null;
  let numerator = Number(match[1]);
  let denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) return null;
  let left = numerator;
  let right = denominator;
  while (right !== 0) [left, right] = [right, left % right];
  numerator /= left;
  denominator /= left;
  return `${numerator}/${denominator}`;
}

function probeTimelineWithHeldFds(
  binding: ExecutionFileBinding,
  expectedFfprobe: HostExecutableIdentity<"/usr/bin/ffprobe">,
): ProbedTimeline {
  const ffprobeDescriptor = openSync("/usr/bin/ffprobe", constants.O_RDONLY | constants.O_NOFOLLOW);
  const mediaDescriptor = openSync(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const ffprobeBefore = revision(fstatSync(ffprobeDescriptor));
    const mediaBefore = revision(fstatSync(mediaDescriptor));
    if (ffprobeBefore.uid !== 0
      || (ffprobeBefore.mode & 0o022) !== 0
      || (ffprobeBefore.mode & 0o111) === 0
      || !sameRevision(mediaBefore, binding.revision)
      || hashDescriptor(ffprobeDescriptor, ffprobeBefore.sizeBytes) !== expectedFfprobe.sha256
      || hashDescriptor(mediaDescriptor, mediaBefore.sizeBytes) !== binding.sha256) {
      throw new Error("Timeline-Probe konnte ihre gehaltenen FFprobe-/Medien-FDs nicht binden.");
    }
    const result = spawnSync("/proc/self/fd/3", [
      "-v", "error", "-count_frames",
      "-show_entries", "stream=codec_type,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,width,height",
      "-of", "json", "/proc/self/fd/4",
    ], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      shell: false,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", ffprobeDescriptor, mediaDescriptor],
    });
    const ffprobeAfter = revision(fstatSync(ffprobeDescriptor));
    const mediaAfter = revision(fstatSync(mediaDescriptor));
    const ffprobePath = lstatSync("/usr/bin/ffprobe");
    const mediaPath = lstatSync(binding.path);
    if (result.error || result.status !== 0
      || !sameRevision(ffprobeBefore, ffprobeAfter)
      || !sameRevision(mediaBefore, mediaAfter)
      || ffprobePath.isSymbolicLink() || mediaPath.isSymbolicLink()
      || !sameRevision(ffprobeAfter, revision(ffprobePath))
      || !sameRevision(mediaAfter, revision(mediaPath))
      || hashDescriptor(ffprobeDescriptor, ffprobeAfter.sizeBytes) !== expectedFfprobe.sha256
      || hashDescriptor(mediaDescriptor, mediaAfter.sizeBytes) !== binding.sha256) {
      throw new Error("Timeline-Probe scheiterte oder FFprobe/Medienbytes drifteten während der gehaltenen FD-Prüfung.");
    }
    const payload: unknown = JSON.parse(result.stdout);
    if (!isRecord(payload) || !Array.isArray(payload.streams)) {
      throw new Error("FFprobe lieferte keine eindeutige Stream-Evidence.");
    }
    const streams = payload.streams.filter(isRecord);
    const videoStreams = streams.filter((stream) => stream.codec_type === "video");
    const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
    if (videoStreams.length !== 1 || audioStreams.length !== 1) {
      throw new Error("Timeline-Medium besitzt nicht exakt eine Video- und eine Audiospur.");
    }
    const video = videoStreams[0];
    const averageRate = typeof video.avg_frame_rate === "string" && video.avg_frame_rate !== "0/0"
      ? reducedFrameRate(video.avg_frame_rate)
      : null;
    const realRate = typeof video.r_frame_rate === "string" && video.r_frame_rate !== "0/0"
      ? reducedFrameRate(video.r_frame_rate)
      : null;
    const frameRate = averageRate ?? realRate;
    const countedFrames = typeof video.nb_read_frames === "string"
      && /^[1-9]\d*$/.test(video.nb_read_frames)
      ? Number(video.nb_read_frames)
      : 0;
    const declaredFrames = typeof video.nb_frames === "string"
      && /^[1-9]\d*$/.test(video.nb_frames)
      ? Number(video.nb_frames)
      : null;
    const frameCount = countedFrames;
    const width = typeof video.width === "number" ? video.width : 0;
    const height = typeof video.height === "number" ? video.height : 0;
    if (!frameRate
      || (averageRate !== null && realRate !== null && averageRate !== realRate)
      || (declaredFrames !== null && declaredFrames !== countedFrames)
      || !Number.isSafeInteger(frameCount) || frameCount <= 0
      || !Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0) {
      throw new Error("FFprobe-Timelinewerte sind unvollständig oder ungültig.");
    }
    return { frameRate, frameCount, width, height, hasAudio: true };
  } finally {
    closeSync(mediaDescriptor);
    closeSync(ffprobeDescriptor);
  }
}

function probeVideoPacketsWithHeldFds(
  binding: ExecutionFileBinding,
  expectedFfprobe: HostExecutableIdentity<"/usr/bin/ffprobe">,
  expectedAudioStreams: 0 | 1,
): VideoPacketEvidence {
  const ffprobeDescriptor = openSync("/usr/bin/ffprobe", constants.O_RDONLY | constants.O_NOFOLLOW);
  const mediaDescriptor = openSync(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const ffprobeBefore = revision(fstatSync(ffprobeDescriptor));
    const mediaBefore = revision(fstatSync(mediaDescriptor));
    if (ffprobeBefore.uid !== 0
      || (ffprobeBefore.mode & 0o022) !== 0
      || (ffprobeBefore.mode & 0o111) === 0
      || !sameRevision(mediaBefore, binding.revision)
      || hashDescriptor(ffprobeDescriptor, ffprobeBefore.sizeBytes) !== expectedFfprobe.sha256
      || hashDescriptor(mediaDescriptor, mediaBefore.sizeBytes) !== binding.sha256) {
      throw new Error("Video-Paketprobe konnte ihre gehaltenen FFprobe-/Medien-FDs nicht binden.");
    }
    const result = spawnSync("/proc/self/fd/3", [
      "-v", "error",
      "-show_packets", "-show_streams", "-show_data_hash", "sha256",
      "-show_entries",
      "stream=index,codec_type,codec_name,codec_tag_string,width,height,time_base,extradata_size,extradata_hash:packet=codec_type,stream_index,pts,dts,duration,size,flags,data_hash",
      "-of", "json", "/proc/self/fd/4",
    ], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      shell: false,
      timeout: 120_000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", ffprobeDescriptor, mediaDescriptor],
    });
    const ffprobeAfter = revision(fstatSync(ffprobeDescriptor));
    const mediaAfter = revision(fstatSync(mediaDescriptor));
    const ffprobePath = lstatSync("/usr/bin/ffprobe");
    const mediaPath = lstatSync(binding.path);
    if (result.error || result.status !== 0
      || !sameRevision(ffprobeBefore, ffprobeAfter)
      || !sameRevision(mediaBefore, mediaAfter)
      || ffprobePath.isSymbolicLink() || mediaPath.isSymbolicLink()
      || !sameRevision(ffprobeAfter, revision(ffprobePath))
      || !sameRevision(mediaAfter, revision(mediaPath))
      || hashDescriptor(ffprobeDescriptor, ffprobeAfter.sizeBytes) !== expectedFfprobe.sha256
      || hashDescriptor(mediaDescriptor, mediaAfter.sizeBytes) !== binding.sha256) {
      throw new Error("Video-Paketprobe scheiterte oder FFprobe/Medienbytes drifteten während der gehaltenen FD-Prüfung.");
    }
    const payload: unknown = JSON.parse(result.stdout);
    if (!isRecord(payload) || !Array.isArray(payload.streams) || !Array.isArray(payload.packets)
      || !payload.streams.every(isRecord) || !payload.packets.every(isRecord)) {
      throw new Error("FFprobe lieferte keine eindeutige Video-Paketevidence.");
    }
    const videoStreams = payload.streams.filter((stream) => stream.codec_type === "video");
    const audioStreams = payload.streams.filter((stream) => stream.codec_type === "audio");
    if (videoStreams.length !== 1
      || audioStreams.length !== expectedAudioStreams
      || payload.streams.length !== 1 + expectedAudioStreams
      || audioStreams.some((stream) => stream.codec_name !== "aac")) {
      throw new Error("Raw-Mux-Medium besitzt nicht die registrierte Video-/Audiospuranzahl.");
    }
    const stream = videoStreams[0];
    const index = typeof stream.index === "number" && Number.isSafeInteger(stream.index)
      ? stream.index
      : -1;
    const width = typeof stream.width === "number" ? stream.width : 0;
    const height = typeof stream.height === "number" ? stream.height : 0;
    const extradataSize = typeof stream.extradata_size === "number" ? stream.extradata_size : 0;
    const codecTagString = typeof stream.codec_tag_string === "string" ? stream.codec_tag_string : "";
    const timeBase = typeof stream.time_base === "string" ? stream.time_base : "";
    const extradataHash = typeof stream.extradata_hash === "string" ? stream.extradata_hash : "";
    if (stream.codec_name !== "h264"
      || index < 0
      || !Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0
      || !/^[A-Za-z0-9._-]{1,32}$/u.test(codecTagString)
      || reducedFrameRate(timeBase) === null
      || !Number.isSafeInteger(extradataSize) || extradataSize <= 0
      || !/^SHA256:[0-9a-f]{64}$/u.test(extradataHash)) {
      throw new Error("Raw-Mux-Videostream ist nicht der registrierte gebundene H.264-Stream.");
    }
    const registeredStreamIndexes = new Map(
      payload.streams.map((entry) => [entry.index, entry.codec_type]),
    );
    if (payload.packets.some((packet) =>
      (packet.codec_type !== "video" && packet.codec_type !== "audio")
      || registeredStreamIndexes.get(packet.stream_index) !== packet.codec_type)) {
      throw new Error("Raw-Mux-Medium enthält Pakete außerhalb der exakt registrierten Streams.");
    }
    const videoPackets = payload.packets.filter((packet) => packet.codec_type === "video");
    if (videoPackets.length < 1) throw new Error("Raw-Mux-Videostream enthält keine Pakete.");
    const packets = videoPackets.map((packet) => {
      const streamIndex = typeof packet.stream_index === "number" ? packet.stream_index : -1;
      const pts = typeof packet.pts === "number" ? packet.pts : Number.NaN;
      const dts = typeof packet.dts === "number" ? packet.dts : Number.NaN;
      const duration = typeof packet.duration === "number" ? packet.duration : Number.NaN;
      const size = typeof packet.size === "string" ? packet.size : "";
      const flags = typeof packet.flags === "string" ? packet.flags : "";
      const dataHash = typeof packet.data_hash === "string" ? packet.data_hash : "";
      if (streamIndex !== index
        || !Number.isSafeInteger(pts)
        || !Number.isSafeInteger(dts)
        || !Number.isSafeInteger(duration) || duration <= 0
        || !/^[1-9]\d*$/u.test(size)
        || !/^[A-Z_]{1,16}$/u.test(flags)
        || !/^SHA256:[0-9a-f]{64}$/u.test(dataHash)) {
        throw new Error("Raw-Mux-Videopaket ist unvollständig oder nicht eindeutig gehasht.");
      }
      return { streamIndex, pts, dts, duration, size, flags, dataHash };
    });
    return {
      stream: {
        index,
        codecName: "h264",
        codecTagString,
        width,
        height,
        timeBase,
        extradataSize,
        extradataHash,
      },
      packets,
    };
  } finally {
    closeSync(mediaDescriptor);
    closeSync(ffprobeDescriptor);
  }
}

function rawMuxPacketTimeline(evidence: VideoPacketEvidence): unknown {
  return {
    streamIndex: evidence.stream.index,
    codecName: evidence.stream.codecName,
    codecTagString: evidence.stream.codecTagString,
    width: evidence.stream.width,
    height: evidence.stream.height,
    timeBase: evidence.stream.timeBase,
    presentation: evidence.packets
      .map(({ pts, duration }) => ({ pts, duration }))
      .sort((left, right) => left.pts - right.pts || left.duration - right.duration),
    decodeTimestamps: evidence.packets.map(({ dts }) => dts).sort((left, right) => left - right),
  };
}

function verifyRawMuxPacketCausality(files: RawMuxBaselineAuthority["files"]): void {
  const currentFfprobe = currentExecutableIdentity("/usr/bin/ffprobe");
  const preMux = probeVideoPacketsWithHeldFds(files.preMux, currentFfprobe, 0);
  const baseline = probeVideoPacketsWithHeldFds(files.baselineRaw, currentFfprobe, 1);
  const candidate = probeVideoPacketsWithHeldFds(files.candidateRaw, currentFfprobe, 1);
  if (canonicalJson(candidate) !== canonicalJson(preMux)) {
    throw new Error("Raw-Mux-Kandidat ist kein exakter H.264-Paketstrom des gebundenen CRF13-Pre-Mux-Artefakts.");
  }
  if (canonicalJson(rawMuxPacketTimeline(baseline)) !== canonicalJson(rawMuxPacketTimeline(preMux))) {
    throw new Error("Raw-Mux-Baseline bewahrt Geometrie und Paket-Timeline des gebundenen CRF13-Pre-Mux-Artefakts nicht.");
  }
  if (canonicalJson(baseline) === canonicalJson(preMux)) {
    throw new Error("Raw-Mux-Baseline beweist keine eigenständige CRF18-Transkodierung.");
  }
}

function verifyTimelineReceiptAgainstFiles(
  receipt: PairedTimelineReceipt,
  files: RawMuxBaselineAuthority["files"],
  programAudioDelayMs: number,
): void {
  const baselineArgv = receipt.commands.baseline.argv;
  const candidateArgv = receipt.commands.candidate.argv;
  const baselineRefinedFd = baselineArgv[6] ?? "";
  const candidateRefinedFd = candidateArgv[6] ?? "";
  const sourceFd = baselineArgv[8] ?? "";
  const programAudioFd = baselineArgv[10] ?? "";
  const fdPathPattern = /^\/proc\/self\/fd\/[0-9]+$/;
  const expectedBaselineCommand = expectedTimelineCommand(
    files,
    receipt.timeline.baseline,
    programAudioDelayMs,
    "baseline",
    baselineRefinedFd,
    sourceFd,
    programAudioFd,
  );
  const expectedCandidateCommand = expectedTimelineCommand(
    files,
    receipt.timeline.candidate,
    programAudioDelayMs,
    "candidate",
    candidateRefinedFd,
    sourceFd,
    programAudioFd,
  );
  const baselinePcmFd = receipt.decodedPcm.commands.baseline.argv[4] ?? "";
  const candidatePcmFd = receipt.decodedPcm.commands.candidate.argv[4] ?? "";
  const expectedBaselinePcmCommand = expectedDecodedPcmCommand(baselinePcmFd);
  const expectedCandidatePcmCommand = expectedDecodedPcmCommand(candidatePcmFd);
  const currentFfmpeg = currentExecutableIdentity("/usr/bin/ffmpeg");
  const currentFfprobe = currentExecutableIdentity("/usr/bin/ffprobe");
  if (!fdPathPattern.test(baselineRefinedFd)
    || !fdPathPattern.test(candidateRefinedFd)
    || !fdPathPattern.test(sourceFd)
    || !fdPathPattern.test(programAudioFd)
    || new Set([baselineRefinedFd, candidateRefinedFd, sourceFd, programAudioFd]).size !== 4
    || candidateArgv[8] !== sourceFd
    || candidateArgv[10] !== programAudioFd
    || !fdPathPattern.test(baselinePcmFd)
    || !fdPathPattern.test(candidatePcmFd)
    || baselinePcmFd === candidatePcmFd
    || canonicalJson(receipt.commands.baseline.argv) !== canonicalJson(expectedBaselineCommand)
    || canonicalJson(receipt.commands.candidate.argv) !== canonicalJson(expectedCandidateCommand)
    || canonicalJson(receipt.decodedPcm.commands.baseline.argv) !== canonicalJson(expectedBaselinePcmCommand)
    || canonicalJson(receipt.decodedPcm.commands.candidate.argv) !== canonicalJson(expectedCandidatePcmCommand)
    || receipt.rawMuxReceiptSha256 !== files.receipt.sha256
    || receipt.programAudioDelayMs !== programAudioDelayMs
    || receipt.inputs.source.sha256 !== files.ltxBase.sha256
    || receipt.inputs.source.sizeBytes !== files.ltxBase.revision.sizeBytes
    || receipt.inputs.programAudio.sha256 !== files.programAudio.sha256
    || receipt.inputs.programAudio.sizeBytes !== files.programAudio.revision.sizeBytes
    || canonicalJson(receipt.executables.before) !== canonicalJson(receipt.executables.after)
    || canonicalJson(receipt.executables.after.ffmpeg) !== canonicalJson(currentFfmpeg)
    || canonicalJson(receipt.executables.after.ffprobe) !== canonicalJson(currentFfprobe)
    || canonicalJson(receipt.timeline.baseline) !== canonicalJson(receipt.timeline.candidate)
    || receipt.outputs.baselineFinal.sha256 !== files.baselineFinal.sha256
    || receipt.outputs.baselineFinal.sizeBytes !== files.baselineFinal.revision.sizeBytes
    || receipt.outputs.candidateFinal.sha256 !== files.candidateFinal.sha256
    || receipt.outputs.candidateFinal.sizeBytes !== files.candidateFinal.revision.sizeBytes
    || receipt.outputs.baselineFinal.decodedPcmSha256
      !== receipt.outputs.candidateFinal.decodedPcmSha256) {
    throw new Error("Timeline-Receipt beweist keine identische, unveränderte Host-Timeline für beide Raw-Mux-Arme.");
  }
  const baselinePcmSha256 = decodedPcmSha256(files.baselineFinal, currentFfmpeg);
  const candidatePcmSha256 = decodedPcmSha256(files.candidateFinal, currentFfmpeg);
  if (baselinePcmSha256 !== receipt.outputs.baselineFinal.decodedPcmSha256
    || candidatePcmSha256 !== receipt.outputs.candidateFinal.decodedPcmSha256
    || baselinePcmSha256 !== candidatePcmSha256) {
    throw new Error("Timeline-Receipt behauptet nicht die unabhängig dekodierten identischen A/B-PCM-Audiobytes.");
  }
  const sourceTimeline = probeTimelineWithHeldFds(files.ltxBase, currentFfprobe);
  const baselineTimeline = probeTimelineWithHeldFds(files.baselineFinal, currentFfprobe);
  const candidateTimeline = probeTimelineWithHeldFds(files.candidateFinal, currentFfprobe);
  if (canonicalJson(sourceTimeline) !== canonicalJson(receipt.timeline.baseline)
    || canonicalJson(baselineTimeline) !== canonicalJson(receipt.timeline.baseline)
    || canonicalJson(candidateTimeline) !== canonicalJson(receipt.timeline.candidate)) {
    throw new Error("Timeline-Receipt widerspricht der unabhängig gemessenen Source-/A-/B-Timeline.");
  }
}

function verifyTimelineReplayAgainstFiles(
  verificationRoot: string,
  receipt: PairedTimelineReceipt,
  files: RawMuxBaselineAuthority["files"],
  programAudioDelayMs: number,
): void {
  const evidence = verifyRawMuxTimelineReplay({
    verificationRoot,
    files: {
      baselineRaw: files.baselineRaw,
      candidateRaw: files.candidateRaw,
      ltxBase: files.ltxBase,
      programAudio: files.programAudio,
      baselineFinal: files.baselineFinal,
      candidateFinal: files.candidateFinal,
    },
    timeline: receipt.timeline.baseline,
    programAudioDelayMs,
  });
  if (evidence.ffmpegSha256 !== receipt.executables.after.ffmpeg.sha256
    || evidence.ffprobeSha256 !== receipt.executables.after.ffprobe.sha256
    || canonicalJson(evidence.timeline) !== canonicalJson(receipt.timeline.baseline)
    || evidence.programAudioDelayMs !== programAudioDelayMs
    || evidence.baselineFinalSha256 !== files.baselineFinal.sha256
    || evidence.candidateFinalSha256 !== files.candidateFinal.sha256) {
    throw new Error("Timeline-Replay-Evidence widerspricht dem strikt gebundenen Timeline-Receipt.");
  }
}

function verifyRawReplayAgainstFiles(
  verificationRoot: string,
  receipt: RawMuxPairReceipt,
  timelineReceipt: PairedTimelineReceipt,
  files: RawMuxBaselineAuthority["files"],
): void {
  const evidence = verifyRawMuxRawReplay({
    verificationRoot,
    files: {
      preMux: files.preMux,
      audio: files.controlAudio,
      baselineRaw: files.baselineRaw,
      candidateRaw: files.candidateRaw,
    },
    receipt,
  });
  if (evidence.ffmpegSha256 !== receipt.ffmpeg.sha256
    || evidence.ffprobeSha256 !== timelineReceipt.executables.after.ffprobe.sha256
    || evidence.durationArg !== receipt.durationArg
    || evidence.baselineRawSha256 !== files.baselineRaw.sha256
    || evidence.candidateRawSha256 !== files.candidateRaw.sha256) {
    throw new Error("Raw-Mux-Replay-Evidence widerspricht den strikt gebundenen Pair-/Timeline-Receipts.");
  }
}

function atomicAuthorityFile(path: string, authority: RawMuxBaselineAuthority): void {
  const descriptor = openSync(path, "wx", 0o400);
  try {
    writeFileSync(descriptor, `${JSON.stringify(authority, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function createRawMuxBaselineAuthority(input: {
  paths: RawMuxPairPaths;
  baselineFinalPath: string;
  experimentId: string;
  protocolSha256: string;
  baselineJobId: string;
  baselineOutputName: string;
  baselineRequestSha256: string;
  candidateRequestSha256: string;
  containerImageFingerprint: string;
  mouthDelayMs: number;
  programAudioDelayMs: number;
  createdAt?: string;
}): RawMuxBaselineAuthority {
  const expectedRoot = resolve(input.paths.root);
  const rootStats = lstatSync(expectedRoot);
  if (rootStats.isSymbolicLink()
    || !rootStats.isDirectory()
    || Number(rootStats.uid) !== currentUid()
    || (rootStats.mode & 0o077) !== 0) {
    throw new Error("Privates Raw-Mux-Paarverzeichnis ist nicht owner-exklusiv oder kein echtes Verzeichnis.");
  }
  for (const path of [
    input.paths.preMux,
    input.paths.preMuxReceipt,
    input.paths.baselineRaw,
    input.paths.candidateRaw,
    input.paths.candidateFinal,
    input.paths.receipt,
    input.paths.timelineReceipt,
    input.paths.authority,
  ]) {
    if (dirname(resolve(path)) !== expectedRoot) {
      throw new Error("Raw-Mux-Paarpfad verlässt das deterministische private Paarverzeichnis.");
    }
  }
  try {
    lstatSync(input.paths.authority);
    throw new Error("Raw-Mux-Baseline-Authority existiert bereits; Überschreiben ist nicht zulässig.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const initialFiles = {
    preMux: captureRawMuxPairFile(input.paths.preMux),
    preMuxReceipt: captureRawMuxPairFile(input.paths.preMuxReceipt),
    baselineRaw: captureRawMuxPairFile(input.paths.baselineRaw),
    candidateRaw: captureRawMuxPairFile(input.paths.candidateRaw),
    candidateFinal: captureRawMuxPairFile(input.paths.candidateFinal),
    receipt: captureRawMuxPairFile(input.paths.receipt),
    timelineReceipt: captureRawMuxPairFile(input.paths.timelineReceipt),
    ltxBase: captureRawMuxPairFile(input.paths.ltxBase),
    controlAudio: captureRawMuxPairFile(input.paths.controlAudio),
    programAudio: captureRawMuxPairFile(input.paths.programAudio),
    baselineFinal: captureRawMuxPairFile(input.baselineFinalPath),
  };
  const boundFiles = Object.fromEntries(
    Object.entries(initialFiles).map(([key, binding]) => [key, sealRawMuxPairFile(binding)]),
  ) as RawMuxBaselineAuthority["files"];
  for (const [key, initial] of Object.entries(initialFiles)) {
    const sealed = boundFiles[key as keyof RawMuxBaselineAuthority["files"]];
    if (!sameFileBytesAndIdentity(initial, sealed)) {
      throw new Error(`Raw-Mux-Paarartefakt verlor zwischen Erfassung und FD-Seal seine Identität: ${key}`);
    }
  }
  const receipt = parseRawMuxPairReceipt(readSmallJsonFromBinding(boundFiles.receipt, 256 * 1024));
  if (!receipt) throw new Error("Raw-Mux-Paar-Receipt ist strukturell oder kryptografisch ungültig.");
  verifyReceiptAgainstFiles(receipt, boundFiles);
  const preMuxReceipt = parsePreMuxExportReceipt(
    readSmallJsonFromBinding(boundFiles.preMuxReceipt, 256 * 1024),
  );
  if (!preMuxReceipt) throw new Error("Pre-Mux-Export-Receipt ist strukturell oder kryptografisch ungültig.");
  verifyPreMuxExportReceiptAgainstFiles(preMuxReceipt, boundFiles.preMux, receipt);
  verifyRawMuxPacketCausality(boundFiles);
  const timelineReceipt = parsePairedTimelineReceipt(
    readSmallJsonFromBinding(boundFiles.timelineReceipt, 256 * 1024),
  );
  if (!timelineReceipt) throw new Error("Raw-Mux-Timeline-Receipt ist strukturell oder kryptografisch ungültig.");
  verifyTimelineReceiptAgainstFiles(timelineReceipt, boundFiles, input.programAudioDelayMs);
  verifyRawReplayAgainstFiles(input.paths.root, receipt, timelineReceipt, boundFiles);
  verifyTimelineReplayAgainstFiles(
    input.paths.root,
    timelineReceipt,
    boundFiles,
    input.programAudioDelayMs,
  );
  for (const [key, sealed] of Object.entries(boundFiles)) {
    const recaptured = captureRawMuxPairFile(sealed.path);
    if (canonicalJson(recaptured) !== canonicalJson(sealed)) {
      throw new Error(`Raw-Mux-Paarartefakt driftete nach dem semantischen Seal: ${key}`);
    }
  }
  const base: Omit<RawMuxBaselineAuthority, "fingerprint"> = {
    schemaVersion: "ltx-studio-raw-mux-baseline-authority.v1",
    createdAt: input.createdAt ?? new Date().toISOString(),
    experimentId: input.experimentId,
    protocolSha256: input.protocolSha256,
    baselineJobId: input.baselineJobId,
    baselineOutputName: input.baselineOutputName,
    baselineRequestSha256: input.baselineRequestSha256,
    candidateRequestSha256: input.candidateRequestSha256,
    containerImageFingerprint: input.containerImageFingerprint,
    mouthDelayMs: input.mouthDelayMs,
    programAudioDelayMs: input.programAudioDelayMs,
    rawOutputProfiles: {
      baseline: defaultLipForcingRawOutputProfile,
      candidate: experimentalLipForcingRawOutputProfile,
    },
    files: boundFiles,
  };
  const authority: RawMuxBaselineAuthority = {
    ...base,
    fingerprint: authorityFingerprint(base),
  };
  atomicAuthorityFile(input.paths.authority, authority);
  return authority;
}

function isRevision(value: unknown): value is ExecutionFileRevision {
  if (!isRecord(value) || !exactKeys(value, [
    "sizeBytes", "modifiedAtMs", "changedAtMs", "fileId", "deviceId", "mode", "uid", "gid", "nlink",
  ])) return false;
  return typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0
    && typeof value.modifiedAtMs === "number" && Number.isFinite(value.modifiedAtMs) && value.modifiedAtMs >= 0
    && typeof value.changedAtMs === "number" && Number.isFinite(value.changedAtMs) && value.changedAtMs >= 0
    && typeof value.fileId === "string" && /^\d{1,64}$/.test(value.fileId)
    && typeof value.deviceId === "string" && /^\d{1,64}$/.test(value.deviceId)
    && typeof value.mode === "number" && Number.isSafeInteger(value.mode) && value.mode >= 0
    && typeof value.uid === "number" && Number.isSafeInteger(value.uid) && value.uid >= 0
    && typeof value.gid === "number" && Number.isSafeInteger(value.gid) && value.gid >= 0
    && value.nlink === 1;
}

function isFileBinding(value: unknown): value is ExecutionFileBinding {
  return isRecord(value)
    && exactKeys(value, ["path", "sha256", "revision"])
    && typeof value.path === "string" && value.path.startsWith("/") && !value.path.includes("\0")
    && typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)
    && isRevision(value.revision);
}

export function normalizeRawMuxBaselineAuthority(value: unknown): RawMuxBaselineAuthority | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "createdAt", "experimentId", "protocolSha256", "baselineJobId",
    "baselineOutputName", "baselineRequestSha256", "candidateRequestSha256",
    "containerImageFingerprint", "mouthDelayMs", "programAudioDelayMs",
    "rawOutputProfiles", "files", "fingerprint",
  ])) return null;
  if (!isRecord(value.rawOutputProfiles)
    || !exactKeys(value.rawOutputProfiles, ["baseline", "candidate"])
    || value.rawOutputProfiles.baseline !== defaultLipForcingRawOutputProfile
    || value.rawOutputProfiles.candidate !== experimentalLipForcingRawOutputProfile
    || !isRecord(value.files)
    || !exactKeys(value.files, [
      "preMux", "preMuxReceipt", "baselineRaw", "candidateRaw", "candidateFinal", "receipt", "timelineReceipt",
      "ltxBase", "controlAudio", "programAudio", "baselineFinal",
    ])
    || !Object.values(value.files).every(isFileBinding)) return null;
  const base = {
    schemaVersion: value.schemaVersion,
    createdAt: value.createdAt,
    experimentId: value.experimentId,
    protocolSha256: value.protocolSha256,
    baselineJobId: value.baselineJobId,
    baselineOutputName: value.baselineOutputName,
    baselineRequestSha256: value.baselineRequestSha256,
    candidateRequestSha256: value.candidateRequestSha256,
    containerImageFingerprint: value.containerImageFingerprint,
    mouthDelayMs: value.mouthDelayMs,
    programAudioDelayMs: value.programAudioDelayMs,
    rawOutputProfiles: value.rawOutputProfiles,
    files: value.files,
  };
  if (value.schemaVersion !== "ltx-studio-raw-mux-baseline-authority.v1"
    || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.experimentId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.experimentId)
    || typeof value.protocolSha256 !== "string" || !SHA256_PATTERN.test(value.protocolSha256)
    || typeof value.baselineJobId !== "string" || !/^[0-9a-f-]{36}$/i.test(value.baselineJobId)
    || typeof value.baselineOutputName !== "string" || value.baselineOutputName.length < 1 || value.baselineOutputName.length > 120
    || typeof value.baselineRequestSha256 !== "string" || !SHA256_PATTERN.test(value.baselineRequestSha256)
    || typeof value.candidateRequestSha256 !== "string" || !SHA256_PATTERN.test(value.candidateRequestSha256)
    || typeof value.containerImageFingerprint !== "string" || !SHA256_PATTERN.test(value.containerImageFingerprint)
    || typeof value.mouthDelayMs !== "number" || !Number.isInteger(value.mouthDelayMs)
    || value.mouthDelayMs < -500 || value.mouthDelayMs > 500
    || typeof value.programAudioDelayMs !== "number" || !Number.isInteger(value.programAudioDelayMs)
    || value.programAudioDelayMs < -500 || value.programAudioDelayMs > 500
    || typeof value.fingerprint !== "string" || value.fingerprint !== authorityFingerprint(base as Omit<RawMuxBaselineAuthority, "fingerprint">)) {
    return null;
  }
  return structuredClone(value) as RawMuxBaselineAuthority;
}

export function readVerifiedRawMuxBaselineAuthority(
  paths: RawMuxPairPaths,
  expected: {
    experimentId: string;
    protocolSha256: string;
    baselineJobId: string;
    baselineOutputName: string;
    baselineRequestSha256: string;
    candidateRequestSha256: string;
    containerImageFingerprint: string;
    baselineFinalPath: string;
    mouthDelayMs: number;
    programAudioDelayMs: number;
  },
): { authority: RawMuxBaselineAuthority; authorityBinding: ExecutionFileBinding } | null {
  let parsed: unknown;
  let authorityBinding: ExecutionFileBinding;
  try {
    const captured = captureAndReadSmallJson(paths.authority, 256 * 1024);
    authorityBinding = captured.binding;
    parsed = captured.value;
  } catch {
    return null;
  }
  const authority = normalizeRawMuxBaselineAuthority(parsed);
  if (!authority
    || (authorityBinding.revision.mode & 0o7777) !== 0o400
    || authority.experimentId !== expected.experimentId
    || authority.protocolSha256 !== expected.protocolSha256
    || authority.baselineJobId !== expected.baselineJobId
    || authority.baselineOutputName !== expected.baselineOutputName
    || authority.baselineRequestSha256 !== expected.baselineRequestSha256
    || authority.candidateRequestSha256 !== expected.candidateRequestSha256
    || authority.containerImageFingerprint !== expected.containerImageFingerprint) return null;
  if (authority.mouthDelayMs !== expected.mouthDelayMs
    || authority.programAudioDelayMs !== expected.programAudioDelayMs) return null;
  const expectedBindings: Array<[ExecutionFileBinding, string]> = [
    [authority.files.preMux, paths.preMux],
    [authority.files.preMuxReceipt, paths.preMuxReceipt],
    [authority.files.baselineRaw, paths.baselineRaw],
    [authority.files.candidateRaw, paths.candidateRaw],
    [authority.files.candidateFinal, paths.candidateFinal],
    [authority.files.receipt, paths.receipt],
    [authority.files.timelineReceipt, paths.timelineReceipt],
    [authority.files.ltxBase, paths.ltxBase],
    [authority.files.controlAudio, paths.controlAudio],
    [authority.files.programAudio, paths.programAudio],
    [authority.files.baselineFinal, expected.baselineFinalPath],
  ];
  try {
    if (!expectedBindings.every(([bound, path]) =>
      bound.path === path
      && (bound.revision.mode & 0o7777) === 0o400
      && canonicalJson(bound) === canonicalJson(captureRawMuxPairFile(path)))) return null;
    const receipt = parseRawMuxPairReceipt(
      readSmallJsonFromBinding(authority.files.receipt, 256 * 1024),
    );
    if (!receipt) return null;
    verifyReceiptAgainstFiles(receipt, authority.files);
    const preMuxReceipt = parsePreMuxExportReceipt(
      readSmallJsonFromBinding(authority.files.preMuxReceipt, 256 * 1024),
    );
    if (!preMuxReceipt) return null;
    verifyPreMuxExportReceiptAgainstFiles(preMuxReceipt, authority.files.preMux, receipt);
    verifyRawMuxPacketCausality(authority.files);
    const timelineReceipt = parsePairedTimelineReceipt(
      readSmallJsonFromBinding(authority.files.timelineReceipt, 256 * 1024),
    );
    if (!timelineReceipt) return null;
    verifyTimelineReceiptAgainstFiles(
      timelineReceipt,
      authority.files,
      authority.programAudioDelayMs,
    );
    verifyRawReplayAgainstFiles(paths.root, receipt, timelineReceipt, authority.files);
    verifyTimelineReplayAgainstFiles(
      paths.root,
      timelineReceipt,
      authority.files,
      authority.programAudioDelayMs,
    );
    return { authority, authorityBinding };
  } catch {
    return null;
  }
}

function copyBoundFile(source: ExecutionFileBinding, destination: string): ExecutionFileBinding {
  const sourceDescriptor = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationDescriptor: number | null = null;
  let snapshot: ExecutionFileBinding | null = null;
  try {
    const before = revision(fstatSync(sourceDescriptor));
    if (!sameRevision(before, source.revision)
      || hashDescriptor(sourceDescriptor, before.sizeBytes) !== source.sha256) {
      throw new Error(`Gebundenes Raw-Mux-Paarartefakt driftete vor dem Snapshot: ${source.path}`);
    }
    destinationDescriptor = openSync(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.sizeBytes) {
      const count = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.length, before.sizeBytes - position),
        position,
      );
      if (count <= 0) throw new Error("Raw-Mux-Paarquelle endete während des Snapshots vorzeitig.");
      let written = 0;
      while (written < count) {
        written += writeSync(destinationDescriptor, buffer, written, count - written, position + written);
      }
      position += count;
    }
    fchmodSync(destinationDescriptor, 0o400);
    fsyncSync(destinationDescriptor);
    const after = revision(fstatSync(sourceDescriptor));
    const pathname = lstatSync(source.path);
    if (!sameRevision(before, after)
      || pathname.isSymbolicLink()
      || !sameRevision(after, revision(pathname))
      || hashDescriptor(sourceDescriptor, after.sizeBytes) !== source.sha256) {
      throw new Error("Raw-Mux-Paarquelle änderte sich während des gehaltenen FD-Snapshots.");
    }
    const destinationRevision = revision(fstatSync(destinationDescriptor));
    const destinationPathname = lstatSync(destination);
    const destinationSha256 = hashDescriptor(
      destinationDescriptor,
      destinationRevision.sizeBytes,
    );
    if ((destinationRevision.mode & 0o7777) !== 0o400
      || destinationRevision.uid !== currentUid()
      || destinationPathname.isSymbolicLink()
      || !sameRevision(destinationRevision, revision(destinationPathname))
      || destinationSha256 !== source.sha256) {
      throw new Error("Privater Raw-Mux-Paar-Snapshot stimmt nicht exakt mit seinem gehaltenen Ziel-FD überein.");
    }
    snapshot = {
      path: destination,
      sha256: destinationSha256,
      revision: destinationRevision,
    };
    const directoryDescriptor = openSync(
      dirname(destination),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (destinationDescriptor !== null) {
      try {
        const held = fstatSync(destinationDescriptor);
        const pathname = lstatSync(destination);
        if (!pathname.isSymbolicLink()
          && pathname.dev === held.dev
          && pathname.ino === held.ino) {
          unlinkSync(destination);
        }
      } catch {
        // A private exact-inode orphan is fail-closed; never unlink a replaced pathname.
      }
    }
    throw error;
  } finally {
    if (destinationDescriptor !== null) closeSync(destinationDescriptor);
    closeSync(sourceDescriptor);
  }
  if (!snapshot) throw new Error("Privater Raw-Mux-Paar-Snapshot wurde nicht vollständig gebunden.");
  return snapshot;
}

export function copyRawMuxBoundFile(
  source: ExecutionFileBinding,
  destination: string,
): ExecutionFileBinding {
  return copyBoundFile(source, destination);
}

export function pinRawMuxCandidateArtifact(
  authority: RawMuxBaselineAuthority,
  authorityBinding: ExecutionFileBinding,
  baselineProvenanceFingerprint: string,
  candidateStageRoot: string,
): { inputPath: string; source: CpuPairedArtifactReuseSourceBinding } {
  const boundAuthority = normalizeRawMuxBaselineAuthority(
    readSmallJsonFromBinding(authorityBinding, 256 * 1024),
  );
  if (!boundAuthority || canonicalJson(boundAuthority) !== canonicalJson(authority)) {
    throw new Error("Raw-Mux-Authority-Binding gehört nicht exakt zur verifizierten Baseline-Authority.");
  }
  try {
    mkdirSync(candidateStageRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const candidateRootStats = lstatSync(candidateStageRoot);
  if (candidateRootStats.isSymbolicLink()
    || !candidateRootStats.isDirectory()
    || Number(candidateRootStats.uid) !== currentUid()
    || (candidateRootStats.mode & 0o077) !== 0) {
    throw new Error("Kandidaten-StageRoot ist nicht owner-exklusiv oder kein echtes Verzeichnis.");
  }
  const snapshotRoot = join(candidateStageRoot, "raw-mux-pair-reuse");
  mkdirSync(snapshotRoot, { mode: 0o700 });
  const snapshotRootStats = lstatSync(snapshotRoot);
  if (snapshotRootStats.isSymbolicLink()
    || !snapshotRootStats.isDirectory()
    || Number(snapshotRootStats.uid) !== currentUid()
    || (snapshotRootStats.mode & 0o077) !== 0) {
    throw new Error("Privater Raw-Mux-Snapshot-Root ist nicht owner-exklusiv oder kein echtes Verzeichnis.");
  }
  const snapshotAuthority = copyBoundFile(authorityBinding, join(snapshotRoot, RAW_MUX_PAIR_AUTHORITY_FILE));
  const snapshotReceipt = copyBoundFile(authority.files.receipt, join(snapshotRoot, "pair-receipt.json"));
  const snapshotTimelineReceipt = copyBoundFile(
    authority.files.timelineReceipt,
    join(snapshotRoot, "timeline-receipt.json"),
  );
  const snapshotPreMux = copyBoundFile(authority.files.preMux, join(snapshotRoot, "pre-mux-crf13.mp4"));
  const snapshotPreMuxReceipt = copyBoundFile(
    authority.files.preMuxReceipt,
    join(snapshotRoot, "pre-mux-receipt.json"),
  );
  const snapshotCandidateFinal = copyBoundFile(
    authority.files.candidateFinal,
    join(snapshotRoot, "candidate-final.mp4"),
  );
  const directory = openSync(snapshotRoot, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
  for (const binding of [
    authorityBinding,
    authority.files.receipt,
    authority.files.timelineReceipt,
    authority.files.preMux,
    authority.files.preMuxReceipt,
    authority.files.candidateFinal,
  ]) {
    if (canonicalJson(captureRawMuxPairFile(binding.path)) !== canonicalJson(binding)) {
      throw new Error("Raw-Mux-Baseline änderte sich während der privaten Snapshot-Erfassung.");
    }
  }
  return {
    inputPath: snapshotCandidateFinal.path,
    source: {
      reuseKind: "lipforcing-raw-mux-pair",
      baselineJobId: authority.baselineJobId,
      baselineOutputName: authority.baselineOutputName,
      baselineRequestSha256: authority.baselineRequestSha256,
      sourceProvenanceFingerprint: baselineProvenanceFingerprint,
      authority: authorityBinding,
      receipt: authority.files.receipt,
      timelineReceipt: authority.files.timelineReceipt,
      preMux: authority.files.preMux,
      preMuxReceipt: authority.files.preMuxReceipt,
      candidateFinal: authority.files.candidateFinal,
      snapshotAuthority,
      snapshotReceipt,
      snapshotTimelineReceipt,
      snapshotPreMux,
      snapshotPreMuxReceipt,
      snapshotCandidateFinal,
    },
  };
}
