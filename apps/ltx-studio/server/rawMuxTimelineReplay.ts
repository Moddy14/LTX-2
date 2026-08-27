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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import type { ExecutionFileBinding, ExecutionFileRevision } from "../shared/jobExecution.js";

const FFMPEG_PATH = "/usr/bin/ffmpeg";
const FFPROBE_PATH = "/usr/bin/ffprobe";
const REPLAY_DIRECTORY_PREFIX = ".raw-mux-timeline-replay-";
const REPLAY_ID_PATTERN = /^[0-9a-f]{32}$/u;
const FRAME_RATE_PATTERN = /^([1-9]\d*)\/([1-9]\d*)$/u;
const MAX_SAFE_INTEGER_DIGITS = String(Number.MAX_SAFE_INTEGER).length;

export const RAW_MUX_REPLAY_TIMELINE_LIMITS = Object.freeze({
  maxFrameCount: 2_049,
  maxWidth: 4_096,
  maxHeight: 4_096,
  minFrameRate: 1,
  maxFrameRate: 120,
});

export type RawMuxReplayTimeline = {
  frameRate: string;
  frameCount: number;
  width: number;
  height: number;
  hasAudio: true;
};

export type RawMuxTimelineReplayFiles = {
  baselineRaw: ExecutionFileBinding;
  candidateRaw: ExecutionFileBinding;
  ltxBase: ExecutionFileBinding;
  programAudio: ExecutionFileBinding;
  baselineFinal: ExecutionFileBinding;
  candidateFinal: ExecutionFileBinding;
};

export type RawMuxTimelineReplayEvidence = {
  schemaVersion: "ltx-studio-raw-mux-timeline-replay.v1";
  ffmpegSha256: string;
  ffprobeSha256: string;
  timeline: RawMuxReplayTimeline;
  programAudioDelayMs: number;
  baselineFinalSha256: string;
  candidateFinalSha256: string;
};

type BoundRevision = Omit<ExecutionFileRevision, "nlink"> & { nlink: number };

type OpenBinding = {
  name: keyof RawMuxTimelineReplayFiles;
  binding: ExecutionFileBinding;
  descriptor: number;
  before: BoundRevision;
};

type OpenExecutable = {
  path: typeof FFMPEG_PATH | typeof FFPROBE_PATH;
  descriptor: number;
  before: BoundRevision;
  sha256: string;
};

type OpenReplayOutput = {
  path: string;
  descriptor: number;
  revision: BoundRevision;
  sha256: string;
};

type DirectoryBinding = {
  path: string;
  accessPath: string;
  descriptor: number;
  revision: BoundRevision;
};

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Timeline-Replay benötigt eine POSIX-UID.");
  }
  return process.getuid();
}

function revision(stats: ReturnType<typeof fstatSync>): BoundRevision {
  if (!stats.isFile() && !stats.isDirectory()) {
    throw new Error("Timeline-Replay bindet ausschließlich reguläre Dateien oder Verzeichnisse.");
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

function sameRevision(left: BoundRevision, right: BoundRevision): boolean {
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

function hashDescriptor(descriptor: number, sizeBytes: number): string {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error("Timeline-Replay verweigert leere oder übergroße Dateibindungen.");
  }
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < sizeBytes) {
    const count = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, sizeBytes - position),
      position,
    );
    if (count <= 0) {
      throw new Error("Timeline-Replay-Datei endete während der Hashprüfung vorzeitig.");
    }
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

function assertPathMatchesDescriptor(
  path: string,
  descriptorRevision: BoundRevision,
  expectedKind: "file" | "directory",
): void {
  const pathnameStats = lstatSync(path);
  if (pathnameStats.isSymbolicLink()
    || (expectedKind === "file" ? !pathnameStats.isFile() : !pathnameStats.isDirectory())
    || !sameRevision(descriptorRevision, revision(pathnameStats))) {
    throw new Error(`Timeline-Replay-Pfad driftete von seinem gehaltenen FD ab: ${path}`);
  }
}

function sameDirectoryIdentity(left: BoundRevision, right: BoundRevision): boolean {
  return left.fileId === right.fileId
    && left.deviceId === right.deviceId
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid;
}

function assertDirectoryPathMatchesDescriptor(
  path: string,
  descriptorRevision: BoundRevision,
): void {
  const pathnameStats = lstatSync(path);
  const pathnameRevision = revision(pathnameStats);
  if (pathnameStats.isSymbolicLink()
    || !pathnameStats.isDirectory()
    || !sameDirectoryIdentity(descriptorRevision, pathnameRevision)) {
    throw new Error(`Timeline-Replay-Verzeichnispfad driftete von seinem gehaltenen FD ab: ${path}`);
  }
}

function openBoundFile(
  name: keyof RawMuxTimelineReplayFiles,
  binding: ExecutionFileBinding,
): OpenBinding {
  if (!isAbsolute(binding.path)) {
    throw new Error(`Timeline-Replay-Dateibindung ist nicht absolut: ${name}`);
  }
  const descriptor = openSync(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const beforeStats = fstatSync(descriptor);
    const before = revision(beforeStats);
    if (!beforeStats.isFile()
      || before.sizeBytes <= 0
      || before.uid !== currentUid()
      || before.nlink !== 1
      || (before.mode & 0o022) !== 0
      || !sameRevision(before, binding.revision)
      || hashDescriptor(descriptor, before.sizeBytes) !== binding.sha256) {
      throw new Error(`Timeline-Replay-Dateibindung ist nicht owner-gebunden oder driftete: ${name}`);
    }
    assertPathMatchesDescriptor(binding.path, before, "file");
    return { name, binding, descriptor, before };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyOpenBinding(open: OpenBinding): void {
  const after = revision(fstatSync(open.descriptor));
  if (!sameRevision(open.before, after)
    || hashDescriptor(open.descriptor, after.sizeBytes) !== open.binding.sha256) {
    throw new Error(`Timeline-Replay-Datei driftete während der gehaltenen Prüfung: ${open.name}`);
  }
  assertPathMatchesDescriptor(open.binding.path, after, "file");
}

function openTrustedExecutable(
  path: typeof FFMPEG_PATH | typeof FFPROBE_PATH,
): OpenExecutable {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    const before = revision(stats);
    if (!stats.isFile()
      || before.sizeBytes <= 0
      || before.uid !== 0
      || before.nlink !== 1
      || (before.mode & 0o111) === 0
      || (before.mode & 0o022) !== 0) {
      throw new Error(`Timeline-Replay-TCB ist nicht root-eigen, regulär und unveränderbar: ${path}`);
    }
    const sha256 = hashDescriptor(descriptor, before.sizeBytes);
    assertPathMatchesDescriptor(path, before, "file");
    return { path, descriptor, before, sha256 };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyOpenExecutable(executable: OpenExecutable): void {
  const after = revision(fstatSync(executable.descriptor));
  if (!sameRevision(executable.before, after)
    || after.uid !== 0
    || (after.mode & 0o111) === 0
    || (after.mode & 0o022) !== 0
    || hashDescriptor(executable.descriptor, after.sizeBytes) !== executable.sha256) {
    throw new Error(`Timeline-Replay-TCB driftete während der gehaltenen Prüfung: ${executable.path}`);
  }
  assertPathMatchesDescriptor(executable.path, after, "file");
}

export function validRawMuxReplayTimeline(value: unknown): value is RawMuxReplayTimeline {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const timeline = value as Record<string, unknown>;
  if (typeof timeline.frameRate !== "string"
    || typeof timeline.frameCount !== "number"
    || typeof timeline.width !== "number"
    || typeof timeline.height !== "number"
    || timeline.hasAudio !== true
    || !Number.isSafeInteger(timeline.frameCount)
    || timeline.frameCount <= 0
    || timeline.frameCount > RAW_MUX_REPLAY_TIMELINE_LIMITS.maxFrameCount
    || !Number.isSafeInteger(timeline.width)
    || timeline.width <= 0
    || timeline.width > RAW_MUX_REPLAY_TIMELINE_LIMITS.maxWidth
    || !Number.isSafeInteger(timeline.height)
    || timeline.height <= 0
    || timeline.height > RAW_MUX_REPLAY_TIMELINE_LIMITS.maxHeight) return false;

  const match = FRAME_RATE_PATTERN.exec(timeline.frameRate);
  if (!match
    || match[1].length > MAX_SAFE_INTEGER_DIGITS
    || match[2].length > MAX_SAFE_INTEGER_DIGITS) return false;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator)
    || !Number.isSafeInteger(denominator)
    || numerator <= 0
    || denominator <= 0) return false;
  const frameRate = numerator / denominator;
  const durationSeconds = timeline.frameCount / frameRate;
  return Number.isFinite(frameRate)
    && frameRate >= RAW_MUX_REPLAY_TIMELINE_LIMITS.minFrameRate
    && frameRate <= RAW_MUX_REPLAY_TIMELINE_LIMITS.maxFrameRate
    && Number.isFinite(durationSeconds)
    && durationSeconds > 0;
}

function validateTimeline(timeline: RawMuxReplayTimeline): {
  numerator: number;
  denominator: number;
} {
  if (!validRawMuxReplayTimeline(timeline)) {
    throw new Error("Timeline-Replay erhielt keine vollständige Timeline innerhalb der GenerationRequest-Grenzen.");
  }
  const match = FRAME_RATE_PATTERN.exec(timeline.frameRate);
  if (!match) throw new Error("Timeline-Replay erhielt keine sicher berechenbare Framerate.");
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  const durationSeconds = timeline.frameCount * denominator / numerator;
  if (!Number.isSafeInteger(numerator)
    || !Number.isSafeInteger(denominator)
    || numerator <= 0
    || denominator <= 0
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0) {
    throw new Error("Timeline-Replay erhielt keine sicher berechenbare Framerate.");
  }
  return { numerator, denominator };
}

/**
 * Single source of truth for the registered paired-host timeline grammar.
 * The output path is intentionally parameterized because replay artifacts live
 * in a fresh, private verification directory.
 */
export function expectedRawMuxTimelineReplayCommand(input: {
  timeline: RawMuxReplayTimeline;
  programAudioDelayMs: number;
  refinedFdPath: string;
  sourceFdPath: string;
  programAudioFdPath: string;
  outputPath: string;
}): string[] {
  const { numerator, denominator } = validateTimeline(input.timeline);
  if (!Number.isInteger(input.programAudioDelayMs)
    || input.programAudioDelayMs < -500
    || input.programAudioDelayMs > 500) {
    throw new Error("Timeline-Replay-Audioverzögerung liegt außerhalb des registrierten Bereichs.");
  }
  for (const [label, path] of [
    ["Refined-FD", input.refinedFdPath],
    ["Source-FD", input.sourceFdPath],
    ["Program-Audio-FD", input.programAudioFdPath],
  ] as const) {
    if (!/^\/proc\/self\/fd\/[0-9]+$/u.test(path)) {
      throw new Error(`Timeline-Replay erhielt keinen gehaltenen ${label}.`);
    }
  }
  if (!isAbsolute(input.outputPath) || input.outputPath.includes("\0")) {
    throw new Error("Timeline-Replay-Ausgabepfad ist nicht absolut oder enthält NUL.");
  }
  const durationSeconds = input.timeline.frameCount * denominator / numerator;
  const padSeconds = Math.ceil(durationSeconds) + 1;
  const timingFilter = input.programAudioDelayMs > 0
    ? `adelay=${input.programAudioDelayMs}:all=1,`
    : input.programAudioDelayMs < 0
      ? `atrim=start=${(Math.abs(input.programAudioDelayMs) / 1000).toFixed(9)},asetpts=PTS-STARTPTS,`
      : "";
  const videoFilter = `fps=fps=${input.timeline.frameRate}:round=near,`
    + `tpad=stop_mode=clone:stop_duration=${padSeconds},`
    + `trim=end_frame=${input.timeline.frameCount},setpts=N/(${input.timeline.frameRate}*TB)`;
  return [
    FFMPEG_PATH, "-hide_banner", "-loglevel", "error", "-n",
    "-i", input.refinedFdPath,
    "-i", input.sourceFdPath,
    "-i", input.programAudioFdPath,
    "-map", "0:v:0", "-map", "2:a:0",
    "-vf", videoFilter,
    "-frames:v", String(input.timeline.frameCount),
    "-c:v", "libx264", "-preset", "medium", "-crf", "8",
    "-pix_fmt", "yuv420p",
    "-af", `${timingFilter}aresample=48000,apad,`
      + `atrim=duration=${durationSeconds.toFixed(9)},asetpts=PTS-STARTPTS`,
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    input.outputPath,
  ];
}

function openDirectory(
  accessPath: string,
  requireExact0700: boolean,
  identityPath = accessPath,
): DirectoryBinding {
  const descriptor = openSync(
    accessPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY,
  );
  try {
    const stats = fstatSync(descriptor);
    const boundRevision = revision(stats);
    if (!stats.isDirectory()
      || boundRevision.uid !== currentUid()
      || (requireExact0700
        ? (boundRevision.mode & 0o7777) !== 0o700
        : (boundRevision.mode & 0o077) !== 0)) {
      throw new Error(`Timeline-Replay-Verzeichnis ist nicht owner-privat: ${identityPath}`);
    }
    assertDirectoryPathMatchesDescriptor(identityPath, boundRevision);
    return {
      path: identityPath,
      accessPath: `/proc/self/fd/${descriptor}`,
      descriptor,
      revision: boundRevision,
    };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyDirectory(directory: DirectoryBinding): void {
  const after = revision(fstatSync(directory.descriptor));
  if (!sameDirectoryIdentity(directory.revision, after)) {
    throw new Error(`Timeline-Replay-Verzeichnis driftete während der Prüfung: ${directory.path}`);
  }
  assertDirectoryPathMatchesDescriptor(directory.path, after);
}

function assertOutputAbsent(path: string): void {
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Timeline-Replay überschreibt keine bestehende Ausgabe: ${path}`);
}

function openAndSealReplayOutput(path: string): OpenReplayOutput {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initialStats = fstatSync(descriptor);
    const initial = revision(initialStats);
    if (!initialStats.isFile()
      || initial.sizeBytes <= 0
      || initial.uid !== currentUid()
      || initial.nlink !== 1) {
      throw new Error("Timeline-Replay-Ausgabe ist nicht exklusiv owner-gebunden.");
    }
    assertPathMatchesDescriptor(path, initial, "file");
    fchmodSync(descriptor, 0o400);
    fsyncSync(descriptor);
    const sealed = revision(fstatSync(descriptor));
    const sha256 = hashDescriptor(descriptor, sealed.sizeBytes);
    if (sealed.uid !== currentUid()
      || sealed.nlink !== 1
      || (sealed.mode & 0o7777) !== 0o400) {
      throw new Error("Timeline-Replay-Ausgabe konnte nicht owner-exklusiv versiegelt werden.");
    }
    assertPathMatchesDescriptor(path, sealed, "file");
    return { path, descriptor, revision: sealed, sha256 };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyReplayOutput(output: OpenReplayOutput): void {
  const after = revision(fstatSync(output.descriptor));
  if (!sameRevision(output.revision, after)
    || hashDescriptor(output.descriptor, after.sizeBytes) !== output.sha256) {
    throw new Error("Timeline-Replay-Ausgabe driftete nach ihrer Versiegelung.");
  }
  assertPathMatchesDescriptor(output.path, after, "file");
}

function reducedFrameRate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = FRAME_RATE_PATTERN.exec(value);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ProbedMedium = {
  streams: Record<string, unknown>[];
  video: Record<string, unknown>;
  audio: Record<string, unknown>;
};

function probeMedium(
  ffprobe: OpenExecutable,
  mediaDescriptor: number,
  label: string,
): ProbedMedium {
  const result = spawnSync("/proc/self/fd/3", [
    "-v", "error", "-count_frames",
    "-show_entries",
    "stream=index,codec_type,codec_name,pix_fmt,sample_rate,channels,avg_frame_rate,r_frame_rate,nb_frames,nb_read_frames,width,height",
    "-of", "json", "/proc/self/fd/4",
  ], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    shell: false,
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe", ffprobe.descriptor, mediaDescriptor],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Timeline-Replay-FFprobe scheiterte für ${label}.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Timeline-Replay-FFprobe lieferte kein JSON für ${label}.`);
  }
  if (!isRecord(payload)
    || !Array.isArray(payload.streams)
    || !payload.streams.every(isRecord)) {
    throw new Error(`Timeline-Replay-FFprobe lieferte keine vollständige Streamliste für ${label}.`);
  }
  const streams = payload.streams;
  const videos = streams.filter((stream) => stream.codec_type === "video");
  const audios = streams.filter((stream) => stream.codec_type === "audio");
  if (streams.length !== 2 || videos.length !== 1 || audios.length !== 1) {
    throw new Error(`Timeline-Replay verlangt exakt eine Video- und eine Audiospur für ${label}.`);
  }
  return { streams, video: videos[0], audio: audios[0] };
}

function positiveInteger(value: unknown): number | null {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9]\d*$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function assertMeasuredTimeline(
  medium: ProbedMedium,
  timeline: RawMuxReplayTimeline,
  label: string,
): void {
  const averageRate = reducedFrameRate(medium.video.avg_frame_rate);
  const realRate = reducedFrameRate(medium.video.r_frame_rate);
  const expectedRate = reducedFrameRate(timeline.frameRate);
  const countedFrames = positiveInteger(medium.video.nb_read_frames);
  const declaredFrames = positiveInteger(medium.video.nb_frames);
  if (!expectedRate
    || averageRate !== expectedRate
    || realRate !== expectedRate
    || countedFrames !== timeline.frameCount
    || declaredFrames !== timeline.frameCount
    || positiveInteger(medium.video.width) !== timeline.width
    || positiveInteger(medium.video.height) !== timeline.height) {
    throw new Error(`Timeline-Replay misst eine abweichende Timeline für ${label}.`);
  }
}

function assertFinalProfile(
  medium: ProbedMedium,
  timeline: RawMuxReplayTimeline,
  label: string,
): void {
  assertMeasuredTimeline(medium, timeline, label);
  if (medium.video.codec_name !== "h264"
    || medium.video.pix_fmt !== "yuv420p"
    || medium.audio.codec_name !== "aac"
    || medium.audio.sample_rate !== "48000"
    || positiveInteger(medium.audio.channels) === null) {
    throw new Error(`Timeline-Replay-Finalprofil ist nicht exakt H.264/yuv420p + AAC/48k für ${label}.`);
  }
}

function runReplayArm(input: {
  ffmpeg: OpenExecutable;
  refined: OpenBinding;
  source: OpenBinding;
  programAudio: OpenBinding;
  timeline: RawMuxReplayTimeline;
  programAudioDelayMs: number;
  replayDirectory: DirectoryBinding;
  outputName: string;
  timeoutMs: number;
}): { output: OpenReplayOutput; command: string[] } {
  if (basename(input.outputName) !== input.outputName) {
    throw new Error("Timeline-Replay-Ausgabename verlässt das gehaltene Verzeichnis.");
  }
  const hostOutputPath = join(input.replayDirectory.accessPath, input.outputName);
  const childOutputPath = `/proc/self/fd/7/${input.outputName}`;
  assertOutputAbsent(hostOutputPath);
  const command = expectedRawMuxTimelineReplayCommand({
    timeline: input.timeline,
    programAudioDelayMs: input.programAudioDelayMs,
    refinedFdPath: "/proc/self/fd/4",
    sourceFdPath: "/proc/self/fd/5",
    programAudioFdPath: "/proc/self/fd/6",
    outputPath: childOutputPath,
  });
  const result = spawnSync("/proc/self/fd/3", command.slice(1), {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    shell: false,
    timeout: input.timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    stdio: [
      "ignore",
      "pipe",
      "pipe",
      input.ffmpeg.descriptor,
      input.refined.descriptor,
      input.source.descriptor,
      input.programAudio.descriptor,
      input.replayDirectory.descriptor,
    ],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Timeline-Replay-FFmpeg scheiterte: ${result.stderr.trim().slice(0, 1000)}`);
  }
  return { output: openAndSealReplayOutput(hostOutputPath), command };
}

function securelyRemoveReplayDirectory(input: {
  verificationRoot: DirectoryBinding;
  replayDirectory: DirectoryBinding;
  expectedOutputNames: readonly string[];
  outputs: readonly OpenReplayOutput[];
}): void {
  verifyDirectory(input.verificationRoot);
  verifyDirectory(input.replayDirectory);
  const expectedNames = new Set(input.expectedOutputNames.map((name) => {
    if (basename(name) !== name) {
      throw new Error("Timeline-Replay-Cleanup erhielt einen ungültigen Ausgabenamen.");
    }
    return name;
  }));
  const entries = readdirSync(input.replayDirectory.accessPath);
  if (entries.some((entry) => !expectedNames.has(entry))) {
    throw new Error("Timeline-Replay-Cleanup verweigert ein Verzeichnis mit fremden Einträgen.");
  }
  const openByPath = new Map(input.outputs.map((output) => [output.path, output]));
  for (const outputName of input.expectedOutputNames) {
    const outputPath = join(input.replayDirectory.accessPath, outputName);
    const output = openByPath.get(outputPath);
    let adoptedDescriptor: number | null = null;
    try {
      if (!output) {
        try {
          adoptedDescriptor = openSync(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const stats = fstatSync(adoptedDescriptor);
        const adoptedRevision = revision(stats);
        if (!stats.isFile()
          || adoptedRevision.uid !== currentUid()
          || adoptedRevision.nlink !== 1) {
          throw new Error("Timeline-Replay-Cleanup verweigert eine nicht eindeutig eigene Ausgabe.");
        }
        assertPathMatchesDescriptor(outputPath, adoptedRevision, "file");
      } else {
        verifyReplayOutput(output);
      }
      unlinkSync(outputPath);
    } finally {
      if (adoptedDescriptor !== null) closeSync(adoptedDescriptor);
    }
  }
  verifyDirectory(input.replayDirectory);
  rmdirSync(join(input.verificationRoot.accessPath, basename(input.replayDirectory.path)));
  verifyDirectory(input.verificationRoot);
}

function closeAll(descriptors: readonly number[]): void {
  for (const descriptor of descriptors) {
    try {
      closeSync(descriptor);
    } catch {
      // A prior close must not hide the primary verification error.
    }
  }
}

export function verifyRawMuxTimelineReplay(input: {
  verificationRoot: string;
  files: RawMuxTimelineReplayFiles;
  timeline: RawMuxReplayTimeline;
  programAudioDelayMs: number;
  replayId?: string;
  timeoutMs?: number;
}): RawMuxTimelineReplayEvidence {
  validateTimeline(input.timeline);
  if (!Number.isInteger(input.programAudioDelayMs)
    || input.programAudioDelayMs < -500
    || input.programAudioDelayMs > 500) {
    throw new Error("Timeline-Replay-Audioverzögerung liegt außerhalb des registrierten Bereichs.");
  }
  const timeoutMs = input.timeoutMs ?? 15 * 60 * 1000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60 * 60 * 1000) {
    throw new Error("Timeline-Replay-Timeout liegt außerhalb des sicheren Bereichs.");
  }
  const rootPath = resolve(input.verificationRoot);
  if (!isAbsolute(input.verificationRoot) || rootPath !== input.verificationRoot) {
    throw new Error("Timeline-Replay-Root muss ein kanonischer absoluter Pfad sein.");
  }
  const replayId = input.replayId ?? randomBytes(16).toString("hex");
  if (!REPLAY_ID_PATTERN.test(replayId)) {
    throw new Error("Timeline-Replay-ID ist nicht exakt 128 Bit hexadezimal.");
  }

  const verificationRoot = openDirectory(rootPath, false);
  let replayDirectory: DirectoryBinding | null = null;
  const openBindings: OpenBinding[] = [];
  const replayOutputs: OpenReplayOutput[] = [];
  let ffmpeg: OpenExecutable | null = null;
  let ffprobe: OpenExecutable | null = null;
  let primaryError: unknown;
  let evidence: RawMuxTimelineReplayEvidence | null = null;
  const replayDirectoryPath = join(rootPath, `${REPLAY_DIRECTORY_PREFIX}${replayId}`);
  const baselineReplayName = "baseline-final-replay.mp4";
  const candidateReplayName = "candidate-final-replay.mp4";
  const expectedOutputNames = [baselineReplayName, candidateReplayName] as const;

  try {
    if (dirname(replayDirectoryPath) !== rootPath) {
      throw new Error("Timeline-Replay-Verzeichnis verlässt seinen expliziten Verification-Root.");
    }
    const replayDirectoryAccessPath = join(
      verificationRoot.accessPath,
      `${REPLAY_DIRECTORY_PREFIX}${replayId}`,
    );
    mkdirSync(replayDirectoryAccessPath, { mode: 0o700 });
    replayDirectory = openDirectory(replayDirectoryAccessPath, true, replayDirectoryPath);

    ffmpeg = openTrustedExecutable(FFMPEG_PATH);
    ffprobe = openTrustedExecutable(FFPROBE_PATH);
    for (const name of [
      "baselineRaw",
      "candidateRaw",
      "ltxBase",
      "programAudio",
      "baselineFinal",
      "candidateFinal",
    ] as const) {
      openBindings.push(openBoundFile(name, input.files[name]));
    }
    const identities = new Set(openBindings.map((open) =>
      `${open.before.deviceId}:${open.before.fileId}`));
    if (identities.size !== openBindings.length) {
      throw new Error("Timeline-Replay verweigert Hardlinks oder quergesteckte identische Artefakte.");
    }
    const byName = Object.fromEntries(openBindings.map((open) => [open.name, open])) as Record<
      keyof RawMuxTimelineReplayFiles,
      OpenBinding
    >;

    const sourceMedium = probeMedium(ffprobe, byName.ltxBase.descriptor, "LTX-Quelle");
    assertMeasuredTimeline(sourceMedium, input.timeline, "LTX-Quelle");
    assertFinalProfile(
      probeMedium(ffprobe, byName.baselineFinal.descriptor, "Baseline-Final"),
      input.timeline,
      "Baseline-Final",
    );
    assertFinalProfile(
      probeMedium(ffprobe, byName.candidateFinal.descriptor, "Kandidaten-Final"),
      input.timeline,
      "Kandidaten-Final",
    );

    const baseline = runReplayArm({
      ffmpeg,
      refined: byName.baselineRaw,
      source: byName.ltxBase,
      programAudio: byName.programAudio,
      timeline: input.timeline,
      programAudioDelayMs: input.programAudioDelayMs,
      replayDirectory,
      outputName: baselineReplayName,
      timeoutMs,
    });
    replayOutputs.push(baseline.output);
    if (baseline.output.sha256 !== byName.baselineFinal.binding.sha256
      || baseline.output.revision.sizeBytes !== byName.baselineFinal.binding.revision.sizeBytes) {
      throw new Error("Timeline-Replay der Baseline ist nicht byteidentisch zum gebundenen Final.");
    }

    const candidate = runReplayArm({
      ffmpeg,
      refined: byName.candidateRaw,
      source: byName.ltxBase,
      programAudio: byName.programAudio,
      timeline: input.timeline,
      programAudioDelayMs: input.programAudioDelayMs,
      replayDirectory,
      outputName: candidateReplayName,
      timeoutMs,
    });
    replayOutputs.push(candidate.output);
    if (candidate.output.sha256 !== byName.candidateFinal.binding.sha256
      || candidate.output.revision.sizeBytes !== byName.candidateFinal.binding.revision.sizeBytes) {
      throw new Error("Timeline-Replay des Kandidaten ist nicht byteidentisch zum gebundenen Final.");
    }

    assertFinalProfile(
      probeMedium(ffprobe, baseline.output.descriptor, "Baseline-Replay"),
      input.timeline,
      "Baseline-Replay",
    );
    assertFinalProfile(
      probeMedium(ffprobe, candidate.output.descriptor, "Kandidaten-Replay"),
      input.timeline,
      "Kandidaten-Replay",
    );

    for (const binding of openBindings) verifyOpenBinding(binding);
    for (const output of replayOutputs) verifyReplayOutput(output);
    verifyOpenExecutable(ffmpeg);
    verifyOpenExecutable(ffprobe);
    verifyDirectory(verificationRoot);
    verifyDirectory(replayDirectory);

    evidence = {
      schemaVersion: "ltx-studio-raw-mux-timeline-replay.v1",
      ffmpegSha256: ffmpeg.sha256,
      ffprobeSha256: ffprobe.sha256,
      timeline: structuredClone(input.timeline),
      programAudioDelayMs: input.programAudioDelayMs,
      baselineFinalSha256: byName.baselineFinal.binding.sha256,
      candidateFinalSha256: byName.candidateFinal.binding.sha256,
    };
  } catch (error) {
    primaryError = error;
  }

  let postBindingError: unknown;
  try {
    for (const binding of openBindings) verifyOpenBinding(binding);
    for (const output of replayOutputs) verifyReplayOutput(output);
    if (ffmpeg) verifyOpenExecutable(ffmpeg);
    if (ffprobe) verifyOpenExecutable(ffprobe);
    verifyDirectory(verificationRoot);
    if (replayDirectory) verifyDirectory(replayDirectory);
  } catch (error) {
    postBindingError = error;
  }

  let cleanupError: unknown;
  if (replayDirectory) {
    try {
      securelyRemoveReplayDirectory({
        verificationRoot,
        replayDirectory,
        expectedOutputNames,
        outputs: replayOutputs,
      });
    } catch (error) {
      cleanupError = error;
    }
  }
  closeAll([
    ...replayOutputs.map((output) => output.descriptor),
    ...openBindings.map((binding) => binding.descriptor),
    ...(ffprobe ? [ffprobe.descriptor] : []),
    ...(ffmpeg ? [ffmpeg.descriptor] : []),
    ...(replayDirectory ? [replayDirectory.descriptor] : []),
    verificationRoot.descriptor,
  ]);

  const errors = [primaryError, postBindingError, cleanupError].filter(
    (error): error is NonNullable<unknown> => error !== undefined && error !== null,
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const details = errors.map((error) =>
      error instanceof Error ? error.message : String(error)).join(" | ");
    throw new AggregateError(errors, `Timeline-Replay scheiterte fail-closed: ${details}`);
  }
  if (!evidence) throw new Error("Timeline-Replay erzeugte keine verifizierte Evidence.");
  return evidence;
}
