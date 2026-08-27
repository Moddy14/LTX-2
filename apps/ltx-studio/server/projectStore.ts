import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  generationRequestSchema,
  isLegacyDfrRequest,
  migrateGenerationRequest,
} from "../shared/pipelines.js";
import {
  projectArchiveInputSchema,
  projectCreateInputSchema,
  projectOutputApprovalInputSchema,
  projectOutputRecordInputSchema,
  projectRunBindingSchema,
  projectRevisionEnvelopeSchema,
  projectShotCreateInputSchema,
  projectShotRevisionInputSchema,
  studioProjectSchema,
  type ProjectArchiveInput,
  type ProjectCreateInput,
  type ProjectOutputApprovalInput,
  type ProjectOutputRecordInput,
  type ProjectRevisionEnvelope,
  type ProjectRunBinding,
  type ProjectShotCreateInput,
  type ProjectShotRevisionInput,
  type StudioProject,
} from "../shared/projects.js";
import { DataRecoveryCoordinator } from "./dataRecoveryJournal.js";

const PROJECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_FILE_PATTERN = /^(\d{8})\.json$/;
const MAX_REVISION_BYTES = 32 * 1024 * 1024;

export class ProjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectConflictError";
  }
}

export function projectValueSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalDocument(value: unknown): string {
  return canonicalJson(value);
}

function assertRealDirectory(path: string, context: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ProjectConflictError(`${context} muss ein echtes Verzeichnis sein.`);
  }
  const effectiveUid = process.geteuid?.();
  if ((metadata.mode & 0o077) !== 0 || (effectiveUid !== undefined && metadata.uid !== effectiveUid)) {
    throw new ProjectConflictError(`${context} muss owner-only geschützt sein.`);
  }
}

function revisionFileName(revision: number): string {
  return `${revision.toString().padStart(8, "0")}.json`;
}

function findShot(project: StudioProject, shotId: string) {
  const shot = project.shots.find(({ id }) => id === shotId);
  if (!shot) throw new ProjectConflictError("Shot nicht gefunden.");
  return shot;
}

function assertActive(project: StudioProject): void {
  if (project.status !== "active") {
    throw new ProjectConflictError("Ein archiviertes Projekt ist unveränderlich.");
  }
  if (project.shots.some((shot) => shot.requestRevisions.some(({ request }) =>
    isLegacyDfrRequest(request)))) {
    throw new ProjectConflictError(
      "Ein Projekt mit historischem DFR-Altbestand bleibt unveränderlich lesbar und darf nicht fortgesetzt werden.",
    );
  }
}

/**
 * Preserve canonical persisted project bytes and their original request
 * digests, but expose a deliberately non-executable archival view for the
 * one known incompatible request family. Unknown corruption remains fatal.
 */
function legacyReadableProjectEnvelope(value: unknown): unknown | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const migrated = structuredClone(value) as Record<string, unknown>;
  const project = migrated.project;
  if (!project || typeof project !== "object" || Array.isArray(project)) return null;
  const shots = (project as Record<string, unknown>).shots;
  if (!Array.isArray(shots)) return null;
  for (const shot of shots) {
    if (!shot || typeof shot !== "object" || Array.isArray(shot)) return null;
    const revisions = (shot as Record<string, unknown>).requestRevisions;
    if (!Array.isArray(revisions)) return null;
    for (const revision of revisions) {
      if (!revision || typeof revision !== "object" || Array.isArray(revision)) return null;
      const record = revision as Record<string, unknown>;
      const current = generationRequestSchema.safeParse(record.request);
      if (current.success) {
        record.request = current.data;
        continue;
      }
      const legacy = migrateGenerationRequest(record.request);
      if (!legacy || !isLegacyDfrRequest(legacy)) return null;
      record.request = legacy;
    }
  }
  return migrated;
}

function assertRequestDigests(project: StudioProject): void {
  for (const shot of project.shots) {
    const revisions = new Map(shot.requestRevisions.map((revision) => [revision.id, revision]));
    for (const revision of shot.requestRevisions) {
      if (projectValueSha256(revision.request) !== revision.requestSha256) {
        throw new ProjectConflictError(`Request-Revision ${revision.id} ist nicht hashkonsistent.`);
      }
    }
    for (const output of shot.outputHistory) {
      if (revisions.get(output.requestRevisionId)?.requestSha256 !== output.requestSha256) {
        throw new ProjectConflictError(`Ausgabe ${output.id} bindet nicht ihre exakte Request-Revision.`);
      }
    }
  }
}

function assertUnchanged(left: unknown, right: unknown, context: string): void {
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new ProjectConflictError(`Projekt-Revision verändert unerlaubt ${context}.`);
  }
}

function assertRevisionTransition(
  previous: ProjectRevisionEnvelope | null,
  current: ProjectRevisionEnvelope,
): void {
  const project = current.project;
  if (project.updatedAt !== current.recordedAt) {
    throw new ProjectConflictError("Projekt- und Revisionszeitpunkt müssen identisch sein.");
  }
  if (previous === null) {
    if (
      current.revision !== 1
      || current.mutation.type !== "project-created"
      || project.status !== "active"
      || project.shots.length !== 0
      || project.createdAt !== current.recordedAt
    ) {
      throw new ProjectConflictError("Die erste Projekt-Revision ist kein leerer, aktiver Projekt-Create.");
    }
    return;
  }
  if (
    current.revision !== previous.revision + 1
    || current.previousRevisionSha256 !== projectValueSha256(previous)
    || current.recordedAt < previous.recordedAt
  ) {
    throw new ProjectConflictError("Projekt-Revisionskette ist nicht monoton oder hashkonsistent.");
  }
  assertUnchanged(project.id, previous.project.id, "die Projekt-ID");
  assertUnchanged(project.title, previous.project.title, "den Projekttitel");
  assertUnchanged(project.description, previous.project.description, "die Projektbeschreibung");
  assertUnchanged(project.createdAt, previous.project.createdAt, "den Erstellungszeitpunkt");

  const prior = previous.project;
  const mutation = current.mutation;
  if (mutation.type === "shot-added") {
    if (project.status !== "active" || project.shots.length !== prior.shots.length + 1) {
      throw new ProjectConflictError("Shot-Add hat eine unerlaubte Projektform.");
    }
    assertUnchanged(project.shots.slice(0, -1), prior.shots, "bestehende Shots");
    const added = project.shots.at(-1);
    if (
      !added
      || added.id !== mutation.shotId
      || added.order !== prior.shots.length
      || added.requestRevisions[0]?.actorId !== mutation.actorId
      || added.requestRevisions[0]?.createdAt !== current.recordedAt
    ) {
      throw new ProjectConflictError("Shot-Add bindet nicht den angehängten Shot.");
    }
    assertUnchanged(project.status, prior.status, "den Projektstatus");
    return;
  }
  if (mutation.type === "project-archived") {
    if (prior.status !== "active" || project.status !== "archived") {
      throw new ProjectConflictError("Projekt-Archive besitzt keinen gültigen Statusübergang.");
    }
    assertUnchanged(project.shots, prior.shots, "die Shots beim Archivieren");
    return;
  }
  if (mutation.type === "project-created") {
    throw new ProjectConflictError("Project-Create darf nur die erste Revision sein.");
  }
  if (project.status !== prior.status || project.shots.length !== prior.shots.length) {
    throw new ProjectConflictError("Shot-Mutation verändert unerlaubt Projektstatus oder Shot-Anzahl.");
  }
  const shotIndex = prior.shots.findIndex(({ id }) => id === mutation.shotId);
  if (shotIndex < 0) throw new ProjectConflictError("Mutation referenziert einen unbekannten Shot.");
  project.shots.forEach((shot, index) => {
    if (index !== shotIndex) assertUnchanged(shot, prior.shots[index], "einen unbeteiligten Shot");
  });
  const before = prior.shots[shotIndex];
  const after = project.shots[shotIndex];
  if (!before || !after) throw new ProjectConflictError("Shot-Revision ist unvollständig.");
  if (mutation.type === "shot-request-revised") {
    if (after.requestRevisions.length !== before.requestRevisions.length + 1) {
      throw new ProjectConflictError("Request-Revision wurde nicht genau einmal angehängt.");
    }
    assertUnchanged(after.requestRevisions.slice(0, -1), before.requestRevisions, "die Request-Historie");
    assertUnchanged(after.outputHistory, before.outputHistory, "die Ausgabehistorie");
    assertUnchanged(after.continuity, before.continuity, "die Continuity-Bindung");
    assertUnchanged(after.title, before.title, "den Shot-Titel");
    assertUnchanged(after.order, before.order, "die Shot-Reihenfolge");
    const appended = after.requestRevisions.at(-1);
    if (
      !appended
      || appended.id !== mutation.requestRevisionId
      || appended.actorId !== mutation.actorId
      || appended.createdAt !== current.recordedAt
      || after.currentRequestRevisionId !== appended.id
      || after.approvedOutputId !== null
      || after.status !== (after.outputHistory.length > 0 ? "rendered" : "draft")
    ) {
      throw new ProjectConflictError("Request-Revision bindet nicht den neuen unveröffentlichten Stand.");
    }
    return;
  }
  assertUnchanged(after.requestRevisions, before.requestRevisions, "die Request-Historie");
  assertUnchanged(after.currentRequestRevisionId, before.currentRequestRevisionId, "die aktuelle Request-Revision");
  assertUnchanged(after.continuity, before.continuity, "die Continuity-Bindung");
  assertUnchanged(after.title, before.title, "den Shot-Titel");
  assertUnchanged(after.order, before.order, "die Shot-Reihenfolge");
  if (mutation.type === "shot-output-recorded") {
    if (after.outputHistory.length !== before.outputHistory.length + 1) {
      throw new ProjectConflictError("Output-Historie wurde nicht genau einmal angehängt.");
    }
    assertUnchanged(after.outputHistory.slice(0, -1), before.outputHistory, "bestehende Outputs");
    const appended = after.outputHistory.at(-1);
    if (
      !appended
      || appended.id !== mutation.outputId
      || appended.recordedAt !== current.recordedAt
      || after.approvedOutputId !== before.approvedOutputId
      || after.status !== (before.approvedOutputId ? "approved" : "rendered")
    ) {
      throw new ProjectConflictError("Output-Mutation bindet nicht den angehängten Export.");
    }
    return;
  }
  if (mutation.type === "shot-output-approved") {
    assertUnchanged(after.outputHistory, before.outputHistory, "die Ausgabehistorie");
    if (after.approvedOutputId !== mutation.outputId || after.status !== "approved") {
      throw new ProjectConflictError("Approval bindet nicht die freigegebene Ausgabe.");
    }
    return;
  }
  throw new ProjectConflictError("Unbekannte Projektmutation.");
}

export type ProjectStoreStorage = {
  root: string;
  recovery: {
    coordinator: DataRecoveryCoordinator;
    targetPrefix: string;
  };
};

export class ProjectStore {
  private readonly root: string;
  private readonly recovery: ProjectStoreStorage["recovery"] | null;

  constructor(storage: string | ProjectStoreStorage) {
    this.root = typeof storage === "string" ? storage : storage.root;
    this.recovery = typeof storage === "string" ? null : storage.recovery;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    assertRealDirectory(this.root, "Projekt-Root");
    if (this.recovery) {
      this.recovery.coordinator.recover();
      this.recovery.coordinator.verifyCommittedTargets();
    }
  }

  listAvailable(): { projects: ProjectRevisionEnvelope[]; warnings: string[] } {
    const projects: ProjectRevisionEnvelope[] = [];
    const warnings: string[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!PROJECT_ID_PATTERN.test(entry.name)) continue;
      try {
        if (!entry.isDirectory() || entry.isSymbolicLink()) {
          throw new ProjectConflictError(`Projektpfad ${entry.name} ist kein echtes Verzeichnis.`);
        }
        const current = this.get(entry.name);
        if (current) projects.push(current);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : `Projekt ${entry.name} ist nicht lesbar.`);
      }
    }
    projects.sort((left, right) => right.project.updatedAt.localeCompare(left.project.updatedAt));
    return { projects, warnings };
  }

  get(id: string): ProjectRevisionEnvelope | null {
    if (!PROJECT_ID_PATTERN.test(id)) return null;
    const directory = join(this.root, id);
    if (!existsSync(directory)) return null;
    return this.history(id).at(-1) ?? null;
  }

  preflightOutputCapture(
    id: string,
    expectedRevision: number,
    shotId: string,
    requestRevisionId: string,
  ): string {
    const current = this.get(id);
    if (!current) throw new ProjectConflictError("Projekt nicht gefunden.");
    if (current.revision !== expectedRevision) {
      throw new ProjectConflictError(
        `Stale Write: erwartet Revision ${expectedRevision}, aktuell ist ${current.revision}.`,
      );
    }
    assertActive(current.project);
    const shot = findShot(current.project, shotId);
    const revision = shot.requestRevisions.find(({ id: revisionId }) => revisionId === requestRevisionId);
    if (!revision) throw new ProjectConflictError("Output referenziert keine Request-Revision dieses Shots.");
    return revision.requestSha256;
  }

  bindingForRun(
    id: string,
    expectedRevision: number,
    shotId: string,
  ): { request: StudioProject["shots"][number]["requestRevisions"][number]["request"]; binding: ProjectRunBinding } {
    const current = this.get(id);
    if (!current) throw new ProjectConflictError("Projekt nicht gefunden.");
    if (current.revision !== expectedRevision) {
      throw new ProjectConflictError(
        `Stale Write: erwartet Revision ${expectedRevision}, aktuell ist ${current.revision}.`,
      );
    }
    assertActive(current.project);
    const shot = findShot(current.project, shotId);
    const revision = shot.requestRevisions.at(-1);
    if (!revision || revision.id !== shot.currentRequestRevisionId) {
      throw new ProjectConflictError("Aktuelle Shot-Request-Revision ist nicht hashkonsistent.");
    }
    return {
      request: structuredClone(revision.request),
      binding: projectRunBindingSchema.parse({
        schemaVersion: "ltx-studio-project-run.v1",
        projectId: current.projectId,
        projectRevision: current.revision,
        projectRevisionSha256: projectValueSha256(current),
        shotId: shot.id,
        requestRevisionId: revision.id,
        requestSha256: revision.requestSha256,
        continuity: shot.continuity,
      }),
    };
  }

  history(id: string): ProjectRevisionEnvelope[] {
    if (!PROJECT_ID_PATTERN.test(id)) throw new ProjectConflictError("Ungültige Projekt-ID.");
    const directory = join(this.root, id);
    if (!existsSync(directory)) throw new ProjectConflictError("Projekt nicht gefunden.");
    assertRealDirectory(directory, `Projekt ${id}`);
    const revisionFiles = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => REVISION_FILE_PATTERN.test(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    if (revisionFiles.length === 0) throw new ProjectConflictError(`Projekt ${id} hat keine Revisionen.`);
    const history: ProjectRevisionEnvelope[] = [];
    const persistedHistory: ProjectRevisionEnvelope[] = [];
    for (const [index, entry] of revisionFiles.entries()) {
      const match = REVISION_FILE_PATTERN.exec(entry.name);
      const expectedRevision = index + 1;
      if (!entry.isFile() || entry.isSymbolicLink() || Number(match?.[1]) !== expectedRevision) {
        throw new ProjectConflictError(`Projekt ${id} besitzt eine lückenhafte oder unsichere Revision.`);
      }
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size <= 0 || metadata.size > MAX_REVISION_BYTES) {
        throw new ProjectConflictError(`Projekt-Revision ${entry.name} ist keine zulässige reguläre Datei.`);
      }
      if ((metadata.mode & 0o077) !== 0) {
        throw new ProjectConflictError(`Projekt-Revision ${entry.name} ist nicht owner-only geschützt.`);
      }
      const payload = readFileSync(path, "utf8");
      let decoded: unknown;
      try {
        decoded = JSON.parse(payload);
      } catch {
        throw new ProjectConflictError(`Projekt-Revision ${entry.name} enthält kein gültiges JSON.`);
      }
      const readable = legacyReadableProjectEnvelope(decoded);
      const parsed = projectRevisionEnvelopeSchema.safeParse(readable);
      const canonical = canonicalDocument(decoded);
      if (!parsed.success || (payload !== canonical && payload !== `${canonical}\n`)) {
        throw new ProjectConflictError(`Projekt-Revision ${entry.name} ist nicht kanonisch oder schema-valid.`);
      }
      if (parsed.data.projectId !== id || parsed.data.revision !== expectedRevision) {
        throw new ProjectConflictError(`Projekt-Revision ${entry.name} ist an die falsche Identität gebunden.`);
      }
      // Digests and previous-revision hashes bind the exact historical bytes,
      // not the additive archival presentation marker.
      const persisted = decoded as ProjectRevisionEnvelope;
      assertRequestDigests(persisted.project);
      assertRevisionTransition(persistedHistory.at(-1) ?? null, persisted);
      persistedHistory.push(persisted);
      history.push(parsed.data);
    }
    return history;
  }

  create(input: ProjectCreateInput, recordedAt = new Date().toISOString()): ProjectRevisionEnvelope {
    const parsed = projectCreateInputSchema.parse(input);
    const id = randomUUID();
    const directory = join(this.root, id);
    mkdirSync(directory, { mode: 0o700 });
    const project = studioProjectSchema.parse({
      schemaVersion: "ltx-studio-project.v1",
      id,
      title: parsed.title,
      description: parsed.description,
      status: "active",
      createdAt: recordedAt,
      updatedAt: recordedAt,
      shots: [],
    });
    const envelope = projectRevisionEnvelopeSchema.parse({
      schemaVersion: "ltx-studio-project-revision.v1",
      projectId: id,
      revision: 1,
      previousRevisionSha256: null,
      recordedAt,
      mutation: { type: "project-created", actorId: parsed.actorId },
      project,
    });
    this.writeRevision(directory, envelope);
    return envelope;
  }

  addShot(id: string, input: ProjectShotCreateInput, recordedAt = new Date().toISOString()): ProjectRevisionEnvelope {
    const parsed = projectShotCreateInputSchema.parse(input);
    return this.mutate(id, parsed.expectedRevision, (current) => {
      const project = structuredClone(current.project);
      assertActive(project);
      if (parsed.continuity) {
        const predecessor = findShot(project, parsed.continuity.predecessorShotId);
        if (!predecessor.outputHistory.some(({ id: outputId }) => outputId === parsed.continuity?.referenceOutputId)) {
          throw new ProjectConflictError("Continuity-Ausgabe existiert nicht im Vorgänger-Shot.");
        }
      }
      const shotId = randomUUID();
      const requestRevisionId = randomUUID();
      project.shots.push({
        id: shotId,
        order: project.shots.length,
        title: parsed.title,
        status: "draft",
        continuity: parsed.continuity,
        requestRevisions: [{
          id: requestRevisionId,
          parentRevisionId: null,
          reason: "initial",
          sourceOutputId: null,
          request: parsed.request,
          requestSha256: projectValueSha256(parsed.request),
          createdAt: recordedAt,
          actorId: parsed.actorId,
        }],
        currentRequestRevisionId: requestRevisionId,
        outputHistory: [],
        approvedOutputId: null,
      });
      project.updatedAt = recordedAt;
      return {
        project,
        mutation: { type: "shot-added" as const, actorId: parsed.actorId, shotId },
      };
    }, recordedAt);
  }

  reviseShot(id: string, input: ProjectShotRevisionInput, recordedAt = new Date().toISOString()): ProjectRevisionEnvelope {
    const parsed = projectShotRevisionInputSchema.parse(input);
    return this.mutate(id, parsed.expectedRevision, (current) => {
      const project = structuredClone(current.project);
      assertActive(project);
      const shot = findShot(project, parsed.shotId);
      const sourceOutput = parsed.sourceOutputId
        ? project.shots.flatMap(({ outputHistory }) => outputHistory)
          .find(({ id: outputId }) => outputId === parsed.sourceOutputId)
        : null;
      if (parsed.reason === "retake") {
        if (!sourceOutput) {
          throw new ProjectConflictError("Retake-Quelle fehlt in der Projekt-Ausgabehistorie.");
        }
        if (
          parsed.request.mode !== "retake"
          || parsed.request.retake.videoName !== sourceOutput.outputName
          || basename(parsed.request.retake.videoPath) !== sourceOutput.outputName
        ) {
          throw new ProjectConflictError("Retake-Request bindet nicht die protokollierte Quellausgabe.");
        }
      } else if (parsed.request.mode === "retake") {
        throw new ProjectConflictError("Ein Retake-Request muss als Retake-Revision mit Quelle protokolliert werden.");
      }
      const requestRevisionId = randomUUID();
      shot.requestRevisions.push({
        id: requestRevisionId,
        parentRevisionId: shot.currentRequestRevisionId,
        reason: parsed.reason,
        sourceOutputId: parsed.sourceOutputId,
        request: parsed.request,
        requestSha256: projectValueSha256(parsed.request),
        createdAt: recordedAt,
        actorId: parsed.actorId,
      });
      shot.currentRequestRevisionId = requestRevisionId;
      shot.approvedOutputId = null;
      shot.status = shot.outputHistory.length > 0 ? "rendered" : "draft";
      project.updatedAt = recordedAt;
      return {
        project,
        mutation: {
          type: "shot-request-revised" as const,
          actorId: parsed.actorId,
          shotId: shot.id,
          requestRevisionId,
        },
      };
    }, recordedAt);
  }

  recordOutput(id: string, input: ProjectOutputRecordInput, recordedAt = new Date().toISOString()): ProjectRevisionEnvelope {
    const parsed = projectOutputRecordInputSchema.parse(input);
    return this.mutate(id, parsed.expectedRevision, (current) => {
      const project = structuredClone(current.project);
      assertActive(project);
      const shot = findShot(project, parsed.shotId);
      const projectRun = parsed.evidence.projectRun;
      const boundEnvelope = this.history(id)[projectRun.projectRevision - 1];
      const boundShot = boundEnvelope?.project.shots.find(({ id: shotId }) => shotId === projectRun.shotId);
      const boundRequest = boundShot?.requestRevisions.find(
        ({ id: revisionId }) => revisionId === projectRun.requestRevisionId,
      );
      if (
        projectRun.projectId !== id
        || projectRun.shotId !== shot.id
        || !boundEnvelope
        || projectValueSha256(boundEnvelope) !== projectRun.projectRevisionSha256
        || !boundShot
        || !boundRequest
        || boundRequest.requestSha256 !== projectRun.requestSha256
        || canonicalJson(boundShot.continuity) !== canonicalJson(projectRun.continuity)
      ) {
        throw new ProjectConflictError("Output bindet keinen verifizierbaren historischen Projekt-Run.");
      }
      const requestRevision = shot.requestRevisions.find(({ id }) => id === parsed.evidence.requestRevisionId);
      if (!requestRevision || requestRevision.requestSha256 !== parsed.evidence.requestSha256) {
        throw new ProjectConflictError("Output bindet keine exakte Request-Revision dieses Shots.");
      }
      if (parsed.evidence.recordedAt !== recordedAt) {
        throw new ProjectConflictError("Output- und Projekt-Revisionszeitpunkt müssen identisch sein.");
      }
      const outputs = project.shots.flatMap(({ outputHistory }) => outputHistory);
      if (
        outputs.some(({ id: outputId }) => outputId === parsed.evidence.id)
        || outputs.some(({ jobId }) => jobId === parsed.evidence.jobId)
      ) {
        throw new ProjectConflictError("Output- oder Job-ID wurde bereits im Projekt protokolliert.");
      }
      shot.outputHistory.push(parsed.evidence);
      shot.status = shot.approvedOutputId ? "approved" : "rendered";
      project.updatedAt = recordedAt;
      return {
        project,
        mutation: {
          type: "shot-output-recorded" as const,
          actorId: parsed.actorId,
          shotId: shot.id,
          outputId: parsed.evidence.id,
        },
      };
    }, recordedAt);
  }

  approveOutput(id: string, input: ProjectOutputApprovalInput, recordedAt = new Date().toISOString()): ProjectRevisionEnvelope {
    const parsed = projectOutputApprovalInputSchema.parse(input);
    return this.mutate(id, parsed.expectedRevision, (current) => {
      const project = structuredClone(current.project);
      assertActive(project);
      const shot = findShot(project, parsed.shotId);
      if (!shot.outputHistory.some(({ id: outputId }) => outputId === parsed.outputId)) {
        throw new ProjectConflictError("Freizugebende Ausgabe fehlt in der Shot-Historie.");
      }
      shot.approvedOutputId = parsed.outputId;
      shot.status = "approved";
      project.updatedAt = recordedAt;
      return {
        project,
        mutation: {
          type: "shot-output-approved" as const,
          actorId: parsed.actorId,
          shotId: shot.id,
          outputId: parsed.outputId,
        },
      };
    }, recordedAt);
  }

  archive(id: string, input: ProjectArchiveInput, recordedAt = new Date().toISOString()): ProjectRevisionEnvelope {
    const parsed = projectArchiveInputSchema.parse(input);
    return this.mutate(id, parsed.expectedRevision, (current) => {
      const project = structuredClone(current.project);
      assertActive(project);
      project.status = "archived";
      project.updatedAt = recordedAt;
      return {
        project,
        mutation: { type: "project-archived" as const, actorId: parsed.actorId },
      };
    }, recordedAt);
  }

  private mutate(
    id: string,
    expectedRevision: number,
    operation: (current: ProjectRevisionEnvelope) => {
      project: StudioProject;
      mutation: ProjectRevisionEnvelope["mutation"];
    },
    recordedAt: string,
  ): ProjectRevisionEnvelope {
    if (!PROJECT_ID_PATTERN.test(id)) throw new ProjectConflictError("Ungültige Projekt-ID.");
    const directory = join(this.root, id);
    return this.withLock(directory, () => {
      const current = this.get(id);
      if (!current) throw new ProjectConflictError("Projekt nicht gefunden.");
      if (current.revision !== expectedRevision) {
        throw new ProjectConflictError(
          `Stale Write: erwartet Revision ${expectedRevision}, aktuell ist ${current.revision}.`,
        );
      }
      const update = operation(current);
      const envelope = projectRevisionEnvelopeSchema.parse({
        schemaVersion: "ltx-studio-project-revision.v1",
        projectId: id,
        revision: current.revision + 1,
        previousRevisionSha256: projectValueSha256(current),
        recordedAt,
        mutation: update.mutation,
        project: studioProjectSchema.parse(update.project),
      });
      assertRequestDigests(envelope.project);
      assertRevisionTransition(current, envelope);
      this.writeRevision(directory, envelope);
      return envelope;
    });
  }

  private withLock<T>(directory: string, operation: () => T): T {
    assertRealDirectory(directory, "Projektverzeichnis");
    const lockPath = join(directory, ".write-lock");
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch {
      throw new ProjectConflictError("Projekt wird bereits geändert oder besitzt einen verwaisten Write-Lock.");
    }
    try {
      return operation();
    } finally {
      rmdirSync(lockPath);
    }
  }

  private writeRevision(directory: string, envelope: ProjectRevisionEnvelope): void {
    const parsed = projectRevisionEnvelopeSchema.parse(envelope);
    const target = join(directory, revisionFileName(parsed.revision));
    if (existsSync(target)) throw new ProjectConflictError("Projekt-Revision existiert bereits.");
    if (this.recovery) {
      this.recovery.coordinator.commitJson({
        targetKind: "project",
        targetRelativePath: [
          this.recovery.targetPrefix.replace(/\/$/, ""),
          parsed.projectId,
          revisionFileName(parsed.revision),
        ].filter(Boolean).join("/"),
        expectedAbsolutePath: target,
        value: parsed,
      });
      if ((statSync(target).mode & 0o077) !== 0) {
        throw new ProjectConflictError("Persistierte Projekt-Revision ist nicht owner-only geschützt.");
      }
      return;
    }
    const temporary = join(directory, `.${revisionFileName(parsed.revision)}.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, canonicalDocument(parsed), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      chmodSync(temporary, 0o600);
      renameSync(temporary, target);
      const directoryDescriptor = openSync(directory, "r");
      try {
        fsyncSync(directoryDescriptor);
      } finally {
        closeSync(directoryDescriptor);
      }
      if ((statSync(target).mode & 0o077) !== 0) {
        throw new ProjectConflictError("Persistierte Projekt-Revision ist nicht owner-only geschützt.");
      }
    } catch (error) {
      if (descriptor !== null) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
      throw error;
    }
  }
}
