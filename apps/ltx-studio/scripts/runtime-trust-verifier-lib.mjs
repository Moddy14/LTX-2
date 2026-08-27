import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import {
  readExternalBootstrapExpectedPinSha256,
  verifyExternalBootstrapAuthority,
} from "./bootstrap-authority-lib.mjs";
import {
  HOST_TCB_ATTESTATION_ROOT,
  HOST_TCB_PIN_DROP_IN,
  hostTcbPinDropIn,
  runtimeTrustBindingFromHostAttestation,
  verifyHostTcbAttestation,
} from "./host-tcb-attestation-lib.mjs";
import { canonicalJson } from "./release-manifest-lib.mjs";

export const EXTERNAL_RUNTIME_PIN_ROOT = "/etc/ltx-studio/release-pins";
export const EXTERNAL_TRUST_POLICY_PATHS = Object.freeze({
  release: "/etc/ltx-studio/trust/release-trusted-keys.v1.json",
  activationWriter: "/etc/ltx-studio/trust/activation-writer-trust.v1.json",
  qualificationAuthorizer: "/etc/ltx-studio/trust/qualification-authorizer-trust.v1.json",
  runtimeRights: "/etc/ltx-studio/trust/runtime-rights-trusted-keys.v1.json",
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_EXTERNAL_RECORD_BYTES = 4 * 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readExactExternalFile(pathArgument, options = {}) {
  const path = resolve(pathArgument);
  const expectedPath = resolve(options.expectedPath ?? path);
  if (path !== expectedPath || realpathSync(path) !== path) {
    throw new Error(`External RuntimeTrust path is not the fixed canonical path: ${path}`);
  }
  const details = lstatSync(path);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  const expectedMode = options.expectedMode ?? 0o444;
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || details.uid !== expectedUid || details.gid !== expectedGid
    || (details.mode & 0o7777) !== expectedMode
    || details.size < 1 || details.size > (options.maximumBytes ?? MAX_EXTERNAL_RECORD_BYTES)) {
    throw new Error(`External RuntimeTrust file identity, owner, mode, or size is invalid: ${path}`);
  }
  let directory = dirname(path);
  const allowedParentOwners = options.allowedParentOwners ?? [{ uid: 0, gid: 0 }];
  for (;;) {
    const parent = lstatSync(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || realpathSync(directory) !== directory
      || !allowedParentOwners.some(({ uid, gid }) => parent.uid === uid && parent.gid === gid)
      || (parent.mode & 0o022) !== 0) {
      throw new Error(`External RuntimeTrust parent is mutable or has a different owner: ${directory}`);
    }
    if (directory === dirname(directory)) break;
    directory = dirname(directory);
  }
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("External RuntimeTrust verifier requires O_NOFOLLOW support");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== details.dev || opened.ino !== details.ino || opened.mode !== details.mode
      || opened.uid !== details.uid || opened.gid !== details.gid || opened.nlink !== details.nlink
      || opened.size !== details.size || opened.ctimeMs !== details.ctimeMs
      || opened.mtimeMs !== details.mtimeMs) {
      throw new Error(`External RuntimeTrust file changed while opening: ${path}`);
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.mode !== opened.mode || after.uid !== opened.uid || after.gid !== opened.gid
      || after.nlink !== opened.nlink || after.size !== opened.size
      || after.ctimeMs !== opened.ctimeMs || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`External RuntimeTrust file changed while reading: ${path}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function parseCanonicalRecord(bytes, label) {
  const text = bytes.toString("utf8");
  const record = JSON.parse(text);
  if (canonicalJson(record) !== text) throw new Error(`${label} is not canonical JSON`);
  return record;
}

export function readExternalRuntimeIdentityPin(releaseRootArgument, releaseDigest, options = {}) {
  if (!SHA256_PATTERN.test(releaseDigest)) throw new Error("External runtime identity requires a release digest");
  const releaseRoot = resolve(releaseRootArgument);
  const pinRoot = resolve(options.pinRoot ?? EXTERNAL_RUNTIME_PIN_ROOT);
  const path = join(pinRoot, `${basename(releaseRoot)}.runtime-identity.v1.json`);
  const bytes = readExactExternalFile(path, {
    expectedPath: options.expectedPath ?? path,
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
    allowedParentOwners: options.allowedParentOwners,
  });
  const pin = parseCanonicalRecord(bytes, "External runtime identity pin");
  if (pin?.schemaVersion !== "ltx-studio-external-runtime-identity-pin.v1"
    || pin.releaseDigest !== releaseDigest
    || ![pin.runtimeInstallSealSha256, pin.runtimeTreeSha256,
      pin.runtimePolicySha256, pin.nodeExecutableSha256].every((value) => SHA256_PATTERN.test(value ?? ""))) {
    throw new Error("External runtime identity pin is invalid or release-mismatched");
  }
  return pin;
}

export function readExternalRuntimeTrustPolicyDigests(options = {}) {
  const paths = options.paths ?? EXTERNAL_TRUST_POLICY_PATHS;
  if (canonicalJson(Object.keys(paths).sort())
    !== canonicalJson(["activationWriter", "qualificationAuthorizer", "release", "runtimeRights"])) {
    throw new Error("External RuntimeTrust policy inventory is incomplete or unexpected");
  }
  return Object.fromEntries(Object.entries(paths).map(([name, path]) => {
    const bytes = readExactExternalFile(path, {
      expectedPath: (options.expectedPaths ?? EXTERNAL_TRUST_POLICY_PATHS)[name],
      expectedUid: options.expectedUid,
      expectedGid: options.expectedGid,
      allowedParentOwners: options.allowedParentOwners,
    });
    parseCanonicalRecord(bytes, `External ${name} trust policy`);
    return [name, sha256(bytes)];
  }));
}

export function readExpectedHostTcbAttestationSha256(releaseDigest, options = {}) {
  if (!SHA256_PATTERN.test(releaseDigest)) throw new Error("Host-TCB pin requires a release digest");
  const systemdRoot = resolve(options.systemdRoot ?? "/etc/systemd/system");
  const path = join(
    systemdRoot,
    `ltx-studio-sealed@${releaseDigest}.service.d`,
    HOST_TCB_PIN_DROP_IN,
  );
  const bytes = readExactExternalFile(path, {
    expectedPath: options.expectedPath ?? path,
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
    allowedParentOwners: options.allowedParentOwners,
    maximumBytes: 256,
  });
  const match = /^\[Service\]\nEnvironment=LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256=([0-9a-f]{64})\n$/.exec(
    bytes.toString("utf8"),
  );
  if (!match || bytes.toString("utf8") !== hostTcbPinDropIn(match[1])) {
    throw new Error("External Host-TCB pin drop-in is not exact");
  }
  return match[1];
}

export function verifyExternalRuntimeTrust(options) {
  const releaseRoot = resolve(options.releaseRoot);
  const releaseDigest = options.releaseDigest;
  const runtimeIdentity = options.runtimeIdentity;
  const pin = readExternalRuntimeIdentityPin(releaseRoot, releaseDigest, options.runtimePinOptions);
  for (const name of [
    "runtimeInstallSealSha256",
    "runtimeTreeSha256",
    "runtimePolicySha256",
    "nodeExecutableSha256",
  ]) {
    if (pin[name] !== runtimeIdentity?.[name]) {
      throw new Error(`External runtime identity drifted at ${name}`);
    }
  }
  const expectedAttestationSha256 = readExpectedHostTcbAttestationSha256(
    releaseDigest,
    options.hostPinOptions,
  );
  const attestationRoot = resolve(options.hostTcbAttestationRoot ?? HOST_TCB_ATTESTATION_ROOT);
  const attestationPath = join(attestationRoot, `${releaseDigest}.host-tcb-attestation.v2.json`);
  const attestationBytes = readExactExternalFile(attestationPath, {
    expectedPath: options.expectedHostTcbAttestationPath ?? attestationPath,
    expectedUid: options.expectedUid,
    expectedGid: options.expectedGid,
    allowedParentOwners: options.allowedParentOwners,
  });
  if (sha256(attestationBytes) !== expectedAttestationSha256) {
    throw new Error("External Host-TCB attestation differs from its separately loaded systemd pin");
  }
  const preliminary = parseCanonicalRecord(attestationBytes, "External Host-TCB attestation");
  const expectedBootstrapPinSha256 = (options.bootstrapExpectedPinReader
    ?? readExternalBootstrapExpectedPinSha256)(options.bootstrapExpectedPinOptions);
  if (preliminary.bootstrapAuthoritySha256 !== expectedBootstrapPinSha256) {
    throw new Error("Host-TCB bootstrap authority differs from the separate expected-pin source");
  }
  const authority = (options.bootstrapAuthorityVerifier ?? verifyExternalBootstrapAuthority)({
    expectedPinSha256: expectedBootstrapPinSha256,
    ...(options.bootstrapAuthorityOptions ?? {}),
  });
  try {
    const trustPolicyDigests = {
      ...(options.trustPolicyDigests ?? readExternalRuntimeTrustPolicyDigests(options.trustPolicyOptions)),
      bootstrapAuthority: expectedBootstrapPinSha256,
    };
    const verified = verifyHostTcbAttestation(attestationBytes, {
      releaseRoot,
      releaseDigest,
      manifest: options.manifest,
      runtimeIdentity,
      expectedAttestationSha256,
      expectedBootstrapAuthoritySha256: expectedBootstrapPinSha256,
      expectedTrustPolicyDigests: trustPolicyDigests,
      pinDropInRoot: options.hostPinOptions?.systemdRoot,
      expectedPolicyUid: options.expectedUid,
      expectedPolicyGid: options.expectedGid,
      execute: options.execute,
      captureElfClosure: options.captureElfClosure,
      capturePostInstallHostClosure: options.capturePostInstallHostClosure,
      sealedServicePolicy: authority.sealedServicePolicy,
    });
    return runtimeTrustBindingFromHostAttestation({
      record: verified.record,
      attestationSha256: verified.attestationSha256,
      trustPolicyDigests,
    });
  } finally {
    authority.close();
  }
}
