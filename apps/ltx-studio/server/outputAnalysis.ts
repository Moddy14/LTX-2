import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

import {
  objectiveBaseWorkerResultV7Schema,
  objectiveWorkerResultSchema,
  type ObjectiveBaseWorkerResultV7,
  type ObjectiveQualityAnalysis,
  type ObjectiveWorkerResult,
  type OutputAnalysisRecord,
} from "../shared/objectiveQuality.js";
import {
  mfaMediaPipeRunnerOutputSchema,
  phonemeVisemeResultSchema,
  unavailablePhonemeVisemeResult,
  type PhonemeVisemeResult,
} from "../shared/phonemeVisemeEvaluator.js";
import { mouthSkinMeasurementIsSufficient } from "../shared/mouthSkinSufficiency.js";
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
  phonemeVisemePythonExecutable as defaultPhonemeVisemePythonExecutable,
  pythonExecutable as defaultPythonExecutable,
} from "./config.js";
import {
  type IdentityInputEvidence,
  type ResolvedIdentityReference,
} from "./inputEvidence.js";
import {
  resolveDialogueEvaluatorState,
  WHISPER_SMALL_SHA256,
  type DialogueEvaluatorState,
} from "./dialogueEvaluator.js";
import {
  resolvePhonemeVisemeEvaluatorState,
  verifyPhonemeVisemeExecutionRuntime,
  type PhonemeVisemeExecution,
  type PhonemeVisemeEvaluatorState,
  type PhonemeVisemeTrustPins,
} from "./evaluatorManifest.js";
import {
  capturePinnedPathRevision,
  openPinnedPaths,
} from "./evaluatorBindings.js";
import {
  evaluatorCredentialPath,
  evaluatorRuntimeDirectory,
  evaluatorSandboxProperties,
} from "./evaluatorSandbox.js";
import { OutputLibrary, OutputQualityError, type OutputAnalysisTarget } from "./outputs.js";
import { verifyProvenanceFileEvidence } from "./runProvenance.js";

const MAX_STDOUT_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const ANALYSIS_TIMEOUT_MS = 120_000;
const PHONEME_VISEME_TIMEOUT_MS = 180_000;
const TERMINATION_GRACE_MS = 2_000;
const SYSTEMD_STOP_DEADLINE_MS = 10_000;
const SYSTEMD_CONTROL_TIMEOUT_MS = 1_000;
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
  phonemeVisemeTimeoutMs?: number;
  phonemeVisemeSystemdSandbox?: boolean;
  terminationGraceMs?: number;
  phonemeVisemeEvaluatorStateResolver?: () => PhonemeVisemeEvaluatorState;
  phonemeVisemeTrustPins?: PhonemeVisemeTrustPins;
  phonemeVisemeRuntimeVerifier?: (execution: PhonemeVisemeExecution) => void;
  phonemeVisemeTrustVerifier?: (
    execution: PhonemeVisemeExecution,
    pinned: ReturnType<typeof openPinnedPaths>,
  ) => void;
  dialogueEvaluatorStateResolver?: () => DialogueEvaluatorState;
  phonemeVisemeUnitRecovery?: () => Promise<void>;
  controlCommand?: typeof runControlCommand;
};

type AnalysisTask = {
  target: OutputAnalysisTarget;
  record: Extract<OutputAnalysisRecord, { schemaVersion: "ltx-studio-output-analysis.v7" }>;
  evaluatorState: PhonemeVisemeEvaluatorState;
  dialogueEvaluatorState: DialogueEvaluatorState;
  evaluatorFingerprint: string;
};

function analysisWasCancelled(task: AnalysisTask): boolean {
  return task.record.status === "cancelled";
}

function completedAnalysisIsCurrent(
  record: OutputAnalysisRecord,
  evaluatorState: PhonemeVisemeEvaluatorState,
  dialogueEvaluatorState: DialogueEvaluatorState,
  target: OutputAnalysisTarget,
): boolean {
  const evaluatorFingerprint = combinedEvaluatorFingerprint(
    evaluatorState,
    dialogueEvaluatorState,
  );
  if (record.status !== "completed"
    || record.schemaVersion !== "ltx-studio-output-analysis.v7"
    || record.result?.schemaVersion !== "ltx-studio-objective-quality.v7"
    || record.evaluatorFingerprint !== evaluatorFingerprint
    || record.conditioningAudioSha256 !== (conditioningAudioEvidence(target)?.sha256 ?? null)
    || record.expectedDialogueSha256 !== expectedDialogueSha256(target)
    || record.result.phonemeViseme.manifestSha256 !== evaluatorState.result.manifestSha256
    || record.result.phonemeViseme.manifestReleaseId !== evaluatorState.result.manifestReleaseId
    || record.result.phonemeViseme.productGo.status !== evaluatorState.result.productGo.status) return false;
  if (dialogueEvaluatorState.status === "ready"
    && (record.result.dialogue.status === "measured"
      || record.result.dialogue.status === "failed"
      || record.result.dialogue.blockerCode === "alignment-insufficient")) {
    if (record.result.dialogue.modelSha256 !== dialogueEvaluatorState.modelSha256
      || record.result.dialogue.packageVersion !== dialogueEvaluatorState.packageVersion) return false;
  } else if (dialogueEvaluatorState.status !== "ready"
    && !["not-available", "not-applicable"].includes(record.result.dialogue.status)) {
    return false;
  }
  const identity = record.result.identity;
  if (["not-applicable", "reference-provenance-missing"].includes(identity.status)) return true;
  return identity.modelSha256 === CURRENT_IDENTITY_MODEL_SHA256
    && identity.modelRevision === CURRENT_IDENTITY_MODEL_REVISION
    && identity.preprocessingVersion === CURRENT_IDENTITY_PREPROCESSING;
}

function expectedDialogueSha256(target: OutputAnalysisTarget): string {
  return createHash("sha256")
    .update(target.request.promptParts.dialogue, "utf8")
    .digest("hex");
}

export function combinedEvaluatorFingerprint(
  evaluatorState: PhonemeVisemeEvaluatorState,
  dialogueEvaluatorState: DialogueEvaluatorState,
): string {
  return createHash("sha256").update(JSON.stringify({
    analyzer: "ffprobe-yunet5-sface-dual-avmotion-whisper-pv-artifact.v7",
    phonemeViseme: evaluatorState.fingerprint,
    dialogue: dialogueEvaluatorState.fingerprint,
  })).digest("hex");
}

function conditioningAudioEvidence(target: OutputAnalysisTarget) {
  const requestedPath = target.request.audio.path;
  if (!requestedPath || !target.runProvenance) return null;
  return target.runProvenance.files.find((file) =>
    file.role === "input:conditioning-audio"
    && file.kind === "file"
    && resolve(file.path) === resolve(requestedPath)) ?? null;
}

export function cleanupAnalysisTempRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith("analysis-")) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
  }
}

function cleanupPhonemeVisemeTempRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const managedDirectory = /^phoneme-viseme-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !managedDirectory.test(entry.name)) continue;
    rmSync(join(root, entry.name), { recursive: true, force: true });
  }
}

function now(): string {
  return new Date().toISOString();
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessGroupExit(processGroupId: number, deadlineMs: number): Promise<boolean> {
  while (Date.now() < deadlineMs) {
    if (!processGroupExists(processGroupId)) return true;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  return !processGroupExists(processGroupId);
}

async function terminateProcessGroup(
  child: ChildProcess,
  graceMs: number,
  deadlineMs = graceMs + 2_000,
): Promise<void> {
  if (!child.pid) return;
  const processGroupId = child.pid;
  const startedAt = Date.now();
  signalProcessGroup(child, "SIGTERM");
  if (await waitForProcessGroupExit(processGroupId, startedAt + graceMs)) return;
  signalProcessGroup(child, "SIGKILL");
  if (!await waitForProcessGroupExit(processGroupId, startedAt + deadlineMs)) {
    throw new Error(`Analyse-Prozessgruppe ${processGroupId} blieb nach SIGKILL aktiv.`);
  }
}

function runControlCommand(args: string[], timeoutMs = 5_000): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise) => {
    const child = spawn("/usr/bin/sudo", ["-n", ...args], {
      shell: false,
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-16_384);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-16_384);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: timedOut ? null : code,
        stdout,
        stderr: timedOut ? `${stderr}Zeitlimit überschritten.` : stderr,
      });
    });
  });
}

type ControlCommand = typeof runControlCommand;

async function readSystemdUnitState(
  unit: string,
  controlCommand: ControlCommand,
  timeoutMs = SYSTEMD_CONTROL_TIMEOUT_MS,
): Promise<{ loadState: string; activeState: string }> {
  const result = await controlCommand([
    "/usr/bin/systemctl",
    "show",
    "--no-pager",
    "--property=LoadState",
    "--property=ActiveState",
    unit,
  ], timeoutMs);
  if (result.code !== 0) {
    throw new Error(
      `Status von ${unit} konnte nicht bestätigt werden: ${
        result.stderr.trim().slice(-300) || `Code ${result.code ?? "?"}`
      }`,
    );
  }
  const properties = new Map(result.stdout
    .split(/\r?\n/u)
    .map((line) => line.split("=", 2) as [string, string])
    .filter(([key, value]) => Boolean(key && value)));
  const loadState = properties.get("LoadState");
  const activeState = properties.get("ActiveState");
  if (!loadState || !activeState) {
    throw new Error(`Status von ${unit} war unvollständig.`);
  }
  return { loadState, activeState };
}

export async function stopSystemdUnit(
  unit: string,
  controlCommand: ControlCommand,
  options: {
    initiallyObserved?: boolean;
    clientFinished?: () => boolean;
    deadlineMs?: number;
    pollIntervalMs?: number;
    controlTimeoutMs?: number;
  } = {},
): Promise<void> {
  let unitWasObserved = options.initiallyObserved ?? false;
  let lastError = "";
  const deadline = Date.now() + (options.deadlineMs ?? SYSTEMD_STOP_DEADLINE_MS);
  const controlTimeoutMs = options.controlTimeoutMs ?? SYSTEMD_CONTROL_TIMEOUT_MS;
  for (let attempt = 0; attempt < 100 && Date.now() < deadline; attempt += 1) {
    const stopped = await controlCommand(
      ["/usr/bin/systemctl", "stop", unit],
      controlTimeoutMs,
    );
    if (stopped.code !== 0) {
      lastError = stopped.stderr.trim().slice(-300) || `Stop-Code ${stopped.code ?? "?"}`;
    }
    try {
      const state = await readSystemdUnitState(unit, controlCommand, controlTimeoutMs);
      if (state.loadState !== "not-found") unitWasObserved = true;
      if (state.loadState === "not-found") {
        if (unitWasObserved || options.clientFinished?.()) return;
        lastError = "Unit ist noch nicht registriert und der systemd-run-Client läuft.";
      } else if (state.activeState === "inactive" || state.activeState === "failed") {
        return;
      } else {
        lastError = `LoadState=${state.loadState}, ActiveState=${state.activeState}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolvePromise) => setTimeout(
      resolvePromise,
      options.pollIntervalMs ?? 50,
    ));
  }
  throw new Error(`Phonem-/Visem-Sandbox ${unit} blieb nach Stop unbestätigt: ${lastError}`);
}

export async function recoverPhonemeVisemeSandboxState(
  root: string,
  controlCommand: ControlCommand = runControlCommand,
): Promise<void> {
  const listed = await controlCommand([
    "/usr/bin/systemctl",
    "list-units",
    "--all",
    "--plain",
    "--no-legend",
    "ltx-pv-*.service",
  ]);
  if (listed.code !== 0) {
    throw new Error(`Verwaiste Phonem-/Visem-Units konnten nicht geprüft werden: ${listed.stderr.slice(-300)}`);
  }
  const orphanPattern = /^ltx-pv-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.service$/;
  const orphans = listed.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((unit) => orphanPattern.test(unit));
  for (const unit of orphans) {
    await stopSystemdUnit(unit, controlCommand, { initiallyObserved: true });
  }
  cleanupPhonemeVisemeTempRoot(root);
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
): Extract<ObjectiveQualityAnalysis, { schemaVersion: "ltx-studio-objective-quality.v7" }> {
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
  const mouthSkinMeasurementSufficient = mouthSkinMeasurementIsSufficient(worker.face);
  if (mouthSkinMeasurementSufficient) {
    findings.push({
      code: "mouth-skin-stability-raw-measured",
      level: "info",
      message: `Mundhaut-Texturrest Raum-p95/Zeit-p95 ${worker.face.mouthSkinWarpResidualP95!.toFixed(3)}, `
        + `lokale Flussdeformation Raum-p95/Zeit-p95 ${worker.face.mouthSkinFlowDeformationP95!.toFixed(3)} `
        + `bei ${(worker.face.mouthSkinPairCoverage * 100).toFixed(0)} % Paar- und `
        + `${(worker.face.mouthSkinValidPixelCoverageP10! * 100).toFixed(0)} % Pixelabdeckung p10.`,
    });
  } else {
    const pixelCoverage = worker.face.mouthSkinValidPixelCoverageP10 === null
      ? "nicht messbar"
      : `${(worker.face.mouthSkinValidPixelCoverageP10 * 100).toFixed(0)} %`;
    findings.push({
      code: "mouth-skin-stability-insufficient",
      level: "warning",
      message: `Mundhaut-Rohmessung unzureichend: ${worker.face.mouthSkinPairCount} Paare, `
        + `${(worker.face.mouthSkinPairCoverage * 100).toFixed(0)} % Paarabdeckung und `
        + `${pixelCoverage} Pixelabdeckung p10; erforderlich sind mindestens 8 Paare, 50 % Paar- und 60 % Pixelabdeckung.`,
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
      message: `Der klassische AV-Rohproxy des eingebetteten Endmixes fand sein stärkstes gemeinsames Bewegungssignal bei ${timing}.`,
    });
  } else if (worker.avSync.status === "insufficient") {
    findings.push({
      code: "classical-av-sync-insufficient",
      level: "warning",
      message: worker.avSync.error
        ? `Endmix-AV-Rohproxy unzureichend: ${worker.avSync.error}`
        : "Der klassische Endmix-AV-Rohproxy erhielt kein belastbares Bewegungssignal.",
    });
  } else if (worker.avSync.status === "failed") {
    findings.push({
      code: "classical-av-sync-failed",
      level: "warning",
      message: `Endmix-AV-Rohproxy fehlgeschlagen: ${worker.avSync.error ?? "unbekannter Fehler"}`,
    });
  }
  if (worker.conditioningAvSync?.status === "measured") {
    const lag = worker.conditioningAvSync.estimatedAudioLeadMilliseconds;
    if (lag === null) throw new Error("Gemessener Konditionierungs-AV-Rohproxy enthält keinen Rohversatz.");
    const timing = lag > 0
      ? `${lag} ms Audio-Vorlauf`
      : lag < 0
        ? `${Math.abs(lag)} ms Mund-/Video-Vorlauf`
        : "0 ms Rohversatz";
    findings.push({
      code: "classical-conditioning-av-sync-raw-measured",
      level: "info",
      message: `Der hashgebundene Konditionierungs-Audio-Proxy fand sein stärkstes gemeinsames Bewegungssignal bei ${timing}.`,
    });
  } else if (worker.conditioningAvSync?.status === "insufficient") {
    findings.push({
      code: "classical-conditioning-av-sync-insufficient",
      level: "warning",
      message: worker.conditioningAvSync.error
        ? `Konditionierungs-Audio-Proxy unzureichend: ${worker.conditioningAvSync.error}`
        : "Der Konditionierungs-Audio-Proxy erhielt kein belastbares Bewegungssignal.",
    });
  } else if (worker.conditioningAvSync?.status === "failed") {
    findings.push({
      code: "classical-conditioning-av-sync-failed",
      level: "warning",
      message: `Konditionierungs-Audio-Proxy fehlgeschlagen: ${worker.conditioningAvSync.error ?? "unbekannter Fehler"}`,
    });
  }
  if (worker.phonemeViseme.status === "measured") {
    findings.push({
      code: "phoneme-viseme-product-go-measured",
      level: "info",
      message: `Der freigegebene Phonem-/Visem-Evaluator bestand Offset- und Inhaltsgate (${worker.phonemeViseme.manifestReleaseId}).`,
    });
  } else if (worker.phonemeViseme.status === "measurement-only") {
    const bilabialClosure = worker.phonemeViseme.measurement?.bilabialClosureF1 ?? null;
    findings.push({
      code: "phoneme-viseme-measurement-only",
      level: "info",
      message: bilabialClosure !== null && bilabialClosure < 0.5
        ? "Laut-/Lippenprüfung: Bei P, B und M schließen sich die Lippen nicht passend zum gesprochenen Ton."
        : "Laut-/Lippenprüfung abgeschlossen. Die verständliche Zusammenfassung steht über den Detailwerten.",
    });
  } else if (worker.phonemeViseme.status === "not-available") {
    findings.push({
      code: `phoneme-viseme-${worker.phonemeViseme.blockerCode}`,
      level: "warning",
      message: worker.phonemeViseme.error ?? "Kein freigegebener Phonem-/Visem-Evaluator verfügbar.",
    });
  } else if (worker.phonemeViseme.status === "insufficient") {
    findings.push({
      code: "phoneme-viseme-insufficient",
      level: "warning",
      message: worker.phonemeViseme.error ?? "Phonem-/Visem-Inhaltsprüfung unzureichend.",
    });
  } else if (worker.phonemeViseme.status === "failed") {
    findings.push({
      code: "phoneme-viseme-failed",
      level: "warning",
      message: worker.phonemeViseme.error ?? "Phonem-/Visem-Inhaltsprüfung fehlgeschlagen.",
    });
  }
  if (worker.dialogue.wordErrorRate !== null) {
    const errorPercent = Math.min(999, (worker.dialogue.wordErrorRate ?? 0) * 100);
    findings.push({
      code: "dialogue-whisper-word-measured",
      level: errorPercent > 20 ? "warning" : "info",
      message: `Whisper erkannte den gespeicherten Dialog mit ${errorPercent.toFixed(0)} % Wortfehlerrate.`,
    });
    if (worker.dialogue.lowConfidenceAlignedWords > 0) {
      findings.push({
        code: "dialogue-guided-low-confidence",
        level: "warning",
        message: `${worker.dialogue.lowConfidenceAlignedWords} geführte Wortausrichtung(en) haben niedrige Modellkonfidenz.`,
      });
    }
  }
  if (worker.dialogue.status === "insufficient") {
    findings.push({
      code: "dialogue-whisper-insufficient",
      level: "warning",
      message: worker.dialogue.error ?? "Whisper-Wortauswertung unzureichend.",
    });
  } else if (worker.dialogue.status === "failed") {
    findings.push({
      code: "dialogue-whisper-failed",
      level: "warning",
      message: worker.dialogue.error ?? "Whisper-Wortauswertung fehlgeschlagen.",
    });
  } else if (worker.dialogue.status === "not-available") {
    findings.push({
      code: "dialogue-whisper-not-available",
      level: "warning",
      message: worker.dialogue.error ?? "Lokaler Whisper-Wortauswerter nicht verfügbar.",
    });
  }
  findings.push({
    code: "calibration-required",
    level: "info",
    message: "Dynamikwerte sind Rohmessungen und erhalten erst nach lokalen Positiv-/Negativkontrollen ein Qualitätsurteil.",
  });
  const primaryAvSync = worker.conditioningAvSync ?? worker.avSync;
  const sufficient = worker.technical.hasAudio === true
    && worker.technical.constantFrameRate === true
    && worker.technical.audioVideoStartDeltaSeconds !== null
    && worker.technical.audioVideoStartDeltaSeconds <= 0.04
    && worker.technical.audioVideoDurationDeltaSeconds !== null
    && worker.technical.audioVideoDurationDeltaSeconds <= 0.04
    && worker.face.sampledFrames >= 8
    && worker.face.geometryCoverage >= 0.5
    && ["measured", "not-applicable"].includes(worker.identity.status)
    && primaryAvSync.status === "measured"
    && worker.phonemeViseme.status === "measured"
    && ["measured", "not-applicable"].includes(worker.dialogue.status);
  return {
    schemaVersion: "ltx-studio-objective-quality.v7",
    analyzerVersion: "ffprobe-yunet5-sface-dual-avmotion-whisper-pv-artifact.v7",
    createdAt,
    status: sufficient ? "measured" : "insufficient",
    technical: worker.technical,
    face: worker.face,
    identity: worker.identity,
    avSync: worker.avSync,
    conditioningAvSync: worker.conditioningAvSync,
    phonemeViseme: worker.phonemeViseme,
    dialogue: worker.dialogue,
    capabilities: {
      avSync: worker.avSync.status === "measured"
        ? "classical-av-raw-measured"
        : worker.avSync.status === "insufficient"
          ? "classical-av-insufficient"
          : worker.avSync.status === "failed"
            ? "classical-av-failed"
            : "not-applicable",
      conditioningAvSync: worker.conditioningAvSync?.status === "measured"
        ? "classical-av-raw-measured"
        : worker.conditioningAvSync?.status === "insufficient"
          ? "classical-av-insufficient"
          : worker.conditioningAvSync?.status === "failed"
            ? "classical-av-failed"
            : "provenance-unavailable",
      phonemeViseme: worker.phonemeViseme.status === "measured"
        ? "product-go-measured"
        : worker.phonemeViseme.status === "measurement-only"
          ? "measurement-only"
        : worker.phonemeViseme.status === "insufficient"
          ? "product-go-insufficient"
          : worker.phonemeViseme.status === "failed"
            ? "failed"
            : worker.phonemeViseme.status === "not-applicable"
              ? "not-applicable"
              : worker.phonemeViseme.blockerCode === "runner-unavailable"
                ? "runner-unavailable"
                : worker.phonemeViseme.blockerCode === "legal-hold"
                  ? "legal-hold"
                  : worker.phonemeViseme.blockerCode === "manifest-missing"
                    ? "manifest-missing"
                    : "failed",
      identity: worker.identity.status === "measured"
        ? "sface-raw-measured"
        : worker.identity.status === "insufficient"
          ? "sface-insufficient"
          : worker.identity.status === "not-applicable"
            ? "not-applicable"
            : worker.identity.status === "failed"
              ? "sface-failed"
              : "reference-provenance-required",
      dialogue: worker.dialogue.status === "measured"
        ? "whisper-word-measured"
        : worker.dialogue.status === "insufficient"
          ? "whisper-word-insufficient"
          : worker.dialogue.status === "failed"
            ? "whisper-word-failed"
            : worker.dialogue.status === "not-available"
              ? "whisper-word-not-available"
              : "not-applicable",
    },
    findings,
    limitations: [
      "YuNet liefert fünf Landmarken; die Werte messen Stabilität, aber keine Phonem-Mund-Synchronität.",
      "Texturrest und Helligkeitsdelta messen photometrische Inkonsistenz nach vorwärts/rückwärts-konsistenter Bewegungsanpassung; die lokale Deformation entfernt zuvor die beste globale affine Kopfbewegung. Paar- und Pixelabdeckung gaten die Evidenz. Alle Werte bleiben unkalibrierte Vergleichsrohwerte.",
      "SFace misst Identitätsähnlichkeit nur gegen während der Generierung kryptografisch gebundene Studio-Referenzen.",
      "Die getrennten Rohproxys korrelieren Audio-Onsets des Endmixes beziehungsweise der hashgebundenen Konditionierungs-Spur mit stabilisierter Mundbewegung; sie beweisen keine Phonem- oder Visemtreue.",
      "Whisper misst Worttreue und richtet den gespeicherten Wortlaut grob an der Audiospur aus; Wortfenster und YuNet-Mundbewegung sind keine Phonem-/Visemklassifikation.",
      "Wortaktivitäts-Lags und Mundbewegungsanteile bleiben Rohwerte, bis kontrollierte Zeitverschiebungen und lokale Positiv-/Negativbeispiele kalibriert sind.",
      "Nur ein manifestgebundener Evaluator mit Product-GO sowie bestandener Offset- und Inhaltsstufe darf Phonem-/Visemtreue als gemessen markieren.",
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
  private readonly phonemeVisemeUnits = new Map<string, string>();
  private readonly phonemeVisemeUnitStops = new Map<string, Promise<void>>();
  private phonemeVisemeUnitRecovery: Promise<void> | null = null;
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

  isActive(outputName: string): boolean {
    return this.activeByOutput.has(outputName);
  }

  start(outputName: string, force = false): OutputAnalysisRecord {
    const target = this.library.resolveAnalysisTarget(outputName);
    const revision = revisionOf(target);
    const current = readOutputAnalysis(this.root, outputName, revision);
    const evaluatorState = this.resolveEvaluatorState();
    const dialogueEvaluatorState = this.resolveDialogueEvaluatorState();
    const evaluatorFingerprint = combinedEvaluatorFingerprint(
      evaluatorState,
      dialogueEvaluatorState,
    );
    if (current && ["queued", "running"].includes(current.status)) return current;
    if (current && completedAnalysisIsCurrent(
      current,
      evaluatorState,
      dialogueEvaluatorState,
      target,
    ) && !force) return current;
    const createdAt = now();
    const record: Extract<OutputAnalysisRecord, { schemaVersion: "ltx-studio-output-analysis.v7" }> = {
      schemaVersion: "ltx-studio-output-analysis.v7",
      evaluatorFingerprint,
      conditioningAudioSha256: conditioningAudioEvidence(target)?.sha256 ?? null,
      expectedDialogueSha256: expectedDialogueSha256(target),
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
    this.tasks.set(record.analysisId, {
      target,
      record,
      evaluatorState,
      dialogueEvaluatorState,
      evaluatorFingerprint,
    });
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
    if (this.phonemeVisemeUnits.has(analysisId)) {
      void this.stopPhonemeVisemeUnit(analysisId).catch(() => undefined);
    } else if (process) {
      void terminateProcessGroup(
        process,
        this.options.terminationGraceMs ?? TERMINATION_GRACE_MS,
      ).catch(() => undefined);
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

  async shutdown(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (const [analysisId, task] of [...this.tasks]) {
      if (!["queued", "running"].includes(task.record.status)) continue;
      try {
        this.cancel(task.target.outputName, analysisId);
      } catch {
        // A newer analysis owns the output; this task is no longer active.
      }
    }
    const stops = [...this.phonemeVisemeUnitStops.values()];
    const processStops = [...this.processes.values()].map((child) =>
      terminateProcessGroup(
        child,
        Math.min(
          this.options.terminationGraceMs ?? TERMINATION_GRACE_MS,
          Math.max(100, timeoutMs - 1_000),
        ),
        timeoutMs,
      ));
    const stopResults = await Promise.race([
      Promise.allSettled([...stops, ...processStops]),
      new Promise<null>((resolvePromise) => {
        const timer = setTimeout(() => resolvePromise(null), Math.max(1, deadline - Date.now()));
        timer.unref();
      }),
    ]);
    if (stopResults === null) {
      throw new Error("Phonem-/Visem-Sandbox-Stopp überschritt das Studio-Shutdown-Zeitlimit.");
    }
    const failedStop = stopResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedStop) {
      throw new Error(
        `Phonem-/Visem-Sandbox konnte beim Studio-Shutdown nicht bestätigt werden: ${
          failedStop.reason instanceof Error ? failedStop.reason.message : String(failedStop.reason)
        }`,
      );
    }
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
      this.verifyTaskConditioningAudio(task, "vor der Analyse");
      if (analysisWasCancelled(task)) return;
      const baseWorker = await this.runWorker(task);
      if (analysisWasCancelled(task)) return;
      const phonemeViseme = await this.runPhonemeVisemeEvaluator(task);
      const worker = objectiveWorkerResultSchema.parse({
        ...baseWorker,
        phonemeViseme,
      });
      if (analysisWasCancelled(task)) return;
      await this.verifyTaskIdentityEvidence(task, "nach der Analyse");
      this.verifyTaskConditioningAudio(task, "nach der Analyse");
      if (analysisWasCancelled(task)) return;
      if (combinedEvaluatorFingerprint(
        this.resolveEvaluatorState(),
        this.resolveDialogueEvaluatorState(),
      ) !== task.evaluatorFingerprint) {
        throw new Error("Evaluator-Manifest oder Whisper-Laufzeit wurde während der Analyse verändert.");
      }
      const currentTarget = this.library.resolveAnalysisTarget(task.target.outputName);
      if (currentTarget.sizeBytes !== task.target.sizeBytes
        || Math.abs(currentTarget.modifiedAtMs - task.target.modifiedAtMs) >= 1
        || Math.abs(currentTarget.changedAtMs - task.target.changedAtMs) >= 1
        || currentTarget.fileId !== task.target.fileId
        || currentTarget.jobId !== task.target.jobId) {
        throw new Error("Ausgabe wurde während der Analyse ersetzt oder verändert.");
      }
      if (expectedDialogueSha256(currentTarget) !== expectedDialogueSha256(task.target)) {
        throw new Error("Gespeicherter Dialog wurde während der Analyse verändert.");
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

  private verifyTaskConditioningAudio(task: AnalysisTask, context: string): void {
    const evidence = conditioningAudioEvidence(task.target);
    if (!evidence) return;
    const error = verifyProvenanceFileEvidence(evidence);
    if (error) {
      throw new Error(`Gebundenes Konditionierungs-Audio ${context} verändert: ${error}`);
    }
  }

  private resolveEvaluatorState(): PhonemeVisemeEvaluatorState {
    return (this.options.phonemeVisemeEvaluatorStateResolver ?? resolvePhonemeVisemeEvaluatorState)();
  }

  private resolveDialogueEvaluatorState(): DialogueEvaluatorState {
    return (this.options.dialogueEvaluatorStateResolver ?? (() => resolveDialogueEvaluatorState(
      undefined,
      this.options.pythonExecutable ?? defaultPythonExecutable,
    )))();
  }

  private async recoverPhonemeVisemeUnits(): Promise<void> {
    if (this.options.phonemeVisemeUnitRecovery) {
      await this.options.phonemeVisemeUnitRecovery();
      return;
    }
    await recoverPhonemeVisemeSandboxState(
      this.options.analysisTempRoot ?? defaultAnalysisTempRoot,
      this.options.controlCommand ?? runControlCommand,
    );
  }

  private ensurePhonemeVisemeUnitRecovery(): Promise<void> {
    if (!this.phonemeVisemeUnitRecovery) {
      const recovery = this.recoverPhonemeVisemeUnits();
      this.phonemeVisemeUnitRecovery = recovery;
      void recovery.catch(() => {
        if (this.phonemeVisemeUnitRecovery === recovery) {
          this.phonemeVisemeUnitRecovery = null;
        }
      });
    }
    return this.phonemeVisemeUnitRecovery;
  }

  private stopPhonemeVisemeUnit(analysisId: string): Promise<void> {
    const existing = this.phonemeVisemeUnitStops.get(analysisId);
    if (existing) return existing;
    const unit = this.phonemeVisemeUnits.get(analysisId);
    if (!unit) return Promise.resolve();
    const stopping = (async () => {
      await stopSystemdUnit(unit, this.options.controlCommand ?? runControlCommand, {
        clientFinished: () => {
          const client = this.processes.get(analysisId);
          return !client || client.exitCode !== null || client.signalCode !== null;
        },
      });
      this.phonemeVisemeUnits.delete(analysisId);
    })().finally(() => {
      this.phonemeVisemeUnitStops.delete(analysisId);
    });
    this.phonemeVisemeUnitStops.set(analysisId, stopping);
    return stopping;
  }

  private runWorker(task: AnalysisTask): Promise<ObjectiveBaseWorkerResultV7> {
    const script = this.options.workerScript ?? join(appRoot, "scripts", "analyze-face-quality.py");
    const faceModel = this.options.faceModel ?? join(appRoot, "models", "face_detection_yunet_2023mar.onnx");
    const identityModel = this.options.identityModel ?? join(appRoot, "models", "face_recognition_sface_2021dec.onnx");
    const references = this.options.identityReferenceResolver?.(task.target.identityEvidence) ?? [];
    const conditioningAudio = conditioningAudioEvidence(task.target);
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
      "--expected-dialogue",
      task.target.request.promptParts.dialogue,
      "--whisper-model",
      task.dialogueEvaluatorState.modelPath,
      task.dialogueEvaluatorState.modelSha256 ?? WHISPER_SMALL_SHA256,
      "--dialogue-evaluator-state",
      task.dialogueEvaluatorState.status,
      "--dialogue-evaluator-blocker",
      task.dialogueEvaluatorState.blockerCode,
      "--dialogue-evaluator-error",
      task.dialogueEvaluatorState.error ?? "",
      "--max-frames",
      "240",
    ];
    for (const reference of references) {
      workerArgs.push("--identity-reference", reference.path, reference.sha256);
    }
    if (conditioningAudio) {
      workerArgs.push(
        "--conditioning-audio",
        conditioningAudio.path,
        conditioningAudio.sha256,
        String(task.target.request.audio.startTime),
        String(task.target.request.audio.maxDuration ?? -1),
      );
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
          HF_HUB_OFFLINE: "1",
          TRANSFORMERS_OFFLINE: "1",
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
          resolvePromise(objectiveBaseWorkerResultV7Schema.parse(JSON.parse(stdout)));
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

  private async runPhonemeVisemeEvaluator(task: AnalysisTask): Promise<PhonemeVisemeResult> {
    const execution = task.evaluatorState.execution;
    if (!execution) return Promise.resolve(task.evaluatorState.result);
    const expectedDialogue = task.target.request.promptParts.dialogue;
    if (!expectedDialogue.trim()) {
      const reason = "Phonem-/Visem-Messung ist ohne gebundenen Zieldialog nicht anwendbar.";
      return Promise.resolve(phonemeVisemeResultSchema.parse({
        ...unavailablePhonemeVisemeResult(reason, "not-applicable"),
        status: "not-applicable",
        manifestReleaseId: task.evaluatorState.result.manifestReleaseId,
        manifestSha256: task.evaluatorState.result.manifestSha256,
        preprocessingVersion: task.evaluatorState.result.preprocessingVersion,
        visemeMapVersion: task.evaluatorState.result.visemeMapVersion,
      }));
    }
    const timeoutMs = this.options.phonemeVisemeTimeoutMs ?? PHONEME_VISEME_TIMEOUT_MS;
    const terminationGraceMs = this.options.terminationGraceMs ?? TERMINATION_GRACE_MS;
    const analysisTempRoot = this.options.analysisTempRoot ?? defaultAnalysisTempRoot;
    const measurementTempDir = join(analysisTempRoot, `phoneme-viseme-${task.record.analysisId}`);
    const requestPath = join(measurementTempDir, "request.json");
    const sandboxed = this.options.phonemeVisemeSystemdSandbox ?? true;
    const python = sandboxed
      ? execution.pythonExecutable
      : this.options.pythonExecutable ?? execution.pythonExecutable ?? defaultPythonExecutable;
    const unitName = `ltx-pv-${task.record.analysisId}`;
    const sandboxWorkDir = evaluatorRuntimeDirectory(unitName);
    const runnerRequestPath = sandboxed
      ? evaluatorCredentialPath(unitName, "request.json")
      : requestPath;
    const runnerWorkDir = sandboxed ? sandboxWorkDir : measurementTempDir;
    const runnerArgs = [
      execution.runnerPath,
      "--request",
      runnerRequestPath,
      "--work-dir",
      runnerWorkDir,
    ];
    const environment = [
      "PATH=/usr/bin:/bin",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "USER=ltx-pv-evaluator",
      "LOGNAME=ltx-pv-evaluator",
      `HOME=${runnerWorkDir}`,
      `TMPDIR=${runnerWorkDir}`,
      "CUDA_VISIBLE_DEVICES=",
      "HF_HUB_OFFLINE=1",
      "TRANSFORMERS_OFFLINE=1",
      "OMP_NUM_THREADS=2",
      "OPENBLAS_NUM_THREADS=2",
      "PYTHONNOUSERSITE=1",
      "PYTHONSAFEPATH=1",
      "HTTP_PROXY=http://127.0.0.1:9",
      "HTTPS_PROXY=http://127.0.0.1:9",
      "ALL_PROXY=http://127.0.0.1:9",
      "NO_PROXY=",
      "no_proxy=",
    ];
    if (sandboxed) {
      await this.ensurePhonemeVisemeUnitRecovery();
      if (analysisWasCancelled(task)) {
        return task.evaluatorState.result;
      }
      const configuredPython = this.options.pythonExecutable ?? defaultPhonemeVisemePythonExecutable;
      if (execution.pythonExecutable !== configuredPython) {
        throw new Error("Evaluator-Python stimmt nicht mit der Studio-Konfiguration überein.");
      }
      (this.options.phonemeVisemeRuntimeVerifier ?? verifyPhonemeVisemeExecutionRuntime)(execution);
    }
    mkdirSync(analysisTempRoot, { recursive: true, mode: 0o700 });
    rmSync(measurementTempDir, { recursive: true, force: true });
    mkdirSync(measurementTempDir, { recursive: false, mode: 0o700 });
    writeFileSync(requestPath, JSON.stringify({
      schemaVersion: "ltx-studio-mfa-mediapipe-request.v1",
      manifestPath: execution.manifestPath,
      manifestSha256: execution.manifestSha256,
      videoPath: task.target.outputPath,
      expectedDialogue,
      expectedDialogueSha256: expectedDialogueSha256(task.target),
    }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    const outputRevision = capturePinnedPathRevision(task.target.outputPath, "file");
    const requestRevision = capturePinnedPathRevision(requestPath, "file");
    const evaluatorBindings = [...execution.boundPathRevisions, outputRevision];
    const pinned = openPinnedPaths([...evaluatorBindings, requestRevision]);
    if (sandboxed) {
      try {
        const verifyTrust = this.options.phonemeVisemeTrustVerifier ?? ((
          verifiedExecution: PhonemeVisemeExecution,
          verifiedPaths: ReturnType<typeof openPinnedPaths>,
        ) => {
          const trustPins = this.options.phonemeVisemeTrustPins ?? {
            manifestSha256: process.env.LTX_STUDIO_PHONEME_VISEME_MANIFEST_SHA256?.trim() ?? "",
            legalApprovalSha256:
              process.env.LTX_STUDIO_PHONEME_VISEME_LEGAL_APPROVAL_SHA256?.trim() ?? "",
            runnerSha256: process.env.LTX_STUDIO_PHONEME_VISEME_RUNNER_SHA256?.trim() ?? "",
          };
          if (trustPins.manifestSha256 !== verifiedExecution.manifestSha256
            || trustPins.legalApprovalSha256 !== verifiedExecution.legalApprovalSha256
            || trustPins.runnerSha256 !== verifiedExecution.runnerSha256
            || verifiedPaths.sha256(verifiedExecution.manifestPath, 1024 * 1024)
              !== trustPins.manifestSha256
            || verifiedPaths.sha256(verifiedExecution.runnerPath, 2 * 1024 * 1024)
              !== trustPins.runnerSha256) {
            throw new Error(
              "Evaluator-Manifest, Legal Approval oder Runner stimmt nicht mit den Administrator-Pins überein.",
            );
          }
        });
        verifyTrust(execution, pinned);
      } catch (error) {
        pinned.close();
        rmSync(measurementTempDir, { recursive: true, force: true });
        throw error;
      }
    }
    const command = sandboxed ? "/usr/bin/sudo" : python;
    const args = sandboxed ? [
      "-n",
      "/usr/bin/systemd-run",
      "--system",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--service-type=exec",
      `--unit=${unitName}`,
      `--working-directory=${sandboxWorkDir}`,
      ...evaluatorSandboxProperties(unitName),
      `--property=LoadCredential=request.json:${pinned.sourcePath(requestPath)}`,
      ...evaluatorBindings.map((revision) => pinned.bindReadOnlyProperty(revision.path)),
      "--property=MemoryMax=8G",
      "--property=TasksMax=64",
      "--property=LimitNOFILE=256",
      "--property=LimitFSIZE=512M",
      `--property=RuntimeMaxSec=${Math.ceil(timeoutMs / 1_000) + 5}s`,
      `--property=TimeoutStopSec=${Math.ceil(terminationGraceMs / 1_000)}s`,
      "--property=KillMode=control-group",
      "/usr/bin/env",
      "-i",
      ...environment,
      python,
      ...runnerArgs,
    ] : runnerArgs;
    return new Promise((resolvePromise) => {
      if (sandboxed) this.phonemeVisemeUnits.set(task.record.analysisId, unitName);
      const child = spawn(command, args, {
        cwd: measurementTempDir,
        detached: true,
        shell: false,
        env: {
          ...(sandboxed ? {
            PATH: "/usr/bin:/bin",
          } : Object.fromEntries(environment.map((entry) => {
            const separator = entry.indexOf("=");
            return [entry.slice(0, separator), entry.slice(separator + 1)];
          }))),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.processes.set(task.record.analysisId, child);
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeout: NodeJS.Timeout | null = null;
      let terminationPromise: Promise<void> | null = null;
      let terminationReason: string | null = null;
      const failedResult = (reason: string): PhonemeVisemeResult => {
        const boundedReason = reason.slice(0, 500);
        return phonemeVisemeResultSchema.parse({
          ...unavailablePhonemeVisemeResult(boundedReason, "evaluator-failed"),
          status: "failed",
          manifestReleaseId: task.evaluatorState.result.manifestReleaseId,
          manifestSha256: task.evaluatorState.result.manifestSha256,
          preprocessingVersion: task.evaluatorState.result.preprocessingVersion,
          visemeMapVersion: task.evaluatorState.result.visemeMapVersion,
        });
      };
      const finish = async (result: PhonemeVisemeResult) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (terminationPromise) await terminationPromise;
        let finalResult = result;
        try {
          await this.stopPhonemeVisemeUnit(task.record.analysisId);
        } catch (error) {
          finalResult = failedResult(
            `Phonem-/Visem-Sandbox konnte nicht sicher beendet werden: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        try {
          pinned.verifyUnchanged();
        } catch (error) {
          finalResult = failedResult(
            `Gebundene Phonem-/Visem-Evidenz wurde verändert: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } finally {
          pinned.close();
        }
        rmSync(measurementTempDir, { recursive: true, force: true });
        resolvePromise(finalResult);
      };
      child.stdout?.on("data", (chunk: Buffer) => {
        if (terminationReason) return;
        if (Buffer.byteLength(stdout) + chunk.byteLength > MAX_STDOUT_BYTES) {
          stdout = "";
          terminationReason = "Phonem-/Visem-Ausgabe überschritt das Größenlimit.";
          child.stdout?.removeAllListeners("data");
          child.stdout?.resume();
          if (sandboxed) {
            void this.stopPhonemeVisemeUnit(task.record.analysisId).catch(() => undefined);
          } else {
            terminationPromise ??= terminateProcessGroup(child, terminationGraceMs);
          }
          return;
        }
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf8")}`.slice(-MAX_STDERR_BYTES);
      });
      child.on("error", (error) => void finish(failedResult(
        `Phonem-/Visem-Runner konnte nicht gestartet werden: ${error.message}`,
      )));
      child.on("close", (code, signal) => {
        if (terminationReason) return void finish(failedResult(terminationReason));
        if (code !== 0) {
          return void finish(failedResult(
            `Phonem-/Visem-Runner endete mit Code ${code ?? "?"}${signal ? ` (${signal})` : ""}: ${
              stderr.slice(-1_000)
            }`,
          ));
        }
        try {
          const runnerResult = mfaMediaPipeRunnerOutputSchema.parse(JSON.parse(stdout));
          if (runnerResult.manifestSha256 !== execution.manifestSha256
            || runnerResult.manifestReleaseId !== task.evaluatorState.result.manifestReleaseId
            || runnerResult.preprocessingVersion !== task.evaluatorState.result.preprocessingVersion
            || runnerResult.visemeMapVersion !== task.evaluatorState.result.visemeMapVersion) {
            return void finish(failedResult(
              "Phonem-/Visem-Runner lieferte ein Ergebnis für ein anderes Evaluator-Manifest.",
            ));
          }
          if (runnerResult.measurement
            && (runnerResult.measurement.runnerFingerprint !== execution.runnerSha256
              || runnerResult.measurement.expectedDialogueSha256 !== expectedDialogueSha256(task.target))) {
            return void finish(failedResult(
              "Phonem-/Visem-Runner lieferte ungebundene Runner- oder Dialogevidenz.",
            ));
          }
          const measurementOnly = runnerResult.status === "measurement-only";
          const blockerCode = measurementOnly
            ? "product-go-pending"
            : runnerResult.status === "insufficient"
              ? "measurement-insufficient"
              : "evaluator-failed";
          void finish(phonemeVisemeResultSchema.parse({
            status: runnerResult.status,
            blockerCode,
            error: runnerResult.error,
            manifestReleaseId: runnerResult.manifestReleaseId,
            manifestSha256: runnerResult.manifestSha256,
            preprocessingVersion: runnerResult.preprocessingVersion,
            visemeMapVersion: runnerResult.visemeMapVersion,
            gateVersion: null,
            productGo: {
              status: "blocked",
              reason: task.evaluatorState.result.productGo.reason,
            },
            offset: {
              ...runnerResult.offset,
              gatePassed: false,
            },
            content: {
              status: runnerResult.measurement ? "insufficient" : "not-run",
              gatePassed: false,
              frameMacroF1: null,
              transitionF1: null,
            },
            measurement: runnerResult.measurement,
          }));
        } catch (error) {
          void finish(failedResult(`Phonem-/Visem-Runner lieferte ungültige Messdaten: ${String(error)}`));
        }
      });
      timeout = setTimeout(() => {
        terminationReason = `Phonem-/Visem-Runner überschritt ${Math.ceil(timeoutMs / 1_000)} Sekunden.`;
        if (sandboxed) {
          void this.stopPhonemeVisemeUnit(task.record.analysisId).catch(() => undefined);
        } else {
          terminationPromise ??= terminateProcessGroup(child, terminationGraceMs);
        }
      }, timeoutMs);
      timeout.unref();
    });
  }
}
