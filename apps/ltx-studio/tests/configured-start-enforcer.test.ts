import { describe, expect, it } from "vitest";

import { buildConfiguredJobStartEnforcer } from "../server/configuredStartEnforcer.js";

const context = {
  requestSha256: "a".repeat(64),
  surfaceEntryId: "two-stage.text.prompt.base-gemma.post.none",
  source: "direct" as const,
};

describe("configured job-start enforcer", () => {
  it("keeps development available without pretending it is a sealed activation", () => {
    expect(buildConfiguredJobStartEnforcer({
      sealed: false,
      identity: { verified: false, releaseDigest: null, surfaceDigest: null },
      activationTrustPolicyDigest: "",
      rightsTrustPolicyDigest: "",
    }).decide(context)).toMatchObject({ allowed: true, mode: "development" });
  });

  it("fails a sealed release closed when identity, pins, or provider are missing", () => {
    const completeIdentity = {
      verified: true,
      releaseDigest: "b".repeat(64),
      surfaceDigest: "c".repeat(64),
    };
    expect(buildConfiguredJobStartEnforcer({
      sealed: true,
      identity: completeIdentity,
      activationTrustPolicyDigest: "",
      rightsTrustPolicyDigest: "d".repeat(64),
    }).decide(context)).toMatchObject({ allowed: false, mode: "blocked" });
    expect(buildConfiguredJobStartEnforcer({
      sealed: true,
      identity: completeIdentity,
      activationTrustPolicyDigest: "e".repeat(64),
      rightsTrustPolicyDigest: "d".repeat(64),
    }).decide(context)).toMatchObject({ allowed: false, mode: "blocked" });
  });

  it("uses the verified activation provider only with exact static trust pins", () => {
    const enforcer = buildConfiguredJobStartEnforcer({
      sealed: true,
      identity: { verified: true, releaseDigest: "b".repeat(64), surfaceDigest: "c".repeat(64) },
      activationTrustPolicyDigest: "e".repeat(64),
      rightsTrustPolicyDigest: "d".repeat(64),
      activation: {
        read: () => ({
          state: "production_stable",
          generation: 2,
          activationHeadSha256: "f".repeat(64),
          releaseDigest: "b".repeat(64),
          surfaceDigest: "c".repeat(64),
          rightsCurrent: true,
          releasedSurfaceEntryIds: [context.surfaceEntryId],
        }),
      },
    });
    expect(enforcer.decide(context)).toMatchObject({ allowed: true, mode: "production_stable" });
  });
});
