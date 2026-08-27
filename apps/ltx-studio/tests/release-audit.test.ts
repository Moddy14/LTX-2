import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  activationEnvelopeDigest,
  activationRecordDigest,
  type ActivationJournalEnvelope,
  type ActivationJournalRecord,
} from "../shared/activation.js";
import { validateReleasePromotion } from "../server/releasePromotion.js";
import {
  collectReleaseEvidence,
  finalizeReleaseAudit,
  qualificationGateOwnership,
  qualificationKinds,
  releaseEvidenceSchema,
  releaseTrustedKeyPolicySchema,
  verifyReleasePromotionBundle,
  type QualificationKind,
  type ReleaseEvidenceInput,
} from "../shared/releaseAudit.js";
import {
  buildAuthorityResolvedBlockers,
  expectedQualificationResolutions,
  type QualificationEvidenceDigests,
  type QualificationResolutionTrustRole,
} from "../shared/qualificationResolution.js";
import { releaseGateIds } from "../shared/releaseSurface.js";
import { runtimeTrustFixture } from "./runtime-trust-fixture.js";

const NOW = new Date("2026-08-11T12:00:00Z");
const DIGEST = {
  release: "1".repeat(64),
  catalog: "2".repeat(64),
  producer: "3".repeat(64),
};

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function timestamp(offsetHours: number): string {
  return new Date(NOW.getTime() + offsetHours * 3_600_000)
    .toISOString()
    .replace(".000", "");
}

type Fixture = ReleaseEvidenceInput & {
  signDocument: (document: unknown) => Record<string, unknown>;
  signEvidenceDocument: (document: unknown) => Record<string, unknown>;
  signSecurityDocument: (document: unknown) => Record<string, unknown>;
  signHoldoutDocument: (document: unknown) => Record<string, unknown>;
  signInfrastructureDocument: (document: unknown) => Record<string, unknown>;
  signQualificationDocument: (
    role: QualificationResolutionTrustRole,
    document: unknown,
  ) => Record<string, unknown>;
  writeSecurityArtifact: (path: string, document: unknown) => string;
  finalizerPrivateKeyPem: string;
};

function fixture(): Fixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const authorizer = generateKeyPairSync("ed25519");
  const qualification = generateKeyPairSync("ed25519");
  const holdout = generateKeyPairSync("ed25519");
  const finalizer = generateKeyPairSync("ed25519");
  const infrastructureScanner = generateKeyPairSync("ed25519");
  const buildAuthority = generateKeyPairSync("ed25519");
  const authorityIsolation = generateKeyPairSync("ed25519");
  const qualificationResolver = generateKeyPairSync("ed25519");
  const rawPublicKey = publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const trustPolicy = {
    schemaVersion: "ltx-studio-trusted-keys.v1",
    policyId: "independent-policy-01",
    keys: [
      {
        keyId: "independent-key-01",
        algorithm: "ed25519",
        publicKeyBase64: rawPublicKey.toString("base64"),
        roles: [
          "preregistration-freezer",
          "rights-attestor",
        ],
        notBefore: timestamp(-24),
        notAfter: timestamp(24),
        revokedAt: null,
      },
      {
        keyId: "qualification-key-01",
        algorithm: "ed25519",
        publicKeyBase64: qualification.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
        roles: ["qualification-attestor"],
        notBefore: timestamp(-24),
        notAfter: timestamp(24),
        revokedAt: null,
      },
      {
        keyId: "holdout-scorer-key-01",
        algorithm: "ed25519",
        publicKeyBase64: holdout.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
        roles: ["holdout-scorer"],
        notBefore: timestamp(-24),
        notAfter: timestamp(24),
        revokedAt: null,
      },
      {
        keyId: "audit-finalizer-key-01",
        algorithm: "ed25519",
        publicKeyBase64: finalizer.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
        roles: ["audit-finalizer"],
        notBefore: timestamp(-24),
        notAfter: timestamp(24),
        revokedAt: null,
      },
      {
        keyId: "release-authorizer-key-01",
        algorithm: "ed25519",
        publicKeyBase64: authorizer.publicKey
          .export({ format: "der", type: "spki" })
          .subarray(-32)
          .toString("base64"),
        roles: ["release-authorizer"],
        notBefore: timestamp(-24),
        notAfter: timestamp(24),
        revokedAt: null,
      },
    ],
  };
  const trustPolicyDigest = hash(trustPolicy);
  const qualificationKeys = {
    "build-authority-attestor": {
      keyId: "build-authority-attestor-key-01",
      keyPair: buildAuthority,
    },
    "authority-isolation-attestor": {
      keyId: "authority-isolation-attestor-key-01",
      keyPair: authorityIsolation,
    },
    "qualification-resolver": {
      keyId: "qualification-resolver-key-01",
      keyPair: qualificationResolver,
    },
  } as const;
  const qualificationTrustPolicy = {
    schemaVersion: "ltx-studio-qualification-resolution-trust.v1" as const,
    policyId: "qualification-resolution-policy-01",
    keys: Object.entries(qualificationKeys).map(([role, { keyId, keyPair }]) => ({
      keyId,
      algorithm: "ed25519" as const,
      role: role as QualificationResolutionTrustRole,
      publicKeyBase64: keyPair.publicKey
        .export({ format: "der", type: "spki" })
        .subarray(-32)
        .toString("base64"),
      notBefore: timestamp(-24),
      notAfter: timestamp(24),
      revokedAt: null,
    })),
  };
  const qualificationTrustPolicyDigest = hash(qualificationTrustPolicy);
  const runtimeTrust = {
    ...runtimeTrustFixture,
    trustPolicyDigests: {
      ...runtimeTrustFixture.trustPolicyDigests,
      release: trustPolicyDigest,
      qualificationAuthorizer: qualificationTrustPolicyDigest,
    },
  };
  const signQualificationDocument = (
    role: QualificationResolutionTrustRole,
    document: unknown,
  ) => {
    const key = qualificationKeys[role];
    return {
      schemaVersion: "ltx-studio-qualification-resolution-signature.v1",
      algorithm: "ed25519",
      role,
      keyId: key.keyId,
      payloadSha256: hash(document),
      signatureBase64: sign(
        null,
        Buffer.from(canonicalJson(document)),
        key.keyPair.privateKey,
      ).toString("base64"),
    };
  };
  const signature = (document: unknown) => ({
    schemaVersion: "ltx-studio-detached-signature.v1",
    algorithm: "ed25519",
    keyId: "release-authorizer-key-01",
    payloadSha256: hash(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      authorizer.privateKey,
    ).toString("base64"),
  });
  const evidenceSignature = (document: unknown) => ({
    schemaVersion: "ltx-studio-detached-signature.v1",
    algorithm: "ed25519",
    keyId: "independent-key-01",
    payloadSha256: hash(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      privateKey,
    ).toString("base64"),
  });
  const holdoutSignature = (document: unknown) => ({
    schemaVersion: "ltx-studio-detached-signature.v1",
    algorithm: "ed25519",
    keyId: "holdout-scorer-key-01",
    payloadSha256: hash(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      holdout.privateKey,
    ).toString("base64"),
  });
  const qualificationSignature = (document: unknown) => ({
    schemaVersion: "ltx-studio-detached-signature.v1",
    algorithm: "ed25519",
    keyId: "qualification-key-01",
    payloadSha256: hash(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      qualification.privateKey,
    ).toString("base64"),
  });
  const surface = {
    schemaVersion: "candidate-release-surface.v1",
    policyVersion: "ltx-studio-release-rights.v1",
    inputs: {
      requestSchema: { path: "shared/pipelines.ts", sha256: "4".repeat(64) },
      capabilityMatrix: {
        path: "shared/releaseSurface.ts",
        sha256: "5".repeat(64),
      },
    },
    activationContract: {
      candidate:
        "requires-current-signed-rights-attest-and-all-applicable-gates",
      blocked: "must-not-run-in-production-or-support-release-claims",
    },
    entries: [
      {
        id: "lipdub.native",
        claimId: "reference-video-redubbing.native",
        request: {
          mode: "lipdub",
          sourceMode: "not-applicable",
          icLoraProfile: null,
          lipDubPipelineProfile: "official-comfy-hq",
          retakeCheckpoint: null,
          modelProfile: "ltx23-monolith",
          unionControlType: null,
          promptEncoderProfile: "not-applicable",
          dialogueIntent: "required",
          postprocessor: "none",
          dfrTemporalUpscalings: null,
          dfrSpatialUpscalings: null,
        },
        inputContract: ["reference-video", "exact-target-dialogue"],
        outputMedia: "video/mp4",
        cooperativeCheckpoint: true,
        applicableGates: [...releaseGateIds],
        notApplicable: [],
        rights: {
          status: "conditional",
          evidenceIds: ["rights.ltx"],
          reason: "signed attestation required",
        },
        targetStatus: "candidate",
        targetReason: null,
      },
    ],
  };
  const preregistration = {
    schema_version: "ltx-av-eval-preregistration.v2",
    status: "frozen",
    target_sota_claim_ids: ["reference-video-redubbing.native"],
  };
  const preregistrationDigest = hash(preregistration);
  const surfaceDigest = hash(surface);
  const rights = {
    schemaVersion: "ltx-studio-rights-attestation.v2",
    releaseDigest: DIGEST.release,
    surfaceDigest,
    evidenceCatalogDigest: DIGEST.catalog,
    runtimeTrust,
    policyVersion: "ltx-studio-release-rights.v1",
    validAt: timestamp(-1),
    expiresAt: timestamp(12),
    revocationState: "clear",
    evidenceIds: ["rights.ltx"],
    warnings: [],
  };
  const manifestQualification = {
    releaseDecision: "hold" as const,
    blockers: [
      "current-signed-rights-attest-missing",
      "signed-build-host-container-scan-reports-missing",
      "root-owned-post-install-host-attestation-missing",
      "dedicated-external-build-authority-attestation-missing",
      "read-only-build-source-mount-not-independently-attested",
      "separate-build-uid-isolation-not-independently-attested",
      "same-uid-transient-source-or-tool-swap-not-excluded",
      "privileged-sudo-docker-control-plane-broker-missing",
      "digest-bound-cold-canary-missing",
      "quality-and-holdout-evidence-missing",
    ],
  };
  const securityAuditBinding = {
    releaseDigest: DIGEST.release,
    runtimeInstallSealSha256: "7".repeat(64),
    runtimeTreeSha256: "6".repeat(64),
    runtimePolicySha256: "5".repeat(64),
    nodeExecutableSha256: "4".repeat(64),
    runtimeTrust,
    manifestQualification,
    boundInputs: {
      nodeLockSha256: "a".repeat(64),
      pythonLockSha256: "b".repeat(64),
      runtimePyprojectSha256: "c".repeat(64),
      runtimeVerifierSha256: "d".repeat(64),
    },
    nodeComponents: [{ name: "express", version: "5.1.0" }],
    pythonComponents: [{ name: "requests", version: "2.34.2" }],
    localComponents: [{
      name: "requests",
      version: "2.34.2",
      source: {
        kind: "local-path" as const,
        locator: "apps/ltx-studio/runtime",
        sha256: "8".repeat(64),
      },
    }],
    runtimeTcbComponents: [{ name: "node" }, { name: "uv" }],
    hostTcbTools: [{ name: "ffmpeg" }],
    hostTcbDockerImages: [
      { name: "latentsync" },
      { name: "lipforcing" },
      { name: "musetalk" },
    ],
    buildTcbComponents: [{ name: "vite", version: "7.1.4" }],
    hostRuntimeComponents: [{ name: "systemd" }],
    containerRuntimeComponents: [{ name: "latentsync" }],
  };
  const securityArtifacts = new Map<string, Buffer>();
  const securityArtifact = (
    path: string,
    mediaType:
      | "application/json"
      | "application/vnd.ltx-studio.security-scan-request+json"
      | "application/vnd.ltx-studio.security-scan-result+json",
    document: unknown,
  ) => {
    const bytes = Buffer.from(canonicalJson(document));
    securityArtifacts.set(path, bytes);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex"), mediaType };
  };
  const writeSecurityArtifact = (path: string, document: unknown): string => {
    const bytes = Buffer.from(canonicalJson(document));
    securityArtifacts.set(path, bytes);
    return createHash("sha256").update(bytes).digest("hex");
  };
  const uvRequest = {
    schemaVersion: "ltx-studio-security-scan-request.v1",
    ecosystem: "python",
    advisoryProvider: "osv.dev",
    releaseDigest: DIGEST.release,
    lockSha256: securityAuditBinding.boundInputs.pythonLockSha256,
    cutoffAt: timestamp(-0.5),
    components: securityAuditBinding.pythonComponents,
  };
  const npmRequest = {
    schemaVersion: "ltx-studio-security-scan-request.v1",
    ecosystem: "npm",
    advisoryProvider: "npm-registry-audit",
    releaseDigest: DIGEST.release,
    lockSha256: securityAuditBinding.boundInputs.nodeLockSha256,
    cutoffAt: timestamp(-0.5),
    components: securityAuditBinding.nodeComponents,
  };
  const uvRequestReference = securityArtifact(
    "security/uv.request.json",
    "application/vnd.ltx-studio.security-scan-request+json",
    uvRequest,
  );
  const npmRequestReference = securityArtifact(
    "security/npm.request.json",
    "application/vnd.ltx-studio.security-scan-request+json",
    npmRequest,
  );
  const uvResponseReference = securityArtifact(
    "security/uv.response.json",
    "application/json",
    { results: [{}] },
  );
  const npmResponseReference = securityArtifact(
    "security/npm.response.json",
    "application/json",
    {
      auditReportVersion: 2,
      metadata: { vulnerabilities: { total: 0 } },
      vulnerabilities: {},
    },
  );
  const scanResult = (
    ecosystem: "npm" | "python",
    advisoryProvider: "npm-registry-audit" | "osv.dev",
    requestSha256: string,
    responseSha256: string,
    components: Array<{ name: string; version: string }>,
  ) => ({
    schemaVersion: "ltx-studio-security-scan-result.v1",
    ecosystem,
    advisoryProvider,
    advisoryCutoffAt: timestamp(-0.5),
    requestSha256,
    responseSha256,
    networkStatus: "complete",
    components: components.map((component) => ({
      ...component,
      status: "clear",
      advisoryIds: [],
    })),
    normalizedAdvisories: [],
    unresolvedFindings: [],
    adverseStatuses: [],
    verdict: "pass",
  });
  const uvResultReference = securityArtifact(
    "security/uv.result.json",
    "application/vnd.ltx-studio.security-scan-result+json",
    scanResult(
      "python",
      "osv.dev",
      uvRequestReference.sha256,
      uvResponseReference.sha256,
      securityAuditBinding.pythonComponents,
    ),
  );
  const npmResultReference = securityArtifact(
    "security/npm.result.json",
    "application/vnd.ltx-studio.security-scan-result+json",
    scanResult(
      "npm",
      "npm-registry-audit",
      npmRequestReference.sha256,
      npmResponseReference.sha256,
      securityAuditBinding.nodeComponents,
    ),
  );
  const infrastructurePublicKey = infrastructureScanner.publicKey
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const infrastructurePublicKeyBase64 = infrastructurePublicKey.toString("base64");
  const infrastructurePublicKeySha256 = createHash("sha256")
    .update(infrastructurePublicKey)
    .digest("hex");
  const signInfrastructureDocument = (document: unknown) => ({
    schemaVersion: "ltx-studio-infrastructure-scan-signature.v1",
    algorithm: "ed25519",
    keyId: "infrastructure-scanner-key-01",
    publicKeyBase64: infrastructurePublicKeyBase64,
    publicKeySha256: infrastructurePublicKeySha256,
    payloadSha256: hash(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      infrastructureScanner.privateKey,
    ).toString("base64"),
  });
  const infrastructureScans = Object.fromEntries(
    (["build", "host", "container"] as const).map((scope) => {
      const components = scope === "build"
        ? securityAuditBinding.buildTcbComponents
        : scope === "host"
          ? [
              ...securityAuditBinding.hostTcbTools,
              ...securityAuditBinding.hostRuntimeComponents,
            ]
          : [
              ...securityAuditBinding.hostTcbDockerImages,
              ...securityAuditBinding.containerRuntimeComponents,
            ];
      const sbomDocument = {
        schemaVersion: "ltx-studio-infrastructure-sbom.v1",
        scope,
        components,
      };
      const document = {
        schemaVersion: "ltx-studio-infrastructure-scan-report.v1",
        scope,
        releaseDigest: DIGEST.release,
        runtimeTrust,
        scanner: {
          name: `fixture-${scope}-scanner`,
          version: "1.0.0",
          executableSha256: hash(`fixture-${scope}-scanner-bytes`),
          rulesDatabaseSha256: hash(`fixture-${scope}-rules-database`),
          rulesCutoffAt: timestamp(-0.5),
        },
        sbomSha256: hash(sbomDocument),
        scannedComponents: components.length,
        omittedComponents: 0,
        normalizedFindings: [],
        unresolvedFindings: [],
        completedAt: timestamp(-0.25),
        expiresAt: timestamp(23),
        verdict: "pass",
      };
      const payloadSha256 = hash(document);
      const signatureDocument = signInfrastructureDocument(document);
      return [scope, {
        report: securityArtifact(
          `security/infrastructure/${scope}.report.json`,
          "application/json",
          document,
        ),
        signature: securityArtifact(
          `security/infrastructure/${scope}.signature.json`,
          "application/json",
          signatureDocument,
        ),
        payloadSha256,
        signerPublicKeySha256: infrastructurePublicKeySha256,
      }];
    }),
  );
  const securityAudit = {
    schemaVersion: "ltx-studio-security-audit.v4",
    releaseDigest: DIGEST.release,
    runtimeInstallSealSha256: securityAuditBinding.runtimeInstallSealSha256,
    runtimeTreeSha256: securityAuditBinding.runtimeTreeSha256,
    runtimePolicySha256: securityAuditBinding.runtimePolicySha256,
    nodeExecutableSha256: securityAuditBinding.nodeExecutableSha256,
    runtimeTrust,
    manifestQualification: securityAuditBinding.manifestQualification,
    generatedAt: timestamp(-0.25),
    cutoffAt: timestamp(-0.5),
    expiresAt: timestamp(12),
    boundInputs: {
      nodeLock: {
        path: "apps/ltx-studio/package-lock.json",
        sha256: securityAuditBinding.boundInputs.nodeLockSha256,
      },
      pythonLock: {
        path: "apps/ltx-studio/runtime/uv.lock",
        sha256: securityAuditBinding.boundInputs.pythonLockSha256,
      },
      runtimePyproject: {
        path: "apps/ltx-studio/runtime/pyproject.toml",
        sha256: securityAuditBinding.boundInputs.runtimePyprojectSha256,
      },
      runtimeVerifier: {
        path: "apps/ltx-studio/runtime/verify_runtime.py",
        sha256: securityAuditBinding.boundInputs.runtimeVerifierSha256,
      },
    },
    infrastructureScans,
    audits: {
      uv: {
        tool: { name: "uv", version: "0.12.2", executableSha256: "e".repeat(64) },
        advisoryProvider: "osv.dev",
        advisoryCutoffAt: timestamp(-0.5),
        request: uvRequestReference,
        response: uvResponseReference,
        normalizedResult: uvResultReference,
      },
      npm: {
        tool: { name: "npm", version: "11.5.1", executableSha256: "0".repeat(64) },
        advisoryProvider: "npm-registry-audit",
        advisoryCutoffAt: timestamp(-0.5),
        request: npmRequestReference,
        response: npmResponseReference,
        normalizedResult: npmResultReference,
      },
    },
    coverage: {
      node: { lockComponents: 1, sbomComponents: 1, auditedComponents: 1, omittedComponents: 0 },
      python: { lockComponents: 1, sbomComponents: 1, auditedComponents: 1, omittedComponents: 0 },
      localComponents: { discoveredComponents: 1, sbomComponents: 1, auditedComponents: 1, omittedComponents: 0 },
    },
    sbom: {
      schemaVersion: "ltx-studio-security-sbom.v3",
      nodeComponents: securityAuditBinding.nodeComponents,
      pythonComponents: securityAuditBinding.pythonComponents,
      localComponents: securityAuditBinding.localComponents.map((component) => ({
        ...component,
        auditedBy: ["osv.dev"],
        verdict: "clear",
      })),
      runtimeTcbComponents: securityAuditBinding.runtimeTcbComponents,
      hostTcbTools: securityAuditBinding.hostTcbTools,
      hostTcbDockerImages: securityAuditBinding.hostTcbDockerImages,
      buildTcbComponents: securityAuditBinding.buildTcbComponents,
      hostRuntimeComponents: securityAuditBinding.hostRuntimeComponents,
      containerRuntimeComponents: securityAuditBinding.containerRuntimeComponents,
    },
    packageAliases: [],
    normalizedAdvisories: [],
    unresolvedFindings: [],
    adverseStatuses: [],
    verdict: "pass",
  };
  const securityAuditDigest = hash(securityAudit);
  const reports = qualificationKinds.map((kind) => {
    const report = {
      schemaVersion: "ltx-studio-qualification-report.v2",
      kind,
      releaseDigest: DIGEST.release,
      preregistrationDigest,
      surfaceDigest,
      runtimeTrust,
      producerId: `producer.${kind}`,
      producerDigest: DIGEST.producer,
      verdict: "pass",
      warnings: [],
      coverage:
        qualificationGateOwnership[kind].length > 0
          ? [
              {
                surfaceEntryId: "lipdub.native",
                gates: [...qualificationGateOwnership[kind]],
              },
            ]
          : [],
      claimResults:
        kind === "q2-holdout"
          ? [
              {
                claimId: "reference-video-redubbing.native",
                status: "sota-qualified",
                sotaAnchorDigest: "6".repeat(64),
              },
            ]
          : [],
    };
    return {
      kind,
      sha256: hash(report),
      document: report,
      signature:
        kind === "q2-holdout"
          ? holdoutSignature(report)
          : qualificationSignature(report),
    };
  });
  const reportReferences = reports.map(({ kind, sha256: reportSha }) => ({
    kind,
    path: `reports/${kind}.json`,
    sha256: reportSha,
    signaturePath: `reports/${kind}.sig.json`,
    signatureSha256: "7".repeat(64),
  }));
  const rightsDigest = hash(rights);
  const buildAuthorityAttestationDocument = {
    schemaVersion: "ltx-studio-build-authority-attestation.v1" as const,
    releaseDigest: DIGEST.release,
    surfaceDigest,
    runtimeTrust,
    qualificationTrustPolicySha256: qualificationTrustPolicyDigest,
    buildTcbSha256: runtimeTrust.buildTcbSha256,
    claims: {
      dedicatedExternalBuildAuthority: true as const,
      readOnlyBuildSourceMount: true as const,
      separateBuildUid: true as const,
      transientSourceAndToolSwapExcluded: true as const,
    },
    resolvedBlockers: [...buildAuthorityResolvedBlockers],
    issuedAt: timestamp(-1),
    expiresAt: timestamp(12),
    verdict: "pass" as const,
    warnings: [],
  };
  const buildAuthorityAttestation = {
    document: buildAuthorityAttestationDocument,
    signature: signQualificationDocument(
      "build-authority-attestor",
      buildAuthorityAttestationDocument,
    ),
  };
  const authorityIsolationAttestationDocument = {
    schemaVersion: "ltx-studio-authority-isolation-attestation.v1" as const,
    releaseDigest: DIGEST.release,
    surfaceDigest,
    runtimeTrust,
    qualificationTrustPolicySha256: qualificationTrustPolicyDigest,
    hostTcbAttestationSha256: runtimeTrust.hostTcbAttestationSha256,
    mechanism: runtimeTrust.authorityIsolation.status === "attested"
      ? runtimeTrust.authorityIsolation.mechanism
      : "separate-studio-identity-proc-fd-isolation" as const,
    brokerAttestationSha256: runtimeTrust.authorityIsolation.status === "attested"
      && runtimeTrust.authorityIsolation.mechanism === "external-signer-sealed-fd-broker"
      ? runtimeTrust.authorityIsolation.brokerAttestationSha256
      : null,
    privilegedControlPlaneIsolationAttested: true as const,
    resolvedBlockers: ["privileged-sudo-docker-control-plane-broker-missing"],
    issuedAt: timestamp(-1),
    expiresAt: timestamp(12),
    verdict: "pass" as const,
    warnings: [],
  };
  const authorityIsolationAttestation = {
    document: authorityIsolationAttestationDocument,
    signature: signQualificationDocument(
      "authority-isolation-attestor",
      authorityIsolationAttestationDocument,
    ),
  };
  const buildAuthorityAttestationDigest = hash(buildAuthorityAttestationDocument);
  const authorityIsolationAttestationDigest = hash(authorityIsolationAttestationDocument);
  const reportDigest = (kind: QualificationKind): string => {
    const found = reports.find((report) => report.kind === kind);
    if (!found) throw new Error(`missing fixture report ${kind}`);
    return found.sha256;
  };
  const qualificationEvidenceDigests: QualificationEvidenceDigests = {
    "rights-attestation": rightsDigest,
    "security-audit": securityAuditDigest,
    "host-tcb-attestation": runtimeTrust.hostTcbAttestationSha256,
    "build-authority-attestation": buildAuthorityAttestationDigest,
    "authority-isolation-attestation": authorityIsolationAttestationDigest,
    "r3-canaries-report": reportDigest("r3-canaries"),
    "d1-calibration-report": reportDigest("d1-calibration"),
    "q0-cross-shot-report": reportDigest("q0-cross-shot"),
    "q1-comparators-report": reportDigest("q1-comparators"),
    "q2-holdout-report": reportDigest("q2-holdout"),
  };
  const qualificationResolutionDocument = {
    schemaVersion: "ltx-studio-qualification-resolution.v2" as const,
    releaseDigest: DIGEST.release,
    surfaceDigest,
    manifestQualificationSha256: hash(manifestQualification),
    runtimeTrust,
    qualificationTrustPolicySha256: qualificationTrustPolicyDigest,
    issuedAt: timestamp(-0.5),
    expiresAt: timestamp(12),
    resolutions: expectedQualificationResolutions(
      manifestQualification,
      qualificationEvidenceDigests,
    ),
    unresolvedBlockers: [],
    verdict: "pass" as const,
    warnings: [],
  };
  const qualificationResolution = {
    document: qualificationResolutionDocument,
    signature: signQualificationDocument("qualification-resolver", qualificationResolutionDocument),
  };
  const qualificationResolutionDigest = hash(qualificationResolutionDocument);
  return {
    now: NOW,
    releaseDigest: DIGEST.release,
    manifestSurfaceDigest: surfaceDigest,
    manifestRightsCatalogDigest: DIGEST.catalog,
    surface,
    index: {
      schemaVersion: "ltx-studio-release-evidence-index.v3",
      releaseDigest: DIGEST.release,
      runtimeTrust,
      preregistrationDigest,
      targetSotaClaimIds: ["reference-video-redubbing.native"],
      trustPolicy: { path: "trusted-keys.json", sha256: trustPolicyDigest },
      preregistration: {
        path: "preregistration.json",
        sha256: preregistrationDigest,
        signaturePath: "preregistration.sig.json",
        signatureSha256: "7".repeat(64),
      },
      rightsAttestation: {
        path: "rights.json",
        sha256: rightsDigest,
        signaturePath: "rights.sig.json",
        signatureSha256: "7".repeat(64),
      },
      securityAudit: {
        path: "security-audit.json",
        sha256: securityAuditDigest,
        signaturePath: "security-audit.sig.json",
        signatureSha256: "7".repeat(64),
      },
      qualification: {
        trustPolicy: {
          path: "qualification-resolution-trust.v1.json",
          sha256: qualificationTrustPolicyDigest,
        },
        buildAuthorityAttestation: {
          path: "qualification/build-authority-attestation.v1.json",
          sha256: buildAuthorityAttestationDigest,
          signaturePath: "qualification/build-authority-attestation.v1.sig.json",
          signatureSha256: hash(buildAuthorityAttestation.signature),
        },
        authorityIsolationAttestation: {
          path: "qualification/authority-isolation-attestation.v1.json",
          sha256: authorityIsolationAttestationDigest,
          signaturePath: "qualification/authority-isolation-attestation.v1.sig.json",
          signatureSha256: hash(authorityIsolationAttestation.signature),
        },
        resolution: {
          path: "qualification/qualification-resolution.v2.json",
          sha256: qualificationResolutionDigest,
          signaturePath: "qualification/qualification-resolution.v2.sig.json",
          signatureSha256: hash(qualificationResolution.signature),
        },
      },
      reports: reportReferences,
    },
    trustPolicy,
    preregistration: {
      document: preregistration,
      signature: evidenceSignature(preregistration),
    },
    rightsAttestation: { document: rights, signature: evidenceSignature(rights) },
    securityAudit: {
      document: securityAudit,
      signature: qualificationSignature(securityAudit),
      sha256: securityAuditDigest,
    },
    securityAuditBinding,
    securityAuditReadArtifact: (path: string) => {
      const bytes = securityArtifacts.get(path);
      if (!bytes) throw new Error(`missing security artifact: ${path}`);
      return bytes;
    },
    reports,
    trustPolicyDigest,
    qualificationTrustPolicy,
    qualificationTrustPolicyDigest,
    buildAuthorityAttestation,
    authorityIsolationAttestation,
    qualificationResolution,
    signDocument: signature,
    signEvidenceDocument: evidenceSignature,
    signSecurityDocument: qualificationSignature,
    signHoldoutDocument: holdoutSignature,
    signInfrastructureDocument,
    signQualificationDocument,
    writeSecurityArtifact,
    finalizerPrivateKeyPem: finalizer.privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  };
}

function report(input: ReleaseEvidenceInput, kind: QualificationKind) {
  const found = input.reports.find((item) => item.kind === kind);
  if (!found) throw new Error(`missing fixture report ${kind}`);
  return found;
}

function replaceSecurityAudit(
  input: Fixture,
  document: Record<string, unknown>,
): void {
  const digest = hash(document);
  input.securityAudit.document = document;
  input.securityAudit.signature = input.signSecurityDocument(document);
  input.securityAudit.sha256 = digest;
  (
    input.index as { securityAudit: { sha256: string } }
  ).securityAudit.sha256 = digest;
}

function replaceInfrastructureScanReport(
  input: Fixture,
  update: (report: {
    scanner: { rulesCutoffAt: string };
    completedAt: string;
    expiresAt: string;
  }) => void,
): string {
  const document = structuredClone(input.securityAudit.document) as {
    infrastructureScans: {
      build: {
        report: { path: string; sha256: string };
        signature: { path: string; sha256: string };
        payloadSha256: string;
      };
    };
  } & Record<string, unknown>;
  const scan = document.infrastructureScans.build;
  const report = JSON.parse(
    Buffer.from(input.securityAuditReadArtifact(scan.report.path)).toString("utf8"),
  ) as Record<string, unknown> & {
    scanner: { rulesCutoffAt: string };
    completedAt: string;
    expiresAt: string;
  };
  update(report);
  const signature = input.signInfrastructureDocument(report);
  scan.report.sha256 = input.writeSecurityArtifact(scan.report.path, report);
  scan.signature.sha256 = input.writeSecurityArtifact(scan.signature.path, signature);
  scan.payloadSha256 = hash(report);
  replaceSecurityAudit(input, document);
  return input.securityAudit.sha256;
}

function replaceQualificationArtifact(
  input: Fixture,
  field: "buildAuthorityAttestation" | "authorityIsolationAttestation" | "qualificationResolution",
  role: QualificationResolutionTrustRole,
  document: Record<string, unknown>,
): string {
  const signed = field === "qualificationResolution"
    ? input.qualificationResolution
    : input[field];
  signed.document = document;
  signed.signature = input.signQualificationDocument(role, document);
  const digest = hash(document);
  const referenceName = field === "qualificationResolution" ? "resolution" : field;
  const reference = (input.index as {
    qualification: Record<string, { sha256: string; signatureSha256: string }>;
  }).qualification[referenceName]!;
  reference.sha256 = digest;
  reference.signatureSha256 = hash(signed.signature);
  return digest;
}

function replaceResolutionEvidenceDigest(
  input: Fixture,
  kind: string,
  evidenceDigest: string,
): void {
  const document = input.qualificationResolution.document as {
    resolutions: Array<{ evidence: Array<{ kind: string; sha256: string }> }>;
  } & Record<string, unknown>;
  const reference = document.resolutions.flatMap(({ evidence }) => evidence)
    .find((entry) => entry.kind === kind);
  if (!reference) throw new Error(`missing qualification evidence reference: ${kind}`);
  reference.sha256 = evidenceDigest;
  replaceQualificationArtifact(
    input,
    "qualificationResolution",
    "qualification-resolver",
    document,
  );
}

describe("release evidence collector", () => {
  it("accepts a dedicated evaluation-authorizer but rejects role collapse", () => {
    const input = fixture();
    const policy = structuredClone(input.trustPolicy) as {
      keys: Array<{ roles: string[] }>;
    };
    policy.keys[0].roles = ["evaluation-authorizer"];
    expect(releaseTrustedKeyPolicySchema.safeParse(policy).success).toBe(true);
    policy.keys[0].roles = [
      "evaluation-authorizer",
      "release-authorizer",
    ];
    expect(releaseTrustedKeyPolicySchema.safeParse(policy).success).toBe(false);

    const collapsedQualification = structuredClone(input.trustPolicy) as {
      keys: Array<{ roles: string[] }>;
    };
    collapsedQualification.keys[1].roles.push("release-authorizer");
    expect(
      releaseTrustedKeyPolicySchema.safeParse(collapsedQualification).success,
    ).toBe(false);

    const collapsedHoldout = structuredClone(input.trustPolicy) as {
      keys: Array<{ roles: string[] }>;
    };
    collapsedHoldout.keys[2].roles.push("release-authorizer");
    expect(
      releaseTrustedKeyPolicySchema.safeParse(collapsedHoldout).success,
    ).toBe(false);

    const missingQualification = structuredClone(input.trustPolicy) as {
      keys: Array<{ roles: string[] }>;
    };
    missingQualification.keys = missingQualification.keys.filter(
      ({ roles }) => !roles.includes("qualification-attestor"),
    );
    expect(
      releaseTrustedKeyPolicySchema.safeParse(missingQualification).success,
    ).toBe(false);

    const aliasedQualificationKey = structuredClone(input.trustPolicy) as {
      keys: Array<{ publicKeyBase64: string }>;
    };
    aliasedQualificationKey.keys[1].publicKeyBase64 =
      aliasedQualificationKey.keys[0].publicKeyBase64;
    expect(
      releaseTrustedKeyPolicySchema.safeParse(aliasedQualificationKey).success,
    ).toBe(false);

    const producerControlCollapse = structuredClone(input.trustPolicy) as {
      keys: Array<{ roles: string[] }>;
    };
    producerControlCollapse.keys[0].roles.push("release-authorizer");
    expect(
      releaseTrustedKeyPolicySchema.safeParse(producerControlCollapse).success,
    ).toBe(false);
  });

  it("requires the main release trust policy to match the RuntimeTrust pin", () => {
    const input = fixture();
    const replacementPolicy = {
      ...(input.trustPolicy as Record<string, unknown>),
      policyId: "coordinated-unpinned-policy-02",
    };
    input.trustPolicy = replacementPolicy;
    input.trustPolicyDigest = hash(replacementPolicy);
    (input.index as { trustPolicy: { sha256: string } }).trustPolicy.sha256 =
      input.trustPolicyDigest;
    expect(() => collectReleaseEvidence(input)).toThrow(/RuntimeTrust release pin/i);
  });

  it("becomes ready only after every signed and bound gate passes", () => {
    const evidence = collectReleaseEvidence(fixture());
    expect(evidence.ready_for_release_authorization).toBe(true);
    expect(evidence.blockers).toEqual([]);
    expect(evidence.targetSotaClaimIds).toEqual([
      "reference-video-redubbing.native",
    ]);
    expect(evidence.claimResults[0]).toMatchObject({
      status: "sota-qualified",
    });
  });

  it("does not permit a legacy PASS or same-local-uid downgrade into Evidence v3", () => {
    const legacyPass = fixture();
    const legacySecurity = structuredClone(legacyPass.securityAudit.document) as {
      manifestQualification: { releaseDecision: "pass"; blockers: [] };
    } & Record<string, unknown>;
    legacyPass.securityAuditBinding.manifestQualification = {
      releaseDecision: "pass",
      blockers: [],
    };
    legacySecurity.manifestQualification = { releaseDecision: "pass", blockers: [] };
    replaceSecurityAudit(legacyPass, legacySecurity);
    expect(() => collectReleaseEvidence(legacyPass)).toThrow(/legacy PASS cannot authorize/i);

    const sameUid = fixture();
    sameUid.securityAuditBinding.runtimeTrust = {
      ...sameUid.securityAuditBinding.runtimeTrust,
      authorityIsolation: {
        schemaVersion: "ltx-studio-authority-isolation.v1",
        status: "hold",
        mechanism: "same-local-uid",
        attestationSha256: null,
        reasonCode: "same-uid-authority-not-authentic",
      },
    };
    expect(() => collectReleaseEvidence(sameUid)).toThrow(/same-local-UID/i);
  });

  it("rejects a coordinated foreign Build-TCB swap even after attestor and resolver re-sign it", () => {
    const input = fixture();
    const build = structuredClone(input.buildAuthorityAttestation.document) as {
      releaseDigest: string;
    } & Record<string, unknown>;
    build.releaseDigest = hash("foreign-release");
    const buildDigest = replaceQualificationArtifact(
      input,
      "buildAuthorityAttestation",
      "build-authority-attestor",
      build,
    );
    replaceResolutionEvidenceDigest(input, "build-authority-attestation", buildDigest);
    expect(() => collectReleaseEvidence(input)).toThrow(/another release.*Build-TCB/i);
  });

  it("rejects foreign host authority, a wrong resolver role, and exact expiry", () => {
    const foreignHost = fixture();
    const authority = structuredClone(foreignHost.authorityIsolationAttestation.document) as {
      hostTcbAttestationSha256: string;
    } & Record<string, unknown>;
    authority.hostTcbAttestationSha256 = hash("foreign-host");
    const authorityDigest = replaceQualificationArtifact(
      foreignHost,
      "authorityIsolationAttestation",
      "authority-isolation-attestor",
      authority,
    );
    replaceResolutionEvidenceDigest(
      foreignHost,
      "authority-isolation-attestation",
      authorityDigest,
    );
    expect(() => collectReleaseEvidence(foreignHost)).toThrow(/host and broker authority/i);

    const wrongRole = fixture();
    wrongRole.qualificationResolution.signature = wrongRole.signQualificationDocument(
      "build-authority-attestor",
      wrongRole.qualificationResolution.document,
    );
    (wrongRole.index as {
      qualification: { resolution: { signatureSha256: string } };
    }).qualification.resolution.signatureSha256 = hash(wrongRole.qualificationResolution.signature);
    expect(() => collectReleaseEvidence(wrongRole)).toThrow(/role binding/i);

    const exactExpiry = fixture();
    const resolution = structuredClone(exactExpiry.qualificationResolution.document) as {
      expiresAt: string;
    } & Record<string, unknown>;
    resolution.expiresAt = NOW.toISOString().replace(".000Z", "Z");
    replaceQualificationArtifact(
      exactExpiry,
      "qualificationResolution",
      "qualification-resolver",
      resolution,
    );
    expect(() => collectReleaseEvidence(exactExpiry)).toThrow(/exclusive validity window/i);
  });

  it("keeps unknown and dirty-worktree immutable blockers non-dischargeable", () => {
    for (const blocker of ["future-unrecognized-blocker", "longcat-runtime-worktree-dirty"]) {
      const input = fixture();
      input.securityAuditBinding.manifestQualification = {
        releaseDecision: "hold",
        blockers: [blocker],
      };
      const security = structuredClone(input.securityAudit.document) as {
        manifestQualification: { releaseDecision: "hold"; blockers: string[] };
      } & Record<string, unknown>;
      security.manifestQualification = { releaseDecision: "hold", blockers: [blocker] };
      replaceSecurityAudit(input, security);
      expect(() => collectReleaseEvidence(input)).toThrow(
        blocker === "longcat-runtime-worktree-dirty" ? /non-dischargeable/i : /unknown qualification/i,
      );
    }
  });

  it("fails closed when the signed security cutoff is stale", () => {
    const input = fixture();
    input.now = new Date(NOW.getTime() + 25 * 60 * 60 * 1000);
    expect(() => collectReleaseEvidence(input)).toThrow(/older than 24 hours/i);
  });

  it("rejects security evidence after a final lock digest changes", () => {
    const input = fixture();
    const document = structuredClone(input.securityAudit.document) as {
      boundInputs: { pythonLock: { sha256: string } };
    } & Record<string, unknown>;
    document.boundInputs.pythonLock.sha256 = "0".repeat(64);
    replaceSecurityAudit(input, document);
    expect(() => collectReleaseEvidence(input)).toThrow(/different release inputs/i);
  });

  it("rejects a re-signed security audit that overrides manifest qualification", () => {
    const input = fixture();
    const document = structuredClone(input.securityAudit.document) as {
      manifestQualification: {
        releaseDecision: "pass" | "hold";
        blockers: string[];
      };
    } & Record<string, unknown>;
    document.manifestQualification = {
      releaseDecision: "hold",
      blockers: ["quality-gates-hold"],
    };
    replaceSecurityAudit(input, document);

    expect(() => collectReleaseEvidence(input)).toThrow(/different release inputs/i);
  });

  it("rejects a missing raw scanner response and every reported finding", () => {
    const missingResponse = fixture();
    const originalReader = missingResponse.securityAuditReadArtifact;
    missingResponse.securityAuditReadArtifact = (path) => {
      if (path === "security/uv.response.json") throw new Error("missing raw response");
      return originalReader(path);
    };
    expect(() => collectReleaseEvidence(missingResponse)).toThrow(
      /scanner response is unavailable/i,
    );

    const adverse = fixture();
    const adverseDocument = structuredClone(adverse.securityAudit.document) as {
      unresolvedFindings: unknown[];
    } & Record<string, unknown>;
    adverseDocument.unresolvedFindings.push({ advisoryId: "CVE-test" });
    replaceSecurityAudit(adverse, adverseDocument);
    expect(() => collectReleaseEvidence(adverse)).toThrow(
      /too big|security audit schema rejected/i,
    );
  });

  it("rejects scanner-response tampering and an incomplete normalized result", () => {
    const tamperedResponse = fixture();
    tamperedResponse.writeSecurityArtifact(
      "security/npm.response.json",
      { metadata: { vulnerabilities: { total: 1 } } },
    );
    expect(() => collectReleaseEvidence(tamperedResponse)).toThrow(
      /does not match its signed SHA-256/i,
    );

    const adverseResponse = fixture();
    const adverseAudit = structuredClone(adverseResponse.securityAudit.document) as {
      audits: { npm: { response: { path: string; sha256: string } } };
    } & Record<string, unknown>;
    adverseAudit.audits.npm.response.sha256 = adverseResponse.writeSecurityArtifact(
      adverseAudit.audits.npm.response.path,
      {
        auditReportVersion: 2,
        metadata: { vulnerabilities: { total: 1 } },
        vulnerabilities: { express: { severity: "high" } },
      },
    );
    replaceSecurityAudit(adverseResponse, adverseAudit);
    expect(() => collectReleaseEvidence(adverseResponse)).toThrow(
      /contains vulnerabilities/i,
    );

    const incompleteResult = fixture();
    const document = structuredClone(incompleteResult.securityAudit.document) as {
      audits: {
        uv: {
          request: { sha256: string };
          response: { sha256: string };
          normalizedResult: { path: string; sha256: string };
        };
      };
    } & Record<string, unknown>;
    const result = {
      schemaVersion: "ltx-studio-security-scan-result.v1",
      ecosystem: "python",
      advisoryProvider: "osv.dev",
      advisoryCutoffAt: timestamp(-0.5),
      requestSha256: document.audits.uv.request.sha256,
      responseSha256: document.audits.uv.response.sha256,
      networkStatus: "complete",
      components: [],
      normalizedAdvisories: [],
      unresolvedFindings: [],
      adverseStatuses: [],
      verdict: "pass",
    };
    document.audits.uv.normalizedResult.sha256 =
      incompleteResult.writeSecurityArtifact(
        document.audits.uv.normalizedResult.path,
        result,
      );
    replaceSecurityAudit(incompleteResult, document);
    expect(() => collectReleaseEvidence(incompleteResult)).toThrow(
      /expected array to have >=1|normalized result rejected/i,
    );
  });

  it("rejects a signed infrastructure scan with a future rules cutoff", () => {
    const input = fixture();
    replaceInfrastructureScanReport(input, (report) => {
      report.scanner.rulesCutoffAt = timestamp(1);
      report.completedAt = timestamp(2);
    });
    expect(() => collectReleaseEvidence(input)).toThrow(/infrastructure scan/i);
  });

  it("rejects a signed infrastructure scan completed in the future", () => {
    const input = fixture();
    replaceInfrastructureScanReport(input, (report) => {
      report.completedAt = timestamp(1);
    });
    expect(() => collectReleaseEvidence(input)).toThrow(/infrastructure scan/i);
  });

  it("rejects scan completion after its containing audit was generated", () => {
    const input = fixture();
    replaceInfrastructureScanReport(input, (report) => {
      report.completedAt = timestamp(-0.125);
    });
    expect(() => collectReleaseEvidence(input)).toThrow(/infrastructure scan/i);
  });

  it("accepts exact scan cutoff/completion/audit-generation boundaries", () => {
    const input = fixture();
    const generatedAt = (input.securityAudit.document as { generatedAt: string }).generatedAt;
    const securityDigest = replaceInfrastructureScanReport(input, (report) => {
      report.scanner.rulesCutoffAt = generatedAt;
      report.completedAt = generatedAt;
    });
    replaceResolutionEvidenceDigest(input, "security-audit", securityDigest);
    expect(collectReleaseEvidence(input).securityAudit.sha256).toBe(securityDigest);
  });

  it("rejects additive scan windows with a rules cutoff older than 24 hours", () => {
    const input = fixture();
    replaceInfrastructureScanReport(input, (report) => {
      report.scanner.rulesCutoffAt = timestamp(-47);
      report.completedAt = timestamp(-23.5);
      report.expiresAt = timestamp(0.25);
    });
    expect(() => collectReleaseEvidence(input)).toThrow(/infrastructure scan/i);
  });

  it("accepts a rules cutoff exactly 24 hours old", () => {
    const input = fixture();
    const securityDigest = replaceInfrastructureScanReport(input, (report) => {
      report.scanner.rulesCutoffAt = timestamp(-24);
    });
    replaceResolutionEvidenceDigest(input, "security-audit", securityDigest);
    expect(collectReleaseEvidence(input).securityAudit.sha256).toBe(securityDigest);
  });

  it("rejects a consistently re-signed infrastructure report for a substituted SBOM", () => {
    const input = fixture();
    const document = structuredClone(input.securityAudit.document) as {
      infrastructureScans: {
        build: {
          report: { path: string; sha256: string };
          signature: { path: string; sha256: string };
          payloadSha256: string;
        };
      };
    } & Record<string, unknown>;
    const scan = document.infrastructureScans.build;
    const report = JSON.parse(
      Buffer.from(input.securityAuditReadArtifact(scan.report.path)).toString("utf8"),
    ) as Record<string, unknown>;
    report.sbomSha256 = "f".repeat(64);
    const signature = input.signInfrastructureDocument(report);
    scan.report.sha256 = input.writeSecurityArtifact(scan.report.path, report);
    scan.signature.sha256 = input.writeSecurityArtifact(scan.signature.path, signature);
    scan.payloadSha256 = hash(report);
    replaceSecurityAudit(input, document);

    expect(() => collectReleaseEvidence(input)).toThrow(/infrastructure scan/i);
  });

  it("rejects omission or source drift in the release-bound local inventory", () => {
    const input = fixture();
    const document = structuredClone(input.securityAudit.document) as {
      coverage: {
        localComponents: {
          discoveredComponents: number;
          sbomComponents: number;
          auditedComponents: number;
        };
      };
      sbom: { localComponents: unknown[] };
    } & Record<string, unknown>;
    document.sbom.localComponents = [];
    document.coverage.localComponents.discoveredComponents = 0;
    document.coverage.localComponents.sbomComponents = 0;
    document.coverage.localComponents.auditedComponents = 0;
    replaceSecurityAudit(input, document);
    expect(() => collectReleaseEvidence(input)).toThrow(
      /does not exactly match the final release inventory/i,
    );
  });

  it("rejects a missing applicable gate", () => {
    const input = fixture();
    const canary = report(input, "r3-canaries");
    const document = canary.document as {
      coverage: Array<{ gates: string[] }>;
    };
    document.coverage[0].gates = document.coverage[0].gates.filter(
      (gate) => gate !== "provenance",
    );
    canary.sha256 = hash(document);
    const reference = (
      input.index as { reports: Array<{ kind: string; sha256: string }> }
    ).reports.find(({ kind }) => kind === "r3-canaries");
    if (reference) reference.sha256 = canary.sha256;
    expect(() => collectReleaseEvidence(input)).toThrow(
      /signature payload digest mismatch/i,
    );
  });

  it("does not let calibration coverage replace a missing Q2 holdout gate", () => {
    const input = fixture();
    const q2 = report(input, "q2-holdout");
    const document = q2.document as {
      coverage: Array<{ gates: string[] }>;
    };
    document.coverage[0].gates = document.coverage[0].gates.filter(
      (gate) => gate !== "identity",
    );
    q2.sha256 = hash(document);
    q2.signature = input.signHoldoutDocument(document);
    const reference = (
      input.index as { reports: Array<{ kind: string; sha256: string }> }
    ).reports.find(({ kind }) => kind === "q2-holdout");
    if (!reference) throw new Error("missing Q2 report reference");
    reference.sha256 = q2.sha256;

    expect(() => collectReleaseEvidence(input)).toThrow(
      /lacks final-owner passing gates: identity/i,
    );
  });

  it("rejects expired rights even when their original signature is valid", () => {
    const input = fixture();
    const securityDocument = structuredClone(input.securityAudit.document) as {
      expiresAt: string;
    } & Record<string, unknown>;
    securityDocument.expiresAt = timestamp(23);
    replaceSecurityAudit(input, securityDocument);
    input.now = new Date("2026-08-12T01:00:00Z");
    expect(() => collectReleaseEvidence(input)).toThrow(
      /rights attestation is stale/i,
    );
  });

  it("rejects local-only results for a frozen target SOTA claim", () => {
    const input = fixture();
    const q2 = report(input, "q2-holdout");
    const document = q2.document as {
      claimResults: Array<{ status: string; sotaAnchorDigest: string | null }>;
    };
    document.claimResults[0] = { status: "local-only", sotaAnchorDigest: null };
    q2.sha256 = hash(document);
    expect(() => collectReleaseEvidence(input)).toThrow(
      /report index mismatch|signature payload digest mismatch/i,
    );
  });

  it("rejects signed Q2 results for claims outside the candidate surface", () => {
    const input = fixture();
    const q2 = report(input, "q2-holdout");
    const document = q2.document as {
      claimResults: Array<{
        claimId: string;
        status: string;
        sotaAnchorDigest: string | null;
      }>;
    };
    document.claimResults.push({
      claimId: "invented.claim",
      status: "sota-qualified",
      sotaAnchorDigest: "9".repeat(64),
    });
    q2.sha256 = hash(document);
    q2.signature = input.signHoldoutDocument(document);
    const reference = (
      input.index as { reports: Array<{ kind: string; sha256: string }> }
    ).reports.find(({ kind }) => kind === "q2-holdout");
    if (!reference) throw new Error("missing Q2 report reference");
    reference.sha256 = q2.sha256;

    expect(() => collectReleaseEvidence(input)).toThrow(
      /result for a non-candidate claim/i,
    );
  });

  it("rejects an incomplete report set and a vacuous target set", () => {
    const incomplete = fixture();
    incomplete.reports.pop();
    expect(() => collectReleaseEvidence(incomplete)).toThrow(/incomplete/i);

    const emptyTargets = fixture();
    (
      emptyTargets.index as { targetSotaClaimIds: string[] }
    ).targetSotaClaimIds = [];
    expect(() => collectReleaseEvidence(emptyTargets)).toThrow();
  });

  it("rejects internally inconsistent release evidence before finalization", () => {
    const evidence = collectReleaseEvidence(fixture());
    const unqualifiedTarget = structuredClone(evidence);
    unqualifiedTarget.claimResults[0] = {
      claimId: unqualifiedTarget.targetSotaClaimIds[0],
      status: "local-only",
      sotaAnchorDigest: null,
    };
    expect(releaseEvidenceSchema.safeParse(unqualifiedTarget).success).toBe(
      false,
    );

    const duplicateReport = structuredClone(evidence);
    duplicateReport.reports[0] = structuredClone(duplicateReport.reports[1]);
    expect(releaseEvidenceSchema.safeParse(duplicateReport).success).toBe(
      false,
    );
  });
});

describe("release audit finalizer", () => {
  it("is the first stage allowed to emit production and SOTA go", () => {
    const input = fixture();
    const evidence = collectReleaseEvidence(input);
    const evidenceDigest = hash(evidence);
    const q2ReportDigest = evidence.reports.find(
      ({ kind }) => kind === "q2-holdout",
    )?.sha256;
    if (!q2ReportDigest) throw new Error("missing Q2 fixture digest");
    const authorization = {
      schemaVersion: "ltx-studio-release-authorization.v4",
      activationGeneration: 1,
      releaseDigest: evidence.releaseDigest,
      surfaceDigest: evidence.surfaceDigest,
      runtimeInstallSealSha256: input.securityAuditBinding.runtimeInstallSealSha256,
      runtimeTreeSha256: input.securityAuditBinding.runtimeTreeSha256,
      runtimePolicySha256: input.securityAuditBinding.runtimePolicySha256,
      nodeExecutableSha256: input.securityAuditBinding.nodeExecutableSha256,
      runtimeTrust: input.securityAuditBinding.runtimeTrust,
      manifestQualificationSha256: evidence.manifestQualificationSha256,
      qualificationTrustPolicyDigest: evidence.qualificationTrustPolicyDigest,
      buildAuthorityAttestationDigest: evidence.buildAuthorityAttestationDigest,
      authorityIsolationAttestationDigest: evidence.authorityIsolationAttestationDigest,
      qualificationResolutionDigest: evidence.qualificationResolutionDigest,
      preregistrationDigest: evidence.preregistrationDigest,
      q2ReportDigest,
      releaseEvidenceDigest: evidenceDigest,
      rightsAttestationDigest: evidence.rightsAttestationDigest,
      securityAuditDigest: evidence.securityAudit.sha256,
      releasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      notBefore: timestamp(-1),
      expiresAt: timestamp(1),
    };

    const envelope = finalizeReleaseAudit({
      now: NOW,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
      finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
    });

    const wrongRoleSecurityAudit = {
      ...input.securityAudit,
      signature: input.signDocument(input.securityAudit.document),
    };
    expect(() => finalizeReleaseAudit({
      now: NOW,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      rightsAttestation: input.rightsAttestation,
      securityAudit: wrongRoleSecurityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
      finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
    })).toThrow(/qualification-attestor/i);

    const tamperedSecurityArtifactReader = (path: string) =>
      path === "security/npm.response.json"
        ? Buffer.from("{}")
        : input.securityAuditReadArtifact(path);
    expect(() => finalizeReleaseAudit({
      now: NOW,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: tamperedSecurityArtifactReader,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
      finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
    })).toThrow(/does not match its signed SHA-256/i);

    const driftedSecurityBinding = structuredClone(input.securityAuditBinding);
    driftedSecurityBinding.runtimeInstallSealSha256 = "0".repeat(64);
    expect(() => finalizeReleaseAudit({
      now: NOW,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: driftedSecurityBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
      finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
    })).toThrow(/different release inputs/i);

    const tamperedQualificationEvidence = structuredClone(evidence);
    tamperedQualificationEvidence.qualificationArtifacts.resolution.signature.signatureBase64 =
      Buffer.alloc(64, 0x5a).toString("base64");
    const tamperedQualificationEvidenceDigest = hash(tamperedQualificationEvidence);
    const tamperedQualificationAuthorization = {
      ...authorization,
      releaseEvidenceDigest: tamperedQualificationEvidenceDigest,
    };
    expect(() => finalizeReleaseAudit({
      now: NOW,
      evidence: tamperedQualificationEvidence,
      evidenceDigest: tamperedQualificationEvidenceDigest,
      authorization: {
        document: tamperedQualificationAuthorization,
        signature: input.signDocument(tamperedQualificationAuthorization),
      },
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
      finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
    })).toThrow(/Qualification detached Ed25519 signature is invalid/i);

    expect(envelope.audit).toMatchObject({
      activationGeneration: 1,
      production_overall: "go",
      sota_overall: "go",
      releaseEvidenceDigest: evidenceDigest,
      releaseAuthorizationDigest: hash(authorization),
    });
    expect(envelope.signature.payloadSha256).toBe(hash(envelope.audit));
    const expectedRuntimeIdentity = {
      expectedRuntimeInstallSealSha256: input.securityAuditBinding.runtimeInstallSealSha256,
      expectedRuntimeTreeSha256: input.securityAuditBinding.runtimeTreeSha256,
      expectedRuntimePolicySha256: input.securityAuditBinding.runtimePolicySha256,
      expectedNodeExecutableSha256: input.securityAuditBinding.nodeExecutableSha256,
      expectedRuntimeTrust: input.securityAuditBinding.runtimeTrust,
    };
    const tamperedAuditPayload = {
      ...envelope.audit,
      releaseEvidenceDigest: tamperedQualificationEvidenceDigest,
      releaseAuthorizationDigest: hash(tamperedQualificationAuthorization),
    };
    const tamperedAuditEnvelope = {
      schemaVersion: "ltx-studio-release-audit.v4",
      audit: tamperedAuditPayload,
      signature: {
        schemaVersion: "ltx-studio-detached-signature.v1",
        algorithm: "ed25519",
        keyId: "audit-finalizer-key-01",
        payloadSha256: hash(tamperedAuditPayload),
        signatureBase64: sign(
          null,
          Buffer.from(canonicalJson(tamperedAuditPayload)),
          input.finalizerPrivateKeyPem,
        ).toString("base64"),
      },
    };
    expect(() => verifyReleasePromotionBundle({
      now: NOW,
      expectedGeneration: 1,
      expectedReleaseDigest: evidence.releaseDigest,
      expectedSurfaceDigest: evidence.surfaceDigest,
      ...expectedRuntimeIdentity,
      expectedRightsPolicyEvidenceDigest: DIGEST.catalog,
      expectedReleasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      evidence: tamperedQualificationEvidence,
      evidenceDigest: tamperedQualificationEvidenceDigest,
      authorization: {
        document: tamperedQualificationAuthorization,
        signature: input.signDocument(tamperedQualificationAuthorization),
      },
      auditEnvelope: tamperedAuditEnvelope,
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
    })).toThrow(/Qualification detached Ed25519 signature is invalid/i);
    expect(verifyReleasePromotionBundle({
      now: NOW,
      expectedGeneration: 1,
      expectedReleaseDigest: evidence.releaseDigest,
      expectedSurfaceDigest: evidence.surfaceDigest,
      ...expectedRuntimeIdentity,
      expectedRightsPolicyEvidenceDigest: DIGEST.catalog,
      expectedReleasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      auditEnvelope: envelope,
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
    })).toEqual({
      authorizationDigest: hash(authorization),
      auditEnvelopeDigest: hash(envelope),
      rightsAttestationDigest: evidence.rightsAttestationDigest,
      releasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
    });
    expect(() => verifyReleasePromotionBundle({
      now: NOW,
      expectedGeneration: 1,
      expectedReleaseDigest: evidence.releaseDigest,
      expectedSurfaceDigest: evidence.surfaceDigest,
      ...expectedRuntimeIdentity,
      expectedRightsPolicyEvidenceDigest: DIGEST.catalog,
      expectedReleasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      auditEnvelope: envelope,
      rightsAttestation: input.rightsAttestation,
      securityAudit: wrongRoleSecurityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
    })).toThrow(/qualification-attestor/i);
    expect(() => verifyReleasePromotionBundle({
      now: NOW,
      expectedGeneration: 1,
      expectedReleaseDigest: evidence.releaseDigest,
      expectedSurfaceDigest: evidence.surfaceDigest,
      ...expectedRuntimeIdentity,
      expectedRightsPolicyEvidenceDigest: DIGEST.catalog,
      expectedReleasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      auditEnvelope: envelope,
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: tamperedSecurityArtifactReader,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
    })).toThrow(/does not match its signed SHA-256/i);
    expect(() => verifyReleasePromotionBundle({
      now: NOW,
      expectedGeneration: 1,
      expectedReleaseDigest: evidence.releaseDigest,
      expectedSurfaceDigest: evidence.surfaceDigest,
      ...expectedRuntimeIdentity,
      expectedRightsPolicyEvidenceDigest: DIGEST.catalog,
      expectedReleasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      auditEnvelope: envelope,
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: driftedSecurityBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
    })).toThrow(/different release inputs/i);
    expect(() => verifyReleasePromotionBundle({
      now: NOW,
      expectedGeneration: 2,
      expectedReleaseDigest: evidence.releaseDigest,
      expectedSurfaceDigest: evidence.surfaceDigest,
      ...expectedRuntimeIdentity,
      expectedRightsPolicyEvidenceDigest: DIGEST.catalog,
      expectedReleasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      auditEnvelope: envelope,
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
    })).toThrow(/binding mismatch/);

    const activationRelease = {
      releaseDigest: evidence.releaseDigest,
      surfaceDigest: evidence.surfaceDigest,
      runtimeInstallSealSha256: input.securityAuditBinding.runtimeInstallSealSha256,
      runtimeTreeSha256: input.securityAuditBinding.runtimeTreeSha256,
      runtimePolicySha256: input.securityAuditBinding.runtimePolicySha256,
      nodeExecutableSha256: input.securityAuditBinding.nodeExecutableSha256,
      runtimeTrust: input.securityAuditBinding.runtimeTrust,
      rights: {
        policyEvidenceDigest: DIGEST.catalog,
        attestationSeriesId: "rights-series-001",
        minimumSnapshotVersion: 1,
      },
    };
    const activationEnvelope = (record: ActivationJournalRecord): ActivationJournalEnvelope => ({
      record,
      signature: {
        schemaVersion: "ltx-studio-detached-signature.v1",
        algorithm: "ed25519",
        role: "activation-journal-writer",
        keyId: record.writerKeyId,
        payloadSha256: activationRecordDigest(record),
        signatureBase64: "promotion-structural-signature",
      },
    });
    const blocked = activationEnvelope({
      schemaVersion: "ltx-studio-activation-journal-record.v3",
      recordId: "00000000-0000-4000-8000-000000000401",
      sequence: 0,
      generation: 1,
      previousRecordSha256: null,
      previousState: null,
      state: "blocked",
      operation: "bootstrap_generation",
      release: activationRelease,
      releasedSurfaceEntryIds: [],
      authorizationDigest: null,
      auditEnvelopeDigest: null,
      evidenceDigest: null,
      ticketId: null,
      ticketState: null,
      ticketTerminal: null,
      supersedePreflight: null,
      recordedAt: timestamp(-0.5),
      writerKeyId: "activation-writer-001",
    });
    const qualification = activationEnvelope({
      ...blocked.record,
      recordId: "00000000-0000-4000-8000-000000000402",
      sequence: 1,
      previousRecordSha256: activationEnvelopeDigest(blocked),
      previousState: "blocked",
      state: "qualification_only",
      operation: "activate_qualification_mode",
      authorizationDigest: hash("qualification-mode"),
      recordedAt: timestamp(-0.4),
    });
    const promotion = activationEnvelope({
      ...qualification.record,
      recordId: "00000000-0000-4000-8000-000000000403",
      sequence: 2,
      previousRecordSha256: activationEnvelopeDigest(qualification),
      previousState: "qualification_only",
      state: "production_provisional",
      operation: "promote_production",
      releasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      authorizationDigest: hash(authorization),
      auditEnvelopeDigest: hash(envelope),
      recordedAt: timestamp(-0.3),
    });
    const promotionInput = {
      now: NOW,
      expectedGeneration: 1,
      expectedRelease: activationRelease,
      expectedReleasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      evidence,
      evidenceDigest,
      authorization: { document: authorization, signature: input.signDocument(authorization) },
      auditEnvelope: envelope,
      rightsAttestation: input.rightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
    };
    expect(validateReleasePromotion({ ...promotionInput, journal: [blocked, qualification, promotion] }))
      .toMatchObject({ authorizationDigest: hash(authorization), auditEnvelopeDigest: hash(envelope) });
    expect(() => validateReleasePromotion({ ...promotionInput, journal: [blocked, qualification] }))
      .toThrow(/not consumed exactly once/);
  });

  it("rechecks authorization bindings and rights freshness at finalization", () => {
    const input = fixture();
    const evidence = collectReleaseEvidence(input);
    const evidenceDigest = hash(evidence);
    const q2ReportDigest = evidence.reports.find(
      ({ kind }) => kind === "q2-holdout",
    )?.sha256;
    if (!q2ReportDigest) throw new Error("missing Q2 fixture digest");
    const authorization = {
      schemaVersion: "ltx-studio-release-authorization.v4",
      activationGeneration: 1,
      releaseDigest: evidence.releaseDigest,
      surfaceDigest: evidence.surfaceDigest,
      runtimeInstallSealSha256: input.securityAuditBinding.runtimeInstallSealSha256,
      runtimeTreeSha256: input.securityAuditBinding.runtimeTreeSha256,
      runtimePolicySha256: input.securityAuditBinding.runtimePolicySha256,
      nodeExecutableSha256: input.securityAuditBinding.nodeExecutableSha256,
      runtimeTrust: input.securityAuditBinding.runtimeTrust,
      manifestQualificationSha256: evidence.manifestQualificationSha256,
      qualificationTrustPolicyDigest: evidence.qualificationTrustPolicyDigest,
      buildAuthorityAttestationDigest: evidence.buildAuthorityAttestationDigest,
      authorityIsolationAttestationDigest: evidence.authorityIsolationAttestationDigest,
      qualificationResolutionDigest: evidence.qualificationResolutionDigest,
      preregistrationDigest: evidence.preregistrationDigest,
      q2ReportDigest,
      releaseEvidenceDigest: "f".repeat(64),
      rightsAttestationDigest: evidence.rightsAttestationDigest,
      securityAuditDigest: evidence.securityAudit.sha256,
      releasedSurfaceEntryIds: evidence.candidateSurfaceEntryIds,
      notBefore: timestamp(-1),
      expiresAt: timestamp(1),
    };
    expect(() =>
      finalizeReleaseAudit({
        now: NOW,
        evidence,
        evidenceDigest,
        authorization: {
          document: authorization,
          signature: input.signDocument(authorization),
        },
        rightsAttestation: input.rightsAttestation,
        securityAudit: input.securityAudit,
        securityAuditBinding: input.securityAuditBinding,
        securityAuditReadArtifact: input.securityAuditReadArtifact,
        trustPolicy: input.trustPolicy,
        trustPolicyDigest: input.trustPolicyDigest,
        finalizerKeyId: "audit-finalizer-key-01",
        finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
      }),
    ).toThrow(/authorization binding mismatch/i);
  });

  it("rejects direct and coordinated foreign-surface rights at FinalAudit", () => {
    const input = fixture();
    const evidence = collectReleaseEvidence(input);
    const authorizationFor = (
      boundEvidence: typeof evidence,
      evidenceDigest: string,
    ) => {
      const q2ReportDigest = boundEvidence.reports.find(
        ({ kind }) => kind === "q2-holdout",
      )?.sha256;
      if (!q2ReportDigest) throw new Error("missing Q2 fixture digest");
      return {
        schemaVersion: "ltx-studio-release-authorization.v4",
        activationGeneration: 1,
        releaseDigest: boundEvidence.releaseDigest,
        surfaceDigest: boundEvidence.surfaceDigest,
        runtimeInstallSealSha256: input.securityAuditBinding.runtimeInstallSealSha256,
        runtimeTreeSha256: input.securityAuditBinding.runtimeTreeSha256,
        runtimePolicySha256: input.securityAuditBinding.runtimePolicySha256,
        nodeExecutableSha256: input.securityAuditBinding.nodeExecutableSha256,
        runtimeTrust: input.securityAuditBinding.runtimeTrust,
        manifestQualificationSha256: boundEvidence.manifestQualificationSha256,
        qualificationTrustPolicyDigest: boundEvidence.qualificationTrustPolicyDigest,
        buildAuthorityAttestationDigest: boundEvidence.buildAuthorityAttestationDigest,
        authorityIsolationAttestationDigest: boundEvidence.authorityIsolationAttestationDigest,
        qualificationResolutionDigest: boundEvidence.qualificationResolutionDigest,
        preregistrationDigest: boundEvidence.preregistrationDigest,
        q2ReportDigest,
        releaseEvidenceDigest: evidenceDigest,
        rightsAttestationDigest: boundEvidence.rightsAttestationDigest,
        securityAuditDigest: boundEvidence.securityAudit.sha256,
        releasedSurfaceEntryIds: boundEvidence.candidateSurfaceEntryIds,
        notBefore: timestamp(-1),
        expiresAt: timestamp(1),
      };
    };
    const foreignRightsDocument = {
      ...(input.rightsAttestation.document as Record<string, unknown>),
      surfaceDigest: hash("foreign-surface"),
    };
    const foreignRightsAttestation = {
      document: foreignRightsDocument,
      signature: input.signEvidenceDocument(foreignRightsDocument),
    };
    const evidenceDigest = hash(evidence);
    const authorization = authorizationFor(evidence, evidenceDigest);
    expect(() => finalizeReleaseAudit({
      now: NOW,
      evidence,
      evidenceDigest,
      authorization: {
        document: authorization,
        signature: input.signDocument(authorization),
      },
      rightsAttestation: foreignRightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
      finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
    })).toThrow(/rights attestation binding mismatch/i);

    const coordinatedEvidence = structuredClone(evidence);
    const foreignRightsDigest = hash(foreignRightsDocument);
    coordinatedEvidence.rightsAttestationDigest = foreignRightsDigest;
    const resolutionDocument = coordinatedEvidence.qualificationArtifacts.resolution.document;
    const rightsReference = resolutionDocument.resolutions
      .flatMap(({ evidence: references }) => references)
      .find(({ kind }) => kind === "rights-attestation");
    if (!rightsReference) throw new Error("missing rights resolution reference");
    rightsReference.sha256 = foreignRightsDigest;
    coordinatedEvidence.qualificationArtifacts.resolution.signature =
      input.signQualificationDocument("qualification-resolver", resolutionDocument) as
        typeof coordinatedEvidence.qualificationArtifacts.resolution.signature;
    coordinatedEvidence.qualificationResolutionDigest = hash(resolutionDocument);
    const coordinatedEvidenceDigest = hash(coordinatedEvidence);
    const coordinatedAuthorization = authorizationFor(
      coordinatedEvidence,
      coordinatedEvidenceDigest,
    );
    expect(() => finalizeReleaseAudit({
      now: NOW,
      evidence: coordinatedEvidence,
      evidenceDigest: coordinatedEvidenceDigest,
      authorization: {
        document: coordinatedAuthorization,
        signature: input.signDocument(coordinatedAuthorization),
      },
      rightsAttestation: foreignRightsAttestation,
      securityAudit: input.securityAudit,
      securityAuditBinding: input.securityAuditBinding,
      securityAuditReadArtifact: input.securityAuditReadArtifact,
      trustPolicy: input.trustPolicy,
      trustPolicyDigest: input.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
      finalizerPrivateKeyPem: input.finalizerPrivateKeyPem,
    })).toThrow(/rights attestation binding mismatch/i);
  });
});
