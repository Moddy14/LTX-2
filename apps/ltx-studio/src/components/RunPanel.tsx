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

import {
  dfrOutputGeometry,
  isLegacyDfrRequest,
  PIPELINES,
  type GenerationRequest,
} from "../../shared/pipelines";
import { effectiveA2vTimeline } from "../../shared/a2vDuration";
import type { PlanSuggestion } from "../../shared/plan";
import { qualificationHoldForRequest } from "../../shared/qualificationHold";
import { videoDurationSeconds } from "../../shared/presets";
import { isVideoPreviewUrl } from "../../shared/media";
import type {
  Health,
  ResourceEstimate,
  StudioJob,
  StudioOutput,
} from "../types";
import { qualityReviewAverage, type QualityReviewInput } from "../../shared/quality";
import type { ExperimentCreateInput } from "../../shared/experiments";
import type { PublicControlledExperiment } from "../../shared/outputPublic";
import { isSpeechQualityCandidate, isT2aAudioQualityCandidate } from "../qualityCandidates";
import { supportsSceneReference } from "../sceneReference";
import { importWithSingleReload } from "../lazyImport";
import { phonemeVisemeMeasurementWindow } from "../objectiveAnalysisCoverage";
import { executionClassLabel } from "../jobExecutionPresentation";
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
const AudioQualityPanel = lazy(async () => ({
  default: (await importWithSingleReload("audio-quality", () => import("./AudioQualityPanel")))
    .AudioQualityPanel,
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

function cancellationIsSettling(job: StudioJob): boolean {
  return job.cancellationState === "requested" || job.cancellationState === "settling";
}

function visibleJobStatus(job: StudioJob): string {
  return cancellationIsSettling(job) ? "Abbruch läuft" : statusLabels[job.status];
}

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
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${hours} h ${String(minutes).padStart(2, "0")} min`
    : `${minutes} min ${String(remainder).padStart(2, "0")} s`;
}

function jobLaneLabel(job: StudioJob): string {
  return job.executionClass === "dgx"
    ? PIPELINES.find((item) => item.id === job.mode)?.shortLabel ?? job.mode
    : executionClassLabel(job);
}

function dgxJobLabel(job: StudioJob): string {
  if (job.executionClass === "cpu-only") return "Nicht erforderlich";
  if (job.executionClass === "pending") return "Klassifizierung ausstehend";
  if (job.executionClass === undefined) return "Nicht klassifiziert (Legacy)";
  return job.dgxJobId ?? "Noch nicht eingereicht";
}

function formatFileSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function lipSyncOutputStatusLabel(output: StudioOutput): string {
  const result = output.analysis?.status === "completed" ? output.analysis.result : null;
  const measurementWindow = phonemeVisemeMeasurementWindow(result);
  const phonemeViseme = result?.schemaVersion === "ltx-studio-objective-quality.v4"
    || result?.schemaVersion === "ltx-studio-objective-quality.v5"
    || result?.schemaVersion === "ltx-studio-objective-quality.v6"
    || result?.schemaVersion === "ltx-studio-objective-quality.v7"
    ? result.phonemeViseme
    : null;
  if (phonemeViseme?.status === "measured" && phonemeViseme.productGo.status === "passed") {
    return "Lip-Sync Product-GO freigegeben";
  }
  if (phonemeViseme?.status === "measurement-only") {
    return measurementWindow.status === "partial"
      ? "Lip-Sync gemessen (Teilfenster) · keine Product-GO-Freigabe"
      : "Lip-Sync gemessen · keine Product-GO-Freigabe";
  }
  return "Video gemessen, Lip-Sync nicht freigegeben";
}

function audioQualityStatus(output: StudioOutput): string | null {
  const analysis = output.audioAnalysis;
  if (!analysis) return null;
  if (analysis.claimScope === "development") {
    if (analysis.status === "queued") return "Entwicklungsmessung wartet · nicht attestiert";
    if (analysis.status === "running") return "Entwicklungsmessung läuft · nicht attestiert";
    if (analysis.status === "cancelled") return "Entwicklungsmessung abgebrochen · nicht attestiert";
    if (analysis.status === "failed") return "Entwicklungsmessung fehlgeschlagen · nicht attestiert";
    return "Entwicklungsmessung · nicht attestiert · keine Freigabe";
  }
  if (analysis.status === "queued") return "Audioanalyse wartet";
  if (analysis.status === "running") return "Audioanalyse läuft";
  if (analysis.status === "cancelled") return "Audioanalyse abgebrochen";
  if (analysis.status === "failed") return "Audioanalyse fehlgeschlagen";
  if (analysis.result?.analysisStatus !== "measured") return "Audioanalyse ohne Messwerte";
  return analysis.result.ia2vEligibility.status === "eligible"
    ? "Audio-Vorfilter bestanden"
    : "Audio-Vorfilter gesperrt";
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
  cancellingJobIds: ReadonlySet<string>;
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
  onStartT2aAnalysis: (output: StudioOutput, force?: boolean) => Promise<void>;
  onCancelT2aAnalysis: (output: StudioOutput, analysisId: string) => Promise<void>;
  onPrepareLipSyncRetry: (output: StudioOutput, referenceStrength: number) => void;
  onDeleteOutput: (output: StudioOutput) => Promise<void>;
  deletingOutputName: string | null;
  onLoadSettings: (job: StudioJob) => void;
  onLoadOutputSettings: (output: StudioOutput) => void;
  onUseFrameAsReference: (output: StudioOutput, atSeconds: number) => Promise<void>;
  onUseBestFrameAsReference: (output: StudioOutput) => Promise<number | null>;
  qualityGuidedSceneReferenceAvailable: boolean;
  extractingReferenceFrom: string | null;
  experiments: PublicControlledExperiment[];
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
  cancellingJobIds,
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
  onStartT2aAnalysis,
  onCancelT2aAnalysis,
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
  const sourcePath =
    request.mode === "retake"
      ? request.retake.videoPath
      : request.mode === "lipdub"
        ? request.lipDub.referenceVideo.path
      : request.mode === "id-lora"
        ? request.images[0]?.path || request.idLora.referenceAudio.path
      : request.images[0]?.path || request.icLora.videoConditioning[0]?.path || request.audio.path;
  const sourcePreview = sourcePath ? previews[sourcePath] : null;
  const qualificationHold = qualificationHoldForRequest(request);
  const selectedJobQualificationHold = selectedJob
    ? qualificationHoldForRequest(selectedJob.request)
    : null;
  // Invalid editor input stays clickable so the normal run handler can expose
  // its field-specific validation messages. Only non-actionable states are disabled.
  const runBlocked = submitting || isLegacyDfrRequest(request) || Boolean(qualificationHold);
  const runLabel = qualificationHold
    ? "DFR Qualification-HOLD"
    : health?.orchestrator === "missing"
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
  const showDgxForecast = monitorJob === null
    || (monitorJob.executionClass === "dgx" && ["queued", "running", "paused"].includes(monitorJob.status));
  const outputRequest = selectedOutput?.request ?? null;
  const outputDfrGeometry = outputRequest?.mode === "dfr" && !isLegacyDfrRequest(outputRequest)
    ? dfrOutputGeometry(outputRequest)
    : null;
  const outputA2vTimeline = outputRequest ? effectiveA2vTimeline(outputRequest) : null;
  const outputMeasuredTiming = selectedOutput?.analysis?.status === "completed"
    ? selectedOutput.analysis.result?.technical ?? null
    : null;
  const outputHasMeasuredFrameTiming = Boolean(
    outputMeasuredTiming?.frames
      && outputMeasuredTiming.frames > 0
      && outputMeasuredTiming.fps
      && outputMeasuredTiming.fps > 0,
  );
  const outputMeasuredDurationSeconds = outputMeasuredTiming?.durationSeconds !== null
    && outputMeasuredTiming?.durationSeconds !== undefined
    && outputMeasuredTiming.durationSeconds > 0
    ? outputMeasuredTiming.durationSeconds
    : null;
  const outputEffectiveFrames = (outputHasMeasuredFrameTiming ? outputMeasuredTiming?.frames : null)
    ?? outputA2vTimeline?.frameCount
    ?? outputRequest?.numFrames
    ?? null;
  const outputEffectiveFrameRate = (outputHasMeasuredFrameTiming ? outputMeasuredTiming?.fps : null)
    ?? outputRequest?.frameRate
    ?? null;
  const outputEffectiveDurationSeconds = outputMeasuredDurationSeconds
    ?? outputA2vTimeline?.durationSeconds
    ?? null;
  const outputA2vFrameBasis = outputHasMeasuredFrameTiming
    ? "Medium gemessen"
    : outputA2vTimeline?.derivesFramesFromAudio
      ? outputA2vTimeline.exact ? "aus Audio" : "Obergrenze aus Audio-Maximaldauer"
      : null;
  const outputForJob = (job: StudioJob) =>
    outputs.find((output) => output.jobId === job.id || output.name === job.outputName);
  const selectedOutputReadOnly = selectedOutput?.trustStatus === "legacy-unattested";
  const selectedJobReadOnly = selectedJob?.historyStatus === "legacy-unattested"
    || Boolean(selectedJob && outputForJob(selectedJob)?.trustStatus === "legacy-unattested");
  const previewRequest = outputRequest ?? request;
  const previewIsAudio = selectedOutput
    ? isAudioOutputName(selectedOutput.name)
    : previewRequest.mode === "text-to-audio";
  const previewFormat = selectedOutput && !outputRequest
    ? previewIsAudio ? "WAV · Audio" : "Video"
    : previewIsAudio
      ? "WAV · PCM 16 Bit"
      : previewRequest.mode === "retake"
        ? "Quelle"
        : `${previewRequest.width} x ${previewRequest.height}`;
  const previewTiming = selectedOutput && outputEffectiveDurationSeconds !== null
    ? `${outputA2vTimeline?.derivesFramesFromAudio
        && !outputA2vTimeline.exact
        && outputMeasuredDurationSeconds === null ? "Bis zu " : ""}${outputEffectiveDurationSeconds.toFixed(1)} s`
    : selectedOutput && !outputRequest
      ? "Dauer aus Medium"
    : previewRequest.mode === "lipdub"
      ? "Referenzdauer"
      : `${(previewRequest.mode === "retake"
        ? previewRequest.retake.endTime - previewRequest.retake.startTime
        : videoDurationSeconds(previewRequest.numFrames, previewRequest.frameRate)).toFixed(1)} s`;
  const canUseSceneReference = selectedOutput !== null
    && !selectedOutputReadOnly
    && !isAudioOutputName(selectedOutput.name)
    && supportsSceneReference(request.mode);
  const qualityAverageForJob = (job: StudioJob): number | null => {
    const output = outputForJob(job);
    if (!output || output.trustStatus === "legacy-unattested" || isAudioOutputName(output.name)) return null;
    const review = output.qualityReview;
    return review ? qualityReviewAverage(review) : null;
  };
  const qualityAverageForOutput = (output: StudioOutput): number | null => {
    if (output.trustStatus === "legacy-unattested" || isAudioOutputName(output.name)) return null;
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
            <span>{previewFormat}</span>
            <span>{previewTiming}</span>
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
                    {output.name}{output.qualityReview
                      && output.trustStatus !== "legacy-unattested"
                      && !isAudioOutputName(output.name)
                      ? ` · ${qualityReviewAverage(output.qualityReview).toFixed(1)}/10`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            {selectedOutput ? (
              <div className="output-library__details">
                <span>{formatFileSize(selectedOutput.sizeBytes)}</span>
                <span>{new Date(selectedOutput.modifiedAt).toLocaleString("de-AT")}</span>
                <span>{selectedOutputReadOnly
                  ? "Historischer Altbestand · ungeprüft · nur lesbar"
                  : selectedOutput.settingsAvailable
                    ? "Studio-Einstellungen vorhanden"
                    : "Keine verlässlichen Einstellungen"}</span>
                {outputRequest && isLegacyDfrRequest(outputRequest) ? (
                  <span>DFR Legacy · nur lesbar · nicht ausführbar</span>
                ) : null}
                {selectedOutput.qualityReview
                  && !selectedOutputReadOnly
                  && !isAudioOutputName(selectedOutput.name) ? (
                  <span>Bewertung {qualityReviewAverage(selectedOutput.qualityReview).toFixed(1)} / 10</span>
                ) : null}
                {!selectedOutputReadOnly
                  ? isAudioOutputName(selectedOutput.name)
                    ? audioQualityStatus(selectedOutput) ? <span>{audioQualityStatus(selectedOutput)}</span> : null
                    : selectedOutput.analysis?.status === "completed"
                      ? <span>{lipSyncOutputStatusLabel(selectedOutput)}</span>
                      : null
                  : null}
              </div>
            ) : null}
            {outputRequest ? (
              <div className="output-settings-summary" aria-label="Gespeicherte Einstellungen">
                <span>Pipeline <strong>{PIPELINES.find((item) => item.id === outputRequest.mode)?.shortLabel}</strong></span>
                {isLegacyDfrRequest(outputRequest) ? <span>Status <strong>Legacy · nicht ausführbar</strong></span> : null}
                <span>Modell <strong>LTX-{outputRequest.models.generation} · {outputRequest.models.layout === "split" ? "Split" : "Monolith Legacy"}</strong></span>
                <span>Seed <strong>{outputRequest.seed}</strong></span>
                <span>Format <strong>{outputRequest.mode === "text-to-audio"
                  ? "WAV · PCM 16 Bit"
                  : `${outputRequest.width} x ${outputRequest.height}`}</strong></span>
                <span>{outputRequest.mode === "text-to-audio" ? "Dauerbasis" : "Frames"} <strong>{
                  outputRequest.mode === "lipdub"
                    ? "aus Referenzvideo"
                    : outputDfrGeometry
                      ? `${outputDfrGeometry.numFrames} @ ${outputDfrGeometry.frameRate} fps (Endausgabe)`
                      : outputEffectiveFrames !== null && outputEffectiveFrameRate !== null
                        ? `${outputEffectiveFrames} @ ${outputEffectiveFrameRate} fps${outputA2vFrameBasis ? ` (${outputA2vFrameBasis})` : ""}`
                        : `${outputRequest.numFrames} @ ${outputRequest.frameRate} fps`
                }</strong></span>
                {outputA2vTimeline?.derivesFramesFromAudio ? (
                    <span>Expliziter Framewert <strong>{outputRequest.numFrames} ungenutzt · Audio-Maximaldauer steuert</strong></span>
                  ) : null}
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
            {outputRequest?.promptParts.dialogue.trim() ? (
              <div className="output-dialogue-summary" role="note" aria-label="Gesprochener Text der Ausgabe">
                <strong>Gesprochener Text</strong>
                <p>{outputRequest.promptParts.dialogue}</p>
              </div>
            ) : null}
            <div className="output-library__actions">
              <button
                type="button"
                className="button output-library__load"
                disabled={!selectedOutput?.settingsAvailable || selectedOutputReadOnly}
                title={selectedOutputReadOnly
                  ? "Historischer Altbestand ist ungeprüft und darf nicht in den Editor übernommen werden."
                  : undefined}
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
                disabled={!selectedOutput || selectedOutputReadOnly || isAudioOutputName(selectedOutput.name)}
                onClick={() => {
                  if (selectedOutput) onToggleCompare(selectedOutput);
                }}
              >
                <Columns2 size={17} />
              </button>
              <button
                type="button"
                className="icon-button icon-button--danger"
                title={selectedOutputReadOnly
                  ? "Historischer Altbestand ist nur lesbar und kann hier nicht gelöscht werden."
                  : "Ausgabe und zugehörige Daten löschen"}
                disabled={!selectedOutput || selectedOutputReadOnly || deletingOutputName === selectedOutput.name}
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
              selectedOutput={selectedOutputReadOnly ? null : selectedOutput}
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
                outputs={outputs.filter((output) => output.trustStatus !== "legacy-unattested")}
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
          <span>{monitorJob ? visibleJobStatus(monitorJob) : "Leer"}</span>
        </div>
        {monitorJob ? (
          <>
            <div className="run-monitor__title">
              <strong>{monitorJob.outputName}</strong>
              <span>{formatRuntime(monitorRuntime)}</span>
            </div>
            <div className="run-monitor__metrics">
              <span>Status <strong>{visibleJobStatus(monitorJob)}</strong></span>
              <span>Fortschritt <strong>{monitorJob.progress === null ? "Nicht gemeldet" : `${Math.round(monitorJob.progress)}%`}</strong></span>
              {monitorJob.executionClass === "dgx" ? (
                <span>Pipeline <strong>{jobLaneLabel(monitorJob)}</strong></span>
              ) : (
                <span>Ausführung <strong>{executionClassLabel(monitorJob)}</strong></span>
              )}
              <span>Seed <strong>{monitorJob.request.seed}</strong></span>
            </div>
            {monitorJob.thermalProfile ? (
              <div className="run-monitor__thermal">
                <Thermometer size={15} />
                <span>Basis {monitorJob.thermalProfile.baselineC.toFixed(1)} °C</span>
                <span>Aktuell {monitorJob.thermalProfile.currentC === null ? "beendet" : `${monitorJob.thermalProfile.currentC.toFixed(1)} °C`}</span>
                <span>Peak {monitorJob.thermalProfile.peakC.toFixed(1)} °C</span>
                <span>Pause ab {monitorJob.thermalProfile.pauseAtC.toFixed(0)} °C</span>
                <span>Fortsetzen bei/unter {monitorJob.thermalProfile.resumeBelowC.toFixed(0)} °C</span>
              </div>
            ) : null}
            {monitorJob.cancelledBy === "studio" ? (
              <p className="run-monitor__notice">{cancellationIsSettling(monitorJob)
                ? "Abbruch läuft: Prozess, Container und DGX-Zustand werden noch bestätigt."
                : "Dieser Lauf wurde manuell über die Studio-Abbruchfunktion beendet."}</p>
            ) : null}
            <p className="run-monitor__latest">{monitorJob.logs.at(-1) ?? "Noch keine Logausgabe"}</p>
          </>
        ) : (
          <div className="compact-empty">Noch kein Lauf vorhanden</div>
        )}
      </section>

      <section className="run-summary">
        {monitorJob ? (
          <div className="run-summary__line">
            <span>Ausführung</span>
            <strong>{executionClassLabel(monitorJob)}</strong>
          </div>
        ) : null}
        <div className="run-summary__line">
          <span>{monitorJob && !showDgxForecast ? "Request-Typ" : "Pipeline"}</span>
          <strong>{monitorJob ? PIPELINES.find((item) => item.id === monitorJob.mode)?.shortLabel : pipeline.shortLabel}</strong>
        </div>
        {showDgxForecast ? (
          <>
            <div className="run-summary__line">
              <span>Gemma-Verbesserung</span>
              <strong>{(monitorJob?.request ?? request).enhancePrompt ? "Aktiv" : "Aus"}</strong>
            </div>
            <div className="run-summary__line">
              <span>Queue</span>
              <strong>{health?.queueDepth ?? 0}</strong>
            </div>
            <div className="run-summary__line">
              <span>RAM-Prognose</span>
              <strong>{estimate.memoryGiB} GiB</strong>
            </div>
            {estimate.memoryBasis?.startsWith("provisional-proxy:") ? (
              <div className="run-summary__line">
                <span>RAM-Basis</span>
                <strong>Provisorisch · Peakmessung ausstehend</strong>
              </div>
            ) : null}
            <div className="run-summary__line">
              <span>Ausgabedatei</span>
              <strong>ca. {estimate.outputGiB.toFixed(2)} GiB</strong>
            </div>
            <div className="run-summary__line">
              <span>ETA</span>
              <strong>{etaLabel}</strong>
            </div>
          </>
        ) : (
          <div className="run-summary__line">
            <span>Laufzeit</span>
            <strong>{formatRuntime(monitorRuntime)}</strong>
          </div>
        )}
      </section>

      {showDgxForecast && memoryShortfall ? (
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
            title={selectedJobReadOnly
              ? "Historischer Altbestand ist nur lesbar."
              : selectedJob.favorite ? "Aus Favoriten entfernen" : "Als Favorit markieren"}
            aria-pressed={selectedJob.favorite}
            disabled={selectedJobReadOnly}
            onClick={() => onFavorite(selectedJob)}
          >
            <Star size={17} fill={selectedJob.favorite ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            className="button job-action-primary"
            title={selectedJobReadOnly
              ? "Historischer Altbestand ist ungeprüft und darf nicht in den Editor übernommen werden."
              : "Alle Einstellungen dieses Jobs in den Editor laden"}
            disabled={selectedJobReadOnly}
            onClick={() => onLoadSettings(selectedJob)}
          >
            <SlidersHorizontal size={16} /> Einstellungen übernehmen
          </button>
          <button
            type="button"
            className="icon-button"
            title={selectedJobReadOnly ? "Historischer Altbestand ist nur lesbar."
              : selectedJobQualificationHold?.reason
              ?? "Mit denselben Einstellungen und demselben Seed neu starten"}
            disabled={selectedJobReadOnly || Boolean(selectedJobQualificationHold)
              || ["queued", "running", "paused"].includes(selectedJob.status)}
            onClick={() => onRerun(selectedJob, "exact")}
          >
            <Repeat2 size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            title={selectedJobReadOnly ? "Historischer Altbestand ist nur lesbar."
              : selectedJobQualificationHold?.reason
              ?? "Variante mit neuem konkreten Seed starten"}
            disabled={selectedJobReadOnly || Boolean(selectedJobQualificationHold)
              || ["queued", "running", "paused"].includes(selectedJob.status)}
            onClick={() => onRerun(selectedJob, "random-seed")}
          >
            <Dices size={17} />
          </button>
          <span>Seed {selectedJob.request.seed}</span>
        </div>
      ) : null}

      {comparisonOutputs.length !== 2 && selectedOutput && isT2aAudioQualityCandidate(selectedOutput) ? (
        <LazyPanelBoundary label="Audio-Qualitätsanalyse">
          <Suspense fallback={<LazyPanelLoading label="Audio-Qualitätsanalyse" />}>
            <AudioQualityPanel
              key={`audio-${selectedOutput.name}-${selectedOutput.revisionToken}-${selectedOutput.audioAnalysis?.analysisId ?? "none"}-${selectedOutput.audioAnalysis?.status ?? "idle"}`}
              outputName={selectedOutput.name}
              analysis={selectedOutput.audioAnalysis}
              capability={health?.evaluators.t2aAudio ?? null}
              onStart={(force) => onStartT2aAnalysis(selectedOutput, force)}
              onCancel={(analysisId) => onCancelT2aAnalysis(selectedOutput, analysisId)}
            />
          </Suspense>
        </LazyPanelBoundary>
      ) : comparisonOutputs.length !== 2 && selectedOutput && isAudioOutputName(selectedOutput.name) ? (
        <section className="objective-analysis" role="note" aria-label="Audio-QA nicht verfügbar">
          <div className="objective-analysis__heading">
            <div>
              <h2>Audio-Qualitätsanalyse</h2>
              <p>Nur für neue, autorisierte Text-zu-Audio-Läufe verfügbar.</p>
            </div>
          </div>
        </section>
      ) : comparisonOutputs.length !== 2 && selectedOutput && isSpeechQualityCandidate(selectedOutput) ? (
        <LazyPanelBoundary label="Qualitätsanalyse">
          <Suspense fallback={<LazyPanelLoading label="Qualitätsanalyse" />}>
            <QualityScorecard
              key={`manual-${selectedOutput.name}`}
              output={selectedOutput}
              outputs={outputs}
              onSave={onSaveQualityReview}
            />
            <ObjectiveAnalysisPanel
              key={`objective-${selectedOutput.name}-${selectedOutput.revisionToken}`}
              output={selectedOutput}
              onStart={onStartAnalysis}
              onCancel={onCancelAnalysis}
              onPrepareLipSyncRetry={onPrepareLipSyncRetry}
            />
          </Suspense>
        </LazyPanelBoundary>
      ) : null}

      {qualificationHold ? (
        <div className="run-errors" role="alert">
          <ShieldCheck size={17} />
          <div><span><strong>DFR Qualification-HOLD:</strong> {qualificationHold.reason}</span></div>
        </div>
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

      <button
        type="button"
        className="run-button"
        onClick={onRun}
        disabled={runBlocked}
        title={qualificationHold?.reason}
      >
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
                    <small>{visibleJobStatus(job)} · {jobLaneLabel(job)} · Seed {job.request.seed}
                      {isLegacyDfrRequest(job.request)
                        ? " · DFR Legacy · nicht ausführbar"
                        : qualificationHoldForRequest(job.request) ? " · DFR Qualification-HOLD" : ""}</small>
                </span>
                <span className="job-row__meta">
                  {job.favorite ? <Star className="job-row__favorite" size={13} fill="currentColor" /> : null}
                  {qualityAverageForJob(job) !== null ? (
                    <span className="job-row__score">{qualityAverageForJob(job)!.toFixed(1)}</span>
                  ) : null}
                  {job.progress !== null ? <span className="job-row__progress">{Math.round(job.progress)}%</span> : null}
                </span>
              </button>
              {["queued", "running", "paused"].includes(job.status)
                || cancellingJobIds.has(job.id)
                || cancellationIsSettling(job) ? (
                <button
                  type="button"
                  className="job-row__cancel"
                  title={cancellingJobIds.has(job.id)
                    || cancellationIsSettling(job)
                    ? "Job wird abgebrochen"
                    : "Job abbrechen"}
                  disabled={cancellingJobIds.has(job.id)
                    || cancellationIsSettling(job)}
                  onClick={() => onCancel(job.id)}
                >
                  {cancellingJobIds.has(job.id)
                    || cancellationIsSettling(job)
                    ? <LoaderCircle className="spin" size={15} />
                    : <CircleStop size={15} />}
                </button>
              ) : (
                <button
                  type="button"
                  className="job-row__delete"
                  title={job.historyStatus === "legacy-unattested"
                    || outputForJob(job)?.trustStatus === "legacy-unattested"
                    ? "Historischer Altbestand ist nur lesbar."
                    : "Job aus Verlauf löschen"}
                  disabled={deletingJobId === job.id
                    || job.historyStatus === "legacy-unattested"
                    || outputForJob(job)?.trustStatus === "legacy-unattested"}
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
          {isLegacyDfrRequest(selectedJob.request) ? (
            <p className="job-cancelled">Historischer DFR-Altbestand · nur lesbar · semantische Neuausführung gesperrt.</p>
          ) : null}
          {selectedJobReadOnly && !isLegacyDfrRequest(selectedJob.request) ? (
            <p className="job-cancelled">Historischer Altbestand · ungeprüft · nur lesbar.</p>
          ) : null}
          {selectedJobQualificationHold && !isLegacyDfrRequest(selectedJob.request) ? (
            <p className="job-cancelled">DFR Qualification-HOLD · erneute Ausführung gesperrt. {selectedJobQualificationHold.reason}</p>
          ) : null}
          {selectedJob.status === "completed" && !outputForJob(selectedJob) ? (
            <p className="job-cancelled">Die Ausgabedatei wurde gelöscht; der Jobverlauf bleibt erhalten.</p>
          ) : null}
          {selectedJob.cancelledBy === "studio" ? (
            <p className="job-cancelled">{cancellationIsSettling(selectedJob)
              ? "Abbruch läuft: Prozess, Container und DGX-Zustand werden noch bestätigt."
              : "Manuell über die Studio-Abbruchfunktion beendet."}</p>
          ) : null}
          {selectedJob.variantOf ? <p className="job-lineage">Variante von {selectedJob.variantOf.slice(0, 8)}</p> : null}
          <dl className="job-facts">
            <div><dt>Status</dt><dd>{visibleJobStatus(selectedJob)}</dd></div>
            <div><dt>Erstellt</dt><dd>{new Date(selectedJob.createdAt).toLocaleString("de-AT")}</dd></div>
            <div><dt>Laufzeit</dt><dd>{formatRuntime(selectedJob.runtimeMs)}</dd></div>
            <div><dt>Ausführung</dt><dd>{executionClassLabel(selectedJob)}</dd></div>
            <div><dt>Entschieden</dt><dd>{selectedJob.executionDecisionSummary
              ? new Date(selectedJob.executionDecisionSummary.decidedAt).toLocaleString("de-AT")
              : "Legacy – keine öffentliche Decision-Zusammenfassung"}</dd></div>
            <div><dt>DGX-Job</dt><dd>{dgxJobLabel(selectedJob)}</dd></div>
            <div><dt>Logs</dt><dd>{selectedJob.logs.length} Zeilen</dd></div>
          </dl>
          {selectedJob.executionDecisionSummary ? (
            <details className="job-command">
              <summary><ShieldCheck size={14} /> Ausführungsentscheidung</summary>
              <p>{selectedJob.executionDecisionSummary.reason}</p>
              <pre>{selectedJob.executionDecisionSummary.executionClass === "cpu-only"
                ? selectedJob.executionDecisionSummary.cpuReuse!.operationKind === "ffmpeg-audio-retime"
                  ? [
                      `Quelle: ${selectedJob.executionDecisionSummary.cpuReuse!.baselineLabel}`,
                      `Quelltonversatz: ${selectedJob.executionDecisionSummary.cpuReuse!.sourceProgramAudioDelayMs} ms`,
                      `Angewendete Korrektur: ${selectedJob.executionDecisionSummary.cpuReuse!.appliedDeltaMs} ms`,
                      `Operationsstatus: ${selectedJob.executionDecisionSummary.cpuReuse!.operationState}`,
                      `Verifikation: ${selectedJob.executionDecisionSummary.verificationStatus}`,
                    ].join("\n")
                  : [
                      `Quelle: ${selectedJob.executionDecisionSummary.cpuReuse!.baselineLabel}`,
                      "Operation: gepaarten privaten Raw-Mux-Kandidaten atomar publizieren",
                      `Operationsstatus: ${selectedJob.executionDecisionSummary.cpuReuse!.operationState}`,
                      `Verifikation: ${selectedJob.executionDecisionSummary.verificationStatus}`,
                    ].join("\n")
                : [
                    `Ausführungsklasse: ${selectedJob.executionDecisionSummary.executionClass}`,
                    `Verifikation: ${selectedJob.executionDecisionSummary.verificationStatus}`,
                  ].join("\n")}</pre>
            </details>
          ) : null}
          <details className="job-command">
            <summary><Terminal size={14} /> {selectedJob.executionClass === "cpu-only"
              ? selectedJob.executionDecisionSummary?.cpuReuse?.operationKind === "paired-artifact-promotion"
                ? "Renderplan (bei Paar-Promotion nicht ausgeführt)"
                : "Renderplan (bei Audio-Retime nicht ausgeführt)"
              : "Vollständiges Kommando"}</summary>
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
