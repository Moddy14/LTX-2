import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";
import {
  detachedSignatureSchema,
  trustedKeyPolicySchema,
  verifyDetachedSignature,
} from "./releaseAudit.js";

export const T2A_TUDA_AUTHORITY_VERSION = "ltx-studio-t2a-tuda-authority.v1" as const;
export const T2A_TUDA_PREREGISTRATION_VERSION =
  "ltx-studio-t2a-tuda-preregistration.v1" as const;
export const T2A_TUDA_DEV_INVENTORY_VERSION =
  "ltx-studio-t2a-tuda-dev-inventory.v1" as const;
export const T2A_TUDA_LEAKAGE_VERSION = "ltx-studio-t2a-tuda-leakage.v1" as const;
export const T2A_TUDA_SELECTION_VERSION = "ltx-studio-t2a-tuda-selection.v1" as const;
export const T2A_TUDA_CASE_MANIFEST_VERSION =
  "ltx-studio-t2a-tuda-case-manifest.v1" as const;
export const T2A_TUDA_RUN_AUTHORIZATION_VERSION =
  "ltx-studio-t2a-tuda-run-authorization.v1" as const;
export const T2A_TUDA_LEDGER_RECEIPT_VERSION =
  "ltx-studio-t2a-tuda-ledger-receipt.v1" as const;
export const T2A_TUDA_REPLAY_HEAD_VERSION =
  "ltx-studio-t2a-tuda-replay-head.v1" as const;
export const T2A_TUDA_SCORE_REPORT_VERSION =
  "ltx-studio-t2a-tuda-score-report.v1" as const;
export const T2A_TUDA_CALIBRATION_REPORT_VERSION =
  "ltx-studio-t2a-tuda-calibration-report.v1" as const;

export const T2A_TUDA_DATASET_REVISION =
  "26ad28a9ac73b664c2f7c7c93969f9507ea6aadc" as const;
export const T2A_TUDA_DEV_ROWS = 1_085 as const;
export const T2A_TUDA_TEST_ROWS = 1_028 as const;
export const T2A_TUDA_CALIBRATION_CASES_PER_CLASS = 300 as const;
export const T2A_TUDA_TOTAL_CALIBRATION_CASES = 600 as const;
export const T2A_TUDA_MAXIMUM_DURATION_MS = 21_000 as const;
export const T2A_TUDA_SCORE_SCALE = 1_000_000 as const;
export const T2A_TUDA_MINIMUM_TRUE_ACCEPTS = 285 as const;
export const T2A_TUDA_MAXIMUM_PRIVATE_INPUT_BYTES = 2_000_000_000 as const;
export const T2A_TUDA_MAXIMUM_RUNTIME_MS = 4 * 60 * 60 * 1_000;
export const T2A_TUDA_DATASET_FEATURES = [
  "speaker_id",
  "sentence_id",
  "cleaned_sentence",
  "microphone",
] as const;

const SELECTION_DOMAIN = "ltx-studio:t2a:tuda-de:dev:calibration:v1";
const MICROPHONE_DOMAIN = "ltx-studio:t2a:tuda-de:microphone-arm:v1";
const PAIRING_DOMAIN = "ltx-studio:t2a:tuda-de:dev:derangement:v1";
export const T2A_TUDA_SELECTION_SEED = createHash("sha256")
  .update(SELECTION_DOMAIN).digest("hex");
export const T2A_TUDA_MICROPHONE_SEED = createHash("sha256")
  .update(MICROPHONE_DOMAIN).digest("hex");
export const T2A_TUDA_PAIRING_SEED = createHash("sha256")
  .update(PAIRING_DOMAIN).digest("hex");

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u).refine(
  (value) => !/^([0-9a-f])\1{63}$/u.test(value),
  "placeholder digests are forbidden",
);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });
const uuidSchema = z.string().uuid();

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function isSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value)
    && new Set(values).size === values.length;
}

function addSortedUniqueIssue(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  if (!isSortedUnique(values)) {
    context.addIssue({ code: "custom", path, message: "values must be strictly sorted and unique" });
  }
}

function safeGermanText(value: string): boolean {
  if (value !== value.normalize("NFC") || value.trim() !== value || value.length === 0) return false;
  return [...value].every((character) => {
    const point = character.codePointAt(0)!;
    return point > 31
      && point !== 127
      && !(point >= 128 && point <= 159)
      && !(point >= 0x202a && point <= 0x202e)
      && !(point >= 0x2066 && point <= 0x2069)
      && point !== 0xfeff;
  });
}

const upstreamTextFieldSchema = z.string().min(1).max(512).refine(
  safeGermanText,
  "upstream field must be trimmed NFC without controls or bidi overrides",
);

const tudaBindingsSchema = z.object({
  combinedEvaluatorDigest: sha256Schema,
  scorerDigest: sha256Schema,
  scorerRuntimeDigest: sha256Schema,
  ipaModelManifestDigest: sha256Schema,
  ipaModelWeightsDigest: sha256Schema,
  ipaRunnerDigest: sha256Schema,
  g2pDigest: sha256Schema,
  normalizationPolicyDigest: sha256Schema,
  adjudicatorDigest: sha256Schema,
  groupingRuleDigest: sha256Schema,
  leakageRuleDigest: sha256Schema,
  ledgerAuthorityDigest: sha256Schema,
}).strict().superRefine((value, context) => {
  const independent = [
    value.scorerDigest,
    value.adjudicatorDigest,
    value.ipaRunnerDigest,
    value.ipaModelWeightsDigest,
  ];
  if (new Set(independent).size !== independent.length) {
    context.addIssue({
      code: "custom",
      path: ["adjudicatorDigest"],
      message: "scorer, adjudicator, IPA runner, and weights must be independently pinned",
    });
  }
});

const datasetFeaturesSchema = z.tuple([
  z.literal("speaker_id"),
  z.literal("sentence_id"),
  z.literal("cleaned_sentence"),
  z.literal("microphone"),
]);

export const t2aTudaAuthoritySchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_AUTHORITY_VERSION),
  canonicalization: z.literal("ltx-studio-canonical-json.v1"),
  digestAlgorithm: z.literal("sha256"),
  repository: z.literal("uhhlt/Tuda-De"),
  immutableRevision: z.literal(T2A_TUDA_DATASET_REVISION),
  sourceUrl: z.literal(
    "https://huggingface.co/datasets/uhhlt/Tuda-De/tree/26ad28a9ac73b664c2f7c7c93969f9507ea6aadc",
  ),
  license: z.literal("CC-BY-4.0"),
  features: datasetFeaturesSchema,
  declaredRows: z.object({ dev: z.literal(T2A_TUDA_DEV_ROWS), test: z.literal(T2A_TUDA_TEST_ROWS) })
    .strict(),
  splitSemantics: z.object({
    devTestSpeakers: z.literal("new-and-disjoint-by-official-dataset-design"),
    devTestSentences: z.literal("new-and-disjoint-by-official-dataset-design"),
    sentenceOccurrenceWithinEachSplit: z.literal("exactly-once-before-microphone-arm-expansion"),
    microphoneSemantics: z.literal("parallel-arms-of-one-speaking-event"),
  }).strict(),
  modelProvenance: z.object({
    fineTuningCorpus: z.literal("Common Voice"),
    pretrainingCorpora: z.tuple([
      z.literal("BABEL"),
      z.literal("Common Voice"),
      z.literal("MLS"),
    ]),
    exactTrainingClipInventoryPublished: z.literal(false),
    disjointnessClaim: z.literal("provenance-only-not-cryptographically-proven"),
  }).strict(),
  provisioning: z.object({
    datasetAuthority: z.literal("not-provisioned-contract-draft"),
    trustRootAuthority: z.literal("not-provisioned-contract-draft"),
    casReplayAuthority: z.literal("not-provisioned-contract-draft"),
    devDownloadReceiptDigest: z.null(),
    devSourceInventoryDigest: z.null(),
  }).strict(),
  licenseEvidence: z.object({
    status: z.literal("metadata-only-not-provisioned"),
    licenseTextDigest: z.null(),
    datasetCardDigest: z.null(),
    attributionApprovalDigest: z.null(),
  }).strict(),
  testSplitAccess: z.object({
    state: z.literal("not-provisioned-sealed-release-required"),
    mounted: z.literal(false),
    opened: z.literal(false),
    bytesRead: z.literal(0),
    openFileDescriptors: z.literal(0),
    inventoryDigest: z.null(),
    speakerSentenceCommitmentRoot: z.null(),
    executionCount: z.literal(0),
    futurePolicy: z.literal("exactly-once-after-signed-sealed-release"),
  }).strict(),
  trustPolicyDigest: sha256Schema,
  evaluationAuthorizerKeyId: identifierSchema,
  scorerKeyId: identifierSchema,
  ledgerKeyId: identifierSchema,
  bindings: tudaBindingsSchema,
}).strict().superRefine((value, context) => {
  if (new Set([
    value.evaluationAuthorizerKeyId,
    value.scorerKeyId,
    value.ledgerKeyId,
  ]).size !== 3) {
    context.addIssue({
      code: "custom",
      path: ["evaluationAuthorizerKeyId"],
      message: "authorizer, scorer, and ledger keys must be distinct",
    });
  }
});

export type T2aTudaAuthority = z.infer<typeof t2aTudaAuthoritySchema>;

export function t2aTudaAuthorityDigest(raw: unknown): string {
  return digestCanonical(t2aTudaAuthoritySchema.parse(raw));
}

const ipaTokenSchema = z.string().min(1).max(32).refine(safeGermanText, "unsafe IPA token");
const oovAdjudicationSchema = z.object({
  tokenDigest: sha256Schema,
  adjudicationRecordDigest: sha256Schema,
  resolution: z.literal("human-adjudicated-german-ipa"),
}).strict();

const audioBodySchema = z.object({
  containerDigest: sha256Schema,
  pcmDigest: sha256Schema,
  sampleRateHz: z.literal(16_000),
  channels: z.literal(1),
  bitsPerSample: z.literal(16),
  sampleFrames: z.number().int().positive().max(16_000 * 21),
  durationMilliseconds: z.number().int().positive().max(T2A_TUDA_MAXIMUM_DURATION_MS),
}).strict().superRefine((value, context) => {
  if (Math.abs(value.sampleFrames * 1_000 - value.durationMilliseconds * 16_000) > 16_000) {
    context.addIssue({
      code: "custom",
      path: ["durationMilliseconds"],
      message: "duration must match sample frames within one millisecond",
    });
  }
});

export function t2aTudaAudioDigest(raw: unknown): string {
  return digestCanonical({
    schemaVersion: "ltx-studio-t2a-tuda-audio-authority.v1",
    audio: audioBodySchema.parse(raw),
  });
}

const microphoneArmSchema = z.object({
  microphone: upstreamTextFieldSchema,
  microphoneDigest: sha256Schema,
  audio: audioBodySchema,
  audioAuthorityDigest: sha256Schema,
}).strict().superRefine((value, context) => {
  if (digestText(value.microphone) !== value.microphoneDigest) {
    context.addIssue({ code: "custom", path: ["microphoneDigest"], message: "microphone digest mismatch" });
  }
  if (t2aTudaAudioDigest(value.audio) !== value.audioAuthorityDigest) {
    context.addIssue({
      code: "custom",
      path: ["audioAuthorityDigest"],
      message: "audio authority digest mismatch",
    });
  }
});

const rowBodySchema = z.object({
  split: z.literal("dev"),
  upstreamRowIndex: z.number().int().min(0).max(T2A_TUDA_DEV_ROWS - 1),
  speakerId: upstreamTextFieldSchema,
  speakerIdDigest: sha256Schema,
  sentenceId: upstreamTextFieldSchema,
  sentenceIdDigest: sha256Schema,
  cleanedSentence: z.string().min(1).max(1_000).refine(
    safeGermanText,
    "cleaned sentence must be trimmed NFC without controls or bidi overrides",
  ),
  cleanedSentenceDigest: sha256Schema,
  normalizedWordCount: z.number().int().min(1).max(200),
  normalizationPolicyDigest: sha256Schema,
  g2pDigest: sha256Schema,
  adjudicatorDigest: sha256Schema,
  ipaTokens: z.array(ipaTokenSchema).min(1).max(512),
  ipaAuthorityDigest: sha256Schema,
  g2pOovTokenDigests: z.array(sha256Schema).max(64),
  oovAdjudications: z.array(oovAdjudicationSchema).max(64),
  unresolvedOovTokenDigests: z.array(sha256Schema).length(0),
  microphoneArms: z.array(microphoneArmSchema).min(1).max(16),
}).strict();

export const t2aTudaDevRowSchema = rowBodySchema.extend({
  rowAuthorityDigest: sha256Schema,
}).strict().superRefine((value, context) => {
  const { rowAuthorityDigest, ...body } = value;
  if (digestCanonical(body) !== rowAuthorityDigest) {
    context.addIssue({ code: "custom", path: ["rowAuthorityDigest"], message: "row digest mismatch" });
  }
  if (digestText(value.speakerId) !== value.speakerIdDigest
    || digestText(value.sentenceId) !== value.sentenceIdDigest
    || digestText(value.cleanedSentence) !== value.cleanedSentenceDigest) {
    context.addIssue({ code: "custom", path: ["speakerIdDigest"], message: "source field digest mismatch" });
  }
  const ipaDigest = digestCanonical({
    schemaVersion: "ltx-studio-t2a-tuda-ipa-authority.v1",
    cleanedSentenceDigest: value.cleanedSentenceDigest,
    normalizationPolicyDigest: value.normalizationPolicyDigest,
    g2pDigest: value.g2pDigest,
    adjudicatorDigest: value.adjudicatorDigest,
    ipaTokens: value.ipaTokens,
    g2pOovTokenDigests: value.g2pOovTokenDigests,
    oovAdjudications: value.oovAdjudications,
  });
  if (ipaDigest !== value.ipaAuthorityDigest) {
    context.addIssue({ code: "custom", path: ["ipaAuthorityDigest"], message: "IPA authority mismatch" });
  }
  addSortedUniqueIssue(
    value.g2pOovTokenDigests,
    context,
    ["g2pOovTokenDigests"],
  );
  addSortedUniqueIssue(
    value.oovAdjudications.map(({ tokenDigest }) => tokenDigest),
    context,
    ["oovAdjudications"],
  );
  if (!sameCanonical(
    value.g2pOovTokenDigests,
    value.oovAdjudications.map(({ tokenDigest }) => tokenDigest),
  )) {
    context.addIssue({
      code: "custom",
      path: ["oovAdjudications"],
      message: "every G2P OOV token requires exactly one human IPA adjudication",
    });
  }
  addSortedUniqueIssue(
    value.microphoneArms.map(({ microphoneDigest, audioAuthorityDigest }) =>
      `${microphoneDigest}:${audioAuthorityDigest}`),
    context,
    ["microphoneArms"],
  );
  if (new Set(value.microphoneArms.map(({ microphoneDigest }) => microphoneDigest)).size
      !== value.microphoneArms.length) {
    context.addIssue({
      code: "custom",
      path: ["microphoneArms"],
      message: "a sentence may contain each microphone arm exactly once",
    });
  }
});

export type T2aTudaDevRow = z.infer<typeof t2aTudaDevRowSchema>;

export function createT2aTudaDevRow(raw: z.input<typeof rowBodySchema>): T2aTudaDevRow {
  const body = rowBodySchema.parse(raw);
  return t2aTudaDevRowSchema.parse({ ...body, rowAuthorityDigest: digestCanonical(body) });
}

export const t2aTudaDevInventorySchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_DEV_INVENTORY_VERSION),
  authorityDigest: sha256Schema,
  evidenceMode: z.literal("synthetic-contract-test-only-not-dataset-evidence"),
  split: z.literal("dev"),
  rows: z.array(t2aTudaDevRowSchema).length(T2A_TUDA_DEV_ROWS),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssue(value.rows.map(({ rowAuthorityDigest }) => rowAuthorityDigest), context, ["rows"]);
  for (const [field, entries] of [
    ["upstreamRowIndex", value.rows.map(({ upstreamRowIndex }) => String(upstreamRowIndex).padStart(4, "0"))],
    ["sentenceId", value.rows.map(({ sentenceIdDigest }) => sentenceIdDigest)],
  ] as const) {
    if (new Set(entries).size !== T2A_TUDA_DEV_ROWS) {
      context.addIssue({ code: "custom", path: ["rows"], message: `${field} must be unique in dev` });
    }
  }
  const indexes = value.rows.map(({ upstreamRowIndex }) => upstreamRowIndex).sort((a, b) => a - b);
  if (!indexes.every((item, index) => item === index)) {
    context.addIssue({ code: "custom", path: ["rows"], message: "dev indexes must cover 0..1084" });
  }
});

export type T2aTudaDevInventory = z.infer<typeof t2aTudaDevInventorySchema>;

export function createT2aTudaDevInventory(options: {
  authority: T2aTudaAuthority;
  rows: readonly T2aTudaDevRow[];
}): T2aTudaDevInventory {
  const authority = t2aTudaAuthoritySchema.parse(options.authority);
  const rows = [...options.rows].sort((left, right) =>
    left.rowAuthorityDigest.localeCompare(right.rowAuthorityDigest));
  if (rows.some((row) => row.normalizationPolicyDigest
      !== authority.bindings.normalizationPolicyDigest
    || row.g2pDigest !== authority.bindings.g2pDigest
    || row.adjudicatorDigest !== authority.bindings.adjudicatorDigest)) {
    throw new Error("TUDA dev row evaluator authority binding mismatch");
  }
  return t2aTudaDevInventorySchema.parse({
    schemaVersion: T2A_TUDA_DEV_INVENTORY_VERSION,
    authorityDigest: t2aTudaAuthorityDigest(authority),
    evidenceMode: "synthetic-contract-test-only-not-dataset-evidence",
    split: "dev",
    rows,
  });
}

export function t2aTudaDevInventoryDigest(raw: unknown): string {
  return digestCanonical(t2aTudaDevInventorySchema.parse(raw));
}

export const t2aTudaPreregistrationSchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_PREREGISTRATION_VERSION),
  preregistrationId: identifierSchema,
  authorityDigest: sha256Schema,
  devRows: z.literal(T2A_TUDA_DEV_ROWS),
  testRowsDeclaredByCard: z.literal(T2A_TUDA_TEST_ROWS),
  devCalibration: z.object({
    positiveCases: z.literal(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
    negativeCases: z.literal(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
    microphoneArmSelection: z.literal("sha256-rank-one-arm-per-sentence.v1"),
    sentenceSelection: z.literal(
      "sha256-ranked-transitive-component-subset-sum-exact-300.v1",
    ),
    negativePairing: z.literal("first-valid-hash-cyclic-bijective-derangement.v1"),
    observedAudioOrModelScoreSelection: z.literal("forbidden"),
    maximumDurationMilliseconds: z.literal(T2A_TUDA_MAXIMUM_DURATION_MS),
  }).strict(),
  futureSealedTest: z.object({
    requiredPositiveCases: z.literal(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
    requiredNegativeCases: z.literal(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
    currentState: z.literal("not-provisioned-zero-access"),
    exactlyOnce: z.literal(true),
    releasePrerequisite: z.literal("future-detached-signature-plus-sealed-cas-release"),
    testTranscriptUseAsDevNegative: z.literal("forbidden"),
    testBytesRead: z.literal(0),
  }).strict(),
  leakagePolicy: z.object({
    component: z.literal("transitive-speaker-id-and-sentence-id"),
    devTestSpeakerOverlap: z.null(),
    devTestSentenceOverlap: z.null(),
    officialDatasetDesignExpectation: z.literal(
      "zero-speaker-and-sentence-overlap-to-be-verified-after-sealed-release",
    ),
    verificationState: z.literal("not-provisioned-no-claim"),
  }).strict(),
  bindings: tudaBindingsSchema,
  authorityProvisioning: z.literal("contract-draft-not-runtime-authorized"),
}).strict();

export type T2aTudaPreregistration = z.infer<typeof t2aTudaPreregistrationSchema>;

export function createT2aTudaPreregistration(options: {
  authority: T2aTudaAuthority;
  preregistrationId: string;
}): T2aTudaPreregistration {
  const authority = t2aTudaAuthoritySchema.parse(options.authority);
  return t2aTudaPreregistrationSchema.parse({
    schemaVersion: T2A_TUDA_PREREGISTRATION_VERSION,
    preregistrationId: options.preregistrationId,
    authorityDigest: t2aTudaAuthorityDigest(authority),
    devRows: T2A_TUDA_DEV_ROWS,
    testRowsDeclaredByCard: T2A_TUDA_TEST_ROWS,
    devCalibration: {
      positiveCases: T2A_TUDA_CALIBRATION_CASES_PER_CLASS,
      negativeCases: T2A_TUDA_CALIBRATION_CASES_PER_CLASS,
      microphoneArmSelection: "sha256-rank-one-arm-per-sentence.v1",
      sentenceSelection: "sha256-ranked-transitive-component-subset-sum-exact-300.v1",
      negativePairing: "first-valid-hash-cyclic-bijective-derangement.v1",
      observedAudioOrModelScoreSelection: "forbidden",
      maximumDurationMilliseconds: T2A_TUDA_MAXIMUM_DURATION_MS,
    },
    futureSealedTest: {
      requiredPositiveCases: T2A_TUDA_CALIBRATION_CASES_PER_CLASS,
      requiredNegativeCases: T2A_TUDA_CALIBRATION_CASES_PER_CLASS,
      currentState: "not-provisioned-zero-access",
      exactlyOnce: true,
      releasePrerequisite: "future-detached-signature-plus-sealed-cas-release",
      testTranscriptUseAsDevNegative: "forbidden",
      testBytesRead: 0,
    },
    leakagePolicy: {
      component: "transitive-speaker-id-and-sentence-id",
      devTestSpeakerOverlap: null,
      devTestSentenceOverlap: null,
      officialDatasetDesignExpectation:
        "zero-speaker-and-sentence-overlap-to-be-verified-after-sealed-release",
      verificationState: "not-provisioned-no-claim",
    },
    bindings: authority.bindings,
    authorityProvisioning: "contract-draft-not-runtime-authorized",
  });
}

export function t2aTudaPreregistrationDigest(raw: unknown): string {
  return digestCanonical(t2aTudaPreregistrationSchema.parse(raw));
}

type TrustedKeyPolicy = z.infer<typeof trustedKeyPolicySchema>;
type DetachedSignature = z.infer<typeof detachedSignatureSchema>;

function verifyTudaSignature(options: {
  authority: T2aTudaAuthority;
  document: unknown;
  signature: unknown;
  trustPolicy: TrustedKeyPolicy;
  keyId: string;
  role: "evaluation-authorizer" | "holdout-scorer" | "qualification-attestor";
  now: Date;
}): DetachedSignature {
  const authority = t2aTudaAuthoritySchema.parse(options.authority);
  const policy = trustedKeyPolicySchema.parse(options.trustPolicy);
  if (digestCanonical(policy) !== authority.trustPolicyDigest) {
    throw new Error("TUDA trust policy is not bound by the dataset authority");
  }
  const signature = detachedSignatureSchema.parse(options.signature);
  if (signature.keyId !== options.keyId) throw new Error("TUDA signature key binding mismatch");
  verifyDetachedSignature(options.document, signature, policy, options.role, options.now);
  return signature;
}

export function verifyT2aTudaPreregistration(options: {
  authority: T2aTudaAuthority;
  preregistration: T2aTudaPreregistration;
  signature: unknown;
  trustPolicy: TrustedKeyPolicy;
  now: Date;
}): T2aTudaPreregistration {
  const authority = t2aTudaAuthoritySchema.parse(options.authority);
  const preregistration = t2aTudaPreregistrationSchema.parse(options.preregistration);
  if (preregistration.authorityDigest !== t2aTudaAuthorityDigest(authority)
    || !sameCanonical(preregistration.bindings, authority.bindings)) {
    throw new Error("TUDA preregistration authority binding mismatch");
  }
  verifyTudaSignature({
    authority,
    document: preregistration,
    signature: options.signature,
    trustPolicy: options.trustPolicy,
    keyId: authority.evaluationAuthorizerKeyId,
    role: "evaluation-authorizer",
    now: options.now,
  });
  return preregistration;
}

const leakageGroupSchema = z.object({
  groupId: sha256Schema,
  memberRowDigests: z.array(sha256Schema).min(1),
  speakerDigests: z.array(sha256Schema).min(1),
  sentenceDigests: z.array(sha256Schema).min(1),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssue(value.memberRowDigests, context, ["memberRowDigests"]);
  addSortedUniqueIssue(value.speakerDigests, context, ["speakerDigests"]);
  addSortedUniqueIssue(value.sentenceDigests, context, ["sentenceDigests"]);
});

export const t2aTudaLeakageManifestSchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_LEAKAGE_VERSION),
  inventoryDigest: sha256Schema,
  groupingRuleDigest: sha256Schema,
  leakageRuleDigest: sha256Schema,
  groups: z.array(leakageGroupSchema).min(1).max(T2A_TUDA_DEV_ROWS),
  futureTestEvidence: z.object({
    status: z.literal("not-provisioned"),
    commitmentRoot: z.null(),
    speakerOverlapCount: z.null(),
    sentenceOverlapCount: z.null(),
    testRowsDisclosed: z.literal(0),
    testBytesRead: z.literal(0),
  }).strict(),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssue(value.groups.map(({ groupId }) => groupId), context, ["groups"]);
  const members = value.groups.flatMap(({ memberRowDigests }) => memberRowDigests);
  if (members.length !== T2A_TUDA_DEV_ROWS || new Set(members).size !== T2A_TUDA_DEV_ROWS) {
    context.addIssue({ code: "custom", path: ["groups"], message: "groups must partition dev exactly" });
  }
});

export type T2aTudaLeakageManifest = z.infer<typeof t2aTudaLeakageManifestSchema>;

function computeTudaLeakageGroups(
  inventory: T2aTudaDevInventory,
  groupingRuleDigest: string,
): z.infer<typeof leakageGroupSchema>[] {
  const parents = inventory.rows.map((_, index) => index);
  const find = (input: number): number => {
    let value = input;
    while (parents[value] !== value) {
      parents[value] = parents[parents[value]!]!;
      value = parents[value]!;
    }
    return value;
  };
  const union = (left: number, right: number): void => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parents[Math.max(a, b)] = Math.min(a, b);
  };
  const owners = new Map<string, number>();
  inventory.rows.forEach((row, index) => {
    for (const key of [`speaker:${row.speakerIdDigest}`, `sentence:${row.sentenceIdDigest}`]) {
      const owner = owners.get(key);
      if (owner === undefined) owners.set(key, index);
      else union(owner, index);
    }
  });
  const components = new Map<number, T2aTudaDevRow[]>();
  inventory.rows.forEach((row, index) => {
    const root = find(index);
    components.set(root, [...(components.get(root) ?? []), row]);
  });
  return [...components.values()].map((rows) => {
    const memberRowDigests = rows.map(({ rowAuthorityDigest }) => rowAuthorityDigest).sort();
    const speakerDigests = [...new Set(rows.map(({ speakerIdDigest }) => speakerIdDigest))].sort();
    const sentenceDigests = [...new Set(rows.map(({ sentenceIdDigest }) => sentenceIdDigest))].sort();
    return {
      groupId: digestCanonical({
        schemaVersion: "ltx-studio-t2a-tuda-leakage-group.v1",
        groupingRuleDigest,
        memberRowDigests,
        speakerDigests,
        sentenceDigests,
      }),
      memberRowDigests,
      speakerDigests,
      sentenceDigests,
    };
  }).sort((left, right) => left.groupId.localeCompare(right.groupId));
}

export function createT2aTudaLeakageManifest(options: {
  authority: T2aTudaAuthority;
  inventory: T2aTudaDevInventory;
}): T2aTudaLeakageManifest {
  const authority = t2aTudaAuthoritySchema.parse(options.authority);
  const inventory = t2aTudaDevInventorySchema.parse(options.inventory);
  return t2aTudaLeakageManifestSchema.parse({
    schemaVersion: T2A_TUDA_LEAKAGE_VERSION,
    inventoryDigest: t2aTudaDevInventoryDigest(inventory),
    groupingRuleDigest: authority.bindings.groupingRuleDigest,
    leakageRuleDigest: authority.bindings.leakageRuleDigest,
    groups: computeTudaLeakageGroups(inventory, authority.bindings.groupingRuleDigest),
    futureTestEvidence: {
      status: "not-provisioned",
      commitmentRoot: null,
      speakerOverlapCount: null,
      sentenceOverlapCount: null,
      testRowsDisclosed: 0,
      testBytesRead: 0,
    },
  });
}

export function t2aTudaLeakageManifestDigest(raw: unknown): string {
  return digestCanonical(t2aTudaLeakageManifestSchema.parse(raw));
}

const selectedRowSchema = z.object({
  rowAuthorityDigest: sha256Schema,
  sentenceIdDigest: sha256Schema,
  speakerIdDigest: sha256Schema,
  microphoneDigest: sha256Schema,
  audioAuthorityDigest: sha256Schema,
  transcriptDigest: sha256Schema,
  ipaAuthorityDigest: sha256Schema,
  microphoneRank: sha256Schema,
  sentenceRank: sha256Schema,
  leakageGroupId: sha256Schema,
}).strict();

export const t2aTudaSelectionManifestSchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_SELECTION_VERSION),
  inventoryDigest: sha256Schema,
  leakageManifestDigest: sha256Schema,
  selectionSeed: z.literal(T2A_TUDA_SELECTION_SEED),
  microphoneSeed: z.literal(T2A_TUDA_MICROPHONE_SEED),
  selected: z.array(selectedRowSchema).length(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
  reserve: z.array(selectedRowSchema).length(T2A_TUDA_DEV_ROWS - T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
  policy: z.object({
    oneMicrophoneArmPerSentence: z.literal(true),
    transitiveLeakageComponentsAtomic: z.literal(true),
    componentSelection: z.literal("sha256-ranked-suffix-subset-sum.v1"),
    exactCapacityOrFail: z.literal(true),
    audioOrModelScoreSelection: z.literal("forbidden"),
    replacementAfterScoring: z.literal("forbidden"),
  }).strict(),
  qualification: z.literal("contract-draft-provisional-ineligible"),
}).strict().superRefine((value, context) => {
  const all = [...value.selected, ...value.reserve];
  for (const field of [
    "rowAuthorityDigest",
    "sentenceIdDigest",
    "audioAuthorityDigest",
    "transcriptDigest",
  ] as const) {
    if (new Set(all.map((entry) => entry[field])).size !== T2A_TUDA_DEV_ROWS) {
      context.addIssue({ code: "custom", path: ["selected"], message: `${field} must be bijective` });
    }
  }
  if (!isSortedUnique(value.selected.map(({ sentenceRank, sentenceIdDigest }) =>
    `${sentenceRank}:${sentenceIdDigest}`))
    || !isSortedUnique(value.reserve.map(({ sentenceRank, sentenceIdDigest }) =>
      `${sentenceRank}:${sentenceIdDigest}`))) {
    context.addIssue({ code: "custom", path: ["selected"], message: "selection must be rank sorted" });
  }
  const selectedGroupIds = new Set(value.selected.map(({ leakageGroupId }) => leakageGroupId));
  if (value.reserve.some(({ leakageGroupId }) => selectedGroupIds.has(leakageGroupId))) {
    context.addIssue({
      code: "custom",
      path: ["selected"],
      message: "transitive leakage components must not cross selection and reserve",
    });
  }
});

export type T2aTudaSelectionManifest = z.infer<typeof t2aTudaSelectionManifestSchema>;

function selectAtomicTudaLeakageGroups(
  leakage: T2aTudaLeakageManifest,
): Set<string> {
  const target = T2A_TUDA_CALIBRATION_CASES_PER_CLASS;
  const rankedGroups = leakage.groups.map((group) => ({
    group,
    rank: digestCanonical({
      schemaVersion: "ltx-studio-t2a-tuda-component-rank.v1",
      seed: T2A_TUDA_SELECTION_SEED,
      groupId: group.groupId,
      memberRowDigests: group.memberRowDigests,
    }),
  })).sort((left, right) => left.rank.localeCompare(right.rank)
    || left.group.groupId.localeCompare(right.group.groupId));

  // Suffix reachability makes the ranked choice deterministic while refusing
  // to split a transitive speaker/sentence component to fill the 300-row cap.
  const reachable = Array.from(
    { length: rankedGroups.length + 1 },
    () => new Uint8Array(target + 1),
  );
  reachable[rankedGroups.length]![0] = 1;
  for (let index = rankedGroups.length - 1; index >= 0; index -= 1) {
    const size = rankedGroups[index]!.group.memberRowDigests.length;
    const current = reachable[index]!;
    const suffix = reachable[index + 1]!;
    for (let count = 0; count <= target; count += 1) {
      current[count] = suffix[count] === 1
        || (count >= size && suffix[count - size] === 1)
        ? 1
        : 0;
    }
  }
  if (reachable[0]![target] !== 1) {
    throw new Error(
      "TUDA transitive leakage components cannot fill exactly 300 rows without splitting",
    );
  }

  const selected = new Set<string>();
  let remaining: number = target;
  for (const [index, ranked] of rankedGroups.entries()) {
    const size = ranked.group.memberRowDigests.length;
    if (size <= remaining && reachable[index + 1]![remaining - size] === 1) {
      selected.add(ranked.group.groupId);
      remaining -= size;
    }
  }
  if (remaining !== 0) {
    throw new Error("TUDA atomic component selection failed its exact-capacity invariant");
  }
  return selected;
}

export function selectT2aTudaDevCalibration(options: {
  inventory: T2aTudaDevInventory;
  leakageManifest: T2aTudaLeakageManifest;
}): T2aTudaSelectionManifest {
  const inventory = t2aTudaDevInventorySchema.parse(options.inventory);
  const leakage = t2aTudaLeakageManifestSchema.parse(options.leakageManifest);
  const inventoryDigest = t2aTudaDevInventoryDigest(inventory);
  if (leakage.inventoryDigest !== inventoryDigest
    || !sameCanonical(leakage.groups, computeTudaLeakageGroups(inventory, leakage.groupingRuleDigest))) {
    throw new Error("TUDA transitive leakage manifest mismatch");
  }
  const groupByRow = new Map(leakage.groups.flatMap((group) =>
    group.memberRowDigests.map((rowDigest) => [rowDigest, group.groupId] as const)));
  const canonical = inventory.rows.map((row) => {
    const arms = row.microphoneArms.map((arm) => ({
      arm,
      rank: digestCanonical({
        schemaVersion: "ltx-studio-t2a-tuda-microphone-rank.v1",
        seed: T2A_TUDA_MICROPHONE_SEED,
        sentenceIdDigest: row.sentenceIdDigest,
        microphoneDigest: arm.microphoneDigest,
        audioAuthorityDigest: arm.audioAuthorityDigest,
      }),
    })).sort((left, right) => left.rank.localeCompare(right.rank)
      || left.arm.microphoneDigest.localeCompare(right.arm.microphoneDigest));
    const chosen = arms[0]!;
    return {
      rowAuthorityDigest: row.rowAuthorityDigest,
      sentenceIdDigest: row.sentenceIdDigest,
      speakerIdDigest: row.speakerIdDigest,
      microphoneDigest: chosen.arm.microphoneDigest,
      audioAuthorityDigest: chosen.arm.audioAuthorityDigest,
      transcriptDigest: row.cleanedSentenceDigest,
      ipaAuthorityDigest: row.ipaAuthorityDigest,
      microphoneRank: chosen.rank,
      sentenceRank: digestCanonical({
        schemaVersion: "ltx-studio-t2a-tuda-sentence-rank.v1",
        seed: T2A_TUDA_SELECTION_SEED,
        sentenceIdDigest: row.sentenceIdDigest,
        rowAuthorityDigest: row.rowAuthorityDigest,
      }),
      leakageGroupId: groupByRow.get(row.rowAuthorityDigest) ?? "",
    };
  }).sort((left, right) => left.sentenceRank.localeCompare(right.sentenceRank)
    || left.sentenceIdDigest.localeCompare(right.sentenceIdDigest));
  if (canonical.some(({ leakageGroupId }) => !sha256Schema.safeParse(leakageGroupId).success)) {
    throw new Error("TUDA selected row is missing its leakage component");
  }
  const selectedGroupIds = selectAtomicTudaLeakageGroups(leakage);
  const selected = canonical.filter(({ leakageGroupId }) => selectedGroupIds.has(leakageGroupId));
  const reserve = canonical.filter(({ leakageGroupId }) => !selectedGroupIds.has(leakageGroupId));
  if (selected.length !== T2A_TUDA_CALIBRATION_CASES_PER_CLASS
    || reserve.length !== T2A_TUDA_DEV_ROWS - T2A_TUDA_CALIBRATION_CASES_PER_CLASS) {
    throw new Error("TUDA atomic component selection violated exact row capacities");
  }
  return t2aTudaSelectionManifestSchema.parse({
    schemaVersion: T2A_TUDA_SELECTION_VERSION,
    inventoryDigest,
    leakageManifestDigest: t2aTudaLeakageManifestDigest(leakage),
    selectionSeed: T2A_TUDA_SELECTION_SEED,
    microphoneSeed: T2A_TUDA_MICROPHONE_SEED,
    selected,
    reserve,
    policy: {
      oneMicrophoneArmPerSentence: true,
      transitiveLeakageComponentsAtomic: true,
      componentSelection: "sha256-ranked-suffix-subset-sum.v1",
      exactCapacityOrFail: true,
      audioOrModelScoreSelection: "forbidden",
      replacementAfterScoring: "forbidden",
    },
    qualification: "contract-draft-provisional-ineligible",
  });
}

export function t2aTudaSelectionManifestDigest(raw: unknown): string {
  return digestCanonical(t2aTudaSelectionManifestSchema.parse(raw));
}

export const t2aTudaDifficultyBands = ["hard", "medium", "easy"] as const;

const tudaPairSchema = z.object({
  pairId: sha256Schema,
  sourceRowDigest: sha256Schema,
  referenceRowDigest: sha256Schema,
  audioAuthorityDigest: sha256Schema,
  ownTranscriptDigest: sha256Schema,
  foreignTranscriptDigest: sha256Schema,
  ownIpaDigest: sha256Schema,
  foreignIpaDigest: sha256Schema,
  ipaEditDistance: z.number().int().positive().max(512),
  maximumIpaLength: z.number().int().positive().max(512),
  difficultyBand: z.enum(t2aTudaDifficultyBands),
}).strict();

export const t2aTudaCaseManifestSchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_CASE_MANIFEST_VERSION),
  inventoryDigest: sha256Schema,
  selectionManifestDigest: sha256Schema,
  pairingSeed: z.literal(T2A_TUDA_PAIRING_SEED),
  positiveCaseIds: z.array(sha256Schema).length(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
  negativeCaseIds: z.array(sha256Schema).length(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
  pairs: z.array(tudaPairSchema).length(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
  audioMarginalDigests: z.array(sha256Schema).length(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
  transcriptMarginalDigests: z.array(sha256Schema).length(T2A_TUDA_CALIBRATION_CASES_PER_CLASS),
  assignment: z.literal("authentic-dev-transcript-bijective-derangement"),
  syntheticTranscriptMutation: z.literal("forbidden"),
  qualification: z.literal("contract-draft-not-holdout-qualified"),
}).strict().superRefine((value, context) => {
  for (const [path, values] of [
    ["positiveCaseIds", value.positiveCaseIds],
    ["negativeCaseIds", value.negativeCaseIds],
    ["audioMarginalDigests", value.audioMarginalDigests],
    ["transcriptMarginalDigests", value.transcriptMarginalDigests],
    ["pairs", value.pairs.map(({ pairId }) => pairId)],
  ] as const) addSortedUniqueIssue(values, context, [path]);
  if (value.negativeCaseIds.some((id) => value.positiveCaseIds.includes(id))) {
    context.addIssue({ code: "custom", path: ["negativeCaseIds"], message: "case ids must be disjoint" });
  }
  if (new Set(value.pairs.map(({ sourceRowDigest }) => sourceRowDigest)).size !== 300
    || new Set(value.pairs.map(({ referenceRowDigest }) => referenceRowDigest)).size !== 300
    || value.pairs.some((pair) => pair.sourceRowDigest === pair.referenceRowDigest)) {
    context.addIssue({ code: "custom", path: ["pairs"], message: "references must be a derangement" });
  }
  const pairAudio = value.pairs.map(({ audioAuthorityDigest }) => audioAuthorityDigest).sort();
  const ownTranscripts = value.pairs.map(({ ownTranscriptDigest }) => ownTranscriptDigest).sort();
  const foreignTranscripts = value.pairs.map(({ foreignTranscriptDigest }) => foreignTranscriptDigest).sort();
  if (!sameCanonical(pairAudio, value.audioMarginalDigests)
    || !sameCanonical(ownTranscripts, value.transcriptMarginalDigests)
    || !sameCanonical(foreignTranscripts, value.transcriptMarginalDigests)) {
    context.addIssue({
      code: "custom",
      path: ["pairs"],
      message: "audio and authentic transcript marginals must be exactly bijective",
    });
  }
  for (const band of t2aTudaDifficultyBands) {
    if (value.pairs.filter(({ difficultyBand }) => difficultyBand === band).length !== 100) {
      context.addIssue({ code: "custom", path: ["pairs"], message: `${band} must contain 100 cases` });
    }
  }
});

export type T2aTudaCaseManifest = z.infer<typeof t2aTudaCaseManifestSchema>;

function levenshtein(left: readonly string[], right: readonly string[]): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      current.push(Math.min(
        previous[rightIndex + 1]! + 1,
        current[rightIndex]! + 1,
        previous[rightIndex]! + (left[leftIndex] === right[rightIndex] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[right.length]!;
}

export function createT2aTudaCaseManifest(options: {
  inventory: T2aTudaDevInventory;
  selectionManifest: T2aTudaSelectionManifest;
}): T2aTudaCaseManifest {
  const inventory = t2aTudaDevInventorySchema.parse(options.inventory);
  const selection = t2aTudaSelectionManifestSchema.parse(options.selectionManifest);
  const inventoryDigest = t2aTudaDevInventoryDigest(inventory);
  if (selection.inventoryDigest !== inventoryDigest) throw new Error("TUDA case inventory mismatch");
  const selectionManifestDigest = t2aTudaSelectionManifestDigest(selection);
  const rowByDigest = new Map(inventory.rows.map((row) => [row.rowAuthorityDigest, row]));
  const ordered = selection.selected.map((entry) => ({
    entry,
    row: rowByDigest.get(entry.rowAuthorityDigest),
    rank: digestCanonical({
      schemaVersion: "ltx-studio-t2a-tuda-pair-order.v1",
      seed: T2A_TUDA_PAIRING_SEED,
      selectionManifestDigest,
      rowAuthorityDigest: entry.rowAuthorityDigest,
    }),
  })).sort((left, right) => left.rank.localeCompare(right.rank));
  if (ordered.some(({ row }) => !row)) throw new Error("TUDA selected row absent from inventory");
  const offsets = Array.from({ length: 299 }, (_, index) => index + 1).sort((left, right) => {
    const rank = (offset: number) => digestCanonical({
      schemaVersion: "ltx-studio-t2a-tuda-pair-offset.v1",
      seed: T2A_TUDA_PAIRING_SEED,
      selectionManifestDigest,
      offset,
    });
    return rank(left).localeCompare(rank(right)) || left - right;
  });
  const offset = offsets.find((candidate) => ordered.every((source, index) => {
    const reference = ordered[(index + candidate) % ordered.length]!;
    return source.entry.rowAuthorityDigest !== reference.entry.rowAuthorityDigest
      && source.entry.transcriptDigest !== reference.entry.transcriptDigest
      && source.entry.ipaAuthorityDigest !== reference.entry.ipaAuthorityDigest;
  }));
  if (offset === undefined) throw new Error("TUDA selected rows admit no authentic transcript derangement");
  type WorkingPair = Omit<z.infer<typeof tudaPairSchema>, "difficultyBand">;
  const working: WorkingPair[] = ordered.map((source, index) => {
    const reference = ordered[(index + offset) % ordered.length]!;
    const sourceRow = source.row!;
    const referenceRow = reference.row!;
    const ipaEditDistance = levenshtein(sourceRow.ipaTokens, referenceRow.ipaTokens);
    if (ipaEditDistance < 1) throw new Error("TUDA negative has zero IPA distance");
    const body = {
      sourceRowDigest: source.entry.rowAuthorityDigest,
      referenceRowDigest: reference.entry.rowAuthorityDigest,
      audioAuthorityDigest: source.entry.audioAuthorityDigest,
      ownTranscriptDigest: source.entry.transcriptDigest,
      foreignTranscriptDigest: reference.entry.transcriptDigest,
      ownIpaDigest: source.entry.ipaAuthorityDigest,
      foreignIpaDigest: reference.entry.ipaAuthorityDigest,
      ipaEditDistance,
      maximumIpaLength: Math.max(sourceRow.ipaTokens.length, referenceRow.ipaTokens.length),
    };
    return {
      pairId: digestCanonical({ schemaVersion: "ltx-studio-t2a-tuda-pair.v1", ...body }),
      ...body,
    };
  });
  working.sort((left, right) =>
    left.ipaEditDistance * right.maximumIpaLength
      - right.ipaEditDistance * left.maximumIpaLength
    || left.pairId.localeCompare(right.pairId));
  const pairs = working.map((pair, index) => ({
    ...pair,
    difficultyBand: t2aTudaDifficultyBands[Math.floor(index / 100)]!,
  })).sort((left, right) => left.pairId.localeCompare(right.pairId));
  const positiveCaseIds = pairs.map((pair) => digestCanonical({
    schemaVersion: "ltx-studio-t2a-tuda-positive.v1",
    audioAuthorityDigest: pair.audioAuthorityDigest,
    transcriptDigest: pair.ownTranscriptDigest,
  })).sort();
  const negativeCaseIds = pairs.map((pair) => digestCanonical({
    schemaVersion: "ltx-studio-t2a-tuda-negative.v1",
    pairId: pair.pairId,
    audioAuthorityDigest: pair.audioAuthorityDigest,
    transcriptDigest: pair.foreignTranscriptDigest,
  })).sort();
  return t2aTudaCaseManifestSchema.parse({
    schemaVersion: T2A_TUDA_CASE_MANIFEST_VERSION,
    inventoryDigest,
    selectionManifestDigest,
    pairingSeed: T2A_TUDA_PAIRING_SEED,
    positiveCaseIds,
    negativeCaseIds,
    pairs,
    audioMarginalDigests: pairs.map(({ audioAuthorityDigest }) => audioAuthorityDigest).sort(),
    transcriptMarginalDigests: pairs.map(({ ownTranscriptDigest }) => ownTranscriptDigest).sort(),
    assignment: "authentic-dev-transcript-bijective-derangement",
    syntheticTranscriptMutation: "forbidden",
    qualification: "contract-draft-not-holdout-qualified",
  });
}

export function t2aTudaCaseManifestDigest(raw: unknown): string {
  return digestCanonical(t2aTudaCaseManifestSchema.parse(raw));
}

export function verifyT2aTudaMaterialization(options: {
  authority: T2aTudaAuthority;
  inventory: T2aTudaDevInventory;
  leakageManifest: T2aTudaLeakageManifest;
  selectionManifest: T2aTudaSelectionManifest;
  caseManifest: T2aTudaCaseManifest;
}): void {
  const authority = t2aTudaAuthoritySchema.parse(options.authority);
  const inventory = t2aTudaDevInventorySchema.parse(options.inventory);
  if (inventory.authorityDigest !== t2aTudaAuthorityDigest(authority)) {
    throw new Error("TUDA inventory authority mismatch");
  }
  const expectedLeakage = createT2aTudaLeakageManifest({ authority, inventory });
  if (!sameCanonical(expectedLeakage, options.leakageManifest)) {
    throw new Error("TUDA leakage materialization mismatch");
  }
  const expectedSelection = selectT2aTudaDevCalibration({
    inventory,
    leakageManifest: expectedLeakage,
  });
  if (!sameCanonical(expectedSelection, options.selectionManifest)) {
    throw new Error("TUDA deterministic microphone/sentence selection mismatch");
  }
  const expectedCases = createT2aTudaCaseManifest({
    inventory,
    selectionManifest: expectedSelection,
  });
  if (!sameCanonical(expectedCases, options.caseManifest)) {
    throw new Error("TUDA deterministic case derangement mismatch");
  }
}

export const t2aTudaRunAuthorizationSchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_RUN_AUTHORIZATION_VERSION),
  authorizationId: identifierSchema,
  authorityDigest: sha256Schema,
  preregistrationDigest: sha256Schema,
  inventoryDigest: sha256Schema,
  leakageManifestDigest: sha256Schema,
  selectionManifestDigest: sha256Schema,
  caseManifestDigest: sha256Schema,
  combinedEvaluatorDigest: sha256Schema,
  scorerDigest: sha256Schema,
  adjudicatorDigest: sha256Schema,
  ledgerAuthorityDigest: sha256Schema,
  runScope: z.literal("dev-calibration-contract-draft"),
  testSplitCapability: z.literal("none"),
  testBytesAuthorized: z.literal(0),
  nonce: z.string().regex(/^[0-9a-f]{64}$/u),
  transactionId: uuidSchema,
  issuedAt: timestampSchema,
  notBefore: timestampSchema,
  startBy: timestampSchema,
  completeBy: timestampSchema,
  maximumPrivateInputBytes: z.number().int().positive().max(T2A_TUDA_MAXIMUM_PRIVATE_INPUT_BYTES),
  exactlyOnce: z.literal(true),
}).strict().superRefine((value, context) => {
  const issued = Date.parse(value.issuedAt);
  const notBefore = Date.parse(value.notBefore);
  const startBy = Date.parse(value.startBy);
  const completeBy = Date.parse(value.completeBy);
  if (!(issued <= notBefore && notBefore <= startBy && startBy <= completeBy)
    || startBy - notBefore > 10 * 60 * 1_000
    || completeBy - notBefore > T2A_TUDA_MAXIMUM_RUNTIME_MS) {
    context.addIssue({ code: "custom", path: ["completeBy"], message: "authorization window invalid" });
  }
});

export type T2aTudaRunAuthorization = z.infer<typeof t2aTudaRunAuthorizationSchema>;

export function t2aTudaRunAuthorizationDigest(raw: unknown): string {
  return digestCanonical(t2aTudaRunAuthorizationSchema.parse(raw));
}

export function verifyT2aTudaRunAuthorization(options: {
  authority: T2aTudaAuthority;
  preregistration: T2aTudaPreregistration;
  preregistrationSignature: unknown;
  authorization: T2aTudaRunAuthorization;
  authorizationSignature: unknown;
  trustPolicy: TrustedKeyPolicy;
  materialization: {
    inventory: T2aTudaDevInventory;
    leakageManifest: T2aTudaLeakageManifest;
    selectionManifest: T2aTudaSelectionManifest;
    caseManifest: T2aTudaCaseManifest;
  };
  now: Date;
}): T2aTudaRunAuthorization {
  const authority = t2aTudaAuthoritySchema.parse(options.authority);
  const preregistration = verifyT2aTudaPreregistration({
    authority,
    preregistration: options.preregistration,
    signature: options.preregistrationSignature,
    trustPolicy: options.trustPolicy,
    now: options.now,
  });
  verifyT2aTudaMaterialization({ authority, ...options.materialization });
  const authorization = t2aTudaRunAuthorizationSchema.parse(options.authorization);
  const expected = {
    authorityDigest: t2aTudaAuthorityDigest(authority),
    preregistrationDigest: t2aTudaPreregistrationDigest(preregistration),
    inventoryDigest: t2aTudaDevInventoryDigest(options.materialization.inventory),
    leakageManifestDigest: t2aTudaLeakageManifestDigest(options.materialization.leakageManifest),
    selectionManifestDigest: t2aTudaSelectionManifestDigest(options.materialization.selectionManifest),
    caseManifestDigest: t2aTudaCaseManifestDigest(options.materialization.caseManifest),
  };
  if (authorization.authorityDigest !== expected.authorityDigest
    || authorization.preregistrationDigest !== expected.preregistrationDigest
    || authorization.inventoryDigest !== expected.inventoryDigest
    || authorization.leakageManifestDigest !== expected.leakageManifestDigest
    || authorization.selectionManifestDigest !== expected.selectionManifestDigest
    || authorization.caseManifestDigest !== expected.caseManifestDigest
    || authorization.combinedEvaluatorDigest !== authority.bindings.combinedEvaluatorDigest
    || authorization.scorerDigest !== authority.bindings.scorerDigest
    || authorization.adjudicatorDigest !== authority.bindings.adjudicatorDigest
    || authorization.ledgerAuthorityDigest !== authority.bindings.ledgerAuthorityDigest
    || options.now.getTime() < Date.parse(authorization.notBefore)
    || options.now.getTime() > Date.parse(authorization.completeBy)) {
    throw new Error("TUDA run authorization binding or time mismatch");
  }
  verifyTudaSignature({
    authority,
    document: authorization,
    signature: options.authorizationSignature,
    trustPolicy: options.trustPolicy,
    keyId: authority.evaluationAuthorizerKeyId,
    role: "evaluation-authorizer",
    now: options.now,
  });
  return authorization;
}

export const t2aTudaLedgerReceiptSchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_LEDGER_RECEIPT_VERSION),
  receiptId: uuidSchema,
  authorizationDigest: sha256Schema,
  authorizationNonce: z.string().regex(/^[0-9a-f]{64}$/u),
  transactionId: uuidSchema,
  ledgerAuthorityDigest: sha256Schema,
  sequence: z.number().int().min(0).max(2),
  previousReceiptDigest: sha256Schema.nullable(),
  state: z.enum(["reserved", "consumed", "terminal"]),
  privateInputBytesRead: z.number().int().nonnegative().max(T2A_TUDA_MAXIMUM_PRIVATE_INPUT_BYTES),
  outcome: z.enum(["passed", "failed", "infrastructure_aborted", "deadline"]).nullable(),
  outputDigest: sha256Schema.nullable(),
  recordedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if ((value.sequence === 0) !== (value.previousReceiptDigest === null)
    || (value.state === "reserved") !== (value.sequence === 0)
    || (value.state === "consumed" && value.sequence !== 1)
    || (value.state === "terminal" && value.sequence === 0)
    || (value.state === "terminal") !== (value.outcome !== null)
    || (value.outcome === "passed") !== (value.outputDigest !== null)
    || (value.state === "reserved" && value.privateInputBytesRead !== 0)
    || (value.state === "consumed" && value.privateInputBytesRead < 1)) {
    context.addIssue({ code: "custom", path: ["state"], message: "ledger receipt state is inconsistent" });
  }
});

export type T2aTudaLedgerReceipt = z.infer<typeof t2aTudaLedgerReceiptSchema>;

export function t2aTudaLedgerReceiptDigest(raw: unknown): string {
  return digestCanonical(t2aTudaLedgerReceiptSchema.parse(raw));
}

export const t2aTudaReplayHeadSchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_REPLAY_HEAD_VERSION),
  authorizationDigest: sha256Schema,
  authorizationNonce: z.string().regex(/^[0-9a-f]{64}$/u),
  transactionId: uuidSchema,
  ledgerAuthorityDigest: sha256Schema,
  currentHeadDigest: sha256Schema,
  generation: z.number().int().min(1).max(3),
  terminal: z.boolean(),
  observedAt: timestampSchema,
}).strict();

export type T2aTudaReplayHead = z.infer<typeof t2aTudaReplayHeadSchema>;

export function verifyT2aTudaCasReplayChain(options: {
  authority: T2aTudaAuthority;
  authorization: T2aTudaRunAuthorization;
  receipts: readonly { document: unknown; signature: unknown }[];
  replayHead: unknown;
  replayHeadSignature: unknown;
  trustPolicy: TrustedKeyPolicy;
  now: Date;
}): T2aTudaLedgerReceipt[] {
  const authority = t2aTudaAuthoritySchema.parse(options.authority);
  const authorization = t2aTudaRunAuthorizationSchema.parse(options.authorization);
  if (options.receipts.length < 1 || options.receipts.length > 3) {
    throw new Error("TUDA CAS chain must contain one to three signed receipts");
  }
  const authorizationDigest = t2aTudaRunAuthorizationDigest(authorization);
  const receipts: T2aTudaLedgerReceipt[] = [];
  for (const [index, envelope] of options.receipts.entries()) {
    const receipt = t2aTudaLedgerReceiptSchema.parse(envelope.document);
    const previous = receipts[index - 1];
    if (receipt.sequence !== index
      || receipt.previousReceiptDigest !== (previous ? t2aTudaLedgerReceiptDigest(previous) : null)
      || receipt.authorizationDigest !== authorizationDigest
      || receipt.authorizationNonce !== authorization.nonce
      || receipt.transactionId !== authorization.transactionId
      || receipt.ledgerAuthorityDigest !== authority.bindings.ledgerAuthorityDigest
      || (previous && receipt.privateInputBytesRead < previous.privateInputBytesRead)
      || (previous && Date.parse(receipt.recordedAt) < Date.parse(previous.recordedAt))
      || receipt.privateInputBytesRead > authorization.maximumPrivateInputBytes) {
      throw new Error(`TUDA CAS receipt ${index} binding mismatch`);
    }
    if (index === 0 && (Date.parse(receipt.recordedAt) < Date.parse(authorization.notBefore)
      || Date.parse(receipt.recordedAt) > Date.parse(authorization.startBy))) {
      throw new Error("TUDA CAS reservation is outside the start window");
    }
    if (receipt.outcome === "deadline") {
      if (Date.parse(receipt.recordedAt) < Date.parse(authorization.completeBy)) {
        throw new Error("TUDA deadline receipt precedes completeBy");
      }
    } else if (Date.parse(receipt.recordedAt) > Date.parse(authorization.completeBy)) {
      throw new Error("TUDA CAS receipt crossed completeBy");
    }
    if (receipt.state === "terminal" && previous?.state === "reserved"
      && (receipt.privateInputBytesRead !== 0 || receipt.outcome === "passed")) {
      throw new Error("TUDA private bytes require a durable consumed receipt first");
    }
    verifyTudaSignature({
      authority,
      document: receipt,
      signature: envelope.signature,
      trustPolicy: options.trustPolicy,
      keyId: authority.ledgerKeyId,
      role: "qualification-attestor",
      now: options.now,
    });
    receipts.push(receipt);
  }
  const replayHead = t2aTudaReplayHeadSchema.parse(options.replayHead);
  verifyTudaSignature({
    authority,
    document: replayHead,
    signature: options.replayHeadSignature,
    trustPolicy: options.trustPolicy,
    keyId: authority.ledgerKeyId,
    role: "qualification-attestor",
    now: options.now,
  });
  const last = receipts.at(-1)!;
  if (replayHead.authorizationDigest !== authorizationDigest
    || replayHead.authorizationNonce !== authorization.nonce
    || replayHead.transactionId !== authorization.transactionId
    || replayHead.ledgerAuthorityDigest !== authority.bindings.ledgerAuthorityDigest
    || replayHead.currentHeadDigest !== t2aTudaLedgerReceiptDigest(last)
    || replayHead.generation !== receipts.length
    || replayHead.terminal !== (last.state === "terminal")
    || Date.parse(replayHead.observedAt) < Date.parse(last.recordedAt)
    || Date.parse(replayHead.observedAt) > options.now.getTime()) {
    throw new Error("TUDA authoritative replay head rejects fork, truncation, or replay");
  }
  return receipts;
}

const caseScoreSchema = z.object({
  caseId: sha256Schema,
  scorePpm: z.number().int().min(0).max(T2A_TUDA_SCORE_SCALE),
}).strict();

const scoreCoreSchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_SCORE_REPORT_VERSION),
  authorizationDigest: sha256Schema,
  caseManifestDigest: sha256Schema,
  combinedEvaluatorDigest: sha256Schema,
  scorerDigest: sha256Schema,
  adjudicatorDigest: sha256Schema,
  scope: z.literal("dev-calibration-contract-draft"),
  testBytesRead: z.literal(0),
  scores: z.array(caseScoreSchema).length(T2A_TUDA_TOTAL_CALIBRATION_CASES),
}).strict();

export const t2aTudaScoreReportSchema = scoreCoreSchema.extend({
  receiptHeadDigest: sha256Schema,
}).strict().superRefine((value, context) => {
  addSortedUniqueIssue(value.scores.map(({ caseId }) => caseId), context, ["scores"]);
});

export type T2aTudaScoreReport = z.infer<typeof t2aTudaScoreReportSchema>;

export function t2aTudaScorePayloadDigest(raw: unknown): string {
  const report = t2aTudaScoreReportSchema.parse(raw);
  const { receiptHeadDigest: _head, ...core } = report;
  void _head;
  return digestCanonical(scoreCoreSchema.parse(core));
}

export const t2aTudaCalibrationReportSchema = z.object({
  schemaVersion: z.literal(T2A_TUDA_CALIBRATION_REPORT_VERSION),
  authorizationDigest: sha256Schema,
  caseManifestDigest: sha256Schema,
  scoreReportDigest: sha256Schema,
  receiptHeadDigest: sha256Schema,
  status: z.enum(["provisional-ineligible", "calibration-failed"]),
  thresholdPpm: z.number().int().min(0).max(T2A_TUDA_SCORE_SCALE).nullable(),
  trueAccepts: z.number().int().min(0).max(300),
  falseRejects: z.number().int().min(0).max(300),
  trueRejects: z.number().int().min(0).max(300),
  falseAccepts: z.number().int().min(0).max(300),
  authorityStatus: z.literal("not-provisioned-contract-draft"),
  cryptographicEnvelopeStatus: z.literal("verified-under-uninstalled-self-bound-test-policy"),
  casReplayStatus: z.literal("signed-chain-and-replay-head-verified"),
  datasetEvidenceStatus: z.literal("synthetic-contract-test-only"),
  testSplitStatus: z.literal("unopened-zero-bytes-not-provisioned"),
  calibrationQualification: z.literal("not-calibrated"),
  holdoutQualification: z.literal("not-qualified"),
}).strict().superRefine((value, context) => {
  if (value.trueAccepts + value.falseRejects !== 300
    || value.trueRejects + value.falseAccepts !== 300
    || (value.status === "provisional-ineligible") !== (value.thresholdPpm !== null)) {
    context.addIssue({ code: "custom", path: ["status"], message: "calibration counts/status mismatch" });
  }
});

export type T2aTudaCalibrationReport = z.infer<typeof t2aTudaCalibrationReportSchema>;

export function calibrateT2aTudaDevThreshold(options: {
  authority: T2aTudaAuthority;
  preregistration: T2aTudaPreregistration;
  preregistrationSignature: unknown;
  materialization: {
    inventory: T2aTudaDevInventory;
    leakageManifest: T2aTudaLeakageManifest;
    selectionManifest: T2aTudaSelectionManifest;
    caseManifest: T2aTudaCaseManifest;
  };
  authorization: T2aTudaRunAuthorization;
  authorizationSignature: unknown;
  receipts: readonly { document: unknown; signature: unknown }[];
  replayHead: unknown;
  replayHeadSignature: unknown;
  scoreReport: unknown;
  scoreReportSignature: unknown;
  trustPolicy: TrustedKeyPolicy;
  now: Date;
}): T2aTudaCalibrationReport {
  const authority = t2aTudaAuthoritySchema.parse(options.authority);
  const authorization = verifyT2aTudaRunAuthorization({
    authority,
    preregistration: options.preregistration,
    preregistrationSignature: options.preregistrationSignature,
    authorization: options.authorization,
    authorizationSignature: options.authorizationSignature,
    trustPolicy: options.trustPolicy,
    materialization: options.materialization,
    now: options.now,
  });
  const receipts = verifyT2aTudaCasReplayChain({
    authority,
    authorization,
    receipts: options.receipts,
    replayHead: options.replayHead,
    replayHeadSignature: options.replayHeadSignature,
    trustPolicy: options.trustPolicy,
    now: options.now,
  });
  const terminal = receipts.at(-1)!;
  if (terminal.state !== "terminal" || terminal.outcome !== "passed") {
    throw new Error("TUDA score calibration requires a passed authoritative terminal receipt");
  }
  const scoreReport = t2aTudaScoreReportSchema.parse(options.scoreReport);
  verifyTudaSignature({
    authority,
    document: scoreReport,
    signature: options.scoreReportSignature,
    trustPolicy: options.trustPolicy,
    keyId: authority.scorerKeyId,
    role: "holdout-scorer",
    now: options.now,
  });
  const authorizationDigest = t2aTudaRunAuthorizationDigest(authorization);
  const caseManifestDigest = t2aTudaCaseManifestDigest(options.materialization.caseManifest);
  if (scoreReport.authorizationDigest !== authorizationDigest
    || scoreReport.caseManifestDigest !== caseManifestDigest
    || scoreReport.combinedEvaluatorDigest !== authority.bindings.combinedEvaluatorDigest
    || scoreReport.scorerDigest !== authority.bindings.scorerDigest
    || scoreReport.adjudicatorDigest !== authority.bindings.adjudicatorDigest
    || scoreReport.receiptHeadDigest !== t2aTudaLedgerReceiptDigest(terminal)
    || terminal.outputDigest !== t2aTudaScorePayloadDigest(scoreReport)) {
    throw new Error("TUDA signed score report is not bound to authorization and terminal output");
  }
  const cases = options.materialization.caseManifest;
  const expectedIds = [...cases.positiveCaseIds, ...cases.negativeCaseIds].sort();
  if (!sameCanonical(expectedIds, scoreReport.scores.map(({ caseId }) => caseId))) {
    throw new Error("TUDA signed score report does not cover the exact 600 preregistered cases");
  }
  const scoreById = new Map(scoreReport.scores.map(({ caseId, scorePpm }) => [caseId, scorePpm]));
  const maximumNegative = Math.max(...cases.negativeCaseIds.map((id) => scoreById.get(id)!));
  const threshold = maximumNegative < T2A_TUDA_SCORE_SCALE ? maximumNegative + 1 : null;
  const accepted = (id: string) => threshold !== null && scoreById.get(id)! >= threshold;
  const trueAccepts = cases.positiveCaseIds.filter(accepted).length;
  const falseAccepts = cases.negativeCaseIds.filter(accepted).length;
  const metricsPass = threshold !== null
    && falseAccepts === 0
    && trueAccepts >= T2A_TUDA_MINIMUM_TRUE_ACCEPTS;
  return t2aTudaCalibrationReportSchema.parse({
    schemaVersion: T2A_TUDA_CALIBRATION_REPORT_VERSION,
    authorizationDigest,
    caseManifestDigest,
    scoreReportDigest: digestCanonical(scoreReport),
    receiptHeadDigest: t2aTudaLedgerReceiptDigest(terminal),
    status: metricsPass ? "provisional-ineligible" : "calibration-failed",
    thresholdPpm: metricsPass ? threshold : null,
    trueAccepts,
    falseRejects: 300 - trueAccepts,
    trueRejects: 300 - falseAccepts,
    falseAccepts,
    authorityStatus: "not-provisioned-contract-draft",
    cryptographicEnvelopeStatus: "verified-under-uninstalled-self-bound-test-policy",
    casReplayStatus: "signed-chain-and-replay-head-verified",
    datasetEvidenceStatus: "synthetic-contract-test-only",
    testSplitStatus: "unopened-zero-bytes-not-provisioned",
    calibrationQualification: "not-calibrated",
    holdoutQualification: "not-qualified",
  });
}
