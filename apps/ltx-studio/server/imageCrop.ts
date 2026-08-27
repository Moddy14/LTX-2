import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { ImageCropFit, PreparedImageCrop } from "../shared/plan.js";
import { hostTcbExecutables, uploadRoot } from "./config.js";
import { probeVideoMetadata } from "./mediaProbe.js";
import { matchesUploadSignature } from "./uploads.js";
import type { AssetFile } from "./assets.js";

export class ImageCropPreparationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ImageCropPreparationError";
  }
}

export type ImageCropPreparationInput = {
  path: string;
  sourceName?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
  /** Voreinstellung "stretch" hält das bisherige Verhalten bei. */
  fit?: ImageCropFit;
  /** Nur bei "bokeh": Anteil der Zielhöhe für den Ausschnitt. */
  coverage?: number;
  /** Nur bei "bokeh": weiche Kante in Pixeln. */
  feather?: number;
};

export const DEFAULT_BOKEH_COVERAGE = 0.94;
export const DEFAULT_BOKEH_FEATHER = 90;

type PreparedImageCropFile = Omit<PreparedImageCrop, "asset"> & {
  file: AssetFile;
  command: string;
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function outputName(sourcePath: string, input: ImageCropPreparationInput): string {
  const stem = basename(input.sourceName || sourcePath).replace(/\.[^.]+$/, "") || "reference";
  return `${stem}-crop-${input.x}-${input.y}-${input.width}x${input.height}`
    + `-to-${input.outputWidth}x${input.outputHeight}.png`;
}

export type CropFilterPlan = {
  flag: "-vf" | "-filter_complex";
  filter: string;
  fit: ImageCropFit;
  coverage: number | null;
  feather: number | null;
};

/**
 * Baut den FFmpeg-Filter für den Zuschnitt.
 *
 * "stretch" zieht den Ausschnitt auf die Zielmaße. "bokeh" passt ihn dagegen
 * proportional ein und legt ihn mittig auf eine formatfüllende, weichgezeichnete
 * Fassung desselben Ausschnitts; die Kante läuft über `feather` Pixel weich aus.
 * Der Hintergrund entsteht mit `force_original_aspect_ratio=increase` plus Crop,
 * wird also ebenfalls nicht verzerrt, und stammt aus demselben Bild - dadurch
 * passen Farben und Helligkeit von selbst.
 */
export function buildImageCropFilter(input: ImageCropPreparationInput): CropFilterPlan {
  const crop = `crop=${input.width}:${input.height}:${input.x}:${input.y}:exact=1`;
  if ((input.fit ?? "stretch") === "stretch") {
    return {
      flag: "-vf",
      filter: `${crop},scale=${input.outputWidth}:${input.outputHeight}:flags=lanczos,setsar=1`,
      fit: "stretch",
      coverage: null,
      feather: null,
    };
  }

  const coverage = input.coverage ?? DEFAULT_BOKEH_COVERAGE;
  const feather = Math.round(input.feather ?? DEFAULT_BOKEH_FEATHER);
  const fitWidth = Math.max(2, Math.round(input.outputWidth * coverage));
  const fitHeight = Math.max(2, Math.round(input.outputHeight * coverage));
  // Der Weichzeichner skaliert mit dem Bild, damit der Hintergrund bei jeder
  // Zielgröße gleich stark aufgelöst wirkt.
  const blur = Math.max(8, Math.round(input.outputWidth / 48));
  // Die Alpha-Rampe misst den Abstand zum nächsten Rand; W und H sind hier die
  // Maße des bereits skalierten Vordergrunds, nicht die des Zielrahmens.
  const alpha = feather > 0
    ? `255*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/${feather})`
    : "255";
  const filter = [
    `[0:v]${crop},split=2[fgsrc][bgsrc]`,
    `[bgsrc]scale=${input.outputWidth}:${input.outputHeight}`
      + `:force_original_aspect_ratio=increase:flags=lanczos`
      + `,crop=${input.outputWidth}:${input.outputHeight},boxblur=${blur}:3,setsar=1[bg]`,
    `[fgsrc]scale=${fitWidth}:${fitHeight}:force_original_aspect_ratio=decrease:flags=lanczos`
      + `,format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alpha}'[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2:format=auto,format=rgb24,setsar=1`,
  ].join(";");

  return { flag: "-filter_complex", filter, fit: "bokeh", coverage, feather };
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(hostTcbExecutables.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 120_000);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new ImageCropPreparationError(`FFmpeg konnte nicht gestartet werden: ${error.message}`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new ImageCropPreparationError("Bildzuschnitt hat das Zeitlimit überschritten.", 500));
      } else if (code === 0) {
        resolvePromise();
      } else {
        reject(new ImageCropPreparationError(
          `Bildzuschnitt fehlgeschlagen: ${stderr || `Exit-Code ${code}`}`,
          400,
        ));
      }
    });
  });
}

export async function prepareImageCrop(
  input: ImageCropPreparationInput,
  preparedUploadRoot = uploadRoot,
): Promise<PreparedImageCropFile> {
  const metadata = probeVideoMetadata(input.path);
  if (!metadata?.width || !metadata.height) {
    throw new ImageCropPreparationError(`Bildabmessungen konnten nicht gelesen werden (${input.path}).`);
  }
  if (input.x + input.width > metadata.width || input.y + input.height > metadata.height) {
    throw new ImageCropPreparationError(
      `Ausschnitt ${input.x},${input.y} + ${input.width}x${input.height} liegt außerhalb `
      + `des Quellbildes ${metadata.width}x${metadata.height}.`,
    );
  }

  const imageDir = join(preparedUploadRoot, "image");
  mkdirSync(imageDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const filename = `${id}.png`;
  const resultPath = join(imageDir, filename);
  const temporaryPath = join(imageDir, `${id}.preparing.png`);
  const plan = buildImageCropFilter(input);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input.path,
    "-frames:v",
    "1",
    plan.flag,
    plan.filter,
    "-c:v",
    "png",
    "-compression_level",
    "9",
    temporaryPath,
  ];

  try {
    await runFfmpeg(args);
    if (!matchesUploadSignature(temporaryPath)) {
      throw new ImageCropPreparationError("Erzeugter Bildzuschnitt ist kein gültiges PNG.", 500);
    }
    const outputMetadata = probeVideoMetadata(temporaryPath);
    if (outputMetadata?.width !== input.outputWidth || outputMetadata.height !== input.outputHeight) {
      throw new ImageCropPreparationError("Erzeugter Bildzuschnitt hat unerwartete Abmessungen.", 500);
    }
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, resultPath);
    const stats = statSync(resultPath);
    return {
      file: {
        filename,
        path: resultPath,
        originalname: outputName(input.path, input),
        size: stats.size,
      },
      source: { width: metadata.width, height: metadata.height },
      crop: {
        x: input.x,
        y: input.y,
        width: input.width,
        height: input.height,
      },
      target: { width: input.outputWidth, height: input.outputHeight },
      fit: plan.fit,
      coverage: plan.coverage,
      feather: plan.feather,
      scaleFilter: "lanczos",
      command: ["ffmpeg", ...args].map(shellQuote).join(" "),
    };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    rmSync(resultPath, { force: true });
    if (error instanceof ImageCropPreparationError) throw error;
    throw new ImageCropPreparationError(
      `Bildzuschnitt fehlgeschlagen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`,
      500,
    );
  }
}
