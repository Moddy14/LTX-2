import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it, vi } from "vitest";

import { publicT2aAudioEvaluatorCapabilitySchema } from "../shared/healthPublic.js";
import {
  t2aAudioPublicAnalysisRecordSchema,
  t2aAudioPublicQualitySchema,
} from "../shared/t2aAudioPublic.js";
import {
  formatAudioDb,
  formatAudioDuration,
  formatAudioPercent,
  presentT2aAudioAnalysis,
  T2A_IA2V_BLOCKER_LABELS,
} from "../src/audioQualityPresentation.js";
import { AudioQualityPanel } from "../src/components/AudioQualityPanel.js";

const sealedCapability = publicT2aAudioEvaluatorCapabilitySchema.parse({
  status: "authoritative",
  claimScope: "sealed-release",
  blockerCode: "none",
  message: "Attestierter Evaluator ist messbereit.",
  productGo: "blocked",
  measurementReady: true,
});

const developmentCapability = publicT2aAudioEvaluatorCapabilitySchema.parse({
  status: "development-measurement",
  claimScope: "development",
  blockerCode: "development-runtime-unattested",
  message: "Entwicklungs-Messung ist verfügbar, aber nicht attestiert.",
  productGo: "blocked",
  measurementReady: true,
});

function measuredRecord() {
  return t2aAudioPublicAnalysisRecordSchema.parse({
    schemaVersion: "ltx-studio-t2a-audio-analysis-public.v4",
    analysisKind: "t2a-audio-qa",
    mediaKind: "audio",
    outputName: "dialog-v3.wav",
    outputRevisionToken: `eq1_${"r".repeat(32)}`,
    jobId: "11111111-1111-4111-8111-111111111111",
    analysisId: "22222222-2222-4222-8222-222222222222",
    claimScope: "sealed-release",
    attempt: 1,
    status: "completed",
    progress: 100,
    createdAt: "2026-08-26T08:00:00.000Z",
    startedAt: "2026-08-26T08:00:01.000Z",
    finishedAt: "2026-08-26T08:00:05.000Z",
    updatedAt: "2026-08-26T08:00:05.000Z",
    error: null,
    result: {
      schemaVersion: "ltx-studio-t2a-audio-quality-public.v4",
      mediaKind: "audio",
      analysisKind: "t2a-audio-qa",
      analysisStatus: "measured",
      wav: {
        container: "RIFF/WAVE",
        codec: "pcm_s16le",
        formatTag: 1,
        bitsPerSample: 16,
        channels: 2,
        sampleRateHz: 48_000,
        sampleFrames: 960_000,
        durationSeconds: 20,
      },
      pcm: {
        totalSamples: 1_920_000,
        samplePeakLinear: 0.707,
        samplePeakDbfs: -3.01,
        fullScaleClippedSamples: 0,
        fullScaleClippedRatio: 0,
      },
      loudness: {
        method: "ffmpeg-ebur128-peak-true.v1",
        integratedLufs: -18.45,
        truePeakDbtp: -2.72,
      },
      dialogue: {
        status: "measured",
        blockerCode: "none",
        error: null,
        detectedLanguage: "de",
        expectedWordCount: 43,
        recognizedWordCount: 43,
        wordErrorRate: 0,
        substitutions: 0,
        deletions: 0,
        insertions: 0,
        guidedAlignedWordCount: 43,
        guidedWordCoverage: 1,
        usableAlignedWordCount: 43,
        usableGuidedWordCoverage: 1,
        medianGuidedWordProbability: 0.991,
        p10GuidedWordProbability: 0.873,
        lowConfidenceAlignedWords: 0,
        alignmentStatus: "measured",
        alignmentError: null,
        timePrecisionMilliseconds: 20,
      },
      policy: {
        peakCeilingDbfs: -3,
        peakCeilingLinear: 0.7079457843841379,
        pcm16LsbToleranceLinear: 1 / 32_768,
      },
      independentIpa: {
        evaluationMode: "measurement-only",
        status: "measured",
        targetConditioned: false,
        reasonCode: null,
        method: "xlsr53-espeak-cv-free-ctc-greedy.v1",
        modelFingerprint: "f".repeat(64),
        decodedIpa: "h a l o",
        tokenCount: 4,
        unknownTokenCount: 0,
        specialTokenCount: 0,
        blankFrameRatio: 0.625,
        releaseQualification: {
          status: "not-qualified",
          requiredPositiveHoldoutCases: 300,
          requiredNegativeHoldoutCases: 300,
          maximumFalseAccepts: 0,
        },
      },
      pronunciationMeasurement: {
        status: "measured",
        sourcePhaseStatus: "measured",
        method: "pinned-espeak-reference-vs-independent-ipa-raw-edit.v1",
        evaluationMode: "measurement-only",
        substitutions: 1,
        deletions: 2,
        insertions: 1,
        editDistance: 4,
        referenceTokenCount: 40,
        hypothesisTokenCount: 39,
        normalizedPhoneErrorRate: 0.1,
      },
      ia2vEligibility: {
        schemaVersion: "t2a-ia2v-eligibility.v2",
        status: "blocked",
        blockers: ["spoken-content-gate-not-passed"],
      },
    },
  });
}

function developmentMeasuredRecord() {
  const measured = measuredRecord();
  return t2aAudioPublicAnalysisRecordSchema.parse({
    ...measured,
    claimScope: "development",
    result: {
      ...measured.result,
      ia2vEligibility: {
        schemaVersion: "t2a-ia2v-eligibility.v2",
        status: "blocked",
        blockers: ["spoken-content-gate-not-passed", "development-runtime-unattested"],
      },
    },
  });
}

describe("T2A audio quality presentation", () => {
  it("formats public measurements consistently in German", () => {
    expect(formatAudioPercent(0.069767, 1)).toBe("7,0 %");
    expect(formatAudioDb(-3.01, "dBFS", 2)).toBe("-3,01 dBFS");
    expect(formatAudioDuration(20)).toBe("20,00 s");
    expect(formatAudioDb(null, "LUFS")).toBe("Nicht gemessen");
  });

  it("maps terminal, active and missing records without inventing measurements", () => {
    const measured = measuredRecord();
    expect(presentT2aAudioAnalysis(measured)).toMatchObject({
      state: "measured",
      tone: "danger",
      label: "Audio-Messung abgeschlossen · Vorfilter gesperrt",
      canRetry: true,
    });
    expect(presentT2aAudioAnalysis({ ...measured, status: "running", progress: 37, result: null }))
      .toMatchObject({ state: "running", progress: 37, measurement: null, canRetry: false });
    expect(presentT2aAudioAnalysis(null)).toMatchObject({
      state: "idle",
      measurement: null,
      canRetry: false,
    });
  });

  it("renders only audio measurements and keeps IA2V handoff visibly disabled", () => {
    const markup = renderToStaticMarkup(createElement(AudioQualityPanel, {
      outputName: "dialog-v3.wav",
      analysis: measuredRecord(),
      capability: sealedCapability,
      onStart: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    }));

    expect(markup).toContain("Audio-Qualitätsanalyse");
    expect(markup).toContain("Dialogprüfung");
    expect(markup).toContain("Erkannte / erwartete Wörter");
    expect(markup).toContain("43 / 43");
    expect(markup).toContain("Wortfehlerrate (WER)");
    expect(markup).toContain("S / D / I");
    expect(markup).toContain("Geführte Wortdeckung");
    expect(markup).toContain("Nutzbare Wortdeckung");
    expect(markup).toContain("Konfidenz Median / P10");
    expect(markup).toContain("20,00 s");
    expect(markup).toContain("-3,01 dBFS");
    expect(markup).toContain("-3,0 dBFS");
    expect(markup).toContain("-2,7 dBTP");
    expect(markup).toContain("-18,5 LUFS");
    expect(markup).toContain("Vollpegel-Samples");
    expect(markup).toContain("Unabhängige Lautbeobachtung · nur Messbetrieb");
    expect(markup).toContain("Zieltextfreie CTC-Rohbeobachtung");
    expect(markup).toContain("Gemessen · keine Freigabe");
    expect(markup).toContain("Nein · zieltextfrei");
    expect(markup).toContain("h a l o");
    expect(markup).toContain("4 / 0 / 0");
    expect(markup).toContain("62,5 %");
    expect(markup).toContain("Nicht qualifiziert");
    expect(markup).toContain("300 positiv / 300 negativ / 0 False Accepts");
    expect(markup).toContain("Lautabgleich · nur Messbetrieb");
    expect(markup).toContain("target-free Beobachtung");
    expect(markup).toContain("gepinntes deutsches G2P");
    expect(markup).toContain("Audioaussprache und NICHT die Lippen-Synchronität");
    expect(markup).toContain("Roh-PER ist unkalibriert und erteilt keine Freigabe");
    expect(markup).toContain("Roh-PER (unkalibriert)");
    expect(markup).toContain("10,0 %");
    expect(markup).toContain("Laut-S / D / I");
    expect(markup).toContain("1 / 2 / 1");
    expect(markup).toContain("40 / 39");
    expect(markup).toContain("Technischer IA2V-Vorfilter gesperrt");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Audio für IA2V bereitstellen<\/button>/u);
    expect(markup).toContain("Der technische Vorfilter allein aktiviert die Weitergabe nicht.");
    expect(markup.toLocaleLowerCase("de-DE")).not.toMatch(/visem|gesicht|product-go|10\/10|sota/u);
    expect(markup).not.toMatch(/Lippen-Synchronität[^<]*(bestanden|perfekt|freigegeben)/u);
  });

  it("renders insufficient and failed IPA phases without fabricating measurement values", () => {
    const measured = measuredRecord();
    if (measured.result?.analysisStatus !== "measured") {
      throw new Error("Expected measured fixture");
    }
    const common = {
      evaluationMode: "measurement-only" as const,
      targetConditioned: false as const,
      method: null,
      modelFingerprint: null,
      decodedIpa: null,
      tokenCount: null,
      unknownTokenCount: null,
      specialTokenCount: null,
      blankFrameRatio: null,
      releaseQualification: measured.result.independentIpa.releaseQualification,
    };
    const insufficient = t2aAudioPublicAnalysisRecordSchema.parse({
      ...measured,
      result: {
        ...measured.result,
        independentIpa: {
          ...common,
          status: "insufficient",
          reasonCode: "duration-exceeds-independent-ipa-window",
        },
      },
    });
    const failed = t2aAudioPublicAnalysisRecordSchema.parse({
      ...measured,
      result: {
        ...measured.result,
        independentIpa: {
          ...common,
          status: "failed",
          reasonCode: "independent-ipa-runner-failed",
        },
      },
    });
    const insufficientMarkup = renderToStaticMarkup(createElement(AudioQualityPanel, {
      outputName: insufficient.outputName,
      analysis: insufficient,
      capability: sealedCapability,
      onStart: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    }));
    const failedMarkup = renderToStaticMarkup(createElement(AudioQualityPanel, {
      outputName: failed.outputName,
      analysis: failed,
      capability: sealedCapability,
      onStart: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    }));

    expect(insufficientMarkup).toContain("Nicht ausreichend · keine Freigabe");
    expect(insufficientMarkup).toContain("überschreitet das unabhängige IPA-Messfenster");
    expect(failedMarkup).toContain("Fehlgeschlagen · keine Freigabe");
    expect(failedMarkup).toContain("Der isolierte IPA-Messlauf ist fehlgeschlagen.");
    for (const markup of [insufficientMarkup, failedMarkup]) {
      expect(markup).toContain("Wortfehlerrate (WER)");
      expect(markup).toContain("S / D / I");
      expect(markup).toContain("Nicht gemessen");
      expect(markup).toContain("300 positiv / 300 negativ / 0 False Accepts");
      expect(markup).not.toContain("h a l o");
      expect(markup).not.toContain("f".repeat(64));
      expect(markup).not.toContain("audio-quality__status--success");
    }
  });

  it("renders unavailable adjudication and legacy missing evidence as not measured", () => {
    const measured = measuredRecord();
    if (measured.result?.analysisStatus !== "measured") {
      throw new Error("Expected measured fixture");
    }
    const unavailable = t2aAudioPublicAnalysisRecordSchema.parse({
      ...measured,
      result: {
        ...measured.result,
        pronunciationMeasurement: {
          status: "unavailable",
          sourcePhaseStatus: "failed",
          method: "pinned-espeak-reference-vs-independent-ipa-raw-edit.v1",
          evaluationMode: "measurement-only",
          substitutions: null,
          deletions: null,
          insertions: null,
          editDistance: null,
          referenceTokenCount: null,
          hypothesisTokenCount: null,
          normalizedPhoneErrorRate: null,
        },
      },
    });
    const legacy = t2aAudioPublicAnalysisRecordSchema.parse({
      ...measured,
      result: {
        ...measured.result,
        pronunciationMeasurement: null,
      },
    });
    const render = (analysis: typeof unavailable) => renderToStaticMarkup(createElement(
      AudioQualityPanel,
      {
        outputName: analysis.outputName,
        analysis,
        capability: sealedCapability,
        onStart: vi.fn(async () => undefined),
        onCancel: vi.fn(async () => undefined),
      },
    ));
    const unavailableMarkup = render(unavailable);
    const legacyMarkup = render(legacy);

    expect(unavailableMarkup).toContain('data-pronunciation-status="unavailable"');
    expect(unavailableMarkup).toContain('data-source-phase-status="failed"');
    expect(unavailableMarkup).toContain("Quellphasenstatus");
    expect(unavailableMarkup).toContain("Fehlgeschlagen");
    expect(unavailableMarkup).toContain("pinned-espeak-reference-vs-independent-ipa-raw-edit.v1");
    expect(legacyMarkup).toContain('data-pronunciation-status="not-measured"');
    expect(legacyMarkup).toContain('data-source-phase-status="not-measured"');
    expect(legacyMarkup).not.toContain("pinned-espeak-reference-vs-independent-ipa-raw-edit.v1");
    for (const markup of [unavailableMarkup, legacyMarkup]) {
      expect(markup).toContain("Lautabgleich · nur Messbetrieb");
      expect(markup).toMatch(/data-audio-metric="Roh-PER \(unkalibriert\)"[^]*?<dd>Nicht gemessen<\/dd>/u);
      expect(markup).toMatch(/data-audio-metric="Laut-S \/ D \/ I"[^]*?<dd>Nicht gemessen<\/dd>/u);
      expect(markup).toMatch(/data-audio-metric="Laut-Editdistanz"[^]*?<dd>Nicht gemessen<\/dd>/u);
      expect(markup).toMatch(/data-audio-metric="Referenz- \/ Hypothesentokens"[^]*?<dd>Nicht gemessen<\/dd>/u);
    }
  });

  it("rejects stale versions, release claims and private IPA payload fields", () => {
    const measured = measuredRecord();
    if (measured.result?.analysisStatus !== "measured") {
      throw new Error("Expected measured fixture");
    }
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse({
      ...measured,
      schemaVersion: "ltx-studio-t2a-audio-analysis-public.v3",
    }).success).toBe(false);
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse({
      ...measured,
      result: {
        ...measured.result,
        ia2vEligibility: {
          schemaVersion: "t2a-ia2v-eligibility.v2",
          status: "eligible",
          blockers: [],
        },
      },
    }).success).toBe(false);
    const pronunciation = measured.result.pronunciationMeasurement;
    if (pronunciation?.status !== "measured") {
      throw new Error("Expected measured pronunciation fixture");
    }
    expect(Object.keys(pronunciation).sort()).toEqual([
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
    for (const privatePayload of [
      { targetText: "privater Klartext" },
      { referenceIpaTokens: ["h", "a"] },
      { serverPath: "/private/model" },
      { adjudicationResultSha256: "a".repeat(64) },
      { threshold: 0.2 },
      { passed: true },
      { eligible: true },
      { measurement: { referenceIpaTokens: ["h"] } },
    ]) {
      expect(t2aAudioPublicAnalysisRecordSchema.safeParse({
        ...measured,
        result: {
          ...measured.result,
          pronunciationMeasurement: { ...pronunciation, ...privatePayload },
        },
      }).success).toBe(false);
    }
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse({
      ...measured,
      result: {
        ...measured.result,
        independentIpa: {
          ...measured.result.independentIpa,
          tokens: [{ symbol: "private" }],
          error: { message: "/private/runtime/traceback" },
          serverPath: "/private/model",
        },
      },
    }).success).toBe(false);
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse({
      ...measured,
      result: {
        ...measured.result,
        independentIpa: {
          ...measured.result.independentIpa,
          tokenCount: 4,
          unknownTokenCount: 3,
          specialTokenCount: 2,
        },
      },
    }).success).toBe(false);
  });

  it("rejects an IA2V success claim on every failed public analysis", () => {
    const measured = measuredRecord();
    const failed = {
      ...measured,
      status: "failed",
      error: {
        code: "analysis-failed",
        message: "Audioauswertung fehlgeschlagen.",
      },
      result: {
        schemaVersion: "ltx-studio-t2a-audio-quality-public.v4",
        mediaKind: "audio",
        analysisKind: "t2a-audio-qa",
        analysisStatus: "failed",
        error: {
          code: "internal-error",
          message: "Audioauswertung fehlgeschlagen.",
        },
        ia2vEligibility: {
          schemaVersion: "t2a-ia2v-eligibility.v2",
          status: "eligible",
          blockers: [],
        },
      },
    };

    expect(t2aAudioPublicQualitySchema.safeParse(failed.result).success).toBe(false);
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse(failed).success).toBe(false);
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse({
      ...failed,
      result: {
        ...failed.result,
        ia2vEligibility: {
          schemaVersion: "t2a-ia2v-eligibility.v2",
          status: "blocked",
          blockers: ["sample-peak-ceiling-exceeded"],
        },
      },
    }).success).toBe(false);

    const blockedFailure = {
      ...failed,
      result: {
        ...failed.result,
        ia2vEligibility: {
          schemaVersion: "t2a-ia2v-eligibility.v2",
          status: "blocked",
          blockers: ["analysis-failed"],
        },
      },
    };
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse(blockedFailure).success).toBe(true);
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse({
      ...blockedFailure,
      claimScope: "development",
    }).success).toBe(false);
    expect(t2aAudioPublicAnalysisRecordSchema.safeParse({
      ...blockedFailure,
      claimScope: "development",
      result: {
        ...blockedFailure.result,
        ia2vEligibility: {
          schemaVersion: "t2a-ia2v-eligibility.v2",
          status: "blocked",
          blockers: ["analysis-failed", "development-runtime-unattested"],
        },
      },
    }).success).toBe(true);
  });

  it("keeps development measurements visible without rendering any release or IA2V success claim", () => {
    const development = developmentMeasuredRecord();
    const presentation = presentT2aAudioAnalysis(development);
    const markup = renderToStaticMarkup(createElement(AudioQualityPanel, {
      outputName: development.outputName,
      analysis: development,
      capability: developmentCapability,
      onStart: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    }));

    expect(presentation).toMatchObject({
      state: "measured",
      claimScope: "development",
      tone: "pending",
      label: "Entwicklungs-Messung abgeschlossen · keine Freigabe",
    });
    expect(markup).toContain("ENTWICKLUNGSMESSUNG · nicht attestiert");
    expect(markup).toContain('data-claim-scope="development"');
    expect(markup).toContain("43 / 43");
    expect(markup).toContain("Wortfehlerrate (WER)");
    expect(markup).toContain("Technische Messwerte · IA2V und Product-GO gesperrt");
    expect(markup).toContain(T2A_IA2V_BLOCKER_LABELS["development-runtime-unattested"]);
    expect(markup).toContain("Diese Messung kann weder Product-GO noch IA2V freigeben");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Audio für IA2V bereitstellen<\/button>/u);
    expect(markup).not.toContain("audio-quality__status--success");
    expect(markup).not.toContain("is-eligible");
    expect(markup).not.toContain("Vorfilter bestanden");
  });

  it("keeps the unattested development warning visible while analysis is active", () => {
    const development = developmentMeasuredRecord();
    const running = t2aAudioPublicAnalysisRecordSchema.parse({
      ...development,
      status: "running",
      progress: 42,
      finishedAt: null,
      error: null,
      result: null,
    });
    const markup = renderToStaticMarkup(createElement(AudioQualityPanel, {
      outputName: running.outputName,
      analysis: running,
      capability: developmentCapability,
      onStart: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    }));

    expect(markup).toContain("ENTWICKLUNGSMESSUNG · nicht attestiert");
    expect(markup).toContain("Keine Release-, Product-GO- oder IA2V-Freigabe");
    expect(markup).toContain('role="progressbar"');
    expect(markup).not.toContain("audio-quality__status--success");
    expect(markup).not.toContain("Vorfilter bestanden");
  });

  it("shows every technical blocker in human-readable German", () => {
    const measured = measuredRecord();
    const blocked = t2aAudioPublicAnalysisRecordSchema.parse({
      ...measured,
      result: {
        ...measured.result,
        ia2vEligibility: {
          schemaVersion: "t2a-ia2v-eligibility.v2",
          status: "blocked",
          blockers: [
            "spoken-content-gate-not-passed",
            "sample-peak-ceiling-exceeded",
            "word-error-rate-not-zero",
            "alignment-not-measured",
          ],
        },
      },
    });
    const markup = renderToStaticMarkup(createElement(AudioQualityPanel, {
      outputName: blocked.outputName,
      analysis: blocked,
      capability: sealedCapability,
      onStart: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    }));

    expect(Object.keys(T2A_IA2V_BLOCKER_LABELS)).toHaveLength(17);
    expect(presentT2aAudioAnalysis(blocked)).toMatchObject({
      state: "measured",
      tone: "danger",
      label: "Audio-Messung abgeschlossen · Vorfilter gesperrt",
    });
    expect(markup).toContain("Technischer IA2V-Vorfilter gesperrt");
    expect(markup).toContain("Audio-Messung abgeschlossen · Vorfilter gesperrt");
    expect(markup).toContain(T2A_IA2V_BLOCKER_LABELS["sample-peak-ceiling-exceeded"]);
    expect(markup).toContain(T2A_IA2V_BLOCKER_LABELS["word-error-rate-not-zero"]);
    expect(markup).toContain(T2A_IA2V_BLOCKER_LABELS["alignment-not-measured"]);
  });

  it("renders analysis failures without rendering fabricated signal metrics", () => {
    const measured = measuredRecord();
    const failed = t2aAudioPublicAnalysisRecordSchema.parse({
      ...measured,
      status: "failed",
      error: {
        code: "analysis-failed",
        message: "Audioauswertung fehlgeschlagen.",
      },
      result: {
        schemaVersion: "ltx-studio-t2a-audio-quality-public.v4",
        mediaKind: "audio",
        analysisKind: "t2a-audio-qa",
        analysisStatus: "failed",
        error: {
          code: "loudness-measurement-failed",
          message: "True-Peak-Messung nicht verfügbar.",
        },
        ia2vEligibility: {
          schemaVersion: "t2a-ia2v-eligibility.v2",
          status: "blocked",
          blockers: ["analysis-failed"],
        },
      },
    });
    const markup = renderToStaticMarkup(createElement(AudioQualityPanel, {
      outputName: failed.outputName,
      analysis: failed,
      capability: sealedCapability,
      onStart: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    }));

    expect(markup).toContain("Audioanalyse fehlgeschlagen");
    expect(markup).toContain("True-Peak-Messung nicht verfügbar.");
    expect(markup).not.toContain("Vollpegel-Samples");
    expect(markup).toContain(T2A_IA2V_BLOCKER_LABELS["analysis-failed"]);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Audio für IA2V bereitstellen<\/button>/u);
    expect(markup).toContain("Audio erneut analysieren");
  });

  it("announces active progress and exposes the cancel action semantically", () => {
    const measured = measuredRecord();
    const running = t2aAudioPublicAnalysisRecordSchema.parse({
      ...measured,
      status: "running",
      progress: 42,
      startedAt: "2026-08-26T08:00:01.000Z",
      finishedAt: null,
      error: null,
      result: null,
    });
    const markup = renderToStaticMarkup(createElement(AudioQualityPanel, {
      outputName: running.outputName,
      analysis: running,
      capability: sealedCapability,
      onStart: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    }));

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="42"');
    expect(markup).toContain("Audioanalyse läuft");
    expect(markup).toContain("Audioanalyse abbrechen");
    expect(markup).not.toContain("Audio für IA2V bereitstellen");
  });

  it("disables starting when health does not attest measurement readiness and shows the safe reason", () => {
    const capability = publicT2aAudioEvaluatorCapabilitySchema.parse({
      status: "blocked",
      claimScope: null,
      blockerCode: "development-opt-in-required",
      message: "Entwicklungs-Messungen sind nicht aktiviert.",
      productGo: "blocked",
      measurementReady: false,
    });
    const markup = renderToStaticMarkup(createElement(AudioQualityPanel, {
      outputName: "dialog-v3.wav",
      analysis: null,
      capability,
      onStart: vi.fn(async () => undefined),
      onCancel: vi.fn(async () => undefined),
    }));

    expect(markup).toContain("Audioanalyse nicht startbereit.");
    expect(markup).toContain("Entwicklungs-Messungen sind nicht aktiviert.");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="[^"]+"[^>]*>.*Audio analysieren<\/button>/u);
  });
});
