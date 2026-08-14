import { describe, expect, it } from "vitest";

import {
  activationJobStartEnforcer,
  bootstrapJobStartEnforcer,
  jobStartSources,
} from "../server/startEnforcer.js";

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
        schemaVersion: "ltx-studio-bootstrap-start-enforcer.v1",
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
      activation: {
        read: () => ({
          state: "production_provisional",
          generation: 3,
          activationHeadSha256: digest("d"),
          releaseDigest: digest("b"),
          surfaceDigest: digest("c"),
          rightsCurrent: true,
          releasedSurfaceEntryIds: [context.surfaceEntryId],
        }),
      },
    });

    expect(enforcer.decide(context)).toMatchObject({ allowed: true, mode: "production_provisional", generation: 3 });
    expect(enforcer.decide({ ...context, surfaceEntryId: "blocked.surface.entry" })).toMatchObject({
      allowed: false,
      mode: "production_provisional",
    });
  });

  it("fails closed on qualification-only, stale rights, binding drift, or unreadable state", () => {
    const snapshot = {
      state: "qualification_only" as const,
      generation: 1,
      activationHeadSha256: digest("d"),
      releaseDigest: digest("b"),
      surfaceDigest: digest("c"),
      rightsCurrent: true,
      releasedSurfaceEntryIds: [] as string[],
    };
    const options = {
      expectedReleaseDigest: digest("b"),
      expectedSurfaceDigest: digest("c"),
    };
    expect(activationJobStartEnforcer({ ...options, activation: { read: () => snapshot } }).decide(context))
      .toMatchObject({ allowed: false, mode: "qualification_only" });
    expect(activationJobStartEnforcer({
      ...options,
      activation: { read: () => ({ ...snapshot, state: "production_stable", rightsCurrent: false }) },
    }).decide(context)).toMatchObject({ allowed: false, mode: "hold" });
    expect(activationJobStartEnforcer({
      ...options,
      activation: { read: () => ({ ...snapshot, releaseDigest: digest("e") }) },
    }).decide(context)).toMatchObject({ allowed: false, mode: "hold" });
    expect(activationJobStartEnforcer({
      ...options,
      activation: { read: () => { throw new Error("anchor mismatch"); } },
    }).decide(context)).toMatchObject({ allowed: false, mode: "hold", generation: null });
  });
});
