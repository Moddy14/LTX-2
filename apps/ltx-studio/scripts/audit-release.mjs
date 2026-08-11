import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  releaseArtifacts,
  sha256Bytes,
  sha256File,
} from "./release-manifest-lib.mjs";

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if ((!value || value.startsWith("--")) && required)
    throw new Error(`${name} requires a value`);
  return value;
}

const expectedReleaseDigest = argument("--release");
const releaseRoot = resolve(
  argument("--release-root", false) ??
    `/opt/ltx-studio/releases/${expectedReleaseDigest}`,
);
const evidenceRoot = resolve(argument("--evidence-root"));
const outputPath = resolve(
  argument("--output", false) ?? join(evidenceRoot, "release-evidence.v1.json"),
);
if (dirname(outputPath) !== evidenceRoot)
  throw new Error("Audit output must be a direct child of the evidence root");
const evidenceRootMetadata = lstatSync(evidenceRoot);
if (
  !evidenceRootMetadata.isDirectory() ||
  evidenceRootMetadata.isSymbolicLink() ||
  (evidenceRootMetadata.mode & 0o022) !== 0
) {
  throw new Error(
    "Evidence root must be a real directory without group/world write access",
  );
}
const realEvidenceRoot = realpathSync(evidenceRoot);

const manifestPath = join(releaseRoot, "release-manifest.json");
const manifestBytes = readFileSync(manifestPath);
const releaseDigest = sha256Bytes(manifestBytes);
if (releaseDigest !== expectedReleaseDigest)
  throw new Error("Release manifest digest does not match --release");
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (
  manifest.schemaVersion !== "ltx-studio-release-manifest.v1" ||
  canonicalJson(manifest) !== manifestBytes.toString("utf8")
) {
  throw new Error("Release manifest is not a canonical supported manifest");
}
if (
  canonicalJson(releaseArtifacts(releaseRoot)) !==
  canonicalJson(manifest.artifacts)
) {
  throw new Error("Release artifact drift detected before audit");
}
const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");
const auditModule = await import(
  pathToFileURL(join(releaseAppRoot, "shared", "releaseAudit.js"))
);
const surface = JSON.parse(
  readFileSync(join(releaseRoot, manifest.surface.path), "utf8"),
);
function safeEvidencePath(path) {
  const resolved = resolve(evidenceRoot, path);
  if (!resolved.startsWith(`${evidenceRoot}${sep}`))
    throw new Error(`Evidence path escapes root: ${path}`);
  return resolved;
}

function readEvidenceBytes(path) {
  const absolute = safeEvidencePath(path);
  const metadata = lstatSync(absolute);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0 ||
    metadata.size > MAX_EVIDENCE_BYTES
  ) {
    throw new Error(
      `Evidence must be a bounded regular file without group/world write access: ${path}`,
    );
  }
  const real = realpathSync(absolute);
  if (!real.startsWith(`${realEvidenceRoot}${sep}`))
    throw new Error(`Evidence path escapes real root: ${path}`);
  const descriptor = openSync(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      throw new Error(`Evidence changed while opening: ${path}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function readJson(path) {
  const bytes = readEvidenceBytes(path);
  const document = JSON.parse(bytes.toString("utf8"));
  if (canonicalJson(document) !== bytes.toString("utf8"))
    throw new Error(`Evidence is not canonical JSON: ${path}`);
  return { bytes, document };
}

const index = auditModule.releaseEvidenceIndexSchema.parse(
  readJson("evidence-index.v1.json").document,
);

function readReference(reference) {
  const document = readJson(reference.path);
  const signature = readJson(reference.signaturePath);
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

const trustPolicyFile = readJson(index.trustPolicy.path);
if (sha256Bytes(trustPolicyFile.bytes) !== index.trustPolicy.sha256)
  throw new Error("Trusted-key policy file digest mismatch");
const trustPolicy = trustPolicyFile.document;
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
  trustPolicy,
  preregistration,
  rightsAttestation,
  reports,
  trustPolicyDigest: index.trustPolicy.sha256,
});
writeFileSync(outputPath, canonicalJson(evidence), {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  `${JSON.stringify({
    releaseDigest,
    evidenceDigest: sha256File(outputPath),
    readyForReleaseAuthorization: true,
    output: outputPath,
  })}\n`,
);
