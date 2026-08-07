import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  reusableLtxBaseFromSidecars,
  runProvenanceSharesLtxBase,
  type ReusableLtxBaseCandidate,
  type StudioJob,
} from "../server/jobs.js";
import type { IdentityInputEvidence } from "../server/inputEvidence.js";
import type { RunProvenance } from "../shared/provenance.js";
import { OutputLibrary } from "../server/outputs.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-reusable-base-"));
  roots.push(root);
  return root;
}

const BASE_JOB_ID = "2c8a5dc6-8864-49f7-a639-85caef918888";
const REFINER_JOB_ID = "7d1f2b3a-4c5d-4e6f-8a9b-0c1d2e3f4a5b";

function verifiedIdentityEvidence(): IdentityInputEvidence {
  return {
    schemaVersion: "ltx-studio-identity-evidence.v1",
    status: "verified",
    source: "image-conditioning",
    capturedAt: "2026-08-01T00:00:00.000Z",
    verifiedAt: "2026-08-01T00:01:00.000Z",
    reason: null,
    references: [{
      assetId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      kind: "image",
      sizeBytes: 2048,
      modifiedAtMs: 1_722_470_400_000,
      changedAtMs: 1_722_470_400_001,
      fileId: "42",
      sha256: "9".repeat(64),
    }],
  };
}

function verifiedRunProvenance(): RunProvenance {
  return {
    schemaVersion: "ltx-studio-run-provenance.v1",
    capturedAt: "2026-08-01T00:00:00.000Z",
    verifiedAt: "2026-08-01T00:05:00.000Z",
    files: [{
      role: "input:conditioning-audio",
      path: "/inputs/speech.wav",
      kind: "file",
      sizeBytes: 1024,
      modifiedAtMs: 1_722_470_400_000,
      changedAtMs: 1_722_470_400_001,
      fileId: "123",
      sha256: "a".repeat(64),
      entries: [],
    }],
    code: [{
      repositoryRoot: "/repo",
      commit: "b".repeat(40),
      dirty: false,
      trackedDiffSha256: "c".repeat(64),
      untracked: [],
      fingerprint: "d".repeat(64),
    }],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "test",
      nodeVersion: "test",
      pythonExecutable: "/python",
      pythonVersion: "3.12",
      packages: { torch: "test" },
      ffmpegVersion: "test",
      fingerprint: "e".repeat(64),
    },
    fingerprint: "f".repeat(64),
  };
}

function completedBaseJob(outputName: string): StudioJob {
  const request = validRequest();
  request.outputName = outputName;
  const finishedAt = "2026-08-01T00:10:00.000Z";
  return {
    id: BASE_JOB_ID,
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName,
    outputUrl: `/api/jobs/${BASE_JOB_ID}/output`,
    createdAt: finishedAt,
    startedAt: finishedAt,
    finishedAt,
    progress: 100,
    error: null,
    logs: [],
    command: "python -m ltx_pipelines.ti2vid_two_stages",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    runtimeMs: 1000,
    cancelledBy: null,
    dgxJobId: null,
    thermalProfile: null,
    identityEvidence: verifiedIdentityEvidence(),
    runProvenance: verifiedRunProvenance(),
  };
}

function sidecarCandidate(): ReusableLtxBaseCandidate {
  const request = validRequest();
  request.outputName = "base.mp4";
  return {
    outputName: "base.mp4",
    outputPath: "/outputs/base.mp4",
    jobId: BASE_JOB_ID,
    request,
    identityEvidence: verifiedIdentityEvidence(),
    runProvenance: verifiedRunProvenance(),
  };
}

function refinerTarget() {
  const request = validRequest();
  request.outputName = "refined.mp4";
  request.postprocess.lipForcing.enabled = true;
  const identity = verifiedIdentityEvidence();
  identity.status = "captured";
  identity.verifiedAt = null;
  const runProvenance = verifiedRunProvenance();
  runProvenance.verifiedAt = null;
  return { id: REFINER_JOB_ID, request, identityEvidence: identity, runProvenance };
}

describe("OutputLibrary.reusableLtxBaseCandidates", () => {
  it("exposes completed outputs whose sidecar carries full reuse evidence", async () => {
    const root = await outputRoot();
    const outputName = "base.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedBaseJob(outputName);

    library.recordCompleted([job]);
    const candidates = library.reusableLtxBaseCandidates();

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      outputName,
      outputPath: join(root, outputName),
      jobId: BASE_JOB_ID,
    });
    expect(candidates[0].request).toEqual(job.request);
    expect(candidates[0].identityEvidence).toEqual(job.identityEvidence);
    expect(candidates[0].runProvenance).toEqual(job.runProvenance);
  });

  it("drops a candidate whose file changed after the sidecar was written", async () => {
    const root = await outputRoot();
    const outputName = "base.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    library.recordCompleted([completedBaseJob(outputName)]);

    await appendFile(join(root, outputName), "tampered");

    expect(library.reusableLtxBaseCandidates()).toEqual([]);
  });

  it("omits sidecars without identity or run provenance", async () => {
    const root = await outputRoot();
    const outputName = "base.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedBaseJob(outputName);
    job.identityEvidence = null;
    job.runProvenance = null;

    library.recordCompleted([job]);

    expect(library.reusableLtxBaseCandidates()).toEqual([]);
  });
});

describe("reusableLtxBaseFromSidecars", () => {
  it("matches an identical base for a refiner-only request", () => {
    const candidate = sidecarCandidate();

    const match = reusableLtxBaseFromSidecars([candidate], refinerTarget(), () => true);

    expect(match).toBeDefined();
    expect(match?.id).toBe(BASE_JOB_ID);
    expect(match?.outputPath).toBe(candidate.outputPath);
    expect(match?.description).toContain("base.mp4");
  });

  it("never reuses the target job's own output", () => {
    const candidate = sidecarCandidate();
    const target = refinerTarget();
    target.id = BASE_JOB_ID;

    expect(reusableLtxBaseFromSidecars([candidate], target, () => true)).toBeUndefined();
  });

  it("rejects candidates that are refiner outputs themselves", () => {
    const candidate = sidecarCandidate();
    candidate.request.postprocess.lipForcing.enabled = true;

    expect(reusableLtxBaseFromSidecars([candidate], refinerTarget(), () => true)).toBeUndefined();
  });

  it("rejects candidates whose identity evidence is not verified", () => {
    const candidate = sidecarCandidate();
    candidate.identityEvidence.status = "captured";

    expect(reusableLtxBaseFromSidecars([candidate], refinerTarget(), () => true)).toBeUndefined();
  });

  it("rejects candidates whose run provenance was never verified", () => {
    const candidate = sidecarCandidate();
    candidate.runProvenance.verifiedAt = null;

    expect(reusableLtxBaseFromSidecars([candidate], refinerTarget(), () => true)).toBeUndefined();
  });

  it("rejects a target without captured run provenance", () => {
    const target = { ...refinerTarget(), runProvenance: null };

    expect(reusableLtxBaseFromSidecars([sidecarCandidate()], target, () => true)).toBeUndefined();
  });

  it("rejects a target whose generation settings drifted", () => {
    const target = refinerTarget();
    target.request.seed += 1;

    expect(reusableLtxBaseFromSidecars([sidecarCandidate()], target, () => true)).toBeUndefined();
  });

  it("rejects candidates whose file is not ready on disk", () => {
    expect(reusableLtxBaseFromSidecars([sidecarCandidate()], refinerTarget(), () => false)).toBeUndefined();
  });
});

describe("refiner-only provenance roles", () => {
  const REFINER_ONLY_ROLES = [
    "code:longcat-adapter",
    "model:longcat-face-detector",
    "code:latentsync-adapter",
    "model:latentsync-unet",
    "code:musetalk-adapter",
    "model:musetalk-unet",
    "code:lipforcing-adapter",
    "model:lipforcing-checkpoint",
    // Shared by every refiner arm; it never touches the LTX base. Leaving it
    // unfiltered made the role lists differ for good, so no refiner run could
    // adopt an existing base and every one re-rendered it.
    "code:refiner-audio-window",
    "input:final-audio-mix",
  ] as const;

  function withExtraRoles(roles: readonly string[]): RunProvenance {
    const provenance = verifiedRunProvenance();
    provenance.files = [
      ...provenance.files,
      ...roles.map((role, index) => ({
        ...provenance.files[0],
        role,
        path: `/refiner/${index}`,
        sha256: String(index % 10).repeat(64),
      })),
    ];
    return provenance;
  }

  it.each(REFINER_ONLY_ROLES)("ignores %s when comparing the LTX base", (role) => {
    expect(runProvenanceSharesLtxBase(verifiedRunProvenance(), withExtraRoles([role]))).toBe(true);
  });

  it("ignores a full refiner role set at once", () => {
    expect(runProvenanceSharesLtxBase(verifiedRunProvenance(), withExtraRoles(REFINER_ONLY_ROLES))).toBe(true);
  });

  it("still rejects a differing LTX model role", () => {
    expect(runProvenanceSharesLtxBase(verifiedRunProvenance(), withExtraRoles(["model:checkpoint:1"]))).toBe(false);
  });
});

describe("reusable base wiring", () => {
  it("falls back to the persisted output sidecars inside findReusableLtxBase", () => {
    const jobsSource = readFileSync(fileURLToPath(new URL("../server/jobs.ts", import.meta.url)), "utf8");
    const finder = jobsSource.slice(jobsSource.indexOf("private findReusableLtxBase"));

    expect(finder).toContain("this.reusableBaseSource");
    expect(finder).toContain("reusableLtxBaseFromSidecars(");
  });

  it("wires the output library into the job manager at server startup", () => {
    const indexSource = readFileSync(fileURLToPath(new URL("../server/index.ts", import.meta.url)), "utf8");

    expect(indexSource).toContain("jobs.wireReusableBaseSource(outputs)");
  });
});
