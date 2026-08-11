import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";
import {
  candidateReleaseSurfaceSchema,
  releaseGateIds,
  type ReleaseGateId,
} from "./releaseSurface.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });
const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    const parts = value.split("/");
    return (
      !value.startsWith("/") &&
      !value.includes("\\") &&
      parts.every((part) => part !== "" && part !== "." && part !== "..")
    );
  }, "path must be a normalized relative POSIX path");

export const qualificationKinds = [
  "r0-control-plane",
  "r1-reproducible-build",
  "r3-canaries",
  "r3-pause-resume",
  "r3-soak",
  "d1-calibration",
  "q0-cross-shot",
  "q1-comparators",
  "q2-holdout",
] as const;
export type QualificationKind = (typeof qualificationKinds)[number];

export const qualificationGateOwnership: Record<
  QualificationKind,
  readonly ReleaseGateId[]
> = {
  "r0-control-plane": [],
  "r1-reproducible-build": ["runtime-import"],
  "r3-canaries": ["cold-canary", "playable-output", "provenance"],
  "r3-pause-resume": [],
  "r3-soak": [],
  "d1-calibration": [
    "av-sync",
    "phoneme-viseme",
    "mouth-artifact",
    "identity",
    "sharpness",
    "vbench-i2v",
    "asr-critical-token",
    "audio-quality",
  ],
  "q0-cross-shot": [
    "av-sync",
    "phoneme-viseme",
    "mouth-artifact",
    "identity",
    "sharpness",
    "vbench-i2v",
  ],
  "q1-comparators": [
    "av-sync",
    "phoneme-viseme",
    "mouth-artifact",
    "identity",
    "sharpness",
    "vbench-i2v",
    "asr-critical-token",
    "audio-quality",
  ],
  "q2-holdout": [
    "av-sync",
    "phoneme-viseme",
    "mouth-artifact",
    "identity",
    "sharpness",
    "vbench-i2v",
    "asr-critical-token",
    "audio-quality",
    "mos",
  ],
};

export const trustRoles = [
  "preregistration-freezer",
  "rights-attestor",
  "qualification-attestor",
  "evaluation-authorizer",
  "holdout-scorer",
  "release-authorizer",
  "audit-finalizer",
] as const;
export type TrustRole = (typeof trustRoles)[number];

const artifactReferenceSchema = z
  .object({
    path: relativePathSchema,
    sha256: sha256Schema,
    signaturePath: relativePathSchema,
    signatureSha256: sha256Schema,
  })
  .strict();

export const releaseEvidenceIndexSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-release-evidence-index.v1"),
    releaseDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    targetSotaClaimIds: z.array(identifierSchema).min(1),
    trustPolicy: z
      .object({ path: relativePathSchema, sha256: sha256Schema })
      .strict(),
    preregistration: artifactReferenceSchema,
    rightsAttestation: artifactReferenceSchema,
    reports: z
      .array(
        artifactReferenceSchema
          .extend({ kind: z.enum(qualificationKinds) })
          .strict(),
      )
      .length(qualificationKinds.length),
  })
  .strict()
  .superRefine((index, context) => {
    const kinds = index.reports.map(({ kind }) => kind);
    if (new Set(kinds).size !== qualificationKinds.length) {
      context.addIssue({
        code: "custom",
        path: ["reports"],
        message: "every qualification kind must occur exactly once",
      });
    }
    if (
      new Set(index.targetSotaClaimIds).size !== index.targetSotaClaimIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetSotaClaimIds"],
        message: "target claims must be unique",
      });
    }
    if (
      !sameArray(index.targetSotaClaimIds, [...index.targetSotaClaimIds].sort())
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetSotaClaimIds"],
        message: "target claims must be sorted",
      });
    }
  });

export const detachedSignatureSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-detached-signature.v1"),
    algorithm: z.literal("ed25519"),
    keyId: identifierSchema,
    payloadSha256: sha256Schema,
    signatureBase64: z.string().min(1),
  })
  .strict();

export const trustedKeyPolicySchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-trusted-keys.v1"),
    policyId: identifierSchema,
    keys: z
      .array(
        z
          .object({
            keyId: identifierSchema,
            algorithm: z.literal("ed25519"),
            publicKeyBase64: z.string().min(1),
            roles: z.array(z.enum(trustRoles)).min(1),
            notBefore: timestampSchema,
            notAfter: timestampSchema,
            revokedAt: timestampSchema.nullable(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((policy, context) => {
    const ids = policy.keys.map(({ keyId }) => keyId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "key ids must be unique",
      });
    }
    for (const [index, key] of policy.keys.entries()) {
      if (new Set(key.roles).size !== key.roles.length) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "roles"],
          message: "roles must be unique",
        });
      }
      if (parseTimestamp(key.notBefore) >= parseTimestamp(key.notAfter)) {
        context.addIssue({
          code: "custom",
          path: ["keys", index],
          message: "key validity window is inconsistent",
        });
      }
      if (
        key.roles.includes("release-authorizer") &&
        key.roles.includes("audit-finalizer")
      ) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "roles"],
          message:
            "release authorization and audit finalization require separate keys",
        });
      }
      if (
        key.roles.includes("evaluation-authorizer") &&
        (key.roles.includes("release-authorizer") ||
          key.roles.includes("audit-finalizer"))
      ) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "roles"],
          message:
            "evaluation authorization requires a key separate from release authorization and audit finalization",
        });
      }
      if (key.roles.includes("holdout-scorer") && key.roles.length !== 1) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "roles"],
          message: "holdout scoring requires a dedicated signing key",
        });
      }
    }
    if (
      policy.keys.filter(({ roles }) => roles.includes("holdout-scorer"))
        .length !== 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "exactly one holdout-scorer key is required",
      });
    }
  });

export const rightsAttestationSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-rights-attestation.v1"),
    releaseDigest: sha256Schema,
    surfaceDigest: sha256Schema,
    evidenceCatalogDigest: sha256Schema,
    policyVersion: z.literal("ltx-studio-release-rights.v1"),
    validAt: timestampSchema,
    expiresAt: timestampSchema,
    revocationState: z.literal("clear"),
    evidenceIds: z.array(identifierSchema).min(1),
    warnings: z.array(z.string()).max(0),
  })
  .strict()
  .superRefine((attestation, context) => {
    if (
      new Set(attestation.evidenceIds).size !== attestation.evidenceIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "evidence ids must be unique",
      });
    }
    if (
      parseTimestamp(attestation.validAt) >=
      parseTimestamp(attestation.expiresAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "rights validity window is inconsistent",
      });
    }
  });

const claimResultSchema = z
  .object({
    claimId: identifierSchema,
    status: z.enum(["sota-qualified", "local-only", "abstained"]),
    sotaAnchorDigest: sha256Schema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      (result.status === "sota-qualified") !==
      (result.sotaAnchorDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sotaAnchorDigest"],
        message: "only a SOTA-qualified claim binds an anchor",
      });
    }
  });

export const qualificationReportSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-qualification-report.v1"),
    kind: z.enum(qualificationKinds),
    releaseDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    surfaceDigest: sha256Schema,
    producerId: identifierSchema,
    producerDigest: sha256Schema,
    verdict: z.literal("pass"),
    warnings: z.array(z.string()).max(0),
    coverage: z.array(
      z
        .object({
          surfaceEntryId: identifierSchema,
          gates: z.array(z.enum(releaseGateIds)).min(1),
        })
        .strict(),
    ),
    claimResults: z.array(claimResultSchema),
  })
  .strict()
  .superRefine((report, context) => {
    const entries = report.coverage.map(({ surfaceEntryId }) => surfaceEntryId);
    if (new Set(entries).size !== entries.length) {
      context.addIssue({
        code: "custom",
        path: ["coverage"],
        message: "surface entries must be unique within a report",
      });
    }
    for (const [index, coverage] of report.coverage.entries()) {
      if (new Set(coverage.gates).size !== coverage.gates.length) {
        context.addIssue({
          code: "custom",
          path: ["coverage", index, "gates"],
          message: "gates must be unique",
        });
      }
    }
    const claims = report.claimResults.map(({ claimId }) => claimId);
    if (new Set(claims).size !== claims.length) {
      context.addIssue({
        code: "custom",
        path: ["claimResults"],
        message: "claim results must be unique",
      });
    }
    if (report.kind !== "q2-holdout" && report.claimResults.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["claimResults"],
        message: "only Q2 may publish final claim results",
      });
    }
    const allowedGates = new Set(qualificationGateOwnership[report.kind]);
    for (const [index, coverage] of report.coverage.entries()) {
      for (const gate of coverage.gates) {
        if (!allowedGates.has(gate)) {
          context.addIssue({
            code: "custom",
            path: ["coverage", index, "gates"],
            message: `${report.kind} does not own gate ${gate}`,
          });
        }
      }
    }
  });

export const releaseEvidenceSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-release-evidence.v1"),
    releaseDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    surfaceDigest: sha256Schema,
    rightsAttestationDigest: sha256Schema,
    trustPolicyDigest: sha256Schema,
    targetSotaClaimIds: z.array(identifierSchema).min(1),
    candidateSurfaceEntryIds: z.array(identifierSchema).min(1),
    reports: z
      .array(
        z
          .object({ kind: z.enum(qualificationKinds), sha256: sha256Schema })
          .strict(),
      )
      .length(qualificationKinds.length),
    claimResults: z.array(claimResultSchema).min(1),
    blockers: z.array(z.string()).max(0),
    ready_for_release_authorization: z.literal(true),
  })
  .strict();

export const releaseAuthorizationSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-release-authorization.v1"),
    releaseDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    q2ReportDigest: sha256Schema,
    releaseEvidenceDigest: sha256Schema,
    rightsAttestationDigest: sha256Schema,
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .superRefine((authorization, context) => {
    if (
      parseTimestamp(authorization.notBefore) >=
      parseTimestamp(authorization.expiresAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "release authorization validity window is inconsistent",
      });
    }
  });

export const releaseAuditPayloadSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-release-audit-payload.v1"),
    releaseDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    q2ReportDigest: sha256Schema,
    rightsAttestationDigest: sha256Schema,
    releaseEvidenceDigest: sha256Schema,
    releaseAuthorizationDigest: sha256Schema,
    trustPolicyDigest: sha256Schema,
    targetSotaClaimIds: z.array(identifierSchema).min(1),
    releasedSurfaceEntryIds: z.array(identifierSchema).min(1),
    finalizedAt: timestampSchema,
    production_overall: z.literal("go"),
    sota_overall: z.literal("go"),
  })
  .strict();

export const releaseAuditEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-release-audit.v1"),
    audit: releaseAuditPayloadSchema,
    signature: detachedSignatureSchema,
  })
  .strict();

type SignedDocument = { document: unknown; signature: unknown };
export type ReleaseEvidenceInput = {
  now: Date;
  releaseDigest: string;
  manifestSurfaceDigest: string;
  manifestRightsCatalogDigest: string;
  surface: unknown;
  index: unknown;
  trustPolicy: unknown;
  preregistration: SignedDocument;
  rightsAttestation: SignedDocument;
  reports: Array<SignedDocument & { kind: QualificationKind; sha256: string }>;
  trustPolicyDigest: string;
};

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function parseTimestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result))
    throw new Error(`Invalid UTC timestamp: ${value}`);
  return result;
}

export function verifyDetachedSignature(
  document: unknown,
  rawSignature: unknown,
  policy: z.infer<typeof trustedKeyPolicySchema>,
  role: TrustRole,
  now: Date,
): string {
  const signature = detachedSignatureSchema.parse(rawSignature);
  const digest = sha256(document);
  if (signature.payloadSha256 !== digest)
    throw new Error("Detached signature payload digest mismatch");
  const key = policy.keys.find(({ keyId }) => keyId === signature.keyId);
  if (!key || !key.roles.includes(role))
    throw new Error(`Signature key lacks required role: ${role}`);
  const nowMs = now.getTime();
  if (
    nowMs < parseTimestamp(key.notBefore) ||
    nowMs > parseTimestamp(key.notAfter)
  ) {
    throw new Error("Signature key is outside its validity window");
  }
  if (key.revokedAt && parseTimestamp(key.revokedAt) <= nowMs)
    throw new Error("Signature key is revoked");
  const rawKey = Buffer.from(key.publicKeyBase64, "base64");
  const rawSignatureBytes = Buffer.from(signature.signatureBase64, "base64");
  if (
    rawKey.length !== 32 ||
    rawSignatureBytes.length !== 64 ||
    rawKey.toString("base64") !== key.publicKeyBase64 ||
    rawSignatureBytes.toString("base64") !== signature.signatureBase64
  ) {
    throw new Error(
      "Ed25519 key or signature is not canonical base64 with the expected size",
    );
  }
  const derKey = Buffer.concat([
    Buffer.from("302a300506032b6570032100", "hex"),
    rawKey,
  ]);
  const publicKey = createPublicKey({
    key: derKey,
    format: "der",
    type: "spki",
  });
  if (
    !verify(
      null,
      Buffer.from(canonicalJson(document)),
      publicKey,
      rawSignatureBytes,
    )
  ) {
    throw new Error("Detached Ed25519 signature is invalid");
  }
  return digest;
}

function assertCurrentWindow(
  notBefore: string,
  expiresAt: string,
  now: Date,
  context: string,
): void {
  const nowMs = now.getTime();
  if (nowMs < parseTimestamp(notBefore) || nowMs > parseTimestamp(expiresAt)) {
    throw new Error(`${context} is outside its validity window`);
  }
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function collectReleaseEvidence(
  raw: ReleaseEvidenceInput,
): z.infer<typeof releaseEvidenceSchema> {
  if (Number.isNaN(raw.now.getTime())) throw new Error("Audit time is invalid");
  const index = releaseEvidenceIndexSchema.parse(raw.index);
  const surface = candidateReleaseSurfaceSchema.parse(raw.surface);
  const policy = trustedKeyPolicySchema.parse(raw.trustPolicy);
  if (raw.releaseDigest !== index.releaseDigest)
    throw new Error("Index release digest mismatch");
  if (sha256(surface) !== raw.manifestSurfaceDigest)
    throw new Error("Candidate surface digest mismatch");
  if (
    sha256(policy) !== raw.trustPolicyDigest ||
    index.trustPolicy.sha256 !== raw.trustPolicyDigest
  ) {
    throw new Error("Trusted-key policy digest mismatch");
  }

  const preregistration = z
    .object({
      schema_version: z.literal("ltx-av-eval-preregistration.v2"),
      status: z.literal("frozen"),
      target_sota_claim_ids: z.array(identifierSchema).min(1),
    })
    .passthrough()
    .parse(raw.preregistration.document);
  const preregistrationDigest = verifyDetachedSignature(
    preregistration,
    raw.preregistration.signature,
    policy,
    "preregistration-freezer",
    raw.now,
  );
  if (
    preregistrationDigest !== index.preregistrationDigest ||
    preregistrationDigest !== index.preregistration.sha256 ||
    !sameArray(preregistration.target_sota_claim_ids, index.targetSotaClaimIds)
  ) {
    throw new Error("Frozen preregistration binding mismatch");
  }

  const rights = rightsAttestationSchema.parse(raw.rightsAttestation.document);
  const rightsDigest = verifyDetachedSignature(
    rights,
    raw.rightsAttestation.signature,
    policy,
    "rights-attestor",
    raw.now,
  );
  if (
    rightsDigest !== index.rightsAttestation.sha256 ||
    rights.releaseDigest !== raw.releaseDigest ||
    rights.surfaceDigest !== raw.manifestSurfaceDigest ||
    rights.evidenceCatalogDigest !== raw.manifestRightsCatalogDigest ||
    parseTimestamp(rights.validAt) > raw.now.getTime() ||
    parseTimestamp(rights.expiresAt) < raw.now.getTime()
  ) {
    throw new Error(
      "Rights attestation is stale or bound to different release evidence",
    );
  }
  const candidateEntries = surface.entries.filter(
    ({ targetStatus }) => targetStatus === "candidate",
  );
  if (candidateEntries.length === 0)
    throw new Error("Release surface has no candidate entries");
  const candidateIds = new Set(candidateEntries.map(({ id }) => id));
  const candidateById = new Map(candidateEntries.map((entry) => [entry.id, entry]));
  const requiredRights = new Set(
    candidateEntries.flatMap(
      ({ rights: entryRights }) => entryRights.evidenceIds,
    ),
  );
  const attestedRights = new Set(rights.evidenceIds);
  if ([...requiredRights].some((id) => !attestedRights.has(id)))
    throw new Error("Rights attestation misses candidate evidence");

  const expectedReferences = new Map(
    index.reports.map((report) => [report.kind, report]),
  );
  const observedKinds = new Set<QualificationKind>();
  const coverage = new Map<string, Set<ReleaseGateId>>();
  let claimResults: z.infer<typeof claimResultSchema>[] = [];
  const reportDigests: Array<{ kind: QualificationKind; sha256: string }> = [];
  for (const rawReport of raw.reports) {
    if (observedKinds.has(rawReport.kind))
      throw new Error(`Duplicate qualification report: ${rawReport.kind}`);
    observedKinds.add(rawReport.kind);
    const reference = expectedReferences.get(rawReport.kind);
    if (!reference || rawReport.sha256 !== reference.sha256)
      throw new Error(`Report index mismatch: ${rawReport.kind}`);
    const report = qualificationReportSchema.parse(rawReport.document);
    if (report.kind !== rawReport.kind || sha256(report) !== rawReport.sha256) {
      throw new Error(
        `Qualification report digest mismatch: ${rawReport.kind}`,
      );
    }
    verifyDetachedSignature(
      report,
      rawReport.signature,
      policy,
      rawReport.kind === "q2-holdout"
        ? "holdout-scorer"
        : "qualification-attestor",
      raw.now,
    );
    if (
      report.releaseDigest !== raw.releaseDigest ||
      report.preregistrationDigest !== preregistrationDigest ||
      report.surfaceDigest !== raw.manifestSurfaceDigest
    ) {
      throw new Error(
        `Qualification report binding mismatch: ${rawReport.kind}`,
      );
    }
    for (const entry of report.coverage) {
      if (!candidateIds.has(entry.surfaceEntryId))
        throw new Error(
          `Report covers non-candidate entry: ${entry.surfaceEntryId}`,
        );
      const applicable = new Set(
        candidateById.get(entry.surfaceEntryId)?.applicableGates ?? [],
      );
      if (entry.gates.some((gate) => !applicable.has(gate)))
        throw new Error(
          `Report claims a non-applicable gate: ${entry.surfaceEntryId}`,
        );
      const gateSet =
        coverage.get(entry.surfaceEntryId) ?? new Set<ReleaseGateId>();
      for (const gate of entry.gates) gateSet.add(gate);
      coverage.set(entry.surfaceEntryId, gateSet);
    }
    if (report.kind === "q2-holdout") claimResults = report.claimResults;
    reportDigests.push({ kind: rawReport.kind, sha256: rawReport.sha256 });
  }
  if (observedKinds.size !== qualificationKinds.length)
    throw new Error("Qualification report set is incomplete");
  for (const entry of candidateEntries) {
    const passed = coverage.get(entry.id) ?? new Set<ReleaseGateId>();
    const missing = entry.applicableGates.filter((gate) => !passed.has(gate));
    if (missing.length > 0)
      throw new Error(
        `Candidate ${entry.id} lacks passing gates: ${missing.join(",")}`,
      );
  }
  const resultsByClaim = new Map(
    claimResults.map((result) => [result.claimId, result]),
  );
  const candidateClaims = new Set(
    candidateEntries.map(({ claimId }) => claimId),
  );
  for (const claim of candidateClaims) {
    if (!resultsByClaim.has(claim))
      throw new Error(
        `Q2 report has no final result for candidate claim: ${claim}`,
      );
  }
  for (const claim of resultsByClaim.keys()) {
    if (!candidateClaims.has(claim))
      throw new Error(
        `Q2 report publishes a result for a non-candidate claim: ${claim}`,
      );
  }
  for (const target of index.targetSotaClaimIds) {
    if (!candidateClaims.has(target))
      throw new Error(`Target SOTA claim has no candidate surface: ${target}`);
    if (resultsByClaim.get(target)?.status !== "sota-qualified") {
      throw new Error(
        `Target SOTA claim is not qualified against an external anchor: ${target}`,
      );
    }
  }

  return releaseEvidenceSchema.parse({
    schemaVersion: "ltx-studio-release-evidence.v1",
    releaseDigest: raw.releaseDigest,
    preregistrationDigest,
    surfaceDigest: raw.manifestSurfaceDigest,
    rightsAttestationDigest: rightsDigest,
    trustPolicyDigest: raw.trustPolicyDigest,
    targetSotaClaimIds: index.targetSotaClaimIds,
    candidateSurfaceEntryIds: candidateEntries.map(({ id }) => id),
    reports: reportDigests.sort((left, right) =>
      left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0,
    ),
    claimResults: [...claimResults].sort((left, right) =>
      left.claimId < right.claimId ? -1 : left.claimId > right.claimId ? 1 : 0,
    ),
    blockers: [],
    ready_for_release_authorization: true,
  });
}

export type ReleaseFinalizationInput = {
  now: Date;
  evidence: unknown;
  evidenceDigest: string;
  authorization: SignedDocument;
  rightsAttestation: SignedDocument;
  trustPolicy: unknown;
  trustPolicyDigest: string;
  finalizerKeyId: string;
  finalizerPrivateKeyPem: string;
};

export function finalizeReleaseAudit(
  raw: ReleaseFinalizationInput,
): z.infer<typeof releaseAuditEnvelopeSchema> {
  if (Number.isNaN(raw.now.getTime()))
    throw new Error("Finalization time is invalid");
  const evidence = releaseEvidenceSchema.parse(raw.evidence);
  if (sha256(evidence) !== raw.evidenceDigest)
    throw new Error("Release evidence digest mismatch");
  const policy = trustedKeyPolicySchema.parse(raw.trustPolicy);
  if (
    sha256(policy) !== raw.trustPolicyDigest ||
    evidence.trustPolicyDigest !== raw.trustPolicyDigest
  ) {
    throw new Error("Finalizer trusted-key policy digest mismatch");
  }

  const rights = rightsAttestationSchema.parse(raw.rightsAttestation.document);
  const rightsDigest = verifyDetachedSignature(
    rights,
    raw.rightsAttestation.signature,
    policy,
    "rights-attestor",
    raw.now,
  );
  if (
    rightsDigest !== evidence.rightsAttestationDigest ||
    rights.releaseDigest !== evidence.releaseDigest
  ) {
    throw new Error("Finalizer rights attestation binding mismatch");
  }
  assertCurrentWindow(
    rights.validAt,
    rights.expiresAt,
    raw.now,
    "Rights attestation",
  );

  const authorization = releaseAuthorizationSchema.parse(
    raw.authorization.document,
  );
  const authorizationSignature = detachedSignatureSchema.parse(
    raw.authorization.signature,
  );
  if (authorizationSignature.keyId === raw.finalizerKeyId) {
    throw new Error(
      "Release authorizer and audit finalizer must use different keys",
    );
  }
  const authorizationDigest = verifyDetachedSignature(
    authorization,
    authorizationSignature,
    policy,
    "release-authorizer",
    raw.now,
  );
  const q2ReportDigest = evidence.reports.find(
    ({ kind }) => kind === "q2-holdout",
  )?.sha256;
  if (!q2ReportDigest)
    throw new Error("Release evidence has no Q2 report digest");
  if (
    authorization.releaseDigest !== evidence.releaseDigest ||
    authorization.preregistrationDigest !== evidence.preregistrationDigest ||
    authorization.q2ReportDigest !== q2ReportDigest ||
    authorization.releaseEvidenceDigest !== raw.evidenceDigest ||
    authorization.rightsAttestationDigest !== rightsDigest
  ) {
    throw new Error("Release authorization binding mismatch");
  }
  assertCurrentWindow(
    authorization.notBefore,
    authorization.expiresAt,
    raw.now,
    "Release authorization",
  );

  const payload = releaseAuditPayloadSchema.parse({
    schemaVersion: "ltx-studio-release-audit-payload.v1",
    releaseDigest: evidence.releaseDigest,
    preregistrationDigest: evidence.preregistrationDigest,
    q2ReportDigest,
    rightsAttestationDigest: rightsDigest,
    releaseEvidenceDigest: raw.evidenceDigest,
    releaseAuthorizationDigest: authorizationDigest,
    trustPolicyDigest: raw.trustPolicyDigest,
    targetSotaClaimIds: evidence.targetSotaClaimIds,
    releasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
    finalizedAt: new Date(Math.floor(raw.now.getTime() / 1000) * 1000)
      .toISOString()
      .replace(".000Z", "Z"),
    production_overall: "go",
    sota_overall: "go",
  });
  const finalizerKey = policy.keys.find(
    ({ keyId }) => keyId === raw.finalizerKeyId,
  );
  if (!finalizerKey || !finalizerKey.roles.includes("audit-finalizer")) {
    throw new Error("Finalizer key lacks the audit-finalizer role");
  }
  assertCurrentWindow(
    finalizerKey.notBefore,
    finalizerKey.notAfter,
    raw.now,
    "Finalizer key",
  );
  if (
    finalizerKey.revokedAt &&
    parseTimestamp(finalizerKey.revokedAt) <= raw.now.getTime()
  ) {
    throw new Error("Finalizer key is revoked");
  }
  const privateKey = createPrivateKey(raw.finalizerPrivateKeyPem);
  const signature = detachedSignatureSchema.parse({
    schemaVersion: "ltx-studio-detached-signature.v1",
    algorithm: "ed25519",
    keyId: raw.finalizerKeyId,
    payloadSha256: sha256(payload),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(payload)),
      privateKey,
    ).toString("base64"),
  });
  verifyDetachedSignature(
    payload,
    signature,
    policy,
    "audit-finalizer",
    raw.now,
  );
  return releaseAuditEnvelopeSchema.parse({
    schemaVersion: "ltx-studio-release-audit.v1",
    audit: payload,
    signature,
  });
}
