import { z } from "zod";

export const INDEPENDENT_IPA_PHASE_SCHEMA_VERSION = "ltx-studio-independent-ipa-phase.v2" as const;
export const INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION = "ltx-studio-independent-ipa-observation.v1" as const;
export const INDEPENDENT_IPA_METHOD = "xlsr53-espeak-cv-free-ctc-greedy.v1" as const;
export const INDEPENDENT_IPA_DECODER_POLICY = "ctc-collapse-runs-then-remove-blank.v1" as const;
export const INDEPENDENT_IPA_NORMALIZATION_METHOD = "ffmpeg-pcm-s16le-mono-16khz-bitexact.v1" as const;
export const INDEPENDENT_IPA_FFMPEG_SHA256 = "de3099d88e092174168b4d436187b970eab6578c5987a4f09b0fee543794f31e" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const sha256Schema = z.string().regex(SHA256_PATTERN);
const boundedIntegerSchema = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const confidenceSchema = z.number().finite().min(0).max(1);

function roundHalfToEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction !== 0.5) return Math.round(value);
  return lower % 2 === 0 ? lower : lower + 1;
}

const normalizationSchema = z.object({
  method: z.literal(INDEPENDENT_IPA_NORMALIZATION_METHOD),
  ffmpegSha256: z.literal(INDEPENDENT_IPA_FFMPEG_SHA256),
  normalizedAudioSha256: sha256Schema,
  sampleRateHz: z.literal(16_000),
  channels: z.literal(1),
  durationMilliseconds: z.number().finite().int().min(100).max(21_000),
}).strict();

const executionBoundarySchema = z.object({
  cpuOnly: z.literal(true),
  ipSocketFamiliesBlocked: z.tuple([z.literal("AF_INET"), z.literal("AF_INET6")]),
  blockedNetworkErrno: z.literal(97),
  noNewPrivileges: z.literal(true),
  effectiveCapabilities: z.literal("0000000000000000"),
  memoryMaxBytes: z.literal(8 * 1024 ** 3),
  minimumCgroupHeadroomBytes: z.literal(6 * 1024 ** 3),
  swapMaxBytes: z.literal(0),
  pidsMax: z.literal(64),
  cpuMax: z.literal("200000 100000"),
}).strict();

const normalizedSourceAudioSchema = z.object({
  sha256: sha256Schema,
  sampleRateHz: z.literal(16_000),
  channels: z.literal(1),
  sampleCount: z.number().finite().int().min(1_600).max(336_000),
  durationMilliseconds: z.number().finite().int().min(100).max(21_000),
}).strict().superRefine((source, context) => {
  const expectedDuration = roundHalfToEven(source.sampleCount * 1_000 / 16_000);
  if (source.durationMilliseconds !== expectedDuration) {
    context.addIssue({
      code: "custom",
      path: ["durationMilliseconds"],
      message: "Normalized audio duration must be derived from its exact sample count.",
    });
  }
});

const tokenSchema = z.object({
  tokenId: z.number().finite().int().min(0).max(391),
  symbol: z.string().min(1).max(5),
  startFrame: boundedIntegerSchema,
  endFrameExclusive: z.number().finite().int().min(1).max(Number.MAX_SAFE_INTEGER),
  medianPosterior: confidenceSchema,
  p10Posterior: confidenceSchema,
  minimumTop1Margin: confidenceSchema,
  unknown: z.boolean(),
  special: z.boolean(),
}).strict().superRefine((token, context) => {
  if (token.endFrameExclusive <= token.startFrame) {
    context.addIssue({
      code: "custom",
      path: ["endFrameExclusive"],
      message: "A decoded CTC run must contain at least one frame.",
    });
  }
  if (token.p10Posterior > token.medianPosterior) {
    context.addIssue({
      code: "custom",
      path: ["p10Posterior"],
      message: "The tenth-percentile posterior cannot exceed the median posterior.",
    });
  }
  if (token.unknown && token.special) {
    context.addIssue({
      code: "custom",
      path: ["special"],
      message: "The pinned vocabulary's unknown token is not a special token.",
    });
  }
});

const ipaObservationPayloadSchema = z.object({
  frameCount: z.number().finite().int().min(4).max(1_049),
  outputStrideSamples: z.literal(320),
  receptiveFieldSamples: z.literal(400),
  blankTokenId: z.literal(0),
  unknownTokenId: z.literal(3),
  decodedIpa: z.string().max(256 * 1024),
  unknownTokenCount: boundedIntegerSchema,
  specialTokenCount: boundedIntegerSchema,
  blankFrameRatio: confidenceSchema,
  tokens: z.array(tokenSchema).max(1_049),
}).strict().superRefine((observation, context) => {
  let previousEnd = 0;
  observation.tokens.forEach((token, index) => {
    if (token.startFrame < previousEnd || token.endFrameExclusive > observation.frameCount) {
      context.addIssue({
        code: "custom",
        path: ["tokens", index],
        message: "Decoded CTC token runs must be ordered, disjoint, and inside the frame window.",
      });
    }
    if (token.tokenId === observation.blankTokenId) {
      context.addIssue({
        code: "custom",
        path: ["tokens", index, "tokenId"],
        message: "The CTC blank token must be removed from decoded token runs.",
      });
    }
    if (token.unknown !== (token.tokenId === observation.unknownTokenId)) {
      context.addIssue({
        code: "custom",
        path: ["tokens", index, "unknown"],
        message: "Unknown-token flags must be bound to the pinned unknown token ID.",
      });
    }
    if (token.special !== (token.tokenId === 1 || token.tokenId === 2)) {
      context.addIssue({
        code: "custom",
        path: ["tokens", index, "special"],
        message: "Special-token flags must be bound to the pinned BOS/EOS token IDs.",
      });
    }
    previousEnd = token.endFrameExclusive;
  });

  if (observation.decodedIpa !== observation.tokens.map((token) => token.symbol).join(" ")) {
    context.addIssue({
      code: "custom",
      path: ["decodedIpa"],
      message: "Decoded IPA must be the exact ordered token-symbol sequence.",
    });
  }
  if (observation.unknownTokenCount
    !== observation.tokens.filter((token) => token.unknown).length) {
    context.addIssue({
      code: "custom",
      path: ["unknownTokenCount"],
      message: "Unknown-token count must match decoded token facts.",
    });
  }
  if (observation.specialTokenCount
    !== observation.tokens.filter((token) => token.special).length) {
    context.addIssue({
      code: "custom",
      path: ["specialTokenCount"],
      message: "Special-token count must match decoded token facts.",
    });
  }
});

const measuredObservationSchema = z.object({
  schemaVersion: z.literal(INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION),
  status: z.literal("measured"),
  error: z.null(),
  method: z.literal(INDEPENDENT_IPA_METHOD),
  decoderPolicy: z.literal(INDEPENDENT_IPA_DECODER_POLICY),
  targetConditioned: z.literal(false),
  runnerSha256: sha256Schema,
  executionBoundary: executionBoundarySchema,
  sourceAudio: normalizedSourceAudioSchema,
  modelFingerprint: sha256Schema,
  modelManifestSha256: sha256Schema,
  modelWeightSha256: sha256Schema,
  runtime: z.object({
    python: z.literal("3.12.3"),
    torch: z.literal("2.13.0+cu132"),
    transformers: z.literal("5.14.1"),
    safetensors: z.literal("0.8.0"),
  }).strict(),
  observation: ipaObservationPayloadSchema,
}).strict();

export const independentIpaObservationSchema = measuredObservationSchema;

const measuredPhaseSchema = z.object({
  schemaVersion: z.literal(INDEPENDENT_IPA_PHASE_SCHEMA_VERSION),
  status: z.literal("measured"),
  reasonCode: z.null(),
  authorityAudioSha256: sha256Schema,
  sourceAudioSha256: sha256Schema,
  normalization: normalizationSchema,
  observation: measuredObservationSchema,
  error: z.null(),
}).strict().superRefine((phase, context) => {
  if (phase.sourceAudioSha256 !== phase.authorityAudioSha256) {
    context.addIssue({
      code: "custom",
      path: ["sourceAudioSha256"],
      message: "Source audio must match the server-controlled authority audio hash.",
    });
  }
  if (phase.normalization.normalizedAudioSha256 !== phase.observation.sourceAudio.sha256) {
    context.addIssue({
      code: "custom",
      path: ["observation", "sourceAudio", "sha256"],
      message: "The observation must bind the exact normalized audio snapshot.",
    });
  }
  if (phase.normalization.durationMilliseconds
    !== phase.observation.sourceAudio.durationMilliseconds) {
    context.addIssue({
      code: "custom",
      path: ["observation", "sourceAudio", "durationMilliseconds"],
      message: "Normalization and observation durations must identify the same audio snapshot.",
    });
  }
});

const insufficientPhaseSchema = z.object({
  schemaVersion: z.literal(INDEPENDENT_IPA_PHASE_SCHEMA_VERSION),
  status: z.literal("insufficient"),
  reasonCode: z.literal("duration-exceeds-independent-ipa-window"),
  authorityAudioSha256: sha256Schema,
  sourceAudioSha256: sha256Schema,
  normalization: z.null(),
  observation: z.null(),
  error: z.null(),
}).strict().superRefine((phase, context) => {
  if (phase.sourceAudioSha256 !== phase.authorityAudioSha256) {
    context.addIssue({
      code: "custom",
      path: ["sourceAudioSha256"],
      message: "Source audio must match the server-controlled authority audio hash.",
    });
  }
});

const phaseFailureCodeSchema = z.enum([
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

const phaseFailedPhaseSchema = z.object({
  schemaVersion: z.literal(INDEPENDENT_IPA_PHASE_SCHEMA_VERSION),
  status: z.literal("failed"),
  reasonCode: phaseFailureCodeSchema,
  authorityAudioSha256: sha256Schema,
  sourceAudioSha256: sha256Schema.nullable(),
  normalization: normalizationSchema.nullable(),
  observation: z.null(),
  error: z.object({
    code: phaseFailureCodeSchema,
    message: z.string().min(1).max(500),
  }).strict(),
}).strict().superRefine((phase, context) => {
  if (phase.reasonCode !== phase.error.code) {
    context.addIssue({
      code: "custom",
      path: ["error", "code"],
      message: "Phase failure code must match its top-level reason code.",
    });
  }
  if (phase.sourceAudioSha256 !== null
    && phase.sourceAudioSha256 !== phase.authorityAudioSha256) {
    context.addIssue({
      code: "custom",
      path: ["sourceAudioSha256"],
      message: "Source audio must match the server-controlled authority audio hash.",
    });
  }
  if (phase.normalization !== null && phase.sourceAudioSha256 === null) {
    context.addIssue({
      code: "custom",
      path: ["normalization"],
      message: "A completed normalization requires a verified source-audio binding.",
    });
  }
  if (phase.reasonCode === "independent-ipa-runner-failed"
    && (phase.sourceAudioSha256 === null || phase.normalization === null)) {
    context.addIssue({
      code: "custom",
      path: ["reasonCode"],
      message: "A runner failure must preserve the completed source and normalization evidence.",
    });
  }
});

export const independentIpaPhaseSchema = z.union([
  measuredPhaseSchema,
  insufficientPhaseSchema,
  phaseFailedPhaseSchema,
]);

export type IndependentIpaObservation = z.infer<typeof independentIpaObservationSchema>;
export type IndependentIpaPhase = z.infer<typeof independentIpaPhaseSchema>;

export function parseIndependentIpaPhase(value: unknown): IndependentIpaPhase {
  return independentIpaPhaseSchema.parse(value);
}
