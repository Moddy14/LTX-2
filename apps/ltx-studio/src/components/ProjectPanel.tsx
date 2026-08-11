import {
  Archive,
  Check,
  CircleCheck,
  FileClock,
  FolderKanban,
  History,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { GenerationRequest } from "../../shared/pipelines";
import type {
  ProjectArchiveRequest,
  ProjectCreateRequest,
  ProjectOutputApprovalRequest,
  ProjectOutputCaptureRequest,
  ProjectRevisionEnvelope,
  ProjectShotCreateRequest,
  ProjectShotRevisionRequest,
  StudioProject,
} from "../../shared/projects";
import type { StudioJob, StudioOutput } from "../types";
import { SelectField, TextField } from "./Controls";

type ProjectPanelProps = {
  request: GenerationRequest;
  requestValid: boolean;
  projects: ProjectRevisionEnvelope[];
  warnings: string[];
  jobs: StudioJob[];
  selectedOutput: StudioOutput | null;
  onCreate: (input: ProjectCreateRequest) => Promise<ProjectRevisionEnvelope>;
  onAddShot: (id: string, input: ProjectShotCreateRequest) => Promise<ProjectRevisionEnvelope>;
  onReviseShot: (
    id: string,
    shotId: string,
    input: ProjectShotRevisionRequest,
  ) => Promise<ProjectRevisionEnvelope>;
  onLaunch: (id: string, shotId: string, expectedRevision: number) => Promise<void>;
  onCapture: (
    id: string,
    shotId: string,
    input: ProjectOutputCaptureRequest,
  ) => Promise<ProjectRevisionEnvelope>;
  onApprove: (
    id: string,
    shotId: string,
    input: ProjectOutputApprovalRequest,
  ) => Promise<ProjectRevisionEnvelope>;
  onArchive: (id: string, input: ProjectArchiveRequest) => Promise<ProjectRevisionEnvelope>;
  onHistory: (id: string) => Promise<ProjectRevisionEnvelope[]>;
  onLoadRequest: (request: GenerationRequest) => void;
};

type ProjectShot = StudioProject["shots"][number];

const shotStatusLabels: Record<ProjectShot["status"], string> = {
  draft: "Entwurf",
  rendered: "Gerendert",
  approved: "Freigegeben",
};

const jobStatusLabels: Record<StudioJob["status"], string> = {
  queued: "wartet",
  running: "läuft",
  paused: "pausiert",
  completed: "fertig",
  failed: "fehlgeschlagen",
  cancelled: "abgebrochen",
  interrupted: "unterbrochen",
};

function latestRequest(shot: ProjectShot) {
  return shot.requestRevisions.find(({ id }) => id === shot.currentRequestRevisionId)
    ?? shot.requestRevisions.at(-1)!;
}

function outputSourceOptions(project: StudioProject) {
  return project.shots.flatMap((shot) => shot.outputHistory.map((output) => ({
    value: output.id,
    label: `${shot.order + 1}. ${shot.title} · ${output.outputName}`,
    shotId: shot.id,
    output,
  })));
}

function pathBasename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? "";
}

function latestBoundJob(shot: ProjectShot, jobs: StudioJob[]): StudioJob | null {
  const matching = jobs.filter((job) => job.project?.shotId === shot.id);
  return matching.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

export function ProjectPanel({
  request,
  requestValid,
  projects,
  warnings,
  jobs,
  selectedOutput,
  onCreate,
  onAddShot,
  onReviseShot,
  onLaunch,
  onCapture,
  onApprove,
  onArchive,
  onHistory,
  onLoadRequest,
}: ProjectPanelProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [projectTitle, setProjectTitle] = useState("");
  const [projectDescription, setProjectDescription] = useState("");
  const [shotTitle, setShotTitle] = useState("");
  const [continuityOutputId, setContinuityOutputId] = useState("");
  const [retakeSources, setRetakeSources] = useState<Record<string, string>>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [historyStatus, setHistoryStatus] = useState<string | null>(null);

  useEffect(() => {
    if (projects.some(({ projectId }) => projectId === selectedProjectId)) return;
    setSelectedProjectId(
      projects.find(({ project }) => project.status === "active")?.projectId
      ?? projects[0]?.projectId
      ?? "",
    );
  }, [projects, selectedProjectId]);

  const selected = projects.find(({ projectId }) => projectId === selectedProjectId) ?? null;
  const sourceOptions = useMemo(
    () => selected ? outputSourceOptions(selected.project) : [],
    [selected],
  );
  const continuityOptions = useMemo(() => [
    { value: "", label: "Keine gebundene Vorgängerausgabe" },
    ...sourceOptions.map(({ value, label }) => ({ value, label })),
  ], [sourceOptions]);

  const action = async <T,>(key: string, callback: () => Promise<T>): Promise<T | null> => {
    setBusyAction(key);
    setError(null);
    setHistoryStatus(null);
    try {
      return await callback();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Projektaktion fehlgeschlagen.");
      return null;
    } finally {
      setBusyAction(null);
    }
  };

  const create = async () => {
    const created = await action("create", () => onCreate({
      title: projectTitle,
      description: projectDescription,
    }));
    if (!created) return;
    setSelectedProjectId(created.projectId);
    setProjectTitle("");
    setProjectDescription("");
  };

  const addShot = async () => {
    if (!selected) return;
    const continuitySource = sourceOptions.find(({ value }) => value === continuityOutputId);
    const updated = await action("add-shot", () => onAddShot(selected.projectId, {
      expectedRevision: selected.revision,
      title: shotTitle,
      request,
      continuity: continuitySource
        ? {
            predecessorShotId: continuitySource.shotId,
            referenceOutputId: continuitySource.output.id,
          }
        : null,
    }));
    if (!updated) return;
    setShotTitle("");
    setContinuityOutputId("");
  };

  return (
    <section className="project-panel" aria-labelledby="project-panel-heading">
      <div className="run-panel__heading">
        <h2 id="project-panel-heading"><FolderKanban size={16} /> Produktionsprojekte</h2>
        <span>{projects.length}</span>
      </div>

      <details className="project-create">
        <summary>Neues Projekt anlegen</summary>
        <TextField
          label="Projekttitel"
          hint="Ein stabiler Name für die zusammengehörige Shot- und Continuity-Historie."
          value={projectTitle}
          maxLength={120}
          onChange={setProjectTitle}
        />
        <label className="field">
          <span className="field__label">Beschreibung</span>
          <textarea
            aria-label="Projektbeschreibung"
            value={projectDescription}
            maxLength={2_000}
            rows={3}
            onChange={(event) => setProjectDescription(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button button--secondary"
          disabled={!projectTitle.trim() || busyAction !== null}
          onClick={() => void create()}
        >
          {busyAction === "create" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          Projekt anlegen
        </button>
      </details>

      {projects.length > 0 ? (
        <SelectField
          label="Projekt"
          hint="Die sichtbare Revision ist die optimistische Schreibsperre für jede Änderung."
          value={selectedProjectId}
          options={projects.map((envelope) => ({
            value: envelope.projectId,
            label: `${envelope.project.title} · R${envelope.revision}${envelope.project.status === "archived" ? " · archiviert" : ""}`,
          }))}
          onChange={(id) => {
            setSelectedProjectId(id);
            setError(null);
            setHistoryStatus(null);
          }}
        />
      ) : null}

      {selected ? (
        <article className="project-workspace">
          <div className="project-workspace__summary">
            <div>
              <strong>{selected.project.title}</strong>
              <span>Revision {selected.revision} · {selected.project.status === "active" ? "aktiv" : "archiviert"}</span>
            </div>
            <span className="project-chain">
              <ShieldCheck size={14} /> {selected.previousRevisionSha256?.slice(0, 12) ?? "Genesis"}
            </span>
          </div>
          {selected.project.description ? <p className="project-description">{selected.project.description}</p> : null}

          <div className="project-actions">
            <button
              type="button"
              className="button button--secondary"
              disabled={busyAction !== null}
              onClick={() => void action("history", async () => {
                const revisions = await onHistory(selected.projectId);
                setHistoryStatus(
                  revisions.length === selected.revision
                    ? `${revisions.length} Revisionen vollständig und hashverkettet gelesen.`
                    : `Historie unvollständig: ${revisions.length} von ${selected.revision} Revisionen.`,
                );
              })}
            >
              {busyAction === "history" ? <LoaderCircle className="spin" size={16} /> : <History size={16} />}
              Kette prüfen
            </button>
            {selected.project.status === "active" ? (
              <button
                type="button"
                className="button button--secondary"
                disabled={busyAction !== null}
                onClick={() => {
                  if (!window.confirm(`Projekt „${selected.project.title}“ wirklich archivieren?`)) return;
                  void action("archive", () => onArchive(selected.projectId, {
                    expectedRevision: selected.revision,
                  }));
                }}
              >
                {busyAction === "archive" ? <LoaderCircle className="spin" size={16} /> : <Archive size={16} />}
                Archivieren
              </button>
            ) : null}
          </div>

          {historyStatus ? <p className="project-chain-status"><CircleCheck size={14} /> {historyStatus}</p> : null}

          {selected.project.status === "active" ? (
            <details className="project-create project-shot-create">
              <summary>Aktuellen Editorstand als Shot hinzufügen</summary>
              <TextField
                label="Shot-Titel"
                hint="Kurzer Szenenname; die vollständigen Renderparameter werden separat und unveränderlich gebunden."
                value={shotTitle}
                maxLength={120}
                onChange={setShotTitle}
              />
              <SelectField
                label="Continuity-Quelle"
                hint="Optional genau eine bereits protokollierte Ausgabe eines früheren Shots binden."
                value={continuityOutputId}
                options={continuityOptions}
                onChange={setContinuityOutputId}
              />
              <button
                type="button"
                className="button button--secondary"
                disabled={!requestValid || !shotTitle.trim() || busyAction !== null}
                onClick={() => void addShot()}
              >
                {busyAction === "add-shot" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
                Shot revisionsgebunden anlegen
              </button>
            </details>
          ) : null}

          <div className="project-shot-list">
            {selected.project.shots.map((shot) => {
              const currentRequest = latestRequest(shot);
              const boundJob = latestBoundJob(shot, jobs);
              const selectedBinding = selectedOutput?.project;
              const capturable = Boolean(
                selectedOutput
                && selectedBinding?.projectId === selected.projectId
                && selectedBinding.shotId === shot.id
                && shot.requestRevisions.some(({ id }) => id === selectedBinding.requestRevisionId)
                && !selected.project.shots.some((candidate) => candidate.outputHistory.some(
                  ({ jobId }) => jobId === selectedOutput.jobId,
                )),
              );
              const retakeOutputId = retakeSources[shot.id] ?? "";
              const retakeSource = sourceOptions.find(({ value }) => value === retakeOutputId)?.output;
              const retakeRequestMatches = Boolean(
                retakeSource
                && request.mode === "retake"
                && request.retake.videoName === retakeSource.outputName
                && pathBasename(request.retake.videoPath) === retakeSource.outputName,
              );
              return (
                <article className="project-shot" key={shot.id}>
                  <div className="project-shot__heading">
                    <strong>{shot.order + 1}. {shot.title}</strong>
                    <span className={`project-shot__status is-${shot.status}`}>
                      {shot.status === "approved" ? <Check size={13} /> : <FileClock size={13} />}
                      {shotStatusLabels[shot.status]}
                    </span>
                  </div>
                  <div className="project-shot__facts">
                    <span>Request R{shot.requestRevisions.length}</span>
                    <span>{currentRequest.requestSha256.slice(0, 12)}</span>
                    <span>{boundJob ? `Letzter Lauf ${jobStatusLabels[boundJob.status]}` : "Noch kein gebundener Lauf"}</span>
                  </div>
                  {shot.continuity ? (
                    <p className="project-binding"><ShieldCheck size={13} /> Continuity {shot.continuity.referenceOutputId.slice(0, 8)}</p>
                  ) : null}
                  <div className="project-actions">
                    <button
                      type="button"
                      className="button button--secondary"
                      disabled={busyAction !== null}
                      onClick={() => onLoadRequest(currentRequest.request)}
                    >
                      <RefreshCw size={15} /> In Editor laden
                    </button>
                    {selected.project.status === "active" ? (
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={busyAction !== null}
                        onClick={() => void action(
                          `launch-${shot.id}`,
                          () => onLaunch(selected.projectId, shot.id, selected.revision),
                        )}
                      >
                        {busyAction === `launch-${shot.id}`
                          ? <LoaderCircle className="spin" size={15} />
                          : <Play size={15} />}
                        Gebunden starten
                      </button>
                    ) : null}
                    {selected.project.status === "active" ? (
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={!requestValid || request.mode === "retake" || busyAction !== null}
                        title={request.mode === "retake" ? "Retake muss mit einer Quellausgabe protokolliert werden." : undefined}
                        onClick={() => void action(
                          `revise-${shot.id}`,
                          () => onReviseShot(selected.projectId, shot.id, {
                            expectedRevision: selected.revision,
                            request,
                            reason: "edit",
                            sourceOutputId: null,
                          }),
                        )}
                      >
                        {busyAction === `revise-${shot.id}`
                          ? <LoaderCircle className="spin" size={15} />
                          : <Save size={15} />}
                        Editorstand revisionieren
                      </button>
                    ) : null}
                    {capturable && selectedOutput ? (
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={busyAction !== null}
                        onClick={() => void action(
                          `capture-${shot.id}`,
                          () => onCapture(selected.projectId, shot.id, {
                            expectedRevision: selected.revision,
                            requestRevisionId: selectedBinding!.requestRevisionId,
                            outputName: selectedOutput.name,
                          }),
                        )}
                      >
                        {busyAction === `capture-${shot.id}`
                          ? <LoaderCircle className="spin" size={15} />
                          : <Save size={15} />}
                        Gewählte Ausgabe erfassen
                      </button>
                    ) : null}
                  </div>

                  {selected.project.status === "active" && sourceOptions.length > 0 ? (
                    <div className="project-retake">
                      <SelectField
                        label="Retake-Quelle"
                        hint="Die Quelle muss im Retake-Editor als exakt dieselbe Ausgabedatei gewählt sein."
                        value={retakeOutputId}
                        options={[
                          { value: "", label: "Quellausgabe wählen" },
                          ...sourceOptions.map(({ value, label }) => ({ value, label })),
                        ]}
                        onChange={(value) => setRetakeSources((current) => ({ ...current, [shot.id]: value }))}
                      />
                      <button
                        type="button"
                        className="button button--secondary"
                        disabled={!requestValid || !retakeRequestMatches || busyAction !== null}
                        title={retakeRequestMatches
                          ? "Retake als neue Request-Revision protokollieren"
                          : "Im Editor zuerst einen Retake mit exakt dieser Quellausgabe vorbereiten."}
                        onClick={() => void action(
                          `retake-${shot.id}`,
                          () => onReviseShot(selected.projectId, shot.id, {
                            expectedRevision: selected.revision,
                            request,
                            reason: "retake",
                            sourceOutputId: retakeOutputId,
                          }),
                        )}
                      >
                        {busyAction === `retake-${shot.id}`
                          ? <LoaderCircle className="spin" size={15} />
                          : <RefreshCw size={15} />}
                        Retake revisionieren
                      </button>
                    </div>
                  ) : null}

                  {shot.outputHistory.length > 0 ? (
                    <div className="project-output-list">
                      {shot.outputHistory.map((output) => (
                        <div className="project-output" key={output.id}>
                          <span>{output.outputName}</span>
                          <span>{output.exportSha256.slice(0, 12)}</span>
                          {shot.approvedOutputId === output.id ? (
                            <strong><CircleCheck size={13} /> Freigegeben</strong>
                          ) : selected.project.status === "active" ? (
                            <button
                              type="button"
                              className="button button--secondary"
                              disabled={busyAction !== null}
                              onClick={() => void action(
                                `approve-${output.id}`,
                                () => onApprove(selected.projectId, shot.id, {
                                  expectedRevision: selected.revision,
                                  outputId: output.id,
                                }),
                              )}
                            >
                              {busyAction === `approve-${output.id}`
                                ? <LoaderCircle className="spin" size={14} />
                                : <Check size={14} />}
                              Freigeben
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
          {selected.project.shots.length === 0 ? (
            <div className="compact-empty">Noch kein Shot in diesem Projekt</div>
          ) : null}
        </article>
      ) : (
        <div className="compact-empty">Noch kein Produktionsprojekt</div>
      )}

      <p className="project-evidence">
        Revisionsgebundener Produktionsverlauf · keine SOTA-Freigabe ohne P4-Evidence
      </p>
      {warnings.length > 0 ? (
        <div className="run-warnings" role="alert">
          {warnings.map((warning) => <p key={warning}>{warning}</p>)}
        </div>
      ) : null}
      {error ? <p className="section-error" role="alert">{error}</p> : null}
    </section>
  );
}
