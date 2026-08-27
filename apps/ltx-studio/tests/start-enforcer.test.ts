import { describe, expect, it } from "vitest";

import {
  activationJobStartEnforcer,
  bootstrapJobStartEnforcer,
  jobStartSources,
} from "../server/startEnforcer.js";
import { releaseSurfaceEntryForRequest } from "../shared/releaseSurface.js";
import { validLtx25SplitRequest } from "./fixtures.js";
import { runtimeTrustFixture, sameUidRuntimeTrustFixture } from "./runtime-trust-fixture.js";

const digest = (character: string) => character.repeat(64);
const context = {
  requestSha256: digest("a"),
  surfaceEntryId: "two-stage.text.prompt.base-gemma.post.none",
  source: "direct" as const,
};

describe("bootstrap job-start enforcer", () => {
  it("fails closed for every start source in a sealed release", () => {
    const enforcer = bootstrapJobStartEnforcer(true);

    for (const source of jobStartSources) {
      expect(enforcer.decide({ ...context, source })).toMatchObject({
        allowed: false,
        mode: "blocked",
        schemaVersion: "ltx-studio-bootstrap-start-enforcer.v3",
      });
    }
  });

  it("keeps the explicitly unsealed development workflow available", () => {
    expect(bootstrapJobStartEnforcer(false).decide({
      ...context,
      requestSha256: digest("b"),
    })).toMatchObject({
      allowed: true,
      mode: "development",
    });
  });

  it("allows only explicitly released entries in a bound production state", () => {
    const enforcer = activationJobStartEnforcer({
      expectedReleaseDigest: digest("b"),
      expectedSurfaceDigest: digest("c"),
      expectedRuntimeInstallSealSha256: digest("1"),
      expectedRuntimeTreeSha256: digest("2"),
      expectedRuntimePolicySha256: digest("3"),
      expectedNodeExecutableSha256: digest("4"),
      expectedRuntimeTrust: runtimeTrustFixture,
      activation: {
        read: () => ({
          state: "production_provisional",
          generation: 3,
          activationHeadSha256: digest("d"),
          releaseDigest: digest("b"),
          surfaceDigest: digest("c"),
          runtimeInstallSealSha256: digest("1"),
          runtimeTreeSha256: digest("2"),
          runtimePolicySha256: digest("3"),
          nodeExecutableSha256: digest("4"),
          runtimeTrust: runtimeTrustFixture,
          rightsCurrent: true,
          releasedSurfaceEntryIds: [context.surfaceEntryId],
        }),
      },
    });

    expect(enforcer.decide(context)).toMatchObject({ allowed: true, mode: "production_provisional", generation: 3 });
    expect(enforcer.inspect()).toMatchObject({ productStartsAllowed: true, mode: "production_provisional" });
    expect(enforcer.decide({ ...context, surfaceEntryId: "blocked.surface.entry" })).toMatchObject({
      allowed: false,
      mode: "production_provisional",
    });
  });

  it("rejects a blocked release-surface target even when an activation names its id", () => {
    const blockedEntry = releaseSurfaceEntryForRequest(validLtx25SplitRequest("dfr"));
    expect(blockedEntry.targetStatus).toBe("blocked");
    const enforcer = activationJobStartEnforcer({
      expectedReleaseDigest: digest("b"),
      expectedSurfaceDigest: digest("c"),
      expectedRuntimeInstallSealSha256: digest("1"),
      expectedRuntimeTreeSha256: digest("2"),
      expectedRuntimePolicySha256: digest("3"),
      expectedNodeExecutableSha256: digest("4"),
      expectedRuntimeTrust: runtimeTrustFixture,
      activation: {
        read: () => ({
          state: "production_stable",
          generation: 4,
          activationHeadSha256: digest("d"),
          releaseDigest: digest("b"),
          surfaceDigest: digest("c"),
          runtimeInstallSealSha256: digest("1"),
          runtimeTreeSha256: digest("2"),
          runtimePolicySha256: digest("3"),
          nodeExecutableSha256: digest("4"),
          runtimeTrust: runtimeTrustFixture,
          rightsCurrent: true,
          releasedSurfaceEntryIds: [blockedEntry.id],
        }),
      },
    });

    expect(enforcer.inspect()).toMatchObject({ productStartsAllowed: false, mode: "hold" });
    expect(enforcer.decide({ ...context, surfaceEntryId: blockedEntry.id })).toMatchObject({
      allowed: false,
      mode: "hold",
      reason: expect.stringContaining("blockierten"),
    });
  });

  it("does not let a released generic T2A surface authorize a verbatim-dialogue request", () => {
    const genericRequest = validLtx25SplitRequest("text-to-audio");
    genericRequest.promptParts.dialogue = "";
    const exactRequest = structuredClone(genericRequest);
    exactRequest.promptParts.dialogue = "Dieser Wortlaut muss exakt gesprochen werden.";
    const genericSurfaceEntryId = releaseSurfaceEntryForRequest(genericRequest).id;
    const exactSurfaceEntryId = releaseSurfaceEntryForRequest(exactRequest).id;
    expect(exactSurfaceEntryId).not.toBe(genericSurfaceEntryId);

    const enforcer = activationJobStartEnforcer({
      expectedReleaseDigest: digest("b"),
      expectedSurfaceDigest: digest("c"),
      expectedRuntimeInstallSealSha256: digest("1"),
      expectedRuntimeTreeSha256: digest("2"),
      expectedRuntimePolicySha256: digest("3"),
      expectedNodeExecutableSha256: digest("4"),
      expectedRuntimeTrust: runtimeTrustFixture,
      activation: {
        read: () => ({
          state: "production_provisional",
          generation: 3,
          activationHeadSha256: digest("d"),
          releaseDigest: digest("b"),
          surfaceDigest: digest("c"),
          runtimeInstallSealSha256: digest("1"),
          runtimeTreeSha256: digest("2"),
          runtimePolicySha256: digest("3"),
          nodeExecutableSha256: digest("4"),
          runtimeTrust: runtimeTrustFixture,
          rightsCurrent: true,
          releasedSurfaceEntryIds: [genericSurfaceEntryId],
        }),
      },
    });

    expect(enforcer.decide({
      requestSha256: digest("e"),
      surfaceEntryId: genericSurfaceEntryId,
      source: "direct",
    })).toMatchObject({ allowed: true, mode: "production_provisional" });
    expect(enforcer.decide({
      requestSha256: digest("f"),
      surfaceEntryId: exactSurfaceEntryId,
      source: "direct",
    })).toMatchObject({ allowed: false, mode: "production_provisional" });
  });

  it("fails closed on qualification-only, stale rights, binding drift, or unreadable state", () => {
    const snapshot = {
      state: "qualification_only" as const,
      generation: 1,
      activationHeadSha256: digest("d"),
      releaseDigest: digest("b"),
      surfaceDigest: digest("c"),
      runtimeInstallSealSha256: digest("1"),
      runtimeTreeSha256: digest("2"),
      runtimePolicySha256: digest("3"),
      nodeExecutableSha256: digest("4"),
      runtimeTrust: runtimeTrustFixture,
      rightsCurrent: true,
      releasedSurfaceEntryIds: [] as string[],
    };
    const options = {
      expectedReleaseDigest: digest("b"),
      expectedSurfaceDigest: digest("c"),
      expectedRuntimeInstallSealSha256: digest("1"),
      expectedRuntimeTreeSha256: digest("2"),
      expectedRuntimePolicySha256: digest("3"),
      expectedNodeExecutableSha256: digest("4"),
      expectedRuntimeTrust: runtimeTrustFixture,
    };
    expect(activationJobStartEnforcer({ ...options, activation: { read: () => snapshot } }).decide(context))
      .toMatchObject({ allowed: false, mode: "qualification_only" });
    expect(activationJobStartEnforcer({ ...options, activation: { read: () => snapshot } }).inspect())
      .toMatchObject({ productStartsAllowed: false, mode: "qualification_only" });
    expect(activationJobStartEnforcer({
      ...options,
      activation: { read: () => ({ ...snapshot, state: "production_stable", rightsCurrent: false }) },
    }).decide(context)).toMatchObject({ allowed: false, mode: "hold" });
    for (const field of [
      "releaseDigest",
      "surfaceDigest",
      "runtimeInstallSealSha256",
      "runtimeTreeSha256",
      "runtimePolicySha256",
      "nodeExecutableSha256",
    ] as const) {
      expect(activationJobStartEnforcer({
        ...options,
        activation: { read: () => ({ ...snapshot, [field]: digest("e") }) },
      }).decide(context), field).toMatchObject({ allowed: false, mode: "hold" });
    }
    expect(activationJobStartEnforcer({
      ...options,
      activation: { read: () => ({
        ...snapshot,
        runtimeTrust: { ...runtimeTrustFixture, hostTcbAttestationSha256: digest("e") },
      }) },
    }).decide(context)).toMatchObject({ allowed: false, mode: "hold" });
    for (const policy of [
      "release",
      "activationWriter",
      "qualificationAuthorizer",
      "runtimeRights",
      "bootstrapAuthority",
    ] as const) {
      expect(activationJobStartEnforcer({
        ...options,
        activation: { read: () => ({
          ...snapshot,
          runtimeTrust: {
            ...runtimeTrustFixture,
            trustPolicyDigests: {
              ...runtimeTrustFixture.trustPolicyDigests,
              [policy]: digest("e"),
            },
          },
        }) },
      }).decide(context), policy).toMatchObject({ allowed: false, mode: "hold" });
    }
    expect(activationJobStartEnforcer({
      ...options,
      activation: { read: () => { throw new Error("anchor mismatch"); } },
    }).decide(context)).toMatchObject({ allowed: false, mode: "hold", generation: null });
  });

  it("blocks Product starts while execution/publication authority shares the local Studio UID", () => {
    const snapshot = {
      state: "production_stable" as const,
      generation: 4,
      activationHeadSha256: digest("d"),
      releaseDigest: digest("b"),
      surfaceDigest: digest("c"),
      runtimeInstallSealSha256: digest("1"),
      runtimeTreeSha256: digest("2"),
      runtimePolicySha256: digest("3"),
      nodeExecutableSha256: digest("4"),
      runtimeTrust: sameUidRuntimeTrustFixture,
      rightsCurrent: true,
      releasedSurfaceEntryIds: [context.surfaceEntryId],
    };
    const enforcer = activationJobStartEnforcer({
      expectedReleaseDigest: snapshot.releaseDigest,
      expectedSurfaceDigest: snapshot.surfaceDigest,
      expectedRuntimeInstallSealSha256: snapshot.runtimeInstallSealSha256,
      expectedRuntimeTreeSha256: snapshot.runtimeTreeSha256,
      expectedRuntimePolicySha256: snapshot.runtimePolicySha256,
      expectedNodeExecutableSha256: snapshot.nodeExecutableSha256,
      expectedRuntimeTrust: sameUidRuntimeTrustFixture,
      activation: { read: () => snapshot },
    });
    expect(enforcer.decide(context)).toMatchObject({
      allowed: false,
      mode: "hold",
      generation: null,
    });
    expect(enforcer.inspect()).toMatchObject({
      productStartsAllowed: false,
      mode: "hold",
    });
  });
});
