import {
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  loadVerifiedReleaseRoot,
  openEvidenceRoot,
  readOwnerPrivateKey,
} from "./release-audit-io-lib.mjs";
import {
  canonicalJson,
  sha256Bytes,
} from "./release-manifest-lib.mjs";

export const PREFLIGHT_SCHEMA_VERSION = "ltx-studio-release-audit-preflight.v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const QUALIFICATION_KINDS = [
  "r0-control-plane",
  "r1-reproducible-build",
  "r3-canaries",
  "r3-pause-resume",
  "r3-soak",
  "d1-calibration",
  "q0-cross-shot",
  "q1-comparators",
  "q2-holdout",
];
const COLD_CANARY_GATES = ["cold-canary", "playable-output", "provenance"];
const FINAL_OWNER = {
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

const CHECK_IDS = [
  "release-root",
  "runtime-authority-isolation",
  "manifest-qualification",
  "release-audit-schema",
  "evidence-root",
  "trusted-policy-pin",
  "evidence-index",
  "trust-policy",
  "security-audit",
  "preregistration",
  "rights-attestation",
  "qualification-trust-policy",
  "build-authority-attestation",
  "authority-isolation-attestation",
  "qualification-resolution",
  ...QUALIFICATION_KINDS.map((kind) => `phase-report:${kind}`),
  "cold-canary-gates",
  "q2-claim-coverage",
  "evidence-collection",
  "release-evidence",
  "release-authorization",
  "finalizer-key-id",
  "finalizer-private-key",
];

function errorMessage(error) {
  if (error && typeof error === "object" && "issues" in error
    && Array.isArray(error.issues) && error.issues.length > 0) {
    const issue = error.issues[0];
    const path = Array.isArray(issue.path) && issue.path.length > 0
      ? `${issue.path.join(".")}: `
      : "";
    return `${path}${issue.message ?? "schema rejected"}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isMissingFile(error) {
  return Boolean(error && typeof error === "object" && "code" in error
    && ["ENOENT", "ENOTDIR"].includes(error.code));
}

function securityAuditErrorCode(error) {
  if (error && typeof error === "object" && "code" in error
    && typeof error.code === "string") {
    return error.code;
  }
  return "security-audit-invalid";
}

function verifyReadOnlyTree(root) {
  const pending = [resolve(root)];
  while (pending.length > 0) {
    const path = pending.pop();
    const details = lstatSync(path);
    if (details.isSymbolicLink()) continue;
    if ((details.mode & 0o222) !== 0) {
      throw new Error(`Release root contains a writable path: ${path}`);
    }
    if (details.isDirectory()) {
      for (const name of readdirSync(path).sort().reverse()) {
        pending.push(join(path, name));
      }
    } else if (!details.isFile()) {
      throw new Error(`Release root contains an unsupported path type: ${path}`);
    }
  }
}

function reportResult(options, checks, release = null) {
  for (const id of CHECK_IDS) {
    if (!checks.has(id)) {
      checks.set(id, {
        id,
        status: "invalid",
        origin: "code-schema",
        code: "preflight-check-not-evaluated",
        message: "The preflight implementation did not evaluate this required check.",
      });
    }
  }
  const ordered = CHECK_IDS.map((id) => checks.get(id));
  const blockers = ordered
    .filter(({ status }) => status !== "present")
    .map(({ id, status, origin, code }) => ({ id, status, origin, code }));
  const evidenceCheckIds = [
    "release-root",
    "runtime-authority-isolation",
    "manifest-qualification",
    "release-audit-schema",
    "evidence-root",
    "trusted-policy-pin",
    "evidence-index",
    "trust-policy",
    "security-audit",
    "preregistration",
    "rights-attestation",
    "qualification-trust-policy",
    "build-authority-attestation",
    "authority-isolation-attestation",
    "qualification-resolution",
    ...QUALIFICATION_KINDS.map((kind) => `phase-report:${kind}`),
    "cold-canary-gates",
    "q2-claim-coverage",
    "evidence-collection",
  ];
  const finalizationCheckIds = [
    ...evidenceCheckIds,
    "release-evidence",
    "release-authorization",
    "finalizer-key-id",
    "finalizer-private-key",
  ];
  const allPresent = (ids) => ids.every((id) => checks.get(id)?.status === "present");
  const readyForEvidenceCollection = allPresent(evidenceCheckIds);
  const readyForFinalization = allPresent(finalizationCheckIds);
  return {
    schemaVersion: PREFLIGHT_SCHEMA_VERSION,
    expectedReleaseDigest: options.expectedReleaseDigest,
    releaseRoot: resolve(options.releaseRoot),
    evidenceRoot: options.evidenceRoot ? resolve(options.evidenceRoot) : null,
    release,
    verdict: readyForFinalization
      ? "ready-for-finalization"
      : readyForEvidenceCollection
        ? "ready-for-evidence-collection"
        : "blocked",
    readyForEvidenceCollection,
    readyForFinalization,
    counts: {
      present: ordered.filter(({ status }) => status === "present").length,
      missing: ordered.filter(({ status }) => status === "missing").length,
      invalid: ordered.filter(({ status }) => status === "invalid").length,
    },
    checks: ordered,
    blockers,
  };
}

function dependencyChecks(checks, status, origin, code, message) {
  for (const id of CHECK_IDS) {
    if (!checks.has(id)) checks.set(id, { id, status, origin, code, message });
  }
}

function setPresent(checks, id, message, observed = undefined) {
  checks.set(id, {
    id,
    status: "present",
    origin: ["release-root", "release-audit-schema"].includes(id) ? "release" : "external",
    code: "verified",
    message,
    ...(observed === undefined ? {} : { observed }),
  });
}

function setMissing(checks, id, code, message) {
  checks.set(id, { id, status: "missing", origin: "external", code, message });
}

function setInvalid(checks, id, origin, code, message) {
  checks.set(id, { id, status: "invalid", origin, code, message });
}

function assertStaticRuntimeAuthority(runtimeTrust) {
  if (!runtimeTrust || typeof runtimeTrust !== "object"
    || runtimeTrust.schemaVersion !== "ltx-studio-runtime-trust-binding.v2"
    || !runtimeTrust.authorityIsolation
    || runtimeTrust.authorityIsolation.status !== "attested"
    || ![
      "separate-studio-identity-proc-fd-isolation",
      "external-signer-sealed-fd-broker",
    ].includes(runtimeTrust.authorityIsolation.mechanism)) {
    throw new Error(
      "Preflight blocked: same-local-UID execution/publication authority is not authentic",
    );
  }
}

function readReference(evidenceIo, reference) {
  const document = evidenceIo.readJson(reference.path);
  const signature = evidenceIo.readJson(reference.signaturePath);
  if (sha256Bytes(document.bytes) !== reference.sha256
    || sha256Bytes(signature.bytes) !== reference.signatureSha256) {
    throw new Error(`Evidence file digest mismatch: ${reference.path}`);
  }
  return {
    document: document.document,
    signature: signature.document,
    bytes: document.bytes,
  };
}

function verifyCurrentKey(key, now, role) {
  if (!key || !Array.isArray(key.roles) || !key.roles.includes(role)) {
    throw new Error(`Trusted key lacks required role: ${role}`);
  }
  const nowMs = now.getTime();
  if (nowMs < Date.parse(key.notBefore) || nowMs >= Date.parse(key.notAfter)) {
    throw new Error(`Trusted ${role} key is outside its validity window`);
  }
  if (key.revokedAt && Date.parse(key.revokedAt) <= nowMs) {
    throw new Error(`Trusted ${role} key is revoked`);
  }
}

function validateAuthorization({
  auditModule,
  authorization,
  authorizationSignature,
  evidence,
  evidenceDigest,
  rightsDigest,
  policy,
  runtimeIdentity,
  now,
}) {
  const parsed = auditModule.releaseAuthorizationSchema.parse(authorization);
  const signature = auditModule.detachedSignatureSchema.parse(authorizationSignature);
  auditModule.verifyDetachedSignature(
    parsed,
    signature,
    policy,
    "release-authorizer",
    now,
  );
  const q2ReportDigest = evidence.reports.find(({ kind }) => kind === "q2-holdout")?.sha256;
  if (!q2ReportDigest
    || parsed.releaseDigest !== evidence.releaseDigest
    || parsed.surfaceDigest !== evidence.surfaceDigest
    || parsed.runtimeInstallSealSha256 !== runtimeIdentity.runtimeInstallSealSha256
    || parsed.runtimeTreeSha256 !== runtimeIdentity.runtimeTreeSha256
    || parsed.runtimePolicySha256 !== runtimeIdentity.runtimePolicySha256
    || parsed.nodeExecutableSha256 !== runtimeIdentity.nodeExecutableSha256
    || parsed.preregistrationDigest !== evidence.preregistrationDigest
    || parsed.q2ReportDigest !== q2ReportDigest
    || parsed.releaseEvidenceDigest !== evidenceDigest
    || parsed.rightsAttestationDigest !== rightsDigest
    || parsed.securityAuditDigest !== evidence.securityAudit.sha256
    || parsed.manifestQualificationSha256 !== evidence.manifestQualificationSha256
    || parsed.qualificationTrustPolicyDigest !== evidence.qualificationTrustPolicyDigest
    || parsed.buildAuthorityAttestationDigest !== evidence.buildAuthorityAttestationDigest
    || parsed.authorityIsolationAttestationDigest !== evidence.authorityIsolationAttestationDigest
    || parsed.qualificationResolutionDigest !== evidence.qualificationResolutionDigest
    || canonicalJson(parsed.runtimeTrust) !== canonicalJson(evidence.runtimeTrust)
    || canonicalJson(parsed.releasedSurfaceEntryIds) !== canonicalJson(evidence.candidateSurfaceEntryIds)
    || now.getTime() < Date.parse(parsed.notBefore)
    || now.getTime() >= Date.parse(parsed.expiresAt)) {
    throw new Error("Release authorization binding or validity window mismatch");
  }
  return { document: parsed, signature };
}

function validateFinalizerPrivateKey(privateKeyPem, trustedKey) {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Finalizer private key must be Ed25519");
  }
  const publicDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const rawPublicKey = Buffer.from(publicDer).subarray(-32).toString("base64");
  if (rawPublicKey !== trustedKey.publicKeyBase64) {
    throw new Error("Finalizer private key does not match the trusted finalizer key");
  }
}

export async function runReleaseAuditPreflight(options, dependencies = {}) {
  const checks = new Map();
  const now = dependencies.now ?? new Date();
  const releaseLoader = dependencies.releaseLoader ?? loadVerifiedReleaseRoot;
  const immutableVerifier = dependencies.immutableVerifier ?? verifyReadOnlyTree;
  const evidenceIoFactory = dependencies.evidenceIoFactory ?? openEvidenceRoot;
  const privateKeyReader = dependencies.privateKeyReader ?? readOwnerPrivateKey;

  if (!SHA256_PATTERN.test(options.expectedReleaseDigest)) {
    setInvalid(checks, "release-root", "release", "release-digest-invalid", "--release must be a lowercase SHA-256 digest.");
    dependencyChecks(checks, "invalid", "release", "release-root-invalid", "Release-dependent checks cannot run.");
    return reportResult(options, checks);
  }

  let releaseContext;
  try {
    releaseContext = releaseLoader(options.releaseRoot, options.expectedReleaseDigest);
    immutableVerifier(releaseContext.releaseRoot);
  } catch (error) {
    setInvalid(checks, "release-root", "release", "release-root-invalid", errorMessage(error));
    dependencyChecks(checks, "invalid", "release", "release-root-invalid", "Release-dependent checks cannot run.");
    return reportResult(options, checks);
  }

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
  try {
    assertStaticRuntimeAuthority(runtimeTrust);
    setPresent(
      checks,
      "runtime-authority-isolation",
      "Externally loaded RuntimeTrust authorizes release evaluation before any release-contained module or evidence is read.",
    );
  } catch (error) {
    setPresent(checks, "release-root", "Release digest and artifact inventory were loaded before the authority gate.", {
      releaseDigest,
      artifactCount: manifest.artifacts.length,
    });
    setInvalid(
      checks,
      "runtime-authority-isolation",
      "release",
      "runtime-authority-isolation-hold",
      errorMessage(error),
    );
    dependencyChecks(
      checks,
      "missing",
      "external",
      "runtime-authority-isolation-hold",
      "No release-contained module or evidence may be read while RuntimeTrust authority is HOLD.",
    );
    return reportResult(options, checks, {
      releaseDigest,
      artifactCount: manifest.artifacts.length,
      manifestBlockers: manifest.qualification?.blockers ?? [],
    });
  }
  const manifestQualification = manifest?.qualification;
  const manifestBlockers = Array.isArray(manifestQualification?.blockers)
    ? manifestQualification.blockers
    : [];
  const immutableHold = manifestQualification?.releaseDecision === "hold"
    && manifestBlockers.length > 0;
  setInvalid(
    checks,
    "manifest-qualification",
    "release",
    immutableHold
      ? "manifest-qualification-hold"
      : manifestQualification?.releaseDecision === "pass" && manifestBlockers.length === 0
        ? "qualification-resolution-v2-required"
        : "manifest-qualification-invalid",
    immutableHold
      ? `Immutable manifest HOLD awaits a signed Qualification Resolution v2: ${manifestBlockers.join(",")}`
      : manifestQualification?.releaseDecision === "pass" && manifestBlockers.length === 0
        ? "Legacy manifest PASS is readable but cannot authorize Evidence v3 or promotion without an immutable HOLD and Resolution v2."
        : "Release manifest qualification is absent or internally inconsistent.",
  );
  let auditModule;
  let surfaceModule;
  let surface;
  try {
    const dynamicModuleLoader = dependencies.dynamicModuleLoader
      ?? ((url) => import(url));
    auditModule = dependencies.auditModule ?? await dynamicModuleLoader(pathToFileURL(
      join(releaseRoot, "apps", "ltx-studio", "shared", "releaseAudit.js"),
    ));
    surfaceModule = dependencies.surfaceModule ?? await dynamicModuleLoader(pathToFileURL(
      join(releaseRoot, "apps", "ltx-studio", "shared", "releaseSurface.js"),
    ));
    for (const [name, type] of [
      ["collectReleaseEvidence", "function"],
      ["verifyDetachedSignature", "function"],
      ["validateReleaseSecurityAudit", "function"],
      ["validateReleaseSecurityAuditEvidence", "function"],
      ["securityAuditBindingFromReleaseManifest", "function"],
      ["releaseEvidenceIndexSchema", "object"],
      ["releaseTrustedKeyPolicySchema", "object"],
      ["rightsAttestationSchema", "object"],
      ["qualificationReportSchema", "object"],
      ["releaseEvidenceSchema", "object"],
      ["releaseAuthorizationSchema", "object"],
      ["detachedSignatureSchema", "object"],
      ["qualificationResolutionTrustPolicySchema", "object"],
      ["signedBuildAuthorityAttestationSchema", "object"],
      ["signedAuthorityIsolationAttestationSchema", "object"],
      ["signedQualificationResolutionSchema", "object"],
    ]) {
      if (typeof auditModule[name] !== type) throw new Error(`Release audit export is missing: ${name}`);
    }
    if (!surfaceModule.candidateReleaseSurfaceSchema?.parse) {
      throw new Error("Release surface schema export is missing");
    }
    const surfaceBytes = readFileSync(join(releaseRoot, manifest.surface.path));
    if (sha256Bytes(surfaceBytes) !== manifest.surface.sha256) {
      throw new Error("Release surface file does not match the manifest digest");
    }
    const rightsCatalogBytes = readFileSync(join(releaseRoot, manifest.rights.evidenceCatalog.path));
    if (sha256Bytes(rightsCatalogBytes) !== manifest.rights.evidenceCatalog.sha256) {
      throw new Error("Rights catalog file does not match the manifest digest");
    }
    surface = surfaceModule.candidateReleaseSurfaceSchema.parse(
      JSON.parse(surfaceBytes.toString("utf8")),
    );
  } catch (error) {
    setPresent(checks, "release-root", "Release digest, artifact inventory, and read-only tree are verified.", {
      releaseDigest,
      artifactCount: manifest.artifacts.length,
    });
    setInvalid(checks, "release-audit-schema", "code-schema", "release-audit-schema-invalid", errorMessage(error));
    dependencyChecks(checks, "invalid", "code-schema", "release-audit-schema-invalid", "Audit-schema-dependent checks cannot run.");
    return reportResult(options, checks, {
      releaseDigest,
      artifactCount: manifest.artifacts.length,
      manifestBlockers: manifest.qualification?.blockers ?? [],
    });
  }

  const candidates = surface.entries.filter(({ targetStatus }) => targetStatus === "candidate");
  setPresent(checks, "release-root", "Release digest, artifact inventory, and read-only tree are verified.", {
    releaseDigest,
    artifactCount: manifest.artifacts.length,
  });
  setPresent(checks, "release-audit-schema", "Release-contained audit and surface schemas loaded successfully.");
  const releaseSummary = {
    releaseDigest,
    artifactCount: manifest.artifacts.length,
    candidateEntries: candidates.length,
    candidateClaims: new Set(candidates.map(({ claimId }) => claimId)).size,
    manifestBlockers: manifest.qualification?.blockers ?? [],
  };

  if (!options.evidenceRoot) {
    setMissing(checks, "evidence-root", "evidence-root-not-configured", "No external evidence root was supplied.");
    if (!options.trustedPolicySha256) {
      setMissing(checks, "trusted-policy-pin", "trusted-policy-pin-not-configured", "No out-of-band trusted-policy SHA-256 was supplied.");
    } else if (!SHA256_PATTERN.test(options.trustedPolicySha256)) {
      setInvalid(checks, "trusted-policy-pin", "external", "trusted-policy-pin-invalid", "Trusted-policy pin must be a lowercase SHA-256 digest.");
    } else {
      setPresent(checks, "trusted-policy-pin", "Out-of-band trusted-policy digest is syntactically valid.");
    }
    dependencyChecks(checks, "missing", "external", "external-evidence-not-configured", "External release evidence was not supplied.");
    return reportResult(options, checks, releaseSummary);
  }

  let evidenceIo;
  try {
    evidenceIo = evidenceIoFactory(options.evidenceRoot);
    setPresent(checks, "evidence-root", "Evidence root permissions, type, and containment contract are valid.");
  } catch (error) {
    const missing = isMissingFile(error);
    checks.set("evidence-root", {
      id: "evidence-root",
      status: missing ? "missing" : "invalid",
      origin: "external",
      code: missing ? "evidence-root-missing" : "evidence-root-invalid",
      message: errorMessage(error),
    });
    if (!options.trustedPolicySha256) {
      setMissing(checks, "trusted-policy-pin", "trusted-policy-pin-not-configured", "No out-of-band trusted-policy SHA-256 was supplied.");
    } else if (!SHA256_PATTERN.test(options.trustedPolicySha256)) {
      setInvalid(checks, "trusted-policy-pin", "external", "trusted-policy-pin-invalid", "Trusted-policy pin must be a lowercase SHA-256 digest.");
    } else {
      setPresent(checks, "trusted-policy-pin", "Out-of-band trusted-policy digest is syntactically valid.");
    }
    dependencyChecks(
      checks,
      missing ? "missing" : "invalid",
      "external",
      missing ? "evidence-root-missing" : "evidence-root-invalid",
      "Evidence-root-dependent checks cannot run.",
    );
    return reportResult(options, checks, releaseSummary);
  }

  if (!options.trustedPolicySha256) {
    setMissing(checks, "trusted-policy-pin", "trusted-policy-pin-not-configured", "No out-of-band trusted-policy SHA-256 was supplied.");
  } else if (!SHA256_PATTERN.test(options.trustedPolicySha256)) {
    setInvalid(checks, "trusted-policy-pin", "external", "trusted-policy-pin-invalid", "Trusted-policy pin must be a lowercase SHA-256 digest.");
  } else {
    setPresent(checks, "trusted-policy-pin", "Out-of-band trusted-policy digest is syntactically valid.");
  }

  let index;
  try {
    index = auditModule.releaseEvidenceIndexSchema.parse(
      evidenceIo.readJson(options.indexPath ?? "evidence-index.v3.json").document,
    );
    if (index.releaseDigest !== releaseDigest
      || canonicalJson(index.runtimeTrust) !== canonicalJson(runtimeTrust)) {
      throw new Error("Evidence index release or RuntimeTrust binding mismatch");
    }
    setPresent(checks, "evidence-index", "Canonical evidence index is complete and release-bound.");
  } catch (error) {
    const missing = isMissingFile(error);
    checks.set("evidence-index", {
      id: "evidence-index",
      status: missing ? "missing" : "invalid",
      origin: "external",
      code: missing ? "evidence-index-missing" : "evidence-index-invalid",
      message: errorMessage(error),
    });
    for (const id of [
      "trust-policy",
      "security-audit",
      "preregistration",
      "rights-attestation",
      "qualification-trust-policy",
      "build-authority-attestation",
      "authority-isolation-attestation",
      "qualification-resolution",
      ...QUALIFICATION_KINDS.map((kind) => `phase-report:${kind}`),
      "cold-canary-gates",
      "q2-claim-coverage",
      "evidence-collection",
    ]) {
      if (missing) setMissing(checks, id, "evidence-index-missing", "Evidence location is unavailable until the external index is supplied.");
      else setInvalid(checks, id, "external", "evidence-index-invalid", "Evidence cannot be trusted through an invalid index.");
    }
    for (const id of ["release-evidence", "release-authorization", "finalizer-key-id", "finalizer-private-key"]) {
      setMissing(checks, id, "external-evidence-incomplete", "Finalization input cannot be validated before evidence collection is complete.");
    }
    return reportResult(options, checks, releaseSummary);
  }

  let policy;
  try {
    const policyFile = evidenceIo.readJson(index.trustPolicy.path);
    const policyDigest = sha256Bytes(policyFile.bytes);
    if (policyDigest !== index.trustPolicy.sha256
      || policyDigest !== runtimeTrust.trustPolicyDigests.release) {
      throw new Error("Trusted-policy digest does not match its index and RuntimeTrust release pin");
    }
    policy = auditModule.releaseTrustedKeyPolicySchema.parse(
      policyFile.document,
    );
    if (options.trustedPolicySha256 && policyDigest !== options.trustedPolicySha256) {
      throw new Error("Trusted-policy file does not match the out-of-band pin");
    }
    setPresent(
      checks,
      "trust-policy",
      options.trustedPolicySha256
        ? "Canonical trust policy matches its index reference and supplied pin."
        : "Canonical trust policy matches its index reference; the out-of-band pin is still missing.",
      {
        sha256: policyDigest,
      },
    );
  } catch (error) {
    const missing = isMissingFile(error);
    checks.set("trust-policy", {
      id: "trust-policy",
      status: missing ? "missing" : "invalid",
      origin: "external",
      code: missing ? "trust-policy-missing" : "trust-policy-invalid",
      message: errorMessage(error),
    });
  }

  const signaturesTrusted = Boolean(
    policy
      && checks.get("trust-policy")?.status === "present"
      && checks.get("trusted-policy-pin")?.status === "present",
  );
  let securityAudit;
  let securityAuditSigned;
  try {
    if (!signaturesTrusted) {
      throw new Error("Trusted-policy pin and valid policy are required before signature verification");
    }
    securityAuditSigned = readReference(evidenceIo, index.securityAudit);
    securityAudit = auditModule.validateReleaseSecurityAuditEvidence(
      securityAuditSigned.document,
      auditModule.securityAuditBindingFromReleaseManifest(
        manifest,
        releaseDigest,
        { runtimeInstallSealSha256, runtimeTreeSha256, runtimePolicySha256, nodeExecutableSha256, runtimeTrust },
      ),
      now,
      evidenceIo.readBytes,
    );
    const securityAuditDigest = auditModule.verifyDetachedSignature(
      securityAudit,
      securityAuditSigned.signature,
      policy,
      "qualification-attestor",
      now,
    );
    if (securityAuditDigest !== index.securityAudit.sha256) {
      throw new Error("Security audit index or signature binding mismatch");
    }
    setPresent(
      checks,
      "security-audit",
      "Current signed security audit is evidence-valid for the exact HOLD release; it does not independently authorize GO.",
      {
        sha256: securityAuditDigest,
        cutoffAt: securityAudit.cutoffAt,
        expiresAt: securityAudit.expiresAt,
      },
    );
  } catch (error) {
    const missing = isMissingFile(error);
    checks.set("security-audit", {
      id: "security-audit",
      status: missing || !signaturesTrusted ? "missing" : "invalid",
      origin: "external",
      code: missing
        ? "security-audit-missing"
        : !signaturesTrusted
          ? "trusted-policy-prerequisite-missing"
          : securityAuditErrorCode(error),
      message: errorMessage(error),
    });
  }

  let preregistration;
  let preregistrationSigned;
  try {
    if (!signaturesTrusted) throw new Error("Trusted-policy pin and valid policy are required before signature verification");
    preregistrationSigned = readReference(evidenceIo, index.preregistration);
    preregistration = preregistrationSigned.document;
    const preregistrationDigest = auditModule.verifyDetachedSignature(
      preregistration,
      preregistrationSigned.signature,
      policy,
      "preregistration-freezer",
      now,
    );
    if (!preregistration || typeof preregistration !== "object"
      || preregistration.schema_version !== "ltx-av-eval-preregistration.v2"
      || preregistration.status !== "frozen"
      || !Array.isArray(preregistration.target_sota_claim_ids)
      || preregistration.target_sota_claim_ids.length === 0
      || preregistrationDigest !== index.preregistrationDigest
      || preregistrationDigest !== index.preregistration.sha256
      || canonicalJson(preregistration.target_sota_claim_ids) !== canonicalJson(index.targetSotaClaimIds)) {
      throw new Error("Frozen preregistration binding mismatch");
    }
    setPresent(checks, "preregistration", "Frozen preregistration and detached signature are valid and release-index-bound.");
  } catch (error) {
    const missing = isMissingFile(error);
    checks.set("preregistration", {
      id: "preregistration",
      status: missing || !signaturesTrusted ? "missing" : "invalid",
      origin: "external",
      code: missing
        ? "preregistration-missing"
        : !signaturesTrusted
          ? "trusted-policy-prerequisite-missing"
          : "preregistration-invalid",
      message: errorMessage(error),
    });
  }

  let rightsSigned;
  let rights;
  let rightsDigest;
  try {
    if (!signaturesTrusted) throw new Error("Trusted-policy pin and valid policy are required before signature verification");
    rightsSigned = readReference(evidenceIo, index.rightsAttestation);
    rights = auditModule.rightsAttestationSchema.parse(rightsSigned.document);
    rightsDigest = auditModule.verifyDetachedSignature(
      rights,
      rightsSigned.signature,
      policy,
      "rights-attestor",
      now,
    );
    const requiredRights = new Set(candidates.flatMap(({ rights: entryRights }) => entryRights.evidenceIds));
    if (rightsDigest !== index.rightsAttestation.sha256
      || rights.releaseDigest !== releaseDigest
      || rights.surfaceDigest !== manifest.surface.sha256
      || rights.evidenceCatalogDigest !== manifest.rights.evidenceCatalog.sha256
      || canonicalJson(rights.runtimeTrust) !== canonicalJson(runtimeTrust)
      || Date.parse(rights.validAt) > now.getTime()
      || Date.parse(rights.expiresAt) <= now.getTime()
      || [...requiredRights].some((id) => !rights.evidenceIds.includes(id))) {
      throw new Error("Rights attestation is stale, incomplete, or bound to different release evidence");
    }
    setPresent(checks, "rights-attestation", "Current signed rights attestation covers every candidate evidence requirement.", {
      sha256: rightsDigest,
    });
  } catch (error) {
    const missing = isMissingFile(error);
    checks.set("rights-attestation", {
      id: "rights-attestation",
      status: missing || !signaturesTrusted ? "missing" : "invalid",
      origin: "external",
      code: missing
        ? "rights-attestation-missing"
        : !signaturesTrusted
          ? "trusted-policy-prerequisite-missing"
          : "rights-attestation-invalid",
      message: errorMessage(error),
    });
  }

  let qualificationTrustPolicy;
  try {
    if (!signaturesTrusted) {
      throw new Error("Trusted release-policy pin is required before qualification policy separation can be checked");
    }
    const policyFile = evidenceIo.readJson(index.qualification.trustPolicy.path);
    const policyDigest = sha256Bytes(policyFile.bytes);
    qualificationTrustPolicy = auditModule.qualificationResolutionTrustPolicySchema.parse(
      policyFile.document,
    );
    if (policyDigest !== index.qualification.trustPolicy.sha256
      || policyDigest !== runtimeTrust.trustPolicyDigests.qualificationAuthorizer) {
      throw new Error("Qualification trust policy does not match its evidence index and RuntimeTrust pin");
    }
    setPresent(
      checks,
      "qualification-trust-policy",
      "Dedicated resolver/build/authority key policy is strict and matches the RuntimeTrust qualification-authorizer pin.",
      { sha256: policyDigest },
    );
  } catch (error) {
    const missing = isMissingFile(error);
    checks.set("qualification-trust-policy", {
      id: "qualification-trust-policy",
      status: missing || !signaturesTrusted ? "missing" : "invalid",
      origin: "external",
      code: missing
        ? "qualification-trust-policy-missing"
        : !signaturesTrusted
          ? "trusted-policy-prerequisite-missing"
          : "qualification-trust-policy-invalid",
      message: errorMessage(error),
    });
  }

  const readQualificationArtifact = (checkId, reference, schema, missingCode) => {
    try {
      if (!qualificationTrustPolicy) throw new Error("A pinned qualification trust policy is required");
      const signed = readReference(evidenceIo, reference);
      const parsed = schema.parse({ document: signed.document, signature: signed.signature });
      setPresent(
        checks,
        checkId,
        "Indexed strict signed qualification artifact is present; collector performs final signature, freshness, and release binding.",
        { sha256: reference.sha256 },
      );
      return parsed;
    } catch (error) {
      const missing = isMissingFile(error);
      checks.set(checkId, {
        id: checkId,
        status: missing ? "missing" : "invalid",
        origin: "external",
        code: missing ? missingCode : `${checkId}-invalid`,
        message: errorMessage(error),
      });
      return undefined;
    }
  };
  const buildAuthoritySigned = readQualificationArtifact(
    "build-authority-attestation",
    index.qualification.buildAuthorityAttestation,
    auditModule.signedBuildAuthorityAttestationSchema,
    "build-authority-attestation-missing",
  );
  const authorityIsolationSigned = readQualificationArtifact(
    "authority-isolation-attestation",
    index.qualification.authorityIsolationAttestation,
    auditModule.signedAuthorityIsolationAttestationSchema,
    "authority-isolation-attestation-missing",
  );
  const qualificationResolutionSigned = readQualificationArtifact(
    "qualification-resolution",
    index.qualification.resolution,
    auditModule.signedQualificationResolutionSchema,
    "qualification-resolution-missing",
  );

  const reportReferences = new Map(index.reports.map((reference) => [reference.kind, reference]));
  const reports = new Map();
  for (const kind of QUALIFICATION_KINDS) {
    const id = `phase-report:${kind}`;
    try {
      if (!signaturesTrusted) throw new Error("Trusted-policy pin and valid policy are required before signature verification");
      const reference = reportReferences.get(kind);
      if (!reference) throw new Error(`Evidence index has no ${kind} report reference`);
      const signed = readReference(evidenceIo, reference);
      const report = auditModule.qualificationReportSchema.parse(signed.document);
      const reportDigest = sha256Bytes(signed.bytes);
      if (reportDigest !== reference.sha256
        || report.kind !== kind
        || report.releaseDigest !== releaseDigest
        || report.preregistrationDigest !== index.preregistrationDigest
        || report.surfaceDigest !== manifest.surface.sha256
        || canonicalJson(report.runtimeTrust) !== canonicalJson(runtimeTrust)) {
        throw new Error(`${kind} qualification report binding mismatch`);
      }
      auditModule.verifyDetachedSignature(
        report,
        signed.signature,
        policy,
        kind === "q2-holdout" ? "holdout-scorer" : "qualification-attestor",
        now,
      );
      reports.set(kind, { ...signed, kind, sha256: reportDigest, report });
      setPresent(checks, id, `Signed ${kind} report is schema-valid and release-bound.`, {
        sha256: reportDigest,
      });
    } catch (error) {
      const missing = isMissingFile(error);
      checks.set(id, {
        id,
        status: missing || !signaturesTrusted ? "missing" : "invalid",
        origin: "external",
        code: missing
          ? "phase-report-missing"
          : !signaturesTrusted
            ? "trusted-policy-prerequisite-missing"
            : "phase-report-invalid",
        message: errorMessage(error),
      });
    }
  }

  const r3 = reports.get("r3-canaries")?.report;
  if (!r3) {
    const dependency = checks.get("phase-report:r3-canaries");
    checks.set("cold-canary-gates", {
      id: "cold-canary-gates",
      status: dependency.status,
      origin: dependency.origin,
      code: "r3-canary-report-unavailable",
      message: "Cold-canary coverage cannot be established without a valid R3 canary report.",
    });
  } else {
    const coverage = new Map(r3.coverage.map(({ surfaceEntryId, gates }) => [surfaceEntryId, new Set(gates)]));
    const missingCoverage = candidates.flatMap((entry) => {
      const required = entry.applicableGates.filter((gate) => COLD_CANARY_GATES.includes(gate));
      const observed = coverage.get(entry.id) ?? new Set();
      return required.filter((gate) => !observed.has(gate)).map((gate) => `${entry.id}:${gate}`);
    });
    if (missingCoverage.length > 0) {
      setInvalid(
        checks,
        "cold-canary-gates",
        "external",
        "cold-canary-coverage-incomplete",
        `R3 report lacks ${missingCoverage.length} candidate/gate bindings.`,
      );
    } else {
      setPresent(checks, "cold-canary-gates", "Every candidate has signed cold-canary, playable-output, and provenance coverage.", {
        candidateEntries: candidates.length,
      });
    }
  }

  const q2 = reports.get("q2-holdout")?.report;
  if (!q2) {
    const dependency = checks.get("phase-report:q2-holdout");
    checks.set("q2-claim-coverage", {
      id: "q2-claim-coverage",
      status: dependency.status,
      origin: dependency.origin,
      code: "q2-report-unavailable",
      message: "Q2 claim coverage cannot be established without a valid holdout report.",
    });
  } else {
    const candidateClaims = new Set(candidates.map(({ claimId }) => claimId));
    const results = new Map(q2.claimResults.map((result) => [result.claimId, result]));
    const missingClaims = [...candidateClaims].filter((claim) => !results.has(claim));
    const foreignClaims = [...results.keys()].filter((claim) => !candidateClaims.has(claim));
    const unqualifiedTargets = index.targetSotaClaimIds.filter(
      (claim) => results.get(claim)?.status !== "sota-qualified",
    );
    const missingQ2Gates = candidates.flatMap((entry) => {
      const required = entry.applicableGates.filter((gate) => FINAL_OWNER[gate] === "q2-holdout");
      const coverage = q2.coverage.find(({ surfaceEntryId }) => surfaceEntryId === entry.id)?.gates ?? [];
      return required.filter((gate) => !coverage.includes(gate)).map((gate) => `${entry.id}:${gate}`);
    });
    if (missingClaims.length > 0 || foreignClaims.length > 0
      || unqualifiedTargets.length > 0 || missingQ2Gates.length > 0) {
      setInvalid(
        checks,
        "q2-claim-coverage",
        "external",
        "q2-claim-coverage-incomplete",
        `Q2 coverage mismatch: missingClaims=${missingClaims.length}, foreignClaims=${foreignClaims.length}, unqualifiedTargets=${unqualifiedTargets.length}, missingGates=${missingQ2Gates.length}.`,
      );
    } else {
      setPresent(checks, "q2-claim-coverage", "Q2 covers every candidate claim/gate and qualifies every frozen target.", {
        candidateClaims: candidateClaims.size,
        targetSotaClaims: index.targetSotaClaimIds.length,
      });
    }
  }

  let derivedEvidence;
  const evidenceInputsReady = [
    "trusted-policy-pin",
    "trust-policy",
    "security-audit",
    "preregistration",
    "rights-attestation",
    "qualification-trust-policy",
    "build-authority-attestation",
    "authority-isolation-attestation",
    "qualification-resolution",
    ...QUALIFICATION_KINDS.map((kind) => `phase-report:${kind}`),
    "cold-canary-gates",
    "q2-claim-coverage",
  ].every((id) => checks.get(id)?.status === "present");
  if (!evidenceInputsReady) {
    setMissing(checks, "evidence-collection", "external-evidence-incomplete", "Evidence collection prerequisites are incomplete.");
  } else {
    try {
      derivedEvidence = auditModule.collectReleaseEvidence({
        now,
        releaseDigest,
        manifestSurfaceDigest: manifest.surface.sha256,
        manifestRightsCatalogDigest: manifest.rights.evidenceCatalog.sha256,
        surface,
        index,
        trustPolicy: policy,
        preregistration: {
          document: preregistrationSigned.document,
          signature: preregistrationSigned.signature,
        },
        rightsAttestation: {
          document: rightsSigned.document,
          signature: rightsSigned.signature,
        },
        securityAudit: {
          document: securityAuditSigned.document,
          signature: securityAuditSigned.signature,
          sha256: index.securityAudit.sha256,
        },
        securityAuditBinding: auditModule.securityAuditBindingFromReleaseManifest(
          manifest,
          releaseDigest,
          { runtimeInstallSealSha256, runtimeTreeSha256, runtimePolicySha256, nodeExecutableSha256, runtimeTrust },
        ),
        securityAuditReadArtifact: evidenceIo.readBytes,
        reports: QUALIFICATION_KINDS.map((kind) => {
          const report = reports.get(kind);
          return {
            document: report.report,
            signature: report.signature,
            kind,
            sha256: report.sha256,
          };
        }),
        trustPolicyDigest: options.trustedPolicySha256,
        qualificationTrustPolicy,
        qualificationTrustPolicyDigest: index.qualification.trustPolicy.sha256,
        buildAuthorityAttestation: buildAuthoritySigned,
        authorityIsolationAttestation: authorityIsolationSigned,
        qualificationResolution: qualificationResolutionSigned,
      });
      setPresent(
        checks,
        "manifest-qualification",
        "Immutable manifest HOLD is discharged only by the current signed Qualification Resolution v2; manifest bytes remain unchanged.",
        { qualificationResolutionSha256: derivedEvidence.qualificationResolutionDigest },
      );
      for (const id of [
        "qualification-trust-policy",
        "build-authority-attestation",
        "authority-isolation-attestation",
        "qualification-resolution",
      ]) {
        const prior = checks.get(id);
        setPresent(checks, id, `Collector reverified ${id} signature, freshness, role separation, and immutable release binding.`, prior?.observed);
      }
      setPresent(checks, "evidence-collection", "All release-evidence inputs pass the release-contained collector without writing output.");
    } catch (error) {
      setInvalid(checks, "evidence-collection", "external", "evidence-collection-invalid", errorMessage(error));
      setInvalid(
        checks,
        "qualification-resolution",
        "external",
        "qualification-resolution-invalid",
        errorMessage(error),
      );
    }
  }

  let persistedEvidence;
  let persistedEvidenceDigest;
  const evidencePath = options.evidencePath ?? "release-evidence.v3.json";
  try {
    const evidenceFile = evidenceIo.readJson(evidencePath);
    persistedEvidence = auditModule.releaseEvidenceSchema.parse(evidenceFile.document);
    persistedEvidenceDigest = sha256Bytes(evidenceFile.bytes);
    if (!derivedEvidence
      || canonicalJson(persistedEvidence) !== canonicalJson(derivedEvidence)) {
      throw new Error("Persisted release evidence does not equal the collector result for current inputs");
    }
    setPresent(checks, "release-evidence", "Persisted write-once release evidence matches the current collector result.", {
      sha256: persistedEvidenceDigest,
    });
  } catch (error) {
    const missing = isMissingFile(error);
    checks.set("release-evidence", {
      id: "release-evidence",
      status: missing ? "missing" : "invalid",
      origin: "external",
      code: missing ? "release-evidence-missing" : "release-evidence-invalid",
      message: errorMessage(error),
    });
  }

  let verifiedAuthorization;
  const authorizationPath = options.authorizationPath ?? "release-authorization.v4.json";
  const authorizationSignaturePath = options.authorizationSignaturePath
    ?? "release-authorization.v4.sig.json";
  try {
    if (!persistedEvidence || !persistedEvidenceDigest || !rightsDigest || !policy) {
      throw new Error("Verified release evidence, rights, and trust policy are prerequisites");
    }
    const authorization = evidenceIo.readJson(authorizationPath).document;
    const authorizationSignature = evidenceIo.readJson(authorizationSignaturePath).document;
    verifiedAuthorization = validateAuthorization({
      auditModule,
      authorization,
      authorizationSignature,
      evidence: persistedEvidence,
      evidenceDigest: persistedEvidenceDigest,
      rightsDigest,
      policy,
      runtimeIdentity: {
        runtimeInstallSealSha256,
        runtimeTreeSha256,
        runtimePolicySha256,
        nodeExecutableSha256,
      },
      now,
    });
    setPresent(checks, "release-authorization", "External release authorization and signature are current and fully bound.");
  } catch (error) {
    const missing = isMissingFile(error);
    checks.set("release-authorization", {
      id: "release-authorization",
      status: missing ? "missing" : "invalid",
      origin: "external",
      code: missing ? "release-authorization-missing" : "release-authorization-invalid",
      message: errorMessage(error),
    });
  }

  let finalizerKey;
  if (!options.finalizerKeyId) {
    setMissing(checks, "finalizer-key-id", "finalizer-key-id-not-configured", "No external audit-finalizer key ID was supplied.");
  } else if (!IDENTIFIER_PATTERN.test(options.finalizerKeyId)) {
    setInvalid(checks, "finalizer-key-id", "external", "finalizer-key-id-invalid", "Finalizer key ID has invalid syntax.");
  } else {
    try {
      if (!policy) throw new Error("A valid trusted policy is required");
      finalizerKey = policy.keys.find(({ keyId }) => keyId === options.finalizerKeyId);
      verifyCurrentKey(finalizerKey, now, "audit-finalizer");
      if (verifiedAuthorization?.signature.keyId === options.finalizerKeyId) {
        throw new Error("Release authorizer and audit finalizer must use different keys");
      }
      setPresent(checks, "finalizer-key-id", "Finalizer key ID is trusted, current, unrevoked, and role-separated.");
    } catch (error) {
      setInvalid(checks, "finalizer-key-id", "external", "finalizer-key-id-invalid", errorMessage(error));
    }
  }

  if (!options.finalizerPrivateKeyPath) {
    setMissing(checks, "finalizer-private-key", "finalizer-private-key-not-configured", "No owner-only external finalizer private-key path was supplied.");
  } else {
    try {
      if (!finalizerKey) throw new Error("A valid finalizer key ID is required before private-key matching");
      const privateKeyPem = privateKeyReader(options.finalizerPrivateKeyPath);
      validateFinalizerPrivateKey(privateKeyPem, finalizerKey);
      setPresent(checks, "finalizer-private-key", "Owner-only finalizer private key matches the trusted public key; no signature was created.");
    } catch (error) {
      const missing = isMissingFile(error);
      checks.set("finalizer-private-key", {
        id: "finalizer-private-key",
        status: missing ? "missing" : "invalid",
        origin: "external",
        code: missing ? "finalizer-private-key-missing" : "finalizer-private-key-invalid",
        message: errorMessage(error),
      });
    }
  }

  return reportResult(options, checks, releaseSummary);
}

export function parsePreflightArguments(argv) {
  const optionNames = new Map([
    ["--release", "expectedReleaseDigest"],
    ["--release-root", "releaseRoot"],
    ["--evidence-root", "evidenceRoot"],
    ["--index", "indexPath"],
    ["--trusted-policy-sha256", "trustedPolicySha256"],
    ["--evidence", "evidencePath"],
    ["--authorization", "authorizationPath"],
    ["--authorization-signature", "authorizationSignaturePath"],
    ["--finalizer-key-id", "finalizerKeyId"],
    ["--finalizer-private-key", "finalizerPrivateKeyPath"],
  ]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!optionNames.has(name)) throw new Error(`Unsupported preflight option: ${name ?? "<missing>"}`);
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    const property = optionNames.get(name);
    if (property in parsed) throw new Error(`Duplicate preflight option: ${name}`);
    parsed[property] = value;
  }
  if (!parsed.expectedReleaseDigest) throw new Error("--release requires a value");
  parsed.releaseRoot = parsed.releaseRoot
    ?? `/opt/ltx-studio/releases/${parsed.expectedReleaseDigest}`;
  return parsed;
}
