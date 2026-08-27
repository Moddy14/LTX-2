import {
  CircleCheck,
  CircleX,
  EyeOff,
  LoaderCircle,
  Pause,
  Play,
  ShieldCheck,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  blindEvaluationPublicStateSha256,
  extendBlindPlaybackCoverage,
  summarizeBlindPlaybackCoverage,
  verifyBlindEvaluationReveal,
  type BlindEvaluationActivePublic,
  type BlindEvaluationInitialPin,
  type BlindEvaluationPublic,
  type BlindEvaluationSubmissionPin,
  type BlindEvaluationSubmissionInput,
  type BlindEvaluationSubmittedPublic,
  type BlindEvaluationTimelineCoverage,
  type BlindEvaluationVerification,
} from "../../shared/blindEvaluation";
import {
  abortBlindEvaluation,
  blindEvaluationNavigation,
  claimBlindEvaluation,
  getBlindEvaluation,
  newBlindEvaluationIdempotencyKey,
  readBlindEvaluationSubmissionPin,
  releaseBlindEvaluationScope,
  submitBlindEvaluation,
} from "../api";

type Channel = "x" | "y";
type PlaybackRate = 1 | 0.5;
type AudioSource = Channel | "muted";
type ScoreKey = keyof BlindEvaluationSubmissionInput["scores"]["x"];
type Preference = BlindEvaluationSubmissionInput["preference"];
type Observation = {
  durationMilliseconds: number;
  normalSpeed: BlindEvaluationTimelineCoverage;
  halfSpeed: BlindEvaluationTimelineCoverage;
  audibleNormalSpeed: BlindEvaluationTimelineCoverage;
  audibleHalfSpeed: BlindEvaluationTimelineCoverage;
};
type CoverageKey = Exclude<keyof Observation, "durationMilliseconds">;

const scoreLabels: Record<ScoreKey, string> = {
  timing: "Laut-/Lippen-Timing",
  mouthIntegration: "Mundintegration",
  eyesIdentity: "Augen / Identität",
  resolutionDetail: "Auflösung / Details",
};

const blankCoverage = (): BlindEvaluationTimelineCoverage => ({
  intervals: [],
  uniqueCoverageMilliseconds: 0,
  coverageRatio: 0,
  ended: false,
});

const blankObservation = (durationMilliseconds = 0): Observation => ({
  durationMilliseconds,
  normalSpeed: blankCoverage(),
  halfSpeed: blankCoverage(),
  audibleNormalSpeed: blankCoverage(),
  audibleHalfSpeed: blankCoverage(),
});

const blankScores = (): Record<Channel, Record<ScoreKey, string>> => ({
  x: { timing: "", mouthIntegration: "", eyesIdentity: "", resolutionDetail: "" },
  y: { timing: "", mouthIntegration: "", eyesIdentity: "", resolutionDetail: "" },
});

function clock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safe / 60);
  return `${minutes}:${String(Math.floor(safe % 60)).padStart(2, "0")}`;
}

function isPreference(value: string): value is Preference {
  return value === "x" || value === "y" || value === "tie";
}

function trapFocus(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
    "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  if (focusable.length === 0) {
    event.preventDefault();
    event.currentTarget.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function publicResponseMatchesPin(
  evaluation: BlindEvaluationPublic,
  pin: BlindEvaluationInitialPin,
): Promise<boolean> {
  return evaluation.id === pin.id
    && evaluation.commitment === pin.commitment
    && await blindEvaluationPublicStateSha256(evaluation) === pin.publicStateSha256;
}

function ScoreSelect({
  channel,
  metric,
  value,
  onChange,
}: {
  channel: Channel;
  metric: ScoreKey;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="blind-evaluation__score">
      <span>{channel.toUpperCase()} · {scoreLabels[metric]}</span>
      <select
        aria-label={`${channel.toUpperCase()} ${scoreLabels[metric]}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">–</option>
        {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => (
          <option key={score} value={score}>{score} / 10</option>
        ))}
      </select>
    </label>
  );
}

function RevealDialog({
  evaluation,
  initialPin,
  submissionPin,
  onClose,
}: {
  evaluation: BlindEvaluationSubmittedPublic;
  initialPin: BlindEvaluationInitialPin;
  submissionPin: BlindEvaluationSubmissionPin;
  onClose: () => void;
}) {
  const [verification, setVerification] = useState<BlindEvaluationVerification | null>(null);
  useEffect(() => {
    let current = true;
    void verifyBlindEvaluationReveal(evaluation, initialPin, submissionPin).then((result) => {
      if (current) setVerification(result);
    });
    return () => { current = false; };
  }, [evaluation, initialPin, submissionPin]);
  const valid = verification?.valid === true;
  return (
    <div className="blind-evaluation blind-evaluation--revealed" role="dialog" aria-modal="true"
      aria-label="Aufgedeckte Blindbewertung" tabIndex={-1}>
      <div className="blind-evaluation__heading">
        <h2>{valid ? <CircleCheck size={18} /> : <CircleX size={18} />} Kryptografisches Reveal</h2>
        <span>{valid ? "v5 verifiziert" : "fail-closed"}</span>
      </div>
      <p className="blind-evaluation__notice">{evaluation.limitation}</p>
      <p className="blind-evaluation__notice">{evaluation.threatModel}</p>
      <div className="blind-evaluation__reveal">
        {verification === null ? <span>Commitment, initialen Browser-Pin und Submission nachrechnen …</span> : null}
        {valid ? (
          <>
            <strong>Commitment, Browser-Pin und Submission clientseitig erfolgreich nachgerechnet.</strong>
            <span>X war {evaluation.reveal.commitmentPreimage.mapping.x === "baseline" ? "Baseline" : "Kandidat"}: <code>
              {evaluation.reveal.commitmentPreimage.arms[evaluation.reveal.commitmentPreimage.mapping.x].outputName}
            </code></span>
            <span>Y war {evaluation.reveal.commitmentPreimage.mapping.y === "baseline" ? "Baseline" : "Kandidat"}: <code>
              {evaluation.reveal.commitmentPreimage.arms[evaluation.reveal.commitmentPreimage.mapping.y].outputName}
            </code></span>
            <span>Beide Arme wurden mit demselben gebundenen v5-Transportprofil ausgeliefert.</span>
          </>
        ) : null}
        {verification && !valid ? verification.errors.map((error) => (
          <span key={error} className="blind-evaluation__media-error" role="alert">{error}</span>
        )) : null}
      </div>
      <div className="blind-evaluation__footer">
        <code>Initialer Pin {initialPin.publicStateSha256.slice(0, 16)}…</code>
        <button type="button" className="button" onClick={onClose}>Zurück zum Studio</button>
      </div>
    </div>
  );
}

function ActiveDialog({
  evaluation,
  initialPin,
  onChange,
  onClose,
}: {
  evaluation: BlindEvaluationActivePublic;
  initialPin: BlindEvaluationInitialPin;
  onChange: (evaluation: BlindEvaluationSubmittedPublic, submissionPin: BlindEvaluationSubmissionPin) => void;
  onClose: () => void;
}) {
  const refs = {
    x: useRef<HTMLVideoElement>(null),
    y: useRef<HTMLVideoElement>(null),
  };
  const lastTimes = useRef<Record<Channel, number | null>>({ x: null, y: null });
  const playingRef = useRef<Record<Channel, boolean>>({ x: false, y: false });
  const [loaded, setLoaded] = useState<Record<Channel, boolean>>({ x: false, y: false });
  const [played, setPlayed] = useState<Record<Channel, boolean>>({ x: false, y: false });
  const [playing, setPlaying] = useState<Record<Channel, boolean>>({ x: false, y: false });
  const [durations, setDurations] = useState<Record<Channel, number>>({ x: 0, y: 0 });
  const [currentTimes, setCurrentTimes] = useState<Record<Channel, number>>({ x: 0, y: 0 });
  const [mediaErrors, setMediaErrors] = useState<Record<Channel, string | null>>({ x: null, y: null });
  const [playbackRate, setPlaybackRate] = useState<PlaybackRate>(1);
  const [audioSource, setAudioSource] = useState<AudioSource>("x");
  const [observed, setObserved] = useState<Record<Channel, Observation>>({
    x: blankObservation(),
    y: blankObservation(),
  });
  const [normalAcknowledged, setNormalAcknowledged] = useState(false);
  const [halfAcknowledged, setHalfAcknowledged] = useState(false);
  const [audioAcknowledged, setAudioAcknowledged] = useState<Record<Channel, boolean>>({ x: false, y: false });
  const [humanAttested, setHumanAttested] = useState(false);
  const [scores, setScores] = useState(blankScores);
  const [preference, setPreference] = useState<Preference | "">("");
  const [confidence, setConfidence] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitIdempotencyKey = useRef(
    readBlindEvaluationSubmissionPin(evaluation.id)?.idempotencyKey
      ?? newBlindEvaluationIdempotencyKey(),
  );

  const setChannelPlaying = (channel: Channel, value: boolean) => {
    playingRef.current[channel] = value;
    lastTimes.current[channel] = value ? refs[channel].current?.currentTime ?? null : null;
    setPlaying((current) => ({ ...current, [channel]: value }));
  };

  const toggleChannel = async (channel: Channel) => {
    const video = refs[channel].current;
    if (!video || !loaded[channel] || mediaErrors[channel]) return;
    if (playingRef.current[channel]) {
      video.pause();
      setChannelPlaying(channel, false);
      return;
    }
    const other: Channel = channel === "x" ? "y" : "x";
    refs[other].current?.pause();
    setChannelPlaying(other, false);
    video.playbackRate = playbackRate;
    try {
      await video.play();
      if (video.paused || video.ended || video.readyState < 2) {
        throw new Error("Wiedergabe wurde nicht gestartet.");
      }
      setPlayed((current) => ({ ...current, [channel]: true }));
      setChannelPlaying(channel, true);
      setError(null);
    } catch {
      setChannelPlaying(channel, false);
      setMediaErrors((current) => ({
        ...current,
        [channel]: `Wiedergabe von Video ${channel.toUpperCase()} ist fehlgeschlagen.`,
      }));
    }
  };

  const coverageFields = (video: HTMLVideoElement): { watched: CoverageKey; audible: CoverageKey } =>
    video.playbackRate < 0.75
      ? { watched: "halfSpeed", audible: "audibleHalfSpeed" }
      : { watched: "normalSpeed", audible: "audibleNormalSpeed" };

  const observe = (channel: Channel, allowEnded = false) => {
    const video = refs[channel].current;
    if (!video || !playingRef.current[channel]
      || (!allowEnded && (video.paused || video.ended)) || video.readyState < 2) return;
    const previous = lastTimes.current[channel];
    const delta = previous === null ? 0 : video.currentTime - previous;
    lastTimes.current[channel] = video.currentTime;
    setCurrentTimes((current) => ({ ...current, [channel]: video.currentTime }));
    if (delta <= 0 || delta > 0.75) return;
    const { watched, audible } = coverageFields(video);
    const isAudible = audioSource === channel && !video.muted && video.volume > 0;
    const startMilliseconds = Math.ceil(previous! * 1_000);
    const endMilliseconds = Math.floor(video.currentTime * 1_000);
    const durationMilliseconds = Math.round(video.duration * 1_000);
    if (!Number.isInteger(durationMilliseconds) || durationMilliseconds <= 0) return;
    setObserved((current) => {
      const channelObservation = current[channel].durationMilliseconds === durationMilliseconds
        ? current[channel]
        : blankObservation(durationMilliseconds);
      return {
        ...current,
        [channel]: {
        ...channelObservation,
        [watched]: extendBlindPlaybackCoverage(
          channelObservation[watched],
          durationMilliseconds,
          startMilliseconds,
          endMilliseconds,
        ),
        ...(isAudible ? {
          [audible]: extendBlindPlaybackCoverage(
            channelObservation[audible],
            durationMilliseconds,
            startMilliseconds,
            endMilliseconds,
          ),
        } : {}),
      },
      };
    });
  };

  const finishPlayback = (channel: Channel) => {
    const video = refs[channel].current;
    if (!video) return;
    observe(channel, true);
    const { watched, audible } = coverageFields(video);
    const isAudible = audioSource === channel && !video.muted && video.volume > 0;
    const durationMilliseconds = Math.round(video.duration * 1_000);
    if (!Number.isInteger(durationMilliseconds) || durationMilliseconds <= 0) return;
    setObserved((current) => ({
      ...current,
      [channel]: {
        ...current[channel],
        [watched]: summarizeBlindPlaybackCoverage(
          current[channel][watched].intervals,
          durationMilliseconds,
          true,
        ),
        ...(isAudible ? {
          [audible]: summarizeBlindPlaybackCoverage(
            current[channel][audible].intervals,
            durationMilliseconds,
            true,
          ),
        } : {}),
      },
    }));
    setChannelPlaying(channel, false);
  };

  const selectPlaybackRate = (rate: PlaybackRate) => {
    setPlaybackRate(rate);
    for (const channel of ["x", "y"] as const) {
      if (refs[channel].current) refs[channel].current.playbackRate = rate;
      lastTimes.current[channel] = null;
    }
  };

  const selectAudio = (source: AudioSource) => {
    setAudioSource(source);
    if (refs.x.current) refs.x.current.muted = source !== "x";
    if (refs.y.current) refs.y.current.muted = source !== "y";
  };

  const timeline = evaluation.requirements.timelineCoverage;
  const coverageReady = (coverage: BlindEvaluationTimelineCoverage, minimumRatio: number) =>
    coverage.coverageRatio + 1e-9 >= minimumRatio && (!timeline.endedRequired || coverage.ended);
  const normalReady = (["x", "y"] as const).every((channel) =>
    coverageReady(observed[channel].normalSpeed, timeline.normalMinimumRatio));
  const halfReady = (["x", "y"] as const).every((channel) =>
    coverageReady(observed[channel].halfSpeed, timeline.halfMinimumRatio));
  const audioReady = (channel: Channel) =>
    coverageReady(observed[channel].audibleNormalSpeed, timeline.audibleNormalMinimumRatio)
    && coverageReady(observed[channel].audibleHalfSpeed, timeline.audibleHalfMinimumRatio);
  const scoresComplete = (["x", "y"] as const).every((channel) =>
    (Object.keys(scoreLabels) as ScoreKey[]).every((metric) => scores[channel][metric] !== ""));
  const canSubmit = loaded.x && loaded.y && played.x && played.y
    && !mediaErrors.x && !mediaErrors.y && normalReady && halfReady
    && audioReady("x") && audioReady("y") && normalAcknowledged && halfAcknowledged
    && audioAcknowledged.x && audioAcknowledged.y && humanAttested && scoresComplete
    && preference !== "" && confidence !== "" && !busy;

  const submit = async () => {
    if (!canSubmit || !isPreference(preference)) return;
    setBusy(true);
    setError(null);
    try {
      const numericScores = (channel: Channel) => ({
        timing: Number(scores[channel].timing),
        mouthIntegration: Number(scores[channel].mouthIntegration),
        eyesIdentity: Number(scores[channel].eyesIdentity),
        resolutionDetail: Number(scores[channel].resolutionDetail),
      });
      const playback = (channel: Channel) => ({
        ...observed[channel],
        mediaLoaded: true as const,
        playSucceeded: true as const,
        audioReviewed: true as const,
      });
      const submitted = await submitBlindEvaluation(evaluation.id, {
        scores: { x: numericScores("x"), y: numericScores("y") },
        preference,
        confidence: Number(confidence),
        note,
        playback: {
          x: playback("x"),
          y: playback("y"),
          normalSpeedReviewed: true,
          halfSpeedReviewed: true,
          humanObservationAttested: true,
        },
      }, initialPin, submitIdempotencyKey.current);
      const { evaluation: updated, submissionPin } = submitted;
      if (updated.status !== "submitted" || !await publicResponseMatchesPin(updated, initialPin)) {
        throw new Error("Die Submit-Antwort weicht vom initial fixierten Browser-Pin ab.");
      }
      const verification = await verifyBlindEvaluationReveal(updated, initialPin, submissionPin);
      if (!verification.valid) {
        throw new Error(verification.errors.join(" "));
      }
      onChange(updated, submissionPin);
    } catch (reason) {
      try {
        const recovered = await getBlindEvaluation(evaluation.id);
        if (recovered.status === "submitted" && await publicResponseMatchesPin(recovered, initialPin)) {
          const submissionPin = readBlindEvaluationSubmissionPin(evaluation.id);
          const verification = await verifyBlindEvaluationReveal(recovered, initialPin, submissionPin);
          if (verification.valid) {
            onChange(recovered, submissionPin!);
            return;
          }
        }
      } catch {
        // The original submit error remains authoritative if GET recovery also fails.
      }
      setError(reason instanceof Error ? reason.message : "Blindbewertung konnte nicht gespeichert werden.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="blind-evaluation" role="dialog" aria-modal="true" aria-label="Verblindeter X/Y-Vergleich" tabIndex={-1}>
      <div className="blind-evaluation__heading">
        <h2><EyeOff size={17} /> Verblindeter X/Y-Vergleich</h2>
        <span>v5 Evaluator-Scope</span>
      </div>
      <p className="blind-evaluation__intro">
        Armzuordnung, Dateinamen, Einstellungen und objektive Scores bleiben bis zur einmaligen Abgabe verborgen.
      </p>
      <p className="blind-evaluation__notice">{evaluation.limitation}</p>
      <p className="blind-evaluation__notice">{evaluation.threatModel}</p>
      <div className="blind-evaluation__media">
        {(["x", "y"] as const).map((channel) => (
          <figure key={channel}>
            <video
              ref={refs[channel]}
              src={evaluation.media[channel]}
              muted={audioSource !== channel}
              playsInline
              preload="metadata"
              tabIndex={-1}
              onLoadedMetadata={(event) => {
                const value = event.currentTarget.duration;
                if (!Number.isFinite(value) || value <= 0) {
                  setMediaErrors((current) => ({ ...current, [channel]: `Video ${channel.toUpperCase()} hat keine gültige Laufzeit.` }));
                  return;
                }
                const durationMilliseconds = Math.round(value * 1_000);
                setDurations((current) => ({ ...current, [channel]: value }));
                setObserved((current) => ({
                  ...current,
                  [channel]: current[channel].durationMilliseconds === durationMilliseconds
                    ? current[channel]
                    : blankObservation(durationMilliseconds),
                }));
              }}
              onCanPlay={() => {
                setLoaded((current) => ({ ...current, [channel]: true }));
                setMediaErrors((current) => ({ ...current, [channel]: null }));
              }}
              onPlaying={() => setChannelPlaying(channel, true)}
              onPause={(event) => {
                if (!event.currentTarget.ended) setChannelPlaying(channel, false);
              }}
              onSeeking={() => { lastTimes.current[channel] = null; }}
              onEnded={() => finishPlayback(channel)}
              onTimeUpdate={() => observe(channel)}
              onError={() => {
                setLoaded((current) => ({ ...current, [channel]: false }));
                setChannelPlaying(channel, false);
                setMediaErrors((current) => ({ ...current, [channel]: `Video ${channel.toUpperCase()} konnte nicht geladen werden.` }));
              }}
            />
            <figcaption>Video {channel.toUpperCase()}</figcaption>
            <button type="button" className="blind-evaluation__channel-play"
              title={`${playing[channel] ? "Video pausieren" : "Video abspielen"} ${channel.toUpperCase()}`}
              disabled={!loaded[channel] || Boolean(mediaErrors[channel])}
              onClick={() => void toggleChannel(channel)}>
              {playing[channel] ? <Pause size={14} /> : <Play size={14} />}
              {playing[channel] ? "Pausieren" : "Abspielen"} {channel.toUpperCase()}
            </button>
            <span className="blind-evaluation__channel-time">
              {clock(currentTimes[channel])} / {clock(durations[channel])}
            </span>
            {mediaErrors[channel] ? <span className="blind-evaluation__media-error" role="alert">{mediaErrors[channel]}</span> : null}
          </figure>
        ))}
      </div>
      <div className="blind-evaluation__controls" aria-label="Getrennte verblindete Wiedergabesteuerung">
        <div className="blind-evaluation__toggle" aria-label="Wiedergabegeschwindigkeit">
          {([1, 0.5] as const).map((rate) => (
            <button key={rate} type="button" className={playbackRate === rate ? "is-active" : ""}
              aria-pressed={playbackRate === rate} onClick={() => selectPlaybackRate(rate)}>
              {rate === 1 ? "1×" : "0,5×"}
            </button>
          ))}
        </div>
        <div className="blind-evaluation__toggle" aria-label="Verblindeter Vergleichston">
          {(["x", "y"] as const).map((channel) => (
            <button key={channel} type="button" className={audioSource === channel ? "is-active" : ""}
              aria-pressed={audioSource === channel} title={`Ton von Video ${channel.toUpperCase()}`}
              onClick={() => selectAudio(channel)}>
              <Volume2 size={13} /> {channel.toUpperCase()}
            </button>
          ))}
          <button type="button" className={audioSource === "muted" ? "is-active" : ""}
            aria-pressed={audioSource === "muted"} title="Vergleich stummschalten"
            onClick={() => selectAudio("muted")}><VolumeX size={13} /></button>
        </div>
      </div>
      <div className="blind-evaluation__playback-gates">
        <span className={normalReady ? "is-ready" : "is-waiting"}>
          1× eindeutige Timeline: X {(observed.x.normalSpeed.coverageRatio * 100).toFixed(0)}%, Y {(observed.y.normalSpeed.coverageRatio * 100).toFixed(0)}% / {(timeline.normalMinimumRatio * 100).toFixed(0)}% + Ende
        </span>
        <span className={halfReady ? "is-ready" : "is-waiting"}>
          0,5× eindeutige Timeline: X {(observed.x.halfSpeed.coverageRatio * 100).toFixed(0)}%, Y {(observed.y.halfSpeed.coverageRatio * 100).toFixed(0)}% / {(timeline.halfMinimumRatio * 100).toFixed(0)}% + Ende
        </span>
        {(["x", "y"] as const).map((channel) => (
          <label key={channel}>
            <input type="checkbox" checked={audioAcknowledged[channel]} disabled={!audioReady(channel)}
              aria-label={`Ton und Lippen von Video ${channel.toUpperCase()} bewusst verglichen`}
              onChange={(event) => setAudioAcknowledged((current) => ({ ...current, [channel]: event.target.checked }))} />
            Ton und Lippen von {channel.toUpperCase()} bei 1× und 0,5× bewusst gehört und gesehen
          </label>
        ))}
        <label><input type="checkbox" checked={normalAcknowledged} disabled={!normalReady}
          onChange={(event) => setNormalAcknowledged(event.target.checked)} />X und Y bei 1× bewusst verglichen</label>
        <label><input type="checkbox" checked={halfAcknowledged} disabled={!halfReady}
          onChange={(event) => setHalfAcknowledged(event.target.checked)} />Mund, Augen und Übergänge bei 0,5× geprüft</label>
        <label><input type="checkbox" checked={humanAttested} disabled={!audioAcknowledged.x || !audioAcknowledged.y}
          onChange={(event) => setHumanAttested(event.target.checked)} />Ich bestätige diese menschliche Beobachtung; sie ist kein automatischer Wahrnehmungsbeweis</label>
      </div>
      <div className="blind-evaluation__score-grid">
        {(["x", "y"] as const).flatMap((channel) => (Object.keys(scoreLabels) as ScoreKey[]).map((metric) => (
          <ScoreSelect key={`${channel}-${metric}`} channel={channel} metric={metric}
            value={scores[channel][metric]} onChange={(value) => setScores((current) => ({
              ...current,
              [channel]: { ...current[channel], [metric]: value },
            }))} />
        )))}
      </div>
      <div className="blind-evaluation__decision">
        <label><span>Gesamtpräferenz</span><select aria-label="Gesamtpräferenz" value={preference}
          onChange={(event) => setPreference(event.target.value as typeof preference)}>
          <option value="">Bitte wählen</option><option value="x">X</option><option value="y">Y</option><option value="tie">Gleichstand</option>
        </select></label>
        <label><span>Sicherheit der Bewertung</span><select aria-label="Sicherheit der Bewertung" value={confidence}
          onChange={(event) => setConfidence(event.target.value)}>
          <option value="">Bitte wählen</option>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} / 5</option>)}
        </select></label>
      </div>
      <label className="blind-evaluation__note"><span>Beobachtungsnotiz</span><textarea aria-label="Beobachtungsnotiz"
        value={note} maxLength={2_000} placeholder="Konkrete sicht- und hörbare Unterschiede …"
        onChange={(event) => setNote(event.target.value)} /></label>
      <div className="blind-evaluation__footer">
        <code>Initialer Pin {initialPin.publicStateSha256.slice(0, 16)}…</code>
        <div>
          <button type="button" className="button button--secondary" disabled={busy} onClick={onClose}>Bewertung verlassen</button>
          <button type="button" className="button" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}Einmalig abgeben und aufdecken
          </button>
        </div>
      </div>
      {error ? <p className="section-error" role="alert">{error}</p> : null}
    </div>
  );
}

export function BlindEvaluationApp({
  routeSessionId,
  initialPin,
  initialEvaluation,
}: {
  routeSessionId: string;
  initialPin: BlindEvaluationInitialPin | null;
  initialEvaluation?: BlindEvaluationPublic;
}) {
  const scopeRef = useRef<HTMLElement>(null);
  const [evaluation, setEvaluation] = useState<BlindEvaluationPublic | null>(initialEvaluation ?? null);
  const [submissionPin, setSubmissionPin] = useState<BlindEvaluationSubmissionPin | null>(
    () => readBlindEvaluationSubmissionPin(routeSessionId),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      scopeRef.current?.querySelector<HTMLElement>(
        "button:not([disabled]), select:not([disabled]), textarea:not([disabled]), input:not([disabled])",
      )?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [evaluation, error]);

  useEffect(() => {
    let current = true;
    if (initialEvaluation?.status === "creating") {
      if (initialPin || routeSessionId !== initialEvaluation.id) {
        setError("Creating-Route, v5-Reservation und Browser-Pin widersprechen sich.");
        return () => { current = false; };
      }
      void (async () => {
        let loaded: BlindEvaluationPublic = initialEvaluation;
        while (current && loaded.status === "creating") {
          if (loaded.creation.phase === "reserved") {
            try {
              loaded = await claimBlindEvaluation(routeSessionId);
            } catch {
              // A lost claim response is recovered from the durable creating/active record.
              loaded = await getBlindEvaluation(routeSessionId);
            }
          } else {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
            if (current) loaded = await getBlindEvaluation(routeSessionId);
          }
          if (current && loaded.status === "creating" && loaded.creation.phase === "reserved") {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
          }
        }
        if (!current) return;
        if (loaded.status !== "active") {
          throw new Error("Eine terminale v5-Session kann ohne ihren ursprünglichen Browser-Pin nicht rekonstruiert werden.");
        }
        const navigation = await blindEvaluationNavigation(loaded);
        if (!navigation.pin) throw new Error("Der dauerhafte v5-Claim lieferte keinen initialen Browser-Pin.");
        window.dispatchEvent(new CustomEvent("ltx-studio:hard-navigation", {
          detail: { href: navigation.href },
        }));
      })().catch((reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : "v5-Reservation konnte nicht sicher geclaimt werden.");
      });
      return () => { current = false; };
    }
    if (!initialPin || routeSessionId !== initialPin.id) {
      setError("Evaluator-URL und initialer v5-Browser-Pin fehlen oder widersprechen sich.");
      return () => { current = false; };
    }
    void getBlindEvaluation(routeSessionId).then(async (loaded) => {
      if (!await publicResponseMatchesPin(loaded, initialPin)) {
        throw new Error("Die geladene v5-Session weicht vom initialen Browser-Pin ab.");
      }
      if (loaded.status === "submitted") {
        const durableSubmissionPin = readBlindEvaluationSubmissionPin(routeSessionId);
        const verification = await verifyBlindEvaluationReveal(loaded, initialPin, durableSubmissionPin);
        if (!verification.valid) throw new Error(verification.errors.join(" "));
        if (current) setSubmissionPin(durableSubmissionPin);
      }
      if (current) setEvaluation(loaded);
    }).catch((reason: unknown) => {
      if (current) setError(reason instanceof Error ? reason.message : "v5-Blind-Session konnte nicht sicher geladen werden.");
    });
    return () => { current = false; };
  }, [initialEvaluation, initialPin, routeSessionId]);

  const closeScope = async (abort: boolean) => {
    try {
      if (abort) await abortBlindEvaluation(routeSessionId);
      else await releaseBlindEvaluationScope(routeSessionId);
    } catch {
      await releaseBlindEvaluationScope(routeSessionId).catch(() => undefined);
    } finally {
      window.location.replace("/");
    }
  };

  let content: React.ReactNode;
  if (!error && evaluation?.status === "creating") {
    content = (
      <div className="blind-evaluation" role="status">
        <div className="blind-evaluation__heading"><h2><LoaderCircle className="spin" size={18} /> v5-Session vorbereiten</h2></div>
        <p>Die Reservation ist dauerhaft capability-gebunden. Der globale Lock bleibt bis zum terminalen Publish oder Abbruch bestehen.</p>
        <button type="button" className="button button--secondary" onClick={() => void closeScope(true)}>
          Erstellung unwiderruflich abbrechen
        </button>
      </div>
    );
  } else if (error || !initialPin) {
    content = (
      <div className="blind-evaluation" role="alert">
        <div className="blind-evaluation__heading"><h2><CircleX size={18} /> Evaluator fail-closed</h2></div>
        <p className="blind-evaluation__media-error">{error ?? "Initialer v5-Browser-Pin fehlt."}</p>
        <button type="button" className="button" onClick={() => void closeScope(true)}>Bewertung unwiderruflich abbrechen</button>
      </div>
    );
  } else if (!evaluation) {
    content = <div className="blind-evaluation" role="status"><LoaderCircle className="spin" /> v5-Session und Browser-Pin prüfen …</div>;
  } else if (evaluation.status === "submitted") {
    content = submissionPin
      ? <RevealDialog evaluation={evaluation} initialPin={initialPin} submissionPin={submissionPin}
          onClose={() => void closeScope(false)} />
      : <div className="blind-evaluation" role="alert">Dauerhafter Browser-Submission-Pin fehlt; Reveal bleibt fail-closed.</div>;
  } else if (evaluation.status === "active") {
    content = <ActiveDialog evaluation={evaluation} initialPin={initialPin}
      onChange={(next, pin) => { setSubmissionPin(pin); setEvaluation(next); }}
      onClose={() => void closeScope(true)} />;
  } else {
    content = <div className="blind-evaluation" role="alert">Unbekannter v5-Evaluator-Zustand.</div>;
  }

  return (
    <main ref={scopeRef} className="blind-evaluation-scope" data-evaluator-role="blind-evaluator"
      tabIndex={-1} onKeyDown={trapFocus}>
      {content}
    </main>
  );
}
