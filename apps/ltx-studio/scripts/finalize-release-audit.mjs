import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadVerifiedReleaseRoot,
  openEvidenceRoot,
  readOwnerPrivateKey,
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
const { releaseRoot, releaseDigest } = loadVerifiedReleaseRoot(
  argument("--release-root", false) ??
    `/opt/ltx-studio/releases/${expectedReleaseDigest}`,
  expectedReleaseDigest,
);
const evidenceIo = openEvidenceRoot(argument("--evidence-root"));
const expectedTrustPolicyDigest = argument("--trusted-policy-sha256");
const outputPath = evidenceIo.outputPath(
  argument("--output", false) ??
    join(evidenceIo.evidenceRoot, "release-audit.v1.json"),
);
const auditModule = await import(
  pathToFileURL(
    join(releaseRoot, "apps", "ltx-studio", "shared", "releaseAudit.js"),
  )
);
const evidenceFile = evidenceIo.readJson(
  argument("--evidence", false) ?? "release-evidence.v1.json",
);
const index = auditModule.releaseEvidenceIndexSchema.parse(
  evidenceIo.readJson("evidence-index.v1.json").document,
);
const trustPolicyFile = evidenceIo.readJson(index.trustPolicy.path);
if (
  sha256Bytes(trustPolicyFile.bytes) !== index.trustPolicy.sha256 ||
  index.trustPolicy.sha256 !== expectedTrustPolicyDigest
)
  throw new Error("Trusted-key policy file digest mismatch");

function signedDocument(documentArgument, signatureArgument) {
  return {
    document: evidenceIo.readJson(argument(documentArgument)).document,
    signature: evidenceIo.readJson(argument(signatureArgument)).document,
  };
}

const rightsAttestation = {
  document: evidenceIo.readJson(index.rightsAttestation.path).document,
  signature: evidenceIo.readJson(index.rightsAttestation.signaturePath)
    .document,
};
const envelope = auditModule.finalizeReleaseAudit({
  now: new Date(),
  evidence: evidenceFile.document,
  evidenceDigest: sha256Bytes(evidenceFile.bytes),
  authorization: signedDocument("--authorization", "--authorization-signature"),
  rightsAttestation,
  trustPolicy: trustPolicyFile.document,
  trustPolicyDigest: expectedTrustPolicyDigest,
  finalizerKeyId: argument("--finalizer-key-id"),
  finalizerPrivateKeyPem: readOwnerPrivateKey(
    argument("--finalizer-private-key"),
  ),
});
if (envelope.audit.releaseDigest !== releaseDigest)
  throw new Error("Final audit does not bind the verified release root");
evidenceIo.writeCanonicalOnce(outputPath, envelope);
process.stdout.write(
  `${JSON.stringify({
    releaseDigest,
    auditDigest: sha256Bytes(evidenceIo.readBytes(outputPath)),
    productionOverall: envelope.audit.production_overall,
    sotaOverall: envelope.audit.sota_overall,
    output: outputPath,
  })}\n`,
);
