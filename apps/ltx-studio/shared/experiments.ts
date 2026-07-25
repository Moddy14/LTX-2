import { z } from "zod";

import {
  generationRequestSchema,
  type GenerationRequest,
} from "./pipelines.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const experimentCandidateSchema = z.discriminatedUnion("variable", [
  z.object({
    variable: z.literal("a2v-guidance"),
    value: z.number().finite().min(0).max(20),
  }).strict(),
  z.object({
    variable: z.literal("reference-image-strength"),
    value: z.number().finite().min(0).max(1),
  }).strict(),
  z.object({
    variable: z.literal("reference-image-crf"),
    value: z.number().int().min(0).max(51),
  }).strict(),
  z.object({
    variable: z.literal("lipdub-reference-strength"),
    value: z.number().finite().min(0).max(2),
  }).strict(),
  z.object({
    variable: z.literal("replicate-seed"),
    value: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    variable: z.literal("resolution"),
    width: z.number().int().min(64).max(4096),
    height: z.number().int().min(64).max(4096),
  }).strict(),
]);

export type ExperimentCandidate = z.infer<typeof experimentCandidateSchema>;
export type ExperimentVariableId = ExperimentCandidate["variable"];
export type ExperimentKind = "ablation" | "replicate";

export const experimentCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(120).refine((value) => !value.includes("\0"), {
    message: "NUL-Zeichen sind nicht erlaubt.",
  }),
  baselineRequest: generationRequestSchema,
  candidate: experimentCandidateSchema,
}).strict();

export type ExperimentCreateInput = z.infer<typeof experimentCreateInputSchema>;

export const experimentRunArmSchema = z.object({
  arm: z.enum(["baseline", "candidate"]),
  request: generationRequestSchema,
  requestSha256: sha256Schema,
  settingsSha256: sha256Schema,
  jobId: z.string().uuid().nullable(),
  attemptJobIds: z.array(z.string().uuid()).max(32).default([]),
}).strict();

export const controlledExperimentSchema = z.object({
  schemaVersion: z.literal("ltx-studio-experiment.v1"),
  id: z.string().uuid(),
  title: z.string().trim().min(1).max(120),
  claimScope: z.literal("development"),
  status: z.enum(["draft", "frozen"]),
  kind: z.enum(["ablation", "replicate"]),
  candidate: experimentCandidateSchema,
  changedRequestPaths: z.array(z.string().min(1).max(240)).min(1).max(8),
  createdAt: timestampSchema,
  frozenAt: timestampSchema.nullable(),
  protocolSha256: sha256Schema.nullable(),
  arms: z.tuple([
    experimentRunArmSchema.extend({ arm: z.literal("baseline") }),
    experimentRunArmSchema.extend({ arm: z.literal("candidate") }),
  ]),
}).strict();

export type ControlledExperiment = z.infer<typeof controlledExperimentSchema>;

export const experimentRunBindingSchema = z.object({
  schemaVersion: z.literal("ltx-studio-experiment-run.v1"),
  experimentId: z.string().uuid(),
  protocolSha256: sha256Schema,
  arm: z.enum(["baseline", "candidate"]),
  kind: z.enum(["ablation", "replicate"]),
  variableId: z.string().min(1).max(80),
  changedRequestPaths: z.array(z.string().min(1).max(240)).min(1).max(8),
  baselineRequestSha256: sha256Schema,
  requestSha256: sha256Schema,
  baselineJobId: z.string().uuid().nullable(),
  baselineOutputName: z.string().min(1).max(120),
}).strict().superRefine((value, context) => {
  if (value.arm === "candidate" && !value.baselineJobId) {
    context.addIssue({
      code: "custom",
      path: ["baselineJobId"],
      message: "Der Kandidatenarm benötigt den gebundenen Baseline-Job.",
    });
  }
  if (value.arm === "baseline" && value.baselineJobId) {
    context.addIssue({
      code: "custom",
      path: ["baselineJobId"],
      message: "Der Baseline-Arm darf keinen fremden Baseline-Job referenzieren.",
    });
  }
});

export type ExperimentRunBinding = z.infer<typeof experimentRunBindingSchema>;

export const experimentVariableLabels: Record<ExperimentVariableId, string> = {
  "a2v-guidance": "A2V Guidance",
  "reference-image-strength": "Referenzbildstärke",
  "reference-image-crf": "Referenzbild-CRF",
  "lipdub-reference-strength": "LipDub-Referenzstärke",
  "replicate-seed": "Seed-Replikat",
  resolution: "Auflösung",
};

export function experimentKind(candidate: ExperimentCandidate): ExperimentKind {
  return candidate.variable === "replicate-seed" ? "replicate" : "ablation";
}

export function allowedExperimentPaths(candidate: ExperimentCandidate): string[] {
  switch (candidate.variable) {
    case "a2v-guidance":
      return ["videoGuidance.modalityScale"];
    case "reference-image-strength":
      return ["images[0].strength"];
    case "reference-image-crf":
      return ["images[0].crf"];
    case "lipdub-reference-strength":
      return ["lipDub.referenceVideo.strength"];
    case "replicate-seed":
      return ["seed"];
    case "resolution":
      return ["height", "width"];
  }
}

export function applyExperimentCandidate(
  baseline: GenerationRequest,
  candidate: ExperimentCandidate,
): GenerationRequest {
  const request = structuredClone(generationRequestSchema.parse(baseline));
  switch (candidate.variable) {
    case "a2v-guidance":
      if (request.mode !== "audio-to-video") {
        throw new Error("A2V Guidance ist nur für Audio zu Video als kontrollierte Variable zulässig.");
      }
      request.videoGuidance.modalityScale = candidate.value;
      break;
    case "reference-image-strength":
      if (!request.images[0]) throw new Error("Die Ablation benötigt ein erstes Referenzbild.");
      request.images[0].strength = candidate.value;
      break;
    case "reference-image-crf":
      if (!request.images[0]) throw new Error("Die Ablation benötigt ein erstes Referenzbild.");
      request.images[0].crf = candidate.value;
      break;
    case "lipdub-reference-strength":
      if (request.mode !== "lipdub") {
        throw new Error("LipDub-Referenzstärke ist nur im LipDub-Modus zulässig.");
      }
      request.lipDub.referenceVideo.strength = candidate.value;
      break;
    case "replicate-seed":
      request.seed = candidate.value;
      break;
    case "resolution":
      request.width = candidate.width;
      request.height = candidate.height;
      break;
  }
  return generationRequestSchema.parse(request);
}

function requestDiff(
  left: unknown,
  right: unknown,
  path: string,
  target: string[],
): void {
  if (Object.is(left, right)) return;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      target.push(path);
      return;
    }
    left.forEach((item, index) => requestDiff(item, right[index], `${path}[${index}]`, target));
    return;
  }
  if (
    left !== null
    && right !== null
    && typeof left === "object"
    && typeof right === "object"
    && !Array.isArray(left)
    && !Array.isArray(right)
  ) {
    const keys = [...new Set([
      ...Object.keys(left as Record<string, unknown>),
      ...Object.keys(right as Record<string, unknown>),
    ])].sort();
    for (const key of keys) {
      requestDiff(
        (left as Record<string, unknown>)[key],
        (right as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
        target,
      );
    }
    return;
  }
  target.push(path);
}

export function generationRequestDiffPaths(
  left: GenerationRequest,
  right: GenerationRequest,
): string[] {
  const paths: string[] = [];
  requestDiff(left, right, "", paths);
  return paths.filter(Boolean).sort();
}

export function controlledExperimentDiffPaths(
  baseline: GenerationRequest,
  candidateRequest: GenerationRequest,
): string[] {
  return generationRequestDiffPaths(baseline, candidateRequest)
    .filter((path) => path !== "outputName");
}

export function validateControlledExperimentDifference(
  baseline: GenerationRequest,
  candidateRequest: GenerationRequest,
  candidate: ExperimentCandidate,
): string[] {
  const changed = controlledExperimentDiffPaths(baseline, candidateRequest);
  const allowed = new Set(allowedExperimentPaths(candidate));
  if (changed.length === 0) throw new Error("Die kontrollierte Variable ändert den Baseline-Request nicht.");
  const unexpected = changed.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(`Nicht freigegebene Request-Änderung: ${unexpected.join(", ")}.`);
  }
  return changed;
}
