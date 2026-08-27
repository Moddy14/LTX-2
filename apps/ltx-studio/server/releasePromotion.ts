import {
  validateActivationJournal,
  type ActivationReleaseBinding,
} from "../shared/activation.js";
import { canonicalJson } from "../shared/canonicalJson.js";
import { verifyReleasePromotionBundle } from "../shared/releaseAudit.js";
import type {
  ReleaseSecurityAuditBinding,
  SecurityAuditArtifactReader,
} from "../shared/securityAudit.js";

export function validateReleasePromotion(options: {
  now: Date;
  journal: unknown;
  expectedGeneration: number;
  expectedRelease: ActivationReleaseBinding;
  expectedReleasedSurfaceEntryIds: readonly string[];
  evidence: unknown;
  evidenceDigest: string;
  authorization: { document: unknown; signature: unknown };
  auditEnvelope: unknown;
  rightsAttestation: { document: unknown; signature: unknown };
  securityAudit: {
    document: unknown;
    signature: unknown;
    sha256: string;
  };
  securityAuditBinding: ReleaseSecurityAuditBinding;
  securityAuditReadArtifact: SecurityAuditArtifactReader;
  trustPolicy: unknown;
  trustPolicyDigest: string;
}) {
  const verified = verifyReleasePromotionBundle({
    now: options.now,
    expectedGeneration: options.expectedGeneration,
    expectedReleaseDigest: options.expectedRelease.releaseDigest,
    expectedSurfaceDigest: options.expectedRelease.surfaceDigest,
    expectedRuntimeInstallSealSha256: options.expectedRelease.runtimeInstallSealSha256,
    expectedRuntimeTreeSha256: options.expectedRelease.runtimeTreeSha256,
    expectedRuntimePolicySha256: options.expectedRelease.runtimePolicySha256,
    expectedNodeExecutableSha256: options.expectedRelease.nodeExecutableSha256,
    expectedRuntimeTrust: options.expectedRelease.runtimeTrust,
    expectedRightsPolicyEvidenceDigest: options.expectedRelease.rights.policyEvidenceDigest,
    expectedReleasedSurfaceEntryIds: options.expectedReleasedSurfaceEntryIds,
    evidence: options.evidence,
    evidenceDigest: options.evidenceDigest,
    authorization: options.authorization,
    auditEnvelope: options.auditEnvelope,
    rightsAttestation: options.rightsAttestation,
    securityAudit: options.securityAudit,
    securityAuditBinding: options.securityAuditBinding,
    securityAuditReadArtifact: options.securityAuditReadArtifact,
    trustPolicy: options.trustPolicy,
    trustPolicyDigest: options.trustPolicyDigest,
  });
  const journal = validateActivationJournal(options.journal);
  const promotions = journal.filter(({ record }) => record.operation === "promote_production"
    && record.generation === options.expectedGeneration
    && record.authorizationDigest === verified.authorizationDigest);
  if (promotions.length !== 1) throw new Error("Release promotion authorization was not consumed exactly once");
  const promotion = promotions[0].record;
  const head = journal.at(-1)!.record;
  if (promotion.state !== "production_provisional"
    || promotion.auditEnvelopeDigest !== verified.auditEnvelopeDigest
    || promotion.generation !== options.expectedGeneration
    || canonicalJson(promotion.release) !== canonicalJson(options.expectedRelease)
    || canonicalJson(promotion.releasedSurfaceEntryIds) !== canonicalJson(verified.releasedSurfaceEntryIds)
    || head.generation !== options.expectedGeneration
    || canonicalJson(head.release) !== canonicalJson(options.expectedRelease)
    || !["production_provisional", "production_stable"].includes(head.state)) {
    throw new Error("Release promotion journal binding mismatch");
  }
  return verified;
}
