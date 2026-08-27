import type { AdmissionPreflightReport } from "../shared/admissionPreflight.js";
import {
  publicAssetListResponseSchema,
  publicImageCropResponseSchema,
  publicLipDubReferenceResponseSchema,
  publicOutputFrameResponseSchema,
  publicStudioAssetSchema,
} from "../shared/assetPublic.js";
import {
  canonicalBlindEvaluationJson,
  createBlindEvaluationSubmissionPin,
  blindEvaluationInitialPinSchema,
  blindEvaluationPublicSchema,
  blindEvaluationPublicStateSha256,
  blindEvaluationSubmissionPinSchema,
  type BlindEvaluationInitialPin,
  type BlindEvaluationPublic,
  type BlindEvaluationSubmissionPin,
  type BlindEvaluationSubmissionInput,
} from "../shared/blindEvaluation.js";
import type { GenerationRequest } from "../shared/pipelines.js";
import { publicHealthSchema } from "../shared/healthPublic.js";
import { publicModelInventorySchema } from "../shared/modelPublic.js";
import type { QualityReviewInput } from "../shared/quality.js";
import type { DeletedStudioOutput } from "../shared/outputs.js";
import {
  t2aAudioPublicAnalysisRecordSchema,
  type T2aAudioPublicAnalysisRecord,
} from "../shared/t2aAudioPublic.js";
import type {
  PublicControlledExperiment,
  PublicOutputAnalysisRecord as OutputAnalysisRecord,
  PublicProjectRevisionEnvelope,
  PublicProjectRunSummary,
} from "../shared/outputPublic.js";
import type {
  ExperimentCreateInput,
} from "../shared/experiments.js";
import type {
  ProjectArchiveRequest,
  ProjectCreateRequest,
  ProjectOutputApprovalRequest,
  ProjectOutputCaptureRequest,
  ProjectRunRequest,
  ProjectShotCreateRequest,
  ProjectShotRevisionRequest,
} from "../shared/projects.js";
import type {
  LipDubReferenceDiagnostics,
  PlanSuggestion,
  PreparedImageCrop,
  PreparedLipDubReference,
  PlanExecutionDisposition,
} from "../shared/plan.js";
import {
  ApiError,
  type AssetKind,
  type Health,
  type ModelInventory,
  type ResourceEstimate,
  type StudioAsset,
  type StudioConfig,
  type StudioJob,
  type StudioOutput,
  type UploadedFile,
} from "./types.js";

async function decode<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { error?: string; issues?: { path: string; message: string }[] } & T;
  if (!response.ok) throw new ApiError(body.error ?? `HTTP ${response.status}`, body.issues ?? []);
  return body;
}

const BLIND_SUBMISSION_PIN_STORAGE_PREFIX = "ltx-studio.blind-submission-pin.v5.";
const BLIND_SUBMISSION_PIN_DATABASE = "ltx-studio-blind-submission-pin-v5";
const BLIND_SUBMISSION_PIN_STORE = "submission-pins";
let blindSubmissionPinDatabase: Promise<IDBDatabase> | null = null;

function blindSubmissionPinStorageKey(id: string): string {
  return `${BLIND_SUBMISSION_PIN_STORAGE_PREFIX}${id}`;
}

export function readBlindEvaluationSubmissionPin(id: string): BlindEvaluationSubmissionPin | null {
  try {
    const raw = window.localStorage.getItem(blindSubmissionPinStorageKey(id));
    if (!raw) return null;
    const parsed = blindEvaluationSubmissionPinSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.sessionId === id ? parsed.data : null;
  } catch {
    return null;
  }
}

function openBlindSubmissionPinDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) {
    return Promise.reject(new ApiError(
      "Die Abgabe bleibt gesperrt, weil dieser Browser keine dauerhafte IndexedDB-CAS-Primitive bereitstellt.",
    ));
  }
  blindSubmissionPinDatabase ??= new Promise<IDBDatabase>((resolvePromise, rejectPromise) => {
    const request = globalThis.indexedDB.open(BLIND_SUBMISSION_PIN_DATABASE, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(BLIND_SUBMISSION_PIN_STORE)) {
        database.createObjectStore(BLIND_SUBMISSION_PIN_STORE, { keyPath: "sessionId" });
      }
    };
    request.onerror = () => rejectPromise(new ApiError(
      `Der dauerhafte Browser-Submission-CAS ist nicht verfügbar: ${request.error?.message ?? "IndexedDB open failed"}`,
    ));
    request.onblocked = () => rejectPromise(new ApiError(
      "Der dauerhafte Browser-Submission-CAS ist durch eine inkompatible Datenbankversion blockiert.",
    ));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        blindSubmissionPinDatabase = null;
      };
      resolvePromise(database);
    };
  }).catch((error) => {
    blindSubmissionPinDatabase = null;
    throw error;
  });
  return blindSubmissionPinDatabase;
}

function localBlindSubmissionPin(id: string): {
  raw: string | null;
  parsed: BlindEvaluationSubmissionPin | null;
} {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(blindSubmissionPinStorageKey(id));
  } catch (error) {
    throw new ApiError(
      `Der dauerhafte Browser-Submission-Pin ist nicht lesbar: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw === null) return { raw, parsed: null };
  try {
    const parsed = blindEvaluationSubmissionPinSchema.safeParse(JSON.parse(raw));
    return { raw, parsed: parsed.success && parsed.data.sessionId === id ? parsed.data : null };
  } catch {
    return { raw, parsed: null };
  }
}

async function claimBlindSubmissionPin(
  proposed: BlindEvaluationSubmissionPin,
): Promise<BlindEvaluationSubmissionPin> {
  const database = await openBlindSubmissionPinDatabase();
  return new Promise<BlindEvaluationSubmissionPin>((resolvePromise, rejectPromise) => {
    const transaction = database.transaction(BLIND_SUBMISSION_PIN_STORE, "readwrite", {
      durability: "strict",
    });
    const store = transaction.objectStore(BLIND_SUBMISSION_PIN_STORE);
    let selected: BlindEvaluationSubmissionPin | null = null;
    let failure: Error | null = null;
    const fail = (error: Error) => {
      failure ??= error;
      try { transaction.abort(); } catch { /* An already terminal transaction rejects below. */ }
    };
    const persistLocalMirror = (pin: BlindEvaluationSubmissionPin): boolean => {
      try {
        window.localStorage.setItem(
          blindSubmissionPinStorageKey(proposed.sessionId),
          canonicalBlindEvaluationJson(pin),
        );
        const durable = readBlindEvaluationSubmissionPin(proposed.sessionId);
        if (!durable || canonicalBlindEvaluationJson(durable) !== canonicalBlindEvaluationJson(pin)) {
          throw new Error("Submission-Pin konnte nicht identisch zurückgelesen werden.");
        }
        return true;
      } catch (error) {
        fail(new ApiError(
          `Der dauerhafte Browser-Submission-Pin ist nicht gespeichert: ${error instanceof Error ? error.message : String(error)}`,
        ));
        return false;
      }
    };
    const read = store.get(proposed.sessionId);
    read.onerror = () => fail(new ApiError(
      `Der dauerhafte Browser-Submission-CAS ist nicht lesbar: ${read.error?.message ?? "IndexedDB get failed"}`,
    ));
    read.onsuccess = () => {
      const indexed = read.result === undefined
        ? null
        : blindEvaluationSubmissionPinSchema.safeParse(read.result);
      if (indexed !== null && (!indexed.success || indexed.data.sessionId !== proposed.sessionId)) {
        fail(new ApiError("Ein vorhandener IndexedDB-Submission-Pin ist beschädigt; die Abgabe bleibt fail-closed."));
        return;
      }
      let local: ReturnType<typeof localBlindSubmissionPin>;
      try {
        local = localBlindSubmissionPin(proposed.sessionId);
      } catch (error) {
        fail(error instanceof Error ? error : new ApiError(String(error)));
        return;
      }
      if (local.raw !== null && local.parsed === null) {
        fail(new ApiError("Ein vorhandener Browser-Submission-Pin ist beschädigt; die Abgabe bleibt fail-closed."));
        return;
      }
      const indexedPin = indexed?.success ? indexed.data : null;
      if (indexedPin && local.parsed
        && canonicalBlindEvaluationJson(indexedPin) !== canonicalBlindEvaluationJson(local.parsed)) {
        fail(new ApiError("IndexedDB und LocalStorage widersprechen sich beim dauerhaften Browser-Submission-Pin."));
        return;
      }
      const existing = indexedPin ?? local.parsed;
      if (existing) {
        const stableExisting = { ...existing, pinnedAt: proposed.pinnedAt };
        if (canonicalBlindEvaluationJson(stableExisting) !== canonicalBlindEvaluationJson(proposed)) {
          fail(new ApiError("Der dauerhafte Browser-Submission-Pin steht im Konflikt mit diesem Retry."));
          return;
        }
        selected = existing;
        if (!indexedPin) store.add(existing);
        persistLocalMirror(existing);
        return;
      }
      selected = proposed;
      store.add(proposed);
      persistLocalMirror(proposed);
    };
    transaction.onerror = () => {
      // onabort is the single terminal rejection path.
    };
    transaction.onabort = () => rejectPromise(failure ?? new ApiError(
      `Der dauerhafte Browser-Submission-CAS wurde abgebrochen: ${transaction.error?.message ?? "IndexedDB abort"}`,
    ));
    transaction.oncomplete = () => {
      if (!selected) {
        rejectPromise(new ApiError("Der dauerhafte Browser-Submission-CAS endete ohne eindeutigen Gewinner."));
        return;
      }
      resolvePromise(selected);
    };
  });
}

async function deleteBlindSubmissionPinFromDatabase(id: string): Promise<void> {
  try {
    const database = await openBlindSubmissionPinDatabase();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const transaction = database.transaction(BLIND_SUBMISSION_PIN_STORE, "readwrite", {
        durability: "strict",
      });
      transaction.objectStore(BLIND_SUBMISSION_PIN_STORE).delete(id);
      transaction.oncomplete = () => resolvePromise();
      transaction.onerror = () => rejectPromise(transaction.error);
      transaction.onabort = () => rejectPromise(transaction.error);
    });
  } catch {
    // A session ID is never reused. LocalStorage is still removed below, and
    // any retained IndexedDB pin can only keep that terminal ID fail-closed.
  }
}

export async function clearBlindEvaluationSubmissionPin(id: string): Promise<void> {
  try { window.localStorage.removeItem(blindSubmissionPinStorageKey(id)); } catch { /* fail closed on next reveal */ }
  await deleteBlindSubmissionPinFromDatabase(id);
}

async function persistBlindEvaluationSubmissionPin(
  input: BlindEvaluationSubmissionInput,
  initialPin: BlindEvaluationInitialPin,
  idempotencyKey: string,
): Promise<BlindEvaluationSubmissionPin> {
  const proposed = await createBlindEvaluationSubmissionPin(input, initialPin, idempotencyKey);
  const lockManager = globalThis.navigator?.locks;
  if (!lockManager) {
    throw new ApiError("Die Abgabe bleibt gesperrt, weil dieser Browser keine atomare Web-Lock-Primitive bereitstellt.");
  }
  return lockManager.request(`ltx-studio.blind-submission-pin.v5.${initialPin.id}`, {
    mode: "exclusive",
  }, async () => claimBlindSubmissionPin(proposed));
}

export async function getConfig(): Promise<StudioConfig> {
  return decode<StudioConfig>(await fetch("/api/config"));
}

export async function getHealth(): Promise<Health> {
  const response = await fetch("/api/health");
  const body = (await response.json()) as {
    error?: string;
    issues?: { path: string; message: string }[];
  };
  if (!response.ok && response.status !== 503) {
    throw new ApiError(body.error ?? `HTTP ${response.status}`, body.issues ?? []);
  }
  // A 503 carrying a schema-valid persistence HOLD is an observable health
  // state, not a transport failure. The GUI can therefore show restartRequired
  // instead of degrading the entire health panel to "offline".
  return publicHealthSchema.parse(body);
}

export async function getJobs(): Promise<StudioJob[]> {
  const body = await decode<{ jobs: StudioJob[] }>(await fetch("/api/jobs"));
  return body.jobs;
}

export async function getOutputs(): Promise<StudioOutput[]> {
  const body = await decode<{ outputs: StudioOutput[] }>(await fetch("/api/outputs"));
  return body.outputs;
}

export async function deleteOutput(outputName: string): Promise<DeletedStudioOutput> {
  const body = await decode<{ deleted: DeletedStudioOutput }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}`, { method: "DELETE" }),
  );
  return body.deleted;
}

export async function getExperiments(): Promise<{
  experiments: PublicControlledExperiment[];
  warnings: string[];
}> {
  return decode<{ experiments: PublicControlledExperiment[]; warnings: string[] }>(
    await fetch("/api/experiments"),
  );
}

export async function getProjects(): Promise<{
  projects: PublicProjectRevisionEnvelope[];
  warnings: string[];
}> {
  return decode<{ projects: PublicProjectRevisionEnvelope[]; warnings: string[] }>(
    await fetch("/api/projects"),
  );
}

export async function getProjectHistory(id: string): Promise<PublicProjectRevisionEnvelope[]> {
  const body = await decode<{ revisions: PublicProjectRevisionEnvelope[] }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/history`),
  );
  return body.revisions;
}

export async function createProject(input: ProjectCreateRequest): Promise<PublicProjectRevisionEnvelope> {
  const body = await decode<{ project: PublicProjectRevisionEnvelope }>(
    await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function addProjectShot(
  id: string,
  input: ProjectShotCreateRequest,
): Promise<PublicProjectRevisionEnvelope> {
  const body = await decode<{ project: PublicProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function reviseProjectShot(
  id: string,
  shotId: string,
  input: ProjectShotRevisionRequest,
): Promise<PublicProjectRevisionEnvelope> {
  const body = await decode<{ project: PublicProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/revisions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function captureProjectShotOutput(
  id: string,
  shotId: string,
  input: ProjectOutputCaptureRequest,
): Promise<PublicProjectRevisionEnvelope> {
  const body = await decode<{ project: PublicProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/outputs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function launchProjectShot(
  id: string,
  shotId: string,
  input: ProjectRunRequest,
): Promise<{ project: PublicProjectRunSummary; job: StudioJob }> {
  return decode<{ project: PublicProjectRunSummary; job: StudioJob }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function approveProjectShotOutput(
  id: string,
  shotId: string,
  input: ProjectOutputApprovalRequest,
): Promise<PublicProjectRevisionEnvelope> {
  const body = await decode<{ project: PublicProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/shots/${encodeURIComponent(shotId)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function archiveProject(
  id: string,
  input: ProjectArchiveRequest,
): Promise<PublicProjectRevisionEnvelope> {
  const body = await decode<{ project: PublicProjectRevisionEnvelope }>(
    await fetch(`/api/projects/${encodeURIComponent(id)}/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.project;
}

export async function createExperiment(input: ExperimentCreateInput): Promise<PublicControlledExperiment> {
  const body = await decode<{ experiment: PublicControlledExperiment }>(
    await fetch("/api/experiments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.experiment;
}

export async function freezeExperiment(id: string): Promise<PublicControlledExperiment> {
  const body = await decode<{ experiment: PublicControlledExperiment }>(
    await fetch(`/api/experiments/${id}/freeze`, { method: "POST" }),
  );
  return body.experiment;
}

export async function supersedeExperiment(
  id: string,
  reason: string,
  replacementExperimentId: string | null = null,
): Promise<PublicControlledExperiment> {
  const body = await decode<{ experiment: PublicControlledExperiment }>(
    await fetch(`/api/experiments/${id}/supersede`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason, replacementExperimentId }),
    }),
  );
  return body.experiment;
}

export async function launchExperimentArm(
  id: string,
  arm: "baseline" | "candidate",
): Promise<{ experiment: PublicControlledExperiment; job: StudioJob }> {
  return decode<{ experiment: PublicControlledExperiment; job: StudioJob }>(
    await fetch(`/api/experiments/${id}/runs/${arm}`, { method: "POST" }),
  );
}

export async function preflightExperimentArm(
  id: string,
  arm: "baseline" | "candidate",
): Promise<AdmissionPreflightReport> {
  return decode<AdmissionPreflightReport>(
    await fetch(`/api/experiments/${encodeURIComponent(id)}/runs/${arm}/preflight`, { method: "POST" }),
  );
}

const BLIND_CREATION_STORAGE_KEY = "ltx-studio-blind-creation.v5";
let volatileBlindCreation: {
  experimentId: string;
  creationRequestId: string;
  reservationId?: string;
  creationToken?: string;
} | null = null;

function randomBlindRequestId(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function readPendingBlindCreation(): typeof volatileBlindCreation {
  try {
    const raw = globalThis.sessionStorage?.getItem(BLIND_CREATION_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as typeof volatileBlindCreation;
      if (parsed && /^[0-9a-f-]{36}$/i.test(parsed.experimentId)
        && /^[0-9a-f]{64}$/.test(parsed.creationRequestId)
        && (parsed.reservationId === undefined || /^[0-9a-f-]{36}$/i.test(parsed.reservationId))
        && (parsed.creationToken === undefined || /^[0-9a-f]{64}$/.test(parsed.creationToken))) {
        return parsed;
      }
    }
  } catch {
    // The in-memory request id still makes retries in this page idempotent.
  }
  return volatileBlindCreation;
}

function writePendingBlindCreation(value: NonNullable<typeof volatileBlindCreation>): void {
  volatileBlindCreation = value;
  try { globalThis.sessionStorage?.setItem(BLIND_CREATION_STORAGE_KEY, JSON.stringify(value)); } catch { /* fail in memory */ }
}

export function finishBlindEvaluationCreation(reservationId: string): void {
  const pending = readPendingBlindCreation();
  if (pending?.reservationId !== reservationId) return;
  volatileBlindCreation = null;
  try { globalThis.sessionStorage?.removeItem(BLIND_CREATION_STORAGE_KEY); } catch { /* already terminal */ }
}

export function newBlindEvaluationIdempotencyKey(): string {
  return randomBlindRequestId();
}

export async function createBlindEvaluation(experimentId: string): Promise<BlindEvaluationPublic> {
  const existing = readPendingBlindCreation();
  const pending = existing?.experimentId === experimentId
    ? existing
    : { experimentId, creationRequestId: randomBlindRequestId() };
  writePendingBlindCreation(pending);
  const body = await decode<{ evaluation: BlindEvaluationPublic; creationToken: string | null }>(
    await fetch("/api/blind-evaluations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experimentId, creationRequestId: pending.creationRequestId }),
    }),
  );
  const evaluation = blindEvaluationPublicSchema.parse(body.evaluation);
  const creationToken = body.creationToken ?? pending.creationToken;
  if (!creationToken || !/^[0-9a-f]{64}$/.test(creationToken)) {
    throw new ApiError("Die private v5-Creation-Autorität ist für diese Reservation nicht verfügbar.");
  }
  writePendingBlindCreation({ ...pending, reservationId: evaluation.id, creationToken });
  return evaluation;
}

export async function getBlindEvaluation(id: string): Promise<BlindEvaluationPublic> {
  const body = await decode<{ evaluation: BlindEvaluationPublic }>(
    await fetch(`/api/blind-evaluations/${encodeURIComponent(id)}`),
  );
  return blindEvaluationPublicSchema.parse(body.evaluation);
}

export async function claimBlindEvaluation(id: string): Promise<BlindEvaluationPublic> {
  const pending = readPendingBlindCreation();
  if (pending?.reservationId !== id || !pending.creationToken) {
    throw new ApiError("Die private v5-Creation-Autorität fehlt in dieser Initiator-Session.");
  }
  const body = await decode<{ evaluation: BlindEvaluationPublic }>(
    await fetch(`/api/blind-evaluations/${encodeURIComponent(id)}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ creationToken: pending.creationToken }),
    }),
  );
  const evaluation = blindEvaluationPublicSchema.parse(body.evaluation);
  if (evaluation.status !== "creating") finishBlindEvaluationCreation(id);
  return evaluation;
}

export async function blindEvaluationNavigation(
  evaluation: BlindEvaluationPublic,
): Promise<{ pin: BlindEvaluationInitialPin | null; href: string }> {
  if (evaluation.status === "creating") {
    const fragment = new URLSearchParams({ id: evaluation.id, creating: "v5" });
    return {
      pin: null,
      href: `/blind-evaluation/${encodeURIComponent(evaluation.id)}#${fragment.toString()}`,
    };
  }
  // A durable active record is authoritative even when the claim response was
  // lost. Do not retain the one-shot creation capability after recovery.
  finishBlindEvaluationCreation(evaluation.id);
  const pin = blindEvaluationInitialPinSchema.parse({
    schemaVersion: "ltx-studio-blind-evaluation-initial-pin.v5",
    id: evaluation.id,
    commitment: evaluation.commitment,
    publicStateSha256: await blindEvaluationPublicStateSha256(evaluation),
  });
  const fragment = new URLSearchParams({
    id: pin.id,
    commitment: pin.commitment,
    publicStateSha256: pin.publicStateSha256,
  });
  return {
    pin,
    href: `/blind-evaluation/${encodeURIComponent(pin.id)}#${fragment.toString()}`,
  };
}

export async function submitBlindEvaluation(
  id: string,
  input: BlindEvaluationSubmissionInput,
  initialPin: BlindEvaluationInitialPin,
  idempotencyKey: string,
): Promise<{ evaluation: BlindEvaluationPublic; submissionPin: BlindEvaluationSubmissionPin }> {
  const submissionPin = await persistBlindEvaluationSubmissionPin(input, initialPin, idempotencyKey);
  const encodedSubmissionPin = btoa(canonicalBlindEvaluationJson(submissionPin))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  const body = await decode<{ evaluation: BlindEvaluationPublic }>(
    await fetch(`/api/blind-evaluations/${encodeURIComponent(id)}/submission`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${initialPin.publicStateSha256}"`,
        "X-Blind-Evaluation-Id": initialPin.id,
        "X-Blind-Evaluation-Commitment": initialPin.commitment,
        "X-Blind-Submission-Pin": encodedSubmissionPin,
        "Idempotency-Key": submissionPin.idempotencyKey,
      },
      body: JSON.stringify(input),
    }),
  );
  return { evaluation: blindEvaluationPublicSchema.parse(body.evaluation), submissionPin };
}

export async function releaseBlindEvaluationScope(id: string): Promise<void> {
  const response = await fetch(`/api/blind-evaluations/${encodeURIComponent(id)}/scope/release`, {
    method: "POST",
  });
  if (!response.ok) await decode<never>(response);
  finishBlindEvaluationCreation(id);
  await clearBlindEvaluationSubmissionPin(id);
}

export async function abortBlindEvaluation(id: string): Promise<void> {
  const response = await fetch(`/api/blind-evaluations/${encodeURIComponent(id)}/abort`, {
    method: "POST",
  });
  if (!response.ok) await decode<never>(response);
  finishBlindEvaluationCreation(id);
  await clearBlindEvaluationSubmissionPin(id);
}

export async function getBlindEvaluatorScope(): Promise<{
  locked: boolean;
  evaluation: BlindEvaluationPublic | null;
}> {
  const response = await fetch("/api/blind-evaluator-scope", { cache: "no-store" });
  const body = await decode<{ locked: boolean; evaluation: unknown }>(response);
  return {
    locked: body.locked === true,
    evaluation: body.evaluation === null ? null : blindEvaluationPublicSchema.parse(body.evaluation),
  };
}

export async function getModels(refresh = false): Promise<ModelInventory> {
  return publicModelInventorySchema.parse(
    await decode<unknown>(await fetch(`/api/models${refresh ? "?refresh=1" : ""}`)),
  );
}

export async function getEstimate(request: GenerationRequest): Promise<ResourceEstimate> {
  return decode<ResourceEstimate>(
    await fetch("/api/estimates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}

export async function preflightAdmission(request: GenerationRequest): Promise<AdmissionPreflightReport> {
  return decode<AdmissionPreflightReport>(
    await fetch("/api/admission/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}

export async function createJob(request: GenerationRequest): Promise<StudioJob> {
  const body = await decode<{ job: StudioJob }>(
    await fetch("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
  return body.job;
}

export async function planJob(
  request: GenerationRequest,
): Promise<{
  command: string;
  outputPath: string;
  pathErrors: string[];
  pathWarnings: string[];
  suggestions?: PlanSuggestion[];
  execution: PlanExecutionDisposition;
}> {
  return decode(
    await fetch("/api/jobs/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    }),
  );
}

export async function cancelJob(id: string): Promise<StudioJob> {
  const body = await decode<{ job: StudioJob }>(await fetch(`/api/jobs/${id}/cancel`, { method: "POST" }));
  return body.job;
}

export async function deleteJob(id: string): Promise<StudioJob> {
  const body = await decode<{ deleted: StudioJob }>(
    await fetch(`/api/jobs/${id}`, { method: "DELETE" }),
  );
  return body.deleted;
}

export async function rerunJob(id: string, mode: "exact" | "random-seed"): Promise<StudioJob> {
  const body = await decode<{ job: StudioJob }>(
    await fetch(`/api/jobs/${id}/rerun`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  );
  return body.job;
}

export async function setJobFavorite(id: string, favorite: boolean): Promise<StudioJob> {
  const body = await decode<{ job: StudioJob }>(
    await fetch(`/api/jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorite }),
    }),
  );
  return body.job;
}

export async function setOutputQualityReview(outputName: string, input: QualityReviewInput): Promise<StudioOutput> {
  const body = await decode<{ output: StudioOutput }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}/quality-review`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
  return body.output;
}

export async function startOutputAnalysis(outputName: string, force = false): Promise<OutputAnalysisRecord> {
  const body = await decode<{ analysis: OutputAnalysisRecord }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}/analysis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    }),
  );
  return body.analysis;
}

export async function cancelOutputAnalysis(outputName: string, analysisId: string): Promise<OutputAnalysisRecord> {
  const body = await decode<{ analysis: OutputAnalysisRecord }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}/analysis/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId }),
    }),
  );
  return body.analysis;
}

export async function startT2aAudioAnalysis(
  outputName: string,
  force = false,
): Promise<T2aAudioPublicAnalysisRecord> {
  const body = await decode<{ analysis: T2aAudioPublicAnalysisRecord }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}/analysis`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force }),
    }),
  );
  return t2aAudioPublicAnalysisRecordSchema.parse(body.analysis);
}

export async function cancelT2aAudioAnalysis(
  outputName: string,
  analysisId: string,
): Promise<T2aAudioPublicAnalysisRecord> {
  const body = await decode<{ analysis: T2aAudioPublicAnalysisRecord }>(
    await fetch(`/api/outputs/${encodeURIComponent(outputName)}/analysis/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysisId }),
    }),
  );
  return t2aAudioPublicAnalysisRecordSchema.parse(body.analysis);
}

export async function uploadFile(kind: UploadedFile["kind"], file: File): Promise<UploadedFile> {
  const data = new FormData();
  data.append("file", file);
  return publicStudioAssetSchema.parse(
    await decode<unknown>(await fetch(`/api/uploads/${kind}`, { method: "POST", body: data })),
  );
}

export async function getAssets(kind?: AssetKind): Promise<StudioAsset[]> {
  const body = publicAssetListResponseSchema.parse(
    await decode<unknown>(
      await fetch(`/api/assets${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`),
    ),
  );
  return body.assets;
}

export async function takeOutputFrame(output: string, atSeconds: number): Promise<StudioAsset> {
  const body = publicOutputFrameResponseSchema.parse(
    await decode<unknown>(
      await fetch("/api/images/from-output", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output, atSeconds }),
      }),
    ),
  );
  return body.asset;
}

export type RecommendedOutputFrame = {
  asset: StudioAsset;
  recommendation: {
    atSeconds: number;
    score: number;
    sampledFrames: number;
    eligibleFrames: number;
    metrics: {
      faceSharpness: number;
      faceAreaRatio: number;
      faceConfidence: number;
      stability: number;
      exposure: number;
      frontalness: number;
      prominentFaceCount: number;
    };
  };
};

export async function takeRecommendedOutputFrame(output: string): Promise<RecommendedOutputFrame> {
  const body = publicOutputFrameResponseSchema.parse(
    await decode<unknown>(
      await fetch("/api/images/from-output", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ output, strategy: "best-face" }),
      }),
    ),
  );
  if (body.recommendation === null) {
    throw new ApiError("Die automatische Frame-Auswahl lieferte keine öffentliche Empfehlung.");
  }
  return { asset: body.asset, recommendation: body.recommendation };
}

export async function prepareImageCrop(input: {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  outputWidth: number;
  outputHeight: number;
}): Promise<PreparedImageCrop> {
  return publicImageCropResponseSchema.parse(
    await decode<unknown>(
      await fetch("/api/images/crop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    ),
  );
}

export async function inspectLipDubReference(input: {
  path: string;
  width: number;
  height: number;
  dialogue: string;
  prompt: string;
  pipelineProfile: GenerationRequest["lipDub"]["pipelineProfile"];
}): Promise<LipDubReferenceDiagnostics> {
  return decode<LipDubReferenceDiagnostics>(
    await fetch("/api/lipdub/reference/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export async function prepareLipDubReference(
  request: GenerationRequest,
  trim?: { startSeconds: number; durationSeconds: number },
): Promise<PreparedLipDubReference> {
  return publicLipDubReferenceResponseSchema.parse(
    await decode<unknown>(
      await fetch("/api/lipdub/reference/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...request, trim }),
      }),
    ),
  );
}
