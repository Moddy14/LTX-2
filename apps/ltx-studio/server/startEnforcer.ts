import type { ActivationState, RuntimeActivationSnapshot } from "../shared/activation.js";

export const jobStartSources = ["direct", "project", "experiment", "rerun", "restored"] as const;

export type JobStartSource = (typeof jobStartSources)[number];

export type JobStartContext = {
  requestSha256: string;
  surfaceEntryId: string;
  source: JobStartSource;
};

export type JobStartDecision = {
  allowed: boolean;
  mode: "development" | ActivationState;
  reason: string;
  schemaVersion: "ltx-studio-bootstrap-start-enforcer.v1" | "ltx-studio-activation-start-enforcer.v1";
  generation: number | null;
  activationHeadSha256: string | null;
};

export type JobStartEnforcer = {
  decide(context: JobStartContext): JobStartDecision;
};

const DEVELOPMENT_REASON = "Unversiegelter Entwicklungsmodus; Release-Autorisierung ist nicht anwendbar.";
const BLOCKED_REASON = "Versiegelter Release ist fail-closed: Es ist noch kein signierter Activation-State aktiv.";

export function bootstrapJobStartEnforcer(sealedRelease: boolean): JobStartEnforcer {
  return {
    decide: () => ({
      allowed: !sealedRelease,
      mode: sealedRelease ? "blocked" : "development",
      reason: sealedRelease ? BLOCKED_REASON : DEVELOPMENT_REASON,
      schemaVersion: "ltx-studio-bootstrap-start-enforcer.v1",
      generation: null,
      activationHeadSha256: null,
    }),
  };
}

export type RuntimeActivationProvider = {
  read(): RuntimeActivationSnapshot;
};

export function activationJobStartEnforcer(options: {
  expectedReleaseDigest: string;
  expectedSurfaceDigest: string;
  activation: RuntimeActivationProvider;
}): JobStartEnforcer {
  return {
    decide: (context) => {
      let snapshot: RuntimeActivationSnapshot;
      try {
        snapshot = options.activation.read();
      } catch (error) {
        return {
          allowed: false,
          mode: "hold",
          reason: `Activation-State ist nicht verifizierbar: ${error instanceof Error ? error.message : String(error)}`,
          schemaVersion: "ltx-studio-activation-start-enforcer.v1",
          generation: null,
          activationHeadSha256: null,
        };
      }
      const base = {
        schemaVersion: "ltx-studio-activation-start-enforcer.v1" as const,
        generation: snapshot.generation,
        activationHeadSha256: snapshot.activationHeadSha256,
      };
      if (snapshot.releaseDigest !== options.expectedReleaseDigest
        || snapshot.surfaceDigest !== options.expectedSurfaceDigest) {
        return { ...base, allowed: false, mode: "hold", reason: "Activation-State ist an einen anderen Release oder eine andere Surface gebunden." };
      }
      if (!snapshot.rightsCurrent) {
        return { ...base, allowed: false, mode: "hold", reason: "Der aktuelle Rights-Snapshot fehlt, ist veraltet oder widerrufen." };
      }
      if (snapshot.state === "production_provisional" || snapshot.state === "production_stable") {
        if (!snapshot.releasedSurfaceEntryIds.includes(context.surfaceEntryId)) {
          return { ...base, allowed: false, mode: snapshot.state, reason: `Surface-Eintrag ${context.surfaceEntryId} ist nicht released.` };
        }
        return { ...base, allowed: true, mode: snapshot.state, reason: `Surface-Eintrag ${context.surfaceEntryId} ist für den aktiven Release freigegeben.` };
      }
      if (snapshot.state === "qualification_only") {
        return { ...base, allowed: false, mode: snapshot.state, reason: "Qualification-only benötigt ein separat registriertes und atomar konsumiertes Run-Ticket." };
      }
      return { ...base, allowed: false, mode: snapshot.state, reason: `Activation-State ${snapshot.state} erlaubt keinen Jobstart.` };
    },
  };
}
