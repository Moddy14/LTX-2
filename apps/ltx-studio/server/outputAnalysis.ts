import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import { appRoot, outputRoot, pythonExecutable as defaultPythonExecutable } from "./config.js";
import { OutputLibrary, type OutputAnalysisTarget } from "./outputs.js";

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const ANALYSIS_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 2_000;

type OutputAnalysisManagerOptions = {
  pythonExecutable?: string;
  workerScript?: string;
  faceModel?: string;
  timeoutMs?: number;
  terminationGraceMs?: number;
};

type AnalysisTask = {
  target: OutputAnalysisTarget;
  record: OutputAnalysisRecord;
};

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
  worker: ObjectiveWorkerResult,
  createdAt = now(),
): ObjectiveQualityAnalysis {
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
  findings.push({
    code: "calibration-required",
    level: "info",
    message: "Dynamikwerte sind Rohmessungen und erhalten erst nach lokalen Positiv-/Negativkontrollen ein Qualitätsurteil.",
  });
  const sufficient = worker.technical.hasAudio === true
    && worker.technical.constantFrameRate === true
    && worker.face.sampledFrames >= 8
    && worker.face.geometryCoverage >= 0.5;
  return {
    schemaVersion: "ltx-studio-objective-quality.v1",
    analyzerVersion: "ffprobe-yunet5.v1",
    createdAt,
    status: sufficient ? "measured" : "insufficient",
    technical: worker.technical,
    face: worker.face,
    capabilities: {
      avSync: "syncnet-required",
      identity: "face-recognition-model-required",
      dialogue: "whisper-not-run",
    },
    findings,
    limitations: [
      "YuNet liefert fünf Landmarken; die Werte messen Stabilität, aber keine Phonem-Mund-Synchronität.",
      "AV-Sync benötigt ein kalibriertes SyncNet-Modell und Identität ein separates Face-Recognition-Modell.",
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
    if (current?.status === "completed" && !force) return current;
    const createdAt = now();
    const record: OutputAnalysisRecord = {
      schemaVersion: "ltx-studio-output-analysis.v1",
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

  cancel(outputName: string): OutputAnalysisRecord | null {
    const analysisId = this.activeByOutput.get(outputName);
    if (!analysisId) return this.get(outputName);
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
      const worker = await this.runWorker(task);
      if (task.record.status === "cancelled") return;
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

  private runWorker(task: AnalysisTask): Promise<ObjectiveWorkerResult> {
    const script = this.options.workerScript ?? join(appRoot, "scripts", "analyze-face-quality.py");
    const faceModel = this.options.faceModel ?? join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
    const timeoutMs = this.options.timeoutMs ?? ANALYSIS_TIMEOUT_MS;
    const terminationGraceMs = this.options.terminationGraceMs ?? TERMINATION_GRACE_MS;
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(this.options.pythonExecutable ?? defaultPythonExecutable, [
        script,
        "--video",
        task.target.outputPath,
        "--face-model",
        faceModel,
        "--max-frames",
        "240",
      ], {
        cwd: appRoot,
        detached: true,
        shell: false,
        env: {
          ...process.env,
          CUDA_VISIBLE_DEVICES: "",
          OMP_NUM_THREADS: "2",
          OPENBLAS_NUM_THREADS: "2",
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
