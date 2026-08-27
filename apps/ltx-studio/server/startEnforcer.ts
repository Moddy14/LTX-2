import type { ActivationState, RuntimeActivationSnapshot } from "../shared/activation.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import {
  assertRuntimeTrustAuthorizesRelease,
  type RuntimeTrustBinding,
} from "../shared/runtimeTrust.js";
import { deriveReleaseSurfaceEntries } from "../shared/releaseSurface.js";

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
  schemaVersion: "ltx-studio-bootstrap-start-enforcer.v3" | "ltx-studio-activation-start-enforcer.v3";
  generation: number | null;
  activationHeadSha256: string | null;
};

export type JobStartStatus = Omit<JobStartDecision, "allowed"> & {
  productStartsAllowed: boolean;
};

export type JobStartEnforcer = {
  decide(context: JobStartContext): JobStartDecision;
  inspect(): JobStartStatus;
};

const DEVELOPMENT_REASON = "Unversiegelter Entwicklungsmodus; Release-Autorisierung ist nicht anwendbar.";
const BLOCKED_REASON = "Versiegelter Release ist fail-closed: Es ist noch kein signierter Activation-State aktiv.";
const ACTIVATABLE_SURFACE_ENTRY_IDS = new Set(
  deriveReleaseSurfaceEntries()
    .filter(({ targetStatus }) => targetStatus === "candidate")
    .map(({ id }) => id),
);

export function bootstrapJobStartEnforcer(sealedRelease: boolean): JobStartEnforcer {
  const status: JobStartStatus = {
    productStartsAllowed: !sealedRelease,
    mode: sealedRelease ? "blocked" : "development",
    reason: sealedRelease ? BLOCKED_REASON : DEVELOPMENT_REASON,
    schemaVersion: "ltx-studio-bootstrap-start-enforcer.v3",
    generation: null,
    activationHeadSha256: null,
  };
  return {
    decide: () => ({ ...status, allowed: status.productStartsAllowed }),
    inspect: () => ({ ...status }),
  };
}

export type RuntimeActivationProvider = {
  read(): RuntimeActivationSnapshot;
};

export function activationJobStartEnforcer(options: {
  expectedReleaseDigest: string;
  expectedSurfaceDigest: string;
  expectedRuntimeInstallSealSha256: string;
  expectedRuntimeTreeSha256: string;
  expectedRuntimePolicySha256: string;
  expectedNodeExecutableSha256: string;
  expectedRuntimeTrust: RuntimeTrustBinding;
  activation: RuntimeActivationProvider;
}): JobStartEnforcer {
  const inspect = (): JobStartStatus & { snapshot: RuntimeActivationSnapshot | null } => {
    let snapshot: RuntimeActivationSnapshot;
    const failure = (reason: string): JobStartStatus & { snapshot: null } => ({
      productStartsAllowed: false,
      mode: "hold",
      reason,
      schemaVersion: "ltx-studio-activation-start-enforcer.v3",
      generation: null,
      activationHeadSha256: null,
      snapshot: null,
    });
    try {
      assertRuntimeTrustAuthorizesRelease(options.expectedRuntimeTrust, "Product start");
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
    try {
      snapshot = options.activation.read();
    } catch (error) {
      return failure(`Activation-State ist nicht verifizierbar: ${error instanceof Error ? error.message : String(error)}`);
    }
    const base = {
      schemaVersion: "ltx-studio-activation-start-enforcer.v3" as const,
      generation: snapshot.generation,
      activationHeadSha256: snapshot.activationHeadSha256,
      snapshot,
    };
    if (snapshot.releaseDigest !== options.expectedReleaseDigest
      || snapshot.surfaceDigest !== options.expectedSurfaceDigest
      || snapshot.runtimeInstallSealSha256 !== options.expectedRuntimeInstallSealSha256
      || snapshot.runtimeTreeSha256 !== options.expectedRuntimeTreeSha256
      || snapshot.runtimePolicySha256 !== options.expectedRuntimePolicySha256
      || snapshot.nodeExecutableSha256 !== options.expectedNodeExecutableSha256
      || canonicalJson(snapshot.runtimeTrust) !== canonicalJson(options.expectedRuntimeTrust)) {
      return { ...base, snapshot: null, productStartsAllowed: false, mode: "hold", reason: "Activation-State ist an eine andere Release- oder Runtime-Identität gebunden." };
    }
    if (!snapshot.rightsCurrent) {
      return { ...base, snapshot: null, productStartsAllowed: false, mode: "hold", reason: "Der aktuelle Rights-Snapshot fehlt, ist veraltet oder widerrufen." };
    }
    const nonActivatableEntryId = snapshot.releasedSurfaceEntryIds.find(
      (id) => !ACTIVATABLE_SURFACE_ENTRY_IDS.has(id),
    );
    if (nonActivatableEntryId) {
      return {
        ...base,
        snapshot: null,
        productStartsAllowed: false,
        mode: "hold",
        reason: `Activation-State enthält den blockierten oder nicht deklarierten Surface-Eintrag ${nonActivatableEntryId}.`,
      };
    }
    const productStartsAllowed = (snapshot.state === "production_provisional" || snapshot.state === "production_stable")
      && snapshot.releasedSurfaceEntryIds.length > 0;
    return {
      ...base,
      productStartsAllowed,
      mode: snapshot.state,
      reason: productStartsAllowed
        ? `${snapshot.releasedSurfaceEntryIds.length} Surface-Einträge sind für den aktiven Release freigegeben.`
        : snapshot.state === "qualification_only"
          ? "Qualification-only benötigt separat registrierte und atomar konsumierte Run-Tickets."
          : `Activation-State ${snapshot.state} erlaubt keinen Produktstart.`,
    };
  };
  const publicStatus = (value: JobStartStatus & { snapshot: RuntimeActivationSnapshot | null }): JobStartStatus => ({
    productStartsAllowed: value.productStartsAllowed,
    mode: value.mode,
    reason: value.reason,
    schemaVersion: value.schemaVersion,
    generation: value.generation,
    activationHeadSha256: value.activationHeadSha256,
  });
  return {
    decide: (context) => {
      const inspected = inspect();
      const snapshot = inspected.snapshot;
      const status = publicStatus(inspected);
      if (!snapshot) return { ...status, allowed: false };
      if (snapshot.state === "production_provisional" || snapshot.state === "production_stable") {
        if (!snapshot.releasedSurfaceEntryIds.includes(context.surfaceEntryId)) {
          return { ...status, allowed: false, mode: snapshot.state, reason: `Surface-Eintrag ${context.surfaceEntryId} ist nicht released.` };
        }
        return { ...status, allowed: true, mode: snapshot.state, reason: `Surface-Eintrag ${context.surfaceEntryId} ist für den aktiven Release freigegeben.` };
      }
      if (snapshot.state === "qualification_only") {
        return { ...status, allowed: false, mode: snapshot.state, reason: "Qualification-only benötigt ein separat registriertes und atomar konsumiertes Run-Ticket." };
      }
      return { ...status, allowed: false, mode: snapshot.state, reason: `Activation-State ${snapshot.state} erlaubt keinen Jobstart.` };
    },
    inspect: () => publicStatus(inspect()),
  };
}
