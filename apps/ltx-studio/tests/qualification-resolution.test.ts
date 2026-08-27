import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  assertQualificationArtifactCurrent,
  authorityIsolationAttestationSchema,
  buildAuthorityAttestationSchema,
  buildAuthorityResolvedBlockers,
  dischargeableQualificationBlockers,
  expectedQualificationResolutions,
  nonDischargeableQualificationBlockers,
  qualificationArtifactDigest,
  qualificationResolutionSchema,
  qualificationResolutionTrustPolicySchema,
  verifyQualificationArtifactSignature,
  type QualificationEvidenceDigests,
  type QualificationResolutionTrustRole,
} from "../shared/qualificationResolution.js";
import {
  runtimeTrustFixture,
  sameUidRuntimeTrustFixture,
} from "./runtime-trust-fixture.js";

const NOW = new Date("2026-08-25T12:00:00Z");
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

const EXPECTED_BLOCKER_MATRIX = {
  "current-signed-rights-attest-missing": ["rights-attestation"],
  "signed-build-host-container-scan-reports-missing": ["security-audit"],
  "root-owned-post-install-host-attestation-missing": ["host-tcb-attestation"],
  "dedicated-external-build-authority-attestation-missing": ["build-authority-attestation"],
  "read-only-build-source-mount-not-independently-attested": ["build-authority-attestation"],
  "separate-build-uid-isolation-not-independently-attested": ["build-authority-attestation"],
  "same-uid-transient-source-or-tool-swap-not-excluded": ["build-authority-attestation"],
  "privileged-sudo-docker-control-plane-broker-missing": ["authority-isolation-attestation"],
  "digest-bound-cold-canary-missing": ["r3-canaries-report"],
  "quality-and-holdout-evidence-missing": [
    "d1-calibration-report",
    "q0-cross-shot-report",
    "q1-comparators-report",
    "q2-holdout-report",
  ],
} as const;

function signatureFixture() {
  const keyPairs = {
    "build-authority-attestor": generateKeyPairSync("ed25519"),
    "authority-isolation-attestor": generateKeyPairSync("ed25519"),
    "qualification-resolver": generateKeyPairSync("ed25519"),
  };
  const policy = {
    schemaVersion: "ltx-studio-qualification-resolution-trust.v1" as const,
    policyId: "qualification-resolution-policy-01",
    keys: Object.entries(keyPairs).map(([role, pair]) => ({
      keyId: `${role}-key-01`,
      algorithm: "ed25519" as const,
      role: role as QualificationResolutionTrustRole,
      publicKeyBase64: pair.publicKey.export({ format: "der", type: "spki" })
        .subarray(-32).toString("base64"),
      notBefore: "2026-08-25T00:00:00Z",
      notAfter: "2026-08-26T00:00:00Z",
      revokedAt: null,
    })),
  };
  const parsedPolicy = qualificationResolutionTrustPolicySchema.parse(policy);
  const signDocument = (role: QualificationResolutionTrustRole, document: unknown) => ({
    schemaVersion: "ltx-studio-qualification-resolution-signature.v1" as const,
    algorithm: "ed25519" as const,
    role,
    keyId: `${role}-key-01`,
    payloadSha256: qualificationArtifactDigest(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      keyPairs[role].privateKey,
    ).toString("base64"),
  });
  return { policy: parsedPolicy, signDocument };
}

function evidenceDigests(): QualificationEvidenceDigests {
  return {
    "rights-attestation": digest("rights"),
    "security-audit": digest("security"),
    "host-tcb-attestation": runtimeTrustFixture.hostTcbAttestationSha256,
    "build-authority-attestation": digest("build"),
    "authority-isolation-attestation": digest("authority"),
    "r3-canaries-report": digest("r3"),
    "d1-calibration-report": digest("d1"),
    "q0-cross-shot-report": digest("q0"),
    "q1-comparators-report": digest("q1"),
    "q2-holdout-report": digest("q2"),
  };
}

describe("Qualification Resolution v2 contracts", () => {
  it("matches an independently maintained exact generator blocker matrix", () => {
    expect(dischargeableQualificationBlockers).toEqual(EXPECTED_BLOCKER_MATRIX);
    expect(nonDischargeableQualificationBlockers).toEqual([
      "longcat-runtime-worktree-dirty",
    ]);
    expect(buildAuthorityResolvedBlockers).toEqual([
      "dedicated-external-build-authority-attestation-missing",
      "read-only-build-source-mount-not-independently-attested",
      "same-uid-transient-source-or-tool-swap-not-excluded",
      "separate-build-uid-isolation-not-independently-attested",
    ]);
  });

  it("uses dedicated canonical Ed25519 signatures and exclusive key expiry", () => {
    const { policy, signDocument } = signatureFixture();
    const document = { z: 2, a: 1 };
    const signature = signDocument("qualification-resolver", document);
    expect(verifyQualificationArtifactSignature({
      document: { a: 1, z: 2 },
      signature,
      policy,
      role: "qualification-resolver",
      now: NOW,
    })).toBe(qualificationArtifactDigest(document));
    expect(() => verifyQualificationArtifactSignature({
      document,
      signature,
      policy,
      role: "build-authority-attestor",
      now: NOW,
    })).toThrow(/role binding/i);

    const revoked = structuredClone(policy);
    revoked.keys.find(({ role }) => role === "qualification-resolver")!.revokedAt = NOW.toISOString();
    expect(() => verifyQualificationArtifactSignature({
      document,
      signature,
      policy: revoked,
      role: "qualification-resolver",
      now: NOW,
    })).toThrow(/revoked/i);

    const exactExpiry = structuredClone(policy);
    exactExpiry.keys.find(({ role }) => role === "qualification-resolver")!.notAfter = NOW.toISOString();
    expect(() => verifyQualificationArtifactSignature({
      document,
      signature,
      policy: exactExpiry,
      role: "qualification-resolver",
      now: NOW,
    })).toThrow(/exclusive validity window/i);
  });

  it("requires exact Build-TCB claims and rejects same-local-uid authority", () => {
    const policyDigest = digest("qualification-policy");
    const build = {
      schemaVersion: "ltx-studio-build-authority-attestation.v1",
      releaseDigest: digest("release"),
      surfaceDigest: digest("surface"),
      runtimeTrust: runtimeTrustFixture,
      qualificationTrustPolicySha256: policyDigest,
      buildTcbSha256: runtimeTrustFixture.buildTcbSha256,
      claims: {
        dedicatedExternalBuildAuthority: true,
        readOnlyBuildSourceMount: true,
        separateBuildUid: true,
        transientSourceAndToolSwapExcluded: true,
      },
      resolvedBlockers: [...buildAuthorityResolvedBlockers],
      issuedAt: "2026-08-25T11:00:00Z",
      expiresAt: "2026-08-26T11:00:00Z",
      verdict: "pass",
      warnings: [],
    };
    expect(buildAuthorityAttestationSchema.safeParse(build).success).toBe(true);
    expect(buildAuthorityAttestationSchema.safeParse({
      ...build,
      buildTcbSha256: digest("foreign-build"),
    }).success).toBe(false);
    expect(buildAuthorityAttestationSchema.safeParse({
      ...build,
      resolvedBlockers: build.resolvedBlockers.slice(1),
    }).success).toBe(false);

    expect(authorityIsolationAttestationSchema.safeParse({
      schemaVersion: "ltx-studio-authority-isolation-attestation.v1",
      releaseDigest: digest("release"),
      surfaceDigest: digest("surface"),
      runtimeTrust: sameUidRuntimeTrustFixture,
      qualificationTrustPolicySha256: policyDigest,
      hostTcbAttestationSha256: sameUidRuntimeTrustFixture.hostTcbAttestationSha256,
      mechanism: "separate-studio-identity-proc-fd-isolation",
      brokerAttestationSha256: null,
      privilegedControlPlaneIsolationAttested: true,
      resolvedBlockers: ["privileged-sudo-docker-control-plane-broker-missing"],
      issuedAt: "2026-08-25T11:00:00Z",
      expiresAt: "2026-08-25T13:00:00Z",
      verdict: "pass",
      warnings: [],
    }).success).toBe(false);
  });

  it("enforces bounded current windows, strict schemas, exact matrix order, and no unknown blocker", () => {
    expect(() => assertQualificationArtifactCurrent({
      issuedAt: "2026-08-25T11:00:00Z",
      expiresAt: NOW.toISOString(),
    }, NOW, "fixture")).toThrow(/exclusive/i);
    expect(() => assertQualificationArtifactCurrent({
      issuedAt: "2026-08-26T11:00:00Z",
      expiresAt: "2026-08-26T12:00:00Z",
    }, NOW, "fixture")).toThrow(/future/i);

    const qualification = {
      releaseDecision: "hold" as const,
      blockers: Object.keys(EXPECTED_BLOCKER_MATRIX),
    };
    const resolution = {
      schemaVersion: "ltx-studio-qualification-resolution.v2",
      releaseDigest: digest("release"),
      surfaceDigest: digest("surface"),
      manifestQualificationSha256: digest(canonicalJson(qualification)),
      runtimeTrust: runtimeTrustFixture,
      qualificationTrustPolicySha256: digest("policy"),
      issuedAt: "2026-08-25T11:00:00Z",
      expiresAt: "2026-08-25T13:00:00Z",
      resolutions: expectedQualificationResolutions(qualification, evidenceDigests()),
      unresolvedBlockers: [],
      verdict: "pass",
      warnings: [],
    };
    expect(qualificationResolutionSchema.safeParse(resolution).success).toBe(true);
    expect(qualificationResolutionSchema.safeParse({ ...resolution, extra: true }).success).toBe(false);
    expect(qualificationResolutionSchema.safeParse({
      ...resolution,
      resolutions: [...resolution.resolutions].reverse(),
    }).success).toBe(false);
    expect(qualificationResolutionSchema.safeParse({
      ...resolution,
      resolutions: [...resolution.resolutions, resolution.resolutions[0]],
    }).success).toBe(false);
    expect(() => expectedQualificationResolutions({
      releaseDecision: "hold",
      blockers: ["future-unknown-blocker"],
    }, evidenceDigests())).toThrow(/unknown/i);
  });
});
