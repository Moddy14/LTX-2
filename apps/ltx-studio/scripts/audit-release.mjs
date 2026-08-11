import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadVerifiedReleaseRoot,
  openEvidenceRoot,
} from "./release-audit-io-lib.mjs";
import { sha256Bytes } from "./release-manifest-lib.mjs";

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if ((!value || value.startsWith("--")) && required)
    throw new Error(`${name} requires a value`);
  return value;
}

const expectedReleaseDigest = argument("--release");
const { releaseRoot, releaseDigest, manifest } = loadVerifiedReleaseRoot(
  argument("--release-root", false) ??
    `/opt/ltx-studio/releases/${expectedReleaseDigest}`,
  expectedReleaseDigest,
);
const evidenceIo = openEvidenceRoot(argument("--evidence-root"));
const expectedTrustPolicyDigest = argument("--trusted-policy-sha256");
const outputPath = evidenceIo.outputPath(
  argument("--output", false) ??
    join(evidenceIo.evidenceRoot, "release-evidence.v1.json"),
);
const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");
const auditModule = await import(
  pathToFileURL(join(releaseAppRoot, "shared", "releaseAudit.js"))
);
const surface = JSON.parse(
  readFileSync(join(releaseRoot, manifest.surface.path), "utf8"),
);
const index = auditModule.releaseEvidenceIndexSchema.parse(
  evidenceIo.readJson("evidence-index.v1.json").document,
);

function readReference(reference) {
  const document = evidenceIo.readJson(reference.path);
  const signature = evidenceIo.readJson(reference.signaturePath);
  if (
    sha256Bytes(document.bytes) !== reference.sha256 ||
    sha256Bytes(signature.bytes) !== reference.signatureSha256
  ) {
    throw new Error(`Evidence file digest mismatch: ${reference.path}`);
  }
  return {
    document: document.document,
    signature: signature.document,
  };
}

const trustPolicyFile = evidenceIo.readJson(index.trustPolicy.path);
if (
  sha256Bytes(trustPolicyFile.bytes) !== index.trustPolicy.sha256 ||
  index.trustPolicy.sha256 !== expectedTrustPolicyDigest
)
  throw new Error("Trusted-key policy file digest mismatch");
const preregistration = readReference(index.preregistration);
const rightsAttestation = readReference(index.rightsAttestation);
const reports = index.reports.map((reference) => ({
  ...readReference(reference),
  kind: reference.kind,
  sha256: reference.sha256,
}));
const evidence = auditModule.collectReleaseEvidence({
  now: new Date(),
  releaseDigest,
  manifestSurfaceDigest: manifest.surface.sha256,
  manifestRightsCatalogDigest: manifest.rights.evidenceCatalog.sha256,
  surface,
  index,
  trustPolicy: trustPolicyFile.document,
  preregistration,
  rightsAttestation,
  reports,
  trustPolicyDigest: expectedTrustPolicyDigest,
});
evidenceIo.writeCanonicalOnce(outputPath, evidence);
process.stdout.write(
  `${JSON.stringify({
    releaseDigest,
    evidenceDigest: sha256Bytes(evidenceIo.readBytes(outputPath)),
    readyForReleaseAuthorization: true,
    output: outputPath,
  })}\n`,
);
