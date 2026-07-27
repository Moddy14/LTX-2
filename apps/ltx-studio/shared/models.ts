import { hasDialogueIntent, type GenerationRequest } from "./pipelines.js";

export type ModelKind = "checkpoint" | "distilled-checkpoint" | "spatial-upscaler" | "lora" | "amax" | "gemma";

export type RecommendedModelAsset = {
  id:
    | "ltx23-dev-checkpoint"
    | "ltx23-gemma"
    | "ltx23-distilled-lora"
    | "ltx23-spatial-upscaler"
    | "lipdub-lora"
    | "lipdub-distilled-checkpoint"
    | "lipdub-spatial-upscaler";
  kind: ModelKind;
  label: string;
  repoId: string;
  filename: string;
  localPath: string;
  present: boolean;
  access: "public" | "gated";
  expectedSizeBytes?: number;
  expectedSha256?: string;
  expectedContents?: readonly {
    relativePath: string;
    expectedSizeBytes: number;
    expectedSha256: string;
  }[];
  actualSha256?: string | null;
  integrity: "verified" | "missing" | "unverified" | "size-mismatch" | "sha256-mismatch";
};

export type ModelInventoryItem = {
  kind: ModelKind;
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  precision: "bf16" | "fp8" | "unknown";
};

export type ModelInventory = {
  roots: string[];
  scannedAt: string;
  truncated: boolean;
  errors: string[];
  items: ModelInventoryItem[];
  recommendations: RecommendedModelAsset[];
};

export const recommendedModelAssets = [
  {
    id: "ltx23-dev-checkpoint",
    kind: "checkpoint",
    label: "LTX-2.3 Dev Checkpoint",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-22b-dev.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-dev.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 46_149_344_974,
    expectedSha256: "7ab7225325bc403448ea84b6db2269811a880e5118cd2ee2b6282a93d585016f",
    integrity: "missing",
  },
  {
    id: "ltx23-gemma",
    kind: "gemma",
    label: "LTX-2.3 Gemma QAT Q4",
    repoId: "google/gemma-3-12b-it-qat-q4_0-unquantized",
    filename: "google__gemma-3-12b-it-qat-q4_0-unquantized",
    localPath:
      "/home/moddy/LTX-2.3-max/google__gemma-3-12b-it-qat-q4_0-unquantized",
    present: false,
    access: "public",
    expectedContents: [
      {
        relativePath: "config.json",
        expectedSizeBytes: 1_611,
        expectedSha256: "72ba569f583e58bfd39e192d859bc0c0905c3d08b2d0d4e520b7f8543fc87cdc",
      },
      {
        relativePath: "preprocessor_config.json",
        expectedSizeBytes: 570,
        expectedSha256: "f688d6bb20c5017601c4011de7ca656da8485b540b05013efdaf986c0fcc918d",
      },
      {
        relativePath: "tokenizer.json",
        expectedSizeBytes: 33_384_570,
        expectedSha256: "7d4046bf0505a327dd5a0abbb427ecd4fc82f99c2ceaa170bc61ecde12809b0c",
      },
      {
        relativePath: "tokenizer.model",
        expectedSizeBytes: 4_689_074,
        expectedSha256: "1299c11d7cf632ef3b4e11937501358ada021bbdf7c47638d13c0ee982f2e79c",
      },
      {
        relativePath: "tokenizer_config.json",
        expectedSizeBytes: 1_157_001,
        expectedSha256: "31e860fdfa360fa5aa58fe93252799facde5a52d1352f77d45978ab2a7e9eeb1",
      },
      {
        relativePath: "chat_template.json",
        expectedSizeBytes: 1_615,
        expectedSha256: "fe16baf728db49457cde32802cd7efc0ac8a7a9877dbe22fe3322b2d9dc6ccd9",
      },
      {
        relativePath: "added_tokens.json",
        expectedSizeBytes: 35,
        expectedSha256: "50b2f405ba56a26d4913fd772089992252d7f942123cc0a034d96424221ba946",
      },
      {
        relativePath: "generation_config.json",
        expectedSizeBytes: 173,
        expectedSha256: "13da6aad6852a008419f46df754b3452fc96387a4213c25811509d474e5a4776",
      },
      {
        relativePath: "processor_config.json",
        expectedSizeBytes: 70,
        expectedSha256: "3ffd5f11778dc73e2b69b3c00535e4121e1badf7018136263cd17b5b34fbaa53",
      },
      {
        relativePath: "special_tokens_map.json",
        expectedSizeBytes: 662,
        expectedSha256: "2f7b0adf4fb469770bb1490e3e35df87b1dc578246c5e7e6fc76ecf33213a397",
      },
      {
        relativePath: "model.safetensors.index.json",
        expectedSizeBytes: 108_605,
        expectedSha256: "788cc42a1a92835df62d9a3791f47105f63504c7c404637a73288e9b11bc7b82",
      },
      {
        relativePath: "model-00001-of-00005.safetensors",
        expectedSizeBytes: 4_979_902_192,
        expectedSha256: "e6fb899db428481aafb45a20130457df6e247e7cb03b7d9f01ee4bc2a9a08138",
      },
      {
        relativePath: "model-00002-of-00005.safetensors",
        expectedSizeBytes: 4_931_296_592,
        expectedSha256: "d251e7fe9799d529405ddb61705a44cd700bd30a8b66a8d44ae26ddf8365dbc6",
      },
      {
        relativePath: "model-00003-of-00005.safetensors",
        expectedSizeBytes: 4_931_296_656,
        expectedSha256: "0684ef801385f0669a0b3e4ab160c50877efdbfa40eb97788595985de2743e78",
      },
      {
        relativePath: "model-00004-of-00005.safetensors",
        expectedSizeBytes: 4_931_296_656,
        expectedSha256: "b4b964e6526f81ccfa625c900b72ce92d5e0fd2debb75998763038ad06b9c541",
      },
      {
        relativePath: "model-00005-of-00005.safetensors",
        expectedSizeBytes: 4_601_000_928,
        expectedSha256: "4ef2de8f93e165b4e02425769fc566000b0674256ef0c3a27b23a0d45eb12088",
      },
    ],
    integrity: "missing",
  },
  {
    id: "ltx23-distilled-lora",
    kind: "lora",
    label: "LTX-2.3 Distilled LoRA 1.1",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-distilled-lora-384-1.1.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 7_605_507_256,
    expectedSha256: "f5d4953f3386197a4b4f5abdb17616ff256171e8075c111d6e7d2dfa6e823b3a",
    integrity: "missing",
  },
  {
    id: "ltx23-spatial-upscaler",
    kind: "spatial-upscaler",
    label: "LTX-2.3 Spatial Upscaler x2 1.1",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 995_743_560,
    expectedSha256: "5f416311fa8172b65af67530758964708d29a317b830d689a51143b7f91913ed",
    integrity: "missing",
  },
  {
    id: "lipdub-lora",
    kind: "lora",
    label: "LipDub IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-LipDub",
    filename: "ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-LipDub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors",
    present: false,
    access: "gated",
    expectedSizeBytes: 2_466_665_072,
    expectedSha256: "fc415b12cb639e78511bc264f85080c2f7b188e334c1d9fade76b310e2bc419c",
    integrity: "missing",
  },
  {
    id: "lipdub-distilled-checkpoint",
    kind: "distilled-checkpoint",
    label: "LipDub Distilled Checkpoint 1.1",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-22b-distilled-1.1.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-22b-distilled-1.1.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 46_149_345_334,
    expectedSha256: "b33b7fe4bbfe084f484be4aaf90b0f1d95dca20d403ac4c0e037eb8c4f0af7cc",
    integrity: "missing",
  },
  {
    id: "lipdub-spatial-upscaler",
    kind: "spatial-upscaler",
    label: "LipDub Spatial Upscaler x2 1.1",
    repoId: "Lightricks/LTX-2.3",
    filename: "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
    present: false,
    access: "public",
    expectedSizeBytes: 995_743_560,
    expectedSha256: "5f416311fa8172b65af67530758964708d29a317b830d689a51143b7f91913ed",
    integrity: "missing",
  },
] as const satisfies readonly RecommendedModelAsset[];

export function recommendedModelAsset(
  id: RecommendedModelAsset["id"],
): (typeof recommendedModelAssets)[number] {
  const asset = recommendedModelAssets.find((candidate) => candidate.id === id);
  if (!asset) throw new Error(`Unbekanntes empfohlenes Modellasset: ${id}`);
  return asset;
}

export function usesOfficialSpeechStack(request: GenerationRequest): boolean {
  return request.mode === "audio-to-video" || hasDialogueIntent(request);
}

export function requiredOfficialSpeechAssetIds(
  request: GenerationRequest,
): RecommendedModelAsset["id"][] {
  if (!usesOfficialSpeechStack(request)) return [];
  const usesDistilledCheckpoint = ["distilled", "ic-lora", "lipdub"].includes(request.mode)
    || (request.mode === "retake" && request.retake.distilled);
  return [
    "ltx23-gemma",
    usesDistilledCheckpoint ? "lipdub-distilled-checkpoint" : "ltx23-dev-checkpoint",
    ...(!["one-stage", "retake"].includes(request.mode)
      ? [request.mode === "lipdub" ? "lipdub-spatial-upscaler" as const : "ltx23-spatial-upscaler" as const]
      : []),
    ...(["two-stage", "two-stage-hq", "keyframes", "audio-to-video"].includes(request.mode)
      ? ["ltx23-distilled-lora" as const]
      : []),
    ...(request.mode === "lipdub" ? ["lipdub-lora" as const] : []),
  ];
}

export function withOfficialSpeechModelPaths(request: GenerationRequest): GenerationRequest {
  if (!usesOfficialSpeechStack(request)) return request;
  const usesDistilledCheckpoint = ["distilled", "ic-lora", "lipdub"].includes(request.mode)
    || (request.mode === "retake" && request.retake.distilled);
  return {
    ...request,
    enhancePrompt: ["two-stage", "two-stage-hq", "one-stage", "distilled"].includes(request.mode)
      ? false
      : request.enhancePrompt,
    models: {
      ...request.models,
      checkpointPath: usesDistilledCheckpoint
        ? request.models.checkpointPath
        : recommendedModelAsset("ltx23-dev-checkpoint").localPath,
      distilledCheckpointPath: usesDistilledCheckpoint
        ? recommendedModelAsset("lipdub-distilled-checkpoint").localPath
        : request.models.distilledCheckpointPath,
      gemmaRoot: recommendedModelAsset("ltx23-gemma").localPath,
      spatialUpscalerPath: !["one-stage", "retake"].includes(request.mode)
        ? recommendedModelAsset(
          request.mode === "lipdub" ? "lipdub-spatial-upscaler" : "ltx23-spatial-upscaler",
        ).localPath
        : request.models.spatialUpscalerPath,
      distilledLora: {
        ...request.models.distilledLora,
        path: ["two-stage", "two-stage-hq", "keyframes", "audio-to-video"].includes(request.mode)
          ? recommendedModelAsset("ltx23-distilled-lora").localPath
          : request.models.distilledLora.path,
      },
    },
    lipDub: {
      ...request.lipDub,
      lora: {
        ...request.lipDub.lora,
        path: request.mode === "lipdub"
          ? recommendedModelAsset("lipdub-lora").localPath
          : request.lipDub.lora.path,
      },
    },
  };
}

export function withDiscoveredModelDefaults(
  request: GenerationRequest,
  inventory: ModelInventory,
): GenerationRequest {
  if (usesOfficialSpeechStack(request)) return withOfficialSpeechModelPaths(request);
  const find = (kind: ModelKind, predicate: (name: string) => boolean = () => true) =>
    inventory.items.find((item) => item.kind === kind && predicate(item.name.toLowerCase()))?.path ?? "";
  const recommended = (id: RecommendedModelAsset["id"]) => {
    const asset = inventory.recommendations.find((item) => item.id === id && item.present);
    return asset?.localPath ?? "";
  };
  const officialUpscaler = request.mode === "lipdub"
    ? recommended("lipdub-spatial-upscaler")
    : recommended("ltx23-spatial-upscaler");
  const officialCheckpoint = recommended("ltx23-dev-checkpoint");
  const officialDistilledCheckpoint = recommended("lipdub-distilled-checkpoint");
  const officialGemma = recommended("ltx23-gemma");
  const officialDistilledLora = recommended("ltx23-distilled-lora");
  const officialLipDubLora = recommended("lipdub-lora");
  const usesDistilledCheckpoint = ["distilled", "ic-lora", "lipdub"].includes(request.mode)
    || (request.mode === "retake" && request.retake.distilled);
  const choose = (current: string, official: string, fallback: () => string) =>
    current || official || fallback();

  return {
    ...request,
    enhancePrompt: request.enhancePrompt,
    models: {
      ...request.models,
      checkpointPath: choose(
        request.models.checkpointPath,
        !usesDistilledCheckpoint ? officialCheckpoint : "",
        () => find("checkpoint", (name) => !name.includes("fp8")) || find("checkpoint"),
      ),
      distilledCheckpointPath: choose(
        request.models.distilledCheckpointPath,
        usesDistilledCheckpoint ? officialDistilledCheckpoint : "",
        () => find("distilled-checkpoint"),
      ),
      gemmaRoot: choose(request.models.gemmaRoot, officialGemma, () => find("gemma")),
      spatialUpscalerPath: choose(
        request.models.spatialUpscalerPath,
        officialUpscaler,
        () => find("spatial-upscaler", (name) => name.includes("x2")) || find("spatial-upscaler"),
      ),
      distilledLora: {
        ...request.models.distilledLora,
        path: choose(
          request.models.distilledLora.path,
          officialDistilledLora,
          () => find("lora", (name) => name.includes("distilled")),
        ),
      },
    },
    lipDub: {
      ...request.lipDub,
      lora: {
        ...request.lipDub.lora,
        path: request.mode === "lipdub"
          ? officialLipDubLora || request.lipDub.lora.path
          : request.lipDub.lora.path
            || recommended("lipdub-lora")
            || find("lora", (name) => name.includes("lipdub") || name.includes("lip-dub")),
      },
    },
  };
}
