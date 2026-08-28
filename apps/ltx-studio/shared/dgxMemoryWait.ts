export type DgxMemoryBlocker = {
  kind: "memory";
  availableGiB: number;
  pendingReservationsGiB: number;
  requiredAvailableGiB: number;
  currentShortfallGiB: number;
  qwenPagingReservedGiB: number | null;
  qwenRestoreReservedGiB: number | null;
  qwenEvictedTriggerReservedGiB: number | null;
};

export type DgxLastStartGateObservation = {
  schemaVersion: "dgx-last-start-gate.v0";
  error: "qwen_gate_active";
  reason: "qwen_restore_reserved";
  observedAt: string;
  retryAfterSeconds: number | null;
  blocker: DgxMemoryBlocker | null;
};

export type PublicDgxMemoryWait = DgxMemoryBlocker & {
  schemaVersion: "ltx-studio-dgx-memory-wait.v1";
  observedAt: string;
};

const MAX_MEMORY_GIB = 4_096;
const RAW_MEMORY_BLOCKER_KEYS = new Set([
  "kind",
  "available_gib",
  "pending_reservations_gib",
  "required_available_gib",
  "current_shortfall_gib",
  "qwen_paging_reserved_gib",
  "qwen_restore_reserved_gib",
  "qwen_evicted_trigger_reserved_gib",
]);
const REQUIRED_RAW_MEMORY_BLOCKER_KEYS = [
  "kind",
  "available_gib",
  "pending_reservations_gib",
  "required_available_gib",
  "current_shortfall_gib",
] as const;
const LAST_START_GATE_KEYS = new Set([
  "schema_version",
  "error",
  "reason",
  "observed_at",
  "retry_after_seconds",
  "blocker",
]);
const OFFSET_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function finiteMemoryGiB(value: unknown): number | null {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= MAX_MEMORY_GIB
    ? value
    : null;
}

function exactOffsetTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = OFFSET_DATE_TIME_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function roundedGiB(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * Strictly normalizes the snake_case Runtime-API blocker. No legacy
 * `shortfall_gib` alias is accepted: it never distinguished a current gate
 * measurement from a reclaim projection.
 */
export function normalizeDgxMemoryBlocker(value: unknown): DgxMemoryBlocker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const blocker = value as Record<string, unknown>;
  const keys = Object.keys(blocker);
  if (blocker.kind !== "memory"
    || REQUIRED_RAW_MEMORY_BLOCKER_KEYS.some((key) => !(key in blocker))
    || keys.some((key) => !RAW_MEMORY_BLOCKER_KEYS.has(key))) return null;
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
  const qwenEvictedTriggerReservedGiB = blocker.qwen_evicted_trigger_reserved_gib === undefined
    ? 0
    : finiteMemoryGiB(blocker.qwen_evicted_trigger_reserved_gib);
  if (availableGiB === null
    || pendingReservationsGiB === null
    || requiredAvailableGiB === null
    || currentShortfallGiB === null
    || qwenPagingReservedGiB === null
    || qwenRestoreReservedGiB === null
    || qwenEvictedTriggerReservedGiB === null
    || currentShortfallGiB <= 0
    || (blocker.qwen_paging_reserved_gib !== undefined && qwenPagingReservedGiB <= 0)
    || (blocker.qwen_restore_reserved_gib !== undefined && qwenRestoreReservedGiB <= 0)
    || (blocker.qwen_evicted_trigger_reserved_gib !== undefined
      && qwenEvictedTriggerReservedGiB <= 0)) return null;
  const operands = [
    availableGiB,
    pendingReservationsGiB,
    requiredAvailableGiB,
    currentShortfallGiB,
    qwenPagingReservedGiB,
    qwenRestoreReservedGiB,
    qwenEvictedTriggerReservedGiB,
  ];
  if (operands.some((operand) => roundedGiB(operand) !== operand)) return null;
  const expectedShortfall = roundedGiB(requiredAvailableGiB
    - (
      availableGiB
      - pendingReservationsGiB
      - qwenPagingReservedGiB
      - qwenRestoreReservedGiB
      - qwenEvictedTriggerReservedGiB
    ));
  if (!Number.isFinite(expectedShortfall) || expectedShortfall !== currentShortfallGiB) return null;
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
    qwenEvictedTriggerReservedGiB: blocker.qwen_evicted_trigger_reserved_gib === undefined
      ? null
      : qwenEvictedTriggerReservedGiB,
  };
}

/** Strict consumer for the additive Runtime-API restore-gate observation. */
export function normalizeDgxLastStartGate(value: unknown): DgxLastStartGateObservation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const observation = value as Record<string, unknown>;
  const keys = Object.keys(observation);
  if (keys.some((key) => !LAST_START_GATE_KEYS.has(key))
    || !["schema_version", "error", "reason", "observed_at", "retry_after_seconds"]
      .every((key) => key in observation)
    || observation.schema_version !== "dgx-last-start-gate.v0"
    || observation.error !== "qwen_gate_active"
    || observation.reason !== "qwen_restore_reserved") return null;
  const observedAt = exactOffsetTimestamp(observation.observed_at);
  const retryAfterSeconds = observation.retry_after_seconds;
  if (!observedAt
    || (retryAfterSeconds !== null
      && (!Number.isInteger(retryAfterSeconds) || (retryAfterSeconds as number) < 0))) return null;
  const blocker = observation.blocker === undefined
    ? null
    : normalizeDgxMemoryBlocker(observation.blocker);
  if (observation.blocker !== undefined && !blocker) return null;
  return {
    schemaVersion: "dgx-last-start-gate.v0",
    error: "qwen_gate_active",
    reason: "qwen_restore_reserved",
    observedAt,
    retryAfterSeconds: retryAfterSeconds as number | null,
    blocker,
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
    ...(candidate.qwenEvictedTriggerReservedGiB === null
      || candidate.qwenEvictedTriggerReservedGiB === undefined
      ? {}
      : { qwen_evicted_trigger_reserved_gib: candidate.qwenEvictedTriggerReservedGiB }),
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
  if (wait.qwenEvictedTriggerReservedGiB !== null) {
    parts.push(`${germanNumber(wait.qwenEvictedTriggerReservedGiB)} GiB Qwen-Eviction-Trigger-Reserve`);
  }
  return `DGX-Speicher: ${parts.join("; ")}.`;
}
