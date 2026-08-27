import { describe, expect, it } from "vitest";

import {
  collectPublicT2aAudioAnalyses,
  publicT2aAudioAnalysisResponse,
  toBoundPublicT2aAudioAnalysis,
} from "../server/publicT2aAudio.js";
import { toPublicStudioOutput } from "../server/publicOutput.js";
import {
  t2aAudioAnalysisRecordSchema,
  type T2aAudioAnalysisRecord,
} from "../server/t2aAudioAnalysis.js";
import type { StudioOutput } from "../shared/outputs.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const modifiedAtMs = Date.parse("2026-08-26T08:00:00.000Z");
const changedAtMs = Date.parse("2026-08-26T08:00:01.000Z");

function record(
  revisionOverrides: Partial<T2aAudioAnalysisRecord["targetBinding"]["outputRevision"]> = {},
): T2aAudioAnalysisRecord {
  return t2aAudioAnalysisRecordSchema.parse({
    schemaVersion: "ltx-studio-t2a-audio-analysis.v3",
    analysisKind: "t2a-audio-qa",
    mediaKind: "audio",
    analysisId: "22222222-2222-4222-8222-222222222222",
    claimScope: "sealed-release",
    evaluatorFingerprint: "1".repeat(64),
    targetBinding: {
      outputName: "dialog-v3.wav",
      jobId,
      outputSha256: "2".repeat(64),
      outputRevision: {
        sizeBytes: 96_044,
        modifiedAtMs,
        changedAtMs,
        fileId: "9001",
        deviceId: "8",
        mode: 0o100600,
        uid: 1_000,
        gid: 1_000,
        nlink: 1,
        ...revisionOverrides,
      },
      publicationSha256: "3".repeat(64),
      executionDecisionSha256: "4".repeat(64),
      rawRequestSha256: "5".repeat(64),
      normalizedRequestSha256: "6".repeat(64),
      dialogueSha256: "7".repeat(64),
      settingsSha256: "8".repeat(64),
      settingsRevision: {
        sizeBytes: 4_096,
        modifiedAtMs,
        changedAtMs,
        fileId: "9002",
        deviceId: "8",
        mode: 0o100600,
        uid: 1_000,
        gid: 1_000,
        nlink: 1,
      },
      peakCeilingDbfs: -3,
    },
    attempt: 1,
    status: "failed",
    progress: 10,
    createdAt: "2026-08-26T08:00:02.000Z",
    startedAt: "2026-08-26T08:00:03.000Z",
    finishedAt: "2026-08-26T08:00:04.000Z",
    updatedAt: "2026-08-26T08:00:04.000Z",
    error: {
      code: "analysis-failed",
      message: `private /home/moddy/runtime ${"9".repeat(64)}`,
    },
    result: null,
  });
}

function output(overrides: Partial<StudioOutput> = {}): StudioOutput {
  return {
    name: "dialog-v3.wav",
    url: "/api/outputs/dialog-v3.wav",
    sizeBytes: 96_044,
    modifiedAt: new Date(modifiedAtMs).toISOString(),
    changedAt: new Date(changedAtMs).toISOString(),
    fileId: "9001",
    jobId,
    jobStatus: "completed",
    request: null,
    settingsAvailable: true,
    qualityReview: null,
    analysis: null,
    provenance: null,
    experiment: null,
    project: null,
    executionDecision: null,
    experimentRequestVerified: false,
    ...overrides,
  };
}

describe("public T2A audio binding", () => {
  it("uses exactly the same opaque revision token as the public WAV output", () => {
    const publicAnalysis = toBoundPublicT2aAudioAnalysis(record());
    const publicOutput = toPublicStudioOutput(output(), publicAnalysis);

    expect(publicAnalysis.outputRevisionToken).toBe(publicOutput.revisionToken);
    expect(publicAnalysis.outputRevisionToken).toMatch(/^eq1_[A-Za-z0-9_-]{32}$/u);
    expect(publicOutput.audioAnalysis).toEqual(publicAnalysis);
  });

  it("binds a sub-ms private revision to the rounded Stats ISO revision", () => {
    const subMillisecondModifiedAtMs = modifiedAtMs + 0.9373;
    const subMillisecondChangedAtMs = changedAtMs + 0.9373;
    const current = record({
      modifiedAtMs: subMillisecondModifiedAtMs,
      changedAtMs: subMillisecondChangedAtMs,
    });
    const serializedOutput = output({
      // node:fs Stats Date serialization rounds these values up to the next ms.
      modifiedAt: new Date(Math.round(subMillisecondModifiedAtMs)).toISOString(),
      changedAt: new Date(Math.round(subMillisecondChangedAtMs)).toISOString(),
    });

    const publicAnalysis = toBoundPublicT2aAudioAnalysis(current);
    const publicOutput = toPublicStudioOutput(serializedOutput, publicAnalysis);
    expect(publicAnalysis.outputRevisionToken).toBe(publicOutput.revisionToken);
    expect(collectPublicT2aAudioAnalyses([serializedOutput], () => current).get("dialog-v3.wav"))
      .toEqual(publicAnalysis);

    const adjacentMillisecond = output({
      ...serializedOutput,
      modifiedAt: new Date(Math.round(subMillisecondModifiedAtMs) + 1).toISOString(),
    });
    expect(collectPublicT2aAudioAnalyses([adjacentMillisecond], () => current).size).toBe(0);
  });

  it("does not attach an analysis to a replaced or differently owned WAV", () => {
    const current = record();
    expect(collectPublicT2aAudioAnalyses([output()], () => current).has("dialog-v3.wav"))
      .toBe(true);
    expect(collectPublicT2aAudioAnalyses([
      output({ changedAt: "2026-08-26T08:00:02.000Z" }),
    ], () => current).size).toBe(0);
    expect(collectPublicT2aAudioAnalyses([
      output({ jobId: "33333333-3333-4333-8333-333333333333" }),
    ], () => current).size).toBe(0);
  });

  it("keeps output listing available when the private analysis resolver fails", () => {
    expect(collectPublicT2aAudioAnalyses([output()], () => {
      throw new Error("private evaluator temporarily unavailable");
    })).toEqual(new Map());
  });

  it("publishes only catalogued errors and no authority digests or paths", () => {
    const serialized = JSON.stringify(publicT2aAudioAnalysisResponse(record()));
    expect(serialized).toContain("T2A-Audioanalyse konnte nicht sicher abgeschlossen werden.");
    expect(serialized).not.toContain("/home/moddy/runtime");
    expect(serialized).not.toContain("9".repeat(64));
    expect(serialized).not.toContain("targetBinding");
    expect(serialized).not.toContain("evaluatorFingerprint");
  });
});
