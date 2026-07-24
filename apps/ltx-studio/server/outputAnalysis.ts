import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  objectiveWorkerResultSchema,
  type ObjectiveQualityAnalysis,
  type ObjectiveWorkerResult,
  type OutputAnalysisRecord,
} from "../shared/objectiveQuality.js";
import type { StudioJob } from "./jobs.js";
import {
  readOutputAnalysis,
  recoverInterruptedOutputAnalyses,
  writeOutputAnalysis,
  type OutputRevision,
} from "./analysisStore.js";
import {
  analysisTempRoot as defaultAnalysisTempRoot,
  appRoot,
  outputRoot,
  pythonExecutable as defaultPythonExecutable,
} from "./config.js";
import {
  type IdentityInputEvidence,
  type ResolvedIdentityReference,
} from "./inputEvidence.js";
import { OutputLibrary, OutputQualityError, type OutputAnalysisTarget } from "./outputs.js";

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const ANALYSIS_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 2_000;
const CURRENT_IDENTITY_MODEL_SHA256 = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79";
const CURRENT_IDENTITY_MODEL_REVISION = "3d7082438a6e4551e840c9b2bb60b71e8da4b524";
const CURRENT_IDENTITY_PREPROCESSING = "yunet5-aligncrop-112-track.v2";

type OutputAnalysisManagerOptions = {
  pythonExecutable?: string;
  workerScript?: string;
  faceModel?: string;
  identityModel?: string;
  identityReferenceResolver?: (evidence: IdentityInputEvidence | null) => ResolvedIdentityReference[];
  identityEvidenceVerifier?: (evidence: IdentityInputEvidence) => Promise<string | null>;
  analysisTempRoot?: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
};

type AnalysisTask = {
  target: OutputAnalysisTarget;
  record: Extract<OutputAnalysisRecord, { schemaVersion: "ltx-studio-output-analysis.v3" }>;
};

function analysisWasCancelled(task: AnalysisTask): boolean {
  return task.record.status === "cancelled";
}

function completedAnalysisIsCurrent(record: OutputAnalysisRecord): boolean {
  if (record.status !== "completed"
    || record.schemaVersion !== "ltx-studio-output-analysis.v3"
    || record.result?.schemaVersion !== "ltx-studio-objective-quality.v3") return false;
  const identity = record.result.identity;
  if (["not-applicable", "reference-provenance-missing"].includes(identity.status)) return true;
  return identity.modelSha256 === CURRENT_IDENTITY_MODEL_SHA256
    && identity.modelRevision === CURRENT_IDENTITY_MODEL_REVISION
    && identity.preprocessingVersion === CURRENT_IDENTITY_PREPROCESSING;
}

export function cleanupAnalysisTempRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith("analysis-")) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
  }
}

function now(): string {
  return new Date().toISOString();
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function revisionOf(target: OutputAnalysisTarget): OutputRevision {
  return {
    sizeBytes: target.sizeBytes,
    modifiedAtMs: target.modifiedAtMs,
    changedAtMs: target.changedAtMs,
    fileId: target.fileId,
    jobId: target.jobId,
  };
}

export function buildObjectiveQualityAnalysis(
  input: ObjectiveWorkerResult,
  createdAt = now(),
): Extract<ObjectiveQualityAnalysis, { schemaVersion: "ltx-studio-objective-quality.v3" }> {
  const worker = objectiveWorkerResultSchema.parse(input);
  const findings: ObjectiveQualityAnalysis["findings"] = [];
  if (worker.technical.hasAudio !== true) {
    findings.push({
      code: "audio-missing",
      level: "error",
      message: "Die Ausgabe enthält keine verlässlich erkennbare Audiospur.",
    });
  }
  if (worker.technical.constantFrameRate === false) {
    findings.push({
      code: "variable-frame-rate",
      level: "warning",
      message: "Die Ausgabe hat keine konsistente konstante Bildrate.",
    });
  } else if (worker.technical.constantFrameRate === null) {
    findings.push({
      code: "frame-rate-unverified",
      level: "warning",
      message: "Eine konstante Bildrate konnte nicht verlässlich bestätigt werden.",
    });
  }
  if ((worker.technical.audioVideoStartDeltaSeconds ?? 0) > 0.04) {
    findings.push({
      code: "audio-video-start-drift",
      level: "warning",
      message: `Audio und Video starten ${(worker.technical.audioVideoStartDeltaSeconds! * 1_000).toFixed(0)} ms versetzt.`,
    });
  }
  if ((worker.technical.audioVideoDurationDeltaSeconds ?? 0) > 0.04) {
    findings.push({
      code: "audio-video-duration-drift",
      level: "warning",
      message: `Audio- und Videodauer unterscheiden sich um ${(worker.technical.audioVideoDurationDeltaSeconds! * 1_000).toFixed(0)} ms.`,
    });
  }
  if (worker.face.detectionCoverage < 0.9) {
    findings.push({
      code: "face-detection-incomplete",
      level: worker.face.detectionCoverage < 0.5 ? "error" : "warning",
      message: `Das Gesicht wurde in ${(worker.face.detectionCoverage * 100).toFixed(0)} % der Stichproben erkannt.`,
    });
  }
  if (worker.face.geometryCoverage < 0.8) {
    findings.push({
      code: "landmark-geometry-incomplete",
      level: worker.face.geometryCoverage < 0.5 ? "error" : "warning",
      message: `Verwertbare Gesichtsgeometrie lag in ${(worker.face.geometryCoverage * 100).toFixed(0)} % der Stichproben vor.`,
    });
  }
  if (worker.identity.status === "measured") {
    if (worker.identity.outputCoverage < 0.8) {
      findings.push({
        code: "identity-coverage-incomplete",
        level: worker.identity.outputCoverage < 0.5 ? "error" : "warning",
        message: `SFace konnte die gebundene Identität in ${(worker.identity.outputCoverage * 100).toFixed(0)} % der Stichproben vergleichen.`,
      });
    }
    findings.push({
      code: "identity-calibration-required",
      level: "info",
      message: "SFace-Ähnlichkeiten sind echte Rohmessungen, aber noch kein kalibrierter 0-bis-10-Identitätsscore.",
    });
  } else if (worker.identity.status === "reference-provenance-missing") {
    findings.push({
      code: "identity-reference-provenance-missing",
      level: "info",
      message: "Diese Ausgabe besitzt keine während der Generierung verifizierte Identitätsreferenz.",
    });
  } else if (worker.identity.status === "insufficient") {
    findings.push({
      code: "identity-measurement-insufficient",
      level: "warning",
      message: worker.identity.error
        ? `SFace-Messung unzureichend: ${worker.identity.error}`
        : "SFace erhielt nicht genügend eindeutige Gesichtsframes für eine belastbare Rohmessung.",
    });
  } else if (worker.identity.status === "failed") {
    findings.push({
      code: "identity-measurement-failed",
      level: "warning",
      message: `SFace-Teilprüfung fehlgeschlagen: ${worker.identity.error ?? "unbekannter Fehler"}`,
    });
  }
  if (worker.avSync.status === "measured") {
    const lag = worker.avSync.estimatedAudioLeadMilliseconds;
    if (lag === null) throw new Error("Gemessener AV-Rohproxy enthält keinen Rohversatz.");
    const timing = lag > 0
      ? `${lag} ms Audio-Vorlauf`
      : lag < 0
        ? `${Math.abs(lag)} ms Mund-/Video-Vorlauf`
        : "0 ms Rohversatz";
    findings.push({
      code: "classical-av-sync-raw-measured",
      level: "info",
      message: `Der klassische AV-Rohproxy fand sein stärkstes gemeinsames Bewegungssignal bei ${timing}.`,
    });
  } else if (worker.avSync.status === "insufficient") {
    findings.push({
      code: "classical-av-sync-insufficient",
      level: "warning",
      message: worker.avSync.error
        ? `AV-Rohproxy unzureichend: ${worker.avSync.error}`
        : "Der klassische AV-Rohproxy erhielt kein belastbares Bewegungssignal.",
    });
  } else if (worker.avSync.status === "failed") {
    findings.push({
      code: "classical-av-sync-failed",
      level: "warning",
      message: `AV-Rohproxy fehlgeschlagen: ${worker.avSync.error ?? "unbekannter Fehler"}`,
    });
  }
  findings.push({
    code: "calibration-required",
    level: "info",
    message: "Dynamikwerte sind Rohmessungen und erhalten erst nach lokalen Positiv-/Negativkontrollen ein Qualitätsurteil.",
  });
  const sufficient = worker.technical.hasAudio === true
    && worker.technical.constantFrameRate === true
    && worker.technical.audioVideoStartDeltaSeconds !== null
    && worker.technical.audioVideoStartDeltaSeconds <= 0.04
    && worker.technical.audioVideoDurationDeltaSeconds !== null
    && worker.technical.audioVideoDurationDeltaSeconds <= 0.04
    && worker.face.sampledFrames >= 8
    && worker.face.geometryCoverage >= 0.5
    && ["measured", "not-applicable"].includes(worker.identity.status)
    && worker.avSync.status === "measured";
  return {
    schemaVersion: "ltx-studio-objective-quality.v3",
    analyzerVersion: "ffprobe-yunet5-sface-avmotion.v3",
    createdAt,
    status: sufficient ? "measured" : "insufficient",
    technical: worker.technical,
    face: worker.face,
    identity: worker.identity,
    avSync: worker.avSync,
    capabilities: {
      avSync: worker.avSync.status === "measured"
        ? "classical-av-raw-measured"
        : worker.avSync.status === "insufficient"
          ? "classical-av-insufficient"
          : worker.avSync.status === "failed"
            ? "classical-av-failed"
            : "not-applicable",
      identity: worker.identity.status === "measured"
        ? "sface-raw-measured"
        : worker.identity.status === "insufficient"
          ? "sface-insufficient"
          : worker.identity.status === "not-applicable"
            ? "not-applicable"
            : worker.identity.status === "failed"
              ? "sface-failed"
              : "reference-provenance-required",
      dialogue: "whisper-not-run",
    },
    findings,
    limitations: [
      "YuNet liefert fünf Landmarken; die Werte messen Stabilität, aber keine Phonem-Mund-Synchronität.",
      "SFace misst Identitätsähnlichkeit nur gegen während der Generierung kryptografisch gebundene Studio-Referenzen.",
      "Der klassische AV-Rohproxy korreliert Audio-Onsets mit stabilisierter Mundbewegung; er beweist keine Phonem- oder Visemtreue.",
      "Musik, Fremdsprache, Verdeckungen und starke Beleuchtungswechsel können den AV-Rohproxy verfälschen.",
      "Eine SOTA-Aussage benötigt weiterhin einen lizenzierten und lokal kalibrierten Phonem-AV-Evaluator.",
      "Unkalibrierte Rohwerte dürfen keine automatische 10/10- oder SOTA-Freigabe erzeugen.",
    ],
  };
}

export class OutputAnalysisManager {
  private readonly queue: string[] = [];
  private readonly tasks = new Map<string, AnalysisTask>();
  private readonly activeByOutput = new Map<string, string>();
  private readonly processes = new Map<string, ChildProcess>();
  private runningId: string | null = null;

  constructor(
    private readonly library: OutputLibrary,
    private readonly jobs: () => readonly StudioJob[],
    private readonly root = outputRoot,
    private readonly options: OutputAnalysisManagerOptions = {},
  ) {
    recoverInterruptedOutputAnalyses(this.root);
  }

  get(outputName: string): OutputAnalysisRecord | null {
    const target = this.library.resolveAnalysisTarget(outputName);
    return readOutputAnalysis(this.root, outputName, revisionOf(target));
  }

  start(outputName: string, force = false): OutputAnalysisRecord {
    const target = this.library.resolveAnalysisTarget(outputName);
    const revision = revisionOf(target);
    const current = readOutputAnalysis(this.root, outputName, revision);
    if (current && ["queued", "running"].includes(current.status)) return current;
    if (current && completedAnalysisIsCurrent(current) && !force) return current;
    const createdAt = now();
    const record: Extract<OutputAnalysisRecord, { schemaVersion: "ltx-studio-output-analysis.v3" }> = {
      schemaVersion: "ltx-studio-output-analysis.v3",
      outputName,
      sizeBytes: target.sizeBytes,
      modifiedAtMs: target.modifiedAtMs,
      changedAtMs: target.changedAtMs,
      fileId: target.fileId,
      jobId: target.jobId,
      analysisId: randomUUID(),
      attempt: (current?.attempt ?? 0) + 1,
      status: "queued",
      progress: 0,
      createdAt,
      startedAt: null,
      finishedAt: null,
      updatedAt: createdAt,
      error: null,
      result: null,
    };
    writeOutputAnalysis(this.root, record);
    this.tasks.set(record.analysisId, { target, record });
    this.activeByOutput.set(outputName, record.analysisId);
    this.queue.push(record.analysisId);
    setImmediate(() => void this.pump());
    return record;
  }

  cancel(outputName: string, expectedAnalysisId: string): OutputAnalysisRecord | null {
    const analysisId = this.activeByOutput.get(outputName);
    if (!analysisId) return this.get(outputName);
    if (analysisId !== expectedAnalysisId) {
      throw new OutputQualityError(
        "Der Analyselauf wurde inzwischen ersetzt; der neuere Lauf wurde nicht abgebrochen.",
        409,
      );
    }
    const task = this.tasks.get(analysisId);
    if (!task) return this.get(outputName);
    const queueIndex = this.queue.indexOf(analysisId);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    const process = this.processes.get(analysisId);
    if (process) {
      signalProcessGroup(process, "SIGTERM");
      setTimeout(
        () => signalProcessGroup(process, "SIGKILL"),
        this.options.terminationGraceMs ?? TERMINATION_GRACE_MS,
      ).unref();
    }
    const updatedAt = now();
    task.record = {
      ...task.record,
      status: "cancelled",
      finishedAt: updatedAt,
      updatedAt,
      error: { code: "cancelled", message: "Objektive Analyse wurde manuell abgebrochen." },
      result: null,
    };
    writeOutputAnalysis(this.root, task.record);
    this.activeByOutput.delete(outputName);
    if (this.runningId !== analysisId) this.tasks.delete(analysisId);
    return task.record;
  }

  private async pump(): Promise<void> {
    if (this.runningId !== null) return;
    const analysisId = this.queue.shift();
    if (!analysisId) return;
    const task = this.tasks.get(analysisId);
    if (!task || task.record.status !== "queued") return void this.pump();
    this.runningId = analysisId;
    try {
      await this.run(task);
    } finally {
      this.processes.delete(analysisId);
      this.tasks.delete(analysisId);
      if (this.activeByOutput.get(task.target.outputName) === analysisId) {
        this.activeByOutput.delete(task.target.outputName);
      }
      this.runningId = null;
      void this.pump();
    }
  }

  private async run(task: AnalysisTask): Promise<void> {
    const startedAt = now();
    task.record = {
      ...task.record,
      status: "running",
      progress: 10,
      startedAt,
      updatedAt: startedAt,
    };
    writeOutputAnalysis(this.root, task.record);
    try {
      await this.verifyTaskIdentityEvidence(task, "vor der Analyse");
      if (analysisWasCancelled(task)) return;
      const worker = await this.runWorker(task);
      if (analysisWasCancelled(task)) return;
      await this.verifyTaskIdentityEvidence(task, "nach der Analyse");
      if (analysisWasCancelled(task)) return;
      const currentTarget = this.library.resolveAnalysisTarget(task.target.outputName);
      if (currentTarget.sizeBytes !== task.target.sizeBytes
        || Math.abs(currentTarget.modifiedAtMs - task.target.modifiedAtMs) >= 1
        || Math.abs(currentTarget.changedAtMs - task.target.changedAtMs) >= 1
        || currentTarget.fileId !== task.target.fileId
        || currentTarget.jobId !== task.target.jobId) {
        throw new Error("Ausgabe wurde während der Analyse ersetzt oder verändert.");
      }
      const finishedAt = now();
      task.record = {
        ...task.record,
        status: "completed",
        progress: 100,
        finishedAt,
        updatedAt: finishedAt,
        error: null,
        result: buildObjectiveQualityAnalysis(worker, finishedAt),
      };
      writeOutputAnalysis(this.root, task.record);
      this.library.list(this.jobs());
    } catch (error) {
      if (task.record.status === "cancelled") return;
      const finishedAt = now();
      task.record = {
        ...task.record,
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        error: {
          code: "analysis-failed",
          message: (error instanceof Error ? error.message : "Objektive Analyse fehlgeschlagen.").slice(0, 500),
        },
        result: null,
      };
      writeOutputAnalysis(this.root, task.record);
    }
  }

  private async verifyTaskIdentityEvidence(task: AnalysisTask, context: string): Promise<void> {
    if (task.target.identityEvidence?.status !== "verified" || !this.options.identityEvidenceVerifier) return;
    const error = await this.options.identityEvidenceVerifier(task.target.identityEvidence);
    if (error) {
      throw new Error(`Gebundene Identitätsreferenz ${context} verändert: ${error}`);
    }
  }

  private runWorker(task: AnalysisTask): Promise<ObjectiveWorkerResult> {
    const script = this.options.workerScript ?? join(appRoot, "scripts", "analyze-face-quality.py");
    const faceModel = this.options.faceModel ?? join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
    const identityModel = this.options.identityModel ?? join(appRoot, "models", "face_recognition_sface_2021dec.onnx");
    const references = this.options.identityReferenceResolver?.(task.target.identityEvidence) ?? [];
    const identityStatus = task.target.identityEvidence?.status === "not-applicable"
      ? "not-applicable"
      : task.target.identityEvidence?.status === "verified" && references.length > 0
        ? "available"
        : "reference-provenance-missing";
    const timeoutMs = this.options.timeoutMs ?? ANALYSIS_TIMEOUT_MS;
    const terminationGraceMs = this.options.terminationGraceMs ?? TERMINATION_GRACE_MS;
    const workerArgs = [
      script,
      "--video",
      task.target.outputPath,
      "--face-model",
      faceModel,
      "--identity-model",
      identityModel,
      "--identity-status",
      identityStatus,
      "--max-frames",
      "240",
    ];
    for (const reference of references) {
      workerArgs.push("--identity-reference", reference.path, reference.sha256);
    }
    const analysisTempRoot = this.options.analysisTempRoot ?? defaultAnalysisTempRoot;
    const analysisTempDir = join(analysisTempRoot, `analysis-${task.record.analysisId}`);
    mkdirSync(analysisTempRoot, { recursive: true, mode: 0o700 });
    rmSync(analysisTempDir, { recursive: true, force: true });
    mkdirSync(analysisTempDir, { recursive: false, mode: 0o700 });
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.options.pythonExecutable ?? defaultPythonExecutable, workerArgs, {
        cwd: appRoot,
        detached: true,
        shell: false,
        env: {
          ...process.env,
          CUDA_VISIBLE_DEVICES: "",
          OMP_NUM_THREADS: "2",
          OPENBLAS_NUM_THREADS: "2",
          LTX_STUDIO_ANALYSIS_TEMP_DIR: analysisTempDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.processes.set(task.record.analysisId, child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      let terminationError: Error | null = null;
      let timeout: NodeJS.Timeout | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        rmSync(analysisTempDir, { recursive: true, force: true });
        if (error) return rejectPromise(error);
        try {
          resolvePromise(objectiveWorkerResultSchema.parse(JSON.parse(stdout)));
        } catch (parseError) {
          rejectPromise(new Error(`Analyse lieferte ungültige Messdaten: ${String(parseError)}`));
        }
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > MAX_STDOUT_BYTES) {
          terminationError ??= new Error("Analyseausgabe überschritt das Größenlimit.");
          signalProcessGroup(child, "SIGKILL");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
      });
      child.on("error", (error) => finish(terminationError ?? error));
      child.on("close", (code, signal) => {
        if (terminationError) finish(terminationError);
        else if (code === 0) finish();
        else finish(new Error(`Analyseprozess endete mit Code ${code ?? "?"}${signal ? ` (${signal})` : ""}: ${stderr.slice(-1_000)}`));
      });
      timeout = setTimeout(() => {
        terminationError = new Error(`Objektive Analyse überschritt ${Math.ceil(timeoutMs / 1_000)} Sekunden.`);
        signalProcessGroup(child, "SIGTERM");
        killTimer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), terminationGraceMs);
        killTimer.unref();
      }, timeoutMs);
      timeout.unref();
    });
  }
}
