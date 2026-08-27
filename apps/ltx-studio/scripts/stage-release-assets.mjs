import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import {
  materializeExternalInterpreterSymlinks,
  materializeTrustedExecutable,
} from "./runtime-install-seal-lib.mjs";
import { canonicalJson, sha256File } from "./release-manifest-lib.mjs";
import {
  BUILD_TCB_POLICY_PATH,
  BUILD_TCB_SCHEMA,
  canonicalMaterializedSourceInventory,
  hermeticBuildEnvironment,
  readExternalBuildTcbPolicy,
  verifyBuildTcbPolicy,
} from "./build-tcb-lib.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const releaseRoot = join(appRoot, "build", "release-root");
const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");

if (!releaseRoot.startsWith(`${join(appRoot, "build")}${sep}`)) {
  throw new Error(`Unexpected release root: ${releaseRoot}`);
}
if (!existsSync(join(releaseAppRoot, "server", "index.js"))) {
  throw new Error("Compiled release server is missing; run release:emit first");
}
const expectedPolicyIndex = process.argv.indexOf("--expected-build-tcb-policy-sha256");
const expectedPolicySha256 = expectedPolicyIndex < 0 ? null : process.argv[expectedPolicyIndex + 1];
const policyPathIndex = process.argv.indexOf("--build-tcb-policy");
const policyPath = policyPathIndex < 0 ? BUILD_TCB_POLICY_PATH : process.argv[policyPathIndex + 1];
const npmCacheIndex = process.argv.indexOf("--npm-cache");
const npmCachePath = npmCacheIndex < 0 ? null : process.argv[npmCacheIndex + 1];
if (!/^[0-9a-f]{64}$/.test(expectedPolicySha256 ?? "") || !policyPath || !npmCachePath) {
  throw new Error("Release staging requires the separate Build-TCB pin, policy path, and isolated npm cache");
}
const buildTcbSourcePath = join(appRoot, "release", "build-tcb.v1.json");
const buildTcbText = readFileSync(buildTcbSourcePath, "utf8");
const buildTcb = JSON.parse(buildTcbText);
if (buildTcb.schemaVersion !== BUILD_TCB_SCHEMA || canonicalJson(buildTcb) !== buildTcbText
  || canonicalJson(canonicalMaterializedSourceInventory(repoRoot))
    !== canonicalJson(buildTcb.source.inventory)) {
  throw new Error("Release staging source differs from the verified materialized Git tree");
}
const externalPolicy = readExternalBuildTcbPolicy(policyPath, { expectedPath: policyPath });
verifyBuildTcbPolicy(externalPolicy.policy, buildTcb, expectedPolicySha256);

const allowedFiles = new Set([
  "LICENSE",
  "pyproject.toml",
  "apps/ltx-studio/package-lock.json",
  "apps/ltx-studio/package.json",
]);
const allowedPrefixes = [
  "apps/ltx-studio/deploy/",
  "apps/ltx-studio/evaluators/",
  "apps/ltx-studio/models/",
  "apps/ltx-studio/release/",
  "apps/ltx-studio/runtime/",
  "apps/ltx-studio/scripts/",
  "packages/ltx-core/",
  "packages/ltx-pipelines/",
];
const tracked = buildTcb.source.inventory
  .filter((entry) => entry.type === "file" || entry.type === "symlink")
  .map((entry) => entry.path)
  .filter((path) => allowedFiles.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix)))
  .filter((path) => !path.endsWith(".ts") && !path.endsWith(".tsx") && path !== "apps/ltx-studio/release/build-tcb.v1.json");

for (const path of tracked) {
  const source = join(repoRoot, path);
  const destination = join(releaseRoot, path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  cpSync(source, destination, { preserveTimestamps: false });
}
mkdirSync(join(releaseAppRoot, "release"), { recursive: true, mode: 0o755 });
cpSync(buildTcbSourcePath, join(releaseAppRoot, "release", "build-tcb.v1.json"), {
  preserveTimestamps: false,
});
cpSync(join(appRoot, "dist"), join(releaseAppRoot, "dist"), {
  recursive: true,
  preserveTimestamps: false,
});

const buildEnvironment = hermeticBuildEnvironment({
  sourceDateEpoch: buildTcb.environment.sourceDateEpoch,
  nodeBinDirectory: dirname(buildTcb.node.path),
  npmCacheDirectory: resolve(npmCachePath),
});
execFileSync(buildTcb.node.path, [buildTcb.npm.cli.path, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: releaseAppRoot,
  env: buildEnvironment,
  stdio: "inherit",
});
const runtimeRoot = join(releaseAppRoot, "runtime");
const uvSource = buildTcb.uv.path;
const uvSha256 = sha256File(uvSource);
const uvToolchainRoot = join(runtimeRoot, "toolchain");
mkdirSync(uvToolchainRoot, { recursive: true, mode: 0o755 });
const releaseUv = join(uvToolchainRoot, "uv");
materializeTrustedExecutable(uvSource, releaseUv, uvSha256);
const nodeLicensePath = buildTcb.licenses.node.path;
if (!existsSync(nodeLicensePath)) {
  throw new Error(`Production Node license is missing: ${nodeLicensePath}`);
}
cpSync(nodeLicensePath, join(runtimeRoot, "NODE-LICENSE"), {
  preserveTimestamps: false,
});
const releaseEnvironment = { ...buildEnvironment };
releaseEnvironment.HF_HUB_OFFLINE = "1";
releaseEnvironment.PYTHONNOUSERSITE = "1";
releaseEnvironment.TRANSFORMERS_OFFLINE = "1";
releaseEnvironment.PYTHONDONTWRITEBYTECODE = "1";
for (const name of [
  "NODE_OPTIONS", "NODE_PATH", "LD_PRELOAD", "LD_AUDIT", "LD_LIBRARY_PATH",
  "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONUSERBASE",
]) delete releaseEnvironment[name];
execFileSync(releaseUv, [
  "sync",
  "--project", runtimeRoot,
  "--locked",
  "--no-dev",
  "--no-editable",
  "--link-mode", "copy",
  "--no-config",
], { cwd: releaseRoot, env: releaseEnvironment, stdio: "inherit" });
materializeExternalInterpreterSymlinks(join(runtimeRoot, ".venv"));
materializeTrustedExecutable(
  buildTcb.node.path,
  join(runtimeRoot, ".venv", "bin", "node"),
  buildTcb.node.sha256,
);
const releasePython = join(runtimeRoot, ".venv", "bin", "python");
execFileSync(releasePython, ["-I", join(runtimeRoot, "normalize_cusparselt_wheel.py")], {
  cwd: releaseRoot,
  env: releaseEnvironment,
  stdio: "inherit",
});
execFileSync(releasePython, ["-I", join(runtimeRoot, "normalize_torch_cudnn_requirement.py")], {
  cwd: releaseRoot,
  env: releaseEnvironment,
  stdio: "inherit",
});
execFileSync(releaseUv, ["pip", "check", "--python", releasePython], {
  cwd: releaseRoot,
  env: releaseEnvironment,
  stdio: "inherit",
});
execFileSync(releasePython, ["-I", join(runtimeRoot, "verify_runtime.py")], {
  cwd: releaseRoot,
  env: releaseEnvironment,
  stdio: "inherit",
});
const packagePath = join(releaseAppRoot, "package.json");
const sourcePackage = JSON.parse(readFileSync(packagePath, "utf8"));
const productionPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  private: true,
  type: "module",
  scripts: {
    start: "./runtime/.venv/bin/node server/index.js",
    "release:verify": "./runtime/.venv/bin/node scripts/verify-release-manifest.mjs",
    "release:verify:static": "./runtime/.venv/bin/node scripts/verify-release-manifest.mjs --static-only",
    "audit:preflight": "./runtime/.venv/bin/node scripts/preflight-release-audit.mjs",
    "audit:security": "./runtime/.venv/bin/node scripts/audit-release-security.mjs",
    "audit:release": "./runtime/.venv/bin/node scripts/audit-release.mjs",
    "audit:finalize": "./runtime/.venv/bin/node scripts/finalize-release-audit.mjs",
    "audit:promotion": "./runtime/.venv/bin/node scripts/prepare-release-promotion.mjs",
  },
  dependencies: sourcePackage.dependencies,
};
writeFileSync(packagePath, `${JSON.stringify(productionPackage, null, 2)}\n`, { mode: 0o644 });

for (const forbidden of [
  join(releaseAppRoot, "node_modules", ".bin", "tsx"),
  join(releaseAppRoot, "server", "index.ts"),
]) {
  if (existsSync(forbidden)) throw new Error(`Forbidden production source/runtime found: ${relative(releaseRoot, forbidden)}`);
}
process.stdout.write(`${releaseRoot}\n`);
