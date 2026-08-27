import type { StudioAsset } from "../shared/assets.js";
import {
  publicAssetListResponseSchema,
  publicImageCropResponseSchema,
  publicLipDubReferenceResponseSchema,
  publicOutputFrameResponseSchema,
  publicSequenceResponseSchema,
  publicStudioAssetSchema,
  type PublicAssetListResponse,
  type PublicImageCropResponse,
  type PublicLipDubReferenceResponse,
  type PublicOutputFrameResponse,
  type PublicSequenceResponse,
  type PublicStudioAsset,
} from "../shared/assetPublic.js";

export function toPublicStudioAsset(asset: StudioAsset): PublicStudioAsset {
  const derivation = asset.derivation
    ? {
        operation: asset.derivation.operation,
        sourceCount: 1 + asset.derivation.additionalSources.length,
        createdAt: asset.derivation.createdAt,
      }
    : null;
  return publicStudioAssetSchema.parse({
    id: asset.id,
    path: asset.path,
    name: asset.name,
    size: asset.size,
    kind: asset.kind,
    url: asset.url,
    createdAt: asset.createdAt,
    derivation,
  });
}

export function publicAssetListResponse(assets: readonly StudioAsset[]): PublicAssetListResponse {
  return publicAssetListResponseSchema.parse({
    assets: assets.map((asset) => toPublicStudioAsset(asset)),
  });
}

export function publicImageCropResponse(
  asset: StudioAsset,
  prepared: {
    source: { width: number; height: number };
    crop: { x: number; y: number; width: number; height: number };
    target: { width: number; height: number };
    fit: "stretch" | "bokeh";
    coverage: number | null;
    feather: number | null;
    scaleFilter: "lanczos";
  },
): PublicImageCropResponse {
  return publicImageCropResponseSchema.parse({
    asset: toPublicStudioAsset(asset),
    source: {
      width: prepared.source.width,
      height: prepared.source.height,
    },
    crop: {
      x: prepared.crop.x,
      y: prepared.crop.y,
      width: prepared.crop.width,
      height: prepared.crop.height,
    },
    target: {
      width: prepared.target.width,
      height: prepared.target.height,
    },
    fit: prepared.fit,
    coverage: prepared.coverage,
    feather: prepared.feather,
    scaleFilter: prepared.scaleFilter,
  });
}

export function publicOutputFrameResponse(
  asset: StudioAsset,
  recommendation: null | {
    atSeconds: number;
    score: number;
    sampledFrames: number;
    eligibleFrames: number;
    metrics: {
      faceSharpness: number;
      faceAreaRatio: number;
      faceConfidence: number;
      stability: number;
      exposure: number;
      frontalness: number;
      prominentFaceCount: number;
    };
  },
): PublicOutputFrameResponse {
  return publicOutputFrameResponseSchema.parse({
    asset: toPublicStudioAsset(asset),
    recommendation: recommendation
      ? {
          atSeconds: recommendation.atSeconds,
          score: recommendation.score,
          sampledFrames: recommendation.sampledFrames,
          eligibleFrames: recommendation.eligibleFrames,
          metrics: {
            faceSharpness: recommendation.metrics.faceSharpness,
            faceAreaRatio: recommendation.metrics.faceAreaRatio,
            faceConfidence: recommendation.metrics.faceConfidence,
            stability: recommendation.metrics.stability,
            exposure: recommendation.metrics.exposure,
            frontalness: recommendation.metrics.frontalness,
            prominentFaceCount: recommendation.metrics.prominentFaceCount,
          },
        }
      : null,
  });
}

export function publicSequenceResponse(
  asset: StudioAsset,
  prepared: {
    shots: readonly {
      outputName: string;
      width: number;
      height: number;
      frames: number | null;
      durationSeconds: number | null;
      trimStartSeconds: number;
      trimEndSeconds: number;
      usedSeconds: number | null;
    }[];
    target: { width: number; height: number; durationSeconds: number | null };
  },
): PublicSequenceResponse {
  return publicSequenceResponseSchema.parse({
    asset: toPublicStudioAsset(asset),
    shots: prepared.shots.map((shot) => ({
      outputName: shot.outputName,
      width: shot.width,
      height: shot.height,
      frames: shot.frames,
      durationSeconds: shot.durationSeconds,
      trimStartSeconds: shot.trimStartSeconds,
      trimEndSeconds: shot.trimEndSeconds,
      usedSeconds: shot.usedSeconds,
    })),
    target: {
      width: prepared.target.width,
      height: prepared.target.height,
      durationSeconds: prepared.target.durationSeconds,
    },
  });
}

export function publicLipDubReferenceResponse(
  asset: StudioAsset,
  prepared: {
    target: {
      width: number;
      height: number;
      fps: 24 | 25 | 30;
      frames: number;
      durationSeconds: number;
    };
    trim: { startSeconds: number; requestedDurationSeconds: number } | null;
  },
): PublicLipDubReferenceResponse {
  return publicLipDubReferenceResponseSchema.parse({
    asset: toPublicStudioAsset(asset),
    target: {
      width: prepared.target.width,
      height: prepared.target.height,
      fps: prepared.target.fps,
      frames: prepared.target.frames,
      durationSeconds: prepared.target.durationSeconds,
    },
    trim: prepared.trim
      ? {
          startSeconds: prepared.trim.startSeconds,
          requestedDurationSeconds: prepared.trim.requestedDurationSeconds,
        }
      : null,
  });
}
