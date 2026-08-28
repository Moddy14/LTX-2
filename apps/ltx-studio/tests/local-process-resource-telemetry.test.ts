import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOCAL_PROCESS_RESOURCE_JSONL_BASENAME,
  LOCAL_PROCESS_RESOURCE_MAX_GAP_MS,
  LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS,
  LOCAL_PROCESS_RESOURCE_SUMMARY_BASENAME,
  LocalProcessResourceTelemetryRecorder,
  NVIDIA_ML_LICENSE_PATH,
  NVIDIA_ML_SONAME_PATH,
  NVIDIA_PROCESS_MEMORY_QUERY_ARGS,
  NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT,
  NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS,
  type LocalProcessResourceIdentity,
  type LocalProcessResourceObserverIdentity,
  type LocalProcessResourceTelemetryOperations,
} from "../server/localProcessResourceTelemetry.js";

const BOOT_ID = "11111111-1111-4111-8111-111111111111";
const IDENTITY: LocalProcessResourceIdentity = {
  bootId: BOOT_ID,
  processGroupId: 100,
  leaderStartTicks: "1000",
};
const OBSERVER_IDENTITY: LocalProcessResourceObserverIdentity = {
  schemaVersion: "ltx-studio-local-process-resource-observer.v1",
  executable: "/usr/bin/nvidia-smi",
  executableSha256: "a".repeat(64),
  versionArguments: ["--version"],
  versionOutputSha256: "b".repeat(64),
  versionFirstLine: "NVIDIA-SMI fixture",
  queryArguments: [
    "--query-compute-apps=pid,used_memory",
    "--format=csv,noheader,nounits",
  ],
  queryTimeoutMs: NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS,
  environment: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
  dynamicLibraries: [{
    name: "nvml",
    path: "/usr/lib/aarch64-linux-gnu/libnvidia-ml.so.580.173.02",
    sha256: "c".repeat(64),
    licensePath: "/usr/share/doc/libnvidia-compute-580/copyright",
    licenseSha256: "d".repeat(64),
  }],
  residentAccounting: "vmrss-plus-nvidia-used-memory-conservative-envelope.v1",
};
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-local-resources-"));
  temporaryRoots.push(root);
  return root;
}

function processStat(pid: number, processGroupId: number, startTicks: string): string {
  const fields = [
    "S", "1", String(processGroupId), "1", "0", "0", "0", "0", "0", "0",
    "0", "0", "0", "0", "0", "0", "0", "1", "0", startTicks,
  ];
  return `${pid} (test process ${pid}) ${fields.join(" ")}\n`;
}

function processStatus(input: {
  rssAnonKiB: number;
  vmRssKiB: number;
  vmHwmKiB: number;
  vmSwapKiB: number;
}): string {
  return [
    `Name:\ttest`,
    `VmHWM:\t${input.vmHwmKiB} kB`,
    `VmRSS:\t${input.vmRssKiB} kB`,
    `RssAnon:\t${input.rssAnonKiB} kB`,
    `VmSwap:\t${input.vmSwapKiB} kB`,
    "",
  ].join("\n");
}

function fixtureOperations(options: {
  monotonicMs?: number[];
  bootId?: string;
  leaderStartTicks?: string;
  listProcEntries?: () => string[];
  nvidia?: LocalProcessResourceTelemetryOperations["runNvidiaSmi"];
  sleep?: LocalProcessResourceTelemetryOperations["sleep"];
} = {}): {
  operations: Partial<LocalProcessResourceTelemetryOperations>;
  runNvidiaSmi: ReturnType<typeof vi.fn<LocalProcessResourceTelemetryOperations["runNvidiaSmi"]>>;
  readText: ReturnType<typeof vi.fn<LocalProcessResourceTelemetryOperations["readText"]>>;
  listProcEntries: ReturnType<typeof vi.fn<LocalProcessResourceTelemetryOperations["listProcEntries"]>>;
} {
  let meminfoRead = 0;
  let vmstatRead = 0;
  let wallRead = 0;
  const monotonic = [...(options.monotonicMs ?? [0])];
  let lastMonotonic = monotonic[0] ?? 0;
  const runNvidiaSmi = vi.fn<LocalProcessResourceTelemetryOperations["runNvidiaSmi"]>(
    options.nvidia ?? (() => ({
      status: 0,
      signal: null,
      stdout: "100, 128\n101, 256\n999, 999\n",
      stderr: "",
    })),
  );
  const readText = vi.fn<LocalProcessResourceTelemetryOperations["readText"]>((path: string): string => {
    if (path === "/proc/sys/kernel/random/boot_id") return `${options.bootId ?? BOOT_ID}\n`;
    if (path === "/proc/meminfo") {
      const available = [1_000_000, 900_000][Math.min(meminfoRead, 1)];
      const free = [300_000, 250_000][Math.min(meminfoRead, 1)];
      const swapFree = [500_000, 450_000][Math.min(meminfoRead, 1)];
      meminfoRead += 1;
      return `MemTotal: 2000000 kB\nMemFree: ${free} kB\nMemAvailable: ${available} kB\nSwapTotal: 600000 kB\nSwapFree: ${swapFree} kB\n`;
    }
    if (path === "/proc/vmstat") {
      const pswpin = [10, 13][Math.min(vmstatRead, 1)];
      const pswpout = [20, 27][Math.min(vmstatRead, 1)];
      vmstatRead += 1;
      return `pgpgin 1\npswpin ${pswpin}\npswpout ${pswpout}\n`;
    }
    const statMatch = /^\/proc\/(\d+)\/stat$/u.exec(path);
    if (statMatch) {
      const pid = Number(statMatch[1]);
      if (pid === 2) return processStat(pid, 0, "2");
      if (pid === 100) return processStat(pid, 100, options.leaderStartTicks ?? "1000");
      if (pid === 101) return processStat(pid, 100, "1001");
      if (pid === 999) return processStat(pid, 999, "9990");
    }
    if (path === "/proc/100/status") {
      return processStatus({ rssAnonKiB: 100, vmRssKiB: 150, vmHwmKiB: 200, vmSwapKiB: 10 });
    }
    if (path === "/proc/101/status") {
      return processStatus({ rssAnonKiB: 300, vmRssKiB: 400, vmHwmKiB: 500, vmSwapKiB: 20 });
    }
    throw Object.assign(new Error(`unexpected fixture read: ${path}`), { code: "ENOENT" });
  });
  const listProcEntries = vi.fn<LocalProcessResourceTelemetryOperations["listProcEntries"]>(
    options.listProcEntries ?? (() => ["2", "100", "101", "999", "self"]),
  );
  return {
    runNvidiaSmi,
    readText,
    listProcEntries,
    operations: {
      captureObserverIdentity: () => structuredClone(OBSERVER_IDENTITY),
      readText,
      listProcEntries,
      runNvidiaSmi,
      monotonicNowMs: () => {
        const next = monotonic.shift();
        if (next !== undefined) lastMonotonic = next;
        return lastMonotonic;
      },
      now: () => new Date(Date.UTC(2026, 7, 28, 10, 0, wallRead++)),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    },
  };
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

describe("local process resource telemetry", () => {
  it("durably creates every missing evidence directory with private file modes", async () => {
    const root = await temporaryRoot();
    const evidenceDirectory = join(root, "resource-telemetry", "job-1", "ltx-g0");
    const fixture = fixtureOperations();
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory,
      operations: fixture.operations,
    });

    for (const directory of [
      join(root, "resource-telemetry"),
      join(root, "resource-telemetry", "job-1"),
      evidenceDirectory,
    ]) {
      const stats = await lstat(directory);
      expect(stats.isDirectory()).toBe(true);
      expect(stats.isSymbolicLink()).toBe(false);
      expect(stats.mode & 0o777).toBe(0o700);
    }
    expect((await lstat(recorder.jsonlPath)).mode & 0o777).toBe(0o600);

    recorder.capture();
    const receipt = recorder.finalize();

    expect((await lstat(receipt.summaryPath)).mode & 0o777).toBe(0o600);
  });

  it("fails before creating JSONL when evidence-directory preparation fails", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations();
    const prepareEvidenceDirectory = vi.fn<LocalProcessResourceTelemetryOperations["prepareEvidenceDirectory"]>(
      () => { throw new Error("fixture prepare durability failure"); },
    );
    const createJsonl = vi.fn<LocalProcessResourceTelemetryOperations["createJsonl"]>();

    expect(() => new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: join(root, "evidence"),
      operations: {
        ...fixture.operations,
        prepareEvidenceDirectory,
        createJsonl,
      },
    })).toThrow("fixture prepare durability failure");

    expect(prepareEvidenceDirectory).toHaveBeenCalledOnce();
    expect(createJsonl).not.toHaveBeenCalled();
    expect(fixture.readText).not.toHaveBeenCalled();
    expect(fixture.listProcEntries).not.toHaveBeenCalled();
    expect(fixture.runNvidiaSmi).not.toHaveBeenCalled();
  });

  it("fails before the first probe when exclusive JSONL creation fails", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations();
    const prepareEvidenceDirectory = vi.fn<LocalProcessResourceTelemetryOperations["prepareEvidenceDirectory"]>();
    const createJsonl = vi.fn<LocalProcessResourceTelemetryOperations["createJsonl"]>(
      () => { throw new Error("fixture exclusive create failure"); },
    );

    expect(() => new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: join(root, "evidence"),
      operations: {
        ...fixture.operations,
        prepareEvidenceDirectory,
        createJsonl,
      },
    })).toThrow("fixture exclusive create failure");

    expect(prepareEvidenceDirectory).toHaveBeenCalledOnce();
    expect(createJsonl).toHaveBeenCalledOnce();
    expect(fixture.readText).not.toHaveBeenCalled();
    expect(fixture.listProcEntries).not.toHaveBeenCalled();
    expect(fixture.runNvidiaSmi).not.toHaveBeenCalled();
  });

  it("does not commit a sample when its first durable JSONL append fails", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations();
    const appendJsonl = vi.fn<LocalProcessResourceTelemetryOperations["appendJsonl"]>(
      () => { throw new Error("fixture append fsync failure"); },
    );
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: { ...fixture.operations, appendJsonl },
    });

    expect(() => recorder.capture()).toThrow("fixture append fsync failure");
    expect(appendJsonl).toHaveBeenCalledOnce();
    expect(appendJsonl.mock.calls[0]?.[2]).toMatchObject({
      deviceId: expect.any(String),
      fileId: expect.any(String),
      linkCount: 1,
    });
    expect(await readFile(recorder.jsonlPath, "utf8")).toBe("");
    expect(recorder.finalize().summary).toMatchObject({
      sampleCount: 0,
      quality: "insufficient",
      qualityReasons: ["no_samples"],
    });
  });

  it("rejects a JSONL path replacement before appending the first sample", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations();
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });
    const displacedPath = `${recorder.jsonlPath}.displaced`;
    await rename(recorder.jsonlPath, displacedPath);
    await writeFile(recorder.jsonlPath, "", { mode: 0o600 });

    expect(() => recorder.capture()).toThrow("resource telemetry JSONL inode changed before append");
    expect(await readFile(recorder.jsonlPath, "utf8")).toBe("");
    expect(await readFile(displacedPath, "utf8")).toBe("");
  });

  it("rejects a hard-linked JSONL before appending the first sample", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations();
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });
    const hardlinkPath = `${recorder.jsonlPath}.hardlink`;
    await link(recorder.jsonlPath, hardlinkPath);

    expect(() => recorder.capture()).toThrow(
      "resource telemetry evidence file identity, ownership, mode, or link count is unsafe",
    );
    expect(await readFile(recorder.jsonlPath, "utf8")).toBe("");
    expect(await readFile(hardlinkPath, "utf8")).toBe("");
  });

  it("rejects observer identity drift at finalize without writing a summary", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations();
    let observerCapture = 0;
    const captureObserverIdentity = vi.fn<LocalProcessResourceTelemetryOperations["captureObserverIdentity"]>(
      () => observerCapture++ === 0
        ? structuredClone(OBSERVER_IDENTITY)
        : { ...structuredClone(OBSERVER_IDENTITY), executableSha256: "c".repeat(64) },
    );
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: { ...fixture.operations, captureObserverIdentity },
    });

    recorder.capture();

    expect(() => recorder.finalize()).toThrow(
      "Local process resource observer identity changed during the measurement",
    );
    expect(captureObserverIdentity).toHaveBeenCalledTimes(2);
    await expect(readFile(recorder.summaryPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(recorder.jsonlPath, "utf8")).trim()).not.toBe("");
  });

  it("attributes host, process-group and NVIDIA memory to one exact identity", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations({ monotonicMs: [0, 1_000] });
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });

    const first = recorder.capture();
    const second = recorder.capture();
    const receipt = recorder.finalize();

    expect(first).toMatchObject({
      sequence: 1,
      gapMs: null,
      identityVerified: true,
      host: {
        memFreeKiB: 300_000,
        memAvailableKiB: 1_000_000,
        swapTotalKiB: 600_000,
        swapFreeKiB: 500_000,
        pswpinPages: 10,
        pswpoutPages: 20,
      },
      processGroup: {
        attributionVerified: true,
        pids: [100, 101],
        processCount: 2,
        rssAnonKiB: 400,
        vmRssKiB: 550,
        vmHwmKiB: 700,
        vmSwapKiB: 30,
        nvidiaUsedMemoryMiB: 384,
        accountedResidentKiB: 393_766,
        nvidiaPids: [
          { pid: 100, usedMemoryMiB: 128 },
          { pid: 101, usedMemoryMiB: 256 },
        ],
      },
      sourceErrors: [],
    });
    expect(second.gapMs).toBe(1_000);
    expect(fixture.runNvidiaSmi).toHaveBeenCalledTimes(2);
    expect(fixture.runNvidiaSmi).toHaveBeenCalledWith(NVIDIA_PROCESS_MEMORY_QUERY_ARGS);

    expect(receipt.summary).toMatchObject({
      intervalMs: LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS,
      maximumPermittedGapMs: LOCAL_PROCESS_RESOURCE_MAX_GAP_MS,
      sampleCount: 2,
      lastSuccessfulSequence: 2,
      terminalGapMs: 0,
      maxGapMs: 1_000,
      quality: "sufficient",
      qualityReasons: [],
      sourceErrors: [],
      metrics: {
        host: {
          minimumMemFreeKiB: 250_000,
          minimumMemAvailableKiB: 900_000,
          swapTotalKiB: 600_000,
          minimumSwapFreeKiB: 450_000,
          pswpinDeltaPages: 3,
          pswpoutDeltaPages: 7,
        },
        processGroup: {
          maximumProcessCount: 2,
          maximumRssAnonKiB: 400,
          maximumVmRssKiB: 550,
          maximumVmHwmKiB: 700,
          maximumVmSwapKiB: 30,
          maximumNvidiaUsedMemoryMiB: 384,
          maximumAccountedResidentKiB: 393_766,
        },
      },
    });
    expect(receipt.jsonlPath).toBe(join(root, LOCAL_PROCESS_RESOURCE_JSONL_BASENAME));
    expect(receipt.summaryPath).toBe(join(root, LOCAL_PROCESS_RESOURCE_SUMMARY_BASENAME));
    expect(receipt.jsonlSha256).toBe(await fileSha256(receipt.jsonlPath));
    expect(receipt.summarySha256).toBe(await fileSha256(receipt.summaryPath));
    const lines = (await readFile(receipt.jsonlPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual(first);
    expect(lines[1]).toEqual(second);
    const persistedSummary = JSON.parse(await readFile(receipt.summaryPath, "utf8"));
    expect(persistedSummary).toEqual(receipt.summary);
    expect(persistedSummary.jsonl.sha256).toBe(receipt.jsonlSha256);
  });

  it("marks a sample gap above three seconds as insufficient", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations({ monotonicMs: [0, 3_001] });
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });

    recorder.capture();
    recorder.capture();
    const receipt = recorder.finalize();

    expect(receipt.summary).toMatchObject({
      sampleCount: 2,
      maxGapMs: 3_001,
      quality: "insufficient",
      qualityReasons: ["sample_gap_exceeded"],
    });
  });

  it("includes the terminal no-probe interval in maxGap without another PG read", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations({ monotonicMs: [0, 4_001] });
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });

    recorder.capture();
    const nvidiaCallsBeforeFinalize = fixture.runNvidiaSmi.mock.calls.length;
    const procReadsBeforeFinalize = fixture.readText.mock.calls.length;
    const procScansBeforeFinalize = fixture.listProcEntries.mock.calls.length;
    const receipt = recorder.finalize();

    expect(fixture.runNvidiaSmi).toHaveBeenCalledTimes(nvidiaCallsBeforeFinalize);
    expect(fixture.readText).toHaveBeenCalledTimes(procReadsBeforeFinalize);
    expect(fixture.listProcEntries).toHaveBeenCalledTimes(procScansBeforeFinalize);
    expect(receipt.summary).toMatchObject({
      sampleCount: 1,
      lastSuccessfulSequence: 1,
      terminalGapMs: 4_001,
      maxGapMs: 4_001,
      quality: "insufficient",
      qualityReasons: ["sample_gap_exceeded"],
    });
  });

  it("retains process metrics but fails quality when the NVIDIA source fails", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations({
      nvidia: () => ({ status: 1, signal: null, stdout: "", stderr: "driver query failed" }),
    });
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });

    const sample = recorder.capture();
    const receipt = recorder.finalize();

    expect(sample.processGroup).toMatchObject({
      attributionVerified: true,
      rssAnonKiB: 400,
      nvidiaUsedMemoryMiB: null,
      accountedResidentKiB: null,
      nvidiaPids: [],
    });
    expect(sample.sourceErrors).toEqual([
      { source: "nvidia_smi", message: "driver query failed" },
    ]);
    expect(receipt.summary.quality).toBe("insufficient");
    expect(receipt.summary.qualityReasons).toEqual(["source_errors"]);
    expect(receipt.summary.sourceErrors).toEqual([{
      source: "nvidia_smi",
      message: "driver query failed",
      count: 1,
      firstSequence: 1,
      lastSequence: 1,
    }]);
  });

  it("does not inspect or attribute a process group after boot identity drift", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations({ bootId: "22222222-2222-4222-8222-222222222222" });
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });

    const sample = recorder.capture();
    const receipt = recorder.finalize();

    expect(sample.identityVerified).toBe(false);
    expect(sample.processGroup).toMatchObject({
      attributionVerified: false,
      pids: [],
      processCount: 0,
      rssAnonKiB: null,
      nvidiaUsedMemoryMiB: null,
    });
    expect(fixture.runNvidiaSmi).not.toHaveBeenCalled();
    expect(sample.sourceErrors.map((error) => error.source)).toEqual(["boot_id"]);
    expect(receipt.summary.quality).toBe("insufficient");
  });

  it("rejects a reused PGID when the leader start ticks no longer match", async () => {
    const root = await temporaryRoot();
    const fixture = fixtureOperations({ leaderStartTicks: "2000" });
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });

    const sample = recorder.capture();

    expect(sample.identityVerified).toBe(false);
    expect(sample.processGroup.attributionVerified).toBe(false);
    expect(fixture.runNvidiaSmi).not.toHaveBeenCalled();
    expect(sample.sourceErrors).toEqual([{
      source: "leader_stat",
      message: "process-group leader no longer matches its bound PGID/start ticks",
    }]);
    expect(recorder.finalize().summary.quality).toBe("insufficient");
  });

  it("invalidates sums when process-group membership changes within a sample", async () => {
    const root = await temporaryRoot();
    let scan = 0;
    const fixture = fixtureOperations({
      listProcEntries: () => scan++ === 0 ? ["100", "101"] : ["100"],
    });
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });

    const sample = recorder.capture();

    expect(sample.identityVerified).toBe(true);
    expect(sample.processGroup).toMatchObject({
      attributionVerified: false,
      pids: [100, 101],
      processCount: 2,
      rssAnonKiB: null,
      vmRssKiB: null,
      nvidiaUsedMemoryMiB: null,
    });
    expect(sample.sourceErrors).toEqual([{
      source: "process_group_identity",
      message: "process-group membership changed during one telemetry sample",
    }]);
    expect(recorder.finalize().summary.quality).toBe("insufficient");
  });

  it("runs on a one-second start-to-start cadence until aborted", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    let monotonicMs = 0;
    const waits: number[] = [];
    const fixture = fixtureOperations({
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        monotonicMs += milliseconds;
        if (waits.length === 2) controller.abort();
      },
    });
    fixture.operations.monotonicNowMs = () => monotonicMs;
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });

    const receipt = await recorder.run(controller.signal);

    expect(waits).toEqual([1_000, 1_000]);
    expect(receipt.summary).toMatchObject({
      sampleCount: 2,
      maxGapMs: 1_000,
      quality: "sufficient",
    });
  });

  it("waits one interval after a pre-gate sample instead of duplicating it", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    let monotonicMs = 0;
    const waits: number[] = [];
    const fixture = fixtureOperations({
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        monotonicMs += milliseconds;
        controller.abort();
      },
    });
    fixture.operations.monotonicNowMs = () => monotonicMs;
    const recorder = new LocalProcessResourceTelemetryRecorder({
      identity: IDENTITY,
      evidenceDirectory: root,
      operations: fixture.operations,
    });

    recorder.capture();
    const receipt = await recorder.run(controller.signal);

    expect(waits).toEqual([1_000]);
    expect(receipt.summary).toMatchObject({
      sampleCount: 1,
      terminalGapMs: 1_000,
      quality: "sufficient",
    });
  });

  it("uses a fixed read-only NVIDIA query with a sub-second timeout", () => {
    expect(NVIDIA_PROCESS_MEMORY_QUERY_ARGS).toEqual([
      "--query-compute-apps=pid,used_memory",
      "--format=csv,noheader,nounits",
    ]);
    expect(NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS).toBeLessThan(1_000);
    expect(NVIDIA_PROCESS_MEMORY_QUERY_ENVIRONMENT).toEqual({
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LC_ALL: "C",
    });
    expect(NVIDIA_ML_SONAME_PATH).toBe("/usr/lib/aarch64-linux-gnu/libnvidia-ml.so.1");
    expect(NVIDIA_ML_LICENSE_PATH).toBe("/usr/share/doc/libnvidia-compute-580/copyright");
  });
});
