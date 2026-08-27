import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error The immutable operator CLI helper is plain ESM JavaScript.
// prettier-ignore
import { parsePreflightArguments, runReleaseAuditPreflight } from "../scripts/release-audit-preflight-lib.mjs";
// @ts-expect-error The final audit CLI helper is plain ESM JavaScript.
import { runReleaseAuditFinalization } from "../scripts/finalize-release-audit-lib.mjs";
// @ts-expect-error The production CLI dispatcher is plain ESM JavaScript.
// prettier-ignore
import { executeReleaseAuditCommand, parseReleaseAuditCommandArguments } from "../scripts/release-audit-command-lib.mjs";
import { canonicalJson } from "../shared/canonicalJson.js";
import * as activationModule from "../shared/activation.js";
import * as auditModule from "../shared/releaseAudit.js";
import {
  qualificationGateOwnership,
  qualificationKinds,
} from "../shared/releaseAudit.js";
import {
  buildAuthorityResolvedBlockers,
  expectedQualificationResolutions,
  type QualificationEvidenceDigests,
  type QualificationResolutionTrustRole,
} from "../shared/qualificationResolution.js";
import * as surfaceModule from "../shared/releaseSurface.js";
import { releaseGateIds } from "../shared/releaseSurface.js";
import { runtimeInstallIntegrityPolicy } from "../scripts/runtime-install-seal-lib.mjs";
import {
  runtimeTrustFixture,
  sameUidRuntimeTrustFixture,
} from "./runtime-trust-fixture.js";

const NOW = new Date("2026-08-25T12:00:00Z");
const RELEASE_DIGEST = "a".repeat(64);
const temporaryRoots: string[] = [];
const DISCHARGEABLE_MANIFEST_BLOCKERS = [
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
] as const;
const RUNTIME_AUTHORIZATION_FIELDS = [
  "runtimeInstallSealSha256",
  "runtimeTreeSha256",
  "runtimePolicySha256",
  "nodeExecutableSha256",
] as const;
type RuntimeAuthorizationField = (typeof RUNTIME_AUTHORIZATION_FIELDS)[number];

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function documentDigest(document: unknown): string {
  return hash(canonicalJson(document));
}

function rawPublicKey(key: KeyObject): string {
  return Buffer.from(key.export({ format: "der", type: "spki" })).subarray(-32).toString("base64");
}

function detachedSignature(document: unknown, keyId: string, privateKey: KeyObject) {
  return {
    schemaVersion: "ltx-studio-detached-signature.v1",
    algorithm: "ed25519",
    keyId,
    payloadSha256: documentDigest(document),
    signatureBase64: sign(
      null,
      Buffer.from(canonicalJson(document)),
      privateKey,
    ).toString("base64"),
  };
}

function writeCanonical(root: string, relativePath: string, document: unknown): string {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  const bytes = canonicalJson(document);
  writeFileSync(path, bytes, { mode: 0o600 });
  return hash(bytes);
}

function releaseFixture() {
  const releaseRoot = mkdtempSync(join(tmpdir(), "ltx-preflight-release-"));
  temporaryRoots.push(releaseRoot);
  const surface = {
    schemaVersion: "candidate-release-surface.v1",
    policyVersion: "ltx-studio-release-rights.v1",
    inputs: {
      requestSchema: { path: "shared/pipelines.ts", sha256: "4".repeat(64) },
      capabilityMatrix: { path: "shared/releaseSurface.ts", sha256: "5".repeat(64) },
    },
    activationContract: {
      candidate: "requires-current-signed-rights-attest-and-all-applicable-gates",
      blocked: "must-not-run-in-production-or-support-release-claims",
    },
    entries: [{
      id: "ltx25.image-audio.release",
      claimId: "audio-driven-video.ltx25.release",
      request: {
        mode: "image-audio-to-video",
        sourceMode: "not-applicable",
        icLoraProfile: null,
        lipDubPipelineProfile: null,
        retakeCheckpoint: null,
        modelProfile: "ltx25-split-bf16-two-stage",
        unionControlType: null,
        promptEncoderProfile: "not-applicable",
        dialogueIntent: "required",
        postprocessor: "none",
        dfrTemporalUpscalings: null,
        dfrSpatialUpscalings: null,
      },
      inputContract: ["prompt", "reference-image", "driving-audio"],
      outputMedia: "video/mp4",
      cooperativeCheckpoint: true,
      applicableGates: [...releaseGateIds],
      notApplicable: [],
      rights: {
        status: "conditional",
        evidenceIds: ["rights.ltx25"],
        reason: "current signed attestation required",
      },
      targetStatus: "candidate",
      targetReason: null,
    }],
  };
  const surfacePath = "apps/ltx-studio/release/candidate-release-surface.v1.json";
  const rightsPath = "apps/ltx-studio/release/rights-evidence.v1.json";
  const surfaceDigest = writeCanonical(releaseRoot, surfacePath, surface);
  const rightsCatalogDigest = writeCanonical(releaseRoot, rightsPath, {
    schemaVersion: "test-rights-catalog.v1",
  });
  const qualificationKeys = {
    "build-authority-attestor": {
      keyId: "build-authority-attestor-key-01",
      keyPair: generateKeyPairSync("ed25519"),
    },
    "authority-isolation-attestor": {
      keyId: "authority-isolation-attestor-key-01",
      keyPair: generateKeyPairSync("ed25519"),
    },
    "qualification-resolver": {
      keyId: "qualification-resolver-key-01",
      keyPair: generateKeyPairSync("ed25519"),
    },
  } as const;
  const qualificationTrustPolicy = {
    schemaVersion: "ltx-studio-qualification-resolution-trust.v1" as const,
    policyId: "preflight-qualification-policy-01",
    keys: Object.entries(qualificationKeys).map(([role, { keyId, keyPair }]) => ({
      keyId,
      algorithm: "ed25519" as const,
      role: role as QualificationResolutionTrustRole,
      publicKeyBase64: rawPublicKey(keyPair.publicKey),
      notBefore: "2026-08-24T00:00:00Z",
      notAfter: "2026-08-26T00:00:00Z",
      revokedAt: null,
    })),
  };
  const qualificationTrustPolicyDigest = documentDigest(qualificationTrustPolicy);
  const activationWriter = generateKeyPairSync("ed25519");
  const activationTrustPolicy = {
    schemaVersion: "ltx-studio-activation-writer-trust.v1" as const,
    policyId: "preflight-activation-policy-01",
    keys: [{
      keyId: "activation-writer-key-01",
      algorithm: "ed25519" as const,
      role: "activation-journal-writer" as const,
      publicKeyBase64: rawPublicKey(activationWriter.publicKey),
      notBefore: "2026-08-24T00:00:00Z",
      notAfter: "2026-08-26T00:00:00Z",
      revokedAt: null,
    }],
  };
  const activationTrustPolicyDigest = documentDigest(activationTrustPolicy);
  const manifest = {
    schemaVersion: "ltx-studio-release-manifest.v4",
    artifacts: [
      { path: "apps/ltx-studio/package-lock.json", type: "file", sha256: "a".repeat(64) },
      { path: "apps/ltx-studio/runtime/uv.lock", type: "file", sha256: "b".repeat(64) },
      { path: "apps/ltx-studio/runtime/pyproject.toml", type: "file", sha256: "c".repeat(64) },
      { path: "apps/ltx-studio/runtime/verify_runtime.py", type: "file", sha256: "d".repeat(64) },
    ],
    locks: {
      node: "a".repeat(64),
      python: "b".repeat(64),
    },
    tools: {
      node: { sha256: "5".repeat(64) },
    },
    hostTcb: {
      schemaVersion: "ltx-studio-host-tcb.v2",
      tools: [{ name: "ffmpeg" }],
      runtimeComponents: [{ name: "node" }, { name: "uv" }],
      dockerImages: [{ name: "latentsync" }, { name: "lipforcing" }, { name: "musetalk" }],
      controlPlane: { fixture: true },
    },
    runtimeInstallIntegrity: runtimeInstallIntegrityPolicy(),
    sbom: {
      schemaVersion: "ltx-studio-static-sbom.v3",
      nodeComponents: [{ name: "express", version: "5.1.0" }],
      pythonComponents: [{ name: "requests", version: "2.34.2" }],
      localComponents: [{
        name: "requests",
        version: "2.34.2",
        source: {
          kind: "local-path",
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
    },
    buildTcb: {
      path: "apps/ltx-studio/release/build-tcb.v1.json",
      sha256: runtimeTrustFixture.buildTcbSha256,
      externalPolicySha256: "9".repeat(64),
    },
    surface: { path: surfacePath, sha256: surfaceDigest },
    rights: {
      evidenceCatalog: { path: rightsPath, sha256: rightsCatalogDigest },
    },
    qualification: {
      releaseDecision: "hold" as const,
      blockers: [...DISCHARGEABLE_MANIFEST_BLOCKERS] as string[],
    },
  };
  manifest.sbom.localComponents[0].source.sha256 = documentDigest(
    manifest.artifacts
      .filter(({ path }) => path.startsWith("apps/ltx-studio/runtime/"))
      .sort((left, right) => left.path.localeCompare(right.path)),
  );
  return {
    releaseRoot,
    surface,
    surfaceDigest,
    rightsCatalogDigest,
    manifest,
    qualificationKeys,
    qualificationTrustPolicy,
    qualificationTrustPolicyDigest,
    activationWriter,
    activationTrustPolicy,
    activationTrustPolicyDigest,
    releaseTrustPolicyDigest: runtimeTrustFixture.trustPolicyDigests.release,
    runtimeRightsTrustPolicyDigest: runtimeTrustFixture.trustPolicyDigests.runtimeRights,
  };
}

function runtimeIdentity(release: {
  manifest: { runtimeInstallIntegrity: unknown; hostTcb: unknown; buildTcb: { sha256: string } };
  qualificationTrustPolicyDigest: string;
  activationTrustPolicyDigest: string;
  releaseTrustPolicyDigest: string;
  runtimeRightsTrustPolicyDigest: string;
}) {
  const { manifest } = release;
  return {
    runtimeInstallSealSha256: "7".repeat(64),
    runtimeTreeSha256: "6".repeat(64),
    runtimePolicySha256: documentDigest(manifest.runtimeInstallIntegrity),
    nodeExecutableSha256: "5".repeat(64),
    runtimeTrust: {
      ...runtimeTrustFixture,
      hostTcbContractSha256: documentDigest(manifest.hostTcb),
      buildTcbSha256: manifest.buildTcb.sha256,
      trustPolicyDigests: {
        ...runtimeTrustFixture.trustPolicyDigests,
        release: release.releaseTrustPolicyDigest,
        activationWriter: release.activationTrustPolicyDigest,
        qualificationAuthorizer: release.qualificationTrustPolicyDigest,
        runtimeRights: release.runtimeRightsTrustPolicyDigest,
      },
    },
  };
}

function dependencies(release: ReturnType<typeof releaseFixture>) {
  return {
    now: NOW,
    immutableVerifier: () => undefined,
    releaseLoader: (root: string, expectedDigest: string) => ({
      releaseRoot: root,
      releaseDigest: expectedDigest,
      manifest: release.manifest,
      ...runtimeIdentity(release),
    }),
    auditModule,
    surfaceModule,
  };
}

function evidenceFixture(release: ReturnType<typeof releaseFixture>) {
  const evidenceRoot = mkdtempSync(join(tmpdir(), "ltx-preflight-evidence-"));
  temporaryRoots.push(evidenceRoot);
  chmodSync(evidenceRoot, 0o700);
  const general = generateKeyPairSync("ed25519");
  const holdout = generateKeyPairSync("ed25519");
  const authorizer = generateKeyPairSync("ed25519");
  const finalizer = generateKeyPairSync("ed25519");
  const infrastructureScanner = generateKeyPairSync("ed25519");
  const qualificationTrustPolicyDigest = writeCanonical(
    evidenceRoot,
    "qualification-resolution-trust.v1.json",
    release.qualificationTrustPolicy,
  );
  if (qualificationTrustPolicyDigest !== release.qualificationTrustPolicyDigest) {
    throw new Error("qualification trust-policy fixture digest drift");
  }
  const signQualificationDocument = (
    role: QualificationResolutionTrustRole,
    document: unknown,
  ) => {
    const key = release.qualificationKeys[role];
    return {
      schemaVersion: "ltx-studio-qualification-resolution-signature.v1",
      algorithm: "ed25519",
      role,
      keyId: key.keyId,
      payloadSha256: documentDigest(document),
      signatureBase64: sign(
        null,
        Buffer.from(canonicalJson(document)),
        key.keyPair.privateKey,
      ).toString("base64"),
    };
  };
  const trustPolicy = {
    schemaVersion: "ltx-studio-trusted-keys.v1",
    policyId: "preflight-policy-01",
    keys: [
      {
        keyId: "qualification-key-01",
        algorithm: "ed25519",
        publicKeyBase64: rawPublicKey(general.publicKey),
        roles: ["preregistration-freezer", "rights-attestor", "qualification-attestor"],
        notBefore: "2026-08-24T00:00:00Z",
        notAfter: "2026-08-26T00:00:00Z",
        revokedAt: null,
      },
      {
        keyId: "holdout-scorer-key-01",
        algorithm: "ed25519",
        publicKeyBase64: rawPublicKey(holdout.publicKey),
        roles: ["holdout-scorer"],
        notBefore: "2026-08-24T00:00:00Z",
        notAfter: "2026-08-26T00:00:00Z",
        revokedAt: null,
      },
      {
        keyId: "release-authorizer-key-01",
        algorithm: "ed25519",
        publicKeyBase64: rawPublicKey(authorizer.publicKey),
        roles: ["release-authorizer"],
        notBefore: "2026-08-24T00:00:00Z",
        notAfter: "2026-08-26T00:00:00Z",
        revokedAt: null,
      },
      {
        keyId: "audit-finalizer-key-01",
        algorithm: "ed25519",
        publicKeyBase64: rawPublicKey(finalizer.publicKey),
        roles: ["audit-finalizer"],
        notBefore: "2026-08-24T00:00:00Z",
        notAfter: "2026-08-26T00:00:00Z",
        revokedAt: null,
      },
    ],
  };
  const trustPolicyDigest = writeCanonical(evidenceRoot, "trusted-keys.json", trustPolicy);
  release.releaseTrustPolicyDigest = trustPolicyDigest;
  release.runtimeRightsTrustPolicyDigest = trustPolicyDigest;
  const evidenceRuntimeTrust = runtimeIdentity(release).runtimeTrust;
  const preregistration = {
    schema_version: "ltx-av-eval-preregistration.v2",
    status: "frozen",
    target_sota_claim_ids: ["audio-driven-video.ltx25.release"],
  };
  const preregistrationDigest = writeCanonical(evidenceRoot, "preregistration.json", preregistration);
  const preregistrationSignature = detachedSignature(
    preregistration,
    "qualification-key-01",
    general.privateKey,
  );
  const preregistrationSignatureDigest = writeCanonical(
    evidenceRoot,
    "preregistration.sig.json",
    preregistrationSignature,
  );
  const rights = {
    schemaVersion: "ltx-studio-rights-attestation.v2",
    releaseDigest: RELEASE_DIGEST,
    surfaceDigest: release.surfaceDigest,
    evidenceCatalogDigest: release.rightsCatalogDigest,
    runtimeTrust: evidenceRuntimeTrust,
    policyVersion: "ltx-studio-release-rights.v1",
    validAt: "2026-08-24T00:00:00Z",
    expiresAt: "2026-08-26T00:00:00Z",
    revocationState: "clear",
    evidenceIds: ["rights.ltx25"],
    warnings: [],
  };
  const rightsDigest = writeCanonical(evidenceRoot, "rights.json", rights);
  const rightsSignatureDigest = writeCanonical(
    evidenceRoot,
    "rights.sig.json",
    detachedSignature(rights, "qualification-key-01", general.privateKey),
  );
  const securityReference = (
    path: string,
    mediaType:
      | "application/json"
      | "application/vnd.ltx-studio.security-scan-request+json"
      | "application/vnd.ltx-studio.security-scan-result+json",
    document: unknown,
  ) => ({
    path,
    sha256: writeCanonical(evidenceRoot, path, document),
    mediaType,
  });
  const uvRequestReference = securityReference(
    "security/uv.request.json",
    "application/vnd.ltx-studio.security-scan-request+json",
    {
      schemaVersion: "ltx-studio-security-scan-request.v1",
      ecosystem: "python",
      advisoryProvider: "osv.dev",
      releaseDigest: RELEASE_DIGEST,
      lockSha256: "b".repeat(64),
      cutoffAt: "2026-08-25T11:00:00Z",
      components: [{ name: "requests", version: "2.34.2" }],
    },
  );
  const npmRequestReference = securityReference(
    "security/npm.request.json",
    "application/vnd.ltx-studio.security-scan-request+json",
    {
      schemaVersion: "ltx-studio-security-scan-request.v1",
      ecosystem: "npm",
      advisoryProvider: "npm-registry-audit",
      releaseDigest: RELEASE_DIGEST,
      lockSha256: "a".repeat(64),
      cutoffAt: "2026-08-25T11:00:00Z",
      components: [{ name: "express", version: "5.1.0" }],
    },
  );
  const uvResponseReference = securityReference(
    "security/uv.response.json",
    "application/json",
    { results: [{}] },
  );
  const npmResponseReference = securityReference(
    "security/npm.response.json",
    "application/json",
    {
      auditReportVersion: 2,
      metadata: { vulnerabilities: { total: 0 } },
      vulnerabilities: {},
    },
  );
  const normalizedResult = (
    ecosystem: "npm" | "python",
    advisoryProvider: "npm-registry-audit" | "osv.dev",
    requestSha256: string,
    responseSha256: string,
    component: { name: string; version: string },
  ) => ({
    schemaVersion: "ltx-studio-security-scan-result.v1",
    ecosystem,
    advisoryProvider,
    advisoryCutoffAt: "2026-08-25T11:00:00Z",
    requestSha256,
    responseSha256,
    networkStatus: "complete",
    components: [{ ...component, status: "clear", advisoryIds: [] }],
    normalizedAdvisories: [],
    unresolvedFindings: [],
    adverseStatuses: [],
    verdict: "pass",
  });
  const uvResultReference = securityReference(
    "security/uv.result.json",
    "application/vnd.ltx-studio.security-scan-result+json",
    normalizedResult(
      "python",
      "osv.dev",
      uvRequestReference.sha256,
      uvResponseReference.sha256,
      { name: "requests", version: "2.34.2" },
    ),
  );
  const npmResultReference = securityReference(
    "security/npm.result.json",
    "application/vnd.ltx-studio.security-scan-result+json",
    normalizedResult(
      "npm",
      "npm-registry-audit",
      npmRequestReference.sha256,
      npmResponseReference.sha256,
      { name: "express", version: "5.1.0" },
    ),
  );
  const infrastructurePublicKeyBase64 = rawPublicKey(infrastructureScanner.publicKey);
  const infrastructurePublicKeyBytes = Buffer.from(infrastructurePublicKeyBase64, "base64");
  const infrastructurePublicKeySha256 = hash(infrastructurePublicKeyBytes);
  const infrastructureScans = Object.fromEntries(
    (["build", "host", "container"] as const).map((scope) => {
      const components = scope === "build"
        ? release.manifest.sbom.buildTcbComponents
        : scope === "host"
          ? [
              ...release.manifest.sbom.hostTcbTools,
              ...release.manifest.sbom.hostRuntimeComponents,
            ]
          : [
              ...release.manifest.sbom.hostTcbDockerImages,
              ...release.manifest.sbom.containerRuntimeComponents,
            ];
      const sbomDocument = {
        schemaVersion: "ltx-studio-infrastructure-sbom.v1",
        scope,
        components,
      };
      const report = {
        schemaVersion: "ltx-studio-infrastructure-scan-report.v1",
        scope,
        releaseDigest: RELEASE_DIGEST,
        runtimeTrust: evidenceRuntimeTrust,
        scanner: {
          name: `fixture-${scope}-scanner`,
          version: "1.0.0",
          executableSha256: documentDigest({ scope, executable: "fixture" }),
          rulesDatabaseSha256: documentDigest({ scope, database: "fixture" }),
          rulesCutoffAt: "2026-08-25T11:00:00Z",
        },
        sbomSha256: documentDigest(sbomDocument),
        scannedComponents: components.length,
        omittedComponents: 0,
        normalizedFindings: [],
        unresolvedFindings: [],
        completedAt: "2026-08-25T11:20:00Z",
        expiresAt: "2026-08-26T11:20:00Z",
        verdict: "pass",
      };
      const payloadSha256 = documentDigest(report);
      const signatureDocument = {
        schemaVersion: "ltx-studio-infrastructure-scan-signature.v1",
        algorithm: "ed25519",
        keyId: "infrastructure-scanner-key-01",
        publicKeyBase64: infrastructurePublicKeyBase64,
        publicKeySha256: infrastructurePublicKeySha256,
        payloadSha256,
        signatureBase64: sign(
          null,
          Buffer.from(canonicalJson(report)),
          infrastructureScanner.privateKey,
        ).toString("base64"),
      };
      return [scope, {
        report: securityReference(
          `security/infrastructure/${scope}.report.json`,
          "application/json",
          report,
        ),
        signature: securityReference(
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
    releaseDigest: RELEASE_DIGEST,
    runtimeInstallSealSha256: "7".repeat(64),
    runtimeTreeSha256: "6".repeat(64),
    runtimePolicySha256: documentDigest(release.manifest.runtimeInstallIntegrity),
    nodeExecutableSha256: "5".repeat(64),
    runtimeTrust: evidenceRuntimeTrust,
    manifestQualification: release.manifest.qualification,
    generatedAt: "2026-08-25T11:30:00Z",
    cutoffAt: "2026-08-25T11:00:00Z",
    expiresAt: "2026-08-26T11:30:00Z",
    boundInputs: {
      nodeLock: { path: "apps/ltx-studio/package-lock.json", sha256: "a".repeat(64) },
      pythonLock: { path: "apps/ltx-studio/runtime/uv.lock", sha256: "b".repeat(64) },
      runtimePyproject: { path: "apps/ltx-studio/runtime/pyproject.toml", sha256: "c".repeat(64) },
      runtimeVerifier: { path: "apps/ltx-studio/runtime/verify_runtime.py", sha256: "d".repeat(64) },
    },
    infrastructureScans,
    audits: {
      uv: {
        tool: { name: "uv", version: "0.12.2", executableSha256: "e".repeat(64) },
        advisoryProvider: "osv.dev",
        advisoryCutoffAt: "2026-08-25T11:00:00Z",
        request: uvRequestReference,
        response: uvResponseReference,
        normalizedResult: uvResultReference,
      },
      npm: {
        tool: { name: "npm", version: "11.5.1", executableSha256: "0".repeat(64) },
        advisoryProvider: "npm-registry-audit",
        advisoryCutoffAt: "2026-08-25T11:00:00Z",
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
      nodeComponents: [{ name: "express", version: "5.1.0" }],
      pythonComponents: [{ name: "requests", version: "2.34.2" }],
      localComponents: [{
        name: "requests",
        version: "2.34.2",
        source: release.manifest.sbom.localComponents[0].source,
        auditedBy: ["osv.dev"],
        verdict: "clear",
      }],
      runtimeTcbComponents: release.manifest.sbom.runtimeTcbComponents,
      hostTcbTools: release.manifest.sbom.hostTcbTools,
      hostTcbDockerImages: release.manifest.sbom.hostTcbDockerImages,
      buildTcbComponents: release.manifest.sbom.buildTcbComponents,
      hostRuntimeComponents: release.manifest.sbom.hostRuntimeComponents,
      containerRuntimeComponents: release.manifest.sbom.containerRuntimeComponents,
    },
    packageAliases: [],
    normalizedAdvisories: [],
    unresolvedFindings: [],
    adverseStatuses: [],
    verdict: "pass",
  };
  const securityAuditDigest = writeCanonical(
    evidenceRoot,
    "security-audit.json",
    securityAudit,
  );
  const securityAuditSignature = detachedSignature(
    securityAudit,
    "qualification-key-01",
    general.privateKey,
  );
  const securityAuditSignatureDigest = writeCanonical(
    evidenceRoot,
    "security-audit.sig.json",
    securityAuditSignature,
  );

  const signedReports = qualificationKinds.map((kind) => {
    const gates = qualificationGateOwnership[kind];
    const report = {
      schemaVersion: "ltx-studio-qualification-report.v2",
      kind,
      releaseDigest: RELEASE_DIGEST,
      preregistrationDigest,
      surfaceDigest: release.surfaceDigest,
      runtimeTrust: evidenceRuntimeTrust,
      producerId: `producer.${kind}`,
      producerDigest: "9".repeat(64),
      verdict: "pass",
      warnings: [],
      coverage: gates.length > 0
        ? [{ surfaceEntryId: "ltx25.image-audio.release", gates: [...gates] }]
        : [],
      claimResults: kind === "q2-holdout"
        ? [{
            claimId: "audio-driven-video.ltx25.release",
            status: "sota-qualified",
            sotaAnchorDigest: "8".repeat(64),
          }]
        : [],
    };
    const path = `reports/${kind}.json`;
    const signaturePath = `reports/${kind}.sig.json`;
    const reportDigest = writeCanonical(evidenceRoot, path, report);
    const signatureDigest = writeCanonical(
      evidenceRoot,
      signaturePath,
      detachedSignature(
        report,
        kind === "q2-holdout" ? "holdout-scorer-key-01" : "qualification-key-01",
        kind === "q2-holdout" ? holdout.privateKey : general.privateKey,
      ),
    );
    return {
      reference: {
        kind,
        path,
        sha256: reportDigest,
        signaturePath,
        signatureSha256: signatureDigest,
      },
      document: report,
      signature: detachedSignature(
        report,
        kind === "q2-holdout" ? "holdout-scorer-key-01" : "qualification-key-01",
        kind === "q2-holdout" ? holdout.privateKey : general.privateKey,
      ),
    };
  });
  const buildAuthorityDocument = {
    schemaVersion: "ltx-studio-build-authority-attestation.v1" as const,
    releaseDigest: RELEASE_DIGEST,
    surfaceDigest: release.surfaceDigest,
    runtimeTrust: evidenceRuntimeTrust,
    qualificationTrustPolicySha256: qualificationTrustPolicyDigest,
    buildTcbSha256: evidenceRuntimeTrust.buildTcbSha256,
    claims: {
      dedicatedExternalBuildAuthority: true as const,
      readOnlyBuildSourceMount: true as const,
      separateBuildUid: true as const,
      transientSourceAndToolSwapExcluded: true as const,
    },
    resolvedBlockers: [...buildAuthorityResolvedBlockers],
    issuedAt: "2026-08-25T11:00:00Z",
    expiresAt: "2026-08-26T11:00:00Z",
    verdict: "pass" as const,
    warnings: [],
  };
  const buildAuthorityAttestation = {
    document: buildAuthorityDocument,
    signature: signQualificationDocument(
      "build-authority-attestor",
      buildAuthorityDocument,
    ),
  };
  const buildAuthorityDigest = writeCanonical(
    evidenceRoot,
    "qualification/build-authority-attestation.v1.json",
    buildAuthorityDocument,
  );
  const buildAuthoritySignatureDigest = writeCanonical(
    evidenceRoot,
    "qualification/build-authority-attestation.v1.sig.json",
    buildAuthorityAttestation.signature,
  );
  const authorityIsolationDocument = {
    schemaVersion: "ltx-studio-authority-isolation-attestation.v1" as const,
    releaseDigest: RELEASE_DIGEST,
    surfaceDigest: release.surfaceDigest,
    runtimeTrust: evidenceRuntimeTrust,
    qualificationTrustPolicySha256: qualificationTrustPolicyDigest,
    hostTcbAttestationSha256: evidenceRuntimeTrust.hostTcbAttestationSha256,
    mechanism: evidenceRuntimeTrust.authorityIsolation.status === "attested"
      ? evidenceRuntimeTrust.authorityIsolation.mechanism
      : "separate-studio-identity-proc-fd-isolation" as const,
    brokerAttestationSha256: evidenceRuntimeTrust.authorityIsolation.status === "attested"
      && evidenceRuntimeTrust.authorityIsolation.mechanism === "external-signer-sealed-fd-broker"
      ? evidenceRuntimeTrust.authorityIsolation.brokerAttestationSha256
      : null,
    privilegedControlPlaneIsolationAttested: true as const,
    resolvedBlockers: ["privileged-sudo-docker-control-plane-broker-missing"],
    issuedAt: "2026-08-25T11:00:00Z",
    expiresAt: "2026-08-26T11:00:00Z",
    verdict: "pass" as const,
    warnings: [],
  };
  const authorityIsolationAttestation = {
    document: authorityIsolationDocument,
    signature: signQualificationDocument(
      "authority-isolation-attestor",
      authorityIsolationDocument,
    ),
  };
  const authorityIsolationDigest = writeCanonical(
    evidenceRoot,
    "qualification/authority-isolation-attestation.v1.json",
    authorityIsolationDocument,
  );
  const authorityIsolationSignatureDigest = writeCanonical(
    evidenceRoot,
    "qualification/authority-isolation-attestation.v1.sig.json",
    authorityIsolationAttestation.signature,
  );
  const reportDigest = (kind: (typeof qualificationKinds)[number]): string => {
    const found = signedReports.find(({ reference }) => reference.kind === kind);
    if (!found) throw new Error(`missing preflight report fixture: ${kind}`);
    return found.reference.sha256;
  };
  const qualificationEvidenceDigests: QualificationEvidenceDigests = {
    "rights-attestation": rightsDigest,
    "security-audit": securityAuditDigest,
    "host-tcb-attestation": evidenceRuntimeTrust.hostTcbAttestationSha256,
    "build-authority-attestation": buildAuthorityDigest,
    "authority-isolation-attestation": authorityIsolationDigest,
    "r3-canaries-report": reportDigest("r3-canaries"),
    "d1-calibration-report": reportDigest("d1-calibration"),
    "q0-cross-shot-report": reportDigest("q0-cross-shot"),
    "q1-comparators-report": reportDigest("q1-comparators"),
    "q2-holdout-report": reportDigest("q2-holdout"),
  };
  const qualificationResolutionDocument = {
    schemaVersion: "ltx-studio-qualification-resolution.v2" as const,
    releaseDigest: RELEASE_DIGEST,
    surfaceDigest: release.surfaceDigest,
    manifestQualificationSha256: documentDigest(release.manifest.qualification),
    runtimeTrust: evidenceRuntimeTrust,
    qualificationTrustPolicySha256: qualificationTrustPolicyDigest,
    issuedAt: "2026-08-25T11:30:00Z",
    expiresAt: "2026-08-26T11:30:00Z",
    resolutions: expectedQualificationResolutions(
      release.manifest.qualification,
      qualificationEvidenceDigests,
    ),
    unresolvedBlockers: [],
    verdict: "pass" as const,
    warnings: [],
  };
  const qualificationResolution = {
    document: qualificationResolutionDocument,
    signature: signQualificationDocument(
      "qualification-resolver",
      qualificationResolutionDocument,
    ),
  };
  const qualificationResolutionDigest = writeCanonical(
    evidenceRoot,
    "qualification/qualification-resolution.v2.json",
    qualificationResolutionDocument,
  );
  const qualificationResolutionSignatureDigest = writeCanonical(
    evidenceRoot,
    "qualification/qualification-resolution.v2.sig.json",
    qualificationResolution.signature,
  );
  const index = {
    schemaVersion: "ltx-studio-release-evidence-index.v3",
    releaseDigest: RELEASE_DIGEST,
    runtimeTrust: evidenceRuntimeTrust,
    preregistrationDigest,
    targetSotaClaimIds: ["audio-driven-video.ltx25.release"],
    trustPolicy: { path: "trusted-keys.json", sha256: trustPolicyDigest },
    preregistration: {
      path: "preregistration.json",
      sha256: preregistrationDigest,
      signaturePath: "preregistration.sig.json",
      signatureSha256: preregistrationSignatureDigest,
    },
    rightsAttestation: {
      path: "rights.json",
      sha256: rightsDigest,
      signaturePath: "rights.sig.json",
      signatureSha256: rightsSignatureDigest,
    },
    securityAudit: {
      path: "security-audit.json",
      sha256: securityAuditDigest,
      signaturePath: "security-audit.sig.json",
      signatureSha256: securityAuditSignatureDigest,
    },
    qualification: {
      trustPolicy: {
        path: "qualification-resolution-trust.v1.json",
        sha256: qualificationTrustPolicyDigest,
      },
      buildAuthorityAttestation: {
        path: "qualification/build-authority-attestation.v1.json",
        sha256: buildAuthorityDigest,
        signaturePath: "qualification/build-authority-attestation.v1.sig.json",
        signatureSha256: buildAuthoritySignatureDigest,
      },
      authorityIsolationAttestation: {
        path: "qualification/authority-isolation-attestation.v1.json",
        sha256: authorityIsolationDigest,
        signaturePath: "qualification/authority-isolation-attestation.v1.sig.json",
        signatureSha256: authorityIsolationSignatureDigest,
      },
      resolution: {
        path: "qualification/qualification-resolution.v2.json",
        sha256: qualificationResolutionDigest,
        signaturePath: "qualification/qualification-resolution.v2.sig.json",
        signatureSha256: qualificationResolutionSignatureDigest,
      },
    },
    reports: signedReports.map(({ reference }) => reference),
  };
  writeCanonical(evidenceRoot, "evidence-index.v3.json", index);
  return {
    evidenceRoot,
    trustPolicyDigest,
    trustPolicy,
    index,
    preregistration,
    preregistrationSignature,
    rights,
    rightsSignature: detachedSignature(rights, "qualification-key-01", general.privateKey),
    rightsDigest,
    securityAudit,
    securityAuditSignature,
    securityAuditDigest,
    signedReports,
    qualificationTrustPolicy: release.qualificationTrustPolicy,
    qualificationTrustPolicyDigest,
    buildAuthorityAttestation,
    authorityIsolationAttestation,
    qualificationResolution,
    general,
    authorizer,
    finalizer,
  };
}

function writeFinalizationInputs(
  release: ReturnType<typeof releaseFixture>,
  evidence: ReturnType<typeof evidenceFixture>,
  runtimeOverrides: Partial<Record<RuntimeAuthorizationField, string>> = {},
) {
  const collected = auditModule.collectReleaseEvidence({
    now: NOW,
    releaseDigest: RELEASE_DIGEST,
    manifestSurfaceDigest: release.surfaceDigest,
    manifestRightsCatalogDigest: release.rightsCatalogDigest,
    surface: release.surface,
    index: evidence.index,
    trustPolicy: evidence.trustPolicy,
    preregistration: {
      document: evidence.preregistration,
      signature: evidence.preregistrationSignature,
    },
    rightsAttestation: {
      document: evidence.rights,
      signature: evidence.rightsSignature,
    },
    securityAudit: {
      document: evidence.securityAudit,
      signature: evidence.securityAuditSignature,
      sha256: evidence.securityAuditDigest,
    },
    securityAuditBinding: auditModule.securityAuditBindingFromReleaseManifest(
      release.manifest,
      RELEASE_DIGEST,
      runtimeIdentity(release),
    ),
    securityAuditReadArtifact: (path) =>
      readFileSync(join(evidence.evidenceRoot, path)),
    reports: evidence.signedReports.map(({ reference, document, signature }) => ({
      document,
      signature,
      kind: reference.kind,
      sha256: reference.sha256,
    })),
    trustPolicyDigest: evidence.trustPolicyDigest,
    qualificationTrustPolicy: evidence.qualificationTrustPolicy,
    qualificationTrustPolicyDigest: evidence.qualificationTrustPolicyDigest,
    buildAuthorityAttestation: evidence.buildAuthorityAttestation,
    authorityIsolationAttestation: evidence.authorityIsolationAttestation,
    qualificationResolution: evidence.qualificationResolution,
  });
  const releaseEvidenceDigest = writeCanonical(
    evidence.evidenceRoot,
    "release-evidence.v3.json",
    collected,
  );
  const authorization = writeAuthorizationInputs(
    release,
    evidence,
    collected,
    releaseEvidenceDigest,
    runtimeOverrides,
  );
  return { collected, authorization };
}

function writeAuthorizationInputs(
  release: ReturnType<typeof releaseFixture>,
  evidence: ReturnType<typeof evidenceFixture>,
  collected: ReturnType<typeof auditModule.collectReleaseEvidence>,
  releaseEvidenceDigest = documentDigest(collected),
  runtimeOverrides: Partial<Record<RuntimeAuthorizationField, string>> = {},
) {
  const q2ReportDigest = collected.reports.find(
    ({ kind }) => kind === "q2-holdout",
  )?.sha256;
  if (!q2ReportDigest) throw new Error("missing Q2 fixture report");
  const authorization = {
    schemaVersion: "ltx-studio-release-authorization.v4",
    activationGeneration: 1,
    releaseDigest: RELEASE_DIGEST,
    surfaceDigest: release.surfaceDigest,
    ...runtimeIdentity(release),
    ...runtimeOverrides,
    manifestQualificationSha256: collected.manifestQualificationSha256,
    qualificationTrustPolicyDigest: collected.qualificationTrustPolicyDigest,
    buildAuthorityAttestationDigest: collected.buildAuthorityAttestationDigest,
    authorityIsolationAttestationDigest: collected.authorityIsolationAttestationDigest,
    qualificationResolutionDigest: collected.qualificationResolutionDigest,
    preregistrationDigest: evidence.index.preregistrationDigest,
    q2ReportDigest,
    releaseEvidenceDigest,
    rightsAttestationDigest: evidence.rightsDigest,
    securityAuditDigest: collected.securityAudit.sha256,
    releasedSurfaceEntryIds: ["ltx25.image-audio.release"],
    notBefore: "2026-08-25T11:00:00Z",
    expiresAt: "2026-08-25T13:00:00Z",
  };
  writeCanonical(
    evidence.evidenceRoot,
    "release-authorization.v4.json",
    authorization,
  );
  writeCanonical(
    evidence.evidenceRoot,
    "release-authorization.v4.sig.json",
    detachedSignature(
      authorization,
      "release-authorizer-key-01",
      evidence.authorizer.privateKey,
    ),
  );
  return authorization;
}

function activationControlFixture(
  release: ReturnType<typeof releaseFixture>,
  evidence: ReturnType<typeof evidenceFixture>,
) {
  const activationControlRoot = mkdtempSync(join(tmpdir(), "ltx-promotion-control-"));
  temporaryRoots.push(activationControlRoot);
  chmodSync(activationControlRoot, 0o700);
  writeCanonical(
    activationControlRoot,
    "activation-writer-trust.json",
    release.activationTrustPolicy,
  );
  writeCanonical(
    activationControlRoot,
    "release-trusted-keys.json",
    evidence.trustPolicy,
  );
  const releaseBinding = {
    releaseDigest: RELEASE_DIGEST,
    surfaceDigest: release.surfaceDigest,
    ...runtimeIdentity(release),
    rights: {
      policyEvidenceDigest: release.rightsCatalogDigest,
      attestationSeriesId: "release-rights-series-001",
      minimumSnapshotVersion: 1,
    },
  };
  const signedActivationRecord = (
    raw: Parameters<typeof activationModule.activationJournalRecordSchema.parse>[0],
  ) => {
    const record = activationModule.activationJournalRecordSchema.parse(raw);
    return activationModule.activationJournalEnvelopeSchema.parse({
      record,
      signature: {
        schemaVersion: "ltx-studio-detached-signature.v1",
        algorithm: "ed25519",
        role: "activation-journal-writer",
        keyId: "activation-writer-key-01",
        payloadSha256: activationModule.activationRecordDigest(record),
        signatureBase64: sign(
          null,
          Buffer.from(canonicalJson(record)),
          release.activationWriter.privateKey,
        ).toString("base64"),
      },
    });
  };
  const bootstrap = signedActivationRecord({
    schemaVersion: "ltx-studio-activation-journal-record.v3",
    recordId: "00000000-0000-4000-8000-000000000101",
    sequence: 0,
    generation: 1,
    previousRecordSha256: null,
    previousState: null,
    state: "blocked",
    operation: "bootstrap_generation",
    release: releaseBinding,
    releasedSurfaceEntryIds: [],
    authorizationDigest: null,
    auditEnvelopeDigest: null,
    evidenceDigest: null,
    ticketId: null,
    ticketState: null,
    ticketTerminal: null,
    supersedePreflight: null,
    recordedAt: "2026-08-25T11:00:00Z",
    writerKeyId: "activation-writer-key-01",
  });
  const qualificationOnly = signedActivationRecord({
    ...bootstrap.record,
    recordId: "00000000-0000-4000-8000-000000000102",
    sequence: 1,
    previousRecordSha256: activationModule.activationEnvelopeDigest(bootstrap),
    previousState: "blocked",
    state: "qualification_only",
    operation: "activate_qualification_mode",
    authorizationDigest: hash("qualification-mode-authorization"),
    recordedAt: "2026-08-25T11:10:00Z",
  });
  const journal = [bootstrap, qualificationOnly];
  writeCanonical(activationControlRoot, "activation-journal.json", journal);
  writeCanonical(activationControlRoot, "activation-head.json", {
    generation: 1,
    sequence: 1,
    headSha256: activationModule.activationEnvelopeDigest(qualificationOnly),
  });
  const runtimeRightsSnapshot = {
    schemaVersion: "ltx-studio-runtime-rights-snapshot.v3",
    releaseDigest: RELEASE_DIGEST,
    surfaceDigest: release.surfaceDigest,
    ...runtimeIdentity(release),
    policyEvidenceDigest: release.rightsCatalogDigest,
    attestationSeriesId: "release-rights-series-001",
    version: 1,
    checkedAt: "2026-08-25T11:30:00Z",
    nextUpdate: "2026-08-25T13:00:00Z",
    sourceDigest: hash("runtime-rights-source"),
    revocationState: "clear",
  };
  writeCanonical(activationControlRoot, "runtime-rights-snapshot.json", {
    document: runtimeRightsSnapshot,
    signature: detachedSignature(
      runtimeRightsSnapshot,
      "qualification-key-01",
      evidence.general.privateKey,
    ),
  });
  return { activationControlRoot, journal, qualificationOnly, runtimeRightsSnapshot };
}

function snapshotTree(root: string): Record<string, string> {
  return Object.fromEntries(
    (readdirSync(root, { recursive: true }) as string[])
      .sort()
      .flatMap((relativePath) => {
        const absolutePath = join(root, relativePath);
        return lstatSync(absolutePath).isFile()
          ? [[relativePath, hash(readFileSync(absolutePath))]]
          : [];
      }),
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release audit preflight", () => {
  it("blocks same-UID authority before dynamic imports or evidence reads", async () => {
    const release = releaseFixture();
    let dynamicImports = 0;
    let evidenceReads = 0;
    const base = dependencies(release);
    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
      evidenceRoot: "/must-not-be-read",
      trustedPolicySha256: "1".repeat(64),
    }, {
      ...base,
      auditModule: undefined,
      surfaceModule: undefined,
      releaseLoader: (root: string, expectedDigest: string) => ({
        ...base.releaseLoader(root, expectedDigest),
        runtimeTrust: sameUidRuntimeTrustFixture,
      }),
      dynamicModuleLoader: () => {
        dynamicImports += 1;
        throw new Error("dynamic import must not execute");
      },
      evidenceIoFactory: () => {
        evidenceReads += 1;
        throw new Error("evidence read must not execute");
      },
    });

    expect(result.verdict).toBe("blocked");
    expect(result.checks.find(({ id }: { id: string }) => id === "runtime-authority-isolation"))
      .toMatchObject({ status: "invalid", code: "runtime-authority-isolation-hold" });
    expect(dynamicImports).toBe(0);
    expect(evidenceReads).toBe(0);
  });

  it("fails closed while the installed-runtime content seal is unresolved", () => {
    const release = releaseFixture();
    const blockedManifest = structuredClone(release.manifest) as {
      runtimeInstallIntegrity: Record<string, unknown>;
    };
    blockedManifest.runtimeInstallIntegrity = {
      schemaVersion: "ltx-studio-runtime-install-integrity.v1",
      status: "blocked",
      blocker: "runtime-install-content-seal-missing",
    };

    expect(() => auditModule.securityAuditBindingFromReleaseManifest(
      blockedManifest,
      RELEASE_DIGEST,
      runtimeIdentity(release),
    )).toThrow(/installed-runtime integrity seal/i);
  });

  it("rejects local tree drift and an incomplete release CUDA inventory", () => {
    const release = releaseFixture();
    const driftedLocalTree = structuredClone(release.manifest);
    driftedLocalTree.sbom.localComponents[0].source.sha256 = "0".repeat(64);
    expect(() => auditModule.securityAuditBindingFromReleaseManifest(
      driftedLocalTree,
      RELEASE_DIGEST,
      runtimeIdentity(release),
    )).toThrow(/tree digest is missing or invalid/i);

    const omittedCuda = structuredClone(release.manifest);
    omittedCuda.sbom.pythonComponents.push({
      name: "nvidia-cublas",
      version: "13.4.0.1",
    });
    expect(() => auditModule.securityAuditBindingFromReleaseManifest(
      omittedCuda,
      RELEASE_DIGEST,
      runtimeIdentity(release),
    )).toThrow(/every installed CUDA runtime component/i);
  });

  it("reports absent external evidence deterministically without writing files", async () => {
    const release = releaseFixture();
    const before = readdirSync(release.releaseRoot, { recursive: true }).sort();
    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
    }, dependencies(release));

    expect(result.verdict).toBe("blocked");
    expect(result.checks.find(({ id }: { id: string }) => id === "release-root")?.status).toBe("present");
    expect(result.checks.find(({ id }: { id: string }) => id === "evidence-root")).toMatchObject({
      status: "missing",
      origin: "external",
    });
    expect(result.blockers.some(({ origin }: { origin: string }) => origin === "code-schema")).toBe(false);
    expect(readdirSync(release.releaseRoot, { recursive: true }).sort()).toEqual(before);
  });

  it("preserves a valid out-of-band trust pin when the evidence root is still absent", async () => {
    const release = releaseFixture();
    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
      trustedPolicySha256: "1".repeat(64),
    }, dependencies(release));

    expect(result.checks.find(({ id }: { id: string }) => id === "evidence-root")?.status).toBe("missing");
    expect(result.checks.find(({ id }: { id: string }) => id === "trusted-policy-pin")).toMatchObject({
      status: "present",
      origin: "external",
    });
  });

  it("distinguishes a malformed external index from a code/schema failure", async () => {
    const release = releaseFixture();
    const evidenceRoot = mkdtempSync(join(tmpdir(), "ltx-preflight-invalid-"));
    temporaryRoots.push(evidenceRoot);
    chmodSync(evidenceRoot, 0o700);
    writeCanonical(evidenceRoot, "evidence-index.v3.json", { malformed: true });
    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
      evidenceRoot,
      trustedPolicySha256: "1".repeat(64),
    }, dependencies(release));

    expect(result.checks.find(({ id }: { id: string }) => id === "evidence-index")).toMatchObject({
      status: "invalid",
      origin: "external",
      code: "evidence-index-invalid",
    });
    expect(result.checks.find(({ id }: { id: string }) => id === "release-audit-schema")?.status).toBe("present");
  });

  it("reports a missing release-contained parser as a code/schema failure", async () => {
    const release = releaseFixture();
    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
    }, {
      ...dependencies(release),
      auditModule: {},
    });

    expect(result.checks.find(({ id }: { id: string }) => id === "release-audit-schema")).toMatchObject({
      status: "invalid",
      origin: "code-schema",
      code: "release-audit-schema-invalid",
    });
  });

  it("validates rights, all phases, cold-canary gates, and Q2 without creating an envelope", async () => {
    const release = releaseFixture();
    const evidence = evidenceFixture(release);
    const before = readdirSync(evidence.evidenceRoot, { recursive: true }).sort();
    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
      evidenceRoot: evidence.evidenceRoot,
      trustedPolicySha256: evidence.trustPolicyDigest,
    }, dependencies(release));

    expect(result.verdict).toBe("ready-for-evidence-collection");
    expect(result.readyForEvidenceCollection).toBe(true);
    expect(result.readyForFinalization).toBe(false);
    for (const id of [
      "security-audit",
      "rights-attestation",
      "cold-canary-gates",
      "q2-claim-coverage",
      "evidence-collection",
    ]) {
      expect(result.checks.find((check: { id: string }) => check.id === id)?.status).toBe("present");
    }
    expect(result.checks.find(({ id }: { id: string }) => id === "release-evidence")?.status).toBe("missing");
    expect(readdirSync(evidence.evidenceRoot, { recursive: true }).sort()).toEqual(before);
  });

  it("validates external finalization inputs without creating or signing an audit envelope", async () => {
    const release = releaseFixture();
    const evidence = evidenceFixture(release);
    const collected = auditModule.collectReleaseEvidence({
      now: NOW,
      releaseDigest: RELEASE_DIGEST,
      manifestSurfaceDigest: release.surfaceDigest,
      manifestRightsCatalogDigest: release.rightsCatalogDigest,
      surface: release.surface,
      index: evidence.index,
      trustPolicy: evidence.trustPolicy,
      preregistration: {
        document: evidence.preregistration,
        signature: evidence.preregistrationSignature,
      },
      rightsAttestation: {
        document: evidence.rights,
        signature: evidence.rightsSignature,
      },
      securityAudit: {
        document: evidence.securityAudit,
        signature: evidence.securityAuditSignature,
        sha256: evidence.securityAuditDigest,
      },
      securityAuditBinding: auditModule.securityAuditBindingFromReleaseManifest(
        release.manifest,
        RELEASE_DIGEST,
        runtimeIdentity(release),
      ),
      securityAuditReadArtifact: (path) =>
        readFileSync(join(evidence.evidenceRoot, path)),
      reports: evidence.signedReports.map(({ reference, document, signature }) => ({
        document,
        signature,
        kind: reference.kind,
        sha256: reference.sha256,
      })),
      trustPolicyDigest: evidence.trustPolicyDigest,
      qualificationTrustPolicy: evidence.qualificationTrustPolicy,
      qualificationTrustPolicyDigest: evidence.qualificationTrustPolicyDigest,
      buildAuthorityAttestation: evidence.buildAuthorityAttestation,
      authorityIsolationAttestation: evidence.authorityIsolationAttestation,
      qualificationResolution: evidence.qualificationResolution,
    });
    const releaseEvidenceDigest = writeCanonical(
      evidence.evidenceRoot,
      "release-evidence.v3.json",
      collected,
    );
    const q2ReportDigest = collected.reports.find(({ kind }) => kind === "q2-holdout")!.sha256;
    const authorization = {
      schemaVersion: "ltx-studio-release-authorization.v4",
      activationGeneration: 1,
      releaseDigest: RELEASE_DIGEST,
      surfaceDigest: release.surfaceDigest,
      ...runtimeIdentity(release),
      manifestQualificationSha256: collected.manifestQualificationSha256,
      qualificationTrustPolicyDigest: collected.qualificationTrustPolicyDigest,
      buildAuthorityAttestationDigest: collected.buildAuthorityAttestationDigest,
      authorityIsolationAttestationDigest: collected.authorityIsolationAttestationDigest,
      qualificationResolutionDigest: collected.qualificationResolutionDigest,
      preregistrationDigest: evidence.index.preregistrationDigest,
      q2ReportDigest,
      releaseEvidenceDigest,
      rightsAttestationDigest: evidence.rightsDigest,
      securityAuditDigest: collected.securityAudit.sha256,
      releasedSurfaceEntryIds: ["ltx25.image-audio.release"],
      notBefore: "2026-08-25T11:00:00Z",
      expiresAt: "2026-08-25T13:00:00Z",
    };
    writeCanonical(evidence.evidenceRoot, "release-authorization.v4.json", authorization);
    writeCanonical(
      evidence.evidenceRoot,
      "release-authorization.v4.sig.json",
      detachedSignature(authorization, "release-authorizer-key-01", evidence.authorizer.privateKey),
    );
    const operatorRoot = mkdtempSync(join(tmpdir(), "ltx-preflight-operator-"));
    temporaryRoots.push(operatorRoot);
    chmodSync(operatorRoot, 0o700);
    const finalizerPrivateKeyPath = join(operatorRoot, "audit-finalizer.pk8.pem");
    writeFileSync(
      finalizerPrivateKeyPath,
      evidence.finalizer.privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    const beforeEvidence = readdirSync(evidence.evidenceRoot, { recursive: true }).sort();
    const beforeOperator = readdirSync(operatorRoot, { recursive: true }).sort();

    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
      evidenceRoot: evidence.evidenceRoot,
      trustedPolicySha256: evidence.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
      finalizerPrivateKeyPath,
    }, dependencies(release));

    expect(result.verdict).toBe("ready-for-finalization");
    expect(result.readyForFinalization).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.release.manifestBlockers).toEqual(DISCHARGEABLE_MANIFEST_BLOCKERS);
    expect(readdirSync(evidence.evidenceRoot, { recursive: true }).sort()).toEqual(beforeEvidence);
    expect(readdirSync(operatorRoot, { recursive: true }).sort()).toEqual(beforeOperator);
    expect(beforeEvidence).not.toContain("release-audit.v1.json");
  });

  it.each(RUNTIME_AUTHORIZATION_FIELDS)(
    "rejects a correctly re-signed authorization with swapped %s",
    async (field) => {
      const release = releaseFixture();
      const evidence = evidenceFixture(release);
      writeFinalizationInputs(release, evidence, { [field]: "f".repeat(64) });

      const result = await runReleaseAuditPreflight({
        expectedReleaseDigest: RELEASE_DIGEST,
        releaseRoot: release.releaseRoot,
        evidenceRoot: evidence.evidenceRoot,
        trustedPolicySha256: evidence.trustPolicyDigest,
      }, dependencies(release));

      expect(result.checks.find(({ id }: { id: string }) => id === "release-authorization"))
        .toMatchObject({ status: "invalid", code: "release-authorization-invalid" });
      expect(result.readyForFinalization).toBe(false);
    },
  );

  it("rejects a coordinated re-signed swap of every runtime identity digest", async () => {
    const release = releaseFixture();
    const evidence = evidenceFixture(release);
    writeFinalizationInputs(release, evidence, Object.fromEntries(
      RUNTIME_AUTHORIZATION_FIELDS.map((field, index) => [
        field,
        index.toString(16).repeat(64),
      ]),
    ));

    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
      evidenceRoot: evidence.evidenceRoot,
      trustedPolicySha256: evidence.trustPolicyDigest,
    }, dependencies(release));

    expect(result.checks.find(({ id }: { id: string }) => id === "release-authorization"))
      .toMatchObject({ status: "invalid", code: "release-authorization-invalid" });
    expect(result.readyForFinalization).toBe(false);
  });

  it("blocks every unresolved manifest qualification blocker before evidence, finalization, or phase-pass substitution", async () => {
    for (const blocker of [
      "current-signed-rights-attest-missing",
      "signed-build-host-container-scan-reports-missing",
      "root-owned-post-install-host-attestation-missing",
      "dedicated-external-build-authority-attestation-missing",
      "read-only-build-source-mount-not-independently-attested",
      "separate-build-uid-isolation-not-independently-attested",
      "same-uid-transient-source-or-tool-swap-not-excluded",
      "privileged-sudo-docker-control-plane-broker-missing",
      "longcat-runtime-worktree-dirty",
      "digest-bound-cold-canary-missing",
      "quality-and-holdout-evidence-missing",
    ]) {
      const release = releaseFixture();
      const evidence = evidenceFixture(release);
      release.manifest.qualification = { releaseDecision: "hold", blockers: [blocker] };
      const result = await runReleaseAuditPreflight({
        expectedReleaseDigest: RELEASE_DIGEST,
        releaseRoot: release.releaseRoot,
        evidenceRoot: evidence.evidenceRoot,
        trustedPolicySha256: evidence.trustPolicyDigest,
      }, dependencies(release));
      expect(result.verdict).toBe("blocked");
      expect(result.readyForEvidenceCollection).toBe(false);
      expect(result.readyForFinalization).toBe(false);
      expect(result.checks.find(({ id }: { id: string }) => id === "manifest-qualification"))
        .toMatchObject({ status: "invalid", code: "manifest-qualification-hold" });
      expect(result.release.manifestBlockers).toEqual([blocker]);
    }
  });

  it("reports the historical M2 report as a deterministic stale-security-audit blocker", async () => {
    const release = releaseFixture();
    const evidence = evidenceFixture(release);
    const historicalM2 = {
      schemaVersion: "ltx-m2-security-runtime-report.v1",
      generatedAt: "2026-08-15T00:15:26Z",
      status: "security-and-cpu-runtime-pass",
    };
    evidence.index.securityAudit.sha256 = writeCanonical(
      evidence.evidenceRoot,
      "security-audit.json",
      historicalM2,
    );
    writeCanonical(
      evidence.evidenceRoot,
      "evidence-index.v3.json",
      evidence.index,
    );

    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
      evidenceRoot: evidence.evidenceRoot,
      trustedPolicySha256: evidence.trustPolicyDigest,
    }, dependencies(release));

    expect(result.checks.find(({ id }: { id: string }) => id === "security-audit"))
      .toMatchObject({
        status: "invalid",
        origin: "external",
        code: "stale-security-audit",
      });
    expect(result.readyForEvidenceCollection).toBe(false);
  });

  it("does not trust or mark signed subchecks present after a policy-pin mismatch", async () => {
    const release = releaseFixture();
    const evidence = evidenceFixture(release);
    const pinnedDigest = evidence.trustPolicyDigest;
    const replacementPolicy = {
      ...evidence.trustPolicy,
      policyId: "preflight-policy-replaced",
    };
    evidence.index.trustPolicy.sha256 = writeCanonical(
      evidence.evidenceRoot,
      "trusted-keys.json",
      replacementPolicy,
    );
    writeCanonical(
      evidence.evidenceRoot,
      "evidence-index.v3.json",
      evidence.index,
    );

    const result = await runReleaseAuditPreflight({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
      evidenceRoot: evidence.evidenceRoot,
      trustedPolicySha256: pinnedDigest,
    }, dependencies(release));

    expect(result.checks.find(({ id }: { id: string }) => id === "trust-policy"))
      .toMatchObject({ status: "invalid" });
    expect(result.checks.find(({ id }: { id: string }) => id === "security-audit"))
      .toMatchObject({
        status: "missing",
        code: "trusted-policy-prerequisite-missing",
      });
    expect(result.readyForEvidenceCollection).toBe(false);
  });

  it("rejects unknown and duplicate CLI options", () => {
    expect(() => parsePreflightArguments(["--unknown", "value"])).toThrow(/unsupported/i);
    expect(() => parsePreflightArguments([
      "--release", RELEASE_DIGEST,
      "--release", RELEASE_DIGEST,
    ])).toThrow(/duplicate/i);
  });
});

describe("qualification v2 operator CLI chain", () => {
  it("uses v3/v4 defaults through evidence, staged security, final audit, and a no-mutation promotion HOLD", async () => {
    const release = releaseFixture();
    const evidence = evidenceFixture(release);
    const baseDependencies = dependencies(release);
    const commonArguments = [
      "--release", RELEASE_DIGEST,
      "--release-root", release.releaseRoot,
      "--evidence-root", evidence.evidenceRoot,
      "--trusted-policy-sha256", evidence.trustPolicyDigest,
    ];

    const collectionCommand = await executeReleaseAuditCommand(
      "evidence",
      commonArguments,
      baseDependencies,
    );
    expect(collectionCommand.exitCode).toBe(0);
    expect(collectionCommand.document).toMatchObject({
      releaseDigest: RELEASE_DIGEST,
      readyForReleaseAuthorization: true,
    });
    expect(readdirSync(evidence.evidenceRoot, { recursive: true }))
      .toContain("release-evidence.v3.json");
    expect(readdirSync(evidence.evidenceRoot, { recursive: true }))
      .not.toContain("release-evidence.v1.json");
    const collected = auditModule.releaseEvidenceSchema.parse(JSON.parse(readFileSync(
      join(evidence.evidenceRoot, "release-evidence.v3.json"),
      "utf8",
    )));
    writeAuthorizationInputs(
      release,
      evidence,
      collected,
      collectionCommand.document.evidenceDigest,
    );

    const productSecurity = await executeReleaseAuditCommand(
      "security",
      commonArguments,
      baseDependencies,
    );
    expect(productSecurity).toMatchObject({
      exitCode: 2,
      document: { mode: "product-go", verdict: "blocked", go: false },
    });
    const stagedSecurity = await executeReleaseAuditCommand(
      "security",
      [...commonArguments, "--mode", "staged-evidence"],
      baseDependencies,
    );
    expect(stagedSecurity).toMatchObject({
      exitCode: 0,
      document: {
      mode: "staged-evidence",
      verdict: "evidence-valid",
      go: false,
      },
    });

    const finalizationCommand = await executeReleaseAuditCommand("finalize", [
      ...commonArguments,
      "--finalizer-key-id", "audit-finalizer-key-01",
      "--finalizer-private-key", "/external/operator/finalizer.pk8.pem",
    ], {
      ...baseDependencies,
      privateKeyReader: () => evidence.finalizer.privateKey.export({
        format: "pem",
        type: "pkcs8",
      }).toString(),
    });
    expect(finalizationCommand.exitCode).toBe(0);
    expect(finalizationCommand.document.output)
      .toBe(join(evidence.evidenceRoot, "release-audit.v4.json"));
    expect(readdirSync(evidence.evidenceRoot, { recursive: true }))
      .not.toContain("release-audit.v1.json");

    const activation = activationControlFixture(release, evidence);
    const evidenceBefore = snapshotTree(evidence.evidenceRoot);
    const activationBefore = snapshotTree(activation.activationControlRoot);
    const promotionCommand = await executeReleaseAuditCommand("promotion", [
      ...commonArguments,
      "--activation-control-root", activation.activationControlRoot,
    ], {
      ...baseDependencies,
      activationModule,
    });

    expect(promotionCommand.exitCode).toBe(2);
    expect(promotionCommand.document).toMatchObject({
      schemaVersion: "ltx-studio-promotion-authorization-request.v1",
      status: "hold-external-activation-writer-required",
      mutationPerformed: false,
      expectedActivationHead: {
        generation: 1,
        sequence: 1,
        headSha256: activationModule.activationEnvelopeDigest(activation.qualificationOnly),
      },
      requestedTransition: {
        previousState: "qualification_only",
        operation: "promote_production",
        state: "production_provisional",
        releasedSurfaceEntryIds: ["ltx25.image-audio.release"],
        evidenceDigest: null,
      },
    });
    expect(snapshotTree(evidence.evidenceRoot)).toEqual(evidenceBefore);
    expect(snapshotTree(activation.activationControlRoot)).toEqual(activationBefore);
  });

  it("fails closed on a missing v3 qualification artifact and never falls back to a v1 index", async () => {
    const release = releaseFixture();
    const evidence = evidenceFixture(release);
    rmSync(join(
      evidence.evidenceRoot,
      "qualification/qualification-resolution.v2.json",
    ));

    const command = await executeReleaseAuditCommand("evidence", [
      "--release", RELEASE_DIGEST,
      "--release-root", release.releaseRoot,
      "--evidence-root", evidence.evidenceRoot,
      "--trusted-policy-sha256", evidence.trustPolicyDigest,
    ], dependencies(release));
    expect(command).toMatchObject({
      exitCode: 2,
      document: { command: "evidence", verdict: "hold", go: false },
    });
    expect(readdirSync(evidence.evidenceRoot, { recursive: true }))
      .not.toContain("release-evidence.v3.json");
  });

  it("rejects a foreign re-signed runtime-rights snapshot before producing a request", async () => {
    const release = releaseFixture();
    const evidence = evidenceFixture(release);
    writeFinalizationInputs(release, evidence);
    const finalization = await runReleaseAuditFinalization({
      expectedReleaseDigest: RELEASE_DIGEST,
      releaseRoot: release.releaseRoot,
      evidenceRoot: evidence.evidenceRoot,
      trustedPolicySha256: evidence.trustPolicyDigest,
      finalizerKeyId: "audit-finalizer-key-01",
    }, {
      ...dependencies(release),
      privateKeyReader: () => evidence.finalizer.privateKey.export({
        format: "pem",
        type: "pkcs8",
      }).toString(),
    });
    expect(finalization.auditDigest).toMatch(/^[0-9a-f]{64}$/);
    const activation = activationControlFixture(release, evidence);
    const foreignSnapshot = {
      ...activation.runtimeRightsSnapshot,
      runtimeTreeSha256: "f".repeat(64),
    };
    writeCanonical(
      activation.activationControlRoot,
      "runtime-rights-snapshot.json",
      {
        document: foreignSnapshot,
        signature: detachedSignature(
          foreignSnapshot,
          "qualification-key-01",
          evidence.general.privateKey,
        ),
      },
    );
    const before = snapshotTree(activation.activationControlRoot);

    const command = await executeReleaseAuditCommand("promotion", [
      "--release", RELEASE_DIGEST,
      "--release-root", release.releaseRoot,
      "--evidence-root", evidence.evidenceRoot,
      "--trusted-policy-sha256", evidence.trustPolicyDigest,
      "--activation-control-root", activation.activationControlRoot,
    ], {
      ...dependencies(release),
      activationModule,
    });
    expect(command).toMatchObject({
      exitCode: 2,
      document: {
        status: "blocked",
        mutationPerformed: false,
        error: expect.stringMatching(/Runtime rights snapshot binding mismatch/),
      },
    });
    expect(snapshotTree(activation.activationControlRoot)).toEqual(before);
  });

  it("strictly parses every productive command and keeps v3/v4 defaults implicit", () => {
    const commonArguments = [
      "--release", RELEASE_DIGEST,
      "--evidence-root", "/secure/evidence",
      "--trusted-policy-sha256", "b".repeat(64),
    ];
    expect(parseReleaseAuditCommandArguments("security", commonArguments))
      .toMatchObject({ mode: "product-go" });
    expect(parseReleaseAuditCommandArguments("evidence", commonArguments))
      .not.toHaveProperty("indexPath");
    expect(() => parseReleaseAuditCommandArguments("evidence", [
      ...commonArguments,
      "--index", "evidence-index.v3.json",
      "--index", "evidence-index.v1.json",
    ])).toThrow(/Duplicate/);
    expect(() => parseReleaseAuditCommandArguments("finalize", [
      ...commonArguments,
      "--unknown", "value",
    ])).toThrow(/Unsupported/);
    expect(() => parseReleaseAuditCommandArguments("promotion", [
      ...commonArguments,
    ])).toThrow(/activation-control-root/);
  });

  it("wires the complete command chain into source and staged package entrypoints", () => {
    const sourcePackage = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(sourcePackage.scripts).toMatchObject({
      "audit:preflight": "node scripts/preflight-release-audit.mjs",
      "audit:security": "node scripts/audit-release-security.mjs",
      "audit:release": "node scripts/audit-release.mjs",
      "audit:finalize": "node scripts/finalize-release-audit.mjs",
      "audit:promotion": "node scripts/prepare-release-promotion.mjs",
    });
    const stageSource = readFileSync(
      join(process.cwd(), "scripts", "stage-release-assets.mjs"),
      "utf8",
    );
    for (const entrypoint of [
      "preflight-release-audit.mjs",
      "audit-release-security.mjs",
      "audit-release.mjs",
      "finalize-release-audit.mjs",
      "prepare-release-promotion.mjs",
    ]) {
      expect(stageSource).toContain(`./runtime/.venv/bin/node scripts/${entrypoint}`);
    }
  });
});
