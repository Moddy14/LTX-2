import { createPublicKey, verify } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { canonicalJson, sha256Bytes } from "./release-manifest-lib.mjs";

export const BOOTSTRAP_AUTHORITY_SCHEMA = "ltx-studio-root-bootstrap-authority.v1";
export const BOOTSTRAP_PIN_SCHEMA = "ltx-studio-root-bootstrap-pin.v1";
export const BOOTSTRAP_SIGNATURE_SCHEMA = "ltx-studio-root-bootstrap-signature.v1";
export const EXTERNAL_BOOTSTRAP_EXECUTABLE = "/usr/libexec/ltx-studio/root-bootstrap-v1.mjs";
export const EXTERNAL_BOOTSTRAP_NODE = "/usr/libexec/ltx-studio/node-v24/bin/node";
export const EXTERNAL_BOOTSTRAP_POLICY = "/etc/ltx-studio/bootstrap/root-bootstrap-authority.v1.json";
export const EXTERNAL_BOOTSTRAP_SIGNATURE = "/etc/ltx-studio/bootstrap/root-bootstrap-authority.v1.sig.json";
export const EXTERNAL_BOOTSTRAP_PIN = "/etc/ltx-studio/bootstrap/root-bootstrap-pin.v1.json";
export const EXTERNAL_BOOTSTRAP_EXPECTED_PIN_SHA256 = "/etc/ltx-studio/trust/root-bootstrap-pin.v1.sha256";
export const EXTERNAL_SEALED_SERVICE_TEMPLATE = "/etc/ltx-studio/bootstrap/ltx-studio-sealed@.service";
export const SEALED_SERVICE_POLICY_SCHEMA = "ltx-studio-sealed-service-policy.v1";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function readExactRootFile(pathArgument, options = {}) {
  const path = resolve(pathArgument);
  if (!isAbsolute(path) || path !== (options.expectedPath ?? path) || realpathSync(path) !== path) {
    throw new Error(`External bootstrap path is not the fixed canonical path: ${path}`);
  }
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || details.uid !== (options.expectedUid ?? 0) || details.gid !== (options.expectedGid ?? 0)
    || (details.mode & 0o222) !== 0) {
    throw new Error(`External bootstrap authority file is not immutable and root-owned: ${path}`);
  }
  if ((details.mode & 0o7777) !== options.expectedMode
    || details.size < 1 || details.size > options.maximumBytes) {
    throw new Error(`External bootstrap authority file mode or size is invalid: ${path}`);
  }
  const parentChainRoot = resolve(options.parentChainRoot ?? "/");
  const withinParentChainRoot = parentChainRoot === "/"
    ? path.startsWith("/") && path !== "/"
    : path.startsWith(`${parentChainRoot}${sep}`);
  if (path === parentChainRoot || !withinParentChainRoot) {
    throw new Error(`External bootstrap path escapes its parent-chain trust root: ${path}`);
  }
  let directory = dirname(path);
  for (;;) {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory
      || parent.uid !== (options.expectedUid ?? 0) || parent.gid !== (options.expectedGid ?? 0)
      || (parent.mode & 0o022) !== 0) {
      throw new Error(`External bootstrap parent is mutable or has a different owner: ${directory}`);
    }
    if (directory === parentChainRoot) break;
    const next = dirname(directory);
    if (next === directory) throw new Error("External bootstrap parent-chain trust root was not reached");
    directory = next;
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("External bootstrap verification requires O_NOFOLLOW support");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const held = fstatSync(descriptor);
  if (held.dev !== details.dev || held.ino !== details.ino || held.size !== details.size
    || held.ctimeMs !== details.ctimeMs || held.mtimeMs !== details.mtimeMs) {
    throw new Error(`External bootstrap authority changed while it was opened: ${path}`);
  }
  const bytes = readFileSync(descriptor);
  const after = fstatSync(descriptor);
  if (after.size !== held.size || after.ctimeMs !== held.ctimeMs || after.mtimeMs !== held.mtimeMs) {
    throw new Error(`External bootstrap authority changed while it was read: ${path}`);
  }
  return { path, descriptor, bytes, sha256: sha256Bytes(bytes), stat: held };
}

function parseCanonical(record, context) {
  const text = record.bytes.toString("utf8");
  const value = JSON.parse(text);
  if (canonicalJson(value) !== text) throw new Error(`${context} is not canonical JSON`);
  return value;
}

export function readExternalBootstrapExpectedPinSha256(options = {}) {
  const path = options.path ?? EXTERNAL_BOOTSTRAP_EXPECTED_PIN_SHA256;
  const record = readExactRootFile(path, {
    expectedPath: options.expectedPath ?? EXTERNAL_BOOTSTRAP_EXPECTED_PIN_SHA256,
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
    expectedMode: 0o444,
    maximumBytes: 65,
    parentChainRoot: options.parentChainRoot,
  });
  try {
    const text = record.bytes.toString("utf8");
    if (!/^[0-9a-f]{64}\n$/.test(text)) {
      throw new Error("External bootstrap expected-pin digest is not an exact lowercase SHA-256 line");
    }
    return text.slice(0, 64);
  } finally {
    closeSync(record.descriptor);
  }
}

export function verifyExternalBootstrapAuthority(options = {}) {
  if (!SHA256_PATTERN.test(options.expectedPinSha256 ?? "")) {
    throw new Error("A separate out-of-band expected bootstrap pin SHA-256 is mandatory");
  }
  const paths = {
    executable: options.executablePath ?? EXTERNAL_BOOTSTRAP_EXECUTABLE,
    node: options.nodePath ?? EXTERNAL_BOOTSTRAP_NODE,
    policy: options.policyPath ?? EXTERNAL_BOOTSTRAP_POLICY,
    signature: options.signaturePath ?? EXTERNAL_BOOTSTRAP_SIGNATURE,
    pin: options.pinPath ?? EXTERNAL_BOOTSTRAP_PIN,
    serviceTemplate: options.serviceTemplatePath ?? EXTERNAL_SEALED_SERVICE_TEMPLATE,
  };
  const expectedPaths = options.expectedPaths ?? {
    executable: EXTERNAL_BOOTSTRAP_EXECUTABLE,
    node: EXTERNAL_BOOTSTRAP_NODE,
    policy: EXTERNAL_BOOTSTRAP_POLICY,
    signature: EXTERNAL_BOOTSTRAP_SIGNATURE,
    pin: EXTERNAL_BOOTSTRAP_PIN,
    serviceTemplate: EXTERNAL_SEALED_SERVICE_TEMPLATE,
  };
  const filePolicies = {
    executable: { expectedMode: 0o555, maximumBytes: 16 * 1024 * 1024 },
    node: { expectedMode: 0o555, maximumBytes: 256 * 1024 * 1024 },
    policy: { expectedMode: 0o444, maximumBytes: 4 * 1024 * 1024 },
    signature: { expectedMode: 0o444, maximumBytes: 1024 * 1024 },
    pin: { expectedMode: 0o444, maximumBytes: 1024 * 1024 },
    serviceTemplate: { expectedMode: 0o444, maximumBytes: 1024 * 1024 },
  };
  const records = Object.fromEntries(Object.entries(paths).map(([name, path]) => [
    name,
    readExactRootFile(path, {
      expectedPath: expectedPaths[name],
      expectedUid: options.expectedUid,
      expectedGid: options.expectedGid,
      parentChainRoot: options.parentChainRoot,
      ...filePolicies[name],
    }),
  ]));
  try {
    const pin = parseCanonical(records.pin, "External bootstrap pin");
    const policy = parseCanonical(records.policy, "External bootstrap policy");
    const signature = parseCanonical(records.signature, "External bootstrap signature");
    if (records.pin.sha256 !== options.expectedPinSha256
      || pin?.schemaVersion !== BOOTSTRAP_PIN_SCHEMA
      || policy?.schemaVersion !== BOOTSTRAP_AUTHORITY_SCHEMA
      || signature?.schemaVersion !== BOOTSTRAP_SIGNATURE_SCHEMA
      || pin.policyPath !== expectedPaths.policy || pin.policySha256 !== records.policy.sha256
      || pin.signaturePath !== expectedPaths.signature || pin.signatureSha256 !== records.signature.sha256
      || pin.executablePath !== expectedPaths.executable || pin.executableSha256 !== records.executable.sha256
      || pin.nodePath !== expectedPaths.node || pin.nodeSha256 !== records.node.sha256
      || pin.serviceTemplatePath !== expectedPaths.serviceTemplate
      || pin.serviceTemplateSha256 !== records.serviceTemplate.sha256
      || policy.executable?.path !== expectedPaths.executable || policy.executable?.sha256 !== records.executable.sha256
      || policy.node?.path !== expectedPaths.node || policy.node?.sha256 !== records.node.sha256
      || policy.sealedServicePolicy?.schemaVersion !== SEALED_SERVICE_POLICY_SCHEMA
      || policy.sealedServicePolicy?.templatePath !== expectedPaths.serviceTemplate
      || policy.sealedServicePolicy?.templateSha256 !== records.serviceTemplate.sha256
      || policy.sealedServicePolicy?.unknownDirectivePolicy !== "deny-unlisted-before-install-and-start"
      || policy.privilegedImportPolicy !== "no-candidate-code-import-or-execution"
      || canonicalJson(policy.operations) !== canonicalJson(["attest", "install", "recover", "verify"])
      || signature.algorithm !== "ed25519" || signature.payloadSha256 !== records.policy.sha256
      || signature.keyId !== pin.authorityKeyId || signature.publicKeySha256 !== pin.authorityPublicKeySha256
      || !SHA256_PATTERN.test(pin.authorityPublicKeySha256 ?? "")) {
      throw new Error("External bootstrap authority pin, policy, signature, Node, or executable binding mismatch");
    }
    const rawKey = Buffer.from(pin.authorityPublicKeyBase64, "base64");
    const rawSignature = Buffer.from(signature.signatureBase64, "base64");
    if (rawKey.length !== 32 || rawSignature.length !== 64
      || rawKey.toString("base64") !== pin.authorityPublicKeyBase64
      || rawSignature.toString("base64") !== signature.signatureBase64
      || sha256Bytes(rawKey) !== pin.authorityPublicKeySha256) {
      throw new Error("External bootstrap authority key or signature encoding is invalid");
    }
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]),
      format: "der",
      type: "spki",
    });
    if (!verify(null, records.policy.bytes, publicKey, rawSignature)) {
      throw new Error("External bootstrap authority Ed25519 signature is invalid");
    }
    for (const name of ["policy", "signature", "pin"]) closeSync(records[name].descriptor);
    return {
      schemaVersion: "ltx-studio-verified-root-bootstrap-authority.v1",
      authoritySha256: records.pin.sha256,
      policySha256: records.policy.sha256,
      executableSha256: records.executable.sha256,
      nodeSha256: records.node.sha256,
      policy,
      sealedServicePolicy: policy.sealedServicePolicy,
      heldExecutableFd: records.executable.descriptor,
      heldNodeFd: records.node.descriptor,
      heldServiceTemplateFd: records.serviceTemplate.descriptor,
      close() {
        closeSync(records.executable.descriptor);
        closeSync(records.node.descriptor);
        closeSync(records.serviceTemplate.descriptor);
      },
    };
  } catch (error) {
    for (const record of Object.values(records)) {
      try { closeSync(record.descriptor); } catch { /* best effort */ }
    }
    throw error;
  }
}
