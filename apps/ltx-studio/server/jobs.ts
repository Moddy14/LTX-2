import { EventEmitter } from "node:events";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { delimiter, dirname, extname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  rawMuxPairV1BaselineError,
  rawMuxPairV1CandidateError,
  experimentRunBindingSchema,
  isAdoptedLipForcingCandidate,
  supportsProgramAudioDelayExperiment,
  supportsPositivePromptExperiment,
  type ExperimentRunBinding,
} from "../shared/experiments.js";
import {
  projectRunBindingSchema,
  type ProjectRunBinding,
} from "../shared/projects.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_BASIS } from "../shared/estimates.js";
import {
  PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
  PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
  publicJobPersistenceHoldHealth,
  type PublicJobPersistenceHealth,
} from "../shared/healthPublic.js";
import { refinerAdmissionMemoryGiB } from "../shared/admissionPreflight.js";
import {
  isJobExecutionClass,
  jobExecutionDecisionIsMonotone,
  normalizeJobExecutionDecision,
  executionDescriptorThreatModel,
  type CpuAudioRetimeReuseSourceBinding,
  type CpuFfmpegOperation,
  type CpuPacketCopyAudioRetimeOperation,
  type CpuOperationState,
  type CpuOperation,
  type CpuPairedArtifactPromotionOperation,
  type CpuPairedArtifactReuseSourceBinding,
  type CpuReuseSourceBinding,
  type ExecutionFileBinding,
  type ExecutionFileRevision,
  type JobExecutionDecision,
  type JobExecutionClass,
} from "../shared/jobExecution.js";
import {
  defaultLipForcingRawOutputProfile,
  experimentalLipForcingRawOutputProfile,
  isAudioConditionedMode,
  isLegacyDfrRequest,
  migrateGenerationRequest,
  type GenerationRequest,
} from "../shared/pipelines.js";
import { qualificationHoldForRequest } from "../shared/qualificationHold.js";
import {
  requiredOfficialSpeechAssetIds,
  withOfficialSpeechModelPaths,
  type ModelInventory,
} from "../shared/models.js";
import {
  assertAuthoritativeQueueList,
  buildAdmissionRequests,
  cooperativeQueueContractConfirmed,
  decisionMessage,
  decideSegmentBoundary,
  cooperativeCheckpointPath,
  heartbeatQueueJob,
  isDgxJobId,
  isDgxNeverStarted,
  listQueueJobs,
  parseStrictOffsetDateTime,
  queueAdmissionMemoryGiB,
  readQueueJob,
  replayPreparedQueueAdmission,
  retryAfterMs,
  submitConditionalQueueSuccessor,
  submitPreparedQueueAdmission,
  supportsCooperativeCheckpoint,
  transitionQueueJob,
  type AdmissionRequest,
  type ConditionalSuccessorResult,
  type ConditionalSuccessorTerminalEvidence,
  type QueueArtifact,
  type QueueHeartbeatPayload,
  type QueueJobSummary,
  type QueueJobState,
  type QueueListResponse,
  type QueueSubmitResponse,
  type QueueTransitionState,
  type SegmentBoundaryDecision,
} from "./admission.js";
import {
  dgxRuntimeRequestSha256,
  dgxRuntimeRequestSha256Matches,
} from "./dgxRequestDigest.js";
import { buildCommand, type CommandPlan, validateRequestPlan } from "./command.js";
import { getModelInventory } from "./models.js";
import {
  admissionPythonExecutable,
  appRoot,
  executableAvailable,
  hybridCacheRoot,
  hybridRoot,
  hostTcbExecutables,
  isolatedPythonEnvironment,
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
  rendererPythonExecutable,
  pythonRuntimeAvailable,
  repoRoot,
  SEALED_EXECUTABLE_PATH,
  sealedRelease,
  statePath,
  thermalPauseC,
  thermalPausePolls,
  thermalPollIntervalMs,
  thermalResumeC,
  thermalResumePolls,
  thermalStartSampleIntervalMs,
  thermalStartSamples,
  thermalUnreadablePolls,
} from "./config.js";
import { revalidateSealedRuntimeTrustIdentity } from "./releaseIdentity.js";
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
import {
  buildPositiveAudioRetimePacketCopyArgs,
  createPositiveAudioRetimeReceipt,
  positiveAudioRetimeArgsSha256,
  POSITIVE_AUDIO_RETIME_FFPROBE_ARGS_SHA256,
  POSITIVE_AUDIO_RETIME_PROFILE,
} from "./audioRetimeReceipt.js";
import type {
  ProvenanceContainerImageEvidence,
  RunProvenance,
} from "../shared/provenance.js";
import {
  bindRunExecutionDecision,
  bindRunProvenanceFile,
  captureRunProvenance,
  forkVerifiedRunProvenanceForArtifactPromotion,
  normalizeRunProvenance,
  runProvenanceFingerprintMatches,
  runProvenanceEnvironmentMatches,
  verifyRunProvenance,
} from "./runProvenance.js";
import { lipForcingImageIdentity } from "./dockerImageIdentity.js";
import {
  verifyNativeRuntimeSource,
  type NativeRuntimeSourceProbeOperations,
} from "./nativeRuntimeSourceGate.js";
import { outputAnalysisRecordSchema } from "../shared/objectiveQuality.js";
import { RuntimeApiError } from "./runtimeApi.js";
import {
  describeDgxMemoryWait,
  memoryWaitFromDgxBlocker,
  normalizeDgxLastStartGate,
  normalizeDgxMemoryBlocker,
  normalizePublicDgxMemoryWait,
  type PublicDgxMemoryWait,
} from "../shared/dgxMemoryWait.js";
import { releaseSurfaceEntryForRequest } from "../shared/releaseSurface.js";
import {
  jobStartSources,
  type JobStartDecision,
  type JobStartEnforcer,
  type JobStartSource,
} from "./startEnforcer.js";
import { configuredJobStartEnforcer } from "./configuredStartEnforcer.js";
import { DataRecoveryCoordinator } from "./dataRecoveryJournal.js";
import { experimentRequestSha256V1 } from "./experimentDigest.js";
import {
  captureRawMuxPairFile,
  copyRawMuxBoundFile,
  createRawMuxBaselineAuthority,
  pinRawMuxCandidateArtifact,
  rawMuxPairPaths,
  readVerifiedRawMuxBaselineAuthority,
  type RawMuxBaselineAuthority,
} from "./rawMuxBaselineAuthority.js";
import {
  OUTPUT_PUBLICATION_SUFFIX,
  normalizeOutputPublicationAuthority,
  outputPublicationPath,
  persistOutputPublicationAuthority,
  prepareOutputPublicationAuthority,
  readValidOutputPublicationAuthority,
  removeOutputPublicationAuthority,
  terminalJobAuthoritySha256,
  type OutputPublicationAuthority,
} from "./outputPublication.js";
import {
  captureLegacyTerminalHistory,
  legacyArtifactStatsStillMatch,
  normalizeLegacyTerminalHistory,
  type LegacyTerminalHistory,
  type LegacyTerminalStatus,
} from "./legacyOutput.js";
import {
  LocalProcessResourceTelemetryRecorder,
  type LocalProcessResourceIdentity,
  type LocalProcessResourceSample,
  type LocalProcessResourceTelemetryReceipt,
} from "./localProcessResourceTelemetry.js";
import {
  captureLtxResourceTelemetryOutput,
  LTX_RESOURCE_TELEMETRY_MANIFEST_BASENAME,
  ltxResourceTelemetryMeasurementBlockers,
  verifyLtxResourceTelemetryEvidence,
  type LtxResourceTelemetryBinding,
  type LtxResourceTelemetryManifest,
} from "./ltxResourceTelemetryEvidence.js";

const HOST_TCB_DOCKER_ENV: NodeJS.ProcessEnv = Object.freeze({
  PATH: SEALED_EXECUTABLE_PATH,
  LC_ALL: "C",
});

export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";

export type OutputAuthorityReconciliationOperations = {
  removePublicationAuthority: (outputPath: string) => void;
  quarantineUnreleased: (outputPath: string, quarantineRoot: string) => string | null;
};

export type JobManagerStorage = {
  path: string;
  recovery?: {
    coordinator: DataRecoveryCoordinator;
    targetRelativePath: string;
  };
  /** Test/recovery injection; production uses the pinned synchronous writer. */
  fileOperations?: AtomicSnapshotFileOperations;
  /** Fault-injection seam for startup reconciliation; production uses durable marker/quarantine operations. */
  outputAuthorityReconciliationOperations?: Partial<OutputAuthorityReconciliationOperations>;
};

export type ThermalProfile = {
  baselineC: number;
  currentC: number | null;
  peakC: number;
  riseC: number;
  pauseAtC: number;
  resumeBelowC: number;
  updatedAt: string;
};

export const OWNED_DOCKER_THERMAL_WORKLOADS = Object.freeze({
  latentSync: Object.freeze({
    id: "latentsync",
    label: "LatentSync",
    containerPrefix: "ltx-latentsync-",
    resumeHeartbeatPhase: "latentsync_refinement",
  }),
  museTalk: Object.freeze({
    id: "musetalk",
    label: "MuseTalk",
    containerPrefix: "ltx-musetalk-",
    resumeHeartbeatPhase: "musetalk_refinement",
  }),
  lipForcing: Object.freeze({
    id: "lipforcing",
    label: "LipForcing",
    containerPrefix: "ltx-lipforcing-",
    resumeHeartbeatPhase: "lipforcing_refinement",
  }),
} as const);

type OwnedDockerThermalWorkload = typeof OWNED_DOCKER_THERMAL_WORKLOADS[keyof typeof OWNED_DOCKER_THERMAL_WORKLOADS];
type OwnedDockerWorkloadId = OwnedDockerThermalWorkload["id"];
type OwnedDockerContainerState = "bound" | "running" | "paused" | "cleanup";
type OwnedDockerContainerAuthority = {
  schemaVersion: "ltx-studio-owned-docker-container.v2";
  name: string;
  containerId: string | null;
  dgxJobId: string;
  workload: OwnedDockerWorkloadId;
  state: OwnedDockerContainerState;
  /** Durable ambiguity fence written before the FD3 start token is released. */
  startGateReleasedAt: string | null;
  /** Repeated name-absence evidence after a released start gate. */
  absenceProofStartedAt: string | null;
  absenceProofCount: number;
};
type OwnedDockerCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
};
type OwnedDockerOperations = {
  run: (args: readonly string[]) => OwnedDockerCommandResult;
};
type OwnedDockerInspection =
  | { kind: "absent" }
  | { kind: "owned"; containerId: string; paused: boolean; running: boolean };

type ThermalWatcherOperations = Partial<{
  readTemperatureC: () => number | null;
  processIsAlive: (child: ChildProcess) => boolean;
  signalProcessGroup: (child: ChildProcess, signal: NodeJS.Signals) => boolean;
  setHeartbeatPhase: (phase: string) => void;
  onPause: () => void;
  dockerAction: (action: "pause" | "unpause", containerName: string) => boolean;
}>;

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
  project: ProjectRunBinding | null;
  runtimeMs: number | null;
  cancelledBy: "studio" | null;
  /**
   * Public, non-sensitive cancellation settlement state. A terminal-looking
   * local status may still be waiting for process/container absence or the
   * authoritative DGX terminal transition.
   */
  cancellationState?: "requested" | "settling" | "settled" | null;
  thermalProfile: ThermalProfile | null;
  dgxJobId: string | null;
  /** Latest validated, non-authoritative DGX memory wait diagnostic. */
  dgxMemoryWait?: PublicDgxMemoryWait | null;
  identityEvidence: IdentityInputEvidence | null;
  runProvenance: RunProvenance | null;
  /**
   * Missing only for history written before execution classes were persisted.
   * Legacy jobs stay unclassified; neither server nor UI infers a class from
   * logs, timing, or a missing DGX job id.
   */
  executionClass?: JobExecutionClass;
  /** Missing only for persisted history predating versioned ExecutionDecision authority. */
  executionDecision?: JobExecutionDecision;
  /** Durable pre-publication binding; a marker is never its own authority. */
  outputPublication?: OutputPublicationAuthority;
  /** Explicitly non-authoritative history imported from Studio versions before v1.1. */
  historyStatus?: "legacy-unattested";
  /** Historical display value only; never a current queue lease or mutation authority. */
  historicalDgxJobId?: string | null;
};

type DgxOwnerHeartbeatState = {
  jobId: string;
  phase: string;
  progressEpoch: number;
  acknowledgedProgressEpoch: number;
  acknowledgedOnce: boolean;
  lastAcknowledgedAt: number;
  lastProgressAt: number;
  failureStartedAt?: number;
  consecutiveFailures: number;
  stopped: boolean;
  timer?: NodeJS.Timeout;
  safetyTimer?: NodeJS.Timeout;
  inFlight?: Promise<void>;
  lastError?: string;
  activationBlockReason?: string;
};

type RuntimeJob = StudioJob & {
  localProcessProtocol: "fd-gate.v1";
  startSource: JobStartSource;
  /**
   * Durable prepare/commit fence. A deferred job may be persisted before an
   * external experiment/project CAS, but it must never execute until
   * `startQueued()` has durably armed it after that CAS succeeds.
   */
  startDeferred: boolean;
  plan: CommandPlan;
  /**
   * Exact JSON value whose canonical digest is bound by the persisted ExecutionDecision.
   * The parsed editor request may contain later schema defaults, but this value
   * is never migrated or exposed through the public job API.
   */
  authorityBoundRequest: unknown;
  authorityRequestSha256: string;
  /** Old T2A requests had no peak-ceiling field and cannot be replayed exactly. */
  legacyTextToAudioPeakCeilingUnset: boolean;
  /** Read-only preservation receipt; cannot authorize execution, reuse, analysis, or quality GO. */
  legacyHistory?: LegacyTerminalHistory;
  /** Durable local preparation; never a remote completed intent by itself. */
  outputPublicationCommitPending?: OutputPublicationCommitPending;
  process?: ChildProcess;
  processTermination?: Promise<void>;
  localProcessSpawnPending?: boolean;
  localProcessGroupPending?: boolean;
  localProcessGroupIdentity?: LocalProcessGroupIdentity;
  localProcessGroupRetry?: NodeJS.Timeout;
  /**
   * Exact, private cleanup authority for one Studio-created Docker refiner.
   * Presence means that the named container may still exist; it is cleared
   * only after an identity-bound `docker container inspect` proves absence.
   */
  ownedDockerContainer?: OwnedDockerContainerAuthority;
  /** Runtime receipt that the current immutable ID was successfully snapshotted. */
  ownedDockerContainerIdDurablyCommitted?: boolean;
  ownedDockerContainerRecoveryBlocked?: boolean;
  ownedDockerContainerCleanup?: Promise<boolean>;
  ownedDockerContainerRetry?: NodeJS.Timeout;
  dgxSubmitPending?: boolean;
  dgxSubmitStartedAt?: string;
  /** Exact canonical POST body retained until an ambiguous submit is resolved. */
  dgxPreparedAdmission?: AdmissionRequest;
  dgxPreparedAdmissionSha256?: string;
  dgxSubmitReconcileRetry?: NodeJS.Timeout;
  dgxSubmitReconcileInFlight?: Promise<void>;
  dgxSubmitReconcileDelayMs?: number;
  dgxAdmissionAbortController?: AbortController;
  dgxJobTerminal?: boolean;
  /** Durable mutation authority acquired only from an exact submit response. */
  dgxLeaseReceipt?: DgxLeaseReceipt;
  dgxStateTransitionInFlight?: Promise<boolean>;
  dgxTerminalDelivery?: DgxTerminalDelivery;
  /** Durable proof that this exact remote lease was observed terminal. */
  dgxTerminalReceipt?: DgxTerminalReceipt;
  /** One-shot authority for replacing one exact never-started terminal lease. */
  dgxSuccessorAuthorization?: DgxSuccessorAuthorization;
  dgxSuccessorSubmitInFlight?: Promise<DgxSuccessorSubmitOutcome>;
  dgxTerminalDeliveryInFlight?: Promise<boolean>;
  dgxTerminalRetry?: NodeJS.Timeout;
  dgxOwnerHeartbeat?: DgxOwnerHeartbeatState;
};

class DgxCooperativeQueueContractError extends Error {
  constructor(message: string, readonly observedRemoteState: QueueJobState) {
    super(message);
    this.name = "DgxCooperativeQueueContractError";
  }
}

type RawOutputCandidateAuthorityJob = Pick<
  RuntimeJob,
  "request" | "experiment" | "runProvenance" | "identityEvidence"
>;
type ProcessResult = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };
type LtxResourceTelemetrySettlement = {
  receipt: LocalProcessResourceTelemetryReceipt | null;
  observerError: string | null;
};
type ActiveLtxResourceTelemetry = {
  binding: LtxResourceTelemetryBinding;
  controller: AbortController;
  evidenceDirectory: string;
  thermalPauseCount: number;
  settlement: Promise<LtxResourceTelemetrySettlement>;
};
type BoundProcessOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  inheritedFds?: readonly number[];
  boundExecutable?: BoundExecutableDescriptor;
  recheckExecutables?: readonly BoundExecutableDescriptor[];
  recheckDescriptors?: readonly VerifiedExecutionDescriptor[];
  startGate?: boolean;
  genericGate?: boolean;
};

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
type OutputPublicationCommitPending = {
  schemaVersion: "ltx-studio-output-publication-commit.v1";
  completedAt: string;
  completionMetadata: DgxTransitionMetadata;
};
type DgxTerminalState = Extract<QueueTransitionState, "completed" | "failed" | "cancelled">;
type DgxObservedTerminalState = DgxTerminalState | "rejected";
type DgxTerminalDelivery = {
  state: DgxTerminalState;
  metadata: DgxTransitionMetadata;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
};
type DgxTerminalReceipt = {
  schemaVersion: "ltx-studio-dgx-terminal-receipt.v1";
  studioJobId: string;
  dgxJobId: string;
  idempotencyKey: string;
  localIntentState: DgxTerminalState;
  remoteTerminalState: DgxObservedTerminalState;
  confirmedAt: string;
  evidence:
    | {
        kind: "job-read";
        schemaVersion: "dgx-job-read.v0";
        requestedBy: string;
        sourceApp: "LTX Studio";
        idempotencyKey: string;
      }
    | {
        kind: "job-transition";
        schemaVersion: "dgx-job-transition.v0";
        requestedBy: string;
        sourceApp: "LTX Studio";
        idempotencyKey: string;
      }
    | {
        kind: "queue-submit";
        schemaVersion: "dgx-queue-submit.v0";
        requestedBy: string;
        sourceApp: "LTX Studio";
        idempotencyKey: string;
      }
    | {
        kind: "queue-replay";
        schemaVersion: "dgx-queue-submit.v0";
        requestedBy: string;
        sourceApp: "LTX Studio";
        idempotencyKey: string;
        replayBoundJobId: string;
        idempotentReplay: true;
      }
    | {
        kind: "job-gone";
        schemaVersion: "dgx-job-gone.v0";
        idempotencyKey: string;
        finishedAt: string;
        reapedAt: string;
        reason: string | null;
      }
    | {
        kind: "job-gone";
        schemaVersion: "ltx-studio-dgx-job-gone-evidence.v1";
        runtimeSchemaVersion: "dgx-job-gone.v0";
        idempotencyKey: string;
        requestSha256: string;
        finishedAt: string;
        reapedAt: string;
        reason: string | null;
      }
    | {
        kind: "conditional-successor";
        schemaVersion: "dgx-conditional-successor-result.v0";
        successorToken: string;
        predecessorDgxJobId: string;
        requestSha256: string;
        outcome: "created" | "terminal";
        requestedBy: string;
        sourceApp: "LTX Studio";
        idempotencyKey: string;
      }
    | {
        kind: "conditional-successor-reaped";
        schemaVersion: "dgx-conditional-successor-result.v0";
        runtimeEvidenceSchemaVersion: "dgx-conditional-successor-terminal.v0";
        successorToken: string;
        predecessorDgxJobId: string;
        requestSha256: string;
        idempotencyKey: string;
        createdAt: string;
        startedAt: string | null;
        finishedAt: string;
        reapedAt: string;
        decision: string;
        reason: string;
        clientAction: string;
        recordSha256: string;
      };
};
type DgxLeaseReceipt = {
  schemaVersion: "ltx-studio-dgx-lease-receipt.v1";
  studioJobId: string;
  dgxJobId: string;
  requestedBy: string;
  sourceApp: "LTX Studio";
  idempotencyKey: string;
  preparedAdmission: AdmissionRequest;
  preparedAdmissionSha256: string;
  submitStartedAt: string;
  observedState: "accepted" | "queued";
  observedCreatedAt: string;
  evidence:
    | {
        kind: "submit-response";
        schemaVersion: "dgx-queue-submit.v0";
      }
    | {
        kind: "queue-positive";
        schemaVersion: "dgx-queue-read.v0";
        observedAt: string;
      }
    | {
        kind: "conditional-successor";
        schemaVersion: "dgx-conditional-successor-result.v0";
        successorToken: string;
        predecessorDgxJobId: string;
        requestSha256: string;
        outcome: "created" | "replayed";
      };
  confirmedAt: string;
};
type DgxSuccessorReplayEvidence = {
  kind: "exact-bound-replay";
  schemaVersion: "dgx-queue-submit.v0";
  replayBoundJobId: string;
  idempotentReplay: true;
  terminalState: Extract<DgxObservedTerminalState, "failed" | "rejected" | "cancelled">;
  reservationActive: false;
  admissionReservationActive: false;
  startedAt: null | "";
  admissionDecision: "rejected_terminal_record";
  admissionReason: "unstarted_terminal_record_released";
  clientAction: "retry_now_key_is_free";
};
type DgxSuccessorAuthorizationBase = {
  schemaVersion: "ltx-studio-dgx-successor-authorization.v1";
  generation: 1;
  successorToken: string;
  studioJobId: string;
  predecessorDgxJobId: string;
  predecessorLeaseReceipt: DgxLeaseReceipt;
  predecessorLeaseReceiptSha256: string;
  preparedAdmissionSha256: string;
  requestSha256: string;
  authorizedAt: string;
  replayEvidence: DgxSuccessorReplayEvidence;
};
type DgxSuccessorAuthorization = DgxSuccessorAuthorizationBase & (
  | {
      phase: "submit-pending";
    }
  | {
      phase: "consumed";
      successorDgxJobId: string;
      successorAuthorityKind: "lease" | "terminal";
      successorAuthorityReceipt: DgxLeaseReceipt | DgxTerminalReceipt;
      successorAuthoritySha256: string;
      consumedAt: string;
    }
);
type DgxSuccessorSubmitOutcome =
  | { kind: "positive"; remote: QueueJobSummary }
  | { kind: "terminal" }
  | { kind: "ambiguous" };
type DgxValidatedConditionalSuccessorResult =
  | {
      kind: "positive";
      result: ConditionalSuccessorResult;
      remote: QueueJobSummary;
      receipt: DgxLeaseReceipt;
    }
  | {
      kind: "terminal";
      result: ConditionalSuccessorResult;
      observation: DgxTerminalObservation;
    };
type DgxStartOutcome = "started" | "queued" | "stopped";
type LocalProcessGroupIdentity = {
  bootId: string;
  processGroupId: number;
  leaderStartTicks: string;
};
type PersistedStudioJob = Omit<StudioJob, "request"> & {
  request: unknown;
  legacyHistory?: LegacyTerminalHistory;
  /** Durable pre-marker phase; remote completed is forbidden until this clears after marker commit. */
  outputPublicationCommitPending?: OutputPublicationCommitPending;
  localProcessProtocol?: "fd-gate.v1";
  startSource?: JobStartSource;
  startDeferred?: boolean;
  dgxTerminalDelivery?: DgxTerminalDelivery;
  dgxTerminalReceipt?: DgxTerminalReceipt;
  dgxLeaseReceipt?: DgxLeaseReceipt;
  localProcessSpawnPending?: boolean;
  localProcessGroupPending?: boolean;
  localProcessGroupIdentity?: LocalProcessGroupIdentity;
  ownedDockerContainer?: OwnedDockerContainerAuthority;
  ownedDockerContainerRecoveryBlocked?: boolean;
  dgxSubmitPending?: boolean;
  dgxSubmitStartedAt?: string;
  dgxPreparedAdmission?: AdmissionRequest;
  dgxPreparedAdmissionSha256?: string;
  dgxSuccessorAuthorization?: DgxSuccessorAuthorization;
};

export type ArchivedOutputAuthority = {
  schemaVersion: "ltx-studio-archived-output-authority.v1";
  id: string;
  status: "completed";
  outputName: string;
  finishedAt: string;
  executionClass: "dgx" | "cpu-only";
  executionDecisionSha256: string;
  requestSha256: string;
  protocolSha256: string | null;
  cpuOutputSha256: string | null;
  runProvenanceSha256: string;
  identityEvidenceSha256: string | null;
  experimentSha256: string | null;
  projectSha256: string | null;
  outputPublication: OutputPublicationAuthority;
};

export type CurrentOutputAuthorityJob = StudioJob & {
  /** Internal-only raw request binding; output storage must not serialize it via an API. */
  authorityBoundRequest?: unknown;
  authorityRequestSha256?: string;
  legacyHistory?: LegacyTerminalHistory;
  outputPublicationCommitPending?: OutputPublicationCommitPending;
};

export type OutputAuthorityJob = CurrentOutputAuthorityJob | ArchivedOutputAuthority;

type PersistedOutputAuthorityArchive = {
  schemaVersion: "ltx-studio-output-authority-archive.v1";
  entries: ArchivedOutputAuthority[];
};
type DgxQueueOperations = {
  read: typeof readQueueJob;
  transition: typeof transitionQueueJob;
  heartbeat?: typeof heartbeatQueueJob;
};
type DgxAdmissionOperations = {
  submit: typeof submitPreparedQueueAdmission;
  replay?: typeof replayPreparedQueueAdmission;
  list?: typeof listQueueJobs;
  successor?: typeof submitConditionalQueueSuccessor;
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

type JobCreateMetadata = {
  variantOf?: string | null;
  experiment?: ExperimentRunBinding | null;
  project?: ProjectRunBinding | null;
  deferStart?: boolean;
};

const MAX_JOBS = 100;
export const MAX_ACTIVE_JOBS = 8;
const STUDIO_JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LOG_LINES = 600;
const MAX_LOG_LINE_LENGTH = 4000;
const RESOURCE_RETRY_INTERVAL_MS = 10_000;
const RESOURCE_WAIT_LOG_INTERVAL_MS = 60_000;
const MAX_RUNNING_PROCESS_PROGRESS = 95;
const DEFAULT_DGX_TERMINAL_RETRY_BASE_MS = 5_000;
const MAX_DGX_TERMINAL_RETRY_MS = 60_000;
const DGX_START_FENCE_RETRY_MS = 30_000;
const DGX_SUBMIT_RECONCILE_POLL_MS = 2_000;
const OWNED_DOCKER_CONTAINER_RECONCILE_MS = 2_000;
const OWNED_DOCKER_CREATION_QUIESCENCE_MS = 4_000;
const OWNED_DOCKER_CREATION_ABSENCE_PROOFS = 3;
const OWNED_DOCKER_IDENTITY_DISCOVERY_MS = 10_000;
const GENERIC_PROCESS_START_GATE_CODE = [
  "import os,sys",
  "token=os.read(3,2)",
  "os.close(3)",
  "token == b'1' or os._exit(125)",
  "count=int(sys.argv[1])",
  "[(os.dup2(fd+1,fd)) for fd in range(3,3+count)]",
  "count == 0 or os.close(3+count)",
  "os.execvpe(sys.argv[2],[sys.argv[2],*sys.argv[3:]],os.environ)",
].join(";");
export const DGX_OWNER_HEARTBEAT_INTERVAL_MS = Math.min(
  60_000,
  Math.max(
    1_000,
    Number.parseInt(process.env.LTX_STUDIO_DGX_HEARTBEAT_INTERVAL_MS ?? "45000", 10) || 45_000,
  ),
);
export const DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS = Math.min(
  110_000,
  Math.max(3_000, DGX_OWNER_HEARTBEAT_INTERVAL_MS * 2),
);
export const DGX_OWNER_NO_PROGRESS_TIMEOUT_MS = Math.max(
  60_000,
  Number.parseInt(process.env.LTX_STUDIO_DGX_NO_PROGRESS_TIMEOUT_MS ?? "600000", 10) || 600_000,
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
const DGX_POSITIVE_DISCOVERY_STATES = new Set<QueueJobState>(["accepted", "queued"]);
const DGX_MEMORY_WAIT_RESOLVED_STATES = new Set<QueueJobState>([
  "starting",
  "running",
  "pausing",
  "resuming",
  "completed",
  "failed",
  "cancelled",
  "rejected",
]);
const DGX_QUEUE_JOB_STATES = new Set<QueueJobState>([
  "submitted",
  "accepted",
  "queued",
  "starting",
  "running",
  "pausing",
  "paused",
  "resuming",
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

function runtimePayloadBlocker(error: unknown): unknown {
  if (!(error instanceof RuntimeApiError)
    || !error.payload
    || typeof error.payload !== "object"
    || Array.isArray(error.payload)) return undefined;
  return (error.payload as Record<string, unknown>).blocker;
}

type QueueJobMemoryObservation = {
  blocker: unknown;
  observedAt?: string;
  authoritative: boolean;
};

function queueJobMemoryObservation(
  job: QueueJobSummary,
  fallbackBlocker?: unknown,
): QueueJobMemoryObservation {
  if (DGX_MEMORY_WAIT_RESOLVED_STATES.has(job.state)) {
    return { blocker: undefined, authoritative: true };
  }
  if (job.blocker !== undefined) {
    return { blocker: job.blocker, authoritative: true };
  }
  const lastStartGate = (job.state === "accepted" || job.state === "queued")
    && isDgxNeverStarted(job.started_at)
    && job.durable_waiter === false
    && job.segment_waiter === false
    && job.prestart_only_waiter === false
    ? normalizeDgxLastStartGate(job.last_start_gate)
    : null;
  if (lastStartGate) {
    const rawGate = job.last_start_gate as Record<string, unknown>;
    return {
      blocker: rawGate.blocker,
      ...(rawGate.blocker === undefined ? {} : { observedAt: lastStartGate.observedAt }),
      // A valid blockerless restore observation is still authoritative: it
      // must clear an older memory equation instead of reviving admission data.
      authoritative: true,
    };
  }
  return {
    blocker: fallbackBlocker,
    authoritative: fallbackBlocker !== undefined,
  };
}

function queueJobMemoryBlocker(
  job: QueueJobSummary,
  fallbackBlocker?: unknown,
): unknown {
  return queueJobMemoryObservation(job, fallbackBlocker).blocker;
}

type DgxTerminalObservation = {
  state: DgxObservedTerminalState;
  evidence: DgxTerminalReceipt["evidence"];
};

type DgxBoundReplayResult =
  | {
      kind: "response";
      response: QueueSubmitResponse;
      receipt: DgxLeaseReceipt;
    }
  | {
      kind: "gone";
      observation: DgxTerminalObservation;
      receipt: DgxLeaseReceipt;
    }
  | {
      kind: "successor-already-authorized";
      receipt: DgxLeaseReceipt;
    };

function dgxResponseBoundJob(
  value: unknown,
  kind: "job-read" | "job-transition" | "job-heartbeat",
  expectedDgxJobId: string,
  expectedStudioJobId: string,
): QueueJobSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const expectedSchema = kind === "job-read"
    ? "dgx-job-read.v0"
    : kind === "job-transition"
      ? "dgx-job-transition.v0"
      : "dgx-job-heartbeat.v0";
  if (response.schema_version !== expectedSchema
    || (kind === "job-transition" && response.transition_applied !== true)
    || (kind === "job-heartbeat"
      && response.heartbeat_applied !== undefined
      && response.heartbeat_applied !== true)
    || !response.job
    || typeof response.job !== "object"
    || Array.isArray(response.job)) return null;
  const remoteJob = response.job as Record<string, unknown>;
  const expectedCaller = `ltx-studio:${expectedStudioJobId}`;
  if (!isDgxJobId(remoteJob.job_id)
    || remoteJob.job_id !== expectedDgxJobId
    || typeof remoteJob.state !== "string"
    || !DGX_QUEUE_JOB_STATES.has(remoteJob.state as QueueJobState)
    || remoteJob.requested_by !== expectedCaller
    || remoteJob.source_app !== "LTX Studio"
    || remoteJob.idempotency_key !== expectedCaller) return null;
  return remoteJob as QueueJobSummary;
}

function dgxResponseJobState(
  value: unknown,
  kind: "job-read" | "job-transition",
  expectedDgxJobId: string,
  expectedStudioJobId: string,
): QueueJobState | null {
  return dgxResponseBoundJob(value, kind, expectedDgxJobId, expectedStudioJobId)?.state ?? null;
}

function dgxQueueJobCallerBound(
  value: unknown,
  expectedStudioJobId: string,
): value is QueueJobSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const job = value as Record<string, unknown>;
  const expectedCaller = `ltx-studio:${expectedStudioJobId}`;
  return isDgxJobId(job.job_id)
    && typeof job.state === "string"
    && DGX_QUEUE_JOB_STATES.has(job.state as QueueJobState)
    && job.requested_by === expectedCaller
    && job.source_app === "LTX Studio"
    && job.idempotency_key === expectedCaller;
}

function dgxSubmitResponseCallerBound(
  value: unknown,
  expectedStudioJobId: string,
): value is QueueSubmitResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return response.schema_version === "dgx-queue-submit.v0"
    && dgxQueueJobCallerBound(response.job, expectedStudioJobId)
    && Boolean(response.admission)
    && typeof response.admission === "object"
    && !Array.isArray(response.admission)
    && typeof (response.admission as Record<string, unknown>).decision === "string";
}

/**
 * Proves that a replay-endpoint response is an idempotent observation of the
 * already durable lease. A caller-bound submit envelope alone is insufficient:
 * a drifted orchestrator could otherwise return a newly created job for the
 * same Studio UUID and silently replace mutation authority.
 */
function dgxReplayResponseLeaseBound(
  value: unknown,
  receipt: DgxLeaseReceipt,
): value is QueueSubmitResponse {
  if (!dgxSubmitResponseCallerBound(value, receipt.studioJobId)) return false;
  const response = value as QueueSubmitResponse;
  const createdAt = canonicalIsoTimestamp(response.job.created_at);
  if (response.admission.idempotent_replay !== true
    || response.admission.replay_bound_job_id !== receipt.dgxJobId
    || (response.admission.job_id !== undefined
      && response.admission.job_id !== receipt.dgxJobId)
    || response.job.job_id !== receipt.dgxJobId
    || createdAt !== receipt.observedCreatedAt
    || !dgxQueueJobIdentityMatchesPreparedAdmission(
      response.job,
      receipt.studioJobId,
      receipt.preparedAdmission,
      receipt.submitStartedAt,
    )) return false;
  if (DGX_POSITIVE_DISCOVERY_STATES.has(response.job.state)
    && !isDgxNeverStarted(response.job.started_at)) return false;
  if (response.job.state === "queued"
    && (response.admission.decision !== "queued"
      || response.job.reservation_active !== false)) return false;
  if (response.job.state === "accepted"
    && (response.admission.decision !== "accepted"
      || typeof response.job.reservation_active !== "boolean")) return false;
  if (DGX_REMOTE_TERMINAL_STATES.has(response.job.state)
    && response.job.reservation_active !== false) return false;
  // An accepted durable waiter can legitimately still report
  // reservation_active=false until the subsequent authoritative start-fence.
  // Therefore replay identity must not reuse the initial lease-acquisition
  // predicate, which intentionally requires accepted=>reservation_active.
  return DGX_POSITIVE_DISCOVERY_STATES.has(response.job.state)
    || DGX_REMOTE_TERMINAL_STATES.has(response.job.state);
}

function dgxRetryNowSuccessorEvidence(
  value: QueueSubmitResponse,
  receipt: DgxLeaseReceipt,
): DgxSuccessorReplayEvidence | null {
  if (!dgxReplayResponseLeaseBound(value, receipt)
    || (value.job.state !== "failed"
      && value.job.state !== "rejected"
      && value.job.state !== "cancelled")
    || value.job.reservation_active !== false
    || value.admission.reservation_active !== false
    || !isDgxNeverStarted(value.job.started_at)
    || value.admission.decision !== "rejected_terminal_record"
    || value.admission.reason !== "unstarted_terminal_record_released"
    || value.admission.client_action !== "retry_now_key_is_free") return null;
  return {
    kind: "exact-bound-replay",
    schemaVersion: "dgx-queue-submit.v0",
    replayBoundJobId: receipt.dgxJobId,
    idempotentReplay: true,
    terminalState: value.job.state,
    reservationActive: false,
    admissionReservationActive: false,
    startedAt: value.job.started_at,
    admissionDecision: "rejected_terminal_record",
    admissionReason: "unstarted_terminal_record_released",
    clientAction: "retry_now_key_is_free",
  };
}

function dgxQueueJobIdentityMatchesPreparedAdmission(
  remote: QueueJobSummary,
  studioJobId: string,
  preparedAdmission: AdmissionRequest,
  submitStartedAt: string,
): boolean {
  const remoteCreatedAt = canonicalIsoTimestamp(remote.created_at);
  const localSubmitStartedAt = canonicalIsoTimestamp(submitStartedAt);
  return isDgxJobId(remote.job_id)
    && remote.requested_by === `ltx-studio:${studioJobId}`
    && remote.requested_by === preparedAdmission.requested_by
    && remote.source_app === preparedAdmission.source_app
    && remote.job_type === preparedAdmission.job_type
    && remote.runtime === preparedAdmission.runtime
    && remote.priority === preparedAdmission.priority
    && remote.exclusive_runtime === preparedAdmission.resource_profile.exclusive_runtime
    && remote.idempotency_key === preparedAdmission.idempotency_key
    && remoteCreatedAt !== null
    && localSubmitStartedAt !== null
    && Date.parse(remoteCreatedAt) >= Date.parse(localSubmitStartedAt);
}

function dgxQueueJobMatchesPreparedAdmission(
  remote: QueueJobSummary,
  studioJobId: string,
  preparedAdmission: AdmissionRequest,
  submitStartedAt: string,
): boolean {
  return DGX_POSITIVE_DISCOVERY_STATES.has(remote.state)
    && isDgxNeverStarted(remote.started_at)
    && remote.reservation_active === (remote.state === "accepted")
    && dgxQueueJobIdentityMatchesPreparedAdmission(
      remote,
      studioJobId,
      preparedAdmission,
      submitStartedAt,
    );
}

function dgxLeaseReceiptFromBoundJob(
  remote: QueueJobSummary,
  studioJobId: string,
  preparedAdmission: AdmissionRequest,
  submitStartedAt: string,
  evidence: DgxLeaseReceipt["evidence"],
): DgxLeaseReceipt {
  const observedCreatedAt = canonicalIsoTimestamp(remote.created_at);
  if (!dgxQueueJobMatchesPreparedAdmission(
    remote,
    studioJobId,
    preparedAdmission,
    submitStartedAt,
  )
    || !observedCreatedAt
    || preparedAdmission.requested_by !== `ltx-studio:${studioJobId}`
    || preparedAdmission.idempotency_key !== preparedAdmission.requested_by
    || preparedAdmission.source_app !== "LTX Studio") {
    throw new Error("DGX-Lease-Receipt kann nur aus einem exakt gebundenen Submit entstehen.");
  }
  return {
    schemaVersion: "ltx-studio-dgx-lease-receipt.v1",
    studioJobId,
    dgxJobId: remote.job_id,
    requestedBy: preparedAdmission.requested_by,
    sourceApp: "LTX Studio",
    idempotencyKey: preparedAdmission.idempotency_key,
    preparedAdmission: structuredClone(preparedAdmission),
    preparedAdmissionSha256: preparedAdmissionSha256(preparedAdmission),
    submitStartedAt: canonicalIsoTimestamp(submitStartedAt)!,
    observedState: remote.state as "accepted" | "queued",
    observedCreatedAt,
    evidence: structuredClone(evidence),
    confirmedAt: now(),
  };
}

function dgxLeaseReceiptFromSubmit(
  response: QueueSubmitResponse,
  studioJobId: string,
  preparedAdmission: AdmissionRequest,
  submitStartedAt: string,
): DgxLeaseReceipt {
  if (!dgxSubmitResponseCallerBound(response, studioJobId)) {
    throw new Error("DGX-Lease-Receipt kann nur aus einer exakt gebundenen Submit-Antwort entstehen.");
  }
  return dgxLeaseReceiptFromBoundJob(response.job, studioJobId, preparedAdmission, submitStartedAt, {
    kind: "submit-response",
    schemaVersion: "dgx-queue-submit.v0",
  });
}

function dgxLeaseReceiptFromQueuePositive(
  remote: QueueJobSummary,
  studioJobId: string,
  preparedAdmission: AdmissionRequest,
  submitStartedAt: string,
): DgxLeaseReceipt {
  return dgxLeaseReceiptFromBoundJob(remote, studioJobId, preparedAdmission, submitStartedAt, {
    kind: "queue-positive",
    schemaVersion: "dgx-queue-read.v0",
    observedAt: now(),
  });
}

const CONDITIONAL_SUCCESSOR_RESULT_FIELDS = [
  "schema_version",
  "successor_token",
  "predecessor_job_id",
  "successor_job_id",
  "request_sha256",
  "created",
  "outcome",
  "job",
  "admission",
  "terminal_evidence",
] as const;

const CONDITIONAL_SUCCESSOR_TERMINAL_FIELDS = [
  "schema_version",
  "job_id",
  "state",
  "created_at",
  "started_at",
  "finished_at",
  "reaped_at",
  "request_sha256",
  "idempotency_key",
  "decision",
  "reason",
  "client_action",
  "record_sha256",
] as const;

function lowercaseSha256Equals(left: unknown, right: unknown): left is string {
  if (typeof left !== "string"
    || typeof right !== "string"
    || !/^[0-9a-f]{64}$/.test(left)
    || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

function dgxConditionalSuccessorStatusIsAmbiguous(statusCode: number | null): boolean {
  return statusCode === null
    || statusCode === 408
    || statusCode === 425
    || statusCode === 429
    || (statusCode >= 500 && statusCode <= 599);
}

function conditionalSuccessorEnvelope(
  value: unknown,
  authorization: DgxSuccessorAuthorization,
  preparedAdmission: AdmissionRequest,
): ConditionalSuccessorResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (!hasExactKeys(candidate, CONDITIONAL_SUCCESSOR_RESULT_FIELDS)
    || candidate.schema_version !== "dgx-conditional-successor-result.v0"
    || !lowercaseSha256Equals(candidate.successor_token, authorization.successorToken)
    || candidate.predecessor_job_id !== authorization.predecessorDgxJobId
    || !isDgxJobId(candidate.successor_job_id)
    || candidate.successor_job_id === authorization.predecessorDgxJobId
    || !lowercaseSha256Equals(candidate.request_sha256, authorization.requestSha256)
    || !dgxRuntimeRequestSha256Matches(preparedAdmission, candidate.request_sha256)
    || typeof candidate.created !== "boolean"
    || (candidate.outcome !== "created"
      && candidate.outcome !== "replayed"
      && candidate.outcome !== "terminal"
      && candidate.outcome !== "reaped")
    || candidate.created !== (candidate.outcome === "created")) return null;
  return candidate as unknown as ConditionalSuccessorResult;
}

function validateRetainedConditionalSuccessorResult(
  value: unknown,
  authorization: DgxSuccessorAuthorization,
  preparedAdmission: AdmissionRequest,
): DgxValidatedConditionalSuccessorResult | null {
  const result = conditionalSuccessorEnvelope(value, authorization, preparedAdmission);
  const createdAtMs = result?.job
    ? parseStrictOffsetDateTime(result.job.created_at)
    : null;
  const authorizedAtMs = parseStrictOffsetDateTime(authorization.authorizedAt);
  if (!result
    || result.outcome === "reaped"
    || result.terminal_evidence !== null
    || !result.job
    || typeof result.job !== "object"
    || Array.isArray(result.job)
    || !result.admission
    || typeof result.admission !== "object"
    || Array.isArray(result.admission)
    || createdAtMs === null
    || authorizedAtMs === null
    || createdAtMs < authorizedAtMs
    || result.job.job_id !== result.successor_job_id
    || !dgxQueueJobCallerBound(result.job, authorization.studioJobId)
    || !dgxQueueJobIdentityMatchesPreparedAdmission(
      result.job,
      authorization.studioJobId,
      preparedAdmission,
      authorization.authorizedAt,
    )
    || typeof result.admission.decision !== "string"
    || (result.admission.job_id !== undefined
      && result.admission.job_id !== result.successor_job_id)) return null;

  if (DGX_POSITIVE_DISCOVERY_STATES.has(result.job.state)) {
    const reservationActive = result.job.state === "accepted";
    if (result.outcome === "terminal"
      || !dgxQueueJobMatchesPreparedAdmission(
        result.job,
        authorization.studioJobId,
        preparedAdmission,
        authorization.authorizedAt,
      )
      || result.admission.job_id !== result.successor_job_id
      || result.job.reservation_active !== reservationActive
      || result.admission.reservation_active !== reservationActive
      || result.admission.decision !== result.job.state
      || result.job.decision !== result.admission.decision
      || result.job.reason !== result.admission.reason
      || result.job.client_action !== result.admission.client_action) return null;
    const receipt = dgxLeaseReceiptFromBoundJob(
      result.job,
      authorization.studioJobId,
      preparedAdmission,
      authorization.authorizedAt,
      {
        kind: "conditional-successor",
        schemaVersion: "dgx-conditional-successor-result.v0",
        successorToken: authorization.successorToken,
        predecessorDgxJobId: authorization.predecessorDgxJobId,
        requestSha256: authorization.requestSha256,
        outcome: result.outcome,
      },
    );
    return { kind: "positive", result, remote: result.job, receipt };
  }

  const finishedAtMs = parseStrictOffsetDateTime(result.job.finished_at);
  const updatedAtMs = parseStrictOffsetDateTime(result.job.updated_at);
  const neverStarted = isDgxNeverStarted(result.job.started_at);
  const startedAtMs = neverStarted
    ? null
    : parseStrictOffsetDateTime(result.job.started_at);
  if (!DGX_REMOTE_TERMINAL_STATES.has(result.job.state)
    || result.job.reservation_active !== false
    || result.admission.reservation_active !== false
    || finishedAtMs === null
    || updatedAtMs === null
    || (!neverStarted && startedAtMs === null)
    || finishedAtMs < createdAtMs
    || (startedAtMs !== null
      && (startedAtMs < createdAtMs || startedAtMs > finishedAtMs))
    || updatedAtMs < finishedAtMs
    || updatedAtMs > Date.now()
    || typeof result.admission.decision !== "string"
    || result.admission.decision.length === 0
    || typeof result.admission.reason !== "string"
    || result.admission.reason.length === 0
    || typeof result.admission.client_action !== "string"
    || result.admission.client_action.length === 0
    || result.job.decision !== result.admission.decision
    || result.job.reason !== result.admission.reason
    || result.job.client_action !== result.admission.client_action
    || (result.outcome !== "created" && result.outcome !== "terminal")) return null;
  const expectedCaller = `ltx-studio:${authorization.studioJobId}`;
  return {
    kind: "terminal",
    result,
    observation: {
      state: result.job.state as DgxObservedTerminalState,
      evidence: {
        kind: "conditional-successor",
        schemaVersion: "dgx-conditional-successor-result.v0",
        successorToken: authorization.successorToken,
        predecessorDgxJobId: authorization.predecessorDgxJobId,
        requestSha256: authorization.requestSha256,
        outcome: result.outcome,
        requestedBy: expectedCaller,
        sourceApp: "LTX Studio",
        idempotencyKey: expectedCaller,
      },
    },
  };
}

function validateReapedConditionalSuccessorResult(
  value: unknown,
  authorization: DgxSuccessorAuthorization,
  preparedAdmission: AdmissionRequest,
): DgxValidatedConditionalSuccessorResult | null {
  const result = conditionalSuccessorEnvelope(value, authorization, preparedAdmission);
  if (!result
    || result.outcome !== "reaped"
    || result.created !== false
    || result.job !== null
    || result.admission !== null
    || !result.terminal_evidence
    || typeof result.terminal_evidence !== "object"
    || Array.isArray(result.terminal_evidence)) return null;
  const evidence = result.terminal_evidence as ConditionalSuccessorTerminalEvidence;
  if (!hasExactKeys(
    evidence as unknown as Record<string, unknown>,
    CONDITIONAL_SUCCESSOR_TERMINAL_FIELDS,
  )
    || evidence.schema_version !== "dgx-conditional-successor-terminal.v0"
    || evidence.job_id !== result.successor_job_id
    || !DGX_REMOTE_TERMINAL_STATES.has(evidence.state)
    || !lowercaseSha256Equals(evidence.request_sha256, authorization.requestSha256)
    || evidence.idempotency_key !== preparedAdmission.idempotency_key
    || !/^[0-9a-f]{64}$/.test(evidence.record_sha256)
    || typeof evidence.decision !== "string"
    || !evidence.decision
    || typeof evidence.reason !== "string"
    || !evidence.reason
    || typeof evidence.client_action !== "string"
    || !evidence.client_action) return null;
  const createdAtMs = parseStrictOffsetDateTime(evidence.created_at);
  const finishedAtMs = parseStrictOffsetDateTime(evidence.finished_at);
  const reapedAtMs = parseStrictOffsetDateTime(evidence.reaped_at);
  const authorizedAtMs = parseStrictOffsetDateTime(authorization.authorizedAt);
  const startedAtMs = isDgxNeverStarted(evidence.started_at)
    ? null
    : parseStrictOffsetDateTime(evidence.started_at);
  if (createdAtMs === null
    || finishedAtMs === null
    || reapedAtMs === null
    || authorizedAtMs === null
    || (!isDgxNeverStarted(evidence.started_at) && startedAtMs === null)
    || createdAtMs < authorizedAtMs
    || finishedAtMs < createdAtMs
    || (startedAtMs !== null && (startedAtMs < createdAtMs || startedAtMs > finishedAtMs))
    || reapedAtMs < finishedAtMs
    || reapedAtMs > Date.now()) return null;
  return {
    kind: "terminal",
    result,
    observation: {
      state: evidence.state,
      evidence: {
        kind: "conditional-successor-reaped",
        schemaVersion: "dgx-conditional-successor-result.v0",
        runtimeEvidenceSchemaVersion: "dgx-conditional-successor-terminal.v0",
        successorToken: authorization.successorToken,
        predecessorDgxJobId: authorization.predecessorDgxJobId,
        requestSha256: authorization.requestSha256,
        idempotencyKey: evidence.idempotency_key,
        createdAt: new Date(createdAtMs).toISOString(),
        startedAt: isDgxNeverStarted(evidence.started_at)
          ? evidence.started_at
          : new Date(startedAtMs!).toISOString(),
        finishedAt: new Date(finishedAtMs).toISOString(),
        reapedAt: new Date(reapedAtMs).toISOString(),
        decision: evidence.decision,
        reason: evidence.reason,
        clientAction: evidence.client_action,
        recordSha256: evidence.record_sha256,
      },
    },
  };
}

function exactPositiveQueueCandidate(
  response: QueueListResponse,
  studioJobId: string,
  preparedAdmission: AdmissionRequest,
  submitStartedAt: string,
): QueueJobSummary | null {
  assertAuthoritativeQueueList(response);
  const expectedCaller = `ltx-studio:${studioJobId}`;
  const collisions = response.jobs.filter((candidate) =>
    candidate.requested_by === expectedCaller
      || candidate.idempotency_key === preparedAdmission.idempotency_key);
  const matches = collisions.filter((candidate) =>
    dgxQueueJobMatchesPreparedAdmission(
      candidate,
      studioJobId,
      preparedAdmission,
      submitStartedAt,
    ));
  if (collisions.length !== matches.length || matches.length > 1) {
    throw new DgxLeaseAuthorityError(
      "DGX-Queue enthält eine mehrdeutige oder abweichend gebundene positive Submit-Identität.",
    );
  }
  return matches[0] ?? null;
}

function canonicalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function dgxResponseTerminalObservation(
  value: unknown,
  kind: "job-read" | "job-transition",
  expectedDgxJobId: string,
  expectedStudioJobId: string,
): DgxTerminalObservation | null {
  const state = dgxResponseJobState(value, kind, expectedDgxJobId, expectedStudioJobId);
  if (!state || !DGX_REMOTE_TERMINAL_STATES.has(state)) return null;
  const expectedCaller = `ltx-studio:${expectedStudioJobId}`;
  return {
    state: state as DgxObservedTerminalState,
    evidence: kind === "job-read"
      ? {
          kind,
          schemaVersion: "dgx-job-read.v0",
          requestedBy: expectedCaller,
          sourceApp: "LTX Studio",
          idempotencyKey: expectedCaller,
        }
      : {
          kind,
          schemaVersion: "dgx-job-transition.v0",
          requestedBy: expectedCaller,
          sourceApp: "LTX Studio",
          idempotencyKey: expectedCaller,
        },
  };
}

function dgxSubmitTerminalObservation(
  value: unknown,
  expectedStudioJobId: string,
  preparedAdmission: AdmissionRequest,
  submitStartedAt: string,
  replayBoundJobId?: string,
): DgxTerminalObservation | null {
  if (!dgxSubmitResponseCallerBound(value, expectedStudioJobId)) return null;
  const response = value as QueueSubmitResponse;
  if (!DGX_REMOTE_TERMINAL_STATES.has(response.job.state)
    || (replayBoundJobId !== undefined
      && (response.job.job_id !== replayBoundJobId
        || response.admission.idempotent_replay !== true
        || response.admission.replay_bound_job_id !== replayBoundJobId))
    || !dgxQueueJobIdentityMatchesPreparedAdmission(
      response.job,
      expectedStudioJobId,
      preparedAdmission,
      submitStartedAt,
    )) return null;
  return {
    state: response.job.state as DgxObservedTerminalState,
    evidence: replayBoundJobId === undefined
      ? {
          kind: "queue-submit",
          schemaVersion: "dgx-queue-submit.v0",
          requestedBy: preparedAdmission.requested_by,
          sourceApp: "LTX Studio",
          idempotencyKey: preparedAdmission.idempotency_key,
        }
      : {
          kind: "queue-replay",
          schemaVersion: "dgx-queue-submit.v0",
          requestedBy: preparedAdmission.requested_by,
          sourceApp: "LTX Studio",
          idempotencyKey: preparedAdmission.idempotency_key,
          replayBoundJobId,
          idempotentReplay: true,
        },
  };
}

function dgxGoneTerminalObservation(
  error: unknown,
  receipt: DgxLeaseReceipt,
): DgxTerminalObservation | null {
  if (!(error instanceof RuntimeApiError)
    || error.statusCode !== 410
    || !error.payload
    || typeof error.payload !== "object"
    || Array.isArray(error.payload)) return null;
  const payload = error.payload as Record<string, unknown>;
  const state = payload.state;
  const finishedAtMs = parseStrictOffsetDateTime(payload.finished_at);
  const reapedAtMs = parseStrictOffsetDateTime(payload.reaped_at);
  const observedCreatedAtMs = parseStrictOffsetDateTime(receipt.observedCreatedAt);
  const observedAtMs = Date.now();
  if (payload.error !== "job_gone"
    || payload.schema_version !== "dgx-job-gone.v0"
    || payload.terminal !== true
    || payload.job_id !== receipt.dgxJobId
    || payload.idempotency_key !== receipt.idempotencyKey
    || !dgxRuntimeRequestSha256Matches(receipt.preparedAdmission, payload.request_sha256)
    || typeof state !== "string"
    || !DGX_REMOTE_TERMINAL_STATES.has(state as QueueJobState)
    || finishedAtMs === null
    || reapedAtMs === null
    || observedCreatedAtMs === null
    || finishedAtMs < observedCreatedAtMs
    || reapedAtMs < finishedAtMs
    || finishedAtMs > observedAtMs
    || reapedAtMs > observedAtMs) return null;
  const finishedAt = new Date(finishedAtMs).toISOString();
  const reapedAt = new Date(reapedAtMs).toISOString();
  return {
    state: state as DgxObservedTerminalState,
    evidence: {
      kind: "job-gone",
      schemaVersion: "ltx-studio-dgx-job-gone-evidence.v1",
      runtimeSchemaVersion: "dgx-job-gone.v0",
      idempotencyKey: receipt.idempotencyKey,
      requestSha256: payload.request_sha256 as string,
      finishedAt,
      reapedAt,
      reason: typeof payload.reason === "string" ? payload.reason.slice(0, 1_000) : null,
    },
  };
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

function definitiveDgxReplayProtocolFailure(error: unknown): string | null {
  if (!(error instanceof RuntimeApiError) || error.statusCode === null) return null;
  if (![400, 401, 403, 404, 405, 409, 410, 412, 415, 422].includes(error.statusCode)) {
    return null;
  }
  const code = runtimePayloadError(error);
  return `HTTP ${error.statusCode}${code ? `, ${code}` : ""}: ${error.message}`;
}

function dgxReplayTargetTemporarilyUnavailable(
  error: unknown,
  expectedDgxJobId: string,
): boolean {
  if (!(error instanceof RuntimeApiError)
    || error.statusCode !== 409
    || !error.payload
    || typeof error.payload !== "object"
    || Array.isArray(error.payload)) return false;
  const payload = error.payload as Record<string, unknown>;
  return payload.schema_version === "dgx-queue-replay-conflict.v0"
    && payload.error === "replay_target_mismatch"
    && payload.expected_job_id === expectedDgxJobId
    && payload.observed_job_id === null
    && payload.client_action === "poll_expected_job_status";
}

function definitiveHeartbeatLeaseLoss(error: unknown): string | null {
  if (!(error instanceof RuntimeApiError)) return null;
  const code = runtimePayloadError(error);
  if (!((error.statusCode === 404 && code === "job_not_found")
    || (error.statusCode === 409 && code === "heartbeat_requires_active_job"))) return null;
  return `DGX-Owner-Heartbeat verlor die Remote-Lease autoritativ `
    + `(HTTP ${error.statusCode}${code ? `, ${code}` : ""}).`;
}

export type VariantMode = "exact" | "random-seed";

export class JobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobConflictError";
  }
}

const LEGACY_JOB_READ_ONLY_MESSAGE =
  "Historischer Altbestand ist ausdrücklich nur lesbar; Favoriten-, Abbruch- und andere Zustandsänderungen sind gesperrt.";
const LEGACY_OUTPUT_READ_ONLY_MESSAGE =
  "Historischer Altbestand ist ausschließlich für Wiedergabe und Download freigegeben; persistierende oder abgeleitete Änderungen sind gesperrt.";

/**
 * Sticky fail-stop raised when the manager cannot prove whether its complete
 * job snapshot is durably committed.  Callers must not compensate or retry a
 * mutation after this error: doing so could diverge from an already-renamed
 * target.  A fresh manager process performs recovery before accepting work.
 */
export class JobPersistenceHoldError extends Error {
  readonly publicCode = PUBLIC_JOB_PERSISTENCE_HOLD_CODE;
  readonly publicReason = PUBLIC_JOB_PERSISTENCE_HOLD_REASON;
  readonly restartRequired = true;

  constructor(
    _diagnosticMessage: string,
    _persistenceCause: unknown,
  ) {
    super(PUBLIC_JOB_PERSISTENCE_HOLD_REASON);
    void _diagnosticMessage;
    void _persistenceCause;
    this.name = "JobPersistenceHoldError";
  }
}

function isJobPersistenceHoldError(error: unknown): error is JobPersistenceHoldError {
  return error instanceof JobPersistenceHoldError;
}

/**
 * A proven pre-rename failure while committing a DGX terminal receipt.  The
 * remote transition may already be terminal, so the caller must not continue
 * reconciliation in the same attempt; flush() rearms the durable GET-first
 * retry after the in-flight promise has cleared.
 */
class DgxTerminalReceiptPersistenceError extends Error {
  constructor(readonly persistenceCause: unknown) {
    super(
      `DGX-Terminalbeleg konnte nicht persistiert werden: ${
        persistenceCause instanceof Error ? persistenceCause.message : String(persistenceCause)
      }`,
    );
    this.name = "DgxTerminalReceiptPersistenceError";
  }
}

class DgxLeaseAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DgxLeaseAuthorityError";
  }
}

class DgxRemoteLeaseLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DgxRemoteLeaseLostError";
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

function lipForcingVisualComparable(request: GenerationRequest): object {
  const comparable: Partial<GenerationRequest> = structuredClone(request);
  delete comparable.outputName;
  if (comparable.postprocess) {
    comparable.postprocess.lipForcing.programAudioDelayMs = 0;
  }
  return comparable;
}

export type ProgramAudioDelayVariableId =
  | "lipforcing-program-audio-delay-ms"
  | "program-audio-delay-ms";

export function programAudioDelayPath(variableId: ProgramAudioDelayVariableId): string {
  return variableId === "program-audio-delay-ms"
    ? "audio.outputDelayMs"
    : "postprocess.lipForcing.programAudioDelayMs";
}

export function programAudioDelayValue(
  request: GenerationRequest,
  variableId: ProgramAudioDelayVariableId,
): number {
  return variableId === "program-audio-delay-ms"
    ? request.audio.outputDelayMs
    : request.postprocess.lipForcing.programAudioDelayMs;
}

function programAudioVisualComparable(
  request: GenerationRequest,
  variableId: ProgramAudioDelayVariableId,
): object {
  const comparable: Partial<GenerationRequest> = structuredClone(request);
  delete comparable.outputName;
  if (variableId === "program-audio-delay-ms") {
    if (comparable.audio) comparable.audio.outputDelayMs = 0;
  } else if (comparable.postprocess) {
    comparable.postprocess.lipForcing.programAudioDelayMs = 0;
  }
  return comparable;
}

export function requestsShareProgramAudioVisual(
  left: GenerationRequest,
  right: GenerationRequest,
  variableId: ProgramAudioDelayVariableId,
): boolean {
  return isDeepStrictEqual(
    programAudioVisualComparable(left, variableId),
    programAudioVisualComparable(right, variableId),
  );
}

export function publishedOutputIsReusableProgramAudioVisual(
  source: GenerationRequest,
  target: GenerationRequest,
  variableId: ProgramAudioDelayVariableId,
): boolean {
  const variableContractValid = variableId === "program-audio-delay-ms"
    ? !source.postprocess.lipForcing.enabled && !target.postprocess.lipForcing.enabled
    : source.postprocess.lipForcing.enabled && target.postprocess.lipForcing.enabled;
  return variableContractValid
    && !source.audio.finalMix.path
    && !target.audio.finalMix.path
    && requestsShareProgramAudioVisual(source, target, variableId);
}

export function requestsShareLipForcingVisual(
  left: GenerationRequest,
  right: GenerationRequest,
): boolean {
  return isDeepStrictEqual(lipForcingVisualComparable(left), lipForcingVisualComparable(right));
}

export function publishedOutputIsReusableLipForcingVisual(
  source: GenerationRequest,
  target: GenerationRequest,
): boolean {
  return publishedOutputIsReusableProgramAudioVisual(
    source,
    target,
    "lipforcing-program-audio-delay-ms",
  );
}

export const DEVELOPMENT_LIPFORCING_RAW_OUTPUT_SURFACE_ID =
  "development:lipforcing-raw-output-profile:h264-crf13-mux-copy-v1";

const LIPFORCING_RAW_OUTPUT_EXPERIMENT_PATH = "postprocess.lipForcing.rawOutputProfile";
const POSITIVE_PROMPT_EXPERIMENT_PATH = "prompt";

export function validRequestBoundExperimentBinding(
  request: GenerationRequest,
  binding: ExperimentRunBinding | null | undefined,
): ExperimentRunBinding | null {
  const parsed = experimentRunBindingSchema.safeParse(binding);
  if (!parsed.success) return null;
  const requestSha256 = experimentRequestSha256V1(request);
  return parsed.data.requestSha256 === requestSha256 ? parsed.data : null;
}

export function validRawOutputExperimentBinding(
  request: GenerationRequest,
  binding: ExperimentRunBinding | null | undefined,
): ExperimentRunBinding | null {
  const value = validRequestBoundExperimentBinding(request, binding);
  if (!value || rawMuxPairV1CandidateError(request)) return null;
  return value.arm === "candidate"
    && value.kind === "ablation"
    && value.variableId === "lipforcing-raw-output-profile"
    && value.changedRequestPaths.length === 1
    && value.changedRequestPaths[0] === LIPFORCING_RAW_OUTPUT_EXPERIMENT_PATH
    && value.protocolSha256.length === 64
    && value.baselineJobId !== null
    && value.adoptedBaseline !== true
    ? value
    : null;
}

export function validPositivePromptExperimentBinding(
  request: GenerationRequest,
  binding: ExperimentRunBinding | null | undefined,
): ExperimentRunBinding | null {
  const value = validPositivePromptExperimentArmBinding(request, binding);
  return value?.arm === "candidate" ? value : null;
}

export function validPositivePromptExperimentArmBinding(
  request: GenerationRequest,
  binding: ExperimentRunBinding | null | undefined,
): ExperimentRunBinding | null {
  const value = validRequestBoundExperimentBinding(request, binding);
  if (!value || !supportsPositivePromptExperiment(request)) return null;
  if (value.kind !== "ablation"
    || value.variableId !== "positive-prompt"
    || value.changedRequestPaths.length !== 1
    || value.changedRequestPaths[0] !== POSITIVE_PROMPT_EXPERIMENT_PATH
    || value.protocolSha256.length !== 64
    || value.adoptedBaseline === true) return null;
  if (value.arm === "baseline") {
    return value.baselineJobId === null
      && value.baselineRequestSha256 === value.requestSha256
      ? value
      : null;
  }
  return value.baselineJobId !== null ? value : null;
}

export function positivePromptCandidateEnvironmentError(
  candidate: Pick<StudioJob, "request" | "experiment" | "runProvenance">,
  baseline: Pick<StudioJob, "status" | "runProvenance"> | null | undefined,
): string | null {
  if (
    candidate.experiment?.arm !== "candidate"
    || candidate.experiment.variableId !== "positive-prompt"
  ) return null;
  if (!validPositivePromptExperimentBinding(candidate.request, candidate.experiment)) {
    return "Der Prompt-Kandidat besitzt keine exakt request- und protokollgebundene Einzelfaktor-Autorität.";
  }
  if (
    baseline?.status !== "completed"
    || !runProvenanceEnvironmentMatches(baseline.runProvenance, candidate.runProvenance)
  ) {
    return "Der Prompt-Kandidat wurde vor DGX-Admission abgewiesen: Ausführungsinputs, Code oder Runtime-Provenienz "
      + "stimmen nicht exakt mit dem frischen Baseline-Arm überein.";
  }
  return null;
}

export function genericLtxBaseReuseAllowed(
  job: Pick<StudioJob, "request" | "experiment">,
): boolean {
  const postprocess = job.request.postprocess;
  const reuseRelevant = postprocess.longcatLipsync.enabled
    || postprocess.latentSync.enabled
    || postprocess.museTalk.enabled
    || postprocess.lipForcing.enabled;
  return reuseRelevant && job.experiment?.variableId !== "positive-prompt";
}

export function validRawOutputBaselineExperimentBinding(
  request: GenerationRequest,
  binding: ExperimentRunBinding | null | undefined,
): ExperimentRunBinding | null {
  const value = validRequestBoundExperimentBinding(request, binding);
  if (!value || rawMuxPairV1BaselineError(request)) return null;
  return value.arm === "baseline"
    && value.kind === "ablation"
    && value.variableId === "lipforcing-raw-output-profile"
    && value.changedRequestPaths.length === 1
    && value.changedRequestPaths[0] === LIPFORCING_RAW_OUTPUT_EXPERIMENT_PATH
    && value.protocolSha256.length === 64
    && value.baselineJobId === null
    && value.baselineRequestSha256 === value.requestSha256
    && value.adoptedBaseline !== true
    ? value
    : null;
}

export function rawMuxCandidateRequestFromBaseline(
  request: GenerationRequest,
  binding: ExperimentRunBinding,
): GenerationRequest | null {
  if (!validRawOutputBaselineExperimentBinding(request, binding)) return null;
  const suffix = `-exp-${binding.experimentId.slice(0, 8)}-a.mp4`;
  if (!request.outputName.endsWith(suffix)) return null;
  const candidate = structuredClone(request);
  candidate.outputName = `${request.outputName.slice(0, -suffix.length)}`
    + `-exp-${binding.experimentId.slice(0, 8)}-b.mp4`;
  candidate.postprocess.lipForcing.rawOutputProfile = experimentalLipForcingRawOutputProfile;
  return candidate;
}

function isBoundRawOutputCandidate(job: Pick<StudioJob, "experiment" | "request">): boolean {
  return validRawOutputExperimentBinding(job.request, job.experiment) !== null;
}

export function jobSurfaceEntryId(
  request: GenerationRequest,
  source: JobStartSource,
  isSealedRelease = sealedRelease,
  experiment: ExperimentRunBinding | null = null,
): string {
  const profile = request.postprocess.lipForcing.rawOutputProfile;
  if (profile === defaultLipForcingRawOutputProfile) {
    if (source === "experiment"
      && experiment?.variableId === "lipforcing-raw-output-profile"
      && validRawOutputBaselineExperimentBinding(request, experiment) === null) {
      throw new JobConflictError(
        "Der Rohvideo-Baseline-Arm erfüllt den strikt gepaarten Raw-Mux-v1-Vertrag nicht.",
      );
    }
    return releaseSurfaceEntryForRequest(request).id;
  }
  if (profile !== experimentalLipForcingRawOutputProfile
    || !request.postprocess.lipForcing.enabled) {
    throw new JobConflictError("Unbekanntes oder inaktives experimentelles LipForcing-Rohvideo-Profil.");
  }
  if (
    isSealedRelease
    || source !== "experiment"
    || validRawOutputExperimentBinding(request, experiment) === null
  ) {
    throw new JobConflictError(
      "Der LipForcing-Mux-copy-Kandidat benötigt den exakt requestgebundenen Kandidatenarm "
        + "des kontrollierten Development-Experiments.",
    );
  }
  return DEVELOPMENT_LIPFORCING_RAW_OUTPUT_SURFACE_ID;
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
      && file.role !== "private:lipforcing-raw-mux-pair-v1"
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

export function runProvenanceUsesExactLipForcingImage(
  provenance: RunProvenance | null,
  expected: ProvenanceContainerImageEvidence,
): boolean {
  const actual = lipForcingImageIdentity(provenance?.containerImages);
  return actual !== null && canonicalJson(actual) === canonicalJson(expected);
}

export type ReusableLtxBaseCandidate = {
  outputName: string;
  outputPath: string;
  jobId: string;
  request: GenerationRequest;
  /** Exact request bytes originally sealed in the settings sidecar. */
  authorityBoundRequest?: unknown;
  authorityRequestSha256?: string;
  identityEvidence: IdentityInputEvidence;
  runProvenance: RunProvenance;
  settingsSidecarPath?: string;
  analysisSidecarPath?: string;
  analysisSidecarVerified?: boolean;
};

export type ReusableLtxBaseSource = {
  reusableLtxBaseCandidates: () => ReusableLtxBaseCandidate[];
};

export type ReusableLtxBase = {
  id: string;
  outputPath: string;
  description: string;
};

export type ReusableLipForcingOutput = ReusableLtxBase & {
  outputName: string;
  baselineRequestSha256: string;
  sourceAuthorityRequestSha256?: string;
  sourceRunProvenance: RunProvenance;
  sourceProvenanceFingerprint: string;
  settingsSidecarPath: string;
  analysisSidecarPath: string;
  programAudioDelayMs: number;
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

export function reusableProgramAudioOutputFromSidecars(
  candidates: readonly ReusableLtxBaseCandidate[],
  target: {
    id: string;
    request: GenerationRequest;
    identityEvidence: IdentityInputEvidence | null;
  },
  fileReady: (path: string) => boolean,
  variableId: ProgramAudioDelayVariableId,
): ReusableLipForcingOutput | undefined {
  const match = candidates.find((candidate) =>
    candidate.jobId !== target.id
    && Boolean(candidate.runProvenance.verifiedAt)
    && typeof candidate.authorityRequestSha256 === "string"
    && /^[0-9a-f]{64}$/.test(candidate.authorityRequestSha256)
    && candidate.authorityBoundRequest !== undefined
    && candidate.authorityRequestSha256
      === experimentRequestSha256V1(candidate.authorityBoundRequest)
    && publishedOutputIsReusableProgramAudioVisual(candidate.request, target.request, variableId)
    && identityEvidenceMatches(candidate.identityEvidence, target.identityEvidence)
    && candidate.settingsSidecarPath !== undefined
    && fileReady(candidate.settingsSidecarPath)
    && candidate.analysisSidecarPath !== undefined
    && candidate.analysisSidecarVerified === true
    && fileReady(candidate.analysisSidecarPath)
    && fileReady(candidate.outputPath));
  if (!match) return undefined;
  return {
    id: match.jobId,
    outputPath: match.outputPath,
    description: `Ausgabe „${match.outputName}" (Job ${match.jobId})`,
    outputName: match.outputName,
    baselineRequestSha256: experimentRequestSha256V1(match.request),
    sourceAuthorityRequestSha256: match.authorityRequestSha256,
    sourceRunProvenance: structuredClone(match.runProvenance),
    sourceProvenanceFingerprint: match.runProvenance.fingerprint,
    settingsSidecarPath: match.settingsSidecarPath ?? `${match.outputPath}.ltx-settings.json`,
    analysisSidecarPath: match.analysisSidecarPath ?? `${match.outputPath}.ltx-analysis.json`,
    programAudioDelayMs: programAudioDelayValue(match.request, variableId),
  };
}

export function reusableLipForcingOutputFromSidecars(
  candidates: readonly ReusableLtxBaseCandidate[],
  target: {
    id: string;
    request: GenerationRequest;
    identityEvidence: IdentityInputEvidence | null;
  },
  fileReady: (path: string) => boolean,
): ReusableLipForcingOutput | undefined {
  return reusableProgramAudioOutputFromSidecars(
    candidates,
    target,
    fileReady,
    "lipforcing-program-audio-delay-ms",
  );
}

function boundProgramAudioDelayVariable(
  job: Pick<StudioJob, "experiment" | "request">,
): ProgramAudioDelayVariableId | null {
  const binding = job.experiment;
  if (!binding
    || binding.arm !== "candidate"
    || !binding.baselineJobId
    || !binding.baselineOutputName
    || binding.changedRequestPaths.length !== 1) return null;
  if (binding.variableId === "lipforcing-program-audio-delay-ms"
    && binding.changedRequestPaths[0] === programAudioDelayPath(binding.variableId)
    && job.request.postprocess.lipForcing.enabled) {
    return binding.variableId;
  }
  if (binding.variableId === "program-audio-delay-ms"
    && binding.changedRequestPaths[0] === programAudioDelayPath(binding.variableId)
    && Number.isInteger(job.request.audio.outputDelayMs)
    && job.request.audio.outputDelayMs >= 1
    && job.request.audio.outputDelayMs <= 500) {
    const baselineShape = structuredClone(job.request);
    baselineShape.audio.outputDelayMs = 0;
    if (!supportsProgramAudioDelayExperiment(baselineShape)) return null;
    return binding.variableId;
  }
  return null;
}

function isBoundProgramAudioOnlyCandidate(job: Pick<StudioJob, "experiment" | "request">): boolean {
  return boundProgramAudioDelayVariable(job) !== null;
}

/**
 * Runtime selection is deliberately narrower than the generic preflight
 * predicate: an experiment may reuse only the exact frozen baseline named in
 * its server-side binding. A compatible output from any other job is never a
 * fallback.
 */
export function exactBoundProgramAudioOutputFromSidecars(
  candidates: readonly ReusableLtxBaseCandidate[],
  target: Pick<StudioJob, "id" | "request" | "identityEvidence" | "experiment">,
  fileReady: (path: string) => boolean,
): ReusableLipForcingOutput | undefined {
  const binding = target.experiment;
  const variableId = boundProgramAudioDelayVariable(target);
  if (!binding || !variableId || !binding.baselineJobId) return undefined;
  if (experimentRequestSha256V1(target.request) !== binding.requestSha256) {
    return undefined;
  }
  const exact = candidates.filter((candidate) =>
    candidate.jobId === binding.baselineJobId
    && candidate.outputName === binding.baselineOutputName
    && typeof candidate.authorityRequestSha256 === "string"
    && /^[0-9a-f]{64}$/.test(candidate.authorityRequestSha256)
    && candidate.authorityBoundRequest !== undefined
    && candidate.authorityRequestSha256
      === experimentRequestSha256V1(candidate.authorityBoundRequest)
    && experimentRequestSha256V1(candidate.request) === binding.baselineRequestSha256
    && candidate.runProvenance.verifiedAt
    && /^[0-9a-f]{64}$/.test(candidate.runProvenance.fingerprint)
    && publishedOutputIsReusableProgramAudioVisual(candidate.request, target.request, variableId)
    && identityEvidenceMatches(candidate.identityEvidence, target.identityEvidence)
    && candidate.analysisSidecarVerified === true);
  if (exact.length !== 1) return undefined;
  const candidate = exact[0];
  const settingsSidecarPath = candidate.settingsSidecarPath ?? `${candidate.outputPath}.ltx-settings.json`;
  const analysisSidecarPath = candidate.analysisSidecarPath ?? `${candidate.outputPath}.ltx-analysis.json`;
  if (![candidate.outputPath, settingsSidecarPath, analysisSidecarPath].every(fileReady)) return undefined;
  return {
    id: candidate.jobId,
    outputName: candidate.outputName,
    outputPath: candidate.outputPath,
    description: `gebundene Baseline-Ausgabe „${candidate.outputName}" (Job ${candidate.jobId})`,
    baselineRequestSha256: binding.baselineRequestSha256,
    sourceAuthorityRequestSha256: candidate.authorityRequestSha256,
    sourceRunProvenance: structuredClone(candidate.runProvenance),
    sourceProvenanceFingerprint: candidate.runProvenance.fingerprint,
    settingsSidecarPath,
    analysisSidecarPath,
    programAudioDelayMs: programAudioDelayValue(candidate.request, variableId),
  };
}

export function exactBoundLipForcingOutputFromSidecars(
  candidates: readonly ReusableLtxBaseCandidate[],
  target: Pick<StudioJob, "id" | "request" | "identityEvidence" | "experiment">,
  fileReady: (path: string) => boolean,
): ReusableLipForcingOutput | undefined {
  return exactBoundProgramAudioOutputFromSidecars(candidates, target, fileReady);
}

export function buildLipForcingAudioRetimeArgs(
  inputPath: string,
  outputPath: string,
  deltaMs: number,
): string[] {
  if (!Number.isInteger(deltaMs) || deltaMs < -1_000 || deltaMs > 1_000) {
    throw new Error("LipForcing-Tonversatzdifferenz muss ganzzahlig zwischen -1000 und 1000 ms liegen.");
  }
  const common = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", inputPath,
    "-map", "0:v:0", "-map", "0:a:0",
    "-c:v", "copy",
  ];
  if (deltaMs === 0) {
    return [...common, "-c:a", "copy", "-movflags", "+faststart", outputPath];
  }
  const timingFilter = deltaMs > 0
    ? `adelay=${deltaMs}:all=1`
    : `atrim=start=${(Math.abs(deltaMs) / 1_000).toFixed(9)},asetpts=PTS-STARTPTS`;
  return [
    ...common,
    "-af", `${timingFilter},aresample=48000,apad`,
    "-c:a", "aac", "-b:a", "192k",
    "-shortest", "-movflags", "+faststart",
    outputPath,
  ];
}

export function buildPositivePacketCopyAudioRetimeArgs(
  inputPath: string,
  outputPath: string,
  deltaMs: number,
): string[] {
  return buildPositiveAudioRetimePacketCopyArgs(inputPath, outputPath, deltaMs);
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

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function quarantineUnreleasedArtifact(outputPath: string, quarantineRoot: string): string | null {
  if (!existsSync(outputPath)) return null;
  mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  const quarantinePath = join(quarantineRoot, `unreleased-output${extname(outputPath)}`);
  if (existsSync(quarantinePath)) {
    rmSync(quarantinePath, { force: true });
    fsyncDirectory(quarantineRoot);
  }
  renameSync(outputPath, quarantinePath);
  fsyncDirectory(dirname(outputPath));
  if (dirname(outputPath) !== quarantineRoot) fsyncDirectory(quarantineRoot);
  chmodSync(quarantinePath, 0o600);
  const descriptor = openSync(quarantinePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return quarantinePath;
}

const DEFAULT_OUTPUT_AUTHORITY_RECONCILIATION_OPERATIONS: OutputAuthorityReconciliationOperations =
  Object.freeze({
    removePublicationAuthority: removeOutputPublicationAuthority,
    quarantineUnreleased: quarantineUnreleasedArtifact,
  });

/**
 * Restore must revoke external authority even when private quarantine fails,
 * but recovery never has authority to destroy the only remaining media bytes.
 * A raw pathname that cannot be moved remains reserved and is made 404 by the
 * caller's durable job/archive downgrade; a marker alone is never authority.
 */
export function quarantineRestoredUnpublishedArtifact(
  outputPath: string,
  quarantineRoot: string,
  operations: OutputAuthorityReconciliationOperations =
    DEFAULT_OUTPUT_AUTHORITY_RECONCILIATION_OPERATIONS,
): string | null {
  try {
    operations.removePublicationAuthority(outputPath);
  } catch {
    // Moving the bound output below still makes a surviving marker inert.
  }
  let quarantinePath: string | null = null;
  try {
    const preferredPath = join(
      quarantineRoot,
      `unreleased-output${extname(outputPath)}`,
    );
    // Never let the legacy quarantine helper replace an earlier recovery
    // artifact. A fresh private child directory retains both generations.
    const nonReplacingRoot = existsSync(preferredPath)
      ? join(quarantineRoot, `restore-${randomUUID()}`)
      : quarantineRoot;
    quarantinePath = operations.quarantineUnreleased(outputPath, nonReplacingRoot);
  } catch {
    // The caller terminalizes/downgrades the job if the raw pathname remains.
  }
  try {
    operations.removePublicationAuthority(outputPath);
  } catch {
    // The caller removes every job/archive claim before exposing its restored state.
  }
  if (existsSync(outputPath)) {
    throw new Error(
      "Nicht publizierte Restore-Ausgabe konnte nicht privat quarantänisiert werden; "
      + "Rohdaten bleiben unverändert und ohne Publikationsautorität am reservierten Pfad.",
    );
  }
  return quarantinePath;
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

function boundedResourceTelemetryError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/gu, " ")
    .trim() || "unbekannter Telemetriefehler";
  return message.length <= 1_000 ? message : `${message.slice(0, 999)}…`;
}

export type AtomicSnapshotFileOperations = {
  mkdir: (path: string) => void;
  open: (path: string, flags: string, mode?: number) => number;
  write: (descriptor: number, contents: string) => void;
  fsync: (descriptor: number) => void;
  close: (descriptor: number) => void;
  rename: (source: string, target: string) => void;
  remove: (path: string) => void;
  read: (path: string) => Buffer;
};

type AtomicSnapshotWritePhase =
  | "directory-create"
  | "temporary-open"
  | "temporary-write"
  | "temporary-fsync"
  | "temporary-close"
  | "target-rename"
  | "directory-open"
  | "directory-fsync"
  | "directory-close";

class AtomicSnapshotWriteError extends Error {
  constructor(
    readonly phase: AtomicSnapshotWritePhase,
    readonly originalError: unknown,
  ) {
    super(
      `Atomare Snapshot-Persistenz scheiterte in Phase ${phase}: ${
        originalError instanceof Error ? originalError.message : String(originalError)
      }`,
    );
    this.name = "AtomicSnapshotWriteError";
  }
}

const DEFAULT_ATOMIC_SNAPSHOT_FILE_OPERATIONS: AtomicSnapshotFileOperations = Object.freeze({
  mkdir: (path: string) => mkdirSync(path, { recursive: true, mode: 0o700 }),
  open: (path: string, flags: string, mode?: number) => openSync(path, flags, mode),
  write: (descriptor: number, contents: string) => writeFileSync(descriptor, contents, "utf8"),
  fsync: fsyncSync,
  close: closeSync,
  rename: renameSync,
  remove: (path: string) => rmSync(path, { force: true }),
  read: (path: string) => readFileSync(path),
});

function atomicTextFile(
  path: string,
  contents: string,
  operations: AtomicSnapshotFileOperations = DEFAULT_ATOMIC_SNAPSHOT_FILE_OPERATIONS,
): void {
  let phase: AtomicSnapshotWritePhase = "directory-create";
  let temporaryDescriptor: number | undefined;
  let directoryDescriptor: number | undefined;
  let renamed = false;
  const temporaryPath = join(dirname(path), `.${path.split("/").at(-1)}.${randomUUID()}.tmp`);
  try {
    operations.mkdir(dirname(path));
    phase = "temporary-open";
    temporaryDescriptor = operations.open(temporaryPath, "wx", 0o600);
    phase = "temporary-write";
    operations.write(temporaryDescriptor, contents);
    phase = "temporary-fsync";
    operations.fsync(temporaryDescriptor);
    phase = "temporary-close";
    operations.close(temporaryDescriptor);
    temporaryDescriptor = undefined;
    phase = "target-rename";
    operations.rename(temporaryPath, path);
    renamed = true;
    phase = "directory-open";
    directoryDescriptor = operations.open(dirname(path), "r");
    phase = "directory-fsync";
    operations.fsync(directoryDescriptor);
    phase = "directory-close";
    operations.close(directoryDescriptor);
    directoryDescriptor = undefined;
  } catch (error) {
    if (temporaryDescriptor !== undefined) {
      try { operations.close(temporaryDescriptor); } catch { /* best-effort descriptor cleanup */ }
    }
    if (directoryDescriptor !== undefined) {
      try { operations.close(directoryDescriptor); } catch { /* best-effort descriptor cleanup */ }
    }
    if (!renamed) {
      try { operations.remove(temporaryPath); } catch { /* target remains authoritative */ }
    }
    throw new AtomicSnapshotWriteError(phase, error);
  }
}

function fsyncSnapshotDirectory(
  path: string,
  operations: AtomicSnapshotFileOperations,
): void {
  let lastError: unknown = new Error("Directory-fsync wurde nicht versucht.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let descriptor: number | undefined;
    try {
      descriptor = operations.open(dirname(path), "r");
      operations.fsync(descriptor);
      operations.close(descriptor);
      return;
    } catch (error) {
      lastError = error;
      if (descriptor !== undefined) {
        try { operations.close(descriptor); } catch { /* retry uses a fresh directory FD */ }
      }
    }
  }
  throw lastError;
}

function atomicJsonFile(path: string, value: object): void {
  atomicTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function exclusiveDurableJsonFile(path: string, value: object): void {
  const temporaryPath = join(dirname(path), `.${path.split("/").at(-1)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let linked = false;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, path);
    linked = true;
    unlinkSync(temporaryPath);
    const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* retain the authoritative write failure */ }
    }
    if (!linked) {
      try { unlinkSync(temporaryPath); } catch { /* retain the authoritative write failure */ }
    }
    throw error;
  }
}

function exclusiveDurableReadonlyJsonFile(path: string, value: object): void {
  const temporaryPath = join(dirname(path), `.${path.split("/").at(-1)}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  let linked = false;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fchmodSync(descriptor, 0o400);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporaryPath, path);
    linked = true;
    unlinkSync(temporaryPath);
    const directoryDescriptor = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* retain the authoritative write failure */ }
    }
    if (!linked) {
      try { unlinkSync(temporaryPath); } catch { /* retain the authoritative write failure */ }
    }
    throw error;
  }
}

export type ProtectedJsonReadOperations = {
  lstat?: typeof lstatSync;
  open?: typeof openSync;
  fstat?: typeof fstatSync;
  read?: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  close?: typeof closeSync;
};

function archiveFileStatIsTrusted(stats: Stats, maxBytes: number): boolean {
  return stats.isFile()
    && stats.nlink === 1
    && stats.uid === (process.getuid?.() ?? stats.uid)
    && stats.gid === (process.getgid?.() ?? stats.gid)
    && (stats.mode & 0o777) === 0o600
    && stats.size > 0
    && stats.size <= maxBytes;
}

function archiveFileStatsEqual(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function readExactProtectedFile(
  fd: number,
  size: number,
  read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number,
): Buffer {
  const value = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = read(fd, value, offset, size - offset, offset);
    if (count <= 0) throw new Error("Output-Authority-Archiv endete während des Lesens vorzeitig.");
    offset += count;
  }
  return value;
}

/**
 * Reads an authority ledger exclusively through one held, no-follow descriptor.
 * A second exact read plus pre/mid/post descriptor and pathname revisions makes
 * path replacement, hard-linking and same-inode mutation fail closed.
 */
export function readProtectedJsonFile(
  path: string,
  maxBytes: number,
  overrides: ProtectedJsonReadOperations = {},
): unknown {
  const operations = {
    lstat: overrides.lstat ?? lstatSync,
    open: overrides.open ?? openSync,
    fstat: overrides.fstat ?? fstatSync,
    read: overrides.read ?? readSync,
    close: overrides.close ?? closeSync,
  };
  const pathBefore = operations.lstat(path);
  if (pathBefore.isSymbolicLink() || !archiveFileStatIsTrusted(pathBefore, maxBytes)) {
    throw new Error("Output-Authority-Archiv ist kein geschütztes reguläres Ledger.");
  }
  const descriptor = operations.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorBefore = operations.fstat(descriptor);
    if (!archiveFileStatIsTrusted(descriptorBefore, maxBytes)
      || !archiveFileStatsEqual(pathBefore, descriptorBefore)) {
      throw new Error("Output-Authority-Archiv wurde vor dem Lesen ersetzt.");
    }
    const first = readExactProtectedFile(descriptor, descriptorBefore.size, operations.read);
    const descriptorMid = operations.fstat(descriptor);
    const second = readExactProtectedFile(descriptor, descriptorBefore.size, operations.read);
    const descriptorAfter = operations.fstat(descriptor);
    const pathAfter = operations.lstat(path);
    if (!archiveFileStatsEqual(descriptorBefore, descriptorMid)
      || !archiveFileStatsEqual(descriptorBefore, descriptorAfter)
      || !archiveFileStatsEqual(descriptorBefore, pathAfter)
      || !first.equals(second)) {
      throw new Error("Output-Authority-Archiv wurde während des Lesens verändert oder ersetzt.");
    }
    return JSON.parse(first.toString("utf8"));
  } finally {
    operations.close(descriptor);
  }
}

type HashedExecutionFile = {
  sha256: string;
  revision: ExecutionFileRevision;
};

function executionRevision(stats: {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number | bigint;
  dev: number | bigint;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
}): ExecutionFileRevision {
  if (stats.nlink !== 1) {
    throw new Error("Execution-Datei muss genau einen Hardlink besitzen.");
  }
  return {
    sizeBytes: stats.size,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
    fileId: String(stats.ino),
    deviceId: String(stats.dev),
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    nlink: 1,
  };
}

function executionRevisionsEqual(left: ExecutionFileRevision, right: ExecutionFileRevision): boolean {
  return left.sizeBytes === right.sizeBytes
    && left.modifiedAtMs === right.modifiedAtMs
    && left.changedAtMs === right.changedAtMs
    && left.fileId === right.fileId
    && left.deviceId === right.deviceId
    && left.mode === right.mode
    && left.uid === right.uid
    && left.gid === right.gid
    && left.nlink === right.nlink;
}

function hashExecutionDescriptor(descriptor: number, size: number, context: string): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const count = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, size - position),
      position,
    );
    if (count <= 0) throw new Error(`${context} endete beim Prüfen vorzeitig.`);
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

export type BoundExecutableDescriptor = {
  fd: number;
  binding: ExecutionFileBinding;
  version: string;
};

function verifyBoundExecutableDescriptor(executable: BoundExecutableDescriptor): void {
  const before = fstatSync(executable.fd);
  const beforeRevision = executionRevision(before);
  if (!before.isFile()
    || (before.mode & 0o111) === 0
    || !executionRevisionsEqual(beforeRevision, executable.binding.revision)) {
    throw new Error("Gebundener Executable-FD hat vor exec eine andere Revision oder keinen Ausführungsmodus.");
  }
  const sha256 = hashExecutionDescriptor(executable.fd, before.size, "Gebundener Executable-FD");
  const afterRevision = executionRevision(fstatSync(executable.fd));
  if (sha256 !== executable.binding.sha256
    || !executionRevisionsEqual(beforeRevision, afterRevision)) {
    throw new Error("Gebundener Executable-FD änderte sich vor exec.");
  }
}

function verifyRootOwnedBoundMediaTool(
  executable: BoundExecutableDescriptor,
  expectedPath: "/usr/bin/ffmpeg" | "/usr/bin/ffprobe",
): void {
  verifyBoundExecutableDescriptor(executable);
  const revision = executable.binding.revision;
  if (executable.binding.path !== expectedPath
    || revision.uid !== 0
    || revision.nlink !== 1
    || (revision.mode & 0o170000) !== 0o100000
    || (revision.mode & 0o111) === 0
    || (revision.mode & 0o022) !== 0) {
    throw new Error(`${expectedPath} ist nicht exakt als root-eigenes, nicht gruppen-/weltbeschreibbares Tool gebunden.`);
  }
}

/**
 * Opens with O_NOFOLLOW, binds bytes plus complete stat mode/revision, and asks
 * that exact descriptor for its version. The descriptor deliberately stays
 * open for exec through /proc/self/fd/N. This blocks pathname substitution;
 * same-uid in-place mutation remains outside the guarantee without memfd or
 * fs-verity and is stated in the persisted ExecutionDecision threat model.
 */
export function openBoundExecutable(
  path: string,
  versionArgs: readonly string[] = ["-version"],
): BoundExecutableDescriptor {
  if (!isAbsolute(path)) throw new Error("Executable-Pfad muss absolut sein.");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const openedRevision = executionRevision(opened);
    if (!opened.isFile() || opened.size <= 0 || (opened.mode & 0o111) === 0) {
      throw new Error(`Executable ist keine reguläre, nichtleere ausführbare Datei: ${path}`);
    }
    const sha256 = hashExecutionDescriptor(descriptor, opened.size, "Executable");
    const afterHashRevision = executionRevision(fstatSync(descriptor));
    const pathStats = lstatSync(path);
    if (pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || !executionRevisionsEqual(openedRevision, afterHashRevision)
      || !executionRevisionsEqual(openedRevision, executionRevision(pathStats))) {
      throw new Error(`Executable änderte sich während der Bindung: ${path}`);
    }
    const binding: ExecutionFileBinding = { path, sha256, revision: afterHashRevision };
    const versionResult = spawnSync("/proc/self/fd/3", [...versionArgs], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe", descriptor],
    });
    const version = versionResult.status === 0
      ? `${versionResult.stdout}\n${versionResult.stderr}`.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? ""
      : "";
    if (!version) throw new Error(`Executable-Version konnte nicht vom gebundenen FD gelesen werden: ${path}`);
    const executable = { fd: descriptor, binding, version };
    verifyBoundExecutableDescriptor(executable);
    return executable;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openBoundExecutableFromPath(executable: string): BoundExecutableDescriptor {
  const candidates = isAbsolute(executable)
    ? [executable]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, executable));
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return openBoundExecutable(realpathSync(candidate));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Kein bindbares ${executable} gefunden${errors.length > 0 ? `: ${errors.at(-1)}` : "."}`);
}

async function hashUnchangedExecutionFile(
  path: string,
  shouldStop: () => boolean = () => false,
): Promise<HashedExecutionFile> {
  if (shouldStop()) throw new Error("CPU-Reuse-Hashing wurde am Fail-Stop-Fence beendet.");
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile() || before.size <= 0) {
    throw new Error(`CPU-Reuse-Quelle ist keine reguläre, nichtleere Datei: ${path}`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    const beforeRevision = executionRevision(before);
    const openedRevision = executionRevision(opened);
    if (!executionRevisionsEqual(beforeRevision, openedRevision)) {
      throw new Error(`CPU-Reuse-Quelle änderte sich vor dem Öffnen: ${path}`);
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(path, { fd: descriptor, autoClose: false })) {
      if (shouldStop()) throw new Error("CPU-Reuse-Hashing wurde am Fail-Stop-Fence beendet.");
      digest.update(chunk);
    }
    if (shouldStop()) throw new Error("CPU-Reuse-Hashing wurde am Fail-Stop-Fence beendet.");
    const afterDescriptor = executionRevision(fstatSync(descriptor));
    const afterPathStats = lstatSync(path);
    if (afterPathStats.isSymbolicLink()
      || !afterPathStats.isFile()
      || !executionRevisionsEqual(openedRevision, afterDescriptor)
      || !executionRevisionsEqual(openedRevision, executionRevision(afterPathStats))) {
      throw new Error(`CPU-Reuse-Quelle änderte sich während der Hash-Erfassung: ${path}`);
    }
    return { sha256: digest.digest("hex"), revision: afterDescriptor };
  } finally {
    closeSync(descriptor);
  }
}

function durableSnapshotCopy(
  sourcePath: string,
  destinationPath: string,
  expectedRevision: ExecutionFileRevision,
): void {
  rmSync(destinationPath, { force: true });
  const sourceDescriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!executionRevisionsEqual(executionRevision(fstatSync(sourceDescriptor)), expectedRevision)) {
      throw new Error(`CPU-Reuse-Quelle änderte sich vor dem privaten Snapshot: ${sourcePath}`);
    }
    copyFileSync(`/proc/self/fd/${sourceDescriptor}`, destinationPath, constants.COPYFILE_EXCL);
    if (!executionRevisionsEqual(executionRevision(fstatSync(sourceDescriptor)), expectedRevision)) {
      throw new Error(`CPU-Reuse-Quelle änderte sich während des privaten Snapshots: ${sourcePath}`);
    }
  } finally {
    closeSync(sourceDescriptor);
  }
  chmodSync(destinationPath, 0o400);
  const snapshotDescriptor = openSync(destinationPath, "r");
  try {
    fsyncSync(snapshotDescriptor);
  } finally {
    closeSync(snapshotDescriptor);
  }
}

function sameHashedExecutionFile(left: HashedExecutionFile, right: HashedExecutionFile): boolean {
  return left.sha256 === right.sha256 && executionRevisionsEqual(left.revision, right.revision);
}

type PinnedCpuReuse = {
  inputPath: string;
  source: CpuAudioRetimeReuseSourceBinding;
};

export type VerifiedExecutionDescriptor = {
  fd: number;
  revision: ExecutionFileRevision;
  sha256: string;
};

export function openVerifiedExecutionDescriptor(
  path: string,
  expectedSha256: string,
  expectedRevision: ExecutionFileRevision,
): VerifiedExecutionDescriptor {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    const beforeRevision = executionRevision(before);
    if (!before.isFile() || before.size <= 0
      || !executionRevisionsEqual(beforeRevision, expectedRevision)) {
      throw new Error(`Privater CPU-Reuse-Snapshot hat vor dem Prozessstart eine andere Revision: ${path}`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (count <= 0) throw new Error(`Privater CPU-Reuse-Snapshot endete beim Prüfen vorzeitig: ${path}`);
      digest.update(buffer.subarray(0, count));
      position += count;
    }
    const afterRevision = executionRevision(fstatSync(descriptor));
    const sha256 = digest.digest("hex");
    if (!executionRevisionsEqual(beforeRevision, afterRevision) || sha256 !== expectedSha256) {
      throw new Error(`Privater CPU-Reuse-Snapshot änderte sich unmittelbar vor dem Prozessstart: ${path}`);
    }
    return { fd: descriptor, revision: afterRevision, sha256 };
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function recheckVerifiedExecutionDescriptor(descriptor: VerifiedExecutionDescriptor): void {
  const before = fstatSync(descriptor.fd);
  const beforeRevision = executionRevision(before);
  if (!before.isFile()
    || !executionRevisionsEqual(beforeRevision, descriptor.revision)
    || hashExecutionDescriptor(descriptor.fd, before.size, "Gehaltenes Snapshot-FD") !== descriptor.sha256
    || !executionRevisionsEqual(beforeRevision, executionRevision(fstatSync(descriptor.fd)))) {
    throw new Error("Gehaltenes Snapshot-FD änderte sich unmittelbar vor exec.");
  }
}

function executionRevisionMatchesAtomicRename(
  before: ExecutionFileRevision,
  after: ExecutionFileRevision,
): boolean {
  return before.sizeBytes === after.sizeBytes
    && before.modifiedAtMs === after.modifiedAtMs
    && after.changedAtMs >= before.changedAtMs
    && before.fileId === after.fileId
    && before.deviceId === after.deviceId
    && before.mode === after.mode
    && before.uid === after.uid
    && before.gid === after.gid
    && before.nlink === after.nlink;
}

/**
 * Rebinds a held, already verified inode after its private staging name was
 * atomically renamed to the public output name. rename(2) legitimately changes
 * ctime on the same inode, so the strict pre-exec revision comparison cannot be
 * reused here. Bytes, hash, inode/device, ownership, mode, link count and the
 * final non-symlink path remain fail-closed and are checked on both sides of
 * the hash pass.
 */
export function rebindVerifiedExecutionDescriptorAfterAtomicRename(
  descriptor: VerifiedExecutionDescriptor,
  outputPath: string,
): VerifiedExecutionDescriptor {
  const before = fstatSync(descriptor.fd);
  const beforeRevision = executionRevision(before);
  const beforePath = lstatSync(outputPath);
  const beforePathRevision = executionRevision(beforePath);
  if (!before.isFile()
    || beforePath.isSymbolicLink()
    || !beforePath.isFile()
    || !executionRevisionMatchesAtomicRename(descriptor.revision, beforeRevision)
    || !executionRevisionsEqual(beforeRevision, beforePathRevision)) {
    throw new Error("Atomar publiziertes Snapshot-FD stimmt nicht mit dem finalen Ausgabepfad überein.");
  }
  const sha256 = hashExecutionDescriptor(descriptor.fd, before.size, "Atomar publiziertes Snapshot-FD");
  const afterRevision = executionRevision(fstatSync(descriptor.fd));
  const afterPath = lstatSync(outputPath);
  if (afterPath.isSymbolicLink()
    || !afterPath.isFile()
    || sha256 !== descriptor.sha256
    || !executionRevisionsEqual(beforeRevision, afterRevision)
    || !executionRevisionsEqual(afterRevision, executionRevision(afterPath))) {
    throw new Error("Atomar publiziertes Snapshot-FD änderte sich während der finalen Bindung.");
  }
  return { ...descriptor, revision: afterRevision };
}

function cpuAudioRetimeDescriptorsMatch(
  source: CpuAudioRetimeReuseSourceBinding,
  inheritedFds: readonly number[],
  descriptors: readonly VerifiedExecutionDescriptor[],
): boolean {
  const expected = [
    { sha256: source.snapshotOutputSha256, revision: source.snapshotOutputRevision },
    { sha256: source.snapshotSettingsSidecarSha256, revision: source.snapshotSettingsSidecarRevision },
    { sha256: source.snapshotAnalysisSidecarSha256, revision: source.snapshotAnalysisSidecarRevision },
  ];
  return inheritedFds.length === 1
    && descriptors.length === expected.length
    && inheritedFds[0] === descriptors[0]?.fd
    && descriptors.every((descriptor, index) =>
      descriptor.sha256 === expected[index]?.sha256
      && executionRevisionsEqual(descriptor.revision, expected[index]!.revision));
}

function cpuAudioRetimeVerifierMatches(
  operation: CpuFfmpegOperation | CpuPacketCopyAudioRetimeOperation,
  verifiers: readonly BoundExecutableDescriptor[],
): boolean {
  if (operation.kind === "ffmpeg-audio-retime") return verifiers.length === 0;
  return verifiers.length === 1
    && canonicalJson(verifiers[0]?.binding) === canonicalJson(operation.ffprobe)
    && verifiers[0]?.version === operation.ffprobeVersion;
}

/** Captures, snapshots, and rechecks all evidence before a CPU process may be classified or spawned. */
export async function pinExactLipForcingReuse(
  reusable: ReusableLipForcingOutput,
  stageRoot: string,
  afterSnapshot?: () => void | Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<PinnedCpuReuse> {
  const assertCanContinue = (): void => {
    if (shouldStop()) throw new Error("CPU-Reuse-Snapshot wurde am Fail-Stop-Fence beendet.");
  };
  const sourceOutput = await hashUnchangedExecutionFile(reusable.outputPath, shouldStop);
  const sourceSettings = await hashUnchangedExecutionFile(reusable.settingsSidecarPath, shouldStop);
  const sourceAnalysis = await hashUnchangedExecutionFile(reusable.analysisSidecarPath, shouldStop);

  assertCanContinue();
  mkdirSync(stageRoot, { recursive: true, mode: 0o700 });
  const stageStats = lstatSync(stageRoot);
  if (stageStats.isSymbolicLink() || !stageStats.isDirectory()) {
    throw new Error("Privates CPU-Reuse-Verzeichnis ist kein echtes Verzeichnis.");
  }
  chmodSync(stageRoot, 0o700);
  const snapshotOutputPath = join(stageRoot, "reused-lipforcing-output.mp4");
  const snapshotSettingsSidecarPath = join(stageRoot, "reused-lipforcing-output.ltx-settings.json");
  const snapshotAnalysisSidecarPath = join(stageRoot, "reused-lipforcing-output.ltx-analysis.json");
  durableSnapshotCopy(reusable.outputPath, snapshotOutputPath, sourceOutput.revision);
  durableSnapshotCopy(reusable.settingsSidecarPath, snapshotSettingsSidecarPath, sourceSettings.revision);
  durableSnapshotCopy(reusable.analysisSidecarPath, snapshotAnalysisSidecarPath, sourceAnalysis.revision);
  const directoryDescriptor = openSync(stageRoot, "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }

  const snapshotOutput = await hashUnchangedExecutionFile(snapshotOutputPath, shouldStop);
  const snapshotSettings = await hashUnchangedExecutionFile(snapshotSettingsSidecarPath, shouldStop);
  const snapshotAnalysis = await hashUnchangedExecutionFile(snapshotAnalysisSidecarPath, shouldStop);
  if (snapshotOutput.sha256 !== sourceOutput.sha256
    || snapshotSettings.sha256 !== sourceSettings.sha256
    || snapshotAnalysis.sha256 !== sourceAnalysis.sha256) {
    throw new Error("Privater CPU-Reuse-Snapshot stimmt nicht kryptografisch mit der Baseline überein.");
  }

  const parsedSettings = JSON.parse(readFileSync(snapshotSettingsSidecarPath, "utf8")) as Record<string, unknown>;
  const rawSettingsRequestSha256 = experimentRequestSha256V1(parsedSettings.request);
  const settingsRequest = migrateGenerationRequest(structuredClone(parsedSettings.request));
  const settingsProvenance = normalizeRunProvenance(parsedSettings.runProvenance);
  const settingsRequestSha256 = settingsRequest
    ? experimentRequestSha256V1(settingsRequest)
    : null;
  const expectedAuthorityRequestSha256 = reusable.sourceAuthorityRequestSha256
    ?? reusable.baselineRequestSha256;
  const settingsMismatch = parsedSettings.outputName !== reusable.outputName
    ? "Outputname"
    : parsedSettings.jobId !== reusable.id
      ? "Job-ID"
      : rawSettingsRequestSha256 !== expectedAuthorityRequestSha256
        ? "Authority-Request-SHA-256"
        : settingsRequestSha256 !== reusable.baselineRequestSha256
          ? "migrierte Request-SHA-256"
        : settingsProvenance?.fingerprint !== reusable.sourceProvenanceFingerprint
          ? "Provenienz-Fingerprint"
          : !settingsProvenance.verifiedAt
            ? "Provenienz-Verifikation"
            : null;
  if (settingsMismatch) {
    throw new Error(
      `Einstellungs-Sidecar bindet nicht die exakt ausgewählte Baseline und ihre Provenienz (${settingsMismatch}).`,
    );
  }
  const analysis = outputAnalysisRecordSchema.parse(JSON.parse(readFileSync(snapshotAnalysisSidecarPath, "utf8")));
  if (analysis.outputName !== reusable.outputName
    || analysis.jobId !== reusable.id
    || analysis.status !== "completed"
    || analysis.sizeBytes !== sourceOutput.revision.sizeBytes
    || Math.abs(analysis.modifiedAtMs - sourceOutput.revision.modifiedAtMs) >= 1
    || Math.abs(analysis.changedAtMs - sourceOutput.revision.changedAtMs) >= 1
    || analysis.fileId !== sourceOutput.revision.fileId) {
    throw new Error("Analyse-Sidecar bindet nicht die unveränderte, abgeschlossene Baseline-Ausgabe.");
  }

  await afterSnapshot?.();
  assertCanContinue();
  const recheckedOutput = await hashUnchangedExecutionFile(reusable.outputPath, shouldStop);
  const recheckedSettings = await hashUnchangedExecutionFile(reusable.settingsSidecarPath, shouldStop);
  const recheckedAnalysis = await hashUnchangedExecutionFile(reusable.analysisSidecarPath, shouldStop);
  if (!sameHashedExecutionFile(sourceOutput, recheckedOutput)
    || !sameHashedExecutionFile(sourceSettings, recheckedSettings)
    || !sameHashedExecutionFile(sourceAnalysis, recheckedAnalysis)) {
    throw new Error("Baseline-Ausgabe oder Sidecars änderten sich während der privaten Snapshot-Erfassung.");
  }
  const finalSnapshotOutput = await hashUnchangedExecutionFile(snapshotOutputPath, shouldStop);
  const finalSnapshotSettings = await hashUnchangedExecutionFile(snapshotSettingsSidecarPath, shouldStop);
  const finalSnapshotAnalysis = await hashUnchangedExecutionFile(snapshotAnalysisSidecarPath, shouldStop);
  if (!sameHashedExecutionFile(snapshotOutput, finalSnapshotOutput)
    || !sameHashedExecutionFile(snapshotSettings, finalSnapshotSettings)
    || !sameHashedExecutionFile(snapshotAnalysis, finalSnapshotAnalysis)) {
    throw new Error("Privater CPU-Reuse-Snapshot oder seine Sidecars änderten sich vor der Freigabe.");
  }

  return {
    inputPath: snapshotOutputPath,
    source: {
      baselineJobId: reusable.id,
      baselineOutputName: reusable.outputName,
      baselineRequestSha256: reusable.baselineRequestSha256,
      sourceOutputPath: reusable.outputPath,
      outputSha256: sourceOutput.sha256,
      outputRevision: sourceOutput.revision,
      settingsSidecarPath: reusable.settingsSidecarPath,
      settingsSidecarSha256: sourceSettings.sha256,
      settingsSidecarRevision: sourceSettings.revision,
      analysisSidecarPath: reusable.analysisSidecarPath,
      analysisSidecarSha256: sourceAnalysis.sha256,
      analysisSidecarRevision: sourceAnalysis.revision,
      sourceProvenanceFingerprint: reusable.sourceProvenanceFingerprint,
      sourceProgramAudioDelayMs: reusable.programAudioDelayMs,
      snapshotOutputPath,
      snapshotOutputSha256: finalSnapshotOutput.sha256,
      snapshotOutputRevision: finalSnapshotOutput.revision,
      snapshotSettingsSidecarPath,
      snapshotSettingsSidecarSha256: finalSnapshotSettings.sha256,
      snapshotSettingsSidecarRevision: finalSnapshotSettings.revision,
      snapshotAnalysisSidecarPath,
      snapshotAnalysisSidecarSha256: finalSnapshotAnalysis.sha256,
      snapshotAnalysisSidecarRevision: finalSnapshotAnalysis.revision,
    },
  };
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

type RestoredExecutionAuthority = {
  executionClass?: JobExecutionClass;
  executionDecision?: JobExecutionDecision;
  error: string | null;
  cpuResumeAmbiguous: boolean;
  operationInterruptedOnRestore?: boolean;
};

function restoreExecutionAuthority(
  entry: PersistedStudioJob,
  authorityBoundRequest: unknown,
  request: GenerationRequest,
  experiment: ExperimentRunBinding | null,
  dgxJobId: string | null,
  storedStatus: JobStatus,
): RestoredExecutionAuthority {
  const hasClass = Object.prototype.hasOwnProperty.call(entry, "executionClass");
  const hasDecision = Object.prototype.hasOwnProperty.call(entry, "executionDecision");
  if (!hasDecision) {
    if (!hasClass) return { error: null, cpuResumeAmbiguous: false };
    if (!isJobExecutionClass(entry.executionClass)) {
      return {
        error: "Persistierte Legacy-Ausführungsklasse ist vorhanden, aber ungültig.",
        cpuResumeAmbiguous: false,
      };
    }
    if ((entry.executionClass === "pending"
      && (storedStatus !== "queued"
        || dgxJobId !== null
        || entry.dgxSubmitPending === true
        || entry.localProcessSpawnPending === true
        || entry.localProcessGroupPending === true))
      || (entry.executionClass === "cpu-only"
        && (dgxJobId !== null || entry.dgxSubmitPending === true))) {
      return {
        error: "Persistierte Legacy-Ausführungsklasse widerspricht Jobstatus oder DGX-Lease.",
        cpuResumeAmbiguous: false,
      };
    }
    return {
      executionClass: entry.executionClass,
      error: null,
      cpuResumeAmbiguous: entry.executionClass === "cpu-only" && isActiveJobStatus(storedStatus),
    };
  }
  const decision = normalizeJobExecutionDecision(entry.executionDecision);
  if (!decision || !hasClass || !isJobExecutionClass(entry.executionClass)) {
    return {
        error: "Persistierte ExecutionDecision.v5/v6 fehlt oder ist ungültig; ältere Versionen werden nicht still migriert.",
      cpuResumeAmbiguous: false,
    };
  }
  const requestSha256 = createHash("sha256").update(canonicalJson(authorityBoundRequest)).digest("hex");
  const protocolSha256 = experiment?.protocolSha256 ?? null;
  if (entry.executionClass !== decision.executionClass
    || decision.requestSha256 !== requestSha256
    || decision.protocolSha256 !== protocolSha256) {
    return {
      error: "Persistierte Ausführungsklasse, Request- oder Protokollbindung widerspricht der ExecutionDecision.",
      cpuResumeAmbiguous: false,
    };
  }
  if ((decision.executionClass === "pending" || decision.executionClass === "cpu-only")
    && (dgxJobId !== null || entry.dgxSubmitPending === true)) {
    return {
      error: "Persistierte Nicht-DGX-Entscheidung widerspricht einer vorhandenen DGX-Lease.",
      cpuResumeAmbiguous: false,
    };
  }
  const durablyUnarmedCrash = decision.executionClass === "pending"
    && entry.startDeferred === true
    && storedStatus === "interrupted"
    && entry.startedAt === null
    && dgxJobId === null
    && entry.dgxSubmitPending !== true
    && entry.localProcessSpawnPending !== true
    && entry.localProcessGroupPending !== true;
  const durablyNeverStartedTerminal = decision.executionClass === "pending"
    && (["cancelled", "failed", "interrupted"] as const).includes(
      storedStatus as "cancelled" | "failed" | "interrupted",
    )
    && entry.startedAt === null
    && dgxJobId === null
    && entry.dgxSubmitPending !== true
    && entry.localProcessSpawnPending !== true
    && entry.localProcessGroupPending !== true
    && entry.localProcessGroupIdentity === undefined
    && entry.ownedDockerContainer === undefined;
  if (decision.executionClass === "pending"
    && ((storedStatus !== "queued" && !durablyUnarmedCrash && !durablyNeverStartedTerminal)
      || entry.localProcessSpawnPending === true
      || entry.localProcessGroupPending === true)) {
    return {
      error: "Persistierte pending-Entscheidung widerspricht einem bereits gestarteten oder terminalen Job.",
      cpuResumeAmbiguous: false,
    };
  }
  if (decision.executionClass === "cpu-only") {
    const operationState = decision.operation.state;
    const operationMatchesJob = storedStatus === "completed"
      ? operationState === "succeeded"
      : storedStatus === "failed"
        ? operationState === "failed" || operationState === "succeeded"
        : storedStatus === "cancelled"
          ? operationState === "cancelled"
          : storedStatus === "interrupted"
            ? operationState === "interrupted" || operationState === "succeeded"
            : operationState === "prepared" || operationState === "running" || operationState === "succeeded";
    const commonBindingMatches = Boolean(
      experiment
      && experiment.arm === "candidate"
      && experiment.baselineJobId === decision.cpuReuse.baselineJobId
      && experiment.baselineOutputName === decision.cpuReuse.baselineOutputName
      && experiment.baselineRequestSha256 === decision.cpuReuse.baselineRequestSha256,
    );
    let operationBindingMatches = false;
    if ((decision.operation.kind === "ffmpeg-audio-retime"
      || decision.operation.kind === "ffmpeg-audio-retime-v2")
      && !("reuseKind" in decision.cpuReuse)) {
      const variableId = boundProgramAudioDelayVariable({ request, experiment });
      const operationMatchesVariable = decision.operation.kind === "ffmpeg-audio-retime-v2"
        ? variableId === "program-audio-delay-ms"
        : variableId === "lipforcing-program-audio-delay-ms";
      operationBindingMatches = variableId !== null
        && operationMatchesVariable
        && decision.operation.deltaMs
          === programAudioDelayValue(request, variableId)
            - decision.cpuReuse.sourceProgramAudioDelayMs;
    } else if (decision.operation.kind === "paired-artifact-promotion"
      && "reuseKind" in decision.cpuReuse
      && decision.cpuReuse.reuseKind === "lipforcing-raw-mux-pair") {
      operationBindingMatches = experiment?.variableId === "lipforcing-raw-output-profile"
        && experiment.changedRequestPaths.length === 1
        && experiment.changedRequestPaths[0] === LIPFORCING_RAW_OUTPUT_EXPERIMENT_PATH
        && validRawOutputExperimentBinding(request, experiment) !== null
        && decision.operation.authoritySha256 === decision.cpuReuse.authority.sha256;
    }
    if (!commonBindingMatches || !operationBindingMatches || !operationMatchesJob) {
      return {
        error: "Persistierte CPU-Reuse-Entscheidung widerspricht Baseline, Operation oder Jobstatus.",
        cpuResumeAmbiguous: false,
      };
    }
  }
  const runProvenance = normalizeRunProvenance(entry.runProvenance);
  if (runProvenance?.executionDecision && !runProvenanceFingerprintMatches(runProvenance)) {
    return {
      error: "Persistierter ExecutionDecision-Provenienz-Fingerprint ist ungültig.",
      cpuResumeAmbiguous: false,
    };
  }
  if ((decision.executionClass !== "pending" || runProvenance?.executionDecision !== undefined)
    && canonicalJson(runProvenance?.executionDecision) !== canonicalJson(decision)) {
    return {
      error: "Persistierte Laufprovenienz widerspricht der ExecutionDecision des Jobs.",
      cpuResumeAmbiguous: false,
    };
  }
  let restoredDecision = decision;
  let operationInterruptedOnRestore = false;
  if (decision.executionClass === "cpu-only"
    && isActiveJobStatus(storedStatus)
    && decision.operation.state === "prepared") {
    return {
      executionClass: decision.executionClass,
      executionDecision: decision,
      error: "Persistierte vorbereitete CPU-Operation besitzt nach dem Neustart keinen monoton belegbaren running-Zustand; sie bleibt unveraendert terminal fail-closed.",
      cpuResumeAmbiguous: false,
    };
  }
  if (decision.executionClass === "cpu-only"
    && isActiveJobStatus(storedStatus)
    && decision.operation.state === "running") {
    restoredDecision = {
      ...decision,
      operation: {
        ...decision.operation,
        state: "interrupted",
        completedAt: now(),
        exitCode: null,
        signal: null,
        errorSha256: createHash("sha256")
          .update("studio-restart-after-cpu-operation-running")
          .digest("hex"),
        output: null,
      },
    } as JobExecutionDecision;
    operationInterruptedOnRestore = true;
  }
  return {
    executionClass: decision.executionClass,
    executionDecision: restoredDecision,
    error: null,
    cpuResumeAmbiguous: decision.executionClass === "cpu-only" && isActiveJobStatus(storedStatus),
    operationInterruptedOnRestore,
  };
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

function hasExactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === allowed.length
    && [...allowed].sort().every((key, index) => key === keys[index]);
}

function normalizeOutputPublicationCommitPending(
  value: unknown,
): OutputPublicationCommitPending | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!hasExactKeys(candidate, ["schemaVersion", "completedAt", "completionMetadata"])
    || candidate.schemaVersion !== "ltx-studio-output-publication-commit.v1"
    || typeof candidate.completedAt !== "string"
    || !canonicalIsoTimestamp(candidate.completedAt)
    || !candidate.completionMetadata
    || typeof candidate.completionMetadata !== "object"
    || Array.isArray(candidate.completionMetadata)) return undefined;
  const normalizedDelivery = normalizeDgxTerminalDelivery({
    state: "completed",
    metadata: candidate.completionMetadata,
    attempts: 0,
    lastError: null,
    updatedAt: candidate.completedAt,
  });
  if (!normalizedDelivery
    || canonicalJson(normalizedDelivery.metadata) !== canonicalJson(candidate.completionMetadata)) {
    return undefined;
  }
  return {
    schemaVersion: "ltx-studio-output-publication-commit.v1",
    completedAt: candidate.completedAt,
    completionMetadata: normalizedDelivery.metadata,
  };
}

function normalizePreparedAdmission(value: unknown): AdmissionRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const cooperative = candidate.resumability !== undefined || candidate.scheduling !== undefined;
  const topLevelKeys = [
    "requested_by",
    "source_app",
    "job_type",
    "runtime",
    "priority",
    "estimated_memory_gib",
    "caller_network",
    "queue_ttl_seconds",
    "idempotency_key",
    "resource_profile",
    ...(cooperative ? ["resumability", "scheduling"] : []),
  ];
  if (!hasExactKeys(candidate, topLevelKeys)
    || typeof candidate.requested_by !== "string"
    || !candidate.requested_by.startsWith("ltx-studio:")
    || !STUDIO_JOB_ID_PATTERN.test(candidate.requested_by.slice("ltx-studio:".length))
    || candidate.source_app !== "LTX Studio"
    || typeof candidate.job_type !== "string"
    || !/^[a-z0-9_]{3,128}$/.test(candidate.job_type)
    || typeof candidate.runtime !== "string"
    || !/^[a-z0-9_]{3,128}$/.test(candidate.runtime)
    || candidate.priority !== "normal"
    || typeof candidate.estimated_memory_gib !== "number"
    || !Number.isFinite(candidate.estimated_memory_gib)
    || candidate.estimated_memory_gib <= 0
    || candidate.estimated_memory_gib > 1_024
    || candidate.caller_network !== "dgx_local"
    || typeof candidate.queue_ttl_seconds !== "number"
    || !Number.isInteger(candidate.queue_ttl_seconds)
    || candidate.queue_ttl_seconds <= 0
    || candidate.queue_ttl_seconds > 604_800
    || candidate.idempotency_key !== candidate.requested_by
    || !candidate.resource_profile
    || typeof candidate.resource_profile !== "object"
    || Array.isArray(candidate.resource_profile)) return undefined;
  const profile = candidate.resource_profile as Record<string, unknown>;
  if (!hasExactKeys(profile, ["gpu", "exclusive_runtime", "required_gib"])
    || profile.gpu !== true
    || profile.exclusive_runtime !== candidate.runtime
    || profile.required_gib !== candidate.estimated_memory_gib) return undefined;
  if (cooperative) {
    if (candidate.resumability !== "required"
      || !candidate.scheduling
      || typeof candidate.scheduling !== "object"
      || Array.isArray(candidate.scheduling)) return undefined;
    const scheduling = candidate.scheduling as Record<string, unknown>;
    if (!hasExactKeys(scheduling, [
      "mode",
      "preemptible",
      "yield_after_each_segment",
      "expected_segment_seconds",
      "resume_checkpoint",
    ])
      || scheduling.mode !== "segmented"
      || scheduling.preemptible !== true
      || scheduling.yield_after_each_segment !== true
      || typeof scheduling.expected_segment_seconds !== "number"
      || !Number.isFinite(scheduling.expected_segment_seconds)
      || scheduling.expected_segment_seconds <= 0
      || scheduling.expected_segment_seconds > 3_600
      || typeof scheduling.resume_checkpoint !== "string"
      || !isAbsolute(scheduling.resume_checkpoint)) return undefined;
  }
  return structuredClone(candidate) as AdmissionRequest;
}

function preparedAdmissionSha256(value: AdmissionRequest): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function dgxAuthoritySha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function dgxSuccessorAuthorityBindsAuthorization(
  authorization: DgxSuccessorAuthorizationBase,
  kind: "lease" | "terminal",
  receipt: DgxLeaseReceipt | DgxTerminalReceipt,
): boolean {
  if (receipt.studioJobId !== authorization.studioJobId
    || receipt.dgxJobId === authorization.predecessorDgxJobId
    || receipt.idempotencyKey
      !== authorization.predecessorLeaseReceipt.preparedAdmission.idempotency_key) return false;
  if (kind === "lease") {
    if (receipt.schemaVersion !== "ltx-studio-dgx-lease-receipt.v1") return false;
    const evidence = receipt.evidence;
    return receipt.submitStartedAt === authorization.authorizedAt
      && receipt.preparedAdmissionSha256 === authorization.preparedAdmissionSha256
      && canonicalJson(receipt.preparedAdmission)
        === canonicalJson(authorization.predecessorLeaseReceipt.preparedAdmission)
      && evidence.kind === "conditional-successor"
      && evidence.successorToken === authorization.successorToken
      && evidence.predecessorDgxJobId === authorization.predecessorDgxJobId
      && evidence.requestSha256 === authorization.requestSha256;
  }
  if (receipt.schemaVersion !== "ltx-studio-dgx-terminal-receipt.v1") return false;
  const evidence = receipt.evidence;
  return (evidence.kind === "conditional-successor"
      || evidence.kind === "conditional-successor-reaped")
    && evidence.successorToken === authorization.successorToken
    && evidence.predecessorDgxJobId === authorization.predecessorDgxJobId
    && evidence.requestSha256 === authorization.requestSha256;
}

function normalizeDgxLeaseReceipt(value: unknown): DgxLeaseReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<DgxLeaseReceipt>;
  const preparedAdmission = normalizePreparedAdmission(candidate.preparedAdmission);
  const confirmedAt = canonicalIsoTimestamp(candidate.confirmedAt);
  const submitStartedAt = canonicalIsoTimestamp(candidate.submitStartedAt);
  const observedCreatedAt = canonicalIsoTimestamp(candidate.observedCreatedAt);
  const rawEvidence = candidate.evidence;
  let evidence: DgxLeaseReceipt["evidence"] | undefined;
  if (rawEvidence && typeof rawEvidence === "object" && !Array.isArray(rawEvidence)) {
    if (rawEvidence.kind === "submit-response"
      && rawEvidence.schemaVersion === "dgx-queue-submit.v0") {
      evidence = {
        kind: "submit-response",
        schemaVersion: "dgx-queue-submit.v0",
      };
    } else if (rawEvidence.kind === "queue-positive"
      && rawEvidence.schemaVersion === "dgx-queue-read.v0") {
      const observedAt = canonicalIsoTimestamp(rawEvidence.observedAt);
      if (observedAt) {
        evidence = {
          kind: "queue-positive",
          schemaVersion: "dgx-queue-read.v0",
          observedAt,
        };
      }
    } else if (rawEvidence.kind === "conditional-successor"
      && rawEvidence.schemaVersion === "dgx-conditional-successor-result.v0"
      && /^[0-9a-f]{64}$/.test(rawEvidence.successorToken)
      && isDgxJobId(rawEvidence.predecessorDgxJobId)
      && /^[0-9a-f]{64}$/.test(rawEvidence.requestSha256)
      && (rawEvidence.outcome === "created" || rawEvidence.outcome === "replayed")) {
      evidence = {
        kind: "conditional-successor",
        schemaVersion: "dgx-conditional-successor-result.v0",
        successorToken: rawEvidence.successorToken,
        predecessorDgxJobId: rawEvidence.predecessorDgxJobId,
        requestSha256: rawEvidence.requestSha256,
        outcome: rawEvidence.outcome,
      };
    }
  }
  const futureLimit = Date.now() + 5 * 60_000;
  if (candidate.schemaVersion !== "ltx-studio-dgx-lease-receipt.v1"
    || typeof candidate.studioJobId !== "string"
    || !STUDIO_JOB_ID_PATTERN.test(candidate.studioJobId)
    || !isDgxJobId(candidate.dgxJobId)
    || candidate.requestedBy !== `ltx-studio:${candidate.studioJobId}`
    || candidate.sourceApp !== "LTX Studio"
    || candidate.idempotencyKey !== candidate.requestedBy
    || !preparedAdmission
    || preparedAdmission.requested_by !== candidate.requestedBy
    || candidate.preparedAdmissionSha256 !== preparedAdmissionSha256(preparedAdmission)
    || !submitStartedAt
    || (candidate.observedState !== "accepted" && candidate.observedState !== "queued")
    || !observedCreatedAt
    || !evidence
    || !confirmedAt
    || Date.parse(observedCreatedAt) < Date.parse(submitStartedAt)
    || Date.parse(confirmedAt) < Date.parse(observedCreatedAt)
    || Date.parse(submitStartedAt) > futureLimit
    || Date.parse(observedCreatedAt) > futureLimit
    || Date.parse(confirmedAt) > futureLimit
    || (evidence.kind === "queue-positive"
      && (Date.parse(evidence.observedAt) < Date.parse(observedCreatedAt)
        || Date.parse(confirmedAt) < Date.parse(evidence.observedAt)
        || Date.parse(evidence.observedAt) > futureLimit))) return undefined;
  return {
    schemaVersion: candidate.schemaVersion,
    studioJobId: candidate.studioJobId,
    dgxJobId: candidate.dgxJobId,
    requestedBy: candidate.requestedBy,
    sourceApp: "LTX Studio",
    idempotencyKey: candidate.idempotencyKey,
    preparedAdmission,
    preparedAdmissionSha256: candidate.preparedAdmissionSha256,
    submitStartedAt,
    observedState: candidate.observedState,
    observedCreatedAt,
    evidence,
    confirmedAt,
  };
}

function normalizeDgxSuccessorAuthorization(
  value: unknown,
): DgxSuccessorAuthorization | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<DgxSuccessorAuthorization>;
  const predecessorLeaseReceipt = normalizeDgxLeaseReceipt(candidate.predecessorLeaseReceipt);
  const authorizedAt = canonicalIsoTimestamp(candidate.authorizedAt);
  const rawReplayEvidence = candidate.replayEvidence;
  if (candidate.schemaVersion !== "ltx-studio-dgx-successor-authorization.v1"
    || candidate.generation !== 1
    || typeof candidate.successorToken !== "string"
    || !/^[0-9a-f]{64}$/.test(candidate.successorToken)
    || typeof candidate.studioJobId !== "string"
    || !STUDIO_JOB_ID_PATTERN.test(candidate.studioJobId)
    || !isDgxJobId(candidate.predecessorDgxJobId)
    || !predecessorLeaseReceipt
    || predecessorLeaseReceipt.studioJobId !== candidate.studioJobId
    || predecessorLeaseReceipt.dgxJobId !== candidate.predecessorDgxJobId
    || candidate.predecessorLeaseReceiptSha256 !== dgxAuthoritySha256(predecessorLeaseReceipt)
    || candidate.preparedAdmissionSha256 !== predecessorLeaseReceipt.preparedAdmissionSha256
    || !dgxRuntimeRequestSha256Matches(
      predecessorLeaseReceipt.preparedAdmission,
      candidate.requestSha256,
    )
    || !authorizedAt
    || Date.parse(authorizedAt) < Date.parse(predecessorLeaseReceipt.confirmedAt)
    || Date.parse(authorizedAt) > Date.now() + 5 * 60_000
    || !rawReplayEvidence
    || typeof rawReplayEvidence !== "object"
    || Array.isArray(rawReplayEvidence)
    || rawReplayEvidence.kind !== "exact-bound-replay"
    || rawReplayEvidence.schemaVersion !== "dgx-queue-submit.v0"
    || rawReplayEvidence.replayBoundJobId !== candidate.predecessorDgxJobId
    || rawReplayEvidence.idempotentReplay !== true
    || (rawReplayEvidence.terminalState !== "failed"
      && rawReplayEvidence.terminalState !== "rejected"
      && rawReplayEvidence.terminalState !== "cancelled")
    || rawReplayEvidence.reservationActive !== false
    || rawReplayEvidence.admissionReservationActive !== false
    || !isDgxNeverStarted(rawReplayEvidence.startedAt)
    || rawReplayEvidence.admissionDecision !== "rejected_terminal_record"
    || rawReplayEvidence.admissionReason !== "unstarted_terminal_record_released"
    || rawReplayEvidence.clientAction !== "retry_now_key_is_free") return undefined;
  const replayEvidence: DgxSuccessorReplayEvidence = {
    kind: "exact-bound-replay",
    schemaVersion: "dgx-queue-submit.v0",
    replayBoundJobId: candidate.predecessorDgxJobId,
    idempotentReplay: true,
    terminalState: rawReplayEvidence.terminalState,
    reservationActive: false,
    admissionReservationActive: false,
    startedAt: rawReplayEvidence.startedAt,
    admissionDecision: "rejected_terminal_record",
    admissionReason: "unstarted_terminal_record_released",
    clientAction: "retry_now_key_is_free",
  };
  const base: DgxSuccessorAuthorizationBase = {
    schemaVersion: "ltx-studio-dgx-successor-authorization.v1",
    generation: 1,
    successorToken: candidate.successorToken,
    studioJobId: candidate.studioJobId,
    predecessorDgxJobId: candidate.predecessorDgxJobId,
    predecessorLeaseReceipt,
    predecessorLeaseReceiptSha256: candidate.predecessorLeaseReceiptSha256,
    preparedAdmissionSha256: candidate.preparedAdmissionSha256,
    requestSha256: candidate.requestSha256,
    authorizedAt,
    replayEvidence,
  };
  if (candidate.phase === "submit-pending") return { ...base, phase: "submit-pending" };
  const consumedCandidate = candidate as Partial<Extract<
    DgxSuccessorAuthorization,
    { phase: "consumed" }
  >>;
  const consumedAt = canonicalIsoTimestamp(
    candidate.phase === "consumed" ? consumedCandidate.consumedAt : undefined,
  );
  const successorAuthorityReceipt = consumedCandidate.successorAuthorityKind === "lease"
    ? normalizeDgxLeaseReceipt(consumedCandidate.successorAuthorityReceipt)
    : consumedCandidate.successorAuthorityKind === "terminal"
      ? normalizeDgxTerminalReceipt(consumedCandidate.successorAuthorityReceipt)
      : undefined;
  if (candidate.phase !== "consumed"
    || !isDgxJobId(consumedCandidate.successorDgxJobId)
    || consumedCandidate.successorDgxJobId === candidate.predecessorDgxJobId
    || (consumedCandidate.successorAuthorityKind !== "lease"
      && consumedCandidate.successorAuthorityKind !== "terminal")
    || !successorAuthorityReceipt
    || successorAuthorityReceipt.studioJobId !== candidate.studioJobId
    || successorAuthorityReceipt.dgxJobId !== consumedCandidate.successorDgxJobId
    || successorAuthorityReceipt.idempotencyKey
      !== predecessorLeaseReceipt.preparedAdmission.idempotency_key
    || (consumedCandidate.successorAuthorityKind === "lease"
      && (successorAuthorityReceipt.schemaVersion !== "ltx-studio-dgx-lease-receipt.v1"
        || successorAuthorityReceipt.preparedAdmissionSha256
          !== candidate.preparedAdmissionSha256
        || canonicalJson(successorAuthorityReceipt.preparedAdmission)
          !== canonicalJson(predecessorLeaseReceipt.preparedAdmission)))
    || !dgxSuccessorAuthorityBindsAuthorization(
      base,
      consumedCandidate.successorAuthorityKind,
      successorAuthorityReceipt,
    )
    || typeof consumedCandidate.successorAuthoritySha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(consumedCandidate.successorAuthoritySha256)
    || consumedCandidate.successorAuthoritySha256 !== dgxAuthoritySha256(successorAuthorityReceipt)
    || !consumedAt
    || Date.parse(consumedAt) < Date.parse(authorizedAt)
    || Date.parse(consumedAt) > Date.now() + 5 * 60_000) return undefined;
  return {
    ...base,
    phase: "consumed",
    successorDgxJobId: consumedCandidate.successorDgxJobId,
    successorAuthorityKind: consumedCandidate.successorAuthorityKind,
    successorAuthorityReceipt,
    successorAuthoritySha256: consumedCandidate.successorAuthoritySha256,
    consumedAt,
  };
}

function dgxSuccessorAuthorizationBindsPredecessor(
  value: unknown,
  receipt: DgxLeaseReceipt,
): boolean {
  const authorization = normalizeDgxSuccessorAuthorization(value);
  return Boolean(
    authorization
    && authorization.studioJobId === receipt.studioJobId
    && authorization.predecessorDgxJobId === receipt.dgxJobId
    && authorization.predecessorLeaseReceiptSha256 === dgxAuthoritySha256(receipt)
    && canonicalJson(authorization.predecessorLeaseReceipt) === canonicalJson(receipt),
  );
}

function consumeDgxSuccessorAuthorization(
  value: unknown,
  successorDgxJobId: string,
  successorAuthorityKind: "lease" | "terminal",
  successorAuthority: DgxLeaseReceipt | DgxTerminalReceipt,
): DgxSuccessorAuthorization | undefined {
  const authorization = normalizeDgxSuccessorAuthorization(value);
  if (!authorization
    || authorization.phase !== "submit-pending"
    || !isDgxJobId(successorDgxJobId)
    || successorDgxJobId === authorization.predecessorDgxJobId
    || successorAuthority.dgxJobId !== successorDgxJobId
    || !dgxSuccessorAuthorityBindsAuthorization(
      authorization,
      successorAuthorityKind,
      successorAuthority,
    )) return undefined;
  return {
    ...authorization,
    phase: "consumed",
    successorDgxJobId,
    successorAuthorityKind,
    successorAuthorityReceipt: structuredClone(successorAuthority),
    successorAuthoritySha256: dgxAuthoritySha256(successorAuthority),
    consumedAt: now(),
  };
}

function requireDgxLeaseAuthority(job: RuntimeJob): DgxLeaseReceipt {
  const receipt = normalizeDgxLeaseReceipt(job.dgxLeaseReceipt);
  if (!receipt
    || !job.dgxJobId
    || receipt.studioJobId !== job.id
    || receipt.dgxJobId !== job.dgxJobId
    || canonicalJson(receipt) !== canonicalJson(job.dgxLeaseReceipt)) {
    throw new DgxLeaseAuthorityError(
      "DGX-Lease besitzt kein gültiges dauerhaftes Submit-Receipt; Remote-Zugriff bleibt gesperrt.",
    );
  }
  return receipt;
}

function dgxCooperativeFlagLabel(value: boolean | undefined): string {
  return value === true ? "true" : value === false ? "false" : "fehlend";
}

function assertDgxCooperativeQueueContract(
  job: RuntimeJob,
  remote: QueueJobSummary,
  boundary: string,
): void {
  const admission = requireDgxLeaseAuthority(job).preparedAdmission;
  if (cooperativeQueueContractConfirmed(admission, remote)) return;
  throw new DgxCooperativeQueueContractError(
    `DGX-Orchestrator-Vertragsabweichung ${boundary}: Der kooperative LTX-Request verlangt `
      + "durable_waiter=true und segment_waiter=true, der positive Record meldet "
      + `durable_waiter=${dgxCooperativeFlagLabel(remote.durable_waiter)} und `
      + `segment_waiter=${dgxCooperativeFlagLabel(remote.segment_waiter)}. `
      + "Lokale GPU-Allokation bleibt fail-closed gesperrt; der Remote-Record wird terminal bereinigt.",
    remote.state,
  );
}

function dgxCooperativeContractTerminalState(
  remoteState: QueueJobState,
): Extract<DgxTerminalState, "cancelled" | "failed"> {
  return remoteState === "accepted" || remoteState === "queued" || remoteState === "paused"
    ? "cancelled"
    : "failed";
}

function normalizeDgxTerminalReceipt(value: unknown): DgxTerminalReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<DgxTerminalReceipt>;
  const confirmedAt = canonicalIsoTimestamp(candidate.confirmedAt);
  if (candidate.schemaVersion !== "ltx-studio-dgx-terminal-receipt.v1"
    || typeof candidate.studioJobId !== "string"
    || !STUDIO_JOB_ID_PATTERN.test(candidate.studioJobId)
    || !isDgxJobId(candidate.dgxJobId)
    || candidate.idempotencyKey !== `ltx-studio:${candidate.studioJobId}`
    || !candidate.localIntentState
    || !DGX_TERMINAL_STATES.has(candidate.localIntentState)
    || !candidate.remoteTerminalState
    || !DGX_REMOTE_TERMINAL_STATES.has(candidate.remoteTerminalState)
    || !confirmedAt) return undefined;

  const rawEvidence = candidate.evidence;
  if (!rawEvidence || typeof rawEvidence !== "object" || Array.isArray(rawEvidence)) return undefined;
  const expectedCaller = `ltx-studio:${candidate.studioJobId}`;
  let evidence: DgxTerminalReceipt["evidence"];
  if (rawEvidence.kind === "job-read"
    && rawEvidence.schemaVersion === "dgx-job-read.v0"
    && rawEvidence.requestedBy === expectedCaller
    && rawEvidence.sourceApp === "LTX Studio"
    && rawEvidence.idempotencyKey === expectedCaller) {
    evidence = {
      kind: "job-read",
      schemaVersion: "dgx-job-read.v0",
      requestedBy: expectedCaller,
      sourceApp: "LTX Studio",
      idempotencyKey: expectedCaller,
    };
  } else if (rawEvidence.kind === "job-transition"
    && rawEvidence.schemaVersion === "dgx-job-transition.v0"
    && rawEvidence.requestedBy === expectedCaller
    && rawEvidence.sourceApp === "LTX Studio"
    && rawEvidence.idempotencyKey === expectedCaller) {
    evidence = {
      kind: "job-transition",
      schemaVersion: "dgx-job-transition.v0",
      requestedBy: expectedCaller,
      sourceApp: "LTX Studio",
      idempotencyKey: expectedCaller,
    };
  } else if (rawEvidence.kind === "queue-submit"
    && rawEvidence.schemaVersion === "dgx-queue-submit.v0"
    && rawEvidence.requestedBy === expectedCaller
    && rawEvidence.sourceApp === "LTX Studio"
    && rawEvidence.idempotencyKey === expectedCaller) {
    evidence = {
      kind: "queue-submit",
      schemaVersion: "dgx-queue-submit.v0",
      requestedBy: expectedCaller,
      sourceApp: "LTX Studio",
      idempotencyKey: expectedCaller,
    };
  } else if (rawEvidence.kind === "queue-replay"
    && rawEvidence.schemaVersion === "dgx-queue-submit.v0"
    && rawEvidence.requestedBy === expectedCaller
    && rawEvidence.sourceApp === "LTX Studio"
    && rawEvidence.idempotencyKey === expectedCaller
    && rawEvidence.replayBoundJobId === candidate.dgxJobId
    && rawEvidence.idempotentReplay === true) {
    evidence = {
      kind: "queue-replay",
      schemaVersion: "dgx-queue-submit.v0",
      requestedBy: expectedCaller,
      sourceApp: "LTX Studio",
      idempotencyKey: expectedCaller,
      replayBoundJobId: candidate.dgxJobId,
      idempotentReplay: true,
    };
  } else if (rawEvidence.kind === "conditional-successor"
    && rawEvidence.schemaVersion === "dgx-conditional-successor-result.v0"
    && /^[0-9a-f]{64}$/.test(rawEvidence.successorToken)
    && isDgxJobId(rawEvidence.predecessorDgxJobId)
    && rawEvidence.predecessorDgxJobId !== candidate.dgxJobId
    && /^[0-9a-f]{64}$/.test(rawEvidence.requestSha256)
    && (rawEvidence.outcome === "created" || rawEvidence.outcome === "terminal")
    && rawEvidence.requestedBy === expectedCaller
    && rawEvidence.sourceApp === "LTX Studio"
    && rawEvidence.idempotencyKey === expectedCaller) {
    evidence = {
      kind: "conditional-successor",
      schemaVersion: "dgx-conditional-successor-result.v0",
      successorToken: rawEvidence.successorToken,
      predecessorDgxJobId: rawEvidence.predecessorDgxJobId,
      requestSha256: rawEvidence.requestSha256,
      outcome: rawEvidence.outcome,
      requestedBy: expectedCaller,
      sourceApp: "LTX Studio",
      idempotencyKey: expectedCaller,
    };
  } else if (rawEvidence.kind === "conditional-successor-reaped"
    && rawEvidence.schemaVersion === "dgx-conditional-successor-result.v0"
    && rawEvidence.runtimeEvidenceSchemaVersion === "dgx-conditional-successor-terminal.v0"
    && /^[0-9a-f]{64}$/.test(rawEvidence.successorToken)
    && isDgxJobId(rawEvidence.predecessorDgxJobId)
    && rawEvidence.predecessorDgxJobId !== candidate.dgxJobId
    && /^[0-9a-f]{64}$/.test(rawEvidence.requestSha256)
    && rawEvidence.idempotencyKey === expectedCaller
    && /^[0-9a-f]{64}$/.test(rawEvidence.recordSha256)
    && typeof rawEvidence.decision === "string"
    && rawEvidence.decision.length > 0
    && typeof rawEvidence.reason === "string"
    && rawEvidence.reason.length > 0
    && typeof rawEvidence.clientAction === "string"
    && rawEvidence.clientAction.length > 0) {
    const createdAt = canonicalIsoTimestamp(rawEvidence.createdAt);
    const finishedAt = canonicalIsoTimestamp(rawEvidence.finishedAt);
    const reapedAt = canonicalIsoTimestamp(rawEvidence.reapedAt);
    const startedAt = isDgxNeverStarted(rawEvidence.startedAt)
      ? rawEvidence.startedAt
      : canonicalIsoTimestamp(rawEvidence.startedAt);
    if (!createdAt
      || !finishedAt
      || !reapedAt
      || startedAt === null && !isDgxNeverStarted(rawEvidence.startedAt)
      || Date.parse(finishedAt) < Date.parse(createdAt)
      || (startedAt !== null
        && startedAt !== ""
        && (Date.parse(startedAt) < Date.parse(createdAt)
          || Date.parse(startedAt) > Date.parse(finishedAt)))
      || Date.parse(reapedAt) < Date.parse(finishedAt)) return undefined;
    evidence = {
      kind: "conditional-successor-reaped",
      schemaVersion: "dgx-conditional-successor-result.v0",
      runtimeEvidenceSchemaVersion: "dgx-conditional-successor-terminal.v0",
      successorToken: rawEvidence.successorToken,
      predecessorDgxJobId: rawEvidence.predecessorDgxJobId,
      requestSha256: rawEvidence.requestSha256,
      idempotencyKey: expectedCaller,
      createdAt,
      startedAt,
      finishedAt,
      reapedAt,
      decision: rawEvidence.decision,
      reason: rawEvidence.reason,
      clientAction: rawEvidence.clientAction,
      recordSha256: rawEvidence.recordSha256,
    };
  } else if (rawEvidence.kind === "job-gone"
    && rawEvidence.schemaVersion === "ltx-studio-dgx-job-gone-evidence.v1"
    && rawEvidence.runtimeSchemaVersion === "dgx-job-gone.v0"
    && rawEvidence.idempotencyKey === expectedCaller
    && typeof rawEvidence.requestSha256 === "string"
    && /^[0-9a-f]{64}$/.test(rawEvidence.requestSha256)) {
    const finishedAt = canonicalIsoTimestamp(rawEvidence.finishedAt);
    const reapedAt = canonicalIsoTimestamp(rawEvidence.reapedAt);
    if (!finishedAt
      || !reapedAt
      || Date.parse(reapedAt) < Date.parse(finishedAt)
      || (rawEvidence.reason !== null && typeof rawEvidence.reason !== "string")) return undefined;
    evidence = {
      kind: "job-gone",
      schemaVersion: "ltx-studio-dgx-job-gone-evidence.v1",
      runtimeSchemaVersion: "dgx-job-gone.v0",
      idempotencyKey: expectedCaller,
      requestSha256: rawEvidence.requestSha256,
      finishedAt,
      reapedAt,
      reason: rawEvidence.reason === null ? null : rawEvidence.reason.slice(0, 1_000),
    };
  } else if (rawEvidence.kind === "job-gone"
    && rawEvidence.schemaVersion === "dgx-job-gone.v0"
    && rawEvidence.idempotencyKey === expectedCaller) {
    const finishedAt = canonicalIsoTimestamp(rawEvidence.finishedAt);
    const reapedAt = canonicalIsoTimestamp(rawEvidence.reapedAt);
    if (!finishedAt
      || !reapedAt
      || Date.parse(reapedAt) < Date.parse(finishedAt)
      || (rawEvidence.reason !== null && typeof rawEvidence.reason !== "string")) return undefined;
    evidence = {
      kind: "job-gone",
      schemaVersion: "dgx-job-gone.v0",
      idempotencyKey: expectedCaller,
      finishedAt,
      reapedAt,
      reason: rawEvidence.reason === null ? null : rawEvidence.reason.slice(0, 1_000),
    };
  } else {
    return undefined;
  }
  return {
    schemaVersion: candidate.schemaVersion,
    studioJobId: candidate.studioJobId,
    dgxJobId: candidate.dgxJobId,
    idempotencyKey: candidate.idempotencyKey,
    localIntentState: candidate.localIntentState,
    remoteTerminalState: candidate.remoteTerminalState,
    confirmedAt,
    evidence,
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

  snapshot(): {
    denoisingStage: number;
    phase: "preparing" | "denoising" | "decoding";
    current: number;
  } {
    return {
      denoisingStage: this.denoisingStage,
      phase: this.phase,
      current: this.current,
    };
  }

  restore(snapshot: ReturnType<PipelineProgressTracker["snapshot"]>): void {
    this.denoisingStage = snapshot.denoisingStage;
    this.phase = snapshot.phase;
    this.current = snapshot.current;
  }
}

function processIsAlive(child: ChildProcess): boolean {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function jobWasCancelled(job: RuntimeJob): boolean {
  return job.status === "cancelled" || job.status === "interrupted";
}

function signalExactProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
  child?: ChildProcess,
): boolean {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if (child?.pid === processGroupId && processIsAlive(child)) return child.kill(signal);
    throw error;
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (!child.pid) return false;
  return signalExactProcessGroup(child.pid, signal, child);
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
  return Object.keys(identity).sort().join(",") === "bootId,leaderStartTicks,processGroupId"
    && typeof identity.bootId === "string"
    && STUDIO_JOB_ID_PATTERN.test(identity.bootId)
    && typeof identity.processGroupId === "number"
    && Number.isSafeInteger(identity.processGroupId)
    && identity.processGroupId > 0
    && typeof identity.leaderStartTicks === "string"
    && /^[0-9]+$/u.test(identity.leaderStartTicks);
}

function ownedDockerWorkload(id: unknown): OwnedDockerThermalWorkload | null {
  return Object.values(OWNED_DOCKER_THERMAL_WORKLOADS)
    .find((candidate) => candidate.id === id) ?? null;
}

function normalizeOwnedDockerContainerAuthority(
  value: unknown,
  studioJobId: string,
  dgxJobId: string | null,
): OwnedDockerContainerAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !dgxJobId) return null;
  const authority = value as Record<string, unknown>;
  const workload = ownedDockerWorkload(authority.workload);
  if (!workload
    || authority.dgxJobId !== dgxJobId
    || authority.name !== `${workload.containerPrefix}${studioJobId}`
    || !(authority.containerId === null
      || (typeof authority.containerId === "string" && /^[0-9a-f]{64}$/u.test(authority.containerId)))
    || !["bound", "running", "paused", "cleanup"].includes(String(authority.state))) return null;

  const v1Keys = "containerId,dgxJobId,name,schemaVersion,state,workload";
  if (authority.schemaVersion === "ltx-studio-owned-docker-container.v1"
    && Object.keys(authority).sort().join(",") === v1Keys) {
    return {
      schemaVersion: "ltx-studio-owned-docker-container.v2",
      name: authority.name as string,
      containerId: authority.containerId as string | null,
      dgxJobId,
      workload: workload.id,
      state: authority.state as OwnedDockerContainerState,
      // A legacy non-bound wrapper may already have sent docker create. Treat
      // it conservatively as a freshly released gate on first v2 restore.
      startGateReleasedAt: authority.state === "bound" ? null : now(),
      absenceProofStartedAt: null,
      absenceProofCount: 0,
    };
  }

  const v2Keys = "absenceProofCount,absenceProofStartedAt,containerId,dgxJobId,name,schemaVersion,startGateReleasedAt,state,workload";
  const validTimestamp = (timestamp: unknown): timestamp is string =>
    typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp));
  const absenceProofValid = authority.absenceProofStartedAt === null
    ? authority.absenceProofCount === 0
    : validTimestamp(authority.absenceProofStartedAt)
      && Number.isSafeInteger(authority.absenceProofCount)
      && (authority.absenceProofCount as number) > 0
      && (authority.absenceProofCount as number) <= OWNED_DOCKER_CREATION_ABSENCE_PROOFS;
  const releaseStateValid = authority.state === "bound"
    ? authority.startGateReleasedAt === null
    : ["running", "paused"].includes(String(authority.state))
      ? validTimestamp(authority.startGateReleasedAt)
      : authority.startGateReleasedAt === null || validTimestamp(authority.startGateReleasedAt);
  const proofTimelineValid = authority.absenceProofStartedAt === null
    || (validTimestamp(authority.startGateReleasedAt)
      && Date.parse(authority.absenceProofStartedAt as string)
        >= Date.parse(authority.startGateReleasedAt));
  if (authority.schemaVersion !== "ltx-studio-owned-docker-container.v2"
    || Object.keys(authority).sort().join(",") !== v2Keys
    || !releaseStateValid
    || !absenceProofValid
    || !proofTimelineValid) return null;
  return {
    schemaVersion: "ltx-studio-owned-docker-container.v2",
    name: authority.name as string,
    containerId: authority.containerId as string | null,
    dgxJobId,
    workload: workload.id,
    state: authority.state as OwnedDockerContainerState,
    startGateReleasedAt: authority.startGateReleasedAt as string | null,
    absenceProofStartedAt: authority.absenceProofStartedAt as string | null,
    absenceProofCount: authority.absenceProofCount as number,
  };
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
  await terminateExactProcessGroup(child.pid, wasPaused, graceMs, deadlineMs, child);
}

async function terminateExactProcessGroup(
  processGroupId: number,
  wasPaused: boolean,
  graceMs = 10_000,
  deadlineMs = 15_000,
  child?: ChildProcess,
): Promise<void> {
  if (wasPaused) signalExactProcessGroup(processGroupId, "SIGCONT", child);
  signalExactProcessGroup(processGroupId, "SIGTERM", child);
  const startedAt = Date.now();
  if (await waitForProcessGroupExit(processGroupId, startedAt + graceMs)) return;
  signalExactProcessGroup(processGroupId, "SIGKILL", child);
  if (!await waitForProcessGroupExit(processGroupId, startedAt + deadlineMs)) {
    throw new Error(`Prozessgruppe ${processGroupId} blieb nach SIGKILL aktiv.`);
  }
}

function runtimeSettlementPending(job: RuntimeJob): boolean {
  return Boolean(
    job.process
    || job.processTermination
    || job.localProcessSpawnPending
    || job.localProcessGroupPending
    || job.localProcessGroupIdentity
    || job.localProcessGroupRetry
    || job.ownedDockerContainer
    || job.ownedDockerContainerRecoveryBlocked
    || job.ownedDockerContainerCleanup
    || job.ownedDockerContainerRetry
    || job.dgxSubmitPending
    || job.dgxSubmitReconcileRetry
    || job.dgxSubmitReconcileInFlight
    || job.dgxAdmissionAbortController
    || job.dgxStateTransitionInFlight
    || job.dgxSuccessorSubmitInFlight
    || job.dgxTerminalDelivery
    || job.dgxTerminalDeliveryInFlight
    || job.dgxTerminalRetry
    || (job.dgxOwnerHeartbeat && !job.dgxOwnerHeartbeat.stopped)
  );
}

function publicJob(
  job: RuntimeJob,
  persistenceHeld = false,
  settlementPending = runtimeSettlementPending(job),
): StudioJob {
  const value = { ...job } as Partial<RuntimeJob>;
  value.cancellationState = job.cancelledBy === "studio"
    ? (persistenceHeld || settlementPending) ? "settling" : "settled"
    : null;
  value.historyStatus = job.legacyHistory ? "legacy-unattested" : undefined;
  value.historicalDgxJobId = job.legacyHistory?.historicalDgxJobId ?? undefined;
  delete value.plan;
  delete value.authorityBoundRequest;
  delete value.authorityRequestSha256;
  delete value.legacyTextToAudioPeakCeilingUnset;
  delete value.legacyHistory;
  delete value.outputPublicationCommitPending;
  delete value.localProcessProtocol;
  delete value.process;
  delete value.processTermination;
  delete value.localProcessSpawnPending;
  delete value.localProcessGroupPending;
  delete value.localProcessGroupIdentity;
  delete value.localProcessGroupRetry;
  delete value.ownedDockerContainer;
  delete value.ownedDockerContainerIdDurablyCommitted;
  delete value.ownedDockerContainerRecoveryBlocked;
  delete value.ownedDockerContainerCleanup;
  delete value.ownedDockerContainerRetry;
  delete value.dgxSubmitPending;
  delete value.dgxSubmitStartedAt;
  delete value.dgxPreparedAdmission;
  delete value.dgxPreparedAdmissionSha256;
  delete value.dgxSubmitReconcileRetry;
  delete value.dgxSubmitReconcileInFlight;
  delete value.dgxSubmitReconcileDelayMs;
  delete value.dgxAdmissionAbortController;
  delete value.dgxJobTerminal;
  delete value.dgxLeaseReceipt;
  delete value.dgxStateTransitionInFlight;
  delete value.dgxSuccessorAuthorization;
  delete value.dgxSuccessorSubmitInFlight;
  delete value.dgxTerminalDelivery;
  delete value.dgxTerminalReceipt;
  delete value.dgxTerminalDeliveryInFlight;
  delete value.dgxTerminalRetry;
  delete value.dgxOwnerHeartbeat;
  delete value.startSource;
  delete value.startDeferred;
  delete value.outputPublication;
  return value as StudioJob;
}

function persistedJob(job: RuntimeJob): PersistedStudioJob {
  const value: PersistedStudioJob = publicJob(job);
  delete value.cancellationState;
  delete value.historyStatus;
  delete value.historicalDgxJobId;
  value.request = structuredClone(job.authorityBoundRequest);
  if (job.legacyHistory) value.legacyHistory = structuredClone(job.legacyHistory);
  if (job.outputPublicationCommitPending) {
    value.outputPublicationCommitPending = structuredClone(job.outputPublicationCommitPending);
  }
  value.localProcessProtocol = job.localProcessProtocol;
  if (job.outputPublication) value.outputPublication = structuredClone(job.outputPublication);
  value.startSource = job.startSource;
  if (job.startDeferred) value.startDeferred = true;
  if (job.dgxTerminalDelivery) value.dgxTerminalDelivery = structuredClone(job.dgxTerminalDelivery);
  if (job.dgxTerminalReceipt) value.dgxTerminalReceipt = structuredClone(job.dgxTerminalReceipt);
  if (job.dgxLeaseReceipt) value.dgxLeaseReceipt = structuredClone(job.dgxLeaseReceipt);
  if (job.dgxSuccessorAuthorization) {
    value.dgxSuccessorAuthorization = structuredClone(job.dgxSuccessorAuthorization);
  }
  if (job.localProcessSpawnPending) value.localProcessSpawnPending = true;
  if (job.localProcessGroupPending) value.localProcessGroupPending = true;
  if (job.localProcessGroupIdentity) {
    value.localProcessGroupIdentity = structuredClone(job.localProcessGroupIdentity);
  }
  if (job.ownedDockerContainer) {
    value.ownedDockerContainer = structuredClone(job.ownedDockerContainer);
  }
  if (job.ownedDockerContainerRecoveryBlocked) {
    value.ownedDockerContainerRecoveryBlocked = true;
  }
  if (job.dgxSubmitPending) value.dgxSubmitPending = true;
  if (job.dgxSubmitStartedAt) value.dgxSubmitStartedAt = job.dgxSubmitStartedAt;
  if (job.dgxPreparedAdmission) {
    value.dgxPreparedAdmission = structuredClone(job.dgxPreparedAdmission);
  }
  if (job.dgxPreparedAdmissionSha256) {
    value.dgxPreparedAdmissionSha256 = job.dgxPreparedAdmissionSha256;
  }
  return value;
}

function runtimeAuthorityRequestSha256(job: RuntimeJob): string | null {
  const digest = createHash("sha256").update(canonicalJson(job.authorityBoundRequest)).digest("hex");
  return digest === job.authorityRequestSha256 ? digest : null;
}

function archivedOutputAuthorityFromJob(job: RuntimeJob): ArchivedOutputAuthority | null {
  const decision = normalizeJobExecutionDecision(job.executionDecision);
  const requestSha256 = runtimeAuthorityRequestSha256(job);
  const publication = job.outputPublication
    ? normalizeOutputPublicationAuthority(job.outputPublication, join(outputRoot, job.outputName))
    : null;
  if (job.status !== "completed"
    || !job.finishedAt
    || !decision
    || !requestSha256
    || decision.executionClass === "pending"
    || decision.executionClass !== job.executionClass
    || decision.requestSha256 !== requestSha256
    || decision.protocolSha256 !== (job.experiment?.protocolSha256 ?? null)
    || !job.runProvenance
    || !runProvenanceFingerprintMatches(job.runProvenance)
    || canonicalJson(job.runProvenance.executionDecision) !== canonicalJson(decision)
    || !publication) return null;
  const executionDecisionSha256 = createHash("sha256").update(canonicalJson(decision)).digest("hex");
  if (publication.jobId !== job.id
    || publication.publishedAt !== job.finishedAt
    || publication.executionDecisionSha256 !== executionDecisionSha256
    || publication.jobAuthoritySha256 !== terminalJobAuthoritySha256({
      jobId: job.id,
      status: "completed",
      outputName: job.outputName,
      finishedAt: job.finishedAt,
      executionClass: decision.executionClass,
      executionDecisionSha256,
      requestSha256: decision.requestSha256,
      protocolSha256: decision.protocolSha256,
      jobPersistenceRevision: publication.jobPersistenceRevision,
    })) return null;
  const cpuOutputSha256 = decision.executionClass === "cpu-only"
    && decision.operation.state === "succeeded"
    && decision.operation.output?.sha256 === publication.output.sha256
    ? publication.output.sha256
    : null;
  if (decision.executionClass === "cpu-only" && cpuOutputSha256 === null) return null;
  return {
    schemaVersion: "ltx-studio-archived-output-authority.v1",
    id: job.id,
    status: "completed",
    outputName: job.outputName,
    finishedAt: job.finishedAt,
    executionClass: decision.executionClass,
    executionDecisionSha256,
    requestSha256: decision.requestSha256,
    protocolSha256: decision.protocolSha256,
    cpuOutputSha256,
    runProvenanceSha256: createHash("sha256").update(canonicalJson(job.runProvenance)).digest("hex"),
    identityEvidenceSha256: job.identityEvidence == null
      ? null
      : createHash("sha256").update(canonicalJson(job.identityEvidence)).digest("hex"),
    experimentSha256: job.experiment == null
      ? null
      : createHash("sha256").update(canonicalJson(job.experiment)).digest("hex"),
    projectSha256: job.project == null
      ? null
      : createHash("sha256").update(canonicalJson(job.project)).digest("hex"),
    outputPublication: publication,
  };
}

function normalizeArchivedOutputAuthority(value: unknown): ArchivedOutputAuthority | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).sort().join(",") !== [
    "cpuOutputSha256", "executionClass", "executionDecisionSha256", "finishedAt", "id",
    "identityEvidenceSha256", "experimentSha256", "outputName", "outputPublication", "projectSha256",
    "protocolSha256", "requestSha256", "runProvenanceSha256", "schemaVersion", "status",
  ].sort().join(",")
    || entry.schemaVersion !== "ltx-studio-archived-output-authority.v1"
    || entry.status !== "completed"
    || typeof entry.id !== "string"
    || !/^[0-9a-f-]{36}$/i.test(entry.id)
    || typeof entry.outputName !== "string"
    || typeof entry.finishedAt !== "string"
    || !Number.isFinite(Date.parse(entry.finishedAt))
    || (entry.executionClass !== "dgx" && entry.executionClass !== "cpu-only")
    || typeof entry.executionDecisionSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(entry.executionDecisionSha256)
    || typeof entry.requestSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(entry.requestSha256)
    || !(entry.protocolSha256 === null
      || (typeof entry.protocolSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.protocolSha256)))
    || !(entry.cpuOutputSha256 === null
      || (typeof entry.cpuOutputSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.cpuOutputSha256)))
    || typeof entry.runProvenanceSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(entry.runProvenanceSha256)
    || !(entry.identityEvidenceSha256 === null
      || (typeof entry.identityEvidenceSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.identityEvidenceSha256)))
    || !(entry.experimentSha256 === null
      || (typeof entry.experimentSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.experimentSha256)))
    || !(entry.projectSha256 === null
      || (typeof entry.projectSha256 === "string" && /^[0-9a-f]{64}$/.test(entry.projectSha256)))
    || (entry.executionClass === "dgx" && entry.cpuOutputSha256 !== null)
    || (entry.executionClass === "cpu-only" && typeof entry.cpuOutputSha256 !== "string")) return null;
  const outputPath = join(outputRoot, entry.outputName);
  const publication = normalizeOutputPublicationAuthority(entry.outputPublication, outputPath);
  if (!publication
    || publication.jobId !== entry.id
    || publication.publishedAt !== entry.finishedAt
    || publication.executionDecisionSha256 !== entry.executionDecisionSha256
    || publication.jobAuthoritySha256 !== terminalJobAuthoritySha256({
      jobId: entry.id,
      status: "completed",
      outputName: entry.outputName,
      finishedAt: entry.finishedAt,
      executionClass: entry.executionClass,
      executionDecisionSha256: entry.executionDecisionSha256,
      requestSha256: entry.requestSha256,
      protocolSha256: entry.protocolSha256,
      jobPersistenceRevision: publication.jobPersistenceRevision,
    })
    || (entry.executionClass === "cpu-only" && entry.cpuOutputSha256 !== publication.output.sha256)) return null;
  return { ...entry, outputPublication: publication } as ArchivedOutputAuthority;
}

function parseOutputAuthorityArchive(value: unknown): ArchivedOutputAuthority[] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const archive = value as Partial<PersistedOutputAuthorityArchive>;
  if (Object.keys(archive).sort().join(",") !== "entries,schemaVersion"
    || archive.schemaVersion !== "ltx-studio-output-authority-archive.v1"
    || !Array.isArray(archive.entries)) return null;
  const entries = archive.entries.map(normalizeArchivedOutputAuthority);
  if (entries.some((entry) => entry === null)) return null;
  const normalized = entries as ArchivedOutputAuthority[];
  const identities = new Set<string>();
  const outputNames = new Set<string>();
  for (const entry of normalized) {
    if (identities.has(entry.id) || outputNames.has(entry.outputName)) return null;
    identities.add(entry.id);
    outputNames.add(entry.outputName);
  }
  return normalized;
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

function historicalThermalResumeBelowC(baselineC: number, pauseAtC: number): number {
  return Math.min(baselineC + 0.1, pauseAtC - 0.1);
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
      resumeBelowC: historicalThermalResumeBelowC(baselineC, thermalPauseC),
      updatedAt: now(),
    };
  }
  return null;
}

export class JobManager extends EventEmitter {
  private readonly storagePath: string;
  private readonly outputAuthorityArchivePath: string;
  private readonly recovery: NonNullable<JobManagerStorage["recovery"]> | null;
  private readonly jobs = new Map<string, RuntimeJob>();
  private readonly outputAuthorityArchive = new Map<string, ArchivedOutputAuthority>();
  private outputAuthorityArchiveNeedsRewrite = false;
  private readonly queue: string[] = [];
  private runningId: string | null = null;
  private activeRunPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private persistenceHold: JobPersistenceHoldError | null = null;
  private readonly persistenceHoldAbortController = new AbortController();
  private readonly persistenceHoldSafetyStops = new Map<string, Promise<void>>();
  private readonly earlyProcessErrors = new WeakMap<ChildProcess, Error>();
  private jobPersistenceFileOperations: AtomicSnapshotFileOperations =
    DEFAULT_ATOMIC_SNAPSHOT_FILE_OPERATIONS;
  private outputAuthorityReconciliationOperations: OutputAuthorityReconciliationOperations =
    DEFAULT_OUTPUT_AUTHORITY_RECONCILIATION_OPERATIONS;
  private shutdownPromise: Promise<{
    queuedPreserved: number;
    localGroupsStopped: number;
    localPending: number;
    remoteConfirmed: number;
    remotePending: number;
  }> | null = null;

  private reusableBaseSource: ReusableLtxBaseSource | null = null;
  private createLocalProcessResourceTelemetry = (options: {
    identity: LocalProcessResourceIdentity;
    evidenceDirectory: string;
  }): LocalProcessResourceTelemetryRecorder => new LocalProcessResourceTelemetryRecorder(options);
  private ownedDockerOperations: OwnedDockerOperations = {
    run: (args) => {
      const result = spawnSync(hostTcbExecutables.docker, [...args], {
        encoding: "utf8",
        env: HOST_TCB_DOCKER_ENV,
        shell: false,
        timeout: 30_000,
      });
      return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        error: result.error ?? null,
      };
    },
  };

  constructor(
    storage: string | JobManagerStorage = statePath,
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
      submit: submitPreparedQueueAdmission,
      replay: replayPreparedQueueAdmission,
      list: listQueueJobs,
      successor: submitConditionalQueueSuccessor,
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
    private readonly startEnforcer: JobStartEnforcer = configuredJobStartEnforcer(),
    private readonly runtimeTrustRevalidation: () => void = () => {
      if (sealedRelease) revalidateSealedRuntimeTrustIdentity();
    },
    private readonly nativeRuntimeSourceProbeOperations?: NativeRuntimeSourceProbeOperations,
  ) {
    super();
    this.storagePath = typeof storage === "string" ? storage : storage.path;
    this.outputAuthorityArchivePath = `${this.storagePath}.output-authority.v1.json`;
    this.recovery = typeof storage === "string" ? null : storage.recovery ?? null;
    if (typeof storage !== "string" && storage.fileOperations) {
      this.jobPersistenceFileOperations = storage.fileOperations;
    }
    if (typeof storage !== "string" && storage.outputAuthorityReconciliationOperations) {
      this.outputAuthorityReconciliationOperations = {
        ...DEFAULT_OUTPUT_AUTHORITY_RECONCILIATION_OPERATIONS,
        ...storage.outputAuthorityReconciliationOperations,
      };
    }
    try {
      if (this.recovery) {
        this.recovery.coordinator.recover();
        this.recovery.coordinator.verifyCommittedTargets();
      }
      if (existsSync(this.storagePath)) this.sealExistingJobSnapshotForStartup();
    } catch (error) {
      this.enterPersistenceHold(
        error,
        `Startup-Durability des Job-Snapshots ${this.storagePath} konnte nicht bestätigt werden`,
      );
    }
    if (!this.persistenceHold) this.restore();
    for (const job of this.jobs.values()) {
      this.scheduleLocalProcessGroupReconciliation(job, 0);
      this.scheduleOwnedDockerContainerReconciliation(job, 0);
      this.scheduleDgxTerminalRetry(job, 0);
      this.scheduleTerminalPendingDgxSubmitReconciliation(job, 0);
    }
    if (this.autoStart && this.queue.length > 0) {
      queueMicrotask(() => this.runDetached(this.pump(), "initialer Queue-Pump"));
    }
  }

  // The output library lives beside the manager in index.ts; wiring it after
  // construction avoids threading a tenth positional constructor default.
  wireReusableBaseSource(source: ReusableLtxBaseSource): void {
    this.reusableBaseSource = source;
  }

  list(): StudioJob[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((job) => this.publicJob(job));
  }

  /**
   * Route-level preflight for operations that would persist state derived
   * from an output. Legacy history grants byte playback only; it must never
   * become an implicit authority for reviews, analyses or derived assets.
   */
  assertOutputMutationAllowed(outputName: string): void {
    this.assertPersistenceAvailable("Änderung einer Ausgabe");
    if ([...this.jobs.values()].some((job) =>
      job.outputName === outputName && job.legacyHistory !== undefined)) {
      throw new JobConflictError(LEGACY_OUTPUT_READ_ONLY_MESSAGE);
    }
  }

  assertOutputDeletionAllowed(outputName: string): void {
    this.assertOutputMutationAllowed(outputName);
    const protectedArm = [...this.jobs.values()].find((job) =>
      job.outputName === outputName
      && job.experiment?.variableId === "positive-prompt"
      && validPositivePromptExperimentArmBinding(job.request, job.experiment) !== null);
    if (protectedArm) {
      throw new JobConflictError(
        "Die Ausgabe ist Teil eines hashgebundenen Prompt-A/B-Experiments und bleibt als Vergleichsevidenz geschützt.",
      );
    }
  }

  /** Reject missing or legacy jobs before a bound route can grant new authority. */
  assertJobMutationAllowed(id: string): void {
    const job = this.jobs.get(id);
    if (!job) {
      throw new JobConflictError(
        "Der gebundene Job ist nicht mehr mit einer aktuellen modernen Jobautorität belegt.",
      );
    }
    if (job.legacyHistory) throw new JobConflictError(LEGACY_JOB_READ_ONLY_MESSAGE);
  }

  /**
   * Project outputHistory may outlive the bounded interactive job list. It may
   * authorize a new continuity/retake operation only while either the current
   * modern publication or its immutable modern archive entry still exists.
   */
  assertHistoricalOutputReferenceMutationAllowed(jobId: string, outputName: string): void {
    this.assertPersistenceAvailable("Verwendung einer historischen Projektausgabe");
    const job = this.jobs.get(jobId);
    if (job?.legacyHistory) throw new JobConflictError(LEGACY_OUTPUT_READ_ONLY_MESSAGE);
    const archived = this.outputAuthorityArchive.get(jobId);
    const publication = readValidOutputPublicationAuthority(outputRoot, outputName);
    if (archived?.outputName === outputName
      && publication
      && canonicalJson(publication) === canonicalJson(archived.outputPublication)) return;
    throw new JobConflictError(
      "Die gebundene Projektausgabe besitzt keine aktuell sichtbare, archivierte moderne Publikationsautorität.",
    );
  }

  private publicJob(job: RuntimeJob): StudioJob {
    return publicJob(job, this.persistenceHold !== null, this.jobSettlementPending(job));
  }

  /** Internal-only current job authorities; never serialize this through an API route. */
  outputAuthorityList(): OutputAuthorityJob[] {
    this.assertPersistenceAvailable("Lesen einer Output-Publikationsautorität");
    const current = [...this.jobs.values()].map((job) => ({
        ...publicJob(job),
        authorityBoundRequest: structuredClone(job.authorityBoundRequest),
        authorityRequestSha256: job.authorityRequestSha256,
        legacyHistory: job.legacyHistory ? structuredClone(job.legacyHistory) : undefined,
        outputPublicationCommitPending: job.outputPublicationCommitPending
          ? structuredClone(job.outputPublicationCommitPending)
          : undefined,
        outputPublication: job.outputPublication
          ? structuredClone(job.outputPublication)
          : undefined,
      }));
    const currentIds = new Set(current.map(({ id }) => id));
    const archived = [...this.outputAuthorityArchive.values()]
      .filter(({ id }) => !currentIds.has(id))
      .map((entry) => structuredClone(entry));
    return [...current, ...archived]
      .sort((left, right) => {
        const leftAt = "createdAt" in left ? left.createdAt : left.finishedAt;
        const rightAt = "createdAt" in right ? right.createdAt : right.finishedAt;
        return rightAt.localeCompare(leftAt);
      });
  }

  revokeOutputAuthority(outputName: string, expectedJobId: string): void {
    this.assertPersistenceAvailable("Widerruf einer Output-Autorität");
    const archived = this.outputAuthorityArchive.get(expectedJobId);
    if (!archived || archived.outputName !== outputName) {
      throw new Error("Dauerhafte Output-Autorität fehlt oder gehört zu einem anderen Job.");
    }
    const archiveSnapshot = new Map(this.outputAuthorityArchive);
    this.outputAuthorityArchive.delete(expectedJobId);
    try {
      this.persistOutputAuthorityArchive();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        this.outputAuthorityArchive.clear();
        for (const [jobId, entry] of archiveSnapshot) {
          this.outputAuthorityArchive.set(jobId, entry);
        }
      }
      throw error;
    }
  }

  get(id: string): StudioJob | undefined {
    const job = this.jobs.get(id);
    return job ? this.publicJob(job) : undefined;
  }

  /**
   * Internal-only settlement authority for experiment retries.
   *
   * A terminal public status is intentionally insufficient: cancellation is
   * visible immediately while the local process group, an ambiguous queue
   * submit, or the authoritative DGX terminal transition may still be in
   * flight.  Never serialize these implementation details through an API.
   */
  experimentRetryAuthority(id: string): {
    status: string;
    dgxJobId: string | null;
    settlementPending: boolean;
  } | undefined {
    const job = this.jobs.get(id);
    if (!job) {
      throw new JobConflictError(
        "Der gebundene Experimentjob ist nicht mehr mit einer aktuellen modernen Jobautorität belegt.",
      );
    }
    // Retry is a new execution, not a read-only inspection. Returning the
    // terminal state here would let an imported v1 history entry bypass the
    // explicit rerun lock through the controlled-experiment API.
    if (job.legacyHistory) throw new JobConflictError(LEGACY_JOB_READ_ONLY_MESSAGE);
    return {
      status: job.status,
      dgxJobId: job.dgxJobId,
      settlementPending: this.jobSettlementPending(job),
    };
  }

  private jobSettlementPending(job: RuntimeJob): boolean {
    return this.runningId === job.id || runtimeSettlementPending(job);
  }

  private assertPersistenceAvailable(boundary: string): void {
    if (!this.persistenceHold) return;
    throw new JobPersistenceHoldError(
      `LTX Studio bleibt wegen unbestätigter Snapshot-Durability im HOLD; ${boundary} ist gesperrt. `
        + PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
      this.persistenceHold,
    );
  }

  private enterPersistenceHold(
    error: unknown,
    details: string,
  ): JobPersistenceHoldError {
    if (!this.persistenceHold) {
      const diagnostic = `Persistenz-HOLD: ${details}. Ursache: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.persistenceHold = new JobPersistenceHoldError(
        diagnostic,
        error,
      );
      this.persistenceHoldAbortController.abort();
      process.stderr.write(`${diagnostic}\n`);
      // A post-rename durability failure can happen after intended job bytes
      // became visible but before changed() reached its normal SSE emission.
      // Publish the manager-wide HOLD overlay exactly once, without another
      // write, so an open GUI immediately renders `settling`/restart-required.
      this.emitChangedSnapshot();
      queueMicrotask(() => {
        for (const job of this.jobs.values()) {
          const admission = job.dgxAdmissionAbortController;
          if (admission && !admission.signal.aborted) admission.abort();
          this.runDetached(
            this.safetyStopAfterPersistenceHold(job),
            `Persistenz-HOLD-Sicherheitsstopp ${job.id}`,
          );
        }
      });
    }
    return this.persistenceHold;
  }

  private safetyStopAfterPersistenceHold(job: RuntimeJob): Promise<void> {
    const existing = this.persistenceHoldSafetyStops.get(job.id);
    if (existing) return existing;
    const safetyStop = (async () => {
      const child = job.process;
      const identity = job.localProcessGroupIdentity;
      let processGroupId: number | null = null;
      if (child?.pid && processIsAlive(child)) {
        processGroupId = child.pid;
      } else if (identity && !localProcessGroupIsGone(identity)) {
        // The group leader can exit while descendants retain its PGID. The
        // persisted boot/start-tick identity plus the /proc PGID scan proves
        // that this is still our old isolated group; child.exitCode alone is
        // therefore never an absence proof.
        processGroupId = identity.processGroupId;
      }
      if (processGroupId !== null && processGroupExists(processGroupId)) {
        try {
          // Do not clear the process identity marker in HOLD.  We prove/force
          // local quiescence, while restart recovery remains the only authority
          // allowed to settle the persisted marker and remote lease.
          await terminateExactProcessGroup(
            processGroupId,
            job.status === "paused",
            10_000,
            15_000,
            child?.pid === processGroupId ? child : undefined,
          );
        } catch (error) {
          this.recordCleanupDiagnostic(
            job,
            `Persistenz-HOLD: gebundene Prozessgruppe konnte nicht sicher gestoppt werden: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (job.ownedDockerContainer?.containerId
        && job.ownedDockerContainerIdDurablyCommitted) {
        await this.cleanupOwnedDockerContainer(job).catch(() => false);
      }
    })().finally(() => {
      this.persistenceHoldSafetyStops.delete(job.id);
    });
    this.persistenceHoldSafetyStops.set(job.id, safetyStop);
    return safetyStop;
  }

  /**
   * Timer, EventEmitter and queueMicrotask callbacks have no awaiting caller.
   * Observe every detached promise here so a persistence HOLD (or a secondary
   * cleanup failure) can never surface as an unhandled rejection and crash the
   * server before the fail-stop safety sequence has finished.
   */
  private runDetached(promise: Promise<unknown>, context: string): void {
    void promise.catch((error) => {
      try {
        process.stderr.write(
          `LTX Studio asynchroner Ablauf ${context} wurde fail-closed beendet: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      } catch {
        // Diagnostics must never undermine the fail-stop boundary.
      }
    });
  }

  private persistenceTargetDigest(path = this.storagePath): string | null {
    try {
      return createHash("sha256")
        .update(this.jobPersistenceFileOperations.read(path))
        .digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private sealExistingJobSnapshotForStartup(): void {
    const before = this.jobPersistenceFileOperations.read(this.storagePath);
    const descriptor = this.jobPersistenceFileOperations.open(this.storagePath, "r");
    try {
      this.jobPersistenceFileOperations.fsync(descriptor);
    } finally {
      this.jobPersistenceFileOperations.close(descriptor);
    }
    fsyncSnapshotDirectory(this.storagePath, this.jobPersistenceFileOperations);
    const after = this.jobPersistenceFileOperations.read(this.storagePath);
    if (!before.equals(after)) {
      throw new Error("Job-Snapshot änderte sich während des Startup-Durability-Beweises.");
    }
  }

  private commitManagedSnapshot(options: {
    path: string;
    value: unknown;
    recoveryRelativePath: string | null;
  }): void {
    this.assertPersistenceAvailable("jede weitere Snapshot-Mutation");
    const useRecovery = this.recovery && options.recoveryRelativePath !== null;
    const intendedContents = useRecovery
      ? canonicalJson(options.value)
      : `${JSON.stringify(options.value, null, 2)}\n`;
    const intendedDigest = createHash("sha256").update(intendedContents).digest("hex");
    let beforeDigest: string | null;
    try {
      beforeDigest = this.persistenceTargetDigest(options.path);
    } catch (error) {
      throw this.enterPersistenceHold(error, "der vorherige Snapshot konnte nicht beweiskräftig gelesen werden");
    }

    try {
      if (useRecovery) {
        this.recovery.coordinator.commitJson({
          targetKind: "job",
          targetRelativePath: options.recoveryRelativePath!,
          expectedAbsolutePath: options.path,
          value: options.value,
        });
      } else {
        atomicTextFile(
          options.path,
          intendedContents,
          this.jobPersistenceFileOperations,
        );
      }
      return;
    } catch (commitError) {
      // commitJson may have stopped after its prepared record or after writing
      // the target.  Recovery is part of the same commit attempt and must make
      // both journal and target authoritative before callers may continue.
      if (useRecovery) {
        try {
          this.recovery.coordinator.recover();
          this.recovery.coordinator.verifyCommittedTargets();
          const recoveredDigest = this.persistenceTargetDigest(options.path);
          if (recoveredDigest === intendedDigest) return;
          if (recoveredDigest === beforeDigest) throw commitError;
        } catch (recoveryError) {
          if (recoveryError === commitError) throw commitError;
          throw this.enterPersistenceHold(
            recoveryError,
            `Recovery des unklaren Job-Snapshot-Commits ist fehlgeschlagen (before=${beforeDigest ?? "missing"}, intended=${intendedDigest})`,
          );
        }
        throw this.enterPersistenceHold(
          commitError,
          `Recovery bestätigte nicht den beabsichtigten Job-Snapshot (before=${beforeDigest ?? "missing"}, intended=${intendedDigest})`,
        );
      }

      let observedDigest: string | null;
      try {
        observedDigest = this.persistenceTargetDigest(options.path);
      } catch (readError) {
        throw this.enterPersistenceHold(
          readError,
          `Read-back nach unklarem Snapshot-Commit scheiterte (before=${beforeDigest ?? "missing"}, intended=${intendedDigest})`,
        );
      }
      if (observedDigest === intendedDigest) {
        try {
          // A rename followed by an open/fsync/close failure is recovered only
          // through a newly opened directory FD.  Successful re-fsync turns
          // the ambiguous attempt into a committed receipt for every caller.
          fsyncSnapshotDirectory(options.path, this.jobPersistenceFileOperations);
          return;
        } catch (fsyncError) {
          throw this.enterPersistenceHold(
            fsyncError,
            `der beabsichtigte Snapshot ist sichtbar, seine Directory-Durability bleibt aber unbestätigt (intended=${intendedDigest})`,
          );
        }
      }
      const failedBeforeTargetReplacement = commitError instanceof AtomicSnapshotWriteError
        && [
          "directory-create",
          "temporary-open",
          "temporary-write",
          "temporary-fsync",
          "temporary-close",
          "target-rename",
        ].includes(commitError.phase);
      if (failedBeforeTargetReplacement && observedDigest === beforeDigest) {
        // The target is byte-for-byte the snapshot observed before the attempt,
        // and the writer did not pass rename.  This is the only outcome that
        // authorizes caller compensation/retry rather than a sticky HOLD.
        throw commitError;
      }
      throw this.enterPersistenceHold(
        commitError,
        `Snapshot-Ausgang ist nicht eindeutig committed (before=${beforeDigest ?? "missing"}, intended=${intendedDigest}, observed=${observedDigest ?? "missing"})`,
      );
    }
  }

  private commitJobSnapshot(values: PersistedStudioJob[]): void {
    this.commitManagedSnapshot({
      path: this.storagePath,
      value: values,
      recoveryRelativePath: this.recovery?.targetRelativePath ?? null,
    });
  }

  private clearCancellationSettlementTransient(job: RuntimeJob, clear: () => void): void {
    const wasPending = job.cancelledBy === "studio" && this.jobSettlementPending(job);
    clear();
    if (!wasPending || this.jobSettlementPending(job)) return;
    // Runtime promises/timers are deliberately absent from persistedJob().
    // This durable write + event exists only so an already-open GUI receives
    // the final computed `settled` state without requiring a reload.
    try {
      this.changed();
    } catch (error) {
      process.stderr.write(
        `LTX Studio konnte den finalen Cancellation-Settlement-Event nicht persistieren: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
      // These cleared promises/timers are intentionally runtime-only and are
      // never part of persistedJob().  Even when an unrelated durable write is
      // unavailable, the live GUI must receive exactly one final computed
      // `settled` snapshot instead of remaining permanently on `settling`.
      this.emitChangedSnapshot();
    }
  }

  private recordCleanupDiagnostic(job: RuntimeJob, message: string): void {
    this.appendLog(job, message);
    if (this.persistenceHold) {
      // Cleanup is authorized only through a previously durable immutable ID.
      // HOLD deliberately forbids another write, but a diagnostic must not
      // interrupt the exact-ID stop/rm safety path.
      this.emitChangedSnapshot();
      return;
    }
    this.changed();
  }

  inspectRawMuxPairCandidateAuthority(
    request: GenerationRequest,
    binding: ExperimentRunBinding,
  ): { description: string } | { error: string } {
    const proof = this.rawOutputPairAuthority({
      request,
      experiment: binding,
      runProvenance: null,
      identityEvidence: null,
    });
    if (proof.error || !proof.authority || !proof.authorityBinding) {
      return { error: proof.error ?? "Die private Raw-Mux-Paarautorität ist nicht vollständig verifizierbar." };
    }
    return {
      description: `Baseline ${proof.authority.baselineOutputName} bindet den privaten Kandidatenarm, beide Receipts und die identische Host-Timeline.`,
    };
  }

  activationStatus() {
    return this.startEnforcer.inspect();
  }

  persistenceHealth(): PublicJobPersistenceHealth {
    return this.persistenceHold
      ? publicJobPersistenceHoldHealth()
      : { status: "ok", restartRequired: false };
  }

  create(
    request: GenerationRequest,
    metadata: JobCreateMetadata = {},
  ): StudioJob {
    this.assertPersistenceAvailable("Annahme eines neuen Jobs");
    if (metadata.experiment && metadata.project) {
      throw new JobConflictError("Ein Job darf nicht gleichzeitig Experiment- und Projektlauf sein.");
    }
    const experimentBinding = metadata.experiment
      ? experimentRunBindingSchema.parse(metadata.experiment)
      : null;
    const startSource = this.startSource({ ...metadata, experiment: experimentBinding });
    // Frozen experiment and revision-bound project requests are authoritative.
    // Normal jobs are still canonicalized here; bound requests were canonicalized
    // before persistence and must retain their exact digest.
    request = experimentBinding || metadata.project
      ? structuredClone(request)
      : withOfficialSpeechModelPaths(request);
    const outputTimingVariable = boundProgramAudioDelayVariable({
      request,
      experiment: experimentBinding,
    });
    if (request.audio.outputDelayMs !== 0
      && outputTimingVariable !== "program-audio-delay-ms") {
      throw new JobConflictError(
        "Ein Ausgabetonversatz ungleich 0 ms ist ausschließlich als exakt gebundener "
        + "Kandidatenarm eines eingefrorenen Audio-only-Experiments ausführbar.",
      );
    }
    const authorityBoundRequest = structuredClone(request);
    const requestSha256 = createHash("sha256").update(canonicalJson(authorityBoundRequest)).digest("hex");
    if (experimentBinding
      && experimentBinding.requestSha256 !== experimentRequestSha256V1(authorityBoundRequest)) {
      throw new JobConflictError("Experimentlauf stimmt nicht mit seiner gebundenen Request-Revision überein.");
    }
    if (
      metadata.project
      && requestSha256 !== metadata.project.requestSha256
    ) {
      throw new JobConflictError("Projektlauf stimmt nicht mit seiner gebundenen Request-Revision überein.");
    }
    this.assertStartAllowed(request, startSource, requestSha256, experimentBinding);
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
    const outputPath = join(outputRoot, request.outputName);
    const completedJobOwnsName = [...this.jobs.values()].some(
      (job) => job.status === "completed" && job.outputName === request.outputName,
    );
    const archivedJobOwnsName = [...this.outputAuthorityArchive.values()].some(
      (entry) => entry.outputName === request.outputName,
    );
    if (completedJobOwnsName
      || archivedJobOwnsName
      || existsSync(outputPath)
      || existsSync(outputPublicationPath(outputPath))) {
      throw new JobConflictError(
        `Die Ausgabedatei ${request.outputName} ist bereits publiziert oder durch eine dauerhafte Output-Autorität belegt.`,
      );
    }
    const id = randomUUID();
    const createdAt = now();
    const pendingDecision: JobExecutionDecision = {
      schemaVersion: "ltx-studio-execution-decision.v6",
      executionClass: "pending",
      decidedAt: createdAt,
      reason: "Auftrag dauerhaft angenommen; Ausführungsklasse wird vor dem ersten Prozess-/DGX-Start festgelegt.",
      requestSha256,
      protocolSha256: experimentBinding?.protocolSha256 ?? null,
      cpuReuse: null,
      operation: null,
    };
    const job: RuntimeJob = {
      id,
      status: "queued",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      logs: [],
      command: plan.displayCommand,
      request,
      favorite: false,
      variantOf: metadata.variantOf ?? null,
      experiment: experimentBinding,
      project: metadata.project ? projectRunBindingSchema.parse(metadata.project) : null,
      runtimeMs: null,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: null,
      dgxMemoryWait: null,
      identityEvidence: null,
      runProvenance: null,
      executionClass: "pending",
      executionDecision: pendingDecision,
      localProcessProtocol: "fd-gate.v1",
      startSource,
      startDeferred: metadata.deferStart === true,
      plan,
      authorityBoundRequest,
      authorityRequestSha256: requestSha256,
      legacyTextToAudioPeakCeilingUnset: false,
    };
    const jobsSnapshot = new Map(this.jobs);
    const queueSnapshot = [...this.queue];
    this.jobs.set(id, job);
    this.queue.push(id);
    this.trimHistory();
    try {
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        this.jobs.clear();
        for (const [snapshotId, snapshotJob] of jobsSnapshot) {
          this.jobs.set(snapshotId, snapshotJob);
        }
        this.queue.splice(0, this.queue.length, ...queueSnapshot);
      }
      throw error;
    }
    if (this.autoStart && !metadata.deferStart) {
      this.runDetached(this.pump(), `Queue-Pump nach Jobanlage ${job.id}`);
    }
    return this.publicJob(job);
  }

  startQueued(id: string): StudioJob | undefined {
    this.assertPersistenceAvailable("Start eines vorbereiteten Jobs");
    if (this.shuttingDown) return undefined;
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued" || !this.queue.includes(id)) return undefined;
    if (job.startDeferred) {
      // Persist the arm only after the caller completed its external CAS. If
      // this write fails, the in-memory fence is restored and no pump occurs.
      job.startDeferred = false;
      try {
        this.changed();
      } catch (error) {
        if (!isJobPersistenceHoldError(error)) job.startDeferred = true;
        throw error;
      }
    }
    if (this.autoStart) this.runDetached(this.pump(), `Queue-Pump nach Freigabe ${job.id}`);
    return this.publicJob(job);
  }

  /**
   * Terminalizes a prepared-but-never-armed transaction without pretending it
   * was a user cancellation. The private durable fence is deliberately kept:
   * after any later restart it proves that the job never became executable.
   */
  interruptDeferredStart(id: string, reason: string): StudioJob | undefined {
    this.assertPersistenceAvailable("Terminalisierung eines vorbereiteten Jobs");
    const job = this.jobs.get(id);
    if (!job
      || job.status !== "queued"
      || !job.startDeferred
      || job.startedAt !== null
      || job.dgxJobId !== null
      || this.jobSettlementPending(job)) {
      return undefined;
    }
    const queueIndex = this.queue.indexOf(id);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    job.status = "interrupted";
    job.finishedAt = now();
    job.error = reason;
    this.appendLog(job, reason);
    this.changed();
    return this.publicJob(job);
  }

  rerun(id: string, mode: VariantMode): StudioJob | undefined {
    const source = this.jobs.get(id);
    if (!source || isActiveJobStatus(source.status) || this.jobSettlementPending(source)) return undefined;
    if (source.legacyHistory) {
      throw new JobConflictError(
        "Historischer Altbestand ist ausdrücklich nur lesbar und besitzt keine moderne "
        + "Ausführungsautorität. Einstellungen bei Bedarf manuell als neuen Auftrag erfassen.",
      );
    }
    if (source.legacyTextToAudioPeakCeilingUnset) {
      throw new JobConflictError(
        "Dieser historische Text-zu-Audio-Job hat keine gebundene Peak-Grenze und kann deshalb nicht "
        + "semantisch exakt wiederholt werden. Bitte Einstellungen übernehmen und einen neuen, sichtbar "
        + "auf -3 dBFS begrenzten Auftrag erstellen.",
      );
    }
    const unavailable = (name: string) =>
      [...this.jobs.values()].some((job) => job.outputName === name) || existsSync(join(outputRoot, name));
    const request = withOfficialSpeechModelPaths(structuredClone(source.request));
    request.outputName = nextVariantOutputName(source.outputName, unavailable);
    if (mode === "random-seed") request.seed = randomInt(0, 2_147_483_647);
    return this.create(request, { variantOf: source.variantOf ?? source.id });
  }

  setFavorite(id: string, favorite: boolean): StudioJob | undefined {
    this.assertPersistenceAvailable("Änderung eines Jobs");
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.legacyHistory) throw new JobConflictError(LEGACY_JOB_READ_ONLY_MESSAGE);
    job.favorite = favorite;
    this.changed();
    return this.publicJob(job);
  }

  remove(id: string): StudioJob | undefined {
    this.assertPersistenceAvailable("Entfernen eines Jobs");
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.legacyHistory) {
      throw new JobConflictError(
        "Historischer Altbestand bleibt mit seinem schreibgeschützten Mediennachweis verbunden und kann hier nicht entfernt werden.",
      );
    }
    if (isActiveJobStatus(job.status) || this.jobSettlementPending(job)) {
      throw new JobConflictError(
        "Der Job ist noch aktiv oder seine DGX-Abschlussmeldung ist noch nicht bestätigt.",
      );
    }
    if (job.experiment?.variableId === "positive-prompt"
      && validPositivePromptExperimentArmBinding(job.request, job.experiment)) {
      throw new JobConflictError(
        "Der Job ist Teil eines hashgebundenen Prompt-A/B-Experiments und bleibt als Vergleichsevidenz geschützt.",
      );
    }
    return this.removeTerminalJob(id, job);
  }

  /**
   * Roll back only a never-armed experiment prepare whose external attach CAS
   * was proven absent. This is deliberately separate from the public history
   * deletion path so a bound prompt arm can never use the cleanup exception.
   */
  removeDetachedDeferredExperimentJob(id: string): StudioJob | undefined {
    this.assertPersistenceAvailable("Rollback eines nicht gebundenen Experimentjobs");
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (!job.experiment
      || !job.startDeferred
      || job.status !== "cancelled"
      || job.startedAt !== null
      || job.dgxJobId !== null
      || job.executionClass !== "pending"
      || job.identityEvidence !== null
      || job.runProvenance !== null
      || job.outputPublication !== undefined
      || this.jobSettlementPending(job)
      || this.fileReady(job.plan.outputPath)) {
      throw new JobConflictError(
        "Nur ein nachweislich nie gestarteter, nicht publizierter und weiterhin startgesperrter "
        + "Experiment-Prepare darf nach fehlgeschlagener Armbindung entfernt werden.",
      );
    }
    return this.removeTerminalJob(id, job);
  }

  private removeTerminalJob(id: string, job: RuntimeJob): StudioJob {
    this.jobs.delete(id);
    try {
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) this.jobs.set(id, job);
      throw error;
    }
    return this.publicJob(job);
  }

  private commitStudioCancellationIntent(job: RuntimeJob, beforeLocalStart: boolean): void {
    const queueSnapshot = [...this.queue];
    const snapshot = {
      status: job.status,
      cancelledBy: job.cancelledBy,
      finishedAt: job.finishedAt,
      runtimeMs: job.runtimeMs,
      logs: [...job.logs],
      dgxMemoryWait: job.dgxMemoryWait ? structuredClone(job.dgxMemoryWait) : null,
      dgxTerminalDelivery: job.dgxTerminalDelivery
        ? structuredClone(job.dgxTerminalDelivery)
        : undefined,
      ownedDockerContainer: job.ownedDockerContainer
        ? structuredClone(job.ownedDockerContainer)
        : undefined,
    };
    try {
      if (job.status === "queued") {
        const index = this.queue.indexOf(job.id);
        if (index >= 0) this.queue.splice(index, 1);
      }
      this.prepareDgxTerminalDelivery(job, "cancelled", {
        current_step: beforeLocalStart
          ? "cancelled by LTX Studio before local start"
          : "cancelled by LTX Studio",
        last_error: "manual Studio cancellation",
      });
      job.status = "cancelled";
      job.cancelledBy = "studio";
      job.finishedAt = now();
      job.dgxMemoryWait = null;
      if (job.startedAt) job.runtimeMs = Date.now() - Date.parse(job.startedAt);
      if (job.ownedDockerContainer) job.ownedDockerContainer.state = "cleanup";
      this.appendLog(
        job,
        beforeLocalStart
          ? "Manueller Abbruch über die Studio-Abbruchfunktion vor dem Start angefordert."
          : "Manueller Abbruch über die Studio-Abbruchfunktion angefordert.",
      );
      // No abort, signal, Docker action, or DGX transition may happen before
      // this durable cancellation intent commits.
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        this.queue.splice(0, this.queue.length, ...queueSnapshot);
        job.status = snapshot.status;
        job.cancelledBy = snapshot.cancelledBy;
        job.finishedAt = snapshot.finishedAt;
        job.runtimeMs = snapshot.runtimeMs;
        job.logs = snapshot.logs;
        job.dgxMemoryWait = snapshot.dgxMemoryWait;
        if (snapshot.dgxTerminalDelivery) {
          job.dgxTerminalDelivery = snapshot.dgxTerminalDelivery;
        } else {
          delete job.dgxTerminalDelivery;
        }
        if (snapshot.ownedDockerContainer) {
          job.ownedDockerContainer = snapshot.ownedDockerContainer;
        } else {
          delete job.ownedDockerContainer;
        }
      }
      throw error;
    }
  }

  cancel(id: string): StudioJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (job.legacyHistory) throw new JobConflictError(LEGACY_JOB_READ_ONLY_MESSAGE);
    if (["queued", "running", "paused"].includes(job.status)) {
      this.assertPersistenceAvailable("neuer Cancellation-Intent");
    }
    if (job.status === "queued") {
      const process = job.process;
      const admission = job.dgxAdmissionAbortController;
      this.commitStudioCancellationIntent(job, true);
      // The cancellation intent is durable now. Abort the current in-flight
      // submit or receipt-bound replay so cancellation never waits on a hung
      // HTTP response. Pending-first-submit reconciliation remains read-only;
      // no POST is issued after terminal intent.
      admission?.abort();
      if (job.dgxAdmissionAbortController === admission) {
        delete job.dgxAdmissionAbortController;
      }
      if (job.dgxSubmitPending) {
        this.scheduleTerminalPendingDgxSubmitReconciliation(job, 0);
      }
      if (process?.pid) {
        this.runDetached(
          this.stopProcessBeforeTerminalDelivery(job, process, false),
          `Cancellation-Prozessstopp ${job.id}`,
        );
      }
      if (job.ownedDockerContainer) {
        this.scheduleOwnedDockerContainerReconciliation(job, 0);
      } else if (!process?.pid) {
        this.runDetached(this.flushDgxTerminalDelivery(job), `Cancellation-DGX-Zustellung ${job.id}`);
      }
      return this.publicJob(job);
    }
    if (["running", "paused"].includes(job.status)) {
      const wasPaused = job.status === "paused";
      const process = job.process;
      const admission = job.dgxAdmissionAbortController;
      this.commitStudioCancellationIntent(job, false);
      admission?.abort();
      if (job.dgxAdmissionAbortController === admission) {
        delete job.dgxAdmissionAbortController;
      }
      if (job.dgxSubmitPending) {
        this.scheduleTerminalPendingDgxSubmitReconciliation(job, 0);
      }
      if (process?.pid) {
        this.runDetached(
          this.stopProcessBeforeTerminalDelivery(job, process, wasPaused),
          `Cancellation-Prozessstopp ${job.id}`,
        );
      }
      if (job.ownedDockerContainer) {
        this.scheduleOwnedDockerContainerReconciliation(job, 0);
      } else if (!process?.pid) {
        this.runDetached(this.flushDgxTerminalDelivery(job), `Cancellation-DGX-Zustellung ${job.id}`);
      }
    }
    return this.publicJob(job);
  }

  async reconcileRestoredRemoteAuthority(timeoutMs = 140_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (const job of this.jobs.values()) {
      while (
        job.dgxSubmitPending
        && !isActiveJobStatus(job.status)
        && !this.shuttingDown
        && Date.now() < deadline
      ) {
        if (job.dgxSubmitReconcileRetry) clearTimeout(job.dgxSubmitReconcileRetry);
        delete job.dgxSubmitReconcileRetry;
        if (job.dgxTerminalRetry) clearTimeout(job.dgxTerminalRetry);
        delete job.dgxTerminalRetry;
        try {
          if (job.dgxSubmitReconcileInFlight) {
            await this.withDeadline(job.dgxSubmitReconcileInFlight, deadline);
          } else if (job.dgxTerminalDelivery) {
            await this.withDeadline(this.flushDgxTerminalDelivery(job).then(() => undefined), deadline);
          } else {
            const reconciliation = this.reconcileTerminalPendingDgxSubmit(job);
            job.dgxSubmitReconcileInFlight = reconciliation;
            try {
              await this.withDeadline(reconciliation, deadline);
            } finally {
              if (job.dgxSubmitReconcileInFlight === reconciliation) {
                this.clearCancellationSettlementTransient(
                  job,
                  () => delete job.dgxSubmitReconcileInFlight,
                );
              }
            }
          }
        } catch {
          // Durable pending/delivery state remains the authority. The loop
          // retries until the caller's startup-cleanup deadline.
        }
        if (!job.dgxSubmitPending || Date.now() >= deadline) break;
        const requestedDelayMs = job.dgxSubmitReconcileDelayMs;
        delete job.dgxSubmitReconcileDelayMs;
        const delayMs = Math.min(
          requestedDelayMs ?? DGX_SUBMIT_RECONCILE_POLL_MS,
          Math.max(0, deadline - Date.now()),
        );
        if (delayMs > 0) {
          await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs));
        }
      }
    }
    for (const job of this.jobs.values()) {
      while (job.dgxTerminalDelivery && !this.shuttingDown && Date.now() < deadline) {
        if (job.dgxTerminalRetry) clearTimeout(job.dgxTerminalRetry);
        delete job.dgxTerminalRetry;
        try {
          await this.withDeadline(this.flushDgxTerminalDelivery(job).then(() => undefined), deadline);
        } catch {
          // The durable delivery remains pending and is retried below.
        }
        if (!job.dgxTerminalDelivery || Date.now() >= deadline) break;
        await new Promise<void>((resolvePromise) => setTimeout(
          resolvePromise,
          Math.min(DGX_SUBMIT_RECONCILE_POLL_MS, Math.max(0, deadline - Date.now())),
        ));
      }
    }
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
      if (job.dgxSubmitReconcileRetry) clearTimeout(job.dgxSubmitReconcileRetry);
      delete job.dgxSubmitReconcileRetry;
      if (job.localProcessGroupRetry) clearTimeout(job.localProcessGroupRetry);
      delete job.localProcessGroupRetry;
      if (job.ownedDockerContainerRetry) clearTimeout(job.ownedDockerContainerRetry);
      delete job.ownedDockerContainerRetry;
    }
    this.shutdownPromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      const activeJob = this.runningId ? this.jobs.get(this.runningId) : undefined;
      let localGroupsStopped = 0;
      const preserveLocalQueue = activeJob?.status === "queued"
        && !activeJob.dgxJobId
        && !activeJob.dgxSubmitPending
        && !activeJob.dgxPreparedAdmission
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
        if (activeJob.ownedDockerContainer) activeJob.ownedDockerContainer.state = "cleanup";
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
            this.cleanupOwnedDockerContainer(activeJob).then(() => undefined),
            deadline,
          ).catch(() => undefined);
          await this.withDeadline(
            this.flushDgxTerminalDelivery(activeJob).then(() => undefined),
            deadline,
          ).catch(() => undefined);
        }
      }
      if (this.activeRunPromise) {
        await this.withDeadline(this.activeRunPromise, deadline).catch(() => undefined);
      }
      for (const job of this.jobs.values()) {
        if (Date.now() >= deadline) break;
        if (!job.ownedDockerContainer || job.ownedDockerContainerRecoveryBlocked) continue;
        await this.withDeadline(
          this.cleanupOwnedDockerContainer(job).then(() => undefined),
          deadline,
        ).catch(() => undefined);
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
        localPending: [...this.jobs.values()].filter((job) => Boolean(
          job.localProcessSpawnPending
          || job.localProcessGroupPending
          || job.ownedDockerContainer
          || job.ownedDockerContainerRecoveryBlocked,
        )).length,
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
      const snapshot = {
        process: job.process,
        localProcessGroupPending: job.localProcessGroupPending,
        localProcessGroupIdentity: job.localProcessGroupIdentity
          ? structuredClone(job.localProcessGroupIdentity)
          : undefined,
      };
      if (job.process === process) delete job.process;
      delete job.localProcessGroupPending;
      delete job.localProcessGroupIdentity;
      try {
        this.changed();
      } catch (error) {
        if (snapshot.process) job.process = snapshot.process;
        if (snapshot.localProcessGroupPending) job.localProcessGroupPending = true;
        if (snapshot.localProcessGroupIdentity) {
          job.localProcessGroupIdentity = snapshot.localProcessGroupIdentity;
        }
        if (!isJobPersistenceHoldError(error)) {
          this.scheduleLocalProcessGroupReconciliation(job, 0);
        }
        throw error;
      }
      if (!await this.cleanupOwnedDockerContainer(job)) {
        throw new Error("Eigener Docker-Refiner ist noch nicht als abwesend bewiesen.");
      }
      await this.flushDgxTerminalDelivery(job);
    })();
    job.processTermination = termination;
    const observedTermination = termination.catch((error) => {
      this.recordCleanupDiagnostic(
        job,
        `Lokale Prozessgruppe konnte nicht sicher beendet werden; Remote-Lease bleibt vorgemerkt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }).finally(() => {
      if (job.processTermination === termination) {
        this.clearCancellationSettlementTransient(job, () => delete job.processTermination);
      }
    });
    this.runDetached(observedTermination, `Prozessgruppen-Terminisierung ${job.id}`);
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
    // Terminality is monotone. In particular, a heartbeat fail-stop can race
    // with a successful child exit; no continuation may revive a failed or
    // interrupted job and publish it as completed.
    return this.shuttingDown
      || this.persistenceHold !== null
      || !isActiveJobStatus(job.status);
  }

  private hasOutputReleaseAuthority(job: RuntimeJob, boundary: string): boolean {
    if (this.jobShouldStop(job)) return false;
    if (!job.dgxJobId) return true;
    try {
      requireDgxLeaseAuthority(job);
      if (job.dgxJobTerminal || job.dgxTerminalReceipt || job.dgxTerminalDelivery) {
        throw new DgxLeaseAuthorityError(
          `DGX-Lease ist vor ${boundary} bereits terminal oder zur Terminalisierung vorgemerkt.`,
        );
      }
    } catch (error) {
      this.enterPersistenceHold(error, `Ausgabeautorität vor ${boundary} ist nicht beweiskräftig`);
      return false;
    }
    if (this.dgxQueueOperations.heartbeat) {
      const heartbeat = job.dgxOwnerHeartbeat;
      const heartbeatHealthy = heartbeat
        && !heartbeat.stopped
        && heartbeat.jobId === job.dgxJobId
        && heartbeat.acknowledgedOnce
        && heartbeat.failureStartedAt === undefined
        && Date.now() - heartbeat.lastAcknowledgedAt < DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS;
      if (!heartbeatHealthy) {
        this.failJob(
          job,
          `Ausgabe bleibt unveröffentlicht: Der DGX-Owner-Heartbeat ist vor ${boundary} `
            + "nicht frisch und fehlerfrei bestätigt.",
        );
        return false;
      }
    }
    return true;
  }

  private assertPublicationMarkerReleaseAuthority(job: RuntimeJob): void {
    this.assertPersistenceAvailable("Publikationsmarker-Freigabe");
    const pending = normalizeOutputPublicationCommitPending(job.outputPublicationCommitPending);
    if (this.shuttingDown
      || !isActiveJobStatus(job.status)
      || !pending
      || !job.finishedAt
      || pending.completedAt !== job.finishedAt
      || !job.outputPublication
      || job.dgxTerminalDelivery
      || job.dgxTerminalReceipt
      || job.dgxJobTerminal) {
      throw new Error("Publikationsmarker besitzt keine dauerhaft vorbereitete lokale Commit-Phase.");
    }
    // Preparing and hashing a large marker/output pair is synchronous and can
    // take long enough for externally pinned runtime or Activation/Rights
    // inputs to drift.  Re-read both at the last synchronous fence shared by
    // CPU and DGX publication, directly before link(2) makes the marker public.
    this.revalidateRuntimeTrustBoundary(job, "unmittelbarer Publikationsmarker-Freigabe");
    const releaseDecision = this.jobStartDecision(job);
    if (!releaseDecision.allowed) {
      throw new Error(
        `Publikationsmarker wurde vom aktuellen Activation-/Rights-Gate verweigert: ${releaseDecision.reason}`,
      );
    }
    if (!job.dgxJobId) return;
    requireDgxLeaseAuthority(job);
    if (job.dgxJobTerminal
      || job.dgxTerminalReceipt
      || job.dgxTerminalDelivery) {
      throw new DgxLeaseAuthorityError(
        "Publikationsmarker besitzt keine aktive Lease ohne vorzeitigen Remote-Terminalintent.",
      );
    }
    if (this.dgxQueueOperations.heartbeat) {
      const heartbeat = job.dgxOwnerHeartbeat;
      if (!heartbeat
        || heartbeat.stopped
        || heartbeat.jobId !== job.dgxJobId
        || !heartbeat.acknowledgedOnce
        || heartbeat.failureStartedAt !== undefined
        || Date.now() - heartbeat.lastAcknowledgedAt >= DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS) {
        throw new DgxRemoteLeaseLostError(
          "Publikationsmarker wurde verweigert, weil der DGX-Owner-Heartbeat nicht frisch und fehlerfrei ist.",
        );
      }
    }
  }

  private bindOwnedDockerContainer(
    job: RuntimeJob,
    name: string,
    workload: OwnedDockerThermalWorkload,
  ): void {
    if (!job.dgxJobId
      || name !== `${workload.containerPrefix}${job.id}`
      || job.ownedDockerContainerRecoveryBlocked) {
      throw new Error(`${workload.label}-Container konnte nicht exakt an den aktuellen DGX-Job gebunden werden.`);
    }
    const previous = job.ownedDockerContainer;
    const authority: OwnedDockerContainerAuthority = {
      schemaVersion: "ltx-studio-owned-docker-container.v2",
      name,
      containerId: null,
      dgxJobId: job.dgxJobId,
      workload: workload.id,
      state: "bound",
      startGateReleasedAt: null,
      absenceProofStartedAt: null,
      absenceProofCount: 0,
    };
    if (previous && canonicalJson(previous) !== canonicalJson(authority)) {
      throw new Error("Ein anderer eigener Docker-Container ist noch nicht als abwesend bewiesen.");
    }
    job.ownedDockerContainer = authority;
    delete job.ownedDockerContainerIdDurablyCommitted;
    try {
      // This is the durable pre-spawn fence. The wrapper may create the
      // container only after its exact cleanup authority reached disk.
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        if (previous) job.ownedDockerContainer = previous;
        else delete job.ownedDockerContainer;
      }
      throw error;
    }
  }

  private setOwnedDockerContainerState(
    job: RuntimeJob,
    state: OwnedDockerContainerState,
  ): void {
    const authority = job.ownedDockerContainer;
    if (!authority || authority.state === state) return;
    const previous = authority.state;
    authority.state = state;
    try {
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) authority.state = previous;
      throw error;
    }
  }

  private markOwnedDockerStartGateReleased(job: RuntimeJob): void {
    const authority = job.ownedDockerContainer;
    if (!authority) throw new Error("Refiner-Startgate besitzt keine persistierte Containerautorität.");
    const snapshot = {
      state: authority.state,
      startGateReleasedAt: authority.startGateReleasedAt,
      absenceProofStartedAt: authority.absenceProofStartedAt,
      absenceProofCount: authority.absenceProofCount,
    };
    authority.state = "running";
    authority.startGateReleasedAt = now();
    authority.absenceProofStartedAt = null;
    authority.absenceProofCount = 0;
    try {
      // This durable ambiguity marker must precede the one-byte FD3 token.
      // Restore therefore knows that a daemon-side Create/Start may still
      // become visible even if the docker CLI process group has already died.
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) Object.assign(authority, snapshot);
      throw error;
    }
  }

  private async pinStartedOwnedDockerContainer(
    job: RuntimeJob,
    child: ChildProcess,
  ): Promise<void> {
    const deadline = Date.now() + OWNED_DOCKER_IDENTITY_DISCOVERY_MS;
    while (Date.now() < deadline) {
      const authority = job.ownedDockerContainer;
      if (!authority) throw new Error("Containerautorität verschwand während der ID-Bindung.");
      const inspection = this.inspectOwnedDockerContainer(job, authority);
      if (inspection.kind === "owned" && job.ownedDockerContainerIdDurablyCommitted) return;
      if (child.exitCode !== null || child.signalCode !== null || this.jobShouldStop(job)) {
        throw new Error("Refiner endete, bevor seine unveränderliche Docker-ID dauerhaft gebunden war.");
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    throw new Error("Refiner-Container wurde nach Gate-Freigabe nicht rechtzeitig identitätsgebunden sichtbar.");
  }

  private ownedDockerCommand(
    job: RuntimeJob,
    boundary: string,
    args: readonly string[],
    allowPersistenceHold = false,
  ): OwnedDockerCommandResult {
    this.revalidateRuntimeTrustBoundary(job, boundary, allowPersistenceHold);
    return this.ownedDockerOperations.run(args);
  }

  private inspectOwnedDockerContainer(
    job: RuntimeJob,
    authority: OwnedDockerContainerAuthority,
    allowPersistenceHoldCleanup = false,
  ): OwnedDockerInspection {
    if (this.persistenceHold
      && !(allowPersistenceHoldCleanup
        && authority.containerId !== null
        && job.ownedDockerContainerIdDurablyCommitted === true)) {
      this.assertPersistenceAvailable("Docker-Containeridentitätsprüfung");
    }
    const current = normalizeOwnedDockerContainerAuthority(
      authority,
      job.id,
      job.dgxJobId,
    );
    if (!current || canonicalJson(current) !== canonicalJson(authority)) {
      throw new Error("Persistierte Docker-Containerautorität widerspricht dem aktuellen Studio-/DGX-Job.");
    }
    const inspectTarget = authority.containerId ?? authority.name;
    const result = this.ownedDockerCommand(
      job,
      "Docker-Containeridentitätsprüfung",
      ["container", "inspect", "--format", "{{json .}}", inspectTarget],
      allowPersistenceHoldCleanup,
    );
    const stderr = result.stderr.trim();
    if (result.status !== 0 || result.error) {
      if (!result.error
        && result.status === 1
        && /No such (?:object|container):/iu.test(stderr)
        && stderr.includes(inspectTarget)) return { kind: "absent" };
      throw new Error(
        `docker container inspect für ${authority.name} war nicht beweiskräftig: ${
          result.error?.message || stderr || `Exit ${String(result.status)}`
        }`,
      );
    }
    let inspection: unknown;
    try {
      inspection = JSON.parse(result.stdout.trim());
    } catch {
      throw new Error(`docker container inspect für ${authority.name} lieferte kein gültiges JSON.`);
    }
    if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) {
      throw new Error(`docker container inspect für ${authority.name} lieferte kein Objekt.`);
    }
    const record = inspection as Record<string, unknown>;
    const inspectedContainerId = record.Id;
    const config = record.Config;
    const state = record.State;
    const labels = config && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>).Labels
      : null;
    if (typeof inspectedContainerId !== "string"
      || !/^[0-9a-f]{64}$/u.test(inspectedContainerId)
      || (authority.containerId !== null && inspectedContainerId !== authority.containerId)
      || record.Name !== `/${authority.name}`
      || !labels
      || typeof labels !== "object"
      || Array.isArray(labels)
      || (labels as Record<string, unknown>)["dgx.source_app"] !== "ltx-studio"
      || (labels as Record<string, unknown>)["dgx.job"] !== authority.dgxJobId
      || (labels as Record<string, unknown>)["dgx.runtime"] !== "ltx2_native"
      || !state
      || typeof state !== "object"
      || Array.isArray(state)
      || typeof (state as Record<string, unknown>).Paused !== "boolean"
      || typeof (state as Record<string, unknown>).Running !== "boolean") {
      throw new Error(
        `Container ${authority.name} besitzt nicht die exakt erwartete Studio-/DGX-Identität; er wird nicht verändert.`,
      );
    }
    if (authority.containerId === null) {
      const previousAbsenceProofStartedAt = authority.absenceProofStartedAt;
      const previousAbsenceProofCount = authority.absenceProofCount;
      authority.containerId = inspectedContainerId;
      authority.absenceProofStartedAt = null;
      authority.absenceProofCount = 0;
      try {
        // The immutable Docker ID must be durable before the first mutation;
        // all subsequent actions address the ID, never the reusable name.
        this.changed();
        job.ownedDockerContainerIdDurablyCommitted = true;
      } catch (error) {
        if (!isJobPersistenceHoldError(error)) {
          authority.containerId = null;
          authority.absenceProofStartedAt = previousAbsenceProofStartedAt;
          authority.absenceProofCount = previousAbsenceProofCount;
        }
        delete job.ownedDockerContainerIdDurablyCommitted;
        throw error;
      }
    }
    return {
      kind: "owned",
      containerId: inspectedContainerId,
      paused: (state as Record<string, unknown>).Paused as boolean,
      running: (state as Record<string, unknown>).Running as boolean,
    };
  }

  private mutateOwnedDockerContainer(
    job: RuntimeJob,
    authority: OwnedDockerContainerAuthority,
    action: string,
    argsBeforeTarget: readonly string[],
    allowPersistenceHoldCleanup = false,
  ): OwnedDockerInspection {
    if (this.persistenceHold
      && !(allowPersistenceHoldCleanup
        && authority.containerId !== null
        && job.ownedDockerContainerIdDurablyCommitted === true)) {
      this.assertPersistenceAvailable(`Docker-${action}`);
    }
    const before = this.inspectOwnedDockerContainer(job, authority, allowPersistenceHoldCleanup);
    if (before.kind === "absent") return before;
    const result = this.ownedDockerCommand(
      job,
      `Docker-${action}`,
      [...argsBeforeTarget, before.containerId],
      allowPersistenceHoldCleanup,
    );
    if (result.status !== 0 || result.error) {
      throw new Error(
        `docker ${action} für ${authority.name} scheiterte: ${
          result.error?.message || result.stderr.trim() || `Exit ${String(result.status)}`
        }`,
      );
    }
    return this.inspectOwnedDockerContainer(job, authority, allowPersistenceHoldCleanup);
  }

  private controlOwnedDockerThermalState(
    job: RuntimeJob,
    containerName: string,
    workload: OwnedDockerThermalWorkload,
    action: "pause" | "unpause",
  ): boolean {
    const authority = job.ownedDockerContainer;
    if (!authority
      || authority.name !== containerName
      || authority.workload !== workload.id) {
      throw new Error(`${workload.label}-Thermalaktion besitzt keine exakte persistierte Containerautorität.`);
    }
    const after = this.mutateOwnedDockerContainer(
      job,
      authority,
      action,
      [action],
    );
    const expectedPaused = action === "pause";
    if (after.kind !== "owned" || after.paused !== expectedPaused) {
      throw new Error(
        `${workload.label}-Containerzustand nach docker ${action} ist nicht beweiskräftig.`,
      );
    }
    this.setOwnedDockerContainerState(job, expectedPaused ? "paused" : "running");
    return true;
  }

  private confirmOwnedDockerCreationQuiescence(
    job: RuntimeJob,
    authority: OwnedDockerContainerAuthority,
  ): boolean {
    if (authority.containerId !== null || authority.startGateReleasedAt === null) return true;
    const timestamp = now();
    const observedAt = Date.parse(timestamp);
    const snapshot = {
      absenceProofStartedAt: authority.absenceProofStartedAt,
      absenceProofCount: authority.absenceProofCount,
    };
    if (authority.absenceProofStartedAt === null) {
      authority.absenceProofStartedAt = timestamp;
      authority.absenceProofCount = 1;
    } else {
      authority.absenceProofCount += 1;
    }
    try {
      // Every proof is a fresh name inspect performed only after the wrapper
      // process group is gone. Persisting the series keeps restore from
      // accepting one early 404 while Docker daemon Create/Start is delayed.
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) Object.assign(authority, snapshot);
      throw error;
    }
    return authority.absenceProofCount >= OWNED_DOCKER_CREATION_ABSENCE_PROOFS
      && observedAt - Date.parse(authority.absenceProofStartedAt)
        >= OWNED_DOCKER_CREATION_QUIESCENCE_MS;
  }

  private async cleanupOwnedDockerContainer(job: RuntimeJob): Promise<boolean> {
    if (job.ownedDockerContainerRecoveryBlocked) return false;
    if (!job.ownedDockerContainer) return true;
    if (job.ownedDockerContainerCleanup) return job.ownedDockerContainerCleanup;
    const cleanup = Promise.resolve().then(() => {
      const authority = job.ownedDockerContainer;
      if (!authority) return true;
      if (this.persistenceHold) {
        if (!authority.containerId || !job.ownedDockerContainerIdDurablyCommitted) return false;
      } else {
        this.setOwnedDockerContainerState(job, "cleanup");
      }
      let inspection = this.inspectOwnedDockerContainer(job, authority, true);
      if (inspection.kind === "owned" && inspection.paused) {
        try {
          inspection = this.mutateOwnedDockerContainer(
            job,
            authority,
            "unpause",
            ["unpause"],
            true,
          );
        } catch (error) {
          this.recordCleanupDiagnostic(
            job,
            `Eigener pausierter Docker-Container konnte nicht regulär fortgesetzt werden; Cleanup bleibt exakt identitätsgebunden: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          inspection = this.inspectOwnedDockerContainer(job, authority, true);
        }
      }
      if (inspection.kind === "owned") {
        try {
          inspection = this.mutateOwnedDockerContainer(
            job,
            authority,
            "stop",
            ["stop", "--time", "20"],
            true,
          );
        } catch (error) {
          this.recordCleanupDiagnostic(
            job,
            `Eigener Docker-Container konnte nicht regulär gestoppt werden; exakt gebundener rm-f-Fallback folgt: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          // A new inspect directly before rm -f is mandatory. It both
          // detects an already completed --rm and revalidates ownership.
          inspection = this.inspectOwnedDockerContainer(job, authority, true);
        }
      }
      if (inspection.kind === "owned") {
        inspection = this.mutateOwnedDockerContainer(
          job,
          authority,
          "rm -f",
          ["rm", "-f"],
          true,
        );
      }
      // Do not accept the mutation result alone. A final fresh inspect is the
      // sole absence proof, including after docker stop/rm reported success.
      inspection = this.inspectOwnedDockerContainer(job, authority, true);
      if (inspection.kind !== "absent") {
        throw new Error(`Container ${authority.name} ist nach Cleanup weiterhin vorhanden.`);
      }
      if (job.localProcessSpawnPending || job.localProcessGroupPending || job.localProcessGroupIdentity) {
        // On restart a wrapper can still be between inspect and docker run.
        // Keep the durable authority until its process group is also gone.
        return false;
      }
      if (!this.confirmOwnedDockerCreationQuiescence(job, authority)) return false;
      if (this.persistenceHold) return false;
      const markerSnapshot = structuredClone(authority);
      const idWasDurablyCommitted = job.ownedDockerContainerIdDurablyCommitted;
      const logsSnapshot = [...job.logs];
      if (job.ownedDockerContainerRetry) {
        clearTimeout(job.ownedDockerContainerRetry);
        delete job.ownedDockerContainerRetry;
      }
      if (job.ownedDockerContainer === authority) delete job.ownedDockerContainer;
      delete job.ownedDockerContainerIdDurablyCommitted;
      this.appendLog(
        job,
        `Eigener ${ownedDockerWorkload(authority.workload)?.label ?? "Docker-Refiner"}-Container ${authority.name} ist nachweislich abwesend.`,
      );
      try {
        this.changed();
      } catch (error) {
        // Restoring an immutable, already-verified marker is conservative even
        // in HOLD: it cannot authorize a reusable name, and it keeps local/DGX
        // settlement fenced until restart recovery resolves disk durability.
        job.ownedDockerContainer = markerSnapshot;
        if (idWasDurablyCommitted) job.ownedDockerContainerIdDurablyCommitted = true;
        job.logs = logsSnapshot;
        throw error;
      }
      return true;
    });
    job.ownedDockerContainerCleanup = cleanup;
    try {
      return await cleanup;
    } catch (error) {
      this.recordCleanupDiagnostic(
        job,
        `Docker-Cleanup bleibt fail-closed; lokale/DGX-Freigabe ist weiter gesperrt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    } finally {
      if (job.ownedDockerContainerCleanup === cleanup) {
        this.clearCancellationSettlementTransient(job, () => delete job.ownedDockerContainerCleanup);
      }
      if (job.ownedDockerContainer && !this.shuttingDown) {
        this.scheduleOwnedDockerContainerReconciliation(job, OWNED_DOCKER_CONTAINER_RECONCILE_MS);
      }
    }
  }

  private scheduleOwnedDockerContainerReconciliation(job: RuntimeJob, delayMs: number): void {
    if (this.shuttingDown
      || !job.ownedDockerContainer
      || job.ownedDockerContainerRecoveryBlocked
      || job.ownedDockerContainerRetry
      || job.ownedDockerContainerCleanup) return;
    job.ownedDockerContainerRetry = setTimeout(() => {
      this.clearCancellationSettlementTransient(
        job,
        () => delete job.ownedDockerContainerRetry,
      );
      this.runDetached(
        this.reconcileOwnedDockerContainer(job),
        `Docker-Container-Reconciliation ${job.id}`,
      );
    }, delayMs);
    job.ownedDockerContainerRetry.unref();
  }

  private async reconcileOwnedDockerContainer(job: RuntimeJob): Promise<void> {
    if (this.shuttingDown || !job.ownedDockerContainer) return;
    const settled = await this.cleanupOwnedDockerContainer(job);
    if (!settled) return;
    await this.flushDgxTerminalDelivery(job);
    this.scheduleDgxTerminalRetry(job, 0);
  }

  private async markProcessStarted(job: RuntimeJob, child: ChildProcess): Promise<void> {
    const spawnPendingSnapshot = job.localProcessSpawnPending;
    job.process = child;
    job.localProcessGroupPending = true;
    try {
      if (!child.pid) throw new Error("Gestarteter Prozess besitzt keine PID.");
      job.localProcessGroupIdentity = captureLocalProcessGroupIdentity(child.pid);
      delete job.localProcessSpawnPending;
      this.changed();
    } catch (error) {
      try {
        this.recordCleanupDiagnostic(
          job,
          `Lokale Prozessgruppenidentität konnte nicht dauerhaft gebunden werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } catch {
        // A diagnostic write must never stand between a spawned process and
        // its unconditional safety stop.
      }
      let groupGone = false;
      try {
        await terminateProcessGroup(child, false, 250, 2_000);
        groupGone = !child.pid || !processGroupExists(child.pid);
      } catch (terminationError) {
        try {
          this.recordCleanupDiagnostic(
            job,
            `Prozessgruppen-Sicherheitsstopp nach Bindefehler blieb unbestätigt: ${
              terminationError instanceof Error ? terminationError.message : String(terminationError)
            }`,
          );
        } catch {
          // The in-memory/persisted pending marker remains the fail-closed fence.
        }
      }
      if (groupGone && !this.persistenceHold && !isJobPersistenceHoldError(error)) {
        if (job.process === child) delete job.process;
        delete job.localProcessGroupPending;
        delete job.localProcessGroupIdentity;
        if (spawnPendingSnapshot) job.localProcessSpawnPending = true;
      }
      throw error;
    }
  }

  private async confirmProcessGroupGone(job: RuntimeJob, child: ChildProcess): Promise<void> {
    if (child.pid && processGroupExists(child.pid)) {
      await terminateProcessGroup(child, false, 250, 2_000);
    }
    if (this.persistenceHold) {
      // HOLD may prove/force quiescence, but only restart recovery may clear
      // the durable PG marker or release its remote lease.
      await this.safetyStopAfterPersistenceHold(job);
      return;
    }
    const processSnapshot = job.process;
    const pendingSnapshot = job.localProcessGroupPending;
    const identitySnapshot = job.localProcessGroupIdentity
      ? structuredClone(job.localProcessGroupIdentity)
      : undefined;
    if (job.process === child) delete job.process;
    delete job.localProcessGroupPending;
    delete job.localProcessGroupIdentity;
    try {
      this.changed();
    } catch (error) {
      if (processSnapshot) job.process = processSnapshot;
      else delete job.process;
      if (pendingSnapshot) job.localProcessGroupPending = true;
      if (identitySnapshot) job.localProcessGroupIdentity = identitySnapshot;
      if (!isJobPersistenceHoldError(error)) {
        this.scheduleLocalProcessGroupReconciliation(job, 0);
      }
      throw error;
    }
    if (!await this.cleanupOwnedDockerContainer(job)) {
      throw new Error("Eigener Docker-Refiner ist nach Prozessende noch nicht als abwesend bewiesen.");
    }
  }

  private scheduleLocalProcessGroupReconciliation(job: RuntimeJob, delayMs: number): void {
    if (
      this.shuttingDown
      || this.persistenceHold
      || !job.localProcessGroupPending
      || !job.localProcessGroupIdentity
      || job.localProcessGroupRetry
    ) {
      return;
    }
    job.localProcessGroupRetry = setTimeout(() => {
      delete job.localProcessGroupRetry;
      this.runDetached(
        this.reconcileLocalProcessGroup(job),
        `Prozessgruppen-Reconciliation ${job.id}`,
      );
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
    if (this.persistenceHold) return;
    const processSnapshot = job.process;
    const pendingSnapshot = job.localProcessGroupPending;
    const identitySnapshot = structuredClone(identity);
    const logsSnapshot = [...job.logs];
    if (job.process?.pid === identity.processGroupId) delete job.process;
    delete job.localProcessGroupPending;
    delete job.localProcessGroupIdentity;
    this.appendLog(
      job,
      "Studio-Recovery: frühere lokale Prozessgruppe ist nachweislich beendet; Remote-Terminalmeldung wird freigegeben.",
    );
    try {
      this.changed();
    } catch (error) {
      // A proven pre-rename failure means disk still contains the marker. Keep
      // RAM identical and retry reconciliation live. In HOLD the early guard
      // above prevents marker mutation entirely.
      if (processSnapshot) job.process = processSnapshot;
      else delete job.process;
      if (pendingSnapshot) job.localProcessGroupPending = true;
      job.localProcessGroupIdentity = identitySnapshot;
      job.logs = logsSnapshot;
      if (!isJobPersistenceHoldError(error)) {
        this.scheduleLocalProcessGroupReconciliation(job, 0);
      }
      throw error;
    }
    if (job.ownedDockerContainer) {
      this.scheduleOwnedDockerContainerReconciliation(job, 0);
      return;
    }
    await this.flushDgxTerminalDelivery(job);
    this.scheduleDgxTerminalRetry(job, 0);
  }

  private async pump(): Promise<void> {
    if (this.shuttingDown || this.persistenceHold || this.runningId !== null) return;
    // A deferred entry is a prepared transaction, not runnable queue work.
    // Another job may trigger the shared pump while its external experiment
    // CAS is still pending, so the fence must be enforced here as well as at
    // the create() call site.
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const queued = this.jobs.get(this.queue[index]!);
      if (!queued || queued.status !== "queued") this.queue.splice(index, 1);
    }
    const runnableIndex = this.queue.findIndex((queuedId) =>
      this.jobs.get(queuedId)?.startDeferred === false);
    if (runnableIndex < 0) return;
    const [id] = this.queue.splice(runnableIndex, 1);
    if (!id) return;
    const job = this.jobs.get(id);
    if (!job || job.status !== "queued") return this.pump();
    const decision = this.jobStartDecision(job);
    if (!decision.allowed) {
      job.status = "failed";
      job.finishedAt = now();
      job.error = decision.reason;
      this.appendLog(job, decision.reason);
      this.changed();
      return this.pump();
    }
    this.runningId = id;
    const runPromise = this.run(job);
    this.activeRunPromise = runPromise;
    try {
      await runPromise;
    } catch (error) {
      if (isJobPersistenceHoldError(error)) {
        process.stderr.write(
          `LTX Studio Runner bleibt wegen Persistenz-HOLD fail-stop ohne Status-/DGX-Kompensation: ${error.message}\n`,
        );
        return;
      }
      // Publication is already locally terminal before its remote completion
      // receipt is flushed. A delivery/receipt error must leave that completed
      // authority monotone; only an actually active runner may still fail.
      if (isActiveJobStatus(this.jobs.get(id)?.status ?? "failed")) {
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
      this.clearCancellationSettlementTransient(job, () => {
        this.runningId = null;
      });
      if (job.dgxSubmitPending && !isActiveJobStatus(job.status)) {
        this.scheduleTerminalPendingDgxSubmitReconciliation(job, 0);
      }
      if (!this.shuttingDown) this.runDetached(this.pump(), "nachfolgender Queue-Pump");
    }
  }

  private startSource(metadata: JobCreateMetadata): Exclude<JobStartSource, "restored"> {
    if (metadata.project) return "project";
    if (metadata.experiment) return "experiment";
    if (metadata.variantOf) return "rerun";
    return "direct";
  }

  private assertStartAllowed(
    request: GenerationRequest,
    source: Exclude<JobStartSource, "restored">,
    requestSha256: string,
    experiment: ExperimentRunBinding | null,
  ): void {
    if (isLegacyDfrRequest(request)) {
      throw new JobConflictError(
        "Historischer DFR-Altbestand vor v1.3.0 ist unveränderlich lesbar, aber nicht ausführbar. "
        + "Für einen neuen Lauf muss DFR ausdrücklich mit dem aktuellen v1.3-Vertrag neu konfiguriert werden.",
      );
    }
    const qualificationHold = qualificationHoldForRequest(request);
    if (qualificationHold) throw new JobConflictError(qualificationHold.reason);
    if ((source === "experiment") !== (experiment !== null)
      || (experiment && validRequestBoundExperimentBinding(request, experiment) === null)) {
      throw new JobConflictError(
        "Experimentquelle und kanonische Request-Bindung stimmen nicht überein.",
      );
    }
    const decision = this.startEnforcer.decide({
      requestSha256,
      surfaceEntryId: jobSurfaceEntryId(request, source, sealedRelease, experiment),
      source,
    });
    if (!decision.allowed) throw new JobConflictError(decision.reason);
  }

  private deniedStartDecision(reason: string): JobStartDecision {
    const status = this.startEnforcer.inspect();
    return {
      allowed: false,
      mode: status.mode,
      reason,
      schemaVersion: status.schemaVersion,
      generation: status.generation,
      activationHeadSha256: status.activationHeadSha256,
    };
  }

  private rawOutputBaselineImageAuthority(job: Pick<RawOutputCandidateAuthorityJob, "request" | "experiment">): {
    evidence: ProvenanceContainerImageEvidence | null;
    error: string | null;
  } {
    if (job.request.postprocess.lipForcing.rawOutputProfile
      !== experimentalLipForcingRawOutputProfile) {
      return { evidence: null, error: null };
    }
    const candidateBinding = validRawOutputExperimentBinding(job.request, job.experiment);
    if (!candidateBinding?.baselineJobId) {
      return {
        evidence: null,
        error: "Mux-copy-Kandidat besitzt keine exakt requestgebundene frische Baseline.",
      };
    }
    const baseline = this.jobs.get(candidateBinding.baselineJobId);
    const baselineBinding = baseline
      ? validRequestBoundExperimentBinding(baseline.request, baseline.experiment)
      : null;
    const currentPublication = baseline?.outputPublication
      ? readValidOutputPublicationAuthority(outputRoot, baseline.outputName)
      : null;
    const baselineOutputPublished = Boolean(
      baseline
      && this.fileReady(baseline.plan.outputPath)
      && currentPublication
      && baseline.outputPublication
      && canonicalJson(currentPublication) === canonicalJson(baseline.outputPublication)
      && currentPublication.jobId === baseline.id
      && currentPublication.publishedAt === baseline.finishedAt,
    );
    if (!baseline
      || baseline.status !== "completed"
      || baselineBinding?.arm !== "baseline"
      || baselineBinding.experimentId !== candidateBinding.experimentId
      || baselineBinding.protocolSha256 !== candidateBinding.protocolSha256
      || baselineBinding.kind !== "ablation"
      || baselineBinding.variableId !== "lipforcing-raw-output-profile"
      || baselineBinding.changedRequestPaths.length !== 1
      || baselineBinding.changedRequestPaths[0] !== LIPFORCING_RAW_OUTPUT_EXPERIMENT_PATH
      || baselineBinding.requestSha256 !== candidateBinding.baselineRequestSha256
      || baselineBinding.baselineJobId !== null
      || baselineBinding.adoptedBaseline === true
      || baseline.outputName !== candidateBinding.baselineOutputName
      || !baselineOutputPublished
      || runtimeAuthorityRequestSha256(baseline) === null
      || baseline.runProvenance?.verifiedAt == null
      || !runProvenanceFingerprintMatches(baseline.runProvenance)) {
      return {
        evidence: null,
        error: "Mux-copy-Kandidat benötigt den abgeschlossenen, frisch gerenderten und exakt protokollgebundenen Baseline-Arm.",
      };
    }
    const evidence = lipForcingImageIdentity(baseline.runProvenance.containerImages);
    if (!evidence) {
      return {
        evidence: null,
        error: "Der frische Baseline-Arm besitzt keine gültige unveränderliche LipForcing-Containeridentität.",
      };
    }
    return { evidence, error: null };
  }

  private positivePromptBaselineAuthority(job: RuntimeJob): {
    baseline: RuntimeJob | null;
    error: string | null;
  } {
    if (job.experiment?.arm !== "candidate" || job.experiment.variableId !== "positive-prompt") {
      return { baseline: null, error: null };
    }
    const candidateBinding = validPositivePromptExperimentBinding(job.request, job.experiment);
    const baseline = candidateBinding?.baselineJobId
      ? this.jobs.get(candidateBinding.baselineJobId) ?? null
      : null;
    const baselineBinding = baseline
      ? validPositivePromptExperimentArmBinding(baseline.request, baseline.experiment)
      : null;
    const currentPublication = baseline?.outputPublication
      ? readValidOutputPublicationAuthority(outputRoot, baseline.outputName)
      : null;
    const publicationMatches = Boolean(
      baseline
      && this.fileReady(baseline.plan.outputPath)
      && currentPublication
      && baseline.outputPublication
      && canonicalJson(currentPublication) === canonicalJson(baseline.outputPublication)
      && currentPublication.jobId === baseline.id
      && currentPublication.publishedAt === baseline.finishedAt,
    );
    if (!candidateBinding?.baselineJobId
      || !baseline
      || baseline.status !== "completed"
      || baselineBinding?.arm !== "baseline"
      || baselineBinding.experimentId !== candidateBinding.experimentId
      || baselineBinding.protocolSha256 !== candidateBinding.protocolSha256
      || baselineBinding.requestSha256 !== candidateBinding.baselineRequestSha256
      || baseline.outputName !== candidateBinding.baselineOutputName
      || runtimeAuthorityRequestSha256(baseline) === null
      || !publicationMatches
      || baseline.runProvenance?.verifiedAt == null
      || !runProvenanceFingerprintMatches(baseline.runProvenance)) {
      return {
        baseline: null,
        error: "Der Prompt-Kandidat benötigt den abgeschlossenen, frisch gerenderten, "
          + "publizierten und exakt protokollgebundenen Baseline-Arm.",
      };
    }
    return { baseline, error: null };
  }

  private rawOutputPairAuthority(job: RawOutputCandidateAuthorityJob): {
    authority: RawMuxBaselineAuthority | null;
    authorityBinding: ExecutionFileBinding | null;
    baselineRunProvenance: RunProvenance | null;
    baselineProvenanceFingerprint: string | null;
    error: string | null;
  } {
    if (!isBoundRawOutputCandidate(job)) {
      return {
        authority: null,
        authorityBinding: null,
        baselineRunProvenance: null,
        baselineProvenanceFingerprint: null,
        error: null,
      };
    }
    const binding = validRawOutputExperimentBinding(job.request, job.experiment);
    const baseline = binding?.baselineJobId ? this.jobs.get(binding.baselineJobId) : null;
    const imageAuthority = this.rawOutputBaselineImageAuthority(job);
    if (!binding?.baselineJobId || !baseline || imageAuthority.error || !imageAuthority.evidence) {
      return {
        authority: null,
        authorityBinding: null,
        baselineRunProvenance: null,
        baselineProvenanceFingerprint: null,
        error: imageAuthority.error
          ?? "Mux-copy-Kandidat besitzt keine gültige gepaarte Baseline-Containerautorität.",
      };
    }
    const baselineBinding = validRawOutputBaselineExperimentBinding(
      baseline.request,
      baseline.experiment,
    );
    const derivedCandidate = baselineBinding
      ? rawMuxCandidateRequestFromBaseline(baseline.request, baselineBinding)
      : null;
    if (!baselineBinding
      || baselineBinding.experimentId !== binding.experimentId
      || baselineBinding.protocolSha256 !== binding.protocolSha256
      || !derivedCandidate
      || experimentRequestSha256V1(derivedCandidate) !== binding.requestSha256) {
      return {
        authority: null,
        authorityBinding: null,
        baselineRunProvenance: null,
        baselineProvenanceFingerprint: null,
        error: "Mux-copy-Kandidat stimmt nicht mit dem deterministisch abgeleiteten gepaarten Baseline-Request überein.",
      };
    }
    const paths = rawMuxPairPaths(join(hybridRoot, baseline.id));
    const verifiedAuthority = readVerifiedRawMuxBaselineAuthority(paths, {
      experimentId: binding.experimentId,
      protocolSha256: binding.protocolSha256,
      baselineJobId: baseline.id,
      baselineOutputName: binding.baselineOutputName,
      baselineRequestSha256: binding.baselineRequestSha256,
      candidateRequestSha256: binding.requestSha256,
      containerImageFingerprint: imageAuthority.evidence.fingerprint,
      baselineFinalPath: baseline.plan.outputPath,
      mouthDelayMs: baseline.request.postprocess.lipForcing.mouthDelayMs,
      programAudioDelayMs: baseline.request.postprocess.lipForcing.programAudioDelayMs,
    });
    const manifestEvidence = baseline.runProvenance?.files.filter((file) =>
      file.role === "private:lipforcing-raw-mux-pair-v1") ?? [];
    const authority = verifiedAuthority?.authority ?? null;
    const currentAuthority = verifiedAuthority?.authorityBinding ?? null;
    if (!authority || !currentAuthority
      || manifestEvidence.length !== 1
      || manifestEvidence[0].path !== paths.authority
      || manifestEvidence[0].sha256 !== currentAuthority.sha256
      || manifestEvidence[0].sizeBytes !== currentAuthority.revision.sizeBytes
      || manifestEvidence[0].fileId !== currentAuthority.revision.fileId
      || !baseline.runProvenance?.verifiedAt
      || !runProvenanceFingerprintMatches(baseline.runProvenance)) {
      return {
        authority: null,
        authorityBinding: null,
        baselineRunProvenance: null,
        baselineProvenanceFingerprint: null,
        error: "Gepaarte Raw-Mux-Baseline-Artefakte oder ihre verifizierte private Manifestbindung fehlen oder sind gedriftet.",
      };
    }
    if (job.identityEvidence
      && !identityEvidenceMatches(baseline.identityEvidence, job.identityEvidence)) {
      return {
        authority: null,
        authorityBinding: null,
        baselineRunProvenance: null,
        baselineProvenanceFingerprint: null,
        error: "Gepaarter Raw-Mux-Kandidat stimmt nicht exakt mit der aktuellen Eingabeidentität seiner Baseline überein.",
      };
    }
    if (job.runProvenance
      && (!runProvenanceSharesLtxBase(baseline.runProvenance, job.runProvenance)
        || !runProvenanceUsesExactLipForcingImage(job.runProvenance, imageAuthority.evidence))) {
      return {
        authority: null,
        authorityBinding: null,
        baselineRunProvenance: null,
        baselineProvenanceFingerprint: null,
        error: "Gepaarter Raw-Mux-Kandidat stimmt nicht exakt mit Eingabe-, LTX- und Containerprovenienz seiner Baseline überein.",
      };
    }
    return {
      authority,
      authorityBinding: currentAuthority,
      baselineRunProvenance: baseline.runProvenance,
      baselineProvenanceFingerprint: baseline.runProvenance.fingerprint,
      error: null,
    };
  }

  private jobStartDecision(job: RuntimeJob): JobStartDecision {
    const canonicalRequestSha256 = createHash("sha256")
      .update(canonicalJson(job.request))
      .digest("hex");
    if (job.authorityRequestSha256 !== canonicalRequestSha256) {
      return this.deniedStartDecision(
        "Kanonischer Request und persistierte Jobautorität stimmen nicht überein.",
      );
    }
    if (isLegacyDfrRequest(job.request)) {
      return this.deniedStartDecision(
        "Historischer DFR-Altbestand vor v1.3.0 ist nur lesbar und darf nicht neu ausgeführt werden.",
      );
    }
    const qualificationHold = qualificationHoldForRequest(job.request);
    if (qualificationHold) return this.deniedStartDecision(qualificationHold.reason);
    if ((job.startSource === "experiment") !== (job.experiment !== null)
      || (job.experiment
        && validRequestBoundExperimentBinding(job.request, job.experiment) === null)) {
      return this.deniedStartDecision(
        "Experimentquelle und kanonische Request-Bindung stimmen nicht überein.",
      );
    }
    const rawBaseline = this.rawOutputBaselineImageAuthority(job);
    if (rawBaseline.error) return this.deniedStartDecision(rawBaseline.error);
    const executionDecision = normalizeJobExecutionDecision(job.executionDecision);
    const pinnedPairedPromotion = isBoundRawOutputCandidate(job)
      && executionDecision?.schemaVersion === "ltx-studio-execution-decision.v6"
      && executionDecision.executionClass === "cpu-only"
      && executionDecision.operation?.kind === "paired-artifact-promotion";
    if (!pinnedPairedPromotion) {
      const rawPair = this.rawOutputPairAuthority(job);
      if (rawPair.error) return this.deniedStartDecision(rawPair.error);
    }
    if (rawBaseline.evidence
      && job.runProvenance
      && !runProvenanceUsesExactLipForcingImage(job.runProvenance, rawBaseline.evidence)) {
      return this.deniedStartDecision(
        "Mux-copy-Kandidat und frische Baseline besitzen nicht dieselbe unveränderliche Containeridentität.",
      );
    }
    try {
      return this.startEnforcer.decide({
        requestSha256: job.authorityRequestSha256,
        surfaceEntryId: jobSurfaceEntryId(job.request, job.startSource, sealedRelease, job.experiment),
        source: job.startSource,
      });
    } catch (error) {
      return this.deniedStartDecision(
        error instanceof Error ? error.message : "Jobstart-Autorität ist ungültig.",
      );
    }
  }

  /**
   * Re-read every externally pinned Runtime-Seal input immediately beside a
   * state-changing boundary.  This is intentionally synchronous: no submit,
   * fence, process, Docker action, resume, or publication may race ahead of a
   * failed revalidation.
   */
  private revalidateRuntimeTrustBoundary(
    job: RuntimeJob,
    boundary: string,
    allowPersistenceHold = false,
  ): void {
    if (!allowPersistenceHold) this.assertPersistenceAvailable(boundary);
    try {
      this.runtimeTrustRevalidation();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Runtime-Trust-Revalidierung vor ${boundary} verweigert: ${detail}`);
    }
  }

  private verifyNativeRuntimeSourceBeforeAdmission(job: RuntimeJob): boolean {
    try {
      const evidence = verifyNativeRuntimeSource(
        job.request,
        job.plan.executable,
        this.nativeRuntimeSourceProbeOperations,
      );
      if (evidence) {
        this.appendLog(
          job,
          `Native Runtime-Source-Gate: ltx-pipelines ${evidence.distributionVersion}, `
            + `${evidence.contractId.toUpperCase()} Runtime-SHA ${evidence.runtimeSourceSha256.slice(0, 12)}, `
            + `Upstream-SHA ${evidence.upstreamSourceSha256.slice(0, 12)} und Patchbindung `
            + `${evidence.patchBinding.bindingSha256.slice(0, 12)} verifiziert.`,
        );
        this.changed();
      }
      return true;
    } catch (error) {
      this.failJob(
        job,
        `Native Runtime-Source-Gate verweigert den Lauf vor Admission: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  private async captureInitialIdentityEvidence(job: RuntimeJob): Promise<boolean> {
    const captured = await this.identityEvidenceOperations.capture(job.request, this.assets);
    if (this.jobShouldStop(job)) return false;
    job.identityEvidence = captured;
    if (captured.status === "captured") {
      this.appendLog(
        job,
        `${captured.references.length} Identitätsreferenz(en) kryptografisch für diesen Lauf gebunden.`,
      );
    } else if (captured.status === "unavailable") {
      this.appendLog(
        job,
        `Identitätsmessung später nicht beweisbar: ${captured.reason ?? "Referenzprovenienz fehlt."}`,
      );
    }
    this.changed();
    return true;
  }

  private async captureInitialRunProvenance(
    job: RuntimeJob,
    options?: Parameters<typeof captureRunProvenance>[2],
  ): Promise<boolean> {
    let captured: RunProvenance;
    try {
      captured = await this.runProvenanceOperations.capture(job.request, job.plan, options);
    } catch (error) {
      if (this.jobShouldStop(job)) return false;
      this.failJob(
        job,
        `Laufprovenienz konnte nicht vollständig gebunden werden: ${
          error instanceof Error ? error.message : "unbekannter Fehler"
        }`,
      );
      return false;
    }
    if (this.jobShouldStop(job)) return false;
    if (options?.expectedLipForcingImage
      && !runProvenanceUsesExactLipForcingImage(captured, options.expectedLipForcingImage)) {
      this.failJob(
        job,
        "Mux-copy-Kandidat wurde nicht an exakt dieselbe unveränderliche Containeridentität wie seine frische Baseline gebunden.",
      );
      return false;
    }
    job.runProvenance = captured;
    this.appendLog(
      job,
      `${captured.files.length} verwendete Datei-/Modellartefakte sowie Code und Runtime kryptografisch gebunden `
        + `(Manifest ${captured.fingerprint.slice(0, 12)}).`,
    );
    this.changed();
    return true;
  }

  private async bindJobRunProvenanceFile(
    job: RuntimeJob,
    path: string,
    role: string,
  ): Promise<boolean> {
    if (!job.runProvenance) throw new Error("Laufprovenienz fehlt vor der Dateibindung.");
    const bindFile = this.runProvenanceOperations.bindFile ?? bindRunProvenanceFile;
    const bound = await bindFile(job.runProvenance, path, role);
    if (this.jobShouldStop(job)) return false;
    job.runProvenance = bound;
    return true;
  }

  private async run(job: RuntimeJob): Promise<void> {
    const exactAdoptedRefinerRun = isAdoptedLipForcingCandidate(job.experiment);
    const rawMuxPairedCandidate = isBoundRawOutputCandidate(job);
    const programAudioOnlyCandidate = isBoundProgramAudioOnlyCandidate(job);
    const positivePromptExperimentArm = job.experiment?.variableId === "positive-prompt"
      ? validPositivePromptExperimentArmBinding(job.request, job.experiment)
      : null;
    if (job.experiment?.variableId === "positive-prompt" && !positivePromptExperimentArm) {
      this.failJob(
        job,
        "Der Prompt-Experimentarm besitzt keine exakt request- und protokollgebundene Einzelfaktor-Autorität.",
      );
      return;
    }
    if (!programAudioOnlyCandidate && !this.verifyNativeRuntimeSourceBeforeAdmission(job)) return;
    const requiredAssetIds = exactAdoptedRefinerRun
      || rawMuxPairedCandidate
      || programAudioOnlyCandidate
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
      if (this.jobShouldStop(job)) return;
    }
    if (!rawMuxPairedCandidate && !programAudioOnlyCandidate) {
      pathErrors.push(...validateRequestPlan(job.request, job.plan, inventory, {
        enforceOfficialAssets: !exactAdoptedRefinerRun,
      }));
    }
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
      if (!executableAvailable(hostTcbExecutables.docker)) {
        pathErrors.push("Docker für den LatentSync-Refiner ist nicht verfügbar.");
      } else {
        try {
          this.revalidateRuntimeTrustBoundary(job, "Docker-Image-Inspektion");
          const imageCheck = spawnSync(hostTcbExecutables.docker, ["image", "inspect", latentSyncImage], {
            encoding: "utf8",
            env: HOST_TCB_DOCKER_ENV,
            shell: false,
            stdio: "ignore",
            timeout: 20_000,
          });
          if (imageCheck.status !== 0 || imageCheck.error) {
            pathErrors.push(`LatentSync-Containerimage fehlt (${latentSyncImage}).`);
          }
        } catch (error) {
          pathErrors.push(error instanceof Error ? error.message : String(error));
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
      if (!executableAvailable(hostTcbExecutables.docker)) {
        pathErrors.push("Docker für den MuseTalk-Refiner ist nicht verfügbar.");
      } else {
        try {
          this.revalidateRuntimeTrustBoundary(job, "Docker-Image-Inspektion");
          const imageCheck = spawnSync(hostTcbExecutables.docker, ["image", "inspect", museTalkImage], {
            encoding: "utf8",
            env: HOST_TCB_DOCKER_ENV,
            shell: false,
            stdio: "ignore",
            timeout: 20_000,
          });
          if (imageCheck.status !== 0 || imageCheck.error) {
            pathErrors.push(`MuseTalk-Containerimage fehlt (${museTalkImage}).`);
          }
        } catch (error) {
          pathErrors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (lipForcingEnabled && !rawMuxPairedCandidate && !programAudioOnlyCandidate) {
      const rawOutputImageAuthority = this.rawOutputBaselineImageAuthority(job);
      const lipForcingAvailabilityReference = rawOutputImageAuthority.evidence?.executionReference
        ?? lipForcingImage;
      if (rawOutputImageAuthority.error) pathErrors.push(rawOutputImageAuthority.error);
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
      if (!executableAvailable(hostTcbExecutables.docker)) {
        pathErrors.push("Docker für den LipForcing-Refiner ist nicht verfügbar.");
      } else {
        try {
          this.revalidateRuntimeTrustBoundary(job, "Docker-Image-Inspektion");
          const imageCheck = spawnSync(
            hostTcbExecutables.docker,
            ["image", "inspect", lipForcingAvailabilityReference],
            {
              encoding: "utf8",
              env: HOST_TCB_DOCKER_ENV,
              shell: false,
              stdio: "ignore",
              timeout: 20_000,
            },
          );
          if (imageCheck.status !== 0 || imageCheck.error) {
            pathErrors.push(`LipForcing-Containerimage fehlt (${lipForcingAvailabilityReference}).`);
          }
        } catch (error) {
          pathErrors.push(error instanceof Error ? error.message : String(error));
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
    if (!rawMuxPairedCandidate
      && !programAudioOnlyCandidate
      && !pythonRuntimeAvailable(pythonExecutable)) {
      job.status = "failed";
      job.finishedAt = now();
      job.error = `Die konfigurierte Python-LTX-Laufzeit ist unvollständig: ${pythonExecutable}`;
      this.appendLog(job, job.error);
      this.changed();
      return;
    }
    if (!rawMuxPairedCandidate
      && (finalAudioMixEnabled || refinerEnabled)
      && !executableAvailable("ffmpeg")) {
      job.status = "failed";
      job.finishedAt = now();
      job.error = "FFmpeg für die finale Tonspur ist nicht verfügbar.";
      this.appendLog(job, job.error);
      this.changed();
      return;
    }
    if (programAudioOnlyCandidate
      && (!executableAvailable("ffmpeg") || !executableAvailable("ffprobe"))) {
      job.status = "failed";
      job.finishedAt = now();
      job.error = "FFmpeg und FFprobe für den beweisgebundenen Audio-only-Retime sind nicht verfügbar.";
      this.appendLog(job, job.error);
      this.changed();
      return;
    }

    if (!await this.captureInitialIdentityEvidence(job)) return;

    if (rawMuxPairedCandidate) {
      const paired = this.rawOutputPairAuthority(job);
      if (paired.error
        || !paired.authority
        || !paired.authorityBinding
        || !paired.baselineRunProvenance
        || !paired.baselineProvenanceFingerprint) {
        this.failJob(
          job,
          paired.error
            ?? "Gepaarte Raw-Mux-Baseline ist nicht vollständig und unverändert verfügbar; ein DGX-Fallback ist verboten.",
        );
        return;
      }
      try {
        job.runProvenance = forkVerifiedRunProvenanceForArtifactPromotion(
          paired.baselineRunProvenance,
        );
      } catch (error) {
        this.failJob(
          job,
          `Historische Baseline-Provenienz konnte nicht für die CPU-only-Promotion gebunden werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      this.appendLog(
        job,
        "CPU-only Paar-Promotion übernimmt die verifizierte historische Baseline-Provenienz; aktuelle DGX-Modelle, Python und Docker werden nicht benötigt.",
      );
      this.changed();
      await this.runPairedRawOutputCandidate(
        job,
        paired.authority,
        paired.authorityBinding,
        paired.baselineProvenanceFingerprint,
      );
      return;
    }

    if (programAudioOnlyCandidate) {
      const reusableProgramAudioOutput = this.findReusableLipForcingOutput(job);
      if (!reusableProgramAudioOutput) {
        this.failJob(
          job,
          "Die exakt protokollgebundene Baseline samt Ausgabe-, Einstellungs- und Analyse-Sidecar "
            + "ist nicht unverändert verfügbar; kein Fremdquellen- oder DGX-Fallback ist zulässig.",
        );
        return;
      }
      try {
        job.runProvenance = forkVerifiedRunProvenanceForArtifactPromotion(
          reusableProgramAudioOutput.sourceRunProvenance,
        );
      } catch (error) {
        this.failJob(
          job,
          `Historische Baseline-Provenienz konnte nicht für den CPU-only-Retime gebunden werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      this.appendLog(
        job,
        "CPU-only Audio-Retime übernimmt die verifizierte historische Baseline-Provenienz; "
          + "aktuelle DGX-Modelle, Python und Docker werden nicht benötigt.",
      );
      this.changed();
      await this.runReusedLipForcingAudioRetime(job, reusableProgramAudioOutput);
      return;
    }

    const rawOutputBaselineImage = this.rawOutputBaselineImageAuthority(job);
    if (rawOutputBaselineImage.error) {
      this.failJob(job, rawOutputBaselineImage.error);
      return;
    }
    if (!await this.captureInitialRunProvenance(
      job,
      rawOutputBaselineImage.evidence
        ? { expectedLipForcingImage: rawOutputBaselineImage.evidence }
        : undefined,
    )) return;

    if (positivePromptExperimentArm?.arm === "candidate") {
      const authority = this.positivePromptBaselineAuthority(job);
      if (authority.error || !authority.baseline) {
        this.failJob(job, authority.error ?? "Der frische Prompt-Baseline-Arm ist nicht verfügbar.");
        return;
      }
      const environmentError = positivePromptCandidateEnvironmentError(job, authority.baseline);
      if (environmentError) {
        this.failJob(job, environmentError);
        return;
      }
    }

    // Every remaining path can allocate DGX resources (including the LongCat
    // supervisor). Persist the class before any admission or GPU start gate.
    if (!this.classifyExecution(job, "dgx")) return;

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

    const reusableBase = genericLtxBaseReuseAllowed(job)
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
        if (!await this.bindJobRunProvenanceFile(
          job,
          ltxOutput,
          `input:reused-ltx-base:${reusableBase.id}`,
        )) return;
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
      if (positivePromptExperimentArm?.arm === "candidate") {
        const authority = this.positivePromptBaselineAuthority(job);
        if (authority.error || !authority.baseline) {
          this.failJob(job, authority.error ?? "Der frische Prompt-Baseline-Arm ist nicht verfügbar.");
          await this.transitionDgxJob(job, "failed", {
            current_step: "fresh prompt baseline authority changed before LTX allocation",
            last_error: job.error ?? "fresh prompt baseline authority verification failed",
          });
          return;
        }
        const environmentError = positivePromptCandidateEnvironmentError(job, authority.baseline);
        if (environmentError) {
          this.failJob(job, environmentError);
          await this.transitionDgxJob(job, "failed", {
            current_step: "fresh prompt control environment changed before LTX allocation",
            last_error: job.error ?? "fresh prompt control environment verification failed",
          });
          return;
        }
      }
      this.appendLog(job, `LTX-Start: ${job.command}`);
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
        && job.plan.executable === rendererPythonExecutable
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
        let completion: Promise<ProcessResult> | null = null;
        const boundaryWatcher: { value: {
          stop: () => Promise<void>;
          yieldDecisionId: () => string | null;
        } | null } = { value: null };
        let stopThermalWatcher: () => void = () => undefined;
        let resourceTelemetry: ActiveLtxResourceTelemetry | null = null;
        let child: ChildProcess;
        try {
          child = await this.spawnProcessWithDurableGate(job, job.plan.executable, ltxArgs, {
            cwd: repoRoot,
            env: isolatedPythonEnvironment({
              DGX_JOB_ID: job.dgxJobId ?? undefined,
              LTX_COOPERATIVE_CHECKPOINT_DIR: cooperativeEnabled ? checkpointRoot : undefined,
              LTX_COOPERATIVE_JOB_FINGERPRINT: cooperativeEnabled
                ? job.runProvenance?.fingerprint
                : undefined,
              LTX_COOPERATIVE_GENERATION: cooperativeEnabled
                ? String(cooperativeGeneration)
                : undefined,
              PYTHONUNBUFFERED: "1",
            }),
          }, async (gatedChild) => {
            // Attach every observer before the token. A target that exits in
            // its first instruction cannot outrun logs/completion/thermal QA.
            this.consumeProcessLogs(job, gatedChild, progressTracker);
            completion = this.waitForProcess(gatedChild);
            resourceTelemetry = await this.startLtxResourceTelemetry(
              job,
              cooperativeGeneration,
              job.plan.executable,
              ltxArgs,
            );
            if (!await this.transitionDgxJob(job, "running", {
              current_step: cooperativeEnabled
                ? "ltx native pipeline running with cooperative Euler checkpoints"
                : "ltx native pipeline running",
            })) {
              throw new Error("DGX-Queue-Running-State wurde vor dem LTX-Exec nicht freigegeben.");
            }
            this.changed();
            boundaryWatcher.value = cooperativeEnabled
              ? this.watchSegmentBoundaries(
                  job,
                  checkpointRoot,
                  job.runProvenance!.fingerprint,
                  cooperativeGeneration,
                )
              : null;
            stopThermalWatcher = this.watchThermals(job, gatedChild, thermalBaselineC, {
              onPause: () => {
                if (resourceTelemetry) resourceTelemetry.thermalPauseCount += 1;
              },
            });
          });
        } catch (error) {
          const telemetrySettlement = await this.finishLtxResourceTelemetry(resourceTelemetry);
          stopThermalWatcher();
          await boundaryWatcher.value?.stop();
          await this.recordLtxResourceTelemetry(
            job,
            resourceTelemetry,
            telemetrySettlement,
            { code: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) },
            false,
            false,
            null,
          );
          if (this.jobShouldStop(job)) return;
          this.failJob(
            job,
            `LTX-Prozess blieb vor dem autorisierten Startgate: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
        const ltxResult = await (completion ?? this.waitForProcess(child));
        const settledResourceTelemetry = resourceTelemetry as ActiveLtxResourceTelemetry | null;
        let processGroupExitedNaturally = false;
        if (settledResourceTelemetry) {
          try {
            processGroupExitedNaturally = localProcessGroupIsGone(
              settledResourceTelemetry.binding.processIdentity,
            );
          } catch {
            // An unreadable natural-exit proof keeps this measurement ineligible;
            // confirmProcessGroupGone still owns mandatory cleanup below.
          }
        }
        const telemetrySettlement = await this.finishLtxResourceTelemetry(settledResourceTelemetry);
        stopThermalWatcher();
        await boundaryWatcher.value?.stop();
        let processGroupGone = false;
        try {
          await this.confirmProcessGroupGone(job, child);
          processGroupGone = true;
        } finally {
          await this.recordLtxResourceTelemetry(
            job,
            settledResourceTelemetry,
            telemetrySettlement,
            ltxResult,
            processGroupGone,
            processGroupExitedNaturally,
            processGroupGone ? ltxOutput : null,
          );
        }
        if (this.jobShouldStop(job)) {
          return;
        }

        if (!ltxResult.error && ltxResult.code === LTX_COOPERATIVE_YIELD_EXIT_CODE && cooperativeEnabled) {
          const artifact = this.validateCooperativeCheckpoint(
            job,
            checkpointManifest,
            boundaryWatcher.value?.yieldDecisionId() ?? null,
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
          const activationDecision = this.jobStartDecision(job);
          if (!activationDecision.allowed) {
            await this.failDgxJob(
              job,
              `Activation-/Rights-Gate blieb nach dem sicheren LTX-Checkpoint geschlossen: ${activationDecision.reason}`,
              "activation or rights revoked at cooperative LTX boundary",
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
      const thermalBaselineC = await this.readThermalBaseline(job, "LatentSync");
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
      job.status = "running";
      job.startedAt ??= now();
      let latentSyncCompletion: Promise<ProcessResult> | null = null;
      let stopLatentSyncThermals: () => void = () => undefined;
      const child = await this.spawnOwnedDockerRefiner(
        job,
        OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
        containerName,
        pythonExecutable,
        latentSyncArgs,
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            DGX_JOB_ID: job.dgxJobId ?? undefined,
            PYTHONUNBUFFERED: "1",
          },
        },
        async (gatedChild) => {
          this.consumeProcessLogs(job, gatedChild);
          latentSyncCompletion = this.waitForProcess(gatedChild);
          if (reusableBase && !await this.transitionDgxJob(job, "running", {
            current_step: "LatentSync 1.6 face refinement running on reused LTX base",
          })) {
            throw new Error("DGX-Queue-Running-State wurde für LatentSync nicht freigegeben.");
          }
          this.setDgxOwnerHeartbeatPhase(job, "latentsync_refinement");
        },
      );
      // Docker thermal control requires the immutable container ID. The
      // spawn helper returns only after that ID has been durably pinned.
      stopLatentSyncThermals = this.watchOwnedDockerThermals(
        job,
        child,
        thermalBaselineC,
        containerName,
        OWNED_DOCKER_THERMAL_WORKLOADS.latentSync,
      );
      const latentSyncResult = await (latentSyncCompletion ?? this.waitForProcess(child));
      stopLatentSyncThermals();
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
      const thermalBaselineC = await this.readThermalBaseline(job, "MuseTalk");
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
      job.status = "running";
      job.startedAt ??= now();
      let museTalkCompletion: Promise<ProcessResult> | null = null;
      let stopMuseTalkThermals: () => void = () => undefined;
      const child = await this.spawnOwnedDockerRefiner(
        job,
        OWNED_DOCKER_THERMAL_WORKLOADS.museTalk,
        containerName,
        pythonExecutable,
        museTalkArgs,
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            DGX_JOB_ID: job.dgxJobId ?? undefined,
            PYTHONUNBUFFERED: "1",
          },
        },
        async (gatedChild) => {
          this.consumeProcessLogs(job, gatedChild);
          museTalkCompletion = this.waitForProcess(gatedChild);
          if (reusableBase && !await this.transitionDgxJob(job, "running", {
            current_step: "MuseTalk 1.5 frame inpainting running on reused LTX base",
          })) {
            throw new Error("DGX-Queue-Running-State wurde für MuseTalk nicht freigegeben.");
          }
          this.setDgxOwnerHeartbeatPhase(job, "musetalk_refinement");
        },
      );
      stopMuseTalkThermals = this.watchOwnedDockerThermals(
        job,
        child,
        thermalBaselineC,
        containerName,
        OWNED_DOCKER_THERMAL_WORKLOADS.museTalk,
      );
      const museTalkResult = await (museTalkCompletion ?? this.waitForProcess(child));
      stopMuseTalkThermals();
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
      const pairedBaselineBinding = validRawOutputBaselineExperimentBinding(
        job.request,
        job.experiment,
      );
      const pairedCandidateRequest = pairedBaselineBinding
        ? rawMuxCandidateRequestFromBaseline(job.request, pairedBaselineBinding)
        : null;
      const pairedPaths = pairedBaselineBinding ? rawMuxPairPaths(stageRoot) : null;
      if (pairedBaselineBinding && (!pairedCandidateRequest || !pairedPaths || existsSync(pairedPaths.root))) {
        await this.failDgxJob(
          job,
          pairedCandidateRequest
            ? "Privates Raw-Mux-Paarverzeichnis existiert bereits; ein Teil- oder Wiederholungslauf wird nicht überschrieben."
            : "Kandidatenrequest konnte nicht deterministisch aus der Raw-Mux-Baseline abgeleitet werden.",
          "paired raw mux baseline precondition failed",
        );
        return;
      }
      const containerName = `ltx-lipforcing-${job.id}`;
      const thermalBaselineC = await this.readThermalBaseline(job, "LipForcing");
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
      const rawBaselineAtLipForcingStart = this.rawOutputBaselineImageAuthority(job);
      if (rawBaselineAtLipForcingStart.error
        || (rawBaselineAtLipForcingStart.evidence
          && !runProvenanceUsesExactLipForcingImage(
            job.runProvenance,
            rawBaselineAtLipForcingStart.evidence,
          ))) {
        const detail = rawBaselineAtLipForcingStart.error
          ?? "Containeridentität des frischen Baseline-Arms hat sich vor dem Kandidatenstart geändert.";
        this.failJob(job, detail);
        await this.transitionDgxJob(job, "failed", {
          current_step: "raw-output baseline authority changed before LipForcing start",
          last_error: detail,
        });
        return;
      }
      const lipForcingContainerIdentity = lipForcingImageIdentity(
        job.runProvenance?.containerImages,
      );
      if (!lipForcingContainerIdentity) {
        this.failJob(job, "LipForcing-Containeridentität fehlt unmittelbar vor dem Prozessstart.");
        await this.transitionDgxJob(job, "failed", {
          current_step: "immutable LipForcing container identity missing before start",
          last_error: "LipForcing-Containeridentität fehlt unmittelbar vor dem Prozessstart.",
        });
        return;
      }
      this.appendLog(
        job,
        "LipForcing 14B startet mit offizieller 512x512-Gesichtsausrichtung und audiogeführter "
          + "Zwei-Schritt-Diffusion. Kopfbewegung, Körper, Hintergrund und die exakte LTX-Zeitachse bleiben erhalten.",
      );
      if (pairedPaths) {
        try {
          lstatSync(refinedOutput);
          await this.failDgxJob(
            job,
            "Gepaarte Raw-Mux-Baseline überschreibt keine bestehende oder verlinkte Zielausgabe.",
            "paired raw mux baseline output already exists",
          );
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            await this.failDgxJob(
              job,
              `Gepaarte Baseline-Zielausgabe konnte nicht sicher auf Abwesenheit geprüft werden: ${
                error instanceof Error ? error.message : String(error)
              }`,
              "paired raw mux baseline output absence check failed",
            );
            return;
          }
        }
      } else {
        rmSync(refinedOutput, { force: true });
      }
      const lipForcingArgs = [
        lipForcingScript,
        "--video", lipForcingInput,
        "--output", refinedOutput,
        "--stage-root", stageRoot,
        "--model-root", lipForcingModelRoot,
        "--insightface-root", latentSyncInsightFaceRoot,
        "--image", lipForcingContainerIdentity.executionReference,
        "--container-name", containerName,
        "--decoder", job.request.postprocess.lipForcing.decoder,
        "--raw-output-profile", job.request.postprocess.lipForcing.rawOutputProfile,
        "--mouth-delay-ms", String(job.request.postprocess.lipForcing.mouthDelayMs),
        "--program-audio-delay-ms", String(job.request.postprocess.lipForcing.programAudioDelayMs),
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
      if (pairedPaths) {
        lipForcingArgs.push("--paired-raw-experiment-dir", pairedPaths.root);
        this.appendLog(
          job,
          "Gepaarter Raw-Mux-v1-Lauf aktiv: ein gemeinsamer CRF13-Pre-Mux erzeugt den privaten A/B-Arm; nur die Baseline wird jetzt publiziert.",
        );
      }
      job.status = "running";
      job.startedAt ??= now();
      let lipForcingCompletion: Promise<ProcessResult> | null = null;
      let stopLipForcingThermals: () => void = () => undefined;
      const child = await this.spawnOwnedDockerRefiner(
        job,
        OWNED_DOCKER_THERMAL_WORKLOADS.lipForcing,
        containerName,
        pythonExecutable,
        lipForcingArgs,
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            DGX_JOB_ID: job.dgxJobId ?? undefined,
            PYTHONUNBUFFERED: "1",
          },
        },
        async (gatedChild) => {
          this.consumeProcessLogs(job, gatedChild);
          lipForcingCompletion = this.waitForProcess(gatedChild);
          if (reusableBase && !await this.transitionDgxJob(job, "running", {
            current_step: "LipForcing 14B refinement running on reused LTX base",
          })) {
            throw new Error("DGX-Queue-Running-State wurde für LipForcing nicht freigegeben.");
          }
          this.setDgxOwnerHeartbeatPhase(job, "lipforcing_refinement");
        },
      );
      stopLipForcingThermals = this.watchOwnedDockerThermals(
        job,
        child,
        thermalBaselineC,
        containerName,
        OWNED_DOCKER_THERMAL_WORKLOADS.lipForcing,
      );
      const lipForcingResult = await (lipForcingCompletion ?? this.waitForProcess(child));
      stopLipForcingThermals();
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
      if (pairedBaselineBinding && pairedCandidateRequest && pairedPaths) {
        try {
          const authority = createRawMuxBaselineAuthority({
            paths: pairedPaths,
            baselineFinalPath: refinedOutput,
            experimentId: pairedBaselineBinding.experimentId,
            protocolSha256: pairedBaselineBinding.protocolSha256,
            baselineJobId: job.id,
            baselineOutputName: job.outputName,
            baselineRequestSha256: pairedBaselineBinding.baselineRequestSha256,
            candidateRequestSha256: experimentRequestSha256V1(pairedCandidateRequest),
            containerImageFingerprint: lipForcingContainerIdentity.fingerprint,
            mouthDelayMs: job.request.postprocess.lipForcing.mouthDelayMs,
            programAudioDelayMs: job.request.postprocess.lipForcing.programAudioDelayMs,
          });
          if (!await this.bindJobRunProvenanceFile(
            job,
            pairedPaths.authority,
            "private:lipforcing-raw-mux-pair-v1",
          )) return;
          if (!await this.verifyJobRunProvenance(job, "nach dem privaten Raw-Mux-Paar-Seal")) {
            throw new Error("Raw-Mux-Paar-Manifest konnte vor der Baseline-Publikation nicht verifiziert werden.");
          }
          const sealed = readVerifiedRawMuxBaselineAuthority(pairedPaths, {
            experimentId: authority.experimentId,
            protocolSha256: authority.protocolSha256,
            baselineJobId: authority.baselineJobId,
            baselineOutputName: authority.baselineOutputName,
            baselineRequestSha256: authority.baselineRequestSha256,
            candidateRequestSha256: authority.candidateRequestSha256,
            containerImageFingerprint: authority.containerImageFingerprint,
            baselineFinalPath: refinedOutput,
            mouthDelayMs: authority.mouthDelayMs,
            programAudioDelayMs: authority.programAudioDelayMs,
          });
          if (!sealed || sealed.authority.fingerprint !== authority.fingerprint) {
            throw new Error("Raw-Mux-Paar-Authority driftete unmittelbar nach Provenienzbindung.");
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          try {
            const quarantinePath = quarantineRestoredUnpublishedArtifact(
              refinedOutput,
              stageRoot,
              this.outputAuthorityReconciliationOperations,
            );
            if (quarantinePath) {
              this.appendLog(
                job,
                `Markerlose gepaarte Baseline wurde nach fehlgeschlagenem Authority-Seal nach ${quarantinePath} verschoben.`,
              );
            }
          } catch (quarantineError) {
            this.appendLog(
              job,
              `Markerlose gepaarte Baseline konnte nicht vollständig bereinigt werden: ${
                quarantineError instanceof Error ? quarantineError.message : String(quarantineError)
              }`,
            );
          }
          await this.failDgxJob(
            job,
            `Gepaarte Raw-Mux-Baseline konnte nicht fail-closed versiegelt werden: ${detail}`,
            "paired raw mux baseline sealing failed",
          );
          return;
        }
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
        if (!this.persistenceHold) rmSync(remuxPath, { force: true });
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
    const outputReleaseDecision = this.jobStartDecision(job);
    if (!outputReleaseDecision.allowed) {
      try {
        const quarantinePath = quarantineUnreleasedArtifact(job.plan.outputPath, stageRoot);
        if (quarantinePath) {
          this.appendLog(job, `Nicht freigegebene Ausgabe wurde aus der öffentlichen Output-Bibliothek nach ${quarantinePath} verschoben.`);
        }
      } catch (error) {
        rmSync(job.plan.outputPath, { force: true });
        this.appendLog(
          job,
          `Nicht freigegebene Ausgabe konnte nicht sicher quarantänisiert werden und wurde entfernt: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await this.failDgxJob(
        job,
        `Ausgabe bleibt wegen des aktuellen Activation-/Rights-Gates unveröffentlicht: ${outputReleaseDecision.reason}`,
        "activation or rights gate failed before output release",
      );
      return;
    }
    if (!this.hasOutputReleaseAuthority(job, "der finalen Ausgabe-Publikation")) {
      if (!this.persistenceHold) {
        try {
          quarantineUnreleasedArtifact(job.plan.outputPath, stageRoot);
        } catch {
          rmSync(job.plan.outputPath, { force: true });
        }
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
    const completedAt = now();
    let publicationAuthority: OutputPublicationAuthority;
    try {
      this.revalidateRuntimeTrustBoundary(job, "Ausgabe-Publikationsvorbereitung");
      this.promotePrivateOutput(job.plan.outputPath, job.plan.outputPath);
      // Hashing a large output is synchronous. Build the authority while the
      // job is still active, then re-check heartbeat freshness afterwards.
      publicationAuthority = this.buildPublicationAuthority(job, completedAt);
    } catch (error) {
      if (isJobPersistenceHoldError(error)) {
        process.stderr.write(
          "LTX Studio Publikationsvorbereitung bleibt im Persistenz-HOLD unverändert und nicht öffentlich; Restart-Recovery entscheidet.\n",
        );
        throw error;
      }
      removeOutputPublicationAuthority(job.plan.outputPath);
      const publicationQuarantineRoot = join(hybridRoot, job.id);
      quarantineUnreleasedArtifact(job.plan.outputPath, publicationQuarantineRoot);
      this.failJob(
        job,
        `Ausgabe konnte nicht sicher für die atomare Publikation vorbereitet werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!this.hasOutputReleaseAuthority(job, "dem finalen Publikations-Commit")) {
      if (!this.persistenceHold) {
        quarantineUnreleasedArtifact(job.plan.outputPath, join(hybridRoot, job.id));
      }
      return;
    }
    const successLog = latentSyncEnabled
        ? "Video mit LatentSync-Gesichtsrefiner erfolgreich erzeugt."
        : museTalkEnabled
        ? "Video mit MuseTalk-1.5-Lippen-Inpainting erfolgreich erzeugt."
        : lipForcingEnabled
        ? "Video mit LipForcing-14B-Lippenrefiner erfolgreich erzeugt."
        : hybridEnabled
        ? "Hybridvideo erfolgreich erzeugt; LTX-Basis und LongCat-Mundspur bleiben als Zwischenstände erhalten."
        : job.request.mode === "text-to-audio"
          ? "Audio erfolgreich erzeugt."
          : "Video erfolgreich erzeugt.";
    if (!this.commitPreparedPublication(
      job,
      publicationAuthority,
      completedAt,
      completionMetadata,
      successLog,
      "Ausgabe konnte nicht atomar und dauerhaft publiziert werden",
      join(hybridRoot, job.id),
    )) return;
    await this.flushDgxTerminalDelivery(job);
  }

  private async startLtxResourceTelemetry(
    job: RuntimeJob,
    cooperativeGeneration: number,
    executable: string,
    args: readonly string[],
  ): Promise<ActiveLtxResourceTelemetry | null> {
    const estimate = estimateRequest(job.request, [...this.jobs.values()]);
    const memoryBasis = estimate.memoryBasis;
    if (memoryBasis !== LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_BASIS) return null;

    const lease = requireDgxLeaseAuthority(job);
    const identity = job.localProcessGroupIdentity;
    const provenance = job.runProvenance;
    if (!identity
      || !provenance
      || !runProvenanceFingerprintMatches(provenance)
      || job.authorityRequestSha256 !== createHash("sha256")
        .update(canonicalJson(job.authorityBoundRequest))
        .digest("hex")
      || lease.preparedAdmissionSha256 !== preparedAdmissionSha256(lease.preparedAdmission)
      || lease.preparedAdmission.estimated_memory_gib !== estimate.memoryGiB
      || lease.preparedAdmission.resource_profile.required_gib !== estimate.memoryGiB) {
      throw new Error(
        "Peak-RAM-Telemetrie verweigert die Gate-Freigabe: Request-, Provenienz-, Prozessgruppen- oder Admission-Bindung ist nicht exakt.",
      );
    }

    const evidenceDirectory = join(
      dirname(this.storagePath),
      "resource-telemetry",
      job.id,
      `ltx-g${cooperativeGeneration}`,
    );
    const recorder = this.createLocalProcessResourceTelemetry({
      identity,
      evidenceDirectory,
    });
    const binding: LtxResourceTelemetryBinding = {
      studioJobId: job.id,
      dgxJobId: lease.dgxJobId,
      preparedAdmissionSha256: lease.preparedAdmissionSha256,
      declaredMemoryGiB: lease.preparedAdmission.estimated_memory_gib,
      requiredMemoryGiB: lease.preparedAdmission.resource_profile.required_gib,
      memoryBasis,
      requestSha256: job.authorityRequestSha256,
      runProvenanceFingerprint: provenance.fingerprint,
      runProvenanceSha256: createHash("sha256").update(canonicalJson(provenance)).digest("hex"),
      cooperativeGeneration,
      executable,
      argumentsSha256: createHash("sha256").update(canonicalJson(args)).digest("hex"),
      processIdentity: structuredClone(identity),
      observerIdentity: structuredClone(recorder.observerIdentity),
    };
    let initialSample: LocalProcessResourceSample;
    try {
      initialSample = recorder.capture();
    } catch (error) {
      throw new Error(
        `Peak-RAM-Telemetrie konnte ihre erste Probe nicht dauerhaft vor dem Starttoken sichern: ${
          boundedResourceTelemetryError(error)
        }`,
      );
    }

    const initialError = initialSample.sourceErrors.length > 0
      || !initialSample.identityVerified
      || !initialSample.processGroup.attributionVerified
      || initialSample.processGroup.accountedResidentKiB === null
      ? "Die erste Peak-RAM-Probe ist nicht vollständig und eindeutig der gebundenen Prozessgruppe zurechenbar."
      : null;
    if (initialError) {
      let receipt: LocalProcessResourceTelemetryReceipt | null = null;
      let observerError = initialError;
      try {
        receipt = recorder.finalize();
      } catch (error) {
        observerError += ` Summary-Persistenz: ${boundedResourceTelemetryError(error)}`;
      }
      const failedActive: ActiveLtxResourceTelemetry = {
        binding,
        controller: new AbortController(),
        evidenceDirectory,
        thermalPauseCount: 0,
        settlement: Promise.resolve({ receipt, observerError }),
      };
      // Even an observer failure before FD3 release is an immutable attempt.
      // Route it through the same verifier and parent-provenance binding as a
      // completed process, while keeping the still-gated group explicitly
      // ineligible. The outer spawn gate remains responsible for termination.
      await this.recordLtxResourceTelemetry(
        job,
        failedActive,
        { receipt, observerError },
        { code: null, signal: null, error: new Error(initialError) },
        false,
        false,
        null,
      );
      throw new Error(`Peak-RAM-Telemetrie hält das Startgate geschlossen: ${observerError}`);
    }

    this.appendLog(
      job,
      `Peak-RAM-Beobachter aktiv: erste Prozessgruppenprobe ist vor dem Starttoken fsync-persistiert; Basis ${memoryBasis}.`,
    );
    this.changed();
    const controller = new AbortController();
    const settlement = recorder.run(controller.signal).then<
      LtxResourceTelemetrySettlement,
      LtxResourceTelemetrySettlement
    >(
      (receipt) => ({ receipt, observerError: null }),
      (error) => {
        let receipt: LocalProcessResourceTelemetryReceipt | null = null;
        let observerError = boundedResourceTelemetryError(error);
        try {
          receipt = recorder.finalize();
        } catch (finalizeError) {
          observerError += `; Summary-Persistenz: ${boundedResourceTelemetryError(finalizeError)}`;
        }
        return { receipt, observerError };
      },
    );
    return { binding, controller, evidenceDirectory, thermalPauseCount: 0, settlement };
  }

  private async finishLtxResourceTelemetry(
    active: ActiveLtxResourceTelemetry | null,
  ): Promise<LtxResourceTelemetrySettlement | null> {
    if (!active) return null;
    active.controller.abort();
    return active.settlement;
  }

  private async persistLtxResourceTelemetryManifest(
    active: ActiveLtxResourceTelemetry,
    settlement: LtxResourceTelemetrySettlement,
    result: ProcessResult,
    processGroupGone: boolean,
    processGroupExitedNaturally: boolean,
    outputPath: string | null,
  ): Promise<{
    manifest: LtxResourceTelemetryManifest;
    manifestPath: string;
    manifestSha256: string;
  }> {
    let observerError = settlement.observerError;
    let output: LtxResourceTelemetryManifest["output"] = null;
    if (processGroupGone && !result.error && result.code === 0 && outputPath && this.fileReady(outputPath)) {
      try {
        output = captureLtxResourceTelemetryOutput(outputPath);
      } catch (error) {
        observerError = [observerError, `Ausgabebindung: ${boundedResourceTelemetryError(error)}`]
          .filter(Boolean)
          .join("; ");
      }
    }
    const telemetry = settlement.receipt ? {
      jsonlPath: settlement.receipt.jsonlPath,
      jsonlSha256: settlement.receipt.jsonlSha256,
      summaryPath: settlement.receipt.summaryPath,
      summarySha256: settlement.receipt.summarySha256,
      summary: settlement.receipt.summary,
    } : null;
    const measurementBlockers = ltxResourceTelemetryMeasurementBlockers({
      binding: active.binding,
      summary: telemetry?.summary ?? null,
      observerError,
      result,
      processGroupGone,
      processGroupExitedNaturally,
      thermalPauseCount: active.thermalPauseCount,
      outputBound: output !== null,
      outputTechnicalValid: output?.technical.blockers.length === 0,
    });
    const measurementEligibleForCalibration = telemetry?.summary.quality === "sufficient"
      && measurementBlockers.length === 0;
    const unsignedManifest = {
      schemaVersion: "ltx-studio-ltx-resource-telemetry-manifest.v1" as const,
      binding: active.binding,
      telemetry,
      observerError,
      processOutcome: {
        code: result.code,
        signal: result.signal,
        error: result.error ? boundedResourceTelemetryError(result.error) : null,
      },
      processGroupGone,
      processGroupExitedNaturally,
      thermalPauseCount: active.thermalPauseCount,
      output,
      measurementEligibleForCalibration,
      recordedAt: now(),
    };
    const manifest: LtxResourceTelemetryManifest = {
      ...unsignedManifest,
      fingerprint: createHash("sha256").update(canonicalJson(unsignedManifest)).digest("hex"),
    };
    const manifestPath = join(active.evidenceDirectory, LTX_RESOURCE_TELEMETRY_MANIFEST_BASENAME);
    exclusiveDurableJsonFile(manifestPath, manifest);
    const verified = verifyLtxResourceTelemetryEvidence(manifestPath, {
      expectedBinding: active.binding,
      ...(output ? { expectedOutputPath: output.path } : {}),
    });
    if (canonicalJson(verified.manifest) !== canonicalJson(manifest)) {
      throw new Error("Verifiziertes Peak-RAM-Manifest weicht vom gebundenen Manifest ab.");
    }
    return {
      manifest: verified.manifest,
      manifestPath,
      manifestSha256: verified.manifestSha256,
    };
  }

  private async recordLtxResourceTelemetry(
    job: RuntimeJob,
    active: ActiveLtxResourceTelemetry | null,
    settlement: LtxResourceTelemetrySettlement | null,
    result: ProcessResult,
    processGroupGone: boolean,
    processGroupExitedNaturally: boolean,
    outputPath: string | null,
  ): Promise<void> {
    if (!active || !settlement) return;
    try {
      const evidence = await this.persistLtxResourceTelemetryManifest(
        active,
        settlement,
        result,
        processGroupGone,
        processGroupExitedNaturally,
        outputPath,
      );
      const summary = evidence.manifest.telemetry?.summary;
      const peakKiB = summary?.metrics.processGroup.maximumAccountedResidentKiB ?? null;
      const minimumAvailableKiB = summary?.metrics.host.minimumMemAvailableKiB ?? null;
      const minimumFreeKiB = summary?.metrics.host.minimumMemFreeKiB ?? null;
      const parentProvenance = job.runProvenance;
      if (!parentProvenance
        || !runProvenanceFingerprintMatches(parentProvenance)
        || parentProvenance.fingerprint !== active.binding.runProvenanceFingerprint
        || createHash("sha256").update(canonicalJson(parentProvenance)).digest("hex")
          !== active.binding.runProvenanceSha256) {
        throw new Error("Peak-RAM-Manifest kann nicht an seine unveränderte Eltern-Laufprovenienz gebunden werden.");
      }
      const evidenceRole = `evidence:resource-telemetry:g${active.binding.cooperativeGeneration}`;
      if (!await this.bindJobRunProvenanceFile(job, evidence.manifestPath, evidenceRole)) {
        throw new Error("Peak-RAM-Manifest wurde vor seiner Laufprovenienzbindung abgebrochen.");
      }
      const boundProvenance = job.runProvenance;
      const boundFiles = boundProvenance?.files.filter((file) => file.role === evidenceRole) ?? [];
      if (!boundProvenance
        || !runProvenanceFingerprintMatches(boundProvenance)
        || boundFiles.length !== 1
        || boundFiles[0].kind !== "file"
        || boundFiles[0].path !== evidence.manifestPath
        || boundFiles[0].sha256 !== evidence.manifestSha256) {
        throw new Error("Peak-RAM-Manifest fehlt nach der Bindung in der exakten Laufprovenienz.");
      }
      const verifiedAfterBinding = verifyLtxResourceTelemetryEvidence(evidence.manifestPath, {
        expectedBinding: active.binding,
        ...(evidence.manifest.output ? { expectedOutputPath: evidence.manifest.output.path } : {}),
      });
      if (verifiedAfterBinding.manifestSha256 !== evidence.manifestSha256) {
        throw new Error("Peak-RAM-Manifest änderte sich während seiner Laufprovenienzbindung.");
      }
      if (evidence.manifest.measurementEligibleForCalibration && peakKiB !== null) {
        this.appendLog(
          job,
          `Peak-RAM-Einzelmessung kryptografisch verifiziert und an die Laufprovenienz gebunden: `
            + `${(peakKiB / 1_048_576).toFixed(2)} GiB konservative Prozessgruppen-Hüllkurve; Host-Minimum ${
              minimumAvailableKiB === null ? "unbekannt" : `${(minimumAvailableKiB / 1_048_576).toFixed(2)} GiB`
            }; MemFree-Minimum ${
              minimumFreeKiB === null ? "unbekannt" : `${(minimumFreeKiB / 1_048_576).toFixed(2)} GiB`
            }; Swap-In/Out ${String(summary?.metrics.host.pswpinDeltaPages ?? "unbekannt")}/`
            + `${String(summary?.metrics.host.pswpoutDeltaPages ?? "unbekannt")} Seiten; `
            + `Manifest ${evidence.manifestSha256} unter ${evidence.manifestPath}; `
            + "keine automatische RAM-Absenkung aus einem einzelnen Lauf.",
        );
      } else {
        const blockers = ltxResourceTelemetryMeasurementBlockers({
          binding: active.binding,
          summary: summary ?? null,
          observerError: evidence.manifest.observerError,
          result,
          processGroupGone,
          processGroupExitedNaturally,
          thermalPauseCount: active.thermalPauseCount,
          outputBound: evidence.manifest.output !== null,
          outputTechnicalValid: evidence.manifest.output?.technical.blockers.length === 0,
        });
        this.appendLog(
          job,
          "Peak-RAM-Telemetrie unzureichend; beobachtete Werte sind nur Untergrenzen und kalibrieren die RAM-Prognose nicht"
            + `${blockers.length > 0 ? ` (${blockers.join(", ")})` : ""}. `
            + `Manifest ${evidence.manifestSha256} ist als ${evidenceRole} an die Laufprovenienz gebunden `
            + `und liegt unter ${evidence.manifestPath}.`,
        );
      }
      this.changed();
    } catch (error) {
      this.appendLog(
        job,
        "Peak-RAM-Telemetrie unzureichend; die Beweispersistenz scheiterte und darf die RAM-Prognose nicht kalibrieren: "
          + boundedResourceTelemetryError(error),
      );
      this.changed();
    }
  }

  private fileReady(path: string): boolean {
    try {
      const stats = statSync(path);
      return stats.isFile() && stats.size > 0;
    } catch {
      return false;
    }
  }

  private terminalizeCpuOperation(
    job: RuntimeJob,
    state: Exclude<CpuOperationState, "prepared" | "running">,
    result: ProcessResult,
    output: ExecutionFileBinding | null,
    errorDetail: string | null,
    receipt: ExecutionFileBinding | null = null,
  ): boolean {
    const decision = normalizeJobExecutionDecision(job.executionDecision);
    if (!decision || decision.executionClass !== "cpu-only") {
      this.failJob(job, "Persistierte CPU-Ausführungsentscheidung fehlt beim terminalen Operationsresultat.");
      return false;
    }
    if (["succeeded", "failed", "cancelled", "interrupted"].includes(decision.operation.state)) {
      return decision.operation.state === state
        && JSON.stringify(decision.operation.output) === JSON.stringify(output)
        && (decision.operation.kind !== "ffmpeg-audio-retime-v2"
          || JSON.stringify(decision.operation.receipt) === JSON.stringify(receipt));
    }
    const errorText = errorDetail ?? result.error?.message ?? null;
    const terminalOperation = {
      ...decision.operation,
      state,
      completedAt: now(),
      exitCode: result.code,
      signal: result.signal,
      errorSha256: errorText === null
        ? null
        : createHash("sha256").update(errorText).digest("hex"),
      output,
      ...(decision.operation.kind === "ffmpeg-audio-retime-v2" ? { receipt } : {}),
    };
    const completedDecision = {
      ...decision,
      operation: terminalOperation,
    } as JobExecutionDecision;
    return this.commitExecutionDecision(job, completedDecision);
  }

  private promotePrivateOutput(sourcePath: string, outputPath: string): void {
    removeOutputPublicationAuthority(outputPath);
    if (sourcePath !== outputPath) renameSync(sourcePath, outputPath);
    const outputDescriptor = openSync(outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      fsyncSync(outputDescriptor);
    } finally {
      closeSync(outputDescriptor);
    }
    const outputDirectoryDescriptor = openSync(dirname(outputPath), "r");
    try {
      fsyncSync(outputDirectoryDescriptor);
    } finally {
      closeSync(outputDirectoryDescriptor);
    }
    if (dirname(sourcePath) !== dirname(outputPath)) {
      const sourceDirectoryDescriptor = openSync(dirname(sourcePath), "r");
      try {
        fsyncSync(sourceDirectoryDescriptor);
      } finally {
        closeSync(sourceDirectoryDescriptor);
      }
    }
  }

  private buildPublicationAuthority(
    job: RuntimeJob,
    publishedAt: string,
  ): OutputPublicationAuthority {
    const decision = normalizeJobExecutionDecision(job.executionDecision);
    if (!canonicalIsoTimestamp(publishedAt)
      || !decision
      || decision.executionClass === "pending") {
      throw new Error("Publikation ohne geplanten Terminalzeitpunkt und persistierte ExecutionDecision verweigert.");
    }
    const executionDecisionSha256 = createHash("sha256").update(canonicalJson(decision)).digest("hex");
    const jobPersistenceRevision = randomUUID();
    const jobAuthoritySha256 = terminalJobAuthoritySha256({
      jobId: job.id,
      status: "completed",
      outputName: job.outputName,
      finishedAt: publishedAt,
      executionClass: decision.executionClass,
      executionDecisionSha256,
      requestSha256: decision.requestSha256,
      protocolSha256: decision.protocolSha256,
      jobPersistenceRevision,
    });
    return prepareOutputPublicationAuthority(job.plan.outputPath, {
      jobId: job.id,
      publishedAt,
      executionDecisionSha256,
      jobPersistenceRevision,
      jobAuthoritySha256,
    });
  }

  private persistPublicationAuthority(job: RuntimeJob): void {
    const decision = normalizeJobExecutionDecision(job.executionDecision);
    const pending = normalizeOutputPublicationCommitPending(job.outputPublicationCommitPending);
    const expected = job.outputPublication
      ? normalizeOutputPublicationAuthority(job.outputPublication, job.plan.outputPath)
      : null;
    if (!isActiveJobStatus(job.status)
      || !job.finishedAt
      || !pending
      || pending.completedAt !== job.finishedAt
      || !decision
      || decision.executionClass === "pending"
      || !expected
      || expected.jobId !== job.id
      || expected.publishedAt !== job.finishedAt) {
      throw new Error("Publikation ohne dauerhaft vorbereitete lokale Commit- und ExecutionDecision-Autorität verweigert.");
    }
    const decisionSha256 = createHash("sha256").update(canonicalJson(decision)).digest("hex");
    const jobAuthoritySha256 = terminalJobAuthoritySha256({
      jobId: job.id,
      status: "completed",
      outputName: job.outputName,
      finishedAt: job.finishedAt,
      executionClass: decision.executionClass,
      executionDecisionSha256: decisionSha256,
      requestSha256: decision.requestSha256,
      protocolSha256: decision.protocolSha256,
      jobPersistenceRevision: expected.jobPersistenceRevision,
    });
    if (expected.executionDecisionSha256 !== decisionSha256
      || expected.jobAuthoritySha256 !== jobAuthoritySha256) {
      throw new Error("Persistierte Jobautorität driftete vor der Marker-Persistenz.");
    }
    const authority = persistOutputPublicationAuthority(job.plan.outputPath, {
      jobId: job.id,
      publishedAt: job.finishedAt,
      executionDecisionSha256: decisionSha256,
      jobPersistenceRevision: expected.jobPersistenceRevision,
      jobAuthoritySha256,
    }, {}, expected, () => this.assertPublicationMarkerReleaseAuthority(job));
    if (decision.executionClass === "cpu-only"
      && (decision.operation.state !== "succeeded"
        || !decision.operation.output
        || decision.operation.output.sha256 !== authority.output.sha256)) {
      removeOutputPublicationAuthority(job.plan.outputPath);
      throw new Error("Publizierte Bytes widersprechen dem terminalen CPU-Operationsresultat.");
    }
  }

  private commitPreparedPublication(
    job: RuntimeJob,
    publicationAuthority: OutputPublicationAuthority,
    completedAt: string,
    completionMetadata: DgxTransitionMetadata,
    successLog: string,
    failureMessage: string,
    quarantineRoot: string,
  ): boolean {
    if (!isActiveJobStatus(job.status)
      || job.dgxTerminalDelivery
      || job.dgxTerminalReceipt
      || job.dgxJobTerminal
      || job.outputPublicationCommitPending
      || job.outputPublication) {
      throw new Error("Publikationscommit startete ohne aktive, terminal-intent-freie Jobautorität.");
    }
    const normalized = normalizeOutputPublicationCommitPending({
      schemaVersion: "ltx-studio-output-publication-commit.v1",
      completedAt,
      completionMetadata,
    });
    if (!normalized) throw new Error("Publikationscommit-Metadaten sind nicht kanonisch.");

    const previousFinishedAt = job.finishedAt;
    const previousLogs = [...job.logs];
    const previousDgxMemoryWait = job.dgxMemoryWait
      ? structuredClone(job.dgxMemoryWait)
      : null;
    job.finishedAt = completedAt;
    job.dgxMemoryWait = null;
    job.outputPublication = publicationAuthority;
    job.outputPublicationCommitPending = normalized;
    this.appendLog(
      job,
      "Ausgabe lokal dauerhaft zum Marker-Commit vorbereitet; DGX completed ist bis nach dem Marker-Fsync gesperrt.",
    );
    // Crash before/inside this commit leaves the previous active snapshot and
    // no remote completed intent. Crash after it is recovered from the exact
    // prepared authority plus marker presence.
    try {
      this.changed();
    } catch (error) {
      if (isJobPersistenceHoldError(error)) {
        // The prepared snapshot may already be the only durable authority.
        // Preserve the exact in-memory claim for restart reconciliation and
        // never remove bytes or a marker while durability is ambiguous.
        throw error;
      }

      // commitManagedSnapshot returns a non-HOLD error only after proving that
      // the target still contains the pre-attempt snapshot. Undo every RAM-only
      // preparation mutation, including its diagnostic, before terminalizing.
      delete job.outputPublicationCommitPending;
      delete job.outputPublication;
      job.finishedAt = previousFinishedAt;
      job.logs = previousLogs;
      job.dgxMemoryWait = previousDgxMemoryWait;
      const cleanupErrors: unknown[] = [];
      try {
        removeOutputPublicationAuthority(job.plan.outputPath);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        quarantineUnreleasedArtifact(job.plan.outputPath, quarantineRoot);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        const cleanupSummary = cleanupErrors
          .map((cleanupError) => cleanupError instanceof Error ? cleanupError.message : String(cleanupError))
          .join("; ");
        throw this.enterPersistenceHold(
          new AggregateError(
            [error, ...cleanupErrors],
            `Prepared-Publikationsrollback blieb mehrdeutig: ${cleanupSummary}`,
          ),
          "nicht dauerhaft vorbereitete Publikationsbytes konnten nicht beweiskräftig widerrufen werden",
        );
      }
      this.failJob(
        job,
        `${failureMessage}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    try {
      this.persistPublicationAuthority(job);
    } catch (error) {
      if (isJobPersistenceHoldError(error)) {
        process.stderr.write(
          "LTX Studio Publikationsmarker bleibt im Persistenz-HOLD; kein Remote-completed wurde vorgemerkt.\n",
        );
        throw error;
      }

      // Revoke the in-memory prepared claim before any cleanup that can throw.
      // Thus neither the outer pump nor failJob can inherit a stale completed intent.
      delete job.outputPublicationCommitPending;
      delete job.outputPublication;
      job.finishedAt = previousFinishedAt;
      const cleanupErrors: unknown[] = [];
      try {
        removeOutputPublicationAuthority(job.plan.outputPath);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        quarantineUnreleasedArtifact(job.plan.outputPath, quarantineRoot);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (cleanupErrors.length > 0) {
        throw this.enterPersistenceHold(
          new AggregateError([error, ...cleanupErrors], "Publikationsrollback blieb mehrdeutig."),
          "fehlgeschlagener Publikationsmarker konnte nicht beweiskräftig widerrufen werden",
        );
      }
      this.failJob(
        job,
        `${failureMessage}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }

    // Only a fully fsync-backed, final-fence-checked marker may unlock local
    // completion and the first durable remote-completed intent.
    delete job.outputPublicationCommitPending;
    job.status = "completed";
    job.progress = 100;
    job.outputUrl = `/api/jobs/${job.id}/output`;
    job.finishedAt = completedAt;
    if (job.startedAt) job.runtimeMs = Date.now() - Date.parse(job.startedAt);
    this.prepareDgxTerminalDelivery(job, "completed", normalized.completionMetadata);
    this.appendLog(job, successLog);
    try {
      this.changed();
    } catch (firstError) {
      if (isJobPersistenceHoldError(firstError)) throw firstError;
      // A proven pre-rename failure leaves the durable prepared snapshot and
      // marker intact. Retry the identical completed+delivery snapshot once;
      // if that also cannot commit, enter HOLD before any public request or
      // remote-completed mutation can interleave.
      try {
        this.changed();
      } catch (retryError) {
        if (isJobPersistenceHoldError(retryError)) throw retryError;
        throw this.enterPersistenceHold(
          new AggregateError(
            [firstError, retryError],
            "Finaler completed-Snapshot blieb nach beweisbaren Pre-Rename-Fehlern ungeschrieben.",
          ),
          "lokale Completion und Remote-completed-Intent konnten nach dem Marker nicht dauerhaft gemeinsam committed werden",
        );
      }
    }
    try {
      this.archivePublishedJob(job);
    } catch (error) {
      if (isJobPersistenceHoldError(error)) throw error;
      throw this.enterPersistenceHold(
        error,
        "publizierte Ausgabe konnte nicht in das dauerhafte Authority-Archiv übernommen werden",
      );
    }
    return true;
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

  private verifyPairedPromotionRunProvenance(
    job: RuntimeJob,
    source: CpuPairedArtifactReuseSourceBinding,
    baselineProvenanceFingerprint: string,
    context: string,
  ): boolean {
    if (!job.runProvenance || !runProvenanceFingerprintMatches(job.runProvenance)) {
      this.failJob(job, `Historische Paar-Promotionsprovenienz ${context} fehlt oder ihr Fingerprint driftete.`);
      return false;
    }
    if (source.sourceProvenanceFingerprint !== baselineProvenanceFingerprint) {
      this.failJob(
        job,
        `Historische Baseline-Provenienz ${context} stimmt nicht mit der gepinnten Paarquelle überein.`,
      );
      return false;
    }
    const snapshotPairs = [
      [source.authority, source.snapshotAuthority],
      [source.receipt, source.snapshotReceipt],
      [source.timelineReceipt, source.snapshotTimelineReceipt],
      [source.preMux, source.snapshotPreMux],
      [source.preMuxReceipt, source.snapshotPreMuxReceipt],
      [source.candidateFinal, source.snapshotCandidateFinal],
    ] as const;
    for (const [original, snapshot] of snapshotPairs) {
      if (original.sha256 !== snapshot.sha256
        || original.revision.sizeBytes !== snapshot.revision.sizeBytes
        || canonicalJson(captureRawMuxPairFile(snapshot.path)) !== canonicalJson(snapshot)) {
        this.failJob(job, `Privater Paar-Snapshot ${context} ist nicht mehr exakt an seine verifizierte Baselinequelle gebunden.`);
        return false;
      }
    }
    const required = [
      ["input:raw-mux-pair-authority", source.snapshotAuthority],
      ["input:raw-mux-pair-receipt", source.snapshotReceipt],
      ["input:raw-mux-timeline-receipt", source.snapshotTimelineReceipt],
      ["input:raw-mux-pair-premux", source.snapshotPreMux],
      ["input:raw-mux-premux-receipt", source.snapshotPreMuxReceipt],
      ["input:raw-mux-paired-candidate-final", source.snapshotCandidateFinal],
    ] as const;
    for (const [role, binding] of required) {
      const evidence = job.runProvenance.files.filter((file) => file.role === role);
      if (evidence.length !== 1
        || evidence[0].kind !== "file"
        || evidence[0].path !== binding.path
        || evidence[0].sha256 !== binding.sha256
        || evidence[0].sizeBytes !== binding.revision.sizeBytes
        || evidence[0].modifiedAtMs !== binding.revision.modifiedAtMs
        || evidence[0].changedAtMs !== binding.revision.changedAtMs
        || evidence[0].fileId !== binding.revision.fileId) {
        this.failJob(job, `Privates Paar-Promotionsartefakt ${role} ${context} ist nicht exakt gebunden.`);
        return false;
      }
    }
    job.runProvenance = { ...job.runProvenance, verifiedAt: now() };
    this.appendLog(
      job,
      `Historische Baseline- und private Snapshot-Provenienz ${context} ohne unbenutzte DGX-/Docker-Abhängigkeit verifiziert.`,
    );
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

  private findReusableLipForcingOutput(job: RuntimeJob): ReusableLipForcingOutput | undefined {
    if (!this.reusableBaseSource || !isBoundProgramAudioOnlyCandidate(job)) return undefined;
    let candidates: readonly ReusableLtxBaseCandidate[];
    try {
      candidates = this.reusableBaseSource.reusableLtxBaseCandidates();
    } catch {
      return undefined;
    }
    return exactBoundLipForcingOutputFromSidecars(candidates, job, (path) => this.fileReady(path));
  }

  private async runPairedRawOutputCandidate(
    job: RuntimeJob,
    authority: RawMuxBaselineAuthority,
    authorityBinding: ExecutionFileBinding,
    baselineProvenanceFingerprint: string,
  ): Promise<void> {
    const stageRoot = join(hybridRoot, job.id);
    const temporaryOutput = join(stageRoot, "paired-raw-mux-candidate.tmp.mp4");
    let pinned: ReturnType<typeof pinRawMuxCandidateArtifact>;
    try {
      pinned = pinRawMuxCandidateArtifact(
        authority,
        authorityBinding,
        baselineProvenanceFingerprint,
        stageRoot,
      );
    } catch (error) {
      this.failJob(
        job,
        `Gepaarter Raw-Mux-Kandidat konnte nicht unverändert gesnapshottet werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!job.runProvenance) {
      this.failJob(job, "Laufprovenienz fehlt vor der Bindung des gepaarten Kandidaten-Snapshots.");
      return;
    }
    try {
      for (const [path, role] of [
        [pinned.source.snapshotAuthority.path, "input:raw-mux-pair-authority"],
        [pinned.source.snapshotReceipt.path, "input:raw-mux-pair-receipt"],
        [pinned.source.snapshotTimelineReceipt.path, "input:raw-mux-timeline-receipt"],
        [pinned.source.snapshotPreMux.path, "input:raw-mux-pair-premux"],
        [pinned.source.snapshotPreMuxReceipt.path, "input:raw-mux-premux-receipt"],
        [pinned.source.snapshotCandidateFinal.path, "input:raw-mux-paired-candidate-final"],
      ] as const) {
        if (!await this.bindJobRunProvenanceFile(job, path, role)) return;
      }
    } catch (error) {
      this.failJob(
        job,
        `Private Raw-Mux-Snapshots konnten nicht in die Kandidatenprovenienz gebunden werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!await this.verifyJobIdentityEvidence(job, "vor der gepaarten Kandidaten-Promotion")) return;
    if (!this.verifyPairedPromotionRunProvenance(
      job,
      pinned.source,
      baselineProvenanceFingerprint,
      "vor der gepaarten Kandidaten-Promotion",
    )) return;
    const preparedAt = now();
    const operation: CpuPairedArtifactPromotionOperation = {
      kind: "paired-artifact-promotion",
      state: "prepared",
      descriptorThreatModel: executionDescriptorThreatModel,
      authoritySha256: pinned.source.authority.sha256,
      preparedAt,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      signal: null,
      errorSha256: null,
      output: null,
    };
    if (!this.classifyExecution(job, "cpu-only", pinned.source, operation)) return;
    const decision = normalizeJobExecutionDecision(job.executionDecision);
    if (!decision
      || decision.schemaVersion !== "ltx-studio-execution-decision.v6"
      || decision.executionClass !== "cpu-only"
      || decision.operation.kind !== "paired-artifact-promotion"
      || !("reuseKind" in decision.cpuReuse)
      || decision.cpuReuse.reuseKind !== "lipforcing-raw-mux-pair") {
      this.failJob(job, "Persistierte v6-Promotion-Entscheidung fehlt unmittelbar vor der Operation.");
      return;
    }
    const pairedDecision = decision as JobExecutionDecision & {
      cpuReuse: CpuPairedArtifactReuseSourceBinding;
      operation: CpuPairedArtifactPromotionOperation;
    };
    job.status = "running";
    job.startedAt ??= now();
    const runningDecision: JobExecutionDecision = {
      ...pairedDecision,
      operation: {
        ...pairedDecision.operation,
        state: "running",
        startedAt: job.startedAt,
      },
    } as JobExecutionDecision;
    if (!this.commitExecutionDecision(job, runningDecision)) return;

    const descriptors: VerifiedExecutionDescriptor[] = [];
    let promotedSource: ExecutionFileBinding | null = null;
    let pairedPublishedFileId: string | null = null;
    let pairedPublishedDeviceId: string | null = null;
    let pairedPublicationTemporary: ExecutionFileBinding | null = null;
    try {
      for (const binding of [
        pinned.source.snapshotAuthority,
        pinned.source.snapshotReceipt,
        pinned.source.snapshotTimelineReceipt,
        pinned.source.snapshotPreMux,
        pinned.source.snapshotPreMuxReceipt,
        pinned.source.snapshotCandidateFinal,
      ]) {
        descriptors.push(openVerifiedExecutionDescriptor(
          binding.path,
          binding.sha256,
          binding.revision,
        ));
      }
      for (const descriptor of descriptors) recheckVerifiedExecutionDescriptor(descriptor);
      this.revalidateRuntimeTrustBoundary(job, "gepaarte Raw-Mux-Kandidaten-Promotion");
      const privateOutput = copyRawMuxBoundFile(
        pinned.source.snapshotCandidateFinal,
        temporaryOutput,
      );
      promotedSource = privateOutput;
      for (const descriptor of descriptors) recheckVerifiedExecutionDescriptor(descriptor);
      const success: ProcessResult = { code: 0, signal: null, error: null };
      if (!this.terminalizeCpuOperation(job, "succeeded", success, privateOutput, null)) {
        quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
        return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const failed: ProcessResult = { code: 1, signal: null, error: error instanceof Error ? error : new Error(detail) };
      this.terminalizeCpuOperation(job, "failed", failed, null, detail);
      quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      this.failJob(job, `Gepaarte Raw-Mux-Kandidaten-Promotion fehlgeschlagen: ${detail}`);
      return;
    } finally {
      for (const descriptor of descriptors) closeSync(descriptor.fd);
    }
    if (!await this.verifyJobIdentityEvidence(job, "nach der gepaarten Kandidaten-Promotion")) {
      quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      return;
    }
    if (!this.verifyPairedPromotionRunProvenance(
      job,
      pinned.source,
      baselineProvenanceFingerprint,
      "nach der gepaarten Kandidaten-Promotion",
    )) {
      quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      return;
    }
    const releaseDecision = this.jobStartDecision(job);
    if (!releaseDecision.allowed) {
      quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      this.failJob(job, `Ausgabe bleibt wegen des aktuellen Activation-/Rights-Gates unveröffentlicht: ${releaseDecision.reason}`);
      return;
    }
    if (!this.hasOutputReleaseAuthority(job, "der gepaarten Kandidaten-Publikation")) {
      if (!this.persistenceHold) quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      return;
    }
    try {
      this.revalidateRuntimeTrustBoundary(job, "Ausgabe-Publikation");
      if (!promotedSource
        || existsSync(job.plan.outputPath)
        || existsSync(outputPublicationPath(job.plan.outputPath))) {
        throw new Error("Publikationsziel oder Marker existiert bereits; gepaarte Bytes werden nicht überschrieben.");
      }
      const publicationTemporary = `${job.plan.outputPath}.paired-${job.id}.tmp`;
      const publicationBinding = copyRawMuxBoundFile(promotedSource, publicationTemporary);
      pairedPublicationTemporary = publicationBinding;
      linkSync(publicationBinding.path, job.plan.outputPath);
      pairedPublishedFileId = publicationBinding.revision.fileId;
      pairedPublishedDeviceId = publicationBinding.revision.deviceId;
      unlinkSync(publicationBinding.path);
      pairedPublicationTemporary = null;
      const outputDescriptor = openSync(job.plan.outputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const outputStats = fstatSync(outputDescriptor);
        if (!outputStats.isFile()
          || outputStats.nlink !== 1
          || String(outputStats.ino) !== publicationBinding.revision.fileId
          || String(outputStats.dev) !== publicationBinding.revision.deviceId
          || outputStats.uid !== publicationBinding.revision.uid
          || outputStats.gid !== publicationBinding.revision.gid
          || outputStats.mode !== publicationBinding.revision.mode
          || (outputStats.mode & 0o7777) !== 0o400
          || (typeof process.getuid === "function" && outputStats.uid !== process.getuid())) {
          throw new Error("No-replace-Publikation bindet nicht mehr das vorbereitete Kandidatenartefakt.");
        }
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;
        while (position < outputStats.size) {
          const count = readSync(
            outputDescriptor,
            buffer,
            0,
            Math.min(buffer.length, outputStats.size - position),
            position,
          );
          if (count <= 0) throw new Error("No-replace-Publikation endete während der Hashprüfung vorzeitig.");
          digest.update(buffer.subarray(0, count));
          position += count;
        }
        const outputAfter = fstatSync(outputDescriptor);
        const outputPathAfter = lstatSync(job.plan.outputPath);
        if (digest.digest("hex") !== publicationBinding.sha256
          || outputAfter.size !== outputStats.size
          || outputAfter.mtimeMs !== outputStats.mtimeMs
          || outputAfter.ctimeMs !== outputStats.ctimeMs
          || outputAfter.nlink !== 1
          || String(outputAfter.ino) !== String(outputStats.ino)
          || String(outputAfter.dev) !== String(outputStats.dev)
          || outputPathAfter.isSymbolicLink()
          || String(outputPathAfter.ino) !== String(outputStats.ino)
          || String(outputPathAfter.dev) !== String(outputStats.dev)) {
          throw new Error("No-replace-Publikationsbytes drifteten während der gehaltenen FD-Prüfung.");
        }
        fsyncSync(outputDescriptor);
      } finally {
        closeSync(outputDescriptor);
      }
      fsyncDirectory(dirname(job.plan.outputPath));
      rmSync(temporaryOutput, { force: true });
    } catch (error) {
      let publishedPathIsOurs = false;
      if (pairedPublishedFileId && pairedPublishedDeviceId) {
        try {
          const current = lstatSync(job.plan.outputPath);
          publishedPathIsOurs = !current.isSymbolicLink()
            && String(current.ino) === pairedPublishedFileId
            && String(current.dev) === pairedPublishedDeviceId;
        } catch {
          publishedPathIsOurs = false;
        }
      }
      if (publishedPathIsOurs) {
        try {
          unlinkSync(job.plan.outputPath);
          fsyncDirectory(dirname(job.plan.outputPath));
          publishedPathIsOurs = false;
        } catch {
          // Leave a still exact-owned path unserved: no publication marker is written.
        }
      }
      if (pairedPublicationTemporary) {
        try {
          const current = lstatSync(pairedPublicationTemporary.path);
          if (!current.isSymbolicLink()
            && String(current.ino) === pairedPublicationTemporary.revision.fileId
            && String(current.dev) === pairedPublicationTemporary.revision.deviceId) {
            quarantineUnreleasedArtifact(pairedPublicationTemporary.path, stageRoot);
          }
        } catch {
          // Never remove or move a pathname that no longer binds our private temp inode.
        }
      }
      quarantineUnreleasedArtifact(
        publishedPathIsOurs ? job.plan.outputPath : temporaryOutput,
        stageRoot,
      );
      this.failJob(
        job,
        `Gepaarte CPU-Ausgabe konnte nicht atomar publiziert werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const completedAt = now();
    let publicationAuthority: OutputPublicationAuthority;
    try {
      this.revalidateRuntimeTrustBoundary(job, "gepaarte Publikationsautorität");
      publicationAuthority = this.buildPublicationAuthority(job, completedAt);
    } catch (error) {
      if (isJobPersistenceHoldError(error)) throw error;
      quarantineUnreleasedArtifact(job.plan.outputPath, stageRoot);
      this.failJob(
        job,
        `Publikationsautorität des gepaarten Kandidaten konnte nicht vorbereitet werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!this.hasOutputReleaseAuthority(job, "dem gepaarten Publikations-Commit")) {
      if (!this.persistenceHold) quarantineUnreleasedArtifact(job.plan.outputPath, stageRoot);
      return;
    }
    const completionMetadata: DgxTransitionMetadata = {
      current_step: "provenance-bound paired raw mux candidate promotion completed",
      artifact: {
        type: "video",
        path: job.plan.outputPath,
        note: "paired LipForcing raw mux candidate from exact baseline pre-mux",
      },
    };
    if (!this.commitPreparedPublication(
      job,
      publicationAuthority,
      completedAt,
      completionMetadata,
      "Privater gepaarter Mux-copy-Kandidatenarm ohne zweiten LTX-/LipForcing-/Docker-Lauf atomar publiziert.",
      "Publikationsautorität des gepaarten Kandidaten konnte nicht persistiert werden",
      stageRoot,
    )) return;
    await this.flushDgxTerminalDelivery(job);
  }

  private async runPositivePacketCopyAudioRetime(
    job: RuntimeJob,
    reusable: ReusableLipForcingOutput,
    pinned: PinnedCpuReuse,
    stageRoot: string,
    temporaryOutput: string,
    deltaMs: number,
  ): Promise<void> {
    const experiment = job.experiment;
    const receiptPath = join(stageRoot, "audio-retime-receipt.v1.json");
    const verificationRoot = join(stageRoot, "audio-retime-replay");
    if (!experiment
      || experiment.arm !== "candidate"
      || experiment.variableId !== "program-audio-delay-ms"
      || experiment.changedRequestPaths.length !== 1
      || experiment.changedRequestPaths[0] !== "audio.outputDelayMs"
      || experiment.baselineJobId !== reusable.id
      || experiment.baselineOutputName !== reusable.outputName
      || experiment.baselineRequestSha256 !== reusable.baselineRequestSha256
      || experiment.requestSha256 !== experimentRequestSha256V1(job.authorityBoundRequest)
      || !experiment.protocolSha256
      || reusable.programAudioDelayMs !== 0
      || deltaMs !== job.request.audio.outputDelayMs
      || !Number.isInteger(deltaMs)
      || deltaMs < 1
      || deltaMs > 500
      || typeof reusable.sourceAuthorityRequestSha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(reusable.sourceAuthorityRequestSha256)
      || !/^[0-9a-f]{64}$/u.test(reusable.sourceProvenanceFingerprint)) {
      this.failJob(
        job,
        "Der native Packet-Copy-Audioarm besitzt keine vollständige positive LTX-2.5-Experimentautorität.",
      );
      return;
    }

    let ffmpeg: BoundExecutableDescriptor | null = null;
    let ffprobe: BoundExecutableDescriptor | null = null;
    let pinnedOutput: VerifiedExecutionDescriptor | null = null;
    let pinnedSettings: VerifiedExecutionDescriptor | null = null;
    let pinnedAnalysis: VerifiedExecutionDescriptor | null = null;
    let candidateDescriptor: VerifiedExecutionDescriptor | null = null;
    let receiptDescriptor: VerifiedExecutionDescriptor | null = null;
    let classified = false;
    let result: ProcessResult | null = null;

    const closeDescriptors = (): void => {
      for (const descriptor of [
        receiptDescriptor,
        candidateDescriptor,
        pinnedAnalysis,
        pinnedSettings,
        pinnedOutput,
      ]) {
        if (descriptor) closeSync(descriptor.fd);
      }
      if (ffprobe) closeSync(ffprobe.fd);
      if (ffmpeg) closeSync(ffmpeg.fd);
    };
    const terminalFailure = (detail: string, failureResult?: ProcessResult): void => {
      const terminalResult = failureResult ?? {
        code: 1,
        signal: null,
        error: new Error(detail),
      };
      if (classified) this.terminalizeCpuOperation(job, "failed", terminalResult, null, detail);
      if (!this.persistenceHold) quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      this.failJob(job, detail);
    };

    try {
      try {
        ffmpeg = openBoundExecutable("/usr/bin/ffmpeg");
        ffprobe = openBoundExecutable("/usr/bin/ffprobe");
        verifyRootOwnedBoundMediaTool(ffmpeg, "/usr/bin/ffmpeg");
        verifyRootOwnedBoundMediaTool(ffprobe, "/usr/bin/ffprobe");
      } catch (error) {
        this.failJob(
          job,
          `FFmpeg/FFprobe konnten nicht als root-eigene O_NOFOLLOW-Tools gebunden werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      if (!job.runProvenance) {
        this.failJob(job, "Die historische Baseline-Provenienz fehlt vor dem gebundenen Audio-Retime.");
        return;
      }
      if (job.runProvenance.runtime.ffmpegVersion !== ffmpeg.version) {
        this.appendLog(
          job,
          "Das aktuelle FFmpeg unterscheidet sich von der historischen Baseline-Laufzeit; "
            + "Executable-FD, Version, Bytes und Revision werden deshalb ausschließlich in der neuen "
            + "CPU-Operation und ihrem unabhängig verifizierten Receipt gebunden.",
        );
      }
      try {
        pinnedOutput = openVerifiedExecutionDescriptor(
          pinned.source.snapshotOutputPath,
          pinned.source.snapshotOutputSha256,
          pinned.source.snapshotOutputRevision,
        );
        pinnedSettings = openVerifiedExecutionDescriptor(
          pinned.source.snapshotSettingsSidecarPath,
          pinned.source.snapshotSettingsSidecarSha256,
          pinned.source.snapshotSettingsSidecarRevision,
        );
        pinnedAnalysis = openVerifiedExecutionDescriptor(
          pinned.source.snapshotAnalysisSidecarPath,
          pinned.source.snapshotAnalysisSidecarSha256,
          pinned.source.snapshotAnalysisSidecarRevision,
        );
      } catch (error) {
        this.failJob(
          job,
          `Private LTX-2.5-Baseline-Snapshots drifteten vor dem Packet-Copy-Retime: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }

      const args = buildPositiveAudioRetimePacketCopyArgs(
        "/proc/self/fd/4",
        temporaryOutput,
        deltaMs,
      );
      const operation: CpuPacketCopyAudioRetimeOperation = {
        kind: "ffmpeg-audio-retime-v2",
        profileId: POSITIVE_AUDIO_RETIME_PROFILE,
        state: "prepared",
        descriptorThreatModel: executionDescriptorThreatModel,
        ffmpeg: ffmpeg.binding,
        ffmpegVersion: ffmpeg.version,
        ffprobe: ffprobe.binding,
        ffprobeVersion: ffprobe.version,
        ffmpegArgsSha256: positiveAudioRetimeArgsSha256(args),
        ffprobeArgsSha256: POSITIVE_AUDIO_RETIME_FFPROBE_ARGS_SHA256,
        deltaMs,
        preparedAt: now(),
        startedAt: null,
        completedAt: null,
        exitCode: null,
        signal: null,
        errorSha256: null,
        output: null,
        receipt: null,
      };
      if (!this.classifyExecution(job, "cpu-only", pinned.source, operation)) return;
      classified = true;

      job.progress = 90;
      this.appendLog(
        job,
        `Native LTX-2.5-Baseline ${reusable.description} exakt gebunden; `
          + `Video- und Audiopakete werden ohne Re-Encode kopiert und der hörbare Ton um +${deltaMs} ms verschoben. `
          + "Der Kandidat läuft CPU-only und muss vor Publikation einen gebundenen Kausalitäts-Receipt bestehen.",
      );
      this.changed();
      result = await this.runLoggedProcess(job, "/proc/self/fd/3", args, {
        cwd: repoRoot,
        env: { ...process.env, LC_ALL: "C" },
        inheritedFds: [pinnedOutput.fd],
        boundExecutable: ffmpeg,
        recheckExecutables: [ffprobe],
        recheckDescriptors: [pinnedOutput, pinnedSettings, pinnedAnalysis],
      });
      if (this.jobShouldStop(job)) {
        this.terminalizeCpuOperation(
          job,
          job.status === "cancelled" ? "cancelled" : "interrupted",
          result,
          null,
          job.error,
        );
        quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
        return;
      }
      if (result.error || result.code !== 0 || !this.fileReady(temporaryOutput)) {
        const detail = result.error?.message
          ?? `Packet-Copy-Audio-Retime endete mit Code ${String(result.code)}`
            + `${result.signal ? ` (${result.signal})` : ""}`
            + `${this.fileReady(temporaryOutput) ? "." : "; Kandidatendatei fehlt."}`;
        terminalFailure(detail, result);
        return;
      }

      let privateOutput: HashedExecutionFile;
      try {
        privateOutput = await hashUnchangedExecutionFile(
          temporaryOutput,
          () => this.jobShouldStop(job),
        );
      } catch (error) {
        if (this.jobShouldStop(job)) {
          this.terminalizeCpuOperation(
            job,
            job.status === "cancelled" ? "cancelled" : "interrupted",
            result,
            null,
            job.error,
          );
          quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
          return;
        }
        terminalFailure(
          `Packet-Copy-Kandidat konnte nicht unverändert gebunden werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
          result,
        );
        return;
      }
      const privateOutputBinding: ExecutionFileBinding = {
        path: temporaryOutput,
        sha256: privateOutput.sha256,
        revision: privateOutput.revision,
      };
      try {
        candidateDescriptor = openVerifiedExecutionDescriptor(
          privateOutputBinding.path,
          privateOutputBinding.sha256,
          privateOutputBinding.revision,
        );
        mkdirSync(verificationRoot, { mode: 0o700 });
        const receipt = createPositiveAudioRetimeReceipt({
          profile: POSITIVE_AUDIO_RETIME_PROFILE,
          requestedDelayMs: deltaMs,
          authority: {
            jobId: job.id,
            experimentId: experiment.experimentId,
            protocolSha256: experiment.protocolSha256,
            candidateRequestSha256: experiment.requestSha256,
            baselineJobId: reusable.id,
            baselineOutputName: reusable.outputName,
            baselineRequestSha256: reusable.baselineRequestSha256,
            sourceAuthorityRequestSha256: reusable.sourceAuthorityRequestSha256,
            sourceProvenanceFingerprint: reusable.sourceProvenanceFingerprint,
          },
          source: {
            path: pinned.source.snapshotOutputPath,
            sha256: pinned.source.snapshotOutputSha256,
            revision: pinned.source.snapshotOutputRevision,
          },
          candidate: privateOutputBinding,
          ffmpeg,
          ffprobe,
          transformArgs: args,
          verificationRoot,
        });
        recheckVerifiedExecutionDescriptor(candidateDescriptor);
        exclusiveDurableReadonlyJsonFile(receiptPath, receipt);
      } catch (error) {
        if (existsSync(receiptPath)) {
          this.enterPersistenceHold(
            error,
            "der exklusive Audio-Retime-Receipt-Link wurde sichtbar, aber seine Durability ist nicht eindeutig",
          );
          return;
        }
        terminalFailure(
          `Packet-Copy-Kausalitätsprüfung oder Receipt-Erzeugung scheiterte: ${
            error instanceof Error ? error.message : String(error)
          }`,
          result,
        );
        return;
      }

      let receiptFile: HashedExecutionFile;
      try {
        receiptFile = await hashUnchangedExecutionFile(
          receiptPath,
          () => this.jobShouldStop(job),
        );
        receiptDescriptor = openVerifiedExecutionDescriptor(
          receiptPath,
          receiptFile.sha256,
          receiptFile.revision,
        );
      } catch (error) {
        if (this.jobShouldStop(job)) {
          this.terminalizeCpuOperation(
            job,
            job.status === "cancelled" ? "cancelled" : "interrupted",
            result,
            null,
            job.error,
          );
          quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
          return;
        }
        terminalFailure(
          `Persistierter Audio-Retime-Receipt konnte nicht unverändert gebunden werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
          result,
        );
        return;
      }
      const receiptBinding: ExecutionFileBinding = {
        path: receiptPath,
        sha256: receiptFile.sha256,
        revision: receiptFile.revision,
      };
      try {
        if (!await this.bindJobRunProvenanceFile(
          job,
          receiptPath,
          "evidence:cpu-audio-retime-receipt",
        )) {
          this.terminalizeCpuOperation(
            job,
            job.status === "cancelled" ? "cancelled" : "interrupted",
            result,
            null,
            job.error,
          );
          quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
          return;
        }
      } catch (error) {
        terminalFailure(
          `Audio-Retime-Receipt konnte nicht an die Laufprovenienz gebunden werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
          result,
        );
        return;
      }

      for (const descriptor of [
        pinnedOutput,
        pinnedSettings,
        pinnedAnalysis,
        candidateDescriptor,
        receiptDescriptor,
      ]) recheckVerifiedExecutionDescriptor(descriptor);
      verifyRootOwnedBoundMediaTool(ffmpeg, "/usr/bin/ffmpeg");
      verifyRootOwnedBoundMediaTool(ffprobe, "/usr/bin/ffprobe");
      if (!this.terminalizeCpuOperation(
        job,
        "succeeded",
        result,
        privateOutputBinding,
        null,
        receiptBinding,
      )) {
        quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
        return;
      }
      if (!await this.verifyJobIdentityEvidence(job, "nach dem nativen Packet-Copy-Audio-Retime")) {
        quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
        return;
      }
      if (!await this.verifyJobRunProvenance(job, "nach dem nativen Packet-Copy-Audio-Retime")) {
        quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
        return;
      }
      for (const descriptor of [
        pinnedOutput,
        pinnedSettings,
        pinnedAnalysis,
        candidateDescriptor,
        receiptDescriptor,
      ]) recheckVerifiedExecutionDescriptor(descriptor);
      const releaseDecision = this.jobStartDecision(job);
      if (!releaseDecision.allowed) {
        quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
        this.failJob(
          job,
          `Ausgabe bleibt wegen des aktuellen Activation-/Rights-Gates unveröffentlicht: ${releaseDecision.reason}`,
        );
        return;
      }
      if (!this.hasOutputReleaseAuthority(job, "der nativen Packet-Copy-Audio-Publikation")) {
        if (!this.persistenceHold) quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
        return;
      }

      try {
        for (const descriptor of [candidateDescriptor, receiptDescriptor]) {
          recheckVerifiedExecutionDescriptor(descriptor);
        }
        verifyRootOwnedBoundMediaTool(ffmpeg, "/usr/bin/ffmpeg");
        verifyRootOwnedBoundMediaTool(ffprobe, "/usr/bin/ffprobe");
        this.revalidateRuntimeTrustBoundary(job, "native Packet-Copy-Audio-Publikation");
        this.promotePrivateOutput(temporaryOutput, job.plan.outputPath);
        candidateDescriptor = rebindVerifiedExecutionDescriptorAfterAtomicRename(
          candidateDescriptor,
          job.plan.outputPath,
        );
        recheckVerifiedExecutionDescriptor(receiptDescriptor);
      } catch (error) {
        quarantineUnreleasedArtifact(
          existsSync(job.plan.outputPath) ? job.plan.outputPath : temporaryOutput,
          stageRoot,
        );
        this.failJob(
          job,
          `Terminaler Packet-Copy-Kandidat konnte nicht atomar/fsync-persistiert werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }

      const completedAt = now();
      let publicationAuthority: OutputPublicationAuthority;
      try {
        this.revalidateRuntimeTrustBoundary(job, "nativer Packet-Copy-Audio-Publikationsautorität");
        publicationAuthority = this.buildPublicationAuthority(job, completedAt);
      } catch (error) {
        if (isJobPersistenceHoldError(error)) throw error;
        quarantineUnreleasedArtifact(job.plan.outputPath, stageRoot);
        this.failJob(
          job,
          `Publikationsautorität des Packet-Copy-Kandidaten konnte nicht vorbereitet werden: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return;
      }
      if (!this.hasOutputReleaseAuthority(job, "dem nativen Packet-Copy-Audio-Publikations-Commit")) {
        if (!this.persistenceHold) quarantineUnreleasedArtifact(job.plan.outputPath, stageRoot);
        return;
      }
      const completionMetadata: DgxTransitionMetadata = {
        current_step: "receipt-bound native LTX-2.5 program-audio retiming completed",
        artifact: {
          type: "video",
          path: job.plan.outputPath,
          note: "native LTX-2.5 output with receipt-bound packet-copy audio timing correction",
        },
      };
      if (!this.commitPreparedPublication(
        job,
        publicationAuthority,
        completedAt,
        completionMetadata,
        "Native LTX-2.5-Pakete unverändert kopiert und positiver hörbarer Tonversatz receipt-gebunden publiziert.",
        "Publikationsautorität des Packet-Copy-Kandidaten konnte nicht dauerhaft persistiert werden",
        stageRoot,
      )) return;
      await this.flushDgxTerminalDelivery(job);
    } finally {
      closeDescriptors();
    }
  }

  private async runReusedLipForcingAudioRetime(
    job: RuntimeJob,
    reusable: ReusableLipForcingOutput,
  ): Promise<void> {
    const stageRoot = join(hybridRoot, job.id);
    const temporaryOutput = join(stageRoot, "retimed-program-audio-output.tmp.mp4");
    let pinned: PinnedCpuReuse;
    try {
      pinned = await pinExactLipForcingReuse(
        reusable,
        stageRoot,
        undefined,
        () => this.jobShouldStop(job),
      );
    } catch (error) {
      if (this.jobShouldStop(job)) return;
      this.failJob(
        job,
        `Die exakt gebundene Audio-Timing-Baseline konnte nicht fail-closed übernommen werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!this.fileReady(pinned.inputPath) || !job.runProvenance) {
      this.failJob(job, "Der private Baseline-Snapshot oder die Laufprovenienz fehlt.");
      return;
    }
    try {
      if (!await this.bindJobRunProvenanceFile(
        job,
        pinned.inputPath,
        `input:reused-program-audio-output:${reusable.id}`,
      )) return;
    } catch (error) {
      this.failJob(
        job,
        `Die wiederverwendete Baseline-Ausgabe konnte nicht kryptografisch gebunden werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!await this.verifyJobIdentityEvidence(job, "vor der Audio-only-Zeitkorrektur")) return;
    if (!await this.verifyJobRunProvenance(job, "vor der Audio-only-Zeitkorrektur")) return;

    const variableId = boundProgramAudioDelayVariable(job);
    if (!variableId) {
      this.failJob(job, "Die Audio-only-Zeitkorrektur besitzt keine gültige Einzelfaktor-Bindung.");
      return;
    }
    const targetDelayMs = programAudioDelayValue(job.request, variableId);
    const deltaMs = targetDelayMs - reusable.programAudioDelayMs;
    if (variableId === "program-audio-delay-ms") {
      await this.runPositivePacketCopyAudioRetime(
        job,
        reusable,
        pinned,
        stageRoot,
        temporaryOutput,
        deltaMs,
      );
      return;
    }
    let ffmpeg: BoundExecutableDescriptor;
    try {
      ffmpeg = openBoundExecutableFromPath("ffmpeg");
    } catch (error) {
      this.failJob(
        job,
        `FFmpeg konnte nicht per O_NOFOLLOW gebunden werden: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (job.runProvenance.runtime.ffmpegVersion !== ffmpeg.version) {
      closeSync(ffmpeg.fd);
      this.failJob(job, "FFmpeg-Version des gebundenen Executable-FD widerspricht der Laufprovenienz.");
      return;
    }
    let pinnedOutput: VerifiedExecutionDescriptor | null = null;
    let pinnedSettings: VerifiedExecutionDescriptor | null = null;
    let pinnedAnalysis: VerifiedExecutionDescriptor | null = null;
    try {
      pinnedOutput = openVerifiedExecutionDescriptor(
        pinned.source.snapshotOutputPath,
        pinned.source.snapshotOutputSha256,
        pinned.source.snapshotOutputRevision,
      );
      pinnedSettings = openVerifiedExecutionDescriptor(
        pinned.source.snapshotSettingsSidecarPath,
        pinned.source.snapshotSettingsSidecarSha256,
        pinned.source.snapshotSettingsSidecarRevision,
      );
      pinnedAnalysis = openVerifiedExecutionDescriptor(
        pinned.source.snapshotAnalysisSidecarPath,
        pinned.source.snapshotAnalysisSidecarSha256,
        pinned.source.snapshotAnalysisSidecarRevision,
      );
    } catch (error) {
      if (pinnedOutput) closeSync(pinnedOutput.fd);
      if (pinnedSettings) closeSync(pinnedSettings.fd);
      if (pinnedAnalysis) closeSync(pinnedAnalysis.fd);
      closeSync(ffmpeg.fd);
      this.failJob(
        job,
        `Der private Baseline-Snapshot änderte sich vor FFmpeg: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    // Child fd 3 is the executable; the held media snapshot is child fd 4.
    const args = buildLipForcingAudioRetimeArgs("/proc/self/fd/4", temporaryOutput, deltaMs);
    const preparedAt = now();
    const operation: CpuFfmpegOperation = {
      kind: "ffmpeg-audio-retime",
      state: "prepared",
      descriptorThreatModel: executionDescriptorThreatModel,
      executable: ffmpeg.binding,
      ffmpegVersion: ffmpeg.version,
      argsSha256: createHash("sha256").update(canonicalJson(args)).digest("hex"),
      deltaMs,
      preparedAt,
      startedAt: null,
      completedAt: null,
      exitCode: null,
      signal: null,
      errorSha256: null,
      output: null,
    };
    if (!this.classifyExecution(job, "cpu-only", pinned.source, operation)) {
      closeSync(pinnedOutput.fd);
      closeSync(pinnedSettings.fd);
      closeSync(pinnedAnalysis.fd);
      closeSync(ffmpeg.fd);
      return;
    }

    rmSync(temporaryOutput, { force: true });
    job.progress = 90;
    this.appendLog(
      job,
      `Visuell identische ${reusable.description} kryptografisch gebunden; `
        + `nur der hörbare Ton wird um ${deltaMs >= 0 ? "+" : ""}${deltaMs} ms relativ verschoben. `
        + "Kein LTX-, LipForcing- oder sonstiger GPU-Lauf erforderlich.",
    );
    this.changed();
    let result: ProcessResult;
    try {
      result = await this.runLoggedProcess(job, "/proc/self/fd/3", args, {
        cwd: repoRoot,
        env: { ...process.env },
        inheritedFds: [pinnedOutput.fd],
        boundExecutable: ffmpeg,
        recheckDescriptors: [pinnedOutput, pinnedSettings, pinnedAnalysis],
      });
    } finally {
      closeSync(pinnedOutput.fd);
      closeSync(pinnedSettings.fd);
      closeSync(pinnedAnalysis.fd);
      closeSync(ffmpeg.fd);
    }
    if (this.jobShouldStop(job)) {
      this.terminalizeCpuOperation(
        job,
        job.status === "cancelled" ? "cancelled" : "interrupted",
        result,
        null,
        job.error,
      );
      rmSync(temporaryOutput, { force: true });
      return;
    }
    if (result.error || result.code !== 0 || !this.fileReady(temporaryOutput)) {
      const failure = result.error?.message
        ?? `Audio-only-Zeitkorrektur endete mit Code ${String(result.code)}`
          + `${result.signal ? ` (${result.signal})` : ""}`
          + `${this.fileReady(temporaryOutput) ? "." : "; terminale Ausgabedatei fehlt."}`;
      this.terminalizeCpuOperation(job, "failed", result, null, failure);
      rmSync(temporaryOutput, { force: true });
      this.failJob(job, failure);
      return;
    }
    let privateOutput: HashedExecutionFile;
    try {
      privateOutput = await hashUnchangedExecutionFile(
        temporaryOutput,
        () => this.jobShouldStop(job),
      );
    } catch (error) {
      if (this.jobShouldStop(job)) return;
      const failure = `FFmpeg-Ausgabe konnte nicht unverändert gebunden werden: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.terminalizeCpuOperation(job, "failed", result, null, failure);
      rmSync(temporaryOutput, { force: true });
      this.failJob(job, failure);
      return;
    }
    const privateOutputBinding: ExecutionFileBinding = {
      path: temporaryOutput,
      sha256: privateOutput.sha256,
      revision: privateOutput.revision,
    };
    if (!this.terminalizeCpuOperation(job, "succeeded", result, privateOutputBinding, null)) {
      quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      return;
    }
    if (!await this.verifyJobIdentityEvidence(job, "nach der Audio-only-Zeitkorrektur")) {
      quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      return;
    }
    if (!await this.verifyJobRunProvenance(job, "nach der Audio-only-Zeitkorrektur")) {
      quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      return;
    }
    const outputReleaseDecision = this.jobStartDecision(job);
    if (!outputReleaseDecision.allowed) {
      quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      this.failJob(
        job,
        `Ausgabe bleibt wegen des aktuellen Activation-/Rights-Gates unveröffentlicht: ${outputReleaseDecision.reason}`,
      );
      return;
    }
    if (!this.hasOutputReleaseAuthority(job, "der Audio-only-Ausgabe-Publikation")) {
      if (!this.persistenceHold) quarantineUnreleasedArtifact(temporaryOutput, stageRoot);
      return;
    }

    try {
      this.revalidateRuntimeTrustBoundary(job, "Ausgabe-Publikation");
      this.promotePrivateOutput(temporaryOutput, job.plan.outputPath);
    } catch (error) {
      quarantineUnreleasedArtifact(
        existsSync(job.plan.outputPath) ? job.plan.outputPath : temporaryOutput,
        stageRoot,
      );
      this.failJob(
        job,
        `Terminale CPU-Ausgabe konnte nicht atomar/fsync-persistiert werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    const completedAt = now();
    let publicationAuthority: OutputPublicationAuthority;
    try {
      this.revalidateRuntimeTrustBoundary(job, "Audio-only-Publikationsautorität");
      publicationAuthority = this.buildPublicationAuthority(job, completedAt);
    } catch (error) {
      if (isJobPersistenceHoldError(error)) throw error;
      quarantineUnreleasedArtifact(job.plan.outputPath, stageRoot);
      this.failJob(
        job,
        `Publikationsautorität der Audio-only-Ausgabe konnte nicht vorbereitet werden: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    if (!this.hasOutputReleaseAuthority(job, "dem Audio-only-Publikations-Commit")) {
      if (!this.persistenceHold) quarantineUnreleasedArtifact(job.plan.outputPath, stageRoot);
      return;
    }
    const completionMetadata: DgxTransitionMetadata = {
      current_step: "provenance-bound program-audio-only retiming completed",
      artifact: {
        type: "video",
        path: job.plan.outputPath,
        note: "final LTX Studio output with audio-only timing correction",
      },
    };
    if (!this.commitPreparedPublication(
      job,
      publicationAuthority,
      completedAt,
      completionMetadata,
      "Videostream unverändert wiederverwendet und hörbare Sprachspur erfolgreich neu getimt.",
      "Publikationsautorität konnte nicht dauerhaft persistiert werden",
      stageRoot,
    )) return;
    await this.flushDgxTerminalDelivery(job);
  }

  private async waitForDelay(job: RuntimeJob, delayMs: number): Promise<boolean> {
    const endAt = Date.now() + delayMs;
    while (!this.jobShouldStop(job) && isActiveJobStatus(job.status)) {
      const remaining = endAt - Date.now();
      if (remaining <= 0) return true;
      await new Promise<void>((resolvePromise) => {
        const signal = this.persistenceHoldAbortController.signal;
        function finish(): void {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolvePromise();
        }
        const timer = setTimeout(finish, Math.min(1_000, remaining));
        if (signal.aborted) return finish();
        signal.addEventListener("abort", finish, { once: true });
      });
    }
    return false;
  }

  /**
   * Converts either the initial submit response or one authoritative positive
   * queue observation into durable mutation authority.  The commit is the
   * only point where an unknown submit may acquire a remote ID; callers may
   * issue GET/PATCH or exact idempotent POST replays only after this method has
   * returned successfully.
   */
  private commitDgxLeaseReceipt(
    job: RuntimeJob,
    remote: QueueJobSummary,
    receiptInput: DgxLeaseReceipt,
    terminalIntent: boolean,
  ): void {
    const receipt = normalizeDgxLeaseReceipt(receiptInput);
    if (!receipt
      || canonicalJson(receipt) !== canonicalJson(receiptInput)
      || receipt.studioJobId !== job.id
      || receipt.dgxJobId !== remote.job_id) {
      throw new DgxLeaseAuthorityError(
        "DGX-Lease-Receipt widerspricht dem dauerhaft vorbereiteten Einmal-Submit-Vertrag.",
      );
    }
    if (job.dgxTerminalReceipt) {
      if (job.dgxTerminalReceipt.dgxJobId === remote.job_id) return;
      throw new DgxLeaseAuthorityError(
        "Eine verspätete Submit-Evidenz widerspricht dem bereits terminal bestätigten DGX-Job.",
      );
    }
    if (job.dgxLeaseReceipt || job.dgxJobId) {
      const existing = normalizeDgxLeaseReceipt(job.dgxLeaseReceipt);
      if (existing
        && job.dgxJobId === remote.job_id
        && existing.dgxJobId === remote.job_id
        && existing.preparedAdmissionSha256 === receipt.preparedAdmissionSha256) {
        if (terminalIntent && !job.dgxTerminalDelivery) {
          this.prepareDgxTerminalDelivery(job, "cancelled", {
            current_step: "terminal Studio intent after ambiguous DGX submit",
            last_error: job.error ?? "Studio job became terminal while the sole DGX submit was ambiguous",
          });
          this.changed();
        }
        return;
      }
      throw new DgxLeaseAuthorityError(
        "Zwei verschiedene DGX-Leases beanspruchen denselben Studio-Einmal-Submit.",
      );
    }
    const preparedAdmission = normalizePreparedAdmission(job.dgxPreparedAdmission);
    if (!preparedAdmission
      || job.dgxPreparedAdmissionSha256 !== preparedAdmissionSha256(preparedAdmission)
      || receipt.preparedAdmissionSha256 !== job.dgxPreparedAdmissionSha256
      || canonicalJson(receipt.preparedAdmission) !== canonicalJson(preparedAdmission)) {
      throw new DgxLeaseAuthorityError(
        "DGX-Lease-Receipt widerspricht dem dauerhaft vorbereiteten Einmal-Submit-Vertrag.",
      );
    }
    if (!job.dgxSubmitPending) {
      throw new DgxLeaseAuthorityError(
        "DGX-Lease-Evidenz traf ohne dauerhaften unbekannten Submit-Intent ein.",
      );
    }
    const successorAuthorization = job.dgxSuccessorAuthorization === undefined
      ? undefined
      : normalizeDgxSuccessorAuthorization(job.dgxSuccessorAuthorization);
    if (job.dgxSuccessorAuthorization !== undefined
      && (!successorAuthorization
        || successorAuthorization.phase !== "submit-pending"
        || canonicalJson(successorAuthorization) !== canonicalJson(job.dgxSuccessorAuthorization)
        || successorAuthorization.studioJobId !== job.id
        || successorAuthorization.preparedAdmissionSha256 !== receipt.preparedAdmissionSha256
        || successorAuthorization.authorizedAt !== receipt.submitStartedAt
        || canonicalJson(successorAuthorization.predecessorLeaseReceipt.preparedAdmission)
          !== canonicalJson(receipt.preparedAdmission)
        || successorAuthorization.predecessorDgxJobId === remote.job_id)) {
      throw new DgxLeaseAuthorityError(
        "DGX-Successor-Receipt widerspricht seiner dauerhaften Einmal-Autorisierung.",
      );
    }
    const consumedSuccessorAuthorization = successorAuthorization
      ? consumeDgxSuccessorAuthorization(
          successorAuthorization,
          remote.job_id,
          "lease",
          receipt,
        )
      : undefined;
    if (successorAuthorization && !consumedSuccessorAuthorization) {
      throw new DgxLeaseAuthorityError(
        "DGX-Successor-Autorisierung konnte nicht exakt einmal konsumiert werden.",
      );
    }

    const snapshot = {
      dgxJobId: job.dgxJobId,
      dgxJobTerminal: job.dgxJobTerminal,
      dgxLeaseReceipt: job.dgxLeaseReceipt
        ? structuredClone(job.dgxLeaseReceipt)
        : undefined,
      dgxSubmitPending: job.dgxSubmitPending,
      dgxSubmitStartedAt: job.dgxSubmitStartedAt,
      dgxPreparedAdmission: job.dgxPreparedAdmission
        ? structuredClone(job.dgxPreparedAdmission)
        : undefined,
      dgxPreparedAdmissionSha256: job.dgxPreparedAdmissionSha256,
      dgxTerminalDelivery: job.dgxTerminalDelivery
        ? structuredClone(job.dgxTerminalDelivery)
        : undefined,
      dgxSuccessorAuthorization: job.dgxSuccessorAuthorization
        ? structuredClone(job.dgxSuccessorAuthorization)
        : undefined,
      logs: [...job.logs],
    };
    job.dgxJobId = remote.job_id;
    job.dgxJobTerminal = false;
    job.dgxLeaseReceipt = receipt;
    delete job.dgxSubmitPending;
    delete job.dgxSubmitStartedAt;
    delete job.dgxPreparedAdmission;
    delete job.dgxPreparedAdmissionSha256;
    if (consumedSuccessorAuthorization) {
      job.dgxSuccessorAuthorization = consumedSuccessorAuthorization;
    }
    if (terminalIntent) {
      this.prepareDgxTerminalDelivery(job, "cancelled", {
        current_step: "terminal Studio intent after ambiguous DGX submit",
        last_error: job.error ?? "Studio job became terminal while the sole DGX submit was ambiguous",
      });
    }
    try {
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        job.dgxJobId = snapshot.dgxJobId;
        job.dgxJobTerminal = snapshot.dgxJobTerminal;
        if (snapshot.dgxLeaseReceipt) job.dgxLeaseReceipt = snapshot.dgxLeaseReceipt;
        else delete job.dgxLeaseReceipt;
        if (snapshot.dgxSubmitPending) job.dgxSubmitPending = true;
        else delete job.dgxSubmitPending;
        if (snapshot.dgxSubmitStartedAt) job.dgxSubmitStartedAt = snapshot.dgxSubmitStartedAt;
        else delete job.dgxSubmitStartedAt;
        if (snapshot.dgxPreparedAdmission) {
          job.dgxPreparedAdmission = snapshot.dgxPreparedAdmission;
        } else delete job.dgxPreparedAdmission;
        if (snapshot.dgxPreparedAdmissionSha256) {
          job.dgxPreparedAdmissionSha256 = snapshot.dgxPreparedAdmissionSha256;
        } else delete job.dgxPreparedAdmissionSha256;
        if (snapshot.dgxTerminalDelivery) job.dgxTerminalDelivery = snapshot.dgxTerminalDelivery;
        else delete job.dgxTerminalDelivery;
        if (snapshot.dgxSuccessorAuthorization) {
          job.dgxSuccessorAuthorization = snapshot.dgxSuccessorAuthorization;
        } else delete job.dgxSuccessorAuthorization;
        job.logs.splice(0, job.logs.length, ...snapshot.logs);
      }
      throw error;
    }
  }

  /** Finalizes an exact terminal response from the sole submit without GET. */
  private commitTerminalDgxSubmitResponse(
    job: RuntimeJob,
    response: QueueSubmitResponse,
    preparedAdmission: AdmissionRequest,
    submitStartedAt: string,
    message: string,
  ): void {
    const observation = dgxSubmitTerminalObservation(
      response,
      job.id,
      preparedAdmission,
      submitStartedAt,
    );
    if (!observation) {
      throw new DgxLeaseAuthorityError(
        "Terminale DGX-Submit-Antwort war nicht exakt an den dauerhaften Einmal-Submit gebunden.",
      );
    }
    this.commitTerminalPreparedDgxObservation(
      job,
      response.job.job_id,
      observation,
      preparedAdmission,
      submitStartedAt,
      message,
    );
  }

  private commitTerminalPreparedDgxObservation(
    job: RuntimeJob,
    terminalDgxJobId: string,
    observation: DgxTerminalObservation,
    preparedAdmission: AdmissionRequest,
    submitStartedAt: string,
    message: string,
  ): void {
    if (!isDgxJobId(terminalDgxJobId)
      || !DGX_REMOTE_TERMINAL_STATES.has(observation.state)) {
      throw new DgxLeaseAuthorityError(
        "Terminale DGX-Evidenz besitzt keine gültige gebundene Jobidentität.",
      );
    }
    if (job.dgxTerminalReceipt) {
      if (job.dgxTerminalReceipt.dgxJobId === terminalDgxJobId) return;
      throw new DgxLeaseAuthorityError(
        "Terminale Submit-Antwort widerspricht einem bereits bestätigten DGX-Terminalbeleg.",
      );
    }
    if (!job.dgxSubmitPending
      || job.dgxJobId
      || job.dgxLeaseReceipt
      || job.dgxPreparedAdmissionSha256 !== preparedAdmissionSha256(preparedAdmission)
      || canonicalJson(job.dgxPreparedAdmission) !== canonicalJson(preparedAdmission)) {
      throw new DgxLeaseAuthorityError(
        "Terminale Submit-Antwort traf nicht auf den exakt vorbereiteten unbekannten Submit-Intent.",
      );
    }
    const successorAuthorization = job.dgxSuccessorAuthorization === undefined
      ? undefined
      : normalizeDgxSuccessorAuthorization(job.dgxSuccessorAuthorization);
    if (job.dgxSuccessorAuthorization !== undefined
      && (!successorAuthorization
        || successorAuthorization.phase !== "submit-pending"
        || canonicalJson(successorAuthorization) !== canonicalJson(job.dgxSuccessorAuthorization)
        || successorAuthorization.studioJobId !== job.id
        || successorAuthorization.preparedAdmissionSha256
          !== preparedAdmissionSha256(preparedAdmission)
        || successorAuthorization.authorizedAt !== canonicalIsoTimestamp(submitStartedAt)
        || canonicalJson(successorAuthorization.predecessorLeaseReceipt.preparedAdmission)
          !== canonicalJson(preparedAdmission)
        || successorAuthorization.predecessorDgxJobId === terminalDgxJobId)) {
      throw new DgxLeaseAuthorityError(
        "Terminaler DGX-Successor widerspricht seiner dauerhaften Einmal-Autorisierung.",
      );
    }

    const queueSnapshot = [...this.queue];
    const snapshot = {
      status: job.status,
      error: job.error,
      finishedAt: job.finishedAt,
      runtimeMs: job.runtimeMs,
      logs: [...job.logs],
      dgxMemoryWait: job.dgxMemoryWait ? structuredClone(job.dgxMemoryWait) : null,
      dgxJobId: job.dgxJobId,
      dgxJobTerminal: job.dgxJobTerminal,
      dgxSubmitPending: job.dgxSubmitPending,
      dgxSubmitStartedAt: job.dgxSubmitStartedAt,
      dgxPreparedAdmission: job.dgxPreparedAdmission
        ? structuredClone(job.dgxPreparedAdmission)
        : undefined,
      dgxPreparedAdmissionSha256: job.dgxPreparedAdmissionSha256,
      dgxLeaseReceipt: job.dgxLeaseReceipt
        ? structuredClone(job.dgxLeaseReceipt)
        : undefined,
      dgxTerminalDelivery: job.dgxTerminalDelivery
        ? structuredClone(job.dgxTerminalDelivery)
        : undefined,
      dgxTerminalReceipt: job.dgxTerminalReceipt
        ? structuredClone(job.dgxTerminalReceipt)
        : undefined,
      dgxSuccessorAuthorization: job.dgxSuccessorAuthorization
        ? structuredClone(job.dgxSuccessorAuthorization)
        : undefined,
    };
    const localIntentState: DgxTerminalState = jobWasCancelled(job) ? "cancelled" : "failed";
    const terminalReceipt: DgxTerminalReceipt = {
      schemaVersion: "ltx-studio-dgx-terminal-receipt.v1",
      studioJobId: job.id,
      dgxJobId: terminalDgxJobId,
      idempotencyKey: preparedAdmission.idempotency_key,
      localIntentState,
      remoteTerminalState: observation.state,
      confirmedAt: now(),
      evidence: structuredClone(observation.evidence),
    };
    const consumedSuccessorAuthorization = successorAuthorization
      ? consumeDgxSuccessorAuthorization(
          successorAuthorization,
          terminalDgxJobId,
          "terminal",
          terminalReceipt,
        )
      : undefined;
    if (successorAuthorization && !consumedSuccessorAuthorization) {
      throw new DgxLeaseAuthorityError(
        "Terminale DGX-Successor-Autorisierung konnte nicht exakt einmal konsumiert werden.",
      );
    }
    const queueIndex = this.queue.indexOf(job.id);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    if (!jobWasCancelled(job)) {
      job.status = "failed";
      job.error = message;
      job.finishedAt = now();
      if (job.startedAt) job.runtimeMs = Date.now() - Date.parse(job.startedAt);
    }
    job.dgxMemoryWait = null;
    job.dgxJobId = terminalDgxJobId;
    job.dgxJobTerminal = true;
    delete job.dgxSubmitPending;
    delete job.dgxSubmitStartedAt;
    delete job.dgxPreparedAdmission;
    delete job.dgxPreparedAdmissionSha256;
    delete job.dgxLeaseReceipt;
    delete job.dgxTerminalDelivery;
    job.dgxTerminalReceipt = terminalReceipt;
    if (consumedSuccessorAuthorization) {
      job.dgxSuccessorAuthorization = consumedSuccessorAuthorization;
    }
    this.appendLog(
      job,
      `${message} Exakte terminale Einmal-Submit-Antwort: ${terminalDgxJobId} ist ${observation.state}.`,
    );
    try {
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        this.queue.splice(0, this.queue.length, ...queueSnapshot);
        job.status = snapshot.status;
        job.error = snapshot.error;
        job.finishedAt = snapshot.finishedAt;
        job.runtimeMs = snapshot.runtimeMs;
        job.logs.splice(0, job.logs.length, ...snapshot.logs);
        job.dgxMemoryWait = snapshot.dgxMemoryWait;
        job.dgxJobId = snapshot.dgxJobId;
        job.dgxJobTerminal = snapshot.dgxJobTerminal;
        if (snapshot.dgxSubmitPending) job.dgxSubmitPending = true;
        else delete job.dgxSubmitPending;
        if (snapshot.dgxSubmitStartedAt) job.dgxSubmitStartedAt = snapshot.dgxSubmitStartedAt;
        else delete job.dgxSubmitStartedAt;
        if (snapshot.dgxPreparedAdmission) job.dgxPreparedAdmission = snapshot.dgxPreparedAdmission;
        else delete job.dgxPreparedAdmission;
        if (snapshot.dgxPreparedAdmissionSha256) {
          job.dgxPreparedAdmissionSha256 = snapshot.dgxPreparedAdmissionSha256;
        } else delete job.dgxPreparedAdmissionSha256;
        if (snapshot.dgxLeaseReceipt) job.dgxLeaseReceipt = snapshot.dgxLeaseReceipt;
        else delete job.dgxLeaseReceipt;
        if (snapshot.dgxTerminalDelivery) job.dgxTerminalDelivery = snapshot.dgxTerminalDelivery;
        else delete job.dgxTerminalDelivery;
        if (snapshot.dgxTerminalReceipt) job.dgxTerminalReceipt = snapshot.dgxTerminalReceipt;
        else delete job.dgxTerminalReceipt;
        if (snapshot.dgxSuccessorAuthorization) {
          job.dgxSuccessorAuthorization = snapshot.dgxSuccessorAuthorization;
        } else delete job.dgxSuccessorAuthorization;
      }
      throw error;
    }
  }

  private authorizeDgxSuccessorSubmit(
    job: RuntimeJob,
    predecessorReceipt: DgxLeaseReceipt,
    replayEvidence: DgxSuccessorReplayEvidence,
  ): DgxSuccessorAuthorization | null {
    if (job.dgxSuccessorAuthorization !== undefined) {
      if (dgxSuccessorAuthorizationBindsPredecessor(
        job.dgxSuccessorAuthorization,
        predecessorReceipt,
      )) return null;
      throw new DgxLeaseAuthorityError(
        "Eine vorhandene DGX-Successor-Generation widerspricht der exakten Replay-Lease.",
      );
    }
    const currentReceipt = normalizeDgxLeaseReceipt(job.dgxLeaseReceipt);
    if (this.jobShouldStop(job)
      || job.dgxSubmitPending
      || job.dgxTerminalReceipt
      || job.dgxTerminalDelivery
      || !currentReceipt
      || job.dgxJobId !== predecessorReceipt.dgxJobId
      || canonicalJson(currentReceipt) !== canonicalJson(predecessorReceipt)
      || replayEvidence.replayBoundJobId !== predecessorReceipt.dgxJobId) {
      throw new DgxLeaseAuthorityError(
        "DGX-Successor-Autorisierung verlor vor ihrem Commit die alte Lease-Bindung.",
      );
    }
    const authorizedAt = now();
    const requestSha256 = dgxRuntimeRequestSha256(predecessorReceipt.preparedAdmission);
    if (!requestSha256) {
      throw new DgxLeaseAuthorityError(
        "Der versiegelte DGX-Successor-Request besitzt keinen kanonischen Runtime-Digest.",
      );
    }
    const authorization: DgxSuccessorAuthorization = {
      schemaVersion: "ltx-studio-dgx-successor-authorization.v1",
      generation: 1,
      phase: "submit-pending",
      successorToken: randomBytes(32).toString("hex"),
      studioJobId: job.id,
      predecessorDgxJobId: predecessorReceipt.dgxJobId,
      predecessorLeaseReceipt: structuredClone(predecessorReceipt),
      predecessorLeaseReceiptSha256: dgxAuthoritySha256(predecessorReceipt),
      preparedAdmissionSha256: predecessorReceipt.preparedAdmissionSha256,
      requestSha256,
      authorizedAt,
      replayEvidence: structuredClone(replayEvidence),
    };
    const normalized = normalizeDgxSuccessorAuthorization(authorization);
    if (!normalized || canonicalJson(normalized) !== canonicalJson(authorization)) {
      throw new DgxLeaseAuthorityError(
        "DGX-Successor-Autorisierung war nicht kanonisch persistierbar.",
      );
    }
    const snapshot = {
      dgxJobId: job.dgxJobId,
      dgxJobTerminal: job.dgxJobTerminal,
      dgxLeaseReceipt: job.dgxLeaseReceipt
        ? structuredClone(job.dgxLeaseReceipt)
        : undefined,
      dgxSubmitPending: job.dgxSubmitPending,
      dgxSubmitStartedAt: job.dgxSubmitStartedAt,
      dgxPreparedAdmission: job.dgxPreparedAdmission
        ? structuredClone(job.dgxPreparedAdmission)
        : undefined,
      dgxPreparedAdmissionSha256: job.dgxPreparedAdmissionSha256,
      dgxSuccessorAuthorization: job.dgxSuccessorAuthorization
        ? structuredClone(job.dgxSuccessorAuthorization)
        : undefined,
      logs: [...job.logs],
    };
    job.dgxJobId = null;
    job.dgxJobTerminal = false;
    delete job.dgxLeaseReceipt;
    job.dgxSubmitPending = true;
    job.dgxSubmitStartedAt = authorizedAt;
    job.dgxPreparedAdmission = structuredClone(predecessorReceipt.preparedAdmission);
    job.dgxPreparedAdmissionSha256 = predecessorReceipt.preparedAdmissionSha256;
    job.dgxSuccessorAuthorization = normalized;
    this.appendLog(
      job,
      `DGX-Successor-Generation 1 wurde vor jedem neuen POST atomar autorisiert: `
        + `${predecessorReceipt.dgxJobId} war exakt replay-gebunden, terminal, reservierungsfrei und nie gestartet; `
        + `Token ${authorization.successorToken.slice(0, 12)}… ist dauerhaft gebunden.`,
    );
    try {
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        job.dgxJobId = snapshot.dgxJobId;
        job.dgxJobTerminal = snapshot.dgxJobTerminal;
        if (snapshot.dgxLeaseReceipt) job.dgxLeaseReceipt = snapshot.dgxLeaseReceipt;
        else delete job.dgxLeaseReceipt;
        if (snapshot.dgxSubmitPending) job.dgxSubmitPending = true;
        else delete job.dgxSubmitPending;
        if (snapshot.dgxSubmitStartedAt) job.dgxSubmitStartedAt = snapshot.dgxSubmitStartedAt;
        else delete job.dgxSubmitStartedAt;
        if (snapshot.dgxPreparedAdmission) job.dgxPreparedAdmission = snapshot.dgxPreparedAdmission;
        else delete job.dgxPreparedAdmission;
        if (snapshot.dgxPreparedAdmissionSha256) {
          job.dgxPreparedAdmissionSha256 = snapshot.dgxPreparedAdmissionSha256;
        } else delete job.dgxPreparedAdmissionSha256;
        if (snapshot.dgxSuccessorAuthorization) {
          job.dgxSuccessorAuthorization = snapshot.dgxSuccessorAuthorization;
        } else delete job.dgxSuccessorAuthorization;
        job.logs.splice(0, job.logs.length, ...snapshot.logs);
      }
      throw error;
    }
    return normalized;
  }

  private async performAuthorizedDgxSuccessorSubmit(
    job: RuntimeJob,
    authorizationInput: DgxSuccessorAuthorization,
  ): Promise<DgxSuccessorSubmitOutcome> {
    const authorization = normalizeDgxSuccessorAuthorization(job.dgxSuccessorAuthorization);
    const preparedAdmission = normalizePreparedAdmission(job.dgxPreparedAdmission);
    const submitStartedAt = canonicalIsoTimestamp(job.dgxSubmitStartedAt);
    if (!authorization
      || authorization.phase !== "submit-pending"
      || canonicalJson(authorization) !== canonicalJson(authorizationInput)
      || canonicalJson(authorization) !== canonicalJson(job.dgxSuccessorAuthorization)
      || !job.dgxSubmitPending
      || job.dgxJobId
      || job.dgxLeaseReceipt
      || !preparedAdmission
      || !submitStartedAt
      || submitStartedAt !== authorization.authorizedAt
      || job.dgxPreparedAdmissionSha256 !== authorization.preparedAdmissionSha256
      || preparedAdmissionSha256(preparedAdmission) !== authorization.preparedAdmissionSha256
      || canonicalJson(preparedAdmission)
        !== canonicalJson(authorization.predecessorLeaseReceipt.preparedAdmission)) {
      throw new DgxLeaseAuthorityError(
        "Der autorisierte DGX-Successor verlor vor seinem token-idempotenten POST die dauerhafte Generation.",
      );
    }
    if (this.shuttingDown || this.persistenceHold) {
      return { kind: "ambiguous" };
    }
    if (!this.dgxAdmissionOperations.successor) {
      throw new DgxLeaseAuthorityError(
        "Der DGX-Client besitzt keinen Conditional-Successor-Transport; normaler Submit-Fallback ist verboten.",
      );
    }
    const abortController = new AbortController();
    job.dgxAdmissionAbortController = abortController;
    let validated: DgxValidatedConditionalSuccessorResult;
    try {
      const response = await this.dgxAdmissionOperations.successor(
        authorization.predecessorDgxJobId,
        authorization.successorToken,
        structuredClone(preparedAdmission),
        abortController.signal,
      );
      const retained = validateRetainedConditionalSuccessorResult(
        response,
        authorization,
        preparedAdmission,
      );
      if (!retained) {
        throw new DgxLeaseAuthorityError(
          "DGX-Conditional-Successor lieferte keine feldgeschlossene token-, Vorgänger- und Request-gebundene Antwort.",
        );
      }
      validated = retained;
    } catch (error) {
      if (error instanceof DgxLeaseAuthorityError) throw error;
      if (error instanceof RuntimeApiError && error.statusCode === 410) {
        const reaped = validateReapedConditionalSuccessorResult(
          error.payload,
          authorization,
          preparedAdmission,
        );
        if (!reaped) {
          throw new DgxLeaseAuthorityError(
            "DGX-Conditional-Successor-410 besaß keinen exakt gebundenen feldgeschlossenen Tombstone.",
          );
        }
        validated = reaped;
      } else if (error instanceof RuntimeApiError
        && !dgxConditionalSuccessorStatusIsAmbiguous(error.statusCode)) {
        throw new DgxLeaseAuthorityError(
          `DGX-Conditional-Successor wurde autoritativ mit HTTP ${error.statusCode} abgelehnt; `
            + "definitive Protokollantworten erlauben keinen normalen Submit-Fallback.",
        );
      } else {
        this.appendLog(
          job,
          `Der token-idempotente DGX-Successor-POST blieb ohne autoritative Antwort; `
            + `Generation 1 wird ausschließlich über denselben Endpunkt und Token erneut abgeglichen: ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
        this.changed();
        return { kind: "ambiguous" };
      }
    } finally {
      if (job.dgxAdmissionAbortController === abortController) {
        this.clearCancellationSettlementTransient(
          job,
          () => delete job.dgxAdmissionAbortController,
        );
      }
    }
    try {
      if (validated.kind === "positive") {
        const terminalIntent = this.jobShouldStop(job);
        this.commitDgxLeaseReceipt(
          job,
          validated.remote,
          validated.receipt,
          terminalIntent,
        );
        const logsBeforeConsumedMessage = [...job.logs];
        this.appendLog(
          job,
          `DGX-Successor-Generation 1 wurde token-idempotent konsumiert: ${validated.remote.job_id} `
            + `ist ${validated.remote.state} (${validated.result.outcome}).`,
        );
        try {
          this.changed();
        } catch (error) {
          if (this.persistenceHold || isJobPersistenceHoldError(error)) throw error;
          job.logs.splice(0, job.logs.length, ...logsBeforeConsumedMessage);
          process.stderr.write(
            `LTX Studio konnte das Diagnose-Log des bereits konsumierten DGX-Successors ${validated.remote.job_id} nicht persistieren: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
        if (terminalIntent) {
          await this.flushDgxTerminalDelivery(job);
          return { kind: "terminal" };
        }
        return { kind: "positive", remote: validated.remote };
      }
      this.commitTerminalPreparedDgxObservation(
        job,
        validated.result.successor_job_id,
        validated.observation,
        preparedAdmission,
        authorization.authorizedAt,
        `DGX-Successor-Generation 1 ist tokengebunden ${validated.result.outcome} als `
          + `${validated.observation.state} bestätigt.`,
      );
      return { kind: "terminal" };
    } catch (error) {
      if (error instanceof DgxLeaseAuthorityError || isJobPersistenceHoldError(error)) throw error;
      this.appendLog(
        job,
        `Der lokale Successor-Commit blieb nach autoritativer Token-Antwort unklar; `
          + `derselbe Endpunkt und Token werden wiederholt: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.changed();
      return { kind: "ambiguous" };
    }
  }

  private async advanceDgxSuccessorSubmit(
    job: RuntimeJob,
    freshlyAuthorized?: DgxSuccessorAuthorization,
  ): Promise<DgxSuccessorSubmitOutcome | { kind: "follower" }> {
    if (!freshlyAuthorized && job.dgxSuccessorSubmitInFlight) {
      await job.dgxSuccessorSubmitInFlight;
      return { kind: "follower" };
    }
    const firstAuthorization = normalizeDgxSuccessorAuthorization(
      freshlyAuthorized ?? job.dgxSuccessorAuthorization,
    );
    if (!firstAuthorization
      || (freshlyAuthorized
        && canonicalJson(firstAuthorization) !== canonicalJson(freshlyAuthorized))) {
      throw new DgxLeaseAuthorityError(
        "Die persistierte DGX-Successor-Autorisierung ist für den Token-Retry ungültig.",
      );
    }
    if (firstAuthorization.phase === "consumed") return { kind: "follower" };
    let authorization = firstAuthorization;
    while (!this.shuttingDown && !this.persistenceHold) {
      const operation = this.performAuthorizedDgxSuccessorSubmit(job, authorization);
      job.dgxSuccessorSubmitInFlight = operation;
      let outcome: DgxSuccessorSubmitOutcome;
      try {
        outcome = await operation;
      } finally {
        if (job.dgxSuccessorSubmitInFlight === operation) {
          this.clearCancellationSettlementTransient(
            job,
            () => delete job.dgxSuccessorSubmitInFlight,
          );
        }
      }
      if (outcome.kind !== "ambiguous") return outcome;
      if (this.jobShouldStop(job)
        || !await this.waitForDelay(job, DGX_SUBMIT_RECONCILE_POLL_MS)) {
        return outcome;
      }
      const current = normalizeDgxSuccessorAuthorization(job.dgxSuccessorAuthorization);
      if (!current
        || current.phase !== "submit-pending"
        || canonicalJson(current) !== canonicalJson(authorization)) {
        throw new DgxLeaseAuthorityError(
          "DGX-Successor-Tokenbindung änderte sich während des identischen Retries.",
        );
      }
      authorization = current;
    }
    return { kind: "ambiguous" };
  }

  private async reconcilePendingDgxSubmit(
    job: RuntimeJob,
  ): Promise<QueueJobSummary | null | undefined> {
    if (!job.dgxSubmitPending) return null;
    const preparedAdmission = normalizePreparedAdmission(job.dgxPreparedAdmission);
    const submitStartedAt = canonicalIsoTimestamp(job.dgxSubmitStartedAt);
    const successorAuthorization = job.dgxSuccessorAuthorization === undefined
      ? undefined
      : normalizeDgxSuccessorAuthorization(job.dgxSuccessorAuthorization);
    if (!preparedAdmission
      || !submitStartedAt
      || job.dgxPreparedAdmissionSha256 !== preparedAdmissionSha256(preparedAdmission)
      || (job.dgxSuccessorAuthorization !== undefined
        && (!successorAuthorization
          || successorAuthorization.phase !== "submit-pending"
          || canonicalJson(successorAuthorization) !== canonicalJson(job.dgxSuccessorAuthorization)
          || successorAuthorization.authorizedAt !== submitStartedAt
          || successorAuthorization.preparedAdmissionSha256
            !== job.dgxPreparedAdmissionSha256))) {
      this.appendLog(
        job,
        "DGX-Submit-Ausgang bleibt fail-closed: Der vollständige persistierte Einmal-Submit-Vertrag ist ungültig.",
      );
      this.changed();
      return undefined;
    }
    if (successorAuthorization) {
      try {
        const outcome = await this.advanceDgxSuccessorSubmit(job);
        return outcome.kind === "positive" ? outcome.remote : undefined;
      } catch (error) {
        if (this.persistenceHold || isJobPersistenceHoldError(error)) return undefined;
        if (error instanceof DgxLeaseAuthorityError) {
          this.enterPersistenceHold(
            error,
            "DGX-Conditional-Successor-Recovery verlor Token-, Vorgänger- oder Request-Autorität",
          );
          return undefined;
        }
        throw error;
      }
    }
    let lastError = "";
    while (!this.jobShouldStop(job) && job.dgxSubmitPending) {
      try {
        if (!this.dgxAdmissionOperations.list) {
          throw new Error("Die DGX-Queue unterstützt keine positive Submit-Discovery.");
        }
        const response = await this.dgxAdmissionOperations.list();
        if (this.jobShouldStop(job)) return undefined;
        const remote = exactPositiveQueueCandidate(
          response,
          job.id,
          preparedAdmission,
          submitStartedAt,
        );
        if (!remote) {
          const message = "noch kein exakt gebundener positiver Queue-Record sichtbar; Abwesenheit ist kein Gegenbeweis";
          if (message !== lastError) {
            lastError = message;
            this.appendLog(job, `DGX-Submit-Discovery wartet: ${message}.`);
            this.changed();
          }
          if (!await this.waitForDelay(job, DGX_SUBMIT_RECONCILE_POLL_MS)) return undefined;
          continue;
        }
        const leaseReceipt = dgxLeaseReceiptFromQueuePositive(
          remote,
          job.id,
          preparedAdmission,
          submitStartedAt,
        );
        this.commitDgxLeaseReceipt(job, remote, leaseReceipt, false);
        const logsBeforeDiscoveryMessage = [...job.logs];
        this.appendLog(
          job,
          `DGX-Submit nach unklarer Antwort atomar per positiver Queue-Evidenz gebunden: `
            + `${remote.job_id} ist ${remote.state}.`,
        );
        try {
          this.changed();
        } catch (error) {
          if (this.persistenceHold || isJobPersistenceHoldError(error)) return undefined;
          // The lease adoption above is already durable authority. A proven
          // pre-rename failure of this optional diagnostic must not turn that
          // remote success back into an unknown submit, strand the lease, or
          // make the caller leave a queue-less local job behind.
          job.logs.splice(0, job.logs.length, ...logsBeforeDiscoveryMessage);
          process.stderr.write(
            `LTX Studio konnte das Diagnose-Log der bereits dauerhaft gebundenen DGX-Lease ${remote.job_id} nicht persistieren: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
        return remote;
      } catch (error) {
        if (this.persistenceHold || isJobPersistenceHoldError(error)) return undefined;
        if (error instanceof DgxLeaseAuthorityError) {
          this.enterPersistenceHold(error, "positive DGX-Submit-Discovery war mehrdeutig");
          return undefined;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastError) {
          lastError = message;
          this.appendLog(job, `DGX-Submit-Abgleich wartet auf eine autoritative Queue-Antwort: ${message}`);
          this.changed();
        }
      }
      if (!await this.waitForDelay(job, DGX_SUBMIT_RECONCILE_POLL_MS)) {
        return undefined;
      }
    }
    return undefined;
  }

  private scheduleTerminalPendingDgxSubmitReconciliation(
    job: RuntimeJob,
    delayMs = DGX_SUBMIT_RECONCILE_POLL_MS,
  ): void {
    if (this.shuttingDown
      || this.persistenceHold
      || !job.dgxSubmitPending
      || isActiveJobStatus(job.status)
      || job.dgxSubmitReconcileRetry
      || job.dgxSubmitReconcileInFlight
      || job.dgxTerminalDelivery
      || job.dgxTerminalDeliveryInFlight) return;
    job.dgxSubmitReconcileRetry = setTimeout(() => {
      delete job.dgxSubmitReconcileRetry;
      const reconciliation = this.reconcileTerminalPendingDgxSubmit(job);
      job.dgxSubmitReconcileInFlight = reconciliation;
      const observedReconciliation = reconciliation.finally(() => {
        if (job.dgxSubmitReconcileInFlight === reconciliation) {
          this.clearCancellationSettlementTransient(
            job,
            () => delete job.dgxSubmitReconcileInFlight,
          );
        }
        if (job.dgxSubmitPending && !isActiveJobStatus(job.status)) {
          const retryDelayMs = job.dgxSubmitReconcileDelayMs;
          delete job.dgxSubmitReconcileDelayMs;
          this.scheduleTerminalPendingDgxSubmitReconciliation(job, retryDelayMs);
        }
      });
      this.runDetached(
        observedReconciliation,
        `terminaler DGX-Submit-Abgleich ${job.id}`,
      );
    }, delayMs);
    job.dgxSubmitReconcileRetry.unref();
  }

  private async reconcileTerminalPendingDgxSubmit(job: RuntimeJob): Promise<void> {
    if (this.shuttingDown || this.persistenceHold || !job.dgxSubmitPending || isActiveJobStatus(job.status)) return;
    const preparedAdmission = normalizePreparedAdmission(job.dgxPreparedAdmission);
    const submitStartedAt = canonicalIsoTimestamp(job.dgxSubmitStartedAt);
    const successorAuthorization = job.dgxSuccessorAuthorization === undefined
      ? undefined
      : normalizeDgxSuccessorAuthorization(job.dgxSuccessorAuthorization);
    if (!preparedAdmission
      || !submitStartedAt
      || job.dgxPreparedAdmissionSha256 !== preparedAdmissionSha256(preparedAdmission)
      || (job.dgxSuccessorAuthorization !== undefined
        && (!successorAuthorization
          || successorAuthorization.phase !== "submit-pending"
          || canonicalJson(successorAuthorization) !== canonicalJson(job.dgxSuccessorAuthorization)
          || successorAuthorization.authorizedAt !== submitStartedAt
          || successorAuthorization.preparedAdmissionSha256
            !== job.dgxPreparedAdmissionSha256))) {
      this.appendLog(
        job,
        "Terminaler DGX-Submit-Ausgang bleibt ohne vollständigen Einmal-Submit-Vertrag fail-closed unaufgelöst.",
      );
      this.changed();
      return;
    }
    try {
      if (successorAuthorization) {
        const outcome = await this.advanceDgxSuccessorSubmit(job);
        if (outcome.kind === "positive") {
          await this.flushDgxTerminalDelivery(job);
          this.scheduleDgxTerminalRetry(job);
        }
        return;
      }
      if (!this.dgxAdmissionOperations.list) {
        throw new Error("Die DGX-Queue unterstützt keine positive Submit-Discovery.");
      }
      const response = await this.dgxAdmissionOperations.list();
      if (this.shuttingDown
        || this.persistenceHold
        || !job.dgxSubmitPending
        || isActiveJobStatus(job.status)) return;
      const remote = exactPositiveQueueCandidate(
        response,
        job.id,
        preparedAdmission,
        submitStartedAt,
      );
      if (!remote) {
        this.appendLog(
          job,
          "Terminaler DGX-Submit bleibt settling: Es ist noch kein exakt gebundener positiver Queue-Record sichtbar; Abwesenheit beendet den Intent nie.",
        );
        this.changed();
        return;
      }
      const leaseReceipt = dgxLeaseReceiptFromQueuePositive(
        remote,
        job.id,
        preparedAdmission,
        submitStartedAt,
      );
      this.commitDgxLeaseReceipt(job, remote, leaseReceipt, true);
      this.appendLog(
        job,
        `Terminaler DGX-Submit-Ausgang atomar per positiver Queue-Evidenz gebunden: ${remote.job_id} ist `
          + `${remote.state} und wird ohne Compute-Start terminal bestätigt.`,
      );
      this.changed();
      await this.flushDgxTerminalDelivery(job);
      this.scheduleDgxTerminalRetry(job);
    } catch (error) {
      if (this.persistenceHold || isJobPersistenceHoldError(error)) return;
      if (error instanceof DgxLeaseAuthorityError) {
        this.enterPersistenceHold(
          error,
          successorAuthorization
            ? "terminaler DGX-Conditional-Successor-Abgleich verlor seine gebundene Autorität"
            : "terminale positive DGX-Submit-Discovery war mehrdeutig",
        );
        return;
      }
      this.appendLog(
        job,
        `Terminaler DGX-Submit-Abgleich bleibt vorgemerkt: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.changed();
      // The first durable write after adopting an ambiguous remote lease may
      // have failed after the in-memory terminal delivery was prepared. Only
      // arm its retry after this recovery write succeeded; otherwise a
      // persisted lease could be left without either reconciliation timer.
      if (job.dgxTerminalDelivery) this.scheduleDgxTerminalRetry(job, 0);
    }
  }

  private async settleDgxCooperativeQueueContractError(
    job: RuntimeJob,
    error: DgxCooperativeQueueContractError,
  ): Promise<false> {
    const terminalState = dgxCooperativeContractTerminalState(error.observedRemoteState);
    await this.failDgxJob(
      job,
      error.message,
      "cooperative orchestrator contract mismatch before LTX allocation",
      terminalState,
    );
    return false;
  }

  private async confirmDgxCooperativeQueueContract(
    job: RuntimeJob,
    remote: QueueJobSummary,
    boundary: string,
  ): Promise<boolean> {
    try {
      assertDgxCooperativeQueueContract(job, remote, boundary);
      return true;
    } catch (error) {
      if (error instanceof DgxCooperativeQueueContractError) {
        return this.settleDgxCooperativeQueueContractError(job, error);
      }
      throw error;
    }
  }

  private async waitForDgxQueueStart(
    job: RuntimeJob,
    estimatedMemoryGiBOverride?: number,
  ): Promise<boolean> {
    if (this.persistenceHold) return false;
    // Defense in depth: no queue admission may happen for an unclassified or
    // explicitly CPU-only job.
    if (!this.classifyExecution(job, "dgx")) return false;
    if (!await this.waitForLocalPreAdmissionResources(job)) return false;
    while (!this.shuttingDown && isActiveJobStatus(job.status)) {
      if (job.dgxSubmitPending) {
        const recovered = await this.reconcilePendingDgxSubmit(job);
        if (recovered === undefined) return false;
        if (recovered) {
          this.observeQueueJobMemoryWait(job, recovered);
          if (DGX_POSITIVE_DISCOVERY_STATES.has(recovered.state)
            && !await this.confirmDgxCooperativeQueueContract(
              job,
              recovered,
              "in der positiven Submit-Recovery",
            )) return false;
          if (recovered.state === "accepted") {
            const outcome = await this.startAcceptedDgxJob(job, recovered);
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
      let response: QueueSubmitResponse;
      let responseLeaseReceipt: DgxLeaseReceipt | null = null;
      const submitAbortController = new AbortController();
      try {
        this.revalidateRuntimeTrustBoundary(job, "DGX-Submit");
      } catch (error) {
        this.failJob(job, error instanceof Error ? error.message : String(error));
        return false;
      }
      try {
        this.appendLog(job, "DGX-Queue: Renderbedarf wird beim Orchestrator eingereicht; laufende Anwendungen werden nicht direkt beendet.");
        const estimate = estimateRequest(job.request, this.list());
        const requestedMemoryGiB = queueAdmissionMemoryGiB(
          job.request,
          estimatedMemoryGiBOverride ?? estimate.memoryGiB,
          job.id,
        );
        const requestedMemoryBasis = estimatedMemoryGiBOverride === undefined
          ? estimate.memoryBasis
          : undefined;
        const [preparedAdmission] = buildAdmissionRequests(
          job.request,
          requestedMemoryGiB,
          job.id,
        );
        this.appendLog(
          job,
          `DGX-Queue: Modellbedarf ${requestedMemoryGiB} GiB RAM und `
            + `${estimate.outputGiB.toFixed(2)} GiB Ausgabe`
            + `${requestedMemoryBasis ? `; RAM-Basis ${requestedMemoryBasis}` : ""}`
            + "; der Orchestrator entscheidet das Start-Fence.",
        );
        job.dgxSubmitPending = true;
        job.dgxSubmitStartedAt = now();
        job.dgxPreparedAdmission = structuredClone(preparedAdmission);
        job.dgxPreparedAdmissionSha256 = preparedAdmissionSha256(preparedAdmission);
        job.dgxAdmissionAbortController = submitAbortController;
        this.changed();
        const submitResponse = await this.dgxAdmissionOperations.submit(
          preparedAdmission,
          submitAbortController.signal,
        );
        if (this.persistenceHold) return false;
        if (!dgxSubmitResponseCallerBound(submitResponse, job.id)) {
          throw new Error(
            "DGX-Queue-Submit lieferte keine exakt caller- und idempotenzgebundene Antwort.",
          );
        }
        if (DGX_POSITIVE_DISCOVERY_STATES.has(submitResponse.job.state)) {
          responseLeaseReceipt = dgxLeaseReceiptFromSubmit(
          submitResponse,
          job.id,
          preparedAdmission,
          job.dgxSubmitStartedAt!,
          );
        }
        response = submitResponse;
        this.clearCancellationSettlementTransient(
          job,
          () => delete job.dgxAdmissionAbortController,
        );
      } catch (error) {
        if (this.persistenceHold || isJobPersistenceHoldError(error)) return false;
        this.clearCancellationSettlementTransient(
          job,
          () => delete job.dgxAdmissionAbortController,
        );
        const message = error instanceof Error ? error.message : "DGX-Queue-Submit ist fehlgeschlagen.";
        this.appendLog(
          job,
          `Der initiale DGX-Queue-Submit endete ohne autoritative Antwort; bis zu positiver `
            + `Queue-Evidenz wird er nie erneut gesendet und ausschließlich read-only abgeglichen: ${message}`,
        );
        this.changed();
        if (this.jobShouldStop(job)) {
          if (job.dgxSubmitPending) {
            this.scheduleTerminalPendingDgxSubmitReconciliation(job, 0);
          }
          return false;
        }
        continue;
      }

      const { admission, job: queueJob } = response;
      if (this.jobShouldStop(job)) {
        if (!responseLeaseReceipt) {
          this.commitTerminalDgxSubmitResponse(
            job,
            response,
            job.dgxPreparedAdmission!,
            job.dgxSubmitStartedAt!,
            "Der einzige DGX-Submit wurde während des lokalen Abbruchs bereits remote terminal; es existiert keine aktive Lease.",
          );
          return false;
        }
        this.commitDgxLeaseReceipt(job, queueJob, responseLeaseReceipt, true);
        if (job.dgxSubmitReconcileRetry) {
          clearTimeout(job.dgxSubmitReconcileRetry);
          delete job.dgxSubmitReconcileRetry;
        }
        await this.flushDgxTerminalDelivery(job);
        return false;
      }
      this.observeQueueJobMemoryWait(job, queueJob, admission.blocker);
      if (job.dgxSubmitReconcileRetry) {
        clearTimeout(job.dgxSubmitReconcileRetry);
        delete job.dgxSubmitReconcileRetry;
      }
      if (responseLeaseReceipt) {
        this.commitDgxLeaseReceipt(job, queueJob, responseLeaseReceipt, false);
        if (!await this.confirmDgxCooperativeQueueContract(
          job,
          queueJob,
          "in der positiven Queue-Submit-Antwort",
        )) return false;
      }
      this.appendLog(
        job,
        `DGX-Queue: ${queueJob.job_id} ${queueJob.state}; Admission ${admission.decision}`
          + `${admission.reason ? ` - ${admission.reason}` : ""}.`,
      );
      if (queueJob.state === "accepted" && admission.decision === "accepted") {
        const outcome = await this.startAcceptedDgxJob(job, queueJob);
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

      this.commitTerminalDgxSubmitResponse(
        job,
        response,
        job.dgxPreparedAdmission!,
        job.dgxSubmitStartedAt!,
        `DGX-Orchestrator beendete den einzigen sicheren Submit als ${queueJob.state}: `
          + `${decisionMessage(admission)}. Ein Neuversuch benötigt einen neuen Studio-Job mit neuer UUID.`,
      );
      return false;
    }
    return false;
  }

  private async waitForQueuedDgxJob(job: RuntimeJob, initialDelayMs: number): Promise<DgxStartOutcome> {
    let replayAt = Date.now() + Math.max(0, initialDelayMs);
    let delayMs = Math.min(DGX_START_FENCE_RETRY_MS, Math.max(0, initialDelayMs));
    while (!this.shuttingDown && isActiveJobStatus(job.status) && job.dgxJobId) {
      this.appendLog(job, `DGX-Queue-Job wartet beim Orchestrator; nächste Prüfung in ${(delayMs / 1000).toFixed(0)} s.`);
      this.changed();
      if (!await this.waitForDelay(job, delayMs)) return "stopped";
      let queueJob: QueueJobSummary;
      let terminalObservation: DgxTerminalObservation | null = null;
      let pollReceipt: DgxLeaseReceipt | null = null;
      try {
        const expectedDgxJobId = job.dgxJobId;
        pollReceipt = requireDgxLeaseAuthority(job);
        const response = await this.dgxQueueOperations.read(expectedDgxJobId);
        const boundJob = dgxResponseBoundJob(response, "job-read", expectedDgxJobId, job.id);
        if (!boundJob) {
          throw new DgxLeaseAuthorityError(
            "DGX-Queue-Status ist nicht exakt an diesen Studio-Job gebunden.",
          );
        }
        if (this.jobShouldStop(job) || job.dgxJobId !== expectedDgxJobId) return "stopped";
        queueJob = boundJob;
        terminalObservation = dgxResponseTerminalObservation(
          response,
          "job-read",
          expectedDgxJobId,
          job.id,
        );
      } catch (error) {
        if (error instanceof DgxLeaseAuthorityError) {
          this.enterPersistenceHold(error, "DGX-Queue-Poll verlor seine Lease-Autorität");
          return "stopped";
        }
        if (isJobPersistenceHoldError(error)) return "stopped";
        const goneObservation = pollReceipt
          ? dgxGoneTerminalObservation(error, pollReceipt)
          : null;
        if (goneObservation && pollReceipt) {
          if (this.jobShouldStop(job)) {
            this.commitCancelledDgxReplayTerminalObservation(
              job,
              pollReceipt,
              goneObservation,
              "abgebrochener Queue-Poll erhielt exakten HTTP-410-Beleg",
            );
            return "stopped";
          }
          const message = `DGX-Queue-Job ist per 410-Beleg terminal: ${goneObservation.state}. `
            + "Derselbe Studio-Job wird niemals erneut submitten.";
          this.failJob(job, message);
          if (job.dgxTerminalDelivery) {
            this.commitDgxTerminalReceipt(job, goneObservation, "Queue-Poll erhielt exakten HTTP-410-Beleg");
          }
          return "stopped";
        }
        if (this.jobShouldStop(job)) return "stopped";
        const message = error instanceof Error ? error.message : "DGX-Queue-Status konnte nicht gelesen werden.";
        this.appendLog(job, `DGX-Queue-Status vorübergehend nicht lesbar: ${message}. Prüfung wird wiederholt.`);
        this.changed();
        delayMs = 30_000;
        continue;
      }
      if (this.jobShouldStop(job)) return "stopped";
      this.observeQueueJobMemoryWait(job, queueJob);
      if (DGX_POSITIVE_DISCOVERY_STATES.has(queueJob.state)
        && !await this.confirmDgxCooperativeQueueContract(
          job,
          queueJob,
          "im positiven Queue-Poll",
        )) return "stopped";
      this.appendLog(job, `DGX-Queue-Status: ${queueJob.job_id} ${queueJob.state}${queueJob.reason ? ` - ${queueJob.reason}` : ""}.`);
      if (queueJob.state === "queued" && Date.now() >= replayAt) {
        try {
          const replayResult = await this.replayBoundDgxQueueAdmission(job);
          const replayReceipt = replayResult.receipt;
          if (replayResult.kind === "successor-already-authorized") {
            const successorOutcome = await this.advanceDgxSuccessorSubmit(job);
            if (successorOutcome.kind !== "positive") return "stopped";
            queueJob = successorOutcome.remote;
            this.observeDgxMemoryWait(job, queueJobMemoryBlocker(queueJob));
            if (!await this.confirmDgxCooperativeQueueContract(
              job,
              queueJob,
              "im parallel abgeglichenen DGX-Successor",
            )) return "stopped";
            this.appendLog(
              job,
              `Paralleler DGX-Successor-Beobachter übernimmt keinen POST; Generation 1 ist `
                + `bereits durch ${queueJob.job_id} konsumiert.`,
            );
            this.changed();
            if (queueJob.state === "accepted") {
              return await this.startAcceptedDgxJob(job, queueJob);
            }
            replayAt = Date.now() + DGX_START_FENCE_RETRY_MS;
            delayMs = DGX_START_FENCE_RETRY_MS;
            continue;
          }
          if (replayResult.kind === "gone") {
            if (this.jobShouldStop(job)) {
              this.commitCancelledDgxReplayTerminalObservation(
                job,
                replayReceipt,
                replayResult.observation,
                "abgebrochener Queue-Replay erhielt exakten HTTP-410-Beleg",
              );
              return "stopped";
            }
            this.failJob(
              job,
              `DGX-Queue-Replay bestätigte per 410-Beleg den terminalen Zustand `
                + `${replayResult.observation.state} der bestehenden Lease.`,
            );
            if (job.dgxTerminalDelivery) {
              this.commitDgxTerminalReceipt(
                job,
                replayResult.observation,
                "Queue-Replay erhielt exakten HTTP-410-Beleg",
              );
            }
            return "stopped";
          }
          const replayResponse = replayResult.response;
          queueJob = replayResponse.job;
          this.observeQueueJobMemoryWait(job, queueJob, replayResponse.admission.blocker);
          terminalObservation = dgxSubmitTerminalObservation(
            replayResponse,
            job.id,
            replayReceipt.preparedAdmission,
            replayReceipt.submitStartedAt,
            replayReceipt.dgxJobId,
          );
          if (this.jobShouldStop(job)) {
            if (terminalObservation) {
              this.commitCancelledDgxReplayTerminalObservation(
                job,
                replayReceipt,
                terminalObservation,
                "abgebrochener Queue-Replay erhielt gebundene Terminalantwort",
              );
            }
            return "stopped";
          }
          const retryNowEvidence = dgxRetryNowSuccessorEvidence(
            replayResponse,
            replayReceipt,
          );
          if (retryNowEvidence) {
            const authorization = this.authorizeDgxSuccessorSubmit(
              job,
              replayReceipt,
              retryNowEvidence,
            );
            const successorOutcome = await this.advanceDgxSuccessorSubmit(
              job,
              authorization ?? undefined,
            );
            if (successorOutcome.kind === "follower") return "stopped";
            if (successorOutcome.kind === "terminal"
              || successorOutcome.kind === "ambiguous") return "stopped";
            queueJob = successorOutcome.remote;
            terminalObservation = null;
            this.observeDgxMemoryWait(job, queueJobMemoryBlocker(queueJob));
          }
          if (DGX_POSITIVE_DISCOVERY_STATES.has(queueJob.state)
            && !await this.confirmDgxCooperativeQueueContract(
              job,
              queueJob,
              "im exakt idempotenten Queue-Replay",
            )) return "stopped";
          this.appendLog(
            job,
            `DGX-Queue-Replay: bestehende Lease ${queueJob.job_id} ist ${queueJob.state}; `
              + `Admission ${replayResponse.admission.decision}`
              + `${replayResponse.admission.reason ? ` - ${replayResponse.admission.reason}` : ""}.`,
          );
          replayAt = Date.now() + Math.max(1_000, retryAfterMs(replayResponse.admission));
        } catch (error) {
          if (error instanceof DgxLeaseAuthorityError) {
            this.enterPersistenceHold(error, "DGX-Queue-Replay verlor seine gebundene Lease-Autorität");
            return "stopped";
          }
          if (isJobPersistenceHoldError(error)) return "stopped";
          const expectedDgxJobId = job.dgxJobId;
          if (expectedDgxJobId
            && dgxReplayTargetTemporarilyUnavailable(error, expectedDgxJobId)) {
            if (this.jobShouldStop(job)) return "stopped";
            this.appendLog(
              job,
              `DGX-Queue-Replay fand die erwartete Lease zwischen GET und POST nicht mehr; `
                + "der Replay-only-Vertrag hat keinen Ersatzjob erzeugt. Exakter GET-Abgleich folgt.",
            );
            this.changed();
            replayAt = Date.now() + DGX_START_FENCE_RETRY_MS;
            delayMs = 1_000;
            continue;
          }
          const protocolFailure = definitiveDgxReplayProtocolFailure(error);
          if (protocolFailure) {
            this.enterPersistenceHold(
              new DgxLeaseAuthorityError(
                `Der erwartete-ID-gebundene DGX-Queue-Replay wurde autoritativ abgelehnt (${protocolFailure}).`,
              ),
              "DGX-Queue-Replay-Vertrag ist nicht verfügbar oder widersprüchlich",
            );
            return "stopped";
          }
          if (this.jobShouldStop(job)) return "stopped";
          const message = error instanceof Error
            ? error.message
            : "DGX-Queue-Replay blieb ohne autoritative Antwort.";
          this.appendLog(
            job,
            `DGX-Queue-Replay blieb vorübergehend unbestätigt; die vorhandene Lease bleibt `
              + `unverändert und wird per GET weiter geprüft: ${message}`,
          );
          this.changed();
          replayAt = Date.now() + DGX_START_FENCE_RETRY_MS;
          // Der Replay-Transport ist auf 25 s begrenzt. Danach folgt fast
          // sofort ein read-only GET; der POST darf serverseitig fertiglaufen
          // und kann beim GET keine neue Lease unterschieben.
          delayMs = 1_000;
          continue;
        }
      }
      if (queueJob.state === "accepted") {
        const outcome = await this.startAcceptedDgxJob(job, queueJob);
        if (outcome === "queued") {
          replayAt = Date.now() + DGX_START_FENCE_RETRY_MS;
          delayMs = DGX_START_FENCE_RETRY_MS;
          continue;
        }
        return outcome;
      }
      if (queueJob.state === "queued") {
        // Die read-only GET-Planung bleibt unabhängig vom Server-Backoff auf
        // höchstens 30 s begrenzt. Transportlaufzeiten kommen hinzu; deshalb
        // ist der Replay-POST separat auf 25 s begrenzt und ein Timeout führt
        // nach 1 s wieder zu einem GET.
        delayMs = Math.min(
          DGX_START_FENCE_RETRY_MS,
          Math.max(1_000, replayAt - Date.now()),
        );
        continue;
      }
      if (queueJob.state === "cancelled") {
        this.failJob(
          job,
          `Remote-Job ${queueJob.job_id} wurde vor dem Start abgebrochen. `
            + "Ein Neuversuch benötigt einen neuen Studio-Job mit neuer UUID.",
        );
        if (terminalObservation && job.dgxTerminalDelivery) {
          this.commitDgxTerminalReceipt(
            job,
            terminalObservation,
            "Queue-Poll bestätigte den Remote-Abbruch",
          );
        }
        return "stopped";
      }
      if (["completed", "failed", "rejected"].includes(queueJob.state)) {
        this.failJob(job, `DGX-Queue-Job ist terminal: ${queueJob.state}${queueJob.last_error ? ` - ${queueJob.last_error}` : ""}`);
        if (terminalObservation && job.dgxTerminalDelivery) {
          this.commitDgxTerminalReceipt(
            job,
            terminalObservation,
            "Queue-Poll bestätigte einen terminalen Remote-Zustand",
          );
        }
        return "stopped";
      }
      delayMs = 30_000;
    }
    return "stopped";
  }

  /**
   * Replays only the canonically equal admission object already sealed into a
   * durable lease receipt.  This is intentionally disjoint from recovery of
   * an ambiguous initial POST, which remains read-only until positive queue
   * evidence establishes a lease.
   */
  private async replayBoundDgxQueueAdmission(
    job: RuntimeJob,
  ): Promise<DgxBoundReplayResult> {
    const receipt = requireDgxLeaseAuthority(job);
    const expectedDgxJobId = receipt.dgxJobId;
    const receiptJson = canonicalJson(receipt);
    const replayRequest = structuredClone(receipt.preparedAdmission);
    const abortController = new AbortController();
    job.dgxAdmissionAbortController = abortController;
    try {
      try {
        this.revalidateRuntimeTrustBoundary(job, "exakter DGX-Queue-Replay");
      } catch (error) {
        if (isJobPersistenceHoldError(error)) throw error;
        throw new DgxLeaseAuthorityError(
          `Lokaler Replay-Preflight verweigerte die bestehende Lease: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!this.dgxAdmissionOperations.replay) {
        throw new DgxLeaseAuthorityError(
          "Der DGX-Client besitzt keinen erwartete-ID-gebundenen Replay-Transport.",
        );
      }
      let response: QueueSubmitResponse;
      try {
        response = await this.dgxAdmissionOperations.replay(
          replayRequest,
          expectedDgxJobId,
          abortController.signal,
        );
      } catch (error) {
        const goneObservation = dgxGoneTerminalObservation(error, receipt);
        if (goneObservation) {
          return { kind: "gone", observation: goneObservation, receipt };
        }
        throw error;
      }
      // Auch wenn ein lokaler Abbruch waehrend des POST gewann, muss eine
      // autoritative Antwort zuerst gegen den unveraenderlichen Receipt-
      // Snapshot geprueft werden. Sonst bliebe eine fremde Ersatz-ID als
      // unerkannter Remote-Orphan zurueck.
      if (receipt.preparedAdmissionSha256 !== preparedAdmissionSha256(replayRequest)
        || !dgxReplayResponseLeaseBound(response, receipt)) {
        throw new DgxLeaseAuthorityError(
          "DGX-Queue-Replay war nicht als exakte idempotente Beobachtung der bestehenden Lease gebunden.",
        );
      }
      if ((job.dgxJobId !== expectedDgxJobId
          || canonicalJson(normalizeDgxLeaseReceipt(job.dgxLeaseReceipt)) !== receiptJson)
        && dgxSuccessorAuthorizationBindsPredecessor(
          job.dgxSuccessorAuthorization,
          receipt,
        )) {
        return { kind: "successor-already-authorized", receipt };
      }
      if (!this.jobShouldStop(job)) {
        if (job.dgxJobId !== expectedDgxJobId) {
          throw new DgxLeaseAuthorityError(
            "DGX-Queue-Replay verlor waehrend der Antwort seine dauerhafte Job-ID-Bindung.",
          );
        }
        const currentReceipt = requireDgxLeaseAuthority(job);
        if (canonicalJson(currentReceipt) !== receiptJson) {
          throw new DgxLeaseAuthorityError(
            "DGX-Queue-Replay verlor waehrend der Antwort seine dauerhafte Receipt-Bindung.",
          );
        }
      }
      return { kind: "response", response, receipt };
    } finally {
      if (job.dgxAdmissionAbortController === abortController) {
        this.clearCancellationSettlementTransient(
          job,
          () => delete job.dgxAdmissionAbortController,
        );
      }
    }
  }

  private commitCancelledDgxReplayTerminalObservation(
    job: RuntimeJob,
    replayReceipt: DgxLeaseReceipt,
    observation: DgxTerminalObservation,
    detail: string,
  ): void {
    if (this.persistenceHold || job.cancelledBy !== "studio") return;
    if (job.dgxTerminalReceipt) {
      if (job.dgxTerminalReceipt.dgxJobId === replayReceipt.dgxJobId) return;
      throw new DgxLeaseAuthorityError(
        "Terminaler Cancel-Replay widerspricht einem bereits bestätigten DGX-Terminalbeleg.",
      );
    }
    if (!job.dgxTerminalDelivery) return;
    const currentReceipt = normalizeDgxLeaseReceipt(job.dgxLeaseReceipt);
    if (!currentReceipt
      || job.dgxJobId !== replayReceipt.dgxJobId
      || canonicalJson(currentReceipt) !== canonicalJson(replayReceipt)) {
      throw new DgxLeaseAuthorityError(
        "Terminaler Cancel-Replay verlor vor dem Receipt-Commit seine dauerhafte Lease-Bindung.",
      );
    }
    this.commitDgxTerminalReceipt(job, observation, detail);
  }

  private async startAcceptedDgxJob(
    job: RuntimeJob,
    acceptedQueueJob: QueueJobSummary,
  ): Promise<DgxStartOutcome> {
    this.observeQueueJobMemoryWait(job, acceptedQueueJob);
    if (!await this.confirmDgxCooperativeQueueContract(
      job,
      acceptedQueueJob,
      "vor dem autoritativen Start-Fence",
    )) return "stopped";
    const snapshot = this.readStartResourceSnapshot();
    this.appendLog(
      job,
      `DGX-Admission ist akzeptiert; Start-Fence wird jetzt autoritativ beim Orchestrator geprüft. `
        + `Lokale Messung: ${snapshot.availableMemoryGiB?.toFixed(2) ?? "unbekannt"} GiB RAM, `
        + `${snapshot.swapFreeGiB?.toFixed(2) ?? "unbekannt"} GiB Swap und `
        + `${snapshot.outputFreeGiB?.toFixed(2) ?? "unbekannt"} GiB Ausgabeplatz frei.`,
    );
    this.changed();
    let started: boolean;
    try {
      started = await this.transitionDgxJob(job, "starting", {
        current_step: "thermal start gate before LTX allocation",
      });
    } catch (error) {
      if (error instanceof DgxCooperativeQueueContractError) {
        await this.settleDgxCooperativeQueueContractError(job, error);
        return "stopped";
      }
      throw error;
    }
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
    if (this.persistenceHold) return false;
    if (!job.dgxJobId || job.dgxJobTerminal) return true;
    try {
      requireDgxLeaseAuthority(job);
    } catch (error) {
      this.appendLog(job, error instanceof Error ? error.message : String(error));
      this.changed();
      return false;
    }
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
        let transitionMayHaveApplied = false;
        try {
          this.revalidateRuntimeTrustBoundary(job, `DGX-${state}-Fence`);
          const expectedDgxJobId = job.dgxJobId!;
          requireDgxLeaseAuthority(job);
          const currentResponse = await this.dgxQueueOperations.read(expectedDgxJobId);
          const current = dgxResponseBoundJob(
            currentResponse,
            "job-read",
            expectedDgxJobId,
            job.id,
          );
          if (!current) {
            throw new DgxLeaseAuthorityError(
              "DGX-State-Fence konnte die Lease nicht exakt an diesen Studio-Job binden.",
            );
          }
          if (this.jobShouldStop(job) || job.dgxJobId !== expectedDgxJobId) return false;
          this.observeQueueJobMemoryWait(job, current);
          if (state === "starting" || state === "resuming") {
            assertDgxCooperativeQueueContract(
              job,
              current,
              `im letzten ${state}-GET vor lokaler LTX-Allokation`,
            );
          }
          const alreadyApplied = current.state === state
            || ((state === "starting" || state === "resuming") && current.state === "running");
          if (alreadyApplied) {
            this.appendLog(
              job,
              `DGX-Queue-State war vor PATCH bereits autoritativ ${current.state}: ${current.job_id}.`,
            );
            if (state === "starting" || state === "running" || state === "pausing" || state === "resuming") {
              this.startDgxOwnerHeartbeat(job, current.state === "running" ? "ltx_rendering" : state);
            }
            this.changed();
            return true;
          }
          if (DGX_REMOTE_TERMINAL_STATES.has(current.state)) {
            throw new Error(`DGX-State-Fence ist bereits terminal: ${current.state}.`);
          }
          transitionMayHaveApplied = true;
          if (this.jobShouldStop(job) || job.dgxJobId !== expectedDgxJobId) return false;
          requireDgxLeaseAuthority(job);
          const response = await this.dgxQueueOperations.transition(expectedDgxJobId, state, metadata);
          if (this.persistenceHold
            || this.jobShouldStop(job)
            || job.dgxJobId !== expectedDgxJobId) return false;
          const applied = dgxResponseBoundJob(
            response,
            "job-transition",
            expectedDgxJobId,
            job.id,
          );
          if (!applied || applied.state !== state) {
            throw new DgxLeaseAuthorityError(
              `DGX-State-PATCH bestätigte ${state} nicht exakt callergebunden.`,
            );
          }
          this.observeQueueJobMemoryWait(job, applied);
          if (state === "starting" || state === "resuming") {
            assertDgxCooperativeQueueContract(
              job,
              applied,
              `in der positiven ${state}-PATCH-Antwort vor lokaler LTX-Allokation`,
            );
          }
          this.appendLog(job, `DGX-Queue-State: ${applied.job_id} -> ${applied.state}.`);
          if (state === "starting" || state === "running" || state === "pausing" || state === "resuming") {
            this.startDgxOwnerHeartbeat(job, state === "running" ? "ltx_rendering" : state);
          }
          this.changed();
          return true;
        } catch (error) {
          if (this.persistenceHold || isJobPersistenceHoldError(error)) return false;
          if (error instanceof DgxCooperativeQueueContractError) throw error;
          if (error instanceof DgxLeaseAuthorityError) {
            this.enterPersistenceHold(error, `DGX-${state}-Fence verlor seine Lease-Autorität`);
            return false;
          }
          if (transitionMayHaveApplied && job.dgxJobId) {
            try {
              const expectedDgxJobId = job.dgxJobId;
              requireDgxLeaseAuthority(job);
              const readBack = await this.dgxQueueOperations.read(expectedDgxJobId);
              const remote = dgxResponseBoundJob(
                readBack,
                "job-read",
                expectedDgxJobId,
                job.id,
              );
              if (!remote) {
                throw new DgxLeaseAuthorityError(
                  "Statusabgleich nach PATCH war nicht exakt callergebunden.",
                );
              }
              if (this.jobShouldStop(job) || job.dgxJobId !== expectedDgxJobId) return false;
              this.observeQueueJobMemoryWait(job, remote);
              if (state === "starting" || state === "resuming") {
                assertDgxCooperativeQueueContract(
                  job,
                  remote,
                  `im ${state}-Statusabgleich vor lokaler LTX-Allokation`,
                );
              }
              if (remote.state === state
                || ((state === "starting" || state === "resuming") && remote.state === "running")) {
                this.appendLog(
                  job,
                  `DGX-State-PATCH per exakt gebundenem GET bestätigt: ${remote.job_id} ist ${remote.state}.`,
                );
                if (state === "starting" || state === "running" || state === "pausing" || state === "resuming") {
                  this.startDgxOwnerHeartbeat(
                    job,
                    remote.state === "running" ? "ltx_rendering" : state,
                  );
                }
                this.changed();
                return true;
              }
            } catch (readBackError) {
              if (this.persistenceHold || isJobPersistenceHoldError(readBackError)) return false;
              if (readBackError instanceof DgxCooperativeQueueContractError) throw readBackError;
              if (readBackError instanceof DgxLeaseAuthorityError) {
                this.enterPersistenceHold(
                  readBackError,
                  `DGX-${state}-Statusabgleich verlor seine Lease-Autorität`,
                );
                return false;
              }
              this.appendLog(
                job,
                `DGX-State-PATCH-Ausgang bleibt nach GET unklar: ${
                  readBackError instanceof Error ? readBackError.message : String(readBackError)
                }`,
              );
              this.changed();
            }
          }
          const startFenceState = state === "starting" || state === "resuming" ? state : null;
          if (startFenceState) {
            const blocker = runtimePayloadBlocker(error);
            if (blocker !== undefined) this.observeDgxMemoryWait(job, blocker);
          }
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
        this.clearCancellationSettlementTransient(
          job,
          () => delete job.dgxStateTransitionInFlight,
        );
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
    const unresolvedMemoryFence = normalizeDgxMemoryBlocker(
      runtimePayloadBlocker(transitionError),
    ) !== null;
    while (!this.shuttingDown && isActiveJobStatus(job.status) && job.dgxJobId) {
      let remote: QueueJobSummary;
      let pollReceipt: DgxLeaseReceipt | null = null;
      try {
        const expectedDgxJobId = job.dgxJobId;
        pollReceipt = requireDgxLeaseAuthority(job);
        const response = await this.dgxQueueOperations.read(expectedDgxJobId);
        const boundJob = dgxResponseBoundJob(response, "job-read", expectedDgxJobId, job.id);
        if (!boundJob) {
          throw new DgxLeaseAuthorityError(
            "DGX-Start-Fence-Status ist nicht exakt an diesen Studio-Job gebunden.",
          );
        }
        if (this.jobShouldStop(job) || job.dgxJobId !== expectedDgxJobId) return "failed";
        remote = boundJob;
      } catch (error) {
        if (this.persistenceHold || isJobPersistenceHoldError(error)) return "failed";
        const goneObservation = pollReceipt
          ? dgxGoneTerminalObservation(error, pollReceipt)
          : null;
        if (goneObservation) {
          this.failJob(
            job,
            `DGX-Start-Fence erhielt einen exakten HTTP-410-Terminalbeleg (${goneObservation.state}); `
              + "derselbe Studio-Job wird nicht erneut submitten.",
          );
          if (job.dgxTerminalDelivery) {
            this.commitDgxTerminalReceipt(
              job,
              goneObservation,
              "Start-Fence erhielt exakten HTTP-410-Beleg",
            );
          }
          return "failed";
        }
        if (error instanceof DgxLeaseAuthorityError) {
          this.enterPersistenceHold(error, "DGX-Start-Fence verlor seine Lease-Autorität");
          return "failed";
        }
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
      if (this.jobShouldStop(job)) return "failed";
      this.observeQueueJobMemoryWait(job, remote, undefined, {
        // A PATCH-409 may carry the authoritative memory equation while its
        // immediate read-back projects only the still-unresolved queue state.
        // Keep that one measurement until this reconciliation resolves, but
        // never carry it across a successful/terminal state or an ordinary
        // poll. The admission reason can belong to an older epoch, especially
        // for paused -> resuming, and therefore cannot overrule the newer 409.
        retainWhenMissing: unresolvedMemoryFence
          && queueJobMemoryBlocker(remote) === undefined
          && ["accepted", "queued", "paused"].includes(remote.state),
      });
      assertDgxCooperativeQueueContract(
        job,
        remote,
        `im wiederholten ${targetState}-Statusabgleich vor lokaler LTX-Allokation`,
      );
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
    if (this.persistenceHold) return false;
    if (!job.dgxJobId || job.dgxJobTerminal || !job.dgxTerminalDelivery) return true;
    if (job.localProcessSpawnPending
      || job.localProcessGroupPending
      || job.ownedDockerContainer
      || job.ownedDockerContainerRecoveryBlocked) return false;
    if (job.dgxTerminalDeliveryInFlight) return job.dgxTerminalDeliveryInFlight;
    // Claim single-flight synchronously, before waiting for a state transition
    // or heartbeat.  No second caller may pass the same pre-await checks.
    const deliveryPromise = (async (): Promise<boolean> => {
      try {
        requireDgxLeaseAuthority(job);
        if (job.dgxStateTransitionInFlight) await job.dgxStateTransitionInFlight;
        if (this.persistenceHold) return false;
        requireDgxLeaseAuthority(job);
        await this.stopDgxOwnerHeartbeat(job);
        if (this.persistenceHold) return false;
        if (!job.dgxJobId || job.dgxJobTerminal || !job.dgxTerminalDelivery) return true;
        requireDgxLeaseAuthority(job);
        if (job.dgxTerminalRetry) {
          clearTimeout(job.dgxTerminalRetry);
          delete job.dgxTerminalRetry;
        }
        return await this.attemptDgxTerminalDelivery(job);
      } catch (error) {
        if (error instanceof DgxLeaseAuthorityError) {
          const message = error.message;
          if (job.dgxTerminalDelivery && job.dgxTerminalDelivery.lastError !== message) {
            job.dgxTerminalDelivery.lastError = message;
            job.dgxTerminalDelivery.updatedAt = now();
            this.appendLog(job, `${message} Automatische Remote-Retries bleiben gesperrt.`);
            this.changed();
          }
          return false;
        }
        throw error;
      }
    })();
    job.dgxTerminalDeliveryInFlight = deliveryPromise;
    let retryAfterPersistenceFailure = false;
    try {
      return await deliveryPromise;
    } catch (error) {
      retryAfterPersistenceFailure = !this.persistenceHold
        && !isJobPersistenceHoldError(error)
        && Boolean(job.dgxTerminalDelivery);
      throw error;
    } finally {
      if (job.dgxTerminalDeliveryInFlight === deliveryPromise) {
        this.clearCancellationSettlementTransient(
          job,
          () => delete job.dgxTerminalDeliveryInFlight,
        );
      }
      if (retryAfterPersistenceFailure) this.scheduleDgxTerminalRetry(job);
      if (job.dgxSubmitPending
        && !isActiveJobStatus(job.status)
        && !job.dgxTerminalDelivery) {
        this.scheduleTerminalPendingDgxSubmitReconciliation(job, 0);
      }
    }
  }

  private async attemptDgxTerminalDelivery(job: RuntimeJob): Promise<boolean> {
    const delivery = job.dgxTerminalDelivery;
    const jobId = job.dgxJobId;
    let deliveryReceipt: DgxLeaseReceipt | null = null;
    if (!delivery || !jobId) return true;
    const previousAttempts = delivery.attempts;
    const previousUpdatedAt = delivery.updatedAt;
    delivery.attempts += 1;
    delivery.updatedAt = now();
    try {
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        // A proven pre-rename failure left the durable delivery untouched. Keep
        // memory aligned with that snapshot and restore the timer that flush()
        // cleared before this attempt began.
        delivery.attempts = previousAttempts;
        delivery.updatedAt = previousUpdatedAt;
      }
      throw error;
    }
    try {
      let transitionState: DgxTerminalState = delivery.state;
      let transitionMetadata = delivery.metadata;
      // Every terminal mutation is GET-first. A persisted/adopted job ID alone
      // is not mutation authority: the current public record must bind both
      // caller fields to this exact Studio job before PATCH.
      deliveryReceipt = requireDgxLeaseAuthority(job);
      if (job.dgxJobId !== jobId) throw new DgxLeaseAuthorityError("DGX-Lease-ID änderte sich vor dem Terminal-GET.");
      const current = await this.dgxQueueOperations.read(jobId);
      if (this.persistenceHold) return false;
      const currentState = dgxResponseJobState(current, "job-read", jobId, job.id);
      if (!currentState) {
        throw new DgxLeaseAuthorityError(
          "DGX Runtime API lieferte beim GET keinen exakt callergebundenen Jobzustand.",
        );
      }
      const currentTerminal = dgxResponseTerminalObservation(current, "job-read", jobId, job.id);
      if (currentTerminal) {
        this.commitDgxTerminalReceipt(
          job,
          currentTerminal,
          currentState === delivery.state
            ? "vor PATCH per GET bestätigt"
            : "vor PATCH per GET abweichend terminal bestätigt",
        );
        return currentState === delivery.state;
      }
      if (delivery.state === "cancelled"
        && ["starting", "pausing", "resuming"].includes(currentState)) {
        transitionState = "failed";
        transitionMetadata = {
          ...delivery.metadata,
          current_step: "cancelled locally before compute launch completed",
          last_error: delivery.metadata.last_error ?? "LTX Studio cancellation won a queue transition race",
        };
      }
      if (this.persistenceHold) return false;
      requireDgxLeaseAuthority(job);
      if (job.dgxJobId !== jobId) throw new DgxLeaseAuthorityError("DGX-Lease-ID änderte sich vor dem Terminal-PATCH.");
      const response = await this.dgxQueueOperations.transition(jobId, transitionState, transitionMetadata);
      if (this.persistenceHold) return false;
      const responseState = dgxResponseJobState(response, "job-transition", jobId, job.id);
      const responseTerminal = dgxResponseTerminalObservation(
        response,
        "job-transition",
        jobId,
        job.id,
      );
      if (!responseState || !responseTerminal) {
        throw new DgxLeaseAuthorityError(
          "DGX Runtime API lieferte beim PATCH keinen exakt gebundenen terminalen Jobzustand.",
        );
      }
      if (responseState !== transitionState) {
        throw new Error(`DGX Runtime API bestätigte ${responseState} statt ${transitionState}.`);
      }
      const detail = transitionState === delivery.state
        ? "PATCH bestätigt"
        : `lokaler Abbruch regelkonform als ${transitionState} abgeschlossen`;
      this.commitDgxTerminalReceipt(job, responseTerminal, detail);
      return true;
    } catch (transitionError) {
      if (this.persistenceHold || isJobPersistenceHoldError(transitionError)) return false;
      if (transitionError instanceof DgxTerminalReceiptPersistenceError) throw transitionError;
      if (transitionError instanceof DgxLeaseAuthorityError) throw transitionError;
      const goneObservation = deliveryReceipt
        ? dgxGoneTerminalObservation(transitionError, deliveryReceipt)
        : null;
      if (goneObservation) return this.settleDgxGoneEvidence(job, delivery, goneObservation);
      const transitionMessage = transitionError instanceof Error ? transitionError.message : String(transitionError);
      try {
        requireDgxLeaseAuthority(job);
        if (job.dgxJobId !== jobId) throw new DgxLeaseAuthorityError("DGX-Lease-ID änderte sich vor dem Terminal-Statusabgleich.");
        const response = await this.dgxQueueOperations.read(jobId);
        if (this.persistenceHold) return false;
        const responseState = dgxResponseJobState(response, "job-read", jobId, job.id);
        if (!responseState) {
          throw new DgxLeaseAuthorityError(
            "DGX Runtime API lieferte beim Statusabgleich keinen exakt gebundenen Jobzustand.",
          );
        }
        const responseTerminal = dgxResponseTerminalObservation(response, "job-read", jobId, job.id);
        if (responseState === delivery.state && responseTerminal) {
          this.commitDgxTerminalReceipt(
            job,
            responseTerminal,
            "nach verlorener PATCH-Antwort per GET abgeglichen",
          );
          return true;
        }
        if (responseTerminal) {
          this.commitDgxTerminalReceipt(
            job,
            responseTerminal,
            "nach verlorener PATCH-Antwort abweichend terminal abgeglichen",
          );
          return false;
        }
        this.deferDgxTerminalDelivery(
          job,
          `${transitionMessage}; Remote-Zustand nach Abgleich: ${responseState}`,
        );
        return false;
      } catch (readError) {
        if (this.persistenceHold || isJobPersistenceHoldError(readError)) return false;
        if (readError instanceof DgxTerminalReceiptPersistenceError) throw readError;
        if (readError instanceof DgxLeaseAuthorityError) throw readError;
        const readGoneObservation = deliveryReceipt
          ? dgxGoneTerminalObservation(readError, deliveryReceipt)
          : null;
        if (readGoneObservation) return this.settleDgxGoneEvidence(job, delivery, readGoneObservation);
        const readMessage = readError instanceof Error ? readError.message : String(readError);
        this.deferDgxTerminalDelivery(job, `${transitionMessage}; Statusabgleich fehlgeschlagen: ${readMessage}`);
        return false;
      }
    }
  }

  private settleDgxGoneEvidence(
    job: RuntimeJob,
    delivery: DgxTerminalDelivery,
    observation: DgxTerminalObservation,
  ): boolean {
    this.commitDgxTerminalReceipt(
      job,
      observation,
      "gebundener HTTP-410-Gone-Terminalbeleg bestätigt",
    );
    return observation.state === delivery.state;
  }

  private commitDgxTerminalReceipt(
    job: RuntimeJob,
    observation: DgxTerminalObservation,
    detail: string,
  ): void {
    const delivery = job.dgxTerminalDelivery;
    const dgxJobId = job.dgxJobId;
    if (!delivery || !dgxJobId) {
      throw new Error("DGX-Terminalbeleg besitzt keine aktive Zustellautorität.");
    }
    const snapshot = {
      dgxJobId: job.dgxJobId,
      dgxJobTerminal: job.dgxJobTerminal,
      dgxTerminalDelivery: structuredClone(delivery),
      dgxTerminalReceipt: job.dgxTerminalReceipt
        ? structuredClone(job.dgxTerminalReceipt)
        : undefined,
      dgxLeaseReceipt: job.dgxLeaseReceipt
        ? structuredClone(job.dgxLeaseReceipt)
        : undefined,
      dgxSubmitPending: job.dgxSubmitPending,
      dgxSubmitStartedAt: job.dgxSubmitStartedAt,
      dgxPreparedAdmission: job.dgxPreparedAdmission
        ? structuredClone(job.dgxPreparedAdmission)
        : undefined,
      dgxPreparedAdmissionSha256: job.dgxPreparedAdmissionSha256,
      dgxSubmitReconcileDelayMs: job.dgxSubmitReconcileDelayMs,
      dgxMemoryWait: job.dgxMemoryWait ? structuredClone(job.dgxMemoryWait) : null,
      logs: [...job.logs],
    };
    delete job.dgxTerminalDelivery;
    job.dgxJobTerminal = true;
    job.dgxTerminalReceipt = {
      schemaVersion: "ltx-studio-dgx-terminal-receipt.v1",
      studioJobId: job.id,
      dgxJobId,
      idempotencyKey: `ltx-studio:${job.id}`,
      localIntentState: delivery.state,
      remoteTerminalState: observation.state,
      confirmedAt: now(),
      evidence: structuredClone(observation.evidence),
    };
    delete job.dgxLeaseReceipt;
    // Exact terminal evidence also resolves any older submit-ambiguity marker
    // for this same idempotency key. Replaying it again could only rediscover
    // (or recreate after retention) the already-settled lease.
    delete job.dgxSubmitPending;
    delete job.dgxSubmitStartedAt;
    delete job.dgxPreparedAdmission;
    delete job.dgxPreparedAdmissionSha256;
    job.dgxMemoryWait = null;
    this.appendLog(
      job,
      observation.state === delivery.state
        ? `DGX-Queue-State: ${dgxJobId} -> ${observation.state} (${detail}).`
        : `DGX-Terminalabweichung: lokal war ${delivery.state} vorgemerkt, ${dgxJobId} ist `
          + `${observation.state} (${detail}).`,
    );
    try {
      // Receipt, Delivery-Clear and an optional recovered-submit lease release
      // are one fsync-backed snapshot. No restart may observe a half-settled
      // cancellation.
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        job.dgxJobId = snapshot.dgxJobId;
        job.dgxJobTerminal = snapshot.dgxJobTerminal;
        job.dgxTerminalDelivery = snapshot.dgxTerminalDelivery;
        if (snapshot.dgxTerminalReceipt) {
          job.dgxTerminalReceipt = snapshot.dgxTerminalReceipt;
        } else {
          delete job.dgxTerminalReceipt;
        }
        if (snapshot.dgxLeaseReceipt) {
          job.dgxLeaseReceipt = snapshot.dgxLeaseReceipt;
        } else {
          delete job.dgxLeaseReceipt;
        }
        if (snapshot.dgxSubmitPending) job.dgxSubmitPending = true;
        else delete job.dgxSubmitPending;
        if (snapshot.dgxSubmitStartedAt) job.dgxSubmitStartedAt = snapshot.dgxSubmitStartedAt;
        else delete job.dgxSubmitStartedAt;
        if (snapshot.dgxPreparedAdmission) {
          job.dgxPreparedAdmission = snapshot.dgxPreparedAdmission;
        } else {
          delete job.dgxPreparedAdmission;
        }
        if (snapshot.dgxPreparedAdmissionSha256) {
          job.dgxPreparedAdmissionSha256 = snapshot.dgxPreparedAdmissionSha256;
        } else delete job.dgxPreparedAdmissionSha256;
        if (snapshot.dgxSubmitReconcileDelayMs !== undefined) {
          job.dgxSubmitReconcileDelayMs = snapshot.dgxSubmitReconcileDelayMs;
        } else {
          delete job.dgxSubmitReconcileDelayMs;
        }
        job.dgxMemoryWait = snapshot.dgxMemoryWait;
        job.logs.splice(0, job.logs.length, ...snapshot.logs);
        throw new DgxTerminalReceiptPersistenceError(error);
      }
      throw error;
    }
    if (job.dgxTerminalRetry) clearTimeout(job.dgxTerminalRetry);
    delete job.dgxTerminalRetry;
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
      || this.persistenceHold
      || this.dgxTerminalRetryBaseMs === null
      || !job.dgxTerminalDelivery
      || job.dgxJobTerminal
      || job.dgxTerminalRetry
      || job.localProcessSpawnPending
      || job.localProcessGroupPending
      || job.ownedDockerContainer
      || job.ownedDockerContainerRecoveryBlocked
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
      this.runDetached(
        this.flushDgxTerminalDelivery(job),
        `DGX-Terminal-Retry ${job.id}`,
      );
    }, delayMs);
    job.dgxTerminalRetry.unref();
  }

  private failJob(
    job: RuntimeJob,
    message: string,
    remoteTerminalState: DgxTerminalState = "failed",
  ): void {
    // Every terminal state is monotone. In particular, an error from the
    // remote-completion receipt path must never downgrade already published
    // local output from completed to failed.
    if (!isActiveJobStatus(job.status)) return;
    this.prepareDgxTerminalDelivery(job, remoteTerminalState, {
      current_step: "LTX Studio job failed",
      last_error: message,
    });
    job.status = "failed";
    job.error = message;
    job.finishedAt = now();
    job.dgxMemoryWait = null;
    if (job.startedAt) job.runtimeMs = Date.now() - Date.parse(job.startedAt);
    this.appendLog(job, message);
    this.changed();
    this.scheduleDgxTerminalRetry(job, 0);
  }

  private async failDgxJob(
    job: RuntimeJob,
    message: string,
    currentStep: string,
    remoteTerminalState: DgxTerminalState = "failed",
  ): Promise<void> {
    if (!isActiveJobStatus(job.status)) return;
    this.prepareDgxTerminalDelivery(job, remoteTerminalState, {
      current_step: currentStep,
      last_error: message,
    });
    this.failJob(job, message, remoteTerminalState);
    await this.flushDgxTerminalDelivery(job);
  }

  private startDgxOwnerHeartbeat(job: RuntimeJob, phase: string): void {
    if (!job.dgxJobId || job.dgxJobTerminal || !this.dgxQueueOperations.heartbeat) return;
    try {
      requireDgxLeaseAuthority(job);
    } catch (error) {
      this.enterPersistenceHold(error, "DGX-Owner-Heartbeat besitzt keine dauerhafte Lease-Autorität");
      return;
    }
    const existing = job.dgxOwnerHeartbeat;
    if (existing?.jobId === job.dgxJobId && !existing.stopped) {
      // A descriptive phase transition is not compute progress. In
      // particular, thermal pause/resume oscillation must never extend the
      // independent no-progress deadline or emit `progressed: true`.
      existing.phase = phase;
      return;
    }
    if (existing) {
      existing.stopped = true;
      if (existing.timer) clearInterval(existing.timer);
      if (existing.safetyTimer) clearTimeout(existing.safetyTimer);
    }

    const startedAt = Date.now();
    const state: DgxOwnerHeartbeatState = {
      jobId: job.dgxJobId,
      phase,
      progressEpoch: 0,
      acknowledgedProgressEpoch: 0,
      acknowledgedOnce: false,
      lastAcknowledgedAt: startedAt,
      lastProgressAt: startedAt,
      consecutiveFailures: 0,
      stopped: false,
    };
    state.timer = setInterval(() => {
      this.runDetached(
        this.sendDgxOwnerHeartbeat(job, state),
        `DGX-Owner-Heartbeat ${job.id}`,
      );
    }, DGX_OWNER_HEARTBEAT_INTERVAL_MS);
    state.timer.unref();
    job.dgxOwnerHeartbeat = state;
    this.armDgxOwnerHeartbeatSafetyDeadline(job, state);
    this.runDetached(
      this.sendDgxOwnerHeartbeat(job, state),
      `initialer DGX-Owner-Heartbeat ${job.id}`,
    );
  }

  private armDgxOwnerHeartbeatSafetyDeadline(
    job: RuntimeJob,
    state: DgxOwnerHeartbeatState,
  ): void {
    if (state.safetyTimer) clearTimeout(state.safetyTimer);
    if (state.stopped || job.dgxOwnerHeartbeat !== state) {
      delete state.safetyTimer;
      return;
    }
    const deadline = Math.min(
      state.lastAcknowledgedAt + DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS,
      state.lastProgressAt + DGX_OWNER_NO_PROGRESS_TIMEOUT_MS,
    );
    state.safetyTimer = setTimeout(() => {
      delete state.safetyTimer;
      this.runDetached(
        this.enforceDgxOwnerHeartbeatSafetyDeadline(job, state),
        `DGX-Owner-Heartbeat-Sicherheitsfrist ${job.id}`,
      );
    }, Math.max(1, deadline - Date.now()));
    state.safetyTimer.unref();
  }

  private async enforceDgxOwnerHeartbeatSafetyDeadline(
    job: RuntimeJob,
    state: DgxOwnerHeartbeatState,
  ): Promise<void> {
    if (state.stopped || job.dgxOwnerHeartbeat !== state) return;
    const checkedAt = Date.now();
    if (checkedAt - state.lastAcknowledgedAt >= DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS) {
      await this.failStopDgxOwnerHeartbeat(
        job,
        state,
        `DGX-Owner-Heartbeat blieb ${Math.round(DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS / 1_000)} s `
          + "ohne Bestätigung; lokale Compute-Arbeit wurde durch die unabhängige Sicherheitsfrist beendet.",
      );
      return;
    }
    if (checkedAt - state.lastProgressAt >= DGX_OWNER_NO_PROGRESS_TIMEOUT_MS) {
      await this.failStopDgxOwnerHeartbeat(
        job,
        state,
        `DGX-Lauf überschritt die ${Math.round(DGX_OWNER_NO_PROGRESS_TIMEOUT_MS / 60_000)}`
          + "-Minuten-No-Progress-Frist.",
      );
      return;
    }
    this.armDgxOwnerHeartbeatSafetyDeadline(job, state);
  }

  private async failStopDgxOwnerHeartbeat(
    job: RuntimeJob,
    state: DgxOwnerHeartbeatState,
    message: string,
    observation?: DgxTerminalObservation,
  ): Promise<void> {
    if (state.stopped || job.dgxOwnerHeartbeat !== state) return;
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    if (state.safetyTimer) clearTimeout(state.safetyTimer);
    delete job.dgxOwnerHeartbeat;
    if (jobWasCancelled(job) || this.persistenceHold) return;

    const wasPaused = job.status === "paused";
    const child = job.process;
    try {
      this.failJob(job, message);
    } catch (error) {
      // The local safety stop is unconditional. A failed snapshot commit may
      // forbid remote mutation, but it must never leave GPU compute running
      // after the owner heartbeat has stopped.
      const emergencyStopErrors: string[] = [];
      if (child?.pid) {
        await terminateProcessGroup(child, wasPaused, 10_000, 15_000).catch((stopError) => {
          emergencyStopErrors.push(stopError instanceof Error ? stopError.message : String(stopError));
        });
      }
      if (job.ownedDockerContainer) {
        const cleaned = await this.cleanupOwnedDockerContainer(job).catch((cleanupError) => {
          emergencyStopErrors.push(
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          );
          return false;
        });
        if (!cleaned && job.ownedDockerContainer) {
          try {
            const remaining = this.inspectOwnedDockerContainer(job, job.ownedDockerContainer, true);
            if (remaining.kind === "owned") {
              emergencyStopErrors.push(`Container ${job.ownedDockerContainer.name} läuft möglicherweise weiter.`);
            }
          } catch (inspectionError) {
            emergencyStopErrors.push(
              inspectionError instanceof Error ? inspectionError.message : String(inspectionError),
            );
          }
        }
      }
      if (emergencyStopErrors.length > 0) {
        process.stderr.write(
          `Heartbeat-Notstopp für ${job.id} konnte lokale Compute-Abwesenheit nicht vollständig beweisen: `
            + `${emergencyStopErrors.join("; ")}\n`,
        );
      }
      throw error;
    }
    let localStopFailure: unknown = null;
    if (child?.pid) {
      try {
        await this.stopProcessBeforeTerminalDelivery(job, child, wasPaused);
      } catch (error) {
        localStopFailure = error;
      }
    } else if (job.localProcessSpawnPending
      || job.localProcessGroupPending
      || job.localProcessGroupIdentity) {
      localStopFailure = new Error(
        "Persistierte lokale Prozessgruppenautorität blieb ohne erreichbares Child-Handle aktiv.",
      );
    }
    if (job.ownedDockerContainer) {
      const cleaned = await this.cleanupOwnedDockerContainer(job);
      if (!cleaned && job.ownedDockerContainer) {
        try {
          const remaining = this.inspectOwnedDockerContainer(job, job.ownedDockerContainer, true);
          if (remaining.kind === "owned") {
            localStopFailure ??= new Error(
              `Container ${job.ownedDockerContainer.name} blieb nach Heartbeat-Notstopp aktiv.`,
            );
          }
        } catch (error) {
          localStopFailure ??= error;
        }
      }
    }
    if (job.ownedDockerContainerRecoveryBlocked) {
      localStopFailure ??= new Error("Docker-Containerautorität ist recovery-blockiert.");
    }
    if (localStopFailure) {
      this.enterPersistenceHold(
        localStopFailure,
        "Heartbeat-Notstopp konnte lokale Compute-Abwesenheit nicht beweisen",
      );
      return;
    }
    if (observation
      && job.dgxTerminalDelivery
      && !job.localProcessSpawnPending
      && !job.localProcessGroupPending
      && !job.ownedDockerContainer
      && !job.ownedDockerContainerRecoveryBlocked) {
      this.commitDgxTerminalReceipt(
        job,
        observation,
        "Heartbeat-Fail-stop erhielt exakte Remote-Terminalevidenz",
      );
      return;
    }
    await this.flushDgxTerminalDelivery(job);
  }

  private async sendDgxOwnerHeartbeat(
    job: RuntimeJob,
    state: DgxOwnerHeartbeatState,
  ): Promise<void> {
    if (
      state.stopped
      || this.persistenceHold
      || job.dgxOwnerHeartbeat !== state
      || job.dgxJobId !== state.jobId
      || job.dgxJobTerminal
      || state.inFlight
      || !this.dgxQueueOperations.heartbeat
    ) return;

    const activationDecision = this.jobStartDecision(job);
    if (!activationDecision.allowed) {
      if (supportsCooperativeCheckpoint(job.request)) {
        if (state.activationBlockReason !== activationDecision.reason) {
          state.activationBlockReason = activationDecision.reason;
          this.appendLog(
            job,
            `Activation-/Rights-Gate ist geschlossen; der kooperative Lauf beendet sich an der nächsten sicheren Euler-Grenze (${activationDecision.reason}).`,
          );
          this.changed();
        }
      } else {
        state.stopped = true;
        if (state.timer) clearInterval(state.timer);
        if (state.safetyTimer) clearTimeout(state.safetyTimer);
        if (job.dgxOwnerHeartbeat === state) delete job.dgxOwnerHeartbeat;
        const child = job.process;
        if (child && processIsAlive(child)) {
          await this.stopProcessBeforeTerminalDelivery(job, child, false).catch(() => undefined);
        }
        if (this.jobShouldStop(job)) return;
        if (isActiveJobStatus(job.status)) {
          await this.failDgxJob(
            job,
            `Nicht-kooperativer Lauf wurde wegen des aktuellen Activation-/Rights-Gates beendet: ${activationDecision.reason}`,
            "activation or rights revoked during non-cooperative run",
          );
        }
        return;
      }
    } else if (state.activationBlockReason) {
      delete state.activationBlockReason;
      this.appendLog(job, "Activation-/Rights-Gate ist wieder aktuell; der Lauf bleibt autorisiert.");
      this.changed();
    }

    const sentProgressEpoch = state.progressEpoch;
    const payload: QueueHeartbeatPayload = {
      runtime_status: { phase: state.phase },
      ...(sentProgressEpoch > state.acknowledgedProgressEpoch ? { progressed: true as const } : {}),
    };
    const request = (async () => {
      try {
        requireDgxLeaseAuthority(job);
        if (job.dgxJobId !== state.jobId) {
          throw new DgxLeaseAuthorityError("DGX-Lease-ID änderte sich vor dem Owner-Heartbeat.");
        }
        const response = await this.dgxQueueOperations.heartbeat!(state.jobId, payload);
        if (response && typeof response === "object"
          && !Array.isArray(response)
          && (response as Record<string, unknown>).heartbeat_applied === false) {
          throw new DgxRemoteLeaseLostError(
            "DGX-Owner-Heartbeat wurde explizit nicht auf die aktuelle Lease-Generation angewendet.",
          );
        }
        const remote = dgxResponseBoundJob(
          response,
          "job-heartbeat",
          state.jobId,
          job.id,
        );
        if (!remote) {
          throw new DgxLeaseAuthorityError(
            "DGX-Owner-Heartbeat wurde nicht exakt caller- und idempotenzgebunden bestätigt.",
          );
        }
        if (!["starting", "running", "pausing", "resuming"].includes(remote.state)) {
          throw new DgxRemoteLeaseLostError(
            `DGX-Owner-Heartbeat bestätigte keine aktive Lease mehr (${remote.state}).`,
          );
        }
        if (this.jobShouldStop(job) || state.stopped || job.dgxOwnerHeartbeat !== state) return;
        const acknowledgedAt = Date.now();
        state.acknowledgedOnce = true;
        state.lastAcknowledgedAt = acknowledgedAt;
        state.acknowledgedProgressEpoch = Math.max(
          state.acknowledgedProgressEpoch,
          sentProgressEpoch,
        );
        state.consecutiveFailures = 0;
        delete state.failureStartedAt;
        this.armDgxOwnerHeartbeatSafetyDeadline(job, state);
        if (state.lastError) {
          this.appendLog(job, "DGX-Owner-Heartbeat ist wieder erreichbar.");
          delete state.lastError;
          this.changed();
        }
        if (acknowledgedAt - state.lastProgressAt >= DGX_OWNER_NO_PROGRESS_TIMEOUT_MS) {
          await this.failStopDgxOwnerHeartbeat(
            job,
            state,
            `DGX-Lauf wurde nach ${Math.round(DGX_OWNER_NO_PROGRESS_TIMEOUT_MS / 60_000)} Minuten ohne `
              + "dauerhaft beobachteten Pipeline-Fortschritt fail-closed beendet.",
          );
        }
      } catch (error) {
        if (this.jobShouldStop(job)
          || isJobPersistenceHoldError(error)
          || state.stopped
          || job.dgxOwnerHeartbeat !== state) return;
        if (error instanceof DgxLeaseAuthorityError) {
          this.enterPersistenceHold(error, "DGX-Owner-Heartbeat verlor seine Lease-Autorität");
          return;
        }
        if (error instanceof DgxRemoteLeaseLostError) {
          await this.failStopDgxOwnerHeartbeat(job, state, error.message);
          return;
        }
        const definitiveLoss = definitiveHeartbeatLeaseLoss(error);
        if (definitiveLoss) {
          await this.failStopDgxOwnerHeartbeat(job, state, definitiveLoss);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        // Publication is forbidden from the first observed heartbeat failure
        // until a later exact heartbeat response explicitly re-acknowledges us.
        const failedAt = Date.now();
        state.failureStartedAt ??= failedAt;
        state.consecutiveFailures += 1;
        let terminalObservation: DgxTerminalObservation | null = null;
        let statusReceipt: DgxLeaseReceipt | null = null;
        try {
          statusReceipt = requireDgxLeaseAuthority(job);
          if (job.dgxJobId !== state.jobId) {
            throw new DgxLeaseAuthorityError("DGX-Lease-ID änderte sich vor dem Heartbeat-Statusabgleich.");
          }
          const readResponse = await this.dgxQueueOperations.read(state.jobId);
          const remote = dgxResponseBoundJob(
            readResponse,
            "job-read",
            state.jobId,
            job.id,
          );
          if (!remote) {
            throw new DgxLeaseAuthorityError(
              "Heartbeat-Statusabgleich war nicht exakt caller- und idempotenzgebunden.",
            );
          }
          terminalObservation = dgxResponseTerminalObservation(
            readResponse,
            "job-read",
            state.jobId,
            job.id,
          );
          if (terminalObservation
            || !["starting", "running", "pausing", "resuming"].includes(remote.state)) {
            await this.failStopDgxOwnerHeartbeat(
              job,
              state,
              terminalObservation
                ? `DGX-Remote-Lease wurde während des lokalen Laufs ${terminalObservation.state}.`
                : `DGX-Remote-Lease ist nicht mehr aktiv (${remote.state}).`,
              terminalObservation ?? undefined,
            );
            return;
          }
        } catch (readError) {
          if (this.persistenceHold
            || isJobPersistenceHoldError(readError)
            || state.stopped
            || job.dgxOwnerHeartbeat !== state) return;
          const goneObservation = statusReceipt
            ? dgxGoneTerminalObservation(readError, statusReceipt)
            : null;
          if (goneObservation) {
            await this.failStopDgxOwnerHeartbeat(
              job,
              state,
              `DGX-Remote-Lease ist laut exaktem HTTP-410-Beleg ${goneObservation.state}.`,
              goneObservation,
            );
            return;
          }
          if (readError instanceof DgxLeaseAuthorityError) {
            this.enterPersistenceHold(readError, "Heartbeat-Statusabgleich verlor seine Lease-Autorität");
            return;
          }
          const definitiveReadLoss = definitiveHeartbeatLeaseLoss(readError);
          if (definitiveReadLoss) {
            await this.failStopDgxOwnerHeartbeat(job, state, definitiveReadLoss);
            return;
          }
        }
        if (message !== state.lastError) {
          state.lastError = message;
          this.appendLog(job, `DGX-Owner-Heartbeat vorübergehend fehlgeschlagen: ${message}`);
          this.changed();
        }
        if (failedAt - state.failureStartedAt >= DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS
          || failedAt - state.lastAcknowledgedAt >= DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS) {
          await this.failStopDgxOwnerHeartbeat(
            job,
            state,
            `DGX-Owner-Heartbeat blieb ${Math.round(DGX_OWNER_HEARTBEAT_FAILURE_TIMEOUT_MS / 1_000)} s `
              + `ohne Bestätigung (${state.consecutiveFailures} Fehler); lokale Compute-Arbeit wurde fail-closed beendet.`,
          );
          return;
        }
        if (failedAt - state.lastProgressAt >= DGX_OWNER_NO_PROGRESS_TIMEOUT_MS) {
          await this.failStopDgxOwnerHeartbeat(
            job,
            state,
            `DGX-Lauf überschritt die ${Math.round(DGX_OWNER_NO_PROGRESS_TIMEOUT_MS / 60_000)}-Minuten-No-Progress-Frist.`,
          );
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
      job.dgxOwnerHeartbeat.lastProgressAt = Date.now();
      this.armDgxOwnerHeartbeatSafetyDeadline(job, job.dgxOwnerHeartbeat);
    }
  }

  private setDgxOwnerHeartbeatPhase(job: RuntimeJob, phase: string): void {
    if (job.dgxOwnerHeartbeat && !job.dgxOwnerHeartbeat.stopped) {
      // Phase is descriptive only. Only markDgxOwnerProgress(), called after
      // a newly persisted Euler advance, may move the no-progress clock and
      // advertise `progressed: true` to the orchestrator.
      job.dgxOwnerHeartbeat.phase = phase;
    }
  }

  private async stopDgxOwnerHeartbeat(job: RuntimeJob): Promise<void> {
    const state = job.dgxOwnerHeartbeat;
    if (!state) return;
    state.stopped = true;
    if (state.timer) clearInterval(state.timer);
    if (state.safetyTimer) clearTimeout(state.safetyTimer);
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
      // A persistence HOLD is a fail-stop boundary.  Child pipes can still
      // deliver buffered data after the safety stop has begun, but those
      // callbacks must neither mutate the durable model nor call changed()
      // (which deliberately throws while the manager is held).
      if (this.persistenceHold) return false;
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
    const commitRecords = (records: string[]): void => {
      const logsSnapshot = [...job.logs];
      const progressSnapshot = job.progress;
      const heartbeatSnapshot = job.dgxOwnerHeartbeat;
      const heartbeatProgressSnapshot = heartbeatSnapshot?.progressEpoch;
      const heartbeatLastProgressAtSnapshot = heartbeatSnapshot?.lastProgressAt;
      const trackerSnapshot = progressTracker?.snapshot();
      if (!consumeRecords(records)) return;
      try {
        this.changed();
      } catch (error) {
        if (!isJobPersistenceHoldError(error)) {
          job.logs = logsSnapshot;
          job.progress = progressSnapshot;
          if (heartbeatSnapshot !== undefined
            && job.dgxOwnerHeartbeat === heartbeatSnapshot
            && heartbeatProgressSnapshot !== undefined
            && heartbeatLastProgressAtSnapshot !== undefined) {
            heartbeatSnapshot.progressEpoch = heartbeatProgressSnapshot;
            heartbeatSnapshot.lastProgressAt = heartbeatLastProgressAtSnapshot;
            this.armDgxOwnerHeartbeatSafetyDeadline(job, heartbeatSnapshot);
          }
          if (progressTracker && trackerSnapshot) progressTracker.restore(trackerSnapshot);
        }
        // EventEmitter callbacks have no awaiting caller.  HOLD already
        // scheduled the authoritative safety-stop; a proven pre-rename error
        // was rolled back above.  Neither may escape and prevent later close
        // listeners (including waitForProcess) from running.
        process.stderr.write(
          `LTX Studio Prozesslog konnte nicht dauerhaft übernommen werden: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    };
    const consume = (stream: keyof typeof buffers) => (chunk: Buffer) => {
      const framed = frameProcessLogChunk(buffers[stream], chunk.toString("utf8"));
      buffers[stream] = framed.rest;
      commitRecords(framed.records);
    };
    child.stdout?.on("data", consume("stdout"));
    child.stderr?.on("data", consume("stderr"));
    child.once("close", () => {
      const stdout = frameProcessLogChunk(buffers.stdout, "", true);
      const stderr = frameProcessLogChunk(buffers.stderr, "", true);
      buffers.stdout = "";
      buffers.stderr = "";
      commitRecords([...stdout.records, ...stderr.records]);
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
      const earlyError = this.earlyProcessErrors.get(child);
      if (earlyError) {
        finish({ code: null, signal: null, error: earlyError });
      } else if (child.exitCode !== null || child.signalCode !== null) {
        finish({ code: child.exitCode, signal: child.signalCode, error: null });
      }
    });
  }

  private watchSegmentBoundaries(
    job: RuntimeJob,
    checkpointRoot: string,
    fingerprint: string,
    generation: number,
  ): { stop: () => Promise<void>; yieldDecisionId: () => string | null } {
    if (this.jobShouldStop(job)) {
      return {
        stop: async () => undefined,
        yieldDecisionId: () => null,
      };
    }
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
      if (stopped || this.jobShouldStop(job) || !child || !processIsAlive(child)) return;
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
      const activationDecision = this.jobStartDecision(job);
      if (!activationDecision.allowed) {
        decision = {
          schema_version: "dgx-segment-schedule-decision.v1",
          action: "yield_to_waiting_job",
          current_job_id: job.dgxJobId ?? "missing",
          next_job_id: null,
          reason: `activation_gate_fail_closed:${activationDecision.reason}`,
          retry_after_seconds: 0,
        };
      } else {
        try {
          if (!job.dgxJobId) throw new Error("DGX-Job-ID fehlt an der Segmentgrenze");
          const expectedDgxJobId = job.dgxJobId;
          requireDgxLeaseAuthority(job);
          this.revalidateRuntimeTrustBoundary(job, "DGX-Segment-Fence");
          decision = await this.dgxSchedulerOperations.decide(expectedDgxJobId);
          if (this.jobShouldStop(job)
            || job.dgxJobId !== expectedDgxJobId
            || decision.current_job_id !== expectedDgxJobId) {
            throw new Error("Segmententscheidung gehört nicht zum laufenden DGX-Job");
          }
        } catch (error) {
          process.stderr.write(`LTX Studio Segmentgrenzen-Wächter (fail-closed): ${String(error)}\n`);
          decision = {
            schema_version: "dgx-segment-schedule-decision.v1",
            action: "yield_to_waiting_job",
            current_job_id: job.dgxJobId ?? "missing",
            next_job_id: null,
            reason: "scheduler_unavailable_fail_closed",
            retry_after_seconds: 5,
          };
        }
      }
      if (stopped || this.jobShouldStop(job) || !processIsAlive(child)) return;
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
      if (stopped || this.jobShouldStop(job) || !processIsAlive(child)) return;
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
      if (pollInFlight || stopped || this.jobShouldStop(job)) return;
      const currentPoll = poll();
      pollInFlight = currentPoll;
      const observedPoll = currentPoll.finally(() => {
        if (pollInFlight === currentPoll) pollInFlight = null;
      });
      this.runDetached(observedPoll, `Segmentgrenzen-Wächter ${job.id}`);
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
        const expectedDgxJobId = job.dgxJobId;
        requireDgxLeaseAuthority(job);
        this.revalidateRuntimeTrustBoundary(job, "DGX-Resume-Auswahl");
        const decision = await this.dgxSchedulerOperations.decide(expectedDgxJobId);
        if (this.jobShouldStop(job) || job.dgxJobId !== expectedDgxJobId) return false;
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
    const pausingApplied = await this.transitionDgxJob(job, "pausing", {
      current_step: "LTX Euler checkpoint committed; process exited before resource release",
      artifact,
    });
    if (this.jobShouldStop(job)) return false;
    if (!pausingApplied) {
      this.failJob(job, "DGX-Queue konnte den LTX-Slice nicht auf pausing setzen.");
      return false;
    }
    const pausedApplied = await this.transitionDgxJob(job, "paused", {
      current_step: "LTX process exited and cooperative checkpoint is durable",
      artifact,
    });
    if (this.jobShouldStop(job)) return false;
    if (!pausedApplied) {
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
      let resumed: boolean;
      try {
        resumed = await this.transitionDgxJob(job, "resuming", {
          current_step: "fresh start gate before resuming durable LTX checkpoint",
          artifact,
        });
      } catch (error) {
        if (error instanceof DgxCooperativeQueueContractError) {
          await this.settleDgxCooperativeQueueContractError(job, error);
          return false;
        }
        throw error;
      }
      if (resumed) break;
      if (this.jobShouldStop(job)) return false;
      if (!await this.waitForDelay(job, DGX_START_FENCE_RETRY_MS)) return false;
    }
    if (!isActiveJobStatus(job.status)) return false;

    this.appendLog(job, `LTX-Resume bleibt an dieselbe DGX-Zuteilung ${pausedJobId} gebunden.`);
    this.changed();
    return true;
  }

  private spawnBoundProcess(
    job: RuntimeJob,
    executable: string,
    args: string[],
    options: BoundProcessOptions,
  ): ChildProcess {
    let decision = normalizeJobExecutionDecision(job.executionDecision);
    if (!decision
      || decision.executionClass !== job.executionClass
      || decision.executionClass === "pending"
      || decision.requestSha256 !== runtimeAuthorityRequestSha256(job)
      || decision.protocolSha256 !== (job.experiment?.protocolSha256 ?? null)
      || canonicalJson(job.runProvenance?.executionDecision) !== canonicalJson(decision)) {
      throw new Error("Prozessstart ohne gültige persistierte ExecutionDecision verweigert.");
    }
    const {
      boundExecutable,
      inheritedFds = [],
      recheckExecutables = [],
      recheckDescriptors = [],
      startGate = false,
      genericGate = false,
      ...spawnOptions
    } = options;
    if (genericGate && !startGate) {
      throw new Error("Ein generisches Prozessgate benötigt seinen expliziten Parent-Pipe-FD.");
    }
    if (startGate && !genericGate && (boundExecutable || inheritedFds.length > 0)) {
      throw new Error("Der Refiner-Startgate-FD darf nicht mit anderen geerbten Deskriptoren geteilt werden.");
    }
    if (decision.executionClass === "cpu-only") {
      const audioRetimeOperation = decision.operation.kind === "ffmpeg-audio-retime"
        || decision.operation.kind === "ffmpeg-audio-retime-v2";
      const expectedExecutable = decision.operation.kind === "ffmpeg-audio-retime-v2"
        ? decision.operation.ffmpeg
        : decision.operation.kind === "ffmpeg-audio-retime"
          ? decision.operation.executable
          : null;
      const expectedVersion = decision.operation.kind === "ffmpeg-audio-retime-v2"
        ? decision.operation.ffmpegVersion
        : decision.operation.kind === "ffmpeg-audio-retime"
          ? decision.operation.ffmpegVersion
          : null;
      const expectedArgsSha256 = decision.operation.kind === "ffmpeg-audio-retime-v2"
        ? decision.operation.ffmpegArgsSha256
        : decision.operation.kind === "ffmpeg-audio-retime"
          ? decision.operation.argsSha256
          : null;
      const processBindingsMatch = (decision.operation.kind === "ffmpeg-audio-retime"
        || decision.operation.kind === "ffmpeg-audio-retime-v2")
        && !("reuseKind" in decision.cpuReuse)
        && cpuAudioRetimeDescriptorsMatch(
          decision.cpuReuse,
          inheritedFds,
          recheckDescriptors,
        )
        && cpuAudioRetimeVerifierMatches(decision.operation, recheckExecutables);
      if (!audioRetimeOperation
        || !processBindingsMatch
        || !boundExecutable
        || executable !== "/proc/self/fd/3"
        || JSON.stringify(expectedExecutable) !== JSON.stringify(boundExecutable.binding)
        || expectedVersion !== boundExecutable.version
        || expectedArgsSha256
          !== createHash("sha256").update(canonicalJson(args)).digest("hex")) {
        throw new Error("FFmpeg-FD oder Argumente stimmen nicht mit der persistierten CPU-Operation überein.");
      }
      verifyBoundExecutableDescriptor(boundExecutable);
      for (const executableDescriptor of recheckExecutables) {
        verifyBoundExecutableDescriptor(executableDescriptor);
      }
      for (const descriptor of recheckDescriptors) recheckVerifiedExecutionDescriptor(descriptor);
      if (decision.operation.state === "prepared") {
        const runningDecision = {
          ...decision,
          operation: {
            ...decision.operation,
            state: "running",
            // This is the CPU operation start, not the earlier Studio-job
            // start. It must be at or after the durably bound preparedAt.
            startedAt: now(),
          },
        } as JobExecutionDecision;
        if (!this.commitExecutionDecision(job, runningDecision)) {
          throw new Error("CPU-Operation konnte vor exec nicht dauerhaft auf running gesetzt werden.");
        }
        decision = normalizeJobExecutionDecision(job.executionDecision);
      }
      if (!decision || decision.executionClass !== "cpu-only" || decision.operation.state !== "running") {
        throw new Error("FFmpeg-Operation ist unmittelbar vor exec nicht dauerhaft running.");
      }
      // Recheck after the durable running fence. The held descriptor removes
      // pathname replacement; the v4 threat model explicitly retains the
      // same-uid in-place mutation residual without memfd/fs-verity.
      verifyBoundExecutableDescriptor(boundExecutable);
      for (const executableDescriptor of recheckExecutables) {
        verifyBoundExecutableDescriptor(executableDescriptor);
      }
      for (const descriptor of recheckDescriptors) recheckVerifiedExecutionDescriptor(descriptor);
    } else if (boundExecutable
      || inheritedFds.length > 0
      || recheckExecutables.length > 0
      || recheckDescriptors.length > 0) {
      throw new Error("Nur eine CPU-Operation darf gebundene Executable-, Medien- oder Prüf-FDs übergeben.");
    }
    this.revalidateRuntimeTrustBoundary(job, "Prozess-Spawn");
    // A final durable fence directly adjacent to spawn covers later state
    // changes and makes persistence failure observably win the race.
    this.persist();
    const descriptorCount = (boundExecutable ? 1 : 0) + inheritedFds.length;
    const spawnedExecutable = genericGate ? hostTcbExecutables.python3 : executable;
    const spawnedArgs = genericGate
      ? ["-I", "-S", "-c", GENERIC_PROCESS_START_GATE_CODE, String(descriptorCount), executable, ...args]
      : args;
    const child = spawn(spawnedExecutable, spawnedArgs, {
      ...spawnOptions,
      detached: true,
      shell: false,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        ...(startGate ? ["pipe" as const] : []),
        ...(boundExecutable ? [boundExecutable.fd] : []),
        ...inheritedFds,
      ],
    });
    // Node can return a ChildProcess without a PID and emit ENOENT/EACCES on
    // the next tick. Observe that error immediately; the durable gate helper
    // may reject before waitForProcess() is installed.
    child.once("error", (error) => this.earlyProcessErrors.set(child, error));
    return child;
  }

  private assertProcessStartGateReleaseAuthority(
    job: RuntimeJob,
    executable: string,
    args: readonly string[],
    options: BoundProcessOptions,
  ): void {
    if (this.jobShouldStop(job)) {
      throw new Error("Prozessstart wurde am unmittelbaren Startgate-Fence abgebrochen.");
    }
    const decision = normalizeJobExecutionDecision(job.executionDecision);
    if (!decision
      || decision.executionClass !== job.executionClass
      || decision.executionClass === "pending"
      || decision.requestSha256 !== runtimeAuthorityRequestSha256(job)
      || decision.protocolSha256 !== (job.experiment?.protocolSha256 ?? null)
      || canonicalJson(job.runProvenance?.executionDecision) !== canonicalJson(decision)) {
      throw new Error("Prozess-Startgate besitzt keine aktuelle persistierte ExecutionDecision.");
    }
    const {
      boundExecutable,
      inheritedFds = [],
      recheckExecutables = [],
      recheckDescriptors = [],
    } = options;
    if (decision.executionClass === "cpu-only") {
      const audioRetimeOperation = decision.operation.kind === "ffmpeg-audio-retime"
        || decision.operation.kind === "ffmpeg-audio-retime-v2";
      const expectedExecutable = decision.operation.kind === "ffmpeg-audio-retime-v2"
        ? decision.operation.ffmpeg
        : decision.operation.kind === "ffmpeg-audio-retime"
          ? decision.operation.executable
          : null;
      const expectedVersion = decision.operation.kind === "ffmpeg-audio-retime-v2"
        ? decision.operation.ffmpegVersion
        : decision.operation.kind === "ffmpeg-audio-retime"
          ? decision.operation.ffmpegVersion
          : null;
      const expectedArgsSha256 = decision.operation.kind === "ffmpeg-audio-retime-v2"
        ? decision.operation.ffmpegArgsSha256
        : decision.operation.kind === "ffmpeg-audio-retime"
          ? decision.operation.argsSha256
          : null;
      const processBindingsMatch = (decision.operation.kind === "ffmpeg-audio-retime"
        || decision.operation.kind === "ffmpeg-audio-retime-v2")
        && !("reuseKind" in decision.cpuReuse)
        && cpuAudioRetimeDescriptorsMatch(
          decision.cpuReuse,
          inheritedFds,
          recheckDescriptors,
        )
        && cpuAudioRetimeVerifierMatches(decision.operation, recheckExecutables);
      if (!audioRetimeOperation
        || decision.operation.state !== "running"
        || !processBindingsMatch
        || !boundExecutable
        || executable !== "/proc/self/fd/3"
        || JSON.stringify(expectedExecutable) !== JSON.stringify(boundExecutable.binding)
        || expectedVersion !== boundExecutable.version
        || expectedArgsSha256
          !== createHash("sha256").update(canonicalJson(args)).digest("hex")) {
        throw new Error("CPU-Prozessautorität driftete vor der Startgate-Freigabe.");
      }
      verifyBoundExecutableDescriptor(boundExecutable);
      for (const executableDescriptor of recheckExecutables) {
        verifyBoundExecutableDescriptor(executableDescriptor);
      }
      for (const descriptor of recheckDescriptors) recheckVerifiedExecutionDescriptor(descriptor);
    } else if (boundExecutable
      || inheritedFds.length > 0
      || recheckExecutables.length > 0
      || recheckDescriptors.length > 0) {
      throw new Error("Nicht-CPU-Prozess besitzt unerlaubte Deskriptoren am Startgate-Fence.");
    }
    const activationDecision = this.jobStartDecision(job);
    if (!activationDecision.allowed) {
      throw new Error(
        `Prozess-Startgate wurde vom aktuellen Activation-/Rights-Gate verweigert: ${activationDecision.reason}`,
      );
    }
    // Keep the Runtime-Seal check last: no await or user callback is allowed
    // between this revalidation and writing the one-byte exec token.
    this.revalidateRuntimeTrustBoundary(job, "unmittelbarer Prozess-Startgate-Freigabe");
  }

  private async releaseProcessStartGate(
    job: RuntimeJob,
    child: ChildProcess,
    executable: string,
    args: readonly string[],
    options: BoundProcessOptions,
  ): Promise<void> {
    const gate = child.stdio[3] as null | {
      once: (event: "error", listener: (error: Error) => void) => unknown;
      off: (event: "error", listener: (error: Error) => void) => unknown;
      end: (chunk: string, callback: () => void) => unknown;
    };
    if (!gate || typeof gate.end !== "function") {
      throw new Error("Prozess-Startgate-Pipe fehlt nach dem Spawn.");
    }
    this.assertProcessStartGateReleaseAuthority(job, executable, args, options);
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error) => reject(error);
      gate.once("error", onError);
      gate.end("1", () => {
        gate.off("error", onError);
        resolvePromise();
      });
    });
  }

  private prepareLocalProcessSpawn(job: RuntimeJob): void {
    if (job.localProcessSpawnPending
      || job.localProcessGroupPending
      || job.localProcessGroupIdentity
      || job.process) {
      throw new Error("Ein zweiter Prozessstart ohne geklärte lokale Spawn-/PG-Autorität wurde verweigert.");
    }
    job.localProcessSpawnPending = true;
    try {
      this.changed();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) delete job.localProcessSpawnPending;
      throw error;
    }
  }

  private clearLocalProcessSpawnPending(job: RuntimeJob): void {
    if (!job.localProcessSpawnPending || this.persistenceHold) return;
    delete job.localProcessSpawnPending;
    try {
      this.changed();
    } catch (error) {
      job.localProcessSpawnPending = true;
      throw error;
    }
    if (!isActiveJobStatus(job.status)) {
      this.runDetached(
        this.flushDgxTerminalDelivery(job),
        `DGX-Terminalzustellung nach Spawn-Gate-Abwesenheitsbeweis ${job.id}`,
      );
      this.scheduleDgxTerminalRetry(job, 0);
    }
  }

  private async spawnProcessWithDurableGate(
    job: RuntimeJob,
    executable: string,
    args: string[],
    options: BoundProcessOptions,
    beforeRelease?: (child: ChildProcess) => void | (() => void) | Promise<void | (() => void)>,
  ): Promise<ChildProcess> {
    this.prepareLocalProcessSpawn(job);
    let child: ChildProcess | undefined;
    try {
      if (this.jobShouldStop(job)) {
        this.clearLocalProcessSpawnPending(job);
        throw new Error("Prozessstart wurde vor dem Spawn-Gate abgebrochen.");
      }
      child = this.spawnBoundProcess(job, executable, args, {
        ...options,
        startGate: true,
        genericGate: true,
      });
      await this.markProcessStarted(job, child);
      if (this.jobShouldStop(job)) {
        throw new Error("Prozessstart wurde vor der Gate-Freigabe abgebrochen.");
      }
      await beforeRelease?.(child);
      if (this.jobShouldStop(job)) {
        throw new Error("Prozessstart wurde während der Gate-Freigabevorbereitung abgebrochen.");
      }
      await this.releaseProcessStartGate(job, child, executable, args, options);
      return child;
    } catch (error) {
      const gate = child?.stdio[3] as { destroy?: () => void } | null | undefined;
      gate?.destroy?.();
      if (child?.pid && processGroupExists(child.pid)) {
        await this.stopProcessBeforeTerminalDelivery(job, child, false, 250, 2_000)
          .catch(() => undefined);
      }
      if (!child?.pid || !processGroupExists(child.pid)) {
        try {
          this.clearLocalProcessSpawnPending(job);
        } catch {
          // The durable spawn marker remains the restart fence.
        }
      }
      throw error;
    }
  }

  private async spawnOwnedDockerRefiner(
    job: RuntimeJob,
    workload: OwnedDockerThermalWorkload,
    containerName: string,
    executable: string,
    args: string[],
    options: BoundProcessOptions,
    beforeRelease?: (child: ChildProcess) => void | (() => void) | Promise<void | (() => void)>,
  ): Promise<ChildProcess> {
    const containerNamePositions = args
      .map((argument, index) => argument === "--container-name" ? index : -1)
      .filter((index) => index >= 0);
    if (containerNamePositions.length !== 1
      || args.some((argument) => argument.startsWith("--container-name="))
      || args[containerNamePositions[0]! + 1] !== containerName
      || options.env.DGX_JOB_ID !== job.dgxJobId) {
      throw new Error(
        `${workload.label}-Wrapper stimmt nicht exakt mit Containername und DGX_JOB_ID seiner persistierten Autorität überein.`,
      );
    }
    this.bindOwnedDockerContainer(job, containerName, workload);
    this.prepareLocalProcessSpawn(job);
    let child: ChildProcess | undefined;
    let abortPreparedObservers: (() => void) | undefined;
    try {
      child = this.spawnBoundProcess(
        job,
        executable,
        args,
        { ...options, startGate: true, genericGate: true },
      );
      await this.markProcessStarted(job, child);
      if (this.jobShouldStop(job)) {
        throw new Error("Refiner-Startgate wurde vor der Freigabe abgebrochen.");
      }
      const observerCleanup = await beforeRelease?.(child);
      if (typeof observerCleanup === "function") abortPreparedObservers = observerCleanup;
      if (this.jobShouldStop(job)) {
        throw new Error("Refiner-Startgate wurde während der Freigabevorbereitung abgebrochen.");
      }
      this.markOwnedDockerStartGateReleased(job);
      await this.releaseProcessStartGate(job, child, executable, args, options);
      await this.pinStartedOwnedDockerContainer(job, child);
      return child;
    } catch (error) {
      abortPreparedObservers?.();
      const gate = child?.stdio[3] as { destroy?: () => void } | null | undefined;
      gate?.destroy?.();
      if (child?.pid) {
        await this.stopProcessBeforeTerminalDelivery(job, child, false, 250, 2_000)
          .catch(() => undefined);
      }
      if (!child?.pid || !processGroupExists(child.pid)) {
        try {
          this.clearLocalProcessSpawnPending(job);
        } catch {
          // The durable spawn marker remains the restart fence.
        }
      }
      await this.cleanupOwnedDockerContainer(job).catch(() => false);
      throw error;
    }
  }

  private async runLoggedProcess(
    job: RuntimeJob,
    executable: string,
    args: string[],
    options: BoundProcessOptions,
  ): Promise<ProcessResult> {
    let child: ChildProcess;
    let completion: Promise<ProcessResult> | null = null;
    try {
      job.status = "running";
      job.startedAt ??= now();
      child = await this.spawnProcessWithDurableGate(
        job,
        executable,
        args,
        options,
        (gatedChild) => {
          this.consumeProcessLogs(job, gatedChild);
          completion = this.waitForProcess(gatedChild);
        },
      );
    } catch (error) {
      return {
        code: null,
        signal: null,
        error: new Error(
          `Prozessstart am dauerhaften Startgate verweigert: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      };
    }
    const result = await (completion ?? this.waitForProcess(child));
    await this.confirmProcessGroupGone(job, child);
    return result;
  }

  private async readThermalBaseline(job: RuntimeJob, workloadLabel = "LTX"): Promise<number | null> {
    const maxC = await readMedianMaxTemperatureC({
      samples: thermalStartSamples,
      intervalMs: thermalStartSampleIntervalMs,
    });
    if (this.jobShouldStop(job)) return null;
    if (maxC !== null && maxC < thermalPauseC) {
      const resumeBelowC = thermalResumeC;
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
        `Thermal-Basiswert: ${maxC.toFixed(1)} °C Host-Maximum. Pause ab ${thermalPauseC.toFixed(1)} °C; Wiederanlauf erst nach ${thermalResumePolls} Messungen bei oder unter ${resumeBelowC.toFixed(1)} °C.`,
      );
      return maxC;
    }
    const error = maxC === null
      ? `Temperatur ist nicht messbar; ${workloadLabel}-Start aus Sicherheitsgründen blockiert.`
      : `Host bereits bei ${maxC.toFixed(1)} °C; kein ${workloadLabel}-Start an oder über der Hardware-Pausenschwelle von ${thermalPauseC.toFixed(0)} °C.`;
    this.failJob(job, error);
    return null;
  }

  private watchThermals(
    job: RuntimeJob,
    child: ChildProcess,
    baselineC: number,
    operations: ThermalWatcherOperations = {},
  ): () => void {
    const resumeBelowC = thermalResumeC;
    const readTemperatureC = operations.readTemperatureC ?? readMaxTemperatureC;
    const childIsAlive = operations.processIsAlive ?? processIsAlive;
    const signalChild = operations.signalProcessGroup ?? signalProcessGroup;
    const setHeartbeatPhase = operations.setHeartbeatPhase
      ?? ((phase: string) => this.setDgxOwnerHeartbeatPhase(job, phase));
    const onPause = operations.onPause ?? (() => undefined);
    let peakC = baselineC;
    const guard = new ThermalPauseGuard({
      pauseAtC: thermalPauseC,
      pausePolls: thermalPausePolls,
      resumeBelowC,
      resumePolls: thermalResumePolls,
      unreadablePolls: thermalUnreadablePolls,
    });
    const timer = setInterval(() => {
      if (this.jobShouldStop(job)
        || !childIsAlive(child)
        || !["running", "paused"].includes(job.status)) return;
      try {
        const temperatureC = readTemperatureC();
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
          if (!signalChild(child, "SIGSTOP")) return;
          onPause();
          job.status = "paused";
          setHeartbeatPhase("thermal_pause");
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
          if (!signalChild(child, "SIGCONT")) return;
          job.status = "running";
          setHeartbeatPhase("ltx_rendering");
          this.appendLog(
            job,
            `Thermalpause beendet: ${temperatureC?.toFixed(1)} °C über ${thermalResumePolls} Messungen bei oder unter der Wiederanlaufschwelle ${resumeBelowC.toFixed(1)} °C. LTX läuft ohne Neustart weiter.`,
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
      if (this.persistenceHold) return;
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
    workload: OwnedDockerThermalWorkload,
    operations: ThermalWatcherOperations = {},
  ): () => void {
    const resumeBelowC = thermalResumeC;
    const readTemperatureC = operations.readTemperatureC ?? readMaxTemperatureC;
    const childIsAlive = operations.processIsAlive ?? processIsAlive;
    const signalChild = operations.signalProcessGroup ?? signalProcessGroup;
    const setHeartbeatPhase = operations.setHeartbeatPhase
      ?? ((phase: string) => this.setDgxOwnerHeartbeatPhase(job, phase));
    let peakC = baselineC;
    const guard = new ThermalPauseGuard({
      pauseAtC: thermalPauseC,
      pausePolls: thermalPausePolls,
      resumeBelowC,
      resumePolls: thermalResumePolls,
      unreadablePolls: thermalUnreadablePolls,
    });
    const productionDockerAction = (action: "pause" | "unpause"): boolean => {
      try {
        return this.controlOwnedDockerThermalState(
          job,
          containerName,
          workload,
          action,
        );
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (this.persistenceHold || error instanceof JobPersistenceHoldError) {
          // enterPersistenceHold() owns the only authorized SIGCONT/TERM/KILL
          // and immutable-ID Docker cleanup sequence from this point onward.
          process.stderr.write(
            `LTX Studio ${workload.label}-Thermalwächter im Persistenz-HOLD beendet: ${detail}\n`,
          );
          return false;
        }
        this.appendLog(
          job,
          `${workload.label}-Thermalschutz konnte den eigenen Container nicht mit docker ${action} steuern: ${detail}`,
        );
        signalChild(child, "SIGTERM");
        this.changed();
        return false;
      }
    };
    const dockerAction = (action: "pause" | "unpause") => operations.dockerAction
      ? operations.dockerAction(action, containerName)
      : productionDockerAction(action);
    const timer = setInterval(() => {
      if (this.jobShouldStop(job)
        || !childIsAlive(child)
        || !["running", "paused"].includes(job.status)) return;
      try {
        const temperatureC = readTemperatureC();
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
          setHeartbeatPhase("thermal_pause");
          const reason = action === "pause_hot"
            ? `${temperatureC?.toFixed(1)} °C über ${thermalPausePolls} Messungen`
            : `${thermalUnreadablePolls} Temperaturmessungen ohne verwertbaren Sensorwert`;
          this.appendLog(
            job,
            `Thermalpause: ${reason}. Der ${workload.label}-Container bleibt vollständig im Speicher und wird nach Abkühlung nahtlos fortgesetzt.`,
          );
          this.changed();
          return;
        }
        if (action === "resume") {
          if (!dockerAction("unpause")) return;
          job.status = "running";
          setHeartbeatPhase(workload.resumeHeartbeatPhase);
          this.appendLog(
            job,
            `Thermalpause beendet: ${temperatureC?.toFixed(1)} °C über ${thermalResumePolls} Messungen bei oder unter der Wiederanlaufschwelle ${resumeBelowC.toFixed(1)} °C. ${workload.label} läuft ohne Neustart weiter.`,
          );
          this.changed();
          return;
        }
        this.changed();
      } catch (error) {
        process.stderr.write(`LTX Studio ${workload.label}-Thermalwächter: ${String(error)}\n`);
      }
    }, thermalPollIntervalMs);
    timer.unref();
    return () => {
      clearInterval(timer);
      if (this.persistenceHold) return;
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
        `${workload.label}-Thermalprofil (gesamter Host): Basis ${baselineC.toFixed(1)} °C, Peak ${peakC.toFixed(1)} °C, beobachteter Anstieg ${(peakC - baselineC).toFixed(1)} °C.`,
      );
    };
  }

  private async waitForLongcatResources(job: RuntimeJob): Promise<boolean> {
    let lastAvailable: number | null = null;
    let lastLogAt = 0;
    while (!this.jobShouldStop(job) && job.status === "queued") {
      const resource = readResourceSnapshot();
      const available = resource.availableMemoryGiB;
      if (available !== null && available >= longcatMinAvailableGiB) {
        const temperatureC = await readMedianMaxTemperatureC({
          samples: thermalStartSamples,
          intervalMs: thermalStartSampleIntervalMs,
        });
        if (this.jobShouldStop(job) || job.status !== "queued") return false;
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

  private classifyExecution(
    job: RuntimeJob,
    executionClass: Exclude<JobExecutionClass, "pending">,
    cpuReuse?: CpuReuseSourceBinding,
    operation?: CpuOperation,
  ): boolean {
    if (isBoundRawOutputCandidate(job)
      && (executionClass !== "cpu-only"
        || operation?.kind !== "paired-artifact-promotion"
        || !cpuReuse
        || !("reuseKind" in cpuReuse)
        || cpuReuse.reuseKind !== "lipforcing-raw-mux-pair")) {
      this.failJob(
        job,
        "Mux-copy-Kandidaten dürfen ausschließlich als gebundene paired-artifact-promotion laufen; DGX- oder Audio-Retime-Fallback ist verboten.",
      );
      return false;
    }
    const current = job.executionClass;
    if (current !== undefined && current !== "pending" && current !== executionClass) {
      this.failJob(
        job,
        `Ausführungsklasse bleibt fail-closed: ${current} kann nicht als ${executionClass} umklassifiziert werden.`,
      );
      return false;
    }
    if (executionClass === "cpu-only" && (!cpuReuse || !operation)) {
      this.failJob(job, "CPU-only darf nur mit vollständig gebundener Baseline und registrierter Operation klassifiziert werden.");
      return false;
    }
    if (executionClass === "dgx" && (cpuReuse || operation)) {
      this.failJob(job, "DGX-Klassifizierung darf keine CPU-Reuse-Quelle tragen.");
      return false;
    }
    if (job.executionDecision?.executionClass === executionClass) {
      const currentDecision = normalizeJobExecutionDecision(job.executionDecision);
      const requestSha256 = runtimeAuthorityRequestSha256(job);
      if (!currentDecision
        || !requestSha256
        || currentDecision.requestSha256 !== requestSha256
        || currentDecision.protocolSha256 !== (job.experiment?.protocolSha256 ?? null)
        || canonicalJson(job.runProvenance?.executionDecision) !== canonicalJson(currentDecision)) {
        this.failJob(job, "Persistierte Ausführungsentscheidung driftete vor dem Startgate; Lauf bleibt fail-closed.");
        return false;
      }
      return true;
    }
    const decision = {
      schemaVersion: job.executionDecision?.schemaVersion
        ?? "ltx-studio-execution-decision.v6",
      executionClass,
      decidedAt: now(),
      reason: executionClass === "dgx"
        ? "Der verbleibende Renderplan kann DGX-Ressourcen belegen; Entscheidung vor Queue-Admission persistiert."
        : operation?.kind === "paired-artifact-promotion"
          ? "Gepaarter privater Kandidatenarm wurde aus exakt einem Baseline-Pre-Mux abgeleitet, protokollgebunden gesnapshottet und wird nur atomar publiziert."
          : "Exakt protokollgebundene Baseline wurde vor und nach privatem Snapshot verifiziert; nur FFmpeg-Audio-Retime.",
      requestSha256: job.authorityRequestSha256,
      protocolSha256: job.experiment?.protocolSha256 ?? null,
      cpuReuse: executionClass === "cpu-only" ? cpuReuse! : null,
      operation: executionClass === "cpu-only" ? operation! : null,
    } as JobExecutionDecision;
    return this.commitExecutionDecision(job, decision);
  }

  private commitExecutionDecision(job: RuntimeJob, decision: JobExecutionDecision): boolean {
    const normalized = normalizeJobExecutionDecision(decision);
    const requestSha256 = runtimeAuthorityRequestSha256(job);
    const protocolSha256 = job.experiment?.protocolSha256 ?? null;
    if (!normalized
      || normalized.executionClass !== decision.executionClass
      || !requestSha256
      || normalized.requestSha256 !== requestSha256
      || normalized.protocolSha256 !== protocolSha256
      || !jobExecutionDecisionIsMonotone(job.executionDecision, normalized)) {
      this.failJob(job, "Ausführungsentscheidung ist ungültig, widersprüchlich oder nicht monoton; Lauf bleibt fail-closed.");
      return false;
    }
    if (normalized.executionClass === "cpu-only") {
      const binding = job.experiment;
      const commonBindingMatches = Boolean(
        binding
        && binding.arm === "candidate"
        && binding.baselineJobId === normalized.cpuReuse.baselineJobId
        && binding.baselineOutputName === normalized.cpuReuse.baselineOutputName
        && binding.baselineRequestSha256 === normalized.cpuReuse.baselineRequestSha256
        && binding.protocolSha256 === normalized.protocolSha256,
      );
      let operationBindingMatches = false;
      if ((normalized.operation.kind === "ffmpeg-audio-retime"
        || normalized.operation.kind === "ffmpeg-audio-retime-v2")
        && !("reuseKind" in normalized.cpuReuse)) {
        const variableId = boundProgramAudioDelayVariable({
          request: job.request,
          experiment: binding,
        });
        const operationMatchesVariable = normalized.operation.kind === "ffmpeg-audio-retime-v2"
          ? variableId === "program-audio-delay-ms"
          : variableId === "lipforcing-program-audio-delay-ms";
        operationBindingMatches = variableId !== null
          && operationMatchesVariable
          && normalized.operation.deltaMs
            === programAudioDelayValue(job.request, variableId)
              - normalized.cpuReuse.sourceProgramAudioDelayMs;
      } else if (normalized.operation.kind === "paired-artifact-promotion"
        && "reuseKind" in normalized.cpuReuse
        && normalized.cpuReuse.reuseKind === "lipforcing-raw-mux-pair") {
        operationBindingMatches = binding?.variableId === "lipforcing-raw-output-profile"
          && validRawOutputExperimentBinding(job.request, binding) !== null
          && normalized.operation.authoritySha256 === normalized.cpuReuse.authority.sha256;
      }
      if (!commonBindingMatches
        || !operationBindingMatches
        || !binding
        || job.dgxJobId !== null
        || job.dgxSubmitPending) {
        this.failJob(job, "CPU-only-Entscheidung widerspricht der eingefrorenen Baseline- oder DGX-Bindung.");
        return false;
      }
    }
    job.executionClass = normalized.executionClass;
    job.executionDecision = normalized;
    if (job.runProvenance) job.runProvenance = bindRunExecutionDecision(job.runProvenance, normalized);
    // This durable write is the process/queue fence. Callers may spawn or
    // submit only after it returned successfully.
    this.changed();
    return true;
  }

  private observeDgxMemoryWait(
    job: RuntimeJob,
    rawBlocker: unknown,
    options: {
      observedAt?: string;
      retainWhenMissing?: boolean;
      advanceAuthoritativeObservedAt?: boolean;
    } = {},
  ): boolean {
    const next = memoryWaitFromDgxBlocker(rawBlocker, options.observedAt ?? now());
    if (!next) {
      if (rawBlocker === undefined && options.retainWhenMissing) return false;
      if (!job.dgxMemoryWait) return false;
      job.dgxMemoryWait = null;
      return true;
    }
    const previous = normalizePublicDgxMemoryWait(job.dgxMemoryWait);
    if (previous
      && previous.availableGiB === next.availableGiB
      && previous.pendingReservationsGiB === next.pendingReservationsGiB
      && previous.requiredAvailableGiB === next.requiredAvailableGiB
      && previous.currentShortfallGiB === next.currentShortfallGiB
      && previous.qwenPagingReservedGiB === next.qwenPagingReservedGiB
      && previous.qwenRestoreReservedGiB === next.qwenRestoreReservedGiB
      && previous.qwenEvictedTriggerReservedGiB === next.qwenEvictedTriggerReservedGiB) {
      if (options.advanceAuthoritativeObservedAt
        && Date.parse(next.observedAt) > Date.parse(previous.observedAt)) {
        // A newer Runtime-API last_start_gate is a new measurement even when
        // rounding leaves every visible equation operand unchanged. Persist
        // its server timestamp without duplicating the unchanged diagnosis.
        job.dgxMemoryWait = next;
        return true;
      }
      // A queue poll can project the same persisted gate snapshot repeatedly;
      // receipt time is not measurement time. Preserve the first observation
      // until at least one equation operand actually changes.
      job.dgxMemoryWait = previous;
      return false;
    }
    job.dgxMemoryWait = next;
    this.appendLog(job, describeDgxMemoryWait(next));
    return true;
  }

  private observeQueueJobMemoryWait(
    job: RuntimeJob,
    queueJob: QueueJobSummary,
    fallbackBlocker?: unknown,
    options: { retainWhenMissing?: boolean } = {},
  ): boolean {
    const observation = queueJobMemoryObservation(queueJob, fallbackBlocker);
    return this.observeDgxMemoryWait(job, observation.blocker, {
      ...(observation.observedAt === undefined ? {} : { observedAt: observation.observedAt }),
      retainWhenMissing: options.retainWhenMissing === true && !observation.authoritative,
      advanceAuthoritativeObservedAt: observation.observedAt !== undefined,
    });
  }

  private appendLog(job: RuntimeJob, value: string): void {
    job.logs.push(cleanLogLine(value));
    if (job.logs.length > MAX_LOG_LINES) job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
  }

  private emitChangedSnapshot(): void {
    const snapshot = this.list();
    // EventEmitter.emit() stops at the first throwing listener. Invoke its raw
    // listener wrappers individually so one broken SSE/client observer cannot
    // starve every listener registered after it; once() wrappers retain their
    // normal self-removal behavior when invoked.
    for (const listener of this.rawListeners("changed")) {
      try {
        (listener as (jobs: StudioJob[]) => void).call(this, snapshot);
      } catch (error) {
        process.stderr.write(
          `LTX Studio Changed-Listener ist fehlgeschlagen; durable Mutation bleibt gültig: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
    }
  }

  private changed(): void {
    this.persist();
    this.emitChangedSnapshot();
  }

  private restoreOutputAuthorityArchive(): void {
    if (!existsSync(this.outputAuthorityArchivePath)) return;
    try {
      const entries = parseOutputAuthorityArchive(
        readProtectedJsonFile(this.outputAuthorityArchivePath, 128 * 1024 * 1024),
      );
      if (!entries) throw new Error("Output-Authority-Archiv ist strukturell oder kryptografisch ungueltig.");
      for (const entry of entries) this.outputAuthorityArchive.set(entry.id, entry);
    } catch {
      // Never trust a partially written or edited ledger. Reconciliation below
      // revokes every marker/raw pair that no current terminal job can prove.
      this.outputAuthorityArchive.clear();
      this.outputAuthorityArchiveNeedsRewrite = true;
    }
  }

  private persistOutputAuthorityArchive(): void {
    const value: PersistedOutputAuthorityArchive = {
      schemaVersion: "ltx-studio-output-authority-archive.v1",
      entries: [...this.outputAuthorityArchive.values()]
        .sort((left, right) => left.finishedAt!.localeCompare(right.finishedAt!)),
    };
    this.commitManagedSnapshot({
      path: this.outputAuthorityArchivePath,
      value,
      recoveryRelativePath: this.recovery
        ? `${this.recovery.targetRelativePath}.output-authority.v1.json`
        : null,
    });
    this.outputAuthorityArchiveNeedsRewrite = false;
  }

  private archivePublishedJob(job: RuntimeJob): void {
    const archived = archivedOutputAuthorityFromJob(job);
    if (!archived) throw new Error("Terminaler Job konnte nicht in das Output-Authority-Archiv gebunden werden.");
    const archiveSnapshot = new Map(this.outputAuthorityArchive);
    for (const [archivedId, entry] of this.outputAuthorityArchive) {
      if (archivedId !== job.id && entry.outputName === job.outputName) {
        this.outputAuthorityArchive.delete(archivedId);
      }
    }
    this.outputAuthorityArchive.set(job.id, archived);
    try {
      this.persistOutputAuthorityArchive();
    } catch (error) {
      if (!isJobPersistenceHoldError(error)) {
        this.outputAuthorityArchive.clear();
        for (const [jobId, entry] of archiveSnapshot) {
          this.outputAuthorityArchive.set(jobId, entry);
        }
      }
      throw error;
    }
  }

  /**
   * Reconciliation has no authority to destroy an unclaimed media artifact.
   * Marker removal and private quarantine are both best-effort: if either
   * operation fails, the raw pathname may remain as a name reservation, but
   * it cannot be served or mutated because no archive/job authority is kept.
   */
  private revokeUntrustedOutputPublicationPreservingRaw(
    outputPath: string,
    quarantineRoot: string,
  ): void {
    try {
      this.outputAuthorityReconciliationOperations.removePublicationAuthority(outputPath);
    } catch {
      // The archive/job match below is the mandatory public authority half.
    }
    try {
      this.outputAuthorityReconciliationOperations.quarantineUnreleased(
        outputPath,
        quarantineRoot,
      );
    } catch {
      // Preserve the only remaining raw bytes in place; the name stays reserved.
    }
    try {
      this.outputAuthorityReconciliationOperations.removePublicationAuthority(outputPath);
    } catch {
      // A surviving marker is inert without the archive/job claim removed below.
    }
  }

  private reconcileOutputAuthorityArchive(): void {
    let changed = this.outputAuthorityArchiveNeedsRewrite;
    for (const job of this.jobs.values()) {
      if (job.status !== "completed" || !job.outputPublication) continue;
      const archived = archivedOutputAuthorityFromJob(job);
      if (!archived) continue;
      for (const [archivedId, entry] of this.outputAuthorityArchive) {
        if (archivedId !== job.id && entry.outputName === job.outputName) {
          this.outputAuthorityArchive.delete(archivedId);
          changed = true;
        }
      }
      if (JSON.stringify(this.outputAuthorityArchive.get(job.id)) !== JSON.stringify(archived)) {
        this.outputAuthorityArchive.set(job.id, archived);
        changed = true;
      }
    }

    for (const [jobId, entry] of [...this.outputAuthorityArchive]) {
      const outputPath = join(outputRoot, entry.outputName);
      const publication = readValidOutputPublicationAuthority(outputRoot, entry.outputName);
      const expected = normalizeOutputPublicationAuthority(entry.outputPublication, outputPath);
      if (publication && expected && canonicalJson(publication) === canonicalJson(expected)) continue;
      this.revokeUntrustedOutputPublicationPreservingRaw(
        outputPath,
        join(hybridRoot, jobId),
      );
      this.outputAuthorityArchive.delete(jobId);
      changed = true;
    }

    try {
      for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(OUTPUT_PUBLICATION_SUFFIX)) continue;
        const outputName = entry.name.slice(0, -OUTPUT_PUBLICATION_SUFFIX.length);
        if ([...this.outputAuthorityArchive.values()].some((authority) => authority.outputName === outputName)) {
          continue;
        }
        const outputPath = join(outputRoot, outputName);
        this.revokeUntrustedOutputPublicationPreservingRaw(
          outputPath,
          join(hybridRoot, `orphan-publication-${randomUUID()}`),
        );
      }
    } catch {
      // A missing output directory has no public bytes to reconcile.
    }
    if (changed
      || (this.outputAuthorityArchive.size > 0 && !existsSync(this.outputAuthorityArchivePath))) {
      this.persistOutputAuthorityArchive();
    }
  }

  private reconcileOutputAuthorityArchiveAtStartup(context: string): void {
    try {
      this.reconcileOutputAuthorityArchive();
    } catch (error) {
      // Archive reconciliation is part of the same startup authority boundary
      // as jobs.json. A rewrite failure must keep the server alive in sticky
      // HOLD so health/recovery remain observable; it must never crash startup
      // or expose an in-memory archive whose durability is unknown.
      if (!this.persistenceHold) {
        this.enterPersistenceHold(error, context);
      }
    }
  }

  private persist(): void {
    const values = [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(persistedJob);
    this.commitJobSnapshot(values);
  }

  private restore(): void {
    this.restoreOutputAuthorityArchive();
    if (!existsSync(this.storagePath)) {
      this.reconcileOutputAuthorityArchiveAtStartup(
        `Output-Authority-Archiv ${this.outputAuthorityArchivePath} konnte beim leeren Startup nicht beweiskräftig abgeglichen werden`,
      );
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as unknown;
      if (!Array.isArray(parsed)) {
        throw new Error("Persistierter Job-Snapshot ist kein Array.");
      }
      const seenIds = new Set<string>();
      const legacyImportIds = new Set<string>();
      const stored: PersistedStudioJob[] = [];
      for (const candidate of parsed) {
        const entry = candidate && typeof candidate === "object" && !Array.isArray(candidate)
          ? candidate as Record<string, unknown>
          : null;
        if (!entry) continue;
        const rawId = entry.id;
        if (typeof rawId === "string") {
          if (seenIds.has(rawId)) {
            throw new Error(`Persistierter Job-Snapshot enthält die doppelte Job-ID ${rawId}.`);
          }
          seenIds.add(rawId);
        }
        const validId = typeof rawId === "string" && STUDIO_JOB_ID_PATTERN.test(rawId);
        const validStatuses = [
          "queued", "running", "paused", "completed", "failed", "cancelled", "interrupted",
        ];
        const validStatus = typeof entry.status === "string" && validStatuses.includes(entry.status);
        const activeOrUnclearStatus = !validStatus
          || (validStatus && isActiveJobStatus(entry.status as JobStatus));
        const rawDgxClaim = entry.dgxJobId !== undefined && entry.dgxJobId !== null;
        const validDgxJobId = isDgxJobId(entry.dgxJobId);
        const executionDecision = entry.executionDecision
          && typeof entry.executionDecision === "object"
          && !Array.isArray(entry.executionDecision)
          ? entry.executionDecision as Record<string, unknown>
          : null;
        const operation = executionDecision?.operation
          && typeof executionDecision.operation === "object"
          && !Array.isArray(executionDecision.operation)
          ? executionDecision.operation as Record<string, unknown>
          : null;
        const activeExecutionClaim = validStatus
          && isActiveJobStatus(entry.status as JobStatus)
          && (executionDecision?.executionClass === "pending"
            || (executionDecision?.executionClass === "cpu-only"
              && (operation?.state === "prepared" || operation?.state === "running")));
        let migratedRequest: GenerationRequest | null = null;
        try {
          migratedRequest = migrateGenerationRequest(structuredClone(entry.request));
        } catch {
          migratedRequest = null;
        }
        const terminalLegacyStatus = validStatus
          && !isActiveJobStatus(entry.status as JobStatus)
          && (["completed", "failed", "cancelled", "interrupted"] as const)
            .includes(entry.status as LegacyTerminalStatus);
        const legacyImportCandidate = terminalLegacyStatus
          && entry.legacyHistory === undefined
          && !Object.hasOwn(entry, "executionClass")
          && !Object.hasOwn(entry, "executionDecision")
          && entry.localProcessProtocol === undefined
          && entry.startSource === undefined
          && entry.startDeferred === undefined
          && entry.dgxSubmitPending !== true
          && entry.dgxSubmitStartedAt === undefined
          && entry.dgxPreparedAdmission === undefined
          && entry.dgxPreparedAdmissionSha256 === undefined
          && entry.dgxSuccessorAuthorization === undefined
          && entry.dgxLeaseReceipt === undefined
          && entry.dgxTerminalDelivery === undefined
          && entry.dgxTerminalReceipt === undefined
          && entry.localProcessSpawnPending === undefined
          && entry.localProcessGroupPending === undefined
          && entry.localProcessGroupIdentity === undefined
          && entry.ownedDockerContainer === undefined
          && entry.ownedDockerContainerRecoveryBlocked === undefined
          && entry.outputPublicationCommitPending === undefined
          && entry.outputPublication === undefined;
        const normalizedLegacyHistory = normalizeLegacyTerminalHistory(
          entry.legacyHistory,
          outputRoot,
        );
        const legacyHistoryValid = entry.legacyHistory === undefined
          || Boolean(
            validId
            && migratedRequest
            && terminalLegacyStatus
            && !rawDgxClaim
            && normalizedLegacyHistory
            && canonicalJson(entry.legacyHistory) === canonicalJson(normalizedLegacyHistory)
            && normalizedLegacyHistory.jobId === rawId
            && normalizedLegacyHistory.originalStatus === entry.status
            && normalizedLegacyHistory.outputName === migratedRequest.outputName
            && normalizedLegacyHistory.finishedAt === (entry.finishedAt ?? null)
            && normalizedLegacyHistory.requestSha256
              === createHash("sha256").update(canonicalJson(entry.request)).digest("hex"),
          );
        const authorityClaim = activeOrUnclearStatus
          || rawDgxClaim
          || entry.legacyHistory !== undefined
          || entry.outputPublicationCommitPending !== undefined
          || entry.dgxSubmitPending === true
          || entry.dgxSubmitStartedAt !== undefined
          || entry.dgxPreparedAdmission !== undefined
          || entry.dgxPreparedAdmissionSha256 !== undefined
          || entry.dgxSuccessorAuthorization !== undefined
          || entry.dgxLeaseReceipt !== undefined
          || entry.dgxTerminalDelivery !== undefined
          || entry.dgxTerminalReceipt !== undefined
          || entry.localProcessSpawnPending !== undefined
          || entry.localProcessGroupPending === true
          || entry.localProcessGroupIdentity !== undefined
          || entry.ownedDockerContainer !== undefined
          || entry.ownedDockerContainerRecoveryBlocked === true
          || entry.outputPublication !== undefined
          || entry.startDeferred !== undefined
          || activeExecutionClaim;
        const normalizedTerminalDelivery = normalizeDgxTerminalDelivery(entry.dgxTerminalDelivery);
        const terminalDeliveryValid = entry.dgxTerminalDelivery === undefined
          || (validDgxJobId
            && normalizedTerminalDelivery !== undefined
            && canonicalJson(entry.dgxTerminalDelivery) === canonicalJson(normalizedTerminalDelivery));
        const normalizedTerminalReceipt = normalizeDgxTerminalReceipt(entry.dgxTerminalReceipt);
        const normalizedLeaseReceipt = normalizeDgxLeaseReceipt(entry.dgxLeaseReceipt);
        const leaseReceiptValid = entry.dgxLeaseReceipt === undefined
          || (validId
            && validDgxJobId
            && normalizedLeaseReceipt !== undefined
            && normalizedLeaseReceipt.studioJobId === rawId
            && normalizedLeaseReceipt.dgxJobId === entry.dgxJobId
            && normalizedLeaseReceipt.requestedBy === `ltx-studio:${rawId}`
            && normalizedLeaseReceipt.idempotencyKey === `ltx-studio:${rawId}`
            && canonicalJson(entry.dgxLeaseReceipt) === canonicalJson(normalizedLeaseReceipt)
            && entry.dgxSubmitPending !== true
            && entry.dgxSubmitStartedAt === undefined
            && entry.dgxPreparedAdmission === undefined
            && entry.dgxPreparedAdmissionSha256 === undefined
            && entry.dgxTerminalReceipt === undefined);
        const terminalReceiptValid = entry.dgxTerminalReceipt === undefined
          || (validId
            && validDgxJobId
            && normalizedTerminalReceipt !== undefined
            && normalizedTerminalReceipt.studioJobId === rawId
            && normalizedTerminalReceipt.dgxJobId === entry.dgxJobId
            && normalizedTerminalReceipt.idempotencyKey === `ltx-studio:${rawId}`
            && canonicalJson(entry.dgxTerminalReceipt) === canonicalJson(normalizedTerminalReceipt)
            && !isActiveJobStatus(entry.status as JobStatus)
            && entry.dgxSubmitPending !== true
            && entry.dgxSubmitStartedAt === undefined
            && entry.dgxPreparedAdmission === undefined
            && entry.dgxPreparedAdmissionSha256 === undefined
            && entry.dgxLeaseReceipt === undefined
            && entry.dgxTerminalDelivery === undefined
            && entry.localProcessSpawnPending !== true
            && entry.localProcessGroupPending !== true
            && entry.localProcessGroupIdentity === undefined
            && entry.ownedDockerContainer === undefined
            && entry.ownedDockerContainerRecoveryBlocked !== true);
        const processGroupValid = entry.localProcessGroupPending === true
          ? isLocalProcessGroupIdentity(entry.localProcessGroupIdentity)
          : entry.localProcessGroupIdentity === undefined;
        const spawnMarkerValid = entry.localProcessSpawnPending === undefined
          || (entry.localProcessSpawnPending === true
            && entry.localProcessGroupPending !== true
            && entry.localProcessGroupIdentity === undefined);
        const submitStartedAtValid = entry.dgxSubmitStartedAt === undefined
          || (entry.dgxSubmitPending === true
            && typeof entry.dgxSubmitStartedAt === "string"
            && Number.isFinite(Date.parse(entry.dgxSubmitStartedAt)));
        const normalizedPreparedAdmission = normalizePreparedAdmission(entry.dgxPreparedAdmission);
        const preparedAdmissionValid = entry.dgxSubmitPending === true
          ? Boolean(
              normalizedPreparedAdmission
              && entry.dgxPreparedAdmissionSha256 === preparedAdmissionSha256(normalizedPreparedAdmission)
              && normalizedPreparedAdmission.requested_by === `ltx-studio:${rawId}`
              && canonicalJson(entry.dgxPreparedAdmission) === canonicalJson(normalizedPreparedAdmission)
            )
          : entry.dgxPreparedAdmission === undefined
            && entry.dgxPreparedAdmissionSha256 === undefined;
        const normalizedSuccessorAuthorization = normalizeDgxSuccessorAuthorization(
          entry.dgxSuccessorAuthorization,
        );
        const successorAuthorizationValid = entry.dgxSuccessorAuthorization === undefined
          || Boolean(
            validId
            && validStatus
            && normalizedSuccessorAuthorization
            && canonicalJson(entry.dgxSuccessorAuthorization)
              === canonicalJson(normalizedSuccessorAuthorization)
            && normalizedSuccessorAuthorization.studioJobId === rawId
            && (normalizedSuccessorAuthorization.phase === "submit-pending"
              ? entry.status !== "completed"
                && entry.dgxSubmitPending === true
                && !rawDgxClaim
                && entry.dgxJobTerminal !== true
                && entry.dgxLeaseReceipt === undefined
                && entry.dgxTerminalDelivery === undefined
                && entry.dgxTerminalReceipt === undefined
                && entry.dgxSubmitStartedAt === normalizedSuccessorAuthorization.authorizedAt
                && normalizedPreparedAdmission !== undefined
                && normalizedSuccessorAuthorization.preparedAdmissionSha256
                  === entry.dgxPreparedAdmissionSha256
                && canonicalJson(normalizedPreparedAdmission)
                  === canonicalJson(
                    normalizedSuccessorAuthorization.predecessorLeaseReceipt.preparedAdmission,
                  )
              : rawDgxClaim
                && entry.dgxJobId === normalizedSuccessorAuthorization.successorDgxJobId
                && entry.dgxSubmitPending !== true
                && entry.dgxSubmitStartedAt === undefined
                && entry.dgxPreparedAdmission === undefined
                && entry.dgxPreparedAdmissionSha256 === undefined
                && (normalizedSuccessorAuthorization.successorAuthorityKind === "lease"
                  ? normalizeDgxLeaseReceipt(
                    normalizedSuccessorAuthorization.successorAuthorityReceipt,
                  ) !== undefined
                    && (normalizedLeaseReceipt !== undefined
                      ? entry.dgxJobTerminal !== true
                        && entry.dgxTerminalReceipt === undefined
                        && canonicalJson(normalizedLeaseReceipt)
                          === canonicalJson(
                            normalizedSuccessorAuthorization.successorAuthorityReceipt,
                          )
                      : normalizedTerminalReceipt !== undefined
                        && entry.dgxLeaseReceipt === undefined
                        && Date.parse(normalizedTerminalReceipt.confirmedAt)
                          >= Date.parse(
                            normalizedSuccessorAuthorization.successorAuthorityReceipt.confirmedAt,
                          ))
                  : normalizedTerminalReceipt !== undefined
                    && entry.dgxLeaseReceipt === undefined
                    && Date.parse(normalizedSuccessorAuthorization.consumedAt)
                      >= Date.parse(normalizedTerminalReceipt.confirmedAt)
                    && canonicalJson(normalizedTerminalReceipt)
                      === canonicalJson(
                        normalizedSuccessorAuthorization.successorAuthorityReceipt,
                      ))),
          );
        const dgxAuthorityCombinationValid = entry.dgxSubmitPending === true
          ? !rawDgxClaim
            && entry.dgxLeaseReceipt === undefined
            && entry.dgxTerminalDelivery === undefined
            && entry.dgxTerminalReceipt === undefined
          : rawDgxClaim
            ? legacyImportCandidate
              || ((entry.dgxTerminalReceipt !== undefined) !== (entry.dgxLeaseReceipt !== undefined)
                && (entry.dgxTerminalDelivery === undefined || entry.dgxLeaseReceipt !== undefined))
            : entry.dgxLeaseReceipt === undefined
              && entry.dgxTerminalDelivery === undefined
              && entry.dgxTerminalReceipt === undefined;
        const terminalLocalLeaseHasDelivery = !validStatus
          || isActiveJobStatus(entry.status as JobStatus)
          || entry.dgxLeaseReceipt === undefined
          || entry.dgxTerminalDelivery !== undefined;
        const ownedContainerValid = entry.ownedDockerContainer === undefined
          || (validId
            && validDgxJobId
            && normalizeOwnedDockerContainerAuthority(
              entry.ownedDockerContainer,
              rawId as string,
              entry.dgxJobId as string,
            ) !== null);
        const markerlessLegacyActiveExecution = entry.localProcessProtocol !== "fd-gate.v1"
          && (entry.status === "running" || entry.status === "paused")
          && entry.localProcessSpawnPending !== true
          && entry.localProcessGroupPending !== true
          && entry.ownedDockerContainer === undefined;
        const processProtocolValid = entry.localProcessProtocol === undefined
          || entry.localProcessProtocol === "fd-gate.v1";
        const spawnProtocolValid = entry.localProcessSpawnPending !== true
          || entry.localProcessProtocol === "fd-gate.v1";
        const completedWithUnsettledLocalAuthority = entry.status === "completed"
          && (entry.localProcessSpawnPending === true
            || entry.localProcessGroupPending === true
            || entry.ownedDockerContainer !== undefined
            || entry.ownedDockerContainerRecoveryBlocked === true);
        const startDeferredValid = entry.startDeferred === undefined
          || (entry.startDeferred === true
            && (["queued", "interrupted", "cancelled", "failed"] as const).includes(
              entry.status as "queued" | "interrupted" | "cancelled" | "failed",
            )
            && (entry.startedAt === null || entry.startedAt === undefined)
            && !rawDgxClaim
            && entry.dgxSubmitPending !== true
            && entry.localProcessSpawnPending !== true
            && entry.localProcessGroupPending !== true
            && entry.ownedDockerContainer === undefined);
        const hasExecutionClass = Object.hasOwn(entry, "executionClass");
        const hasExecutionDecision = Object.hasOwn(entry, "executionDecision");
        const normalizedExecutionDecision = hasExecutionDecision
          ? normalizeJobExecutionDecision(entry.executionDecision)
          : null;
        const executionMarkerStructurallyValid = hasExecutionDecision
          ? Boolean(
              normalizedExecutionDecision
              && hasExecutionClass
              && entry.executionClass === normalizedExecutionDecision.executionClass,
            )
          : !hasExecutionClass || isJobExecutionClass(entry.executionClass);
        const invalidExecutionMarkerOwnsUnsettledAuthority = !executionMarkerStructurallyValid
          && (
            entry.status === "running"
            || entry.status === "paused"
            || rawDgxClaim
            || entry.dgxSubmitPending === true
            || entry.dgxSuccessorAuthorization !== undefined
            || entry.dgxTerminalDelivery !== undefined
            || entry.dgxTerminalReceipt !== undefined
            || entry.localProcessSpawnPending === true
            || entry.localProcessGroupPending === true
            || entry.localProcessGroupIdentity !== undefined
            || entry.ownedDockerContainer !== undefined
            || entry.ownedDockerContainerRecoveryBlocked === true
            || entry.outputPublicationCommitPending !== undefined
            || entry.outputPublication !== undefined
          );
        const normalizedOutputPublication = migratedRequest
          ? normalizeOutputPublicationAuthority(
              entry.outputPublication,
              join(outputRoot, migratedRequest.outputName),
            )
          : null;
        const outputPublicationValid = entry.outputPublication === undefined
          || Boolean(
            normalizedOutputPublication
            && canonicalJson(entry.outputPublication) === canonicalJson(normalizedOutputPublication),
          );
        const normalizedPublicationCommit = normalizeOutputPublicationCommitPending(
          entry.outputPublicationCommitPending,
        );
        const publicationCommitValid = entry.outputPublicationCommitPending === undefined
          || Boolean(
            validId
            && migratedRequest
            && validStatus
            && isActiveJobStatus(entry.status as JobStatus)
            && normalizedPublicationCommit
            && canonicalJson(entry.outputPublicationCommitPending)
              === canonicalJson(normalizedPublicationCommit)
            && normalizedOutputPublication
            && normalizedOutputPublication.jobId === rawId
            && normalizedOutputPublication.outputName === migratedRequest.outputName
            && normalizedOutputPublication.publishedAt === normalizedPublicationCommit.completedAt
            && entry.finishedAt === normalizedPublicationCommit.completedAt
            && normalizedExecutionDecision
            && normalizedExecutionDecision.executionClass !== "pending"
            && entry.executionClass === normalizedExecutionDecision.executionClass
            && entry.dgxTerminalDelivery === undefined
            && entry.dgxTerminalReceipt === undefined
            && entry.dgxSubmitPending !== true
            && entry.localProcessSpawnPending !== true
            && entry.localProcessGroupPending !== true
            && entry.localProcessGroupIdentity === undefined
            && entry.ownedDockerContainer === undefined
            && entry.ownedDockerContainerRecoveryBlocked !== true
            && entry.startDeferred !== true,
          );
        if (authorityClaim && (
          !validId
          || !migratedRequest
          || !validStatus
          || (rawDgxClaim && !validDgxJobId)
          || !terminalDeliveryValid
          || !leaseReceiptValid
          || !terminalReceiptValid
          || !spawnMarkerValid
          || !processGroupValid
          || !submitStartedAtValid
          || !preparedAdmissionValid
          || !successorAuthorizationValid
          || !dgxAuthorityCombinationValid
          || !terminalLocalLeaseHasDelivery
          || !ownedContainerValid
          || markerlessLegacyActiveExecution
          || !processProtocolValid
          || !spawnProtocolValid
          || completedWithUnsettledLocalAuthority
          || !startDeferredValid
          || invalidExecutionMarkerOwnsUnsettledAuthority
          || !outputPublicationValid
          || !legacyHistoryValid
          || !publicationCommitValid
        )) {
          throw new Error(
            `Persistierter Authority-Job ${typeof rawId === "string" ? rawId : "<ohne UUID>"} ist strukturell widersprüchlich.`,
          );
        }
        // Authority-free legacy debris is intentionally discarded. It cannot
        // own compute, a remote lease, or a public artifact.
        if (!validId || !migratedRequest) continue;
        if (legacyImportCandidate) legacyImportIds.add(rawId);
        stored.push(entry as unknown as PersistedStudioJob);
      }
      const retained = [
        ...stored.slice(0, MAX_JOBS),
        ...stored.slice(MAX_JOBS).filter((entry) => {
          // Every imported v1 terminal record is a durable negative-authority
          // tombstone, including failures without playable bytes. Dropping one
          // would let an old experiment/project reference look like an unknown
          // modern job and regain retry/continuity authority after MAX_JOBS.
          const hasLegacyHistory = entry.legacyHistory !== undefined
            || legacyImportIds.has(entry.id);
          // Controlled-experiment retries also require the exact previous
          // terminal attempt. Keep that bounded subset so a missing job never
          // becomes an implicit retry grant.
          const hasExperimentBinding = entry.experiment !== undefined && entry.experiment !== null;
          const hasPendingTerminal = normalizeDgxTerminalDelivery(entry.dgxTerminalDelivery) !== undefined;
          const hasTerminalReceipt = normalizeDgxTerminalReceipt(entry.dgxTerminalReceipt) !== undefined;
          const hasPendingSubmit = entry.dgxSubmitPending === true;
          const hasLeaseReceipt = normalizeDgxLeaseReceipt(entry.dgxLeaseReceipt) !== undefined;
          const hasSuccessorAuthorization = normalizeDgxSuccessorAuthorization(
            entry.dgxSuccessorAuthorization,
          ) !== undefined;
          const hasPendingLocalProcess = entry.localProcessSpawnPending === true
            || entry.localProcessGroupPending === true;
          const hasPendingOwnedContainer = entry.ownedDockerContainer !== undefined
            || entry.ownedDockerContainerRecoveryBlocked === true;
          const hasPendingPublicationCommit = normalizeOutputPublicationCommitPending(
            entry.outputPublicationCommitPending,
          ) !== undefined;
          const hasActiveRemoteLease = isActiveJobStatus(entry.status)
            && isDgxJobId(entry.dgxJobId);
          const hasCancelledRemoteLeaseWithoutDelivery = entry.status === "cancelled"
            && isDgxJobId(entry.dgxJobId)
            && !hasPendingTerminal
            && !hasTerminalReceipt;
          return hasLegacyHistory
            || hasExperimentBinding
            || hasPendingTerminal
            || hasPendingSubmit
            || hasLeaseReceipt
            || hasSuccessorAuthorization
            || hasPendingLocalProcess
            || hasPendingOwnedContainer
            || hasPendingPublicationCommit
            || hasActiveRemoteLease
            || hasCancelledRemoteLeaseWithoutDelivery;
        }),
      ];
      let restorationRequiresPersist = false;
      for (const entry of retained) {
        const authorityBoundRequest = structuredClone(entry.request);
        const authorityRequestSha256 = createHash("sha256")
          .update(canonicalJson(authorityBoundRequest))
          .digest("hex");
        let migratedRequest = migrateGenerationRequest(structuredClone(authorityBoundRequest));
        if (!migratedRequest || typeof entry.id !== "string" || !STUDIO_JOB_ID_PATTERN.test(entry.id)) continue;
        const rawRequestRecord = authorityBoundRequest && typeof authorityBoundRequest === "object"
          && !Array.isArray(authorityBoundRequest)
          ? authorityBoundRequest as Record<string, unknown>
          : null;
        const rawTextToAudio = rawRequestRecord?.textToAudio;
        const legacyTextToAudioPeakCeilingUnset = migratedRequest.mode === "text-to-audio"
          && (!rawTextToAudio
            || typeof rawTextToAudio !== "object"
            || Array.isArray(rawTextToAudio)
            || !Object.hasOwn(rawTextToAudio, "peakCeilingDbfs"));
        const storedStatus: JobStatus = ["queued", "running", "paused", "completed", "failed", "cancelled", "interrupted"]
          .includes(entry.status) ? entry.status : "interrupted";
        const storedPublicationCommit = normalizeOutputPublicationCommitPending(
          entry.outputPublicationCommitPending,
        );
        if (storedPublicationCommit) restorationRequiresPersist = true;
        const storedLegacyHistory = normalizeLegacyTerminalHistory(entry.legacyHistory, outputRoot);
        const importLegacyTerminal = !storedLegacyHistory
          && (["completed", "failed", "cancelled", "interrupted"] as const)
            .includes(storedStatus as LegacyTerminalStatus)
          && !Object.hasOwn(entry, "executionClass")
          && !Object.hasOwn(entry, "executionDecision")
          && entry.localProcessProtocol === undefined
          && entry.startSource === undefined
          && entry.startDeferred === undefined
          && entry.dgxSubmitPending !== true
          && entry.dgxSubmitStartedAt === undefined
          && entry.dgxPreparedAdmission === undefined
          && entry.dgxPreparedAdmissionSha256 === undefined
          && entry.dgxSuccessorAuthorization === undefined
          && entry.dgxLeaseReceipt === undefined
          && entry.dgxTerminalDelivery === undefined
          && entry.dgxTerminalReceipt === undefined
          && entry.localProcessSpawnPending === undefined
          && entry.localProcessGroupPending === undefined
          && entry.localProcessGroupIdentity === undefined
          && entry.ownedDockerContainer === undefined
          && entry.ownedDockerContainerRecoveryBlocked === undefined
          && entry.outputPublicationCommitPending === undefined
          && entry.outputPublication === undefined;
        const legacyHistory = storedLegacyHistory ?? (importLegacyTerminal
          ? captureLegacyTerminalHistory(outputRoot, {
              jobId: entry.id,
              status: storedStatus as LegacyTerminalStatus,
              outputName: migratedRequest.outputName,
              finishedAt: validTimestamp(entry.finishedAt, null),
              dgxJobId: isDgxJobId(entry.dgxJobId) ? entry.dgxJobId : null,
              rawRequest: authorityBoundRequest,
              migratedRequest,
              runProvenance: entry.runProvenance,
              identityEvidence: entry.identityEvidence,
              experiment: entry.experiment,
              importedAt: now(),
            })
          : null);
        if (importLegacyTerminal) restorationRequiresPersist = true;
        // A pre-v1.1 DGX id is retained solely inside the explicitly
        // non-authoritative history receipt. It must never become a lease.
        const dgxJobId = legacyHistory
          ? null
          : isDgxJobId(entry.dgxJobId) ? entry.dgxJobId : null;
        const restoredOwnedDockerContainer = normalizeOwnedDockerContainerAuthority(
          entry.ownedDockerContainer,
          entry.id,
          dgxJobId,
        );
        const ownedDockerContainerRecoveryBlocked = entry.ownedDockerContainerRecoveryBlocked === true
          || (entry.ownedDockerContainer !== undefined && !restoredOwnedDockerContainer);
        if (entry.ownedDockerContainer !== undefined
          && (!restoredOwnedDockerContainer
            || canonicalJson(entry.ownedDockerContainer) !== canonicalJson(restoredOwnedDockerContainer))) {
          restorationRequiresPersist = true;
        }
        const locallyQueuedWithoutDgx = storedStatus === "queued" && dgxJobId === null;
        const deferredStartFence = entry.startDeferred === true;
        const experimentBindingResult = experimentRunBindingSchema.safeParse(entry.experiment);
        const projectBindingResult = projectRunBindingSchema.safeParse(entry.project);
        const experimentBinding = experimentBindingResult.success ? experimentBindingResult.data : null;
        const projectBinding = projectBindingResult.success ? projectBindingResult.data : null;
        const experimentBindingPresent = entry.experiment !== undefined && entry.experiment !== null;
        const experimentSourceClaimed = entry.startSource === "experiment";
        const projectBindingInvalid = entry.project !== undefined
          && entry.project !== null
          && !projectBindingResult.success;
        const executableRequestCandidate = locallyQueuedWithoutDgx
          && !experimentBinding
          && !projectBinding
          && !projectBindingInvalid
          ? withOfficialSpeechModelPaths(migratedRequest)
          : migratedRequest;
        const executableRequestDiffers = canonicalJson(executableRequestCandidate)
          !== canonicalJson(authorityBoundRequest);
        const activeRequestMigrationConflict = isActiveJobStatus(storedStatus)
          && executableRequestDiffers;
        if (!executableRequestDiffers) migratedRequest = executableRequestCandidate;
        const projectBindingMismatch = Boolean(
          projectBinding
          && authorityRequestSha256 !== projectBinding.requestSha256,
        );
        const authorityConflict = Boolean(experimentBinding && projectBinding);
        const brokenProjectAuthority = projectBindingInvalid || projectBindingMismatch || authorityConflict;
        const rawOutputCandidate = migratedRequest.postprocess.lipForcing.rawOutputProfile
          === experimentalLipForcingRawOutputProfile;
        const requestBoundExperimentBinding = validRequestBoundExperimentBinding(
          migratedRequest,
          experimentBinding,
        );
        const brokenExperimentAuthority = isActiveJobStatus(storedStatus)
          && (experimentBindingPresent || experimentSourceClaimed)
          && requestBoundExperimentBinding === null;
        const brokenRawOutputExperimentAuthority = rawOutputCandidate && (
          validRawOutputExperimentBinding(migratedRequest, experimentBinding) === null
          || projectBinding !== null
        );
        const executionAuthority = restoreExecutionAuthority(
          entry,
          authorityBoundRequest,
          migratedRequest,
          experimentBinding,
          dgxJobId,
          storedPublicationCommit ? "completed" : storedStatus,
        );
        const brokenExecutionAuthority = executionAuthority.error !== null;
        const incompatibleLegacyT2AExecution = legacyTextToAudioPeakCeilingUnset
          && isActiveJobStatus(storedStatus);
        const restoredSpawnPending = entry.localProcessSpawnPending === true;
        if (activeRequestMigrationConflict
          || brokenExperimentAuthority
          || brokenRawOutputExperimentAuthority
          || (deferredStartFence && isActiveJobStatus(storedStatus))
          || restoredSpawnPending
          || entry.localProcessProtocol !== "fd-gate.v1") {
          restorationRequiresPersist = true;
        }
        const recoverableLocalQueue = locallyQueuedWithoutDgx
          && !deferredStartFence
          && !restoredSpawnPending
          && !brokenExecutionAuthority
          && !activeRequestMigrationConflict
          && !brokenExperimentAuthority
          && !brokenRawOutputExperimentAuthority
          && !executionAuthority.cpuResumeAmbiguous;
        let status: JobStatus = recoverableLocalQueue
          ? "queued"
          : isActiveJobStatus(storedStatus) ? "interrupted" : storedStatus;
        if (brokenExecutionAuthority) status = "failed";
        if (activeRequestMigrationConflict) status = "failed";
        if (brokenExperimentAuthority) status = "failed";
        if (brokenRawOutputExperimentAuthority) status = "failed";
        if (brokenProjectAuthority && !activeRequestMigrationConflict) status = "interrupted";
        const plan = buildCommand(migratedRequest);
        let outputFileExists = false;
        try {
          const outputStats = lstatSync(plan.outputPath);
          outputFileExists = !outputStats.isSymbolicLink() && outputStats.isFile() && outputStats.size > 0;
        } catch {
          outputFileExists = false;
        }
        const publication = outputFileExists
          ? readValidOutputPublicationAuthority(outputRoot, migratedRequest.outputName)
          : null;
        const expectedDecisionSha256 = executionAuthority.executionDecision
          ? createHash("sha256").update(canonicalJson(executionAuthority.executionDecision)).digest("hex")
          : null;
        const storedOutputPublication = normalizeOutputPublicationAuthority(
          entry.outputPublication,
          plan.outputPath,
        );
        const expectedJobAuthoritySha256 = executionAuthority.executionDecision
          && executionAuthority.executionDecision.executionClass !== "pending"
          && storedOutputPublication
          && typeof entry.finishedAt === "string"
          ? terminalJobAuthoritySha256({
              jobId: entry.id,
              status: "completed",
              outputName: migratedRequest.outputName,
              finishedAt: entry.finishedAt,
              executionClass: executionAuthority.executionDecision.executionClass,
              executionDecisionSha256: expectedDecisionSha256!,
              requestSha256: executionAuthority.executionDecision.requestSha256,
              protocolSha256: executionAuthority.executionDecision.protocolSha256,
              jobPersistenceRevision: storedOutputPublication.jobPersistenceRevision,
            })
          : null;
        const publicationAuthorityMatches = Boolean(
          publication
          && storedOutputPublication
          && canonicalJson(publication) === canonicalJson(storedOutputPublication)
          && publication.jobId === entry.id
          && publication.publishedAt === entry.finishedAt
          && expectedDecisionSha256
          && publication.executionDecisionSha256 === expectedDecisionSha256
          && expectedJobAuthoritySha256
          && publication.jobAuthoritySha256 === expectedJobAuthoritySha256,
        );
        const publicationMatchesPreparedCommit = Boolean(
          storedPublicationCommit
          && isActiveJobStatus(storedStatus)
          && !brokenExecutionAuthority
          && !activeRequestMigrationConflict
          && !brokenExperimentAuthority
          && !brokenRawOutputExperimentAuthority
          && !brokenProjectAuthority
          && publicationAuthorityMatches
          && publication
          && publication.publishedAt === storedPublicationCommit.completedAt,
        );
        const publicationMatchesJob = Boolean(
          (storedStatus === "completed" || publicationMatchesPreparedCommit)
          && publicationAuthorityMatches,
        );
        if (publicationMatchesPreparedCommit) status = "completed";
        const legacyOutputReady = Boolean(
          legacyHistory?.artifact
          && legacyHistory.originalStatus === "completed"
          && legacyHistory.jobId === entry.id
          && legacyHistory.outputName === migratedRequest.outputName
          && legacyHistory.requestSha256 === authorityRequestSha256
          // migratedRequestSha256 is preserved as an import-time audit fact.
          // The exact raw request digest above remains stable across future
          // migration defaults and is the only durable request binding here.
          && legacyArtifactStatsStillMatch(legacyHistory),
        );
        let outputReady = publicationMatchesJob || legacyOutputReady;
        let restoredOutputQuarantined = false;
        let restoredOutputPreservedInPlace = false;
        const shouldQuarantineRaw = outputFileExists && !publicationMatchesJob && !legacyHistory;
        if (!outputFileExists) {
          try {
            removeOutputPublicationAuthority(plan.outputPath);
          } catch {
            // With no raw pathname the marker cannot authorize bytes; the
            // restored job is still downgraded below and persisted fail-closed.
          }
          if (entry.outputPublication !== undefined) restorationRequiresPersist = true;
        }
        if (shouldQuarantineRaw) {
          try {
            restoredOutputQuarantined = quarantineRestoredUnpublishedArtifact(
              plan.outputPath,
              join(hybridRoot, entry.id),
              this.outputAuthorityReconciliationOperations,
            ) !== null;
          } catch {
            // Recovery is not deletion authority. The raw pathname remains
            // unserved and reserves its output name until an operator or a
            // later restart can move it into the private quarantine safely.
            restoredOutputPreservedInPlace = existsSync(plan.outputPath);
          }
          outputReady = false;
          restorationRequiresPersist = true;
        }
        if (restoredOutputPreservedInPlace && isActiveJobStatus(status)) {
          // In particular, a locally queued job must never overwrite or reuse
          // ambiguous bytes that recovery could not move out of the way.
          status = "interrupted";
        }
        if (storedStatus === "completed" && !outputReady && !legacyHistory) {
          status = "failed";
        }
        const interrupted = status === "interrupted";
        const missingOutput = storedStatus === "completed" && !outputReady;
        const terminalizedDuringRestore = isActiveJobStatus(storedStatus)
          && !isActiveJobStatus(status);
        const storedProgress = typeof entry.progress === "number" && Number.isFinite(entry.progress)
          ? Math.min(100, Math.max(0, entry.progress))
          : null;
        const restoredTerminalDelivery = dgxJobId
          ? normalizeDgxTerminalDelivery(entry.dgxTerminalDelivery)
          : undefined;
        const restoredTerminalReceipt = dgxJobId
          ? normalizeDgxTerminalReceipt(entry.dgxTerminalReceipt)
          : undefined;
        const restoredLeaseReceipt = dgxJobId
          ? normalizeDgxLeaseReceipt(entry.dgxLeaseReceipt)
          : undefined;
        const recoveredPublicationDelivery = publicationMatchesPreparedCommit
          && dgxJobId
          && restoredLeaseReceipt
          && !restoredTerminalDelivery
          && !restoredTerminalReceipt
          && storedPublicationCommit
          ? {
              state: "completed" as const,
              metadata: storedPublicationCommit.completionMetadata,
              attempts: 0,
              lastError: null,
              updatedAt: now(),
            }
          : undefined;
        const restoredProcessGroupIdentity = entry.localProcessGroupPending === true
          && isLocalProcessGroupIdentity(entry.localProcessGroupIdentity)
          ? entry.localProcessGroupIdentity
          : undefined;
        const interruptedRemoteDelivery = (
          interrupted
          || brokenExecutionAuthority
          || activeRequestMigrationConflict
          || brokenExperimentAuthority
          || brokenRawOutputExperimentAuthority
        )
          && isActiveJobStatus(storedStatus)
          && dgxJobId
          && restoredLeaseReceipt
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
        const cancelledRemoteDelivery = storedStatus === "cancelled"
          && dgxJobId
          && restoredLeaseReceipt
          && !restoredTerminalDelivery
          && !restoredTerminalReceipt
          ? {
              state: "cancelled" as const,
              metadata: {
                current_step: "restart reconciliation for cancelled Studio job with remote lease",
                last_error: "Terminal delivery authority was absent; GET/idempotent cancel is required before release",
              },
              attempts: 0,
              lastError: null,
              updatedAt: now(),
            }
          : undefined;
        const restoredLogs = Array.isArray(entry.logs)
          ? entry.logs.filter((line): line is string => typeof line === "string").slice(-MAX_LOG_LINES).map(cleanLogLine)
          : [];
        if (publicationMatchesPreparedCommit) {
          restoredLogs.push(
            "Studio-Neustart: dauerhaft vorbereiteter Publikationscommit samt Marker verifiziert; lokale Completion und erst jetzt Remote-completed wiederhergestellt.",
          );
        } else if (storedPublicationCommit) {
          restoredLogs.push(
            "Studio-Neustart: vorbereiteter Publikationscommit besitzt keinen exakt passenden Marker; Ausgabe bleibt unveröffentlicht und Remote-completed ist gesperrt.",
          );
        }
        if (interruptedRemoteDelivery) {
          restoredLogs.push("Studio-Neustart: Remote-Queue-Lease wird als cancelled abgemeldet.");
        } else if (cancelledRemoteDelivery) {
          restoredLogs.push(
            "Studio-Neustart: cancelled Job mit Remote-Lease ohne Zustellmarker wird defensiv per GET/idempotentem Cancel abgeglichen.",
          );
          restorationRequiresPersist = true;
        } else if (recoverableLocalQueue && status === "queued") {
          restoredLogs.push(
            normalizeDgxSuccessorAuthorization(entry.dgxSuccessorAuthorization)?.phase
              === "submit-pending"
              ? "Studio-Neustart: autorisierte DGX-Successor-Generation 1 wird ausschließlich am Conditional-Endpunkt mit demselben dauerhaften Token fortgesetzt."
              : entry.dgxSubmitPending === true
                ? "Studio-Neustart: unklarer Einmal-Submit wird ausschließlich über positive Queue-Evidenz abgeglichen."
              : "Studio-Neustart: rein lokal wartender Job wird automatisch fortgesetzt.",
          );
        }
        if (deferredStartFence) {
          restoredLogs.push(
            "Studio-Neustart: vorbereiteter Job war noch nicht dauerhaft zum Start freigegeben und bleibt unterbrochen.",
          );
        }
        if (restoredSpawnPending) {
          restoredLogs.push(
            "Studio-Neustart: ein Prozess blieb vor der dauerhaften PG-Bindung am Parent-FD-Gate; "
              + "ohne den verlorenen Parent-Token kann der Zielprozess nicht execen und wird niemals automatisch wiederholt.",
          );
        }
        if (brokenProjectAuthority) {
          restoredLogs.push(
            "Studio-Neustart: ungültige oder widersprüchliche Projektbindung; Job bleibt fail-closed unterbrochen.",
          );
        }
        if (brokenExecutionAuthority) {
          restoredLogs.push(
            `Studio-Neustart: ungültige oder widersprüchliche ExecutionDecision.v5/v6; ältere Autorität bleibt terminal fail-closed. ${executionAuthority.error}`,
          );
        } else if (executionAuthority.cpuResumeAmbiguous) {
          restoredLogs.push(
            "Studio-Neustart: eine persistierte CPU-Ausführung wird wegen unklarem Spawn-/Prozesszustand niemals automatisch wiederholt.",
          );
        }
        if (incompatibleLegacyT2AExecution) {
          restoredLogs.push(
            "Studio-Neustart: historischer T2A-Request ohne Peak-Grenze wird nicht still mit -3 dBFS ausgeführt.",
          );
        }
        if (activeRequestMigrationConflict && !incompatibleLegacyT2AExecution) {
          restoredLogs.push(
            "Studio-Neustart: aktive Request-Migration wich von der gebundenen Ausführungsrepräsentation ab; "
            + "der Job bleibt vor jedem Start terminal fail-closed.",
          );
        }
        if (brokenExperimentAuthority && !brokenRawOutputExperimentAuthority) {
          restoredLogs.push(
            "Studio-Neustart: behauptete Experimentquelle besitzt keine exakt requestgebundene "
              + "Experimentautorität; der Job bleibt terminal fail-closed.",
          );
        }
        if (brokenRawOutputExperimentAuthority) {
          restoredLogs.push(
            "Studio-Neustart: experimentelles LipForcing-Rohvideo-Profil ohne exakt passende "
              + "Kandidatenarm-Bindung; der Job bleibt terminal fail-closed.",
          );
        }
        if (restoredOutputPreservedInPlace) {
          restoredLogs.push(
            "Studio-Neustart: Ausgabe ohne gültige Publikationsautorität konnte nicht privat "
              + "quarantänisiert werden; Rohdaten bleiben unverändert am reservierten Pfad, "
              + "sind 404/fail-closed und der Job wird nicht automatisch wieder gestartet.",
          );
        } else if (restoredOutputQuarantined) {
          restoredLogs.push(
            "Studio-Neustart: Ausgabe ohne gültige dauerhafte Publikationsautorität wurde in den privaten Quarantänebereich verschoben.",
          );
        } else if (storedStatus === "completed" && !outputReady) {
          restoredLogs.push(
            legacyHistory
              ? "Legacy-Import: historische Ausgabe blieb unverändert am Ursprungsort, ist wegen fehlender oder abweichender Alt-Evidenz aber nicht lesbar."
              : "Studio-Neustart: abgeschlossene Ausgabe besitzt keinen passenden dauerhaften Publikationsmarker und bleibt 404/fail-closed.",
          );
        }
        if (importLegacyTerminal) {
          restoredLogs.push(
            legacyOutputReady
              ? "Legacy-Import v1.1: historisches Medium unverändert und nur lesbar erhalten; keine ExecutionDecision-, DGX-Lease-, Experiment-, Analyse- oder Qualitäts-GO-Autorität."
              : "Legacy-Import v1.1: terminale Historie ohne moderne Autorität übernommen; keine automatische Wiederholung oder DGX-Mutation.",
          );
        }
        if (entry.localProcessGroupPending === true) {
          restoredLogs.push(
            restoredProcessGroupIdentity
              ? "Studio-Neustart: frühere Prozessgruppe wird bootgebunden über /proc geprüft; bis zum Abwesenheitsbeweis bleibt die Remote-Lease gesperrt."
              : "Studio-Neustart: Remote-Lease bleibt gesperrt, weil für die frühere lokale Prozessgruppe keine sichere Identität vorliegt.",
          );
        }
        if (restoredOwnedDockerContainer) {
          restoredLogs.push(
            `Studio-Neustart: eigener Docker-Container ${restoredOwnedDockerContainer.name} wird nur nach exakter Labelprüfung bereinigt; bis zum Abwesenheitsbeweis bleibt die Remote-Lease gesperrt.`,
          );
        } else if (ownedDockerContainerRecoveryBlocked) {
          restoredLogs.push(
            "Studio-Neustart: persistierte Docker-Containerautorität ist ungültig; keine Containeraktion und keine lokale/DGX-Freigabe ohne Operatorprüfung.",
          );
        }
        const normalizedStoredRunProvenance = normalizeRunProvenance(entry.runProvenance);
        const restoredRunProvenance = executionAuthority.operationInterruptedOnRestore
          && executionAuthority.executionDecision
          && normalizedStoredRunProvenance
          ? bindRunExecutionDecision(normalizedStoredRunProvenance, executionAuthority.executionDecision)
          : normalizedStoredRunProvenance;
        if (executionAuthority.operationInterruptedOnRestore) {
          restorationRequiresPersist = true;
          restoredLogs.push(
            "Studio-Neustart: vorbereitete/laufende CPU-Operation wurde dauerhaft interrupted; sie wird niemals automatisch wiederholt.",
          );
        }
        this.jobs.set(entry.id, {
          ...entry,
          id: entry.id,
          mode: migratedRequest.mode,
          prompt: migratedRequest.prompt,
          outputName: migratedRequest.outputName,
          outputUrl: status === "completed" && outputReady ? `/api/jobs/${entry.id}/output` : null,
          createdAt: validTimestamp(entry.createdAt, now())!,
          startedAt: validTimestamp(entry.startedAt, null),
          request: migratedRequest,
          status,
          // Preserve terminal audit history exactly across repeated restarts.
          // A fresh timestamp is created only for an active persisted job that
          // this restore pass itself terminalizes fail-closed.
          finishedAt: publicationMatchesPreparedCommit && storedPublicationCommit
            ? storedPublicationCommit.completedAt
            : terminalizedDuringRestore
              ? now()
              : validTimestamp(entry.finishedAt, null),
          progress: status === "completed"
            ? 100
            : storedProgress === null ? null : Math.min(MAX_RUNNING_PROCESS_PROGRESS, storedProgress),
          error: brokenRawOutputExperimentAuthority
            ? "Experimentelles LipForcing-Rohvideo-Profil besitzt keine exakt requestgebundene Kandidatenarm-Autorität."
            : brokenExperimentAuthority
              ? "Persistierte Experimentquelle besitzt keine exakt requestgebundene Experimentautorität."
            : brokenProjectAuthority
            ? "Persistierte Projektbindung ist ungültig oder stimmt nicht mit dem Request überein."
            : brokenExecutionAuthority
              ? executionAuthority.error
            : activeRequestMigrationConflict
              ? incompatibleLegacyT2AExecution
                ? "Historischer T2A-Request ohne gebundene Peak-Grenze darf nicht still verändert ausgeführt werden."
                : "Aktive Request-Migration weicht von der gebundenen Ausführungsrepräsentation ab."
            : interrupted
              ? deferredStartFence
                ? "Studio wurde vor der dauerhaften Startfreigabe des vorbereiteten Jobs neu gestartet."
                : "Studio wurde während des Jobs neu gestartet."
            : missingOutput && !legacyHistory
              ? restoredOutputPreservedInPlace
                ? "Die gespeicherte Ausgabe besitzt keine gültige Publikationsautorität; "
                  + "ihre Rohdaten bleiben unverändert am reservierten, nicht lesbaren Pfad."
                : "Die gespeicherte Ausgabedatei ist nicht mehr vorhanden."
              : legacyHistory && storedStatus === "completed" && !legacyOutputReady
                ? "Historische Ausgabe ist mangels unveränderter Alt-Evidenz nur als Jobverlauf erhalten."
              : typeof entry.error === "string" ? entry.error : null,
          logs: restoredLogs.slice(-MAX_LOG_LINES),
          command: plan.displayCommand,
          favorite: entry.favorite === true,
          variantOf: typeof entry.variantOf === "string" && /^[0-9a-f-]{36}$/i.test(entry.variantOf)
            ? entry.variantOf
            : null,
          experiment: experimentBinding,
          project: projectBinding,
          outputPublication: publicationMatchesJob && storedOutputPublication
            ? storedOutputPublication
            : undefined,
          outputPublicationCommitPending: undefined,
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
                  : historicalThermalResumeBelowC(
                    entry.thermalProfile.baselineC,
                    typeof entry.thermalProfile.pauseAtC === "number"
                      && Number.isFinite(entry.thermalProfile.pauseAtC)
                      ? entry.thermalProfile.pauseAtC
                      : thermalPauseC,
                  ),
                updatedAt: validTimestamp(entry.thermalProfile.updatedAt, now())!,
              }
            : thermalProfileFromLogs(entry.logs),
          dgxJobId,
          dgxMemoryWait: isActiveJobStatus(status) && dgxJobId
            ? normalizePublicDgxMemoryWait(entry.dgxMemoryWait)
            : null,
          dgxJobTerminal: Boolean(restoredTerminalReceipt),
          dgxTerminalDelivery: dgxJobId
            ? restoredTerminalDelivery
              ?? recoveredPublicationDelivery
              ?? interruptedRemoteDelivery
              ?? cancelledRemoteDelivery
            : undefined,
          dgxTerminalReceipt: restoredTerminalReceipt,
          dgxLeaseReceipt: restoredLeaseReceipt,
          localProcessSpawnPending: undefined,
          localProcessGroupPending: entry.localProcessGroupPending === true || undefined,
          localProcessGroupIdentity: restoredProcessGroupIdentity,
          ownedDockerContainer: restoredOwnedDockerContainer ?? undefined,
          ownedDockerContainerIdDurablyCommitted:
            restoredOwnedDockerContainer?.containerId ? true : undefined,
          ownedDockerContainerRecoveryBlocked: ownedDockerContainerRecoveryBlocked || undefined,
          dgxSubmitPending: entry.dgxSubmitPending === true || undefined,
          dgxSubmitStartedAt: entry.dgxSubmitPending === true
            ? validTimestamp(entry.dgxSubmitStartedAt, now()) ?? undefined
            : undefined,
          dgxPreparedAdmission: entry.dgxSubmitPending === true
            ? normalizePreparedAdmission(entry.dgxPreparedAdmission)
            : undefined,
          dgxPreparedAdmissionSha256: entry.dgxSubmitPending === true
            && typeof entry.dgxPreparedAdmissionSha256 === "string"
            ? entry.dgxPreparedAdmissionSha256
            : undefined,
          dgxSuccessorAuthorization: normalizeDgxSuccessorAuthorization(
            entry.dgxSuccessorAuthorization,
          ),
          identityEvidence: normalizeIdentityInputEvidence(entry.identityEvidence),
          runProvenance: restoredRunProvenance,
          executionClass: executionAuthority.executionClass,
          executionDecision: executionAuthority.executionDecision,
          localProcessProtocol: "fd-gate.v1",
          startSource: projectBinding
            ? "project"
            : requestBoundExperimentBinding
              ? "experiment"
              : entry.startSource !== "experiment"
                && jobStartSources.includes(entry.startSource as JobStartSource)
                ? entry.startSource as JobStartSource
                : typeof entry.variantOf === "string" && /^[0-9a-f-]{36}$/i.test(entry.variantOf)
                  ? "rerun"
                  : "restored",
          // Preserve the private fence as durable evidence that this terminal
          // job never crossed the start-arm commit point. This keeps repeated
          // restarts stable without ever exposing or re-queueing it.
          startDeferred: deferredStartFence,
          plan,
          authorityBoundRequest,
          authorityRequestSha256,
          legacyTextToAudioPeakCeilingUnset,
          legacyHistory: legacyHistory ?? undefined,
        });
        if (status === "queued") this.queue.push(entry.id);
      }
      for (const job of this.jobs.values()) {
        if (job.request.postprocess.lipForcing.rawOutputProfile
          !== experimentalLipForcingRawOutputProfile
          || !(isActiveJobStatus(job.status) || job.status === "interrupted")) continue;
        const baselineAuthority = this.rawOutputBaselineImageAuthority(job);
        if (!baselineAuthority.error) continue;
        job.status = "failed";
        job.finishedAt = now();
        job.outputUrl = null;
        job.error = `Studio-Neustart: ${baselineAuthority.error}`;
        this.appendLog(job, `${job.error} Der Kandidat wird nicht erneut eingereiht.`);
        const queuedIndex = this.queue.indexOf(job.id);
        if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
        if (job.dgxJobId && !job.dgxTerminalDelivery) {
          job.dgxTerminalDelivery = {
            state: "cancelled",
            metadata: {
              current_step: "raw-output baseline container authority failed during restore",
              last_error: baselineAuthority.error,
            },
            attempts: 0,
            lastError: null,
            updatedAt: now(),
          };
        }
        restorationRequiresPersist = true;
      }
      if (restorationRequiresPersist) this.persist();
    } catch (error) {
      // An existing but unreadable/non-parseable job snapshot may contain the
      // only durable PG, Docker-ID or DGX-lease authority. Treating it as an
      // empty fresh session would permit new work while orphaned compute is
      // still live. Keep the manager in a sticky restart-required HOLD and do
      // not reconcile/publicize outputs from an authority-less view.
      if (!isJobPersistenceHoldError(error)) {
        this.enterPersistenceHold(
          error,
          `vorhandener Job-Snapshot ${this.storagePath} ist nicht beweiskräftig les- und wiederherstellbar`,
        );
      }
      return;
    }
    this.reconcileOutputAuthorityArchiveAtStartup(
      `Output-Authority-Archiv ${this.outputAuthorityArchivePath} konnte nach Job-Restore nicht beweiskräftig abgeglichen werden`,
    );
  }

  private trimHistory(): void {
    const entries = [...this.jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const job of entries.slice(MAX_JOBS)) {
      if (!job.legacyHistory
        && !job.experiment
        && !job.dgxSuccessorAuthorization
        && !isActiveJobStatus(job.status)
        && !this.jobSettlementPending(job)) this.jobs.delete(job.id);
    }
  }
}
