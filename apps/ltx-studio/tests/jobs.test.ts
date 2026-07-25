import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  isActiveJobStatus,
  frameProcessLogChunk,
  JobConflictError,
  JobManager,
  MAX_ACTIVE_JOBS,
  PipelineProgressTracker,
  progressFromPipelineLog,
  publishedOutputIsReusableLtxBase,
  requestsShareLtxBase,
  resolveRenderOutputPaths,
} from "../server/jobs.js";
import { hybridRoot } from "../server/config.js";
import { notApplicableIdentityEvidence } from "../server/inputEvidence.js";
import type { ResourceSnapshot } from "../server/system.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function statePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-jobs-"));
  roots.push(root);
  return join(root, "jobs.json");
}

describe("job persistence and reservations", () => {
  it("reuses an LTX base only when generation settings are otherwise identical", () => {
    const original = validRequest();
    const hybrid = structuredClone(original);
    hybrid.outputName = "hybrid.mp4";
    hybrid.postprocess.longcatLipsync.enabled = true;
    hybrid.postprocess.longcatLipsync.blend = 0.55;

    expect(requestsShareLtxBase(original, hybrid)).toBe(true);
    hybrid.audio.finalMix = { path: "/inputs/final-mix.wav", name: "final-mix.wav" };
    expect(requestsShareLtxBase(original, hybrid)).toBe(true);
    expect(publishedOutputIsReusableLtxBase(hybrid, original)).toBe(false);
    expect(publishedOutputIsReusableLtxBase(original, hybrid)).toBe(true);
    hybrid.seed += 1;
    expect(requestsShareLtxBase(original, hybrid)).toBe(false);
  });

  it("keeps every pre-remux video outside the public output path", () => {
    const finalOutput = "/outputs/final.mp4";
    const stageRoot = "/staging/job";

    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      remuxInput: "/staging/job/ltx-base.mp4",
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, true, true)).toEqual({
      ltxOutput: "/staging/job/ltx-base.mp4",
      compositeOutput: "/staging/job/longcat-composite.mp4",
      remuxInput: "/staging/job/longcat-composite.mp4",
    });
    expect(resolveRenderOutputPaths(finalOutput, stageRoot, false, false).ltxOutput).toBe(finalOutput);
  });

  it("treats thermally paused jobs as active", () => {
    expect(isActiveJobStatus("paused")).toBe(true);
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

  it("waits for swap before creating a DGX queue lease", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    const snapshots: ResourceSnapshot[] = [
      {
        availableMemoryGiB: 80,
        totalMemoryGiB: 121.69,
        swapFreeGiB: 3.25,
        swapTotalGiB: 16,
        outputFreeGiB: 100,
      },
      {
        availableMemoryGiB: 80,
        totalMemoryGiB: 121.69,
        swapFreeGiB: 4.25,
        swapTotalGiB: 16,
        outputFreeGiB: 100,
      },
    ];
    Reflect.set(manager, "readStartResourceSnapshot", () => snapshots.shift()!);
    Reflect.set(manager, "waitForDelay", async () => true);

    const waitForPreAdmission = Reflect.get(manager, "waitForLocalPreAdmissionResources") as (
      job: unknown,
    ) => Promise<boolean>;

    expect(await waitForPreAdmission.call(manager, runtimeJob)).toBe(true);
    expect(manager.get(created.id)?.logs).toEqual(expect.arrayContaining([
      expect.stringContaining("mindestens 4 GiB"),
      expect.stringContaining("4.25 GiB Swap"),
    ]));
  });

  it("rechecks all resources immediately before an accepted DGX job starts", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-local-start-gate";
    const transitions: string[] = [];
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 121,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 4.25,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));
    Reflect.set(manager, "transitionDgxJob", async (_job: unknown, state: string) => {
      transitions.push(state);
      return true;
    });

    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (job: unknown) => Promise<boolean>;

    expect(await startAccepted.call(manager, runtimeJob)).toBe(true);
    expect(transitions).toEqual(["starting"]);
    expect(manager.get(created.id)?.logs.at(-1)).toContain("100.00 GiB Ausgabeplatz");
  });

  it("cancels an accepted DGX lease when the immediate RAM recheck fails", async () => {
    let cancellationResolve!: () => void;
    const cancellation = new Promise<void>((resolve) => {
      cancellationResolve = resolve;
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
        if (state === "cancelled") cancellationResolve();
        return {
          schema_version: "dgx-job-transition.v0",
          job: { job_id: jobId, state },
        };
      },
    }, null);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, { dgxJobId: string | null }>;
    const runtimeJob = internalJobs.get(created.id)!;
    runtimeJob.dgxJobId = "dgx-job-failed-local-recheck";
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 40,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 8,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
    }));

    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (job: unknown) => Promise<boolean>;

    expect(await startAccepted.call(manager, runtimeJob)).toBe(false);
    await cancellation;
    expect(transitions).toEqual(["cancelled"]);
    expect(manager.get(created.id)).toMatchObject({
      status: "failed",
      outputUrl: null,
    });
    expect(manager.get(created.id)?.error).toContain("lokale Start-Recheck ist fehlgeschlagen");
  });

  it("does not create a DGX lease after cancellation while waiting for pre-admission resources", async () => {
    const manager = new JobManager(await statePath(), false);
    const created = manager.create(validRequest());
    const internalJobs = Reflect.get(manager, "jobs") as Map<string, unknown>;
    const runtimeJob = internalJobs.get(created.id)!;
    Reflect.set(manager, "readStartResourceSnapshot", () => ({
      availableMemoryGiB: 80,
      totalMemoryGiB: 121.69,
      swapFreeGiB: 3.25,
      swapTotalGiB: 16,
      outputFreeGiB: 100,
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
    Reflect.set(manager, "startAcceptedDgxJob", async () => true);
    const waitForQueuedDgxJob = Reflect.get(manager, "waitForQueuedDgxJob") as (
      job: unknown,
      delayMs: number,
    ) => Promise<boolean>;

    expect(await waitForQueuedDgxJob.call(manager, runtimeJob, 0)).toBe(true);
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
    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (job: unknown) => Promise<boolean>;

    expect(await startAccepted.call(manager, runtimeJob)).toBe(false);
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
    }, null);
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
    }, null);
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

    const startAccepted = Reflect.get(manager, "startAcceptedDgxJob") as (job: unknown) => Promise<boolean>;
    const starting = startAccepted.call(manager, runtimeJob);
    await startingTransition;
    expect(manager.cancel(created.id)?.status).toBe("cancelled");
    releaseStartingResolve();

    expect(await starting).toBe(false);
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

  it("keeps LongCat available but disables it on rerun variants", async () => {
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
      enabled: false,
      resolution: "720p",
      blend: 0.65,
    });
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
