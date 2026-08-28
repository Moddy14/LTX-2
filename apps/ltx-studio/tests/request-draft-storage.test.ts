import { describe, expect, it } from "vitest";

import { createDefaultRequest } from "../shared/pipelines.js";
import {
  isExactLegacyAutoDefault,
  LEGACY_REQUEST_STORAGE_KEY,
  persistRequestDraft,
  REQUEST_DRAFT_SCHEMA_VERSION,
  REQUEST_STORAGE_KEY,
  restorePersistedRequest,
} from "../src/requestDraftStorage.js";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function v1AutoDefault(): Record<string, unknown> {
  const value = JSON.parse(JSON.stringify(createDefaultRequest("two-stage"))) as Record<string, unknown>;
  // These fields were introduced after v1. Their absence must not turn the
  // historical automatic default into a false custom-draft classification.
  delete value.textToAudio;
  const postprocess = value.postprocess as Record<string, unknown>;
  const lipForcing = postprocess.lipForcing as Record<string, unknown>;
  delete lipForcing.rawOutputProfile;
  return value;
}

describe("request draft storage upgrade", () => {
  it("opens a fresh browser latest-first on LTX-2.5", () => {
    const restored = restorePersistedRequest(new MemoryStorage());

    expect(restored.request.mode).toBe("distilled");
    expect(restored.request.models).toMatchObject({ generation: "2.5", layout: "split" });
    expect(restored.migration).toBeNull();
  });

  it("upgrades only the exact v1 automatic default and keeps a recoverable copy", () => {
    const storage = new MemoryStorage();
    const legacy = v1AutoDefault();
    storage.setItem(LEGACY_REQUEST_STORAGE_KEY, JSON.stringify(legacy));

    expect(isExactLegacyAutoDefault(legacy)).toBe(true);
    const restored = restorePersistedRequest(storage);

    expect(restored.request.mode).toBe("distilled");
    expect(restored.request.models).toMatchObject({ generation: "2.5", layout: "split" });
    expect(restored.migration).toMatchObject({
      kind: "auto-default-upgraded",
      noticePending: true,
      legacyRequest: { mode: "two-stage", models: { generation: "2.3", layout: "monolith" } },
    });
  });

  it("archives every custom legacy editor value while still opening latest-first", () => {
    const storage = new MemoryStorage();
    const legacy = v1AutoDefault();
    legacy.prompt = "Mein ausdrücklich gespeicherter Legacy-Entwurf";
    legacy.outputName = "mein-legacy-render.mp4";
    storage.setItem(LEGACY_REQUEST_STORAGE_KEY, JSON.stringify(legacy));

    expect(isExactLegacyAutoDefault(legacy)).toBe(false);
    const restored = restorePersistedRequest(storage);

    expect(restored.request).toMatchObject({
      mode: "distilled",
      models: { generation: "2.5", layout: "split" },
    });
    expect(restored.migration).toMatchObject({
      kind: "legacy-draft-archived",
      noticePending: true,
      legacyRequest: {
        mode: "two-stage",
        prompt: "Mein ausdrücklich gespeicherter Legacy-Entwurf",
        outputName: "mein-legacy-render.mp4",
        models: { generation: "2.3", layout: "monolith" },
      },
    });
  });

  it("round-trips the v2 envelope and never overwrites the original v1 recovery source", () => {
    const storage = new MemoryStorage();
    const legacy = v1AutoDefault();
    const legacyRaw = JSON.stringify(legacy);
    storage.setItem(LEGACY_REQUEST_STORAGE_KEY, legacyRaw);
    const first = restorePersistedRequest(storage);

    persistRequestDraft(storage, first.request, first.migration);
    const stored = JSON.parse(storage.getItem(REQUEST_STORAGE_KEY)!) as Record<string, unknown>;
    const second = restorePersistedRequest(storage);

    expect(stored.schemaVersion).toBe(REQUEST_DRAFT_SCHEMA_VERSION);
    expect(storage.getItem(LEGACY_REQUEST_STORAGE_KEY)).toBe(legacyRaw);
    expect(second).toEqual(first);
  });

  it("restores an old IA2V draft as a valid editable copy with a visible normalization warning", () => {
    const storage = new MemoryStorage();
    const historical = createDefaultRequest("image-audio-to-video");
    historical.negativePrompt = "hidden legacy exclusions";
    historical.videoGuidance.modalityScale = 5;
    historical.audioGuidance.cfgScale = 9;
    persistRequestDraft(storage, historical, null);

    const restored = restorePersistedRequest(storage);
    const defaults = createDefaultRequest("image-audio-to-video");
    expect(restored.request.negativePrompt).toBe("");
    expect(restored.request.videoGuidance).toEqual(defaults.videoGuidance);
    expect(restored.request.audioGuidance).toEqual(defaults.audioGuidance);
    expect(restored.warnings).toEqual([
      expect.stringContaining("nicht in die Editierkopie übernommen"),
    ]);
  });

  it("falls back to the intact v1 draft when a v2 envelope is malformed", () => {
    const storage = new MemoryStorage();
    const custom = v1AutoDefault();
    custom.seed = 424242;
    storage.setItem(LEGACY_REQUEST_STORAGE_KEY, JSON.stringify(custom));
    storage.setItem(REQUEST_STORAGE_KEY, "{malformed");

    const restored = restorePersistedRequest(storage);

    expect(restored.request).toMatchObject({ mode: "distilled", models: { generation: "2.5" } });
    expect(restored.migration).toMatchObject({
      kind: "legacy-draft-archived",
      legacyRequest: { seed: 424242 },
    });
  });

  it("does not silently discard a recovery copy from a structurally invalid v2 migration", () => {
    const storage = new MemoryStorage();
    const custom = v1AutoDefault();
    custom.prompt = "Diese v1-Rückfallkopie muss erhalten bleiben";
    storage.setItem(LEGACY_REQUEST_STORAGE_KEY, JSON.stringify(custom));
    storage.setItem(REQUEST_STORAGE_KEY, JSON.stringify({
      schemaVersion: REQUEST_DRAFT_SCHEMA_VERSION,
      request: createDefaultRequest("distilled"),
      migration: { kind: "unknown", noticePending: false },
    }));

    const restored = restorePersistedRequest(storage);

    expect(restored.request).toMatchObject({ mode: "distilled", models: { generation: "2.5" } });
    expect(restored.migration).toMatchObject({
      kind: "legacy-draft-archived",
      legacyRequest: { prompt: "Diese v1-Rückfallkopie muss erhalten bleiben" },
    });
  });
});
