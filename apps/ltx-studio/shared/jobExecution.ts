export const jobExecutionClasses = ["pending", "dgx", "cpu-only"] as const;

export type JobExecutionClass = (typeof jobExecutionClasses)[number];

export const cpuOperationStates = [
  "prepared",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type CpuOperationState = (typeof cpuOperationStates)[number];

/**
 * Held descriptors defeat pathname replacement, but do not make mutable inode
 * contents immutable to the same uid. Eliminating that residual race requires
 * a sealed memfd, fs-verity, or an equivalent immutable execution substrate.
 */
export const executionDescriptorThreatModel =
  "held-fd-blocks-path-replacement;same-uid-in-place-write-requires-memfd-or-fs-verity" as const;

export type ExecutionFileRevision = {
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number;
  fileId: string;
  deviceId: string;
  /** Complete stat(2) mode: file type plus permission/special bits. */
  mode: number;
  /** Numeric owner identity captured from stat(2). */
  uid: number;
  /** Numeric group identity captured from stat(2). */
  gid: number;
  /** Publication/execution inputs must never have another hard-link name. */
  nlink: 1;
};

export type ExecutionFileBinding = {
  path: string;
  sha256: string;
  revision: ExecutionFileRevision;
};

export type CpuAudioRetimeReuseSourceBinding = {
  baselineJobId: string;
  baselineOutputName: string;
  baselineRequestSha256: string;
  sourceOutputPath: string;
  outputSha256: string;
  outputRevision: ExecutionFileRevision;
  settingsSidecarPath: string;
  settingsSidecarSha256: string;
  settingsSidecarRevision: ExecutionFileRevision;
  analysisSidecarPath: string;
  analysisSidecarSha256: string;
  analysisSidecarRevision: ExecutionFileRevision;
  sourceProvenanceFingerprint: string;
  sourceProgramAudioDelayMs: number;
  snapshotOutputPath: string;
  snapshotOutputSha256: string;
  snapshotOutputRevision: ExecutionFileRevision;
  snapshotSettingsSidecarPath: string;
  snapshotSettingsSidecarSha256: string;
  snapshotSettingsSidecarRevision: ExecutionFileRevision;
  snapshotAnalysisSidecarPath: string;
  snapshotAnalysisSidecarSha256: string;
  snapshotAnalysisSidecarRevision: ExecutionFileRevision;
};

export type CpuPairedArtifactReuseSourceBinding = {
  reuseKind: "lipforcing-raw-mux-pair";
  baselineJobId: string;
  baselineOutputName: string;
  baselineRequestSha256: string;
  sourceProvenanceFingerprint: string;
  authority: ExecutionFileBinding;
  receipt: ExecutionFileBinding;
  timelineReceipt: ExecutionFileBinding;
  preMux: ExecutionFileBinding;
  preMuxReceipt: ExecutionFileBinding;
  candidateFinal: ExecutionFileBinding;
  snapshotAuthority: ExecutionFileBinding;
  snapshotReceipt: ExecutionFileBinding;
  snapshotTimelineReceipt: ExecutionFileBinding;
  snapshotPreMux: ExecutionFileBinding;
  snapshotPreMuxReceipt: ExecutionFileBinding;
  snapshotCandidateFinal: ExecutionFileBinding;
};

/**
 * The untagged shape is the persisted v5 audio-retime authority.  Do not add a
 * discriminator retroactively: old completed jobs must remain verifiable.
 */
export type CpuReuseSourceBinding =
  | CpuAudioRetimeReuseSourceBinding
  | CpuPairedArtifactReuseSourceBinding;

export type CpuFfmpegOperation = {
  kind: "ffmpeg-audio-retime";
  state: CpuOperationState;
  descriptorThreatModel: typeof executionDescriptorThreatModel;
  executable: ExecutionFileBinding;
  ffmpegVersion: string;
  argsSha256: string;
  deltaMs: number;
  preparedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  errorSha256: string | null;
  output: ExecutionFileBinding | null;
};

/**
 * Versioned packet-copy authority for the native LTX-2.5 timing experiment.
 * Unlike the historical v5 operation, success is impossible without an
 * independently bound media-causality receipt.
 */
export type CpuPacketCopyAudioRetimeOperation = {
  kind: "ffmpeg-audio-retime-v2";
  profileId: "positive-delay-packet-copy.v1";
  state: CpuOperationState;
  descriptorThreatModel: typeof executionDescriptorThreatModel;
  ffmpeg: ExecutionFileBinding;
  ffmpegVersion: string;
  ffprobe: ExecutionFileBinding;
  ffprobeVersion: string;
  ffmpegArgsSha256: string;
  ffprobeArgsSha256: string;
  deltaMs: number;
  preparedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  errorSha256: string | null;
  output: ExecutionFileBinding | null;
  receipt: ExecutionFileBinding | null;
};

export type CpuPairedArtifactPromotionOperation = {
  kind: "paired-artifact-promotion";
  state: CpuOperationState;
  descriptorThreatModel: typeof executionDescriptorThreatModel;
  authoritySha256: string;
  preparedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  signal: string | null;
  errorSha256: string | null;
  output: ExecutionFileBinding | null;
};

export type CpuOperation =
  | CpuFfmpegOperation
  | CpuPacketCopyAudioRetimeOperation
  | CpuPairedArtifactPromotionOperation;

type ExecutionDecisionCommon = {
  decidedAt: string;
  reason: string;
  requestSha256: string;
  protocolSha256: string | null;
};

type NonCpuDecision = {
      executionClass: "pending" | "dgx";
      cpuReuse: null;
      operation: null;
    };

type AudioRetimeDecision = {
      executionClass: "cpu-only";
      cpuReuse: CpuAudioRetimeReuseSourceBinding;
      operation: CpuFfmpegOperation;
    };

type PacketCopyAudioRetimeDecision = {
  executionClass: "cpu-only";
  cpuReuse: CpuAudioRetimeReuseSourceBinding;
  operation: CpuPacketCopyAudioRetimeOperation;
};

type PairedArtifactDecision = {
  executionClass: "cpu-only";
  cpuReuse: CpuPairedArtifactReuseSourceBinding;
  operation: CpuPairedArtifactPromotionOperation;
};

export type JobExecutionDecision =
  | (ExecutionDecisionCommon & {
      schemaVersion: "ltx-studio-execution-decision.v5";
    } & (NonCpuDecision | AudioRetimeDecision))
  | (ExecutionDecisionCommon & {
      schemaVersion: "ltx-studio-execution-decision.v6";
    } & (
      NonCpuDecision
      | AudioRetimeDecision
      | PacketCopyAudioRetimeDecision
      | PairedArtifactDecision
    ));

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_ID_PATTERN = /^\d{1,64}$/;
const TERMINAL_CPU_OPERATION_STATES = new Set<CpuOperationState>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("/") && value.length <= 4096 && !value.includes("\0");
}

function isExecutionFileRevision(value: unknown): value is ExecutionFileRevision {
  if (!isRecord(value) || !exactKeys(value, [
    "sizeBytes", "modifiedAtMs", "changedAtMs", "fileId", "deviceId", "mode",
    "uid", "gid", "nlink",
  ])) return false;
  return typeof value.sizeBytes === "number"
    && Number.isSafeInteger(value.sizeBytes)
    && value.sizeBytes > 0
    && typeof value.modifiedAtMs === "number"
    && Number.isFinite(value.modifiedAtMs)
    && value.modifiedAtMs >= 0
    && typeof value.changedAtMs === "number"
    && Number.isFinite(value.changedAtMs)
    && value.changedAtMs >= 0
    && typeof value.fileId === "string"
    && INTEGER_ID_PATTERN.test(value.fileId)
    && typeof value.deviceId === "string"
    && INTEGER_ID_PATTERN.test(value.deviceId)
    && typeof value.mode === "number"
    && Number.isSafeInteger(value.mode)
    && value.mode >= 0
    && value.mode <= 0xffff_ffff
    && typeof value.uid === "number"
    && Number.isSafeInteger(value.uid)
    && value.uid >= 0
    && typeof value.gid === "number"
    && Number.isSafeInteger(value.gid)
    && value.gid >= 0
    && value.nlink === 1;
}

function isExecutionFileBinding(value: unknown): value is ExecutionFileBinding {
  return isRecord(value)
    && exactKeys(value, ["path", "sha256", "revision"])
    && isAbsolutePath(value.path)
    && isSha256(value.sha256)
    && isExecutionFileRevision(value.revision);
}

function isCpuAudioRetimeReuseSourceBinding(value: unknown): value is CpuAudioRetimeReuseSourceBinding {
  if (!isRecord(value) || !exactKeys(value, [
    "baselineJobId", "baselineOutputName", "baselineRequestSha256", "sourceOutputPath",
    "outputSha256", "outputRevision", "settingsSidecarPath", "settingsSidecarSha256",
    "settingsSidecarRevision", "analysisSidecarPath", "analysisSidecarSha256",
    "analysisSidecarRevision", "sourceProvenanceFingerprint", "sourceProgramAudioDelayMs",
    "snapshotOutputPath", "snapshotOutputSha256", "snapshotOutputRevision",
    "snapshotSettingsSidecarPath", "snapshotSettingsSidecarSha256", "snapshotSettingsSidecarRevision",
    "snapshotAnalysisSidecarPath", "snapshotAnalysisSidecarSha256", "snapshotAnalysisSidecarRevision",
  ])) return false;
  return typeof value.baselineJobId === "string"
    && UUID_PATTERN.test(value.baselineJobId)
    && typeof value.baselineOutputName === "string"
    && value.baselineOutputName.length > 0
    && value.baselineOutputName.length <= 120
    && !value.baselineOutputName.includes("/")
    && !value.baselineOutputName.includes("\\")
    && isSha256(value.baselineRequestSha256)
    && isAbsolutePath(value.sourceOutputPath)
    && isSha256(value.outputSha256)
    && isExecutionFileRevision(value.outputRevision)
    && isAbsolutePath(value.settingsSidecarPath)
    && isSha256(value.settingsSidecarSha256)
    && isExecutionFileRevision(value.settingsSidecarRevision)
    && isAbsolutePath(value.analysisSidecarPath)
    && isSha256(value.analysisSidecarSha256)
    && isExecutionFileRevision(value.analysisSidecarRevision)
    && isSha256(value.sourceProvenanceFingerprint)
    && typeof value.sourceProgramAudioDelayMs === "number"
    && Number.isInteger(value.sourceProgramAudioDelayMs)
    && value.sourceProgramAudioDelayMs >= -1_000
    && value.sourceProgramAudioDelayMs <= 1_000
    && isAbsolutePath(value.snapshotOutputPath)
    && isSha256(value.snapshotOutputSha256)
    && isExecutionFileRevision(value.snapshotOutputRevision)
    && isAbsolutePath(value.snapshotSettingsSidecarPath)
    && isSha256(value.snapshotSettingsSidecarSha256)
    && isExecutionFileRevision(value.snapshotSettingsSidecarRevision)
    && isAbsolutePath(value.snapshotAnalysisSidecarPath)
    && isSha256(value.snapshotAnalysisSidecarSha256)
    && isExecutionFileRevision(value.snapshotAnalysisSidecarRevision)
    && value.snapshotOutputSha256 === value.outputSha256
    && value.snapshotSettingsSidecarSha256 === value.settingsSidecarSha256
    && value.snapshotAnalysisSidecarSha256 === value.analysisSidecarSha256;
}

function isCpuPairedArtifactReuseSourceBinding(
  value: unknown,
): value is CpuPairedArtifactReuseSourceBinding {
  if (!isRecord(value) || !exactKeys(value, [
    "reuseKind", "baselineJobId", "baselineOutputName", "baselineRequestSha256",
    "sourceProvenanceFingerprint", "authority", "receipt", "timelineReceipt", "preMux", "preMuxReceipt", "candidateFinal",
    "snapshotAuthority", "snapshotReceipt", "snapshotTimelineReceipt", "snapshotPreMux", "snapshotPreMuxReceipt", "snapshotCandidateFinal",
  ])) return false;
  return value.reuseKind === "lipforcing-raw-mux-pair"
    && typeof value.baselineJobId === "string"
    && UUID_PATTERN.test(value.baselineJobId)
    && typeof value.baselineOutputName === "string"
    && value.baselineOutputName.length > 0
    && value.baselineOutputName.length <= 120
    && !value.baselineOutputName.includes("/")
    && !value.baselineOutputName.includes("\\")
    && isSha256(value.baselineRequestSha256)
    && isSha256(value.sourceProvenanceFingerprint)
    && isExecutionFileBinding(value.authority)
    && isExecutionFileBinding(value.receipt)
    && isExecutionFileBinding(value.timelineReceipt)
    && isExecutionFileBinding(value.preMux)
    && isExecutionFileBinding(value.preMuxReceipt)
    && isExecutionFileBinding(value.candidateFinal)
    && isExecutionFileBinding(value.snapshotAuthority)
    && isExecutionFileBinding(value.snapshotReceipt)
    && isExecutionFileBinding(value.snapshotTimelineReceipt)
    && isExecutionFileBinding(value.snapshotPreMux)
    && isExecutionFileBinding(value.snapshotPreMuxReceipt)
    && isExecutionFileBinding(value.snapshotCandidateFinal)
    && value.snapshotAuthority.sha256 === value.authority.sha256
    && value.snapshotReceipt.sha256 === value.receipt.sha256
    && value.snapshotTimelineReceipt.sha256 === value.timelineReceipt.sha256
    && value.snapshotPreMux.sha256 === value.preMux.sha256
    && value.snapshotPreMuxReceipt.sha256 === value.preMuxReceipt.sha256
    && value.snapshotCandidateFinal.sha256 === value.candidateFinal.sha256;
}

function isCpuReuseSourceBinding(value: unknown): value is CpuReuseSourceBinding {
  return isCpuAudioRetimeReuseSourceBinding(value)
    || isCpuPairedArtifactReuseSourceBinding(value);
}

function timestampAtOrAfter(value: string, lowerBound: string): boolean {
  return Date.parse(value) >= Date.parse(lowerBound);
}

function isCpuFfmpegOperation(value: unknown): value is CpuFfmpegOperation {
  if (!isRecord(value) || !exactKeys(value, [
    "kind", "state", "descriptorThreatModel", "executable", "ffmpegVersion", "argsSha256", "deltaMs",
    "preparedAt", "startedAt", "completedAt", "exitCode", "signal", "errorSha256", "output",
  ])) return false;
  if (value.kind !== "ffmpeg-audio-retime"
    || typeof value.state !== "string"
    || !cpuOperationStates.includes(value.state as CpuOperationState)
    || value.descriptorThreatModel !== executionDescriptorThreatModel
    || !isExecutionFileBinding(value.executable)
    || (value.executable.revision.mode & 0o170000) !== 0o100000
    || (value.executable.revision.mode & 0o111) === 0
    || typeof value.ffmpegVersion !== "string"
    || value.ffmpegVersion.length < 1
    || value.ffmpegVersion.length > 1000
    || !isSha256(value.argsSha256)
    || typeof value.deltaMs !== "number"
    || !Number.isInteger(value.deltaMs)
    || value.deltaMs < -1_000
    || value.deltaMs > 1_000
    || !isTimestamp(value.preparedAt)
    || !(value.startedAt === null || isTimestamp(value.startedAt))
    || !(value.completedAt === null || isTimestamp(value.completedAt))
    || !(value.exitCode === null
      || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)))
    || !(value.signal === null
      || (typeof value.signal === "string" && value.signal.length > 0 && value.signal.length <= 64))
    || !(value.errorSha256 === null || isSha256(value.errorSha256))
    || !(value.output === null || isExecutionFileBinding(value.output))) return false;

  const state = value.state as CpuOperationState;
  const terminal = TERMINAL_CPU_OPERATION_STATES.has(state);
  if (state === "prepared") {
    return value.startedAt === null
      && value.completedAt === null
      && value.exitCode === null
      && value.signal === null
      && value.errorSha256 === null
      && value.output === null;
  }
  if (state === "running") {
    return isTimestamp(value.startedAt)
      && timestampAtOrAfter(value.startedAt, value.preparedAt)
      && value.completedAt === null
      && value.exitCode === null
      && value.signal === null
      && value.errorSha256 === null
      && value.output === null;
  }
  if (!terminal
    || !isTimestamp(value.completedAt)
    || !timestampAtOrAfter(value.completedAt, value.startedAt ?? value.preparedAt)
    || (value.startedAt !== null && !timestampAtOrAfter(value.startedAt, value.preparedAt))) return false;
  if (state === "succeeded") {
    return isTimestamp(value.startedAt)
      && value.exitCode === 0
      && value.signal === null
      && value.errorSha256 === null
      && isExecutionFileBinding(value.output);
  }
  if (value.output !== null) return false;
  if (state === "failed") {
    return value.exitCode !== null || value.signal !== null || value.errorSha256 !== null;
  }
  return true;
}

function isCpuPacketCopyAudioRetimeOperation(
  value: unknown,
): value is CpuPacketCopyAudioRetimeOperation {
  if (!isRecord(value) || !exactKeys(value, [
    "kind", "profileId", "state", "descriptorThreatModel", "ffmpeg", "ffmpegVersion",
    "ffprobe", "ffprobeVersion", "ffmpegArgsSha256", "ffprobeArgsSha256", "deltaMs",
    "preparedAt", "startedAt", "completedAt", "exitCode", "signal", "errorSha256",
    "output", "receipt",
  ])) return false;
  if (value.kind !== "ffmpeg-audio-retime-v2"
    || value.profileId !== "positive-delay-packet-copy.v1"
    || typeof value.state !== "string"
    || !cpuOperationStates.includes(value.state as CpuOperationState)
    || value.descriptorThreatModel !== executionDescriptorThreatModel
    || !isExecutionFileBinding(value.ffmpeg)
    || (value.ffmpeg.revision.mode & 0o170000) !== 0o100000
    || (value.ffmpeg.revision.mode & 0o111) === 0
    || typeof value.ffmpegVersion !== "string"
    || value.ffmpegVersion.length < 1
    || value.ffmpegVersion.length > 1000
    || !isExecutionFileBinding(value.ffprobe)
    || (value.ffprobe.revision.mode & 0o170000) !== 0o100000
    || (value.ffprobe.revision.mode & 0o111) === 0
    || typeof value.ffprobeVersion !== "string"
    || value.ffprobeVersion.length < 1
    || value.ffprobeVersion.length > 1000
    || !isSha256(value.ffmpegArgsSha256)
    || !isSha256(value.ffprobeArgsSha256)
    || typeof value.deltaMs !== "number"
    || !Number.isInteger(value.deltaMs)
    || value.deltaMs < 1
    || value.deltaMs > 500
    || !isTimestamp(value.preparedAt)
    || !(value.startedAt === null || isTimestamp(value.startedAt))
    || !(value.completedAt === null || isTimestamp(value.completedAt))
    || !(value.exitCode === null
      || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)))
    || !(value.signal === null
      || (typeof value.signal === "string" && value.signal.length > 0 && value.signal.length <= 64))
    || !(value.errorSha256 === null || isSha256(value.errorSha256))
    || !(value.output === null || isExecutionFileBinding(value.output))
    || !(value.receipt === null || isExecutionFileBinding(value.receipt))) return false;

  const state = value.state as CpuOperationState;
  if (state === "prepared") {
    return value.startedAt === null
      && value.completedAt === null
      && value.exitCode === null
      && value.signal === null
      && value.errorSha256 === null
      && value.output === null
      && value.receipt === null;
  }
  if (state === "running") {
    return isTimestamp(value.startedAt)
      && timestampAtOrAfter(value.startedAt, value.preparedAt)
      && value.completedAt === null
      && value.exitCode === null
      && value.signal === null
      && value.errorSha256 === null
      && value.output === null
      && value.receipt === null;
  }
  if (!TERMINAL_CPU_OPERATION_STATES.has(state)
    || !isTimestamp(value.completedAt)
    || !timestampAtOrAfter(value.completedAt, value.startedAt ?? value.preparedAt)
    || (value.startedAt !== null && !timestampAtOrAfter(value.startedAt, value.preparedAt))) return false;
  if (state === "succeeded") {
    return isTimestamp(value.startedAt)
      && value.exitCode === 0
      && value.signal === null
      && value.errorSha256 === null
      && isExecutionFileBinding(value.output)
      && isExecutionFileBinding(value.receipt);
  }
  if (value.output !== null || value.receipt !== null) return false;
  if (state === "failed") {
    return value.exitCode !== null || value.signal !== null || value.errorSha256 !== null;
  }
  return true;
}

function isCpuPairedArtifactPromotionOperation(
  value: unknown,
): value is CpuPairedArtifactPromotionOperation {
  if (!isRecord(value) || !exactKeys(value, [
    "kind", "state", "descriptorThreatModel", "authoritySha256", "preparedAt",
    "startedAt", "completedAt", "exitCode", "signal", "errorSha256", "output",
  ])) return false;
  if (value.kind !== "paired-artifact-promotion"
    || typeof value.state !== "string"
    || !cpuOperationStates.includes(value.state as CpuOperationState)
    || value.descriptorThreatModel !== executionDescriptorThreatModel
    || !isSha256(value.authoritySha256)
    || !isTimestamp(value.preparedAt)
    || !(value.startedAt === null || isTimestamp(value.startedAt))
    || !(value.completedAt === null || isTimestamp(value.completedAt))
    || !(value.exitCode === null
      || (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)))
    || !(value.signal === null
      || (typeof value.signal === "string" && value.signal.length > 0 && value.signal.length <= 64))
    || !(value.errorSha256 === null || isSha256(value.errorSha256))
    || !(value.output === null || isExecutionFileBinding(value.output))) return false;

  const state = value.state as CpuOperationState;
  if (state === "prepared") {
    return value.startedAt === null
      && value.completedAt === null
      && value.exitCode === null
      && value.signal === null
      && value.errorSha256 === null
      && value.output === null;
  }
  if (state === "running") {
    return isTimestamp(value.startedAt)
      && timestampAtOrAfter(value.startedAt, value.preparedAt)
      && value.completedAt === null
      && value.exitCode === null
      && value.signal === null
      && value.errorSha256 === null
      && value.output === null;
  }
  if (!TERMINAL_CPU_OPERATION_STATES.has(state)
    || !isTimestamp(value.completedAt)
    || !timestampAtOrAfter(value.completedAt, value.startedAt ?? value.preparedAt)
    || (value.startedAt !== null && !timestampAtOrAfter(value.startedAt, value.preparedAt))) return false;
  if (state === "succeeded") {
    return isTimestamp(value.startedAt)
      && value.exitCode === 0
      && value.signal === null
      && value.errorSha256 === null
      && isExecutionFileBinding(value.output);
  }
  if (value.output !== null) return false;
  if (state === "failed") {
    return value.exitCode !== null || value.signal !== null || value.errorSha256 !== null;
  }
  return true;
}

function isCpuOperation(value: unknown): value is CpuOperation {
  return isCpuFfmpegOperation(value)
    || isCpuPacketCopyAudioRetimeOperation(value)
    || isCpuPairedArtifactPromotionOperation(value);
}

export function isJobExecutionClass(value: unknown): value is JobExecutionClass {
  return typeof value === "string"
    && jobExecutionClasses.includes(value as JobExecutionClass);
}

export function normalizeJobExecutionDecision(value: unknown): JobExecutionDecision | null {
  if (!isRecord(value) || !exactKeys(value, [
    "schemaVersion", "decidedAt", "reason", "requestSha256", "protocolSha256",
    "executionClass", "cpuReuse", "operation",
  ])) return null;
  if (!(value.schemaVersion === "ltx-studio-execution-decision.v5"
      || value.schemaVersion === "ltx-studio-execution-decision.v6")
    || !isTimestamp(value.decidedAt)
    || typeof value.reason !== "string"
    || value.reason.length < 1
    || value.reason.length > 1000
    || !isSha256(value.requestSha256)
    || !(value.protocolSha256 === null || isSha256(value.protocolSha256))
    || !isJobExecutionClass(value.executionClass)) return null;
  if (value.executionClass === "cpu-only") {
    if (!isCpuReuseSourceBinding(value.cpuReuse) || !isCpuOperation(value.operation)) return null;
    const audioRetimeOperation = value.operation.kind === "ffmpeg-audio-retime"
      || value.operation.kind === "ffmpeg-audio-retime-v2";
    if (audioRetimeOperation !== !("reuseKind" in value.cpuReuse)) return null;
    if (value.operation.kind === "ffmpeg-audio-retime-v2"
      && value.schemaVersion !== "ltx-studio-execution-decision.v6") return null;
    if (value.operation.kind === "paired-artifact-promotion"
      && "reuseKind" in value.cpuReuse
      && value.operation.authoritySha256 !== value.cpuReuse.authority.sha256) return null;
    if (value.operation.kind === "paired-artifact-promotion"
      && value.schemaVersion !== "ltx-studio-execution-decision.v6") return null;
  } else if (value.cpuReuse !== null || value.operation !== null) {
    return null;
  }
  return structuredClone(value) as JobExecutionDecision;
}

function cpuOperationImmutableFieldsMatch(left: CpuOperation, right: CpuOperation): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "ffmpeg-audio-retime" && right.kind === "ffmpeg-audio-retime") {
    return JSON.stringify({
      kind: left.kind,
      descriptorThreatModel: left.descriptorThreatModel,
      executable: left.executable,
      ffmpegVersion: left.ffmpegVersion,
      argsSha256: left.argsSha256,
      deltaMs: left.deltaMs,
      preparedAt: left.preparedAt,
    }) === JSON.stringify({
      kind: right.kind,
      descriptorThreatModel: right.descriptorThreatModel,
      executable: right.executable,
      ffmpegVersion: right.ffmpegVersion,
      argsSha256: right.argsSha256,
      deltaMs: right.deltaMs,
      preparedAt: right.preparedAt,
    });
  }
  if (left.kind === "ffmpeg-audio-retime-v2" && right.kind === "ffmpeg-audio-retime-v2") {
    return JSON.stringify({
      kind: left.kind,
      profileId: left.profileId,
      descriptorThreatModel: left.descriptorThreatModel,
      ffmpeg: left.ffmpeg,
      ffmpegVersion: left.ffmpegVersion,
      ffprobe: left.ffprobe,
      ffprobeVersion: left.ffprobeVersion,
      ffmpegArgsSha256: left.ffmpegArgsSha256,
      ffprobeArgsSha256: left.ffprobeArgsSha256,
      deltaMs: left.deltaMs,
      preparedAt: left.preparedAt,
    }) === JSON.stringify({
      kind: right.kind,
      profileId: right.profileId,
      descriptorThreatModel: right.descriptorThreatModel,
      ffmpeg: right.ffmpeg,
      ffmpegVersion: right.ffmpegVersion,
      ffprobe: right.ffprobe,
      ffprobeVersion: right.ffprobeVersion,
      ffmpegArgsSha256: right.ffmpegArgsSha256,
      ffprobeArgsSha256: right.ffprobeArgsSha256,
      deltaMs: right.deltaMs,
      preparedAt: right.preparedAt,
    });
  }
  if (left.kind === "paired-artifact-promotion" && right.kind === "paired-artifact-promotion") {
    return JSON.stringify({
      kind: left.kind,
      descriptorThreatModel: left.descriptorThreatModel,
      authoritySha256: left.authoritySha256,
      preparedAt: left.preparedAt,
    }) === JSON.stringify({
      kind: right.kind,
      descriptorThreatModel: right.descriptorThreatModel,
      authoritySha256: right.authoritySha256,
      preparedAt: right.preparedAt,
    });
  }
  return false;
}

export function jobExecutionDecisionIsMonotone(
  previous: JobExecutionDecision | undefined,
  next: JobExecutionDecision,
): boolean {
  if (!previous) return next.executionClass === "pending";
  if (previous.schemaVersion !== next.schemaVersion
    || previous.requestSha256 !== next.requestSha256
    || previous.protocolSha256 !== next.protocolSha256
    || Date.parse(next.decidedAt) < Date.parse(previous.decidedAt)) return false;
  if (previous.executionClass === "pending") {
    return next.executionClass === "dgx"
      || (next.executionClass === "cpu-only" && next.operation.state === "prepared");
  }
  if (previous.executionClass !== next.executionClass) return false;
  if (previous.executionClass !== "cpu-only" || next.executionClass !== "cpu-only") {
    return JSON.stringify(previous) === JSON.stringify(next);
  }
  if (previous.decidedAt !== next.decidedAt
    || previous.reason !== next.reason
    || JSON.stringify(previous.cpuReuse) !== JSON.stringify(next.cpuReuse)
    || !cpuOperationImmutableFieldsMatch(previous.operation, next.operation)) return false;
  if (TERMINAL_CPU_OPERATION_STATES.has(previous.operation.state)) {
    return JSON.stringify(previous) === JSON.stringify(next);
  }
  if (previous.operation.state === "prepared") {
    return next.operation.state === "running";
  }
  return previous.operation.state === "running"
    && TERMINAL_CPU_OPERATION_STATES.has(next.operation.state);
}
