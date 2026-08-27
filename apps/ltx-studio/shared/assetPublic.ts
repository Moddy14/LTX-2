import { z } from "zod";

import { assetKinds } from "./assets.js";

export const publicAssetDerivationSummarySchema = z.object({
  operation: z.enum([
    "lipdub-reference-prepare",
    "image-face-crop",
    "sequence-assemble",
    "output-frame",
  ]),
  sourceCount: z.number().int().min(1),
  createdAt: z.string().datetime(),
}).strict();

export const publicStudioAssetSchema = z.object({
  id: z.string().uuid(),
  path: z.string().min(1),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  kind: z.enum(assetKinds),
  url: z.string().startsWith("/api/uploads/"),
  createdAt: z.string().datetime(),
  derivation: publicAssetDerivationSummarySchema.nullable(),
}).strict();

const dimensionsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

export const publicAssetListResponseSchema = z.object({
  assets: z.array(publicStudioAssetSchema),
}).strict();

export const publicImageCropResponseSchema = z.object({
  asset: publicStudioAssetSchema,
  source: dimensionsSchema,
  crop: z.object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict(),
  target: dimensionsSchema,
  fit: z.enum(["stretch", "bokeh"]),
  coverage: z.number().finite().positive().max(1).nullable(),
  feather: z.number().int().nonnegative().nullable(),
  scaleFilter: z.literal("lanczos"),
}).strict();

const publicFrameMetricsSchema = z.object({
  faceSharpness: z.number().finite().nonnegative(),
  faceAreaRatio: z.number().finite().min(0).max(1),
  faceConfidence: z.number().finite().min(0).max(1),
  stability: z.number().finite().min(0).max(1),
  exposure: z.number().finite().min(0).max(1),
  frontalness: z.number().finite().min(0).max(1),
  prominentFaceCount: z.number().int().positive(),
}).strict();

export const publicOutputFrameRecommendationSchema = z.object({
  atSeconds: z.number().finite().nonnegative(),
  score: z.number().finite().min(0).max(1),
  sampledFrames: z.number().int().positive().max(120),
  eligibleFrames: z.number().int().positive().max(120),
  metrics: publicFrameMetricsSchema,
}).strict();

export const publicOutputFrameResponseSchema = z.object({
  asset: publicStudioAssetSchema,
  recommendation: publicOutputFrameRecommendationSchema.nullable(),
}).strict();

export const publicSequenceResponseSchema = z.object({
  asset: publicStudioAssetSchema,
  shots: z.array(z.object({
    outputName: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    frames: z.number().int().positive().nullable(),
    durationSeconds: z.number().finite().positive().nullable(),
    trimStartSeconds: z.number().finite().nonnegative(),
    trimEndSeconds: z.number().finite().nonnegative(),
    usedSeconds: z.number().finite().positive().nullable(),
  }).strict()).min(2),
  target: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    durationSeconds: z.number().finite().positive().nullable(),
  }).strict(),
}).strict();

export const publicLipDubReferenceResponseSchema = z.object({
  asset: publicStudioAssetSchema,
  target: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.union([z.literal(24), z.literal(25), z.literal(30)]),
    frames: z.number().int().positive(),
    durationSeconds: z.number().finite().positive(),
  }).strict(),
  trim: z.object({
    startSeconds: z.number().finite().nonnegative(),
    requestedDurationSeconds: z.number().finite().positive(),
  }).strict().nullable(),
}).strict();

export type PublicStudioAsset = z.infer<typeof publicStudioAssetSchema>;
export type PublicAssetListResponse = z.infer<typeof publicAssetListResponseSchema>;
export type PublicImageCropResponse = z.infer<typeof publicImageCropResponseSchema>;
export type PublicOutputFrameResponse = z.infer<typeof publicOutputFrameResponseSchema>;
export type PublicSequenceResponse = z.infer<typeof publicSequenceResponseSchema>;
export type PublicLipDubReferenceResponse = z.infer<typeof publicLipDubReferenceResponseSchema>;
