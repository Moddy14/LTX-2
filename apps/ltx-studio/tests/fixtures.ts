import {
  createDefaultRequest,
  type GenerationRequest,
  type PipelineMode,
} from "../shared/pipelines.js";
import { documentedLtx23CheckpointAssetId } from "../shared/models.js";

export function validRequest(mode: PipelineMode = "two-stage"): GenerationRequest {
  const request = createDefaultRequest(mode);
  request.prompt = "A precise cinematic scene with synchronized sound.";
  request.models.checkpointPath = "/models/ltx/checkpoint.safetensors";
  request.models.distilledCheckpointPath = "/models/ltx/distilled.safetensors";
  request.models.gemmaRoot = "/models/gemma";
  request.models.gemmaLora = {
    enabled: true,
    path: "/models/gemma/gemma-abliterated-lora.safetensors",
    strength: 1,
  };
  request.models.spatialUpscalerPath = "/models/ltx/upscaler.safetensors";
  request.models.distilledLora = { path: "/models/ltx/distilled-lora.safetensors", strength: 1 };
  if (
    mode === "two-stage"
    || mode === "image-audio-to-video"
    || mode === "ic-lora"
    || mode === "lipdub"
    || mode === "text-to-audio"
  ) {
    request.models.distilledLora.strength = 0.5;
  }
  if (documentedLtx23CheckpointAssetId(request)?.includes("fp8")) {
    request.quantization.mode = "fp8-scaled-mm";
  } else if (mode === "text-to-audio") {
    request.quantization.mode = "fp8-cast";
  }

  if (mode === "keyframes") {
    request.images = [
      { path: "/inputs/first.png", name: "first.png", frameIndex: 0, strength: 0.7, crf: 33 },
      {
        path: "/inputs/last.png",
        name: "last.png",
        frameIndex: request.numFrames - 1,
        strength: 0.7,
        crf: 33,
      },
    ];
  }
  if (mode === "ic-lora") {
    request.images = [
      { path: "/inputs/reference.png", name: "reference.png", frameIndex: 0, strength: 1, crf: 33 },
    ];
    request.icLora.lora = { path: "/models/ltx/ic-lora.safetensors", strength: 1 };
    request.icLora.mogeModelPath = "/models/moge_2_vitl_normal_fp16.safetensors";
    request.icLora.videoConditioning = [
      { path: "/inputs/control.mp4", name: "control.mp4", strength: 1 },
    ];
  }
  if (mode === "id-lora") {
    request.images = [
      { path: "/inputs/person.png", name: "person.png", frameIndex: 0, strength: 1, crf: 33 },
    ];
    request.promptParts.dialogue = "Dieser Text wird mit der Referenzstimme neu erzeugt.";
    request.idLora.referenceAudio = { path: "/inputs/voice-reference.wav", name: "voice-reference.wav" };
    request.idLora.lora = { path: "/models/ltx/ltx-2.3-id-lora-talkvid-3k.safetensors", strength: 1 };
    request.enhancePrompt = false;
  }
  if (mode === "image-audio-to-video" || mode === "audio-to-video") {
    request.audio = {
      ...request.audio,
      path: "/inputs/source.wav",
      name: "source.wav",
      startTime: 0,
      maxDuration: 5,
    };
  }
  if (mode === "image-audio-to-video") {
    request.images = [
      { path: "/inputs/speaker.png", name: "speaker.png", frameIndex: 0, strength: 1, crf: 33 },
    ];
  }
  if (mode === "lipdub") {
    request.promptParts.dialogue = "Das ist ein nativer LTX LipDub Test";
    request.prompt = 'A close portrait of the speaker saying exactly: "Das ist ein nativer LTX LipDub Test".';
    request.lipDub.referenceVideo = { path: "/inputs/speaker-reference.mp4", name: "speaker-reference.mp4", strength: 1 };
    request.lipDub.lora = { path: "/models/ltx/ltx-lipdub-lora.safetensors", strength: 1 };
    request.lipDub.targetLanguage = "Deutsch";
    request.lipDub.singleSpeakerAcknowledged = true;
  }
  if (mode === "retake") {
    request.retake.videoPath = "/inputs/source.mp4";
    request.retake.videoName = "source.mp4";
  }
  return request;
}

export function validLtx25SplitRequest(
  mode: "distilled" | "text-to-audio" | "ic-lora" = "distilled",
): GenerationRequest {
  const request = validRequest(mode);
  request.models = {
    ...request.models,
    layout: "split",
    generation: "2.5",
    transformerPath: "/models/ltx-2.5/ltx-2.5-22b-distilled-transformer-bf16.safetensors",
    textEncoderPath: "/models/ltx-2.5/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
    videoVaePath: "/models/ltx-2.5/ltx-2.5-video-vae-bf16.safetensors",
    audioVaePath: "/models/ltx-2.5/ltx-2.5-audio-vae-bf16.safetensors",
    durationHeadPath: "/models/ltx-2.5/ltx-2.5-duration-head-bf16.safetensors",
    promptEnhancerGemmaRoot: "/models/gemma-4-enhancer",
    spatialUpscalerPath: "/models/ltx-2.5/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
    gemmaLora: { ...request.models.gemmaLora, enabled: false },
  };
  request.quantization = { mode: "none", amaxPath: "" };
  return request;
}
