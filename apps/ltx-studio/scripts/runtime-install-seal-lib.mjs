import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";

import {
  canonicalJson,
  RUNTIME_ROOT_PATH,
  RUNTIME_SEAL_PATH,
  sha256Bytes,
} from "./release-manifest-lib.mjs";

export const RUNTIME_INSTALL_POLICY_SCHEMA =
  "ltx-studio-runtime-install-integrity.v3";
export const RUNTIME_INSTALL_SEAL_SCHEMA = "ltx-studio-runtime-install-seal.v3";
export const RUNTIME_INSTALL_INVENTORY_SCHEMA =
  "ltx-studio-runtime-install-inventory.v3";
export const RUNTIME_TREE_ALGORITHM =
  "ltx-studio-canonical-runtime-tree-sha256.v3";
export const RUNTIME_CANONICALIZATION = "ltx-studio-canonical-json.v1";
export const TRUSTED_RELEASE_PARENT = "/opt/ltx-studio/releases";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const READ_BUFFER_BYTES = 1024 * 1024;
const MAX_SEAL_BYTES = 1024 * 1024;

function noFollowFlag() {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("This release platform cannot enforce O_NOFOLLOW file reads");
  }
  return constants.O_NOFOLLOW;
}

function directoryFlag() {
  if (typeof constants.O_DIRECTORY !== "number") {
    throw new Error("This release platform cannot fsync directories safely");
  }
  return constants.O_DIRECTORY;
}

export function runtimeInstallIntegrityPolicy() {
  return {
    schemaVersion: RUNTIME_INSTALL_POLICY_SCHEMA,
    status: "seal-required",
    treeAlgorithm: RUNTIME_TREE_ALGORITHM,
    canonicalization: RUNTIME_CANONICALIZATION,
    runtimeRoot: RUNTIME_ROOT_PATH,
    sealPath: RUNTIME_SEAL_PATH,
    inputPaths: {
      nodeLock: "apps/ltx-studio/package-lock.json",
      pythonLock: "apps/ltx-studio/runtime/uv.lock",
      runtimePyproject: "apps/ltx-studio/runtime/pyproject.toml",
      runtimeVerifier: "apps/ltx-studio/runtime/verify_runtime.py",
      nodeLicense: "apps/ltx-studio/runtime/NODE-LICENSE",
      uvLicense: "apps/ltx-studio/runtime/UV-LICENSE",
      sealVerifier: "apps/ltx-studio/scripts/runtime-install-seal-lib.mjs",
    },
    executablePaths: {
      node: "apps/ltx-studio/runtime/.venv/bin/node",
      uv: "apps/ltx-studio/runtime/toolchain/uv",
    },
    constraints: {
      stableNoFollowFileReads: true,
      externalSymlinksAllowed: false,
      absoluteSymlinksAllowed: false,
      hardlinksAllowed: false,
      supportedNodeTypes: ["directory", "file", "symlink"],
      uvLinkMode: "copy",
      sealExcludedFromArtifactDigest: true,
      sealExcludedFromRuntimeTree: true,
      fullUnixModeBound: true,
      installedDirectoryMode: "0555",
      installedExecutableMode: "0555",
      installedDataMode: "0444",
    },
  };
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function safeNumber(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} exceeds the supported integer range`);
  }
  return number;
}

function resolveDeclaredPath(root, declared, label) {
  if (typeof declared !== "string" || declared.length === 0
    || declared.includes("\\") || posix.normalize(declared) !== declared
    || declared.startsWith("/") || declared === "." || declared.startsWith("../")) {
    throw new Error(`Invalid ${label}: ${String(declared)}`);
  }
  const absolute = resolve(root, declared);
  if (!absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes the release root: ${declared}`);
  }
  return absolute;
}

function stableFileOperation(path, operation) {
  const beforePath = lstatSync(path, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error(`Expected a no-follow regular file: ${path}`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    const beforeFd = fstatSync(descriptor, { bigint: true });
    if (!sameStat(beforePath, beforeFd)) {
      throw new Error(`File changed while opening: ${path}`);
    }
    const result = operation(descriptor, beforeFd);
    const afterFd = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameStat(beforeFd, afterFd) || !sameStat(afterFd, afterPath)) {
      throw new Error(`File changed while reading: ${path}`);
    }
    return result;
  } finally {
    closeSync(descriptor);
  }
}

export function readStableRegularFile(path, maximumBytes = MAX_SEAL_BYTES) {
  return stableFileOperation(path, (descriptor, details) => {
    const size = safeNumber(details.size, `File size for ${path}`);
    if (size > maximumBytes) throw new Error(`File is too large: ${path}`);
    return readFileSync(descriptor);
  });
}

export function sha256StableRegularFile(path) {
  return stableFileOperation(path, (descriptor) => {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest("hex");
  });
}

function fullUnixMode(details) {
  const value = typeof details.mode === "bigint"
    ? Number(details.mode & 0o7777n)
    : details.mode & 0o7777;
  return value.toString(8).padStart(4, "0");
}

function inside(rootArgument, candidateArgument) {
  const root = resolve(rootArgument);
  const candidate = resolve(candidateArgument);
  const path = relative(root, candidate);
  return path === ""
    || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function relativeRuntimePath(runtimeRoot, absolute) {
  const path = relative(runtimeRoot, absolute).split(sep).join("/");
  if (!path || path === "." || posix.normalize(path) !== path
    || path.startsWith("../")) {
    throw new Error(`Runtime entry has an invalid relative path: ${absolute}`);
  }
  return path;
}

export function digestRuntimeTree(runtimeRootArgument, options = {}) {
  const runtimeRoot = resolve(runtimeRootArgument);
  const rootBefore = lstatSync(runtimeRoot, { bigint: true });
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink()) {
    throw new Error("Runtime root must be a real directory");
  }
  const realRuntimeRoot = realpathSync(runtimeRoot);
  if (realRuntimeRoot !== runtimeRoot) {
    throw new Error("Runtime root must not resolve through a symlink");
  }
  const entries = [];
  let fileCount = 0;
  let directoryCount = 1;
  let symlinkCount = 0;
  let totalFileBytes = 0;

  const installedMode = (details, type) => options.canonicalInstalledModes === true
    ? (type === "directory" || (details.mode & 0o111n) !== 0n ? "0555" : "0444")
    : fullUnixMode(details);

  entries.push({ path: ".", type: "directory", mode: installedMode(rootBefore, "directory") });

  function walk(directory) {
    const directoryBefore = lstatSync(directory, { bigint: true });
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw new Error(`Runtime directory changed during traversal: ${directory}`);
    }
    const namesBefore = readdirSync(directory).sort();
    for (const name of namesBefore) {
      const absolute = join(directory, name);
      const path = relativeRuntimePath(runtimeRoot, absolute);
      const detailsBefore = lstatSync(absolute, { bigint: true });
      if (detailsBefore.isDirectory() && !detailsBefore.isSymbolicLink()) {
        if (!inside(realRuntimeRoot, realpathSync(absolute))) {
          throw new Error(`Runtime directory escapes its root: ${path}`);
        }
        entries.push({ path, type: "directory", mode: installedMode(detailsBefore, "directory") });
        directoryCount += 1;
        walk(absolute);
        const detailsAfter = lstatSync(absolute, { bigint: true });
        if (!sameStat(detailsBefore, detailsAfter)) {
          throw new Error(`Runtime directory changed while hashing: ${path}`);
        }
      } else if (detailsBefore.isFile() && !detailsBefore.isSymbolicLink()) {
        if (detailsBefore.nlink !== 1n) {
          throw new Error(`Runtime hardlink/cache sharing is forbidden: ${path}`);
        }
        const sizeBytes = safeNumber(detailsBefore.size, `Runtime file size for ${path}`);
        const sha256 = sha256StableRegularFile(absolute);
        const detailsAfter = lstatSync(absolute, { bigint: true });
        if (!sameStat(detailsBefore, detailsAfter)) {
          throw new Error(`Runtime file changed while hashing: ${path}`);
        }
        entries.push({
          path,
          type: "file",
          mode: installedMode(detailsBefore, "file"),
          sizeBytes,
          sha256,
        });
        fileCount += 1;
        totalFileBytes += sizeBytes;
        if (!Number.isSafeInteger(totalFileBytes)) {
          throw new Error("Runtime byte count exceeds the supported integer range");
        }
      } else if (detailsBefore.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        if (target.startsWith("/")) {
          throw new Error(`Runtime absolute symlink is forbidden: ${path} -> ${target}`);
        }
        const lexicalTarget = resolve(dirname(absolute), target);
        if (!inside(runtimeRoot, lexicalTarget)) {
          throw new Error(`Runtime symlink escapes its root: ${path} -> ${target}`);
        }
        let realTarget;
        try {
          realTarget = realpathSync(absolute);
        } catch {
          throw new Error(`Runtime symlink is dangling: ${path} -> ${target}`);
        }
        if (!inside(realRuntimeRoot, realTarget)) {
          throw new Error(`Runtime symlink resolves outside its root: ${path} -> ${target}`);
        }
        const detailsAfter = lstatSync(absolute, { bigint: true });
        if (!sameStat(detailsBefore, detailsAfter) || readlinkSync(absolute) !== target) {
          throw new Error(`Runtime symlink changed while hashing: ${path}`);
        }
        entries.push({ path, type: "symlink", target });
        symlinkCount += 1;
      } else {
        throw new Error(`Unsupported runtime node type: ${path}`);
      }
    }
    const namesAfter = readdirSync(directory).sort();
    if (canonicalJson(namesAfter) !== canonicalJson(namesBefore)) {
      throw new Error(`Runtime directory contents changed while hashing: ${directory}`);
    }
  }

  walk(runtimeRoot);
  const rootAfter = lstatSync(runtimeRoot, { bigint: true });
  if (!sameStat(rootBefore, rootAfter)) {
    throw new Error("Runtime root changed while hashing");
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    algorithm: RUNTIME_TREE_ALGORITHM,
    canonicalization: RUNTIME_CANONICALIZATION,
    entryCount: entries.length,
    fileCount,
    directoryCount,
    symlinkCount,
    totalFileBytes,
    treeSha256: sha256Bytes(Buffer.from(canonicalJson(entries))),
  };
}

export function expectedRuntimeInstallInventory(runtimeRoot) {
  return {
    schemaVersion: RUNTIME_INSTALL_INVENTORY_SCHEMA,
    tree: digestRuntimeTree(runtimeRoot, { canonicalInstalledModes: true }),
  };
}

function validateRuntimeInstallInventory(manifest, actualTree) {
  const inventory = manifest?.runtimeInstallInventory;
  if (inventory?.schemaVersion !== RUNTIME_INSTALL_INVENTORY_SCHEMA
    || canonicalJson(inventory.tree) !== canonicalJson(actualTree)) {
    throw new Error("Installed runtime does not match the exact manifest runtime inventory");
  }
  return inventory;
}

export function verifyRuntimeInstallInventory(releaseRootArgument, manifest, options = {}) {
  const releaseRoot = resolve(releaseRootArgument);
  const policy = validatePolicy(manifest);
  const runtimeRoot = resolveDeclaredPath(releaseRoot, policy.runtimeRoot, "runtime root");
  const tree = digestRuntimeTree(runtimeRoot, {
    canonicalInstalledModes: options.installedModesApplied !== true,
  });
  validateRuntimeInstallInventory(manifest, tree);
  return manifest.runtimeInstallInventory;
}

function artifactFileSha256(manifest, path) {
  const matches = Array.isArray(manifest.artifacts)
    ? manifest.artifacts.filter((artifact) => artifact?.path === path)
    : [];
  if (matches.length !== 1 || matches[0].type !== "file"
    || !SHA256_PATTERN.test(matches[0].sha256 ?? "")) {
    throw new Error(`Runtime seal input is not an exact manifest file artifact: ${path}`);
  }
  return matches[0].sha256;
}

function validatePolicy(manifest) {
  const expected = runtimeInstallIntegrityPolicy();
  if (canonicalJson(manifest?.runtimeInstallIntegrity) !== canonicalJson(expected)) {
    throw new Error("Release manifest runtime-install seal policy is invalid");
  }
  return expected;
}

function runtimeSealInputs(releaseRoot, manifest, policy) {
  const input = {};
  for (const [name, path] of Object.entries(policy.inputPaths)) {
    const absolute = resolveDeclaredPath(releaseRoot, path, `runtime seal input ${name}`);
    const manifestSha256 = artifactFileSha256(manifest, path);
    const actualSha256 = sha256StableRegularFile(absolute);
    if (actualSha256 !== manifestSha256) {
      throw new Error(`Runtime seal input drift detected: ${path}`);
    }
    input[`${name}Sha256`] = actualSha256;
  }
  if (manifest?.locks?.node !== input.nodeLockSha256
    || manifest?.locks?.python !== input.pythonLockSha256) {
    throw new Error("Runtime seal lock identities disagree with the release manifest");
  }
  if (manifest?.tools?.node?.licenseSha256 !== input.nodeLicenseSha256
    || manifest?.tools?.node?.licensePath !== policy.inputPaths.nodeLicense) {
    throw new Error("Runtime seal Node license identity disagrees with the release manifest");
  }
  if (manifest?.tools?.uv?.licenseSha256 !== input.uvLicenseSha256
    || manifest?.tools?.uv?.licensePath !== policy.inputPaths.uvLicense) {
    throw new Error("Runtime seal uv license identity disagrees with the release manifest");
  }
  return input;
}

function runtimeSealExecutables(releaseRoot, manifest, policy) {
  const declaredNodeDigest = manifest?.tools?.node?.sha256;
  if (!SHA256_PATTERN.test(declaredNodeDigest ?? "")) {
    throw new Error("Release manifest does not bind the production Node binary");
  }
  const nodePath = resolveDeclaredPath(
    releaseRoot,
    policy.executablePaths.node,
    "runtime Node executable",
  );
  const nodeDetails = lstatSync(nodePath, { bigint: true });
  if (!nodeDetails.isFile() || nodeDetails.isSymbolicLink()
    || nodeDetails.nlink !== 1n || (nodeDetails.mode & 0o111n) === 0n) {
    throw new Error("Production Node runtime must be an independent executable regular file");
  }
  const nodeSha256 = sha256StableRegularFile(nodePath);
  if (nodeSha256 !== declaredNodeDigest) {
    throw new Error("Production Node runtime disagrees with the release manifest");
  }
  const declaredUvDigest = manifest?.tools?.uv?.sha256;
  if (!SHA256_PATTERN.test(declaredUvDigest ?? "")) {
    throw new Error("Release manifest does not bind the production uv toolchain binary");
  }
  const uvPath = resolveDeclaredPath(
    releaseRoot,
    policy.executablePaths.uv,
    "runtime uv toolchain executable",
  );
  const uvDetails = lstatSync(uvPath, { bigint: true });
  if (!uvDetails.isFile() || uvDetails.isSymbolicLink()
    || uvDetails.nlink !== 1n || (uvDetails.mode & 0o111n) === 0n) {
    throw new Error("uv toolchain must be an independent executable regular file");
  }
  const uvSha256 = sha256StableRegularFile(uvPath);
  if (uvSha256 !== declaredUvDigest) {
    throw new Error("uv toolchain binary disagrees with the release manifest");
  }
  return {
    nodePath: policy.executablePaths.node,
    nodeSha256,
    uvPath: policy.executablePaths.uv,
    uvSha256,
  };
}

function expectedSeal(releaseRoot, manifest, releaseDigest) {
  if (!SHA256_PATTERN.test(releaseDigest)) {
    throw new Error("Runtime seal requires the final release SHA-256 digest");
  }
  const policy = validatePolicy(manifest);
  const runtimeRoot = resolveDeclaredPath(
    releaseRoot,
    policy.runtimeRoot,
    "runtime root",
  );
  const tree = digestRuntimeTree(runtimeRoot);
  validateRuntimeInstallInventory(manifest, tree);
  return {
    schemaVersion: RUNTIME_INSTALL_SEAL_SCHEMA,
    releaseDigest,
    policySha256: sha256Bytes(Buffer.from(canonicalJson(policy))),
    runtimeRoot: policy.runtimeRoot,
    sealPath: policy.sealPath,
    tree,
    inputs: runtimeSealInputs(releaseRoot, manifest, policy),
    executables: runtimeSealExecutables(releaseRoot, manifest, policy),
  };
}

function fsyncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY | directoryFlag());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeCanonicalAtomic(path, document) {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${posix.basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const bytes = Buffer.from(canonicalJson(document));
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o644,
    );
    let offset = 0;
    while (offset < bytes.length) {
      offset += writeSync(descriptor, bytes, offset, bytes.length - offset, null);
    }
    fchmodSync(descriptor, 0o644);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (existsSync(path)) {
      const existing = lstatSync(path);
      if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) {
        throw new Error(`Refusing to replace unsafe runtime seal path: ${path}`);
      }
    }
    renameSync(temporary, path);
    fsyncDirectory(directory);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return bytes;
}

export function createRuntimeInstallSeal(releaseRootArgument, manifest, releaseDigest) {
  const releaseRoot = resolve(releaseRootArgument);
  const policy = validatePolicy(manifest);
  const seal = expectedSeal(releaseRoot, manifest, releaseDigest);
  const sealPath = resolveDeclaredPath(releaseRoot, policy.sealPath, "runtime seal path");
  const bytes = writeCanonicalAtomic(sealPath, seal);
  return {
    seal,
    sealPath,
    sealSha256: sha256Bytes(bytes),
  };
}

export function verifyReleaseOwnershipAndPermissions(releaseRootArgument, options = {}) {
  const releaseRoot = resolve(releaseRootArgument);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  const requireReadOnly = options.requireReadOnly ?? true;
  const pending = [releaseRoot];
  let nodeCount = 0;
  while (pending.length > 0) {
    const path = pending.pop();
    const details = lstatSync(path);
    if (details.uid !== expectedUid || details.gid !== expectedGid) {
      throw new Error(`Release ownership gate failed: ${path}`);
    }
    if (!details.isSymbolicLink() && requireReadOnly && (details.mode & 0o222) !== 0) {
      throw new Error(`Release permission gate found a writable path: ${path}`);
    }
    if (requireReadOnly && !details.isSymbolicLink()) {
      const actualMode = details.mode & 0o7777;
      const expectedMode = details.isDirectory()
        ? 0o555
        : details.isFile() && (details.mode & 0o111) !== 0 ? 0o555 : 0o444;
      if (actualMode !== expectedMode) {
        throw new Error(
          `Release permission gate found noncanonical mode ${actualMode.toString(8)} at ${path}`,
        );
      }
    }
    if (details.isDirectory() && !details.isSymbolicLink()) {
      for (const name of readdirSync(path).sort().reverse()) pending.push(join(path, name));
    } else if (!details.isFile() && !details.isSymbolicLink()) {
      throw new Error(`Release ownership gate found an unsupported node: ${path}`);
    }
    nodeCount += 1;
  }
  return { expectedUid, expectedGid, requireReadOnly, nodeCount };
}

export function verifyTrustedReleaseParent(parentArgument, options = {}) {
  const filesystem = options.filesystem ?? { lstatSync, realpathSync };
  const expectedParent = resolve(options.expectedParent ?? TRUSTED_RELEASE_PARENT);
  const trustAnchor = resolve(options.trustAnchor ?? "/");
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  const parent = resolve(parentArgument);
  if (parent !== expectedParent) {
    throw new Error(`Release parent must be exactly ${expectedParent}`);
  }
  if (!inside(trustAnchor, parent)) {
    throw new Error(`Release parent is outside its trusted anchor: ${trustAnchor}`);
  }
  if (filesystem.realpathSync(parent) !== parent) {
    throw new Error(`Release parent must not resolve through a symlink: ${parent}`);
  }
  const checked = [];
  let current = parent;
  for (;;) {
    const details = filesystem.lstatSync(current);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`Release parent chain contains a non-directory: ${current}`);
    }
    if (details.uid !== expectedUid || details.gid !== expectedGid) {
      throw new Error(`Release parent chain is not owned by the trusted identity: ${current}`);
    }
    if ((details.mode & 0o022) !== 0) {
      throw new Error(`Release parent chain is group/world writable: ${current}`);
    }
    checked.push(current);
    if (current === trustAnchor) break;
    const next = dirname(current);
    if (next === current || !inside(trustAnchor, next)) {
      throw new Error(`Release parent chain escaped its trusted anchor: ${trustAnchor}`);
    }
    current = next;
  }
  return { parent, expectedUid, expectedGid, checked };
}

export function verifyTrustedReleaseRootLocation(
  releaseRootArgument,
  releaseDigest,
  options = {},
) {
  if (!SHA256_PATTERN.test(releaseDigest)) {
    throw new Error("Trusted release location requires an exact lowercase SHA-256 digest");
  }
  const filesystem = options.filesystem ?? { lstatSync, realpathSync };
  const releaseRoot = resolve(releaseRootArgument);
  if (basename(releaseRoot) !== releaseDigest) {
    throw new Error("Verified release directory name must equal its exact release digest");
  }
  const details = filesystem.lstatSync(releaseRoot);
  if (!details.isDirectory() || details.isSymbolicLink()
    || filesystem.realpathSync(releaseRoot) !== releaseRoot) {
    throw new Error("Release root must be a canonical real directory");
  }
  const parentChain = verifyTrustedReleaseParent(dirname(releaseRoot), {
    expectedParent: options.expectedParent,
    trustAnchor: options.trustAnchor,
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
    filesystem,
  });
  return { releaseRoot, releaseDigest, parentChain };
}

export function verifyRuntimeInstallSeal(
  releaseRootArgument,
  manifest,
  releaseDigest,
  options = {},
) {
  const releaseRoot = resolve(releaseRootArgument);
  const policy = validatePolicy(manifest);
  const sealPath = resolveDeclaredPath(releaseRoot, policy.sealPath, "runtime seal path");
  const sealMetadata = lstatSync(sealPath, { bigint: true });
  if (!sealMetadata.isFile() || sealMetadata.isSymbolicLink()
    || sealMetadata.nlink !== 1n) {
    throw new Error("Runtime install seal must be an independent regular file");
  }
  const sealBytes = readStableRegularFile(sealPath, MAX_SEAL_BYTES);
  if (lstatSync(sealPath, { bigint: true }).nlink !== 1n) {
    throw new Error("Runtime install seal must not be hardlinked");
  }
  const seal = JSON.parse(sealBytes.toString("utf8"));
  if (canonicalJson(seal) !== sealBytes.toString("utf8")) {
    throw new Error("Runtime install seal is not canonically serialized");
  }
  const expected = expectedSeal(releaseRoot, manifest, releaseDigest);
  if (canonicalJson(seal) !== canonicalJson(expected)) {
    throw new Error("Runtime install seal or runtime tree does not match the release");
  }
  const ownership = options.ownership
    ? verifyReleaseOwnershipAndPermissions(releaseRoot, options.ownership)
    : null;
  return {
    seal,
    sealPath,
    sealSha256: sha256Bytes(sealBytes),
    ownership,
  };
}

function copyStableExecutable(source, destination) {
  const beforePath = lstatSync(source, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error(`Interpreter target is not a regular file: ${source}`);
  }
  const sourceDescriptor = openSync(source, constants.O_RDONLY | noFollowFlag());
  let destinationDescriptor;
  try {
    const beforeFd = fstatSync(sourceDescriptor, { bigint: true });
    if (!sameStat(beforePath, beforeFd)) {
      throw new Error(`Interpreter target changed while opening: ${source}`);
    }
    destinationDescriptor = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(),
      0o755,
    );
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
    for (;;) {
      const count = readSync(sourceDescriptor, buffer, 0, buffer.byteLength, null);
      if (count === 0) break;
      let offset = 0;
      while (offset < count) {
        offset += writeSync(destinationDescriptor, buffer, offset, count - offset, null);
      }
    }
    fchmodSync(destinationDescriptor, 0o755);
    fsyncSync(destinationDescriptor);
    const afterFd = fstatSync(sourceDescriptor, { bigint: true });
    const afterPath = lstatSync(source, { bigint: true });
    if (!sameStat(beforeFd, afterFd) || !sameStat(afterFd, afterPath)) {
      throw new Error(`Interpreter target changed while copying: ${source}`);
    }
  } finally {
    closeSync(sourceDescriptor);
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
  }
}

export function materializeTrustedExecutable(sourceArgument, destinationArgument, expectedSha256) {
  if (!SHA256_PATTERN.test(expectedSha256 ?? "")) {
    throw new Error("Trusted executable requires an expected SHA-256 digest");
  }
  const source = resolve(sourceArgument);
  const destination = resolve(destinationArgument);
  if (source === destination || existsSync(destination)) {
    throw new Error(`Trusted executable destination must be new and distinct: ${destination}`);
  }
  const directory = dirname(destination);
  const directoryDetails = statSync(directory);
  if (!directoryDetails.isDirectory()) {
    throw new Error(`Trusted executable destination directory is missing: ${directory}`);
  }
  if (sha256StableRegularFile(source) !== expectedSha256) {
    throw new Error("Trusted executable source digest does not match its release pin");
  }
  const temporary = join(
    directory,
    `.${posix.basename(destination)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  try {
    copyStableExecutable(source, temporary);
    if (sha256StableRegularFile(temporary) !== expectedSha256) {
      throw new Error("Materialized trusted executable digest changed while copying");
    }
    renameSync(temporary, destination);
    fsyncDirectory(directory);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { path: destination, sha256: expectedSha256 };
}

export function materializeExternalInterpreterSymlinks(runtimeRootArgument) {
  const runtimeRoot = resolve(runtimeRootArgument);
  const realRuntimeRoot = realpathSync(runtimeRoot);
  if (realRuntimeRoot !== runtimeRoot) {
    throw new Error("Runtime root must not resolve through a symlink");
  }
  const binRoot = join(runtimeRoot, "bin");
  const binDetails = lstatSync(binRoot);
  if (!binDetails.isDirectory() || binDetails.isSymbolicLink()
    || !inside(realRuntimeRoot, realpathSync(binRoot))) {
    throw new Error("Runtime interpreter directory must be a real internal directory");
  }
  const materialized = [];
  for (const name of readdirSync(binRoot).sort()) {
    if (!/^python(?:3(?:\.\d+)?)?$/.test(name)) continue;
    const path = join(binRoot, name);
    const details = lstatSync(path, { bigint: true });
    if (!details.isSymbolicLink()) continue;
    const target = readlinkSync(path);
    const resolvedTarget = realpathSync(path);
    if (!target.startsWith("/") && inside(realRuntimeRoot, resolvedTarget)) continue;
    const temporary = join(
      binRoot,
      `.${name}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      copyStableExecutable(resolvedTarget, temporary);
      const currentDetails = lstatSync(path, { bigint: true });
      if (!sameStat(details, currentDetails) || readlinkSync(path) !== target) {
        throw new Error(`Interpreter symlink changed while materializing: ${path}`);
      }
      renameSync(temporary, path);
      fsyncDirectory(binRoot);
      materialized.push(name);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  return materialized;
}
