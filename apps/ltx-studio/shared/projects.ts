import { z } from "zod";

import {
  generationRequestSchema,
  outputNameSchema,
} from "./pipelines.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 3 });
const safeText = (maximum: number) => z.string().trim().min(1).max(maximum).refine(
  (value) => !value.includes("\0"),
  "NUL-Zeichen sind nicht erlaubt.",
);
const safeDescriptionSchema = z.string().trim().max(2_000).refine(
  (value) => !value.includes("\0"),
  "NUL-Zeichen sind nicht erlaubt.",
);

export const projectCreateInputSchema = z.object({
  title: safeText(120),
  description: safeDescriptionSchema.default(""),
  actorId: safeText(128),
}).strict();

export const projectContinuityBindingSchema = z.object({
  predecessorShotId: z.string().uuid(),
  referenceOutputId: z.string().uuid(),
}).strict();

export const projectShotCreateInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  title: safeText(120),
  request: generationRequestSchema,
  continuity: projectContinuityBindingSchema.nullable().default(null),
  actorId: safeText(128),
}).strict();

export const projectShotRevisionInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  shotId: z.string().uuid(),
  request: generationRequestSchema,
  reason: z.enum(["edit", "retake"]),
  sourceOutputId: z.string().uuid().nullable().default(null),
  actorId: safeText(128),
}).strict().superRefine((value, context) => {
  if ((value.reason === "retake") !== (value.sourceOutputId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["sourceOutputId"],
      message: "Eine Retake-Revision benötigt genau eine gebundene Quellausgabe.",
    });
  }
});

export const projectOutputEvidenceSchema = z.object({
  id: z.string().uuid(),
  requestRevisionId: z.string().uuid(),
  requestSha256: sha256Schema,
  jobId: z.string().uuid(),
  outputName: outputNameSchema,
  sizeBytes: z.number().int().positive(),
  changedAt: timestampSchema,
  fileId: z.string().regex(/^\d{1,64}$/),
  provenanceFingerprint: sha256Schema,
  settingsSidecarSha256: sha256Schema,
  exportSha256: sha256Schema,
  recordedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  if (value.changedAt > value.recordedAt) {
    context.addIssue({
      code: "custom",
      path: ["changedAt"],
      message: "Eine Ausgabe kann nicht vor ihrem Dateizeitpunkt protokolliert werden.",
    });
  }
});

export const projectOutputRecordInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  shotId: z.string().uuid(),
  evidence: projectOutputEvidenceSchema,
  actorId: safeText(128),
}).strict();

export const projectOutputApprovalInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  shotId: z.string().uuid(),
  outputId: z.string().uuid(),
  actorId: safeText(128),
}).strict();

export const projectArchiveInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  actorId: safeText(128),
}).strict();

export const projectRequestRevisionSchema = z.object({
  id: z.string().uuid(),
  parentRevisionId: z.string().uuid().nullable(),
  reason: z.enum(["initial", "edit", "retake"]),
  sourceOutputId: z.string().uuid().nullable(),
  request: generationRequestSchema,
  requestSha256: sha256Schema,
  createdAt: timestampSchema,
  actorId: safeText(128),
}).strict();

export const projectShotSchema = z.object({
  id: z.string().uuid(),
  order: z.number().int().nonnegative(),
  title: safeText(120),
  status: z.enum(["draft", "rendered", "approved"]),
  continuity: projectContinuityBindingSchema.nullable(),
  requestRevisions: z.array(projectRequestRevisionSchema).min(1).max(128),
  currentRequestRevisionId: z.string().uuid(),
  outputHistory: z.array(projectOutputEvidenceSchema).max(256),
  approvedOutputId: z.string().uuid().nullable(),
}).strict();

export const studioProjectSchema = z.object({
  schemaVersion: z.literal("ltx-studio-project.v1"),
  id: z.string().uuid(),
  title: safeText(120),
  description: safeDescriptionSchema,
  status: z.enum(["active", "archived"]),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  shots: z.array(projectShotSchema).max(256),
}).strict().superRefine((project, context) => {
  const shotIds = project.shots.map(({ id }) => id);
  if (new Set(shotIds).size !== shotIds.length) {
    context.addIssue({ code: "custom", path: ["shots"], message: "Shot-IDs müssen eindeutig sein." });
  }
  if (project.shots.some((shot, index) => shot.order !== index)) {
    context.addIssue({ code: "custom", path: ["shots"], message: "Shot-Reihenfolge muss lückenlos sein." });
  }
  const shotsById = new Map(project.shots.map((shot) => [shot.id, shot]));
  const allOutputIds = new Set<string>();
  for (const [shotIndex, shot] of project.shots.entries()) {
    const revisionIds = shot.requestRevisions.map(({ id }) => id);
    if (new Set(revisionIds).size !== revisionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["shots", shotIndex, "requestRevisions"],
        message: "Request-Revisionen müssen eindeutig sein.",
      });
    }
    if (shot.currentRequestRevisionId !== revisionIds.at(-1)) {
      context.addIssue({
        code: "custom",
        path: ["shots", shotIndex, "currentRequestRevisionId"],
        message: "Aktuelle Request-Revision muss das Ende der Historie sein.",
      });
    }
    shot.requestRevisions.forEach((revision, revisionIndex) => {
      const expectedParent = revisionIndex === 0
        ? null
        : shot.requestRevisions[revisionIndex - 1]?.id ?? null;
      if (
        revision.parentRevisionId !== expectedParent
        || (revisionIndex === 0 && revision.reason !== "initial")
        || (revisionIndex > 0 && revision.reason === "initial")
        || ((revision.reason === "retake") !== (revision.sourceOutputId !== null))
      ) {
        context.addIssue({
          code: "custom",
          path: ["shots", shotIndex, "requestRevisions", revisionIndex],
          message: "Request-Revisionskette ist inkonsistent.",
        });
      }
    });
    const outputIds = shot.outputHistory.map(({ id }) => id);
    if (new Set(outputIds).size !== outputIds.length || outputIds.some((id) => allOutputIds.has(id))) {
      context.addIssue({
        code: "custom",
        path: ["shots", shotIndex, "outputHistory"],
        message: "Output-IDs müssen projektweit eindeutig sein.",
      });
    }
    outputIds.forEach((id) => allOutputIds.add(id));
    if (shot.outputHistory.some(({ requestRevisionId }) => !revisionIds.includes(requestRevisionId))) {
      context.addIssue({
        code: "custom",
        path: ["shots", shotIndex, "outputHistory"],
        message: "Eine Ausgabe referenziert eine unbekannte Request-Revision.",
      });
    }
    if (shot.approvedOutputId !== null && !outputIds.includes(shot.approvedOutputId)) {
      context.addIssue({
        code: "custom",
        path: ["shots", shotIndex, "approvedOutputId"],
        message: "Freigegebene Ausgabe fehlt in der Historie.",
      });
    }
    const expectedStatus = shot.approvedOutputId !== null
      ? "approved"
      : shot.outputHistory.length > 0
        ? "rendered"
        : "draft";
    if (shot.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["shots", shotIndex, "status"],
        message: "Shot-Status passt nicht zur Ausgabehistorie.",
      });
    }
    if (shot.continuity) {
      const predecessor = shotsById.get(shot.continuity.predecessorShotId);
      if (
        !predecessor
        || predecessor.order >= shot.order
        || !predecessor.outputHistory.some(({ id }) => id === shot.continuity?.referenceOutputId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["shots", shotIndex, "continuity"],
          message: "Continuity muss eine konkrete Ausgabe eines früheren Shots binden.",
        });
      }
    }
  }
  for (const [shotIndex, shot] of project.shots.entries()) {
    for (const [revisionIndex, revision] of shot.requestRevisions.entries()) {
      if (revision.sourceOutputId !== null && !allOutputIds.has(revision.sourceOutputId)) {
        context.addIssue({
          code: "custom",
          path: ["shots", shotIndex, "requestRevisions", revisionIndex, "sourceOutputId"],
          message: "Retake-Quelle fehlt in der unveränderlichen Ausgabehistorie.",
        });
      }
    }
  }
});

export const projectMutationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project-created"), actorId: safeText(128) }).strict(),
  z.object({ type: z.literal("shot-added"), actorId: safeText(128), shotId: z.string().uuid() }).strict(),
  z.object({
    type: z.literal("shot-request-revised"),
    actorId: safeText(128),
    shotId: z.string().uuid(),
    requestRevisionId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("shot-output-recorded"),
    actorId: safeText(128),
    shotId: z.string().uuid(),
    outputId: z.string().uuid(),
  }).strict(),
  z.object({
    type: z.literal("shot-output-approved"),
    actorId: safeText(128),
    shotId: z.string().uuid(),
    outputId: z.string().uuid(),
  }).strict(),
  z.object({ type: z.literal("project-archived"), actorId: safeText(128) }).strict(),
]);

export const projectRevisionEnvelopeSchema = z.object({
  schemaVersion: z.literal("ltx-studio-project-revision.v1"),
  projectId: z.string().uuid(),
  revision: z.number().int().positive(),
  previousRevisionSha256: sha256Schema.nullable(),
  recordedAt: timestampSchema,
  mutation: projectMutationSchema,
  project: studioProjectSchema,
}).strict().superRefine((value, context) => {
  if (value.projectId !== value.project.id) {
    context.addIssue({
      code: "custom",
      path: ["projectId"],
      message: "Envelope und Projekt enthalten unterschiedliche IDs.",
    });
  }
  if ((value.revision === 1) !== (value.previousRevisionSha256 === null)) {
    context.addIssue({
      code: "custom",
      path: ["previousRevisionSha256"],
      message: "Nur die erste Revision darf keinen Vorgänger-Hash besitzen.",
    });
  }
});

export type ProjectCreateInput = z.infer<typeof projectCreateInputSchema>;
export type ProjectShotCreateInput = z.infer<typeof projectShotCreateInputSchema>;
export type ProjectShotRevisionInput = z.infer<typeof projectShotRevisionInputSchema>;
export type ProjectOutputRecordInput = z.infer<typeof projectOutputRecordInputSchema>;
export type ProjectOutputApprovalInput = z.infer<typeof projectOutputApprovalInputSchema>;
export type ProjectArchiveInput = z.infer<typeof projectArchiveInputSchema>;
export type StudioProject = z.infer<typeof studioProjectSchema>;
export type ProjectRevisionEnvelope = z.infer<typeof projectRevisionEnvelopeSchema>;
