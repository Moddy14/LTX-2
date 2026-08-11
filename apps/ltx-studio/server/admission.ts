import type { GenerationRequest } from "../shared/pipelines.js";
import {
  admissionPreflightPlan,
  type AdmissionPreflightReport,
  type AdmissionPreflightStep,
} from "../shared/admissionPreflight.js";
import { estimateResources } from "../shared/estimates.js";
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
  retry_after_seconds?: number;
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

export type QueueJobSummary = {
  job_id: string;
  state: QueueJobState;
  requested_by?: string;
  source_app?: string;
  job_type?: string;
  runtime?: string;
  queue_position?: number | null;
  decision?: string;
  reason?: string;
  message_for_humans?: string;
  app_message?: string;
  current_step?: string;
  last_error?: string;
  runner_last_seen_at?: string | null;
  runtime_status?: Record<string, unknown> | null;
};

export type QueueListResponse = {
  jobs: QueueJobSummary[];
};

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
  return request.mode !== "two-stage-hq"
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
  const seconds = "retry_after_seconds" in decision && typeof decision.retry_after_seconds === "number"
    ? decision.retry_after_seconds
    : decision.decision === "rejected_insufficient_resources"
      && "client_action" in decision
      && decision.client_action === "retry_when_resources_free"
      ? 900
      : 30;
  return Math.max(0, seconds * 1000);
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

export async function submitQueueAdmission(
  request: GenerationRequest,
  estimatedMemoryGiB?: number,
  callerJobId?: string,
  signal?: AbortSignal,
): Promise<QueueSubmitResponse> {
  const [admissionRequest] = buildAdmissionRequests(request, estimatedMemoryGiB, callerJobId);
  return runtimeApiJson("POST", "/dgx/queue/submit", admissionRequest, {
    timeoutMs: 120_000,
    signal,
  });
}

export async function listQueueJobs(): Promise<QueueListResponse> {
  const response = await runtimeApiJson<unknown>(
    "GET",
    "/dgx/queue",
    undefined,
    { timeoutMs: 30_000 },
  );
  return { jobs: normalizeQueueJobs(response) };
}

export function normalizeQueueJobs(response: unknown): QueueJobSummary[] {
  if (!response || typeof response !== "object") return [];
  const root = response as Record<string, unknown>;
  const queue = root.queue && typeof root.queue === "object"
    ? root.queue as Record<string, unknown>
    : {};
  const groups = [
    root.jobs,
    queue.jobs,
    queue.accepted_jobs,
    queue.active_jobs,
    queue.queued_jobs,
  ];
  const states = new Set<QueueJobState>([
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
  const jobs = new Map<string, QueueJobSummary>();
  for (const group of groups) {
    if (!Array.isArray(group)) continue;
    for (const value of group) {
      if (!value || typeof value !== "object") continue;
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.job_id !== "string"
        || !candidate.job_id
        || typeof candidate.state !== "string"
        || !states.has(candidate.state as QueueJobState)) continue;
      jobs.set(candidate.job_id, candidate as QueueJobSummary);
    }
  }
  return [...jobs.values()];
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
  if (typeof value.action !== "string"
    || !SEGMENT_BOUNDARY_ACTIONS.has(value.action as SegmentBoundaryAction)) {
    throw new Error("Segmentgrenzen-Antwort enthält keine bekannte Aktion");
  }
  if (value.current_job_id !== expectedJobId) {
    throw new Error("Segmentgrenzen-Antwort gehört zu einem anderen DGX-Job");
  }
  if (value.next_job_id !== undefined
    && value.next_job_id !== null
    && typeof value.next_job_id !== "string") {
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
