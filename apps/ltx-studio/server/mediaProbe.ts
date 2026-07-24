import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export type VideoMetadata = {
  width: number | null;
  height: number | null;
  frames: number | null;
  fps: number | null;
  durationSeconds: number | null;
  hasAudio: boolean | null;
  videoCodec?: string | null;
  pixelFormat?: string | null;
  nominalFps?: number | null;
  constantFrameRate?: boolean | null;
  videoStartSeconds?: number | null;
  videoStreamCount?: number;
  audioCodec?: string | null;
  audioSampleRate?: number | null;
  audioChannels?: number | null;
  audioChannelLayout?: string | null;
  audioDurationSeconds?: number | null;
  audioStartSeconds?: number | null;
  audioStreamCount?: number;
  audioVideoDurationDeltaSeconds?: number | null;
  audioVideoStartDeltaSeconds?: number | null;
  sampleAspectRatio?: string | null;
  displayAspectRatio?: string | null;
};

const metadataCache = new Map<string, { size: number; mtimeMs: number; metadata: VideoMetadata | null }>();

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseRate(value: unknown): number | null {
  if (typeof value !== "string" || value === "0/0") return null;
  const [left, right] = value.split("/");
  if (right === undefined) return positiveNumber(left);
  const numerator = Number(left);
  const denominator = Number(right);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const fps = numerator / denominator;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

export function probeVideoMetadata(path: string): VideoMetadata | null {
  if (!path) return null;
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  const cached = metadataCache.get(path);
  if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs) return cached.metadata;
  const result = spawnSync("ffprobe", [
    "-v",
    "error",
    "-count_frames",
    "-show_entries",
    "format=duration:"
      + "stream=codec_type,codec_name,width,height,pix_fmt,nb_read_frames,nb_frames,"
      + "avg_frame_rate,r_frame_rate,duration,start_time,sample_rate,channels,channel_layout,"
      + "sample_aspect_ratio,display_aspect_ratio",
    "-of",
    "json",
    path,
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || !result.stdout) {
    metadataCache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, metadata: null });
    return null;
  }
  try {
    const body = JSON.parse(result.stdout) as { streams?: unknown[]; format?: Record<string, unknown> };
    const streams = Array.isArray(body.streams) ? body.streams as Record<string, unknown>[] : [];
    const videoStreams = streams.filter((item) => item.codec_type === "video");
    const audioStreams = streams.filter((item) => item.codec_type === "audio");
    const stream = videoStreams[0];
    const audioStream = audioStreams[0];
    if (!stream) return null;
    const averageFps = parseRate(stream.avg_frame_rate);
    const nominalFps = parseRate(stream.r_frame_rate);
    const fps = averageFps ?? nominalFps;
    const formatDuration = positiveNumber(body.format?.duration);
    const durationSeconds = positiveNumber(stream.duration) ?? formatDuration;
    const videoStartSeconds = finiteNumber(stream.start_time);
    const audioDurationSeconds = positiveNumber(audioStream?.duration) ?? (audioStream ? formatDuration : null);
    const audioStartSeconds = finiteNumber(audioStream?.start_time);
    const hasAudio = streams.some((item) => item.codec_type === "audio");
    const width = Math.round(positiveNumber(stream.width) ?? 0);
    const height = Math.round(positiveNumber(stream.height) ?? 0);
    const frames = Math.round(
      positiveNumber(stream.nb_read_frames)
        ?? positiveNumber(stream.nb_frames)
        ?? (durationSeconds !== null && fps !== null ? durationSeconds * fps : 0),
    );
    const metadata = {
      width: width > 0 ? width : null,
      height: height > 0 ? height : null,
      frames: frames > 0 ? frames : null,
      fps,
      durationSeconds,
      hasAudio,
      videoCodec: optionalString(stream.codec_name),
      pixelFormat: optionalString(stream.pix_fmt),
      nominalFps,
      constantFrameRate: averageFps !== null && nominalFps !== null
        ? Math.abs(averageFps - nominalFps) <= 0.001
        : null,
      videoStartSeconds,
      videoStreamCount: videoStreams.length,
      audioCodec: optionalString(audioStream?.codec_name),
      audioSampleRate: Math.round(positiveNumber(audioStream?.sample_rate) ?? 0) || null,
      audioChannels: Math.round(positiveNumber(audioStream?.channels) ?? 0) || null,
      audioChannelLayout: optionalString(audioStream?.channel_layout),
      audioDurationSeconds,
      audioStartSeconds,
      audioStreamCount: audioStreams.length,
      audioVideoDurationDeltaSeconds: durationSeconds !== null && audioDurationSeconds !== null
        ? Math.abs(durationSeconds - audioDurationSeconds)
        : null,
      audioVideoStartDeltaSeconds: videoStartSeconds !== null && audioStartSeconds !== null
        ? Math.abs(videoStartSeconds - audioStartSeconds)
        : null,
      sampleAspectRatio: optionalString(stream.sample_aspect_ratio),
      displayAspectRatio: optionalString(stream.display_aspect_ratio),
    };
    metadataCache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, metadata });
    return metadata;
  } catch {
    metadataCache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, metadata: null });
    return null;
  }
}
