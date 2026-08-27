import { spawnSync } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = dirname(fileURLToPath(import.meta.url));

export const SEALED_EXECUTABLE_PATH = "/usr/sbin:/usr/bin:/sbin:/bin";
export const hostTcbExecutables = Object.freeze({
  docker: "/usr/bin/docker",
  env: "/usr/bin/env",
  ffmpeg: "/usr/bin/ffmpeg",
  ffprobe: "/usr/bin/ffprobe",
  python3: "/usr/bin/python3.12",
  sudo: "/usr/bin/sudo",
  systemdRun: "/usr/bin/systemd-run",
});

export function parseSealedReleaseMode(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  throw new Error("LTX_STUDIO_SEALED_RELEASE must be exactly 1 when set; omit it for development");
}

export const sealedRelease = parseSealedReleaseMode(process.env.LTX_STUDIO_SEALED_RELEASE);

export function parseT2aDevelopmentMeasurementMode(
  value: string | undefined,
  sealed: boolean,
): boolean {
  if (value === undefined || value === "") return false;
  if (value !== "1") {
    throw new Error(
      "LTX_STUDIO_T2A_DEVELOPMENT_MEASUREMENT must be exactly 1 when set; omit it to disable development measurement",
    );
  }
  if (sealed) {
    throw new Error(
      "LTX_STUDIO_T2A_DEVELOPMENT_MEASUREMENT cannot be enabled in sealed release mode",
    );
  }
  return true;
}

export const t2aDevelopmentMeasurementEnabled = parseT2aDevelopmentMeasurementMode(
  process.env.LTX_STUDIO_T2A_DEVELOPMENT_MEASUREMENT,
  sealedRelease,
);

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

export function validateThermalHysteresis(pauseAtC: number, resumeAtOrBelowC: number): void {
  if (!Number.isFinite(pauseAtC) || !Number.isFinite(resumeAtOrBelowC)) {
    throw new Error("Thermal pause and resume thresholds must be finite numbers");
  }
  if (resumeAtOrBelowC > pauseAtC - 1) {
    throw new Error(
      "LTX_STUDIO_THERMAL_RESUME_C must be at least 1 C below LTX_STUDIO_THERMAL_PAUSE_C",
    );
  }
}

export const repoRoot = resolve(serverDir, "../../..");
export const appRoot = resolve(serverDir, "..");

type SealedDockerImageName = "latentsync" | "musetalk" | "lipforcing";

function sealedDockerImages(): Record<SealedDockerImageName, string> | null {
  if (!sealedRelease) return null;
  for (const name of [
    "LTX_STUDIO_LATENTSYNC_IMAGE",
    "LTX_STUDIO_MUSETALK_IMAGE",
    "LTX_STUDIO_LIPFORCING_IMAGE",
  ]) {
    if (process.env[name] !== undefined) {
      throw new Error(`${name} cannot override the digest-bound sealed Docker image`);
    }
  }
  const manifest = JSON.parse(readFileSync(join(repoRoot, "release-manifest.json"), "utf8")) as {
    hostTcb?: { dockerImages?: Array<{ name?: unknown; reference?: unknown }> };
  };
  const images = manifest.hostTcb?.dockerImages;
  if (!Array.isArray(images)) throw new Error("Sealed release manifest has no Host-TCB Docker images");
  const result = {} as Record<SealedDockerImageName, string>;
  for (const name of ["latentsync", "musetalk", "lipforcing"] as const) {
    const matches = images.filter((image) => image.name === name);
    const reference = matches[0]?.reference;
    if (matches.length !== 1 || typeof reference !== "string"
      || !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(reference)) {
      throw new Error(`Sealed Docker image ${name} is not uniquely bound by immutable RepoDigest`);
    }
    result[name] = reference;
  }
  if (images.length !== 3) throw new Error("Sealed release manifest has unexpected Docker images");
  return result;
}

const boundSealedDockerImages = sealedDockerImages();
const vitestWorkerId = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID;

export function isolatedVitestDataRootPrefix(
  workerId: string | undefined,
  pid = process.pid,
  temporaryRoot = tmpdir(),
): string {
  const identifier = workerId ?? "main";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(identifier)
    || !Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(
      "VITEST_WORKER_ID/VITEST_POOL_ID must be a 1 to 64 character alphanumeric test-worker identifier",
    );
  }
  const root = resolve(temporaryRoot);
  const rootDetails = lstatSync(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error("Vitest temporary root must be a canonical real directory");
  }
  const prefix = resolve(root, `ltx-studio-vitest-${pid}-${identifier}-`);
  if (dirname(prefix) !== root || !prefix.startsWith(`${root}${sep}`)) {
    throw new Error("Vitest data-root prefix must resolve to one direct child of the temporary directory");
  }
  return prefix;
}

type VitestDataRootIdentity = Readonly<{
  device: bigint;
  inode: bigint;
  uid: bigint;
  gid: bigint;
  mode: bigint;
}>;

export type VitestDataRootClaim = {
  readonly path: string;
  readonly parent: string;
  readonly descriptor: number;
  readonly identity: VitestDataRootIdentity;
  closed: boolean;
};

function processIdentity(): { uid: bigint; gid: bigint } {
  if (typeof process.geteuid !== "function" || typeof process.getegid !== "function") {
    throw new Error("Vitest data-root isolation requires POSIX effective user and group identities");
  }
  return { uid: BigInt(process.geteuid()), gid: BigInt(process.getegid()) };
}

function statIdentity(details: ReturnType<typeof fstatSync>): VitestDataRootIdentity {
  return {
    device: BigInt(details.dev),
    inode: BigInt(details.ino),
    uid: BigInt(details.uid),
    gid: BigInt(details.gid),
    mode: BigInt(details.mode) & 0o7777n,
  };
}

function sameIdentity(left: VitestDataRootIdentity, right: VitestDataRootIdentity): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.mode === right.mode;
}

function readClaimedVitestDataRootIdentity(path: string, descriptor: number): VitestDataRootIdentity {
  const pathDetails = lstatSync(path, { bigint: true });
  if (!pathDetails.isDirectory() || pathDetails.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error(`Vitest data root is no longer a canonical real directory: ${path}`);
  }
  const descriptorDetails = fstatSync(descriptor, { bigint: true });
  if (!descriptorDetails.isDirectory()) {
    throw new Error(`Held Vitest data-root descriptor is not a directory: ${path}`);
  }
  const pathIdentity = statIdentity(pathDetails);
  const descriptorIdentity = statIdentity(descriptorDetails);
  if (!sameIdentity(pathIdentity, descriptorIdentity)) {
    throw new Error(`Vitest data-root path no longer names the atomically claimed directory: ${path}`);
  }
  const owner = processIdentity();
  if (pathIdentity.uid !== owner.uid || pathIdentity.gid !== owner.gid || pathIdentity.mode !== 0o700n) {
    throw new Error(`Vitest data root must remain owned by the effective process identity with mode 0700: ${path}`);
  }
  return pathIdentity;
}

export function claimIsolatedVitestDataRoot(
  workerId: string | undefined,
  pid = process.pid,
  temporaryRoot = tmpdir(),
): VitestDataRootClaim {
  const prefix = isolatedVitestDataRootPrefix(workerId, pid, temporaryRoot);
  const parent = dirname(prefix);
  const path = mkdtempSync(prefix);
  if (dirname(path) !== parent || !path.startsWith(prefix) || realpathSync(parent) !== parent) {
    throw new Error("Atomically allocated Vitest data root escaped its canonical temporary parent");
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    const identity = readClaimedVitestDataRootIdentity(path, descriptor);
    return {
      path,
      parent,
      descriptor,
      identity,
      closed: false,
    };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      const details = lstatSync(path, { bigint: true });
      const owner = processIdentity();
      if (details.isDirectory() && !details.isSymbolicLink()
        && details.uid === owner.uid && details.gid === owner.gid
        && realpathSync(path) === path) {
        rmSync(path, { recursive: true, force: false });
      }
    } catch {
      // Fail closed: never clean a path whose post-failure identity is uncertain.
    }
    throw error;
  }
}

export function assertClaimedVitestDataRoot(claim: VitestDataRootClaim): void {
  if (claim.closed) throw new Error(`Vitest data-root claim is already closed: ${claim.path}`);
  const current = readClaimedVitestDataRootIdentity(claim.path, claim.descriptor);
  if (!sameIdentity(current, claim.identity)) {
    throw new Error(`Vitest data-root identity changed after its atomic allocation: ${claim.path}`);
  }
}

export function closeVitestDataRootClaim(claim: VitestDataRootClaim): void {
  if (claim.closed) return;
  closeSync(claim.descriptor);
  claim.closed = true;
}

export function resolveConfiguredDataRoot(options: {
  vitestMode: boolean;
  configuredDataRoot?: string;
  repositoryDefault: string;
  claimedVitestDataRoot?: string;
}): string {
  if (!options.vitestMode) {
    return resolve(options.configuredDataRoot ?? options.repositoryDefault);
  }
  if (options.configuredDataRoot !== undefined) {
    throw new Error("LTX_STUDIO_DATA_DIR is forbidden in Vitest mode; the data root is atomically allocated");
  }
  if (options.claimedVitestDataRoot === undefined) {
    throw new Error("Vitest data root must be atomically allocated before configuration is exported");
  }
  return options.claimedVitestDataRoot;
}

const vitestMode = process.env.VITEST === "true" || vitestWorkerId !== undefined;
if (vitestMode && process.env.LTX_STUDIO_DATA_DIR !== undefined) {
  throw new Error("LTX_STUDIO_DATA_DIR is forbidden in Vitest mode; the data root is atomically allocated");
}
const vitestDataRootClaim = vitestMode
  // JobManager startup intentionally reconciles every publication marker in
  // its output root. Parallel test workers must therefore never share that
  // authority namespace or one worker can correctly quarantine another
  // worker's in-flight fixture as an orphan.
  ? claimIsolatedVitestDataRoot(vitestWorkerId)
  : null;
export const dataRoot = resolveConfiguredDataRoot({
  vitestMode,
  configuredDataRoot: process.env.LTX_STUDIO_DATA_DIR,
  repositoryDefault: join(repoRoot, ".ltx-studio"),
  claimedVitestDataRoot: vitestDataRootClaim?.path,
});

export function assertSafeVitestCleanupRoot(candidate: string): { path: string; exists: true } {
  if (vitestDataRootClaim === null || resolve(candidate) !== vitestDataRootClaim.path) {
    throw new Error(`Refusing to clean a data root not owned by this Vitest process: ${candidate}`);
  }
  assertClaimedVitestDataRoot(vitestDataRootClaim);
  return { path: vitestDataRootClaim.path, exists: true };
}

export function closeActiveVitestDataRootClaim(): void {
  if (vitestDataRootClaim !== null) closeVitestDataRootClaim(vitestDataRootClaim);
}
export const uploadRoot = join(dataRoot, "uploads");
export const outputRoot = join(dataRoot, "outputs");
export const hybridRoot = join(dataRoot, "hybrid");
export const hybridCacheRoot = join(dataRoot, "hybrid-cache");
export const analysisTempRoot = join(dataRoot, "analysis-tmp");
export const experimentRoot = join(dataRoot, "experiments");
export const blindEvaluationRoot = join(dataRoot, "blind-evaluations");
export const projectRoot = join(dataRoot, "projects");
export const activationControlRoot = resolve(
  process.env.LTX_STUDIO_ACTIVATION_CONTROL_ROOT ?? join(dataRoot, "activation-control"),
);
export const activationJournalPath = join(activationControlRoot, "activation-journal.json");
export const activationAnchorPath = join(activationControlRoot, "activation-head.json");
export const activationTrustPolicyPath = join(activationControlRoot, "activation-writer-trust.json");
export const runtimeRightsSnapshotPath = join(activationControlRoot, "runtime-rights-snapshot.json");
export const runtimeRightsTrustPolicyPath = join(activationControlRoot, "release-trusted-keys.json");
export const activationTrustPolicyDigest = process.env.LTX_STUDIO_ACTIVATION_TRUST_POLICY_SHA256?.trim() ?? "";
export const runtimeRightsTrustPolicyDigest = process.env.LTX_STUDIO_RIGHTS_TRUST_POLICY_SHA256?.trim() ?? "";
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
  boundSealedDockerImages?.latentsync
  ?? process.env.LTX_STUDIO_LATENTSYNC_IMAGE
  ?? "ltx-studio-latentsync:1.6-cu131";
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
  boundSealedDockerImages?.musetalk
  ?? process.env.LTX_STUDIO_MUSETALK_IMAGE
  ?? "ltx-studio-musetalk:1.5-cu131";
export const museTalkModelRoot = resolve(
  process.env.LTX_STUDIO_MUSETALK_MODEL_ROOT
    ?? "/home/moddy/models/musetalk-1.5",
);
export const lipForcingImage =
  boundSealedDockerImages?.lipforcing
  ?? process.env.LTX_STUDIO_LIPFORCING_IMAGE
  ?? "ltx-studio-lipforcing:14b-cu131";
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
export const thermalResumeC = numericSetting("LTX_STUDIO_THERMAL_RESUME_C", "66", {
  minimum: 1,
  maximum: 150,
});
validateThermalHysteresis(thermalPauseC, thermalResumeC);
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

export const modelRoots = (
  process.env.LTX_STUDIO_MODEL_ROOTS ?? "/home/moddy/LTX-2.3-max:/home/moddy/LTX-2.5"
)
  .split(delimiter)
  .map((root) => root.trim())
  .filter(Boolean)
  .map((root) => resolve(root));

export function ensureRuntimeDirectories(): void {
  for (const directory of [
    uploadRoot,
    outputRoot,
    hybridRoot,
    hybridCacheRoot,
    analysisTempRoot,
    experimentRoot,
    blindEvaluationRoot,
    projectRoot,
  ]) {
    if (vitestDataRootClaim !== null) {
      assertClaimedVitestDataRoot(vitestDataRootClaim);
      mkdirSync(directory, { recursive: false, mode: 0o700 });
      assertClaimedVitestDataRoot(vitestDataRootClaim);
    } else {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
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
  settingName?: string;
}): string {
  if (!options.sealed) {
    return selectPythonExecutable(options.explicit, options.developmentCandidates);
  }
  const sealedCandidate = resolve(options.sealedCandidate);
  if (options.explicit?.trim() && resolve(options.explicit.trim()) !== sealedCandidate) {
    throw new Error(`${options.settingName ?? "LTX_STUDIO_RENDER_PYTHON"} must point inside the sealed release runtime`);
  }
  if (!executableAvailable(sealedCandidate)) {
    throw new Error(`Sealed renderer runtime is missing or not executable: ${sealedCandidate}`);
  }
  return sealedCandidate;
}

const nativeRuntimePython = join(appRoot, "runtime", ".venv", "bin", "python");
export const pythonExecutable = selectRendererPythonExecutable({
  sealed: sealedRelease,
  explicit: process.env.LTX_STUDIO_PYTHON,
  sealedCandidate: nativeRuntimePython,
  settingName: "LTX_STUDIO_PYTHON",
  developmentCandidates: [
    join(repoRoot, ".venv", "bin", "python"),
    join(homedir(), "comfyui-env", "bin", "python"),
    "python3",
  ],
});
export const rendererPythonExecutable = selectRendererPythonExecutable({
  sealed: sealedRelease,
  explicit: process.env.LTX_STUDIO_RENDER_PYTHON,
  sealedCandidate: nativeRuntimePython,
  developmentCandidates: [nativeRuntimePython, pythonExecutable],
});
export const analysisPythonExecutable = selectRendererPythonExecutable({
  sealed: sealedRelease,
  explicit: process.env.LTX_STUDIO_ANALYSIS_PYTHON,
  sealedCandidate: nativeRuntimePython,
  settingName: "LTX_STUDIO_ANALYSIS_PYTHON",
  developmentCandidates: [
    nativeRuntimePython,
    join(homedir(), "comfyui-env", "bin", "python"),
    join(repoRoot, ".venv", "bin", "python"),
    "python3",
  ],
});
export const admissionPythonExecutable = selectRendererPythonExecutable({
  sealed: sealedRelease,
  explicit: process.env.LTX_STUDIO_ADMISSION_PYTHON,
  sealedCandidate: nativeRuntimePython,
  settingName: "LTX_STUDIO_ADMISSION_PYTHON",
  developmentCandidates: ["python3", pythonExecutable],
});
export const phonemeVisemePythonExecutable = selectRendererPythonExecutable({
  sealed: sealedRelease,
  explicit: process.env.LTX_STUDIO_PHONEME_VISEME_PYTHON,
  sealedCandidate: nativeRuntimePython,
  settingName: "LTX_STUDIO_PHONEME_VISEME_PYTHON",
  developmentCandidates: [analysisPythonExecutable],
});

const sealedInjectionVariables = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_DEBUG",
  "LD_DEBUG_OUTPUT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONINSPECT",
  "PYTHONBREAKPOINT",
  "PYTHONUSERBASE",
] as const;

const sealedCoreControlValues = {
  LTX_STUDIO_DATA_DIR: "/var/lib/ltx-studio",
  HF_HUB_OFFLINE: "1",
  PYTHONNOUSERSITE: "1",
  TRANSFORMERS_OFFLINE: "1",
} as const;

export function validateSealedProcessEnvironment(
  sealed: boolean,
  environment: NodeJS.ProcessEnv,
): void {
  if (!sealed) return;
  if (environment.LTX_STUDIO_SEALED_RELEASE !== "1") {
    throw new Error("Sealed release mode was not explicitly and exactly enabled");
  }
  const present = sealedInjectionVariables.filter((name) => Boolean(environment[name]?.trim()));
  if (present.length > 0) {
    throw new Error(`Sealed release refuses executable injection variables: ${present.join(", ")}`);
  }
  if (environment.PATH !== SEALED_EXECUTABLE_PATH) {
    throw new Error(`Sealed release requires the fixed executable PATH ${SEALED_EXECUTABLE_PATH}`);
  }
  if (!/^[0-9a-f]{64}$/.test(environment.LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256 ?? "")) {
    throw new Error("Sealed release requires a separately pinned Host-TCB attestation SHA-256");
  }
  for (const [name, expected] of Object.entries(sealedCoreControlValues)) {
    if (environment[name] !== expected) {
      throw new Error(`Sealed release requires ${name}=${expected}`);
    }
  }
}

validateSealedProcessEnvironment(sealedRelease, process.env);

const pythonRuntimeCache = new Map<string, boolean>();

export function isolatedPythonEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
    HF_HUB_OFFLINE: "1",
    PYTHONNOUSERSITE: "1",
    TRANSFORMERS_OFFLINE: "1",
  };
  delete environment.PYTHONHOME;
  delete environment.PYTHONPATH;
  delete environment.PYTHONSTARTUP;
  delete environment.PYTHONINSPECT;
  delete environment.PYTHONBREAKPOINT;
  delete environment.PYTHONUSERBASE;
  if (sealedRelease) environment.PATH = SEALED_EXECUTABLE_PATH;
  return environment;
}

export function pythonRuntimeAvailable(
  executable: string,
  { isolated = false }: { isolated?: boolean } = {},
): boolean {
  const cacheKey = `${isolated ? "isolated" : "development"}:${executable}`;
  const cached = sealedRelease ? undefined : pythonRuntimeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (!executableAvailable(executable)) {
    if (!sealedRelease) pythonRuntimeCache.set(cacheKey, false);
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
  if (!sealedRelease) pythonRuntimeCache.set(cacheKey, available);
  return available;
}

export function analysisRuntimeAvailable(
  executable: string,
  { isolated = false }: { isolated?: boolean } = {},
): boolean {
  const cacheKey = `${isolated ? "isolated" : "development"}:analysis:${executable}`;
  const cached = sealedRelease ? undefined : pythonRuntimeCache.get(cacheKey);
  if (cached !== undefined) return cached;
  if (!executableAvailable(executable)) {
    if (!sealedRelease) pythonRuntimeCache.set(cacheKey, false);
    return false;
  }
  const result = spawnSync(executable, [
    ...(isolated ? ["-I"] : []),
    "-c",
    "import cv2, numpy, torch, whisper",
  ], {
    cwd: repoRoot,
    env: isolated ? isolatedPythonEnvironment() : process.env,
    shell: false,
    stdio: "ignore",
    timeout: 30_000,
  });
  const available = result.status === 0 && !result.error;
  if (!sealedRelease) pythonRuntimeCache.set(cacheKey, available);
  return available;
}
