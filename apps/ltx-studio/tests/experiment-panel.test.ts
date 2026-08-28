import { describe, expect, it } from "vitest";

import { availableExperimentVariables } from "../shared/experiments.js";
import { validRequest } from "./fixtures.js";

describe("ExperimentPanel treatment availability", () => {
  it("never offers inert A2V guidance for the official IA2V SimpleDenoiser workflow", () => {
    expect(availableExperimentVariables(validRequest("image-audio-to-video")))
      .not.toContain("a2v-guidance");
  });

  it("retains A2V guidance for the guided audio-to-video workflow that consumes it", () => {
    expect(availableExperimentVariables(validRequest("audio-to-video")))
      .toContain("a2v-guidance");
  });
});
