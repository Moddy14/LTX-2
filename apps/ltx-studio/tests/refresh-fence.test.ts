import { describe, expect, it } from "vitest";

import { LatestRefreshFence, RefreshFence } from "../src/refreshFence.js";

describe("refresh fence", () => {
  it("rejects snapshots captured before or during a mutation", () => {
    const fence = new RefreshFence();
    const before = fence.snapshot();
    const finish = fence.beginMutation();
    const during = fence.snapshot();

    expect(fence.accepts(before)).toBe(false);
    expect(fence.accepts(during)).toBe(false);

    finish();
    expect(fence.accepts(before)).toBe(false);
    expect(fence.accepts(during)).toBe(false);
    expect(fence.accepts(fence.snapshot())).toBe(true);
  });

  it("stays closed until overlapping mutations have both completed", () => {
    const fence = new RefreshFence();
    const finishFirst = fence.beginMutation();
    const finishSecond = fence.beginMutation();

    finishSecond();
    expect(fence.accepts(fence.snapshot())).toBe(false);

    finishFirst();
    expect(fence.accepts(fence.snapshot())).toBe(true);
  });

  it("makes mutation completion idempotent", () => {
    const fence = new RefreshFence();
    const finish = fence.beginMutation();
    finish();
    const completed = fence.snapshot();

    finish();
    expect(fence.snapshot()).toBe(completed);
    expect(fence.accepts(completed)).toBe(true);
  });
});

describe("latest refresh fence", () => {
  it("accepts only the newest concurrent refresh", () => {
    const fence = new LatestRefreshFence();
    const older = fence.issue();
    const newer = fence.issue();

    expect(fence.accepts(older)).toBe(false);
    expect(fence.accepts(newer)).toBe(true);
  });

  it("rejects refreshes crossing a mutation boundary", () => {
    const fence = new LatestRefreshFence();
    const before = fence.issue();
    const finish = fence.beginMutation();
    const during = fence.issue();

    expect(fence.accepts(before)).toBe(false);
    expect(fence.accepts(during)).toBe(false);
    finish();
    expect(fence.accepts(before)).toBe(false);
    expect(fence.accepts(during)).toBe(false);
    expect(fence.accepts(fence.issue())).toBe(true);
  });

  it("stays closed across overlapping delete and analysis mutations", () => {
    const fence = new LatestRefreshFence();
    const beforeDelete = fence.issue();
    const finishDelete = fence.beginMutation();
    const duringDelete = fence.issue();
    const finishAnalysis = fence.beginMutation();

    finishAnalysis();
    expect(fence.accepts(beforeDelete)).toBe(false);
    expect(fence.accepts(duringDelete)).toBe(false);
    expect(fence.accepts(fence.issue())).toBe(false);

    finishDelete();
    expect(fence.accepts(duringDelete)).toBe(false);
    expect(fence.accepts(fence.issue())).toBe(true);
  });
});
