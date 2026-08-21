import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  bindRunProvenanceFile,
  captureGemmaManifest,
  captureProvenanceFile,
  captureRunProvenance,
  normalizeRunProvenance,
  verifyProvenanceFileEvidence,
} from "../server/runProvenance.js";
import { createDefaultRequest } from "../shared/pipelines.js";
import type { RunProvenance } from "../shared/provenance.js";
import { upstreamWorkflowContractsForRequest } from "../shared/upstreamWorkflowContracts.js";
import { validLtx25SplitRequest } from "./fixtures.js";

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

  it("rejects a split component before runtime capture when pinned size or digest differs", async () => {
    const root = await temporaryRoot("ltx25-integrity-");
    const path = join(root, "ltx-2.5-22b-distilled-transformer-bf16.safetensors");
    await writeFile(path, "not-the-official-transformer");
    const request = validLtx25SplitRequest("distilled");

    await expect(captureRunProvenance(request, {
      executable: process.execPath,
      args: [],
      displayCommand: process.execPath,
      outputPath: join(root, "output.mp4"),
      requiredPaths: [{
        path,
        label: "LTX-2.5 Transformer",
        kind: "file",
        expectedSizeBytes: 42_018_190_584,
        expectedSha256: "31eb3cad89b9e54e99dd3baf286f70825ac4f6c660a70d9184d895be76d7bff4",
      }],
    })).rejects.toThrow("weicht vom gepinnten Wert");
  });

  it("adds a reused LTX base as a pinned input and invalidates the prior verification", async () => {
    const root = await temporaryRoot("ltx-provenance-reused-base-");
    const path = join(root, "ltx-base.mp4");
    await writeFile(path, "immutable-base");
    const original: RunProvenance = {
      schemaVersion: "ltx-studio-run-provenance.v1",
      capturedAt: "2026-07-30T00:00:00.000Z",
      verifiedAt: "2026-07-30T00:01:00.000Z",
      files: [],
      code: [],
      runtime: {
        platform: "linux",
        architecture: "arm64",
        kernelRelease: "test",
        nodeVersion: "test",
        pythonExecutable: "/python",
        pythonVersion: "test",
        packages: {},
        ffmpegVersion: "test",
        fingerprint: "a".repeat(64),
      },
      fingerprint: "b".repeat(64),
    };

    const bound = await bindRunProvenanceFile(
      original,
      path,
      "input:reused-ltx-base:source-job",
    );

    expect(bound.verifiedAt).toBeNull();
    expect(bound.fingerprint).not.toBe(original.fingerprint);
    expect(bound.files).toHaveLength(1);
    expect(bound.files[0]).toMatchObject({
      role: "input:reused-ltx-base:source-job",
      path,
      sha256: createHash("sha256").update("immutable-base").digest("hex"),
    });
    expect(verifyProvenanceFileEvidence(bound.files[0])).toBeNull();
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

  it("pins the exact upstream workflow used by official Comfy modes", () => {
    const lipDub = createDefaultRequest("lipdub");
    const [lipDubContract] = upstreamWorkflowContractsForRequest(lipDub);
    expect(lipDubContract).toEqual({
      role: "official-workflow:lipdub-two-stage",
      repository: "https://github.com/Lightricks/ComfyUI-LTXVideo",
      commit: "3b9c5cde4700917074823d45e25401d81049f8fc",
      path: "example_workflows/2.3/LTX-2.3_ICLoRA_Lipdub_Two_Stage_Distilled.json",
      sha256: "620c4fc838866c4fa0819b04db6aa199818ddcff73b7636e44138fed6f1e4a35",
    });

    const inpaint = createDefaultRequest("ic-lora");
    inpaint.icLora.profile = "inpainting";
    expect(upstreamWorkflowContractsForRequest(inpaint)[0]?.sha256).toBe(
      "b4d002e2d15eb716654f234797b464daf8aa4f23261f30137ac16dfffdda42bd",
    );

    const nativeLipDub = createDefaultRequest("lipdub");
    nativeLipDub.lipDub.pipelineProfile = "native-distilled";
    expect(upstreamWorkflowContractsForRequest(nativeLipDub)).toEqual([]);

    const hdr = createDefaultRequest("ic-lora");
    hdr.icLora.profile = "hdr";
    expect(upstreamWorkflowContractsForRequest(hdr)).toEqual([]);
  });

  it("pins the ComfyUI documentation templates for the native two-stage modes", () => {
    expect(upstreamWorkflowContractsForRequest(createDefaultRequest("two-stage"))).toEqual([{
      role: "official-template:t2v",
      repository: "https://github.com/Comfy-Org/workflow_templates",
      commit: "7653f1cdef1d92394b6ef9946018c0a8aa4136b8",
      path: "templates/video_ltx2_3_t2v.json",
      sha256: "75b10f3ee48c1fe00c7fb21b24c0c247b133e5ee34676144de4b652ac7dcbe7f",
    }]);

    const i2v = createDefaultRequest("two-stage");
    i2v.images = [{ path: "/inputs/first.png", name: "first.png", frameIndex: 0, strength: 1, crf: 33 }];
    expect(upstreamWorkflowContractsForRequest(i2v)[0]).toMatchObject({
      role: "official-template:i2v",
      path: "templates/video_ltx2_3_i2v.json",
      sha256: "77a16503db8476dec5891de9de9e024c265b6e01b0cd79edac995faa0504ddc8",
    });

    expect(
      upstreamWorkflowContractsForRequest(createDefaultRequest("image-audio-to-video"))[0],
    ).toMatchObject({
      role: "official-template:ia2v",
      path: "templates/video_ltx2_3_ia2v.json",
      sha256: "7823a703f472d9c5e6f82c462235ff89a0fa14752ec1fd947c4422cf53e47685",
    });

    expect(upstreamWorkflowContractsForRequest(createDefaultRequest("id-lora"))[0]).toMatchObject({
      role: "official-template:id-lora",
      path: "templates/video_ltx2_3_id_lora.json",
      sha256: "fcffe421129bac16b4f0655e54130d633280cdaf6949e145221e7090be42151f",
    });

    const unionControl = createDefaultRequest("ic-lora");
    expect(upstreamWorkflowContractsForRequest(unionControl)[0]).toMatchObject({
      role: "official-template:ic-lora-union-control",
      repository: "https://github.com/Comfy-Org/workflow_templates",
      path: "templates/video_ltx2_3_ic_lora.json",
      sha256: "48650e2f459391173e33686f0f27e4eafdc4fb79ce3be9b19a77a5d235666f04",
    });

    expect(upstreamWorkflowContractsForRequest(createDefaultRequest("audio-to-video"))).toEqual([]);
  });

  it("pins exact LTX-2.5 workflow files only for explicit split-pack requests", () => {
    expect(upstreamWorkflowContractsForRequest(validLtx25SplitRequest("distilled"))).toEqual([{
      role: "official-workflow:ltx-2.5:t2v-i2v-two-stage",
      repository: "https://github.com/Lightricks/ComfyUI-LTXVideo",
      commit: "15d09abb5a187a8dcaea2fc31fe51ee96e6c9d0d",
      path: "example_workflows/2.5/LTX-2.5_T2V_I2V_Two_Stage_Distilled.json",
      sha256: "b8b8d79b5cb09519e828a3cd438348b492b448547f030ed7e1098ad86ea3010a",
    }]);

    const preview = validLtx25SplitRequest("distilled");
    preview.distilled.singleStage = true;
    expect(upstreamWorkflowContractsForRequest(preview)[0]).toMatchObject({
      role: "official-workflow:ltx-2.5:t2v-i2v-single-stage",
      path: "example_workflows/2.5/LTX-2.5_T2V_I2V_Single_Stage_Distilled.json",
      sha256: "e264b203ec4b0ff1dfd448121c96ceb5d45dfe84b70fcac9a03e5bc700338f25",
    });

    const ingredients = validLtx25SplitRequest("ic-lora");
    ingredients.icLora.profile = "ingredients";
    expect(upstreamWorkflowContractsForRequest(ingredients)[0]).toMatchObject({
      role: "official-workflow:ltx-2.5:ic-lora-ingredients",
      path: "example_workflows/2.5/LTX-2.5_ICLoRA_Ingredients_Single_Stage_Distilled.json",
      sha256: "afb34052b0569ffaa7930bfa2c854798b8121ce72240306eb7f49724efbe1f72",
    });
  });

  it("accepts upstream contracts in new sidecars while preserving legacy v1 sidecars", () => {
    const base = {
      schemaVersion: "ltx-studio-run-provenance.v1" as const,
      capturedAt: new Date().toISOString(),
      verifiedAt: null,
      files: [],
      code: [],
      runtime: {
        platform: "linux",
        architecture: "arm64",
        kernelRelease: "test",
        nodeVersion: "test",
        pythonExecutable: "/python",
        pythonVersion: "test",
        packages: {},
        ffmpegVersion: "test",
        fingerprint: "a".repeat(64),
      },
      fingerprint: "b".repeat(64),
    } satisfies RunProvenance;
    expect(normalizeRunProvenance(base)).not.toBeNull();

    const withContract: RunProvenance = {
      ...base,
      upstreamContracts: upstreamWorkflowContractsForRequest(createDefaultRequest("lipdub")),
    };
    expect(normalizeRunProvenance(withContract)?.upstreamContracts).toHaveLength(1);
    expect(normalizeRunProvenance({
      ...base,
      schemaVersion: "ltx-studio-run-provenance.v2",
      release: {
        sealed: true,
        verified: true,
        releaseDigest: "e".repeat(64),
        manifestSha256: "e".repeat(64),
        sourceCommit: "f".repeat(40),
      },
    })).not.toBeNull();
    expect(normalizeRunProvenance({
      ...base,
      schemaVersion: "ltx-studio-run-provenance.v2",
    })).toBeNull();
    expect(normalizeRunProvenance({
      ...withContract,
      upstreamContracts: [{ ...withContract.upstreamContracts![0], sha256: "invalid" }],
    })).toBeNull();
  });
});
