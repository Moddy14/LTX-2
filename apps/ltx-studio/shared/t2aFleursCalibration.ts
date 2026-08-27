import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";

export const T2A_FLEURS_CALIBRATION_AUTHORITY_VERSION =
  "ltx-studio-t2a-fleurs-calibration-authority.v1" as const;
export const T2A_FLEURS_CALIBRATION_INVENTORY_VERSION =
  "ltx-studio-t2a-fleurs-calibration-inventory.v1" as const;
export const T2A_FLEURS_CALIBRATION_LEAKAGE_VERSION =
  "ltx-studio-t2a-fleurs-calibration-leakage.v1" as const;
export const T2A_FLEURS_CALIBRATION_SELECTION_POLICY_VERSION =
  "ltx-studio-t2a-fleurs-calibration-selection-policy.v1" as const;
export const T2A_FLEURS_CALIBRATION_SELECTION_VERSION =
  "ltx-studio-t2a-fleurs-calibration-selection.v1" as const;
export const T2A_FLEURS_CALIBRATION_PAIRING_POLICY_VERSION =
  "ltx-studio-t2a-fleurs-calibration-pairing-policy.v1" as const;
export const T2A_FLEURS_CALIBRATION_CASE_MANIFEST_VERSION =
  "ltx-studio-t2a-fleurs-calibration-case-manifest.v1" as const;
export const T2A_FLEURS_CALIBRATION_AUTHORIZATION_VERSION =
  "ltx-studio-t2a-fleurs-calibration-authorization.v1" as const;
export const T2A_FLEURS_CALIBRATION_CONSUMPTION_VERSION =
  "ltx-studio-t2a-fleurs-calibration-consumption.v1" as const;
export const T2A_FLEURS_CALIBRATION_THRESHOLD_SELECTION_VERSION =
  "ltx-studio-t2a-fleurs-calibration-threshold-selection.v1" as const;
export const T2A_FLEURS_CALIBRATION_SCORE_REPORT_VERSION =
  "ltx-studio-t2a-fleurs-calibration-score-report.v1" as const;
export const T2A_FLEURS_CALIBRATION_REPORT_VERSION =
  "ltx-studio-t2a-fleurs-calibration-report.v1" as const;
export const T2A_FLEURS_CALIBRATION_THRESHOLD_POLICY_VERSION =
  "ltx-studio-t2a-fleurs-calibration-threshold-policy.v1" as const;

export const T2A_FLEURS_VALIDATION_ROWS = 363 as const;
export const T2A_FLEURS_TEST_ROWS_DECLARED_BY_CARD = 862 as const;
export const T2A_FLEURS_DATASET_REVISION =
  "70bb2e84b976b7e960aa89f1c648e09c59f894dd" as const;
export const T2A_FLEURS_DATASET_FEATURES = [
  "id",
  "num_samples",
  "path",
  "audio",
  "transcription",
  "raw_transcription",
  "gender",
  "lang_id",
] as const;
export const T2A_FLEURS_CALIBRATION_SELECTED_ROWS = 300 as const;
export const T2A_FLEURS_CALIBRATION_RESERVE_ROWS = 63 as const;
export const T2A_FLEURS_CALIBRATION_TOTAL_CASES = 600 as const;
export const T2A_FLEURS_CALIBRATION_MAXIMUM_CASES_PER_GROUP = 40 as const;
export const T2A_FLEURS_CALIBRATION_SCORE_SCALE = 1_000_000 as const;
export const T2A_FLEURS_CALIBRATION_MINIMUM_TRUE_ACCEPTS = 285 as const;
export const T2A_FLEURS_CALIBRATION_MINIMUM_INDEPENDENT_GROUPS = 300 as const;
export const T2A_FLEURS_CALIBRATION_BOUND_EVALUATOR_MAXIMUM_DURATION_MS = 21_000 as const;
export const T2A_FLEURS_CALIBRATION_MAXIMUM_PRIVATE_INPUT_BYTES = 2_000_000_000 as const;
export const T2A_FLEURS_CALIBRATION_MAXIMUM_RUNTIME_MS = 4 * 60 * 60 * 1_000;
export const T2A_FLEURS_CALIBRATION_MAXIMUM_START_WINDOW_MS = 10 * 60 * 1_000;
// ceil((1 - 0.05^(1 / 300)) * 1_000_000); frozen as an integer so the
// evidence representation is cross-runtime deterministic and conservative.
export const T2A_FLEURS_CALIBRATION_ZERO_FA_UPPER_BOUND_95_PPM = 9_937 as const;

export const t2aFleursCalibrationDifficultyBands = ["hard", "medium", "easy"] as const;
export const t2aFleursCalibrationNegativeStrata = [
  "easy-higher-source-word-count",
  "easy-lower-source-word-count",
  "hard-higher-source-word-count",
  "hard-lower-source-word-count",
  "medium-higher-source-word-count",
  "medium-lower-source-word-count",
] as const;

const SELECTION_DOMAIN = "ltx-studio:t2a:fleurs-de_de:validation:calibration:v1";
const PAIRING_DOMAIN = "ltx-studio:t2a:fleurs-de_de:validation:derangement:v1";
export const T2A_FLEURS_CALIBRATION_SELECTION_SEED = createHash("sha256")
  .update(SELECTION_DOMAIN, "utf8")
  .digest("hex");
export const T2A_FLEURS_CALIBRATION_PAIRING_SEED = createHash("sha256")
  .update(PAIRING_DOMAIN, "utf8")
  .digest("hex");

const nonPlaceholderSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u).refine(
  (value) => !/^([0-9a-f])\1{63}$/u.test(value),
  "placeholder digests are forbidden",
);
const immutableRevisionSchema = z.literal(T2A_FLEURS_DATASET_REVISION);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u);
const utcTimestampSchema = z.string().datetime({ offset: false, precision: 0 });
const ipaTokenSchema = z.string().min(1).max(32).refine(
  (value) => [...value].every((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint > 31 && codePoint !== 127;
  }),
  "IPA tokens may not contain control characters",
);

function digestCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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

export const t2aFleursCalibrationBindingsSchema = z.object({
  combinedEvaluatorDigest: nonPlaceholderSha256Schema,
  scorerDigest: nonPlaceholderSha256Schema,
  adjudicatorDigest: nonPlaceholderSha256Schema,
  scorerRuntimeDigest: nonPlaceholderSha256Schema,
  adjudicatorRuntimeDigest: nonPlaceholderSha256Schema,
  normalizationPolicyDigest: nonPlaceholderSha256Schema,
  g2pDigest: nonPlaceholderSha256Schema,
  groupingRuleDigest: nonPlaceholderSha256Schema,
  leakageRuleDigest: nonPlaceholderSha256Schema,
  trustPolicyDigest: nonPlaceholderSha256Schema,
  consumptionWriterDigest: nonPlaceholderSha256Schema,
}).strict().superRefine((value, context) => {
  if (value.scorerDigest === value.adjudicatorDigest) {
    context.addIssue({
      code: "custom",
      path: ["adjudicatorDigest"],
      message: "scorer and adjudicator must be independently pinned",
    });
  }
  if (value.scorerRuntimeDigest === value.adjudicatorRuntimeDigest) {
    context.addIssue({
      code: "custom",
      path: ["adjudicatorRuntimeDigest"],
      message: "scorer and adjudicator runtimes must be independently pinned",
    });
  }
  if (value.groupingRuleDigest === value.leakageRuleDigest) {
    context.addIssue({
      code: "custom",
      path: ["leakageRuleDigest"],
      message: "grouping and leakage rules must be independently pinned",
    });
  }
});

export type T2aFleursCalibrationBindings = z.infer<
  typeof t2aFleursCalibrationBindingsSchema
>;

const datasetFeaturesSchema = z.tuple([
  z.literal("id"),
  z.literal("num_samples"),
  z.literal("path"),
  z.literal("audio"),
  z.literal("transcription"),
  z.literal("raw_transcription"),
  z.literal("gender"),
  z.literal("lang_id"),
]);

const testSplitAccessSchema = z.object({
  status: z.enum(["verified-sealed", "not-provisioned"]),
  policy: z.literal("forbidden-unmounted-zero-bytes"),
  declaredRowsFromDatasetCard: z.literal(T2A_FLEURS_TEST_ROWS_DECLARED_BY_CARD),
  mounted: z.literal(false),
  opened: z.literal(false),
  bytesRead: z.literal(0),
  openFileDescriptors: z.literal(0),
  attestationDigest: nonPlaceholderSha256Schema.nullable(),
  sealedGroupCommitmentRoot: nonPlaceholderSha256Schema.nullable(),
}).strict().superRefine((value, context) => {
  const provisioned = value.status === "verified-sealed";
  for (const key of ["attestationDigest", "sealedGroupCommitmentRoot"] as const) {
    if (provisioned !== (value[key] !== null)) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: "verified test evidence must be complete; unprovisioned evidence must be null",
      });
    }
  }
});

export const t2aFleursCalibrationAuthoritySchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_AUTHORITY_VERSION),
  canonicalization: z.literal("ltx-studio-canonical-json.v1"),
  digestAlgorithm: z.literal("sha256"),
  repository: z.literal("google/fleurs"),
  immutableRevision: immutableRevisionSchema,
  config: z.literal("de_de"),
  split: z.literal("validation"),
  expectedInventoryRows: z.literal(T2A_FLEURS_VALIDATION_ROWS),
  declaredDatasetFeatures: datasetFeaturesSchema,
  upstreamSpeakerField: z.literal("absent"),
  datasetRootDigest: nonPlaceholderSha256Schema,
  sourceFileInventoryDigest: nonPlaceholderSha256Schema,
  downloadEvidence: z.object({
    sourceUrl: z.literal(
      "https://huggingface.co/datasets/google/fleurs/commit/70bb2e84b976b7e960aa89f1c648e09c59f894dd",
    ),
    immutableRevision: immutableRevisionSchema,
    receiptDigest: nonPlaceholderSha256Schema,
    resolvedArtifactInventoryDigest: nonPlaceholderSha256Schema,
    fetchedAt: utcTimestampSchema,
    offlineMaterializationRequired: z.literal(true),
    networkDisabledDuringCalibration: z.literal(true),
  }).strict(),
  licenseEvidence: z.object({
    spdxIdentifier: z.literal("CC-BY-4.0"),
    licenseTextDigest: nonPlaceholderSha256Schema,
    datasetCardDigest: nonPlaceholderSha256Schema,
    legalApprovalDigest: nonPlaceholderSha256Schema,
    approvalStatus: z.literal("approved-for-local-calibration-and-derived-metrics"),
  }).strict(),
  speakerAuthority: z.object({
    status: z.enum(["verified-signed-mapping", "unavailable-in-upstream-features"]),
    manifestDigest: nonPlaceholderSha256Schema.nullable(),
    filenameInference: z.literal("forbidden"),
  }).strict().superRefine((speaker, context) => {
    if ((speaker.status === "verified-signed-mapping")
      !== (speaker.manifestDigest !== null)) {
      context.addIssue({
        code: "custom",
        path: ["manifestDigest"],
        message: "only verified speaker authority may bind a speaker manifest",
      });
    }
  }),
  testSplitAccess: testSplitAccessSchema,
  bindings: t2aFleursCalibrationBindingsSchema,
  scorerKeyId: identifierSchema,
  adjudicatorKeyId: identifierSchema,
  authorizationKeyId: identifierSchema,
}).strict().superRefine((value, context) => {
  if (value.downloadEvidence.immutableRevision !== value.immutableRevision) {
    context.addIssue({
      code: "custom",
      path: ["downloadEvidence", "immutableRevision"],
      message: "download receipt revision must equal dataset authority revision",
    });
  }
  if (new Set([
    value.scorerKeyId,
    value.adjudicatorKeyId,
    value.authorizationKeyId,
  ]).size !== 3) {
    context.addIssue({
      code: "custom",
      path: ["scorerKeyId"],
      message: "scorer, adjudicator, and authorizer keys must be distinct",
    });
  }
});

export type T2aFleursCalibrationAuthority = z.infer<
  typeof t2aFleursCalibrationAuthoritySchema
>;

export function t2aFleursCalibrationAuthorityDigest(raw: unknown): string {
  return digestCanonical(t2aFleursCalibrationAuthoritySchema.parse(raw));
}

const leakageTokenKindSchema = z.enum([
  "ipa",
  "normalized-transcript",
  "pcm-audio",
  "recording-session",
  "source-sentence",
  "speaker",
  "upstream-duplicate",
]);

const leakageTokenSchema = z.object({
  kind: leakageTokenKindSchema,
  digest: nonPlaceholderSha256Schema,
}).strict();

const audioAuthorityBodySchema = z.object({
  containerSha256: nonPlaceholderSha256Schema,
  pcmPayloadSha256: nonPlaceholderSha256Schema,
  sampleRateHz: z.number().int().positive().max(192_000),
  channels: z.number().int().min(1).max(8),
  bitsPerSample: z.literal(16),
  sampleFrames: z.number().int().positive(),
  durationMilliseconds: z.number().int().min(1_000).max(30_000),
}).strict();

export function t2aFleursCalibrationAudioAuthorityDigest(
  raw: z.input<typeof audioAuthorityBodySchema>,
): string {
  const audio = audioAuthorityBodySchema.parse(raw);
  return digestCanonical({
    schemaVersion: "ltx-studio-t2a-fleurs-audio-authority.v1",
    ...audio,
  });
}

const audioAuthoritySchema = audioAuthorityBodySchema.extend({
  audioAuthorityDigest: nonPlaceholderSha256Schema,
}).strict().superRefine((audio, context) => {
  const representedMilliseconds = audio.sampleFrames * 1_000;
  const declaredMilliseconds = audio.durationMilliseconds * audio.sampleRateHz;
  if (Math.abs(representedMilliseconds - declaredMilliseconds) > audio.sampleRateHz) {
    context.addIssue({
      code: "custom",
      path: ["durationMilliseconds"],
      message: "duration must agree with sample frames and sample rate within one millisecond",
    });
  }
  const { audioAuthorityDigest, ...body } = audio;
  if (t2aFleursCalibrationAudioAuthorityDigest(body) !== audioAuthorityDigest) {
    context.addIssue({
      code: "custom",
      path: ["audioAuthorityDigest"],
      message: "audio authority digest mismatch",
    });
  }
});

const ipaAuthorityBodySchema = z.object({
  normalizedTranscriptDigest: nonPlaceholderSha256Schema,
  normalizationPolicyDigest: nonPlaceholderSha256Schema,
  g2pDigest: nonPlaceholderSha256Schema,
  ipaTokens: z.array(ipaTokenSchema).min(1).max(512),
}).strict();

export function t2aFleursCalibrationIpaAuthorityDigest(
  raw: z.input<typeof ipaAuthorityBodySchema>,
): string {
  const ipa = ipaAuthorityBodySchema.parse(raw);
  return digestCanonical({
    schemaVersion: "ltx-studio-t2a-fleurs-ipa-authority.v1",
    ...ipa,
  });
}

const sourceSentenceSchema = z.object({
  sourceSentenceDigest: nonPlaceholderSha256Schema,
  authority: z.enum([
    "signed-upstream-source-sentence-mapping",
    "conservative-normalized-transcript-equivalence",
  ]),
  authorityRecordDigest: nonPlaceholderSha256Schema.nullable(),
}).strict();

const rowBodySchema = z.object({
  upstreamRowId: identifierSchema,
  upstreamRowIdDigest: nonPlaceholderSha256Schema,
  upstreamRowIndex: z.number().int().min(0).max(T2A_FLEURS_VALIDATION_ROWS - 1),
  datasetRootDigest: nonPlaceholderSha256Schema,
  speakerDigest: nonPlaceholderSha256Schema.nullable(),
  speakerAuthorityRecordDigest: nonPlaceholderSha256Schema.nullable(),
  sourceSentence: sourceSentenceSchema,
  audio: audioAuthoritySchema,
  transcript: z.object({
    rawTranscriptDigest: nonPlaceholderSha256Schema,
    normalizedTranscriptDigest: nonPlaceholderSha256Schema,
    normalizedWordCount: z.number().int().min(1).max(200),
    normalizationPolicyDigest: nonPlaceholderSha256Schema,
    g2pDigest: nonPlaceholderSha256Schema,
    ipaDigest: nonPlaceholderSha256Schema,
    ipaTokens: z.array(ipaTokenSchema).min(1).max(512),
  }).strict(),
  leakageTokens: z.array(leakageTokenSchema).min(4).max(16),
}).strict();

export const t2aFleursCalibrationRowSchema = rowBodySchema.extend({
  rowAuthorityDigest: nonPlaceholderSha256Schema,
}).strict().superRefine((row, context) => {
  const { rowAuthorityDigest, ...body } = row;
  if (digestCanonical(body) !== rowAuthorityDigest) {
    context.addIssue({
      code: "custom",
      path: ["rowAuthorityDigest"],
      message: "row authority digest mismatch",
    });
  }
  const tokenKeys = row.leakageTokens.map(({ kind, digest }) => `${kind}:${digest}`);
  addSortedUniqueIssues(tokenKeys, context, ["leakageTokens"]);
  if (createHash("sha256").update(row.upstreamRowId, "utf8").digest("hex")
      !== row.upstreamRowIdDigest) {
    context.addIssue({
      code: "custom",
      path: ["upstreamRowIdDigest"],
      message: "upstream row id digest mismatch",
    });
  }
  if (t2aFleursCalibrationIpaAuthorityDigest({
    normalizedTranscriptDigest: row.transcript.normalizedTranscriptDigest,
    normalizationPolicyDigest: row.transcript.normalizationPolicyDigest,
    g2pDigest: row.transcript.g2pDigest,
    ipaTokens: row.transcript.ipaTokens,
  }) !== row.transcript.ipaDigest) {
    context.addIssue({
      code: "custom",
      path: ["transcript", "ipaDigest"],
      message: "IPA digest does not bind the transcript, G2P, normalization, and IPA tokens",
    });
  }
  const signedSourceSentence = row.sourceSentence.authority
    === "signed-upstream-source-sentence-mapping";
  if (signedSourceSentence !== (row.sourceSentence.authorityRecordDigest !== null)) {
    context.addIssue({
      code: "custom",
      path: ["sourceSentence", "authorityRecordDigest"],
      message: "only a signed source-sentence mapping may bind an authority record",
    });
  }
  if (!signedSourceSentence && row.sourceSentence.sourceSentenceDigest
      !== row.transcript.normalizedTranscriptDigest) {
    context.addIssue({
      code: "custom",
      path: ["sourceSentence", "sourceSentenceDigest"],
      message: "conservative source-sentence grouping must equal normalized transcript digest",
    });
  }
  const required = new Map<string, string>([
    ["normalized-transcript", row.transcript.normalizedTranscriptDigest],
    ["ipa", row.transcript.ipaDigest],
    ["pcm-audio", row.audio.pcmPayloadSha256],
    ["source-sentence", row.sourceSentence.sourceSentenceDigest],
  ]);
  if ((row.speakerDigest === null) !== (row.speakerAuthorityRecordDigest === null)) {
    context.addIssue({
      code: "custom",
      path: ["speakerDigest"],
      message: "speaker digest and authority record must be present or absent together",
    });
  }
  if (row.speakerDigest !== null) required.set("speaker", row.speakerDigest);
  for (const [kind, digest] of required) {
    const matching = row.leakageTokens.filter((token) => token.kind === kind);
    if (matching.length !== 1 || matching[0]?.digest !== digest) {
      context.addIssue({
        code: "custom",
        path: ["leakageTokens"],
        message: `exactly one authoritative ${kind} leakage token is required`,
      });
    }
  }
  if (row.speakerDigest === null
    && row.leakageTokens.some(({ kind }) => kind === "speaker")) {
    context.addIssue({
      code: "custom",
      path: ["leakageTokens"],
      message: "unverified speaker tokens are forbidden",
    });
  }
});

export type T2aFleursCalibrationRow = z.infer<typeof t2aFleursCalibrationRowSchema>;

export function createT2aFleursCalibrationRow(
  rawBody: z.input<typeof rowBodySchema>,
): T2aFleursCalibrationRow {
  const body = rowBodySchema.parse(rawBody);
  return t2aFleursCalibrationRowSchema.parse({
    ...body,
    rowAuthorityDigest: digestCanonical(body),
  });
}

export const t2aFleursCalibrationInventorySchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_INVENTORY_VERSION),
  canonicalization: z.literal("ltx-studio-canonical-json.v1"),
  digestAlgorithm: z.literal("sha256"),
  authorityDigest: nonPlaceholderSha256Schema,
  datasetRootDigest: nonPlaceholderSha256Schema,
  config: z.literal("de_de"),
  split: z.literal("validation"),
  normalizationPolicyDigest: nonPlaceholderSha256Schema,
  g2pDigest: nonPlaceholderSha256Schema,
  speakerAuthorityStatus: z.enum([
    "verified-signed-mapping",
    "unavailable-in-upstream-features",
  ]),
  rows: z.array(t2aFleursCalibrationRowSchema).length(T2A_FLEURS_VALIDATION_ROWS),
}).strict().superRefine((value, context) => {
  const rowDigests = value.rows.map(({ rowAuthorityDigest }) => rowAuthorityDigest);
  addSortedUniqueIssues(rowDigests, context, ["rows"]);
  const rowIds = value.rows.map(({ upstreamRowId }) => upstreamRowId);
  if (new Set(rowIds).size !== T2A_FLEURS_VALIDATION_ROWS) {
    context.addIssue({ code: "custom", path: ["rows"], message: "row ids must be unique" });
  }
  const indexes = value.rows.map(({ upstreamRowIndex }) => upstreamRowIndex).sort((a, b) => a - b);
  if (!indexes.every((item, index) => item === index)) {
    context.addIssue({
      code: "custom",
      path: ["rows"],
      message: "row indexes must cover exactly 0..362",
    });
  }
  if (value.rows.some(({ datasetRootDigest }) => datasetRootDigest !== value.datasetRootDigest)) {
    context.addIssue({
      code: "custom",
      path: ["datasetRootDigest"],
      message: "every row must bind the same dataset root",
    });
  }
  if (value.rows.some(({ transcript }) =>
    transcript.normalizationPolicyDigest !== value.normalizationPolicyDigest
    || transcript.g2pDigest !== value.g2pDigest)) {
    context.addIssue({
      code: "custom",
      path: ["rows"],
      message: "every row must bind the inventory normalization and G2P authorities",
    });
  }
  const rowsWithSpeaker = value.rows.filter(({ speakerDigest }) => speakerDigest !== null).length;
  if ((value.speakerAuthorityStatus === "verified-signed-mapping")
      !== (rowsWithSpeaker === T2A_FLEURS_VALIDATION_ROWS)) {
    context.addIssue({
      code: "custom",
      path: ["speakerAuthorityStatus"],
      message: "speaker authority status must agree with all 363 row authorities",
    });
  }
});

export type T2aFleursCalibrationInventory = z.infer<
  typeof t2aFleursCalibrationInventorySchema
>;

export function createT2aFleursCalibrationInventory(options: {
  authority: T2aFleursCalibrationAuthority;
  rows: readonly T2aFleursCalibrationRow[];
}): T2aFleursCalibrationInventory {
  const authority = t2aFleursCalibrationAuthoritySchema.parse(options.authority);
  return t2aFleursCalibrationInventorySchema.parse({
    schemaVersion: T2A_FLEURS_CALIBRATION_INVENTORY_VERSION,
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    authorityDigest: t2aFleursCalibrationAuthorityDigest(authority),
    datasetRootDigest: authority.datasetRootDigest,
    config: authority.config,
    split: authority.split,
    normalizationPolicyDigest: authority.bindings.normalizationPolicyDigest,
    g2pDigest: authority.bindings.g2pDigest,
    speakerAuthorityStatus: authority.speakerAuthority.status,
    rows: [...options.rows].sort((a, b) =>
      a.rowAuthorityDigest.localeCompare(b.rowAuthorityDigest)),
  });
}

export function t2aFleursCalibrationInventoryDigest(raw: unknown): string {
  return digestCanonical(t2aFleursCalibrationInventorySchema.parse(raw));
}

const leakageGroupSchema = z.object({
  groupId: nonPlaceholderSha256Schema,
  memberRowAuthorityDigests: z.array(nonPlaceholderSha256Schema).min(1),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssues(value.memberRowAuthorityDigests, context, ["memberRowAuthorityDigests"]);
});

const sealedExternalEvidenceSchema = z.object({
  status: z.enum(["verified-zero-intersection", "not-provisioned"]),
  testGroupCommitmentRoot: nonPlaceholderSha256Schema.nullable(),
  priorCalibrationGroupCommitmentRoot: nonPlaceholderSha256Schema.nullable(),
  crossReleaseGroupCommitmentRoot: nonPlaceholderSha256Schema.nullable(),
  keyedTagEnvelopeDigest: nonPlaceholderSha256Schema.nullable(),
  custodianAttestationDigest: nonPlaceholderSha256Schema.nullable(),
  testIntersectionCount: z.literal(0).nullable(),
  priorCalibrationIntersectionCount: z.literal(0).nullable(),
  crossReleaseIntersectionCount: z.literal(0).nullable(),
  testRowsDisclosed: z.literal(0),
  testBytesReadByCalibration: z.literal(0),
}).strict().superRefine((value, context) => {
  const verified = value.status === "verified-zero-intersection";
  const evidenceKeys = [
    "testGroupCommitmentRoot",
    "priorCalibrationGroupCommitmentRoot",
    "crossReleaseGroupCommitmentRoot",
    "keyedTagEnvelopeDigest",
    "custodianAttestationDigest",
    "testIntersectionCount",
    "priorCalibrationIntersectionCount",
    "crossReleaseIntersectionCount",
  ] as const;
  for (const key of evidenceKeys) {
    if (verified !== (value[key] !== null)) {
      context.addIssue({
        code: "custom",
        path: [key],
        message: "verified leakage evidence must be complete; unprovisioned evidence must be null",
      });
    }
  }
});

export const t2aFleursCalibrationLeakageManifestSchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_LEAKAGE_VERSION),
  canonicalization: z.literal("ltx-studio-canonical-json.v1"),
  digestAlgorithm: z.literal("sha256"),
  inventoryDigest: nonPlaceholderSha256Schema,
  groupingRuleDigest: nonPlaceholderSha256Schema,
  leakageRuleDigest: nonPlaceholderSha256Schema,
  groups: z.array(leakageGroupSchema).min(1).max(T2A_FLEURS_VALIDATION_ROWS),
  sealedExternalEvidence: sealedExternalEvidenceSchema,
}).strict().superRefine((value, context) => {
  addSortedUniqueIssues(value.groups.map(({ groupId }) => groupId), context, ["groups"]);
  const members = value.groups.flatMap(({ memberRowAuthorityDigests }) =>
    memberRowAuthorityDigests);
  if (members.length !== T2A_FLEURS_VALIDATION_ROWS
    || new Set(members).size !== T2A_FLEURS_VALIDATION_ROWS) {
    context.addIssue({
      code: "custom",
      path: ["groups"],
      message: "leakage groups must partition all 363 rows exactly once",
    });
  }
});

export type T2aFleursCalibrationLeakageManifest = z.infer<
  typeof t2aFleursCalibrationLeakageManifestSchema
>;

function computeLeakageGroups(
  inventory: T2aFleursCalibrationInventory,
  groupingRuleDigest: string,
): z.infer<typeof leakageGroupSchema>[] {
  const parent = inventory.rows.map((_, index) => index);
  const find = (value: number): number => {
    let current = value;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]!]!;
      current = parent[current]!;
    }
    return current;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const tokenOwner = new Map<string, number>();
  inventory.rows.forEach((row, index) => {
    for (const token of row.leakageTokens) {
      const key = `${token.kind}:${token.digest}`;
      const owner = tokenOwner.get(key);
      if (owner === undefined) tokenOwner.set(key, index);
      else union(owner, index);
    }
  });
  const components = new Map<number, string[]>();
  inventory.rows.forEach((row, index) => {
    const root = find(index);
    const members = components.get(root) ?? [];
    members.push(row.rowAuthorityDigest);
    components.set(root, members);
  });
  return [...components.values()].map((members) => {
    const sortedMembers = members.sort();
    return {
      groupId: digestCanonical({
        schemaVersion: "ltx-studio-t2a-fleurs-leakage-group.v1",
        groupingRuleDigest,
        memberRowAuthorityDigests: sortedMembers,
      }),
      memberRowAuthorityDigests: sortedMembers,
    };
  }).sort((a, b) => a.groupId.localeCompare(b.groupId));
}

export function createT2aFleursCalibrationLeakageManifest(options: {
  inventory: T2aFleursCalibrationInventory;
  groupingRuleDigest: string;
  leakageRuleDigest: string;
  sealedExternalEvidence: z.input<
    typeof t2aFleursCalibrationLeakageManifestSchema
  >["sealedExternalEvidence"];
}): T2aFleursCalibrationLeakageManifest {
  const inventory = t2aFleursCalibrationInventorySchema.parse(options.inventory);
  return t2aFleursCalibrationLeakageManifestSchema.parse({
    schemaVersion: T2A_FLEURS_CALIBRATION_LEAKAGE_VERSION,
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    inventoryDigest: t2aFleursCalibrationInventoryDigest(inventory),
    groupingRuleDigest: options.groupingRuleDigest,
    leakageRuleDigest: options.leakageRuleDigest,
    groups: computeLeakageGroups(inventory, options.groupingRuleDigest),
    sealedExternalEvidence: options.sealedExternalEvidence,
  });
}

export function verifyT2aFleursCalibrationLeakageManifest(options: {
  inventory: T2aFleursCalibrationInventory;
  manifest: T2aFleursCalibrationLeakageManifest;
}): T2aFleursCalibrationLeakageManifest {
  const inventory = t2aFleursCalibrationInventorySchema.parse(options.inventory);
  const manifest = t2aFleursCalibrationLeakageManifestSchema.parse(options.manifest);
  if (manifest.inventoryDigest !== t2aFleursCalibrationInventoryDigest(inventory)
    || !sameCanonical(
      manifest.groups,
      computeLeakageGroups(inventory, manifest.groupingRuleDigest),
    )) {
    throw new Error("FLEURS leakage manifest does not match the transitive row partition");
  }
  return manifest;
}

export function t2aFleursCalibrationLeakageManifestDigest(raw: unknown): string {
  return digestCanonical(t2aFleursCalibrationLeakageManifestSchema.parse(raw));
}

export const t2aFleursCalibrationSelectionPolicySchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_SELECTION_POLICY_VERSION),
  inventoryDigest: nonPlaceholderSha256Schema,
  leakageManifestDigest: nonPlaceholderSha256Schema,
  selectionSeed: z.literal(T2A_FLEURS_CALIBRATION_SELECTION_SEED),
  expectedSelectedRows: z.literal(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  expectedReserveRows: z.literal(T2A_FLEURS_CALIBRATION_RESERVE_ROWS),
  maximumCasesPerTransitiveGroup: z.literal(T2A_FLEURS_CALIBRATION_MAXIMUM_CASES_PER_GROUP),
  algorithm: z.literal("sha256-rank-greedy-transitive-group-cap.v1"),
  modelScoreSelection: z.literal("forbidden"),
  audioScoreSelection: z.literal("forbidden"),
  replacementAfterScoring: z.literal("forbidden"),
}).strict();

export type T2aFleursCalibrationSelectionPolicy = z.infer<
  typeof t2aFleursCalibrationSelectionPolicySchema
>;

const rankedRowSchema = z.object({
  rowAuthorityDigest: nonPlaceholderSha256Schema,
  selectionRank: nonPlaceholderSha256Schema,
  groupId: nonPlaceholderSha256Schema,
}).strict();

export const t2aFleursCalibrationIneligibilityReasons = [
  "external-leakage-evidence-not-provisioned",
  "insufficient-independent-transitive-groups",
  "insufficient-unique-source-sentence-groups",
  "insufficient-unique-authoritative-speakers",
  "selected-audio-exceeds-bound-evaluator-duration",
  "speaker-authority-unavailable",
] as const;

export const t2aFleursCalibrationIndependenceAssessmentSchema = z.object({
  selectedRecordingRows: z.literal(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  speakerAuthorityStatus: z.enum([
    "verified-signed-mapping",
    "unavailable-in-upstream-features",
  ]),
  uniqueAuthoritativeSpeakers: z.number().int().min(1)
    .max(T2A_FLEURS_CALIBRATION_SELECTED_ROWS).nullable(),
  uniqueSourceSentenceGroups: z.number().int().min(1)
    .max(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  uniqueTransitiveLeakageGroups: z.number().int().min(1)
    .max(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  maximumSelectedDurationMilliseconds: z.number().int().min(1_000).max(30_000),
  boundEvaluatorMaximumDurationMilliseconds: z.literal(
    T2A_FLEURS_CALIBRATION_BOUND_EVALUATOR_MAXIMUM_DURATION_MS,
  ),
  minimumRequiredIndependentGroups: z.literal(
    T2A_FLEURS_CALIBRATION_MINIMUM_INDEPENDENT_GROUPS,
  ),
  externalLeakageEvidenceStatus: z.enum([
    "verified-zero-intersection",
    "not-provisioned",
  ]),
  status: z.enum(["eligible-for-descriptive-independent-case-analysis", "provisional-ineligible"]),
  reasons: z.array(z.enum(t2aFleursCalibrationIneligibilityReasons)).max(6),
  caseIndependenceClaim: z.enum([
    "selected-cases-distinct-across-pinned-transitive-groups",
    "none",
  ]),
  speakerIndependenceClaim: z.enum([
    "selected-cases-distinct-by-authoritative-speaker",
    "none",
  ]),
}).strict().superRefine((value, context) => {
  const expectedReasons: Array<(typeof t2aFleursCalibrationIneligibilityReasons)[number]> = [];
  if (value.externalLeakageEvidenceStatus !== "verified-zero-intersection") {
    expectedReasons.push("external-leakage-evidence-not-provisioned");
  }
  if (value.uniqueTransitiveLeakageGroups
      < T2A_FLEURS_CALIBRATION_MINIMUM_INDEPENDENT_GROUPS) {
    expectedReasons.push("insufficient-independent-transitive-groups");
  }
  if (value.uniqueSourceSentenceGroups
      < T2A_FLEURS_CALIBRATION_MINIMUM_INDEPENDENT_GROUPS) {
    expectedReasons.push("insufficient-unique-source-sentence-groups");
  }
  if (value.speakerAuthorityStatus !== "verified-signed-mapping") {
    expectedReasons.push("speaker-authority-unavailable");
  } else if (value.uniqueAuthoritativeSpeakers
      !== T2A_FLEURS_CALIBRATION_SELECTED_ROWS) {
    expectedReasons.push("insufficient-unique-authoritative-speakers");
  }
  if (value.maximumSelectedDurationMilliseconds
      > T2A_FLEURS_CALIBRATION_BOUND_EVALUATOR_MAXIMUM_DURATION_MS) {
    expectedReasons.push("selected-audio-exceeds-bound-evaluator-duration");
  }
  expectedReasons.sort();
  if ((value.speakerAuthorityStatus === "verified-signed-mapping")
      !== (value.uniqueAuthoritativeSpeakers !== null)) {
    context.addIssue({
      code: "custom",
      path: ["uniqueAuthoritativeSpeakers"],
      message: "speaker count requires verified signed speaker authority",
    });
  }
  if (!sameCanonical(value.reasons, expectedReasons)) {
    context.addIssue({
      code: "custom",
      path: ["reasons"],
      message: "ineligibility reasons must be complete, derived, and sorted",
    });
  }
  const eligible = expectedReasons.length === 0
    && value.uniqueAuthoritativeSpeakers === T2A_FLEURS_CALIBRATION_SELECTED_ROWS;
  if (eligible !== (value.status === "eligible-for-descriptive-independent-case-analysis")) {
    context.addIssue({ code: "custom", path: ["status"], message: "eligibility mismatch" });
  }
  if (eligible !== (value.caseIndependenceClaim
      === "selected-cases-distinct-across-pinned-transitive-groups")
    || eligible !== (value.speakerIndependenceClaim
      === "selected-cases-distinct-by-authoritative-speaker")) {
    context.addIssue({
      code: "custom",
      path: ["caseIndependenceClaim"],
      message: "independence claims are forbidden unless every prerequisite is satisfied",
    });
  }
});

export type T2aFleursCalibrationIndependenceAssessment = z.infer<
  typeof t2aFleursCalibrationIndependenceAssessmentSchema
>;

export const t2aFleursCalibrationSelectionManifestSchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_SELECTION_VERSION),
  inventoryDigest: nonPlaceholderSha256Schema,
  leakageManifestDigest: nonPlaceholderSha256Schema,
  selectionPolicyDigest: nonPlaceholderSha256Schema,
  selected: z.array(rankedRowSchema).length(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  reserve: z.array(rankedRowSchema).length(T2A_FLEURS_CALIBRATION_RESERVE_ROWS),
  independenceAssessment: t2aFleursCalibrationIndependenceAssessmentSchema,
}).strict().superRefine((value, context) => {
  const rows = [...value.selected, ...value.reserve];
  const digests = rows.map(({ rowAuthorityDigest }) => rowAuthorityDigest);
  if (new Set(digests).size !== T2A_FLEURS_VALIDATION_ROWS) {
    context.addIssue({
      code: "custom",
      path: ["selected"],
      message: "selection and reserve must partition all inventory rows",
    });
  }
  for (const [path, entries] of [["selected", value.selected], ["reserve", value.reserve]] as const) {
    const rankKeys = entries.map(({ selectionRank, rowAuthorityDigest }) =>
      `${selectionRank}:${rowAuthorityDigest}`);
    if (!isStrictlySorted(rankKeys)) {
      context.addIssue({ code: "custom", path: [path], message: `${path} must be rank sorted` });
    }
  }
});

export type T2aFleursCalibrationSelectionManifest = z.infer<
  typeof t2aFleursCalibrationSelectionManifestSchema
>;

export function t2aFleursCalibrationSelectionPolicyDigest(raw: unknown): string {
  return digestCanonical(t2aFleursCalibrationSelectionPolicySchema.parse(raw));
}

export function selectT2aFleursCalibrationRows(options: {
  inventory: T2aFleursCalibrationInventory;
  leakageManifest: T2aFleursCalibrationLeakageManifest;
  policy: T2aFleursCalibrationSelectionPolicy;
}): T2aFleursCalibrationSelectionManifest {
  const inventory = t2aFleursCalibrationInventorySchema.parse(options.inventory);
  const leakageManifest = verifyT2aFleursCalibrationLeakageManifest({
    inventory,
    manifest: options.leakageManifest,
  });
  const policy = t2aFleursCalibrationSelectionPolicySchema.parse(options.policy);
  const inventoryDigest = t2aFleursCalibrationInventoryDigest(inventory);
  const leakageManifestDigest = t2aFleursCalibrationLeakageManifestDigest(leakageManifest);
  if (policy.inventoryDigest !== inventoryDigest
    || policy.leakageManifestDigest !== leakageManifestDigest) {
    throw new Error("FLEURS selection policy authority binding mismatch");
  }
  const groupByRow = new Map<string, string>();
  for (const group of leakageManifest.groups) {
    for (const rowDigest of group.memberRowAuthorityDigests) {
      groupByRow.set(rowDigest, group.groupId);
    }
  }
  const ranked = inventory.rows.map((row) => ({
    rowAuthorityDigest: row.rowAuthorityDigest,
    selectionRank: digestCanonical({
      schemaVersion: "ltx-studio-t2a-fleurs-selection-rank.v1",
      selectionSeed: policy.selectionSeed,
      datasetRootDigest: inventory.datasetRootDigest,
      rowAuthorityDigest: row.rowAuthorityDigest,
    }),
    groupId: groupByRow.get(row.rowAuthorityDigest) ?? "",
  })).sort((left, right) =>
    left.selectionRank.localeCompare(right.selectionRank)
    || left.rowAuthorityDigest.localeCompare(right.rowAuthorityDigest));
  if (ranked.some(({ groupId }) => !nonPlaceholderSha256Schema.safeParse(groupId).success)) {
    throw new Error("FLEURS selection row is missing its transitive leakage group");
  }
  const selected: typeof ranked = [];
  const selectedSet = new Set<string>();
  const groupCounts = new Map<string, number>();
  for (const entry of ranked) {
    const current = groupCounts.get(entry.groupId) ?? 0;
    if (selected.length < T2A_FLEURS_CALIBRATION_SELECTED_ROWS
      && current < policy.maximumCasesPerTransitiveGroup) {
      selected.push(entry);
      selectedSet.add(entry.rowAuthorityDigest);
      groupCounts.set(entry.groupId, current + 1);
    }
  }
  if (selected.length !== T2A_FLEURS_CALIBRATION_SELECTED_ROWS) {
    throw new Error("FLEURS inventory cannot satisfy the frozen transitive-group selection cap");
  }
  const reserve = ranked.filter(({ rowAuthorityDigest }) => !selectedSet.has(rowAuthorityDigest));
  const rowByDigest = new Map(inventory.rows.map((row) => [row.rowAuthorityDigest, row]));
  const selectedRows = selected.map(({ rowAuthorityDigest }) => rowByDigest.get(rowAuthorityDigest)!);
  const uniqueAuthoritativeSpeakers = inventory.speakerAuthorityStatus === "verified-signed-mapping"
    ? new Set(selectedRows.map(({ speakerDigest }) => speakerDigest!)).size
    : null;
  const uniqueSourceSentenceGroups = new Set(selectedRows.map(({ sourceSentence }) =>
    sourceSentence.sourceSentenceDigest)).size;
  const uniqueTransitiveLeakageGroups = new Set(selected.map(({ groupId }) => groupId)).size;
  const maximumSelectedDurationMilliseconds = Math.max(...selectedRows.map(({ audio }) =>
    audio.durationMilliseconds));
  const reasons: Array<(typeof t2aFleursCalibrationIneligibilityReasons)[number]> = [];
  if (leakageManifest.sealedExternalEvidence.status !== "verified-zero-intersection") {
    reasons.push("external-leakage-evidence-not-provisioned");
  }
  if (uniqueTransitiveLeakageGroups < T2A_FLEURS_CALIBRATION_MINIMUM_INDEPENDENT_GROUPS) {
    reasons.push("insufficient-independent-transitive-groups");
  }
  if (uniqueSourceSentenceGroups < T2A_FLEURS_CALIBRATION_MINIMUM_INDEPENDENT_GROUPS) {
    reasons.push("insufficient-unique-source-sentence-groups");
  }
  if (inventory.speakerAuthorityStatus !== "verified-signed-mapping") {
    reasons.push("speaker-authority-unavailable");
  } else if (uniqueAuthoritativeSpeakers !== T2A_FLEURS_CALIBRATION_SELECTED_ROWS) {
    reasons.push("insufficient-unique-authoritative-speakers");
  }
  if (maximumSelectedDurationMilliseconds
      > T2A_FLEURS_CALIBRATION_BOUND_EVALUATOR_MAXIMUM_DURATION_MS) {
    reasons.push("selected-audio-exceeds-bound-evaluator-duration");
  }
  reasons.sort();
  const eligible = reasons.length === 0
    && uniqueAuthoritativeSpeakers === T2A_FLEURS_CALIBRATION_SELECTED_ROWS;
  return t2aFleursCalibrationSelectionManifestSchema.parse({
    schemaVersion: T2A_FLEURS_CALIBRATION_SELECTION_VERSION,
    inventoryDigest,
    leakageManifestDigest,
    selectionPolicyDigest: t2aFleursCalibrationSelectionPolicyDigest(policy),
    selected,
    reserve,
    independenceAssessment: {
      selectedRecordingRows: T2A_FLEURS_CALIBRATION_SELECTED_ROWS,
      speakerAuthorityStatus: inventory.speakerAuthorityStatus,
      uniqueAuthoritativeSpeakers,
      uniqueSourceSentenceGroups,
      uniqueTransitiveLeakageGroups,
      maximumSelectedDurationMilliseconds,
      boundEvaluatorMaximumDurationMilliseconds:
        T2A_FLEURS_CALIBRATION_BOUND_EVALUATOR_MAXIMUM_DURATION_MS,
      minimumRequiredIndependentGroups: T2A_FLEURS_CALIBRATION_MINIMUM_INDEPENDENT_GROUPS,
      externalLeakageEvidenceStatus: leakageManifest.sealedExternalEvidence.status,
      status: eligible
        ? "eligible-for-descriptive-independent-case-analysis"
        : "provisional-ineligible",
      reasons,
      caseIndependenceClaim: eligible
        ? "selected-cases-distinct-across-pinned-transitive-groups"
        : "none",
      speakerIndependenceClaim: eligible
        ? "selected-cases-distinct-by-authoritative-speaker"
        : "none",
    },
  });
}

export function t2aFleursCalibrationSelectionManifestDigest(raw: unknown): string {
  return digestCanonical(t2aFleursCalibrationSelectionManifestSchema.parse(raw));
}

export const t2aFleursCalibrationPairingPolicySchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_PAIRING_POLICY_VERSION),
  selectionManifestDigest: nonPlaceholderSha256Schema,
  pairingSeed: z.literal(T2A_FLEURS_CALIBRATION_PAIRING_SEED),
  algorithm: z.literal("first-valid-hash-ranked-cyclic-derangement.v1"),
  foreignReferenceAuthority: z.literal("authentic-selected-dataset-transcript"),
  fixedPoints: z.literal(0),
  bijective: z.literal(true),
  equalNormalizedTranscript: z.literal("forbidden"),
  equalIpa: z.literal("forbidden"),
  syntheticTranscriptMutation: z.literal("forbidden"),
  modelScorePairing: z.literal("forbidden"),
  audioScorePairing: z.literal("forbidden"),
  difficultyAssignment: z.literal("normalized-ipa-distance-stable-tertiles-100.v1"),
  stratumAssignment: z.literal("source-word-count-halves-within-tertile-50.v1"),
}).strict();

export type T2aFleursCalibrationPairingPolicy = z.infer<
  typeof t2aFleursCalibrationPairingPolicySchema
>;

const calibrationPairSchema = z.object({
  pairId: nonPlaceholderSha256Schema,
  sourceRowAuthorityDigest: nonPlaceholderSha256Schema,
  referenceRowAuthorityDigest: nonPlaceholderSha256Schema,
  audioAuthorityDigest: nonPlaceholderSha256Schema,
  foreignRawTranscriptDigest: nonPlaceholderSha256Schema,
  foreignNormalizedTranscriptDigest: nonPlaceholderSha256Schema,
  foreignIpaDigest: nonPlaceholderSha256Schema,
  ipaEditDistance: z.number().int().positive().max(512),
  maximumIpaTokenLength: z.number().int().positive().max(512),
  difficultyBand: z.enum(t2aFleursCalibrationDifficultyBands),
  stratum: z.enum(t2aFleursCalibrationNegativeStrata),
}).strict();

export const t2aFleursCalibrationCaseManifestSchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_CASE_MANIFEST_VERSION),
  inventoryDigest: nonPlaceholderSha256Schema,
  selectionManifestDigest: nonPlaceholderSha256Schema,
  pairingPolicyDigest: nonPlaceholderSha256Schema,
  positiveCaseIds: z.array(nonPlaceholderSha256Schema)
    .length(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  negativeCaseIds: z.array(nonPlaceholderSha256Schema)
    .length(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  pairs: z.array(calibrationPairSchema).length(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  independenceAssessment: t2aFleursCalibrationIndependenceAssessmentSchema,
  releaseQualification: z.literal("calibration-only-not-holdout-qualified"),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssues(value.positiveCaseIds, context, ["positiveCaseIds"]);
  addSortedUniqueIssues(value.negativeCaseIds, context, ["negativeCaseIds"]);
  if (value.negativeCaseIds.some((caseId) => value.positiveCaseIds.includes(caseId))) {
    context.addIssue({
      code: "custom",
      path: ["negativeCaseIds"],
      message: "positive and negative case ids must be disjoint",
    });
  }
  addSortedUniqueIssues(value.pairs.map(({ pairId }) => pairId), context, ["pairs"]);
  if (new Set(value.pairs.map(({ sourceRowAuthorityDigest }) =>
    sourceRowAuthorityDigest)).size !== T2A_FLEURS_CALIBRATION_SELECTED_ROWS
    || new Set(value.pairs.map(({ referenceRowAuthorityDigest }) =>
      referenceRowAuthorityDigest)).size !== T2A_FLEURS_CALIBRATION_SELECTED_ROWS
    || value.pairs.some((pair) =>
      pair.sourceRowAuthorityDigest === pair.referenceRowAuthorityDigest)) {
    context.addIssue({
      code: "custom",
      path: ["pairs"],
      message: "negative references must form a bijective zero-fixed-point derangement",
    });
  }
  for (const band of t2aFleursCalibrationDifficultyBands) {
    if (value.pairs.filter(({ difficultyBand }) => difficultyBand === band).length !== 100) {
      context.addIssue({
        code: "custom",
        path: ["pairs"],
        message: `difficulty band ${band} must contain exactly 100 cases`,
      });
    }
  }
  for (const stratum of t2aFleursCalibrationNegativeStrata) {
    if (value.pairs.filter((pair) => pair.stratum === stratum).length !== 50) {
      context.addIssue({
        code: "custom",
        path: ["pairs"],
        message: `stratum ${stratum} must contain exactly 50 cases`,
      });
    }
  }
});

export type T2aFleursCalibrationCaseManifest = z.infer<
  typeof t2aFleursCalibrationCaseManifestSchema
>;

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

function difficultyComparator(
  left: Pick<z.infer<typeof calibrationPairSchema>, "ipaEditDistance" | "maximumIpaTokenLength" | "pairId">,
  right: Pick<z.infer<typeof calibrationPairSchema>, "ipaEditDistance" | "maximumIpaTokenLength" | "pairId">,
): number {
  const leftCross = left.ipaEditDistance * right.maximumIpaTokenLength;
  const rightCross = right.ipaEditDistance * left.maximumIpaTokenLength;
  return leftCross - rightCross
    || left.ipaEditDistance - right.ipaEditDistance
    || left.maximumIpaTokenLength - right.maximumIpaTokenLength
    || left.pairId.localeCompare(right.pairId);
}

export function createT2aFleursCalibrationCaseManifest(options: {
  inventory: T2aFleursCalibrationInventory;
  selectionManifest: T2aFleursCalibrationSelectionManifest;
  pairingPolicy: T2aFleursCalibrationPairingPolicy;
}): T2aFleursCalibrationCaseManifest {
  const inventory = t2aFleursCalibrationInventorySchema.parse(options.inventory);
  const selection = t2aFleursCalibrationSelectionManifestSchema.parse(
    options.selectionManifest,
  );
  const pairingPolicy = t2aFleursCalibrationPairingPolicySchema.parse(options.pairingPolicy);
  const inventoryDigest = t2aFleursCalibrationInventoryDigest(inventory);
  const selectionManifestDigest = t2aFleursCalibrationSelectionManifestDigest(selection);
  if (selection.inventoryDigest !== inventoryDigest
    || pairingPolicy.selectionManifestDigest !== selectionManifestDigest) {
    throw new Error("FLEURS pairing authority binding mismatch");
  }
  const rowByDigest = new Map(inventory.rows.map((row) => [row.rowAuthorityDigest, row]));
  const selectedRows = selection.selected.map(({ rowAuthorityDigest }) => {
    const row = rowByDigest.get(rowAuthorityDigest);
    if (!row) throw new Error("FLEURS selected row is absent from inventory");
    return row;
  });
  const orderedRows = [...selectedRows].sort((left, right) => {
    const leftRank = digestCanonical({
      schemaVersion: "ltx-studio-t2a-fleurs-pair-order.v1",
      pairingSeed: pairingPolicy.pairingSeed,
      selectionManifestDigest,
      rowAuthorityDigest: left.rowAuthorityDigest,
    });
    const rightRank = digestCanonical({
      schemaVersion: "ltx-studio-t2a-fleurs-pair-order.v1",
      pairingSeed: pairingPolicy.pairingSeed,
      selectionManifestDigest,
      rowAuthorityDigest: right.rowAuthorityDigest,
    });
    return leftRank.localeCompare(rightRank)
      || left.rowAuthorityDigest.localeCompare(right.rowAuthorityDigest);
  });
  const offsets = Array.from(
    { length: T2A_FLEURS_CALIBRATION_SELECTED_ROWS - 1 },
    (_, index) => index + 1,
  ).sort((left, right) => {
    const rank = (offset: number) => digestCanonical({
      schemaVersion: "ltx-studio-t2a-fleurs-pair-offset.v1",
      pairingSeed: pairingPolicy.pairingSeed,
      selectionManifestDigest,
      offset,
    });
    return rank(left).localeCompare(rank(right)) || left - right;
  });
  const offset = offsets.find((candidateOffset) => orderedRows.every((source, index) => {
    const reference = orderedRows[(index + candidateOffset) % orderedRows.length]!;
    return source.rowAuthorityDigest !== reference.rowAuthorityDigest
      && source.transcript.rawTranscriptDigest !== reference.transcript.rawTranscriptDigest
      && source.transcript.normalizedTranscriptDigest
        !== reference.transcript.normalizedTranscriptDigest
      && source.transcript.ipaDigest !== reference.transcript.ipaDigest;
  }));
  if (offset === undefined) {
    throw new Error("FLEURS selected rows admit no valid frozen cyclic transcript derangement");
  }
  type WorkingPair = Omit<z.infer<typeof calibrationPairSchema>, "difficultyBand" | "stratum"> & {
    sourceWordCount: number;
  };
  const workingPairs: WorkingPair[] = orderedRows.map((source, index) => {
    const reference = orderedRows[(index + offset) % orderedRows.length]!;
    const ipaEditDistance = levenshtein(
      source.transcript.ipaTokens,
      reference.transcript.ipaTokens,
    );
    if (ipaEditDistance < 1) {
      throw new Error("FLEURS foreign reference has no pinned IPA difference");
    }
    const pairBase = {
      sourceRowAuthorityDigest: source.rowAuthorityDigest,
      referenceRowAuthorityDigest: reference.rowAuthorityDigest,
      audioAuthorityDigest: source.audio.audioAuthorityDigest,
      foreignRawTranscriptDigest: reference.transcript.rawTranscriptDigest,
      foreignNormalizedTranscriptDigest: reference.transcript.normalizedTranscriptDigest,
      foreignIpaDigest: reference.transcript.ipaDigest,
      ipaEditDistance,
      maximumIpaTokenLength: Math.max(
        source.transcript.ipaTokens.length,
        reference.transcript.ipaTokens.length,
      ),
    };
    return {
      pairId: digestCanonical({
        schemaVersion: "ltx-studio-t2a-fleurs-negative-pair.v1",
        pairingPolicyDigest: digestCanonical(pairingPolicy),
        ...pairBase,
      }),
      ...pairBase,
      sourceWordCount: source.transcript.normalizedWordCount,
    };
  });
  const byDifficulty = [...workingPairs].sort(difficultyComparator);
  const completed: z.infer<typeof calibrationPairSchema>[] = [];
  for (const [bandIndex, band] of t2aFleursCalibrationDifficultyBands.entries()) {
    const bandPairs = byDifficulty.slice(bandIndex * 100, (bandIndex + 1) * 100);
    const byWordCount = [...bandPairs].sort((left, right) =>
      left.sourceWordCount - right.sourceWordCount
      || left.sourceRowAuthorityDigest.localeCompare(right.sourceRowAuthorityDigest));
    const lower = new Set(byWordCount.slice(0, 50).map(({ pairId }) => pairId));
    for (const pair of bandPairs) {
      const { sourceWordCount: _wordCount, ...publicPair } = pair;
      void _wordCount;
      completed.push({
        ...publicPair,
        difficultyBand: band,
        stratum: `${band}-${lower.has(pair.pairId) ? "lower" : "higher"}-source-word-count`,
      } as z.infer<typeof calibrationPairSchema>);
    }
  }
  completed.sort((left, right) => left.pairId.localeCompare(right.pairId));
  const pairingPolicyDigest = digestCanonical(pairingPolicy);
  const positiveCaseIds = selectedRows.map((row) => digestCanonical({
    schemaVersion: "ltx-studio-t2a-fleurs-calibration-positive-case.v1",
    inventoryDigest,
    rowAuthorityDigest: row.rowAuthorityDigest,
    audioAuthorityDigest: row.audio.audioAuthorityDigest,
    referenceTranscriptDigest: row.transcript.rawTranscriptDigest,
  })).sort();
  const negativeCaseIds = completed.map((pair) => digestCanonical({
    schemaVersion: "ltx-studio-t2a-fleurs-calibration-negative-case.v1",
    inventoryDigest,
    pairId: pair.pairId,
    audioAuthorityDigest: pair.audioAuthorityDigest,
    foreignTranscriptDigest: pair.foreignRawTranscriptDigest,
    difficultyBand: pair.difficultyBand,
    stratum: pair.stratum,
  })).sort();
  return t2aFleursCalibrationCaseManifestSchema.parse({
    schemaVersion: T2A_FLEURS_CALIBRATION_CASE_MANIFEST_VERSION,
    inventoryDigest,
    selectionManifestDigest,
    pairingPolicyDigest,
    positiveCaseIds,
    negativeCaseIds,
    pairs: completed,
    independenceAssessment: selection.independenceAssessment,
    releaseQualification: "calibration-only-not-holdout-qualified",
  });
}

export function t2aFleursCalibrationCaseManifestDigest(raw: unknown): string {
  return digestCanonical(t2aFleursCalibrationCaseManifestSchema.parse(raw));
}

export function verifyT2aFleursCalibrationMaterialization(options: {
  authority: T2aFleursCalibrationAuthority;
  inventory: T2aFleursCalibrationInventory;
  leakageManifest: T2aFleursCalibrationLeakageManifest;
  selectionPolicy: T2aFleursCalibrationSelectionPolicy;
  selectionManifest: T2aFleursCalibrationSelectionManifest;
  pairingPolicy: T2aFleursCalibrationPairingPolicy;
  caseManifest: T2aFleursCalibrationCaseManifest;
}): void {
  const authority = t2aFleursCalibrationAuthoritySchema.parse(options.authority);
  const inventory = t2aFleursCalibrationInventorySchema.parse(options.inventory);
  if (inventory.authorityDigest !== t2aFleursCalibrationAuthorityDigest(authority)
    || inventory.datasetRootDigest !== authority.datasetRootDigest) {
    throw new Error("FLEURS inventory does not bind the approved acquisition authority");
  }
  const leakage = verifyT2aFleursCalibrationLeakageManifest({
    inventory,
    manifest: options.leakageManifest,
  });
  if (leakage.groupingRuleDigest !== authority.bindings.groupingRuleDigest
    || leakage.leakageRuleDigest !== authority.bindings.leakageRuleDigest
    || (leakage.sealedExternalEvidence.status === "verified-zero-intersection")
      !== (authority.testSplitAccess.status === "verified-sealed")
    || leakage.sealedExternalEvidence.testGroupCommitmentRoot
      !== authority.testSplitAccess.sealedGroupCommitmentRoot
    || leakage.sealedExternalEvidence.testBytesReadByCalibration !== 0) {
    throw new Error("FLEURS leakage or sealed test authority binding mismatch");
  }
  const expectedSelection = selectT2aFleursCalibrationRows({
    inventory,
    leakageManifest: leakage,
    policy: options.selectionPolicy,
  });
  if (!sameCanonical(expectedSelection, options.selectionManifest)) {
    throw new Error("FLEURS calibration selection is not the frozen deterministic selection");
  }
  const expectedCases = createT2aFleursCalibrationCaseManifest({
    inventory,
    selectionManifest: expectedSelection,
    pairingPolicy: options.pairingPolicy,
  });
  if (!sameCanonical(expectedCases, options.caseManifest)) {
    throw new Error("FLEURS calibration cases are not the frozen deterministic derangement");
  }
}

export const t2aFleursCalibrationAuthorizationSchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_AUTHORIZATION_VERSION),
  authorizationId: identifierSchema,
  authorityDigest: nonPlaceholderSha256Schema,
  inventoryDigest: nonPlaceholderSha256Schema,
  leakageManifestDigest: nonPlaceholderSha256Schema,
  selectionManifestDigest: nonPlaceholderSha256Schema,
  caseManifestDigest: nonPlaceholderSha256Schema,
  thresholdSelectionPolicyDigest: nonPlaceholderSha256Schema,
  combinedEvaluatorDigest: nonPlaceholderSha256Schema,
  scorerDigest: nonPlaceholderSha256Schema,
  adjudicatorDigest: nonPlaceholderSha256Schema,
  consumptionWriterDigest: nonPlaceholderSha256Schema,
  authorizationKeyId: identifierSchema,
  authenticity: z.literal("unsigned-structural-contract-draft"),
  testAccessEvidenceStatus: z.enum(["verified-sealed", "not-provisioned"]),
  testAccessAttestationDigest: nonPlaceholderSha256Schema.nullable(),
  issuedAt: utcTimestampSchema,
  notBefore: utcTimestampSchema,
  startBy: utcTimestampSchema,
  completeBy: utcTimestampSchema,
  nonce: z.string().regex(/^[0-9a-f]{32,128}$/u),
  maximumPrivateInputBytes: z.number().int().positive()
    .max(T2A_FLEURS_CALIBRATION_MAXIMUM_PRIVATE_INPUT_BYTES),
  exactlyOnce: z.literal(true),
  testSplitCapability: z.literal("none"),
}).strict().superRefine((value, context) => {
  const times = [value.issuedAt, value.notBefore, value.startBy, value.completeBy].map(Date.parse);
  if (!(times[0]! <= times[1]! && times[1]! <= times[2]! && times[2]! <= times[3]!)) {
    context.addIssue({
      code: "custom",
      path: ["completeBy"],
      message: "calibration authorization time window is inconsistent",
    });
  }
  if (times[2]! - times[1]! > T2A_FLEURS_CALIBRATION_MAXIMUM_START_WINDOW_MS
    || times[3]! - times[1]! > T2A_FLEURS_CALIBRATION_MAXIMUM_RUNTIME_MS) {
    context.addIssue({
      code: "custom",
      path: ["completeBy"],
      message: "calibration start or runtime window exceeds its frozen bound",
    });
  }
  if ((value.testAccessEvidenceStatus === "verified-sealed")
      !== (value.testAccessAttestationDigest !== null)) {
    context.addIssue({
      code: "custom",
      path: ["testAccessAttestationDigest"],
      message: "test access attestation is required only for verified sealed evidence",
    });
  }
});

export type T2aFleursCalibrationAuthorization = z.infer<
  typeof t2aFleursCalibrationAuthorizationSchema
>;

export function t2aFleursCalibrationAuthorizationDigest(raw: unknown): string {
  return digestCanonical(t2aFleursCalibrationAuthorizationSchema.parse(raw));
}

export const t2aFleursCalibrationConsumptionRecordSchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_CONSUMPTION_VERSION),
  recordId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  previousRecordDigest: nonPlaceholderSha256Schema.nullable(),
  authorizationDigest: nonPlaceholderSha256Schema,
  authorizationNonce: z.string().regex(/^[0-9a-f]{32,128}$/u),
  transactionId: z.string().uuid(),
  state: z.enum(["started", "consumed", "terminal"]),
  privateInputBytesRead: z.number().int().nonnegative(),
  outcome: z.enum(["passed", "failed", "infrastructure_aborted", "deadline"]).nullable(),
  outputDigest: nonPlaceholderSha256Schema.nullable(),
  recordedAt: utcTimestampSchema,
  writerDigest: nonPlaceholderSha256Schema,
  authenticity: z.literal("unsigned-structural-contract-draft"),
}).strict().superRefine((value, context) => {
  if ((value.sequence === 0) !== (value.previousRecordDigest === null)) {
    context.addIssue({
      code: "custom",
      path: ["previousRecordDigest"],
      message: "only the first consumption record may omit its previous digest",
    });
  }
  if (value.state === "started" && value.privateInputBytesRead !== 0) {
    context.addIssue({
      code: "custom",
      path: ["privateInputBytesRead"],
      message: "started must be durable before the first private byte",
    });
  }
  if (value.state === "consumed" && value.privateInputBytesRead < 1) {
    context.addIssue({
      code: "custom",
      path: ["privateInputBytesRead"],
      message: "consumed begins at the first private byte",
    });
  }
  if ((value.state === "terminal") !== (value.outcome !== null)) {
    context.addIssue({ code: "custom", path: ["outcome"], message: "only terminal binds outcome" });
  }
  if ((value.outcome === "passed") !== (value.outputDigest !== null)) {
    context.addIssue({
      code: "custom",
      path: ["outputDigest"],
      message: "only a passed terminal record must bind an output digest",
    });
  }
});

export type T2aFleursCalibrationConsumptionRecord = z.infer<
  typeof t2aFleursCalibrationConsumptionRecordSchema
>;

export function t2aFleursCalibrationConsumptionRecordDigest(raw: unknown): string {
  return digestCanonical(t2aFleursCalibrationConsumptionRecordSchema.parse(raw));
}

export function validateT2aFleursCalibrationConsumption(options: {
  authorization: T2aFleursCalibrationAuthorization;
  records: readonly unknown[];
}): T2aFleursCalibrationConsumptionRecord[] {
  const authorization = t2aFleursCalibrationAuthorizationSchema.parse(options.authorization);
  const records = z.array(t2aFleursCalibrationConsumptionRecordSchema).parse(options.records);
  const authorizationDigest = t2aFleursCalibrationAuthorizationDigest(authorization);
  for (const [index, record] of records.entries()) {
    const previous = records[index - 1];
    const correctTransition = index === 0
      ? record.state === "started"
      : record.state === "consumed"
        ? previous?.state === "started"
        : record.state === "terminal"
          ? previous?.state === "started" || previous?.state === "consumed"
          : false;
    if (record.sequence !== index
      || record.previousRecordDigest !== (previous
        ? t2aFleursCalibrationConsumptionRecordDigest(previous)
        : null)
      || record.authorizationDigest !== authorizationDigest
      || record.authorizationNonce !== authorization.nonce
      || record.writerDigest !== authorization.consumptionWriterDigest
      || (previous && record.transactionId !== previous.transactionId)
      || (previous && record.privateInputBytesRead < previous.privateInputBytesRead)
      || (previous && Date.parse(record.recordedAt) < Date.parse(previous.recordedAt))
      || record.privateInputBytesRead > authorization.maximumPrivateInputBytes
      || (record.state === "terminal" && previous?.state === "started"
        && (record.privateInputBytesRead !== 0 || record.outcome === "passed"))
      || !correctTransition) {
      throw new Error(`FLEURS calibration consumption record ${index} is not exactly-once bound`);
    }
    const recordedAt = Date.parse(record.recordedAt);
    if (index === 0 && (recordedAt < Date.parse(authorization.issuedAt)
      || recordedAt < Date.parse(authorization.notBefore)
      || recordedAt > Date.parse(authorization.startBy))) {
      throw new Error("FLEURS calibration started record is outside its authorized start window");
    }
    if (record.outcome !== "deadline"
      && recordedAt > Date.parse(authorization.completeBy)) {
      throw new Error(`FLEURS calibration consumption record ${index} crossed completeBy`);
    }
    if (record.outcome === "deadline"
      && recordedAt < Date.parse(authorization.completeBy)) {
      throw new Error("FLEURS calibration deadline outcome may not precede completeBy");
    }
  }
  return records;
}

export function assertT2aFleursCalibrationMayStart(options: {
  authorization: T2aFleursCalibrationAuthorization;
  records: readonly unknown[];
  now: Date;
}): void {
  const authorization = t2aFleursCalibrationAuthorizationSchema.parse(options.authorization);
  const now = options.now.getTime();
  if (now < Date.parse(authorization.notBefore) || now > Date.parse(authorization.startBy)) {
    throw new Error("FLEURS calibration authorization is outside its start window");
  }
  if (validateT2aFleursCalibrationConsumption({ authorization, records: options.records }).length) {
    throw new Error("FLEURS calibration authorization has already started and cannot be retried");
  }
  throw new Error(
    "FLEURS calibration is a contract draft: cryptographic authorization and authoritative CAS are not provisioned",
  );
}

export function assertT2aFleursCalibrationMayContinue(options: {
  authorization: T2aFleursCalibrationAuthorization;
  records: readonly unknown[];
  transactionId: string;
  now: Date;
}): void {
  const authorization = t2aFleursCalibrationAuthorizationSchema.parse(options.authorization);
  const records = validateT2aFleursCalibrationConsumption({
    authorization,
    records: options.records,
  });
  const head = records.at(-1);
  if (options.now.getTime() > Date.parse(authorization.completeBy)
    || options.now.getTime() < Date.parse(authorization.notBefore)
    || !head
    || options.now.getTime() < Date.parse(head.recordedAt)
    || head.transactionId !== options.transactionId
    || head.state === "terminal") {
    throw new Error("FLEURS calibration continuation is absent, foreign, terminal, or expired");
  }
  throw new Error(
    "FLEURS calibration is a contract draft: authoritative CAS/replay-head continuation is not provisioned",
  );
}

export const t2aFleursCalibrationThresholdSelectionPolicySchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_THRESHOLD_SELECTION_VERSION),
  caseManifestDigest: nonPlaceholderSha256Schema,
  combinedEvaluatorDigest: nonPlaceholderSha256Schema,
  scorerDigest: nonPlaceholderSha256Schema,
  adjudicatorDigest: nonPlaceholderSha256Schema,
  scoreScale: z.literal(T2A_FLEURS_CALIBRATION_SCORE_SCALE),
  decisionRule: z.literal("accept-iff-score-ppm-greater-than-or-equal-threshold"),
  selector: z.literal("smallest-zero-false-accept-threshold.v1"),
  maximumFalseAccepts: z.literal(0),
  maximumAbstentions: z.literal(0),
  minimumTrueAccepts: z.literal(T2A_FLEURS_CALIBRATION_MINIMUM_TRUE_ACCEPTS),
  modelOrAudioScoreCaseSelection: z.literal("forbidden"),
  scoreEvidenceAuthority: z.literal("unsigned-contract-draft-only"),
  releaseQualification: z.literal("forbidden-calibration-only"),
}).strict();

export type T2aFleursCalibrationThresholdSelectionPolicy = z.infer<
  typeof t2aFleursCalibrationThresholdSelectionPolicySchema
>;

export function verifyT2aFleursCalibrationAuthorization(options: {
  authority: T2aFleursCalibrationAuthority;
  inventory: T2aFleursCalibrationInventory;
  leakageManifest: T2aFleursCalibrationLeakageManifest;
  selectionPolicy: T2aFleursCalibrationSelectionPolicy;
  selectionManifest: T2aFleursCalibrationSelectionManifest;
  pairingPolicy: T2aFleursCalibrationPairingPolicy;
  caseManifest: T2aFleursCalibrationCaseManifest;
  thresholdSelectionPolicy: T2aFleursCalibrationThresholdSelectionPolicy;
  authorization: T2aFleursCalibrationAuthorization;
}): T2aFleursCalibrationAuthorization {
  verifyT2aFleursCalibrationMaterialization(options);
  const authority = t2aFleursCalibrationAuthoritySchema.parse(options.authority);
  const thresholdPolicy = t2aFleursCalibrationThresholdSelectionPolicySchema.parse(
    options.thresholdSelectionPolicy,
  );
  const authorization = t2aFleursCalibrationAuthorizationSchema.parse(options.authorization);
  const caseManifestDigest = t2aFleursCalibrationCaseManifestDigest(options.caseManifest);
  if (thresholdPolicy.caseManifestDigest !== caseManifestDigest
    || thresholdPolicy.combinedEvaluatorDigest !== authority.bindings.combinedEvaluatorDigest
    || thresholdPolicy.scorerDigest !== authority.bindings.scorerDigest
    || thresholdPolicy.adjudicatorDigest !== authority.bindings.adjudicatorDigest
    || authorization.authorityDigest !== t2aFleursCalibrationAuthorityDigest(authority)
    || authorization.inventoryDigest !== t2aFleursCalibrationInventoryDigest(options.inventory)
    || authorization.leakageManifestDigest
      !== t2aFleursCalibrationLeakageManifestDigest(options.leakageManifest)
    || authorization.selectionManifestDigest
      !== t2aFleursCalibrationSelectionManifestDigest(options.selectionManifest)
    || authorization.caseManifestDigest !== caseManifestDigest
    || authorization.thresholdSelectionPolicyDigest !== digestCanonical(thresholdPolicy)
    || authorization.combinedEvaluatorDigest !== authority.bindings.combinedEvaluatorDigest
    || authorization.scorerDigest !== authority.bindings.scorerDigest
    || authorization.adjudicatorDigest !== authority.bindings.adjudicatorDigest
    || authorization.consumptionWriterDigest !== authority.bindings.consumptionWriterDigest
    || authorization.authorizationKeyId !== authority.authorizationKeyId
    || authorization.testAccessEvidenceStatus !== authority.testSplitAccess.status
    || authorization.testAccessAttestationDigest
      !== authority.testSplitAccess.attestationDigest) {
    throw new Error("FLEURS calibration authorization prerequisite binding mismatch");
  }
  void authorization;
  throw new Error(
    "FLEURS calibration authorization is structurally bound but not cryptographically verified; contract draft remains ineligible",
  );
}

const caseScoreSchema = z.object({
  caseId: nonPlaceholderSha256Schema,
  scorePpm: z.number().int().min(0).max(T2A_FLEURS_CALIBRATION_SCORE_SCALE),
}).strict();

export const t2aFleursCalibrationScoreReportSchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_SCORE_REPORT_VERSION),
  caseManifestDigest: nonPlaceholderSha256Schema,
  combinedEvaluatorDigest: nonPlaceholderSha256Schema,
  scorerDigest: nonPlaceholderSha256Schema,
  adjudicatorDigest: nonPlaceholderSha256Schema,
  consumptionHeadDigest: nonPlaceholderSha256Schema,
  authenticity: z.literal("unsigned-untrusted-contract-draft"),
  scores: z.array(caseScoreSchema).length(T2A_FLEURS_CALIBRATION_TOTAL_CASES),
}).strict().superRefine((value, context) => {
  addSortedUniqueIssues(value.scores.map(({ caseId }) => caseId), context, ["scores"]);
});

export type T2aFleursCalibrationScoreReport = z.infer<
  typeof t2aFleursCalibrationScoreReportSchema
>;

const negativePartitionResultSchema = z.object({
  name: z.string().min(1).max(80),
  cases: z.number().int().positive(),
  falseAccepts: z.number().int().nonnegative(),
  trueRejects: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.falseAccepts + value.trueRejects !== value.cases) {
    context.addIssue({ code: "custom", path: ["cases"], message: "partition counts mismatch" });
  }
});

export const t2aFleursCalibrationReportSchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_REPORT_VERSION),
  caseManifestDigest: nonPlaceholderSha256Schema,
  thresholdSelectionPolicyDigest: nonPlaceholderSha256Schema,
  scoreReportDigest: nonPlaceholderSha256Schema,
  consumptionHeadDigest: nonPlaceholderSha256Schema,
  status: z.enum(["provisional-ineligible", "calibration-failed"]),
  thresholdPpm: z.number().int().min(0).max(T2A_FLEURS_CALIBRATION_SCORE_SCALE).nullable(),
  trueAccepts: z.number().int().min(0).max(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  falseRejects: z.number().int().min(0).max(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  trueRejects: z.number().int().min(0).max(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  falseAccepts: z.number().int().min(0).max(T2A_FLEURS_CALIBRATION_SELECTED_ROWS),
  abstentions: z.literal(0),
  difficultyResults: z.array(negativePartitionResultSchema).length(3),
  stratumResults: z.array(negativePartitionResultSchema).length(6),
  independenceAssessment: t2aFleursCalibrationIndependenceAssessmentSchema,
  descriptiveFalseAcceptUpperBound95Ppm: z.null(),
  confidenceBoundRounding: z.literal("not-applicable"),
  thresholdSelectedOnSameCases: z.literal(true),
  confidenceClaim: z.enum([
    "not-applicable-untrusted-contract-draft",
    "not-applicable-calibration-failed",
  ]),
  executionQualification: z.literal(
    "contract-draft-no-cryptographic-authorization-score-signature-or-cas-authority",
  ),
  releaseQualification: z.literal("not-holdout-qualified"),
}).strict().superRefine((value, context) => {
  if (value.trueAccepts + value.falseRejects !== T2A_FLEURS_CALIBRATION_SELECTED_ROWS
    || value.trueRejects + value.falseAccepts !== T2A_FLEURS_CALIBRATION_SELECTED_ROWS) {
    context.addIssue({ code: "custom", path: ["trueAccepts"], message: "confusion counts mismatch" });
  }
  const hasThreshold = value.thresholdPpm !== null;
  if ((value.status !== "calibration-failed") !== hasThreshold) {
    context.addIssue({
      code: "custom",
      path: ["thresholdPpm"],
      message: "only a successful provisional contract-draft report may bind a threshold",
    });
  }
  if ((value.status === "provisional-ineligible") !== hasThreshold) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "unsigned successful scores remain provisional-ineligible",
    });
  }
  if (value.status === "provisional-ineligible"
    && (value.confidenceClaim !== "not-applicable-untrusted-contract-draft"
      || value.confidenceBoundRounding !== "not-applicable")) {
    context.addIssue({
      code: "custom",
      path: ["confidenceClaim"],
      message: "provisional correlated cases have no binomial confidence claim",
    });
  }
  if (value.status === "calibration-failed"
    && (value.confidenceClaim !== "not-applicable-calibration-failed"
      || value.confidenceBoundRounding !== "not-applicable")) {
    context.addIssue({
      code: "custom",
      path: ["confidenceClaim"],
      message: "failed calibration has no confidence claim",
    });
  }
});

export type T2aFleursCalibrationReport = z.infer<
  typeof t2aFleursCalibrationReportSchema
>;

export const t2aFleursCalibrationThresholdPolicySchema = z.object({
  schemaVersion: z.literal(T2A_FLEURS_CALIBRATION_THRESHOLD_POLICY_VERSION),
  calibrationReportDigest: nonPlaceholderSha256Schema,
  caseManifestDigest: nonPlaceholderSha256Schema,
  combinedEvaluatorDigest: nonPlaceholderSha256Schema,
  scorerDigest: nonPlaceholderSha256Schema,
  adjudicatorDigest: nonPlaceholderSha256Schema,
  thresholdPpm: z.number().int().min(0).max(T2A_FLEURS_CALIBRATION_SCORE_SCALE),
  scoreScale: z.literal(T2A_FLEURS_CALIBRATION_SCORE_SCALE),
  decisionRule: z.literal("accept-iff-score-ppm-greater-than-or-equal-threshold"),
  status: z.literal("calibration-only-provisional-ineligible"),
  independenceClaim: z.literal("none"),
  executionQualification: z.literal("contract-draft-not-authorized-for-runtime-use"),
  holdoutQualification: z.literal("not-qualified"),
}).strict();

export type T2aFleursCalibrationThresholdPolicy = z.infer<
  typeof t2aFleursCalibrationThresholdPolicySchema
>;

export function calibrateT2aFleursThreshold(options: {
  caseManifest: T2aFleursCalibrationCaseManifest;
  selectionPolicy: T2aFleursCalibrationThresholdSelectionPolicy;
  scoreReport: T2aFleursCalibrationScoreReport;
}): {
  report: T2aFleursCalibrationReport;
  thresholdPolicy: T2aFleursCalibrationThresholdPolicy | null;
} {
  const manifest = t2aFleursCalibrationCaseManifestSchema.parse(options.caseManifest);
  const policy = t2aFleursCalibrationThresholdSelectionPolicySchema.parse(
    options.selectionPolicy,
  );
  const scores = t2aFleursCalibrationScoreReportSchema.parse(options.scoreReport);
  const caseManifestDigest = t2aFleursCalibrationCaseManifestDigest(manifest);
  if (policy.caseManifestDigest !== caseManifestDigest
    || scores.caseManifestDigest !== caseManifestDigest
    || policy.combinedEvaluatorDigest !== scores.combinedEvaluatorDigest
    || policy.scorerDigest !== scores.scorerDigest
    || policy.adjudicatorDigest !== scores.adjudicatorDigest) {
    throw new Error("FLEURS calibration score or threshold authority binding mismatch");
  }
  const expectedCaseIds = [...manifest.positiveCaseIds, ...manifest.negativeCaseIds].sort();
  if (!sameCanonical(expectedCaseIds, scores.scores.map(({ caseId }) => caseId))) {
    throw new Error("FLEURS calibration score report does not cover the exact 600 cases");
  }
  const scoreByCase = new Map(scores.scores.map(({ caseId, scorePpm }) => [caseId, scorePpm]));
  const maximumNegativeScore = Math.max(...manifest.negativeCaseIds.map((caseId) =>
    scoreByCase.get(caseId)!));
  const threshold = maximumNegativeScore < T2A_FLEURS_CALIBRATION_SCORE_SCALE
    ? maximumNegativeScore + 1
    : null;
  const accepted = (caseId: string) => threshold !== null
    && scoreByCase.get(caseId)! >= threshold;
  const trueAccepts = manifest.positiveCaseIds.filter(accepted).length;
  const falseAccepts = manifest.negativeCaseIds.filter(accepted).length;
  const metricsPass = threshold !== null
    && falseAccepts === 0
    && trueAccepts >= policy.minimumTrueAccepts;
  // negativeCaseIds are independently sorted, so bind partitions by the same
  // deterministic case-id formula instead of relying on array position.
  const negativeCaseId = (pair: z.infer<typeof calibrationPairSchema>) => digestCanonical({
    schemaVersion: "ltx-studio-t2a-fleurs-calibration-negative-case.v1",
    inventoryDigest: manifest.inventoryDigest,
    pairId: pair.pairId,
    audioAuthorityDigest: pair.audioAuthorityDigest,
    foreignTranscriptDigest: pair.foreignRawTranscriptDigest,
    difficultyBand: pair.difficultyBand,
    stratum: pair.stratum,
  });
  const partition = (name: string, pairs: readonly z.infer<typeof calibrationPairSchema>[]) => {
    const falseAcceptCount = pairs.filter((pair) => accepted(negativeCaseId(pair))).length;
    return {
      name,
      cases: pairs.length,
      falseAccepts: falseAcceptCount,
      trueRejects: pairs.length - falseAcceptCount,
    };
  };
  const status = !metricsPass
    ? "calibration-failed" as const
    : "provisional-ineligible" as const;
  const report = t2aFleursCalibrationReportSchema.parse({
    schemaVersion: T2A_FLEURS_CALIBRATION_REPORT_VERSION,
    caseManifestDigest,
    thresholdSelectionPolicyDigest: digestCanonical(policy),
    scoreReportDigest: digestCanonical(scores),
    consumptionHeadDigest: scores.consumptionHeadDigest,
    status,
    thresholdPpm: metricsPass ? threshold : null,
    trueAccepts,
    falseRejects: T2A_FLEURS_CALIBRATION_SELECTED_ROWS - trueAccepts,
    trueRejects: T2A_FLEURS_CALIBRATION_SELECTED_ROWS - falseAccepts,
    falseAccepts,
    abstentions: 0,
    difficultyResults: t2aFleursCalibrationDifficultyBands.map((band) => partition(
      band,
      manifest.pairs.filter(({ difficultyBand }) => difficultyBand === band),
    )),
    stratumResults: t2aFleursCalibrationNegativeStrata.map((stratum) => partition(
      stratum,
      manifest.pairs.filter((pair) => pair.stratum === stratum),
    )),
    independenceAssessment: manifest.independenceAssessment,
    descriptiveFalseAcceptUpperBound95Ppm: null,
    confidenceBoundRounding: "not-applicable",
    thresholdSelectedOnSameCases: true,
    confidenceClaim: status === "provisional-ineligible"
        ? "not-applicable-untrusted-contract-draft"
        : "not-applicable-calibration-failed",
    executionQualification:
      "contract-draft-no-cryptographic-authorization-score-signature-or-cas-authority",
    releaseQualification: "not-holdout-qualified",
  });
  if (!metricsPass || threshold === null) return { report, thresholdPolicy: null };
  const thresholdPolicy = t2aFleursCalibrationThresholdPolicySchema.parse({
    schemaVersion: T2A_FLEURS_CALIBRATION_THRESHOLD_POLICY_VERSION,
    calibrationReportDigest: digestCanonical(report),
    caseManifestDigest,
    combinedEvaluatorDigest: policy.combinedEvaluatorDigest,
    scorerDigest: policy.scorerDigest,
    adjudicatorDigest: policy.adjudicatorDigest,
    thresholdPpm: threshold,
    scoreScale: policy.scoreScale,
    decisionRule: policy.decisionRule,
    status: "calibration-only-provisional-ineligible",
    independenceClaim: "none",
    executionQualification: "contract-draft-not-authorized-for-runtime-use",
    holdoutQualification: "not-qualified",
  });
  return { report, thresholdPolicy };
}
