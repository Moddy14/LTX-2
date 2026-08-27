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
import {
  validateReleaseSecurityAuditEvidence,
  type SecurityAuditArtifactReader,
  type ReleaseSecurityAuditBinding,
} from "./securityAudit.js";
import {
  assertQualificationArtifactCurrent,
  dischargeableQualificationBlockers,
  expectedQualificationResolutions,
  manifestQualificationSchema,
  nonDischargeableQualificationBlockers,
  qualificationArtifactDigest,
  qualificationResolutionTrustPolicySchema,
  signedAuthorityIsolationAttestationSchema,
  signedBuildAuthorityAttestationSchema,
  signedQualificationResolutionSchema,
  verifyQualificationArtifactSignature,
  type QualificationEvidenceDigests,
} from "./qualificationResolution.js";
import {
  assertRuntimeTrustAuthorizesRelease,
  runtimeTrustBindingSchema,
} from "./runtimeTrust.js";

export {
  securityAuditBindingFromReleaseManifest,
  validateReleaseSecurityAudit,
  validateReleaseSecurityAuditEvidence,
} from "./securityAudit.js";
export {
  authorityIsolationAttestationSchema,
  buildAuthorityAttestationSchema,
  qualificationResolutionSchema,
  qualificationResolutionTrustPolicySchema,
  signedAuthorityIsolationAttestationSchema,
  signedBuildAuthorityAttestationSchema,
  signedQualificationResolutionSchema,
  verifyQualificationArtifactSignature,
} from "./qualificationResolution.js";

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

const finalQualificationGateOwner: Record<ReleaseGateId, QualificationKind> = {
  "runtime-import": "r1-reproducible-build",
  "cold-canary": "r3-canaries",
  "playable-output": "r3-canaries",
  provenance: "r3-canaries",
  "av-sync": "q2-holdout",
  "phoneme-viseme": "q2-holdout",
  "mouth-artifact": "q2-holdout",
  identity: "q2-holdout",
  sharpness: "q2-holdout",
  "vbench-i2v": "q2-holdout",
  "asr-critical-token": "q2-holdout",
  "audio-quality": "q2-holdout",
  mos: "q2-holdout",
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

const evidenceProducerTrustRoles = [
  "preregistration-freezer",
  "rights-attestor",
  "qualification-attestor",
  "holdout-scorer",
] as const satisfies readonly TrustRole[];
const releaseControlTrustRoles = [
  "release-authorizer",
  "audit-finalizer",
] as const satisfies readonly TrustRole[];

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
    schemaVersion: z.literal("ltx-studio-release-evidence-index.v3"),
    releaseDigest: sha256Schema,
    runtimeTrust: runtimeTrustBindingSchema,
    preregistrationDigest: sha256Schema,
    targetSotaClaimIds: z.array(identifierSchema).min(1),
    trustPolicy: z
      .object({ path: relativePathSchema, sha256: sha256Schema })
      .strict(),
    preregistration: artifactReferenceSchema,
    rightsAttestation: artifactReferenceSchema,
    securityAudit: artifactReferenceSchema,
    qualification: z.object({
      trustPolicy: z.object({ path: relativePathSchema, sha256: sha256Schema }).strict(),
      buildAuthorityAttestation: artifactReferenceSchema,
      authorityIsolationAttestation: artifactReferenceSchema,
      resolution: artifactReferenceSchema,
    }).strict(),
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

const ed25519PublicKeySchema = z.string().min(1).max(128).refine((value) => {
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value;
}, "Ed25519 public key must be canonical base64 for exactly 32 bytes");

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
            publicKeyBase64: ed25519PublicKeySchema,
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
    const publicKeys = policy.keys.map(({ publicKeyBase64 }) => publicKeyBase64);
    if (new Set(publicKeys).size !== publicKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "public key material must be unique across trust-policy keys",
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
        evidenceProducerTrustRoles.some((role) => key.roles.includes(role))
        && releaseControlTrustRoles.some((role) => key.roles.includes(role))
      ) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "roles"],
          message:
            "evidence production, release authorization, and audit finalization require separate keys",
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

export const releaseTrustedKeyPolicySchema = trustedKeyPolicySchema.superRefine(
  (policy, context) => {
    const qualificationAttestors = policy.keys.filter(({ roles }) =>
      roles.includes("qualification-attestor"),
    );
    if (qualificationAttestors.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["keys"],
        message: "exactly one qualification-attestor key is required",
      });
    }
    for (const [index, key] of policy.keys.entries()) {
      if (
        key.roles.includes("qualification-attestor") &&
        (key.roles.includes("release-authorizer") ||
          key.roles.includes("audit-finalizer"))
      ) {
        context.addIssue({
          code: "custom",
          path: ["keys", index, "roles"],
          message:
            "security qualification attestation requires a key separate from release authorization and audit finalization",
        });
      }
    }
  },
);

export const rightsAttestationSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-rights-attestation.v2"),
    releaseDigest: sha256Schema,
    surfaceDigest: sha256Schema,
    evidenceCatalogDigest: sha256Schema,
    runtimeTrust: runtimeTrustBindingSchema,
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
    schemaVersion: z.literal("ltx-studio-qualification-report.v2"),
    kind: z.enum(qualificationKinds),
    releaseDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    surfaceDigest: sha256Schema,
    runtimeTrust: runtimeTrustBindingSchema,
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
    schemaVersion: z.literal("ltx-studio-release-evidence.v3"),
    releaseDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    surfaceDigest: sha256Schema,
    runtimeTrust: runtimeTrustBindingSchema,
    manifestQualificationSha256: sha256Schema,
    qualificationTrustPolicyDigest: sha256Schema,
    buildAuthorityAttestationDigest: sha256Schema,
    authorityIsolationAttestationDigest: sha256Schema,
    qualificationResolutionDigest: sha256Schema,
    qualificationArtifacts: z.object({
      trustPolicy: qualificationResolutionTrustPolicySchema,
      buildAuthorityAttestation: signedBuildAuthorityAttestationSchema,
      authorityIsolationAttestation: signedAuthorityIsolationAttestationSchema,
      resolution: signedQualificationResolutionSchema,
    }).strict(),
    rightsAttestationDigest: sha256Schema,
    securityAudit: z
      .object({
        sha256: sha256Schema,
        generatedAt: timestampSchema,
        cutoffAt: timestampSchema,
        expiresAt: timestampSchema,
      })
      .strict(),
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
  .strict()
  .superRefine((evidence, context) => {
    const securityGeneratedAt = parseTimestamp(evidence.securityAudit.generatedAt);
    const securityCutoffAt = parseTimestamp(evidence.securityAudit.cutoffAt);
    const securityExpiresAt = parseTimestamp(evidence.securityAudit.expiresAt);
    const maxSecurityWindowMs = 24 * 60 * 60 * 1000;
    if (
      securityCutoffAt > securityGeneratedAt ||
      securityGeneratedAt >= securityExpiresAt ||
      securityGeneratedAt - securityCutoffAt > maxSecurityWindowMs ||
      securityExpiresAt - securityGeneratedAt > maxSecurityWindowMs
    ) {
      context.addIssue({
        code: "custom",
        path: ["securityAudit"],
        message: "security audit summary exceeds its 24-hour validity window",
      });
    }
    const reportKinds = evidence.reports.map(({ kind }) => kind);
    if (
      new Set(reportKinds).size !== qualificationKinds.length ||
      qualificationKinds.some((kind) => !reportKinds.includes(kind))
    ) {
      context.addIssue({
        code: "custom",
        path: ["reports"],
        message: "every qualification kind must occur exactly once",
      });
    }
    for (const [path, values] of [
      ["targetSotaClaimIds", evidence.targetSotaClaimIds],
      ["candidateSurfaceEntryIds", evidence.candidateSurfaceEntryIds],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} must be unique`,
        });
      }
    }
    const resultsByClaim = new Map(
      evidence.claimResults.map((result) => [result.claimId, result]),
    );
    if (resultsByClaim.size !== evidence.claimResults.length) {
      context.addIssue({
        code: "custom",
        path: ["claimResults"],
        message: "claim results must be unique",
      });
    }
    for (const target of evidence.targetSotaClaimIds) {
      if (resultsByClaim.get(target)?.status !== "sota-qualified") {
        context.addIssue({
          code: "custom",
          path: ["targetSotaClaimIds"],
          message: `target claim is not SOTA-qualified: ${target}`,
        });
      }
    }
  });

export const releaseAuthorizationSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-release-authorization.v4"),
    activationGeneration: z.number().int().positive(),
    releaseDigest: sha256Schema,
    surfaceDigest: sha256Schema,
    runtimeInstallSealSha256: sha256Schema,
    runtimeTreeSha256: sha256Schema,
    runtimePolicySha256: sha256Schema,
    nodeExecutableSha256: sha256Schema,
    runtimeTrust: runtimeTrustBindingSchema,
    manifestQualificationSha256: sha256Schema,
    qualificationTrustPolicyDigest: sha256Schema,
    buildAuthorityAttestationDigest: sha256Schema,
    authorityIsolationAttestationDigest: sha256Schema,
    qualificationResolutionDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    q2ReportDigest: sha256Schema,
    releaseEvidenceDigest: sha256Schema,
    rightsAttestationDigest: sha256Schema,
    securityAuditDigest: sha256Schema,
    releasedSurfaceEntryIds: z.array(identifierSchema).min(1),
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict()
  .superRefine((authorization, context) => {
    if (new Set(authorization.releasedSurfaceEntryIds).size !== authorization.releasedSurfaceEntryIds.length
      || !sameArray(authorization.releasedSurfaceEntryIds, [...authorization.releasedSurfaceEntryIds].sort())) {
      context.addIssue({
        code: "custom",
        path: ["releasedSurfaceEntryIds"],
        message: "released surface entries must be unique and sorted",
      });
    }
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
    schemaVersion: z.literal("ltx-studio-release-audit-payload.v4"),
    activationGeneration: z.number().int().positive(),
    releaseDigest: sha256Schema,
    surfaceDigest: sha256Schema,
    runtimeInstallSealSha256: sha256Schema,
    runtimeTreeSha256: sha256Schema,
    runtimePolicySha256: sha256Schema,
    nodeExecutableSha256: sha256Schema,
    runtimeTrust: runtimeTrustBindingSchema,
    manifestQualificationSha256: sha256Schema,
    qualificationTrustPolicyDigest: sha256Schema,
    buildAuthorityAttestationDigest: sha256Schema,
    authorityIsolationAttestationDigest: sha256Schema,
    qualificationResolutionDigest: sha256Schema,
    preregistrationDigest: sha256Schema,
    q2ReportDigest: sha256Schema,
    rightsAttestationDigest: sha256Schema,
    securityAuditDigest: sha256Schema,
    releaseEvidenceDigest: sha256Schema,
    releaseAuthorizationDigest: sha256Schema,
    trustPolicyDigest: sha256Schema,
    targetSotaClaimIds: z.array(identifierSchema).min(1),
    releasedSurfaceEntryIds: z.array(identifierSchema).min(1),
    finalizedAt: timestampSchema,
    production_overall: z.literal("go"),
    sota_overall: z.literal("go"),
  })
  .strict()
  .superRefine((audit, context) => {
    if (new Set(audit.releasedSurfaceEntryIds).size !== audit.releasedSurfaceEntryIds.length
      || !sameArray(audit.releasedSurfaceEntryIds, [...audit.releasedSurfaceEntryIds].sort())) {
      context.addIssue({
        code: "custom",
        path: ["releasedSurfaceEntryIds"],
        message: "released surface entries must be unique and sorted",
      });
    }
  });

export const releaseAuditEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-release-audit.v4"),
    audit: releaseAuditPayloadSchema,
    signature: detachedSignatureSchema,
  })
  .strict();

type SignedDocument = { document: unknown; signature: unknown };
type SignedSecurityAudit = SignedDocument & { sha256: string };
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
  securityAudit: SignedSecurityAudit;
  securityAuditBinding: ReleaseSecurityAuditBinding;
  securityAuditReadArtifact: SecurityAuditArtifactReader;
  reports: Array<SignedDocument & { kind: QualificationKind; sha256: string }>;
  trustPolicyDigest: string;
  qualificationTrustPolicy: unknown;
  qualificationTrustPolicyDigest: string;
  buildAuthorityAttestation: SignedDocument;
  authorityIsolationAttestation: SignedDocument;
  qualificationResolution: SignedDocument;
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
    Number.isNaN(nowMs) ||
    nowMs < parseTimestamp(key.notBefore) ||
    nowMs >= parseTimestamp(key.notAfter)
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
  if (nowMs < parseTimestamp(notBefore) || nowMs >= parseTimestamp(expiresAt)) {
    throw new Error(`${context} is outside its validity window`);
  }
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function verifyCurrentSignedSecurityAudit(
  securityAuditInput: SignedSecurityAudit,
  binding: ReleaseSecurityAuditBinding,
  readArtifact: SecurityAuditArtifactReader,
  policy: z.infer<typeof trustedKeyPolicySchema>,
  now: Date,
): {
  audit: ReturnType<typeof validateReleaseSecurityAuditEvidence>;
  digest: string;
} {
  const audit = validateReleaseSecurityAuditEvidence(
    securityAuditInput.document,
    binding,
    now,
    readArtifact,
  );
  const digest = verifyDetachedSignature(
    audit,
    securityAuditInput.signature,
    policy,
    "qualification-attestor",
    now,
  );
  if (digest !== securityAuditInput.sha256) {
    throw new Error("Security audit signed-document digest mismatch");
  }
  return { audit, digest };
}

type VerifiedQualificationExistingEvidence = {
  rightsAttestationDigest: string;
  securityAuditDigest: string;
  reportDigests: ReadonlyMap<QualificationKind, string>;
};

type VerifiedQualificationArtifacts = {
  manifestQualificationSha256: string;
  qualificationTrustPolicyDigest: string;
  buildAuthorityAttestationDigest: string;
  authorityIsolationAttestationDigest: string;
  qualificationResolutionDigest: string;
};

function verifyQualificationArtifacts(options: {
  now: Date;
  releaseDigest: string;
  surfaceDigest: string;
  runtimeTrust: z.infer<typeof runtimeTrustBindingSchema>;
  manifestQualification: unknown;
  releaseTrustPolicy: z.infer<typeof releaseTrustedKeyPolicySchema>;
  qualificationTrustPolicy: unknown;
  qualificationTrustPolicyDigest: string;
  buildAuthorityAttestation: SignedDocument;
  authorityIsolationAttestation: SignedDocument;
  qualificationResolution: SignedDocument;
  existingEvidence: VerifiedQualificationExistingEvidence;
}): VerifiedQualificationArtifacts {
  assertRuntimeTrustAuthorizesRelease(options.runtimeTrust, "Qualification resolution/Product GO");
  const qualification = manifestQualificationSchema.parse(options.manifestQualification);
  if (qualification.releaseDecision !== "hold" || qualification.blockers.length === 0) {
    throw new Error(
      "Qualification Resolution v2 requires the exact immutable manifest HOLD; legacy PASS cannot authorize v3 evidence",
    );
  }
  const nonDischargeable = qualification.blockers.filter((blocker) =>
    (nonDischargeableQualificationBlockers as readonly string[]).includes(blocker));
  if (nonDischargeable.length > 0) {
    throw new Error(`Manifest contains non-dischargeable qualification blockers: ${nonDischargeable.join(",")}`);
  }
  const unknown = qualification.blockers.filter((blocker) =>
    !(blocker in dischargeableQualificationBlockers));
  if (unknown.length > 0) {
    throw new Error(`Manifest contains unknown qualification blockers: ${unknown.join(",")}`);
  }

  const policy = qualificationResolutionTrustPolicySchema.parse(
    options.qualificationTrustPolicy,
  );
  const policyDigest = qualificationArtifactDigest(policy);
  if (policyDigest !== options.qualificationTrustPolicyDigest
    || policyDigest !== options.runtimeTrust.trustPolicyDigests.qualificationAuthorizer) {
    throw new Error("Qualification resolution trust policy does not match its RuntimeTrust pin");
  }
  const releaseKeyIds = new Set(options.releaseTrustPolicy.keys.map(({ keyId }) => keyId));
  const releasePublicKeys = new Set(
    options.releaseTrustPolicy.keys.map(({ publicKeyBase64 }) => publicKeyBase64),
  );
  if (policy.keys.some(({ keyId, publicKeyBase64 }) =>
    releaseKeyIds.has(keyId) || releasePublicKeys.has(publicKeyBase64))) {
    throw new Error(
      "Qualification resolver and evidence attestors must be key-separated from release evidence, authorization, and finalization",
    );
  }

  const buildSigned = signedBuildAuthorityAttestationSchema.parse(
    options.buildAuthorityAttestation,
  );
  const buildDigest = verifyQualificationArtifactSignature({
    ...buildSigned,
    policy,
    role: "build-authority-attestor",
    now: options.now,
  });
  assertQualificationArtifactCurrent(
    buildSigned.document,
    options.now,
    "Build authority attestation",
  );
  if (buildSigned.document.releaseDigest !== options.releaseDigest
    || buildSigned.document.surfaceDigest !== options.surfaceDigest
    || buildSigned.document.qualificationTrustPolicySha256 !== policyDigest
    || buildSigned.document.buildTcbSha256 !== options.runtimeTrust.buildTcbSha256
    || canonicalJson(buildSigned.document.runtimeTrust) !== canonicalJson(options.runtimeTrust)) {
    throw new Error("Build authority attestation is bound to another release, surface, RuntimeTrust, or Build-TCB");
  }

  const authoritySigned = signedAuthorityIsolationAttestationSchema.parse(
    options.authorityIsolationAttestation,
  );
  const authorityDigest = verifyQualificationArtifactSignature({
    ...authoritySigned,
    policy,
    role: "authority-isolation-attestor",
    now: options.now,
  });
  assertQualificationArtifactCurrent(
    authoritySigned.document,
    options.now,
    "Authority isolation attestation",
  );
  if (authoritySigned.document.releaseDigest !== options.releaseDigest
    || authoritySigned.document.surfaceDigest !== options.surfaceDigest
    || authoritySigned.document.qualificationTrustPolicySha256 !== policyDigest
    || authoritySigned.document.hostTcbAttestationSha256
      !== options.runtimeTrust.hostTcbAttestationSha256
    || canonicalJson(authoritySigned.document.runtimeTrust) !== canonicalJson(options.runtimeTrust)) {
    throw new Error("Authority isolation attestation is bound to another release, host, broker, or RuntimeTrust");
  }

  const reportDigest = (kind: QualificationKind): string => {
    const value = options.existingEvidence.reportDigests.get(kind);
    if (!value) throw new Error(`Verified qualification report is missing: ${kind}`);
    return value;
  };
  const evidence: QualificationEvidenceDigests = {
    "rights-attestation": options.existingEvidence.rightsAttestationDigest,
    "security-audit": options.existingEvidence.securityAuditDigest,
    "host-tcb-attestation": options.runtimeTrust.hostTcbAttestationSha256,
    "build-authority-attestation": buildDigest,
    "authority-isolation-attestation": authorityDigest,
    "r3-canaries-report": reportDigest("r3-canaries"),
    "d1-calibration-report": reportDigest("d1-calibration"),
    "q0-cross-shot-report": reportDigest("q0-cross-shot"),
    "q1-comparators-report": reportDigest("q1-comparators"),
    "q2-holdout-report": reportDigest("q2-holdout"),
  };

  const resolutionSigned = signedQualificationResolutionSchema.parse(
    options.qualificationResolution,
  );
  const resolutionDigest = verifyQualificationArtifactSignature({
    ...resolutionSigned,
    policy,
    role: "qualification-resolver",
    now: options.now,
  });
  assertQualificationArtifactCurrent(
    resolutionSigned.document,
    options.now,
    "Qualification resolution",
  );
  const manifestQualificationSha256 = sha256(qualification);
  const expected = expectedQualificationResolutions(qualification, evidence);
  if (resolutionSigned.document.releaseDigest !== options.releaseDigest
    || resolutionSigned.document.surfaceDigest !== options.surfaceDigest
    || resolutionSigned.document.manifestQualificationSha256 !== manifestQualificationSha256
    || resolutionSigned.document.qualificationTrustPolicySha256 !== policyDigest
    || canonicalJson(resolutionSigned.document.runtimeTrust) !== canonicalJson(options.runtimeTrust)
    || canonicalJson(resolutionSigned.document.resolutions) !== canonicalJson(expected)) {
    throw new Error(
      "Qualification resolution does not exactly bind the immutable HOLD and every verified typed evidence artifact",
    );
  }
  return {
    manifestQualificationSha256,
    qualificationTrustPolicyDigest: policyDigest,
    buildAuthorityAttestationDigest: buildDigest,
    authorityIsolationAttestationDigest: authorityDigest,
    qualificationResolutionDigest: resolutionDigest,
  };
}

function assertCurrentSecurityWindow(
  securityAudit: z.infer<typeof releaseEvidenceSchema>["securityAudit"],
  now: Date,
): void {
  const nowMs = now.getTime();
  const generatedAt = parseTimestamp(securityAudit.generatedAt);
  const cutoffAt = parseTimestamp(securityAudit.cutoffAt);
  const expiresAt = parseTimestamp(securityAudit.expiresAt);
  const maxAgeMs = 24 * 60 * 60 * 1000;
  if (
    generatedAt > nowMs ||
    cutoffAt > nowMs ||
    nowMs >= expiresAt ||
    nowMs - generatedAt > maxAgeMs ||
    nowMs - cutoffAt > maxAgeMs
  ) {
    throw new Error("Stale security audit: the 24-hour release window expired");
  }
}

export function collectReleaseEvidence(
  raw: ReleaseEvidenceInput,
): z.infer<typeof releaseEvidenceSchema> {
  if (Number.isNaN(raw.now.getTime())) throw new Error("Audit time is invalid");
  assertRuntimeTrustAuthorizesRelease(
    raw.securityAuditBinding.runtimeTrust,
    "Release evidence/Product GO",
  );
  const index = releaseEvidenceIndexSchema.parse(raw.index);
  const surface = candidateReleaseSurfaceSchema.parse(raw.surface);
  const policy = releaseTrustedKeyPolicySchema.parse(raw.trustPolicy);
  if (raw.releaseDigest !== index.releaseDigest)
    throw new Error("Index release digest mismatch");
  if (canonicalJson(index.runtimeTrust) !== canonicalJson(raw.securityAuditBinding.runtimeTrust)) {
    throw new Error("Index runtime trust binding mismatch");
  }
  if (sha256(surface) !== raw.manifestSurfaceDigest)
    throw new Error("Candidate surface digest mismatch");
  if (
    sha256(policy) !== raw.trustPolicyDigest ||
    index.trustPolicy.sha256 !== raw.trustPolicyDigest ||
    raw.trustPolicyDigest
      !== raw.securityAuditBinding.runtimeTrust.trustPolicyDigests.release
  ) {
    throw new Error("Trusted-key policy digest does not match its RuntimeTrust release pin");
  }

  const verifiedSecurityAudit = verifyCurrentSignedSecurityAudit(
    raw.securityAudit,
    raw.securityAuditBinding,
    raw.securityAuditReadArtifact,
    policy,
    raw.now,
  );
  const securityAudit = verifiedSecurityAudit.audit;
  const securityAuditDigest = verifiedSecurityAudit.digest;
  if (
    raw.securityAuditBinding.releaseDigest !== raw.releaseDigest ||
    securityAuditDigest !== raw.securityAudit.sha256 ||
    securityAuditDigest !== index.securityAudit.sha256
  ) {
    throw new Error("Security audit index or release binding mismatch");
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
    canonicalJson(rights.runtimeTrust) !== canonicalJson(raw.securityAuditBinding.runtimeTrust) ||
    parseTimestamp(rights.validAt) > raw.now.getTime() ||
    parseTimestamp(rights.expiresAt) <= raw.now.getTime()
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
      report.surfaceDigest !== raw.manifestSurfaceDigest ||
      canonicalJson(report.runtimeTrust) !== canonicalJson(raw.securityAuditBinding.runtimeTrust)
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
      const gateSet = coverage.get(entry.surfaceEntryId) ?? new Set<ReleaseGateId>();
      for (const gate of entry.gates) {
        if (finalQualificationGateOwner[gate] === report.kind) gateSet.add(gate);
      }
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
        `Candidate ${entry.id} lacks final-owner passing gates: ${missing.join(",")}`,
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

  const verifiedQualification = verifyQualificationArtifacts({
    now: raw.now,
    releaseDigest: raw.releaseDigest,
    surfaceDigest: raw.manifestSurfaceDigest,
    runtimeTrust: raw.securityAuditBinding.runtimeTrust,
    manifestQualification: raw.securityAuditBinding.manifestQualification,
    releaseTrustPolicy: policy,
    qualificationTrustPolicy: raw.qualificationTrustPolicy,
    qualificationTrustPolicyDigest: raw.qualificationTrustPolicyDigest,
    buildAuthorityAttestation: raw.buildAuthorityAttestation,
    authorityIsolationAttestation: raw.authorityIsolationAttestation,
    qualificationResolution: raw.qualificationResolution,
    existingEvidence: {
      rightsAttestationDigest: rightsDigest,
      securityAuditDigest,
      reportDigests: new Map(reportDigests.map(({ kind, sha256: digest }) => [kind, digest])),
    },
  });
  if (index.qualification.trustPolicy.sha256
      !== verifiedQualification.qualificationTrustPolicyDigest
    || index.qualification.buildAuthorityAttestation.sha256
      !== verifiedQualification.buildAuthorityAttestationDigest
    || index.qualification.authorityIsolationAttestation.sha256
      !== verifiedQualification.authorityIsolationAttestationDigest
    || index.qualification.resolution.sha256
      !== verifiedQualification.qualificationResolutionDigest
    || index.qualification.buildAuthorityAttestation.signatureSha256
      !== sha256(raw.buildAuthorityAttestation.signature)
    || index.qualification.authorityIsolationAttestation.signatureSha256
      !== sha256(raw.authorityIsolationAttestation.signature)
    || index.qualification.resolution.signatureSha256
      !== sha256(raw.qualificationResolution.signature)) {
    throw new Error("Qualification policy, attestation, resolution, or signature index binding mismatch");
  }

  return releaseEvidenceSchema.parse({
    schemaVersion: "ltx-studio-release-evidence.v3",
    releaseDigest: raw.releaseDigest,
    preregistrationDigest,
    surfaceDigest: raw.manifestSurfaceDigest,
    runtimeTrust: raw.securityAuditBinding.runtimeTrust,
    ...verifiedQualification,
    qualificationArtifacts: {
      trustPolicy: qualificationResolutionTrustPolicySchema.parse(raw.qualificationTrustPolicy),
      buildAuthorityAttestation: signedBuildAuthorityAttestationSchema.parse(
        raw.buildAuthorityAttestation,
      ),
      authorityIsolationAttestation: signedAuthorityIsolationAttestationSchema.parse(
        raw.authorityIsolationAttestation,
      ),
      resolution: signedQualificationResolutionSchema.parse(raw.qualificationResolution),
    },
    rightsAttestationDigest: rightsDigest,
    securityAudit: {
      sha256: securityAuditDigest,
      generatedAt: securityAudit.generatedAt,
      cutoffAt: securityAudit.cutoffAt,
      expiresAt: securityAudit.expiresAt,
    },
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
  securityAudit: SignedSecurityAudit;
  securityAuditBinding: ReleaseSecurityAuditBinding;
  securityAuditReadArtifact: SecurityAuditArtifactReader;
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
  assertRuntimeTrustAuthorizesRelease(
    raw.securityAuditBinding.runtimeTrust,
    "Release finalization/Product GO",
  );
  const evidence = releaseEvidenceSchema.parse(raw.evidence);
  if (sha256(evidence) !== raw.evidenceDigest)
    throw new Error("Release evidence digest mismatch");
  assertCurrentSecurityWindow(evidence.securityAudit, raw.now);
  const policy = releaseTrustedKeyPolicySchema.parse(raw.trustPolicy);
  if (
    sha256(policy) !== raw.trustPolicyDigest ||
    evidence.trustPolicyDigest !== raw.trustPolicyDigest ||
    raw.trustPolicyDigest
      !== raw.securityAuditBinding.runtimeTrust.trustPolicyDigests.release
  ) {
    throw new Error("Finalizer trusted-key policy does not match its RuntimeTrust release pin");
  }
  const verifiedSecurityAudit = verifyCurrentSignedSecurityAudit(
    raw.securityAudit,
    raw.securityAuditBinding,
    raw.securityAuditReadArtifact,
    policy,
    raw.now,
  );
  if (
    raw.securityAuditBinding.releaseDigest !== evidence.releaseDigest ||
    verifiedSecurityAudit.digest !== evidence.securityAudit.sha256 ||
    verifiedSecurityAudit.audit.generatedAt !== evidence.securityAudit.generatedAt ||
    verifiedSecurityAudit.audit.cutoffAt !== evidence.securityAudit.cutoffAt ||
    verifiedSecurityAudit.audit.expiresAt !== evidence.securityAudit.expiresAt
  ) {
    throw new Error("Finalizer security audit binding mismatch");
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
    rights.releaseDigest !== evidence.releaseDigest ||
    rights.surfaceDigest !== evidence.surfaceDigest
  ) {
    throw new Error("Finalizer rights attestation binding mismatch");
  }
  assertCurrentWindow(
    rights.validAt,
    rights.expiresAt,
    raw.now,
    "Rights attestation",
  );

  const verifiedQualification = verifyQualificationArtifacts({
    now: raw.now,
    releaseDigest: evidence.releaseDigest,
    surfaceDigest: evidence.surfaceDigest,
    runtimeTrust: raw.securityAuditBinding.runtimeTrust,
    manifestQualification: raw.securityAuditBinding.manifestQualification,
    releaseTrustPolicy: policy,
    qualificationTrustPolicy: evidence.qualificationArtifacts.trustPolicy,
    qualificationTrustPolicyDigest: evidence.qualificationTrustPolicyDigest,
    buildAuthorityAttestation: evidence.qualificationArtifacts.buildAuthorityAttestation,
    authorityIsolationAttestation: evidence.qualificationArtifacts.authorityIsolationAttestation,
    qualificationResolution: evidence.qualificationArtifacts.resolution,
    existingEvidence: {
      rightsAttestationDigest: rightsDigest,
      securityAuditDigest: evidence.securityAudit.sha256,
      reportDigests: new Map(evidence.reports.map(({ kind, sha256: digest }) => [kind, digest])),
    },
  });
  if (canonicalJson(verifiedQualification) !== canonicalJson({
    manifestQualificationSha256: evidence.manifestQualificationSha256,
    qualificationTrustPolicyDigest: evidence.qualificationTrustPolicyDigest,
    buildAuthorityAttestationDigest: evidence.buildAuthorityAttestationDigest,
    authorityIsolationAttestationDigest: evidence.authorityIsolationAttestationDigest,
    qualificationResolutionDigest: evidence.qualificationResolutionDigest,
  })) {
    throw new Error("Finalizer qualification resolution binding mismatch");
  }

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
    authorization.activationGeneration < 1 ||
    authorization.releaseDigest !== evidence.releaseDigest ||
    authorization.surfaceDigest !== evidence.surfaceDigest ||
    authorization.runtimeInstallSealSha256 !== raw.securityAuditBinding.runtimeInstallSealSha256 ||
    authorization.runtimeTreeSha256 !== raw.securityAuditBinding.runtimeTreeSha256 ||
    authorization.runtimePolicySha256 !== raw.securityAuditBinding.runtimePolicySha256 ||
    authorization.nodeExecutableSha256 !== raw.securityAuditBinding.nodeExecutableSha256 ||
    canonicalJson(authorization.runtimeTrust) !== canonicalJson(raw.securityAuditBinding.runtimeTrust) ||
    canonicalJson(evidence.runtimeTrust) !== canonicalJson(raw.securityAuditBinding.runtimeTrust) ||
    canonicalJson(rights.runtimeTrust) !== canonicalJson(raw.securityAuditBinding.runtimeTrust) ||
    authorization.manifestQualificationSha256 !== evidence.manifestQualificationSha256 ||
    authorization.qualificationTrustPolicyDigest !== evidence.qualificationTrustPolicyDigest ||
    authorization.buildAuthorityAttestationDigest !== evidence.buildAuthorityAttestationDigest ||
    authorization.authorityIsolationAttestationDigest !== evidence.authorityIsolationAttestationDigest ||
    authorization.qualificationResolutionDigest !== evidence.qualificationResolutionDigest ||
    authorization.preregistrationDigest !== evidence.preregistrationDigest ||
    authorization.q2ReportDigest !== q2ReportDigest ||
    authorization.releaseEvidenceDigest !== raw.evidenceDigest ||
    authorization.rightsAttestationDigest !== rightsDigest ||
    authorization.securityAuditDigest !== evidence.securityAudit.sha256 ||
    !sameArray(authorization.releasedSurfaceEntryIds, evidence.candidateSurfaceEntryIds)
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
    schemaVersion: "ltx-studio-release-audit-payload.v4",
    activationGeneration: authorization.activationGeneration,
    releaseDigest: evidence.releaseDigest,
    surfaceDigest: evidence.surfaceDigest,
    runtimeInstallSealSha256: authorization.runtimeInstallSealSha256,
    runtimeTreeSha256: authorization.runtimeTreeSha256,
    runtimePolicySha256: authorization.runtimePolicySha256,
    nodeExecutableSha256: authorization.nodeExecutableSha256,
    runtimeTrust: authorization.runtimeTrust,
    manifestQualificationSha256: authorization.manifestQualificationSha256,
    qualificationTrustPolicyDigest: authorization.qualificationTrustPolicyDigest,
    buildAuthorityAttestationDigest: authorization.buildAuthorityAttestationDigest,
    authorityIsolationAttestationDigest: authorization.authorityIsolationAttestationDigest,
    qualificationResolutionDigest: authorization.qualificationResolutionDigest,
    preregistrationDigest: evidence.preregistrationDigest,
    q2ReportDigest,
    rightsAttestationDigest: rightsDigest,
    securityAuditDigest: evidence.securityAudit.sha256,
    releaseEvidenceDigest: raw.evidenceDigest,
    releaseAuthorizationDigest: authorizationDigest,
    trustPolicyDigest: raw.trustPolicyDigest,
    targetSotaClaimIds: evidence.targetSotaClaimIds,
    releasedSurfaceEntryIds: authorization.releasedSurfaceEntryIds,
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
    schemaVersion: "ltx-studio-release-audit.v4",
    audit: payload,
    signature,
  });
}

export function verifyReleasePromotionBundle(raw: {
  now: Date;
  expectedGeneration: number;
  expectedReleaseDigest: string;
  expectedSurfaceDigest: string;
  expectedRuntimeInstallSealSha256: string;
  expectedRuntimeTreeSha256: string;
  expectedRuntimePolicySha256: string;
  expectedNodeExecutableSha256: string;
  expectedRuntimeTrust: z.infer<typeof runtimeTrustBindingSchema>;
  expectedRightsPolicyEvidenceDigest: string;
  expectedReleasedSurfaceEntryIds: readonly string[];
  evidence: unknown;
  evidenceDigest: string;
  authorization: SignedDocument;
  auditEnvelope: unknown;
  rightsAttestation: SignedDocument;
  securityAudit: SignedSecurityAudit;
  securityAuditBinding: ReleaseSecurityAuditBinding;
  securityAuditReadArtifact: SecurityAuditArtifactReader;
  trustPolicy: unknown;
  trustPolicyDigest: string;
}): {
  authorizationDigest: string;
  auditEnvelopeDigest: string;
  rightsAttestationDigest: string;
  releasedSurfaceEntryIds: string[];
} {
  assertRuntimeTrustAuthorizesRelease(
    raw.expectedRuntimeTrust,
    "Release promotion/Product GO",
  );
  const policy = releaseTrustedKeyPolicySchema.parse(raw.trustPolicy);
  if (sha256(policy) !== raw.trustPolicyDigest
    || raw.trustPolicyDigest !== raw.expectedRuntimeTrust.trustPolicyDigests.release) {
    throw new Error("Promotion trusted-key policy does not match its RuntimeTrust release pin");
  }
  const evidence = releaseEvidenceSchema.parse(raw.evidence);
  if (sha256(evidence) !== raw.evidenceDigest) {
    throw new Error("Promotion release-evidence digest mismatch");
  }
  if (evidence.trustPolicyDigest !== raw.trustPolicyDigest) {
    throw new Error("Promotion release-evidence trust-policy mismatch");
  }
  assertCurrentSecurityWindow(evidence.securityAudit, raw.now);
  const verifiedSecurityAudit = verifyCurrentSignedSecurityAudit(
    raw.securityAudit,
    raw.securityAuditBinding,
    raw.securityAuditReadArtifact,
    policy,
    raw.now,
  );
  if (
    raw.securityAuditBinding.releaseDigest !== raw.expectedReleaseDigest ||
    raw.securityAuditBinding.runtimeInstallSealSha256 !== raw.expectedRuntimeInstallSealSha256 ||
    raw.securityAuditBinding.runtimeTreeSha256 !== raw.expectedRuntimeTreeSha256 ||
    raw.securityAuditBinding.runtimePolicySha256 !== raw.expectedRuntimePolicySha256 ||
    raw.securityAuditBinding.nodeExecutableSha256 !== raw.expectedNodeExecutableSha256 ||
    canonicalJson(raw.securityAuditBinding.runtimeTrust) !== canonicalJson(raw.expectedRuntimeTrust) ||
    verifiedSecurityAudit.digest !== evidence.securityAudit.sha256 ||
    verifiedSecurityAudit.audit.generatedAt !== evidence.securityAudit.generatedAt ||
    verifiedSecurityAudit.audit.cutoffAt !== evidence.securityAudit.cutoffAt ||
    verifiedSecurityAudit.audit.expiresAt !== evidence.securityAudit.expiresAt
  ) {
    throw new Error("Promotion security audit binding mismatch");
  }
  const authorization = releaseAuthorizationSchema.parse(raw.authorization.document);
  const authorizationSignature = detachedSignatureSchema.parse(raw.authorization.signature);
  const authorizationDigest = verifyDetachedSignature(
    authorization,
    authorizationSignature,
    policy,
    "release-authorizer",
    raw.now,
  );
  assertCurrentWindow(authorization.notBefore, authorization.expiresAt, raw.now, "Release authorization");

  const auditEnvelope = releaseAuditEnvelopeSchema.parse(raw.auditEnvelope);
  verifyDetachedSignature(
    auditEnvelope.audit,
    auditEnvelope.signature,
    policy,
    "audit-finalizer",
    raw.now,
  );
  if (auditEnvelope.signature.keyId === authorizationSignature.keyId) {
    throw new Error("Promotion release-authorizer and audit-finalizer keys must differ");
  }
  if (Date.parse(auditEnvelope.audit.finalizedAt) > raw.now.getTime()) {
    throw new Error("Promotion audit finalization time is in the future");
  }

  const rights = rightsAttestationSchema.parse(raw.rightsAttestation.document);
  const rightsDigest = verifyDetachedSignature(
    rights,
    raw.rightsAttestation.signature,
    policy,
    "rights-attestor",
    raw.now,
  );
  assertCurrentWindow(rights.validAt, rights.expiresAt, raw.now, "Rights attestation");
  const verifiedQualification = verifyQualificationArtifacts({
    now: raw.now,
    releaseDigest: evidence.releaseDigest,
    surfaceDigest: evidence.surfaceDigest,
    runtimeTrust: raw.expectedRuntimeTrust,
    manifestQualification: raw.securityAuditBinding.manifestQualification,
    releaseTrustPolicy: policy,
    qualificationTrustPolicy: evidence.qualificationArtifacts.trustPolicy,
    qualificationTrustPolicyDigest: evidence.qualificationTrustPolicyDigest,
    buildAuthorityAttestation: evidence.qualificationArtifacts.buildAuthorityAttestation,
    authorityIsolationAttestation: evidence.qualificationArtifacts.authorityIsolationAttestation,
    qualificationResolution: evidence.qualificationArtifacts.resolution,
    existingEvidence: {
      rightsAttestationDigest: rightsDigest,
      securityAuditDigest: evidence.securityAudit.sha256,
      reportDigests: new Map(evidence.reports.map(({ kind, sha256: digest }) => [kind, digest])),
    },
  });
  const q2ReportDigest = evidence.reports.find(({ kind }) => kind === "q2-holdout")?.sha256;
  const expectedEntries = [...raw.expectedReleasedSurfaceEntryIds];
  if (!q2ReportDigest
    || raw.expectedGeneration !== authorization.activationGeneration
    || raw.expectedReleaseDigest !== evidence.releaseDigest
    || raw.expectedSurfaceDigest !== evidence.surfaceDigest
    || raw.expectedRightsPolicyEvidenceDigest !== rights.evidenceCatalogDigest
    || rights.releaseDigest !== raw.expectedReleaseDigest
    || rights.surfaceDigest !== raw.expectedSurfaceDigest
    || evidence.rightsAttestationDigest !== rightsDigest
    || authorization.releaseDigest !== evidence.releaseDigest
    || authorization.surfaceDigest !== evidence.surfaceDigest
    || authorization.runtimeInstallSealSha256 !== raw.expectedRuntimeInstallSealSha256
    || authorization.runtimeTreeSha256 !== raw.expectedRuntimeTreeSha256
    || authorization.runtimePolicySha256 !== raw.expectedRuntimePolicySha256
    || authorization.nodeExecutableSha256 !== raw.expectedNodeExecutableSha256
    || canonicalJson(authorization.runtimeTrust) !== canonicalJson(raw.expectedRuntimeTrust)
    || canonicalJson(evidence.runtimeTrust) !== canonicalJson(raw.expectedRuntimeTrust)
    || canonicalJson(rights.runtimeTrust) !== canonicalJson(raw.expectedRuntimeTrust)
    || canonicalJson(verifiedQualification) !== canonicalJson({
      manifestQualificationSha256: evidence.manifestQualificationSha256,
      qualificationTrustPolicyDigest: evidence.qualificationTrustPolicyDigest,
      buildAuthorityAttestationDigest: evidence.buildAuthorityAttestationDigest,
      authorityIsolationAttestationDigest: evidence.authorityIsolationAttestationDigest,
      qualificationResolutionDigest: evidence.qualificationResolutionDigest,
    })
    || authorization.manifestQualificationSha256 !== evidence.manifestQualificationSha256
    || authorization.qualificationTrustPolicyDigest !== evidence.qualificationTrustPolicyDigest
    || authorization.buildAuthorityAttestationDigest !== evidence.buildAuthorityAttestationDigest
    || authorization.authorityIsolationAttestationDigest !== evidence.authorityIsolationAttestationDigest
    || authorization.qualificationResolutionDigest !== evidence.qualificationResolutionDigest
    || authorization.preregistrationDigest !== evidence.preregistrationDigest
    || authorization.q2ReportDigest !== q2ReportDigest
    || authorization.releaseEvidenceDigest !== raw.evidenceDigest
    || authorization.rightsAttestationDigest !== rightsDigest
    || authorization.securityAuditDigest !== evidence.securityAudit.sha256
    || !sameArray(authorization.releasedSurfaceEntryIds, expectedEntries)
    || auditEnvelope.audit.activationGeneration !== authorization.activationGeneration
    || auditEnvelope.audit.releaseDigest !== authorization.releaseDigest
    || auditEnvelope.audit.surfaceDigest !== authorization.surfaceDigest
    || auditEnvelope.audit.runtimeInstallSealSha256 !== authorization.runtimeInstallSealSha256
    || auditEnvelope.audit.runtimeTreeSha256 !== authorization.runtimeTreeSha256
    || auditEnvelope.audit.runtimePolicySha256 !== authorization.runtimePolicySha256
    || auditEnvelope.audit.nodeExecutableSha256 !== authorization.nodeExecutableSha256
    || canonicalJson(auditEnvelope.audit.runtimeTrust) !== canonicalJson(authorization.runtimeTrust)
    || auditEnvelope.audit.manifestQualificationSha256 !== authorization.manifestQualificationSha256
    || auditEnvelope.audit.qualificationTrustPolicyDigest !== authorization.qualificationTrustPolicyDigest
    || auditEnvelope.audit.buildAuthorityAttestationDigest !== authorization.buildAuthorityAttestationDigest
    || auditEnvelope.audit.authorityIsolationAttestationDigest !== authorization.authorityIsolationAttestationDigest
    || auditEnvelope.audit.qualificationResolutionDigest !== authorization.qualificationResolutionDigest
    || auditEnvelope.audit.preregistrationDigest !== authorization.preregistrationDigest
    || auditEnvelope.audit.q2ReportDigest !== authorization.q2ReportDigest
    || auditEnvelope.audit.rightsAttestationDigest !== rightsDigest
    || auditEnvelope.audit.securityAuditDigest !== evidence.securityAudit.sha256
    || auditEnvelope.audit.releaseEvidenceDigest !== raw.evidenceDigest
    || auditEnvelope.audit.releaseAuthorizationDigest !== authorizationDigest
    || auditEnvelope.audit.trustPolicyDigest !== raw.trustPolicyDigest
    || !sameArray(auditEnvelope.audit.targetSotaClaimIds, evidence.targetSotaClaimIds)
    || !sameArray(auditEnvelope.audit.releasedSurfaceEntryIds, expectedEntries)) {
    throw new Error("Promotion authorization, audit, rights, or release binding mismatch");
  }
  return {
    authorizationDigest,
    auditEnvelopeDigest: sha256(auditEnvelope),
    rightsAttestationDigest: rightsDigest,
    releasedSurfaceEntryIds: [...authorization.releasedSurfaceEntryIds],
  };
}
