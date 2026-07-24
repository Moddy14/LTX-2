import { statSync } from "node:fs";
import { spawnSync } from "node:child_process";

export type VideoMetadata = {
  frames: number | null;
  fps: number | null;
  durationSeconds: number | null;
};

const metadataCache = new Map<string, { size: number; mtimeMs: number; metadata: VideoMetadata | null }>();

function positiveNumber(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=nb_read_frames,nb_frames,avg_frame_rate,r_frame_rate,duration",
    "-of",
    "json",
    path,
  ], { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0 || !result.stdout) {
    metadataCache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, metadata: null });
    return null;
  }
  try {
    const body = JSON.parse(result.stdout) as { streams?: unknown[] };
    const stream = Array.isArray(body.streams) ? body.streams[0] as Record<string, unknown> | undefined : undefined;
    if (!stream) return null;
    const fps = parseRate(stream.avg_frame_rate) ?? parseRate(stream.r_frame_rate);
    const durationSeconds = positiveNumber(stream.duration);
    const frames = Math.round(
      positiveNumber(stream.nb_read_frames)
        ?? positiveNumber(stream.nb_frames)
        ?? (durationSeconds !== null && fps !== null ? durationSeconds * fps : 0),
    );
    const metadata = {
      frames: frames > 0 ? frames : null,
      fps,
      durationSeconds,
    };
    metadataCache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, metadata });
    return metadata;
  } catch {
    metadataCache.set(path, { size: stats.size, mtimeMs: stats.mtimeMs, metadata: null });
    return null;
  }
}
