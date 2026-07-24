import { Save, Star } from "lucide-react";
import { useMemo, useState } from "react";

import {
  qualityReviewAverage,
  type QualityReviewInput,
  type QualityScoreKey,
  type QualityScores,
} from "../../shared/quality";
import { fieldHelp } from "../fieldHelp";
import { isSpeechQualityCandidate } from "../qualityCandidates";
import type { StudioOutput } from "../types";
import { Field, InfoTooltip } from "./Controls";

const scoreFields: readonly {
  key: QualityScoreKey;
  label: string;
  hint: string;
}[] = [
  { key: "lipSync", label: "LipSync", hint: fieldHelp.qualityLipSync },
  { key: "identity", label: "Identität", hint: fieldHelp.qualityIdentity },
  { key: "mouthNaturalness", label: "Mundnatürlichkeit", hint: fieldHelp.qualityMouthNaturalness },
  { key: "skinStability", label: "Hautstabilität", hint: fieldHelp.qualitySkinStability },
  { key: "motion", label: "Bewegung", hint: fieldHelp.qualityMotion },
  { key: "audio", label: "Ton", hint: fieldHelp.qualityAudio },
];

const neutralScores: QualityScores = {
  lipSync: 5,
  identity: 5,
  mouthNaturalness: 5,
  skinStability: 5,
  motion: 5,
  audio: 5,
};

export function QualityScorecard({
  output,
  outputs,
  onSave,
}: {
  output: StudioOutput;
  outputs: readonly StudioOutput[];
  onSave: (output: StudioOutput, input: QualityReviewInput) => Promise<void>;
}) {
  const [scores, setScores] = useState<QualityScores>(() => output.qualityReview?.scores ?? neutralScores);
  const [note, setNote] = useState(output.qualityReview?.note ?? "");
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saved" | "failed">("idle");

  const reviewedCandidates = useMemo(
    () => outputs.filter(isSpeechQualityCandidate).filter((candidate) => candidate.qualityReview),
    [outputs],
  );
  const bestAverage = reviewedCandidates.length > 0
    ? Math.max(...reviewedCandidates.map((candidate) => qualityReviewAverage(candidate.qualityReview!)))
    : null;
  const savedAverage = output.qualityReview ? qualityReviewAverage(output.qualityReview) : null;

  const save = async () => {
    setSaving(true);
    setSaveState("idle");
    try {
      await onSave(output, { scores, note });
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="quality-scorecard" aria-labelledby={`quality-heading-${output.jobId}`}>
      <div className="quality-scorecard__heading">
        <div>
          <h2 id={`quality-heading-${output.jobId}`}>Manuelle Qualitätsbewertung</h2>
          <InfoTooltip text={fieldHelp.qualityReview} />
        </div>
        <div className="quality-scorecard__summary" aria-label="Bewertungsübersicht">
          {savedAverage === null ? <span>Noch unbewertet</span> : <strong>{savedAverage.toFixed(1)} / 10</strong>}
          {bestAverage !== null ? <span><Star size={12} fill="currentColor" /> Bestwert {bestAverage.toFixed(1)}</span> : null}
        </div>
      </div>

      <div className="quality-scorecard__grid">
        {scoreFields.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <div className="quality-scorecard__control">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={scores[field.key]}
                aria-label={`${field.label} Bewertung`}
                aria-valuetext={`${scores[field.key]} von 10`}
                onChange={(event) => {
                  const value = Number.parseInt(event.target.value, 10);
                  setScores((current) => ({ ...current, [field.key]: value }));
                  setSaveState("idle");
                }}
              />
              <output aria-live="polite">{scores[field.key]} / 10</output>
            </div>
          </Field>
        ))}
      </div>

      <Field label="Notiz" hint={fieldHelp.qualityNote}>
        <textarea
          value={note}
          maxLength={2_000}
          rows={3}
          aria-label="Qualitätsnotiz"
          placeholder="Konkrete Stärken, Fehler und nächste Änderung festhalten..."
          onChange={(event) => {
            setNote(event.target.value);
            setSaveState("idle");
          }}
        />
        <span className="quality-scorecard__note-count">{note.length} / 2.000</span>
      </Field>

      <div className="quality-scorecard__footer">
        <span role={saveState === "failed" ? "alert" : "status"}>
          {saveState === "saved"
            ? "Bewertung gespeichert."
            : saveState === "failed"
              ? "Speichern fehlgeschlagen."
            : output.qualityReview
                ? `Zuletzt gespeichert ${new Date(output.qualityReview.updatedAt).toLocaleString("de-AT")}`
                : "Werte werden erst beim Speichern übernommen."}
        </span>
        <button type="button" className="button" disabled={saving} onClick={() => void save()}>
          <Save size={15} /> {saving ? "Speichert..." : "Bewertung speichern"}
        </button>
      </div>
    </section>
  );
}
