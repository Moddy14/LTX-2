import { appendFile, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { StudioJob } from "../server/jobs.js";
import type { RunProvenance } from "../shared/provenance.js";
import { writeOutputAnalysis } from "../server/analysisStore.js";
import { sha256Json } from "../server/experimentStore.js";
import { OutputLibrary } from "../server/outputs.js";
import { validRequest } from "./fixtures.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function outputRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-outputs-"));
  roots.push(root);
  return root;
}

function completedJob(
  outputName: string,
  finishedAt: string,
  mode: Parameters<typeof validRequest>[0] = "two-stage",
): StudioJob {
  const request = validRequest(mode);
  request.outputName = outputName;
  return {
    id: "2c8a5dc6-8864-49f7-a639-85caef918888",
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName,
    outputUrl: `/api/jobs/2c8a5dc6-8864-49f7-a639-85caef918888/output`,
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
    identityEvidence: null,
    runProvenance: null,
  };
}

function runProvenance(): RunProvenance {
  return {
    schemaVersion: "ltx-studio-run-provenance.v1",
    capturedAt: "2026-07-24T09:30:00.000Z",
    verifiedAt: "2026-07-24T09:35:00.000Z",
    files: [{
      role: "input:conditioning-audio",
      path: "/inputs/speech.wav",
      kind: "file",
      sizeBytes: 1024,
      modifiedAtMs: 1_721_813_400_000,
      changedAtMs: 1_721_813_400_001,
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

describe("generated output library", () => {
  it("lists every MP4 and exposes settings only with matching provenance", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:00:00.000Z");
    const studioName = "studio-output.mp4";
    const externalName = "external-output.mp4";
    await writeFile(join(root, studioName), "video");
    await writeFile(join(root, externalName), "external");
    await utimes(join(root, studioName), completedAt, completedAt);
    const library = new OutputLibrary(root);
    const job = completedJob(studioName, completedAt.toISOString());

    library.recordCompleted([job]);
    const outputs = library.list([job]);
    const studioOutput = outputs.find((output) => output.name === studioName)!;
    const externalOutput = outputs.find((output) => output.name === externalName)!;

    expect(studioOutput.settingsAvailable).toBe(true);
    expect(studioOutput.request).toEqual(job.request);
    expect(studioOutput.qualityReview).toBeNull();
    expect(studioOutput.analysis).toBeNull();
    expect(externalOutput.settingsAvailable).toBe(false);
    expect(externalOutput.request).toBeNull();
    expect(externalOutput.qualityReview).toBeNull();
    expect(externalOutput.analysis).toBeNull();

    await appendFile(join(root, studioName), "changed");
    const modified = library.list([job]).find((output) => output.name === studioName)!;
    expect(modified.settingsAvailable).toBe(false);
    expect(modified.request).toBeNull();
  });

  it("backfills settings for completed Studio jobs even when filesystem mtime drifted", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:00:00.000Z");
    const driftedMtime = new Date("2026-07-24T08:30:00.000Z");
    const outputName = "drifted-output.mp4";
    await writeFile(join(root, outputName), "video");
    await utimes(join(root, outputName), driftedMtime, driftedMtime);
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString());

    const output = library.list([job]).find((candidate) => candidate.name === outputName)!;

    expect(output.settingsAvailable).toBe(true);
    expect(output.request).toEqual(job.request);
  });

  it("loads older settings sidecars through the current request migration", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:00:00.000Z");
    const outputName = "legacy-settings.mp4";
    await writeFile(join(root, outputName), "video");
    const stats = await stat(join(root, outputName));
    const job = completedJob(outputName, completedAt.toISOString());
    const legacyRequest = structuredClone(job.request) as Partial<typeof job.request>;
    delete legacyRequest.lipDub;
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify({
      schemaVersion: "ltx-studio-output.v1",
      outputName,
      jobId: job.id,
      completedAt: completedAt.toISOString(),
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      request: legacyRequest,
    }));

    const output = new OutputLibrary(root).list([job]).find((candidate) => candidate.name === outputName)!;

    expect(output.settingsAvailable).toBe(true);
    expect(output.request?.lipDub).toMatchObject({
      referenceVideo: { path: "", name: "", strength: 1 },
      lora: { path: "", strength: 1 },
    });
    expect(output.qualityReview).toBeNull();
    const migrated = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));
    expect(migrated).toMatchObject({
      schemaVersion: "ltx-studio-output.v6",
      changedAtMs: expect.any(Number),
      fileId: expect.stringMatching(/^\d+$/),
      identityEvidence: null,
      runProvenance: null,
    });
  });

  it("keeps legacy settings readable but refuses objective analysis without strong provenance", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:30:00.000Z");
    const outputName = "legacy-unbound-speech.mp4";
    await writeFile(join(root, outputName), "video");
    const stats = await stat(join(root, outputName));
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify({
      schemaVersion: "ltx-studio-output.v2",
      outputName,
      jobId: job.id,
      completedAt: completedAt.toISOString(),
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      request: job.request,
      qualityReview: null,
    }));
    const library = new OutputLibrary(root);

    expect(library.list([]).find((output) => output.name === outputName)?.settingsAvailable).toBe(true);
    library.setQualityReview(outputName, {
      scores: {
        lipSync: 5,
        identity: 5,
        mouthNaturalness: 5,
        skinStability: 5,
        motion: 5,
        audio: 5,
      },
      note: "Legacy darf dadurch keine starke Provenienz erhalten.",
    }, []);
    const afterReview = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));
    expect(afterReview.schemaVersion).toBe("ltx-studio-output.v2");
    expect(afterReview.changedAtMs).toBeUndefined();
    expect(afterReview.fileId).toBeUndefined();
    expect(() => library.resolveAnalysisTarget(outputName)).toThrow("inhaltsgebundene Studio-Provenienz");
  });

  it("upgrades a strong v3 speech sidecar to v6 without inventing evidence", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T07:45:00.000Z");
    const outputName = "v3-speech.mp4";
    await writeFile(join(root, outputName), "video");
    const stats = await stat(join(root, outputName));
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify({
      schemaVersion: "ltx-studio-output.v3",
      outputName,
      jobId: job.id,
      completedAt: completedAt.toISOString(),
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      changedAtMs: stats.ctimeMs,
      fileId: String(stats.ino),
      request: job.request,
      qualityReview: null,
    }));
    const library = new OutputLibrary(root);

    expect(library.resolveAnalysisTarget(outputName).identityEvidence).toBeNull();
    library.setQualityReview(outputName, {
      scores: {
        lipSync: 5,
        identity: 5,
        mouthNaturalness: 5,
        skinStability: 5,
        motion: 5,
        audio: 5,
      },
      note: "Alte Ausgabe ohne beweisbare Identitätsreferenz.",
    }, []);

    const upgraded = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));
    expect(upgraded).toMatchObject({
      schemaVersion: "ltx-studio-output.v6",
      identityEvidence: null,
      runProvenance: null,
    });
  });

  it("keeps completed provenance after the source job leaves bounded history", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T08:00:00.000Z");
    const outputName = "historic-output.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    library.recordCompleted([job]);

    const historic = library.list([]).find((output) => output.name === outputName)!;

    expect(historic.jobStatus).toBe("completed");
    expect(historic.jobId).toBe(job.id);
    expect(historic.settingsAvailable).toBe(true);
  });

  it("persists a validated speech quality scorecard in a revision-bound v6 sidecar", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:00:00.000Z");
    const outputName = "speech-scorecard.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    library.recordCompleted([job]);

    const updated = library.setQualityReview(outputName, {
      scores: {
        lipSync: 8,
        identity: 9,
        mouthNaturalness: 7,
        skinStability: 6,
        motion: 8,
        audio: 10,
      },
      note: "1,8 s: Lippen leicht zu spät.",
    }, [job]);

    expect(updated.qualityReview).toMatchObject({
      scores: {
        lipSync: 8,
        identity: 9,
        mouthNaturalness: 7,
        skinStability: 6,
        motion: 8,
        audio: 10,
      },
      note: "1,8 s: Lippen leicht zu spät.",
    });
    expect(Number.isFinite(Date.parse(updated.qualityReview!.updatedAt))).toBe(true);
    const sidecar = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));
    expect(sidecar.schemaVersion).toBe("ltx-studio-output.v6");
    expect(sidecar.changedAtMs).toEqual(expect.any(Number));
    expect(sidecar.fileId).toMatch(/^\d+$/);
    expect(sidecar.request).toEqual(job.request);
    expect(sidecar.qualityReview.scores.lipSync).toBe(8);

    const restored = new OutputLibrary(root).list([job]).find((output) => output.name === outputName)!;
    expect(restored.qualityReview).toEqual(updated.qualityReview);
  });

  it("refuses scorecards for external, changed, and non-speech outputs", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:00:00.000Z");
    const score = {
      scores: {
        lipSync: 5,
        identity: 5,
        mouthNaturalness: 5,
        skinStability: 5,
        motion: 5,
        audio: 5,
      },
      note: "",
    };
    const externalName = "external-score.mp4";
    await writeFile(join(root, externalName), "video");
    const library = new OutputLibrary(root);
    expect(() => library.setQualityReview(externalName, score, [])).toThrow("keine passende Studio-Provenienz");

    const silentName = "silent-score.mp4";
    await writeFile(join(root, silentName), "video");
    const silentJob = completedJob(silentName, completedAt.toISOString());
    silentJob.request.promptParts.dialogue = "Dialogtext allein macht diese Pipeline nicht zu einem Sprachvideo.";
    library.recordCompleted([silentJob]);
    expect(() => library.setQualityReview(silentName, score, [silentJob])).toThrow("Nur ein fertiges Sprachvideo");

    const changedName = "changed-score.mp4";
    await writeFile(join(root, changedName), "video");
    const speechJob = completedJob(changedName, completedAt.toISOString(), "audio-to-video");
    library.recordCompleted([speechJob]);
    await appendFile(join(root, changedName), "changed");
    expect(() => library.setQualityReview(changedName, score, [speechJob])).toThrow("nachträglich verändert");
  });

  it("resolves analysis targets only for unchanged Studio speech outputs", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:30:00.000Z");
    const outputName = "speech-analysis.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "lipdub");
    library.recordCompleted([job]);

    expect(library.resolveAnalysisTarget(outputName)).toMatchObject({
      outputName,
      jobId: job.id,
      request: { mode: "lipdub" },
    });

    const silentName = "silent-analysis.mp4";
    await writeFile(join(root, silentName), "video");
    const silentJob = completedJob(silentName, completedAt.toISOString(), "two-stage");
    library.recordCompleted([silentJob]);
    expect(() => library.resolveAnalysisTarget(silentName)).toThrow(
      "Nur ein fertiges Audio- oder LipDub-Video",
    );

    await appendFile(join(root, outputName), "changed");
    expect(() => library.resolveAnalysisTarget(outputName)).toThrow("nachträglich verändert");
  });

  it("persists verified identity evidence without persisting a reference path", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:35:00.000Z");
    const outputName = "speech-identity-evidence.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    job.identityEvidence = {
      schemaVersion: "ltx-studio-identity-evidence.v1",
      status: "verified",
      source: "image-conditioning",
      capturedAt: "2026-07-24T09:30:00.000Z",
      verifiedAt: "2026-07-24T09:35:00.000Z",
      reason: null,
      references: [{
        assetId: "6d6d624b-12c3-4a97-9e4e-152a69423b6c",
        kind: "image",
        sizeBytes: 1_024,
        modifiedAtMs: 1_721_813_400_000,
        changedAtMs: 1_721_813_400_001,
        fileId: "12345",
        sha256: "a".repeat(64),
      }],
    };

    library.recordCompleted([job]);
    expect(library.resolveAnalysisTarget(outputName).identityEvidence).toEqual(job.identityEvidence);
    const sidecar = await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8");
    expect(sidecar).not.toContain("/uploads/");
    expect(sidecar).toContain(job.identityEvidence.references[0].sha256);
  });

  it("persists full run provenance in the output sidecar and analysis target", async () => {
    const root = await outputRoot();
    const outputName = "speech-run-provenance.mp4";
    await writeFile(join(root, outputName), "video");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, "2026-07-24T09:35:00.000Z", "audio-to-video");
    job.runProvenance = runProvenance();

    library.recordCompleted([job]);

    expect(library.list([job]).find((output) => output.name === outputName)?.provenance).toEqual(job.runProvenance);
    expect(library.resolveAnalysisTarget(outputName).runProvenance).toEqual(job.runProvenance);
    const sidecar = await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8");
    expect(sidecar).toContain(job.runProvenance.fingerprint);
    expect(sidecar).toContain("input:conditioning-audio");
  });

  it("keeps a frozen experiment binding after the source job leaves bounded history", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:40:00.000Z");
    const outputName = "experiment-bound.mp4";
    await writeFile(join(root, outputName), "video");
    await utimes(join(root, outputName), completedAt, completedAt);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    const requestSha256 = sha256Json(job.request);
    job.experiment = {
      schemaVersion: "ltx-studio-experiment-run.v1",
      experimentId: "33333333-3333-4333-8333-333333333333",
      protocolSha256: "a".repeat(64),
      arm: "baseline",
      kind: "ablation",
      variableId: "a2v-guidance",
      changedRequestPaths: ["videoGuidance.modalityScale"],
      baselineRequestSha256: requestSha256,
      requestSha256,
      baselineJobId: null,
      baselineOutputName: outputName,
    };
    const library = new OutputLibrary(root);

    library.recordCompleted([job]);
    const output = library.list([]).find((item) => item.name === outputName);
    const sidecar = JSON.parse(await readFile(join(root, `${outputName}.ltx-settings.json`), "utf8"));

    expect(output?.experiment).toEqual(job.experiment);
    expect(output?.experimentRequestVerified).toBe(true);
    expect(sidecar).toMatchObject({
      schemaVersion: "ltx-studio-output.v6",
      experiment: job.experiment,
    });
  });

  it("drops an analysis when same-sized output bytes replace the original with restored mtime", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:45:00.000Z");
    const outputName = "content-revision.mp4";
    const outputPath = join(root, outputName);
    await writeFile(outputPath, "video-a");
    const library = new OutputLibrary(root);
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    library.recordCompleted([job]);
    const target = library.resolveAnalysisTarget(outputName);
    writeOutputAnalysis(root, {
      schemaVersion: "ltx-studio-output-analysis.v1",
      outputName,
      sizeBytes: target.sizeBytes,
      modifiedAtMs: target.modifiedAtMs,
      changedAtMs: target.changedAtMs,
      fileId: target.fileId,
      jobId: target.jobId,
      analysisId: "3c8a5dc6-8864-49f7-a639-85caef918888",
      attempt: 1,
      status: "failed",
      progress: 10,
      createdAt: "2026-07-24T09:45:01.000Z",
      startedAt: "2026-07-24T09:45:01.000Z",
      finishedAt: "2026-07-24T09:45:02.000Z",
      updatedAt: "2026-07-24T09:45:02.000Z",
      error: { code: "test", message: "Test record." },
      result: null,
    });
    expect(library.list([job]).find((output) => output.name === outputName)?.analysis).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(outputPath, "video-b");
    await utimes(outputPath, target.modifiedAtMs / 1_000, target.modifiedAtMs / 1_000);

    const replaced = library.list([job]).find((output) => output.name === outputName);
    expect(replaced?.settingsAvailable).toBe(false);
    expect(replaced?.analysis).toBeNull();
  });

  it("ignores invalid quality data while retaining valid v2 provenance", async () => {
    const root = await outputRoot();
    const completedAt = new Date("2026-07-24T09:00:00.000Z");
    const outputName = "invalid-scorecard.mp4";
    await writeFile(join(root, outputName), "video");
    const stats = await stat(join(root, outputName));
    const job = completedJob(outputName, completedAt.toISOString(), "audio-to-video");
    await writeFile(join(root, `${outputName}.ltx-settings.json`), JSON.stringify({
      schemaVersion: "ltx-studio-output.v2",
      outputName,
      jobId: job.id,
      completedAt: completedAt.toISOString(),
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      request: job.request,
      qualityReview: {
        scores: {
          lipSync: 11,
          identity: 9,
          mouthNaturalness: 7,
          skinStability: 6,
          motion: 8,
          audio: 10,
        },
        note: "invalid",
        updatedAt: completedAt.toISOString(),
      },
    }));

    const output = new OutputLibrary(root).list([job]).find((candidate) => candidate.name === outputName)!;
    expect(output.settingsAvailable).toBe(true);
    expect(output.request).toEqual(job.request);
    expect(output.qualityReview).toBeNull();
  });
});
