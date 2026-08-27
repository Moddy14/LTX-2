import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";
import {
  independentIpaPhaseSchema,
  type IndependentIpaPhase,
} from "./independentIpa.js";
import {
  parseT2aGermanG2pExecution,
  parseT2aGermanG2pVocabulary,
  T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256,
  T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256,
  T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
  T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256,
  T2A_GERMAN_G2P_RUNNER_SHA256,
  T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
  T2A_GERMAN_G2P_VOCAB_PATH,
  t2aGermanG2pResultCanonicalJson,
  t2aGermanG2pResultSchema,
  validatePinnedT2aGermanG2pResult,
  type T2aGermanG2pRequest,
} from "./t2aGermanG2p.js";

export const T2A_REFERENCE_IPA_SCHEMA_VERSION =
  "ltx-studio-t2a-reference-ipa.v1" as const;
export const T2A_IPA_ADJUDICATION_RESULT_SCHEMA_VERSION =
  "ltx-studio-t2a-ipa-adjudication-result.v1" as const;
export const T2A_IPA_ADJUDICATOR_REQUEST_SCHEMA_VERSION =
  "ltx-studio-t2a-ipa-adjudicator-request.v1" as const;
export const T2A_IPA_MAX_TOKENS = 1_049 as const;

export const T2A_IPA_ADJUDICATION_POLICY = Object.freeze({
  schemaVersion: "ltx-studio-t2a-ipa-adjudication-policy.v1",
  alignmentMethod: "levenshtein-unit-cost.v1",
  hypothesisTokenSource: "independent-ipa-observation-token-symbols-exact.v1",
  referenceTokenSource: "pinned-reference-ipa-tokens-exact.v1",
  tokenNormalization: "none.v1",
  tieBreak: "minimum-distance-insertions-deletions-substitutions.v1",
  normalizedPhoneErrorRate: "edit-distance-divided-by-reference-token-count.v1",
  maximumReferenceTokens: T2A_IPA_MAX_TOKENS,
  maximumHypothesisTokens: T2A_IPA_MAX_TOKENS,
});

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export const T2A_IPA_ADJUDICATION_POLICY_SHA256 = canonicalSha256(
  T2A_IPA_ADJUDICATION_POLICY,
);

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const canonicalizationSchema = z.literal("ltx-studio-canonical-json.v1");
const digestAlgorithmSchema = z.literal("sha256");
const boundedCountSchema = z.number().finite().int().nonnegative().max(T2A_IPA_MAX_TOKENS);
const referenceIpaTokenSchema = z
  .string()
  .min(1)
  .refine((token) => [...token].length <= 32, "IPA token exceeds the code-point limit")
  .refine(
    (token) => [...token].every((character) => {
      const codePoint = character.codePointAt(0)!;
      return (
        !/\s/u.test(character) &&
        codePoint >= 0x21 &&
        codePoint !== 0x7f &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      );
    }),
    "IPA tokens must not contain controls, whitespace, or unpaired surrogates",
  );
const hypothesisIpaTokenSchema = z.string().min(1).max(5);

export const t2aReferenceIpaDocumentSchema = z
  .object({
    schemaVersion: z.literal(T2A_REFERENCE_IPA_SCHEMA_VERSION),
    canonicalization: canonicalizationSchema,
    digestAlgorithm: digestAlgorithmSchema,
    locale: z.literal("de-DE"),
    authorityAudioSha256: sha256Schema,
    sourceAudioSha256: sha256Schema.nullable(),
    normalizedAudioSha256: sha256Schema.nullable(),
    targetTextSha256: sha256Schema,
    normalizedTargetTextSha256: sha256Schema,
    g2pRunnerSha256: z.literal(T2A_GERMAN_G2P_RUNNER_SHA256),
    espeakBinarySha256: z.literal(T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256),
    espeakDataManifestSha256: z.literal(T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256),
    espeakRuntimeManifestSha256: z.literal(T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256),
    ipaVocabularySha256: z.literal(T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256),
    normalizationPolicySha256: z.literal(T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256),
    espeakStdoutSha256: sha256Schema,
    g2pResultSha256: sha256Schema,
    adjudicatorRunnerSha256: sha256Schema,
    adjudicationPolicySha256: z.literal(T2A_IPA_ADJUDICATION_POLICY_SHA256),
    tokenization: z.literal("espeak-reference-ipa-token-sequence.v1"),
    referenceIpaTokens: z
      .array(referenceIpaTokenSchema)
      .min(1)
      .max(T2A_IPA_MAX_TOKENS),
  })
  .strict()
  .superRefine((reference, context) => {
    if (reference.normalizedAudioSha256 !== null && reference.sourceAudioSha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["normalizedAudioSha256"],
        message: "normalized audio requires a verified source-audio binding",
      });
    }
    const independentPins = [
      reference.g2pRunnerSha256,
      reference.espeakBinarySha256,
      reference.espeakDataManifestSha256,
      reference.espeakRuntimeManifestSha256,
      reference.ipaVocabularySha256,
      reference.normalizationPolicySha256,
      reference.adjudicatorRunnerSha256,
      reference.adjudicationPolicySha256,
    ];
    if (new Set(independentPins).size !== independentPins.length) {
      context.addIssue({
        code: "custom",
        path: ["g2pRunnerSha256"],
        message: "reference production, adjudication, and policy pins must be distinct",
      });
    }
  });

const alignmentMeasurementSchema = z
  .object({
    substitutions: boundedCountSchema,
    deletions: boundedCountSchema,
    insertions: boundedCountSchema,
    editDistance: boundedCountSchema,
    referenceTokenCount: z.number().finite().int().min(1).max(T2A_IPA_MAX_TOKENS),
    hypothesisTokenCount: boundedCountSchema,
    normalizedPhoneErrorRate: z
      .number()
      .finite()
      .nonnegative()
      .max(T2A_IPA_MAX_TOKENS),
  })
  .strict()
  .superRefine((measurement, context) => {
    if (
      measurement.editDistance !==
      measurement.substitutions + measurement.deletions + measurement.insertions
    ) {
      context.addIssue({
        code: "custom",
        path: ["editDistance"],
        message: "edit distance must equal the S/D/I decomposition",
      });
    }
    const expectedRate = measurement.editDistance / measurement.referenceTokenCount;
    if (!Object.is(measurement.normalizedPhoneErrorRate, expectedRate)) {
      context.addIssue({
        code: "custom",
        path: ["normalizedPhoneErrorRate"],
        message: "phone error rate must be the exact normalized raw distance",
      });
    }
  });

const resultDigestsShape = {
  phaseSha256: sha256Schema,
  referenceSha256: sha256Schema,
  targetTextSha256: sha256Schema,
  normalizedTargetTextSha256: sha256Schema,
  espeakRuntimeManifestSha256: z.literal(T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256),
  ipaVocabularySha256: z.literal(T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256),
  espeakStdoutSha256: sha256Schema,
  g2pResultSha256: sha256Schema,
  runnerSha256: sha256Schema,
  policySha256: z.literal(T2A_IPA_ADJUDICATION_POLICY_SHA256),
};

const measuredAdjudicationResultSchema = z
  .object({
    schemaVersion: z.literal(T2A_IPA_ADJUDICATION_RESULT_SCHEMA_VERSION),
    status: z.literal("measured"),
    sourcePhaseStatus: z.literal("measured"),
    ...resultDigestsShape,
    measurement: alignmentMeasurementSchema,
  })
  .strict();

const unavailableAdjudicationResultSchema = z
  .object({
    schemaVersion: z.literal(T2A_IPA_ADJUDICATION_RESULT_SCHEMA_VERSION),
    status: z.literal("unavailable"),
    sourcePhaseStatus: z.enum(["insufficient", "failed"]),
    ...resultDigestsShape,
    measurement: z.null(),
  })
  .strict();

export const t2aIpaAdjudicationResultSchema = z.discriminatedUnion("status", [
  measuredAdjudicationResultSchema,
  unavailableAdjudicationResultSchema,
]);

export const t2aIpaAdjudicatorRequestSchema = z
  .object({
    schemaVersion: z.literal(T2A_IPA_ADJUDICATOR_REQUEST_SCHEMA_VERSION),
    phaseCanonicalJsonBase64: z.string().min(1).max(1024 * 1024),
    referenceCanonicalJsonBase64: z.string().min(1).max(256 * 1024),
    g2pResultCanonicalJsonBase64: z.string().min(1).max(512 * 1024),
    phaseSha256: sha256Schema,
    referenceSha256: sha256Schema,
    runnerSha256: sha256Schema,
    policySha256: z.literal(T2A_IPA_ADJUDICATION_POLICY_SHA256),
    g2pRunnerSha256: z.literal(T2A_GERMAN_G2P_RUNNER_SHA256),
    espeakBinarySha256: z.literal(T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256),
    espeakDataManifestSha256: z.literal(T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256),
    espeakRuntimeManifestSha256: z.literal(T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256),
    ipaVocabularySha256: z.literal(T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256),
    normalizationPolicySha256: z.literal(T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256),
    targetTextSha256: sha256Schema,
    normalizedTargetTextSha256: sha256Schema,
    espeakStdoutSha256: sha256Schema,
    g2pResultSha256: sha256Schema,
  })
  .strict()
  .superRefine((request, context) => {
    for (const key of [
      "phaseCanonicalJsonBase64",
      "referenceCanonicalJsonBase64",
      "g2pResultCanonicalJsonBase64",
    ] as const) {
      const bytes = Buffer.from(request[key], "base64");
      if (bytes.length === 0 || bytes.toString("base64") !== request[key]) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "canonical base64 is required",
        });
      }
    }
  });

export type T2aReferenceIpaDocument = z.infer<typeof t2aReferenceIpaDocumentSchema>;
export type T2aIpaAdjudicationResult = z.infer<typeof t2aIpaAdjudicationResultSchema>;
export type T2aIpaAdjudicatorRequest = z.infer<typeof t2aIpaAdjudicatorRequestSchema>;

type CanonicalInputSchema<T> = z.ZodType<T>;

function parseCanonicalDocument<T>(
  raw: string,
  schema: CanonicalInputSchema<T>,
  maximumBytes: number,
  label: string,
): { document: T; sha256: string } {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") === 0 ||
    Buffer.byteLength(raw, "utf8") > maximumBytes
  ) {
    throw new Error(`Invalid canonical ${label} size`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Invalid canonical ${label} JSON`);
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success || canonicalJson(parsed.data) !== raw) {
    throw new Error(`Invalid canonical ${label} document`);
  }
  return {
    document: parsed.data,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

type AlignmentCounts = Readonly<{
  substitutions: number;
  deletions: number;
  insertions: number;
  editDistance: number;
}>;

type AlignmentState = readonly [
  distance: number,
  substitutions: number,
  deletions: number,
  insertions: number,
];

function alignmentKey(
  state: AlignmentState,
  operationRank: number,
): readonly number[] {
  return [state[0], state[3], state[2], state[1], operationRank];
}

function compareNumericArrays(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

function addState(
  state: AlignmentState,
  substitutions: number,
  deletions: number,
  insertions: number,
): AlignmentState {
  return [
    state[0] + substitutions + deletions + insertions,
    state[1] + substitutions,
    state[2] + deletions,
    state[3] + insertions,
  ];
}

export function rawIpaAlignment(
  referenceTokens: readonly string[],
  hypothesisTokens: readonly string[],
): AlignmentCounts {
  const reference = z
    .array(referenceIpaTokenSchema)
    .min(1)
    .max(T2A_IPA_MAX_TOKENS)
    .parse(referenceTokens);
  const hypothesis = z
    .array(hypothesisIpaTokenSchema)
    .max(T2A_IPA_MAX_TOKENS)
    .parse(hypothesisTokens);
  let previous: AlignmentState[] = Array.from(
    { length: hypothesis.length + 1 },
    (_, index) => [index, 0, 0, index],
  );
  for (let row = 1; row <= reference.length; row += 1) {
    const current: AlignmentState[] = [[row, 0, row, 0]];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      if (reference[row - 1] === hypothesis[column - 1]) {
        current.push(previous[column - 1]!);
        continue;
      }
      const candidates: Array<Readonly<{ state: AlignmentState; rank: number }>> = [
        { state: addState(previous[column - 1]!, 1, 0, 0), rank: 0 },
        { state: addState(previous[column]!, 0, 1, 0), rank: 1 },
        { state: addState(current[column - 1]!, 0, 0, 1), rank: 2 },
      ];
      candidates.sort((left, right) =>
        compareNumericArrays(
          alignmentKey(left.state, left.rank),
          alignmentKey(right.state, right.rank),
        ));
      current.push(candidates[0]!.state);
    }
    previous = current;
  }
  const result = previous[hypothesis.length]!;
  return Object.freeze({
    substitutions: result[1],
    deletions: result[2],
    insertions: result[3],
    editDistance: result[0],
  });
}

const adjudicationOptionsSchema = z
  .object({
    phaseCanonicalJson: z.string().min(1).max(1024 * 1024),
    referenceCanonicalJson: z.string().min(1).max(256 * 1024),
    g2pResultCanonicalJson: z.string().min(1).max(512 * 1024),
    phaseSha256: sha256Schema,
    referenceSha256: sha256Schema,
    runnerSha256: sha256Schema,
    policySha256: z.literal(T2A_IPA_ADJUDICATION_POLICY_SHA256),
    g2pRunnerSha256: z.literal(T2A_GERMAN_G2P_RUNNER_SHA256),
    espeakBinarySha256: z.literal(T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256),
    espeakDataManifestSha256: z.literal(T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256),
    espeakRuntimeManifestSha256: z.literal(T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256),
    ipaVocabularySha256: z.literal(T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256),
    normalizationPolicySha256: z.literal(T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256),
    targetTextSha256: sha256Schema,
    normalizedTargetTextSha256: sha256Schema,
    espeakStdoutSha256: sha256Schema,
    g2pResultSha256: sha256Schema,
  })
  .strict();

function assertAudioBindings(
  phase: IndependentIpaPhase,
  reference: T2aReferenceIpaDocument,
): void {
  if (
    reference.authorityAudioSha256 !== phase.authorityAudioSha256 ||
    reference.sourceAudioSha256 !== phase.sourceAudioSha256 ||
    reference.normalizedAudioSha256 !==
      (phase.normalization?.normalizedAudioSha256 ?? null)
  ) {
    throw new Error("IPA adjudication audio binding mismatch");
  }
}

function assertPinnedPhaseVocabularyBindings(phase: IndependentIpaPhase): void {
  if (phase.status !== "measured") return;
  const bytes = readFileSync(T2A_GERMAN_G2P_VOCAB_PATH);
  parseT2aGermanG2pVocabulary(bytes);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Pinned IPA vocabulary is not strict UTF-8 JSON");
  }
  if (raw === null || Array.isArray(raw) || typeof raw !== "object") {
    throw new Error("Pinned IPA vocabulary is not a token-ID authority");
  }
  const tokenIds = raw as Record<string, unknown>;
  for (const token of phase.observation.observation.tokens) {
    if (tokenIds[token.symbol] !== token.tokenId) {
      throw new Error("Independent IPA token ID and symbol differ from the pinned vocabulary");
    }
  }
}

export function adjudicateT2aIpa(rawOptions: unknown): T2aIpaAdjudicationResult {
  const optionsResult = adjudicationOptionsSchema.safeParse(rawOptions);
  if (!optionsResult.success) throw new Error("Invalid IPA adjudication options");
  const options = optionsResult.data;
  const phase = parseCanonicalDocument(
    options.phaseCanonicalJson,
    independentIpaPhaseSchema,
    512 * 1024,
    "independent IPA phase",
  );
  const reference = parseCanonicalDocument(
    options.referenceCanonicalJson,
    t2aReferenceIpaDocumentSchema,
    128 * 1024,
    "reference IPA",
  );
  const parsedG2pResult = parseCanonicalDocument(
    options.g2pResultCanonicalJson,
    t2aGermanG2pResultSchema,
    256 * 1024,
    "German G2P result",
  );
  const g2pResult = validatePinnedT2aGermanG2pResult(parsedG2pResult.document);
  if (
    phase.sha256 !== options.phaseSha256 ||
    reference.sha256 !== options.referenceSha256 ||
    reference.document.adjudicatorRunnerSha256 !== options.runnerSha256 ||
    reference.document.adjudicationPolicySha256 !== options.policySha256 ||
    reference.document.g2pRunnerSha256 !== options.g2pRunnerSha256 ||
    reference.document.espeakBinarySha256 !== options.espeakBinarySha256 ||
    reference.document.espeakDataManifestSha256 !==
      options.espeakDataManifestSha256 ||
    reference.document.espeakRuntimeManifestSha256 !==
      options.espeakRuntimeManifestSha256 ||
    reference.document.ipaVocabularySha256 !== options.ipaVocabularySha256 ||
    reference.document.normalizationPolicySha256 !==
      options.normalizationPolicySha256 ||
    reference.document.targetTextSha256 !== options.targetTextSha256 ||
    reference.document.normalizedTargetTextSha256 !==
      options.normalizedTargetTextSha256 ||
    reference.document.espeakStdoutSha256 !== options.espeakStdoutSha256
    || reference.document.g2pResultSha256 !== options.g2pResultSha256
    || parsedG2pResult.sha256 !== options.g2pResultSha256
    || g2pResult.targetTextSha256 !== reference.document.targetTextSha256
    || g2pResult.normalizedTargetTextSha256 !== reference.document.normalizedTargetTextSha256
    || g2pResult.g2pRunnerSha256 !== reference.document.g2pRunnerSha256
    || g2pResult.espeakBinarySha256 !== reference.document.espeakBinarySha256
    || g2pResult.espeakDataManifestSha256 !== reference.document.espeakDataManifestSha256
    || g2pResult.espeakRuntimeManifestSha256 !== reference.document.espeakRuntimeManifestSha256
    || g2pResult.ipaVocabularySha256 !== reference.document.ipaVocabularySha256
    || g2pResult.normalizationPolicySha256 !== reference.document.normalizationPolicySha256
    || g2pResult.espeakStdoutSha256 !== reference.document.espeakStdoutSha256
    || canonicalJson(g2pResult.referenceIpaTokens) !== canonicalJson(reference.document.referenceIpaTokens)
  ) {
    throw new Error("IPA adjudicator runner, policy, or reference-production binding mismatch");
  }
  assertAudioBindings(phase.document, reference.document);
  assertPinnedPhaseVocabularyBindings(phase.document);

  const digests = {
    phaseSha256: phase.sha256,
    referenceSha256: reference.sha256,
    targetTextSha256: options.targetTextSha256,
    normalizedTargetTextSha256: options.normalizedTargetTextSha256,
    espeakRuntimeManifestSha256: options.espeakRuntimeManifestSha256,
    ipaVocabularySha256: options.ipaVocabularySha256,
    espeakStdoutSha256: options.espeakStdoutSha256,
    g2pResultSha256: options.g2pResultSha256,
    runnerSha256: options.runnerSha256,
    policySha256: options.policySha256,
  };
  const result: T2aIpaAdjudicationResult = phase.document.status === "measured"
    ? {
        schemaVersion: T2A_IPA_ADJUDICATION_RESULT_SCHEMA_VERSION,
        status: "measured",
        sourcePhaseStatus: "measured",
        ...digests,
        measurement: (() => {
          const referenceTokens = reference.document.referenceIpaTokens;
          const hypothesisTokens = phase.document.observation.observation.tokens.map(
            ({ symbol }) => symbol,
          );
          const counts = rawIpaAlignment(referenceTokens, hypothesisTokens);
          return {
            ...counts,
            referenceTokenCount: referenceTokens.length,
            hypothesisTokenCount: hypothesisTokens.length,
            normalizedPhoneErrorRate:
              counts.editDistance / referenceTokens.length,
          };
        })(),
      }
    : {
        schemaVersion: T2A_IPA_ADJUDICATION_RESULT_SCHEMA_VERSION,
        status: "unavailable",
        sourcePhaseStatus: phase.document.status,
        ...digests,
        measurement: null,
      };
  return Object.freeze(t2aIpaAdjudicationResultSchema.parse(result));
}

export function t2aIpaAdjudicationCanonicalJson(
  result: T2aIpaAdjudicationResult,
): string {
  return canonicalJson(t2aIpaAdjudicationResultSchema.parse(result));
}

export function buildT2aIpaAdjudicatorRequest(options: {
  phaseCanonicalJson: string;
  referenceCanonicalJson: string;
  g2pResultCanonicalJson: string;
  phaseSha256: string;
  referenceSha256: string;
  runnerSha256: string;
  policySha256: typeof T2A_IPA_ADJUDICATION_POLICY_SHA256;
  g2pRunnerSha256: string;
  espeakBinarySha256: string;
  espeakDataManifestSha256: string;
  espeakRuntimeManifestSha256: string;
  ipaVocabularySha256: string;
  normalizationPolicySha256: string;
  targetTextSha256: string;
  normalizedTargetTextSha256: string;
  espeakStdoutSha256: string;
  g2pResultSha256: string;
}): T2aIpaAdjudicatorRequest {
  adjudicateT2aIpa(options);
  return t2aIpaAdjudicatorRequestSchema.parse({
    schemaVersion: T2A_IPA_ADJUDICATOR_REQUEST_SCHEMA_VERSION,
    phaseCanonicalJsonBase64: Buffer.from(options.phaseCanonicalJson, "utf8").toString("base64"),
    referenceCanonicalJsonBase64: Buffer.from(options.referenceCanonicalJson, "utf8").toString("base64"),
    g2pResultCanonicalJsonBase64: Buffer.from(options.g2pResultCanonicalJson, "utf8").toString("base64"),
    phaseSha256: options.phaseSha256,
    referenceSha256: options.referenceSha256,
    runnerSha256: options.runnerSha256,
    policySha256: options.policySha256,
    g2pRunnerSha256: options.g2pRunnerSha256,
    espeakBinarySha256: options.espeakBinarySha256,
    espeakDataManifestSha256: options.espeakDataManifestSha256,
    espeakRuntimeManifestSha256: options.espeakRuntimeManifestSha256,
    ipaVocabularySha256: options.ipaVocabularySha256,
    normalizationPolicySha256: options.normalizationPolicySha256,
    targetTextSha256: options.targetTextSha256,
    normalizedTargetTextSha256: options.normalizedTargetTextSha256,
    espeakStdoutSha256: options.espeakStdoutSha256,
    g2pResultSha256: options.g2pResultSha256,
  });
}

export function buildT2aReferenceIpaDocument(options: Readonly<{
  phase: IndependentIpaPhase;
  g2pRequest: T2aGermanG2pRequest;
  g2pExecution: Readonly<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: Uint8Array;
    stderr: Uint8Array;
    error?: Error;
  }>;
  adjudicatorRunnerSha256: string;
}>): Readonly<{
  reference: T2aReferenceIpaDocument;
  g2pResultCanonicalJson: string;
}> {
  const phase = independentIpaPhaseSchema.parse(options.phase);
  const g2pResult = parseT2aGermanG2pExecution(options.g2pExecution, options.g2pRequest);
  const g2pResultCanonicalJson = t2aGermanG2pResultCanonicalJson(g2pResult);
  const g2pResultSha256 = createHash("sha256")
    .update(g2pResultCanonicalJson)
    .digest("hex");
  const reference = t2aReferenceIpaDocumentSchema.parse({
    schemaVersion: T2A_REFERENCE_IPA_SCHEMA_VERSION,
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    locale: "de-DE",
    authorityAudioSha256: phase.authorityAudioSha256,
    sourceAudioSha256: phase.sourceAudioSha256,
    normalizedAudioSha256: phase.normalization?.normalizedAudioSha256 ?? null,
    targetTextSha256: g2pResult.targetTextSha256,
    normalizedTargetTextSha256: g2pResult.normalizedTargetTextSha256,
    g2pRunnerSha256: g2pResult.g2pRunnerSha256,
    espeakBinarySha256: g2pResult.espeakBinarySha256,
    espeakDataManifestSha256: g2pResult.espeakDataManifestSha256,
    espeakRuntimeManifestSha256: g2pResult.espeakRuntimeManifestSha256,
    ipaVocabularySha256: g2pResult.ipaVocabularySha256,
    normalizationPolicySha256: g2pResult.normalizationPolicySha256,
    espeakStdoutSha256: g2pResult.espeakStdoutSha256,
    g2pResultSha256,
    adjudicatorRunnerSha256: options.adjudicatorRunnerSha256,
    adjudicationPolicySha256: T2A_IPA_ADJUDICATION_POLICY_SHA256,
    tokenization: g2pResult.tokenization,
    referenceIpaTokens: g2pResult.referenceIpaTokens,
  });
  return Object.freeze({ reference, g2pResultCanonicalJson });
}
