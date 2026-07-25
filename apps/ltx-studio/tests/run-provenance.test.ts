import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureGemmaManifest,
  captureProvenanceFile,
  normalizeRunProvenance,
  verifyProvenanceFileEvidence,
} from "../server/runProvenance.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

describe("run provenance", () => {
  it("binds a regular file to its actual SHA-256 and revision", async () => {
    const root = await temporaryRoot("ltx-provenance-file-");
    const path = join(root, "speech.wav");
    await writeFile(path, "bound-audio");

    const evidence = await captureProvenanceFile(path, "input:conditioning-audio");

    expect(evidence).toMatchObject({
      role: "input:conditioning-audio",
      path,
      kind: "file",
      sizeBytes: 11,
      sha256: createHash("sha256").update("bound-audio").digest("hex"),
      entries: [],
    });
    expect(verifyProvenanceFileEvidence(evidence)).toBeNull();

    await writeFile(path, "changed-audio");
    expect(verifyProvenanceFileEvidence(evidence)).toContain("Dateirevision hat sich geändert");
  });

  it("manifests only Gemma configuration and shards referenced by the HF index", async () => {
    const root = await temporaryRoot("ltx-provenance-gemma-");
    await mkdir(join(root, "gguf"));
    await writeFile(join(root, "config.json"), "{}");
    await writeFile(join(root, "preprocessor_config.json"), "{}");
    await writeFile(join(root, "model-00001-of-00002.safetensors"), "shard-a");
    await writeFile(join(root, "model-00002-of-00002.safetensors"), "shard-b");
    await writeFile(join(root, "gguf", "unused.gguf"), "not-loaded");
    await writeFile(join(root, "model.safetensors.index.json"), JSON.stringify({
      weight_map: {
        first: "model-00001-of-00002.safetensors",
        second: "model-00002-of-00002.safetensors",
      },
    }));

    const evidence = await captureGemmaManifest(root);

    expect(evidence.kind).toBe("directory-manifest");
    expect(evidence.entries.map((entry) => entry.relativePath)).toEqual([
      "config.json",
      "model-00001-of-00002.safetensors",
      "model-00002-of-00002.safetensors",
      "model.safetensors.index.json",
      "preprocessor_config.json",
    ]);
    expect(evidence.entries.map((entry) => entry.relativePath)).not.toContain("gguf/unused.gguf");
    expect(verifyProvenanceFileEvidence(evidence)).toBeNull();

    await writeFile(join(root, "model-00002-of-00002.safetensors"), "changed");
    expect(verifyProvenanceFileEvidence(evidence)).toContain("Gemma-Manifestrevision hat sich geändert");
  });

  it("rejects structurally incomplete persisted manifests", () => {
    expect(normalizeRunProvenance({
      schemaVersion: "ltx-studio-run-provenance.v1",
      capturedAt: new Date().toISOString(),
      verifiedAt: null,
      files: [],
      code: [],
      runtime: null,
      fingerprint: "a".repeat(64),
    })).toBeNull();
  });
});
