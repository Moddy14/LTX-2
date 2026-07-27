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
    mapAffricatesAtomically: z.literal(true),
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

const measurementArtifactSchema = z.object({
  path: relativeArtifactPathSchema,
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive().max(8 * 1024 ** 3),
  kind: z.enum([
    "mfa-executable",
    "mfa-acoustic-model",
    "mfa-dictionary",
    "mfa-g2p-model",
    "mediapipe-face-landmarker",
    "viseme-mapping",
  ]),
  upstreamUrl: z.string().url().max(1_000),
  revision: z.string().min(1).max(200),
  licenseEvidenceIds: z.array(releaseIdSchema).min(1).max(20),
}).strict();

const legalEvidenceSchema = z.object({
  evidenceId: releaseIdSchema,
  subject: z.string().min(1).max(200),
  path: relativeArtifactPathSchema,
  sha256: sha256Schema,
  upstreamUrl: z.string().url().max(1_000),
  revision: z.string().min(1).max(200),
  evidenceType: z.enum([
    "code-license",
    "model-license",
    "model-card",
    "notice",
    "attribution",
    "training-data-provenance",
    "biometric-processing-approval",
  ]),
  commercialUseReviewed: z.boolean(),
  biometricProcessingReviewed: z.boolean(),
}).strict();

const measurementOnlyManifestSchema = z.object({
  schemaVersion: z.literal("ltx-studio-phoneme-viseme-manifest.v2"),
  releaseId: releaseIdSchema,
  method: z.literal("mfa-mediapipe-de.v1"),
  productGo: z.object({
    status: z.literal("blocked"),
    reason: z.string().min(1).max(500),
    candidateCreatedAt: z.string().datetime({ offset: true }),
  }).strict(),
  preprocessing: z.object({
    version: z.literal("mfa-mediapipe-de-pts.v1"),
    maxSeconds: z.literal(5),
    frameRates: z.tuple([z.literal(24), z.literal(25), z.literal(30)]),
  }).strict(),
  evidencePolicy: z.object({
    minimumSampledFrames: z.number().int().min(24).max(300),
    minimumUsableDurationSeconds: z.number().finite().min(1).max(5),
    minimumFaceTrackCoverage: z.number().finite().min(0.5).max(1),
    minimumMouthTrackCoverage: z.number().finite().min(0.5).max(1),
    maximumMultiFaceFrameRatio: z.number().finite().min(0).max(0.2),
    minimumPhoneCoverage: z.number().finite().min(0.5).max(1),
    requireNoUnknownPhones: z.literal(true),
    minimumMedianBlurVariance: z.number().finite().min(0).max(10_000),
    maximumYawP95Degrees: z.number().finite().min(0).max(90),
    maximumPitchP95Degrees: z.number().finite().min(0).max(90),
  }).strict(),
  visemeMap: z.object({
    version: z.literal("viseme15-en-de.v1"),
    classCount: z.literal(15),
    path: relativeArtifactPathSchema,
    sha256: sha256Schema,
  }).strict(),
  runtime: z.object({
    pythonVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    mfaVersion: z.literal("3.3.9"),
    mediaPipeVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    openCvVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    numpyVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    ffmpegVersion: z.string().min(1).max(100),
    ffmpegSha256: sha256Schema,
    ffprobeSha256: sha256Schema,
    cpuOnly: z.literal(true),
  }).strict(),
  components: z.object({
    mfaExecutable: measurementArtifactSchema,
    acousticModel: measurementArtifactSchema,
    dictionary: measurementArtifactSchema,
    g2pModel: measurementArtifactSchema.nullable(),
    faceLandmarker: measurementArtifactSchema,
    visemeMapping: measurementArtifactSchema,
  }).strict(),
  legalApproval: z.object({
    evidenceId: releaseIdSchema,
    reviewedBy: z.string().min(3).max(200),
    reviewedAt: z.string().datetime({ offset: true }),
    policyVersion: z.literal("ltx-studio-evaluator-legal.v1"),
    scope: z.literal("commercial-biometric-measurement-only"),
  }).strict(),
  legalEvidence: z.array(legalEvidenceSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const expectedKinds = {
    mfaExecutable: "mfa-executable",
    acousticModel: "mfa-acoustic-model",
    dictionary: "mfa-dictionary",
    g2pModel: "mfa-g2p-model",
    faceLandmarker: "mediapipe-face-landmarker",
    visemeMapping: "viseme-mapping",
  } as const;
  for (const [key, expected] of Object.entries(expectedKinds)) {
    const component = value.components[key as keyof typeof value.components];
    if (component !== null && component.kind !== expected) {
      context.addIssue({
        code: "custom",
        path: ["components", key, "kind"],
        message: `${key} muss als ${expected} deklariert sein.`,
      });
    }
  }
  if (value.components.visemeMapping.path !== value.visemeMap.path
    || value.components.visemeMapping.sha256 !== value.visemeMap.sha256) {
    context.addIssue({
      code: "custom",
      path: ["components", "visemeMapping"],
      message: "Visem-Mapping muss mit dem manifestweiten Mapping identisch gebunden sein.",
    });
  }
  const evidenceIds = value.legalEvidence.map((entry) => entry.evidenceId);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    context.addIssue({
      code: "custom",
      path: ["legalEvidence"],
      message: "Lizenzbeleg-IDs müssen eindeutig sein.",
    });
  }
  const evidenceIdSet = new Set(evidenceIds);
  const evidenceById = new Map(value.legalEvidence.map((entry) => [entry.evidenceId, entry]));
  const approval = evidenceById.get(value.legalApproval.evidenceId);
  if (!approval
    || approval.evidenceType !== "biometric-processing-approval") {
    context.addIssue({
      code: "custom",
      path: ["legalApproval", "evidenceId"],
      message: "Legal Approval muss auf einen vollständigen biometrischen Freigabebeleg zeigen.",
    });
  }
  for (const [key, component] of Object.entries(value.components)) {
    if (component === null) continue;
    for (const evidenceId of component.licenseEvidenceIds) {
      if (!evidenceIdSet.has(evidenceId)) {
        context.addIssue({
          code: "custom",
          path: ["components", key, "licenseEvidenceIds"],
          message: `Unbekannter Lizenzbeleg ${evidenceId}.`,
        });
      }
    }
    const evidenceTypes = new Set(component.licenseEvidenceIds
      .map((evidenceId) => evidenceById.get(evidenceId)?.evidenceType)
      .filter((entry) => entry !== undefined));
    const requiredTypes = key === "mfaExecutable" || key === "visemeMapping"
      ? ["code-license"]
      : ["model-license", "model-card", "training-data-provenance"];
    for (const requiredType of requiredTypes) {
      if (!evidenceTypes.has(requiredType as typeof value.legalEvidence[number]["evidenceType"])) {
        context.addIssue({
          code: "custom",
          path: ["components", key, "licenseEvidenceIds"],
          message: `${key} benötigt einen Beleg vom Typ ${requiredType}.`,
        });
      }
    }
    if (!component.licenseEvidenceIds.includes(value.legalApproval.evidenceId)) {
      context.addIssue({
        code: "custom",
        path: ["components", key, "licenseEvidenceIds"],
        message: `${key} muss an das externe Legal Approval gebunden sein.`,
      });
    }
  }
});

export const phonemeVisemeEvaluatorManifestSchema = z.union([
  blockedManifestSchema,
  releaseCandidateManifestSchema,
  measurementOnlyManifestSchema,
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
  "product-go-pending",
  "measurement-insufficient",
  "evaluator-failed",
  "not-applicable",
]);

export const mfaMediaPipeMeasurementSchema = z.object({
  method: z.literal("mfa-mediapipe-de.v1"),
  runnerFingerprint: sha256Schema,
  expectedDialogueSha256: sha256Schema,
  globalAvLagMilliseconds: z.number().int().min(-500).max(500).nullable(),
  lagConfidence: z.number().finite().min(0).max(1).nullable(),
  bilabialClosureF1: z.number().finite().min(0).max(1).nullable(),
  openingCorrelation: z.number().finite().min(-1).max(1).nullable(),
  roundingCorrelation: z.number().finite().min(-1).max(1).nullable(),
  speechMotionRecall: z.number().finite().min(0).max(1).nullable(),
  pauseLeakRatio: z.number().finite().min(0).max(1).nullable(),
  phoneCoverage: z.number().finite().min(0).max(1),
  unknownPhones: z.array(z.string().min(1).max(32)).max(100),
  faceTrackCoverage: z.number().finite().min(0).max(1),
  mouthTrackCoverage: z.number().finite().min(0).max(1),
  multiFaceFrameRatio: z.number().finite().min(0).max(1),
  medianBlurVariance: z.number().finite().min(0).nullable(),
  yawP95Degrees: z.number().finite().min(0).max(180).nullable(),
  pitchP95Degrees: z.number().finite().min(0).max(180).nullable(),
  usableDurationSeconds: z.number().finite().min(0).max(5),
  sampledFrames: z.number().int().min(0).max(300),
}).strict();

export type MfaMediaPipeMeasurement = z.infer<typeof mfaMediaPipeMeasurementSchema>;

export const mfaMediaPipeRunnerOutputSchema = z.object({
  schemaVersion: z.literal("ltx-studio-mfa-mediapipe-runner.v1"),
  status: z.enum(["measurement-only", "insufficient", "failed"]),
  error: z.string().min(1).max(500),
  manifestReleaseId: releaseIdSchema,
  manifestSha256: sha256Schema,
  preprocessingVersion: z.literal("mfa-mediapipe-de-pts.v1"),
  visemeMapVersion: z.literal("viseme15-en-de.v1"),
  offset: z.object({
    status: z.enum(["measured", "insufficient", "not-run"]),
    estimatedOffsetMilliseconds: z.number().int().min(-500).max(500).nullable(),
    confidence: z.number().finite().min(0).max(1).nullable(),
  }).strict(),
  measurement: mfaMediaPipeMeasurementSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.measurement
    && (value.offset.estimatedOffsetMilliseconds !== value.measurement.globalAvLagMilliseconds
      || value.offset.confidence !== value.measurement.lagConfidence)) {
    context.addIssue({
      code: "custom",
      path: ["offset"],
      message: "Offsetstufe und MFA/MediaPipe-Rohmessung müssen dieselbe Lag-Messung ausweisen.",
    });
  }
  if (value.offset.status === "measured"
    && (value.offset.estimatedOffsetMilliseconds === null || value.offset.confidence === null)) {
    context.addIssue({
      code: "custom",
      path: ["offset"],
      message: "Eine gemessene Offsetstufe benötigt Versatz und Konfidenz.",
    });
  }
  if (value.status === "measurement-only") {
    if (value.measurement === null
      || !["measured", "insufficient"].includes(value.offset.status)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Measurement-only benötigt Rohmetriken und eine ausgeführte Offsetstufe.",
      });
    }
    return;
  }
  if (value.status === "insufficient") {
    if (value.measurement !== null
      && !["measured", "insufficient"].includes(value.offset.status)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Unzureichende Rohmessung benötigt eine ausgeführte Offsetstufe.",
      });
    }
    if (value.measurement === null && value.offset.status !== "not-run") {
      context.addIssue({
        code: "custom",
        path: ["offset"],
        message: "Ohne Rohmetriken darf keine Offsetstufe behauptet werden.",
      });
    }
    return;
  }
  if (value.measurement !== null || value.offset.status !== "not-run") {
    context.addIssue({
      code: "custom",
      path: ["status"],
      message: "Fehlgeschlagene oder unzureichende Runner dürfen keine Messwerte behaupten.",
    });
  }
});

export type MfaMediaPipeRunnerOutput = z.infer<typeof mfaMediaPipeRunnerOutputSchema>;

const phonemeVisemeResultBaseSchema = z.object({
  status: z.enum(["measured", "measurement-only", "insufficient", "failed", "not-available", "not-applicable"]),
  blockerCode: phonemeVisemeBlockerCodeSchema,
  error: z.string().min(1).max(500).nullable(),
  manifestReleaseId: releaseIdSchema.nullable(),
  manifestSha256: sha256Schema.nullable(),
  preprocessingVersion: z.enum([
    "mouth-npz-rgb96-audio-wav16k-cfr.v2",
    "mfa-mediapipe-de-pts.v1",
  ]).nullable(),
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
  measurement: mfaMediaPipeMeasurementSchema.nullable().optional(),
}).strict();

export const phonemeVisemeResultSchema = phonemeVisemeResultBaseSchema.superRefine((value, context) => {
  if (value.manifestReleaseId !== null && value.manifestSha256 === null) {
    context.addIssue({
      code: "custom",
      path: ["manifestSha256"],
      message: "Ein Manifest-Release benötigt den zugehörigen Manifest-Hash.",
    });
  }
  if (!["measured", "measurement-only"].includes(value.status) && value.productGo.status !== "blocked") {
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
    && value.status !== "measurement-only"
    && !(value.status === "insufficient" && value.measurement)
    && (value.offset.status === "measured" || value.content.status === "measured")) {
    context.addIssue({
      code: "custom",
      path: ["productGo"],
      message: "Blockierte Gewichte dürfen keine Stufenmessung ausführen.",
    });
  }
  if (value.status === "measurement-only") {
    if (value.productGo.status !== "blocked"
      || value.blockerCode !== "product-go-pending"
      || value.measurement === null
      || value.measurement === undefined
      || value.error === null
      || (value.offset.status !== "measured" && value.offset.status !== "insufficient")
      || value.offset.gatePassed
      || value.content.status !== "insufficient"
      || value.content.gatePassed
      || value.content.frameMacroF1 !== null
      || value.content.transitionF1 !== null
      || value.gateVersion !== null) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Measurement-only benötigt echte MFA/MediaPipe-Rohmessung und einen explizit blockierten Product-GO.",
      });
    }
    return;
  }
  if (value.status === "insufficient" && value.measurement) {
    if (value.productGo.status !== "blocked"
      || value.blockerCode !== "measurement-insufficient"
      || value.error === null
      || value.offset.gatePassed
      || !["measured", "insufficient"].includes(value.offset.status)
      || value.content.status !== "insufficient"
      || value.content.gatePassed
      || value.content.frameMacroF1 !== null
      || value.content.transitionF1 !== null
      || value.gateVersion !== null) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Unzureichende MFA/MediaPipe-Rohmessung muss Product-GO und alle Inhaltsgates blockieren.",
      });
    }
    return;
  }
  if (value.measurement !== null && value.measurement !== undefined && value.status !== "measured") {
    context.addIssue({
      code: "custom",
      path: ["measurement"],
      message: "MFA/MediaPipe-Rohmetriken sind nur bei measurement-only oder gemessen zulässig.",
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
