import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CurrentOutputAuthorityJob, StudioJob } from "../server/jobs.js";
import { OutputLibrary, OutputQualityError } from "../server/outputs.js";
import {
  T2A_AUDIO_ANALYSIS_RECORD_VERSION,
  T2aAudioAnalysisManager,
  cleanupT2aAudioSnapshots,
  openT2aAudioAnalysisTarget,
  recoverInterruptedT2aAudioAnalyses,
  removeT2aAudioAnalysis,
  resolveT2aAudioAnalysisTarget,
  t2aAudioAnalysisPath,
  t2aAudioAnalysisRecordSchema,
  toPublicT2aAudioAnalysis,
  toPublicT2aAudioQuality,
  writeT2aAudioAnalysis,
} from "../server/t2aAudioAnalysis.js";
import {
  T2aAudioEvaluatorCancelledError,
  T2aAudioEvaluatorTerminationError,
} from "../server/t2aAudioEvaluator.js";
import {
  INDEPENDENT_IPA_DECODER_POLICY,
  INDEPENDENT_IPA_METHOD,
  INDEPENDENT_IPA_NORMALIZATION_METHOD,
  INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
  INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
  independentIpaPhaseSchema,
  type IndependentIpaPhase,
} from "../shared/independentIpa.js";
import {
  T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
  T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
} from "../shared/t2aGermanG2p.js";
import {
  PCM16_LSB_LINEAR,
  T2A_AUDIO_QUALITY_SCHEMA_VERSION,
  T2A_FFMPEG_SHA256,
  T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
  T2A_PHONEME_MEASUREMENT_METHOD,
  T2A_WHISPER_SMALL_SHA256,
  deriveT2aPhonemeVerification,
  deriveT2aIa2vEligibility,
  deriveT2aSpokenContentGate,
  t2aAudioQualitySchema,
  type T2aMeasuredAudioQuality,
} from "../shared/t2aAudioQuality.js";
import {
  T2A_IPA_ADJUDICATION_POLICY_SHA256,
  T2A_IPA_ADJUDICATION_RESULT_SCHEMA_VERSION,
  t2aIpaAdjudicationResultSchema,
} from "../shared/t2aIpaAdjudication.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { t2aAudioPublicAnalysisRecordSchema } from "../shared/t2aAudioPublic.js";
import { validLtx25SplitRequest } from "./fixtures.js";
import { publishCompletedOutputFixture } from "./output-publication-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function measuredIndependentIpaPhase(authorityAudioSha256: string) {
  const normalizedAudioSha256 = sha256(`normalized:${authorityAudioSha256}`);
  return independentIpaPhaseSchema.parse({
    schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
    status: "measured",
    reasonCode: null,
    authorityAudioSha256,
    sourceAudioSha256: authorityAudioSha256,
    normalization: {
      method: INDEPENDENT_IPA_NORMALIZATION_METHOD,
      ffmpegSha256: T2A_FFMPEG_SHA256,
      normalizedAudioSha256,
      sampleRateHz: 16_000,
      channels: 1,
      durationMilliseconds: 100,
    },
    observation: {
      schemaVersion: INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
      status: "measured",
      error: null,
      method: INDEPENDENT_IPA_METHOD,
      decoderPolicy: INDEPENDENT_IPA_DECODER_POLICY,
      targetConditioned: false,
      runnerSha256: sha256("independent-ipa-runner-fixture"),
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
        sampleCount: 1_600,
        durationMilliseconds: 100,
      },
      modelFingerprint: sha256("independent-ipa-model-fixture"),
      modelManifestSha256: sha256("independent-ipa-manifest-fixture"),
      modelWeightSha256: sha256("independent-ipa-weight-fixture"),
      runtime: {
        python: "3.12.3",
        torch: "2.13.0+cu132",
        transformers: "5.14.1",
        safetensors: "0.8.0",
      },
      observation: {
        frameCount: 4,
        outputStrideSamples: 320,
        receptiveFieldSamples: 400,
        blankTokenId: 0,
        unknownTokenId: 3,
        decodedIpa: "h",
        unknownTokenCount: 0,
        specialTokenCount: 0,
        blankFrameRatio: 0.75,
        tokens: [{
          tokenId: 4,
          symbol: "h",
          startFrame: 0,
          endFrameExclusive: 1,
          medianPosterior: 0.9,
          p10Posterior: 0.8,
          minimumTop1Margin: 0.5,
          unknown: false,
          special: false,
        }],
      },
    },
    error: null,
  });
}

function studioJob(
  outputName: string,
  dialogue = "Hallo",
  id = "2c8a5dc6-8864-49f7-a639-85caef918888",
): StudioJob {
  const request = validLtx25SplitRequest("text-to-audio");
  request.outputName = outputName;
  request.promptParts.dialogue = dialogue;
  return {
    id,
    status: "completed",
    mode: request.mode,
    prompt: request.prompt,
    outputName,
    outputUrl: `/api/jobs/${id}/output`,
    createdAt: "2026-08-26T00:00:00.000Z",
    startedAt: "2026-08-26T00:00:01.000Z",
    finishedAt: "2026-08-26T00:01:00.000Z",
    progress: 100,
    error: null,
    logs: [],
    command: "python -m ltx_pipelines.t2a",
    request,
    favorite: false,
    variantOf: null,
    experiment: null,
    project: null,
    runtimeMs: 59_000,
    cancelledBy: null,
    thermalProfile: null,
    dgxJobId: "dgx-job-test",
    identityEvidence: null,
    runProvenance: null,
  };
}

type Fixture = {
  root: string;
  tempRoot: string;
  outputPath: string;
  sidecarPath: string;
  job: CurrentOutputAuthorityJob;
};

async function fixture(options: {
  legacyPeak?: boolean;
  omittedDefault?: boolean;
  dialogue?: string;
  outputName?: string;
  jobId?: string;
  root?: string;
  tempRoot?: string;
} = {}): Promise<Fixture> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "ltx-t2a-analysis-output-"));
  const tempRoot = options.tempRoot ?? await mkdtemp(join(tmpdir(), "ltx-t2a-analysis-temp-"));
  if (!options.root) roots.push(root);
  if (!options.tempRoot) roots.push(tempRoot);
  await chmod(tempRoot, 0o700);
  const outputName = options.outputName ?? "new-t2a.wav";
  const outputPath = join(root, outputName);
  await writeFile(outputPath, Buffer.alloc(96_044, 7));
  const base = studioJob(outputName, options.dialogue ?? "Hallo", options.jobId);
  const rawRequest = structuredClone(base.request) as Record<string, unknown>;
  if (options.legacyPeak) delete rawRequest.textToAudio;
  if (options.omittedDefault) {
    delete (rawRequest.icLora as Record<string, unknown>).profile;
  }
  const rawRequestSha256 = sha256(canonicalJson(rawRequest));
  if (options.legacyPeak || options.omittedDefault) {
    base.executionDecision = {
      schemaVersion: "ltx-studio-execution-decision.v5",
      executionClass: "dgx",
      decidedAt: base.startedAt!,
      reason: "Legacy fixture without an explicit peak policy.",
      requestSha256: rawRequestSha256,
      protocolSha256: null,
      cpuReuse: null,
      operation: null,
    };
  }
  const job = Object.assign(base, {
    authorityBoundRequest: rawRequest,
    authorityRequestSha256: rawRequestSha256,
  });
  publishCompletedOutputFixture(root, job);
  const library = new OutputLibrary(root);
  library.recordCompleted([job]);
  return {
    root,
    tempRoot,
    outputPath,
    sidecarPath: join(root, `${outputName}.ltx-settings.json`),
    job,
  };
}

function measuredResult(target: ReturnType<typeof resolveT2aAudioAnalysisTarget>): T2aMeasuredAudioQuality {
  const dialogueEvaluation = {
    status: "measured" as const,
    blockerCode: "none" as const,
    error: null,
    method: "whisper-small-guided-word-motion.v1" as const,
    modelName: "OpenAI Whisper small" as const,
    modelSha256: T2A_WHISPER_SMALL_SHA256,
    packageVersion: "20250625",
    detectedLanguage: "de",
    expectedTranscriptSha256: target.binding.dialogueSha256,
    expectedWordCount: 1,
    recognizedWordCount: 1,
    recognizedTranscript: "Hallo",
    wordErrorRate: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    rawAsrContentGate: {
      status: "passed" as const,
      method: "whisper-small-independent-raw-asr-token-edits.v1" as const,
      targetConditioned: false as const,
      exactTokenMatch: true,
      expectedNormalizedWords: ["hallo"],
      recognizedNormalizedWords: ["hallo"],
      prefixInsertions: [],
      internalInsertions: [],
      suffixInsertions: [],
      deletedExpectedWords: [],
      substitutedWords: [],
      repeatedInsertions: [],
    },
    phonemeVerification: {
      status: "not-available" as const,
      method: null,
      reason: "Kein unabhaengig gebundener Zweit-Recognizer oder Phonem-Scorer ist verfuegbar." as const,
    },
    guidedAlignedWordCount: 1,
    guidedWordCoverage: 1,
    usableAlignedWordCount: 1,
    usableGuidedWordCoverage: 1,
    medianGuidedWordProbability: 0.9,
    p10GuidedWordProbability: 0.9,
    lowConfidenceAlignedWords: 0,
    alignmentStatus: "measured" as const,
    alignmentError: null,
    timePrecisionMilliseconds: 20 as const,
    guidedWords: [{
      index: 0,
      word: "Hallo",
      normalizedWord: "hallo",
      tokenIds: [1],
      startSeconds: 0,
      endSeconds: 0.8,
      probability: 0.9,
      usable: true,
    }],
  };
  const sourceSnapshot = {
    sha256: target.binding.outputSha256,
    byteLength: target.binding.outputRevision.sizeBytes,
  };
  const independentIpaPhase = measuredIndependentIpaPhase(sourceSnapshot.sha256);
  const spokenContentGate = deriveT2aSpokenContentGate({
    dialogueEvaluation,
    authorityAudioSha256: sourceSnapshot.sha256,
    phaseDocumentSha256: sha256(canonicalJson(independentIpaPhase)),
    independentIpaPhase,
  });
  const facts = {
    wav: {
      container: "RIFF/WAVE" as const,
      codec: "pcm_s16le" as const,
      formatTag: 1 as const,
      bitsPerSample: 16 as const,
      channels: 1,
      sampleRateHz: 48_000,
      sampleFrames: 48_000,
      durationSeconds: 1,
    },
    pcm: {
      totalSamples: 48_000,
      samplePeakLinear: 0.5,
      samplePeakDbfs: 20 * Math.log10(0.5),
      fullScaleClippedSamples: 0,
      fullScaleClippedRatio: 0,
    },
    loudness: {
      method: "ffmpeg-ebur128-peak-true.v1" as const,
      ffmpegSha256: T2A_FFMPEG_SHA256,
      integratedLufs: -20,
      truePeakDbtp: -1,
    },
    policy: {
      peakCeilingDbfs: target.binding.peakCeilingDbfs,
      peakCeilingLinear: 10 ** (target.binding.peakCeilingDbfs / 20),
      pcm16LsbToleranceLinear: PCM16_LSB_LINEAR,
    },
    dialogueEvaluation,
    spokenContentGate,
  };
  return {
    schemaVersion: T2A_AUDIO_QUALITY_SCHEMA_VERSION,
    mediaKind: "audio",
    analysisKind: "t2a-audio-qa",
    analysisStatus: "measured",
    sourceSnapshot,
    ...facts,
    ia2vEligibility: deriveT2aIa2vEligibility(facts),
  };
}

function withIndependentIpaPhase(
  result: T2aMeasuredAudioQuality,
  independentIpaPhase: IndependentIpaPhase,
): T2aMeasuredAudioQuality {
  const spokenContentGate = deriveT2aSpokenContentGate({
    dialogueEvaluation: result.dialogueEvaluation,
    authorityAudioSha256: result.sourceSnapshot.sha256,
    phaseDocumentSha256: sha256(canonicalJson(independentIpaPhase)),
    independentIpaPhase,
  });
  const facts = {
    wav: result.wav,
    pcm: result.pcm,
    loudness: result.loudness,
    policy: result.policy,
    dialogueEvaluation: result.dialogueEvaluation,
    spokenContentGate,
  };
  return {
    ...result,
    spokenContentGate,
    ia2vEligibility: deriveT2aIa2vEligibility(facts),
  };
}

function withIpaAdjudication(
  result: T2aMeasuredAudioQuality,
): T2aMeasuredAudioQuality {
  const phase = result.spokenContentGate.independentIpa.phase;
  const measured = phase.status === "measured";
  const adjudication = t2aIpaAdjudicationResultSchema.parse({
    schemaVersion: T2A_IPA_ADJUDICATION_RESULT_SCHEMA_VERSION,
    status: measured ? "measured" : "unavailable",
    sourcePhaseStatus: phase.status,
    phaseSha256: result.spokenContentGate.independentIpa.phaseDocumentSha256,
    referenceSha256: "1".repeat(64),
    targetTextSha256: result.dialogueEvaluation.expectedTranscriptSha256,
    normalizedTargetTextSha256: "2".repeat(64),
    espeakRuntimeManifestSha256: T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
    ipaVocabularySha256: T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
    espeakStdoutSha256: "3".repeat(64),
    g2pResultSha256: "4".repeat(64),
    runnerSha256: "5".repeat(64),
    policySha256: T2A_IPA_ADJUDICATION_POLICY_SHA256,
    measurement: measured ? {
      substitutions: 1,
      deletions: 2,
      insertions: 0,
      editDistance: 3,
      referenceTokenCount: 4,
      hypothesisTokenCount: 2,
      normalizedPhoneErrorRate: 0.75,
    } : null,
  });
  const adjudicationSha256 = sha256(canonicalJson(adjudication));
  const dialogueEvaluation = {
    ...result.dialogueEvaluation,
    phonemeVerification: deriveT2aPhonemeVerification(adjudicationSha256, adjudication),
  };
  const spokenContentGate = deriveT2aSpokenContentGate({
    dialogueEvaluation,
    authorityAudioSha256: result.sourceSnapshot.sha256,
    phaseDocumentSha256: result.spokenContentGate.independentIpa.phaseDocumentSha256,
    independentIpaPhase: phase,
    ipaAdjudicationResultSha256: adjudicationSha256,
    ipaAdjudicationResult: adjudication,
  });
  const facts = {
    wav: result.wav,
    pcm: result.pcm,
    loudness: result.loudness,
    policy: result.policy,
    dialogueEvaluation,
    spokenContentGate,
  };
  return t2aAudioQualitySchema.parse({
    ...result,
    dialogueEvaluation,
    spokenContentGate,
    ia2vEligibility: deriveT2aIa2vEligibility(facts),
  }) as T2aMeasuredAudioQuality;
}

async function waitForTerminal(manager: T2aAudioAnalysisManager, outputName: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = manager.getStored(outputName);
    if (record && ["completed", "failed", "cancelled"].includes(record.status)) return record;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  throw new Error("T2A manager did not become terminal");
}

describe("T2A audio analysis authority", () => {
  it("materializes a private 0444 WAV and verifies output, raw request, sidecar and policy", async () => {
    const value = await fixture();
    const lease = openT2aAudioAnalysisTarget(
      value.root,
      value.job.outputName,
      [value.job],
      value.tempRoot,
    );
    try {
      expect(statSync(lease.target.audioSnapshotPath).mode & 0o777).toBe(0o444);
      expect(statSync(lease.target.audioSnapshotPath).size).toBe(96_044);
      expect(lease.target.binding).toMatchObject({
        outputName: value.job.outputName,
        rawRequestSha256: value.job.authorityRequestSha256,
        peakCeilingDbfs: -3,
      });
      expect(lease.target.binding.settingsSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(lease.target.binding.dialogueSha256).toBe(sha256("Hallo"));
      expect(() => lease.verify([value.job])).not.toThrow();
    } finally {
      lease.release();
    }
  });

  it("rejects legacy T2A without an explicit historic peak policy", async () => {
    const value = await fixture({ legacyPeak: true });
    expect(() => resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]))
      .toThrowError(OutputQualityError);
    try {
      resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409 });
      expect(String(error)).toContain("Legacy-T2A");
    }
  });

  it("accepts a raw sidecar with an explicit peak and an omitted schema default", async () => {
    const value = await fixture({ omittedDefault: true });
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    expect(target.binding).toMatchObject({
      rawRequestSha256: value.job.authorityRequestSha256,
      peakCeilingDbfs: -3,
    });
    expect(target.request.icLora.profile).toBe("union-control");
  });

  it("represents an empty but valid T2A transcript as a nonempty private envelope", async () => {
    const value = await fixture({ dialogue: "" });
    const lease = openT2aAudioAnalysisTarget(
      value.root,
      value.job.outputName,
      [value.job],
      value.tempRoot,
    );
    try {
      const envelope = JSON.parse(await readFile(lease.target.transcriptSnapshotPath, "utf8"));
      expect(envelope).toEqual({
        schemaVersion: "ltx-studio-private-transcript.v1",
        text: "",
      });
      expect(statSync(lease.target.transcriptSnapshotPath).size).toBeGreaterThan(0);
      expect(lease.target.dialogueSha256).toBe(sha256(""));
      expect(() => lease.verify([value.job])).not.toThrow();
    } finally {
      lease.release();
    }
  });

  it("fails a held lease closed after same-path settings mutation", async () => {
    const value = await fixture();
    const lease = openT2aAudioAnalysisTarget(
      value.root,
      value.job.outputName,
      [value.job],
      value.tempRoot,
    );
    try {
      const document = JSON.parse(await readFile(value.sidecarPath, "utf8"));
      document.request.prompt = "swapped";
      await writeFile(value.sidecarPath, JSON.stringify(document), { mode: 0o600 });
      expect(() => lease.verify([value.job])).toThrow(/Sidecar|Authority/u);
    } finally {
      lease.release();
    }
  });

  it("gates every manager method until namespaced startup recovery has completed", async () => {
    const value = await fixture();
    const managed = await mkdtemp(join(value.tempRoot, "t2a-audio-"));
    let releaseRecovery: () => void = () => {
      throw new Error("startup recovery did not begin");
    };
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: () => new Promise<void>((resolvePromise) => {
        releaseRecovery = resolvePromise;
      }),
      evaluatorFingerprint: () => "7".repeat(64),
    });
    const initialization = manager.initialize();
    expect(() => manager.getStored(value.job.outputName)).toThrow(/noch nicht sicher initialisiert/u);
    expect(existsSync(managed)).toBe(true);
    releaseRecovery();
    await initialization;
    expect(existsSync(managed)).toBe(false);
    expect(manager.getStored(value.job.outputName)).toBeNull();
    await manager.shutdown();
  });

  it("persists only measured worker output as completed and publishes no private hashes", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const fingerprint = "f".repeat(64);
    const manager = new T2aAudioAnalysisManager(
      () => [value.job],
      value.root,
      {
        tempRoot: value.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => fingerprint,
        evaluator: async () => ({
          result: measuredResult(target),
          evaluatorFingerprint: fingerprint,
          claimScope: "sealed-release",
        }),
      },
    );
    await manager.initialize();
    manager.start(value.job.outputName);
    const record = await waitForTerminal(manager, value.job.outputName);
    expect(t2aAudioAnalysisRecordSchema.parse(record).status).toBe("completed");
    expect(manager.getForListing(value.job.outputName)).toEqual(record);
    const outputRevisionToken = `eq1_${"A".repeat(32)}`;
    const publicRecord = toPublicT2aAudioAnalysis(record, outputRevisionToken);
    const serialized = JSON.stringify(publicRecord);
    expect(publicRecord).toMatchObject({
      status: "completed",
      outputRevisionToken,
      result: {
        analysisStatus: "measured",
        independentIpa: {
          evaluationMode: "measurement-only",
          status: "measured",
          targetConditioned: false,
          reasonCode: null,
          method: INDEPENDENT_IPA_METHOD,
          modelFingerprint: sha256("independent-ipa-model-fixture"),
          decodedIpa: "h",
          tokenCount: 1,
          unknownTokenCount: 0,
          specialTokenCount: 0,
          blankFrameRatio: 0.75,
          releaseQualification: {
            status: "not-qualified",
            requiredPositiveHoldoutCases: 300,
            requiredNegativeHoldoutCases: 300,
            maximumFalseAccepts: 0,
          },
        },
        pronunciationMeasurement: null,
      },
    });
    if (publicRecord.result?.analysisStatus !== "measured") {
      throw new Error("Expected a measured public T2A result");
    }
    expect(Object.keys(publicRecord.result.independentIpa).sort()).toEqual([
      "blankFrameRatio",
      "decodedIpa",
      "evaluationMode",
      "method",
      "modelFingerprint",
      "reasonCode",
      "releaseQualification",
      "specialTokenCount",
      "status",
      "targetConditioned",
      "tokenCount",
      "unknownTokenCount",
    ]);
    expect(Object.keys(publicRecord.result.independentIpa.releaseQualification).sort()).toEqual([
      "maximumFalseAccepts",
      "requiredNegativeHoldoutCases",
      "requiredPositiveHoldoutCases",
      "status",
    ]);
    const publicIpa = JSON.stringify(publicRecord.result.independentIpa);
    for (const privateIpaField of [
      "authorityAudioSha256",
      "phaseDocumentSha256",
      "sourceAudioSha256",
      "normalization",
      "runnerSha256",
      "executionBoundary",
      "modelManifestSha256",
      "modelWeightSha256",
      "runtime",
      "tokens",
      "error",
      "path",
    ]) {
      expect(publicIpa).not.toContain(privateIpaField);
    }
    for (const forbidden of [
      "sourceSnapshot",
      "modelSha256",
      "ffmpegSha256",
      "expectedTranscriptSha256",
      "rawRequestSha256",
      "normalizedRequestSha256",
      "dialogueSha256",
      "tokenIds",
      "audioSnapshotPath",
      value.outputPath,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(() => manager.cancel(
      value.job.outputName,
      "7c8a5dc6-8864-49f7-a639-85caef919999",
    )).toThrowError(OutputQualityError);
    expect(manager.cancel(value.job.outputName, record.analysisId)?.status).toBe("completed");
    await manager.shutdown();
  });

  it("projects only the adjudicated raw pronunciation measurement", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const measured = toPublicT2aAudioQuality(withIpaAdjudication(measuredResult(target)));
    if (measured.analysisStatus !== "measured") {
      throw new Error("Expected measured public quality");
    }

    expect(measured.pronunciationMeasurement).toEqual({
      status: "measured",
      sourcePhaseStatus: "measured",
      method: T2A_PHONEME_MEASUREMENT_METHOD,
      evaluationMode: "measurement-only",
      substitutions: 1,
      deletions: 2,
      insertions: 0,
      editDistance: 3,
      referenceTokenCount: 4,
      hypothesisTokenCount: 2,
      normalizedPhoneErrorRate: 0.75,
    });
    expect(Object.keys(measured.pronunciationMeasurement ?? {}).sort()).toEqual([
      "deletions",
      "editDistance",
      "evaluationMode",
      "hypothesisTokenCount",
      "insertions",
      "method",
      "normalizedPhoneErrorRate",
      "referenceTokenCount",
      "sourcePhaseStatus",
      "status",
      "substitutions",
    ]);
    const serialized = JSON.stringify(measured.pronunciationMeasurement);
    expect(serialized).not.toMatch(/[0-9a-f]{64}/u);
    expect(serialized).not.toContain("Hallo");
    expect(serialized).not.toContain("/private/");
    for (const forbiddenKey of [
      "targetConditioned",
      "releaseDecision",
      "adjudicationResultSha256",
      "phaseSha256",
      "referenceSha256",
      "targetTextSha256",
      "referenceIpaTokens",
      "threshold",
      "passed",
      "eligibility",
    ]) {
      expect(serialized).not.toContain(forbiddenKey);
    }
    expect(serialized).not.toContain('"measurement":');
  });

  it("projects adjudication without numeric evidence and legacy results fail-honestly", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const legacy = measuredResult(target);
    const insufficientPhase = independentIpaPhaseSchema.parse({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "insufficient",
      reasonCode: "duration-exceeds-independent-ipa-window",
      authorityAudioSha256: legacy.sourceSnapshot.sha256,
      sourceAudioSha256: legacy.sourceSnapshot.sha256,
      normalization: null,
      observation: null,
      error: null,
    });
    const unavailable = toPublicT2aAudioQuality(withIpaAdjudication(
      withIndependentIpaPhase(legacy, insufficientPhase),
    ));
    const legacyPublic = toPublicT2aAudioQuality(legacy);
    const evidenceRemoved = structuredClone(withIpaAdjudication(legacy));
    delete evidenceRemoved.spokenContentGate.ipaAdjudication;
    const evidenceRemovedPublic = toPublicT2aAudioQuality(evidenceRemoved);
    if (unavailable.analysisStatus !== "measured"
      || legacyPublic.analysisStatus !== "measured"
      || evidenceRemovedPublic.analysisStatus !== "measured") {
      throw new Error("Expected measured public quality envelopes");
    }

    expect(unavailable.pronunciationMeasurement).toEqual({
      status: "unavailable",
      sourcePhaseStatus: "insufficient",
      method: T2A_PHONEME_MEASUREMENT_METHOD,
      evaluationMode: "measurement-only",
      substitutions: null,
      deletions: null,
      insertions: null,
      editDistance: null,
      referenceTokenCount: null,
      hypothesisTokenCount: null,
      normalizedPhoneErrorRate: null,
    });
    expect(legacyPublic.pronunciationMeasurement).toBeNull();
    expect(evidenceRemovedPublic.pronunciationMeasurement).toBeNull();
  });

  it("projects insufficient and failed IPA phases without private or fabricated observations", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const base = measuredResult(target);
    const insufficientPhase = independentIpaPhaseSchema.parse({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "insufficient",
      reasonCode: "duration-exceeds-independent-ipa-window",
      authorityAudioSha256: base.sourceSnapshot.sha256,
      sourceAudioSha256: base.sourceSnapshot.sha256,
      normalization: null,
      observation: null,
      error: null,
    });
    const failedPhase = independentIpaPhaseSchema.parse({
      schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
      status: "failed",
      reasonCode: "independent-ipa-failed",
      authorityAudioSha256: base.sourceSnapshot.sha256,
      sourceAudioSha256: base.sourceSnapshot.sha256,
      normalization: null,
      observation: null,
      error: {
        code: "independent-ipa-failed",
        message: "private traceback at /private/runtime/model",
      },
    });
    const insufficient = toPublicT2aAudioQuality(
      withIndependentIpaPhase(base, insufficientPhase),
    );
    const failed = toPublicT2aAudioQuality(withIndependentIpaPhase(base, failedPhase));
    if (insufficient.analysisStatus !== "measured" || failed.analysisStatus !== "measured") {
      throw new Error("Expected measured public quality envelopes");
    }

    expect(insufficient.independentIpa).toEqual({
      evaluationMode: "measurement-only",
      status: "insufficient",
      targetConditioned: false,
      reasonCode: "duration-exceeds-independent-ipa-window",
      method: null,
      modelFingerprint: null,
      decodedIpa: null,
      tokenCount: null,
      unknownTokenCount: null,
      specialTokenCount: null,
      blankFrameRatio: null,
      releaseQualification: {
        status: "not-qualified",
        requiredPositiveHoldoutCases: 300,
        requiredNegativeHoldoutCases: 300,
        maximumFalseAccepts: 0,
      },
    });
    expect(failed.independentIpa).toMatchObject({
      evaluationMode: "measurement-only",
      status: "failed",
      targetConditioned: false,
      reasonCode: "independent-ipa-failed",
      method: null,
      modelFingerprint: null,
      decodedIpa: null,
      tokenCount: null,
      unknownTokenCount: null,
      specialTokenCount: null,
      blankFrameRatio: null,
    });
    const failedPublicIpa = JSON.stringify(failed.independentIpa);
    expect(failedPublicIpa).not.toContain("private traceback");
    expect(failedPublicIpa).not.toContain("/private/");
    expect(failedPublicIpa).not.toContain("error");
  });

  it("persists development measurements with an explicit unattested IA2V blocker", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const fingerprint = "9".repeat(64);
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorFingerprint: () => fingerprint,
      evaluatorClaimScope: () => "development",
      evaluator: async () => ({
        result: measuredResult(target),
        evaluatorFingerprint: fingerprint,
        claimScope: "development",
      }),
    });
    await manager.initialize();
    manager.start(value.job.outputName);
    const record = await waitForTerminal(manager, value.job.outputName);
    expect(record).toMatchObject({
      claimScope: "development",
      status: "completed",
      result: {
        analysisStatus: "measured",
        ia2vEligibility: {
          status: "blocked",
          blockers: ["spoken-content-gate-not-passed", "development-runtime-unattested"],
        },
      },
    });
    const publicRecord = toPublicT2aAudioAnalysis(record, `eq1_${"D".repeat(32)}`);
    expect(publicRecord).toMatchObject({
      claimScope: "development",
      result: {
        ia2vEligibility: {
          status: "blocked",
          blockers: ["spoken-content-gate-not-passed", "development-runtime-unattested"],
        },
      },
    });
    expect(t2aAudioAnalysisRecordSchema.safeParse({
      ...record,
      claimScope: "sealed-release",
    }).success).toBe(false);
    expect(t2aAudioAnalysisRecordSchema.safeParse({
      ...record,
      result: measuredResult(target),
    }).success).toBe(false);
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse({
      ...publicRecord,
      claimScope: "sealed-release",
    }).success).toBe(false);
    await manager.shutdown();
  });

  it("fails closed when the evaluator returns a different claim scope", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const fingerprint = "7".repeat(64);
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorFingerprint: () => fingerprint,
      evaluatorClaimScope: () => "development",
      evaluator: async () => ({
        result: measuredResult(target),
        evaluatorFingerprint: fingerprint,
        claimScope: "sealed-release",
      }),
    });
    await manager.initialize();
    manager.start(value.job.outputName);
    expect(await waitForTerminal(manager, value.job.outputName)).toMatchObject({
      claimScope: "development",
      status: "failed",
      result: null,
    });
    await manager.shutdown();
  });

  it("fails the metadata-only listing binding closed after output or settings stat changes", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const fingerprint = "1".repeat(64);
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorFingerprint: () => fingerprint,
      evaluator: async () => ({
        result: measuredResult(target),
        evaluatorFingerprint: fingerprint,
        claimScope: "sealed-release",
      }),
    });
    await manager.initialize();
    manager.start(value.job.outputName);
    const record = await waitForTerminal(manager, value.job.outputName);
    expect(manager.getForListing(value.job.outputName)).toEqual(record);
    await writeFile(value.outputPath, Buffer.alloc(96_044, 8));
    expect(() => manager.getForListing(value.job.outputName)).toThrowError(OutputQualityError);
    await manager.shutdown();

    const settingsFixture = await fixture();
    const settingsTarget = resolveT2aAudioAnalysisTarget(
      settingsFixture.root,
      settingsFixture.job.outputName,
      [settingsFixture.job],
    );
    const settingsManager = new T2aAudioAnalysisManager(
      () => [settingsFixture.job],
      settingsFixture.root,
      {
        tempRoot: settingsFixture.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => fingerprint,
        evaluator: async () => ({
          result: measuredResult(settingsTarget),
          evaluatorFingerprint: fingerprint,
          claimScope: "sealed-release",
        }),
      },
    );
    await settingsManager.initialize();
    settingsManager.start(settingsFixture.job.outputName);
    await waitForTerminal(settingsManager, settingsFixture.job.outputName);
    const settings = JSON.parse(await readFile(settingsFixture.sidecarPath, "utf8"));
    settings.request.prompt = "hostile replacement";
    await writeFile(settingsFixture.sidecarPath, JSON.stringify(settings), { mode: 0o600 });
    expect(() => settingsManager.getForListing(settingsFixture.job.outputName))
      .toThrowError(OutputQualityError);
    await settingsManager.shutdown();
  });

  it("maps a structured worker failure to failed instead of completed", async () => {
    const value = await fixture();
    const fingerprint = "e".repeat(64);
    const manager = new T2aAudioAnalysisManager(
      () => [value.job],
      value.root,
      {
        tempRoot: value.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => fingerprint,
        evaluator: async () => ({
          evaluatorFingerprint: fingerprint,
          claimScope: "sealed-release",
          result: {
            schemaVersion: T2A_AUDIO_QUALITY_SCHEMA_VERSION,
            mediaKind: "audio",
            analysisKind: "t2a-audio-qa",
            analysisStatus: "failed",
            error: { code: "internal-error", message: "synthetic failure" },
            ia2vEligibility: {
              schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
              status: "blocked",
              blockers: ["analysis-failed"],
            },
          },
        }),
      },
    );
    await manager.initialize();
    manager.start(value.job.outputName);
    const record = await waitForTerminal(manager, value.job.outputName);
    expect(record).toMatchObject({
      status: "failed",
      error: { code: "analysis-failed", message: "synthetic failure" },
      result: { analysisStatus: "failed" },
    });
    const publicFailure = JSON.stringify(
      toPublicT2aAudioAnalysis(record, `eq1_${"F".repeat(32)}`),
    );
    expect(publicFailure).not.toContain("synthetic failure");
    expect(publicFailure).toContain("Die Audioanalyse ist intern fehlgeschlagen");
    await manager.shutdown();
  });

  it("persists running cancellation only after evaluator termination is confirmed", async () => {
    const value = await fixture();
    const fingerprint = "c".repeat(64);
    const manager = new T2aAudioAnalysisManager(
      () => [value.job],
      value.root,
      {
        tempRoot: value.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => fingerprint,
        evaluator: (_target, options) => new Promise((_resolvePromise, rejectPromise) => {
          options?.signal?.addEventListener("abort", () => {
            rejectPromise(new T2aAudioEvaluatorCancelledError());
          }, { once: true });
        }),
      },
    );
    await manager.initialize();
    const started = manager.start(value.job.outputName);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (manager.getStored(value.job.outputName)?.status === "running") break;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    const cancelling = manager.cancel(value.job.outputName, started.analysisId);
    expect(cancelling).toMatchObject({
      status: "running",
      error: null,
    });
    const cancelled = await waitForTerminal(manager, value.job.outputName);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      error: { code: "cancelled" },
      result: null,
    });
    await manager.shutdown();
    expect(manager.isActive(value.job.outputName)).toBe(false);
    expect(manager.getStored(value.job.outputName)?.status).toBe("cancelled");
  });

  it("fails closed instead of reporting cancellation when sandbox stop is unconfirmed", async () => {
    const value = await fixture();
    const fingerprint = "9".repeat(64);
    const manager = new T2aAudioAnalysisManager(
      () => [value.job],
      value.root,
      {
        tempRoot: value.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => fingerprint,
        evaluator: (_target, options) => new Promise((_resolvePromise, rejectPromise) => {
          options?.signal?.addEventListener("abort", () => {
            rejectPromise(new T2aAudioEvaluatorTerminationError("systemctl stop denied"));
          }, { once: true });
        }),
      },
    );
    await manager.initialize();
    const started = manager.start(value.job.outputName);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (manager.getStored(value.job.outputName)?.status === "running") break;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    expect(manager.cancel(value.job.outputName, started.analysisId)?.status).toBe("running");
    const terminal = await waitForTerminal(manager, value.job.outputName);
    expect(terminal).toMatchObject({ status: "failed", error: { code: "analysis-failed" } });
    await expect(manager.shutdown()).rejects.toThrow(/ohne bestaetigte Terminierung/u);
  });

  it("never starts a queued evaluator after an unconfirmed sandbox stop", async () => {
    const first = await fixture();
    const second = await fixture({
      root: first.root,
      tempRoot: first.tempRoot,
      outputName: "second-t2a.wav",
      jobId: "3c8a5dc6-8864-49f7-a639-85caef918889",
    });
    const fingerprint = "5".repeat(64);
    let evaluatorCalls = 0;
    const manager = new T2aAudioAnalysisManager(
      () => [first.job, second.job],
      first.root,
      {
        tempRoot: first.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => fingerprint,
        evaluator: (_target, options) => {
          evaluatorCalls += 1;
          return new Promise((_resolvePromise, rejectPromise) => {
            options?.signal?.addEventListener("abort", () => {
              rejectPromise(new T2aAudioEvaluatorTerminationError("systemctl stop denied"));
            }, { once: true });
          });
        },
      },
    );
    await manager.initialize();
    const firstRun = manager.start(first.job.outputName);
    manager.start(second.job.outputName);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (manager.getStored(first.job.outputName)?.status === "running") break;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    expect(manager.cancel(first.job.outputName, firstRun.analysisId)?.status).toBe("running");
    expect(await waitForTerminal(manager, first.job.outputName)).toMatchObject({ status: "failed" });
    expect(await waitForTerminal(manager, second.job.outputName)).toMatchObject({
      status: "failed",
      error: { code: "analysis-failed" },
    });
    expect(evaluatorCalls).toBe(1);
    expect(manager.isActive(second.job.outputName)).toBe(false);
    await expect(manager.shutdown(25)).rejects.toThrow(/ohne bestaetigte Terminierung/u);
  });

  it("locks and drains the queue on unconfirmed termination without manual cancellation", async () => {
    const first = await fixture();
    const second = await fixture({
      root: first.root,
      tempRoot: first.tempRoot,
      outputName: "unconfirmed-second.wav",
      jobId: "5c8a5dc6-8864-49f7-a639-85caef918891",
    });
    const fingerprint = "3".repeat(64);
    let evaluatorCalls = 0;
    const manager = new T2aAudioAnalysisManager(
      () => [first.job, second.job],
      first.root,
      {
        tempRoot: first.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => fingerprint,
        evaluator: async () => {
          evaluatorCalls += 1;
          throw new T2aAudioEvaluatorTerminationError("unit remained active");
        },
      },
    );
    await manager.initialize();
    manager.start(first.job.outputName);
    manager.start(second.job.outputName);
    expect(await waitForTerminal(manager, first.job.outputName)).toMatchObject({ status: "failed" });
    expect(await waitForTerminal(manager, second.job.outputName)).toMatchObject({ status: "failed" });
    expect(evaluatorCalls).toBe(1);
    expect(manager.isActive(second.job.outputName)).toBe(false);
    await expect(manager.shutdown(25)).rejects.toThrow(/ohne bestaetigte Terminierung/u);
  });

  it("allows a retry after an evaluator timeout with confirmed termination", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const fingerprint = "2".repeat(64);
    let evaluatorCalls = 0;
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorFingerprint: () => fingerprint,
      evaluator: async () => {
        evaluatorCalls += 1;
        if (evaluatorCalls === 1) throw new Error("confirmed timeout");
        return {
          result: measuredResult(target),
          evaluatorFingerprint: fingerprint,
          claimScope: "sealed-release",
        };
      },
    });
    await manager.initialize();
    manager.start(value.job.outputName);
    expect(await waitForTerminal(manager, value.job.outputName)).toMatchObject({ status: "failed" });
    const retry = manager.start(value.job.outputName, true);
    expect(retry.attempt).toBe(2);
    expect(await waitForTerminal(manager, value.job.outputName)).toMatchObject({
      status: "completed",
      attempt: 2,
    });
    expect(evaluatorCalls).toBe(2);
    await manager.shutdown();
  });

  it("does not start the next evaluator after terminal record persistence fails", async () => {
    const first = await fixture();
    const second = await fixture({
      root: first.root,
      tempRoot: first.tempRoot,
      outputName: "persistence-second.wav",
      jobId: "6c8a5dc6-8864-49f7-a639-85caef918892",
    });
    const target = resolveT2aAudioAnalysisTarget(first.root, first.job.outputName, [first.job, second.job]);
    const fingerprint = "0".repeat(64);
    let evaluatorCalls = 0;
    const manager = new T2aAudioAnalysisManager(
      () => [first.job, second.job],
      first.root,
      {
        tempRoot: first.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => fingerprint,
        evaluator: async () => {
          evaluatorCalls += 1;
          await chmod(first.root, 0o500);
          return {
            result: measuredResult(target),
            evaluatorFingerprint: fingerprint,
            claimScope: "sealed-release",
          };
        },
      },
    );
    try {
      await manager.initialize();
      manager.start(first.job.outputName);
      manager.start(second.job.outputName);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (!manager.isActive(first.job.outputName) && !manager.isActive(second.job.outputName)) break;
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
      }
      expect(manager.isActive(first.job.outputName)).toBe(false);
      expect(manager.isActive(second.job.outputName)).toBe(false);
      expect(evaluatorCalls).toBe(1);
    } finally {
      await chmod(first.root, 0o700);
    }
    await expect(manager.shutdown(25)).rejects.toThrow(/ohne bestaetigte Terminierung/u);
  });

  it("keeps shutdown terminal when queued lease cleanup throws during cancellation", async () => {
    const first = await fixture();
    const second = await fixture({
      root: first.root,
      tempRoot: first.tempRoot,
      outputName: "cancel-queued.wav",
      jobId: "4c8a5dc6-8864-49f7-a639-85caef918890",
    });
    const fingerprint = "4".repeat(64);
    const manager = new T2aAudioAnalysisManager(
      () => [first.job, second.job],
      first.root,
      {
        tempRoot: first.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => fingerprint,
        evaluator: (_target, options) => new Promise((_resolvePromise, rejectPromise) => {
          options?.signal?.addEventListener("abort", () => {
            rejectPromise(new T2aAudioEvaluatorCancelledError());
          }, { once: true });
        }),
      },
    );
    await manager.initialize();
    const firstRun = manager.start(first.job.outputName);
    const secondRun = manager.start(second.job.outputName);
    const internals = manager as unknown as {
      tasks: Map<string, { lease: { release: () => void } }>;
    };
    const queuedTask = internals.tasks.get(secondRun.analysisId);
    if (!queuedTask) throw new Error("expected queued manager task");
    const release = queuedTask.lease.release;
    queuedTask.lease.release = () => {
      release();
      throw new Error("synthetic queued lease cleanup failure");
    };
    await expect(manager.shutdown(25)).rejects.toThrow(/ohne bestaetigte Terminierung/u);
    expect(internals.tasks.has(secondRun.analysisId)).toBe(false);
    expect(manager.isActive(second.job.outputName)).toBe(false);
    expect(manager.getStored(second.job.outputName)).toMatchObject({ status: "cancelled" });
    expect(manager.getStored(first.job.outputName)).toMatchObject({
      analysisId: firstRun.analysisId,
      status: "cancelled",
    });
  });

  it("clears running state even when private lease cleanup throws", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const fingerprint = "8".repeat(64);
    const evaluation = deferred<{
      result: T2aMeasuredAudioQuality;
      evaluatorFingerprint: string;
      claimScope: "sealed-release";
    }>();
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorFingerprint: () => fingerprint,
      evaluator: async () => evaluation.promise,
    });
    await manager.initialize();
    const started = manager.start(value.job.outputName);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (manager.getStored(value.job.outputName)?.status === "running") break;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    const internals = manager as unknown as {
      tasks: Map<string, { lease: { release: () => void } }>;
    };
    const task = internals.tasks.get(started.analysisId);
    if (!task) throw new Error("expected active manager task");
    const release = task.lease.release;
    task.lease.release = () => {
      release();
      throw new Error("synthetic private lease cleanup failure");
    };
    evaluation.resolve({
      result: measuredResult(target),
      evaluatorFingerprint: fingerprint,
      claimScope: "sealed-release",
    });
    await waitForTerminal(manager, value.job.outputName);
    for (let attempt = 0; attempt < 100 && manager.isActive(value.job.outputName); attempt += 1) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
    }
    expect(manager.isActive(value.job.outputName)).toBe(false);
    await expect(manager.shutdown(25)).rejects.toThrow(/ohne bestaetigte Terminierung/u);
  });

  it("keeps attempts monotone across evaluator revisions and rejects stale terminal cancel", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    let fingerprint = "a".repeat(64);
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorFingerprint: () => fingerprint,
      evaluator: async () => ({
        result: measuredResult(target),
        evaluatorFingerprint: fingerprint,
        claimScope: "sealed-release",
      }),
    });
    await manager.initialize();
    manager.start(value.job.outputName);
    await waitForTerminal(manager, value.job.outputName);
    manager.start(value.job.outputName, true);
    expect(await waitForTerminal(manager, value.job.outputName)).toMatchObject({ attempt: 2 });
    fingerprint = "b".repeat(64);
    const revised = manager.start(value.job.outputName);
    expect(revised.attempt).toBe(3);
    const completed = await waitForTerminal(manager, value.job.outputName);
    expect(completed).toMatchObject({ status: "completed", attempt: 3 });
    fingerprint = "c".repeat(64);
    expect(() => manager.cancel(value.job.outputName, completed.analysisId))
      .toThrowError(OutputQualityError);
    try {
      manager.cancel(value.job.outputName, completed.analysisId);
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 409 });
    }
    await manager.shutdown();
  });

  it("invalidates an interrupted record after an IPA-inclusive binding change on restart", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const timestamp = "2026-08-26T00:10:00.000Z";
    const oldBinding = {
      evaluatorFingerprint: "1".repeat(64),
      claimScope: "sealed-release" as const,
    };
    const currentBinding = {
      evaluatorFingerprint: "2".repeat(64),
      claimScope: "sealed-release" as const,
    };
    writeT2aAudioAnalysis(value.root, t2aAudioAnalysisRecordSchema.parse({
      schemaVersion: T2A_AUDIO_ANALYSIS_RECORD_VERSION,
      analysisKind: "t2a-audio-qa",
      mediaKind: "audio",
      analysisId: "6c8a5dc6-8864-49f7-a639-85caef919999",
      claimScope: oldBinding.claimScope,
      evaluatorFingerprint: oldBinding.evaluatorFingerprint,
      targetBinding: target.binding,
      attempt: 1,
      status: "running",
      progress: 10,
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: null,
      updatedAt: timestamp,
      error: null,
      result: null,
    }));
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorBinding: () => currentBinding,
      expectedEvaluatorBinding: currentBinding,
      evaluator: async () => ({
        result: measuredResult(target),
        ...currentBinding,
      }),
    });

    await manager.initialize();
    expect(manager.getStored(value.job.outputName)).toMatchObject({
      evaluatorFingerprint: oldBinding.evaluatorFingerprint,
      status: "failed",
      error: { message: expect.stringContaining("kombinierte T2A-Evaluator-Bindung") },
    });
    expect(manager.get(value.job.outputName)).toBeNull();
    const restarted = manager.start(value.job.outputName);
    expect(restarted).toMatchObject({
      attempt: 2,
      evaluatorFingerprint: currentBinding.evaluatorFingerprint,
      claimScope: currentBinding.claimScope,
    });
    await expect(waitForTerminal(manager, value.job.outputName)).resolves.toMatchObject({
      attempt: 2,
      status: "completed",
      evaluatorFingerprint: currentBinding.evaluatorFingerprint,
    });
    await manager.shutdown();
  });

  it("keeps Studio initialization available but blocks T2A after recovery authority loss", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const timestamp = "2026-08-26T00:10:00.000Z";
    writeT2aAudioAnalysis(value.root, t2aAudioAnalysisRecordSchema.parse({
      schemaVersion: T2A_AUDIO_ANALYSIS_RECORD_VERSION,
      analysisKind: "t2a-audio-qa",
      mediaKind: "audio",
      analysisId: "7c8a5dc6-8864-49f7-a639-85caef919999",
      claimScope: "sealed-release",
      evaluatorFingerprint: "3".repeat(64),
      targetBinding: target.binding,
      attempt: 1,
      status: "queued",
      progress: 0,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      updatedAt: timestamp,
      error: null,
      result: null,
    }));
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorBinding: () => {
        throw new Error("independent IPA authority unavailable at /private/model");
      },
    });

    await expect(manager.initialize()).resolves.toBeUndefined();
    expect(manager.getStored(value.job.outputName)).toMatchObject({ status: "failed" });
    expect(() => manager.get(value.job.outputName)).toThrow(
      "T2A-Audioanalyse: Lesen konnte nicht sicher ausgefuehrt werden.",
    );
    expect(() => manager.start(value.job.outputName)).toThrow(
      "T2A-Audioanalyse: Start konnte nicht sicher ausgefuehrt werden.",
    );
    expect((await readdir(value.tempRoot)).filter((name) => name.startsWith("t2a-audio-")))
      .toEqual([]);
    await manager.shutdown();
  });

  it("requires the live combined binding to match the successful startup preflight", async () => {
    const value = await fixture();
    const preflightBinding = {
      evaluatorFingerprint: "4".repeat(64),
      claimScope: "development" as const,
    };
    const liveBinding = {
      evaluatorFingerprint: "5".repeat(64),
      claimScope: "development" as const,
    };
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorBinding: () => liveBinding,
      expectedEvaluatorBinding: preflightBinding,
    });

    await manager.initialize();
    expect(() => manager.start(value.job.outputName)).toThrow(
      "T2A-Audioanalyse: Start konnte nicht sicher ausgefuehrt werden.",
    );
    expect(() => manager.get(value.job.outputName)).toThrow(
      "T2A-Audioanalyse: Lesen konnte nicht sicher ausgefuehrt werden.",
    );
    expect((await readdir(value.tempRoot)).filter((name) => name.startsWith("t2a-audio-")))
      .toEqual([]);
    await manager.shutdown();
  });

  it("releases its private lease when evaluator-state resolution fails", async () => {
    const value = await fixture();
    const manager = new T2aAudioAnalysisManager(
      () => [value.job],
      value.root,
      {
        tempRoot: value.tempRoot,
        sandboxRecovery: async () => undefined,
        evaluatorFingerprint: () => {
          throw new Error("authority unavailable at '/home/moddy/private-runtime'");
        },
      },
    );
    await manager.initialize();
    expect(() => manager.start(value.job.outputName)).toThrow(
      "T2A-Audioanalyse: Start konnte nicht sicher ausgefuehrt werden.",
    );
    try {
      manager.start(value.job.outputName);
    } catch (error) {
      expect(String(error)).not.toContain("/home/moddy/private-runtime");
    }
    expect((await readdir(value.tempRoot)).filter((name) => name.startsWith("t2a-audio-")))
      .toEqual([]);
  });

  it("redacts paths and digests even when an internal failure message contains them", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const timestamp = "2026-08-26T00:10:00.000Z";
    const privateDigest = "a".repeat(64);
    const record = t2aAudioAnalysisRecordSchema.parse({
      schemaVersion: "ltx-studio-t2a-audio-analysis.v3",
      analysisKind: "t2a-audio-qa",
      mediaKind: "audio",
      analysisId: "3c8a5dc6-8864-49f7-a639-85caef919999",
      claimScope: "sealed-release",
      evaluatorFingerprint: "b".repeat(64),
      targetBinding: target.binding,
      attempt: 1,
      status: "failed",
      progress: 10,
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      updatedAt: timestamp,
      error: {
        code: "analysis-failed",
        message: `private /home/moddy/model.pt digest ${privateDigest}`,
      },
      result: null,
    });
    const serialized = JSON.stringify(toPublicT2aAudioAnalysis(record, `eq1_${"B".repeat(32)}`));
    expect(serialized).not.toContain("/home/moddy/model.pt");
    expect(serialized).not.toContain(privateDigest);
    expect(serialized).not.toContain("[redacted-path]");
    expect(serialized).not.toContain("[redacted-digest]");
    expect(serialized).toContain("T2A-Audioanalyse konnte nicht sicher abgeschlossen werden");
  });

  it("never publishes hostile quoted, assigned or file-URL diagnostics", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const timestamp = "2026-08-26T00:10:00.000Z";
    const secretDialogue = "dieser exakte Dialog darf nie im Fehler stehen";
    const hostile = `FileNotFoundError: '/home/moddy/model.pt' path=/run/private file:///tmp/x ${secretDialogue}`;
    const record = t2aAudioAnalysisRecordSchema.parse({
      schemaVersion: "ltx-studio-t2a-audio-analysis.v3",
      analysisKind: "t2a-audio-qa",
      mediaKind: "audio",
      analysisId: "4c8a5dc6-8864-49f7-a639-85caef919999",
      claimScope: "sealed-release",
      evaluatorFingerprint: "d".repeat(64),
      targetBinding: target.binding,
      attempt: 1,
      status: "failed",
      progress: 10,
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      updatedAt: timestamp,
      error: { code: "analysis-failed", message: hostile },
      result: null,
    });
    const serialized = JSON.stringify(toPublicT2aAudioAnalysis(record, `eq1_${"C".repeat(32)}`));
    for (const secret of ["/home/moddy", "/run/private", "file:///tmp", secretDialogue]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("recovers only canonical private records and ignores symlinks, oversize and wrong names", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const timestamp = "2026-08-26T00:10:00.000Z";
    const queued = t2aAudioAnalysisRecordSchema.parse({
      schemaVersion: "ltx-studio-t2a-audio-analysis.v3",
      analysisKind: "t2a-audio-qa",
      mediaKind: "audio",
      analysisId: "5c8a5dc6-8864-49f7-a639-85caef919999",
      claimScope: "sealed-release",
      evaluatorFingerprint: "e".repeat(64),
      targetBinding: target.binding,
      attempt: 1,
      status: "queued",
      progress: 0,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      updatedAt: timestamp,
      error: null,
      result: null,
    });
    const wrong = join(value.root, "wrong.wav.ltx-t2a-audio-analysis.json");
    const source = join(value.root, "private-source.json");
    const linked = join(value.root, "link.wav.ltx-t2a-audio-analysis.json");
    const oversized = join(value.root, "huge.wav.ltx-t2a-audio-analysis.json");
    await writeFile(wrong, `${JSON.stringify(queued)}\n`, { mode: 0o600 });
    await writeFile(source, `${JSON.stringify(queued)}\n`, { mode: 0o600 });
    await symlink(source, linked);
    await writeFile(oversized, Buffer.alloc(2 * 1024 * 1024 + 1), { mode: 0o600 });
    expect(recoverInterruptedT2aAudioAnalyses(value.root)).toBe(0);
    expect(existsSync(t2aAudioAnalysisPath(value.root, value.job.outputName))).toBe(false);
  });

  it("treats pre-IPA v2 records as stale instead of recovering them under the v3 claim", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const timestamp = "2026-08-26T00:10:00.000Z";
    const v3Queued = t2aAudioAnalysisRecordSchema.parse({
      schemaVersion: T2A_AUDIO_ANALYSIS_RECORD_VERSION,
      analysisKind: "t2a-audio-qa",
      mediaKind: "audio",
      analysisId: "8c8a5dc6-8864-49f7-a639-85caef919999",
      claimScope: "sealed-release",
      evaluatorFingerprint: "6".repeat(64),
      targetBinding: target.binding,
      attempt: 4,
      status: "queued",
      progress: 0,
      createdAt: timestamp,
      startedAt: null,
      finishedAt: null,
      updatedAt: timestamp,
      error: null,
      result: null,
    });
    await writeFile(
      t2aAudioAnalysisPath(value.root, value.job.outputName),
      `${JSON.stringify({ ...v3Queued, schemaVersion: "ltx-studio-t2a-audio-analysis.v2" })}\n`,
      { mode: 0o600 },
    );
    const binding = {
      evaluatorFingerprint: "7".repeat(64),
      claimScope: "sealed-release" as const,
    };
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorBinding: () => binding,
      evaluator: async () => ({
        result: measuredResult(target),
        ...binding,
      }),
    });

    await manager.initialize();
    expect(manager.getStored(value.job.outputName)).toBeNull();
    expect(manager.get(value.job.outputName)).toBeNull();
    const replacement = manager.start(value.job.outputName);
    expect(replacement).toMatchObject({
      schemaVersion: T2A_AUDIO_ANALYSIS_RECORD_VERSION,
      attempt: 1,
      evaluatorFingerprint: binding.evaluatorFingerprint,
    });
    await waitForTerminal(manager, value.job.outputName);
    await manager.shutdown();
  });

  it("durably removes its sidecar and treats ENOENT as idempotent", async () => {
    const value = await fixture();
    const target = resolveT2aAudioAnalysisTarget(value.root, value.job.outputName, [value.job]);
    const fingerprint = "6".repeat(64);
    const manager = new T2aAudioAnalysisManager(() => [value.job], value.root, {
      tempRoot: value.tempRoot,
      sandboxRecovery: async () => undefined,
      evaluatorFingerprint: () => fingerprint,
      evaluator: async () => ({
        result: measuredResult(target),
        evaluatorFingerprint: fingerprint,
        claimScope: "sealed-release",
      }),
    });
    await manager.initialize();
    manager.start(value.job.outputName);
    await waitForTerminal(manager, value.job.outputName);
    await manager.shutdown();
    removeT2aAudioAnalysis(value.root, value.job.outputName);
    expect(existsSync(t2aAudioAnalysisPath(value.root, value.job.outputName))).toBe(false);
    expect(() => removeT2aAudioAnalysis(value.root, value.job.outputName)).not.toThrow();
  });

  it("removes only owner-bound managed crash snapshots", async () => {
    const value = await fixture();
    const managed = await mkdtemp(join(value.tempRoot, "t2a-audio-"));
    const unrelated = join(value.tempRoot, "do-not-delete");
    await writeFile(unrelated, "keep");
    expect(cleanupT2aAudioSnapshots(value.tempRoot)).toBe(1);
    await expect(readFile(managed)).rejects.toThrow();
    await expect(readFile(unrelated, "utf8")).resolves.toBe("keep");
  });
});
