import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { runtimeTrustBindingFromHostAttestation } from "../scripts/host-tcb-attestation-lib.mjs";
import { canonicalJson } from "../shared/canonicalJson.js";
import {
  assertRuntimeTrustAuthorizesRelease,
  runtimeTrustBindingSchema,
} from "../shared/runtimeTrust.js";
import { validateReleaseSecurityAudit } from "../shared/securityAudit.js";
import {
  collectReleaseEvidence,
  finalizeReleaseAudit,
  verifyReleasePromotionBundle,
} from "../shared/releaseAudit.js";
import {
  runtimeTrustFixture,
  sameUidRuntimeTrustFixture,
} from "./runtime-trust-fixture.js";

const trustPolicyDigests = {
  release: "1".repeat(64),
  activationWriter: "2".repeat(64),
  qualificationAuthorizer: "3".repeat(64),
  runtimeRights: "4".repeat(64),
  bootstrapAuthority: "5".repeat(64),
};

function hostRecord(isolation: Record<string, unknown>) {
  const servicePolicy = { privilegedControlPlaneIsolation: isolation };
  return {
    schemaVersion: "ltx-studio-host-tcb-attestation.v2",
    hostTcbContractSha256: "a".repeat(64),
    servicePolicy,
    servicePolicySha256: createHash("sha256").update(canonicalJson(servicePolicy)).digest("hex"),
    buildTcbSha256: "b".repeat(64),
  };
}

describe("RuntimeTrust authority isolation", () => {
  it("rejects legacy/missing isolation and exposes the current same-UID state as HOLD", () => {
    expect(runtimeTrustBindingSchema.safeParse({
      ...runtimeTrustFixture,
      schemaVersion: "ltx-studio-runtime-trust-binding.v1",
      authorityIsolation: undefined,
    }).success).toBe(false);
    expect(() => assertRuntimeTrustAuthorizesRelease(
      sameUidRuntimeTrustFixture,
      "Product GO",
    )).toThrow(/same-local-UID.*not authentic/i);
    expect(assertRuntimeTrustAuthorizesRelease(runtimeTrustFixture)).toEqual(runtimeTrustFixture);
    expect(runtimeTrustBindingSchema.safeParse({
      ...runtimeTrustFixture,
      authorityIsolation: {
        ...runtimeTrustFixture.authorityIsolation,
        hostTcbAttestationSha256: "0".repeat(64),
      },
    }).success).toBe(false);
  });

  it("derives HOLD from the signed effective service facts instead of a caller claim", () => {
    const runtimeTrust = runtimeTrustBindingFromHostAttestation({
      record: hostRecord({
        status: "hold",
        mechanism: "same-local-uid",
        sameUidProcFdTamperingExcluded: false,
        externalSignerSealedFdBrokerAttested: false,
        reasonCode: "same-uid-authority-not-authentic",
      }),
      attestationSha256: "c".repeat(64),
      trustPolicyDigests,
      // Deliberately ignored: callers cannot promote signed HOLD facts.
      authorityIsolation: runtimeTrustFixture.authorityIsolation,
    });
    expect(runtimeTrust.authorityIsolation).toEqual({
      schemaVersion: "ltx-studio-authority-isolation.v1",
      status: "hold",
      mechanism: "same-local-uid",
      attestationSha256: null,
      reasonCode: "same-uid-authority-not-authentic",
    });
  });

  it("accepts only concrete separate-identity/proc-fd or broker attestation facts", () => {
    const separateIdentity = runtimeTrustBindingFromHostAttestation({
      record: hostRecord({
        status: "attested",
        mechanism: "separate-studio-identity-proc-fd-isolation",
        sameUidProcFdTamperingExcluded: true,
        studioUid: 991,
        authorityOwnerUid: 0,
        protectProc: "invisible",
        procSubset: "pid",
      }),
      attestationSha256: "d".repeat(64),
      trustPolicyDigests,
    });
    expect(assertRuntimeTrustAuthorizesRelease(separateIdentity).authorityIsolation.status)
      .toBe("attested");

    expect(() => runtimeTrustBindingFromHostAttestation({
      record: hostRecord({
        status: "attested",
        mechanism: "separate-studio-identity-proc-fd-isolation",
        sameUidProcFdTamperingExcluded: true,
        studioUid: 1000,
        authorityOwnerUid: 1000,
        protectProc: "default",
        procSubset: "all",
      }),
      attestationSha256: "e".repeat(64),
      trustPolicyDigests,
    })).toThrow(/does not attest a recognized/i);

    const broker = runtimeTrustBindingFromHostAttestation({
      record: hostRecord({
        status: "attested",
        mechanism: "external-signer-sealed-fd-broker",
        externalSignerSealedFdBrokerAttested: true,
        brokerAttestationSha256: "f".repeat(64),
      }),
      attestationSha256: "0".repeat(64),
      trustPolicyDigests,
    });
    expect(broker.authorityIsolation.mechanism).toBe("external-signer-sealed-fd-broker");
    expect(broker.authorityIsolation.hostTcbAttestationSha256).toBe("0".repeat(64));
    expect(broker.authorityIsolation.brokerAttestationSha256).toBe("f".repeat(64));
    expect(runtimeTrustBindingSchema.safeParse({
      ...broker,
      hostTcbAttestationSha256: "1".repeat(64),
    }).success).toBe(false);
    expect(runtimeTrustBindingSchema.safeParse({
      ...broker,
      authorityIsolation: {
        ...broker.authorityIsolation,
        brokerAttestationSha256: "not-a-digest",
      },
    }).success).toBe(false);
  });

  it("mechanically blocks Security GO, evidence readiness, finalization, and promotion on HOLD", () => {
    const now = new Date("2026-08-25T12:00:00Z");
    const securityBinding = { runtimeTrust: sameUidRuntimeTrustFixture };
    try {
      validateReleaseSecurityAudit(null, securityBinding as never, now, () => Buffer.alloc(0));
      throw new Error("security validation unexpectedly accepted HOLD");
    } catch (error) {
      expect(error).toMatchObject({ code: "runtime-authority-isolation-hold" });
    }
    expect(() => collectReleaseEvidence({
      now,
      securityAuditBinding: securityBinding,
    } as never)).toThrow(/Release evidence\/Product GO blocked.*same-local-UID/i);
    expect(() => finalizeReleaseAudit({
      now,
      securityAuditBinding: securityBinding,
    } as never)).toThrow(/Release finalization\/Product GO blocked.*same-local-UID/i);
    expect(() => verifyReleasePromotionBundle({
      expectedRuntimeTrust: sameUidRuntimeTrustFixture,
    } as never)).toThrow(/Release promotion\/Product GO blocked.*same-local-UID/i);
  });

  it("mechanically blocks every immutable manifest HOLD at Security GO", () => {
    const now = new Date("2026-08-25T12:00:00Z");
    for (const blocker of [
      "current-signed-rights-attest-missing",
      "signed-build-host-container-scan-reports-missing",
      "root-owned-post-install-host-attestation-missing",
      "dedicated-external-build-authority-attestation-missing",
      "read-only-build-source-mount-not-independently-attested",
      "separate-build-uid-isolation-not-independently-attested",
      "same-uid-transient-source-or-tool-swap-not-excluded",
      "privileged-sudo-docker-control-plane-broker-missing",
      "longcat-runtime-worktree-dirty",
      "digest-bound-cold-canary-missing",
      "quality-and-holdout-evidence-missing",
    ]) {
      const securityBinding = {
        runtimeTrust: runtimeTrustFixture,
        manifestQualification: { releaseDecision: "hold", blockers: [blocker] },
      };
      try {
        validateReleaseSecurityAudit(null, securityBinding as never, now, () => Buffer.alloc(0));
        throw new Error("security validation unexpectedly accepted manifest HOLD");
      } catch (error) {
        expect(error).toMatchObject({ code: "manifest-qualification-hold" });
      }
    }
  });
});
