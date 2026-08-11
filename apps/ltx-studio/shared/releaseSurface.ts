import { z } from "zod";

import {
  icLoraProfiles,
  lipDubPipelineProfiles,
  pipelineModes,
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
  if ((entry.rights.status === "blocked") !== (entry.targetStatus === "blocked")) {
    context.addIssue({
      code: "custom",
      path: ["targetStatus"],
      message: "blocked rights and blocked target status must agree",
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

type BaseVariant = {
  id: string;
  claimId: string;
  mode: PipelineMode;
  sourceMode: "text" | "image" | "not-applicable";
  icLoraProfile: ICLoraProfile | null;
  lipDubPipelineProfile: LipDubPipelineProfile | null;
  retakeCheckpoint: "dev" | "distilled" | null;
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
    inputContract: ["prompt"],
    dialogueIntent: "optional",
    identityReference: false,
  });
  for (const profile of icLoraProfiles) {
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
      inputContract: ["source-video", "time-range", "at-least-one-of-video-or-audio-regeneration"],
      dialogueIntent: "optional",
      identityReference: true,
    });
  }
  return variants;
}

const ltxRights = {
  status: "conditional" as const,
  evidenceIds: ["ltx2-community-license-2026-01-05"],
  reason: "Activation requires a current signed attestation for revenue threshold, commercial agreement if applicable, and acceptable-use/user-notice controls.",
};

function rightsFor(postprocessor: PostprocessorId): ReleaseSurfaceEntry["rights"] {
  if (postprocessor === "none") return ltxRights;
  if (postprocessor === "longcat-lipsync") {
    return {
      status: "conditional",
      evidenceIds: ["ltx2-community-license-2026-01-05", "longcat-video-mit-model-card"],
      reason: "LongCat is MIT-licensed, while activation still requires the signed LTX-2 conditional-rights attestation for the base output.",
    };
  }
  const commonEvidence = [
    "ltx2-community-license-2026-01-05",
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
    applicable.add("phoneme-viseme");
    applicable.add("mouth-artifact");
    applicable.add("asr-critical-token");
  }
  if (variant.identityReference) applicable.add("identity");

  const reasons: Partial<Record<ReleaseGateId, string>> = {
    "av-sync": "Audio-only output has no video timeline.",
    "phoneme-viseme": "This surface entry makes no speech or lip-synchronization claim.",
    "mouth-artifact": "This surface entry makes no mouth-rendering claim.",
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

function entryFor(variant: BaseVariant, postprocessor: PostprocessorId): ReleaseSurfaceEntry {
  const rights = rightsFor(postprocessor);
  return {
    id: `${variant.id}.post.${postprocessor}`,
    claimId: postprocessor === "none" ? variant.claimId : `${variant.claimId}.refined.${postprocessor}`,
    request: {
      mode: variant.mode,
      sourceMode: variant.sourceMode,
      icLoraProfile: variant.icLoraProfile,
      lipDubPipelineProfile: variant.lipDubPipelineProfile,
      retakeCheckpoint: variant.retakeCheckpoint,
      dialogueIntent: postprocessor === "none" ? variant.dialogueIntent : "required",
      postprocessor,
    },
    inputContract: postprocessor === "none"
      ? variant.inputContract
      : [...variant.inputContract, "speech-audio-or-native-dialogue-track"],
    outputMedia: variant.mode === "text-to-audio" ? "audio/wav" : "video/mp4",
    cooperativeCheckpoint: variant.mode !== "two-stage-hq"
      && variant.mode !== "text-to-audio"
      && variant.mode !== "ic-lora"
      && !postprocessor.startsWith("latentsync")
      && !postprocessor.startsWith("musetalk")
      && !postprocessor.startsWith("lipforcing"),
    ...gatesFor(variant, postprocessor),
    rights,
    targetStatus: rights.status === "blocked" ? "blocked" : "candidate",
  };
}

export function deriveReleaseSurfaceEntries(): ReleaseSurfaceEntry[] {
  const entries: ReleaseSurfaceEntry[] = [];
  for (const variant of baseVariants()) {
    entries.push(entryFor(variant, "none"));
    if (variant.mode === "text-to-audio") continue;
    if (["image-audio-to-video", "audio-to-video"].includes(variant.mode)) {
      entries.push(entryFor(variant, "longcat-lipsync"));
    }
    entries.push(entryFor(variant, "latentsync-1.6"));
    entries.push(entryFor(variant, "musetalk-1.5"));
    entries.push(entryFor(variant, "lipforcing-14b-wan-vae"));
    entries.push(entryFor(variant, "lipforcing-14b-streaming-taehv"));
  }
  return entries.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}
