import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z, ZodError } from "zod";

import { assetKinds, type AssetKind } from "../shared/assets.js";
import {
  BLIND_EVALUATOR_SCOPE_COOKIE,
  blindEvaluationChannelSchema,
  blindEvaluationClaimInputSchema,
  blindEvaluationCreateInputSchema,
  blindEvaluationInitialPinSchema,
  blindEvaluationSubmissionPinSchema,
  blindEvaluationSubmissionInputSchema,
} from "../shared/blindEvaluation.js";
import { generationRequestSchema, outputNameSchema, PIPELINES } from "../shared/pipelines.js";
import { qualificationHoldForRequest } from "../shared/qualificationHold.js";
import {
  experimentCreateInputSchema,
  experimentRequiresFreshBaseline,
  type ControlledExperiment,
} from "../shared/experiments.js";
import {
  projectArchiveRequestSchema,
  projectCreateRequestSchema,
  projectOutputApprovalRequestSchema,
  projectOutputCaptureRequestSchema,
  projectRunRequestSchema,
  projectShotCreateRequestSchema,
  projectShotRevisionRequestSchema,
} from "../shared/projects.js";
import { qualityReviewInputSchema } from "../shared/quality.js";
import type { ProvenanceFileEvidence } from "../shared/provenance.js";
import {
  recommendedModelAssets,
  requiredOfficialSpeechAssetIds,
  withOfficialSpeechModelPaths,
} from "../shared/models.js";
import {
  admissionClientAvailable,
  admissionPreflight,
  listQueueJobs,
} from "./admission.js";
import { AssetStore } from "./assets.js";
import { evaluateBlindV5ApiGate } from "./blindApiGate.js";
import {
  BlindEvaluationConflictError,
  BlindEvaluationStore,
} from "./blindEvaluationStore.js";
import { sendVerifiedBlindEvaluationMedia } from "./blindMediaResponse.js";
import { buildCommand, suggestRequestPlan, validateRequestPlan, warnRequestPlan } from "./command.js";
import {
  appRoot,
  admissionRequired,
  analysisPythonExecutable,
  analysisRuntimeAvailable,
  analysisTempRoot,
  blindEvaluationRoot,
  dataRoot,
  devUiPort,
  ensureRuntimeDirectories,
  experimentRoot,
  minAvailableGiB,
  minResidualMemoryGiB,
  minSwapFreeGiB,
  outputRoot,
  projectActorId,
  projectRoot,
  pythonRuntimeAvailable,
  rendererPythonExecutable,
  sealedRelease,
  serverHost,
  serverPort,
  t2aDevelopmentMeasurementEnabled,
  uploadRoot,
} from "./config.js";
import { acquireDataRootWriterLock } from "./dataRootWriterLock.js";
import {
  isActiveJobStatus,
  JobConflictError,
  JobManager,
  JobPersistenceHoldError,
  type StudioJob,
} from "./jobs.js";
import {
  NativeRuntimeSourceGateError,
  verifyNativeRuntimeSource,
} from "./nativeRuntimeSourceGate.js";
import { toPublicStudioJob, toPublicStudioJobs } from "./publicJob.js";
import {
  publicAssetListResponse,
  publicImageCropResponse,
  publicLipDubReferenceResponse,
  publicOutputFrameResponse,
  publicSequenceResponse,
  toPublicStudioAsset,
} from "./publicAssets.js";
import {
  resolveT2aAudioEvaluatorCapability,
  T2aAudioEvaluatorUnavailableError,
  toPublicJobPersistenceHoldError,
  toPublicHealth,
} from "./publicHealth.js";
import { toPublicModelInventory } from "./publicModels.js";
import {
  publicOutputAnalysisResponse,
  publicProjectHistoryResponse,
  publicProjectListResponse,
  publicProjectResponse,
  publicStudioOutputResponse,
  publicStudioOutputsResponse,
  toPublicControlledExperiment,
  toPublicControlledExperiments,
  toPublicProjectRunSummary,
} from "./publicOutput.js";
import { inspectLipDubReference } from "./lipdubDiagnostics.js";
import { ImageCropPreparationError, prepareImageCrop } from "./imageCrop.js";
import { LipDubReferencePreparationError, prepareLipDubReference } from "./lipdubPrep.js";
import { createLocalStudioHostGate } from "./localStudioHostGate.js";
import { assembleSequence, SequenceAssembleError } from "./sequenceAssemble.js";
import { extractOutputFrame, OutputFrameError } from "./outputFrame.js";
import {
  recommendSceneReferenceFrame,
  SCENE_REFERENCE_YUNET_SHA256,
  SceneReferenceFrameError,
} from "./sceneReferenceFrame.js";
import { estimateRequest } from "./estimates.js";
import {
  ExperimentConflictError,
  ExperimentStore,
  outputVerifiesExperimentArmRun,
  outputVerifiesExperimentBaseline,
  requestSettingsSha256,
} from "./experimentStore.js";
import {
  inspectRetryableExperimentArm,
  type ExperimentArmRetryReadDeps,
} from "./experimentRetry.js";
import {
  experimentAdmissionPreflight,
  isProgramAudioOnlyCandidate,
  isRawMuxPairCandidate,
  unverifiableExperimentAdmissionPreflight,
} from "./experimentAdmissionPreflight.js";
import { getModelInventory } from "./models.js";
import { readOrchestratorStatus } from "./orchestrator.js";
import {
  OutputDeleteError,
  OutputLibrary,
  OutputQualityError,
} from "./outputs.js";
import type { OutputPublicationAuthority } from "./outputPublication.js";
import {
  cleanupAnalysisTempRoot,
  OutputAnalysisManager,
  recoverPhonemeVisemeSandboxState,
} from "./outputAnalysis.js";
import { resolveIdentityEvidenceReferences, verifyIdentityEvidence } from "./inputEvidence.js";
import {
  captureProvenanceFile,
  captureRunEnvironmentEvidence,
  runProvenanceEnvironmentMatches,
  runProvenanceFingerprintMatches,
  verifyProvenanceFileEvidence,
} from "./runProvenance.js";
import { lipForcingImageIdentity } from "./dockerImageIdentity.js";
import { readResourceSnapshot } from "./system.js";
import { matchesUploadSignature } from "./uploads.js";
import { PhonemeVisemeEvaluatorStateProvider } from "./evaluatorStateProvider.js";
import { reconcileCompletedAnalysisTransitions } from "./autoAnalysis.js";
import { releaseIdentity } from "./releaseIdentity.js";
import { ProjectConflictError, ProjectStore } from "./projectStore.js";
import {
  assertProjectOutputReferenceMutationAllowed as enforceProjectOutputReferenceMutationPolicy,
  assertProjectRunSourcesMutationAllowed as enforceProjectRunSourcesMutationPolicy,
} from "./legacyMutationPolicy.js";
import {
  removeT2aAudioAnalysis,
  t2aAudioAnalysisPath,
  T2aAudioAnalysisManager,
} from "./t2aAudioAnalysis.js";
import {
  assertMatchingT2aAudioEvaluatorBindings,
  preflightT2aAudioEvaluatorSandbox,
  resolveT2aAudioEvaluatorBinding,
  type T2aAudioEvaluatorBinding,
} from "./t2aAudioEvaluator.js";
import {
  collectPublicT2aAudioAnalyses,
  publicT2aAudioAnalysisResponse,
} from "./publicT2aAudio.js";
import { deleteOutputWithT2aAudioCleanup } from "./t2aOutputDelete.js";
import {
  bindHeldFileResponseRelease,
  delegateCommittedResponseError,
  finishHeldFileResponse,
  sendOutputSnapshotUnavailableResponse,
} from "./expressResponseSafety.js";
import { reconcileExperimentsBeforeServerStart } from "./startupExperimentReconciliation.js";

ensureRuntimeDirectories();
const dataRootWriterLock = acquireDataRootWriterLock(dataRoot);
cleanupAnalysisTempRoot(analysisTempRoot);
try {
  await recoverPhonemeVisemeSandboxState(analysisTempRoot);
} catch (error) {
  console.error(
    "Phonem-/Visem-Sandbox-Recovery blieb fail-closed:",
    error instanceof Error ? error.message : String(error),
  );
}
const app = express();
const assets = new AssetStore();
const jobs = new JobManager(undefined, true, assets);
const observedJobStatuses = new Map(jobs.list().map((job) => [job.id, job.status]));
const outputs = new OutputLibrary(outputRoot);
outputs.wireJobSource(() => jobs.outputAuthorityList());
outputs.wireAuthorityRevoker((outputName, expectedJobId) => {
  jobs.revokeOutputAuthority(outputName, expectedJobId);
});
jobs.wireReusableBaseSource(outputs);
const experiments = new ExperimentStore(experimentRoot);

async function assertPositivePromptEnvironmentMatchesBaseline(
  experiment: ControlledExperiment,
  arm: "baseline" | "candidate",
  selectedRequest: z.infer<typeof generationRequestSchema>,
  plan: ReturnType<typeof buildCommand>,
): Promise<void> {
  if (arm !== "candidate" || experiment.candidate.variable !== "positive-prompt") return;
  const baselineJobId = experiment.arms[0].jobId;
  const baseline = baselineJobId ? jobs.get(baselineJobId) : undefined;
  if (baseline?.status !== "completed" || !baseline.runProvenance?.verifiedAt) {
    throw new ExperimentConflictError(
      "Der Prompt-Kandidat benötigt den frisch abgeschlossenen Baseline-Arm mit verifizierter Laufprovenienz.",
    );
  }
  const baselineOutput = outputs.list(jobs.outputAuthorityList())
    .find((output) => outputVerifiesExperimentBaseline(output, experiment));
  if (!baselineOutput) {
    throw new ExperimentConflictError(
      "Der Prompt-Kandidat benötigt die unveränderte, verifizierte Videoausgabe seines frischen Baseline-Arms.",
    );
  }
  const current = await captureRunEnvironmentEvidence(selectedRequest, plan);
  if (!runProvenanceEnvironmentMatches(baseline.runProvenance, current)) {
    throw new ExperimentConflictError(
      "Der Prompt-Kandidat wird vor dem Start abgewiesen: Ausführungsinputs, Code oder Runtime stimmen nicht "
      + "exakt mit dem frischen Baseline-Arm überein.",
    );
  }
}

const blindEvaluations = new BlindEvaluationStore(blindEvaluationRoot, outputRoot);
let blindEvaluatorServerLock = blindEvaluations.hasActiveSession();
const studioEventStreams = new Set<Response>();

function closeStudioEventStreams(): void {
  for (const stream of studioEventStreams) {
    try {
      stream.write("event: blind-scope-lock\ndata: {}\n\n");
      stream.end();
    } catch {
      // A concurrently closed stream is already detached by its close handler.
    }
  }
  studioEventStreams.clear();
}
const projects = new ProjectStore(projectRoot);
const phonemeVisemeEvaluatorStates = new PhonemeVisemeEvaluatorStateProvider();
const experimentStartupFailure = reconcileExperimentsBeforeServerStart(jobs, experiments);
if (experimentStartupFailure) await experimentStartupFailure;
const analyses = new OutputAnalysisManager(outputs, () => jobs.outputAuthorityList(), outputRoot, {
  identityReferenceResolver: (evidence) => resolveIdentityEvidenceReferences(evidence, assets),
  identityEvidenceVerifier: async (evidence) => (await verifyIdentityEvidence(evidence, assets)).error,
  phonemeVisemeEvaluatorStateResolver: () => phonemeVisemeEvaluatorStates.get(),
});
const analysisRuntimeReady = analysisRuntimeAvailable(
  analysisPythonExecutable,
  { isolated: sealedRelease },
);
const t2aSandboxPreflightRequired = analysisRuntimeReady && (
  t2aDevelopmentMeasurementEnabled
  || (
    releaseIdentity.sealed
    && releaseIdentity.verified
    && releaseIdentity.runtimeTrust?.authorityIsolation.status === "attested"
  )
);
let t2aSandboxPreflightReady = false;
let t2aSandboxPreflightBinding: T2aAudioEvaluatorBinding | undefined;
if (t2aSandboxPreflightRequired) {
  const correlationId = randomUUID();
  try {
    const preflightBinding = await preflightT2aAudioEvaluatorSandbox();
    const liveBinding = resolveT2aAudioEvaluatorBinding();
    assertMatchingT2aAudioEvaluatorBindings(preflightBinding, liveBinding);
    t2aSandboxPreflightBinding = preflightBinding;
    t2aSandboxPreflightReady = true;
  } catch (error) {
    console.error("T2A-Audio-QA-Sandbox-Preflight blieb fail-closed.", {
      correlationId,
      cause: error instanceof Error ? error.stack ?? error.message : String(error),
    });
  }
}
const t2aAudioEvaluatorCapability = resolveT2aAudioEvaluatorCapability({
  sealed: releaseIdentity.sealed,
  verified: releaseIdentity.verified,
  authorityIsolation: releaseIdentity.runtimeTrust?.authorityIsolation ?? null,
  analysisRuntimeAvailable: analysisRuntimeReady && t2aSandboxPreflightReady,
  developmentMeasurementEnabled: t2aDevelopmentMeasurementEnabled,
});
const t2aAudioAnalyses = new T2aAudioAnalysisManager(
  () => jobs.outputAuthorityList(),
  outputRoot,
  { expectedEvaluatorBinding: t2aSandboxPreflightBinding },
);
await t2aAudioAnalyses.initialize();

function startT2aAudioAnalysis(outputName: string, force = false) {
  const correlationId = randomUUID();
  if (!t2aAudioEvaluatorCapability.measurementReady) {
    console.error("T2A-Audio-QA-Start wurde durch die Capability blockiert.", {
      correlationId,
      outputName,
      blockerCode: t2aAudioEvaluatorCapability.blockerCode,
    });
    throw T2aAudioEvaluatorUnavailableError.fromCapability(
      t2aAudioEvaluatorCapability,
      correlationId,
    );
  }
  try {
    return t2aAudioAnalyses.start(outputName, force);
  } catch (error) {
    if (error instanceof OutputQualityError) throw error;
    console.error("T2A-Audio-QA-Start ist intern fehlgeschlagen.", {
      correlationId,
      outputName,
      cause: error instanceof Error ? error.stack ?? error.message : String(error),
    });
    throw T2aAudioEvaluatorUnavailableError.startFailed(correlationId);
  }
}

const processAutomaticAnalyses = (value: StudioJob[]) => {
  try {
    outputs.recordCompleted(jobs.outputAuthorityList());
  } catch (error) {
    // Persistence HOLD is a deliberate read-only startup mode surfaced by
    // /api/health and the inline banner. It must not crash the process before
    // an operator can see the reason and restart after repair.
    if (error instanceof JobPersistenceHoldError) return;
    throw error;
  }
  for (const { job, kind } of reconcileCompletedAnalysisTransitions(observedJobStatuses, value)) {
    if (kind === "t2a-audio" && !t2aAudioEvaluatorCapability.measurementReady) {
      const correlationId = randomUUID();
      console.error(
        "Automatische T2A-Audio-Qualitaetsanalyse ist durch die Capability blockiert.",
        {
          correlationId,
          outputName: job.outputName,
          blockerCode: t2aAudioEvaluatorCapability.blockerCode,
        },
      );
      continue;
    }
    try {
      if (kind === "t2a-audio") startT2aAudioAnalysis(job.outputName);
      else analyses.start(job.outputName);
    } catch (error) {
      if (kind === "t2a-audio") {
        if (error instanceof T2aAudioEvaluatorUnavailableError) {
          console.error("Automatische T2A-Audio-Qualitaetsanalyse konnte nicht sicher gestartet werden.", {
            correlationId: error.correlationId,
            outputName: job.outputName,
            blockerCode: error.blockerCode,
          });
        } else {
          console.error("Automatische T2A-Audio-Qualitaetsanalyse ist intern fehlgeschlagen.", {
            correlationId: randomUUID(),
            outputName: job.outputName,
            cause: error instanceof Error ? error.stack ?? error.message : String(error),
          });
        }
        continue;
      }
      console.error(
        `Automatische Video-Qualitätsanalyse für ${job.outputName} konnte nicht gestartet werden:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
};
// Reconcile transitions that completed while startup sandbox recovery was in
// flight, then subscribe synchronously before another event can interleave.
processAutomaticAnalyses(jobs.list());
jobs.on("changed", processAutomaticAnalyses);
const allowedBrowserOrigins = new Set([
  `http://127.0.0.1:${serverPort}`,
  `http://localhost:${serverPort}`,
  `http://127.0.0.1:${devUiPort}`,
  `http://localhost:${devUiPort}`,
]);

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function isT2aAudioOutputName(outputName: string): boolean {
  return outputName.toLowerCase().endsWith(".wav");
}

function publicOutputListResponse() {
  const listed = outputs.list(jobs.outputAuthorityList());
  const audioAnalyses = collectPublicT2aAudioAnalyses(
    listed,
    (outputName) => t2aAudioAnalyses.getForListing(outputName),
  );
  return publicStudioOutputsResponse(listed, audioAnalyses);
}

function assertProjectOutputReferenceMutationAllowed(projectId: string, outputId: string): void {
  enforceProjectOutputReferenceMutationPolicy(projects.get(projectId), outputId, jobs);
}

/**
 * A restored project may still contain a formerly verified output reference.
 * Once its job is imported as legacy history, continuity and retake metadata
 * remain readable audit history but may no longer authorize another run.
 */
function assertProjectRunSourcesMutationAllowed(projectId: string, shotId: string): void {
  enforceProjectRunSourcesMutationPolicy(projects.get(projectId), shotId, jobs);
}

function sendHeldPublishedOutput(
  response: Response,
  next: NextFunction,
  lease: { fd: number; release?: () => void },
  outputName: string,
): void {
  response.type(extname(outputName));
  const release = bindHeldFileResponseRelease(response, lease.fd, lease.release);
  try {
    response.sendFile(`/proc/self/fd/${lease.fd}`, { dotfiles: "allow" }, (error) => {
      finishHeldFileResponse(response, next, lease.fd, error, release);
    });
  } catch (error) {
    release();
    throw error;
  }
}

function publicationProvenance(
  authority: OutputPublicationAuthority,
  role: string,
): ProvenanceFileEvidence {
  return {
    role,
    path: authority.output.path,
    kind: "file",
    sizeBytes: authority.output.revision.sizeBytes,
    modifiedAtMs: authority.output.revision.modifiedAtMs,
    changedAtMs: authority.output.revision.changedAtMs,
    fileId: authority.output.revision.fileId,
    sha256: authority.output.sha256,
    entries: [],
  };
}

function experimentRetryReadDeps(
  listVerifiedOutputs: (
    experiment: ControlledExperiment,
    arm: "baseline" | "candidate",
  ) => ReturnType<typeof outputs.list> =
    () => outputs.list(jobs.outputAuthorityList()),
): ExperimentArmRetryReadDeps {
  return {
    getJob: (jobId) => jobs.experimentRetryAuthority(jobId),
    hasVerifiedArmOutput: (boundExperiment, boundArm) =>
      listVerifiedOutputs(boundExperiment, boundArm).some((output) =>
        outputVerifiesExperimentArmRun(output, boundExperiment, boundArm)),
    listRemoteJobs: listQueueJobs,
  };
}

function blindEvaluationCookieValues(request: Request): string[] {
  return (request.headers.cookie ?? "").split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== BLIND_EVALUATOR_SCOPE_COOKIE) return [];
    const value = part.slice(separator + 1).trim();
    return /^[0-9a-f]{64}$/.test(value) ? [value] : [];
  });
}

function blindEvaluationCookiePresent(request: Request): boolean {
  return (request.headers.cookie ?? "").split(";").some((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 && part.slice(0, separator).trim() === BLIND_EVALUATOR_SCOPE_COOKIE;
  });
}

function blindEvaluationCredential(request: Request, sessionId: string): string {
  for (const credential of blindEvaluationCookieValues(request)) {
    try {
      blindEvaluations.authorize(sessionId, credential);
      return credential;
    } catch {
      // Only the credential bound to this v5 reservation/session capability is accepted.
    }
  }
  throw new BlindEvaluationConflictError("Blind-Session nicht gefunden.", 404);
}

function setBlindEvaluationCookie(response: Response, credential: string): void {
  response.append(
    "Set-Cookie",
    `${BLIND_EVALUATOR_SCOPE_COOKIE}=${credential}; Path=/api; HttpOnly; SameSite=Strict`,
  );
}

function clearBlindEvaluationCookie(response: Response): void {
  response.append(
    "Set-Cookie",
    `${BLIND_EVALUATOR_SCOPE_COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
}

function blindEvaluationInitialPin(request: Request, sessionId: string) {
  const ifMatch = request.header("if-match") ?? "";
  const matched = /^"([0-9a-f]{64})"$/.exec(ifMatch);
  const commitment = request.header("x-blind-evaluation-commitment") ?? "";
  const pinnedSessionId = request.header("x-blind-evaluation-id") ?? "";
  const parsed = blindEvaluationInitialPinSchema.safeParse({
    schemaVersion: "ltx-studio-blind-evaluation-initial-pin.v5",
    id: pinnedSessionId,
    commitment,
    publicStateSha256: matched?.[1] ?? "",
  });
  if (!parsed.success || parsed.data.id !== sessionId) {
    throw new BlindEvaluationConflictError("Der initiale Browser-Pin fehlt oder ist ungültig.", 412);
  }
  return parsed.data;
}

function blindEvaluationSubmissionPin(request: Request, sessionId: string) {
  const encoded = request.header("x-blind-submission-pin") ?? "";
  if (!/^[A-Za-z0-9_-]{1,2048}$/u.test(encoded)) {
    throw new BlindEvaluationConflictError("Der dauerhafte Browser-Submission-Pin fehlt oder ist ungültig.", 412);
  }
  try {
    const raw = Buffer.from(encoded, "base64url");
    if (raw.length < 2 || raw.length > 1_536) throw new Error("invalid pin size");
    const parsed = blindEvaluationSubmissionPinSchema.parse(JSON.parse(raw.toString("utf8")) as unknown);
    if (parsed.sessionId !== sessionId) throw new Error("session mismatch");
    return parsed;
  } catch {
    throw new BlindEvaluationConflictError("Der dauerhafte Browser-Submission-Pin fehlt oder ist ungültig.", 412);
  }
}

function blindEvaluationContext(sessionId: string, credential: string): {
  experiment: ControlledExperiment;
} {
  const experimentId = blindEvaluations.boundExperimentId(sessionId, credential);
  return {
    experiment: experiments.verifyFrozenIntegrity(experimentId),
  };
}

app.disable("x-powered-by");
app.use(createLocalStudioHostGate(serverPort));
app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && !allowedBrowserOrigins.has(origin)) {
    // Reject a foreign browser before consulting the evaluator lock so the
    // lock's existence is never disclosed cross-origin.
    return response.status(403).json({ error: "Nur die lokale Studio-Oberfläche darf Browser-Anfragen senden." });
  }
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; "
      + "img-src 'self' blob: data:; media-src 'self' blob:; object-src 'none'; script-src 'self'; style-src 'self'",
  );
  // HOLD is a process-wide durability boundary, not merely a JobManager
  // condition. Reject every HTTP mutation before JSON, multipart, project,
  // experiment, evaluator, or asset middleware can allocate or persist bytes.
  // Read-only recovery surfaces remain available so the operator can inspect
  // health and preserved media before repairing the snapshot and restarting.
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)
    && jobs.persistenceHealth().status === "hold") {
    return response.status(503).json(toPublicJobPersistenceHoldError());
  }
  const blindGate = evaluateBlindV5ApiGate({
    path: request.path,
    method: request.method,
    capabilityCookiePresent: blindEvaluationCookiePresent(request),
    readGlobalLock: () => blindEvaluations.hasActiveSession(),
  });
  blindEvaluatorServerLock = blindGate.locked;
  if (blindGate.rejection) {
    if (blindGate.rejection.allow) response.setHeader("Allow", blindGate.rejection.allow);
    return response.status(blindGate.rejection.status).json({ error: blindGate.rejection.error });
  }
  next();
});
app.use(express.json({ limit: "2mb" }));

const acceptedExtensions: Record<string, Set<string>> = {
  image: new Set([".png", ".jpg", ".jpeg", ".webp"]),
  video: new Set([".mp4", ".webm", ".mov", ".mkv"]),
  audio: new Set([".wav", ".mp3", ".flac", ".m4a", ".ogg"]),
  mask: new Set([".mp4", ".webm", ".mov", ".mkv"]),
};
const lipDubReferenceDimensionSchema = z.number().int().min(64).max(4096).refine(
  (value) => value % 64 === 0,
  { message: "Breite und Höhe müssen durch 64 teilbar sein." },
);
const lipDubReferencePathSchema = z.string().trim().min(1).max(4096).refine((value) => !value.includes("\0"), {
  message: "NUL-Zeichen sind nicht erlaubt.",
});
const lipDubReferenceInspectionRequestSchema = z.object({
  path: lipDubReferencePathSchema,
  width: lipDubReferenceDimensionSchema,
  height: lipDubReferenceDimensionSchema,
  dialogue: z.string().max(20_000).default(""),
  prompt: z.string().max(20_000).default(""),
  pipelineProfile: z.enum(["official-comfy-hq", "native-distilled"]).optional(),
});
const lipDubReferencePreparationRequestSchema = z.object({
  mode: z.literal("lipdub").optional(),
  width: lipDubReferenceDimensionSchema,
  height: lipDubReferenceDimensionSchema,
  lipDub: z.object({
    pipelineProfile: z.enum(["official-comfy-hq", "native-distilled"]).default("native-distilled"),
    referenceVideo: z.object({
      path: lipDubReferencePathSchema,
      name: z.string().trim().max(255).default(""),
      strength: z.number().finite().min(0).max(2).default(1),
    }),
  }),
  trim: z.object({
    startSeconds: z.number().finite().min(0).max(86_400),
    durationSeconds: z.number().finite().min(2).max(5),
  }).optional(),
});
const imageCropPreparationRequestSchema = z.object({
  path: lipDubReferencePathSchema,
  x: z.number().int().min(0).max(16_384),
  y: z.number().int().min(0).max(16_384),
  width: z.number().int().min(64).max(16_384),
  height: z.number().int().min(64).max(16_384),
  outputWidth: lipDubReferenceDimensionSchema,
  outputHeight: lipDubReferenceDimensionSchema,
  // "bokeh" passt ein Porträt in einen Breitbildrahmen ein, statt es zu quetschen.
  fit: z.enum(["stretch", "bokeh"]).optional(),
  coverage: z.number().min(0.3).max(1).optional(),
  feather: z.number().int().min(0).max(512).optional(),
}).strict();

const outputFrameRequestSchema = z.object({
  output: outputNameSchema,
  atSeconds: z.number().min(0).max(3600).optional(),
  strategy: z.literal("best-face").optional(),
}).strict().refine(
  (value) => (value.atSeconds === undefined) !== (value.strategy === undefined),
  { message: "Entweder Zeitpunkt oder automatische Auswahl angeben." },
);

const sequenceAssembleRequestSchema = z.object({
  // Entweder nur der Name oder ein Schnittplatz-Eintrag mit In- und Out-Punkt.
  outputs: z.array(z.union([
    outputNameSchema,
    z.object({
      output: outputNameSchema,
      trimStartSeconds: z.number().min(0).max(3600).optional(),
      trimEndSeconds: z.number().min(0).max(3600).optional(),
    }).strict(),
  ])).min(2).max(200),
  name: z.string().trim().min(1).max(120).optional(),
}).strict();

const upload = multer({
  storage: multer.diskStorage({
    destination: (request, _file, callback) => {
      const kind = routeParam(request.params.kind);
      const directory = join(uploadRoot, acceptedExtensions[kind] ? kind : "invalid");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      callback(null, directory);
    },
    filename: (_request, file, callback) => {
      callback(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`);
    },
  }),
  limits: { files: 1, fileSize: 8 * 1024 ** 3, fields: 4 },
  fileFilter: (request, file, callback) => {
    const allowed = acceptedExtensions[routeParam(request.params.kind)];
    callback(null, Boolean(allowed?.has(extname(file.originalname).toLowerCase())));
  },
});

app.get("/api/config", (_request, response) => {
  response.json({
    pipelines: PIPELINES,
    features: {
      qualityGuidedSceneReference: true,
    },
    runtime: {
      minAvailableGiB,
      minResidualMemoryGiB,
      minSwapFreeGiB,
      outputRoot,
      maxUploadGiB: 8,
      admissionRequired,
    },
  });
});

app.get("/api/health", async (_request, response) => {
  const resources = readResourceSnapshot();
  const activation = jobs.activationStatus();
  const persistence = jobs.persistenceHealth();
  const runtimeAuthorityIsolation = releaseIdentity.runtimeTrust?.authorityIsolation;
  const phonemeVisemeState = phonemeVisemeEvaluatorStates.get();
  const phonemeViseme = phonemeVisemeState.result;
  let runtimeStatus;
  let orchestratorReachable = false;
  try {
    runtimeStatus = await readOrchestratorStatus();
    orchestratorReachable = true;
  } catch {
    runtimeStatus = { overall: "unknown", qwen: "offline" as const, workloads: [] };
  }
  const health = toPublicHealth({
    state: resources.outputFreeGiB !== null
      && activation.productStartsAllowed
      && persistence.status === "ok"
      ? "ready"
      : "blocked",
    release: {
      sealed: releaseIdentity.sealed,
      verified: releaseIdentity.verified,
      authorityIsolation: runtimeAuthorityIsolation ?? null,
    },
    resources,
    engine: pythonRuntimeAvailable(rendererPythonExecutable, { isolated: true }) ? "available" : "missing",
    analysisEngine: analysisRuntimeReady ? "available" : "missing",
    orchestrator: admissionRequired && orchestratorReachable && admissionClientAvailable() ? "available" : admissionRequired ? "missing" : "disabled",
    qwen: runtimeStatus.qwen,
    runtimeOverall: runtimeStatus.overall,
    workloads: runtimeStatus.workloads,
    evaluators: {
      phonemeViseme: {
        status: phonemeViseme.status,
        blockerCode: phonemeViseme.blockerCode,
        message: phonemeViseme.error,
        productGo: phonemeViseme.productGo.status,
        measurementReady: Boolean(phonemeVisemeState.execution),
        method: phonemeVisemeState.execution?.method ?? null,
      },
      t2aAudio: t2aAudioEvaluatorCapability,
    },
    jobPersistence: persistence,
    queueDepth: jobs.list().filter((job) => isActiveJobStatus(job.status)).length,
  });
  response
    .status(persistence.status === "hold" ? 503 : 200)
    .json(health);
});

app.get("/api/models", async (request, response) => {
  response.json(toPublicModelInventory(await getModelInventory(
    request.query.refresh === "1",
    request.query.verify === "1" ? recommendedModelAssets.map((asset) => asset.id) : [],
  )));
});

app.post("/api/uploads/:kind", upload.single("file"), (request, response) => {
  const kind = routeParam(request.params.kind);
  if (!acceptedExtensions[kind]) return response.status(404).json({ error: "Unbekannter Upload-Typ." });
  if (!request.file) return response.status(400).json({ error: "Dateityp nicht erlaubt oder keine Datei empfangen." });
  if (!matchesUploadSignature(request.file.path)) {
    unlinkSync(request.file.path);
    return response.status(400).json({ error: "Dateiinhalt passt nicht zum erlaubten Medienformat." });
  }
  let asset;
  try {
    asset = assets.add(request.file, kind as AssetKind);
  } catch (error) {
    unlinkSync(request.file.path);
    throw error;
  }
  response.status(201).json(toPublicStudioAsset(asset));
});

app.get("/api/assets", (request, response) => {
  const rawKind = typeof request.query.kind === "string" ? request.query.kind : undefined;
  if (rawKind && !assetKinds.includes(rawKind as AssetKind)) {
    return response.status(400).json({ error: "Unbekannter Medientyp." });
  }
  response.json(publicAssetListResponse(assets.list(rawKind as AssetKind | undefined)));
});

app.get("/api/uploads/:kind/:filename", (request, response) => {
  const kind = routeParam(request.params.kind);
  const filename = routeParam(request.params.filename);
  if (!acceptedExtensions[kind] || !/^[0-9a-f-]{36}\.[a-z0-9]+$/i.test(filename)) {
    return response.status(404).json({ error: "Upload nicht gefunden." });
  }
  const uploadPath = resolve(uploadRoot, kind, filename);
  if (!uploadPath.startsWith(`${resolve(uploadRoot, kind)}/`)) {
    return response.status(400).json({ error: "Ungültiger Upload-Pfad." });
  }
  response.sendFile(uploadPath, { dotfiles: "allow" });
});

app.post("/api/images/crop", async (request, response) => {
  const payload = imageCropPreparationRequestSchema.parse(request.body);
  const sourceAsset = assets.findByPath("image", payload.path);
  if (!sourceAsset) {
    return response.status(400).json({
      error: "Bildzuschnitt ist nur für Bilder aus der Studio-Mediathek verfügbar.",
    });
  }
  const source = await captureProvenanceFile(sourceAsset.path, "derived-source:image-face-crop");
  const prepared = await prepareImageCrop({ ...payload, sourceName: sourceAsset.name });
  const sourceError = verifyProvenanceFileEvidence(source);
  if (sourceError) {
    unlinkSync(prepared.file.path);
    throw new ImageCropPreparationError(
      "Das Quellbild wurde während des Zuschnitts verändert. Das Ergebnis wurde verworfen.",
      409,
    );
  }
  let asset;
  try {
    asset = assets.add(prepared.file, "image", {
      schemaVersion: "ltx-studio-asset-derivation.v1",
      operation: "image-face-crop",
      source,
      additionalSources: [],
      parameters: {
        sourceAssetId: sourceAsset.id,
        sourceWidth: prepared.source.width,
        sourceHeight: prepared.source.height,
        x: prepared.crop.x,
        y: prepared.crop.y,
        width: prepared.crop.width,
        height: prepared.crop.height,
        outputWidth: prepared.target.width,
        outputHeight: prepared.target.height,
        fit: prepared.fit,
        coverage: prepared.coverage,
        feather: prepared.feather,
        scaleFilter: prepared.scaleFilter,
      },
      command: prepared.command,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    unlinkSync(prepared.file.path);
    throw error;
  }
  response.status(201).json(publicImageCropResponse(asset, prepared));
});

app.post("/api/jobs/plan", async (request, response) => {
  const payload = withOfficialSpeechModelPaths(generationRequestSchema.parse(request.body));
  const qualificationHold = qualificationHoldForRequest(payload);
  // A command string is itself an operator-facing execution promise.  Prove
  // the exact installed source before displaying that promise. A held DFR
  // plan is explicitly diagnostic-only, so expose its HOLD independently of
  // the installed (possibly still pre-v1.3) source without implying execution.
  if (!qualificationHold) verifyNativeRuntimeSource(payload, rendererPythonExecutable);
  const plan = buildCommand(payload);
  const requiredAssetIds = requiredOfficialSpeechAssetIds(payload);
  // A held plan is diagnostic-only.  Do not hash tens of GiB of model files
  // for a request that cannot proceed, and do not let repeated local preview
  // calls turn the qualification fence into an I/O-amplification path.
  const inventory = !qualificationHold && requiredAssetIds.length > 0
    ? await getModelInventory(false, requiredAssetIds)
    : undefined;
  response.json({
    command: plan.displayCommand,
    outputPath: plan.outputPath,
    pathErrors: validateRequestPlan(payload, plan, inventory),
    pathWarnings: warnRequestPlan(payload),
    suggestions: suggestRequestPlan(payload),
    execution: {
      status: qualificationHold ? "qualification-hold" : "preview-only",
      qualificationHold,
    },
  });
});

app.post("/api/images/from-output", async (request, response) => {
  const payload = outputFrameRequestSchema.parse(request.body);
  jobs.assertOutputMutationAllowed(payload.output);
  const authorityJobs = jobs.outputAuthorityList();
  const snapshot = await outputs.materializePublishedOutputs([payload.output], authorityJobs);
  const authority = snapshot.authorities.get(payload.output);
  if (!authority) {
    snapshot.release();
    throw new OutputFrameError("Ausgabe ist nicht autoritativ verfügbar.", 404);
  }
  try {
  // Herkunft vor dem Griff binden und danach prüfen: Ändert sich die Ausgabe
  // währenddessen, ist der Frame nicht mehr das, was er zu sein vorgibt.
  const source = publicationProvenance(authority, `output-frame-source:${payload.output}`);
  const recommendationScriptPath = join(appRoot, "scripts", "select_scene_reference_frame.py");
  const recommendationModelPath = join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
  const recommendationScript = payload.strategy
    ? await captureProvenanceFile(recommendationScriptPath, "code:scene-reference-frame-selector")
    : null;
  const recommendationModel = payload.strategy
    ? await captureProvenanceFile(recommendationModelPath, "model:scene-reference-frame-yunet")
    : null;
  if (recommendationModel && recommendationModel.sha256 !== SCENE_REFERENCE_YUNET_SHA256) {
    throw new SceneReferenceFrameError(
      `YuNet-Modell hat eine unerwartete Prüfsumme: ${recommendationModelPath}`,
      500,
    );
  }
  snapshot.verify(jobs.outputAuthorityList());
  const recommendation = payload.strategy
    ? await recommendSceneReferenceFrame(join(snapshot.root, payload.output), {
        script: recommendationScriptPath,
        faceModel: recommendationModelPath,
      })
    : null;
  snapshot.verify(jobs.outputAuthorityList());
  const atSeconds = payload.atSeconds ?? recommendation?.atSeconds;
  if (atSeconds === undefined) {
    throw new OutputFrameError("Kein gültiger Referenzzeitpunkt ermittelt.", 500);
  }
  snapshot.verify(jobs.outputAuthorityList());
  const extracted = await extractOutputFrame({ output: payload.output, atSeconds }, snapshot.root);
  snapshot.verify(jobs.outputAuthorityList());
  const currentAuthority = outputs.readPublishedOutputAuthority(
    payload.output,
    jobs.outputAuthorityList(),
    authority.jobId,
  );
  const changedSource = JSON.stringify(currentAuthority) !== JSON.stringify(authority)
    ? "Die Job-/Publikationsautorität änderte sich während der Frame-Übernahme."
    : verifyProvenanceFileEvidence(source);
  const changedScript = recommendationScript ? verifyProvenanceFileEvidence(recommendationScript) : null;
  const changedModel = recommendationModel ? verifyProvenanceFileEvidence(recommendationModel) : null;
  if (changedSource || changedScript || changedModel) {
    unlinkSync(extracted.file.path);
    throw new OutputFrameError(
      changedSource
        ? "Die Ausgabe wurde während der Frame-Übernahme verändert. Das Ergebnis wurde verworfen."
        : changedScript
          ? "Das Auswahlskript wurde während der automatischen Auswahl verändert. Das Ergebnis wurde verworfen."
        : "Das Gesichtsmodell wurde während der automatischen Auswahl verändert. Das Ergebnis wurde verworfen.",
      409,
    );
  }
  let asset;
  try {
    asset = assets.add(extracted.file, "image", {
      schemaVersion: "ltx-studio-asset-derivation.v1",
      operation: "output-frame",
      source,
      additionalSources: recommendationScript && recommendationModel
        ? [recommendationScript, recommendationModel]
        : [],
      parameters: {
        outputName: extracted.outputName,
        atSeconds: extracted.atSeconds,
        width: extracted.width,
        height: extracted.height,
        sourceDurationSeconds: extracted.sourceDurationSeconds,
        selectionStrategy: recommendation ? "best-face" : "manual",
        recommendationScore: recommendation?.score ?? null,
        sampledFrames: recommendation?.sampledFrames ?? null,
        eligibleFrames: recommendation?.eligibleFrames ?? null,
        faceSharpness: recommendation?.metrics.faceSharpness ?? null,
        faceAreaRatio: recommendation?.metrics.faceAreaRatio ?? null,
        faceConfidence: recommendation?.metrics.faceConfidence ?? null,
        stability: recommendation?.metrics.stability ?? null,
        exposure: recommendation?.metrics.exposure ?? null,
        frontalness: recommendation?.metrics.frontalness ?? null,
        topCandidates: recommendation ? JSON.stringify(recommendation.candidates) : null,
      },
      command: recommendation ? `${recommendation.command}\n${extracted.command}` : extracted.command,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    unlinkSync(extracted.file.path);
    throw error;
  }
  response.status(201).json(publicOutputFrameResponse(asset, recommendation));
  } finally {
    snapshot.release();
  }
});

app.post("/api/sequences/assemble", async (request, response) => {
  const payload = sequenceAssembleRequestSchema.parse(request.body);
  // Provenienz jedes Shots vor dem Schnitt binden. Verändert sich ein Shot
  // während der Montage, wird das Ergebnis verworfen - dieselbe fail-closed
  // Regel wie beim Bildzuschnitt und bei der LipDub-Vorbereitung.
  const sourceNames = payload.outputs.map((entry) => typeof entry === "string" ? entry : entry.output);
  for (const outputName of sourceNames) jobs.assertOutputMutationAllowed(outputName);
  const authorityJobs = jobs.outputAuthorityList();
  const snapshot = await outputs.materializePublishedOutputs(sourceNames, authorityJobs);
  try {
  const sources = sourceNames.map((outputName, index) => {
    const authority = snapshot.authorities.get(outputName);
    if (!authority) throw new SequenceAssembleError(`Ausgabe ${outputName} ist nicht autoritativ verfügbar.`, 404);
    return publicationProvenance(authority, `sequence-shot:${index}:${outputName}`);
  });
  snapshot.verify(jobs.outputAuthorityList());
  const prepared = await assembleSequence(payload, snapshot.root);
  snapshot.verify(jobs.outputAuthorityList());
  const currentJobs = jobs.outputAuthorityList();
  const changedAuthority = sourceNames.find((outputName) => {
    const before = snapshot.authorities.get(outputName);
    const after = outputs.readPublishedOutputAuthority(outputName, currentJobs, before?.jobId);
    return JSON.stringify(after) !== JSON.stringify(before);
  });
  const changed = changedAuthority
    ? `Die Job-/Publikationsautorität von ${changedAuthority} änderte sich.`
    : sources.map((source) => verifyProvenanceFileEvidence(source)).find(Boolean);
  if (changed) {
    unlinkSync(prepared.file.path);
    throw new SequenceAssembleError(
      "Ein Shot wurde während des Zusammenschnitts verändert. Das Ergebnis wurde verworfen.",
      409,
    );
  }
  let asset;
  try {
    asset = assets.add(prepared.file, "video", {
      schemaVersion: "ltx-studio-asset-derivation.v1",
      operation: "sequence-assemble",
      source: sources[0],
      additionalSources: sources.slice(1),
      parameters: {
        shotCount: prepared.shots.length,
        // Jeder Shot mit seinen Schnittpunkten, damit die Montage nachvollziehbar
        // bleibt: "name@start-ende" in Sekunden, ungeschnitten ohne Zusatz.
        shotOrder: prepared.shots.map((shot) =>
          shot.trimStartSeconds > 0 || shot.trimEndSeconds > 0
            ? `${shot.outputName}@${shot.trimStartSeconds}-${shot.trimEndSeconds}`
            : shot.outputName).join(","),
        width: prepared.target.width,
        height: prepared.target.height,
        durationSeconds: prepared.target.durationSeconds,
      },
      command: prepared.command,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    unlinkSync(prepared.file.path);
    throw error;
  }
  response.status(201).json(publicSequenceResponse(asset, prepared));
  } finally {
    snapshot.release();
  }
});

app.post("/api/lipdub/reference/inspect", (request, response) => {
  const payload = lipDubReferenceInspectionRequestSchema.parse(request.body);
  if (!assets.findByPath("video", payload.path)) {
    return response.status(400).json({
      error: "LipDub-Referenzdiagnose ist nur für Videos aus der Studio-Mediathek verfügbar.",
    });
  }
  response.json(inspectLipDubReference(payload));
});

app.post("/api/lipdub/reference/prepare", async (request, response) => {
  const payload = lipDubReferencePreparationRequestSchema.parse(request.body);
  const sourceAsset = assets.findByPath("video", payload.lipDub.referenceVideo.path);
  if (!sourceAsset) {
    return response.status(400).json({
      error: "LipDub-Referenzvorbereitung ist nur für Videos aus der Studio-Mediathek verfügbar.",
    });
  }
  const source = await captureProvenanceFile(sourceAsset.path, "derived-source:lipdub-reference-video");
  const prepared = await prepareLipDubReference(payload);
  const sourceError = verifyProvenanceFileEvidence(source);
  if (sourceError) {
    unlinkSync(prepared.file.path);
    throw new LipDubReferencePreparationError(
      "Das LipDub-Quellvideo wurde während der Vorbereitung verändert. Das Ergebnis wurde verworfen.",
      409,
    );
  }
  let asset;
  try {
    asset = assets.add(prepared.file, "video", {
      schemaVersion: "ltx-studio-asset-derivation.v1",
      operation: "lipdub-reference-prepare",
      source,
      additionalSources: [],
      parameters: {
        sourceAssetId: sourceAsset.id,
        width: prepared.target.width,
        height: prepared.target.height,
        fps: prepared.target.fps,
        frames: prepared.target.frames,
        durationSeconds: prepared.target.durationSeconds,
        trimStartSeconds: prepared.trim?.startSeconds ?? null,
        trimRequestedDurationSeconds: prepared.trim?.requestedDurationSeconds ?? null,
      },
      command: prepared.command,
      createdAt: new Date().toISOString(),
    });
  } catch (error) {
    unlinkSync(prepared.file.path);
    throw error;
  }
  response.status(201).json(publicLipDubReferenceResponse(asset, prepared));
});

app.get("/api/jobs", (_request, response) => response.json({ jobs: toPublicStudioJobs(jobs.list()) }));
app.get("/api/outputs", (_request, response) => response.json(publicOutputListResponse()));
app.get("/api/experiments", (_request, response) => {
  const available = experiments.listAvailable();
  response.json({
    experiments: toPublicControlledExperiments(available.experiments),
    warnings: available.warnings,
  });
});
app.get("/api/blind-evaluator-scope", (request, response) => {
  const values = blindEvaluationCookieValues(request);
  if (!blindEvaluationCookiePresent(request)) {
    return response.json({ locked: blindEvaluatorServerLock, evaluation: null });
  }
  if (values.length !== 1) {
    clearBlindEvaluationCookie(response);
    return response.json({ locked: true, evaluation: null });
  }
  try {
    const evaluation = blindEvaluations.scopeForCredential(values[0]!);
    if (!evaluation) {
      clearBlindEvaluationCookie(response);
      return response.json({ locked: true, evaluation: null });
    }
    return response.json({ locked: true, evaluation });
  } catch {
    clearBlindEvaluationCookie(response);
    return response.json({ locked: true, evaluation: null });
  }
});

app.post("/api/blind-evaluations", (request, response) => {
  const payload = blindEvaluationCreateInputSchema.parse(request.body);
  const experiment = experiments.verifyFrozenIntegrity(payload.experimentId);
  const cookieValues = blindEvaluationCookieValues(request);
  const providedCredential = cookieValues.length === 1 ? cookieValues[0] : undefined;
  const reserved = blindEvaluations.reserve(
    experiment,
    payload.creationRequestId,
    new Date().toISOString(),
    providedCredential,
  );
  setBlindEvaluationCookie(response, reserved.credential);
  response.status(201).json({
    evaluation: reserved.evaluation,
    creationToken: reserved.creationToken,
  });
});

app.get("/api/blind-evaluations/:id", (request, response) => {
  const id = z.string().uuid().parse(routeParam(request.params.id));
  const credential = blindEvaluationCredential(request, id);
  response.json({ evaluation: blindEvaluations.get(id, credential) });
});

app.post("/api/blind-evaluations/:id/claim", async (request, response) => {
  const payload = blindEvaluationClaimInputSchema.parse(request.body);
  const id = z.string().uuid().parse(routeParam(request.params.id));
  const credential = blindEvaluationCredential(request, id);
  const context = blindEvaluationContext(id, credential);
  const authorityJobs = jobs.outputAuthorityList();
  const evaluation = await blindEvaluations.claim(
    id,
    credential,
    payload.creationToken,
    context.experiment,
    {
      outputs: outputs.list(authorityJobs),
      openPublishedOutput: (outputName, expectedJobId) =>
        outputs.openPublishedOutput(outputName, authorityJobs, expectedJobId),
    },
    closeStudioEventStreams,
  );
  blindEvaluatorServerLock = blindEvaluations.hasActiveSession();
  response.status(evaluation.status === "creating" ? 202 : 200).json({ evaluation });
});

app.get("/api/blind-evaluations/:id/media/:channel", async (request, response) => {
  const id = z.string().uuid().parse(routeParam(request.params.id));
  const channel = blindEvaluationChannelSchema.parse(routeParam(request.params.channel));
  const credential = blindEvaluationCredential(request, id);
  const lease = blindEvaluations.openMedia(id, channel, credential);
  sendVerifiedBlindEvaluationMedia(request, response, lease);
});

app.post("/api/blind-evaluations/:id/submission", async (request, response) => {
  const id = z.string().uuid().parse(routeParam(request.params.id));
  const payload = blindEvaluationSubmissionInputSchema.parse(request.body);
  const initialPin = blindEvaluationInitialPin(request, id);
  const submissionPin = blindEvaluationSubmissionPin(request, id);
  const credential = blindEvaluationCredential(request, id);
  const context = blindEvaluationContext(id, credential);
  const idempotencyKey = request.header("idempotency-key") ?? "";
  if (!/^[0-9a-f]{64}$/.test(idempotencyKey)) {
    throw new BlindEvaluationConflictError(
      "Blind-v5-Submit benötigt genau einen 64-stelligen Idempotency-Key.",
      412,
    );
  }
  const evaluation = await blindEvaluations.submit(
    id,
    credential,
    payload,
    initialPin,
    context.experiment,
    idempotencyKey,
    new Date().toISOString(),
    submissionPin,
  );
  blindEvaluatorServerLock = blindEvaluations.hasActiveSession();
  response.status(201).json({ evaluation });
});

app.post("/api/blind-evaluations/:id/abort", (request, response) => {
  z.object({}).strict().parse(request.body ?? {});
  const id = z.string().uuid().parse(routeParam(request.params.id));
  const credential = blindEvaluationCredential(request, id);
  blindEvaluations.abort(id, credential);
  blindEvaluatorServerLock = blindEvaluations.hasActiveSession();
  clearBlindEvaluationCookie(response);
  response.status(204).end();
});

app.post("/api/blind-evaluations/:id/scope/release", (request, response) => {
  z.object({}).strict().parse(request.body ?? {});
  const id = z.string().uuid().parse(routeParam(request.params.id));
  try {
    const credential = blindEvaluationCredential(request, id);
    const evaluation = blindEvaluations.get(id, credential);
    if (evaluation.status === "active" || evaluation.status === "creating") {
      try {
        blindEvaluations.abort(id, credential);
      } catch (error) {
        const concurrent = blindEvaluations.get(id, credential);
        if (concurrent.status !== "submitted") throw error;
      }
    }
  } catch (error) {
    if (!(error instanceof BlindEvaluationConflictError) || error.statusCode !== 404) throw error;
  }
  blindEvaluatorServerLock = blindEvaluations.hasActiveSession();
  clearBlindEvaluationCookie(response);
  response.status(204).end();
});
app.get("/api/projects", (_request, response) => {
  response.json(publicProjectListResponse(projects.listAvailable()));
});

app.get("/api/projects/:id/history", (request, response) => {
  response.json(publicProjectHistoryResponse(projects.history(routeParam(request.params.id))));
});

app.post("/api/projects", (request, response) => {
  const payload = projectCreateRequestSchema.parse(request.body);
  response.status(201).json(publicProjectResponse(
    projects.create({ ...payload, actorId: projectActorId }),
  ));
});

app.post("/api/projects/:id/shots", (request, response) => {
  const payload = projectShotCreateRequestSchema.parse(request.body);
  const projectId = routeParam(request.params.id);
  if (payload.continuity) {
    assertProjectOutputReferenceMutationAllowed(projectId, payload.continuity.referenceOutputId);
  }
  response.status(201).json(publicProjectResponse(
    projects.addShot(projectId, {
      ...payload,
      request: withOfficialSpeechModelPaths(payload.request),
      actorId: projectActorId,
    }),
  ));
});

app.post("/api/projects/:id/shots/:shotId/revisions", (request, response) => {
  const payload = projectShotRevisionRequestSchema.parse(request.body);
  const projectId = routeParam(request.params.id);
  if (payload.sourceOutputId) {
    assertProjectOutputReferenceMutationAllowed(projectId, payload.sourceOutputId);
  }
  response.status(201).json(publicProjectResponse(
    projects.reviseShot(projectId, {
      ...payload,
      request: withOfficialSpeechModelPaths(payload.request),
      shotId: routeParam(request.params.shotId),
      actorId: projectActorId,
    }),
  ));
});

app.post("/api/projects/:id/shots/:shotId/outputs", async (request, response) => {
  const payload = projectOutputCaptureRequestSchema.parse(request.body);
  jobs.assertOutputMutationAllowed(payload.outputName);
  const projectId = routeParam(request.params.id);
  const shotId = routeParam(request.params.shotId);
  const expectedRequestSha256 = projects.preflightOutputCapture(
    projectId,
    payload.expectedRevision,
    shotId,
    payload.requestRevisionId,
  );
  const recordedAt = new Date().toISOString();
  const evidence = await outputs.captureProjectOutputEvidence(
    payload.outputName,
    {
      projectId,
      shotId,
      requestRevisionId: payload.requestRevisionId,
    },
    jobs.outputAuthorityList(),
    recordedAt,
  );
  if (evidence.requestSha256 !== expectedRequestSha256) {
    throw new ProjectConflictError("Ausgabe stimmt nicht mit der gebundenen Projekt-Request-Revision überein.");
  }
  response.status(201).json(publicProjectResponse(
    projects.recordOutput(projectId, {
      expectedRevision: payload.expectedRevision,
      shotId,
      evidence,
      actorId: projectActorId,
    }, recordedAt),
  ));
});

app.post("/api/projects/:id/shots/:shotId/run", (request, response) => {
  const payload = projectRunRequestSchema.parse(request.body);
  const projectId = routeParam(request.params.id);
  const shotId = routeParam(request.params.shotId);
  assertProjectRunSourcesMutationAllowed(projectId, shotId);
  const run = projects.bindingForRun(projectId, payload.expectedRevision, shotId);
  verifyNativeRuntimeSource(run.request, rendererPythonExecutable);
  response.status(202).json({
    project: toPublicProjectRunSummary(run.binding),
    job: toPublicStudioJob(jobs.create(run.request, { project: run.binding })),
  });
});

app.post("/api/projects/:id/shots/:shotId/approve", (request, response) => {
  const payload = projectOutputApprovalRequestSchema.parse(request.body);
  const projectId = routeParam(request.params.id);
  assertProjectOutputReferenceMutationAllowed(projectId, payload.outputId);
  response.json(publicProjectResponse(
    projects.approveOutput(projectId, {
      ...payload,
      shotId: routeParam(request.params.shotId),
      actorId: projectActorId,
    }),
  ));
});

app.post("/api/projects/:id/archive", (request, response) => {
  const payload = projectArchiveRequestSchema.parse(request.body);
  response.json(publicProjectResponse(
    projects.archive(routeParam(request.params.id), {
      ...payload,
      actorId: projectActorId,
    }),
  ));
});

app.post("/api/experiments", (request, response) => {
  let payload = experimentCreateInputSchema.parse(request.body);
  let baselineEvidence = null;
  if (payload.baselineOutputName) {
    if (experimentRequiresFreshBaseline(payload.candidate)) {
      throw new ExperimentConflictError(
        "Dieses Experiment benötigt zwingend einen frischen Baseline-Lauf mit identischen Ausführungsinputs, Code und Runtime.",
      );
    }
    const output = outputs.list(jobs.outputAuthorityList())
      .find((item) => item.name === payload.baselineOutputName);
    if (
      !output?.settingsAvailable
      || !output.request
      || !output.jobId
      || !output.provenance?.verifiedAt
      || output.provenance.fingerprint.length !== 64
    ) {
      throw new ExperimentConflictError(
        "Die ausgewählte vorhandene Baseline ist nicht vollständig und unverändert provenienzverifiziert.",
      );
    }
    if (requestSettingsSha256(output.request) !== requestSettingsSha256(payload.baselineRequest)) {
      throw new ExperimentConflictError(
        "Die ausgewählte vorhandene Baseline stimmt nicht exakt mit den aktuellen Experimentparametern überein.",
      );
    }
    baselineEvidence = {
      outputName: output.name,
      jobId: output.jobId,
      sizeBytes: output.sizeBytes,
      changedAt: output.changedAt,
      fileId: output.fileId,
      provenanceFingerprint: output.provenance.fingerprint,
    };
    payload = experimentCreateInputSchema.parse({
      ...payload,
      baselineRequest: output.request,
    });
  } else {
    payload = experimentCreateInputSchema.parse({
      ...payload,
      baselineRequest: withOfficialSpeechModelPaths(payload.baselineRequest),
    });
  }
  response.status(201).json({
    experiment: toPublicControlledExperiment(experiments.create(payload, undefined, baselineEvidence)),
  });
});

app.post("/api/experiments/:id/freeze", (request, response) => {
  response.json({ experiment: toPublicControlledExperiment(experiments.freeze(request.params.id)) });
});

app.post("/api/experiments/:id/supersede", (request, response) => {
  const payload = z.object({
    reason: z.string().trim().min(1).max(500),
    replacementExperimentId: z.string().uuid().nullable().default(null),
  }).strict().parse(request.body ?? {});
  response.json({
    experiment: toPublicControlledExperiment(experiments.supersede(
      request.params.id,
      payload.reason,
      payload.replacementExperimentId,
    )),
  });
});

app.post("/api/experiments/:id/runs/:arm/preflight", async (request, response) => {
  const arm = z.enum(["baseline", "candidate"]).parse(request.params.arm);
  let experiment = experiments.get(request.params.id);
  if (!experiment) throw new ExperimentConflictError("Experiment nicht gefunden.");
  const authorityJobs = jobs.outputAuthorityList();
  const inspectReadOnlyOutput = (outputName: string) =>
    outputs.inspectExperimentPreflightEvidence([outputName], authorityJobs);
  let audioOnly = isProgramAudioOnlyCandidate(experiment, arm);
  let rawMuxPair = isRawMuxPairCandidate(experiment, arm);
  let binding: ReturnType<typeof experiments.bindingFor>;
  try {
    const selected = experiment.arms[arm === "baseline" ? 0 : 1];
    if (selected.jobId) jobs.assertJobMutationAllowed(selected.jobId);
    if (arm === "candidate" && experiment.arms[0].jobId) {
      jobs.assertJobMutationAllowed(experiment.arms[0].jobId);
    }
    if (selected.jobId) {
      const retryableJobId = await inspectRetryableExperimentArm(
        experiment,
        arm,
        experimentRetryReadDeps((boundExperiment, boundArm) =>
          inspectReadOnlyOutput(
            boundExperiment.arms[boundArm === "baseline" ? 0 : 1].request.outputName,
          ).outputs),
      );
      if (!retryableJobId) {
        // Preserve the canonical active/completed-arm conflict message.
        binding = experiments.bindingFor(experiment.id, arm);
      } else {
        const retryView = experiments.retryPreflightView(experiment.id, arm, retryableJobId);
        experiment = retryView.experiment;
        binding = retryView.binding;
        audioOnly = isProgramAudioOnlyCandidate(experiment, arm);
        rawMuxPair = isRawMuxPairCandidate(experiment, arm);
      }
    } else {
      // Read-only but essential: this recomputes the frozen protocol and arm
      // hashes instead of trusting an experiment id supplied by the browser.
      binding = experiments.bindingFor(experiment.id, arm);
    }
  } catch (error) {
    response.json(unverifiableExperimentAdmissionPreflight(
      error instanceof Error ? error.message : "Das Experimentprotokoll ist nicht prüfbar.",
      { audioOnly, rawMuxPair },
    ));
    return;
  }
  try {
    const selectedRequest = generationRequestSchema.parse(structuredClone(
      experiment.arms[arm === "baseline" ? 0 : 1].request,
    ));
    if (!qualificationHoldForRequest(selectedRequest)) {
      verifyNativeRuntimeSource(selectedRequest, rendererPythonExecutable);
    }
    await assertPositivePromptEnvironmentMatchesBaseline(
      experiment,
      arm,
      selectedRequest,
      buildCommand(selectedRequest),
    );
    const outputEvidence = audioOnly
      ? inspectReadOnlyOutput(experiment.arms[0].request.outputName)
      : { outputs: [], reusableCandidates: [] };
    response.json(await experimentAdmissionPreflight(experiment, arm, {
      binding,
      outputs: outputEvidence.outputs,
      reusableCandidates: outputEvidence.reusableCandidates,
      verifyRawMuxPairAuthority: rawMuxPair
        ? (selectedRequest, selectedBinding) =>
            jobs.inspectRawMuxPairCandidateAuthority(selectedRequest, selectedBinding)
        : undefined,
    }));
  } catch (error) {
    response.json(unverifiableExperimentAdmissionPreflight(
      error instanceof Error ? error.message : "Die aktuelle Baseline-Evidenz ist nicht lesbar.",
      { audioOnly, rawMuxPair },
    ));
  }
});

app.post("/api/experiments/:id/runs/:arm", async (request, response) => {
  const arm = z.enum(["baseline", "candidate"]).parse(request.params.arm);
  const storedExperiment = experiments.get(request.params.id);
  if (!storedExperiment) throw new ExperimentConflictError("Experiment nicht gefunden.");
  const storedArm = storedExperiment.arms[arm === "baseline" ? 0 : 1];
  if (storedArm.jobId) jobs.assertJobMutationAllowed(storedArm.jobId);
  const preReleaseRequest = generationRequestSchema.parse(structuredClone(
    storedArm.request,
  ));
  const qualificationHold = qualificationHoldForRequest(preReleaseRequest);
  if (qualificationHold) throw new ExperimentConflictError(qualificationHold.reason);
  if (arm === "candidate") {
    const baselineJobId = storedExperiment.arms[0].jobId;
    if (baselineJobId) jobs.assertJobMutationAllowed(baselineJobId);
    const baseline = baselineJobId ? jobs.get(baselineJobId) : null;
    const baselineOutput = baselineJobId
      ? outputs.list(jobs.outputAuthorityList())
        .find((output) => outputVerifiesExperimentBaseline(output, storedExperiment))
      : null;
    const verifiedBaselineJob = baseline?.status === "completed"
      && Boolean(baseline.runProvenance?.verifiedAt)
      && baseline.runProvenance?.fingerprint.length === 64
      && runProvenanceFingerprintMatches(baseline.runProvenance);
    const rawOutputExperiment = storedExperiment.candidate.variable
      === "lipforcing-raw-output-profile";
    const positivePromptExperiment = storedExperiment.candidate.variable === "positive-prompt";
    const immutableBaselineImage = rawOutputExperiment
      ? lipForcingImageIdentity(baseline?.runProvenance?.containerImages)
      : null;
    if ((rawOutputExperiment && (!verifiedBaselineJob || !immutableBaselineImage))
      || (positivePromptExperiment && (!verifiedBaselineJob || !baselineOutput))
      || (!rawOutputExperiment && !positivePromptExperiment && !verifiedBaselineJob && !baselineOutput)) {
      throw new ExperimentConflictError(
        rawOutputExperiment
          ? "Der Rohvideo-Kandidat benötigt einen frisch abgeschlossenen Baseline-Lauf mit verifizierter unveränderlicher LipForcing-Containeridentität."
          : positivePromptExperiment
            ? "Der Prompt-Kandidat benötigt einen frisch abgeschlossenen Baseline-Lauf samt unveränderter, verifizierter Videoausgabe und Laufprovenienz."
            : "Der gebundene Baseline-Lauf muss vollständig abgeschlossen und mit verifizierter Laufprovenienz belegt sein.",
      );
    }
  }
  let failedJobId: string | null = null;
  let experiment = storedExperiment;
  let binding: ReturnType<typeof experiments.bindingFor>;
  if (storedArm.jobId) {
    failedJobId = await inspectRetryableExperimentArm(
      storedExperiment,
      arm,
      experimentRetryReadDeps(),
    );
    if (!failedJobId) {
      // Preserve the canonical active/completed-arm conflict message.
      binding = experiments.bindingFor(storedExperiment.id, arm);
    } else {
      const retryView = experiments.retryPreflightView(storedExperiment.id, arm, failedJobId);
      experiment = retryView.experiment;
      binding = retryView.binding;
    }
  } else {
    binding = experiments.bindingFor(storedExperiment.id, arm);
  }
  const selected = experiment.arms[arm === "baseline" ? 0 : 1];
  const exactAdoptedRefinerRun = arm === "candidate"
    && experiment.baselineEvidence !== null
    && experiment.candidate.variable === "lipforcing-enabled"
    && experiment.changedRequestPaths.length === 1
    && experiment.changedRequestPaths[0] === "postprocess.lipForcing.enabled";
  const selectedRequest = generationRequestSchema.parse(structuredClone(selected.request));
  verifyNativeRuntimeSource(selectedRequest, rendererPythonExecutable);
  const plan = buildCommand(selectedRequest);
  const requiredAssetIds = exactAdoptedRefinerRun
    ? []
    : requiredOfficialSpeechAssetIds(selectedRequest);
  const inventory = requiredAssetIds.length > 0
    ? await getModelInventory(false, requiredAssetIds)
    : undefined;
  const planErrors = validateRequestPlan(selectedRequest, plan, inventory, {
    enforceOfficialAssets: !exactAdoptedRefinerRun,
  });
  if (planErrors.length > 0) {
    throw new ExperimentConflictError(`Experimentarm kann nicht gestartet werden: ${planErrors.join(" ")}`);
  }
  await assertPositivePromptEnvironmentMatchesBaseline(
    experiment,
    arm,
    selectedRequest,
    plan,
  );
  const job = jobs.create(selectedRequest, {
    variantOf: arm === "candidate" ? experiment.arms[0].jobId : null,
    experiment: binding,
    deferStart: true,
  });
  let updated: ControlledExperiment;
  try {
    updated = failedJobId
      ? experiments.replaceArmJobForRetry(experiment.id, arm, failedJobId, job.id)
      : experiments.attachJob(experiment.id, arm, job.id);
  } catch (error) {
    let armBoundOrCommitUncertain = true;
    try {
      const current = experiments.get(experiment.id);
      armBoundOrCommitUncertain = current != null
        && current.arms[arm === "baseline" ? 0 : 1].jobId === job.id;
    } catch {
      // A failed post-rename directory fsync cannot prove whether the CAS will
      // survive power loss. Keep the never-armed job as an interrupted audit
      // record; either possible experiment version then reconciles safely.
    }
    if (armBoundOrCommitUncertain) {
      try {
        jobs.interruptDeferredStart(
          job.id,
          "Die Experiment-Armbindung konnte nicht dauerhaft bestätigt werden; der vorbereitete Job wurde vor dem Start unterbrochen.",
        );
      } catch {
        // The persisted startDeferred fence remains the final fail-closed
        // authority even when terminal-state persistence is unavailable.
      }
    } else {
      try {
        jobs.cancel(job.id);
        jobs.removeDetachedDeferredExperimentJob(job.id);
      } catch {
        // A deferred job has no process or remote lease. If an unexpected
        // invariant prevents removal, its durable start fence remains safer
        // than hiding the original attach failure.
      }
    }
    throw error;
  }
  try {
    if (!jobs.startQueued(job.id)) {
      throw new JobConflictError(
        "Der vorbereitete Experimentjob konnte nach der dauerhaften Armbindung nicht gestartet werden.",
      );
    }
  } catch (error) {
    // The experiment CAS already committed. Keep the terminal job record bound
    // so the normal, audited retry path can recover it; removing it here would
    // leave a durable arm pointing at a vanished job.
    try {
      jobs.interruptDeferredStart(
        job.id,
        "Die dauerhafte Startfreigabe des gebundenen Experimentjobs ist fehlgeschlagen; der Job wurde vor der Ausführung unterbrochen.",
      );
    } catch {
      // If persistence itself is unavailable, the durable prepare fence from
      // create() still prevents execution and survives a restart fail-closed.
    }
    throw error;
  }
  response.status(202).json({
    experiment: toPublicControlledExperiment(updated),
    job: toPublicStudioJob(job),
  });
});

app.post("/api/estimates", (request, response) => {
  const payload = generationRequestSchema.parse(request.body);
  response.json(estimateRequest(payload, jobs.list()));
});

app.post("/api/admission/preflight", async (request, response) => {
  const payload = generationRequestSchema.parse(request.body);
  if (!qualificationHoldForRequest(payload)) {
    verifyNativeRuntimeSource(payload, rendererPythonExecutable);
  }
  response.json(await admissionPreflight(payload));
});

app.post("/api/jobs", (request, response) => {
  const payload = withOfficialSpeechModelPaths(generationRequestSchema.parse(request.body));
  verifyNativeRuntimeSource(payload, rendererPythonExecutable);
  response.status(202).json({ job: toPublicStudioJob(jobs.create(payload)) });
});

app.post("/api/jobs/:id/cancel", (request, response) => {
  const job = jobs.cancel(request.params.id);
  if (!job) return response.status(404).json({ error: "Job nicht gefunden." });
  response.json({ job: toPublicStudioJob(job) });
});

app.post("/api/jobs/:id/rerun", (request, response) => {
  const payload = z.object({ mode: z.enum(["exact", "random-seed"]) }).strict().parse(request.body);
  const source = jobs.get(request.params.id);
  if (!source) return response.status(409).json({ error: "Job kann in seinem aktuellen Zustand nicht neu gestartet werden." });
  jobs.assertJobMutationAllowed(request.params.id);
  verifyNativeRuntimeSource(source.request, rendererPythonExecutable);
  const job = jobs.rerun(request.params.id, payload.mode);
  if (!job) return response.status(409).json({ error: "Job kann in seinem aktuellen Zustand nicht neu gestartet werden." });
  response.status(202).json({ job: toPublicStudioJob(job) });
});

app.patch("/api/jobs/:id", (request, response) => {
  const payload = z.object({ favorite: z.boolean() }).strict().parse(request.body);
  const job = jobs.setFavorite(request.params.id, payload.favorite);
  if (!job) return response.status(404).json({ error: "Job nicht gefunden." });
  response.json({ job: toPublicStudioJob(job) });
});

app.delete("/api/jobs/:id", (request, response) => {
  const job = jobs.remove(request.params.id);
  if (!job) return response.status(404).json({ error: "Job nicht gefunden." });
  response.json({ deleted: toPublicStudioJob(job) });
});

app.get("/api/jobs/:id/output", (request, response, next) => {
  const job = jobs.get(request.params.id);
  if (!job || job.status !== "completed") return response.status(404).json({ error: "Ausgabe nicht verfügbar." });
  const lease = outputs.openReadableOutput(job.outputName, jobs.outputAuthorityList(), job.id);
  if (!lease) return response.status(404).json({ error: "Ausgabe nicht verfügbar." });
  sendHeldPublishedOutput(response, next, lease, job.outputName);
});

app.get("/api/outputs/:filename", (request, response, next) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  const lease = outputs.openReadableOutput(filename, jobs.outputAuthorityList());
  if (!lease) return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  sendHeldPublishedOutput(response, next, lease, filename);
});

app.delete("/api/outputs/:filename", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  jobs.assertOutputDeletionAllowed(filename);
  if (analyses.isActive(filename) || t2aAudioAnalyses.isActive(filename)) {
    return response.status(409).json({
      error: "Die objektive Analyse dieser Ausgabe läuft noch. Analyse zuerst abbrechen.",
    });
  }
  const audioAnalysisPath = t2aAudioAnalysisPath(outputRoot, filename);
  const hadAudioAnalysis = isT2aAudioOutputName(filename) && existsSync(audioAnalysisPath);
  const deleted = deleteOutputWithT2aAudioCleanup(
    filename,
    isT2aAudioOutputName(filename),
    hadAudioAnalysis,
    () => removeT2aAudioAnalysis(outputRoot, filename),
    () => outputs.delete(filename, jobs.outputAuthorityList()),
  );
  response.json({ deleted });
});

app.put("/api/outputs/:filename/quality-review", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  jobs.assertOutputMutationAllowed(filename);
  const payload = qualityReviewInputSchema.parse(request.body);
  const output = outputs.setQualityReview(filename, payload, jobs.outputAuthorityList());
  response.json(publicStudioOutputResponse(output));
});

app.get("/api/outputs/:filename/analysis", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  if (isT2aAudioOutputName(filename)) {
    return response.json(publicT2aAudioAnalysisResponse(t2aAudioAnalyses.get(filename)));
  }
  response.json(publicOutputAnalysisResponse(analyses.get(filename)));
});

app.post("/api/outputs/:filename/analysis", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  jobs.assertOutputMutationAllowed(filename);
  const payload = z.object({ force: z.boolean().default(false) }).strict().parse(request.body ?? {});
  if (isT2aAudioOutputName(filename)) {
    const analysis = startT2aAudioAnalysis(filename, payload.force);
    return response.status(["queued", "running"].includes(analysis.status) ? 202 : 200)
      .json(publicT2aAudioAnalysisResponse(analysis));
  }
  const analysis = analyses.start(filename, payload.force);
  response.status(["queued", "running"].includes(analysis.status) ? 202 : 200)
    .json(publicOutputAnalysisResponse(analysis));
});

app.post("/api/outputs/:filename/analysis/cancel", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  jobs.assertOutputMutationAllowed(filename);
  const payload = z.object({ analysisId: z.string().uuid() }).strict().parse(request.body ?? {});
  if (isT2aAudioOutputName(filename)) {
    const analysis = t2aAudioAnalyses.cancel(filename, payload.analysisId);
    if (!analysis) return response.status(404).json({ error: "Keine objektive Analyse vorhanden." });
    return response.json(publicT2aAudioAnalysisResponse(analysis));
  }
  const analysis = analyses.cancel(filename, payload.analysisId);
  if (!analysis) return response.status(404).json({ error: "Keine objektive Analyse vorhanden." });
  response.json(publicOutputAnalysisResponse(analysis));
});

app.get("/api/events", (request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  studioEventStreams.add(response);
  let closed = false;
  let heartbeat: NodeJS.Timeout | null = null;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    studioEventStreams.delete(response);
    if (heartbeat) clearInterval(heartbeat);
    jobs.off("changed", onChange);
  };
  const closeIfBlindLocked = (): boolean => {
    let locked = true;
    try {
      locked = blindEvaluations.hasActiveSession();
    } catch {
      // A corrupt cross-process lock is also a fail-closed global lock.
    }
    if (!locked) return false;
    try {
      response.write("event: blind-scope-lock\ndata: {}\n\n");
      response.end();
    } finally {
      cleanup();
    }
    return true;
  };
  const send = (value: readonly StudioJob[]) => {
    if (!closeIfBlindLocked()) {
      response.write(`event: jobs\ndata: ${JSON.stringify(toPublicStudioJobs(value))}\n\n`);
    }
  };
  const onChange = (value: StudioJob[]) => send(value);
  heartbeat = setInterval(() => {
    if (!closeIfBlindLocked()) response.write(": heartbeat\n\n");
  }, 1_000);
  jobs.on("changed", onChange);
  send(jobs.list());
  request.on("close", cleanup);
});

app.use("/api", (_request, response) => response.status(404).json({ error: "API-Endpunkt nicht gefunden." }));

const distRoot = join(appRoot, "dist");
app.use(express.static(distRoot, { index: false, maxAge: 0 }));
app.get("/{*path}", (_request, response) => response.sendFile(join(distRoot, "index.html")));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (delegateCommittedResponseError(error, response, _next)) return;
  if (error instanceof ZodError) {
    return response.status(400).json({
      error: "Eingaben sind unvollständig oder ungültig.",
      issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  if (error instanceof multer.MulterError) {
    return response.status(400).json({ error: `Upload fehlgeschlagen: ${error.message}` });
  }
  if (error instanceof JobConflictError) {
    return response.status(409).json({ error: error.message });
  }
  if (error instanceof JobPersistenceHoldError) {
    return response.status(503).json(toPublicJobPersistenceHoldError());
  }
  if (error instanceof NativeRuntimeSourceGateError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof ExperimentConflictError) {
    return response.status(409).json({ error: error.message });
  }
  if (error instanceof BlindEvaluationConflictError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof ProjectConflictError) {
    return response.status(409).json({ error: error.message });
  }
  if (error instanceof ImageCropPreparationError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof LipDubReferencePreparationError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof SequenceAssembleError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof OutputFrameError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof SceneReferenceFrameError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof OutputQualityError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  if (sendOutputSnapshotUnavailableResponse(error, response)) return;
  if (error instanceof T2aAudioEvaluatorUnavailableError) {
    return response.status(error.statusCode).json({
      error: error.message,
      blockerCode: error.blockerCode,
      correlationId: error.correlationId,
    });
  }
  if (error instanceof OutputDeleteError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  const message = error instanceof Error ? error.message : "Unbekannter Serverfehler";
  response.status(500).json({ error: message });
});

const server = app.listen(serverPort, serverHost, () => {
  process.stdout.write(`LTX Studio API: http://${serverHost}:${serverPort}\n`);
});

let shutdownPromise: Promise<void> | null = null;
function shutdown(signal: NodeJS.Signals): void {
  if (shutdownPromise) return;
  shutdownPromise = (async () => {
    const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
    server.closeAllConnections();
    let writersStopped = false;
    try {
      const [jobShutdown] = await Promise.all([
        jobs.shutdown(15_000),
        analyses.shutdown(15_000),
        t2aAudioAnalyses.shutdown(15_000),
        serverClosed,
      ]);
      writersStopped = true;
      if (jobShutdown.remotePending > 0 || jobShutdown.localPending > 0) {
        process.exitCode = 1;
        console.error(
          `Studio-Shutdown: ${jobShutdown.localPending} lokale Prozessgruppe(n) und `
            + `${jobShutdown.remotePending} DGX-Terminalmeldung(en) bleiben zur Wiederholung vorgemerkt.`,
        );
      }
    } catch (error) {
      process.exitCode = 1;
      console.error(
        `Studio-Shutdown nach ${signal} blieb fail-closed:`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (writersStopped) {
        try {
          dataRootWriterLock.release();
        } catch (error) {
          process.exitCode = 1;
          console.error(
            "Studio-Shutdown konnte den exklusiven Data-Root-Lock nicht kontrolliert freigeben:",
            error instanceof Error ? error.message : String(error),
          );
        }
      } else {
        console.error(
          "Der exklusive Data-Root-Lock bleibt bis zum Prozessende gehalten, weil nicht alle Writer kontrolliert stoppten.",
        );
      }
    }
  })();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
