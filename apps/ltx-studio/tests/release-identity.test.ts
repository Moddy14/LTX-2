import { createHash } from "node:crypto";
import { getgid, getuid } from "node:process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalJson } from "../shared/canonicalJson.js";
import { loadReleaseIdentity as loadReleaseIdentityRaw } from "../server/releaseIdentity.js";
import {
  createRuntimeInstallSeal,
  digestRuntimeTree,
  runtimeInstallIntegrityPolicy,
} from "../scripts/runtime-install-seal-lib.mjs";
import { runtimeTrustFixture } from "./runtime-trust-fixture.js";
import {
  assertRuntimeTrustAuthorizesRelease,
  runtimeTrustBindingSchema,
} from "../shared/runtimeTrust.js";

const roots: string[] = [];

const loadReleaseIdentity = (
  options: Parameters<typeof loadReleaseIdentityRaw>[0],
) => loadReleaseIdentityRaw({ ...options, hostTcbVerifier: false });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ltx-release-identity-"));
  roots.push(root);
  mkdirSync(join(root, "server"));
  mkdirSync(join(root, "apps", "ltx-studio", "release"), { recursive: true });
  mkdirSync(join(root, "apps", "ltx-studio", "runtime", ".venv", "bin"), { recursive: true });
  mkdirSync(join(root, "apps", "ltx-studio", "scripts"), { recursive: true });
  const artifact = Buffer.from("sealed\n");
  const surfaceArtifact = Buffer.from("{}\n");
  writeFileSync(join(root, "server", "index.js"), artifact, { mode: 0o644 });
  writeFileSync(
    join(root, "apps", "ltx-studio", "release", "candidate-release-surface.v1.json"),
    surfaceArtifact,
    { mode: 0o644 },
  );
  const nodeBytes = Buffer.from("#!/bin/sh\nexit 0\n");
  const nodeExecutable = join(root, "apps", "ltx-studio", "runtime", ".venv", "bin", "node");
  writeFileSync(nodeExecutable, nodeBytes, { mode: 0o755 });
  const staticInputs = new Map([
    ["apps/ltx-studio/package-lock.json", "node-lock\n"],
    ["apps/ltx-studio/runtime/uv.lock", "python-lock\n"],
    ["apps/ltx-studio/runtime/pyproject.toml", "[project]\nname='fixture'\n"],
    ["apps/ltx-studio/runtime/verify_runtime.py", "print('ok')\n"],
    ["apps/ltx-studio/runtime/NODE-LICENSE", "Node.js license fixture\n"],
    ["apps/ltx-studio/runtime/UV-LICENSE", "uv license fixture\n"],
    ["apps/ltx-studio/scripts/runtime-install-seal-lib.mjs", "export {};\n"],
  ]);
  for (const [path, content] of staticInputs) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content, { mode: 0o644 });
  }
  writeFileSync(
    join(root, "apps", "ltx-studio", "runtime", ".venv", "runtime.bin"),
    "runtime-content\n",
    { mode: 0o644 },
  );
  const uvBytes = Buffer.from("#!/bin/sh\nexit 0\n");
  const uvExecutable = join(root, "apps", "ltx-studio", "runtime", "toolchain", "uv");
  mkdirSync(dirname(uvExecutable), { recursive: true });
  writeFileSync(uvExecutable, uvBytes, { mode: 0o755 });
  const surfaceDigest = createHash("sha256").update(surfaceArtifact).digest("hex");
  const fileArtifact = (path: string, bytes: Buffer) => ({
    path,
    type: "file" as const,
    mode: "0644" as const,
    sizeBytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const staticArtifacts = [...staticInputs].map(([path, content]) =>
    fileArtifact(path, Buffer.from(content)));
  const buildTcbComponents = [{ name: "vite", version: "7.1.4" }];
  const buildTcb = {
    schemaVersion: "ltx-studio-build-tcb.v1",
    source: { gitCommit: "a".repeat(40), gitTree: "b".repeat(40) },
    externalPolicySha256: "9".repeat(64),
    nodeModules: { packageTreeComponents: buildTcbComponents },
  };
  const buildTcbBytes = Buffer.from(canonicalJson(buildTcb));
  const buildTcbPath = "apps/ltx-studio/release/build-tcb.v1.json";
  writeFileSync(join(root, buildTcbPath), buildTcbBytes, { mode: 0o644 });
  const manifest = {
    schemaVersion: "ltx-studio-release-manifest.v4",
    source: { gitCommit: "a".repeat(40), clean: true },
    tools: {
      node: {
        version: "v24.0.0",
        sha256: createHash("sha256").update(nodeBytes).digest("hex"),
        runtimePath: "apps/ltx-studio/runtime/.venv/bin/node" as const,
        licensePath: "apps/ltx-studio/runtime/NODE-LICENSE" as const,
        licenseSha256: createHash("sha256").update("Node.js license fixture\n").digest("hex"),
      },
      uv: {
        version: "uv 0.12.2",
        sha256: createHash("sha256").update(uvBytes).digest("hex"),
        runtimePath: "apps/ltx-studio/runtime/toolchain/uv" as const,
        licensePath: "apps/ltx-studio/runtime/UV-LICENSE" as const,
        licenseSha256: createHash("sha256").update("uv license fixture\n").digest("hex"),
      },
    },
    surface: {
      path: "apps/ltx-studio/release/candidate-release-surface.v1.json",
      sha256: surfaceDigest,
    },
    locks: {
      node: staticArtifacts.find(({ path }) => path.endsWith("package-lock.json"))!.sha256,
      python: staticArtifacts.find(({ path }) => path.endsWith("uv.lock"))!.sha256,
    },
    runtimeInstallIntegrity: runtimeInstallIntegrityPolicy(),
    runtimeInstallInventory: {
      schemaVersion: "ltx-studio-runtime-install-inventory.v3",
      tree: digestRuntimeTree(join(root, "apps", "ltx-studio", "runtime", ".venv")),
    },
    hostTcb: {
      schemaVersion: "ltx-studio-host-tcb.v2" as const,
      tools: [],
      runtimeComponents: [],
      dockerImages: [],
      controlPlane: {},
    },
    sbom: {
      schemaVersion: "ltx-studio-static-sbom.v3" as const,
      runtimeTcbComponents: [],
      hostTcbTools: [],
      hostTcbDockerImages: [],
      buildTcbComponents,
      hostRuntimeComponents: [],
      containerRuntimeComponents: [],
    },
    buildTcb: {
      path: buildTcbPath as "apps/ltx-studio/release/build-tcb.v1.json",
      sha256: createHash("sha256").update(buildTcbBytes).digest("hex"),
      externalPolicySha256: buildTcb.externalPolicySha256,
    },
    artifacts: [
      fileArtifact(
        "apps/ltx-studio/release/candidate-release-surface.v1.json",
        surfaceArtifact,
      ),
      fileArtifact(buildTcbPath, buildTcbBytes),
      ...staticArtifacts,
      {
        ...fileArtifact("apps/ltx-studio/runtime/toolchain/uv", uvBytes),
        mode: "0755" as const,
      },
      fileArtifact("server/index.js", artifact),
    ].sort((left, right) => left.path.localeCompare(right.path)),
  };
  const manifestBytes = Buffer.from(canonicalJson(manifest));
  const digest = createHash("sha256").update(manifestBytes).digest("hex");
  writeFileSync(join(root, "release-manifest.json"), manifestBytes);
  writeFileSync(join(root, "release-manifest.sha256"), `${digest}  release-manifest.json\n`);
  const runtimeSeal = createRuntimeInstallSeal(root, manifest, digest);
  const runtimeTrust = {
    ...runtimeTrustFixture,
    hostTcbContractSha256: createHash("sha256")
      .update(canonicalJson(manifest.hostTcb))
      .digest("hex"),
    buildTcbSha256: manifest.buildTcb.sha256,
  };
  return { root, digest, manifest, runtimeSeal, nodeExecutable, runtimeTrust };
}

const testOwnership = {
  expectedUid: getuid!(),
  expectedGid: getgid!(),
  requireReadOnly: false,
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sealed release identity", () => {
  it("keeps development explicitly unattested", () => {
    expect(loadReleaseIdentity({ root: "/unused", sealed: false })).toEqual({
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
    });
  });

  it("accepts only the expected digest and complete artifact set", () => {
    const { root, digest, runtimeSeal, nodeExecutable, runtimeTrust } = fixture();
    expect(() => loadReleaseIdentity({
      root,
      sealed: true,
      expectedDigest: digest,
      nodeExecutable,
      trustedParent: false,
      ownership: testOwnership,
      expectedRuntimeTrust: runtimeTrust,
    })).toThrow(/EXPECTED_RUNTIME_INSTALL_SEAL_SHA256/);
    expect(loadReleaseIdentity({
      root,
      sealed: true,
      expectedDigest: digest,
      expectedRuntimeSealSha256: runtimeSeal.sealSha256,
      nodeExecutable,
      trustedParent: false,
      ownership: testOwnership,
      expectedRuntimeTrust: runtimeTrust,
    })).toMatchObject({
      sealed: true,
      verified: true,
      releaseDigest: digest,
      surfaceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      sourceCommit: "a".repeat(40),
    });
    expect(() => loadReleaseIdentity({
      root,
      sealed: true,
      expectedDigest: "b".repeat(64),
      expectedRuntimeSealSha256: runtimeSeal.sealSha256,
      nodeExecutable,
      trustedParent: false,
      ownership: testOwnership,
      expectedRuntimeTrust: runtimeTrust,
    }))
      .toThrow(/expected sealed identity/);
  });

  it("rejects artifact drift", () => {
    const { root, digest, runtimeSeal, nodeExecutable, runtimeTrust } = fixture();
    writeFileSync(join(root, "server", "index.js"), "changed\n");
    expect(() => loadReleaseIdentity({
      root,
      sealed: true,
      expectedDigest: digest,
      expectedRuntimeSealSha256: runtimeSeal.sealSha256,
      nodeExecutable,
      trustedParent: false,
      ownership: testOwnership,
      expectedRuntimeTrust: runtimeTrust,
    }))
      .toThrow(/artifact drift/);
  });

  it("fails sealed startup closed on a missing seal or runtime-tree drift", () => {
    const missing = fixture();
    unlinkSync(join(
      missing.root,
      "apps",
      "ltx-studio",
      "runtime",
      "runtime-install-seal.json",
    ));
    expect(() => loadReleaseIdentity({
      root: missing.root,
      sealed: true,
      expectedDigest: missing.digest,
      expectedRuntimeSealSha256: missing.runtimeSeal.sealSha256,
      nodeExecutable: missing.nodeExecutable,
      trustedParent: false,
      ownership: testOwnership,
      expectedRuntimeTrust: missing.runtimeTrust,
    })).toThrow();

    const changed = fixture();
    writeFileSync(
      join(changed.root, "apps", "ltx-studio", "runtime", ".venv", "runtime.bin"),
      "changed-runtime\n",
    );
    expect(() => loadReleaseIdentity({
      root: changed.root,
      sealed: true,
      expectedDigest: changed.digest,
      expectedRuntimeSealSha256: changed.runtimeSeal.sealSha256,
      nodeExecutable: changed.nodeExecutable,
      trustedParent: false,
      ownership: testOwnership,
      expectedRuntimeTrust: changed.runtimeTrust,
    })).toThrow(/runtime (tree|inventory).*does not match|does not match.*runtime/i);
  });

  it("pins the exact installed seal and the in-tree Node executable", () => {
    const value = fixture();
    unlinkSync(value.runtimeSeal.sealPath);
    writeFileSync(
      join(value.root, "apps", "ltx-studio", "runtime", ".venv", "runtime.bin"),
      "different-but-valid-runtime\n",
    );
    expect(() => createRuntimeInstallSeal(value.root, value.manifest, value.digest))
      .toThrow(/exact manifest runtime inventory/i);
    expect(() => loadReleaseIdentity({
      root: value.root,
      sealed: true,
      expectedDigest: value.digest,
      expectedRuntimeSealSha256: value.runtimeSeal.sealSha256,
      nodeExecutable: value.nodeExecutable,
      trustedParent: false,
      ownership: testOwnership,
      expectedRuntimeTrust: value.runtimeTrust,
    })).toThrow(/runtime-install-seal|no such file|runtime inventory/i);
    const intact = fixture();
    expect(() => loadReleaseIdentity({
      root: intact.root,
      sealed: true,
      expectedDigest: intact.digest,
      expectedRuntimeSealSha256: intact.runtimeSeal.sealSha256,
      nodeExecutable: process.execPath,
      trustedParent: false,
      ownership: testOwnership,
      expectedRuntimeTrust: intact.runtimeTrust,
    })).toThrow(/Node binary inside the sealed runtime/i);
  });

  it("loads a broker-isolated identity only when host-TCB and broker digests remain independently valid", () => {
    const value = fixture();
    const brokerRuntimeTrust = runtimeTrustBindingSchema.parse({
      ...value.runtimeTrust,
      authorityIsolation: {
        schemaVersion: "ltx-studio-authority-isolation.v1",
        status: "attested",
        mechanism: "external-signer-sealed-fd-broker",
        hostTcbAttestationSha256: value.runtimeTrust.hostTcbAttestationSha256,
        brokerAttestationSha256: "f".repeat(64),
        reasonCode: null,
      },
    });
    expect(assertRuntimeTrustAuthorizesRelease(brokerRuntimeTrust).authorityIsolation)
      .toMatchObject({
        hostTcbAttestationSha256: value.runtimeTrust.hostTcbAttestationSha256,
        brokerAttestationSha256: "f".repeat(64),
      });
    const common = {
      root: value.root,
      sealed: true,
      expectedDigest: value.digest,
      expectedRuntimeSealSha256: value.runtimeSeal.sealSha256,
      expectedHostTcbAttestationSha256: value.runtimeTrust.hostTcbAttestationSha256,
      nodeExecutable: value.nodeExecutable,
      trustedParent: false as const,
      ownership: testOwnership,
    };
    expect(loadReleaseIdentityRaw({
      ...common,
      runtimeTrustVerifier: () => brokerRuntimeTrust,
    })).toMatchObject({ runtimeTrust: brokerRuntimeTrust });
    expect(() => loadReleaseIdentityRaw({
      ...common,
      runtimeTrustVerifier: () => ({
        ...brokerRuntimeTrust,
        hostTcbAttestationSha256: "e".repeat(64),
      }),
    })).toThrow(/Host-TCB pin|attestation/i);
    expect(() => loadReleaseIdentityRaw({
      ...common,
      runtimeTrustVerifier: () => ({
        ...brokerRuntimeTrust,
        authorityIsolation: {
          ...brokerRuntimeTrust.authorityIsolation,
          brokerAttestationSha256: "tampered",
        },
      }),
    })).toThrow();
  });
});
