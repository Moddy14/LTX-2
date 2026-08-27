import { describe, expect, it } from "vitest";

import {
  deriveT2aIa2vEligibility,
  deriveT2aSpokenContentGate,
  PCM16_LSB_LINEAR,
  T2A_AUDIO_QUALITY_SCHEMA_VERSION,
  T2A_FFMPEG_SHA256,
  T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
  T2A_SPOKEN_CONTENT_GATE_SCHEMA_VERSION,
  T2A_WHISPER_SMALL_SHA256,
  bindT2aAudioQualityClaimScope,
  bindT2aIa2vEligibilityClaimScope,
  t2aAudioQualitySchema,
  type T2aAudioDialogueEvaluation,
  type T2aMeasuredAudioQuality,
} from "../shared/t2aAudioQuality.js";
import type { IndependentIpaPhase } from "../shared/independentIpa.js";

function measuredDialogue(): T2aAudioDialogueEvaluation {
  return {
    status: "measured",
    blockerCode: "none",
    error: null,
    method: "whisper-small-guided-word-motion.v1",
    modelName: "OpenAI Whisper small",
    modelSha256: T2A_WHISPER_SMALL_SHA256,
    packageVersion: "20250625",
    detectedLanguage: "de",
    expectedTranscriptSha256: "b".repeat(64),
    expectedWordCount: 1,
    recognizedWordCount: 1,
    recognizedTranscript: "Hallo",
    wordErrorRate: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    rawAsrContentGate: {
      status: "passed",
      method: "whisper-small-independent-raw-asr-token-edits.v1",
      targetConditioned: false,
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
      status: "not-available",
      method: null,
      reason: "Kein unabhaengig gebundener Zweit-Recognizer oder Phonem-Scorer ist verfuegbar.",
    },
    guidedAlignedWordCount: 1,
    guidedWordCoverage: 1,
    usableAlignedWordCount: 1,
    usableGuidedWordCoverage: 1,
    medianGuidedWordProbability: 0.9,
    p10GuidedWordProbability: 0.9,
    lowConfidenceAlignedWords: 0,
    alignmentStatus: "measured",
    alignmentError: null,
    timePrecisionMilliseconds: 20,
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
}

const AUDIO_SHA256 = "d".repeat(64);
const IPA_PHASE_DOCUMENT_SHA256 = "f".repeat(64);

function measuredIndependentIpaPhase(
  authorityAudioSha256 = AUDIO_SHA256,
): IndependentIpaPhase {
  const normalizedAudioSha256 = "e".repeat(64);
  return {
    schemaVersion: "ltx-studio-independent-ipa-phase.v2",
    status: "measured",
    reasonCode: null,
    authorityAudioSha256,
    sourceAudioSha256: authorityAudioSha256,
    normalization: {
      method: "ffmpeg-pcm-s16le-mono-16khz-bitexact.v1",
      ffmpegSha256: T2A_FFMPEG_SHA256,
      normalizedAudioSha256,
      sampleRateHz: 16_000,
      channels: 1,
      durationMilliseconds: 100,
    },
    observation: {
      schemaVersion: "ltx-studio-independent-ipa-observation.v1",
      status: "measured",
      error: null,
      method: "xlsr53-espeak-cv-free-ctc-greedy.v1",
      decoderPolicy: "ctc-collapse-runs-then-remove-blank.v1",
      targetConditioned: false,
      runnerSha256: "1".repeat(64),
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
      modelFingerprint: "2".repeat(64),
      modelManifestSha256: "3".repeat(64),
      modelWeightSha256: "4".repeat(64),
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
  };
}

function dialogueWithTwoSubstitutions(): T2aAudioDialogueEvaluation {
  const expectedWords = Array.from({ length: 43 }, (_, index) => `wort${index}`);
  expectedWords[10] = "reißt";
  expectedWords[20] = "schreie";
  const recognizedWords = [...expectedWords];
  recognizedWords[10] = "reist";
  recognizedWords[20] = "schreihe";
  return {
    ...measuredDialogue(),
    expectedWordCount: 43,
    recognizedWordCount: 43,
    recognizedTranscript: recognizedWords.join(" "),
    wordErrorRate: 2 / 43,
    substitutions: 2,
    rawAsrContentGate: {
      status: "failed",
      method: "whisper-small-independent-raw-asr-token-edits.v1",
      targetConditioned: false,
      exactTokenMatch: false,
      expectedNormalizedWords: expectedWords,
      recognizedNormalizedWords: recognizedWords,
      prefixInsertions: [],
      internalInsertions: [],
      suffixInsertions: [],
      deletedExpectedWords: [],
      substitutedWords: [{
        expectedIndex: 10,
        recognizedIndex: 10,
        expectedWord: "reißt",
        recognizedWord: "reist",
      }, {
        expectedIndex: 20,
        recognizedIndex: 20,
        expectedWord: "schreie",
        recognizedWord: "schreihe",
      }],
      repeatedInsertions: [],
    },
    guidedAlignedWordCount: 43,
    guidedWordCoverage: 1,
    usableAlignedWordCount: 43,
    usableGuidedWordCoverage: 1,
    medianGuidedWordProbability: 0.9,
    p10GuidedWordProbability: 0.9,
    lowConfidenceAlignedWords: 0,
    guidedWords: expectedWords.map((word, index) => ({
      index,
      word,
      normalizedWord: word,
      tokenIds: [index + 1],
      startSeconds: index / 100,
      endSeconds: (index + 0.5) / 100,
      probability: 0.9,
      usable: true,
    })),
  };
}

function spokenContentGateFor(dialogueEvaluation: T2aAudioDialogueEvaluation) {
  return deriveT2aSpokenContentGate({
    dialogueEvaluation,
    authorityAudioSha256: AUDIO_SHA256,
    phaseDocumentSha256: IPA_PHASE_DOCUMENT_SHA256,
    independentIpaPhase: measuredIndependentIpaPhase(),
  });
}

function measuredAudio(
  dialogueEvaluation = measuredDialogue(),
  overrides: Partial<T2aMeasuredAudioQuality> = {},
): T2aMeasuredAudioQuality {
  const wav = {
    container: "RIFF/WAVE" as const,
    codec: "pcm_s16le" as const,
    formatTag: 1 as const,
    bitsPerSample: 16 as const,
    channels: 1,
    sampleRateHz: 48_000,
    sampleFrames: 48_000,
    durationSeconds: 1,
  };
  const facts = {
    wav,
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
      integratedLufs: -40,
      truePeakDbtp: -1,
    },
    policy: {
      peakCeilingDbfs: -3,
      peakCeilingLinear: 10 ** (-3 / 20),
      pcm16LsbToleranceLinear: PCM16_LSB_LINEAR,
    },
    dialogueEvaluation,
  };
  const sourceSnapshot = {
    sha256: AUDIO_SHA256,
    byteLength: 96_044,
  };
  const spokenContentGate = deriveT2aSpokenContentGate({
    dialogueEvaluation,
    authorityAudioSha256: sourceSnapshot.sha256,
    phaseDocumentSha256: IPA_PHASE_DOCUMENT_SHA256,
    independentIpaPhase: measuredIndependentIpaPhase(sourceSnapshot.sha256),
  });
  return {
    schemaVersion: T2A_AUDIO_QUALITY_SCHEMA_VERSION,
    mediaKind: "audio",
    analysisKind: "t2a-audio-qa",
    analysisStatus: "measured",
    sourceSnapshot,
    ...facts,
    spokenContentGate,
    ia2vEligibility: deriveT2aIa2vEligibility({ ...facts, spokenContentGate }),
    ...overrides,
  };
}

describe("T2A audio-quality evidence", () => {
  it("keeps every measurement blocked without making integrated loudness an eligibility condition", () => {
    const quiet = measuredAudio();
    const loud = measuredAudio(measuredDialogue(), {
      loudness: { ...quiet.loudness, integratedLufs: -6 },
    });
    loud.ia2vEligibility = deriveT2aIa2vEligibility(loud);

    expect(t2aAudioQualitySchema.parse(quiet).ia2vEligibility.status).toBe("blocked");
    expect(t2aAudioQualitySchema.parse(loud).ia2vEligibility.status).toBe("blocked");
    expect(quiet).toMatchObject({
      schemaVersion: "t2a-audio-quality.v2",
      mediaKind: "audio",
      analysisKind: "t2a-audio-qa",
      spokenContentGate: {
        schemaVersion: T2A_SPOKEN_CONTENT_GATE_SCHEMA_VERSION,
        evaluationMode: "measurement-only",
        releaseDecision: "blocked",
        blockerCodes: ["calibrated-holdout-not-qualified"],
        releaseQualification: {
          status: "not-qualified",
          requiredPositiveHoldoutCases: 300,
          requiredNegativeHoldoutCases: 300,
          maximumFalseAccepts: 0,
          evidenceSha256: null,
        },
      },
      ia2vEligibility: {
        schemaVersion: "t2a-ia2v-eligibility.v2",
        status: "blocked",
        blockers: ["spoken-content-gate-not-passed"],
      },
    });
  });

  it("keeps 2/43 Whisper substitutions immutable and unqualified despite measured IPA", () => {
    const dialogue = dialogueWithTwoSubstitutions();
    const before = structuredClone(dialogue);
    const gate = spokenContentGateFor(dialogue);

    expect(dialogue).toEqual(before);
    expect(dialogue).toMatchObject({
      expectedWordCount: 43,
      recognizedWordCount: 43,
      wordErrorRate: 2 / 43,
      substitutions: 2,
      deletions: 0,
      insertions: 0,
      rawAsrContentGate: {
        status: "failed",
        substitutedWords: [{
          expectedWord: "reißt",
          recognizedWord: "reist",
        }, {
          expectedWord: "schreie",
          recognizedWord: "schreihe",
        }],
      },
    });
    expect(gate).toMatchObject({
      evaluationMode: "measurement-only",
      releaseDecision: "blocked",
      blockerCodes: [
        "calibrated-holdout-not-qualified",
        "raw-asr-substitution-unqualified",
      ],
      independentIpa: {
        authorityAudioSha256: AUDIO_SHA256,
        phaseDocumentSha256: IPA_PHASE_DOCUMENT_SHA256,
        phase: { status: "measured" },
      },
    });

    const measured = measuredAudio(dialogue);
    expect(t2aAudioQualitySchema.parse(measured).ia2vEligibility.blockers).toEqual([
      "raw-asr-content-gate-not-passed",
      "word-error-rate-not-zero",
      "word-edit-counts-not-zero",
      "spoken-content-gate-not-passed",
    ]);
  });

  it("always exposes deletion, insertion, and repetition as spoken-content blockers", () => {
    const base = measuredDialogue();
    const deletion: T2aAudioDialogueEvaluation = {
      ...base,
      recognizedWordCount: 0,
      recognizedTranscript: "",
      wordErrorRate: 1,
      deletions: 1,
      rawAsrContentGate: {
        ...base.rawAsrContentGate,
        status: "failed",
        exactTokenMatch: false,
        recognizedNormalizedWords: [],
        deletedExpectedWords: [{ expectedIndex: 0, word: "hallo" }],
      },
    };
    const repeatedInsertion: T2aAudioDialogueEvaluation = {
      ...base,
      recognizedWordCount: 2,
      recognizedTranscript: "Hallo Hallo",
      wordErrorRate: 1,
      insertions: 1,
      rawAsrContentGate: {
        ...base.rawAsrContentGate,
        status: "failed",
        exactTokenMatch: false,
        recognizedNormalizedWords: ["hallo", "hallo"],
        prefixInsertions: [{ recognizedIndex: 0, word: "hallo" }],
        repeatedInsertions: [{ recognizedIndex: 0, word: "hallo" }],
      },
    };

    expect(spokenContentGateFor(deletion).blockerCodes).toEqual([
      "calibrated-holdout-not-qualified",
      "raw-asr-deletion-present",
    ]);
    expect(spokenContentGateFor(repeatedInsertion).blockerCodes).toEqual([
      "calibrated-holdout-not-qualified",
      "raw-asr-insertion-present",
      "raw-asr-repetition-present",
    ]);
    expect(t2aAudioQualitySchema.parse(measuredAudio(deletion)).ia2vEligibility.blockers)
      .toContain("spoken-content-gate-not-passed");
    expect(t2aAudioQualitySchema.parse(measuredAudio(repeatedInsertion)).ia2vEligibility.blockers)
      .toContain("spoken-content-gate-not-passed");
  });

  it("distinguishes insufficient and failed IPA evidence without creating a release path", () => {
    const insufficient: IndependentIpaPhase = {
      schemaVersion: "ltx-studio-independent-ipa-phase.v2",
      status: "insufficient",
      reasonCode: "duration-exceeds-independent-ipa-window",
      authorityAudioSha256: AUDIO_SHA256,
      sourceAudioSha256: AUDIO_SHA256,
      normalization: null,
      observation: null,
      error: null,
    };
    const failed: IndependentIpaPhase = {
      schemaVersion: "ltx-studio-independent-ipa-phase.v2",
      status: "failed",
      reasonCode: "independent-ipa-failed",
      authorityAudioSha256: AUDIO_SHA256,
      sourceAudioSha256: AUDIO_SHA256,
      normalization: null,
      observation: null,
      error: {
        code: "independent-ipa-failed",
        message: "Gebundener Testfehler.",
      },
    };
    const derive = (phase: IndependentIpaPhase) => deriveT2aSpokenContentGate({
      dialogueEvaluation: measuredDialogue(),
      authorityAudioSha256: AUDIO_SHA256,
      phaseDocumentSha256: IPA_PHASE_DOCUMENT_SHA256,
      independentIpaPhase: phase,
    });

    expect(derive(insufficient).blockerCodes).toEqual([
      "calibrated-holdout-not-qualified",
      "independent-ipa-insufficient",
    ]);
    expect(derive(failed).blockerCodes).toEqual([
      "calibrated-holdout-not-qualified",
      "independent-ipa-failed",
    ]);
  });

  it("rejects invented release passes and invalid phase/audio bindings", () => {
    const valid = measuredAudio();
    expect(t2aAudioQualitySchema.safeParse({
      ...valid,
      spokenContentGate: {
        ...valid.spokenContentGate,
        releaseDecision: "passed",
      },
    }).success).toBe(false);
    expect(t2aAudioQualitySchema.safeParse({
      ...valid,
      spokenContentGate: {
        ...valid.spokenContentGate,
        independentIpa: {
          ...valid.spokenContentGate.independentIpa,
          phaseDocumentSha256: "not-a-bound-sha256",
        },
      },
    }).success).toBe(false);

    const otherAudioSha256 = "a".repeat(64);
    const otherPhase = measuredIndependentIpaPhase(otherAudioSha256);
    expect(() => deriveT2aSpokenContentGate({
      dialogueEvaluation: measuredDialogue(),
      authorityAudioSha256: AUDIO_SHA256,
      phaseDocumentSha256: IPA_PHASE_DOCUMENT_SHA256,
      independentIpaPhase: otherPhase,
    })).toThrow(/Audio-Authority/u);
    const otherGate = deriveT2aSpokenContentGate({
      dialogueEvaluation: measuredDialogue(),
      authorityAudioSha256: otherAudioSha256,
      phaseDocumentSha256: IPA_PHASE_DOCUMENT_SHA256,
      independentIpaPhase: otherPhase,
    });
    expect(t2aAudioQualitySchema.safeParse({
      ...valid,
      spokenContentGate: otherGate,
    }).success).toBe(false);
  });

  it("marks every development measurement as unattested and never changes sealed eligibility", () => {
    const measured = measuredAudio();
    expect(bindT2aAudioQualityClaimScope(measured, "sealed-release")).toBe(measured);
    const development = bindT2aAudioQualityClaimScope(measured, "development");
    expect(development.ia2vEligibility).toEqual({
      schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
      status: "blocked",
      blockers: ["spoken-content-gate-not-passed", "development-runtime-unattested"],
    });
    expect(bindT2aAudioQualityClaimScope(development, "development")).toEqual(development);

    const technicallyBlocked = deriveT2aIa2vEligibility({
      ...measured,
      pcm: { ...measured.pcm, fullScaleClippedSamples: 1 },
    });
    expect(bindT2aIa2vEligibilityClaimScope(technicallyBlocked, "development")).toMatchObject({
      status: "blocked",
      blockers: [
        "full-scale-clipping-detected",
        "spoken-content-gate-not-passed",
        "development-runtime-unattested",
      ],
    });
  });

  it("blocks audio beyond the bounded dialogue-analysis window", () => {
    const base = measuredAudio();
    const longAudio: T2aMeasuredAudioQuality = {
      ...base,
      sourceSnapshot: {
        ...base.sourceSnapshot,
        byteLength: 2_976_044,
      },
      wav: {
        ...base.wav,
        sampleFrames: 1_488_000,
        durationSeconds: 31,
      },
      pcm: {
        ...base.pcm,
        totalSamples: 1_488_000,
      },
    };
    longAudio.ia2vEligibility = deriveT2aIa2vEligibility(longAudio);

    expect(t2aAudioQualitySchema.parse(longAudio).ia2vEligibility).toEqual({
      schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
      status: "blocked",
      blockers: ["duration-exceeds-dialogue-window", "spoken-content-gate-not-passed"],
    });
  });

  it("derives every technical IA2V blocker from bound facts", () => {
    const dialogue = measuredDialogue();
    const degradedDialogue: T2aAudioDialogueEvaluation = {
      ...dialogue,
      status: "insufficient",
      blockerCode: "alignment-insufficient",
      error: "Ausrichtung reicht nicht aus.",
      detectedLanguage: "en",
      expectedWordCount: 2,
      recognizedWordCount: 2,
      wordErrorRate: 0.5,
      substitutions: 1,
      rawAsrContentGate: {
        ...dialogue.rawAsrContentGate,
        status: "failed",
        exactTokenMatch: false,
        expectedNormalizedWords: ["hallo", "welt"],
        recognizedNormalizedWords: ["hallo", "heute"],
        substitutedWords: [{
          expectedIndex: 1,
          recognizedIndex: 1,
          expectedWord: "welt",
          recognizedWord: "heute",
        }],
      },
      guidedAlignedWordCount: 1,
      guidedWordCoverage: 0.5,
      usableAlignedWordCount: 1,
      usableGuidedWordCoverage: 0.5,
      medianGuidedWordProbability: 0.2,
      p10GuidedWordProbability: 0.2,
      lowConfidenceAlignedWords: 1,
      alignmentStatus: "insufficient",
      alignmentError: "Ausrichtung reicht nicht aus.",
      guidedWords: [{ ...dialogue.guidedWords[0], probability: 0.2 }],
    };
    const base = measuredAudio(degradedDialogue);
    const degraded: T2aMeasuredAudioQuality = {
      ...base,
      pcm: {
        ...base.pcm,
        samplePeakLinear: 1,
        samplePeakDbfs: 0,
        fullScaleClippedSamples: 1,
        fullScaleClippedRatio: 1 / 48_000,
      },
      loudness: { ...base.loudness, truePeakDbtp: 0.1 },
    };
    degraded.ia2vEligibility = deriveT2aIa2vEligibility(degraded);

    expect(t2aAudioQualitySchema.parse(degraded).ia2vEligibility).toEqual({
      schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
      status: "blocked",
      blockers: [
        "full-scale-clipping-detected",
        "sample-peak-ceiling-exceeded",
        "true-peak-above-zero-dbtp",
        "dialogue-not-measured",
        "detected-language-not-de",
        "raw-asr-content-gate-not-passed",
        "word-error-rate-not-zero",
        "word-edit-counts-not-zero",
        "spoken-content-gate-not-passed",
        "guided-word-coverage-incomplete",
        "usable-guided-word-coverage-incomplete",
        "low-confidence-aligned-words-present",
        "alignment-not-measured",
      ],
    });
  });

  it("binds PCM algebra, the one-LSB ceiling tolerance, and derived eligibility", () => {
    const valid = measuredAudio();
    expect(t2aAudioQualitySchema.safeParse({
      ...valid,
      pcm: { ...valid.pcm, totalSamples: 47_999 },
    }).success).toBe(false);
    expect(t2aAudioQualitySchema.safeParse({
      ...valid,
      pcm: {
        ...valid.pcm,
        fullScaleClippedSamples: 48_001,
        fullScaleClippedRatio: 1,
      },
    }).success).toBe(false);
    expect(t2aAudioQualitySchema.safeParse({
      ...valid,
      pcm: { ...valid.pcm, samplePeakDbfs: -7 },
    }).success).toBe(false);
    expect(t2aAudioQualitySchema.safeParse({
      ...valid,
      policy: { ...valid.policy, pcm16LsbToleranceLinear: PCM16_LSB_LINEAR * 2 },
    }).success).toBe(false);
    expect(t2aAudioQualitySchema.safeParse({
      ...valid,
      pcm: {
        ...valid.pcm,
        samplePeakLinear: 0.500_001,
        samplePeakDbfs: 20 * Math.log10(0.500_001),
      },
    }).success).toBe(false);
    expect(t2aAudioQualitySchema.safeParse({
      ...valid,
      ia2vEligibility: {
        schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
        status: "blocked",
        blockers: ["sample-peak-ceiling-exceeded"],
      },
    }).success).toBe(false);

    const firstPcmStepAboveCeiling = Math.ceil(
      valid.policy.peakCeilingLinear / PCM16_LSB_LINEAR,
    ) * PCM16_LSB_LINEAR;
    const withinTolerance = measuredAudio(measuredDialogue(), {
      pcm: {
        ...valid.pcm,
        samplePeakLinear: firstPcmStepAboveCeiling,
        samplePeakDbfs: 20 * Math.log10(firstPcmStepAboveCeiling),
      },
    });
    withinTolerance.ia2vEligibility = deriveT2aIa2vEligibility(withinTolerance);
    expect(t2aAudioQualitySchema.parse(withinTolerance).ia2vEligibility).toMatchObject({
      status: "blocked",
      blockers: ["spoken-content-gate-not-passed"],
    });

    const beyondTolerancePeak = firstPcmStepAboveCeiling + PCM16_LSB_LINEAR;
    const beyondTolerance = measuredAudio(measuredDialogue(), {
      pcm: {
        ...valid.pcm,
        samplePeakLinear: beyondTolerancePeak,
        samplePeakDbfs: 20 * Math.log10(beyondTolerancePeak),
      },
    });
    beyondTolerance.ia2vEligibility = deriveT2aIa2vEligibility(beyondTolerance);
    expect(t2aAudioQualitySchema.parse(beyondTolerance).ia2vEligibility).toMatchObject({
      status: "blocked",
      blockers: ["sample-peak-ceiling-exceeded", "spoken-content-gate-not-passed"],
    });
  });

  it("rejects dialogue counters, usability, and quantiles that contradict word facts", () => {
    const valid = measuredAudio();
    const lowConfidenceCounterLie = {
      ...valid,
      dialogueEvaluation: {
        ...valid.dialogueEvaluation,
        medianGuidedWordProbability: 0.2,
        p10GuidedWordProbability: 0.2,
        lowConfidenceAlignedWords: 0,
        guidedWords: [{ ...valid.dialogueEvaluation.guidedWords[0], probability: 0.2 }],
      },
    };
    expect(t2aAudioQualitySchema.safeParse(lowConfidenceCounterLie).success).toBe(false);

    const falseUsability = {
      ...valid,
      dialogueEvaluation: {
        ...valid.dialogueEvaluation,
        usableAlignedWordCount: 0,
        usableGuidedWordCoverage: 0,
        guidedWords: [{ ...valid.dialogueEvaluation.guidedWords[0], usable: false }],
      },
    };
    expect(t2aAudioQualitySchema.safeParse(falseUsability).success).toBe(false);

    const zeroWindowUsability = {
      ...valid,
      dialogueEvaluation: {
        ...valid.dialogueEvaluation,
        guidedWords: [{
          ...valid.dialogueEvaluation.guidedWords[0],
          endSeconds: valid.dialogueEvaluation.guidedWords[0].startSeconds,
          usable: true,
        }],
      },
    };
    expect(t2aAudioQualitySchema.safeParse(zeroWindowUsability).success).toBe(false);

    const quantileLie = {
      ...valid,
      dialogueEvaluation: {
        ...valid.dialogueEvaluation,
        medianGuidedWordProbability: 0.8,
      },
    };
    expect(t2aAudioQualitySchema.safeParse(quantileLie).success).toBe(false);

    const utf16WordOverflow = {
      ...valid,
      dialogueEvaluation: {
        ...valid.dialogueEvaluation,
        guidedWords: [{ ...valid.dialogueEvaluation.guidedWords[0], word: "😀".repeat(80) }],
      },
    };
    expect(t2aAudioQualitySchema.safeParse(utf16WordOverflow).success).toBe(false);

    const unsafeTokenId = {
      ...valid,
      dialogueEvaluation: {
        ...valid.dialogueEvaluation,
        guidedWords: [{
          ...valid.dialogueEvaluation.guidedWords[0],
          tokenIds: [Number.MAX_SAFE_INTEGER + 1],
        }],
      },
    };
    expect(t2aAudioQualitySchema.safeParse(unsafeTokenId).success).toBe(false);

    const hiddenPrefixInsertion = {
      ...valid,
      dialogueEvaluation: {
        ...valid.dialogueEvaluation,
        recognizedWordCount: 2,
        recognizedTranscript: "nochmal Hallo",
        wordErrorRate: 0,
        rawAsrContentGate: {
          ...valid.dialogueEvaluation.rawAsrContentGate,
          recognizedNormalizedWords: ["nochmal", "hallo"],
        },
      },
    };
    expect(t2aAudioQualitySchema.safeParse(hiddenPrefixInsertion).success).toBe(false);

    const inventedPhonemePass = {
      ...valid,
      dialogueEvaluation: {
        ...valid.dialogueEvaluation,
        phonemeVerification: {
          status: "measured",
          method: "orthographic-homophone-guess",
          reason: null,
        },
      },
    };
    expect(t2aAudioQualitySchema.safeParse(inventedPhonemePass).success).toBe(false);
  });

  it("rejects unknown fields and keeps failures structurally blocked", () => {
    const failure = {
      schemaVersion: T2A_AUDIO_QUALITY_SCHEMA_VERSION,
      mediaKind: "audio",
      analysisKind: "t2a-audio-qa",
      analysisStatus: "failed",
      error: { code: "audio-silent", message: "Stille ist nicht auswertbar." },
      ia2vEligibility: {
        schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
        status: "blocked",
        blockers: ["analysis-failed"],
      },
    };
    expect(t2aAudioQualitySchema.parse(failure)).toEqual(failure);
    expect(t2aAudioQualitySchema.safeParse({ ...failure, unexpected: true }).success).toBe(false);
    expect(t2aAudioQualitySchema.safeParse({
      ...failure,
      ia2vEligibility: { ...failure.ia2vEligibility, blockers: ["audio-silent"] },
    }).success).toBe(false);
  });
});
