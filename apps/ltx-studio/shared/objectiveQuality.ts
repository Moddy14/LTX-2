import { z } from "zod";

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

export const objectiveWorkerResultSchema = z.object({
  technical: objectiveTechnicalMetricsSchema,
  face: faceTrackingMetricsSchema,
  identity: identityMetricsSchema,
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

export const objectiveQualityAnalysisSchema = z.union([
  objectiveQualityAnalysisV1Schema,
  objectiveQualityAnalysisV2Schema,
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

export const outputAnalysisRecordSchema = z.union([
  outputAnalysisRecordV1Schema,
  outputAnalysisRecordV2Schema,
]);

export type OutputAnalysisRecord = z.infer<typeof outputAnalysisRecordSchema>;

export function normalizeObjectiveQualityAnalysis(value: unknown): ObjectiveQualityAnalysis | null {
  const parsed = objectiveQualityAnalysisSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
