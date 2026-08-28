import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname, resolve } from "node:path";

import { canonicalizeJson, canonicalJson } from "../shared/canonicalJson.js";
import { hostTcbExecutables } from "./config.js";

export const LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS = 1_000;
export const LOCAL_PROCESS_RESOURCE_MAX_GAP_MS = 3_000;
export const NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS = 750;
export const NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT = Object.freeze({
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LC_ALL: "C",
} as const);
export const NVIDIA_ML_SONAME_PATH = "/usr/lib/aarch64-linux-gnu/libnvidia-ml.so.1";
export const NVIDIA_ML_LICENSE_PATH = "/usr/share/doc/libnvidia-compute-580/copyright";
export const LOCAL_PROCESS_RESOURCE_JSONL_BASENAME = "local-process-resources.v1.jsonl";
export const LOCAL_PROCESS_RESOURCE_SUMMARY_BASENAME = "local-process-resources.summary.v1.json";
export const NVIDIA_PROCESS_MEMORY_QUERY_ARGS = Object.freeze([
  "--query-compute-apps=pid,used_memory",
  "--format=csv,noheader,nounits",
] as const);

const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TICKS_PATTERN = /^\d+$/u;
const PROC_PID_PATTERN = /^\d+$/u;
const MAX_ERROR_LENGTH = 500;

export type LocalProcessResourceIdentity = {
  bootId: string;
  processGroupId: number;
  leaderStartTicks: string;
};

export type LocalProcessResourceSource =
  | "boot_id"
  | "leader_stat"
  | "meminfo"
  | "vmstat"
  | "proc_scan"
  | "proc_status"
  | "process_group_identity"
  | "nvidia_smi"
  | "monotonic_clock";

export type LocalProcessResourceSourceError = {
  source: LocalProcessResourceSource;
  message: string;
};

export type NvidiaSmiExecution = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
};

export type LocalProcessResourceTelemetryOperations = {
  readText(path: string): string;
  listProcEntries(): string[];
  runNvidiaSmi(args: readonly string[]): NvidiaSmiExecution;
  now(): Date;
  monotonicNowMs(): number;
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
  captureObserverIdentity(): LocalProcessResourceObserverIdentity;
  prepareEvidenceDirectory(path: string): void;
  createJsonl(path: string): LocalProcessResourceEvidenceFileIdentity;
  appendJsonl(path: string, line: string, identity: LocalProcessResourceEvidenceFileIdentity): void;
  writeSummary(path: string, content: string): void;
  readEvidence(path: string, identity?: LocalProcessResourceEvidenceFileIdentity): Buffer;
};

export type LocalProcessResourceObserverIdentity = {
  schemaVersion: "ltx-studio-local-process-resource-observer.v1";
  executable: string;
  executableSha256: string;
  versionArguments: ["--version"];
  versionOutputSha256: string;
  versionFirstLine: string;
  queryArguments: typeof NVIDIA_PROCESS_MEMORY_QUERY_ARGS;
  queryTimeoutMs: typeof NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS;
  environment: typeof NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT;
  dynamicLibraries: [{
    name: "nvml";
    path: string;
    sha256: string;
    licensePath: typeof NVIDIA_ML_LICENSE_PATH;
    licenseSha256: string;
  }];
  residentAccounting: "vmrss-plus-nvidia-used-memory-conservative-envelope.v1";
};

export type LocalProcessResourceEvidenceFileIdentity = {
  deviceId: string;
  fileId: string;
  uid: number;
  gid: number;
  mode: number;
  linkCount: 1;
};

export type LocalProcessResourceSample = {
  schemaVersion: "ltx-studio-local-process-resource-sample.v1";
  sequence: number;
  capturedAt: string;
  monotonicMs: number;
  gapMs: number | null;
  identity: LocalProcessResourceIdentity;
  identityVerified: boolean;
  host: {
    memFreeKiB: number | null;
    memAvailableKiB: number | null;
    swapTotalKiB: number | null;
    swapFreeKiB: number | null;
    pswpinPages: number | null;
    pswpoutPages: number | null;
  };
  processGroup: {
    attributionVerified: boolean;
    pids: number[];
    processCount: number;
    rssAnonKiB: number | null;
    vmRssKiB: number | null;
    vmHwmKiB: number | null;
    vmSwapKiB: number | null;
    nvidiaUsedMemoryMiB: number | null;
    accountedResidentKiB: number | null;
    nvidiaPids: Array<{ pid: number; usedMemoryMiB: number }>;
  };
  sourceErrors: LocalProcessResourceSourceError[];
};

export type LocalProcessResourceTelemetrySummary = {
  schemaVersion: "ltx-studio-local-process-resource-summary.v1";
  identity: LocalProcessResourceIdentity;
  startedAt: string;
  finishedAt: string;
  intervalMs: typeof LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS;
  maximumPermittedGapMs: typeof LOCAL_PROCESS_RESOURCE_MAX_GAP_MS;
  observer: LocalProcessResourceObserverIdentity;
  sampleCount: number;
  lastSuccessfulSequence: number | null;
  terminalGapMs: number | null;
  maxGapMs: number | null;
  quality: "sufficient" | "insufficient";
  qualityReasons: Array<"no_samples" | "sample_gap_exceeded" | "source_errors">;
  sourceErrors: Array<{
    source: LocalProcessResourceSource;
    message: string;
    count: number;
    firstSequence: number;
    lastSequence: number;
  }>;
  jsonl: {
    name: typeof LOCAL_PROCESS_RESOURCE_JSONL_BASENAME;
    bytes: number;
    sha256: string;
  };
  metrics: {
    host: {
      minimumMemFreeKiB: number | null;
      minimumMemAvailableKiB: number | null;
      swapTotalKiB: number | null;
      minimumSwapFreeKiB: number | null;
      pswpinDeltaPages: number | null;
      pswpoutDeltaPages: number | null;
    };
    processGroup: {
      maximumProcessCount: number | null;
      maximumRssAnonKiB: number | null;
      maximumVmRssKiB: number | null;
      maximumVmHwmKiB: number | null;
      maximumVmSwapKiB: number | null;
      maximumNvidiaUsedMemoryMiB: number | null;
      maximumAccountedResidentKiB: number | null;
    };
  };
};

export type LocalProcessResourceTelemetryReceipt = {
  schemaVersion: "ltx-studio-local-process-resource-evidence.v1";
  jsonlPath: string;
  jsonlSha256: string;
  summaryPath: string;
  summarySha256: string;
  summary: LocalProcessResourceTelemetrySummary;
};

type ProcessStat = {
  processGroupId: number;
  startTicks: string;
};

type ProcessStatusMemory = {
  rssAnonKiB: number;
  vmRssKiB: number;
  vmHwmKiB: number;
  vmSwapKiB: number;
};

type GroupMember = {
  pid: number;
  startTicks: string;
};

function boundedError(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/gu, " ")
    .trim();
  const message = raw || "unknown source error";
  return message.length <= MAX_ERROR_LENGTH
    ? message
    : `${message.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

function sourceError(
  errors: LocalProcessResourceSourceError[],
  source: LocalProcessResourceSource,
  error: unknown,
): void {
  const candidate = { source, message: boundedError(error) };
  if (!errors.some((item) => item.source === candidate.source && item.message === candidate.message)) {
    errors.push(candidate);
  }
}

function requireIdentity(identity: LocalProcessResourceIdentity): LocalProcessResourceIdentity {
  if (!BOOT_ID_PATTERN.test(identity.bootId)) throw new Error("Local process resource boot ID is structurally invalid");
  if (!Number.isSafeInteger(identity.processGroupId) || identity.processGroupId <= 0) {
    throw new Error("Local process resource PGID is structurally invalid");
  }
  if (!TICKS_PATTERN.test(identity.leaderStartTicks)) {
    throw new Error("Local process resource leader start ticks are structurally invalid");
  }
  return { ...identity };
}

function requireFiniteNonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} is not a finite non-negative number`);
  return value;
}

function readProcessStat(raw: string, pid: number): ProcessStat {
  const suffixStart = raw.lastIndexOf(") ");
  if (suffixStart < 0) throw new Error(`/proc/${pid}/stat has no terminal comm delimiter`);
  const fields = raw.slice(suffixStart + 2).trim().split(/\s+/u);
  const processGroupId = Number.parseInt(fields[2] ?? "", 10);
  const startTicks = fields[19] ?? "";
  // Linux kernel threads legitimately report process group 0. They are not
  // members of a positive, isolated Studio process group and must be ignored
  // by the scan instead of poisoning attribution for every sample.
  if (!Number.isSafeInteger(processGroupId) || processGroupId < 0 || !TICKS_PATTERN.test(startTicks)) {
    throw new Error(`/proc/${pid}/stat has no safe process-group identity`);
  }
  return { processGroupId, startTicks };
}

function parseNamedKiB(raw: string, names: readonly string[], source: string): Record<string, number> {
  const requested = new Set(names);
  const values: Record<string, number> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB\s*$/u.exec(line);
    if (!match || !requested.has(match[1])) continue;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${source} ${match[1]} is invalid`);
    values[match[1]] = value;
  }
  for (const name of names) {
    if (values[name] === undefined) throw new Error(`${source} is missing ${name}`);
  }
  return values;
}

function parseMeminfo(raw: string): Pick<LocalProcessResourceSample["host"],
  "memFreeKiB" | "memAvailableKiB" | "swapTotalKiB" | "swapFreeKiB"> {
  const values = parseNamedKiB(raw, ["MemFree", "MemAvailable", "SwapTotal", "SwapFree"], "/proc/meminfo");
  return {
    memFreeKiB: values.MemFree,
    memAvailableKiB: values.MemAvailable,
    swapTotalKiB: values.SwapTotal,
    swapFreeKiB: values.SwapFree,
  };
}

function parseVmstat(raw: string): Pick<LocalProcessResourceSample["host"],
  "pswpinPages" | "pswpoutPages"> {
  const values = new Map<string, number>();
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^(pswpin|pswpout)\s+(\d+)\s*$/u.exec(line);
    if (!match) continue;
    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`/proc/vmstat ${match[1]} is invalid`);
    values.set(match[1], value);
  }
  const pswpinPages = values.get("pswpin");
  const pswpoutPages = values.get("pswpout");
  if (pswpinPages === undefined || pswpoutPages === undefined) {
    throw new Error("/proc/vmstat is missing pswpin or pswpout");
  }
  return { pswpinPages, pswpoutPages };
}

function parseProcessStatus(raw: string, pid: number): ProcessStatusMemory {
  const values = parseNamedKiB(raw, ["RssAnon", "VmRSS", "VmHWM", "VmSwap"], `/proc/${pid}/status`);
  return {
    rssAnonKiB: values.RssAnon,
    vmRssKiB: values.VmRSS,
    vmHwmKiB: values.VmHWM,
    vmSwapKiB: values.VmSwap,
  };
}

function mapsEqual(left: Map<number, GroupMember>, right: Map<number, GroupMember>): boolean {
  if (left.size !== right.size) return false;
  return [...left].every(([pid, member]) => right.get(pid)?.startTicks === member.startTicks);
}

function scanProcessGroup(
  identity: LocalProcessResourceIdentity,
  operations: LocalProcessResourceTelemetryOperations,
  errors: LocalProcessResourceSourceError[],
): Map<number, GroupMember> | null {
  let entries: string[];
  try {
    entries = operations.listProcEntries();
  } catch (error) {
    sourceError(errors, "proc_scan", error);
    return null;
  }
  const members = new Map<number, GroupMember>();
  let unreadable = false;
  for (const entry of [...entries].sort((left, right) => Number(left) - Number(right))) {
    if (!PROC_PID_PATTERN.test(entry)) continue;
    const pid = Number(entry);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try {
      const stat = readProcessStat(operations.readText(`/proc/${pid}/stat`), pid);
      if (stat.processGroupId === identity.processGroupId) {
        members.set(pid, { pid, startTicks: stat.startTicks });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      unreadable = true;
      sourceError(errors, "proc_scan", error);
    }
  }
  if (unreadable) return null;
  if (!members.has(identity.processGroupId)) {
    sourceError(errors, "process_group_identity", "process-group leader is absent from the /proc membership scan");
    return null;
  }
  return members;
}

function verifyIdentity(
  identity: LocalProcessResourceIdentity,
  operations: LocalProcessResourceTelemetryOperations,
  errors: LocalProcessResourceSourceError[],
): boolean {
  let bootId: string;
  try {
    bootId = operations.readText("/proc/sys/kernel/random/boot_id").trim();
  } catch (error) {
    sourceError(errors, "boot_id", error);
    return false;
  }
  if (!BOOT_ID_PATTERN.test(bootId) || bootId !== identity.bootId) {
    sourceError(errors, "boot_id", "current Linux boot ID does not match the bound process-group identity");
    return false;
  }
  try {
    const leader = readProcessStat(
      operations.readText(`/proc/${identity.processGroupId}/stat`),
      identity.processGroupId,
    );
    if (leader.processGroupId !== identity.processGroupId
      || leader.startTicks !== identity.leaderStartTicks) {
      sourceError(errors, "leader_stat", "process-group leader no longer matches its bound PGID/start ticks");
      return false;
    }
  } catch (error) {
    sourceError(errors, "leader_stat", error);
    return false;
  }
  return true;
}

function collectProcessMemory(
  members: Map<number, GroupMember>,
  operations: LocalProcessResourceTelemetryOperations,
  errors: LocalProcessResourceSourceError[],
): ProcessStatusMemory | null {
  const total: ProcessStatusMemory = { rssAnonKiB: 0, vmRssKiB: 0, vmHwmKiB: 0, vmSwapKiB: 0 };
  let valid = true;
  for (const pid of [...members.keys()].sort((left, right) => left - right)) {
    try {
      const memory = parseProcessStatus(operations.readText(`/proc/${pid}/status`), pid);
      total.rssAnonKiB += memory.rssAnonKiB;
      total.vmRssKiB += memory.vmRssKiB;
      total.vmHwmKiB += memory.vmHwmKiB;
      total.vmSwapKiB += memory.vmSwapKiB;
    } catch (error) {
      valid = false;
      sourceError(errors, "proc_status", error);
    }
  }
  if (!valid) return null;
  for (const [key, value] of Object.entries(total)) requireFiniteNonNegative(value, key);
  return total;
}

function collectNvidiaMemory(
  members: Map<number, GroupMember>,
  operations: LocalProcessResourceTelemetryOperations,
  errors: LocalProcessResourceSourceError[],
): { totalMiB: number; pids: Array<{ pid: number; usedMemoryMiB: number }> } | null {
  let result: NvidiaSmiExecution;
  try {
    result = operations.runNvidiaSmi(NVIDIA_PROCESS_MEMORY_QUERY_ARGS);
  } catch (error) {
    sourceError(errors, "nvidia_smi", error);
    return null;
  }
  if (result.error || result.status !== 0 || result.signal !== null) {
    sourceError(
      errors,
      "nvidia_smi",
      result.error
        || result.stderr.trim()
        || `nvidia-smi exited with status ${String(result.status)} signal ${String(result.signal)}`,
    );
    return null;
  }
  const byPid = new Map<number, number>();
  for (const line of result.stdout.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean)) {
    const match = /^(\d+)\s*,\s*(\d+(?:\.\d+)?)$/u.exec(line);
    if (!match) {
      sourceError(errors, "nvidia_smi", `unparseable nvidia-smi process row: ${line}`);
      return null;
    }
    const pid = Number(match[1]);
    const usedMemoryMiB = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0
      || !Number.isSafeInteger(usedMemoryMiB) || usedMemoryMiB < 0) {
      sourceError(errors, "nvidia_smi", `invalid nvidia-smi process row: ${line}`);
      return null;
    }
    if (members.has(pid)) byPid.set(pid, (byPid.get(pid) ?? 0) + usedMemoryMiB);
  }
  const pids = [...byPid].sort(([left], [right]) => left - right)
    .map(([pid, usedMemoryMiB]) => ({ pid, usedMemoryMiB }));
  return { totalMiB: pids.reduce((total, item) => total + item.usedMemoryMiB, 0), pids };
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function evidenceFileIdentity(stats: Stats): LocalProcessResourceEvidenceFileIdentity {
  if (!stats.isFile()
    || stats.nlink !== 1
    || stats.uid !== (process.getuid?.() ?? stats.uid)
    || stats.gid !== (process.getgid?.() ?? stats.gid)
    || (stats.mode & 0o777) !== 0o600) {
    throw new Error("resource telemetry evidence file identity, ownership, mode, or link count is unsafe");
  }
  return {
    deviceId: String(stats.dev),
    fileId: String(stats.ino),
    uid: stats.uid,
    gid: stats.gid,
    mode: stats.mode,
    linkCount: 1,
  };
}

function evidenceFileIdentityMatches(
  stats: Stats,
  expected: LocalProcessResourceEvidenceFileIdentity,
): boolean {
  return canonicalJson(evidenceFileIdentity(stats)) === canonicalJson(expected);
}

function stableObserverFileRevision(
  path: string,
  requireExecutable = true,
): Record<string, string | number> {
  if (realpathSync(path) !== path) throw new Error(`resource telemetry observer path is not canonical: ${path}`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()
    || !stats.isFile()
    || stats.nlink !== 1
    || stats.uid !== 0
    || stats.gid !== 0
    || (stats.mode & 0o022) !== 0
    || (requireExecutable && (stats.mode & 0o111) === 0)
    || stats.size <= 0) {
    throw new Error(`resource telemetry observer executable is not a protected root-owned file: ${path}`);
  }
  return {
    deviceId: String(stats.dev),
    fileId: String(stats.ino),
    sizeBytes: stats.size,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    linkCount: stats.nlink,
  };
}

function captureNvidiaObserverIdentity(): LocalProcessResourceObserverIdentity {
  const executable = hostTcbExecutables.nvidiaSmi;
  const before = stableObserverFileRevision(executable);
  const executableBytes = readFileSync(executable);
  const middle = stableObserverFileRevision(executable);
  const version = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const after = stableObserverFileRevision(executable);
  if (canonicalJson(before) !== canonicalJson(middle)
    || canonicalJson(before) !== canonicalJson(after)) {
    throw new Error("resource telemetry observer executable changed while its identity was captured");
  }
  if (version.error || version.status !== 0 || version.signal !== null) {
    throw new Error(
      version.error?.message
      ?? version.stderr?.trim()
      ?? `resource telemetry observer version probe exited with ${String(version.status)}`,
    );
  }
  const versionOutput = `${version.stdout ?? ""}${version.stderr ?? ""}`;
  const versionFirstLine = versionOutput.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  if (!versionFirstLine) throw new Error("resource telemetry observer version probe returned no identity");
  const nvmlPath = realpathSync(NVIDIA_ML_SONAME_PATH);
  const nvmlBefore = stableObserverFileRevision(nvmlPath, false);
  const nvmlBytes = readFileSync(nvmlPath);
  const nvmlAfter = stableObserverFileRevision(nvmlPath, false);
  const licenseBefore = stableObserverFileRevision(NVIDIA_ML_LICENSE_PATH, false);
  const licenseBytes = readFileSync(NVIDIA_ML_LICENSE_PATH);
  const licenseAfter = stableObserverFileRevision(NVIDIA_ML_LICENSE_PATH, false);
  if (canonicalJson(nvmlBefore) !== canonicalJson(nvmlAfter)
    || canonicalJson(licenseBefore) !== canonicalJson(licenseAfter)) {
    throw new Error("resource telemetry NVML or license identity changed while it was captured");
  }
  return {
    schemaVersion: "ltx-studio-local-process-resource-observer.v1",
    executable,
    executableSha256: createHash("sha256").update(executableBytes).digest("hex"),
    versionArguments: ["--version"],
    versionOutputSha256: createHash("sha256").update(versionOutput).digest("hex"),
    versionFirstLine,
    queryArguments: [...NVIDIA_PROCESS_MEMORY_QUERY_ARGS],
    queryTimeoutMs: NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS,
    environment: { ...NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT },
    dynamicLibraries: [{
      name: "nvml",
      path: nvmlPath,
      sha256: createHash("sha256").update(nvmlBytes).digest("hex"),
      licensePath: NVIDIA_ML_LICENSE_PATH,
      licenseSha256: createHash("sha256").update(licenseBytes).digest("hex"),
    }],
    residentAccounting: "vmrss-plus-nvidia-used-memory-conservative-envelope.v1",
  };
}

function prepareEvidenceDirectoryDurably(path: string): void {
  const target = resolve(path);
  const missing: string[] = [];
  let cursor = target;
  while (true) {
    try {
      const stats = lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`resource telemetry evidence ancestor is not a real directory: ${cursor}`);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error("resource telemetry evidence path has no existing ancestor");
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    mkdirSync(directory, { mode: 0o700 });
    const stats = lstatSync(directory);
    if (stats.isSymbolicLink()
      || !stats.isDirectory()
      || stats.uid !== (process.getuid?.() ?? stats.uid)
      || stats.gid !== (process.getgid?.() ?? stats.gid)
      || (stats.mode & 0o777) !== 0o700) {
      throw new Error(`resource telemetry evidence directory creation was replaced: ${directory}`);
    }
    // Persist both sides of every newly introduced name. This includes
    // resource-telemetry/, the Studio job directory and ltx-gN, rather than
    // only fsyncing the deepest directory after a recursive mkdir.
    syncDirectory(directory);
    syncDirectory(dirname(directory));
  }
  const targetStats = lstatSync(target);
  if (targetStats.isSymbolicLink()
    || !targetStats.isDirectory()
    || targetStats.uid !== (process.getuid?.() ?? targetStats.uid)
    || targetStats.gid !== (process.getgid?.() ?? targetStats.gid)
    || (targetStats.mode & 0o777) !== 0o700) {
    throw new Error(`resource telemetry evidence directory is not protected: ${target}`);
  }
  syncDirectory(target);
}

function createEvidenceFile(path: string): LocalProcessResourceEvidenceFileIdentity {
  const descriptor = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let identity: LocalProcessResourceEvidenceFileIdentity;
  try {
    identity = evidenceFileIdentity(fstatSync(descriptor));
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const pathIdentity = evidenceFileIdentity(lstatSync(path));
  if (canonicalJson(pathIdentity) !== canonicalJson(identity)) {
    throw new Error("resource telemetry JSONL path was replaced during creation");
  }
  syncDirectory(dirname(path));
  return identity;
}

function appendEvidenceLine(
  path: string,
  line: string,
  identity: LocalProcessResourceEvidenceFileIdentity,
): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    if (!evidenceFileIdentityMatches(fstatSync(descriptor), identity)) {
      throw new Error("resource telemetry JSONL inode changed before append");
    }
    const buffer = Buffer.from(line, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(descriptor, buffer, offset);
      if (written <= 0) throw new Error("resource telemetry JSONL write made no progress");
      offset += written;
    }
    fsyncSync(descriptor);
    if (!evidenceFileIdentityMatches(fstatSync(descriptor), identity)) {
      throw new Error("resource telemetry JSONL inode changed during append");
    }
  } finally {
    closeSync(descriptor);
  }
  if (!evidenceFileIdentityMatches(lstatSync(path), identity)) {
    throw new Error("resource telemetry JSONL path changed after append");
  }
  // The initial pre-gate sample must be durable together with the already
  // persisted directory entry. Repeating the directory fsync is cheap at the
  // one-second cadence and keeps every standalone sample equally durable.
  syncDirectory(dirname(path));
}

function writeSummaryAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let linked = false;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    linkSync(temporaryPath, path);
    linked = true;
    unlinkSync(temporaryPath);
    syncDirectory(dirname(path));
  } catch (error) {
    if (!linked) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The original write/link error remains authoritative.
      }
    }
    throw error;
  }
}

function readProtectedEvidenceFile(
  path: string,
  expectedIdentity?: LocalProcessResourceEvidenceFileIdentity,
): Buffer {
  const pathBefore = evidenceFileIdentity(lstatSync(path));
  if (expectedIdentity && canonicalJson(pathBefore) !== canonicalJson(expectedIdentity)) {
    throw new Error("resource telemetry evidence path identity changed before read");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorBefore = evidenceFileIdentity(fstatSync(descriptor));
    if (canonicalJson(pathBefore) !== canonicalJson(descriptorBefore)) {
      throw new Error("resource telemetry evidence path was replaced before read");
    }
    const bytes = readFileSync(descriptor);
    const descriptorAfter = evidenceFileIdentity(fstatSync(descriptor));
    const pathAfter = evidenceFileIdentity(lstatSync(path));
    if (canonicalJson(descriptorBefore) !== canonicalJson(descriptorAfter)
      || canonicalJson(descriptorBefore) !== canonicalJson(pathAfter)) {
      throw new Error("resource telemetry evidence changed during read");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

async function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || milliseconds <= 0) return;
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolvePromise();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

const DEFAULT_OPERATIONS: LocalProcessResourceTelemetryOperations = {
  readText: (path) => readFileSync(path, "utf8"),
  listProcEntries: () => readdirSync("/proc"),
  runNvidiaSmi: (args) => {
    const result = spawnSync(hostTcbExecutables.nvidiaSmi, [...args], {
      encoding: "utf8",
      timeout: NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      ...(result.error ? { error: result.error.message } : {}),
    };
  },
  now: () => new Date(),
  monotonicNowMs: () => Number(process.hrtime.bigint()) / 1_000_000,
  sleep: abortableSleep,
  captureObserverIdentity: captureNvidiaObserverIdentity,
  prepareEvidenceDirectory: prepareEvidenceDirectoryDurably,
  createJsonl: createEvidenceFile,
  appendJsonl: appendEvidenceLine,
  writeSummary: writeSummaryAtomically,
  readEvidence: readProtectedEvidenceFile,
};

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
  return present.length > 0 ? present.at(-1)! - present[0] : null;
}

function aggregateSourceErrors(samples: LocalProcessResourceSample[]): LocalProcessResourceTelemetrySummary["sourceErrors"] {
  const aggregate = new Map<string, LocalProcessResourceTelemetrySummary["sourceErrors"][number]>();
  for (const sample of samples) {
    for (const error of sample.sourceErrors) {
      const key = `${error.source}\0${error.message}`;
      const existing = aggregate.get(key);
      if (existing) {
        existing.count += 1;
        existing.lastSequence = sample.sequence;
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

export class LocalProcessResourceTelemetryRecorder {
  readonly identity: LocalProcessResourceIdentity;
  readonly observerIdentity: LocalProcessResourceObserverIdentity;
  readonly jsonlPath: string;
  readonly summaryPath: string;

  private readonly operations: LocalProcessResourceTelemetryOperations;
  private readonly jsonlIdentity: LocalProcessResourceEvidenceFileIdentity;
  private readonly samples: LocalProcessResourceSample[] = [];
  private receipt: LocalProcessResourceTelemetryReceipt | null = null;

  constructor(options: {
    identity: LocalProcessResourceIdentity;
    evidenceDirectory: string;
    operations?: Partial<LocalProcessResourceTelemetryOperations>;
  }) {
    this.identity = requireIdentity(options.identity);
    this.operations = { ...DEFAULT_OPERATIONS, ...options.operations };
    this.observerIdentity = this.operations.captureObserverIdentity();
    const evidenceDirectory = resolve(options.evidenceDirectory);
    this.jsonlPath = resolve(evidenceDirectory, LOCAL_PROCESS_RESOURCE_JSONL_BASENAME);
    this.summaryPath = resolve(evidenceDirectory, LOCAL_PROCESS_RESOURCE_SUMMARY_BASENAME);
    this.operations.prepareEvidenceDirectory(evidenceDirectory);
    this.jsonlIdentity = this.operations.createJsonl(this.jsonlPath);
  }

  capture(): LocalProcessResourceSample {
    if (this.receipt) throw new Error("Local process resource telemetry is already finalized");
    const errors: LocalProcessResourceSourceError[] = [];
    const monotonicMs = requireFiniteNonNegative(
      this.operations.monotonicNowMs(),
      "resource telemetry monotonic timestamp",
    );
    const previous = this.samples.at(-1);
    let gapMs = previous ? monotonicMs - previous.monotonicMs : null;
    if (gapMs !== null && gapMs < 0) {
      sourceError(errors, "monotonic_clock", "monotonic sample timestamp moved backwards");
      gapMs = 0;
    }

    const host: LocalProcessResourceSample["host"] = {
      memFreeKiB: null,
      memAvailableKiB: null,
      swapTotalKiB: null,
      swapFreeKiB: null,
      pswpinPages: null,
      pswpoutPages: null,
    };
    try {
      Object.assign(host, parseMeminfo(this.operations.readText("/proc/meminfo")));
    } catch (error) {
      sourceError(errors, "meminfo", error);
    }
    try {
      Object.assign(host, parseVmstat(this.operations.readText("/proc/vmstat")));
    } catch (error) {
      sourceError(errors, "vmstat", error);
    }
    if (previous && previous.host.pswpinPages !== null && host.pswpinPages !== null
      && host.pswpinPages < previous.host.pswpinPages) {
      sourceError(errors, "vmstat", "pswpin counter moved backwards within one boot identity");
    }
    if (previous && previous.host.pswpoutPages !== null && host.pswpoutPages !== null
      && host.pswpoutPages < previous.host.pswpoutPages) {
      sourceError(errors, "vmstat", "pswpout counter moved backwards within one boot identity");
    }

    const initiallyVerified = verifyIdentity(this.identity, this.operations, errors);
    const initialMembers = initiallyVerified
      ? scanProcessGroup(this.identity, this.operations, errors)
      : null;
    const memory = initialMembers
      ? collectProcessMemory(initialMembers, this.operations, errors)
      : null;
    const nvidia = initialMembers && memory
      ? collectNvidiaMemory(initialMembers, this.operations, errors)
      : null;
    const finalMembers = initialMembers
      ? scanProcessGroup(this.identity, this.operations, errors)
      : null;
    const finallyVerified = initialMembers
      ? verifyIdentity(this.identity, this.operations, errors)
      : false;
    const stableMembership = Boolean(
      initialMembers
      && finalMembers
      && mapsEqual(initialMembers, finalMembers),
    );
    if (initialMembers && finalMembers && !stableMembership) {
      sourceError(errors, "process_group_identity", "process-group membership changed during one telemetry sample");
    }
    const attributionVerified = initiallyVerified && finallyVerified && stableMembership && memory !== null;
    const nvidiaUsedMemoryMiB = attributionVerified && nvidia ? nvidia.totalMiB : null;
    // VmRSS includes anonymous, file-backed and shared resident pages. Adding
    // the process-scoped NVIDIA allocation is deliberately conservative on a
    // unified-memory GB10: mappings may overlap, but the envelope cannot have
    // the demonstrated RssAnon-only undercount that would make a downward RAM
    // calibration unsafe.
    const accountedResidentKiB = attributionVerified && nvidiaUsedMemoryMiB !== null
      ? memory.vmRssKiB + nvidiaUsedMemoryMiB * 1_024
      : null;
    const pids = initialMembers ? [...initialMembers.keys()].sort((left, right) => left - right) : [];
    const sample: LocalProcessResourceSample = {
      schemaVersion: "ltx-studio-local-process-resource-sample.v1",
      sequence: this.samples.length + 1,
      capturedAt: this.operations.now().toISOString(),
      monotonicMs,
      gapMs,
      identity: { ...this.identity },
      identityVerified: initiallyVerified && finallyVerified,
      host,
      processGroup: {
        attributionVerified,
        pids,
        processCount: pids.length,
        rssAnonKiB: attributionVerified ? memory.rssAnonKiB : null,
        vmRssKiB: attributionVerified ? memory.vmRssKiB : null,
        vmHwmKiB: attributionVerified ? memory.vmHwmKiB : null,
        vmSwapKiB: attributionVerified ? memory.vmSwapKiB : null,
        nvidiaUsedMemoryMiB,
        accountedResidentKiB,
        nvidiaPids: attributionVerified && nvidia ? nvidia.pids : [],
      },
      sourceErrors: errors,
    };
    const line = `${JSON.stringify(canonicalizeJson(sample))}\n`;
    this.operations.appendJsonl(this.jsonlPath, line, this.jsonlIdentity);
    this.samples.push(sample);
    return structuredClone(sample);
  }

  async run(signal: AbortSignal): Promise<LocalProcessResourceTelemetryReceipt> {
    while (!signal.aborted) {
      const previous = this.samples.at(-1);
      if (previous) {
        const deadline = previous.monotonicMs + LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS;
        const current = requireFiniteNonNegative(
          this.operations.monotonicNowMs(),
          "resource telemetry scheduler timestamp",
        );
        await this.operations.sleep(Math.max(0, deadline - current), signal);
        if (signal.aborted) break;
      }
      this.capture();
    }
    return this.finalize();
  }

  finalize(): LocalProcessResourceTelemetryReceipt {
    if (this.receipt) return structuredClone(this.receipt);
    const finalizedObserverIdentity = this.operations.captureObserverIdentity();
    if (canonicalJson(finalizedObserverIdentity) !== canonicalJson(this.observerIdentity)) {
      throw new Error("Local process resource observer identity changed during the measurement");
    }
    const jsonl = this.operations.readEvidence(this.jsonlPath, this.jsonlIdentity);
    const jsonlSha256 = createHash("sha256").update(jsonl).digest("hex");
    const sourceErrors = aggregateSourceErrors(this.samples);
    const finalizedMonotonicMs = requireFiniteNonNegative(
      this.operations.monotonicNowMs(),
      "resource telemetry finalization timestamp",
    );
    const lastSuccessful = [...this.samples].reverse().find((sample) =>
      sample.sourceErrors.length === 0
      && sample.identityVerified
      && sample.processGroup.attributionVerified);
    const terminalGapMs = lastSuccessful
      ? finalizedMonotonicMs - lastSuccessful.monotonicMs
      : null;
    if (terminalGapMs !== null && terminalGapMs < 0) {
      sourceErrors.push({
        source: "monotonic_clock",
        message: "finalization timestamp precedes the last successful telemetry sample",
        count: 1,
        firstSequence: this.samples.length + 1,
        lastSequence: this.samples.length + 1,
      });
      sourceErrors.sort((left, right) =>
        left.source.localeCompare(right.source) || left.message.localeCompare(right.message));
    }
    const normalizedTerminalGapMs = terminalGapMs === null ? null : Math.max(0, terminalGapMs);
    const maxGapMs = maximum([
      ...this.samples.map((sample) => sample.gapMs),
      normalizedTerminalGapMs,
    ]);
    const qualityReasons: LocalProcessResourceTelemetrySummary["qualityReasons"] = [];
    if (this.samples.length === 0) qualityReasons.push("no_samples");
    if (maxGapMs !== null && maxGapMs > LOCAL_PROCESS_RESOURCE_MAX_GAP_MS) {
      qualityReasons.push("sample_gap_exceeded");
    }
    if (sourceErrors.length > 0) qualityReasons.push("source_errors");
    const finishedAt = this.operations.now().toISOString();
    const summary: LocalProcessResourceTelemetrySummary = {
      schemaVersion: "ltx-studio-local-process-resource-summary.v1",
      identity: { ...this.identity },
      startedAt: this.samples[0]?.capturedAt ?? finishedAt,
      finishedAt,
      intervalMs: LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS,
      maximumPermittedGapMs: LOCAL_PROCESS_RESOURCE_MAX_GAP_MS,
      observer: structuredClone(this.observerIdentity),
      sampleCount: this.samples.length,
      lastSuccessfulSequence: lastSuccessful?.sequence ?? null,
      terminalGapMs: normalizedTerminalGapMs,
      maxGapMs,
      quality: qualityReasons.length === 0 ? "sufficient" : "insufficient",
      qualityReasons,
      sourceErrors,
      jsonl: {
        name: LOCAL_PROCESS_RESOURCE_JSONL_BASENAME,
        bytes: jsonl.byteLength,
        sha256: jsonlSha256,
      },
      metrics: {
        host: {
          minimumMemFreeKiB: minimum(this.samples.map((sample) => sample.host.memFreeKiB)),
          minimumMemAvailableKiB: minimum(this.samples.map((sample) => sample.host.memAvailableKiB)),
          swapTotalKiB: maximum(this.samples.map((sample) => sample.host.swapTotalKiB)),
          minimumSwapFreeKiB: minimum(this.samples.map((sample) => sample.host.swapFreeKiB)),
          pswpinDeltaPages: counterDelta(this.samples.map((sample) => sample.host.pswpinPages)),
          pswpoutDeltaPages: counterDelta(this.samples.map((sample) => sample.host.pswpoutPages)),
        },
        processGroup: {
          maximumProcessCount: maximum(this.samples.map((sample) =>
            sample.processGroup.attributionVerified ? sample.processGroup.processCount : null)),
          maximumRssAnonKiB: maximum(this.samples.map((sample) => sample.processGroup.rssAnonKiB)),
          maximumVmRssKiB: maximum(this.samples.map((sample) => sample.processGroup.vmRssKiB)),
          maximumVmHwmKiB: maximum(this.samples.map((sample) => sample.processGroup.vmHwmKiB)),
          maximumVmSwapKiB: maximum(this.samples.map((sample) => sample.processGroup.vmSwapKiB)),
          maximumNvidiaUsedMemoryMiB: maximum(this.samples.map((sample) =>
            sample.processGroup.nvidiaUsedMemoryMiB)),
          maximumAccountedResidentKiB: maximum(this.samples.map((sample) =>
            sample.processGroup.accountedResidentKiB)),
        },
      },
    };
    const summaryContent = canonicalJson(summary);
    this.operations.writeSummary(this.summaryPath, summaryContent);
    const persistedSummary = this.operations.readEvidence(this.summaryPath);
    const summarySha256 = createHash("sha256").update(persistedSummary).digest("hex");
    if (!persistedSummary.equals(Buffer.from(summaryContent, "utf8"))) {
      throw new Error("Persisted local process resource summary differs from the finalized evidence");
    }
    this.receipt = {
      schemaVersion: "ltx-studio-local-process-resource-evidence.v1",
      jsonlPath: this.jsonlPath,
      jsonlSha256,
      summaryPath: this.summaryPath,
      summarySha256,
      summary,
    };
    return structuredClone(this.receipt);
  }
}
