import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  canonicalJson,
  DIGEST_NAME,
  MANIFEST_NAME,
  releaseArtifacts,
  sha256Bytes,
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
const releasePython = join(releaseAppRoot, "runtime", ".venv", "bin", "python");
execFileSync(releasePython, ["-I", join(releaseAppRoot, "runtime", "verify_runtime.py")], {
  cwd: releaseRoot,
  stdio: "inherit",
});
process.stdout.write(`${JSON.stringify({ releaseDigest: actualDigest, artifacts: actualArtifacts.length, verdict: "ok" })}\n`);
