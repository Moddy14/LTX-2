import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  T2A_FLEURS_CALIBRATION_AUTHORIZATION_VERSION,
  T2A_FLEURS_CALIBRATION_CONSUMPTION_VERSION,
  T2A_FLEURS_CALIBRATION_PAIRING_POLICY_VERSION,
  T2A_FLEURS_CALIBRATION_PAIRING_SEED,
  T2A_FLEURS_CALIBRATION_SCORE_REPORT_VERSION,
  T2A_FLEURS_CALIBRATION_SCORE_SCALE,
  T2A_FLEURS_CALIBRATION_SELECTION_POLICY_VERSION,
  T2A_FLEURS_CALIBRATION_SELECTION_SEED,
  T2A_FLEURS_CALIBRATION_THRESHOLD_SELECTION_VERSION,
  T2A_FLEURS_CALIBRATION_ZERO_FA_UPPER_BOUND_95_PPM,
  T2A_FLEURS_DATASET_FEATURES,
  T2A_FLEURS_DATASET_REVISION,
  T2A_FLEURS_VALIDATION_ROWS,
  assertT2aFleursCalibrationMayContinue,
  assertT2aFleursCalibrationMayStart,
  calibrateT2aFleursThreshold,
  createT2aFleursCalibrationCaseManifest,
  createT2aFleursCalibrationInventory,
  createT2aFleursCalibrationLeakageManifest,
  createT2aFleursCalibrationRow,
  selectT2aFleursCalibrationRows,
  t2aFleursCalibrationAudioAuthorityDigest,
  t2aFleursCalibrationAuthorityDigest,
  t2aFleursCalibrationAuthoritySchema,
  t2aFleursCalibrationAuthorizationDigest,
  t2aFleursCalibrationCaseManifestDigest,
  t2aFleursCalibrationConsumptionRecordDigest,
  t2aFleursCalibrationIpaAuthorityDigest,
  t2aFleursCalibrationInventoryDigest,
  t2aFleursCalibrationLeakageManifestDigest,
  t2aFleursCalibrationNegativeStrata,
  t2aFleursCalibrationRowSchema,
  t2aFleursCalibrationSelectionManifestDigest,
  t2aFleursCalibrationSelectionPolicySchema,
  validateT2aFleursCalibrationConsumption,
  verifyT2aFleursCalibrationAuthorization,
  verifyT2aFleursCalibrationMaterialization,
  type T2aFleursCalibrationAuthority,
  type T2aFleursCalibrationAuthorization,
  type T2aFleursCalibrationConsumptionRecord,
  type T2aFleursCalibrationPairingPolicy,
  type T2aFleursCalibrationSelectionPolicy,
  type T2aFleursCalibrationThresholdSelectionPolicy,
} from "../shared/t2aFleursCalibration.js";

function digest(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
    "utf8",
  ).digest("hex");
}

type FixtureOptions = {
  speakerAuthority?: "verified" | "unavailable";
  sourceSentenceGroups?: number;
  externalEvidence?: "verified" | "unavailable";
  constantIpaTokens?: boolean;
  transitiveChain?: boolean;
  globalLeakageToken?: boolean;
  durationMilliseconds?: number;
  createCases?: boolean;
};

function authority(options: FixtureOptions): T2aFleursCalibrationAuthority {
  const speakerVerified = (options.speakerAuthority ?? "verified") === "verified";
  const externalVerified = (options.externalEvidence ?? "verified") === "verified";
  return t2aFleursCalibrationAuthoritySchema.parse({
    schemaVersion: "ltx-studio-t2a-fleurs-calibration-authority.v1",
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    repository: "google/fleurs",
    immutableRevision: T2A_FLEURS_DATASET_REVISION,
    config: "de_de",
    split: "validation",
    expectedInventoryRows: T2A_FLEURS_VALIDATION_ROWS,
    declaredDatasetFeatures: [...T2A_FLEURS_DATASET_FEATURES],
    upstreamSpeakerField: "absent",
    datasetRootDigest: digest("dataset-root"),
    sourceFileInventoryDigest: digest("source-file-inventory"),
    downloadEvidence: {
      sourceUrl: `https://huggingface.co/datasets/google/fleurs/commit/${T2A_FLEURS_DATASET_REVISION}`,
      immutableRevision: T2A_FLEURS_DATASET_REVISION,
      receiptDigest: digest("download-receipt"),
      resolvedArtifactInventoryDigest: digest("resolved-artifact-inventory"),
      fetchedAt: "2026-08-26T06:00:00Z",
      offlineMaterializationRequired: true,
      networkDisabledDuringCalibration: true,
    },
    licenseEvidence: {
      spdxIdentifier: "CC-BY-4.0",
      licenseTextDigest: digest("cc-by-4-license-text"),
      datasetCardDigest: digest("immutable-dataset-card"),
      legalApprovalDigest: digest("legal-approval"),
      approvalStatus: "approved-for-local-calibration-and-derived-metrics",
    },
    speakerAuthority: {
      status: speakerVerified ? "verified-signed-mapping" : "unavailable-in-upstream-features",
      manifestDigest: speakerVerified ? digest("signed-speaker-map") : null,
      filenameInference: "forbidden",
    },
    testSplitAccess: {
      status: externalVerified ? "verified-sealed" : "not-provisioned",
      policy: "forbidden-unmounted-zero-bytes",
      declaredRowsFromDatasetCard: 862,
      mounted: false,
      opened: false,
      bytesRead: 0,
      openFileDescriptors: 0,
      attestationDigest: externalVerified ? digest("test-access-attestation") : null,
      sealedGroupCommitmentRoot: externalVerified ? digest("test-group-root") : null,
    },
    bindings: {
      combinedEvaluatorDigest: digest("combined-evaluator"),
      scorerDigest: digest("scorer"),
      adjudicatorDigest: digest("adjudicator"),
      scorerRuntimeDigest: digest("scorer-runtime"),
      adjudicatorRuntimeDigest: digest("adjudicator-runtime"),
      normalizationPolicyDigest: digest("normalization-policy"),
      g2pDigest: digest("g2p"),
      groupingRuleDigest: digest("grouping-rule"),
      leakageRuleDigest: digest("leakage-rule"),
      trustPolicyDigest: digest("trust-policy"),
      consumptionWriterDigest: digest("consumption-writer"),
    },
    scorerKeyId: "fleurs-scorer-key",
    adjudicatorKeyId: "fleurs-adjudicator-key",
    authorizationKeyId: "fleurs-authorization-key",
  });
}

function materialize(options: FixtureOptions = {}) {
  const approvedAuthority = authority(options);
  const speakerVerified = (options.speakerAuthority ?? "verified") === "verified";
  const externalVerified = (options.externalEvidence ?? "verified") === "verified";
  const sourceGroups = options.sourceSentenceGroups ?? T2A_FLEURS_VALIDATION_ROWS;
  const rows = Array.from({ length: T2A_FLEURS_VALIDATION_ROWS }, (_, index) => {
    const sourceGroup = index % sourceGroups;
    const normalizedTranscriptDigest = digest(`normalized-${sourceGroup}`);
    const ipaTokens = options.constantIpaTokens
      ? ["k", "a"]
      : ["k", `a${sourceGroup}`, `z${sourceGroup % 17}`];
    const ipaDigest = t2aFleursCalibrationIpaAuthorityDigest({
      normalizedTranscriptDigest,
      normalizationPolicyDigest: approvedAuthority.bindings.normalizationPolicyDigest,
      g2pDigest: approvedAuthority.bindings.g2pDigest,
      ipaTokens,
    });
    const durationMilliseconds = options.durationMilliseconds ?? 2_000;
    const audioBody = {
      containerSha256: digest(`container-${index}`),
      pcmPayloadSha256: digest(`pcm-${index}`),
      sampleRateHz: 16_000,
      channels: 1,
      bitsPerSample: 16 as const,
      sampleFrames: durationMilliseconds * 16,
      durationMilliseconds,
    };
    const leakageTokens = [
      { kind: "ipa" as const, digest: ipaDigest },
      { kind: "normalized-transcript" as const, digest: normalizedTranscriptDigest },
      { kind: "pcm-audio" as const, digest: audioBody.pcmPayloadSha256 },
      { kind: "source-sentence" as const, digest: normalizedTranscriptDigest },
      ...(speakerVerified
        ? [{ kind: "speaker" as const, digest: digest(`speaker-${index}`) }]
        : []),
      ...(options.transitiveChain && index <= 1
        ? [{ kind: "recording-session" as const, digest: digest("chain-a") }]
        : []),
      ...(options.transitiveChain && index >= 1 && index <= 2
        ? [{ kind: "recording-session" as const, digest: digest("chain-b") }]
        : []),
      ...(options.globalLeakageToken
        ? [{ kind: "recording-session" as const, digest: digest("global-session") }]
        : []),
    ].sort((left, right) =>
      `${left.kind}:${left.digest}`.localeCompare(`${right.kind}:${right.digest}`));
    const upstreamRowId = `row-${index.toString().padStart(3, "0")}`;
    return createT2aFleursCalibrationRow({
      upstreamRowId,
      upstreamRowIdDigest: digest(upstreamRowId),
      upstreamRowIndex: index,
      datasetRootDigest: approvedAuthority.datasetRootDigest,
      speakerDigest: speakerVerified ? digest(`speaker-${index}`) : null,
      speakerAuthorityRecordDigest: speakerVerified ? digest(`speaker-record-${index}`) : null,
      sourceSentence: {
        sourceSentenceDigest: normalizedTranscriptDigest,
        authority: "conservative-normalized-transcript-equivalence",
        authorityRecordDigest: null,
      },
      audio: {
        ...audioBody,
        audioAuthorityDigest: t2aFleursCalibrationAudioAuthorityDigest(audioBody),
      },
      transcript: {
        rawTranscriptDigest: digest(`raw-${sourceGroup}`),
        normalizedTranscriptDigest,
        normalizedWordCount: 3 + (sourceGroup % 20),
        normalizationPolicyDigest: approvedAuthority.bindings.normalizationPolicyDigest,
        g2pDigest: approvedAuthority.bindings.g2pDigest,
        ipaDigest,
        ipaTokens,
      },
      leakageTokens,
    });
  });
  const inventory = createT2aFleursCalibrationInventory({
    authority: approvedAuthority,
    rows,
  });
  const leakageManifest = createT2aFleursCalibrationLeakageManifest({
    inventory,
    groupingRuleDigest: approvedAuthority.bindings.groupingRuleDigest,
    leakageRuleDigest: approvedAuthority.bindings.leakageRuleDigest,
    sealedExternalEvidence: {
      status: externalVerified ? "verified-zero-intersection" : "not-provisioned",
      testGroupCommitmentRoot: externalVerified ? digest("test-group-root") : null,
      priorCalibrationGroupCommitmentRoot: externalVerified ? digest("prior-group-root") : null,
      crossReleaseGroupCommitmentRoot: externalVerified ? digest("cross-release-root") : null,
      keyedTagEnvelopeDigest: externalVerified ? digest("keyed-tag-envelope") : null,
      custodianAttestationDigest: externalVerified ? digest("custodian-attestation") : null,
      testIntersectionCount: externalVerified ? 0 : null,
      priorCalibrationIntersectionCount: externalVerified ? 0 : null,
      crossReleaseIntersectionCount: externalVerified ? 0 : null,
      testRowsDisclosed: 0,
      testBytesReadByCalibration: 0,
    },
  });
  const selectionPolicy: T2aFleursCalibrationSelectionPolicy = {
    schemaVersion: T2A_FLEURS_CALIBRATION_SELECTION_POLICY_VERSION,
    inventoryDigest: t2aFleursCalibrationInventoryDigest(inventory),
    leakageManifestDigest: t2aFleursCalibrationLeakageManifestDigest(leakageManifest),
    selectionSeed: T2A_FLEURS_CALIBRATION_SELECTION_SEED,
    expectedSelectedRows: 300,
    expectedReserveRows: 63,
    maximumCasesPerTransitiveGroup: 40,
    algorithm: "sha256-rank-greedy-transitive-group-cap.v1",
    modelScoreSelection: "forbidden",
    audioScoreSelection: "forbidden",
    replacementAfterScoring: "forbidden",
  };
  const selectionManifest = selectT2aFleursCalibrationRows({
    inventory,
    leakageManifest,
    policy: selectionPolicy,
  });
  const pairingPolicy: T2aFleursCalibrationPairingPolicy = {
    schemaVersion: T2A_FLEURS_CALIBRATION_PAIRING_POLICY_VERSION,
    selectionManifestDigest: t2aFleursCalibrationSelectionManifestDigest(selectionManifest),
    pairingSeed: T2A_FLEURS_CALIBRATION_PAIRING_SEED,
    algorithm: "first-valid-hash-ranked-cyclic-derangement.v1",
    foreignReferenceAuthority: "authentic-selected-dataset-transcript",
    fixedPoints: 0,
    bijective: true,
    equalNormalizedTranscript: "forbidden",
    equalIpa: "forbidden",
    syntheticTranscriptMutation: "forbidden",
    modelScorePairing: "forbidden",
    audioScorePairing: "forbidden",
    difficultyAssignment: "normalized-ipa-distance-stable-tertiles-100.v1",
    stratumAssignment: "source-word-count-halves-within-tertile-50.v1",
  };
  const caseManifest = options.createCases === false
    ? null
    : createT2aFleursCalibrationCaseManifest({
      inventory,
      selectionManifest,
      pairingPolicy,
    });
  return {
    authority: approvedAuthority,
    inventory,
    leakageManifest,
    selectionPolicy,
    selectionManifest,
    pairingPolicy,
    caseManifest,
  };
}

function thresholdSelection(fixture: ReturnType<typeof materialize>) {
  if (!fixture.caseManifest) throw new Error("fixture needs cases");
  return {
    schemaVersion: T2A_FLEURS_CALIBRATION_THRESHOLD_SELECTION_VERSION,
    caseManifestDigest: t2aFleursCalibrationCaseManifestDigest(fixture.caseManifest),
    combinedEvaluatorDigest: fixture.authority.bindings.combinedEvaluatorDigest,
    scorerDigest: fixture.authority.bindings.scorerDigest,
    adjudicatorDigest: fixture.authority.bindings.adjudicatorDigest,
    scoreScale: T2A_FLEURS_CALIBRATION_SCORE_SCALE,
    decisionRule: "accept-iff-score-ppm-greater-than-or-equal-threshold",
    selector: "smallest-zero-false-accept-threshold.v1",
    maximumFalseAccepts: 0,
    maximumAbstentions: 0,
    minimumTrueAccepts: 285,
    modelOrAudioScoreCaseSelection: "forbidden",
    scoreEvidenceAuthority: "unsigned-contract-draft-only",
    releaseQualification: "forbidden-calibration-only",
  } satisfies T2aFleursCalibrationThresholdSelectionPolicy;
}

function scoreReport(fixture: ReturnType<typeof materialize>) {
  if (!fixture.caseManifest) throw new Error("fixture needs cases");
  const manifest = fixture.caseManifest;
  return {
    schemaVersion: T2A_FLEURS_CALIBRATION_SCORE_REPORT_VERSION,
    caseManifestDigest: t2aFleursCalibrationCaseManifestDigest(manifest),
    combinedEvaluatorDigest: fixture.authority.bindings.combinedEvaluatorDigest,
    scorerDigest: fixture.authority.bindings.scorerDigest,
    adjudicatorDigest: fixture.authority.bindings.adjudicatorDigest,
    consumptionHeadDigest: digest("consumption-head"),
    authenticity: "unsigned-untrusted-contract-draft" as const,
    scores: [
      ...manifest.positiveCaseIds.map((caseId, index) => ({
        caseId,
        scorePpm: index < 295 ? 900_000 : 50_000,
      })),
      ...manifest.negativeCaseIds.map((caseId, index) => ({
        caseId,
        scorePpm: 100_000 + index,
      })),
    ].sort((left, right) => left.caseId.localeCompare(right.caseId)),
  };
}

function authorizationFor(
  fixture: ReturnType<typeof materialize>,
  policy: T2aFleursCalibrationThresholdSelectionPolicy,
): T2aFleursCalibrationAuthorization {
  if (!fixture.caseManifest) throw new Error("fixture needs cases");
  return {
    schemaVersion: T2A_FLEURS_CALIBRATION_AUTHORIZATION_VERSION,
    authorizationId: "fleurs-calibration-run-001",
    authorityDigest: t2aFleursCalibrationAuthorityDigest(fixture.authority),
    inventoryDigest: t2aFleursCalibrationInventoryDigest(fixture.inventory),
    leakageManifestDigest: t2aFleursCalibrationLeakageManifestDigest(fixture.leakageManifest),
    selectionManifestDigest: t2aFleursCalibrationSelectionManifestDigest(
      fixture.selectionManifest,
    ),
    caseManifestDigest: t2aFleursCalibrationCaseManifestDigest(fixture.caseManifest),
    thresholdSelectionPolicyDigest: digest(policy),
    combinedEvaluatorDigest: fixture.authority.bindings.combinedEvaluatorDigest,
    scorerDigest: fixture.authority.bindings.scorerDigest,
    adjudicatorDigest: fixture.authority.bindings.adjudicatorDigest,
    consumptionWriterDigest: fixture.authority.bindings.consumptionWriterDigest,
    authorizationKeyId: fixture.authority.authorizationKeyId,
    authenticity: "unsigned-structural-contract-draft",
    testAccessEvidenceStatus: fixture.authority.testSplitAccess.status,
    testAccessAttestationDigest: fixture.authority.testSplitAccess.attestationDigest,
    issuedAt: "2026-08-26T08:00:00Z",
    notBefore: "2026-08-26T08:01:00Z",
    startBy: "2026-08-26T08:02:00Z",
    completeBy: "2026-08-26T08:10:00Z",
    nonce: "0123456789abcdef0123456789abcdef",
    maximumPrivateInputBytes: 10_000_000,
    exactlyOnce: true,
    testSplitCapability: "none",
  };
}

describe("FLEURS de_de validation calibration-v1 contract", () => {
  it("freezes the authority and deterministically materializes 300/63, a bijection, tertiles, and six honest strata", () => {
    const fixture = materialize();
    expect(fixture.authority.immutableRevision).toBe(T2A_FLEURS_DATASET_REVISION);
    expect(fixture.authority.declaredDatasetFeatures).toEqual(T2A_FLEURS_DATASET_FEATURES);
    expect(fixture.selectionManifest.selected).toHaveLength(300);
    expect(fixture.selectionManifest.reserve).toHaveLength(63);
    expect(fixture.selectionManifest.independenceAssessment.status).toBe(
      "eligible-for-descriptive-independent-case-analysis",
    );
    expect(fixture.caseManifest).not.toBeNull();
    const manifest = fixture.caseManifest!;
    expect(new Set(manifest.pairs.map((pair) => pair.referenceRowAuthorityDigest)).size).toBe(300);
    expect(manifest.pairs.every((pair) =>
      pair.sourceRowAuthorityDigest !== pair.referenceRowAuthorityDigest)).toBe(true);
    for (const band of ["hard", "medium", "easy"] as const) {
      expect(manifest.pairs.filter((pair) => pair.difficultyBand === band)).toHaveLength(100);
    }
    for (const stratum of t2aFleursCalibrationNegativeStrata) {
      expect(manifest.pairs.filter((pair) => pair.stratum === stratum)).toHaveLength(50);
    }
    expect(manifest.releaseQualification).toBe("calibration-only-not-holdout-qualified");
    expect(selectT2aFleursCalibrationRows({
      inventory: fixture.inventory,
      leakageManifest: fixture.leakageManifest,
      policy: fixture.selectionPolicy,
    })).toEqual(fixture.selectionManifest);
    expect(() => verifyT2aFleursCalibrationMaterialization({
      ...fixture,
      caseManifest: manifest,
    })).not.toThrow();
  });

  it("marks official-like repeated sentences, absent speakers, and absent custodian evidence provisional", () => {
    const fixture = materialize({
      speakerAuthority: "unavailable",
      sourceSentenceGroups: 150,
      externalEvidence: "unavailable",
    });
    const assessment = fixture.selectionManifest.independenceAssessment;
    expect(assessment.status).toBe("provisional-ineligible");
    expect(assessment.uniqueSourceSentenceGroups).toBeLessThan(300);
    expect(assessment.uniqueAuthoritativeSpeakers).toBeNull();
    expect(assessment.caseIndependenceClaim).toBe("none");
    expect(assessment.speakerIndependenceClaim).toBe("none");
    expect(assessment.reasons).toContain("speaker-authority-unavailable");
    expect(assessment.reasons).toContain("insufficient-unique-source-sentence-groups");
    expect(assessment.reasons).toContain("external-leakage-evidence-not-provisioned");
    const result = calibrateT2aFleursThreshold({
      caseManifest: fixture.caseManifest!,
      selectionPolicy: thresholdSelection(fixture),
      scoreReport: scoreReport(fixture),
    });
    expect(result.report.status).toBe("provisional-ineligible");
    expect(result.report.descriptiveFalseAcceptUpperBound95Ppm).toBeNull();
    expect(result.report.confidenceClaim).toBe("not-applicable-untrusted-contract-draft");
    expect(result.thresholdPolicy?.status).toBe("calibration-only-provisional-ineligible");
    expect(result.thresholdPolicy?.independenceClaim).toBe("none");
    expect(result.thresholdPolicy?.holdoutQualification).toBe("not-qualified");
    const overEvaluatorDuration = materialize({
      durationMilliseconds: 22_000,
      createCases: false,
    });
    expect(overEvaluatorDuration.selectionManifest.independenceAssessment.status).toBe(
      "provisional-ineligible",
    );
    expect(overEvaluatorDuration.selectionManifest.independenceAssessment.reasons).toContain(
      "selected-audio-exceeds-bound-evaluator-duration",
    );
  });

  it("computes transitive leakage and fails selection when one component exceeds the frozen capacity", () => {
    const chained = materialize({ transitiveChain: true, createCases: false });
    const firstThree = chained.inventory.rows
      .filter(({ upstreamRowIndex }) => upstreamRowIndex <= 2)
      .map(({ rowAuthorityDigest }) => rowAuthorityDigest);
    expect(chained.leakageManifest.groups.some((group) =>
      firstThree.every((rowDigest) => group.memberRowAuthorityDigests.includes(rowDigest)))).toBe(true);
    expect(() => materialize({ globalLeakageToken: true, createCases: false })).toThrow(
      /transitive-group selection cap/u,
    );
  });

  it("rejects fabricated authority, partial evidence, and contradictory row digests", () => {
    const validAuthority = authority({ externalEvidence: "unavailable" });
    expect(t2aFleursCalibrationAuthoritySchema.safeParse({
      ...validAuthority,
      immutableRevision: digest("wrong-revision").slice(0, 40),
    }).success).toBe(false);
    expect(t2aFleursCalibrationAuthoritySchema.safeParse({
      ...validAuthority,
      licenseEvidence: { ...validAuthority.licenseEvidence, spdxIdentifier: "MIT" },
    }).success).toBe(false);
    expect(t2aFleursCalibrationAuthoritySchema.safeParse({
      ...validAuthority,
      testSplitAccess: {
        ...validAuthority.testSplitAccess,
        attestationDigest: digest("fabricated-partial-evidence"),
      },
    }).success).toBe(false);
    const fixture = materialize();
    const row = structuredClone(fixture.inventory.rows[0]!);
    row.audio.audioAuthorityDigest = digest("contradictory-audio-authority");
    expect(t2aFleursCalibrationRowSchema.safeParse(row).success).toBe(false);
    const ipaRow = structuredClone(fixture.inventory.rows[1]!);
    ipaRow.transcript.ipaTokens = ["tampered"];
    expect(t2aFleursCalibrationRowSchema.safeParse(ipaRow).success).toBe(false);
    const sourceRow = structuredClone(fixture.inventory.rows[2]!);
    sourceRow.leakageTokens = sourceRow.leakageTokens
      .filter(({ kind }) => kind !== "source-sentence");
    expect(t2aFleursCalibrationRowSchema.safeParse(sourceRow).success).toBe(false);
  });

  it("rejects score-based selection fields, synthetic zero-distance negatives, and materialization tamper", () => {
    const fixture = materialize();
    expect(t2aFleursCalibrationSelectionPolicySchema.safeParse({
      ...fixture.selectionPolicy,
      observedAudioScores: [1, 2, 3],
    }).success).toBe(false);
    const zeroDistance = materialize({ constantIpaTokens: true, createCases: false });
    expect(() => createT2aFleursCalibrationCaseManifest({
      inventory: zeroDistance.inventory,
      selectionManifest: zeroDistance.selectionManifest,
      pairingPolicy: zeroDistance.pairingPolicy,
    })).toThrow(/no pinned IPA difference/u);
    const tampered = structuredClone(fixture.caseManifest!);
    tampered.pairs[0]!.foreignRawTranscriptDigest = digest("foreign-transcript-tamper");
    expect(() => verifyT2aFleursCalibrationMaterialization({
      ...fixture,
      caseManifest: tampered,
    })).toThrow(/frozen deterministic derangement/u);
  });

  it("selects only a separate calibration threshold and binds scorer plus adjudicator", () => {
    const fixture = materialize();
    const policy = thresholdSelection(fixture);
    const scores = scoreReport(fixture);
    const result = calibrateT2aFleursThreshold({
      caseManifest: fixture.caseManifest!,
      selectionPolicy: policy,
      scoreReport: scores,
    });
    expect(result.report.status).toBe("provisional-ineligible");
    expect(result.report.thresholdPpm).toBe(100_300);
    expect(T2A_FLEURS_CALIBRATION_ZERO_FA_UPPER_BOUND_95_PPM).toBe(9_937);
    expect(result.report.descriptiveFalseAcceptUpperBound95Ppm).toBeNull();
    expect(result.report.confidenceClaim).toBe("not-applicable-untrusted-contract-draft");
    expect(result.thresholdPolicy?.status).toBe("calibration-only-provisional-ineligible");
    expect(result.thresholdPolicy?.holdoutQualification).toBe("not-qualified");
    expect(() => calibrateT2aFleursThreshold({
      caseManifest: fixture.caseManifest!,
      selectionPolicy: policy,
      scoreReport: { ...scores, adjudicatorDigest: digest("foreign-adjudicator") },
    })).toThrow(/authority binding mismatch/u);
  });

  it("verifies all prerequisites and enforces writer-separated, self-contained exactly-once timing", () => {
    const fixture = materialize();
    const policy = thresholdSelection(fixture);
    const authorization = authorizationFor(fixture, policy);
    expect(() => verifyT2aFleursCalibrationAuthorization({
      ...fixture,
      caseManifest: fixture.caseManifest!,
      thresholdSelectionPolicy: policy,
      authorization,
    })).toThrow(/not cryptographically verified/u);
    expect(() => verifyT2aFleursCalibrationAuthorization({
      ...fixture,
      caseManifest: fixture.caseManifest!,
      thresholdSelectionPolicy: policy,
      authorization: { ...authorization, authorizationKeyId: "forged-authorization-key" },
    })).toThrow(/prerequisite binding mismatch/u);
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const started: T2aFleursCalibrationConsumptionRecord = {
      schemaVersion: T2A_FLEURS_CALIBRATION_CONSUMPTION_VERSION,
      recordId: "22222222-2222-4222-8222-222222222222",
      sequence: 0,
      previousRecordDigest: null,
      authorizationDigest: t2aFleursCalibrationAuthorizationDigest(authorization),
      authorizationNonce: authorization.nonce,
      transactionId,
      state: "started",
      privateInputBytesRead: 0,
      outcome: null,
      outputDigest: null,
      recordedAt: "2026-08-26T08:01:00Z",
      writerDigest: authorization.consumptionWriterDigest,
      authenticity: "unsigned-structural-contract-draft",
    };
    const consumed: T2aFleursCalibrationConsumptionRecord = {
      ...started,
      recordId: "33333333-3333-4333-8333-333333333333",
      sequence: 1,
      previousRecordDigest: t2aFleursCalibrationConsumptionRecordDigest(started),
      state: "consumed",
      privateInputBytesRead: 1,
      recordedAt: "2026-08-26T08:03:00Z",
    };
    const terminal: T2aFleursCalibrationConsumptionRecord = {
      ...consumed,
      recordId: "44444444-4444-4444-8444-444444444444",
      sequence: 2,
      previousRecordDigest: t2aFleursCalibrationConsumptionRecordDigest(consumed),
      state: "terminal",
      privateInputBytesRead: 5_000,
      outcome: "passed",
      outputDigest: digest("calibration-output"),
      recordedAt: "2026-08-26T08:09:00Z",
    };
    expect(validateT2aFleursCalibrationConsumption({
      authorization,
      records: [started, consumed, terminal],
    })).toHaveLength(3);
    expect(() => assertT2aFleursCalibrationMayStart({
      authorization,
      records: [started],
      now: new Date("2026-08-26T08:01:30Z"),
    })).toThrow(/already started/u);
    expect(() => assertT2aFleursCalibrationMayContinue({
      authorization,
      records: [started, consumed],
      transactionId,
      now: new Date("2026-08-26T08:04:00Z"),
    })).toThrow(/contract draft/u);

    const forkedConsumed: T2aFleursCalibrationConsumptionRecord = {
      ...consumed,
      recordId: "55555555-5555-4555-8555-555555555555",
      privateInputBytesRead: 2,
    };
    expect(validateT2aFleursCalibrationConsumption({
      authorization,
      records: [started, forkedConsumed],
    })).toHaveLength(2);
    expect(() => assertT2aFleursCalibrationMayContinue({
      authorization,
      records: [started, forkedConsumed],
      transactionId,
      now: new Date("2026-08-26T08:04:00Z"),
    })).toThrow(/CAS\/replay-head/u);

    expect(() => t2aFleursCalibrationAuthorizationDigest({
      ...authorization,
      maximumPrivateInputBytes: 2_000_000_001,
    })).toThrow();

    expect(() => assertT2aFleursCalibrationMayStart({
      authorization,
      records: [],
      now: new Date("2026-08-26T08:01:30Z"),
    })).toThrow(/contract draft/u);

    const wrongWriter = { ...started, writerDigest: authorization.adjudicatorDigest };
    expect(() => validateT2aFleursCalibrationConsumption({
      authorization,
      records: [wrongWriter],
    })).toThrow(/exactly-once bound/u);
    const earlyStarted = { ...started, recordedAt: "2026-08-26T08:00:30Z" };
    expect(() => validateT2aFleursCalibrationConsumption({
      authorization,
      records: [earlyStarted],
    })).toThrow(/start window/u);
    const lateTerminal = { ...terminal, recordedAt: "2026-08-26T08:11:00Z" };
    expect(() => validateT2aFleursCalibrationConsumption({
      authorization,
      records: [started, consumed, lateTerminal],
    })).toThrow(/crossed completeBy/u);
  });

  it("fails threshold calibration when zero false accepts is impossible", () => {
    const fixture = materialize();
    const scores = scoreReport(fixture);
    const firstNegative = fixture.caseManifest!.negativeCaseIds[0]!;
    scores.scores.find(({ caseId }) => caseId === firstNegative)!.scorePpm =
      T2A_FLEURS_CALIBRATION_SCORE_SCALE;
    const result = calibrateT2aFleursThreshold({
      caseManifest: fixture.caseManifest!,
      selectionPolicy: thresholdSelection(fixture),
      scoreReport: scores,
    });
    expect(result.report.status).toBe("calibration-failed");
    expect(result.report.thresholdPpm).toBeNull();
    expect(result.report.confidenceClaim).toBe("not-applicable-calibration-failed");
    expect(result.thresholdPolicy).toBeNull();
  });
});
