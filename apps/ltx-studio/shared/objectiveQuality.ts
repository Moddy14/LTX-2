import { z } from "zod";

import { dialogueEvaluationSchema } from "./dialogueEvaluator.js";
import { phonemeVisemeResultSchema } from "./phonemeVisemeEvaluator.js";
import { outputNameSchema } from "./pipelines.js";

const nullableFiniteNumber = z.number().finite().nullable();
const nonNegativeNumber = z.number().finite().min(0);

export const objectiveTechnicalMetricsSchema = z.object({
  durationSeconds: nullableFiniteNumber,
  fps: nullableFiniteNumber,
  frames: z.number().int().min(0).nullable(),
  hasAudio: z.boolean().nullable(),
  constantFrameRate: z.boolean().nullable(),
  audioVideoDurationDeltaSeconds: nonNegativeNumber.nullable(),
  audioVideoStartDeltaSeconds: nonNegativeNumber.nullable(),
}).strict();

export const faceTrackingMetricsSchema = z.object({
  sampledFrames: z.number().int().min(0),
  detectedFrames: z.number().int().min(0),
  validGeometryFrames: z.number().int().min(0),
  detectionCoverage: z.number().finite().min(0).max(1),
  geometryCoverage: z.number().finite().min(0).max(1),
  medianConfidence: z.number().finite().min(0).max(1).nullable(),
  medianEyeSpanPixels: nonNegativeNumber.nullable(),
  medianFaceAreaRatio: z.number().finite().min(0).max(1).nullable(),
  noseVelocityP95PerSecond: nonNegativeNumber.nullable(),
  noseAccelerationP95PerSecond2: nonNegativeNumber.nullable(),
  mouthAngleMedianDegrees: nullableFiniteNumber,
  mouthAngleVelocityP95DegreesPerSecond: nonNegativeNumber.nullable(),
  mouthSpanCoefficientOfVariation: nonNegativeNumber.nullable(),
}).strict();

export type FaceTrackingMetrics = z.infer<typeof faceTrackingMetricsSchema>;

const faceTrackingMetricsV7BaseSchema = faceTrackingMetricsSchema.extend({
  mouthSkinPairCount: z.number().int().min(0),
  mouthSkinPairCoverage: z.number().finite().min(0).max(1),
  mouthSkinWarpResidualMedian: z.number().finite().min(0).max(1).nullable(),
  mouthSkinWarpResidualP95: z.number().finite().min(0).max(1).nullable(),
  mouthSkinLuminanceDeltaP95: z.number().finite().min(0).max(1).nullable(),
  mouthSkinFlowDeformationP95: nonNegativeNumber.nullable(),
  mouthSkinValidPixelCoverageP10: z.number().finite().min(0).max(1).nullable(),
}).strict();

export const faceTrackingMetricsV7Schema = faceTrackingMetricsV7BaseSchema.superRefine((value, context) => {
  const possiblePairs = Math.max(0, value.sampledFrames - 1);
  if (value.mouthSkinPairCount > possiblePairs) {
    context.addIssue({
      code: "custom",
      path: ["mouthSkinPairCount"],
      message: "Mundhaut-Paarzahl darf sampledFrames - 1 nicht überschreiten.",
    });
  }
  const expectedCoverage = possiblePairs === 0 ? 0 : value.mouthSkinPairCount / possiblePairs;
  if (Math.abs(value.mouthSkinPairCoverage - expectedCoverage) > 1e-6) {
    context.addIssue({
      code: "custom",
      path: ["mouthSkinPairCoverage"],
      message: "Mundhaut-Paarabdeckung muss Paarzahl / (sampledFrames - 1) entsprechen.",
    });
  }
  const measurements = [
    ["mouthSkinWarpResidualMedian", value.mouthSkinWarpResidualMedian],
    ["mouthSkinWarpResidualP95", value.mouthSkinWarpResidualP95],
    ["mouthSkinLuminanceDeltaP95", value.mouthSkinLuminanceDeltaP95],
    ["mouthSkinFlowDeformationP95", value.mouthSkinFlowDeformationP95],
    ["mouthSkinValidPixelCoverageP10", value.mouthSkinValidPixelCoverageP10],
  ] as const;
  for (const [path, measurement] of measurements) {
    if ((value.mouthSkinPairCount === 0) !== (measurement === null)) {
      context.addIssue({
        code: "custom",
        path: [path],
        message: value.mouthSkinPairCount === 0
          ? "Ohne verwertbare Mundhaut-Paare muss der Messwert null sein."
          : "Mit verwertbaren Mundhaut-Paaren muss der Messwert gesetzt sein.",
      });
    }
  }
});

export type FaceTrackingMetricsV7 = z.infer<typeof faceTrackingMetricsV7Schema>;

export const identityMetricsSchema = z.object({
  status: z.enum(["measured", "insufficient", "failed", "not-applicable", "reference-provenance-missing"]),
  error: z.string().min(1).max(500).nullable(),
  modelName: z.literal("OpenCV SFace 2021dec").nullable(),
  modelSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  modelRevision: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  preprocessingVersion: z.enum([
    "yunet5-aligncrop-112.v1",
    "yunet5-aligncrop-112-track.v2",
  ]).nullable(),
  embeddingDimensions: z.number().int().positive().nullable(),
  referenceCount: z.number().int().min(0),
  sampledReferenceFrames: z.number().int().min(0),
  embeddedReferenceFrames: z.number().int().min(0),
  sampledOutputFrames: z.number().int().min(0),
  matchedOutputFrames: z.number().int().min(0),
  outputCoverage: z.number().finite().min(0).max(1),
  ambiguousOutputFrames: z.number().int().min(0),
  referenceSelfConsistencyMedian: z.number().finite().min(-1).max(1).nullable(),
  referenceSelfConsistencyP10: z.number().finite().min(-1).max(1).nullable(),
  cosineMedian: z.number().finite().min(-1).max(1).nullable(),
  cosineP10: z.number().finite().min(-1).max(1).nullable(),
  cosineMinimum: z.number().finite().min(-1).max(1).nullable(),
  outputTemporalConsistencyMedian: z.number().finite().min(-1).max(1).nullable(),
}).strict();

export type IdentityMetrics = z.infer<typeof identityMetricsSchema>;

const avSyncRawMetricsBaseSchema = z.object({
  status: z.enum(["measured", "insufficient", "failed", "not-applicable"]),
  error: z.string().min(1).max(500).nullable(),
  method: z.literal("classical-audio-mouth-motion.v1"),
  sampledVideoFrames: z.number().int().min(0),
  validMotionPairs: z.number().int().min(0),
  motionCoverage: z.number().finite().min(0).max(1),
  audioWindowCount: z.number().int().min(0),
  audioActivityRatio: z.number().finite().min(0).max(1).nullable(),
  usableAudioActivitySeconds: nonNegativeNumber,
  mouthCoverageDuringAudioActivity: z.number().finite().min(0).max(1),
  usableWindowCount: z.number().int().min(0),
  estimatedAudioLeadMilliseconds: z.number().int().min(-500).max(500).nullable(),
  lagSearchLimitMilliseconds: z.literal(500),
  lagResolutionMilliseconds: z.number().int().min(10).max(200).nullable(),
  effectiveVideoSampleMilliseconds: z.number().finite().min(0).max(200).nullable(),
  correlationPeak: z.number().finite().min(-1).max(1).nullable(),
  zeroLagCorrelation: z.number().finite().min(-1).max(1).nullable(),
  peakProminence: z.number().finite().min(0).max(2).nullable(),
  peakWidthMilliseconds: z.number().int().min(0).max(1_000).nullable(),
  featureLagAgreementMilliseconds: z.number().int().min(0).max(1_000).nullable(),
  windowLagIqrMilliseconds: z.number().int().min(0).max(1_000).nullable(),
  nullP95Correlation: z.number().finite().min(-1).max(1).nullable(),
}).strict();

export const avSyncRawMetricsSchema = avSyncRawMetricsBaseSchema.superRefine((value, context) => {
  if (value.status !== "measured") {
    if (value.error === null) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Nicht gemessene AV-Rohwerte benötigen einen erklärenden Fehlertext.",
      });
    }
    return;
  }
  if (value.error !== null) {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "Eine gemessene AV-Rohprüfung darf keinen Fehler tragen.",
    });
  }
  const requiredMeasurements = [
    "audioActivityRatio",
    "estimatedAudioLeadMilliseconds",
    "lagResolutionMilliseconds",
    "effectiveVideoSampleMilliseconds",
    "correlationPeak",
    "zeroLagCorrelation",
    "peakProminence",
    "peakWidthMilliseconds",
    "featureLagAgreementMilliseconds",
    "windowLagIqrMilliseconds",
    "nullP95Correlation",
  ] as const;
  for (const field of requiredMeasurements) {
    if (value[field] === null) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Eine gemessene AV-Rohprüfung benötigt diesen Messwert.",
      });
    }
  }
  if (value.validMotionPairs < 24 || value.motionCoverage < 0.6) {
    context.addIssue({
      code: "custom",
      path: ["validMotionPairs"],
      message: "Eine gemessene AV-Rohprüfung benötigt mindestens 24 kontinuierliche Bewegungspaare.",
    });
  }
  if (value.usableAudioActivitySeconds < 1
    || value.mouthCoverageDuringAudioActivity < 0.7
    || value.usableWindowCount < 2) {
    context.addIssue({
      code: "custom",
      path: ["usableAudioActivitySeconds"],
      message: "Eine gemessene AV-Rohprüfung benötigt ausreichend abgedeckte Aktivität und mindestens zwei Fenster.",
    });
  }
});

export type AvSyncRawMetrics = z.infer<typeof avSyncRawMetricsSchema>;

export const objectiveBaseWorkerResultSchema = z.object({
  technical: objectiveTechnicalMetricsSchema,
  face: faceTrackingMetricsSchema,
  identity: identityMetricsSchema,
  avSync: avSyncRawMetricsSchema,
  conditioningAvSync: avSyncRawMetricsSchema.nullable(),
  dialogue: dialogueEvaluationSchema,
}).strict();

export const objectiveBaseWorkerResultV7Schema = objectiveBaseWorkerResultSchema.extend({
  face: faceTrackingMetricsV7Schema,
}).strict();

export type ObjectiveBaseWorkerResultV7 = z.infer<typeof objectiveBaseWorkerResultV7Schema>;

export const objectiveWorkerResultSchema = objectiveBaseWorkerResultV7Schema.extend({
  phonemeViseme: phonemeVisemeResultSchema,
}).strict();

export type ObjectiveWorkerResult = z.infer<typeof objectiveWorkerResultSchema>;

const objectiveQualityAnalysisV1Schema = z.object({
  schemaVersion: z.literal("ltx-studio-objective-quality.v1"),
  analyzerVersion: z.literal("ffprobe-yunet5.v1"),
  createdAt: z.string().datetime({ offset: true }),
  status: z.enum(["measured", "insufficient"]),
  technical: objectiveTechnicalMetricsSchema,
  face: faceTrackingMetricsSchema.nullable(),
  capabilities: z.object({
    avSync: z.literal("syncnet-required"),
    identity: z.literal("face-recognition-model-required"),
    dialogue: z.literal("whisper-not-run"),
  }).strict(),
  findings: z.array(z.object({
    code: z.string().min(1).max(80),
    level: z.enum(["info", "warning", "error"]),
    message: z.string().min(1).max(500),
  }).strict()).max(30),
  limitations: z.array(z.string().min(1).max(500)).min(1).max(20),
}).strict();

const objectiveQualityAnalysisV2Schema = z.object({
  schemaVersion: z.literal("ltx-studio-objective-quality.v2"),
  analyzerVersion: z.literal("ffprobe-yunet5-sface.v2"),
  createdAt: z.string().datetime({ offset: true }),
  status: z.enum(["measured", "insufficient"]),
  technical: objectiveTechnicalMetricsSchema,
  face: faceTrackingMetricsSchema.nullable(),
  identity: identityMetricsSchema,
  capabilities: z.object({
    avSync: z.literal("syncnet-required"),
    identity: z.enum([
      "sface-raw-measured",
      "sface-insufficient",
      "sface-failed",
      "reference-provenance-required",
      "not-applicable",
    ]),
    dialogue: z.literal("whisper-not-run"),
  }).strict(),
  findings: z.array(z.object({
    code: z.string().min(1).max(80),
    level: z.enum(["info", "warning", "error"]),
    message: z.string().min(1).max(500),
  }).strict()).max(30),
  limitations: z.array(z.string().min(1).max(500)).min(1).max(20),
}).strict();

const objectiveQualityAnalysisV3Schema = z.object({
  schemaVersion: z.literal("ltx-studio-objective-quality.v3"),
  analyzerVersion: z.literal("ffprobe-yunet5-sface-avmotion.v3"),
  createdAt: z.string().datetime({ offset: true }),
  status: z.enum(["measured", "insufficient"]),
  technical: objectiveTechnicalMetricsSchema,
  face: faceTrackingMetricsSchema.nullable(),
  identity: identityMetricsSchema,
  avSync: avSyncRawMetricsSchema,
  capabilities: z.object({
    avSync: z.enum([
      "classical-av-raw-measured",
      "classical-av-insufficient",
      "classical-av-failed",
      "not-applicable",
    ]),
    identity: z.enum([
      "sface-raw-measured",
      "sface-insufficient",
      "sface-failed",
      "reference-provenance-required",
      "not-applicable",
    ]),
    dialogue: z.literal("whisper-not-run"),
  }).strict(),
  findings: z.array(z.object({
    code: z.string().min(1).max(80),
    level: z.enum(["info", "warning", "error"]),
    message: z.string().min(1).max(500),
  }).strict()).max(30),
  limitations: z.array(z.string().min(1).max(500)).min(1).max(20),
}).strict();

const objectiveQualityAnalysisV4Schema = z.object({
  schemaVersion: z.literal("ltx-studio-objective-quality.v4"),
  analyzerVersion: z.literal("ffprobe-yunet5-sface-avmotion-pv.v4"),
  createdAt: z.string().datetime({ offset: true }),
  status: z.enum(["measured", "insufficient"]),
  technical: objectiveTechnicalMetricsSchema,
  face: faceTrackingMetricsSchema.nullable(),
  identity: identityMetricsSchema,
  avSync: avSyncRawMetricsSchema,
  phonemeViseme: phonemeVisemeResultSchema,
  capabilities: z.object({
    avSync: z.enum([
      "classical-av-raw-measured",
      "classical-av-insufficient",
      "classical-av-failed",
      "not-applicable",
    ]),
    phonemeViseme: z.enum([
      "product-go-measured",
      "measurement-only",
      "product-go-insufficient",
      "legal-hold",
      "runner-unavailable",
      "manifest-missing",
      "failed",
      "not-applicable",
    ]),
    identity: z.enum([
      "sface-raw-measured",
      "sface-insufficient",
      "sface-failed",
      "reference-provenance-required",
      "not-applicable",
    ]),
    dialogue: z.literal("whisper-not-run"),
  }).strict(),
  findings: z.array(z.object({
    code: z.string().min(1).max(80),
    level: z.enum(["info", "warning", "error"]),
    message: z.string().min(1).max(500),
  }).strict()).max(40),
  limitations: z.array(z.string().min(1).max(500)).min(1).max(20),
}).strict();

const objectiveQualityAnalysisV5Schema = objectiveQualityAnalysisV4Schema.extend({
  schemaVersion: z.literal("ltx-studio-objective-quality.v5"),
  analyzerVersion: z.literal("ffprobe-yunet5-sface-dual-avmotion-pv.v5"),
  conditioningAvSync: avSyncRawMetricsSchema.nullable(),
  capabilities: objectiveQualityAnalysisV4Schema.shape.capabilities.extend({
    conditioningAvSync: z.enum([
      "classical-av-raw-measured",
      "classical-av-insufficient",
      "classical-av-failed",
      "provenance-unavailable",
    ]),
  }).strict(),
}).strict();

const objectiveQualityAnalysisV6Schema = objectiveQualityAnalysisV5Schema.extend({
  schemaVersion: z.literal("ltx-studio-objective-quality.v6"),
  analyzerVersion: z.literal("ffprobe-yunet5-sface-dual-avmotion-whisper-pv.v6"),
  dialogue: dialogueEvaluationSchema,
  capabilities: objectiveQualityAnalysisV5Schema.shape.capabilities.extend({
    dialogue: z.enum([
      "whisper-word-measured",
      "whisper-word-insufficient",
      "whisper-word-failed",
      "whisper-word-not-available",
      "not-applicable",
    ]),
  }).strict(),
}).strict();

const objectiveQualityAnalysisV7Schema = objectiveQualityAnalysisV6Schema.extend({
  schemaVersion: z.literal("ltx-studio-objective-quality.v7"),
  analyzerVersion: z.literal("ffprobe-yunet5-sface-dual-avmotion-whisper-pv-artifact.v7"),
  face: faceTrackingMetricsV7Schema,
}).strict();

export const objectiveQualityAnalysisSchema = z.union([
  objectiveQualityAnalysisV1Schema,
  objectiveQualityAnalysisV2Schema,
  objectiveQualityAnalysisV3Schema,
  objectiveQualityAnalysisV4Schema,
  objectiveQualityAnalysisV5Schema,
  objectiveQualityAnalysisV6Schema,
  objectiveQualityAnalysisV7Schema,
]);

export type ObjectiveQualityAnalysis = z.infer<typeof objectiveQualityAnalysisSchema>;

const outputAnalysisRecordFields = {
  outputName: outputNameSchema,
  sizeBytes: z.number().int().positive(),
  modifiedAtMs: z.number().finite().nonnegative(),
  changedAtMs: z.number().finite().nonnegative(),
  fileId: z.string().regex(/^\d{1,64}$/),
  jobId: z.string().uuid(),
  analysisId: z.string().uuid(),
  attempt: z.number().int().min(1),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  progress: z.number().finite().min(0).max(100),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  finishedAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
  }).strict().nullable(),
};

const outputAnalysisRecordV1Schema = z.object({
  schemaVersion: z.literal("ltx-studio-output-analysis.v1"),
  ...outputAnalysisRecordFields,
  result: objectiveQualityAnalysisV1Schema.nullable(),
}).strict();

const outputAnalysisRecordV2Schema = z.object({
  schemaVersion: z.literal("ltx-studio-output-analysis.v2"),
  ...outputAnalysisRecordFields,
  result: objectiveQualityAnalysisV2Schema.nullable(),
}).strict();

const outputAnalysisRecordV3Schema = z.object({
  schemaVersion: z.literal("ltx-studio-output-analysis.v3"),
  ...outputAnalysisRecordFields,
  result: objectiveQualityAnalysisV3Schema.nullable(),
}).strict();

const outputAnalysisRecordV4Schema = z.object({
  schemaVersion: z.literal("ltx-studio-output-analysis.v4"),
  ...outputAnalysisRecordFields,
  evaluatorFingerprint: z.string().min(1).max(512),
  result: objectiveQualityAnalysisV4Schema.nullable(),
}).strict();

const outputAnalysisRecordV5Schema = z.object({
  schemaVersion: z.literal("ltx-studio-output-analysis.v5"),
  ...outputAnalysisRecordFields,
  evaluatorFingerprint: z.string().min(1).max(512),
  conditioningAudioSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  result: objectiveQualityAnalysisV5Schema.nullable(),
}).strict();

const outputAnalysisRecordV6Schema = z.object({
  schemaVersion: z.literal("ltx-studio-output-analysis.v6"),
  ...outputAnalysisRecordFields,
  evaluatorFingerprint: z.string().min(1).max(512),
  conditioningAudioSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  expectedDialogueSha256: z.string().regex(/^[0-9a-f]{64}$/),
  result: objectiveQualityAnalysisV6Schema.nullable(),
}).strict();

const outputAnalysisRecordV7Schema = z.object({
  schemaVersion: z.literal("ltx-studio-output-analysis.v7"),
  ...outputAnalysisRecordFields,
  evaluatorFingerprint: z.string().min(1).max(512),
  conditioningAudioSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  expectedDialogueSha256: z.string().regex(/^[0-9a-f]{64}$/),
  result: objectiveQualityAnalysisV7Schema.nullable(),
}).strict();

export const outputAnalysisRecordSchema = z.union([
  outputAnalysisRecordV1Schema,
  outputAnalysisRecordV2Schema,
  outputAnalysisRecordV3Schema,
  outputAnalysisRecordV4Schema,
  outputAnalysisRecordV5Schema,
  outputAnalysisRecordV6Schema,
  outputAnalysisRecordV7Schema,
]);

export type OutputAnalysisRecord = z.infer<typeof outputAnalysisRecordSchema>;

export function normalizeObjectiveQualityAnalysis(value: unknown): ObjectiveQualityAnalysis | null {
  const parsed = objectiveQualityAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
