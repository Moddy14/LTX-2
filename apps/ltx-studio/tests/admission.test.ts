import { describe, expect, it } from "vitest";

import {
  assertAuthoritativeQueueAbsence,
  assertAuthoritativeQueueList,
  buildAdmissionRequests,
  decisionMessage,
  normalizeSegmentBoundaryDecision,
  normalizeQueueJobs,
  normalizeQueueJobsWithDiagnostics,
  retryAfterMs,
  shouldRetryQueueSubmit,
  supportsCooperativeCheckpoint,
} from "../server/admission.js";
import { validLtx25SplitRequest, validRequest } from "./fixtures.js";

const queueAuthority = {
  admission_state: "local_queue_v0",
  readable: true,
  lock_lane: { state: "free", waiters: 0 },
} as const;

function queueRead(queue: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: "dgx-queue-read.v0",
    queue: { ...queueAuthority, ...queue },
  };
}

function queueJob(
  jobId: string,
  state: "accepted" | "queued" | "starting" | "running" | "pausing" | "paused" | "resuming",
  requestedBy: string,
): Record<string, unknown> {
  const active = !["accepted", "queued"].includes(state);
  return {
    job_id: jobId,
    state,
    requested_by: requestedBy,
    source_app: "ltx-studio",
    job_type: "ltx2_native_distilled",
    runtime: "ltx2_native",
    priority: "normal",
    exclusive_runtime: "ltx2_native",
    created_at: "2026-08-27T08:00:00+00:00",
    started_at: active ? "2026-08-27T08:00:01+00:00" : null,
    reservation_active: state !== "queued",
    idempotency_key: requestedBy,
  };
}

describe("DGX admission contract", () => {
  it("normalizes all four canonical segment-boundary actions", () => {
    for (const action of [
      "continue_current",
      "yield_to_waiting_job",
      "wait_for_successor",
      "resume_current",
    ] as const) {
      expect(normalizeSegmentBoundaryDecision({
        schema_version: "dgx-segment-schedule-decision.v1",
        action,
        current_job_id: "dgx-job-1",
        next_job_id: null,
        reason: "test",
        retry_after_seconds: 3,
        additive_future_field: true,
      }, "dgx-job-1")).toMatchObject({ action, current_job_id: "dgx-job-1" });
    }
  });

  it("rejects stale or malformed segment-boundary responses", () => {
    expect(() => normalizeSegmentBoundaryDecision({
      schema_version: "dgx-segment-schedule-decision.v1",
      action: "continue_current",
      current_job_id: "dgx-job-stale",
    }, "dgx-job-current")).toThrow(/anderen DGX-Job/);
    expect(() => normalizeSegmentBoundaryDecision({
      schema_version: "dgx-segment-schedule-decision.v1",
      action: "invented_action",
    }, "dgx-job-current"))
      .toThrow(/keine bekannte Aktion/);
    expect(() => normalizeSegmentBoundaryDecision({
      schema_version: "dgx-segment-schedule-decision.v1",
      action: "wait_for_successor",
      current_job_id: "dgx-job-current",
      retry_after_seconds: -1,
    }, "dgx-job-current")).toThrow(/Wartezeit/);
  });

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

  it("names the caller network, a generous ttl and a segment-stable idempotency key", () => {
    const jobId = "22222222-2222-4222-8222-222222222222";
    const [admission] = buildAdmissionRequests(validRequest(), undefined, jobId);

    // Der Weg ist auf Loopback festgenagelt; der Orchestrator soll ihn nicht raten.
    expect(admission.caller_network).toBe("dgx_local");
    // Ein knappes TTL liesse einen korrekt wartenden Job verfallen - der laengste
    // berechtigte Wartefall dauerte gut fuenf Stunden.
    expect(admission.queue_ttl_seconds).toBeGreaterThanOrEqual(3600);
    // Derselbe Schluessel ueber alle Segmente: Ohne ihn legte jedes Resume nach
    // einem Yield einen eigenen Queue-Record an.
    expect(admission.idempotency_key).toBe(`ltx-studio:${jobId}`);
  });

  it("keeps the idempotency key stable across every segment of one job", () => {
    const jobId = "33333333-3333-4333-8333-333333333333";
    const ersteEinreichung = buildAdmissionRequests(validRequest(), undefined, jobId);
    const nachDemYield = buildAdmissionRequests(validRequest(), undefined, jobId);

    expect(nachDemYield[0].idempotency_key).toBe(ersteEinreichung[0].idempotency_key);
  });

  it("still submits without a job id, then without a per-job key", () => {
    const [admission] = buildAdmissionRequests(validRequest());

    expect(admission.idempotency_key).toBe("ltx-studio");
    expect(admission.caller_network).toBe("dgx_local");
    // Ohne Job-Id gibt es keinen Checkpoint-Pfad, also auch keine Yield-Zusage.
    expect(admission.scheduling).toBeUndefined();
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
        expected_segment_seconds: 9,
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

  it("never constructs a DGX admission request while DFR v1.3 is in qualification HOLD", () => {
    const request = validRequest("dfr");
    expect(supportsCooperativeCheckpoint(request)).toBe(false);
    expect(() => buildAdmissionRequests(request, undefined, "dfr-job"))
      .toThrow(/Qualification-HOLD/u);
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

  it("never submits a durable LTX segment waiter below its measured 58 GiB floor", () => {
    const request = validRequest("image-audio-to-video");
    const [admission] = buildAdmissionRequests(request, 56, "durable-segment-job");

    expect(admission).toMatchObject({
      estimated_memory_gib: 58,
      resource_profile: { required_gib: 58 },
      resumability: "required",
      scheduling: { mode: "segmented" },
    });
  });

  it("submits the full LTX-2.5 IA2V profile with its 82-GiB provisional safety floor", () => {
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.width = 1024;
    request.height = 1536;
    request.numFrames = 289;
    request.frameRate = 24;
    request.audio.maxDuration = null;
    request.tiling = true;
    request.enhancePrompt = false;
    const [admission] = buildAdmissionRequests(request, undefined, "ia2v-calibration-job");

    expect(admission).toMatchObject({
      job_type: "ltx2_native_image_audio_to_video",
      estimated_memory_gib: 82,
      resource_profile: { required_gib: 82 },
      resumability: "required",
      scheduling: { mode: "segmented" },
    });
  });

  it("never lets a full-size near-miss LTX-2.5 IA2V profile fall below the 82-GiB safety floor", () => {
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.width = 1024;
    request.height = 1536;
    request.numFrames = 289;
    request.frameRate = 24;
    request.audio.maxDuration = null;
    request.tiling = true;
    request.enhancePrompt = false;
    request.images.push({ ...request.images[0], name: "second.png" });
    const [admission] = buildAdmissionRequests(request, undefined, "ia2v-near-miss-job");

    expect(admission).toMatchObject({
      estimated_memory_gib: 82,
      resource_profile: { required_gib: 82 },
    });
  });

  it("does not apply the segment-waiter floor to non-resumable LTX work", () => {
    const request = validRequest("two-stage-hq");
    const [admission] = buildAdmissionRequests(request, 56, "non-resumable-job");

    expect(admission.estimated_memory_gib).toBe(56);
    expect(admission.resource_profile.required_gib).toBe(56);
    expect(admission.scheduling).toBeUndefined();
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

  it("rejects malformed or unbounded replay delays instead of weakening queue liveness", () => {
    const decision = { decision: "accepted" };
    expect(retryAfterMs({ ...decision, retry_after_seconds: 0 })).toBe(30_000);
    expect(retryAfterMs({ ...decision, retry_after_seconds: 1.5 })).toBe(30_000);
    expect(retryAfterMs({ ...decision, retry_after_seconds: Number.NaN })).toBe(30_000);
    expect(retryAfterMs({ ...decision, retry_after_seconds: Number.POSITIVE_INFINITY }))
      .toBe(30_000);
    expect(retryAfterMs({ ...decision, retry_after_seconds: 4_801 })).toBe(30_000);
    expect(retryAfterMs({ ...decision, retry_after_seconds: 4_800 })).toBe(4_800_000);
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

  it("separates resource-free cooling orders from queue jobs during crash reconciliation", () => {
    const response = {
      schema_version: "dgx-queue-read.v0",
      queue: {
        ...queueAuthority,
        accepted_jobs: [queueJob(
          "dgx-job-20260827-080000-000000000001",
          "accepted",
          "ltx-studio:one",
        )],
        active_jobs: [queueJob(
          "dgx-job-20260827-080000-000000000002",
          "running",
          "ltx-studio:two",
        )],
        cooling_jobs: [{
          order_id: "a".repeat(64),
          state: "cooling",
          source_app: "minimax-h3-dgx",
          job_type: "comfyui_minimax_h3_workflow",
          runtime: "comfyui_minimax_h3",
          created_at: "2026-08-27T08:00:00+00:00",
          updated_at: "2026-08-27T08:01:00+00:00",
          current_step: "durable order waiting for stable cooling",
          queue_position: null,
        }],
        queued_jobs: [queueJob(
          "dgx-job-20260827-080000-000000000003",
          "queued",
          "ltx-studio:three",
        )],
      },
    };

    expect(normalizeQueueJobs(response)).toEqual([
      expect.objectContaining({ job_id: "dgx-job-20260827-080000-000000000001", state: "accepted" }),
      expect.objectContaining({ job_id: "dgx-job-20260827-080000-000000000002", state: "running" }),
      expect.objectContaining({ job_id: "dgx-job-20260827-080000-000000000003", state: "queued" }),
    ]);
    expect(normalizeQueueJobsWithDiagnostics(response)).toMatchObject({
      schemaVersion: "dgx-queue-read.v0",
      jobs: [
        expect.objectContaining({ job_id: "dgx-job-20260827-080000-000000000001", state: "accepted" }),
        expect.objectContaining({ job_id: "dgx-job-20260827-080000-000000000002", state: "running" }),
        expect.objectContaining({ job_id: "dgx-job-20260827-080000-000000000003", state: "queued" }),
      ],
      coolingOrders: [{
        order_id: "a".repeat(64),
        state: "cooling",
        source_app: "minimax-h3-dgx",
        queue_position: null,
      }],
      queueReadable: true,
      admissionState: "local_queue_v0",
      lockLane: { state: "free", waiters: 0 },
    });
  });

  it("rejects job-shaped, duplicate or malformed cooling orders instead of inventing leases", () => {
    const order = {
      order_id: "b".repeat(64),
      state: "cooling",
      source_app: "minimax-h3-dgx",
      job_type: "comfyui_minimax_h3_workflow",
      runtime: "comfyui_minimax_h3",
      created_at: "2026-08-27T08:00:00+00:00",
      updated_at: "2026-08-27T08:01:00+00:00",
      current_step: "durable order waiting for stable cooling",
      queue_position: null,
    };
    const result = normalizeQueueJobsWithDiagnostics({
      schema_version: "dgx-queue-read.v0",
      queue: {
        ...queueAuthority,
        accepted_jobs: [],
        active_jobs: [],
        queued_jobs: [],
        cooling_jobs: [
          order,
          { ...order },
          {
            job_id: "dgx-job-not-a-cooling-order",
            state: "cooling",
            requested_by: "ltx-studio:not-an-order",
          },
          { ...order, order_id: "not-a-digest" },
        ],
      },
    });

    expect(result).toEqual({
      schemaVersion: "dgx-queue-read.v0",
      jobs: [],
      coolingOrders: [order],
      discardedCoolingEntries: 3,
      queueReadable: true,
      admissionState: "local_queue_v0",
      lockLane: { state: "free", waiters: 0 },
    });
    expect(normalizeQueueJobs({
      schema_version: "dgx-queue-read.v0",
      queue: {
        ...queueAuthority,
        accepted_jobs: [],
        active_jobs: [],
        queued_jobs: [],
        cooling_jobs: [{
          job_id: "dgx-job-not-a-cooling-order",
          state: "cooling",
          requested_by: "ltx-studio:not-an-order",
        }],
      },
    })).toEqual([]);
    expect(() => assertAuthoritativeQueueList(result)).not.toThrow();
  });

  it("requires strict offset timestamps and chronological cooling updates", () => {
    const order = {
      order_id: "c".repeat(64),
      state: "cooling",
      source_app: "minimax-h3-dgx",
      job_type: "comfyui_minimax_h3_workflow",
      runtime: "comfyui_minimax_h3",
      created_at: "2026-08-27T08:00:00+00:00",
      updated_at: "2026-08-27T08:01:00+00:00",
      current_step: "durable order waiting for stable cooling",
      queue_position: null,
    };
    const result = normalizeQueueJobsWithDiagnostics(queueRead({
      accepted_jobs: [],
      active_jobs: [],
      queued_jobs: [],
      cooling_jobs: [
        { ...order, order_id: "d".repeat(64), created_at: "2026-08-27T08:00:00" },
        { ...order, order_id: "e".repeat(64), created_at: "2026-02-30T08:00:00+00:00" },
        {
          ...order,
          order_id: "f".repeat(64),
          created_at: "2026-08-27T08:02:00+00:00",
          updated_at: "2026-08-27T08:01:00+00:00",
        },
      ],
    }));

    expect(result).toMatchObject({
      schemaVersion: "dgx-queue-read.v0",
      jobs: [],
      discardedCoolingEntries: 3,
      queueReadable: true,
      admissionState: "local_queue_v0",
      lockLane: { state: "free", waiters: 0 },
    });
    expect(result).not.toHaveProperty("discardedJobLikeEntries");
    expect(result).not.toHaveProperty("coolingOrders");
  });

  it("accepts a readable uninitialized queue without an accepted_jobs bucket", () => {
    const result = normalizeQueueJobsWithDiagnostics({
      schema_version: "dgx-queue-read.v0",
      queue: {
        admission_state: "local_queue_uninitialized",
        readable: true,
        lock_lane: { state: "free", waiters: 0 },
        active_jobs: [],
        cooling_jobs: [],
        queued_jobs: [],
      },
    });

    expect(result).toEqual({
      schemaVersion: "dgx-queue-read.v0",
      jobs: [],
      queueReadable: true,
      admissionState: "local_queue_uninitialized",
      lockLane: { state: "free", waiters: 0 },
    });
    expect(() => assertAuthoritativeQueueList(result)).not.toThrow();
    expect(() => assertAuthoritativeQueueAbsence(result)).not.toThrow();
  });

  it("rejects an unreadable queue even when its published buckets are empty", () => {
    const result = normalizeQueueJobsWithDiagnostics({
      schema_version: "dgx-queue-read.v0",
      queue: {
        admission_state: "local_queue_unreadable",
        readable: false,
        lock_lane: { state: "free", waiters: 0 },
        active_jobs: [],
        cooling_jobs: [],
        queued_jobs: [],
      },
    });

    expect(result).toEqual({
      schemaVersion: "dgx-queue-read.v0",
      jobs: [],
      queueReadable: false,
      admissionState: "local_queue_unreadable",
      lockLane: { state: "free", waiters: 0 },
    });
    expect(() => assertAuthoritativeQueueList(result)).toThrow("nicht normalisierbare Jobzustände");
    expect(() => assertAuthoritativeQueueAbsence(result)).toThrow("nicht normalisierbare Jobzustände");
  });

  it("uses a valid non-free lock view for listing but never for an absence proof", () => {
    for (const lock_lane of [
      { state: "held", seconds: 0.4, waiters: 0, holders: 1 },
      { state: "stalled", seconds: 1203.4, waiters: 3, holders: 1 },
      { state: "unmeasured", reason: "proc_locks_unreadable" },
    ]) {
      const result = normalizeQueueJobsWithDiagnostics(queueRead({
        lock_lane,
        accepted_jobs: [],
        active_jobs: [],
        cooling_jobs: [],
        queued_jobs: [],
      }));
      expect(() => assertAuthoritativeQueueList(result)).not.toThrow();
      expect(() => assertAuthoritativeQueueAbsence(result)).toThrow("nicht beweisbar");
    }
  });

  it("fails closed on malformed or contradictory authority metadata", () => {
    for (const authority of [
      { readable: "yes", admission_state: "local_queue_v0", lock_lane: { state: "free", waiters: 0 } },
      { readable: true, admission_state: "invented", lock_lane: { state: "free", waiters: 0 } },
      { readable: true, admission_state: "local_queue_unreadable", lock_lane: { state: "free", waiters: 0 } },
      { readable: true, admission_state: "local_queue_v0", lock_lane: { state: "held", seconds: 1, waiters: 0 } },
    ]) {
      const result = normalizeQueueJobsWithDiagnostics({
        schema_version: "dgx-queue-read.v0",
        queue: {
          ...authority,
          accepted_jobs: [],
          active_jobs: [],
          cooling_jobs: [],
          queued_jobs: [],
        },
      });
      expect(result.discardedJobLikeEntries).toBeGreaterThan(0);
      expect(() => assertAuthoritativeQueueList(result)).toThrow("nicht normalisierbare Jobzustände");
    }
  });

  it("reports unknown queue states instead of silently treating them as absence", () => {
    expect(normalizeQueueJobsWithDiagnostics({
      schema_version: "dgx-queue-read.v0",
      queue: {
        ...queueAuthority,
        accepted_jobs: [],
        active_jobs: [{
          job_id: "dgx-job-20260827-080000-000000000004",
          state: "launching-vNext",
          requested_by: "ltx-studio:one",
        }],
        cooling_jobs: [],
        queued_jobs: [],
      },
    })).toEqual({
      schemaVersion: "dgx-queue-read.v0",
      jobs: [],
      discardedJobLikeEntries: 1,
      queueReadable: true,
      admissionState: "local_queue_v0",
      lockLane: { state: "free", waiters: 0 },
    });
  });

  it("reports structural queue-envelope drift instead of returning an authoritative empty list", () => {
    expect(normalizeQueueJobsWithDiagnostics({
      schema_version: "dgx-queue-read.v0",
      queue: {
        ...queueAuthority,
        accepted_jobs: [],
        active_jobs: { job_id: "not-an-array" },
        cooling_jobs: [],
        queued_jobs: [],
      },
    })).toEqual({
      schemaVersion: "dgx-queue-read.v0",
      jobs: [],
      discardedJobLikeEntries: 1,
      queueReadable: true,
      admissionState: "local_queue_v0",
      lockLane: { state: "free", waiters: 0 },
    });
    const missingContract = normalizeQueueJobsWithDiagnostics({
      schema_version: "dgx-queue-read.v0",
      queue: {},
    });
    expect(missingContract.jobs).toEqual([]);
    expect(missingContract.discardedJobLikeEntries).toBeGreaterThan(0);
    expect(missingContract.discardedCoolingEntries).toBe(1);
  });

  it("fails closed on schema drift and rejects the former root-jobs fallback", () => {
    const emptyQueue = {
      ...queueAuthority,
      accepted_jobs: [],
      active_jobs: [],
      cooling_jobs: [],
      queued_jobs: [],
    };
    expect(normalizeQueueJobsWithDiagnostics({
      schema_version: "dgx-queue-read.v1",
      queue: emptyQueue,
    })).toEqual({
      jobs: [],
      discardedJobLikeEntries: 1,
      queueReadable: true,
      admissionState: "local_queue_v0",
      lockLane: { state: "free", waiters: 0 },
    });
    expect(normalizeQueueJobsWithDiagnostics({
      schema_version: "dgx-queue-read.v0",
      jobs: [],
    })).toEqual({ jobs: [], discardedJobLikeEntries: 1 });
    expect(() => normalizeQueueJobs({
      schema_version: "dgx-queue-read.v1",
      queue: emptyQueue,
    })).toThrow("nicht normalisierbare Jobzustände");
  });

  it("diagnoses bucket/state contradictions, missing owners and duplicate job ids", () => {
    const invalid = normalizeQueueJobsWithDiagnostics({
      schema_version: "dgx-queue-read.v0",
      queue: {
        ...queueAuthority,
        accepted_jobs: [{
          ...queueJob(
            "dgx-job-20260827-080000-000000000005",
            "accepted",
            "ltx-studio:wrong-bucket",
          ),
          state: "completed",
        }],
        active_jobs: [{
          ...queueJob(
            "dgx-job-20260827-080000-000000000006",
            "running",
            "ltx-studio:missing-owner",
          ),
          job_id: "dgx-job-20260827-080000-000000000006",
          state: "running",
          requested_by: undefined,
        }, {
          ...queueJob(
            "dgx-job-20260827-080000-000000000007",
            "running",
            "ltx-studio:duplicate",
          ),
        }],
        cooling_jobs: [{
          job_id: "dgx-job-20260827-080000-000000000007",
          state: "cooling",
          requested_by: "ltx-studio:duplicate",
        }],
        queued_jobs: [{
          ...queueJob(
            "dgx-job-20260827-080000-000000000008",
            "queued",
            "ltx-studio:padded-owner",
          ),
          requested_by: " ltx-studio:padded-owner ",
        }],
      },
    });

    expect(invalid).toEqual({
      schemaVersion: "dgx-queue-read.v0",
      jobs: [expect.objectContaining({
        job_id: "dgx-job-20260827-080000-000000000007",
        state: "running",
      })],
      discardedJobLikeEntries: 3,
      discardedCoolingEntries: 1,
      queueReadable: true,
      admissionState: "local_queue_v0",
      lockLane: { state: "free", waiters: 0 },
    });
  });
});
