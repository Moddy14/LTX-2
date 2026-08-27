import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadVerifiedReleaseRoot,
  openEvidenceRoot,
} from "./release-audit-io-lib.mjs";
import { assertStaticRuntimeAuthority } from "./release-audit-authority-lib.mjs";
import { canonicalJson, sha256Bytes } from "./release-manifest-lib.mjs";

export async function runReleaseSecurityVerification(options, dependencies = {}) {
  const mode = options.mode ?? "product-go";
  if (!["product-go", "staged-evidence"].includes(mode)) {
    const error = new Error("--mode must be product-go or staged-evidence");
    error.code = "security-audit-cli-invalid";
    throw error;
  }
  const releaseLoader = dependencies.releaseLoader ?? loadVerifiedReleaseRoot;
  const evidenceIoFactory = dependencies.evidenceIoFactory ?? openEvidenceRoot;
  const now = dependencies.now ?? new Date();
  const {
    releaseRoot,
    releaseDigest,
    manifest,
    runtimeInstallSealSha256,
    runtimeTreeSha256,
    runtimePolicySha256,
    nodeExecutableSha256,
    runtimeTrust,
  } = releaseLoader(
    options.releaseRoot
      ?? `/opt/ltx-studio/releases/${options.expectedReleaseDigest}`,
    options.expectedReleaseDigest,
  );
  assertStaticRuntimeAuthority(runtimeTrust, "Release security verification");
  const evidenceIo = evidenceIoFactory(options.evidenceRoot);
  const auditModule = dependencies.auditModule ?? await import(
    pathToFileURL(join(releaseRoot, "apps", "ltx-studio", "shared", "releaseAudit.js"))
  );
  const index = auditModule.releaseEvidenceIndexSchema.parse(
    evidenceIo.readJson(options.indexPath ?? "evidence-index.v3.json").document,
  );
  if (index.releaseDigest !== releaseDigest
    || canonicalJson(index.runtimeTrust) !== canonicalJson(runtimeTrust)) {
    throw new Error("Evidence index release or RuntimeTrust binding mismatch");
  }
  const trustPolicyFile = evidenceIo.readJson(index.trustPolicy.path);
  if (sha256Bytes(trustPolicyFile.bytes) !== index.trustPolicy.sha256
    || index.trustPolicy.sha256 !== options.trustedPolicySha256
    || index.trustPolicy.sha256 !== runtimeTrust.trustPolicyDigests.release) {
    throw new Error("Trusted-key policy file does not match its index, external pin, and RuntimeTrust pin");
  }
  const policy = auditModule.releaseTrustedKeyPolicySchema.parse(
    trustPolicyFile.document,
  );
  const securityFile = evidenceIo.readJson(index.securityAudit.path);
  const signatureFile = evidenceIo.readJson(index.securityAudit.signaturePath);
  const securityDigest = sha256Bytes(securityFile.bytes);
  if (securityDigest !== index.securityAudit.sha256
    || sha256Bytes(signatureFile.bytes) !== index.securityAudit.signatureSha256) {
    throw new Error("Security audit file digest mismatch");
  }
  const securityAudit = (mode === "staged-evidence"
    ? auditModule.validateReleaseSecurityAuditEvidence
    : auditModule.validateReleaseSecurityAudit)(
    securityFile.document,
    auditModule.securityAuditBindingFromReleaseManifest(
      manifest,
      releaseDigest,
      {
        runtimeInstallSealSha256,
        runtimeTreeSha256,
        runtimePolicySha256,
        nodeExecutableSha256,
        runtimeTrust,
      },
    ),
    now,
    evidenceIo.readBytes,
  );
  const signedDigest = auditModule.verifyDetachedSignature(
    securityAudit,
    signatureFile.document,
    policy,
    "qualification-attestor",
    now,
  );
  if (signedDigest !== securityDigest) {
    throw new Error("Security audit detached signature binding mismatch");
  }
  return {
    schemaVersion: "ltx-studio-security-audit-verification.v1",
    releaseDigest,
    securityAuditDigest: securityDigest,
    cutoffAt: securityAudit.cutoffAt,
    expiresAt: securityAudit.expiresAt,
    mode,
    verdict: mode === "staged-evidence" ? "evidence-valid" : "pass",
    go: mode === "product-go",
  };
}
