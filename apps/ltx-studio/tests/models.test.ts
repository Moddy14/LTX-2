import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { withDiscoveredModelDefaults } from "../shared/models.js";
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

  it("marks the official LipDub LoRA recommendation present when the file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-models-"));
    temporaryRoots.push(root);
    const repo = join(root, "Lightricks__LTX-2.3-22b-IC-LoRA-LipDub");
    await mkdir(repo);
    const localPath = join(repo, "ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors");
    await writeFile(localPath, "lora");

    const inventory = await discoverModels([root]);
    expect(inventory.items.map((item) => item.name)).toContain("ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors");
    expect(inventory.recommendations.find((item) => item.id === "lipdub-lora")).toMatchObject({
      present: true,
      localPath,
    });
  });

  it("marks the LipDub spatial upscaler recommendation present when the current file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-models-"));
    temporaryRoots.push(root);
    const repo = join(root, "Lightricks__LTX-2.3");
    await mkdir(repo);
    const localPath = join(repo, "ltx-2.3-spatial-upscaler-x2-1.1.safetensors");
    await writeFile(localPath, "upscaler");

    const inventory = await discoverModels([root]);
    expect(inventory.items.map((item) => item.name)).toContain("ltx-2.3-spatial-upscaler-x2-1.1.safetensors");
    expect(inventory.recommendations.find((item) => item.id === "lipdub-spatial-upscaler")).toMatchObject({
      present: true,
      localPath,
    });
  });

  it("marks the LipDub distilled checkpoint recommendation present when the current file exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-models-"));
    temporaryRoots.push(root);
    const repo = join(root, "Lightricks__LTX-2.3");
    await mkdir(repo);
    const localPath = join(repo, "ltx-2.3-22b-distilled-1.1.safetensors");
    await writeFile(localPath, "checkpoint");

    const inventory = await discoverModels([root]);
    expect(inventory.items.map((item) => item.name)).toContain("ltx-2.3-22b-distilled-1.1.safetensors");
    expect(inventory.recommendations.find((item) => item.id === "lipdub-distilled-checkpoint")).toMatchObject({
      present: true,
      localPath,
    });
  });

  it("prefers the official LTX-2.3 A2V stack over alphabetically earlier legacy assets", async () => {
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
      join(ltx, "ltx-2.3-22b-dev.safetensors"),
    );
    expect(request.models.gemmaRoot).toBe(officialGemma);
    expect(request.models.distilledLora.path).toBe(
      join(ltx, "ltx-2.3-22b-distilled-lora-384-1.1.safetensors"),
    );
    expect(request.models.spatialUpscalerPath).toBe(
      join(ltx, "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"),
    );
  });

  it("reports an incomplete official Gemma directory instead of treating a fallback as official", async () => {
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
    expect(request.models.gemmaRoot).toBe(fallbackGemma);
  });

  it("never overwrites explicit model selections with recommendations", () => {
    const request = createDefaultRequest("audio-to-video");
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
