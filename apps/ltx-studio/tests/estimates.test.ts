import { afterEach, describe, expect, it, vi } from "vitest";

import {
  estimateResources,
  requiredStartMemoryForRequests,
} from "../shared/estimates.js";
import { estimateRequest } from "../server/estimates.js";
import * as mediaProbe from "../server/mediaProbe.js";
import { validRequest } from "./fixtures.js";

describe("resource and runtime estimates", () => {
  afterEach(() => vi.restoreAllMocks());

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

  it("plans LipDub as a conservative distilled two-stage run", () => {
    const request = validRequest("lipdub");
    const estimate = estimateResources(request);
    expect(estimate.memoryGiB).toBeGreaterThanOrEqual(64);
  });

  it("uses the most demanding experiment arm for the visible RAM gate", () => {
    const baseline = validRequest("audio-to-video");
    baseline.width = 512;
    baseline.height = 512;
    const higherResolutionCandidate = structuredClone(baseline);
    higherResolutionCandidate.width = 1920;
    higherResolutionCandidate.height = 1088;
    const candidateEstimate = estimateResources(higherResolutionCandidate).memoryGiB;

    expect(candidateEstimate).toBeGreaterThan(estimateResources(baseline).memoryGiB);
    expect(requiredStartMemoryForRequests(
      [baseline, higherResolutionCandidate],
      { minAvailableGiB: 48, minResidualMemoryGiB: 24 },
    )).toBe(candidateEstimate + 24);
  });

  it("does not claim a local RAM gate for LipDub before the server probes the reference", () => {
    expect(requiredStartMemoryForRequests(
      [validRequest("lipdub")],
      { minAvailableGiB: 48, minResidualMemoryGiB: 24 },
    )).toBeNull();
  });

  it("sizes native LipDub server estimates from the reference video instead of the UI frame proxy", () => {
    const request = validRequest("lipdub");
    request.numFrames = 25;
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 576,
      height: 1024,
      frames: 2401,
      fps: 24,
      durationSeconds: 100.04,
      hasAudio: true,
    });

    const sharedEstimate = estimateResources(request);
    const serverEstimate = estimateRequest(request, []);

    expect(serverEstimate.memoryGiB).toBeGreaterThan(sharedEstimate.memoryGiB);
    expect(serverEstimate.outputGiB).toBeGreaterThan(sharedEstimate.outputGiB);
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
