import { afterEach, describe, expect, it, vi } from "vitest";

import { pipelineModes } from "../shared/pipelines.js";
import {
  buildCommand,
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
    const promptIndex = args.indexOf("--prompt");
    expect(args[promptIndex + 1]).toContain("Target language: Deutsch.");
    expect(args[promptIndex + 1]).toContain("Exactly one visible person speaks.");
    expect(args[promptIndex + 1]).toContain(
      'Target dialogue (verbatim): "Das ist ein nativer LTX LipDub Test".',
    );
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
      label: "Format 768 x 1344 übernehmen",
      message: "Referenzvideo 720 x 1280; empfohlenes 64er-LipDub-Format 768 x 1344 mit möglichst geringer Seitenverhältnisdrift.",
      patch: { width: 768, height: 1344 },
    }]);

    request.width = 768;
    request.height = 1344;
    expect(suggestRequestPlan(request)).toEqual([]);
    expect(warnRequestPlan(request)).not.toContain(
      "LipDub-Referenz ist 720 x 1280, Ausgabe ist 768 x 1344. Für höchste Qualität sollte die Ausgabe der Referenzauflösung oder dem nächstliegenden durch 64 teilbaren Format entsprechen.",
    );
  });

  it("does not suggest LipDub output formats outside the request schema limits", () => {
    const request = validRequest("lipdub");
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

  it("blocks native LipDub when it is configured with non-reference model assets", () => {
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
      "Distilled Checkpoint: der offizielle Sprachpfad verlangt ",
    ))).toBe(true);
    expect(errors.some((message) => message.startsWith(
      "Spatial Upscaler: der offizielle Sprachpfad verlangt ",
    ))).toBe(true);
    expect(errors.some((message) => message.startsWith(
      "LipDub IC-LoRA: der offizielle Sprachpfad verlangt ",
    ))).toBe(true);
  });
});
