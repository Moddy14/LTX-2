import type { GenerationRequest } from "../shared/pipelines.js";
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
  qwen_pressure_reclaim: "required_before_start";
};

export type AdmissionRequest = {
  requested_by: string;
  source_app: string;
  job_type: string;
  runtime: string;
  priority: "normal";
  estimated_memory_gib: number;
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

export type QueueTransitionState = Extract<
  QueueJobState,
  "starting" | "running" | "pausing" | "paused" | "completed" | "failed" | "cancelled"
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

export type QwenDemandResponse = {
  schema_version: "dgx-qwen-demand.v0";
  visible: boolean;
  updated_at?: string | null;
  expires_at?: string | null;
  owners?: string[];
};

export function supportsCooperativeCheckpoint(request: GenerationRequest): boolean {
  return request.mode !== "two-stage-hq";
}

export function cooperativeCheckpointPath(callerJobId: string): string {
  return join(dataRoot, "checkpoints", callerJobId, "manifest.json");
}

export function buildAdmissionRequests(
  request: GenerationRequest,
  estimatedMemoryGiB?: number,
  callerJobId?: string,
): AdmissionRequest[] {
  const requestMemoryGiB = estimatedMemoryGiB ?? estimateResources(request).memoryGiB;
  const cooperativeScheduling = callerJobId && supportsCooperativeCheckpoint(request)
    ? {
        resumability: "required" as const,
        scheduling: {
          mode: "segmented" as const,
          preemptible: true as const,
          yield_after_each_segment: true as const,
          expected_segment_seconds: 60,
          resume_checkpoint: cooperativeCheckpointPath(callerJobId),
          qwen_pressure_reclaim: "required_before_start" as const,
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

export async function readQwenDemand(): Promise<QwenDemandResponse> {
  return runtimeApiJson("GET", "/dgx/qwen-demand", undefined, { timeoutMs: 30_000 });
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
