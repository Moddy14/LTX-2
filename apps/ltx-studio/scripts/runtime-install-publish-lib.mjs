import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lchownSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function noFollowFlag() {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Install platform cannot enforce O_NOFOLLOW");
  }
  return constants.O_NOFOLLOW;
}

function directoryFlag() {
  if (typeof constants.O_DIRECTORY !== "number") {
    throw new Error("Install platform cannot fsync directories");
  }
  return constants.O_DIRECTORY;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

export function fsyncDirectory(path) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | directoryFlag() | noFollowFlag(),
  );
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncRegularFile(path) {
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`Install tree contains an unsafe regular file: ${path}`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!sameIdentity(before, opened)) throw new Error(`Install file changed while opening: ${path}`);
    fsyncSync(descriptor);
    const after = lstatSync(path, { bigint: true });
    if (!sameIdentity(opened, after)) throw new Error(`Install file changed while syncing: ${path}`);
  } finally {
    closeSync(descriptor);
  }
}

export function applyCanonicalInstalledMetadata(rootArgument, options = {}) {
  const root = resolve(rootArgument);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  let nodeCount = 0;

  function visit(path) {
    const details = lstatSync(path);
    if (details.isSymbolicLink()) {
      lchownSync(path, expectedUid, expectedGid);
      nodeCount += 1;
      return;
    }
    if (details.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
      chownSync(path, expectedUid, expectedGid);
      chmodSync(path, 0o555);
      fsyncDirectory(path);
      nodeCount += 1;
      return;
    }
    if (details.isFile()) {
      if (details.nlink !== 1) throw new Error(`Install tree hardlink is forbidden: ${path}`);
      chownSync(path, expectedUid, expectedGid);
      chmodSync(path, (details.mode & 0o111) !== 0 ? 0o555 : 0o444);
      fsyncRegularFile(path);
      nodeCount += 1;
      return;
    }
    throw new Error(`Install tree contains an unsupported node: ${path}`);
  }

  visit(root);
  return { root, expectedUid, expectedGid, nodeCount };
}

export function sealRegularFileMetadata(pathArgument, options = {}) {
  const path = resolve(pathArgument);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1) {
    throw new Error(`Install seal is not an independent regular file: ${path}`);
  }
  chownSync(path, expectedUid, expectedGid);
  chmodSync(path, 0o444);
  fsyncRegularFile(path);
  fsyncDirectory(dirname(path));
}

function stagingPrefix(digest) {
  if (!SHA256_PATTERN.test(digest)) throw new Error("Install staging requires an exact release digest");
  return `.${digest}.staging-`;
}

function makeWritableForRemoval(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritableForRemoval(join(path, name));
  } else if (details.isFile()) {
    chmodSync(path, 0o600);
  } else {
    throw new Error(`Orphan staging tree contains an unsupported node: ${path}`);
  }
}

export function recoverOrphanedInstallStaging(parentArgument, digest, options = {}) {
  const parent = resolve(parentArgument);
  const prefix = stagingPrefix(digest);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  const removed = [];
  for (const name of readdirSync(parent).sort()) {
    if (!name.startsWith(prefix)) continue;
    const path = join(parent, name);
    const details = lstatSync(path);
    if (!details.isDirectory() || details.isSymbolicLink()
      || details.uid !== expectedUid || details.gid !== expectedGid) {
      throw new Error(`Unsafe orphan install staging entry: ${path}`);
    }
    makeWritableForRemoval(path);
    rmSync(path, { recursive: true, force: false });
    removed.push(path);
  }
  if (removed.length > 0) fsyncDirectory(parent);
  return removed;
}

export function createInstallStaging(parentArgument, digest) {
  const parent = resolve(parentArgument);
  const staging = mkdtempSync(join(parent, stagingPrefix(digest)));
  if (dirname(staging) !== parent || !basename(staging).startsWith(stagingPrefix(digest))) {
    throw new Error("Install staging escaped its trusted parent");
  }
  fsyncDirectory(parent);
  return staging;
}

export function discardInstallStaging(stagingArgument, parentArgument, digest) {
  const staging = resolve(stagingArgument);
  const parent = resolve(parentArgument);
  if (dirname(staging) !== parent || !basename(staging).startsWith(stagingPrefix(digest))) {
    throw new Error("Refusing to discard an unexpected install path");
  }
  if (!existsSync(staging)) return false;
  const details = lstatSync(staging);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error("Refusing to discard unsafe install staging");
  }
  makeWritableForRemoval(staging);
  rmSync(staging, { recursive: true, force: false });
  fsyncDirectory(parent);
  return true;
}

export function publishStagedRelease(options) {
  const staging = resolve(options.staging);
  const destination = resolve(options.destination);
  const parent = resolve(options.parent);
  if (dirname(staging) !== parent || dirname(destination) !== parent
    || !basename(staging).startsWith(stagingPrefix(options.digest))
    || basename(destination) !== options.digest || destination.startsWith(`${staging}${sep}`)) {
    throw new Error("Install publish paths are not exact trusted siblings");
  }
  if (existsSync(destination)) throw new Error(`Release destination already exists: ${destination}`);
  options.verify?.();
  options.failpoint?.("after-verify-before-rename");
  renameSync(staging, destination);
  fsyncDirectory(parent);
  options.failpoint?.("after-rename-and-parent-fsync");
  return destination;
}
