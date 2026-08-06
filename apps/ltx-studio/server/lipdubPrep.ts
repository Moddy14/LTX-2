import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { GenerationRequest } from "../shared/pipelines.js";
import type { PreparedLipDubReference } from "../shared/plan.js";
import { uploadRoot } from "./config.js";
import { probeVideoMetadata } from "./mediaProbe.js";
import {
  chooseLipDubConstantFps,
  OFFICIAL_COMFY_LIPDUB_OUTPUT_AREA,
  recommendedLipDubOutputSize,
  snapLipDubFrames,
} from "./lipdubDiagnostics.js";
import { matchesUploadSignature } from "./uploads.js";
import type { AssetFile } from "./assets.js";

export class LipDubReferencePreparationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "LipDubReferencePreparationError";
  }
}

type PreparedLipDubReferenceFile = Omit<PreparedLipDubReference, "asset"> & {
  file: AssetFile;
};

export type LipDubReferencePreparationInput = Pick<GenerationRequest, "width" | "height"> & {
  mode?: GenerationRequest["mode"];
  lipDub: Pick<GenerationRequest["lipDub"], "pipelineProfile" | "referenceVideo">;
  trim?: {
    startSeconds: number;
    durationSeconds: number;
  };
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function preparedReferenceName(sourcePathOrName: string, trimmed: boolean): string {
  const sourceName = basename(sourcePathOrName).replace(/\.[^.]+$/, "") || "reference";
  return `${sourceName}-lipdub-${trimmed ? "calibration" : "prep"}.mp4`;
}

function targetSize(
  request: LipDubReferencePreparationInput,
  metadata: NonNullable<ReturnType<typeof probeVideoMetadata>>,
): { width: number; height: number } {
  return recommendedLipDubOutputSize(
    metadata,
    request.lipDub.pipelineProfile === "official-comfy-hq" ? OFFICIAL_COMFY_LIPDUB_OUTPUT_AREA : null,
  ) ?? { width: request.width, height: request.height };
}

function metadataDurationSeconds(metadata: NonNullable<ReturnType<typeof probeVideoMetadata>>): number | null {
  if (metadata.durationSeconds !== null) return metadata.durationSeconds;
  if (metadata.frames !== null && metadata.fps !== null) return metadata.frames / metadata.fps;
  return null;
}

function preparationWindow(
  request: LipDubReferencePreparationInput,
  sourceDurationSeconds: number | null,
): { startSeconds: number; requestedDurationSeconds: number } {
  const startSeconds = request.trim?.startSeconds ?? 0;
  const requestedDurationSeconds = request.trim?.durationSeconds
    ?? (sourceDurationSeconds === null ? 0 : sourceDurationSeconds);
  if (!Number.isFinite(startSeconds) || startSeconds < 0) {
    throw new LipDubReferencePreparationError("Start des Kalibrierclips muss mindestens 0 Sekunden sein.");
  }
  if (!Number.isFinite(requestedDurationSeconds) || requestedDurationSeconds <= 0) {
    throw new LipDubReferencePreparationError("Dauer der Referenzvorbereitung konnte nicht bestimmt werden.");
  }
  if (request.trim && (requestedDurationSeconds < 2 || requestedDurationSeconds > 5)) {
    throw new LipDubReferencePreparationError("Ein LipDub-Kalibrierclip muss zwischen 2 und 5 Sekunden lang sein.");
  }
  if (sourceDurationSeconds !== null && startSeconds + requestedDurationSeconds > sourceDurationSeconds + 0.01) {
    throw new LipDubReferencePreparationError(
      `Kalibrierclip endet bei ${(startSeconds + requestedDurationSeconds).toFixed(2)} s, `
      + `das Referenzvideo ist aber nur ${sourceDurationSeconds.toFixed(2)} s lang.`,
    );
  }
  return { startSeconds, requestedDurationSeconds };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 300_000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new LipDubReferencePreparationError(`FFmpeg konnte nicht gestartet werden: ${error.message}`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new LipDubReferencePreparationError("FFmpeg-Referenzvorbereitung hat das Zeitlimit überschritten.", 500));
      } else if (code === 0) {
        resolvePromise();
      } else {
        reject(new LipDubReferencePreparationError(
          `FFmpeg-Referenzvorbereitung fehlgeschlagen: ${stderr || `Exit-Code ${code}`}`,
          400,
        ));
      }
    });
  });
}

export async function prepareLipDubReference(
  request: LipDubReferencePreparationInput,
  preparedUploadRoot = uploadRoot,
): Promise<PreparedLipDubReferenceFile> {
  if (request.mode !== undefined && request.mode !== "lipdub") {
    throw new LipDubReferencePreparationError("Referenzvorbereitung ist nur im LipDub-Modus verfügbar.");
  }
  const sourcePath = request.lipDub.referenceVideo.path;
  if (!sourcePath) throw new LipDubReferencePreparationError("LipDub-Referenzvideo fehlt.");

  const metadata = probeVideoMetadata(sourcePath);
  if (!metadata) {
    throw new LipDubReferencePreparationError(`LipDub-Referenzvideo konnte nicht dekodiert werden (${sourcePath}).`);
  }
  if (metadata.hasAudio !== true) {
    throw new LipDubReferencePreparationError(`LipDub-Referenzvideo enthält keine verlässliche Audiospur (${sourcePath}).`);
  }

  const videoDir = join(preparedUploadRoot, "video");
  mkdirSync(videoDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const filename = `${id}.mp4`;
  const outputPath = join(videoDir, filename);
  const temporaryPath = join(videoDir, `${id}.preparing.mp4`);
  const { width, height } = targetSize(request, metadata);
  const fps = chooseLipDubConstantFps(metadata.fps);
  const window = preparationWindow(request, metadataDurationSeconds(metadata));
  const frames = snapLipDubFrames(Math.max(1, Math.floor(window.requestedDurationSeconds * fps + 0.0001)));
  if (frames < 9) {
    throw new LipDubReferencePreparationError("Vorbereitete LipDub-Referenz hätte weniger als 9 Frames.");
  }
  const durationSeconds = frames / fps;
  const trimPrefix = request.trim
    ? `trim=start=${window.startSeconds}:duration=${window.requestedDurationSeconds},setpts=PTS-STARTPTS,`
    : "setpts=PTS-STARTPTS,";
  const videoFilter =
    `${trimPrefix}fps=${fps},trim=end_frame=${frames},setpts=PTS-STARTPTS,`
    + `scale=${width}:${height}:force_original_aspect_ratio=increase,`
    + `crop=${width}:${height},setsar=1`;
  const audioFilter =
    `atrim=start=${window.startSeconds}:duration=${durationSeconds},asetpts=PTS-STARTPTS,`
    + "aresample=48000,aformat=channel_layouts=stereo,"
    + `apad,atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    sourcePath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-vf",
    videoFilter,
    "-af",
    audioFilter,
    "-frames:v",
    String(frames),
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    temporaryPath,
  ];

  try {
    await runFfmpeg(args);
    if (!matchesUploadSignature(temporaryPath)) {
      throw new LipDubReferencePreparationError("Vorbereitete LipDub-Referenz ist kein gültiges MP4.", 500);
    }
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, outputPath);
    const stats = statSync(outputPath);
    return {
      file: {
        filename,
        path: outputPath,
        originalname: preparedReferenceName(
          request.lipDub.referenceVideo.name || sourcePath,
          Boolean(request.trim),
        ),
        size: stats.size,
      },
      target: { width, height, fps, frames, durationSeconds },
      trim: request.trim
        ? {
            startSeconds: window.startSeconds,
            requestedDurationSeconds: window.requestedDurationSeconds,
          }
        : null,
      command: ["ffmpeg", ...args].map(shellQuote).join(" "),
    };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    rmSync(outputPath, { force: true });
    if (error instanceof LipDubReferencePreparationError) throw error;
    throw new LipDubReferencePreparationError(
      `LipDub-Referenzvorbereitung fehlgeschlagen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`,
      500,
    );
  }
}
