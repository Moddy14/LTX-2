import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getgid, getuid } from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  BOOTSTRAP_AUTHORITY_SCHEMA,
  BOOTSTRAP_PIN_SCHEMA,
  BOOTSTRAP_SIGNATURE_SCHEMA,
  SEALED_SERVICE_POLICY_SCHEMA,
  readExternalBootstrapExpectedPinSha256,
  verifyExternalBootstrapAuthority,
} from "../scripts/bootstrap-authority-lib.mjs";
import { canonicalJson } from "../shared/canonicalJson.js";

const roots: string[] = [];
const uid = getuid!();
const gid = getgid!();
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ltx-bootstrap-authority-"));
  roots.push(root);
  const paths = {
    executable: join(root, "libexec", "root-bootstrap-v1.mjs"),
    node: join(root, "libexec", "node"),
    policy: join(root, "etc", "authority.json"),
    signature: join(root, "etc", "authority.sig.json"),
    pin: join(root, "etc", "pin.json"),
    expectedPin: join(root, "etc", "expected-pin.sha256"),
    serviceTemplate: join(root, "etc", "ltx-studio-sealed@.service"),
  };
  mkdirSync(join(root, "libexec"), { recursive: true });
  mkdirSync(join(root, "etc"), { recursive: true });
  chmodSync(root, 0o700);
  chmodSync(join(root, "libexec"), 0o755);
  chmodSync(join(root, "etc"), 0o755);
  const executableBytes = Buffer.from("#!/usr/bin/env node\n");
  const nodeBytes = Buffer.from("fixture-node\n");
  const serviceTemplateBytes = Buffer.from("[Unit]\nDescription=fixture\n[Service]\nType=simple\n[Install]\nWantedBy=multi-user.target\n");
  writeFileSync(paths.executable, executableBytes, { mode: 0o555 });
  writeFileSync(paths.node, nodeBytes, { mode: 0o555 });
  writeFileSync(paths.serviceTemplate, serviceTemplateBytes, { mode: 0o444 });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const rawKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const policy = {
    schemaVersion: BOOTSTRAP_AUTHORITY_SCHEMA,
    authorityId: "root-bootstrap-fixture",
    executable: { path: paths.executable, sha256: sha(executableBytes) },
    node: { path: paths.node, sha256: sha(nodeBytes) },
    sealedServicePolicy: {
      schemaVersion: SEALED_SERVICE_POLICY_SCHEMA,
      templatePath: paths.serviceTemplate,
      templateSha256: sha(serviceTemplateBytes),
      unknownDirectivePolicy: "deny-unlisted-before-install-and-start",
    },
    privilegedImportPolicy: "no-candidate-code-import-or-execution",
    operations: ["attest", "install", "recover", "verify"],
  };
  const policyBytes = Buffer.from(canonicalJson(policy));
  const signature = {
    schemaVersion: BOOTSTRAP_SIGNATURE_SCHEMA,
    algorithm: "ed25519",
    keyId: "bootstrap-admin-fixture",
    payloadSha256: sha(policyBytes),
    publicKeySha256: sha(rawKey),
    signatureBase64: sign(null, policyBytes, privateKey).toString("base64"),
  };
  writeFileSync(paths.policy, policyBytes, { mode: 0o444 });
  writeFileSync(paths.signature, canonicalJson(signature), { mode: 0o444 });
  const pin = {
    schemaVersion: BOOTSTRAP_PIN_SCHEMA,
    authorityKeyId: signature.keyId,
    authorityPublicKeyBase64: rawKey.toString("base64"),
    authorityPublicKeySha256: sha(rawKey),
    executablePath: paths.executable,
    executableSha256: sha(executableBytes),
    nodePath: paths.node,
    nodeSha256: sha(nodeBytes),
    serviceTemplatePath: paths.serviceTemplate,
    serviceTemplateSha256: sha(serviceTemplateBytes),
    policyPath: paths.policy,
    policySha256: sha(policyBytes),
    signaturePath: paths.signature,
    signatureSha256: sha(Buffer.from(canonicalJson(signature))),
  };
  const pinBytes = Buffer.from(canonicalJson(pin));
  writeFileSync(paths.pin, pinBytes, { mode: 0o444 });
  const pinSha256 = sha(pinBytes);
  writeFileSync(paths.expectedPin, `${pinSha256}\n`, { mode: 0o444 });
  return { root, paths, pinSha256, pin, policy, privateKey, rawKey };
}

function verifyFixture(value: ReturnType<typeof fixture>, expectedPinSha256 = value.pinSha256) {
  return verifyExternalBootstrapAuthority({
    expectedPinSha256,
    executablePath: value.paths.executable,
    nodePath: value.paths.node,
    policyPath: value.paths.policy,
    signaturePath: value.paths.signature,
    pinPath: value.paths.pin,
    serviceTemplatePath: value.paths.serviceTemplate,
    expectedPaths: value.paths,
    expectedUid: uid,
    expectedGid: gid,
    parentChainRoot: value.root,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external root bootstrap authority", () => {
  it("requires the fixed bytes, exact modes, detached signature, and separate out-of-band pin", () => {
    const value = fixture();
    expect(readExternalBootstrapExpectedPinSha256({
      path: value.paths.expectedPin,
      expectedPath: value.paths.expectedPin,
      expectedUid: uid,
      expectedGid: gid,
      parentChainRoot: value.root,
    })).toBe(value.pinSha256);
    const verified = verifyFixture(value);
    expect(verified.authoritySha256).toBe(value.pinSha256);
    verified.close();
    chmodSync(value.root, 0o777);
    expect(() => verifyFixture(value)).toThrow(/parent.*mutable/i);
    chmodSync(value.root, 0o700);
    expect(() => verifyExternalBootstrapAuthority({
      ...value.paths,
      expectedPaths: value.paths,
      expectedUid: uid,
      expectedGid: gid,
      parentChainRoot: value.root,
    })).toThrow(/out-of-band/i);
    chmodSync(value.paths.executable, 0o555 | 0o020);
    expect(() => verifyFixture(value)).toThrow(/mode|root-owned/i);

    const malformedExpectedPin = fixture();
    chmodSync(malformedExpectedPin.paths.expectedPin, 0o644);
    expect(() => readExternalBootstrapExpectedPinSha256({
      path: malformedExpectedPin.paths.expectedPin,
      expectedPath: malformedExpectedPin.paths.expectedPin,
      expectedUid: uid,
      expectedGid: gid,
      parentChainRoot: malformedExpectedPin.root,
    })).toThrow(/mode|root-owned/i);
  });

  it("rejects a consistently replaced policy, signature, and pin against the unchanged external digest", () => {
    const value = fixture();
    const replacement = { ...value.policy, authorityId: "root-bootstrap-evil" };
    const policyBytes = Buffer.from(canonicalJson(replacement));
    const signature = {
      schemaVersion: BOOTSTRAP_SIGNATURE_SCHEMA,
      algorithm: "ed25519",
      keyId: "bootstrap-admin-fixture",
      payloadSha256: sha(policyBytes),
      publicKeySha256: sha(value.rawKey),
      signatureBase64: sign(null, policyBytes, value.privateKey).toString("base64"),
    };
    chmodSync(value.paths.policy, 0o644);
    writeFileSync(value.paths.policy, policyBytes);
    chmodSync(value.paths.policy, 0o444);
    chmodSync(value.paths.signature, 0o644);
    writeFileSync(value.paths.signature, canonicalJson(signature));
    chmodSync(value.paths.signature, 0o444);
    const replacementPin = {
      ...value.pin,
      policySha256: sha(policyBytes),
      signatureSha256: sha(Buffer.from(canonicalJson(signature))),
    };
    chmodSync(value.paths.pin, 0o644);
    writeFileSync(value.paths.pin, canonicalJson(replacementPin));
    chmodSync(value.paths.pin, 0o444);
    expect(() => verifyFixture(value)).toThrow(/out-of-band|pin/i);

    const linked = fixture();
    linkSync(linked.paths.pin, `${linked.paths.pin}.hardlink`);
    expect(() => verifyFixture(linked)).toThrow(/root-owned|single|immutable/i);
  });
});
