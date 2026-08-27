import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadVerifiedReleaseRoot,
  openEvidenceRoot,
} from "./release-audit-io-lib.mjs";
import { assertStaticRuntimeAuthority } from "./release-audit-authority-lib.mjs";
import { canonicalJson, sha256Bytes } from "./release-manifest-lib.mjs";

export async function runReleaseEvidenceCollection(options, dependencies = {}) {
  const releaseLoader = dependencies.releaseLoader ?? loadVerifiedReleaseRoot;
  const evidenceIoFactory = dependencies.evidenceIoFactory ?? openEvidenceRoot;
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
  assertStaticRuntimeAuthority(runtimeTrust, "Release evidence collection");
  const evidenceIo = evidenceIoFactory(options.evidenceRoot);
  const requestedOutputPath = options.outputPath ?? "release-evidence.v3.json";
  const outputPath = evidenceIo.outputPath(
    isAbsolute(requestedOutputPath)
      ? requestedOutputPath
      : join(evidenceIo.evidenceRoot, requestedOutputPath),
  );
  const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");
  const auditModule = dependencies.auditModule ?? await import(
    pathToFileURL(join(releaseAppRoot, "shared", "releaseAudit.js"))
  );
  const surface = JSON.parse(
    readFileSync(join(releaseRoot, manifest.surface.path), "utf8"),
  );
  const index = auditModule.releaseEvidenceIndexSchema.parse(
    evidenceIo.readJson(options.indexPath ?? "evidence-index.v3.json").document,
  );
  if (index.releaseDigest !== releaseDigest
    || canonicalJson(index.runtimeTrust) !== canonicalJson(runtimeTrust)) {
    throw new Error("Evidence index release or RuntimeTrust binding mismatch");
  }

  const readReference = (reference) => {
    const document = evidenceIo.readJson(reference.path);
    const signature = evidenceIo.readJson(reference.signaturePath);
    if (sha256Bytes(document.bytes) !== reference.sha256
      || sha256Bytes(signature.bytes) !== reference.signatureSha256) {
      throw new Error(`Evidence file digest mismatch: ${reference.path}`);
    }
    return { document: document.document, signature: signature.document };
  };

  const trustPolicyFile = evidenceIo.readJson(index.trustPolicy.path);
  if (sha256Bytes(trustPolicyFile.bytes) !== index.trustPolicy.sha256
    || index.trustPolicy.sha256 !== options.trustedPolicySha256
    || index.trustPolicy.sha256 !== runtimeTrust.trustPolicyDigests.release) {
    throw new Error("Trusted-key policy file does not match its index, external pin, and RuntimeTrust pin");
  }
  const qualificationTrustPolicyFile = evidenceIo.readJson(
    index.qualification.trustPolicy.path,
  );
  if (sha256Bytes(qualificationTrustPolicyFile.bytes)
      !== index.qualification.trustPolicy.sha256
    || index.qualification.trustPolicy.sha256
      !== runtimeTrust.trustPolicyDigests.qualificationAuthorizer) {
    throw new Error("Qualification trust policy file does not match its index and RuntimeTrust pin");
  }
  const preregistration = readReference(index.preregistration);
  const rightsAttestation = readReference(index.rightsAttestation);
  const securityAudit = readReference(index.securityAudit);
  const buildAuthorityAttestation = readReference(
    index.qualification.buildAuthorityAttestation,
  );
  const authorityIsolationAttestation = readReference(
    index.qualification.authorityIsolationAttestation,
  );
  const qualificationResolution = readReference(index.qualification.resolution);
  const reports = index.reports.map((reference) => ({
    ...readReference(reference),
    kind: reference.kind,
    sha256: reference.sha256,
  }));
  const evidence = auditModule.collectReleaseEvidence({
    now,
    releaseDigest,
    manifestSurfaceDigest: manifest.surface.sha256,
    manifestRightsCatalogDigest: manifest.rights.evidenceCatalog.sha256,
    surface,
    index,
    trustPolicy: trustPolicyFile.document,
    preregistration,
    rightsAttestation,
    securityAudit: { ...securityAudit, sha256: index.securityAudit.sha256 },
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
    reports,
    trustPolicyDigest: options.trustedPolicySha256,
    qualificationTrustPolicy: qualificationTrustPolicyFile.document,
    qualificationTrustPolicyDigest: index.qualification.trustPolicy.sha256,
    buildAuthorityAttestation,
    authorityIsolationAttestation,
    qualificationResolution,
  });
  evidenceIo.writeCanonicalOnce(outputPath, evidence);
  return {
    releaseDigest,
    evidenceDigest: sha256Bytes(evidenceIo.readBytes(outputPath)),
    securityAuditDigest: evidence.securityAudit.sha256,
    readyForReleaseAuthorization: true,
    output: outputPath,
  };
}
