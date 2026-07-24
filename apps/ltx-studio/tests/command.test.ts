import { afterEach, describe, expect, it, vi } from "vitest";

import { pipelineModes } from "../shared/pipelines.js";
import { buildCommand, validateRequestPlan } from "../server/command.js";
import * as mediaProbe from "../server/mediaProbe.js";
import { validRequest } from "./fixtures.js";

const expectedModules = {
  "two-stage": "ltx_pipelines.ti2vid_two_stages",
  "two-stage-hq": "ltx_pipelines.ti2vid_two_stages_hq",
  "one-stage": "ltx_pipelines.ti2vid_one_stage",
  distilled: "ltx_pipelines.distilled",
  "ic-lora": "ltx_pipelines.ic_lora",
  keyframes: "ltx_pipelines.keyframe_interpolation",
  "audio-to-video": "ltx_pipelines.a2vid_two_stage",
  lipdub: "ltx_pipelines.lipdub",
  retake: "ltx_pipelines.retake",
} as const;

describe("buildCommand", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(pipelineModes)("maps %s to its typed Python module", (mode) => {
    const plan = buildCommand(validRequest(mode));
    expect(plan.args.slice(0, 2)).toEqual(["-m", expectedModules[mode]]);
    expect(plan.outputPath.endsWith(`ltx-${mode}.mp4`)).toBe(true);
    if (mode === "lipdub") expect(plan.args).not.toContain("--enhance-prompt");
    else expect(plan.args).toContain("--enhance-prompt");
  });

  it("keeps prompt metacharacters in one argv element", () => {
    const request = validRequest();
    request.prompt = "camera's move; $(touch /tmp/not-run)";
    const plan = buildCommand(request);
    const promptIndex = plan.args.indexOf("--prompt");
    expect(plan.args[promptIndex + 1]).toBe(request.prompt);
    expect(plan.executable).not.toMatch(/(?:^|\/)sh$/);
    expect(plan.displayCommand).toContain("'camera'\"'\"'s move; $(touch /tmp/not-run)'");
  });

  it("requires Gemma processor metadata only for prompt enhancement", () => {
    const enhanced = validRequest();
    const enhancedPaths = buildCommand(enhanced).requiredPaths;
    expect(enhancedPaths).toContainEqual({
      path: "/models/gemma/preprocessor_config.json",
      label: "Gemma Prozessorkonfiguration für Promptverbesserung",
      kind: "file",
    });

    enhanced.enhancePrompt = false;
    expect(buildCommand(enhanced).requiredPaths.map((entry) => entry.path))
      .not.toContain("/models/gemma/preprocessor_config.json");
  });

  it("emits the full non-distilled retake contract", () => {
    const request = validRequest("retake");
    request.retake.regenerateAudio = false;
    request.retake.regenerateVideo = false;
    request.tiling = false;
    request.models.loras = [{ path: "/models/retake.safetensors", strength: 0.7 }];
    const args = buildCommand(request).args;
    expect(args).toEqual(expect.arrayContaining([
      "--negative-prompt",
      "--num-inference-steps",
      "--video-cfg-guidance-scale",
      "--audio-cfg-guidance-scale",
      "--no-regenerate-video",
      "--no-regenerate-audio",
      "--disable-tiling",
      "--lora",
    ]));
  });

  it("omits ignored guidance and steps in distilled retake mode", () => {
    const request = validRequest("retake");
    request.retake.distilled = true;
    const args = buildCommand(request).args;
    expect(args).toContain("--distilled");
    expect(args).toContain(request.models.distilledCheckpointPath);
    expect(args).not.toContain(request.models.checkpointPath);
    expect(args).not.toContain("--negative-prompt");
    expect(args).not.toContain("--num-inference-steps");
    expect(args).not.toContain("--video-cfg-guidance-scale");
  });

  it("does not expose tiling or unused audio guidance to incompatible modes", () => {
    const oneStage = validRequest("one-stage");
    oneStage.tiling = false;
    expect(buildCommand(oneStage).args).not.toContain("--disable-tiling");

    const audioToVideo = buildCommand(validRequest("audio-to-video")).args;
    expect(audioToVideo).toContain("--video-cfg-guidance-scale");
    expect(audioToVideo).not.toContain("--audio-cfg-guidance-scale");
  });

  it("emits only the native LipDub CLI contract", () => {
    const request = validRequest("lipdub");
    request.models.loras = [{ path: "/models/ignored-style.safetensors", strength: 0.4 }];
    request.images = [{ path: "/inputs/ignored.png", name: "ignored.png", frameIndex: 0, strength: 1, crf: 33 }];
    const plan = buildCommand(request);
    const args = plan.args;

    expect(args.slice(0, 2)).toEqual(["-m", "ltx_pipelines.lipdub"]);
    expect(args).toEqual(expect.arrayContaining([
      "--distilled-checkpoint-path",
      request.models.distilledCheckpointPath,
      "--reference-video",
      request.lipDub.referenceVideo.path,
      "--reference-strength",
      String(request.lipDub.referenceVideo.strength),
      "--lora",
      request.lipDub.lora.path,
      String(request.lipDub.lora.strength),
      "--spatial-upsampler-path",
    ]));
    expect(args).not.toContain("--num-frames");
    expect(args).not.toContain("--frame-rate");
    expect(args).not.toContain("--num-inference-steps");
    expect(args).not.toContain("--negative-prompt");
    expect(args).not.toContain("--image");
    expect(args).not.toContain("--disable-tiling");
    expect(args).not.toContain("--video-cfg-guidance-scale");
    expect(args).not.toContain("/models/ignored-style.safetensors");
    expect(args).not.toContain("/inputs/ignored.png");
  });

  it("rejects a native LipDub reference video without audio before queue start", () => {
    const request = validRequest("lipdub");
    const plan = buildCommand(request);
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      frames: 121,
      fps: 24,
      durationSeconds: 5.04,
      hasAudio: false,
    });

    expect(validateRequestPlan(request, plan)).toContain(
      `LipDub-Referenzvideo enthält keine Audiospur (${request.lipDub.referenceVideo.path})`,
    );
  });
});
