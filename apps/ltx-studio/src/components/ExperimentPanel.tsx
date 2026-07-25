import {
  ArchiveX,
  BarChart3,
  CircleCheck,
  FlaskConical,
  LoaderCircle,
  LockKeyhole,
  Play,
  ScanSearch,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  experimentVariableLabels,
  type ControlledExperiment,
  type ExperimentCandidate,
  type ExperimentCreateInput,
  type ExperimentVariableId,
} from "../../shared/experiments";
import type { GenerationRequest } from "../../shared/pipelines";
import { requiredStartMemoryForRequests } from "../../shared/estimates";
import { fieldHelp } from "../fieldHelp";
import type { Health, StudioJob, StudioOutput } from "../types";
import { InfoTooltip, NumberField, SelectField, TextField } from "./Controls";

type ExperimentPanelProps = {
  request: GenerationRequest;
  requestValid: boolean;
  experiments: ControlledExperiment[];
  jobs: StudioJob[];
  outputs: StudioOutput[];
  health: Health | null;
  runtimeGate: {
    minAvailableGiB: number;
    minResidualMemoryGiB: number;
    minSwapFreeGiB: number;
  } | null;
  onCreate: (input: ExperimentCreateInput) => Promise<void>;
  onFreeze: (id: string) => Promise<void>;
  onLaunch: (id: string, arm: "baseline" | "candidate") => Promise<void>;
  onAnalyze: (output: StudioOutput) => Promise<void>;
  onCompare: (outputs: [StudioOutput, StudioOutput]) => void;
};

function availableVariables(request: GenerationRequest): ExperimentVariableId[] {
  const variables: ExperimentVariableId[] = ["replicate-seed", "resolution"];
  if (request.mode === "audio-to-video") variables.unshift("a2v-guidance");
  if (request.images[0]) variables.push("reference-image-strength", "reference-image-crf");
  if (request.mode === "lipdub") variables.unshift("lipdub-reference-strength");
  return variables;
}

function initialValue(request: GenerationRequest, variable: ExperimentVariableId): number {
  switch (variable) {
    case "a2v-guidance":
      return request.videoGuidance.modalityScale === 3 ? 5 : 3;
    case "reference-image-strength":
      return request.images[0]?.strength === 0.9 ? 1 : 0.9;
    case "reference-image-crf":
      return request.images[0]?.crf === 0 ? 33 : 0;
    case "lipdub-reference-strength":
      return request.lipDub.referenceVideo.strength === 0.9 ? 1 : 0.9;
    case "replicate-seed":
      return request.seed === 23_072_026 ? 23_072_027 : 23_072_026;
    case "resolution":
      return request.width;
  }
}

function candidateFromState(
  variable: ExperimentVariableId,
  value: number,
  width: number,
  height: number,
): ExperimentCandidate {
  switch (variable) {
    case "a2v-guidance":
    case "reference-image-strength":
    case "lipdub-reference-strength":
      return { variable, value };
    case "reference-image-crf":
    case "replicate-seed":
      return { variable, value: Math.round(value) };
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
    case "replicate-seed":
      return String(request.seed);
    case "resolution":
      return `${request.width} x ${request.height}`;
  }
}

function outputForArm(
  experiment: ControlledExperiment,
  arm: 0 | 1,
  outputs: StudioOutput[],
): StudioOutput | undefined {
  const selected = experiment.arms[arm];
  return outputs.find((output) =>
    output.name === selected.request.outputName
    && output.jobId === selected.jobId
    && output.experiment?.experimentId === experiment.id
    && output.experiment.protocolSha256 === experiment.protocolSha256
    && output.experiment.arm === selected.arm
    && output.experiment.requestSha256 === selected.requestSha256
    && output.experimentRequestVerified === true
    && Boolean(output.provenance?.verifiedAt),
  );
}

function currentAnalysisCompleted(output: StudioOutput | undefined): boolean {
  return output?.analysis?.schemaVersion === "ltx-studio-output-analysis.v6"
    && output.analysis.status === "completed"
    && output.analysis.result?.schemaVersion === "ltx-studio-objective-quality.v6";
}

function evaluatorStatusLabel(health: Health | null): string {
  const evaluator = health?.evaluators.phonemeViseme;
  if (!evaluator) return "Status fehlt";
  if (evaluator.status === "measured") return "bereit";
  if (evaluator.status === "insufficient") return "Messung unzureichend";
  if (evaluator.status === "failed") return "Messung fehlgeschlagen";
  if (evaluator.status === "not-applicable") return "nicht anwendbar";
  const blockerLabels: Record<string, string> = {
    "legal-hold": "rechtlich gesperrt",
    "manifest-missing": "Modellfreigabe fehlt",
    "runner-unavailable": "Evaluator fehlt",
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
  runtimeGate,
  onCreate,
  onFreeze,
  onLaunch,
  onAnalyze,
  onCompare,
}: ExperimentPanelProps) {
  const variables = useMemo(() => availableVariables(request), [request]);
  const [title, setTitle] = useState("");
  const [variable, setVariable] = useState<ExperimentVariableId>(variables[0]);
  const [value, setValue] = useState(() => initialValue(request, variables[0]));
  const [width, setWidth] = useState(request.width);
  const [height, setHeight] = useState(request.height);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    await onCreate({
      title,
      baselineRequest: request,
      candidate: candidateFromState(variable, value, width, height),
    });
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
        ) : (
          <NumberField
            label="Kandidatenwert"
            hint={fieldHelp.experimentCandidate}
            min={0}
            max={variable === "reference-image-crf"
              ? 51
              : variable === "reference-image-strength"
                ? 1
                : variable === "lipdub-reference-strength"
                  ? 2
                  : variable === "a2v-guidance"
                    ? 20
                    : Number.MAX_SAFE_INTEGER}
            step={variable === "reference-image-crf" || variable === "replicate-seed" ? 1 : 0.05}
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
            const baselineRetryable = Boolean(
              baselineJob && ["failed", "cancelled", "interrupted"].includes(baselineJob.status),
            );
            const candidateRetryable = Boolean(
              candidateJob && ["failed", "cancelled", "interrupted"].includes(candidateJob.status),
            );
            const baselineOutput = outputForArm(experiment, 0, outputs);
            const candidateOutput = outputForArm(experiment, 1, outputs);
            const candidateEnabled = (
              baselineJob?.status === "completed"
              && Boolean(baselineJob.runProvenance?.verifiedAt)
            ) || Boolean(baselineOutput);
            const requiredMemoryGiB = requiredStartMemoryForRequests(
              experiment.arms.map((arm) => arm.request),
              {
                minAvailableGiB: runtimeGate?.minAvailableGiB ?? 48,
                minResidualMemoryGiB: runtimeGate?.minResidualMemoryGiB ?? 24,
              },
            );
            const gateUnknownMessages = requiredMemoryGiB === null
              ? ["LipDub-RAM wird beim Armstart aus dem Referenzvideo geprüft"]
              : [];
            const gateMessages = health === null
              ? ["Live-Ressourcenstatus fehlt"]
              : [
                  health.resources.swapFreeGiB === null
                    ? "Swap nicht messbar"
                    : health.resources.swapFreeGiB < (runtimeGate?.minSwapFreeGiB ?? 4)
                      ? `Swap ${health.resources.swapFreeGiB.toFixed(2)} / ${(runtimeGate?.minSwapFreeGiB ?? 4).toFixed(2)} GiB`
                      : null,
                  health.resources.availableMemoryGiB === null
                    ? "RAM nicht messbar"
                    : requiredMemoryGiB !== null
                      && health.resources.availableMemoryGiB < requiredMemoryGiB
                      ? `RAM ${health.resources.availableMemoryGiB.toFixed(1)} / ${requiredMemoryGiB.toFixed(1)} GiB`
                      : null,
                  health.orchestrator === "missing" ? "Orchestrator nicht erreichbar" : null,
                ].filter((message): message is string => Boolean(message));
            const phonemeViseme = health?.evaluators.phonemeViseme;
            const analysesCompleted = currentAnalysisCompleted(baselineOutput)
              && currentAnalysisCompleted(candidateOutput);
            const outputsReady = Boolean(baselineOutput && candidateOutput);
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
                  <span>{experiment.kind === "replicate" ? "Replikat" : "Einzelfaktor"}</span>
                  <span>Seed {baseline.request.seed}</span>
                  <span>
                    LongCat {baseline.request.postprocess.longcatLipsync.enabled ? "an" : "aus"}
                  </span>
                  <span>{experiment.changedRequestPaths.join(", ")}</span>
                </div>
                {experiment.protocolSha256 ? (
                  <p className="experiment-hash">
                    Protokoll {experiment.protocolSha256.slice(0, 12)}
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
                  {gateMessages.length > 0 ? (
                    <span className="is-waiting">
                      <TriangleAlert size={14} /> Start wartet: {gateMessages.join(" · ")}
                    </span>
                  ) : gateUnknownMessages.length > 0 ? (
                    <span className="is-waiting">
                      <TriangleAlert size={14} /> Startprüfung offen: {gateUnknownMessages.join(" · ")}
                    </span>
                  ) : (
                    <span className="is-ready"><CircleCheck size={14} /> Lokale Startgates bereit</span>
                  )}
                  <span className={phonemeViseme?.status === "measured" ? "is-ready" : "is-waiting"}>
                    {phonemeViseme?.status === "measured"
                      ? <CircleCheck size={14} />
                      : <TriangleAlert size={14} />}
                    Phonem/Visem: {evaluatorStatusLabel(health)}
                    <InfoTooltip
                      text={phonemeViseme?.message
                        ?? "Der Phonem-/Visem-Evaluator prüft zeitliche Zuordnung und Mundformen. Ohne freigegebenen Evaluator bleibt der SOTA-Nachweis blockiert."}
                    />
                  </span>
                </div>
                <div className="experiment-actions">
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
                  {experiment.status === "frozen" && (!baseline.jobId || baselineRetryable) ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={busyAction !== null}
                      onClick={() => void action(
                        `baseline-${experiment.id}`,
                        () => onLaunch(experiment.id, "baseline"),
                      )}
                    >
                      {busyAction === `baseline-${experiment.id}`
                        ? <LoaderCircle className="spin" size={16} />
                        : <Play size={16} />}
                      {baselineRetryable ? "Baseline erneut starten" : "Baseline starten"}
                    </button>
                  ) : null}
                  {experiment.status === "frozen"
                    && baseline.jobId
                    && (!candidate.jobId || candidateRetryable) ? (
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={busyAction !== null || !candidateEnabled}
                      title={candidateEnabled
                        ? "Kandidatenarm aus dem eingefrorenen Request starten"
                        : "Erst nach fertiger, provenienzverifizierter Baseline verfügbar"}
                      onClick={() => void action(
                        `candidate-${experiment.id}`,
                        () => onLaunch(experiment.id, "candidate"),
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
