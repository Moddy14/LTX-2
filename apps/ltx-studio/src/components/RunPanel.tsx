import {
  AlertTriangle,
  AudioLines,
  Camera,
  Check,
  CircleStop,
  Clock3,
  Columns2,
  Dices,
  Download,
  Film,
  FolderKanban,
  LoaderCircle,
  ListVideo,
  Pause,
  Play,
  Repeat2,
  ScanSearch,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Thermometer,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";

import { PIPELINES, type GenerationRequest } from "../../shared/pipelines";
import type { PlanSuggestion } from "../../shared/plan";
import { videoDurationSeconds } from "../../shared/presets";
import { isVideoPreviewUrl } from "../../shared/media";
import type {
  Health,
  ResourceEstimate,
  StudioJob,
  StudioOutput,
} from "../types";
import { qualityReviewAverage, type QualityReviewInput } from "../../shared/quality";
import type {
  ControlledExperiment,
  ExperimentCreateInput,
} from "../../shared/experiments";
import { isSpeechQualityCandidate } from "../qualityCandidates";
import { supportsSceneReference } from "../sceneReference";
import { importWithSingleReload } from "../lazyImport";
import { InfoTooltip } from "./Controls";
import { LazyPanelBoundary, LazyPanelLoading } from "./LazyPanelBoundary";

const ExperimentPanel = lazy(async () => ({
  default: (await importWithSingleReload("experiments", () => import("./ExperimentPanel"))).ExperimentPanel,
}));
const ProjectPanel = lazy(async () => ({
  default: (await importWithSingleReload("projects", () => import("./ProjectPanel"))).ProjectPanel,
}));
const ObjectiveAnalysisPanel = lazy(async () => ({
  default: (await importWithSingleReload("objective-analysis", () => import("./ObjectiveAnalysisPanel")))
    .ObjectiveAnalysisPanel,
}));
const ObjectiveComparisonPanel = lazy(async () => ({
  default: (await importWithSingleReload("objective-comparison", () => import("./ObjectiveComparisonPanel")))
    .ObjectiveComparisonPanel,
}));
const QualityScorecard = lazy(async () => ({
  default: (await importWithSingleReload("quality-scorecard", () => import("./QualityScorecard"))).QualityScorecard,
}));
const SynchronizedComparePreview = lazy(async () => ({
  default: (await importWithSingleReload("synchronized-compare", () => import("./SynchronizedComparePreview")))
    .SynchronizedComparePreview,
}));

const statusLabels: Record<StudioJob["status"], string> = {
  queued: "Wartet",
  running: "Läuft",
  paused: "Thermisch pausiert",
  completed: "Fertig",
  failed: "Fehler",
  cancelled: "Abgebrochen",
  interrupted: "Unterbrochen",
};

function StatusIcon({ status }: { status: StudioJob["status"] }) {
  if (status === "completed") return <Check size={14} />;
  if (status === "running") return <LoaderCircle className="spin" size={14} />;
  if (status === "paused") return <Pause size={14} fill="currentColor" />;
  if (status === "queued") return <Clock3 size={14} />;
  if (status === "failed" || status === "interrupted") return <AlertTriangle size={14} />;
  return <X size={14} />;
}

function formatRuntime(milliseconds: number | null): string {
  if (milliseconds === null) return "Noch nicht verfügbar";
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours} h ${String(minutes).padStart(2, "0")} min`
    : `${minutes} min ${String(remainder).padStart(2, "0")} s`;
}

function formatFileSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function hasLipSyncMeasurement(output: StudioOutput): boolean {
  const result = output.analysis?.status === "completed" ? output.analysis.result : null;
  return Boolean(result && "phonemeViseme" in result && result.phonemeViseme?.measurement);
}

function isAudioOutputName(name: string): boolean {
  return name.toLowerCase().endsWith(".wav");
}

function seekToInitialReferenceFrame(video: HTMLVideoElement): number {
  if (!Number.isFinite(video.duration) || video.duration <= 0 || video.currentTime > 0.001) {
    return video.currentTime;
  }
  const midpoint = Math.min(video.duration / 2, Math.max(0, video.duration - 0.04));
  video.currentTime = midpoint;
  return midpoint;
}

type RunPanelProps = {
  request: GenerationRequest;
  requestValid: boolean;
  health: Health | null;
  jobs: StudioJob[];
  outputs: StudioOutput[];
  selectedJob: StudioJob | null;
  selectedOutput: StudioOutput | null;
  onSelectJob: (job: StudioJob) => void;
  onSelectOutput: (output: StudioOutput) => void;
  onRun: () => void;
  onCancel: (id: string) => void;
  onDeleteJob: (job: StudioJob) => Promise<void>;
  deletingJobId: string | null;
  submitting: boolean;
  errors: string[];
  warnings: string[];
  suggestions: PlanSuggestion[];
  onApplySuggestion: (suggestion: PlanSuggestion) => void;
  command: string | null;
  previews: Record<string, string>;
  comparisonOutputs: StudioOutput[];
  comparisonNames: string[];
  onToggleCompare: (output: StudioOutput) => void;
  onCompareExperiment: (outputs: [StudioOutput, StudioOutput]) => void;
  onRerun: (job: StudioJob, mode: "exact" | "random-seed") => void;
  onFavorite: (job: StudioJob) => void;
  onSaveQualityReview: (output: StudioOutput, input: QualityReviewInput) => Promise<void>;
  onStartAnalysis: (output: StudioOutput, force?: boolean) => Promise<void>;
  onCancelAnalysis: (output: StudioOutput) => Promise<void>;
  onPrepareLipSyncRetry: (output: StudioOutput, referenceStrength: number) => void;
  onDeleteOutput: (output: StudioOutput) => Promise<void>;
  deletingOutputName: string | null;
  onLoadSettings: (job: StudioJob) => void;
  onLoadOutputSettings: (output: StudioOutput) => void;
  onUseFrameAsReference: (output: StudioOutput, atSeconds: number) => Promise<void>;
  onUseBestFrameAsReference: (output: StudioOutput) => Promise<number | null>;
  qualityGuidedSceneReferenceAvailable: boolean;
  extractingReferenceFrom: string | null;
  experiments: ControlledExperiment[];
  onCreateExperiment: (input: ExperimentCreateInput) => Promise<void>;
  onFreezeExperiment: (id: string) => Promise<void>;
  onLaunchExperiment: (id: string, arm: "baseline" | "candidate") => Promise<void>;
  onProjectJobLaunched: (job: StudioJob) => void;
  onLoadProjectRequest: (request: GenerationRequest) => void;
  estimate: ResourceEstimate;
  requiredStartMemoryGiB: number;
};

export function RunPanel({
  request,
  requestValid,
  health,
  jobs,
  outputs,
  selectedJob,
  selectedOutput,
  onSelectJob,
  onSelectOutput,
  onRun,
  onCancel,
  onDeleteJob,
  deletingJobId,
  submitting,
  errors,
  warnings,
  suggestions,
  onApplySuggestion,
  command,
  previews,
  comparisonOutputs,
  comparisonNames,
  onToggleCompare,
  onCompareExperiment,
  onRerun,
  onFavorite,
  onSaveQualityReview,
  onStartAnalysis,
  onCancelAnalysis,
  onPrepareLipSyncRetry,
  onDeleteOutput,
  deletingOutputName,
  onLoadSettings,
  onLoadOutputSettings,
  onUseFrameAsReference,
  onUseBestFrameAsReference,
  qualityGuidedSceneReferenceAvailable,
  extractingReferenceFrom,
  experiments,
  onCreateExperiment,
  onFreezeExperiment,
  onLaunchExperiment,
  onProjectJobLaunched,
  onLoadProjectRequest,
  estimate,
  requiredStartMemoryGiB,
}: RunPanelProps) {
  const selectedVideoRef = useRef<HTMLVideoElement | null>(null);
  const [selectedFrameSeconds, setSelectedFrameSeconds] = useState(0);
  const [experimentsExpanded, setExperimentsExpanded] = useState(false);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const pipeline = PIPELINES.find((item) => item.id === request.mode) ?? PIPELINES[0];
  const duration = request.mode === "retake"
    ? request.retake.endTime - request.retake.startTime
    : videoDurationSeconds(request.numFrames, request.frameRate);
  const sourcePath =
    request.mode === "retake"
      ? request.retake.videoPath
      : request.mode === "lipdub"
        ? request.lipDub.referenceVideo.path
      : request.mode === "id-lora"
        ? request.images[0]?.path || request.idLora.referenceAudio.path
      : request.images[0]?.path || request.icLora.videoConditioning[0]?.path || request.audio.path;
  const sourcePreview = sourcePath ? previews[sourcePath] : null;
  const runBlocked = submitting;
  const runLabel = health?.orchestrator === "missing"
    ? "DGX-Admission fehlt"
    : "Generieren";
  const memoryShortfall = health?.resources.availableMemoryGiB !== null
    && health?.resources.availableMemoryGiB !== undefined
    && health.resources.availableMemoryGiB < requiredStartMemoryGiB;
  const etaLabel = estimate.etaSeconds === null
    ? estimate.etaSamples > 0 ? "Noch 1 Vergleichslauf nötig" : "Nach 2 erfolgreichen Läufen"
    : estimate.etaSeconds >= 3600
      ? `${(estimate.etaSeconds / 3600).toFixed(1)} h`
      : `${Math.max(1, Math.round(estimate.etaSeconds / 60))} min`;
  const activeJob = jobs.find((job) => ["queued", "running", "paused"].includes(job.status)) ?? null;
  const monitorJob = activeJob ?? selectedJob;
  const monitorRuntime = monitorJob?.startedAt
    ? monitorJob.runtimeMs ?? Date.now() - Date.parse(monitorJob.startedAt)
    : null;
  const outputRequest = selectedOutput?.request ?? null;
  const canUseSceneReference = selectedOutput !== null
    && !isAudioOutputName(selectedOutput.name)
    && supportsSceneReference(request.mode);
  const outputForJob = (job: StudioJob) =>
    outputs.find((output) => output.jobId === job.id || output.name === job.outputName);
  const qualityAverageForJob = (job: StudioJob): number | null => {
    const review = outputForJob(job)?.qualityReview;
    return review ? qualityReviewAverage(review) : null;
  };
  const qualityAverageForOutput = (output: StudioOutput): number | null => {
    const review = output.qualityReview;
    return review ? qualityReviewAverage(review) : null;
  };

  return (
    <aside className="run-panel">
      <section className="preview-stage">
        <div className="preview-stage__media">
          {comparisonOutputs.length === 2 ? (
            <LazyPanelBoundary label="Synchronvergleich">
              <Suspense fallback={<LazyPanelLoading label="Synchronvergleich" />}>
                <SynchronizedComparePreview
                  outputs={[comparisonOutputs[0], comparisonOutputs[1]]}
                  scores={[
                    qualityAverageForOutput(comparisonOutputs[0]),
                    qualityAverageForOutput(comparisonOutputs[1]),
                  ]}
                />
              </Suspense>
            </LazyPanelBoundary>
          ) : selectedOutput ? (
            isAudioOutputName(selectedOutput.name)
              ? <audio key={selectedOutput.url} src={selectedOutput.url} controls preload="metadata" />
              : <video
                  key={selectedOutput.url}
                  ref={selectedVideoRef}
                  src={selectedOutput.url}
                  controls
                  muted
                  playsInline
                  onLoadStart={() => setSelectedFrameSeconds(0)}
                  onLoadedMetadata={(event) => {
                    setSelectedFrameSeconds(seekToInitialReferenceFrame(event.currentTarget));
                  }}
                  onDurationChange={(event) => {
                    setSelectedFrameSeconds(seekToInitialReferenceFrame(event.currentTarget));
                  }}
                  onCanPlay={(event) => {
                    setSelectedFrameSeconds(seekToInitialReferenceFrame(event.currentTarget));
                  }}
                  onSeeked={(event) => setSelectedFrameSeconds(event.currentTarget.currentTime)}
                  onTimeUpdate={(event) => setSelectedFrameSeconds(event.currentTarget.currentTime)}
                />
          ) : selectedJob?.outputUrl && outputForJob(selectedJob) ? (
            isAudioOutputName(selectedJob.outputName)
              ? <audio key={selectedJob.outputUrl} src={selectedJob.outputUrl} controls autoPlay />
              : <video key={selectedJob.outputUrl} src={selectedJob.outputUrl} controls autoPlay muted playsInline />
          ) : sourcePreview && request.mode !== "audio-to-video" ? (
            isVideoPreviewUrl(sourcePreview) ? (
              <video src={sourcePreview} controls muted playsInline />
            ) : (
              <img src={sourcePreview} alt="Eingabemedium" />
            )
          ) : (
            <div className="preview-empty">
              {request.mode === "text-to-audio"
                ? <AudioLines size={38} strokeWidth={1.3} />
                : <Film size={38} strokeWidth={1.3} />}
              <span>{pipeline.shortLabel}</span>
            </div>
          )}
          <div className="preview-stage__meta">
            <span>
              {request.mode === "retake"
                ? "Quelle"
                : request.mode === "text-to-audio"
                  ? "WAV · PCM 16 Bit"
                  : `${request.width} x ${request.height}`}
            </span>
            <span>{request.mode === "lipdub" ? "Referenzdauer" : `${duration.toFixed(1)} s`}</span>
          </div>
        </div>
      </section>

      {comparisonOutputs.length === 2 ? (
        <LazyPanelBoundary label="Objektiver Vergleich">
          <Suspense fallback={<LazyPanelLoading label="Objektiver Vergleich" />}>
            <ObjectiveComparisonPanel outputs={[comparisonOutputs[0], comparisonOutputs[1]]} />
          </Suspense>
        </LazyPanelBoundary>
      ) : null}

      <section className="output-library" aria-label="Erzeugte Medien und Einstellungen">
        <div className="run-panel__heading">
          <h2><ListVideo size={16} /> Erzeugte Medien</h2>
          <span>{outputs.length}</span>
        </div>
        {outputs.length > 0 ? (
          <>
            <label className="output-library__select">
              <span>Ausgabe auswählen</span>
              <select
                aria-label="Erzeugte Ausgabe"
                value={selectedOutput?.name ?? ""}
                onChange={(event) => {
                  const output = outputs.find((candidate) => candidate.name === event.target.value);
                  if (output) onSelectOutput(output);
                }}
              >
                {outputs.map((output) => (
                  <option key={output.name} value={output.name}>
                    {output.name}{output.qualityReview ? ` · ${qualityReviewAverage(output.qualityReview).toFixed(1)}/10` : ""}
                  </option>
                ))}
              </select>
            </label>
            {selectedOutput ? (
              <div className="output-library__details">
                <span>{formatFileSize(selectedOutput.sizeBytes)}</span>
                <span>{new Date(selectedOutput.modifiedAt).toLocaleString("de-AT")}</span>
                <span>{selectedOutput.settingsAvailable ? "Studio-Einstellungen vorhanden" : "Keine verlässlichen Einstellungen"}</span>
                {selectedOutput.qualityReview ? (
                  <span>Bewertung {qualityReviewAverage(selectedOutput.qualityReview).toFixed(1)} / 10</span>
                ) : null}
                {selectedOutput.analysis?.status === "completed" ? (
                  <span>{hasLipSyncMeasurement(selectedOutput)
                    ? "Lip-Sync geprüft"
                    : "Video geprüft, Lip-Sync nicht eindeutig"}</span>
                ) : null}
              </div>
            ) : null}
            {outputRequest ? (
              <div className="output-settings-summary" aria-label="Gespeicherte Videoeinstellungen">
                <span>Pipeline <strong>{PIPELINES.find((item) => item.id === outputRequest.mode)?.shortLabel}</strong></span>
                <span>Seed <strong>{outputRequest.seed}</strong></span>
                <span>Format <strong>{outputRequest.mode === "text-to-audio"
                  ? "WAV · PCM 16 Bit"
                  : `${outputRequest.width} x ${outputRequest.height}`}</strong></span>
                <span>{outputRequest.mode === "text-to-audio" ? "Dauerbasis" : "Frames"} <strong>{
                  outputRequest.mode === "lipdub"
                    ? "aus Referenzvideo"
                    : `${outputRequest.numFrames} @ ${outputRequest.frameRate} fps`
                }</strong></span>
                <span>Schritte <strong>{
                  outputRequest.mode === "lipdub"
                    ? "fest (8 + 3)"
                    : ["id-lora", "two-stage", "image-audio-to-video"].includes(outputRequest.mode)
                      ? "fest (8 + 3)"
                      : outputRequest.mode === "distilled"
                        ? outputRequest.distilled.singleStage ? "fest (8)" : "fest (8 + 3)"
                      : ["ic-lora", "keyframes", "text-to-audio"].includes(outputRequest.mode)
                        ? "fest (8)"
                      : outputRequest.numInferenceSteps
                }</strong></span>
                <span>Quantisierung <strong>{outputRequest.quantization.mode}</strong></span>
              </div>
            ) : null}
            <div className="output-library__actions">
              <button
                type="button"
                className="button output-library__load"
                disabled={!selectedOutput?.settingsAvailable}
                onClick={() => {
                  if (selectedOutput) onLoadOutputSettings(selectedOutput);
                }}
              >
                <SlidersHorizontal size={16} /> Alle Einstellungen übernehmen
              </button>
              <button
                type="button"
                className={`icon-button ${selectedOutput && comparisonNames.includes(selectedOutput.name) ? "is-active" : ""}`}
                title="Ausgabe zum Vergleich hinzufügen"
                aria-pressed={Boolean(selectedOutput && comparisonNames.includes(selectedOutput.name))}
                disabled={!selectedOutput || isAudioOutputName(selectedOutput.name)}
                onClick={() => {
                  if (selectedOutput) onToggleCompare(selectedOutput);
                }}
              >
                <Columns2 size={17} />
              </button>
              <button
                type="button"
                className="icon-button icon-button--danger"
                title="Ausgabe und zugehörige Daten löschen"
                disabled={!selectedOutput || deletingOutputName === selectedOutput.name}
                onClick={() => {
                  if (selectedOutput) void onDeleteOutput(selectedOutput);
                }}
              >
                {deletingOutputName === selectedOutput?.name
                  ? <LoaderCircle className="spin" size={17} />
                  : <Trash2 size={17} />}
              </button>
            </div>
            <div className="output-library__reference-action">
              <label className="output-library__frame-time">
                <span>
                  Zeitpunkt
                  <InfoTooltip text="Wofür: Legt fest, welcher sichtbare Frame als neue Szenenreferenz verwendet wird. Gut ist ein scharfes, ruhiges Bild nach dem Anlauf, mit gut erkennbarem Gesicht und passendem Licht." />
                </span>
                <input
                  type="number"
                  aria-label="Referenzzeitpunkt in Sekunden"
                  min={0}
                  step={0.04}
                  value={selectedFrameSeconds.toFixed(2)}
                  onChange={(event) => {
                    const next = Math.max(0, Number(event.target.value) || 0);
                    setSelectedFrameSeconds(next);
                    const video = selectedVideoRef.current;
                    if (video && Number.isFinite(video.duration) && next < video.duration) video.currentTime = next;
                  }}
                />
              </label>
              <button
                type="button"
                className="icon-button output-library__auto-reference"
                title={qualityGuidedSceneReferenceAvailable
                  ? "Schärfsten ruhigen Gesichtsframe automatisch auswählen"
                  : "Automatische Frame-Auswahl wird nach dem Studio-Neustart verfügbar"}
                aria-label="Besten Referenzframe automatisch auswählen"
                disabled={!qualityGuidedSceneReferenceAvailable
                  || !canUseSceneReference
                  || extractingReferenceFrom === selectedOutput?.name}
                onClick={async () => {
                  if (!selectedOutput) return;
                  const atSeconds = await onUseBestFrameAsReference(selectedOutput);
                  if (atSeconds === null) return;
                  setSelectedFrameSeconds(atSeconds);
                  const video = selectedVideoRef.current;
                  if (video && Number.isFinite(video.duration) && atSeconds < video.duration) {
                    video.currentTime = atSeconds;
                  }
                }}
              >
                {extractingReferenceFrom === selectedOutput?.name
                  ? <LoaderCircle className="spin" size={16} />
                  : <ScanSearch size={17} />}
              </button>
              <button
                type="button"
                className="button output-library__reference"
                title="Den gewählten Videoframe als gebundene Bildreferenz in den Editor einsetzen"
                disabled={!canUseSceneReference || extractingReferenceFrom === selectedOutput?.name}
                onClick={() => {
                  if (!selectedOutput) return;
                  void onUseFrameAsReference(selectedOutput, selectedFrameSeconds);
                }}
              >
                {extractingReferenceFrom === selectedOutput?.name
                  ? <LoaderCircle className="spin" size={16} />
                  : <Camera size={16} />}
                Frame als Referenz
              </button>
            </div>
          </>
        ) : (
          <div className="compact-empty">Noch keine MP4- oder WAV-Ausgabe im Studio-Ordner</div>
        )}
      </section>

      {projectsExpanded ? (
        <LazyPanelBoundary label="Projektansicht">
          <Suspense fallback={<LazyPanelLoading label="Projektansicht" />}>
            <ProjectPanel
              request={request}
              requestValid={requestValid}
              jobs={jobs}
              selectedOutput={selectedOutput}
              onJobLaunched={onProjectJobLaunched}
              onLoadRequest={onLoadProjectRequest}
            />
          </Suspense>
        </LazyPanelBoundary>
      ) : (
        <section className="output-library" aria-label="Produktionsprojekte">
          <div className="run-panel__heading">
            <h2><FolderKanban size={16} /> Produktionsprojekte</h2>
            <button type="button" className="button" onClick={() => setProjectsExpanded(true)}>
              Projekte öffnen
            </button>
          </div>
        </section>
      )}

      {request.mode !== "text-to-audio" ? (
        experimentsExpanded ? (
          <LazyPanelBoundary label="Experimentansicht">
            <Suspense fallback={<LazyPanelLoading label="Experimentansicht" />}>
              <ExperimentPanel
                request={request}
                requestValid={requestValid}
                experiments={experiments}
                jobs={jobs}
                outputs={outputs}
                health={health}
                onCreate={onCreateExperiment}
                onFreeze={onFreezeExperiment}
                onLaunch={onLaunchExperiment}
                onAnalyze={(output) => onStartAnalysis(output)}
                onCompare={onCompareExperiment}
              />
            </Suspense>
          </LazyPanelBoundary>
        ) : (
          <section className="output-library" aria-label="Experimente">
            <div className="run-panel__heading">
              <h2>Kontrollierte Experimente</h2>
              <button type="button" className="button" onClick={() => setExperimentsExpanded(true)}>
                Experimente öffnen
              </button>
            </div>
          </section>
        )
      ) : null}

      <section className={`run-monitor ${activeJob ? "is-live" : ""}`} aria-label="Laufmonitor">
        <div className="run-panel__heading">
          <h2>{activeJob ? <LoaderCircle className="spin" size={16} /> : <ScrollText size={16} />} Laufmonitor</h2>
          <span>{monitorJob ? statusLabels[monitorJob.status] : "Leer"}</span>
        </div>
        {monitorJob ? (
          <>
            <div className="run-monitor__title">
              <strong>{monitorJob.outputName}</strong>
              <span>{formatRuntime(monitorRuntime)}</span>
            </div>
            <div className="run-monitor__metrics">
              <span>Status <strong>{statusLabels[monitorJob.status]}</strong></span>
              <span>Fortschritt <strong>{monitorJob.progress === null ? "Nicht gemeldet" : `${Math.round(monitorJob.progress)}%`}</strong></span>
              <span>Pipeline <strong>{PIPELINES.find((item) => item.id === monitorJob.mode)?.shortLabel}</strong></span>
              <span>Seed <strong>{monitorJob.request.seed}</strong></span>
            </div>
            {monitorJob.thermalProfile ? (
              <div className="run-monitor__thermal">
                <Thermometer size={15} />
                <span>Basis {monitorJob.thermalProfile.baselineC.toFixed(1)} °C</span>
                <span>Aktuell {monitorJob.thermalProfile.currentC === null ? "beendet" : `${monitorJob.thermalProfile.currentC.toFixed(1)} °C`}</span>
                <span>Peak {monitorJob.thermalProfile.peakC.toFixed(1)} °C</span>
                <span>Pause ab {monitorJob.thermalProfile.pauseAtC.toFixed(0)} °C</span>
              </div>
            ) : null}
            {monitorJob.cancelledBy === "studio" ? (
              <p className="run-monitor__notice">Dieser Lauf wurde manuell über die Studio-Abbruchfunktion beendet.</p>
            ) : null}
            <p className="run-monitor__latest">{monitorJob.logs.at(-1) ?? "Noch keine Logausgabe"}</p>
          </>
        ) : (
          <div className="compact-empty">Noch kein Lauf vorhanden</div>
        )}
      </section>

      <section className="run-summary">
        <div className="run-summary__line">
          <span>Pipeline</span>
          <strong>{pipeline.shortLabel}</strong>
        </div>
        <div className="run-summary__line">
          <span>Gemma-Verbesserung</span>
          <strong>{request.enhancePrompt ? "Aktiv" : "Aus"}</strong>
        </div>
        <div className="run-summary__line">
          <span>Queue</span>
          <strong>{health?.queueDepth ?? 0}</strong>
        </div>
        <div className="run-summary__line">
          <span>RAM-Prognose</span>
          <strong>{estimate.memoryGiB} GiB</strong>
        </div>
        <div className="run-summary__line">
          <span>Ausgabedatei</span>
          <strong>ca. {estimate.outputGiB.toFixed(2)} GiB</strong>
        </div>
        <div className="run-summary__line">
          <span>ETA</span>
          <strong>{etaLabel}</strong>
        </div>
      </section>

      {memoryShortfall ? (
        <p className="resource-warning">
          Der aktuelle RAM liegt unter dem konservativen Planwert von {requiredStartMemoryGiB} GiB.
          Der Auftrag wird trotzdem eingereiht; der DGX-Orchestrator entscheidet den tatsächlichen Start.
        </p>
      ) : null}

      {health?.workloads.length ? (
        <section className="runtime-lanes" aria-label="Aktive DGX-Laufzeiten">
          {health.workloads.map((lane) => (
            <div className="runtime-lane" key={lane.id}>
              <span className={`runtime-lane__state runtime-lane__state--${lane.state}`} />
              <strong>{lane.label}</strong>
              <span>{lane.state.replaceAll("_", " ")}</span>
              {lane.protected ? <ShieldCheck size={13} aria-label="Geschützt" /> : null}
            </div>
          ))}
        </section>
      ) : null}

      {selectedJob?.outputUrl && outputForJob(selectedJob) ? (
        <a className="output-download" href={selectedJob.outputUrl} download={selectedJob.outputName}>
          <Download size={16} /> Ausgabe herunterladen
        </a>
      ) : null}

      {selectedJob ? (
        <div className="job-actions" aria-label="Aktionen für ausgewählten Job">
          <button
            type="button"
            className={`icon-button ${selectedJob.favorite ? "is-active" : ""}`}
            title={selectedJob.favorite ? "Aus Favoriten entfernen" : "Als Favorit markieren"}
            aria-pressed={selectedJob.favorite}
            onClick={() => onFavorite(selectedJob)}
          >
            <Star size={17} fill={selectedJob.favorite ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            className="button job-action-primary"
            title="Alle Einstellungen dieses Jobs in den Editor laden"
            onClick={() => onLoadSettings(selectedJob)}
          >
            <SlidersHorizontal size={16} /> Einstellungen übernehmen
          </button>
          <button
            type="button"
            className="icon-button"
            title="Mit denselben Einstellungen und demselben Seed neu starten"
            disabled={["queued", "running", "paused"].includes(selectedJob.status)}
            onClick={() => onRerun(selectedJob, "exact")}
          >
            <Repeat2 size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            title="Variante mit neuem konkreten Seed starten"
            disabled={["queued", "running", "paused"].includes(selectedJob.status)}
            onClick={() => onRerun(selectedJob, "random-seed")}
          >
            <Dices size={17} />
          </button>
          <span>Seed {selectedJob.request.seed}</span>
        </div>
      ) : null}

      {comparisonOutputs.length !== 2 && selectedOutput && isSpeechQualityCandidate(selectedOutput) ? (
        <LazyPanelBoundary label="Qualitätsanalyse">
          <Suspense fallback={<LazyPanelLoading label="Qualitätsanalyse" />}>
            <QualityScorecard
              key={`manual-${selectedOutput.name}`}
              output={selectedOutput}
              outputs={outputs}
              onSave={onSaveQualityReview}
            />
            <ObjectiveAnalysisPanel
              key={`objective-${selectedOutput.name}-${selectedOutput.fileId}-${selectedOutput.changedAt}`}
              output={selectedOutput}
              onStart={onStartAnalysis}
              onCancel={onCancelAnalysis}
              onPrepareLipSyncRetry={onPrepareLipSyncRetry}
            />
          </Suspense>
        </LazyPanelBoundary>
      ) : null}

      {errors.length > 0 ? (
        <div className="run-errors" role="alert">
          <AlertTriangle size={17} />
          <div>{errors.slice(0, 5).map((error) => <span key={error}>{error}</span>)}</div>
        </div>
      ) : null}

      {warnings.length > 0 ? (
        <div className="run-warnings" role="status">
          <AlertTriangle size={17} />
          <div>{warnings.slice(0, 5).map((warning) => <span key={warning}>{warning}</span>)}</div>
        </div>
      ) : null}

      {suggestions.length > 0 ? (
        <div className="run-suggestions" role="status">
          <SlidersHorizontal size={17} />
          <div>
            {suggestions.slice(0, 3).map((suggestion) => (
              <div className="run-suggestion" key={suggestion.id}>
                <span>{suggestion.message}</span>
                <button type="button" className="button button--secondary" onClick={() => onApplySuggestion(suggestion)}>
                  <SlidersHorizontal size={15} /> {suggestion.label}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <button type="button" className="run-button" onClick={onRun} disabled={runBlocked}>
        {submitting ? <LoaderCircle className="spin" size={19} /> : <Play size={19} fill="currentColor" />}
        {runLabel}
      </button>

      <section className="job-section">
        <div className="run-panel__heading">
          <h2>Jobs</h2>
          <span>{jobs.length}</span>
        </div>
        <div className="job-list">
          {jobs.length === 0 ? <div className="compact-empty compact-empty--jobs">Noch keine Jobs</div> : null}
          {jobs.map((job) => (
            <div key={job.id} className={`job-row ${selectedJob?.id === job.id ? "is-active" : ""}`}>
              <button type="button" className="job-row__select" onClick={() => onSelectJob(job)}>
                <span className={`job-status job-status--${job.status}`}><StatusIcon status={job.status} /></span>
                  <span className="job-row__main">
                    <strong>{job.outputName}</strong>
                    <small>{statusLabels[job.status]} · {PIPELINES.find((item) => item.id === job.mode)?.shortLabel} · Seed {job.request.seed}</small>
                </span>
                <span className="job-row__meta">
                  {job.favorite ? <Star className="job-row__favorite" size={13} fill="currentColor" /> : null}
                  {qualityAverageForJob(job) !== null ? (
                    <span className="job-row__score">{qualityAverageForJob(job)!.toFixed(1)}</span>
                  ) : null}
                  {job.progress !== null ? <span className="job-row__progress">{Math.round(job.progress)}%</span> : null}
                </span>
              </button>
              {["queued", "running", "paused"].includes(job.status) ? (
                <button
                  type="button"
                  className="job-row__cancel"
                  title="Job abbrechen"
                  onClick={() => onCancel(job.id)}
                >
                  <CircleStop size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  className="job-row__delete"
                  title="Job aus Verlauf löschen"
                  disabled={deletingJobId === job.id}
                  onClick={() => void onDeleteJob(job)}
                >
                  {deletingJobId === job.id
                    ? <LoaderCircle className="spin" size={15} />
                    : <Trash2 size={15} />}
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      {selectedJob ? (
        <details className="run-details" open>
          <summary><ScrollText size={16} /> Jobdetails</summary>
          {selectedJob.error ? <p className="job-error">{selectedJob.error}</p> : null}
          {selectedJob.status === "completed" && !outputForJob(selectedJob) ? (
            <p className="job-cancelled">Die Ausgabedatei wurde gelöscht; der Jobverlauf bleibt erhalten.</p>
          ) : null}
          {selectedJob.cancelledBy === "studio" ? (
            <p className="job-cancelled">Manuell über die Studio-Abbruchfunktion beendet.</p>
          ) : null}
          {selectedJob.variantOf ? <p className="job-lineage">Variante von {selectedJob.variantOf.slice(0, 8)}</p> : null}
          <dl className="job-facts">
            <div><dt>Status</dt><dd>{statusLabels[selectedJob.status]}</dd></div>
            <div><dt>Erstellt</dt><dd>{new Date(selectedJob.createdAt).toLocaleString("de-AT")}</dd></div>
            <div><dt>Laufzeit</dt><dd>{formatRuntime(selectedJob.runtimeMs)}</dd></div>
            <div><dt>DGX-Job</dt><dd>{selectedJob.dgxJobId ?? "Noch nicht eingereicht"}</dd></div>
            <div><dt>Logs</dt><dd>{selectedJob.logs.length} Zeilen</dd></div>
          </dl>
          <details className="job-command">
            <summary><Terminal size={14} /> Vollständiges Kommando</summary>
            <pre>{selectedJob.command}</pre>
          </details>
          <pre>{selectedJob.logs.join("\n") || "Keine Logausgabe"}</pre>
        </details>
      ) : command ? (
        <details className="run-details">
          <summary><Terminal size={16} /> Kommando</summary>
          <pre>{command}</pre>
        </details>
      ) : null}
    </aside>
  );
}
