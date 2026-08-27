import { describe, expect, it } from "vitest";

import { buildConfiguredJobStartEnforcer } from "../server/configuredStartEnforcer.js";
import { runtimeTrustFixture } from "./runtime-trust-fixture.js";

const context = {
  requestSha256: "a".repeat(64),
  surfaceEntryId: "two-stage.text.prompt.base-gemma.post.none",
  source: "direct" as const,
};

describe("configured job-start enforcer", () => {
  it("keeps development available without pretending it is a sealed activation", () => {
    expect(buildConfiguredJobStartEnforcer({
      sealed: false,
      identity: {
        verified: false,
        releaseDigest: null,
        surfaceDigest: null,
        runtimeInstallSealSha256: null,
        runtimeTreeSha256: null,
        runtimePolicySha256: null,
        nodeExecutableSha256: null,
        runtimeTrust: null,
      },
      activationTrustPolicyDigest: "",
      rightsTrustPolicyDigest: "",
    }).decide(context)).toMatchObject({ allowed: true, mode: "development" });
  });

  it("fails a sealed release closed when identity, pins, or provider are missing", () => {
    const completeIdentity = {
      verified: true,
      releaseDigest: "b".repeat(64),
      surfaceDigest: "c".repeat(64),
      runtimeInstallSealSha256: "1".repeat(64),
      runtimeTreeSha256: "2".repeat(64),
      runtimePolicySha256: "3".repeat(64),
      nodeExecutableSha256: "4".repeat(64),
      runtimeTrust: runtimeTrustFixture,
    };
    expect(buildConfiguredJobStartEnforcer({
      sealed: true,
      identity: completeIdentity,
      activationTrustPolicyDigest: "",
      rightsTrustPolicyDigest: runtimeTrustFixture.trustPolicyDigests.runtimeRights,
    }).decide(context)).toMatchObject({ allowed: false, mode: "blocked" });
    expect(buildConfiguredJobStartEnforcer({
      sealed: true,
      identity: completeIdentity,
      activationTrustPolicyDigest: runtimeTrustFixture.trustPolicyDigests.activationWriter,
      rightsTrustPolicyDigest: runtimeTrustFixture.trustPolicyDigests.runtimeRights,
    }).decide(context)).toMatchObject({ allowed: false, mode: "blocked" });
  });

  it("uses the verified activation provider only with exact static trust pins", () => {
    const enforcer = buildConfiguredJobStartEnforcer({
      sealed: true,
      identity: {
        verified: true,
        releaseDigest: "b".repeat(64),
        surfaceDigest: "c".repeat(64),
        runtimeInstallSealSha256: "1".repeat(64),
        runtimeTreeSha256: "2".repeat(64),
        runtimePolicySha256: "3".repeat(64),
        nodeExecutableSha256: "4".repeat(64),
        runtimeTrust: runtimeTrustFixture,
      },
      activationTrustPolicyDigest: runtimeTrustFixture.trustPolicyDigests.activationWriter,
      rightsTrustPolicyDigest: runtimeTrustFixture.trustPolicyDigests.runtimeRights,
      activation: {
        read: () => ({
          state: "production_stable",
          generation: 2,
          activationHeadSha256: "f".repeat(64),
          releaseDigest: "b".repeat(64),
          surfaceDigest: "c".repeat(64),
          runtimeInstallSealSha256: "1".repeat(64),
          runtimeTreeSha256: "2".repeat(64),
          runtimePolicySha256: "3".repeat(64),
          nodeExecutableSha256: "4".repeat(64),
          runtimeTrust: runtimeTrustFixture,
          rightsCurrent: true,
          releasedSurfaceEntryIds: [context.surfaceEntryId],
        }),
      },
    });
    expect(enforcer.decide(context)).toMatchObject({ allowed: true, mode: "production_stable" });
  });
});
