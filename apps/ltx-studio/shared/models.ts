export type ModelKind = "checkpoint" | "distilled-checkpoint" | "spatial-upscaler" | "lora" | "amax" | "gemma";

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
};
