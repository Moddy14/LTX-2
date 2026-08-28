export type DgxMemoryBlocker = {
  kind: "memory";
  availableGiB: number;
  pendingReservationsGiB: number;
  requiredAvailableGiB: number;
  currentShortfallGiB: number;
  qwenPagingReservedGiB: number | null;
  qwenRestoreReservedGiB: number | null;
};

export type PublicDgxMemoryWait = DgxMemoryBlocker & {
  schemaVersion: "ltx-studio-dgx-memory-wait.v1";
  observedAt: string;
};

const MAX_MEMORY_GIB = 4_096;
const ROUNDING_TOLERANCE_GIB = 0.03;

function finiteMemoryGiB(value: unknown): number | null {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_MEMORY_GIB
    ? value
    : null;
}

function exactOffsetTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

/**
 * Strictly normalizes the snake_case Runtime-API blocker. No legacy
 * `shortfall_gib` alias is accepted: it never distinguished a current gate
 * measurement from a reclaim projection.
 */
export function normalizeDgxMemoryBlocker(value: unknown): DgxMemoryBlocker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const blocker = value as Record<string, unknown>;
  if (blocker.kind !== "memory") return null;
  const availableGiB = finiteMemoryGiB(blocker.available_gib);
  const pendingReservationsGiB = finiteMemoryGiB(blocker.pending_reservations_gib);
  const requiredAvailableGiB = finiteMemoryGiB(blocker.required_available_gib);
  const currentShortfallGiB = finiteMemoryGiB(blocker.current_shortfall_gib);
  const qwenPagingReservedGiB = blocker.qwen_paging_reserved_gib === undefined
    ? 0
    : finiteMemoryGiB(blocker.qwen_paging_reserved_gib);
  const qwenRestoreReservedGiB = blocker.qwen_restore_reserved_gib === undefined
    ? 0
    : finiteMemoryGiB(blocker.qwen_restore_reserved_gib);
  if (availableGiB === null
    || pendingReservationsGiB === null
    || requiredAvailableGiB === null
    || currentShortfallGiB === null
    || qwenPagingReservedGiB === null
    || qwenRestoreReservedGiB === null
    || currentShortfallGiB <= 0) return null;
  const expectedShortfall = requiredAvailableGiB
    - (
      availableGiB
      - pendingReservationsGiB
      - qwenPagingReservedGiB
      - qwenRestoreReservedGiB
    );
  if (!Number.isFinite(expectedShortfall)
    || Math.abs(expectedShortfall - currentShortfallGiB) > ROUNDING_TOLERANCE_GIB) return null;
  return {
    kind: "memory",
    availableGiB,
    pendingReservationsGiB,
    requiredAvailableGiB,
    currentShortfallGiB,
    qwenPagingReservedGiB: blocker.qwen_paging_reserved_gib === undefined
      ? null
      : qwenPagingReservedGiB,
    qwenRestoreReservedGiB: blocker.qwen_restore_reserved_gib === undefined
      ? null
      : qwenRestoreReservedGiB,
  };
}

export function memoryWaitFromDgxBlocker(
  value: unknown,
  observedAt: string,
): PublicDgxMemoryWait | null {
  const blocker = normalizeDgxMemoryBlocker(value);
  const normalizedObservedAt = exactOffsetTimestamp(observedAt);
  if (!blocker || !normalizedObservedAt) return null;
  return {
    schemaVersion: "ltx-studio-dgx-memory-wait.v1",
    observedAt: normalizedObservedAt,
    ...blocker,
  };
}

export function normalizePublicDgxMemoryWait(value: unknown): PublicDgxMemoryWait | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== "ltx-studio-dgx-memory-wait.v1"
    || candidate.kind !== "memory") return null;
  const normalized = memoryWaitFromDgxBlocker({
    kind: "memory",
    available_gib: candidate.availableGiB,
    pending_reservations_gib: candidate.pendingReservationsGiB,
    required_available_gib: candidate.requiredAvailableGiB,
    current_shortfall_gib: candidate.currentShortfallGiB,
    ...(candidate.qwenPagingReservedGiB === null
      ? {}
      : { qwen_paging_reserved_gib: candidate.qwenPagingReservedGiB }),
    ...(candidate.qwenRestoreReservedGiB === null
      ? {}
      : { qwen_restore_reserved_gib: candidate.qwenRestoreReservedGiB }),
  }, typeof candidate.observedAt === "string" ? candidate.observedAt : "");
  return normalized;
}

function germanNumber(value: number): string {
  return value.toFixed(2).replace(".", ",");
}

export function describeDgxMemoryWait(wait: PublicDgxMemoryWait): string {
  const parts = [
    `aktuell fehlen ${germanNumber(wait.currentShortfallGiB)} GiB`,
    `${germanNumber(wait.availableGiB)} GiB verfügbar`,
    `${germanNumber(wait.pendingReservationsGiB)} GiB offene Reservierungen`,
    `${germanNumber(wait.requiredAvailableGiB)} GiB Startschwelle`,
  ];
  if (wait.qwenPagingReservedGiB !== null) {
    parts.push(`${germanNumber(wait.qwenPagingReservedGiB)} GiB Qwen-Einpage-Reserve`);
  }
  if (wait.qwenRestoreReservedGiB !== null) {
    parts.push(`${germanNumber(wait.qwenRestoreReservedGiB)} GiB Qwen-Restore-Reserve`);
  }
  return `DGX-Speicher: ${parts.join("; ")}.`;
}
