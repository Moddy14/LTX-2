import { Activity, Cpu, FolderClock, MemoryStick, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import packageJson from "../package.json";

import {
  createPreferredRequest,
  generationRequestSchema,
  ia2vEditorNormalizationWarnings,
  isLegacyDfrRequest,
  mergeEditableGenerationRequest,
  PIPELINES,
  type GenerationRequest,
  type PipelineMode,
} from "../shared/pipelines";
import {
  withDiscoveredModelDefaults,
  withOfficialSpeechModelPaths,
} from "../shared/models";
import type { PlanSuggestion, PreparedLipDubReference } from "../shared/plan";
import { estimateResources } from "../shared/estimates";
import { qualificationHoldForRequest } from "../shared/qualificationHold";
import { decodeDraftParameter } from "../shared/drafts";
import { composePromptFromParts, composePromptRequestSchema } from "../shared/prompts";
import {
  cancelJob,
  deleteJob,
  deleteOutput,
  createJob,
  getConfig,
  getHealth,
  getJobs,
  getOutputs,
  getEstimate,
  getAssets,
  getModels,
  planJob,
  rerunJob,
  setJobFavorite,
  setOutputQualityReview,
  startOutputAnalysis,
  startT2aAudioAnalysis,
  takeOutputFrame,
  takeRecommendedOutputFrame,
  cancelOutputAnalysis,
  cancelT2aAudioAnalysis,
  createExperiment as createExperimentApi,
  freezeExperiment as freezeExperimentApi,
  getExperiments,
  launchExperimentArm,
} from "./api";
import { protocolOrderedComparisonOutputs } from "./objectiveComparison";
import { LatestRefreshFence, RefreshFence } from "./refreshFence";
import type { QualityReviewInput } from "../shared/quality";
import type {
  PublicControlledExperiment,
  PublicOutputAnalysisRecord as OutputAnalysisRecord,
} from "../shared/outputPublic";
import type { T2aAudioPublicAnalysisRecord } from "../shared/t2aAudioPublic";
import {
  MIN_SCENE_REFERENCE_FACE_SHARPNESS,
  sceneReferenceTooSoftMessage,
} from "../shared/sceneReferenceQuality";
import type { ExperimentCreateInput } from "../shared/experiments";
import { ModeRail } from "./components/ModeRail";
import { RunPanel } from "./components/RunPanel";
import { LazyPanelBoundary, LazyPanelLoading } from "./components/LazyPanelBoundary";
import { PersistenceHoldBanner } from "./components/PersistenceHoldBanner";
import { settleStudioStartup } from "./startupLoad";
import { importWithSingleReload } from "./lazyImport";
import {
  mergeOutputAnalysis,
  mergeOutputRefresh,
  mergeT2aAudioAnalysis,
} from "./outputState";
import { withSceneReference } from "./sceneReference";
import { requestForModeChange } from "./modeTransition";
import {
  persistRequestDraft,
  restorePersistedRequest,
  type RequestDraftMigration,
  type RestoredRequestDraft,
} from "./requestDraftStorage";
import {
  ApiError,
  type Health,
  type ModelInventory,
  type ResourceEstimate,
  type StudioConfig,
  type StudioJob,
  type StudioOutput,
} from "./types";

const Editor = lazy(async () => ({
  default: (await importWithSingleReload("editor", () => import("./components/Editor"))).Editor,
}));

const LEGACY_OUTPUT_READ_ONLY_MESSAGE =
  "Historischer Altbestand ist ungeprüft und nur lesbar; erlaubt sind ausschließlich Wiedergabe und Download.";

function restoreRequest(): RestoredRequestDraft {
  try {
    const draft = decodeDraftParameter(window.location.search);
    if (draft !== null) {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.delete("draft");
      window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      return {
        request: withOfficialSpeechModelPaths(mergeEditableGenerationRequest(draft)),
        migration: null,
        warnings: ia2vEditorNormalizationWarnings(draft),
      };
    }
    return restorePersistedRequest(localStorage);
  } catch {
    return {
      request: withOfficialSpeechModelPaths(createPreferredRequest()),
      migration: null,
      warnings: [],
    };
  }
}

function nextEditableOutputName(
  outputName: string,
  jobs: readonly StudioJob[],
  outputs: readonly StudioOutput[],
): string {
  const extension = outputName.toLowerCase().endsWith(".wav") ? ".wav" : ".mp4";
  const base = outputName.replace(/\.(?:mp4|wav)$/i, "").replace(/-(?:v|edit)\d+$/i, "");
  const used = new Set([...jobs.map((job) => job.outputName), ...outputs.map((output) => output.name)]);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = `${base}-edit${String(index).padStart(2, "0")}${extension}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-edit-${Date.now()}${extension}`;
}

function uniqueMessages(messages: readonly string[]): string[] {
  return [...new Set(messages)];
}

export function App() {
  const [restoredDraft] = useState<RestoredRequestDraft>(restoreRequest);
  const [request, setRequest] = useState<GenerationRequest>(restoredDraft.request);
  const [draftMigration, setDraftMigration] = useState<RequestDraftMigration | null>(
    restoredDraft.migration,
  );
  const requestRef = useRef(request);
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [modelInventory, setModelInventory] = useState<ModelInventory | null>(null);
  const [historyEstimate, setHistoryEstimate] = useState<ResourceEstimate | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [outputs, setOutputs] = useState<StudioOutput[]>([]);
  const [experiments, setExperiments] = useState<PublicControlledExperiment[]>([]);
  const experimentRefreshFence = useRef(new RefreshFence());
  const outputRefreshFence = useRef(new LatestRefreshFence());
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedOutputName, setSelectedOutputName] = useState<string | null>(null);
  const [comparisonNames, setComparisonNames] = useState<string[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const cancellingJobs = useRef(new Set<string>());
  const [cancellingJobIds, setCancellingJobIds] = useState<Set<string>>(() => new Set());
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [deletingOutputName, setDeletingOutputName] = useState<string | null>(null);
  const [extractingReferenceFrom, setExtractingReferenceFrom] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [serverWarnings, setServerWarnings] = useState<string[]>(restoredDraft.warnings);
  const [preflightErrors, setPreflightErrors] = useState<string[]>([]);
  const [preflightWarnings, setPreflightWarnings] = useState<string[]>([]);
  const [preflightSuggestions, setPreflightSuggestions] = useState<PlanSuggestion[]>([]);
  const [command, setCommand] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [promptComposeError, setPromptComposeError] = useState<string | null>(null);
  const [promptUndo, setPromptUndo] = useState<string | null>(null);

  const validation = useMemo(() => generationRequestSchema.safeParse(request), [request]);
  const legacyExecutionBlocked = isLegacyDfrRequest(request);
  const qualificationHold = qualificationHoldForRequest(request);
  const requestExecutable = validation.success && !legacyExecutionBlocked && !qualificationHold;
  const fieldErrors = useMemo(() => {
    if (!attempted || validation.success) return {};
    return Object.fromEntries(validation.error.issues.map((issue) => [issue.path.join("."), issue.message]));
  }, [attempted, validation]);
  const validationMessages = [
    ...(validation.success ? [] : validation.error.issues.map((issue) => issue.message)),
    ...(legacyExecutionBlocked
      ? ["Historischer DFR-Altbestand ist nur lesbar und darf nicht neu ausgeführt werden."]
      : []),
  ];
  const resourceEstimate = historyEstimate ?? estimateResources(request);
  const requiredStartMemoryGiB = Math.max(
    config?.runtime.minAvailableGiB ?? 48,
    resourceEstimate.memoryGiB + (config?.runtime.minResidualMemoryGiB ?? 24),
  );
  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? jobs[0] ?? null;
  const selectedOutput = outputs.find((output) => output.name === selectedOutputName) ?? outputs[0] ?? null;
  const comparisonOutputs = protocolOrderedComparisonOutputs(
    comparisonNames
      .map((name) => outputs.find((output) => output.name === name))
      .filter((output): output is StudioOutput => output !== undefined
        && output.trustStatus !== "legacy-unattested"),
  );

  useLayoutEffect(() => {
    requestRef.current = request;
  }, [request]);

  useEffect(() => {
    try {
      persistRequestDraft(localStorage, request, draftMigration);
    } catch {
      // The editor remains usable when browser storage is unavailable. The
      // next explicit server action still persists its own bound request.
    }
  }, [draftMigration, request]);

  const refreshOutputs = async (): Promise<void> => {
    const ticket = outputRefreshFence.current.issue();
    const next = await getOutputs();
    if (!outputRefreshFence.current.accepts(ticket)) return;
    setOutputs((current) => mergeOutputRefresh(current, next));
  };

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const experimentSnapshot = experimentRefreshFence.current.snapshot();
      const outputTicket = outputRefreshFence.current.issue();
      const { coreResult, healthResult, outputResult, experimentResult } = await settleStudioStartup({
        core: Promise.all([
          getConfig(),
          getJobs(),
          getModels(),
          getAssets(),
        ]),
        health: getHealth(),
        outputs: getOutputs(),
        experiments: getExperiments(),
        onHealthSettled: (result) => {
          if (!mounted) return;
          setHealth(result.status === "fulfilled" ? result.value : null);
        },
      });
      if (!mounted) return;
      // Health was applied independently by onHealthSettled. In particular,
      // a persistence HOLD stays visible while another startup request hangs.
      if (coreResult.status === "fulfilled") {
        const [nextConfig, nextJobs, nextModels, nextAssets] = coreResult.value;
        setConfig(nextConfig);
        setJobs(nextJobs);
        setModelInventory(nextModels);
        setPreviews(Object.fromEntries(nextAssets.map((asset) => [asset.path, asset.url])));
        setRequest((current) => withDiscoveredModelDefaults(current, nextModels));
      }
      if (outputResult.status === "fulfilled"
        && outputRefreshFence.current.accepts(outputTicket)) {
        setOutputs((current) => mergeOutputRefresh(current, outputResult.value));
      }
      if (
        experimentResult.status === "fulfilled"
        && experimentRefreshFence.current.accepts(experimentSnapshot)
      ) {
        setExperiments(experimentResult.value.experiments);
      }
      const startupFailure = [coreResult, healthResult, outputResult, experimentResult]
        .find((result) => result.status === "rejected");
      if (startupFailure?.status === "rejected") {
        const error = startupFailure.reason;
        setStartupError(error instanceof Error ? error.message : "Studio API nicht erreichbar");
      } else {
        setStartupError(null);
      }
    };
    void refresh();
    const healthTimer = window.setInterval(() => void getHealth().then(setHealth).catch(() => setHealth(null)), 10_000);
    const outputsTimer = window.setInterval(
      () => void refreshOutputs().catch(() => undefined),
      10_000,
    );
    const experimentsTimer = window.setInterval(
      () => {
        const snapshot = experimentRefreshFence.current.snapshot();
        void getExperiments()
          .then((next) => {
            if (experimentRefreshFence.current.accepts(snapshot)) setExperiments(next.experiments);
          })
          .catch(() => undefined);
      },
      10_000,
    );
    const events = new EventSource("/api/events");
    events.addEventListener("jobs", (event) => {
      setJobs(JSON.parse((event as MessageEvent).data) as StudioJob[]);
      void refreshOutputs().catch(() => undefined);
    });
    events.addEventListener("blind-scope-lock", () => {
      window.dispatchEvent(new CustomEvent("ltx-studio:hard-navigation", {
        detail: { href: "/blind-evaluation-lock" },
      }));
    });
    return () => {
      mounted = false;
      window.clearInterval(healthTimer);
      window.clearInterval(outputsTimer);
      window.clearInterval(experimentsTimer);
      events.close();
    };
  }, []);

  useEffect(() => {
    if (!outputs.some((output) => (
      output.analysis && ["queued", "running"].includes(output.analysis.status)
    ) || (
      output.audioAnalysis && ["queued", "running"].includes(output.audioAnalysis.status)
    ))) return;
    const timer = window.setInterval(() => {
      void refreshOutputs().catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [outputs]);

  useEffect(() => {
    setHistoryEstimate(null);
    if (!requestExecutable || !validation.success) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void getEstimate(validation.data).then((estimate) => {
        if (!controller.signal.aborted) setHistoryEstimate(estimate);
      }).catch(() => undefined);
    }, 400);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [request, requestExecutable, validation]);

  useEffect(() => {
    let cancelled = false;
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setPreflightSuggestions([]);
    if (request.mode !== "lipdub" || !validation.success) return;
    const plannedRequest = validation.data;
    const timer = window.setTimeout(() => {
      void planJob(plannedRequest).then((plan) => {
        if (cancelled) return;
        setCommand(plan.command);
        setPreflightErrors(plan.pathErrors);
        setPreflightWarnings(plan.pathWarnings);
        setPreflightSuggestions(plan.suggestions ?? []);
      }).catch(() => {
        if (cancelled) return;
        setPreflightErrors([]);
        setPreflightWarnings([]);
        setPreflightSuggestions([]);
      });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [request, validation]);

  const changeMode = (mode: PipelineMode) => {
    setRequest((current) => requestForModeChange(current, mode, modelInventory));
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings(mode === "image-audio-to-video"
      ? ia2vEditorNormalizationWarnings({ ...request, mode })
      : []);
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setPreflightSuggestions([]);
    setCommand(null);
  };

  const updateRequest = (nextRequest: GenerationRequest) => {
    if (nextRequest.prompt !== request.prompt) setPromptUndo(null);
    setRequest(withOfficialSpeechModelPaths(nextRequest));
  };

  const run = async () => {
    setAttempted(true);
    setServerErrors([]);
    setServerWarnings([]);
    if (!validation.success || qualificationHold) return;
    const runtimeErrors: string[] = [];
    if (!health) runtimeErrors.push("DGX-Status ist noch nicht verfügbar.");
    else {
      if (health.jobPersistence.status === "hold") {
        runtimeErrors.push("Job-Persistenz ist im Sicherheits-HOLD; ein Neustart ist erforderlich.");
      }
      if (health.engine !== "available") runtimeErrors.push("Python-Engine ist nicht verfügbar.");
      if (health.orchestrator === "missing") runtimeErrors.push("DGX-Orchestrator Runtime API ist nicht verfügbar.");
      const requiredDiskGiB = Math.max(1, Math.ceil(resourceEstimate.outputGiB * 3 * 100) / 100);
      if (health.resources.outputFreeGiB === null) {
        runtimeErrors.push("Freier Ausgabeplatz ist unbekannt.");
      } else if (health.resources.outputFreeGiB < requiredDiskGiB) {
        runtimeErrors.push(
          `Mindestens ${requiredDiskGiB.toFixed(2)} GiB Ausgabeplatz sind erforderlich; verfügbar sind ${health.resources.outputFreeGiB.toFixed(2)} GiB.`,
        );
      }
    }
    if (runtimeErrors.length > 0) {
      setServerErrors(runtimeErrors);
      return;
    }
    setSubmitting(true);
    try {
      const plan = await planJob(validation.data);
      setCommand(plan.command);
      setServerWarnings(plan.pathWarnings);
      setPreflightSuggestions(plan.suggestions ?? []);
      if (plan.pathErrors.length > 0) {
        setServerErrors(plan.pathErrors);
        return;
      }
      const job = await createJob(validation.data);
      setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setSelectedJobId(job.id);
    } catch (error) {
      if (error instanceof ApiError) {
        setServerErrors(error.issues.length > 0 ? error.issues.map((issue) => issue.message) : [error.message]);
      } else {
        setServerErrors([error instanceof Error ? error.message : "Job konnte nicht erstellt werden."]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: string) => {
    const job = jobs.find((candidate) => candidate.id === id);
    if (!job || !["queued", "running", "paused"].includes(job.status) || cancellingJobs.current.has(id)) return;
    cancellingJobs.current.add(id);
    setCancellingJobIds((current) => new Set(current).add(id));
    setServerErrors([]);
    try {
      const cancelled = await cancelJob(id);
      setJobs((current) => current.map((job) => job.id === id ? cancelled : job));
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Job konnte nicht abgebrochen werden."]);
    } finally {
      cancellingJobs.current.delete(id);
      setCancellingJobIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDeleteJob = async (job: StudioJob) => {
    if (!window.confirm(
      `Job "${job.outputName}" wirklich aus dem Verlauf löschen?\n\n`
      + "Die erzeugte Ausgabe bleibt in „Erzeugte Medien“ erhalten und kann dort separat gelöscht werden.",
    )) return;
    setServerErrors([]);
    setDeletingJobId(job.id);
    try {
      await deleteJob(job.id);
      setJobs((current) => current.filter((candidate) => candidate.id !== job.id));
      if (selectedJobId === job.id) setSelectedJobId(null);
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Job konnte nicht gelöscht werden."]);
    } finally {
      setDeletingJobId(null);
    }
  };

  const handleRerun = async (job: StudioJob, mode: "exact" | "random-seed") => {
    setServerErrors([]);
    setServerWarnings([]);
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setPreflightSuggestions([]);
    try {
      const variant = await rerunJob(job.id, mode);
      setJobs((current) => [variant, ...current.filter((item) => item.id !== variant.id)]);
      setSelectedJobId(variant.id);
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Variante konnte nicht erstellt werden."]);
    }
  };

  const handleFavorite = async (job: StudioJob) => {
    try {
      const updated = await setJobFavorite(job.id, !job.favorite);
      setJobs((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Favorit konnte nicht geändert werden."]);
    }
  };

  const handleCreateExperiment = async (input: ExperimentCreateInput) => {
    const finishMutation = experimentRefreshFence.current.beginMutation();
    try {
      const experiment = await createExperimentApi(input);
      finishMutation();
      setExperiments((current) => [experiment, ...current.filter((item) => item.id !== experiment.id)]);
    } catch (error) {
      finishMutation();
      throw error;
    }
  };

  const handleFreezeExperiment = async (id: string) => {
    const finishMutation = experimentRefreshFence.current.beginMutation();
    try {
      const experiment = await freezeExperimentApi(id);
      finishMutation();
      setExperiments((current) => current.map((item) => item.id === id ? experiment : item));
    } catch (error) {
      finishMutation();
      throw error;
    }
  };

  const handleLaunchExperiment = async (id: string, arm: "baseline" | "candidate") => {
    const finishMutation = experimentRefreshFence.current.beginMutation();
    try {
      const launched = await launchExperimentArm(id, arm);
      finishMutation();
      setExperiments((current) => current.map((item) => item.id === id ? launched.experiment : item));
      setJobs((current) => [launched.job, ...current.filter((item) => item.id !== launched.job.id)]);
      setSelectedJobId(launched.job.id);
    } catch (error) {
      finishMutation();
      throw error;
    }
  };

  const loadProjectRequest = (projectRequest: GenerationRequest) => {
    const merged = mergeEditableGenerationRequest(projectRequest, projectRequest.mode);
    const loaded = withOfficialSpeechModelPaths(
      modelInventory ? withDiscoveredModelDefaults(merged, modelInventory) : merged,
    );
    setRequest({ ...loaded, outputName: nextEditableOutputName(loaded.outputName, jobs, outputs) });
    setPromptUndo(null);
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings(ia2vEditorNormalizationWarnings(projectRequest));
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setPreflightSuggestions([]);
    setCommand(null);
  };

  const handleQualityReview = async (output: StudioOutput, input: QualityReviewInput) => {
    if (output.trustStatus === "legacy-unattested") {
      setServerErrors([LEGACY_OUTPUT_READ_ONLY_MESSAGE]);
      return;
    }
    setServerErrors([]);
    const finishMutation = outputRefreshFence.current.beginMutation();
    try {
      const updated = await setOutputQualityReview(output.name, input);
      finishMutation();
      setOutputs((current) => current.map((item) =>
        item.name === updated.name ? mergeOutputRefresh([item], [updated])[0] : item,
      ));
    } catch (error) {
      finishMutation();
      const message = error instanceof Error ? error.message : "Qualitätsbewertung konnte nicht gespeichert werden.";
      setServerErrors([message]);
      throw error;
    }
  };

  const updateOutputAnalysis = (outputName: string, analysis: OutputAnalysisRecord) => {
    setOutputs((current) => current.map((output) =>
      output.name === outputName ? mergeOutputAnalysis(output, analysis) : output,
    ));
  };

  const updateT2aAnalysis = (
    outputName: string,
    analysis: T2aAudioPublicAnalysisRecord,
  ) => {
    setOutputs((current) => current.map((output) =>
      output.name === outputName ? mergeT2aAudioAnalysis(output, analysis) : output,
    ));
  };

  const handleStartAnalysis = async (output: StudioOutput, force = false) => {
    if (output.trustStatus === "legacy-unattested") {
      const error = new Error(LEGACY_OUTPUT_READ_ONLY_MESSAGE);
      setServerErrors([error.message]);
      throw error;
    }
    setServerErrors([]);
    const finishMutation = outputRefreshFence.current.beginMutation();
    try {
      const analysis = await startOutputAnalysis(output.name, force);
      finishMutation();
      updateOutputAnalysis(output.name, analysis);
    } catch (error) {
      finishMutation();
      setServerErrors([error instanceof Error ? error.message : "Objektive Analyse konnte nicht gestartet werden."]);
      throw error;
    }
  };

  const handleCancelAnalysis = async (output: StudioOutput) => {
    if (output.trustStatus === "legacy-unattested") {
      const error = new Error(LEGACY_OUTPUT_READ_ONLY_MESSAGE);
      setServerErrors([error.message]);
      throw error;
    }
    setServerErrors([]);
    const finishMutation = outputRefreshFence.current.beginMutation();
    try {
      if (!output.analysis) throw new Error("Kein aktiver Analyselauf vorhanden.");
      const analysis = await cancelOutputAnalysis(output.name, output.analysis.analysisId);
      finishMutation();
      updateOutputAnalysis(output.name, analysis);
    } catch (error) {
      finishMutation();
      setServerErrors([error instanceof Error ? error.message : "Objektive Analyse konnte nicht abgebrochen werden."]);
      throw error;
    }
  };

  const handleStartT2aAnalysis = async (output: StudioOutput, force = false) => {
    if (output.trustStatus === "legacy-unattested") {
      const error = new Error(LEGACY_OUTPUT_READ_ONLY_MESSAGE);
      setServerErrors([error.message]);
      throw error;
    }
    setServerErrors([]);
    const finishMutation = outputRefreshFence.current.beginMutation();
    try {
      const analysis = await startT2aAudioAnalysis(output.name, force);
      finishMutation();
      updateT2aAnalysis(output.name, analysis);
    } catch (error) {
      finishMutation();
      setServerErrors([error instanceof Error ? error.message : "Audioanalyse konnte nicht gestartet werden."]);
      throw error;
    }
  };

  const handleCancelT2aAnalysis = async (output: StudioOutput, analysisId: string) => {
    if (output.trustStatus === "legacy-unattested") {
      const error = new Error(LEGACY_OUTPUT_READ_ONLY_MESSAGE);
      setServerErrors([error.message]);
      throw error;
    }
    setServerErrors([]);
    const finishMutation = outputRefreshFence.current.beginMutation();
    try {
      const analysis = await cancelT2aAudioAnalysis(output.name, analysisId);
      finishMutation();
      updateT2aAnalysis(output.name, analysis);
    } catch (error) {
      finishMutation();
      setServerErrors([error instanceof Error ? error.message : "Audioanalyse konnte nicht abgebrochen werden."]);
      throw error;
    }
  };

  const handleDeleteOutput = async (output: StudioOutput) => {
    if (output.trustStatus === "legacy-unattested") {
      setServerErrors([LEGACY_OUTPUT_READ_ONLY_MESSAGE]);
      return;
    }
    if (!window.confirm(
      `Ausgabe "${output.name}" wirklich löschen?\n\n`
      + "Die Mediendatei sowie gespeicherte Einstellungen, Analyse und Report werden dauerhaft entfernt. "
      + "Der Jobverlauf bleibt erhalten.",
    )) return;
    setServerErrors([]);
    setDeletingOutputName(output.name);
    const finishMutation = outputRefreshFence.current.beginMutation();
    try {
      await deleteOutput(output.name);
      finishMutation();
      setOutputs((current) => current.filter((candidate) => candidate.name !== output.name));
      setComparisonNames((current) => current.filter((name) => name !== output.name));
      if (selectedOutputName === output.name) {
        setSelectedOutputName(null);
        setSelectedJobId(null);
      }
    } catch (error) {
      finishMutation();
      setServerErrors([error instanceof Error ? error.message : "Ausgabe konnte nicht gelöscht werden."]);
    } finally {
      setDeletingOutputName(null);
    }
  };

  const handleUseFrameAsReference = async (output: StudioOutput, atSeconds: number) => {
    if (output.trustStatus === "legacy-unattested") {
      setServerErrors([LEGACY_OUTPUT_READ_ONLY_MESSAGE]);
      return;
    }
    setServerErrors([]);
    setServerWarnings([]);
    setExtractingReferenceFrom(output.name);
    try {
      const asset = await takeOutputFrame(output.name, atSeconds);
      setPreviews((current) => ({ ...current, [asset.path]: asset.url }));
      setRequest((current) => ({
        ...withSceneReference(current, asset),
        outputName: nextEditableOutputName(current.outputName, jobs, outputs),
      }));
      setAttempted(false);
      setPreflightErrors([]);
      setPreflightWarnings([]);
      setPreflightSuggestions([]);
      setCommand(null);
      setServerWarnings([
        `Der sichtbare Frame bei ${atSeconds.toLocaleString("de-AT", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} s ist als Szenenreferenz mit Stärke 1,0 im Editor eingesetzt.`,
      ]);
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Frame konnte nicht als Referenz übernommen werden."]);
    } finally {
      setExtractingReferenceFrom(null);
    }
  };

  const handleUseBestFrameAsReference = async (output: StudioOutput): Promise<number | null> => {
    if (output.trustStatus === "legacy-unattested") {
      setServerErrors([LEGACY_OUTPUT_READ_ONLY_MESSAGE]);
      return null;
    }
    setServerErrors([]);
    setServerWarnings([]);
    setExtractingReferenceFrom(output.name);
    try {
      const { asset, recommendation } = await takeRecommendedOutputFrame(output.name);
      if (recommendation.metrics.faceSharpness < MIN_SCENE_REFERENCE_FACE_SHARPNESS) {
        setServerErrors([sceneReferenceTooSoftMessage(recommendation.metrics.faceSharpness)]);
        return null;
      }
      setPreviews((current) => ({ ...current, [asset.path]: asset.url }));
      setRequest((current) => ({
        ...withSceneReference(current, asset),
        outputName: nextEditableOutputName(current.outputName, jobs, outputs),
      }));
      setAttempted(false);
      setPreflightErrors([]);
      setPreflightWarnings([]);
      setPreflightSuggestions([]);
      setCommand(null);
      setServerWarnings([
        `Automatisch gewählter Frame bei ${recommendation.atSeconds.toLocaleString("de-AT", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} s eingesetzt: Gesichtsschärfe ${recommendation.metrics.faceSharpness.toLocaleString("de-AT", {
          maximumFractionDigits: 1,
        })}, Stabilität ${(recommendation.metrics.stability * 100).toLocaleString("de-AT", {
          maximumFractionDigits: 0,
        })} %, ${recommendation.eligibleFrames} geeignete Frames geprüft.`,
      ]);
      return recommendation.atSeconds;
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Bester Referenzframe konnte nicht ermittelt werden."]);
      return null;
    } finally {
      setExtractingReferenceFrom(null);
    }
  };

  const toggleComparison = (output: StudioOutput) => {
    if (output.trustStatus === "legacy-unattested") {
      setServerErrors([LEGACY_OUTPUT_READ_ONLY_MESSAGE]);
      return;
    }
    setComparisonNames((current) => {
      if (current.includes(output.name)) return current.filter((name) => name !== output.name);
      return current.length < 2 ? [...current, output.name] : [current[1], output.name];
    });
  };

  const handleComposePrompt = () => {
    setPromptComposeError(null);
    try {
      const compositionInput = composePromptRequestSchema.parse({
        mode: request.mode,
        sourceMode: request.sourceMode,
        currentPrompt: request.prompt,
        parts: request.promptParts,
        continuity: request.continuity,
      });
      const result = composePromptFromParts(compositionInput);
      setPromptUndo(request.prompt);
      setRequest((current) => ({ ...current, prompt: result.prompt }));
    } catch (error) {
      setPromptComposeError(error instanceof Error ? error.message : "Prompt-Bausteine konnten nicht übernommen werden.");
    }
  };

  const loadJobSettings = (job: StudioJob) => {
    const merged = mergeEditableGenerationRequest(job.request, job.mode);
    const loaded = withOfficialSpeechModelPaths(
      modelInventory ? withDiscoveredModelDefaults(merged, modelInventory) : merged,
    );
    setRequest({ ...loaded, outputName: nextEditableOutputName(loaded.outputName, jobs, outputs) });
    const matchingOutput = outputs.find((output) => output.jobId === job.id || output.name === job.outputName);
    if (matchingOutput) setSelectedOutputName(matchingOutput.name);
    setPromptUndo(null);
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings(ia2vEditorNormalizationWarnings(job.request));
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setCommand(null);
  };

  const loadOutputSettings = (output: StudioOutput) => {
    if (output.trustStatus === "legacy-unattested") {
      setServerErrors([LEGACY_OUTPUT_READ_ONLY_MESSAGE]);
      return;
    }
    if (!output.request) {
      setServerErrors(["Für dieses Video ist keine verlässliche Studio-Einstellungshistorie gespeichert."]);
      setServerWarnings([]);
      setPreflightErrors([]);
      setPreflightWarnings([]);
      setPreflightSuggestions([]);
      return;
    }
    const merged = mergeEditableGenerationRequest(output.request, output.request.mode);
    const loaded = withOfficialSpeechModelPaths(
      modelInventory ? withDiscoveredModelDefaults(merged, modelInventory) : merged,
    );
    setRequest({ ...loaded, outputName: nextEditableOutputName(output.name, jobs, outputs) });
    setSelectedOutputName(output.name);
    if (output.jobId) setSelectedJobId(output.jobId);
    setPromptUndo(null);
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings(ia2vEditorNormalizationWarnings(output.request));
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setPreflightSuggestions([]);
    setCommand(null);
  };

  const prepareLipSyncRetry = (output: StudioOutput, referenceStrength: number) => {
    if (output.trustStatus === "legacy-unattested") {
      setServerErrors([LEGACY_OUTPUT_READ_ONLY_MESSAGE]);
      return;
    }
    if (!output.request || output.request.mode !== "lipdub") {
      setServerErrors(["Für dieses Video können keine LipDub-Einstellungen vorbereitet werden."]);
      return;
    }
    const merged = mergeEditableGenerationRequest(output.request, "lipdub");
    const loaded = withOfficialSpeechModelPaths(
      modelInventory ? withDiscoveredModelDefaults(merged, modelInventory) : merged,
    );
    setRequest({
      ...loaded,
      outputName: nextEditableOutputName(output.name, jobs, outputs),
      lipDub: {
        ...loaded.lipDub,
        referenceVideo: {
          ...loaded.lipDub.referenceVideo,
          strength: referenceStrength,
        },
      },
    });
    setSelectedOutputName(output.name);
    if (output.jobId) setSelectedJobId(output.jobId);
    setPromptUndo(null);
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings([]);
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setPreflightSuggestions([]);
    setCommand(null);
  };

  const applyPlanSuggestion = (suggestion: PlanSuggestion) => {
    setRequest((current) => ({ ...current, ...suggestion.patch }));
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings([]);
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setPreflightSuggestions([]);
    setCommand(null);
  };

  const applyPreparedLipDubReference = (prepared: PreparedLipDubReference, sourcePath: string): boolean => {
    const currentRequest = requestRef.current;
    if (currentRequest.mode !== "lipdub" || currentRequest.lipDub.referenceVideo.path !== sourcePath) return false;
    setPreviews((current) => ({ ...current, [prepared.asset.path]: prepared.asset.url }));
    setRequest((current) => {
      if (current.mode !== "lipdub" || current.lipDub.referenceVideo.path !== sourcePath) return current;
      return {
        ...current,
        width: prepared.target.width,
        height: prepared.target.height,
        lipDub: {
          ...current.lipDub,
          referenceVideo: {
            ...current.lipDub.referenceVideo,
            path: prepared.asset.path,
            name: prepared.asset.name,
          },
        },
      };
    });
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings([]);
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setPreflightSuggestions([]);
    setCommand(null);
    return true;
  };

  const activePipeline = PIPELINES.find((pipeline) => pipeline.id === request.mode) ?? PIPELINES[0];
  const memoryLabel = health?.resources.availableMemoryGiB === null || health?.resources.availableMemoryGiB === undefined
    ? "Unbekannt"
    : `${health.resources.availableMemoryGiB.toFixed(1)} GiB`;
  const memoryPressure = health?.resources.availableMemoryGiB !== null
    && health?.resources.availableMemoryGiB !== undefined
    && health.resources.availableMemoryGiB < requiredStartMemoryGiB;
  const authorityAttested = health?.release?.authorityIsolation?.status === "attested";

  return (
    <div className="studio-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark"><Sparkles size={19} /></span>
          <strong>LTX Studio</strong>
          <span className="version-mark">{packageJson.version}</span>
        </div>
        <div className="topbar__context">
          <span>{activePipeline.shortLabel}</span>
          <span className="topbar__divider" />
          <span>{request.outputName}</span>
        </div>
        <div className="health-strip">
          <span className={`health-item health-item--${health?.qwen === "ready" ? "ok" : "warn"}`} title="Qwen Status">
            <Activity size={15} /> Qwen
          </span>
          <span className={`health-item health-item--${health?.engine === "available" ? "ok" : "warn"}`} title="Python Engine">
            <Cpu size={15} /> Engine
          </span>
          <span className={`health-item health-item--${health?.orchestrator === "missing" ? "blocked" : "ok"}`} title="DGX-Orchestrator Admission">
            <ShieldCheck size={15} /> Admission
          </span>
          <span
            className={`health-item health-item--${authorityAttested ? "ok" : "warn"}`}
            title={authorityAttested
              ? "Execution-/Publication-Autorität ist separat attestiert"
              : "Security-/Product-GO bleibt ohne separate Studio-Identität mit proc/fd-Isolation oder externen Signer-/Sealed-FD-Broker gesperrt"}
          >
            <ShieldCheck size={15} /> Authority {authorityAttested ? "PASS" : "HOLD"}
          </span>
          <span className={`health-item health-item--${memoryPressure ? "warn" : "ok"}`} title="Verfügbarer Arbeitsspeicher; Startfreigabe erfolgt über die DGX-Queue">
            <MemoryStick size={15} /> {memoryLabel}
          </span>
          <span className="health-item" title="Aktive und wartende Jobs"><FolderClock size={15} /> {health?.queueDepth ?? 0}</span>
        </div>
      </header>

      {startupError ? (
        <div className="startup-error" role="alert">
          <span>{startupError}</span>
          <button type="button" className="icon-button" title="Neu laden" onClick={() => window.location.reload()}><RefreshCw size={17} /></button>
        </div>
      ) : null}

      {draftMigration?.noticePending ? (
        <div className="draft-migration-notice" role="status">
          <span>{draftMigration.kind === "auto-default-upgraded"
            ? "Der automatisch gespeicherte LTX-2.3-Startentwurf wurde unverändert archiviert. Der Editor startet latest-first mit LTX-2.5; der Altentwurf wird nur nach ausdrücklicher Auswahl geladen."
            : "Der individuelle v1-Altentwurf wurde unverändert archiviert. Der Editor startet latest-first mit LTX-2.5; der Altentwurf wird nur nach ausdrücklicher Auswahl geladen."}</span>
          <div className="draft-migration-notice__actions">
            <button
              type="button"
              className="button"
              onClick={() => {
                setRequest(draftMigration.legacyRequest);
                setDraftMigration({
                  ...draftMigration,
                  kind: "legacy-draft-archived",
                  noticePending: false,
                });
              }}
            >
              Altentwurf exakt laden
            </button>
            <button
              type="button"
              className="button"
              onClick={() => setDraftMigration({ ...draftMigration, noticePending: false })}
            >
              Hinweis schließen
            </button>
          </div>
        </div>
      ) : null}

      <PersistenceHoldBanner
        health={health}
        onReload={() => window.location.reload()}
      />

      <div className="studio-grid">
        <ModeRail active={request.mode} onChange={changeMode} />
        <LazyPanelBoundary label="Editor">
          <Suspense fallback={<LazyPanelLoading label="Editor" />}>
            <Editor
              request={request}
              resourceEstimate={resourceEstimate}
              onChange={updateRequest}
              errors={fieldErrors}
              previews={previews}
              onPreview={(path, url) => setPreviews((current) => ({ ...current, [path]: url }))}
              onPreparedLipDubReference={applyPreparedLipDubReference}
              onComposePrompt={handleComposePrompt}
              promptComposeError={promptComposeError}
              modelInventory={modelInventory}
              canUndoPrompt={promptUndo !== null}
              onUndoPrompt={() => {
                if (promptUndo === null) return;
                setRequest((current) => ({ ...current, prompt: promptUndo }));
                setPromptUndo(null);
              }}
            />
          </Suspense>
        </LazyPanelBoundary>
        <RunPanel
          request={request}
          requestValid={requestExecutable}
          health={health}
          jobs={jobs}
          outputs={outputs}
          selectedJob={selectedJob}
          selectedOutput={selectedOutput}
          onSelectJob={(job) => {
            setSelectedJobId(job.id);
            const matchingOutput = outputs.find((output) => output.jobId === job.id || output.name === job.outputName);
            if (matchingOutput) setSelectedOutputName(matchingOutput.name);
          }}
          onSelectOutput={(output) => {
            setSelectedOutputName(output.name);
            if (output.jobId) setSelectedJobId(output.jobId);
          }}
          onRun={() => void run()}
          onCancel={(id) => void handleCancel(id)}
          cancellingJobIds={cancellingJobIds}
          onDeleteJob={handleDeleteJob}
          deletingJobId={deletingJobId}
          submitting={submitting}
          errors={attempted
            ? uniqueMessages([...validationMessages, ...serverErrors])
            : uniqueMessages([...preflightErrors, ...serverErrors])}
          warnings={uniqueMessages([...preflightWarnings, ...serverWarnings])}
          suggestions={preflightSuggestions}
          onApplySuggestion={applyPlanSuggestion}
          command={command}
          previews={previews}
          comparisonOutputs={comparisonOutputs}
          comparisonNames={comparisonNames}
          estimate={resourceEstimate}
          requiredStartMemoryGiB={requiredStartMemoryGiB}
          onToggleCompare={toggleComparison}
          onCompareExperiment={(experimentOutputs) => {
            setComparisonNames(experimentOutputs.map((output) => output.name));
            setSelectedOutputName(experimentOutputs[1].name);
          }}
          onRerun={(job, mode) => void handleRerun(job, mode)}
          onFavorite={(job) => void handleFavorite(job)}
          onSaveQualityReview={handleQualityReview}
          onStartAnalysis={handleStartAnalysis}
          onCancelAnalysis={handleCancelAnalysis}
          onStartT2aAnalysis={handleStartT2aAnalysis}
          onCancelT2aAnalysis={handleCancelT2aAnalysis}
          onPrepareLipSyncRetry={prepareLipSyncRetry}
          onDeleteOutput={handleDeleteOutput}
          deletingOutputName={deletingOutputName}
          onLoadSettings={loadJobSettings}
          onLoadOutputSettings={loadOutputSettings}
          onUseFrameAsReference={handleUseFrameAsReference}
          onUseBestFrameAsReference={handleUseBestFrameAsReference}
          qualityGuidedSceneReferenceAvailable={Boolean(config?.features?.qualityGuidedSceneReference)}
          extractingReferenceFrom={extractingReferenceFrom}
          experiments={experiments}
          onCreateExperiment={handleCreateExperiment}
          onFreezeExperiment={handleFreezeExperiment}
          onLaunchExperiment={handleLaunchExperiment}
          onProjectJobLaunched={(job) => {
            setJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
            setSelectedJobId(job.id);
          }}
          onLoadProjectRequest={loadProjectRequest}
        />
      </div>

      {config ? (
        <span className="sr-only">
          Render-Startfreigabe erfolgt über die DGX-Orchestrator-Queue; RAM und Swap bleiben sichtbare Zustandswerte.
        </span>
      ) : null}
    </div>
  );
}
