import { describe, expect, it } from "vitest";

import type { ObjectiveQualityAnalysis } from "../shared/objectiveQuality.js";
import { phonemeVisemeMeasurementWindow } from "../src/objectiveAnalysisCoverage.js";

function resultWithDurations(total: number | null, usable: number): ObjectiveQualityAnalysis {
  return {
    schemaVersion: "ltx-studio-objective-quality.v4",
    technical: { durationSeconds: total, fps: 24 },
    phonemeViseme: { measurement: { usableDurationSeconds: usable } },
  } as ObjectiveQualityAnalysis;
}

describe("phonemeVisemeMeasurementWindow", () => {
  it("marks a five-second measurement of a ten-second clip as partial", () => {
    expect(phonemeVisemeMeasurementWindow(resultWithDurations(10.04, 5))).toEqual({
      status: "partial",
      usableDurationSeconds: 5,
      totalDurationSeconds: 10.04,
      coverageRatio: 5 / 10.04,
    });
  });

  it("allows normal frame-boundary rounding for a full measurement", () => {
    expect(phonemeVisemeMeasurementWindow(resultWithDurations(4.041_667, 4)).status).toBe("full");
  });

  it("fails closed when the total clip duration is unavailable", () => {
    expect(phonemeVisemeMeasurementWindow(resultWithDurations(null, 4))).toMatchObject({
      status: "partial",
      coverageRatio: null,
    });
  });
});
