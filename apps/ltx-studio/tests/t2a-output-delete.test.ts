import { describe, expect, it, vi } from "vitest";

import { deleteOutputWithT2aAudioCleanup } from "../server/t2aOutputDelete.js";

function deleted() {
  return { name: "speech.wav", sizeBytes: 1024, deletedArtifacts: ["speech.wav"] };
}

describe("T2A output deletion ordering", () => {
  it("durably removes private audio QA before deleting the public output", () => {
    const order: string[] = [];
    const result = deleteOutputWithT2aAudioCleanup(
      "speech.wav",
      true,
      true,
      () => { order.push("audio-analysis"); },
      () => { order.push("public-output"); return deleted(); },
    );

    expect(order).toEqual(["audio-analysis", "public-output"]);
    expect(result.deletedArtifacts).toContain("speech.wav.ltx-t2a-audio-analysis.json");
  });

  it("leaves the public output retryable when private cleanup fails", () => {
    const deleteOutput = vi.fn(() => deleted());
    expect(() => deleteOutputWithT2aAudioCleanup(
      "speech.wav",
      true,
      true,
      () => { throw new Error("fsync failed"); },
      deleteOutput,
    )).toThrow("fsync failed");
    expect(deleteOutput).not.toHaveBeenCalled();
  });

  it("does not run audio cleanup for video output deletion", () => {
    const removeAudioAnalysis = vi.fn();
    deleteOutputWithT2aAudioCleanup(
      "video.mp4",
      false,
      false,
      removeAudioAnalysis,
      () => ({ name: "video.mp4", sizeBytes: 2048, deletedArtifacts: ["video.mp4"] }),
    );
    expect(removeAudioAnalysis).not.toHaveBeenCalled();
  });
});
