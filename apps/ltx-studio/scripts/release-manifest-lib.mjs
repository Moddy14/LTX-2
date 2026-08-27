import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const MANIFEST_NAME = "release-manifest.json";
export const DIGEST_NAME = "release-manifest.sha256";
export const RELEASE_MANIFEST_SCHEMA = "ltx-studio-release-manifest.v4";
export const RUNTIME_ROOT_PATH = "apps/ltx-studio/runtime/.venv";
export const RUNTIME_SEAL_PATH = "apps/ltx-studio/runtime/runtime-install-seal.json";

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256Bytes(readFileSync(path));
}

export function canonicalDigestFile(digest) {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Release digest must be an exact SHA-256 value");
  return `${digest}  ${MANIFEST_NAME}\n`;
}

export function parseCanonicalDigestFile(value) {
  if (typeof value !== "string") throw new Error("Release digest file must be UTF-8 text");
  const match = /^([0-9a-f]{64})  release-manifest\.json\n$/.exec(value);
  if (!match) throw new Error("Release digest file is not canonical");
  return match[1];
}

function excluded(path) {
  return path === MANIFEST_NAME
    || path === DIGEST_NAME
    || path === RUNTIME_SEAL_PATH
    || path === RUNTIME_ROOT_PATH
    || path.startsWith(`${RUNTIME_ROOT_PATH}${sep}`);
}

export function releaseArtifacts(root) {
  const artifacts = [];
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      if (excluded(path)) continue;
      const details = lstatSync(absolute);
      if (details.isDirectory()) {
        walk(absolute);
      } else if (details.isSymbolicLink()) {
        const target = readlinkSync(absolute);
        const resolvedTarget = resolve(dirname(absolute), target);
        if (target.startsWith("/") || (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`))) {
          throw new Error(`Release symlink escapes its package directory: ${path} -> ${target}`);
        }
        artifacts.push({ path, type: "symlink", target });
      } else if (details.isFile()) {
        artifacts.push({
          path,
          type: "file",
          mode: details.mode & 0o111 ? "0755" : "0644",
          sizeBytes: details.size,
          sha256: sha256File(absolute),
        });
      } else {
        throw new Error(`Unsupported release artifact type: ${path}`);
      }
    }
  }
  walk(root);
  return artifacts.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function uniqueComponents(components) {
  const byIdentity = new Map();
  for (const component of components) {
    byIdentity.set(`${component.name}\0${component.version}`, component);
  }
  return [...byIdentity.values()].sort((left, right) => {
    const a = `${left.name}@${left.version}`;
    const b = `${right.name}@${right.version}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}
