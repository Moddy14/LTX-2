import { describe, expect, it } from "vitest";

import { createDefaultRequest } from "../shared/pipelines.js";
import type {
  PublicOutputAnalysisRecord as OutputAnalysisRecord,
  PublicStudioOutput as StudioOutput,
} from "../shared/outputPublic.js";
import type { JobQualityReview } from "../shared/quality.js";
import type { T2aAudioPublicAnalysisRecord } from "../shared/t2aAudioPublic.js";
import {
  mergeOutputAnalysis,
  mergeOutputRefresh,
  mergeT2aAudioAnalysis,
} from "../src/outputState.js";
import { isSpeechQualityCandidate } from "../src/qualityCandidates.js";

function review(updatedAt: string, lipSync = 8): JobQualityReview {
  return {
    scores: {
      lipSync,
      identity: 8,
      mouthNaturalness: 8,
      skinStability: 8,
      motion: 8,
      audio: 8,
    },
    note: "",
    updatedAt,
  };
}

function output(qualityReview: JobQualityReview | null): StudioOutput {
  return {
    name: "speech.mp4",
    url: "/api/outputs/speech.mp4",
    sizeBytes: 1_000,
    modifiedAt: "2026-07-24T18:00:00.000Z",
    changedAt: "2026-07-24T18:00:01.000Z",
    revisionToken: "eq1_output-revision",
    jobId: "2c8a5dc6-8864-49f7-a639-85caef919999",
    jobStatus: "completed",
    request: createDefaultRequest("audio-to-video"),
    settingsAvailable: true,
    qualityReview,
    analysis: null,
    audioAnalysis: null,
    provenanceSummary: null,
    experiment: null,
    project: null,
    experimentRequestVerified: false,
  };
}

function analysis(updatedAt: string, status: OutputAnalysisRecord["status"] = "running"): OutputAnalysisRecord {
  return {
    schemaVersion: "ltx-studio-public-output-analysis.v1",
    sourceSchemaVersion: "ltx-studio-output-analysis.v1",
    outputName: "speech.mp4",
    outputRevisionToken: "eq1_output-revision",
    jobId: "2c8a5dc6-8864-49f7-a639-85caef919999",
    analysisId: "3c8a5dc6-8864-49f7-a639-85caef919999",
    attempt: 1,
    status,
    progress: status === "completed" ? 100 : 10,
    createdAt: "2026-07-24T18:00:01.000Z",
    startedAt: "2026-07-24T18:00:02.000Z",
    finishedAt: status === "completed" ? updatedAt : null,
    updatedAt,
    error: null,
    equality: { evaluator: null, expectedDialogue: null, identityModel: null },
    result: null,
  };
}

function audioOutput(): StudioOutput {
  return {
    ...output(null),
    name: "speech.wav",
    url: "/api/outputs/speech.wav",
    request: createDefaultRequest("text-to-audio"),
    analysis: null,
  };
}

function audioAnalysis(
  updatedAt: string,
  status: "queued" | "running" | "cancelled" = "running",
  outputRevisionToken = "eq1_output-revision",
): T2aAudioPublicAnalysisRecord {
  return {
    schemaVersion: "ltx-studio-t2a-audio-analysis-public.v4",
    analysisKind: "t2a-audio-qa",
    mediaKind: "audio",
    outputName: "speech.wav",
    outputRevisionToken,
    jobId: "2c8a5dc6-8864-49f7-a639-85caef919999",
    analysisId: "4c8a5dc6-8864-49f7-a639-85caef919999",
    claimScope: "sealed-release",
    attempt: 1,
    status,
    progress: status === "queued" ? 0 : 10,
    createdAt: "2026-07-24T18:00:01.000Z",
    startedAt: status === "queued" ? null : "2026-07-24T18:00:02.000Z",
    finishedAt: status === "cancelled" ? updatedAt : null,
    updatedAt,
    error: status === "cancelled"
      ? { code: "cancelled", message: "Audioanalyse wurde abgebrochen." }
      : null,
    result: null,
  };
}

describe("quality output refresh", () => {
  it("keeps a newer saved scorecard when an older poll finishes late", () => {
    const current = output(review("2026-07-24T18:05:00.000Z", 9));
    const lateWithoutReview = output(null);
    const lateOlderReview = output(review("2026-07-24T18:04:00.000Z", 3));

    expect(mergeOutputRefresh([current], [lateWithoutReview])[0].qualityReview).toEqual(current.qualityReview);
    expect(mergeOutputRefresh([current], [lateOlderReview])[0].qualityReview).toEqual(current.qualityReview);
  });

  it("accepts a newer server review and never carries a review onto a replaced MP4", () => {
    const current = output(review("2026-07-24T18:05:00.000Z", 7));
    const newer = output(review("2026-07-24T18:06:00.000Z", 10));
    const replaced = {
      ...output(null),
      sizeBytes: 2_000,
      modifiedAt: "2026-07-24T18:07:00.000Z",
      revisionToken: "eq1_replaced-revision",
    };

    expect(mergeOutputRefresh([current], [newer])[0].qualityReview).toEqual(newer.qualityReview);
    expect(mergeOutputRefresh([current], [replaced])[0].qualityReview).toBeNull();
  });

  it("keeps only the newest analysis for the same MP4 revision", () => {
    const current = { ...output(null), analysis: analysis("2026-07-24T18:05:00.000Z") };
    const older = { ...output(null), analysis: analysis("2026-07-24T18:04:00.000Z") };
    const newer = { ...output(null), analysis: analysis("2026-07-24T18:06:00.000Z", "completed") };

    expect(mergeOutputRefresh([current], [older])[0].analysis).toEqual(current.analysis);
    expect(mergeOutputRefresh([current], [newer])[0].analysis).toEqual(newer.analysis);
    expect(mergeOutputAnalysis(current, older.analysis!)).toEqual(current);
    expect(mergeOutputAnalysis(current, newer.analysis!).analysis).toEqual(newer.analysis);
  });

  it("treats an authoritative null as revocation for the same media revision", () => {
    const video = { ...output(null), analysis: analysis("2026-07-24T18:05:00.000Z") };
    const audio = {
      ...audioOutput(),
      audioAnalysis: audioAnalysis("2026-07-24T18:05:00.000Z"),
    };

    expect(mergeOutputRefresh([video], [output(null)])[0].analysis).toBeNull();
    expect(mergeOutputRefresh([audio], [audioOutput()])[0].audioAnalysis).toBeNull();
  });

  it("never attaches an analysis response to a replaced MP4", () => {
    const replaced = {
      ...output(null),
      sizeBytes: 2_000,
      modifiedAt: "2026-07-24T18:07:00.000Z",
      revisionToken: "eq1_replaced-revision",
    };

    expect(mergeOutputAnalysis(replaced, analysis("2026-07-24T18:08:00.000Z"))).toEqual(replaced);
    expect(mergeOutputRefresh(
      [{ ...output(null), analysis: analysis("2026-07-24T18:06:00.000Z") }],
      [replaced],
    )[0].analysis).toBeNull();
  });

  it("keeps a running state when a same-timestamp queued response arrives late", () => {
    const timestamp = "2026-07-24T18:05:00.000Z";
    const queued = {
      ...analysis(timestamp, "queued"),
      progress: 0,
      startedAt: null,
    };
    const running = analysis(timestamp, "running");
    const current = { ...output(null), analysis: running };

    expect(mergeOutputAnalysis(current, queued).analysis).toEqual(running);
    expect(mergeOutputRefresh([current], [{ ...output(null), analysis: queued }])[0].analysis).toEqual(running);
  });

  it("prefers a newer analysis attempt even when timestamps tie", () => {
    const timestamp = "2026-07-24T18:05:00.000Z";
    const completed = { ...analysis(timestamp, "completed"), analysisId: "3c8a5dc6-8864-49f7-a639-85caef919998" };
    const rerun = {
      ...analysis(timestamp, "queued"),
      analysisId: "3c8a5dc6-8864-49f7-a639-85caef919997",
      attempt: 2,
      progress: 0,
      startedAt: null,
      finishedAt: null,
    };
    const current = { ...output(null), analysis: completed };

    expect(mergeOutputAnalysis(current, rerun).analysis).toEqual(rerun);
  });

  it("merges T2A analysis only for the same WAV job and opaque revision", () => {
    const currentAnalysis = audioAnalysis("2026-07-24T18:05:00.000Z");
    const current = { ...audioOutput(), audioAnalysis: currentAnalysis };
    const queued = audioAnalysis("2026-07-24T18:04:00.000Z", "queued");
    const terminal = audioAnalysis("2026-07-24T18:06:00.000Z", "cancelled");

    expect(mergeOutputRefresh([current], [{ ...audioOutput(), audioAnalysis: queued }])[0].audioAnalysis)
      .toEqual(currentAnalysis);
    expect(mergeT2aAudioAnalysis(current, queued)).toEqual(current);
    expect(mergeT2aAudioAnalysis(current, terminal).audioAnalysis).toEqual(terminal);
  });

  it("never attaches a T2A response to a replaced WAV or another job", () => {
    const replaced = { ...audioOutput(), revisionToken: "eq1_replaced-revision" };
    const anotherJob = {
      ...audioAnalysis("2026-07-24T18:08:00.000Z"),
      jobId: "5c8a5dc6-8864-49f7-a639-85caef919999",
    };

    expect(mergeT2aAudioAnalysis(replaced, audioAnalysis(
      "2026-07-24T18:08:00.000Z",
    ))).toEqual(replaced);
    expect(mergeT2aAudioAnalysis(audioOutput(), anotherJob)).toEqual(audioOutput());
    expect(mergeOutputRefresh(
      [{ ...audioOutput(), audioAnalysis: audioAnalysis("2026-07-24T18:06:00.000Z") }],
      [replaced],
    )[0].audioAnalysis).toBeNull();
  });

  it("offers the scorecard for external-audio and native-dialogue outputs", () => {
    const audioOutput = output(null);
    expect(isSpeechQualityCandidate(audioOutput)).toBe(true);
    expect(isSpeechQualityCandidate({
      ...audioOutput,
      request: createDefaultRequest("lipdub"),
    })).toBe(true);
    const twoStage = createDefaultRequest("two-stage");
    twoStage.promptParts.dialogue = "Dieser Dialogtext wird nativ gesprochen.";
    expect(isSpeechQualityCandidate({ ...audioOutput, request: twoStage })).toBe(true);
    twoStage.promptParts.dialogue = "";
    twoStage.prompt = "A silent portrait.";
    expect(isSpeechQualityCandidate({ ...audioOutput, request: twoStage })).toBe(false);
  });
});
