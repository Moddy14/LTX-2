import {
  ArchiveX,
  BarChart3,
  CircleCheck,
  EyeOff,
  FlaskConical,
  LoaderCircle,
  LockKeyhole,
  Play,
  ScanSearch,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AdmissionPreflightReport } from "../../shared/admissionPreflight";
import {
  availableExperimentVariables,
  experimentVariableLabels,
  generationRequestDiffPaths,
  rawMuxPairV1BaselineError,
  supportsA2vGuidanceExperiment,
  type ExperimentCandidate,
  type ExperimentCreateInput,
  type ExperimentVariableId,
} from "../../shared/experiments";
import type { PublicControlledExperiment } from "../../shared/outputPublic";
import { qualificationHoldForRequest } from "../../shared/qualificationHold";
import {
  defaultLipForcingRawOutputProfile,
  experimentalLipForcingRawOutputProfile,
  type GenerationRequest,
} from "../../shared/pipelines";
import { blindEvaluationNavigation, createBlindEvaluation, preflightExperimentArm } from "../api";
import { armRetryable } from "../experimentArms";
import { buildExperimentCreateInput } from "../experimentCreate";
import { outputForArm } from "../experimentOutputs";
import { fieldHelp } from "../fieldHelp";
import type { Health, StudioJob, StudioOutput } from "../types";
import { InfoTooltip, NumberField, SelectField, TextField } from "./Controls";

type ExperimentPanelProps = {
  request: GenerationRequest;
  requestValid: boolean;
  experiments: PublicControlledExperiment[];
  jobs: StudioJob[];
  outputs: StudioOutput[];
  health: Health | null;
  onCreate: (input: ExperimentCreateInput) => Promise<void>;
  onFreeze: (id: string) => Promise<void>;
  onLaunch: (id: string, arm: "baseline" | "candidate") => Promise<void>;
  onAnalyze: (output: StudioOutput) => Promise<void>;
  onCompare: (outputs: [StudioOutput, StudioOutput]) => void;
};

function adjacentLipForcingDelay(current: number): number {
  return current <= 475 ? current + 25 : current - 25;
}

type LipForcingDecoder = GenerationRequest["postprocess"]["lipForcing"]["decoder"];

function alternateLipForcingDecoder(decoder: LipForcingDecoder): LipForcingDecoder {
  return decoder === "wan-vae" ? "streaming-taehv" : "wan-vae";
}

function lipForcingDecoderLabel(decoder: LipForcingDecoder): string {
  return decoder === "wan-vae"
    ? "Wan-VAE (Qualitätsreferenz)"
    : "Streaming-TAEHV (schneller, anderer Decoder)";
}

function initialValue(request: GenerationRequest, variable: ExperimentVariableId): number | null {
  switch (variable) {
    case "a2v-guidance":
      return request.videoGuidance.modalityScale === 3 ? 5 : 3;
    case "reference-image-strength":
      return request.images[0]?.strength === 0.9 ? 1 : 0.9;
    case "reference-image-crf":
      return request.images[0]?.crf === 0 ? 33 : 0;
    case "lipdub-reference-strength":
      return request.lipDub.referenceVideo.strength === 0.9 ? 1 : 0.9;
    case "lipforcing-enabled":
    case "lipforcing-decoder":
    case "lipforcing-raw-output-profile":
      return null;
    case "lipforcing-mouth-delay-ms":
      return adjacentLipForcingDelay(request.postprocess.lipForcing.mouthDelayMs);
    case "lipforcing-program-audio-delay-ms":
      return adjacentLipForcingDelay(request.postprocess.lipForcing.programAudioDelayMs);
    case "replicate-seed":
      return request.seed === 23_072_026 ? 23_072_027 : 23_072_026;
    case "resolution":
      return request.width;
  }
}

function candidateFromState(
  variable: ExperimentVariableId,
  value: number | null,
  width: number,
  height: number,
  request: GenerationRequest,
): ExperimentCandidate {
  switch (variable) {
    case "a2v-guidance":
    case "reference-image-strength":
    case "lipdub-reference-strength": {
      if (value === null) throw new Error("Der Kandidatenwert fehlt.");
      return { variable, value };
    }
    case "reference-image-crf":
    case "replicate-seed":
    case "lipforcing-mouth-delay-ms":
    case "lipforcing-program-audio-delay-ms": {
      if (value === null) throw new Error("Der Kandidatenwert fehlt.");
      return { variable, value: Math.round(value) };
    }
    case "lipforcing-enabled":
      return { variable };
    case "lipforcing-decoder":
      return {
        variable,
        value: alternateLipForcingDecoder(request.postprocess.lipForcing.decoder),
      };
    case "lipforcing-raw-output-profile":
      return { variable };
    case "resolution":
      return { variable, width: Math.round(width), height: Math.round(height) };
  }
}

function jobStatus(
  jobId: string | null,
  outputName: string,
  jobs: StudioJob[],
  outputs: StudioOutput[],
): string {
  if (!jobId) return "Nicht gestartet";
  const job = jobs.find((item) => item.id === jobId);
  if (!job) {
    const output = outputs.find((item) => item.jobId === jobId && item.name === outputName);
    return output?.settingsAvailable ? "Fertig (Output-Sidecar)" : "Jobhistorie ausgelagert";
  }
  const labels: Record<StudioJob["status"], string> = {
    queued: "Wartet",
    running: "Läuft",
    paused: "Thermisch pausiert",
    completed: "Fertig",
    failed: "Fehler",
    cancelled: "Abgebrochen",
    interrupted: "Unterbrochen",
  };
  return labels[job.status];
}

function experimentValue(
  request: GenerationRequest,
  candidate: ExperimentCandidate,
): string {
  switch (candidate.variable) {
    case "a2v-guidance":
      return request.videoGuidance.modalityScale.toFixed(2).replace(/\.?0+$/, "");
    case "reference-image-strength":
      return (request.images[0]?.strength ?? 0).toFixed(2).replace(/\.?0+$/, "");
    case "reference-image-crf":
      return String(request.images[0]?.crf ?? 0);
    case "lipdub-reference-strength":
      return request.lipDub.referenceVideo.strength.toFixed(2).replace(/\.?0+$/, "");
    case "lipforcing-enabled":
      return request.postprocess.lipForcing.enabled
        ? `an (${request.postprocess.lipForcing.decoder === "wan-vae" ? "Wan-VAE" : "TAEHV"})`
        : "aus";
    case "lipforcing-decoder":
      return lipForcingDecoderLabel(request.postprocess.lipForcing.decoder);
    case "lipforcing-raw-output-profile":
      return request.postprocess.lipForcing.rawOutputProfile === experimentalLipForcingRawOutputProfile
        ? "CRF-13-Videostream unverändert muxen"
        : "CRF-13-Video beim Audiomux erneut mit CRF 18 encodieren";
    case "lipforcing-mouth-delay-ms":
      return `${request.postprocess.lipForcing.mouthDelayMs} ms`;
    case "lipforcing-program-audio-delay-ms":
      return `${request.postprocess.lipForcing.programAudioDelayMs} ms`;
    case "replicate-seed":
      return String(request.seed);
    case "resolution":
      return `${request.width} x ${request.height}`;
  }
}

function currentAnalysisCompleted(output: StudioOutput | undefined): boolean {
  return output?.analysis?.sourceSchemaVersion === "ltx-studio-output-analysis.v7"
    && output.analysis.status === "completed"
    && output.analysis.result?.schemaVersion === "ltx-studio-objective-quality.v7";
}

function evaluatorStatusLabel(health: Health | null): string {
  const evaluator = health?.evaluators.phonemeViseme;
  if (!evaluator) return "Status fehlt";
  if (evaluator.status === "measured" && evaluator.productGo === "passed") return "Product-GO freigegeben";
  if (evaluator.status === "measurement-only") return "Gemessen · keine Product-GO-Freigabe";
  if (evaluator.measurementReady) return "Messung verfügbar · keine Product-GO-Freigabe";
  if (evaluator.status === "insufficient") return "Ergebnis nicht eindeutig";
  if (evaluator.status === "failed") return "Prüfung fehlgeschlagen";
  if (evaluator.status === "not-applicable") return "nicht nötig";
  const blockerLabels: Record<string, string> = {
    "legal-hold": "nicht freigegeben",
    "manifest-missing": "nicht eingerichtet",
    "runner-unavailable": "nicht verfügbar",
  };
  return blockerLabels[evaluator.blockerCode] ?? "nicht verfügbar";
}

export function ExperimentPanel({
  request,
  requestValid,
  experiments,
  jobs,
  outputs,
  health,
  onCreate,
  onFreeze,
  onLaunch,
  onAnalyze,
  onCompare,
}: ExperimentPanelProps) {
  const variables = useMemo(() => availableExperimentVariables(request), [request]);
  const rawMuxEligibilityError = useMemo(() => (
    request.postprocess.lipForcing.enabled
      && request.postprocess.lipForcing.rawOutputProfile === defaultLipForcingRawOutputProfile
      ? rawMuxPairV1BaselineError(request)
      : null
  ), [request]);
  const reusableBaseline = useMemo(() => outputs.find((output) =>
    output.settingsAvailable
    && output.request
    && output.jobId
    && output.provenanceSummary?.status === "verified"
    && generationRequestDiffPaths(output.request, request).every((path) => path === "outputName")
  ), [outputs, request]);
  const [title, setTitle] = useState("");
  const [variable, setVariable] = useState<ExperimentVariableId>(variables[0]);
  const [value, setValue] = useState(() => initialValue(request, variables[0]));
  const [width, setWidth] = useState(request.width);
  const [height, setHeight] = useState(request.height);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preflights, setPreflights] = useState<Record<string, AdmissionPreflightReport>>({});

  useEffect(() => {
    if (variables.includes(variable)) return;
    const fallback = variables[0];
    setVariable(fallback);
    setValue(initialValue(request, fallback));
    setWidth(request.width);
    setHeight(request.height);
  }, [height, request, variable, variables, width]);

  const selectVariable = (next: ExperimentVariableId) => {
    setVariable(next);
    setValue(initialValue(request, next));
    setWidth(request.width);
    setHeight(request.height);
    setError(null);
  };

  const action = async (key: string, callback: () => Promise<void>) => {
    setBusyAction(key);
    setError(null);
    try {
      await callback();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Experimentaktion fehlgeschlagen.");
    } finally {
      setBusyAction(null);
    }
  };

  const create = () => action("create", async () => {
    const candidate = candidateFromState(variable, value, width, height, request);
    await onCreate(buildExperimentCreateInput({
      title,
      baselineRequest: request,
      reusableBaselineOutputName: reusableBaseline?.name ?? null,
      candidate,
    }));
    setTitle("");
  });

  return (
    <section className="experiment-panel" aria-labelledby="experiment-panel-heading">
      <div className="run-panel__heading">
        <h2 id="experiment-panel-heading"><FlaskConical size={16} /> Kontrollierte Experimente</h2>
        <span>{experiments.length}</span>
      </div>

      <details className="experiment-create">
        <summary>Experiment vorregistrieren</summary>
        <TextField
          label="Experimentname"
          hint={fieldHelp.experimentTitle}
          value={title}
          maxLength={120}
          placeholder="z. B. A2V Guidance 5 gegen 3"
          onChange={setTitle}
        />
        <SelectField
          label="Kontrollierte Variable"
          hint={fieldHelp.experimentVariable}
          value={variable}
          options={variables.map((item) => ({ value: item, label: experimentVariableLabels[item] }))}
          onChange={selectVariable}
        />
        {rawMuxEligibilityError ? (
          <p className="experiment-fixed-value">
            Rohvideo-Mux-Vergleich noch nicht zulässig: {rawMuxEligibilityError}
          </p>
        ) : null}
        {variable === "lipforcing-raw-output-profile" ? (
          <>
            <p className="experiment-fixed-value">
              Für diesen geplanten Einzelfaktor-Vergleich ist ein frisch gerenderter Baseline-Arm
              verpflichtend; vorhandene Ausgaben werden nicht übernommen. Kausal vergleichbar wird
              er erst nach dem gemeinsamen Pre-Mux-Artefaktnachweis.
            </p>
            <p className="experiment-fixed-value">
              Kandidat: Der vorhandene CRF-13-Videostream wird beim Upstream-Audiomux unverändert
              übernommen. Modelleingabe, Decoder und finale Timeline bleiben gleich; die GUI lässt
              den Kandidaten erst nach unabhängig belegter Paket- und Decoder-Header-Gleichheit zu.
            </p>
          </>
        ) : reusableBaseline ? (
          <p className="experiment-fixed-value">
            Verifizierte Baseline wird ohne neuen LTX-Render übernommen: {reusableBaseline.name}
          </p>
        ) : null}
        {variable === "resolution" ? (
          <div className="field-grid field-grid--2">
            <NumberField
              label="Kandidatenbreite"
              hint={fieldHelp.experimentCandidate}
              min={64}
              max={4096}
              step={64}
              value={width}
              onChange={(next) => setWidth(next ?? request.width)}
            />
            <NumberField
              label="Kandidatenhöhe"
              hint={fieldHelp.experimentCandidate}
              min={64}
              max={4096}
              step={64}
              value={height}
              onChange={(next) => setHeight(next ?? request.height)}
            />
          </div>
        ) : variable === "lipforcing-enabled" ? (
          <p className="experiment-fixed-value">
            Kandidat: LipForcing mit {request.postprocess.lipForcing.decoder === "wan-vae"
              ? "qualitativem Wan-VAE-Decoder"
              : "schnellem TAEHV-Decoder"}
          </p>
        ) : variable === "lipforcing-decoder" ? (
          <p className="experiment-fixed-value">
            Kandidat: {lipForcingDecoderLabel(alternateLipForcingDecoder(
              request.postprocess.lipForcing.decoder,
            ))}. Wan-VAE ist die Qualitätsreferenz; Streaming-TAEHV ist der schnellere,
            andere Decoder. Welcher am konkreten Clip besser abschneidet, bleibt offen.
          </p>
        ) : (
          <NumberField
            label={variable === "lipforcing-mouth-delay-ms"
              ? "Modell-Steuerung des Kandidaten (ms)"
              : variable === "lipforcing-program-audio-delay-ms"
                ? "Hörbarer Tonversatz des Kandidaten (ms)"
                : "Kandidatenwert"}
            hint={fieldHelp.experimentCandidate}
            min={variable === "lipforcing-mouth-delay-ms"
              || variable === "lipforcing-program-audio-delay-ms"
              ? -500
              : 0}
            max={variable === "lipforcing-mouth-delay-ms"
              || variable === "lipforcing-program-audio-delay-ms"
              ? 500
              : variable === "reference-image-crf"
              ? 51
              : variable === "reference-image-strength"
                ? 1
                : variable === "lipdub-reference-strength"
                  ? 2
                  : variable === "a2v-guidance"
                    ? 20
                    : Number.MAX_SAFE_INTEGER}
            step={variable === "reference-image-crf"
              || variable === "replicate-seed"
              || variable === "lipforcing-mouth-delay-ms"
              || variable === "lipforcing-program-audio-delay-ms"
              ? 1
              : 0.05}
            value={value}
            onChange={(next) => setValue(next ?? initialValue(request, variable))}
          />
        )}
        <button
          type="button"
          className="button button--secondary"
          disabled={!requestValid || !title.trim() || busyAction !== null}
          onClick={() => void create()}
        >
          {busyAction === "create" ? <LoaderCircle className="spin" size={16} /> : <FlaskConical size={16} />}
          Draft anlegen
        </button>
      </details>

      {experiments.length > 0 ? (
        <div className="experiment-list">
          {experiments.slice(0, 6).map((experiment) => {
            const baseline = experiment.arms[0];
            const candidate = experiment.arms[1];
            const baselineJob = jobs.find((job) => job.id === baseline.jobId);
            const candidateJob = jobs.find((job) => job.id === candidate.jobId);
            const baselineOutput = outputForArm(experiment, 0, outputs);
            const candidateOutput = outputForArm(experiment, 1, outputs);
            const baselineRetryable = armRetryable(baseline, baselineJob, baselineOutput);
            const candidateRetryable = armRetryable(candidate, candidateJob, candidateOutput);
            const unsupportedHistoricalTreatment = experiment.candidate.variable === "a2v-guidance"
              && !supportsA2vGuidanceExperiment(baseline.request);
            const baselineQualificationHold = qualificationHoldForRequest(baseline.request);
            const candidateQualificationHold = qualificationHoldForRequest(candidate.request);
            const experimentQualificationHold = baselineQualificationHold ?? candidateQualificationHold;
            const candidateEnabled = (
              baselineJob?.status === "completed"
              && baselineJob.runProvenanceSummary?.status === "verified"
            ) || Boolean(baselineOutput);
            const gateMessages = health === null
              ? ["Live-Systemstatus fehlt"]
              : health.orchestrator === "missing"
                ? ["DGX-Orchestrator nicht erreichbar"]
                : [];
            const phonemeViseme = health?.evaluators.phonemeViseme;
            const analysesCompleted = currentAnalysisCompleted(baselineOutput)
              && currentAnalysisCompleted(candidateOutput);
            const outputsReady = Boolean(baselineOutput && candidateOutput);
            const startableArm: "baseline" | "candidate" | null = experiment.status !== "frozen"
              || unsupportedHistoricalTreatment
              ? null
              : (!baseline.jobId || baselineRetryable)
                ? "baseline"
                : (!candidate.jobId || candidateRetryable)
                  ? "candidate"
                  : null;
            const preflightKey = startableArm ? `${experiment.id}:${startableArm}` : null;
            const preflight = preflightKey ? preflights[preflightKey] : undefined;
            const cpuOnlyPreflight = preflight?.executionClass === "cpu-only";
            const cpuOnlyBound = baselineJob?.executionClass === "cpu-only"
              || candidateJob?.executionClass === "cpu-only";
            const cpuOnlyVisible = cpuOnlyPreflight || cpuOnlyBound;
            const audioReusePreflight = preflight?.steps.some((step) =>
              step.label === "Audio-only-Reuse-Nachweis" || step.decision === "cpu-only-provenance-reuse");
            return (
              <article className="experiment-item" key={experiment.id}>
                <div className="experiment-item__heading">
                  <strong>{experiment.title}</strong>
                  <span className={`experiment-status is-${experiment.status}`}>
                    {experiment.status === "frozen"
                      ? <LockKeyhole size={13} />
                      : experiment.status === "superseded"
                        ? <ArchiveX size={13} />
                        : <FlaskConical size={13} />}
                    {experiment.status === "frozen"
                      ? "Eingefroren"
                      : experiment.status === "superseded"
                        ? "Stillgelegt"
                        : "Draft"}
                  </span>
                </div>
                <div className="experiment-item__facts">
                  <span>{experimentVariableLabels[experiment.candidate.variable]}</span>
                  <span>{experiment.kind === "replicate"
                    ? "Replikat"
                    : experiment.candidate.variable === "lipforcing-raw-output-profile"
                      ? "Geplanter Einzelfaktor"
                      : "Einzelfaktor"}</span>
                  <span>Seed {baseline.request.seed}</span>
                  <span>
                    LongCat {baseline.request.postprocess.longcatLipsync.enabled ? "an" : "aus"}
                  </span>
                  <span>{experiment.changedRequestPaths.join(", ")}</span>
                </div>
                {experiment.protocolEqualityToken ? (
                  <p className="experiment-hash">
                    Protokoll {experiment.protocolEqualityToken.slice(0, 12)}
                    <InfoTooltip text={fieldHelp.experimentProtocolHash} />
                  </p>
                ) : null}
                {experiment.status === "superseded" ? (
                  <p className="experiment-superseded">
                    {experiment.supersededReason}
                    {experiment.replacementExperimentId
                      ? ` · Ersatz ${experiment.replacementExperimentId.slice(0, 8)}`
                      : ""}
                  </p>
                ) : null}
                <div className="experiment-arms">
                  <span>
                    A · {experimentValue(baseline.request, experiment.candidate)}
                    {" · "}{jobStatus(baseline.jobId, baseline.request.outputName, jobs, outputs)}
                  </span>
                  <span>
                    B · {experimentValue(candidate.request, experiment.candidate)}
                    {" · "}{jobStatus(candidate.jobId, candidate.request.outputName, jobs, outputs)}
                  </span>
                </div>
                <div className="experiment-gates">
                  {unsupportedHistoricalTreatment ? (
                    <span className="is-waiting">
                      <TriangleAlert size={14} /> Historischer IA2V-Guidance-Arm nicht wiederholbar
                      <InfoTooltip text="Der offizielle IA2V-8+3-Pfad verwendet in beiden Stufen SimpleDenoiser und konsumiert die registrierte Guidance-Variable nicht. Der abgebrochene Arm bleibt als Audit-Evidenz sichtbar, kann aber nicht erneut gestartet werden." />
                    </span>
                  ) : experimentQualificationHold ? (
                    <span className="is-waiting">
                      <TriangleAlert size={14} /> DFR Qualification-HOLD: Produktstarts und CPU-only-Reuse sind gesperrt
                      <InfoTooltip text={experimentQualificationHold.reason} />
                    </span>
                  ) : cpuOnlyVisible ? (
                    <span className="is-ready">
                      <CircleCheck size={14} /> Gebundener CPU-only-Lauf; keine DGX-Queue erforderlich
                    </span>
                  ) : gateMessages.length > 0 ? (
                    <span className="is-waiting">
                      <TriangleAlert size={14} /> Queue nicht bereit: {gateMessages.join(" · ")}
                    </span>
                  ) : (
                    <span className="is-ready"><CircleCheck size={14} /> DGX-Queue entscheidet den Start automatisch</span>
                  )}
                  <span className={phonemeViseme?.productGo === "passed" ? "is-ready" : "is-waiting"}>
                    {phonemeViseme?.productGo === "passed"
                      ? <CircleCheck size={14} />
                      : <TriangleAlert size={14} />}
                    Laut-/Lippenprüfung: {evaluatorStatusLabel(health)}
                    <InfoTooltip
                      text={phonemeViseme?.message
                        ?? "Die App vergleicht gesprochene Laute mit der sichtbaren Lippenbewegung und prüft besonders den Lippenschluss bei P, B und M."}
                    />
                  </span>
                </div>
                {preflight ? (
                  <div className="experiment-gates">
                    <span className={preflight.verdict === "start-frei" ? "is-ready" : "is-waiting"}>
                      {preflight.verdict === "start-frei"
                        ? <CircleCheck size={14} />
                        : <TriangleAlert size={14} />}
                      Startprüfung: {cpuOnlyPreflight
                        ? "Der gebundene Bildstrom wird CPU-only übernommen; kein DGX-Lauf ist erforderlich."
                        : preflight.verdict === "hold"
                          ? "DFR bleibt im Qualification-HOLD; es wurde keine Admission oder Wiederverwendung freigegeben."
                        : preflight.verdict === "start-frei"
                          ? "Der Orchestrator würde den Lauf jetzt zulassen."
                        : preflight.verdict === "wartet"
                          ? "Der Orchestrator würde den Lauf jetzt warten lassen."
                          : audioReusePreflight
                            ? "Die gebundene Audio-only-Wiederverwendung ist gerade nicht sicher prüfbar."
                          : "Die Orchestrator-Entscheidung ist gerade nicht prüfbar."}
                      <InfoTooltip text={preflight.notes.join(" ")} />
                    </span>
                    {preflight.steps.map((step) => (
                      <span key={step.label} className={step.accepted ? "is-ready" : "is-waiting"}>
                        {step.accepted ? <CircleCheck size={14} /> : <TriangleAlert size={14} />}
                        {step.label} · {step.estimatedMemoryGiB === 0
                          ? cpuOnlyPreflight ? "kein DGX-RAM" : "Ressourcen nicht ermittelt"
                          : `${step.estimatedMemoryGiB} GiB`}: {step.message}
                      </span>
                    ))}
                  </div>
                ) : null}
                <div className="experiment-actions">
                  {startableArm ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={busyAction !== null}
                      title="Serverseitig prüfen, ob der Arm nach aktueller Evidenz CPU-only wiederverwendet wird oder welche DGX-Schritte zugelassen würden"
                      onClick={() => void action(`preflight-${experiment.id}`, async () => {
                        const report = await preflightExperimentArm(experiment.id, startableArm);
                        setPreflights((current) => ({
                          ...current,
                          [`${experiment.id}:${startableArm}`]: report,
                        }));
                      })}
                    >
                      {busyAction === `preflight-${experiment.id}`
                        ? <LoaderCircle className="spin" size={16} />
                        : <ScanSearch size={16} />}
                      Startprüfung
                    </button>
                  ) : null}
                  {experiment.status === "draft" ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={busyAction !== null}
                      onClick={() => void action(`freeze-${experiment.id}`, () => onFreeze(experiment.id))}
                    >
                      {busyAction === `freeze-${experiment.id}`
                        ? <LoaderCircle className="spin" size={16} />
                        : <LockKeyhole size={16} />}
                      Einfrieren
                    </button>
                  ) : null}
                  {experiment.status === "frozen"
                    && !unsupportedHistoricalTreatment
                    && (!baseline.jobId || baselineRetryable) ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={Boolean(baselineQualificationHold) || busyAction !== null}
                      title={baselineQualificationHold?.reason}
                      onClick={() => void action(
                        `baseline-${experiment.id}`,
                        async () => {
                          await onLaunch(experiment.id, "baseline");
                          setPreflights((current) => Object.fromEntries(
                            Object.entries(current).filter(([key]) => !key.startsWith(`${experiment.id}:`)),
                          ));
                        },
                      )}
                    >
                      {busyAction === `baseline-${experiment.id}`
                        ? <LoaderCircle className="spin" size={16} />
                        : <Play size={16} />}
                      {baselineRetryable ? "Baseline erneut starten" : "Baseline starten"}
                    </button>
                  ) : null}
                  {experiment.status === "frozen"
                    && !unsupportedHistoricalTreatment
                    && baseline.jobId
                    && (!candidate.jobId || candidateRetryable) ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={Boolean(candidateQualificationHold) || busyAction !== null || !candidateEnabled}
                      title={candidateQualificationHold?.reason ?? (candidateEnabled
                        ? "Kandidatenarm aus dem eingefrorenen Request starten"
                        : "Erst nach fertiger, provenienzverifizierter Baseline verfügbar")}
                      onClick={() => void action(
                        `candidate-${experiment.id}`,
                        async () => {
                          await onLaunch(experiment.id, "candidate");
                          setPreflights((current) => Object.fromEntries(
                            Object.entries(current).filter(([key]) => !key.startsWith(`${experiment.id}:`)),
                          ));
                        },
                      )}
                    >
                      {busyAction === `candidate-${experiment.id}`
                        ? <LoaderCircle className="spin" size={16} />
                        : <Play size={16} />}
                      {candidateRetryable ? "Kandidat erneut starten" : "Kandidat starten"}
                    </button>
                  ) : null}
                  {baseline.jobId && candidate.jobId ? (
                    <span className="experiment-bound"><CircleCheck size={15} /> Beide Arme gebunden</span>
                  ) : null}
                  {baselineOutput && candidateOutput && !analysesCompleted ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={busyAction !== null}
                      onClick={() => void action(`analyze-${experiment.id}`, async () => {
                        for (const output of [baselineOutput, candidateOutput]) {
                          if (
                            !currentAnalysisCompleted(output)
                            && (!output.analysis || !["queued", "running"].includes(output.analysis.status))
                          ) {
                            await onAnalyze(output);
                          }
                        }
                      })}
                    >
                      {busyAction === `analyze-${experiment.id}`
                        ? <LoaderCircle className="spin" size={16} />
                        : <ScanSearch size={16} />}
                      Beide analysieren
                    </button>
                  ) : null}
                  {outputsReady ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={busyAction !== null || !analysesCompleted}
                      title={analysesCompleted
                        ? "Baseline und Kandidat in eingefrorener Reihenfolge vergleichen"
                        : "Erst beide objektiven Analysen abschließen"}
                      onClick={() => onCompare([baselineOutput!, candidateOutput!])}
                    >
                      <BarChart3 size={16} /> Protokollvergleich
                    </button>
                  ) : null}
                  {outputsReady && analysesCompleted ? (
                    <button
                      type="button"
                      className="button"
                      disabled={busyAction !== null}
                      title="Neue oder bereits gebundene serverseitige X/Y-Blindbewertung öffnen"
                      onClick={() => void action(`blind-${experiment.id}`, async () => {
                        const evaluation = await createBlindEvaluation(experiment.id);
                        const navigation = await blindEvaluationNavigation(evaluation);
                        window.dispatchEvent(new CustomEvent("ltx-studio:hard-navigation", {
                          detail: { href: navigation.href },
                        }));
                      })}
                    >
                      {busyAction === `blind-${experiment.id}`
                        ? <LoaderCircle className="spin" size={16} />
                        : <EyeOff size={16} />}
                      Verblindet bewerten
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="compact-empty">Noch kein eingefrorener Versuchsplan</div>
      )}
      <p className="experiment-evidence">
        Entwicklungsprotokoll · SOTA-Evidence bleibt bis zu allen Product-Gates blockiert
        <InfoTooltip text={fieldHelp.experimentEvidenceStatus} />
      </p>
      {error ? <p className="section-error" role="alert">{error}</p> : null}
    </section>
  );
}
