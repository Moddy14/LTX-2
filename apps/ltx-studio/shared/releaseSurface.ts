import { z } from "zod";

import {
  defaultLipForcingRawOutputProfile,
  dfrSettings,
  icLoraProfiles,
  lipDubPipelineProfiles,
  needsGemmaAbliteratedLora,
  pipelineModes,
  supportsGemmaAbliteratedLoraForRequest,
  type GenerationRequest,
  type ICLoraProfile,
  type LipDubPipelineProfile,
  type PipelineMode,
} from "./pipelines.js";

export const releaseGateIds = [
  "runtime-import",
  "cold-canary",
  "playable-output",
  "provenance",
  "av-sync",
  "phoneme-viseme",
  "mouth-artifact",
  "identity",
  "sharpness",
  "vbench-i2v",
  "asr-critical-token",
  "audio-quality",
  "mos",
] as const;
export type ReleaseGateId = (typeof releaseGateIds)[number];

export const postprocessorIds = [
  "none",
  "longcat-lipsync",
  "latentsync-1.6",
  "musetalk-1.5",
  "lipforcing-14b-wan-vae",
  "lipforcing-14b-streaming-taehv",
] as const;
export type PostprocessorId = (typeof postprocessorIds)[number];

export const promptEncoderProfiles = [
  "not-applicable",
  "base-gemma",
  "abliterated-lora",
] as const;
export type PromptEncoderProfile = (typeof promptEncoderProfiles)[number];

export const releaseModelProfiles = [
  "ltx23-monolith",
  "ltx25-split-bf16-single-stage",
  "ltx25-split-bf16-two-stage",
  "ltx25-split-bf16-dfr",
] as const;
export type ReleaseModelProfile = (typeof releaseModelProfiles)[number];

export const releaseUnionControlTypes = ["depth", "canny", "pose"] as const;
export type ReleaseUnionControlType = (typeof releaseUnionControlTypes)[number];

export function promptEncoderProfileForRequest(
  request: Pick<GenerationRequest, "mode" | "icLora" | "models">,
): PromptEncoderProfile {
  if (!supportsGemmaAbliteratedLoraForRequest(request)) return "not-applicable";
  return request.models.gemmaLora.enabled ? "abliterated-lora" : "base-gemma";
}

const releaseGateSchema = z.enum(releaseGateIds);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const nonApplicableGateSchema = z.object({
  gate: releaseGateSchema,
  reason: z.string().min(1),
}).strict();

export const releaseSurfaceEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]+$/),
  claimId: z.string().regex(/^[a-z0-9][a-z0-9.-]+$/),
  request: z.object({
    mode: z.enum(pipelineModes),
    sourceMode: z.enum(["text", "image", "not-applicable"]),
    icLoraProfile: z.enum(icLoraProfiles).nullable(),
    lipDubPipelineProfile: z.enum(lipDubPipelineProfiles).nullable(),
    retakeCheckpoint: z.enum(["dev", "distilled"]).nullable(),
    modelProfile: z.enum(releaseModelProfiles),
    unionControlType: z.enum(releaseUnionControlTypes).nullable(),
    dfrTemporalUpscalings: z.union([z.literal(0), z.literal(1), z.literal(2)]).nullable(),
    dfrSpatialUpscalings: z.union([z.literal(1), z.literal(2)]).nullable(),
    promptEncoderProfile: z.enum(promptEncoderProfiles),
    dialogueIntent: z.enum(["required", "optional", "not-applicable"]),
    postprocessor: z.enum(postprocessorIds),
  }).strict(),
  inputContract: z.array(z.string().min(1)).min(1),
  outputMedia: z.enum(["video/mp4", "audio/wav"]),
  cooperativeCheckpoint: z.boolean(),
  applicableGates: z.array(releaseGateSchema),
  notApplicable: z.array(nonApplicableGateSchema),
  rights: z.object({
    status: z.enum(["conditional", "blocked"]),
    evidenceIds: z.array(z.string().min(1)).min(1),
    reason: z.string().min(1),
  }).strict(),
  targetStatus: z.enum(["candidate", "blocked"]),
  targetReason: z.string().min(1).nullable(),
}).strict().superRefine((entry, context) => {
  const applicable = new Set(entry.applicableGates);
  const notApplicable = new Set(entry.notApplicable.map(({ gate }) => gate));
  for (const gate of releaseGateIds) {
    if (applicable.has(gate) === notApplicable.has(gate)) {
      context.addIssue({
        code: "custom",
        path: ["applicableGates"],
        message: `${gate} must occur exactly once across applicableGates and notApplicable`,
      });
    }
  }
  if (applicable.size !== entry.applicableGates.length
    || notApplicable.size !== entry.notApplicable.length) {
    context.addIssue({ code: "custom", path: ["applicableGates"], message: "duplicate gate" });
  }
  if (entry.rights.status === "blocked" && entry.targetStatus !== "blocked") {
    context.addIssue({
      code: "custom",
      path: ["targetStatus"],
      message: "blocked rights require a blocked target status",
    });
  }
  if ((entry.targetStatus === "blocked") !== (entry.targetReason !== null)) {
    context.addIssue({
      code: "custom",
      path: ["targetReason"],
      message: "blocked entries require a target reason and candidate entries forbid one",
    });
  }
  const dfrSettingsPresent = entry.request.dfrTemporalUpscalings !== null
    && entry.request.dfrSpatialUpscalings !== null;
  if ((entry.request.mode === "dfr") !== dfrSettingsPresent) {
    context.addIssue({
      code: "custom",
      path: ["request", "dfrTemporalUpscalings"],
      message: "DFR settings must be explicit only for DFR surface entries",
    });
  }
  const supportsOptionalLora = entry.request.modelProfile === "ltx23-monolith"
    && (needsGemmaAbliteratedLora(entry.request.mode)
      || (entry.request.mode === "ic-lora" && entry.request.icLoraProfile === "union-control"));
  if (supportsOptionalLora === (entry.request.promptEncoderProfile === "not-applicable")) {
    context.addIssue({
      code: "custom",
      path: ["request", "promptEncoderProfile"],
      message: supportsOptionalLora
        ? "optional Gemma-LoRA modes require an explicit base-gemma or abliterated-lora profile"
        : "prompt encoder profile must be not-applicable for this request",
    });
  }
});

export const candidateReleaseSurfaceSchema = z.object({
  schemaVersion: z.literal("candidate-release-surface.v1"),
  policyVersion: z.literal("ltx-studio-release-rights.v1"),
  inputs: z.object({
    requestSchema: z.object({ path: z.string().min(1), sha256: sha256Schema }).strict(),
    capabilityMatrix: z.object({ path: z.string().min(1), sha256: sha256Schema }).strict(),
  }).strict(),
  activationContract: z.object({
    candidate: z.literal("requires-current-signed-rights-attest-and-all-applicable-gates"),
    blocked: z.literal("must-not-run-in-production-or-support-release-claims"),
  }).strict(),
  entries: z.array(releaseSurfaceEntrySchema).min(1),
}).strict().superRefine((surface, context) => {
  const ids = new Set<string>();
  for (const [index, entry] of surface.entries.entries()) {
    if (ids.has(entry.id)) {
      context.addIssue({ code: "custom", path: ["entries", index, "id"], message: "duplicate id" });
    }
    ids.add(entry.id);
  }
  const sorted = [...surface.entries].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (surface.entries.some((entry, index) => entry.id !== sorted[index]?.id)) {
    context.addIssue({ code: "custom", path: ["entries"], message: "entries must be sorted by id" });
  }
});

export type CandidateReleaseSurface = z.infer<typeof candidateReleaseSurfaceSchema>;
export type ReleaseSurfaceEntry = z.infer<typeof releaseSurfaceEntrySchema>;

export function postprocessorForRequest(
  request: Pick<GenerationRequest, "postprocess">,
): PostprocessorId {
  if (request.postprocess.longcatLipsync.enabled) return "longcat-lipsync";
  if (request.postprocess.latentSync.enabled) return "latentsync-1.6";
  if (request.postprocess.museTalk.enabled) return "musetalk-1.5";
  if (request.postprocess.lipForcing.enabled) {
    return request.postprocess.lipForcing.decoder === "streaming-taehv"
      ? "lipforcing-14b-streaming-taehv"
      : "lipforcing-14b-wan-vae";
  }
  return "none";
}

type BaseVariant = {
  id: string;
  claimId: string;
  mode: PipelineMode;
  sourceMode: "text" | "image" | "not-applicable";
  icLoraProfile: ICLoraProfile | null;
  lipDubPipelineProfile: LipDubPipelineProfile | null;
  retakeCheckpoint: "dev" | "distilled" | null;
  modelProfile: ReleaseModelProfile;
  unionControlType: ReleaseUnionControlType | null;
  dfrTemporalUpscalings?: 0 | 1 | 2;
  dfrSpatialUpscalings?: 1 | 2;
  targetBlockReason?: string;
  inputContract: string[];
  dialogueIntent: "required" | "optional" | "not-applicable";
  identityReference: boolean;
};

const generationModes = ["two-stage", "two-stage-hq", "one-stage", "distilled"] as const;

function baseVariants(): BaseVariant[] {
  const variants: BaseVariant[] = [];
  for (const mode of generationModes) {
    for (const sourceMode of ["text", "image"] as const) {
      variants.push({
        id: `${mode}.${sourceMode}`,
        claimId: `native-generation.${sourceMode}-to-video`,
        mode,
        sourceMode,
        icLoraProfile: null,
        lipDubPipelineProfile: null,
        retakeCheckpoint: null,
        modelProfile: "ltx23-monolith",
        unionControlType: null,
        inputContract: sourceMode === "image" ? ["prompt", "one-or-more-reference-images"] : ["prompt"],
        dialogueIntent: "optional",
        identityReference: sourceMode === "image",
      });
    }
  }
  variants.push({
    id: "text-to-audio",
    claimId: "native-generation.text-to-audio",
    mode: "text-to-audio",
    sourceMode: "not-applicable",
    icLoraProfile: null,
    lipDubPipelineProfile: null,
    retakeCheckpoint: null,
    modelProfile: "ltx23-monolith",
    unionControlType: null,
    inputContract: ["prompt"],
    dialogueIntent: "optional",
    identityReference: false,
  });
  for (const profile of icLoraProfiles) {
    // Deblur is bound specifically to the audited LTX-2.5 split graph below;
    // Instant Shave remains the explicitly separate LTX-2.3 legacy V2V arm.
    if (profile === "v2v-deblur") continue;
    const needsImage = ["union-control", "ingredients", "motion-track"].includes(profile);
    const needsVideo = profile !== "ingredients";
    variants.push({
      id: `ic-lora.${profile}`,
      claimId: `controlled-video.ic-lora.${profile}`,
      mode: "ic-lora",
      sourceMode: "not-applicable",
      icLoraProfile: profile,
      lipDubPipelineProfile: null,
      retakeCheckpoint: null,
      modelProfile: "ltx23-monolith",
      unionControlType: null,
      inputContract: ["prompt", ...(needsImage ? ["reference-image"] : []), ...(needsVideo ? ["control-video"] : [])],
      dialogueIntent: "optional",
      identityReference: needsImage || needsVideo,
    });
  }
  variants.push({
    id: "id-lora",
    claimId: "identity-video.id-lora",
    mode: "id-lora",
    sourceMode: "not-applicable",
    icLoraProfile: null,
    lipDubPipelineProfile: null,
    retakeCheckpoint: null,
    modelProfile: "ltx23-monolith",
    unionControlType: null,
    inputContract: ["prompt-with-exact-dialogue", "reference-image", "reference-audio"],
    dialogueIntent: "required",
    identityReference: true,
  });
  variants.push({
    id: "keyframes",
    claimId: "controlled-video.first-last-frame",
    mode: "keyframes",
    sourceMode: "not-applicable",
    icLoraProfile: null,
    lipDubPipelineProfile: null,
    retakeCheckpoint: null,
    modelProfile: "ltx23-monolith",
    unionControlType: null,
    inputContract: ["prompt", "first-frame-image", "last-frame-image"],
    dialogueIntent: "optional",
    identityReference: true,
  });
  for (const mode of ["image-audio-to-video", "audio-to-video"] as const) {
    variants.push({
      id: mode,
      claimId: `audio-driven-video.${mode}`,
      mode,
      sourceMode: "not-applicable",
      icLoraProfile: null,
      lipDubPipelineProfile: null,
      retakeCheckpoint: null,
      modelProfile: "ltx23-monolith",
      unionControlType: null,
      inputContract: mode === "image-audio-to-video" ? ["prompt", "reference-image", "driving-audio"] : ["prompt", "driving-audio"],
      dialogueIntent: "required",
      identityReference: mode === "image-audio-to-video",
    });
  }
  for (const profile of lipDubPipelineProfiles) {
    variants.push({
      id: `lipdub.${profile}`,
      claimId: `reference-video-redubbing.${profile}`,
      mode: "lipdub",
      sourceMode: "not-applicable",
      icLoraProfile: null,
      lipDubPipelineProfile: profile,
      retakeCheckpoint: null,
      modelProfile: "ltx23-monolith",
      unionControlType: null,
      inputContract: ["reference-video", "exact-target-dialogue", "target-language", "single-speaker-acknowledgement"],
      dialogueIntent: "required",
      identityReference: true,
    });
  }
  for (const checkpoint of ["dev", "distilled"] as const) {
    variants.push({
      id: `retake.${checkpoint}`,
      claimId: "video-edit.retake",
      mode: "retake",
      sourceMode: "not-applicable",
      icLoraProfile: null,
      lipDubPipelineProfile: null,
      retakeCheckpoint: checkpoint,
      modelProfile: "ltx23-monolith",
      unionControlType: null,
      inputContract: ["source-video", "time-range", "at-least-one-of-video-or-audio-regeneration"],
      dialogueIntent: "optional",
      identityReference: true,
    });
  }
  return variants;
}

function ltx25Variants(): BaseVariant[] {
  const variants: BaseVariant[] = [];
  for (const sourceMode of ["text", "image"] as const) {
    for (const stage of ["two-stage", "single-stage"] as const) {
      variants.push({
        id: `ltx25.distilled.${sourceMode}.${stage}`,
        claimId: `native-generation.ltx25.${sourceMode}-to-video.${stage}`,
        mode: "distilled",
        sourceMode,
        icLoraProfile: null,
        lipDubPipelineProfile: null,
        retakeCheckpoint: null,
        modelProfile: stage === "two-stage"
          ? "ltx25-split-bf16-two-stage"
          : "ltx25-split-bf16-single-stage",
        unionControlType: null,
        inputContract: sourceMode === "image" ? ["prompt", "one-or-more-reference-images"] : ["prompt"],
        dialogueIntent: "optional",
        identityReference: sourceMode === "image",
      });
    }
  }
  for (const sourceMode of ["text", "image"] as const) {
    for (const temporalUpscalings of [0, 1, 2] as const) {
      for (const spatialUpscalings of [1, 2] as const) {
        variants.push({
          id: `ltx25.dfr.${sourceMode}.temporal-${temporalUpscalings}.spatial-${spatialUpscalings}`,
          claimId: `native-generation.ltx25.dfr.${sourceMode}-to-video`,
          mode: "dfr",
          sourceMode,
          icLoraProfile: null,
          lipDubPipelineProfile: null,
          retakeCheckpoint: null,
          modelProfile: "ltx25-split-bf16-dfr",
          unionControlType: null,
          dfrTemporalUpscalings: temporalUpscalings,
          dfrSpatialUpscalings: spatialUpscalings,
          inputContract: [
            "prompt",
            ...(sourceMode === "image" ? ["one-or-more-reference-images"] : []),
            "verified-dfr-detailing-ic-lora-fixed-0.5",
            ...(temporalUpscalings > 0 ? ["verified-dfr-temporal-upscaler"] : []),
          ],
          dialogueIntent: "optional",
          identityReference: sourceMode === "image",
          targetBlockReason:
            "DFR v1.3.0 is HOLD: the mandatory Detailing IC-LoRA is not locally SHA-256-verified, and peak-memory, cold-canary, durability and disjoint holdout evidence are incomplete.",
        });
      }
    }
  }
  variants.push({
    id: "ltx25.image-audio-to-video.two-stage",
    claimId: "audio-driven-video.ltx25.image-audio-to-video.two-stage",
    mode: "image-audio-to-video",
    sourceMode: "not-applicable",
    icLoraProfile: null,
    lipDubPipelineProfile: null,
    retakeCheckpoint: null,
    modelProfile: "ltx25-split-bf16-two-stage",
    unionControlType: null,
    inputContract: ["prompt", "reference-image", "driving-audio"],
    dialogueIntent: "required",
    identityReference: true,
  });
  variants.push({
    id: "ltx25.text-to-audio.single-stage",
    claimId: "native-generation.ltx25.text-to-audio.single-stage",
    mode: "text-to-audio",
    sourceMode: "not-applicable",
    icLoraProfile: null,
    lipDubPipelineProfile: null,
    retakeCheckpoint: null,
    modelProfile: "ltx25-split-bf16-single-stage",
    unionControlType: null,
    inputContract: ["prompt"],
    dialogueIntent: "optional",
    identityReference: false,
  });
  variants.push({
    id: "ltx25.text-to-audio.single-stage.verbatim-dialogue",
    claimId: "native-generation.ltx25.text-to-audio.single-stage.verbatim-dialogue",
    mode: "text-to-audio",
    sourceMode: "not-applicable",
    icLoraProfile: null,
    lipDubPipelineProfile: null,
    retakeCheckpoint: null,
    modelProfile: "ltx25-split-bf16-single-stage",
    unionControlType: null,
    inputContract: ["prompt", "verbatim-dialogue"],
    dialogueIntent: "required",
    identityReference: false,
  });
  for (const controlType of releaseUnionControlTypes) {
    variants.push({
      id: `ltx25.ic-lora.union-control.${controlType}`,
      claimId: `controlled-video.ltx25.ic-lora.union-control.${controlType}`,
      mode: "ic-lora",
      sourceMode: "not-applicable",
      icLoraProfile: "union-control",
      lipDubPipelineProfile: null,
      retakeCheckpoint: null,
      modelProfile: "ltx25-split-bf16-two-stage",
      unionControlType: controlType,
      inputContract: ["prompt", "reference-image", "control-video"],
      dialogueIntent: "optional",
      identityReference: true,
      targetBlockReason:
        "The pinned official LTX-2.5 Union Control workflow is two-stage, but the native Stage-2/spatial-upscaler implementation and executable contract proof are not implemented yet.",
    });
  }
  for (const profile of ["ingredients", "motion-track", "v2v-deblur"] as const) {
    const ingredients = profile === "ingredients";
    variants.push({
      id: `ltx25.ic-lora.${profile}`,
      claimId: `controlled-video.ltx25.ic-lora.${profile}`,
      mode: "ic-lora",
      sourceMode: "not-applicable",
      icLoraProfile: profile,
      lipDubPipelineProfile: null,
      retakeCheckpoint: null,
      modelProfile: "ltx25-split-bf16-single-stage",
      unionControlType: null,
      inputContract: [
        "prompt",
        ...(profile === "v2v-deblur" ? [] : ["reference-image"]),
        ...(ingredients ? [] : ["control-video"]),
      ],
      dialogueIntent: "optional",
      identityReference: true,
    });
  }
  return variants;
}

const blockedBaseEvidence = new Set([
  "comfy-ltx2-abliterated-lora-license-undeclared",
  "ltx23-id-lora-talkvid-data-rights-undeclared",
]);

function supportsOptionalGemmaLora(variant: BaseVariant): boolean {
  return variant.modelProfile === "ltx23-monolith"
    && (needsGemmaAbliteratedLora(variant.mode)
      || (variant.mode === "ic-lora" && variant.icLoraProfile === "union-control"));
}

function promptEncoderProfilesFor(variant: BaseVariant): PromptEncoderProfile[] {
  return supportsOptionalGemmaLora(variant)
    ? ["base-gemma", "abliterated-lora"]
    : ["not-applicable"];
}

function baseRightsFor(
  variant: BaseVariant,
  promptEncoderProfile: PromptEncoderProfile,
): ReleaseSurfaceEntry["rights"] {
  const ltx25 = variant.modelProfile !== "ltx23-monolith";
  const evidenceIds = ltx25
    ? ["ltx25-community-license-model-card-2026-08-21"]
    : ["ltx2-community-license-2026-01-05"];
  if (variant.mode === "dfr") {
    evidenceIds.push("ltx25-dfr-detailing-lora-model-card-2026-08-25");
  }
  if (!(variant.mode === "ic-lora" && variant.icLoraProfile === "hdr")) {
    evidenceIds.push("gemma-terms-model-card");
  }
  if (ltx25 && variant.mode === "ic-lora") {
    evidenceIds.push("ltx2-community-license-2026-01-05");
  }
  if (promptEncoderProfile === "abliterated-lora") {
    evidenceIds.push("comfy-ltx2-abliterated-lora-license-undeclared");
  }
  if (variant.mode === "id-lora") {
    evidenceIds.push("ltx23-id-lora-talkvid-data-rights-undeclared");
  }
  if (variant.mode === "ic-lora"
    && variant.icLoraProfile === "union-control"
    && (!ltx25 || variant.unionControlType === "depth")) {
    evidenceIds.push("moge-mit-model-card");
  }
  const blocked = evidenceIds.some((evidenceId) => blockedBaseEvidence.has(evidenceId));
  return {
    status: blocked ? "blocked" : "conditional",
    evidenceIds,
    reason: blocked
      ? "The fixed base recipe contains a model whose license, provenance, training-data, or biometric rights are not releaseable."
      : ltx25
        ? "Activation requires current signed attestations for the gated LTX-2.5 stack, reused LTX-2 IC-LoRAs where applicable, Gemma terms, commercial scope, acceptable-use, notice, and consent controls."
        : "Activation requires current signed attestations for LTX-2, Gemma where applicable, commercial scope, acceptable-use, notice, and consent controls.",
  };
}

function rightsFor(
  variant: BaseVariant,
  promptEncoderProfile: PromptEncoderProfile,
  postprocessor: PostprocessorId,
): ReleaseSurfaceEntry["rights"] {
  const base = baseRightsFor(variant, promptEncoderProfile);
  if (postprocessor === "none") return base;
  if (postprocessor === "longcat-lipsync") {
    return {
      status: base.status,
      evidenceIds: [...base.evidenceIds, "longcat-video-mit-model-card"],
      reason: base.status === "blocked"
        ? `${base.reason} Adding LongCat does not remove that block.`
        : "LongCat is MIT-licensed, while activation still requires signed LTX-2, Gemma, and biometric-input attestations.",
    };
  }
  const commonEvidence = [
    ...base.evidenceIds,
    "insightface-buffalo-l-noncommercial-model-policy-2025-11-24",
  ];
  if (postprocessor === "musetalk-1.5") {
    return {
      status: "blocked",
      evidenceIds: [...commonEvidence, "musetalk-model-card", "musetalk-face-parse-license-undeclared"],
      reason: "The installed path uses non-commercial InsightFace buffalo_l weights and a face-parsing weight whose upstream license is not declared.",
    };
  }
  return {
    status: "blocked",
    evidenceIds: [
      ...commonEvidence,
      postprocessor === "latentsync-1.6" ? "latentsync-apache-2.0" : "lipforcing-apache-2.0",
    ],
    reason: "The installed face detector/alignment weights are from InsightFace buffalo_l and are restricted upstream to non-commercial research until separately licensed or replaced.",
  };
}

function gatesFor(variant: BaseVariant, postprocessor: PostprocessorId): Pick<ReleaseSurfaceEntry, "applicableGates" | "notApplicable"> {
  const video = variant.mode !== "text-to-audio";
  const speech = variant.dialogueIntent === "required" || postprocessor !== "none";
  const applicable = new Set<ReleaseGateId>([
    "runtime-import",
    "cold-canary",
    "playable-output",
    "provenance",
    "audio-quality",
    "mos",
  ]);
  if (video) {
    applicable.add("av-sync");
    applicable.add("sharpness");
    if (variant.identityReference) applicable.add("vbench-i2v");
  }
  if (speech) {
    applicable.add("asr-critical-token");
    if (video) {
      applicable.add("phoneme-viseme");
      applicable.add("mouth-artifact");
    }
  }
  if (variant.identityReference) applicable.add("identity");

  const reasons: Partial<Record<ReleaseGateId, string>> = {
    "av-sync": "Audio-only output has no video timeline.",
    "phoneme-viseme": video
      ? "This surface entry makes no speech or lip-synchronization claim."
      : "Audio-only output has no visible phoneme-to-viseme alignment.",
    "mouth-artifact": video
      ? "This surface entry makes no mouth-rendering claim."
      : "Audio-only output has no rendered mouth region.",
    identity: "This surface entry has no identity-bearing visual reference.",
    sharpness: "Audio-only output has no image sharpness dimension.",
    "vbench-i2v": video
      ? "This claim has no image/video reference input and is outside VBench-I2V's input contract."
      : "Audio-only output is outside VBench-I2V's input contract.",
    "asr-critical-token": "This surface entry makes no intelligible-speech claim.",
  };
  return {
    applicableGates: releaseGateIds.filter((gate) => applicable.has(gate)),
    notApplicable: releaseGateIds
      .filter((gate) => !applicable.has(gate))
      .map((gate) => ({ gate, reason: reasons[gate] ?? "Not applicable to this claim's media and input contract." })),
  };
}

function entryFor(
  variant: BaseVariant,
  promptEncoderProfile: PromptEncoderProfile,
  postprocessor: PostprocessorId,
): ReleaseSurfaceEntry {
  const rights = rightsFor(variant, promptEncoderProfile, postprocessor);
  return {
    id: `${variant.id}.prompt.${promptEncoderProfile}.post.${postprocessor}`,
    claimId: postprocessor === "none" ? variant.claimId : `${variant.claimId}.refined.${postprocessor}`,
    request: {
      mode: variant.mode,
      sourceMode: variant.sourceMode,
      icLoraProfile: variant.icLoraProfile,
      lipDubPipelineProfile: variant.lipDubPipelineProfile,
      retakeCheckpoint: variant.retakeCheckpoint,
      modelProfile: variant.modelProfile,
      unionControlType: variant.unionControlType,
      dfrTemporalUpscalings: variant.dfrTemporalUpscalings ?? null,
      dfrSpatialUpscalings: variant.dfrSpatialUpscalings ?? null,
      promptEncoderProfile,
      dialogueIntent: postprocessor === "none" ? variant.dialogueIntent : "required",
      postprocessor,
    },
    inputContract: postprocessor === "none"
      ? variant.inputContract
      : [...variant.inputContract, "speech-audio-or-native-dialogue-track"],
    outputMedia: variant.mode === "text-to-audio" ? "audio/wav" : "video/mp4",
    cooperativeCheckpoint: variant.mode !== "two-stage-hq"
      && variant.mode !== "dfr"
      && variant.mode !== "text-to-audio"
      && variant.mode !== "ic-lora"
      && !postprocessor.startsWith("latentsync")
      && !postprocessor.startsWith("musetalk")
      && !postprocessor.startsWith("lipforcing"),
    ...gatesFor(variant, postprocessor),
    rights,
    targetStatus: rights.status === "blocked" || variant.targetBlockReason ? "blocked" : "candidate",
    targetReason: rights.status === "blocked"
      ? rights.reason
      : variant.targetBlockReason ?? null,
  };
}

export function deriveReleaseSurfaceEntries(): ReleaseSurfaceEntry[] {
  const entries: ReleaseSurfaceEntry[] = [];
  for (const variant of [...baseVariants(), ...ltx25Variants()]) {
    for (const promptEncoderProfile of promptEncoderProfilesFor(variant)) {
      entries.push(entryFor(variant, promptEncoderProfile, "none"));
      if (variant.modelProfile !== "ltx23-monolith") {
        if (variant.mode === "image-audio-to-video") {
          entries.push(entryFor(variant, promptEncoderProfile, "lipforcing-14b-wan-vae"));
          entries.push(entryFor(variant, promptEncoderProfile, "lipforcing-14b-streaming-taehv"));
        }
        continue;
      }
      if (variant.mode === "text-to-audio") continue;
      if (["image-audio-to-video", "audio-to-video"].includes(variant.mode)) {
        entries.push(entryFor(variant, promptEncoderProfile, "longcat-lipsync"));
      }
      entries.push(entryFor(variant, promptEncoderProfile, "latentsync-1.6"));
      entries.push(entryFor(variant, promptEncoderProfile, "musetalk-1.5"));
      entries.push(entryFor(variant, promptEncoderProfile, "lipforcing-14b-wan-vae"));
      entries.push(entryFor(variant, promptEncoderProfile, "lipforcing-14b-streaming-taehv"));
    }
  }
  return entries.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function releaseSurfaceEntryForRequest(request: GenerationRequest): ReleaseSurfaceEntry {
  if (request.postprocess.lipForcing.rawOutputProfile !== defaultLipForcingRawOutputProfile) {
    throw new Error(
      "Experimental LipForcing raw-output profiles are outside the declared release surface",
    );
  }
  const sourceMode = [...generationModes, "dfr"].includes(
    request.mode as (typeof generationModes)[number] | "dfr",
  )
    ? request.sourceMode
    : "not-applicable";
  const icLoraProfile = request.mode === "ic-lora" ? request.icLora.profile : null;
  const lipDubPipelineProfile = request.mode === "lipdub" ? request.lipDub.pipelineProfile : null;
  const retakeCheckpoint = request.mode === "retake"
    ? request.retake.distilled ? "distilled" : "dev"
    : null;
  const splitUnionControl = request.models.layout === "split"
    && request.mode === "ic-lora"
    && request.icLora.profile === "union-control";
  const modelProfile: ReleaseModelProfile = request.models.layout === "monolith"
    ? "ltx23-monolith"
    : request.mode === "dfr"
      ? "ltx25-split-bf16-dfr"
      : (request.mode === "image-audio-to-video"
      || splitUnionControl
      || (request.mode === "distilled" && !request.distilled.singleStage))
      ? "ltx25-split-bf16-two-stage"
      : "ltx25-split-bf16-single-stage";
  const unionControlType = request.models.layout === "split"
    && request.mode === "ic-lora"
    && request.icLora.profile === "union-control"
    && releaseUnionControlTypes.includes(request.icLora.controlType as ReleaseUnionControlType)
    ? request.icLora.controlType as ReleaseUnionControlType
    : null;
  const promptEncoderProfile = promptEncoderProfileForRequest(request);
  const postprocessor = postprocessorForRequest(request);
  const dfr = request.mode === "dfr" ? dfrSettings(request) : null;
  const t2aDialogueIntent = request.mode === "text-to-audio" && request.models.layout === "split"
    ? request.promptParts.dialogue.trim().length > 0 ? "required" : "optional"
    : null;
  const result = deriveReleaseSurfaceEntries().find(({ request: entry }) =>
    entry.mode === request.mode
    && entry.sourceMode === sourceMode
    && entry.icLoraProfile === icLoraProfile
    && entry.lipDubPipelineProfile === lipDubPipelineProfile
    && entry.retakeCheckpoint === retakeCheckpoint
    && entry.modelProfile === modelProfile
    && entry.unionControlType === unionControlType
    && entry.dfrTemporalUpscalings === (dfr?.temporalUpscalings ?? null)
    && entry.dfrSpatialUpscalings === (dfr?.spatialUpscalings ?? null)
    && entry.promptEncoderProfile === promptEncoderProfile
    && (t2aDialogueIntent === null || entry.dialogueIntent === t2aDialogueIntent)
    && entry.postprocessor === postprocessor);
  if (!result) throw new Error("Generation request is outside the declared release surface");
  return result;
}
