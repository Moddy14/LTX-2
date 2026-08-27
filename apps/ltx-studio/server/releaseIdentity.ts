import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  assertRuntimeTrustAuthorizesRelease,
  runtimeTrustBindingSchema,
  type RuntimeTrustBinding,
} from "../shared/runtimeTrust.js";
import {
  verifyRuntimeInstallSeal,
  verifyTrustedReleaseRootLocation,
} from "../scripts/runtime-install-seal-lib.mjs";
import { verifyHostTcbContract } from "../scripts/host-tcb-lib.mjs";
import {
  readExternalRuntimeIdentityPin,
  verifyExternalRuntimeTrust,
} from "../scripts/runtime-trust-verifier-lib.mjs";
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
  schemaVersion: "ltx-studio-release-manifest.v4";
  source: { gitCommit: string; clean: boolean };
  tools: {
    node: {
      version: string;
      sha256: string;
      runtimePath: "apps/ltx-studio/runtime/.venv/bin/node";
      licensePath: "apps/ltx-studio/runtime/NODE-LICENSE";
      licenseSha256: string;
    };
    uv: {
      version: string;
      sha256: string;
      runtimePath: "apps/ltx-studio/runtime/toolchain/uv";
      licensePath: "apps/ltx-studio/runtime/UV-LICENSE";
      licenseSha256: string;
    };
  };
  surface: { path: "apps/ltx-studio/release/candidate-release-surface.v1.json"; sha256: string };
  hostTcb: {
    schemaVersion: "ltx-studio-host-tcb.v2";
    tools: unknown[];
    runtimeComponents: unknown[];
    dockerImages: unknown[];
  };
  sbom: {
    schemaVersion: "ltx-studio-static-sbom.v3";
    runtimeTcbComponents: unknown[];
    hostTcbTools: unknown[];
    hostTcbDockerImages: unknown[];
    buildTcbComponents: unknown[];
    hostRuntimeComponents: unknown[];
    containerRuntimeComponents: unknown[];
  };
  buildTcb: {
    path: "apps/ltx-studio/release/build-tcb.v1.json";
    sha256: string;
    externalPolicySha256: string;
  };
  artifacts: ManifestArtifact[];
};

export type ReleaseIdentity = {
  sealed: boolean;
  verified: boolean;
  releaseDigest: string | null;
  manifestSha256: string | null;
  surfaceDigest: string | null;
  sourceCommit: string | null;
  runtimeInstallSealSha256: string | null;
  runtimeTreeSha256: string | null;
  runtimePolicySha256: string | null;
  nodeExecutableSha256: string | null;
  expectedHostTcbAttestationSha256: string | null;
  runtimeTrust: RuntimeTrustBinding | null;
};

type RuntimeIdentityPin = {
  schemaVersion: "ltx-studio-external-runtime-identity-pin.v1";
  releaseDigest: string;
  runtimeInstallSealSha256: string;
  runtimeTreeSha256: string;
  runtimePolicySha256: string;
  nodeExecutableSha256: string;
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
        || path === "apps/ltx-studio/runtime/runtime-install-seal.json"
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
  if (manifest.schemaVersion !== "ltx-studio-release-manifest.v4"
    || !manifest.source
    || manifest.source.clean !== true
    || !/^[0-9a-f]{40}$/.test(manifest.source.gitCommit)
    || !manifest.surface
    || manifest.surface.path !== "apps/ltx-studio/release/candidate-release-surface.v1.json"
    || !SHA256_PATTERN.test(manifest.surface.sha256)
    || !manifest.tools?.node
    || typeof manifest.tools.node.version !== "string"
    || !SHA256_PATTERN.test(manifest.tools.node.sha256)
    || manifest.tools.node.runtimePath !== "apps/ltx-studio/runtime/.venv/bin/node"
    || manifest.tools.node.licensePath !== "apps/ltx-studio/runtime/NODE-LICENSE"
    || !SHA256_PATTERN.test(manifest.tools.node.licenseSha256)
    || !manifest.tools?.uv
    || typeof manifest.tools.uv.version !== "string"
    || !SHA256_PATTERN.test(manifest.tools.uv.sha256)
    || manifest.tools.uv.runtimePath !== "apps/ltx-studio/runtime/toolchain/uv"
    || manifest.tools.uv.licensePath !== "apps/ltx-studio/runtime/UV-LICENSE"
    || !SHA256_PATTERN.test(manifest.tools.uv.licenseSha256)
    || manifest.hostTcb?.schemaVersion !== "ltx-studio-host-tcb.v2"
    || !Array.isArray(manifest.hostTcb.tools)
    || !Array.isArray(manifest.hostTcb.runtimeComponents)
    || !Array.isArray(manifest.hostTcb.dockerImages)
    || manifest.sbom?.schemaVersion !== "ltx-studio-static-sbom.v3"
    || canonicalJson(manifest.sbom.runtimeTcbComponents) !== canonicalJson(manifest.hostTcb.runtimeComponents)
    || canonicalJson(manifest.sbom.hostTcbTools) !== canonicalJson(manifest.hostTcb.tools)
    || canonicalJson(manifest.sbom.hostTcbDockerImages) !== canonicalJson(manifest.hostTcb.dockerImages)
    || !Array.isArray(manifest.sbom.buildTcbComponents)
    || !Array.isArray(manifest.sbom.hostRuntimeComponents)
    || !Array.isArray(manifest.sbom.containerRuntimeComponents)
    || manifest.buildTcb?.path !== "apps/ltx-studio/release/build-tcb.v1.json"
    || !SHA256_PATTERN.test(manifest.buildTcb.sha256)
    || !SHA256_PATTERN.test(manifest.buildTcb.externalPolicySha256)
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
  expectedRuntimeSealSha256?: string;
  expectedHostTcbAttestationSha256?: string;
  expectedRuntimeTrust?: RuntimeTrustBinding;
  nodeExecutable?: string;
  trustedParent?: false | {
    expectedParent?: string;
    trustAnchor?: string;
    expectedUid?: number;
    expectedGid?: number;
  };
  ownership?: {
    expectedUid?: number;
    expectedGid?: number;
    requireReadOnly?: boolean;
  };
  hostTcbVerifier?: false | typeof verifyHostTcbContract;
  runtimeTrustVerifier?: typeof verifyExternalRuntimeTrust;
  runtimeTrustVerifierOptions?: Record<string, unknown>;
  captureElfClosure?: (path: string, options?: unknown) => unknown;
  capturePostInstallHostClosure?: (options?: unknown) => unknown;
}): ReleaseIdentity {
  if (!options.sealed) {
    return {
      sealed: false,
      verified: false,
      releaseDigest: null,
      manifestSha256: null,
      surfaceDigest: null,
      sourceCommit: null,
      runtimeInstallSealSha256: null,
      runtimeTreeSha256: null,
      runtimePolicySha256: null,
      nodeExecutableSha256: null,
      expectedHostTcbAttestationSha256: null,
      runtimeTrust: null,
    };
  }
  if (!options.expectedDigest || !SHA256_PATTERN.test(options.expectedDigest)) {
    throw new Error("LTX_STUDIO_EXPECTED_RELEASE_DIGEST is required for a sealed release");
  }
  const root = resolve(options.root);
  let externalPin: RuntimeIdentityPin | null = null;
  if (!options.expectedRuntimeSealSha256) {
    try {
      externalPin = readExternalRuntimeIdentityPin(root, options.expectedDigest) as RuntimeIdentityPin;
    } catch (error) {
      throw new Error(
        `LTX_STUDIO_EXPECTED_RUNTIME_INSTALL_SEAL_SHA256 or a valid external runtime identity pin is required: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const expectedRuntimeSealSha256 = options.expectedRuntimeSealSha256
    ?? externalPin?.runtimeInstallSealSha256;
  if (!expectedRuntimeSealSha256 || !SHA256_PATTERN.test(expectedRuntimeSealSha256)) {
    throw new Error(
      "LTX_STUDIO_EXPECTED_RUNTIME_INSTALL_SEAL_SHA256 is required for a sealed release",
    );
  }
  const manifestBytes = readFileSync(join(root, "release-manifest.json"));
  const digest = sha256(manifestBytes);
  const digestFile = readFileSync(join(root, "release-manifest.sha256"), "utf8");
  const digestMatch = /^([0-9a-f]{64}) {2}release-manifest\.json\n$/.exec(digestFile);
  if (digest !== options.expectedDigest || digestMatch?.[1] !== digest) {
    throw new Error("Release digest does not match the expected sealed identity");
  }
  const manifest = parseManifest(manifestBytes);
  if (options.trustedParent !== false) {
    verifyTrustedReleaseRootLocation(root, digest, options.trustedParent ?? {});
  }
  const surfaceArtifact = manifest.artifacts.find(({ path }) => path === manifest.surface.path);
  if (surfaceArtifact?.type !== "file" || surfaceArtifact.sha256 !== manifest.surface.sha256) {
    throw new Error("Release surface digest is not bound to its manifest artifact");
  }
  const buildTcbArtifact = manifest.artifacts.find(({ path }) => path === manifest.buildTcb.path);
  if (buildTcbArtifact?.type !== "file" || buildTcbArtifact.sha256 !== manifest.buildTcb.sha256) {
    throw new Error("Build-TCB digest is not bound to its exact manifest artifact");
  }
  const buildTcbBytes = readFileSync(join(root, manifest.buildTcb.path));
  const buildTcbRecord = JSON.parse(buildTcbBytes.toString("utf8")) as {
    schemaVersion?: unknown;
    source?: { gitCommit?: unknown; gitTree?: unknown };
    externalPolicySha256?: unknown;
    nodeModules?: { packageTreeComponents?: unknown };
  };
  if (canonicalJson(buildTcbRecord) !== buildTcbBytes.toString("utf8")
    || sha256(buildTcbBytes) !== manifest.buildTcb.sha256
    || buildTcbRecord.schemaVersion !== "ltx-studio-build-tcb.v1"
    || buildTcbRecord.source?.gitCommit !== manifest.source.gitCommit
    || buildTcbRecord.externalPolicySha256 !== manifest.buildTcb.externalPolicySha256
    || canonicalJson(buildTcbRecord.nodeModules?.packageTreeComponents)
      !== canonicalJson(manifest.sbom.buildTcbComponents)) {
    throw new Error("Build-TCB record, source, external policy, or development SBOM binding is invalid");
  }
  const nodeLicenseArtifact = manifest.artifacts.find(
    ({ path }) => path === manifest.tools.node.licensePath,
  );
  if (nodeLicenseArtifact?.type !== "file"
    || nodeLicenseArtifact.sha256 !== manifest.tools.node.licenseSha256) {
    throw new Error("Production Node license is not bound to the release manifest");
  }
  const uvLicenseArtifact = manifest.artifacts.find(
    ({ path }) => path === manifest.tools.uv.licensePath,
  );
  const uvExecutableArtifact = manifest.artifacts.find(
    ({ path }) => path === manifest.tools.uv.runtimePath,
  );
  if (uvLicenseArtifact?.type !== "file"
    || uvLicenseArtifact.sha256 !== manifest.tools.uv.licenseSha256
    || uvExecutableArtifact?.type !== "file"
    || uvExecutableArtifact.sha256 !== manifest.tools.uv.sha256) {
    throw new Error("uv executable and license are not bound to the release manifest");
  }
  const expectedPaths = manifest.artifacts.map(({ path }) => path).sort();
  if (new Set(expectedPaths).size !== expectedPaths.length
    || canonicalJson(expectedPaths) !== canonicalJson(artifactPaths(root))) {
    throw new Error("Release artifact set drift detected");
  }
  for (const artifact of manifest.artifacts) verifyArtifact(root, artifact);
  const runtimeSeal = verifyRuntimeInstallSeal(root, manifest, digest, {
    ownership: options.ownership ?? {
      expectedUid: 0,
      expectedGid: 0,
      requireReadOnly: true,
    },
  });
  if (runtimeSeal.sealSha256 !== expectedRuntimeSealSha256) {
    throw new Error("Runtime install seal does not match the externally pinned startup identity");
  }
  const seal = runtimeSeal.seal as {
    policySha256?: unknown;
    tree?: { treeSha256?: unknown };
    executables?: { nodePath?: unknown; nodeSha256?: unknown };
  };
  if (!SHA256_PATTERN.test(String(seal.policySha256 ?? ""))
    || !SHA256_PATTERN.test(String(seal.tree?.treeSha256 ?? ""))
    || seal.executables?.nodePath !== manifest.tools.node.runtimePath
    || seal.executables?.nodeSha256 !== manifest.tools.node.sha256) {
    throw new Error("Runtime install seal does not expose a complete bound runtime identity");
  }
  if (externalPin && (externalPin.runtimeTreeSha256 !== seal.tree?.treeSha256
    || externalPin.runtimePolicySha256 !== seal.policySha256
    || externalPin.nodeExecutableSha256 !== manifest.tools.node.sha256)) {
    throw new Error("External runtime identity pin does not bind the complete verified runtime identity");
  }
  let runtimeTrust: RuntimeTrustBinding;
  if (options.hostTcbVerifier !== false) {
    if (!options.expectedHostTcbAttestationSha256
      || !SHA256_PATTERN.test(options.expectedHostTcbAttestationSha256)) {
      throw new Error("LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256 is required for a sealed release");
    }
    runtimeTrust = runtimeTrustBindingSchema.parse(
      (options.runtimeTrustVerifier ?? verifyExternalRuntimeTrust)({
        ...(options.runtimeTrustVerifierOptions ?? {}),
        releaseRoot: root,
        releaseDigest: digest,
        manifest,
        runtimeIdentity: {
          runtimeInstallSealSha256: runtimeSeal.sealSha256,
          runtimeTreeSha256: String(seal.tree?.treeSha256),
          runtimePolicySha256: String(seal.policySha256),
          nodeExecutableSha256: manifest.tools.node.sha256,
        },
        captureElfClosure: options.captureElfClosure,
        capturePostInstallHostClosure: options.capturePostInstallHostClosure,
      }),
    );
    if (runtimeTrust.hostTcbAttestationSha256 !== options.expectedHostTcbAttestationSha256) {
      throw new Error("External RuntimeTrust differs from the separately loaded startup Host-TCB pin");
    }
  } else {
    if (!options.expectedRuntimeTrust) {
      throw new Error("A complete explicit RuntimeTrust fixture is required when Host-TCB verification is disabled");
    }
    runtimeTrust = runtimeTrustBindingSchema.parse(options.expectedRuntimeTrust);
  }
  if (runtimeTrust.hostTcbContractSha256 !== sha256(Buffer.from(canonicalJson(manifest.hostTcb)))
    || runtimeTrust.buildTcbSha256 !== manifest.buildTcb.sha256
    || (options.expectedRuntimeTrust
      && canonicalJson(runtimeTrust) !== canonicalJson(runtimeTrustBindingSchema.parse(options.expectedRuntimeTrust)))) {
    throw new Error("RuntimeTrust is bound to a different HostContract, BuildTCB, or external trust policy set");
  }
  const expectedNodeExecutable = resolve(root, manifest.tools.node.runtimePath);
  const actualNodeExecutable = resolve(options.nodeExecutable ?? process.execPath);
  if (realpathSync(actualNodeExecutable) !== realpathSync(expectedNodeExecutable)) {
    throw new Error("Sealed server must execute with the Node binary inside the sealed runtime");
  }
  return {
    sealed: true,
    verified: true,
    releaseDigest: digest,
    manifestSha256: digest,
    surfaceDigest: manifest.surface.sha256,
    sourceCommit: manifest.source.gitCommit,
    runtimeInstallSealSha256: runtimeSeal.sealSha256,
    runtimeTreeSha256: String(seal.tree?.treeSha256),
    runtimePolicySha256: String(seal.policySha256),
    nodeExecutableSha256: manifest.tools.node.sha256,
    expectedHostTcbAttestationSha256: options.expectedHostTcbAttestationSha256 ?? null,
    runtimeTrust,
  };
}

const configuredIdentityOptions = {
  root: repoRoot,
  sealed: sealedRelease,
  expectedDigest: process.env.LTX_STUDIO_EXPECTED_RELEASE_DIGEST,
  expectedRuntimeSealSha256: process.env.LTX_STUDIO_EXPECTED_RUNTIME_INSTALL_SEAL_SHA256,
  expectedHostTcbAttestationSha256: process.env.LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256,
} as const;

export const releaseIdentity = loadReleaseIdentity(configuredIdentityOptions);

export function revalidateReleaseIdentity(): ReleaseIdentity {
  return loadReleaseIdentity(configuredIdentityOptions);
}

export function revalidateSealedRuntimeTrustIdentity(
  expected: ReleaseIdentity = releaseIdentity,
): RuntimeTrustBinding {
  if (!expected.sealed || !expected.verified || !expected.runtimeTrust) {
    throw new Error("Spawn-adjacent RuntimeTrust revalidation requires a verified sealed identity");
  }
  const current = revalidateReleaseIdentity();
  for (const key of [
    "releaseDigest",
    "manifestSha256",
    "surfaceDigest",
    "sourceCommit",
    "runtimeInstallSealSha256",
    "runtimeTreeSha256",
    "runtimePolicySha256",
    "nodeExecutableSha256",
    "expectedHostTcbAttestationSha256",
  ] as const) {
    if (current[key] !== expected[key]) throw new Error(`Spawn-adjacent sealed identity drifted at ${key}`);
  }
  const runtimeTrust = runtimeTrustBindingSchema.parse(current.runtimeTrust);
  if (canonicalJson(runtimeTrust) !== canonicalJson(expected.runtimeTrust)) {
    throw new Error("Spawn-adjacent sealed RuntimeTrust drifted");
  }
  assertRuntimeTrustAuthorizesRelease(runtimeTrust, "Spawn-adjacent execution");
  return runtimeTrust;
}
