import type { GenerationRequest } from "../shared/pipelines.js";
import { estimateResources } from "../shared/estimates.js";
import { admissionRequired } from "./config.js";
import { runtimeApiConfigured, runtimeApiJson } from "./runtimeApi.js";

export type AdmissionRequest = {
  requested_by: string;
  source_app: string;
  job_type: string;
  runtime: string;
  priority: "normal";
  estimated_memory_gib: number;
  resumability?: "required";
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
  "starting" | "running" | "completed" | "failed" | "cancelled"
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
]);

export function buildAdmissionRequests(request: GenerationRequest, estimatedMemoryGiB?: number): AdmissionRequest[] {
  const requestMemoryGiB = estimatedMemoryGiB ?? estimateResources(request).memoryGiB;
  return [{
    requested_by: "ltx-studio",
    source_app: "LTX Studio",
    job_type: `ltx2_native_${request.mode.replaceAll("-", "_")}`,
    runtime: "ltx2_native",
    priority: "normal",
    estimated_memory_gib: requestMemoryGiB,
    resumability: "required",
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
  return decision.message_for_humans
    ?? decision.app_message
    ?? decision.reason
    ?? decision.decision
    ?? "keine Detailmeldung";
}

export function retryAfterMs(decision: AdmissionDecision | QueueJobSummary): number {
  const seconds = "retry_after_seconds" in decision && typeof decision.retry_after_seconds === "number"
    ? decision.retry_after_seconds
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
): Promise<QueueSubmitResponse> {
  const [admissionRequest] = buildAdmissionRequests(request, estimatedMemoryGiB);
  return runtimeApiJson("POST", "/dgx/queue/submit", admissionRequest, { timeoutMs: 120_000 });
}

export async function readQueueJob(jobId: string): Promise<QueueJobReadResponse> {
  return runtimeApiJson("GET", `/dgx/jobs/${encodeURIComponent(jobId)}`, undefined, { timeoutMs: 30_000 });
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
