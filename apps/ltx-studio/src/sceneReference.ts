import type { StudioAsset } from "../shared/assets.js";
import type { GenerationRequest, PipelineMode } from "../shared/pipelines.js";

const sceneReferenceModes = new Set<PipelineMode>([
  "two-stage",
  "two-stage-hq",
  "one-stage",
  "distilled",
  "id-lora",
  "keyframes",
  "image-audio-to-video",
]);

export function supportsSceneReference(mode: PipelineMode): boolean {
  return sceneReferenceModes.has(mode);
}

export function withSceneReference(
  request: GenerationRequest,
  asset: StudioAsset,
): GenerationRequest {
  return {
    ...request,
    sourceMode: "image",
    images: [
      {
        path: asset.path,
        name: asset.name,
        frameIndex: 0,
        strength: 1,
        crf: 18,
      },
      ...request.images.slice(1),
    ],
  };
}
