import { z } from "zod";

import { INDEPENDENT_IPA_METHOD } from "./independentIpa.js";
import {
  T2A_PHONEME_MEASUREMENT_METHOD,
  t2aAudioClaimScopeSchema,
  t2aIa2vEligibilitySchema,
} from "./t2aAudioBaseContracts.js";

export const T2A_AUDIO_PUBLIC_QUALITY_VERSION = "ltx-studio-t2a-audio-quality-public.v4" as const;
export const T2A_AUDIO_PUBLIC_ANALYSIS_VERSION = "ltx-studio-t2a-audio-analysis-public.v4" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const publicIndependentIpaReleaseQualificationSchema = z.object({
  status: z.literal("not-qualified"),
  requiredPositiveHoldoutCases: z.literal(300),
  requiredNegativeHoldoutCases: z.literal(300),
  maximumFalseAccepts: z.literal(0),
}).strict();

const publicIndependentIpaFailureReasonCodeSchema = z.enum([
  "arguments-invalid",
  "audio-snapshot-invalid",
  "audio-hash-mismatch",
  "wav-container-invalid",
  "wav-format-unsupported",
  "wav-data-invalid",
  "audio-silent",
  "ffmpeg-unverified",
  "offline-runtime-unverified",
  "independent-ipa-unverified",
  "independent-ipa-normalization-failed",
  "independent-ipa-failed",
  "independent-ipa-invalid",
  "independent-ipa-runner-failed",
  "internal-error",
]);

const publicIndependentIpaMeasuredSchema = z.object({
  evaluationMode: z.literal("measurement-only"),
  status: z.literal("measured"),
  targetConditioned: z.literal(false),
  reasonCode: z.null(),
  method: z.literal(INDEPENDENT_IPA_METHOD),
  modelFingerprint: sha256Schema,
  decodedIpa: z.string().max(16 * 1024),
  tokenCount: z.number().int().min(0).max(1_049),
  unknownTokenCount: z.number().int().min(0).max(1_049),
  specialTokenCount: z.number().int().min(0).max(1_049),
  blankFrameRatio: z.number().finite().min(0).max(1),
  releaseQualification: publicIndependentIpaReleaseQualificationSchema,
}).strict().superRefine((value, context) => {
  if (value.unknownTokenCount > value.tokenCount) {
    context.addIssue({
      code: "custom",
      path: ["unknownTokenCount"],
      message: "Unbekannte IPA-Tokens koennen die Gesamtzahl nicht uebersteigen.",
    });
  }
  if (value.specialTokenCount > value.tokenCount) {
    context.addIssue({
      code: "custom",
      path: ["specialTokenCount"],
      message: "Spezialtokens koennen die Gesamtzahl nicht uebersteigen.",
    });
  }
  if (value.unknownTokenCount + value.specialTokenCount > value.tokenCount) {
    context.addIssue({
      code: "custom",
      path: ["tokenCount"],
      message: "Unbekannte und spezielle IPA-Tokens muessen disjunkte Teilmengen sein.",
    });
  }
});

const publicIndependentIpaInsufficientSchema = z.object({
  evaluationMode: z.literal("measurement-only"),
  status: z.literal("insufficient"),
  targetConditioned: z.literal(false),
  reasonCode: z.literal("duration-exceeds-independent-ipa-window"),
  method: z.null(),
  modelFingerprint: z.null(),
  decodedIpa: z.null(),
  tokenCount: z.null(),
  unknownTokenCount: z.null(),
  specialTokenCount: z.null(),
  blankFrameRatio: z.null(),
  releaseQualification: publicIndependentIpaReleaseQualificationSchema,
}).strict();

const publicIndependentIpaFailedSchema = z.object({
  evaluationMode: z.literal("measurement-only"),
  status: z.literal("failed"),
  targetConditioned: z.literal(false),
  reasonCode: publicIndependentIpaFailureReasonCodeSchema,
  method: z.null(),
  modelFingerprint: z.null(),
  decodedIpa: z.null(),
  tokenCount: z.null(),
  unknownTokenCount: z.null(),
  specialTokenCount: z.null(),
  blankFrameRatio: z.null(),
  releaseQualification: publicIndependentIpaReleaseQualificationSchema,
}).strict();

export const publicIndependentIpaMeasurementSchema = z.discriminatedUnion("status", [
  publicIndependentIpaMeasuredSchema,
  publicIndependentIpaInsufficientSchema,
  publicIndependentIpaFailedSchema,
]);

export type PublicIndependentIpaMeasurement = z.infer<
  typeof publicIndependentIpaMeasurementSchema
>;

const publicPronunciationCountSchema = z.number().finite().int().nonnegative().max(1_049);
const publicPronunciationMeasurementShape = {
  method: z.literal(T2A_PHONEME_MEASUREMENT_METHOD),
  evaluationMode: z.literal("measurement-only"),
};

const publicMeasuredPronunciationSchema = z.object({
  status: z.literal("measured"),
  sourcePhaseStatus: z.literal("measured"),
  ...publicPronunciationMeasurementShape,
  substitutions: publicPronunciationCountSchema,
  deletions: publicPronunciationCountSchema,
  insertions: publicPronunciationCountSchema,
  editDistance: publicPronunciationCountSchema,
  referenceTokenCount: z.number().finite().int().min(1).max(1_049),
  hypothesisTokenCount: publicPronunciationCountSchema,
  normalizedPhoneErrorRate: z.number().finite().nonnegative().max(1_049),
}).strict().superRefine((value, context) => {
  if (value.editDistance !== value.substitutions + value.deletions + value.insertions
    || !Object.is(
      value.normalizedPhoneErrorRate,
      value.editDistance / value.referenceTokenCount,
    )) {
    context.addIssue({
      code: "custom",
      path: ["editDistance"],
      message: "Oeffentliche Lautabgleichwerte und Roh-PER widersprechen einander.",
    });
  }
});

const publicUnavailablePronunciationSchema = z.object({
  status: z.literal("unavailable"),
  sourcePhaseStatus: z.enum(["insufficient", "failed"]),
  ...publicPronunciationMeasurementShape,
  substitutions: z.null(),
  deletions: z.null(),
  insertions: z.null(),
  editDistance: z.null(),
  referenceTokenCount: z.null(),
  hypothesisTokenCount: z.null(),
  normalizedPhoneErrorRate: z.null(),
}).strict();

export const publicPronunciationMeasurementSchema = z.discriminatedUnion("status", [
  publicMeasuredPronunciationSchema,
  publicUnavailablePronunciationSchema,
]);

export type PublicPronunciationMeasurement = z.infer<
  typeof publicPronunciationMeasurementSchema
>;

const publicDialogueSchema = z.object({
  status: z.enum(["measured", "insufficient", "failed", "not-applicable", "not-available"]),
  blockerCode: z.enum([
    "none",
    "target-transcript-missing",
    "target-transcript-too-long",
    "audio-missing",
    "duration-out-of-range",
    "model-missing",
    "model-invalid",
    "runtime-unavailable",
    "alignment-insufficient",
    "evaluator-failed",
  ]),
  error: z.string().min(1).max(500).nullable(),
  detectedLanguage: z.string().min(1).max(16).nullable(),
  expectedWordCount: z.number().int().min(0).max(200),
  recognizedWordCount: z.number().int().min(0).max(400),
  wordErrorRate: z.number().finite().min(0).nullable(),
  substitutions: z.number().int().min(0).max(200),
  deletions: z.number().int().min(0).max(200),
  insertions: z.number().int().min(0).max(400),
  guidedAlignedWordCount: z.number().int().min(0).max(200),
  guidedWordCoverage: z.number().finite().min(0).max(1),
  usableAlignedWordCount: z.number().int().min(0).max(200),
  usableGuidedWordCoverage: z.number().finite().min(0).max(1),
  medianGuidedWordProbability: z.number().finite().min(0).max(1).nullable(),
  p10GuidedWordProbability: z.number().finite().min(0).max(1).nullable(),
  lowConfidenceAlignedWords: z.number().int().min(0).max(200),
  alignmentStatus: z.enum(["measured", "insufficient", "failed", "not-applicable"]),
  alignmentError: z.string().min(1).max(500).nullable(),
  timePrecisionMilliseconds: z.literal(20),
}).strict();

const publicMeasuredQualitySchema = z.object({
  schemaVersion: z.literal(T2A_AUDIO_PUBLIC_QUALITY_VERSION),
  mediaKind: z.literal("audio"),
  analysisKind: z.literal("t2a-audio-qa"),
  analysisStatus: z.literal("measured"),
  wav: z.object({
    container: z.literal("RIFF/WAVE"),
    codec: z.literal("pcm_s16le"),
    formatTag: z.literal(1),
    bitsPerSample: z.literal(16),
    channels: z.number().int().min(1).max(32),
    sampleRateHz: z.number().int().min(1).max(384_000),
    sampleFrames: z.number().int().positive(),
    durationSeconds: z.number().finite().positive(),
  }).strict(),
  pcm: z.object({
    totalSamples: z.number().int().positive(),
    samplePeakLinear: z.number().finite().positive().max(1),
    samplePeakDbfs: z.number().finite().max(0),
    fullScaleClippedSamples: z.number().int().nonnegative(),
    fullScaleClippedRatio: z.number().finite().min(0).max(1),
  }).strict(),
  loudness: z.object({
    method: z.literal("ffmpeg-ebur128-peak-true.v1"),
    integratedLufs: z.number().finite(),
    truePeakDbtp: z.number().finite(),
  }).strict(),
  dialogue: publicDialogueSchema,
  policy: z.object({
    peakCeilingDbfs: z.number().finite().min(-60).max(0),
    peakCeilingLinear: z.number().finite().positive().max(1),
    pcm16LsbToleranceLinear: z.number().finite().positive(),
  }).strict(),
  independentIpa: publicIndependentIpaMeasurementSchema,
  pronunciationMeasurement: publicPronunciationMeasurementSchema.nullable(),
  ia2vEligibility: t2aIa2vEligibilitySchema,
}).strict().superRefine((value, context) => {
  if (value.ia2vEligibility.status !== "blocked"
    || !value.ia2vEligibility.blockers.includes("spoken-content-gate-not-passed")) {
    context.addIssue({
      code: "custom",
      path: ["ia2vEligibility"],
      message: "Eine oeffentliche IPA-Messung ohne qualifizierten Holdout muss IA2V sperren.",
    });
  }
});

const publicFailedQualitySchema = z.object({
  schemaVersion: z.literal(T2A_AUDIO_PUBLIC_QUALITY_VERSION),
  mediaKind: z.literal("audio"),
  analysisKind: z.literal("t2a-audio-qa"),
  analysisStatus: z.literal("failed"),
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(500),
  }).strict(),
  ia2vEligibility: t2aIa2vEligibilitySchema,
}).strict().superRefine((value, context) => {
  const eligibility = value.ia2vEligibility;
  if (eligibility.status !== "blocked"
    || eligibility.blockers[0] !== "analysis-failed"
    || eligibility.blockers.length > 2
    || (eligibility.blockers.length === 2
      && eligibility.blockers[1] !== "development-runtime-unattested")) {
    context.addIssue({
      code: "custom",
      path: ["ia2vEligibility", "blockers"],
      message: "Eine fehlgeschlagene oeffentliche Audioanalyse muss IA2V fail-closed blockieren.",
    });
  }
});

export const t2aAudioPublicQualitySchema = z.discriminatedUnion("analysisStatus", [
  publicMeasuredQualitySchema,
  publicFailedQualitySchema,
]);

export type T2aAudioPublicQuality = z.infer<typeof t2aAudioPublicQualitySchema>;

export const t2aAudioPublicAnalysisRecordSchema = z.object({
  schemaVersion: z.literal(T2A_AUDIO_PUBLIC_ANALYSIS_VERSION),
  analysisKind: z.literal("t2a-audio-qa"),
  mediaKind: z.literal("audio"),
  outputName: z.string().min(1).max(124),
  outputRevisionToken: z.string().regex(/^eq1_[A-Za-z0-9_-]{32}$/u),
  jobId: z.string().uuid(),
  analysisId: z.string().uuid(),
  claimScope: t2aAudioClaimScopeSchema,
  attempt: z.number().int().positive(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  progress: z.number().int().min(0).max(100),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  error: z.object({
    code: z.enum(["analysis-failed", "cancelled"]),
    message: z.string().min(1).max(500),
  }).strict().nullable(),
  result: t2aAudioPublicQualitySchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === "completed"
    && (value.progress !== 100
      || value.finishedAt === null
      || value.error !== null
      || value.result?.analysisStatus !== "measured")) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Eine abgeschlossene oeffentliche T2A-Analyse benoetigt ein Messergebnis.",
    });
  }
  if (value.status === "failed"
    && (value.finishedAt === null
      || value.error?.code !== "analysis-failed"
      || value.result?.analysisStatus === "measured")) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Eine fehlgeschlagene oeffentliche T2A-Analyse benoetigt einen Fehler.",
    });
  }
  if (value.status === "cancelled"
    && (value.finishedAt === null
      || value.error?.code !== "cancelled"
      || value.result !== null)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Eine abgebrochene oeffentliche T2A-Analyse ist terminal und ergebnislos.",
    });
  }
  if (["queued", "running"].includes(value.status)
    && (value.finishedAt !== null || value.error !== null || value.result !== null)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Eine aktive oeffentliche T2A-Analyse darf kein terminales Ergebnis enthalten.",
    });
  }
  if (value.result !== null) {
    const blockers = value.result.ia2vEligibility.status === "blocked"
      ? value.result.ia2vEligibility.blockers
      : [];
    const developmentBlocked = blockers.includes("development-runtime-unattested");
    if ((value.claimScope === "development" && !developmentBlocked)
      || (value.claimScope === "sealed-release" && developmentBlocked)) {
      context.addIssue({
        code: "custom",
        path: ["result", "ia2vEligibility"],
        message: "Oeffentlicher T2A-Claim-Scope und Runtime-Blocker widersprechen einander.",
      });
    }
  }
});

export type T2aAudioPublicAnalysisRecord = z.infer<typeof t2aAudioPublicAnalysisRecordSchema>;
