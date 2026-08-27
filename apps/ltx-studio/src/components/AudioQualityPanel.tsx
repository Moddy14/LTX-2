import {
  AudioLines,
  CircleStop,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { useId, useState } from "react";

import type { PublicT2aAudioEvaluatorCapability } from "../../shared/healthPublic.js";
import type { T2aAudioPublicAnalysisRecord } from "../../shared/t2aAudioPublic.js";
import {
  audioAlignmentLabel,
  audioDialogueStatusLabel,
  formatAudioDb,
  formatAudioDecimal,
  formatAudioDuration,
  formatAudioInteger,
  formatAudioPercent,
  independentIpaReasonLabel,
  independentIpaStatusLabel,
  presentT2aAudioAnalysis,
  pronunciationMeasurementStatusLabel,
  pronunciationSourcePhaseStatusLabel,
  T2A_IA2V_BLOCKER_LABELS,
  type MeasuredT2aAudioQuality,
  type PublicT2aIa2vEligibility,
} from "../audioQualityPresentation.js";
import { InfoTooltip } from "./Controls";

type AudioQualityPanelProps = {
  outputName: string;
  analysis: T2aAudioPublicAnalysisRecord | null;
  capability: PublicT2aAudioEvaluatorCapability | null;
  onStart: (force?: boolean) => Promise<void>;
  onCancel: (analysisId: string) => Promise<void>;
};

const help = {
  panel: "Offline-Messung des erzeugten WAV-Signals und des erwarteten deutschen Wortlauts. Die Werte sind ein technischer Vorfilter und keine subjektive Qualitätsnote.",
  words: "Vergleicht die Zahl der offline erkannten Wörter mit der Zahl der erwarteten Wörter.",
  dialogueStatus: "Status der Offline-Prüfung des erwarteten Wortlauts.",
  wer: "Wortfehlerrate: Summe aus Ersetzungen, Löschungen und Einfügungen, geteilt durch die erwartete Wortzahl.",
  edits: "S/D/I steht für Substitutionen (Ersetzungen), Deletions (Löschungen) und Insertions (Einfügungen).",
  language: "Sprache, die der lokale Spracherkenner im Audiosignal erkannt hat.",
  guidedCoverage: "Anteil der erwarteten Wörter, für die eine zeitliche Ausrichtung gefunden wurde.",
  usableCoverage: "Anteil der erwarteten Wörter mit zeitlich nutzbarer Ausrichtung und ausreichender Wortwahrscheinlichkeit.",
  alignment: "Status der zeitlichen Zuordnung zwischen erwartetem Wortlaut und Audiosignal.",
  confidence: "Median beziehungsweise unteres Zehntel der Wortwahrscheinlichkeiten. Das sind Messwerte des lokalen Erkenners, keine menschliche Qualitätsnote.",
  lowConfidence: "Zahl ausgerichteter Wörter mit einer Wahrscheinlichkeit unter 0,25.",
  ipaStatus: "Status der zieltextfreien, unabhängig ausgeführten CTC-Lautbeobachtung. Auch ein gemessener Status ist keine Freigabe.",
  ipaConditioning: "Die IPA-Beobachtung erhält keinen Zieltext und kann ihn daher nicht zur Dekodierung verwenden.",
  ipaReason: "Fail-honest Reason-Code der unabhängigen Lautphase. Nicht gemessene Werte bleiben ausdrücklich leer.",
  ipaMethod: "Fest gebundene Methode der unabhängigen IPA-Beobachtung. Sie bewertet keine Lippenbewegung.",
  ipaModel: "Öffentlicher Fingerprint des fest gebundenen IPA-Modells; keine Modellpfade oder privaten Laufzeitdetails.",
  ipaDecoded: "Zieltextfrei dekodierte Lautsymbolfolge. Sie ist ein Rohbefund, keine Aussage über Wortgleichheit oder Lip-Sync.",
  ipaTokens: "Gesamtzahl dekodierter CTC-Läufe sowie darin enthaltene unbekannte und spezielle Tokens.",
  ipaBlankFrames: "Anteil der CTC-Zeitschritte, in denen das Modell das Blank-Symbol als wahrscheinlichstes Symbol auswählte.",
  ipaQualification: "Für eine Release-Qualifikation sind ein vorregistrierter Holdout mit 300 positiven und 300 negativen Fällen sowie null False Accepts erforderlich.",
  pronunciationStatus: "Status des reinen Lautabgleich-Rohbefunds. Ohne vollständig adjudizierte Messwerte bleibt die Anzeige ausdrücklich bei Nicht gemessen.",
  pronunciationSourceStatus: "Status der target-free IPA-Quellphase, die in den Lautabgleich einging.",
  pronunciationPer: "Unkalibrierte rohe Phone Error Rate: Editdistanz geteilt durch die Zahl der Referenztokens. Daraus wird weder ein Grenzwerturteil noch eine Freigabe abgeleitet.",
  pronunciationEdits: "Rohe Laut-Editzahlen: Substitutionen (S), Deletions (D) und Insertions (I).",
  pronunciationEditDistance: "Summe der rohen Substitutionen, Deletions und Insertions.",
  pronunciationTokenCounts: "Zahl der Lauttokens aus dem gepinnten deutschen G2P und aus der target-free IPA-Beobachtung.",
  pronunciationMethod: "Fest gebundene Rohvergleichsmethode zwischen G2P-Referenz und unabhängiger IPA-Beobachtung.",
  pronunciationMode: "Nur Messbetrieb: Der Wert ist unkalibriert und kann keine Freigabe erteilen.",
  duration: "Dauer des geprüften PCM-WAV-Signals.",
  samplePeak: "Höchster digitaler PCM-Samplewert. Er wird gegen die beim Lauf gespeicherte Sample-Peak-Grenze geprüft.",
  peakCeiling: "Unverändert aus dem autorisierten Lauf übernommene Sample-Peak-Grenze.",
  truePeak: "Mit FFmpeg ebur128 geschätzter Spitzenpegel zwischen den Samples. Dieser Wert ist nicht mit dem Sample-Peak identisch.",
  lufs: "Gemessene integrierte Lautheit nach FFmpeg ebur128. Die Oberfläche zeigt bewusst nur den Messwert und leitet daraus kein Zielurteil ab.",
  clipped: "Zahl und Anteil der PCM-Samples, die den digitalen Vollpegel erreichen.",
  format: "Technische Eigenschaften des geprüften WAV-Signals.",
  eligibility: "Fail-closed technischer Vorfilter für eine spätere IA2V-Weitergabe. Nur eine attestierte Release-Messung kann grundsätzlich Teil einer Freigabe werden; auch sie erzeugt noch keine servergebundene Audiodatei.",
} as const;

function AudioMetric({
  label,
  value,
  tooltip,
}: {
  label: string;
  value: string;
  tooltip: string;
}) {
  return (
    <div className="audio-quality__metric" data-audio-metric={label}>
      <dt>{label} <InfoTooltip text={tooltip} /></dt>
      <dd>{value}</dd>
    </div>
  );
}

function WordMetrics({ measurement, headingId }: {
  measurement: MeasuredT2aAudioQuality;
  headingId: string;
}) {
  const { dialogue } = measurement;
  return (
    <section className="audio-quality__group" aria-labelledby={headingId}>
      <h3 id={headingId}>Worttreue und Sprache</h3>
      <dl className="audio-quality__metrics">
        <AudioMetric
          label="Dialogprüfung"
          value={audioDialogueStatusLabel(dialogue.status)}
          tooltip={help.dialogueStatus}
        />
        <AudioMetric
          label="Erkannte / erwartete Wörter"
          value={`${formatAudioInteger(dialogue.recognizedWordCount)} / ${formatAudioInteger(dialogue.expectedWordCount)}`}
          tooltip={help.words}
        />
        <AudioMetric
          label="Wortfehlerrate (WER)"
          value={formatAudioPercent(dialogue.wordErrorRate)}
          tooltip={help.wer}
        />
        <AudioMetric
          label="S / D / I"
          value={`${dialogue.substitutions} / ${dialogue.deletions} / ${dialogue.insertions}`}
          tooltip={help.edits}
        />
        <AudioMetric
          label="Erkannte Sprache"
          value={dialogue.detectedLanguage ?? "Nicht gemessen"}
          tooltip={help.language}
        />
        <AudioMetric
          label="Geführte Wortdeckung"
          value={`${formatAudioPercent(dialogue.guidedWordCoverage)} (${dialogue.guidedAlignedWordCount} / ${dialogue.expectedWordCount})`}
          tooltip={help.guidedCoverage}
        />
        <AudioMetric
          label="Nutzbare Wortdeckung"
          value={`${formatAudioPercent(dialogue.usableGuidedWordCoverage)} (${dialogue.usableAlignedWordCount} / ${dialogue.expectedWordCount})`}
          tooltip={help.usableCoverage}
        />
        <AudioMetric
          label="Wortausrichtung"
          value={audioAlignmentLabel(dialogue.alignmentStatus)}
          tooltip={help.alignment}
        />
        <AudioMetric
          label="Konfidenz Median / P10"
          value={`${formatAudioPercent(dialogue.medianGuidedWordProbability)} / ${formatAudioPercent(dialogue.p10GuidedWordProbability)}`}
          tooltip={help.confidence}
        />
        <AudioMetric
          label="Wörter mit niedriger Konfidenz"
          value={formatAudioInteger(dialogue.lowConfidenceAlignedWords)}
          tooltip={help.lowConfidence}
        />
      </dl>
      {dialogue.alignmentError ? (
        <p className="audio-quality__inline-warning" role="note">{dialogue.alignmentError}</p>
      ) : null}
    </section>
  );
}

function SignalMetrics({ measurement, headingId }: {
  measurement: MeasuredT2aAudioQuality;
  headingId: string;
}) {
  return (
    <section className="audio-quality__group" aria-labelledby={headingId}>
      <h3 id={headingId}>Audiosignal</h3>
      <dl className="audio-quality__metrics">
        <AudioMetric
          label="Dauer"
          value={formatAudioDuration(measurement.wav.durationSeconds)}
          tooltip={help.duration}
        />
        <AudioMetric
          label="Sample-Peak"
          value={formatAudioDb(measurement.pcm.samplePeakDbfs, "dBFS", 2)}
          tooltip={help.samplePeak}
        />
        <AudioMetric
          label="Gespeicherte Peak-Grenze"
          value={formatAudioDb(measurement.policy.peakCeilingDbfs, "dBFS")}
          tooltip={help.peakCeiling}
        />
        <AudioMetric
          label="True Peak"
          value={formatAudioDb(measurement.loudness.truePeakDbtp, "dBTP")}
          tooltip={help.truePeak}
        />
        <AudioMetric
          label="Integrierte Lautheit (Messwert)"
          value={formatAudioDb(measurement.loudness.integratedLufs, "LUFS")}
          tooltip={help.lufs}
        />
        <AudioMetric
          label="Vollpegel-Samples"
          value={`${formatAudioInteger(measurement.pcm.fullScaleClippedSamples)} / ${formatAudioInteger(measurement.pcm.totalSamples)} (${formatAudioPercent(measurement.pcm.fullScaleClippedRatio, 4)})`}
          tooltip={help.clipped}
        />
        <AudioMetric
          label="WAV-Format"
          value={`${measurement.wav.codec}, ${measurement.wav.bitsPerSample} Bit`}
          tooltip={help.format}
        />
        <AudioMetric
          label="Kanäle / Abtastrate"
          value={`${measurement.wav.channels} / ${formatAudioDecimal(measurement.wav.sampleRateHz / 1_000, 1)} kHz`}
          tooltip={help.format}
        />
      </dl>
    </section>
  );
}

function IndependentIpaMeasurement({ measurement, headingId }: {
  measurement: MeasuredT2aAudioQuality;
  headingId: string;
}) {
  const ipa = measurement.independentIpa;
  const measured = ipa.status === "measured";
  return (
    <section
      className="audio-quality__group audio-quality__ipa-measurement"
      aria-labelledby={headingId}
      data-evaluation-mode={ipa.evaluationMode}
      data-ipa-status={ipa.status}
    >
      <h3 id={headingId}>Unabhängige Lautbeobachtung · nur Messbetrieb</h3>
      <p className="audio-quality__inline-warning" role="note">
        Zieltextfreie CTC-Rohbeobachtung. Sie bewertet weder Wortgleichheit noch
        Lippen-Synchronität und kann keine Freigabe erteilen.
      </p>
      <dl className="audio-quality__metrics">
        <AudioMetric
          label="Messstatus"
          value={independentIpaStatusLabel(ipa.status)}
          tooltip={help.ipaStatus}
        />
        <AudioMetric
          label="Zieltext verwendet"
          value={ipa.targetConditioned ? "Ja" : "Nein · zieltextfrei"}
          tooltip={help.ipaConditioning}
        />
        <AudioMetric
          label="Reason-Code"
          value={independentIpaReasonLabel(ipa.reasonCode)}
          tooltip={help.ipaReason}
        />
        <AudioMetric
          label="Messmethode"
          value={ipa.method ?? "Nicht gemessen"}
          tooltip={help.ipaMethod}
        />
        <AudioMetric
          label="Modell-Fingerprint"
          value={ipa.modelFingerprint ?? "Nicht gemessen"}
          tooltip={help.ipaModel}
        />
        <AudioMetric
          label="Dekodierte IPA-Folge"
          value={ipa.decodedIpa ?? "Nicht gemessen"}
          tooltip={help.ipaDecoded}
        />
        <AudioMetric
          label="Tokens / unbekannt / speziell"
          value={measured
            ? `${formatAudioInteger(ipa.tokenCount)} / ${formatAudioInteger(ipa.unknownTokenCount)} / ${formatAudioInteger(ipa.specialTokenCount)}`
            : "Nicht gemessen"}
          tooltip={help.ipaTokens}
        />
        <AudioMetric
          label="CTC-Blank-Frames"
          value={formatAudioPercent(ipa.blankFrameRatio)}
          tooltip={help.ipaBlankFrames}
        />
        <AudioMetric
          label="Release-Qualifikation"
          value="Nicht qualifiziert"
          tooltip={help.ipaQualification}
        />
        <AudioMetric
          label="Erforderlicher kalibrierter Holdout"
          value={`${ipa.releaseQualification.requiredPositiveHoldoutCases} positiv / ${ipa.releaseQualification.requiredNegativeHoldoutCases} negativ / ${ipa.releaseQualification.maximumFalseAccepts} False Accepts`}
          tooltip={help.ipaQualification}
        />
      </dl>
    </section>
  );
}

function PronunciationMeasurement({ measurement, headingId }: {
  measurement: MeasuredT2aAudioQuality;
  headingId: string;
}) {
  const pronunciation = measurement.pronunciationMeasurement;
  const measured = pronunciation?.status === "measured";
  return (
    <section
      className="audio-quality__group audio-quality__pronunciation-measurement"
      aria-labelledby={headingId}
      data-pronunciation-status={pronunciation?.status ?? "not-measured"}
      data-source-phase-status={pronunciation?.sourcePhaseStatus ?? "not-measured"}
    >
      <h3 id={headingId}>Lautabgleich · nur Messbetrieb</h3>
      <p className="audio-quality__inline-warning" role="note">
        Der Rohvergleich lautet: target-free Beobachtung des Audiosignals vs. gepinntes
        deutsches G2P aus dem Zieltext. Er bewertet die Audioaussprache und NICHT die
        Lippen-Synchronität. Der Roh-PER ist unkalibriert und erteilt keine Freigabe.
      </p>
      <dl className="audio-quality__metrics">
        <AudioMetric
          label="Messstatus"
          value={pronunciationMeasurementStatusLabel(pronunciation)}
          tooltip={help.pronunciationStatus}
        />
        <AudioMetric
          label="Quellphasenstatus"
          value={pronunciationSourcePhaseStatusLabel(pronunciation)}
          tooltip={help.pronunciationSourceStatus}
        />
        <AudioMetric
          label="Roh-PER (unkalibriert)"
          value={formatAudioPercent(pronunciation?.normalizedPhoneErrorRate ?? null)}
          tooltip={help.pronunciationPer}
        />
        <AudioMetric
          label="Laut-S / D / I"
          value={measured
            ? `${formatAudioInteger(pronunciation.substitutions)} / ${formatAudioInteger(pronunciation.deletions)} / ${formatAudioInteger(pronunciation.insertions)}`
            : "Nicht gemessen"}
          tooltip={help.pronunciationEdits}
        />
        <AudioMetric
          label="Laut-Editdistanz"
          value={measured ? formatAudioInteger(pronunciation.editDistance) : "Nicht gemessen"}
          tooltip={help.pronunciationEditDistance}
        />
        <AudioMetric
          label="Referenz- / Hypothesentokens"
          value={measured
            ? `${formatAudioInteger(pronunciation.referenceTokenCount)} / ${formatAudioInteger(pronunciation.hypothesisTokenCount)}`
            : "Nicht gemessen"}
          tooltip={help.pronunciationTokenCounts}
        />
        <AudioMetric
          label="Messmethode"
          value={pronunciation?.method ?? "Nicht gemessen"}
          tooltip={help.pronunciationMethod}
        />
        <AudioMetric
          label="Evaluationsmodus"
          value={pronunciation?.evaluationMode ?? "Nicht gemessen"}
          tooltip={help.pronunciationMode}
        />
      </dl>
    </section>
  );
}

function Eligibility({ eligibility, headingId, noteId, claimScope }: {
  eligibility: PublicT2aIa2vEligibility;
  headingId: string;
  noteId: string;
  claimScope: T2aAudioPublicAnalysisRecord["claimScope"];
}) {
  const development = claimScope === "development";
  const eligible = !development && eligibility.status === "eligible";
  return (
    <section
      className={`audio-quality__eligibility ${development ? "is-development" : eligible ? "is-eligible" : "is-blocked"}`}
      aria-labelledby={headingId}
    >
      <div className="audio-quality__eligibility-heading">
        {eligible ? <ShieldCheck size={16} aria-hidden="true" /> : <ShieldAlert size={16} aria-hidden="true" />}
        <div>
          <h3 id={headingId}>
            {development
              ? "Technische Messwerte · IA2V und Product-GO gesperrt"
              : eligible
                ? "Technischer IA2V-Vorfilter bestanden"
                : "Technischer IA2V-Vorfilter gesperrt"}
          </h3>
          <p>{development
            ? "Die Rohmesswerte bleiben sichtbar. Diese nicht attestierte Entwicklungs-Messung ist keine Release-Entscheidung."
            : eligible
              ? "Die gemessenen Audio-Kriterien sind erfüllt."
              : "Mindestens ein technisches Audio-Kriterium ist nicht erfüllt."}</p>
        </div>
        <InfoTooltip text={help.eligibility} />
      </div>
      {eligibility.blockers.length > 0 ? (
        <ul className="audio-quality__blockers" aria-label="Technische IA2V-Blocker">
          {eligibility.blockers.map((blocker) => (
            <li key={blocker}>{T2A_IA2V_BLOCKER_LABELS[blocker]}</li>
          ))}
        </ul>
      ) : null}
      <div className="audio-quality__handoff">
        <button
          type="button"
          className="button button--secondary"
          disabled
          aria-describedby={noteId}
          title={development
            ? "Entwicklungsmessungen dürfen keine IA2V-Freigabe erteilen"
            : "Noch keine unveränderlich servergebundene abgeleitete Audiodatei vorhanden"}
        >
          Audio für IA2V bereitstellen
        </button>
        <p id={noteId}>
          {development
            ? "Dauerhaft gesperrt: Die Entwicklungs-Runtime ist nicht attestiert. Diese Messung kann weder Product-GO noch IA2V freigeben; dafür ist eine neue attestierte Release-Messung erforderlich."
            : "Noch gesperrt: Der Server muss zuerst eine unveränderlich gebundene abgeleitete Audiodatei erzeugen. Der technische Vorfilter allein aktiviert die Weitergabe nicht."}
        </p>
      </div>
    </section>
  );
}

export function AudioQualityPanel({
  outputName,
  analysis,
  capability,
  onStart,
  onCancel,
}: AudioQualityPanelProps) {
  const headingId = useId();
  const wordMetricsHeadingId = useId();
  const independentIpaHeadingId = useId();
  const pronunciationHeadingId = useId();
  const signalMetricsHeadingId = useId();
  const eligibilityHeadingId = useId();
  const handoffNoteId = useId();
  const capabilityBlockerId = useId();
  const [pending, setPending] = useState<"start" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const presentation = presentT2aAudioAnalysis(analysis);
  const active = presentation.state === "queued" || presentation.state === "running";
  const developmentContext = presentation.claimScope === "development"
    || capability?.claimScope === "development";
  const effectiveClaimScope = developmentContext
    ? "development"
    : presentation.claimScope ?? capability?.claimScope ?? null;
  const measurementReady = capability?.measurementReady === true;
  const statusTone = developmentContext && presentation.tone === "success"
    ? "pending"
    : presentation.tone;
  const statusLabel = developmentContext && presentation.state === "measured"
    ? "Entwicklungs-Messung abgeschlossen · keine Freigabe"
    : presentation.label;

  const start = async () => {
    setPending("start");
    setActionError(null);
    try {
      await onStart(presentation.canRetry);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Audioanalyse konnte nicht gestartet werden.");
    } finally {
      setPending(null);
    }
  };

  const cancel = async () => {
    if (!analysis) return;
    setPending("cancel");
    setActionError(null);
    try {
      await onCancel(analysis.analysisId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Audioanalyse konnte nicht abgebrochen werden.");
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      className="audio-quality"
      aria-labelledby={headingId}
      data-output-name={outputName}
      data-claim-scope={effectiveClaimScope ?? "none"}
    >
      <div className="audio-quality__heading">
        <div>
          <h2 id={headingId}><AudioLines size={16} aria-hidden="true" /> Audio-Qualitätsanalyse</h2>
          <InfoTooltip text={help.panel} />
        </div>
        <span
          className={`audio-quality__status audio-quality__status--${statusTone}`}
          role="status"
          aria-live="polite"
        >
          {statusLabel}
        </span>
      </div>

      {developmentContext ? (
        <div className="audio-quality__development-warning" role="note">
          <ShieldAlert size={16} aria-hidden="true" />
          <div>
            <strong>ENTWICKLUNGSMESSUNG · nicht attestiert</strong>
            <span>Nur technische Rohmesswerte. Keine Release-, Product-GO- oder IA2V-Freigabe.</span>
          </div>
        </div>
      ) : null}

      {!measurementReady ? (
        <p className="audio-quality__capability-blocker" id={capabilityBlockerId} role="note">
          <strong>Audioanalyse nicht startbereit.</strong>{" "}
          {capability?.message
            ?? "Der Evaluatorstatus wird noch geladen. Bis zur bestätigten Messbereitschaft bleibt der Start gesperrt."}
        </p>
      ) : null}

      {active ? (
        <div
          className="audio-quality__progress"
          role="progressbar"
          aria-label="Fortschritt der Audioanalyse"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={presentation.progress ?? 0}
        >
          <LoaderCircle className="spin" size={15} aria-hidden="true" />
          <span>{statusLabel}</span>
          <strong>{presentation.progress ?? 0} %</strong>
        </div>
      ) : null}

      {presentation.measurement ? (
        <>
          <WordMetrics measurement={presentation.measurement} headingId={wordMetricsHeadingId} />
          <IndependentIpaMeasurement
            measurement={presentation.measurement}
            headingId={independentIpaHeadingId}
          />
          <PronunciationMeasurement
            measurement={presentation.measurement}
            headingId={pronunciationHeadingId}
          />
          <SignalMetrics measurement={presentation.measurement} headingId={signalMetricsHeadingId} />
        </>
      ) : null}

      {presentation.eligibility ? (
        <Eligibility
          eligibility={presentation.eligibility}
          headingId={eligibilityHeadingId}
          noteId={handoffNoteId}
          claimScope={effectiveClaimScope ?? "sealed-release"}
        />
      ) : null}

      {presentation.error ? (
        <p className="audio-quality__error" role="alert">{presentation.error}</p>
      ) : null}
      {actionError ? <p className="audio-quality__error" role="alert">{actionError}</p> : null}

      <div className="audio-quality__actions">
        {active ? (
          <button
            type="button"
            className="button button--secondary"
            disabled={pending !== null}
            onClick={() => void cancel()}
          >
            {pending === "cancel"
              ? <LoaderCircle className="spin" size={14} aria-hidden="true" />
              : <CircleStop size={14} aria-hidden="true" />}
            Audioanalyse abbrechen
          </button>
        ) : (
          <button
            type="button"
            className="button button--secondary"
            disabled={pending !== null || !measurementReady}
            aria-describedby={!measurementReady ? capabilityBlockerId : undefined}
            onClick={() => void start()}
          >
            {pending === "start"
              ? <LoaderCircle className="spin" size={14} aria-hidden="true" />
              : <RefreshCw size={14} aria-hidden="true" />}
            {presentation.canRetry ? "Audio erneut analysieren" : "Audio analysieren"}
          </button>
        )}
        <span>Offline-Analyse des veröffentlichten WAV-Signals</span>
      </div>
    </section>
  );
}
