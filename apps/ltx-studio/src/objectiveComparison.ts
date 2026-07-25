import type { GenerationRequest } from "../shared/pipelines.js";
import type { ObjectiveQualityAnalysis } from "../shared/objectiveQuality.js";
import { mouthSkinMeasurementIsSufficient } from "../shared/mouthSkinSufficiency.js";
import type { StudioOutput } from "../shared/outputs.js";
import { generationRequestDiffPaths } from "../shared/experiments.js";

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

export function protocolOrderedComparisonOutputs(
  outputs: readonly StudioOutput[],
): StudioOutput[] {
  if (outputs.length !== 2) return [...outputs];
  const [first, second] = outputs;
  const firstBinding = first.experiment;
  const secondBinding = second.experiment;
  const sameProtocol = firstBinding
    && secondBinding
    && firstBinding.experimentId === secondBinding.experimentId
    && firstBinding.protocolSha256 === secondBinding.protocolSha256;
  if (!sameProtocol) return [...outputs];
  if (firstBinding.arm === "candidate" && secondBinding.arm === "baseline") {
    return [second, first];
  }
  return [...outputs];
}

function completedResult(output: StudioOutput): ObjectiveQualityAnalysis | null {
  return output.analysis?.status === "completed" ? output.analysis.result : null;
}

function sufficientArtifactFace(result: ObjectiveQualityAnalysis) {
  if (result.schemaVersion !== "ltx-studio-objective-quality.v7") return null;
  return mouthSkinMeasurementIsSufficient(result.face) ? result.face : null;
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
  if (left.status !== "measured" || right.status !== "measured") {
    reasons.push("Beide Gesamtanalysen müssen alle Product-Gates erfüllen; unzureichende Analysen bleiben neutrale Rohwerte.");
  }
  if (left.analyzerVersion !== right.analyzerVersion) {
    reasons.push("Analyzer-Versionen unterscheiden sich.");
  }
  const leftFingerprint = leftOutput.analysis && "evaluatorFingerprint" in leftOutput.analysis
    ? leftOutput.analysis.evaluatorFingerprint
    : null;
  const rightFingerprint = rightOutput.analysis && "evaluatorFingerprint" in rightOutput.analysis
    ? rightOutput.analysis.evaluatorFingerprint
    : null;
  if (!leftFingerprint || !rightFingerprint || leftFingerprint !== rightFingerprint) {
    reasons.push("Evaluator-Fingerprints sind nicht identisch belegt.");
  }
  const leftDialogueSha = leftOutput.analysis?.schemaVersion === "ltx-studio-output-analysis.v6"
    || leftOutput.analysis?.schemaVersion === "ltx-studio-output-analysis.v7"
    ? leftOutput.analysis.expectedDialogueSha256
    : null;
  const rightDialogueSha = rightOutput.analysis?.schemaVersion === "ltx-studio-output-analysis.v6"
    || rightOutput.analysis?.schemaVersion === "ltx-studio-output-analysis.v7"
    ? rightOutput.analysis.expectedDialogueSha256
    : null;
  if ((leftDialogueSha || rightDialogueSha)
    && (!leftDialogueSha || !rightDialogueSha || leftDialogueSha !== rightDialogueSha)) {
    reasons.push("Die gebundenen Dialogtexte sind nicht identisch.");
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
  const leftExperiment = leftOutput.experiment;
  const rightExperiment = rightOutput.experiment;
  if (!leftExperiment || !rightExperiment) {
    reasons.push("Beide Ausgaben müssen an denselben eingefrorenen Experimentplan gebunden sein.");
  } else if (
    leftOutput.experimentRequestVerified !== true
    || rightOutput.experimentRequestVerified !== true
  ) {
    reasons.push("Die gespeicherten Requests stimmen nicht mit ihren eingefrorenen Request-Hashes überein.");
  } else if (
    leftExperiment.experimentId !== rightExperiment.experimentId
    || leftExperiment.protocolSha256 !== rightExperiment.protocolSha256
  ) {
    reasons.push("Experiment-ID oder eingefrorener Protokoll-Hash unterscheiden sich.");
  } else {
    const baseline = leftExperiment.arm === "baseline"
      ? { output: leftOutput, binding: leftExperiment }
      : rightExperiment.arm === "baseline"
        ? { output: rightOutput, binding: rightExperiment }
        : null;
    const candidate = leftExperiment.arm === "candidate"
      ? { output: leftOutput, binding: leftExperiment }
      : rightExperiment.arm === "candidate"
        ? { output: rightOutput, binding: rightExperiment }
        : null;
    if (!baseline || !candidate) {
      reasons.push("Der Vergleich benötigt genau einen Baseline- und einen Kandidatenarm.");
    } else {
      if (candidate.binding.baselineJobId !== baseline.output.jobId) {
        reasons.push("Der Kandidatenarm verweist nicht auf diesen Baseline-Job.");
      }
      if (
        baseline.binding.variableId !== candidate.binding.variableId
        || baseline.binding.kind !== candidate.binding.kind
        || baseline.binding.baselineRequestSha256 !== candidate.binding.baselineRequestSha256
      ) {
        reasons.push("Die Experimentbindungen beschreiben nicht dieselbe kontrollierte Variable.");
      }
      const actualPaths = baseline.output.request && candidate.output.request
        ? generationRequestDiffPaths(baseline.output.request, candidate.output.request)
          .filter((path) => path !== "outputName")
        : [];
      const expectedPaths = [...candidate.binding.changedRequestPaths].sort();
      if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
        reasons.push("Der tatsächliche Request-Diff entspricht nicht der eingefrorenen Einzelfaktoränderung.");
      }
      if (
        candidate.binding.kind === "ablation"
        && baseline.output.request?.seed !== candidate.output.request?.seed
      ) {
        reasons.push("Der Seed wurde innerhalb einer Einzelfaktor-Ablation verändert.");
      }
    }
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
  const leftModels = evidenceFingerprint(leftOutput, ["model:"]);
  const rightModels = evidenceFingerprint(rightOutput, ["model:"]);
  if (!leftModels || !rightModels || leftModels !== rightModels) {
    reasons.push("Generationsmodelle oder deren Inhalts-Hashes sind nicht identisch belegt.");
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
  const leftDialogue = "dialogue" in left && typeof left.dialogue === "object"
    ? left.dialogue
    : null;
  const rightDialogue = "dialogue" in right && typeof right.dialogue === "object"
    ? right.dialogue
    : null;
  const leftArtifactDiagnostics = left.schemaVersion === "ltx-studio-objective-quality.v7"
    ? left.face
    : null;
  const rightArtifactDiagnostics = right.schemaVersion === "ltx-studio-objective-quality.v7"
    ? right.face
    : null;
  const leftArtifactFace = sufficientArtifactFace(left);
  const rightArtifactFace = sufficientArtifactFace(right);

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
      digits: 3,
      unit: " %",
      direction: "neutral",
    },
    {
      id: "nose-velocity",
      label: "Nasenbewegung p95",
      left: left.face?.noseVelocityP95PerSecond ?? null,
      right: right.face?.noseVelocityP95PerSecond ?? null,
      digits: 1,
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
      id: "mouth-skin-pair-coverage",
      label: "Mundhaut-Paarabdeckung",
      left: leftArtifactDiagnostics ? leftArtifactDiagnostics.mouthSkinPairCoverage * 100 : null,
      right: rightArtifactDiagnostics ? rightArtifactDiagnostics.mouthSkinPairCoverage * 100 : null,
      digits: 1,
      unit: " %",
      direction: "neutral",
    },
    {
      id: "mouth-skin-valid-pixels",
      label: "Mundhaut-Pixelabdeckung p10",
      left: leftArtifactDiagnostics?.mouthSkinValidPixelCoverageP10 === null
        || leftArtifactDiagnostics?.mouthSkinValidPixelCoverageP10 === undefined
        ? null
        : leftArtifactDiagnostics.mouthSkinValidPixelCoverageP10 * 100,
      right: rightArtifactDiagnostics?.mouthSkinValidPixelCoverageP10 === null
        || rightArtifactDiagnostics?.mouthSkinValidPixelCoverageP10 === undefined
        ? null
        : rightArtifactDiagnostics.mouthSkinValidPixelCoverageP10 * 100,
      digits: 1,
      unit: " %",
      direction: "neutral",
    },
    {
      id: "mouth-skin-warp-residual",
      label: "Mundhaut-Texturrest p95×p95",
      left: leftArtifactFace?.mouthSkinWarpResidualP95 ?? null,
      right: rightArtifactFace?.mouthSkinWarpResidualP95 ?? null,
      digits: 3,
      unit: "",
      direction: "neutral",
    },
    {
      id: "mouth-skin-luminance-delta",
      label: "Mundhaut-Helligkeitsdelta p95",
      left: leftArtifactFace?.mouthSkinLuminanceDeltaP95 ?? null,
      right: rightArtifactFace?.mouthSkinLuminanceDeltaP95 ?? null,
      digits: 3,
      unit: "",
      direction: "neutral",
    },
    {
      id: "mouth-skin-flow-deformation",
      label: "Mundhaut-Flussdeformation p95×p95",
      left: leftArtifactFace?.mouthSkinFlowDeformationP95 ?? null,
      right: rightArtifactFace?.mouthSkinFlowDeformationP95 ?? null,
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
    {
      id: "dialogue-word-error-rate",
      label: "Dialog-Wortfehlerrate",
      left: leftDialogue?.wordErrorRate === null || leftDialogue?.wordErrorRate === undefined
        ? null
        : leftDialogue.wordErrorRate * 100,
      right: rightDialogue?.wordErrorRate === null || rightDialogue?.wordErrorRate === undefined
        ? null
        : rightDialogue.wordErrorRate * 100,
      digits: 0,
      unit: " %",
      direction: "lower",
    },
    {
      id: "dialogue-word-motion",
      label: "Wörter mit Mundbewegung",
      left: leftDialogue?.wordsWithMouthMotionRatio === null
        || leftDialogue?.wordsWithMouthMotionRatio === undefined
        ? null
        : leftDialogue.wordsWithMouthMotionRatio * 100,
      right: rightDialogue?.wordsWithMouthMotionRatio === null
        || rightDialogue?.wordsWithMouthMotionRatio === undefined
        ? null
        : rightDialogue.wordsWithMouthMotionRatio * 100,
      digits: 0,
      unit: " %",
      direction: leftDialogue?.wordMotionProxyStatus === "measured"
        && rightDialogue?.wordMotionProxyStatus === "measured"
        ? "higher"
        : "neutral",
    },
    {
      id: "dialogue-pause-motion",
      label: "Mundbewegung in Pausen",
      left: leftDialogue?.pauseMotionRatio === null || leftDialogue?.pauseMotionRatio === undefined
        ? null
        : leftDialogue.pauseMotionRatio * 100,
      right: rightDialogue?.pauseMotionRatio === null || rightDialogue?.pauseMotionRatio === undefined
        ? null
        : rightDialogue.pauseMotionRatio * 100,
      digits: 0,
      unit: " %",
      direction: leftDialogue?.wordMotionProxyStatus === "measured"
        && rightDialogue?.wordMotionProxyStatus === "measured"
        ? "lower"
        : "neutral",
    },
    {
      id: "dialogue-word-activity-lag",
      label: "Absoluter Wortaktivitäts-Rohversatz",
      left: leftDialogue?.estimatedWordActivityLeadMilliseconds === null
        || leftDialogue?.estimatedWordActivityLeadMilliseconds === undefined
        ? null
        : Math.abs(leftDialogue.estimatedWordActivityLeadMilliseconds),
      right: rightDialogue?.estimatedWordActivityLeadMilliseconds === null
        || rightDialogue?.estimatedWordActivityLeadMilliseconds === undefined
        ? null
        : Math.abs(rightDialogue.estimatedWordActivityLeadMilliseconds),
      digits: 0,
      unit: " ms",
      direction: leftDialogue?.wordMotionProxyStatus === "measured"
        && rightDialogue?.wordMotionProxyStatus === "measured"
        ? "lower"
        : "neutral",
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
