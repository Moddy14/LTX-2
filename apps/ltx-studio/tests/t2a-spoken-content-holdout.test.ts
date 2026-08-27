import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  T2A_SPOKEN_CONTENT_HOLDOUT_CASE_MANIFEST_VERSION,
  T2A_SPOKEN_CONTENT_HOLDOUT_CONFIDENCE_LEVEL,
  T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES,
  T2A_SPOKEN_CONTENT_HOLDOUT_POLICY_VERSION,
  T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES,
  T2A_SPOKEN_CONTENT_HOLDOUT_REPORT_VERSION,
  T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES,
  T2A_SPOKEN_CONTENT_HOLDOUT_VERIFIER_POLICY_VERSION,
  T2A_SPOKEN_CONTENT_HOLDOUT_ZERO_FA_UPPER_BOUND_95,
  t2aSpokenContentHoldoutCaseManifestDigest,
  t2aSpokenContentHoldoutCaseManifestSchema,
  t2aSpokenContentHoldoutPolicyDigest,
  t2aSpokenContentHoldoutPolicySchema,
  t2aSpokenContentHoldoutReportSchema,
  verifyT2aSpokenContentHoldout,
  type T2aSpokenContentHoldoutBindings,
  type T2aSpokenContentHoldoutCaseManifest,
  type T2aSpokenContentHoldoutClaimDomain,
  type T2aSpokenContentHoldoutPolicy,
  type T2aSpokenContentHoldoutReport,
  type T2aSpokenContentHoldoutVerifierPolicy,
} from "../shared/t2aSpokenContentHoldout.js";

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function labelDigest(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function objectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(objectKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...objectKeys(nested)]);
}

function rawEd25519PublicKey(publicKey: KeyObject): string {
  const spki = publicKey.export({ type: "spki", format: "der" });
  return spki.subarray(spki.length - 32).toString("base64");
}

function detachedSignature(document: unknown, keyId: string, privateKey: KeyObject) {
  return {
    schemaVersion: "ltx-studio-detached-signature.v1" as const,
    algorithm: "ed25519" as const,
    keyId,
    payloadSha256: digest(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      privateKey,
    ).toString("base64"),
  };
}

function createFixture() {
  const scorer = generateKeyPairSync("ed25519");
  const unrelated = generateKeyPairSync("ed25519");
  const holdoutScorerKeyId = "t2a-holdout-scorer-2026";
  const trustPolicy = {
    schemaVersion: "ltx-studio-trusted-keys.v1" as const,
    policyId: "t2a-holdout-test-trust",
    keys: [
      {
        keyId: holdoutScorerKeyId,
        algorithm: "ed25519" as const,
        publicKeyBase64: rawEd25519PublicKey(scorer.publicKey),
        roles: ["holdout-scorer"] as Array<
          "holdout-scorer" | "evaluation-authorizer"
        >,
        notBefore: "2026-01-01T00:00:00Z",
        notAfter: "2027-01-01T00:00:00Z",
        revokedAt: null,
      },
      {
        keyId: "unrelated-evaluation-authorizer",
        algorithm: "ed25519" as const,
        publicKeyBase64: rawEd25519PublicKey(unrelated.publicKey),
        roles: ["evaluation-authorizer"] as Array<
          "holdout-scorer" | "evaluation-authorizer"
        >,
        notBefore: "2026-01-01T00:00:00Z",
        notAfter: "2027-01-01T00:00:00Z",
        revokedAt: null,
      },
    ],
  };
  const releaseDigest = labelDigest("release-v1");
  const bindings: T2aSpokenContentHoldoutBindings = {
    releaseDigest,
    surfaceDigest: labelDigest("surface-v1"),
    preregistrationDigest: labelDigest("preregistration-v1"),
    evaluationMatrixDigest: labelDigest("evaluation-matrix-v1"),
    combinedEvaluatorDigest: labelDigest("combined-evaluator-v1"),
    scorerDigest: labelDigest("scorer-v1"),
    adjudicatorDigest: labelDigest("adjudicator-v1"),
    ipaModelManifestDigest: labelDigest("ipa-model-manifest-v1"),
    ipaModelWeightsDigest: labelDigest("ipa-model-weights-v1"),
    ipaRunnerDigest: labelDigest("ipa-runner-v1"),
    g2pDigest: labelDigest("g2p-v1"),
    normalizationPolicyDigest: labelDigest("normalization-v1"),
    thresholdPolicyDigest: labelDigest("thresholds-v1"),
    leakageManifestDigest: labelDigest("leakage-manifest-v1"),
    consumptionHeadDigest: labelDigest("consumption-head-v1"),
    trustPolicyDigest: digest(trustPolicy),
  };
  const positiveCaseIds = Array.from(
    { length: T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES },
    (_, index) => labelDigest(`private-positive-${index}`),
  ).sort();
  const claimDomain: T2aSpokenContentHoldoutClaimDomain = {
    locale: "de-DE",
    maximumAudioDurationMilliseconds: 21_000,
    maximumSpokenWordCount: 80,
    positiveDefinition: {
      expectedClass: "positive",
      audioAuthority: "authentic-dataset-audio-digest",
      referenceAuthority: "own-authoritative-dataset-transcript-digest",
      pairing: "authoritative-audio-reference-pair",
      expectedDecision: "accept",
    },
    negativeDefinition: {
      expectedClass: "negative",
      audioMarginal: "same-authentic-audio-digest-set-as-positive",
      referenceAuthority: "foreign-authoritative-dataset-transcript-digest",
      assignment: "preregistered-deterministic-bijective-derangement",
      derangementFixedPoints: 0,
      observedAudioOrModelScoreUsedForAssignment: false,
      referenceIpaRelation: "different",
      orthographicHomophonePolicy: "excluded",
      minimumPinnedReferenceIpaEditDistance: 1,
      expectedDecision: "reject",
      difficultyMeasure: "symmetric-reference-ipa-token-error-rate.v1",
      difficultyBanding: "stable-rank-terciles-100-each.v1",
      difficultyBandsAssignment: "exactly-one-partition",
      difficultyBands: [
        { band: "easiest-reference-ipa-distance-tercile", caseCount: 100 },
        { band: "hardest-reference-ipa-distance-tercile", caseCount: 100 },
        { band: "middle-reference-ipa-distance-tercile", caseCount: 100 },
      ],
    },
    groupingAndLeakage: {
      groupIdAlgorithm: "sha256",
      groupUnit: "dataset-speaker-and-transitive-leakage-component",
      maximumCasesPerGroup: 4,
      crossClassAudioDigestSetRelation: "identical",
      crossClassGroupSetRelation: "identical",
      maximumCalibrationGroupOverlap: 0,
      maximumCrossReleaseGroupOverlap: 0,
      groupingRuleDigest: labelDigest("grouping-rules-v1"),
      leakageRuleDigest: labelDigest("leakage-rules-v1"),
    },
  };
  const negativeCaseIds = Array.from(
    { length: T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES },
    (_, index) => labelDigest(`private-negative-${index}`),
  ).sort();
  const replayDomain = `ltx-studio:t2a-spoken-content-holdout:${releaseDigest}:release-gate`;
  const manifest: T2aSpokenContentHoldoutCaseManifest = {
    schemaVersion: T2A_SPOKEN_CONTENT_HOLDOUT_CASE_MANIFEST_VERSION,
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    caseIdAlgorithm: "sha256",
    manifestId: "t2a-private-holdout-cases-v1",
    bindings: structuredClone(bindings),
    claimDomain: structuredClone(claimDomain),
    positiveCaseIds,
    negativeCaseIds,
    createdAt: "2026-08-25T23:58:00Z",
    notBefore: "2026-08-26T00:00:00Z",
    expiresAt: "2026-08-27T00:00:00Z",
    replayDomain,
  };
  const caseManifestDigest = t2aSpokenContentHoldoutCaseManifestDigest(manifest);
  const policy: T2aSpokenContentHoldoutPolicy = {
    schemaVersion: T2A_SPOKEN_CONTENT_HOLDOUT_POLICY_VERSION,
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    policyId: "t2a-spoken-content-holdout-v1",
    bindings: structuredClone(bindings),
    claimDomain: structuredClone(claimDomain),
    caseManifestDigest,
    holdoutScorerKeyId,
    expectedPositiveCases: T2A_SPOKEN_CONTENT_HOLDOUT_POSITIVE_CASES,
    expectedNegativeCases: T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES,
    maximumFalseAccepts: 0,
    maximumAbstentions: 0,
    minimumTrueAccepts: 285,
    confidenceMethod: "clopper-pearson-one-sided-upper.v1",
    confidenceLevel: T2A_SPOKEN_CONTENT_HOLDOUT_CONFIDENCE_LEVEL,
    issuedAt: "2026-08-25T23:59:00Z",
    notBefore: "2026-08-26T00:00:00Z",
    expiresAt: "2026-08-27T00:00:00Z",
    replayDomain,
  };
  const policyDigest = t2aSpokenContentHoldoutPolicyDigest(policy);
  const caseResults: T2aSpokenContentHoldoutReport["caseResults"] = [
    ...positiveCaseIds.map((caseId, index) => ({
      caseId,
      expectedClass: "positive" as const,
      decision: index < 285 ? "accept" as const : "reject" as const,
    })),
    ...negativeCaseIds.map((caseId) => ({
      caseId,
      expectedClass: "negative" as const,
      decision: "reject" as const,
    })),
  ].sort(({ caseId: left }, { caseId: right }) => left.localeCompare(right));
  const report: T2aSpokenContentHoldoutReport = {
    schemaVersion: T2A_SPOKEN_CONTENT_HOLDOUT_REPORT_VERSION,
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    reportId: "t2a-spoken-content-holdout-report-test",
    bindings: structuredClone(bindings),
    claimDomain: structuredClone(claimDomain),
    policyDigest,
    caseManifestDigest,
    holdoutScorerKeyId,
    replayDomain,
    replayNonce: labelDigest("single-use-report-nonce"),
    evaluatedAt: "2026-08-26T01:00:00Z",
    expiresAt: "2026-08-27T00:00:00Z",
    minimumTrueAccepts: 285,
    maximumFalseAccepts: 0,
    maximumAbstentions: 0,
    confusionMatrix: {
      trueAccepts: 285,
      falseRejects: 15,
      positiveAbstentions: 0,
      trueRejects: 300,
      falseAccepts: 0,
      negativeAbstentions: 0,
      totalCases: T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES,
      decidedCases: T2A_SPOKEN_CONTENT_HOLDOUT_TOTAL_CASES,
      abstentions: 0,
    },
    confidence: {
      method: "clopper-pearson-one-sided-upper.v1",
      confidenceLevel: T2A_SPOKEN_CONTENT_HOLDOUT_CONFIDENCE_LEVEL,
      negativeTrials: T2A_SPOKEN_CONTENT_HOLDOUT_NEGATIVE_CASES,
      observedFalseAccepts: 0,
      falseAcceptRateUpperBound95:
        T2A_SPOKEN_CONTENT_HOLDOUT_ZERO_FA_UPPER_BOUND_95,
    },
    caseResults,
    qualificationStatus: "qualified",
    failureReasons: [],
  };
  const verifierPolicy: T2aSpokenContentHoldoutVerifierPolicy = {
    schemaVersion: T2A_SPOKEN_CONTENT_HOLDOUT_VERIFIER_POLICY_VERSION,
    expectedPolicyDigest: policyDigest,
    expectedCaseManifestDigest: caseManifestDigest,
    expectedBindings: structuredClone(bindings),
    expectedClaimDomain: structuredClone(claimDomain),
    expectedHoldoutScorerKeyId: holdoutScorerKeyId,
    expectedReplayDomain: replayDomain,
    requiredMinimumTrueAccepts: 285,
    maximumValiditySeconds: 24 * 60 * 60,
  };
  return {
    policy,
    manifest,
    report,
    reportSignature: detachedSignature(report, holdoutScorerKeyId, scorer.privateKey),
    trustPolicy,
    verifierPolicy,
    now: new Date("2026-08-26T02:00:00Z"),
    scorer,
    unrelated,
  };
}

type Fixture = ReturnType<typeof createFixture>;

function resign(fixture: Fixture, privateKey = fixture.scorer.privateKey, keyId = fixture.policy.holdoutScorerKeyId) {
  fixture.reportSignature = detachedSignature(fixture.report, keyId, privateKey);
}

function verify(fixture: Fixture, consumedReplayKeys: string[] = []) {
  return verifyT2aSpokenContentHoldout({
    policyDocument: fixture.policy,
    caseManifestDocument: fixture.manifest,
    reportDocument: fixture.report,
    reportSignature: fixture.reportSignature,
    trustPolicy: fixture.trustPolicy,
    verifierPolicy: fixture.verifierPolicy,
    now: fixture.now,
    consumedReplayKeys,
  });
}

describe("T2A spoken-content holdout v1", () => {
  it("verifies the complete in-memory fixture and reports the honest exact 0/300 bound", () => {
    const fixture = createFixture();
    const verified = verify(fixture);

    expect(verified.qualified).toBe(true);
    expect(verified.policyDigest).toBe(t2aSpokenContentHoldoutPolicyDigest(fixture.policy));
    expect(verified.caseManifestDigest).toBe(
      t2aSpokenContentHoldoutCaseManifestDigest(fixture.manifest),
    );
    expect(T2A_SPOKEN_CONTENT_HOLDOUT_ZERO_FA_UPPER_BOUND_95)
      .toBeCloseTo(0.00993608, 8);
    expect(fixture.report.confidence.falseAcceptRateUpperBound95)
      .toBe(T2A_SPOKEN_CONTENT_HOLDOUT_ZERO_FA_UPPER_BOUND_95);
    expect(objectKeys(fixture.manifest)).not.toEqual(
      expect.arrayContaining(["path", "transcript", "payload"]),
    );
  });

  it("rejects 299 or 301 cases instead of silently changing holdout power", () => {
    const tooFew = createFixture();
    tooFew.manifest.positiveCaseIds.pop();
    expect(() => verify(tooFew)).toThrow(/case manifest/iu);

    const tooMany = createFixture();
    tooMany.manifest.negativeCaseIds.push(labelDigest("private-negative-301"));
    tooMany.manifest.negativeCaseIds.sort();
    expect(() => verify(tooMany)).toThrow(/case manifest/iu);
  });

  it("rejects duplicate and cross-class overlapping digest case IDs", () => {
    const duplicate = createFixture();
    duplicate.manifest.positiveCaseIds[1] = duplicate.manifest.positiveCaseIds[0]!;
    duplicate.manifest.positiveCaseIds.sort();
    expect(() => verify(duplicate)).toThrow(/case manifest/iu);

    const overlap = createFixture();
    overlap.manifest.negativeCaseIds[0] = overlap.manifest.positiveCaseIds[0]!;
    overlap.manifest.negativeCaseIds.sort();
    expect(() => verify(overlap)).toThrow(/case manifest/iu);
  });

  it("rejects report tampering even when the changed document remains structurally valid", () => {
    const fixture = createFixture();
    fixture.report.reportId = "tampered-holdout-report";
    expect(() => verify(fixture)).toThrow(/signature/iu);
  });

  it("rejects invalid signatures, the wrong trusted key and a mixed replay domain", () => {
    const invalidSignature = createFixture();
    const signatureBytes = Buffer.from(
      invalidSignature.reportSignature.signatureBase64,
      "base64",
    );
    signatureBytes[0] = signatureBytes[0]! ^ 1;
    invalidSignature.reportSignature.signatureBase64 = signatureBytes.toString("base64");
    expect(() => verify(invalidSignature)).toThrow(/signature/iu);

    const wrongKey = createFixture();
    resign(
      wrongKey,
      wrongKey.unrelated.privateKey,
      "unrelated-evaluation-authorizer",
    );
    expect(() => verify(wrongKey)).toThrow(/scorer key/iu);

    const wrongDomain = createFixture();
    wrongDomain.report.replayDomain =
      `ltx-studio:t2a-spoken-content-holdout:${labelDigest("release-v2")}:release-gate`;
    resign(wrongDomain);
    expect(() => verify(wrongDomain)).toThrow(/replay-domain/iu);

    const releaseMismatchedDomain = createFixture();
    const substitutedDomain =
      `ltx-studio:t2a-spoken-content-holdout:${labelDigest("release-v2")}:release-gate`;
    releaseMismatchedDomain.manifest.replayDomain = substitutedDomain;
    const substitutedManifestDigest = t2aSpokenContentHoldoutCaseManifestDigest(
      releaseMismatchedDomain.manifest,
    );
    releaseMismatchedDomain.policy.replayDomain = substitutedDomain;
    releaseMismatchedDomain.policy.caseManifestDigest = substitutedManifestDigest;
    const substitutedPolicyDigest = t2aSpokenContentHoldoutPolicyDigest(
      releaseMismatchedDomain.policy,
    );
    releaseMismatchedDomain.report.replayDomain = substitutedDomain;
    releaseMismatchedDomain.report.caseManifestDigest = substitutedManifestDigest;
    releaseMismatchedDomain.report.policyDigest = substitutedPolicyDigest;
    releaseMismatchedDomain.verifierPolicy.expectedReplayDomain = substitutedDomain;
    releaseMismatchedDomain.verifierPolicy.expectedCaseManifestDigest =
      substitutedManifestDigest;
    releaseMismatchedDomain.verifierPolicy.expectedPolicyDigest = substitutedPolicyDigest;
    resign(releaseMismatchedDomain);
    expect(() => verify(releaseMismatchedDomain)).toThrow(/release binding/iu);
  });

  it("requires a dedicated holdout-scorer trust role", () => {
    const fixture = createFixture();
    fixture.trustPolicy.keys[0]!.roles.push("evaluation-authorizer");
    expect(() => verify(fixture)).toThrow(/trusted-key policy/iu);
  });

  it("rejects evaluator digest drift and coordinated cross-release substitution", () => {
    const drift = createFixture();
    drift.report.bindings.combinedEvaluatorDigest = labelDigest("combined-evaluator-v2");
    resign(drift);
    expect(() => verify(drift)).toThrow(/report binding/iu);

    const crossRelease = createFixture();
    const substitutedRelease = labelDigest("release-v2");
    crossRelease.policy.bindings.releaseDigest = substitutedRelease;
    crossRelease.manifest.bindings.releaseDigest = substitutedRelease;
    crossRelease.report.bindings.releaseDigest = substitutedRelease;
    crossRelease.report.policyDigest = t2aSpokenContentHoldoutPolicyDigest(crossRelease.policy);
    resign(crossRelease);
    expect(() => verify(crossRelease)).toThrow(/policy digest/iu);
  });

  it("rejects claim-domain and adversarial-stratum drift", () => {
    const durationDrift = createFixture();
    durationDrift.report.claimDomain.maximumAudioDurationMilliseconds = 20_000;
    resign(durationDrift);
    expect(() => verify(durationDrift)).toThrow(/report claim-domain/iu);

    const bandDrift = createFixture();
    bandDrift.report.claimDomain.negativeDefinition.difficultyBands[0]!.caseCount = 99;
    bandDrift.report.claimDomain.negativeDefinition.difficultyBands[1]!.caseCount = 101;
    resign(bandDrift);
    expect(() => verify(bandDrift)).toThrow(/report claim-domain/iu);

    const fixture = createFixture();
    expect(t2aSpokenContentHoldoutPolicySchema.safeParse({
      ...fixture.policy,
      claimDomain: {
        ...fixture.policy.claimDomain,
        negativeDefinition: {
          ...fixture.policy.claimDomain.negativeDefinition,
          referenceIpaRelation: "equal",
          orthographicHomophonePolicy: "included",
        },
      },
    }).success).toBe(false);

    expect(t2aSpokenContentHoldoutPolicySchema.safeParse({
      ...fixture.policy,
      claimDomain: {
        ...fixture.policy.claimDomain,
        negativeDefinition: {
          ...fixture.policy.claimDomain.negativeDefinition,
          difficultyBandsAssignment: "overlapping",
        },
      },
    }).success).toBe(false);

    expect(t2aSpokenContentHoldoutPolicySchema.safeParse({
      ...fixture.policy,
      claimDomain: {
        ...fixture.policy.claimDomain,
        groupingAndLeakage: {
          ...fixture.policy.claimDomain.groupingAndLeakage,
          crossClassAudioDigestSetRelation: "disjoint",
        },
      },
    }).success).toBe(false);

    expect(t2aSpokenContentHoldoutPolicySchema.safeParse({
      ...fixture.policy,
      claimDomain: {
        ...fixture.policy.claimDomain,
        maximumAudioDurationMilliseconds: 21_001,
      },
    }).success).toBe(false);
    expect(t2aSpokenContentHoldoutPolicySchema.safeParse({
      ...fixture.policy,
      claimDomain: {
        ...fixture.policy.claimDomain,
        maximumSpokenWordCount: 201,
      },
    }).success).toBe(false);
  });

  it("recomputes the confusion matrix from all signed per-case decisions", () => {
    const fixture = createFixture();
    fixture.report.confusionMatrix.trueAccepts -= 1;
    fixture.report.confusionMatrix.falseRejects += 1;
    resign(fixture);
    expect(() => verify(fixture)).toThrow(/confusion matrix/iu);
  });

  it("rejects one false accept even when the signed report admits non-qualification", () => {
    const fixture = createFixture();
    const negative = fixture.report.caseResults.find(
      ({ expectedClass }) => expectedClass === "negative",
    );
    expect(negative).toBeDefined();
    negative!.decision = "accept";
    fixture.report.confusionMatrix.trueRejects = 299;
    fixture.report.confusionMatrix.falseAccepts = 1;
    fixture.report.confidence.observedFalseAccepts = 1;
    fixture.report.confidence.falseAcceptRateUpperBound95 = null;
    fixture.report.qualificationStatus = "not-qualified";
    fixture.report.failureReasons = ["false-accepts-present"];
    resign(fixture);

    expect(() => verify(fixture)).toThrow(/false-accept/iu);
  });

  it("defeats an Always-Reject scorer with the verifier floor preregistered in policy", () => {
    const fixture = createFixture();
    for (const result of fixture.report.caseResults) {
      if (result.expectedClass === "positive") result.decision = "reject";
    }
    fixture.report.confusionMatrix.trueAccepts = 0;
    fixture.report.confusionMatrix.falseRejects = 300;
    fixture.report.qualificationStatus = "not-qualified";
    fixture.report.failureReasons = ["true-accept-floor-not-met"];
    resign(fixture);

    expect(() => verify(fixture)).toThrow(/qualification invariant/iu);

    const underPreregistered = createFixture();
    underPreregistered.policy.minimumTrueAccepts = 284;
    underPreregistered.report.minimumTrueAccepts = 284;
    underPreregistered.report.policyDigest =
      t2aSpokenContentHoldoutPolicyDigest(underPreregistered.policy);
    underPreregistered.verifierPolicy.expectedPolicyDigest =
      underPreregistered.report.policyDigest;
    resign(underPreregistered);
    expect(() => verify(underPreregistered)).toThrow(/below verifier policy/iu);
  });

  it("does not let abstention replace an inconvenient preregistered decision", () => {
    const fixture = createFixture();
    const rejectedPositive = fixture.report.caseResults.find(
      ({ expectedClass, decision }) => expectedClass === "positive" && decision === "reject",
    );
    expect(rejectedPositive).toBeDefined();
    rejectedPositive!.decision = "abstain";
    fixture.report.confusionMatrix.falseRejects = 14;
    fixture.report.confusionMatrix.positiveAbstentions = 1;
    fixture.report.confusionMatrix.decidedCases = 599;
    fixture.report.confusionMatrix.abstentions = 1;
    fixture.report.qualificationStatus = "not-qualified";
    fixture.report.failureReasons = ["abstentions-present"];
    resign(fixture);

    expect(() => verify(fixture)).toThrow(/qualification invariant/iu);
  });

  it("rejects inconsistent counts, class labels and a dishonest numeric confidence value", () => {
    const badCount = createFixture();
    badCount.report.confusionMatrix.decidedCases = 599;
    resign(badCount);
    expect(() => verify(badCount)).toThrow(/holdout report/iu);

    const badClass = createFixture();
    badClass.report.caseResults[0]!.expectedClass =
      badClass.report.caseResults[0]!.expectedClass === "positive" ? "negative" : "positive";
    resign(badClass);
    expect(() => verify(badClass)).toThrow(/class binding/iu);

    const dishonestBound = createFixture();
    dishonestBound.report.confidence.falseAcceptRateUpperBound95 =
      T2A_SPOKEN_CONTENT_HOLDOUT_ZERO_FA_UPPER_BOUND_95 + 0.000001;
    resign(dishonestBound);
    expect(() => verify(dishonestBound)).toThrow(/holdout report/iu);
  });

  it("rejects every unregistered key, including path, transcript and payload fields", () => {
    const fixture = createFixture();
    expect(t2aSpokenContentHoldoutPolicySchema.safeParse({
      ...fixture.policy,
      releasePath: "/private/release",
    }).success).toBe(false);
    expect(t2aSpokenContentHoldoutCaseManifestSchema.safeParse({
      ...fixture.manifest,
      transcript: "secret words",
    }).success).toBe(false);
    expect(t2aSpokenContentHoldoutCaseManifestSchema.safeParse({
      ...fixture.manifest,
      positiveCaseIds: fixture.manifest.positiveCaseIds.map((caseId, index) =>
        index === 0 ? { caseId, payload: "private" } : caseId),
    }).success).toBe(false);
    expect(t2aSpokenContentHoldoutReportSchema.safeParse({
      ...fixture.report,
      outputPath: "/private/report.json",
    }).success).toBe(false);
    expect(t2aSpokenContentHoldoutReportSchema.safeParse({
      ...fixture.report,
      confidence: { ...fixture.report.confidence, debugPayload: "private" },
    }).success).toBe(false);
  });

  it("rejects expiry and a replay key after one valid consumption", () => {
    const expired = createFixture();
    expired.now = new Date(expired.policy.expiresAt);
    expect(() => verify(expired)).toThrow(/validity window/iu);

    const replayed = createFixture();
    const first = verify(replayed);
    expect(() => verify(replayed, [first.replayKey])).toThrow(/replay detected/iu);
  });

  it("rejects a future report and a validity window broader than verifier policy", () => {
    const future = createFixture();
    future.report.evaluatedAt = "2026-08-26T03:00:00Z";
    resign(future);
    expect(() => verify(future)).toThrow(/UTC window/iu);

    const tooBroad = createFixture();
    tooBroad.verifierPolicy.maximumValiditySeconds = 23 * 60 * 60;
    expect(() => verify(tooBroad)).toThrow(/validity window/iu);
  });
});
