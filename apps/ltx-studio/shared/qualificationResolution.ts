import {
  createHash,
  createPublicKey,
  verify,
} from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";
import { runtimeTrustBindingSchema } from "./runtimeTrust.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const identifierSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });
const MAX_QUALIFICATION_ARTIFACT_AGE_MS = 24 * 60 * 60 * 1_000;

const ed25519PublicKeySchema = z.string().min(1).max(128).refine((value) => {
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value;
}, "Ed25519 public key must be canonical base64 for exactly 32 bytes");

function addBoundedWindowIssues(
  value: { issuedAt: string; expiresAt: string },
  context: z.RefinementCtx,
): void {
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (issuedAt >= expiresAt || expiresAt - issuedAt > MAX_QUALIFICATION_ARTIFACT_AGE_MS) {
    context.addIssue({
      code: "custom",
      path: ["expiresAt"],
      message: "qualification artifact validity must be positive and no longer than 24 hours",
    });
  }
}

export const manifestQualificationSchema = z.object({
  releaseDecision: z.enum(["pass", "hold"]),
  blockers: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{2,127}$/)),
}).strict().superRefine((qualification, context) => {
  if (new Set(qualification.blockers).size !== qualification.blockers.length
    || (qualification.releaseDecision === "pass") !== (qualification.blockers.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["blockers"],
      message: "manifest qualification decision and blockers are inconsistent",
    });
  }
});

export type ManifestQualification = z.infer<typeof manifestQualificationSchema>;

export const qualificationEvidenceKinds = [
  "rights-attestation",
  "security-audit",
  "host-tcb-attestation",
  "build-authority-attestation",
  "authority-isolation-attestation",
  "r3-canaries-report",
  "d1-calibration-report",
  "q0-cross-shot-report",
  "q1-comparators-report",
  "q2-holdout-report",
] as const;

export type QualificationEvidenceKind = (typeof qualificationEvidenceKinds)[number];

/**
 * Complete immutable-manifest blocker contract. Independent tests must not
 * derive their expected inventory from this map.
 */
export const dischargeableQualificationBlockers = {
  "current-signed-rights-attest-missing": ["rights-attestation"],
  "signed-build-host-container-scan-reports-missing": ["security-audit"],
  "root-owned-post-install-host-attestation-missing": ["host-tcb-attestation"],
  "dedicated-external-build-authority-attestation-missing": ["build-authority-attestation"],
  "read-only-build-source-mount-not-independently-attested": ["build-authority-attestation"],
  "separate-build-uid-isolation-not-independently-attested": ["build-authority-attestation"],
  "same-uid-transient-source-or-tool-swap-not-excluded": ["build-authority-attestation"],
  "privileged-sudo-docker-control-plane-broker-missing": ["authority-isolation-attestation"],
  "digest-bound-cold-canary-missing": ["r3-canaries-report"],
  "quality-and-holdout-evidence-missing": [
    "d1-calibration-report",
    "q0-cross-shot-report",
    "q1-comparators-report",
    "q2-holdout-report",
  ],
} as const satisfies Record<string, readonly QualificationEvidenceKind[]>;

export type DischargeableQualificationBlocker = keyof typeof dischargeableQualificationBlockers;

export const nonDischargeableQualificationBlockers = [
  "longcat-runtime-worktree-dirty",
] as const;

export const buildAuthorityResolvedBlockers = [
  "dedicated-external-build-authority-attestation-missing",
  "read-only-build-source-mount-not-independently-attested",
  "same-uid-transient-source-or-tool-swap-not-excluded",
  "separate-build-uid-isolation-not-independently-attested",
] as const;

export const qualificationResolutionTrustRoles = [
  "build-authority-attestor",
  "authority-isolation-attestor",
  "qualification-resolver",
] as const;

export type QualificationResolutionTrustRole =
  (typeof qualificationResolutionTrustRoles)[number];

export const qualificationResolutionTrustPolicySchema = z.object({
  schemaVersion: z.literal("ltx-studio-qualification-resolution-trust.v1"),
  policyId: identifierSchema,
  keys: z.array(z.object({
    keyId: identifierSchema,
    algorithm: z.literal("ed25519"),
    role: z.enum(qualificationResolutionTrustRoles),
    publicKeyBase64: ed25519PublicKeySchema,
    notBefore: timestampSchema,
    notAfter: timestampSchema,
    revokedAt: timestampSchema.nullable(),
  }).strict()).length(qualificationResolutionTrustRoles.length),
}).strict().superRefine((policy, context) => {
  const keyIds = policy.keys.map(({ keyId }) => keyId);
  const publicKeys = policy.keys.map(({ publicKeyBase64 }) => publicKeyBase64);
  const roles = policy.keys.map(({ role }) => role);
  if (new Set(keyIds).size !== keyIds.length) {
    context.addIssue({ code: "custom", path: ["keys"], message: "qualification key ids must be unique" });
  }
  if (new Set(publicKeys).size !== publicKeys.length) {
    context.addIssue({ code: "custom", path: ["keys"], message: "qualification key material must be unique" });
  }
  if (new Set(roles).size !== qualificationResolutionTrustRoles.length
    || qualificationResolutionTrustRoles.some((role) => !roles.includes(role))) {
    context.addIssue({
      code: "custom",
      path: ["keys"],
      message: "exactly one dedicated key is required for every qualification resolution role",
    });
  }
  for (const [index, key] of policy.keys.entries()) {
    if (Date.parse(key.notBefore) >= Date.parse(key.notAfter)) {
      context.addIssue({
        code: "custom",
        path: ["keys", index, "notAfter"],
        message: "qualification key validity window is inconsistent",
      });
    }
  }
});

export const qualificationResolutionSignatureSchema = z.object({
  schemaVersion: z.literal("ltx-studio-qualification-resolution-signature.v1"),
  algorithm: z.literal("ed25519"),
  role: z.enum(qualificationResolutionTrustRoles),
  keyId: identifierSchema,
  payloadSha256: sha256Schema,
  signatureBase64: z.string().min(1),
}).strict();

const signedQualificationDocumentSchema = <T extends z.ZodType>(document: T) => z.object({
  document,
  signature: qualificationResolutionSignatureSchema,
}).strict();

const exactResolvedBlockersSchema = <T extends readonly [string, ...string[]]>(expected: T) => z
  .array(z.string())
  .length(expected.length)
  .superRefine((actual, context) => {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      context.addIssue({ code: "custom", message: "attestation blocker claims are not exact or sorted" });
    }
  });

export const buildAuthorityAttestationSchema = z.object({
  schemaVersion: z.literal("ltx-studio-build-authority-attestation.v1"),
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  runtimeTrust: runtimeTrustBindingSchema,
  qualificationTrustPolicySha256: sha256Schema,
  buildTcbSha256: sha256Schema,
  claims: z.object({
    dedicatedExternalBuildAuthority: z.literal(true),
    readOnlyBuildSourceMount: z.literal(true),
    separateBuildUid: z.literal(true),
    transientSourceAndToolSwapExcluded: z.literal(true),
  }).strict(),
  resolvedBlockers: exactResolvedBlockersSchema(buildAuthorityResolvedBlockers),
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  verdict: z.literal("pass"),
  warnings: z.array(z.string()).length(0),
}).strict().superRefine((attestation, context) => {
  addBoundedWindowIssues(attestation, context);
  if (attestation.buildTcbSha256 !== attestation.runtimeTrust.buildTcbSha256) {
    context.addIssue({
      code: "custom",
      path: ["buildTcbSha256"],
      message: "build authority attestation must bind the exact RuntimeTrust Build-TCB",
    });
  }
});

export const authorityIsolationAttestationSchema = z.object({
  schemaVersion: z.literal("ltx-studio-authority-isolation-attestation.v1"),
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  runtimeTrust: runtimeTrustBindingSchema,
  qualificationTrustPolicySha256: sha256Schema,
  hostTcbAttestationSha256: sha256Schema,
  mechanism: z.enum([
    "separate-studio-identity-proc-fd-isolation",
    "external-signer-sealed-fd-broker",
  ]),
  brokerAttestationSha256: sha256Schema.nullable(),
  privilegedControlPlaneIsolationAttested: z.literal(true),
  resolvedBlockers: exactResolvedBlockersSchema([
    "privileged-sudo-docker-control-plane-broker-missing",
  ] as const),
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  verdict: z.literal("pass"),
  warnings: z.array(z.string()).length(0),
}).strict().superRefine((attestation, context) => {
  addBoundedWindowIssues(attestation, context);
  const isolation = attestation.runtimeTrust.authorityIsolation;
  if (isolation.status !== "attested"
    || attestation.hostTcbAttestationSha256 !== attestation.runtimeTrust.hostTcbAttestationSha256
    || attestation.mechanism !== isolation.mechanism
    || attestation.brokerAttestationSha256
      !== (isolation.mechanism === "external-signer-sealed-fd-broker"
        ? isolation.brokerAttestationSha256
        : null)) {
    context.addIssue({
      code: "custom",
      path: ["mechanism"],
      message: "authority isolation attestation does not exactly bind RuntimeTrust host and broker authority",
    });
  }
});

const evidenceReferenceSchema = z.object({
  kind: z.enum(qualificationEvidenceKinds),
  sha256: sha256Schema,
}).strict();

const blockerResolutionSchema = z.object({
  blocker: z.string().regex(/^[a-z0-9][a-z0-9-]{2,127}$/),
  evidence: z.array(evidenceReferenceSchema).min(1),
}).strict().superRefine((resolution, context) => {
  const kinds = resolution.evidence.map(({ kind }) => kind);
  if (new Set(kinds).size !== kinds.length
    || kinds.some((kind, index) => index > 0 && kinds[index - 1]! >= kind)) {
    context.addIssue({
      code: "custom",
      path: ["evidence"],
      message: "resolution evidence kinds must be unique and sorted",
    });
  }
});

export const qualificationResolutionSchema = z.object({
  schemaVersion: z.literal("ltx-studio-qualification-resolution.v2"),
  releaseDigest: sha256Schema,
  surfaceDigest: sha256Schema,
  manifestQualificationSha256: sha256Schema,
  runtimeTrust: runtimeTrustBindingSchema,
  qualificationTrustPolicySha256: sha256Schema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  resolutions: z.array(blockerResolutionSchema).min(1),
  unresolvedBlockers: z.array(z.string()).length(0),
  verdict: z.literal("pass"),
  warnings: z.array(z.string()).length(0),
}).strict().superRefine((resolution, context) => {
  const blockers = resolution.resolutions.map(({ blocker }) => blocker);
  if (new Set(blockers).size !== blockers.length
    || blockers.some((blocker, index) => index > 0 && blockers[index - 1]! >= blocker)) {
    context.addIssue({
      code: "custom",
      path: ["resolutions"],
      message: "resolved blockers must be unique and sorted",
    });
  }
  addBoundedWindowIssues(resolution, context);
});

export const signedBuildAuthorityAttestationSchema = signedQualificationDocumentSchema(
  buildAuthorityAttestationSchema,
);
export const signedAuthorityIsolationAttestationSchema = signedQualificationDocumentSchema(
  authorityIsolationAttestationSchema,
);
export const signedQualificationResolutionSchema = signedQualificationDocumentSchema(
  qualificationResolutionSchema,
);

export type QualificationResolution = z.infer<typeof qualificationResolutionSchema>;
export type QualificationResolutionTrustPolicy = z.infer<
  typeof qualificationResolutionTrustPolicySchema
>;

export type QualificationEvidenceDigests = Readonly<Record<QualificationEvidenceKind, string>>;

export function qualificationArtifactDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function assertQualificationArtifactCurrent(
  value: { issuedAt: string; expiresAt: string },
  now: Date,
  context: string,
): void {
  const nowMs = now.getTime();
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (Number.isNaN(nowMs) || nowMs < issuedAt || nowMs >= expiresAt
    || expiresAt - issuedAt > MAX_QUALIFICATION_ARTIFACT_AGE_MS) {
    throw new Error(`${context} is stale, future-dated, or outside its exclusive validity window`);
  }
}

export function verifyQualificationArtifactSignature(options: {
  document: unknown;
  signature: unknown;
  policy: QualificationResolutionTrustPolicy;
  role: QualificationResolutionTrustRole;
  now: Date;
}): string {
  const signature = qualificationResolutionSignatureSchema.parse(options.signature);
  const digest = qualificationArtifactDigest(options.document);
  if (signature.payloadSha256 !== digest || signature.role !== options.role) {
    throw new Error("Qualification artifact signature payload or role binding mismatch");
  }
  const key = options.policy.keys.find(({ keyId }) => keyId === signature.keyId);
  if (!key || key.role !== options.role) {
    throw new Error(`Qualification signature key lacks dedicated role: ${options.role}`);
  }
  const nowMs = options.now.getTime();
  if (Number.isNaN(nowMs)
    || nowMs < Date.parse(key.notBefore)
    || nowMs >= Date.parse(key.notAfter)) {
    throw new Error(`Qualification ${options.role} key is outside its exclusive validity window`);
  }
  if (key.revokedAt && Date.parse(key.revokedAt) <= nowMs) {
    throw new Error(`Qualification ${options.role} key is revoked`);
  }
  const rawKey = Buffer.from(key.publicKeyBase64, "base64");
  const rawSignature = Buffer.from(signature.signatureBase64, "base64");
  if (rawKey.length !== 32 || rawSignature.length !== 64
    || rawKey.toString("base64") !== key.publicKeyBase64
    || rawSignature.toString("base64") !== signature.signatureBase64) {
    throw new Error("Qualification Ed25519 key or signature encoding is invalid");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, Buffer.from(canonicalJson(options.document)), publicKey, rawSignature)) {
    throw new Error("Qualification detached Ed25519 signature is invalid");
  }
  return digest;
}

/** Structural only: callers must first verify every referenced signed artifact. */
export function expectedQualificationResolutions(
  qualification: ManifestQualification,
  evidence: QualificationEvidenceDigests,
): QualificationResolution["resolutions"] {
  return qualification.blockers.map((blocker) => {
    const kinds = dischargeableQualificationBlockers[
      blocker as DischargeableQualificationBlocker
    ];
    if (!kinds) throw new Error(`Unknown qualification blocker: ${blocker}`);
    return {
      blocker,
      evidence: [...kinds].sort().map((kind) => ({ kind, sha256: evidence[kind] })),
    };
  }).sort((left, right) => left.blocker < right.blocker ? -1 : left.blocker > right.blocker ? 1 : 0);
}
