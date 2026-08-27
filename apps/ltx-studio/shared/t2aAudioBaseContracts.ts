import { z } from "zod";

export const T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION = "t2a-ia2v-eligibility.v2" as const;
export const T2A_PHONEME_MEASUREMENT_METHOD =
  "pinned-espeak-reference-vs-independent-ipa-raw-edit.v1" as const;

export const t2aAudioClaimScopeSchema = z.enum(["sealed-release", "development"]);
export type T2aAudioClaimScope = z.infer<typeof t2aAudioClaimScopeSchema>;

export const t2aIa2vBlockerCodeSchema = z.enum([
  "analysis-failed",
  "full-scale-clipping-detected",
  "sample-peak-ceiling-exceeded",
  "true-peak-above-zero-dbtp",
  "duration-exceeds-dialogue-window",
  "dialogue-not-measured",
  "dialogue-model-unverified",
  "detected-language-not-de",
  "raw-asr-content-gate-not-passed",
  "word-error-rate-not-zero",
  "word-edit-counts-not-zero",
  "spoken-content-gate-not-passed",
  "guided-word-coverage-incomplete",
  "usable-guided-word-coverage-incomplete",
  "low-confidence-aligned-words-present",
  "alignment-not-measured",
  "development-runtime-unattested",
]);

export type T2aIa2vBlockerCode = z.infer<typeof t2aIa2vBlockerCodeSchema>;

export const t2aIa2vEligibleSchema = z.object({
  schemaVersion: z.literal(T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION),
  status: z.literal("eligible"),
  blockers: z.tuple([]),
}).strict();

export type T2aIa2vEligible = z.infer<typeof t2aIa2vEligibleSchema>;

export const t2aIa2vBlockedSchema = z.object({
  schemaVersion: z.literal(T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION),
  status: z.literal("blocked"),
  blockers: z.array(t2aIa2vBlockerCodeSchema).min(1).max(17),
}).strict().superRefine((value, context) => {
  if (new Set(value.blockers).size !== value.blockers.length) {
    context.addIssue({
      code: "custom",
      path: ["blockers"],
      message: "IA2V-Blocker dürfen nicht doppelt vorkommen.",
    });
  }
});

export type T2aIa2vBlocked = z.infer<typeof t2aIa2vBlockedSchema>;

export const t2aIa2vEligibilitySchema = z.discriminatedUnion("status", [
  t2aIa2vEligibleSchema,
  t2aIa2vBlockedSchema,
]);

export type T2aIa2vEligibility = z.infer<typeof t2aIa2vEligibilitySchema>;
