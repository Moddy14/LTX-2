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
import {
  verifyRuntimeInstallSeal,
  verifyTrustedReleaseRootLocation,
} from "./runtime-install-seal-lib.mjs";
import { verifyHostTcbContract } from "./host-tcb-lib.mjs";
import { verifyExternalRuntimeTrust } from "./runtime-trust-verifier-lib.mjs";

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
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("Release audit file reads require O_NOFOLLOW support");
  }
  const descriptor = openSync(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
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

export function loadVerifiedReleaseRoot(
  releaseRoot,
  expectedReleaseDigest,
  {
    staticOnly = false,
    ownership = { expectedUid: 0, expectedGid: 0, requireReadOnly: true },
    verifyHostTcb = true,
    runtimeTrustVerifier = verifyExternalRuntimeTrust,
    expectedRuntimeTrust,
  } = {},
) {
  const resolvedRoot = verifyTrustedReleaseRootLocation(
    releaseRoot,
    expectedReleaseDigest,
  ).releaseRoot;
  const manifestBytes = readStableRegularFile(
    resolve(resolvedRoot, "release-manifest.json"),
    { maximumBytes: MAX_EVIDENCE_BYTES },
  );
  const releaseDigest = sha256Bytes(manifestBytes);
  if (releaseDigest !== expectedReleaseDigest)
    throw new Error("Release manifest digest does not match --release");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (
    manifest.schemaVersion !== "ltx-studio-release-manifest.v4" ||
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
  const runtimeSeal = staticOnly
    ? null
    : verifyRuntimeInstallSeal(
      resolvedRoot,
      manifest,
      releaseDigest,
      { ownership },
    );
  if (!staticOnly && verifyHostTcb) verifyHostTcbContract(resolvedRoot, manifest.hostTcb);
  const seal = runtimeSeal?.seal;
  const runtimeInstallSealSha256 = runtimeSeal?.sealSha256 ?? null;
  const runtimeTreeSha256 = seal && typeof seal === "object"
    && seal.tree && typeof seal.tree === "object"
    ? seal.tree.treeSha256
    : null;
  const runtimePolicySha256 = seal && typeof seal === "object"
    ? seal.policySha256
    : null;
  const nodeExecutableSha256 = seal && typeof seal === "object"
    && seal.executables && typeof seal.executables === "object"
    ? seal.executables.nodeSha256
    : null;
  if (!staticOnly && ![runtimeInstallSealSha256, runtimeTreeSha256,
    runtimePolicySha256, nodeExecutableSha256]
    .every((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))) {
    throw new Error("Verified runtime seal did not yield a complete runtime identity");
  }
  let runtimeTrust = null;
  if (!staticOnly) {
    if (verifyHostTcb) {
      runtimeTrust = runtimeTrustVerifier({
        releaseRoot: resolvedRoot,
        releaseDigest,
        manifest,
        runtimeIdentity: {
          runtimeInstallSealSha256,
          runtimeTreeSha256,
          runtimePolicySha256,
          nodeExecutableSha256,
        },
      });
    } else {
      runtimeTrust = expectedRuntimeTrust;
    }
    const trustPolicyDigests = runtimeTrust?.trustPolicyDigests;
    const requiredPolicyNames = [
      "activationWriter",
      "bootstrapAuthority",
      "qualificationAuthorizer",
      "release",
      "runtimeRights",
    ];
    if (runtimeTrust?.schemaVersion !== "ltx-studio-runtime-trust-binding.v2"
      || ![runtimeTrust.hostTcbAttestationSha256, runtimeTrust.hostTcbContractSha256,
        runtimeTrust.servicePolicySha256, runtimeTrust.buildTcbSha256]
        .every((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))
      || !runtimeTrust.authorityIsolation
      || runtimeTrust.authorityIsolation.schemaVersion !== "ltx-studio-authority-isolation.v1"
      || (runtimeTrust.authorityIsolation.status === "hold"
        ? canonicalJson(runtimeTrust.authorityIsolation) !== canonicalJson({
            schemaVersion: "ltx-studio-authority-isolation.v1",
            status: "hold",
            mechanism: "same-local-uid",
            attestationSha256: null,
            reasonCode: "same-uid-authority-not-authentic",
          })
        : runtimeTrust.authorityIsolation.status === "attested"
          ? !["separate-studio-identity-proc-fd-isolation", "external-signer-sealed-fd-broker"]
            .includes(runtimeTrust.authorityIsolation.mechanism)
            || !/^[0-9a-f]{64}$/.test(runtimeTrust.authorityIsolation.hostTcbAttestationSha256 ?? "")
            || runtimeTrust.authorityIsolation.hostTcbAttestationSha256 !== runtimeTrust.hostTcbAttestationSha256
            || (runtimeTrust.authorityIsolation.mechanism === "external-signer-sealed-fd-broker"
              ? !/^[0-9a-f]{64}$/.test(runtimeTrust.authorityIsolation.brokerAttestationSha256 ?? "")
              : runtimeTrust.authorityIsolation.brokerAttestationSha256 !== null)
            || runtimeTrust.authorityIsolation.reasonCode !== null
            || canonicalJson(Object.keys(runtimeTrust.authorityIsolation).sort()) !== canonicalJson([
              "brokerAttestationSha256", "hostTcbAttestationSha256", "mechanism", "reasonCode", "schemaVersion", "status",
            ])
          : true)
      || !trustPolicyDigests
      || canonicalJson(Object.keys(trustPolicyDigests).sort()) !== canonicalJson(requiredPolicyNames)
      || !Object.values(trustPolicyDigests)
        .every((value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value))
      || runtimeTrust.hostTcbContractSha256 !== sha256Bytes(Buffer.from(canonicalJson(manifest.hostTcb)))
      || runtimeTrust.buildTcbSha256 !== manifest.buildTcb?.sha256) {
      throw new Error("External RuntimeTrust is incomplete or bound to another HostContract/BuildTCB");
    }
  }
  return {
    releaseRoot: resolvedRoot,
    releaseDigest,
    manifest,
    runtimeInstallSealSha256,
    runtimeTreeSha256,
    runtimePolicySha256,
    nodeExecutableSha256,
    runtimeTrust,
  };
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
