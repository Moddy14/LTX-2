import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  T2A_TUDA_DATASET_REVISION,
  T2A_TUDA_DEV_ROWS,
  T2A_TUDA_MAXIMUM_DURATION_MS,
  T2A_TUDA_TEST_ROWS,
  calibrateT2aTudaDevThreshold,
  createT2aTudaCaseManifest,
  createT2aTudaDevInventory,
  createT2aTudaDevRow,
  createT2aTudaLeakageManifest,
  createT2aTudaPreregistration,
  selectT2aTudaDevCalibration,
  t2aTudaAudioDigest,
  t2aTudaAuthorityDigest,
  t2aTudaAuthoritySchema,
  t2aTudaCaseManifestDigest,
  t2aTudaDevInventoryDigest,
  t2aTudaLedgerReceiptDigest,
  t2aTudaLeakageManifestDigest,
  t2aTudaPreregistrationDigest,
  t2aTudaRunAuthorizationDigest,
  t2aTudaRunAuthorizationSchema,
  t2aTudaScorePayloadDigest,
  t2aTudaScoreReportSchema,
  t2aTudaSelectionManifestDigest,
  verifyT2aTudaCasReplayChain,
  verifyT2aTudaMaterialization,
  verifyT2aTudaPreregistration,
  type T2aTudaAuthority,
  type T2aTudaLedgerReceipt,
  type T2aTudaReplayHead,
  type T2aTudaScoreReport,
} from "../shared/t2aTudaCalibration.js";

type SigningKey = { privateKey: KeyObject; publicKey: KeyObject };
type DevRowInput = Parameters<typeof createT2aTudaDevRow>[0];

const NOW = new Date("2026-08-26T06:30:00Z");

function digest(value: unknown): string {
  return createHash("sha256").update(
    typeof value === "string" ? value : canonicalJson(value),
    "utf8",
  ).digest("hex");
}

function rawPublicKey(key: SigningKey): string {
  return key.publicKey.export({ format: "der", type: "spki" })
    .subarray(-32).toString("base64");
}

function detachedSignature(document: unknown, keyId: string, key: SigningKey) {
  return {
    schemaVersion: "ltx-studio-detached-signature.v1" as const,
    algorithm: "ed25519" as const,
    keyId,
    payloadSha256: digest(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      key.privateKey,
    ).toString("base64"),
  };
}

function ipaAuthorityDigest(options: {
  cleanedSentenceDigest: string;
  normalizationPolicyDigest: string;
  g2pDigest: string;
  adjudicatorDigest: string;
  ipaTokens: readonly string[];
  g2pOovTokenDigests?: readonly string[];
  oovAdjudications?: readonly {
    tokenDigest: string;
    adjudicationRecordDigest: string;
    resolution: "human-adjudicated-german-ipa";
  }[];
}): string {
  return digest({
    schemaVersion: "ltx-studio-t2a-tuda-ipa-authority.v1",
    cleanedSentenceDigest: options.cleanedSentenceDigest,
    normalizationPolicyDigest: options.normalizationPolicyDigest,
    g2pDigest: options.g2pDigest,
    adjudicatorDigest: options.adjudicatorDigest,
    ipaTokens: options.ipaTokens,
    g2pOovTokenDigests: options.g2pOovTokenDigests ?? [],
    oovAdjudications: options.oovAdjudications ?? [],
  });
}

function devRowInput(authority: T2aTudaAuthority, index: number): DevRowInput {
  const speakerId = `speaker-${Math.floor(index / 2).toString().padStart(4, "0")}`;
  const sentenceId = `sentence-${index.toString().padStart(4, "0")}`;
  const cleanedSentence = `Dies ist der eindeutige TUDA Satz Nummer ${index}.`;
  const cleanedSentenceDigest = digest(cleanedSentence);
  const ipaTokens = ["d", "iːs", `n${index}`];
  const microphoneArms = ["microphone-a", "microphone-b"].map((microphone) => {
    const audio = {
      containerDigest: digest(`container:${index}:${microphone}`),
      pcmDigest: digest(`pcm:${index}:${microphone}`),
      sampleRateHz: 16_000 as const,
      channels: 1 as const,
      bitsPerSample: 16 as const,
      sampleFrames: 32_000,
      durationMilliseconds: 2_000,
    };
    return {
      microphone,
      microphoneDigest: digest(microphone),
      audio,
      audioAuthorityDigest: t2aTudaAudioDigest(audio),
    };
  }).sort((left, right) =>
    `${left.microphoneDigest}:${left.audioAuthorityDigest}`.localeCompare(
      `${right.microphoneDigest}:${right.audioAuthorityDigest}`,
    ));
  return {
    split: "dev",
    upstreamRowIndex: index,
    speakerId,
    speakerIdDigest: digest(speakerId),
    sentenceId,
    sentenceIdDigest: digest(sentenceId),
    cleanedSentence,
    cleanedSentenceDigest,
    normalizedWordCount: 9,
    normalizationPolicyDigest: authority.bindings.normalizationPolicyDigest,
    g2pDigest: authority.bindings.g2pDigest,
    adjudicatorDigest: authority.bindings.adjudicatorDigest,
    ipaTokens,
    ipaAuthorityDigest: ipaAuthorityDigest({
      cleanedSentenceDigest,
      normalizationPolicyDigest: authority.bindings.normalizationPolicyDigest,
      g2pDigest: authority.bindings.g2pDigest,
      adjudicatorDigest: authority.bindings.adjudicatorDigest,
      ipaTokens,
    }),
    g2pOovTokenDigests: [],
    oovAdjudications: [],
    unresolvedOovTokenDigests: [],
    microphoneArms,
  };
}

function buildFixture() {
  const keys = {
    authorizer: generateKeyPairSync("ed25519"),
    scorer: generateKeyPairSync("ed25519"),
    ledger: generateKeyPairSync("ed25519"),
    foreign: generateKeyPairSync("ed25519"),
  };
  const trustPolicy = {
    schemaVersion: "ltx-studio-trusted-keys.v1" as const,
    policyId: "tuda-contract-test-policy-001",
    keys: [
      {
        keyId: "tuda-evaluation-authorizer-001",
        algorithm: "ed25519" as const,
        publicKeyBase64: rawPublicKey(keys.authorizer),
        roles: ["evaluation-authorizer" as const],
        notBefore: "2026-08-25T00:00:00Z",
        notAfter: "2026-08-27T00:00:00Z",
        revokedAt: null,
      },
      {
        keyId: "tuda-holdout-scorer-001",
        algorithm: "ed25519" as const,
        publicKeyBase64: rawPublicKey(keys.scorer),
        roles: ["holdout-scorer" as const],
        notBefore: "2026-08-25T00:00:00Z",
        notAfter: "2026-08-27T00:00:00Z",
        revokedAt: null,
      },
      {
        keyId: "tuda-ledger-attestor-001",
        algorithm: "ed25519" as const,
        publicKeyBase64: rawPublicKey(keys.ledger),
        roles: ["qualification-attestor" as const],
        notBefore: "2026-08-25T00:00:00Z",
        notAfter: "2026-08-27T00:00:00Z",
        revokedAt: null,
      },
    ],
  };
  const authority = t2aTudaAuthoritySchema.parse({
    schemaVersion: "ltx-studio-t2a-tuda-authority.v1",
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    repository: "uhhlt/Tuda-De",
    immutableRevision: T2A_TUDA_DATASET_REVISION,
    sourceUrl: `https://huggingface.co/datasets/uhhlt/Tuda-De/tree/${T2A_TUDA_DATASET_REVISION}`,
    license: "CC-BY-4.0",
    features: ["speaker_id", "sentence_id", "cleaned_sentence", "microphone"],
    declaredRows: { dev: T2A_TUDA_DEV_ROWS, test: T2A_TUDA_TEST_ROWS },
    splitSemantics: {
      devTestSpeakers: "new-and-disjoint-by-official-dataset-design",
      devTestSentences: "new-and-disjoint-by-official-dataset-design",
      sentenceOccurrenceWithinEachSplit: "exactly-once-before-microphone-arm-expansion",
      microphoneSemantics: "parallel-arms-of-one-speaking-event",
    },
    modelProvenance: {
      fineTuningCorpus: "Common Voice",
      pretrainingCorpora: ["BABEL", "Common Voice", "MLS"],
      exactTrainingClipInventoryPublished: false,
      disjointnessClaim: "provenance-only-not-cryptographically-proven",
    },
    provisioning: {
      datasetAuthority: "not-provisioned-contract-draft",
      trustRootAuthority: "not-provisioned-contract-draft",
      casReplayAuthority: "not-provisioned-contract-draft",
      devDownloadReceiptDigest: null,
      devSourceInventoryDigest: null,
    },
    licenseEvidence: {
      status: "metadata-only-not-provisioned",
      licenseTextDigest: null,
      datasetCardDigest: null,
      attributionApprovalDigest: null,
    },
    testSplitAccess: {
      state: "not-provisioned-sealed-release-required",
      mounted: false,
      opened: false,
      bytesRead: 0,
      openFileDescriptors: 0,
      inventoryDigest: null,
      speakerSentenceCommitmentRoot: null,
      executionCount: 0,
      futurePolicy: "exactly-once-after-signed-sealed-release",
    },
    trustPolicyDigest: digest(trustPolicy),
    evaluationAuthorizerKeyId: "tuda-evaluation-authorizer-001",
    scorerKeyId: "tuda-holdout-scorer-001",
    ledgerKeyId: "tuda-ledger-attestor-001",
    bindings: {
      combinedEvaluatorDigest: digest("combined-evaluator"),
      scorerDigest: digest("independent-scorer"),
      scorerRuntimeDigest: digest("scorer-runtime"),
      ipaModelManifestDigest: digest("xlsr-phoneme-model-manifest"),
      ipaModelWeightsDigest: digest("xlsr-phoneme-model-weights"),
      ipaRunnerDigest: digest("independent-ipa-runner"),
      g2pDigest: digest("german-g2p"),
      normalizationPolicyDigest: digest("german-normalization-policy"),
      adjudicatorDigest: digest("independent-ipa-adjudicator"),
      groupingRuleDigest: digest("speaker-sentence-transitive-grouping"),
      leakageRuleDigest: digest("dev-test-speaker-sentence-disjointness"),
      ledgerAuthorityDigest: digest("authoritative-signed-cas-replay-store"),
    },
  });
  const rows = Array.from({ length: T2A_TUDA_DEV_ROWS }, (_, index) =>
    createT2aTudaDevRow(devRowInput(authority, index)));
  const inventory = createT2aTudaDevInventory({ authority, rows });
  const leakageManifest = createT2aTudaLeakageManifest({ authority, inventory });
  const selectionManifest = selectT2aTudaDevCalibration({ inventory, leakageManifest });
  const caseManifest = createT2aTudaCaseManifest({ inventory, selectionManifest });
  const preregistration = createT2aTudaPreregistration({
    authority,
    preregistrationId: "tuda-calibration-prereg-001",
  });
  const preregistrationSignature = detachedSignature(
    preregistration,
    authority.evaluationAuthorizerKeyId,
    keys.authorizer,
  );
  const materialization = { inventory, leakageManifest, selectionManifest, caseManifest };
  const authorization = t2aTudaRunAuthorizationSchema.parse({
    schemaVersion: "ltx-studio-t2a-tuda-run-authorization.v1",
    authorizationId: "tuda-calibration-run-001",
    authorityDigest: t2aTudaAuthorityDigest(authority),
    preregistrationDigest: t2aTudaPreregistrationDigest(preregistration),
    inventoryDigest: t2aTudaDevInventoryDigest(inventory),
    leakageManifestDigest: t2aTudaLeakageManifestDigest(leakageManifest),
    selectionManifestDigest: t2aTudaSelectionManifestDigest(selectionManifest),
    caseManifestDigest: t2aTudaCaseManifestDigest(caseManifest),
    combinedEvaluatorDigest: authority.bindings.combinedEvaluatorDigest,
    scorerDigest: authority.bindings.scorerDigest,
    adjudicatorDigest: authority.bindings.adjudicatorDigest,
    ledgerAuthorityDigest: authority.bindings.ledgerAuthorityDigest,
    runScope: "dev-calibration-contract-draft",
    testSplitCapability: "none",
    testBytesAuthorized: 0,
    nonce: digest("tuda-run-once-nonce"),
    transactionId: "00000000-0000-4000-8000-000000000001",
    issuedAt: "2026-08-26T06:00:00Z",
    notBefore: "2026-08-26T06:01:00Z",
    startBy: "2026-08-26T06:05:00Z",
    completeBy: "2026-08-26T07:00:00Z",
    maximumPrivateInputBytes: 100_000_000,
    exactlyOnce: true,
  });
  const authorizationSignature = detachedSignature(
    authorization,
    authority.evaluationAuthorizerKeyId,
    keys.authorizer,
  );
  const scores = [
    ...caseManifest.positiveCaseIds.map((caseId) => ({ caseId, scorePpm: 900_000 })),
    ...caseManifest.negativeCaseIds.map((caseId, index) => ({ caseId, scorePpm: 100_000 + index })),
  ].sort((left, right) => left.caseId.localeCompare(right.caseId));
  const scoreCore = {
    schemaVersion: "ltx-studio-t2a-tuda-score-report.v1" as const,
    authorizationDigest: t2aTudaRunAuthorizationDigest(authorization),
    caseManifestDigest: t2aTudaCaseManifestDigest(caseManifest),
    combinedEvaluatorDigest: authority.bindings.combinedEvaluatorDigest,
    scorerDigest: authority.bindings.scorerDigest,
    adjudicatorDigest: authority.bindings.adjudicatorDigest,
    scope: "dev-calibration-contract-draft" as const,
    testBytesRead: 0 as const,
    scores,
  };
  const provisionalScoreReport = t2aTudaScoreReportSchema.parse({
    ...scoreCore,
    receiptHeadDigest: digest("temporary-terminal-head"),
  });
  const scorePayloadDigest = t2aTudaScorePayloadDigest(provisionalScoreReport);
  const reserved: T2aTudaLedgerReceipt = {
    schemaVersion: "ltx-studio-t2a-tuda-ledger-receipt.v1",
    receiptId: "00000000-0000-4000-8000-000000000101",
    authorizationDigest: t2aTudaRunAuthorizationDigest(authorization),
    authorizationNonce: authorization.nonce,
    transactionId: authorization.transactionId,
    ledgerAuthorityDigest: authority.bindings.ledgerAuthorityDigest,
    sequence: 0,
    previousReceiptDigest: null,
    state: "reserved",
    privateInputBytesRead: 0,
    outcome: null,
    outputDigest: null,
    recordedAt: "2026-08-26T06:02:00Z",
  };
  const consumed: T2aTudaLedgerReceipt = {
    ...reserved,
    receiptId: "00000000-0000-4000-8000-000000000102",
    sequence: 1,
    previousReceiptDigest: t2aTudaLedgerReceiptDigest(reserved),
    state: "consumed",
    privateInputBytesRead: 12_345_678,
    recordedAt: "2026-08-26T06:03:00Z",
  };
  const terminal: T2aTudaLedgerReceipt = {
    ...consumed,
    receiptId: "00000000-0000-4000-8000-000000000103",
    sequence: 2,
    previousReceiptDigest: t2aTudaLedgerReceiptDigest(consumed),
    state: "terminal",
    outcome: "passed",
    outputDigest: scorePayloadDigest,
    recordedAt: "2026-08-26T06:10:00Z",
  };
  const receipts = [reserved, consumed, terminal].map((document) => ({
    document,
    signature: detachedSignature(document, authority.ledgerKeyId, keys.ledger),
  }));
  const replayHead: T2aTudaReplayHead = {
    schemaVersion: "ltx-studio-t2a-tuda-replay-head.v1",
    authorizationDigest: t2aTudaRunAuthorizationDigest(authorization),
    authorizationNonce: authorization.nonce,
    transactionId: authorization.transactionId,
    ledgerAuthorityDigest: authority.bindings.ledgerAuthorityDigest,
    currentHeadDigest: t2aTudaLedgerReceiptDigest(terminal),
    generation: 3,
    terminal: true,
    observedAt: "2026-08-26T06:11:00Z",
  };
  const replayHeadSignature = detachedSignature(
    replayHead,
    authority.ledgerKeyId,
    keys.ledger,
  );
  const scoreReport: T2aTudaScoreReport = {
    ...scoreCore,
    receiptHeadDigest: t2aTudaLedgerReceiptDigest(terminal),
  };
  const scoreReportSignature = detachedSignature(
    scoreReport,
    authority.scorerKeyId,
    keys.scorer,
  );
  return {
    keys,
    trustPolicy,
    authority,
    rows,
    materialization,
    preregistration,
    preregistrationSignature,
    authorization,
    authorizationSignature,
    receipts,
    replayHead,
    replayHeadSignature,
    scoreReport,
    scoreReportSignature,
  };
}

let fixture: ReturnType<typeof buildFixture>;

beforeAll(() => {
  fixture = buildFixture();
}, 30_000);

function calibrationOptions() {
  return {
    authority: fixture.authority,
    preregistration: fixture.preregistration,
    preregistrationSignature: fixture.preregistrationSignature,
    materialization: fixture.materialization,
    authorization: fixture.authorization,
    authorizationSignature: fixture.authorizationSignature,
    receipts: fixture.receipts,
    replayHead: fixture.replayHead,
    replayHeadSignature: fixture.replayHeadSignature,
    scoreReport: fixture.scoreReport,
    scoreReportSignature: fixture.scoreReportSignature,
    trustPolicy: fixture.trustPolicy,
    now: NOW,
  };
}

describe("TUDA-De calibration contract v1", () => {
  it("pins only the metadata-only draft and deterministically materializes Dev", () => {
    expect(fixture.authority.immutableRevision).toBe(
      "26ad28a9ac73b664c2f7c7c93969f9507ea6aadc",
    );
    expect(fixture.authority.license).toBe("CC-BY-4.0");
    expect(fixture.authority.declaredRows).toEqual({ dev: 1_085, test: 1_028 });
    expect(fixture.authority.testSplitAccess).toMatchObject({
      state: "not-provisioned-sealed-release-required",
      mounted: false,
      opened: false,
      bytesRead: 0,
      inventoryDigest: null,
      speakerSentenceCommitmentRoot: null,
    });
    expect(fixture.materialization.inventory.evidenceMode).toBe(
      "synthetic-contract-test-only-not-dataset-evidence",
    );
    expect(fixture.preregistration.leakagePolicy).toMatchObject({
      devTestSpeakerOverlap: null,
      devTestSentenceOverlap: null,
      verificationState: "not-provisioned-no-claim",
    });
    expect(fixture.materialization.selectionManifest.selected).toHaveLength(300);
    expect(fixture.materialization.selectionManifest.reserve).toHaveLength(785);
    expect(new Set(fixture.materialization.selectionManifest.selected.map(
      ({ sentenceIdDigest }) => sentenceIdDigest,
    )).size).toBe(300);
    const selectedGroupIds = new Set(fixture.materialization.selectionManifest.selected.map(
      ({ leakageGroupId }) => leakageGroupId,
    ));
    const reserveGroupIds = new Set(fixture.materialization.selectionManifest.reserve.map(
      ({ leakageGroupId }) => leakageGroupId,
    ));
    expect([...selectedGroupIds].filter((groupId) => reserveGroupIds.has(groupId))).toEqual([]);
    expect(selectedGroupIds.size).toBe(150);
    const selectedRowIds = new Set(fixture.materialization.selectionManifest.selected.map(
      ({ rowAuthorityDigest }) => rowAuthorityDigest,
    ));
    expect(fixture.materialization.leakageManifest.groups.every((group) => {
      const selectedMembers = group.memberRowDigests.filter((row) => selectedRowIds.has(row));
      return selectedMembers.length === 0
        || selectedMembers.length === group.memberRowDigests.length;
    })).toBe(true);
    expect(fixture.materialization.selectionManifest.selected.every((row) =>
      fixture.materialization.inventory.rows.find(
        ({ rowAuthorityDigest }) => rowAuthorityDigest === row.rowAuthorityDigest,
      )?.microphoneArms.filter(
        ({ audioAuthorityDigest }) => audioAuthorityDigest === row.audioAuthorityDigest,
      ).length === 1)).toBe(true);
    expect(fixture.materialization.caseManifest.positiveCaseIds).toHaveLength(300);
    expect(fixture.materialization.caseManifest.negativeCaseIds).toHaveLength(300);
    for (const band of ["hard", "medium", "easy"] as const) {
      expect(fixture.materialization.caseManifest.pairs.filter(
        ({ difficultyBand }) => difficultyBand === band,
      )).toHaveLength(100);
    }
    expect(new Set(fixture.materialization.caseManifest.pairs.map(
      ({ foreignTranscriptDigest }) => foreignTranscriptDigest,
    ))).toEqual(new Set(fixture.materialization.caseManifest.transcriptMarginalDigests));
    expect(fixture.materialization.caseManifest.pairs.every((pair) =>
      pair.sourceRowDigest !== pair.referenceRowDigest
      && pair.ownTranscriptDigest !== pair.foreignTranscriptDigest)).toBe(true);
    expect(() => verifyT2aTudaMaterialization({
      authority: fixture.authority,
      ...fixture.materialization,
    })).not.toThrow();
  });

  it("requires the authority-bound detached preregistration signature", () => {
    expect(() => verifyT2aTudaPreregistration({
      authority: fixture.authority,
      preregistration: fixture.preregistration,
      signature: fixture.preregistrationSignature,
      trustPolicy: fixture.trustPolicy,
      now: NOW,
    })).not.toThrow();
    const forged = detachedSignature(
      fixture.preregistration,
      fixture.authority.evaluationAuthorizerKeyId,
      fixture.keys.foreign,
    );
    expect(() => verifyT2aTudaPreregistration({
      authority: fixture.authority,
      preregistration: fixture.preregistration,
      signature: forged,
      trustPolicy: fixture.trustPolicy,
      now: NOW,
    })).toThrow(/invalid/u);
    expect(() => verifyT2aTudaPreregistration({
      authority: fixture.authority,
      preregistration: fixture.preregistration,
      signature: fixture.preregistrationSignature,
      trustPolicy: { ...fixture.trustPolicy, policyId: "substituted-policy-001" },
      now: NOW,
    })).toThrow(/not bound/u);
  });

  it("verifies CAS/replay and rejects signed forks, truncation, and replay", () => {
    expect(verifyT2aTudaCasReplayChain({
      authority: fixture.authority,
      authorization: fixture.authorization,
      receipts: fixture.receipts,
      replayHead: fixture.replayHead,
      replayHeadSignature: fixture.replayHeadSignature,
      trustPolicy: fixture.trustPolicy,
      now: NOW,
    })).toHaveLength(3);
    const terminal = fixture.receipts[2]!.document as T2aTudaLedgerReceipt;
    const fork: T2aTudaLedgerReceipt = {
      ...terminal,
      receiptId: "00000000-0000-4000-8000-000000000199",
      outputDigest: digest("fork-output"),
    };
    expect(() => verifyT2aTudaCasReplayChain({
      authority: fixture.authority,
      authorization: fixture.authorization,
      receipts: [
        ...fixture.receipts.slice(0, 2),
        {
          document: fork,
          signature: detachedSignature(
            fork,
            fixture.authority.ledgerKeyId,
            fixture.keys.ledger,
          ),
        },
      ],
      replayHead: fixture.replayHead,
      replayHeadSignature: fixture.replayHeadSignature,
      trustPolicy: fixture.trustPolicy,
      now: NOW,
    })).toThrow(/fork, truncation, or replay/u);
    expect(() => verifyT2aTudaCasReplayChain({
      authority: fixture.authority,
      authorization: fixture.authorization,
      receipts: fixture.receipts.slice(0, 2),
      replayHead: fixture.replayHead,
      replayHeadSignature: fixture.replayHeadSignature,
      trustPolicy: fixture.trustPolicy,
      now: NOW,
    })).toThrow(/fork, truncation, or replay/u);
    const replayHead = {
      ...fixture.replayHead,
      authorizationNonce: digest("replayed-under-another-authorization"),
    };
    expect(() => verifyT2aTudaCasReplayChain({
      authority: fixture.authority,
      authorization: fixture.authorization,
      receipts: fixture.receipts,
      replayHead,
      replayHeadSignature: detachedSignature(
        replayHead,
        fixture.authority.ledgerKeyId,
        fixture.keys.ledger,
      ),
      trustPolicy: fixture.trustPolicy,
      now: NOW,
    })).toThrow(/fork, truncation, or replay/u);
  });

  it("keeps even cryptographically valid wished scores provisional and ineligible", () => {
    const report = calibrateT2aTudaDevThreshold(calibrationOptions());
    expect(report).toMatchObject({
      status: "provisional-ineligible",
      thresholdPpm: 100_300,
      trueAccepts: 300,
      falseAccepts: 0,
      authorityStatus: "not-provisioned-contract-draft",
      datasetEvidenceStatus: "synthetic-contract-test-only",
      testSplitStatus: "unopened-zero-bytes-not-provisioned",
      calibrationQualification: "not-calibrated",
      holdoutQualification: "not-qualified",
    });
    const tamperedScoreReport = structuredClone(fixture.scoreReport);
    tamperedScoreReport.scores[0]!.scorePpm += 1;
    expect(() => calibrateT2aTudaDevThreshold({
      ...calibrationOptions(),
      scoreReport: tamperedScoreReport,
    })).toThrow(/payload digest|invalid/u);
  });

  it("makes Test access and fabricated split-overlap evidence unrepresentable", () => {
    expect(t2aTudaAuthoritySchema.safeParse({
      ...fixture.authority,
      testSplitAccess: {
        ...fixture.authority.testSplitAccess,
        opened: true,
        bytesRead: 1,
        inventoryDigest: digest("fabricated-test-inventory"),
      },
    }).success).toBe(false);
    expect(t2aTudaRunAuthorizationSchema.safeParse({
      ...fixture.authorization,
      testSplitCapability: "read",
      testBytesAuthorized: 1,
    }).success).toBe(false);
    expect(t2aTudaScoreReportSchema.safeParse({
      ...fixture.scoreReport,
      testBytesRead: 1,
    }).success).toBe(false);
    expect(fixture.materialization.leakageManifest.futureTestEvidence).toEqual({
      status: "not-provisioned",
      commitmentRoot: null,
      speakerOverlapCount: null,
      sentenceOverlapCount: null,
      testRowsDisclosed: 0,
      testBytesRead: 0,
    });
  });

  it("binds speaker/sentence components and rejects duplicate microphones or digests", () => {
    const row0 = fixture.rows.find(({ upstreamRowIndex }) => upstreamRowIndex === 0)!;
    const row1 = fixture.rows.find(({ upstreamRowIndex }) => upstreamRowIndex === 1)!;
    const sharedComponent = fixture.materialization.leakageManifest.groups.find((group) =>
      group.memberRowDigests.includes(row0.rowAuthorityDigest));
    expect(sharedComponent?.memberRowDigests).toContain(row1.rowAuthorityDigest);
    expect(sharedComponent?.speakerDigests).toEqual([row0.speakerIdDigest]);
    expect(sharedComponent?.sentenceDigests).toHaveLength(2);

    const duplicateMicrophone = devRowInput(fixture.authority, 0);
    duplicateMicrophone.microphoneArms.push({ ...duplicateMicrophone.microphoneArms[0]! });
    expect(() => createT2aTudaDevRow(duplicateMicrophone)).toThrow(/microphone|sorted/u);

    const tamperedAudio = devRowInput(fixture.authority, 0);
    tamperedAudio.microphoneArms[0]!.audioAuthorityDigest = digest("wrong-audio-authority");
    expect(() => createT2aTudaDevRow(tamperedAudio)).toThrow(/audio authority digest mismatch/u);

    const duplicateSentenceRows = [...fixture.rows.slice(0, -1), row0];
    expect(() => createT2aTudaDevInventory({
      authority: fixture.authority,
      rows: duplicateSentenceRows,
    })).toThrow(/unique|cover/u);
  });

  it("fails closed when atomic leakage components cannot fill exactly 300 rows", () => {
    const speakerId = "single-transitive-speaker";
    const impossibleRows = Array.from({ length: T2A_TUDA_DEV_ROWS }, (_, index) => {
      const body = devRowInput(fixture.authority, index);
      body.speakerId = speakerId;
      body.speakerIdDigest = digest(speakerId);
      return createT2aTudaDevRow(body);
    });
    const inventory = createT2aTudaDevInventory({
      authority: fixture.authority,
      rows: impossibleRows,
    });
    const leakageManifest = createT2aTudaLeakageManifest({
      authority: fixture.authority,
      inventory,
    });
    expect(leakageManifest.groups).toHaveLength(1);
    expect(leakageManifest.groups[0]!.memberRowDigests).toHaveLength(T2A_TUDA_DEV_ROWS);
    expect(() => selectT2aTudaDevCalibration({
      inventory,
      leakageManifest,
    })).toThrow(/cannot fill exactly 300 rows without splitting/u);
  }, 30_000);

  it("rejects overlong audio, unsafe Unicode, unresolved OOVs, and forged IPA", () => {
    const overlong = devRowInput(fixture.authority, 0);
    overlong.microphoneArms[0]!.audio.durationMilliseconds =
      T2A_TUDA_MAXIMUM_DURATION_MS + 1;
    overlong.microphoneArms[0]!.audio.sampleFrames = 16_000 * 22;
    expect(() => createT2aTudaDevRow(overlong)).toThrow();

    const nonCanonical = devRowInput(fixture.authority, 0);
    nonCanonical.cleanedSentence = "U\u0308ber unsicheres Unicode.";
    nonCanonical.cleanedSentenceDigest = digest(nonCanonical.cleanedSentence);
    expect(() => createT2aTudaDevRow(nonCanonical)).toThrow(/NFC/u);
    const bidi = devRowInput(fixture.authority, 0);
    bidi.cleanedSentence = "Sicher\u202eunsicher";
    bidi.cleanedSentenceDigest = digest(bidi.cleanedSentence);
    expect(() => createT2aTudaDevRow(bidi)).toThrow(/bidi/u);

    const unresolvedOov = devRowInput(fixture.authority, 0);
    const oovDigest = digest("unresolved-oov-token");
    unresolvedOov.g2pOovTokenDigests = [oovDigest];
    unresolvedOov.ipaAuthorityDigest = ipaAuthorityDigest({
      cleanedSentenceDigest: unresolvedOov.cleanedSentenceDigest,
      normalizationPolicyDigest: unresolvedOov.normalizationPolicyDigest,
      g2pDigest: unresolvedOov.g2pDigest,
      adjudicatorDigest: unresolvedOov.adjudicatorDigest,
      ipaTokens: unresolvedOov.ipaTokens,
      g2pOovTokenDigests: [oovDigest],
    });
    expect(() => createT2aTudaDevRow(unresolvedOov)).toThrow(/human IPA adjudication/u);

    const forgedIpa = devRowInput(fixture.authority, 0);
    forgedIpa.ipaAuthorityDigest = digest("forged-ipa-authority");
    expect(() => createT2aTudaDevRow(forgedIpa)).toThrow(/IPA authority mismatch/u);
  });

  it("rejects deadline crossing and a passed receipt without durable consumption", () => {
    const terminal = fixture.receipts[2]!.document as T2aTudaLedgerReceipt;
    const late: T2aTudaLedgerReceipt = {
      ...terminal,
      recordedAt: "2026-08-26T07:00:01Z",
    };
    expect(() => verifyT2aTudaCasReplayChain({
      authority: fixture.authority,
      authorization: fixture.authorization,
      receipts: [
        ...fixture.receipts.slice(0, 2),
        {
          document: late,
          signature: detachedSignature(late, fixture.authority.ledgerKeyId, fixture.keys.ledger),
        },
      ],
      replayHead: fixture.replayHead,
      replayHeadSignature: fixture.replayHeadSignature,
      trustPolicy: fixture.trustPolicy,
      now: NOW,
    })).toThrow(/crossed completeBy/u);

    const reserved = fixture.receipts[0]!.document as T2aTudaLedgerReceipt;
    const directPassed: T2aTudaLedgerReceipt = {
      ...terminal,
      receiptId: "00000000-0000-4000-8000-000000000198",
      sequence: 1,
      previousReceiptDigest: t2aTudaLedgerReceiptDigest(reserved),
      privateInputBytesRead: 12_345_678,
    };
    expect(() => verifyT2aTudaCasReplayChain({
      authority: fixture.authority,
      authorization: fixture.authorization,
      receipts: [
        fixture.receipts[0]!,
        {
          document: directPassed,
          signature: detachedSignature(
            directPassed,
            fixture.authority.ledgerKeyId,
            fixture.keys.ledger,
          ),
        },
      ],
      replayHead: fixture.replayHead,
      replayHeadSignature: fixture.replayHeadSignature,
      trustPolicy: fixture.trustPolicy,
      now: NOW,
    })).toThrow(/durable consumed receipt/u);
  });
});
