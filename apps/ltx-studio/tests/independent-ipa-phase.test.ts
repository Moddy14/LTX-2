import { describe, expect, it } from "vitest";

import {
  INDEPENDENT_IPA_DECODER_POLICY,
  INDEPENDENT_IPA_FFMPEG_SHA256,
  INDEPENDENT_IPA_METHOD,
  INDEPENDENT_IPA_NORMALIZATION_METHOD,
  INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
  INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
  independentIpaPhaseSchema,
  parseIndependentIpaPhase,
} from "../shared/independentIpa.js";

const sourceSha256 = "a".repeat(64);
const normalizedSha256 = "b".repeat(64);

function measuredPhase() {
  return {
    schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
    status: "measured" as const,
    reasonCode: null,
    authorityAudioSha256: sourceSha256,
    sourceAudioSha256: sourceSha256,
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
      runnerSha256: "c".repeat(64),
      executionBoundary: {
        cpuOnly: true,
        ipSocketFamiliesBlocked: ["AF_INET", "AF_INET6"],
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
      modelFingerprint: "d".repeat(64),
      modelManifestSha256: "e".repeat(64),
      modelWeightSha256: "f".repeat(64),
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

describe("target-independent IPA phase contract", () => {
  it("accepts an exactly bound measured observation", () => {
    const parsed = parseIndependentIpaPhase(measuredPhase());

    expect(INDEPENDENT_IPA_PHASE_SCHEMA_VERSION).toBe("ltx-studio-independent-ipa-phase.v2");
    expect(parsed.status).toBe("measured");
    expect(parsed.observation).toMatchObject({
      targetConditioned: false,
      runnerSha256: "c".repeat(64),
      modelManifestSha256: "e".repeat(64),
      modelWeightSha256: "f".repeat(64),
    });
  });

  it("accepts the exact no-truncation insufficient result", () => {
    expect(parseIndependentIpaPhase({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "insufficient",
      reasonCode: "duration-exceeds-independent-ipa-window",
      authorityAudioSha256: sourceSha256,
      sourceAudioSha256: sourceSha256,
      normalization: null,
      observation: null,
      error: null,
    })).toMatchObject({
      status: "insufficient",
      normalization: null,
      observation: null,
    });
  });

  it("accepts both emitted failed envelopes", () => {
    expect(parseIndependentIpaPhase({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "failed",
      reasonCode: "independent-ipa-runner-failed",
      authorityAudioSha256: sourceSha256,
      sourceAudioSha256: sourceSha256,
      normalization: measuredPhase().normalization,
      observation: null,
      error: {
        code: "independent-ipa-runner-failed",
        message: "Independent IPA model authority is not provisioned",
      },
    }).status).toBe("failed");

    expect(parseIndependentIpaPhase({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "failed",
      reasonCode: "independent-ipa-unverified",
      authorityAudioSha256: sourceSha256,
      sourceAudioSha256: null,
      normalization: null,
      observation: null,
      error: {
        code: "independent-ipa-unverified",
        message: "Der gebundene IPA-Runner ist ungueltig.",
      },
    }).status).toBe("failed");
  });

  it("rejects an invented nested failed observation", () => {
    expect(independentIpaPhaseSchema.safeParse({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "failed",
      reasonCode: "independent-ipa-runner-failed",
      authorityAudioSha256: sourceSha256,
      sourceAudioSha256: sourceSha256,
      normalization: measuredPhase().normalization,
      observation: {
        schemaVersion: INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
        status: "failed",
        error: "must not cross the phase boundary",
        method: INDEPENDENT_IPA_METHOD,
        targetConditioned: false,
      },
      error: {
        code: "independent-ipa-runner-failed",
        message: "The runner failed.",
      },
    }).success).toBe(false);
  });

  it("rejects authority/source mismatches in measured, insufficient, and failed results", () => {
    const authorityMismatch = "9".repeat(64);
    expect(independentIpaPhaseSchema.safeParse({
      ...measuredPhase(),
      authorityAudioSha256: authorityMismatch,
    }).success).toBe(false);
    expect(independentIpaPhaseSchema.safeParse({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "insufficient",
      reasonCode: "duration-exceeds-independent-ipa-window",
      authorityAudioSha256: authorityMismatch,
      sourceAudioSha256: sourceSha256,
      normalization: null,
      observation: null,
      error: null,
    }).success).toBe(false);
    expect(independentIpaPhaseSchema.safeParse({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "failed",
      reasonCode: "independent-ipa-runner-failed",
      authorityAudioSha256: authorityMismatch,
      sourceAudioSha256: sourceSha256,
      normalization: measuredPhase().normalization,
      observation: null,
      error: {
        code: "independent-ipa-runner-failed",
        message: "The runner failed.",
      },
    }).success).toBe(false);
  });

  it("rejects impossible failure evidence ordering", () => {
    expect(independentIpaPhaseSchema.safeParse({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "failed",
      reasonCode: "independent-ipa-runner-failed",
      authorityAudioSha256: sourceSha256,
      sourceAudioSha256: null,
      normalization: measuredPhase().normalization,
      observation: null,
      error: {
        code: "independent-ipa-runner-failed",
        message: "The runner failed after normalization.",
      },
    }).success).toBe(false);
    expect(independentIpaPhaseSchema.safeParse({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "failed",
      reasonCode: "independent-ipa-runner-failed",
      authorityAudioSha256: sourceSha256,
      sourceAudioSha256: sourceSha256,
      normalization: null,
      observation: null,
      error: {
        code: "independent-ipa-runner-failed",
        message: "The runner failed after normalization.",
      },
    }).success).toBe(false);
  });

  it("rejects target, transcript, and Whisper fields at every strict boundary", () => {
    expect(independentIpaPhaseSchema.safeParse({
      ...measuredPhase(),
      transcript: "soll niemals in Phase 1 gelangen",
    }).success).toBe(false);
    expect(independentIpaPhaseSchema.safeParse({
      ...measuredPhase(),
      observation: {
        ...measuredPhase().observation,
        targetText: "verboten",
      },
    }).success).toBe(false);
    expect(independentIpaPhaseSchema.safeParse({
      ...measuredPhase(),
      normalization: {
        ...measuredPhase().normalization,
        whisperSha256: "1".repeat(64),
      },
    }).success).toBe(false);
  });

  it("rejects broken audio bindings, token facts, pins, and non-finite confidence", () => {
    const base = measuredPhase();
    expect(independentIpaPhaseSchema.safeParse({
      ...base,
      observation: {
        ...base.observation,
        sourceAudio: { ...base.observation.sourceAudio, sha256: "9".repeat(64) },
      },
    }).success).toBe(false);
    expect(independentIpaPhaseSchema.safeParse({
      ...base,
      observation: {
        ...base.observation,
        runnerSha256: "UNPINNED",
      },
    }).success).toBe(false);
    expect(independentIpaPhaseSchema.safeParse({
      ...base,
      observation: {
        ...base.observation,
        observation: {
          ...base.observation.observation,
          tokens: [{
            ...base.observation.observation.tokens[0],
            medianPosterior: Number.NaN,
          }],
        },
      },
    }).success).toBe(false);
  });
});
