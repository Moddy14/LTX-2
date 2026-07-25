import { EventEmitter } from "node:events";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  experimentRunBindingSchema,
  type ExperimentRunBinding,
} from "../shared/experiments.js";
import { migrateGenerationRequest, type GenerationRequest } from "../shared/pipelines.js";
import {
  decisionMessage,
  readQueueJob,
  retryAfterMs,
  shouldRetryQueueSubmit,
  submitQueueAdmission,
  transitionQueueJob,
  type QueueArtifact,
  type QueueJobState,
  type QueueTransitionState,
} from "./admission.js";
import { buildCommand, type CommandPlan, validateRequestPlan } from "./command.js";
import {
  admissionPythonExecutable,
  appRoot,
  executableAvailable,
  hybridCacheRoot,
  hybridRoot,
  longcatProjectRoot,
  longcatMinAvailableGiB,
  longcatThermalStartMaxC,
  minAvailableGiB,
  minResidualMemoryGiB,
  minSwapFreeGiB,
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
  validateStartResources,
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
  captureRunProvenance,
  normalizeRunProvenance,
  verifyRunProvenance,
} from "./runProvenance.js";

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

type RuntimeJob = StudioJob & {
  plan: CommandPlan;
  process?: ChildProcess;
  dgxJobTerminal?: boolean;
  dgxStateTransitionInFlight?: Promise<boolean>;
  dgxTerminalDelivery?: DgxTerminalDelivery;
  dgxTerminalDeliveryInFlight?: Promise<boolean>;
  dgxTerminalRetry?: NodeJS.Timeout;
};
type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };
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
type PersistedStudioJob = StudioJob & {
  dgxTerminalDelivery?: DgxTerminalDelivery;
};
type DgxQueueOperations = {
  read: typeof readQueueJob;
  transition: typeof transitionQueueJob;
};
type DgxAdmissionOperations = {
  submit: typeof submitQueueAdmission;
};
type RunProvenanceOperations = {
  capture: typeof captureRunProvenance;
  verify: typeof verifyRunProvenance;
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
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "running", "paused"];
const DGX_TERMINAL_STATES = new Set<DgxTerminalState>(["completed", "failed", "cancelled"]);
const DGX_REMOTE_TERMINAL_STATES = new Set<QueueJobState>([
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);

export type VariantMode = "exact" | "random-seed";

export class JobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobConflictError";
  }
}

export function nextVariantOutputName(outputName: string, unavailable: (name: string) => boolean): string {
  const base = outputName.replace(/\.mp4$/i, "").replace(/-v\d+$/i, "");
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${base}-v${String(index).padStart(2, "0")}.mp4`;
    if (!unavailable(candidate)) return candidate;
  }
  return `${base}-${Date.now()}.mp4`;
}

function ltxBaseComparable(request: GenerationRequest): object {
  const generation: Partial<GenerationRequest> = structuredClone(request);
  const otherPostprocess: Partial<GenerationRequest["postprocess"]> = { ...generation.postprocess };
  delete generation.outputName;
  delete otherPostprocess.longcatLipsync;
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
  return !source.audio.finalMix.path && requestsShareLtxBase(source, target);
}

export function runProvenanceSharesLtxBase(
  source: RunProvenance | null,
  target: RunProvenance | null,
): boolean {
  if (!source?.verifiedAt || !target?.verifiedAt) return false;
  const ltxFiles = (evidence: RunProvenance) => evidence.files
    .filter((file) =>
      file.role !== "code:longcat-adapter"
      && file.role !== "model:longcat-face-detector"
      && file.role !== "input:final-audio-mix")
    .map((file) => ({ role: file.role, sha256: file.sha256 }))
    .sort((left, right) => left.role.localeCompare(right.role));
  const ltxCode = (evidence: RunProvenance) => evidence.code
    .filter((repository) => repository.repositoryRoot === repoRoot)
    .map((repository) => repository.fingerprint);
  return isDeepStrictEqual(ltxFiles(source), ltxFiles(target))
    && isDeepStrictEqual(ltxCode(source), ltxCode(target))
    && ltxCode(source).length === 1
    && source.runtime.fingerprint === target.runtime.fingerprint;
}

export function resolveRenderOutputPaths(
  finalOutput: string,
  stageRoot: string,
  hybridEnabled: boolean,
  finalAudioMixEnabled: boolean,
): { ltxOutput: string; compositeOutput: string; remuxInput: string } {
  const ltxOutput = hybridEnabled || finalAudioMixEnabled
    ? join(stageRoot, "ltx-base.mp4")
    : finalOutput;
  const compositeOutput = finalAudioMixEnabled
    ? join(stageRoot, "longcat-composite.mp4")
    : finalOutput;
  return {
    ltxOutput,
    compositeOutput,
    remuxInput: hybridEnabled ? compositeOutput : ltxOutput,
  };
}

function now(): string {
  return new Date().toISOString();
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
}

function processIsAlive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function jobWasCancelled(job: RuntimeJob): boolean {
  return job.status === "cancelled";
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid || !processIsAlive(child)) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return child.kill(signal);
  }
}

function publicJob(job: RuntimeJob): StudioJob {
  const value = { ...job } as Partial<RuntimeJob>;
  delete value.plan;
  delete value.process;
  delete value.dgxJobTerminal;
  delete value.dgxStateTransitionInFlight;
  delete value.dgxTerminalDelivery;
  delete value.dgxTerminalDeliveryInFlight;
  delete value.dgxTerminalRetry;
  return value as StudioJob;
}

function persistedJob(job: RuntimeJob): PersistedStudioJob {
  const value: PersistedStudioJob = publicJob(job);
  if (job.dgxTerminalDelivery) value.dgxTerminalDelivery = structuredClone(job.dgxTerminalDelivery);
  return value;
}

const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function cleanLogLine(line: string): string {
  return line.replaceAll(ANSI_COLOR, "").slice(0, MAX_LOG_LINE_LENGTH);
}

function expectedDenoisingStages(request: GenerationRequest): number {
  if (request.mode === "one-stage" || request.mode === "retake") return 1;
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
    },
    private readonly dgxTerminalRetryBaseMs: number | null = DEFAULT_DGX_TERMINAL_RETRY_BASE_MS,
    private readonly dgxAdmissionOperations: DgxAdmissionOperations = {
      submit: submitQueueAdmission,
    },
    private readonly runProvenanceOperations: RunProvenanceOperations = {
      capture: captureRunProvenance,
      verify: verifyRunProvenance,
    },
  ) {
    super();
    this.restore();
    for (const job of this.jobs.values()) this.scheduleDgxTerminalRetry(job, 0);
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
    const request = structuredClone(source.request);
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
        signalProcessGroup(process, "SIGTERM");
        setTimeout(() => {
          if (processIsAlive(process)) signalProcessGroup(process, "SIGKILL");
        }, 10_000).unref();
      }
      this.changed();
      void this.flushDgxTerminalDelivery(job);
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
        if (wasPaused) signalProcessGroup(process, "SIGCONT");
        signalProcessGroup(process, "SIGTERM");
        setTimeout(() => {
          if (processIsAlive(process)) signalProcessGroup(process, "SIGKILL");
        }, 10_000).unref();
      }
      this.changed();
      void this.flushDgxTerminalDelivery(job);
    }
    return publicJob(job);
  }

  private async pump(): Promise<void> {
    if (this.runningId !== null) return;
    const id = this.queue.shift();
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return void this.pump();
    this.runningId = id;
    try {
      await this.run(job);
    } catch (error) {
      if (this.jobs.get(id)?.status !== "cancelled") {
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
      this.runningId = null;
      void this.pump();
    }
  }

  private async run(job: RuntimeJob): Promise<void> {
    const pathErrors = validateRequestPlan(job.request, job.plan);
    const hybridEnabled = job.request.postprocess.longcatLipsync.enabled;
    const finalAudioMixEnabled = job.request.mode === "audio-to-video"
      && Boolean(job.request.audio.finalMix.path);
    const hybridScript = join(appRoot, "scripts", "longcat-hybrid.py");
    const hybridFaceModel = join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
    if (hybridEnabled) {
      if (!existsSync(hybridScript)) pathErrors.push(`LongCat-Adapter fehlt (${hybridScript})`);
      if (!existsSync(hybridFaceModel)) pathErrors.push(`YuNet-Gesichtsmodell fehlt (${hybridFaceModel})`);
      if (!existsSync(join(longcatProjectRoot, "scripts", "avatar_worker_supervisor.py"))) {
        pathErrors.push(`LongCat-Projekt ist unvollständig (${longcatProjectRoot})`);
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
    if (finalAudioMixEnabled && !executableAvailable("ffmpeg")) {
      job.status = "failed";
      job.finishedAt = now();
      job.error = "FFmpeg für die finale Tonspur ist nicht verfügbar.";
      this.appendLog(job, job.error);
      this.changed();
      return;
    }

    job.identityEvidence = await this.identityEvidenceOperations.capture(job.request, this.assets);
    if (jobWasCancelled(job)) {
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
      this.failJob(
        job,
        `Laufprovenienz konnte nicht vollständig gebunden werden: ${
          error instanceof Error ? error.message : "unbekannter Fehler"
        }`,
      );
      return;
    }
    if (jobWasCancelled(job)) {
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
    const { ltxOutput, compositeOutput, remuxInput } = resolveRenderOutputPaths(
      job.plan.outputPath,
      stageRoot,
      hybridEnabled,
      finalAudioMixEnabled,
    );
    if (hybridEnabled || finalAudioMixEnabled) {
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
      if (jobWasCancelled(job)) return;
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
        if (jobWasCancelled(job)) return;
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

    const reusableBase = hybridEnabled ? this.findReusableLtxBase(job) : undefined;
    if (reusableBase) {
      copyFileSync(reusableBase.plan.outputPath, ltxOutput);
      if (!this.fileReady(ltxOutput)) {
        this.failJob(job, "Die identische vorhandene LTX-Basis konnte nicht übernommen werden.");
        return;
      }
      job.progress = 70;
      this.appendLog(
        job,
        `Identische LTX-Basis aus GUI-Job ${reusableBase.id} übernommen; kein redundanter DGX-Render nötig.`,
      );
      this.changed();
    } else {
      if (!await this.waitForDgxQueueStart(job)) return;
      if (!await this.verifyJobIdentityEvidence(job, "unmittelbar vor dem LTX-Start")) {
        if (jobWasCancelled(job)) return;
        await this.transitionDgxJob(job, "failed", {
          current_step: "identity reference changed before LTX allocation",
          last_error: job.error ?? "identity reference verification failed",
        });
        return;
      }
      if (!await this.verifyJobRunProvenance(job, "unmittelbar vor dem LTX-Start")) {
        if (jobWasCancelled(job)) return;
        await this.transitionDgxJob(job, "failed", {
          current_step: "run provenance changed before LTX allocation",
          last_error: job.error ?? "run provenance verification failed",
        });
        return;
      }
      const thermalBaselineC = await this.readThermalBaseline(job);
      if (thermalBaselineC === null) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "thermal start gate failed before LTX allocation",
          last_error: job.error ?? "thermal start gate failed",
        });
        return;
      }

      job.status = "running";
      job.startedAt ??= now();
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
      const child = spawn(job.plan.executable, ltxArgs, {
        cwd: repoRoot,
        env: {
          ...process.env,
          DGX_JOB_ID: job.dgxJobId ?? undefined,
          PYTHONPATH: pythonPath,
          PYTHONUNBUFFERED: "1",
        },
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      job.process = child;
      if (!await this.transitionDgxJob(job, "running", { current_step: "ltx native pipeline running" })) {
        if (jobWasCancelled(job)) return;
        signalProcessGroup(child, "SIGTERM");
        setTimeout(() => {
          if (processIsAlive(child)) signalProcessGroup(child, "SIGKILL");
        }, 10_000).unref();
        this.failJob(job, "DGX-Queue-Running-State wurde nicht freigegeben; LTX-Prozess wurde beendet.");
        await this.transitionDgxJob(job, "failed", {
          current_step: "failed before LTX output because running transition failed",
          last_error: job.error ?? "running transition failed",
        });
        return;
      }
      this.changed();
      const ltxProgressEnd = hybridEnabled
        ? finalAudioMixEnabled ? 80 : 85
        : finalAudioMixEnabled ? 90 : MAX_RUNNING_PROCESS_PROGRESS;
      this.consumeProcessLogs(
        job,
        child,
        new PipelineProgressTracker(
          hybridEnabled ? 20 : 0,
          ltxProgressEnd,
          expectedDenoisingStages(job.request),
        ),
      );
      const stopThermalWatcher = this.watchThermals(job, child, thermalBaselineC);
      const ltxResult = await this.waitForProcess(child);
      stopThermalWatcher();
      delete job.process;
      if (jobWasCancelled(job)) {
        this.changed();
        return;
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
      if (jobWasCancelled(job)) return;
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

    if (finalAudioMixEnabled) {
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
      if (jobWasCancelled(job)) {
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

    if (!await this.verifyJobIdentityEvidence(job, "nach der vollständigen Ausgabe")) {
      if (!jobWasCancelled(job)) {
        await this.transitionDgxJob(job, "failed", {
          current_step: "final identity evidence verification failed",
          last_error: job.error ?? "identity evidence verification failed",
        });
      }
      return;
    }
    if (!await this.verifyJobRunProvenance(job, "nach der vollständigen Ausgabe")) {
      if (!jobWasCancelled(job)) {
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
        type: "video",
        path: job.plan.outputPath,
        note: finalAudioMixEnabled
          ? "final LTX Studio output with separately remuxed audio"
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
      hybridEnabled
        ? "Hybridvideo erfolgreich erzeugt; LTX-Basis und LongCat-Mundspur bleiben als Zwischenstände erhalten."
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
    if (jobWasCancelled(job)) return false;
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
    if (jobWasCancelled(job)) return false;
    job.runProvenance = result.evidence;
    if (result.error) {
      this.failJob(job, `Laufprovenienzprüfung ${context} fehlgeschlagen: ${result.error}`);
      return false;
    }
    this.appendLog(job, `Gebundene Laufprovenienz ${context} unverändert verifiziert.`);
    this.changed();
    return true;
  }

  private findReusableLtxBase(job: RuntimeJob): RuntimeJob | undefined {
    return [...this.jobs.values()].find((candidate) =>
      candidate.id !== job.id
      && candidate.status === "completed"
      && !candidate.request.postprocess.longcatLipsync.enabled
      && publishedOutputIsReusableLtxBase(candidate.request, job.request)
      && this.identityEvidenceMatches(candidate.identityEvidence, job.identityEvidence)
      && runProvenanceSharesLtxBase(candidate.runProvenance, job.runProvenance)
      && this.fileReady(candidate.plan.outputPath));
  }

  private identityEvidenceMatches(
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

  private async waitForDelay(job: RuntimeJob, delayMs: number): Promise<boolean> {
    const endAt = Date.now() + delayMs;
    while (isActiveJobStatus(job.status)) {
      const remaining = endAt - Date.now();
      if (remaining <= 0) return true;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, Math.min(1_000, remaining)));
    }
    return false;
  }

  private async waitForDgxQueueStart(job: RuntimeJob): Promise<boolean> {
    if (!await this.waitForLocalPreAdmissionResources(job)) return false;
    while (isActiveJobStatus(job.status)) {
      let response;
      try {
        this.appendLog(job, "DGX-Queue: Renderbedarf wird beim Orchestrator eingereicht; laufende Anwendungen werden nicht direkt beendet.");
        const estimate = estimateRequest(job.request, this.list());
        const requiredStartMemoryGiB = Math.max(
          minAvailableGiB,
          estimate.memoryGiB + minResidualMemoryGiB,
        );
        this.appendLog(
          job,
          `DGX-Queue: Ressourcenprognose ${estimate.memoryGiB} GiB RAM plus ${minResidualMemoryGiB} GiB `
            + `Restpuffer, Startanforderung ${requiredStartMemoryGiB} GiB, ${estimate.outputGiB.toFixed(2)} GiB Ausgabe.`,
        );
        response = await this.dgxAdmissionOperations.submit(job.request, requiredStartMemoryGiB, job.id);
      } catch (error) {
        if (jobWasCancelled(job)) return false;
        this.failJob(job, error instanceof Error ? error.message : "DGX-Queue-Submit ist fehlgeschlagen.");
        return false;
      }

      const { admission, job: queueJob } = response;
      if (queueJob.state === "accepted" || queueJob.state === "queued") {
        job.dgxJobId = queueJob.job_id;
        this.changed();
      }
      if (jobWasCancelled(job)) {
        this.prepareDgxTerminalDelivery(job, "cancelled", {
          current_step: "cancelled while DGX queue submit was in flight",
          last_error: "manual Studio cancellation",
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
        return this.startAcceptedDgxJob(job);
      }

      if (queueJob.state === "queued" || admission.decision === "queued") {
        const accepted = await this.waitForQueuedDgxJob(job, retryAfterMs(admission));
        if (!accepted) return false;
        return isActiveJobStatus(job.status);
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

  private async waitForQueuedDgxJob(job: RuntimeJob, initialDelayMs: number): Promise<boolean> {
    let delayMs = initialDelayMs;
    while (isActiveJobStatus(job.status) && job.dgxJobId) {
      this.appendLog(job, `DGX-Queue-Job wartet beim Orchestrator; nächste Prüfung in ${(delayMs / 1000).toFixed(0)} s.`);
      this.changed();
      if (!await this.waitForDelay(job, delayMs)) return false;
      let response;
      try {
        response = await this.dgxQueueOperations.read(job.dgxJobId);
      } catch (error) {
        if (jobWasCancelled(job)) return false;
        const message = error instanceof Error ? error.message : "DGX-Queue-Status konnte nicht gelesen werden.";
        this.appendLog(job, `DGX-Queue-Status vorübergehend nicht lesbar: ${message}. Prüfung wird wiederholt.`);
        this.changed();
        delayMs = 30_000;
        continue;
      }
      const queueJob = response.job;
      this.appendLog(job, `DGX-Queue-Status: ${queueJob.job_id} ${queueJob.state}${queueJob.reason ? ` - ${queueJob.reason}` : ""}.`);
      if (queueJob.state === "accepted") {
        return this.startAcceptedDgxJob(job);
      }
      if (queueJob.state === "queued") {
        delayMs = 30_000;
        continue;
      }
      if (["cancelled", "completed", "failed", "rejected"].includes(queueJob.state)) {
        job.dgxJobTerminal = true;
        this.failJob(job, `DGX-Queue-Job ist terminal: ${queueJob.state}${queueJob.last_error ? ` - ${queueJob.last_error}` : ""}`);
        return false;
      }
      delayMs = 30_000;
    }
    return false;
  }

  private async startAcceptedDgxJob(job: RuntimeJob): Promise<boolean> {
    const estimate = estimateRequest(job.request, this.list());
    const snapshot = this.readStartResourceSnapshot();
    const issue = validateStartResources(snapshot, {
      estimatedMemoryGiB: estimate.memoryGiB,
      minAvailableGiB,
      minResidualMemoryGiB,
      minSwapFreeGiB,
      outputGiB: estimate.outputGiB,
    });
    if (issue !== null) {
      const message = `DGX hat den Job akzeptiert, aber der unmittelbare lokale Start-Recheck ist fehlgeschlagen: ${issue}`;
      this.prepareDgxTerminalDelivery(job, "cancelled", {
        current_step: "local start recheck failed before LTX allocation",
        last_error: message,
      });
      job.status = "failed";
      job.error = message;
      job.finishedAt = now();
      this.appendLog(job, message);
      this.changed();
      void this.flushDgxTerminalDelivery(job);
      return false;
    }
    this.appendLog(
      job,
      `Lokales Start-Gate erfüllt: ${snapshot.availableMemoryGiB?.toFixed(2)} GiB RAM, `
        + `${snapshot.swapFreeGiB?.toFixed(2)} GiB Swap und ${snapshot.outputFreeGiB?.toFixed(2)} GiB Ausgabeplatz frei.`,
    );
    this.changed();
    const started = await this.transitionDgxJob(job, "starting", {
      current_step: "thermal start gate before LTX allocation",
    });
    if (started) return isActiveJobStatus(job.status);
    if (jobWasCancelled(job)) return false;
    const message = "DGX-Queue-Start-Fence wurde nicht freigegeben.";
    this.prepareDgxTerminalDelivery(job, "cancelled", {
      current_step: "starting transition failed before LTX allocation",
      last_error: message,
    });
    this.failJob(job, message);
    await this.flushDgxTerminalDelivery(job);
    return false;
  }

  private readStartResourceSnapshot(): ResourceSnapshot {
    return readResourceSnapshot();
  }

  private async waitForLocalPreAdmissionResources(job: RuntimeJob): Promise<boolean> {
    const estimate = estimateRequest(job.request, this.list());
    const requirements = {
      minSwapFreeGiB,
      outputGiB: estimate.outputGiB,
    };
    let lastIssue: string | null = null;
    let lastLogAt = 0;

    while (isActiveJobStatus(job.status)) {
      const snapshot = this.readStartResourceSnapshot();
      const issue = validatePreAdmissionResources(snapshot, requirements);
      if (issue === null) {
        this.appendLog(
          job,
          `Lokales Vorab-Gate erfüllt: ${snapshot.swapFreeGiB?.toFixed(2)} GiB Swap und `
            + `${snapshot.outputFreeGiB?.toFixed(2)} GiB Ausgabeplatz frei.`,
        );
        this.changed();
        return true;
      }
      const currentTime = Date.now();
      if (issue !== lastIssue || currentTime - lastLogAt >= RESOURCE_WAIT_LOG_INTERVAL_MS) {
        this.appendLog(job, `Lokales Start-Gate wartet: ${issue}`);
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
    if (job.dgxStateTransitionInFlight) return job.dgxStateTransitionInFlight;
    const transitionPromise = (async () => {
      try {
        const response = await this.dgxQueueOperations.transition(job.dgxJobId!, state, metadata);
        this.appendLog(job, `DGX-Queue-State: ${response.job.job_id} -> ${response.job.state}.`);
        this.changed();
        return true;
      } catch (error) {
        this.appendLog(
          job,
          `DGX-Queue-State konnte nicht auf ${state} gesetzt werden: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.changed();
        return false;
      }
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
    if (job.dgxTerminalDeliveryInFlight) return job.dgxTerminalDeliveryInFlight;
    if (job.dgxStateTransitionInFlight) await job.dgxStateTransitionInFlight;
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
      this.dgxTerminalRetryBaseMs === null
      || !job.dgxTerminalDelivery
      || job.dgxJobTerminal
      || job.dgxTerminalRetry
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
    delete job.process;
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
        const progress = progressTracker?.update(line) ?? null;
        if (progress !== null) job.progress = Math.max(job.progress ?? 0, progress);
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
    job.process = child;
    this.consumeProcessLogs(job, child);
    this.changed();
    const result = await this.waitForProcess(child);
    if (job.process === child) delete job.process;
    this.changed();
    return result;
  }

  private async readThermalBaseline(job: RuntimeJob): Promise<number | null> {
    const maxC = await readMedianMaxTemperatureC({
      samples: thermalStartSamples,
      intervalMs: thermalStartSampleIntervalMs,
    });
    if (job.status === "cancelled") return null;
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

  private async waitForLongcatResources(job: RuntimeJob): Promise<boolean> {
    let lastAvailable: number | null = null;
    let lastLogAt = 0;
    while (job.status === "queued") {
      const resource = readResourceSnapshot();
      const available = resource.availableMemoryGiB;
      if (available !== null && available >= longcatMinAvailableGiB) {
        const temperatureC = await readMedianMaxTemperatureC({
          samples: thermalStartSamples,
          intervalMs: thermalStartSampleIntervalMs,
        });
        if (job.status !== "queued") return false;
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
        ...stored.slice(MAX_JOBS).filter((entry) =>
          normalizeDgxTerminalDelivery(entry.dgxTerminalDelivery) !== undefined),
      ];
      for (const entry of retained) {
        const migratedRequest = migrateGenerationRequest(entry.request);
        if (!migratedRequest || typeof entry.id !== "string" || !/^[0-9a-f-]{36}$/i.test(entry.id)) continue;
        const storedStatus: JobStatus = ["queued", "running", "paused", "completed", "failed", "cancelled", "interrupted"]
          .includes(entry.status) ? entry.status : "interrupted";
        let status: JobStatus = isActiveJobStatus(storedStatus) ? "interrupted" : storedStatus;
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
        const dgxJobId = typeof entry.dgxJobId === "string" && /^dgx-job-[0-9a-z-]+$/i.test(entry.dgxJobId)
          ? entry.dgxJobId
          : null;
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
          logs: Array.isArray(entry.logs)
            ? entry.logs.filter((line): line is string => typeof line === "string").slice(-MAX_LOG_LINES).map(cleanLogLine)
            : [],
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
            ? normalizeDgxTerminalDelivery(entry.dgxTerminalDelivery)
            : undefined,
          identityEvidence: normalizeIdentityInputEvidence(entry.identityEvidence),
          runProvenance: normalizeRunProvenance(entry.runProvenance),
          plan,
        });
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
