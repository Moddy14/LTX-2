import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { GenerationRequest } from "../shared/pipelines.js";
import type { PreparedLipDubReference } from "../shared/plan.js";
import { uploadRoot } from "./config.js";
import { probeVideoMetadata } from "./mediaProbe.js";
import { recommendedLipDubOutputSize } from "./command.js";
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
  lipDub: Pick<GenerationRequest["lipDub"], "referenceVideo">;
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function chooseConstantFps(fps: number | null): 24 | 25 | 30 {
  const supported = [24, 25, 30] as const;
  if (fps === null) return 24;
  return supported.reduce((best, candidate) =>
    Math.abs(candidate - fps) < Math.abs(best - fps) ? candidate : best,
  );
}

function preparedReferenceName(sourcePath: string): string {
  const sourceName = basename(sourcePath).replace(/\.[^.]+$/, "") || "reference";
  return `${sourceName}-lipdub-prep.mp4`;
}

function targetSize(
  request: LipDubReferencePreparationInput,
  metadata: NonNullable<ReturnType<typeof probeVideoMetadata>>,
): { width: number; height: number } {
  return recommendedLipDubOutputSize(metadata) ?? { width: request.width, height: request.height };
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
  const fps = chooseConstantFps(metadata.fps);
  const videoFilter =
    `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,`
    + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
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
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "18",
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
        originalname: preparedReferenceName(sourcePath),
        size: stats.size,
      },
      target: { width, height, fps },
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
