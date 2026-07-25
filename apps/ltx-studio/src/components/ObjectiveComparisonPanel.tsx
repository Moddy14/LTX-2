import { Columns2 } from "lucide-react";

import type { StudioOutput } from "../types";
import {
  comparisonCompatibility,
  metricDelta,
  metricTrend,
  objectiveComparisonMetrics,
  settingsDifferences,
  type ObjectiveComparisonMetric,
} from "../objectiveComparison";

function compactName(name: string): string {
  return name.length > 38 ? `${name.slice(0, 35)}...` : name;
}

function formatValue(metric: ObjectiveComparisonMetric, value: number | null): string {
  return value === null ? "Nicht messbar" : `${value.toFixed(metric.digits)}${metric.unit}`;
}

function formatDelta(metric: ObjectiveComparisonMetric): string {
  const delta = metricDelta(metric);
  if (delta === null) return "Nicht messbar";
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(metric.digits)}${metric.unit}`;
}

function analysisLabel(output: StudioOutput): string {
  const analysis = output.analysis;
  if (!analysis) return "Nicht analysiert";
  if (analysis.status !== "completed") return analysis.status === "running" ? "Analysiert" : "Analyse offen";
  return analysis.result?.status === "measured" ? "Gemessen" : "Unzureichend";
}

export function ObjectiveComparisonPanel({ outputs }: { outputs: [StudioOutput, StudioOutput] }) {
  const [left, right] = outputs;
  const differences = settingsDifferences(left.request, right.request);
  const metrics = objectiveComparisonMetrics(left, right);
  const compatibility = comparisonCompatibility(left, right);

  return (
    <section className="objective-comparison" aria-labelledby="objective-comparison-heading">
      <div className="objective-comparison__heading">
        <h2 id="objective-comparison-heading"><Columns2 size={15} /> Objektiver A/B-Vergleich</h2>
        <span>{compatibility.comparable ? "Vergleichbar · B minus A" : "Nur Rohwerte · B minus A"}</span>
      </div>

      <div className="objective-comparison__names">
        <span title={left.name}><strong>A</strong> {compactName(left.name)}</span>
        <span title={right.name}><strong>B</strong> {compactName(right.name)}</span>
      </div>

      <div className="objective-comparison__status">
        <span>A: <strong>{analysisLabel(left)}</strong></span>
        <span>B: <strong>{analysisLabel(right)}</strong></span>
      </div>
      {!compatibility.comparable ? (
        <details className="objective-comparison__compatibility">
          <summary>Vergleichbarkeitsgates nicht erfüllt</summary>
          {compatibility.reasons.map((reason) => <p key={reason}>{reason}</p>)}
        </details>
      ) : null}

      <div className="objective-comparison__table" role="table" aria-label="Abweichende Einstellungen">
        <div className="objective-comparison__row objective-comparison__row--header" role="row">
          <span role="columnheader">Abweichende Einstellung</span>
          <span role="columnheader">A</span>
          <span role="columnheader">B</span>
        </div>
        {differences.length > 0 ? differences.map((difference) => (
          <div className="objective-comparison__row" role="row" key={difference.id}>
            <strong role="cell">{difference.label}</strong>
            <span role="cell" title={difference.left}>{difference.left}</span>
            <span role="cell" title={difference.right}>{difference.right}</span>
          </div>
        )) : (
          <div className="objective-comparison__empty">Keine gespeicherten Einstellungsunterschiede</div>
        )}
      </div>

      <div className="objective-comparison__table objective-comparison__table--metrics" role="table" aria-label="Objektive Messwertdifferenzen">
        <div className="objective-comparison__row objective-comparison__row--metrics objective-comparison__row--header" role="row">
          <span role="columnheader">Messwert</span>
          <span role="columnheader">A</span>
          <span role="columnheader">B</span>
          <span role="columnheader">Delta</span>
        </div>
        {metrics.length > 0 ? metrics.map((metric) => (
          <div className="objective-comparison__row objective-comparison__row--metrics" role="row" key={metric.id}>
            <strong role="cell">{metric.label}</strong>
            <span role="cell">{formatValue(metric, metric.left)}</span>
            <span role="cell">{formatValue(metric, metric.right)}</span>
            <span
              role="cell"
              className={`objective-comparison__delta is-${metricTrend(metric, compatibility.comparable)}`}
            >
              {formatDelta(metric)}
            </span>
          </div>
        )) : (
          <div className="objective-comparison__empty">Für beide Videos ist eine abgeschlossene objektive Analyse nötig</div>
        )}
      </div>
    </section>
  );
}
