import { CircleStop, LoaderCircle, RefreshCw, ScanFace, SlidersHorizontal } from "lucide-react";
import { useState } from "react";

import { fieldHelp } from "../fieldHelp";
import { phonemeVisemeMeasurementWindow } from "../objectiveAnalysisCoverage";
import type { StudioOutput } from "../types";
import { InfoTooltip } from "./Controls";

const statusLabels = {
  queued: "Wartet",
  running: "Analysiert",
  failed: "Fehler",
  cancelled: "Abgebrochen",
} as const;

function percent(value: number): string {
  return `${(value * 100).toFixed(0)} %`;
}

function metricWithUnit(value: number | null, unit: string, digits = 3): string {
  return value === null ? "Nicht messbar" : `${value.toFixed(digits)}${unit}`;
}

function MetricRow({ label, value, help }: { label: string; value: string; help: string }) {
  return (
    <div className="objective-analysis__metric" data-metric-label={label}>
      <span>{label} <InfoTooltip text={help} /></span>
      <strong>{value}</strong>
    </div>
  );
}

export function ObjectiveAnalysisPanel({
  output,
  onStart,
  onCancel,
  onPrepareLipSyncRetry,
}: {
  output: StudioOutput;
  onStart: (output: StudioOutput, force?: boolean) => Promise<void>;
  onCancel: (output: StudioOutput) => Promise<void>;
  onPrepareLipSyncRetry: (output: StudioOutput, referenceStrength: number) => void;
}) {
  const [pending, setPending] = useState<"start" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [preparedStrength, setPreparedStrength] = useState<number | null>(null);
  const analysis = output.analysis;
  const active = analysis ? ["queued", "running"].includes(analysis.status) : false;
  const result = analysis?.status === "completed" ? analysis.result : null;
  const identity = result?.schemaVersion === "ltx-studio-objective-quality.v2"
    || result?.schemaVersion === "ltx-studio-objective-quality.v3"
    || result?.schemaVersion === "ltx-studio-objective-quality.v4"
    || result?.schemaVersion === "ltx-studio-objective-quality.v5"
    || result?.schemaVersion === "ltx-studio-objective-quality.v6"
    || result?.schemaVersion === "ltx-studio-objective-quality.v7"
    ? result.identity
    : null;
  const avSync = result?.schemaVersion === "ltx-studio-objective-quality.v3"
    || result?.schemaVersion === "ltx-studio-objective-quality.v4"
    || result?.schemaVersion === "ltx-studio-objective-quality.v5"
    || result?.schemaVersion === "ltx-studio-objective-quality.v6"
    || result?.schemaVersion === "ltx-studio-objective-quality.v7"
    ? result.avSync
    : null;
  const conditioningAvSync = result?.schemaVersion === "ltx-studio-objective-quality.v5"
    || result?.schemaVersion === "ltx-studio-objective-quality.v6"
    || result?.schemaVersion === "ltx-studio-objective-quality.v7"
    ? result.conditioningAvSync
    : null;
  const phonemeViseme = result?.schemaVersion === "ltx-studio-objective-quality.v4"
    || result?.schemaVersion === "ltx-studio-objective-quality.v5"
    || result?.schemaVersion === "ltx-studio-objective-quality.v6"
    || result?.schemaVersion === "ltx-studio-objective-quality.v7"
    ? result.phonemeViseme
    : null;
  const phonemeVisemeMeasurement = phonemeViseme?.measurement ?? null;
  const measurementWindow = phonemeVisemeMeasurementWindow(result);
  const partialMeasurementWindow = measurementWindow.status === "partial";
  const measurementOnly = phonemeViseme?.status === "measurement-only";
  const dialogue = result?.schemaVersion === "ltx-studio-objective-quality.v6"
    || result?.schemaVersion === "ltx-studio-objective-quality.v7"
    ? result.dialogue
    : null;
  const artifactFace = result?.schemaVersion === "ltx-studio-objective-quality.v7"
    ? result.face
    : null;
  const provenance = output.provenanceSummary;
  const showIdentityMetrics = identity && ["measured", "insufficient"].includes(identity.status);
  const statusLabel = analysis?.status === "completed"
    ? measurementOnly
      ? partialMeasurementWindow
        ? "Lip-Sync gemessen (Teilfenster) · keine Product-GO-Freigabe"
        : "Lip-Sync gemessen · keine Product-GO-Freigabe"
      : phonemeViseme?.status === "measured" && phonemeViseme.productGo.status === "passed"
        ? "Lip-Sync Product-GO freigegeben"
      : "Prüfung unvollständig"
    : analysis ? statusLabels[analysis.status] : "Nicht gemessen";
  const dialogueVerdict = dialogue?.wordErrorRate !== null && dialogue?.wordErrorRate !== undefined
    ? `${dialogue.recognizedWordCount} von ${dialogue.expectedWordCount} Wörtern erkannt, `
      + `${(dialogue.wordErrorRate * 100).toFixed(0)} % Wortfehler`
    : "Wortlaut nicht belastbar gemessen";
  const avVerdict = avSync?.status === "insufficient"
    ? "Ein genauer Zeitversatz konnte nicht sicher bestimmt werden"
    : avSync?.status === "measured"
      ? "Mundbewegung und Ton konnten zeitlich verglichen werden"
      : "Zeitliche Abstimmung konnte nicht geprüft werden";
  const bilabialClosureF1 = phonemeVisemeMeasurement?.bilabialClosureF1 ?? null;
  const currentReferenceStrength = output.request?.mode === "lipdub"
    ? output.request.lipDub.referenceVideo.strength
    : null;
  const recommendedReferenceStrength = currentReferenceStrength === null
    ? null
    : currentReferenceStrength > 0.85
      ? 0.8
      : currentReferenceStrength > 0.7
        ? 0.65
        : currentReferenceStrength > 0.6
          ? 0.6
          : null;
  const showLipSyncRetry = bilabialClosureF1 !== null
    && bilabialClosureF1 < 0.8
    && recommendedReferenceStrength !== null;
  const lipSyncHeadline = measurementOnly
    ? "Lip-Sync gemessen · keine Product-GO-Freigabe"
    : !phonemeVisemeMeasurement
    ? "Lip-Sync konnte nicht vollständig geprüft werden"
    : bilabialClosureF1 === null
      ? "Lip-Sync-Messung nicht eindeutig"
      : bilabialClosureF1 < 0.5
        ? "Lip-Sync nicht ausreichend"
        : bilabialClosureF1 < 0.8
          ? "Lip-Sync hat erkennbare Schwächen"
          : "Keine groben Lippenschlussfehler erkannt";
  const lipSyncExplanation = !phonemeVisemeMeasurement
    ? "Die App konnte Ton und sichtbare Lippenbewegung nicht vollständig miteinander vergleichen."
    : bilabialClosureF1 === null
      ? "Im gesprochenen Text waren nicht genügend klar messbare P-, B- oder M-Laute vorhanden."
      : bilabialClosureF1 < 0.5
        ? "Bei P, B und M schließen sich die Lippen nicht passend zum gesprochenen Ton."
        : bilabialClosureF1 < 0.8
          ? "Bei P, B und M schließen sich die Lippen nur teilweise passend zum gesprochenen Ton."
          : "Die sichtbaren Lippenschlüsse bei P, B und M passen in diesem Video überwiegend zum Ton.";
  const phonemeVisemeVerdict = phonemeVisemeMeasurement
    ? lipSyncExplanation
    : "Laut- und Lippenbewegung konnten nicht vollständig verglichen werden";

  const start = async (force: boolean) => {
    setPending("start");
    setActionError(null);
    try {
      await onStart(output, force);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Objektive Analyse konnte nicht gestartet werden.");
    } finally {
      setPending(null);
    }
  };

  const cancel = async () => {
    setPending("cancel");
    setActionError(null);
    try {
      await onCancel(output);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Objektive Analyse konnte nicht abgebrochen werden.");
    } finally {
      setPending(null);
    }
  };

  return (
    <section className="objective-analysis" aria-labelledby={`objective-heading-${output.jobId}`}>
      <div className="objective-analysis__heading">
        <div>
          <h2 id={`objective-heading-${output.jobId}`}><ScanFace size={15} /> Objektive Ausgabeanalyse</h2>
          <InfoTooltip text={fieldHelp.objectiveAnalysis} />
        </div>
        <span
          className={`objective-analysis__status objective-analysis__status--${analysis?.status ?? "idle"}${result?.status === "insufficient" ? " is-insufficient" : ""}`}
          role="status"
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>

      {active ? (
        <div className="objective-analysis__progress" role="status">
          <LoaderCircle className="spin" size={15} />
          <span>CPU-Analyse läuft</span>
        </div>
      ) : null}

      {partialMeasurementWindow ? (
        <div
          className="objective-analysis__measurement-window"
          role="note"
          aria-label="Lip-Sync-Messfenster unvollständig"
        >
          <strong>Die Lip-Sync-Messung deckt nicht den gesamten Clip ab.</strong>
          <p>
            {measurementWindow.totalDurationSeconds === null
              ? `Messfenster ${measurementWindow.usableDurationSeconds?.toFixed(1).replace(".", ",")} Sekunden; die Gesamtdauer war nicht messbar. `
              : `Messfenster ${measurementWindow.usableDurationSeconds?.toFixed(1).replace(".", ",")} von ${measurementWindow.totalDurationSeconds.toFixed(1).replace(".", ",")} Sekunden (${Math.round((measurementWindow.coverageRatio ?? 0) * 100)} %). `}
            Das Ergebnis gilt nur für diesen Ausschnitt.
          </p>
        </div>
      ) : null}

      {result ? (
        <>
          {result.status === "insufficient" ? (
            <div className="objective-analysis__verdict" role="note" aria-label="Einordnung der Lip-Sync-Messung">
              <strong>{lipSyncHeadline}</strong>
              <p>{lipSyncExplanation}</p>
              <div>
                <span><b>Gesprochener Text</b>{dialogueVerdict}</span>
                <span><b>Zeitliche Abstimmung</b>{avVerdict}</span>
                <span><b>Lippenformen</b>{phonemeVisemeVerdict}</span>
              </div>
            </div>
          ) : null}
          {showLipSyncRetry ? (
            <div className="objective-analysis__recommendation" role="note" aria-label="Empfohlene Lip-Sync-Korrektur">
              <div>
                <strong>Nächsten Lip-Sync-Versuch verbessern</strong>
                <p>
                  Referenzbindung von {currentReferenceStrength?.toFixed(2).replace(".", ",")} auf{" "}
                  {recommendedReferenceStrength.toFixed(2).replace(".", ",")} senken. Damit bekommt der
                  Mund mehr Bewegungsfreiheit; Ziel sind vollständige Lippenschlüsse bei P, B und M.
                </p>
                <span>Dialog, Seed, Modelle und alle übrigen Einstellungen bleiben unverändert.</span>
              </div>
              <button
                type="button"
                className="button"
                onClick={() => {
                  onPrepareLipSyncRetry(output, recommendedReferenceStrength);
                  setPreparedStrength(recommendedReferenceStrength);
                }}
              >
                <SlidersHorizontal size={15} /> Verbesserten Versuch vorbereiten
              </button>
              {preparedStrength !== null ? (
                <p className="objective-analysis__prepared" role="status">
                  Vorbereitet mit Referenzbindung {preparedStrength.toFixed(2).replace(".", ",")}. Jetzt links prüfen
                  und auf „Generieren“ klicken.
                </p>
              ) : null}
            </div>
          ) : null}
          <details className="objective-analysis__technical">
            <summary>Technische Messwerte anzeigen</summary>
            <div className="objective-analysis__metrics" aria-label="Objektive Messwerte">
            <MetricRow label="Gesicht erkannt" value={percent(result.face?.detectionCoverage ?? 0)} help={fieldHelp.objectiveFaceDetection} />
            <MetricRow label="Landmarks verwertbar" value={percent(result.face?.geometryCoverage ?? 0)} help={fieldHelp.objectiveGeometryCoverage} />
            <MetricRow label="Nasenbewegung p95" value={metricWithUnit(result.face?.noseVelocityP95PerSecond ?? null, " EA/s")} help={fieldHelp.objectiveNoseVelocity} />
            <MetricRow label="Nasenbeschleunigung p95" value={metricWithUnit(result.face?.noseAccelerationP95PerSecond2 ?? null, " EA/s²")} help={fieldHelp.objectiveNoseAcceleration} />
            <MetricRow label="Mundwinkel Median" value={metricWithUnit(result.face?.mouthAngleMedianDegrees ?? null, "°", 1)} help={fieldHelp.objectiveMouthAngle} />
            <MetricRow label="Mundwinkel-Dynamik p95" value={metricWithUnit(result.face?.mouthAngleVelocityP95DegreesPerSecond ?? null, "°/s", 1)} help={fieldHelp.objectiveMouthAngleDynamics} />
            {artifactFace ? (
              <>
                <MetricRow label="Mundhaut-Paarabdeckung" value={percent(artifactFace.mouthSkinPairCoverage)} help={fieldHelp.objectiveMouthSkinCoverage} />
                <MetricRow label="Mundhaut-Pixelabdeckung p10" value={metricWithUnit(
                  artifactFace.mouthSkinValidPixelCoverageP10 === null
                    ? null
                    : artifactFace.mouthSkinValidPixelCoverageP10 * 100,
                  " %",
                  0,
                )} help={fieldHelp.objectiveMouthSkinPixelCoverage} />
                <MetricRow label="Mundhaut-Texturrest p95×p95" value={metricWithUnit(artifactFace.mouthSkinWarpResidualP95, "", 3)} help={fieldHelp.objectiveMouthSkinWarpResidual} />
                <MetricRow label="Mundhaut-Helligkeitsdelta p95" value={metricWithUnit(artifactFace.mouthSkinLuminanceDeltaP95, "", 3)} help={fieldHelp.objectiveMouthSkinLuminance} />
                <MetricRow label="Mundhaut-Flussdeformation p95×p95" value={metricWithUnit(artifactFace.mouthSkinFlowDeformationP95, "", 3)} help={fieldHelp.objectiveMouthSkinFlowDeformation} />
              </>
            ) : null}
            {showIdentityMetrics ? (
              <>
                <MetricRow label="Identitätsabdeckung" value={percent(identity.outputCoverage)} help={fieldHelp.objectiveIdentityCoverage} />
                <MetricRow label="Identität Median" value={metricWithUnit(identity.cosineMedian, "", 3)} help={fieldHelp.objectiveIdentityMedian} />
                <MetricRow label="Identität p10" value={metricWithUnit(identity.cosineP10, "", 3)} help={fieldHelp.objectiveIdentityP10} />
                <MetricRow label="Identität Minimum" value={metricWithUnit(identity.cosineMinimum, "", 3)} help={fieldHelp.objectiveIdentityMinimum} />
              </>
            ) : null}
            <MetricRow label="AV-Startdifferenz" value={metricWithUnit(
              result.technical.audioVideoStartDeltaSeconds === null
                ? null
                : result.technical.audioVideoStartDeltaSeconds * 1_000,
              " ms",
              0,
            )} help={fieldHelp.objectiveAvStartDelta} />
            <MetricRow label="AV-Dauerdifferenz" value={metricWithUnit(
              result.technical.audioVideoDurationDeltaSeconds === null
                ? null
                : result.technical.audioVideoDurationDeltaSeconds * 1_000,
              " ms",
              0,
            )} help={fieldHelp.objectiveAvDurationDelta} />
            {conditioningAvSync ? (
              <>
                <MetricRow label="Kond.-AV-Rohversatz" value={metricWithUnit(
                  conditioningAvSync.estimatedAudioLeadMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectiveConditioningAvMotionLag} />
                <MetricRow label="Kond.-AV-Korrelation" value={metricWithUnit(
                  conditioningAvSync.correlationPeak,
                  "",
                  3,
                )} help={fieldHelp.objectiveAvMotionCorrelation} />
                <MetricRow label="Kond.-Nullmodell p95" value={metricWithUnit(
                  conditioningAvSync.nullP95Correlation,
                  "",
                  3,
                )} help={fieldHelp.objectiveAvNullP95} />
                <MetricRow label="Kond.-Fenster-Lag-IQR" value={metricWithUnit(
                  conditioningAvSync.windowLagIqrMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectiveAvWindowIqr} />
              </>
            ) : null}
            {avSync ? (
              <>
                <MetricRow label="Endmix-AV-Rohversatz" value={metricWithUnit(
                  avSync.estimatedAudioLeadMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectiveAvMotionLag} />
                <MetricRow label="Endmix-AV-Zeitauflösung" value={metricWithUnit(
                  avSync.lagResolutionMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectiveAvResolution} />
                <MetricRow label="Endmix-AV-Korrelation" value={metricWithUnit(
                  avSync.correlationPeak,
                  "",
                  3,
                )} help={fieldHelp.objectiveAvMotionCorrelation} />
                <MetricRow label="Endmix-Nullmodell p95" value={metricWithUnit(
                  avSync.nullP95Correlation,
                  "",
                  3,
                )} help={fieldHelp.objectiveAvNullP95} />
                <MetricRow label="Endmix-AV-Prominenz" value={metricWithUnit(
                  avSync.peakProminence,
                  "",
                  3,
                )} help={fieldHelp.objectiveAvMotionProminence} />
                <MetricRow label="Endmix-AV-Peakbreite" value={metricWithUnit(
                  avSync.peakWidthMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectiveAvMotionPeakWidth} />
                <MetricRow label="Merkmals-Lagabweichung" value={metricWithUnit(
                  avSync.featureLagAgreementMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectiveAvFeatureAgreement} />
                <MetricRow label="Fenster-Lag-IQR" value={metricWithUnit(
                  avSync.windowLagIqrMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectiveAvWindowIqr} />
                <MetricRow label="Mundbewegungsabdeckung" value={percent(
                  avSync.motionCoverage,
                )} help={fieldHelp.objectiveAvMotionCoverage} />
                <MetricRow label="Aktivitätsabdeckung" value={percent(
                  avSync.mouthCoverageDuringAudioActivity,
                )} help={fieldHelp.objectiveAvActivityCoverage} />
                <MetricRow label="Nutzbare Aktivität" value={metricWithUnit(
                  avSync.usableAudioActivitySeconds,
                  " s",
                  2,
                )} help={fieldHelp.objectiveAvUsableActivity} />
                <MetricRow label="Audioaktivität" value={avSync.audioActivityRatio === null
                  ? "Nicht messbar"
                  : percent(avSync.audioActivityRatio)} help={fieldHelp.objectiveAvAudioActivity} />
              </>
            ) : null}
            {dialogue && dialogue.wordErrorRate !== null ? (
              <>
                <MetricRow label="Dialog-Wortfehlerrate" value={metricWithUnit(
                  dialogue.wordErrorRate === null ? null : dialogue.wordErrorRate * 100,
                  " %",
                  0,
                )} help={fieldHelp.objectiveDialogueWer} />
                <MetricRow label="Erkannte Wörter" value={`${dialogue.recognizedWordCount} / ${dialogue.expectedWordCount}`} help={fieldHelp.objectiveDialogueWords} />
                <MetricRow label="Geführte Wortabdeckung" value={percent(dialogue.guidedWordCoverage)} help={fieldHelp.objectiveDialogueAlignmentCoverage} />
                <MetricRow label="Wortzeit-Konfidenz Median" value={dialogue.medianGuidedWordProbability === null
                  ? "Nicht messbar"
                  : percent(dialogue.medianGuidedWordProbability)} help={fieldHelp.objectiveDialogueAlignmentConfidence} />
                <MetricRow label="Mundtracking in Wörtern" value={percent(dialogue.mouthTrackedWordCoverage)} help={fieldHelp.objectiveDialogueMouthCoverage} />
                <MetricRow label="Wörter mit Mundbewegung" value={dialogue.wordsWithMouthMotionRatio === null
                  ? "Nicht messbar"
                  : percent(dialogue.wordsWithMouthMotionRatio)} help={fieldHelp.objectiveDialogueWordMotion} />
                <MetricRow label="Mundbewegung in Pausen" value={dialogue.pauseMotionRatio === null
                  ? "Nicht messbar"
                  : percent(dialogue.pauseMotionRatio)} help={fieldHelp.objectiveDialoguePauseMotion} />
                <MetricRow label="Wortaktivitäts-Rohversatz" value={metricWithUnit(
                  dialogue.estimatedWordActivityLeadMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectiveDialogueActivityLag} />
              </>
            ) : null}
            {phonemeViseme?.status === "measured" ? (
              <>
                <MetricRow label="PV-Offset" value={metricWithUnit(
                  phonemeViseme.offset.estimatedOffsetMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectivePvOffset} />
                <MetricRow label="PV-Offsetkonfidenz" value={phonemeViseme.offset.confidence === null
                  ? "Nicht messbar"
                  : percent(phonemeViseme.offset.confidence)} help={fieldHelp.objectivePvOffsetConfidence} />
                <MetricRow label="Visem-Makro-F1" value={metricWithUnit(
                  phonemeViseme.content.frameMacroF1,
                  "",
                  3,
                )} help={fieldHelp.objectivePvFrameMacroF1} />
                <MetricRow label="Visem-Übergangs-F1" value={metricWithUnit(
                  phonemeViseme.content.transitionF1,
                  "",
                  3,
                )} help={fieldHelp.objectivePvTransitionF1} />
              </>
            ) : null}
            {phonemeVisemeMeasurement ? (
              <>
                <MetricRow label="Gemessener Zeitversatz" value={metricWithUnit(
                  phonemeVisemeMeasurement.globalAvLagMilliseconds,
                  " ms",
                  0,
                )} help={fieldHelp.objectivePvRawLag} />
                <MetricRow label="Sicherheit des Zeitversatzes" value={phonemeVisemeMeasurement.lagConfidence === null
                  ? "Nicht messbar"
                  : percent(phonemeVisemeMeasurement.lagConfidence)} help={fieldHelp.objectivePvRawLagConfidence} />
                <MetricRow label="P/B/M-Lippenschluss" value={phonemeVisemeMeasurement.bilabialClosureF1 === null
                  ? "Nicht messbar"
                  : percent(phonemeVisemeMeasurement.bilabialClosureF1)} help={fieldHelp.objectivePvBilabialF1} />
                <MetricRow label="Mundöffnung passt zum Ton" value={metricWithUnit(
                  phonemeVisemeMeasurement.openingCorrelation,
                  "",
                  3,
                )} help={fieldHelp.objectivePvOpeningCorrelation} />
                <MetricRow label="Lippenrundung passt zum Ton" value={metricWithUnit(
                  phonemeVisemeMeasurement.roundingCorrelation,
                  "",
                  3,
                )} help={fieldHelp.objectivePvRoundingCorrelation} />
                <MetricRow label="Sprechbewegungsabdeckung" value={phonemeVisemeMeasurement.speechMotionRecall === null
                  ? "Nicht messbar"
                  : percent(phonemeVisemeMeasurement.speechMotionRecall)} help={fieldHelp.objectivePvSpeechMotion} />
                <MetricRow label="Bewegung in Phonempausen" value={phonemeVisemeMeasurement.pauseLeakRatio === null
                  ? "Nicht messbar"
                  : percent(phonemeVisemeMeasurement.pauseLeakRatio)} help={fieldHelp.objectivePvPauseLeak} />
                <MetricRow label="Abgedeckte Sprachlaute" value={percent(
                  phonemeVisemeMeasurement.phoneCoverage,
                )} help={fieldHelp.objectivePvPhoneCoverage} />
                <MetricRow label="Nicht erkannte Sprachlaute" value={phonemeVisemeMeasurement.unknownPhones.length > 0
                  ? phonemeVisemeMeasurement.unknownPhones.join(", ")
                  : "Keine"} help={fieldHelp.objectivePvUnknownPhones} />
                <MetricRow label="Gesichtstrack-Abdeckung" value={percent(
                  phonemeVisemeMeasurement.faceTrackCoverage,
                )} help={fieldHelp.objectivePvFaceTrackCoverage} />
                <MetricRow label="Mundtrack-Abdeckung" value={percent(
                  phonemeVisemeMeasurement.mouthTrackCoverage,
                )} help={fieldHelp.objectivePvMouthTrackCoverage} />
                <MetricRow label="Mehrgesicht-Frames" value={percent(
                  phonemeVisemeMeasurement.multiFaceFrameRatio,
                )} help={fieldHelp.objectivePvMultiFaceRatio} />
                <MetricRow label="Bildschärfe Median" value={metricWithUnit(
                  phonemeVisemeMeasurement.medianBlurVariance,
                  "",
                  1,
                )} help={fieldHelp.objectivePvBlurVariance} />
                <MetricRow label="Kopfdrehung p95" value={metricWithUnit(
                  phonemeVisemeMeasurement.yawP95Degrees,
                  "°",
                  1,
                )} help={fieldHelp.objectivePvYaw} />
                <MetricRow label="Kopfneigung p95" value={metricWithUnit(
                  phonemeVisemeMeasurement.pitchP95Degrees,
                  "°",
                  1,
                )} help={fieldHelp.objectivePvPitch} />
                <MetricRow label="Nutzbare Messdauer" value={metricWithUnit(
                  phonemeVisemeMeasurement.usableDurationSeconds,
                  " s",
                  2,
                )} help={fieldHelp.objectivePvUsableDuration} />
                <MetricRow label="Ausgewertete Video-Frames" value={String(
                  phonemeVisemeMeasurement.sampledFrames,
                )} help={fieldHelp.objectivePvSampledFrames} />
              </>
            ) : null}
            </div>
            <div className="objective-analysis__capabilities">
            <span>Konditionierungs-AV <strong>{conditioningAvSync?.status === "measured"
              ? "Rohproxy, Phonem offen"
              : conditioningAvSync?.status === "failed"
                ? "Proxy-Fehler"
                : conditioningAvSync?.status === "insufficient"
                  ? "Proxy unzureichend"
                  : "Provenienz fehlt"}</strong></span>
            <span>Endmix-AV <strong>{avSync?.status === "measured"
              ? "Rohproxy, Phonem offen"
              : avSync?.status === "failed"
                ? "Proxy-Fehler"
                : avSync?.status === "insufficient"
                  ? "Proxy unzureichend"
                  : avSync?.status === "not-applicable"
                    ? "Nicht anwendbar"
                    : "Phonem-Evaluator fehlt"}</strong></span>
            <span>Laut-/Lippenprüfung <InfoTooltip text={fieldHelp.objectivePvCapability} /> <strong>{
              phonemeViseme?.status === "measured"
                ? "Bestanden"
                : phonemeViseme?.status === "measurement-only"
                  ? "Gemessen · keine Product-GO-Freigabe"
                : phonemeViseme?.status === "failed"
                  ? "Prüfung fehlgeschlagen"
                  : phonemeViseme?.status === "insufficient"
                    ? "Nicht eindeutig"
                    : phonemeViseme?.status === "not-applicable"
                      ? "Nicht nötig"
                      : phonemeViseme?.blockerCode === "runner-unavailable"
                        ? "Prüfung nicht verfügbar"
                        : phonemeViseme?.blockerCode === "legal-hold"
                          ? "Nicht freigegeben"
                          : phonemeViseme?.blockerCode === "manifest-missing"
                            ? "Nicht eingerichtet"
                            : "Vorübergehend nicht verfügbar"
            }</strong></span>
            <span>Identität <strong>{identity?.status === "measured"
              ? "SFace Rohwerte"
              : identity?.status === "failed"
                ? "Fehler"
              : identity?.status === "insufficient"
                ? "Nicht ausreichend"
                : identity?.status === "not-applicable"
                  ? "Keine Referenz"
                  : result?.schemaVersion === "ltx-studio-objective-quality.v1"
                    ? "Erkennungsmodell fehlt"
                    : "Provenienz fehlt"}</strong></span>
            <span>Dialogtreue <InfoTooltip text={fieldHelp.objectiveDialogueCapability} /> <strong>{
              dialogue?.status === "measured"
                ? "Whisper-Wortmessung"
                : dialogue?.status === "insufficient"
                  ? dialogue.wordErrorRate !== null
                    ? "Wörter gemessen, Alignment unzureichend"
                    : "Wortmessung unzureichend"
                  : dialogue?.status === "failed"
                    ? "Whisper-Fehler"
                    : dialogue?.status === "not-available"
                      ? "Whisper fehlt"
                      : dialogue?.status === "not-applicable"
                        ? "Kein exakter Dialog"
                        : "Whisper nicht ausgeführt"
            }</strong></span>
            </div>
            {result.findings.length > 0 ? (
              <div className="objective-analysis__findings">
                {result.findings.map((finding) => (
                  <span key={finding.code} className={`is-${finding.level}`}>{finding.message}</span>
                ))}
              </div>
            ) : null}
            <details className="objective-analysis__limitations">
              <summary>Messgrenzen</summary>
              {result.limitations.map((limitation) => <p key={limitation}>{limitation}</p>)}
            </details>
          </details>
        </>
      ) : null}

      {provenance ? (
        <details className="objective-analysis__limitations">
          <summary>Laufprovenienz</summary>
          <div className="objective-analysis__metrics" aria-label="Laufprovenienz">
            <MetricRow
              label="Manifest"
              value={provenance.equality.run}
              help={fieldHelp.objectiveProvenanceFingerprint}
            />
            <MetricRow
              label="Nach Render verifiziert"
              value={provenance.verifiedAt ? new Date(provenance.verifiedAt).toLocaleString("de-AT") : "Nein"}
              help={fieldHelp.objectiveProvenanceVerified}
            />
            <MetricRow
              label="Gebundene Modelle"
              value={provenance.equality.models ? "Gleichheit belegt" : "Nicht belegt"}
              help={fieldHelp.objectiveProvenanceModels}
            />
            <MetricRow
              label="Gebundene Eingaben"
              value={provenance.equality.inputs ? "Gleichheit belegt" : "Nicht belegt"}
              help={fieldHelp.objectiveProvenanceInputs}
            />
            <MetricRow
              label="Codezustand"
              value={provenance.equality.code ? "Gleichheitstoken vorhanden" : "Nicht belegt"}
              help={fieldHelp.objectiveProvenanceCode}
            />
            <MetricRow
              label="Runtime"
              value={provenance.equality.runtime}
              help={fieldHelp.objectiveProvenanceRuntime}
            />
          </div>
        </details>
      ) : null}

      {analysis?.error ? (
        <p className="objective-analysis__error" role="alert">{analysis.error.message}</p>
      ) : null}
      {actionError ? (
        <p className="objective-analysis__error" role="alert">{actionError}</p>
      ) : null}

      <div className="objective-analysis__actions">
        {active ? (
          <button type="button" className="button button--secondary" disabled={pending !== null} onClick={() => void cancel()}>
            <CircleStop size={15} /> {pending === "cancel" ? "Bricht ab..." : "Analyse abbrechen"}
          </button>
        ) : (
          <button
            type="button"
            className="button button--secondary"
            disabled={pending !== null}
            onClick={() => void start(analysis?.status === "completed")}
          >
            {pending === "start"
              ? <LoaderCircle className="spin" size={15} />
              : analysis?.status === "completed"
                ? <RefreshCw size={15} />
                : <ScanFace size={15} />}
            {pending === "start" ? "Startet..." : analysis?.status === "completed" ? "Neu messen" : "Objektiv analysieren"}
          </button>
        )}
        <span>CPU-only · keine DGX-Modellbelegung</span>
      </div>
    </section>
  );
}
