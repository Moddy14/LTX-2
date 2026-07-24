import { describe, expect, it } from "vitest";

import { estimateResources } from "../shared/estimates.js";
import { estimateRequest } from "../server/estimates.js";
import { validRequest } from "./fixtures.js";

describe("resource and runtime estimates", () => {
  it("keeps the standard two-stage memory contract conservative", () => {
    const request = validRequest();
    expect(estimateResources(request).memoryGiB).toBe(64);
  });

  it("does not discount a BF16 checkpoint that is cast to FP8 at runtime", () => {
    const long = validRequest();
    long.numFrames = 481;
    long.longClipAcknowledged = true;
    const fullPrecision = estimateResources(long).memoryGiB;
    long.quantization.mode = "fp8-cast";
    expect(fullPrecision).toBeGreaterThan(64);
    expect(estimateResources(long).memoryGiB).toBe(fullPrecision);
  });

  it("discounts model memory only for a native FP8 checkpoint", () => {
    const request = validRequest();
    request.quantization.mode = "fp8-cast";
    request.models.checkpointPath = "/models/ltx-2.3-22b-dev-fp8.safetensors";
    expect(estimateResources(request).memoryGiB).toBe(62);
  });

  it("covers the measured native FP8 one-stage cold-load peak", () => {
    const request = validRequest("one-stage");
    request.width = 320;
    request.height = 576;
    request.numFrames = 25;
    request.quantization.mode = "fp8-cast";
    request.models.checkpointPath = "/models/ltx-2.3-22b-dev-fp8.safetensors";
    expect(estimateResources(request).memoryGiB).toBe(44);
  });

  it("shows no ETA until two successful comparable runs exist", () => {
    const request = validRequest();
    const oneSample = estimateRequest(request, [
      { status: "completed", mode: request.mode, runtimeMs: 120_000, request },
    ]);
    expect(oneSample).toMatchObject({ etaSeconds: null, etaSamples: 1 });

    const estimate = estimateRequest(request, [
      { status: "completed", mode: request.mode, runtimeMs: 120_000, request },
      { status: "completed", mode: request.mode, runtimeMs: 180_000, request },
      { status: "failed", mode: request.mode, runtimeMs: 1_000, request },
    ]);
    expect(estimate).toMatchObject({ etaSeconds: 150, etaSamples: 2 });
  });
});
