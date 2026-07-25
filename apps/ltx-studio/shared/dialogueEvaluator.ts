import { z } from "zod";

const nullableRatio = z.number().finite().min(0).max(1).nullable();
const nullableCorrelation = z.number().finite().min(-1).max(1).nullable();
const blockerCodeSchema = z.enum([
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
  tokenIds: z.array(z.number().int().min(0)).min(1).max(32),
  startSeconds: z.number().finite().min(0).max(30),
  endSeconds: z.number().finite().min(0).max(30),
  probability: z.number().finite().min(0).max(1),
  usable: z.boolean(),
}).strict();

export const dialogueEvaluationSchema = z.object({
  status: z.enum(["measured", "insufficient", "failed", "not-applicable", "not-available"]),
  blockerCode: blockerCodeSchema,
  error: z.string().min(1).max(500).nullable(),
  method: z.literal("whisper-small-guided-word-motion.v1"),
  modelName: z.literal("OpenAI Whisper small").nullable(),
  modelSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  packageVersion: z.string().min(1).max(80).nullable(),
  detectedLanguage: z.string().min(1).max(16).nullable(),
  expectedTranscriptSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  expectedWordCount: z.number().int().min(0),
  recognizedWordCount: z.number().int().min(0),
  recognizedTranscript: z.string().max(4_000).nullable(),
  wordErrorRate: z.number().finite().min(0).nullable(),
  substitutions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  insertions: z.number().int().min(0),
  guidedAlignedWordCount: z.number().int().min(0),
  guidedWordCoverage: z.number().finite().min(0).max(1),
  usableAlignedWordCount: z.number().int().min(0),
  usableGuidedWordCoverage: z.number().finite().min(0).max(1),
  medianGuidedWordProbability: nullableRatio,
  p10GuidedWordProbability: nullableRatio,
  lowConfidenceAlignedWords: z.number().int().min(0),
  alignmentStatus: z.enum(["measured", "insufficient", "failed", "not-applicable"]),
  alignmentError: z.string().min(1).max(500).nullable(),
  timePrecisionMilliseconds: z.literal(20),
  audioStartRelativeVideoSeconds: z.number().finite().min(-30).max(30).nullable(),
  guidedWords: z.array(guidedWordSchema).max(200),
  trackedWordCount: z.number().int().min(0),
  mouthTrackedWordCoverage: z.number().finite().min(0).max(1),
  wordsWithMouthMotionRatio: nullableRatio,
  pauseMotionRatio: nullableRatio,
  estimatedWordActivityLeadMilliseconds: z.number().int().min(-500).max(500).nullable(),
  lagResolutionMilliseconds: z.number().int().min(10).max(200).nullable(),
  correlationPeak: nullableCorrelation,
  nullP95Correlation: nullableCorrelation,
  wordMotionProxyStatus: z.enum(["measured", "insufficient", "failed", "not-applicable"]),
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
          message: "Eine gemessene Dialogprüfung benötigt diesen Messwert.",
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
        message: "Eine gemessene Dialogprüfung benötigt Text, Wortzeiten und darf keinen Fehler tragen.",
      });
    }
  } else if (value.error === null || value.blockerCode === "none") {
    context.addIssue({
      code: "custom",
      path: ["error"],
      message: "Eine nicht gemessene Dialogprüfung benötigt einen erklärenden Fehlertext.",
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
      message: "Status und Blocker-Code widersprechen einander.",
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
  const usableCount = value.guidedWords.filter((word) => word.usable).length;
  if (value.usableAlignedWordCount !== usableCount) {
    context.addIssue({
      code: "custom",
      path: ["usableAlignedWordCount"],
      message: "Die Zahl nutzbarer Wörter muss der gespeicherten Wortliste entsprechen.",
    });
  }
  value.guidedWords.forEach((word, index) => {
    if (word.index !== index) {
      context.addIssue({
        code: "custom",
        path: ["guidedWords", index, "index"],
        message: "Wortindizes müssen lückenlos und aufsteigend sein.",
      });
    }
    if (word.endSeconds < word.startSeconds) {
      context.addIssue({
        code: "custom",
        path: ["guidedWords", index, "endSeconds"],
        message: "Das Wortende darf nicht vor dem Wortanfang liegen.",
      });
    }
    const previous = value.guidedWords[index - 1];
    if (previous && (
      word.startSeconds < previous.startSeconds
      || word.endSeconds < previous.endSeconds
    )) {
      context.addIssue({
        code: "custom",
        path: ["guidedWords", index, "startSeconds"],
        message: "Wortzeiten müssen monoton sein.",
      });
    }
  });
  if (value.wordErrorRate !== null && value.expectedWordCount > 0) {
    const expectedWer = (
      value.substitutions + value.deletions + value.insertions
    ) / value.expectedWordCount;
    if (Math.abs(value.wordErrorRate - expectedWer) > 1e-9) {
      context.addIssue({
        code: "custom",
        path: ["wordErrorRate"],
        message: "Die Wortfehlerrate stimmt nicht mit S, D und I überein.",
      });
    }
  }
  if (value.substitutions + value.deletions > value.expectedWordCount
    || value.substitutions + value.insertions > value.recognizedWordCount) {
    context.addIssue({
      code: "custom",
      path: ["substitutions"],
      message: "S, D und I sind mit den erwarteten beziehungsweise erkannten Wortzahlen unvereinbar.",
    });
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
  if (value.trackedWordCount > value.usableAlignedWordCount) {
    context.addIssue({
      code: "custom",
      path: ["trackedWordCount"],
      message: "Mehr verfolgte als nutzbare Wortfenster sind nicht möglich.",
    });
  }
  const expectedMouthCoverage = value.usableAlignedWordCount > 0
    ? value.trackedWordCount / value.usableAlignedWordCount
    : 0;
  if (Math.abs(value.mouthTrackedWordCoverage - expectedMouthCoverage) > 1e-9) {
    context.addIssue({
      code: "custom",
      path: ["mouthTrackedWordCoverage"],
      message: "Mundtracking-Abdeckung stimmt nicht mit den Wortzahlen überein.",
    });
  }
});

export type DialogueEvaluation = z.infer<typeof dialogueEvaluationSchema>;

export function notApplicableDialogueEvaluation(): DialogueEvaluation {
  return dialogueEvaluationSchema.parse({
    status: "not-applicable",
    blockerCode: "target-transcript-missing",
    error: "Im Dialogfeld ist kein auswertbarer exakter Wortlaut gespeichert.",
    method: "whisper-small-guided-word-motion.v1",
    modelName: null,
    modelSha256: null,
    packageVersion: null,
    detectedLanguage: null,
    expectedTranscriptSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    expectedWordCount: 0,
    recognizedWordCount: 0,
    recognizedTranscript: null,
    wordErrorRate: null,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    guidedAlignedWordCount: 0,
    guidedWordCoverage: 0,
    usableAlignedWordCount: 0,
    usableGuidedWordCoverage: 0,
    medianGuidedWordProbability: null,
    p10GuidedWordProbability: null,
    lowConfidenceAlignedWords: 0,
    alignmentStatus: "not-applicable",
    alignmentError: null,
    timePrecisionMilliseconds: 20,
    audioStartRelativeVideoSeconds: null,
    guidedWords: [],
    trackedWordCount: 0,
    mouthTrackedWordCoverage: 0,
    wordsWithMouthMotionRatio: null,
    pauseMotionRatio: null,
    estimatedWordActivityLeadMilliseconds: null,
    lagResolutionMilliseconds: null,
    correlationPeak: null,
    nullP95Correlation: null,
    wordMotionProxyStatus: "not-applicable",
  });
}
