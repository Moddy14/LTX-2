import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { canonicalizeJson, canonicalJson } from "../shared/canonicalJson.js";
import { LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_BASIS } from "../shared/estimates.js";
import {
  LOCAL_PROCESS_RESOURCE_JSONL_BASENAME,
  LOCAL_PROCESS_RESOURCE_MAX_GAP_MS,
  LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS,
  LOCAL_PROCESS_RESOURCE_SUMMARY_BASENAME,
  NVIDIA_PROCESS_MEMORY_QUERY_TIMEOUT_MS,
  type LocalProcessResourceIdentity,
  type LocalProcessResourceObserverIdentity,
  type LocalProcessResourceSample,
  type LocalProcessResourceTelemetrySummary,
} from "../server/localProcessResourceTelemetry.js";
import {
  captureLtxResourceTelemetryOutput,
  LTX_RESOURCE_TELEMETRY_MANIFEST_BASENAME,
  ltxResourceTelemetryMeasurementBlockers,
  verifyLtxResourceTelemetryEvidence,
  type LtxResourceTelemetryBinding,
  type LtxResourceTelemetryManifest,
  type LtxResourceTelemetryOutputTechnicalReceipt,
} from "../server/ltxResourceTelemetryEvidence.js";

const temporaryRoots: string[] = [];
let validOutputBytes: Buffer;
let validOutputTechnical: LtxResourceTelemetryOutputTechnicalReceipt;
const IDENTITY: LocalProcessResourceIdentity = {
  bootId: "11111111-1111-4111-8111-111111111111",
  processGroupId: 321,
  leaderStartTicks: "987654",
};
const OBSERVER: LocalProcessResourceObserverIdentity = {
  schemaVersion: "ltx-studio-local-process-resource-observer.v1",
  executable: "/usr/bin/nvidia-smi",
  executableSha256: "f".repeat(64),
  versionArguments: ["--version"],
  versionOutputSha256: "0".repeat(64),
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

type EvidenceFixture = {
  root: string;
  evidenceDirectory: string;
  manifestPath: string;
  jsonlPath: string;
  summaryPath: string;
  outputPath: string;
  binding: LtxResourceTelemetryBinding;
  manifest: LtxResourceTelemetryManifest;
};

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "ltx-resource-valid-output-"));
  temporaryRoots.push(root);
  const path = join(root, "valid-ia2v.mp4");
  const result = spawnSync("/usr/bin/ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=1024x1536:r=24:d=12.041667",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo:d=12.041667",
    "-frames:v",
    "289",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-shortest",
    path,
  ], { encoding: "utf8", timeout: 15_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`ffmpeg IA2V contract fixture failed: ${result.error?.message ?? result.stderr}`);
  }
  validOutputBytes = await readFile(path);
  validOutputTechnical = captureLtxResourceTelemetryOutput(path).technical;
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sample(input: {
  sequence: number;
  capturedAt: string;
  monotonicMs: number;
  gapMs: number | null;
  memFreeKiB: number;
  memAvailableKiB: number;
  rssAnonKiB: number;
  vmRssKiB: number;
  vmHwmKiB: number;
  nvidiaUsedMemoryMiB: number;
}): LocalProcessResourceSample {
  return {
    schemaVersion: "ltx-studio-local-process-resource-sample.v1",
    sequence: input.sequence,
    capturedAt: input.capturedAt,
    monotonicMs: input.monotonicMs,
    gapMs: input.gapMs,
    identity: structuredClone(IDENTITY),
    identityVerified: true,
    host: {
      memFreeKiB: input.memFreeKiB,
      memAvailableKiB: input.memAvailableKiB,
      swapTotalKiB: 0,
      swapFreeKiB: 0,
      pswpinPages: 10,
      pswpoutPages: 20,
    },
    processGroup: {
      attributionVerified: true,
      pids: [321],
      processCount: 1,
      rssAnonKiB: input.rssAnonKiB,
      vmRssKiB: input.vmRssKiB,
      vmHwmKiB: input.vmHwmKiB,
      vmSwapKiB: 0,
      nvidiaUsedMemoryMiB: input.nvidiaUsedMemoryMiB,
      accountedResidentKiB: input.vmRssKiB + input.nvidiaUsedMemoryMiB * 1_024,
      nvidiaPids: [{ pid: 321, usedMemoryMiB: input.nvidiaUsedMemoryMiB }],
    },
    sourceErrors: [],
  };
}

function manifestFingerprint(manifest: Omit<LtxResourceTelemetryManifest, "fingerprint">): string {
  return sha256(canonicalJson(manifest));
}

async function writeManifest(path: string, manifest: LtxResourceTelemetryManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function createEvidenceFixture(): Promise<EvidenceFixture> {
  const root = await mkdtemp(join(tmpdir(), "ltx-resource-evidence-"));
  temporaryRoots.push(root);
  const studioJobId = "11111111-2222-4333-8444-555555555555";
  const evidenceDirectory = join(root, "resource-telemetry", studioJobId, "ltx-g0");
  const jsonlPath = join(evidenceDirectory, LOCAL_PROCESS_RESOURCE_JSONL_BASENAME);
  const summaryPath = join(evidenceDirectory, LOCAL_PROCESS_RESOURCE_SUMMARY_BASENAME);
  const manifestPath = join(evidenceDirectory, LTX_RESOURCE_TELEMETRY_MANIFEST_BASENAME);
  const outputPath = join(root, "outputs", "candidate.mp4");
  await mkdir(evidenceDirectory, { recursive: true, mode: 0o700 });
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });

  const samples = [
    sample({
      sequence: 1,
      capturedAt: "2026-08-28T10:00:00.000Z",
      monotonicMs: 1_000,
      gapMs: null,
      memFreeKiB: 10_000_000,
      memAvailableKiB: 20_000_000,
      rssAnonKiB: 2_048,
      vmRssKiB: 4_096,
      vmHwmKiB: 4_096,
      nvidiaUsedMemoryMiB: 2_048,
    }),
    sample({
      sequence: 2,
      capturedAt: "2026-08-28T10:00:01.000Z",
      monotonicMs: 2_000,
      gapMs: 1_000,
      memFreeKiB: 7_000_000,
      memAvailableKiB: 15_000_000,
      rssAnonKiB: 4_096,
      vmRssKiB: 8_192,
      vmHwmKiB: 8_192,
      nvidiaUsedMemoryMiB: 3_072,
    }),
  ];
  const jsonl = `${samples.map((entry) => JSON.stringify(canonicalizeJson(entry))).join("\n")}\n`;
  await writeFile(jsonlPath, jsonl, { mode: 0o600 });
  await chmod(jsonlPath, 0o600);
  const jsonlSha256 = sha256(jsonl);
  const summary: LocalProcessResourceTelemetrySummary = {
    schemaVersion: "ltx-studio-local-process-resource-summary.v1",
    identity: structuredClone(IDENTITY),
    startedAt: samples[0]!.capturedAt,
    finishedAt: "2026-08-28T10:00:01.500Z",
    intervalMs: LOCAL_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS,
    maximumPermittedGapMs: LOCAL_PROCESS_RESOURCE_MAX_GAP_MS,
    observer: structuredClone(OBSERVER),
    sampleCount: 2,
    lastSuccessfulSequence: 2,
    terminalGapMs: 500,
    maxGapMs: 1_000,
    quality: "sufficient",
    qualityReasons: [],
    sourceErrors: [],
    jsonl: {
      name: LOCAL_PROCESS_RESOURCE_JSONL_BASENAME,
      bytes: Buffer.byteLength(jsonl),
      sha256: jsonlSha256,
    },
    metrics: {
      host: {
        minimumMemFreeKiB: 7_000_000,
        minimumMemAvailableKiB: 15_000_000,
        swapTotalKiB: 0,
        minimumSwapFreeKiB: 0,
        pswpinDeltaPages: 0,
        pswpoutDeltaPages: 0,
      },
      processGroup: {
        maximumProcessCount: 1,
        maximumRssAnonKiB: 4_096,
        maximumVmRssKiB: 8_192,
        maximumVmHwmKiB: 8_192,
        maximumVmSwapKiB: 0,
        maximumNvidiaUsedMemoryMiB: 3_072,
        maximumAccountedResidentKiB: 3_153_920,
      },
    },
  };
  const summaryText = canonicalJson(summary);
  await writeFile(summaryPath, summaryText, { mode: 0o600 });
  await chmod(summaryPath, 0o600);
  const output = validOutputBytes;
  await writeFile(outputPath, output, { mode: 0o600 });

  const binding: LtxResourceTelemetryBinding = {
    studioJobId,
    dgxJobId: "dgx-job-20260828-fixture",
    preparedAdmissionSha256: "a".repeat(64),
    declaredMemoryGiB: 66,
    requiredMemoryGiB: 66,
    memoryBasis: LTX25_SPLIT_BF16_IA2V_1024X1536_289F_MEMORY_BASIS,
    requestSha256: "b".repeat(64),
    runProvenanceFingerprint: "c".repeat(64),
    runProvenanceSha256: "d".repeat(64),
    cooperativeGeneration: 0,
    executable: "/usr/bin/python3",
    argumentsSha256: "e".repeat(64),
    processIdentity: structuredClone(IDENTITY),
    observerIdentity: structuredClone(OBSERVER),
  };
  const unsignedManifest: Omit<LtxResourceTelemetryManifest, "fingerprint"> = {
    schemaVersion: "ltx-studio-ltx-resource-telemetry-manifest.v1",
    binding,
    telemetry: {
      jsonlPath,
      jsonlSha256,
      summaryPath,
      summarySha256: sha256(summaryText),
      summary,
    },
    observerError: null,
    processOutcome: { code: 0, signal: null, error: null },
    processGroupGone: true,
    processGroupExitedNaturally: true,
    thermalPauseCount: 0,
    output: {
      path: outputPath,
      sizeBytes: output.byteLength,
      sha256: sha256(output),
      technical: structuredClone(validOutputTechnical),
    },
    measurementEligibleForCalibration: true,
    recordedAt: "2026-08-28T10:00:02.000Z",
  };
  const manifest: LtxResourceTelemetryManifest = {
    ...unsignedManifest,
    fingerprint: manifestFingerprint(unsignedManifest),
  };
  await writeManifest(manifestPath, manifest);
  return { root, evidenceDirectory, manifestPath, jsonlPath, summaryPath, outputPath, binding, manifest };
}

async function rewriteManifest(
  fixture: EvidenceFixture,
  mutate: (manifest: LtxResourceTelemetryManifest) => void,
): Promise<LtxResourceTelemetryManifest> {
  const manifest = structuredClone(fixture.manifest);
  mutate(manifest);
  const { fingerprint: _oldFingerprint, ...unsignedManifest } = manifest;
  void _oldFingerprint;
  manifest.fingerprint = manifestFingerprint(unsignedManifest);
  await writeManifest(fixture.manifestPath, manifest);
  fixture.manifest = manifest;
  return manifest;
}

describe("LTX resource telemetry evidence verifier", () => {
  it("verifies exact protected siblings, bindings, summary aggregation and output bytes", async () => {
    const fixture = await createEvidenceFixture();

    const verified = verifyLtxResourceTelemetryEvidence(fixture.manifestPath, {
      expectedBinding: fixture.binding,
      expectedOutputPath: fixture.outputPath,
    });

    expect(verified).toMatchObject({
      manifestPath: fixture.manifestPath,
      manifestSha256: sha256(await readFile(fixture.manifestPath)),
      jsonlSha256: fixture.manifest.telemetry?.jsonlSha256,
      summarySha256: fixture.manifest.telemetry?.summarySha256,
      outputSha256: fixture.manifest.output?.sha256,
      externalBindingMatched: true,
      expectedOutputPathMatched: true,
    });
    expect(verified.manifest.measurementEligibleForCalibration).toBe(true);
  });

  it("uses one fail-closed intrinsic gate for the exact profile, host headroom and resident ceiling", async () => {
    const fixture = await createEvidenceFixture();
    const base = {
      binding: fixture.binding,
      summary: fixture.manifest.telemetry!.summary,
      observerError: null,
      result: fixture.manifest.processOutcome,
      processGroupGone: true,
      processGroupExitedNaturally: true,
      thermalPauseCount: 0,
      outputBound: true,
      outputTechnicalValid: true,
    };

    expect(ltxResourceTelemetryMeasurementBlockers(base)).toEqual([]);
    expect(ltxResourceTelemetryMeasurementBlockers({
      ...base,
      thermalPauseCount: 1,
    })).toContain("thermal_pause_observed");
    expect(ltxResourceTelemetryMeasurementBlockers({
      ...base,
      outputTechnicalValid: false,
    })).toContain("output_technical_contract_invalid");
    expect(ltxResourceTelemetryMeasurementBlockers({
      ...base,
      binding: { ...base.binding, declaredMemoryGiB: 67 },
    })).toContain("memory_profile_not_exact");
    expect(ltxResourceTelemetryMeasurementBlockers({
      ...base,
      summary: {
        ...base.summary,
        metrics: {
          ...base.summary.metrics,
          host: { ...base.summary.metrics.host, minimumMemAvailableKiB: 12 * 1_048_576 - 1 },
        },
      },
    })).toContain("host_minimum_available_below_12_gib");
    expect(ltxResourceTelemetryMeasurementBlockers({
      ...base,
      summary: {
        ...base.summary,
        metrics: {
          ...base.summary.metrics,
          processGroup: {
            ...base.summary.metrics.processGroup,
            maximumAccountedResidentKiB: 66 * 1_048_576 + 1,
          },
        },
      },
    })).toContain("resident_peak_exceeds_declared_memory");
  });

  it("rejects a caller binding or output pathname that differs from the durable run authority", async () => {
    const fixture = await createEvidenceFixture();
    const wrongBinding = structuredClone(fixture.binding);
    wrongBinding.requestSha256 = "9".repeat(64);

    expect(() => verifyLtxResourceTelemetryEvidence(fixture.manifestPath, {
      expectedBinding: wrongBinding,
    })).toThrow(/expected admission\/request\/provenance\/profile binding/u);
    expect(() => verifyLtxResourceTelemetryEvidence(fixture.manifestPath, {
      expectedOutputPath: join(fixture.root, "outputs", "other.mp4"),
    })).toThrow(/expected output path/u);
  });

  it("rejects manifest fingerprint tampering even when protected-file attributes remain valid", async () => {
    const fixture = await createEvidenceFixture();
    const tampered = structuredClone(fixture.manifest);
    tampered.fingerprint = "8".repeat(64);
    await writeManifest(fixture.manifestPath, tampered);

    expect(() => verifyLtxResourceTelemetryEvidence(fixture.manifestPath))
      .toThrow(/fingerprint/u);
  });

  it("rejects JSONL byte tampering through the persisted SHA chain", async () => {
    const fixture = await createEvidenceFixture();
    await writeFile(fixture.jsonlPath, `${await readFile(fixture.jsonlPath, "utf8")} `, { mode: 0o600 });
    await chmod(fixture.jsonlPath, 0o600);

    expect(() => verifyLtxResourceTelemetryEvidence(fixture.manifestPath))
      .toThrow(/SHA-256/u);
  });

  it("recomputes summary metrics instead of trusting a self-consistent rewritten SHA chain", async () => {
    const fixture = await createEvidenceFixture();
    const summary = structuredClone(fixture.manifest.telemetry!.summary);
    summary.metrics.processGroup.maximumAccountedResidentKiB = 99_999_999;
    const summaryText = canonicalJson(summary);
    await writeFile(fixture.summaryPath, summaryText, { mode: 0o600 });
    await chmod(fixture.summaryPath, 0o600);
    await rewriteManifest(fixture, (manifest) => {
      manifest.telemetry!.summary = summary;
      manifest.telemetry!.summarySha256 = sha256(summaryText);
      manifest.measurementEligibleForCalibration = false;
    });

    expect(() => verifyLtxResourceTelemetryEvidence(fixture.manifestPath))
      .toThrow(/summary metrics/u);
  });

  it("binds the persisted summary observer and every sample identity to the manifest", async () => {
    const fixture = await createEvidenceFixture();
    const summary = structuredClone(fixture.manifest.telemetry!.summary);
    summary.observer.executableSha256 = "7".repeat(64);
    const summaryText = canonicalJson(summary);
    await writeFile(fixture.summaryPath, summaryText, { mode: 0o600 });
    await chmod(fixture.summaryPath, 0o600);
    await rewriteManifest(fixture, (manifest) => {
      manifest.telemetry!.summary = summary;
      manifest.telemetry!.summarySha256 = sha256(summaryText);
      manifest.measurementEligibleForCalibration = false;
    });

    expect(() => verifyLtxResourceTelemetryEvidence(fixture.manifestPath))
      .toThrow(/summary observer/u);
  });

  it("rejects a telemetry sibling path redirected outside the exact generation directory", async () => {
    const fixture = await createEvidenceFixture();
    await rewriteManifest(fixture, (manifest) => {
      manifest.telemetry!.summaryPath = join(fixture.root, LOCAL_PROCESS_RESOURCE_SUMMARY_BASENAME);
    });

    expect(() => verifyLtxResourceTelemetryEvidence(fixture.manifestPath))
      .toThrow(/exact evidence siblings/u);
  });

  it("rejects non-private and multiply-linked evidence files", async () => {
    const wrongMode = await createEvidenceFixture();
    await chmod(wrongMode.summaryPath, 0o640);
    expect(() => verifyLtxResourceTelemetryEvidence(wrongMode.manifestPath))
      .toThrow(/trusted, private/u);

    const hardLinked = await createEvidenceFixture();
    await link(hardLinked.summaryPath, join(hardLinked.root, "summary-hardlink.json"));
    expect(() => verifyLtxResourceTelemetryEvidence(hardLinked.manifestPath))
      .toThrow(/trusted, private/u);
  });

  it("rejects a manifest reached through a symbolic-link pathname", async () => {
    const fixture = await createEvidenceFixture();
    const originalPath = `${fixture.manifestPath}.original`;
    await rename(fixture.manifestPath, originalPath);
    await symlink(originalPath, fixture.manifestPath);

    expect(() => verifyLtxResourceTelemetryEvidence(fixture.manifestPath))
      .toThrow(/symbolic link/u);
  });

  it("rehashes the bound output and rejects media replacement", async () => {
    const fixture = await createEvidenceFixture();
    await writeFile(fixture.outputPath, "replaced-video", { mode: 0o600 });

    expect(() => verifyLtxResourceTelemetryEvidence(fixture.manifestPath, {
      expectedOutputPath: fixture.outputPath,
    })).toThrow(/output content/u);
  });

  it("keeps a hash-bound non-media output ineligible after a real held-FD ffprobe", async () => {
    const fixture = await createEvidenceFixture();
    await writeFile(fixture.outputPath, Buffer.from("candidate-video", "utf8"));
    const rebound = captureLtxResourceTelemetryOutput(fixture.outputPath);
    await rewriteManifest(fixture, (manifest) => {
      manifest.output = rebound;
      manifest.measurementEligibleForCalibration = false;
    });

    const verified = verifyLtxResourceTelemetryEvidence(fixture.manifestPath, {
      expectedBinding: fixture.binding,
      expectedOutputPath: fixture.outputPath,
    });

    expect(verified.manifest.output?.technical).toMatchObject({
      media: null,
      blockers: ["probe_failed"],
    });
    expect(verified.manifest.measurementEligibleForCalibration).toBe(false);
  });
});
