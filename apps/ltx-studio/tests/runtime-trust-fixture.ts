import type { RuntimeTrustBinding } from "../shared/runtimeTrust.js";

export const runtimeTrustFixture: RuntimeTrustBinding = {
  schemaVersion: "ltx-studio-runtime-trust-binding.v2",
  hostTcbAttestationSha256: "a".repeat(64),
  hostTcbContractSha256: "b".repeat(64),
  servicePolicySha256: "c".repeat(64),
  buildTcbSha256: "d".repeat(64),
  authorityIsolation: {
    schemaVersion: "ltx-studio-authority-isolation.v1",
    status: "attested",
    mechanism: "separate-studio-identity-proc-fd-isolation",
    hostTcbAttestationSha256: "a".repeat(64),
    brokerAttestationSha256: null,
    reasonCode: null,
  },
  trustPolicyDigests: {
    release: "1".repeat(64),
    activationWriter: "2".repeat(64),
    qualificationAuthorizer: "3".repeat(64),
    runtimeRights: "4".repeat(64),
    bootstrapAuthority: "5".repeat(64),
  },
};

/** Mirrors the currently observed static User=moddy service posture. */
export const sameUidRuntimeTrustFixture: RuntimeTrustBinding = {
  ...runtimeTrustFixture,
  authorityIsolation: {
    schemaVersion: "ltx-studio-authority-isolation.v1",
    status: "hold",
    mechanism: "same-local-uid",
    attestationSha256: null,
    reasonCode: "same-uid-authority-not-authentic",
  },
};
