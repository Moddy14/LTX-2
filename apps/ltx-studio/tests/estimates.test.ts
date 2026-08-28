import { afterEach, describe, expect, it, vi } from "vitest";

import {
  estimateResources,
  requiredStartMemoryForRequests,
} from "../shared/estimates.js";
import { estimateRequest } from "../server/estimates.js";
import * as mediaProbe from "../server/mediaProbe.js";
import type { GenerationRequest } from "../shared/pipelines.js";
import { validLtx25SplitRequest, validRequest } from "./fixtures.js";

describe("resource and runtime estimates", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the standard two-stage memory contract conservative", () => {
    const request = validRequest();
    expect(estimateResources(request).memoryGiB).toBe(60);
  });

  it("keeps mandatory-detailing DFR v1.3 on an explicit unmeasured qualification HOLD", () => {
    const request = validRequest("dfr");
    const base = estimateResources(request);
    expect(base).toMatchObject({
      memoryGiB: 86,
      memoryBasis: "unmeasured-bootstrap:official-dfr-v1.3.0-single-call.v2",
      qualificationHold: true,
    });

    request.dfr!.temporalUpscalings = 1;
    expect(estimateResources(request).memoryGiB).toBeGreaterThanOrEqual(98);
    request.dfr!.temporalUpscalings = 2;
    expect(estimateResources(request).memoryGiB).toBeGreaterThanOrEqual(110);
    request.dfr!.spatialUpscalings = 2;
    expect(estimateResources(request).memoryGiB).toBeGreaterThanOrEqual(118);
  });

  it("estimates DFR output bytes from final temporal frames/FPS, not the basis canvas", () => {
    const request = validRequest("dfr");
    request.width = 3840;
    request.height = 2176;
    request.numFrames = 481;
    request.frameRate = 24;
    request.longClipAcknowledged = true;

    const base = estimateResources(request).outputGiB;
    request.dfr!.temporalUpscalings = 1;
    const x2 = estimateResources(request).outputGiB;
    request.dfr!.temporalUpscalings = 2;
    const x4 = estimateResources(request).outputGiB;
    expect(x2).toBeGreaterThan(base);
    expect(x4).toBeGreaterThan(x2);

    request.dfr!.spatialUpscalings = 2;
    expect(estimateResources(request).outputGiB).toBe(x4);
  });

  it("reserves 72 GiB so the DGX headroom gates split-BF16 T2A at 84 GiB", () => {
    const request = validLtx25SplitRequest("text-to-audio");
    request.numFrames = 481;
    request.longClipAcknowledged = true;
    const estimate = estimateResources(request);

    expect(estimate).toMatchObject({
      memoryGiB: 72,
      memoryBasis: "measured-cold-start:ltx-2.5-split-bf16-t2a.v1",
    });
    // The orchestrator owns this canonical 12-GiB non-Qwen headroom.
    expect(estimate.memoryGiB + 12).toBe(84);
    // Studio's visible planning warning intentionally keeps its stricter
    // non-blocking 24-GiB residual allowance.
    expect(requiredStartMemoryForRequests(
      [request],
      { minAvailableGiB: 48, minResidualMemoryGiB: 24 },
    )).toBe(96);
  });

  it("does not raise legacy T2A or another LTX-2.5 split mode", () => {
    const request = validRequest("text-to-audio");

    expect(estimateResources(request)).toMatchObject({ memoryGiB: 34 });
    expect(estimateResources(request).memoryBasis).toBeUndefined();
    expect(estimateResources(validLtx25SplitRequest("distilled")).memoryGiB).toBe(58);
  });

  it("uses a provisional 66-GiB proxy only for the audited full IA2V profile", () => {
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.width = 1024;
    request.height = 1536;
    request.numFrames = 289;
    request.audio.maxDuration = null;
    request.tiling = true;
    request.enhancePrompt = false;
    const estimate = estimateResources(request);

    expect(estimate).toMatchObject({
      memoryGiB: 66,
      memoryBasis:
        "provisional-proxy:ltx-2.5-split-bf16-ia2v-1024x1536-289f-24fps-tiled-explicit-1img-no-lora-no-refiner.v1",
    });
    // The orchestrator owns this canonical 12-GiB non-Qwen headroom.
    expect(estimate.memoryGiB + 12).toBe(78);
  });

  it.each([
    ["different geometry", (request: GenerationRequest) => { request.width = 960; }],
    ["different height", (request: GenerationRequest) => { request.height = 1504; }],
    ["different duration", (request: GenerationRequest) => { request.numFrames = 281; }],
    ["different frame rate", (request: GenerationRequest) => { request.frameRate = 25; }],
    ["an audio-derived cap", (request: GenerationRequest) => { request.audio.maxDuration = 12.05; }],
    ["a separate final audio mix", (request: GenerationRequest) => {
      request.audio.finalMix = { path: "/inputs/final.wav", name: "final.wav" };
    }],
    ["multiple image conditions", (request: GenerationRequest) => {
      request.images.push({ ...request.images[0], name: "second.png" });
    }],
    ["a nonzero image frame", (request: GenerationRequest) => { request.images[0].frameIndex = 8; }],
    ["a transformer LoRA", (request: GenerationRequest) => {
      request.models.loras.push({ path: "/models/extra.safetensors", strength: 1 });
    }],
    ["a Gemma LoRA", (request: GenerationRequest) => {
      request.models.gemmaLora.enabled = true;
    }],
    ["tiling disabled", (request: GenerationRequest) => { request.tiling = false; }],
    ["runtime quantization", (request: GenerationRequest) => { request.quantization.mode = "fp8-cast"; }],
    ["legacy model layout", (request: GenerationRequest) => { request.models.layout = "monolith"; }],
    ["legacy model generation", (request: GenerationRequest) => { request.models.generation = "2.3"; }],
    ["prompt enhancement", (request: GenerationRequest) => { request.enhancePrompt = true; }],
    ["a postprocessor", (request: GenerationRequest) => { request.postprocess.latentSync.enabled = true; }],
  ] as const)("falls back to the generic IA2V estimator for %s", (_label, mutate) => {
    const request = validLtx25SplitRequest("image-audio-to-video");
    request.width = 1024;
    request.height = 1536;
    request.numFrames = 289;
    request.audio.maxDuration = null;
    request.tiling = true;
    request.enhancePrompt = false;
    mutate(request);

    const estimate = estimateResources(request);
    expect(estimate.memoryBasis).toBeUndefined();
    expect(estimate.memoryGiB).toBeGreaterThanOrEqual(68);
  });

  it("does not apply the IA2V proxy to audio-only conditioning", () => {
    const request = validRequest("audio-to-video");
    request.models.layout = "split";
    request.models.generation = "2.5";
    request.quantization.mode = "none";
    request.width = 1024;
    request.height = 1536;
    request.numFrames = 289;
    request.audio.maxDuration = null;
    request.tiling = true;
    request.enhancePrompt = false;

    expect(estimateResources(request).memoryBasis).toBeUndefined();
    expect(estimateResources(request).memoryGiB).toBe(74);
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
    expect(estimateResources(request).memoryGiB).toBe(58);
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

  it("never understates the LipForcing 14B shared-memory floor", () => {
    const request = validRequest("one-stage");
    request.width = 320;
    request.height = 576;
    request.numFrames = 25;
    request.quantization.mode = "fp8-cast";
    request.models.checkpointPath = "/models/ltx-2.3-22b-dev-fp8.safetensors";
    request.postprocess.lipForcing.enabled = true;

    expect(estimateResources(request).memoryGiB).toBe(52);
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

  it("reports the exact A2V EOF timeline while keeping the cap-based RAM reservation", () => {
    const request = validRequest("image-audio-to-video");
    request.audio.startTime = 8.2;
    request.audio.maxDuration = 5;
    vi.spyOn(mediaProbe, "probeAudioDurationSeconds").mockReturnValue(10);

    const sharedEstimate = estimateResources(request);
    const serverEstimate = estimateRequest(request, []);

    expect(sharedEstimate.a2vTimeline).toMatchObject({
      frameCount: 113,
      exact: false,
      basis: "audio-cap-upper-bound",
    });
    expect(serverEstimate.a2vTimeline).toMatchObject({
      frameCount: 41,
      upperBoundFrameCount: 113,
      exact: true,
      basis: "audio-eof",
    });
    expect(serverEstimate.memoryGiB).toBe(sharedEstimate.memoryGiB);
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
