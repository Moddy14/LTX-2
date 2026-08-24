import { Activity, Cpu, FolderClock, MemoryStick, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import packageJson from "../package.json";

import {
  createDefaultRequest,
  generationRequestSchema,
  mergeGenerationRequest,
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
  takeOutputFrame,
  takeRecommendedOutputFrame,
  cancelOutputAnalysis,
  createExperiment as createExperimentApi,
  freezeExperiment as freezeExperimentApi,
  getExperiments,
  launchExperimentArm,
} from "./api";
import { protocolOrderedComparisonOutputs } from "./objectiveComparison";
import { RefreshFence } from "./refreshFence";
import type { QualityReviewInput } from "../shared/quality";
import type { OutputAnalysisRecord } from "../shared/objectiveQuality";
import {
  MIN_SCENE_REFERENCE_FACE_SHARPNESS,
  sceneReferenceTooSoftMessage,
} from "../shared/sceneReferenceQuality";
import type {
  ControlledExperiment,
  ExperimentCreateInput,
} from "../shared/experiments";
import { ModeRail } from "./components/ModeRail";
import { RunPanel } from "./components/RunPanel";
import { LazyPanelBoundary, LazyPanelLoading } from "./components/LazyPanelBoundary";
import { importWithSingleReload } from "./lazyImport";
import { mergeOutputAnalysis, mergeOutputRefresh } from "./outputState";
import { withSceneReference } from "./sceneReference";
import {
  ApiError,
  type Health,
  type ModelInventory,
  type ResourceEstimate,
  type StudioConfig,
  type StudioJob,
  type StudioOutput,
} from "./types";

const STORAGE_KEY = "ltx-studio.request.v1";

const Editor = lazy(async () => ({
  default: (await importWithSingleReload("editor", () => import("./components/Editor"))).Editor,
}));

function restoreRequest(): GenerationRequest {
  try {
    const draft = decodeDraftParameter(window.location.search);
    if (draft !== null) {
      const currentUrl = new URL(window.location.href);
      currentUrl.searchParams.delete("draft");
      window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      return withOfficialSpeechModelPaths(mergeGenerationRequest(draft));
    }
    return withOfficialSpeechModelPaths(
      mergeGenerationRequest(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")),
    );
  } catch {
    return createDefaultRequest();
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
  const [request, setRequest] = useState<GenerationRequest>(restoreRequest);
  const requestRef = useRef(request);
  const [config, setConfig] = useState<StudioConfig | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [modelInventory, setModelInventory] = useState<ModelInventory | null>(null);
  const [historyEstimate, setHistoryEstimate] = useState<ResourceEstimate | null>(null);
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [outputs, setOutputs] = useState<StudioOutput[]>([]);
  const [experiments, setExperiments] = useState<ControlledExperiment[]>([]);
  const experimentRefreshFence = useRef(new RefreshFence());
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedOutputName, setSelectedOutputName] = useState<string | null>(null);
  const [comparisonNames, setComparisonNames] = useState<string[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingJobId, setDeletingJobId] = useState<string | null>(null);
  const [deletingOutputName, setDeletingOutputName] = useState<string | null>(null);
  const [extractingReferenceFrom, setExtractingReferenceFrom] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);
  const [preflightErrors, setPreflightErrors] = useState<string[]>([]);
  const [preflightWarnings, setPreflightWarnings] = useState<string[]>([]);
  const [preflightSuggestions, setPreflightSuggestions] = useState<PlanSuggestion[]>([]);
  const [command, setCommand] = useState<string | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [promptComposeError, setPromptComposeError] = useState<string | null>(null);
  const [promptUndo, setPromptUndo] = useState<string | null>(null);

  const validation = useMemo(() => generationRequestSchema.safeParse(request), [request]);
  const fieldErrors = useMemo(() => {
    if (!attempted || validation.success) return {};
    return Object.fromEntries(validation.error.issues.map((issue) => [issue.path.join("."), issue.message]));
  }, [attempted, validation]);
  const validationMessages = validation.success ? [] : validation.error.issues.map((issue) => issue.message);
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
      .filter((output): output is StudioOutput => Boolean(output)),
  );

  useLayoutEffect(() => {
    requestRef.current = request;
  }, [request]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(request));
  }, [request]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const experimentSnapshot = experimentRefreshFence.current.snapshot();
      const [coreResult, experimentResult] = await Promise.allSettled([
        Promise.all([
          getConfig(),
          getHealth(),
          getJobs(),
          getModels(),
          getAssets(),
          getOutputs(),
        ]),
        getExperiments(),
      ]);
      if (!mounted) return;
      if (coreResult.status === "rejected") {
        const error = coreResult.reason;
        setStartupError(error instanceof Error ? error.message : "Studio API nicht erreichbar");
        return;
      }
      const [
        nextConfig,
        nextHealth,
        nextJobs,
        nextModels,
        nextAssets,
        nextOutputs,
      ] = coreResult.value;
      setConfig(nextConfig);
      setHealth(nextHealth);
      setJobs(nextJobs);
      setOutputs((current) => mergeOutputRefresh(current, nextOutputs));
      setModelInventory(nextModels);
      setPreviews(Object.fromEntries(nextAssets.map((asset) => [asset.path, asset.url])));
      setRequest((current) => withDiscoveredModelDefaults(current, nextModels));
      if (
        experimentResult.status === "fulfilled"
        && experimentRefreshFence.current.accepts(experimentSnapshot)
      ) {
        setExperiments(experimentResult.value.experiments);
      }
      if (experimentResult.status === "rejected") {
        const error = experimentResult.reason;
        setStartupError(error instanceof Error ? error.message : "Experimentdaten sind nicht verfügbar");
      } else {
        setStartupError(null);
      }
    };
    void refresh();
    const healthTimer = window.setInterval(() => void getHealth().then(setHealth).catch(() => setHealth(null)), 10_000);
    const outputsTimer = window.setInterval(
      () => void getOutputs()
        .then((next) => setOutputs((current) => mergeOutputRefresh(current, next)))
        .catch(() => undefined),
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
      void getOutputs()
        .then((next) => setOutputs((current) => mergeOutputRefresh(current, next)))
        .catch(() => undefined);
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
    if (!outputs.some((output) => output.analysis && ["queued", "running"].includes(output.analysis.status))) return;
    const timer = window.setInterval(() => {
      void getOutputs()
        .then((next) => setOutputs((current) => mergeOutputRefresh(current, next)))
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [outputs]);

  useEffect(() => {
    setHistoryEstimate(null);
    if (!validation.success) return;
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
  }, [request, validation]);

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
    const modeDefaults = createDefaultRequest(mode);
    setRequest((current) => withOfficialSpeechModelPaths({
      ...modeDefaults,
      prompt: current.prompt,
      promptParts: current.promptParts,
      negativePrompt: current.negativePrompt,
      enhancePrompt: ["lipdub", "id-lora", "keyframes", "ic-lora", "text-to-audio"].includes(mode)
        ? false
        : current.enhancePrompt,
      sourceMode: ["keyframes", "ic-lora", "id-lora", "image-audio-to-video"].includes(mode)
        ? "image"
        : current.sourceMode,
      seed: current.seed,
      models: mode === "lipdub" ? { ...current.models, loras: [] } : current.models,
      images: ["lipdub", "text-to-audio"].includes(mode) ? [] : current.images,
      quantization: current.quantization,
      icLora: current.icLora,
      idLora: current.idLora,
      audio: current.audio,
      lipDub: current.lipDub,
      postprocess: mode === "text-to-audio"
        ? modeDefaults.postprocess
        : current.postprocess,
      retake: current.retake,
      continuity: current.continuity,
    }));
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings([]);
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
    if (!validation.success) return;
    const runtimeErrors: string[] = [];
    if (!health) runtimeErrors.push("DGX-Status ist noch nicht verfügbar.");
    else {
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
    if (!job || !window.confirm(`Job "${job.outputName}" wirklich abbrechen? Der aktuelle Prozess wird beendet.`)) return;
    try {
      const cancelled = await cancelJob(id);
      setJobs((current) => current.map((job) => job.id === id ? cancelled : job));
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Job konnte nicht abgebrochen werden."]);
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
    const merged = mergeGenerationRequest(projectRequest, projectRequest.mode);
    const loaded = withOfficialSpeechModelPaths(
      modelInventory ? withDiscoveredModelDefaults(merged, modelInventory) : merged,
    );
    setRequest({ ...loaded, outputName: nextEditableOutputName(loaded.outputName, jobs, outputs) });
    setPromptUndo(null);
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings([]);
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setPreflightSuggestions([]);
    setCommand(null);
  };

  const handleQualityReview = async (output: StudioOutput, input: QualityReviewInput) => {
    setServerErrors([]);
    try {
      const updated = await setOutputQualityReview(output.name, input);
      setOutputs((current) => current.map((item) =>
        item.name === updated.name ? mergeOutputRefresh([item], [updated])[0] : item,
      ));
    } catch (error) {
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

  const handleStartAnalysis = async (output: StudioOutput, force = false) => {
    setServerErrors([]);
    try {
      updateOutputAnalysis(output.name, await startOutputAnalysis(output.name, force));
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Objektive Analyse konnte nicht gestartet werden."]);
      throw error;
    }
  };

  const handleCancelAnalysis = async (output: StudioOutput) => {
    setServerErrors([]);
    try {
      if (!output.analysis) throw new Error("Kein aktiver Analyselauf vorhanden.");
      updateOutputAnalysis(output.name, await cancelOutputAnalysis(output.name, output.analysis.analysisId));
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Objektive Analyse konnte nicht abgebrochen werden."]);
      throw error;
    }
  };

  const handleDeleteOutput = async (output: StudioOutput) => {
    if (!window.confirm(
      `Video "${output.name}" wirklich löschen?\n\n`
      + "Die MP4 sowie gespeicherte Einstellungen, Analyse und Report werden dauerhaft entfernt. "
      + "Der Jobverlauf bleibt erhalten.",
    )) return;
    setServerErrors([]);
    setDeletingOutputName(output.name);
    try {
      await deleteOutput(output.name);
      const nextOutputs = await getOutputs();
      setOutputs(nextOutputs);
      setComparisonNames((current) => current.filter((name) => name !== output.name));
      if (selectedOutputName === output.name) {
        const next = nextOutputs[0] ?? null;
        setSelectedOutputName(next?.name ?? null);
        setSelectedJobId(next?.jobId ?? null);
      }
    } catch (error) {
      setServerErrors([error instanceof Error ? error.message : "Video konnte nicht gelöscht werden."]);
    } finally {
      setDeletingOutputName(null);
    }
  };

  const handleUseFrameAsReference = async (output: StudioOutput, atSeconds: number) => {
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
    const merged = mergeGenerationRequest(job.request, job.mode);
    const loaded = withOfficialSpeechModelPaths(
      modelInventory ? withDiscoveredModelDefaults(merged, modelInventory) : merged,
    );
    setRequest({ ...loaded, outputName: nextEditableOutputName(loaded.outputName, jobs, outputs) });
    const matchingOutput = outputs.find((output) => output.jobId === job.id || output.name === job.outputName);
    if (matchingOutput) setSelectedOutputName(matchingOutput.name);
    setPromptUndo(null);
    setAttempted(false);
    setServerErrors([]);
    setServerWarnings([]);
    setPreflightErrors([]);
    setPreflightWarnings([]);
    setCommand(null);
  };

  const loadOutputSettings = (output: StudioOutput) => {
    if (!output.request) {
      setServerErrors(["Für dieses Video ist keine verlässliche Studio-Einstellungshistorie gespeichert."]);
      setServerWarnings([]);
      setPreflightErrors([]);
      setPreflightWarnings([]);
      setPreflightSuggestions([]);
      return;
    }
    const merged = mergeGenerationRequest(output.request, output.request.mode);
    const loaded = withOfficialSpeechModelPaths(
      modelInventory ? withDiscoveredModelDefaults(merged, modelInventory) : merged,
    );
    setRequest({ ...loaded, outputName: nextEditableOutputName(output.name, jobs, outputs) });
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

  const prepareLipSyncRetry = (output: StudioOutput, referenceStrength: number) => {
    if (!output.request || output.request.mode !== "lipdub") {
      setServerErrors(["Für dieses Video können keine LipDub-Einstellungen vorbereitet werden."]);
      return;
    }
    const merged = mergeGenerationRequest(output.request, "lipdub");
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

      <div className="studio-grid">
        <ModeRail active={request.mode} onChange={changeMode} />
        <LazyPanelBoundary label="Editor">
          <Suspense fallback={<LazyPanelLoading label="Editor" />}>
            <Editor
              request={request}
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
          requestValid={validation.success}
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
