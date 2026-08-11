import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const componentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]+$/);

export const rightsDecisionSchema = z.enum(["permitted", "conditional", "blocked"]);
export const rightsDimensionSchema = z.enum([
  "permitted",
  "conditional",
  "blocked",
  "not-applicable",
  "not-distributed",
]);

export const rightsEvidenceSourceSchema = z.object({
  authority: z.enum(["upstream-git", "upstream-model-card", "release-local"]),
  repository: z.string().min(1),
  revision: z.string().min(1),
  path: z.string().min(1),
  url: z.string().url(),
  sha256: sha256Schema,
  sizeBytes: z.number().int().positive(),
}).strict();

export const rightsEvidenceEntrySchema = z.object({
  evidenceId: componentIdSchema,
  componentIds: z.array(componentIdSchema).min(1),
  sources: z.array(rightsEvidenceSourceSchema).min(1),
  dimensions: z.object({
    code: rightsDimensionSchema,
    weights: rightsDimensionSchema,
    trainingData: rightsDimensionSchema,
    biometricProcessing: rightsDimensionSchema,
    commercialUse: rightsDimensionSchema,
  }).strict(),
  decision: rightsDecisionSchema,
  reason: z.string().min(1),
}).strict();

export const rightsEvidenceCatalogSchema = z.object({
  schemaVersion: z.literal("ltx-studio-rights-evidence.v1"),
  policyVersion: z.literal("ltx-studio-release-rights.v1"),
  cutoffDate: z.string().date(),
  activationContract: z.object({
    permitted: z.literal("may-proceed-subject-to-applicable-quality-gates"),
    conditional: z.literal("requires-current-signed-rights-attest"),
    blocked: z.literal("must-not-run-in-production-or-support-release-claims"),
  }).strict(),
  evidence: z.array(rightsEvidenceEntrySchema).min(1),
}).strict().superRefine((catalog, context) => {
  const evidenceIds = new Set<string>();
  for (const [index, entry] of catalog.evidence.entries()) {
    if (evidenceIds.has(entry.evidenceId)) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index, "evidenceId"],
        message: "duplicate evidence id",
      });
    }
    evidenceIds.add(entry.evidenceId);
    if (new Set(entry.componentIds).size !== entry.componentIds.length) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index, "componentIds"],
        message: "duplicate component id",
      });
    }
    if (entry.decision !== "blocked"
      && Object.values(entry.dimensions).includes("blocked")) {
      context.addIssue({
        code: "custom",
        path: ["evidence", index, "decision"],
        message: "a blocked dimension requires a blocked decision",
      });
    }
  }
  const sorted = [...catalog.evidence].sort((left, right) =>
    left.evidenceId < right.evidenceId ? -1 : left.evidenceId > right.evidenceId ? 1 : 0);
  if (catalog.evidence.some((entry, index) => entry.evidenceId !== sorted[index]?.evidenceId)) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "evidence must be sorted by id" });
  }
});

export type RightsEvidenceCatalog = z.infer<typeof rightsEvidenceCatalogSchema>;
