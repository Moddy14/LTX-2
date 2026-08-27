import type {
  PublicIndependentIpaMeasurement,
  PublicPronunciationMeasurement,
  T2aAudioPublicAnalysisRecord,
  T2aAudioPublicQuality,
} from "../shared/t2aAudioPublic.js";

export type MeasuredT2aAudioQuality = Extract<
  T2aAudioPublicQuality,
  { analysisStatus: "measured" }
>;
export type PublicT2aIa2vEligibility = T2aAudioPublicQuality["ia2vEligibility"];
export type PublicT2aIa2vBlockerCode = PublicT2aIa2vEligibility["blockers"][number];
export type PublicIndependentIpaReasonCode = Exclude<
  PublicIndependentIpaMeasurement["reasonCode"],
  null
>;
export type PublicT2aPronunciationMeasurement = PublicPronunciationMeasurement;

export type AudioAnalysisPresentation = {
  state: "idle" | "queued" | "running" | "measured" | "failed" | "cancelled";
  claimScope: T2aAudioPublicAnalysisRecord["claimScope"] | null;
  label: string;
  tone: "neutral" | "pending" | "success" | "danger";
  progress: number | null;
  error: string | null;
  measurement: MeasuredT2aAudioQuality | null;
  eligibility: T2aAudioPublicQuality["ia2vEligibility"] | null;
  canRetry: boolean;
};

export const T2A_IA2V_BLOCKER_LABELS: Record<PublicT2aIa2vBlockerCode, string> = {
  "analysis-failed": "Die Audioanalyse ist fehlgeschlagen.",
  "full-scale-clipping-detected": "Das PCM-Signal enthält Samples am digitalen Vollpegel.",
  "sample-peak-ceiling-exceeded": "Der Sample-Peak überschreitet die gespeicherte Grenze.",
  "true-peak-above-zero-dbtp": "Der gemessene True Peak liegt über 0 dBTP.",
  "duration-exceeds-dialogue-window": "Die Audiodauer überschreitet das geprüfte Dialogfenster.",
  "dialogue-not-measured": "Die Worttreue wurde nicht vollständig gemessen.",
  "dialogue-model-unverified": "Das Modell für die Dialogmessung war nicht verifiziert.",
  "detected-language-not-de": "Die erkannte Sprache ist nicht Deutsch.",
  "raw-asr-content-gate-not-passed": "Das unabhängige Raw-ASR-Transkript stimmt nicht wortgenau mit dem Zieltext überein.",
  "word-error-rate-not-zero": "Die Wortfehlerrate ist nicht null.",
  "word-edit-counts-not-zero": "Die Messung enthält Ersetzungen, Löschungen oder Einfügungen.",
  "spoken-content-gate-not-passed": "Die unabhängige Inhaltsprüfung ist nur eine Messung und noch nicht durch den kalibrierten Holdout freigegeben.",
  "guided-word-coverage-incomplete": "Nicht alle erwarteten Wörter wurden zeitlich ausgerichtet.",
  "usable-guided-word-coverage-incomplete": "Nicht alle erwarteten Wörter besitzen eine nutzbare Ausrichtung.",
  "low-confidence-aligned-words-present": "Mindestens ein ausgerichtetes Wort hat eine niedrige Konfidenz.",
  "alignment-not-measured": "Die zeitliche Wortausrichtung wurde nicht gemessen.",
  "development-runtime-unattested": "Die Entwicklungs-Runtime ist nicht attestiert; Product-GO und IA2V bleiben gesperrt.",
};

export const INDEPENDENT_IPA_REASON_LABELS: Record<
  PublicIndependentIpaReasonCode,
  string
> = {
  "duration-exceeds-independent-ipa-window": "Die Audiodauer überschreitet das unabhängige IPA-Messfenster.",
  "arguments-invalid": "Die gebundenen Argumente der Lautmessung sind ungültig.",
  "audio-snapshot-invalid": "Der gebundene Audio-Snapshot ist ungültig.",
  "audio-hash-mismatch": "Der Audio-Snapshot stimmt nicht mit seiner gebundenen Prüfsumme überein.",
  "wav-container-invalid": "Der Audio-Snapshot ist kein gültiger RIFF/WAVE-Container.",
  "wav-format-unsupported": "Das WAV-Format wird von der Lautmessung nicht unterstützt.",
  "wav-data-invalid": "Die PCM-Nutzdaten des WAV-Signals sind ungültig.",
  "audio-silent": "Das Audiosignal enthält keine messbare Lautfolge.",
  "ffmpeg-unverified": "Die Normalisierungs-Runtime konnte nicht verifiziert werden.",
  "offline-runtime-unverified": "Die Offline-Isolation der Lautmessung konnte nicht verifiziert werden.",
  "independent-ipa-unverified": "Das unabhängige IPA-Modell konnte nicht verifiziert werden.",
  "independent-ipa-normalization-failed": "Die Audio-Normalisierung für die Lautmessung ist fehlgeschlagen.",
  "independent-ipa-failed": "Die unabhängige Lautmessung ist fehlgeschlagen.",
  "independent-ipa-invalid": "Die unabhängige Lautmessung lieferte ungültige Messdaten.",
  "independent-ipa-runner-failed": "Der isolierte IPA-Messlauf ist fehlgeschlagen.",
  "internal-error": "Die unabhängige Lautmessung ist intern fehlgeschlagen.",
};

function decimal(value: number, digits: number): string {
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  });
}

export function formatAudioDecimal(value: number | null, digits = 2): string {
  return value === null ? "Nicht gemessen" : decimal(value, digits);
}

export function formatAudioPercent(value: number | null, digits = 1): string {
  return value === null ? "Nicht gemessen" : `${decimal(value * 100, digits)} %`;
}

export function formatAudioDb(
  value: number | null,
  unit: "dBFS" | "dBTP" | "LUFS",
  digits = 1,
): string {
  return value === null ? "Nicht gemessen" : `${decimal(value, digits)} ${unit}`;
}

export function formatAudioDuration(value: number | null): string {
  return value === null ? "Nicht gemessen" : `${decimal(value, 2)} s`;
}

export function formatAudioInteger(value: number): string {
  return value.toLocaleString("de-DE");
}

export function audioAlignmentLabel(
  status: MeasuredT2aAudioQuality["dialogue"]["alignmentStatus"],
): string {
  const labels = {
    measured: "Gemessen",
    insufficient: "Nicht ausreichend",
    failed: "Fehlgeschlagen",
    "not-applicable": "Nicht anwendbar",
  } as const;
  return labels[status];
}

export function audioDialogueStatusLabel(
  status: MeasuredT2aAudioQuality["dialogue"]["status"],
): string {
  const labels = {
    measured: "Gemessen",
    insufficient: "Nicht ausreichend",
    failed: "Fehlgeschlagen",
    "not-applicable": "Nicht anwendbar",
    "not-available": "Nicht verfügbar",
  } as const;
  return labels[status];
}

export function independentIpaStatusLabel(
  status: PublicIndependentIpaMeasurement["status"],
): string {
  const labels = {
    measured: "Gemessen · keine Freigabe",
    insufficient: "Nicht ausreichend · keine Freigabe",
    failed: "Fehlgeschlagen · keine Freigabe",
  } as const;
  return labels[status];
}

export function independentIpaReasonLabel(
  reasonCode: PublicIndependentIpaMeasurement["reasonCode"],
): string {
  return reasonCode === null
    ? "Kein technischer Fehler gemeldet."
    : INDEPENDENT_IPA_REASON_LABELS[reasonCode];
}

export function pronunciationMeasurementStatusLabel(
  measurement: PublicPronunciationMeasurement | null,
): string {
  return measurement?.status === "measured" ? "Gemessen · Rohwert" : "Nicht gemessen";
}

export function pronunciationSourcePhaseStatusLabel(
  measurement: PublicPronunciationMeasurement | null,
): string {
  if (measurement === null) return "Nicht gemessen";
  const labels = {
    measured: "Gemessen",
    insufficient: "Nicht ausreichend",
    failed: "Fehlgeschlagen",
  } as const;
  return labels[measurement.sourcePhaseStatus];
}

export function presentT2aAudioAnalysis(
  analysis: T2aAudioPublicAnalysisRecord | null,
): AudioAnalysisPresentation {
  if (!analysis) {
    return {
      state: "idle",
      claimScope: null,
      label: "Nicht analysiert",
      tone: "neutral",
      progress: null,
      error: null,
      measurement: null,
      eligibility: null,
      canRetry: false,
    };
  }

  if (analysis.status === "queued" || analysis.status === "running") {
    return {
      state: analysis.status,
      claimScope: analysis.claimScope,
      label: analysis.status === "queued" ? "Wartet auf Audioanalyse" : "Audioanalyse läuft",
      tone: "pending",
      progress: analysis.progress,
      error: null,
      measurement: null,
      eligibility: null,
      canRetry: false,
    };
  }

  if (analysis.status === "cancelled") {
    return {
      state: "cancelled",
      claimScope: analysis.claimScope,
      label: "Audioanalyse abgebrochen",
      tone: "danger",
      progress: analysis.progress,
      error: analysis.error?.message ?? "Die Audioanalyse wurde abgebrochen.",
      measurement: null,
      eligibility: null,
      canRetry: true,
    };
  }

  if (analysis.status === "failed") {
    return {
      state: "failed",
      claimScope: analysis.claimScope,
      label: "Audioanalyse fehlgeschlagen",
      tone: "danger",
      progress: analysis.progress,
      error: analysis.result?.analysisStatus === "failed"
        ? analysis.result.error.message
        : analysis.error?.message ?? "Die Audioanalyse lieferte kein verwertbares Ergebnis.",
      measurement: null,
      eligibility: analysis.result?.ia2vEligibility ?? null,
      canRetry: true,
    };
  }

  if (analysis.result?.analysisStatus === "measured") {
    const eligible = analysis.result.ia2vEligibility.status === "eligible";
    const development = analysis.claimScope === "development";
    return {
      state: "measured",
      claimScope: analysis.claimScope,
      label: development
        ? "Entwicklungs-Messung abgeschlossen · keine Freigabe"
        : eligible
          ? "Audio-Messung abgeschlossen · Vorfilter bestanden"
          : "Audio-Messung abgeschlossen · Vorfilter gesperrt",
      tone: development ? "pending" : eligible ? "success" : "danger",
      progress: analysis.progress,
      error: null,
      measurement: analysis.result,
      eligibility: analysis.result.ia2vEligibility,
      canRetry: true,
    };
  }

  return {
    state: "failed",
    claimScope: analysis.claimScope,
    label: "Audioanalyse ohne Messwerte",
    tone: "danger",
    progress: analysis.progress,
    error: analysis.result?.analysisStatus === "failed"
      ? analysis.result.error.message
      : "Der abgeschlossene Analyselauf enthält keine Audio-Messwerte.",
    measurement: null,
    eligibility: analysis.result?.ia2vEligibility ?? null,
    canRetry: true,
  };
}
