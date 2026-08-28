import { describe, expect, it } from "vitest";

import { availableExperimentVariables } from "../shared/experiments.js";
import { validLtx25SplitRequest, validRequest } from "./fixtures.js";

describe("ExperimentPanel treatment availability", () => {
  it("never offers inert A2V guidance for the official IA2V SimpleDenoiser workflow", () => {
    const variables = availableExperimentVariables(validLtx25SplitRequest("image-audio-to-video"));
    expect(variables).not.toContain("a2v-guidance");
    expect(variables).toContain("positive-prompt");
    expect(variables).toContain("program-audio-delay-ms");
  });

  it("offers neutral output timing only on the exact native split-2.5 IA2V baseline", () => {
    const native = validLtx25SplitRequest("image-audio-to-video");
    expect(availableExperimentVariables(native)).toContain("program-audio-delay-ms");
    expect(availableExperimentVariables(validRequest("image-audio-to-video")))
      .not.toContain("program-audio-delay-ms");

    native.postprocess.lipForcing.enabled = true;
    expect(availableExperimentVariables(native)).not.toContain("program-audio-delay-ms");
    expect(availableExperimentVariables(native)).toContain("lipforcing-program-audio-delay-ms");
  });

  it("retains A2V guidance for the guided audio-to-video workflow that consumes it", () => {
    expect(availableExperimentVariables(validRequest("audio-to-video")))
      .toContain("a2v-guidance");
  });

  it("does not offer prompt ablation outside the proven split LTX-2.5 IA2V command", () => {
    expect(availableExperimentVariables(validRequest("image-audio-to-video")))
      .not.toContain("positive-prompt");
    expect(availableExperimentVariables(validLtx25SplitRequest("ic-lora")))
      .not.toContain("positive-prompt");
  });
});
