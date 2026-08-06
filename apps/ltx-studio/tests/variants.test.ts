import { describe, expect, it } from "vitest";

import { nextVariantOutputName } from "../server/jobs.js";

describe("job variants", () => {
  it("allocates sequential non-destructive output names", () => {
    const unavailable = new Set(["scene-v01.mp4", "scene-v02.mp4"]);
    expect(nextVariantOutputName("scene.mp4", (name) => unavailable.has(name))).toBe("scene-v03.mp4");
  });

  it("keeps variants in the same filename family", () => {
    expect(nextVariantOutputName("scene-v07.mp4", () => false)).toBe("scene-v01.mp4");
  });

  it("preserves the WAV extension for text-to-audio variants", () => {
    expect(nextVariantOutputName("dialogue.wav", () => false)).toBe("dialogue-v01.wav");
  });
});
