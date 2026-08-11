import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import {
  appRoot,
  analysisPythonExecutable as defaultPythonExecutable,
  isolatedPythonEnvironment,
  whisperModelPath as defaultWhisperModelPath,
} from "./config.js";

export const WHISPER_SMALL_SHA256 = "9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794";

export type DialogueEvaluatorState = {
  status: "ready" | "not-available";
  blockerCode: "none" | "model-missing" | "model-invalid" | "runtime-unavailable";
  fingerprint: string;
  modelPath: string;
  modelSha256: string | null;
  packageVersion: string | null;
  runnerSha256: string | null;
  runtimeFingerprint: string | null;
  error: string | null;
};

type CachedFileHash = {
  revision: string;
  sha256: string;
};

const fileHashCache = new Map<string, CachedFileHash>();
type RuntimeState = {
  packageVersion: string;
  fingerprint: string;
};

function stableFileSha256(path: string): string {
  const linkStats = lstatSync(path);
  if (linkStats.isSymbolicLink() || !linkStats.isFile() || linkStats.size <= 0) {
    throw new Error("Checkpoint muss eine nichtleere reguläre Datei ohne Symlink sein.");
  }
  const revision = [
    linkStats.dev,
    linkStats.ino,
    linkStats.size,
    linkStats.mtimeMs,
    linkStats.ctimeMs,
  ].join(":");
  const cached = fileHashCache.get(path);
  if (cached?.revision === revision) return cached.sha256;

  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const digest = createHash("sha256");
  try {
    const before = fstatSync(descriptor);
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead > 0) digest.update(chunk.subarray(0, bytesRead));
    } while (bytesRead > 0);
    const after = fstatSync(descriptor);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error("Checkpoint wurde während der Prüfsummenbildung verändert.");
    }
  } finally {
    closeSync(descriptor);
  }
  const sha256 = digest.digest("hex");
  fileHashCache.set(path, { revision, sha256 });
  return sha256;
}

function evaluatorRunnerSha256(): string {
  const digest = createHash("sha256");
  for (const path of [
    join(appRoot, "scripts", "analyze-face-quality.py"),
    join(appRoot, "scripts", "av_sync_proxy.py"),
    join(appRoot, "scripts", "dialogue_word_evaluator.py"),
  ]) {
    digest.update(path);
    digest.update(stableFileSha256(path));
  }
  digest.update("whisper-small-guided-word-motion.v1|basic-normalizer|usable-p=0.15|low-p=0.25|cpu-threads=2");
  return digest.digest("hex");
}

function whisperRuntimeState(pythonExecutable: string): RuntimeState | null {
  const result = spawnSync(pythonExecutable, [
    "-I",
    "-c",
    [
      "import importlib.metadata, json, platform",
      "import cv2, numpy, torch, whisper",
      "packages = {}",
      "for name in ('openai-whisper', 'torch', 'numpy', 'opencv-python'):",
      "    try: packages[name] = importlib.metadata.version(name)",
      "    except importlib.metadata.PackageNotFoundError: packages[name] = None",
      "print(json.dumps({'python': platform.python_version(), 'packages': packages}, sort_keys=True))",
    ].join("\n"),
  ], {
    encoding: "utf8",
    env: isolatedPythonEnvironment({
      CUDA_VISIBLE_DEVICES: "",
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
    }),
    shell: false,
    timeout: 10_000,
  });
  const ffmpeg = spawnSync("ffmpeg", ["-version"], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
  });
  let state: RuntimeState | null = null;
  try {
    const parsed = JSON.parse(result.stdout) as {
      python?: string;
      packages?: Record<string, string | null>;
    };
    const packageVersion = parsed.packages?.["openai-whisper"];
    const torchVersion = parsed.packages?.torch;
    const numpyVersion = parsed.packages?.numpy;
    if (result.status === 0
      && packageVersion
      && torchVersion
      && numpyVersion
      && parsed.python
      && ffmpeg.status === 0) {
      const runtime = {
        python: parsed.python,
        packages: parsed.packages,
        ffmpeg: ffmpeg.stdout.split(/\r?\n/, 1)[0]?.trim(),
      };
      state = {
        packageVersion,
        fingerprint: createHash("sha256").update(JSON.stringify(runtime)).digest("hex"),
      };
    }
  } catch {
    state = null;
  }
  return state;
}

export function resolveDialogueEvaluatorState(
  modelPath = defaultWhisperModelPath,
  pythonExecutable = defaultPythonExecutable,
): DialogueEvaluatorState {
  let runnerSha256: string | null = null;
  try {
    runnerSha256 = evaluatorRunnerSha256();
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    return unavailableState(
      modelPath,
      runnerSha256,
      "runtime-unavailable",
      message,
    );
  }
  let modelSha256: string;
  try {
    modelSha256 = stableFileSha256(modelPath);
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const code = typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
    return unavailableState(
      modelPath,
      runnerSha256,
      code === "ENOENT" ? "model-missing" : "model-invalid",
      message,
    );
  }
  if (modelSha256 !== WHISPER_SMALL_SHA256) {
    return unavailableState(
      modelPath,
      runnerSha256,
      "model-invalid",
      "Whisper-small-Prüfsumme stimmt nicht mit dem offiziellen Checkpoint überein.",
    );
  }
  const runtime = whisperRuntimeState(pythonExecutable);
  if (!runtime) {
    return unavailableState(
      modelPath,
      runnerSha256,
      "runtime-unavailable",
      "Whisper-, Torch-, NumPy- oder FFmpeg-Laufzeit ist nicht vollständig verfügbar.",
    );
  }
  return {
    status: "ready",
    blockerCode: "none",
    fingerprint: `whisper-small-guided-word-motion.v1:${modelSha256}:${runnerSha256}:${runtime.fingerprint}`,
    modelPath,
    modelSha256,
    packageVersion: runtime.packageVersion,
    runnerSha256,
    runtimeFingerprint: runtime.fingerprint,
    error: null,
  };
}

function unavailableState(
  modelPath: string,
  runnerSha256: string | null,
  blockerCode: Exclude<DialogueEvaluatorState["blockerCode"], "none">,
  error: string,
): DialogueEvaluatorState {
  const message = error.slice(0, 500);
  const unavailableFingerprint = createHash("sha256").update(JSON.stringify({
    method: "whisper-small-guided-word-motion.v1",
    blockerCode,
    runnerSha256,
    error: message,
  })).digest("hex");
  return {
    status: "not-available",
    blockerCode,
    fingerprint: `whisper-not-available:${unavailableFingerprint}`,
    modelPath,
    modelSha256: null,
    packageVersion: null,
    runnerSha256,
    runtimeFingerprint: null,
    error: message,
  };
}
