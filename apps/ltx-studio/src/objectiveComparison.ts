import type { GenerationRequest } from "../shared/pipelines.js";
import type { ObjectiveQualityAnalysis } from "../shared/objectiveQuality.js";
import type { StudioOutput } from "../shared/outputs.js";

export type ComparisonDirection = "higher" | "lower" | "neutral";

export type ObjectiveComparisonMetric = {
  id: string;
  label: string;
  left: number | null;
  right: number | null;
  digits: number;
  unit: string;
  direction: ComparisonDirection;
};

export type SettingsDifference = {
  id: string;
  label: string;
  left: string;
  right: string;
};

export type ComparisonCompatibility = {
  comparable: boolean;
  reasons: string[];
};

function completedResult(output: StudioOutput): ObjectiveQualityAnalysis | null {
  return output.analysis?.status === "completed" ? output.analysis.result : null;
}

const settingLabels: Record<string, string> = {
  mode: "Pipeline",
  prompt: "Prompt",
  negativePrompt: "Negativer Prompt",
  seed: "Seed",
  width: "Breite",
  height: "Höhe",
  numFrames: "Frames",
  frameRate: "Bildrate",
  numInferenceSteps: "Schritte",
  "audio.path": "Konditionierungs-Audio-Pfad",
  "audio.name": "Konditionierungs-Audio",
  "audio.startTime": "Audio-Start",
  "audio.maxDuration": "Audio-Maximaldauer",
  "audio.finalMix.path": "Finale Tonspur-Pfad",
  "audio.finalMix.name": "Finale Tonspur",
  "videoGuidance.modalityScale": "A2V Guidance",
  "postprocess.longcatLipsync.enabled": "LongCat-Nachbearbeitung",
  "postprocess.longcatLipsync.resolution": "LongCat-Auflösung",
  "postprocess.longcatLipsync.blend": "LongCat-Blend",
};

type FlatSetting = {
  raw: string;
  display: string;
};

function settingLabel(path: string): string {
  if (settingLabels[path]) return settingLabels[path];
  if (/^images\[\d+\]\.path$/.test(path)) return `${path.match(/\d+/)?.[0] ?? "0"}. Referenzbild-Pfad`;
  if (/^images\[\d+\]\.name$/.test(path)) return `${path.match(/\d+/)?.[0] ?? "0"}. Referenzbild`;
  if (/^images\[\d+\]\.crf$/.test(path)) return `${path.match(/\d+/)?.[0] ?? "0"}. Referenz-CRF`;
  if (/^images\[\d+\]\.strength$/.test(path)) return `${path.match(/\d+/)?.[0] ?? "0"}. Referenzstärke`;
  if (/^images\[\d+\]\.frameIndex$/.test(path)) return `${path.match(/\d+/)?.[0] ?? "0"}. Referenzframe`;
  return path;
}

function displaySetting(value: unknown): string {
  if (typeof value === "string") {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > 96 ? `${compact.slice(0, 93)}...` : compact || "Leer";
  }
  if (value === null) return "Null";
  return String(value);
}

function flattenSettings(
  value: unknown,
  path = "",
  target = new Map<string, FlatSetting>(),
): Map<string, FlatSetting> {
  if (path === "outputName") return target;
  if (Array.isArray(value)) {
    if (value.length === 0 && path) target.set(path, { raw: "[]", display: "Leer" });
    value.forEach((item, index) => flattenSettings(item, `${path}[${index}]`, target));
    return target;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 && path) target.set(path, { raw: "{}", display: "Leer" });
    entries.forEach(([key, child]) => flattenSettings(child, path ? `${path}.${key}` : key, target));
    return target;
  }
  if (path) target.set(path, { raw: JSON.stringify(value), display: displaySetting(value) });
  return target;
}

export function settingsDifferences(
  left: GenerationRequest | null,
  right: GenerationRequest | null,
): SettingsDifference[] {
  if (!left || !right) return [];
  const leftSettings = flattenSettings(left);
  const rightSettings = flattenSettings(right);
  return [...new Set([...leftSettings.keys(), ...rightSettings.keys()])]
    .sort((first, second) => first.localeCompare(second))
    .flatMap((path) => {
      const leftValue = leftSettings.get(path);
      const rightValue = rightSettings.get(path);
      if (leftValue?.raw === rightValue?.raw) return [];
      return [{
        id: path,
        label: settingLabel(path),
        left: leftValue?.display ?? "Nicht gesetzt",
        right: rightValue?.display ?? "Nicht gesetzt",
      }];
    });
}

function effectiveOutputAudio(request: GenerationRequest | null): string | null {
  if (!request) return null;
  return request.audio.finalMix.path || request.audio.path || null;
}

function identityReferencePaths(request: GenerationRequest | null): string[] {
  if (!request) return [];
  return request.images.map((image) => image.path).filter(Boolean);
}

function evidenceFingerprint(output: StudioOutput, rolePrefixes: readonly string[]): string | null {
  const provenance = output.provenance;
  if (!provenance) return null;
  const evidence = provenance.files
    .filter((file) => rolePrefixes.some((prefix) => file.role.startsWith(prefix)))
    .map((file) => ({ role: file.role, sha256: file.sha256 }))
    .sort((left, right) => left.role.localeCompare(right.role));
  return evidence.length > 0 ? JSON.stringify(evidence) : null;
}

export function comparisonCompatibility(
  leftOutput: StudioOutput,
  rightOutput: StudioOutput,
): ComparisonCompatibility {
  const reasons: string[] = [];
  const left = completedResult(leftOutput);
  const right = completedResult(rightOutput);
  if (!left || !right) {
    reasons.push("Beide objektiven Analysen müssen abgeschlossen sein.");
    return { comparable: false, reasons };
  }
  if (left.analyzerVersion !== right.analyzerVersion) {
    reasons.push("Analyzer-Versionen unterscheiden sich.");
  }
  const leftFingerprint = leftOutput.analysis?.schemaVersion === "ltx-studio-output-analysis.v4"
    ? leftOutput.analysis.evaluatorFingerprint
    : null;
  const rightFingerprint = rightOutput.analysis?.schemaVersion === "ltx-studio-output-analysis.v4"
    ? rightOutput.analysis.evaluatorFingerprint
    : null;
  if (!leftFingerprint || !rightFingerprint || leftFingerprint !== rightFingerprint) {
    reasons.push("Evaluator-Fingerprints sind nicht identisch belegt.");
  }
  const leftIdentity = "identity" in left ? left.identity : null;
  const rightIdentity = "identity" in right ? right.identity : null;
  if (
    !leftIdentity
    || !rightIdentity
    || leftIdentity.modelSha256 !== rightIdentity.modelSha256
    || leftIdentity.preprocessingVersion !== rightIdentity.preprocessingVersion
  ) {
    reasons.push("Identitätsmodell oder Vorverarbeitung unterscheiden sich.");
  }
  if (JSON.stringify(identityReferencePaths(leftOutput.request)) !== JSON.stringify(identityReferencePaths(rightOutput.request))) {
    reasons.push("Identitätsreferenzen unterscheiden sich.");
  }
  if (effectiveOutputAudio(leftOutput.request) !== effectiveOutputAudio(rightOutput.request)) {
    reasons.push("Ausgewertete Tonspuren unterscheiden sich.");
  }
  const leftInputEvidence = evidenceFingerprint(leftOutput, [
    "input:conditioning-audio",
    "input:final-audio-mix",
    "input:reference-image",
    "input:reference-video",
  ]);
  const rightInputEvidence = evidenceFingerprint(rightOutput, [
    "input:conditioning-audio",
    "input:final-audio-mix",
    "input:reference-image",
    "input:reference-video",
  ]);
  if (!leftInputEvidence || !rightInputEvidence || leftInputEvidence !== rightInputEvidence) {
    reasons.push("Inhalts-Hashes der ausgewerteten Eingaben sind nicht identisch belegt.");
  }
  if (
    !leftOutput.provenance
    || !rightOutput.provenance
    || JSON.stringify(leftOutput.provenance.code.map((item) => item.fingerprint))
      !== JSON.stringify(rightOutput.provenance.code.map((item) => item.fingerprint))
  ) {
    reasons.push("Codezustände sind nicht identisch belegt.");
  }
  if (
    !leftOutput.provenance
    || !rightOutput.provenance
    || leftOutput.provenance.runtime.fingerprint !== rightOutput.provenance.runtime.fingerprint
  ) {
    reasons.push("Runtime-Versionen sind nicht identisch belegt.");
  }
  if (
    leftOutput.request?.numFrames !== rightOutput.request?.numFrames
    || leftOutput.request?.frameRate !== rightOutput.request?.frameRate
  ) {
    reasons.push("Dauer oder Bildrate unterscheiden sich.");
  }
  return { comparable: reasons.length === 0, reasons };
}

export function objectiveComparisonMetrics(
  leftOutput: StudioOutput,
  rightOutput: StudioOutput,
): ObjectiveComparisonMetric[] {
  const left = completedResult(leftOutput);
  const right = completedResult(rightOutput);
  if (!left || !right) return [];

  const leftIdentity = "identity" in left ? left.identity : null;
  const rightIdentity = "identity" in right ? right.identity : null;
  const leftAv = "avSync" in left ? left.avSync : null;
  const rightAv = "avSync" in right ? right.avSync : null;
  const leftConditioningAv = "conditioningAvSync" in left ? left.conditioningAvSync : null;
  const rightConditioningAv = "conditioningAvSync" in right ? right.conditioningAvSync : null;

  const metrics: ObjectiveComparisonMetric[] = [
    {
      id: "identity-median",
      label: "Identität Median",
      left: leftIdentity?.cosineMedian ?? null,
      right: rightIdentity?.cosineMedian ?? null,
      digits: 3,
      unit: "",
      direction: "higher",
    },
    {
      id: "identity-p10",
      label: "Identität p10",
      left: leftIdentity?.cosineP10 ?? null,
      right: rightIdentity?.cosineP10 ?? null,
      digits: 3,
      unit: "",
      direction: "higher",
    },
    {
      id: "identity-minimum",
      label: "Identität Minimum",
      left: leftIdentity?.cosineMinimum ?? null,
      right: rightIdentity?.cosineMinimum ?? null,
      digits: 3,
      unit: "",
      direction: "higher",
    },
    {
      id: "identity-temporal",
      label: "Identität zeitlich",
      left: leftIdentity?.outputTemporalConsistencyMedian ?? null,
      right: rightIdentity?.outputTemporalConsistencyMedian ?? null,
      digits: 3,
      unit: "",
      direction: "higher",
    },
    {
      id: "face-area",
      label: "Gesichtsfläche Median",
      left: left.face?.medianFaceAreaRatio === null || left.face?.medianFaceAreaRatio === undefined
        ? null
        : left.face.medianFaceAreaRatio * 100,
      right: right.face?.medianFaceAreaRatio === null || right.face?.medianFaceAreaRatio === undefined
        ? null
        : right.face.medianFaceAreaRatio * 100,
      digits: 1,
      unit: " %",
      direction: "neutral",
    },
    {
      id: "nose-velocity",
      label: "Nasenbewegung p95",
      left: left.face?.noseVelocityP95PerSecond ?? null,
      right: right.face?.noseVelocityP95PerSecond ?? null,
      digits: 3,
      unit: " EA/s",
      direction: "lower",
    },
    {
      id: "mouth-span-variation",
      label: "Mundbewegungsvariation",
      left: left.face?.mouthSpanCoefficientOfVariation ?? null,
      right: right.face?.mouthSpanCoefficientOfVariation ?? null,
      digits: 3,
      unit: "",
      direction: "neutral",
    },
    {
      id: "conditioning-av-absolute-lag",
      label: "Absoluter Kond.-AV-Rohversatz",
      left: leftConditioningAv?.estimatedAudioLeadMilliseconds === null
        || leftConditioningAv?.estimatedAudioLeadMilliseconds === undefined
        ? null
        : Math.abs(leftConditioningAv.estimatedAudioLeadMilliseconds),
      right: rightConditioningAv?.estimatedAudioLeadMilliseconds === null
        || rightConditioningAv?.estimatedAudioLeadMilliseconds === undefined
        ? null
        : Math.abs(rightConditioningAv.estimatedAudioLeadMilliseconds),
      digits: 0,
      unit: " ms",
      direction: leftConditioningAv?.status === "measured" && rightConditioningAv?.status === "measured"
        ? "lower"
        : "neutral",
    },
    {
      id: "conditioning-av-correlation-margin",
      label: "Kond.-AV-Peak über Nullmodell",
      left: leftConditioningAv?.correlationPeak === null || leftConditioningAv?.nullP95Correlation === null
        || leftConditioningAv?.correlationPeak === undefined
        || leftConditioningAv?.nullP95Correlation === undefined
        ? null
        : leftConditioningAv.correlationPeak - leftConditioningAv.nullP95Correlation,
      right: rightConditioningAv?.correlationPeak === null || rightConditioningAv?.nullP95Correlation === null
        || rightConditioningAv?.correlationPeak === undefined
        || rightConditioningAv?.nullP95Correlation === undefined
        ? null
        : rightConditioningAv.correlationPeak - rightConditioningAv.nullP95Correlation,
      digits: 3,
      unit: "",
      direction: "higher",
    },
    {
      id: "av-absolute-lag",
      label: "Absoluter Endmix-AV-Rohversatz",
      left: leftAv?.estimatedAudioLeadMilliseconds === null || leftAv?.estimatedAudioLeadMilliseconds === undefined
        ? null
        : Math.abs(leftAv.estimatedAudioLeadMilliseconds),
      right: rightAv?.estimatedAudioLeadMilliseconds === null || rightAv?.estimatedAudioLeadMilliseconds === undefined
        ? null
        : Math.abs(rightAv.estimatedAudioLeadMilliseconds),
      digits: 0,
      unit: " ms",
      direction: leftAv?.status === "measured" && rightAv?.status === "measured" ? "lower" : "neutral",
    },
    {
      id: "av-correlation-margin",
      label: "Endmix-AV-Peak über Nullmodell",
      left: leftAv?.correlationPeak === null || leftAv?.nullP95Correlation === null
        || leftAv?.correlationPeak === undefined || leftAv?.nullP95Correlation === undefined
        ? null
        : leftAv.correlationPeak - leftAv.nullP95Correlation,
      right: rightAv?.correlationPeak === null || rightAv?.nullP95Correlation === null
        || rightAv?.correlationPeak === undefined || rightAv?.nullP95Correlation === undefined
        ? null
        : rightAv.correlationPeak - rightAv.nullP95Correlation,
      digits: 3,
      unit: "",
      direction: "higher",
    },
    {
      id: "av-window-iqr",
      label: "Endmix-Fenster-Lag-IQR",
      left: leftAv?.windowLagIqrMilliseconds ?? null,
      right: rightAv?.windowLagIqrMilliseconds ?? null,
      digits: 0,
      unit: " ms",
      direction: leftAv?.status === "measured" && rightAv?.status === "measured" ? "lower" : "neutral",
    },
    {
      id: "av-duration-drift",
      label: "AV-Dauerdifferenz",
      left: left.technical.audioVideoDurationDeltaSeconds === null
        ? null
        : left.technical.audioVideoDurationDeltaSeconds * 1_000,
      right: right.technical.audioVideoDurationDeltaSeconds === null
        ? null
        : right.technical.audioVideoDurationDeltaSeconds * 1_000,
      digits: 0,
      unit: " ms",
      direction: "lower",
    },
  ];

  return metrics.filter((metric) => metric.left !== null || metric.right !== null);
}

export function metricDelta(metric: ObjectiveComparisonMetric): number | null {
  return metric.left === null || metric.right === null ? null : metric.right - metric.left;
}

export function metricTrend(
  metric: ObjectiveComparisonMetric,
  comparable = true,
): "improved" | "regressed" | "equal" | "neutral" {
  const delta = metricDelta(metric);
  if (!comparable || delta === null || metric.direction === "neutral") return "neutral";
  const tolerance = 10 ** -(metric.digits + 1);
  if (Math.abs(delta) <= tolerance) return "equal";
  if (metric.direction === "higher") return delta > 0 ? "improved" : "regressed";
  return delta < 0 ? "improved" : "regressed";
}
