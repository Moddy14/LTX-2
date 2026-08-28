import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { TextDecoder } from "node:util";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

import { z } from "zod";

import { canonicalizeJson, canonicalJson } from "../shared/canonicalJson.js";
import {
  LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_BASIS,
  LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_GIB,
} from "../shared/estimates.js";
import {
  LOCAL_PROCESS_RESOURCE_JSONL_BASENAME,
  LOCAL_PROCESS_RESOURCE_MAX_GAP_MS,
  LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS,
  LOCAL_PROCESS_RESOURCE_SUMMARY_BASENAME,
  NVIDIA_PROCESS_MEMORY_QUERY_ARGS,
  NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT,
  NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS,
  NVIDIA_ML_LICENSE_PATH,
  type LocalProcessResourceIdentity,
  type LocalProcessResourceObserverIdentity,
  type LocalProcessResourceSample,
  type LocalProcessResourceTelemetrySummary,
} from "./localProcessResourceTelemetry.js";
import { hostTcbExecutables, SEALED_EXECUTABLE_PATH } from "./config.js";

export const LTX_RESOURCE_TELEMETRY_MANIFEST_BASENAME = "ltx-resource-telemetry.manifest.v1.json";
export const LTX_RESOURCE_MEASUREMENT_MINIMUM_HOST_AVAILABLE_KIB = 12 * 1_048_576;
export const LTX_RESOURCE_OUTPUT_PROBE_TIMEOUT_MS = 15_000;

const LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS = [
  "-v",
  "error",
  "-count_frames",
  "-show_entries",
  "format=duration:stream=codec_type,codec_name,width,height,pix_fmt,nb_read_frames,nb_frames,"
    + "avg_frame_rate,r_frame_rate,duration,start_time,sample_rate,channels,channel_layout",
  "-of",
  "json",
  "/proc/self/fd/3",
] as const;
const LTX_RESOURCE_OUTPUT_PROBE_ENVIRONMENT = Object.freeze({
  PATH: SEALED_EXECUTABLE_PATH,
  LC_ALL: "C",
});
const LTX_RESOURCE_OUTPUT_BLOCKERS = [
  "probe_failed",
  "probe_invalid_json",
  "video_stream_count_not_one",
  "audio_stream_count_not_one",
  "video_geometry_mismatch",
  "video_frame_count_mismatch",
  "video_fps_mismatch",
  "video_not_constant_frame_rate",
  "video_duration_mismatch",
  "audio_sample_rate_unavailable",
  "av_start_unavailable",
  "av_start_delta_exceeded",
  "av_duration_unavailable",
  "av_duration_delta_exceeded",
] as const;

export type LtxResourceTelemetryOutputBlocker = typeof LTX_RESOURCE_OUTPUT_BLOCKERS[number];

export type LtxResourceTelemetryOutputTechnicalReceipt = {
  schemaVersion: "ltx-studio-ltx-resource-output-contract.v1";
  probe: {
    executable: "/usr/bin/ffprobe";
    executableSha256: string;
    arguments: [...typeof LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS];
    timeoutMs: typeof LTX_RESOURCE_OUTPUT_PROBE_TIMEOUT_MS;
    environment: typeof LTX_RESOURCE_OUTPUT_PROBE_ENVIRONMENT;
  };
  media: {
    videoStreamCount: number;
    audioStreamCount: number;
    width: number | null;
    height: number | null;
    frames: number | null;
    averageFps: number | null;
    nominalFps: number | null;
    videoDurationSeconds: number | null;
    videoStartSeconds: number | null;
    audioDurationSeconds: number | null;
    audioStartSeconds: number | null;
    audioSampleRate: number | null;
    videoCodec: string | null;
    pixelFormat: string | null;
    audioCodec: string | null;
  } | null;
  blockers: LtxResourceTelemetryOutputBlocker[];
};

export type LtxResourceTelemetryBoundOutput = {
  path: string;
  sizeBytes: number;
  sha256: string;
  technical: LtxResourceTelemetryOutputTechnicalReceipt;
};

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 16 * 1024 * 1024;
const MAX_JSONL_BYTES = 256 * 1024 * 1024;
const MAX_JSONL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_SAMPLES = 100_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/u;
const SIGNAL_PATTERN = /^SIG[A-Z0-9]{1,24}$/u;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type LtxResourceTelemetryBinding = {
  studioJobId: string;
  dgxJobId: string;
  preparedAdmissionSha256: string;
  declaredMemoryGiB: number;
  requiredMemoryGiB: number;
  memoryBasis: string;
  requestSha256: string;
  runProvenanceFingerprint: string;
  runProvenanceSha256: string;
  cooperativeGeneration: number;
  executable: string;
  argumentsSha256: string;
  processIdentity: LocalProcessResourceIdentity;
  observerIdentity: LocalProcessResourceObserverIdentity;
};

export type LtxResourceTelemetryManifest = {
  schemaVersion: "ltx-studio-ltx-resource-telemetry-manifest.v1";
  binding: LtxResourceTelemetryBinding;
  telemetry: {
    jsonlPath: string;
    jsonlSha256: string;
    summaryPath: string;
    summarySha256: string;
    summary: LocalProcessResourceTelemetrySummary;
  } | null;
  observerError: string | null;
  processOutcome: {
    code: number | null;
    signal: NodeJS.Signals | null;
    error: string | null;
  };
  processGroupGone: boolean;
  processGroupExitedNaturally: boolean;
  thermalPauseCount: number;
  output: LtxResourceTelemetryBoundOutput | null;
  /** Intrinsic single-measurement eligibility only; this never authorizes an estimator reduction. */
  measurementEligibleForCalibration: boolean;
  recordedAt: string;
  fingerprint: string;
};

export type LtxResourceTelemetryMeasurementInput = {
  binding: Pick<LtxResourceTelemetryBinding,
    "cooperativeGeneration" | "declaredMemoryGiB" | "requiredMemoryGiB" | "memoryBasis"
    | "processIdentity" | "observerIdentity">;
  summary: LocalProcessResourceTelemetrySummary | null;
  observerError: string | null;
  result: {
    code: number | null;
    signal: NodeJS.Signals | null;
    error: unknown | null;
  };
  processGroupGone: boolean;
  processGroupExitedNaturally: boolean;
  thermalPauseCount: number;
  outputBound: boolean;
  outputTechnicalValid: boolean;
};

export type VerifyLtxResourceTelemetryEvidenceOptions = {
  /** Exact durable admission/request/provenance/profile binding expected by the caller. */
  expectedBinding?: LtxResourceTelemetryBinding;
  /** Exact output pathname expected by the caller. The file itself is re-hashed through a held FD. */
  expectedOutputPath?: string;
};

export type VerifiedLtxResourceTelemetryEvidence = {
  manifest: LtxResourceTelemetryManifest;
  manifestPath: string;
  manifestSha256: string;
  jsonlSha256: string | null;
  summarySha256: string | null;
  outputSha256: string | null;
  externalBindingMatched: boolean;
  expectedOutputPathMatched: boolean;
};

type ProtectedFileRevision = {
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  gid: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

type ProtectedFilePolicy = {
  label: string;
  maximumBytes: number;
  allowEmpty: boolean;
  exactPermissions: number | null;
};

type ProtectedRead = {
  bytes: Buffer;
  sha256: string;
  revision: ProtectedFileRevision;
};

const sha256Schema = z.string().regex(SHA256_PATTERN);
const nullableNonNegativeIntegerSchema = z.number().int().nonnegative().safe().nullable();
const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const nonNegativeFiniteSchema = z.number().finite().nonnegative();
const absolutePathSchema = z.string().min(1).max(4_096).refine(isExactAbsolutePath);
const isoTimestampSchema = z.string().refine((value) => {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}, "timestamp must be an exact UTC ISO-8601 instant");

const processIdentitySchema = z.object({
  bootId: z.string().regex(BOOT_ID_PATTERN),
  processGroupId: z.number().int().positive().safe(),
  leaderStartTicks: z.string().regex(/^\d+$/u),
}).strict();

const observerIdentitySchema = z.object({
  schemaVersion: z.literal("ltx-studio-local-process-resource-observer.v1"),
  executable: absolutePathSchema,
  executableSha256: sha256Schema,
  versionArguments: z.tuple([z.literal("--version")]),
  versionOutputSha256: sha256Schema,
  versionFirstLine: z.string().min(1).max(2_048).refine((value) => !/[\r\n\0]/u.test(value)),
  queryArguments: z.tuple([
    z.literal(NVIDIA_PROCESS_MEMORY_QUERY_ARGS[0]),
    z.literal(NVIDIA_PROCESS_MEMORY_QUERY_ARGS[1]),
  ]),
  queryTimeoutMs: z.literal(NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS),
  environment: z.object({
    PATH: z.literal(NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT.PATH),
    LC_ALL: z.literal(NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT.LC_ALL),
  }).strict(),
  dynamicLibraries: z.tuple([z.object({
    name: z.literal("nvml"),
    path: absolutePathSchema,
    sha256: sha256Schema,
    licensePath: z.literal(NVIDIA_ML_LICENSE_PATH),
    licenseSha256: sha256Schema,
  }).strict()]),
  residentAccounting: z.literal("vmrss-plus-nvidia-used-memory-conservative-envelope.v1"),
}).strict();

export const ltxResourceTelemetryBindingSchema = z.object({
  studioJobId: z.string().regex(SAFE_SEGMENT_PATTERN),
  dgxJobId: z.string().regex(SAFE_SEGMENT_PATTERN),
  preparedAdmissionSha256: sha256Schema,
  declaredMemoryGiB: z.number().int().positive().safe(),
  requiredMemoryGiB: z.number().int().positive().safe(),
  memoryBasis: z.string().min(1).max(512).refine((value) => !/[\r\n\0]/u.test(value)),
  requestSha256: sha256Schema,
  runProvenanceFingerprint: sha256Schema,
  runProvenanceSha256: sha256Schema,
  cooperativeGeneration: z.number().int().nonnegative().safe(),
  executable: absolutePathSchema,
  argumentsSha256: sha256Schema,
  processIdentity: processIdentitySchema,
  observerIdentity: observerIdentitySchema,
}).strict().superRefine((binding, context) => {
  if (binding.requiredMemoryGiB > binding.declaredMemoryGiB) {
    context.addIssue({
      code: "custom",
      path: ["requiredMemoryGiB"],
      message: "required memory exceeds the admission declaration",
    });
  }
});

const sourceSchema = z.enum([
  "boot_id",
  "leader_stat",
  "meminfo",
  "vmstat",
  "proc_scan",
  "proc_status",
  "process_group_identity",
  "nvidia_smi",
  "monotonic_clock",
]);
const sampleSourceErrorSchema = z.object({
  source: sourceSchema,
  message: z.string().min(1).max(500).refine((value) => !/[\r\n\t\0]/u.test(value)),
}).strict();
const summarySourceErrorSchema = sampleSourceErrorSchema.extend({
  count: z.number().int().positive().safe(),
  firstSequence: z.number().int().positive().safe(),
  lastSequence: z.number().int().positive().safe(),
}).strict();

const localProcessResourceSampleSchema = z.object({
  schemaVersion: z.literal("ltx-studio-local-process-resource-sample.v1"),
  sequence: z.number().int().positive().safe(),
  capturedAt: isoTimestampSchema,
  monotonicMs: nonNegativeFiniteSchema,
  gapMs: nonNegativeFiniteSchema.nullable(),
  identity: processIdentitySchema,
  identityVerified: z.boolean(),
  host: z.object({
    memFreeKiB: nullableNonNegativeIntegerSchema,
    memAvailableKiB: nullableNonNegativeIntegerSchema,
    swapTotalKiB: nullableNonNegativeIntegerSchema,
    swapFreeKiB: nullableNonNegativeIntegerSchema,
    pswpinPages: nullableNonNegativeIntegerSchema,
    pswpoutPages: nullableNonNegativeIntegerSchema,
  }).strict(),
  processGroup: z.object({
    attributionVerified: z.boolean(),
    pids: z.array(z.number().int().positive().safe()).max(1_000_000),
    processCount: nonNegativeIntegerSchema,
    rssAnonKiB: nullableNonNegativeIntegerSchema,
    vmRssKiB: nullableNonNegativeIntegerSchema,
    vmHwmKiB: nullableNonNegativeIntegerSchema,
    vmSwapKiB: nullableNonNegativeIntegerSchema,
    nvidiaUsedMemoryMiB: nullableNonNegativeIntegerSchema,
    accountedResidentKiB: nullableNonNegativeIntegerSchema,
    nvidiaPids: z.array(z.object({
      pid: z.number().int().positive().safe(),
      usedMemoryMiB: nonNegativeIntegerSchema,
    }).strict()).max(1_000_000),
  }).strict(),
  sourceErrors: z.array(sampleSourceErrorSchema).max(32),
}).strict();

const localProcessResourceSummarySchema = z.object({
  schemaVersion: z.literal("ltx-studio-local-process-resource-summary.v1"),
  identity: processIdentitySchema,
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  intervalMs: z.literal(LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS),
  maximumPermittedGapMs: z.literal(LOCAL_PROCESS_RESOURCE_MAX_GAP_MS),
  observer: observerIdentitySchema,
  sampleCount: z.number().int().nonnegative().max(MAX_SAMPLES),
  lastSuccessfulSequence: z.number().int().positive().safe().nullable(),
  terminalGapMs: nonNegativeFiniteSchema.nullable(),
  maxGapMs: nonNegativeFiniteSchema.nullable(),
  quality: z.enum(["sufficient", "insufficient"]),
  qualityReasons: z.array(z.enum(["no_samples", "sample_gap_exceeded", "source_errors"])).max(3),
  sourceErrors: z.array(summarySourceErrorSchema).max(MAX_SAMPLES * 32),
  jsonl: z.object({
    name: z.literal(LOCAL_PROCESS_RESOURCE_JSONL_BASENAME),
    bytes: nonNegativeIntegerSchema,
    sha256: sha256Schema,
  }).strict(),
  metrics: z.object({
    host: z.object({
      minimumMemFreeKiB: nullableNonNegativeIntegerSchema,
      minimumMemAvailableKiB: nullableNonNegativeIntegerSchema,
      swapTotalKiB: nullableNonNegativeIntegerSchema,
      minimumSwapFreeKiB: nullableNonNegativeIntegerSchema,
      pswpinDeltaPages: nullableNonNegativeIntegerSchema,
      pswpoutDeltaPages: nullableNonNegativeIntegerSchema,
    }).strict(),
    processGroup: z.object({
      maximumProcessCount: nullableNonNegativeIntegerSchema,
      maximumRssAnonKiB: nullableNonNegativeIntegerSchema,
      maximumVmRssKiB: nullableNonNegativeIntegerSchema,
      maximumVmHwmKiB: nullableNonNegativeIntegerSchema,
      maximumVmSwapKiB: nullableNonNegativeIntegerSchema,
      maximumNvidiaUsedMemoryMiB: nullableNonNegativeIntegerSchema,
      maximumAccountedResidentKiB: nullableNonNegativeIntegerSchema,
    }).strict(),
  }).strict(),
}).strict();

const telemetrySchema = z.object({
  jsonlPath: absolutePathSchema,
  jsonlSha256: sha256Schema,
  summaryPath: absolutePathSchema,
  summarySha256: sha256Schema,
  summary: localProcessResourceSummarySchema,
}).strict();

const outputTechnicalReceiptSchema = z.object({
  schemaVersion: z.literal("ltx-studio-ltx-resource-output-contract.v1"),
  probe: z.object({
    executable: z.literal("/usr/bin/ffprobe"),
    executableSha256: sha256Schema,
    arguments: z.tuple([
      z.literal(LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS[0]),
      z.literal(LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS[1]),
      z.literal(LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS[2]),
      z.literal(LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS[3]),
      z.literal(LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS[4]),
      z.literal(LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS[5]),
      z.literal(LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS[6]),
      z.literal(LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS[7]),
    ]),
    timeoutMs: z.literal(LTX_RESOURCE_OUTPUT_PROBE_TIMEOUT_MS),
    environment: z.object({
      PATH: z.literal(LTX_RESOURCE_OUTPUT_PROBE_ENVIRONMENT.PATH),
      LC_ALL: z.literal(LTX_RESOURCE_OUTPUT_PROBE_ENVIRONMENT.LC_ALL),
    }).strict(),
  }).strict(),
  media: z.object({
    videoStreamCount: nonNegativeIntegerSchema,
    audioStreamCount: nonNegativeIntegerSchema,
    width: nullableNonNegativeIntegerSchema,
    height: nullableNonNegativeIntegerSchema,
    frames: nullableNonNegativeIntegerSchema,
    averageFps: nonNegativeFiniteSchema.nullable(),
    nominalFps: nonNegativeFiniteSchema.nullable(),
    videoDurationSeconds: nonNegativeFiniteSchema.nullable(),
    videoStartSeconds: z.number().finite().nullable(),
    audioDurationSeconds: nonNegativeFiniteSchema.nullable(),
    audioStartSeconds: z.number().finite().nullable(),
    audioSampleRate: nullableNonNegativeIntegerSchema,
    videoCodec: z.string().min(1).max(128).nullable(),
    pixelFormat: z.string().min(1).max(128).nullable(),
    audioCodec: z.string().min(1).max(128).nullable(),
  }).strict().nullable(),
  blockers: z.array(z.enum(LTX_RESOURCE_OUTPUT_BLOCKERS)).max(LTX_RESOURCE_OUTPUT_BLOCKERS.length),
}).strict();

export const ltxResourceTelemetryManifestSchema = z.object({
  schemaVersion: z.literal("ltx-studio-ltx-resource-telemetry-manifest.v1"),
  binding: ltxResourceTelemetryBindingSchema,
  telemetry: telemetrySchema.nullable(),
  observerError: z.string().min(1).max(8_192).refine((value) => !/[\r\n\t\0]/u.test(value)).nullable(),
  processOutcome: z.object({
    code: z.number().int().safe().nullable(),
    signal: z.string().regex(SIGNAL_PATTERN).nullable(),
    error: z.string().min(1).max(1_000).refine((value) => !/[\r\n\t\0]/u.test(value)).nullable(),
  }).strict(),
  processGroupGone: z.boolean(),
  processGroupExitedNaturally: z.boolean(),
  thermalPauseCount: z.number().int().nonnegative().safe(),
  output: z.object({
    path: absolutePathSchema,
    sizeBytes: z.number().int().positive().safe(),
    sha256: sha256Schema,
    technical: outputTechnicalReceiptSchema,
  }).strict().nullable(),
  measurementEligibleForCalibration: z.boolean(),
  recordedAt: isoTimestampSchema,
  fingerprint: sha256Schema,
}).strict();

function isExactAbsolutePath(value: string): boolean {
  return isAbsolute(value)
    && normalize(value) === value
    && resolve(value) === value
    && !value.includes("\0");
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileRevision(stats: Stats): ProtectedFileRevision {
  return {
    dev: stats.dev,
    ino: stats.ino,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function revisionsEqual(left: ProtectedFileRevision, right: ProtectedFileRevision): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertTrustedFile(stats: Stats, policy: ProtectedFilePolicy): ProtectedFileRevision {
  const expectedUid = process.getuid?.();
  const expectedGid = process.getgid?.();
  if (!stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1
    || (expectedUid !== undefined && stats.uid !== expectedUid)
    || (expectedGid !== undefined && stats.gid !== expectedGid)
    || (policy.exactPermissions !== null && (stats.mode & 0o7777) !== policy.exactPermissions)
    || stats.size < (policy.allowEmpty ? 0 : 1)
    || stats.size > policy.maximumBytes
    || !Number.isSafeInteger(stats.size)) {
    throw new Error(`${policy.label} is not a trusted, private, bounded regular file`);
  }
  return fileRevision(stats);
}

function assertUnaliasedPath(path: string, label: string): void {
  if (!isExactAbsolutePath(path) || realpathSync(path) !== path) {
    throw new Error(`${label} path is not exact or traverses a symbolic link`);
  }
}

function readExactDescriptor(descriptor: number, size: number, label: string): Buffer {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const count = readSync(descriptor, bytes, offset, size - offset, offset);
    if (count <= 0) throw new Error(`${label} ended before its bound size while reading`);
    offset += count;
  }
  return bytes;
}

function readProtectedFile(path: string, policy: ProtectedFilePolicy): ProtectedRead {
  assertUnaliasedPath(path, policy.label);
  const pathBeforeStats = lstatSync(path);
  if (pathBeforeStats.isSymbolicLink()) throw new Error(`${policy.label} is a symbolic link`);
  const pathBefore = assertTrustedFile(pathBeforeStats, policy);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorBefore = assertTrustedFile(fstatSync(descriptor), policy);
    if (!revisionsEqual(pathBefore, descriptorBefore)) {
      throw new Error(`${policy.label} was replaced before its descriptor was bound`);
    }
    const first = readExactDescriptor(descriptor, descriptorBefore.size, policy.label);
    const descriptorMid = assertTrustedFile(fstatSync(descriptor), policy);
    const second = readExactDescriptor(descriptor, descriptorBefore.size, policy.label);
    const descriptorAfter = assertTrustedFile(fstatSync(descriptor), policy);
    const pathAfterStats = lstatSync(path);
    if (pathAfterStats.isSymbolicLink()) throw new Error(`${policy.label} path became a symbolic link`);
    const pathAfter = assertTrustedFile(pathAfterStats, policy);
    assertUnaliasedPath(path, policy.label);
    if (!revisionsEqual(descriptorBefore, descriptorMid)
      || !revisionsEqual(descriptorBefore, descriptorAfter)
      || !revisionsEqual(descriptorBefore, pathAfter)
      || !first.equals(second)) {
      throw new Error(`${policy.label} changed or was replaced during its held-descriptor reads`);
    }
    return { bytes: first, sha256: sha256(first), revision: descriptorAfter };
  } finally {
    closeSync(descriptor);
  }
}

function hashDescriptor(descriptor: number, size: number, label: string): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const requested = Math.min(buffer.byteLength, size - offset);
    const count = readSync(descriptor, buffer, 0, requested, offset);
    if (count <= 0) throw new Error(`${label} ended before its bound size while hashing`);
    digest.update(buffer.subarray(0, count));
    offset += count;
  }
  return digest.digest("hex");
}

function optionalProbeString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 128 ? value : null;
}

function finiteProbeNumber(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonNegativeProbeInteger(value: unknown): number | null {
  const parsed = finiteProbeNumber(value);
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function probeRate(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const [rawNumerator, rawDenominator] = value.split("/");
  if (rawDenominator === undefined) {
    const parsed = finiteProbeNumber(rawNumerator);
    return parsed !== null && parsed >= 0 ? parsed : null;
  }
  const numerator = Number(rawNumerator);
  const denominator = Number(rawDenominator);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const parsed = numerator / denominator;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function outputContractReceipt(
  executableSha256: string,
  result: ReturnType<typeof spawnSync>,
): LtxResourceTelemetryOutputTechnicalReceipt {
  const probe: LtxResourceTelemetryOutputTechnicalReceipt["probe"] = {
    executable: hostTcbExecutables.ffprobe as "/usr/bin/ffprobe",
    executableSha256,
    arguments: [...LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS] as [...typeof LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS],
    timeoutMs: LTX_RESOURCE_OUTPUT_PROBE_TIMEOUT_MS,
    environment: { ...LTX_RESOURCE_OUTPUT_PROBE_ENVIRONMENT },
  };
  if (result.error || result.status !== 0 || typeof result.stdout !== "string" || result.stdout.length === 0) {
    return {
      schemaVersion: "ltx-studio-ltx-resource-output-contract.v1",
      probe,
      media: null,
      blockers: ["probe_failed"],
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(result.stdout) as unknown;
  } catch {
    return {
      schemaVersion: "ltx-studio-ltx-resource-output-contract.v1",
      probe,
      media: null,
      blockers: ["probe_invalid_json"],
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      schemaVersion: "ltx-studio-ltx-resource-output-contract.v1",
      probe,
      media: null,
      blockers: ["probe_invalid_json"],
    };
  }
  const streams = Array.isArray((raw as { streams?: unknown }).streams)
    ? (raw as { streams: unknown[] }).streams.filter(
        (stream): stream is Record<string, unknown> => Boolean(stream)
          && typeof stream === "object"
          && !Array.isArray(stream),
      )
    : [];
  const videoStreams = streams.filter((stream) => stream.codec_type === "video");
  const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
  const video = videoStreams[0];
  const audio = audioStreams[0];
  const format = (raw as { format?: unknown }).format;
  const formatRecord = format && typeof format === "object" && !Array.isArray(format)
    ? format as Record<string, unknown>
    : null;
  const media: NonNullable<LtxResourceTelemetryOutputTechnicalReceipt["media"]> = {
    videoStreamCount: videoStreams.length,
    audioStreamCount: audioStreams.length,
    width: nonNegativeProbeInteger(video?.width),
    height: nonNegativeProbeInteger(video?.height),
    frames: nonNegativeProbeInteger(video?.nb_read_frames) ?? nonNegativeProbeInteger(video?.nb_frames),
    averageFps: probeRate(video?.avg_frame_rate),
    nominalFps: probeRate(video?.r_frame_rate),
    videoDurationSeconds: finiteProbeNumber(video?.duration) ?? finiteProbeNumber(formatRecord?.duration),
    videoStartSeconds: finiteProbeNumber(video?.start_time),
    audioDurationSeconds: finiteProbeNumber(audio?.duration) ?? (audio ? finiteProbeNumber(formatRecord?.duration) : null),
    audioStartSeconds: finiteProbeNumber(audio?.start_time),
    audioSampleRate: nonNegativeProbeInteger(audio?.sample_rate),
    videoCodec: optionalProbeString(video?.codec_name),
    pixelFormat: optionalProbeString(video?.pix_fmt),
    audioCodec: optionalProbeString(audio?.codec_name),
  };
  const expectedDurationSeconds = 289 / 24;
  const blockers: LtxResourceTelemetryOutputBlocker[] = [];
  if (media.videoStreamCount !== 1) blockers.push("video_stream_count_not_one");
  if (media.audioStreamCount !== 1) blockers.push("audio_stream_count_not_one");
  if (media.width !== 1_024 || media.height !== 1_536) blockers.push("video_geometry_mismatch");
  if (media.frames !== 289) blockers.push("video_frame_count_mismatch");
  if (media.averageFps === null || Math.abs(media.averageFps - 24) > 0.001
    || media.nominalFps === null || Math.abs(media.nominalFps - 24) > 0.001) {
    blockers.push("video_fps_mismatch");
  }
  if (media.averageFps === null || media.nominalFps === null
    || Math.abs(media.averageFps - media.nominalFps) > 0.001) {
    blockers.push("video_not_constant_frame_rate");
  }
  if (media.videoDurationSeconds === null
    || Math.abs(media.videoDurationSeconds - expectedDurationSeconds) > 0.04) {
    blockers.push("video_duration_mismatch");
  }
  if (media.audioSampleRate === null || media.audioSampleRate <= 0) {
    blockers.push("audio_sample_rate_unavailable");
  }
  if (media.videoStartSeconds === null || media.audioStartSeconds === null) {
    blockers.push("av_start_unavailable");
  } else if (Math.abs(media.videoStartSeconds - media.audioStartSeconds) > 0.04) {
    blockers.push("av_start_delta_exceeded");
  }
  if (media.videoDurationSeconds === null || media.audioDurationSeconds === null) {
    blockers.push("av_duration_unavailable");
  } else if (Math.abs(media.videoDurationSeconds - media.audioDurationSeconds) > 0.04) {
    blockers.push("av_duration_delta_exceeded");
  }
  return {
    schemaVersion: "ltx-studio-ltx-resource-output-contract.v1",
    probe,
    media,
    blockers,
  };
}

function trustedHostExecutableRevision(stats: Stats): ProtectedFileRevision {
  if (!stats.isFile()
    || stats.isSymbolicLink()
    || stats.nlink !== 1
    || stats.uid !== 0
    || stats.gid !== 0
    || (stats.mode & 0o022) !== 0
    || (stats.mode & 0o111) === 0
    || stats.size <= 0
    || !Number.isSafeInteger(stats.size)) {
    throw new Error("bound telemetry ffprobe is not a trusted root-owned executable");
  }
  return fileRevision(stats);
}

/**
 * Hash and technically inspect the exact IA2V output through held descriptors.
 * Both the media payload and the root-owned ffprobe ELF are hashed before and
 * after the probe; ffprobe receives only /proc/self/fd/3 and is itself executed
 * through /proc/self/fd/4, eliminating pathname substitution during analysis.
 */
export function captureLtxResourceTelemetryOutput(path: string): LtxResourceTelemetryBoundOutput {
  const policy: ProtectedFilePolicy = {
    label: "bound telemetry output",
    maximumBytes: MAX_OUTPUT_BYTES,
    allowEmpty: false,
    // Studio media currently inherits the user's 0664 umask policy. Its
    // evidence files, unlike the media payload, are required to be 0600.
    exactPermissions: null,
  };
  assertUnaliasedPath(path, policy.label);
  const pathBeforeStats = lstatSync(path);
  if (pathBeforeStats.isSymbolicLink()) throw new Error(`${policy.label} is a symbolic link`);
  const pathBefore = assertTrustedFile(pathBeforeStats, policy);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const ffprobePath = hostTcbExecutables.ffprobe;
  assertUnaliasedPath(ffprobePath, "bound telemetry ffprobe");
  const ffprobePathBefore = trustedHostExecutableRevision(lstatSync(ffprobePath));
  const ffprobeDescriptor = openSync(ffprobePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorBefore = assertTrustedFile(fstatSync(descriptor), policy);
    if (!revisionsEqual(pathBefore, descriptorBefore)) {
      throw new Error(`${policy.label} was replaced before its descriptor was bound`);
    }
    const firstSha256 = hashDescriptor(descriptor, descriptorBefore.size, policy.label);
    const ffprobeDescriptorBefore = trustedHostExecutableRevision(fstatSync(ffprobeDescriptor));
    if (!revisionsEqual(ffprobePathBefore, ffprobeDescriptorBefore)) {
      throw new Error("bound telemetry ffprobe was replaced before its descriptor was bound");
    }
    const ffprobeSha256Before = hashDescriptor(
      ffprobeDescriptor,
      ffprobeDescriptorBefore.size,
      "bound telemetry ffprobe",
    );
    const probeResult = spawnSync(
      "/proc/self/fd/4",
      [...LTX_RESOURCE_OUTPUT_PROBE_ARGUMENTS],
      {
        encoding: "utf8",
        env: LTX_RESOURCE_OUTPUT_PROBE_ENVIRONMENT,
        timeout: LTX_RESOURCE_OUTPUT_PROBE_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe", descriptor, ffprobeDescriptor],
      },
    );
    const descriptorMid = assertTrustedFile(fstatSync(descriptor), policy);
    const secondSha256 = hashDescriptor(descriptor, descriptorBefore.size, policy.label);
    const descriptorAfter = assertTrustedFile(fstatSync(descriptor), policy);
    const pathAfterStats = lstatSync(path);
    if (pathAfterStats.isSymbolicLink()) throw new Error(`${policy.label} path became a symbolic link`);
    const pathAfter = assertTrustedFile(pathAfterStats, policy);
    const ffprobeDescriptorAfter = trustedHostExecutableRevision(fstatSync(ffprobeDescriptor));
    const ffprobePathAfter = trustedHostExecutableRevision(lstatSync(ffprobePath));
    const ffprobeSha256After = hashDescriptor(
      ffprobeDescriptor,
      ffprobeDescriptorBefore.size,
      "bound telemetry ffprobe",
    );
    assertUnaliasedPath(path, policy.label);
    assertUnaliasedPath(ffprobePath, "bound telemetry ffprobe");
    if (!revisionsEqual(descriptorBefore, descriptorMid)
      || !revisionsEqual(descriptorBefore, descriptorAfter)
      || !revisionsEqual(descriptorBefore, pathAfter)
      || firstSha256 !== secondSha256
      || !revisionsEqual(ffprobeDescriptorBefore, ffprobeDescriptorAfter)
      || !revisionsEqual(ffprobeDescriptorBefore, ffprobePathAfter)
      || ffprobeSha256Before !== ffprobeSha256After) {
      throw new Error(`${policy.label} changed or was replaced during its held-descriptor hashes`);
    }
    return {
      path,
      sizeBytes: descriptorAfter.size,
      sha256: firstSha256,
      technical: outputContractReceipt(ffprobeSha256After, probeResult),
    };
  } finally {
    closeSync(ffprobeDescriptor);
    closeSync(descriptor);
  }
}

function decodeJson(bytes: Buffer, label: string): unknown {
  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function minimum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.min(...present) : null;
}

function maximum(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? Math.max(...present) : null;
}

function counterDelta(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length > 0 ? present.at(-1)! - present[0]! : null;
}

function requireCanonicalEquality(left: unknown, right: unknown, message: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) throw new Error(message);
}

function validateSampleInternals(sample: LocalProcessResourceSample): void {
  const { processGroup } = sample;
  const pids = [...processGroup.pids];
  const sortedPids = [...new Set(pids)].sort((left, right) => left - right);
  if (canonicalJson(pids) !== canonicalJson(sortedPids) || processGroup.processCount !== pids.length) {
    throw new Error(`telemetry sample ${sample.sequence} has an inconsistent process-group PID set`);
  }
  if (!sample.identityVerified && processGroup.attributionVerified) {
    throw new Error(`telemetry sample ${sample.sequence} attributes memory without a verified identity`);
  }
  const nvidiaPids = processGroup.nvidiaPids.map(({ pid }) => pid);
  const sortedNvidiaPids = [...new Set(nvidiaPids)].sort((left, right) => left - right);
  if (canonicalJson(nvidiaPids) !== canonicalJson(sortedNvidiaPids)
    || nvidiaPids.some((pid) => !pids.includes(pid))) {
    throw new Error(`telemetry sample ${sample.sequence} has an inconsistent NVIDIA PID set`);
  }
  if (!processGroup.attributionVerified) {
    const untrustedMetrics = [
      processGroup.rssAnonKiB,
      processGroup.vmRssKiB,
      processGroup.vmHwmKiB,
      processGroup.vmSwapKiB,
      processGroup.nvidiaUsedMemoryMiB,
      processGroup.accountedResidentKiB,
    ];
    if (untrustedMetrics.some((value) => value !== null) || processGroup.nvidiaPids.length > 0) {
      throw new Error(`telemetry sample ${sample.sequence} retains metrics after attribution failed`);
    }
  } else if (processGroup.rssAnonKiB === null
    || processGroup.vmRssKiB === null
    || processGroup.vmHwmKiB === null
    || processGroup.vmSwapKiB === null) {
    throw new Error(`telemetry sample ${sample.sequence} omits process metrics after attribution succeeded`);
  }
  if (processGroup.nvidiaUsedMemoryMiB === null) {
    if (processGroup.nvidiaPids.length > 0 || processGroup.accountedResidentKiB !== null) {
      throw new Error(`telemetry sample ${sample.sequence} has partial NVIDIA accounting`);
    }
  } else {
    const nvidiaTotal = processGroup.nvidiaPids.reduce((total, entry) => total + entry.usedMemoryMiB, 0);
    const expectedResident = processGroup.vmRssKiB === null
      ? null
      : processGroup.vmRssKiB + processGroup.nvidiaUsedMemoryMiB * 1_024;
    if (nvidiaTotal !== processGroup.nvidiaUsedMemoryMiB
      || processGroup.accountedResidentKiB !== expectedResident) {
      throw new Error(`telemetry sample ${sample.sequence} has inconsistent NVIDIA/resident accounting`);
    }
  }
  const uniqueErrors = new Set(sample.sourceErrors.map((error) => `${error.source}\0${error.message}`));
  if (uniqueErrors.size !== sample.sourceErrors.length) {
    throw new Error(`telemetry sample ${sample.sequence} repeats one source error`);
  }
}

function aggregateSourceErrors(samples: readonly LocalProcessResourceSample[]): LocalProcessResourceTelemetrySummary["sourceErrors"] {
  const aggregate = new Map<string, LocalProcessResourceTelemetrySummary["sourceErrors"][number]>();
  for (const sample of samples) {
    for (const error of sample.sourceErrors) {
      const key = `${error.source}\0${error.message}`;
      const previous = aggregate.get(key);
      if (previous) {
        previous.count += 1;
        previous.lastSequence = sample.sequence;
      } else {
        aggregate.set(key, {
          ...error,
          count: 1,
          firstSequence: sample.sequence,
          lastSequence: sample.sequence,
        });
      }
    }
  }
  return [...aggregate.values()].sort((left, right) =>
    left.source.localeCompare(right.source) || left.message.localeCompare(right.message));
}

function validateSummaryAgainstSamples(
  summary: LocalProcessResourceTelemetrySummary,
  samples: readonly LocalProcessResourceSample[],
): void {
  if (summary.sampleCount !== samples.length) {
    throw new Error("telemetry summary sample count does not match its JSONL");
  }
  if (summary.startedAt !== (samples[0]?.capturedAt ?? summary.finishedAt)) {
    throw new Error("telemetry summary start time does not match its JSONL");
  }
  let previousMonotonicMs: number | null = null;
  for (const [index, sample] of samples.entries()) {
    if (sample.sequence !== index + 1) throw new Error("telemetry JSONL sequence is not contiguous");
    const expectedGap = previousMonotonicMs === null ? null : sample.monotonicMs - previousMonotonicMs;
    if (expectedGap !== sample.gapMs || (expectedGap !== null && expectedGap < 0)) {
      throw new Error(`telemetry sample ${sample.sequence} has an invalid monotonic gap`);
    }
    previousMonotonicMs = sample.monotonicMs;
    validateSampleInternals(sample);
  }
  const lastSuccessful = [...samples].reverse().find((sample) =>
    sample.sourceErrors.length === 0
    && sample.identityVerified
    && sample.processGroup.attributionVerified);
  if (summary.lastSuccessfulSequence !== (lastSuccessful?.sequence ?? null)
    || (lastSuccessful === undefined) !== (summary.terminalGapMs === null)) {
    throw new Error("telemetry summary terminal success binding is inconsistent");
  }
  const expectedMaxGap = maximum([
    ...samples.map((sample) => sample.gapMs),
    summary.terminalGapMs,
  ]);
  if (summary.maxGapMs !== expectedMaxGap) {
    throw new Error("telemetry summary maximum gap is inconsistent");
  }
  const expectedSourceErrors = aggregateSourceErrors(samples);
  requireCanonicalEquality(
    summary.sourceErrors,
    expectedSourceErrors,
    "telemetry summary source-error aggregation is inconsistent",
  );
  const expectedReasons: LocalProcessResourceTelemetrySummary["qualityReasons"] = [];
  if (samples.length === 0) expectedReasons.push("no_samples");
  if (expectedMaxGap !== null && expectedMaxGap > LOCAL_PROCESS_RESOURCE_MAX_GAP_MS) {
    expectedReasons.push("sample_gap_exceeded");
  }
  if (expectedSourceErrors.length > 0) expectedReasons.push("source_errors");
  requireCanonicalEquality(
    summary.qualityReasons,
    expectedReasons,
    "telemetry summary quality reasons are inconsistent",
  );
  if (summary.quality !== (expectedReasons.length === 0 ? "sufficient" : "insufficient")) {
    throw new Error("telemetry summary quality verdict is inconsistent");
  }
  const expectedMetrics: LocalProcessResourceTelemetrySummary["metrics"] = {
    host: {
      minimumMemFreeKiB: minimum(samples.map((sample) => sample.host.memFreeKiB)),
      minimumMemAvailableKiB: minimum(samples.map((sample) => sample.host.memAvailableKiB)),
      swapTotalKiB: maximum(samples.map((sample) => sample.host.swapTotalKiB)),
      minimumSwapFreeKiB: minimum(samples.map((sample) => sample.host.swapFreeKiB)),
      pswpinDeltaPages: counterDelta(samples.map((sample) => sample.host.pswpinPages)),
      pswpoutDeltaPages: counterDelta(samples.map((sample) => sample.host.pswpoutPages)),
    },
    processGroup: {
      maximumProcessCount: maximum(samples.map((sample) =>
        sample.processGroup.attributionVerified ? sample.processGroup.processCount : null)),
      maximumRssAnonKiB: maximum(samples.map((sample) => sample.processGroup.rssAnonKiB)),
      maximumVmRssKiB: maximum(samples.map((sample) => sample.processGroup.vmRssKiB)),
      maximumVmHwmKiB: maximum(samples.map((sample) => sample.processGroup.vmHwmKiB)),
      maximumVmSwapKiB: maximum(samples.map((sample) => sample.processGroup.vmSwapKiB)),
      maximumNvidiaUsedMemoryMiB: maximum(samples.map((sample) =>
        sample.processGroup.nvidiaUsedMemoryMiB)),
      maximumAccountedResidentKiB: maximum(samples.map((sample) =>
        sample.processGroup.accountedResidentKiB)),
    },
  };
  requireCanonicalEquality(
    summary.metrics,
    expectedMetrics,
    "telemetry summary metrics are inconsistent with its JSONL",
  );
}

function parseJsonl(bytes: Buffer): LocalProcessResourceSample[] {
  if (bytes.byteLength === 0) return [];
  let text: string;
  try {
    text = utf8Decoder.decode(bytes);
  } catch (error) {
    throw new Error("telemetry JSONL is not valid UTF-8", { cause: error });
  }
  if (!text.endsWith("\n") || text.includes("\r")) {
    throw new Error("telemetry JSONL is not newline-canonical");
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > MAX_SAMPLES || lines.some((line) => Buffer.byteLength(line, "utf8") > MAX_JSONL_LINE_BYTES)) {
    throw new Error("telemetry JSONL exceeds its bounded sample or line count");
  }
  return lines.map((line, index) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`telemetry JSONL line ${index + 1} is invalid JSON`, { cause: error });
    }
    const sample = localProcessResourceSampleSchema.parse(raw) as LocalProcessResourceSample;
    if (JSON.stringify(canonicalizeJson(sample)) !== line) {
      throw new Error(`telemetry JSONL line ${index + 1} is not canonical`);
    }
    return sample;
  });
}

/** Shared, side-effect-free single-measurement gate used by persistence and verification. */
export function ltxResourceTelemetryMeasurementBlockers(
  input: LtxResourceTelemetryMeasurementInput,
): string[] {
  const { binding, summary, result } = input;
  return [
    ...(summary?.qualityReasons ?? ["summary_missing"]),
    input.observerError,
    !input.processGroupGone ? "process_group_not_confirmed_gone" : null,
    !input.processGroupExitedNaturally ? "process_group_required_forced_cleanup" : null,
    input.thermalPauseCount !== 0 ? "thermal_pause_observed" : null,
    binding.cooperativeGeneration !== 0 ? "resumed_generation_requires_job_rollup" : null,
    binding.memoryBasis !== LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_BASIS
      || binding.declaredMemoryGiB !== LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_GIB
      || binding.requiredMemoryGiB !== LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_GIB
      ? "memory_profile_not_exact" : null,
    summary && canonicalJson(summary.observer) !== canonicalJson(binding.observerIdentity)
      ? "observer_identity_mismatch" : null,
    summary && canonicalJson(summary.identity) !== canonicalJson(binding.processIdentity)
      ? "process_identity_mismatch" : null,
    summary && summary.sampleCount < 2 ? "fewer_than_two_samples" : null,
    summary?.metrics.processGroup.maximumVmSwapKiB !== 0 ? "process_group_swap_observed" : null,
    summary?.metrics.host.pswpinDeltaPages !== 0 ? "host_swap_in_observed" : null,
    summary?.metrics.host.pswpoutDeltaPages !== 0 ? "host_swap_out_observed" : null,
    (summary?.metrics.host.minimumMemAvailableKiB ?? -1)
      < LTX_RESOURCE_MEASUREMENT_MINIMUM_HOST_AVAILABLE_KIB
      ? "host_minimum_available_below_12_gib" : null,
    summary?.metrics.processGroup.maximumAccountedResidentKiB === null
      ? "resident_peak_missing" : null,
    (summary?.metrics.processGroup.maximumAccountedResidentKiB ?? Number.POSITIVE_INFINITY)
      > binding.declaredMemoryGiB * 1_048_576
      ? "resident_peak_exceeds_declared_memory" : null,
    result.error ? "process_error" : null,
    result.signal ? `process_signal_${result.signal}` : null,
    result.code !== 0 ? `process_exit_${String(result.code)}` : null,
    !input.outputBound ? "output_unbound" : null,
    !input.outputTechnicalValid ? "output_technical_contract_invalid" : null,
  ].filter((value): value is string => Boolean(value));
}

function intrinsicMeasurementEligibleForCalibration(manifest: LtxResourceTelemetryManifest): boolean {
  const summary = manifest.telemetry?.summary ?? null;
  return summary?.quality === "sufficient"
    && ltxResourceTelemetryMeasurementBlockers({
      binding: manifest.binding,
      summary,
      observerError: manifest.observerError,
      result: manifest.processOutcome,
      processGroupGone: manifest.processGroupGone,
      processGroupExitedNaturally: manifest.processGroupExitedNaturally,
      thermalPauseCount: manifest.thermalPauseCount,
      outputBound: manifest.output !== null,
      outputTechnicalValid: manifest.output?.technical.blockers.length === 0,
    }).length === 0;
}

function validateManifestTopology(manifestPath: string, binding: LtxResourceTelemetryBinding): string {
  if (basename(manifestPath) !== LTX_RESOURCE_TELEMETRY_MANIFEST_BASENAME) {
    throw new Error("telemetry manifest does not use its versioned basename");
  }
  const evidenceDirectory = dirname(manifestPath);
  if (basename(evidenceDirectory) !== `ltx-g${binding.cooperativeGeneration}`
    || basename(dirname(evidenceDirectory)) !== binding.studioJobId
    || basename(dirname(dirname(evidenceDirectory))) !== "resource-telemetry") {
    throw new Error("telemetry manifest path is not bound to its Studio job and cooperative generation");
  }
  return evidenceDirectory;
}

/**
 * Fail-closed verifier for a persisted LTX resource-telemetry evidence set.
 *
 * Evidence files are read twice through held O_NOFOLLOW descriptors and must
 * remain private (0600), singly linked and owned by the current service user.
 * The media output is likewise identity-stable and singly linked, but retains
 * Studio's existing media permissions. This function proves intrinsic
 * measurement consistency; callers still bind the returned raw manifest hash
 * into durable run provenance before treating it as calibration authority.
 */
export function verifyLtxResourceTelemetryEvidence(
  manifestPath: string,
  options: VerifyLtxResourceTelemetryEvidenceOptions = {},
): VerifiedLtxResourceTelemetryEvidence {
  if (!isExactAbsolutePath(manifestPath)) throw new Error("telemetry manifest path must be exact and absolute");
  const manifestFile = readProtectedFile(manifestPath, {
    label: "telemetry manifest",
    maximumBytes: MAX_MANIFEST_BYTES,
    allowEmpty: false,
    exactPermissions: 0o600,
  });
  const rawManifest = decodeJson(manifestFile.bytes, "telemetry manifest");
  const parsedManifest = ltxResourceTelemetryManifestSchema.parse(rawManifest);
  const manifest = parsedManifest as LtxResourceTelemetryManifest;
  const expectedManifestBytes = Buffer.from(`${JSON.stringify(parsedManifest, null, 2)}\n`, "utf8");
  if (!manifestFile.bytes.equals(expectedManifestBytes)) {
    throw new Error("telemetry manifest serialization is not exact or contains duplicate/non-canonical JSON");
  }
  const { fingerprint, ...unsignedManifest } = manifest;
  if (sha256(canonicalJson(unsignedManifest)) !== fingerprint) {
    throw new Error("telemetry manifest fingerprint does not match its canonical payload");
  }
  const evidenceDirectory = validateManifestTopology(manifestPath, manifest.binding);
  if (options.expectedBinding) {
    const expectedBinding = ltxResourceTelemetryBindingSchema.parse(options.expectedBinding);
    requireCanonicalEquality(
      manifest.binding,
      expectedBinding,
      "telemetry manifest does not match the expected admission/request/provenance/profile binding",
    );
  }
  if (manifest.processGroupExitedNaturally && !manifest.processGroupGone) {
    throw new Error("telemetry manifest claims natural process-group exit without confirmed absence");
  }
  let jsonlSha256: string | null = null;
  let summarySha256: string | null = null;
  if (manifest.telemetry) {
    const expectedJsonlPath = join(evidenceDirectory, LOCAL_PROCESS_RESOURCE_JSONL_BASENAME);
    const expectedSummaryPath = join(evidenceDirectory, LOCAL_PROCESS_RESOURCE_SUMMARY_BASENAME);
    if (manifest.telemetry.jsonlPath !== expectedJsonlPath
      || manifest.telemetry.summaryPath !== expectedSummaryPath) {
      throw new Error("telemetry manifest references files outside its exact evidence siblings");
    }
    const jsonlFile = readProtectedFile(expectedJsonlPath, {
      label: "telemetry JSONL",
      maximumBytes: MAX_JSONL_BYTES,
      allowEmpty: true,
      exactPermissions: 0o600,
    });
    const summaryFile = readProtectedFile(expectedSummaryPath, {
      label: "telemetry summary",
      maximumBytes: MAX_SUMMARY_BYTES,
      allowEmpty: false,
      exactPermissions: 0o600,
    });
    jsonlSha256 = jsonlFile.sha256;
    summarySha256 = summaryFile.sha256;
    if (jsonlSha256 !== manifest.telemetry.jsonlSha256
      || summarySha256 !== manifest.telemetry.summarySha256) {
      throw new Error("telemetry evidence file SHA-256 does not match its manifest");
    }
    const rawSummary = decodeJson(summaryFile.bytes, "telemetry summary");
    const parsedSummary = localProcessResourceSummarySchema.parse(rawSummary) as LocalProcessResourceTelemetrySummary;
    if (!summaryFile.bytes.equals(Buffer.from(canonicalJson(parsedSummary), "utf8"))) {
      throw new Error("telemetry summary is not canonical JSON");
    }
    requireCanonicalEquality(
      parsedSummary,
      manifest.telemetry.summary,
      "telemetry embedded summary differs from its protected summary sibling",
    );
    requireCanonicalEquality(
      parsedSummary.identity,
      manifest.binding.processIdentity,
      "telemetry summary identity differs from its process binding",
    );
    requireCanonicalEquality(
      parsedSummary.observer,
      manifest.binding.observerIdentity,
      "telemetry summary observer differs from its observer binding",
    );
    if (parsedSummary.jsonl.name !== LOCAL_PROCESS_RESOURCE_JSONL_BASENAME
      || parsedSummary.jsonl.bytes !== jsonlFile.revision.size
      || parsedSummary.jsonl.sha256 !== jsonlSha256) {
      throw new Error("telemetry summary JSONL receipt differs from its protected JSONL sibling");
    }
    const samples = parseJsonl(jsonlFile.bytes);
    for (const sample of samples) {
      requireCanonicalEquality(
        sample.identity,
        manifest.binding.processIdentity,
        `telemetry sample ${sample.sequence} identity differs from its process binding`,
      );
    }
    validateSummaryAgainstSamples(parsedSummary, samples);
  }

  let outputSha256: string | null = null;
  if (options.expectedOutputPath !== undefined) {
    if (!isExactAbsolutePath(options.expectedOutputPath)) {
      throw new Error("expected telemetry output path must be exact and absolute");
    }
    if (!manifest.output || manifest.output.path !== options.expectedOutputPath) {
      throw new Error("telemetry manifest output does not match the expected output path");
    }
  }
  if (manifest.output) {
    const output = captureLtxResourceTelemetryOutput(manifest.output.path);
    outputSha256 = output.sha256;
    if (output.sizeBytes !== manifest.output.sizeBytes || output.sha256 !== manifest.output.sha256) {
      throw new Error("telemetry output content differs from its manifest binding");
    }
    requireCanonicalEquality(
      output.technical,
      manifest.output.technical,
      "telemetry output technical contract differs from its held-descriptor re-probe",
    );
  }
  if (manifest.measurementEligibleForCalibration !== intrinsicMeasurementEligibleForCalibration(manifest)) {
    throw new Error("telemetry manifest intrinsic single-measurement verdict is inconsistent");
  }

  return {
    manifest,
    manifestPath,
    manifestSha256: manifestFile.sha256,
    jsonlSha256,
    summarySha256,
    outputSha256,
    externalBindingMatched: options.expectedBinding !== undefined,
    expectedOutputPathMatched: options.expectedOutputPath !== undefined,
  };
}
