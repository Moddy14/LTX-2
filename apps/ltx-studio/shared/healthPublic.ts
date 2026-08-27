import { z } from "zod";

const nullableResourceSchema = z.number().finite().nonnegative().nullable();

export const PUBLIC_JOB_PERSISTENCE_HOLD_CODE = "job_persistence_hold" as const;
export const PUBLIC_JOB_PERSISTENCE_HOLD_REASON =
  "Die dauerhafte Job- und Ausfuehrungsautoritaet konnte nicht sicher bestaetigt werden. Schreibende Aktionen bleiben bis zu einem Server-Neustart gesperrt." as const;

export const publicJobPersistenceHealthSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    restartRequired: z.literal(false),
  }).strict(),
  z.object({
    status: z.literal("hold"),
    restartRequired: z.literal(true),
    code: z.literal(PUBLIC_JOB_PERSISTENCE_HOLD_CODE),
    reason: z.literal(PUBLIC_JOB_PERSISTENCE_HOLD_REASON),
  }).strict(),
]);

export const publicJobPersistenceHoldErrorSchema = z.object({
  error: z.literal(PUBLIC_JOB_PERSISTENCE_HOLD_REASON),
  code: z.literal(PUBLIC_JOB_PERSISTENCE_HOLD_CODE),
  restartRequired: z.literal(true),
}).strict();

export type PublicJobPersistenceHealth = z.infer<typeof publicJobPersistenceHealthSchema>;
export type PublicJobPersistenceHoldError = z.infer<typeof publicJobPersistenceHoldErrorSchema>;

export function publicJobPersistenceHoldHealth(): PublicJobPersistenceHealth {
  return {
    status: "hold",
    restartRequired: true,
    code: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
    reason: PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
  };
}

export function publicJobPersistenceHoldError(): PublicJobPersistenceHoldError {
  return {
    error: PUBLIC_JOB_PERSISTENCE_HOLD_REASON,
    code: PUBLIC_JOB_PERSISTENCE_HOLD_CODE,
    restartRequired: true,
  };
}

export const publicT2aAudioEvaluatorBlockerCodeSchema = z.enum([
  "none",
  "development-runtime-unattested",
  "development-opt-in-required",
  "release-not-verified",
  "authority-isolation-unattested",
  "analysis-runtime-unavailable",
]);

export const publicT2aAudioEvaluatorCapabilitySchema = z.object({
  status: z.enum(["authoritative", "development-measurement", "blocked"]),
  claimScope: z.enum(["sealed-release", "development"]).nullable(),
  blockerCode: publicT2aAudioEvaluatorBlockerCodeSchema,
  message: z.string().min(1).max(1_024),
  productGo: z.literal("blocked"),
  measurementReady: z.boolean(),
}).strict().superRefine((value, context) => {
  const valid = value.status === "authoritative"
    ? value.claimScope === "sealed-release"
      && value.blockerCode === "none"
      && value.productGo === "blocked"
      && value.measurementReady
    : value.status === "development-measurement"
      ? value.claimScope === "development"
        && value.blockerCode === "development-runtime-unattested"
        && value.productGo === "blocked"
        && value.measurementReady
      : value.claimScope === null
        && !["none", "development-runtime-unattested"].includes(value.blockerCode)
        && value.productGo === "blocked"
        && !value.measurementReady;
  if (!valid) {
    context.addIssue({
      code: "custom",
      message: "T2A-Evaluatorstatus, Claim-Scope und Freigabe widersprechen einander.",
    });
  }
});

export type PublicT2aAudioEvaluatorCapability = z.infer<
  typeof publicT2aAudioEvaluatorCapabilitySchema
>;
export type PublicT2aAudioEvaluatorBlockerCode = z.infer<
  typeof publicT2aAudioEvaluatorBlockerCodeSchema
>;
const publicAuthorityIsolationSchema = z.union([
  z.object({
    status: z.literal("attested"),
    mechanism: z.enum([
      "separate-studio-identity-proc-fd-isolation",
      "external-signer-sealed-fd-broker",
    ]),
    reasonCode: z.null(),
  }).strict(),
  z.object({
    status: z.literal("hold"),
    mechanism: z.literal("same-local-uid"),
    reasonCode: z.literal("same-uid-authority-not-authentic"),
  }).strict(),
  z.object({
    status: z.literal("hold"),
    mechanism: z.literal("unattested-development"),
    reasonCode: z.literal("runtime-trust-unavailable"),
  }).strict(),
]);

export const publicHealthSchema = z.object({
  state: z.enum(["ready", "blocked"]),
  release: z.object({
    sealed: z.boolean(),
    verified: z.boolean(),
    authorityIsolation: publicAuthorityIsolationSchema,
  }).strict(),
  resources: z.object({
    availableMemoryGiB: nullableResourceSchema,
    totalMemoryGiB: nullableResourceSchema,
    swapFreeGiB: nullableResourceSchema,
    swapTotalGiB: nullableResourceSchema,
    outputFreeGiB: nullableResourceSchema,
  }).strict(),
  engine: z.enum(["available", "missing"]),
  analysisEngine: z.enum(["available", "missing"]),
  orchestrator: z.enum(["available", "missing", "disabled"]),
  qwen: z.enum(["ready", "busy", "offline"]),
  runtimeOverall: z.string().min(1).max(128),
  workloads: z.array(z.object({
    id: z.enum(["qwen", "avatar", "comfyui"]),
    label: z.string().min(1).max(128),
    state: z.string().min(1).max(128),
    protected: z.boolean(),
    estimatedMemoryGiB: nullableResourceSchema,
  }).strict()).max(3),
  evaluators: z.object({
    phonemeViseme: z.object({
      status: z.enum([
        "measured",
        "measurement-only",
        "insufficient",
        "not-available",
        "failed",
        "not-applicable",
      ]),
      blockerCode: z.string().max(256),
      message: z.string().max(4_096).nullable(),
      productGo: z.enum(["passed", "blocked"]),
      measurementReady: z.boolean(),
      method: z.enum(["mfa-mediapipe-de.v1", "ctc-espeak-mediapipe-de.v1"]).nullable(),
    }).strict(),
    t2aAudio: publicT2aAudioEvaluatorCapabilitySchema,
  }).strict(),
  jobPersistence: publicJobPersistenceHealthSchema,
  queueDepth: z.number().int().nonnegative(),
}).strict();

export type PublicHealth = z.infer<typeof publicHealthSchema>;
