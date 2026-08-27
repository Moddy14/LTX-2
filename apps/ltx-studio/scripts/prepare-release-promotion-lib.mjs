import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadVerifiedReleaseRoot,
  openEvidenceRoot,
} from "./release-audit-io-lib.mjs";
import { assertStaticRuntimeAuthority } from "./release-audit-authority-lib.mjs";
import { canonicalJson, sha256Bytes } from "./release-manifest-lib.mjs";

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expectedKeys].sort())) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function readIndexedReference(evidenceIo, reference, includeDigest = false) {
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
}

export async function prepareReleasePromotion(options, dependencies = {}) {
  const releaseLoader = dependencies.releaseLoader ?? loadVerifiedReleaseRoot;
  const evidenceIoFactory = dependencies.evidenceIoFactory ?? openEvidenceRoot;
  const activationIoFactory = dependencies.activationIoFactory ?? openEvidenceRoot;
  const dynamicModuleLoader = dependencies.dynamicModuleLoader ?? ((url) => import(url));
  const now = dependencies.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Promotion preparation clock is invalid");

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

  // This host-static gate runs before any release-contained module or external
  // evidence/control artifact is loaded.
  assertStaticRuntimeAuthority(runtimeTrust, "Promotion preparation");

  const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");
  const auditModule = dependencies.auditModule ?? await dynamicModuleLoader(pathToFileURL(
    join(releaseAppRoot, "shared", "releaseAudit.js"),
  ));
  const activationModule = dependencies.activationModule ?? await dynamicModuleLoader(pathToFileURL(
    join(releaseAppRoot, "shared", "activation.js"),
  ));
  const surfaceModule = dependencies.surfaceModule ?? await dynamicModuleLoader(pathToFileURL(
    join(releaseAppRoot, "shared", "releaseSurface.js"),
  ));
  for (const [name, value] of [
    ["verifyReleasePromotionBundle", auditModule.verifyReleasePromotionBundle],
    ["releaseEvidenceIndexSchema", auditModule.releaseEvidenceIndexSchema],
    ["securityAuditBindingFromReleaseManifest", auditModule.securityAuditBindingFromReleaseManifest],
    ["validateActivationJournal", activationModule.validateActivationJournal],
    ["verifyActivationEnvelopeSignature", activationModule.verifyActivationEnvelopeSignature],
    ["verifyRuntimeRightsSnapshot", activationModule.verifyRuntimeRightsSnapshot],
    ["candidateReleaseSurfaceSchema", surfaceModule.candidateReleaseSurfaceSchema],
  ]) {
    const isSchema = name.endsWith("Schema");
    if (isSchema ? typeof value?.parse !== "function" : typeof value !== "function") {
      throw new Error(`Release promotion verifier export is missing: ${name}`);
    }
  }

  const surfaceBytes = readFileSync(join(releaseRoot, manifest.surface.path));
  if (sha256Bytes(surfaceBytes) !== manifest.surface.sha256) {
    throw new Error("Release surface file does not match the manifest digest");
  }
  const surface = surfaceModule.candidateReleaseSurfaceSchema.parse(
    JSON.parse(surfaceBytes.toString("utf8")),
  );
  const releasedSurfaceEntryIds = surface.entries
    .filter(({ targetStatus }) => targetStatus === "candidate")
    .map(({ id }) => id);
  if (releasedSurfaceEntryIds.length === 0) {
    throw new Error("Release manifest surface contains no production candidates");
  }

  const evidenceIo = evidenceIoFactory(options.evidenceRoot);
  const index = auditModule.releaseEvidenceIndexSchema.parse(
    evidenceIo.readJson(options.indexPath ?? "evidence-index.v3.json").document,
  );
  if (index.releaseDigest !== releaseDigest
    || canonicalJson(index.runtimeTrust) !== canonicalJson(runtimeTrust)) {
    throw new Error("Evidence index release or RuntimeTrust binding mismatch");
  }
  const trustPolicyFile = evidenceIo.readJson(index.trustPolicy.path);
  const trustPolicyDigest = sha256Bytes(trustPolicyFile.bytes);
  if (trustPolicyDigest !== index.trustPolicy.sha256
    || trustPolicyDigest !== options.trustedPolicySha256
    || trustPolicyDigest !== runtimeTrust.trustPolicyDigests.release) {
    throw new Error("Release trust policy differs from its index, external pin, or RuntimeTrust pin");
  }
  const evidenceFile = evidenceIo.readJson(
    options.evidencePath ?? "release-evidence.v3.json",
  );
  const authorization = {
    document: evidenceIo.readJson(
      options.authorizationPath ?? "release-authorization.v4.json",
    ).document,
    signature: evidenceIo.readJson(
      options.authorizationSignaturePath ?? "release-authorization.v4.sig.json",
    ).document,
  };
  const auditEnvelope = evidenceIo.readJson(
    options.auditPath ?? "release-audit.v4.json",
  ).document;
  const rightsAttestation = readIndexedReference(evidenceIo, index.rightsAttestation);
  const securityAudit = readIndexedReference(evidenceIo, index.securityAudit, true);

  const activationIo = activationIoFactory(options.activationControlRoot);
  const activationTrustFile = activationIo.readJson(
    options.activationTrustPolicyPath ?? "activation-writer-trust.json",
  );
  if (sha256Bytes(activationTrustFile.bytes)
      !== runtimeTrust.trustPolicyDigests.activationWriter) {
    throw new Error("Activation-writer policy differs from its RuntimeTrust pin");
  }
  const journalDocument = activationIo.readJson(
    options.activationJournalPath ?? "activation-journal.json",
  ).document;
  const journal = activationModule.validateActivationJournal(journalDocument);
  for (const envelope of journal) {
    activationModule.verifyActivationEnvelopeSignature(
      envelope,
      activationTrustFile.document,
      now,
    );
  }
  const head = journal.at(-1);
  if (!head || head.record.state !== "qualification_only") {
    throw new Error("Activation journal head is not qualification_only");
  }
  const expectedActivationHead = {
    generation: head.record.generation,
    sequence: head.record.sequence,
    headSha256: activationModule.activationEnvelopeDigest(head),
  };
  const anchor = activationIo.readJson(
    options.activationAnchorPath ?? "activation-head.json",
  ).document;
  assertExactObjectKeys(anchor, ["generation", "sequence", "headSha256"], "Activation anchor");
  if (canonicalJson(anchor) !== canonicalJson(expectedActivationHead)) {
    throw new Error("Activation journal and external highest-head anchor diverge");
  }
  const expectedRelease = {
    releaseDigest,
    surfaceDigest: manifest.surface.sha256,
    runtimeInstallSealSha256,
    runtimeTreeSha256,
    runtimePolicySha256,
    nodeExecutableSha256,
    runtimeTrust,
    rights: head.record.release.rights,
  };
  if (canonicalJson(head.record.release) !== canonicalJson(expectedRelease)
    || head.record.release.rights.policyEvidenceDigest
      !== manifest.rights.evidenceCatalog.sha256
    || head.record.releasedSurfaceEntryIds.length !== 0) {
    throw new Error("Qualification-only activation head does not bind the installed release and rights catalog");
  }

  const rightsTrustFile = activationIo.readJson(
    options.runtimeRightsTrustPolicyPath ?? "release-trusted-keys.json",
  );
  if (sha256Bytes(rightsTrustFile.bytes) !== runtimeTrust.trustPolicyDigests.runtimeRights) {
    throw new Error("Runtime-rights policy differs from its RuntimeTrust pin");
  }
  const signedRuntimeRights = activationIo.readJson(
    options.runtimeRightsSnapshotPath ?? "runtime-rights-snapshot.json",
  ).document;
  assertExactObjectKeys(
    signedRuntimeRights,
    ["document", "signature"],
    "Runtime rights snapshot envelope",
  );
  const runtimeRights = activationModule.verifyRuntimeRightsSnapshot({
    signed: signedRuntimeRights,
    trustPolicy: rightsTrustFile.document,
    release: expectedRelease,
    now,
  });

  const verified = auditModule.verifyReleasePromotionBundle({
    now,
    expectedGeneration: head.record.generation,
    expectedReleaseDigest: releaseDigest,
    expectedSurfaceDigest: manifest.surface.sha256,
    expectedRuntimeInstallSealSha256: runtimeInstallSealSha256,
    expectedRuntimeTreeSha256: runtimeTreeSha256,
    expectedRuntimePolicySha256: runtimePolicySha256,
    expectedNodeExecutableSha256: nodeExecutableSha256,
    expectedRuntimeTrust: runtimeTrust,
    expectedRightsPolicyEvidenceDigest: manifest.rights.evidenceCatalog.sha256,
    expectedReleasedSurfaceEntryIds: releasedSurfaceEntryIds,
    evidence: evidenceFile.document,
    evidenceDigest: sha256Bytes(evidenceFile.bytes),
    authorization,
    auditEnvelope,
    rightsAttestation,
    securityAudit,
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
    trustPolicyDigest,
  });

  return {
    schemaVersion: "ltx-studio-promotion-authorization-request.v1",
    status: "hold-external-activation-writer-required",
    mutationPerformed: false,
    release: expectedRelease,
    expectedActivationHead,
    requestedTransition: {
      previousState: "qualification_only",
      operation: "promote_production",
      state: "production_provisional",
      releasedSurfaceEntryIds: verified.releasedSurfaceEntryIds,
      authorizationDigest: verified.authorizationDigest,
      auditEnvelopeDigest: verified.auditEnvelopeDigest,
      evidenceDigest: null,
    },
    releaseEvidenceDigest: sha256Bytes(evidenceFile.bytes),
    rightsAttestationDigest: verified.rightsAttestationDigest,
    runtimeRightsSnapshotDigest: runtimeRights.digest,
  };
}
