import { describe, expect, it } from "vitest";

import { createDefaultRequest } from "../shared/pipelines.js";
import { supportsSceneReference, withSceneReference } from "../src/sceneReference.js";

const asset = {
  id: "scene-frame",
  path: "/tmp/scene-frame.png",
  name: "scene-frame.png",
  size: 1234,
  kind: "image" as const,
  url: "/api/uploads/image/scene-frame.png",
  createdAt: "2026-08-10T10:00:00.000Z",
};

describe("using a visible output frame as the next scene reference", () => {
  it("binds the frame at full strength without discarding later keyframes", () => {
    const request = createDefaultRequest("keyframes");
    request.images = [
      { path: "/tmp/old-first.png", name: "old-first.png", frameIndex: 0, strength: 0.7, crf: 33 },
      { path: "/tmp/last.png", name: "last.png", frameIndex: 120, strength: 0.8, crf: 21 },
    ];

    const updated = withSceneReference(request, asset);

    expect(updated.sourceMode).toBe("image");
    expect(updated.images).toEqual([
      { path: asset.path, name: asset.name, frameIndex: 0, strength: 1, crf: 18 },
      request.images[1],
    ]);
    expect(request.images[0].path).toBe("/tmp/old-first.png");
  });

  it("only exposes modes where the image slot is an actual scene reference", () => {
    expect(supportsSceneReference("two-stage")).toBe(true);
    expect(supportsSceneReference("image-audio-to-video")).toBe(true);
    expect(supportsSceneReference("lipdub")).toBe(false);
    expect(supportsSceneReference("retake")).toBe(false);
    expect(supportsSceneReference("text-to-audio")).toBe(false);
  });
});
