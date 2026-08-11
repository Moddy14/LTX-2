import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildRefinerAudioArgs,
  describeLipForcingFailure,
  isActiveJobStatus,
  frameProcessLogChunk,
  JobConflictError,
  JobManager,
  MAX_ACTIVE_JOBS,
  PipelineProgressTracker,
  progressFromPipelineLog,
  publishedOutputIsReusableLtxBase,
  runProvenanceSharesLtxBase,
  requestsShareLtxBase,
  resolveRenderOutputPaths,
} from "../server/jobs.js";
import { hybridRoot, repoRoot } from "../server/config.js";
import { notApplicableIdentityEvidence } from "../server/inputEvidence.js";
import type { RunProvenance } from "../shared/provenance.js";
import {
  recommendedModelAsset,
  recommendedModelAssets,
  type ModelInventory,
} from "../shared/models.js";
import { RuntimeApiError } from "../server/runtimeApi.js";
import { projectValueSha256 } from "../server/projectStore.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

function verifiedModelInventory(): ModelInventory {
  return {
    roots: [],
    scannedAt: new Date(0).toISOString(),
    truncated: false,
    errors: [],
    items: [],
    recommendations: recommendedModelAssets.map((asset) => ({
      ...asset,
      present: true,
      integrity: "verified" as const,
    })),
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-jobs-"));
  roots.push(root);
  return join(root, "jobs.json");
}

function runProvenance(
  overrides: {
    modelSha?: string;
    runtimeSha?: string;
    codeSha?: string;
    verified?: boolean;
    includeLongCat?: boolean;
    includeFinalMix?: boolean;
  } = {},
): RunProvenance {
  const file = (role: string, sha256: string) => ({
    role,
    path: `/evidence/${role.replaceAll(":", "-")}`,
    kind: "file" as const,
    sizeBytes: 1,
    modifiedAtMs: 1,
    changedAtMs: 1,
    fileId: "1",
    sha256,
    entries: [],
  });
  return {
    schemaVersion: "ltx-studio-run-provenance.v1",
    capturedAt: "2026-07-25T00:00:00.000Z",
    verifiedAt: overrides.verified === false ? null : "2026-07-25T00:01:00.000Z",
    files: [
      file("model:checkpoint:1", overrides.modelSha ?? "a".repeat(64)),
      ...(overrides.includeLongCat ? [file("code:longcat-adapter", "d".repeat(64))] : []),
      ...(overrides.includeFinalMix ? [file("input:final-audio-mix", "e".repeat(64))] : []),
    ],
    code: [{
      repositoryRoot: repoRoot,
      commit: "a".repeat(40),
      dirty: false,
      trackedDiffSha256: "b".repeat(64),
      untracked: [],
      fingerprint: overrides.codeSha ?? "c".repeat(64),
    }],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "test",
      nodeVersion: "test",
      pythonExecutable: "/python",
      pythonVersion: "test",
      packages: {},
      ffmpegVersion: "test",
      fingerprint: overrides.runtimeSha ?? "f".repeat(64),
    },
    fingerprint: "0".repeat(64),
  };
}

const testRunProvenanceOperations = {
  capture: async () => runProvenance(),
  verify: async (evidence: RunProvenance) => ({ evidence, error: null }),
};

describe("job persistence and reservations", () => {
  it("heartbeats an active DGX owner and claims progress only once per real Euler advance", async () => {
    vi.useFakeTimers();
    try {
      const heartbeats: Array<{ jobId: string; payload: Record<string, unknown> }> = [];
      let failNextHeartbeat = false;
      const manager = new JobManager(await statePath(), false, null, undefined, {
        read: async (jobId) => ({
          schema_version: "dgx-job-read.v0",
          job: { job_id: jobId, state: "running" },
        }),
        transition: async (jobId, state) => ({
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        }),
        heartbeat: async (jobId, payload) => {
          heartbeats.push({ jobId, payload });
          if (failNextHeartbeat) {
            failNextHeartbeat = false;
            throw new Error("synthetic heartbeat outage");
          }
          return {
            schema_version: "dgx-job-heartbeat.v0",
            job: { job_id: jobId, state: "running" },
          };
        },
      }, null);
      const created = manager.create(validRequest());
      const active = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
      active.status = "running";
      active.dgxJobId = "dgx-job-heartbeat-test";

      const startHeartbeat = Reflect.get(manager, "startDgxOwnerHeartbeat") as (
        job: unknown,
        phase: string,
      ) => void;
      const markProgress = Reflect.get(manager, "markDgxOwnerProgress") as (job: unknown) => void;
      const stopHeartbeat = Reflect.get(manager, "stopDgxOwnerHeartbeat") as (job: unknown) => Promise<void>;

      startHeartbeat.call(manager, active, "ltx_rendering");
      await vi.advanceTimersByTimeAsync(0);
      expect(heartbeats).toEqual([{
        jobId: "dgx-job-heartbeat-test",
        payload: { runtime_status: { phase: "ltx_rendering" } },
      }]);

      markProgress.call(manager, active);
      failNextHeartbeat = true;
      await vi.advanceTimersByTimeAsync(45_000);
      expect(heartbeats.at(-1)?.payload).toEqual({
        runtime_status: { phase: "ltx_rendering" },
        progressed: true,
      });

      await vi.advanceTimersByTimeAsync(45_000);
      expect(heartbeats.at(-1)?.payload).toEqual({
        runtime_status: { phase: "ltx_rendering" },
        progressed: true,
      });

      await vi.advanceTimersByTimeAsync(45_000);
      expect(heartbeats.at(-1)?.payload).toEqual({
        runtime_status: { phase: "ltx_rendering" },
      });

      await stopHeartbeat.call(manager, active);
      const stoppedAt = heartbeats.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(heartbeats).toHaveLength(stoppedAt);
    } finally {
      vi.useRealTimers();
    }
  });

  it("builds one exact audio window contract for every optional lip refiner", () => {
    const request = validRequest();
    request.mode = "image-audio-to-video";
    request.audio.path = "/inputs/clean.flac";
    request.audio.startTime = 1.25;
    request.audio.maxDuration = 3.5;
    expect(buildRefinerAudioArgs(request)).toEqual([
      "--audio", "/inputs/clean.flac",
      "--audio-start", "1.25",
      "--audio-duration", "3.5",
    ]);
    request.audio.maxDuration = null;
    expect(buildRefinerAudioArgs(request)).toEqual([
      "--audio", "/inputs/clean.flac",
      "--audio-start", "1.25",
    ]);
    request.audio.path = "";
    expect(buildRefinerAudioArgs(request)).toEqual([]);

    // The ID-LoRA reference audio is a voice-cloning sample, never the spoken
    // content: the native speech stack renders the dialogue into the base
    // video, so the refiner must sync against the base video's own track.
    request.mode = "id-lora";
    request.idLora.referenceAudio = {
      path: "/inputs/id-reference.flac",
      name: "id-reference.flac",
    };
    expect(buildRefinerAudioArgs(request)).toEqual([]);

    request.mode = "lipdub";
    request.lipDub.referenceVideo = {
      path: "/inputs/lipdub-reference.mp4",
      name: "lipdub-reference.mp4",
      strength: 1,
    };
    expect(buildRefinerAudioArgs(request)).toEqual([
      "--audio", "/inputs/lipdub-reference.mp4",
      "--audio-start", "0",
    ]);

    request.mode = "two-stage";
    request.audio.path = "/inputs/stale-form-value.flac";
    expect(buildRefinerAudioArgs(request)).toEqual([]);
  });

  it("explains a LipForcing unified-memory failure without a cryptic exit code", () => {
    expect(describeLipForcingFailure(
      [
        "Loading SF checkpoint from /models/lipforcing/lipforcing_14b.pth ...",
        "torch.AcceleratorError: CUDA error: out of memory",
        "LipForcing: Fehler: LipForcing-Container endete mit Code 1.",
      ],
      { code: 1, signal: null, error: null },
    )).toContain("gemeinsamen CPU-/GPU-Speicher");
  });

  it("reuses an LTX base only when generation settings are otherwise identical", () => {
    const original = validRequest();
    const hybrid = structuredClone(original);
    hybrid.outputName = "hybrid.mp4";
    hybrid.postprocess.longcatLipsync.enabled = true;
    hybrid.postprocess.longcatLipsync.blend = 0.55;
    hybrid.continuity.notes = "Refiner-Vergleich mit identischer LTX-Basis.";

    expect(requestsShareLtxBase(original, hybrid)).toBe(true);
    hybrid.audio.finalMix = { path: "/inputs/final-mix.wav", name: "final-mix.wav" };
    expect(requestsShareLtxBase(original, hybrid)).toBe(true);
    expect(publishedOutputIsReusableLtxBase(hybrid, original)).toBe(false);
    expect(publishedOutputIsReusableLtxBase(original, hybrid)).toBe(true);
    hybrid.seed += 1;
    expect(requestsShareLtxBase(original, hybrid)).toBe(false);
  });

  it("reuses a rendered LTX base with matching verified model and runtime provenance", () => {
    const baseline = runProvenance();
    expect(runProvenanceSharesLtxBase(
      runProvenance({ includeFinalMix: true }),
      runProvenance({ includeLongCat: true }),
    )).toBe(true);
    expect(runProvenanceSharesLtxBase(baseline, runProvenance({ modelSha: "1".repeat(64) }))).toBe(false);
    expect(runProvenanceSharesLtxBase(baseline, runProvenance({ codeSha: "2".repeat(64) }))).toBe(true);
    expect(runProvenanceSharesLtxBase(baseline, runProvenance({ runtimeSha: "3".repeat(64) }))).toBe(false);
    expect(runProvenanceSharesLtxBase(baseline, runProvenance({ verified: false }))).toBe(true);
    expect(runProvenanceSharesLtxBase(runProvenance({ verified: false }), baseline)).toBe(false);
    expect(runProvenanceSharesLtxBase(null, baseline)).toBe(false);
  });

  it("keeps every pre-remux video outside the public output path", () => {
    const finalOutput = "/outputs/final.mp4";
    const stageRoot = "/staging/job";

    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      refinedOutput: "/staging/job/latentsync-refined.mp4",
      remuxInput: "/staging/job/ltx-base.mp4",
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, true, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      refinedOutput: "/staging/job/latentsync-refined.mp4",
      remuxInput: "/staging/job/longcat-composite.mp4",
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, false, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      refinedOutput: finalOutput,
      remuxInput: finalOutput,
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, true, false, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      refinedOutput: "/staging/job/musetalk-refined.mp4",
      remuxInput: "/staging/job/musetalk-refined.mp4",
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, false).ltxOutput).toBe(finalOutput);
  });

  it("treats thermally paused jobs as active", () => {
    expect(isActiveJobStatus("paused")).toBe(true);
  });

  it("restores a purely local queued job without inventing an interruption", async () => {
    const path = await statePath();
    const request = validRequest();
    const id = "00000000-0000-4000-8000-000000000099";
    await writeFile(path, JSON.stringify([{
      id,
      status: "queued",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      logs: ["waiting locally"],
      command: "ignored",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: null,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: null,
      identityEvidence: null,
      runProvenance: null,
    }]));

    const restored = new JobManager(path, false);

    expect(restored.get(id)).toMatchObject({
      status: "queued",
      dgxJobId: null,
      error: null,
    });
    expect(restored.get(id)?.logs.at(-1)).toContain("automatisch fortgesetzt");
    expect(Reflect.get(restored, "queue")).toEqual([id]);
  });

  it("resumes a resource-free paused slice with the same orchestrator job id", async () => {
    const transitions: Array<{ jobId: string; state: string }> = [];
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: "paused" },
      }),
      transition: async (jobId, state) => {
        transitions.push({ jobId, state });
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    });
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      status: string;
      dgxJobId: string | null;
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.status = "running";
    runtimeJob.dgxJobId = "dgx-job-old-slice";
    Reflect.set(manager, "waitForSchedulerResume", async () => true);
    const pauseAndResume = Reflect.get(manager, "pauseAndResumeDgxSlice") as (
      job: unknown,
      artifact: { type: string; path: string },
    ) => Promise<boolean>;

    expect(await pauseAndResume.call(manager, runtimeJob, {
      type: "ltx-cooperative-checkpoint",
      path: "/checkpoints/job/manifest.json",
    })).toBe(true);
    expect(transitions).toEqual([
      { jobId: "dgx-job-old-slice", state: "pausing" },
      { jobId: "dgx-job-old-slice", state: "paused" },
      { jobId: "dgx-job-old-slice", state: "resuming" },
    ]);
    expect(runtimeJob.dgxJobId).toBe("dgx-job-old-slice");
  });

  it("requests a fresh canonical decision for every Euler boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-boundary-watcher-"));
    roots.push(root);
    const transitions: string[] = [];
    const decide = vi.fn()
      .mockResolvedValueOnce({
        action: "continue_current",
        current_job_id: "dgx-job-boundary",
        next_job_id: null,
        reason: "no_waiting_job",
        retry_after_seconds: 5,
      })
      .mockResolvedValueOnce({
        action: "yield_to_waiting_job",
        current_job_id: "dgx-job-boundary",
        next_job_id: "dgx-job-waiter",
        reason: "selected_waiter",
        retry_after_seconds: 5,
      });
    const manager = new JobManager(join(root, "jobs.json"), false, null, undefined, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: "running" },
      }),
      transition: async (jobId, state) => {
        transitions.push(state);
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null, undefined, undefined, { decide });
    const created = manager.create(validRequest());
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    runtimeJob.status = "running";
    runtimeJob.dgxJobId = "dgx-job-boundary";
    runtimeJob.runProvenance = runProvenance();
    const child = spawn("/usr/bin/python3", ["-c", "import time; time.sleep(30)"], {
      detached: true,
      stdio: "ignore",
    });
    runtimeJob.process = child;
    const checkpointRoot = join(root, "checkpoint");
    await mkdir(checkpointRoot, { recursive: true });
    const watch = Reflect.get(manager, "watchSegmentBoundaries") as (
      job: unknown,
      path: string,
      fingerprint: string,
      generation: number,
    ) => { stop: () => Promise<void> };
    const watcher = watch.call(
      manager,
      runtimeJob,
      checkpointRoot,
      (runtimeJob.runProvenance as RunProvenance).fingerprint,
      0,
    );
    const decisionPath = join(checkpointRoot, "boundary-decision.json");
    const readyPath = join(checkpointRoot, "boundary-ready.json");
    const waitForDecision = async (): Promise<Record<string, unknown>> => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          return JSON.parse(await readFile(decisionPath, "utf8")) as Record<string, unknown>;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      throw new Error("segment decision was not written");
    };
    try {
      await writeFile(readyPath, JSON.stringify({
        schema_version: "ltx-segment-boundary-ready.v1",
        job_fingerprint: (runtimeJob.runProvenance as RunProvenance).fingerprint,
        dgx_job_id: "dgx-job-boundary",
        generation: 0,
        boundary_id: "0:0:1",
        loop_index: 0,
        next_step_index: 1,
      }));
      await expect(waitForDecision()).resolves.toMatchObject({
        boundary_id: "0:0:1",
        action: "continue_current",
      });
      await rm(readyPath, { force: true });
      await rm(decisionPath, { force: true });

      await writeFile(readyPath, JSON.stringify({
        schema_version: "ltx-segment-boundary-ready.v1",
        job_fingerprint: (runtimeJob.runProvenance as RunProvenance).fingerprint,
        dgx_job_id: "dgx-job-boundary",
        generation: 0,
        boundary_id: "0:0:2",
        loop_index: 0,
        next_step_index: 2,
      }));
      await expect(waitForDecision()).resolves.toMatchObject({
        boundary_id: "0:0:2",
        action: "yield_to_waiting_job",
      });
      expect(decide).toHaveBeenCalledTimes(2);
      expect(transitions).toEqual(["pausing"]);
    } finally {
      await watcher.stop();
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Process already ended.
        }
      }
    }
  });

  it("accepts only a complete checkpoint bound to the current run provenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-checkpoint-"));
    roots.push(root);
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      runProvenance: RunProvenance | null;
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.runProvenance = runProvenance();
    await writeFile(join(root, "state.pt"), "state");
    await writeFile(join(root, "manifest.json"), JSON.stringify({
      schema_version: "ltx-cooperative-checkpoint.v1",
      job_fingerprint: runtimeJob.runProvenance.fingerprint,
      request_id: "yield-1",
      state_file: "state.pt",
      loop_index: 0,
      next_step_index: 4,
    }));
    const validate = Reflect.get(manager, "validateCooperativeCheckpoint") as (
      job: unknown,
      manifestPath: string,
      requestId: string,
    ) => { type: string } | null;

    expect(validate.call(manager, runtimeJob, join(root, "manifest.json"), "yield-1")).toMatchObject({
      type: "ltx-cooperative-checkpoint",
    });
    expect(validate.call(manager, runtimeJob, join(root, "manifest.json"), "different")).toBeNull();
  });

  it("recognizes only complete tqdm records", () => {
    expect(progressFromPipelineLog(" 87%|########7 | 26/30")).toBe(87);
    expect(progressFromPipelineLog("100%|##########| 30/30")).toBe(100);
    expect(progressFromPipelineLog("GPU-Speicher 90% belegt")).toBeNull();
    expect(progressFromPipelineLog("Checkpoint 42% geladen")).toBeNull();
    expect(progressFromPipelineLog("Transformer geladen")).toBeNull();
  });

  it("frames carriage-return tqdm streams across arbitrary chunks", () => {
    const first = frameProcessLogChunk("", "  7%|#");
    expect(first.records).toEqual([]);
    const second = frameProcessLogChunk(
      first.rest,
      "      | 2/30\r 10%|##        | 3/30\rGPU-Speicher 90%",
    );
    expect(second.records).toEqual([
      "  7%|#      | 2/30",
      " 10%|##        | 3/30",
    ]);
    expect(frameProcessLogChunk(second.rest, "", true)).toEqual({
      records: ["GPU-Speicher 90%"],
      rest: "",
    });
  });

  it("maps multiple pipeline phases monotonically below final completion", () => {
    const tracker = new PipelineProgressTracker(0, 95, 2);
    const values = [
      tracker.update("INFO: Building text encoder from /models/gemma"),
      tracker.update("INFO: Prompt encoding complete"),
      tracker.update("INFO: Running denoising loop (30 steps, 256x256 97 frames @ 24 fps)"),
      tracker.update("100%|##########| 30/30"),
      tracker.update("INFO: Running denoising loop (3 steps, 512x512 97 frames @ 24 fps)"),
      tracker.update(" 33%|###3      | 1/3"),
      tracker.update("INFO: Building video decoder from /models/checkpoint"),
      tracker.update("100%|##########| 2/2"),
      tracker.update("INFO: Video saved to /outputs/test.mp4"),
    ].filter((value): value is number => value !== null);

    expect(values).toEqual([...values].sort((left, right) => left - right));
    expect(values.at(-1)).toBe(95);
    expect(values).not.toContain(100);
  });

  it("rejects two active jobs reserving the same output", async () => {
    const manager = new JobManager(await statePath(), false);
    const request = validRequest();
    manager.create(request);
    expect(() => manager.create(structuredClone(request))).toThrow(JobConflictError);
  });

  it("records queued cancellation as a manual Studio action", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const cancelled = manager.cancel(created.id)!;

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.cancelledBy).toBe("studio");
    expect(cancelled.logs.at(-1)).toContain("Studio-Abbruchfunktion");
  });

  it("removes only terminal jobs and persists the shortened history", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());

    expect(() => manager.remove(created.id)).toThrow("noch aktiv");
    expect(manager.get(created.id)).toBeDefined();

    manager.cancel(created.id);
    const deleted = manager.remove(created.id);

    expect(deleted).toMatchObject({ id: created.id, status: "cancelled" });
    expect(manager.get(created.id)).toBeUndefined();
    expect(manager.list()).toEqual([]);
    expect(new JobManager(path, false).list()).toEqual([]);
  });

  it("stops the complete process group before releasing its lease during shutdown", async () => {
    const path = await statePath();
    const root = join(path, "..");
    const readyPath = join(root, "parent.ready");
    const childReadyPath = join(root, "child.ready");
    const transitions: string[] = [];
    let processGroupId = 0;
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (remoteJobId) => {
        expect(() => process.kill(-processGroupId, 0)).toThrow();
        transitions.push("read-after-local-exit");
        return {
          schema_version: "dgx-job-read.v0",
          job: { job_id: remoteJobId, state: "running" },
        };
      },
      transition: async (remoteJobId, state) => {
        transitions.push(state);
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: remoteJobId, state },
        };
      },
    }, null);
    const first = manager.create(validRequest());
    const secondRequest = validRequest();
    secondRequest.outputName = "shutdown-preserved.mp4";
    const second = manager.create(secondRequest);
    const child = spawn("/usr/bin/python3", ["-c", [
      "import pathlib,signal,subprocess,sys,time",
      `child_ready=${JSON.stringify(childReadyPath)}`,
      "code='import pathlib,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        + `pathlib.Path(${JSON.stringify(childReadyPath)}).write_text("ready"); time.sleep(30)'`,
      "subprocess.Popen([sys.executable,'-c',code],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True)",
      "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
      "for _ in range(200):",
      "    if pathlib.Path(child_ready).exists(): break",
      "    time.sleep(0.01)",
      `pathlib.Path(${JSON.stringify(readyPath)}).write_text("ready")`,
      "time.sleep(30)",
    ].join("\n")], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Test-Prozessgruppe konnte nicht gestartet werden.");
    processGroupId = child.pid;
    try {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
          await readFile(readyPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
      const active = internalJobs.get(first.id)!;
      active.status = "running";
      active.startedAt = new Date().toISOString();
      active.dgxJobId = "dgx-job-shutdown-order";
      active.process = child;
      Reflect.set(manager, "runningId", first.id);

      const report = await manager.shutdown(2_000);

      expect(report).toMatchObject({
        queuedPreserved: 1,
        localGroupsStopped: 1,
        remoteConfirmed: 1,
        remotePending: 0,
      });
      expect(transitions).toEqual(["read-after-local-exit", "cancelled"]);
      expect(manager.get(first.id)).toMatchObject({
        status: "interrupted",
        cancelledBy: null,
      });
      expect(manager.get(second.id)?.status).toBe("queued");
      expect(() => manager.create(validRequest())).toThrow("nimmt keine neuen Aufträge");

      const restored = new JobManager(path, false);
      expect(restored.get(second.id)?.status).toBe("queued");
    } finally {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The shutdown path should already have removed the complete group.
      }
    }
  }, 10_000);

  it("preserves the queue item already pulled by the pump when no remote or local process exists", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const created = manager.create(validRequest());
    const queue = Reflect.get(manager, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    Reflect.set(manager, "runningId", created.id);
    Reflect.set(manager, "activeRunPromise", Promise.resolve());

    const report = await manager.shutdown(250);

    expect(report).toMatchObject({ queuedPreserved: 1, remotePending: 0 });
    expect(manager.get(created.id)?.status).toBe("queued");
    const restored = new JobManager(path, false);
    expect(restored.get(created.id)?.status).toBe("queued");
    expect(Reflect.get(restored, "queue")).toContain(created.id);
  });

  it("does not spawn LTX after shutdown wins the thermal-baseline race", async () => {
    const path = await statePath();
    const marker = join(path, "..", "spawned-after-shutdown");
    const executable = join(path, "..", "spawn-marker.sh");
    await writeFile(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(executable, 0o755);
    let releaseBaseline!: () => void;
    let baselineStartedResolve!: () => void;
    const baselineStarted = new Promise<void>((resolve) => {
      baselineStartedResolve = resolve;
    });
    const baselineGate = new Promise<void>((resolve) => {
      releaseBaseline = resolve;
    });
    const manager = new JobManager(
      path,
      false,
      null,
      {
        capture: async () => notApplicableIdentityEvidence(),
        verify: async (evidence) => ({ evidence, error: null }),
      },
      undefined,
      null,
      undefined,
      {
        capture: async () => runProvenance(),
        verify: async (evidence) => ({ evidence, error: null }),
      },
    );
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      plan: { executable: string; outputPath: string; requiredPaths: unknown[] };
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.plan.requiredPaths = [];
    runtimeJob.plan.outputPath = join(path, "..", "thermal-race-output.mp4");
    Reflect.set(manager, "waitForDgxQueueStart", async () => true);
    Reflect.set(manager, "verifyJobIdentityEvidence", async () => true);
    Reflect.set(manager, "verifyJobRunProvenance", async () => true);
    Reflect.set(manager, "modelInventoryOperations", {
      read: async () => verifiedModelInventory(),
    });
    Reflect.set(manager, "readThermalBaseline", async () => {
      runtimeJob.plan.executable = executable;
      baselineStartedResolve();
      await baselineGate;
      return 50;
    });
    const queue = Reflect.get(manager, "queue") as string[];
    queue.splice(queue.indexOf(created.id), 1);
    Reflect.set(manager, "runningId", created.id);
    const run = Reflect.get(manager, "run") as (job: unknown) => Promise<void>;
    const running = run.call(manager, runtimeJob);
    Reflect.set(manager, "activeRunPromise", running);
    await baselineStarted;

    const shutdown = manager.shutdown(500);
    releaseBaseline();
    const report = await shutdown;
    await running;

    expect(report.queuedPreserved).toBe(1);
    expect(manager.get(created.id)?.status).toBe("queued");
    await expect(access(marker)).rejects.toThrow();
  });

  it("never releases a remote lease while local process-group exit remains unproven", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async () => {
        throw new Error("remote read must remain fenced");
      },
      transition: async () => {
        throw new Error("remote transition must remain fenced");
      },
    }, null);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, Record<string, unknown>>;
    const active = internalJobs.get(created.id)!;
    active.status = "running";
    active.dgxJobId = "dgx-job-unproven-local-group";
    active.localProcessGroupPending = true;
    Reflect.set(manager, "runningId", created.id);

    const report = await manager.shutdown(250);

    expect(report).toMatchObject({
      localGroupsStopped: 0,
      remoteConfirmed: 0,
      remotePending: 1,
    });
    const restored = new JobManager(path, false, null, undefined, undefined, null);
    expect(Reflect.get(restored, "jobs").get(created.id)).toMatchObject({
      localProcessGroupPending: true,
      dgxTerminalDelivery: { state: "cancelled" },
    });
  });

  it("reconciles a persisted process group after restart without risking PID-reuse signalling", async () => {
    const path = await statePath();
    const first = new JobManager(path, false);
    const created = first.create(validRequest());
    const internalJobs = Reflect.get(first, "jobs") as Map<string, Record<string, unknown>>;
    const active = internalJobs.get(created.id)!;
    const child = spawn("/usr/bin/python3", ["-c", "import time; time.sleep(30)"], {
      detached: true,
      stdio: "ignore",
    });
    if (!child.pid) throw new Error("Recovery-Testprozess besitzt keine PID.");
    const processGroupId = child.pid;
    try {
      active.status = "interrupted";
      active.dgxJobId = "dgx-job-restart-process-group";
      const markProcessStarted = Reflect.get(first, "markProcessStarted") as (
        job: unknown,
        process: ReturnType<typeof spawn>,
      ) => Promise<void>;
      await markProcessStarted.call(first, active, child);
      const prepareTerminal = Reflect.get(first, "prepareDgxTerminalDelivery") as (
        job: unknown,
        state: string,
        metadata: Record<string, string>,
      ) => void;
      prepareTerminal.call(first, active, "cancelled", {
        current_step: "synthetic restart recovery",
      });
      (Reflect.get(first, "changed") as () => void).call(first);

      const transitions: string[] = [];
      const restored = new JobManager(path, false, null, undefined, {
        read: async (jobId) => ({
          schema_version: "dgx-job-read.v0",
          job: { job_id: jobId, state: "running" },
        }),
        transition: async (jobId, state) => {
          transitions.push(state);
          return {
            schema_version: "dgx-job-transition.v0",
            job: { job_id: jobId, state },
          };
        },
      }, null);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(transitions).toEqual([]);

      process.kill(-processGroupId, "SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      for (let attempt = 0; attempt < 300 && transitions.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      expect(transitions).toEqual(["cancelled"]);
      const recovered = Reflect.get(restored, "jobs").get(created.id);
      expect(recovered.localProcessGroupPending).toBeUndefined();
      expect(recovered.localProcessGroupIdentity).toBeUndefined();
      expect(recovered.dgxJobTerminal).toBe(true);
    } finally {
      try {
        process.kill(-processGroupId, "SIGKILL");
      } catch {
        // The test intentionally removes the old process group before reconciliation.
      }
    }
  }, 10_000);

  it("treats a same-boot PGID with different leader start ticks as safe reuse", async () => {
    const path = await statePath();
    const first = new JobManager(path, false);
    const created = first.create(validRequest());
    const active = (Reflect.get(first, "jobs") as Map<string, Record<string, unknown>>).get(created.id)!;
    active.status = "interrupted";
    active.dgxJobId = "dgx-job-reused-process-group";
    active.localProcessGroupPending = true;
    active.localProcessGroupIdentity = {
      bootId: (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      processGroupId: process.pid,
      leaderStartTicks: "0",
    };
    const prepareTerminal = Reflect.get(first, "prepareDgxTerminalDelivery") as (
      job: unknown,
      state: string,
      metadata: Record<string, string>,
    ) => void;
    prepareTerminal.call(first, active, "cancelled", {
      current_step: "synthetic PGID reuse recovery",
    });
    (Reflect.get(first, "changed") as () => void).call(first);

    const transitions: string[] = [];
    const restored = new JobManager(path, false, null, undefined, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: "running" },
      }),
      transition: async (jobId, state) => {
        transitions.push(state);
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null);
    for (let attempt = 0; attempt < 100 && transitions.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(transitions).toEqual(["cancelled"]);
    const recovered = Reflect.get(restored, "jobs").get(created.id);
    expect(recovered.localProcessGroupPending).toBeUndefined();
    expect(recovered.dgxJobTerminal).toBe(true);
  });

  it("persists an ambiguous in-flight submit and terminalizes a late acceptance", async () => {
    const path = await statePath();
    let submitStartedResolve!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      submitStartedResolve = resolve;
    });
    let releaseSubmitResolve!: () => void;
    const releaseSubmit = new Promise<void>((resolve) => {
      releaseSubmitResolve = resolve;
    });
    const transitions: string[] = [];
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: "accepted" },
      }),
      transition: async (jobId, state) => {
        transitions.push(state);
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null, {
      submit: async () => {
        submitStartedResolve();
        await releaseSubmit;
        return {
          schema_version: "dgx-queue-submit.v0",
          job: { job_id: "dgx-submit-after-shutdown-deadline", state: "accepted" },
          admission: { decision: "accepted" },
        };
      },
    });
    const created = manager.create(validRequest());
    const runtimeJob = (Reflect.get(manager, "jobs") as Map<string, unknown>).get(created.id)!;
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;
    const waiting = waitForDgxQueueStart.call(manager, runtimeJob);
    Reflect.set(manager, "runningId", created.id);
    Reflect.set(manager, "activeRunPromise", waiting.then(() => undefined));
    await submitStarted;

    const report = await manager.shutdown(25);
    const persisted = JSON.parse(await readFile(path, "utf8")) as Array<Record<string, unknown>>;
    expect(report).toMatchObject({ queuedPreserved: 1, remotePending: 1 });
    expect(persisted[0]).toMatchObject({
      id: created.id,
      status: "queued",
      dgxSubmitPending: true,
    });

    releaseSubmitResolve();
    expect(await waiting).toBe(false);
    expect(transitions).toEqual(["cancelled"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "interrupted",
      dgxJobId: "dgx-submit-after-shutdown-deadline",
    });
  });

  it("allows the orchestrator to see a job before the local swap start gate is met", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 80,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 0.25,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));

    const waitForPreAdmission = Reflect.get(manager, "waitForLocalPreAdmissionResources") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await waitForPreAdmission.call(manager, runtimeJob)).toBe(true);
    expect(manager.get(created.id)?.logs).toEqual(expect.arrayContaining([
      expect.stringContaining("Queue-Vorab-Gate erfüllt"),
      expect.stringContaining("vom DGX-Orchestrator entschieden"),
    ]));
  });

  it("submits a low-swap job so the orchestrator can make the start decision", async () => {
    let submits = 0;
    let submittedMemoryGiB: number | undefined;
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, undefined, null, {
      submit: async (_request, estimatedMemoryGiB) => {
        submits += 1;
        submittedMemoryGiB = estimatedMemoryGiB;
        return {
          schema_version: "dgx-queue-submit.v0",
          job: { job_id: "dgx-low-swap-visible", state: "accepted" },
          admission: { decision: "accepted" },
        };
      },
    });
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 80,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 0.25,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));
    Reflect.set(manager, "startAcceptedDgxJob", async () => "started");

    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await waitForDgxQueueStart.call(manager, runtimeJob)).toBe(true);
    expect(submits).toBe(1);
    expect(submittedMemoryGiB).toBe(58);
    expect(manager.get(created.id)).toMatchObject({
      status: "queued",
      dgxJobId: "dgx-low-swap-visible",
    });
  });

  it("uses the orchestrator start fence immediately after acceptance", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-authoritative-start-fence";
    const transitions: string[] = [];
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 40,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 0.25,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));
    Reflect.set(manager, "transitionDgxJob", async (_job: unknown, state: string) => {
      transitions.push(state);
      return true;
    });

    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (job: unknown) => Promise<string>;

    expect(await startAccepted.call(manager, runtimeJob)).toBe("started");
    expect(transitions).toEqual(["starting"]);
    expect(manager.get(created.id)?.logs).toEqual(expect.arrayContaining([
      expect.stringContaining("Start-Fence wird jetzt autoritativ beim Orchestrator geprüft"),
      expect.stringContaining("40.00 GiB RAM"),
      expect.stringContaining("0.25 GiB Swap"),
    ]));
  });

  it("does not create a DGX lease after cancellation while waiting for pre-admission resources", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 80,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 8,
      swapTotalGiB: 16,
      outputFreeGiB: 0.25,
    }));
    Reflect.set(manager, "waitForDelay", async () => {
      manager.cancel(created.id);
      return false;
    });

    const waitForPreAdmission = Reflect.get(manager, "waitForLocalPreAdmissionResources") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await waitForPreAdmission.call(manager, runtimeJob)).toBe(false);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      dgxJobId: null,
    });
  });

  it("adopts and cancels a remote lease created while queue submit was in flight", async () => {
    let submitStartedResolve!: () => void;
    const submitStarted = new Promise<void>((resolve) => {
      submitStartedResolve = resolve;
    });
    let releaseSubmitResolve!: () => void;
    const releaseSubmit = new Promise<void>((resolve) => {
      releaseSubmitResolve = resolve;
    });
    const transitions: string[] = [];
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: "accepted" },
      }),
      transition: async (jobId, state) => {
        transitions.push(state);
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null, {
      submit: async () => {
        submitStartedResolve();
        await releaseSubmit;
        return {
          schema_version: "dgx-queue-submit.v0",
          job: { job_id: "dgx-submit-cancel-race", state: "accepted" },
          admission: { decision: "accepted" },
        };
      },
    });
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "waitForLocalPreAdmissionResources", async () => true);
    const waitForDgxQueueStart = Reflect.get(manager, "waitForDgxQueueStart") as (
      job: unknown,
    ) => Promise<boolean>;

    const waiting = waitForDgxQueueStart.call(manager, runtimeJob);
    await submitStarted;
    expect(manager.cancel(created.id)?.status).toBe("cancelled");
    releaseSubmitResolve();

    expect(await waiting).toBe(false);
    expect(transitions).toEqual(["cancelled"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      dgxJobId: "dgx-submit-cancel-race",
      outputUrl: null,
    });
  });

  it("retries a transient queued-job GET failure without failing the Studio job", async () => {
    let reads = 0;
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => {
        reads += 1;
        if (reads === 1) throw new Error("temporary runtime API disconnect");
        return {
          schema_version: "dgx-job-read.v0",
          job: { job_id: jobId, state: "accepted" },
        };
      },
      transition: async () => {
        throw new Error("not expected");
      },
    }, null);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-queued-transient-get";
    Reflect.set(manager, "waitForDelay", async () => true);
    Reflect.set(manager, "startAcceptedDgxJob", async () => "started");
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<string>;

    expect(await waitForQueuedDgxJob.call(manager, runtimeJob, 0)).toBe("started");
    expect(reads).toBe(2);
    expect(manager.get(created.id)).toMatchObject({
      status: "queued",
      error: null,
    });
    expect(manager.get(created.id)?.logs).toEqual(expect.arrayContaining([
      expect.stringContaining("vorübergehend nicht lesbar"),
      expect.stringContaining("temporary runtime API disconnect"),
    ]));
  });

  it("maps a failed accepted-to-starting transition to remote cancellation before compute", async () => {
    let remoteState: "accepted" | "cancelled" = "accepted";
    const transitions: string[] = [];
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: remoteState },
      }),
      transition: async (jobId, state) => {
        transitions.push(state);
        if (state === "starting") throw new Error("remote end closed connection");
        remoteState = "cancelled";
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state: remoteState },
        };
      },
    }, null);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-starting-transition-failure";
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 121,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 8,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));
    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (job: unknown) => Promise<string>;

    expect(await startAccepted.call(manager, runtimeJob)).toBe("stopped");
    expect(transitions).toEqual(["starting", "cancelled"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "failed",
      error: "DGX-Queue-Start-Fence wurde nicht freigegeben.",
      outputUrl: null,
    });
  });

  it("cannot resume a cancelled job after an asynchronous evidence hash finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-cancel-evidence-"));
    roots.push(root);
    const modelRoot = join(root, "models");
    const gemmaRoot = join(modelRoot, "gemma");
    await mkdir(gemmaRoot, { recursive: true });
    const checkpoint = join(modelRoot, "checkpoint.safetensors");
    await writeFile(checkpoint, "model");
    await writeFile(join(gemmaRoot, "preprocessor_config.json"), "{}");
    const request = validRequest("one-stage");
    request.models.checkpointPath = checkpoint;
    request.models.gemmaRoot = gemmaRoot;
    request.outputName = `cancel-evidence-${Date.now()}.mp4`;

    let enteredResolve!: () => void;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    let finishResolve!: (value: ReturnType<typeof notApplicableIdentityEvidence>) => void;
    const finish = new Promise<ReturnType<typeof notApplicableIdentityEvidence>>((resolve) => {
      finishResolve = resolve;
    });
    const manager = new JobManager(join(root, "jobs.json"), true, null, {
      capture: async () => {
        enteredResolve();
        return finish;
      },
      verify: async (evidence) => ({ evidence, error: null }),
    });
    const created = manager.create(request);
    await entered;

    manager.cancel(created.id);
    finishResolve(notApplicableIdentityEvidence());
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      cancelledBy: "studio",
      outputUrl: null,
    });
  });

  it("does not overwrite an orchestrator cancellation with failed during evidence verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-cancel-verification-"));
    roots.push(root);
    const modelRoot = join(root, "models");
    const gemmaRoot = join(modelRoot, "gemma");
    const checkpoint = join(modelRoot, "checkpoint.safetensors");
    await mkdir(gemmaRoot, { recursive: true });
    await writeFile(checkpoint, "model");
    await writeFile(join(gemmaRoot, "preprocessor_config.json"), "{}");
    const request = validRequest("one-stage");
    request.models.checkpointPath = checkpoint;
    request.models.gemmaRoot = gemmaRoot;
    request.outputName = `cancel-verification-${Date.now()}.mp4`;

    let verificationStartedResolve!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      verificationStartedResolve = resolve;
    });
    let finishVerificationResolve!: () => void;
    const finishVerification = new Promise<void>((resolve) => {
      finishVerificationResolve = resolve;
    });
    const transitions: string[] = [];
    const manager = new JobManager(join(root, "jobs.json"), true, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => {
        verificationStartedResolve();
        await finishVerification;
        return { evidence, error: null };
      },
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: "running" },
      }),
      transition: async (jobId, state) => {
        transitions.push(state);
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null, undefined, testRunProvenanceOperations);
    Reflect.set(manager, "waitForDgxQueueStart", async (job: { dgxJobId: string | null }) => {
      job.dgxJobId = "dgx-job-cancel-verification";
      return true;
    });
    const created = manager.create(request);
    await verificationStarted;

    manager.cancel(created.id);
    finishVerificationResolve();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(manager.get(created.id)?.status).toBe("cancelled");
    expect(transitions).toContain("cancelled");
    expect(transitions).not.toContain("failed");
  });

  it("keeps the DGX job running through final audio and identity verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-queue-finalization-"));
    roots.push(root);
    const request = validRequest("audio-to-video");
    request.models.checkpointPath = recommendedModelAsset("ltx23-dev-checkpoint").localPath;
    request.models.gemmaRoot = recommendedModelAsset("ltx23-gemma").localPath;
    request.models.distilledLora.path = recommendedModelAsset("ltx23-distilled-lora").localPath;
    request.models.spatialUpscalerPath = recommendedModelAsset("ltx23-spatial-upscaler").localPath;
    request.audio.finalMix = {
      path: join(root, "final-mix.wav"),
      name: "final-mix.wav",
    };
    request.outputName = `queue-finalization-${Date.now()}.mp4`;
    const finalOutput = join(root, request.outputName);
    const events: string[] = [];
    let verificationCount = 0;
    let completedTransitionStartedResolve!: () => void;
    const completedTransitionStarted = new Promise<void>((resolve) => {
      completedTransitionStartedResolve = resolve;
    });
    let releaseCompletedTransitionResolve!: () => void;
    const releaseCompletedTransition = new Promise<void>((resolve) => {
      releaseCompletedTransitionResolve = resolve;
    });
    let createdId = "";
    let remoteState: "starting" | "running" | "completed" = "starting";
    const manager = new JobManager(join(root, "jobs.json"), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => {
        verificationCount += 1;
        events.push(verificationCount === 1 ? "pre-identity" : "final-identity");
        return { evidence, error: null };
      },
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: remoteState },
      }),
      transition: async (jobId, state) => {
        if (state === "completed") {
          expect(events.at(-1)).toBe("final-identity");
          expect(await readFile(finalOutput, "utf8")).toBe("final-video");
          expect(manager.get(createdId)?.status).toBe("completed");
          completedTransitionStartedResolve();
          await releaseCompletedTransition;
        }
        remoteState = state as typeof remoteState;
        events.push(state);
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null, undefined, testRunProvenanceOperations);
    Reflect.set(manager, "modelInventoryOperations", {
      read: async () => verifiedModelInventory(),
    });
    const created = manager.create(request);
    createdId = created.id;
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      dgxJobId: string | null;
      plan: {
        executable: string;
        args: string[];
        outputPath: string;
        requiredPaths: unknown[];
      };
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.plan.executable = process.execPath;
    runtimeJob.plan.args = [
      "-e",
      "const fs=require('node:fs');const i=process.argv.indexOf('--output-path');fs.writeFileSync(process.argv[i+1],'ltx-base');",
      "--",
      "--output-path",
      "replaced-by-runner",
    ];
    runtimeJob.plan.outputPath = finalOutput;
    runtimeJob.plan.requiredPaths = [];

    Reflect.set(manager, "waitForDgxQueueStart", async (job: { dgxJobId: string | null }) => {
      job.dgxJobId = "dgx-job-test";
      return true;
    });
    Reflect.set(manager, "readThermalBaseline", async () => 50);
    Reflect.set(manager, "watchThermals", () => () => undefined);
    Reflect.set(
      manager,
      "runLoggedProcess",
      async (_job: unknown, executable: string, args: string[]) => {
        expect(executable).toBe("ffmpeg");
        events.push("final-audio-remux");
        await writeFile(args.at(-1)!, "final-video");
        return { code: 0, signal: null, error: null };
      },
    );
    const runJob = Reflect.get(manager, "run") as (job: unknown) => Promise<void>;
    const running = runJob.call(manager, runtimeJob);
    await completedTransitionStarted;
    expect(manager.cancel(created.id)?.status).toBe("completed");
    releaseCompletedTransitionResolve();
    await running;

    expect(events).toEqual([
      "pre-identity",
      "running",
      "final-audio-remux",
      "final-identity",
      "completed",
    ]);
    expect(manager.get(created.id)?.status).toBe("completed");
    await rm(join(hybridRoot, created.id), { recursive: true, force: true });
  });

  it("reconciles a lost completed response without failing the finished Studio job", async () => {
    const path = await statePath();
    let remoteState: "running" | "completed" = "running";
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: remoteState },
      }),
      transition: async (_jobId, state) => {
        expect(state).toBe("completed");
        remoteState = "completed";
        throw new Error("connection closed after commit");
      },
    }, null);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      dgxJobId: string | null;
      dgxJobTerminal?: boolean;
      dgxTerminalDelivery?: unknown;
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-lost-response";

    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: string,
      metadata?: object,
    ) => Promise<boolean>;
    expect(await transition.call(manager, runtimeJob, "completed", {
      current_step: "finished",
    })).toBe(true);

    expect(runtimeJob.dgxJobTerminal).toBe(true);
    expect(runtimeJob.dgxTerminalDelivery).toBeUndefined();
    expect(manager.get(created.id)?.logs.at(-1)).toContain("per GET abgeglichen");
  });

  it("waits on a Qwen start fence while the remote job remains accepted", async () => {
    const path = await statePath();
    let transitions = 0;
    let remoteState: "accepted" | "starting" = "accepted";
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: remoteState },
      }),
      transition: async (jobId, state) => {
        transitions += 1;
        if (transitions === 1) {
          throw new RuntimeApiError("lease_cordon", 409, {
            error: "qwen_gate_active",
            retry_after_seconds: 30,
          });
        }
        remoteState = "starting";
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null);
    Reflect.set(manager, "waitForDelay", async () => true);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-qwen-fence";
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
      metadata?: object,
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(true);
    expect(transitions).toBe(2);
    expect(manager.get(created.id)?.logs.join("\n")).toContain("Queue-Job bleibt accepted");
  });

  it("waits when the Orchestrator has not selected the accepted job as queue winner", async () => {
    const path = await statePath();
    let transitions = 0;
    let remoteState: "accepted" | "starting" = "accepted";
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: remoteState },
      }),
      transition: async (jobId, state) => {
        transitions += 1;
        if (transitions === 1) {
          throw new RuntimeApiError("DGX start gate active: not_selected_queue_winner", 409, {
            error: "start_gate_active",
            reason: "not_selected_queue_winner",
            retry_after_seconds: 5,
          });
        }
        remoteState = "starting";
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null);
    Reflect.set(manager, "waitForDelay", async () => true);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-waiting-for-winner";
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
      metadata?: object,
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(true);
    expect(transitions).toBe(2);
    expect(manager.get(created.id)).toMatchObject({
      status: "queued",
      error: null,
      dgxJobId: "dgx-job-waiting-for-winner",
    });
    expect(manager.get(created.id)?.logs.join("\n")).toContain("not_selected_queue_winner");
  });

  it("retries the start fence when a queued job is not yet the selected winner", async () => {
    const path = await statePath();
    let transitions = 0;
    let remoteState: "queued" | "starting" = "queued";
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: remoteState },
      }),
      transition: async (jobId, state) => {
        transitions += 1;
        if (transitions === 1) {
          throw new RuntimeApiError("DGX start gate active: not_selected_queue_winner", 409, {
            error: "start_gate_active",
            reason: "not_selected_queue_winner",
            retry_after_seconds: 5,
          });
        }
        remoteState = "starting";
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null);
    Reflect.set(manager, "waitForDelay", async () => true);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-queued-winner";
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(true);
    expect(transitions).toBe(2);
    expect(manager.get(created.id)?.logs.join("\n")).toContain("auf seine Auswahl");
  });

  it("reconciles a dropped starting response before retrying the transition", async () => {
    const path = await statePath();
    let transitions = 0;
    let remoteState: "accepted" | "starting" = "accepted";
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: remoteState },
      }),
      transition: async () => {
        transitions += 1;
        remoteState = "starting";
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    }, null);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-lost-starting-response";
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(true);
    expect(transitions).toBe(1);
    expect(manager.get(created.id)?.logs.at(-1)).toContain("bereits starting");
  });

  it("does not retry a non-Qwen transition conflict", async () => {
    const path = await statePath();
    let reads = 0;
    const manager = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => {
        reads += 1;
        return {
          schema_version: "dgx-job-read.v0",
          job: { job_id: jobId, state: "accepted" as const },
        };
      },
      transition: async () => {
        throw new RuntimeApiError("invalid transition", 409, {
          error: "invalid_transition",
        });
      },
    }, null);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-invalid-transition";
    const transition = Reflect.get(manager, "transitionDgxJob") as (
      job: unknown,
      state: "starting",
    ) => Promise<boolean>;

    expect(await transition.call(manager, runtimeJob, "starting")).toBe(false);
    expect(reads).toBe(0);
  });

  it("persists and redelivers a failed cancelled transition after restart", async () => {
    const path = await statePath();
    const identityOperations = {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence: ReturnType<typeof notApplicableIdentityEvidence>) => ({ evidence, error: null }),
    };
    const failingOperations = {
      read: async (jobId: string) => ({
        schema_version: "dgx-job-read.v0" as const,
        job: { job_id: jobId, state: "running" as const },
      }),
      transition: async () => {
        throw new Error("temporary connection failure");
      },
    };
    const manager = new JobManager(path, false, null, identityOperations, failingOperations, null);
    const created = manager.create(validRequest());
    const firstInternalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    firstInternalJobs.get(created.id)!.dgxJobId = "dgx-job-cancel-retry";

    manager.cancel(created.id);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const pending = JSON.parse(await readFile(path, "utf8")) as Array<{
      dgxTerminalDelivery?: { state: string; attempts: number; lastError: string | null };
    }>;
    expect(pending[0].dgxTerminalDelivery).toMatchObject({
      state: "cancelled",
      attempts: 1,
    });
    expect(pending[0].dgxTerminalDelivery?.lastError).toContain("temporary connection failure");

    const deliveredStates: string[] = [];
    const restored = new JobManager(path, false, null, identityOperations, {
      read: failingOperations.read,
      transition: async (jobId, state) => {
        deliveredStates.push(state);
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null);
    const restoredInternalJobs = Reflect.get(restored, "jobs") as Map<string, unknown>;
    const restoredJob = restoredInternalJobs.get(created.id)!;
    const flush = Reflect.get(restored, "flushDgxTerminalDelivery") as (job: unknown) => Promise<boolean>;

    expect(await flush.call(restored, restoredJob)).toBe(true);
    expect(deliveredStates).toEqual(["cancelled"]);
    const delivered = JSON.parse(await readFile(path, "utf8")) as Array<{ dgxTerminalDelivery?: unknown }>;
    expect(delivered[0].dgxTerminalDelivery).toBeUndefined();
  });

  it("keeps cancellation authoritative while an older running transition is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-running-cancel-race-"));
    roots.push(root);
    const request = validRequest("one-stage");
    request.outputName = `running-cancel-race-${Date.now()}.mp4`;
    let runningTransitionStartedResolve!: () => void;
    const runningTransitionStarted = new Promise<void>((resolve) => {
      runningTransitionStartedResolve = resolve;
    });
    let releaseRunningTransitionResolve!: () => void;
    const releaseRunningTransition = new Promise<void>((resolve) => {
      releaseRunningTransitionResolve = resolve;
    });
    let cancellationDeliveredResolve!: () => void;
    const cancellationDelivered = new Promise<void>((resolve) => {
      cancellationDeliveredResolve = resolve;
    });
    const transitions: string[] = [];
    const manager = new JobManager(join(root, "jobs.json"), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => {
        cancellationDeliveredResolve();
        return {
          schema_version: "dgx-job-read.v0",
          job: { job_id: jobId, state: "cancelled" },
        };
      },
      transition: async (jobId, state) => {
        transitions.push(state);
        if (state === "running") {
          runningTransitionStartedResolve();
          await releaseRunningTransition;
          throw new Error("running transition lost to cancellation");
        }
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null, undefined, testRunProvenanceOperations);
    const created = manager.create(request);
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, {
      dgxJobId: string | null;
      plan: {
        executable: string;
        args: string[];
        outputPath: string;
        requiredPaths: unknown[];
      };
    }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.plan.executable = process.execPath;
    runtimeJob.plan.args = [
      "-e",
      "setTimeout(()=>{},10000)",
      "--",
      "--output-path",
      "replaced-by-runner",
    ];
    runtimeJob.plan.outputPath = join(root, request.outputName);
    runtimeJob.plan.requiredPaths = [];
    Reflect.set(manager, "waitForDgxQueueStart", async (job: { dgxJobId: string | null }) => {
      job.dgxJobId = "dgx-job-running-cancel-race";
      return true;
    });
    Reflect.set(manager, "readThermalBaseline", async () => 50);
    Reflect.set(manager, "watchThermals", () => () => undefined);

    const runJob = Reflect.get(manager, "run") as (job: unknown) => Promise<void>;
    const running = runJob.call(manager, runtimeJob);
    await runningTransitionStarted;
    expect(manager.cancel(created.id)?.status).toBe("cancelled");
    releaseRunningTransitionResolve();
    await cancellationDelivered;
    await running;

    expect(transitions).toEqual(["running"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      error: null,
    });
  });

  it("serializes cancellation against accepted to starting without launching compute", async () => {
    let remoteState: "accepted" | "starting" | "failed" = "accepted";
    let startingTransitionResolve!: () => void;
    const startingTransition = new Promise<void>((resolve) => {
      startingTransitionResolve = resolve;
    });
    let releaseStartingResolve!: () => void;
    const releaseStarting = new Promise<void>((resolve) => {
      releaseStartingResolve = resolve;
    });
    let terminalTransitionResolve!: () => void;
    const terminalTransition = new Promise<void>((resolve) => {
      terminalTransitionResolve = resolve;
    });
    const transitions: string[] = [];
    const manager = new JobManager(await statePath(), false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: remoteState },
      }),
      transition: async (jobId, state) => {
        transitions.push(state);
        if (state === "starting") {
          startingTransitionResolve();
          await releaseStarting;
          remoteState = "starting";
        } else if (state === "failed") {
          remoteState = "failed";
          terminalTransitionResolve();
        }
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state: remoteState },
        };
      },
    }, null);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-starting-cancel-race";
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 121,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 8,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));

    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (job: unknown) => Promise<string>;
    const starting = startAccepted.call(manager, runtimeJob);
    await startingTransition;
    expect(manager.cancel(created.id)?.status).toBe("cancelled");
    releaseStartingResolve();

    expect(await starting).toBe("stopped");
    await terminalTransition;
    expect(transitions).toEqual(["starting", "failed"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "cancelled",
      outputUrl: null,
    });
  });

  it("restores pending terminal deliveries beyond the bounded normal history", async () => {
    const path = await statePath();
    const pendingId = "00000000-0000-4000-8000-000000000100";
    const entries = Array.from({ length: 101 }, (_, index) => {
      const request = validRequest();
      request.outputName = `history-${index}.mp4`;
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      return {
        id,
        status: "cancelled",
        mode: request.mode,
        prompt: request.prompt,
        outputName: request.outputName,
        outputUrl: null,
        createdAt: new Date(Date.now() - index * 1000).toISOString(),
        startedAt: null,
        finishedAt: new Date().toISOString(),
        progress: null,
        error: null,
        logs: [],
        command: "",
        request,
        favorite: false,
        variantOf: null,
        runtimeMs: null,
        cancelledBy: "studio",
        thermalProfile: null,
        dgxJobId: index === 100 ? "dgx-job-old-pending" : null,
        identityEvidence: null,
        ...(index === 100 ? {
          dgxTerminalDelivery: {
            state: "cancelled",
            metadata: { current_step: "old pending cancellation" },
            attempts: 3,
            lastError: "offline",
            updatedAt: new Date().toISOString(),
          },
        } : {}),
      };
    });
    await writeFile(path, JSON.stringify(entries));

    const restored = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (jobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: jobId, state: "running" },
      }),
      transition: async () => {
        throw new Error("not expected");
      },
    }, null);

    expect(restored.list()).toHaveLength(101);
    expect(restored.get(pendingId)?.dgxJobId).toBe("dgx-job-old-pending");
  });

  it("preserves an explicitly enabled LongCat pass on exact reruns", async () => {
    const manager = new JobManager(await statePath(), false);
    const request = validRequest("audio-to-video");
    request.images = [{ path: "/inputs/face.png", name: "face.png", frameIndex: 0, strength: 1, crf: 33 }];
    request.postprocess.longcatLipsync.enabled = true;
    request.postprocess.longcatLipsync.resolution = "720p";
    request.postprocess.longcatLipsync.blend = 0.65;

    const created = manager.create(request);
    manager.cancel(created.id);
    const variant = manager.rerun(created.id, "exact");

    expect(variant?.request.postprocess.longcatLipsync).toEqual({
      enabled: true,
      resolution: "720p",
      blend: 0.65,
    });
  });

  it("migrates a recoverable queued native-dialogue job to the official speech stack", async () => {
    const path = await statePath();
    const manager = new JobManager(path, false);
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "Guten Morgen.";
    request.enhancePrompt = true;
    request.models.checkpointPath = "/legacy/dev.safetensors";
    request.models.gemmaRoot = "/legacy/gemma";
    request.models.distilledLora.path = "/legacy/distilled-lora.safetensors";
    request.models.spatialUpscalerPath = "/legacy/upscaler.safetensors";

    const created = manager.create(request);
    const restored = new JobManager(path, false).get(created.id)!;

    expect(restored.status).toBe("queued");
    expect(restored.request.enhancePrompt).toBe(false);
    expect(restored.request.models.checkpointPath).toBe(
      recommendedModelAsset("ltx23-dev-fp8-checkpoint").localPath,
    );
    expect(restored.request.quantization.mode).toBe("fp8-scaled-mm");
    expect(restored.request.models.gemmaRoot).toBe(
      recommendedModelAsset("ltx23-gemma").localPath,
    );
    expect(restored.request.models.distilledLora.path).toBe(
      recommendedModelAsset("ltx23-comfy-distilled-lora").localPath,
    );
    expect(restored.request.models.spatialUpscalerPath).toBe(
      recommendedModelAsset("ltx23-spatial-upscaler").localPath,
    );
  });

  it("does not rewrite model paths from a frozen experiment binding", async () => {
    const request = validRequest("id-lora");
    request.models.distilledLora.path = "/models/historical-distilled-lora.safetensors";
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "22222222-2222-4222-8222-222222222222",
      protocolSha256: "a".repeat(64),
      arm: "candidate" as const,
      kind: "ablation" as const,
      variableId: "lipforcing-enabled",
      changedRequestPaths: ["postprocess.lipForcing.enabled"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256: "c".repeat(64),
      baselineJobId: "11111111-1111-4111-8111-111111111111",
      baselineOutputName: "historical-baseline.mp4",
    };
    const manager = new JobManager(await statePath(), false);

    const created = manager.create(request, { experiment: binding });

    expect(created.request.models.distilledLora.path).toBe(
      "/models/historical-distilled-lora.safetensors",
    );
  });

  it("persists a frozen experiment binding across a Studio restart", async () => {
    const path = await statePath();
    const request = validRequest("audio-to-video");
    const binding = {
      schemaVersion: "ltx-studio-experiment-run.v1" as const,
      experimentId: "33333333-3333-4333-8333-333333333333",
      protocolSha256: "a".repeat(64),
      arm: "baseline" as const,
      kind: "ablation" as const,
      variableId: "a2v-guidance",
      changedRequestPaths: ["videoGuidance.modalityScale"],
      baselineRequestSha256: "b".repeat(64),
      requestSha256: "b".repeat(64),
      baselineJobId: null,
      baselineOutputName: request.outputName,
    };
    const manager = new JobManager(path, false);

    const created = manager.create(request, { experiment: binding });
    const restored = new JobManager(path, false);

    expect(created.experiment).toEqual(binding);
    expect(restored.get(created.id)?.experiment).toEqual(binding);
  });

  it("persists an exact project binding and rejects request drift or mixed authority", async () => {
    const path = await statePath();
    const request = validRequest("id-lora");
    request.models.distilledLora.path = "/models/project-bound-distilled-lora.safetensors";
    const binding = {
      schemaVersion: "ltx-studio-project-run.v1" as const,
      projectId: "44444444-4444-4444-8444-444444444444",
      projectRevision: 7,
      projectRevisionSha256: "a".repeat(64),
      shotId: "55555555-5555-4555-8555-555555555555",
      requestRevisionId: "66666666-6666-4666-8666-666666666666",
      requestSha256: projectValueSha256(request),
      continuity: null,
    };
    const manager = new JobManager(path, false);

    const created = manager.create(request, { project: binding });
    const restored = new JobManager(path, false);

    expect(created.project).toEqual(binding);
    expect(created.request.models.distilledLora.path).toBe(
      "/models/project-bound-distilled-lora.safetensors",
    );
    expect(restored.get(created.id)?.project).toEqual(binding);
    expect(restored.get(created.id)?.request.models.distilledLora.path).toBe(
      "/models/project-bound-distilled-lora.safetensors",
    );
    expect(restored.get(created.id)?.status).toBe("queued");

    const drifted = structuredClone(request);
    drifted.seed += 1;
    drifted.outputName = "project-drifted.mp4";
    expect(() => manager.create(drifted, { project: binding })).toThrow(
      "gebundenen Request-Revision",
    );
    expect(() => manager.create(request, {
      experiment: {
        schemaVersion: "ltx-studio-experiment-run.v1",
        experimentId: "77777777-7777-4777-8777-777777777777",
        protocolSha256: "b".repeat(64),
        arm: "baseline",
        kind: "ablation",
        variableId: "a2v-guidance",
        changedRequestPaths: ["videoGuidance.modalityScale"],
        baselineRequestSha256: "c".repeat(64),
        requestSha256: "c".repeat(64),
        baselineJobId: null,
        baselineOutputName: request.outputName,
      },
      project: binding,
    })).toThrow("gleichzeitig Experiment- und Projektlauf");

    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted[0].request.seed += 1;
    await writeFile(path, JSON.stringify(persisted));
    const broken = new JobManager(path, false);
    expect(broken.get(created.id)).toMatchObject({
      status: "interrupted",
      error: expect.stringContaining("Projektbindung"),
    });
    expect(Reflect.get(broken, "queue")).not.toContain(created.id);
  });

  it("bounds the persisted active queue", async () => {
    const manager = new JobManager(await statePath(), false);
    for (let index = 0; index < MAX_ACTIVE_JOBS; index += 1) {
      const request = validRequest();
      request.outputName = `queue-${index}.mp4`;
      manager.create(request);
    }
    const overflow = validRequest();
    overflow.outputName = "queue-overflow.mp4";
    expect(() => manager.create(overflow)).toThrow(`auf ${MAX_ACTIVE_JOBS} aktive Aufträge begrenzt`);
    expect(manager.list()).toHaveLength(MAX_ACTIVE_JOBS);
  });

  it("restores authority fields from the validated request", async () => {
    const path = await statePath();
    const request = validRequest();
    const id = "2c8a5dc6-8864-49f7-a639-85caef912345";
    await writeFile(path, JSON.stringify([{
      id,
      status: "failed",
      mode: "retake",
      prompt: "tampered",
      outputName: "../../outside.mp4",
      outputUrl: "/outside",
      createdAt: "invalid",
      startedAt: null,
      finishedAt: null,
      progress: 999,
      error: null,
      logs: ["valid", 42],
      command: "malicious command",
      request,
    }]));

    const restored = new JobManager(path, false).get(id)!;
    expect(restored.mode).toBe(request.mode);
    expect(restored.prompt).toBe(request.prompt);
    expect(restored.outputName).toBe(request.outputName);
    expect(restored.outputUrl).toBeNull();
    expect(restored.progress).toBe(95);
    expect(restored.logs).toEqual(["valid"]);
    expect(restored.cancelledBy).toBeNull();
    expect(restored.command).toContain("ltx_pipelines.ti2vid_two_stages");
    expect(Number.isFinite(Date.parse(restored.createdAt))).toBe(true);

    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted).toHaveLength(1);
  });

  it("marks a persisted thermal pause interrupted after a Studio restart", async () => {
    const path = await statePath();
    const request = validRequest();
    await writeFile(path, JSON.stringify([{
      id: "2c8a5dc6-8864-49f7-a639-85caef916666",
      status: "paused",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      progress: 42,
      error: null,
      logs: ["Thermalpause"],
      command: "ignored",
      request,
      favorite: false,
      variantOf: null,
      runtimeMs: null,
    }]));
    const restored = new JobManager(path, false).list()[0];
    expect(restored.status).toBe("interrupted");
    expect(restored.error).toContain("Studio wurde während des Jobs neu gestartet");
  });

  it("restores an active remote lease with a durable cancellation delivery", async () => {
    const path = await statePath();
    const request = validRequest();
    const jobId = "2c8a5dc6-8864-49f7-a639-85caef916667";
    await writeFile(path, JSON.stringify([{
      id: jobId,
      status: "queued",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      error: null,
      logs: ["accepted lease"],
      command: "ignored",
      request,
      favorite: false,
      variantOf: null,
      experiment: null,
      project: null,
      runtimeMs: null,
      cancelledBy: null,
      thermalProfile: null,
      dgxJobId: "dgx-job-studio-restart",
      identityEvidence: null,
      runProvenance: null,
    }]));
    const transitions: string[] = [];
    const restored = new JobManager(path, false, null, {
      capture: async () => notApplicableIdentityEvidence(),
      verify: async (evidence) => ({ evidence, error: null }),
    }, {
      read: async (remoteJobId) => ({
        schema_version: "dgx-job-read.v0",
        job: { job_id: remoteJobId, state: "accepted" },
      }),
      transition: async (remoteJobId, state) => {
        transitions.push(state);
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: remoteJobId, state },
        };
      },
    }, null);
    const internalJobs = Reflect.get(restored, "jobs") as Map<string, unknown>;
    const restoredJob = internalJobs.get(jobId)!;
    const flush = Reflect.get(restored, "flushDgxTerminalDelivery") as (job: unknown) => Promise<boolean>;

    expect(restored.get(jobId)).toMatchObject({
      status: "interrupted",
      dgxJobId: "dgx-job-studio-restart",
    });
    expect(restored.get(jobId)?.logs).toContain("Studio-Neustart: Remote-Queue-Lease wird als cancelled abgemeldet.");
    expect(await flush.call(restored, restoredJob)).toBe(true);
    expect(transitions).toEqual(["cancelled"]);
  });

  it("migrates historic thermal log lines into structured GUI data", async () => {
    const path = await statePath();
    const request = validRequest();
    await writeFile(path, JSON.stringify([{
      id: "2c8a5dc6-8864-49f7-a639-85caef917777",
      status: "cancelled",
      mode: request.mode,
      prompt: request.prompt,
      outputName: request.outputName,
      outputUrl: null,
      createdAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      progress: null,
      error: null,
      logs: [
        "Abbruch angefordert.",
        "Thermalprofil (gesamter Host): Basis 42.8 °C, Peak 67.9 °C, beobachteter Anstieg 25.1 °C.",
      ],
      command: "ignored",
      request,
      favorite: false,
      variantOf: null,
      runtimeMs: 10_000,
    }]));

    const restored = new JobManager(path, false).list()[0];
    expect(restored.cancelledBy).toBe("studio");
    expect(restored.thermalProfile).toMatchObject({
      baselineC: 42.8,
      peakC: 67.9,
      riseC: 25.1,
      pauseAtC: 90,
    });
  });
});
