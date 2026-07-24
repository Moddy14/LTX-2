import type { StudioOutput } from "../shared/outputs.js";

export function isSpeechQualityCandidate(output: StudioOutput): boolean {
  const request = output.request;
  if (!output.settingsAvailable || output.jobStatus !== "completed" || !request) return false;
  return request.mode === "lipdub" || request.mode === "audio-to-video";
}
