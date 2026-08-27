import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { canonicalJson, sha256Bytes, sha256File } from "./release-manifest-lib.mjs";

export const BUILD_TCB_SCHEMA = "ltx-studio-build-tcb.v1";
export const BUILD_TCB_POLICY_SCHEMA = "ltx-studio-build-tcb-policy.v1";
export const BUILD_TCB_POLICY_PATH = "/etc/ltx-studio/build-tcb-policy.v1.json";
export const REQUIRED_BUILD_PACKAGES = Object.freeze([
  "@vitejs/plugin-react",
  "esbuild",
  "rollup",
  "typescript",
  "vite",
]);
const BUILD_TCB_QUALIFICATION = Object.freeze({
  status: "hold",
  blockers: [
    "dedicated-external-build-authority-attestation-missing",
    "read-only-build-source-mount-not-independently-attested",
    "separate-build-uid-isolation-not-independently-attested",
    "same-uid-transient-source-or-tool-swap-not-excluded",
  ],
  boundedClaim: "git-odb-materialized-fresh-lock-build-with-persistent-byte-inventory",
  externalPathReopenBoundary: {
    rootOwnedReadOnlyFilesRequired: true,
    rootOwnedNonWritableParentChainRequired: true,
    heldFdExecution: false,
    rootAdministratorRemainsTrustBoundary: true,
  },
});
const EXCLUDED_MATERIALIZED_SOURCE_PREFIXES = Object.freeze([
  "apps/ltx-studio/build/",
  "apps/ltx-studio/dist/",
  "apps/ltx-studio/node_modules/",
]);
const EXCLUDED_MATERIALIZED_SOURCE_FILES = new Set([
  "apps/ltx-studio/release/build-tcb.v1.json",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40}$/;

function exactGitBlobSha1(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function safeGitPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")
    || value.startsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Materialized Git path is unsafe: ${String(value)}`);
  }
  return value;
}

export function parseGitTreeInventory(raw) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const text = bytes.toString("utf8");
  if (!Buffer.from(text).equals(bytes)) throw new Error("Git tree contains a non-UTF-8 path");
  const records = text.split("\0");
  if (records.at(-1) !== "") throw new Error("Git tree inventory is not NUL terminated");
  records.pop();
  return records.map((record) => {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
    if (!match) throw new Error(`Git tree contains an unsupported object or mode: ${record}`);
    return { mode: match[1], oid: match[2], path: safeGitPath(match[3]) };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

/** Materialize only bytes addressed by an immutable Git tree; no worktree overlay is read. */
export function materializeGitTree(repoRootArgument, destinationArgument, options = {}) {
  const repoRoot = resolve(repoRootArgument);
  const destination = resolve(destinationArgument);
  const gitCommit = options.gitCommit;
  if (!GIT_OBJECT_PATTERN.test(gitCommit ?? "") || existsSync(destination)) {
    throw new Error("Git materialization requires an exact commit and a new destination");
  }
  const execute = options.execute ?? execFileSync;
  const gitExecutable = options.gitExecutable ?? "/usr/bin/git";
  const gitIdentity = exactFile(gitExecutable, { executable: true });
  if (options.expectedGitExecutableSha256 && gitIdentity.sha256 !== options.expectedGitExecutableSha256) {
    throw new Error("Git executable differs from the external Build-TCB policy");
  }
  const gitTree = String(execute(gitIdentity.path, ["rev-parse", `${gitCommit}^{tree}`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
  })).trim();
  if (!GIT_OBJECT_PATTERN.test(gitTree)
    || (options.expectedGitTree && gitTree !== options.expectedGitTree)) {
    throw new Error("Git commit does not resolve to the externally expected tree");
  }
  const inventoryBytes = execute(gitIdentity.path, ["ls-tree", "-r", "-z", "--full-tree", gitTree], {
    cwd: repoRoot,
    encoding: null,
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const inventory = parseGitTreeInventory(inventoryBytes);
  mkdirSync(destination, { mode: 0o755 });
  for (const entry of inventory) {
    const output = join(destination, entry.path);
    if (output !== destination && !output.startsWith(`${destination}${sep}`)) {
      throw new Error(`Git object escapes materialization root: ${entry.path}`);
    }
    mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
    const blob = Buffer.from(execute(gitIdentity.path, ["cat-file", "blob", entry.oid], {
      cwd: repoRoot,
      encoding: null,
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
      maxBuffer: 64 * 1024 * 1024,
    }));
    if (exactGitBlobSha1(blob) !== entry.oid) {
      throw new Error(`Git object bytes do not match their object ID: ${entry.path}`);
    }
    if (entry.mode === "120000") {
      const target = blob.toString("utf8");
      const resolvedTarget = resolve(dirname(output), target);
      if (!target || target.includes("\0") || target.startsWith("/")
        || (resolvedTarget !== destination && !resolvedTarget.startsWith(`${destination}${sep}`))) {
        throw new Error(`Git symlink escapes materialized tree: ${entry.path}`);
      }
      symlinkSync(target, output);
    } else {
      writeFileSync(output, blob, { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
      chmodSync(output, entry.mode === "100755" ? 0o755 : 0o644);
    }
  }
  const materializedTreeSha256 = canonicalTreeSha256(destination);
  if (options.expectedMaterializedTreeSha256
    && materializedTreeSha256 !== options.expectedMaterializedTreeSha256) {
    throw new Error("Materialized Git tree differs from its external Build-TCB policy");
  }
  return { gitCommit, gitTree, git: gitIdentity, materializedTreeSha256, inventory };
}

export function hermeticBuildEnvironment(options) {
  const sourceDateEpoch = String(options.sourceDateEpoch ?? "");
  if (!/^\d{1,12}$/.test(sourceDateEpoch)
    || !isAbsolute(options.nodeBinDirectory)
    || !isAbsolute(options.npmCacheDirectory)) {
    throw new Error("Hermetic build environment requires exact time, Node, and cache paths");
  }
  return {
    PATH: options.nodeBinDirectory,
    LC_ALL: "C",
    LANG: "C",
    TZ: "UTC",
    SOURCE_DATE_EPOCH: sourceDateEpoch,
    npm_config_audit: "false",
    npm_config_cache: options.npmCacheDirectory,
    npm_config_fund: "false",
    npm_config_globalconfig: "/dev/null",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: "/dev/null",
  };
}

function safeRelative(root, path) {
  const value = relative(root, path);
  if (!value || value === "." || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw new Error(`Build-TCB path escapes its declared root: ${path}`);
  }
  return value.split(sep).join("/");
}

export function canonicalTreeInventory(rootArgument) {
  const root = resolve(rootArgument);
  const entries = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      const relativePath = safeRelative(root, path);
      const details = lstatSync(path);
      if (details.isDirectory() && !details.isSymbolicLink()) {
        entries.push({ path: relativePath, type: "directory", mode: details.mode & 0o7777 });
        walk(path);
      } else if (details.isFile() && !details.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          type: "file",
          mode: details.mode & 0o7777,
          sizeBytes: details.size,
          sha256: sha256File(path),
        });
      } else if (details.isSymbolicLink()) {
        const target = readlinkSync(path);
        const resolvedTarget = resolve(dirname(path), target);
        if (target.startsWith("/") || (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`))) {
          throw new Error(`Build-TCB symlink escapes its package tree: ${relativePath}`);
        }
        entries.push({ path: relativePath, type: "symlink", target });
      } else {
        throw new Error(`Unsupported Build-TCB inventory node: ${relativePath}`);
      }
    }
  }
  walk(root);
  return entries;
}

export function canonicalTreeSha256(root) {
  return sha256Bytes(Buffer.from(canonicalJson(canonicalTreeInventory(root))));
}

export function canonicalMaterializedSourceInventory(root) {
  return canonicalTreeInventory(root).filter(({ path }) =>
    !EXCLUDED_MATERIALIZED_SOURCE_FILES.has(path)
    && !EXCLUDED_MATERIALIZED_SOURCE_PREFIXES.some((prefix) =>
      path === prefix.slice(0, -1) || path.startsWith(prefix)));
}

function exactFile(pathArgument, options = {}) {
  const path = resolve(pathArgument);
  if (!isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error(`Build-TCB executable/config path is not canonical: ${path}`);
  }
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || (details.mode & 0o022) !== 0
    || (options.executable && (details.mode & 0o111) === 0)) {
    throw new Error(`Build-TCB file identity or mode is unsafe: ${path}`);
  }
  return { path, sizeBytes: details.size, mode: details.mode & 0o7777, sha256: sha256File(path) };
}

function exactExternalFile(pathArgument, options = {}) {
  const file = exactFile(pathArgument, options);
  const details = lstatSync(file.path);
  if (details.uid !== 0 || details.gid !== 0) {
    throw new Error(`External Build-TCB file is not root-owned: ${file.path}`);
  }
  const parentDirectories = [];
  let directory = dirname(file.path);
  for (;;) {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory
      || parent.uid !== 0 || parent.gid !== 0 || (parent.mode & 0o022) !== 0) {
      throw new Error(`External Build-TCB parent directory is mutable or not root-owned: ${directory}`);
    }
    parentDirectories.push({ path: directory, uid: parent.uid, gid: parent.gid, mode: parent.mode & 0o7777 });
    if (directory === dirname(directory)) break;
    directory = dirname(directory);
  }
  return { ...file, uid: details.uid, gid: details.gid, nlink: details.nlink, parentDirectories };
}

function packageRoot(appRoot, name) {
  return join(appRoot, "node_modules", ...name.split("/"));
}

function capturePackage(appRoot, name) {
  const root = packageRoot(appRoot, name);
  const packageJsonPath = join(root, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== name || typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error(`Build package identity is invalid: ${name}`);
  }
  const inventory = canonicalTreeInventory(root);
  return {
    name,
    version: packageJson.version,
    root: safeRelative(appRoot, root),
    packageJsonSha256: sha256File(packageJsonPath),
    treeSha256: sha256Bytes(Buffer.from(canonicalJson(inventory))),
    files: inventory.length,
  };
}

function captureNpmCli(appRoot, npmCliPath, options = {}) {
  const cli = options.external === true ? exactExternalFile(npmCliPath) : exactFile(npmCliPath);
  let root = dirname(cli.path);
  while (root !== dirname(root)) {
    try {
      const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (packageJson.name === "npm" && typeof packageJson.version === "string") {
        return {
          version: packageJson.version,
          cli,
          packageRoot: root,
          packageTreeSha256: canonicalTreeSha256(root),
        };
      }
    } catch {
      // Continue towards the filesystem root; only the exact npm package is accepted.
    }
    root = dirname(root);
  }
  throw new Error("Exact npm CLI does not belong to an identifiable npm package tree");
}

export function captureBuildTcb(options) {
  const sourceRoot = resolve(options.sourceRoot);
  const appRoot = resolve(options.appRoot);
  if (appRoot !== join(sourceRoot, "apps", "ltx-studio")) {
    throw new Error("Build-TCB app root must be inside the materialized source root");
  }
  if (!/^[0-9a-f]{40}$/.test(options.gitCommit)
    || !/^[0-9a-f]{40}$/.test(options.gitTree)
    || !SHA256_PATTERN.test(options.policySha256)
    || !/^\d{1,12}$/.test(String(options.sourceDateEpoch ?? ""))) {
    throw new Error("Build-TCB source or external policy identity is incomplete");
  }
  const node = exactExternalFile(options.nodeExecutable, { executable: true });
  const git = exactExternalFile(options.gitExecutable ?? "/usr/bin/git", { executable: true });
  const python = exactExternalFile(options.pythonExecutable, { executable: true });
  const uv = exactExternalFile(options.uvExecutable, { executable: true });
  const licenses = Object.fromEntries(["git", "node", "npm", "python", "uv"].map((name) => {
    const path = options.licensePaths?.[name];
    if (!path) throw new Error(`Build-TCB license path is required: ${name}`);
    return [name, exactExternalFile(path)];
  }));
  const versions = options.versions;
  if (!versions || ["git", "node", "npm", "python", "uv"].some((name) =>
    typeof versions[name] !== "string" || versions[name].length < 1 || versions[name].length > 512)) {
    throw new Error("Build-TCB tool versions are incomplete");
  }
  const npm = captureNpmCli(appRoot, options.npmCliPath, { external: true });
  const materializedInventory = canonicalMaterializedSourceInventory(sourceRoot);
  const materializedTreeSha256 = sha256Bytes(Buffer.from(canonicalJson(materializedInventory)));
  const nodeModulesRoot = join(appRoot, "node_modules");
  const nodeModulesInventory = canonicalTreeInventory(nodeModulesRoot);
  const nodeModulesTreeSha256 = sha256Bytes(Buffer.from(canonicalJson(nodeModulesInventory)));
  const configs = options.configPaths.map((path) => {
    const exact = exactFile(resolve(sourceRoot, path));
    return { path: safeRelative(sourceRoot, exact.path), sha256: exact.sha256, sizeBytes: exact.sizeBytes };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(configs.map(({ path }) => path)).size !== configs.length) {
    throw new Error("Build-TCB config path set contains duplicates");
  }
  const packages = REQUIRED_BUILD_PACKAGES.map((name) => capturePackage(appRoot, name));
  const packageTreeComponents = [];
  for (const entry of nodeModulesInventory) {
    if (entry.type !== "file" || !entry.path.endsWith("/package.json")) continue;
    const packagePath = join(nodeModulesRoot, entry.path);
    try {
      const value = JSON.parse(readFileSync(packagePath, "utf8"));
      if (typeof value.name === "string" && typeof value.version === "string") {
        packageTreeComponents.push({ name: value.name, version: value.version, path: entry.path, sha256: entry.sha256 });
      }
    } catch {
      throw new Error(`Invalid package.json in fresh build tree: ${entry.path}`);
    }
  }
  packageTreeComponents.sort((left, right) => left.path.localeCompare(right.path));
  const nativeBuildArtifacts = nodeModulesInventory
    .filter((entry) => entry.type === "file" && (
      /^@esbuild\/[^/]+\/bin\/esbuild$/.test(entry.path)
      || /^@rollup\/rollup-[^/]+\/.+\.node$/.test(entry.path)
      || entry.path === "rollup/dist/native.js"
    ))
    .map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
    }));
  if (!nativeBuildArtifacts.some(({ path }) => path.startsWith("@esbuild/"))
    || !nativeBuildArtifacts.some(({ path }) => path.startsWith("@rollup/"))) {
    throw new Error("Fresh build tree lacks the platform-specific esbuild or Rollup native implementation");
  }
  const executableScripts = [
    ["tsc", join(appRoot, "node_modules", "typescript", "bin", "tsc")],
    ["vite", join(appRoot, "node_modules", "vite", "bin", "vite.js")],
    ["rollup", join(appRoot, "node_modules", "rollup", "dist", "bin", "rollup")],
    ["esbuild-js", join(appRoot, "node_modules", "esbuild", "bin", "esbuild")],
  ].map(([name, path]) => {
    const canonicalPath = realpathSync(path);
    if (!canonicalPath.startsWith(`${nodeModulesRoot}${sep}`)) {
      throw new Error(`Build script resolves outside the fresh node_modules tree: ${name}`);
    }
    return { name, ...exactFile(canonicalPath) };
  });
  const lockPaths = options.lockPaths ?? {};
  const locks = Object.entries({
    node: lockPaths.node ?? "apps/ltx-studio/package-lock.json",
    pythonRuntime: lockPaths.pythonRuntime ?? "apps/ltx-studio/runtime/uv.lock",
    pythonWorkspace: lockPaths.pythonWorkspace ?? "uv.lock",
  }).map(([name, relativePath]) => {
    const exact = exactFile(resolve(sourceRoot, relativePath));
    return { name, path: safeRelative(sourceRoot, exact.path), sha256: exact.sha256, sizeBytes: exact.sizeBytes };
  }).sort((left, right) => left.name.localeCompare(right.name));
  return {
    schemaVersion: BUILD_TCB_SCHEMA,
    qualification: BUILD_TCB_QUALIFICATION,
    source: {
      materialization: "git-object-database-no-worktree-overlay",
      gitCommit: options.gitCommit,
      gitTree: options.gitTree,
      materializedTreeSha256,
      files: materializedInventory.length,
      inventory: materializedInventory,
    },
    environment: {
      contract: "ltx-studio-hermetic-build-env.v1",
      inheritedVariables: [],
      locale: "C",
      timezone: "UTC",
      sourceDateEpoch: String(options.sourceDateEpoch),
      path: dirname(node.path),
      npmUserConfig: "/dev/null",
      npmGlobalConfig: "/dev/null",
    },
    commands: {
      npmCi: [node.path, npm.cli.path, "ci", "--ignore-scripts", "--include=dev", "--no-audit", "--no-fund"],
      tsc: [node.path, join(appRoot, "node_modules", "typescript", "bin", "tsc"), "--project", join(appRoot, "tsconfig.release.json")],
      vite: [node.path, join(appRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--config", join(appRoot, "vite.config.ts")],
    },
    node,
    git,
    python,
    uv,
    licenses,
    versions,
    npm,
    nodeModules: {
      treeSha256: nodeModulesTreeSha256,
      files: nodeModulesInventory.length,
      inventory: nodeModulesInventory,
      packageTreeComponents,
      executableScripts,
      nativeBuildArtifacts,
    },
    packages,
    configs,
    locks,
    externalPolicySha256: options.policySha256,
  };
}

export function buildTcbSha256(record) {
  if (record?.schemaVersion !== BUILD_TCB_SCHEMA) throw new Error("Build-TCB schema is invalid");
  return sha256Bytes(Buffer.from(canonicalJson(record)));
}

export function preflightBuildTcbPolicy(policy, expectedPolicySha256) {
  if (!SHA256_PATTERN.test(expectedPolicySha256)
    || policy?.schemaVersion !== BUILD_TCB_POLICY_SCHEMA
    || sha256Bytes(Buffer.from(canonicalJson(policy))) !== expectedPolicySha256
    || policy.status !== "authorized"
    || policy.buildTcbSchema !== BUILD_TCB_SCHEMA
    || !GIT_OBJECT_PATTERN.test(policy.gitCommit ?? "")
    || !GIT_OBJECT_PATTERN.test(policy.gitTree ?? "")
    || !SHA256_PATTERN.test(policy.materializedTreeSha256 ?? "")
    || !SHA256_PATTERN.test(policy.nodeModulesTreeSha256 ?? "")
    || !/^\d{1,12}$/.test(String(policy.sourceDateEpoch ?? ""))) {
    throw new Error("External Build-TCB policy authorization header is invalid");
  }
  if (!policy.versions || ["git", "node", "npm", "python", "uv"].some((name) =>
    typeof policy.versions[name] !== "string" || policy.versions[name].length < 1
      || policy.versions[name].length > 512)
    || !isAbsolute(policy.releaseInputs?.longcatRoot ?? "")
    || !policy.releaseInputs?.dockerImages
    || ["latentsync", "lipforcing", "musetalk"].some((name) =>
      typeof policy.releaseInputs.dockerImages[name] !== "string"
      || policy.releaseInputs.dockerImages[name].length > 512)) {
    throw new Error("External Build-TCB policy lacks exact tool versions or release inputs");
  }
  const executablePolicies = ["git", "node", "python", "uv"].map((name) => {
    const value = policy.executables?.[name];
    if (!value || !isAbsolute(value.path) || !SHA256_PATTERN.test(value.sha256 ?? "")) {
      throw new Error(`External Build-TCB policy lacks the exact ${name} executable`);
    }
    const observed = exactExternalFile(value.path, { executable: true });
    if (observed.sha256 !== value.sha256) {
      throw new Error(`External Build-TCB ${name} executable pin does not match`);
    }
    return [name, observed];
  });
  const npmPolicy = policy.npm;
  if (!npmPolicy || !isAbsolute(npmPolicy.cliPath)
    || !SHA256_PATTERN.test(npmPolicy.packageTreeSha256 ?? "")) {
    throw new Error("External Build-TCB policy lacks the exact npm package tree");
  }
  const npm = captureNpmCli("/", npmPolicy.cliPath, { external: true });
  if (npm.packageTreeSha256 !== npmPolicy.packageTreeSha256) {
    throw new Error("External Build-TCB npm package-tree pin does not match");
  }
  const licenses = Object.fromEntries(["git", "node", "npm", "python", "uv"].map((name) => {
    const value = policy.licenses?.[name];
    if (!value || !isAbsolute(value.path) || !SHA256_PATTERN.test(value.sha256 ?? "")) {
      throw new Error(`External Build-TCB policy lacks the exact ${name} license`);
    }
    const observed = exactExternalFile(value.path);
    if (observed.sha256 !== value.sha256) throw new Error(`External Build-TCB ${name} license pin does not match`);
    return [name, observed];
  }));
  return { executables: Object.fromEntries(executablePolicies), npm, licenses };
}

export function verifyBuildTcbPolicy(policy, record, expectedPolicySha256) {
  const observedExternal = preflightBuildTcbPolicy(policy, expectedPolicySha256);
  const sourceInventorySha256 = sha256Bytes(Buffer.from(canonicalJson(record.source?.inventory)));
  const nodeModulesInventorySha256 = sha256Bytes(Buffer.from(canonicalJson(record.nodeModules?.inventory)));
  if (canonicalJson(policy) !== canonicalJson(JSON.parse(canonicalJson(policy)))
    || canonicalJson(record.qualification) !== canonicalJson(BUILD_TCB_QUALIFICATION)
    || record.source?.files !== record.source?.inventory?.length
    || sourceInventorySha256 !== record.source?.materializedTreeSha256
    || record.nodeModules?.files !== record.nodeModules?.inventory?.length
    || nodeModulesInventorySha256 !== record.nodeModules?.treeSha256
    || canonicalJson(record.git) !== canonicalJson(observedExternal.executables.git)
    || canonicalJson(record.node) !== canonicalJson(observedExternal.executables.node)
    || canonicalJson(record.python) !== canonicalJson(observedExternal.executables.python)
    || canonicalJson(record.uv) !== canonicalJson(observedExternal.executables.uv)
    || canonicalJson(record.npm) !== canonicalJson(observedExternal.npm)
    || canonicalJson(record.licenses) !== canonicalJson(observedExternal.licenses)
    || canonicalJson(policy.executables.git) !== canonicalJson({ path: record.git.path, sha256: record.git.sha256 })
    || canonicalJson(policy.executables.node) !== canonicalJson({ path: record.node.path, sha256: record.node.sha256 })
    || canonicalJson(policy.executables.python) !== canonicalJson({ path: record.python.path, sha256: record.python.sha256 })
    || canonicalJson(policy.executables.uv) !== canonicalJson({ path: record.uv.path, sha256: record.uv.sha256 })
    || policy.npm.cliPath !== record.npm.cli.path
    || policy.npm.packageTreeSha256 !== record.npm.packageTreeSha256
    || canonicalJson(policy.licenses) !== canonicalJson(Object.fromEntries(
      Object.entries(record.licenses).map(([name, value]) => [name, { path: value.path, sha256: value.sha256 }]),
    ))
    || canonicalJson(policy.versions) !== canonicalJson(record.versions)
    || policy.nodeModulesTreeSha256 !== record.nodeModules.treeSha256
    || policy.materializedTreeSha256 !== record.source.materializedTreeSha256
    || policy.gitCommit !== record.source.gitCommit
    || policy.gitTree !== record.source.gitTree
    || String(policy.sourceDateEpoch) !== record.environment.sourceDateEpoch
    || canonicalJson(policy.locks) !== canonicalJson(record.locks)
    || canonicalJson(policy.configs) !== canonicalJson(record.configs)
    || canonicalJson(policy.nativeBuildArtifacts) !== canonicalJson(record.nodeModules.nativeBuildArtifacts)
    || canonicalJson(policy.packages) !== canonicalJson(record.packages.map(({ name, version, treeSha256 }) => ({ name, version, treeSha256 })))) {
    throw new Error("External Build-TCB policy is missing, stale, or does not authorize the exact toolchain");
  }
  return record;
}

export function readExternalBuildTcbPolicy(pathArgument = BUILD_TCB_POLICY_PATH, options = {}) {
  const path = resolve(pathArgument);
  if (path !== (options.expectedPath ?? BUILD_TCB_POLICY_PATH) || realpathSync(path) !== path) {
    throw new Error("Build-TCB policy path is not the externally fixed canonical path");
  }
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || details.uid !== (options.expectedUid ?? 0) || details.gid !== (options.expectedGid ?? 0)
    || (details.mode & 0o222) !== 0) {
    throw new Error("Build-TCB policy is not root-owned, immutable, and single-linked");
  }
  if (details.size < 2 || details.size > 4 * 1024 * 1024) {
    throw new Error("Build-TCB policy size is outside the fixed bound");
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("External Build-TCB policy verification requires O_NOFOLLOW support");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    const before = fstatSync(descriptor);
    if (before.dev !== details.dev || before.ino !== details.ino || before.size !== details.size
      || before.ctimeMs !== details.ctimeMs || before.mtimeMs !== details.mtimeMs) {
      throw new Error("Build-TCB policy changed before held-FD read");
    }
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) {
      throw new Error("Build-TCB policy changed during held-FD read");
    }
  } finally {
    closeSync(descriptor);
  }
  const text = bytes.toString("utf8");
  const policy = JSON.parse(text);
  if (canonicalJson(policy) !== text) throw new Error("Build-TCB policy is not canonical JSON");
  return { policy, sha256: sha256Bytes(bytes) };
}
