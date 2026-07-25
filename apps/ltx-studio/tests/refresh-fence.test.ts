import { describe, expect, it } from "vitest";

import { RefreshFence } from "../src/refreshFence.js";

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
