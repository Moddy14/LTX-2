import { z } from "zod";

export const qualityScoreKeys = [
  "lipSync",
  "identity",
  "mouthNaturalness",
  "skinStability",
  "motion",
  "audio",
] as const;

export type QualityScoreKey = typeof qualityScoreKeys[number];
export type QualityScores = Record<QualityScoreKey, number>;

const qualityScoreSchema = z.number().int().min(0).max(10);

export const qualityReviewInputSchema = z.object({
  scores: z.object({
    lipSync: qualityScoreSchema,
    identity: qualityScoreSchema,
    mouthNaturalness: qualityScoreSchema,
    skinStability: qualityScoreSchema,
    motion: qualityScoreSchema,
    audio: qualityScoreSchema,
  }).strict(),
  note: z.string().trim().max(2_000).refine((value) => !value.includes("\0"), {
    message: "NUL-Zeichen sind nicht erlaubt.",
  }),
}).strict();

export const jobQualityReviewSchema = qualityReviewInputSchema.extend({
  updatedAt: z.string().datetime({ offset: true }),
}).strict();

export type QualityReviewInput = z.infer<typeof qualityReviewInputSchema>;
export type JobQualityReview = z.infer<typeof jobQualityReviewSchema>;

export function qualityReviewAverage(review: Pick<JobQualityReview, "scores">): number {
  const total = qualityScoreKeys.reduce((sum, key) => sum + review.scores[key], 0);
  return total / qualityScoreKeys.length;
}

export function normalizeJobQualityReview(value: unknown): JobQualityReview | null {
  const parsed = jobQualityReviewSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
