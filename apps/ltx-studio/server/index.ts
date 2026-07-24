import { randomUUID } from "node:crypto";
import { mkdirSync, unlinkSync } from "node:fs";
import { extname, join, resolve } from "node:path";

import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z, ZodError } from "zod";

import { assetKinds, type AssetKind } from "../shared/assets.js";
import { generationRequestSchema, outputNameSchema, PIPELINES } from "../shared/pipelines.js";
import { qualityReviewInputSchema } from "../shared/quality.js";
import { admissionClientAvailable } from "./admission.js";
import { AssetStore } from "./assets.js";
import { buildCommand, suggestRequestPlan, validateRequestPlan, warnRequestPlan } from "./command.js";
import {
  appRoot,
  admissionRequired,
  ensureRuntimeDirectories,
  minAvailableGiB,
  minResidualMemoryGiB,
  minSwapFreeGiB,
  outputRoot,
  pythonRuntimeAvailable,
  pythonExecutable,
  serverHost,
  serverPort,
  uploadRoot,
} from "./config.js";
import { isActiveJobStatus, JobConflictError, JobManager, type StudioJob } from "./jobs.js";
import { inspectLipDubReference } from "./lipdubDiagnostics.js";
import { LipDubReferencePreparationError, prepareLipDubReference } from "./lipdubPrep.js";
import { estimateRequest } from "./estimates.js";
import { getModelInventory } from "./models.js";
import { readOrchestratorStatus } from "./orchestrator.js";
import { OutputLibrary, OutputQualityError } from "./outputs.js";
import { OutputAnalysisManager } from "./outputAnalysis.js";
import { readResourceSnapshot } from "./system.js";
import { matchesUploadSignature } from "./uploads.js";

ensureRuntimeDirectories();
const app = express();
const jobs = new JobManager();
const assets = new AssetStore();
const outputs = new OutputLibrary(outputRoot);
const analyses = new OutputAnalysisManager(outputs, () => jobs.list());
outputs.recordCompleted(jobs.list());
jobs.on("changed", (value: StudioJob[]) => outputs.recordCompleted(value));
const allowedBrowserOrigins = new Set([
  `http://127.0.0.1:${serverPort}`,
  `http://localhost:${serverPort}`,
  "http://127.0.0.1:4317",
  "http://localhost:4317",
]);

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
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
});
const lipDubReferencePreparationRequestSchema = z.object({
  mode: z.literal("lipdub").optional(),
  width: lipDubReferenceDimensionSchema,
  height: lipDubReferenceDimensionSchema,
  lipDub: z.object({
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
    resources,
    engine: pythonRuntimeAvailable(pythonExecutable) ? "available" : "missing",
    orchestrator: admissionRequired && orchestratorReachable && admissionClientAvailable() ? "available" : admissionRequired ? "missing" : "disabled",
    qwen: runtimeStatus.qwen,
    runtimeOverall: runtimeStatus.overall,
    workloads: runtimeStatus.workloads,
    queueDepth: jobs.list().filter((job) => isActiveJobStatus(job.status)).length,
  });
});

app.get("/api/models", async (request, response) => {
  response.json(await getModelInventory(request.query.refresh === "1"));
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

app.post("/api/jobs/plan", (request, response) => {
  const payload = generationRequestSchema.parse(request.body);
  const plan = buildCommand(payload);
  response.json({
    command: plan.displayCommand,
    outputPath: plan.outputPath,
    pathErrors: validateRequestPlan(payload, plan),
    pathWarnings: warnRequestPlan(payload),
    suggestions: suggestRequestPlan(payload),
  });
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
  if (!assets.findByPath("video", payload.lipDub.referenceVideo.path)) {
    return response.status(400).json({
      error: "LipDub-Referenzvorbereitung ist nur für Videos aus der Studio-Mediathek verfügbar.",
    });
  }
  const prepared = await prepareLipDubReference(payload);
  let asset;
  try {
    asset = assets.add(prepared.file, "video");
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

app.post("/api/estimates", (request, response) => {
  const payload = generationRequestSchema.parse(request.body);
  response.json(estimateRequest(payload, jobs.list()));
});

app.post("/api/jobs", (request, response) => {
  const payload = generationRequestSchema.parse(request.body);
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

app.get("/api/jobs/:id/output", (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job || job.status !== "completed") return response.status(404).json({ error: "Ausgabe nicht verfügbar." });
  const outputPath = resolve(outputRoot, job.outputName);
  if (!outputPath.startsWith(`${resolve(outputRoot)}/`)) return response.status(400).json({ error: "Ungültiger Pfad." });
  response.type("video/mp4").sendFile(outputPath, { dotfiles: "allow" });
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
  response.type("video/mp4").sendFile(outputPath, { dotfiles: "allow" });
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
  const analysis = analyses.cancel(filename);
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
  if (error instanceof LipDubReferencePreparationError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  if (error instanceof OutputQualityError) {
    return response.status(error.statusCode).json({ error: error.message });
  }
  const message = error instanceof Error ? error.message : "Unbekannter Serverfehler";
  response.status(500).json({ error: message });
});

app.listen(serverPort, serverHost, () => {
  process.stdout.write(`LTX Studio API: http://${serverHost}:${serverPort}\n`);
});
