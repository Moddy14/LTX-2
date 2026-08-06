import type { StudioOutput } from "../shared/outputs.js";
import { usesOfficialSpeechStack } from "../shared/models.js";

export function isSpeechQualityCandidate(output: StudioOutput): boolean {
  const request = output.request;
  if (!output.settingsAvailable || output.jobStatus !== "completed" || !request) return false;
  return request.mode !== "text-to-audio" && usesOfficialSpeechStack(request);
}
