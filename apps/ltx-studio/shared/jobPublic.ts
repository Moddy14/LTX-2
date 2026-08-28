import { z } from "zod";

import { cpuOperationStates, jobExecutionClasses } from "./jobExecution.js";

const timestampSchema = z.string().datetime();

/**
 * Deliberately small browser-safe views of internal execution authority.
 *
 * The persisted ExecutionDecision and RunProvenance documents contain held
 * descriptor metadata, private snapshot paths and release/build digests. They
 * are authority records, not API DTOs.  Extending either internal document
 * therefore cannot implicitly extend this strict public contract.
 */
export const publicRunProvenanceSummarySchema = z.object({
  schemaVersion: z.literal("ltx-studio-public-run-provenance-summary.v1"),
  status: z.enum(["captured-unverified", "verified"]),
  capturedAt: timestampSchema,
  verifiedAt: timestampSchema.nullable(),
  release: z.object({
    sealed: z.boolean(),
    verified: z.boolean(),
  }).strict().nullable(),
}).strict();

export type PublicRunProvenanceSummary = z.infer<typeof publicRunProvenanceSummarySchema>;

export const publicExecutionDecisionSummarySchema = z.object({
  schemaVersion: z.literal("ltx-studio-public-execution-decision-summary.v1"),
  executionClass: z.enum(jobExecutionClasses),
  decidedAt: timestampSchema,
  reason: z.string().min(1).max(240),
  verificationStatus: z.enum(["pending", "verified", "unverified"]),
  cpuReuse: z.object({
    baselineLabel: z.string().min(1).max(120),
    operationKind: z.enum([
      "ffmpeg-audio-retime",
      "ffmpeg-audio-retime-v2",
      "paired-artifact-promotion",
    ]),
    sourceProgramAudioDelayMs: z.number().int().min(-1_000).max(1_000).nullable(),
    appliedDeltaMs: z.number().int().min(-1_000).max(1_000).nullable(),
    operationState: z.enum(cpuOperationStates),
    preparedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
  }).strict().nullable(),
}).strict();

export type PublicExecutionDecisionSummary = z.infer<
  typeof publicExecutionDecisionSummarySchema
>;
