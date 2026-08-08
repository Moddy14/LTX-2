import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { outputNameSchema } from "../shared/pipelines.js";
import { uploadRoot } from "./config.js";
import { probeVideoMetadata } from "./mediaProbe.js";
import { matchesUploadSignature } from "./uploads.js";
import type { AssetFile } from "./assets.js";

export class OutputFrameError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "OutputFrameError";
  }
}

export type OutputFrameInput = {
  /** Name der Ausgabe, aus der der Frame stammt. */
  output: string;
  /** Zeitpunkt in Sekunden. */
  atSeconds: number;
};

export type ExtractedOutputFrame = {
  file: AssetFile;
  outputName: string;
  atSeconds: number;
  width: number;
  height: number;
  sourceDurationSeconds: number | null;
  command: string;
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
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
      reject(new OutputFrameError(`FFmpeg konnte nicht gestartet werden: ${error.message}`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new OutputFrameError("Frame-Übernahme hat das Zeitlimit überschritten.", 500));
      } else if (code === 0) {
        resolvePromise();
      } else {
        reject(new OutputFrameError(
          `Frame-Übernahme fehlgeschlagen: ${stderr || `Exit-Code ${code}`}`,
          400,
        ));
      }
    });
  });
}

/**
 * Übernimmt einen Frame aus einer fertigen Ausgabe als Bild-Asset.
 *
 * Der Zweck ist die Bildkonditionierung: Ein von außen mitgebrachtes Porträt
 * stammt aus einer anderen Welt als der Film - anderes Licht, andere Farben,
 * anderer Hintergrund. Die Konditionierung setzt es als ersten Frame, danach
 * übernimmt der Prompt, und an dieser Naht bricht das Bild sichtbar um. Ein
 * Frame aus der Szene selbst hat diesen Bruch nicht, weil er bereits in der
 * Welt des Films liegt.
 */
export async function extractOutputFrame(
  input: OutputFrameInput,
  outputRoot: string,
  preparedUploadRoot = uploadRoot,
): Promise<ExtractedOutputFrame> {
  if (!outputNameSchema.safeParse(input.output).success) {
    throw new OutputFrameError(`Unzulässiger Ausgabename: ${input.output}`);
  }
  if (!Number.isFinite(input.atSeconds) || input.atSeconds < 0) {
    throw new OutputFrameError("Der Zeitpunkt muss null oder größer sein.");
  }
  const sourcePath = join(outputRoot, input.output);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new OutputFrameError(`Ausgabe ${input.output} ist nicht vorhanden.`, 404);
  }
  const metadata = probeVideoMetadata(sourcePath);
  if (!metadata?.width || !metadata.height) {
    throw new OutputFrameError(`Bildmaße von ${input.output} konnten nicht gelesen werden.`);
  }
  if (metadata.durationSeconds !== null
    && metadata.durationSeconds !== undefined
    && input.atSeconds >= metadata.durationSeconds) {
    throw new OutputFrameError(
      `Der Zeitpunkt ${input.atSeconds} s liegt hinter dem Ende von ${input.output} `
      + `(${metadata.durationSeconds.toFixed(2)} s).`,
    );
  }

  const imageDir = join(preparedUploadRoot, "image");
  mkdirSync(imageDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const filename = `${id}.png`;
  const resultPath = join(imageDir, filename);
  const temporaryPath = join(imageDir, `${id}.extracting.png`);
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    // Vor dem Eingang gesucht: schnell, und für einen Standbild-Griff genau genug.
    "-ss",
    input.atSeconds.toFixed(3),
    "-i",
    sourcePath,
    "-frames:v",
    "1",
    "-c:v",
    "png",
    "-compression_level",
    "9",
    temporaryPath,
  ];

  try {
    await runFfmpeg(args);
    if (!existsSync(temporaryPath) || !matchesUploadSignature(temporaryPath)) {
      throw new OutputFrameError("Der übernommene Frame ist kein gültiges PNG.", 500);
    }
    const frameMetadata = probeVideoMetadata(temporaryPath);
    if (frameMetadata?.width !== metadata.width || frameMetadata.height !== metadata.height) {
      throw new OutputFrameError("Der übernommene Frame hat unerwartete Abmessungen.", 500);
    }
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, resultPath);
    const stats = statSync(resultPath);
    const stem = input.output.replace(/\.[^.]+$/, "");
    return {
      file: {
        filename,
        path: resultPath,
        originalname: `${stem}-frame-${input.atSeconds.toFixed(2)}s.png`,
        size: stats.size,
      },
      outputName: input.output,
      atSeconds: input.atSeconds,
      width: metadata.width,
      height: metadata.height,
      sourceDurationSeconds: metadata.durationSeconds ?? null,
      command: ["ffmpeg", ...args].map(shellQuote).join(" "),
    };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    rmSync(resultPath, { force: true });
    if (error instanceof OutputFrameError) throw error;
    throw new OutputFrameError(
      `Frame-Übernahme fehlgeschlagen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`,
      500,
    );
  }
}
