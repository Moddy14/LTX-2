import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z, ZodError } from "zod";

import { assetKinds, type AssetKind } from "../shared/assets.js";
import { generationRequestSchema, outputNameSchema, PIPELINES } from "../shared/pipelines.js";
import {
  experimentCreateInputSchema,
  type ControlledExperiment,
} from "../shared/experiments.js";
import { qualityReviewInputSchema } from "../shared/quality.js";
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
import { buildCommand, suggestRequestPlan, validateRequestPlan, warnRequestPlan } from "./command.js";
import {
  appRoot,
  admissionRequired,
  analysisTempRoot,
  devUiPort,
  ensureRuntimeDirectories,
  experimentRoot,
  minAvailableGiB,
  minResidualMemoryGiB,
  minSwapFreeGiB,
  outputRoot,
  pythonRuntimeAvailable,
  pythonExecutable,
  rendererPythonExecutable,
  serverHost,
  serverPort,
  uploadRoot,
} from "./config.js";
import { isActiveJobStatus, JobConflictError, JobManager, type StudioJob } from "./jobs.js";
import { inspectLipDubReference } from "./lipdubDiagnostics.js";
import { ImageCropPreparationError, prepareImageCrop } from "./imageCrop.js";
import { LipDubReferencePreparationError, prepareLipDubReference } from "./lipdubPrep.js";
import { assembleSequence, SequenceAssembleError } from "./sequenceAssemble.js";
import { extractOutputFrame, OutputFrameError } from "./outputFrame.js";
import {
  recommendSceneReferenceFrame,
  SCENE_REFERENCE_YUNET_SHA256,
  sceneReferenceFrameRecommendationSchema,
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
import { releaseRetryableExperimentArm } from "./experimentRetry.js";
import { getModelInventory } from "./models.js";
import { readOrchestratorStatus } from "./orchestrator.js";
import {
  OutputDeleteError,
  OutputLibrary,
  OutputQualityError,
} from "./outputs.js";
import {
  cleanupAnalysisTempRoot,
  OutputAnalysisManager,
  recoverPhonemeVisemeSandboxState,
} from "./outputAnalysis.js";
import { resolveIdentityEvidenceReferences, verifyIdentityEvidence } from "./inputEvidence.js";
import { captureProvenanceFile, verifyProvenanceFileEvidence } from "./runProvenance.js";
import { readResourceSnapshot } from "./system.js";
import { matchesUploadSignature } from "./uploads.js";
import { PhonemeVisemeEvaluatorStateProvider } from "./evaluatorStateProvider.js";
import { shouldAutoAnalyzeCompletedJob } from "./autoAnalysis.js";
import { releaseIdentity } from "./releaseIdentity.js";

ensureRuntimeDirectories();
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
const outputs = new OutputLibrary(outputRoot);
jobs.wireReusableBaseSource(outputs);
const experiments = new ExperimentStore(experimentRoot);
const phonemeVisemeEvaluatorStates = new PhonemeVisemeEvaluatorStateProvider();
experiments.reconcileJobs(jobs.list());
const analyses = new OutputAnalysisManager(outputs, () => jobs.list(), outputRoot, {
  identityReferenceResolver: (evidence) => resolveIdentityEvidenceReferences(evidence, assets),
  identityEvidenceVerifier: async (evidence) => (await verifyIdentityEvidence(evidence, assets)).error,
  phonemeVisemeEvaluatorStateResolver: () => phonemeVisemeEvaluatorStates.get(),
});
outputs.recordCompleted(jobs.list());
const observedJobStatuses = new Map(jobs.list().map((job) => [job.id, job.status]));
jobs.on("changed", (value: StudioJob[]) => {
  outputs.recordCompleted(value);
  for (const job of value) {
    const previousStatus = observedJobStatuses.get(job.id);
    observedJobStatuses.set(job.id, job.status);
    if (!shouldAutoAnalyzeCompletedJob(previousStatus, job)) continue;
    try {
      analyses.start(job.outputName);
    } catch (error) {
      console.error(
        `Automatische Qualitätsanalyse für ${job.outputName} konnte nicht gestartet werden:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
});
const allowedBrowserOrigins = new Set([
  `http://127.0.0.1:${serverPort}`,
  `http://localhost:${serverPort}`,
  `http://127.0.0.1:${devUiPort}`,
  `http://localhost:${devUiPort}`,
]);

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

async function releaseRetryableArm(
  experiment: ControlledExperiment,
  arm: "baseline" | "candidate",
): Promise<ControlledExperiment> {
  return releaseRetryableExperimentArm(experiment, arm, {
    getJob: (jobId) => {
      const job = jobs.get(jobId);
      return job ? { status: job.status, dgxJobId: job.dgxJobId } : undefined;
    },
    hasVerifiedArmOutput: (boundExperiment, boundArm) =>
      outputs.list(jobs.list()).some((output) =>
        outputVerifiesExperimentArmRun(output, boundExperiment, boundArm)),
    listRemoteJobs: listQueueJobs,
    releaseArm: (experimentId, armToRelease, previousJobId) =>
      experiments.releaseArmForRetry(experimentId, armToRelease, previousJobId),
  });
}

app.disable("x-powered-by");
app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin) {
    if (!allowedBrowserOrigins.has(origin)) {
      return response.status(403).json({ error: "Nur die lokale Studio-Oberfläche darf Browser-Anfragen senden." });
    }
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
  response.json({
    state: resources.outputFreeGiB !== null ? "ready" : "blocked",
    release: releaseIdentity,
    resources,
    engine: pythonRuntimeAvailable(rendererPythonExecutable, { isolated: true }) ? "available" : "missing",
    analysisEngine: pythonRuntimeAvailable(pythonExecutable) ? "available" : "missing",
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
    },
    queueDepth: jobs.list().filter((job) => isActiveJobStatus(job.status)).length,
  });
});

app.get("/api/models", async (request, response) => {
  response.json(await getModelInventory(
    request.query.refresh === "1",
    request.query.verify === "1" ? recommendedModelAssets.map((asset) => asset.id) : [],
  ));
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
  response.status(201).json(asset);
});

app.get("/api/assets", (request, response) => {
  const rawKind = typeof request.query.kind === "string" ? request.query.kind : undefined;
  if (rawKind && !assetKinds.includes(rawKind as AssetKind)) {
    return response.status(400).json({ error: "Unbekannter Medientyp." });
  }
  response.json({ assets: assets.list(rawKind as AssetKind | undefined) });
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
  response.status(201).json({
    asset,
    source: prepared.source,
    crop: prepared.crop,
    target: prepared.target,
    scaleFilter: prepared.scaleFilter,
    command: prepared.command,
  });
});

app.post("/api/jobs/plan", async (request, response) => {
  const payload = withOfficialSpeechModelPaths(generationRequestSchema.parse(request.body));
  const plan = buildCommand(payload);
  const requiredAssetIds = requiredOfficialSpeechAssetIds(payload);
  const inventory = requiredAssetIds.length > 0
    ? await getModelInventory(false, requiredAssetIds)
    : undefined;
  response.json({
    command: plan.displayCommand,
    outputPath: plan.outputPath,
    pathErrors: validateRequestPlan(payload, plan, inventory),
    pathWarnings: warnRequestPlan(payload),
    suggestions: suggestRequestPlan(payload),
  });
});

app.post("/api/images/from-output", async (request, response) => {
  const payload = outputFrameRequestSchema.parse(request.body);
  // Herkunft vor dem Griff binden und danach prüfen: Ändert sich die Ausgabe
  // währenddessen, ist der Frame nicht mehr das, was er zu sein vorgibt.
  const source = await captureProvenanceFile(
    join(outputRoot, payload.output), `output-frame-source:${payload.output}`);
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
  const recommendation = payload.strategy
    ? await recommendSceneReferenceFrame(join(outputRoot, payload.output), {
        script: recommendationScriptPath,
        faceModel: recommendationModelPath,
      })
    : null;
  const atSeconds = payload.atSeconds ?? recommendation?.atSeconds;
  if (atSeconds === undefined) {
    throw new OutputFrameError("Kein gültiger Referenzzeitpunkt ermittelt.", 500);
  }
  const extracted = await extractOutputFrame({ output: payload.output, atSeconds }, outputRoot);
  const changedSource = verifyProvenanceFileEvidence(source);
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
  const publicRecommendation = recommendation ? {
    schemaVersion: recommendation.schemaVersion,
    atSeconds: recommendation.atSeconds,
    score: recommendation.score,
    sampledFrames: recommendation.sampledFrames,
    eligibleFrames: recommendation.eligibleFrames,
    metrics: recommendation.metrics,
    candidates: recommendation.candidates,
  } : null;
  response.status(201).json({
    asset,
    frame: extracted,
    recommendation: publicRecommendation
      ? sceneReferenceFrameRecommendationSchema.parse(publicRecommendation)
      : null,
  });
});

app.post("/api/sequences/assemble", async (request, response) => {
  const payload = sequenceAssembleRequestSchema.parse(request.body);
  // Provenienz jedes Shots vor dem Schnitt binden. Verändert sich ein Shot
  // während der Montage, wird das Ergebnis verworfen - dieselbe fail-closed
  // Regel wie beim Bildzuschnitt und bei der LipDub-Vorbereitung.
  const sourceNames = payload.outputs.map((entry) => typeof entry === "string" ? entry : entry.output);
  const sources = await Promise.all(sourceNames.map((outputName, index) =>
    captureProvenanceFile(join(outputRoot, outputName), `sequence-shot:${index}:${outputName}`)));
  const prepared = await assembleSequence(payload, outputRoot);
  const changed = sources.map((source) => verifyProvenanceFileEvidence(source)).find(Boolean);
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
  response.status(201).json({ asset, shots: prepared.shots, target: prepared.target });
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
  response.status(201).json({
    asset,
    target: prepared.target,
    trim: prepared.trim,
    command: prepared.command,
  });
});

app.get("/api/jobs", (_request, response) => response.json({ jobs: jobs.list() }));
app.get("/api/outputs", (_request, response) => response.json({ outputs: outputs.list(jobs.list()) }));
app.get("/api/experiments", (_request, response) => response.json(experiments.listAvailable()));

app.post("/api/experiments", (request, response) => {
  let payload = experimentCreateInputSchema.parse(request.body);
  let baselineEvidence = null;
  if (payload.baselineOutputName) {
    const output = outputs.list(jobs.list()).find((item) => item.name === payload.baselineOutputName);
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
  response.status(201).json({ experiment: experiments.create(payload, undefined, baselineEvidence) });
});

app.post("/api/experiments/:id/freeze", (request, response) => {
  response.json({ experiment: experiments.freeze(request.params.id) });
});

app.post("/api/experiments/:id/supersede", (request, response) => {
  const payload = z.object({
    reason: z.string().trim().min(1).max(500),
    replacementExperimentId: z.string().uuid().nullable().default(null),
  }).strict().parse(request.body ?? {});
  response.json({
    experiment: experiments.supersede(
      request.params.id,
      payload.reason,
      payload.replacementExperimentId,
    ),
  });
});

app.post("/api/experiments/:id/runs/:arm", async (request, response) => {
  const arm = z.enum(["baseline", "candidate"]).parse(request.params.arm);
  let experiment = experiments.get(request.params.id);
  if (!experiment) throw new ExperimentConflictError("Experiment nicht gefunden.");
  experiment = await releaseRetryableArm(experiment, arm);
  const selected = experiment.arms[arm === "baseline" ? 0 : 1];
  const exactAdoptedRefinerRun = arm === "candidate"
    && experiment.baselineEvidence !== null
    && experiment.candidate.variable === "lipforcing-enabled"
    && experiment.changedRequestPaths.length === 1
    && experiment.changedRequestPaths[0] === "postprocess.lipForcing.enabled";
  const selectedRequest = generationRequestSchema.parse(structuredClone(selected.request));
  if (arm === "candidate") {
    const baselineJobId = experiment.arms[0].jobId;
    const baseline = baselineJobId ? jobs.get(baselineJobId) : null;
    const baselineOutput = baselineJobId
      ? outputs.list(jobs.list()).find((output) => outputVerifiesExperimentBaseline(output, experiment))
      : null;
    const verifiedBaselineJob = baseline?.status === "completed"
      && Boolean(baseline.runProvenance?.verifiedAt)
      && baseline.runProvenance?.fingerprint.length === 64;
    if (!verifiedBaselineJob && !baselineOutput) {
      throw new ExperimentConflictError(
        "Der gebundene Baseline-Lauf muss vollständig abgeschlossen und mit verifizierter Laufprovenienz belegt sein.",
      );
    }
  }
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
  const binding = experiments.bindingFor(experiment.id, arm);
  const job = jobs.create(selectedRequest, {
    variantOf: arm === "candidate" ? experiment.arms[0].jobId : null,
    experiment: binding,
    deferStart: true,
  });
  try {
    const updated = experiments.attachJob(experiment.id, arm, job.id);
    jobs.startQueued(job.id);
    response.status(202).json({ experiment: updated, job });
  } catch (error) {
    jobs.cancel(job.id);
    throw error;
  }
});

app.post("/api/estimates", (request, response) => {
  const payload = generationRequestSchema.parse(request.body);
  response.json(estimateRequest(payload, jobs.list()));
});

app.post("/api/admission/preflight", async (request, response) => {
  const payload = generationRequestSchema.parse(request.body);
  response.json(await admissionPreflight(payload));
});

app.post("/api/jobs", (request, response) => {
  const payload = withOfficialSpeechModelPaths(generationRequestSchema.parse(request.body));
  response.status(202).json({ job: jobs.create(payload) });
});

app.post("/api/jobs/:id/cancel", (request, response) => {
  const job = jobs.cancel(request.params.id);
  if (!job) return response.status(404).json({ error: "Job nicht gefunden." });
  response.json({ job });
});

app.post("/api/jobs/:id/rerun", (request, response) => {
  const payload = z.object({ mode: z.enum(["exact", "random-seed"]) }).strict().parse(request.body);
  const job = jobs.rerun(request.params.id, payload.mode);
  if (!job) return response.status(409).json({ error: "Job kann in seinem aktuellen Zustand nicht neu gestartet werden." });
  response.status(202).json({ job });
});

app.patch("/api/jobs/:id", (request, response) => {
  const payload = z.object({ favorite: z.boolean() }).strict().parse(request.body);
  const job = jobs.setFavorite(request.params.id, payload.favorite);
  if (!job) return response.status(404).json({ error: "Job nicht gefunden." });
  response.json({ job });
});

app.delete("/api/jobs/:id", (request, response) => {
  const job = jobs.remove(request.params.id);
  if (!job) return response.status(404).json({ error: "Job nicht gefunden." });
  response.json({ deleted: job });
});

app.get("/api/jobs/:id/output", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job || job.status !== "completed") return response.status(404).json({ error: "Ausgabe nicht verfügbar." });
  const outputPath = resolve(outputRoot, job.outputName);
  if (!outputPath.startsWith(`${resolve(outputRoot)}/`)) return response.status(400).json({ error: "Ungültiger Pfad." });
  response.sendFile(outputPath, { dotfiles: "allow" });
});

app.get("/api/outputs/:filename", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  const outputPath = resolve(outputRoot, filename);
  if (!outputPath.startsWith(`${resolve(outputRoot)}/`)) {
    return response.status(400).json({ error: "Ungültiger Pfad." });
  }
  response.sendFile(outputPath, { dotfiles: "allow" });
});

app.delete("/api/outputs/:filename", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  if (analyses.isActive(filename)) {
    return response.status(409).json({
      error: "Die objektive Analyse dieses Videos läuft noch. Analyse zuerst abbrechen.",
    });
  }
  response.json({ deleted: outputs.delete(filename, jobs.list()) });
});

app.put("/api/outputs/:filename/quality-review", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  const payload = qualityReviewInputSchema.parse(request.body);
  const output = outputs.setQualityReview(filename, payload, jobs.list());
  response.json({ output });
});

app.get("/api/outputs/:filename/analysis", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  response.json({ analysis: analyses.get(filename) });
});

app.post("/api/outputs/:filename/analysis", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  const payload = z.object({ force: z.boolean().default(false) }).strict().parse(request.body ?? {});
  const analysis = analyses.start(filename, payload.force);
  response.status(["queued", "running"].includes(analysis.status) ? 202 : 200).json({ analysis });
});

app.post("/api/outputs/:filename/analysis/cancel", (request, response) => {
  const filename = routeParam(request.params.filename);
  if (!outputNameSchema.safeParse(filename).success) {
    return response.status(404).json({ error: "Ausgabe nicht gefunden." });
  }
  const payload = z.object({ analysisId: z.string().uuid() }).strict().parse(request.body ?? {});
  const analysis = analyses.cancel(filename, payload.analysisId);
  if (!analysis) return response.status(404).json({ error: "Keine objektive Analyse vorhanden." });
  response.json({ analysis });
});

app.get("/api/events", (request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  const send = (value: unknown) => response.write(`event: jobs\ndata: ${JSON.stringify(value)}\n\n`);
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  const onChange = (value: unknown) => send(value);
  jobs.on("changed", onChange);
  send(jobs.list());
  request.on("close", () => {
    clearInterval(heartbeat);
    jobs.off("changed", onChange);
  });
});

app.use("/api", (_request, response) => response.status(404).json({ error: "API-Endpunkt nicht gefunden." }));

const distRoot = join(appRoot, "dist");
app.use(express.static(distRoot, { index: false, maxAge: 0 }));
app.get("/{*path}", (_request, response) => response.sendFile(join(distRoot, "index.html")));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  void _next;
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
  if (error instanceof ExperimentConflictError) {
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
  const shutdownTimeoutMs = 20_000;
  const forcedExit = setTimeout(() => {
    console.error(`Studio-Shutdown nach ${signal} überschritt ${shutdownTimeoutMs / 1_000} Sekunden; Prozess wird beendet.`);
    process.exit(1);
  }, shutdownTimeoutMs);
  shutdownPromise = (async () => {
    let cleanupFinished = false;
    server.close();
    server.closeAllConnections();
    try {
      const [jobShutdown] = await Promise.all([
        jobs.shutdown(15_000),
        analyses.shutdown(15_000),
      ]);
      if (jobShutdown.remotePending > 0 || jobShutdown.localPending > 0) {
        process.exitCode = 1;
        console.error(
          `Studio-Shutdown: ${jobShutdown.localPending} lokale Prozessgruppe(n) und `
            + `${jobShutdown.remotePending} DGX-Terminalmeldung(en) bleiben zur Wiederholung vorgemerkt.`,
        );
      }
      cleanupFinished = jobShutdown.remotePending === 0 && jobShutdown.localPending === 0;
    } catch (error) {
      process.exitCode = 1;
      console.error(
        `Studio-Shutdown nach ${signal} blieb fail-closed:`,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (cleanupFinished) clearTimeout(forcedExit);
    }
  })();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
