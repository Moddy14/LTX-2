import { describe, expect, it } from "vitest";

import { showsLipSyncControls } from "../src/editorSections.js";
import { validRequest } from "./fixtures.js";

describe("lip sync section visibility", () => {
  it("keeps the section visible while a refiner is active without dialogue", () => {
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "";
    request.postprocess.lipForcing.enabled = true;

    expect(showsLipSyncControls(request)).toBe(true);
  });

  it("hides the section for silent video without refiners", () => {
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "";

    expect(showsLipSyncControls(request)).toBe(false);
  });

  it("leaves audio-conditioned modes to their own controls", () => {
    const request = validRequest("image-audio-to-video");
    request.postprocess.lipForcing.enabled = true;

    expect(showsLipSyncControls(request)).toBe(false);
  });
});
