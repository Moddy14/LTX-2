export type ModelKind = "checkpoint" | "distilled-checkpoint" | "spatial-upscaler" | "lora" | "amax" | "gemma";

export type RecommendedModelAsset = {
  id: "lipdub-lora" | "lipdub-distilled-checkpoint" | "lipdub-spatial-upscaler";
  kind: ModelKind;
  label: string;
  repoId: string;
  filename: string;
  localPath: string;
  present: boolean;
  access: "public" | "gated";
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
    id: "lipdub-lora",
    kind: "lora",
    label: "LipDub IC-LoRA",
    repoId: "Lightricks/LTX-2.3-22b-IC-LoRA-LipDub",
    filename: "ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors",
    localPath:
      "/home/moddy/LTX-2.3-max/Lightricks__LTX-2.3-22b-IC-LoRA-LipDub/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors",
    present: false,
    access: "gated",
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
  },
] as const satisfies readonly RecommendedModelAsset[];
