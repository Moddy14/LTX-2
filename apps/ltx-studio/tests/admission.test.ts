import { describe, expect, it } from "vitest";

import {
  buildAdmissionRequests,
  decisionMessage,
  normalizeQueueJobs,
  retryAfterMs,
  shouldRetryQueueSubmit,
  supportsCooperativeCheckpoint,
} from "../server/admission.js";
import { validRequest } from "./fixtures.js";

describe("DGX admission contract", () => {
  it("never promises cooperative checkpoints for CFG++ sampler modes", () => {
    expect(supportsCooperativeCheckpoint(validRequest("text-to-audio"))).toBe(false);
    expect(supportsCooperativeCheckpoint(validRequest("ic-lora"))).toBe(false);

    const inpaint = validRequest("ic-lora");
    inpaint.icLora.profile = "inpainting";
    expect(supportsCooperativeCheckpoint(inpaint)).toBe(false);
  });

  it("keeps cooperative checkpoints for euler-loop modes", () => {
    expect(supportsCooperativeCheckpoint(validRequest("two-stage"))).toBe(true);
    expect(supportsCooperativeCheckpoint(validRequest("keyframes"))).toBe(true);
  });

  it("uses only native LTX admission when Gemma enhancement is enabled", () => {
    const requests = buildAdmissionRequests(validRequest());
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      runtime: "ltx2_native",
      job_type: "ltx2_native_two_stage",
      estimated_memory_gib: 60,
      resource_profile: { gpu: true, exclusive_runtime: "ltx2_native", required_gib: 60 },
    });
  });

  it("uses the same admission contract when Gemma enhancement is disabled", () => {
    const request = validRequest("distilled");
    request.enhancePrompt = false;
    const requests = buildAdmissionRequests(request);
    expect(requests).toHaveLength(1);
    expect(requests[0].job_type).toBe("ltx2_native_distilled");
  });

  it("uses a stable per-job requester key for crash reconciliation", () => {
    const jobId = "11111111-1111-4111-8111-111111111111";
    const [admission] = buildAdmissionRequests(validRequest(), undefined, jobId);

    expect(admission.requested_by).toBe(`ltx-studio:${jobId}`);
    expect(admission).toMatchObject({
      resumability: "required",
      scheduling: {
        mode: "segmented",
        preemptible: true,
        yield_after_each_segment: true,
        expected_segment_seconds: 60,
      },
    });
    expect(admission.scheduling).not.toHaveProperty("qwen_pressure_reclaim");
    expect(admission.scheduling?.resume_checkpoint).toContain(`/checkpoints/${jobId}/manifest.json`);
  });

  it("does not advertise a resumable boundary for the Res2S HQ sampler", () => {
    const [admission] = buildAdmissionRequests(validRequest("two-stage-hq"), undefined, "hq-job");

    expect(admission.resumability).toBeUndefined();
    expect(admission.scheduling).toBeUndefined();
  });

  it("keeps the full LTX plus LatentSync allocation non-preemptible", () => {
    const request = validRequest("lipdub");
    request.postprocess.latentSync.enabled = true;

    const [admission] = buildAdmissionRequests(request, 24, "latentsync-job");

    expect(admission.estimated_memory_gib).toBe(24);
    expect(admission.resumability).toBeUndefined();
    expect(admission.scheduling).toBeUndefined();
  });

  it("keeps the full LTX plus MuseTalk allocation non-preemptible", () => {
    const request = validRequest("lipdub");
    request.postprocess.museTalk.enabled = true;

    const [admission] = buildAdmissionRequests(request, 16, "musetalk-job");

    expect(admission.estimated_memory_gib).toBe(16);
    expect(admission.resumability).toBeUndefined();
    expect(admission.scheduling).toBeUndefined();
  });

  it("keeps the full LTX plus LipForcing allocation non-preemptible", () => {
    const request = validRequest("lipdub");
    request.postprocess.lipForcing.enabled = true;

    const [admission] = buildAdmissionRequests(request, 52, "lipforcing-job");

    expect(admission.estimated_memory_gib).toBe(52);
    expect(admission.resumability).toBeUndefined();
    expect(admission.scheduling).toBeUndefined();
  });

  it("does not understate runtime FP8 casting of a BF16 checkpoint", () => {
    const request = validRequest();
    request.enhancePrompt = false;
    request.quantization.mode = "fp8-cast";
    const [admission] = buildAdmissionRequests(request);
    expect(admission.estimated_memory_gib).toBe(60);
    expect(admission.resource_profile.required_gib).toBe(60);
  });

  it("uses the lower native FP8 estimate shown by the studio", () => {
    const request = validRequest();
    request.enhancePrompt = false;
    request.quantization.mode = "fp8-cast";
    request.models.checkpointPath = "/models/ltx-2.3-22b-dev-fp8.safetensors";
    const [admission] = buildAdmissionRequests(request);
    expect(admission.estimated_memory_gib).toBe(58);
    expect(admission.resource_profile.required_gib).toBe(58);
  });

  it("accepts a server-side media-aware estimate for native LipDub admission", () => {
    const request = validRequest("lipdub");
    const [admission] = buildAdmissionRequests(request, 82);
    expect(admission).toMatchObject({
      job_type: "ltx2_native_lipdub",
      estimated_memory_gib: 82,
      resource_profile: { required_gib: 82 },
    });
  });

  it("retries orchestrator-controlled qwen pressure windows exactly as instructed", () => {
    expect(shouldRetryQueueSubmit({
      decision: "busy_retry",
      reason: "qwen_eviction_in_progress",
      client_action: "retry_later",
      retry_after_seconds: 30,
    })).toBe(true);
    expect(retryAfterMs({
      decision: "busy_retry",
      reason: "qwen_eviction_in_progress",
      retry_after_seconds: 30,
    })).toBe(30_000);
  });

  it("shows the current busy reason instead of a stale accepted message", () => {
    expect(decisionMessage({
      decision: "busy_retry",
      reason: "qwen_restore_reserved",
      message_for_humans: "accepted from the first admission pass",
    })).toBe("qwen_restore_reserved");
  });

  it("uses the documented 15-minute fallback for resource waits without a server delay", () => {
    const decision = {
      decision: "rejected_insufficient_resources",
      client_action: "retry_when_resources_free",
      reason: "insufficient_memory",
    };
    expect(shouldRetryQueueSubmit(decision)).toBe(true);
    expect(retryAfterMs(decision)).toBe(900_000);
    expect(retryAfterMs({ ...decision, retry_after_seconds: 120 })).toBe(120_000);
  });

  it("does not retry requests that require caller-side fixes", () => {
    expect(shouldRetryQueueSubmit({
      decision: "rejected_policy",
      client_action: "fix_request",
      reason: "unknown_runtime",
    })).toBe(false);
    expect(shouldRetryQueueSubmit({
      decision: "rejected_insufficient_resources",
      client_action: "free_reclaim_candidates_then_retry",
      reason: "memory_reclaim_required",
    })).toBe(false);
  });

  it("normalizes the current Runtime API queue groups for crash reconciliation", () => {
    expect(normalizeQueueJobs({
      schema_version: "dgx-queue-read.v0",
      queue: {
        accepted_jobs: [{
          job_id: "dgx-job-accepted",
          state: "accepted",
          requested_by: "ltx-studio:one",
        }],
        active_jobs: [{
          job_id: "dgx-job-running",
          state: "running",
          requested_by: "ltx-studio:two",
        }],
        queued_jobs: [{
          job_id: "dgx-job-queued",
          state: "queued",
          requested_by: "ltx-studio:three",
        }],
      },
    })).toEqual([
      expect.objectContaining({ job_id: "dgx-job-accepted", state: "accepted" }),
      expect.objectContaining({ job_id: "dgx-job-running", state: "running" }),
      expect.objectContaining({ job_id: "dgx-job-queued", state: "queued" }),
    ]);
  });
});
