import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  publicOutputAnalysisResponse,
  publicProjectHistoryResponse,
  publicProjectListResponse,
  publicProjectResponse,
  publicStudioOutputResponse,
  publicStudioOutputsResponse,
  toPublicControlledExperiment,
  toPublicProjectRevisionEnvelope,
  toPublicProjectRunSummary,
  toPublicStudioOutput,
} from "../server/publicOutput.js";
import type { ControlledExperiment } from "../shared/experiments.js";
import type { OutputAnalysisRecord } from "../shared/objectiveQuality.js";
import type { StudioOutput } from "../shared/outputs.js";
import type { RunProvenance } from "../shared/provenance.js";
import type { ProjectRevisionEnvelope } from "../shared/projects.js";
import { validRequest } from "./fixtures.js";

const privateValues = {
  outputPath: "/private/publication/output.mp4",
  snapshotPath: "/private/authority/snapshot.mp4",
  runtimePath: "/private/runtime/python",
  inputDigest: "1".repeat(64),
  modelDigest: "2".repeat(64),
  evaluatorDigest: "3".repeat(64),
  dialogueDigest: "4".repeat(64),
  identityDigest: "5".repeat(64),
  publicationDigest: "6".repeat(64),
  projectRevisionDigest: "a1".repeat(32),
  projectRequestDigest: "b2".repeat(32),
  projectProvenanceDigest: "c3".repeat(32),
  projectSettingsDigest: "d4".repeat(32),
  projectExportDigest: "e5".repeat(32),
  previousProjectDigest: "f6".repeat(32),
};

function provenance(inputDigest = privateValues.inputDigest): RunProvenance {
  return {
    schemaVersion: "ltx-studio-run-provenance.v2",
    capturedAt: "2026-08-25T18:00:00.000Z",
    verifiedAt: "2026-08-25T18:01:00.000Z",
    files: [{
      role: "input:conditioning-audio",
      path: "/private/input/dialogue.wav",
      kind: "file",
      sizeBytes: 10,
      modifiedAtMs: 1,
      changedAtMs: 2,
      fileId: "701",
      sha256: inputDigest,
      entries: [],
    }, {
      role: "model:transformer",
      path: "/private/models/transformer.safetensors",
      kind: "file",
      sizeBytes: 20,
      modifiedAtMs: 3,
      changedAtMs: 4,
      fileId: "702",
      sha256: privateValues.modelDigest,
      entries: [],
    }],
    code: [{
      repositoryRoot: "/private/source/repository",
      commit: "7".repeat(40),
      dirty: false,
      trackedDiffSha256: "8".repeat(64),
      untracked: [],
      fingerprint: "9".repeat(64),
    }],
    runtime: {
      platform: "linux",
      architecture: "arm64",
      kernelRelease: "private-kernel",
      nodeVersion: "private-node",
      pythonExecutable: privateValues.runtimePath,
      pythonVersion: "3.12.0",
      packages: { private: "1.0" },
      ffmpegVersion: "private-ffmpeg",
      fingerprint: "a".repeat(64),
    },
    release: {
      sealed: true,
      verified: true,
      releaseDigest: "b".repeat(64),
      manifestSha256: "c".repeat(64),
      surfaceDigest: "d".repeat(64),
      sourceCommit: "e".repeat(40),
      runtimeInstallSealSha256: "f".repeat(64),
      runtimeTreeSha256: "0".repeat(64),
      runtimePolicySha256: "1".repeat(64),
      nodeExecutableSha256: "2".repeat(64),
      expectedHostTcbAttestationSha256: "3".repeat(64),
    },
    executionDecision: {
      privatePath: privateValues.snapshotPath,
      uid: 1000,
      gid: 1000,
      nlink: 1,
    } as never,
    fingerprint: "4".repeat(64),
  };
}

function analysis(): OutputAnalysisRecord {
  return {
    schemaVersion: "ltx-studio-output-analysis.v7",
    outputName: "public-test.mp4",
    sizeBytes: 1_024,
    modifiedAtMs: Date.parse("2026-08-25T18:00:00.000Z"),
    changedAtMs: Date.parse("2026-08-25T18:00:01.000Z"),
    fileId: "9001",
    jobId: "11111111-1111-4111-8111-111111111111",
    analysisId: "22222222-2222-4222-8222-222222222222",
    attempt: 1,
    status: "completed",
    progress: 100,
    createdAt: "2026-08-25T18:02:00.000Z",
    startedAt: "2026-08-25T18:02:01.000Z",
    finishedAt: "2026-08-25T18:02:02.000Z",
    updatedAt: "2026-08-25T18:02:02.000Z",
    error: null,
    evaluatorFingerprint: privateValues.evaluatorDigest,
    conditioningAudioSha256: privateValues.inputDigest,
    expectedDialogueSha256: privateValues.dialogueDigest,
    result: {
      schemaVersion: "ltx-studio-objective-quality.v7",
      analyzerVersion: "ffprobe-yunet5-sface-dual-avmotion-whisper-pv-artifact.v7",
      createdAt: "2026-08-25T18:02:02.000Z",
      status: "measured",
      technical: { durationSeconds: 5, fps: 24, frames: 121, hasAudio: true },
      face: { detectionCoverage: 1, mouthSkinWarpResidualP95: 0.02 },
      identity: {
        status: "measured",
        modelName: "OpenCV SFace 2021dec",
        modelSha256: privateValues.identityDigest,
        modelRevision: "a".repeat(40),
        preprocessingVersion: "yunet5-aligncrop-112-track.v2",
        cosineMedian: 0.91,
      },
      dialogue: {
        status: "measured",
        modelName: "OpenAI Whisper small",
        modelSha256: "7".repeat(64),
        expectedTranscriptSha256: privateValues.dialogueDigest,
        recognizedTranscript: `safe speech ${privateValues.snapshotPath} ${"8".repeat(64)}`,
        wordErrorRate: 0,
      },
      phonemeViseme: {
        status: "measurement-only",
        manifestReleaseId: "private-evaluator-release",
        manifestSha256: "9".repeat(64),
        productGo: { status: "blocked", reason: `private ${privateValues.runtimePath}` },
        measurement: {
          runnerFingerprint: "a".repeat(64),
          expectedDialogueSha256: privateValues.dialogueDigest,
          bilabialClosureF1: 0.8,
        },
      },
      capabilities: { identity: "sface-raw-measured" },
      findings: [{
        code: "private-path",
        level: "warning",
        message: `worker opened ${privateValues.snapshotPath}`,
      }],
      limitations: [`digest ${privateValues.publicationDigest}`],
      unexpectedPrivateDigest: privateValues.publicationDigest,
    },
  } as unknown as OutputAnalysisRecord;
}

function internalOutput(inputDigest = privateValues.inputDigest): StudioOutput {
  const request = validRequest("audio-to-video");
  request.outputName = "public-test.mp4";
  request.models.transformerPath = "/operator/models/ltx-2.5-transformer.safetensors";
  return {
    name: request.outputName,
    url: `/api/outputs/${request.outputName}`,
    sizeBytes: 1_024,
    modifiedAt: "2026-08-25T18:00:00.000Z",
    changedAt: "2026-08-25T18:00:01.000Z",
    fileId: "9001",
    jobId: "11111111-1111-4111-8111-111111111111",
    jobStatus: "completed",
    request,
    settingsAvailable: true,
    qualityReview: {
      scores: {
        lipSync: 8,
        identity: 9,
        mouthNaturalness: 8,
        skinStability: 9,
        motion: 7,
        audio: 8,
      },
      note: "Lokale Operator-Notiz /operator/reviews/shot-1.txt",
      updatedAt: "2026-08-25T18:03:00.000Z",
    },
    analysis: analysis(),
    provenance: provenance(inputDigest),
    experiment: {
      schemaVersion: "ltx-studio-experiment-run.v1",
      experimentId: "33333333-3333-4333-8333-333333333333",
      protocolSha256: "b".repeat(64),
      arm: "baseline",
      kind: "ablation",
      variableId: "a2v-guidance",
      changedRequestPaths: ["videoGuidance.modalityScale"],
      baselineRequestSha256: "c".repeat(64),
      requestSha256: "d".repeat(64),
      baselineJobId: null,
      baselineOutputName: request.outputName,
    },
    project: {
      schemaVersion: "ltx-studio-project-run.v1",
      projectId: "44444444-4444-4444-8444-444444444444",
      projectRevision: 1,
      projectRevisionSha256: "e".repeat(64),
      shotId: "55555555-5555-4555-8555-555555555555",
      requestRevisionId: "66666666-6666-4666-8666-666666666666",
      requestSha256: "f".repeat(64),
      continuity: null,
    },
    executionDecision: {
      schemaVersion: "ltx-studio-execution-decision.v5",
      privateOutputPath: privateValues.outputPath,
      outputPublication: { sha256: privateValues.publicationDigest },
    } as never,
    experimentRequestVerified: true,
  };
}

function allKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(allKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
}

function expectNoAuthorityLeak(value: unknown): void {
  const keys = allKeys(value);
  const forbidden = [
    "fileId", "deviceId", "uid", "gid", "inode", "dev", "nlink",
    "runProvenance", "executionDecision", "identityEvidence", "outputPublication",
    "provenanceFingerprint", "evaluatorFingerprint", "runnerFingerprint",
    "modelSha256", "manifestSha256", "expectedDialogueSha256", "expectedTranscriptSha256",
    "conditioningAudioSha256", "protocolSha256", "requestSha256", "settingsSha256",
    "projectRevisionSha256", "previousRevisionSha256", "settingsSidecarSha256", "exportSha256",
    "actorId", "sha256", "digest",
  ];
  for (const key of keys) {
    expect(forbidden.some((entry) => key.toLowerCase() === entry.toLowerCase()), key).toBe(false);
  }
  const serialized = JSON.stringify(value);
  for (const privateValue of Object.values(privateValues)) {
    expect(serialized, privateValue).not.toContain(privateValue);
  }
  expect(serialized).not.toMatch(/\/private\//);
}

function internalProjectEnvelope(
  exportDigest = privateValues.projectExportDigest,
): ProjectRevisionEnvelope {
  const request = validRequest("distilled");
  request.outputName = "project-public-test.mp4";
  request.models.transformerPath = "/operator/models/project-transformer.safetensors";
  const projectId = "77777777-7777-4777-8777-777777777777";
  const shotId = "88888888-8888-4888-8888-888888888888";
  const requestRevisionId = "99999999-9999-4999-8999-999999999999";
  const outputId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectRun = {
    schemaVersion: "ltx-studio-project-run.v1" as const,
    projectId,
    projectRevision: 2,
    projectRevisionSha256: privateValues.projectRevisionDigest,
    shotId,
    requestRevisionId,
    requestSha256: privateValues.projectRequestDigest,
    continuity: null,
  };
  return {
    schemaVersion: "ltx-studio-project-revision.v1",
    projectId,
    revision: 2,
    previousRevisionSha256: privateValues.previousProjectDigest,
    recordedAt: "2026-08-25T18:10:00.000Z",
    mutation: {
      type: "shot-output-recorded",
      actorId: "private-operator",
      shotId,
      outputId,
    },
    project: {
      schemaVersion: "ltx-studio-project.v1",
      id: projectId,
      title: "Public project",
      description: "Operator-authored continuity project",
      status: "active",
      createdAt: "2026-08-25T18:00:00.000Z",
      updatedAt: "2026-08-25T18:10:00.000Z",
      shots: [{
        id: shotId,
        order: 0,
        title: "Opening",
        status: "rendered",
        continuity: null,
        requestRevisions: [{
          id: requestRevisionId,
          parentRevisionId: null,
          reason: "initial",
          sourceOutputId: null,
          request,
          requestSha256: privateValues.projectRequestDigest,
          createdAt: "2026-08-25T18:01:00.000Z",
          actorId: "private-operator",
        }],
        currentRequestRevisionId: requestRevisionId,
        outputHistory: [{
          id: outputId,
          projectRun,
          requestRevisionId,
          requestSha256: privateValues.projectRequestDigest,
          jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          outputName: request.outputName,
          sizeBytes: 4_096,
          changedAt: "2026-08-25T18:09:00.000Z",
          fileId: "424242",
          provenanceFingerprint: privateValues.projectProvenanceDigest,
          settingsSidecarSha256: privateValues.projectSettingsDigest,
          exportSha256: exportDigest,
          recordedAt: "2026-08-25T18:10:00.000Z",
        }],
        approvedOutputId: null,
      }],
    },
  };
}

function internalExperiment(): ControlledExperiment {
  const request = validRequest("audio-to-video");
  return {
    schemaVersion: "ltx-studio-experiment.v1",
    id: "33333333-3333-4333-8333-333333333333",
    title: "Public experiment",
    claimScope: "development",
    status: "frozen",
    kind: "ablation",
    candidate: { variable: "a2v-guidance", value: 4 },
    changedRequestPaths: ["videoGuidance.modalityScale"],
    createdAt: "2026-08-25T18:00:00.000Z",
    frozenAt: "2026-08-25T18:01:00.000Z",
    supersededAt: null,
    supersededReason: null,
    replacementExperimentId: null,
    baselineEvidence: {
      outputName: "public-test.mp4",
      jobId: "11111111-1111-4111-8111-111111111111",
      sizeBytes: 1_024,
      changedAt: "2026-08-25T18:00:01.000Z",
      fileId: "9001",
      provenanceFingerprint: "1".repeat(64),
    },
    protocolSha256: "2".repeat(64),
    arms: [{
      arm: "baseline",
      request,
      requestSha256: "3".repeat(64),
      settingsSha256: "4".repeat(64),
      jobId: "11111111-1111-4111-8111-111111111111",
      attemptJobIds: [],
    }, {
      arm: "candidate",
      request: { ...request, outputName: "candidate.mp4" },
      requestSha256: "5".repeat(64),
      settingsSha256: "6".repeat(64),
      jobId: null,
      attemptJobIds: [],
    }],
  };
}

describe("public StudioOutput DTO v5.1", () => {
  it("recursively strips authority, stat identities and detail digests from both output responses", () => {
    const internal = internalOutput();
    const listPayload = publicStudioOutputsResponse([internal]);
    const reviewPayload = publicStudioOutputResponse(internal);

    expectNoAuthorityLeak(listPayload);
    expectNoAuthorityLeak(reviewPayload);
    expect(listPayload.outputs[0]).toEqual(reviewPayload.output);
    expect(reviewPayload.output.request?.models.transformerPath)
      .toBe("/operator/models/ltx-2.5-transformer.safetensors");
    expect(reviewPayload.output.qualityReview?.note).toContain("/operator/reviews/");
    expect(reviewPayload.output.analysis?.result).toMatchObject({
      identity: { cosineMedian: 0.91 },
      dialogue: { wordErrorRate: 0 },
      phonemeViseme: { measurement: { bilabialClosureF1: 0.8 } },
    });
    expect(JSON.stringify(reviewPayload.output.analysis?.result)).toContain("<redacted-path>");
    expect(JSON.stringify(reviewPayload.output.analysis?.result)).toContain("<redacted-digest>");
  });

  it("uses narrow equality tokens for same evidence and changes them for different evidence", () => {
    const first = toPublicStudioOutput(internalOutput());
    const same = toPublicStudioOutput(internalOutput());
    const different = toPublicStudioOutput(internalOutput("f".repeat(64)));

    expect(first.provenanceSummary?.equality).toEqual(same.provenanceSummary?.equality);
    expect(first.provenanceSummary?.equality.inputs)
      .not.toBe(different.provenanceSummary?.equality.inputs);
    expect(first.provenanceSummary?.equality.models)
      .toBe(different.provenanceSummary?.equality.models);
    expect(first.analysis?.equality).toEqual(same.analysis?.equality);
    for (const token of Object.values(first.provenanceSummary!.equality)) {
      if (token) expect(token).toMatch(/^eq1_[A-Za-z0-9_-]{32}$/);
    }
  });

  it("rotates process-scoped tokens after a mapper restart without changing equality semantics", async () => {
    const beforeRestart = toPublicStudioOutput(internalOutput());
    vi.resetModules();
    const restartedMapper = await import("../server/publicOutput.js");
    const afterRestart = restartedMapper.toPublicStudioOutput(internalOutput());
    const sameRestartedEvidence = restartedMapper.toPublicStudioOutput(internalOutput());

    expect(beforeRestart.provenanceSummary?.equality.run)
      .not.toBe(afterRestart.provenanceSummary?.equality.run);
    expect(afterRestart.provenanceSummary?.equality)
      .toEqual(sameRestartedEvidence.provenanceSummary?.equality);
  });

  it("sanitizes direct analysis responses instead of reopening the raw-analysis side channel", () => {
    const payload = publicOutputAnalysisResponse(analysis());
    expectNoAuthorityLeak(payload);
    expect(payload.analysis?.sourceSchemaVersion).toBe("ltx-studio-output-analysis.v7");
    expect(payload.analysis?.outputRevisionToken).toMatch(/^eq1_/);
  });

  it("removes baseline, protocol and request authority from every public experiment response", () => {
    const dto = toPublicControlledExperiment(internalExperiment());
    expectNoAuthorityLeak(dto);
    expect(dto.baselineEvidence).toEqual({
      outputName: "public-test.mp4",
      jobId: "11111111-1111-4111-8111-111111111111",
      sizeBytes: 1_024,
      changedAt: "2026-08-25T18:00:01.000Z",
    });
    expect(dto.protocolEqualityToken).toMatch(/^eq1_/);
    expect(dto.arms[0].request.models.transformerPath)
      .toBe(internalExperiment().arms[0].request.models.transformerPath);
  });

  it("recursively strips project authority from list, history, mutation and run responses", () => {
    const internal = internalProjectEnvelope();
    const listPayload = publicProjectListResponse({
      projects: [internal],
      warnings: [`private ${privateValues.snapshotPath} ${privateValues.projectExportDigest}`],
    });
    const historyPayload = publicProjectHistoryResponse([internal]);
    const mutationPayload = publicProjectResponse(internal);
    const runPayload = { project: toPublicProjectRunSummary(
      internal.project.shots[0]!.outputHistory[0]!.projectRun,
    ) };

    for (const payload of [listPayload, historyPayload, mutationPayload, runPayload]) {
      expectNoAuthorityLeak(payload);
    }
    expect(listPayload.projects[0]).toEqual(historyPayload.revisions[0]);
    expect(historyPayload.revisions[0]).toEqual(mutationPayload.project);
    expect(listPayload.warnings[0]).toContain("<redacted-path>");
    expect(listPayload.warnings[0]).toContain("<redacted-digest>");
    expect(mutationPayload.project.project.shots[0]?.requestRevisions[0]?.request.models.transformerPath)
      .toBe("/operator/models/project-transformer.safetensors");
    expect(mutationPayload.project.project.shots[0]?.outputHistory[0]).toMatchObject({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      revisionToken: expect.stringMatching(/^eq1_/),
      equality: {
        request: expect.stringMatching(/^eq1_/),
        provenance: expect.stringMatching(/^eq1_/),
        settings: expect.stringMatching(/^eq1_/),
        export: expect.stringMatching(/^eq1_/),
      },
    });
  });

  it("rotates project tokens on mapper restart while stable IDs keep approval and mutation semantics", async () => {
    const internal = internalProjectEnvelope();
    const beforeRestart = toPublicProjectRevisionEnvelope(internal);
    vi.resetModules();
    const restartedMapper = await import("../server/publicOutput.js");
    const afterRestart = restartedMapper.toPublicProjectRevisionEnvelope(internal);
    const sameRestarted = restartedMapper.toPublicProjectRevisionEnvelope(internal);

    expect(beforeRestart.revisionToken).not.toBe(afterRestart.revisionToken);
    expect(afterRestart.revisionToken).toBe(sameRestarted.revisionToken);
    expect(beforeRestart.revision).toBe(afterRestart.revision);
    expect(beforeRestart.projectId).toBe(afterRestart.projectId);
    expect(beforeRestart.project.shots[0]?.id).toBe(afterRestart.project.shots[0]?.id);
    expect(beforeRestart.project.shots[0]?.outputHistory[0]?.id)
      .toBe(afterRestart.project.shots[0]?.outputHistory[0]?.id);
    expect(beforeRestart.project.shots[0]?.approvedOutputId)
      .toBe(afterRestart.project.shots[0]?.approvedOutputId);

    const changedExport = restartedMapper.toPublicProjectRevisionEnvelope(
      internalProjectEnvelope("0a".repeat(32)),
    );
    expect(afterRestart.project.shots[0]?.outputHistory[0]?.equality.export)
      .not.toBe(changedExport.project.shots[0]?.outputHistory[0]?.equality.export);
    expect(afterRestart.project.shots[0]?.outputHistory[0]?.equality.request)
      .toBe(changedExport.project.shots[0]?.outputHistory[0]?.equality.request);
  });

  it("routes output, quality, analysis and experiment REST responses through allowlists", () => {
    const source = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");
    expect(source).toContain("app.get(\"/api/outputs\", (_request, response) => response.json(publicOutputListResponse()))");
    expect(source).toContain("collectPublicT2aAudioAnalyses(");
    expect(source).toContain("response.json(publicStudioOutputResponse(output))");
    expect(source).toContain("publicOutputAnalysisResponse(analyses.get(filename))");
    expect(source).toContain("json(publicOutputAnalysisResponse(analysis))");
    expect(source).toContain("toPublicControlledExperiments(available.experiments)");
    expect(source).toContain("toPublicControlledExperiment(experiments.create");
    expect(source).toContain("publicProjectListResponse(projects.listAvailable())");
    expect(source).toContain("publicProjectHistoryResponse(projects.history");
    expect(source.match(/publicProjectResponse\(/g)).toHaveLength(6);
    expect(source).toContain("project: toPublicProjectRunSummary(run.binding)");
    expect(source).toContain("projects.preflightOutputCapture(");
    expect(source).toContain("evidence.requestSha256 !== expectedRequestSha256");
    expect(source).toContain("jobs.create(run.request, { project: run.binding })");
    expect(source).not.toContain("response.json({ output })");
    expect(source).not.toContain("response.json({ analysis: analyses.get(filename) })");
    expect(source).not.toContain("response.json(experiments.listAvailable())");
    expect(source).not.toContain("response.json(projects.listAvailable())");
    expect(source).not.toContain("project: run.binding,");
  });
});
