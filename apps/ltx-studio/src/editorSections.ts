import {
  hasDialogueIntent,
  isAudioConditionedMode,
  type GenerationRequest,
} from "../shared/pipelines.js";

export function showsLipSyncControls(request: GenerationRequest): boolean {
  if (isAudioConditionedMode(request.mode) || request.mode === "text-to-audio") return false;
  // While a refiner is active the section must stay visible even without
  // dialogue, otherwise the only switch that can disable it again disappears.
  return hasDialogueIntent(request)
    || request.mode === "lipdub"
    || request.mode === "id-lora"
    || request.postprocess.latentSync.enabled
    || request.postprocess.museTalk.enabled
    || request.postprocess.lipForcing.enabled;
}
