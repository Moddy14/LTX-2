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
export const experimentRoot = join(dataRoot, "experiments");
export const projectRoot = join(dataRoot, "projects");
const configuredProjectActorId = process.env.LTX_STUDIO_PROJECT_ACTOR_ID
  ?? `local-uid-${process.geteuid?.() ?? "unknown"}`;
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(configuredProjectActorId)) {
  throw new Error("LTX_STUDIO_PROJECT_ACTOR_ID must be a 3 to 128 character identifier");
}
export const projectActorId = configuredProjectActorId;
export const longcatProjectRoot = resolve(
  process.env.LTX_STUDIO_LONGCAT_ROOT ?? "/home/moddy/projects/longcat-video-avatar-dgx",
);
export const latentSyncImage =
  process.env.LTX_STUDIO_LATENTSYNC_IMAGE ?? "ltx-studio-latentsync:1.6-cu131";
export const latentSyncModelRoot = resolve(
  process.env.LTX_STUDIO_LATENTSYNC_MODEL_ROOT ?? "/home/moddy/models/latentsync/LatentSync-1.6",
);
export const latentSyncCheckpointPath = resolve(
  process.env.LTX_STUDIO_LATENTSYNC_CHECKPOINT
    ?? join(latentSyncModelRoot, "latentsync_unet.pt"),
);
export const latentSyncWhisperPath = resolve(
  process.env.LTX_STUDIO_LATENTSYNC_WHISPER
    ?? join(latentSyncModelRoot, "whisper", "tiny.pt"),
);
export const latentSyncVaeRoot = resolve(
  process.env.LTX_STUDIO_LATENTSYNC_VAE_ROOT
    ?? "/home/moddy/models/latentsync/sd-vae-ft-mse",
);
export const latentSyncInsightFaceRoot = resolve(
  process.env.LTX_STUDIO_LATENTSYNC_INSIGHTFACE_ROOT
    ?? "/home/moddy/models/latentsync/insightface",
);
export const museTalkImage =
  process.env.LTX_STUDIO_MUSETALK_IMAGE ?? "ltx-studio-musetalk:1.5-cu131";
export const museTalkModelRoot = resolve(
  process.env.LTX_STUDIO_MUSETALK_MODEL_ROOT
    ?? "/home/moddy/models/musetalk-1.5",
);
export const lipForcingImage =
  process.env.LTX_STUDIO_LIPFORCING_IMAGE ?? "ltx-studio-lipforcing:14b-cu131";
export const lipForcingModelRoot = resolve(
  process.env.LTX_STUDIO_LIPFORCING_MODEL_ROOT
    ?? "/home/moddy/models/lipforcing-14b",
);
export const statePath = join(dataRoot, "jobs.json");
export const assetsStatePath = join(dataRoot, "assets.json");
export const provenanceCachePath = join(dataRoot, "provenance-cache.json");
export const whisperModelPath = resolve(
  process.env.LTX_STUDIO_WHISPER_SMALL_MODEL ?? join(homedir(), ".cache", "whisper", "small.pt"),
);
export const serverHost = "127.0.0.1";
export const serverPort = Number.parseInt(process.env.LTX_STUDIO_PORT ?? "4318", 10);
export const devUiPort = Number.parseInt(process.env.LTX_STUDIO_UI_PORT ?? "4317", 10);
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
  for (const directory of [
    dataRoot,
    uploadRoot,
    outputRoot,
    hybridRoot,
    hybridCacheRoot,
    analysisTempRoot,
    experimentRoot,
    projectRoot,
  ]) {
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

export function selectRendererPythonExecutable(options: {
  sealed: boolean;
  explicit: string | undefined;
  sealedCandidate: string;
  developmentCandidates: readonly string[];
}): string {
  if (!options.sealed) {
    return selectPythonExecutable(options.explicit, options.developmentCandidates);
  }
  const sealedCandidate = resolve(options.sealedCandidate);
  if (options.explicit?.trim() && resolve(options.explicit.trim()) !== sealedCandidate) {
    throw new Error("LTX_STUDIO_RENDER_PYTHON must point inside the sealed release runtime");
  }
  if (!executableAvailable(sealedCandidate)) {
    throw new Error(`Sealed renderer runtime is missing or not executable: ${sealedCandidate}`);
  }
  return sealedCandidate;
}

export const pythonExecutable = selectPythonExecutable(process.env.LTX_STUDIO_PYTHON, [
  join(repoRoot, ".venv", "bin", "python"),
  join(homedir(), "comfyui-env", "bin", "python"),
  "python3",
]);
export const sealedRelease = process.env.LTX_STUDIO_SEALED_RELEASE === "1";
export const rendererPythonExecutable = selectRendererPythonExecutable({
  sealed: sealedRelease,
  explicit: process.env.LTX_STUDIO_RENDER_PYTHON,
  sealedCandidate: join(appRoot, "runtime", ".venv", "bin", "python"),
  developmentCandidates: [join(appRoot, "runtime", ".venv", "bin", "python"), pythonExecutable],
});
export const phonemeVisemePythonExecutable =
  process.env.LTX_STUDIO_PHONEME_VISEME_PYTHON?.trim() || pythonExecutable;

const pythonRuntimeCache = new Map<string, boolean>();

export function isolatedPythonEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
    PYTHONNOUSERSITE: "1",
  };
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  return environment;
}

export function pythonRuntimeAvailable(
  executable: string,
  { isolated = false }: { isolated?: boolean } = {},
): boolean {
  const cacheKey = `${isolated ? "isolated" : "development"}:${executable}`;
  const cached = pythonRuntimeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (!executableAvailable(executable)) {
    pythonRuntimeCache.set(cacheKey, false);
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
    ...(isolated ? ["-I"] : []),
    "-c",
    [
      "import accelerate, av, einops, safetensors, scipy, torch, torchaudio, transformers",
      "import ltx_core, ltx_pipelines",
    ].join("; "),
  ], {
    cwd: repoRoot,
    env: isolated
      ? isolatedPythonEnvironment()
      : { ...process.env, PYTHONPATH: pythonPath },
    shell: false,
    stdio: "ignore",
    timeout: 30_000,
  });
  const available = result.status === 0 && !result.error;
  pythonRuntimeCache.set(cacheKey, available);
  return available;
}
