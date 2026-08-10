import { afterEach, describe, expect, it, vi } from "vitest";

import { pipelineModes } from "../shared/pipelines.js";
import {
  buildCommand,
  renderPrompt,
  suggestRequestPlan,
  validateOfficialSpeechInventory,
  validateRequestPlan,
  warnRequestPlan,
} from "../server/command.js";
import { recommendedModelAssets, type ModelInventory } from "../shared/models.js";
import * as mediaProbe from "../server/mediaProbe.js";
import { validRequest } from "./fixtures.js";

const expectedModules = {
  "two-stage": "ltx_pipelines.ti2vid_two_stages",
  "two-stage-hq": "ltx_pipelines.ti2vid_two_stages_hq",
  "one-stage": "ltx_pipelines.ti2vid_one_stage",
  distilled: "ltx_pipelines.distilled",
  "text-to-audio": "ltx_pipelines.t2a_one_stage",
  "ic-lora": "ltx_pipelines.ic_lora",
  "id-lora": "ltx_pipelines.id_lora",
  keyframes: "ltx_pipelines.flf2v",
  "image-audio-to-video": "ltx_pipelines.a2vid_two_stage",
  "audio-to-video": "ltx_pipelines.a2vid_two_stage",
  lipdub: "ltx_pipelines.lipdub",
  retake: "ltx_pipelines.retake",
} as const;

describe("buildCommand", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(pipelineModes)("maps %s to its typed Python module", (mode) => {
    const plan = buildCommand(validRequest(mode));
    expect(plan.args.slice(0, 2)).toEqual(["-m", expectedModules[mode]]);
    expect(plan.outputPath.endsWith(`ltx-${mode}.${mode === "text-to-audio" ? "wav" : "mp4"}`)).toBe(true);
    if (["lipdub", "id-lora", "keyframes", "ic-lora", "text-to-audio"].includes(mode)) expect(plan.args).not.toContain("--enhance-prompt");
    else expect(plan.args).toContain("--enhance-prompt");
  });

  it("builds official T2A as an audio-only WAV run with the exact Comfy sampling contract", () => {
    const request = validRequest("text-to-audio");
    request.promptParts.dialogue = "Bitte öffne die Tür.";
    const plan = buildCommand(request);

    expect(plan.outputPath.endsWith(".wav")).toBe(true);
    expect(plan.args).toContain("--official-comfy-workflow");
    expect(plan.args).toContain("--checkpoint-path");
    expect(plan.args).toContain("--negative-prompt");
    expect(plan.args).not.toContain("--distilled-lora");
    expect(plan.args).not.toContain("--height");
    expect(plan.args).not.toContain("--width");
    expect(plan.args).not.toContain("--spatial-upsampler-path");
    expect(plan.args.slice(plan.args.indexOf("--lora") + 1, plan.args.indexOf("--lora") + 3)).toEqual([
      request.models.distilledLora.path,
      "0.5",
    ]);
    expect(plan.args[plan.args.indexOf("--prompt") + 1]).toContain("Bitte öffne die Tür.");
  });

  it("builds FLF2V with only the official distilled checkpoint and two guide images", () => {
    const plan = buildCommand(validRequest("keyframes"));

    expect(plan.args).toContain("--distilled-checkpoint-path");
    expect(plan.args).not.toContain("--checkpoint-path");
    expect(plan.args).not.toContain("--distilled-lora");
    expect(plan.args).not.toContain("--spatial-upsampler-path");
    expect(plan.args).not.toContain("--negative-prompt");
    expect(plan.args).not.toContain("--num-inference-steps");
    expect(plan.args.filter((value) => value === "--image")).toHaveLength(2);
  });

  it("builds official T2V/I2V and IA2V with the fixed native Comfy workflow contract", () => {
    for (const mode of ["two-stage", "image-audio-to-video"] as const) {
      const request = validRequest(mode);
      const args = buildCommand(request).args;
      const loraIndex = args.indexOf("--distilled-lora");

      expect(args).toContain("--official-comfy-workflow");
      expect(args).not.toContain("--num-inference-steps");
      expect(args).not.toContain("--video-cfg-guidance-scale");
      if (mode === "two-stage") {
        expect(args).toEqual(expect.arrayContaining(["--negative-prompt", request.negativePrompt]));
      } else {
        expect(args).not.toContain("--negative-prompt");
      }
      expect(args.slice(loraIndex + 1, loraIndex + 3)).toEqual([
        request.models.distilledLora.path,
        "0.5",
      ]);
    }
  });

  it("passes the official Gemma LoRA separately from transformer LoRAs", () => {
    const request = validRequest("two-stage");
    request.quantization.amaxPath = "/models/ignored-amax.json";
    const args = buildCommand(request).args;
    const gemmaLoraIndex = args.indexOf("--gemma-lora");

    expect(gemmaLoraIndex).toBeGreaterThan(-1);
    expect(args.slice(gemmaLoraIndex + 1, gemmaLoraIndex + 3)).toEqual([
      request.models.gemmaLora.path,
      "1",
    ]);
    expect(args).not.toContain("/models/ignored-amax.json");
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

  it("binds the visible dialogue field to every native render prompt without requiring prompt composition", () => {
    const request = validRequest("two-stage");
    request.prompt = "A close portrait in a quiet room.";
    request.promptParts.dialogue = "Dieser Wortlaut erreicht den Render.";

    const prompt = renderPrompt(request);
    const plan = buildCommand(request);
    const promptIndex = plan.args.indexOf("--prompt");

    expect(prompt).toContain(request.prompt);
    expect(prompt).toContain(request.promptParts.dialogue);
    expect(plan.args[promptIndex + 1]).toBe(prompt);
  });

  it("does not duplicate dialogue that is already present in the positive prompt", () => {
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "Guten Morgen.";
    request.prompt = 'A woman says exactly: "Guten Morgen."';

    expect(renderPrompt(request)).toBe(request.prompt);
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

  it("blocks prompt enhancement for native exact dialogue at plan time without invalidating history", () => {
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "Dieser Wortlaut bleibt exakt.";
    request.enhancePrompt = true;

    expect(validateRequestPlan(request, buildCommand(request))).toContain(
      "Für wortgetreuen nativen Dialog muss die Gemma-Promptverbesserung ausgeschaltet bleiben; "
      + "sie kann den gesprochenen Wortlaut umformulieren.",
    );
  });

  it("requires every selected official speech asset to have verified content", () => {
    const request = validRequest("two-stage");
    request.promptParts.dialogue = "Guten Morgen.";
    const inventory: ModelInventory = {
      roots: [],
      scannedAt: new Date(0).toISOString(),
      truncated: false,
      errors: [],
      items: [],
      recommendations: recommendedModelAssets.map((asset) => ({
        ...asset,
        present: true,
        integrity: asset.id === "ltx23-gemma" ? "sha256-mismatch" as const : "verified" as const,
      })),
    };

    expect(validateOfficialSpeechInventory(request, inventory)).toEqual([
      "LTX-2.3 Gemma QAT Q4: offizielles Asset ist nicht vollständig SHA-256-verifiziert "
      + "(Status: sha256-mismatch).",
    ]);
    inventory.recommendations = inventory.recommendations.map((asset) => ({
      ...asset,
      integrity: "verified" as const,
    }));
    expect(validateOfficialSpeechInventory(request, inventory)).toEqual([]);
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

  it("validates an optional final mix without sending it to LTX", () => {
    const request = validRequest("audio-to-video");
    request.audio.finalMix = { path: "/inputs/final-mix.wav", name: "final-mix.wav" };
    const plan = buildCommand(request);

    expect(plan.args).not.toContain(request.audio.finalMix.path);
    expect(plan.requiredPaths).toContainEqual({
      path: request.audio.finalMix.path,
      label: "Finale Tonspur",
      kind: "file",
    });
  });

  it("binds IC-LoRA to the dedicated official Union-Control model exactly once", () => {
    const request = validRequest("ic-lora");
    request.models.loras = [
      { ...request.icLora.lora },
      { path: "/models/ltx/style-lora.safetensors", strength: 0.4 },
    ];
    const plan = buildCommand(request);
    const loraPaths = plan.args
      .flatMap((value, index) => value === "--lora" ? [plan.args[index + 1]] : []);

    expect(loraPaths.filter((path) => path === request.icLora.lora.path)).toHaveLength(1);
    expect(loraPaths).toContain("/models/ltx/style-lora.safetensors");
    expect(plan.requiredPaths).toContainEqual({
      path: request.icLora.lora.path,
      label: "LTX-2.3 Union-Control IC-LoRA",
      kind: "file",
    });
    expect(plan.args).toContain("--official-comfy-workflow");
    expect(plan.args).toEqual(expect.arrayContaining([
      "--distilled-checkpoint-path",
      request.models.distilledCheckpointPath,
      "--official-comfy-sampler",
      "euler-ancestral-rf",
      "--negative-prompt",
      request.negativePrompt,
      "--gemma-lora",
      request.models.gemmaLora.path,
      "1",
    ]));
    expect(loraPaths).not.toContain(request.models.distilledLora.path);
    expect(plan.requiredPaths).not.toContainEqual(expect.objectContaining({ label: "Distilled LoRA" }));
    expect(plan.args).not.toContain("--checkpoint-path");
    expect(plan.args).not.toContain("--spatial-upsampler-path");
  });

  it("does not preflight the obsolete distilled LoRA for official Union Control", () => {
    const request = validRequest("ic-lora");
    request.models.distilledLora.path = "";

    const errors = validateRequestPlan(request, buildCommand(request));

    expect(errors.some((message) => message.startsWith("Distilled LoRA:"))).toBe(false);
  });

  it("builds Ingredients with one image repeated as the full-sequence IC-LoRA guide", () => {
    const request = validRequest("ic-lora");
    request.icLora.profile = "ingredients";
    request.icLora.controlType = "prepared";
    request.icLora.lora.path = "/models/ltx/ltx-2.3-22b-ic-lora-ingredients-0.9.safetensors";
    request.icLora.videoConditioning = [];
    request.icLora.attentionMaskPath = "/inputs/ignored-mask.mp4";
    const plan = buildCommand(request);
    const args = plan.args;

    expect(args).toEqual(expect.arrayContaining([
      "--checkpoint-path",
      request.models.checkpointPath,
      "--lora",
      request.models.distilledLora.path,
      "0.5",
      "--lora",
      request.icLora.lora.path,
      "1",
      "--official-comfy-sampler",
      "euler-ancestral-cfg-pp",
      "--video-conditioning",
      request.images[0].path,
      "1",
      "--repeat-static-control",
      "--control-preprocessor",
      "prepared",
    ]));
    expect(args).not.toContain("--moge-model-path");
    expect(args).not.toContain("--conditioning-attention-mask");
    expect(args).not.toContain("--gemma-lora");
    expect(args).not.toContain("--image");
    expect(plan.requiredPaths).toContainEqual({
      path: request.icLora.lora.path,
      label: "LTX-2.3 Ingredients IC-LoRA",
      kind: "file",
    });
  });

  it.each([
    ["motion-track", "euler-ancestral-cfg-pp", false, false],
    ["pixel-upscaler", "euler-cfg-pp", true, false],
    ["v2v-instant-shave", "euler-ancestral-cfg-pp", true, true],
  ] as const)(
    "builds the official %s IC-LoRA contract",
    (profile, sampler, freezesAudio, prefixesPrompt) => {
      const request = validRequest("ic-lora");
      request.icLora.profile = profile;
      request.icLora.controlType = "prepared";
      request.images = profile === "motion-track" ? request.images : [];
      request.icLora.videoConditioning = [
        { path: "/inputs/source.mp4", name: "source.mp4", strength: 1 },
      ];
      request.icLora.lora.path = `/models/${profile}.safetensors`;
      request.prompt = "A precise transformation preserving motion.";
      const args = buildCommand(request).args;

      expect(args).toEqual(expect.arrayContaining([
        "--official-comfy-sampler",
        sampler,
        "--control-preprocessor",
        "prepared",
        "--video-conditioning",
        "/inputs/source.mp4",
        "1",
      ]));
      expect(args.includes("--freeze-control-audio")).toBe(freezesAudio);
      const rendered = args[args.indexOf("--prompt") + 1];
      expect(rendered.startsWith("REMOVEBEARD ")).toBe(prefixesPrompt);
    },
  );

  it.each([
    ["inpainting", "inpaint", true],
    ["outpainting", "outpaint", false],
  ] as const)("builds the official two-stage %s contract", (profile, editMode, needsMask) => {
    const request = validRequest("ic-lora");
    request.icLora.profile = profile;
    request.images = [];
    request.icLora.videoConditioning = [
      { path: "/inputs/source.mp4", name: "source.mp4", strength: 1 },
    ];
    request.icLora.attentionMaskPath = "/inputs/mask.mp4";
    request.icLora.lora = {
      path: "/models/ltx/inoutpaint-0.9.safetensors",
      strength: 1,
    };
    const plan = buildCommand(request);

    expect(plan.args).toEqual(expect.arrayContaining([
      "-m",
      "ltx_pipelines.inoutpaint",
      "--checkpoint-path",
      request.models.checkpointPath,
      "--source-video",
      "/inputs/source.mp4",
      "--edit-mode",
      editMode,
      "--stage-2-seed",
      "42",
      "--lora",
      request.models.distilledLora.path,
      "0.5",
      "--lora",
      request.icLora.lora.path,
      "1",
    ]));
    expect(plan.args.includes("--mask-video")).toBe(needsMask);
    expect(plan.args).not.toContain("--spatial-upsampler-path");
    expect(plan.requiredPaths).toContainEqual({
      path: request.icLora.lora.path,
      label: "In-/Outpainting IC-LoRA",
      kind: "file",
    });
  });

  it("builds HDR as the native linear-EXR pipeline with an exact MP4 preview path", () => {
    const request = validRequest("ic-lora");
    request.icLora.profile = "hdr";
    request.images = [];
    request.icLora.videoConditioning = [
      { path: "/inputs/hdr-source.mp4", name: "hdr-source.mp4", strength: 1 },
    ];
    request.icLora.lora = { path: "/models/ltx/hdr-lora.safetensors", strength: 1 };
    request.icLora.hdrTextEmbeddingsPath = "/models/ltx/hdr-scene-emb.safetensors";
    request.icLora.hdrHighQuality = true;
    const plan = buildCommand(request);

    expect(plan.args.slice(0, 2)).toEqual(["-m", "ltx_pipelines.hdr_ic_lora"]);
    expect(plan.args).toEqual(expect.arrayContaining([
      "--input",
      "/inputs/hdr-source.mp4",
      "--output-path",
      plan.outputPath,
      "--hdr-lora",
      request.icLora.lora.path,
      "--text-embeddings",
      request.icLora.hdrTextEmbeddingsPath,
      "--distilled-checkpoint-path",
      request.models.distilledCheckpointPath,
      "--spatial-upsampler-path",
      request.models.spatialUpscalerPath,
      "--num-frames",
      String(request.numFrames),
      "--high-quality",
    ]));
    expect(plan.args).not.toContain("--gemma-root");
    expect(plan.args).not.toContain("--prompt");
    expect(plan.args).not.toContain("--lora");
    expect(plan.requiredPaths).not.toContainEqual(expect.objectContaining({ label: "Gemma Root" }));
  });

  it("emits the official ID-LoRA prompt and identity-guidance contract", () => {
    const request = validRequest("id-lora");
    request.prompt = "A close portrait looks into the camera.";
    request.promptParts.ambience = "Quiet studio room tone.";
    const plan = buildCommand(request);
    const prompt = plan.args[plan.args.indexOf("--prompt") + 1];

    expect(prompt).toBe(
      "[VISUAL]: A close portrait looks into the camera.\n"
      + "[SPEECH]: Dieser Text wird mit der Referenzstimme neu erzeugt.\n"
      + "[SOUNDS]: Quiet studio room tone.",
    );
    expect(plan.args).toEqual(expect.arrayContaining([
      "--reference-audio-path",
      request.idLora.referenceAudio.path,
      "--id-lora",
      request.idLora.lora.path,
      "1",
      "--distilled-lora",
      request.models.distilledLora.path,
      "0.5",
      "--identity-guidance-scale",
      "3",
      "--identity-guidance-start",
      "0",
      "--identity-guidance-end",
      "1",
      "--stage-1-image-strength",
      "0.7",
    ]));
    expect(plan.requiredPaths).toEqual(expect.arrayContaining([
      { path: request.idLora.referenceAudio.path, label: "ID-LoRA-Referenzton", kind: "file" },
      { path: request.idLora.lora.path, label: "ID-LoRA TalkVid", kind: "file" },
    ]));
  });

  it("emits the official Comfy HQ LipDub CLI contract", () => {
    const request = validRequest("lipdub");
    request.models.loras = [{ path: "/models/ignored-style.safetensors", strength: 0.4 }];
    request.images = [{ path: "/inputs/ignored.png", name: "ignored.png", frameIndex: 0, strength: 1, crf: 33 }];
    const plan = buildCommand(request);
    const args = plan.args;

    expect(args.slice(0, 2)).toEqual(["-m", "ltx_pipelines.lipdub"]);
    expect(args).toEqual(expect.arrayContaining([
      "--pipeline-profile",
      "official-comfy-hq",
      "--checkpoint-path",
      request.models.checkpointPath,
      "--distilled-lora",
      request.models.distilledLora.path,
      "0.5",
      "--stage-2-seed",
      "9",
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
    const promptIndex = args.indexOf("--prompt");
    expect(args[promptIndex + 1]).toContain("Target language: Deutsch.");
    expect(args[promptIndex + 1]).toContain("Exactly one visible person speaks.");
    expect(args[promptIndex + 1]).toContain(
      'Target dialogue (verbatim): "Das ist ein nativer LTX LipDub Test".',
    );
  });

  it("preserves the legacy native Distilled LipDub CLI contract when explicitly selected", () => {
    const request = validRequest("lipdub");
    request.lipDub.pipelineProfile = "native-distilled";
    const args = buildCommand(request).args;

    expect(args).toEqual(expect.arrayContaining([
      "--pipeline-profile",
      "native-distilled",
      "--distilled-checkpoint-path",
      request.models.distilledCheckpointPath,
    ]));
    expect(args).not.toContain("--checkpoint-path");
    expect(args).not.toContain("--distilled-lora");
    expect(args).not.toContain("--stage-2-seed");
  });

  it("blocks a native LipDub rerun until its explicit language and speaker contract is confirmed", () => {
    const request = validRequest("lipdub");
    request.lipDub.targetLanguage = "";
    request.lipDub.singleSpeakerAcknowledged = false;
    const plan = buildCommand(request);
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 576,
      height: 1024,
      frames: 121,
      fps: 24,
      durationSeconds: 5.04,
      hasAudio: true,
    });

    expect(validateRequestPlan(request, plan)).toEqual(expect.arrayContaining([
      "LipDub-Zielsprache fehlt.",
      "LipDub erfordert die Bestätigung, dass im Referenzclip genau eine Person spricht.",
    ]));
  });

  it("preserves a legacy LipDub target dialogue that exists only in the free prompt", () => {
    const request = validRequest("lipdub");
    request.promptParts.dialogue = "";
    request.prompt = 'A single speaker says exactly: "Dieser Altbestand bleibt erhalten."';

    const args = buildCommand(request).args;
    const promptIndex = args.indexOf("--prompt");
    const effectivePrompt = args[promptIndex + 1];

    expect(effectivePrompt).toContain(request.prompt);
    expect(effectivePrompt).toContain("Target language: Deutsch.");
    expect(effectivePrompt).not.toContain("Target dialogue (verbatim):");
  });

  it("rejects a native LipDub reference video without audio before queue start", () => {
    const request = validRequest("lipdub");
    const plan = buildCommand(request);
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 576,
      height: 1024,
      frames: 121,
      fps: 24,
      durationSeconds: 5.04,
      hasAudio: false,
    });

    expect(validateRequestPlan(request, plan)).toContain(
      `LipDub-Referenzvideo enthält keine Audiospur (${request.lipDub.referenceVideo.path})`,
    );
  });

  it("rejects native LipDub planning when reference video metadata is not readable", () => {
    const request = validRequest("lipdub");
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue(null);

    expect(validateRequestPlan(request, buildCommand(request))).toContain(
      `LipDub-Referenzvideo konnte nicht dekodiert werden oder enthält keine lesbare Videospur (${request.lipDub.referenceVideo.path})`,
    );
  });

  it("rejects LipDub references that are too short, too slow, or collapse under frame snapping", () => {
    const request = validRequest("lipdub");
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 576,
      height: 1024,
      frames: 8,
      fps: 6,
      durationSeconds: 0.5,
      hasAudio: true,
    });

    const errors = validateRequestPlan(request, buildCommand(request));

    expect(errors).toContain("LipDub-Referenzvideo ist zu kurz (0.50 s); mindestens 1 s verwenden.");
    expect(errors).toContain("LipDub-Referenzvideo hat ungeeignete FPS (6.00); empfohlen sind 12-60 FPS.");
    expect(errors).toContain("LipDub-Referenzvideo liefert nach 8k+1-Snapping weniger als 9 Frames.");
  });

  it("rejects LipDub dialogue lengths that do not fit the reference duration", () => {
    const request = validRequest("lipdub");
    request.promptParts.dialogue = "Hallo";
    request.prompt = "";
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 576,
      height: 1024,
      frames: 721,
      fps: 24,
      durationSeconds: 30,
      hasAudio: true,
    });

    expect(validateRequestPlan(request, buildCommand(request))).toEqual(expect.arrayContaining([
      "LipDub-Referenzvideo ist zu lang (30.00 s); für reproduzierbare Tests maximal 20 s verwenden.",
      "LipDub-Dialog ist für die Referenzdauer zu kurz (1 Wörter in 30.00 s, ca. 2 WPM).",
    ]));

    request.promptParts.dialogue = "";
    request.prompt = 'A speaker saying exactly: "Eins zwei drei vier fünf sechs sieben acht neun zehn elf zwölf dreizehn vierzehn fünfzehn sechzehn siebzehn achtzehn neunzehn zwanzig".';
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 576,
      height: 1024,
      frames: 25,
      fps: 24,
      durationSeconds: 1,
      hasAudio: true,
    });

    expect(validateRequestPlan(request, buildCommand(request))).toContain(
      "LipDub-Dialog ist für die Referenzdauer zu lang (20 Wörter in 1.00 s, ca. 1200 WPM).",
    );
  });

  it("rejects LipDub references that are too small or do not match the output aspect ratio", () => {
    const request = validRequest("lipdub");
    request.width = 1024;
    request.height = 576;
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 90,
      height: 160,
      frames: 121,
      fps: 24,
      durationSeconds: 5.04,
      hasAudio: true,
    });

    expect(validateRequestPlan(request, buildCommand(request))).toEqual(expect.arrayContaining([
      "LipDub-Referenzvideo ist zu klein (90 x 160); mindestens 256 px pro Kante verwenden.",
      "LipDub-Ausgabeformat passt nicht zum Referenzvideo (1024 x 576 vs. 90 x 160); Seitenverhältnis angleichen oder Referenz passend zuschneiden.",
    ]));
  });

  it("warns about LipDub reference choices that can reduce quality without blocking a run", () => {
    const request = validRequest("lipdub");
    request.models.distilledCheckpointPath = "/models/ltx/ltx-2.3-22b-distilled-1.1.safetensors";
    request.models.spatialUpscalerPath = "/models/ltx/ltx-2.3-spatial-upscaler-x2-1.1.safetensors";
    request.width = 576;
    request.height = 1024;
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 576,
      height: 1024,
      frames: 122,
      fps: 23.976,
      durationSeconds: 5.09,
      hasAudio: true,
    });

    expect(warnRequestPlan(request)).toEqual(expect.arrayContaining([
      "Die native LipDub-Pipeline snappt 122 Referenzframes auf 121 Frames nach 8k+1; das Clipende kann dadurch wegfallen.",
      "Referenz-FPS ist 23.976. Die native Ausgabe kodiert derzeit mit ganzzahliger FPS; für präzisen LipSync vorher auf konstante 24, 25 oder 30 FPS transkodieren.",
      "Referenzdauer ist 5.1 s. Für die Kalibrierung zuerst einen 2-5-s-Ausschnitt prüfen, danach dieselben Einstellungen auf längere Clips übertragen.",
    ]));
  });

  it("suggests the closest high-quality 64-multiple LipDub output format", () => {
    const request = validRequest("lipdub");
    request.width = 576;
    request.height = 1024;
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 720,
      height: 1280,
      frames: 121,
      fps: 24,
      durationSeconds: 5.04,
      hasAudio: true,
    });

    expect(suggestRequestPlan(request)).toEqual([{
      id: "lipdub-reference-format",
      level: "info",
      label: "Format 1088 x 1920 übernehmen",
      message: "Referenzvideo 720 x 1280; empfohlenes 64er-LipDub-Format 1088 x 1920 mit möglichst geringer Seitenverhältnisdrift.",
      patch: { width: 1088, height: 1920 },
    }]);

    request.width = 1088;
    request.height = 1920;
    expect(suggestRequestPlan(request)).toEqual([]);
    expect(warnRequestPlan(request)).not.toContain(
      "LipDub-Referenz ist 720 x 1280, Ausgabe ist 1088 x 1920. Der offizielle Comfy-HQ-Pfad sollte die Referenz proportional auf etwa 1920 x 1088 Pixel Gesamtfläche skalieren.",
    );
  });

  it("does not suggest LipDub output formats outside the request schema limits", () => {
    const request = validRequest("lipdub");
    request.lipDub.pipelineProfile = "native-distilled";
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 7680,
      height: 4320,
      frames: 121,
      fps: 24,
      durationSeconds: 5.04,
      hasAudio: true,
    });

    expect(suggestRequestPlan(request)).toEqual([]);
  });

  it("blocks official Comfy HQ LipDub when it is configured with non-reference model assets", () => {
    const request = validRequest("lipdub");
    vi.spyOn(mediaProbe, "probeVideoMetadata").mockReturnValue({
      width: 576,
      height: 1024,
      frames: 121,
      fps: 24,
      durationSeconds: 5.04,
      hasAudio: true,
    });

    const errors = validateRequestPlan(request, buildCommand(request));
    expect(errors.some((message) => message.startsWith(
      "Dev Checkpoint: die offizielle LTX-2.3-Pipeline verlangt ",
    ))).toBe(true);
    expect(errors.some((message) => message.startsWith(
      "Distilled LoRA: die offizielle LTX-2.3-Pipeline verlangt ",
    ))).toBe(true);
    expect(errors.some((message) => message.startsWith(
      "Spatial Upscaler: die offizielle LTX-2.3-Pipeline verlangt ",
    ))).toBe(true);
    expect(errors.some((message) => message.startsWith(
      "LipDub IC-LoRA: die offizielle LTX-2.3-Pipeline verlangt ",
    ))).toBe(true);
  });
});
