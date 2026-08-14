import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const relativePathSchema = z.string().min(1).refine((value) =>
  !value.startsWith("/") && !value.split("/").includes(".."), "path must be repository-relative");

export const m0GitIdentitySchema = z.object({
  role: z.enum(["pre_plan_baseline", "reviewed_plan_source_commit"]),
  commit: gitShaSchema,
  tree: gitShaSchema,
}).strict();

export const m0CommandResultSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]+$/),
  command: z.string().min(1),
  status: z.enum(["pass", "fail", "expected-fail", "not-run"]),
  exitCode: z.number().int().nullable(),
  passed: z.number().int().nonnegative().nullable(),
  failed: z.number().int().nonnegative().nullable(),
  skipped: z.number().int().nonnegative().nullable(),
  outputSha256: sha256Schema.nullable(),
  note: z.string().min(1).nullable(),
}).strict();

export const m0VerificationSchema = z.object({
  schemaVersion: z.literal("ltx-studio-m0-verification.v1"),
  reviewedPlanCommit: gitShaSchema,
  capturedAt: z.string().datetime({ offset: true }),
  commands: z.array(m0CommandResultSchema).min(1),
}).strict();

const fileDigestSchema = z.object({
  path: relativePathSchema,
  sha256: sha256Schema,
  bytes: z.number().int().nonnegative(),
}).strict();

export const m0BaselineSchema = z.object({
  schemaVersion: z.literal("ltx-studio-m0-baseline.v1"),
  capturedAt: z.string().datetime({ offset: true }),
  identities: z.tuple([
    m0GitIdentitySchema.extend({ role: z.literal("pre_plan_baseline") }),
    m0GitIdentitySchema.extend({ role: z.literal("reviewed_plan_source_commit") }),
  ]),
  repository: z.object({
    branch: z.string().min(1),
    reviewedPlanWasClean: z.literal(true),
    evidenceWorktreeChanges: z.array(relativePathSchema),
    originMain: gitShaSchema,
    aheadOfOriginMain: z.number().int().nonnegative(),
    behindOriginMain: z.number().int().nonnegative(),
    localCommitsSinceMergeBase: z.number().int().nonnegative(),
    remotes: z.array(z.object({
      name: z.string().min(1),
      fetchUrl: z.string().url(),
      pushUrl: z.string().url(),
    }).strict()).min(1),
    remoteRefs: z.array(z.object({
      remote: z.string().min(1),
      ref: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/),
      commit: gitShaSchema,
    }).strict()).min(2),
  }).strict(),
  activeJobs: z.object({
    endpoint: z.literal("http://127.0.0.1:4318/api/jobs"),
    running: z.number().int().nonnegative(),
  }).strict(),
  verification: z.object({
    path: relativePathSchema,
    sha256: sha256Schema,
    commands: z.array(m0CommandResultSchema).min(1),
  }).strict(),
  dependencyInputs: z.array(fileDigestSchema).min(1),
  runtime: z.object({
    studioEndpoint: z.literal("http://127.0.0.1:4318"),
    serviceUnit: z.string().min(1).nullable(),
    activeEnterTimestamp: z.string().min(1).nullable(),
    mainPid: z.number().int().nonnegative().nullable(),
    processStart: z.string().min(1).nullable(),
    healthStatus: z.number().int().nullable(),
    healthBodySha256: sha256Schema.nullable(),
    currentReleaseTarget: z.string().min(1).nullable(),
    installedReleaseDigests: z.array(z.string().min(1)),
  }).strict(),
}).strict();

const sourceLocationSchema = z.object({
  path: relativePathSchema,
  line: z.number().int().positive(),
}).strict();

export const m0ContractInventorySchema = z.object({
  schemaVersion: z.literal("ltx-studio-m0-contract-inventory.v1"),
  generatedAt: z.string().datetime({ offset: true }),
  reviewedPlan: m0GitIdentitySchema.extend({ role: z.literal("reviewed_plan_source_commit") }),
  sourceFiles: z.array(fileDigestSchema).min(1),
  capabilitySurface: z.object({
    path: relativePathSchema,
    sha256: sha256Schema,
    entries: z.number().int().positive(),
    candidate: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    claimIds: z.array(z.string().min(1)).min(1),
    modes: z.array(z.string().min(1)).min(1),
  }).strict(),
  httpRoutes: z.array(z.object({
    method: z.enum(["DELETE", "GET", "PATCH", "POST", "PUT"]),
    path: z.string().startsWith("/"),
    source: sourceLocationSchema,
  }).strict()).min(1),
  schemas: z.array(z.object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9]*Schema$/),
    source: sourceLocationSchema,
  }).strict()).min(1),
  cliPrograms: z.array(z.object({
    path: relativePathSchema,
    commands: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
  exports: z.array(z.object({
    language: z.enum(["python", "typescript"]),
    path: relativePathSchema,
    symbols: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
  contracts: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]+$/),
    sources: z.array(relativePathSchema).min(1),
    tests: z.array(relativePathSchema).min(1),
  }).strict()).min(1),
}).strict().superRefine((inventory, context) => {
  const unique = <T>(items: T[]) => new Set(items).size === items.length;
  if (!unique(inventory.httpRoutes.map(({ method, path }) => `${method} ${path}`))) {
    context.addIssue({ code: "custom", path: ["httpRoutes"], message: "duplicate route" });
  }
  if (!unique(inventory.schemas.map(({ name, source }) => `${source.path}:${name}`))) {
    context.addIssue({ code: "custom", path: ["schemas"], message: "duplicate schema" });
  }
  if (!unique(inventory.contracts.map(({ id }) => id))) {
    context.addIssue({ code: "custom", path: ["contracts"], message: "duplicate contract id" });
  }
  if (inventory.capabilitySurface.candidate + inventory.capabilitySurface.blocked
    !== inventory.capabilitySurface.entries) {
    context.addIssue({
      code: "custom",
      path: ["capabilitySurface"],
      message: "candidate and blocked counts must cover every surface entry",
    });
  }
});

export type M0Verification = z.infer<typeof m0VerificationSchema>;
export type M0Baseline = z.infer<typeof m0BaselineSchema>;
export type M0ContractInventory = z.infer<typeof m0ContractInventorySchema>;
