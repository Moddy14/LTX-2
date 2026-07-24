import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  isActiveJobStatus,
  JobConflictError,
  JobManager,
  MAX_ACTIVE_JOBS,
  requestsShareLtxBase,
} from "../server/jobs.js";
import { notApplicableIdentityEvidence } from "../server/inputEvidence.js";
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
    hybrid.seed += 1;
    expect(requestsShareLtxBase(original, hybrid)).toBe(false);
  });

  it("treats thermally paused jobs as active", () => {
    expect(isActiveJobStatus("paused")).toBe(true);
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
    });
    Reflect.set(manager, "waitForDgxQueueStart", async () => true);
    Reflect.set(manager, "transitionDgxJob", async (_job: unknown, state: string) => {
      transitions.push(state);
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
    expect(restored.progress).toBe(100);
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
