import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";

import {
  canonicalJson,
  releaseArtifacts,
  sha256Bytes,
} from "./release-manifest-lib.mjs";

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

function readStableRegularFile(
  absolute,
  { maximumBytes, requireOwnerOnly = false },
) {
  const metadata = lstatSync(absolute);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0 ||
    metadata.size > maximumBytes ||
    (requireOwnerOnly &&
      ((metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.geteuid()))
  ) {
    throw new Error(`Unsafe file permissions or type: ${absolute}`);
  }
  const descriptor = openSync(
    absolute,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(descriptor);
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.size !== metadata.size
    ) {
      throw new Error(`File changed while opening: ${absolute}`);
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function loadVerifiedReleaseRoot(releaseRoot, expectedReleaseDigest) {
  const resolvedRoot = resolve(releaseRoot);
  const manifestBytes = readStableRegularFile(
    resolve(resolvedRoot, "release-manifest.json"),
    { maximumBytes: MAX_EVIDENCE_BYTES },
  );
  const releaseDigest = sha256Bytes(manifestBytes);
  if (releaseDigest !== expectedReleaseDigest)
    throw new Error("Release manifest digest does not match --release");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.schemaVersion !== "ltx-studio-release-manifest.v1" ||
    canonicalJson(manifest) !== manifestBytes.toString("utf8")
  ) {
    throw new Error("Release manifest is not a canonical supported manifest");
  }
  if (
    canonicalJson(releaseArtifacts(resolvedRoot)) !==
    canonicalJson(manifest.artifacts)
  ) {
    throw new Error("Release artifact drift detected before audit");
  }
  return { releaseRoot: resolvedRoot, releaseDigest, manifest };
}

export function openEvidenceRoot(root) {
  const evidenceRoot = resolve(root);
  const metadata = lstatSync(evidenceRoot);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o022) !== 0
  ) {
    throw new Error(
      "Evidence root must be a real directory without group/world write access",
    );
  }
  const realRoot = realpathSync(evidenceRoot);

  function resolveChild(path) {
    const absolute = resolve(evidenceRoot, path);
    if (!absolute.startsWith(`${evidenceRoot}${sep}`))
      throw new Error(`Evidence path escapes root: ${path}`);
    return absolute;
  }

  function readBytes(path) {
    const absolute = resolveChild(path);
    const real = realpathSync(absolute);
    if (!real.startsWith(`${realRoot}${sep}`))
      throw new Error(`Evidence path escapes real root: ${path}`);
    return readStableRegularFile(absolute, {
      maximumBytes: MAX_EVIDENCE_BYTES,
    });
  }

  function readJson(path) {
    const bytes = readBytes(path);
    const document = JSON.parse(bytes.toString("utf8"));
    if (canonicalJson(document) !== bytes.toString("utf8"))
      throw new Error(`Evidence is not canonical JSON: ${path}`);
    return { bytes, document };
  }

  function outputPath(path) {
    const absolute = resolve(path);
    if (
      dirname(absolute) !== evidenceRoot ||
      basename(absolute) !== basename(path)
    ) {
      throw new Error(
        "Audit output must be a direct child of the evidence root",
      );
    }
    return absolute;
  }

  function writeCanonicalOnce(path, document) {
    const absolute = outputPath(path);
    writeFileSync(absolute, canonicalJson(document), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return absolute;
  }

  return { evidenceRoot, readBytes, readJson, outputPath, writeCanonicalOnce };
}

export function readOwnerPrivateKey(path) {
  return readStableRegularFile(resolve(path), {
    maximumBytes: MAX_PRIVATE_KEY_BYTES,
    requireOwnerOnly: true,
  }).toString("utf8");
}
