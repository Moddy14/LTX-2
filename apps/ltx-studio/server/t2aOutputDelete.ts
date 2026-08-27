import type { DeletedStudioOutput } from "../shared/outputs.js";

export const T2A_AUDIO_ANALYSIS_ARTIFACT_SUFFIX = ".ltx-t2a-audio-analysis.json";

/**
 * Removes the private QA record before revoking/deleting the public output.
 * If private cleanup fails, the public output remains retryable. If the later
 * public deletion fails, no private T2A sidecar is left orphaned.
 */
export function deleteOutputWithT2aAudioCleanup(
  outputName: string,
  isT2aAudio: boolean,
  hadAudioAnalysis: boolean,
  removeAudioAnalysis: () => void,
  deleteOutput: () => DeletedStudioOutput,
): DeletedStudioOutput {
  if (isT2aAudio) removeAudioAnalysis();
  const deleted = deleteOutput();
  if (isT2aAudio && hadAudioAnalysis) {
    deleted.deletedArtifacts.push(`${outputName}${T2A_AUDIO_ANALYSIS_ARTIFACT_SUFFIX}`);
  }
  return deleted;
}
