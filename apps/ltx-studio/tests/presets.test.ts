import { describe, expect, it } from "vitest";

import {
  framesForDuration,
  matchingDfrResolutionPreset,
  matchingDurationPreset,
  matchingResolutionPreset,
  videoDurationSeconds,
} from "../shared/presets.js";

describe("LTX output presets", () => {
  it.each([
    [5, 121],
    [10, 241],
    [20, 481],
  ])("maps %s seconds at 24 FPS to %s frames", (seconds, frames) => {
    expect(framesForDuration(seconds, 24)).toBe(frames);
    expect(videoDurationSeconds(frames, 24)).toBe(seconds);
    expect(matchingDurationPreset(frames, 24)).toBe(seconds);
  });

  it("keeps custom frame rates on the 8k+1 lattice", () => {
    const frames = framesForDuration(5, 25);
    expect((frames - 1) % 8).toBe(0);
    expect(Math.abs(videoDurationSeconds(frames, 25) - 5)).toBeLessThan(0.2);
  });

  it("recognizes horizontal, vertical and square production presets", () => {
    expect(matchingResolutionPreset(1920, 1088)?.id).toBe("full-hd-landscape");
    expect(matchingResolutionPreset(1088, 1920)?.id).toBe("full-hd-portrait");
    expect(matchingResolutionPreset(1024, 1024)?.id).toBe("square");
    expect(matchingResolutionPreset(1408, 768)).toBeNull();
  });

  it("adds official 3840 x 2176 UHD only to the DFR preset surface", () => {
    expect(matchingDfrResolutionPreset(3840, 2176)?.id).toBe("dfr-uhd-4k");
    expect(matchingResolutionPreset(3840, 2176)).toBeNull();
    expect(3840 % 128).toBe(0);
    expect(2176 % 128).toBe(0);
  });
});
