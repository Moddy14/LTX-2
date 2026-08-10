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
      recommendedModelAssets.find((asset) => asset.id === "ltx23-dev-fp8-checkpoint")?.localPath,
    );
    expect(resolved.quantization.mode).toBe("fp8-scaled-mm");
    expect(resolved.models.gemmaRoot).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-gemma")?.localPath,
    );
    expect(resolved.models.distilledLora.path).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-comfy-distilled-lora")?.localPath,
    );
    expect(resolved.models.spatialUpscalerPath).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-spatial-upscaler")?.localPath,
    );
  });

  it("pins IC-LoRA jobs to the verified official Union-Control model", () => {
    const request = createDefaultRequest("ic-lora");
    request.icLora.lora.path = "/legacy/arbitrary-control.safetensors";
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

    expect(resolved.icLora.lora.path).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-union-control-lora")?.localPath,
    );
    expect(resolved.models.distilledCheckpointPath).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-distilled-fp8-checkpoint")?.localPath,
    );
    expect(resolved.models.gemmaLora.path).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-gemma-abliterated-lora")?.localPath,
    );
    expect(resolved.quantization.mode).toBe("fp8-scaled-mm");
  });

  it("pins Ingredients to its gated official IC-LoRA asset", () => {
    const request = createDefaultRequest("ic-lora");
    request.icLora.profile = "ingredients";
    request.icLora.lora.path = "/legacy/arbitrary-control.safetensors";
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
    const asset = recommendedModelAssets.find((item) => item.id === "ltx23-ingredients-lora");

    expect(asset).toMatchObject({
      repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-Ingredients",
      filename: "ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors",
      access: "gated",
      expectedSizeBytes: 1_308_778_338,
      expectedSha256: "515e4e139001ac6282357a5b35372e42e98b3affd5fcc886a52242abeed19559",
    });
    expect(resolved.icLora.lora.path).toBe(asset?.localPath);
  });

  it.each([
    [
      "motion-track",
      "ltx23-motion-track-lora",
      "e279807ee3aa3db1ce60188d665ff83342860367dcd6bac19f8bd5a99a9e1dca",
    ],
    [
      "pixel-upscaler",
      "ltx23-pixel-upscaler-x4-lora",
      "5b6370c3cc3a9a773f3655a411fd8ea4b47f4237bd2288a35b3291e2a33840f5",
    ],
    [
      "v2v-instant-shave",
      "ltx23-instant-shave-lora",
      "04231f1befeda653ab98081dd0f58114b9bc71782cdc687239a1610a39a9b0a2",
    ],
    [
      "inpainting",
      "ltx23-inoutpaint-lora",
      "73dd0841c0d4f0eb26fb1f017781b841b2752021944ac5ecefe57917f6dae6b5",
    ],
    [
      "outpainting",
      "ltx23-inoutpaint-lora",
      "73dd0841c0d4f0eb26fb1f017781b841b2752021944ac5ecefe57917f6dae6b5",
    ],
  ] as const)("pins %s to the published asset", (profile, assetId, expectedSha256) => {
    const request = createDefaultRequest("ic-lora");
    request.icLora.profile = profile;
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
    const asset = recommendedModelAssets.find((item) => item.id === assetId);

    expect(resolved.icLora.lora.path).toBe(asset?.localPath);
    expect(asset && "expectedSha256" in asset ? asset.expectedSha256 : null).toBe(expectedSha256);
  });

  it("pins HDR to its checkpoint, upscaler, LoRA and scene embeddings", () => {
    const request = createDefaultRequest("ic-lora");
    request.icLora.profile = "hdr";
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

    expect(resolved.models.distilledCheckpointPath).toBe(
      recommendedModelAssets.find((item) => item.id === "lipdub-distilled-checkpoint")?.localPath,
    );
    expect(resolved.models.spatialUpscalerPath).toBe(
      recommendedModelAssets.find((item) => item.id === "ltx23-spatial-upscaler")?.localPath,
    );
    expect(resolved.icLora.lora.path).toBe(
      recommendedModelAssets.find((item) => item.id === "ltx23-hdr-lora")?.localPath,
    );
    expect(resolved.icLora.hdrTextEmbeddingsPath).toBe(
      recommendedModelAssets.find((item) => item.id === "ltx23-hdr-scene-embeddings")?.localPath,
    );
  });

  it("pins ID-LoRA jobs to the verified TalkVid identity stack", () => {
    const request = createDefaultRequest("id-lora");
    request.idLora.lora.path = "/legacy/arbitrary-id.safetensors";
    request.models.distilledLora.path = "/legacy/distilled.safetensors";
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
    expect(resolved.idLora.lora.path).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-id-lora-talkvid")?.localPath,
    );
    expect(resolved.models.distilledLora.path).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-comfy-distilled-lora")?.localPath,
    );
  });

  it("pins the native Comfy workflows to the documented dynamic Distilled LoRA", () => {
    const asset = recommendedModelAssets.find((item) => item.id === "ltx23-comfy-distilled-lora");
    expect(asset).toMatchObject({
      repoId: "Comfy-Org/ltx-2.3",
      filename: "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors",
      access: "public",
      expectedSizeBytes: 2_741_024_390,
      expectedSha256: "31e0c0195fb841bf31af78e8b60858f489e87ddcea4a5239abc80943da65e3ac",
    });
  });

  it("pins new LipDub jobs to the published Comfy HQ model stack", () => {
    const request = createDefaultRequest("lipdub");
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

    expect(resolved.lipDub.pipelineProfile).toBe("official-comfy-hq");
    expect(resolved.models.checkpointPath).toBe(
      recommendedModelAssets.find((asset) => asset.id === "ltx23-dev-checkpoint")?.localPath,
    );
    expect(resolved.models.distilledLora).toMatchObject({
      path: recommendedModelAssets.find((asset) => asset.id === "ltx23-distilled-lora")?.localPath,
      strength: 0.5,
    });
    expect(resolved.lipDub.lora.path).toBe(
      recommendedModelAssets.find((asset) => asset.id === "lipdub-lora")?.localPath,
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
