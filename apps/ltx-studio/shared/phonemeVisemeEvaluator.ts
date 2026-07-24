import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const releaseIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{2,79}$/);
const relativeArtifactPathSchema = z.string().min(1).max(500).refine(
  (value) => !value.startsWith("/")
    && !value.includes("\\")
    && !value.split("/").includes("..")
    && !value.split("/").includes("."),
  "Artefaktpfade müssen normalisierte relative Pfade sein.",
);

const artifactSchema = z.object({
  path: relativeArtifactPathSchema,
  sha256: sha256Schema,
  format: z.literal("onnx"),
  runtime: z.literal("cpu-onnx"),
}).strict();

const reportSchema = z.object({
  path: relativeArtifactPathSchema,
  sha256: sha256Schema,
}).strict();

const visemeClassSchema = z.object({
  id: z.number().int().min(0).max(14),
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,39}$/),
  phones: z.array(z.string().min(1).max(16)).min(1).max(100),
}).strict();

export const visemeMappingSchema = z.object({
  schemaVersion: z.literal("ltx-studio-viseme-mapping.v1"),
  mappingVersion: z.literal("viseme15-en-de.v1"),
  classCount: z.literal(15),
  languages: z.tuple([z.literal("de"), z.literal("en")]),
  normalization: z.object({
    unicodeForm: z.literal("NFC"),
    stripPrimaryAndSecondaryStress: z.literal(true),
    stripVowelLength: z.literal(true),
    expandAffricatesBeforeMapping: z.literal(true),
    frameAssignment: z.literal("phoneme active at video-frame center"),
    transitionDefinition: z.literal("class id changes between adjacent non-silence frame centers"),
    unknownPolicy: z.literal("quarantine"),
  }).strict(),
  classes: z.array(visemeClassSchema).length(15),
}).strict().superRefine((value, context) => {
  const ids = value.classes.map((entry) => entry.id);
  if (new Set(ids).size !== 15 || !ids.every((id, index) => id === index)) {
    context.addIssue({
      code: "custom",
      path: ["classes"],
      message: "Visemklassen müssen genau einmal und aufsteigend von 0 bis 14 vorkommen.",
    });
  }
  if (value.classes[0]?.code !== "SIL") {
    context.addIssue({
      code: "custom",
      path: ["classes", 0, "code"],
      message: "Klasse 0 muss SIL sein.",
    });
  }
  const phoneOwners = new Map<string, number>();
  value.classes.forEach((entry, classIndex) => {
    entry.phones.forEach((phone, phoneIndex) => {
      const owner = phoneOwners.get(phone);
      if (owner !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["classes", classIndex, "phones", phoneIndex],
          message: `Phone ${phone} ist bereits Klasse ${owner} zugeordnet.`,
        });
      } else {
        phoneOwners.set(phone, entry.id);
      }
    });
  });
});

export type VisemeMapping = z.infer<typeof visemeMappingSchema>;

const manifestBase = {
  schemaVersion: z.literal("ltx-studio-phoneme-viseme-manifest.v1"),
  releaseId: releaseIdSchema,
  preprocessing: z.object({
    version: z.literal("mouth-npz-rgb96-audio-wav16k-cfr.v2"),
    maxSeconds: z.literal(5),
    frameRates: z.tuple([z.literal(24), z.literal(25), z.literal(30)]),
  }).strict(),
  visemeMap: z.object({
    version: z.literal("viseme15-en-de.v1"),
    classCount: z.literal(15),
    path: relativeArtifactPathSchema,
    sha256: sha256Schema,
  }).strict(),
};

const legalGrantSchema = z.object({
  codeLicense: z.string().min(1).max(200),
  weightsLicense: z.string().min(1).max(200),
  trainingDataGrant: z.string().min(1).max(200),
  featureExtractionGrant: z.string().min(1).max(200),
  biometricProcessingGrant: z.string().min(1).max(200),
  derivedWeightsGrant: z.string().min(1).max(200),
  commercialUseGrant: z.string().min(1).max(200),
  redistributionGrant: z.string().min(1).max(200),
}).strict();

const blockedManifestSchema = z.object({
  ...manifestBase,
  productGo: z.object({
    status: z.literal("blocked"),
    reason: z.string().min(1).max(500),
    candidateCreatedAt: z.null(),
  }).strict(),
  legal: z.null(),
  artifacts: z.null(),
  calibration: z.null(),
  datasets: z.array(z.never()).max(0),
}).strict();

const releaseCandidateManifestSchema = z.object({
  ...manifestBase,
  productGo: z.object({
    status: z.literal("release-candidate"),
    reason: z.string().min(1).max(500),
    candidateCreatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  legal: legalGrantSchema,
  artifacts: z.object({
    offsetModel: artifactSchema,
    contentModel: artifactSchema,
  }).strict(),
  calibration: z.object({
    gateVersion: z.literal("ltx-pv-release-gates.v1"),
    tuneReport: reportSchema,
    holdoutReport: reportSchema,
  }).strict(),
  datasets: z.array(z.object({
    datasetId: releaseIdSchema,
    rightsGrantId: z.string().min(1).max(200),
    splitFreezeSha256: sha256Schema,
  }).strict()).min(1).max(100),
}).strict();

export const phonemeVisemeEvaluatorManifestSchema = z.union([
  blockedManifestSchema,
  releaseCandidateManifestSchema,
]);

export type PhonemeVisemeEvaluatorManifest = z.infer<typeof phonemeVisemeEvaluatorManifestSchema>;

const evaluatorStageSchema = z.object({
  status: z.enum(["measured", "insufficient", "failed", "not-run"]),
  gatePassed: z.boolean(),
}).strict();

export const phonemeVisemeBlockerCodeSchema = z.enum([
  "none",
  "manifest-missing",
  "legal-hold",
  "manifest-invalid",
  "artifact-invalid",
  "runner-unavailable",
  "measurement-insufficient",
  "evaluator-failed",
  "not-applicable",
]);

const phonemeVisemeResultBaseSchema = z.object({
  status: z.enum(["measured", "insufficient", "failed", "not-available", "not-applicable"]),
  blockerCode: phonemeVisemeBlockerCodeSchema,
  error: z.string().min(1).max(500).nullable(),
  manifestReleaseId: releaseIdSchema.nullable(),
  manifestSha256: sha256Schema.nullable(),
  preprocessingVersion: z.literal("mouth-npz-rgb96-audio-wav16k-cfr.v2").nullable(),
  visemeMapVersion: z.literal("viseme15-en-de.v1").nullable(),
  gateVersion: z.literal("ltx-pv-release-gates.v1").nullable(),
  productGo: z.object({
    status: z.enum(["passed", "blocked"]),
    reason: z.string().min(1).max(500),
  }).strict(),
  offset: evaluatorStageSchema.extend({
    estimatedOffsetMilliseconds: z.number().int().min(-500).max(500).nullable(),
    confidence: z.number().finite().min(0).max(1).nullable(),
  }).strict(),
  content: evaluatorStageSchema.extend({
    frameMacroF1: z.number().finite().min(0).max(1).nullable(),
    transitionF1: z.number().finite().min(0).max(1).nullable(),
  }).strict(),
}).strict();

export const phonemeVisemeResultSchema = phonemeVisemeResultBaseSchema.superRefine((value, context) => {
  if (value.manifestReleaseId !== null && value.manifestSha256 === null) {
    context.addIssue({
      code: "custom",
      path: ["manifestSha256"],
      message: "Ein Manifest-Release benötigt den zugehörigen Manifest-Hash.",
    });
  }
  if (value.status !== "measured" && value.productGo.status !== "blocked") {
    context.addIssue({
      code: "custom",
      path: ["productGo"],
      message: "Nur eine vollständig gemessene und bestandene Auswertung darf Product-GO tragen.",
    });
  }
  if (value.status === "measured" && value.blockerCode !== "none") {
    context.addIssue({
      code: "custom",
      path: ["blockerCode"],
      message: "Ein gemessenes Product-GO darf keinen Blocker tragen.",
    });
  }
  if (value.status !== "measured" && value.blockerCode === "none") {
    context.addIssue({
      code: "custom",
      path: ["blockerCode"],
      message: "Ein nicht gemessenes Ergebnis benötigt einen maschinenlesbaren Blocker.",
    });
  }
  if (value.productGo.status === "blocked"
    && (value.offset.status === "measured" || value.content.status === "measured")) {
    context.addIssue({
      code: "custom",
      path: ["productGo"],
      message: "Blockierte Gewichte dürfen keine Stufenmessung ausführen.",
    });
  }
  if (value.status !== "measured") {
    if (value.error === null) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Nicht gemessene Phonem-/Visem-Ergebnisse benötigen eine Erklärung.",
      });
    }
    return;
  }
  if (value.error !== null
    || value.productGo.status !== "passed"
    || value.manifestSha256 === null
    || value.preprocessingVersion === null
    || value.visemeMapVersion === null
    || value.gateVersion === null
    || value.offset.status !== "measured"
    || !value.offset.gatePassed
    || value.offset.estimatedOffsetMilliseconds === null
    || value.offset.confidence === null
    || value.content.status !== "measured"
    || !value.content.gatePassed
    || value.content.frameMacroF1 === null
    || value.content.transitionF1 === null) {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Gemessen erfordert Product-GO sowie bestandene Offset- und Inhaltsstufen.",
    });
  }
});

export type PhonemeVisemeResult = z.infer<typeof phonemeVisemeResultSchema>;
export type PhonemeVisemeBlockerCode = z.infer<typeof phonemeVisemeBlockerCodeSchema>;

export function unavailablePhonemeVisemeResult(
  reason = "Kein rechtlich freigegebener Phonem-/Visem-Evaluator konfiguriert.",
  blockerCode: Exclude<z.infer<typeof phonemeVisemeBlockerCodeSchema>, "none"> = "manifest-missing",
): PhonemeVisemeResult {
  return {
    status: "not-available",
    blockerCode,
    error: reason,
    manifestReleaseId: null,
    manifestSha256: null,
    preprocessingVersion: null,
    visemeMapVersion: null,
    gateVersion: null,
    productGo: { status: "blocked", reason },
    offset: {
      status: "not-run",
      gatePassed: false,
      estimatedOffsetMilliseconds: null,
      confidence: null,
    },
    content: {
      status: "not-run",
      gatePassed: false,
      frameMacroF1: null,
      transitionF1: null,
    },
  };
}
