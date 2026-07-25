import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyExperimentCandidate,
  generationRequestDiffPaths,
  validateControlledExperimentDifference,
} from "../shared/experiments.js";
import {
  ExperimentConflictError,
  ExperimentStore,
  outputVerifiesExperimentBaseline,
  requestSettingsSha256,
  sha256Json,
} from "../server/experimentStore.js";
import type { StudioOutput } from "../shared/outputs.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function experimentRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-experiments-"));
  roots.push(root);
  return root;
}

function baselineRequest() {
  const request = validRequest("audio-to-video");
  request.outputName = "native-a2v-guidance.mp4";
  request.images = [{
    path: "/inputs/face.png",
    name: "face.png",
    frameIndex: 0,
    strength: 1,
    crf: 33,
  }];
  request.videoGuidance.modalityScale = 5;
  return request;
}

describe("controlled experiment contract", () => {
  it("applies exactly the registered A2V variable and rejects hidden changes", () => {
    const baseline = baselineRequest();
    const candidate = applyExperimentCandidate(baseline, {
      variable: "a2v-guidance",
      value: 3,
    });

    expect(validateControlledExperimentDifference(
      baseline,
      candidate,
      { variable: "a2v-guidance", value: 3 },
    )).toEqual(["videoGuidance.modalityScale"]);

    candidate.seed += 1;
    expect(() => validateControlledExperimentDifference(
      baseline,
      candidate,
      { variable: "a2v-guidance", value: 3 },
    )).toThrow("Nicht freigegebene Request-Änderung: seed");
  });

  it("treats a seed change as a replicate rather than an ablation", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const experiment = store.create({
      title: "Drei feste Seeds",
      baselineRequest: baselineRequest(),
      candidate: { variable: "replicate-seed", value: 23072026 },
    });

    expect(experiment.kind).toBe("replicate");
    expect(experiment.changedRequestPaths).toEqual(["seed"]);
  });

  it("creates two content-addressed arms and freezes an immutable protocol", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const draft = store.create({
      title: "A2V Guidance 5 gegen 3",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }, "2026-07-25T04:00:00.000Z");

    expect(draft.status).toBe("draft");
    expect(draft.protocolSha256).toBeNull();
    expect(draft.changedRequestPaths).toEqual(["videoGuidance.modalityScale"]);
    expect(draft.arms[0].request.outputName).not.toBe(draft.arms[1].request.outputName);
    expect(draft.arms[0].requestSha256).toBe(sha256Json(draft.arms[0].request));
    expect(draft.arms[0].settingsSha256).toBe(requestSettingsSha256(draft.arms[0].request));

    const frozen = store.freeze(draft.id, "2026-07-25T04:01:00.000Z");
    expect(frozen.status).toBe("frozen");
    expect(frozen.protocolSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => store.freeze(draft.id)).toThrow("bereits eingefroren");
    expect(store.get(draft.id)).toEqual(frozen);
  });

  it("binds baseline before candidate and preserves the frozen request hashes", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "CRF 33 gegen 0",
      baselineRequest: baselineRequest(),
      candidate: { variable: "reference-image-crf", value: 0 },
    }).id);
    const baselineJobId = "11111111-1111-4111-8111-111111111111";
    const candidateJobId = "22222222-2222-4222-8222-222222222222";

    expect(() => store.bindingFor(frozen.id, "candidate")).toThrow("Baseline-Arm");
    const baselineBinding = store.bindingFor(frozen.id, "baseline");
    expect(baselineBinding.arm).toBe("baseline");
    expect(baselineBinding.requestSha256).toBe(frozen.arms[0].requestSha256);
    store.attachJob(frozen.id, "baseline", baselineJobId);

    const candidateBinding = store.bindingFor(frozen.id, "candidate");
    expect(candidateBinding.baselineJobId).toBe(baselineJobId);
    expect(candidateBinding.changedRequestPaths).toEqual(["images[0].crf"]);
    const completed = store.attachJob(frozen.id, "candidate", candidateJobId);
    expect(completed.arms.map((arm) => arm.jobId)).toEqual([baselineJobId, candidateJobId]);
  });

  it("keeps an unused frozen protocol immutable while marking its replacement", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const obsolete = store.freeze(store.create({
      title: "Irreführende Metadaten",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const replacementRequest = baselineRequest();
    replacementRequest.outputName = "neutral-guidance-test.mp4";
    replacementRequest.continuity.notes = "Nur A2V Guidance unterscheidet die Arme.";
    const replacement = store.freeze(store.create({
      title: "Neutral beschrifteter Ersatz",
      baselineRequest: replacementRequest,
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);

    const superseded = store.supersede(
      obsolete.id,
      "Dateiname und Notiz nannten in beiden Armen Guidance 5.",
      replacement.id,
      "2026-07-25T05:00:00.000Z",
    );
    expect(superseded).toMatchObject({
      status: "superseded",
      supersededAt: "2026-07-25T05:00:00.000Z",
      replacementExperimentId: replacement.id,
    });
    expect(superseded.protocolSha256).toBe(obsolete.protocolSha256);
    expect(() => store.bindingFor(obsolete.id, "baseline")).toThrow("muss vor dem Start eingefroren");
  });

  it("does not supersede an experiment after an arm was bound", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Bereits gestarteter Plan",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    store.attachJob(frozen.id, "baseline", "11111111-1111-4111-8111-111111111111");

    expect(() => store.supersede(frozen.id, "Nicht mehr verwenden.", null))
      .toThrow("gestarteten oder früher gebundenen Armen");
  });

  it("does not link a replacement whose frozen protocol was modified", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const obsolete = store.freeze(store.create({
      title: "Alter Plan",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const replacement = store.freeze(store.create({
      title: "Manipulierter Ersatz",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const path = join(root, `${replacement.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.arms[0].request.prompt = "Nach dem Freeze verändert";
    await writeFile(path, JSON.stringify(persisted));

    expect(() => store.supersede(obsolete.id, "Ersatz geplant.", replacement.id))
      .toThrow("nicht mehr hashkonsistent");
    expect(store.get(obsolete.id)?.status).toBe("frozen");
  });

  it("revalidates every frozen hash immediately before binding a run", async () => {
    const root = await experimentRoot();
    const store = new ExperimentStore(root);
    const frozen = store.freeze(store.create({
      title: "Tamper-resistenter Plan",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const path = join(root, `${frozen.id}.json`);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    persisted.arms[0].request.prompt = "Nach dem Einfrieren verändert";
    await writeFile(path, JSON.stringify(persisted));

    expect(() => store.bindingFor(frozen.id, "baseline")).toThrow("nicht mehr hashkonsistent");
  });

  it("reconciles a persisted experiment-bound job after a crash before arm attachment", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Crash-Recovery",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const jobId = "11111111-1111-4111-8111-111111111111";

    const recoverable = {
      id: jobId,
      status: "interrupted",
      startedAt: "2026-07-25T04:00:00.000Z",
      dgxJobId: "dgx-job-recoverable",
      experiment: binding,
    };
    store.reconcileJobs([recoverable]);
    store.reconcileJobs([recoverable]);

    expect(store.get(frozen.id)?.arms[0].jobId).toBe(jobId);
    expect(() => store.bindingFor(frozen.id, "baseline")).toThrow("bereits gestartet");
  });

  it("leaves a clearly never-started crash orphan unbound and preserves retry history", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Nie gestarteter Crash",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const firstBinding = store.bindingFor(frozen.id, "baseline");
    const firstJobId = "11111111-1111-4111-8111-111111111111";
    store.reconcileJobs([{
      id: firstJobId,
      status: "interrupted",
      startedAt: null,
      dgxJobId: null,
      experiment: firstBinding,
    }]);
    expect(store.get(frozen.id)?.arms[0].jobId).toBeNull();

    store.attachJob(frozen.id, "baseline", firstJobId);
    store.releaseArmForRetry(frozen.id, "baseline", firstJobId);
    const secondJobId = "22222222-2222-4222-8222-222222222222";
    store.attachJob(frozen.id, "baseline", secondJobId);

    expect(store.get(frozen.id)?.arms[0]).toMatchObject({
      jobId: secondJobId,
      attemptJobIds: [firstJobId, secondJobId],
    });
  });

  it("accepts a hash-verified baseline output after its job history was pruned", async () => {
    const store = new ExperimentStore(await experimentRoot());
    const frozen = store.freeze(store.create({
      title: "Dauerhafte Baseline",
      baselineRequest: baselineRequest(),
      candidate: { variable: "a2v-guidance", value: 3 },
    }).id);
    const binding = store.bindingFor(frozen.id, "baseline");
    const jobId = "11111111-1111-4111-8111-111111111111";
    const current = store.attachJob(frozen.id, "baseline", jobId);
    const output: StudioOutput = {
      name: current.arms[0].request.outputName,
      url: "/api/outputs/baseline.mp4",
      sizeBytes: 1,
      modifiedAt: "2026-07-25T04:00:00.000Z",
      changedAt: "2026-07-25T04:00:01.000Z",
      fileId: "1",
      jobId,
      jobStatus: "completed",
      request: current.arms[0].request,
      settingsAvailable: true,
      qualityReview: null,
      analysis: null,
      experiment: binding,
      experimentRequestVerified: true,
      provenance: {
        schemaVersion: "ltx-studio-run-provenance.v1",
        capturedAt: "2026-07-25T04:00:00.000Z",
        verifiedAt: "2026-07-25T04:01:00.000Z",
        files: [],
        code: [],
        runtime: {
          platform: "linux",
          architecture: "arm64",
          kernelRelease: "test",
          nodeVersion: "test",
          pythonExecutable: "/python",
          pythonVersion: "3.12",
          packages: {},
          ffmpegVersion: "test",
          fingerprint: "a".repeat(64),
        },
        fingerprint: "b".repeat(64),
      },
    };

    expect(outputVerifiesExperimentBaseline(output, current)).toBe(true);
    const tamperedRequest = structuredClone(output.request!);
    tamperedRequest.seed += 1;
    output.request = tamperedRequest;
    expect(outputVerifiesExperimentBaseline(output, current)).toBe(false);
  });

  it("fails closed on a corrupted experiment file", async () => {
    const root = await experimentRoot();
    const id = "11111111-1111-4111-8111-111111111111";
    await writeFile(join(root, `${id}.json`), "{ broken");
    const store = new ExperimentStore(root);

    expect(() => store.get(id)).toThrow(ExperimentConflictError);
    expect(() => store.list()).toThrow("beschädigt");
  });

  it("keeps output names out of substantive request diffs", () => {
    const baseline = baselineRequest();
    const candidate = structuredClone(baseline);
    candidate.outputName = "different.mp4";

    expect(generationRequestDiffPaths(baseline, candidate)).toEqual(["outputName"]);
    expect(requestSettingsSha256(baseline)).toBe(requestSettingsSha256(candidate));
  });
});
