import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { canonicalJson } from "../shared/canonicalJson.js";
import { repoRoot, sealedRelease } from "./config.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type ManifestArtifact = {
  path: string;
  type: "file" | "symlink";
  mode?: "0644" | "0755";
  sizeBytes?: number;
  sha256?: string;
  target?: string;
};

type ReleaseManifest = {
  schemaVersion: "ltx-studio-release-manifest.v1";
  source: { gitCommit: string; clean: boolean };
  artifacts: ManifestArtifact[];
};

export type ReleaseIdentity = {
  sealed: boolean;
  verified: boolean;
  releaseDigest: string | null;
  manifestSha256: string | null;
  sourceCommit: string | null;
};

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactPaths(root: string): string[] {
  const paths: string[] = [];
  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute);
      if (path === "release-manifest.json" || path === "release-manifest.sha256"
        || path.startsWith(`apps/ltx-studio/runtime/.venv${sep}`)) continue;
      if (entry.isDirectory()) walk(absolute);
      else paths.push(path);
    }
  }
  walk(root);
  return paths.sort();
}

function verifyArtifact(root: string, artifact: ManifestArtifact): void {
  if (!artifact.path || resolve(root, artifact.path) === root
    || !resolve(root, artifact.path).startsWith(`${root}${sep}`)) {
    throw new Error(`Invalid release artifact path: ${artifact.path}`);
  }
  const absolute = join(root, artifact.path);
  const details = lstatSync(absolute);
  if (artifact.type === "symlink") {
    if (!details.isSymbolicLink() || readlinkSync(absolute) !== artifact.target) {
      throw new Error(`Release artifact drift detected: ${artifact.path}`);
    }
    const resolvedTarget = resolve(dirname(absolute), artifact.target ?? "");
    if (resolvedTarget !== root && !resolvedTarget.startsWith(`${root}${sep}`)) {
      throw new Error(`Release symlink escapes release root: ${artifact.path}`);
    }
    return;
  }
  const bytes = readFileSync(absolute);
  const mode = details.mode & 0o111 ? "0755" : "0644";
  if (!details.isFile() || artifact.mode !== mode || artifact.sizeBytes !== bytes.byteLength
    || !artifact.sha256 || sha256(bytes) !== artifact.sha256) {
    throw new Error(`Release artifact drift detected: ${artifact.path}`);
  }
}

function parseManifest(bytes: Buffer): ReleaseManifest {
  const manifest = JSON.parse(bytes.toString("utf8")) as Partial<ReleaseManifest>;
  if (manifest.schemaVersion !== "ltx-studio-release-manifest.v1"
    || !manifest.source
    || manifest.source.clean !== true
    || !/^[0-9a-f]{40}$/.test(manifest.source.gitCommit)
    || !Array.isArray(manifest.artifacts)) {
    throw new Error("Release manifest schema or source state is invalid");
  }
  if (canonicalJson(manifest) !== bytes.toString("utf8")) {
    throw new Error("Release manifest is not canonically serialized");
  }
  return manifest as ReleaseManifest;
}

export function loadReleaseIdentity(options: {
  root: string;
  sealed: boolean;
  expectedDigest?: string;
}): ReleaseIdentity {
  if (!options.sealed) {
    return {
      sealed: false,
      verified: false,
      releaseDigest: null,
      manifestSha256: null,
      sourceCommit: null,
    };
  }
  if (!options.expectedDigest || !SHA256_PATTERN.test(options.expectedDigest)) {
    throw new Error("LTX_STUDIO_EXPECTED_RELEASE_DIGEST is required for a sealed release");
  }
  const root = resolve(options.root);
  const manifestBytes = readFileSync(join(root, "release-manifest.json"));
  const digest = sha256(manifestBytes);
  const digestFile = readFileSync(join(root, "release-manifest.sha256"), "utf8").trim();
  if (digest !== options.expectedDigest || digestFile !== `${digest}  release-manifest.json`) {
    throw new Error("Release digest does not match the expected sealed identity");
  }
  const manifest = parseManifest(manifestBytes);
  const expectedPaths = manifest.artifacts.map(({ path }) => path).sort();
  if (new Set(expectedPaths).size !== expectedPaths.length
    || canonicalJson(expectedPaths) !== canonicalJson(artifactPaths(root))) {
    throw new Error("Release artifact set drift detected");
  }
  for (const artifact of manifest.artifacts) verifyArtifact(root, artifact);
  return {
    sealed: true,
    verified: true,
    releaseDigest: digest,
    manifestSha256: digest,
    sourceCommit: manifest.source.gitCommit,
  };
}

export const releaseIdentity = loadReleaseIdentity({
  root: repoRoot,
  sealed: sealedRelease,
  expectedDigest: process.env.LTX_STUDIO_EXPECTED_RELEASE_DIGEST,
});
