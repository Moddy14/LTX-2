import type { GenerationRequest } from "./pipelines.js";

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
    integrity: "unverified",
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
    integrity: "unverified",
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
    integrity: "unverified",
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
    integrity: "unverified",
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

export function withDiscoveredModelDefaults(
  request: GenerationRequest,
  inventory: ModelInventory,
): GenerationRequest {
  const find = (kind: ModelKind, predicate: (name: string) => boolean = () => true) =>
    inventory.items.find((item) => item.kind === kind && predicate(item.name.toLowerCase()))?.path ?? "";
  const recommended = (id: RecommendedModelAsset["id"]) => {
    const asset = inventory.recommendations.find((item) => item.id === id && item.present);
    return asset?.localPath ?? "";
  };
  const officialUpscaler = request.mode === "lipdub"
    ? recommended("lipdub-spatial-upscaler")
    : recommended("ltx23-spatial-upscaler");

  return {
    ...request,
    models: {
      ...request.models,
      checkpointPath: request.models.checkpointPath
        || recommended("ltx23-dev-checkpoint")
        || find("checkpoint", (name) => !name.includes("fp8"))
        || find("checkpoint"),
      distilledCheckpointPath: request.models.distilledCheckpointPath
        || recommended("lipdub-distilled-checkpoint")
        || find("distilled-checkpoint"),
      gemmaRoot: request.models.gemmaRoot
        || recommended("ltx23-gemma")
        || find("gemma"),
      spatialUpscalerPath: request.models.spatialUpscalerPath
        || officialUpscaler
        || find("spatial-upscaler", (name) => name.includes("x2"))
        || find("spatial-upscaler"),
      distilledLora: {
        ...request.models.distilledLora,
        path: request.models.distilledLora.path
          || recommended("ltx23-distilled-lora")
          || find("lora", (name) => name.includes("distilled")),
      },
    },
    lipDub: {
      ...request.lipDub,
      lora: {
        ...request.lipDub.lora,
        path: request.lipDub.lora.path
          || recommended("lipdub-lora")
          || find("lora", (name) => name.includes("lipdub") || name.includes("lip-dub")),
      },
    },
  };
}
