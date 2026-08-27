import { describe, expect, it } from "vitest";

import {
  A2V_MAX_DERIVED_RAW_FRAMES,
  a2vTimelineMatchesInput,
  a2vFramesFromAudioDuration,
  effectiveA2vTimeline,
} from "../shared/a2vDuration.js";
import { admissionPreflightPlan } from "../shared/admissionPreflight.js";
import { estimateResources, requestComputeUnits } from "../shared/estimates.js";
import { generationRequestSchema, mergeGenerationRequest, type GenerationRequest } from "../shared/pipelines.js";
import { buildCommand } from "../server/command.js";
import { validRequest } from "./fixtures.js";

describe("LTX v1.3 A2V duration contract", () => {
  it.each(["image-audio-to-video", "audio-to-video"] as const)(
    "lets %s derive frames from the bounded audio window",
    (mode) => {
      const request = validRequest(mode);
      request.audio.maxDuration = 3.5;

      const args = buildCommand(request).args;

      expect(args).toEqual(expect.arrayContaining([
        "--audio-max-duration",
        "3.5",
        "--frame-rate",
        String(request.frameRate),
      ]));
      expect(args).not.toContain("--num-frames");
      expect(args).not.toContain("--official-comfy-sampler");
    },
  );

  it.each(["image-audio-to-video", "audio-to-video"] as const)(
    "lets %s use an explicit frame count when no audio cap is selected",
    (mode) => {
      const request = validRequest(mode);
      request.audio.maxDuration = null;

      const args = buildCommand(request).args;

      expect(args).toEqual(expect.arrayContaining([
        "--num-frames",
        String(request.numFrames),
        "--frame-rate",
        String(request.frameRate),
      ]));
      expect(args).not.toContain("--audio-max-duration");
    },
  );

  it("mirrors v1.3 floor, 8k+1 snap and 1024-raw-frame cap", () => {
    expect(a2vFramesFromAudioDuration(3.5, 24)).toBe(81);
    expect(a2vFramesFromAudioDuration(100, 24)).toBe(1017);
    expect(A2V_MAX_DERIVED_RAW_FRAMES).toBe(1024);
  });

  it("uses maxDuration conservatively until EOF is known", () => {
    const request = validRequest("image-audio-to-video");
    request.audio.startTime = 8.2;
    request.audio.maxDuration = 5;

    expect(effectiveA2vTimeline(request)).toMatchObject({
      frameCount: 113,
      durationSeconds: 113 / 24,
      upperBoundFrameCount: 113,
      exact: false,
      basis: "audio-cap-upper-bound",
    });
    const eofTimeline = effectiveA2vTimeline(request, 10);
    expect(eofTimeline).toMatchObject({
      frameCount: 41,
      durationSeconds: 41 / 24,
      upperBoundFrameCount: 113,
      exact: true,
      basis: "audio-eof",
    });
    expect(eofTimeline?.audioWindowSeconds).toBeCloseTo(1.8);
    const changedStart = structuredClone(request);
    changedStart.audio.startTime = 7;
    expect(eofTimeline && a2vTimelineMatchesInput(eofTimeline, request)).toBe(true);
    expect(eofTimeline && a2vTimelineMatchesInput(eofTimeline, changedStart)).toBe(false);
  });

  it("uses the effective frame upper bound in estimates and admission, not the stale GUI frame field", () => {
    const request = validRequest("audio-to-video");
    request.numFrames = 9;
    request.audio.maxDuration = 20;
    request.longClipAcknowledged = true;
    const explicit = structuredClone(request);
    explicit.audio.maxDuration = null;

    const estimate = estimateResources(request);

    expect(estimate.a2vTimeline).toMatchObject({
      frameCount: 473,
      upperBoundFrameCount: 473,
      exact: false,
    });
    expect(estimate.memoryGiB).toBeGreaterThan(estimateResources(explicit).memoryGiB);
    expect(requestComputeUnits(request)).toBeGreaterThan(requestComputeUnits(explicit));
    expect(admissionPreflightPlan(request).steps[0].estimatedMemoryGiB).toBe(estimate.memoryGiB);
  });

  it("gates and migrates long A2V audio windows from the effective duration", () => {
    const request = validRequest("image-audio-to-video");
    request.numFrames = 9;
    request.audio.maxDuration = 100;
    request.longClipAcknowledged = false;

    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.longClipAcknowledged = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    const stored = structuredClone(request) as Partial<GenerationRequest>;
    delete stored.longClipAcknowledged;
    expect(mergeGenerationRequest(stored).longClipAcknowledged).toBe(true);
  });
});
