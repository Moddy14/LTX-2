import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  DIGEST_NAME,
  MANIFEST_NAME,
  releaseArtifacts,
  sha256Bytes,
  sha256File,
} from "./release-manifest-lib.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const rootIndex = process.argv.indexOf("--root");
const rootArgument = rootIndex === -1 ? undefined : process.argv[rootIndex + 1];
if (rootIndex !== -1 && (!rootArgument || rootArgument.startsWith("--"))) {
  throw new Error("--root requires a path");
}
const releaseRoot = rootArgument
  ? resolve(process.cwd(), rootArgument)
  : resolve(appRoot, "build", "release-root");
const manifestBytes = readFileSync(join(releaseRoot, MANIFEST_NAME));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (manifest.schemaVersion !== "ltx-studio-release-manifest.v1") {
  throw new Error("Unsupported release manifest schema");
}
if (canonicalJson(manifest) !== manifestBytes.toString("utf8")) {
  throw new Error("Release manifest is not canonically serialized");
}
const expectedDigest = readFileSync(join(releaseRoot, DIGEST_NAME), "utf8").split(/\s+/)[0];
const actualDigest = sha256Bytes(manifestBytes);
if (expectedDigest !== actualDigest) throw new Error("Release manifest digest mismatch");

const actualArtifacts = releaseArtifacts(releaseRoot);
if (canonicalJson(actualArtifacts) !== canonicalJson(manifest.artifacts)) {
  throw new Error("Release artifact drift detected");
}
const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");
const expectedSurfacePath = "apps/ltx-studio/release/candidate-release-surface.v1.json";
const expectedRightsPath = "apps/ltx-studio/release/rights-evidence.v1.json";
if (manifest.surface?.path !== expectedSurfacePath
  || manifest.rights?.evidenceCatalog?.path !== expectedRightsPath) {
  throw new Error("Release governance artifact path mismatch");
}
const surfacePath = join(releaseRoot, expectedSurfacePath);
const rightsPath = join(releaseRoot, expectedRightsPath);
if (sha256File(surfacePath) !== manifest.surface.sha256
  || sha256File(rightsPath) !== manifest.rights.evidenceCatalog.sha256) {
  throw new Error("Release governance artifact digest mismatch");
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
const releasePython = join(releaseAppRoot, "runtime", ".venv", "bin", "python");
execFileSync(releasePython, ["-I", join(releaseAppRoot, "runtime", "verify_runtime.py")], {
  cwd: releaseRoot,
  stdio: "inherit",
});
process.stdout.write(`${JSON.stringify({ releaseDigest: actualDigest, artifacts: actualArtifacts.length, verdict: "ok" })}\n`);
