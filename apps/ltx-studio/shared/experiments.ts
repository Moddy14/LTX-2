import { z } from "zod";

import {
  defaultLipForcingRawOutputProfile,
  experimentalLipForcingRawOutputProfile,
  generationRequestSchema,
  hasDialogueIntent,
  isAudioConditionedMode,
  outputNameSchema,
  positivePromptSchema,
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
    variable: z.literal("positive-prompt"),
    value: positivePromptSchema,
  }).strict(),
  z.object({
    variable: z.literal("lipdub-reference-strength"),
    value: z.number().finite().min(0).max(2),
  }).strict(),
  z.object({
    variable: z.literal("lipforcing-enabled"),
  }).strict(),
  z.object({
    variable: z.literal("lipforcing-decoder"),
    value: z.enum(["wan-vae", "streaming-taehv"]),
  }).strict(),
  z.object({
    variable: z.literal("lipforcing-raw-output-profile"),
  }).strict(),
  z.object({
    variable: z.literal("lipforcing-mouth-delay-ms"),
    value: z.number().int().min(-500).max(500),
  }).strict(),
  z.object({
    variable: z.literal("lipforcing-program-audio-delay-ms"),
    value: z.number().int().min(-500).max(500),
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

/**
 * The official split-pack IA2V workflow is intentionally guidance-free: both
 * stages use SimpleDenoiser and therefore do not consume MultiModalGuider
 * parameters. Only the non-official audio-to-video path currently binds the
 * A2V guidance value to executable Python semantics.
 */
export function supportsA2vGuidanceExperiment(
  request: Pick<GenerationRequest, "mode">,
): boolean {
  return request.mode === "audio-to-video";
}

/**
 * Prompt ablations are released narrowly for the official LTX-2.5 split IA2V
 * command whose two-stage runtime demonstrably consumes `request.prompt`.
 * Other modes may map or ignore prompt text differently and must earn their
 * own executable-variable contract before this selector is widened.
 */
export function supportsPositivePromptExperiment(
  request: Pick<GenerationRequest, "mode" | "models">,
): boolean {
  return request.mode === "image-audio-to-video"
    && request.models.generation === "2.5"
    && request.models.layout === "split";
}

export function availableExperimentVariables(request: GenerationRequest): ExperimentVariableId[] {
  const variables: ExperimentVariableId[] = ["replicate-seed", "resolution"];
  if (supportsPositivePromptExperiment(request)) variables.push("positive-prompt");
  if (supportsA2vGuidanceExperiment(request)) variables.unshift("a2v-guidance");
  if (request.images[0]) variables.push("reference-image-strength", "reference-image-crf");
  if (request.mode === "lipdub") variables.unshift("lipdub-reference-strength");
  if (
    (
      hasDialogueIntent(request)
      || isAudioConditionedMode(request.mode)
      || request.mode === "id-lora"
    )
    && !request.postprocess.longcatLipsync.enabled
    && !request.postprocess.latentSync.enabled
    && !request.postprocess.museTalk.enabled
    && !request.postprocess.lipForcing.enabled
  ) {
    variables.push("lipforcing-enabled");
  }
  if (request.postprocess.lipForcing.enabled) {
    variables.push(
      "lipforcing-decoder",
      "lipforcing-mouth-delay-ms",
      "lipforcing-program-audio-delay-ms",
    );
    if (
      request.postprocess.lipForcing.rawOutputProfile === defaultLipForcingRawOutputProfile
      && rawMuxPairV1BaselineError(request) === null
    ) {
      variables.push("lipforcing-raw-output-profile");
    }
  }
  return variables;
}

export const experimentCreateInputSchema = z.object({
  title: z.string().trim().min(1).max(120).refine((value) => !value.includes("\0"), {
    message: "NUL-Zeichen sind nicht erlaubt.",
  }),
  baselineRequest: generationRequestSchema,
  baselineOutputName: outputNameSchema.optional(),
  candidate: experimentCandidateSchema,
}).strict().superRefine((value, context) => {
  if (experimentRequiresFreshBaseline(value.candidate) && value.baselineOutputName !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["baselineOutputName"],
      message: "Dieses Experiment benötigt einen frischen Baseline-Arm mit identischen Ausführungsinputs, Code und Runtime.",
    });
  }
});

export type ExperimentCreateInput = z.infer<typeof experimentCreateInputSchema>;

export function experimentRequiresFreshBaseline(candidate: ExperimentCandidate): boolean {
  return candidate.variable === "lipforcing-raw-output-profile"
    || candidate.variable === "positive-prompt";
}

export function rawMuxPairV1BaselineError(request: GenerationRequest): string | null {
  if (!request.postprocess.lipForcing.enabled) {
    return "Das gepaarte Rohvideo-Experiment benötigt aktives LipForcing.";
  }
  if (request.postprocess.lipForcing.rawOutputProfile !== defaultLipForcingRawOutputProfile) {
    return "Das gepaarte Rohvideo-Experiment benötigt das registrierte CRF18-Baseline-Profil.";
  }
  if (request.postprocess.longcatLipsync.enabled
    || request.postprocess.latentSync.enabled
    || request.postprocess.museTalk.enabled) {
    return "Raw-Mux-Paar v1 erlaubt neben LipForcing keinen weiteren Lippenrefiner.";
  }
  if (request.audio.finalMix.path) {
    return "Raw-Mux-Paar v1 erlaubt keinen nachgelagerten FinalMix; beide Arme müssen direkt aus derselben Timeline stammen.";
  }
  const explicitSpeechPath = isAudioConditionedMode(request.mode)
    ? request.audio.path
    : request.mode === "lipdub" ? request.lipDub.referenceVideo.path : "";
  if (!explicitSpeechPath) {
    return "Raw-Mux-Paar v1 benötigt eine explizite, in beiden Armen identische LipForcing-Sprachspur.";
  }
  return null;
}

export function rawMuxPairV1CandidateError(request: GenerationRequest): string | null {
  if (request.postprocess.lipForcing.rawOutputProfile !== experimentalLipForcingRawOutputProfile) {
    return "Das gepaarte Rohvideo-Experiment benötigt das registrierte Mux-copy-Kandidatenprofil.";
  }
  const baselineShape = structuredClone(request);
  baselineShape.postprocess.lipForcing.rawOutputProfile = defaultLipForcingRawOutputProfile;
  return rawMuxPairV1BaselineError(baselineShape);
}

export const experimentBaselineEvidenceSchema = z.object({
  outputName: outputNameSchema,
  jobId: z.string().uuid(),
  sizeBytes: z.number().int().positive(),
  changedAt: timestampSchema,
  fileId: z.string().regex(/^\d{1,64}$/),
  provenanceFingerprint: sha256Schema,
}).strict();

export type ExperimentBaselineEvidence = z.infer<typeof experimentBaselineEvidenceSchema>;

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
  status: z.enum(["draft", "frozen", "superseded"]),
  kind: z.enum(["ablation", "replicate"]),
  candidate: experimentCandidateSchema,
  changedRequestPaths: z.array(z.string().min(1).max(240)).min(1).max(8),
  createdAt: timestampSchema,
  frozenAt: timestampSchema.nullable(),
  supersededAt: timestampSchema.nullable().default(null),
  supersededReason: z.string().trim().min(1).max(500).nullable().default(null),
  replacementExperimentId: z.string().uuid().nullable().default(null),
  baselineEvidence: experimentBaselineEvidenceSchema.nullable().default(null),
  protocolSha256: sha256Schema.nullable(),
  arms: z.tuple([
    experimentRunArmSchema.extend({ arm: z.literal("baseline") }),
    experimentRunArmSchema.extend({ arm: z.literal("candidate") }),
  ]),
}).strict().superRefine((value, context) => {
  if (experimentRequiresFreshBaseline(value.candidate) && value.baselineEvidence !== null) {
    context.addIssue({
      code: "custom",
      path: ["baselineEvidence"],
      message: "Dieses Experiment erlaubt ausschließlich einen frischen Baseline-Arm mit identischen Ausführungsinputs, Code und Runtime.",
    });
  }
  if (value.status === "superseded") {
    if (!value.supersededAt || !value.supersededReason) {
      context.addIssue({
        code: "custom",
        path: ["supersededAt"],
        message: "Ein stillgelegtes Experiment benötigt Zeitpunkt und Begründung.",
      });
    }
  } else if (
    value.supersededAt !== null
    || value.supersededReason !== null
    || value.replacementExperimentId !== null
  ) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Nur stillgelegte Experimente dürfen Stilllegungsmetadaten tragen.",
    });
  }
});

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
  adoptedBaseline: z.literal(true).optional(),
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

export function isAdoptedLipForcingCandidate(
  binding: ExperimentRunBinding | null | undefined,
): boolean {
  return binding?.arm === "candidate"
    && binding.adoptedBaseline === true
    && binding.variableId === "lipforcing-enabled"
    && binding.changedRequestPaths.length === 1
    && binding.changedRequestPaths[0] === "postprocess.lipForcing.enabled";
}

export const experimentVariableLabels: Record<ExperimentVariableId, string> = {
  "a2v-guidance": "A2V Guidance",
  "reference-image-strength": "Referenzbildstärke",
  "reference-image-crf": "Referenzbild-CRF",
  "positive-prompt": "Positive Beschreibung",
  "lipdub-reference-strength": "LipDub-Referenzstärke",
  "lipforcing-enabled": "LipForcing an",
  "lipforcing-decoder": "LipForcing: Decoder",
  "lipforcing-raw-output-profile": "LipForcing: Rohvideo-Mux",
  "lipforcing-mouth-delay-ms": "LipForcing: Modell-Steuerung (ms)",
  "lipforcing-program-audio-delay-ms": "LipForcing: hörbarer Tonversatz (ms)",
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
    case "positive-prompt":
      return ["prompt"];
    case "lipdub-reference-strength":
      return ["lipDub.referenceVideo.strength"];
    case "lipforcing-enabled":
      return ["postprocess.lipForcing.enabled"];
    case "lipforcing-decoder":
      return ["postprocess.lipForcing.decoder"];
    case "lipforcing-raw-output-profile":
      return ["postprocess.lipForcing.rawOutputProfile"];
    case "lipforcing-mouth-delay-ms":
      return ["postprocess.lipForcing.mouthDelayMs"];
    case "lipforcing-program-audio-delay-ms":
      return ["postprocess.lipForcing.programAudioDelayMs"];
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
      if (!isAudioConditionedMode(request.mode)) {
        throw new Error(
          "A2V Guidance ist nur für Audio zu Video als kontrollierte Variable zulässig.",
        );
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
    case "positive-prompt":
      request.prompt = candidate.value;
      break;
    case "lipdub-reference-strength":
      if (request.mode !== "lipdub") {
        throw new Error("LipDub-Referenzstärke ist nur im LipDub-Modus zulässig.");
      }
      request.lipDub.referenceVideo.strength = candidate.value;
      break;
    case "lipforcing-enabled":
      if (
        request.postprocess.longcatLipsync.enabled
        || request.postprocess.latentSync.enabled
        || request.postprocess.museTalk.enabled
        || request.postprocess.lipForcing.enabled
      ) {
        throw new Error("Der LipForcing-Vergleich benötigt eine Baseline ohne aktiven Lippenrefiner.");
      }
      request.postprocess.lipForcing.enabled = true;
      break;
    case "lipforcing-decoder": {
      if (!request.postprocess.lipForcing.enabled) {
        throw new Error("Der LipForcing-Decoder ist nur bei aktivem LipForcing als kontrollierte Variable zulässig.");
      }
      const alternate = request.postprocess.lipForcing.decoder === "wan-vae"
        ? "streaming-taehv"
        : "wan-vae";
      if (candidate.value !== alternate) {
        throw new Error("Der LipForcing-Decoder-Kandidat muss exakt der alternative Decoder der Baseline sein.");
      }
      request.postprocess.lipForcing.decoder = candidate.value;
      break;
    }
    case "lipforcing-raw-output-profile":
      {
        const rawMuxPairError = rawMuxPairV1BaselineError(request);
        if (rawMuxPairError) throw new Error(rawMuxPairError);
      }
      request.postprocess.lipForcing.rawOutputProfile = experimentalLipForcingRawOutputProfile;
      break;
    case "lipforcing-mouth-delay-ms":
      if (!request.postprocess.lipForcing.enabled) {
        throw new Error("Die LipForcing-Modell-Steuerung ist nur bei aktivem LipForcing zulässig.");
      }
      request.postprocess.lipForcing.mouthDelayMs = candidate.value;
      break;
    case "lipforcing-program-audio-delay-ms":
      if (!request.postprocess.lipForcing.enabled) {
        throw new Error("Der hörbare LipForcing-Tonversatz ist nur bei aktivem LipForcing zulässig.");
      }
      request.postprocess.lipForcing.programAudioDelayMs = candidate.value;
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
