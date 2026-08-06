import { describe, expect, it } from "vitest";

import { shouldAutoAnalyzeCompletedJob } from "../server/autoAnalysis.js";
import { validRequest } from "./fixtures.js";

describe("automatic speech output analysis", () => {
  it("starts once when a native speech job newly completes", () => {
    expect(shouldAutoAnalyzeCompletedJob("running", {
      status: "completed",
      request: validRequest("image-audio-to-video"),
    })).toBe(true);
  });

  it("does not restart analysis for a restored completed job", () => {
    expect(shouldAutoAnalyzeCompletedJob("completed", {
      status: "completed",
      request: validRequest("image-audio-to-video"),
    })).toBe(false);
  });

  it("does not send audio-only outputs into the video analysis pipeline", () => {
    expect(shouldAutoAnalyzeCompletedJob("running", {
      status: "completed",
      request: validRequest("text-to-audio"),
    })).toBe(false);
  });

  it("does not analyze a running or silent non-speech job", () => {
    expect(shouldAutoAnalyzeCompletedJob("queued", {
      status: "running",
      request: validRequest("image-audio-to-video"),
    })).toBe(false);

    const silent = validRequest("keyframes");
    silent.promptParts.dialogue = "";
    expect(shouldAutoAnalyzeCompletedJob("running", {
      status: "completed",
      request: silent,
    })).toBe(false);
  });
});
