import { createHash, createPublicKey, verify } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonicalJson.js";
import {
  assertRuntimeTrustAuthorizesRelease,
  runtimeTrustBindingSchema,
  type RuntimeTrustBinding,
} from "./runtimeTrust.js";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const timestampSchema = z.string().datetime({ offset: false, precision: 0 });
const packageNameSchema = z.string().min(1).max(256);
const packageVersionSchema = z.string().min(1).max(256);
const relativePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => {
    const parts = value.split("/");
    return (
      !value.startsWith("/") &&
      !value.includes("\\") &&
      parts.every((part) => part !== "" && part !== "." && part !== "..")
    );
  }, "path must be a normalized relative POSIX path");

const MAX_SECURITY_AUDIT_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_SECURITY_ARTIFACT_BYTES = 16 * 1024 * 1024;
const manifestQualificationSchema = z.object({
  releaseDecision: z.enum(["pass", "hold"]),
  blockers: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{2,127}$/)),
}).strict().superRefine((qualification, context) => {
  if (new Set(qualification.blockers).size !== qualification.blockers.length
    || (qualification.releaseDecision === "pass") !== (qualification.blockers.length === 0)) {
    context.addIssue({
      code: "custom",
      path: ["blockers"],
      message: "manifest qualification decision and blockers are inconsistent",
    });
  }
});

export const securityAuditInputPaths = {
  nodeLock: "apps/ltx-studio/package-lock.json",
  pythonLock: "apps/ltx-studio/runtime/uv.lock",
  runtimePyproject: "apps/ltx-studio/runtime/pyproject.toml",
  runtimeVerifier: "apps/ltx-studio/runtime/verify_runtime.py",
} as const;

const packageComponentSchema = z
  .object({
    name: packageNameSchema,
    version: packageVersionSchema,
  })
  .strict();

const localComponentSourceSchema = z
  .object({
    kind: z.enum(["local-path", "direct-wheel", "cuda-runtime"]),
    locator: z.string().min(1).max(1024),
    sha256: sha256Schema,
  })
  .strict();

const boundLocalComponentSchema = packageComponentSchema
  .extend({ source: localComponentSourceSchema })
  .strict();

const artifactReferenceSchema = (
  mediaType:
    | "application/json"
    | "application/vnd.ltx-studio.security-scan-request+json"
    | "application/vnd.ltx-studio.security-scan-result+json",
) =>
  z
    .object({
      path: relativePathSchema,
      sha256: sha256Schema,
      mediaType: z.literal(mediaType),
    })
    .strict();

const boundInputSchema = (path: string) =>
  z
    .object({
      path: z.literal(path),
      sha256: sha256Schema,
    })
    .strict();

const coverageSchema = z
  .object({
    lockComponents: z.number().int().nonnegative(),
    sbomComponents: z.number().int().nonnegative(),
    auditedComponents: z.number().int().nonnegative(),
    omittedComponents: z.literal(0),
  })
  .strict();

const scannerSchema = <TName extends "uv" | "npm", TProvider extends string>(
  name: TName,
  provider: TProvider,
) =>
  z
    .object({
      tool: z
        .object({
          name: z.literal(name),
          version: z.string().min(1).max(128),
          executableSha256: sha256Schema,
        })
        .strict(),
      advisoryProvider: z.literal(provider),
      advisoryCutoffAt: timestampSchema,
      request: artifactReferenceSchema(
        "application/vnd.ltx-studio.security-scan-request+json",
      ),
      response: artifactReferenceSchema("application/json"),
      normalizedResult: artifactReferenceSchema(
        "application/vnd.ltx-studio.security-scan-result+json",
      ),
    })
    .strict();

const emptyEvidenceArraySchema = z.array(z.unknown()).length(0);

export const infrastructureScanScopes = ["build", "host", "container"] as const;

export const infrastructureScanReportSchema = z.object({
  schemaVersion: z.literal("ltx-studio-infrastructure-scan-report.v1"),
  scope: z.enum(infrastructureScanScopes),
  releaseDigest: sha256Schema,
  runtimeTrust: runtimeTrustBindingSchema,
  scanner: z.object({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
    executableSha256: sha256Schema,
    rulesDatabaseSha256: sha256Schema,
    rulesCutoffAt: timestampSchema,
  }).strict(),
  sbomSha256: sha256Schema,
  scannedComponents: z.number().int().positive(),
  omittedComponents: z.literal(0),
  normalizedFindings: emptyEvidenceArraySchema,
  unresolvedFindings: emptyEvidenceArraySchema,
  completedAt: timestampSchema,
  expiresAt: timestampSchema,
  verdict: z.literal("pass"),
}).strict().superRefine((report, context) => {
  if (Date.parse(report.scanner.rulesCutoffAt) > Date.parse(report.completedAt)
    || Date.parse(report.completedAt) >= Date.parse(report.expiresAt)
    || Date.parse(report.completedAt) - Date.parse(report.scanner.rulesCutoffAt) > MAX_SECURITY_AUDIT_AGE_MS
    || Date.parse(report.expiresAt) - Date.parse(report.completedAt) > MAX_SECURITY_AUDIT_AGE_MS) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "infrastructure scan freshness window is invalid" });
  }
});

export const infrastructureScanSignatureSchema = z.object({
  schemaVersion: z.literal("ltx-studio-infrastructure-scan-signature.v1"),
  algorithm: z.literal("ed25519"),
  keyId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/),
  publicKeyBase64: z.string().min(1),
  publicKeySha256: sha256Schema,
  payloadSha256: sha256Schema,
  signatureBase64: z.string().min(1),
}).strict();

export function verifyInfrastructureScanReport(options: {
  document: unknown;
  signature: unknown;
  trustedPublicKeyBase64: string;
  expectedKeyId: string;
  expectedReleaseDigest: string;
  expectedRuntimeTrust: RuntimeTrustBinding;
  auditGeneratedAt: string;
  now: Date;
}): z.infer<typeof infrastructureScanReportSchema> {
  const document = infrastructureScanReportSchema.parse(options.document);
  const signature = infrastructureScanSignatureSchema.parse(options.signature);
  const rawKey = Buffer.from(options.trustedPublicKeyBase64, "base64");
  const rawSignature = Buffer.from(signature.signatureBase64, "base64");
  const payload = Buffer.from(canonicalJson(document));
  const payloadSha256 = createHash("sha256").update(payload).digest("hex");
  const rulesCutoffAt = Date.parse(document.scanner.rulesCutoffAt);
  const completedAt = Date.parse(document.completedAt);
  const auditGeneratedAt = Date.parse(options.auditGeneratedAt);
  const nowMs = options.now.getTime();
  if (rawKey.length !== 32 || rawSignature.length !== 64
    || rawKey.toString("base64") !== options.trustedPublicKeyBase64
    || rawSignature.toString("base64") !== signature.signatureBase64
    || signature.keyId !== options.expectedKeyId
    || signature.publicKeyBase64 !== options.trustedPublicKeyBase64
    || signature.publicKeySha256 !== createHash("sha256").update(rawKey).digest("hex")
    || signature.payloadSha256 !== payloadSha256
    || document.releaseDigest !== options.expectedReleaseDigest
    || canonicalJson(document.runtimeTrust) !== canonicalJson(options.expectedRuntimeTrust)
    || !timestampSchema.safeParse(options.auditGeneratedAt).success
    || rulesCutoffAt > completedAt
    || completedAt > auditGeneratedAt
    || Number.isNaN(nowMs)
    || auditGeneratedAt > nowMs
    || nowMs - rulesCutoffAt < 0
    || nowMs - rulesCutoffAt > MAX_SECURITY_AUDIT_AGE_MS
    || nowMs - completedAt < 0
    || nowMs - completedAt > MAX_SECURITY_AUDIT_AGE_MS
    || nowMs >= Date.parse(document.expiresAt)) {
    throw new SecurityAuditValidationError("infrastructure-scan-binding-invalid", "Signed infrastructure scan report is stale, untrusted, or bound to another release");
  }
  const publicKey = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]),
    format: "der",
    type: "spki",
  });
  if (!verify(null, payload, publicKey, rawSignature)) {
    throw new SecurityAuditValidationError("infrastructure-scan-signature-invalid", "Infrastructure scan Ed25519 signature is invalid");
  }
  return document;
}

const scanRequestSchema = <TEcosystem extends "npm" | "python", TProvider extends string>(
  ecosystem: TEcosystem,
  provider: TProvider,
) =>
  z
    .object({
      schemaVersion: z.literal("ltx-studio-security-scan-request.v1"),
      ecosystem: z.literal(ecosystem),
      advisoryProvider: z.literal(provider),
      releaseDigest: sha256Schema,
      lockSha256: sha256Schema,
      cutoffAt: timestampSchema,
      components: z.array(packageComponentSchema).min(1),
    })
    .strict();

const scanResultSchema = <TEcosystem extends "npm" | "python", TProvider extends string>(
  ecosystem: TEcosystem,
  provider: TProvider,
) =>
  z
    .object({
      schemaVersion: z.literal("ltx-studio-security-scan-result.v1"),
      ecosystem: z.literal(ecosystem),
      advisoryProvider: z.literal(provider),
      advisoryCutoffAt: timestampSchema,
      requestSha256: sha256Schema,
      responseSha256: sha256Schema,
      networkStatus: z.literal("complete"),
      components: z.array(
        packageComponentSchema
          .extend({
            status: z.literal("clear"),
            advisoryIds: z.array(z.string()).length(0),
          })
          .strict(),
      ).min(1),
      normalizedAdvisories: emptyEvidenceArraySchema,
      unresolvedFindings: emptyEvidenceArraySchema,
      adverseStatuses: emptyEvidenceArraySchema,
      verdict: z.literal("pass"),
    })
    .strict();

export const releaseSecurityAuditSchema = z
  .object({
    schemaVersion: z.literal("ltx-studio-security-audit.v4"),
    releaseDigest: sha256Schema,
    runtimeInstallSealSha256: sha256Schema,
    runtimeTreeSha256: sha256Schema,
    runtimePolicySha256: sha256Schema,
    nodeExecutableSha256: sha256Schema,
    runtimeTrust: runtimeTrustBindingSchema,
    manifestQualification: manifestQualificationSchema,
    generatedAt: timestampSchema,
    cutoffAt: timestampSchema,
    expiresAt: timestampSchema,
    boundInputs: z
      .object({
        nodeLock: boundInputSchema(securityAuditInputPaths.nodeLock),
        pythonLock: boundInputSchema(securityAuditInputPaths.pythonLock),
        runtimePyproject: boundInputSchema(
          securityAuditInputPaths.runtimePyproject,
        ),
        runtimeVerifier: boundInputSchema(
          securityAuditInputPaths.runtimeVerifier,
        ),
      })
      .strict(),
    infrastructureScans: z.object({
      build: z.object({
        report: artifactReferenceSchema("application/json"),
        signature: artifactReferenceSchema("application/json"),
        payloadSha256: sha256Schema,
        signerPublicKeySha256: sha256Schema,
      }).strict(),
      host: z.object({
        report: artifactReferenceSchema("application/json"),
        signature: artifactReferenceSchema("application/json"),
        payloadSha256: sha256Schema,
        signerPublicKeySha256: sha256Schema,
      }).strict(),
      container: z.object({
        report: artifactReferenceSchema("application/json"),
        signature: artifactReferenceSchema("application/json"),
        payloadSha256: sha256Schema,
        signerPublicKeySha256: sha256Schema,
      }).strict(),
    }).strict(),
    audits: z
      .object({
        uv: scannerSchema("uv", "osv.dev"),
        npm: scannerSchema("npm", "npm-registry-audit"),
      })
      .strict(),
    coverage: z
      .object({
        node: coverageSchema,
        python: coverageSchema,
        localComponents: z
          .object({
            discoveredComponents: z.number().int().nonnegative(),
            sbomComponents: z.number().int().nonnegative(),
            auditedComponents: z.number().int().nonnegative(),
            omittedComponents: z.literal(0),
          })
          .strict(),
      })
      .strict(),
    sbom: z
      .object({
        schemaVersion: z.literal("ltx-studio-security-sbom.v3"),
        nodeComponents: z.array(packageComponentSchema).min(1),
        pythonComponents: z.array(packageComponentSchema).min(1),
        localComponents: z.array(
          boundLocalComponentSchema
            .extend({
              auditedBy: z.tuple([z.literal("osv.dev")]),
              verdict: z.literal("clear"),
            })
            .strict(),
        ),
        runtimeTcbComponents: z.array(z.unknown()).min(2),
        hostTcbTools: z.array(z.unknown()).min(1),
        hostTcbDockerImages: z.array(z.unknown()).length(3),
        buildTcbComponents: z.array(z.unknown()).min(1),
        hostRuntimeComponents: z.array(z.unknown()).min(1),
        containerRuntimeComponents: z.array(z.unknown()).min(1),
      })
      .strict(),
    packageAliases: z.array(
      z
        .object({
          ecosystem: z.enum(["npm", "python"]),
          alias: packageNameSchema,
          normalizedName: packageNameSchema,
        })
        .strict(),
    ),
    normalizedAdvisories: emptyEvidenceArraySchema,
    unresolvedFindings: emptyEvidenceArraySchema,
    adverseStatuses: emptyEvidenceArraySchema,
    verdict: z.literal("pass"),
  })
  .strict()
  .superRefine((audit, context) => {
    const generatedAt = Date.parse(audit.generatedAt);
    const cutoffAt = Date.parse(audit.cutoffAt);
    const expiresAt = Date.parse(audit.expiresAt);
    if (
      cutoffAt > generatedAt ||
      generatedAt >= expiresAt ||
      generatedAt - cutoffAt > MAX_SECURITY_AUDIT_AGE_MS ||
      expiresAt - generatedAt > MAX_SECURITY_AUDIT_AGE_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["generatedAt"],
        message: "security audit timestamps exceed the 24-hour cutoff window",
      });
    }
    for (const scanner of [audit.audits.uv, audit.audits.npm]) {
      if (scanner.advisoryCutoffAt !== audit.cutoffAt) {
        context.addIssue({
          code: "custom",
          path: ["audits"],
          message: "every advisory provider must bind the common cutoff",
        });
      }
    }
  });

export type ReleaseSecurityAudit = z.infer<typeof releaseSecurityAuditSchema>;

export type ReleaseSecurityAuditBinding = {
  releaseDigest: string;
  runtimeInstallSealSha256: string;
  runtimeTreeSha256: string;
  runtimePolicySha256: string;
  nodeExecutableSha256: string;
  runtimeTrust: RuntimeTrustBinding;
  manifestQualification: z.infer<typeof manifestQualificationSchema>;
  boundInputs: {
    nodeLockSha256: string;
    pythonLockSha256: string;
    runtimePyprojectSha256: string;
    runtimeVerifierSha256: string;
  };
  nodeComponents: Array<{ name: string; version: string }>;
  pythonComponents: Array<{ name: string; version: string }>;
  localComponents: Array<{
    name: string;
    version: string;
    source: {
      kind: "local-path" | "direct-wheel" | "cuda-runtime";
      locator: string;
      sha256: string;
    };
  }>;
  runtimeTcbComponents: unknown[];
  hostTcbTools: unknown[];
  hostTcbDockerImages: unknown[];
  buildTcbComponents: unknown[];
  hostRuntimeComponents: unknown[];
  containerRuntimeComponents: unknown[];
};

export function assertManifestQualificationAuthorizesRelease(
  binding: Pick<ReleaseSecurityAuditBinding, "manifestQualification">,
  context: string,
): void {
  const parsed = manifestQualificationSchema.safeParse(binding.manifestQualification);
  if (!parsed.success) {
    throw new SecurityAuditValidationError(
      "manifest-qualification-invalid",
      `${context} blocked: release manifest qualification is malformed or internally inconsistent`,
    );
  }
  const qualification = parsed.data;
  const blockers = qualification.blockers;
  if (qualification.releaseDecision !== "pass" || blockers.length !== 0) {
    throw new SecurityAuditValidationError(
      "manifest-qualification-hold",
      `${context} blocked by unresolved release-manifest qualification: ${blockers.join(",")}`,
    );
  }
}

export type SecurityAuditArtifactReader = (path: string) => Uint8Array;

export class SecurityAuditValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SecurityAuditValidationError";
    this.code = code;
  }
}

function canonicalComponents(
  components: ReadonlyArray<{ name: string; version: string }>,
): string {
  return JSON.stringify(
    [...components]
      .map(({ name, version }) => ({ name, version }))
      .sort((left, right) => {
        const leftKey = `${left.name}\u0000${left.version}`;
        const rightKey = `${right.name}\u0000${right.version}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  );
}

function canonicalLocalComponents(
  components: ReadonlyArray<{
    name: string;
    version: string;
    source: { kind: string; locator: string; sha256: string };
  }>,
): string {
  return JSON.stringify(
    [...components]
      .map(({ name, version, source }) => ({ name, version, source }))
      .sort((left, right) => {
        const leftKey = `${left.name}\u0000${left.version}`;
        const rightKey = `${right.name}\u0000${right.version}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
  );
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function infrastructureSbomBinding(
  audit: ReleaseSecurityAudit,
  scope: typeof infrastructureScanScopes[number],
): { sha256: string; componentCount: number } {
  const components = scope === "build"
    ? audit.sbom.buildTcbComponents
    : scope === "host"
      ? [...audit.sbom.hostTcbTools, ...audit.sbom.hostRuntimeComponents]
      : [...audit.sbom.hostTcbDockerImages, ...audit.sbom.containerRuntimeComponents];
  const document = {
    schemaVersion: "ltx-studio-infrastructure-sbom.v1",
    scope,
    components,
  };
  return {
    sha256: sha256Bytes(Buffer.from(canonicalJson(document))),
    componentCount: components.length,
  };
}

function readSecurityArtifact(
  reference: { path: string; sha256: string },
  readArtifact: SecurityAuditArtifactReader,
  context: string,
  requireCanonical: boolean,
): unknown {
  let bytes: Uint8Array;
  try {
    bytes = readArtifact(reference.path);
  } catch (error) {
    throw new SecurityAuditValidationError(
      "security-audit-artifact-missing",
      `${context} is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_SECURITY_ARTIFACT_BYTES
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-artifact-invalid",
      `${context} has an invalid size`,
    );
  }
  if (sha256Bytes(bytes) !== reference.sha256) {
    throw new SecurityAuditValidationError(
      "security-audit-artifact-digest-mismatch",
      `${context} does not match its signed SHA-256`,
    );
  }
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) {
    throw new SecurityAuditValidationError(
      "security-audit-artifact-invalid",
      `${context} is not valid UTF-8`,
    );
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new SecurityAuditValidationError(
      "security-audit-artifact-invalid",
      `${context} is not valid JSON`,
    );
  }
  if (requireCanonical && canonicalJson(document) !== text) {
    throw new SecurityAuditValidationError(
      "security-audit-artifact-invalid",
      `${context} is not canonical JSON`,
    );
  }
  return document;
}

function assertUniqueComponents(
  components: ReadonlyArray<{ name: string; version: string }>,
  context: string,
): void {
  const identities = components.map(({ name, version }) => `${name}\u0000${version}`);
  if (new Set(identities).size !== identities.length) {
    throw new SecurityAuditValidationError(
      "security-audit-coverage-invalid",
      `${context} contains duplicate component identities`,
    );
  }
}

function artifactSha256(manifest: Record<string, unknown>, path: string): string {
  const artifacts = manifest.artifacts;
  if (!Array.isArray(artifacts)) {
    throw new SecurityAuditValidationError(
      "security-audit-release-binding-invalid",
      "Release manifest has no artifact inventory",
    );
  }
  const artifact = artifacts.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      "path" in candidate &&
      candidate.path === path &&
      "type" in candidate &&
      candidate.type === "file",
  );
  if (
    !artifact ||
    !("sha256" in artifact) ||
    typeof artifact.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(artifact.sha256)
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-release-binding-invalid",
      `Release manifest lacks a digest-bound file artifact: ${path}`,
    );
  }
  return artifact.sha256;
}

function assertReleaseLocalComponentSources(
  manifest: Record<string, unknown>,
  pythonComponents: ReadonlyArray<{ name: string; version: string }>,
  localComponents: ReleaseSecurityAuditBinding["localComponents"],
): void {
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  for (const component of localComponents) {
    if (component.source.kind !== "local-path") continue;
    const locator = relativePathSchema.safeParse(component.source.locator);
    if (!locator.success) {
      throw new SecurityAuditValidationError(
        "security-audit-release-binding-invalid",
        `Local runtime component has an invalid release path: ${component.name}`,
      );
    }
    const prefix = `${locator.data}/`;
    const sourceArtifacts = artifacts
      .filter(
        (artifact) =>
          artifact !== null &&
          typeof artifact === "object" &&
          "path" in artifact &&
          typeof artifact.path === "string" &&
          (artifact.path === locator.data || artifact.path.startsWith(prefix)),
      )
      .sort((left, right) => {
        const leftPath = (left as { path: string }).path;
        const rightPath = (right as { path: string }).path;
        return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
      });
    if (
      sourceArtifacts.length === 0 ||
      sha256Bytes(Buffer.from(canonicalJson(sourceArtifacts))) !==
        component.source.sha256
    ) {
      throw new SecurityAuditValidationError(
        "security-audit-release-binding-invalid",
        `Local runtime component tree digest is missing or invalid: ${component.name}`,
      );
    }
  }

  const isCudaRuntime = ({ name }: { name: string }) =>
    name.startsWith("nvidia-") ||
    name.startsWith("cuda-") ||
    name === "triton";
  const expectedCudaComponents = pythonComponents.filter(isCudaRuntime);
  const observedCudaComponents = localComponents.filter(
    ({ source }) => source.kind === "cuda-runtime",
  );
  if (
    canonicalComponents(expectedCudaComponents) !==
    canonicalComponents(observedCudaComponents)
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-release-binding-invalid",
      "Release local inventory does not exactly classify every installed CUDA runtime component",
    );
  }
}

export function securityAuditBindingFromReleaseManifest(
  rawManifest: unknown,
  releaseDigest: string,
  verifiedRuntimeIdentity: {
    runtimeInstallSealSha256: string;
    runtimeTreeSha256: string;
    runtimePolicySha256: string;
    nodeExecutableSha256: string;
    runtimeTrust: RuntimeTrustBinding;
  },
): ReleaseSecurityAuditBinding {
  if (
    rawManifest === null ||
    typeof rawManifest !== "object" ||
    !/^[0-9a-f]{64}$/.test(releaseDigest)
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-release-binding-invalid",
      "Release manifest or digest is invalid",
    );
  }
  const manifest = rawManifest as Record<string, unknown>;
  const locks = manifest.locks;
  const sbom = manifest.sbom;
  const runtimeInstallIntegrity = manifest.runtimeInstallIntegrity;
  const manifestQualification = manifest.qualification;
  if (
    locks === null ||
    typeof locks !== "object" ||
    sbom === null ||
    typeof sbom !== "object"
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-release-binding-invalid",
      "Release manifest lacks lock or SBOM bindings",
    );
  }
  const lockRecord = locks as Record<string, unknown>;
  const sbomRecord = sbom as Record<string, unknown>;
  const runtimeIntegrityRecord =
    runtimeInstallIntegrity !== null && typeof runtimeInstallIntegrity === "object"
      ? (runtimeInstallIntegrity as Record<string, unknown>)
      : {};
  const qualificationRecord = manifestQualification !== null
    && typeof manifestQualification === "object"
    ? manifestQualification as Record<string, unknown>
    : {};
  const toolsRecord = manifest.tools !== null && typeof manifest.tools === "object"
    ? manifest.tools as Record<string, unknown>
    : {};
  const nodeToolRecord = toolsRecord.node !== null && typeof toolsRecord.node === "object"
    ? toolsRecord.node as Record<string, unknown>
    : {};
  if (
    runtimeIntegrityRecord.schemaVersion !==
      "ltx-studio-runtime-install-integrity.v3" ||
    runtimeIntegrityRecord.status !== "seal-required" ||
    runtimeIntegrityRecord.treeAlgorithm !==
      "ltx-studio-canonical-runtime-tree-sha256.v3" ||
    runtimeIntegrityRecord.canonicalization !==
      "ltx-studio-canonical-json.v1" ||
    runtimeIntegrityRecord.runtimeRoot !==
      "apps/ltx-studio/runtime/.venv" ||
    runtimeIntegrityRecord.sealPath !==
      "apps/ltx-studio/runtime/runtime-install-seal.json" ||
    !verifiedRuntimeIdentity
    || ![
      verifiedRuntimeIdentity.runtimeInstallSealSha256,
      verifiedRuntimeIdentity.runtimeTreeSha256,
      verifiedRuntimeIdentity.runtimePolicySha256,
      verifiedRuntimeIdentity.nodeExecutableSha256,
      verifiedRuntimeIdentity.runtimeTrust.hostTcbAttestationSha256,
      verifiedRuntimeIdentity.runtimeTrust.hostTcbContractSha256,
      verifiedRuntimeIdentity.runtimeTrust.servicePolicySha256,
      verifiedRuntimeIdentity.runtimeTrust.buildTcbSha256,
    ].every((value) => /^[0-9a-f]{64}$/.test(value))
    || nodeToolRecord.sha256 !== verifiedRuntimeIdentity.nodeExecutableSha256
    || sha256Bytes(Buffer.from(canonicalJson(manifest.hostTcb))) !== verifiedRuntimeIdentity.runtimeTrust.hostTcbContractSha256
    || (manifest.buildTcb as { sha256?: unknown } | undefined)?.sha256 !== verifiedRuntimeIdentity.runtimeTrust.buildTcbSha256
    || sha256Bytes(Buffer.from(canonicalJson(runtimeIntegrityRecord))) !== verifiedRuntimeIdentity.runtimePolicySha256
  ) {
    throw new SecurityAuditValidationError(
      "runtime-install-seal-missing",
      "Release runtime is not protected by a digest-bound installed-runtime integrity seal",
    );
  }
  const nodeLockSha256 = sha256Schema.parse(lockRecord.node);
  const pythonLockSha256 = sha256Schema.parse(lockRecord.python);
  const nodeComponents = z
    .array(packageComponentSchema)
    .min(1)
    .parse(sbomRecord.nodeComponents);
  const pythonComponents = z
    .array(packageComponentSchema)
    .min(1)
    .parse(sbomRecord.pythonComponents);
  const localComponents = z
    .array(boundLocalComponentSchema)
    .parse(sbomRecord.localComponents);
  if (sbomRecord.schemaVersion !== "ltx-studio-static-sbom.v3") {
    throw new SecurityAuditValidationError(
      "security-audit-release-binding-invalid",
      "Release SBOM schema does not include the production TCB",
    );
  }
  const runtimeTcbComponents = z.array(z.unknown()).min(2)
    .parse(sbomRecord.runtimeTcbComponents);
  const hostTcbTools = z.array(z.unknown()).min(1)
    .parse(sbomRecord.hostTcbTools);
  const hostTcbDockerImages = z.array(z.unknown()).length(3)
    .parse(sbomRecord.hostTcbDockerImages);
  const buildTcbComponents = z.array(z.unknown()).min(1)
    .parse(sbomRecord.buildTcbComponents);
  const hostRuntimeComponents = z.array(z.unknown()).min(1)
    .parse(sbomRecord.hostRuntimeComponents);
  const containerRuntimeComponents = z.array(z.unknown()).min(1)
    .parse(sbomRecord.containerRuntimeComponents);
  const qualification = manifestQualificationSchema.parse(qualificationRecord);
  assertUniqueComponents(nodeComponents, "Release Node SBOM");
  assertUniqueComponents(pythonComponents, "Release Python SBOM");
  assertUniqueComponents(localComponents, "Release local SBOM");
  assertReleaseLocalComponentSources(
    manifest,
    pythonComponents,
    localComponents,
  );
  if (
    artifactSha256(manifest, securityAuditInputPaths.nodeLock) !== nodeLockSha256 ||
    artifactSha256(manifest, securityAuditInputPaths.pythonLock) !== pythonLockSha256
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-release-binding-invalid",
      "Release lock digests disagree with the artifact inventory",
    );
  }
  return {
    releaseDigest,
    ...verifiedRuntimeIdentity,
    manifestQualification: qualification,
    boundInputs: {
      nodeLockSha256,
      pythonLockSha256,
      runtimePyprojectSha256: artifactSha256(
        manifest,
        securityAuditInputPaths.runtimePyproject,
      ),
      runtimeVerifierSha256: artifactSha256(
        manifest,
        securityAuditInputPaths.runtimeVerifier,
      ),
    },
    nodeComponents,
    pythonComponents,
    localComponents,
    runtimeTcbComponents,
    hostTcbTools,
    hostTcbDockerImages,
    buildTcbComponents,
    hostRuntimeComponents,
    containerRuntimeComponents,
  };
}

function validateReleaseSecurityAuditInternal(
  rawAudit: unknown,
  binding: ReleaseSecurityAuditBinding,
  now: Date,
  readArtifact: SecurityAuditArtifactReader,
  requireManifestPass: boolean,
): ReleaseSecurityAudit {
  if (Number.isNaN(now.getTime())) {
    throw new SecurityAuditValidationError(
      "security-audit-time-invalid",
      "Security audit verification time is invalid",
    );
  }
  const verificationContext = requireManifestPass
    ? "Security GO"
    : "Security evidence validation";
  try {
    assertRuntimeTrustAuthorizesRelease(binding.runtimeTrust, verificationContext);
  } catch (error) {
    throw new SecurityAuditValidationError(
      "runtime-authority-isolation-hold",
      error instanceof Error
        ? error.message
        : `${verificationContext} authority isolation is not attested`,
    );
  }
  if (requireManifestPass) {
    assertManifestQualificationAuthorizesRelease(binding, "Security GO");
  }
  if (rawAudit !== null && typeof rawAudit === "object") {
    const schemaVersion = (rawAudit as { schemaVersion?: unknown }).schemaVersion;
    if (schemaVersion === "ltx-m2-security-runtime-report.v1") {
      throw new SecurityAuditValidationError(
        "stale-security-audit",
        "Historical M2 security evidence is stale and cannot authorize a release",
      );
    }
    if (schemaVersion !== "ltx-studio-security-audit.v4") {
      throw new SecurityAuditValidationError(
        "security-audit-schema-unknown",
        "Unknown security audit schema",
      );
    }
  }
  const parsed = releaseSecurityAuditSchema.safeParse(rawAudit);
  if (!parsed.success) {
    throw new SecurityAuditValidationError(
      "security-audit-invalid",
      parsed.error.issues[0]?.message ?? "Security audit schema rejected",
    );
  }
  const audit = parsed.data;
  const generatedAt = Date.parse(audit.generatedAt);
  const cutoffAt = Date.parse(audit.cutoffAt);
  const expiresAt = Date.parse(audit.expiresAt);
  if (generatedAt > now.getTime() || cutoffAt > now.getTime()) {
    throw new SecurityAuditValidationError(
      "security-audit-from-future",
      "Security audit timestamps are in the future",
    );
  }
  if (
    now.getTime() >= expiresAt ||
    now.getTime() - generatedAt > MAX_SECURITY_AUDIT_AGE_MS ||
    now.getTime() - cutoffAt > MAX_SECURITY_AUDIT_AGE_MS
  ) {
    throw new SecurityAuditValidationError(
      "stale-security-audit",
      "Security audit or advisory cutoff is older than 24 hours",
    );
  }
  const expectedInputs = binding.boundInputs;
  if (
    audit.releaseDigest !== binding.releaseDigest ||
    audit.runtimeInstallSealSha256 !== binding.runtimeInstallSealSha256 ||
    audit.runtimeTreeSha256 !== binding.runtimeTreeSha256 ||
    audit.runtimePolicySha256 !== binding.runtimePolicySha256 ||
    audit.nodeExecutableSha256 !== binding.nodeExecutableSha256 ||
    canonicalJson(audit.runtimeTrust) !== canonicalJson(binding.runtimeTrust) ||
    canonicalJson(audit.manifestQualification) !== canonicalJson(binding.manifestQualification) ||
    audit.boundInputs.nodeLock.sha256 !== expectedInputs.nodeLockSha256 ||
    audit.boundInputs.pythonLock.sha256 !== expectedInputs.pythonLockSha256 ||
    audit.boundInputs.runtimePyproject.sha256 !==
      expectedInputs.runtimePyprojectSha256 ||
    audit.boundInputs.runtimeVerifier.sha256 !==
      expectedInputs.runtimeVerifierSha256
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-release-binding-mismatch",
      "Security audit is bound to different release inputs",
    );
  }
  assertUniqueComponents(audit.sbom.nodeComponents, "Security Node SBOM");
  assertUniqueComponents(audit.sbom.pythonComponents, "Security Python SBOM");
  assertUniqueComponents(audit.sbom.localComponents, "Security local SBOM");
  if (
    canonicalComponents(audit.sbom.nodeComponents) !==
      canonicalComponents(binding.nodeComponents) ||
    canonicalComponents(audit.sbom.pythonComponents) !==
      canonicalComponents(binding.pythonComponents)
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-sbom-mismatch",
      "Security SBOM does not exactly match the final release SBOM",
    );
  }
  if (
    canonicalLocalComponents(audit.sbom.localComponents) !==
    canonicalLocalComponents(binding.localComponents)
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-local-sbom-mismatch",
      "Security local/path/direct-wheel/CUDA SBOM does not exactly match the final release inventory",
    );
  }
  if (canonicalJson(audit.sbom.runtimeTcbComponents) !== canonicalJson(binding.runtimeTcbComponents)
    || canonicalJson(audit.sbom.hostTcbTools) !== canonicalJson(binding.hostTcbTools)
    || canonicalJson(audit.sbom.hostTcbDockerImages) !== canonicalJson(binding.hostTcbDockerImages)
    || canonicalJson(audit.sbom.buildTcbComponents) !== canonicalJson(binding.buildTcbComponents)
    || canonicalJson(audit.sbom.hostRuntimeComponents) !== canonicalJson(binding.hostRuntimeComponents)
    || canonicalJson(audit.sbom.containerRuntimeComponents) !== canonicalJson(binding.containerRuntimeComponents)) {
    throw new SecurityAuditValidationError(
      "security-audit-tcb-sbom-mismatch",
      "Security audit does not exactly bind the Node/uv/host-tool/Docker production TCB",
    );
  }
  const pythonIdentities = new Set(
    audit.sbom.pythonComponents.map(({ name, version }) => `${name}\u0000${version}`),
  );
  if (
    audit.sbom.localComponents.some(
      ({ name, version }) => !pythonIdentities.has(`${name}\u0000${version}`),
    )
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-local-sbom-mismatch",
      "Local/path/CUDA SBOM entries must be present in the release Python SBOM",
    );
  }
  if (
    audit.sbom.localComponents.some(
      ({ auditedBy }) => !auditedBy.includes("osv.dev"),
    )
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-local-coverage-invalid",
      "Every local/path/CUDA component must be covered by the Python advisory provider",
    );
  }
  const artifactPaths = [
    audit.audits.uv.request.path,
    audit.audits.uv.response.path,
    audit.audits.uv.normalizedResult.path,
    audit.audits.npm.request.path,
    audit.audits.npm.response.path,
    audit.audits.npm.normalizedResult.path,
    ...Object.values(audit.infrastructureScans).flatMap(({ report, signature }) => [report.path, signature.path]),
  ];
  if (new Set(artifactPaths).size !== artifactPaths.length) {
    throw new SecurityAuditValidationError(
      "security-audit-artifact-invalid",
      "Every scanner request, response, and normalized result must use a distinct evidence path",
    );
  }

  for (const [scope, scan] of Object.entries(audit.infrastructureScans)) {
    const typedScope = scope as typeof infrastructureScanScopes[number];
    const report = readSecurityArtifact(scan.report, readArtifact, `${scope} infrastructure scan report`, true);
    const signature = readSecurityArtifact(scan.signature, readArtifact, `${scope} infrastructure scan signature`, true);
    const parsedReport = infrastructureScanReportSchema.safeParse(report);
    const parsedSignature = infrastructureScanSignatureSchema.safeParse(signature);
    const rawPublicKey = parsedSignature.success
      ? Buffer.from(parsedSignature.data.publicKeyBase64, "base64")
      : Buffer.alloc(0);
    const rawSignature = parsedSignature.success
      ? Buffer.from(parsedSignature.data.signatureBase64, "base64")
      : Buffer.alloc(0);
    const payloadBytes = parsedReport.success
      ? Buffer.from(canonicalJson(parsedReport.data))
      : Buffer.alloc(0);
    const expectedSbom = infrastructureSbomBinding(audit, typedScope);
    let signatureValid = false;
    if (rawPublicKey.length === 32 && rawSignature.length === 64
      && parsedSignature.success
      && rawPublicKey.toString("base64") === parsedSignature.data.publicKeyBase64
      && rawSignature.toString("base64") === parsedSignature.data.signatureBase64) {
      const publicKey = createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawPublicKey]),
        format: "der",
        type: "spki",
      });
      signatureValid = verify(null, payloadBytes, publicKey, rawSignature);
    }
    if (!parsedReport.success || !parsedSignature.success
      || parsedReport.data.scope !== scope
      || parsedReport.data.releaseDigest !== binding.releaseDigest
      || canonicalJson(parsedReport.data.runtimeTrust) !== canonicalJson(binding.runtimeTrust)
      || parsedReport.data.sbomSha256 !== expectedSbom.sha256
      || parsedReport.data.scannedComponents !== expectedSbom.componentCount
      || Date.parse(parsedReport.data.scanner.rulesCutoffAt)
        > Date.parse(parsedReport.data.completedAt)
      || Date.parse(parsedReport.data.completedAt) > Date.parse(audit.generatedAt)
      || Date.parse(audit.generatedAt) > now.getTime()
      || now.getTime() - Date.parse(parsedReport.data.scanner.rulesCutoffAt) < 0
      || now.getTime() - Date.parse(parsedReport.data.scanner.rulesCutoffAt)
        > MAX_SECURITY_AUDIT_AGE_MS
      || now.getTime() - Date.parse(parsedReport.data.completedAt) < 0
      || now.getTime() - Date.parse(parsedReport.data.completedAt)
        > MAX_SECURITY_AUDIT_AGE_MS
      || now.getTime() >= Date.parse(parsedReport.data.expiresAt)
      || parsedSignature.data.payloadSha256 !== scan.payloadSha256
      || scan.payloadSha256 !== sha256Bytes(payloadBytes)
      || parsedSignature.data.publicKeySha256 !== scan.signerPublicKeySha256
      || scan.signerPublicKeySha256 !== sha256Bytes(rawPublicKey)
      || !signatureValid) {
      throw new SecurityAuditValidationError(
        "infrastructure-scan-binding-invalid",
        `${scope} infrastructure scan is absent, unsigned, stale, or bound to another release`,
      );
    }
  }

  const validateScanner = (
    ecosystem: "npm" | "python",
    provider: "npm-registry-audit" | "osv.dev",
    scanner: typeof audit.audits.npm | typeof audit.audits.uv,
    expectedComponents: ReadonlyArray<{ name: string; version: string }>,
    expectedLockSha256: string,
  ): number => {
    const requestDocument = readSecurityArtifact(
      scanner.request,
      readArtifact,
      `${ecosystem} scanner request`,
      true,
    );
    const responseDocument = readSecurityArtifact(
      scanner.response,
      readArtifact,
      `${ecosystem} scanner response`,
      false,
    );
    const normalizedDocument = readSecurityArtifact(
      scanner.normalizedResult,
      readArtifact,
      `${ecosystem} normalized scanner result`,
      true,
    );
    if (responseDocument === null || typeof responseDocument !== "object") {
      throw new SecurityAuditValidationError(
        "security-audit-artifact-invalid",
        `${ecosystem} scanner response must be a JSON object or array`,
      );
    }
    const responseRecord = responseDocument as Record<string, unknown>;
    if (ecosystem === "python") {
      const results = responseRecord.results;
      const resultsAreClear = !("error" in responseRecord) &&
        Array.isArray(results) &&
        results.length === expectedComponents.length &&
        results.every((result) => {
          if (result === null || typeof result !== "object") return false;
          const vulnerabilities = (result as Record<string, unknown>).vulns;
          return vulnerabilities === undefined ||
            (Array.isArray(vulnerabilities) && vulnerabilities.length === 0);
        });
      if (!resultsAreClear) {
        throw new SecurityAuditValidationError(
          "security-audit-provider-response-adverse",
          "OSV response is malformed, incomplete, or contains vulnerabilities",
        );
      }
    } else {
      const auditReportVersion = responseRecord.auditReportVersion;
      const vulnerabilities = responseRecord.vulnerabilities;
      const metadata = responseRecord.metadata;
      const vulnerabilityCounts =
        metadata !== null && typeof metadata === "object"
          ? (metadata as Record<string, unknown>).vulnerabilities
          : undefined;
      const total =
        vulnerabilityCounts !== null && typeof vulnerabilityCounts === "object"
          ? (vulnerabilityCounts as Record<string, unknown>).total
          : undefined;
      if (
        auditReportVersion !== 2 ||
        "error" in responseRecord ||
        vulnerabilities === null ||
        typeof vulnerabilities !== "object" ||
        Array.isArray(vulnerabilities) ||
        Object.keys(vulnerabilities as Record<string, unknown>).length !== 0 ||
        total !== 0
      ) {
        throw new SecurityAuditValidationError(
          "security-audit-provider-response-adverse",
          "npm audit response is malformed, incomplete, or contains vulnerabilities",
        );
      }
    }
    const request = scanRequestSchema(ecosystem, provider).safeParse(requestDocument);
    if (!request.success) {
      throw new SecurityAuditValidationError(
        "security-audit-request-invalid",
        request.error.issues[0]?.message ?? `${ecosystem} scan request rejected`,
      );
    }
    const normalized = scanResultSchema(ecosystem, provider).safeParse(
      normalizedDocument,
    );
    if (!normalized.success) {
      throw new SecurityAuditValidationError(
        "security-audit-result-invalid",
        normalized.error.issues[0]?.message ?? `${ecosystem} normalized result rejected`,
      );
    }
    assertUniqueComponents(request.data.components, `${ecosystem} scan request`);
    assertUniqueComponents(normalized.data.components, `${ecosystem} scan result`);
    if (
      request.data.releaseDigest !== binding.releaseDigest ||
      request.data.lockSha256 !== expectedLockSha256 ||
      request.data.cutoffAt !== audit.cutoffAt ||
      scanner.advisoryCutoffAt !== audit.cutoffAt ||
      normalized.data.advisoryCutoffAt !== audit.cutoffAt ||
      normalized.data.requestSha256 !== scanner.request.sha256 ||
      normalized.data.responseSha256 !== scanner.response.sha256 ||
      canonicalComponents(request.data.components) !==
        canonicalComponents(expectedComponents) ||
      canonicalComponents(normalized.data.components) !==
        canonicalComponents(expectedComponents)
    ) {
      throw new SecurityAuditValidationError(
        "security-audit-scan-binding-mismatch",
        `${ecosystem} scanner evidence does not exactly bind the release, lock, cutoff, request, response, and component set`,
      );
    }
    return normalized.data.components.length;
  };

  const auditedNodeCount = validateScanner(
    "npm",
    "npm-registry-audit",
    audit.audits.npm,
    binding.nodeComponents,
    expectedInputs.nodeLockSha256,
  );
  const auditedPythonCount = validateScanner(
    "python",
    "osv.dev",
    audit.audits.uv,
    binding.pythonComponents,
    expectedInputs.pythonLockSha256,
  );
  const nodeCount = audit.sbom.nodeComponents.length;
  const pythonCount = audit.sbom.pythonComponents.length;
  const localCount = audit.sbom.localComponents.length;
  if (
    audit.coverage.node.lockComponents !== nodeCount ||
    audit.coverage.node.sbomComponents !== nodeCount ||
    audit.coverage.node.auditedComponents !== nodeCount ||
    audit.coverage.python.lockComponents !== pythonCount ||
    audit.coverage.python.sbomComponents !== pythonCount ||
    audit.coverage.python.auditedComponents !== pythonCount ||
    audit.coverage.localComponents.discoveredComponents !== localCount ||
    audit.coverage.localComponents.sbomComponents !== localCount ||
    audit.coverage.localComponents.auditedComponents !== localCount ||
    auditedNodeCount !== nodeCount ||
    auditedPythonCount !== pythonCount
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-coverage-invalid",
      "Security audit coverage does not exactly match every final SBOM component",
    );
  }
  const aliases = audit.packageAliases.map(
    ({ ecosystem, alias }) => `${ecosystem}\u0000${alias}`,
  );
  if (new Set(aliases).size !== aliases.length) {
    throw new SecurityAuditValidationError(
      "security-audit-aliases-invalid",
      "Security audit package aliases are not unique",
    );
  }
  const componentNames = {
    npm: new Set(audit.sbom.nodeComponents.map(({ name }) => name)),
    python: new Set(audit.sbom.pythonComponents.map(({ name }) => name)),
  };
  if (
    audit.packageAliases.some(
      ({ ecosystem, normalizedName }) =>
        !componentNames[ecosystem].has(normalizedName),
    )
  ) {
    throw new SecurityAuditValidationError(
      "security-audit-aliases-invalid",
      "Every normalized package alias must resolve to a final SBOM component",
    );
  }
  return audit;
}

/**
 * Product-GO security verification.  Immutable manifest HOLD remains a hard
 * failure here; only the staged evidence verifier below may inspect the same
 * signed audit while a separately signed qualification resolution is pending.
 */
export function validateReleaseSecurityAudit(
  rawAudit: unknown,
  binding: ReleaseSecurityAuditBinding,
  now: Date,
  readArtifact: SecurityAuditArtifactReader,
): ReleaseSecurityAudit {
  return validateReleaseSecurityAuditInternal(rawAudit, binding, now, readArtifact, true);
}

/**
 * Staged, evidence-only validation.  This performs the complete runtime,
 * schema, release-binding, signed infrastructure, scanner, freshness and SBOM
 * verification, but deliberately emits no GO and does not discharge the
 * immutable manifest HOLD by itself.
 */
export function validateReleaseSecurityAuditEvidence(
  rawAudit: unknown,
  binding: ReleaseSecurityAuditBinding,
  now: Date,
  readArtifact: SecurityAuditArtifactReader,
): ReleaseSecurityAudit {
  return validateReleaseSecurityAuditInternal(rawAudit, binding, now, readArtifact, false);
}
