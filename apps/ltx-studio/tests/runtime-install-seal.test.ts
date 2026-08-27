import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRuntimeInstallSeal,
  digestRuntimeTree,
  expectedRuntimeInstallInventory,
  materializeExternalInterpreterSymlinks,
  materializeTrustedExecutable,
  runtimeInstallIntegrityPolicy,
  TRUSTED_RELEASE_PARENT,
  verifyRuntimeInstallSeal,
  verifyTrustedReleaseParent,
  verifyTrustedReleaseRootLocation,
} from "../scripts/runtime-install-seal-lib.mjs";
// @ts-expect-error The immutable operator CLI helper is plain ESM JavaScript.
import { loadVerifiedReleaseRoot } from "../scripts/release-audit-io-lib.mjs";
// @ts-expect-error The release manifest helper is plain ESM JavaScript.
import { canonicalJson, releaseArtifacts } from "../scripts/release-manifest-lib.mjs";
import { runtimeTrustFixture } from "./runtime-trust-fixture.js";

const roots: string[] = [];

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function write(root: string, path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, { mode });
}

function makeWritable(path: string): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    chmodSync(path, 0o755);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else if (details.isFile()) {
    chmodSync(path, details.mode & 0o111 ? 0o755 : 0o644);
  }
}

function makeReadOnly(path: string): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    for (const name of readdirSync(path)) makeReadOnly(join(path, name));
    chmodSync(path, 0o555);
  } else if (details.isFile()) {
    chmodSync(path, details.mode & 0o111 ? 0o555 : 0o444);
  }
}

function fixture() {
  const anchor = mkdtempSync(join(tmpdir(), "ltx-runtime-seal-"));
  roots.push(anchor);
  const releaseParent = join(anchor, "opt", "ltx-studio", "releases");
  let root = join(releaseParent, "candidate");
  mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const path of [join(anchor, "opt"), join(anchor, "opt", "ltx-studio"), releaseParent]) {
    chmodSync(path, 0o755);
  }
  const inputs = new Map([
    ["apps/ltx-studio/package-lock.json", "node-lock\n"],
    ["apps/ltx-studio/runtime/uv.lock", "python-lock\n"],
    ["apps/ltx-studio/runtime/pyproject.toml", "[project]\nname='runtime-fixture'\n"],
    ["apps/ltx-studio/runtime/verify_runtime.py", "print('verified')\n"],
    ["apps/ltx-studio/runtime/NODE-LICENSE", "Node.js license fixture\n"],
    ["apps/ltx-studio/runtime/UV-LICENSE", "uv license fixture\n"],
    ["apps/ltx-studio/scripts/runtime-install-seal-lib.mjs", "export {};\n"],
  ]);
  const buildTcbComponents = [{ name: "vite", version: "7.1.4" }];
  const buildTcb = {
    schemaVersion: "ltx-studio-build-tcb.v1",
    source: { gitCommit: "a".repeat(40), gitTree: "b".repeat(40) },
    externalPolicySha256: "9".repeat(64),
    nodeModules: { packageTreeComponents: buildTcbComponents },
  };
  const buildTcbPath = "apps/ltx-studio/release/build-tcb.v1.json";
  inputs.set(buildTcbPath, canonicalJson(buildTcb));
  for (const [path, content] of inputs) write(root, path, content);
  let runtimeRoot = join(root, "apps", "ltx-studio", "runtime", ".venv");
  write(root, "apps/ltx-studio/runtime/.venv/bin/tool", "executable\n", 0o755);
  const nodeBytes = "#!/bin/sh\nexit 0\n";
  write(root, "apps/ltx-studio/runtime/.venv/bin/node", nodeBytes, 0o755);
  write(root, "apps/ltx-studio/runtime/.venv/lib/module.py", "VALUE = 1\n");
  const uvBytes = "#!/bin/sh\nexit 0\n";
  write(root, "apps/ltx-studio/runtime/toolchain/uv", uvBytes, 0o755);
  makeReadOnly(runtimeRoot);
  const artifacts = [...inputs, ["apps/ltx-studio/runtime/toolchain/uv", uvBytes]].map(([path, content]) => ({
    path,
    type: "file",
    mode: path === "apps/ltx-studio/runtime/toolchain/uv" ? "0755" : "0644",
    sizeBytes: Buffer.byteLength(content),
    sha256: hash(content),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const manifest = {
    schemaVersion: "ltx-studio-release-manifest.v4",
    source: { gitCommit: "a".repeat(40), clean: true },
    tools: {
      node: {
        version: "v24.0.0",
        sha256: hash(nodeBytes),
        runtimePath: "apps/ltx-studio/runtime/.venv/bin/node",
        licensePath: "apps/ltx-studio/runtime/NODE-LICENSE",
        licenseSha256: hash("Node.js license fixture\n"),
      },
      uv: {
        version: "uv 0.12.2",
        sha256: hash(uvBytes),
        runtimePath: "apps/ltx-studio/runtime/toolchain/uv",
        licensePath: "apps/ltx-studio/runtime/UV-LICENSE",
        licenseSha256: hash("uv license fixture\n"),
      },
    },
    locks: {
      node: hash(inputs.get("apps/ltx-studio/package-lock.json")!),
      python: hash(inputs.get("apps/ltx-studio/runtime/uv.lock")!),
    },
    runtimeInstallIntegrity: runtimeInstallIntegrityPolicy(),
    runtimeInstallInventory: expectedRuntimeInstallInventory(runtimeRoot),
    hostTcb: {
      schemaVersion: "ltx-studio-host-tcb.v2",
      tools: [],
      runtimeComponents: [],
      dockerImages: [],
      controlPlane: {},
    },
    sbom: {
      schemaVersion: "ltx-studio-static-sbom.v3",
      runtimeTcbComponents: [],
      hostTcbTools: [],
      hostTcbDockerImages: [],
      buildTcbComponents,
      hostRuntimeComponents: [],
      containerRuntimeComponents: [],
    },
    buildTcb: {
      path: buildTcbPath,
      sha256: hash(inputs.get(buildTcbPath)!),
      externalPolicySha256: buildTcb.externalPolicySha256,
    },
    artifacts,
  };
  const manifestBytes = canonicalJson(manifest);
  const releaseDigest = hash(manifestBytes);
  const finalRoot = join(releaseParent, releaseDigest);
  renameSync(root, finalRoot);
  root = finalRoot;
  runtimeRoot = join(root, "apps", "ltx-studio", "runtime", ".venv");
  writeFileSync(join(root, "release-manifest.json"), manifestBytes, { mode: 0o644 });
  writeFileSync(
    join(root, "release-manifest.sha256"),
    `${releaseDigest}  release-manifest.json\n`,
    { mode: 0o644 },
  );
  const created = createRuntimeInstallSeal(root, manifest, releaseDigest);
  const runtimeTrust = {
    ...runtimeTrustFixture,
    hostTcbContractSha256: hash(canonicalJson(manifest.hostTcb)),
    buildTcbSha256: manifest.buildTcb.sha256,
  };
  return {
    anchor,
    releaseParent,
    root,
    runtimeRoot,
    manifest,
    manifestBytes,
    releaseDigest,
    created,
    runtimeTrust,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!lstatSync(root).isSymbolicLink()) makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runtime install content seal", () => {
  it("binds the final release digest, declared inputs, and the complete runtime tree without a manifest cycle", () => {
    const value = fixture();
    const verified = verifyRuntimeInstallSeal(
      value.root,
      value.manifest,
      value.releaseDigest,
    );

    expect(verified.sealSha256).toBe(value.created.sealSha256);
    expect(verified.seal).toMatchObject({
      releaseDigest: value.releaseDigest,
      runtimeRoot: "apps/ltx-studio/runtime/.venv",
      tree: {
        fileCount: 3,
        directoryCount: 3,
        symlinkCount: 0,
        treeSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(readFileSync(join(value.root, "release-manifest.json"), "utf8"))
      .toBe(value.manifestBytes);
    expect(releaseArtifacts(value.root)).toEqual(value.manifest.artifacts);
  });

  it("rejects byte drift and added or deleted runtime entries", () => {
    const byteDrift = fixture();
    makeWritable(byteDrift.runtimeRoot);
    writeFileSync(join(byteDrift.runtimeRoot, "lib", "module.py"), "VALUE = 2\n");
    expect(() => verifyRuntimeInstallSeal(
      byteDrift.root,
      byteDrift.manifest,
      byteDrift.releaseDigest,
    )).toThrow(/does not match/i);

    const added = fixture();
    makeWritable(added.runtimeRoot);
    writeFileSync(join(added.runtimeRoot, "rogue.py"), "pass\n");
    expect(() => verifyRuntimeInstallSeal(
      added.root,
      added.manifest,
      added.releaseDigest,
    )).toThrow(/does not match/i);

    const deleted = fixture();
    makeWritable(deleted.runtimeRoot);
    unlinkSync(join(deleted.runtimeRoot, "lib", "module.py"));
    expect(() => verifyRuntimeInstallSeal(
      deleted.root,
      deleted.manifest,
      deleted.releaseDigest,
    )).toThrow(/does not match/i);
  });

  it("binds complete Unix modes instead of collapsing all read-only files", () => {
    const value = fixture();
    const modulePath = join(value.runtimeRoot, "lib", "module.py");
    chmodSync(modulePath, 0o400);
    expect(() => verifyRuntimeInstallSeal(
      value.root,
      value.manifest,
      value.releaseDigest,
    )).toThrow(/does not match/i);
  });

  it("rejects external and absolute symlinks before a seal can be created", () => {
    const value = fixture();
    unlinkSync(value.created.sealPath);
    makeWritable(value.runtimeRoot);
    symlinkSync("/etc/passwd", join(value.runtimeRoot, "escape"));
    expect(() => createRuntimeInstallSeal(
      value.root,
      value.manifest,
      value.releaseDigest,
    )).toThrow(/absolute symlink|escapes/i);
  });

  it("rejects unsupported runtime nodes", () => {
    const value = fixture();
    unlinkSync(value.created.sealPath);
    makeWritable(value.runtimeRoot);
    execFileSync("mkfifo", [join(value.runtimeRoot, "runtime.pipe")]);
    expect(() => digestRuntimeTree(value.runtimeRoot)).toThrow(/unsupported runtime node/i);
  });

  it("rejects runtime and seal hardlinks instead of trusting shared cache inodes", () => {
    const value = fixture();
    unlinkSync(value.created.sealPath);
    makeWritable(value.runtimeRoot);
    linkSync(
      join(value.runtimeRoot, "lib", "module.py"),
      join(value.runtimeRoot, "lib", "shared.py"),
    );
    expect(() => digestRuntimeTree(value.runtimeRoot)).toThrow(/hardlink|cache sharing/i);

    const sealLink = fixture();
    linkSync(sealLink.created.sealPath, join(sealLink.root, "seal-alias.json"));
    expect(() => verifyRuntimeInstallSeal(
      sealLink.root,
      sealLink.manifest,
      sealLink.releaseDigest,
    )).toThrow(/independent regular file|hardlink/i);
  });

  it("rejects noncanonical and semantically tampered seal documents", () => {
    const noncanonical = fixture();
    const seal = JSON.parse(readFileSync(noncanonical.created.sealPath, "utf8"));
    writeFileSync(noncanonical.created.sealPath, JSON.stringify(seal));
    expect(() => verifyRuntimeInstallSeal(
      noncanonical.root,
      noncanonical.manifest,
      noncanonical.releaseDigest,
    )).toThrow(/not canonically serialized/i);

    const tampered = fixture();
    const changed = JSON.parse(readFileSync(tampered.created.sealPath, "utf8"));
    changed.tree.treeSha256 = "0".repeat(64);
    writeFileSync(tampered.created.sealPath, canonicalJson(changed));
    expect(() => verifyRuntimeInstallSeal(
      tampered.root,
      tampered.manifest,
      tampered.releaseDigest,
    )).toThrow(/does not match/i);
  });

  it("rejects a missing seal and false release or lock identities", () => {
    const missing = fixture();
    unlinkSync(missing.created.sealPath);
    expect(() => verifyRuntimeInstallSeal(
      missing.root,
      missing.manifest,
      missing.releaseDigest,
    )).toThrow();

    const falseRelease = fixture();
    expect(() => verifyRuntimeInstallSeal(
      falseRelease.root,
      falseRelease.manifest,
      "f".repeat(64),
    )).toThrow(/does not match/i);

    const falseLock = fixture();
    const changedManifest = structuredClone(falseLock.manifest);
    changedManifest.locks.python = "e".repeat(64);
    expect(() => verifyRuntimeInstallSeal(
      falseLock.root,
      changedManifest,
      falseLock.releaseDigest,
    )).toThrow(/lock identities/i);
  });

  it("does not let static-only verification bypass the production release location", () => {
    const value = fixture();
    unlinkSync(value.created.sealPath);
    expect(() => loadVerifiedReleaseRoot(
      value.root,
      value.releaseDigest,
      { staticOnly: true },
    )).toThrow(/exactly \/opt\/ltx-studio\/releases/i);
    expect(() => loadVerifiedReleaseRoot(
      value.root,
      value.releaseDigest,
      {},
    ))
      .toThrow(/exactly \/opt\/ltx-studio\/releases/i);
    expect(verifyTrustedReleaseRootLocation(value.root, value.releaseDigest, {
      expectedParent: value.releaseParent,
      trustAnchor: value.anchor,
      expectedUid: process.getuid!(),
      expectedGid: process.getgid!(),
    }).releaseRoot).toBe(value.root);
  });

  it("enforces ownership and write-bit policy with caller-supplied non-root identities", () => {
    const value = fixture();
    const uid = process.getuid!();
    const gid = process.getgid!();
    expect(verifyRuntimeInstallSeal(
      value.root,
      value.manifest,
      value.releaseDigest,
      { ownership: { expectedUid: uid, expectedGid: gid, requireReadOnly: false } },
    ).ownership).toMatchObject({ expectedUid: uid, expectedGid: gid });
    expect(() => verifyRuntimeInstallSeal(
      value.root,
      value.manifest,
      value.releaseDigest,
      { ownership: { expectedUid: uid, expectedGid: gid, requireReadOnly: true } },
    )).toThrow(/writable path/i);
    expect(() => verifyRuntimeInstallSeal(
      value.root,
      value.manifest,
      value.releaseDigest,
      { ownership: { expectedUid: uid + 1, expectedGid: gid, requireReadOnly: false } },
    )).toThrow(/ownership gate/i);

    unlinkSync(value.created.sealPath);
    makeReadOnly(value.root);
    const sealDirectory = dirname(value.created.sealPath);
    chmodSync(sealDirectory, 0o755);
    const installedSeal = createRuntimeInstallSeal(
      value.root,
      value.manifest,
      value.releaseDigest,
    );
    chmodSync(installedSeal.sealPath, 0o444);
    chmodSync(sealDirectory, 0o555);
    expect(verifyRuntimeInstallSeal(
      value.root,
      value.manifest,
      value.releaseDigest,
      { ownership: { expectedUid: uid, expectedGid: gid, requireReadOnly: true } },
    ).ownership?.requireReadOnly).toBe(true);
    expect(() => loadVerifiedReleaseRoot(
      value.root,
      value.releaseDigest,
      {
        ownership: { expectedUid: uid, expectedGid: gid, requireReadOnly: true },
        verifyHostTcb: false,
        expectedRuntimeTrust: value.runtimeTrust,
      },
    )).toThrow(/exactly \/opt\/ltx-studio\/releases/i);
    expect(installedSeal.sealSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("materializes an external interpreter symlink into a private regular executable", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-runtime-python-copy-"));
    roots.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    symlinkSync(process.execPath, join(bin, "python"));

    expect(materializeExternalInterpreterSymlinks(root)).toEqual(["python"]);
    const copied = lstatSync(join(bin, "python"));
    expect(copied.isFile()).toBe(true);
    expect(copied.isSymbolicLink()).toBe(false);
    expect(copied.nlink).toBe(1);
    expect(copied.mode & 0o111).not.toBe(0);
    expect(digestRuntimeTree(root).symlinkCount).toBe(0);
  });

  it("copies a digest-pinned executable and rejects source drift", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-runtime-executable-copy-"));
    roots.push(root);
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const source = join(bin, "source");
    const destination = join(bin, "node");
    writeFileSync(source, "trusted executable\n", { mode: 0o755 });
    const digest = hash("trusted executable\n");
    expect(materializeTrustedExecutable(source, destination, digest)).toEqual({
      path: destination,
      sha256: digest,
    });
    expect(readFileSync(destination, "utf8")).toBe("trusted executable\n");
    expect(() => materializeTrustedExecutable(source, join(bin, "other"), "f".repeat(64)))
      .toThrow(/source digest/i);
  });

  it("rejects mutable release parents and accepts a closed trusted chain", () => {
    const anchor = mkdtempSync(join(tmpdir(), "ltx-release-parent-"));
    roots.push(anchor);
    const parent = join(anchor, "opt", "ltx-studio", "releases");
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    expect(verifyTrustedReleaseParent(parent, {
      expectedParent: parent,
      trustAnchor: anchor,
      expectedUid: process.getuid!(),
      expectedGid: process.getgid!(),
    }).parent).toBe(parent);
    chmodSync(join(anchor, "opt", "ltx-studio"), 0o777);
    expect(() => verifyTrustedReleaseParent(parent, {
      expectedParent: parent,
      trustAnchor: anchor,
      expectedUid: process.getuid!(),
      expectedGid: process.getgid!(),
    })).toThrow(/group\/world writable/i);
  });

  it("accepts the exact digest-named production /opt root through the default trust anchor", () => {
    const releaseDigest = "a".repeat(64);
    const releaseRoot = `${TRUSTED_RELEASE_PARENT}/${releaseDigest}`;
    const observed: string[] = [];
    const filesystem = {
      realpathSync: (path: string) => path,
      lstatSync: (path: string) => {
        observed.push(path);
        return {
          isDirectory: () => true,
          isSymbolicLink: () => false,
          uid: 0,
          gid: 0,
          mode: 0o755,
        };
      },
    };
    expect(verifyTrustedReleaseRootLocation(releaseRoot, releaseDigest, { filesystem })).toEqual({
      releaseRoot,
      releaseDigest,
      parentChain: {
        parent: "/opt/ltx-studio/releases",
        expectedUid: 0,
        expectedGid: 0,
        checked: ["/opt/ltx-studio/releases", "/opt/ltx-studio", "/opt", "/"],
      },
    });
    expect(observed).toEqual([
      releaseRoot,
      "/opt/ltx-studio/releases",
      "/opt/ltx-studio",
      "/opt",
      "/",
    ]);
    expect(() => verifyTrustedReleaseRootLocation(
      `/opt/ltx-studio/releases-evil/${releaseDigest}`,
      releaseDigest,
      { filesystem },
    ))
      .toThrow(/exactly \/opt\/ltx-studio\/releases/i);
  });
});
