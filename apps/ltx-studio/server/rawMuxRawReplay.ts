import { createHash, randomBytes } from "node:crypto";
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
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { ExecutionFileBinding, ExecutionFileRevision } from "../shared/jobExecution.js";

const FFMPEG_PATH = "/usr/bin/ffmpeg";
const FFPROBE_PATH = "/usr/bin/ffprobe";
const REPLAY_PREFIX = ".raw-mux-exact-replay-";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FD_PATTERN = /^\/proc\/self\/fd\/[0-9]+$/u;
const REPLAY_ID_PATTERN = /^[0-9a-f]{32}$/u;
const BASELINE_PROFILE = "h264-crf13-mux-crf18-v1";
const CANDIDATE_PROFILE = "h264-crf13-mux-copy-v1";
const MAX_DURATION_SECONDS = 86_400;
const DURATION_ARG_PATTERN = /^(?:0|[1-9]\d{0,4})\.\d{4}$/u;

type Revision = Omit<ExecutionFileRevision, "nlink"> & { nlink: number };

export type RawMuxRawReplayFiles = {
  preMux: ExecutionFileBinding;
  audio: ExecutionFileBinding;
  baselineRaw: ExecutionFileBinding;
  candidateRaw: ExecutionFileBinding;
};

export type RawMuxRawReplayReceipt = {
  schemaVersion: "ltx-studio-lipforcing-raw-mux-pair-receipt.v1";
  profiles: { baseline: typeof BASELINE_PROFILE; candidate: typeof CANDIDATE_PROFILE };
  durationArg: string | null;
  ffmpeg: { path: typeof FFMPEG_PATH; sha256: string; version: string };
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

export type RawMuxRawReplayEvidence = {
  schemaVersion: "ltx-studio-raw-mux-exact-replay.v1";
  ffmpegSha256: string;
  ffprobeSha256: string;
  durationArg: string | null;
  baselineRawSha256: string;
  candidateRawSha256: string;
};

type OpenFile = {
  name: keyof RawMuxRawReplayFiles;
  binding: ExecutionFileBinding;
  descriptor: number;
  before: Revision;
};

type OpenExecutable = {
  path: typeof FFMPEG_PATH | typeof FFPROBE_PATH;
  descriptor: number;
  before: Revision;
  sha256: string;
};

type OpenDirectory = {
  path: string;
  accessPath: string;
  descriptor: number;
  before: Revision;
};

type OpenOutput = {
  path: string;
  descriptor: number;
  before: Revision;
  sha256: string;
};

export function validRawMuxDurationArg(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string"
    || value.length > "86400.0000".length
    || !DURATION_ARG_PATTERN.test(value)) return false;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_DURATION_SECONDS;
}

function uid(): number {
  if (typeof process.getuid !== "function") throw new Error("Raw-Replay benötigt POSIX-UIDs.");
  return process.getuid();
}

function revision(stats: ReturnType<typeof fstatSync>): Revision {
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error("Raw-Replay bindet nur reguläre Dateien oder Verzeichnisse.");
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
    nlink: Number(stats.nlink),
  };
}

function sameRevision(left: Revision, right: Revision): boolean {
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

function sameDirectory(left: Revision, right: Revision): boolean {
  return left.fileId === right.fileId
    && left.deviceId === right.deviceId
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function hashFd(descriptor: number, sizeBytes: number): string {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error("Raw-Replay verweigert eine leere oder übergroße Datei.");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < sizeBytes) {
    const count = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, sizeBytes - offset),
      offset,
    );
    if (count <= 0) throw new Error("Raw-Replay-Datei endete während der Hashprüfung.");
    digest.update(buffer.subarray(0, count));
    offset += count;
  }
  return digest.digest("hex");
}

function assertFilePath(path: string, expected: Revision): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || !sameRevision(expected, revision(stats))) {
    throw new Error(`Raw-Replay-Dateipfad driftete von seinem gehaltenen FD: ${path}`);
  }
}

function assertDirectoryPath(path: string, expected: Revision): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory() || !sameDirectory(expected, revision(stats))) {
    throw new Error(`Raw-Replay-Verzeichnispfad driftete von seinem gehaltenen FD: ${path}`);
  }
}

function openBoundFile(name: keyof RawMuxRawReplayFiles, binding: ExecutionFileBinding): OpenFile {
  if (!isAbsolute(binding.path)) throw new Error(`Raw-Replay-Pfad ist nicht absolut: ${name}`);
  const descriptor = openSync(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    const before = revision(stats);
    if (!stats.isFile()
      || before.sizeBytes <= 0
      || before.uid !== uid()
      || before.nlink !== 1
      || (before.mode & 0o022) !== 0
      || !sameRevision(before, binding.revision)
      || hashFd(descriptor, before.sizeBytes) !== binding.sha256) {
      throw new Error(`Raw-Replay-Bindung driftete oder ist nicht owner-exklusiv: ${name}`);
    }
    assertFilePath(binding.path, before);
    return { name, binding, descriptor, before };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyBoundFile(file: OpenFile): void {
  const after = revision(fstatSync(file.descriptor));
  if (!sameRevision(file.before, after)
    || hashFd(file.descriptor, after.sizeBytes) !== file.binding.sha256) {
    throw new Error(`Raw-Replay-Datei driftete während der Prüfung: ${file.name}`);
  }
  assertFilePath(file.binding.path, after);
}

function openExecutable(path: typeof FFMPEG_PATH | typeof FFPROBE_PATH): OpenExecutable {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    const before = revision(stats);
    if (!stats.isFile()
      || before.uid !== 0
      || before.nlink !== 1
      || (before.mode & 0o111) === 0
      || (before.mode & 0o022) !== 0) {
      throw new Error(`Raw-Replay-TCB ist nicht root-eigen und unveränderbar: ${path}`);
    }
    const sha256 = hashFd(descriptor, before.sizeBytes);
    assertFilePath(path, before);
    return { path, descriptor, before, sha256 };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyExecutable(executable: OpenExecutable): void {
  const after = revision(fstatSync(executable.descriptor));
  if (!sameRevision(executable.before, after)
    || hashFd(executable.descriptor, after.sizeBytes) !== executable.sha256) {
    throw new Error(`Raw-Replay-TCB driftete: ${executable.path}`);
  }
  assertFilePath(executable.path, after);
}

function openDirectory(accessPath: string, identityPath = accessPath): OpenDirectory {
  const descriptor = openSync(
    accessPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    const stats = fstatSync(descriptor);
    const before = revision(stats);
    if (!stats.isDirectory() || before.uid !== uid() || (before.mode & 0o7777) !== 0o700) {
      throw new Error(`Raw-Replay-Verzeichnis ist nicht exakt owner-0700: ${identityPath}`);
    }
    assertDirectoryPath(identityPath, before);
    return {
      path: identityPath,
      accessPath: `/proc/self/fd/${descriptor}`,
      descriptor,
      before,
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyDirectory(directory: OpenDirectory): void {
  const after = revision(fstatSync(directory.descriptor));
  if (!sameDirectory(directory.before, after)) {
    throw new Error(`Raw-Replay-Verzeichnis driftete: ${directory.path}`);
  }
  assertDirectoryPath(directory.path, after);
}

function rawCommandSha256(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv), "utf8").digest("hex");
}

export function expectedRawMuxRawReplayCommand(input: {
  arm: "baseline" | "candidate";
  durationArg: string | null;
  preMuxFdPath: string;
  audioFdPath: string;
  outputPath: string;
}): string[] {
  if (!FD_PATTERN.test(input.preMuxFdPath)
    || !FD_PATTERN.test(input.audioFdPath)
    || input.preMuxFdPath === input.audioFdPath
    || !isAbsolute(input.outputPath)
    || input.outputPath.includes("\0")
    || !validRawMuxDurationArg(input.durationArg)) {
    throw new Error("Raw-Replay-Befehlsparameter sind außerhalb der registrierten Grammatik.");
  }
  const codec = input.arm === "baseline"
    ? ["-c:v", "libx264", "-crf", "18"]
    : ["-c:v", "copy"];
  const duration = input.durationArg === null ? [] : ["-t", input.durationArg];
  return [
    FFMPEG_PATH, "-n", "-loglevel", "error", "-nostdin",
    "-i", input.preMuxFdPath, "-i", input.audioFdPath,
    "-map", "0:v:0", "-map", "1:a:0",
    ...codec,
    "-c:a", "aac", "-q:v", "0", "-q:a", "0",
    ...duration,
    input.outputPath,
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validHashSize(value: unknown): value is { sha256: string; sizeBytes: number } {
  return isRecord(value)
    && exactKeys(value, ["sha256", "sizeBytes"])
    && typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)
    && typeof value.sizeBytes === "number" && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes > 0;
}

function verifyReceipt(
  value: unknown,
  files: RawMuxRawReplayFiles,
): RawMuxRawReplayReceipt {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "profiles", "durationArg", "ffmpeg", "inputs", "commands", "outputs",
  ]) || value.schemaVersion !== "ltx-studio-lipforcing-raw-mux-pair-receipt.v1"
    || !validRawMuxDurationArg(value.durationArg)
    || !isRecord(value.profiles) || !exactKeys(value.profiles, ["baseline", "candidate"])
    || value.profiles.baseline !== BASELINE_PROFILE
    || value.profiles.candidate !== CANDIDATE_PROFILE
    || !isRecord(value.ffmpeg) || !exactKeys(value.ffmpeg, ["path", "sha256", "version"])
    || value.ffmpeg.path !== FFMPEG_PATH
    || typeof value.ffmpeg.sha256 !== "string" || !SHA256_PATTERN.test(value.ffmpeg.sha256)
    || typeof value.ffmpeg.version !== "string" || value.ffmpeg.version.length < 1
    || value.ffmpeg.version.length > 1000
    || !isRecord(value.inputs) || !exactKeys(value.inputs, [
      "preMuxSourceSha256", "preMuxExportSha256", "preMuxSizeBytes", "audioSha256", "audioSizeBytes",
    ])
    || !isRecord(value.commands) || !exactKeys(value.commands, ["baseline", "candidate"])
    || !isRecord(value.outputs) || !exactKeys(value.outputs, ["baselineRaw", "candidateRaw"])
    || !validHashSize(value.outputs.baselineRaw)
    || !validHashSize(value.outputs.candidateRaw)) {
    throw new Error("Raw-Replay-Receipt ist strukturell ungültig.");
  }
  const receipt = structuredClone(value) as RawMuxRawReplayReceipt;
  for (const arm of ["baseline", "candidate"] as const) {
    const command = receipt.commands[arm];
    if (!isRecord(command)
      || !exactKeys(command, ["argv", "sha256"])
      || !Array.isArray(command.argv)
      || !command.argv.every((argument) =>
        typeof argument === "string" && argument.length <= 4096 && !argument.includes("\0"))
      || typeof command.sha256 !== "string" || !SHA256_PATTERN.test(command.sha256)
      || rawCommandSha256(command.argv) !== command.sha256) {
      throw new Error("Raw-Replay-Receipt enthält keinen kryptografisch gebundenen Befehl.");
    }
  }
  const baselineArgv = receipt.commands.baseline.argv;
  const candidateArgv = receipt.commands.candidate.argv;
  const preMuxFd = baselineArgv[6] ?? "";
  const audioFd = baselineArgv[8] ?? "";
  const baselineOutput = baselineArgv.at(-1) ?? "";
  const candidateOutput = candidateArgv.at(-1) ?? "";
  const baselineOutputMatch = /^\/proc\/self\/fd\/([0-9]+)\/baseline-raw\.mp4$/u.exec(baselineOutput);
  const candidateOutputMatch = /^\/proc\/self\/fd\/([0-9]+)\/candidate-raw\.mp4$/u.exec(candidateOutput);
  const expectedBaseline = baselineOutputMatch
    ? expectedRawMuxRawReplayCommand({
        arm: "baseline",
        durationArg: receipt.durationArg,
        preMuxFdPath: preMuxFd,
        audioFdPath: audioFd,
        outputPath: baselineOutput,
      })
    : [];
  const expectedCandidate = candidateOutputMatch
    ? expectedRawMuxRawReplayCommand({
        arm: "candidate",
        durationArg: receipt.durationArg,
        preMuxFdPath: preMuxFd,
        audioFdPath: audioFd,
        outputPath: candidateOutput,
      })
    : [];
  if (!baselineOutputMatch
    || !candidateOutputMatch
    || baselineOutputMatch[1] !== candidateOutputMatch[1]
    || candidateArgv[6] !== preMuxFd
    || candidateArgv[8] !== audioFd
    || JSON.stringify(baselineArgv) !== JSON.stringify(expectedBaseline)
    || JSON.stringify(candidateArgv) !== JSON.stringify(expectedCandidate)
    || receipt.inputs.preMuxSourceSha256 !== files.preMux.sha256
    || receipt.inputs.preMuxExportSha256 !== files.preMux.sha256
    || receipt.inputs.preMuxSizeBytes !== files.preMux.revision.sizeBytes
    || receipt.inputs.audioSha256 !== files.audio.sha256
    || receipt.inputs.audioSizeBytes !== files.audio.revision.sizeBytes
    || receipt.outputs.baselineRaw.sha256 !== files.baselineRaw.sha256
    || receipt.outputs.baselineRaw.sizeBytes !== files.baselineRaw.revision.sizeBytes
    || receipt.outputs.candidateRaw.sha256 !== files.candidateRaw.sha256
    || receipt.outputs.candidateRaw.sizeBytes !== files.candidateRaw.revision.sizeBytes) {
    throw new Error("Raw-Replay-Receipt bindet nicht exakt Inputs, Outputs und registrierte A/B-Grammatik.");
  }
  return receipt;
}

type Stream = Record<string, unknown>;

function probeStreams(
  ffprobe: OpenExecutable,
  descriptor: number,
  label: string,
): Stream[] {
  const result = spawnSync("/proc/self/fd/3", [
    "-v", "error", "-count_frames",
    "-show_entries",
    "stream=index,codec_type,codec_name,pix_fmt,sample_rate,channels,avg_frame_rate,r_frame_rate,nb_read_frames,width,height",
    "-of", "json", "/proc/self/fd/4",
  ], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    shell: false,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe", ffprobe.descriptor, descriptor],
  });
  if (result.error || result.status !== 0) throw new Error(`Raw-Replay-FFprobe scheiterte: ${label}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Raw-Replay-FFprobe lieferte kein JSON: ${label}`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.streams) || !parsed.streams.every(isRecord)) {
    throw new Error(`Raw-Replay-FFprobe lieferte keine vollständigen Streams: ${label}`);
  }
  return parsed.streams;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9]\d*$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function videoShape(video: Stream): string {
  const values = [
    video.avg_frame_rate,
    video.r_frame_rate,
    positiveInteger(video.nb_read_frames),
    positiveInteger(video.width),
    positiveInteger(video.height),
    video.pix_fmt,
  ];
  if (video.codec_name !== "h264"
    || typeof values[0] !== "string" || !/^[1-9]\d*\/[1-9]\d*$/u.test(values[0])
    || typeof values[1] !== "string" || !/^[1-9]\d*\/[1-9]\d*$/u.test(values[1])
    || values.slice(2, 5).some((entry) => entry === null)
    || typeof video.pix_fmt !== "string" || video.pix_fmt.length < 1) {
    throw new Error("Raw-Replay-Videoprofil ist unvollständig oder nicht H.264.");
  }
  return JSON.stringify(values);
}

function assertRawProfiles(input: {
  preMux: Stream[];
  audio: Stream[];
  baseline: Stream[];
  candidate: Stream[];
}): void {
  const preMuxVideos = input.preMux.filter((stream) => stream.codec_type === "video");
  const inputAudios = input.audio.filter((stream) => stream.codec_type === "audio");
  if (input.preMux.length !== 1 || preMuxVideos.length !== 1
    || input.audio.length !== 1 || inputAudios.length !== 1) {
    throw new Error("Raw-Replay-Inputs besitzen nicht exakt einen Video- bzw. Audiostream.");
  }
  const sourceVideoShape = videoShape(preMuxVideos[0]);
  const sourceRate = positiveInteger(inputAudios[0].sample_rate);
  const sourceChannels = positiveInteger(inputAudios[0].channels);
  if (sourceRate === null || sourceChannels === null) {
    throw new Error("Raw-Replay-Audioinput besitzt kein eindeutiges Sampleprofil.");
  }
  for (const [label, streams] of [
    ["Baseline", input.baseline],
    ["Kandidat", input.candidate],
  ] as const) {
    const videos = streams.filter((stream) => stream.codec_type === "video");
    const audios = streams.filter((stream) => stream.codec_type === "audio");
    if (streams.length !== 2 || videos.length !== 1 || audios.length !== 1
      || videoShape(videos[0]) !== sourceVideoShape
      || audios[0].codec_name !== "aac"
      || positiveInteger(audios[0].sample_rate) !== sourceRate
      || positiveInteger(audios[0].channels) !== sourceChannels) {
      throw new Error(`Raw-Replay-${label} verletzt das exakte H.264/AAC-Streamprofil.`);
    }
  }
}

function outputAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Raw-Replay überschreibt keine Ausgabe: ${path}`);
}

function openOutput(path: string): OpenOutput {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.uid !== uid() || stats.nlink !== 1 || stats.size <= 0) {
      throw new Error("Raw-Replay-Ausgabe ist nicht eindeutig owner-gebunden.");
    }
    fchmodSync(descriptor, 0o400);
    fsyncSync(descriptor);
    const before = revision(fstatSync(descriptor));
    const sha256 = hashFd(descriptor, before.sizeBytes);
    assertFilePath(path, before);
    return { path, descriptor, before, sha256 };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyOutput(output: OpenOutput): void {
  const after = revision(fstatSync(output.descriptor));
  if (!sameRevision(output.before, after) || hashFd(output.descriptor, after.sizeBytes) !== output.sha256) {
    throw new Error("Raw-Replay-Ausgabe driftete nach dem Seal.");
  }
  assertFilePath(output.path, after);
}

function runArm(input: {
  arm: "baseline" | "candidate";
  ffmpeg: OpenExecutable;
  preMux: OpenFile;
  audio: OpenFile;
  directory: OpenDirectory;
  durationArg: string | null;
  outputName: string;
  timeoutMs: number;
}): OpenOutput {
  const hostOutput = join(input.directory.accessPath, input.outputName);
  outputAbsent(hostOutput);
  const command = expectedRawMuxRawReplayCommand({
    arm: input.arm,
    durationArg: input.durationArg,
    preMuxFdPath: "/proc/self/fd/4",
    audioFdPath: "/proc/self/fd/5",
    outputPath: `/proc/self/fd/6/${input.outputName}`,
  });
  const result = spawnSync("/proc/self/fd/3", command.slice(1), {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    shell: false,
    timeout: input.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    stdio: [
      "ignore", "pipe", "pipe", input.ffmpeg.descriptor,
      input.preMux.descriptor, input.audio.descriptor, input.directory.descriptor,
    ],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Raw-Replay-FFmpeg scheiterte: ${result.stderr.trim().slice(0, 1000)}`);
  }
  return openOutput(hostOutput);
}

function cleanup(input: {
  root: OpenDirectory;
  directory: OpenDirectory;
  outputNames: readonly string[];
  outputs: readonly OpenOutput[];
}): void {
  verifyDirectory(input.root);
  verifyDirectory(input.directory);
  const allowed = new Set(input.outputNames);
  if ([...allowed].some((name) => basename(name) !== name)
    || readdirSync(input.directory.accessPath).some((name) => !allowed.has(name))) {
    throw new Error("Raw-Replay-Cleanup verweigert fremde Verzeichniseinträge.");
  }
  const held = new Map(input.outputs.map((output) => [output.path, output]));
  for (const name of input.outputNames) {
    const path = join(input.directory.accessPath, name);
    const known = held.get(path);
    if (known) {
      verifyOutput(known);
    } else {
      let descriptor: number;
      try {
        descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      try {
        const stats = fstatSync(descriptor);
        const bound = revision(stats);
        if (!stats.isFile() || bound.uid !== uid() || bound.nlink !== 1) {
          throw new Error("Raw-Replay-Cleanup verweigert eine fremde Datei.");
        }
        assertFilePath(path, bound);
      } finally {
        closeSync(descriptor);
      }
    }
    unlinkSync(path);
  }
  verifyDirectory(input.directory);
  rmdirSync(join(input.root.accessPath, basename(input.directory.path)));
  verifyDirectory(input.root);
}

function closeAll(descriptors: readonly number[]): void {
  for (const descriptor of descriptors) {
    try {
      closeSync(descriptor);
    } catch {
      // Preserve the primary fail-closed error.
    }
  }
}

export function verifyRawMuxRawReplay(input: {
  verificationRoot: string;
  files: RawMuxRawReplayFiles;
  receipt: RawMuxRawReplayReceipt | unknown;
  replayId?: string;
  timeoutMs?: number;
}): RawMuxRawReplayEvidence {
  const rootPath = resolve(input.verificationRoot);
  if (!isAbsolute(input.verificationRoot) || rootPath !== input.verificationRoot) {
    throw new Error("Raw-Replay-Root muss kanonisch und absolut sein.");
  }
  const replayId = input.replayId ?? randomBytes(16).toString("hex");
  if (!REPLAY_ID_PATTERN.test(replayId)) throw new Error("Raw-Replay-ID ist nicht 128-Bit-hex.");
  const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60 * 1000) {
    throw new Error("Raw-Replay-Timeout ist ungültig.");
  }

  const root = openDirectory(rootPath);
  const directoryName = `${REPLAY_PREFIX}${replayId}`;
  const directoryPath = join(rootPath, directoryName);
  let directory: OpenDirectory | null = null;
  let ffmpeg: OpenExecutable | null = null;
  let ffprobe: OpenExecutable | null = null;
  const files: OpenFile[] = [];
  const outputs: OpenOutput[] = [];
  let evidence: RawMuxRawReplayEvidence | null = null;
  let primaryError: unknown;
  const outputNames = ["baseline-raw.mp4", "candidate-raw.mp4"] as const;

  try {
    mkdirSync(join(root.accessPath, directoryName), { mode: 0o700 });
    directory = openDirectory(join(root.accessPath, directoryName), directoryPath);
    ffmpeg = openExecutable(FFMPEG_PATH);
    ffprobe = openExecutable(FFPROBE_PATH);
    for (const name of ["preMux", "audio", "baselineRaw", "candidateRaw"] as const) {
      files.push(openBoundFile(name, input.files[name]));
    }
    if (new Set(files.map((file) => `${file.before.deviceId}:${file.before.fileId}`)).size !== files.length) {
      throw new Error("Raw-Replay verweigert Hardlinks und quergesteckte Artefakte.");
    }
    const byName = Object.fromEntries(files.map((file) => [file.name, file])) as Record<
      keyof RawMuxRawReplayFiles,
      OpenFile
    >;
    const receipt = verifyReceipt(input.receipt, input.files);
    if (receipt.ffmpeg.sha256 !== ffmpeg.sha256) {
      throw new Error("Raw-Replay-FFmpeg stimmt nicht mit dem Pair-Receipt überein.");
    }
    assertRawProfiles({
      preMux: probeStreams(ffprobe, byName.preMux.descriptor, "Pre-Mux"),
      audio: probeStreams(ffprobe, byName.audio.descriptor, "Audio"),
      baseline: probeStreams(ffprobe, byName.baselineRaw.descriptor, "Baseline-Raw"),
      candidate: probeStreams(ffprobe, byName.candidateRaw.descriptor, "Kandidaten-Raw"),
    });

    const baseline = runArm({
      arm: "baseline",
      ffmpeg,
      preMux: byName.preMux,
      audio: byName.audio,
      directory,
      durationArg: receipt.durationArg,
      outputName: outputNames[0],
      timeoutMs,
    });
    outputs.push(baseline);
    if (baseline.sha256 !== byName.baselineRaw.binding.sha256
      || baseline.before.sizeBytes !== byName.baselineRaw.binding.revision.sizeBytes) {
      throw new Error("Raw-Replay-Baseline ist nicht byteidentisch zum gebundenen Raw-Artefakt.");
    }
    const candidate = runArm({
      arm: "candidate",
      ffmpeg,
      preMux: byName.preMux,
      audio: byName.audio,
      directory,
      durationArg: receipt.durationArg,
      outputName: outputNames[1],
      timeoutMs,
    });
    outputs.push(candidate);
    if (candidate.sha256 !== byName.candidateRaw.binding.sha256
      || candidate.before.sizeBytes !== byName.candidateRaw.binding.revision.sizeBytes) {
      throw new Error("Raw-Replay-Kandidat ist nicht byteidentisch zum gebundenen Raw-Artefakt.");
    }
    assertRawProfiles({
      preMux: probeStreams(ffprobe, byName.preMux.descriptor, "Pre-Mux-post"),
      audio: probeStreams(ffprobe, byName.audio.descriptor, "Audio-post"),
      baseline: probeStreams(ffprobe, baseline.descriptor, "Baseline-Replay"),
      candidate: probeStreams(ffprobe, candidate.descriptor, "Kandidaten-Replay"),
    });
    for (const file of files) verifyBoundFile(file);
    for (const output of outputs) verifyOutput(output);
    verifyExecutable(ffmpeg);
    verifyExecutable(ffprobe);
    verifyDirectory(root);
    verifyDirectory(directory);
    evidence = {
      schemaVersion: "ltx-studio-raw-mux-exact-replay.v1",
      ffmpegSha256: ffmpeg.sha256,
      ffprobeSha256: ffprobe.sha256,
      durationArg: receipt.durationArg,
      baselineRawSha256: byName.baselineRaw.binding.sha256,
      candidateRawSha256: byName.candidateRaw.binding.sha256,
    };
  } catch (error) {
    primaryError = error;
  }

  let postError: unknown;
  try {
    for (const file of files) verifyBoundFile(file);
    for (const output of outputs) verifyOutput(output);
    if (ffmpeg) verifyExecutable(ffmpeg);
    if (ffprobe) verifyExecutable(ffprobe);
    verifyDirectory(root);
    if (directory) verifyDirectory(directory);
  } catch (error) {
    postError = error;
  }
  let cleanupError: unknown;
  if (directory) {
    try {
      cleanup({ root, directory, outputNames, outputs });
    } catch (error) {
      cleanupError = error;
    }
  }
  closeAll([
    ...outputs.map((output) => output.descriptor),
    ...files.map((file) => file.descriptor),
    ...(ffprobe ? [ffprobe.descriptor] : []),
    ...(ffmpeg ? [ffmpeg.descriptor] : []),
    ...(directory ? [directory.descriptor] : []),
    root.descriptor,
  ]);
  const errors = [primaryError, postError, cleanupError].filter(
    (error): error is NonNullable<unknown> => error !== undefined && error !== null,
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const detail = errors.map((error) => error instanceof Error ? error.message : String(error)).join(" | ");
    throw new AggregateError(errors, `Raw-Replay scheiterte fail-closed: ${detail}`);
  }
  if (!evidence) throw new Error("Raw-Replay erzeugte keine Evidence.");
  return evidence;
}
