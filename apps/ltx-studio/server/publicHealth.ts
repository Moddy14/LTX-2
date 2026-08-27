import {
  publicJobPersistenceHoldError,
  publicJobPersistenceHoldHealth,
  publicHealthSchema,
  type PublicHealth,
  type PublicJobPersistenceHoldError,
  type PublicT2aAudioEvaluatorBlockerCode,
  type PublicT2aAudioEvaluatorCapability,
} from "../shared/healthPublic.js";

export type T2aAudioEvaluatorCapabilityInput = {
  sealed: boolean;
  verified: boolean;
  authorityIsolation: null | { status: "attested" | "hold" };
  analysisRuntimeAvailable: boolean;
  developmentMeasurementEnabled: boolean;
};

function blockedT2aAudioCapability(
  blockerCode: Exclude<
    PublicT2aAudioEvaluatorBlockerCode,
    "none" | "development-runtime-unattested"
  >,
  message: string,
): PublicT2aAudioEvaluatorCapability {
  return {
    status: "blocked",
    claimScope: null,
    blockerCode,
    message,
    productGo: "blocked",
    measurementReady: false,
  };
}

export function resolveT2aAudioEvaluatorCapability(
  input: T2aAudioEvaluatorCapabilityInput,
): PublicT2aAudioEvaluatorCapability {
  if (input.sealed) {
    if (!input.verified) {
      return blockedT2aAudioCapability(
        "release-not-verified",
        "T2A-Audio-QA ist blockiert, weil die versiegelte Release-Identitaet nicht verifiziert ist.",
      );
    }
    if (input.authorityIsolation?.status !== "attested") {
      return blockedT2aAudioCapability(
        "authority-isolation-unattested",
        "T2A-Audio-QA ist blockiert, weil die Ausfuehrungsautoritaet nicht attestiert isoliert ist.",
      );
    }
    if (!input.analysisRuntimeAvailable) {
      return blockedT2aAudioCapability(
        "analysis-runtime-unavailable",
        "T2A-Audio-QA ist blockiert, weil die lokale Analyse-Laufzeit nicht verfuegbar ist.",
      );
    }
    return {
      status: "authoritative",
      claimScope: "sealed-release",
      blockerCode: "none",
      message: "Die versiegelte T2A-Evaluator-Authority ist messbereit; die Qualitaet einzelner Clips bleibt ungeprueft.",
      productGo: "blocked",
      measurementReady: true,
    };
  }
  if (!input.developmentMeasurementEnabled) {
    return blockedT2aAudioCapability(
      "development-opt-in-required",
      "T2A-Audio-QA benoetigt in der Entwicklungs-Laufzeit ein ausdrueckliches Mess-Opt-in.",
    );
  }
  if (!input.analysisRuntimeAvailable) {
    return blockedT2aAudioCapability(
      "analysis-runtime-unavailable",
      "T2A-Audio-QA ist blockiert, weil die lokale Analyse-Laufzeit nicht verfuegbar ist.",
    );
  }
  return {
    status: "development-measurement",
    claimScope: "development",
    blockerCode: "development-runtime-unattested",
    message: "T2A-Audio-QA misst im Entwicklungsmodus; diese Messung ist keine Produktfreigabe.",
    productGo: "blocked",
    measurementReady: true,
  };
}

export class T2aAudioEvaluatorUnavailableError extends Error {
  readonly statusCode = 503;

  constructor(
    readonly blockerCode: PublicT2aAudioEvaluatorBlockerCode | "evaluator-start-failed",
    message: string,
    readonly correlationId: string,
  ) {
    super(message);
    this.name = "T2aAudioEvaluatorUnavailableError";
  }

  static fromCapability(
    capability: PublicT2aAudioEvaluatorCapability,
    correlationId: string,
  ): T2aAudioEvaluatorUnavailableError {
    return new T2aAudioEvaluatorUnavailableError(
      capability.blockerCode,
      capability.message,
      correlationId,
    );
  }

  static startFailed(correlationId: string): T2aAudioEvaluatorUnavailableError {
    return new T2aAudioEvaluatorUnavailableError(
      "evaluator-start-failed",
      "T2A-Audio-QA konnte nicht sicher gestartet werden.",
      correlationId,
    );
  }
}

type PublicHealthInput = {
  state: "ready" | "blocked";
  release: {
    sealed: boolean;
    verified: boolean;
    authorityIsolation: null
      | {
          status: "attested";
          mechanism:
            | "separate-studio-identity-proc-fd-isolation"
            | "external-signer-sealed-fd-broker";
          reasonCode: null;
        }
      | {
          status: "hold";
          mechanism: "same-local-uid";
          reasonCode: "same-uid-authority-not-authentic";
        };
  };
  resources: {
    availableMemoryGiB: number | null;
    totalMemoryGiB: number | null;
    swapFreeGiB: number | null;
    swapTotalGiB: number | null;
    outputFreeGiB: number | null;
  };
  engine: "available" | "missing";
  analysisEngine: "available" | "missing";
  orchestrator: "available" | "missing" | "disabled";
  qwen: "ready" | "busy" | "offline";
  runtimeOverall: string;
  workloads: readonly {
    id: "qwen" | "avatar" | "comfyui";
    label: string;
    state: string;
    protected: boolean;
    estimatedMemoryGiB: number | null;
  }[];
  evaluators: {
    phonemeViseme: {
      status: "measured" | "measurement-only" | "insufficient" | "not-available" | "failed" | "not-applicable";
      blockerCode: string;
      message: string | null;
      productGo: "passed" | "blocked";
      measurementReady: boolean;
      method: "mfa-mediapipe-de.v1" | "ctc-espeak-mediapipe-de.v1" | null;
    };
    t2aAudio: PublicT2aAudioEvaluatorCapability;
  };
  jobPersistence?:
    | { status: "ok"; restartRequired: false }
    | {
        status: "hold";
        restartRequired: true;
        code?: string;
        reason?: string;
      };
  queueDepth: number;
};

export function toPublicJobPersistenceHoldError(): PublicJobPersistenceHoldError {
  return publicJobPersistenceHoldError();
}

export function toPublicHealth(input: PublicHealthInput): PublicHealth {
  const authorityIsolation = input.release.authorityIsolation;
  return publicHealthSchema.parse({
    state: input.state,
    release: {
      sealed: input.release.sealed,
      verified: input.release.verified,
      authorityIsolation: authorityIsolation
        ? {
            status: authorityIsolation.status,
            mechanism: authorityIsolation.mechanism,
            reasonCode: authorityIsolation.reasonCode,
          }
        : {
            status: "hold",
            mechanism: "unattested-development",
            reasonCode: "runtime-trust-unavailable",
          },
    },
    resources: {
      availableMemoryGiB: input.resources.availableMemoryGiB,
      totalMemoryGiB: input.resources.totalMemoryGiB,
      swapFreeGiB: input.resources.swapFreeGiB,
      swapTotalGiB: input.resources.swapTotalGiB,
      outputFreeGiB: input.resources.outputFreeGiB,
    },
    engine: input.engine,
    analysisEngine: input.analysisEngine,
    orchestrator: input.orchestrator,
    qwen: input.qwen,
    runtimeOverall: input.runtimeOverall,
    workloads: input.workloads.map((workload) => ({
      id: workload.id,
      label: workload.label,
      state: workload.state,
      protected: workload.protected,
      estimatedMemoryGiB: workload.estimatedMemoryGiB,
    })),
    evaluators: {
      phonemeViseme: {
        status: input.evaluators.phonemeViseme.status,
        blockerCode: input.evaluators.phonemeViseme.blockerCode,
        message: input.evaluators.phonemeViseme.message,
        productGo: input.evaluators.phonemeViseme.productGo,
        measurementReady: input.evaluators.phonemeViseme.measurementReady,
        method: input.evaluators.phonemeViseme.method,
      },
      t2aAudio: {
        status: input.evaluators.t2aAudio.status,
        claimScope: input.evaluators.t2aAudio.claimScope,
        blockerCode: input.evaluators.t2aAudio.blockerCode,
        message: input.evaluators.t2aAudio.message,
        productGo: input.evaluators.t2aAudio.productGo,
        measurementReady: input.evaluators.t2aAudio.measurementReady,
      },
    },
    jobPersistence: input.jobPersistence?.status === "hold"
      ? publicJobPersistenceHoldHealth()
      : { status: "ok", restartRequired: false },
    queueDepth: input.queueDepth,
  });
}
