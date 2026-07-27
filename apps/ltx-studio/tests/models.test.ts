import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { recommendedModelAssets, withDiscoveredModelDefaults } from "../shared/models.js";
import { createDefaultRequest } from "../shared/pipelines.js";
import { classifyModelFile, discoverModels } from "../server/models.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("model discovery", () => {
  it("classifies only supported LTX artifacts", () => {
    expect(classifyModelFile("/models/ltx-2.3-22b-dev.safetensors")).toBe("checkpoint");
    expect(classifyModelFile("/models/ltx-2.3-22b-distilled.safetensors")).toBe("distilled-checkpoint");
    expect(classifyModelFile("/models/ltx-spatial-upscaler-x2.safetensors")).toBe("spatial-upscaler");
    expect(classifyModelFile("/models/ltx-distilled-lora.safetensors")).toBe("lora");
    expect(classifyModelFile("/models/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors")).toBe("lora");
    expect(classifyModelFile("/models/model-00001-of-00005.safetensors")).toBeNull();
    expect(classifyModelFile("/models/ltx-temporal-upscaler.safetensors")).toBeNull();
  });

  it("finds a complete Gemma root without indexing its shards", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-models-"));
    temporaryRoots.push(root);
    const gemma = join(root, "gemma");
    await mkdir(gemma);
    await Promise.all([
      writeFile(join(gemma, "tokenizer.model"), "tokenizer"),
      writeFile(join(gemma, "config.json"), "{}"),
      writeFile(join(gemma, "model.safetensors.index.json"), "{}"),
      writeFile(join(gemma, "model-00001-of-00005.safetensors"), "shard"),
      writeFile(join(root, "ltx-2.3-22b-dev-fp8.safetensors"), "checkpoint"),
    ]);

    const inventory = await discoverModels([root]);
    expect(inventory.errors).toEqual([]);
    expect(inventory.items.map((item) => [item.kind, item.name])).toEqual([
      ["checkpoint", "ltx-2.3-22b-dev-fp8.safetensors"],
      ["gemma", "gemma"],
    ]);
    expect(inventory.items[0].precision).toBe("fp8");
    expect(inventory.recommendations.find((item) => item.id === "lipdub-lora")).toMatchObject({
      present: false,
      repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-LipDub",
    });
    expect(inventory.recommendations.find((item) => item.id === "lipdub-distilled-checkpoint")).toMatchObject({
      present: false,
      repoId: "Lightricks/LTX-2.3",
    });
    expect(inventory.recommendations.find((item) => item.id === "lipdub-spatial-upscaler")).toMatchObject({
      present: false,
      repoId: "Lightricks/LTX-2.3",
    });
  });

  it("rejects a same-named LipDub LoRA stub that does not match the official size", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-models-"));
    temporaryRoots.push(root);
    const repo = join(root, "Lightricks__LTX-2.3-22b-IC-LoRA-LipDub");
    await mkdir(repo);
    const localPath = join(repo, "ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors");
    await writeFile(localPath, "lora");

    const inventory = await discoverModels([root]);
    expect(inventory.items.map((item) => item.name)).toContain("ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors");
    expect(inventory.recommendations.find((item) => item.id === "lipdub-lora")).toMatchObject({
      present: false,
      localPath,
      integrity: "size-mismatch",
    });
  });

  it("rejects a same-named LipDub upscaler stub with the wrong size", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-models-"));
    temporaryRoots.push(root);
    const repo = join(root, "Lightricks__LTX-2.3");
    await mkdir(repo);
    const localPath = join(repo, "ltx-2.3-spatial-upscaler-x2-1.1.safetensors");
    await writeFile(localPath, "upscaler");

    const inventory = await discoverModels([root]);
    expect(inventory.items.map((item) => item.name)).toContain("ltx-2.3-spatial-upscaler-x2-1.1.safetensors");
    expect(inventory.recommendations.find((item) => item.id === "lipdub-spatial-upscaler")).toMatchObject({
      present: false,
      localPath,
      integrity: "size-mismatch",
    });
  });

  it("rejects a same-named LipDub checkpoint stub with the wrong size", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-models-"));
    temporaryRoots.push(root);
    const repo = join(root, "Lightricks__LTX-2.3");
    await mkdir(repo);
    const localPath = join(repo, "ltx-2.3-22b-distilled-1.1.safetensors");
    await writeFile(localPath, "checkpoint");

    const inventory = await discoverModels([root]);
    expect(inventory.items.map((item) => item.name)).toContain("ltx-2.3-22b-distilled-1.1.safetensors");
    expect(inventory.recommendations.find((item) => item.id === "lipdub-distilled-checkpoint")).toMatchObject({
      present: false,
      localPath,
      integrity: "size-mismatch",
    });
  });

  it("does not silently fall back to unverified speech assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-models-"));
    temporaryRoots.push(root);
    const ltx = join(root, "Lightricks__LTX-2.3");
    const legacyGemma = join(root, "DreamFast__gemma-3-12b-it-heretic");
    const officialGemma = join(root, "google__gemma-3-12b-it-qat-q4_0-unquantized");
    await Promise.all([mkdir(ltx), mkdir(legacyGemma), mkdir(officialGemma)]);
    await Promise.all([
      writeFile(join(ltx, "000-ltx-legacy-dev-checkpoint.safetensors"), "legacy checkpoint"),
      writeFile(join(ltx, "ltx-2.3-22b-dev.safetensors"), "official checkpoint"),
      writeFile(join(ltx, "ltx-2.3-22b-distilled-lora-384.safetensors"), "legacy lora"),
      writeFile(join(ltx, "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"), "official lora"),
      writeFile(join(ltx, "ltx-2.3-spatial-upscaler-x2-1.0.safetensors"), "legacy upscaler"),
      writeFile(join(ltx, "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"), "official upscaler"),
      ...[legacyGemma, officialGemma].flatMap((path) => [
        writeFile(join(path, "tokenizer.model"), "tokenizer"),
        writeFile(join(path, "config.json"), "{}"),
        writeFile(join(path, "model.safetensors.index.json"), "{}"),
      ]),
    ]);

    const inventory = await discoverModels([root]);
    const request = withDiscoveredModelDefaults(createDefaultRequest("audio-to-video"), inventory);

    expect(request.models.checkpointPath).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-dev-checkpoint")?.localPath,
    );
    expect(request.models.gemmaRoot).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-gemma")?.localPath,
    );
    expect(request.models.distilledLora.path).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-distilled-lora")?.localPath,
    );
    expect(request.models.spatialUpscalerPath).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-spatial-upscaler")?.localPath,
    );
    expect(inventory.recommendations.find((item) => item.id === "ltx23-dev-checkpoint")).toMatchObject({
      present: false,
      integrity: "size-mismatch",
    });
  });

  it("migrates a stored native-dialogue job onto the verified official stack", () => {
    const request = createDefaultRequest("two-stage");
    request.promptParts.dialogue = "Guten Morgen";
    request.prompt = 'The woman says exactly: "Guten Morgen".';
    request.enhancePrompt = true;
    request.models.checkpointPath = "/legacy/ltx-dev.safetensors";
    request.models.gemmaRoot = "/legacy/DreamFast__gemma-3-12b-it-heretic";
    request.models.distilledLora.path = "/legacy/ltx-2.3-22b-distilled-lora-384.safetensors";
    request.models.spatialUpscalerPath = "/legacy/ltx-2.3-spatial-upscaler-x2-1.0.safetensors";
    const inventory = {
      roots: [],
      scannedAt: new Date(0).toISOString(),
      truncated: false,
      errors: [],
      items: [],
      recommendations: recommendedModelAssets.map((asset) => ({
        ...asset,
        present: true,
        integrity: "verified" as const,
        actualSha256: "expectedSha256" in asset ? asset.expectedSha256 : null,
      })),
    };

    const resolved = withDiscoveredModelDefaults(request, inventory);

    expect(resolved.enhancePrompt).toBe(false);
    expect(resolved.models.checkpointPath).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-dev-checkpoint")?.localPath,
    );
    expect(resolved.models.gemmaRoot).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-gemma")?.localPath,
    );
    expect(resolved.models.distilledLora.path).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-distilled-lora")?.localPath,
    );
    expect(resolved.models.spatialUpscalerPath).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-spatial-upscaler")?.localPath,
    );
  });

  it("keeps the canonical speech path when the official Gemma directory is incomplete", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-models-"));
    temporaryRoots.push(root);
    const incompleteOfficialGemma = join(root, "google__gemma-3-12b-it-qat-q4_0-unquantized");
    const fallbackGemma = join(root, "DreamFast__gemma-3-12b-it-heretic");
    await Promise.all([mkdir(incompleteOfficialGemma), mkdir(fallbackGemma)]);
    await Promise.all([
      writeFile(join(incompleteOfficialGemma, "README.md"), "incomplete"),
      writeFile(join(fallbackGemma, "tokenizer.model"), "tokenizer"),
      writeFile(join(fallbackGemma, "config.json"), "{}"),
      writeFile(join(fallbackGemma, "model.safetensors.index.json"), "{}"),
    ]);

    const inventory = await discoverModels([root]);
    const request = withDiscoveredModelDefaults(createDefaultRequest("audio-to-video"), inventory);

    expect(inventory.recommendations.find((item) => item.id === "ltx23-gemma")).toMatchObject({
      present: false,
    });
    expect(request.models.gemmaRoot).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-gemma")?.localPath,
    );
  });

  it("never overwrites explicit model selections for non-speech generation", () => {
    const request = createDefaultRequest("two-stage");
    request.prompt = "A silent landscape.";
    request.promptParts.dialogue = "";
    request.models.gemmaRoot = "/models/custom-gemma";
    request.models.distilledLora.path = "/models/custom-lora.safetensors";
    request.models.spatialUpscalerPath = "/models/custom-upscaler.safetensors";

    const resolved = withDiscoveredModelDefaults(request, {
      roots: [],
      scannedAt: new Date(0).toISOString(),
      truncated: false,
      errors: [],
      items: [],
      recommendations: [],
    });

    expect(resolved.models.gemmaRoot).toBe("/models/custom-gemma");
    expect(resolved.models.distilledLora.path).toBe("/models/custom-lora.safetensors");
    expect(resolved.models.spatialUpscalerPath).toBe("/models/custom-upscaler.safetensors");
  });

  it("reports unreadable roots without failing the whole inventory", async () => {
    const inventory = await discoverModels(["/definitely/not/a/model/root"]);
    expect(inventory.items).toEqual([]);
    expect(inventory.errors).toHaveLength(1);
  });
});
