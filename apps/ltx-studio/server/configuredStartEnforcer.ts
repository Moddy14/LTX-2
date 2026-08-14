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
import { releaseIdentity } from "./releaseIdentity.js";
import { FileRuntimeActivationProvider } from "./runtimeActivationProvider.js";
import {
  activationJobStartEnforcer,
  bootstrapJobStartEnforcer,
  type JobStartEnforcer,
  type RuntimeActivationProvider,
} from "./startEnforcer.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function buildConfiguredJobStartEnforcer(options: {
  sealed: boolean;
  identity: {
    verified: boolean;
    releaseDigest: string | null;
    surfaceDigest: string | null;
  };
  activationTrustPolicyDigest: string;
  rightsTrustPolicyDigest: string;
  activation?: RuntimeActivationProvider;
}): JobStartEnforcer {
  if (!options.sealed) return bootstrapJobStartEnforcer(false);
  if (!options.identity.verified || !options.identity.releaseDigest || !options.identity.surfaceDigest) {
    return bootstrapJobStartEnforcer(true);
  }
  if (!SHA256_PATTERN.test(options.activationTrustPolicyDigest)
    || !SHA256_PATTERN.test(options.rightsTrustPolicyDigest)
    || !options.activation) {
    return bootstrapJobStartEnforcer(true);
  }
  return activationJobStartEnforcer({
    expectedReleaseDigest: options.identity.releaseDigest,
    expectedSurfaceDigest: options.identity.surfaceDigest,
    activation: options.activation,
  });
}

export function configuredJobStartEnforcer(): JobStartEnforcer {
  const pinsPresent = SHA256_PATTERN.test(activationTrustPolicyDigest)
    && SHA256_PATTERN.test(runtimeRightsTrustPolicyDigest);
  const identityComplete = releaseIdentity.verified
    && releaseIdentity.releaseDigest !== null
    && releaseIdentity.surfaceDigest !== null;
  const activation = sealedRelease && pinsPresent && identityComplete
    ? new FileRuntimeActivationProvider({
      journalPath: activationJournalPath,
      anchorPath: activationAnchorPath,
      activationTrustPolicyPath,
      activationTrustPolicyDigest,
      rightsSnapshotPath: runtimeRightsSnapshotPath,
      rightsTrustPolicyPath: runtimeRightsTrustPolicyPath,
      rightsTrustPolicyDigest: runtimeRightsTrustPolicyDigest,
    })
    : undefined;
  return buildConfiguredJobStartEnforcer({
    sealed: sealedRelease,
    identity: releaseIdentity,
    activationTrustPolicyDigest,
    rightsTrustPolicyDigest: runtimeRightsTrustPolicyDigest,
    activation,
  });
}
