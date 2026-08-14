import { describe, expect, it } from "vitest";

import { bootstrapJobStartEnforcer, jobStartSources } from "../server/startEnforcer.js";

describe("bootstrap job-start enforcer", () => {
  it("fails closed for every start source in a sealed release", () => {
    const enforcer = bootstrapJobStartEnforcer(true);

    for (const source of jobStartSources) {
      expect(enforcer.decide({ requestSha256: "a".repeat(64), source })).toMatchObject({
        allowed: false,
        mode: "blocked",
        schemaVersion: "ltx-studio-bootstrap-start-enforcer.v1",
      });
    }
  });

  it("keeps the explicitly unsealed development workflow available", () => {
    expect(bootstrapJobStartEnforcer(false).decide({
      requestSha256: "b".repeat(64),
      source: "direct",
    })).toMatchObject({
      allowed: true,
      mode: "development",
    });
  });
});
