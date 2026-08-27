import type { PublicStudioOutput as StudioOutput } from "../shared/outputPublic.js";
import { usesOfficialSpeechStack } from "../shared/models.js";

export function isSpeechQualityCandidate(output: StudioOutput): boolean {
  const request = output.request;
  if (output.trustStatus === "legacy-unattested"
    || !output.settingsAvailable
    || output.jobStatus !== "completed"
    || !request) return false;
  return request.mode !== "text-to-audio" && usesOfficialSpeechStack(request);
}

export function isT2aAudioQualityCandidate(output: StudioOutput): boolean {
  return output.trustStatus !== "legacy-unattested"
    && output.name.toLowerCase().endsWith(".wav")
    && output.jobStatus === "completed"
    && output.request?.mode === "text-to-audio";
}
