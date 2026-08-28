import { describe, expect, it } from "vitest";

import {
  describeDgxMemoryWait,
  memoryWaitFromDgxBlocker,
  normalizeDgxLastStartGate,
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
      qwenEvictedTriggerReservedGiB: null,
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
      qwenEvictedTriggerReservedGiB: null,
    });
  });

  it("includes the distinct Qwen eviction-trigger reserve in the exact equation", () => {
    const value = {
      ...blocker,
      available_gib: 100,
      required_available_gib: 94,
      qwen_evicted_trigger_reserved_gib: 82,
      current_shortfall_gib: 76,
    };
    expect(normalizeDgxMemoryBlocker(value)).toMatchObject({
      currentShortfallGiB: 76,
      qwenRestoreReservedGiB: null,
      qwenEvictedTriggerReservedGiB: 82,
    });
    const wait = memoryWaitFromDgxBlocker(value, "2026-08-28T08:30:00Z");
    expect(wait && describeDgxMemoryWait(wait)).toContain(
      "82,00 GiB Qwen-Eviction-Trigger-Reserve",
    );
  });

  it.each([
    ["legacy ambiguous name", { ...blocker, current_shortfall_gib: undefined, shortfall_gib: 50.68 }],
    ["inconsistent equation", { ...blocker, current_shortfall_gib: 10.99 }],
    ["boolean", { ...blocker, available_gib: true }],
    ["negative", { ...blocker, pending_reservations_gib: -1 }],
    ["NaN", { ...blocker, available_gib: Number.NaN }],
    ["Infinity", { ...blocker, required_available_gib: Number.POSITIVE_INFINITY }],
    ["wrong kind", { ...blocker, kind: "thermal" }],
    ["unknown field", { ...blocker, secret_projection: 42 }],
    ["non-canonical precision", { ...blocker, available_gib: 43.321, current_shortfall_gib: 50.679 }],
    ["explicit zero optional reserve", { ...blocker, qwen_restore_reserved_gib: 0 }],
  ])("rejects %s without inventing values", (_label, value) => {
    expect(normalizeDgxMemoryBlocker(value)).toBeNull();
  });

  it("normalizes only the exact additive restore-gate schema", () => {
    expect(normalizeDgxLastStartGate({
      schema_version: "dgx-last-start-gate.v0",
      error: "qwen_gate_active",
      reason: "qwen_restore_reserved",
      observed_at: "2026-08-28T10:30:00+02:00",
      retry_after_seconds: 30,
      blocker,
    })).toEqual({
      schemaVersion: "dgx-last-start-gate.v0",
      error: "qwen_gate_active",
      reason: "qwen_restore_reserved",
      observedAt: "2026-08-28T08:30:00.000Z",
      retryAfterSeconds: 30,
      blocker: {
        kind: "memory",
        availableGiB: 43.32,
        pendingReservationsGiB: 0,
        requiredAvailableGiB: 94,
        currentShortfallGiB: 50.68,
        qwenPagingReservedGiB: null,
        qwenRestoreReservedGiB: null,
        qwenEvictedTriggerReservedGiB: null,
      },
    });
    expect(normalizeDgxLastStartGate({
      schema_version: "dgx-last-start-gate.v0",
      error: "qwen_gate_active",
      reason: "qwen_restore_reserved",
      observed_at: "2026-08-28T08:30:00Z",
      retry_after_seconds: null,
    })?.blocker).toBeNull();
  });

  it.each([
    ["wrong reason", { reason: "qwen_demand_visible" }],
    ["fractional retry", { retry_after_seconds: 0.5 }],
    ["unknown field", { secret: true }],
    ["forged blocker", { blocker: { ...blocker, current_shortfall_gib: 1 } }],
    ["non-ISO observation", { observed_at: "0" }],
    ["offsetless observation", { observed_at: "2026-08-28T08:30:00" }],
    ["impossible calendar date", { observed_at: "2026-02-30T08:30:00Z" }],
    ["RFC-1123 observation", { observed_at: "Fri, 28 Aug 2026 08:30:00 GMT" }],
    ["slash-date observation", { observed_at: "2026/08/28 08:30:00Z" }],
  ])("rejects a %s last-start-gate observation", (_label, patch) => {
    expect(normalizeDgxLastStartGate({
      schema_version: "dgx-last-start-gate.v0",
      error: "qwen_gate_active",
      reason: "qwen_restore_reserved",
      observed_at: "2026-08-28T08:30:00Z",
      retry_after_seconds: 30,
      blocker,
      ...patch,
    })).toBeNull();
  });

  it("round-trips only the public camelCase allowlist", () => {
    const wait = memoryWaitFromDgxBlocker(blocker, "2026-08-28T08:30:00+02:00");
    expect(wait).not.toBeNull();
    expect(normalizePublicDgxMemoryWait({ ...wait, raw_secret: "must-not-survive" }))
      .toEqual(wait);
  });

  it("upgrades a persisted v1 memory wait written before the eviction operand existed", () => {
    const wait = memoryWaitFromDgxBlocker(blocker, "2026-08-28T08:30:00Z")!;
    const legacy = { ...wait } as Record<string, unknown>;
    delete legacy.qwenEvictedTriggerReservedGiB;
    expect(normalizePublicDgxMemoryWait(legacy)).toEqual(wait);
  });

  it("formats the exact validated numbers for the visible run monitor", () => {
    const wait = memoryWaitFromDgxBlocker(blocker, "2026-08-28T08:30:00Z");
    expect(wait && describeDgxMemoryWait(wait)).toBe(
      "DGX-Speicher: aktuell fehlen 50,68 GiB; 43,32 GiB verfügbar; "
      + "0,00 GiB offene Reservierungen; 94,00 GiB Startschwelle.",
    );
  });
});
