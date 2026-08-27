import type { PublicStudioAsset } from "../shared/assetPublic.js";
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
  asset: Pick<PublicStudioAsset, "path" | "name">,
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
