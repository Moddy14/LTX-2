import {
  createDefaultRequest,
  createPreferredRequest,
  ia2vEditorNormalizationWarnings,
  mergeEditableGenerationRequest,
  type GenerationRequest,
} from "../shared/pipelines.js";
import { withOfficialSpeechModelPaths } from "../shared/models.js";

export const LEGACY_REQUEST_STORAGE_KEY = "ltx-studio.request.v1";
export const REQUEST_STORAGE_KEY = "ltx-studio.request.v2";
export const REQUEST_DRAFT_SCHEMA_VERSION = "ltx-studio-request-draft.v2" as const;

export type RequestDraftMigration = {
  kind: "auto-default-upgraded" | "legacy-draft-archived";
  legacyRequest: GenerationRequest;
  noticePending: boolean;
};

export type RestoredRequestDraft = {
  request: GenerationRequest;
  migration: RequestDraftMigration | null;
  warnings: string[];
};

type StorageLike = Pick<Storage, "getItem" | "setItem">;

type StoredRequestDraft = {
  schemaVersion: typeof REQUEST_DRAFT_SCHEMA_VERSION;
  request: GenerationRequest;
  migration: RequestDraftMigration | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function preparedRequest(value: unknown): GenerationRequest {
  return withOfficialSpeechModelPaths(mergeEditableGenerationRequest(value));
}

function preferredRequest(): GenerationRequest {
  return withOfficialSpeechModelPaths(createPreferredRequest());
}

/**
 * V1 did not record whether its draft came from the automatic startup default
 * or an explicit user choice. This exact semantic fingerprint changes only
 * the migration explanation: every v1 browser opens latest-first, while the
 * original request remains bound as an explicit opt-in backup. That backup is
 * essential because an explicit choice identical to the automatic default is
 * fundamentally indistinguishable from the automatic write.
 */
export function isExactLegacyAutoDefault(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const knownKeys = new Set(Object.keys(createDefaultRequest("two-stage")));
  if (Object.keys(value).some((key) => !knownKeys.has(key))) return false;
  const candidate = preparedRequest(value);
  const expected = withOfficialSpeechModelPaths(createDefaultRequest("two-stage"));
  return JSON.stringify(candidate) === JSON.stringify(expected);
}

function parseMigration(value: unknown): RequestDraftMigration | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "auto-default-upgraded" && value.kind !== "legacy-draft-archived") {
    return null;
  }
  if (typeof value.noticePending !== "boolean" || !isRecord(value.legacyRequest)) return null;
  return {
    kind: value.kind,
    legacyRequest: preparedRequest(value.legacyRequest),
    noticePending: value.noticePending,
  };
}

function parseCurrentDraft(raw: string): RestoredRequestDraft | null {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.schemaVersion !== REQUEST_DRAFT_SCHEMA_VERSION || !isRecord(value.request)) {
    return null;
  }
  const migration = value.migration === null ? null : parseMigration(value.migration);
  if (value.migration !== null && migration === null) return null;
  return {
    request: preparedRequest(value.request),
    migration,
    warnings: ia2vEditorNormalizationWarnings(value.request),
  };
}

export function restorePersistedRequest(storage: StorageLike): RestoredRequestDraft {
  try {
    const current = storage.getItem(REQUEST_STORAGE_KEY);
    if (current !== null && current !== "null") {
      const restored = parseCurrentDraft(current);
      if (restored !== null) return restored;
    }
  } catch {
    // A malformed/inaccessible v2 value must not hide a recoverable v1 draft.
  }

  try {
    const legacyRaw = storage.getItem(LEGACY_REQUEST_STORAGE_KEY);
    if (legacyRaw === null || legacyRaw === "null") {
      return { request: preferredRequest(), migration: null, warnings: [] };
    }
    const legacyValue: unknown = JSON.parse(legacyRaw);
    const legacyRequest = preparedRequest(legacyValue);
    if (isExactLegacyAutoDefault(legacyValue)) {
      return {
        request: preferredRequest(),
        warnings: [],
        migration: {
          kind: "auto-default-upgraded",
          legacyRequest,
          noticePending: true,
        },
      };
    }
    return {
      request: preferredRequest(),
      warnings: [],
      migration: {
        kind: "legacy-draft-archived",
        legacyRequest,
        noticePending: true,
      },
    };
  } catch {
    return { request: preferredRequest(), migration: null, warnings: [] };
  }
}

export function persistRequestDraft(
  storage: StorageLike,
  request: GenerationRequest,
  migration: RequestDraftMigration | null,
): void {
  const value: StoredRequestDraft = {
    schemaVersion: REQUEST_DRAFT_SCHEMA_VERSION,
    request,
    migration,
  };
  storage.setItem(REQUEST_STORAGE_KEY, JSON.stringify(value));
}
