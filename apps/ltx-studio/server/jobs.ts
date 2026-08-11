import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  experimentRunBindingSchema,
  isAdoptedLipForcingCandidate,
  type ExperimentRunBinding,
} from "../shared/experiments.js";
import { refinerAdmissionMemoryGiB } from "../shared/admissionPreflight.js";
import {
  isAudioConditionedMode,
  migrateGenerationRequest,
  type GenerationRequest,
} from "../shared/pipelines.js";
import {
  requiredOfficialSpeechAssetIds,
  withOfficialSpeechModelPaths,
  type ModelInventory,
} from "../shared/models.js";
import {
  decisionMessage,
  decideSegmentBoundary,
  cooperativeCheckpointPath,
  heartbeatQueueJob,
  listQueueJobs,
  queueAdmissionMemoryGiB,
  readQueueJob,
  retryAfterMs,
  shouldRetryQueueSubmit,
  submitQueueAdmission,
  supportsCooperativeCheckpoint,
  transitionQueueJob,
  type QueueArtifact,
  type QueueHeartbeatPayload,
  type QueueJobSummary,
  type QueueJobState,
  type QueueTransitionState,
  type SegmentBoundaryDecision,
} from "./admission.js";
import { buildCommand, type CommandPlan, validateRequestPlan } from "./command.js";
import { getModelInventory } from "./models.js";
import {
  admissionPythonExecutable,
  appRoot,
  executableAvailable,
  hybridCacheRoot,
  hybridRoot,
  latentSyncCheckpointPath,
  latentSyncImage,
  latentSyncInsightFaceRoot,
  latentSyncVaeRoot,
  latentSyncWhisperPath,
  lipForcingImage,
  lipForcingModelRoot,
  longcatProjectRoot,
  longcatMinAvailableGiB,
  longcatThermalStartMaxC,
  museTalkImage,
  museTalkModelRoot,
  outputRoot,
  pythonExecutable,
  pythonRuntimeAvailable,
  repoRoot,
  statePath,
  thermalPauseC,
  thermalPausePolls,
  thermalPollIntervalMs,
  thermalResumePolls,
  thermalStartSampleIntervalMs,
  thermalStartSamples,
  thermalUnreadablePolls,
} from "./config.js";
import {
  readResourceSnapshot,
  validatePreAdmissionResources,
  type ResourceSnapshot,
} from "./system.js";
import { estimateRequest } from "./estimates.js";
import type { AssetStore } from "./assets.js";
import {
  captureIdentityEvidence,
  normalizeIdentityInputEvidence,
  verifyIdentityEvidence,
  type IdentityInputEvidence,
} from "./inputEvidence.js";
import { readMaxTemperatureC, readMedianMaxTemperatureC, ThermalPauseGuard } from "./thermal.js";
import { buildFinalAudioRemuxArgs } from "./audioRemux.js";
import type { RunProvenance } from "../shared/provenance.js";
import {
  bindRunProvenanceFile,
  captureRunProvenance,
  normalizeRunProvenance,
  verifyRunProvenance,
} from "./runProvenance.js";
import { RuntimeApiError } from "./runtimeApi.js";

export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";

export type ThermalProfile = {
  baselineC: number;
  currentC: number | null;
  peakC: number;
  riseC: number;
  pauseAtC: number;
  resumeBelowC: number;
  updatedAt: string;
};

export type StudioJob = {
  id: string;
  status: JobStatus;
  mode: GenerationRequest["mode"];
  prompt: string;
  outputName: string;
  outputUrl: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: number | null;
  error: string | null;
  logs: string[];
  command: string;
  request: GenerationRequest;
  favorite: boolean;
  variantOf: string | null;
  experiment: ExperimentRunBinding | null;
  runtimeMs: number | null;
  cancelledBy: "studio" | null;
  thermalProfile: ThermalProfile | null;
  dgxJobId: string | null;
  identityEvidence: IdentityInputEvidence | null;
  runProvenance: RunProvenance | null;
};

type DgxOwnerHeartbeatState = {
  jobId: string;
  phase: string;
  progressEpoch: number;
  acknowledgedProgressEpoch: number;
  stopped: boolean;
  timer?: NodeJS.Timeout;
  inFlight?: Promise<void>;
  lastError?: string;
};

type RuntimeJob = StudioJob & {
  plan: CommandPlan;
  process?: ChildProcess;
  processTermination?: Promise<void>;
  localProcessGroupPending?: boolean;
  localProcessGroupIdentity?: LocalProcessGroupIdentity;
  localProcessGroupRetry?: NodeJS.Timeout;
  dgxSubmitPending?: boolean;
  dgxSubmitStartedAt?: string;
  dgxAdmissionAbortController?: AbortController;
  dgxJobTerminal?: boolean;
  dgxStateTransitionInFlight?: Promise<boolean>;
  dgxTerminalDelivery?: DgxTerminalDelivery;
  dgxTerminalDeliveryInFlight?: Promise<boolean>;
  dgxTerminalRetry?: NodeJS.Timeout;
  dgxOwnerHeartbeat?: DgxOwnerHeartbeatState;
};
type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };

export function describeLipForcingFailure(
  logs: readonly string[],
  result: ProcessResult,
): string {
  if (result.error) return `LipForcing konnte nicht gestartet werden: ${result.error.message}`;
  const recentLogs = logs.slice(-120);
  if (recentLogs.some((line) => /CUDA error: out of memory|cudaErrorMemoryAllocation/i.test(line))) {
    return "LipForcing konnte das 14B-Modell nicht vollständig in den gemeinsamen CPU-/GPU-Speicher laden. "
      + "Der Lauf wurde sauber beendet; die vorhandene LTX-Basis und ältere Videos bleiben unverändert.";
  }
  const adapterError = [...recentLogs]
    .reverse()
    .find((line) => line.startsWith("LipForcing: Fehler: "));
  if (adapterError) return adapterError.slice("LipForcing: Fehler: ".length);
  return `LipForcing beendet mit Code ${String(result.code)}`
    + `${result.signal ? ` (${result.signal})` : ""}.`;
}
type IdentityEvidenceOperations = {
  capture: typeof captureIdentityEvidence;
  verify: typeof verifyIdentityEvidence;
};
type DgxTransitionMetadata = {
  current_step?: string;
  last_error?: string;
  artifact?: QueueArtifact;
};
type DgxTerminalState = Extract<QueueTransitionState, "completed" | "failed" | "cancelled">;
type DgxTerminalDelivery = {
  state: DgxTerminalState;
  metadata: DgxTransitionMetadata;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
};
type DgxStartOutcome = "started" | "queued" | "resubmit" | "stopped";
type LocalProcessGroupIdentity = {
  bootId: string;
  processGroupId: number;
  leaderStartTicks: string;
};
type PersistedStudioJob = StudioJob & {
  dgxTerminalDelivery?: DgxTerminalDelivery;
  localProcessGroupPending?: boolean;
  localProcessGroupIdentity?: LocalProcessGroupIdentity;
  dgxSubmitPending?: boolean;
  dgxSubmitStartedAt?: string;
};
type DgxQueueOperations = {
  read: typeof readQueueJob;
  transition: typeof transitionQueueJob;
  heartbeat?: typeof heartbeatQueueJob;
};
type DgxAdmissionOperations = {
  submit: typeof submitQueueAdmission;
  list?: typeof listQueueJobs;
};
type DgxSchedulerOperations = {
  decide: typeof decideSegmentBoundary;
};
type RunProvenanceOperations = {
  capture: typeof captureRunProvenance;
  verify: typeof verifyRunProvenance;
  bindFile?: typeof bindRunProvenanceFile;
};
type ModelInventoryOperations = {
  read: typeof getModelInventory;
};

const MAX_JOBS = 100;
export const MAX_ACTIVE_JOBS = 8;
const MAX_LOG_LINES = 600;
const MAX_LOG_LINE_LENGTH = 4000;
const RESOURCE_RETRY_INTERVAL_MS = 10_000;
const RESOURCE_WAIT_LOG_INTERVAL_MS = 60_000;
const MAX_RUNNING_PROCESS_PROGRESS = 95;
const DEFAULT_DGX_TERMINAL_RETRY_BASE_MS = 5_000;
const MAX_DGX_TERMINAL_RETRY_MS = 60_000;
const DGX_START_FENCE_RETRY_MS = 30_000;
const DGX_SUBMIT_AMBIGUITY_MAX_MS = 125_000;
const DGX_SUBMIT_RECONCILE_POLL_MS = 2_000;
export const DGX_OWNER_HEARTBEAT_INTERVAL_MS = Math.min(
  60_000,
  Math.max(
    1_000,
    Number.parseInt(process.env.LTX_STUDIO_DGX_HEARTBEAT_INTERVAL_MS ?? "45000", 10) || 45_000,
  ),
);
const LOCAL_PROCESS_GROUP_RECONCILE_MS = 2_000;
const LTX_COOPERATIVE_YIELD_EXIT_CODE = 75;
const SEGMENT_BOUNDARY_FILE_POLL_MS = Math.max(
  25,
  Number.parseInt(process.env.LTX_STUDIO_SEGMENT_BOUNDARY_FILE_POLL_MS ?? "50", 10) || 50,
);
const SEGMENT_BOUNDARY_PAUSED_POLL_MS = Math.max(
  10,
  Number.parseInt(process.env.LTX_STUDIO_SEGMENT_BOUNDARY_PAUSED_POLL_MS ?? "5000", 10) || 5_000,
);
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "paused"];
const DGX_TERMINAL_STATES = new Set<DgxTerminalState>(["completed", "failed", "cancelled"]);
const DGX_REMOTE_TERMINAL_STATES = new Set<QueueJobState>([
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);

function runtimePayloadError(error: RuntimeApiError): string | null {
  if (!error.payload || typeof error.payload !== "object") return null;
  const value = (error.payload as Record<string, unknown>).error;
  return typeof value === "string" ? value : null;
}

function retryableStartFenceDelayMs(error: unknown): number | null {
  if (error instanceof RuntimeApiError) {
    if (
      error.statusCode === 409
      && ["qwen_gate_active", "start_gate_active"].includes(runtimePayloadError(error) ?? "")
    ) {
      const payload = error.payload as Record<string, unknown>;
      const seconds = payload.retry_after_seconds;
      return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
        ? Math.max(1_000, seconds * 1_000)
        : DGX_START_FENCE_RETRY_MS;
    }
    if (error.statusCode === null && /timeout/i.test(error.message)) {
      return DGX_START_FENCE_RETRY_MS;
    }
    return null;
  }
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT"].includes(String(error.code))
    ? DGX_START_FENCE_RETRY_MS
    : null;
}

export type VariantMode = "exact" | "random-seed";

export class JobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobConflictError";
  }
}

export function nextVariantOutputName(outputName: string, unavailable: (name: string) => boolean): string {
  const extension = outputName.toLowerCase().endsWith(".wav") ? ".wav" : ".mp4";
  const base = outputName.replace(/\.(?:mp4|wav)$/i, "").replace(/-v\d+$/i, "");
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${base}-v${String(index).padStart(2, "0")}${extension}`;
    if (!unavailable(candidate)) return candidate;
  }
  return `${base}-${Date.now()}${extension}`;
}

function ltxBaseComparable(request: GenerationRequest): object {
  const generation: Partial<GenerationRequest> = structuredClone(request);
  const otherPostprocess: Partial<GenerationRequest["postprocess"]> = { ...generation.postprocess };
  delete generation.outputName;
  delete generation.continuity;
  delete otherPostprocess.longcatLipsync;
  delete otherPostprocess.latentSync;
  delete otherPostprocess.museTalk;
  delete otherPostprocess.lipForcing;
  generation.postprocess = otherPostprocess as GenerationRequest["postprocess"];
  if (generation.audio) {
    generation.audio = {
      ...generation.audio,
      finalMix: { path: "", name: "" },
    };
  }
  return generation;
}

export function requestsShareLtxBase(left: GenerationRequest, right: GenerationRequest): boolean {
  return isDeepStrictEqual(ltxBaseComparable(left), ltxBaseComparable(right));
}

export function publishedOutputIsReusableLtxBase(
  source: GenerationRequest,
  target: GenerationRequest,
): boolean {
  return !source.audio.finalMix.path
    && !source.postprocess.longcatLipsync.enabled
    && !source.postprocess.latentSync.enabled
    && !source.postprocess.museTalk.enabled
    && !source.postprocess.lipForcing.enabled
    && requestsShareLtxBase(source, target);
}

export function runProvenanceSharesLtxBase(
  source: RunProvenance | null,
  target: RunProvenance | null,
): boolean {
  if (!source?.verifiedAt || !target) return false;
  const ltxFiles = (evidence: RunProvenance) => evidence.files
    .filter((file) =>
      file.role !== "code:longcat-adapter"
      && file.role !== "model:longcat-face-detector"
      && !file.role.startsWith("code:latentsync-")
      && !file.role.startsWith("model:latentsync-")
      && !file.role.startsWith("code:musetalk-")
      && !file.role.startsWith("model:musetalk-")
      && !file.role.startsWith("code:lipforcing-")
      && !file.role.startsWith("model:lipforcing-")
      // The shared refiner audio window helper is captured by every refiner
      // arm but never touches the LTX base. Leaving it in made the role lists
      // differ for good, so no refiner run could ever adopt an existing base.
      && file.role !== "code:refiner-audio-window"
      && !file.role.startsWith("input:reused-ltx-base:")
      && file.role !== "input:final-audio-mix")
    .map((file) => ({ role: file.role, sha256: file.sha256 }))
    .sort((left, right) => left.role.localeCompare(right.role));
  return isDeepStrictEqual(ltxFiles(source), ltxFiles(target))
    && source.runtime.fingerprint === target.runtime.fingerprint;
}

export type ReusableLtxBaseCandidate = {
  outputName: string;
  outputPath: string;
  jobId: string;
  request: GenerationRequest;
  identityEvidence: IdentityInputEvidence;
  runProvenance: RunProvenance;
};

export type ReusableLtxBaseSource = {
  reusableLtxBaseCandidates: () => ReusableLtxBaseCandidate[];
};

type ReusableLtxBase = {
  id: string;
  outputPath: string;
  description: string;
};

export function identityEvidenceMatches(
  left: IdentityInputEvidence | null,
  right: IdentityInputEvidence | null,
): boolean {
  if (left?.status !== "verified" || !["captured", "verified"].includes(right?.status ?? "")) return false;
  return left.source === right?.source
    && isDeepStrictEqual(
      left.references.map(({ assetId, kind, sizeBytes, modifiedAtMs, changedAtMs, fileId, sha256 }) => ({
        assetId,
        kind,
        sizeBytes,
        modifiedAtMs,
        changedAtMs,
        fileId,
        sha256,
      })),
      right?.references.map(({ assetId, kind, sizeBytes, modifiedAtMs, changedAtMs, fileId, sha256 }) => ({
        assetId,
        kind,
        sizeBytes,
        modifiedAtMs,
        changedAtMs,
        fileId,
        sha256,
      })),
    );
}

export function reusableLtxBaseFromSidecars(
  candidates: readonly ReusableLtxBaseCandidate[],
  target: {
    id: string;
    request: GenerationRequest;
    identityEvidence: IdentityInputEvidence | null;
    runProvenance: RunProvenance | null;
  },
  fileReady: (path: string) => boolean,
): ReusableLtxBase | undefined {
  const match = candidates.find((candidate) =>
    candidate.jobId !== target.id
    && !candidate.request.postprocess.longcatLipsync.enabled
    && publishedOutputIsReusableLtxBase(candidate.request, target.request)
    && identityEvidenceMatches(candidate.identityEvidence, target.identityEvidence)
    && runProvenanceSharesLtxBase(candidate.runProvenance, target.runProvenance)
    && fileReady(candidate.outputPath));
  if (!match) return undefined;
  return {
    id: match.jobId,
    outputPath: match.outputPath,
    description: `persistierter Ausgabe „${match.outputName}" (Job ${match.jobId})`,
  };
}

export function resolveRenderOutputPaths(
  finalOutput: string,
  stageRoot: string,
  hybridEnabled: boolean,
  finalAudioMixEnabled: boolean,
  latentSyncEnabled = false,
  museTalkEnabled = false,
  lipForcingEnabled = false,
): { ltxOutput: string; compositeOutput: string; refinedOutput: string; remuxInput: string } {
  const refinerEnabled = latentSyncEnabled || museTalkEnabled || lipForcingEnabled;
  const ltxOutput = hybridEnabled || finalAudioMixEnabled || refinerEnabled
    ? join(stageRoot, "ltx-base.mp4")
    : finalOutput;
  const compositeOutput = finalAudioMixEnabled || refinerEnabled
    ? join(stageRoot, "longcat-composite.mp4")
    : finalOutput;
  const refinedOutput = finalAudioMixEnabled
    ? join(
        stageRoot,
        lipForcingEnabled
          ? "lipforcing-refined.mp4"
          : museTalkEnabled ? "musetalk-refined.mp4" : "latentsync-refined.mp4",
      )
    : finalOutput;
  return {
    ltxOutput,
    compositeOutput,
    refinedOutput,
    remuxInput: refinerEnabled
      ? refinedOutput
      : hybridEnabled ? compositeOutput : ltxOutput,
  };
}

export function buildRefinerAudioArgs(request: GenerationRequest): string[] {
  let path = "";
  let startTime = 0;
  let maxDuration: number | null = null;
  if (isAudioConditionedMode(request.mode)) {
    path = request.audio.path;
    startTime = request.audio.startTime;
    maxDuration = request.audio.maxDuration;
  } else if (request.mode === "lipdub") {
    path = request.lipDub.referenceVideo.path;
  }
  // ID-LoRA intentionally passes no audio override: its reference audio is a
  // voice-cloning sample, while the spoken dialogue lives in the base video's
  // native speech track, which the refiner extracts itself.
  if (!path) return [];
  const args = [
    "--audio", path,
    "--audio-start", String(startTime),
  ];
  if (maxDuration !== null) {
    args.push("--audio-duration", String(maxDuration));
  }
  return args;
}

function now(): string {
  return new Date().toISOString();
}

function atomicJsonFile(path: string, value: object): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${path.split("/").at(-1)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  const directoryDescriptor = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    if (statSync(path).size > 64 * 1024) return null;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validTimestamp(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function normalizeDgxTerminalDelivery(value: unknown): DgxTerminalDelivery | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<DgxTerminalDelivery>;
  if (!candidate.state || !DGX_TERMINAL_STATES.has(candidate.state)) return undefined;
  const metadata = candidate.metadata && typeof candidate.metadata === "object"
    ? candidate.metadata
    : {};
  const artifact = metadata.artifact && typeof metadata.artifact === "object"
    && typeof metadata.artifact.type === "string"
    ? {
        type: metadata.artifact.type.slice(0, 100),
        ...(typeof metadata.artifact.path === "string" ? { path: metadata.artifact.path } : {}),
        ...(typeof metadata.artifact.url === "string" ? { url: metadata.artifact.url } : {}),
        ...(typeof metadata.artifact.size_bytes === "number"
          && Number.isFinite(metadata.artifact.size_bytes)
          && metadata.artifact.size_bytes >= 0
          ? { size_bytes: metadata.artifact.size_bytes }
          : {}),
        ...(typeof metadata.artifact.sha256 === "string" ? { sha256: metadata.artifact.sha256.slice(0, 128) } : {}),
        ...(typeof metadata.artifact.note === "string" ? { note: metadata.artifact.note.slice(0, 1000) } : {}),
      }
    : undefined;
  return {
    state: candidate.state,
    metadata: {
      ...(typeof metadata.current_step === "string"
        ? { current_step: metadata.current_step.slice(0, 1000) }
        : {}),
      ...(typeof metadata.last_error === "string"
        ? { last_error: metadata.last_error.slice(0, 4000) }
        : {}),
      ...(artifact ? { artifact } : {}),
    },
    attempts: typeof candidate.attempts === "number"
      && Number.isInteger(candidate.attempts)
      && candidate.attempts >= 0
      ? Math.min(candidate.attempts, 1_000_000)
      : 0,
    lastError: typeof candidate.lastError === "string" ? candidate.lastError.slice(0, 4000) : null,
    updatedAt: validTimestamp(candidate.updatedAt, now())!,
  };
}

export function isActiveJobStatus(status: JobStatus): boolean {
  return ACTIVE_JOB_STATUSES.includes(status);
}

type FramedProcessChunk = {
  records: string[];
  rest: string;
};

export function frameProcessLogChunk(buffer: string, chunk: string, flush = false): FramedProcessChunk {
  const combined = `${buffer}${chunk}`;
  const parts = combined.split(/\r\n|[\r\n]/);
  const rest = flush ? "" : parts.pop() ?? "";
  if (flush && parts.at(-1) !== combined) parts.push("");
  return {
    records: parts.filter((part) => part.length > 0),
    rest,
  };
}

export function progressFromPipelineLog(line: string): number | null {
  const match = line.match(
    /(?:^|\s)(100|[1-9]?\d(?:\.\d+)?)%\|[^|\r\n]*\|\s*\d+(?:\.\d+)?\/\d+(?:\.\d+)?(?=\s|$)/,
  );
  if (!match) return null;
  return Number.parseFloat(match[1]);
}

export class PipelineProgressTracker {
  private denoisingStage = -1;
  private phase: "preparing" | "denoising" | "decoding" = "preparing";
  private current: number;

  constructor(
    private readonly start: number,
    private readonly end: number,
    private readonly expectedDenoisingStages: number,
  ) {
    this.current = start;
  }

  update(line: string): number | null {
    let fraction: number | null = null;
    if (line.includes("Building text encoder")) {
      fraction = 0.02;
    } else if (line.includes("Prompt encoding complete")) {
      fraction = 0.08;
    } else if (line.includes("Running denoising loop")) {
      this.denoisingStage = Math.min(
        this.expectedDenoisingStages - 1,
        this.denoisingStage + 1,
      );
      this.phase = "denoising";
      fraction = 0.1 + 0.8 * this.denoisingStage / this.expectedDenoisingStages;
    } else if (line.includes("Building video decoder")) {
      this.phase = "decoding";
      fraction = 0.9;
    } else if (line.includes("Video saved to")) {
      fraction = 1;
    } else {
      const phaseProgress = progressFromPipelineLog(line);
      if (phaseProgress === null) return null;
      const phaseFraction = phaseProgress / 100;
      if (this.phase === "denoising" && this.denoisingStage >= 0) {
        fraction = 0.1 + 0.8
          * (this.denoisingStage + phaseFraction)
          / this.expectedDenoisingStages;
      } else if (this.phase === "decoding") {
        fraction = 0.9 + 0.1 * phaseFraction;
      } else {
        return null;
      }
    }

    const candidate = this.start + (this.end - this.start) * fraction;
    this.current = Math.max(this.current, Math.min(this.end, candidate));
    return this.current;
  }

  isDenoising(): boolean {
    return this.phase === "denoising";
  }
}

function processIsAlive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function jobWasCancelled(job: RuntimeJob): boolean {
  return job.status === "cancelled" || job.status === "interrupted";
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return child.kill(signal);
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readBootId(): string {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bootId)) {
    throw new Error("Linux-Boot-ID ist nicht lesbar oder ungültig.");
  }
  return bootId;
}

function readProcessStat(processId: number): { processGroupId: number; startTicks: string } {
  const raw = readFileSync(`/proc/${processId}/stat`, "utf8");
  const suffixStart = raw.lastIndexOf(") ");
  if (suffixStart < 0) throw new Error(`Prozessstatus ${processId} ist ungültig.`);
  const fields = raw.slice(suffixStart + 2).trim().split(/\s+/u);
  const processGroupId = Number.parseInt(fields[2] ?? "", 10);
  const startTicks = fields[19] ?? "";
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 0 || !/^[0-9]+$/u.test(startTicks)) {
    throw new Error(`Prozessstatus ${processId} enthält keine sichere Gruppenidentität.`);
  }
  return { processGroupId, startTicks };
}

function captureLocalProcessGroupIdentity(processGroupId: number): LocalProcessGroupIdentity {
  const details = readProcessStat(processGroupId);
  if (details.processGroupId !== processGroupId) {
    throw new Error(`Prozess ${processGroupId} besitzt keine eigene isolierte Prozessgruppe.`);
  }
  return {
    bootId: readBootId(),
    processGroupId,
    leaderStartTicks: details.startTicks,
  };
}

function isLocalProcessGroupIdentity(value: unknown): value is LocalProcessGroupIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.bootId === "string"
    && /^[0-9a-f-]{36}$/i.test(identity.bootId)
    && typeof identity.processGroupId === "number"
    && Number.isSafeInteger(identity.processGroupId)
    && identity.processGroupId > 0
    && typeof identity.leaderStartTicks === "string"
    && /^[0-9]+$/u.test(identity.leaderStartTicks);
}

function localProcessGroupIsGone(identity: LocalProcessGroupIdentity): boolean {
  if (readBootId() !== identity.bootId) return true;
  try {
    const currentLeader = readProcessStat(identity.processGroupId);
    if (currentLeader.startTicks !== identity.leaderStartTicks) return true;
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9]+$/u.test(entry.name)) continue;
    try {
      if (readProcessStat(Number.parseInt(entry.name, 10)).processGroupId === identity.processGroupId) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return true;
}

async function waitForProcessGroupExit(processGroupId: number, deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (!processGroupExists(processGroupId)) return true;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !processGroupExists(processGroupId);
}

async function terminateProcessGroup(
  child: ChildProcess,
  wasPaused: boolean,
  graceMs = 10_000,
  deadlineMs = 15_000,
): Promise<void> {
  if (!child.pid) return;
  const processGroupId = child.pid;
  if (wasPaused) signalProcessGroup(child, "SIGCONT");
  signalProcessGroup(child, "SIGTERM");
  const startedAt = Date.now();
  if (await waitForProcessGroupExit(processGroupId, startedAt + graceMs)) return;
  signalProcessGroup(child, "SIGKILL");
  if (!await waitForProcessGroupExit(processGroupId, startedAt + deadlineMs)) {
    throw new Error(`Prozessgruppe ${processGroupId} blieb nach SIGKILL aktiv.`);
  }
}

function publicJob(job: RuntimeJob): StudioJob {
  const value = { ...job } as Partial<RuntimeJob>;
  delete value.plan;
  delete value.process;
  delete value.processTermination;
  delete value.localProcessGroupPending;
  delete value.localProcessGroupIdentity;
  delete value.localProcessGroupRetry;
  delete value.dgxSubmitPending;
  delete value.dgxSubmitStartedAt;
  delete value.dgxAdmissionAbortController;
  delete value.dgxJobTerminal;
  delete value.dgxStateTransitionInFlight;
  delete value.dgxTerminalDelivery;
  delete value.dgxTerminalDeliveryInFlight;
  delete value.dgxTerminalRetry;
  delete value.dgxOwnerHeartbeat;
  return value as StudioJob;
}

function persistedJob(job: RuntimeJob): PersistedStudioJob {
  const value: PersistedStudioJob = publicJob(job);
  if (job.dgxTerminalDelivery) value.dgxTerminalDelivery = structuredClone(job.dgxTerminalDelivery);
  if (job.localProcessGroupPending) value.localProcessGroupPending = true;
  if (job.localProcessGroupIdentity) {
    value.localProcessGroupIdentity = structuredClone(job.localProcessGroupIdentity);
  }
  if (job.dgxSubmitPending) value.dgxSubmitPending = true;
  if (job.dgxSubmitStartedAt) value.dgxSubmitStartedAt = job.dgxSubmitStartedAt;
  return value;
}

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function cleanLogLine(line: string): string {
  return line.replaceAll(ANSI_COLOR, "").slice(0, MAX_LOG_LINE_LENGTH);
}

function expectedDenoisingStages(request: GenerationRequest): number {
  if (request.mode === "one-stage" || request.mode === "retake" || request.mode === "text-to-audio") return 1;
  if (request.mode === "ic-lora" && request.icLora.skipStage2) return 1;
  return 2;
}

function thermalProfileFromLogs(logs: unknown): ThermalProfile | null {
  if (!Array.isArray(logs)) return null;
  for (const value of [...logs].reverse()) {
    if (typeof value !== "string") continue;
    const match = value.match(
      /Thermalprofil .* Basis ([0-9]+(?:\.[0-9]+)?) °C, Peak ([0-9]+(?:\.[0-9]+)?) °C, beobachteter Anstieg ([0-9]+(?:\.[0-9]+)?) °C/,
    );
    if (!match) continue;
    const baselineC = Number.parseFloat(match[1]);
    const peakC = Number.parseFloat(match[2]);
    const riseC = Number.parseFloat(match[3]);
    return {
      baselineC,
      currentC: null,
      peakC,
      riseC,
      pauseAtC: thermalPauseC,
      resumeBelowC: Math.min(baselineC + 0.1, thermalPauseC - 0.1),
      updatedAt: now(),
    };
  }
  return null;
}

export class JobManager extends EventEmitter {
  private readonly jobs = new Map<string, RuntimeJob>();
  private readonly queue: string[] = [];
  private runningId: string | null = null;
  private activeRunPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<{
    queuedPreserved: number;
    localGroupsStopped: number;
    localPending: number;
    remoteConfirmed: number;
    remotePending: number;
  }> | null = null;

  private reusableBaseSource: ReusableLtxBaseSource | null = null;

  constructor(
    private readonly storagePath = statePath,
    private readonly autoStart = true,
    private readonly assets: AssetStore | null = null,
    private readonly identityEvidenceOperations: IdentityEvidenceOperations = {
      capture: captureIdentityEvidence,
      verify: verifyIdentityEvidence,
    },
    private readonly dgxQueueOperations: DgxQueueOperations = {
      read: readQueueJob,
      transition: transitionQueueJob,
      heartbeat: heartbeatQueueJob,
    },
    private readonly dgxTerminalRetryBaseMs: number | null = DEFAULT_DGX_TERMINAL_RETRY_BASE_MS,
    private readonly dgxAdmissionOperations: DgxAdmissionOperations = {
      submit: submitQueueAdmission,
      list: listQueueJobs,
    },
    private readonly runProvenanceOperations: RunProvenanceOperations = {
      capture: captureRunProvenance,
      verify: verifyRunProvenance,
      bindFile: bindRunProvenanceFile,
    },
    private readonly dgxSchedulerOperations: DgxSchedulerOperations = {
      decide: decideSegmentBoundary,
    },
    private readonly modelInventoryOperations: ModelInventoryOperations = {
      read: getModelInventory,
    },
  ) {
    super();
    this.restore();
    for (const job of this.jobs.values()) {
      this.scheduleLocalProcessGroupReconciliation(job, 0);
      this.scheduleDgxTerminalRetry(job, 0);
    }
    if (this.autoStart && this.queue.length > 0) queueMicrotask(() => void this.pump());
  }

  // The output library lives beside the manager in index.ts; wiring it after
  // construction avoids threading a tenth positional constructor default.
  wireReusableBaseSource(source: ReusableLtxBaseSource): void {
    this.reusableBaseSource = source;
  }

  list(): StudioJob[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(publicJob);
  }

  get(id: string): StudioJob | undefined {
    const job = this.jobs.get(id);
    return job ? publicJob(job) : undefined;
  }

  create(
    request: GenerationRequest,
    metadata: {
      variantOf?: string | null;
      experiment?: ExperimentRunBinding | null;
      deferStart?: boolean;
    } = {},
  ): StudioJob {
    // The frozen experiment request is the authority for an A/B run. Normal
    // jobs are still canonicalized here; experiment requests are canonicalized
    // before freeze or are bound to an exact, verified historical output.
    request = metadata.experiment
      ? structuredClone(request)
      : withOfficialSpeechModelPaths(request);
    if (this.shuttingDown) {
      throw new JobConflictError("LTX Studio wird beendet und nimmt keine neuen Aufträge mehr an.");
    }
    const activeJobs = [...this.jobs.values()].filter((job) => isActiveJobStatus(job.status));
    if (activeJobs.length >= MAX_ACTIVE_JOBS) {
      throw new JobConflictError(
        `Die lokale Warteschlange ist auf ${MAX_ACTIVE_JOBS} aktive Aufträge begrenzt. Bitte zuerst einen Auftrag abschließen oder abbrechen.`,
      );
    }
    if (activeJobs.some((job) => job.outputName === request.outputName)) {
      throw new JobConflictError(`Die Ausgabedatei ${request.outputName} ist bereits durch einen aktiven Job reserviert.`);
    }
    const plan = buildCommand(request);
    const id = randomUUID();
    const job: RuntimeJob = {
      id,
      status: "queued",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      logs: [],
      command: plan.displayCommand,
      request,
      favorite: false,
      variantOf: metadata.variantOf ?? null,
      experiment: metadata.experiment ? experimentRunBindingSchema.parse(metadata.experiment) : null,
      runtimeMs: null,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: null,
      identityEvidence: null,
      runProvenance: null,
      plan,
    };
    this.jobs.set(id, job);
    this.queue.push(id);
    this.trimHistory();
    try {
      this.changed();
    } catch (error) {
      this.jobs.delete(id);
      const queueIndex = this.queue.indexOf(id);
      if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
      throw error;
    }
    if (this.autoStart && !metadata.deferStart) void this.pump();
    return publicJob(job);
  }

  startQueued(id: string): StudioJob | undefined {
    if (this.shuttingDown) return undefined;
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued" || !this.queue.includes(id)) return undefined;
    if (this.autoStart) void this.pump();
    return publicJob(job);
  }

  rerun(id: string, mode: VariantMode): StudioJob | undefined {
    const source = this.jobs.get(id);
    if (!source || isActiveJobStatus(source.status)) return undefined;
    const unavailable = (name: string) =>
      [...this.jobs.values()].some((job) => job.outputName === name) || existsSync(join(outputRoot, name));
    const request = withOfficialSpeechModelPaths(structuredClone(source.request));
    request.outputName = nextVariantOutputName(source.outputName, unavailable);
    if (mode === "random-seed") request.seed = randomInt(0, 2_147_483_647);
    return this.create(request, { variantOf: source.variantOf ?? source.id });
  }

  setFavorite(id: string, favorite: boolean): StudioJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    job.favorite = favorite;
    this.changed();
    return publicJob(job);
  }

  remove(id: string): StudioJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (
      isActiveJobStatus(job.status)
      || job.process
      || job.processTermination
      || job.localProcessGroupPending
      || job.dgxSubmitPending
      || job.dgxStateTransitionInFlight
      || job.dgxTerminalDelivery
      || job.dgxTerminalDeliveryInFlight
    ) {
      throw new JobConflictError(
        "Der Job ist noch aktiv oder seine DGX-Abschlussmeldung ist noch nicht bestätigt.",
      );
    }
    this.jobs.delete(id);
    try {
      this.changed();
    } catch (error) {
      this.jobs.set(id, job);
      throw error;
    }
    return publicJob(job);
  }

  cancel(id: string): StudioJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.status === "queued") {
      const index = this.queue.indexOf(id);
      if (index >= 0) this.queue.splice(index, 1);
      const process = job.process;
      this.prepareDgxTerminalDelivery(job, "cancelled", {
        current_step: "cancelled by LTX Studio before local start",
        last_error: "manual Studio cancellation",
      });
      job.status = "cancelled";
      job.cancelledBy = "studio";
      job.finishedAt = now();
      if (job.startedAt) job.runtimeMs = Date.now() - Date.parse(job.startedAt);
      this.appendLog(job, "Manueller Abbruch über die Studio-Abbruchfunktion vor dem Start angefordert.");
      if (process?.pid) {
        void this.stopProcessBeforeTerminalDelivery(job, process, false);
      }
      this.changed();
      if (!process?.pid) void this.flushDgxTerminalDelivery(job);
      return publicJob(job);
    }
    if (["running", "paused"].includes(job.status)) {
      const wasPaused = job.status === "paused";
      const process = job.process;
      this.prepareDgxTerminalDelivery(job, "cancelled", {
        current_step: "cancelled by LTX Studio",
        last_error: "manual Studio cancellation",
      });
      job.status = "cancelled";
      job.cancelledBy = "studio";
      job.finishedAt = now();
      if (job.startedAt) job.runtimeMs = Date.now() - Date.parse(job.startedAt);
      this.appendLog(job, "Manueller Abbruch über die Studio-Abbruchfunktion angefordert.");
      if (process?.pid) {
        void this.stopProcessBeforeTerminalDelivery(job, process, wasPaused);
      }
      this.changed();
      if (!process?.pid) void this.flushDgxTerminalDelivery(job);
    }
    return publicJob(job);
  }

  async shutdown(timeoutMs = 15_000): Promise<{
    queuedPreserved: number;
    localGroupsStopped: number;
    localPending: number;
    remoteConfirmed: number;
    remotePending: number;
  }> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    for (const job of this.jobs.values()) {
      job.dgxAdmissionAbortController?.abort();
      delete job.dgxAdmissionAbortController;
      if (job.dgxTerminalRetry) clearTimeout(job.dgxTerminalRetry);
      delete job.dgxTerminalRetry;
      if (job.localProcessGroupRetry) clearTimeout(job.localProcessGroupRetry);
      delete job.localProcessGroupRetry;
    }
    this.shutdownPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      const activeJob = this.runningId ? this.jobs.get(this.runningId) : undefined;
      let localGroupsStopped = 0;
      const preserveLocalQueue = activeJob?.status === "queued"
        && !activeJob.dgxJobId
        && !activeJob.process;
      if (activeJob && preserveLocalQueue) {
        if (!this.queue.includes(activeJob.id)) this.queue.unshift(activeJob.id);
        this.appendLog(
          activeJob,
          "Studio-Shutdown: rein lokaler Queue-Auftrag bleibt für den nächsten Start erhalten.",
        );
        this.changed();
      } else if (activeJob && isActiveJobStatus(activeJob.status)) {
        const process = activeJob.process;
        const wasPaused = activeJob.status === "paused";
        this.prepareDgxTerminalDelivery(activeJob, "cancelled", {
          current_step: "LTX Studio signal shutdown after local process stop",
          last_error: "LTX Studio was stopped before the job completed",
        });
        activeJob.status = "interrupted";
        activeJob.finishedAt = now();
        if (activeJob.startedAt) activeJob.runtimeMs = Date.now() - Date.parse(activeJob.startedAt);
        this.appendLog(
          activeJob,
          "Studio-Shutdown: aktiver Job wird kontrolliert unterbrochen; dies ist kein manueller Benutzerabbruch.",
        );
        this.changed();
        if (process?.pid) {
          try {
            await this.withDeadline(
              this.stopProcessBeforeTerminalDelivery(
                activeJob,
                process,
                wasPaused,
                Math.min(10_000, Math.max(100, timeoutMs - 1_000)),
                timeoutMs,
              ),
              deadline,
            );
            localGroupsStopped = 1;
          } catch (error) {
            this.appendLog(
              activeJob,
              `Studio-Shutdown konnte die lokale Prozessgruppe nicht sicher beenden: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            this.changed();
          }
        } else {
          await this.withDeadline(
            this.flushDgxTerminalDelivery(activeJob).then(() => undefined),
            deadline,
          ).catch(() => undefined);
        }
      }
      if (this.activeRunPromise) {
        await this.withDeadline(this.activeRunPromise, deadline).catch(() => undefined);
      }
      const terminalJobs = [...this.jobs.values()].filter((job) => job.dgxTerminalDelivery);
      for (const job of terminalJobs) {
        if (Date.now() >= deadline) break;
        await this.withDeadline(
          this.flushDgxTerminalDelivery(job).then(() => undefined),
          deadline,
        ).catch(() => undefined);
      }
      const shutdownRemoteJobs = [...this.jobs.values()].filter(
        (job) => job.dgxSubmitPending
          || (job.dgxJobId
            && (job.status === "interrupted" || job.dgxTerminalDelivery || job.dgxJobTerminal)),
      );
      return {
        queuedPreserved: [...this.jobs.values()].filter(
          (job) => job.status === "queued",
        ).length,
        localGroupsStopped,
        localPending: [...this.jobs.values()].filter((job) => job.localProcessGroupPending).length,
        remoteConfirmed: shutdownRemoteJobs.filter((job) => job.dgxJobTerminal).length,
        remotePending: shutdownRemoteJobs.filter(
          (job) => Boolean(job.dgxSubmitPending || job.dgxTerminalDelivery),
        ).length,
      };
    })();
    return this.shutdownPromise;
  }

  private stopProcessBeforeTerminalDelivery(
    job: RuntimeJob,
    process: ChildProcess,
    wasPaused: boolean,
    graceMs = 10_000,
    deadlineMs = 15_000,
  ): Promise<void> {
    if (job.processTermination) return job.processTermination;
    const termination = (async () => {
      await terminateProcessGroup(process, wasPaused, graceMs, deadlineMs);
      if (job.process === process) delete job.process;
      delete job.localProcessGroupPending;
      delete job.localProcessGroupIdentity;
      this.changed();
      await this.flushDgxTerminalDelivery(job);
    })();
    job.processTermination = termination;
    void termination.catch((error) => {
      this.appendLog(
        job,
        `Lokale Prozessgruppe konnte nicht sicher beendet werden; Remote-Lease bleibt vorgemerkt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.changed();
    }).finally(() => {
      if (job.processTermination === termination) delete job.processTermination;
    });
    return termination;
  }

  private withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) return Promise.reject(new Error("Studio-Shutdown-Zeitlimit erreicht."));
    return Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Studio-Shutdown-Zeitlimit erreicht.")),
          remaining,
        );
        timer.unref();
      }),
    ]);
  }

  private jobShouldStop(job: RuntimeJob): boolean {
    return this.shuttingDown || jobWasCancelled(job);
  }

  private async markProcessStarted(job: RuntimeJob, child: ChildProcess): Promise<void> {
    job.process = child;
    job.localProcessGroupPending = true;
    try {
      if (!child.pid) throw new Error("Gestarteter Prozess besitzt keine PID.");
      job.localProcessGroupIdentity = captureLocalProcessGroupIdentity(child.pid);
      this.changed();
    } catch (error) {
      this.appendLog(
        job,
        `Lokale Prozessgruppenidentität konnte nicht dauerhaft gebunden werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.changed();
      try {
        await terminateProcessGroup(child, false, 250, 2_000);
        if (job.process === child) delete job.process;
        delete job.localProcessGroupPending;
        delete job.localProcessGroupIdentity;
        this.changed();
      } catch {
        // The persisted pending marker keeps every remote terminal transition fenced.
      }
      throw error;
    }
  }

  private async confirmProcessGroupGone(job: RuntimeJob, child: ChildProcess): Promise<void> {
    if (child.pid && processGroupExists(child.pid)) {
      await terminateProcessGroup(child, false, 250, 2_000);
    }
    if (job.process === child) delete job.process;
    delete job.localProcessGroupPending;
    delete job.localProcessGroupIdentity;
    this.changed();
  }

  private scheduleLocalProcessGroupReconciliation(job: RuntimeJob, delayMs: number): void {
    if (
      this.shuttingDown
      || !job.localProcessGroupPending
      || !job.localProcessGroupIdentity
      || job.localProcessGroupRetry
    ) {
      return;
    }
    job.localProcessGroupRetry = setTimeout(() => {
      delete job.localProcessGroupRetry;
      void this.reconcileLocalProcessGroup(job);
    }, delayMs);
    job.localProcessGroupRetry.unref();
  }

  private async reconcileLocalProcessGroup(job: RuntimeJob): Promise<void> {
    const identity = job.localProcessGroupIdentity;
    if (!job.localProcessGroupPending || !identity || this.shuttingDown) return;
    let gone = false;
    try {
      gone = localProcessGroupIsGone(identity);
    } catch (error) {
      process.stderr.write(
        `LTX Studio Prozessgruppen-Recovery bleibt fail-closed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      this.scheduleLocalProcessGroupReconciliation(job, LOCAL_PROCESS_GROUP_RECONCILE_MS);
      return;
    }
    if (!gone) {
      this.scheduleLocalProcessGroupReconciliation(job, LOCAL_PROCESS_GROUP_RECONCILE_MS);
      return;
    }
    delete job.localProcessGroupPending;
    delete job.localProcessGroupIdentity;
    this.appendLog(
      job,
      "Studio-Recovery: frühere lokale Prozessgruppe ist nachweislich beendet; Remote-Terminalmeldung wird freigegeben.",
    );
    this.changed();
    await this.flushDgxTerminalDelivery(job);
    this.scheduleDgxTerminalRetry(job, 0);
  }

  private async pump(): Promise<void> {
    if (this.shuttingDown || this.runningId !== null) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return void this.pump();
    this.runningId = id;
    const runPromise = this.run(job);
    this.activeRunPromise = runPromise;
    try {
      await runPromise;
    } catch (error) {
      if (!["cancelled", "interrupted"].includes(this.jobs.get(id)?.status ?? "")) {
        const message = `Interner Runner-Fehler: ${
          error instanceof Error ? error.message : "Unerwarteter Fehler im Job-Runner."
        }`;
        try {
          await this.failDgxJob(job, message, "unexpected LTX Studio runner failure");
        } catch (persistError) {
          process.stderr.write(`LTX Studio konnte den Fehlerzustand nicht persistieren: ${String(persistError)}\n`);
        }
      }
    } finally {
      if (this.activeRunPromise === runPromise) this.activeRunPromise = null;
      this.runningId = null;
      if (!this.shuttingDown) void this.pump();
    }
  }

  private async run(job: RuntimeJob): Promise<void> {
    const exactAdoptedRefinerRun = isAdoptedLipForcingCandidate(job.experiment);
    const requiredAssetIds = exactAdoptedRefinerRun
      ? []
      : requiredOfficialSpeechAssetIds(job.request);
    let inventory: ModelInventory | undefined;
    const pathErrors: string[] = [];
    if (requiredAssetIds.length > 0) {
      try {
        inventory = await this.modelInventoryOperations.read(true, requiredAssetIds);
      } catch (error) {
        pathErrors.push(
          `Die offizielle Modellintegrität konnte nicht geprüft werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    pathErrors.push(...validateRequestPlan(job.request, job.plan, inventory, {
      enforceOfficialAssets: !exactAdoptedRefinerRun,
    }));
    const hybridEnabled = job.request.postprocess.longcatLipsync.enabled;
    const latentSyncEnabled = job.request.postprocess.latentSync.enabled;
    const museTalkEnabled = job.request.postprocess.museTalk.enabled;
    const lipForcingEnabled = job.request.postprocess.lipForcing.enabled;
    const refinerEnabled = latentSyncEnabled || museTalkEnabled || lipForcingEnabled;
    const finalAudioMixEnabled = isAudioConditionedMode(job.request.mode)
      && Boolean(job.request.audio.finalMix.path);
    const hybridScript = join(appRoot, "scripts", "longcat-hybrid.py");
    const hybridFaceModel = join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
    const latentSyncScript = join(appRoot, "scripts", "latentsync-refiner.py");
    const museTalkScript = join(appRoot, "scripts", "musetalk-refiner.py");
    const lipForcingScript = join(appRoot, "scripts", "lipforcing-refiner.py");
    if (hybridEnabled) {
      if (!existsSync(hybridScript)) pathErrors.push(`LongCat-Adapter fehlt (${hybridScript})`);
      if (!existsSync(hybridFaceModel)) pathErrors.push(`YuNet-Gesichtsmodell fehlt (${hybridFaceModel})`);
      if (!existsSync(join(longcatProjectRoot, "scripts", "avatar_worker_supervisor.py"))) {
        pathErrors.push(`LongCat-Projekt ist unvollständig (${longcatProjectRoot})`);
      }
    }
    if (latentSyncEnabled) {
      for (const [label, path] of [
        ["LatentSync-Adapter", latentSyncScript],
        ["LatentSync-1.6-Checkpoint", latentSyncCheckpointPath],
        ["LatentSync-Whisper-Tiny", latentSyncWhisperPath],
        ["LatentSync-VAE-Konfiguration", join(latentSyncVaeRoot, "config.json")],
        ["LatentSync-VAE", join(latentSyncVaeRoot, "diffusion_pytorch_model.safetensors")],
        [
          "LatentSync-InsightFace-SCRFD-Gesichtsmodell",
          join(latentSyncInsightFaceRoot, "models", "buffalo_l", "det_10g.onnx"),
        ],
        [
          "LatentSync-InsightFace-106-Punkt-Landmark-Modell",
          join(latentSyncInsightFaceRoot, "models", "buffalo_l", "2d106det.onnx"),
        ],
      ] as const) {
        if (!existsSync(path)) pathErrors.push(`${label} fehlt (${path})`);
      }
      if (!executableAvailable("docker")) {
        pathErrors.push("Docker für den LatentSync-Refiner ist nicht verfügbar.");
      } else {
        const imageCheck = spawnSync("docker", ["image", "inspect", latentSyncImage], {
          encoding: "utf8",
          shell: false,
          stdio: "ignore",
          timeout: 20_000,
        });
        if (imageCheck.status !== 0 || imageCheck.error) {
          pathErrors.push(`LatentSync-Containerimage fehlt (${latentSyncImage}).`);
        }
      }
    }
    if (museTalkEnabled) {
      for (const [label, path] of [
        ["MuseTalk-Adapter", museTalkScript],
        ["MuseTalk-1.5-UNet-Konfiguration", join(museTalkModelRoot, "musetalkV15", "musetalk.json")],
        ["MuseTalk-1.5-UNet", join(museTalkModelRoot, "musetalkV15", "unet.pth")],
        ["MuseTalk-VAE-Konfiguration", join(museTalkModelRoot, "sd-vae", "config.json")],
        ["MuseTalk-VAE", join(museTalkModelRoot, "sd-vae", "diffusion_pytorch_model.bin")],
        ["MuseTalk-Whisper-Konfiguration", join(museTalkModelRoot, "whisper", "config.json")],
        ["MuseTalk-Whisper", join(museTalkModelRoot, "whisper", "pytorch_model.bin")],
        ["MuseTalk-Whisper-Vorverarbeitung", join(museTalkModelRoot, "whisper", "preprocessor_config.json")],
        ["MuseTalk-Gesichtsparser", join(museTalkModelRoot, "face-parse-bisent", "79999_iter.pth")],
        ["MuseTalk-ResNet18", join(museTalkModelRoot, "face-parse-bisent", "resnet18-5c106cde.pth")],
        [
          "MuseTalk-InsightFace-SCRFD-Gesichtsmodell",
          join(latentSyncInsightFaceRoot, "models", "buffalo_l", "det_10g.onnx"),
        ],
        [
          "MuseTalk-InsightFace-106-Punkt-Landmark-Modell",
          join(latentSyncInsightFaceRoot, "models", "buffalo_l", "2d106det.onnx"),
        ],
      ] as const) {
        if (!existsSync(path)) pathErrors.push(`${label} fehlt (${path})`);
      }
      if (!executableAvailable("docker")) {
        pathErrors.push("Docker für den MuseTalk-Refiner ist nicht verfügbar.");
      } else {
        const imageCheck = spawnSync("docker", ["image", "inspect", museTalkImage], {
          encoding: "utf8",
          shell: false,
          stdio: "ignore",
          timeout: 20_000,
        });
        if (imageCheck.status !== 0 || imageCheck.error) {
          pathErrors.push(`MuseTalk-Containerimage fehlt (${museTalkImage}).`);
        }
      }
    }
    if (lipForcingEnabled) {
      for (const [label, path] of [
        ["LipForcing-Adapter", lipForcingScript],
        ["LipForcing-14B-Modell", join(lipForcingModelRoot, "lipforcing_14b.pth")],
        ["LipForcing-Wan-VAE", join(lipForcingModelRoot, "Wan2.1_VAE.pth")],
        [
          "LipForcing-wav2vec2",
          join(lipForcingModelRoot, "wav2vec2-base-960h", "model.safetensors"),
        ],
        [
          "LipForcing-wav2vec2-Merkmalsextraktion",
          join(lipForcingModelRoot, "wav2vec2-base-960h", "feature_extractor_config.json"),
        ],
        ["LipForcing-Mundmaske", join(lipForcingModelRoot, "mask.png")],
        ["LipForcing-Text-Embedding", join(lipForcingModelRoot, "text_emb.pt")],
        [
          "LipForcing-Text-Embedding-Provenienz",
          join(lipForcingModelRoot, "text-embedding-provenance.json"),
        ],
        [
          "LipForcing-Modellmanifest",
          join(lipForcingModelRoot, "ltx-studio-model-manifest.json"),
        ],
        [
          "LipForcing-InsightFace-SCRFD-Gesichtsmodell",
          join(latentSyncInsightFaceRoot, "models", "buffalo_l", "det_10g.onnx"),
        ],
        [
          "LipForcing-InsightFace-106-Punkt-Landmark-Modell",
          join(latentSyncInsightFaceRoot, "models", "buffalo_l", "2d106det.onnx"),
        ],
      ] as const) {
        if (!existsSync(path)) pathErrors.push(`${label} fehlt (${path})`);
      }
      if (
        job.request.postprocess.lipForcing.decoder === "streaming-taehv"
        && !existsSync(join(lipForcingModelRoot, "taew2_1.pth"))
      ) {
        pathErrors.push(`LipForcing-TAEHV fehlt (${join(lipForcingModelRoot, "taew2_1.pth")})`);
      }
      if (!executableAvailable("docker")) {
        pathErrors.push("Docker für den LipForcing-Refiner ist nicht verfügbar.");
      } else {
        const imageCheck = spawnSync("docker", ["image", "inspect", lipForcingImage], {
          encoding: "utf8",
          shell: false,
          stdio: "ignore",
          timeout: 20_000,
        });
        if (imageCheck.status !== 0 || imageCheck.error) {
          pathErrors.push(`LipForcing-Containerimage fehlt (${lipForcingImage}).`);
        }
      }
    }
    if (pathErrors.length > 0) {
      job.status = "failed";
      job.finishedAt = now();
      job.error = pathErrors.join("\n");
      for (const error of pathErrors) this.appendLog(job, error);
      this.changed();
      return;
    }
    if (!pythonRuntimeAvailable(pythonExecutable)) {
      job.status = "failed";
      job.finishedAt = now();
      job.error = `Die konfigurierte Python-LTX-Laufzeit ist unvollständig: ${pythonExecutable}`;
      this.appendLog(job, job.error);
      this.changed();
      return;
    }
    if ((finalAudioMixEnabled || refinerEnabled) && !executableAvailable("ffmpeg")) {
      job.status = "failed";
      job.finishedAt = now();
      job.error = "FFmpeg für die finale Tonspur ist nicht verfügbar.";
      this.appendLog(job, job.error);
      this.changed();
      return;
    }

    job.identityEvidence = await this.identityEvidenceOperations.capture(job.request, this.assets);
    if (this.jobShouldStop(job)) {
      this.changed();
      return;
    }
    if (job.identityEvidence.status === "captured") {
      this.appendLog(
        job,
        `${job.identityEvidence.references.length} Identitätsreferenz(en) kryptografisch für diesen Lauf gebunden.`,
      );
    } else if (job.identityEvidence.status === "unavailable") {
      this.appendLog(
        job,
        `Identitätsmessung später nicht beweisbar: ${job.identityEvidence.reason ?? "Referenzprovenienz fehlt."}`,
      );
    }
    this.changed();

    try {
      job.runProvenance = await this.runProvenanceOperations.capture(job.request, job.plan);
    } catch (error) {
      if (this.jobShouldStop(job)) return;
      this.failJob(
        job,
        `Laufprovenienz konnte nicht vollständig gebunden werden: ${
          error instanceof Error ? error.message : "unbekannter Fehler"
        }`,
      );
      return;
    }
    if (this.jobShouldStop(job)) {
      this.changed();
      return;
    }
    this.appendLog(
      job,
      `${job.runProvenance.files.length} verwendete Datei-/Modellartefakte sowie Code und Runtime kryptografisch gebunden `
        + `(Manifest ${job.runProvenance.fingerprint.slice(0, 12)}).`,
    );
    this.changed();

    const stageRoot = join(hybridRoot, job.id);
    const longcatOutput = join(stageRoot, "longcat.mp4");
    const { ltxOutput, compositeOutput, refinedOutput, remuxInput } = resolveRenderOutputPaths(
      job.plan.outputPath,
      stageRoot,
      hybridEnabled,
      finalAudioMixEnabled,
      latentSyncEnabled,
      museTalkEnabled,
      lipForcingEnabled,
    );
    if (hybridEnabled || refinerEnabled || finalAudioMixEnabled) {
      mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
    }
    if (hybridEnabled) {
      if (!await this.verifyJobRunProvenance(job, "vor der LongCat-Stufe")) return;
      if (!await this.verifyJobIdentityEvidence(job, "vor der LongCat-Stufe")) return;
      this.appendLog(
        job,
        "Optionaler LongCat-Lippenpass aktiv: zuerst Mundspur, danach LTX und lokales Mund-Compositing.",
      );
      const args = [
        hybridScript,
        "generate",
        "--project-root",
        longcatProjectRoot,
        "--image",
        job.request.images[0].path,
        "--audio",
        job.request.audio.path,
        "--output",
        longcatOutput,
        "--cache-root",
        hybridCacheRoot,
        "--resolution",
        job.request.postprocess.longcatLipsync.resolution,
        "--seed",
        String(job.request.seed),
        "--audio-start",
        String(job.request.audio.startTime),
        "--supervisor-python",
        admissionPythonExecutable,
      ];
      if (job.request.audio.maxDuration !== null) {
        args.push("--audio-duration", String(job.request.audio.maxDuration));
      }
      const cacheResult = await this.runLoggedProcess(job, pythonExecutable, [...args, "--cache-only"], {
        cwd: repoRoot,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      });
      if (this.jobShouldStop(job)) return;
      const cacheHit = !cacheResult.error && cacheResult.code === 0 && this.fileReady(longcatOutput);
      if (!cacheHit && (cacheResult.error || cacheResult.code !== 3)) {
        this.failJob(
          job,
          cacheResult.error?.message
            ?? `LongCat-Cacheprüfung beendet mit Code ${String(cacheResult.code)}${cacheResult.signal ? ` (${cacheResult.signal})` : ""}.`,
        );
        return;
      }
      if (!cacheHit) {
        if (!await this.waitForLongcatResources(job)) return;
      }
      job.status = "running";
      job.startedAt = now();
      if (!cacheHit) {
        this.appendLog(job, "LongCat-Stufe gestartet; Admission und Thermal-Schutz übernimmt der LongCat-Supervisor.");
        const longcatResult = await this.runLoggedProcess(job, pythonExecutable, args, {
          cwd: repoRoot,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });
        if (this.jobShouldStop(job)) return;
        if (longcatResult.error || longcatResult.code !== 0 || !this.fileReady(longcatOutput)) {
          this.failJob(
            job,
            longcatResult.error?.message
              ?? `LongCat-Stufe beendet mit Code ${String(longcatResult.code)}${longcatResult.signal ? ` (${longcatResult.signal})` : ""}.`,
          );
          return;
        }
      } else {
        this.appendLog(job, "LongCat-Cache verifiziert; RAM- und Thermal-Startgate sind ohne DGX-Start nicht erforderlich.");
      }
      job.progress = 20;
      this.appendLog(job, "LongCat-Mundspur steht für das spätere Compositing bereit.");
      this.changed();
    }

    const reusableBase = hybridEnabled || refinerEnabled
      ? this.findReusableLtxBase(job)
      : undefined;
    if (reusableBase) {
      copyFileSync(reusableBase.outputPath, ltxOutput);
      if (!this.fileReady(ltxOutput)) {
        this.failJob(job, "Die identische vorhandene LTX-Basis konnte nicht übernommen werden.");
        return;
      }
      if (!job.runProvenance) {
        this.failJob(job, "Laufprovenienz fehlt vor der Bindung der wiederverwendeten LTX-Basis.");
        return;
      }
      try {
        const bindFile = this.runProvenanceOperations.bindFile ?? bindRunProvenanceFile;
        job.runProvenance = await bindFile(
          job.runProvenance,
          ltxOutput,
          `input:reused-ltx-base:${reusableBase.id}`,
        );
      } catch (error) {
        this.failJob(
          job,
          `Die wiederverwendete LTX-Basis konnte nicht kryptografisch gebunden werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      job.progress = refinerEnabled ? 80 : 70;
      this.appendLog(
        job,
        `Identische LTX-Basis aus ${reusableBase.description} übernommen und kryptografisch gebunden; `
          + "kein redundanter DGX-Render nötig.",
      );
      this.changed();
      if (refinerEnabled) {
        const refinerMemoryGiB = refinerAdmissionMemoryGiB(job.request) ?? 16;
        if (!await this.waitForDgxQueueStart(job, refinerMemoryGiB)) return;
        const refinerName = lipForcingEnabled
          ? "LipForcing"
          : museTalkEnabled ? "MuseTalk" : "LatentSync";
        if (!await this.verifyJobIdentityEvidence(job, `unmittelbar vor dem ${refinerName}-Start`)) {
          await this.transitionDgxJob(job, "failed", {
            current_step: `identity reference changed before ${refinerName} allocation`,
            last_error: job.error ?? "identity reference verification failed",
          });
          return;
        }
        if (!await this.verifyJobRunProvenance(job, `unmittelbar vor dem ${refinerName}-Start`)) {
          await this.transitionDgxJob(job, "failed", {
            current_step: `run provenance changed before ${refinerName} allocation`,
            last_error: job.error ?? "run provenance verification failed",
          });
          return;
        }
      }
    } else {
      if (!await this.waitForDgxQueueStart(job)) return;
      if (!await this.verifyJobIdentityEvidence(job, "unmittelbar vor dem LTX-Start")) {
        if (this.jobShouldStop(job)) return;
        await this.transitionDgxJob(job, "failed", {
          current_step: "identity reference changed before LTX allocation",
          last_error: job.error ?? "identity reference verification failed",
        });
        return;
      }
      if (!await this.verifyJobRunProvenance(job, "unmittelbar vor dem LTX-Start")) {
        if (this.jobShouldStop(job)) return;
        await this.transitionDgxJob(job, "failed", {
          current_step: "run provenance changed before LTX allocation",
          last_error: job.error ?? "run provenance verification failed",
        });
        return;
      }
      this.appendLog(job, `LTX-Start: ${job.command}`);
      const pythonPath = [
        `${repoRoot}/packages/ltx-core/src`,
        `${repoRoot}/packages/ltx-pipelines/src`,
        process.env.PYTHONPATH,
      ]
        .filter(Boolean)
        .join(":");
      const ltxArgs = [...job.plan.args];
      const outputArgumentIndex = ltxArgs.indexOf("--output-path");
      if (outputArgumentIndex < 0) {
        this.failJob(job, "Interner Fehler: Die LTX-Ausgabeoption fehlt im Befehlsplan.");
        return;
      }
      ltxArgs[outputArgumentIndex + 1] = ltxOutput;
      const ltxProgressEnd = hybridEnabled
        ? finalAudioMixEnabled ? 80 : 85
        : refinerEnabled
          ? finalAudioMixEnabled ? 80 : 85
          : finalAudioMixEnabled ? 90 : MAX_RUNNING_PROCESS_PROGRESS;
      const progressTracker = new PipelineProgressTracker(
        hybridEnabled ? 20 : 0,
        ltxProgressEnd,
        expectedDenoisingStages(job.request),
      );
      const cooperativeEnabled = supportsCooperativeCheckpoint(job.request)
        && job.plan.executable === pythonExecutable
        && Boolean(job.runProvenance?.fingerprint);
      const checkpointManifest = cooperativeCheckpointPath(job.id);
      const checkpointRoot = dirname(checkpointManifest);
      if (cooperativeEnabled) mkdirSync(checkpointRoot, { recursive: true, mode: 0o700 });
      let cooperativeGeneration = 0;

      while (true) {
        const thermalBaselineC = await this.readThermalBaseline(job);
        if (this.jobShouldStop(job)) return;
        if (thermalBaselineC === null) {
          await this.transitionDgxJob(job, "failed", {
            current_step: "thermal start gate failed before LTX allocation",
            last_error: job.error ?? "thermal start gate failed",
          });
          return;
        }

        job.status = "running";
        job.startedAt ??= now();
        const child = spawn(job.plan.executable, ltxArgs, {
          cwd: repoRoot,
          env: {
            ...process.env,
            DGX_JOB_ID: job.dgxJobId ?? undefined,
            LTX_COOPERATIVE_CHECKPOINT_DIR: cooperativeEnabled ? checkpointRoot : undefined,
            LTX_COOPERATIVE_JOB_FINGERPRINT: cooperativeEnabled
              ? job.runProvenance?.fingerprint
              : undefined,
            LTX_COOPERATIVE_GENERATION: cooperativeEnabled
              ? String(cooperativeGeneration)
              : undefined,
            PYTHONPATH: pythonPath,
            PYTHONUNBUFFERED: "1",
          },
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        await this.markProcessStarted(job, child);
        if (!await this.transitionDgxJob(job, "running", {
          current_step: cooperativeEnabled
            ? "ltx native pipeline running with cooperative Euler checkpoints"
            : "ltx native pipeline running",
        })) {
          if (this.jobShouldStop(job)) return;
          this.failJob(job, "DGX-Queue-Running-State wurde nicht freigegeben; LTX-Prozess wurde beendet.");
          await this.stopProcessBeforeTerminalDelivery(job, child, false).catch(() => undefined);
          return;
        }
        this.changed();
        this.consumeProcessLogs(job, child, progressTracker);
        const boundaryWatcher = cooperativeEnabled
          ? this.watchSegmentBoundaries(
              job,
              checkpointRoot,
              job.runProvenance!.fingerprint,
              cooperativeGeneration,
            )
          : null;
        const stopThermalWatcher = this.watchThermals(job, child, thermalBaselineC);
        const ltxResult = await this.waitForProcess(child);
        stopThermalWatcher();
        await boundaryWatcher?.stop();
        await this.confirmProcessGroupGone(job, child);
        if (this.jobShouldStop(job)) {
          return;
        }

        if (!ltxResult.error && ltxResult.code === LTX_COOPERATIVE_YIELD_EXIT_CODE && cooperativeEnabled) {
          const artifact = this.validateCooperativeCheckpoint(
            job,
            checkpointManifest,
            boundaryWatcher?.yieldDecisionId() ?? null,
          );
          rmSync(join(checkpointRoot, "boundary-ready.json"), { force: true });
          rmSync(join(checkpointRoot, "boundary-decision.json"), { force: true });
          if (!artifact) {
            await this.failDgxJob(
              job,
              "LTX meldete einen kooperativen Yield, aber der atomare Checkpoint ist unvollständig oder gehört zu einem anderen Lauf.",
              "invalid cooperative LTX checkpoint",
            );
            return;
          }
          if (!await this.pauseAndResumeDgxSlice(job, artifact)) return;
          if (!await this.verifyJobRunProvenance(job, "vor dem LTX-Resume")) {
            await this.transitionDgxJob(job, "failed", {
              current_step: "run provenance changed before LTX resume",
              last_error: job.error ?? "run provenance verification failed before resume",
            });
            return;
          }
          this.appendLog(job, "LTX wird aus dem bestätigten Euler-Checkpoint fortgesetzt.");
          this.changed();
          cooperativeGeneration += 1;
          continue;
        }

        if (ltxResult.error || ltxResult.code !== 0 || !this.fileReady(ltxOutput)) {
          this.failJob(
            job,
            ltxResult.error?.message
              ?? `Pipeline beendet mit Code ${String(ltxResult.code)}${ltxResult.signal ? ` (${ltxResult.signal})` : ""}.`,
          );
          await this.transitionDgxJob(job, "failed", {
            current_step: "ltx native pipeline failed",
            last_error: job.error ?? "ltx native pipeline failed",
          });
          return;
        }
        if (cooperativeEnabled) rmSync(checkpointRoot, { recursive: true, force: true });
        break;
      }

      if (this.jobShouldStop(job)) {
        this.changed();
        return;
      }
      job.progress = Math.max(job.progress ?? 0, ltxProgressEnd);
    }

    if (hybridEnabled) {
      const compositeStart = finalAudioMixEnabled ? 80 : 85;
      job.progress = Math.max(job.progress ?? 0, compositeStart);
      this.appendLog(
        job,
        "LTX-Basisvideo fertig. LongCat-Mundbereich wird mit dynamischen Gesichtslandmarks lokal und zeitgenau eingeblendet.",
      );
      const compositeResult = await this.runLoggedProcess(
        job,
        pythonExecutable,
        [
          hybridScript,
          "composite",
          "--base",
          ltxOutput,
          "--longcat",
          longcatOutput,
          "--output",
          compositeOutput,
          "--blend",
          String(job.request.postprocess.longcatLipsync.blend),
          "--face-model",
          hybridFaceModel,
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        },
      );
      if (this.jobShouldStop(job)) return;
      if (compositeResult.error || compositeResult.code !== 0 || !this.fileReady(compositeOutput)) {
        await this.failDgxJob(
          job,
          compositeResult.error?.message
            ?? `LongCat-Compositing beendet mit Code ${String(compositeResult.code)}${compositeResult.signal ? ` (${compositeResult.signal})` : ""}.`,
          "LongCat compositing failed",
        );
        return;
      }
      job.progress = finalAudioMixEnabled ? 90 : MAX_RUNNING_PROCESS_PROGRESS;
    }

    if (latentSyncEnabled) {
      const latentSyncInput = hybridEnabled ? compositeOutput : ltxOutput;
      const containerName = `ltx-latentsync-${job.id}`;
      const thermalBaselineC = await this.readThermalBaseline(job);
      if (this.jobShouldStop(job)) return;
      if (thermalBaselineC === null) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "thermal start gate failed before LatentSync allocation",
          last_error: job.error ?? "thermal start gate failed",
        });
        return;
      }
      if (!await this.verifyJobRunProvenance(job, "unmittelbar vor dem LatentSync-Start")) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "run provenance changed before LatentSync start",
          last_error: job.error ?? "run provenance verification failed",
        });
        return;
      }
      this.appendLog(
        job,
        "LatentSync 1.6 startet als audiogeführter Gesichtsrefiner. LTX-Kopfbewegung, Körper und Hintergrund bleiben erhalten.",
      );
      rmSync(refinedOutput, { force: true });
      const latentSyncArgs = [
        latentSyncScript,
        "--video", latentSyncInput,
        "--output", refinedOutput,
        "--stage-root", stageRoot,
        "--checkpoint", latentSyncCheckpointPath,
        "--whisper", latentSyncWhisperPath,
        "--vae-root", latentSyncVaeRoot,
        "--insightface-root", latentSyncInsightFaceRoot,
        "--image", latentSyncImage,
        "--container-name", containerName,
        "--steps", String(job.request.postprocess.latentSync.steps),
        "--guidance", String(job.request.postprocess.latentSync.guidance),
        "--seed", String(job.request.seed),
      ];
      const latentSyncAudioArgs = buildRefinerAudioArgs(job.request);
      if (latentSyncAudioArgs.length > 0) {
        latentSyncArgs.push(...latentSyncAudioArgs);
        this.appendLog(
          job,
          "LatentSync verwendet die unveränderte saubere Sprachkonditionierung als Mund- und Ausgabetonspur.",
        );
      }
      const child = spawn(
        pythonExecutable,
        latentSyncArgs,
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            DGX_JOB_ID: job.dgxJobId ?? undefined,
            PYTHONUNBUFFERED: "1",
          },
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      job.status = "running";
      job.startedAt ??= now();
      await this.markProcessStarted(job, child);
      if (reusableBase && !await this.transitionDgxJob(job, "running", {
        current_step: "LatentSync 1.6 face refinement running on reused LTX base",
      })) {
        if (this.jobShouldStop(job)) return;
        await this.stopProcessBeforeTerminalDelivery(job, child, false).catch(() => undefined);
        this.failJob(job, "DGX-Queue-Running-State wurde für LatentSync nicht freigegeben.");
        return;
      }
      this.setDgxOwnerHeartbeatPhase(job, "latentsync_refinement");
      this.consumeProcessLogs(job, child);
      const stopThermalWatcher = this.watchOwnedDockerThermals(
        job,
        child,
        thermalBaselineC,
        containerName,
      );
      const latentSyncResult = await this.waitForProcess(child);
      stopThermalWatcher();
      await this.confirmProcessGroupGone(job, child);
      if (this.jobShouldStop(job)) return;
      if (latentSyncResult.error || latentSyncResult.code !== 0 || !this.fileReady(refinedOutput)) {
        await this.failDgxJob(
          job,
          latentSyncResult.error?.message
            ?? `LatentSync beendet mit Code ${String(latentSyncResult.code)}`
              + `${latentSyncResult.signal ? ` (${latentSyncResult.signal})` : ""}.`,
          "LatentSync face refinement failed",
        );
        return;
      }
      job.progress = finalAudioMixEnabled ? 90 : MAX_RUNNING_PROCESS_PROGRESS;
      this.appendLog(job, "LatentSync-Gesichtsrefiner erfolgreich abgeschlossen.");
      this.changed();
    }

    if (museTalkEnabled) {
      const museTalkInput = hybridEnabled ? compositeOutput : ltxOutput;
      const containerName = `ltx-musetalk-${job.id}`;
      const thermalBaselineC = await this.readThermalBaseline(job);
      if (this.jobShouldStop(job)) return;
      if (thermalBaselineC === null) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "thermal start gate failed before MuseTalk allocation",
          last_error: job.error ?? "thermal start gate failed",
        });
        return;
      }
      if (!await this.verifyJobRunProvenance(job, "unmittelbar vor dem MuseTalk-Start")) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "run provenance changed before MuseTalk start",
          last_error: job.error ?? "run provenance verification failed",
        });
        return;
      }
      this.appendLog(
        job,
        "MuseTalk 1.5 startet als bildweises Lippen-Inpainting mit InsightFace-106-Ausrichtung. "
          + "LTX-Kopfbewegung, Körper und Hintergrund bleiben erhalten.",
      );
      rmSync(refinedOutput, { force: true });
      const museTalkArgs = [
        museTalkScript,
        "--video", museTalkInput,
        "--output", refinedOutput,
        "--stage-root", stageRoot,
        "--model-root", museTalkModelRoot,
        "--insightface-root", latentSyncInsightFaceRoot,
        "--image", museTalkImage,
        "--container-name", containerName,
        "--extra-margin", String(job.request.postprocess.museTalk.extraMargin),
        "--cheek-width", String(job.request.postprocess.museTalk.cheekWidth),
        "--audio-padding-left", String(job.request.postprocess.museTalk.audioPaddingLeft),
        "--audio-padding-right", String(job.request.postprocess.museTalk.audioPaddingRight),
      ];
      const museTalkAudioArgs = buildRefinerAudioArgs(job.request);
      if (museTalkAudioArgs.length > 0) {
        museTalkArgs.push(...museTalkAudioArgs);
        this.appendLog(
          job,
          "MuseTalk verwendet die unveränderte saubere Sprachkonditionierung als Mund- und Ausgabetonspur.",
        );
      }
      const child = spawn(
        pythonExecutable,
        museTalkArgs,
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            DGX_JOB_ID: job.dgxJobId ?? undefined,
            PYTHONUNBUFFERED: "1",
          },
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      job.status = "running";
      job.startedAt ??= now();
      await this.markProcessStarted(job, child);
      if (reusableBase && !await this.transitionDgxJob(job, "running", {
        current_step: "MuseTalk 1.5 frame inpainting running on reused LTX base",
      })) {
        if (this.jobShouldStop(job)) return;
        await this.stopProcessBeforeTerminalDelivery(job, child, false).catch(() => undefined);
        this.failJob(job, "DGX-Queue-Running-State wurde für MuseTalk nicht freigegeben.");
        return;
      }
      this.setDgxOwnerHeartbeatPhase(job, "musetalk_refinement");
      this.consumeProcessLogs(job, child);
      const stopThermalWatcher = this.watchOwnedDockerThermals(
        job,
        child,
        thermalBaselineC,
        containerName,
      );
      const museTalkResult = await this.waitForProcess(child);
      stopThermalWatcher();
      await this.confirmProcessGroupGone(job, child);
      if (this.jobShouldStop(job)) return;
      if (museTalkResult.error || museTalkResult.code !== 0 || !this.fileReady(refinedOutput)) {
        await this.failDgxJob(
          job,
          museTalkResult.error?.message
            ?? `MuseTalk beendet mit Code ${String(museTalkResult.code)}`
              + `${museTalkResult.signal ? ` (${museTalkResult.signal})` : ""}.`,
          "MuseTalk frame inpainting failed",
        );
        return;
      }
      job.progress = finalAudioMixEnabled ? 90 : MAX_RUNNING_PROCESS_PROGRESS;
      this.appendLog(job, "MuseTalk-1.5-Lippen-Inpainting erfolgreich abgeschlossen.");
      this.changed();
    }

    if (lipForcingEnabled) {
      const lipForcingInput = hybridEnabled ? compositeOutput : ltxOutput;
      const containerName = `ltx-lipforcing-${job.id}`;
      const thermalBaselineC = await this.readThermalBaseline(job);
      if (this.jobShouldStop(job)) return;
      if (thermalBaselineC === null) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "thermal start gate failed before LipForcing allocation",
          last_error: job.error ?? "thermal start gate failed",
        });
        return;
      }
      if (!await this.verifyJobRunProvenance(job, "unmittelbar vor dem LipForcing-Start")) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "run provenance changed before LipForcing start",
          last_error: job.error ?? "run provenance verification failed",
        });
        return;
      }
      this.appendLog(
        job,
        "LipForcing 14B startet mit offizieller 512x512-Gesichtsausrichtung und audiogeführter "
          + "Zwei-Schritt-Diffusion. Kopfbewegung, Körper, Hintergrund und die exakte LTX-Zeitachse bleiben erhalten.",
      );
      rmSync(refinedOutput, { force: true });
      const lipForcingArgs = [
        lipForcingScript,
        "--video", lipForcingInput,
        "--output", refinedOutput,
        "--stage-root", stageRoot,
        "--model-root", lipForcingModelRoot,
        "--insightface-root", latentSyncInsightFaceRoot,
        "--image", lipForcingImage,
        "--container-name", containerName,
        "--decoder", job.request.postprocess.lipForcing.decoder,
        "--seed", String(job.request.seed),
      ];
      const lipForcingAudioArgs = buildRefinerAudioArgs(job.request);
      if (lipForcingAudioArgs.length > 0) {
        lipForcingArgs.push(...lipForcingAudioArgs);
        this.appendLog(
          job,
          "LipForcing verwendet die unveränderte saubere Sprachkonditionierung; ein separater Musik-Endmix wird erst danach eingebunden.",
        );
      }
      const child = spawn(
        pythonExecutable,
        lipForcingArgs,
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            DGX_JOB_ID: job.dgxJobId ?? undefined,
            PYTHONUNBUFFERED: "1",
          },
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      job.status = "running";
      job.startedAt ??= now();
      await this.markProcessStarted(job, child);
      if (reusableBase && !await this.transitionDgxJob(job, "running", {
        current_step: "LipForcing 14B refinement running on reused LTX base",
      })) {
        if (this.jobShouldStop(job)) return;
        await this.stopProcessBeforeTerminalDelivery(job, child, false).catch(() => undefined);
        this.failJob(job, "DGX-Queue-Running-State wurde für LipForcing nicht freigegeben.");
        return;
      }
      this.setDgxOwnerHeartbeatPhase(job, "lipforcing_refinement");
      this.consumeProcessLogs(job, child);
      const stopThermalWatcher = this.watchOwnedDockerThermals(
        job,
        child,
        thermalBaselineC,
        containerName,
      );
      const lipForcingResult = await this.waitForProcess(child);
      stopThermalWatcher();
      await this.confirmProcessGroupGone(job, child);
      if (this.jobShouldStop(job)) return;
      if (
        lipForcingResult.error
        || lipForcingResult.code !== 0
        || !this.fileReady(refinedOutput)
      ) {
        await this.failDgxJob(
          job,
          describeLipForcingFailure(job.logs, lipForcingResult),
          "LipForcing 14B refinement failed",
        );
        return;
      }
      job.progress = finalAudioMixEnabled ? 90 : MAX_RUNNING_PROCESS_PROGRESS;
      this.appendLog(job, "LipForcing-14B-Lippenrefiner erfolgreich abgeschlossen.");
      this.changed();
    }

    if (finalAudioMixEnabled) {
      this.setDgxOwnerHeartbeatPhase(job, "final_audio_mix");
      const remuxPath = join(stageRoot, "final-audio-remux.tmp");
      rmSync(remuxPath, { force: true });
      this.appendLog(job, "Finale Tonspur wird zeitgleich an das vollständig gerenderte Video gebunden.");
      const remuxResult = await this.runLoggedProcess(
        job,
        "ffmpeg",
        buildFinalAudioRemuxArgs({
          sourceAudioPath: job.request.audio.finalMix.path,
          sourceStartTime: job.request.audio.startTime,
          sourceMaxDuration: job.request.audio.maxDuration,
          videoPath: remuxInput,
          outputPath: remuxPath,
        }),
        {
          cwd: repoRoot,
          env: { ...process.env },
        },
      );
      if (this.jobShouldStop(job)) {
        rmSync(remuxPath, { force: true });
        return;
      }
      if (remuxResult.error || remuxResult.code !== 0 || !this.fileReady(remuxPath)) {
        rmSync(remuxPath, { force: true });
        await this.failDgxJob(
          job,
          remuxResult.error?.message
            ?? `Finale Tonspur konnte nicht eingebunden werden (Code ${String(remuxResult.code)}`
              + `${remuxResult.signal ? `, ${remuxResult.signal}` : ""}).`,
          "final audio remux failed",
        );
        return;
      }
      try {
        renameSync(remuxPath, job.plan.outputPath);
      } catch (error) {
        rmSync(remuxPath, { force: true });
        await this.failDgxJob(
          job,
          `Finale Tonspur konnte nicht atomar übernommen werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "final audio artifact promotion failed",
        );
        return;
      }
      job.progress = MAX_RUNNING_PROCESS_PROGRESS;
      this.appendLog(job, "Finale Tonspur erfolgreich eingebunden; die LTX-Sprachkonditionierung bleibt unverändert belegt.");
      this.changed();
    }

    this.setDgxOwnerHeartbeatPhase(job, "final_verification");
    if (!await this.verifyJobIdentityEvidence(job, "nach der vollständigen Ausgabe")) {
      if (!this.jobShouldStop(job)) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "final identity evidence verification failed",
          last_error: job.error ?? "identity evidence verification failed",
        });
      }
      return;
    }
    if (!await this.verifyJobRunProvenance(job, "nach der vollständigen Ausgabe")) {
      if (!this.jobShouldStop(job)) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "final run provenance verification failed",
          last_error: job.error ?? "run provenance verification failed",
        });
      }
      return;
    }
    const completionMetadata: DgxTransitionMetadata = {
      current_step: "all LTX Studio processing, identity and run provenance verification completed",
      artifact: {
        type: job.request.mode === "text-to-audio" ? "audio" : "video",
        path: job.plan.outputPath,
        note: job.request.mode === "text-to-audio"
          ? "final LTX Studio text-to-audio WAV output"
          : finalAudioMixEnabled
          ? "final LTX Studio output with separately remuxed audio"
          : latentSyncEnabled
            ? "final LTX Studio output after LatentSync 1.6 refinement"
            : museTalkEnabled
              ? "final LTX Studio output after MuseTalk 1.5 frame inpainting"
              : lipForcingEnabled
                ? "final LTX Studio output after LipForcing 14B refinement"
            : hybridEnabled ? "final LTX Studio output after LongCat compositing" : "final LTX Studio output",
      },
    };
    this.prepareDgxTerminalDelivery(job, "completed", completionMetadata);
    job.status = "completed";
    job.progress = 100;
    job.outputUrl = `/api/jobs/${job.id}/output`;
    job.finishedAt = now();
    if (job.startedAt) job.runtimeMs = Date.now() - Date.parse(job.startedAt);
    this.appendLog(
      job,
      latentSyncEnabled
        ? "Video mit LatentSync-Gesichtsrefiner erfolgreich erzeugt."
        : museTalkEnabled
        ? "Video mit MuseTalk-1.5-Lippen-Inpainting erfolgreich erzeugt."
        : lipForcingEnabled
        ? "Video mit LipForcing-14B-Lippenrefiner erfolgreich erzeugt."
        : hybridEnabled
        ? "Hybridvideo erfolgreich erzeugt; LTX-Basis und LongCat-Mundspur bleiben als Zwischenstände erhalten."
        : job.request.mode === "text-to-audio"
          ? "Audio erfolgreich erzeugt."
          : "Video erfolgreich erzeugt.",
    );
    this.changed();
    await this.flushDgxTerminalDelivery(job);
  }

  private fileReady(path: string): boolean {
    try {
      const stats = statSync(path);
      return stats.isFile() && stats.size > 0;
    } catch {
      return false;
    }
  }

  private async verifyJobIdentityEvidence(job: RuntimeJob, context: string): Promise<boolean> {
    if (!job.identityEvidence) return true;
    const result = await this.identityEvidenceOperations.verify(job.identityEvidence, this.assets);
    if (this.jobShouldStop(job)) return false;
    job.identityEvidence = result.evidence;
    if (result.error) {
      this.failJob(job, `Identitätsreferenzprüfung ${context} fehlgeschlagen: ${result.error}`);
      return false;
    }
    if (job.identityEvidence.status === "verified") {
      this.appendLog(job, `Gebundene Identitätsreferenz ${context} unverändert verifiziert.`);
      this.changed();
    }
    return true;
  }

  private async verifyJobRunProvenance(job: RuntimeJob, context: string): Promise<boolean> {
    if (!job.runProvenance) {
      this.failJob(job, `Laufprovenienz ${context} fehlt.`);
      return false;
    }
    const result = await this.runProvenanceOperations.verify(job.runProvenance, job.request);
    if (this.jobShouldStop(job)) return false;
    job.runProvenance = result.evidence;
    if (result.error) {
      this.failJob(job, `Laufprovenienzprüfung ${context} fehlgeschlagen: ${result.error}`);
      return false;
    }
    this.appendLog(job, `Gebundene Laufprovenienz ${context} unverändert verifiziert.`);
    this.changed();
    return true;
  }

  private findReusableLtxBase(job: RuntimeJob): ReusableLtxBase | undefined {
    const fromHistory = [...this.jobs.values()].find((candidate) =>
      candidate.id !== job.id
      && candidate.status === "completed"
      && !candidate.request.postprocess.longcatLipsync.enabled
      && publishedOutputIsReusableLtxBase(candidate.request, job.request)
      && identityEvidenceMatches(candidate.identityEvidence, job.identityEvidence)
      && runProvenanceSharesLtxBase(candidate.runProvenance, job.runProvenance)
      && this.fileReady(candidate.plan.outputPath));
    if (fromHistory) {
      return {
        id: fromHistory.id,
        outputPath: fromHistory.plan.outputPath,
        description: `GUI-Job ${fromHistory.id}`,
      };
    }
    if (!this.reusableBaseSource) return undefined;
    // Fail-closed: unreadable sidecars only cost a regular render, never a crash.
    let candidates: readonly ReusableLtxBaseCandidate[];
    try {
      candidates = this.reusableBaseSource.reusableLtxBaseCandidates();
    } catch {
      return undefined;
    }
    return reusableLtxBaseFromSidecars(candidates, job, (path) => this.fileReady(path));
  }

  private async waitForDelay(job: RuntimeJob, delayMs: number): Promise<boolean> {
    const endAt = Date.now() + delayMs;
    while (!this.shuttingDown && isActiveJobStatus(job.status)) {
      const remaining = endAt - Date.now();
      if (remaining <= 0) return true;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(1_000, remaining)));
    }
    return false;
  }

  private async reconcilePendingDgxSubmit(
    job: RuntimeJob,
  ): Promise<QueueJobSummary | null | undefined> {
    if (!job.dgxSubmitPending) return null;
    const list = this.dgxAdmissionOperations.list;
    if (!list) {
      this.appendLog(
        job,
        "DGX-Submit-Ausgang ist unklar und kann ohne Queue-List-Operation nicht sicher abgeglichen werden.",
      );
      this.changed();
      return undefined;
    }
    const requestedBy = `ltx-studio:${job.id}`;
    const parsedStartedAt = Date.parse(job.dgxSubmitStartedAt ?? "");
    const startedAt = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
    const ambiguityDeadline = startedAt + DGX_SUBMIT_AMBIGUITY_MAX_MS;
    let lastError = "";
    while (!this.jobShouldStop(job) && job.dgxSubmitPending) {
      try {
        const queue = await list();
        if (this.jobShouldStop(job)) return undefined;
        const matches = queue.jobs.filter((candidate) => candidate.requested_by === requestedBy);
        const remote = matches.find((candidate) =>
          ["submitted", "accepted", "queued", "starting", "running", "pausing", "paused", "resuming"]
            .includes(candidate.state))
          ?? matches[0];
        if (remote) {
          if (!DGX_REMOTE_TERMINAL_STATES.has(remote.state)) job.dgxJobId = remote.job_id;
          delete job.dgxSubmitPending;
          delete job.dgxSubmitStartedAt;
          this.appendLog(
            job,
            `DGX-Submit nach unklarer Antwort autoritativ abgeglichen: ${remote.job_id} ist ${remote.state}.`,
          );
          this.changed();
          return remote;
        }
        if (Date.now() >= ambiguityDeadline) {
          delete job.dgxSubmitPending;
          delete job.dgxSubmitStartedAt;
          this.appendLog(
            job,
            "DGX-Queue bestätigt nach Ablauf des Submit-Zeitfensters, dass kein Auftrag für diesen Studio-Job existiert.",
          );
          this.changed();
          return null;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastError) {
          lastError = message;
          this.appendLog(job, `DGX-Submit-Abgleich wartet auf eine autoritative Queue-Antwort: ${message}`);
          this.changed();
        }
      }
      const remaining = Math.max(1, ambiguityDeadline - Date.now());
      if (!await this.waitForDelay(job, Math.min(DGX_SUBMIT_RECONCILE_POLL_MS, remaining))) {
        return undefined;
      }
    }
    return undefined;
  }

  private async waitForDgxQueueStart(
    job: RuntimeJob,
    estimatedMemoryGiBOverride?: number,
  ): Promise<boolean> {
    if (!await this.waitForLocalPreAdmissionResources(job)) return false;
    while (!this.shuttingDown && isActiveJobStatus(job.status)) {
      if (job.dgxSubmitPending) {
        const recovered = await this.reconcilePendingDgxSubmit(job);
        if (recovered === undefined) return false;
        if (recovered) {
          if (recovered.state === "accepted") {
            const outcome = await this.startAcceptedDgxJob(job);
            if (outcome === "started") return true;
            if (outcome === "stopped") return false;
          } else if (recovered.state === "queued") {
            const outcome = await this.waitForQueuedDgxJob(job, DGX_START_FENCE_RETRY_MS);
            if (outcome === "started") return true;
            if (outcome === "stopped") return false;
          } else {
            this.failJob(
              job,
              `Der zuvor unklare DGX-Submit ist bereits terminal: ${recovered.state}`
                + `${recovered.last_error ? ` - ${recovered.last_error}` : ""}.`,
            );
            return false;
          }
          if (!await this.waitForDelay(job, DGX_START_FENCE_RETRY_MS)) return false;
          continue;
        }
      }
      let response;
      const submitAbortController = new AbortController();
      try {
        this.appendLog(job, "DGX-Queue: Renderbedarf wird beim Orchestrator eingereicht; laufende Anwendungen werden nicht direkt beendet.");
        const estimate = estimateRequest(job.request, this.list());
        const requestedMemoryGiB = queueAdmissionMemoryGiB(
          job.request,
          estimatedMemoryGiBOverride ?? estimate.memoryGiB,
          job.id,
        );
        this.appendLog(
          job,
          `DGX-Queue: Modellbedarf ${requestedMemoryGiB} GiB RAM und `
            + `${estimate.outputGiB.toFixed(2)} GiB Ausgabe; der Orchestrator entscheidet das Start-Fence.`,
        );
        job.dgxSubmitPending = true;
        job.dgxSubmitStartedAt = now();
        job.dgxAdmissionAbortController = submitAbortController;
        this.changed();
        response = await this.dgxAdmissionOperations.submit(
          job.request,
          requestedMemoryGiB,
          job.id,
          submitAbortController.signal,
        );
        delete job.dgxAdmissionAbortController;
        delete job.dgxSubmitPending;
        delete job.dgxSubmitStartedAt;
      } catch (error) {
        delete job.dgxAdmissionAbortController;
        const message = error instanceof Error ? error.message : "DGX-Queue-Submit ist fehlgeschlagen.";
        this.appendLog(
          job,
          `DGX-Queue-Submit endete ohne autoritative Antwort; der Auftrag wird vor jedem weiteren Submit abgeglichen: ${message}`,
        );
        this.changed();
        if (this.jobShouldStop(job)) return false;
        continue;
      }

      const { admission, job: queueJob } = response;
      if (queueJob.state === "accepted" || queueJob.state === "queued") {
        job.dgxJobId = queueJob.job_id;
        this.changed();
      }
      if (this.jobShouldStop(job)) {
        if (this.shuttingDown && job.status === "queued" && job.dgxJobId) {
          const queueIndex = this.queue.indexOf(job.id);
          if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
          job.status = "interrupted";
          job.finishedAt = now();
        }
        this.prepareDgxTerminalDelivery(job, "cancelled", {
          current_step: this.shuttingDown
            ? "LTX Studio stopped while DGX queue submit was in flight"
            : "cancelled while DGX queue submit was in flight",
          last_error: this.shuttingDown
            ? "Studio shutdown won the queue submit race"
            : "manual Studio cancellation",
        });
        this.changed();
        await this.flushDgxTerminalDelivery(job);
        return false;
      }
      this.appendLog(
        job,
        `DGX-Queue: ${queueJob.job_id} ${queueJob.state}; Admission ${admission.decision}`
          + `${admission.reason ? ` - ${admission.reason}` : ""}.`,
      );
      if (queueJob.state === "accepted" && admission.decision === "accepted") {
        const outcome = await this.startAcceptedDgxJob(job);
        if (outcome === "started") return true;
        if (outcome === "stopped") return false;
        if (outcome === "queued") {
          const queuedOutcome = await this.waitForQueuedDgxJob(job, DGX_START_FENCE_RETRY_MS);
          if (queuedOutcome === "started") return true;
          if (queuedOutcome === "stopped") return false;
        }
        if (!await this.waitForDelay(job, DGX_START_FENCE_RETRY_MS)) return false;
        continue;
      }

      if (queueJob.state === "queued" || admission.decision === "queued") {
        const outcome = await this.waitForQueuedDgxJob(job, retryAfterMs(admission));
        if (outcome === "started") return true;
        if (outcome === "stopped") return false;
        if (!await this.waitForDelay(job, DGX_START_FENCE_RETRY_MS)) return false;
        continue;
      }

      if (shouldRetryQueueSubmit(admission)) {
        const delayMs = retryAfterMs(admission);
        this.appendLog(
          job,
          `DGX-Queue wartet: ${decisionMessage(admission)}. Neuer Submit in ${(delayMs / 1000).toFixed(0)} s.`,
        );
        this.changed();
        if (!await this.waitForDelay(job, delayMs)) return false;
        continue;
      }

      this.failJob(job, `DGX-Orchestrator lehnt den Start ab: ${decisionMessage(admission)}`);
      return false;
    }
    return false;
  }

  private async waitForQueuedDgxJob(job: RuntimeJob, initialDelayMs: number): Promise<DgxStartOutcome> {
    let delayMs = initialDelayMs;
    while (!this.shuttingDown && isActiveJobStatus(job.status) && job.dgxJobId) {
      this.appendLog(job, `DGX-Queue-Job wartet beim Orchestrator; nächste Prüfung in ${(delayMs / 1000).toFixed(0)} s.`);
      this.changed();
      if (!await this.waitForDelay(job, delayMs)) return "stopped";
      let response;
      try {
        response = await this.dgxQueueOperations.read(job.dgxJobId);
      } catch (error) {
        if (this.jobShouldStop(job)) return "stopped";
        const message = error instanceof Error ? error.message : "DGX-Queue-Status konnte nicht gelesen werden.";
        this.appendLog(job, `DGX-Queue-Status vorübergehend nicht lesbar: ${message}. Prüfung wird wiederholt.`);
        this.changed();
        delayMs = 30_000;
        continue;
      }
      const queueJob = response.job;
      this.appendLog(job, `DGX-Queue-Status: ${queueJob.job_id} ${queueJob.state}${queueJob.reason ? ` - ${queueJob.reason}` : ""}.`);
      if (queueJob.state === "accepted") {
        const outcome = await this.startAcceptedDgxJob(job);
        if (outcome === "queued") {
          delayMs = DGX_START_FENCE_RETRY_MS;
          continue;
        }
        return outcome;
      }
      if (queueJob.state === "queued") {
        delayMs = 30_000;
        continue;
      }
      if (queueJob.state === "cancelled") {
        job.dgxJobTerminal = true;
        this.resetDgxLeaseForResubmit(job, `Remote-Job ${queueJob.job_id} wurde vor dem Start abgebrochen.`);
        return "resubmit";
      }
      if (["completed", "failed", "rejected"].includes(queueJob.state)) {
        job.dgxJobTerminal = true;
        this.failJob(job, `DGX-Queue-Job ist terminal: ${queueJob.state}${queueJob.last_error ? ` - ${queueJob.last_error}` : ""}`);
        return "stopped";
      }
      delayMs = 30_000;
    }
    return "stopped";
  }

  private async startAcceptedDgxJob(job: RuntimeJob): Promise<DgxStartOutcome> {
    const snapshot = this.readStartResourceSnapshot();
    this.appendLog(
      job,
      `DGX-Admission ist akzeptiert; Start-Fence wird jetzt autoritativ beim Orchestrator geprüft. `
        + `Lokale Messung: ${snapshot.availableMemoryGiB?.toFixed(2) ?? "unbekannt"} GiB RAM, `
        + `${snapshot.swapFreeGiB?.toFixed(2) ?? "unbekannt"} GiB Swap und `
        + `${snapshot.outputFreeGiB?.toFixed(2) ?? "unbekannt"} GiB Ausgabeplatz frei.`,
    );
    this.changed();
    const started = await this.transitionDgxJob(job, "starting", {
      current_step: "thermal start gate before LTX allocation",
    });
    if (started) return isActiveJobStatus(job.status) ? "started" : "stopped";
    if (this.jobShouldStop(job)) return "stopped";
    const message = "DGX-Queue-Start-Fence wurde nicht freigegeben.";
    this.prepareDgxTerminalDelivery(job, "cancelled", {
      current_step: "starting transition failed before LTX allocation",
      last_error: message,
    });
    this.failJob(job, message);
    await this.flushDgxTerminalDelivery(job);
    return "stopped";
  }

  private resetDgxLeaseForResubmit(job: RuntimeJob, detail: string): void {
    if (job.dgxTerminalRetry) clearTimeout(job.dgxTerminalRetry);
    delete job.dgxTerminalRetry;
    delete job.dgxTerminalDelivery;
    job.dgxJobId = null;
    job.dgxJobTerminal = false;
    this.appendLog(job, `${detail} Der Renderbedarf wird erneut beim Orchestrator eingereicht.`);
    this.changed();
  }

  private readStartResourceSnapshot(): ResourceSnapshot {
    return readResourceSnapshot();
  }

  private async waitForLocalPreAdmissionResources(job: RuntimeJob): Promise<boolean> {
    const estimate = estimateRequest(job.request, this.list());
    const requirements = {
      outputGiB: estimate.outputGiB,
    };
    let lastIssue: string | null = null;
    let lastLogAt = 0;

    while (!this.shuttingDown && isActiveJobStatus(job.status)) {
      const snapshot = this.readStartResourceSnapshot();
      const issue = validatePreAdmissionResources(snapshot, requirements);
      if (issue === null) {
        this.appendLog(
          job,
          `Lokales Queue-Vorab-Gate erfüllt: ${snapshot.outputFreeGiB?.toFixed(2)} GiB Ausgabeplatz frei; `
            + "RAM, Swap, Reservierungen und zulässiger Reclaim werden vom DGX-Orchestrator entschieden.",
        );
        this.changed();
        return true;
      }
      const currentTime = Date.now();
      if (issue !== lastIssue || currentTime - lastLogAt >= RESOURCE_WAIT_LOG_INTERVAL_MS) {
        this.appendLog(job, `Lokale Ausgabeplatz-Prüfung wartet: ${issue}`);
        this.changed();
        lastIssue = issue;
        lastLogAt = currentTime;
      }
      if (!await this.waitForDelay(job, RESOURCE_RETRY_INTERVAL_MS)) return false;
    }
    return false;
  }

  private async transitionDgxJob(
    job: RuntimeJob,
    state: QueueTransitionState,
    metadata: DgxTransitionMetadata = {},
  ): Promise<boolean> {
    if (!job.dgxJobId || job.dgxJobTerminal) return true;
    if (DGX_TERMINAL_STATES.has(state as DgxTerminalState)) {
      this.prepareDgxTerminalDelivery(job, state as DgxTerminalState, metadata);
      this.changed();
      const delivered = await this.flushDgxTerminalDelivery(job);
      return delivered || Boolean(job.dgxTerminalDelivery);
    }
    if (state === "paused") await this.stopDgxOwnerHeartbeat(job);
    if (job.dgxStateTransitionInFlight) return job.dgxStateTransitionInFlight;
    const transitionPromise = (async () => {
      while (!this.shuttingDown && isActiveJobStatus(job.status)) {
        try {
          const response = await this.dgxQueueOperations.transition(job.dgxJobId!, state, metadata);
          this.appendLog(job, `DGX-Queue-State: ${response.job.job_id} -> ${response.job.state}.`);
          if (state === "starting" || state === "running" || state === "pausing" || state === "resuming") {
            this.startDgxOwnerHeartbeat(job, state === "running" ? "ltx_rendering" : state);
          }
          this.changed();
          return true;
        } catch (error) {
          const startFenceState = state === "starting" || state === "resuming" ? state : null;
          const retryDelayMs = startFenceState
            ? retryableStartFenceDelayMs(error)
            : null;
          if (retryDelayMs === null || startFenceState === null) {
            this.appendLog(
              job,
              `DGX-Queue-State konnte nicht auf ${state} gesetzt werden: ${error instanceof Error ? error.message : String(error)}`,
            );
            this.changed();
            return false;
          }
          const reconciled = await this.reconcileRetryableStartFence(
            job,
            error,
            retryDelayMs,
            startFenceState,
          );
          if (reconciled === "applied") return true;
          if (reconciled === "failed") return false;
        }
      }
      return false;
    })();
    job.dgxStateTransitionInFlight = transitionPromise;
    try {
      return await transitionPromise;
    } finally {
      if (job.dgxStateTransitionInFlight === transitionPromise) {
        delete job.dgxStateTransitionInFlight;
      }
    }
  }

  private async reconcileRetryableStartFence(
    job: RuntimeJob,
    transitionError: unknown,
    retryDelayMs: number,
    targetState: "starting" | "resuming",
  ): Promise<"applied" | "retry" | "failed"> {
    const detail = transitionError instanceof Error
      ? transitionError.message
      : String(transitionError);
    while (!this.shuttingDown && isActiveJobStatus(job.status) && job.dgxJobId) {
      let remote;
      try {
        remote = (await this.dgxQueueOperations.read(job.dgxJobId)).job;
      } catch (error) {
        this.appendLog(
          job,
          `DGX-Start-Fence antwortete nicht (${detail}); der Queue-State ist vorübergehend nicht lesbar: ${
            error instanceof Error ? error.message : String(error)
          }. Nächste Prüfung in ${(retryDelayMs / 1000).toFixed(0)} s.`,
        );
        this.changed();
        if (!await this.waitForDelay(job, retryDelayMs)) return "failed";
        continue;
      }
      if (remote.state === targetState || remote.state === "running") {
        this.appendLog(
          job,
          `DGX-Start-Fence per GET abgeglichen: ${remote.job_id} ist bereits ${remote.state}.`,
        );
        this.startDgxOwnerHeartbeat(job, remote.state === "running" ? "ltx_rendering" : "starting");
        this.changed();
        return "applied";
      }
      if (targetState === "starting" && remote.state === "accepted") {
        this.appendLog(
          job,
          `DGX-Start-Fence wartet beim Orchestrator (${detail}); Queue-Job bleibt accepted. `
            + `Neuer Versuch in ${(retryDelayMs / 1000).toFixed(0)} s.`,
        );
        this.changed();
        if (!await this.waitForDelay(job, retryDelayMs)) return "failed";
        return "retry";
      }
      if (targetState === "starting" && remote.state === "queued") {
        this.appendLog(
          job,
          `DGX-Start-Fence wartet mit Queue-Job ${remote.job_id} auf seine Auswahl; `
            + `neuer Versuch in ${(retryDelayMs / 1000).toFixed(0)} s.`,
        );
        this.changed();
        if (!await this.waitForDelay(job, retryDelayMs)) return "failed";
        return "retry";
      }
      if (targetState === "resuming" && remote.state === "paused") {
        this.appendLog(
          job,
          `DGX-Resume-Fence wartet beim Orchestrator (${detail}); Queue-Job bleibt ressourcenfrei pausiert. `
            + `Neuer Versuch in ${(retryDelayMs / 1000).toFixed(0)} s.`,
        );
        this.changed();
        if (!await this.waitForDelay(job, retryDelayMs)) return "failed";
        return "retry";
      }
      this.appendLog(
        job,
        `DGX-Start-Fence kann nicht fortgesetzt werden: ${remote.job_id} ist ${remote.state}.`,
      );
      this.changed();
      return "failed";
    }
    return "failed";
  }

  private prepareDgxTerminalDelivery(
    job: RuntimeJob,
    state: DgxTerminalState,
    metadata: DgxTransitionMetadata,
  ): void {
    if (!job.dgxJobId || job.dgxJobTerminal) return;
    if (job.dgxTerminalDelivery && job.dgxTerminalDelivery.state !== state) {
      this.appendLog(
        job,
        `DGX-Terminalzustand ${job.dgxTerminalDelivery.state} ist bereits zur Zustellung vorgemerkt; ${state} wird nicht darübergeschrieben.`,
      );
      return;
    }
    job.dgxTerminalDelivery = {
      state,
      metadata: {
        ...job.dgxTerminalDelivery?.metadata,
        ...metadata,
      },
      attempts: job.dgxTerminalDelivery?.attempts ?? 0,
      lastError: job.dgxTerminalDelivery?.lastError ?? null,
      updatedAt: now(),
    };
  }

  private async flushDgxTerminalDelivery(job: RuntimeJob): Promise<boolean> {
    if (!job.dgxJobId || job.dgxJobTerminal || !job.dgxTerminalDelivery) return true;
    if (job.localProcessGroupPending) return false;
    if (job.dgxTerminalDeliveryInFlight) return job.dgxTerminalDeliveryInFlight;
    if (job.dgxStateTransitionInFlight) await job.dgxStateTransitionInFlight;
    await this.stopDgxOwnerHeartbeat(job);
    if (!job.dgxJobId || job.dgxJobTerminal || !job.dgxTerminalDelivery) return true;
    if (job.dgxTerminalRetry) {
      clearTimeout(job.dgxTerminalRetry);
      delete job.dgxTerminalRetry;
    }
    const deliveryPromise = this.attemptDgxTerminalDelivery(job);
    job.dgxTerminalDeliveryInFlight = deliveryPromise;
    try {
      return await deliveryPromise;
    } finally {
      if (job.dgxTerminalDeliveryInFlight === deliveryPromise) {
        delete job.dgxTerminalDeliveryInFlight;
      }
    }
  }

  private async attemptDgxTerminalDelivery(job: RuntimeJob): Promise<boolean> {
    const delivery = job.dgxTerminalDelivery;
    const jobId = job.dgxJobId;
    if (!delivery || !jobId) return true;
    delivery.attempts += 1;
    delivery.updatedAt = now();
    this.changed();
    try {
      let transitionState: DgxTerminalState = delivery.state;
      let transitionMetadata = delivery.metadata;
      if (delivery.state === "cancelled") {
        const current = await this.dgxQueueOperations.read(jobId);
        if (current.job.state === "cancelled") {
          this.confirmDgxTerminalDelivery(job, "cancelled", "vor PATCH per GET bestätigt");
          return true;
        }
        if (DGX_REMOTE_TERMINAL_STATES.has(current.job.state)) {
          job.dgxJobTerminal = true;
          delete job.dgxTerminalDelivery;
          this.appendLog(
            job,
            `DGX-Terminalabweichung: lokal war cancelled vorgemerkt, der Orchestrator meldet ${current.job.state}.`,
          );
          this.changed();
          return false;
        }
        if (["starting", "pausing", "resuming"].includes(current.job.state)) {
          transitionState = "failed";
          transitionMetadata = {
            ...delivery.metadata,
            current_step: "cancelled locally before compute launch completed",
            last_error: delivery.metadata.last_error ?? "LTX Studio cancellation won a queue transition race",
          };
        }
      }
      const response = await this.dgxQueueOperations.transition(jobId, transitionState, transitionMetadata);
      if (response.job.state !== transitionState) {
        throw new Error(`DGX Runtime API bestätigte ${response.job.state} statt ${transitionState}.`);
      }
      const detail = transitionState === delivery.state
        ? "PATCH bestätigt"
        : `lokaler Abbruch regelkonform als ${transitionState} abgeschlossen`;
      this.confirmDgxTerminalDelivery(job, response.job.state as DgxTerminalState, detail);
      return true;
    } catch (transitionError) {
      const transitionMessage = transitionError instanceof Error ? transitionError.message : String(transitionError);
      try {
        const response = await this.dgxQueueOperations.read(jobId);
        if (response.job.state === delivery.state) {
          this.confirmDgxTerminalDelivery(job, response.job.state, "nach verlorener PATCH-Antwort per GET abgeglichen");
          return true;
        }
        if (DGX_REMOTE_TERMINAL_STATES.has(response.job.state)) {
          job.dgxJobTerminal = true;
          delete job.dgxTerminalDelivery;
          this.appendLog(
            job,
            `DGX-Terminalabweichung: lokal war ${delivery.state} vorgemerkt, der Orchestrator meldet ${response.job.state}.`,
          );
          this.changed();
          return false;
        }
        this.deferDgxTerminalDelivery(
          job,
          `${transitionMessage}; Remote-Zustand nach Abgleich: ${response.job.state}`,
        );
        return false;
      } catch (readError) {
        const readMessage = readError instanceof Error ? readError.message : String(readError);
        this.deferDgxTerminalDelivery(job, `${transitionMessage}; Statusabgleich fehlgeschlagen: ${readMessage}`);
        return false;
      }
    }
  }

  private confirmDgxTerminalDelivery(
    job: RuntimeJob,
    state: DgxTerminalState,
    detail: string,
  ): void {
    if (job.dgxTerminalRetry) clearTimeout(job.dgxTerminalRetry);
    delete job.dgxTerminalRetry;
    delete job.dgxTerminalDelivery;
    job.dgxJobTerminal = true;
    this.appendLog(job, `DGX-Queue-State: ${job.dgxJobId} -> ${state} (${detail}).`);
    this.changed();
  }

  private deferDgxTerminalDelivery(job: RuntimeJob, error: string): void {
    if (!job.dgxTerminalDelivery) return;
    job.dgxTerminalDelivery.lastError = error;
    job.dgxTerminalDelivery.updatedAt = now();
    this.appendLog(
      job,
      `DGX-Terminalmeldung ${job.dgxTerminalDelivery.state} noch nicht bestätigt; Zustellung bleibt vorgemerkt: ${error}`,
    );
    this.changed();
    this.scheduleDgxTerminalRetry(job);
  }

  private scheduleDgxTerminalRetry(job: RuntimeJob, delayOverrideMs?: number): void {
    if (
      this.shuttingDown
      || this.dgxTerminalRetryBaseMs === null
      || !job.dgxTerminalDelivery
      || job.dgxJobTerminal
      || job.dgxTerminalRetry
      || job.localProcessGroupPending
    ) {
      return;
    }
    const exponentialDelay = Math.min(
      MAX_DGX_TERMINAL_RETRY_MS,
      this.dgxTerminalRetryBaseMs * 2 ** Math.min(6, job.dgxTerminalDelivery.attempts),
    );
    const delayMs = delayOverrideMs ?? exponentialDelay;
    job.dgxTerminalRetry = setTimeout(() => {
      delete job.dgxTerminalRetry;
      void this.flushDgxTerminalDelivery(job);
    }, delayMs);
    job.dgxTerminalRetry.unref();
  }

  private failJob(job: RuntimeJob, message: string): void {
    this.prepareDgxTerminalDelivery(job, "failed", {
      current_step: "LTX Studio job failed",
      last_error: message,
    });
    job.status = "failed";
    job.error = message;
    job.finishedAt = now();
    if (job.startedAt) job.runtimeMs = Date.now() - Date.parse(job.startedAt);
    this.appendLog(job, message);
    this.changed();
    this.scheduleDgxTerminalRetry(job, 0);
  }

  private async failDgxJob(job: RuntimeJob, message: string, currentStep: string): Promise<void> {
    this.prepareDgxTerminalDelivery(job, "failed", {
      current_step: currentStep,
      last_error: message,
    });
    this.failJob(job, message);
    await this.flushDgxTerminalDelivery(job);
  }

  private startDgxOwnerHeartbeat(job: RuntimeJob, phase: string): void {
    if (!job.dgxJobId || job.dgxJobTerminal || !this.dgxQueueOperations.heartbeat) return;
    const existing = job.dgxOwnerHeartbeat;
    if (existing?.jobId === job.dgxJobId && !existing.stopped) {
      existing.phase = phase;
      return;
    }
    if (existing) {
      existing.stopped = true;
      if (existing.timer) clearInterval(existing.timer);
    }

    const state: DgxOwnerHeartbeatState = {
      jobId: job.dgxJobId,
      phase,
      progressEpoch: 0,
      acknowledgedProgressEpoch: 0,
      stopped: false,
    };
    state.timer = setInterval(() => {
      void this.sendDgxOwnerHeartbeat(job, state);
    }, DGX_OWNER_HEARTBEAT_INTERVAL_MS);
    state.timer.unref();
    job.dgxOwnerHeartbeat = state;
    void this.sendDgxOwnerHeartbeat(job, state);
  }

  private async sendDgxOwnerHeartbeat(
    job: RuntimeJob,
    state: DgxOwnerHeartbeatState,
  ): Promise<void> {
    if (
      state.stopped
      || job.dgxOwnerHeartbeat !== state
      || job.dgxJobId !== state.jobId
      || job.dgxJobTerminal
      || state.inFlight
      || !this.dgxQueueOperations.heartbeat
    ) return;

    const sentProgressEpoch = state.progressEpoch;
    const payload: QueueHeartbeatPayload = {
      runtime_status: { phase: state.phase },
      ...(sentProgressEpoch > state.acknowledgedProgressEpoch ? { progressed: true as const } : {}),
    };
    const request = (async () => {
      try {
        await this.dgxQueueOperations.heartbeat!(state.jobId, payload);
        if (state.stopped || job.dgxOwnerHeartbeat !== state) return;
        state.acknowledgedProgressEpoch = Math.max(
          state.acknowledgedProgressEpoch,
          sentProgressEpoch,
        );
        if (state.lastError) {
          this.appendLog(job, "DGX-Owner-Heartbeat ist wieder erreichbar.");
          delete state.lastError;
          this.changed();
        }
      } catch (error) {
        if (state.stopped || job.dgxOwnerHeartbeat !== state) return;
        const message = error instanceof Error ? error.message : String(error);
        if (message !== state.lastError) {
          state.lastError = message;
          this.appendLog(job, `DGX-Owner-Heartbeat vorübergehend fehlgeschlagen: ${message}`);
          this.changed();
        }
      }
    })();
    state.inFlight = request;
    try {
      await request;
    } finally {
      if (state.inFlight === request) delete state.inFlight;
    }
  }

  private markDgxOwnerProgress(job: RuntimeJob): void {
    if (job.dgxOwnerHeartbeat && !job.dgxOwnerHeartbeat.stopped) {
      job.dgxOwnerHeartbeat.progressEpoch += 1;
    }
  }

  private setDgxOwnerHeartbeatPhase(job: RuntimeJob, phase: string): void {
    if (job.dgxOwnerHeartbeat && !job.dgxOwnerHeartbeat.stopped) {
      job.dgxOwnerHeartbeat.phase = phase;
    }
  }

  private async stopDgxOwnerHeartbeat(job: RuntimeJob): Promise<void> {
    const state = job.dgxOwnerHeartbeat;
    if (!state) return;
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    delete job.dgxOwnerHeartbeat;
    await state.inFlight;
  }

  private consumeProcessLogs(
    job: RuntimeJob,
    child: ChildProcess,
    progressTracker: PipelineProgressTracker | null = null,
  ): void {
    const buffers = { stdout: "", stderr: "" };
    const consumeRecords = (records: string[]): boolean => {
      let changed = false;
      for (const rawLine of records) {
        const line = cleanLogLine(rawLine);
        if (!line) continue;
        this.appendLog(job, line);
        const previousProgress = job.progress ?? 0;
        const eulerStep = progressTracker?.isDenoising() === true
          && progressFromPipelineLog(line) !== null;
        const progress = progressTracker?.update(line) ?? null;
        if (progress !== null) {
          job.progress = Math.max(previousProgress, progress);
          if (eulerStep && progress > previousProgress) this.markDgxOwnerProgress(job);
        }
        changed = true;
      }
      return changed;
    };
    const consume = (stream: keyof typeof buffers) => (chunk: Buffer) => {
      const framed = frameProcessLogChunk(buffers[stream], chunk.toString("utf8"));
      buffers[stream] = framed.rest;
      if (consumeRecords(framed.records)) this.changed();
    };
    child.stdout?.on("data", consume("stdout"));
    child.stderr?.on("data", consume("stderr"));
    child.once("close", () => {
      const stdout = frameProcessLogChunk(buffers.stdout, "", true);
      const stderr = frameProcessLogChunk(buffers.stderr, "", true);
      buffers.stdout = "";
      buffers.stderr = "";
      if (consumeRecords([...stdout.records, ...stderr.records])) this.changed();
    });
  }

  private waitForProcess(child: ChildProcess): Promise<ProcessResult> {
    return new Promise((resolvePromise) => {
      let settled = false;
      const finish = (result: ProcessResult) => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };
      child.once("error", (error) => finish({ code: null, signal: null, error }));
      child.once("close", (code, signal) => finish({ code, signal, error: null }));
    });
  }

  private watchSegmentBoundaries(
    job: RuntimeJob,
    checkpointRoot: string,
    fingerprint: string,
    generation: number,
  ): { stop: () => Promise<void>; yieldDecisionId: () => string | null } {
    const readyPath = join(checkpointRoot, "boundary-ready.json");
    const decisionPath = join(checkpointRoot, "boundary-decision.json");
    rmSync(readyPath, { force: true });
    rmSync(decisionPath, { force: true });
    let lastBoundaryId: string | null = null;
    let currentYieldDecisionId: string | null = null;
    let stopped = false;
    let pollInFlight: Promise<void> | null = null;

    const poll = async (): Promise<void> => {
      const child = job.process;
      if (stopped || !child || !processIsAlive(child)) return;
      const ready = readJsonObject(readyPath);
      if (!ready) return;
      if (
        ready.schema_version !== "ltx-segment-boundary-ready.v1"
        || ready.job_fingerprint !== fingerprint
        || ready.dgx_job_id !== job.dgxJobId
        || ready.generation !== generation
        || typeof ready.boundary_id !== "string"
        || !ready.boundary_id
        || !Number.isInteger(ready.loop_index)
        || (ready.loop_index as number) < 0
        || !Number.isInteger(ready.next_step_index)
        || (ready.next_step_index as number) < 0
      ) {
        process.stderr.write("LTX Studio Segmentgrenzen-Wächter: ungültiges oder veraltetes boundary-ready verworfen.\n");
        return;
      }
      if (ready.boundary_id === lastBoundaryId || existsSync(decisionPath)) return;
      lastBoundaryId = ready.boundary_id;

      const decisionId = randomUUID();
      let decision: SegmentBoundaryDecision;
      try {
        if (!job.dgxJobId) throw new Error("DGX-Job-ID fehlt an der Segmentgrenze");
        decision = await this.dgxSchedulerOperations.decide(job.dgxJobId);
        if (!job.dgxJobId || decision.current_job_id !== job.dgxJobId) {
          throw new Error("Segmententscheidung gehört nicht zum laufenden DGX-Job");
        }
      } catch (error) {
        process.stderr.write(`LTX Studio Segmentgrenzen-Wächter (fail-closed): ${String(error)}\n`);
        decision = {
          action: "yield_to_waiting_job",
          current_job_id: job.dgxJobId ?? "missing",
          next_job_id: null,
          reason: "scheduler_unavailable_fail_closed",
          retry_after_seconds: 5,
        };
      }
      if (stopped || !processIsAlive(child)) return;
      const action = decision.action === "continue_current"
        ? "continue_current"
        : "yield_to_waiting_job";
      let reason = action === decision.action
        ? decision.reason
        : `invalid_running_action_${decision.action}`;
      if (action === "yield_to_waiting_job") {
        const pausing = await this.transitionDgxJob(job, "pausing", {
          current_step: `yield selected at LTX Euler boundary ${ready.boundary_id}`,
        });
        if (!pausing) reason = `${reason}:pausing_transition_failed_fail_closed`;
      }
      if (stopped || !processIsAlive(child)) return;
      atomicJsonFile(decisionPath, {
        schema_version: "ltx-segment-boundary-decision.v1",
        job_fingerprint: fingerprint,
        dgx_job_id: job.dgxJobId,
        generation,
        boundary_id: ready.boundary_id,
        decision_id: decisionId,
        action,
        reason,
        next_job_id: decision.next_job_id,
        decided_at: now(),
      });
      if (action === "yield_to_waiting_job") {
        currentYieldDecisionId = decisionId;
        this.appendLog(
          job,
          `Orchestrator fordert an Euler-Grenze ${ready.boundary_id} einen kooperativen Yield an (${reason}).`,
        );
        this.changed();
      }
    };
    const startPoll = (): void => {
      if (pollInFlight || stopped) return;
      pollInFlight = poll().finally(() => {
        pollInFlight = null;
      });
    };
    startPoll();
    const timer = setInterval(startPoll, SEGMENT_BOUNDARY_FILE_POLL_MS);
    timer.unref();

    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await pollInFlight;
      },
      yieldDecisionId: () => currentYieldDecisionId,
    };
  }

  private validateCooperativeCheckpoint(
    job: RuntimeJob,
    manifestPath: string,
    expectedRequestId: string | null,
  ): QueueArtifact | null {
    const manifest = readJsonObject(manifestPath);
    const fingerprint = job.runProvenance?.fingerprint;
    if (
      !manifest
      || manifest.schema_version !== "ltx-cooperative-checkpoint.v1"
      || manifest.job_fingerprint !== fingerprint
      || typeof manifest.request_id !== "string"
      || (expectedRequestId !== null && manifest.request_id !== expectedRequestId)
      || manifest.state_file !== "state.pt"
      || typeof manifest.loop_index !== "number"
      || typeof manifest.next_step_index !== "number"
    ) {
      return null;
    }
    const statePath = join(dirname(manifestPath), "state.pt");
    if (!this.fileReady(statePath)) return null;
    return {
      type: "ltx-cooperative-checkpoint",
      path: manifestPath,
      size_bytes: statSync(manifestPath).size + statSync(statePath).size,
      note: `Euler loop ${String(manifest.loop_index)}, next diffusion step ${String(manifest.next_step_index)}`,
    };
  }

  private async waitForSchedulerResume(job: RuntimeJob): Promise<boolean> {
    let lastDisposition: string | null = null;
    while (!this.shuttingDown && isActiveJobStatus(job.status)) {
      let delayMs = SEGMENT_BOUNDARY_PAUSED_POLL_MS;
      let disposition = "scheduler_unavailable";
      try {
        if (!job.dgxJobId) throw new Error("DGX-Job-ID fehlt während der Pause");
        const decision = await this.dgxSchedulerOperations.decide(job.dgxJobId);
        disposition = decision.action;
        delayMs = Math.max(SEGMENT_BOUNDARY_PAUSED_POLL_MS, decision.retry_after_seconds * 1_000);
        if (decision.action === "resume_current") return true;
        if (decision.action !== "wait_for_successor") {
          disposition = `invalid_paused_action_${decision.action}`;
        } else if (decision.next_job_id) {
          disposition = `wait_for_${decision.next_job_id}`;
        }
      } catch (error) {
        disposition = `scheduler_unavailable:${error instanceof Error ? error.message : String(error)}`;
      }
      if (disposition !== lastDisposition) {
        this.appendLog(
          job,
          `LTX bleibt fail-closed ressourcenfrei pausiert (${disposition}).`,
        );
        this.changed();
        lastDisposition = disposition;
      }
      if (!await this.waitForDelay(job, delayMs)) return false;
    }
    return false;
  }

  private async pauseAndResumeDgxSlice(
    job: RuntimeJob,
    artifact: QueueArtifact,
  ): Promise<boolean> {
    const pausedJobId = job.dgxJobId;
    if (!pausedJobId) {
      this.failJob(job, "LTX-Checkpoint wurde geschrieben, aber die zugehörige DGX-Zuteilung fehlt.");
      return false;
    }
    this.setDgxOwnerHeartbeatPhase(job, "checkpoint_committed");
    if (!await this.transitionDgxJob(job, "pausing", {
      current_step: "LTX Euler checkpoint committed; process exited before resource release",
      artifact,
    })) {
      this.failJob(job, "DGX-Queue konnte den LTX-Slice nicht auf pausing setzen.");
      return false;
    }
    if (!await this.transitionDgxJob(job, "paused", {
      current_step: "LTX process exited and cooperative checkpoint is durable",
      artifact,
    })) {
      this.failJob(job, "DGX-Queue konnte die bestätigte ressourcenfreie LTX-Pause nicht speichern.");
      return false;
    }

    job.status = "paused";
    this.appendLog(
      job,
      `LTX-Slice ${pausedJobId} ist ressourcenfrei pausiert; der Orchestrator wählt den Nachfolger.`,
    );
    this.changed();
    if (!await this.waitForSchedulerResume(job)) return false;

    while (!this.shuttingDown && isActiveJobStatus(job.status)) {
      if (await this.transitionDgxJob(job, "resuming", {
        current_step: "fresh start gate before resuming durable LTX checkpoint",
        artifact,
      })) break;
      if (this.jobShouldStop(job)) return false;
      if (!await this.waitForDelay(job, DGX_START_FENCE_RETRY_MS)) return false;
    }
    if (!isActiveJobStatus(job.status)) return false;

    this.appendLog(job, `LTX-Resume bleibt an dieselbe DGX-Zuteilung ${pausedJobId} gebunden.`);
    this.changed();
    return true;
  }

  private async runLoggedProcess(
    job: RuntimeJob,
    executable: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ): Promise<ProcessResult> {
    const child = spawn(executable, args, {
      ...options,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    await this.markProcessStarted(job, child);
    this.consumeProcessLogs(job, child);
    const result = await this.waitForProcess(child);
    await this.confirmProcessGroupGone(job, child);
    return result;
  }

  private async readThermalBaseline(job: RuntimeJob): Promise<number | null> {
    const maxC = await readMedianMaxTemperatureC({
      samples: thermalStartSamples,
      intervalMs: thermalStartSampleIntervalMs,
    });
    if (this.jobShouldStop(job)) return null;
    if (maxC !== null && maxC < thermalPauseC) {
      const resumeBelowC = Math.min(maxC + 0.1, thermalPauseC - 0.1);
      job.thermalProfile = {
        baselineC: maxC,
        currentC: maxC,
        peakC: maxC,
        riseC: 0,
        pauseAtC: thermalPauseC,
        resumeBelowC,
        updatedAt: now(),
      };
      this.appendLog(
        job,
        `Thermal-Basiswert: ${maxC.toFixed(1)} °C Host-Maximum. LTX-spezifischer Lastanstieg wird für diesen Lauf protokolliert.`,
      );
      return maxC;
    }
    const error = maxC === null
      ? "Temperatur ist nicht messbar; LTX-Start aus Sicherheitsgründen blockiert."
      : `Host bereits bei ${maxC.toFixed(1)} °C; kein LTX-Start an oder über der Hardware-Pausenschwelle von ${thermalPauseC.toFixed(0)} °C.`;
    this.failJob(job, error);
    return null;
  }

  private watchThermals(job: RuntimeJob, child: ChildProcess, baselineC: number): () => void {
    const resumeBelowC = Math.min(baselineC + 0.1, thermalPauseC - 0.1);
    let peakC = baselineC;
    const guard = new ThermalPauseGuard({
      pauseAtC: thermalPauseC,
      pausePolls: thermalPausePolls,
      resumeBelowC,
      resumePolls: thermalResumePolls,
      unreadablePolls: thermalUnreadablePolls,
    });
    const timer = setInterval(() => {
      if (!processIsAlive(child) || !["running", "paused"].includes(job.status)) return;
      try {
        const temperatureC = readMaxTemperatureC();
        if (temperatureC !== null) peakC = Math.max(peakC, temperatureC);
        if (job.thermalProfile) {
          job.thermalProfile = {
            ...job.thermalProfile,
            currentC: temperatureC,
            peakC,
            riseC: peakC - baselineC,
            updatedAt: now(),
          };
        }
        const action = guard.observe(temperatureC, job.status === "paused");
        if (action === "pause_hot" || action === "pause_unreadable") {
          if (!signalProcessGroup(child, "SIGSTOP")) return;
          job.status = "paused";
          this.setDgxOwnerHeartbeatPhase(job, "thermal_pause");
          const reason = action === "pause_hot"
            ? `${temperatureC?.toFixed(1)} °C über ${thermalPausePolls} Messungen`
            : `${thermalUnreadablePolls} Temperaturmessungen ohne verwertbaren Sensorwert`;
          this.appendLog(
            job,
            `Thermalpause: ${reason}. Der LTX-Prozesszustand bleibt erhalten und wird nach Abkühlung fortgesetzt.`,
          );
          this.changed();
          return;
        }
        if (action === "resume") {
          if (!signalProcessGroup(child, "SIGCONT")) return;
          job.status = "running";
          this.setDgxOwnerHeartbeatPhase(job, "ltx_rendering");
          this.appendLog(
            job,
            `Thermalpause beendet: ${temperatureC?.toFixed(1)} °C über ${thermalResumePolls} Messungen unter dem Lauf-Basiswert ${baselineC.toFixed(1)} °C. LTX läuft ohne Neustart weiter.`,
          );
          this.changed();
          return;
        }
        this.changed();
      } catch (error) {
        process.stderr.write(`LTX Studio Thermal-Wächter: ${String(error)}\n`);
      }
    }, thermalPollIntervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
      if (job.thermalProfile) {
        job.thermalProfile = {
          ...job.thermalProfile,
          currentC: null,
          peakC,
          riseC: peakC - baselineC,
          updatedAt: now(),
        };
      }
      this.appendLog(
        job,
        `Thermalprofil (gesamter Host): Basis ${baselineC.toFixed(1)} °C, Peak ${peakC.toFixed(1)} °C, beobachteter Anstieg ${(peakC - baselineC).toFixed(1)} °C.`,
      );
    };
  }

  private watchOwnedDockerThermals(
    job: RuntimeJob,
    child: ChildProcess,
    baselineC: number,
    containerName: string,
  ): () => void {
    const resumeBelowC = Math.min(baselineC + 0.1, thermalPauseC - 0.1);
    let peakC = baselineC;
    const guard = new ThermalPauseGuard({
      pauseAtC: thermalPauseC,
      pausePolls: thermalPausePolls,
      resumeBelowC,
      resumePolls: thermalResumePolls,
      unreadablePolls: thermalUnreadablePolls,
    });
    const dockerAction = (action: "pause" | "unpause"): boolean => {
      const result = spawnSync("docker", [action, containerName], {
        encoding: "utf8",
        shell: false,
        timeout: 20_000,
      });
      if (result.status === 0 && !result.error) return true;
      const detail = result.error?.message || result.stderr.trim() || `Exit ${String(result.status)}`;
      this.appendLog(
        job,
        `LatentSync-Thermalschutz konnte den eigenen Container nicht mit docker ${action} steuern: ${detail}`,
      );
      signalProcessGroup(child, "SIGTERM");
      this.changed();
      return false;
    };
    const timer = setInterval(() => {
      if (!processIsAlive(child) || !["running", "paused"].includes(job.status)) return;
      try {
        const temperatureC = readMaxTemperatureC();
        if (temperatureC !== null) peakC = Math.max(peakC, temperatureC);
        if (job.thermalProfile) {
          job.thermalProfile = {
            ...job.thermalProfile,
            currentC: temperatureC,
            peakC,
            riseC: peakC - baselineC,
            updatedAt: now(),
          };
        }
        const action = guard.observe(temperatureC, job.status === "paused");
        if (action === "pause_hot" || action === "pause_unreadable") {
          if (!dockerAction("pause")) return;
          job.status = "paused";
          this.setDgxOwnerHeartbeatPhase(job, "thermal_pause");
          const reason = action === "pause_hot"
            ? `${temperatureC?.toFixed(1)} °C über ${thermalPausePolls} Messungen`
            : `${thermalUnreadablePolls} Temperaturmessungen ohne verwertbaren Sensorwert`;
          this.appendLog(
            job,
            `Thermalpause: ${reason}. Der LatentSync-Container bleibt vollständig im Speicher und wird nach Abkühlung nahtlos fortgesetzt.`,
          );
          this.changed();
          return;
        }
        if (action === "resume") {
          if (!dockerAction("unpause")) return;
          job.status = "running";
          this.setDgxOwnerHeartbeatPhase(job, "lip_refinement");
          this.appendLog(
            job,
            `Thermalpause beendet: ${temperatureC?.toFixed(1)} °C über ${thermalResumePolls} Messungen unter dem Lauf-Basiswert ${baselineC.toFixed(1)} °C. LatentSync läuft ohne Neustart weiter.`,
          );
          this.changed();
          return;
        }
        this.changed();
      } catch (error) {
        process.stderr.write(`LTX Studio LatentSync-Thermalwächter: ${String(error)}\n`);
      }
    }, thermalPollIntervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
      if (job.thermalProfile) {
        job.thermalProfile = {
          ...job.thermalProfile,
          currentC: null,
          peakC,
          riseC: peakC - baselineC,
          updatedAt: now(),
        };
      }
      this.appendLog(
        job,
        `LatentSync-Thermalprofil (gesamter Host): Basis ${baselineC.toFixed(1)} °C, Peak ${peakC.toFixed(1)} °C, beobachteter Anstieg ${(peakC - baselineC).toFixed(1)} °C.`,
      );
    };
  }

  private async waitForLongcatResources(job: RuntimeJob): Promise<boolean> {
    let lastAvailable: number | null = null;
    let lastLogAt = 0;
    while (!this.shuttingDown && job.status === "queued") {
      const resource = readResourceSnapshot();
      const available = resource.availableMemoryGiB;
      if (available !== null && available >= longcatMinAvailableGiB) {
        const temperatureC = await readMedianMaxTemperatureC({
          samples: thermalStartSamples,
          intervalMs: thermalStartSampleIntervalMs,
        });
        if (this.shuttingDown || job.status !== "queued") return false;
        if (temperatureC !== null && temperatureC < longcatThermalStartMaxC) {
          this.appendLog(
            job,
            `LongCat-Startgate erfüllt: ${available.toFixed(1)} GiB verfügbar und Temperaturmedian ${temperatureC.toFixed(1)} °C. Der Supervisor prüft jetzt zusätzlich den Treiberspeicher.`,
          );
          this.changed();
          return true;
        }
        const shownTemperature = temperatureC === null ? "nicht messbar" : `${temperatureC.toFixed(1)} °C`;
        if (Date.now() - lastLogAt >= RESOURCE_WAIT_LOG_INTERVAL_MS) {
          this.appendLog(
            job,
            `Warte auf LongCat-Thermalgate: Median ${shownTemperature}, benötigt unter ${longcatThermalStartMaxC.toFixed(0)} °C.`,
          );
          this.changed();
          lastLogAt = Date.now();
        }
      }
      const currentTime = Date.now();
      if (
        lastLogAt === 0
        || (available !== null && lastAvailable !== null && Math.abs(available - lastAvailable) >= 1)
        || currentTime - lastLogAt >= RESOURCE_WAIT_LOG_INTERVAL_MS
      ) {
        const shown = available === null ? "unbekannt" : `${available.toFixed(1)} GiB`;
        this.appendLog(
          job,
          `Warte auf LongCat-Startgate: benötigt ${longcatMinAvailableGiB.toFixed(0)} GiB verfügbaren RAM, aktuell ${shown}. Der Orchestrator entscheidet über zulässigen Reclaim.`,
        );
        this.changed();
        lastAvailable = available;
        lastLogAt = currentTime;
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, RESOURCE_RETRY_INTERVAL_MS));
    }
    return false;
  }

  private appendLog(job: RuntimeJob, value: string): void {
    job.logs.push(cleanLogLine(value));
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  }

  private changed(): void {
    this.persist();
    this.emit("changed", this.list());
  }

  private persist(): void {
    const temporaryPath = `${this.storagePath}.tmp`;
    const values = [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(persistedJob);
    writeFileSync(temporaryPath, JSON.stringify(values, null, 2), { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, this.storagePath);
  }

  private restore(): void {
    if (!existsSync(this.storagePath)) return;
    try {
      const stored = JSON.parse(readFileSync(this.storagePath, "utf8")) as PersistedStudioJob[];
      const retained = [
        ...stored.slice(0, MAX_JOBS),
        ...stored.slice(MAX_JOBS).filter((entry) => {
          const hasPendingTerminal = normalizeDgxTerminalDelivery(entry.dgxTerminalDelivery) !== undefined;
          const hasPendingSubmit = entry.dgxSubmitPending === true;
          const hasActiveRemoteLease = isActiveJobStatus(entry.status)
            && typeof entry.dgxJobId === "string"
            && /^dgx-job-[0-9a-z-]+$/i.test(entry.dgxJobId);
          return hasPendingTerminal || hasPendingSubmit || hasActiveRemoteLease;
        }),
      ];
      for (const entry of retained) {
        let migratedRequest = migrateGenerationRequest(entry.request);
        if (!migratedRequest || typeof entry.id !== "string" || !/^[0-9a-f-]{36}$/i.test(entry.id)) continue;
        const storedStatus: JobStatus = ["queued", "running", "paused", "completed", "failed", "cancelled", "interrupted"]
          .includes(entry.status) ? entry.status : "interrupted";
        const dgxJobId = typeof entry.dgxJobId === "string" && /^dgx-job-[0-9a-z-]+$/i.test(entry.dgxJobId)
          ? entry.dgxJobId
          : null;
        const recoverableLocalQueue = storedStatus === "queued" && dgxJobId === null;
        if (recoverableLocalQueue) {
          migratedRequest = withOfficialSpeechModelPaths(migratedRequest);
        }
        let status: JobStatus = recoverableLocalQueue
          ? "queued"
          : isActiveJobStatus(storedStatus) ? "interrupted" : storedStatus;
        const plan = buildCommand(migratedRequest);
        let outputReady = false;
        if (status === "completed") {
          try {
            const outputStats = statSync(plan.outputPath);
            outputReady = outputStats.isFile() && outputStats.size > 0;
          } catch {
            outputReady = false;
          }
          if (!outputReady) status = "failed";
        }
        const interrupted = status === "interrupted";
        const missingOutput = storedStatus === "completed" && !outputReady;
        const storedProgress = typeof entry.progress === "number" && Number.isFinite(entry.progress)
          ? Math.min(100, Math.max(0, entry.progress))
          : null;
        const restoredTerminalDelivery = dgxJobId
          ? normalizeDgxTerminalDelivery(entry.dgxTerminalDelivery)
          : undefined;
        const restoredProcessGroupIdentity = entry.localProcessGroupPending === true
          && isLocalProcessGroupIdentity(entry.localProcessGroupIdentity)
          ? entry.localProcessGroupIdentity
          : undefined;
        const interruptedRemoteDelivery = interrupted
          && isActiveJobStatus(storedStatus)
          && dgxJobId
          && !restoredTerminalDelivery
          ? {
              state: "cancelled" as const,
              metadata: {
                current_step: "studio restarted while owning active queue job",
                last_error: "LTX Studio restarted before the active queue lease reached a terminal state",
              },
              attempts: 0,
              lastError: null,
              updatedAt: now(),
            }
          : undefined;
        const restoredLogs = Array.isArray(entry.logs)
          ? entry.logs.filter((line): line is string => typeof line === "string").slice(-MAX_LOG_LINES).map(cleanLogLine)
          : [];
        if (interruptedRemoteDelivery) {
          restoredLogs.push("Studio-Neustart: Remote-Queue-Lease wird als cancelled abgemeldet.");
        } else if (recoverableLocalQueue) {
          restoredLogs.push(
            entry.dgxSubmitPending === true
              ? "Studio-Neustart: unklarer Queue-Submit wird vor jeder Fortsetzung autoritativ abgeglichen."
              : "Studio-Neustart: rein lokal wartender Job wird automatisch fortgesetzt.",
          );
        }
        if (entry.localProcessGroupPending === true) {
          restoredLogs.push(
            restoredProcessGroupIdentity
              ? "Studio-Neustart: frühere Prozessgruppe wird bootgebunden über /proc geprüft; bis zum Abwesenheitsbeweis bleibt die Remote-Lease gesperrt."
              : "Studio-Neustart: Remote-Lease bleibt gesperrt, weil für die frühere lokale Prozessgruppe keine sichere Identität vorliegt.",
          );
        }
        this.jobs.set(entry.id, {
          ...entry,
          id: entry.id,
          mode: migratedRequest.mode,
          prompt: migratedRequest.prompt,
          outputName: migratedRequest.outputName,
          outputUrl: status === "completed" ? `/api/jobs/${entry.id}/output` : null,
          createdAt: validTimestamp(entry.createdAt, now())!,
          startedAt: validTimestamp(entry.startedAt, null),
          request: migratedRequest,
          status,
          finishedAt: interrupted ? now() : validTimestamp(entry.finishedAt, null),
          progress: status === "completed"
            ? 100
            : storedProgress === null ? null : Math.min(MAX_RUNNING_PROCESS_PROGRESS, storedProgress),
          error: interrupted
            ? "Studio wurde während des Jobs neu gestartet."
            : missingOutput
              ? "Die gespeicherte Ausgabedatei ist nicht mehr vorhanden."
              : typeof entry.error === "string" ? entry.error : null,
          logs: restoredLogs.slice(-MAX_LOG_LINES),
          command: plan.displayCommand,
          favorite: entry.favorite === true,
          variantOf: typeof entry.variantOf === "string" && /^[0-9a-f-]{36}$/i.test(entry.variantOf)
            ? entry.variantOf
            : null,
          experiment: experimentRunBindingSchema.safeParse(entry.experiment).success
            ? experimentRunBindingSchema.parse(entry.experiment)
            : null,
          runtimeMs: typeof entry.runtimeMs === "number" && Number.isFinite(entry.runtimeMs) && entry.runtimeMs >= 0
            ? entry.runtimeMs
            : null,
          cancelledBy: entry.cancelledBy === "studio" || storedStatus === "cancelled" ? "studio" : null,
          thermalProfile: entry.thermalProfile
            && typeof entry.thermalProfile.baselineC === "number"
            && Number.isFinite(entry.thermalProfile.baselineC)
            && typeof entry.thermalProfile.peakC === "number"
            && Number.isFinite(entry.thermalProfile.peakC)
            ? {
                baselineC: entry.thermalProfile.baselineC,
                currentC: typeof entry.thermalProfile.currentC === "number"
                  && Number.isFinite(entry.thermalProfile.currentC)
                  ? entry.thermalProfile.currentC
                  : null,
                peakC: entry.thermalProfile.peakC,
                riseC: typeof entry.thermalProfile.riseC === "number"
                  && Number.isFinite(entry.thermalProfile.riseC)
                  ? entry.thermalProfile.riseC
                  : entry.thermalProfile.peakC - entry.thermalProfile.baselineC,
                pauseAtC: typeof entry.thermalProfile.pauseAtC === "number"
                  && Number.isFinite(entry.thermalProfile.pauseAtC)
                  ? entry.thermalProfile.pauseAtC
                  : thermalPauseC,
                resumeBelowC: typeof entry.thermalProfile.resumeBelowC === "number"
                  && Number.isFinite(entry.thermalProfile.resumeBelowC)
                  ? entry.thermalProfile.resumeBelowC
                  : Math.min(entry.thermalProfile.baselineC + 0.1, thermalPauseC - 0.1),
                updatedAt: validTimestamp(entry.thermalProfile.updatedAt, now())!,
              }
            : thermalProfileFromLogs(entry.logs),
          dgxJobId,
          dgxTerminalDelivery: dgxJobId
            ? restoredTerminalDelivery ?? interruptedRemoteDelivery
            : undefined,
          localProcessGroupPending: entry.localProcessGroupPending === true || undefined,
          localProcessGroupIdentity: restoredProcessGroupIdentity,
          dgxSubmitPending: entry.dgxSubmitPending === true || undefined,
          dgxSubmitStartedAt: entry.dgxSubmitPending === true
            ? validTimestamp(entry.dgxSubmitStartedAt, now()) ?? undefined
            : undefined,
          identityEvidence: normalizeIdentityInputEvidence(entry.identityEvidence),
          runProvenance: normalizeRunProvenance(entry.runProvenance),
          plan,
        });
        if (recoverableLocalQueue) this.queue.push(entry.id);
      }
    } catch {
      // Invalid history never blocks a fresh local studio session.
    }
  }

  private trimHistory(): void {
    const entries = [...this.jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const job of entries.slice(MAX_JOBS)) {
      if (!isActiveJobStatus(job.status) && !job.dgxTerminalDelivery) this.jobs.delete(job.id);
    }
  }
}
