import { describe, expect, it } from "vitest";

import { buildObjectiveQualityAnalysis } from "../server/outputAnalysis.js";
import type { ObjectiveWorkerResult } from "../shared/objectiveQuality.js";

function worker(overrides: Partial<ObjectiveWorkerResult> = {}): ObjectiveWorkerResult {
  return {
    technical: {
      durationSeconds: 4,
      fps: 24,
      frames: 96,
      hasAudio: true,
      constantFrameRate: true,
      audioVideoDurationDeltaSeconds: 0.001,
      audioVideoStartDeltaSeconds: 0,
    },
    face: {
      sampledFrames: 96,
      detectedFrames: 96,
      validGeometryFrames: 96,
      detectionCoverage: 1,
      geometryCoverage: 1,
      medianConfidence: 0.95,
      medianEyeSpanPixels: 80,
      medianFaceAreaRatio: 0.15,
      noseVelocityP95PerSecond: 2.3,
      noseAccelerationP95PerSecond2: 70,
      mouthAngleMedianDegrees: 1.2,
      mouthAngleVelocityP95DegreesPerSecond: 33,
      mouthSpanCoefficientOfVariation: 0.024,
    },
    identity: {
      status: "measured",
      error: null,
      modelName: "OpenCV SFace 2021dec",
      modelSha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
      modelRevision: "3d7082438a6e4551e840c9b2bb60b71e8da4b524",
      preprocessingVersion: "yunet5-aligncrop-112.v1",
      embeddingDimensions: 128,
      referenceCount: 1,
      sampledReferenceFrames: 1,
      embeddedReferenceFrames: 1,
      sampledOutputFrames: 96,
      matchedOutputFrames: 96,
      outputCoverage: 1,
      ambiguousOutputFrames: 0,
      referenceSelfConsistencyMedian: 1,
      referenceSelfConsistencyP10: 1,
      cosineMedian: 0.87,
      cosineP10: 0.84,
      cosineMinimum: 0.8,
      outputTemporalConsistencyMedian: 0.99,
    },
    ...overrides,
  };
}

describe("objective output quality", () => {
  it("reports real SFace raw measurements without inventing SyncNet or SOTA scores", () => {
    const result = buildObjectiveQualityAnalysis(worker(), "2026-07-24T18:10:00.000Z");

    expect(result.status).toBe("measured");
    expect(result.capabilities).toEqual({
      avSync: "syncnet-required",
      identity: "sface-raw-measured",
      dialogue: "whisper-not-run",
    });
    expect(result.face?.noseVelocityP95PerSecond).toBe(2.3);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "calibration-required" }));
    expect(result).not.toHaveProperty("score");
    expect(result).not.toHaveProperty("rating");
    expect(result.capabilities.avSync).not.toBe("measured");
    expect(result.schemaVersion).toBe("ltx-studio-objective-quality.v2");
    if (result.schemaVersion === "ltx-studio-objective-quality.v2") {
      expect(result.identity.cosineP10).toBe(0.84);
    }
  });

  it("marks missing audio and insufficient face geometry explicitly", () => {
    const baseline = worker();
    const result = buildObjectiveQualityAnalysis(worker({
      technical: {
        ...baseline.technical,
        hasAudio: false,
        constantFrameRate: false,
      },
      face: {
        ...baseline.face,
        sampledFrames: 12,
        detectedFrames: 3,
        validGeometryFrames: 2,
        detectionCoverage: 0.25,
        geometryCoverage: 1 / 6,
      },
    }));

    expect(result.status).toBe("insufficient");
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "audio-missing", level: "error" }),
      expect.objectContaining({ code: "variable-frame-rate", level: "warning" }),
      expect.objectContaining({ code: "face-detection-incomplete", level: "error" }),
      expect.objectContaining({ code: "landmark-geometry-incomplete", level: "error" }),
    ]));
  });

  it("flags absolute audio/video timing drift above 40 ms", () => {
    const baseline = worker();
    const result = buildObjectiveQualityAnalysis(worker({
      technical: {
        ...baseline.technical,
        audioVideoStartDeltaSeconds: 0.041,
        audioVideoDurationDeltaSeconds: 0.125,
      },
    }));

    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "audio-video-start-drift" }),
      expect.objectContaining({ code: "audio-video-duration-drift" }),
    ]));
  });

  it("does not call unknown or variable frame timing a sufficient measurement", () => {
    const baseline = worker();
    for (const constantFrameRate of [null, false] as const) {
      const result = buildObjectiveQualityAnalysis(worker({
        technical: {
          ...baseline.technical,
          constantFrameRate,
        },
      }));
      expect(result.status).toBe("insufficient");
    }
  });

  it("reports an SFace worker failure as an insufficient measurement with its own capability", () => {
    const baseline = worker();
    const result = buildObjectiveQualityAnalysis(worker({
      identity: {
        ...baseline.identity,
        status: "failed",
        error: "RuntimeError: SFace snapshot changed during analysis",
        cosineMedian: null,
        cosineP10: null,
        cosineMinimum: null,
      },
    }));

    expect(result.status).toBe("insufficient");
    expect(result.capabilities.identity).toBe("sface-failed");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "identity-measurement-failed",
      level: "warning",
    }));
  });
});
