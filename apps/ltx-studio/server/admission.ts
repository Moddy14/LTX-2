import type { GenerationRequest } from "../shared/pipelines.js";
import type { DgxMemoryBlocker } from "../shared/dgxMemoryWait.js";
import {
  admissionPreflightPlan,
  type AdmissionPreflightReport,
  type AdmissionPreflightStep,
} from "../shared/admissionPreflight.js";
import { estimateResources } from "../shared/estimates.js";
import {
  qualificationHoldForRequest,
  type QualificationHold,
} from "../shared/qualificationHold.js";
import { join } from "node:path";
import { admissionRequired, dataRoot } from "./config.js";
import { runtimeApiConfigured, runtimeApiJson } from "./runtimeApi.js";

export type CooperativeScheduling = {
  mode: "segmented";
  preemptible: true;
  yield_after_each_segment: true;
  expected_segment_seconds: number;
  resume_checkpoint: string;
};

export type AdmissionRequest = {
  requested_by: string;
  source_app: string;
  job_type: string;
  runtime: string;
  priority: "normal";
  estimated_memory_gib: number;
  /**
   * Der Weg zur Runtime-API ist auf Loopback festgenagelt (runtimeApi.ts prüft
   * den Host), deshalb ist der Wert konstant. Der Orchestrator braucht ihn
   * trotzdem ausgesprochen, um Waiter-Bedingungen nicht raten zu müssen.
   */
  caller_network: "dgx_local";
  /**
   * Großzügig: Wir pollen selbst weiter, solange es dauert - der längste
   * berechtigte Wartefall waren gut fünf Stunden. Ein knappes TTL würde einen
   * korrekt wartenden Job verfallen lassen.
   */
  queue_ttl_seconds: number;
  /**
   * Stabil über alle Segmente eines Laufs. Ohne diesen Schlüssel legte jedes
   * Resume nach einem kooperativen Yield einen neuen Queue-Record an: Ein
   * einziger Studio-Job erzeugte so vier Records, und Wechselkosten ließen sich
   * keinem Lauf mehr zuordnen.
   */
  idempotency_key: string;
  resumability?: "required";
  scheduling?: CooperativeScheduling;
  resource_profile: {
    gpu: boolean;
    exclusive_runtime: string;
    required_gib: number;
  };
};

export type AdmissionDecision = {
  decision: string;
  reason?: string;
  client_action?: string;
  message_for_humans?: string;
  app_message?: string;
  retry_after_seconds?: number | null;
  /**
   * The Runtime API sets this only when an exact idempotency replay resolved
   * the caller's existing job instead of creating a new one.  Bound callers
   * use POST /dgx/queue/replay/<expected-job-id>; legacy submit responses can
   * also carry the marker.  Callers must still bind the returned job identity
   * to their durable local lease before treating the response as evidence.
   */
  idempotent_replay?: boolean;
  /** Exact existing queue identity fenced by the replay-only endpoint. */
  replay_bound_job_id?: string;
  /** Optional structured start-gate diagnostic; validated before display. */
  blocker?: unknown;
  job_id?: string;
  evicted_for?: {
    requested_by?: string;
    job_id?: string;
    estimated_memory_gib?: number;
  };
};

export type QueueJobState =
  | "submitted"
  | "accepted"
  | "queued"
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

/** Exact public identity emitted and accepted by the current DGX Runtime API. */
export const DGX_JOB_ID_PATTERN = /^dgx-job-\d{8}-\d{6}-[0-9a-f]{12}$/;

export function isDgxJobId(value: unknown): value is string {
  return typeof value === "string" && DGX_JOB_ID_PATTERN.test(value);
}

export type QueueJobSummary = {
  job_id: string;
  state: QueueJobState;
  requested_by?: string;
  source_app?: string;
  job_type?: string;
  runtime?: string;
  priority?: string;
  exclusive_runtime?: string;
  created_at?: string;
  started_at?: string | null;
  /**
   * Public scheduler capabilities projected by the current Runtime API.
   * They remain optional at the transport boundary so an older/drifted
   * orchestrator is represented honestly and can be rejected fail-closed.
   */
  durable_waiter?: boolean;
  segment_waiter?: boolean;
  reservation_active?: boolean;
  queue_position?: number | null;
  decision?: string;
  reason?: string;
  client_action?: string;
  retry_after_seconds?: number | null;
  message_for_humans?: string;
  app_message?: string;
  /** Raw Runtime-API field. Consumers must use normalizeDgxMemoryBlocker. */
  blocker?: unknown;
  current_step?: string;
  last_error?: string;
  runner_last_seen_at?: string | null;
  runtime_status?: Record<string, unknown> | null;
  idempotency_key?: string | null;
};

/** Compile-time convenience for already normalized Runtime-API diagnostics. */
export type { DgxMemoryBlocker };

export function cooperativeQueueContractConfirmed(
  admission: AdmissionRequest,
  remote: Pick<QueueJobSummary, "durable_waiter" | "segment_waiter"> | null | undefined,
): boolean {
  const cooperative = admission.resumability === "required"
    && admission.scheduling?.mode === "segmented";
  return !cooperative
    || (remote?.durable_waiter === true && remote.segment_waiter === true);
}

/**
 * A resource-free durable retry order projected by GET /dgx/queue.
 *
 * This is deliberately not a QueueJobSummary: cooling orders have no
 * `dgx-job-*` identity, queue position, reservation or active lease. The
 * orchestrator publishes a regular successor job only after cooling has been
 * proven.
 */
export type QueueCoolingOrderSummary = {
  order_id: string;
  state: "cooling";
  source_app: string;
  job_type: string;
  runtime: string;
  created_at: string;
  updated_at: string;
  current_step: string;
  queue_position: null;
};

export type QueueAdmissionState =
  | "local_queue_v0"
  | "local_queue_uninitialized"
  | "local_queue_unreadable";

export type QueueLockLaneSummary =
  | { state: "free"; waiters: number }
  | { state: "held" | "stalled"; seconds: number; waiters: number; holders: number }
  | { state: "unmeasured"; reason: string; detail?: string; waiters?: number };

export type QueueListResponse = {
  /** Preserved only after exact root-envelope validation. */
  schemaVersion?: "dgx-queue-read.v0";
  jobs: QueueJobSummary[];
  coolingOrders?: QueueCoolingOrderSummary[];
  /** Structural job/authority errors or queue jobs discarded as untrustworthy. */
  discardedJobLikeEntries?: number;
  /** Cooling-only diagnostics; these orders never establish a runtime lease. */
  discardedCoolingEntries?: number;
  queueReadable?: boolean;
  admissionState?: QueueAdmissionState;
  lockLane?: QueueLockLaneSummary;
};

export function assertAuthoritativeQueueList(response: QueueListResponse): void {
  const discardedJobs = response.discardedJobLikeEntries ?? 0;
  if (!Array.isArray(response.jobs)
    || response.schemaVersion !== "dgx-queue-read.v0"
    || !Number.isInteger(discardedJobs)
    || discardedJobs !== 0
    || response.queueReadable !== true
    || (response.admissionState !== "local_queue_v0"
      && response.admissionState !== "local_queue_uninitialized")
    || !normalizeQueueLockLane(response.lockLane)) {
    throw new Error("Die DGX-Queue enthielt unvollständige oder nicht normalisierbare Jobzustände.");
  }
}

/**
 * Proves that a caller-observed absence was taken from a readable, structurally
 * valid queue while the queue lock lane explicitly reported `free`.
 *
 * This deliberately does not require `jobs.length === 0`: callers prove the
 * absence of their own exact identity after filtering an otherwise valid list.
 */
export function assertAuthoritativeQueueAbsence(response: QueueListResponse): void {
  assertAuthoritativeQueueList(response);
  if (response.lockLane?.state !== "free") {
    throw new Error("Die Abwesenheit eines DGX-Jobs ist bei belegter oder ungemessener Queue-Lane nicht beweisbar.");
  }
}

export type QueueSubmitResponse = {
  schema_version: "dgx-queue-submit.v0";
  job: QueueJobSummary;
  admission: AdmissionDecision;
};

export type QueueJobReadResponse = {
  schema_version: "dgx-job-read.v0";
  job: QueueJobSummary;
};

export type QueueTransitionResponse = {
  schema_version: "dgx-job-transition.v0";
  job: QueueJobSummary;
};

export type QueueHeartbeatPayload = {
  runtime_status: Record<string, unknown>;
  progressed?: true;
  current_step?: string;
};

export type QueueHeartbeatResponse = {
  schema_version: "dgx-job-heartbeat.v0";
  /** Omitted by the current success response; explicit false is a generation no-op. */
  heartbeat_applied?: true;
  job: QueueJobSummary;
};

export type QueueTransitionState = Extract<
  QueueJobState,
  "starting" | "running" | "pausing" | "paused" | "resuming" | "completed" | "failed" | "cancelled"
>;

export type QueueArtifact = {
  type: string;
  path?: string;
  url?: string;
  size_bytes?: number;
  sha256?: string;
  note?: string;
};

const TRANSIENT_REASONS = new Set([
  "qwen_eviction_in_progress",
  "qwen_evicted_memory_reserved_for_job",
  "qwen_restore_reserved",
  "qwen_eviction_state_unreadable",
  "qwen_pressure_evicted_for_blocked_job",
  "qwen_required_reclaim_not_available",
  "qwen_required_reclaim_not_completed",
]);

export type SegmentBoundaryAction =
  | "continue_current"
  | "yield_to_waiting_job"
  | "wait_for_successor"
  | "resume_current";

export type SegmentBoundaryDecision = {
  schema_version: "dgx-segment-schedule-decision.v1";
  action: SegmentBoundaryAction;
  current_job_id: string;
  next_job_id: string | null;
  reason: string;
  retry_after_seconds: number;
};

const SEGMENT_BOUNDARY_ACTIONS = new Set<SegmentBoundaryAction>([
  "continue_current",
  "yield_to_waiting_job",
  "wait_for_successor",
  "resume_current",
]);

export function supportsCooperativeCheckpoint(request: GenerationRequest): boolean {
  // The CFG++ sampler loop has no restore/yield hooks; promising resumability
  // there would let a job ignore orchestrator yield requests under Qwen pressure.
  // DFR is also deliberately single-call: its generated keyframe bag and tiled
  // temporal rounds have no durable restore contract in the upstream CLI.
  return request.mode !== "dfr"
    && request.mode !== "two-stage-hq"
    && request.mode !== "text-to-audio"
    && request.mode !== "ic-lora"
    && !request.postprocess.latentSync.enabled
    && !request.postprocess.museTalk.enabled
    && !request.postprocess.lipForcing.enabled;
}

/** Längster gemessener Abstand zwischen zwei Checkpoint-Grenzen (Stage 2, 1280×704). */
export const EXPECTED_SEGMENT_SECONDS = 9;

/** Reichlich bemessen; wir erneuern selbst weiter, statt zu verfallen. */
export const QUEUE_TTL_SECONDS = 3600;

/** Gemessene Untergrenze des vom Orchestrator haltbar behandelten LTX-Waiters. */
export const DURABLE_LTX_SEGMENT_WAITER_MIN_GIB = 58;

/**
 * Ein Schlüssel je Studio-Job, unverändert über alle Segmente.
 *
 * Ohne ihn erzeugte jedes Resume nach einem kooperativen Yield einen eigenen
 * Queue-Record - für einen einzigen Lauf wurden so vier Records angelegt, die in
 * der Queue wie unabhängige Jobs aussahen.
 */
export function admissionIdempotencyKey(callerJobId?: string): string {
  return callerJobId ? `ltx-studio:${callerJobId}` : "ltx-studio";
}

export function cooperativeCheckpointPath(callerJobId: string): string {
  return join(dataRoot, "checkpoints", callerJobId, "manifest.json");
}

export function queueAdmissionMemoryGiB(
  request: GenerationRequest,
  estimatedMemoryGiB: number,
  callerJobId?: string,
): number {
  return callerJobId && supportsCooperativeCheckpoint(request)
    ? Math.max(DURABLE_LTX_SEGMENT_WAITER_MIN_GIB, estimatedMemoryGiB)
    : estimatedMemoryGiB;
}

export function buildAdmissionRequests(
  request: GenerationRequest,
  estimatedMemoryGiB?: number,
  callerJobId?: string,
): AdmissionRequest[] {
  const qualificationHold = qualificationHoldForRequest(request);
  if (qualificationHold) throw new Error(qualificationHold.reason);
  const cooperative = Boolean(callerJobId && supportsCooperativeCheckpoint(request));
  const requestMemoryGiB = queueAdmissionMemoryGiB(
    request,
    estimatedMemoryGiB ?? estimateResources(request).memoryGiB,
    callerJobId,
  );
  const cooperativeScheduling = cooperative
    ? {
        resumability: "required" as const,
        scheduling: {
          mode: "segmented" as const,
          preemptible: true as const,
          yield_after_each_segment: true as const,
          // Gemessen, nicht geschätzt: Die Prüfung sitzt nach jedem Euler-Schritt.
          // Ein Schritt dauert 2,07 s in Stage 1 (640x352) und 8,67 s in Stage 2
          // (1280x704). Der bisherige Wert 60 stammte aus der Zeit davor und
          // hätte den Orchestrator eine haltbare Zusage verwerfen lassen.
          expected_segment_seconds: EXPECTED_SEGMENT_SECONDS,
          resume_checkpoint: cooperativeCheckpointPath(callerJobId!),
        },
      }
    : {};
  return [{
    requested_by: callerJobId ? `ltx-studio:${callerJobId}` : "ltx-studio",
    source_app: "LTX Studio",
    job_type: `ltx2_native_${request.mode.replaceAll("-", "_")}`,
    runtime: "ltx2_native",
    priority: "normal",
    estimated_memory_gib: requestMemoryGiB,
    caller_network: "dgx_local",
    queue_ttl_seconds: QUEUE_TTL_SECONDS,
    idempotency_key: admissionIdempotencyKey(callerJobId),
    ...cooperativeScheduling,
    resource_profile: {
      gpu: true,
      exclusive_runtime: "ltx2_native",
      required_gib: requestMemoryGiB,
    },
  }];
}

export function admissionClientAvailable(): boolean {
  if (!admissionRequired) return true;
  return runtimeApiConfigured();
}

export function decisionMessage(decision: AdmissionDecision | QueueJobSummary): string {
  if (decision.decision === "busy_retry" && decision.reason) return decision.reason;
  return decision.message_for_humans
    ?? decision.app_message
    ?? decision.reason
    ?? decision.decision
    ?? "keine Detailmeldung";
}

export function retryAfterMs(decision: AdmissionDecision | QueueJobSummary): number {
  const fallbackSeconds = decision.decision === "rejected_insufficient_resources"
    && decision.client_action === "retry_when_resources_free"
    ? 900
    : 30;
  const requestedSeconds = decision.retry_after_seconds;
  const seconds = typeof requestedSeconds === "number"
    && Number.isSafeInteger(requestedSeconds)
    && requestedSeconds >= 1
    && requestedSeconds <= 4_800
    ? requestedSeconds
    : fallbackSeconds;
  return seconds * 1000;
}

export function shouldRetryQueueSubmit(decision: AdmissionDecision): boolean {
  if (decision.decision === "queued" || decision.decision === "busy_retry") return true;
  if (decision.decision === "rejected_insufficient_resources") {
    return decision.client_action === "retry_when_resources_free";
  }
  return typeof decision.reason === "string" && TRANSIENT_REASONS.has(decision.reason);
}

export async function checkQueueAdmission(
  request: GenerationRequest,
  estimatedMemoryGiB?: number,
  signal?: AbortSignal,
): Promise<AdmissionDecision> {
  const [admissionRequest] = buildAdmissionRequests(request, estimatedMemoryGiB);
  return runtimeApiJson("POST", "/dgx/admission/check", admissionRequest, {
    timeoutMs: 30_000,
    signal,
  });
}

export async function admissionPreflight(
  request: GenerationRequest,
  check: (
    request: GenerationRequest,
    estimatedMemoryGiB?: number,
  ) => Promise<AdmissionDecision> = checkQueueAdmission,
): Promise<AdmissionPreflightReport> {
  const held = qualificationHoldAdmissionPreflight(request);
  if (held) return held;
  const { steps: plan, notes } = admissionPreflightPlan(request);
  const steps: AdmissionPreflightStep[] = [];
  let unverifiable = false;
  for (const step of plan) {
    try {
      const decision = await check(request, step.estimatedMemoryGiB);
      steps.push({
        ...step,
        decision: decision.decision ?? "unbekannt",
        accepted: decision.decision === "accepted",
        message: decisionMessage(decision),
      });
    } catch (error) {
      unverifiable = true;
      steps.push({
        ...step,
        decision: "nicht-pruefbar",
        accepted: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const verdict: AdmissionPreflightReport["verdict"] = unverifiable
    ? "nicht-pruefbar"
    : steps.every((step) => step.accepted) ? "start-frei" : "wartet";
  return { checkedAt: new Date().toISOString(), verdict, notes, steps };
}

export function qualificationHoldAdmissionPreflight(
  request: GenerationRequest,
  checkedAt = new Date().toISOString(),
): AdmissionPreflightReport | null {
  const hold: QualificationHold | null = qualificationHoldForRequest(request);
  if (!hold) return null;
  return {
    checkedAt,
    verdict: "hold",
    notes: [
      hold.reason,
      "Es wurde keine DGX-Admission angefragt und keine CPU-only-Wiederverwendung freigegeben.",
    ],
    steps: [{
      label: "DFR Qualification-HOLD",
      estimatedMemoryGiB: 0,
      decision: hold.code,
      accepted: false,
      message: hold.reason,
    }],
  };
}

export async function submitQueueAdmission(
  request: GenerationRequest,
  estimatedMemoryGiB?: number,
  callerJobId?: string,
  signal?: AbortSignal,
): Promise<QueueSubmitResponse> {
  const [admissionRequest] = buildAdmissionRequests(request, estimatedMemoryGiB, callerJobId);
  return submitPreparedQueueAdmission(admissionRequest, signal);
}

/**
 * Performs the one lease-creating queue submit for a Studio job.  An
 * ambiguous response is reconciled read-only; this endpoint must never be
 * called again for recovery.  Once a durable lease exists, only
 * replayPreparedQueueAdmission may refresh it.
 */
export async function submitPreparedQueueAdmission(
  admissionRequest: AdmissionRequest,
  signal?: AbortSignal,
): Promise<QueueSubmitResponse> {
  return runtimeApiJson("POST", "/dgx/queue/submit", admissionRequest, {
    timeoutMs: 120_000,
    signal,
  });
}

/**
 * Refreshes one already-known queue lease without granting the server
 * authority to create a successor job when the known record became terminal
 * between the caller's GET and POST.  The bounded client wait keeps a slow
 * local replay from monopolizing the read-only observation loop; the server
 * may finish the fenced operation and the following GET will reconcile it.
 */
export async function replayPreparedQueueAdmission(
  admissionRequest: AdmissionRequest,
  expectedDgxJobId: string,
  signal?: AbortSignal,
): Promise<QueueSubmitResponse> {
  if (!isDgxJobId(expectedDgxJobId)) {
    throw new Error("DGX-Queue-Replay verlangt eine gültige erwartete Job-ID.");
  }
  return runtimeApiJson(
    "POST",
    `/dgx/queue/replay/${encodeURIComponent(expectedDgxJobId)}`,
    admissionRequest,
    { timeoutMs: 25_000, signal },
  );
}

export async function listQueueJobs(): Promise<QueueListResponse> {
  const response = await runtimeApiJson<unknown>(
    "GET",
    "/dgx/queue",
    undefined,
    { timeoutMs: 30_000 },
  );
  const normalized = normalizeQueueJobsWithDiagnostics(response);
  assertAuthoritativeQueueList(normalized);
  return normalized;
}

export function normalizeQueueJobs(response: unknown): QueueJobSummary[] {
  const normalized = normalizeQueueJobsWithDiagnostics(response);
  assertAuthoritativeQueueList(normalized);
  return normalized.jobs;
}

const OFFSET_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export function parseStrictOffsetDateTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = OFFSET_DATE_TIME_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Runtime API legacy records use both null and the empty string for "never started". */
export function isDgxNeverStarted(value: unknown): value is null | "" {
  return value === null || value === "";
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0;
}

function normalizeQueueLockLane(value: unknown): QueueLockLaneSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const lane = value as Record<string, unknown>;
  if (lane.state === "free" && nonNegativeInteger(lane.waiters)) {
    return lane as QueueLockLaneSummary;
  }
  if ((lane.state === "held" || lane.state === "stalled")
    && typeof lane.seconds === "number"
    && Number.isFinite(lane.seconds)
    && lane.seconds >= 0
    && nonNegativeInteger(lane.waiters)
    && nonNegativeInteger(lane.holders)) {
    return lane as QueueLockLaneSummary;
  }
  if (lane.state === "unmeasured"
    && typeof lane.reason === "string"
    && lane.reason.trim().length > 0
    && lane.reason === lane.reason.trim()
    && (lane.detail === undefined
      || (typeof lane.detail === "string"
        && lane.detail.trim().length > 0
        && lane.detail === lane.detail.trim()))
    && (lane.waiters === undefined || nonNegativeInteger(lane.waiters))) {
    return lane as QueueLockLaneSummary;
  }
  return undefined;
}

export function normalizeQueueJobsWithDiagnostics(response: unknown): QueueListResponse {
  if (!response || typeof response !== "object" || Array.isArray(response)) {
    return { jobs: [], discardedJobLikeEntries: 1 };
  }
  const root = response as Record<string, unknown>;
  const jobs = new Map<string, QueueJobSummary>();
  const coolingOrders = new Map<string, QueueCoolingOrderSummary>();
  let discardedJobLikeEntries = 0;
  let discardedCoolingEntries = 0;
  if (root.schema_version !== "dgx-queue-read.v0") discardedJobLikeEntries += 1;
  if (!root.queue || typeof root.queue !== "object" || Array.isArray(root.queue)) {
    discardedJobLikeEntries += 1;
    return { jobs: [], discardedJobLikeEntries };
  }
  const queue = root.queue as Record<string, unknown>;
  const queueReadable = typeof queue.readable === "boolean" ? queue.readable : undefined;
  if (queueReadable === undefined) discardedJobLikeEntries += 1;
  const admissionState = (
    queue.admission_state === "local_queue_v0"
      || queue.admission_state === "local_queue_uninitialized"
      || queue.admission_state === "local_queue_unreadable"
  ) ? queue.admission_state : undefined;
  if (admissionState === undefined) discardedJobLikeEntries += 1;
  if (queueReadable !== undefined && admissionState !== undefined) {
    const stateMatchesReadability = queueReadable
      ? admissionState === "local_queue_v0" || admissionState === "local_queue_uninitialized"
      : admissionState === "local_queue_unreadable";
    if (!stateMatchesReadability) discardedJobLikeEntries += 1;
  }
  const lockLane = normalizeQueueLockLane(queue.lock_lane);
  if (!lockLane) discardedJobLikeEntries += 1;
  const acceptedJobs = queue.accepted_jobs === undefined
    && (admissionState === "local_queue_uninitialized"
      || admissionState === "local_queue_unreadable")
    ? []
    : queue.accepted_jobs;
  const groups: Array<{
    value: unknown;
    states: ReadonlySet<QueueJobState>;
  }> = [
    { value: acceptedJobs, states: new Set<QueueJobState>(["accepted"]) },
    {
      value: queue.active_jobs,
      states: new Set<QueueJobState>(["starting", "running", "pausing", "paused", "resuming"]),
    },
    { value: queue.queued_jobs, states: new Set<QueueJobState>(["queued"]) },
  ];
  for (const group of groups) {
    if (!Array.isArray(group.value)) {
      discardedJobLikeEntries += 1;
      continue;
    }
    for (const value of group.value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        discardedJobLikeEntries += 1;
        continue;
      }
      const candidate = value as Record<string, unknown>;
      if (!isDgxJobId(candidate.job_id)
        || typeof candidate.state !== "string"
        || !group.states.has(candidate.state as QueueJobState)
        || typeof candidate.requested_by !== "string"
        || candidate.requested_by.trim().length === 0
        || candidate.requested_by !== candidate.requested_by.trim()
        || typeof candidate.source_app !== "string"
        || candidate.source_app.trim().length === 0
        || candidate.source_app !== candidate.source_app.trim()
        || typeof candidate.job_type !== "string"
        || !/^[a-z0-9_]{3,128}$/.test(candidate.job_type)
        || typeof candidate.runtime !== "string"
        || !/^[a-z0-9_]{3,128}$/.test(candidate.runtime)
        || typeof candidate.priority !== "string"
        || candidate.priority.trim().length === 0
        || candidate.priority !== candidate.priority.trim()
        || typeof candidate.exclusive_runtime !== "string"
        || candidate.exclusive_runtime.trim().length === 0
        || candidate.exclusive_runtime !== candidate.exclusive_runtime.trim()
        || parseStrictOffsetDateTime(candidate.created_at) === null
        || (!isDgxNeverStarted(candidate.started_at)
          && parseStrictOffsetDateTime(candidate.started_at) === null)
        || typeof candidate.reservation_active !== "boolean"
        || typeof candidate.idempotency_key !== "string"
        || candidate.idempotency_key.trim().length === 0
        || candidate.idempotency_key !== candidate.idempotency_key.trim()
        || jobs.has(candidate.job_id)) {
        discardedJobLikeEntries += 1;
        continue;
      }
      jobs.set(candidate.job_id, candidate as QueueJobSummary);
    }
  }
  if (admissionState === "local_queue_uninitialized" && jobs.size > 0) {
    discardedJobLikeEntries += 1;
  }
  if (!Array.isArray(queue.cooling_jobs)) {
    discardedCoolingEntries += 1;
  } else {
    for (const value of queue.cooling_jobs) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        discardedCoolingEntries += 1;
        continue;
      }
      const candidate = value as Record<string, unknown>;
      const stringFields = [
        candidate.source_app,
        candidate.job_type,
        candidate.runtime,
        candidate.current_step,
      ];
      const createdAt = parseStrictOffsetDateTime(candidate.created_at);
      const updatedAt = parseStrictOffsetDateTime(candidate.updated_at);
      if (typeof candidate.order_id !== "string"
        || !/^[0-9a-f]{64}$/.test(candidate.order_id)
        || candidate.state !== "cooling"
        || stringFields.some((field) =>
          typeof field !== "string" || field.trim().length === 0 || field !== field.trim())
        || createdAt === null
        || updatedAt === null
        || updatedAt < createdAt
        || candidate.queue_position !== null
        || coolingOrders.has(candidate.order_id)) {
        discardedCoolingEntries += 1;
        continue;
      }
      coolingOrders.set(candidate.order_id, candidate as QueueCoolingOrderSummary);
    }
  }
  return {
    ...(root.schema_version === "dgx-queue-read.v0"
      ? { schemaVersion: "dgx-queue-read.v0" as const }
      : {}),
    jobs: [...jobs.values()],
    ...(coolingOrders.size > 0 ? { coolingOrders: [...coolingOrders.values()] } : {}),
    ...(discardedJobLikeEntries > 0 ? { discardedJobLikeEntries } : {}),
    ...(discardedCoolingEntries > 0 ? { discardedCoolingEntries } : {}),
    ...(queueReadable !== undefined ? { queueReadable } : {}),
    ...(admissionState !== undefined ? { admissionState } : {}),
    ...(lockLane ? { lockLane } : {}),
  };
}

export async function readQueueJob(jobId: string): Promise<QueueJobReadResponse> {
  return runtimeApiJson("GET", `/dgx/jobs/${encodeURIComponent(jobId)}`, undefined, { timeoutMs: 30_000 });
}

export function normalizeSegmentBoundaryDecision(
  response: unknown,
  expectedJobId: string,
): SegmentBoundaryDecision {
  if (!response || typeof response !== "object") {
    throw new Error("Segmentgrenzen-Antwort ist kein JSON-Objekt");
  }
  const value = response as Record<string, unknown>;
  if (value.schema_version !== "dgx-segment-schedule-decision.v1") {
    throw new Error("Segmentgrenzen-Antwort besitzt keine unterstützte Schema-Version");
  }
  if (typeof value.action !== "string"
    || !SEGMENT_BOUNDARY_ACTIONS.has(value.action as SegmentBoundaryAction)) {
    throw new Error("Segmentgrenzen-Antwort enthält keine bekannte Aktion");
  }
  if (value.current_job_id !== expectedJobId) {
    throw new Error("Segmentgrenzen-Antwort gehört zu einem anderen DGX-Job");
  }
  if (value.next_job_id !== undefined
    && value.next_job_id !== null
    && !isDgxJobId(value.next_job_id)) {
    throw new Error("Segmentgrenzen-Antwort enthält eine ungültige Nachfolger-ID");
  }
  if (value.retry_after_seconds !== undefined
    && (typeof value.retry_after_seconds !== "number"
      || !Number.isFinite(value.retry_after_seconds)
      || !Number.isInteger(value.retry_after_seconds)
      || value.retry_after_seconds < 0)) {
    throw new Error("Segmentgrenzen-Antwort enthält eine ungültige Wartezeit");
  }
  return {
    schema_version: "dgx-segment-schedule-decision.v1",
    action: value.action as SegmentBoundaryAction,
    current_job_id: expectedJobId,
    next_job_id: typeof value.next_job_id === "string" ? value.next_job_id : null,
    reason: typeof value.reason === "string" && value.reason
      ? value.reason
      : "scheduler_policy",
    retry_after_seconds: typeof value.retry_after_seconds === "number"
      ? value.retry_after_seconds
      : 5,
  };
}

export async function decideSegmentBoundary(jobId: string): Promise<SegmentBoundaryDecision> {
  const response = await runtimeApiJson<unknown>(
    "POST",
    "/dgx/scheduler/segment-boundary/decide",
    { current_job_id: jobId },
    { timeoutMs: 8_000, maxBytes: 64 * 1024 },
  );
  return normalizeSegmentBoundaryDecision(response, jobId);
}

export async function transitionQueueJob(
  jobId: string,
  state: QueueTransitionState,
  metadata: { current_step?: string; last_error?: string; artifact?: QueueArtifact } = {},
): Promise<QueueTransitionResponse> {
  return runtimeApiJson("PATCH", `/dgx/jobs/${encodeURIComponent(jobId)}/state`, {
    state,
    ...metadata,
  }, { timeoutMs: 30_000 });
}

export async function heartbeatQueueJob(
  jobId: string,
  payload: QueueHeartbeatPayload,
): Promise<QueueHeartbeatResponse> {
  return runtimeApiJson("POST", `/dgx/jobs/${encodeURIComponent(jobId)}/heartbeat`, payload, {
    timeoutMs: 30_000,
  });
}
