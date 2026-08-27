import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";
import {
  detachedSignatureSchema,
  trustedKeyPolicySchema,
  verifyDetachedSignature,
} from "./releaseAudit.js";

export const T2A_SPOKEN_CONTENT_HOLDOUT_POLICY_VERSION =
  "ltx-studio-t2a-spoken-content-holdout-policy.v1" as const;
export const T2A_SPOKEN_CONTENT_HOLDOUT_CASE_MANIFEST_VERSION =
  "ltx-studio-t2a-spoken-content-holdout-case-manifest.v1" as const;
export const T2A_SPOKEN_CONTENT_HOLDOUT_REPORT_VERSION =
  "ltx-studio-t2a-spoken-content-holdout-report.v1" as const;
export const T2A_SPOKEN_CONTENT_HOLDOUT_VERIFIER_POLICY_VERSION =
  "ltx-studio-t2a-spoken-content-holdout-verifier-policy.v1" as const;

export const T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES = 300 as const;
export const T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES = 300 as const;
export const T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES = 600 as const;
export const T2A_SPOKEN_CONTENT_HOLDOUT_CONFIDENCE_LEVEL = 0.95 as const;
export const T2A_SPOKEN_CONTENT_HOLDOUT_ZERO_FA_UPPER_BOUND_95 =
  1 - Math.pow(0.05, 1 / T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES);
export const t2aSpokenContentHoldoutNegativeDifficultyBands = [
  "easiest-reference-ipa-distance-tercile",
  "hardest-reference-ipa-distance-tercile",
  "middle-reference-ipa-distance-tercile",
] as const;

const canonicalizationSchema = z.literal("ltx-studio-canonical-json.v1");
const digestAlgorithmSchema = z.literal("sha256");
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);
const utcTimestampSchema = z.string().datetime({ offset: false, precision: 0 });
const replayDomainSchema = z
  .string()
  .regex(/^ltx-studio:t2a-spoken-content-holdout:[0-9a-f]{64}:[A-Za-z0-9._-]{3,64}$/u);

function milliseconds(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid UTC timestamp");
  return parsed;
}

function isStrictlySorted(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function addSortedUniqueIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: "values must be unique" });
  }
  if (!isStrictlySorted(values)) {
    context.addIssue({ code: "custom", path, message: "values must be strictly sorted" });
  }
}

export const t2aSpokenContentHoldoutBindingsSchema = z
  .object({
    releaseDigest: sha256Schema,
    surfaceDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    evaluationMatrixDigest: sha256Schema,
    combinedEvaluatorDigest: sha256Schema,
    scorerDigest: sha256Schema,
    adjudicatorDigest: sha256Schema,
    ipaModelManifestDigest: sha256Schema,
    ipaModelWeightsDigest: sha256Schema,
    ipaRunnerDigest: sha256Schema,
    g2pDigest: sha256Schema,
    normalizationPolicyDigest: sha256Schema,
    thresholdPolicyDigest: sha256Schema,
    leakageManifestDigest: sha256Schema,
    consumptionHeadDigest: sha256Schema,
    trustPolicyDigest: sha256Schema,
  })
  .strict()
  .superRefine((bindings, context) => {
    if (bindings.scorerDigest === bindings.adjudicatorDigest) {
      context.addIssue({
        code: "custom",
        path: ["adjudicatorDigest"],
        message: "scorer and adjudicator must be independently pinned",
      });
    }
    if (bindings.ipaModelWeightsDigest === bindings.ipaRunnerDigest) {
      context.addIssue({
        code: "custom",
        path: ["ipaRunnerDigest"],
        message: "IPA model and runner must be independently pinned",
      });
    }
  });

export const t2aSpokenContentHoldoutClaimDomainSchema = z
  .object({
    locale: z.literal("de-DE"),
    maximumAudioDurationMilliseconds: z.number().int().min(1_000).max(21_000),
    maximumSpokenWordCount: z.number().int().min(1).max(200),
    positiveDefinition: z
      .object({
        expectedClass: z.literal("positive"),
        audioAuthority: z.literal("authentic-dataset-audio-digest"),
        referenceAuthority: z.literal(
          "own-authoritative-dataset-transcript-digest",
        ),
        pairing: z.literal("authoritative-audio-reference-pair"),
        expectedDecision: z.literal("accept"),
      })
      .strict(),
    negativeDefinition: z
      .object({
        expectedClass: z.literal("negative"),
        audioMarginal: z.literal("same-authentic-audio-digest-set-as-positive"),
        referenceAuthority: z.literal(
          "foreign-authoritative-dataset-transcript-digest",
        ),
        assignment: z.literal("preregistered-deterministic-bijective-derangement"),
        derangementFixedPoints: z.literal(0),
        observedAudioOrModelScoreUsedForAssignment: z.literal(false),
        referenceIpaRelation: z.literal("different"),
        orthographicHomophonePolicy: z.literal("excluded"),
        minimumPinnedReferenceIpaEditDistance: z.literal(1),
        expectedDecision: z.literal("reject"),
        difficultyMeasure: z.literal("symmetric-reference-ipa-token-error-rate.v1"),
        difficultyBanding: z.literal("stable-rank-terciles-100-each.v1"),
        difficultyBandsAssignment: z.literal("exactly-one-partition"),
        difficultyBands: z
          .array(
            z
              .object({
                band: z.enum(t2aSpokenContentHoldoutNegativeDifficultyBands),
                caseCount: z
                  .number()
                  .int()
                  .positive()
                  .max(T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES),
              })
              .strict(),
          )
          .length(t2aSpokenContentHoldoutNegativeDifficultyBands.length),
      })
      .strict(),
    groupingAndLeakage: z
      .object({
        groupIdAlgorithm: z.literal("sha256"),
        groupUnit: z.literal(
          "dataset-speaker-and-transitive-leakage-component",
        ),
        maximumCasesPerGroup: z
          .number()
          .int()
          .positive()
          .max(T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES),
        crossClassAudioDigestSetRelation: z.literal("identical"),
        crossClassGroupSetRelation: z.literal("identical"),
        maximumCalibrationGroupOverlap: z.literal(0),
        maximumCrossReleaseGroupOverlap: z.literal(0),
        groupingRuleDigest: sha256Schema,
        leakageRuleDigest: sha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((domain, context) => {
    const bands = domain.negativeDefinition.difficultyBands;
    const names = bands.map(({ band }) => band);
    addSortedUniqueIssues(names, context, ["negativeDefinition", "difficultyBands"]);
    if (
      !sameCanonicalValue(names, [...t2aSpokenContentHoldoutNegativeDifficultyBands])
    ) {
      context.addIssue({
        code: "custom",
        path: ["negativeDefinition", "difficultyBands"],
        message: "the complete frozen negative-difficulty band set is required",
      });
    }
    if (
      bands.reduce((total, { caseCount }) => total + caseCount, 0) !==
      T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES
    ) {
      context.addIssue({
        code: "custom",
        path: ["negativeDefinition", "difficultyBands"],
        message: "negative-difficulty band counts must cover all negative cases",
      });
    }
    if (
      domain.groupingAndLeakage.groupingRuleDigest ===
      domain.groupingAndLeakage.leakageRuleDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["groupingAndLeakage", "leakageRuleDigest"],
        message: "grouping and leakage rules must be independently pinned",
      });
    }
  });

export const t2aSpokenContentHoldoutPolicySchema = z
  .object({
    schemaVersion: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_POLICY_VERSION),
    canonicalization: canonicalizationSchema,
    digestAlgorithm: digestAlgorithmSchema,
    policyId: identifierSchema,
    bindings: t2aSpokenContentHoldoutBindingsSchema,
    claimDomain: t2aSpokenContentHoldoutClaimDomainSchema,
    caseManifestDigest: sha256Schema,
    holdoutScorerKeyId: identifierSchema,
    expectedPositiveCases: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES),
    expectedNegativeCases: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES),
    maximumFalseAccepts: z.literal(0),
    maximumAbstentions: z.literal(0),
    minimumTrueAccepts: z.number().int().min(1).max(T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES),
    confidenceMethod: z.literal("clopper-pearson-one-sided-upper.v1"),
    confidenceLevel: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_CONFIDENCE_LEVEL),
    issuedAt: utcTimestampSchema,
    notBefore: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
    replayDomain: replayDomainSchema,
  })
  .strict()
  .superRefine((policy, context) => {
    const issuedAt = milliseconds(policy.issuedAt);
    const notBefore = milliseconds(policy.notBefore);
    const expiresAt = milliseconds(policy.expiresAt);
    if (issuedAt > notBefore) {
      context.addIssue({
        code: "custom",
        path: ["issuedAt"],
        message: "policy must be issued no later than its validity window",
      });
    }
    if (notBefore >= expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "policy validity window is inconsistent",
      });
    }
  });

export const t2aSpokenContentHoldoutCaseManifestSchema = z
  .object({
    schemaVersion: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_CASE_MANIFEST_VERSION),
    canonicalization: canonicalizationSchema,
    digestAlgorithm: digestAlgorithmSchema,
    caseIdAlgorithm: z.literal("sha256"),
    manifestId: identifierSchema,
    bindings: t2aSpokenContentHoldoutBindingsSchema,
    claimDomain: t2aSpokenContentHoldoutClaimDomainSchema,
    positiveCaseIds: z.array(sha256Schema).length(T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES),
    negativeCaseIds: z.array(sha256Schema).length(T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES),
    createdAt: utcTimestampSchema,
    notBefore: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
    replayDomain: replayDomainSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    addSortedUniqueIssues(manifest.positiveCaseIds, context, ["positiveCaseIds"]);
    addSortedUniqueIssues(manifest.negativeCaseIds, context, ["negativeCaseIds"]);
    const positive = new Set(manifest.positiveCaseIds);
    if (manifest.negativeCaseIds.some((caseId) => positive.has(caseId))) {
      context.addIssue({
        code: "custom",
        path: ["negativeCaseIds"],
        message: "positive and negative holdout cases must be disjoint",
      });
    }
    const createdAt = milliseconds(manifest.createdAt);
    const notBefore = milliseconds(manifest.notBefore);
    const expiresAt = milliseconds(manifest.expiresAt);
    if (createdAt > notBefore || notBefore >= expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "case-manifest validity window is inconsistent",
      });
    }
  });

const holdoutDecisionSchema = z.enum(["accept", "reject", "abstain"]);
const expectedClassSchema = z.enum(["positive", "negative"]);

const holdoutCaseResultSchema = z
  .object({
    caseId: sha256Schema,
    expectedClass: expectedClassSchema,
    decision: holdoutDecisionSchema,
  })
  .strict();

const confusionMatrixSchema = z
  .object({
    trueAccepts: z.number().int().nonnegative().max(T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES),
    falseRejects: z.number().int().nonnegative().max(T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES),
    positiveAbstentions: z.number().int().nonnegative().max(T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES),
    trueRejects: z.number().int().nonnegative().max(T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES),
    falseAccepts: z.number().int().nonnegative().max(T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES),
    negativeAbstentions: z.number().int().nonnegative().max(T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES),
    totalCases: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES),
    decidedCases: z.number().int().nonnegative().max(T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES),
    abstentions: z.number().int().nonnegative().max(T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES),
  })
  .strict()
  .superRefine((matrix, context) => {
    if (
      matrix.trueAccepts + matrix.falseRejects + matrix.positiveAbstentions !==
      T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES
    ) {
      context.addIssue({
        code: "custom",
        path: ["trueAccepts"],
        message: "positive confusion-matrix counts are inconsistent",
      });
    }
    if (
      matrix.trueRejects + matrix.falseAccepts + matrix.negativeAbstentions !==
      T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES
    ) {
      context.addIssue({
        code: "custom",
        path: ["trueRejects"],
        message: "negative confusion-matrix counts are inconsistent",
      });
    }
    if (
      matrix.abstentions !== matrix.positiveAbstentions + matrix.negativeAbstentions ||
      matrix.decidedCases + matrix.abstentions !== T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES
    ) {
      context.addIssue({
        code: "custom",
        path: ["abstentions"],
        message: "decision and abstention counts are inconsistent",
      });
    }
  });

export const t2aSpokenContentHoldoutFailureReasons = [
  "abstentions-present",
  "false-accepts-present",
  "true-accept-floor-not-met",
] as const;

const confidenceStatementSchema = z
  .object({
    method: z.literal("clopper-pearson-one-sided-upper.v1"),
    confidenceLevel: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_CONFIDENCE_LEVEL),
    negativeTrials: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES),
    observedFalseAccepts: z
      .number()
      .int()
      .nonnegative()
      .max(T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES),
    falseAcceptRateUpperBound95: z.number().finite().nonnegative().max(1).nullable(),
  })
  .strict()
  .superRefine((statement, context) => {
    if (statement.observedFalseAccepts === 0) {
      if (
        statement.falseAcceptRateUpperBound95 === null ||
        !Object.is(
          statement.falseAcceptRateUpperBound95,
          T2A_SPOKEN_CONTENT_HOLDOUT_ZERO_FA_UPPER_BOUND_95,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["falseAcceptRateUpperBound95"],
          message: "zero-false-accept 95% upper bound must be the exact numeric value",
        });
      }
    } else if (statement.falseAcceptRateUpperBound95 !== null) {
      context.addIssue({
        code: "custom",
        path: ["falseAcceptRateUpperBound95"],
        message: "this v1 report only states the predeclared 0/300 upper bound",
      });
    }
  });

export const t2aSpokenContentHoldoutReportSchema = z
  .object({
    schemaVersion: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_REPORT_VERSION),
    canonicalization: canonicalizationSchema,
    digestAlgorithm: digestAlgorithmSchema,
    reportId: identifierSchema,
    bindings: t2aSpokenContentHoldoutBindingsSchema,
    claimDomain: t2aSpokenContentHoldoutClaimDomainSchema,
    policyDigest: sha256Schema,
    caseManifestDigest: sha256Schema,
    holdoutScorerKeyId: identifierSchema,
    replayDomain: replayDomainSchema,
    replayNonce: sha256Schema,
    evaluatedAt: utcTimestampSchema,
    expiresAt: utcTimestampSchema,
    minimumTrueAccepts: z.number().int().min(1).max(T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES),
    maximumFalseAccepts: z.literal(0),
    maximumAbstentions: z.literal(0),
    confusionMatrix: confusionMatrixSchema,
    confidence: confidenceStatementSchema,
    caseResults: z.array(holdoutCaseResultSchema).length(T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES),
    qualificationStatus: z.enum(["qualified", "not-qualified"]),
    failureReasons: z.array(z.enum(t2aSpokenContentHoldoutFailureReasons)).max(3),
  })
  .strict()
  .superRefine((report, context) => {
    const caseIds = report.caseResults.map(({ caseId }) => caseId);
    addSortedUniqueIssues(caseIds, context, ["caseResults"]);
    addSortedUniqueIssues(report.failureReasons, context, ["failureReasons"]);
    if (milliseconds(report.evaluatedAt) >= milliseconds(report.expiresAt)) {
      context.addIssue({
        code: "custom",
        path: ["evaluatedAt"],
        message: "report must be evaluated before expiry",
      });
    }
  });

export const t2aSpokenContentHoldoutVerifierPolicySchema = z
  .object({
    schemaVersion: z.literal(T2A_SPOKEN_CONTENT_HOLDOUT_VERIFIER_POLICY_VERSION),
    expectedPolicyDigest: sha256Schema,
    expectedCaseManifestDigest: sha256Schema,
    expectedBindings: t2aSpokenContentHoldoutBindingsSchema,
    expectedClaimDomain: t2aSpokenContentHoldoutClaimDomainSchema,
    expectedHoldoutScorerKeyId: identifierSchema,
    expectedReplayDomain: replayDomainSchema,
    requiredMinimumTrueAccepts: z
      .number()
      .int()
      .min(1)
      .max(T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES),
    maximumValiditySeconds: z.number().int().positive().max(7 * 24 * 60 * 60),
  })
  .strict();

export type T2aSpokenContentHoldoutBindings = z.infer<
  typeof t2aSpokenContentHoldoutBindingsSchema
>;
export type T2aSpokenContentHoldoutClaimDomain = z.infer<
  typeof t2aSpokenContentHoldoutClaimDomainSchema
>;
export type T2aSpokenContentHoldoutPolicy = z.infer<
  typeof t2aSpokenContentHoldoutPolicySchema
>;
export type T2aSpokenContentHoldoutCaseManifest = z.infer<
  typeof t2aSpokenContentHoldoutCaseManifestSchema
>;
export type T2aSpokenContentHoldoutReport = z.infer<
  typeof t2aSpokenContentHoldoutReportSchema
>;
export type T2aSpokenContentHoldoutVerifierPolicy = z.infer<
  typeof t2aSpokenContentHoldoutVerifierPolicySchema
>;

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function t2aSpokenContentHoldoutPolicyDigest(rawPolicy: unknown): string {
  return canonicalSha256(t2aSpokenContentHoldoutPolicySchema.parse(rawPolicy));
}

export function t2aSpokenContentHoldoutCaseManifestDigest(rawManifest: unknown): string {
  return canonicalSha256(t2aSpokenContentHoldoutCaseManifestSchema.parse(rawManifest));
}

export function t2aSpokenContentHoldoutReportDigest(rawReport: unknown): string {
  return canonicalSha256(t2aSpokenContentHoldoutReportSchema.parse(rawReport));
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function parseFailClosed<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`Invalid ${label}`);
  return result.data;
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!sameCanonicalValue(actual, expected)) throw new Error(message);
}

type ConfusionMatrix = z.infer<typeof confusionMatrixSchema>;

function deriveConfusionMatrix(
  report: T2aSpokenContentHoldoutReport,
  manifest: T2aSpokenContentHoldoutCaseManifest,
): ConfusionMatrix {
  const positive = new Set(manifest.positiveCaseIds);
  const negative = new Set(manifest.negativeCaseIds);
  let trueAccepts = 0;
  let falseRejects = 0;
  let positiveAbstentions = 0;
  let trueRejects = 0;
  let falseAccepts = 0;
  let negativeAbstentions = 0;

  for (const result of report.caseResults) {
    const expectedClass = positive.has(result.caseId)
      ? "positive"
      : negative.has(result.caseId)
        ? "negative"
        : null;
    if (expectedClass === null || result.expectedClass !== expectedClass) {
      throw new Error("Holdout case coverage or class binding mismatch");
    }
    if (expectedClass === "positive") {
      if (result.decision === "accept") trueAccepts += 1;
      else if (result.decision === "reject") falseRejects += 1;
      else positiveAbstentions += 1;
    } else if (result.decision === "accept") falseAccepts += 1;
    else if (result.decision === "reject") trueRejects += 1;
    else negativeAbstentions += 1;
  }

  const abstentions = positiveAbstentions + negativeAbstentions;
  return {
    trueAccepts,
    falseRejects,
    positiveAbstentions,
    trueRejects,
    falseAccepts,
    negativeAbstentions,
    totalCases: T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES,
    decidedCases: T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES - abstentions,
    abstentions,
  };
}

const verificationOptionsSchema = z
  .object({
    policyDocument: z.unknown(),
    caseManifestDocument: z.unknown(),
    reportDocument: z.unknown(),
    reportSignature: z.unknown(),
    trustPolicy: z.unknown(),
    verifierPolicy: z.unknown(),
    now: z.date(),
    consumedReplayKeys: z.array(sha256Schema),
  })
  .strict()
  .superRefine((options, context) => {
    addSortedUniqueIssues(options.consumedReplayKeys, context, ["consumedReplayKeys"]);
  });

export type VerifyT2aSpokenContentHoldoutOptions = z.input<
  typeof verificationOptionsSchema
>;

export type VerifiedT2aSpokenContentHoldout = Readonly<{
  policyDigest: string;
  caseManifestDigest: string;
  reportDigest: string;
  replayKey: string;
  qualified: true;
}>;

export function verifyT2aSpokenContentHoldout(
  rawOptions: VerifyT2aSpokenContentHoldoutOptions,
): VerifiedT2aSpokenContentHoldout {
  const options = parseFailClosed(verificationOptionsSchema, rawOptions, "verification options");
  const policy = parseFailClosed(
    t2aSpokenContentHoldoutPolicySchema,
    options.policyDocument,
    "holdout policy document",
  );
  const manifest = parseFailClosed(
    t2aSpokenContentHoldoutCaseManifestSchema,
    options.caseManifestDocument,
    "holdout case manifest",
  );
  const report = parseFailClosed(
    t2aSpokenContentHoldoutReportSchema,
    options.reportDocument,
    "holdout report",
  );
  const verifierPolicy = parseFailClosed(
    t2aSpokenContentHoldoutVerifierPolicySchema,
    options.verifierPolicy,
    "holdout verifier policy",
  );
  const trustPolicy = parseFailClosed(
    trustedKeyPolicySchema,
    options.trustPolicy,
    "trusted-key policy",
  );
  const signature = parseFailClosed(
    detachedSignatureSchema,
    options.reportSignature,
    "holdout report signature",
  );

  const nowMs = options.now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error("Invalid verification time");
  const policyDigest = canonicalSha256(policy);
  const caseManifestDigest = canonicalSha256(manifest);
  const trustPolicyDigest = canonicalSha256(trustPolicy);
  if (
    policyDigest !== verifierPolicy.expectedPolicyDigest ||
    policyDigest !== report.policyDigest
  ) {
    throw new Error("Holdout policy digest binding mismatch");
  }
  if (
    caseManifestDigest !== verifierPolicy.expectedCaseManifestDigest ||
    caseManifestDigest !== policy.caseManifestDigest ||
    caseManifestDigest !== report.caseManifestDigest
  ) {
    throw new Error("Holdout case-manifest digest binding mismatch");
  }
  assertEqual(policy.bindings, verifierPolicy.expectedBindings, "Holdout policy binding mismatch");
  assertEqual(manifest.bindings, verifierPolicy.expectedBindings, "Case-manifest binding mismatch");
  assertEqual(report.bindings, verifierPolicy.expectedBindings, "Holdout report binding mismatch");
  assertEqual(
    policy.claimDomain,
    verifierPolicy.expectedClaimDomain,
    "Holdout policy claim-domain mismatch",
  );
  assertEqual(
    manifest.claimDomain,
    verifierPolicy.expectedClaimDomain,
    "Case-manifest claim-domain mismatch",
  );
  assertEqual(
    report.claimDomain,
    verifierPolicy.expectedClaimDomain,
    "Holdout report claim-domain mismatch",
  );
  if (trustPolicyDigest !== verifierPolicy.expectedBindings.trustPolicyDigest) {
    throw new Error("Trusted-key policy digest binding mismatch");
  }

  if (
    !verifierPolicy.expectedReplayDomain.startsWith(
      `ltx-studio:t2a-spoken-content-holdout:${verifierPolicy.expectedBindings.releaseDigest}:`,
    )
  ) {
    throw new Error("Holdout replay-domain release binding mismatch");
  }
  if (
    policy.replayDomain !== verifierPolicy.expectedReplayDomain ||
    manifest.replayDomain !== verifierPolicy.expectedReplayDomain ||
    report.replayDomain !== verifierPolicy.expectedReplayDomain
  ) {
    throw new Error("Holdout replay-domain mismatch");
  }
  if (
    policy.holdoutScorerKeyId !== verifierPolicy.expectedHoldoutScorerKeyId ||
    report.holdoutScorerKeyId !== verifierPolicy.expectedHoldoutScorerKeyId ||
    signature.keyId !== verifierPolicy.expectedHoldoutScorerKeyId
  ) {
    throw new Error("Holdout scorer key binding mismatch");
  }

  const notBeforeMs = milliseconds(policy.notBefore);
  const expiresAtMs = milliseconds(policy.expiresAt);
  if (
    expiresAtMs - notBeforeMs > verifierPolicy.maximumValiditySeconds * 1_000 ||
    nowMs < notBeforeMs ||
    nowMs >= expiresAtMs
  ) {
    throw new Error("Holdout policy is outside its accepted UTC validity window");
  }
  if (
    manifest.notBefore !== policy.notBefore ||
    manifest.expiresAt !== policy.expiresAt ||
    report.expiresAt !== policy.expiresAt ||
    milliseconds(manifest.createdAt) > milliseconds(policy.issuedAt) ||
    milliseconds(report.evaluatedAt) < notBeforeMs ||
    milliseconds(report.evaluatedAt) > nowMs
  ) {
    throw new Error("Holdout document UTC window mismatch");
  }

  const reportDigest = verifyDetachedSignature(
    report,
    signature,
    trustPolicy,
    "holdout-scorer",
    options.now,
  );
  const expectedReportDigest = canonicalSha256(report);
  if (reportDigest !== expectedReportDigest) {
    throw new Error("Holdout signature digest mismatch");
  }

  const replayKey = canonicalSha256({
    schemaVersion: "ltx-studio-t2a-spoken-content-holdout-replay-key.v1",
    replayDomain: report.replayDomain,
    replayNonce: report.replayNonce,
    policyDigest,
    caseManifestDigest,
    consumptionHeadDigest: report.bindings.consumptionHeadDigest,
  });
  if (options.consumedReplayKeys.includes(replayKey)) {
    throw new Error("Holdout report replay detected");
  }

  if (policy.minimumTrueAccepts < verifierPolicy.requiredMinimumTrueAccepts) {
    throw new Error("Preregistered true-accept floor is below verifier policy");
  }
  if (
    report.minimumTrueAccepts !== policy.minimumTrueAccepts ||
    report.maximumFalseAccepts !== policy.maximumFalseAccepts ||
    report.maximumAbstentions !== policy.maximumAbstentions
  ) {
    throw new Error("Holdout qualification criteria mismatch");
  }

  const expectedCaseIds = [...manifest.positiveCaseIds, ...manifest.negativeCaseIds].sort();
  const reportCaseIds = report.caseResults.map(({ caseId }) => caseId);
  if (!sameCanonicalValue(reportCaseIds, expectedCaseIds)) {
    throw new Error("Holdout report does not cover the exact case manifest");
  }
  const derived = deriveConfusionMatrix(report, manifest);
  assertEqual(derived, report.confusionMatrix, "Holdout confusion matrix mismatch");
  if (
    report.confidence.observedFalseAccepts !== derived.falseAccepts ||
    derived.falseAccepts !== 0 ||
    report.confidence.falseAcceptRateUpperBound95 !==
      T2A_SPOKEN_CONTENT_HOLDOUT_ZERO_FA_UPPER_BOUND_95
  ) {
    throw new Error("Holdout false-accept confidence claim is not qualified");
  }

  const failureReasons: Array<(typeof t2aSpokenContentHoldoutFailureReasons)[number]> = [];
  if (derived.abstentions > 0) failureReasons.push("abstentions-present");
  if (derived.falseAccepts > 0) failureReasons.push("false-accepts-present");
  if (derived.trueAccepts < policy.minimumTrueAccepts) {
    failureReasons.push("true-accept-floor-not-met");
  }
  if (
    failureReasons.length > 0 ||
    report.qualificationStatus !== "qualified" ||
    report.failureReasons.length !== 0
  ) {
    throw new Error("Holdout report does not satisfy every qualification invariant");
  }

  return Object.freeze({
    policyDigest,
    caseManifestDigest,
    reportDigest,
    replayKey,
    qualified: true,
  });
}
