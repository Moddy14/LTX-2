import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));

function numericSetting(
  name: string,
  fallback: string,
  { integer = false, minimum = 0, maximum = Number.POSITIVE_INFINITY } = {},
): number {
  const raw = process.env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} between ${minimum} and ${maximum}`);
  }
  return value;
}

export const repoRoot = resolve(serverDir, "../../..");
export const appRoot = resolve(serverDir, "..");
export const dataRoot = resolve(process.env.LTX_STUDIO_DATA_DIR ?? join(repoRoot, ".ltx-studio"));
export const uploadRoot = join(dataRoot, "uploads");
export const outputRoot = join(dataRoot, "outputs");
export const hybridRoot = join(dataRoot, "hybrid");
export const hybridCacheRoot = join(dataRoot, "hybrid-cache");
export const analysisTempRoot = join(dataRoot, "analysis-tmp");
export const longcatProjectRoot = resolve(
  process.env.LTX_STUDIO_LONGCAT_ROOT ?? "/home/moddy/projects/longcat-video-avatar-dgx",
);
export const statePath = join(dataRoot, "jobs.json");
export const assetsStatePath = join(dataRoot, "assets.json");
export const serverHost = "127.0.0.1";
export const serverPort = Number.parseInt(process.env.LTX_STUDIO_PORT ?? "4318", 10);
export const admissionPythonExecutable = process.env.LTX_STUDIO_ADMISSION_PYTHON ?? "python3";
export const admissionRequired = process.env.LTX_STUDIO_REQUIRE_ADMISSION !== "0";
export const minAvailableGiB = Number.parseFloat(process.env.LTX_STUDIO_MIN_AVAILABLE_GIB ?? "48");
export const minResidualMemoryGiB = Number.parseFloat(
  process.env.LTX_STUDIO_MIN_RESIDUAL_MEMORY_GIB ?? "24",
);
export const minSwapFreeGiB = Number.parseFloat(process.env.LTX_STUDIO_MIN_SWAP_FREE_GIB ?? "4");
export const longcatMinAvailableGiB = numericSetting("LTX_STUDIO_LONGCAT_MIN_AVAILABLE_GIB", "72.5", {
  minimum: 1,
  maximum: 122,
});
// Leave enough headroom for the supervisor's independent 66 C start gate.
export const longcatThermalStartMaxC = numericSetting("LTX_STUDIO_LONGCAT_THERMAL_START_MAX_C", "60", {
  minimum: 1,
  maximum: 150,
});
export const thermalStartSamples = numericSetting("LTX_STUDIO_THERMAL_START_SAMPLES", "5", {
  integer: true,
  minimum: 1,
  maximum: 101,
});
export const thermalStartSampleIntervalMs = numericSetting(
  "LTX_STUDIO_THERMAL_START_SAMPLE_INTERVAL_MS",
  "1000",
  { integer: true, maximum: 60_000 },
);
export const thermalPauseC = numericSetting("LTX_STUDIO_THERMAL_PAUSE_C", "90", {
  minimum: 1,
  maximum: 150,
});
export const thermalPausePolls = numericSetting("LTX_STUDIO_THERMAL_PAUSE_POLLS", "3", {
  integer: true,
  minimum: 1,
  maximum: 100,
});
export const thermalResumePolls = numericSetting("LTX_STUDIO_THERMAL_RESUME_POLLS", "5", {
  integer: true,
  minimum: 1,
  maximum: 100,
});
export const thermalUnreadablePolls = numericSetting("LTX_STUDIO_THERMAL_UNREADABLE_POLLS", "3", {
  integer: true,
  minimum: 1,
  maximum: 100,
});
export const thermalPollIntervalMs = numericSetting("LTX_STUDIO_THERMAL_POLL_INTERVAL_MS", "10000", {
  integer: true,
  minimum: 250,
  maximum: 300_000,
});

export const modelRoots = (process.env.LTX_STUDIO_MODEL_ROOTS ?? "/home/moddy/LTX-2.3-max")
  .split(delimiter)
  .map((root) => root.trim())
  .filter(Boolean)
  .map((root) => resolve(root));

export function ensureRuntimeDirectories(): void {
  for (const directory of [dataRoot, uploadRoot, outputRoot, hybridRoot, hybridCacheRoot, analysisTempRoot]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

export function executableAvailable(executable: string): boolean {
  const candidates = isAbsolute(executable)
    ? [executable]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      // Keep searching PATH.
    }
  }
  return false;
}

export function selectPythonExecutable(
  explicit: string | undefined,
  candidates: readonly string[],
): string {
  if (explicit?.trim()) return explicit.trim();
  return candidates.find(executableAvailable) ?? "python3";
}

export const pythonExecutable = selectPythonExecutable(process.env.LTX_STUDIO_PYTHON, [
  join(repoRoot, ".venv", "bin", "python"),
  join(homedir(), "comfyui-env", "bin", "python"),
  "python3",
]);

const pythonRuntimeCache = new Map<string, boolean>();

export function pythonRuntimeAvailable(executable: string): boolean {
  const cached = pythonRuntimeCache.get(executable);
  if (cached !== undefined) return cached;
  if (!executableAvailable(executable)) {
    pythonRuntimeCache.set(executable, false);
    return false;
  }

  const pythonPath = [
    join(repoRoot, "packages", "ltx-core", "src"),
    join(repoRoot, "packages", "ltx-pipelines", "src"),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(delimiter);
  const result = spawnSync(executable, [
    "-c",
    [
      "import accelerate, av, einops, safetensors, scipy, torch, torchaudio, transformers",
      "import ltx_core, ltx_pipelines",
    ].join("; "),
  ], {
    cwd: repoRoot,
    env: { ...process.env, PYTHONPATH: pythonPath },
    shell: false,
    stdio: "ignore",
    timeout: 30_000,
  });
  const available = result.status === 0 && !result.error;
  pythonRuntimeCache.set(executable, available);
  return available;
}
