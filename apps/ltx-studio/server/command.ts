import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  documentedLtx23CheckpointAssetId,
  documentedLtx23DistilledLoraAssetId,
  icLoraModelAssetId,
  recommendedModelAsset,
  requiredOfficialSpeechAssetIds,
  usesOfficialSpeechStack,
  type ModelInventory,
  type RecommendedModelAsset,
} from "../shared/models.js";
import {
  isAudioConditionedMode,
  isNativeDialogueRequest,
  needsGemmaAbliteratedLoraForRequest,
  usesOfficialComfyLipDub,
  type GenerationRequest,
  type PipelineMode,
} from "../shared/pipelines.js";
import type { PlanSuggestion } from "../shared/plan.js";
import { outputRoot, rendererPythonExecutable } from "./config.js";
import {
  inspectLipDubReference,
  OFFICIAL_COMFY_LIPDUB_OUTPUT_AREA,
  recommendedLipDubOutputSize,
  type LipDubReferenceInspectionInput,
} from "./lipdubDiagnostics.js";
import { probeVideoMetadata } from "./mediaProbe.js";

export { recommendedLipDubOutputSize };

const MODULES: Record<PipelineMode, string> = {
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
  lipdub: "ltx_pipelines.dubit",
  retake: "ltx_pipelines.retake",
};

export type PathRequirement = {
  path: string;
  label: string;
  kind: "file" | "directory";
};

export type CommandPlan = {
  executable: string;
  args: string[];
  displayCommand: string;
  outputPath: string;
  requiredPaths: PathRequirement[];
};

function appendFlag(args: string[], flag: string, value: string | number): void {
  args.push(flag, String(value));
}

function appendBoolean(args: string[], enabled: boolean, flag: string): void {
  if (enabled) args.push(flag);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderPrompt(request: GenerationRequest): string {
  let prompt = request.prompt.trim();
  if (
    request.mode === "ic-lora"
    && request.icLora.profile === "v2v-instant-shave"
    && !/^REMOVEBEARD\b/i.test(prompt)
  ) {
    prompt = `REMOVEBEARD ${prompt}`;
  }
  const dialogue = request.promptParts.dialogue.trim();
  if (request.mode === "text-to-audio") {
    if (!dialogue || prompt.includes(dialogue)) return prompt;
    return [
      prompt,
      `The speaker says exactly: ${JSON.stringify(dialogue)}.`,
    ].filter(Boolean).join("\n\n");
  }
  if (request.mode === "id-lora") {
    const sounds = [
      request.promptParts.ambience.trim(),
      request.promptParts.music.trim(),
    ].filter(Boolean).join(" ");
    return [
      `[VISUAL]: ${prompt}`,
      `[SPEECH]: ${dialogue}`,
      `[SOUNDS]: ${sounds || "Natural clean voice with quiet room ambience."}`,
    ].join("\n");
  }
  if (!dialogue || prompt.includes(dialogue)) return prompt;

  return [
    prompt,
    `The visible speaking subject says exactly: ${JSON.stringify(dialogue)}.`,
  ].filter(Boolean).join("\n\n");
}

function appendCommonGenerationArgs(request: GenerationRequest, args: string[]): void {
  appendFlag(args, "--gemma-root", request.models.gemmaRoot);
  appendFlag(args, "--prompt", renderPrompt(request));
  appendFlag(args, "--output-path", join(outputRoot, request.outputName));
  appendFlag(args, "--seed", request.seed);
  appendFlag(args, "--height", request.height);
  appendFlag(args, "--width", request.width);
  appendFlag(args, "--num-frames", request.numFrames);
  appendFlag(args, "--frame-rate", request.frameRate);
  if (!["two-stage", "distilled", "ic-lora", "keyframes", "image-audio-to-video"].includes(request.mode)) {
    appendFlag(args, "--num-inference-steps", request.numInferenceSteps);
  }
  appendBoolean(args, request.enhancePrompt, "--enhance-prompt");
  appendBoolean(args, request.mode !== "one-stage" && !request.tiling, "--disable-tiling");

  // The official Ingredients graph bypasses the I2V branch: its image enters
  // only as the repeated IC reference, never as a frame-0 latent replacement.
  const ingredientsICLora = request.mode === "ic-lora" && request.icLora.profile === "ingredients";
  if (!ingredientsICLora) {
    for (const image of request.images) {
      args.push("--image", image.path, String(image.frameIndex), String(image.strength), String(image.crf));
    }
  }
  const loras = request.mode === "ic-lora"
    ? [
        ...(request.icLora.profile === "union-control" ? [] : [request.models.distilledLora]),
        request.icLora.lora,
        ...request.models.loras,
      ]
    : request.models.loras;
  const seenLoras = new Set<string>();
  for (const lora of loras) {
    const path = resolve(lora.path);
    if (seenLoras.has(path)) continue;
    seenLoras.add(path);
    args.push("--lora", lora.path, String(lora.strength));
  }
  if (needsGemmaAbliteratedLoraForRequest(request)) {
    args.push("--gemma-lora", request.models.gemmaLora.path, String(request.models.gemmaLora.strength));
  }
  if (request.quantization.mode !== "none") {
    args.push("--quantization", request.quantization.mode);
  }
}

function appendGuidanceArgs(request: GenerationRequest, args: string[], includeAudio = true): void {
  const pairs = [
    ["video", request.videoGuidance],
    ...(includeAudio ? [["audio", request.audioGuidance] as const] : []),
  ] as const;
  for (const [prefix, guidance] of pairs) {
    appendFlag(args, `--${prefix}-cfg-guidance-scale`, guidance.cfgScale);
    appendFlag(args, `--${prefix}-stg-guidance-scale`, guidance.stgScale);
    appendFlag(args, `--${prefix}-rescale-scale`, guidance.rescaleScale);
    appendFlag(args, prefix === "video" ? "--a2v-guidance-scale" : "--v2a-guidance-scale", guidance.modalityScale);
    appendFlag(args, `--${prefix}-skip-step`, guidance.skipStep);
    if (guidance.stgBlocks.length > 0) {
      args.push(`--${prefix}-stg-blocks`, ...guidance.stgBlocks.map(String));
    }
  }
}

function lipDubInspectionInput(request: GenerationRequest): LipDubReferenceInspectionInput {
  return {
    path: request.lipDub.referenceVideo.path,
    width: request.width,
    height: request.height,
    dialogue: request.promptParts.dialogue,
    prompt: request.prompt,
    pipelineProfile: request.lipDub.pipelineProfile,
  };
}

function lipDubPrompt(request: GenerationRequest): string {
  const lines = [
    request.prompt.trim(),
    "",
    "Redubbing constraints:",
    `- Target language: ${request.lipDub.targetLanguage.trim()}.`,
    "- Exactly one visible person speaks.",
    "- Speak the target dialogue in the target language's native script.",
  ];
  const dialogue = request.promptParts.dialogue.trim();
  if (dialogue) lines.push(`- Target dialogue (verbatim): ${JSON.stringify(dialogue)}.`);
  return lines.join("\n");
}

function validateLipDubReference(request: GenerationRequest): string[] {
  const errors: string[] = [];
  if (!request.lipDub.targetLanguage.trim()) {
    errors.push("LipDub-Zielsprache fehlt.");
  }
  if (!request.lipDub.singleSpeakerAcknowledged) {
    errors.push("LipDub erfordert die Bestätigung, dass im Referenzclip genau eine Person spricht.");
  }
  if (request.lipDub.referenceVideo.path) {
    errors.push(...inspectLipDubReference(lipDubInspectionInput(request)).findings
      .filter((item) => item.level === "error")
      .map((item) => item.message));
  }
  return errors;
}

function validateOfficialSpeechAssets(request: GenerationRequest): string[] {
  const errors: string[] = [];
  const documentedCheckpoint = documentedLtx23CheckpointAssetId(request);
  const requireAsset = (
    id: RecommendedModelAsset["id"],
    selectedPath: string,
    label: string,
  ) => {
    const expected = recommendedModelAsset(id);
    if (resolve(selectedPath) !== resolve(expected.localPath)) {
      errors.push(
        `${label}: die offizielle LTX-2.3-Pipeline verlangt ${expected.localPath}; ausgewählt ist ${selectedPath || "nichts"}.`,
      );
    }
  };
  if (request.mode === "ic-lora" && request.icLora.profile === "hdr") {
    requireAsset("ltx23-hdr-lora", request.icLora.lora.path, "HDR IC-LoRA");
    requireAsset(
      "ltx23-hdr-scene-embeddings",
      request.icLora.hdrTextEmbeddingsPath,
      "HDR-Szenen-Embeddings",
    );
    requireAsset(
      "lipdub-distilled-checkpoint",
      request.models.distilledCheckpointPath,
      "Distilled Checkpoint",
    );
    requireAsset("ltx23-spatial-upscaler", request.models.spatialUpscalerPath, "Spatial Upscaler");
    return errors;
  }
  if (request.mode === "ic-lora") {
    const controlAssetId = icLoraModelAssetId(request);
    requireAsset(
      controlAssetId,
      request.icLora.lora.path,
      recommendedModelAsset(controlAssetId).label,
    );
    if (request.icLora.profile === "union-control" && request.icLora.controlType === "depth") {
      requireAsset("ltx23-moge", request.icLora.mogeModelPath, "MoGe-Geometriemodell");
    }
  }
  if (request.mode === "id-lora") {
    requireAsset("ltx23-id-lora-talkvid", request.idLora.lora.path, "ID-LoRA TalkVid");
  }
  if (!usesOfficialSpeechStack(request) && !documentedCheckpoint) return errors;

  const officialComfyLipDub = usesOfficialComfyLipDub(request);
  const nativeUnionControl = request.mode === "ic-lora" && request.icLora.profile === "union-control";
  const usesDistilledCheckpoint = ["distilled", "keyframes"].includes(request.mode)
    || nativeUnionControl
    || (request.mode === "lipdub" && !officialComfyLipDub)
    || (request.mode === "retake" && request.retake.distilled);

  requireAsset("ltx23-gemma", request.models.gemmaRoot, "Gemma");
  requireAsset(
    documentedCheckpoint
      ?? (usesDistilledCheckpoint ? "lipdub-distilled-checkpoint" : "ltx23-dev-checkpoint"),
    usesDistilledCheckpoint ? request.models.distilledCheckpointPath : request.models.checkpointPath,
    documentedCheckpoint ? "Dokumentierter LTX-2.3 Checkpoint" : usesDistilledCheckpoint
      ? "Distilled Checkpoint"
      : "Dev Checkpoint",
  );
  if (documentedCheckpoint?.includes("fp8") && request.quantization.mode !== "fp8-scaled-mm") {
    errors.push(
      "Die offiziellen LTX-2.3-FP8-Checkpoints müssen mit „FP8 Scaled“ geladen werden; "
      + "ihre Gewichtsskalen liegen im Checkpoint.",
    );
  }
  if (!["one-stage", "ic-lora", "keyframes", "retake", "text-to-audio"].includes(request.mode)) {
    requireAsset(
      request.mode === "lipdub" ? "lipdub-spatial-upscaler" : "ltx23-spatial-upscaler",
      request.models.spatialUpscalerPath,
      "Spatial Upscaler",
    );
  }
  if (["two-stage", "two-stage-hq", "image-audio-to-video", "audio-to-video", "id-lora", "text-to-audio"].includes(request.mode)
    || (request.mode === "ic-lora" && request.icLora.profile !== "union-control")
    || officialComfyLipDub) {
    requireAsset(
      documentedLtx23DistilledLoraAssetId(request),
      request.models.distilledLora.path,
      "Distilled LoRA",
    );
  }
  if (needsGemmaAbliteratedLoraForRequest(request)) {
    requireAsset("ltx23-gemma-abliterated-lora", request.models.gemmaLora.path, "Gemma Abliterated LoRA");
  }
  if (request.mode === "lipdub") {
    requireAsset("lipdub-lora", request.lipDub.lora.path, "LipDub IC-LoRA");
  }

  return errors;
}

export function validateOfficialSpeechInventory(
  request: GenerationRequest,
  inventory: ModelInventory,
): string[] {
  return requiredOfficialSpeechAssetIds(request).flatMap((id) => {
    const expected = recommendedModelAsset(id);
    const actual = inventory.recommendations.find((asset) => asset.id === id);
    if (actual?.present && actual.integrity === "verified") return [];
    return [
      `${expected.label}: offizielles Asset ist nicht vollständig SHA-256-verifiziert `
      + `(Status: ${actual?.integrity ?? "missing"}).`,
    ];
  });
}

function warnLipDubReference(request: GenerationRequest): string[] {
  const warnings: string[] = [];

  if (request.lipDub.referenceVideo.path) {
    warnings.push(...inspectLipDubReference(lipDubInspectionInput(request)).findings
      .filter((item) => item.level === "warning")
      .map((item) => item.message));
  }

  return warnings;
}

export function buildCommand(request: GenerationRequest): CommandPlan {
  const outputPath = resolve(outputRoot, request.outputName);
  const hdrICLora = request.mode === "ic-lora" && request.icLora.profile === "hdr";
  const inOutpaintICLora = request.mode === "ic-lora"
    && ["inpainting", "outpainting"].includes(request.icLora.profile);
  const args = [
    "-I",
    "-m",
    hdrICLora
      ? "ltx_pipelines.hdr_ic_lora"
      : inOutpaintICLora
        ? "ltx_pipelines.inoutpaint"
        : MODULES[request.mode],
  ];
  const requiredPaths: PathRequirement[] = hdrICLora
    ? []
    : [{ path: request.models.gemmaRoot, label: "Gemma Root", kind: "directory" }];
  if (request.enhancePrompt && !hdrICLora) {
    requiredPaths.push({
      path: join(request.models.gemmaRoot, "preprocessor_config.json"),
      label: "Gemma Prozessorkonfiguration für Promptverbesserung",
      kind: "file",
    });
  }

  if (hdrICLora) {
    const sourceVideo = request.icLora.videoConditioning[0];
    args.push(
      "--input",
      sourceVideo?.path ?? "",
      "--output-dir",
      resolve(outputRoot, `${request.outputName.replace(/\.mp4$/i, "")}_hdr`),
      "--output-path",
      outputPath,
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
      "--width",
      String(request.width),
      "--height",
      String(request.height),
      "--frame-rate",
      String(request.frameRate),
      "--seed",
      String(request.seed),
    );
    appendBoolean(args, request.icLora.hdrHighQuality, "--high-quality");
    requiredPaths.push(
      { path: sourceVideo?.path ?? "", label: "HDR-Quellvideo", kind: "file" },
      { path: request.icLora.lora.path, label: "HDR IC-LoRA", kind: "file" },
      { path: request.icLora.hdrTextEmbeddingsPath, label: "HDR-Szenen-Embeddings", kind: "file" },
      { path: request.models.distilledCheckpointPath, label: "Distilled Checkpoint", kind: "file" },
      { path: request.models.spatialUpscalerPath, label: "Spatial Upscaler", kind: "file" },
    );
  } else if (inOutpaintICLora) {
    const sourceVideo = request.icLora.videoConditioning[0];
    args.push(
      "--checkpoint-path",
      request.models.checkpointPath,
      "--gemma-root",
      request.models.gemmaRoot,
      "--prompt",
      renderPrompt(request),
      "--negative-prompt",
      request.negativePrompt,
      "--output-path",
      outputPath,
      "--source-video",
      sourceVideo?.path ?? "",
      "--edit-mode",
      request.icLora.profile === "inpainting" ? "inpaint" : "outpaint",
      "--seed",
      String(request.seed),
      "--stage-2-seed",
      "42",
      "--height",
      String(request.height),
      "--width",
      String(request.width),
      "--num-frames",
      String(request.numFrames),
      "--frame-rate",
      String(request.frameRate),
      "--lora",
      request.models.distilledLora.path,
      String(request.models.distilledLora.strength),
      "--lora",
      request.icLora.lora.path,
      String(request.icLora.lora.strength),
    );
    if (request.icLora.profile === "inpainting") {
      args.push("--mask-video", request.icLora.attentionMaskPath);
    }
    for (const lora of request.models.loras) {
      args.push("--lora", lora.path, String(lora.strength));
    }
    appendBoolean(args, request.enhancePrompt, "--enhance-prompt");
    appendBoolean(args, !request.tiling, "--disable-tiling");
    if (request.quantization.mode !== "none") {
      args.push("--quantization", request.quantization.mode);
    }
    requiredPaths.push(
      { path: request.models.checkpointPath, label: "Dev Checkpoint", kind: "file" },
      { path: request.models.distilledLora.path, label: "Distilled LoRA", kind: "file" },
      { path: request.icLora.lora.path, label: "In-/Outpainting IC-LoRA", kind: "file" },
      { path: sourceVideo?.path ?? "", label: "Quellvideo", kind: "file" },
    );
    if (request.icLora.profile === "inpainting") {
      requiredPaths.push({
        path: request.icLora.attentionMaskPath,
        label: "Inpainting-Maskenvideo",
        kind: "file",
      });
    }
  } else if (request.mode === "text-to-audio") {
    args.push(
      "--checkpoint-path",
      request.models.checkpointPath,
      "--gemma-root",
      request.models.gemmaRoot,
      "--prompt",
      renderPrompt(request),
      "--negative-prompt",
      request.negativePrompt,
      "--output-path",
      outputPath,
      "--seed",
      String(request.seed),
      "--num-frames",
      String(request.numFrames),
      "--frame-rate",
      String(request.frameRate),
      "--num-inference-steps",
      "8",
      "--official-comfy-workflow",
      "--lora",
      request.models.distilledLora.path,
      String(request.models.distilledLora.strength),
      "--audio-cfg-guidance-scale",
      String(request.audioGuidance.cfgScale),
      "--audio-stg-guidance-scale",
      String(request.audioGuidance.stgScale),
      "--audio-rescale-scale",
      String(request.audioGuidance.rescaleScale),
      "--audio-skip-step",
      String(request.audioGuidance.skipStep),
    );
    if (request.audioGuidance.stgBlocks.length > 0) {
      args.push("--audio-stg-blocks", ...request.audioGuidance.stgBlocks.map(String));
    }
    for (const lora of request.models.loras) {
      args.push("--lora", lora.path, String(lora.strength));
    }
    appendBoolean(args, request.enhancePrompt, "--enhance-prompt");
    if (request.quantization.mode !== "none") {
      args.push("--quantization", request.quantization.mode);
    }
    requiredPaths.push(
      { path: request.models.checkpointPath, label: "Dev Checkpoint", kind: "file" },
      { path: request.models.distilledLora.path, label: "Distilled LoRA", kind: "file" },
    );
  } else if (request.mode === "lipdub") {
    const officialComfyLipDub = usesOfficialComfyLipDub(request);
    args.push(
      "--pipeline-profile",
      request.lipDub.pipelineProfile,
      officialComfyLipDub ? "--checkpoint-path" : "--distilled-checkpoint-path",
      officialComfyLipDub ? request.models.checkpointPath : request.models.distilledCheckpointPath,
      "--gemma-root",
      request.models.gemmaRoot,
      "--prompt",
      lipDubPrompt(request),
      "--output-path",
      outputPath,
      "--seed",
      String(request.seed),
      "--height",
      String(request.height),
      "--width",
      String(request.width),
      "--spatial-upsampler-path",
      request.models.spatialUpscalerPath,
      "--reference-video",
      request.lipDub.referenceVideo.path,
      "--reference-strength",
      String(request.lipDub.referenceVideo.strength),
      "--lora",
      request.lipDub.lora.path,
      String(request.lipDub.lora.strength),
    );
    if (officialComfyLipDub) {
      args.push(
        "--distilled-lora",
        request.models.distilledLora.path,
        String(request.models.distilledLora.strength),
        "--stage-2-seed",
        String(request.seed > 0 ? request.seed - 1 : 0),
      );
    }
    appendBoolean(args, request.enhancePrompt, "--enhance-prompt");
    if (request.quantization.mode !== "none") {
      args.push("--quantization", request.quantization.mode);
    }
    requiredPaths.push(
      {
        path: officialComfyLipDub ? request.models.checkpointPath : request.models.distilledCheckpointPath,
        label: officialComfyLipDub ? "Dev Checkpoint" : "Distilled Checkpoint",
        kind: "file",
      },
      { path: request.models.spatialUpscalerPath, label: "Spatial Upscaler", kind: "file" },
      { path: request.lipDub.referenceVideo.path, label: "LipDub-Referenzvideo", kind: "file" },
      { path: request.lipDub.lora.path, label: "LipDub IC-LoRA", kind: "file" },
    );
    if (officialComfyLipDub) {
      requiredPaths.push({ path: request.models.distilledLora.path, label: "Distilled LoRA", kind: "file" });
    }
  } else if (request.mode === "retake") {
    const checkpointPath = request.retake.distilled
      ? request.models.distilledCheckpointPath
      : request.models.checkpointPath;
    args.push(
      "--video-path",
      request.retake.videoPath,
      "--prompt",
      renderPrompt(request),
      "--start-time",
      String(request.retake.startTime),
      "--end-time",
      String(request.retake.endTime),
      "--output-path",
      outputPath,
      "--checkpoint-path",
      checkpointPath,
      "--gemma-root",
      request.models.gemmaRoot,
      "--seed",
      String(request.seed),
    );
    if (!request.retake.distilled) {
      appendFlag(args, "--negative-prompt", request.negativePrompt);
      appendFlag(args, "--num-inference-steps", request.numInferenceSteps);
      appendGuidanceArgs(request, args);
    }
    appendBoolean(args, request.enhancePrompt, "--enhance-prompt");
    appendBoolean(args, request.retake.distilled, "--distilled");
    appendBoolean(args, !request.retake.regenerateVideo, "--no-regenerate-video");
    appendBoolean(args, !request.retake.regenerateAudio, "--no-regenerate-audio");
    appendBoolean(args, !request.tiling, "--disable-tiling");
    for (const lora of request.models.loras) args.push("--lora", lora.path, String(lora.strength));
    if (request.quantization.mode !== "none") {
      args.push("--quantization", request.quantization.mode);
    }
    requiredPaths.push(
      { path: checkpointPath, label: request.retake.distilled ? "Distilled Checkpoint" : "Checkpoint", kind: "file" },
      { path: request.retake.videoPath, label: "Quellvideo", kind: "file" },
    );
  } else {
    const nativeUnionControl = request.mode === "ic-lora" && request.icLora.profile === "union-control";
    const distilled = ["distilled", "keyframes"].includes(request.mode) || nativeUnionControl;
    const checkpointPath = distilled ? request.models.distilledCheckpointPath : request.models.checkpointPath;
    appendFlag(args, distilled ? "--distilled-checkpoint-path" : "--checkpoint-path", checkpointPath);
    appendCommonGenerationArgs(request, args);
    if (["two-stage", "ic-lora", "image-audio-to-video"].includes(request.mode)) {
      args.push("--official-comfy-workflow");
    }
    requiredPaths.push({ path: checkpointPath, label: distilled ? "Distilled Checkpoint" : "Checkpoint", kind: "file" });

    if (["two-stage", "two-stage-hq", "one-stage", "audio-to-video"].includes(request.mode)) {
      appendFlag(args, "--negative-prompt", request.negativePrompt);
    }
    if (["two-stage-hq", "one-stage", "audio-to-video"].includes(request.mode)) {
      appendGuidanceArgs(request, args, !isAudioConditionedMode(request.mode));
    }
    if (["two-stage", "two-stage-hq", "image-audio-to-video", "audio-to-video", "id-lora"].includes(request.mode)) {
      const distilledLoraStrength = request.mode === "id-lora"
        ? request.idLora.distilledLoraStrength
        : request.models.distilledLora.strength;
      args.push("--distilled-lora", request.models.distilledLora.path, String(distilledLoraStrength));
      requiredPaths.push({ path: request.models.distilledLora.path, label: "Distilled LoRA", kind: "file" });
    }
    if (!["one-stage", "ic-lora", "keyframes"].includes(request.mode)) {
      appendFlag(args, "--spatial-upsampler-path", request.models.spatialUpscalerPath);
      requiredPaths.push({ path: request.models.spatialUpscalerPath, label: "Spatial Upscaler", kind: "file" });
    }
    if (request.mode === "two-stage-hq") {
      appendFlag(args, "--distilled-lora-strength-stage-1", request.hq.distilledLoraStrengthStage1);
      appendFlag(args, "--distilled-lora-strength-stage-2", request.hq.distilledLoraStrengthStage2);
    }
    if (request.mode === "ic-lora") {
      const ingredients = request.icLora.profile === "ingredients";
      const unionControl = request.icLora.profile === "union-control";
      const pixelUpscaler = request.icLora.profile === "pixel-upscaler";
      const freezeControlAudio = ["pixel-upscaler", "v2v-instant-shave"].includes(request.icLora.profile);
      requiredPaths.push({
        path: request.icLora.lora.path,
        label: recommendedModelAsset(icLoraModelAssetId(request)).label,
        kind: "file",
      });
      if (!unionControl) {
        requiredPaths.push({
          path: request.models.distilledLora.path,
          label: "Distilled LoRA",
          kind: "file",
        });
      }
      appendFlag(
        args,
        "--official-comfy-sampler",
        unionControl
          ? "euler-ancestral-rf"
          : pixelUpscaler ? "euler-cfg-pp" : "euler-ancestral-cfg-pp",
      );
      appendFlag(args, "--negative-prompt", request.negativePrompt);
      appendFlag(args, "--control-preprocessor", unionControl ? request.icLora.controlType : "prepared");
      if (unionControl) {
        appendFlag(args, "--control-cache-dir", resolve(outputRoot, "..", "control-cache"));
      }
      if (unionControl && request.icLora.controlType === "depth") {
        appendFlag(args, "--moge-model-path", request.icLora.mogeModelPath);
        requiredPaths.push({
          path: request.icLora.mogeModelPath,
          label: "MoGe-Geometriemodell",
          kind: "file",
        });
      }
      if (ingredients) {
        const image = request.images[0];
        if (image) {
          args.push("--video-conditioning", image.path, "1");
          args.push("--repeat-static-control");
        }
      } else {
        for (const video of request.icLora.videoConditioning) {
          args.push("--video-conditioning", video.path, String(video.strength));
          requiredPaths.push({ path: video.path, label: `Kontrollvideo ${video.name}`, kind: "file" });
        }
      }
      if (freezeControlAudio && request.icLora.videoConditioning[0]) {
        args.push("--freeze-control-audio", request.icLora.videoConditioning[0].path);
      }
      if (unionControl && request.icLora.attentionMaskPath) {
        args.push(
          "--conditioning-attention-mask",
          request.icLora.attentionMaskPath,
          String(request.icLora.attentionStrength),
        );
        requiredPaths.push({ path: request.icLora.attentionMaskPath, label: "Kontrollmaske", kind: "file" });
      }
    }
    if (request.mode === "id-lora") {
      args.push(
        "--reference-audio-path",
        request.idLora.referenceAudio.path,
        "--id-lora",
        request.idLora.lora.path,
        String(request.idLora.lora.strength),
        "--identity-guidance-scale",
        String(request.idLora.identityGuidanceScale),
        "--identity-guidance-start",
        String(request.idLora.identityGuidanceStart),
        "--identity-guidance-end",
        String(request.idLora.identityGuidanceEnd),
        "--stage-1-image-strength",
        String(request.idLora.stage1ImageStrength),
      );
      requiredPaths.push(
        { path: request.idLora.referenceAudio.path, label: "ID-LoRA-Referenzton", kind: "file" },
        { path: request.idLora.lora.path, label: "ID-LoRA TalkVid", kind: "file" },
      );
    }
    if (isAudioConditionedMode(request.mode)) {
      appendFlag(args, "--audio-path", request.audio.path);
      appendFlag(args, "--audio-start-time", request.audio.startTime);
      if (request.audio.maxDuration !== null) appendFlag(args, "--audio-max-duration", request.audio.maxDuration);
      requiredPaths.push({ path: request.audio.path, label: "Audiodatei", kind: "file" });
      if (request.audio.finalMix.path) {
        requiredPaths.push({ path: request.audio.finalMix.path, label: "Finale Tonspur", kind: "file" });
      }
    }
  }

  if (request.mode !== "lipdub") {
    for (const image of request.images) {
      requiredPaths.push({ path: image.path, label: `Bild ${image.name}`, kind: "file" });
    }
    for (const lora of request.models.loras) {
      if (request.mode === "ic-lora" && resolve(lora.path) === resolve(request.icLora.lora.path)) continue;
      requiredPaths.push({ path: lora.path, label: "LoRA", kind: "file" });
    }
    if (needsGemmaAbliteratedLoraForRequest(request)) {
      requiredPaths.push({
        path: request.models.gemmaLora.path,
        label: "Gemma Abliterated LoRA",
        kind: "file",
      });
    }
  }

  return {
    executable: rendererPythonExecutable,
    args,
    displayCommand: [rendererPythonExecutable, ...args].map(shellQuote).join(" "),
    outputPath,
    requiredPaths,
  };
}

export function validatePlanPaths(plan: CommandPlan): string[] {
  const errors: string[] = [];
  for (const requirement of plan.requiredPaths) {
    try {
      const stats = statSync(requirement.path);
      const matches = requirement.kind === "file" ? stats.isFile() : stats.isDirectory();
      if (!matches) errors.push(`${requirement.label}: falscher Pfadtyp (${requirement.path})`);
    } catch {
      errors.push(`${requirement.label}: nicht gefunden (${requirement.path})`);
    }
  }
  if (existsSync(plan.outputPath)) errors.push(`Ausgabedatei existiert bereits (${plan.outputPath})`);
  return errors;
}

export function validateRequestPlan(
  request: GenerationRequest,
  plan: CommandPlan,
  inventory?: ModelInventory,
  options: { enforceOfficialAssets?: boolean } = {},
): string[] {
  const enforceOfficialAssets = options.enforceOfficialAssets !== false;
  const errors = [
    ...validatePlanPaths(plan),
    ...(enforceOfficialAssets ? validateOfficialSpeechAssets(request) : []),
  ];
  if (isNativeDialogueRequest(request) && request.enhancePrompt) {
    errors.push(
      "Für wortgetreuen nativen Dialog muss die Gemma-Promptverbesserung ausgeschaltet bleiben; "
      + "sie kann den gesprochenen Wortlaut umformulieren.",
    );
  }
  if (inventory && enforceOfficialAssets) {
    errors.push(...validateOfficialSpeechInventory(request, inventory));
  }
  if (request.mode === "lipdub") errors.push(...validateLipDubReference(request));
  return errors;
}

export function warnRequestPlan(request: GenerationRequest): string[] {
  return request.mode === "lipdub" ? warnLipDubReference(request) : [];
}

export function suggestRequestPlan(request: GenerationRequest): PlanSuggestion[] {
  if (request.mode !== "lipdub" || !request.lipDub.referenceVideo.path) return [];
  const metadata = probeVideoMetadata(request.lipDub.referenceVideo.path);
  if (!metadata) return [];
  const recommendedSize = recommendedLipDubOutputSize(
    metadata,
    usesOfficialComfyLipDub(request) ? OFFICIAL_COMFY_LIPDUB_OUTPUT_AREA : null,
  );
  if (!recommendedSize) return [];
  if (recommendedSize.width === request.width && recommendedSize.height === request.height) return [];

  return [{
    id: "lipdub-reference-format",
    level: "info",
    label: `Format ${recommendedSize.width} x ${recommendedSize.height} übernehmen`,
    message:
      `Referenzvideo ${metadata.width} x ${metadata.height}; empfohlenes 64er-LipDub-Format `
      + `${recommendedSize.width} x ${recommendedSize.height} mit möglichst geringer Seitenverhältnisdrift.`,
    patch: recommendedSize,
  }];
}
