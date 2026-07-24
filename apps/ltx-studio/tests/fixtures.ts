import {
  createDefaultRequest,
  type GenerationRequest,
  type PipelineMode,
} from "../shared/pipelines.js";

export function validRequest(mode: PipelineMode = "two-stage"): GenerationRequest {
  const request = createDefaultRequest(mode);
  request.prompt = "A precise cinematic scene with synchronized sound.";
  request.models.checkpointPath = "/models/ltx/checkpoint.safetensors";
  request.models.distilledCheckpointPath = "/models/ltx/distilled.safetensors";
  request.models.gemmaRoot = "/models/gemma";
  request.models.spatialUpscalerPath = "/models/ltx/upscaler.safetensors";
  request.models.distilledLora = { path: "/models/ltx/distilled-lora.safetensors", strength: 1 };

  if (mode === "keyframes") {
    request.images = [
      { path: "/inputs/first.png", name: "first.png", frameIndex: 0, strength: 1, crf: 33 },
      { path: "/inputs/last.png", name: "last.png", frameIndex: 120, strength: 1, crf: 33 },
    ];
  }
  if (mode === "ic-lora") {
    request.models.loras = [{ path: "/models/ltx/ic-lora.safetensors", strength: 1 }];
    request.icLora.videoConditioning = [
      { path: "/inputs/control.mp4", name: "control.mp4", strength: 1 },
    ];
  }
  if (mode === "audio-to-video") {
    request.audio = { path: "/inputs/source.wav", name: "source.wav", startTime: 0, maxDuration: 5 };
  }
  if (mode === "retake") {
    request.retake.videoPath = "/inputs/source.mp4";
    request.retake.videoName = "source.mp4";
  }
  return request;
}
