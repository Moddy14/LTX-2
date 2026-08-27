import { describe, expect, it } from "vitest";

import {
  reconcileCompletedAnalysisTransitions,
  shouldAutoAnalyzeCompletedJob,
  shouldAutoAnalyzeCompletedT2aJob,
} from "../server/autoAnalysis.js";
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

  it("starts T2A analysis exactly once on a new audio completion", () => {
    const completedAudio = {
      status: "completed" as const,
      request: validRequest("text-to-audio"),
    };
    expect(shouldAutoAnalyzeCompletedT2aJob("running", completedAudio)).toBe(true);
    expect(shouldAutoAnalyzeCompletedT2aJob("completed", completedAudio)).toBe(false);
    expect(shouldAutoAnalyzeCompletedT2aJob(undefined, completedAudio)).toBe(true);
  });

  it("never routes a completed video into T2A analysis", () => {
    expect(shouldAutoAnalyzeCompletedT2aJob("running", {
      status: "completed",
      request: validRequest("image-audio-to-video"),
    })).toBe(false);
  });

  it("reconciles exactly once when T2A completes during startup recovery", () => {
    const request = validRequest("text-to-audio");
    const observed = new Map([["startup-job", "running" as const]]);
    const completed = [{ id: "startup-job", status: "completed" as const, request }];

    expect(reconcileCompletedAnalysisTransitions(observed, completed)).toEqual([
      { job: completed[0], kind: "t2a-audio" },
    ]);
    expect(reconcileCompletedAnalysisTransitions(observed, completed)).toEqual([]);
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
