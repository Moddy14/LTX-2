import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  BUILD_TCB_POLICY_PATH,
  buildTcbSha256,
  captureBuildTcb,
  hermeticBuildEnvironment,
  materializeGitTree,
  preflightBuildTcbPolicy,
  readExternalBuildTcbPolicy,
  verifyBuildTcbPolicy,
} from "./build-tcb-lib.mjs";
import { canonicalJson } from "./release-manifest-lib.mjs";

const sourceRepository = resolve(import.meta.dirname, "../../..");

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Hermetic build accepts only explicit --name value pairs");
    }
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate hermetic build option: ${name}`);
    values[name] = value;
  }
  const expectedPolicySha256 = values["--expected-build-tcb-policy-sha256"];
  const destination = resolve(values["--destination"] ?? "");
  const policyPath = resolve(values["--policy"] ?? BUILD_TCB_POLICY_PATH);
  if (!/^[0-9a-f]{64}$/.test(expectedPolicySha256 ?? "")
    || !values["--destination"] || destination === "/" || destination === sourceRepository
    || existsSync(destination)) {
    throw new Error("Hermetic build requires a separate policy digest and a new explicit destination");
  }
  return { destination, expectedPolicySha256, policyPath };
}

const options = parseArguments(process.argv.slice(2));
const external = readExternalBuildTcbPolicy(options.policyPath, { expectedPath: options.policyPath });
const policyTools = preflightBuildTcbPolicy(external.policy, options.expectedPolicySha256);
const policy = external.policy;
const materialized = materializeGitTree(sourceRepository, options.destination, {
  gitCommit: policy.gitCommit,
  expectedGitTree: policy.gitTree,
  expectedMaterializedTreeSha256: policy.materializedTreeSha256,
  gitExecutable: policy.executables.git.path,
  expectedGitExecutableSha256: policy.executables.git.sha256,
});
const appRoot = join(options.destination, "apps", "ltx-studio");
const cacheRoot = `${options.destination}.npm-cache`;
if (existsSync(cacheRoot)) throw new Error("Hermetic npm cache destination already exists");
mkdirSync(cacheRoot, { mode: 0o700 });
const environment = hermeticBuildEnvironment({
  sourceDateEpoch: policy.sourceDateEpoch,
  nodeBinDirectory: dirname(policyTools.executables.node.path),
  npmCacheDirectory: cacheRoot,
});

execFileSync(policyTools.executables.node.path, [
  policyTools.npm.cli.path,
  "ci",
  "--ignore-scripts",
  "--include=dev",
  "--no-audit",
  "--no-fund",
], { cwd: appRoot, env: environment, stdio: "inherit" });

function version(executable, args) {
  const output = execFileSync(executable, args, {
    cwd: appRoot,
    env: environment,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  }).trim();
  if (!output || output.length > 512) throw new Error(`Build-TCB version probe failed: ${executable}`);
  return output.split(/\r?\n/, 1)[0];
}
const observedVersions = {
  git: version(policyTools.executables.git.path, ["--version"]),
  node: version(policyTools.executables.node.path, ["--version"]),
  npm: version(policyTools.executables.node.path, [policyTools.npm.cli.path, "--version"]),
  python: version(policyTools.executables.python.path, ["--version"]),
  uv: version(policyTools.executables.uv.path, ["--version"]),
};
if (canonicalJson(observedVersions) !== canonicalJson(policy.versions)) {
  throw new Error("Observed Build-TCB versions differ from the external policy");
}

const buildTcbCaptureOptions = {
  sourceRoot: options.destination,
  appRoot,
  gitCommit: materialized.gitCommit,
  gitTree: materialized.gitTree,
  sourceDateEpoch: policy.sourceDateEpoch,
  policySha256: external.sha256,
  gitExecutable: policyTools.executables.git.path,
  nodeExecutable: policyTools.executables.node.path,
  npmCliPath: policyTools.npm.cli.path,
  pythonExecutable: policyTools.executables.python.path,
  uvExecutable: policyTools.executables.uv.path,
  licensePaths: Object.fromEntries(Object.entries(policyTools.licenses).map(([name, value]) => [name, value.path])),
  versions: observedVersions,
  configPaths: policy.configs.map(({ path }) => path),
  lockPaths: Object.fromEntries(policy.locks.map(({ name, path }) => [name, path])),
};
const record = captureBuildTcb(buildTcbCaptureOptions);
verifyBuildTcbPolicy(policy, record, options.expectedPolicySha256);
const buildTcbPath = join(appRoot, "release", "build-tcb.v1.json");
if (existsSync(buildTcbPath)) throw new Error("Materialized source already contains a generated Build-TCB record");
writeFileSync(buildTcbPath, canonicalJson(record), { flag: "wx", mode: 0o444 });
function assertBuildTcbRecordUnchanged() {
  const bytes = readFileSync(buildTcbPath);
  const text = bytes.toString("utf8");
  if (text !== canonicalJson(record)
    || buildTcbSha256(JSON.parse(text)) !== buildTcbSha256(record)) {
    throw new Error("Build-TCB record changed after its fresh-tree capture");
  }
}
assertBuildTcbRecordUnchanged();

const scriptByName = Object.fromEntries(record.nodeModules.executableScripts.map((value) => [value.name, value.path]));
execFileSync(record.node.path, [
  scriptByName.tsc,
  "--project",
  join(appRoot, "tsconfig.release.json"),
], { cwd: appRoot, env: environment, stdio: "inherit" });
assertBuildTcbRecordUnchanged();
execFileSync(record.node.path, [
  scriptByName.vite,
  "build",
  "--config",
  join(appRoot, "vite.config.ts"),
  "--outDir",
  join(appRoot, "dist"),
  "--emptyOutDir",
], { cwd: appRoot, env: environment, stdio: "inherit" });
assertBuildTcbRecordUnchanged();

execFileSync(record.node.path, [
  join(appRoot, "scripts", "stage-release-assets.mjs"),
  "--expected-build-tcb-policy-sha256",
  options.expectedPolicySha256,
  "--build-tcb-policy",
  options.policyPath,
  "--npm-cache",
  cacheRoot,
], { cwd: appRoot, env: environment, stdio: "inherit" });
assertBuildTcbRecordUnchanged();
execFileSync(record.node.path, [
  join(appRoot, "scripts", "generate-release-manifest.mjs"),
  "--expected-build-tcb-policy-sha256",
  options.expectedPolicySha256,
  "--build-tcb-policy",
  options.policyPath,
], { cwd: appRoot, env: environment, stdio: "inherit" });
assertBuildTcbRecordUnchanged();

const expectedServer = join(appRoot, "build", "release-root", "apps", "ltx-studio", "server", "index.js");
const expectedUi = join(appRoot, "dist", "index.html");
if (!existsSync(expectedServer) || !existsSync(expectedUi)) {
  throw new Error("Hermetic build did not produce both the explicit server and UI outputs");
}
const postBuildRecord = captureBuildTcb(buildTcbCaptureOptions);
if (canonicalJson(postBuildRecord) !== canonicalJson(record)) {
  throw new Error("Materialized source, lock/config inputs, or complete Build-TCB tree drifted during build");
}
verifyBuildTcbPolicy(policy, postBuildRecord, options.expectedPolicySha256);
process.stdout.write(canonicalJson({
  schemaVersion: "ltx-studio-hermetic-build-result.v1",
  sourceRoot: options.destination,
  buildTcb: { path: buildTcbPath, sha256: buildTcbSha256(record) },
  outputs: { server: expectedServer, ui: expectedUi },
}));
