import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  parseCanonicalDigestFile,
  DIGEST_NAME,
  MANIFEST_NAME,
  productionTcbLicenses,
  releaseArtifacts,
  sha256Bytes,
  sha256File,
} from "./release-manifest-lib.mjs";
import { verifyRuntimeInstallSeal } from "./runtime-install-seal-lib.mjs";
import { verifyHostTcbContract } from "./host-tcb-lib.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const rootIndex = process.argv.indexOf("--root");
const rootArgument = rootIndex === -1 ? undefined : process.argv[rootIndex + 1];
if (rootIndex !== -1 && (!rootArgument || rootArgument.startsWith("--"))) {
  throw new Error("--root requires a path");
}
const releaseRoot = rootArgument
  ? resolve(process.cwd(), rootArgument)
  : resolve(appRoot, "build", "release-root");
const staticOnly = process.argv.includes("--static-only");
const requireRootOwnedReadOnly = process.argv.includes("--require-root-owned-read-only");
if (staticOnly && requireRootOwnedReadOnly) {
  throw new Error("--require-root-owned-read-only cannot be combined with --static-only");
}
const manifestBytes = readFileSync(join(releaseRoot, MANIFEST_NAME));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.schemaVersion !== "ltx-studio-release-manifest.v4") {
  throw new Error("Unsupported release manifest schema");
}
if (canonicalJson(manifest) !== manifestBytes.toString("utf8")) {
  throw new Error("Release manifest is not canonically serialized");
}
const expectedDigest = parseCanonicalDigestFile(readFileSync(join(releaseRoot, DIGEST_NAME), "utf8"));
const actualDigest = sha256Bytes(manifestBytes);
if (expectedDigest !== actualDigest) throw new Error("Release manifest digest mismatch");

const actualArtifacts = releaseArtifacts(releaseRoot);
if (canonicalJson(actualArtifacts) !== canonicalJson(manifest.artifacts)) {
  throw new Error("Release artifact drift detected");
}
const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");
const expectedSurfacePath = "apps/ltx-studio/release/candidate-release-surface.v1.json";
const expectedRightsPath = "apps/ltx-studio/release/rights-evidence.v1.json";
const expectedBuildTcbPath = "apps/ltx-studio/release/build-tcb.v1.json";
if (manifest.surface?.path !== expectedSurfacePath
  || manifest.rights?.evidenceCatalog?.path !== expectedRightsPath
  || manifest.buildTcb?.path !== expectedBuildTcbPath
  || !/^[0-9a-f]{64}$/.test(manifest.buildTcb?.sha256 ?? "")
  || !/^[0-9a-f]{64}$/.test(manifest.buildTcb?.externalPolicySha256 ?? "")) {
  throw new Error("Release governance artifact path mismatch");
}
const surfacePath = join(releaseRoot, expectedSurfacePath);
const rightsPath = join(releaseRoot, expectedRightsPath);
const buildTcbPath = join(releaseRoot, expectedBuildTcbPath);
if (sha256File(surfacePath) !== manifest.surface.sha256
  || sha256File(rightsPath) !== manifest.rights.evidenceCatalog.sha256
  || sha256File(buildTcbPath) !== manifest.buildTcb.sha256) {
  throw new Error("Release governance artifact digest mismatch");
}
if (canonicalJson(manifest.rights.productionTcbLicenses)
  !== canonicalJson(productionTcbLicenses(manifest.hostTcb))) {
  throw new Error("Release production-TCB license inventory differs from its Host-TCB contract");
}
const buildTcbText = readFileSync(buildTcbPath, "utf8");
const buildTcb = JSON.parse(buildTcbText);
if (canonicalJson(buildTcb) !== buildTcbText
  || buildTcb.schemaVersion !== "ltx-studio-build-tcb.v1"
  || buildTcb.source?.gitCommit !== manifest.source?.gitCommit
  || buildTcb.source?.gitTree !== manifest.source?.gitTree
  || buildTcb.externalPolicySha256 !== manifest.buildTcb.externalPolicySha256
  || canonicalJson(buildTcb.nodeModules?.packageTreeComponents)
    !== canonicalJson(manifest.sbom?.buildTcbComponents)) {
  throw new Error("Build-TCB source, external policy, or development SBOM binding mismatch");
}
const releaseSurfaceModule = await import(pathToFileURL(join(releaseAppRoot, "shared", "releaseSurface.js")));
const rightsEvidenceModule = await import(pathToFileURL(join(releaseAppRoot, "shared", "rightsEvidence.js")));
const surface = releaseSurfaceModule.candidateReleaseSurfaceSchema.parse(
  JSON.parse(readFileSync(surfacePath, "utf8")),
);
const rightsEvidence = rightsEvidenceModule.rightsEvidenceCatalogSchema.parse(
  JSON.parse(readFileSync(rightsPath, "utf8")),
);
const knownEvidenceIds = new Set(rightsEvidence.evidence.map(({ evidenceId }) => evidenceId));
for (const entry of surface.entries) {
  for (const evidenceId of entry.rights.evidenceIds) {
    if (!knownEvidenceIds.has(evidenceId)) {
      throw new Error(`Release surface ${entry.id} references unknown rights evidence ${evidenceId}`);
    }
  }
}
if (staticOnly) {
  process.stdout.write(`${JSON.stringify({
    releaseDigest: actualDigest,
    artifacts: actualArtifacts.length,
    verdict: "static-only-ok",
  })}\n`);
  process.exit(0);
}
const runtimeSeal = verifyRuntimeInstallSeal(releaseRoot, manifest, actualDigest, {
  ...(requireRootOwnedReadOnly
    ? { ownership: { expectedUid: 0, expectedGid: 0, requireReadOnly: true } }
    : {}),
});
verifyHostTcbContract(releaseRoot, manifest.hostTcb);
const releasePython = join(releaseAppRoot, "runtime", ".venv", "bin", "python");
const releaseEnvironment = {
  ...process.env,
  HF_HUB_OFFLINE: "1",
  PYTHONNOUSERSITE: "1",
  TRANSFORMERS_OFFLINE: "1",
  PYTHONDONTWRITEBYTECODE: "1",
};
delete releaseEnvironment.VIRTUAL_ENV;
execFileSync(releasePython, ["-I", join(releaseAppRoot, "runtime", "verify_runtime.py")], {
  cwd: releaseRoot,
  env: releaseEnvironment,
  stdio: "inherit",
});
process.stdout.write(`${JSON.stringify({
  releaseDigest: actualDigest,
  artifacts: actualArtifacts.length,
  runtimeInstallSealSha256: runtimeSeal.sealSha256,
  ownershipVerified: runtimeSeal.ownership !== null,
  verdict: "ok",
})}\n`);
