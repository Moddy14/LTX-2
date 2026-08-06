import { afterEach, describe, expect, it, vi } from "vitest";

import { inspectLipDubReference } from "../server/lipdubDiagnostics.js";
import * as mediaProbe from "../server/mediaProbe.js";

const input = {
  path: "/inputs/reference.mp4",
  width: 768,
  height: 1344,
  dialogue: "Eins zwei drei vier fünf",
  prompt: "",
};

describe("LipDub reference diagnostics", () => {
  it("scales the official Comfy HQ target to published pixel area without changing aspect ratio", () => {
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 512,
      height: 512,
      frames: 97,
      fps: 24,
      durationSeconds: 4.04,
      hasAudio: true,
    });

    const result = inspectLipDubReference({
      ...input,
      width: 1472,
      height: 1472,
      pipelineProfile: "official-comfy-hq",
    });

    expect(result.recommendedTarget).toMatchObject({ width: 1472, height: 1472, fps: 24 });
    expect(result.findings.some((finding) => finding.code === "output-size-mismatch")).toBe(false);
  });

  afterEach(() => vi.restoreAllMocks());

  it("marks an exact CFR 8k+1 reference with aligned audio as ready", () => {
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 768,
      height: 1344,
      frames: 97,
      fps: 24,
      durationSeconds: 97 / 24,
      hasAudio: true,
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      nominalFps: 24,
      constantFrameRate: true,
      videoStartSeconds: 0,
      videoStreamCount: 1,
      audioCodec: "aac",
      audioSampleRate: 48000,
      audioChannels: 2,
      audioChannelLayout: "stereo",
      audioDurationSeconds: 97 / 24,
      audioStartSeconds: 0,
      audioStreamCount: 1,
      audioVideoDurationDeltaSeconds: 0,
      audioVideoStartDeltaSeconds: 0,
      sampleAspectRatio: "1:1",
      displayAspectRatio: "4:7",
    });

    const result = inspectLipDubReference(input);

    expect(result.status).toBe("ready");
    expect(result.findings).toEqual([]);
    expect(result.metadata).toMatchObject({
      frames: 97,
      snappedFrames: 97,
      droppedFrames: 0,
      constantFrameRate: true,
      audioSampleRate: 48000,
      dialogueWords: 5,
    });
    expect(result.recommendedTarget).toEqual({ width: 768, height: 1344, fps: 24 });
  });

  it("surfaces frame loss, fractional/VFR timing and audio drift as preparation findings", () => {
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 720,
      height: 1280,
      frames: 122,
      fps: 23.976,
      durationSeconds: 5.09,
      hasAudio: true,
      constantFrameRate: false,
      videoStreamCount: 1,
      audioStreamCount: 1,
      audioVideoDurationDeltaSeconds: 0.125,
      audioVideoStartDeltaSeconds: 0.08,
      sampleAspectRatio: "4:3",
    });

    const result = inspectLipDubReference({ ...input, dialogue: "Eins zwei drei vier fünf sechs sieben" });
    const codes = result.findings.map((finding) => finding.code);

    expect(result.status).toBe("needs-preparation");
    expect(codes).toEqual(expect.arrayContaining([
      "fractional-fps",
      "variable-frame-rate",
      "audio-video-duration-drift",
      "audio-video-start-drift",
      "non-square-pixels",
      "frame-snap",
      "calibration-clip-recommended",
    ]));
    expect(result.metadata).toMatchObject({ snappedFrames: 121, droppedFrames: 1 });
    expect(result.recommendedTarget).toEqual({ width: 768, height: 1344, fps: 24 });
  });

  it("blocks a reference without audio even when its video timing is valid", () => {
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 768,
      height: 1344,
      frames: 97,
      fps: 24,
      durationSeconds: 97 / 24,
      hasAudio: false,
    });

    const result = inspectLipDubReference(input);

    expect(result.status).toBe("blocked");
    expect(result.findings).toContainEqual(expect.objectContaining({ code: "audio-missing", level: "error" }));
  });
});
