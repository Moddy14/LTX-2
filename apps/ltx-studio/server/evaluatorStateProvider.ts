import { Worker } from "node:worker_threads";

import {
  phonemeVisemeResultSchema,
  unavailablePhonemeVisemeResult,
} from "../shared/phonemeVisemeEvaluator.js";
import {
  isPhonemeVisemeExecution,
  resolvePhonemeVisemeEvaluatorState,
  type PhonemeVisemeEvaluatorState,
} from "./evaluatorManifest.js";

const DEFAULT_REFRESH_INTERVAL_MS = 15 * 60_000;
const DEFAULT_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_VERIFICATION_TIMEOUT_MS = 10 * 60_000;

type EvaluatorWorker = {
  on(event: "message", listener: (value: unknown) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
  unref(): void;
};

type StateProviderOptions = {
  manifestConfigured?: boolean;
  now?: () => number;
  refreshIntervalMs?: number;
  retryIntervalMs?: number;
  verificationTimeoutMs?: number;
  workerFactory?: () => EvaluatorWorker;
};

type WorkerStateMessage = {
  type: "state";
  state: PhonemeVisemeEvaluatorState;
};

function pendingState(reason: string): PhonemeVisemeEvaluatorState {
  return {
    fingerprint: `manifest-verification-pending:${reason}`,
    result: unavailablePhonemeVisemeResult(
      `Evaluator-Artefaktprüfung läuft im begrenzten Hintergrundworker: ${reason}`,
      "runner-unavailable",
    ),
    execution: null,
  };
}

function isWorkerStateMessage(value: unknown): value is WorkerStateMessage {
  if (!value
    || typeof value !== "object"
    || !("type" in value)
    || value.type !== "state"
    || !("state" in value)
    || !value.state
    || typeof value.state !== "object"
    || !("fingerprint" in value.state)
    || typeof value.state.fingerprint !== "string"
    || !("result" in value.state)
    || !phonemeVisemeResultSchema.safeParse(value.state.result).success) return false;
  if (!("execution" in value.state) || value.state.execution == null) return true;
  return isPhonemeVisemeExecution(value.state.execution);
}

export class PhonemeVisemeEvaluatorStateProvider {
  private state: PhonemeVisemeEvaluatorState;
  private worker: EvaluatorWorker | null = null;
  private verificationTimer: NodeJS.Timeout | null = null;
  private verifying = false;
  private updatedAtMs: number;
  private nextAttemptAtMs = 0;
  private readonly manifestConfigured: boolean;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly retryIntervalMs: number;
  private readonly verificationTimeoutMs: number;
  private readonly workerFactory: () => EvaluatorWorker;

  constructor(options: StateProviderOptions = {}) {
    this.manifestConfigured = options.manifestConfigured
      ?? Boolean(process.env.LTX_STUDIO_PHONEME_VISEME_MANIFEST?.trim());
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.retryIntervalMs = options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;
    this.verificationTimeoutMs = options.verificationTimeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
    this.workerFactory = options.workerFactory ?? (() => new Worker(
      new URL("./evaluatorManifestWorker.ts", import.meta.url),
      {
        resourceLimits: {
          maxOldGenerationSizeMb: 96,
          maxYoungGenerationSizeMb: 16,
          stackSizeMb: 4,
        },
      },
    ) as EvaluatorWorker);
    this.state = this.manifestConfigured
      ? pendingState("noch nicht abgeschlossen")
      : resolvePhonemeVisemeEvaluatorState();
    this.updatedAtMs = this.manifestConfigured ? 0 : this.now();
    if (this.manifestConfigured) this.refresh();
  }

  get(): PhonemeVisemeEvaluatorState {
    const currentTime = this.now();
    if (!this.manifestConfigured || this.verifying || currentTime < this.nextAttemptAtMs) {
      return this.state;
    }
    if (this.updatedAtMs === 0 || currentTime - this.updatedAtMs >= this.refreshIntervalMs) {
      this.refresh();
    }
    return this.state;
  }

  refresh(): void {
    if (!this.manifestConfigured || this.verifying || this.now() < this.nextAttemptAtMs) return;
    const keepVerifiedState = this.updatedAtMs > 0
      && !this.state.fingerprint.startsWith("manifest-verification-pending:");
    let worker = this.worker;
    if (!worker) {
      try {
        worker = this.workerFactory();
      } catch (error) {
        this.failVerification(`Worker-Start fehlgeschlagen: ${
          error instanceof Error ? error.message : String(error)
        }`);
        return;
      }
      this.worker = worker;
      worker.on("message", (value) => {
        if (this.worker !== worker || !this.verifying) return;
        if (!isWorkerStateMessage(value)) {
          this.failVerification("Worker lieferte eine ungültige Zustandsnachricht.");
          return;
        }
        this.clearVerificationTimer();
        this.state = value.state;
        this.updatedAtMs = this.now();
        this.nextAttemptAtMs = 0;
        this.verifying = false;
      });
      worker.once("error", (error) => {
        if (this.worker === worker) this.failVerification(error.message.slice(0, 200));
      });
      worker.once("exit", (code) => {
        if (this.worker !== worker) return;
        this.worker = null;
        if (this.verifying) {
          this.failVerification(`Worker endete ohne Ergebnis (Code ${code}).`, false);
        }
      });
      worker.unref();
    }
    this.verifying = true;
    if (!keepVerifiedState) {
      this.state = pendingState("Artefakte und Sandbox werden geprüft");
    }
    this.verificationTimer = setTimeout(() => {
      this.failVerification("Artefaktprüfung überschritt ihr Zeitlimit.");
    }, this.verificationTimeoutMs);
    this.verificationTimer.unref();
    try {
      worker.postMessage({ type: "refresh" });
    } catch (error) {
      this.failVerification(`Worker-Auftrag fehlgeschlagen: ${
        error instanceof Error ? error.message : String(error)
      }`);
    }
  }

  private clearVerificationTimer(): void {
    if (this.verificationTimer) clearTimeout(this.verificationTimer);
    this.verificationTimer = null;
  }

  private failVerification(reason: string, terminate = true): void {
    this.clearVerificationTimer();
    this.state = pendingState(reason.slice(0, 200));
    this.updatedAtMs = 0;
    this.nextAttemptAtMs = this.now() + this.retryIntervalMs;
    this.verifying = false;
    const worker = this.worker;
    this.worker = null;
    if (terminate && worker) void worker.terminate().catch(() => undefined);
  }
}
