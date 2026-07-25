import { CircleStop, LoaderCircle, RefreshCw, ScanFace } from "lucide-react";
import { useState } from "react";

import { fieldHelp } from "../fieldHelp";
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
    <div className="objective-analysis__metric">
      <span>{label} <InfoTooltip text={help} /></span>
      <strong>{value}</strong>
    </div>
  );
}

export function ObjectiveAnalysisPanel({
  output,
  onStart,
  onCancel,
}: {
  output: StudioOutput;
  onStart: (output: StudioOutput, force?: boolean) => Promise<void>;
  onCancel: (output: StudioOutput) => Promise<void>;
}) {
  const [pending, setPending] = useState<"start" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const analysis = output.analysis;
  const active = analysis ? ["queued", "running"].includes(analysis.status) : false;
  const result = analysis?.status === "completed" ? analysis.result : null;
  const identity = result?.schemaVersion === "ltx-studio-objective-quality.v2"
    || result?.schemaVersion === "ltx-studio-objective-quality.v3"
    || result?.schemaVersion === "ltx-studio-objective-quality.v4"
    || result?.schemaVersion === "ltx-studio-objective-quality.v5"
    ? result.identity
    : null;
  const avSync = result?.schemaVersion === "ltx-studio-objective-quality.v3"
    || result?.schemaVersion === "ltx-studio-objective-quality.v4"
    || result?.schemaVersion === "ltx-studio-objective-quality.v5"
    ? result.avSync
    : null;
  const conditioningAvSync = result?.schemaVersion === "ltx-studio-objective-quality.v5"
    ? result.conditioningAvSync
    : null;
  const phonemeViseme = result?.schemaVersion === "ltx-studio-objective-quality.v4"
    || result?.schemaVersion === "ltx-studio-objective-quality.v5"
    ? result.phonemeViseme
    : null;
  const provenance = output.provenance;
  const provenanceModelCount = provenance?.files.filter((file) => file.role.startsWith("model:")).length ?? 0;
  const provenanceInputCount = provenance?.files.filter((file) => file.role.startsWith("input:")).length ?? 0;
  const dirtyCodeCount = provenance?.code.filter((repository) => repository.dirty).length ?? 0;
  const showIdentityMetrics = identity && ["measured", "insufficient"].includes(identity.status);
  const statusLabel = analysis?.status === "completed"
    ? result?.status === "measured" ? "Rohwerte erfasst" : "Messung unzureichend"
    : analysis ? statusLabels[analysis.status] : "Nicht gemessen";

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

      {result ? (
        <>
          <div className="objective-analysis__metrics" aria-label="Objektive Messwerte">
            <MetricRow label="Gesicht erkannt" value={percent(result.face?.detectionCoverage ?? 0)} help={fieldHelp.objectiveFaceDetection} />
            <MetricRow label="Landmarks verwertbar" value={percent(result.face?.geometryCoverage ?? 0)} help={fieldHelp.objectiveGeometryCoverage} />
            <MetricRow label="Nasenbewegung p95" value={metricWithUnit(result.face?.noseVelocityP95PerSecond ?? null, " EA/s")} help={fieldHelp.objectiveNoseVelocity} />
            <MetricRow label="Nasenbeschleunigung p95" value={metricWithUnit(result.face?.noseAccelerationP95PerSecond2 ?? null, " EA/s²")} help={fieldHelp.objectiveNoseAcceleration} />
            <MetricRow label="Mundwinkel Median" value={metricWithUnit(result.face?.mouthAngleMedianDegrees ?? null, "°", 1)} help={fieldHelp.objectiveMouthAngle} />
            <MetricRow label="Mundwinkel-Dynamik p95" value={metricWithUnit(result.face?.mouthAngleVelocityP95DegreesPerSecond ?? null, "°/s", 1)} help={fieldHelp.objectiveMouthAngleDynamics} />
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
            <span>Phonem/Visem <InfoTooltip text={fieldHelp.objectivePvCapability} /> <strong>{
              phonemeViseme?.status === "measured"
                ? "Product-GO gemessen"
                : phonemeViseme?.status === "failed"
                  ? "Manifest-/Evaluatorfehler"
                  : phonemeViseme?.status === "insufficient"
                    ? "Nicht ausreichend"
                    : phonemeViseme?.status === "not-applicable"
                      ? "Nicht anwendbar"
                      : phonemeViseme?.blockerCode === "runner-unavailable"
                        ? "Runner fehlt"
                        : phonemeViseme?.blockerCode === "legal-hold"
                          ? "Legal Hold"
                          : phonemeViseme?.blockerCode === "manifest-missing"
                            ? "Modell fehlt"
                            : "Technischer Hold"
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
            <span>Dialogtreue <strong>Whisper nicht ausgeführt</strong></span>
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
        </>
      ) : null}

      {provenance ? (
        <details className="objective-analysis__limitations">
          <summary>Laufprovenienz</summary>
          <div className="objective-analysis__metrics" aria-label="Laufprovenienz">
            <MetricRow
              label="Manifest"
              value={provenance.fingerprint}
              help={fieldHelp.objectiveProvenanceFingerprint}
            />
            <MetricRow
              label="Nach Render verifiziert"
              value={provenance.verifiedAt ? new Date(provenance.verifiedAt).toLocaleString("de-AT") : "Nein"}
              help={fieldHelp.objectiveProvenanceVerified}
            />
            <MetricRow
              label="Gebundene Modelle"
              value={String(provenanceModelCount)}
              help={fieldHelp.objectiveProvenanceModels}
            />
            <MetricRow
              label="Gebundene Eingaben"
              value={String(provenanceInputCount)}
              help={fieldHelp.objectiveProvenanceInputs}
            />
            <MetricRow
              label="Codezustand"
              value={dirtyCodeCount === 0
                ? `${provenance.code.length} Repository(s), sauber`
                : `${dirtyCodeCount} von ${provenance.code.length} Repository(s) mit gebundenem Diff`}
              help={fieldHelp.objectiveProvenanceCode}
            />
            <MetricRow
              label="Runtime"
              value={provenance.runtime.fingerprint}
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
