import { z } from "zod";

import {
  independentIpaPhaseSchema,
  type IndependentIpaPhase,
} from "./independentIpa.js";
import {
  T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
  T2A_PHONEME_MEASUREMENT_METHOD,
  t2aIa2vBlockedSchema,
  t2aIa2vEligibilitySchema,
  type T2aAudioClaimScope,
  type T2aIa2vBlockerCode,
  type T2aIa2vEligibility,
} from "./t2aAudioBaseContracts.js";
import {
  t2aIpaAdjudicationResultSchema,
  type T2aIpaAdjudicationResult,
} from "./t2aIpaAdjudication.js";

export {
  T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
  T2A_PHONEME_MEASUREMENT_METHOD,
  t2aAudioClaimScopeSchema,
  t2aIa2vBlockedSchema,
  t2aIa2vBlockerCodeSchema,
  t2aIa2vEligibleSchema,
  t2aIa2vEligibilitySchema,
  type T2aAudioClaimScope,
  type T2aIa2vBlocked,
  type T2aIa2vBlockerCode,
  type T2aIa2vEligible,
  type T2aIa2vEligibility,
} from "./t2aAudioBaseContracts.js";

export const T2A_AUDIO_QUALITY_SCHEMA_VERSION = "t2a-audio-quality.v2" as const;
export const T2A_SPOKEN_CONTENT_GATE_SCHEMA_VERSION = "t2a-spoken-content-gate.v1" as const;
export const T2A_FFMPEG_SHA256 = "9f126bd755615d8c5d9aa2e67c568626be05389feb795478e0f14d41217270f4" as const;
export const T2A_WHISPER_SMALL_SHA256 = "9ecf779972d90ba49c06d968637d720dd632c55bbf19d441fb42bf17a411e794" as const;
export const T2A_RAW_ASR_CONTENT_METHOD = "whisper-small-independent-raw-asr-token-edits.v1" as const;
export const T2A_PHONEME_VERIFICATION_REASON = "Kein unabhaengig gebundener Zweit-Recognizer oder Phonem-Scorer ist verfuegbar." as const;
export const PCM16_LSB_LINEAR = 1 / 32_768;

const sourceSnapshotSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  byteLength: z.number().int().min(44).max(Number.MAX_SAFE_INTEGER),
}).strict();

const wavPcm16Schema = z.object({
  container: z.literal("RIFF/WAVE"),
  codec: z.literal("pcm_s16le"),
  formatTag: z.literal(1),
  bitsPerSample: z.literal(16),
  channels: z.number().int().min(1).max(32),
  sampleRateHz: z.number().int().min(1).max(384_000),
  sampleFrames: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  durationSeconds: z.number().finite().positive(),
}).strict();

const pcmFactsSchema = z.object({
  totalSamples: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  samplePeakLinear: z.number().finite().positive().max(1),
  samplePeakDbfs: z.number().finite().max(0),
  fullScaleClippedSamples: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  fullScaleClippedRatio: z.number().finite().min(0).max(1),
}).strict();

const loudnessFactsSchema = z.object({
  method: z.literal("ffmpeg-ebur128-peak-true.v1"),
  ffmpegSha256: z.literal(T2A_FFMPEG_SHA256),
  integratedLufs: z.number().finite(),
  truePeakDbtp: z.number().finite(),
}).strict();

const policySchema = z.object({
  peakCeilingDbfs: z.number().finite().min(-60).max(0),
  peakCeilingLinear: z.number().finite().positive().max(1),
  pcm16LsbToleranceLinear: z.literal(PCM16_LSB_LINEAR),
}).strict();

const nullableRatioSchema = z.number().finite().min(0).max(1).nullable();
const dialogueBlockerCodeSchema = z.enum([
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
]);
const guidedWordSchema = z.object({
  index: z.number().int().min(0).max(199),
  word: z.string().min(1).max(80),
  normalizedWord: z.string().min(1).max(80),
  tokenIds: z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).min(1).max(32),
  startSeconds: z.number().finite().min(0).max(30),
  endSeconds: z.number().finite().min(0).max(30),
  probability: z.number().finite().min(0).max(1),
  usable: z.boolean(),
}).strict();
const normalizedContentWordSchema = z.string().min(1).max(4_000);
const insertionFactSchema = z.object({
  recognizedIndex: z.number().int().min(0).max(399),
  word: normalizedContentWordSchema,
}).strict();
const deletionFactSchema = z.object({
  expectedIndex: z.number().int().min(0).max(199),
  word: normalizedContentWordSchema,
}).strict();
const substitutionFactSchema = z.object({
  expectedIndex: z.number().int().min(0).max(199),
  recognizedIndex: z.number().int().min(0).max(399),
  expectedWord: normalizedContentWordSchema,
  recognizedWord: normalizedContentWordSchema,
}).strict();
const rawAsrContentGateSchema = z.object({
  status: z.enum(["passed", "failed", "not-measured"]),
  method: z.literal(T2A_RAW_ASR_CONTENT_METHOD),
  targetConditioned: z.literal(false),
  exactTokenMatch: z.boolean().nullable(),
  expectedNormalizedWords: z.array(normalizedContentWordSchema).max(200),
  recognizedNormalizedWords: z.array(normalizedContentWordSchema).max(400),
  prefixInsertions: z.array(insertionFactSchema).max(400),
  internalInsertions: z.array(insertionFactSchema).max(400),
  suffixInsertions: z.array(insertionFactSchema).max(400),
  deletedExpectedWords: z.array(deletionFactSchema).max(200),
  substitutedWords: z.array(substitutionFactSchema).max(200),
  repeatedInsertions: z.array(insertionFactSchema).max(400),
}).strict();
const unavailableLegacyPhonemeVerificationSchema = z.object({
  status: z.literal("not-available"),
  method: z.null(),
  reason: z.literal(T2A_PHONEME_VERIFICATION_REASON),
}).strict();

const phonemeAlignmentMeasurementSchema = z.object({
  substitutions: z.number().finite().int().nonnegative().max(1_049),
  deletions: z.number().finite().int().nonnegative().max(1_049),
  insertions: z.number().finite().int().nonnegative().max(1_049),
  editDistance: z.number().finite().int().nonnegative().max(1_049),
  referenceTokenCount: z.number().finite().int().min(1).max(1_049),
  hypothesisTokenCount: z.number().finite().int().nonnegative().max(1_049),
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
      message: "Phonem-Editmessung und normalisierte Fehlerrate widersprechen einander.",
    });
  }
});

const adjudicatedPhonemeVerificationSchema = z.object({
  status: z.enum(["measured", "unavailable"]),
  method: z.literal(T2A_PHONEME_MEASUREMENT_METHOD),
  targetConditioned: z.literal(true),
  evaluationMode: z.literal("measurement-only"),
  releaseDecision: z.literal("blocked"),
  adjudicationResultSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sourcePhaseStatus: z.enum(["measured", "insufficient", "failed"]),
  measurement: phonemeAlignmentMeasurementSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.status === "measured") !== (value.sourcePhaseStatus === "measured")
    || (value.status === "measured") !== (value.measurement !== null)) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Phonemstatus muss exakt dem gebundenen IPA-Phasenstatus entsprechen.",
    });
  }
});

const phonemeVerificationSchema = z.union([
  unavailableLegacyPhonemeVerificationSchema,
  adjudicatedPhonemeVerificationSchema,
]);

export const t2aSpokenContentGateBlockerCodeSchema = z.enum([
  "calibrated-holdout-not-qualified",
  "ipa-adjudication-unavailable",
  "independent-ipa-insufficient",
  "independent-ipa-failed",
  "raw-asr-not-measured",
  "raw-asr-substitution-unqualified",
  "raw-asr-deletion-present",
  "raw-asr-insertion-present",
  "raw-asr-repetition-present",
]);

const spokenContentReleaseQualificationSchema = z.object({
  status: z.literal("not-qualified"),
  requiredPositiveHoldoutCases: z.literal(300),
  requiredNegativeHoldoutCases: z.literal(300),
  maximumFalseAccepts: z.literal(0),
  evidenceSha256: z.null(),
}).strict();

const independentIpaGateEvidenceSchema = z.object({
  authorityAudioSha256: z.string().regex(/^[0-9a-f]{64}$/),
  phaseDocumentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  phase: independentIpaPhaseSchema,
}).strict().superRefine((value, context) => {
  if (value.phase.authorityAudioSha256 !== value.authorityAudioSha256) {
    context.addIssue({
      code: "custom",
      path: ["phase", "authorityAudioSha256"],
      message: "IPA-Phase und Spoken-Content-Gate müssen dieselbe Audio-Authority binden.",
    });
  }
});

const ipaAdjudicationGateEvidenceSchema = z.object({
  resultDocumentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  result: t2aIpaAdjudicationResultSchema,
}).strict();

export const t2aSpokenContentGateSchema = z.object({
  schemaVersion: z.literal(T2A_SPOKEN_CONTENT_GATE_SCHEMA_VERSION),
  evaluationMode: z.literal("measurement-only"),
  releaseDecision: z.literal("blocked"),
  blockerCodes: z.array(t2aSpokenContentGateBlockerCodeSchema).min(1).max(9),
  releaseQualification: spokenContentReleaseQualificationSchema,
  independentIpa: independentIpaGateEvidenceSchema,
  ipaAdjudication: ipaAdjudicationGateEvidenceSchema.optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.blockerCodes).size !== value.blockerCodes.length) {
    context.addIssue({
      code: "custom",
      path: ["blockerCodes"],
      message: "Spoken-Content-Blocker dürfen nicht doppelt vorkommen.",
    });
  }
  if (value.ipaAdjudication !== undefined) {
    const { result } = value.ipaAdjudication;
    if (result.phaseSha256 !== value.independentIpa.phaseDocumentSha256
      || (result.status === "unavailable")
        !== value.blockerCodes.includes("ipa-adjudication-unavailable")) {
      context.addIssue({
        code: "custom",
        path: ["ipaAdjudication"],
        message: "IPA-Adjudication ist nicht an Phase und Blockerstatus gebunden.",
      });
    }
  }
});

export type T2aSpokenContentGateBlockerCode = z.infer<
  typeof t2aSpokenContentGateBlockerCodeSchema
>;
export type T2aSpokenContentGate = z.infer<typeof t2aSpokenContentGateSchema>;

type RawAsrContentGate = z.infer<typeof rawAsrContentGateSchema>;
type EditScore = readonly [number, number, number, number];
type EditOperation = "match" | "substitution" | "deletion" | "insertion";

function addEditScore(left: EditScore, right: EditScore): EditScore {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2], left[3] + right[3]];
}

function compareEditScore(left: EditScore, right: EditScore): number {
  for (const index of [0, 3, 2, 1] as const) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function deriveRawAsrTokenEdits(
  expected: readonly string[],
  recognized: readonly string[],
): Pick<RawAsrContentGate,
  "prefixInsertions" | "internalInsertions" | "suffixInsertions"
  | "deletedExpectedWords" | "substitutedWords" | "repeatedInsertions"> {
  const rows = expected.length + 1;
  const columns = recognized.length + 1;
  const scores = Array.from({ length: rows }, () => (
    Array.from({ length: columns }, () => [0, 0, 0, 0] as EditScore)
  ));
  const backtrack = Array.from({ length: rows }, () => (
    Array.from({ length: columns }, () => null as EditOperation | null)
  ));
  for (let row = 1; row < rows; row += 1) {
    scores[row][0] = [row, 0, row, 0];
    backtrack[row][0] = "deletion";
  }
  for (let column = 1; column < columns; column += 1) {
    scores[0][column] = [column, 0, 0, column];
    backtrack[0][column] = "insertion";
  }
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      if (expected[row - 1] === recognized[column - 1]) {
        scores[row][column] = scores[row - 1][column - 1];
        backtrack[row][column] = "match";
        continue;
      }
      const candidates: Array<readonly [EditScore, EditOperation]> = [
        [addEditScore(scores[row - 1][column - 1], [1, 1, 0, 0]), "substitution"],
        [addEditScore(scores[row - 1][column], [1, 0, 1, 0]), "deletion"],
        [addEditScore(scores[row][column - 1], [1, 0, 0, 1]), "insertion"],
      ];
      candidates.sort((left, right) => compareEditScore(left[0], right[0]));
      [scores[row][column], backtrack[row][column]] = candidates[0];
    }
  }

  const operations: Array<{ operation: EditOperation; expectedIndex?: number;
    recognizedIndex?: number; expectedPosition?: number }> = [];
  let row = expected.length;
  let column = recognized.length;
  while (row > 0 || column > 0) {
    const operation = backtrack[row][column];
    if (operation === "match" || operation === "substitution") {
      operations.push({ operation, expectedIndex: row - 1, recognizedIndex: column - 1 });
      row -= 1;
      column -= 1;
    } else if (operation === "deletion") {
      operations.push({ operation, expectedIndex: row - 1 });
      row -= 1;
    } else if (operation === "insertion") {
      operations.push({ operation, expectedPosition: row, recognizedIndex: column - 1 });
      column -= 1;
    } else {
      throw new Error("Raw-ASR-Editfolge ist unvollständig.");
    }
  }
  operations.reverse();
  const result = {
    prefixInsertions: [], internalInsertions: [], suffixInsertions: [],
    deletedExpectedWords: [], substitutedWords: [], repeatedInsertions: [],
  } as Pick<RawAsrContentGate,
    "prefixInsertions" | "internalInsertions" | "suffixInsertions"
    | "deletedExpectedWords" | "substitutedWords" | "repeatedInsertions">;
  const expectedCounts = new Map<string, number>();
  const recognizedCounts = new Map<string, number>();
  expected.forEach((word) => expectedCounts.set(word, (expectedCounts.get(word) ?? 0) + 1));
  recognized.forEach((word) => recognizedCounts.set(word, (recognizedCounts.get(word) ?? 0) + 1));
  for (const operation of operations) {
    if (operation.operation === "deletion") {
      const expectedIndex = operation.expectedIndex as number;
      result.deletedExpectedWords.push({ expectedIndex, word: expected[expectedIndex] });
    } else if (operation.operation === "substitution") {
      const expectedIndex = operation.expectedIndex as number;
      const recognizedIndex = operation.recognizedIndex as number;
      result.substitutedWords.push({
        expectedIndex, recognizedIndex,
        expectedWord: expected[expectedIndex], recognizedWord: recognized[recognizedIndex],
      });
    } else if (operation.operation === "insertion") {
      const recognizedIndex = operation.recognizedIndex as number;
      const insertion = { recognizedIndex, word: recognized[recognizedIndex] };
      if (operation.expectedPosition === 0) result.prefixInsertions.push(insertion);
      else if (operation.expectedPosition === expected.length) result.suffixInsertions.push(insertion);
      else result.internalInsertions.push(insertion);
      if ((recognizedCounts.get(insertion.word) ?? 0) > Math.max(1, expectedCounts.get(insertion.word) ?? 0)) {
        result.repeatedInsertions.push(insertion);
      }
    }
  }
  return result;
}

function linearPercentile(values: readonly number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const fraction = position - lowerIndex;
  return sorted[lowerIndex] * (1 - fraction) + sorted[upperIndex] * fraction;
}

export const t2aAudioDialogueEvaluationSchema = z.object({
  status: z.enum(["measured", "insufficient", "failed", "not-applicable", "not-available"]),
  blockerCode: dialogueBlockerCodeSchema,
  error: z.string().min(1).max(500).nullable(),
  method: z.literal("whisper-small-guided-word-motion.v1"),
  modelName: z.literal("OpenAI Whisper small").nullable(),
  modelSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  packageVersion: z.string().min(1).max(80).nullable(),
  detectedLanguage: z.string().min(1).max(16).nullable(),
  expectedTranscriptSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  expectedWordCount: z.number().int().min(0).max(200),
  recognizedWordCount: z.number().int().min(0).max(400),
  recognizedTranscript: z.string().max(4_000).nullable(),
  wordErrorRate: z.number().finite().min(0).nullable(),
  substitutions: z.number().int().min(0).max(200),
  deletions: z.number().int().min(0).max(200),
  insertions: z.number().int().min(0).max(400),
  rawAsrContentGate: rawAsrContentGateSchema,
  phonemeVerification: phonemeVerificationSchema,
  guidedAlignedWordCount: z.number().int().min(0).max(200),
  guidedWordCoverage: z.number().finite().min(0).max(1),
  usableAlignedWordCount: z.number().int().min(0).max(200),
  usableGuidedWordCoverage: z.number().finite().min(0).max(1),
  medianGuidedWordProbability: nullableRatioSchema,
  p10GuidedWordProbability: nullableRatioSchema,
  lowConfidenceAlignedWords: z.number().int().min(0).max(200),
  alignmentStatus: z.enum(["measured", "insufficient", "failed", "not-applicable"]),
  alignmentError: z.string().min(1).max(500).nullable(),
  timePrecisionMilliseconds: z.literal(20),
  guidedWords: z.array(guidedWordSchema).max(200),
}).strict().superRefine((value, context) => {
  if (value.status === "measured") {
    for (const field of [
      "modelName",
      "modelSha256",
      "packageVersion",
      "detectedLanguage",
      "expectedTranscriptSha256",
      "recognizedTranscript",
      "wordErrorRate",
      "medianGuidedWordProbability",
      "p10GuidedWordProbability",
    ] as const) {
      if (value[field] === null) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Eine gemessene Audio-Dialogprüfung benötigt diesen Messwert.",
        });
      }
    }
    if (value.error !== null
      || value.blockerCode !== "none"
      || value.expectedWordCount < 1
      || value.guidedAlignedWordCount < 1
      || value.alignmentStatus !== "measured") {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Eine gemessene Audio-Dialogprüfung benötigt vollständige Wortausrichtung ohne Fehler.",
      });
    }
  } else if (value.error === null || value.blockerCode === "none") {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "Eine nicht gemessene Audio-Dialogprüfung benötigt einen erklärenden Blocker.",
    });
  }
  const allowedBlockers: Record<typeof value.status, readonly (typeof value.blockerCode)[]> = {
    measured: ["none"],
    insufficient: [
      "target-transcript-too-long",
      "audio-missing",
      "duration-out-of-range",
      "alignment-insufficient",
    ],
    failed: ["evaluator-failed"],
    "not-applicable": ["target-transcript-missing"],
    "not-available": ["model-missing", "model-invalid", "runtime-unavailable"],
  };
  if (!allowedBlockers[value.status].includes(value.blockerCode)) {
    context.addIssue({
      code: "custom",
      path: ["blockerCode"],
      message: "Dialogstatus und Blocker-Code widersprechen einander.",
    });
  }
  if ((value.alignmentStatus === "measured" && value.alignmentError !== null)
    || (value.alignmentStatus === "insufficient" && value.alignmentError === null)) {
    context.addIssue({
      code: "custom",
      path: ["alignmentError"],
      message: "Ausrichtungsstatus und Ausrichtungsfehler widersprechen einander.",
    });
  }
  if (value.guidedAlignedWordCount !== value.guidedWords.length) {
    context.addIssue({
      code: "custom",
      path: ["guidedAlignedWordCount"],
      message: "Die Zahl ausgerichteter Wörter muss der gespeicherten Wortliste entsprechen.",
    });
  }
  if (value.usableAlignedWordCount !== value.guidedWords.filter((word) => word.usable).length) {
    context.addIssue({
      code: "custom",
      path: ["usableAlignedWordCount"],
      message: "Die Zahl nutzbarer Wörter muss der gespeicherten Wortliste entsprechen.",
    });
  }
  if (value.lowConfidenceAlignedWords > value.guidedAlignedWordCount) {
    context.addIssue({
      code: "custom",
      path: ["lowConfidenceAlignedWords"],
      message: "Mehr unsichere als ausgerichtete Wörter sind nicht möglich.",
    });
  }
  value.guidedWords.forEach((word, index) => {
    const previous = value.guidedWords[index - 1];
    if (word.index !== index
      || word.endSeconds < word.startSeconds
      || (previous && (
        word.startSeconds < previous.startSeconds
        || word.endSeconds < previous.endSeconds
      ))) {
      context.addIssue({
        code: "custom",
        path: ["guidedWords", index],
        message: "Geführte Wortdaten müssen lückenlos und zeitlich monoton sein.",
      });
    }
    const expectedUsable = word.probability >= 0.15 && word.endSeconds > word.startSeconds;
    if (word.usable !== expectedUsable) {
      context.addIssue({
        code: "custom",
        path: ["guidedWords", index, "usable"],
        message: "Wortnutzbarkeit stimmt nicht mit Wahrscheinlichkeit und Zeitfenster überein.",
      });
    }
  });
  const probabilities = value.guidedWords.map((word) => word.probability);
  const expectedMedian = linearPercentile(probabilities, 0.5);
  const expectedP10 = linearPercentile(probabilities, 0.1);
  if ((expectedMedian === null) !== (value.medianGuidedWordProbability === null)
    || (expectedMedian !== null
      && Math.abs(expectedMedian - (value.medianGuidedWordProbability ?? 0)) > 1e-12)
    || (expectedP10 === null) !== (value.p10GuidedWordProbability === null)
    || (expectedP10 !== null
      && Math.abs(expectedP10 - (value.p10GuidedWordProbability ?? 0)) > 1e-12)) {
    context.addIssue({
      code: "custom",
      path: ["medianGuidedWordProbability"],
      message: "Gespeicherte Wahrscheinlichkeitsquantile stimmen nicht mit den Wortdaten überein.",
    });
  }
  const expectedLowConfidenceWords = probabilities.filter((probability) => probability < 0.25).length;
  if (value.lowConfidenceAlignedWords !== expectedLowConfidenceWords) {
    context.addIssue({
      code: "custom",
      path: ["lowConfidenceAlignedWords"],
      message: "Die Zahl unsicherer Wörter stimmt nicht mit den Wortwahrscheinlichkeiten überein.",
    });
  }
  if (value.wordErrorRate !== null && value.expectedWordCount > 0) {
    const expectedRate = (
      value.substitutions + value.deletions + value.insertions
    ) / value.expectedWordCount;
    if (Math.abs(value.wordErrorRate - expectedRate) > 1e-9) {
      context.addIssue({
        code: "custom",
        path: ["wordErrorRate"],
        message: "Wortfehlerrate und S/D/I widersprechen einander.",
      });
    }
  }
  if (value.substitutions + value.deletions > value.expectedWordCount
    || value.substitutions + value.insertions > value.recognizedWordCount) {
    context.addIssue({
      code: "custom",
      path: ["substitutions"],
      message: "S/D/I sind mit den erwarteten und erkannten Wortzahlen unvereinbar.",
    });
  }
  const rawGate = value.rawAsrContentGate;
  if (rawGate.expectedNormalizedWords.length !== value.expectedWordCount
    || rawGate.recognizedNormalizedWords.length !== value.recognizedWordCount) {
    context.addIssue({
      code: "custom",
      path: ["rawAsrContentGate"],
      message: "Raw-ASR-Wortlisten und Wortzähler widersprechen einander.",
    });
  }
  const insertionFacts = [
    ...rawGate.prefixInsertions,
    ...rawGate.internalInsertions,
    ...rawGate.suffixInsertions,
  ];
  if (rawGate.substitutedWords.length !== value.substitutions
    || rawGate.deletedExpectedWords.length !== value.deletions
    || insertionFacts.length !== value.insertions) {
    context.addIssue({
      code: "custom",
      path: ["rawAsrContentGate"],
      message: "Raw-ASR-Editbefunde und S/D/I-Zähler widersprechen einander.",
    });
  }
  if (rawGate.status === "not-measured") {
    if (rawGate.exactTokenMatch !== null
      || rawGate.recognizedNormalizedWords.length !== 0
      || insertionFacts.length !== 0
      || rawGate.deletedExpectedWords.length !== 0
      || rawGate.substitutedWords.length !== 0
      || rawGate.repeatedInsertions.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["rawAsrContentGate", "status"],
        message: "Ein ungeprüfter Raw-ASR-Content-Gate darf keine erfundenen Edit-Befunde tragen.",
      });
    }
  } else {
    const expectedExact = rawGate.expectedNormalizedWords.length
      === rawGate.recognizedNormalizedWords.length
      && rawGate.expectedNormalizedWords.every(
        (word, index) => word === rawGate.recognizedNormalizedWords[index],
      );
    const expectedEdits = deriveRawAsrTokenEdits(
      rawGate.expectedNormalizedWords,
      rawGate.recognizedNormalizedWords,
    );
    for (const field of [
      "prefixInsertions", "internalInsertions", "suffixInsertions",
      "deletedExpectedWords", "substitutedWords", "repeatedInsertions",
    ] as const) {
      if (JSON.stringify(rawGate[field]) !== JSON.stringify(expectedEdits[field])) {
        context.addIssue({
          code: "custom",
          path: ["rawAsrContentGate", field],
          message: "Der Raw-ASR-Editbefund stimmt nicht mit den normalisierten Wortlisten überein.",
        });
      }
    }
    if (rawGate.exactTokenMatch !== expectedExact
      || (rawGate.status === "passed") !== expectedExact) {
      context.addIssue({
        code: "custom",
        path: ["rawAsrContentGate", "exactTokenMatch"],
        message: "Raw-ASR-Content-Gate und S/D/I-Zähler widersprechen einander.",
      });
    }
  }
  const expectedCoverage = value.expectedWordCount > 0
    ? Math.min(1, value.guidedAlignedWordCount / value.expectedWordCount)
    : 0;
  const expectedUsableCoverage = value.expectedWordCount > 0
    ? Math.min(1, value.usableAlignedWordCount / value.expectedWordCount)
    : 0;
  if (Math.abs(value.guidedWordCoverage - expectedCoverage) > 1e-9
    || Math.abs(value.usableGuidedWordCoverage - expectedUsableCoverage) > 1e-9) {
    context.addIssue({
      code: "custom",
      path: ["guidedWordCoverage"],
      message: "Gespeicherte Wortabdeckungen stimmen nicht mit den Wortzahlen überein.",
    });
  }
});

export type T2aAudioDialogueEvaluation = z.infer<typeof t2aAudioDialogueEvaluationSchema>;

export type T2aSpokenContentGateFacts = {
  dialogueEvaluation: T2aAudioDialogueEvaluation;
  authorityAudioSha256: string;
  phaseDocumentSha256: string;
  independentIpaPhase: IndependentIpaPhase;
  ipaAdjudicationResultSha256?: string;
  ipaAdjudicationResult?: T2aIpaAdjudicationResult;
};

export function deriveT2aPhonemeVerification(
  resultDocumentSha256: string,
  result: T2aIpaAdjudicationResult,
): z.infer<typeof adjudicatedPhonemeVerificationSchema> {
  return adjudicatedPhonemeVerificationSchema.parse({
    status: result.status,
    method: T2A_PHONEME_MEASUREMENT_METHOD,
    targetConditioned: true,
    evaluationMode: "measurement-only",
    releaseDecision: "blocked",
    adjudicationResultSha256: resultDocumentSha256,
    sourcePhaseStatus: result.sourcePhaseStatus,
    measurement: result.measurement,
  });
}

export function deriveT2aSpokenContentGate(
  facts: T2aSpokenContentGateFacts,
): T2aSpokenContentGate {
  if ((facts.ipaAdjudicationResultSha256 === undefined)
    !== (facts.ipaAdjudicationResult === undefined)) {
    throw new Error("IPA-Adjudication-Dokument und Digest muessen gemeinsam gebunden sein.");
  }
  const blockers: T2aSpokenContentGateBlockerCode[] = [
    "calibrated-holdout-not-qualified",
  ];
  const rawGate = facts.dialogueEvaluation.rawAsrContentGate;

  if (facts.independentIpaPhase.status === "insufficient") {
    blockers.push("independent-ipa-insufficient");
  } else if (facts.independentIpaPhase.status === "failed") {
    blockers.push("independent-ipa-failed");
  }
  if (facts.ipaAdjudicationResult?.status === "unavailable") {
    blockers.push("ipa-adjudication-unavailable");
  }
  if (rawGate.status === "not-measured") {
    blockers.push("raw-asr-not-measured");
  }
  if (rawGate.substitutedWords.length > 0) {
    blockers.push("raw-asr-substitution-unqualified");
  }
  if (rawGate.deletedExpectedWords.length > 0) {
    blockers.push("raw-asr-deletion-present");
  }
  if (rawGate.prefixInsertions.length > 0
    || rawGate.internalInsertions.length > 0
    || rawGate.suffixInsertions.length > 0) {
    blockers.push("raw-asr-insertion-present");
  }
  if (rawGate.repeatedInsertions.length > 0) {
    blockers.push("raw-asr-repetition-present");
  }

  return t2aSpokenContentGateSchema.parse({
    schemaVersion: T2A_SPOKEN_CONTENT_GATE_SCHEMA_VERSION,
    evaluationMode: "measurement-only",
    releaseDecision: "blocked",
    blockerCodes: blockers,
    releaseQualification: {
      status: "not-qualified",
      requiredPositiveHoldoutCases: 300,
      requiredNegativeHoldoutCases: 300,
      maximumFalseAccepts: 0,
      evidenceSha256: null,
    },
    independentIpa: {
      authorityAudioSha256: facts.authorityAudioSha256,
      phaseDocumentSha256: facts.phaseDocumentSha256,
      phase: facts.independentIpaPhase,
    },
    ...(facts.ipaAdjudicationResult === undefined ? {} : {
      ipaAdjudication: {
        resultDocumentSha256: facts.ipaAdjudicationResultSha256,
        result: facts.ipaAdjudicationResult,
      },
    }),
  });
}

export const t2aAudioFailureCodeSchema = z.enum([
  "arguments-invalid",
  "audio-snapshot-invalid",
  "audio-hash-mismatch",
  "wav-container-invalid",
  "wav-format-unsupported",
  "wav-data-invalid",
  "audio-silent",
  "ffmpeg-unverified",
  "whisper-unverified",
  "loudness-measurement-failed",
  "offline-runtime-unverified",
  "internal-error",
]);

const failedAnalysisSchema = z.object({
  schemaVersion: z.literal(T2A_AUDIO_QUALITY_SCHEMA_VERSION),
  mediaKind: z.literal("audio"),
  analysisKind: z.literal("t2a-audio-qa"),
  analysisStatus: z.literal("failed"),
  error: z.object({
    code: t2aAudioFailureCodeSchema,
    message: z.string().min(1).max(500),
  }).strict(),
  ia2vEligibility: t2aIa2vBlockedSchema,
}).strict().superRefine((value, context) => {
  const blockers = value.ia2vEligibility.blockers;
  if (blockers[0] !== "analysis-failed"
    || blockers.length < 1
    || blockers.length > 2
    || (blockers.length === 2 && blockers[1] !== "development-runtime-unattested")) {
    context.addIssue({
      code: "custom",
      path: ["ia2vEligibility", "blockers"],
      message: "Eine fehlgeschlagene Audioanalyse muss IA2V fail-closed blockieren.",
    });
  }
});

type EligibilityFacts = {
  wav: {
    durationSeconds: number;
  };
  pcm: {
    samplePeakLinear: number;
    fullScaleClippedSamples: number;
  };
  loudness: {
    truePeakDbtp: number;
  };
  policy: {
    peakCeilingLinear: number;
    pcm16LsbToleranceLinear: number;
  };
  dialogueEvaluation: T2aAudioDialogueEvaluation;
  spokenContentGate: T2aSpokenContentGate;
};

export function deriveT2aIa2vEligibility(facts: EligibilityFacts): T2aIa2vEligibility {
  const blockers: T2aIa2vBlockerCode[] = [];
  const { dialogueEvaluation: dialogue } = facts;

  if (facts.pcm.fullScaleClippedSamples !== 0) {
    blockers.push("full-scale-clipping-detected");
  }
  if (facts.pcm.samplePeakLinear
    > facts.policy.peakCeilingLinear + facts.policy.pcm16LsbToleranceLinear) {
    blockers.push("sample-peak-ceiling-exceeded");
  }
  if (!Number.isFinite(facts.loudness.truePeakDbtp)
    || facts.loudness.truePeakDbtp > 0) {
    blockers.push("true-peak-above-zero-dbtp");
  }
  if (facts.wav.durationSeconds > 30) {
    blockers.push("duration-exceeds-dialogue-window");
  }
  if (dialogue.status !== "measured") {
    blockers.push("dialogue-not-measured");
  }
  if (dialogue.modelName !== "OpenAI Whisper small"
    || dialogue.modelSha256 !== T2A_WHISPER_SMALL_SHA256) {
    blockers.push("dialogue-model-unverified");
  }
  if (dialogue.detectedLanguage !== "de") {
    blockers.push("detected-language-not-de");
  }
  if (dialogue.rawAsrContentGate.status !== "passed"
    || dialogue.rawAsrContentGate.exactTokenMatch !== true) {
    blockers.push("raw-asr-content-gate-not-passed");
  }
  if (dialogue.wordErrorRate !== 0) {
    blockers.push("word-error-rate-not-zero");
  }
  if (dialogue.substitutions !== 0 || dialogue.deletions !== 0 || dialogue.insertions !== 0) {
    blockers.push("word-edit-counts-not-zero");
  }
  blockers.push("spoken-content-gate-not-passed");
  if (dialogue.expectedWordCount < 1
    || dialogue.guidedAlignedWordCount !== dialogue.expectedWordCount
    || dialogue.guidedWordCoverage !== 1) {
    blockers.push("guided-word-coverage-incomplete");
  }
  if (dialogue.expectedWordCount < 1
    || dialogue.usableAlignedWordCount !== dialogue.expectedWordCount
    || dialogue.usableGuidedWordCoverage !== 1) {
    blockers.push("usable-guided-word-coverage-incomplete");
  }
  if (dialogue.lowConfidenceAlignedWords !== 0) {
    blockers.push("low-confidence-aligned-words-present");
  }
  if (dialogue.alignmentStatus !== "measured") {
    blockers.push("alignment-not-measured");
  }

  return t2aIa2vEligibilitySchema.parse(blockers.length === 0 ? {
    schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
    status: "eligible",
    blockers: [],
  } : {
    schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
    status: "blocked",
    blockers,
  });
}

const measuredAnalysisSchema = z.object({
  schemaVersion: z.literal(T2A_AUDIO_QUALITY_SCHEMA_VERSION),
  mediaKind: z.literal("audio"),
  analysisKind: z.literal("t2a-audio-qa"),
  analysisStatus: z.literal("measured"),
  sourceSnapshot: sourceSnapshotSchema,
  wav: wavPcm16Schema,
  pcm: pcmFactsSchema,
  loudness: loudnessFactsSchema,
  dialogueEvaluation: t2aAudioDialogueEvaluationSchema,
  spokenContentGate: t2aSpokenContentGateSchema,
  policy: policySchema,
  ia2vEligibility: t2aIa2vEligibilitySchema,
}).strict().superRefine((value, context) => {
  const expectedTotalSamples = value.wav.sampleFrames * value.wav.channels;
  if (!Number.isSafeInteger(expectedTotalSamples) || expectedTotalSamples !== value.pcm.totalSamples) {
    context.addIssue({
      code: "custom",
      path: ["pcm", "totalSamples"],
      message: "PCM-Samplezahl und WAV-Kanal-/Frameangaben widersprechen einander.",
    });
  }
  if (value.sourceSnapshot.byteLength < 44 + value.pcm.totalSamples * 2) {
    context.addIssue({
      code: "custom",
      path: ["sourceSnapshot", "byteLength"],
      message: "Der Snapshot ist für die gebundene PCM16-Samplezahl zu klein.",
    });
  }
  const expectedDuration = value.wav.sampleFrames / value.wav.sampleRateHz;
  if (Math.abs(value.wav.durationSeconds - expectedDuration) > 1e-9) {
    context.addIssue({
      code: "custom",
      path: ["wav", "durationSeconds"],
      message: "Die WAV-Dauer stimmt nicht mit Framezahl und Samplerate überein.",
    });
  }
  const expectedClipRatio = value.pcm.fullScaleClippedSamples / value.pcm.totalSamples;
  if (value.pcm.fullScaleClippedSamples > value.pcm.totalSamples) {
    context.addIssue({
      code: "custom",
      path: ["pcm", "fullScaleClippedSamples"],
      message: "Mehr Full-Scale-Samples als PCM-Samples sind nicht möglich.",
    });
  }
  if (Math.abs(value.pcm.fullScaleClippedRatio - expectedClipRatio) > 1e-12) {
    context.addIssue({
      code: "custom",
      path: ["pcm", "fullScaleClippedRatio"],
      message: "Das Full-Scale-Clipping-Verhältnis stimmt nicht mit den Samplezahlen überein.",
    });
  }
  const expectedPeakDbfs = 20 * Math.log10(value.pcm.samplePeakLinear);
  if (Math.abs(value.pcm.samplePeakDbfs - expectedPeakDbfs) > 1e-9) {
    context.addIssue({
      code: "custom",
      path: ["pcm", "samplePeakDbfs"],
      message: "Linearer Sample-Peak und dBFS-Wert widersprechen einander.",
    });
  }
  const quantizedPeak = Math.round(value.pcm.samplePeakLinear / PCM16_LSB_LINEAR)
    * PCM16_LSB_LINEAR;
  if (Math.abs(value.pcm.samplePeakLinear - quantizedPeak) > 1e-12) {
    context.addIssue({
      code: "custom",
      path: ["pcm", "samplePeakLinear"],
      message: "Ein PCM16-Sample-Peak muss auf genau einem PCM16-LSB-Raster liegen.",
    });
  }
  const expectedCeilingLinear = 10 ** (value.policy.peakCeilingDbfs / 20);
  if (Math.abs(value.policy.peakCeilingLinear - expectedCeilingLinear) > 1e-12) {
    context.addIssue({
      code: "custom",
      path: ["policy", "peakCeilingLinear"],
      message: "Lineare Peak-Grenze und dBFS-Vorgabe widersprechen einander.",
    });
  }
  const parsedSpokenContentGate = t2aSpokenContentGateSchema.safeParse(value.spokenContentGate);
  if (!parsedSpokenContentGate.success) return;
  const spokenContentGate = parsedSpokenContentGate.data;
  if (spokenContentGate.independentIpa.authorityAudioSha256
    !== value.sourceSnapshot.sha256) {
    context.addIssue({
      code: "custom",
      path: ["spokenContentGate", "independentIpa", "authorityAudioSha256"],
      message: "Spoken-Content-Gate und Audio-Snapshot binden nicht dieselbe Authority.",
    });
  } else {
    const expectedSpokenContentGate = deriveT2aSpokenContentGate({
      dialogueEvaluation: value.dialogueEvaluation,
      authorityAudioSha256: value.sourceSnapshot.sha256,
      phaseDocumentSha256: spokenContentGate.independentIpa.phaseDocumentSha256,
      independentIpaPhase: spokenContentGate.independentIpa.phase,
      ...(spokenContentGate.ipaAdjudication === undefined ? {} : {
        ipaAdjudicationResultSha256:
          spokenContentGate.ipaAdjudication.resultDocumentSha256,
        ipaAdjudicationResult: spokenContentGate.ipaAdjudication.result,
      }),
    });
    if (JSON.stringify(spokenContentGate) !== JSON.stringify(expectedSpokenContentGate)) {
      context.addIssue({
        code: "custom",
        path: ["spokenContentGate"],
        message: "Spoken-Content-Gate stimmt nicht mit den gebundenen Rohbefunden überein.",
      });
    }
    if (spokenContentGate.ipaAdjudication !== undefined) {
      const { resultDocumentSha256, result } = spokenContentGate.ipaAdjudication;
      if (result.targetTextSha256
          !== value.dialogueEvaluation.expectedTranscriptSha256
        || JSON.stringify(value.dialogueEvaluation.phonemeVerification)
          !== JSON.stringify(deriveT2aPhonemeVerification(resultDocumentSha256, result))) {
        context.addIssue({
          code: "custom",
          path: ["dialogueEvaluation", "phonemeVerification"],
          message: "Phonemmessung ist nicht bytegebunden aus der IPA-Adjudication abgeleitet.",
        });
      }
    }
  }
  const expectedEligibility = deriveT2aIa2vEligibility(value);
  const expectedDevelopmentEligibility = bindT2aIa2vEligibilityClaimScope(
    expectedEligibility,
    "development",
  );
  if (JSON.stringify(value.ia2vEligibility) !== JSON.stringify(expectedEligibility)
    && JSON.stringify(value.ia2vEligibility) !== JSON.stringify(expectedDevelopmentEligibility)) {
    context.addIssue({
      code: "custom",
      path: ["ia2vEligibility"],
      message: "IA2V-Eligibility stimmt nicht mit den gebundenen Messwerten überein.",
    });
  }
});

export const t2aAudioQualitySchema = z.discriminatedUnion("analysisStatus", [
  measuredAnalysisSchema,
  failedAnalysisSchema,
]);

export type T2aAudioQuality = z.infer<typeof t2aAudioQualitySchema>;
export type T2aMeasuredAudioQuality = z.infer<typeof measuredAnalysisSchema>;
export type T2aFailedAudioQuality = z.infer<typeof failedAnalysisSchema>;

export function bindT2aIa2vEligibilityClaimScope(
  eligibility: T2aIa2vEligibility,
  claimScope: T2aAudioClaimScope,
): T2aIa2vEligibility {
  if (claimScope === "sealed-release") return eligibility;
  if (eligibility.status === "blocked"
    && eligibility.blockers.includes("development-runtime-unattested")) return eligibility;
  const blockers = eligibility.status === "eligible"
    ? ["development-runtime-unattested" as const]
    : [...eligibility.blockers, "development-runtime-unattested" as const];
  return t2aIa2vEligibilitySchema.parse({
    schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
    status: "blocked",
    blockers,
  });
}

export function bindT2aAudioQualityClaimScope(
  result: T2aAudioQuality,
  claimScope: T2aAudioClaimScope,
): T2aAudioQuality {
  if (claimScope === "sealed-release") return result;
  return t2aAudioQualitySchema.parse({
    ...result,
    ia2vEligibility: bindT2aIa2vEligibilityClaimScope(result.ia2vEligibility, claimScope),
  });
}
