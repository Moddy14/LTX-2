import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  INDEPENDENT_IPA_OBSERVATION_BASENAME,
  materializeIndependentIpaPhaseObservation,
  parseIndependentIpaPhaseExecution,
  type IndependentIpaPhaseAuthority,
} from "../server/t2aIndependentIpaPhase.js";
import { capturePinnedPathRevision, openPinnedPaths } from "../server/evaluatorBindings.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import {
  INDEPENDENT_IPA_DECODER_POLICY,
  INDEPENDENT_IPA_FFMPEG_SHA256,
  INDEPENDENT_IPA_METHOD,
  INDEPENDENT_IPA_NORMALIZATION_METHOD,
  INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
  INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
} from "../shared/independentIpa.js";

const roots: string[] = [];
const runnerSha256 = "c".repeat(64);
const modelManifestSha256 = "d".repeat(64);
const modelWeightSha256 = "e".repeat(64);
const normalizedSha256 = "b".repeat(64);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function authority(authorityAudioSha256: string): IndependentIpaPhaseAuthority {
  return {
    authorityAudioSha256,
    runnerSha256,
    modelManifestSha256,
    modelWeightSha256,
  };
}

function measuredPhase(authorityAudioSha256: string) {
  return {
    schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
    status: "measured" as const,
    reasonCode: null,
    authorityAudioSha256,
    sourceAudioSha256: authorityAudioSha256,
    normalization: {
      method: INDEPENDENT_IPA_NORMALIZATION_METHOD,
      ffmpegSha256: INDEPENDENT_IPA_FFMPEG_SHA256,
      normalizedAudioSha256: normalizedSha256,
      sampleRateHz: 16_000,
      channels: 1,
      durationMilliseconds: 1_000,
    },
    observation: {
      schemaVersion: INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
      status: "measured" as const,
      error: null,
      method: INDEPENDENT_IPA_METHOD,
      decoderPolicy: INDEPENDENT_IPA_DECODER_POLICY,
      targetConditioned: false,
      runnerSha256,
      executionBoundary: {
        cpuOnly: true,
        ipSocketFamiliesBlocked: ["AF_INET", "AF_INET6"] as const,
        blockedNetworkErrno: 97,
        noNewPrivileges: true,
        effectiveCapabilities: "0000000000000000",
        memoryMaxBytes: 8 * 1024 ** 3,
        minimumCgroupHeadroomBytes: 6 * 1024 ** 3,
        swapMaxBytes: 0,
        pidsMax: 64,
        cpuMax: "200000 100000",
      },
      sourceAudio: {
        sha256: normalizedSha256,
        sampleRateHz: 16_000,
        channels: 1,
        sampleCount: 16_000,
        durationMilliseconds: 1_000,
      },
      modelFingerprint: "f".repeat(64),
      modelManifestSha256,
      modelWeightSha256,
      runtime: {
        python: "3.12.3",
        torch: "2.13.0+cu132",
        transformers: "5.14.1",
        safetensors: "0.8.0",
      },
      observation: {
        frameCount: 49,
        outputStrideSamples: 320,
        receptiveFieldSamples: 400,
        blankTokenId: 0,
        unknownTokenId: 3,
        decodedIpa: "h a",
        unknownTokenCount: 0,
        specialTokenCount: 0,
        blankFrameRatio: 0.5,
        tokens: [{
          tokenId: 10,
          symbol: "h",
          startFrame: 1,
          endFrameExclusive: 4,
          medianPosterior: 0.9,
          p10Posterior: 0.7,
          minimumTop1Margin: 0.5,
          unknown: false,
          special: false,
        }, {
          tokenId: 11,
          symbol: "a",
          startFrame: 6,
          endFrameExclusive: 9,
          medianPosterior: 0.8,
          p10Posterior: 0.6,
          minimumTop1Margin: 0.4,
          unknown: false,
          special: false,
        }],
      },
    },
    error: null,
  };
}

function insufficientPhase(authorityAudioSha256: string) {
  return {
    schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
    status: "insufficient" as const,
    reasonCode: "duration-exceeds-independent-ipa-window" as const,
    authorityAudioSha256,
    sourceAudioSha256: authorityAudioSha256,
    normalization: null,
    observation: null,
    error: null,
  };
}

function failedPhase(authorityAudioSha256: string) {
  return {
    schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
    status: "failed" as const,
    reasonCode: "independent-ipa-unverified" as const,
    authorityAudioSha256,
    sourceAudioSha256: null,
    normalization: null,
    observation: null,
    error: {
      code: "independent-ipa-unverified" as const,
      message: "The independent evaluator was not verified.",
    },
  };
}

async function privateSnapshot() {
  const root = await mkdtemp(join(tmpdir(), "ltx-ipa-phase-"));
  roots.push(root);
  await chmod(root, 0o700);
  const audioSnapshotPath = join(root, "authority.wav");
  const transcriptSnapshotPath = join(root, "transcript.utf8");
  const audioBytes = Buffer.from("RIFF private authority audio bytes", "utf8");
  const transcriptBytes = Buffer.from('{"schemaVersion":"private-test"}\n', "utf8");
  await writeFile(audioSnapshotPath, audioBytes, { mode: 0o444 });
  await writeFile(transcriptSnapshotPath, transcriptBytes, { mode: 0o444 });
  await chmod(audioSnapshotPath, 0o444);
  await chmod(transcriptSnapshotPath, 0o444);
  return {
    root,
    audioSnapshotPath,
    transcriptSnapshotPath,
    audioSha256: sha256(audioBytes),
  };
}

describe("independent IPA execution parsing", () => {
  it("accepts measured output, checks every server pin, and emits one canonical document", () => {
    const audioSha256 = "a".repeat(64);
    const phase = measuredPhase(audioSha256);
    const parsed = parseIndependentIpaPhaseExecution(
      { code: 0, stdout: `${JSON.stringify(phase)}\n` },
      authority(audioSha256),
    );

    expect(parsed.phase.status).toBe("measured");
    expect(parsed.canonicalBytes.toString("utf8")).toBe(canonicalJson(phase));
    expect(parsed.canonicalBytes.toString("utf8")).toMatch(/[^\n]\n$/u);
    expect(parsed.sha256).toBe(sha256(parsed.canonicalBytes));
  });

  it("accepts insufficient only with exit 0 and failed only with exit 2", () => {
    const audioSha256 = "a".repeat(64);
    expect(parseIndependentIpaPhaseExecution(
      { code: 0, stdout: JSON.stringify(insufficientPhase(audioSha256)) },
      authority(audioSha256),
    ).phase.status).toBe("insufficient");
    expect(parseIndependentIpaPhaseExecution(
      { code: 2, stdout: JSON.stringify(failedPhase(audioSha256)) },
      authority(audioSha256),
    ).phase.status).toBe("failed");
  });

  it("rejects every status/exit mismatch, a second JSON document, and another audio authority", () => {
    const audioSha256 = "a".repeat(64);
    const measured = JSON.stringify(measuredPhase(audioSha256));
    const failed = JSON.stringify(failedPhase(audioSha256));
    expect(() => parseIndependentIpaPhaseExecution(
      { code: 2, stdout: measured },
      authority(audioSha256),
    )).toThrow(/Exitcode/u);
    expect(() => parseIndependentIpaPhaseExecution(
      { code: 0, stdout: failed },
      authority(audioSha256),
    )).toThrow(/Exitcode/u);
    expect(() => parseIndependentIpaPhaseExecution(
      { code: 1, stdout: failed },
      authority(audioSha256),
    )).toThrow(/Exitcode/u);
    expect(() => parseIndependentIpaPhaseExecution(
      { code: 0, stdout: `${measured}\n${measured}` },
      authority(audioSha256),
    )).toThrow(/ungueltiges JSON/u);
    expect(() => parseIndependentIpaPhaseExecution(
      { code: 0, stdout: measured },
      authority("9".repeat(64)),
    )).toThrow(/anderes Authority-Audio/u);
  });

  it("rejects each mismatched measured runner or model pin", () => {
    const audioSha256 = "a".repeat(64);
    const execution = { code: 0, stdout: JSON.stringify(measuredPhase(audioSha256)) };
    for (const changed of ["runnerSha256", "modelManifestSha256", "modelWeightSha256"] as const) {
      expect(() => parseIndependentIpaPhaseExecution(execution, {
        ...authority(audioSha256),
        [changed]: "9".repeat(64),
      })).toThrow(/Server-Pins/u);
    }
  });
});

describe("independent IPA private observation materialization", () => {
  it("writes, seals, directory-syncs, and returns a reusable pinned revision", async () => {
    const snapshot = await privateSnapshot();
    const execution = parseIndependentIpaPhaseExecution(
      { code: 0, stdout: JSON.stringify(measuredPhase(snapshot.audioSha256)) },
      authority(snapshot.audioSha256),
    );
    const result = materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: snapshot.audioSnapshotPath,
      transcriptSnapshotPath: snapshot.transcriptSnapshotPath,
      execution,
    });

    expect(result).toMatchObject({
      path: join(snapshot.root, INDEPENDENT_IPA_OBSERVATION_BASENAME),
      sha256: execution.sha256,
    });
    expect(await readFile(result.path)).toEqual(execution.canonicalBytes);
    expect((await lstat(result.path)).mode & 0o777).toBe(0o444);
    const recaptured = capturePinnedPathRevision(result.path, "file");
    expect(recaptured).toEqual(result.revision);
    const pinned = openPinnedPaths([result.revision]);
    try {
      expect(pinned.sha256(result.path, 512 * 1024)).toBe(result.sha256);
      expect(() => pinned.verifyUnchanged()).not.toThrow();
    } finally {
      pinned.close();
    }
  });

  it("rejects a non-private parent and creates no observation", async () => {
    const snapshot = await privateSnapshot();
    const execution = parseIndependentIpaPhaseExecution(
      { code: 0, stdout: JSON.stringify(measuredPhase(snapshot.audioSha256)) },
      authority(snapshot.audioSha256),
    );
    await chmod(snapshot.root, 0o750);
    expect(() => materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: snapshot.audioSnapshotPath,
      transcriptSnapshotPath: snapshot.transcriptSnapshotPath,
      execution,
    })).toThrow(/0700/u);
    await expect(lstat(join(snapshot.root, INDEPENDENT_IPA_OBSERVATION_BASENAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked snapshot root and a symlinked destination", async () => {
    const snapshot = await privateSnapshot();
    const parent = await mkdtemp(join(tmpdir(), "ltx-ipa-phase-link-"));
    roots.push(parent);
    const linkedRoot = join(parent, "snapshot-link");
    await symlink(snapshot.root, linkedRoot, "dir");
    const execution = parseIndependentIpaPhaseExecution(
      { code: 0, stdout: JSON.stringify(measuredPhase(snapshot.audioSha256)) },
      authority(snapshot.audioSha256),
    );
    expect(() => materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: join(linkedRoot, "authority.wav"),
      transcriptSnapshotPath: join(linkedRoot, "transcript.utf8"),
      execution,
    })).toThrow(/0700/u);

    const destination = join(snapshot.root, INDEPENDENT_IPA_OBSERVATION_BASENAME);
    await symlink(snapshot.transcriptSnapshotPath, destination);
    expect(() => materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: snapshot.audioSnapshotPath,
      transcriptSnapshotPath: snapshot.transcriptSnapshotPath,
      execution,
    })).toThrow();
    expect((await lstat(destination)).isSymbolicLink()).toBe(true);
  });

  it("rejects wrong basenames and siblings from different roots", async () => {
    const first = await privateSnapshot();
    const second = await privateSnapshot();
    const execution = parseIndependentIpaPhaseExecution(
      { code: 0, stdout: JSON.stringify(measuredPhase(first.audioSha256)) },
      authority(first.audioSha256),
    );
    expect(() => materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: join(first.root, "renamed.wav"),
      transcriptSnapshotPath: first.transcriptSnapshotPath,
      execution,
    })).toThrow(/authority\.wav/u);
    expect(() => materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: first.audioSnapshotPath,
      transcriptSnapshotPath: second.transcriptSnapshotPath,
      execution,
    })).toThrow(/selben IPA-Snapshot-Root/u);
  });

  it("refuses an existing observation without overwriting it", async () => {
    const snapshot = await privateSnapshot();
    const destination = join(snapshot.root, INDEPENDENT_IPA_OBSERVATION_BASENAME);
    const existingBytes = Buffer.from("existing private evidence\n", "utf8");
    await writeFile(destination, existingBytes, { mode: 0o444 });
    await chmod(destination, 0o444);
    const execution = parseIndependentIpaPhaseExecution(
      { code: 0, stdout: JSON.stringify(measuredPhase(snapshot.audioSha256)) },
      authority(snapshot.audioSha256),
    );
    expect(() => materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: snapshot.audioSnapshotPath,
      transcriptSnapshotPath: snapshot.transcriptSnapshotPath,
      execution,
    })).toThrow();
    expect(await readFile(destination)).toEqual(existingBytes);
  });

  it("rejects tampered canonical bytes and an audio/phase digest mismatch", async () => {
    const snapshot = await privateSnapshot();
    const execution = parseIndependentIpaPhaseExecution(
      { code: 0, stdout: JSON.stringify(measuredPhase(snapshot.audioSha256)) },
      authority(snapshot.audioSha256),
    );
    expect(() => materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: snapshot.audioSnapshotPath,
      transcriptSnapshotPath: snapshot.transcriptSnapshotPath,
      execution: {
        ...execution,
        canonicalBytes: Buffer.concat([execution.canonicalBytes, Buffer.from(" ")]),
      },
    })).toThrow(/veraendert/u);

    const wrongAudioSha256 = "9".repeat(64);
    const wrongExecution = parseIndependentIpaPhaseExecution(
      { code: 0, stdout: JSON.stringify(measuredPhase(wrongAudioSha256)) },
      authority(wrongAudioSha256),
    );
    expect(() => materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: snapshot.audioSnapshotPath,
      transcriptSnapshotPath: snapshot.transcriptSnapshotPath,
      execution: wrongExecution,
    })).toThrow(/Authority-Audio/u);
    await expect(lstat(join(snapshot.root, INDEPENDENT_IPA_OBSERVATION_BASENAME)))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
