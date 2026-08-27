import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadVerifiedReleaseRoot,
  openEvidenceRoot,
  readOwnerPrivateKey,
} from "./release-audit-io-lib.mjs";
import { assertStaticRuntimeAuthority } from "./release-audit-authority-lib.mjs";
import { canonicalJson, sha256Bytes } from "./release-manifest-lib.mjs";

export async function runReleaseAuditFinalization(options, dependencies = {}) {
  const releaseLoader = dependencies.releaseLoader ?? loadVerifiedReleaseRoot;
  const evidenceIoFactory = dependencies.evidenceIoFactory ?? openEvidenceRoot;
  const privateKeyReader = dependencies.privateKeyReader ?? readOwnerPrivateKey;
  const now = dependencies.now ?? new Date();
  const releaseContext = releaseLoader(
    options.releaseRoot
      ?? `/opt/ltx-studio/releases/${options.expectedReleaseDigest}`,
    options.expectedReleaseDigest,
  );
  const {
    releaseRoot,
    releaseDigest,
    manifest,
    runtimeInstallSealSha256,
    runtimeTreeSha256,
    runtimePolicySha256,
    nodeExecutableSha256,
    runtimeTrust,
  } = releaseContext;
  assertStaticRuntimeAuthority(runtimeTrust, "Release audit finalization");
  const evidenceIo = evidenceIoFactory(options.evidenceRoot);
  const requestedOutputPath = options.outputPath ?? "release-audit.v4.json";
  const outputPath = evidenceIo.outputPath(
    isAbsolute(requestedOutputPath)
      ? requestedOutputPath
      : join(evidenceIo.evidenceRoot, requestedOutputPath),
  );
  const auditModule = dependencies.auditModule ?? await import(
    pathToFileURL(
      join(releaseRoot, "apps", "ltx-studio", "shared", "releaseAudit.js"),
    )
  );
  const evidenceFile = evidenceIo.readJson(
    options.evidencePath ?? "release-evidence.v3.json",
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

  const readReference = (reference, includeDigest = false) => {
    const document = evidenceIo.readJson(reference.path);
    const signature = evidenceIo.readJson(reference.signaturePath);
    if (sha256Bytes(document.bytes) !== reference.sha256
      || sha256Bytes(signature.bytes) !== reference.signatureSha256) {
      throw new Error(`Evidence file digest mismatch: ${reference.path}`);
    }
    return {
      document: document.document,
      signature: signature.document,
      ...(includeDigest ? { sha256: reference.sha256 } : {}),
    };
  };
  const authorization = {
    document: evidenceIo.readJson(
      options.authorizationPath ?? "release-authorization.v4.json",
    ).document,
    signature: evidenceIo.readJson(
      options.authorizationSignaturePath
        ?? "release-authorization.v4.sig.json",
    ).document,
  };
  const envelope = auditModule.finalizeReleaseAudit({
    now,
    evidence: evidenceFile.document,
    evidenceDigest: sha256Bytes(evidenceFile.bytes),
    authorization,
    rightsAttestation: readReference(index.rightsAttestation),
    securityAudit: readReference(index.securityAudit, true),
    securityAuditBinding: auditModule.securityAuditBindingFromReleaseManifest(
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
    securityAuditReadArtifact: evidenceIo.readBytes,
    trustPolicy: trustPolicyFile.document,
    trustPolicyDigest: options.trustedPolicySha256,
    finalizerKeyId: options.finalizerKeyId,
    finalizerPrivateKeyPem: privateKeyReader(options.finalizerPrivateKeyPath),
  });
  if (envelope.audit.releaseDigest !== releaseDigest) {
    throw new Error("Final audit does not bind the verified release root");
  }
  evidenceIo.writeCanonicalOnce(outputPath, envelope);
  return {
    releaseDigest,
    auditDigest: sha256Bytes(evidenceIo.readBytes(outputPath)),
    productionOverall: envelope.audit.production_overall,
    sotaOverall: envelope.audit.sota_overall,
    output: outputPath,
  };
}
