import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analysisPythonExecutable, appRoot } from "../server/config.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import {
  T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256,
  T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256,
  T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
  T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256,
  T2A_GERMAN_G2P_RUNNER_SHA256,
  T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
  T2A_GERMAN_G2P_VOCAB_PATH,
  t2aGermanG2pResultSchema,
} from "../shared/t2aGermanG2p.js";
import {
  INDEPENDENT_IPA_DECODER_POLICY,
  INDEPENDENT_IPA_FFMPEG_SHA256,
  INDEPENDENT_IPA_METHOD,
  INDEPENDENT_IPA_NORMALIZATION_METHOD,
  INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
  INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
  parseIndependentIpaPhase,
  type IndependentIpaPhase,
} from "../shared/independentIpa.js";
import {
  T2A_IPA_ADJUDICATION_POLICY_SHA256,
  T2A_IPA_ADJUDICATION_RESULT_SCHEMA_VERSION,
  T2A_IPA_ADJUDICATOR_REQUEST_SCHEMA_VERSION,
  T2A_REFERENCE_IPA_SCHEMA_VERSION,
  adjudicateT2aIpa,
  buildT2aIpaAdjudicatorRequest,
  rawIpaAlignment,
  t2aIpaAdjudicationCanonicalJson,
  t2aIpaAdjudicationResultSchema,
  t2aReferenceIpaDocumentSchema,
  type T2aReferenceIpaDocument,
} from "../shared/t2aIpaAdjudication.js";

const runnerPath = join(appRoot, "scripts", "t2a_ipa_adjudicator.py");
const runnerSha256 = createHash("sha256").update(readFileSync(runnerPath)).digest("hex");
const authorityAudioSha256 = "a".repeat(64);
const normalizedAudioSha256 = "b".repeat(64);
const g2pRunnerSha256 = T2A_GERMAN_G2P_RUNNER_SHA256;
const ipaVocabulary = JSON.parse(readFileSync(T2A_GERMAN_G2P_VOCAB_PATH, "utf8")) as Record<
  string,
  number
>;
const espeakBinarySha256 = T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256;
const espeakDataManifestSha256 = T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256;
const espeakRuntimeManifestSha256 = T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256;
const ipaVocabularySha256 = T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256;
const normalizationPolicySha256 = T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256;
const targetTextSha256 = createHash("sha256").update("target text fixture").digest("hex");
const normalizedTargetTextSha256 = createHash("sha256")
  .update("normalized target text fixture")
  .digest("hex");
const espeakStdoutSha256 = createHash("sha256")
  .update("espeak stdout fixture")
  .digest("hex");

function measuredPhase(symbols: readonly string[] = ["h", "a", "l", "o"]): IndependentIpaPhase {
  return parseIndependentIpaPhase({
    schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
    status: "measured",
    reasonCode: null,
    authorityAudioSha256,
    sourceAudioSha256: authorityAudioSha256,
    normalization: {
      method: INDEPENDENT_IPA_NORMALIZATION_METHOD,
      ffmpegSha256: INDEPENDENT_IPA_FFMPEG_SHA256,
      normalizedAudioSha256,
      sampleRateHz: 16_000,
      channels: 1,
      durationMilliseconds: 1_000,
    },
    observation: {
      schemaVersion: INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
      status: "measured",
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
        sha256: normalizedAudioSha256,
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
        decodedIpa: symbols.join(" "),
        unknownTokenCount: 0,
        specialTokenCount: 0,
        blankFrameRatio: 0.5,
        tokens: symbols.map((symbol, index) => ({
          tokenId: ipaVocabulary[symbol]!,
          symbol,
          startFrame: 1 + index * 2,
          endFrameExclusive: 2 + index * 2,
          medianPosterior: 0.9,
          p10Posterior: 0.7,
          minimumTop1Margin: 0.5,
          unknown: false,
          special: false,
        })),
      },
    },
    error: null,
  });
}

function insufficientPhase(): IndependentIpaPhase {
  return parseIndependentIpaPhase({
    schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
    status: "insufficient",
    reasonCode: "duration-exceeds-independent-ipa-window",
    authorityAudioSha256,
    sourceAudioSha256: authorityAudioSha256,
    normalization: null,
    observation: null,
    error: null,
  });
}

function failedPhase(): IndependentIpaPhase {
  return parseIndependentIpaPhase({
    schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
    status: "failed",
    reasonCode: "independent-ipa-unverified",
    authorityAudioSha256,
    sourceAudioSha256: null,
    normalization: null,
    observation: null,
    error: {
      code: "independent-ipa-unverified",
      message: "Synthetic target-free IPA authority failure",
    },
  });
}

function referenceFor(
  phase: IndependentIpaPhase,
  referenceIpaTokens: readonly string[],
  g2pResultSha256: string,
): T2aReferenceIpaDocument {
  return t2aReferenceIpaDocumentSchema.parse({
    schemaVersion: T2A_REFERENCE_IPA_SCHEMA_VERSION,
    canonicalization: "ltx-studio-canonical-json.v1",
    digestAlgorithm: "sha256",
    locale: "de-DE",
    authorityAudioSha256: phase.authorityAudioSha256,
    sourceAudioSha256: phase.sourceAudioSha256,
    normalizedAudioSha256: phase.normalization?.normalizedAudioSha256 ?? null,
    targetTextSha256,
    normalizedTargetTextSha256,
    g2pRunnerSha256,
    espeakBinarySha256,
    espeakDataManifestSha256,
    espeakRuntimeManifestSha256,
    ipaVocabularySha256,
    normalizationPolicySha256,
    espeakStdoutSha256,
    g2pResultSha256,
    adjudicatorRunnerSha256: runnerSha256,
    adjudicationPolicySha256: T2A_IPA_ADJUDICATION_POLICY_SHA256,
    tokenization: "espeak-reference-ipa-token-sequence.v1",
    referenceIpaTokens,
  });
}

function fixture(
  referenceIpaTokens: readonly string[] = ["h", "a", "l", "o"],
  phase: IndependentIpaPhase = measuredPhase(),
) {
  const g2pResult = t2aGermanG2pResultSchema.parse({
    schemaVersion: "ltx-studio-t2a-german-g2p-result.v1",
    status: "generated",
    locale: "de-DE",
    targetTextSha256,
    normalizedTargetTextSha256,
    g2pRunnerSha256,
    espeakBinarySha256,
    espeakDataManifestSha256,
    espeakRuntimeManifestSha256,
    ipaVocabularySha256,
    normalizationPolicySha256,
    espeakStdoutSha256,
    tokenization: "espeak-reference-ipa-token-sequence.v1",
    referenceIpaTokens,
  });
  const g2pResultCanonicalJson = canonicalJson(g2pResult);
  const g2pResultSha256 = createHash("sha256").update(g2pResultCanonicalJson).digest("hex");
  const reference = referenceFor(phase, referenceIpaTokens, g2pResultSha256);
  const options = {
    phaseCanonicalJson: canonicalJson(phase),
    referenceCanonicalJson: canonicalJson(reference),
    g2pResultCanonicalJson,
    phaseSha256: createHash("sha256").update(canonicalJson(phase)).digest("hex"),
    referenceSha256: createHash("sha256").update(canonicalJson(reference)).digest("hex"),
    runnerSha256,
    policySha256: T2A_IPA_ADJUDICATION_POLICY_SHA256,
    g2pRunnerSha256,
    espeakBinarySha256,
    espeakDataManifestSha256,
    espeakRuntimeManifestSha256,
    ipaVocabularySha256,
    normalizationPolicySha256,
    targetTextSha256,
    normalizedTargetTextSha256,
    espeakStdoutSha256,
    g2pResultSha256,
  };
  return { phase, reference, g2pResult, options };
}

function runPython(options: ReturnType<typeof fixture>["options"]) {
  const request = buildT2aIpaAdjudicatorRequest(options);
  const requestCanonicalJson = canonicalJson(request);
  const execution = spawnSync(
    analysisPythonExecutable,
    [
      "-I",
      runnerPath,
      "--expected-runner-sha256",
      runnerSha256,
      "--expected-request-sha256",
      createHash("sha256").update(requestCanonicalJson).digest("hex"),
      "--expected-phase-sha256",
      options.phaseSha256,
      "--expected-reference-sha256",
      options.referenceSha256,
      "--expected-g2p-result-sha256",
      options.g2pResultSha256,
    ],
    {
      cwd: appRoot,
      encoding: "utf8",
      env: { PATH: process.env.PATH, PYTHONNOUSERSITE: "1" },
      input: requestCanonicalJson,
    },
  );
  return { execution, request };
}

function runRawPythonRequest(
  requestText: string,
  request: Readonly<{
    phaseCanonicalJsonBase64: string;
    referenceCanonicalJsonBase64: string;
    g2pResultCanonicalJsonBase64: string;
  }>,
  expected: Readonly<{
    requestSha256?: string;
    phaseSha256?: string;
    referenceSha256?: string;
    g2pResultSha256?: string;
  }> = {},
) {
  const digestDecoded = (encoded: string) => createHash("sha256")
    .update(Buffer.from(encoded, "base64"))
    .digest("hex");
  return spawnSync(analysisPythonExecutable, [
    "-I",
    runnerPath,
    "--expected-runner-sha256",
    runnerSha256,
    "--expected-request-sha256",
    expected.requestSha256 ?? createHash("sha256").update(requestText).digest("hex"),
    "--expected-phase-sha256",
    expected.phaseSha256 ?? digestDecoded(request.phaseCanonicalJsonBase64),
    "--expected-reference-sha256",
    expected.referenceSha256 ?? digestDecoded(request.referenceCanonicalJsonBase64),
    "--expected-g2p-result-sha256",
    expected.g2pResultSha256 ?? digestDecoded(request.g2pResultCanonicalJsonBase64),
  ], {
    cwd: appRoot,
    encoding: "utf8",
    input: requestText,
  });
}

function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...nestedKeys(nested)]);
}

describe("T2A raw IPA adjudicator", () => {
  it.each([
    {
      name: "exact",
      reference: ["h", "a", "l", "o"],
      expected: { substitutions: 0, deletions: 0, insertions: 0, editDistance: 0 },
    },
    {
      name: "substitution",
      reference: ["h", "a", "l", "ə"],
      expected: { substitutions: 1, deletions: 0, insertions: 0, editDistance: 1 },
    },
    {
      name: "insertion",
      reference: ["h", "a", "l"],
      expected: { substitutions: 0, deletions: 0, insertions: 1, editDistance: 1 },
    },
    {
      name: "deletion",
      reference: ["h", "a", "l", "o", "x"],
      expected: { substitutions: 0, deletions: 1, insertions: 0, editDistance: 1 },
    },
    {
      name: "reordered tokens",
      reference: ["a", "h", "l", "o"],
      expected: { substitutions: 2, deletions: 0, insertions: 0, editDistance: 2 },
    },
  ])("computes deterministic $name S/D/I raw counts", ({ reference, expected }) => {
    const value = fixture(reference);
    const result = adjudicateT2aIpa(value.options);

    expect(result).toMatchObject({
      schemaVersion: T2A_IPA_ADJUDICATION_RESULT_SCHEMA_VERSION,
      status: "measured",
      sourcePhaseStatus: "measured",
      measurement: expected,
    });
    if (result.status === "measured") {
      expect(result.measurement.referenceTokenCount).toBe(reference.length);
      expect(result.measurement.hypothesisTokenCount).toBe(4);
      expect(result.measurement.normalizedPhoneErrorRate)
        .toBe(expected.editDistance / reference.length);
    }
    expect(rawIpaAlignment(reference, ["h", "a", "l", "o"]))
      .toMatchObject(expected);
  });

  it("produces byte-identical canonical results in TypeScript and Python", () => {
    for (const reference of [
      ["h", "a", "l", "o"],
      ["h", "a", "l", "ə"],
      ["h", "a", "l"],
      ["h", "a", "l", "o", "x"],
      ["a", "h", "l", "o"],
    ]) {
      const value = fixture(reference);
      const expected = adjudicateT2aIpa(value.options);
      const first = runPython(value.options).execution;
      const second = runPython(value.options).execution;

      expect(first.status, first.stderr).toBe(0);
      expect(second.status, second.stderr).toBe(0);
      expect(first.stdout).toBe(second.stdout);
      expect(first.stdout).toBe(t2aIpaAdjudicationCanonicalJson(expected));
      expect(t2aIpaAdjudicationResultSchema.parse(JSON.parse(first.stdout)))
        .toEqual(expected);
    }
  });

  it("binds cross-runtime numeric bytes without Python float reserialization", () => {
    const rawPhase = structuredClone(measuredPhase(["h"]));
    if (rawPhase.status !== "measured") throw new Error("Expected measured numeric fixture.");
    rawPhase.observation.observation.tokens[0]!.medianPosterior = 1;
    rawPhase.observation.observation.tokens[0]!.p10Posterior = 1e-7;
    rawPhase.observation.observation.tokens[0]!.minimumTop1Margin = -0;
    const phase = parseIndependentIpaPhase(rawPhase);
    const value = fixture(["h"], phase);
    const canonicalPhase = value.options.phaseCanonicalJson;
    expect(canonicalPhase).toContain('"medianPosterior": 1');
    expect(canonicalPhase).toContain('"p10Posterior": 1e-7');
    expect(canonicalPhase).toContain('"minimumTop1Margin": 0');
    expect(runPython(value.options).execution.status).toBe(0);

    for (const [canonicalNumber, nonCanonicalNumber] of [
      ['"p10Posterior": 1e-7', '"p10Posterior": 1e-07'],
      ['"medianPosterior": 1', '"medianPosterior": 1.0'],
      ['"minimumTop1Margin": 0', '"minimumTop1Margin": -0.0'],
    ] as const) {
      const alteredPhase = canonicalPhase.replace(canonicalNumber, nonCanonicalNumber);
      const alteredPhaseSha256 = createHash("sha256").update(alteredPhase).digest("hex");
      expect(() => adjudicateT2aIpa({
        ...value.options,
        phaseCanonicalJson: alteredPhase,
        phaseSha256: alteredPhaseSha256,
      })).toThrow(/phase document/iu);

      const validRequest = buildT2aIpaAdjudicatorRequest(value.options);
      const alteredRequest = {
        ...validRequest,
        phaseCanonicalJsonBase64: Buffer.from(alteredPhase).toString("base64"),
        phaseSha256: alteredPhaseSha256,
      };
      const python = runRawPythonRequest(
        canonicalJson(alteredRequest),
        alteredRequest,
        { phaseSha256: value.options.phaseSha256 },
      );
      expect(python.status).toBe(2);
      expect(python.stderr).toMatch(/digest mismatch/iu);
    }
  });

  it("rejects foreign self-consistent G2P/runtime pins in both runtimes", () => {
    const value = fixture(["h"]);
    expect(() => adjudicateT2aIpa({
      ...value.options,
      g2pRunnerSha256: "1".repeat(64),
    })).toThrow(/options/iu);

    const validRequest = buildT2aIpaAdjudicatorRequest(value.options);
    const decode = (encoded: string) => JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    const foreignPins = {
      g2pRunnerSha256: "1".repeat(64),
      espeakBinarySha256: "2".repeat(64),
      espeakDataManifestSha256: "3".repeat(64),
      espeakRuntimeManifestSha256: "4".repeat(64),
      ipaVocabularySha256: "5".repeat(64),
      normalizationPolicySha256: "6".repeat(64),
    };
    const foreignG2p = { ...decode(validRequest.g2pResultCanonicalJsonBase64), ...foreignPins };
    const foreignG2pCanonical = canonicalJson(foreignG2p);
    const foreignG2pSha256 = createHash("sha256").update(foreignG2pCanonical).digest("hex");
    const foreignReference = {
      ...decode(validRequest.referenceCanonicalJsonBase64),
      ...foreignPins,
      g2pResultSha256: foreignG2pSha256,
    };
    const foreignReferenceCanonical = canonicalJson(foreignReference);
    const foreignReferenceSha256 = createHash("sha256")
      .update(foreignReferenceCanonical)
      .digest("hex");
    const foreignRequest = {
      ...validRequest,
      ...foreignPins,
      referenceCanonicalJsonBase64: Buffer.from(foreignReferenceCanonical).toString("base64"),
      referenceSha256: foreignReferenceSha256,
      g2pResultCanonicalJsonBase64: Buffer.from(foreignG2pCanonical).toString("base64"),
      g2pResultSha256: foreignG2pSha256,
    };
    const python = runRawPythonRequest(canonicalJson(foreignRequest), foreignRequest);
    expect(python.status).toBe(2);
    expect(python.stderr).toMatch(/Unexpected literal/iu);
  });

  it("rejects a phase token whose ID and symbol do not match the pinned vocabulary", () => {
    const rawPhase = structuredClone(measuredPhase(["h"]));
    if (rawPhase.status !== "measured") throw new Error("Expected measured token fixture.");
    rawPhase.observation.observation.tokens[0]!.tokenId = ipaVocabulary.i!;
    const mismatchedPhase = parseIndependentIpaPhase(rawPhase);
    const value = fixture(["h"], mismatchedPhase);
    expect(() => adjudicateT2aIpa(value.options)).toThrow(/token ID and symbol/iu);

    const valid = fixture(["h"]);
    const validRequest = buildT2aIpaAdjudicatorRequest(valid.options);
    const mismatchedCanonical = canonicalJson(mismatchedPhase);
    const mismatchedSha256 = createHash("sha256").update(mismatchedCanonical).digest("hex");
    const mismatchedRequest = {
      ...validRequest,
      phaseCanonicalJsonBase64: Buffer.from(mismatchedCanonical).toString("base64"),
      phaseSha256: mismatchedSha256,
    };
    const python = runRawPythonRequest(canonicalJson(mismatchedRequest), mismatchedRequest);
    expect(python.status).toBe(2);
    expect(python.stderr).toMatch(/token ID and symbol/iu);
  });

  it("preserves insufficient and failed source facts without inventing a measurement", () => {
    for (const phase of [insufficientPhase(), failedPhase()]) {
      const value = fixture(["h"], phase);
      const result = adjudicateT2aIpa(value.options);
      const python = runPython(value.options).execution;

      expect(result).toEqual(expect.objectContaining({
        status: "unavailable",
        sourcePhaseStatus: phase.status,
        measurement: null,
      }));
      expect(python.status, python.stderr).toBe(0);
      expect(python.stdout).toBe(t2aIpaAdjudicationCanonicalJson(result));
    }
  });

  it("binds phase, reference, runner, policy and every reference-production digest", () => {
    const audioTamper = fixture();
    audioTamper.reference.authorityAudioSha256 = "9".repeat(64);
    audioTamper.options.referenceCanonicalJson = canonicalJson(audioTamper.reference);
    audioTamper.options.referenceSha256 = createHash("sha256")
      .update(audioTamper.options.referenceCanonicalJson)
      .digest("hex");
    expect(() => adjudicateT2aIpa(audioTamper.options)).toThrow(/audio binding/iu);

    const g2pTamper = fixture();
    expect(() => adjudicateT2aIpa({
      ...g2pTamper.options,
      g2pRunnerSha256: "8".repeat(64),
    })).toThrow(/options|production binding/iu);

    for (const key of [
      "normalizedTargetTextSha256",
      "espeakRuntimeManifestSha256",
      "ipaVocabularySha256",
      "espeakStdoutSha256",
    ] as const) {
      const digestTamper = fixture();
      expect(() => adjudicateT2aIpa({
        ...digestTamper.options,
        [key]: "8".repeat(64),
      })).toThrow(/options|production binding/iu);
    }

    const targetTamper = fixture();
    targetTamper.reference.targetTextSha256 = "5".repeat(64);
    targetTamper.options.referenceCanonicalJson = canonicalJson(targetTamper.reference);
    expect(() => adjudicateT2aIpa(targetTamper.options)).toThrow(/production binding/iu);

    const phaseTamper = fixture();
    const parsed = JSON.parse(phaseTamper.options.phaseCanonicalJson) as Record<string, unknown>;
    parsed.sourceAudioSha256 = "7".repeat(64);
    phaseTamper.options.phaseCanonicalJson = canonicalJson(parsed);
    expect(() => adjudicateT2aIpa(phaseTamper.options)).toThrow(/phase document/iu);

    const runnerTamper = fixture();
    runnerTamper.reference.adjudicatorRunnerSha256 = "6".repeat(64);
    runnerTamper.options.runnerSha256 = "6".repeat(64);
    runnerTamper.options.referenceCanonicalJson = canonicalJson(runnerTamper.reference);
    const request = {
      schemaVersion: T2A_IPA_ADJUDICATOR_REQUEST_SCHEMA_VERSION,
      phaseCanonicalJsonBase64: Buffer.from(runnerTamper.options.phaseCanonicalJson).toString("base64"),
      referenceCanonicalJsonBase64: Buffer.from(
        runnerTamper.options.referenceCanonicalJson,
      ).toString("base64"),
      g2pResultCanonicalJsonBase64: Buffer.from(
        runnerTamper.options.g2pResultCanonicalJson,
      ).toString("base64"),
      phaseSha256: runnerTamper.options.phaseSha256,
      referenceSha256: runnerTamper.options.referenceSha256,
      runnerSha256: runnerTamper.options.runnerSha256,
      policySha256: runnerTamper.options.policySha256,
      g2pRunnerSha256,
      espeakBinarySha256,
      espeakDataManifestSha256,
      espeakRuntimeManifestSha256,
      ipaVocabularySha256,
      normalizationPolicySha256,
      targetTextSha256,
      normalizedTargetTextSha256,
      espeakStdoutSha256,
      g2pResultSha256: runnerTamper.options.g2pResultSha256,
    };
    const python = runRawPythonRequest(canonicalJson(request), request);
    expect(python.status).toBe(2);
    expect(python.stdout).toBe("");
    expect(python.stderr).toMatch(/digest mismatch/iu);

    const tokenTamper = fixture();
    tokenTamper.reference.referenceIpaTokens = ["x", "a", "l", "o"];
    tokenTamper.options.referenceCanonicalJson = canonicalJson(tokenTamper.reference);
    expect(() => adjudicateT2aIpa(tokenTamper.options)).toThrow(/production binding/iu);
  });

  it("rejects unknown fields, plaintext transcript/path fields and non-canonical input", () => {
    const value = fixture();
    expect(() => adjudicateT2aIpa({ ...value.options, threshold: 0.2 }))
      .toThrow(/options/iu);
    expect(() => adjudicateT2aIpa({
      ...value.options,
      referenceCanonicalJson: canonicalJson({
        ...value.reference,
        targetText: "verbotener Klartext",
      }),
    })).toThrow(/reference IPA document/iu);
    expect(() => adjudicateT2aIpa({
      ...value.options,
      referenceCanonicalJson: canonicalJson({
        ...value.reference,
        audioPath: "/private/audio.wav",
      }),
    })).toThrow(/reference IPA document/iu);
    expect(() => adjudicateT2aIpa({
      ...value.options,
      phaseCanonicalJson: value.options.phaseCanonicalJson.trim(),
    })).toThrow(/phase document/iu);
    expect(nestedKeys(value.reference)).not.toEqual(
      expect.arrayContaining(["targetText", "transcript", "path", "audioPath"]),
    );
  });

  it("rejects duplicate JSON keys and non-finite values before scoring", () => {
    const value = fixture();
    const localeLine = '  "locale": "de-DE",\n';
    const duplicateReference = value.options.referenceCanonicalJson.replace(
      localeLine,
      `${localeLine}${localeLine}`,
    );
    expect(() => adjudicateT2aIpa({
      ...value.options,
      referenceCanonicalJson: duplicateReference,
    })).toThrow(/reference IPA document/iu);

    const validRequest = buildT2aIpaAdjudicatorRequest(value.options);
    const runnerLine = `  "runnerSha256": "${runnerSha256}",\n`;
    const duplicateRequest = canonicalJson(validRequest).replace(
      runnerLine,
      `${runnerLine}${runnerLine}`,
    );
    const duplicateExecution = runRawPythonRequest(duplicateRequest, validRequest);
    expect(duplicateExecution.status).toBe(2);
    expect(duplicateExecution.stderr).toMatch(/Duplicate JSON key/iu);

    const nonFiniteReference = value.options.referenceCanonicalJson.replace(
      '  "referenceIpaTokens": [',
      '  "nonFinite": NaN,\n  "referenceIpaTokens": [',
    );
    const nonFiniteRequest = {
      ...validRequest,
      referenceCanonicalJsonBase64: Buffer.from(nonFiniteReference).toString("base64"),
    };
    const nonFiniteExecution = runRawPythonRequest(
      canonicalJson(nonFiniteRequest),
      nonFiniteRequest,
    );
    expect(nonFiniteExecution.status).toBe(2);
    expect(nonFiniteExecution.stderr).toMatch(/Non-finite JSON number/iu);

    const surrogateRequest = canonicalJson(validRequest).replace(
      runnerLine,
      '  "runnerSha256": "\\ud800",\n',
    );
    const surrogateExecution = runRawPythonRequest(surrogateRequest, validRequest);
    expect(surrogateExecution.status).toBe(2);
    expect(surrogateExecution.stderr).toMatch(/Invalid Unicode/iu);
    expect(surrogateExecution.stderr).not.toMatch(/Traceback/iu);

    const surrogateReference = canonicalJson({
      ...value.reference,
      referenceIpaTokens: [String.fromCharCode(0xd800)],
    });
    expect(() => adjudicateT2aIpa({
      ...value.options,
      referenceCanonicalJson: surrogateReference,
    })).toThrow(/reference IPA document/iu);
    const surrogateReferenceRequest = {
      ...validRequest,
      referenceCanonicalJsonBase64: Buffer.from(surrogateReference).toString("base64"),
    };
    const surrogateReferenceExecution = runRawPythonRequest(
      canonicalJson(surrogateReferenceRequest),
      surrogateReferenceRequest,
    );
    expect(surrogateReferenceExecution.status).toBe(2);
    expect(surrogateReferenceExecution.stderr).toMatch(/Invalid Unicode|Invalid bounded/iu);
    expect(surrogateReferenceExecution.stderr).not.toMatch(/Traceback/iu);
  });

  it("emits only raw measurement and provenance digests, never a decision field", () => {
    const result = adjudicateT2aIpa(fixture().options);
    const keys = nestedKeys(result);

    expect(keys).not.toEqual(expect.arrayContaining([
      "qualified",
      "eligible",
      "pass",
      "passed",
      "threshold",
      "decision",
      "homophone",
      "wordMatch",
    ]));
    expect(Object.keys(result).sort()).toEqual([
      "espeakRuntimeManifestSha256",
      "espeakStdoutSha256",
      "g2pResultSha256",
      "ipaVocabularySha256",
      "measurement",
      "normalizedTargetTextSha256",
      "phaseSha256",
      "policySha256",
      "referenceSha256",
      "runnerSha256",
      "schemaVersion",
      "sourcePhaseStatus",
      "status",
      "targetTextSha256",
    ]);
  });

  it("offers side-effect-free Python help and keeps schema/policy constants aligned", () => {
    const help = spawnSync(analysisPythonExecutable, ["-I", runnerPath, "--help"], {
      cwd: appRoot,
      encoding: "utf8",
    });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("raw IPA edit measurement");
    expect(T2A_IPA_ADJUDICATION_POLICY_SHA256).toMatch(/^[0-9a-f]{64}$/u);
    expect(T2A_REFERENCE_IPA_SCHEMA_VERSION).toBe("ltx-studio-t2a-reference-ipa.v1");
  });
});
