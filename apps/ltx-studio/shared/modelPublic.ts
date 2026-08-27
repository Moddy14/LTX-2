import { z } from "zod";

import { modelKinds, recommendedModelAssetIds } from "./models.js";

export const publicModelInventoryItemSchema = z.object({
  kind: z.enum(modelKinds),
  path: z.string().min(1),
  name: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string().datetime(),
  precision: z.enum(["bf16", "fp8", "unknown"]),
}).strict();

export const publicRecommendedModelAssetSchema = z.object({
  id: z.enum(recommendedModelAssetIds),
  kind: z.enum(modelKinds),
  label: z.string().min(1).max(256),
  repoId: z.string().min(1).max(256),
  revision: z.string().min(1).max(256).optional(),
  sourcePath: z.string().min(1).max(1_024).optional(),
  filename: z.string().min(1).max(1_024),
  localPath: z.string().min(1),
  present: z.boolean(),
  access: z.enum(["public", "gated"]),
  expectedSizeBytes: z.number().int().positive().optional(),
  integrity: z.enum([
    "verified",
    "missing",
    "unverified",
    "size-mismatch",
    "sha256-mismatch",
  ]),
}).strict();

export const publicModelInventorySchema = z.object({
  roots: z.array(z.string().min(1)).max(128),
  scannedAt: z.string().datetime(),
  truncated: z.boolean(),
  errors: z.array(z.string().max(4_096)).max(5_000),
  items: z.array(publicModelInventoryItemSchema).max(5_000),
  recommendations: z.array(publicRecommendedModelAssetSchema).max(128),
}).strict();

export type PublicModelInventoryItem = z.infer<typeof publicModelInventoryItemSchema>;
export type PublicRecommendedModelAsset = z.infer<typeof publicRecommendedModelAssetSchema>;
export type PublicModelInventory = z.infer<typeof publicModelInventorySchema>;
