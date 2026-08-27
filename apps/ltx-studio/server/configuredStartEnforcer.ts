import {
  activationAnchorPath,
  activationJournalPath,
  activationTrustPolicyDigest,
  activationTrustPolicyPath,
  runtimeRightsSnapshotPath,
  runtimeRightsTrustPolicyDigest,
  runtimeRightsTrustPolicyPath,
  sealedRelease,
} from "./config.js";
import { releaseIdentity, revalidateReleaseIdentity } from "./releaseIdentity.js";
import { FileRuntimeActivationProvider } from "./runtimeActivationProvider.js";
import {
  activationJobStartEnforcer,
  bootstrapJobStartEnforcer,
  type JobStartEnforcer,
  type RuntimeActivationProvider,
} from "./startEnforcer.js";
import type { RuntimeTrustBinding } from "../shared/runtimeTrust.js";
import { canonicalJson } from "../shared/canonicalJson.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function buildConfiguredJobStartEnforcer(options: {
  sealed: boolean;
  identity: {
    verified: boolean;
    releaseDigest: string | null;
    surfaceDigest: string | null;
    runtimeInstallSealSha256: string | null;
    runtimeTreeSha256: string | null;
    runtimePolicySha256: string | null;
    nodeExecutableSha256: string | null;
    runtimeTrust: RuntimeTrustBinding | null;
  };
  activationTrustPolicyDigest: string;
  rightsTrustPolicyDigest: string;
  activation?: RuntimeActivationProvider;
}): JobStartEnforcer {
  if (!options.sealed) return bootstrapJobStartEnforcer(false);
  if (!options.identity.verified
    || !options.identity.releaseDigest
    || !options.identity.surfaceDigest
    || !options.identity.runtimeInstallSealSha256
    || !options.identity.runtimeTreeSha256
    || !options.identity.runtimePolicySha256
    || !options.identity.nodeExecutableSha256
    || !options.identity.runtimeTrust) {
    return bootstrapJobStartEnforcer(true);
  }
  if (!SHA256_PATTERN.test(options.activationTrustPolicyDigest)
    || !SHA256_PATTERN.test(options.rightsTrustPolicyDigest)
    || options.activationTrustPolicyDigest !== options.identity.runtimeTrust.trustPolicyDigests.activationWriter
    || options.rightsTrustPolicyDigest !== options.identity.runtimeTrust.trustPolicyDigests.runtimeRights
    || !options.activation) {
    return bootstrapJobStartEnforcer(true);
  }
  return activationJobStartEnforcer({
    expectedReleaseDigest: options.identity.releaseDigest,
    expectedSurfaceDigest: options.identity.surfaceDigest,
    expectedRuntimeInstallSealSha256: options.identity.runtimeInstallSealSha256,
    expectedRuntimeTreeSha256: options.identity.runtimeTreeSha256,
    expectedRuntimePolicySha256: options.identity.runtimePolicySha256,
    expectedNodeExecutableSha256: options.identity.nodeExecutableSha256,
    expectedRuntimeTrust: options.identity.runtimeTrust,
    activation: options.activation,
  });
}

export function configuredJobStartEnforcer(): JobStartEnforcer {
  const effectiveActivationTrustPolicyDigest = sealedRelease
    ? releaseIdentity.runtimeTrust?.trustPolicyDigests.activationWriter ?? ""
    : activationTrustPolicyDigest;
  const effectiveRightsTrustPolicyDigest = sealedRelease
    ? releaseIdentity.runtimeTrust?.trustPolicyDigests.runtimeRights ?? ""
    : runtimeRightsTrustPolicyDigest;
  const pinsPresent = SHA256_PATTERN.test(effectiveActivationTrustPolicyDigest)
    && SHA256_PATTERN.test(effectiveRightsTrustPolicyDigest);
  const identityComplete = releaseIdentity.verified
    && releaseIdentity.releaseDigest !== null
    && releaseIdentity.surfaceDigest !== null
    && releaseIdentity.runtimeInstallSealSha256 !== null
    && releaseIdentity.runtimeTreeSha256 !== null
    && releaseIdentity.runtimePolicySha256 !== null
    && releaseIdentity.nodeExecutableSha256 !== null
    && releaseIdentity.runtimeTrust !== null;
  const activation = sealedRelease && pinsPresent && identityComplete
    ? new FileRuntimeActivationProvider({
      journalPath: activationJournalPath,
      anchorPath: activationAnchorPath,
      activationTrustPolicyPath,
      activationTrustPolicyDigest: effectiveActivationTrustPolicyDigest,
      rightsSnapshotPath: runtimeRightsSnapshotPath,
      rightsTrustPolicyPath: runtimeRightsTrustPolicyPath,
      rightsTrustPolicyDigest: effectiveRightsTrustPolicyDigest,
    })
    : undefined;
  const configured = buildConfiguredJobStartEnforcer({
    sealed: sealedRelease,
    identity: releaseIdentity,
    activationTrustPolicyDigest: effectiveActivationTrustPolicyDigest,
    rightsTrustPolicyDigest: effectiveRightsTrustPolicyDigest,
    activation,
  });
  if (!sealedRelease) return configured;
  const revalidationFailure = (error: unknown) => ({
    productStartsAllowed: false,
    mode: "hold" as const,
    reason: `Release-/Runtime-/Host-TCB-Revalidierung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`,
    schemaVersion: "ltx-studio-activation-start-enforcer.v3" as const,
    generation: null,
    activationHeadSha256: null,
  });
  const revalidate = () => {
    const current = revalidateReleaseIdentity();
    for (const key of [
      "releaseDigest",
      "surfaceDigest",
      "runtimeInstallSealSha256",
      "runtimeTreeSha256",
      "runtimePolicySha256",
      "nodeExecutableSha256",
    ] as const) {
      if (current[key] !== releaseIdentity[key]) {
        throw new Error(`sealed identity changed at ${key}`);
      }
    }
    if (canonicalJson(current.runtimeTrust) !== canonicalJson(releaseIdentity.runtimeTrust)) {
      throw new Error("sealed identity changed at runtimeTrust");
    }
  };
  return {
    decide: (context) => {
      try {
        revalidate();
      } catch (error) {
        return { ...revalidationFailure(error), allowed: false };
      }
      return configured.decide(context);
    },
    inspect: () => {
      try {
        revalidate();
      } catch (error) {
        return revalidationFailure(error);
      }
      return configured.inspect();
    },
  };
}
