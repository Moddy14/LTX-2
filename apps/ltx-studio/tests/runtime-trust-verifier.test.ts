import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getgid, getuid } from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  readExpectedHostTcbAttestationSha256,
  readExternalRuntimeIdentityPin,
  readExternalRuntimeTrustPolicyDigests,
} from "../scripts/runtime-trust-verifier-lib.mjs";
import { canonicalJson } from "../shared/canonicalJson.js";

const roots: string[] = [];
const uid = getuid!();
const gid = getgid!();
const digest = "a".repeat(64);
const parentOwners = [{ uid: 0, gid: 0 }, { uid, gid }];

function writeExact(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, value, { mode: 0o444 });
  chmodSync(path, 0o444);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external RuntimeTrust evidence readers", () => {
  it("binds the exact external runtime pin, systemd Host-TCB pin, and complete policy inventory", () => {
    const root = mkdtempSync(join(homedir(), ".ltx-runtime-trust-test-"));
    roots.push(root);
    const releaseRoot = join(root, digest);
    mkdirSync(releaseRoot, { mode: 0o755 });
    const pinRoot = join(root, "release-pins");
    const systemdRoot = join(root, "systemd");
    const runtimePinPath = join(pinRoot, `${digest}.runtime-identity.v1.json`);
    writeExact(runtimePinPath, canonicalJson({
      schemaVersion: "ltx-studio-external-runtime-identity-pin.v1",
      releaseDigest: digest,
      runtimeInstallSealSha256: "1".repeat(64),
      runtimeTreeSha256: "2".repeat(64),
      runtimePolicySha256: "3".repeat(64),
      nodeExecutableSha256: "4".repeat(64),
    }));
    const pin = readExternalRuntimeIdentityPin(releaseRoot, digest, {
      pinRoot,
      expectedUid: uid,
      expectedGid: gid,
      allowedParentOwners: parentOwners,
    });
    expect(pin.releaseDigest).toBe(digest);

    const hostPinPath = join(
      systemdRoot,
      `ltx-studio-sealed@${digest}.service.d`,
      "10-host-tcb-attestation-pin.conf",
    );
    writeExact(hostPinPath,
      `[Service]\nEnvironment=LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256=${"5".repeat(64)}\n`);
    expect(readExpectedHostTcbAttestationSha256(digest, {
      systemdRoot,
      expectedUid: uid,
      expectedGid: gid,
      allowedParentOwners: parentOwners,
    })).toBe("5".repeat(64));

    const paths = Object.fromEntries([
      "release", "activationWriter", "qualificationAuthorizer", "runtimeRights",
    ].map((name) => {
      const path = join(root, "trust", `${name}.json`);
      writeExact(path, canonicalJson({ schemaVersion: "fixture-policy.v1", name }));
      return [name, path];
    }));
    const policyDigests = readExternalRuntimeTrustPolicyDigests({
      paths,
      expectedPaths: paths,
      expectedUid: uid,
      expectedGid: gid,
      allowedParentOwners: parentOwners,
    });
    expect(policyDigests.release).toBe(
      createHash("sha256").update(canonicalJson({ schemaVersion: "fixture-policy.v1", name: "release" })).digest("hex"),
    );
  });

  it("rejects a mutable external pin instead of falling back to manifest data", () => {
    const root = mkdtempSync(join(homedir(), ".ltx-runtime-trust-test-"));
    roots.push(root);
    const releaseRoot = join(root, digest);
    const pinRoot = join(root, "release-pins");
    mkdirSync(releaseRoot, { mode: 0o755 });
    const path = join(pinRoot, `${digest}.runtime-identity.v1.json`);
    writeExact(path, canonicalJson({
      schemaVersion: "ltx-studio-external-runtime-identity-pin.v1",
      releaseDigest: digest,
      runtimeInstallSealSha256: "1".repeat(64),
      runtimeTreeSha256: "2".repeat(64),
      runtimePolicySha256: "3".repeat(64),
      nodeExecutableSha256: "4".repeat(64),
    }));
    chmodSync(path, 0o644);
    expect(() => readExternalRuntimeIdentityPin(releaseRoot, digest, {
      pinRoot,
      expectedUid: uid,
      expectedGid: gid,
      allowedParentOwners: parentOwners,
    })).toThrow(/mode|identity/i);
    chmodSync(path, 0o444);
    chmodSync(pinRoot, 0o777);
    expect(() => readExternalRuntimeIdentityPin(releaseRoot, digest, {
      pinRoot,
      expectedUid: uid,
      expectedGid: gid,
      allowedParentOwners: parentOwners,
    })).toThrow(/parent.*mutable/i);
  });
});
