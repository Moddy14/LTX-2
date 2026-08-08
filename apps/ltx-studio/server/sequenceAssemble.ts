import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { outputNameSchema } from "../shared/pipelines.js";
import { uploadRoot } from "./config.js";
import { probeVideoMetadata, type VideoMetadata } from "./mediaProbe.js";
import type { AssetFile } from "./assets.js";

export class SequenceAssembleError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "SequenceAssembleError";
  }
}

export type SequenceAssembleInput = {
  /** Ausgabenamen in Schnittreihenfolge. */
  outputs: readonly string[];
  /** Anzeigename der Montage; ohne Angabe wird einer gebildet. */
  name?: string;
};

export type SequenceShot = {
  outputName: string;
  path: string;
  width: number;
  height: number;
  frames: number | null;
  durationSeconds: number | null;
};

export type PreparedSequence = {
  file: AssetFile;
  shots: SequenceShot[];
  target: {
    width: number;
    height: number;
    durationSeconds: number | null;
  };
  command: string;
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(new SequenceAssembleError(`FFmpeg konnte nicht gestartet werden: ${error.message}`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new SequenceAssembleError("Zusammenschnitt hat das Zeitlimit überschritten.", 500));
      } else if (code === 0) {
        resolvePromise();
      } else {
        reject(new SequenceAssembleError(
          `Zusammenschnitt fehlgeschlagen: ${stderr || `Exit-Code ${code}`}`,
          400,
        ));
      }
    });
  });
}

/**
 * Prüft die Shots und liefert sie in Schnittreihenfolge zurück.
 *
 * Der concat-Filter setzt gleiche Bildmaße und in jedem Shot eine Tonspur
 * voraus. Beides wird hier vorab geprüft und mit dem Namen des abweichenden
 * Shots gemeldet, statt FFmpeg mitten im Lauf scheitern zu lassen.
 */
export function collectSequenceShots(
  outputs: readonly string[],
  root: string,
  probe: (path: string) => VideoMetadata | null = probeVideoMetadata,
): SequenceShot[] {
  if (outputs.length < 2) {
    throw new SequenceAssembleError("Ein Zusammenschnitt braucht mindestens zwei Ausgaben.");
  }
  const shots: SequenceShot[] = [];
  for (const outputName of outputs) {
    if (!outputNameSchema.safeParse(outputName).success) {
      throw new SequenceAssembleError(`Unzulässiger Ausgabename: ${outputName}`);
    }
    const path = join(root, outputName);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size <= 0) {
      throw new SequenceAssembleError(`Ausgabe ${outputName} ist nicht vorhanden.`, 404);
    }
    const metadata = probe(path);
    if (!metadata?.width || !metadata.height) {
      throw new SequenceAssembleError(`Bildmaße von ${outputName} konnten nicht gelesen werden.`);
    }
    if (metadata.hasAudio !== true) {
      throw new SequenceAssembleError(
        `${outputName} hat keine Tonspur. Der Zusammenschnitt verlangt in jedem Shot Ton, `
        + "damit die Montage nicht stumme Lücken erzeugt.",
      );
    }
    const first = shots[0];
    if (first && (first.width !== metadata.width || first.height !== metadata.height)) {
      throw new SequenceAssembleError(
        `${outputName} ist ${metadata.width}×${metadata.height}, aber ${first.outputName} ist `
        + `${first.width}×${first.height}. Alle Shots einer Montage brauchen dieselben Bildmaße.`,
      );
    }
    shots.push({
      outputName,
      path,
      width: metadata.width,
      height: metadata.height,
      frames: metadata.frames ?? null,
      durationSeconds: metadata.durationSeconds ?? null,
    });
  }
  return shots;
}

/** Baut den concat-Filter für die geprüften Shots. */
export function buildConcatFilter(count: number): string {
  const streams = Array.from({ length: count }, (_, index) => `[${index}:v][${index}:a]`).join("");
  return `${streams}concat=n=${count}:v=1:a=1[v][a]`;
}

export async function assembleSequence(
  input: SequenceAssembleInput,
  outputRoot: string,
  preparedUploadRoot = uploadRoot,
): Promise<PreparedSequence> {
  const shots = collectSequenceShots(input.outputs, outputRoot);
  const videoDir = join(preparedUploadRoot, "video");
  mkdirSync(videoDir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const filename = `${id}.mp4`;
  const resultPath = join(videoDir, filename);
  const temporaryPath = join(videoDir, `${id}.assembling.mp4`);

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...shots.flatMap((shot) => ["-i", shot.path]),
    "-filter_complex",
    buildConcatFilter(shots.length),
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-crf",
    "18",
    "-preset",
    "medium",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    temporaryPath,
  ];

  try {
    // Grosszuegiges Limit: eine Minute Film kann mehrere Minuten Kodierzeit kosten.
    await runFfmpeg(args, 30 * 60_000);
    const metadata = probeVideoMetadata(temporaryPath);
    if (metadata?.width !== shots[0].width || metadata.height !== shots[0].height) {
      throw new SequenceAssembleError("Der Zusammenschnitt hat unerwartete Bildmaße.", 500);
    }
    if (metadata.hasAudio !== true) {
      throw new SequenceAssembleError("Der Zusammenschnitt hat keine Tonspur.", 500);
    }
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, resultPath);
    const stats = statSync(resultPath);
    const stem = (input.name || "sequenz").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "sequenz";
    return {
      file: {
        filename,
        path: resultPath,
        originalname: `${stem}.mp4`,
        size: stats.size,
      },
      shots,
      target: {
        width: shots[0].width,
        height: shots[0].height,
        durationSeconds: metadata.durationSeconds ?? null,
      },
      command: ["ffmpeg", ...args].map(shellQuote).join(" "),
    };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    rmSync(resultPath, { force: true });
    if (error instanceof SequenceAssembleError) throw error;
    throw new SequenceAssembleError(
      `Zusammenschnitt fehlgeschlagen: ${error instanceof Error ? error.message : "unbekannter Fehler"}`,
      500,
    );
  }
}
