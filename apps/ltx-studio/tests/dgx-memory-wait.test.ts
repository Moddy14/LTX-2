import { describe, expect, it } from "vitest";

import {
  describeDgxMemoryWait,
  memoryWaitFromDgxBlocker,
  normalizeDgxMemoryBlocker,
  normalizePublicDgxMemoryWait,
} from "../shared/dgxMemoryWait.js";

const blocker = {
  kind: "memory",
  available_gib: 43.32,
  pending_reservations_gib: 0,
  required_available_gib: 94,
  current_shortfall_gib: 50.68,
};

describe("DGX memory wait diagnostics", () => {
  it("normalizes a complete current start-gate equation", () => {
    expect(normalizeDgxMemoryBlocker(blocker)).toEqual({
      kind: "memory",
      availableGiB: 43.32,
      pendingReservationsGiB: 0,
      requiredAvailableGiB: 94,
      currentShortfallGiB: 50.68,
      qwenPagingReservedGiB: null,
      qwenRestoreReservedGiB: null,
    });
  });

  it("includes the optional Qwen paging reserve in the equation", () => {
    expect(normalizeDgxMemoryBlocker({
      ...blocker,
      available_gib: 50,
      pending_reservations_gib: 3,
      qwen_paging_reserved_gib: 2,
      current_shortfall_gib: 49,
    })?.qwenPagingReservedGiB).toBe(2);
  });

  it("includes the optional Qwen restore reserve in the equation", () => {
    expect(normalizeDgxMemoryBlocker({
      ...blocker,
      available_gib: 70.5,
      qwen_restore_reserved_gib: 24,
      required_available_gib: 72,
      current_shortfall_gib: 25.5,
    })).toMatchObject({
      currentShortfallGiB: 25.5,
      qwenPagingReservedGiB: null,
      qwenRestoreReservedGiB: 24,
    });
  });

  it.each([
    ["legacy ambiguous name", { ...blocker, current_shortfall_gib: undefined, shortfall_gib: 50.68 }],
    ["inconsistent equation", { ...blocker, current_shortfall_gib: 10.99 }],
    ["boolean", { ...blocker, available_gib: true }],
    ["negative", { ...blocker, pending_reservations_gib: -1 }],
    ["NaN", { ...blocker, available_gib: Number.NaN }],
    ["Infinity", { ...blocker, required_available_gib: Number.POSITIVE_INFINITY }],
    ["wrong kind", { ...blocker, kind: "thermal" }],
  ])("rejects %s without inventing values", (_label, value) => {
    expect(normalizeDgxMemoryBlocker(value)).toBeNull();
  });

  it("round-trips only the public camelCase allowlist", () => {
    const wait = memoryWaitFromDgxBlocker(blocker, "2026-08-28T08:30:00+02:00");
    expect(wait).not.toBeNull();
    expect(normalizePublicDgxMemoryWait({ ...wait, raw_secret: "must-not-survive" }))
      .toEqual(wait);
  });

  it("formats the exact validated numbers for the visible run monitor", () => {
    const wait = memoryWaitFromDgxBlocker(blocker, "2026-08-28T08:30:00Z");
    expect(wait && describeDgxMemoryWait(wait)).toBe(
      "DGX-Speicher: aktuell fehlen 50,68 GiB; 43,32 GiB verfügbar; "
      + "0,00 GiB offene Reservierungen; 94,00 GiB Startschwelle.",
    );
  });
});
