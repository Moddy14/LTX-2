import { describe, expect, it } from "vitest";

import { createDefaultRequest } from "../shared/pipelines.js";
import type { JobQualityReview } from "../shared/quality.js";
import type { StudioOutput } from "../shared/outputs.js";
import { mergeOutputRefresh } from "../src/outputState.js";
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
    jobId: "2c8a5dc6-8864-49f7-a639-85caef919999",
    jobStatus: "completed",
    request: createDefaultRequest("audio-to-video"),
    settingsAvailable: true,
    qualityReview,
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
    const replaced = { ...output(null), sizeBytes: 2_000, modifiedAt: "2026-07-24T18:07:00.000Z" };

    expect(mergeOutputRefresh([current], [newer])[0].qualityReview).toEqual(newer.qualityReview);
    expect(mergeOutputRefresh([current], [replaced])[0].qualityReview).toBeNull();
  });

  it("offers the scorecard only for native audio-to-video and LipDub outputs", () => {
    const audioOutput = output(null);
    expect(isSpeechQualityCandidate(audioOutput)).toBe(true);
    expect(isSpeechQualityCandidate({
      ...audioOutput,
      request: createDefaultRequest("lipdub"),
    })).toBe(true);
    const twoStage = createDefaultRequest("two-stage");
    twoStage.promptParts.dialogue = "Dieser Dialogtext allein erzeugt keinen Sprachpipeline-Vertrag.";
    expect(isSpeechQualityCandidate({ ...audioOutput, request: twoStage })).toBe(false);
  });
});
