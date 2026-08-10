import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { MIN_SCENE_REFERENCE_FACE_SHARPNESS } from "../shared/sceneReferenceQuality.js";
import { appRoot, pythonExecutable } from "./config.js";

export const SCENE_REFERENCE_YUNET_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4";

const candidateSchema = z.object({
  frameIndex: z.number().int().min(0),
  atSeconds: z.number().finite().min(0),
  score: z.number().finite().min(0).max(1),
  faceConfidence: z.number().finite().min(0).max(1),
  faceAreaRatio: z.number().finite().min(0).max(1),
  faceSharpness: z.number().finite().min(0),
  brightness: z.number().finite().min(0).max(255),
  exposure: z.number().finite().min(0).max(1),
  stability: z.number().finite().min(0).max(1),
  frontalness: z.number().finite().min(0).max(1),
  prominentFaceCount: z.number().int().min(1),
}).strict();

export const sceneReferenceFrameRecommendationSchema = z.object({
  schemaVersion: z.literal("ltx-studio-scene-reference-frame.v1"),
  atSeconds: z.number().finite().min(0),
  score: z.number().finite().min(0).max(1),
  sampledFrames: z.number().int().min(1).max(120),
  eligibleFrames: z.number().int().min(1).max(120),
  metrics: candidateSchema,
  candidates: z.array(candidateSchema).min(1).max(5),
}).strict();

export type SceneReferenceFrameRecommendation = z.infer<typeof sceneReferenceFrameRecommendationSchema>;

export class SceneReferenceFrameError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "SceneReferenceFrameError";
  }
}

type RecommendationOptions = {
  python?: string;
  script?: string;
  faceModel?: string;
  maxSamples?: number;
  minFaceSharpness?: number;
  timeoutMs?: number;
};

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function recommendSceneReferenceFrame(
  videoPath: string,
  options: RecommendationOptions = {},
): Promise<SceneReferenceFrameRecommendation & { command: string; faceModelPath: string }> {
  const executable = options.python ?? pythonExecutable;
  const script = options.script ?? join(appRoot, "scripts", "select_scene_reference_frame.py");
  const faceModel = options.faceModel ?? join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
  const maxSamples = options.maxSamples ?? 48;
  const minFaceSharpness = options.minFaceSharpness ?? MIN_SCENE_REFERENCE_FACE_SHARPNESS;
  const timeoutMs = options.timeoutMs ?? 60_000;
  for (const [path, label] of [[videoPath, "Video"], [script, "Auswahlskript"], [faceModel, "YuNet-Modell"]]) {
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new SceneReferenceFrameError(`${label} fehlt: ${path}`, 500);
    }
  }
  const args = [
    script,
    "--video", videoPath,
    "--face-model", faceModel,
    "--max-samples", String(maxSamples),
    "--min-face-sharpness", String(minFaceSharpness),
  ];
  const command = [executable, ...args].map(shellQuote).join(" ");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: appRoot,
      shell: false,
      env: {
        ...process.env,
        CUDA_VISIBLE_DEVICES: "",
        OMP_NUM_THREADS: "2",
        OPENBLAS_NUM_THREADS: "2",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`;
      if (stdout.length > 128 * 1024) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(new SceneReferenceFrameError(`Frame-Auswahl konnte nicht gestartet werden: ${error.message}`, 500));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        rejectPromise(new SceneReferenceFrameError("Automatische Frame-Auswahl hat das Zeitlimit überschritten.", 500));
        return;
      }
      if (code !== 0) {
        rejectPromise(new SceneReferenceFrameError(
          `Automatische Frame-Auswahl fehlgeschlagen: ${stderr.trim() || `Exit-Code ${code}`}`,
        ));
        return;
      }
      try {
        const parsed = sceneReferenceFrameRecommendationSchema.parse(JSON.parse(stdout));
        resolvePromise({ ...parsed, command, faceModelPath: faceModel });
      } catch (error) {
        rejectPromise(new SceneReferenceFrameError(
          `Automatische Frame-Auswahl lieferte kein gültiges Ergebnis: ${error instanceof Error ? error.message : "unbekannt"}`,
          500,
        ));
      }
    });
  });
}
