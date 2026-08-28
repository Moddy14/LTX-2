import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { canonicalJson } from "../shared/canonicalJson.js";
import type { ExecutionFileBinding, ExecutionFileRevision } from "../shared/jobExecution.js";

export const POSITIVE_AUDIO_RETIME_PROFILE = "positive-delay-packet-copy.v1" as const;
export const POSITIVE_AUDIO_RETIME_RECEIPT_SCHEMA = "ltx-studio-audio-retime-receipt.v1" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const HASHED_DATA_PATTERN = /^SHA256:([0-9a-f]{64})$/u;
const INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/u;
const FD_PATH_PATTERN = /^\/proc\/self\/fd\/([3-9]|[1-9]\d+)$/u;
const MAX_PACKET_COUNT = 1_000_000;
const MAX_PROBE_BYTES = 256 * 1024 * 1024;
const MAX_PCM_BYTES = 512 * 1024 * 1024;
const PCM_SAMPLE_RATE = 48_000;
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = 4;
const PCM_BYTES_PER_FRAME = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE;
const PREFIX_PEAK_LIMIT_DBFS = -90;
const PREFIX_PEAK_LIMIT_S32 = Math.floor(2_147_483_648 * 10 ** (PREFIX_PEAK_LIMIT_DBFS / 20));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type BoundRevision = Omit<ExecutionFileRevision, "nlink"> & { nlink: number };

export type BoundAudioRetimeExecutable = Readonly<{
  fd: number;
  binding: ExecutionFileBinding;
  version: string;
}>;

export type PositiveAudioRetimeReceiptInput = Readonly<{
  profile: typeof POSITIVE_AUDIO_RETIME_PROFILE;
  requestedDelayMs: number;
  authority: PositiveAudioRetimeExecutionAuthority;
  source: ExecutionFileBinding;
  candidate: ExecutionFileBinding;
  ffmpeg: BoundAudioRetimeExecutable;
  ffprobe: BoundAudioRetimeExecutable;
  /** Exact argv used with the held FFmpeg FD; argv[0] is intentionally omitted. */
  transformArgs: readonly string[];
  /** Existing private owner-controlled directory used only for a transient bound replay. */
  verificationRoot: string;
  timeoutMs?: number;
}>;

export type PositiveAudioRetimeExecutionAuthority = Readonly<{
  jobId: string;
  experimentId: string;
  protocolSha256: string;
  candidateRequestSha256: string;
  baselineJobId: string;
  baselineOutputName: string;
  baselineRequestSha256: string;
  sourceAuthorityRequestSha256: string;
  sourceProvenanceFingerprint: string;
}>;

type FileEvidence = {
  binding: ExecutionFileBinding;
  bindingSha256: string;
};

type ToolEvidence = {
  binding: ExecutionFileBinding;
  version: string;
  versionSha256: string;
  identitySha256: string;
};

type PacketFileEvidence = {
  videoPacketCount: number;
  audioPacketCount: number;
  videoStreamSha256: string;
  audioStreamSha256: string;
  videoPacketSequenceSha256: string;
  audioPayloadSequenceSha256: string;
  audioTimelineSequenceSha256: string;
  completePacketSequenceSha256: string;
};

export type PositiveAudioRetimeReceipt = {
  schemaVersion: typeof POSITIVE_AUDIO_RETIME_RECEIPT_SCHEMA;
  profile: typeof POSITIVE_AUDIO_RETIME_PROFILE;
  authority: {
    jobId: string;
    experimentId: string;
    protocolSha256: string;
    candidateRequestSha256: string;
    baselineJobId: string;
    baselineOutputName: string;
    baselineRequestSha256: string;
    sourceAuthorityRequestSha256: string;
    sourceProvenanceFingerprint: string;
    requestedDelayMs: number;
    sourceBindingSha256: string;
    candidateBindingSha256: string;
    canonicalSha256: string;
  };
  transform: {
    requestedDelayMs: number;
    measuredDelayTicks: string;
    measuredDelayTimeBase: string;
    measuredDelayMicroseconds: number;
    absoluteErrorMicroseconds: number;
    pcmLeadingPrefixFrames: number;
    replayOutputSha256: string;
    replayOutputSizeBytes: number;
    canonicalSha256: string;
  };
  tools: {
    ffmpeg: ToolEvidence;
    ffprobe: ToolEvidence;
    canonicalSha256: string;
  };
  args: {
    transformArgsSha256: string;
    ffprobeArgsSha256: string;
    sourceDecodeArgsSha256: string;
    candidateDecodeArgsSha256: string;
    transformReplayArgsSha256: string;
    versionArgsSha256: string;
    canonicalSha256: string;
  };
  files: {
    source: FileEvidence;
    candidate: FileEvidence;
    canonicalSha256: string;
  };
  packets: {
    source: PacketFileEvidence;
    candidate: PacketFileEvidence;
    canonicalSha256: string;
  };
  pcm: {
    format: "s32le/48000/stereo";
    bytesPerFrame: 8;
    sourceByteLength: number;
    sourceFrameCount: number;
    sourceSha256: string;
    candidateByteLength: number;
    candidateFrameCount: number;
    candidateSha256: string;
    leadingPrefixByteLength: number;
    leadingPrefixFrameCount: number;
    leadingPrefixSha256: string;
    leadingPrefixPeakAbsoluteS32: number;
    leadingPrefixPeakDbfs: string;
    sourceInitialSkipSamples: number;
    candidateInitialSkipSamples: number;
    candidatePrimingCompensationSamples: number;
    alignedCandidateSha256: string;
    canonicalSha256: string;
  };
  checks: {
    exactlyOneVideoAndOneAudioPerFile: true;
    noExtraStreams: true;
    videoCodecExtradataGeometryTimeBaseIdentical: true;
    videoPacketSequenceIdentical: true;
    audioCodecExtradataTimeBaseIdentical: true;
    audioPacketCountIdentical: true;
    audioPayloadPacketSequenceIdentical: true;
    audioPtsDeltaConstantPositive: true;
    audioDtsDeltaConstantPositive: true;
    audioPtsDtsDeltaIdentical: true;
    requestedDelayWithinOneMillisecond: true;
    decodedPcmHasOnlySilentLeadingPrefix: true;
    decodedPcmSuffixByteIdentical: true;
    noAudioPacketsLost: true;
    noAudioTailDrop: true;
    allBoundFilesAndToolsStable: true;
    boundTransformReplayByteIdentical: true;
  };
  evidenceSha256: string;
};

type OpenMedia = {
  label: "source" | "candidate" | "replay";
  descriptor: number;
  binding: ExecutionFileBinding;
  revision: BoundRevision;
};

type StreamContract = Record<string, string | number | null>;

type CanonicalPacket = {
  stream: "video" | "audio";
  pts: string;
  dts: string;
  duration: string;
  flags: string;
  size: number;
  dataSha256: string;
  skipSamples: number;
  discardPadding: number;
  sideDataSha256: string;
  nonSkipSideDataSha256: string;
  skipSideDataStaticSha256: string;
};

type ProbedMedia = {
  videoStream: StreamContract;
  audioStream: StreamContract;
  videoPackets: CanonicalPacket[];
  audioPackets: CanonicalPacket[];
  completePackets: CanonicalPacket[];
};

function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Canonical(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

function revision(stats: ReturnType<typeof fstatSync>): BoundRevision {
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

function hashDescriptor(descriptor: number, sizeBytes: number, label: string): string {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error(`${label} ist leer oder für eine vollständige Hashprüfung zu groß.`);
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
    if (count <= 0) throw new Error(`${label} endete während der gehaltenen Hashprüfung vorzeitig.`);
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

function assertCanonicalAbsolutePath(path: string, label: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes("\0")) {
    throw new Error(`${label} benötigt einen kanonischen absoluten Pfad ohne NUL.`);
  }
}

function assertPathStillBinds(path: string, expected: BoundRevision, label: string): void {
  const pathname = lstatSync(path);
  if (pathname.isSymbolicLink() || !pathname.isFile()
    || !sameRevision(revision(pathname), expected)) {
    throw new Error(`${label} driftete von seinem gehaltenen O_NOFOLLOW-FD ab.`);
  }
}

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("Audio-Retime-Receipts benötigen eine POSIX-UID.");
  }
  return process.getuid();
}

function openBoundMedia(
  label: OpenMedia["label"],
  binding: ExecutionFileBinding,
): OpenMedia {
  assertCanonicalAbsolutePath(binding.path, `Audio-Retime-${label}`);
  if (!SHA256_PATTERN.test(binding.sha256)) {
    throw new Error(`Audio-Retime-${label} besitzt keinen kanonischen SHA-256.`);
  }
  const descriptor = openSync(binding.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    const openedRevision = revision(stats);
    if (!stats.isFile()
      || openedRevision.sizeBytes <= 0
      || openedRevision.uid !== currentUid()
      || openedRevision.nlink !== 1
      || !sameRevision(openedRevision, binding.revision)
      || hashDescriptor(descriptor, openedRevision.sizeBytes, `Audio-Retime-${label}`)
        !== binding.sha256) {
      throw new Error(`Audio-Retime-${label} ist nicht exakt owner-/revisions-/bytegebunden.`);
    }
    assertPathStillBinds(binding.path, openedRevision, `Audio-Retime-${label}`);
    return { label, descriptor, binding, revision: openedRevision };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function verifyHeldMediaBytes(media: OpenMedia): void {
  const after = revision(fstatSync(media.descriptor));
  if (!sameRevision(media.revision, after)
    || hashDescriptor(media.descriptor, after.sizeBytes, `Audio-Retime-${media.label}`)
      !== media.binding.sha256) {
    throw new Error(`Audio-Retime-${media.label} driftete während der gehaltenen Prüfung.`);
  }
}

function verifyOpenMedia(media: OpenMedia): void {
  verifyHeldMediaBytes(media);
  assertPathStillBinds(media.binding.path, media.revision, `Audio-Retime-${media.label}`);
}

function verifyUnlinkedReplayBytes(media: OpenMedia): void {
  const after = revision(fstatSync(media.descriptor));
  if (media.label !== "replay"
    || after.sizeBytes !== media.revision.sizeBytes
    || after.modifiedAtMs !== media.revision.modifiedAtMs
    || after.fileId !== media.revision.fileId
    || after.deviceId !== media.revision.deviceId
    || after.mode !== media.revision.mode
    || after.uid !== media.revision.uid
    || after.gid !== media.revision.gid
    || after.nlink !== 0
    || hashDescriptor(media.descriptor, after.sizeBytes, "Unlinked Audio-Retime-Replay")
      !== media.binding.sha256) {
    throw new Error("Unlinked Audio-Retime-Replay änderte seine gebundenen Bytes oder Inode-Identität.");
  }
}

function verifyBoundTool(tool: BoundAudioRetimeExecutable, kind: "ffmpeg" | "ffprobe"): void {
  assertCanonicalAbsolutePath(tool.binding.path, `Gebundenes ${kind}`);
  if (!Number.isInteger(tool.fd) || tool.fd < 0
    || !SHA256_PATTERN.test(tool.binding.sha256)
    || typeof tool.version !== "string" || tool.version.length < 1 || tool.version.length > 1_000) {
    throw new Error(`Gebundenes ${kind} besitzt keine vollständige FD-/Binding-/Versionsautorität.`);
  }
  const stats = fstatSync(tool.fd);
  const current = revision(stats);
  if (!stats.isFile()
    || current.sizeBytes <= 0
    || current.uid !== 0
    || current.nlink !== 1
    || (current.mode & 0o111) === 0
    || (current.mode & 0o022) !== 0
    || !sameRevision(current, tool.binding.revision)
    || hashDescriptor(tool.fd, current.sizeBytes, `Gebundenes ${kind}`) !== tool.binding.sha256) {
    throw new Error(`Gebundenes ${kind} driftete oder ist kein unveränderbares root-eigenes Executable.`);
  }
  assertPathStillBinds(tool.binding.path, current, `Gebundenes ${kind}`);
}

function runBoundVersion(tool: BoundAudioRetimeExecutable, kind: "ffmpeg" | "ffprobe"): void {
  verifyBoundTool(tool, kind);
  const result = spawnSync("/proc/self/fd/3", ["-version"], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    shell: false,
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe", tool.fd],
  });
  const firstLine = result.status === 0 && result.signal === null && !result.error
    ? `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? ""
    : "";
  if (firstLine !== tool.version || !firstLine.startsWith(`${kind} version `)) {
    throw new Error(`Gebundenes ${kind} widerspricht seiner gebundenen Versionszeile.`);
  }
  verifyBoundTool(tool, kind);
}

function exactIntegerString(value: unknown, label: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value.toString();
  if (typeof value !== "string" || !INTEGER_PATTERN.test(value)) {
    throw new Error(`${label} ist kein vollständiger ganzzahliger FFprobe-Wert.`);
  }
  const parsed = BigInt(value);
  if (parsed.toString() !== value) throw new Error(`${label} ist nicht kanonisch.`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label} ist keine positive sichere Ganzzahl.`);
  }
  return number;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  const number = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} ist keine nichtnegative sichere Ganzzahl.`);
  }
  return number;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_000) {
    throw new Error(`${label} fehlt in der vollständigen FFprobe-Autorität.`);
  }
  return value;
}

function streamContract(
  stream: Record<string, unknown>,
  kind: "video" | "audio",
): StreamContract {
  const common = {
    codecName: requiredString(stream.codec_name, `${kind}.codec_name`),
    codecTag: optionalString(stream.codec_tag),
    codecTagString: optionalString(stream.codec_tag_string),
    profile: optionalString(stream.profile),
    timeBase: requiredString(stream.time_base, `${kind}.time_base`),
    extradataSize: positiveSafeInteger(stream.extradata_size, `${kind}.extradata_size`),
    extradataSha256: requiredDataHash(stream.extradata_hash, `${kind}.extradata_hash`),
    sideDataSha256: sha256Canonical(normalizedSideData(stream.side_data_list, `${kind}.side_data_list`)),
  };
  parseTimeBase(common.timeBase, `${kind}.time_base`);
  if (kind === "video") {
    return {
      ...common,
      level: optionalSafeInteger(stream.level),
      pixelFormat: optionalString(stream.pix_fmt),
      width: positiveSafeInteger(stream.width, "video.width"),
      height: positiveSafeInteger(stream.height, "video.height"),
      codedWidth: positiveSafeInteger(stream.coded_width, "video.coded_width"),
      codedHeight: positiveSafeInteger(stream.coded_height, "video.coded_height"),
      sampleAspectRatio: optionalString(stream.sample_aspect_ratio),
      displayAspectRatio: optionalString(stream.display_aspect_ratio),
      fieldOrder: optionalString(stream.field_order),
      rotationTag: isRecord(stream.tags) ? optionalString(stream.tags.rotate) : null,
    };
  }
  return {
    ...common,
    sampleRate: positiveSafeInteger(stream.sample_rate, "audio.sample_rate"),
    channels: positiveSafeInteger(stream.channels, "audio.channels"),
    channelLayout: optionalString(stream.channel_layout),
  };
}

function normalizedSideData(value: unknown, label: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new Error(`${label} ist keine vollständige FFprobe-Side-Data-Liste.`);
  }
  return structuredClone(value);
}

function skipSideDataStatic(entries: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return entries
    .filter((entry) => entry.side_data_type === "Skip Samples")
    .map((entry) => {
      const cloned = structuredClone(entry);
      delete cloned.skip_samples;
      return cloned;
    });
}

function requiredDataHash(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} fehlt.`);
  const match = HASHED_DATA_PATTERN.exec(value);
  if (!match) throw new Error(`${label} ist kein kanonischer SHA-256-Datenhash.`);
  return match[1];
}

function canonicalPacket(
  packet: Record<string, unknown>,
  videoIndex: number,
  audioIndex: number,
): CanonicalPacket {
  const streamIndex = optionalSafeInteger(packet.stream_index);
  const stream = streamIndex === videoIndex ? "video" : streamIndex === audioIndex ? "audio" : null;
  if (!stream) throw new Error("FFprobe meldete ein Paket außerhalb der exakt zwei gebundenen Streams.");
  const flags = requiredString(packet.flags, `${stream}.packet.flags`);
  if (!/^[A-Z_]{3,16}$/u.test(flags)) throw new Error(`${stream}.packet.flags ist nicht kanonisch.`);
  const sideDataEntries = normalizedSideData(
    packet.side_data_list,
    `${stream}.packet.side_data_list`,
  );
  const skipEntries = sideDataEntries.filter((entry) => entry.side_data_type === "Skip Samples");
  if (skipEntries.length > 1) throw new Error(`${stream}.packet enthält mehrere Skip-Samples-Autoritäten.`);
  const skipSamples = skipEntries.length === 1
    ? nonNegativeSafeInteger(skipEntries[0].skip_samples, `${stream}.packet.skip_samples`)
    : 0;
  const discardPadding = skipEntries.length === 1
    ? nonNegativeSafeInteger(skipEntries[0].discard_padding, `${stream}.packet.discard_padding`)
    : 0;
  return {
    stream,
    pts: exactIntegerString(packet.pts, `${stream}.packet.pts`),
    dts: exactIntegerString(packet.dts, `${stream}.packet.dts`),
    duration: exactIntegerString(packet.duration, `${stream}.packet.duration`),
    flags,
    size: positiveSafeInteger(packet.size, `${stream}.packet.size`),
    dataSha256: requiredDataHash(packet.data_hash, `${stream}.packet.data_hash`),
    skipSamples,
    discardPadding,
    sideDataSha256: sha256Canonical(sideDataEntries),
    nonSkipSideDataSha256: sha256Canonical(
      sideDataEntries.filter((entry) => entry.side_data_type !== "Skip Samples"),
    ),
    skipSideDataStaticSha256: sha256Canonical(skipSideDataStatic(sideDataEntries)),
  };
}

const FFPROBE_ARGS = Object.freeze([
  "-v", "error",
  "-show_streams", "-show_packets",
  "-show_entries",
  "stream=index,codec_type,codec_name,codec_tag_string,codec_tag,profile,level,pix_fmt,width,height,coded_width,coded_height,sample_aspect_ratio,display_aspect_ratio,field_order,sample_rate,channels,channel_layout,time_base,extradata_size,extradata_hash:stream_tags=rotate:stream_side_data:packet=stream_index,pts,dts,duration,flags,size,data_hash:packet_side_data",
  "-show_data_hash", "sha256",
  "-of", "json",
  "/proc/self/fd/4",
] as const);

export function positiveAudioRetimeArgsSha256(args: readonly string[]): string {
  if (!Array.isArray(args)
    || !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
    throw new Error("Audio-Retime-Argumentdigest benötigt eine vollständige NUL-freie argv-Liste.");
  }
  return sha256Canonical(args);
}

export const POSITIVE_AUDIO_RETIME_FFPROBE_ARGS_SHA256 = sha256Canonical(FFPROBE_ARGS);

function decodeArgs(primingCompensationSamples: number): string[] {
  if (!Number.isSafeInteger(primingCompensationSamples)
    || primingCompensationSamples < 0
    || primingCompensationSamples > 65_536) {
    throw new Error("AAC-Priming-Kompensation liegt außerhalb der sicheren Receipt-Grenze.");
  }
  const filter = primingCompensationSamples === 0
    ? "aresample=48000:async=1:first_pts=0"
    : `atrim=start_sample=${primingCompensationSamples},aresample=48000:async=1:first_pts=0`;
  return [
    "-v", "error", "-nostdin", "-copyts",
    "-i", "/proc/self/fd/4",
    "-map", "0:a:0", "-vn",
    "-af", filter,
    "-ac", "2", "-ar", "48000",
    "-c:a", "pcm_s32le", "-f", "s32le", "pipe:1",
  ];
}

function probeMedia(
  ffprobe: BoundAudioRetimeExecutable,
  media: OpenMedia,
  timeoutMs: number,
): ProbedMedia {
  verifyBoundTool(ffprobe, "ffprobe");
  verifyOpenMedia(media);
  const result = spawnSync("/proc/self/fd/3", [...FFPROBE_ARGS], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    shell: false,
    timeout: timeoutMs,
    maxBuffer: MAX_PROBE_BYTES,
    stdio: ["ignore", "pipe", "pipe", ffprobe.fd, media.descriptor],
  });
  if (result.error || result.status !== 0 || result.signal !== null || result.stderr.length > 0) {
    throw new Error(`Gebundenes FFprobe scheiterte fail-closed für Audio-Retime-${media.label}.`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`FFprobe lieferte kein JSON für Audio-Retime-${media.label}.`);
  }
  if (!isRecord(payload)
    || !Array.isArray(payload.streams)
    || !payload.streams.every(isRecord)
    || !Array.isArray(payload.packets)
    || !payload.packets.every(isRecord)
    || payload.packets.length < 2
    || payload.packets.length > MAX_PACKET_COUNT) {
    throw new Error(`FFprobe lieferte keine vollständige begrenzte Paketautorität für ${media.label}.`);
  }
  const videos = payload.streams.filter((stream) => stream.codec_type === "video");
  const audios = payload.streams.filter((stream) => stream.codec_type === "audio");
  if (payload.streams.length !== 2 || videos.length !== 1 || audios.length !== 1) {
    throw new Error(`Audio-Retime-${media.label} benötigt exakt eine Video- und eine Audiospur ohne Extras.`);
  }
  const videoIndex = optionalSafeInteger(videos[0].index);
  const audioIndex = optionalSafeInteger(audios[0].index);
  if (videoIndex === null || audioIndex === null || videoIndex === audioIndex) {
    throw new Error(`Audio-Retime-${media.label} besitzt keine eindeutigen Streamindizes.`);
  }
  const completePackets = payload.packets.map((packet) =>
    canonicalPacket(packet, videoIndex, audioIndex));
  const videoPackets = completePackets.filter((packet) => packet.stream === "video");
  const audioPackets = completePackets.filter((packet) => packet.stream === "audio");
  if (videoPackets.length < 1 || audioPackets.length < 1) {
    throw new Error(`Audio-Retime-${media.label} besitzt eine leere Video- oder Paketspur.`);
  }
  verifyOpenMedia(media);
  verifyBoundTool(ffprobe, "ffprobe");
  return {
    videoStream: streamContract(videos[0], "video"),
    audioStream: streamContract(audios[0], "audio"),
    videoPackets,
    audioPackets,
    completePackets,
  };
}

function decodePcm(
  ffmpeg: BoundAudioRetimeExecutable,
  media: OpenMedia,
  primingCompensationSamples: number,
  timeoutMs: number,
): Buffer {
  verifyBoundTool(ffmpeg, "ffmpeg");
  verifyOpenMedia(media);
  const args = decodeArgs(primingCompensationSamples);
  const result = spawnSync("/proc/self/fd/3", args, {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    shell: false,
    timeout: timeoutMs,
    maxBuffer: MAX_PCM_BYTES,
    stdio: ["ignore", "pipe", "pipe", ffmpeg.fd, media.descriptor],
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  if (result.error || result.status !== 0 || result.signal !== null || stderr.length > 0
    || stdout.length < PCM_BYTES_PER_FRAME || stdout.length % PCM_BYTES_PER_FRAME !== 0) {
    throw new Error(`Gebundenes FFmpeg konnte Audio-Retime-${media.label} nicht vollständig als PCM dekodieren.`);
  }
  verifyOpenMedia(media);
  verifyBoundTool(ffmpeg, "ffmpeg");
  return stdout;
}

function parseTimeBase(value: string, label: string): { numerator: bigint; denominator: bigint } {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
  if (!match) throw new Error(`${label} ist keine positive rationale Timebase.`);
  const numerator = BigInt(match[1]);
  const denominator = BigInt(match[2]);
  if (numerator > BigInt(Number.MAX_SAFE_INTEGER) || denominator > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} überschreitet die sichere Timebase-Grenze.`);
  }
  return { numerator, denominator };
}

function roundedDivision(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function exactPacketDelay(
  source: ProbedMedia,
  candidate: ProbedMedia,
  requestedDelayMs: number,
): {
  ticks: bigint;
  timeBase: string;
  measuredMicroseconds: number;
  absoluteErrorMicroseconds: number;
} {
  if (source.audioPackets.length !== candidate.audioPackets.length) {
    throw new Error("Audio-Retime verlor oder ergänzte Audiopakete.");
  }
  const payload = (packet: CanonicalPacket) => ({
    size: packet.size,
    dataSha256: packet.dataSha256,
  });
  if (sha256Canonical(source.audioPackets.map(payload))
    !== sha256Canonical(candidate.audioPackets.map(payload))) {
    throw new Error("Audio-Retime änderte die kanonische Audio-Payloadpaketfolge.");
  }
  for (let index = 0; index < source.audioPackets.length; index += 1) {
    const sourcePacket = source.audioPackets[index];
    const candidatePacket = candidate.audioPackets[index];
    const finalPacket = index === source.audioPackets.length - 1;
    const durationInvalid = finalPacket
      ? BigInt(candidatePacket.duration) < BigInt(sourcePacket.duration)
      : sourcePacket.duration !== candidatePacket.duration;
    if (durationInvalid
      || (index > 0 && sourcePacket.flags !== candidatePacket.flags)
      || sourcePacket.nonSkipSideDataSha256 !== candidatePacket.nonSkipSideDataSha256
      || (index > 0
        && sourcePacket.skipSideDataStaticSha256 !== candidatePacket.skipSideDataStaticSha256)
      || sourcePacket.discardPadding !== candidatePacket.discardPadding
      || (index > 0 && sourcePacket.skipSamples !== candidatePacket.skipSamples)) {
      throw new Error(
        "Audio-Retime änderte Dauer, Flags oder Packet-Side-Data außerhalb der erlaubten ersten Priming-Markierung.",
      );
    }
  }
  const ptsDeltas = source.audioPackets.map((packet, index) =>
    BigInt(candidate.audioPackets[index].pts) - BigInt(packet.pts));
  const dtsDeltas = source.audioPackets.map((packet, index) =>
    BigInt(candidate.audioPackets[index].dts) - BigInt(packet.dts));
  const ticks = ptsDeltas[0];
  if (ticks <= 0n
    || ptsDeltas.some((value) => value !== ticks)
    || dtsDeltas.some((value) => value !== ticks)) {
    throw new Error("Audio-Retime realisierte kein konstantes positives identisches PTS-/DTS-Delta.");
  }
  const timeBase = requiredString(source.audioStream.timeBase, "source.audio.timeBase");
  if (candidate.audioStream.timeBase !== timeBase) {
    throw new Error("Audio-Retime änderte die Audio-Timebase.");
  }
  const { numerator, denominator } = parseTimeBase(timeBase, "audio.timeBase");
  const measuredUsNumerator = ticks * numerator * 1_000_000n;
  const measuredUsBig = roundedDivision(measuredUsNumerator, denominator);
  const requestedUsBig = BigInt(requestedDelayMs) * 1_000n;
  const requestedUsNumerator = requestedUsBig * denominator;
  const absoluteErrorUsNumerator = measuredUsNumerator >= requestedUsNumerator
    ? measuredUsNumerator - requestedUsNumerator
    : requestedUsNumerator - measuredUsNumerator;
  const absoluteErrorUsBig = roundedDivision(absoluteErrorUsNumerator, denominator);
  if (absoluteErrorUsNumerator > 1_000n * denominator
    || measuredUsBig > BigInt(Number.MAX_SAFE_INTEGER)
    || absoluteErrorUsBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Audio-Retime realisierte den angeforderten Versatz nicht innerhalb von 1 ms.");
  }
  return {
    ticks,
    timeBase,
    measuredMicroseconds: Number(measuredUsBig),
    absoluteErrorMicroseconds: Number(absoluteErrorUsBig),
  };
}

function packetEvidence(probe: ProbedMedia): PacketFileEvidence {
  const audioPayload = probe.audioPackets.map((packet) => ({
    size: packet.size,
    dataSha256: packet.dataSha256,
  }));
  const audioTimeline = probe.audioPackets.map((packet) => ({
    pts: packet.pts,
    dts: packet.dts,
    duration: packet.duration,
    flags: packet.flags,
    skipSamples: packet.skipSamples,
    discardPadding: packet.discardPadding,
    sideDataSha256: packet.sideDataSha256,
    nonSkipSideDataSha256: packet.nonSkipSideDataSha256,
    skipSideDataStaticSha256: packet.skipSideDataStaticSha256,
  }));
  return {
    videoPacketCount: probe.videoPackets.length,
    audioPacketCount: probe.audioPackets.length,
    videoStreamSha256: sha256Canonical(probe.videoStream),
    audioStreamSha256: sha256Canonical(probe.audioStream),
    videoPacketSequenceSha256: sha256Canonical(probe.videoPackets),
    audioPayloadSequenceSha256: sha256Canonical(audioPayload),
    audioTimelineSequenceSha256: sha256Canonical(audioTimeline),
    completePacketSequenceSha256: sha256Canonical(probe.completePackets),
  };
}

function peakAbsoluteS32(buffer: Buffer): number {
  let peak = 0;
  for (let offset = 0; offset < buffer.length; offset += PCM_BYTES_PER_SAMPLE) {
    peak = Math.max(peak, Math.abs(buffer.readInt32LE(offset)));
  }
  return peak;
}

function peakDbfs(peak: number): string {
  return peak === 0 ? "-Infinity" : (20 * Math.log10(peak / 2_147_483_648)).toFixed(6);
}

function assertPositiveDelay(delayMs: number): void {
  if (!Number.isInteger(delayMs) || delayMs < 1 || delayMs > 500) {
    throw new Error("Positive Packet-Copy-Audioverzögerung muss ganzzahlig zwischen 1 und 500 ms liegen.");
  }
}

function validatedExecutionAuthority(
  authority: PositiveAudioRetimeExecutionAuthority,
): PositiveAudioRetimeExecutionAuthority {
  const expectedKeys = [
    "jobId",
    "experimentId",
    "protocolSha256",
    "candidateRequestSha256",
    "baselineJobId",
    "baselineOutputName",
    "baselineRequestSha256",
    "sourceAuthorityRequestSha256",
    "sourceProvenanceFingerprint",
  ].sort();
  if (!isRecord(authority)
    || Object.keys(authority).sort().some((key, index) => key !== expectedKeys[index])
    || Object.keys(authority).length !== expectedKeys.length) {
    throw new Error("Audio-Retime-Authority besitzt nicht exakt das registrierte v1-Schema.");
  }
  for (const [label, value] of [
    ["jobId", authority?.jobId],
    ["experimentId", authority?.experimentId],
    ["baselineJobId", authority?.baselineJobId],
  ] as const) {
    if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
      throw new Error(`Audio-Retime-Authority besitzt keine gültige ${label}-UUID.`);
    }
  }
  for (const [label, value] of [
    ["protocolSha256", authority?.protocolSha256],
    ["candidateRequestSha256", authority?.candidateRequestSha256],
    ["baselineRequestSha256", authority?.baselineRequestSha256],
    ["sourceAuthorityRequestSha256", authority?.sourceAuthorityRequestSha256],
    ["sourceProvenanceFingerprint", authority?.sourceProvenanceFingerprint],
  ] as const) {
    if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
      throw new Error(`Audio-Retime-Authority besitzt keinen kanonischen ${label}.`);
    }
  }
  if (typeof authority?.baselineOutputName !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.(?:mp4|wav)$/u.test(authority.baselineOutputName)) {
    throw new Error("Audio-Retime-Authority besitzt keinen sicheren Baseline-Ausgabenamen.");
  }
  if (authority.jobId === authority.baselineJobId
    || authority.candidateRequestSha256 === authority.baselineRequestSha256) {
    throw new Error("Audio-Retime-Authority trennt Kandidat und Baseline nicht eindeutig.");
  }
  return {
    jobId: authority.jobId,
    experimentId: authority.experimentId,
    protocolSha256: authority.protocolSha256,
    candidateRequestSha256: authority.candidateRequestSha256,
    baselineJobId: authority.baselineJobId,
    baselineOutputName: authority.baselineOutputName,
    baselineRequestSha256: authority.baselineRequestSha256,
    sourceAuthorityRequestSha256: authority.sourceAuthorityRequestSha256,
    sourceProvenanceFingerprint: authority.sourceProvenanceFingerprint,
  };
}

export function buildPositiveAudioRetimePacketCopyArgs(
  sourceFdPath: string,
  candidatePath: string,
  requestedDelayMs: number,
): string[] {
  assertPositiveDelay(requestedDelayMs);
  if (!FD_PATH_PATTERN.test(sourceFdPath)) {
    throw new Error("Positive Packet-Copy-Audioverzögerung benötigt einen gehaltenen Source-FD-Pfad.");
  }
  assertCanonicalAbsolutePath(candidatePath, "Packet-Copy-Kandidat");
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
    "-i", sourceFdPath,
    "-itsoffset", (requestedDelayMs / 1_000).toFixed(3),
    "-i", sourceFdPath,
    "-map", "0:v:0", "-map", "1:a:0",
    "-map_metadata", "-1", "-map_chapters", "-1",
    "-c:v", "copy", "-c:a", "copy",
    "-avoid_negative_ts", "disabled",
    "-movflags", "+faststart",
    candidatePath,
  ];
}

function assertExactTransformArgs(
  args: readonly string[],
  candidatePath: string,
  requestedDelayMs: number,
): void {
  if (args.length !== 28 || !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
    throw new Error("Packet-Copy-Transform besitzt keine vollständige registrierte Argumentgrammatik.");
  }
  const sourceFdPath = args[6];
  if (sourceFdPath !== "/proc/self/fd/4") {
    throw new Error("Packet-Copy-Transform muss exakt den gehaltenen Source-FD 4 konsumieren.");
  }
  const expected = buildPositiveAudioRetimePacketCopyArgs(
    sourceFdPath,
    candidatePath,
    requestedDelayMs,
  );
  if (canonicalJson(args) !== canonicalJson(expected)) {
    throw new Error("Packet-Copy-Transform weicht von positive-delay-packet-copy.v1 ab.");
  }
}

type VerificationRoot = {
  descriptor: number;
  path: string;
  fileId: string;
  deviceId: string;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
};

type TransformReplayEvidence = {
  outputSha256: string;
  outputSizeBytes: number;
  argsSha256: string;
};

function verificationRootIdentity(stats: ReturnType<typeof fstatSync>): Omit<VerificationRoot, "descriptor" | "path"> {
  return {
    fileId: stats.ino.toString(),
    deviceId: stats.dev.toString(),
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    nlink: Number(stats.nlink),
  };
}

function sameVerificationRootIdentity(
  root: VerificationRoot,
  stats: ReturnType<typeof fstatSync>,
): boolean {
  const current = verificationRootIdentity(stats);
  return root.fileId === current.fileId
    && root.deviceId === current.deviceId
    && root.mode === current.mode
    && root.uid === current.uid
    && root.gid === current.gid
    && root.nlink === current.nlink;
}

function assertVerificationRootStable(root: VerificationRoot): void {
  const held = fstatSync(root.descriptor);
  const pathname = lstatSync(root.path);
  if (!held.isDirectory()
    || pathname.isSymbolicLink()
    || !pathname.isDirectory()
    || !sameVerificationRootIdentity(root, held)
    || !sameVerificationRootIdentity(root, pathname)) {
    throw new Error("Audio-Retime-Replay-Verzeichnis driftete von seinem gehaltenen O_NOFOLLOW-FD ab.");
  }
}

function openEmptyVerificationRoot(path: string): VerificationRoot {
  assertCanonicalAbsolutePath(path, "Audio-Retime-Replay-Verzeichnis");
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const stats = fstatSync(descriptor);
    const identity = verificationRootIdentity(stats);
    const root: VerificationRoot = { descriptor, path, ...identity };
    if (!stats.isDirectory()
      || identity.uid !== currentUid()
      || (identity.mode & 0o777) !== 0o700) {
      throw new Error("Audio-Retime-Replay-Verzeichnis ist nicht ownerkontrolliert mit Modus 0700.");
    }
    assertVerificationRootStable(root);
    if (readdirSync(path).length !== 0) {
      throw new Error("Audio-Retime-Replay-Verzeichnis muss vor der Prüfung leer sein.");
    }
    return root;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function bindFreshReplay(path: string): ExecutionFileBinding {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    const current = revision(stats);
    if (!stats.isFile()
      || current.sizeBytes <= 0
      || current.uid !== currentUid()
      || current.nlink !== 1) {
      throw new Error("Gebundener Audio-Retime-Replay ist keine eindeutige ownerkontrollierte Datei.");
    }
    assertPathStillBinds(path, current, "Audio-Retime-Replay");
    const sha256 = hashDescriptor(descriptor, current.sizeBytes, "Audio-Retime-Replay");
    const after = revision(fstatSync(descriptor));
    if (!sameRevision(current, after)) {
      throw new Error("Audio-Retime-Replay änderte sich während seiner Bytebindung.");
    }
    return {
      path,
      sha256,
      revision: { ...after, nlink: 1 },
    };
  } finally {
    closeSync(descriptor);
  }
}

function replayCanonicalTransform(
  ffmpeg: BoundAudioRetimeExecutable,
  source: OpenMedia,
  candidate: OpenMedia,
  verificationRootPath: string,
  requestedDelayMs: number,
  timeoutMs: number,
): TransformReplayEvidence {
  const root = openEmptyVerificationRoot(verificationRootPath);
  const replayPath = join(root.path, "positive-audio-retime-replay.mp4");
  const replayArgs = buildPositiveAudioRetimePacketCopyArgs(
    "/proc/self/fd/4",
    replayPath,
    requestedDelayMs,
  );
  let replay: OpenMedia | null = null;
  let replayCreated = false;
  let evidence: TransformReplayEvidence | null = null;
  let primaryError: unknown;
  try {
    verifyBoundTool(ffmpeg, "ffmpeg");
    verifyOpenMedia(source);
    verifyOpenMedia(candidate);
    assertVerificationRootStable(root);
    const result = spawnSync("/proc/self/fd/3", replayArgs, {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", ffmpeg.fd, source.descriptor],
    });
    try {
      lstatSync(replayPath);
      replayCreated = true;
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    if (result.error || result.status !== 0 || result.signal !== null || result.stderr.length > 0) {
      throw new Error("Gebundenes FFmpeg konnte den kanonischen Audio-Retime-Replay nicht erzeugen.");
    }
    replay = openBoundMedia("replay", bindFreshReplay(replayPath));
    if (replay.binding.sha256 !== candidate.binding.sha256
      || replay.revision.sizeBytes !== candidate.revision.sizeBytes) {
      throw new Error(
        "Audio-Retime-Kandidat ist nicht byteidentisch zum gebunden ausgeführten kanonischen FFmpeg-Replay.",
      );
    }
    verifyOpenMedia(source);
    verifyOpenMedia(candidate);
    verifyOpenMedia(replay);
    verifyBoundTool(ffmpeg, "ffmpeg");
    assertVerificationRootStable(root);
    evidence = {
      outputSha256: replay.binding.sha256,
      outputSizeBytes: replay.revision.sizeBytes,
      argsSha256: positiveAudioRetimeArgsSha256(replayArgs),
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  try {
    assertVerificationRootStable(root);
    if (replay) {
      verifyOpenMedia(replay);
      unlinkSync(replayPath);
      verifyUnlinkedReplayBytes(replay);
    } else if (replayCreated) {
      const unexpected = lstatSync(replayPath);
      if (unexpected.isSymbolicLink() || !unexpected.isFile()) {
        throw new Error("Fehlgeschlagener Audio-Retime-Replay hinterließ keine sicher löschbare Datei.");
      }
      unlinkSync(replayPath);
    }
    fsyncSync(root.descriptor);
    assertVerificationRootStable(root);
    if (readdirSync(root.path).length !== 0) {
      throw new Error("Audio-Retime-Replay-Verzeichnis enthält nach der Prüfung unerwartete Dateien.");
    }
    rmdirSync(root.path);
  } catch (error) {
    cleanupError = error;
  }
  if (replay) closeSync(replay.descriptor);
  closeSync(root.descriptor);

  const errors = [primaryError, cleanupError].filter(
    (error): error is NonNullable<unknown> => error !== undefined && error !== null,
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const detail = errors.map((error) => error instanceof Error ? error.message : String(error)).join(" | ");
    throw new AggregateError(errors, `Audio-Retime-Replay scheiterte fail-closed: ${detail}`);
  }
  if (!evidence) throw new Error("Audio-Retime-Replay erzeugte keine vollständige Evidence.");
  return evidence;
}

function toolEvidence(tool: BoundAudioRetimeExecutable): ToolEvidence {
  const binding = structuredClone(tool.binding);
  const identity = { binding, version: tool.version };
  return {
    ...identity,
    versionSha256: sha256Bytes(tool.version),
    identitySha256: sha256Canonical(identity),
  };
}

function fileEvidence(binding: ExecutionFileBinding): FileEvidence {
  const cloned = structuredClone(binding);
  return { binding: cloned, bindingSha256: sha256Canonical(cloned) };
}

/** The caller retains ownership of both executable FDs and must close them. */
export function createPositiveAudioRetimeReceipt(
  input: PositiveAudioRetimeReceiptInput,
): PositiveAudioRetimeReceipt {
  if (input.profile !== POSITIVE_AUDIO_RETIME_PROFILE) {
    throw new Error("Audio-Retime-Receipt verweigert ein unbekanntes Profil.");
  }
  assertPositiveDelay(input.requestedDelayMs);
  const executionAuthority = validatedExecutionAuthority(input.authority);
  const timeoutMs = input.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("Audio-Retime-Receipt-Timeout liegt außerhalb der sicheren Grenzen.");
  }
  assertExactTransformArgs(input.transformArgs, input.candidate.path, input.requestedDelayMs);
  if (input.ffmpeg.fd === input.ffprobe.fd) {
    throw new Error("FFmpeg und FFprobe müssen getrennt gehaltene Executable-FDs besitzen.");
  }

  let source: OpenMedia | null = null;
  let candidate: OpenMedia | null = null;
  let primaryError: unknown;
  let receipt: PositiveAudioRetimeReceipt | null = null;
  try {
    runBoundVersion(input.ffmpeg, "ffmpeg");
    runBoundVersion(input.ffprobe, "ffprobe");
    source = openBoundMedia("source", input.source);
    candidate = openBoundMedia("candidate", input.candidate);
    if (source.revision.deviceId === candidate.revision.deviceId
      && source.revision.fileId === candidate.revision.fileId) {
      throw new Error("Audio-Retime-Quelle und Kandidat dürfen nicht denselben Inode binden.");
    }

    const sourceProbe = probeMedia(input.ffprobe, source, timeoutMs);
    const candidateProbe = probeMedia(input.ffprobe, candidate, timeoutMs);
    if (canonicalJson(sourceProbe.videoStream) !== canonicalJson(candidateProbe.videoStream)) {
      throw new Error("Audio-Retime änderte Video-Codec, Extradata, Geometrie oder Timebase.");
    }
    if (canonicalJson(sourceProbe.videoPackets) !== canonicalJson(candidateProbe.videoPackets)) {
      throw new Error("Audio-Retime änderte die vollständige kanonische Videopaketfolge.");
    }
    if (canonicalJson(sourceProbe.audioStream) !== canonicalJson(candidateProbe.audioStream)) {
      throw new Error("Audio-Retime änderte Audio-Codec, Extradata oder Timebase.");
    }
    const packetDelay = exactPacketDelay(sourceProbe, candidateProbe, input.requestedDelayMs);

    const sourceInitialSkipSamples = sourceProbe.audioPackets[0].skipSamples;
    const candidateInitialSkipSamples = candidateProbe.audioPackets[0].skipSamples;
    if (candidateInitialSkipSamples > sourceInitialSkipSamples) {
      throw new Error("Audio-Retime-Kandidat ergänzte eine nicht autorisierte Codec-Priming-Kürzung.");
    }
    const candidatePrimingCompensationSamples = sourceInitialSkipSamples - candidateInitialSkipSamples;
    const sourceDecodeArgs = decodeArgs(0);
    const candidateDecodeArgs = decodeArgs(candidatePrimingCompensationSamples);
    const sourcePcm = decodePcm(input.ffmpeg, source, 0, timeoutMs);
    const candidatePcm = decodePcm(
      input.ffmpeg,
      candidate,
      candidatePrimingCompensationSamples,
      timeoutMs,
    );
    const prefixByteLength = candidatePcm.length - sourcePcm.length;
    if (prefixByteLength <= 0 || prefixByteLength % PCM_BYTES_PER_FRAME !== 0) {
      throw new Error("Audio-Retime-Kandidat besitzt keinen exakten zusätzlichen PCM-Framepräfix.");
    }
    const prefix = candidatePcm.subarray(0, prefixByteLength);
    const alignedCandidate = candidatePcm.subarray(prefixByteLength);
    if (!alignedCandidate.equals(sourcePcm)) {
      throw new Error("Audio-Retime-Kandidat ist nach seinem Leading-Prefix nicht PCM-byteidentisch zur Quelle.");
    }
    const prefixFrames = prefixByteLength / PCM_BYTES_PER_FRAME;
    const prefixErrorUsNumerator = BigInt(Math.abs(
      prefixFrames * 1_000_000 - input.requestedDelayMs * 1_000 * PCM_SAMPLE_RATE,
    ));
    if (prefixErrorUsNumerator > BigInt(1_000 * PCM_SAMPLE_RATE)
      || Math.abs(Math.round(prefixFrames * 1_000_000 / PCM_SAMPLE_RATE)
        - packetDelay.measuredMicroseconds) > 1_000) {
      throw new Error("Audio-Retime-PCM-Präfix widerspricht dem angeforderten oder gemessenen Paketversatz.");
    }
    const prefixPeak = peakAbsoluteS32(prefix);
    if (prefixPeak > PREFIX_PEAK_LIMIT_S32) {
      throw new Error("Audio-Retime-PCM-Präfix überschreitet -90 dBFS und ist nicht hinreichend still.");
    }

    const replayEvidence = replayCanonicalTransform(
      input.ffmpeg,
      source,
      candidate,
      input.verificationRoot,
      input.requestedDelayMs,
      timeoutMs,
    );

    verifyOpenMedia(source);
    verifyOpenMedia(candidate);
    runBoundVersion(input.ffmpeg, "ffmpeg");
    runBoundVersion(input.ffprobe, "ffprobe");

    const filesWithoutDigest = {
      source: fileEvidence(input.source),
      candidate: fileEvidence(input.candidate),
    };
    const toolsWithoutDigest = {
      ffmpeg: toolEvidence(input.ffmpeg),
      ffprobe: toolEvidence(input.ffprobe),
    };
    const argsWithoutDigest = {
      transformArgsSha256: positiveAudioRetimeArgsSha256(input.transformArgs),
      ffprobeArgsSha256: POSITIVE_AUDIO_RETIME_FFPROBE_ARGS_SHA256,
      sourceDecodeArgsSha256: sha256Canonical(sourceDecodeArgs),
      candidateDecodeArgsSha256: sha256Canonical(candidateDecodeArgs),
      transformReplayArgsSha256: replayEvidence.argsSha256,
      versionArgsSha256: sha256Canonical(["-version"]),
    };
    const authorityWithoutDigest = {
      ...executionAuthority,
      requestedDelayMs: input.requestedDelayMs,
      sourceBindingSha256: filesWithoutDigest.source.bindingSha256,
      candidateBindingSha256: filesWithoutDigest.candidate.bindingSha256,
    };
    const transformWithoutDigest = {
      requestedDelayMs: input.requestedDelayMs,
      measuredDelayTicks: packetDelay.ticks.toString(),
      measuredDelayTimeBase: packetDelay.timeBase,
      measuredDelayMicroseconds: packetDelay.measuredMicroseconds,
      absoluteErrorMicroseconds: packetDelay.absoluteErrorMicroseconds,
      pcmLeadingPrefixFrames: prefixFrames,
      replayOutputSha256: replayEvidence.outputSha256,
      replayOutputSizeBytes: replayEvidence.outputSizeBytes,
    };
    const packetsWithoutDigest = {
      source: packetEvidence(sourceProbe),
      candidate: packetEvidence(candidateProbe),
    };
    const pcmWithoutDigest = {
      format: "s32le/48000/stereo" as const,
      bytesPerFrame: PCM_BYTES_PER_FRAME as 8,
      sourceByteLength: sourcePcm.length,
      sourceFrameCount: sourcePcm.length / PCM_BYTES_PER_FRAME,
      sourceSha256: sha256Bytes(sourcePcm),
      candidateByteLength: candidatePcm.length,
      candidateFrameCount: candidatePcm.length / PCM_BYTES_PER_FRAME,
      candidateSha256: sha256Bytes(candidatePcm),
      leadingPrefixByteLength: prefix.length,
      leadingPrefixFrameCount: prefixFrames,
      leadingPrefixSha256: sha256Bytes(prefix),
      leadingPrefixPeakAbsoluteS32: prefixPeak,
      leadingPrefixPeakDbfs: peakDbfs(prefixPeak),
      sourceInitialSkipSamples,
      candidateInitialSkipSamples,
      candidatePrimingCompensationSamples,
      alignedCandidateSha256: sha256Bytes(alignedCandidate),
    };
    const checks = {
      exactlyOneVideoAndOneAudioPerFile: true,
      noExtraStreams: true,
      videoCodecExtradataGeometryTimeBaseIdentical: true,
      videoPacketSequenceIdentical: true,
      audioCodecExtradataTimeBaseIdentical: true,
      audioPacketCountIdentical: true,
      audioPayloadPacketSequenceIdentical: true,
      audioPtsDeltaConstantPositive: true,
      audioDtsDeltaConstantPositive: true,
      audioPtsDtsDeltaIdentical: true,
      requestedDelayWithinOneMillisecond: true,
      decodedPcmHasOnlySilentLeadingPrefix: true,
      decodedPcmSuffixByteIdentical: true,
      noAudioPacketsLost: true,
      noAudioTailDrop: true,
      allBoundFilesAndToolsStable: true,
      boundTransformReplayByteIdentical: true,
    } as const;
    const evidenceWithoutDigest = {
      schemaVersion: POSITIVE_AUDIO_RETIME_RECEIPT_SCHEMA,
      profile: POSITIVE_AUDIO_RETIME_PROFILE,
      authority: { ...authorityWithoutDigest, canonicalSha256: sha256Canonical(authorityWithoutDigest) },
      transform: { ...transformWithoutDigest, canonicalSha256: sha256Canonical(transformWithoutDigest) },
      tools: { ...toolsWithoutDigest, canonicalSha256: sha256Canonical(toolsWithoutDigest) },
      args: { ...argsWithoutDigest, canonicalSha256: sha256Canonical(argsWithoutDigest) },
      files: { ...filesWithoutDigest, canonicalSha256: sha256Canonical(filesWithoutDigest) },
      packets: { ...packetsWithoutDigest, canonicalSha256: sha256Canonical(packetsWithoutDigest) },
      pcm: { ...pcmWithoutDigest, canonicalSha256: sha256Canonical(pcmWithoutDigest) },
      checks,
    };
    receipt = {
      ...evidenceWithoutDigest,
      evidenceSha256: sha256Canonical(evidenceWithoutDigest),
    };
  } catch (error) {
    primaryError = error;
  }

  let postBindingError: unknown;
  try {
    if (source) verifyOpenMedia(source);
    if (candidate) verifyOpenMedia(candidate);
    verifyBoundTool(input.ffmpeg, "ffmpeg");
    verifyBoundTool(input.ffprobe, "ffprobe");
  } catch (error) {
    postBindingError = error;
  }
  if (candidate) closeSync(candidate.descriptor);
  if (source) closeSync(source.descriptor);

  const errors = [primaryError, postBindingError].filter(
    (error): error is NonNullable<unknown> => error !== undefined && error !== null,
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const detail = errors.map((error) => error instanceof Error ? error.message : String(error)).join(" | ");
    throw new AggregateError(errors, `Audio-Retime-Receipt scheiterte fail-closed: ${detail}`);
  }
  if (!receipt) throw new Error("Audio-Retime-Receipt erzeugte keine vollständige Evidence.");
  return receipt;
}
