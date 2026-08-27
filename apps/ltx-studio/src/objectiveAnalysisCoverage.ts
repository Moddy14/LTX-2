import type { PublicObjectiveQualityAnalysis as ObjectiveQualityAnalysis } from "../shared/outputPublic.js";

export type PhonemeVisemeMeasurementWindow = {
  status: "none" | "full" | "partial";
  usableDurationSeconds: number | null;
  totalDurationSeconds: number | null;
  coverageRatio: number | null;
};

export function phonemeVisemeMeasurementWindow(
  result: ObjectiveQualityAnalysis | null,
): PhonemeVisemeMeasurementWindow {
  if (!result || !("phonemeViseme" in result) || !result.phonemeViseme?.measurement) {
    return {
      status: "none",
      usableDurationSeconds: null,
      totalDurationSeconds: result?.technical.durationSeconds ?? null,
      coverageRatio: null,
    };
  }

  const usableDurationSeconds = result.phonemeViseme.measurement.usableDurationSeconds;
  const totalDurationSeconds = result.technical.durationSeconds;
  if (totalDurationSeconds === null || totalDurationSeconds <= 0) {
    return {
      status: "partial",
      usableDurationSeconds,
      totalDurationSeconds,
      coverageRatio: null,
    };
  }

  const fps = result.technical.fps;
  const durationToleranceSeconds = Math.max(0.1, fps && fps > 0 ? 2 / fps : 0);
  const coverageRatio = Math.min(1, usableDurationSeconds / totalDurationSeconds);
  return {
    status: usableDurationSeconds + durationToleranceSeconds < totalDurationSeconds
      ? "partial"
      : "full",
    usableDurationSeconds,
    totalDurationSeconds,
    coverageRatio,
  };
}
