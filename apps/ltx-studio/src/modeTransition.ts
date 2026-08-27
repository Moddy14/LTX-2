import {
  createDefaultRequest,
  createPreferredRequest,
  isPreferredLtx25PipelineMode,
  type GenerationRequest,
  type PipelineMode,
} from "../shared/pipelines.js";
import {
  withDiscoveredModelDefaults,
  withOfficialSpeechModelPaths,
  type ModelInventory,
} from "../shared/models.js";

/**
 * Build the next editor request without carrying hidden execution state into a
 * pipeline whose contract does not include it. DFR intentionally starts with
 * every postprocessor disabled; refiners need their own explicit arm later.
 */
export function requestForModeChange(
  current: GenerationRequest,
  mode: PipelineMode,
  modelInventory: ModelInventory | null,
): GenerationRequest {
  const modeDefaults = isPreferredLtx25PipelineMode(mode)
    ? createPreferredRequest(mode)
    : createDefaultRequest(mode);
  const currentUsesLtx25SplitPack = current.models.layout === "split"
    && current.models.generation === "2.5";
  const currentUsesLtx23Monolith = current.models.layout === "monolith"
    && current.models.generation === "2.3";
  const hiddenIcLoraProfileIsRunnable = [
    "ingredients",
    "motion-track",
    "v2v-deblur",
  ].includes(current.icLora.profile);
  const preferredModels = isPreferredLtx25PipelineMode(mode)
    ? mode === "dfr"
      ? modeDefaults.models
      : currentUsesLtx25SplitPack
        ? {
            ...modeDefaults.models,
            ...current.models,
            layout: "split" as const,
            generation: "2.5" as const,
            gemmaLora: { enabled: false, path: "", strength: 1 },
          }
        : modeDefaults.models
    : mode === "lipdub"
      ? currentUsesLtx23Monolith
        ? { ...current.models, loras: [] }
        : modeDefaults.models
      : currentUsesLtx23Monolith
        ? current.models
        : modeDefaults.models;
  const next = withOfficialSpeechModelPaths({
    ...modeDefaults,
    prompt: current.prompt,
    promptParts: current.promptParts,
    negativePrompt: current.negativePrompt,
    enhancePrompt: isPreferredLtx25PipelineMode(mode)
      ? false
      : ["lipdub", "id-lora", "keyframes", "ic-lora", "text-to-audio"].includes(mode)
      ? false
      : current.enhancePrompt,
    sourceMode: ["keyframes", "ic-lora", "id-lora", "image-audio-to-video"].includes(mode)
      ? "image"
      : current.sourceMode,
    seed: current.seed,
    models: preferredModels,
    images: ["lipdub", "text-to-audio"].includes(mode) ? [] : current.images,
    quantization: isPreferredLtx25PipelineMode(mode)
      ? modeDefaults.quantization
      : current.quantization,
    // IC-LoRA carries profile state even while another mode is active. Preserve
    // an explicitly configured runnable 2.5 profile, but never promote hidden
    // compatibility state (notably held Union Control or a legacy-only profile)
    // into a latest-first LTX-2.5 request.
    icLora: mode === "ic-lora"
      && current.mode !== "ic-lora"
      && !hiddenIcLoraProfileIsRunnable
      ? modeDefaults.icLora
      : current.icLora,
    idLora: current.idLora,
    audio: current.audio,
    lipDub: current.lipDub,
    postprocess: ["text-to-audio", "dfr"].includes(mode)
      ? modeDefaults.postprocess
      : current.postprocess,
    retake: current.retake,
    continuity: current.continuity,
  });
  return modelInventory ? withDiscoveredModelDefaults(next, modelInventory) : next;
}
