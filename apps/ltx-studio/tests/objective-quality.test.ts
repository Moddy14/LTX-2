import { describe, expect, it } from "vitest";

import { buildObjectiveQualityAnalysis } from "../server/outputAnalysis.js";
import {
  objectiveWorkerResultSchema,
  type ObjectiveWorkerResult,
} from "../shared/objectiveQuality.js";
import { unavailablePhonemeVisemeResult } from "../shared/phonemeVisemeEvaluator.js";
import { notApplicableDialogueEvaluation } from "../shared/dialogueEvaluator.js";

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
      mouthSkinPairCount: 95,
      mouthSkinPairCoverage: 1,
      mouthSkinWarpResidualMedian: 0.018,
      mouthSkinWarpResidualP95: 0.041,
      mouthSkinLuminanceDeltaP95: 0.012,
      mouthSkinFlowDeformationP95: 0.067,
      mouthSkinValidPixelCoverageP10: 0.91,
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
    avSync: {
      status: "measured",
      error: null,
      method: "classical-audio-mouth-motion.v1",
      sampledVideoFrames: 96,
      validMotionPairs: 95,
      motionCoverage: 1,
      audioWindowCount: 400,
      audioActivityRatio: 0.72,
      usableAudioActivitySeconds: 2.8,
      mouthCoverageDuringAudioActivity: 1,
      usableWindowCount: 5,
      estimatedAudioLeadMilliseconds: 30,
      lagSearchLimitMilliseconds: 500,
      lagResolutionMilliseconds: 42,
      effectiveVideoSampleMilliseconds: 41.667,
      correlationPeak: 0.67,
      zeroLagCorrelation: 0.61,
      peakProminence: 0.12,
      peakWidthMilliseconds: 84,
      featureLagAgreementMilliseconds: 42,
      windowLagIqrMilliseconds: 42,
      nullP95Correlation: 0.25,
    },
    conditioningAvSync: null,
    dialogue: notApplicableDialogueEvaluation(),
    phonemeViseme: unavailablePhonemeVisemeResult(),
    ...overrides,
  };
}

describe("objective output quality", () => {
  it("keeps good SFace and classical AV raw measurements insufficient without a Product-GO evaluator", () => {
    const result = buildObjectiveQualityAnalysis(worker(), "2026-07-24T18:10:00.000Z");

    expect(result.status).toBe("insufficient");
    expect(result.capabilities).toEqual({
      avSync: "classical-av-raw-measured",
      conditioningAvSync: "provenance-unavailable",
      phonemeViseme: "manifest-missing",
      identity: "sface-raw-measured",
      dialogue: "not-applicable",
    });
    expect(result.face?.noseVelocityP95PerSecond).toBe(2.3);
    expect(result.face?.mouthSkinWarpResidualP95).toBe(0.041);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "calibration-required" }));
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "mouth-skin-stability-raw-measured",
      level: "info",
    }));
    expect(result).not.toHaveProperty("score");
    expect(result).not.toHaveProperty("rating");
    expect(result.capabilities.avSync).not.toBe("measured");
    expect(result.schemaVersion).toBe("ltx-studio-objective-quality.v7");
    expect(result.identity.cosineP10).toBe(0.84);
    expect(result.avSync.estimatedAudioLeadMilliseconds).toBe(30);
    expect(result.phonemeViseme.status).toBe("not-available");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "phoneme-viseme-manifest-missing",
      level: "warning",
    }));
  });

  it("does not report mouth-skin artifacts as measured below the pair evidence floor", () => {
    const input = worker();
    input.face.mouthSkinPairCount = 7;
    input.face.mouthSkinPairCoverage = 7 / 95;
    const result = buildObjectiveQualityAnalysis(input);

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "mouth-skin-stability-insufficient",
      level: "warning",
    }));
    expect(result.findings).not.toContainEqual(expect.objectContaining({
      code: "mouth-skin-stability-raw-measured",
    }));
  });

  it("requires enough valid mouth-ring pixels before reporting artifact measurements", () => {
    const input = worker();
    input.face.mouthSkinValidPixelCoverageP10 = 0.59;
    const result = buildObjectiveQualityAnalysis(input);

    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "mouth-skin-stability-insufficient",
    }));
  });

  it("rejects impossible mouth-skin pair relations and partial measurement tuples", () => {
    const impossible = worker();
    impossible.face.sampledFrames = 8;
    expect(objectiveWorkerResultSchema.safeParse(impossible).success).toBe(false);

    const partial = worker();
    partial.face.mouthSkinPairCount = 0;
    partial.face.mouthSkinPairCoverage = 0;
    expect(objectiveWorkerResultSchema.safeParse(partial).success).toBe(false);

    partial.face.mouthSkinWarpResidualMedian = null;
    partial.face.mouthSkinWarpResidualP95 = null;
    partial.face.mouthSkinLuminanceDeltaP95 = null;
    partial.face.mouthSkinFlowDeformationP95 = null;
    partial.face.mouthSkinValidPixelCoverageP10 = null;
    expect(objectiveWorkerResultSchema.safeParse(partial).success).toBe(true);
  });

  it("distinguishes a missing CPU runner from a legal or manifest hold", () => {
    const reason = "Release-Kandidat erkannt; CPU-Inferenzrunner fehlt.";
    const result = buildObjectiveQualityAnalysis(worker({
      phonemeViseme: unavailablePhonemeVisemeResult(reason, "runner-unavailable"),
    }));

    expect(result.capabilities.phonemeViseme).toBe("runner-unavailable");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "phoneme-viseme-runner-unavailable",
      level: "warning",
    }));
  });

  it("keeps the hash-bound conditioning proxy separate from the embedded final mix", () => {
    const baseline = worker();
    const conditioningAvSync = {
      ...baseline.avSync,
      estimatedAudioLeadMilliseconds: -42,
      correlationPeak: 0.74,
      nullP95Correlation: 0.28,
    };
    const result = buildObjectiveQualityAnalysis(worker({ conditioningAvSync }));

    expect(result.conditioningAvSync).toEqual(conditioningAvSync);
    expect(result.avSync.estimatedAudioLeadMilliseconds).toBe(30);
    expect(result.capabilities.conditioningAvSync).toBe("classical-av-raw-measured");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "classical-conditioning-av-sync-raw-measured",
    }));
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
        mouthSkinPairCount: 0,
        mouthSkinPairCoverage: 0,
        mouthSkinWarpResidualMedian: null,
        mouthSkinWarpResidualP95: null,
        mouthSkinLuminanceDeltaP95: null,
        mouthSkinFlowDeformationP95: null,
        mouthSkinValidPixelCoverageP10: null,
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
    expect(result.status).toBe("insufficient");
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

  it("fails closed when the classical AV lag is ambiguous", () => {
    const baseline = worker();
    const result = buildObjectiveQualityAnalysis(worker({
      avSync: {
        ...baseline.avSync,
        status: "insufficient",
        error: "Korrelationspeak ist zu breit.",
        estimatedAudioLeadMilliseconds: null,
        correlationPeak: null,
        zeroLagCorrelation: null,
        peakProminence: null,
        peakWidthMilliseconds: null,
        featureLagAgreementMilliseconds: null,
        windowLagIqrMilliseconds: null,
        nullP95Correlation: null,
      },
    }));

    expect(result.status).toBe("insufficient");
    expect(result.capabilities.avSync).toBe("classical-av-insufficient");
    expect(result.findings).toContainEqual(expect.objectContaining({
      code: "classical-av-sync-insufficient",
      level: "warning",
    }));
    expect(result).not.toHaveProperty("score");
  });

  it("rejects a measured AV status without its required evidence", () => {
    const invalid = worker();
    invalid.avSync = {
      ...invalid.avSync,
      error: "Contradictory measured state.",
      validMotionPairs: 0,
      motionCoverage: 0,
      usableAudioActivitySeconds: 0,
      mouthCoverageDuringAudioActivity: 0,
      usableWindowCount: 0,
      estimatedAudioLeadMilliseconds: null,
      lagResolutionMilliseconds: null,
      effectiveVideoSampleMilliseconds: null,
      correlationPeak: null,
      zeroLagCorrelation: null,
      peakProminence: null,
      peakWidthMilliseconds: null,
      featureLagAgreementMilliseconds: null,
      windowLagIqrMilliseconds: null,
      nullP95Correlation: null,
    };

    expect(objectiveWorkerResultSchema.safeParse(invalid).success).toBe(false);
    expect(() => buildObjectiveQualityAnalysis(invalid)).toThrow();
  });

  it("rejects a measured phoneme/viseme status without Product-GO and both evidence stages", () => {
    const invalid = worker();
    invalid.phonemeViseme = {
      ...unavailablePhonemeVisemeResult("Legal Hold"),
      status: "measured",
      error: null,
    };

    expect(objectiveWorkerResultSchema.safeParse(invalid).success).toBe(false);
    expect(() => buildObjectiveQualityAnalysis(invalid)).toThrow();
  });
});
