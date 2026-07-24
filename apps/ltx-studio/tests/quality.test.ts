import { describe, expect, it } from "vitest";

import {
  jobQualityReviewSchema,
  qualityReviewAverage,
  qualityReviewInputSchema,
} from "../shared/quality.js";

const validInput = {
  scores: {
    lipSync: 0,
    identity: 10,
    mouthNaturalness: 4,
    skinStability: 6,
    motion: 8,
    audio: 2,
  },
  note: "Gezielte Beobachtung.",
};

describe("speech quality scorecard", () => {
  it("accepts all integer boundary values and calculates the six-score average", () => {
    expect(qualityReviewInputSchema.parse(validInput)).toEqual(validInput);
    expect(qualityReviewAverage({
      scores: validInput.scores,
    })).toBe(5);
  });

  it.each([
    ["below range", { ...validInput, scores: { ...validInput.scores, lipSync: -1 } }],
    ["above range", { ...validInput, scores: { ...validInput.scores, identity: 11 } }],
    ["fraction", { ...validInput, scores: { ...validInput.scores, audio: 4.5 } }],
    ["extra score", { ...validInput, scores: { ...validInput.scores, other: 3 } }],
    ["extra root field", { ...validInput, unexpected: true }],
    ["NUL note", { ...validInput, note: "bad\0note" }],
    ["long note", { ...validInput, note: "x".repeat(2_001) }],
  ])("rejects %s", (_name, input) => {
    expect(qualityReviewInputSchema.safeParse(input).success).toBe(false);
  });

  it("requires a server timestamp for persisted reviews", () => {
    expect(jobQualityReviewSchema.safeParse(validInput).success).toBe(false);
    expect(jobQualityReviewSchema.safeParse({
      ...validInput,
      updatedAt: "2026-07-24T09:00:00.000Z",
    }).success).toBe(true);
  });
});
