import { describe, expect, it } from "vitest";

import { isVideoPreviewUrl } from "../shared/media.js";

describe("source preview media selection", () => {
  it("keeps IC-LoRA image assets as images and video assets as video", () => {
    expect(isVideoPreviewUrl("/api/uploads/image/id.png")).toBe(false);
    expect(isVideoPreviewUrl("/api/uploads/video/id.mp4")).toBe(true);
    expect(isVideoPreviewUrl("/api/uploads/video/id.webm?version=1")).toBe(true);
  });
});
