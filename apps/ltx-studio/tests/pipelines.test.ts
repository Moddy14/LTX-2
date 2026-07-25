import { describe, expect, it } from "vitest";

import {
  generationRequestSchema,
  mergeGenerationRequest,
  pipelineModes,
  withLongCatLipsyncDisabled,
  type GenerationRequest,
} from "../shared/pipelines.js";
import { validRequest } from "./fixtures.js";

describe("generationRequestSchema", () => {
  it.each(pipelineModes)("accepts a complete %s request", (mode) => {
    expect(generationRequestSchema.safeParse(validRequest(mode)).success).toBe(true);
  });

  it("rejects unsafe output names", () => {
    const request = validRequest();
    request.outputName = "../outside.mp4";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("migrates legacy negative random seeds to a concrete default", () => {
    const legacy = validRequest();
    legacy.seed = -1;
    const migrated = mergeGenerationRequest(legacy);
    expect(migrated.seed).toBe(10);
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("migrates audio jobs created before separate final mixes existed", () => {
    const legacy = structuredClone(validRequest("audio-to-video")) as unknown as {
      audio: {
        path: string;
        name: string;
        startTime: number;
        maxDuration: number | null;
        finalMix?: GenerationRequest["audio"]["finalMix"];
      };
    };
    delete legacy.audio.finalMix;

    const migrated = mergeGenerationRequest(legacy);

    expect(migrated.audio.finalMix).toEqual({ path: "", name: "" });
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("keeps legacy LipDub jobs readable while requiring the new contract only at plan time", () => {
    const legacy = structuredClone(validRequest("lipdub")) as unknown as {
      lipDub: {
        referenceVideo: GenerationRequest["lipDub"]["referenceVideo"];
        lora: GenerationRequest["lipDub"]["lora"];
        targetLanguage?: string;
        singleSpeakerAcknowledged?: boolean;
      };
    };
    delete legacy.lipDub.targetLanguage;
    delete legacy.lipDub.singleSpeakerAcknowledged;

    const migrated = mergeGenerationRequest(legacy);

    expect(migrated.lipDub.targetLanguage).toBe("");
    expect(migrated.lipDub.singleSpeakerAcknowledged).toBe(false);
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("strips removed top-level fields while preserving valid legacy values", () => {
    const legacy = {
      ...validRequest(),
      prompt: "A preserved legacy prompt.",
      removedLegacyFlag: true,
    };
    const migrated = mergeGenerationRequest(legacy);
    expect(migrated.prompt).toBe("A preserved legacy prompt.");
    expect("removedLegacyFlag" in migrated).toBe(false);
    expect(generationRequestSchema.safeParse(migrated).success).toBe(true);
  });

  it("rejects NUL bytes before values reach process spawning", () => {
    const promptRequest = validRequest();
    promptRequest.prompt = "valid prefix\0hidden suffix";
    expect(generationRequestSchema.safeParse(promptRequest).success).toBe(false);

    const pathRequest = validRequest();
    pathRequest.models.checkpointPath = "/models/checkpoint\0.safetensors";
    expect(generationRequestSchema.safeParse(pathRequest).success).toBe(false);
  });

  it("requires 8k+1 frames and mode-specific resolution divisors", () => {
    const request = validRequest("two-stage");
    request.numFrames = 120;
    request.width = 1500;
    const result = generationRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(expect.arrayContaining([
        "Frames müssen dem Muster 8k+1 folgen.",
        "Breite und Höhe müssen durch 64 teilbar sein.",
      ]));
    }
  });

  it("requires paths for every configured media and LoRA row", () => {
    const request = validRequest("ic-lora");
    request.images = [{ path: "", name: "empty", frameIndex: 0, strength: 1, crf: 33 }];
    request.models.loras[0].path = "";
    request.icLora.videoConditioning[0].path = "";
    const result = generationRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(expect.arrayContaining([
        "images.0.path",
        "models.loras.0.path",
        "icLora.videoConditioning.0.path",
      ]));
    }
  });

  it("requires one reference image only in explicit image-to-video mode", () => {
    const request = validRequest("two-stage");
    request.sourceMode = "image";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);

    request.images = [{ path: "/inputs/reference.png", name: "reference.png", frameIndex: 0, strength: 1, crf: 33 }];
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.sourceMode = "text";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("requires an explicit acknowledgement for clips longer than ten seconds", () => {
    const request = validRequest();
    request.numFrames = 481;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.longClipAcknowledged = true;
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("requires in-range, strictly increasing keyframe indices", () => {
    const request = validRequest("keyframes");
    request.images[1].frameIndex = request.numFrames;
    let result = generationRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("images.1.frameIndex");
    }

    request.images[1].frameIndex = request.images[0].frameIndex;
    result = generationRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "Keyframe-Indizes müssen in der eingegebenen Reihenfolge strikt ansteigen.",
      );
    }
  });

  it("requires an AMAX file only for scaled matrix multiplication", () => {
    const request = validRequest();
    request.quantization = { mode: "fp8-scaled-mm", amaxPath: "" };
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
    request.quantization.amaxPath = "/models/ltx/amax.json";
    expect(generationRequestSchema.safeParse(request).success).toBe(true);
  });

  it("requires at least one regenerated Retake modality", () => {
    const request = validRequest("retake");
    request.retake.regenerateVideo = false;
    request.retake.regenerateAudio = false;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("keeps the LongCat lip pass optional and requires audio-to-video inputs when enabled", () => {
    const disabled = validRequest("audio-to-video");
    expect(generationRequestSchema.safeParse(disabled).success).toBe(true);

    const enabled = validRequest("audio-to-video");
    enabled.postprocess.longcatLipsync.enabled = true;
    expect(generationRequestSchema.safeParse(enabled).success).toBe(false);

    enabled.images = [{
      path: "/inputs/face.png",
      name: "face.png",
      frameIndex: 0,
      strength: 1,
      crf: 33,
    }];
    expect(generationRequestSchema.safeParse(enabled).success).toBe(true);

    enabled.mode = "two-stage";
    expect(generationRequestSchema.safeParse(enabled).success).toBe(false);
  });

  it("requires the native LipDub reference contract", () => {
    const request = validRequest("lipdub");
    expect(generationRequestSchema.safeParse(request).success).toBe(true);

    request.lipDub.referenceVideo.path = "";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);

    request.lipDub.referenceVideo.path = "/inputs/speaker-reference.mp4";
    request.lipDub.lora.path = "";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);

    request.lipDub.lora.path = "/models/ltx/ltx-lipdub-lora.safetensors";
    request.prompt = "A portrait with no exact speech.";
    request.promptParts.dialogue = "";
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });

  it("rejects LipDub inputs that are not sent to the native CLI", () => {
    const request = validRequest("lipdub");
    request.images = [{ path: "/inputs/reference.png", name: "reference.png", frameIndex: 0, strength: 1, crf: 33 }];
    request.models.loras = [{ path: "/models/extra.safetensors", strength: 1 }];
    const result = generationRequestSchema.safeParse(request);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual(expect.arrayContaining([
        "images",
        "models.loras",
      ]));
    }
  });

  it("turns off LongCat without dropping its stored tuning values", () => {
    const request = validRequest("audio-to-video");
    request.postprocess.longcatLipsync = { enabled: true, resolution: "720p", blend: 0.65 };

    const disabled = withLongCatLipsyncDisabled(request);

    expect(disabled.postprocess.longcatLipsync).toEqual({ enabled: false, resolution: "720p", blend: 0.65 });
  });

  it("rejects unknown top-level fields", () => {
    const request = { ...validRequest(), shellCommand: "rm -rf /" } as GenerationRequest;
    expect(generationRequestSchema.safeParse(request).success).toBe(false);
  });
});
