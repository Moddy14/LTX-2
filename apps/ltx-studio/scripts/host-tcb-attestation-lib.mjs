import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, sha256Bytes } from "./release-manifest-lib.mjs";
import { capturePostInstallHostClosure, verifyHostTcbContract } from "./host-tcb-lib.mjs";
import { fsyncDirectory } from "./runtime-install-publish-lib.mjs";
import { sha256StableRegularFile } from "./runtime-install-seal-lib.mjs";
import {
  EXTERNAL_BOOTSTRAP_EXECUTABLE,
  EXTERNAL_BOOTSTRAP_NODE,
  SEALED_SERVICE_POLICY_SCHEMA,
} from "./bootstrap-authority-lib.mjs";

export const HOST_TCB_ATTESTATION_SCHEMA = "ltx-studio-host-tcb-attestation.v2";
export const HOST_TCB_ATTESTATION_ROOT = "/etc/ltx-studio/host-tcb-attestations";
export const HOST_TCB_PIN_DROP_IN = "10-host-tcb-attestation-pin.conf";
export const HOST_TCB_BOOTSTRAP_PLACEHOLDER_SHA256 = "0".repeat(64);

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SEALED_UNIT_DIRECTIVES = Object.freeze({
  Unit: new Set(["After", "Description", "JoinsNamespaceOf", "Wants"]),
  Service: new Set([
    "AmbientCapabilities", "BindPaths", "BindReadOnlyPaths", "CapabilityBoundingSet",
    "DeviceAllow", "DevicePolicy", "DynamicUser", "Environment", "ExecCondition",
    "ExecReload", "ExecStart", "ExecStartPost", "ExecStartPre", "ExecStop", "ExecStopPost",
    "Group", "IPAddressAllow", "IPAddressDeny", "ImportCredential", "InaccessiblePaths",
    "LoadCredential", "LoadCredentialEncrypted", "LockPersonality", "MemoryDenyWriteExecute",
    "NetworkNamespacePath", "NoNewPrivileges", "OOMPolicy", "PassEnvironment", "PrivateDevices",
    "PrivateMounts", "PrivateNetwork", "PrivateTmp", "ProtectClock", "ProtectControlGroups",
    "ProtectHome", "ProtectHostname", "ProtectKernelLogs", "ProtectKernelModules",
    "ProtectKernelTunables", "ProtectProc", "ProtectSystem", "ProcSubset", "ReadOnlyPaths",
    "ReadWritePaths", "RemoveIPC", "Restart", "RestartSec", "RestrictAddressFamilies",
    "RestrictNamespaces", "RestrictRealtime", "RestrictSUIDSGID", "RootDirectory", "RootImage",
    "SetCredential", "SetCredentialEncrypted", "StateDirectory", "StateDirectoryMode",
    "SystemCallArchitectures", "TemporaryFileSystem", "Type", "UMask", "UnsetEnvironment",
    "User", "WorkingDirectory", "TimeoutStopSec",
  ]),
  Install: new Set(["WantedBy"]),
});
const REPEATED_SEALED_UNIT_DIRECTIVES = new Set(["Environment", "IPAddressAllow"]);

function assertAllowlistedSealedUnit(bytes, context) {
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes)) || text.includes("\\\n")) {
    throw new Error(`${context} is not a supported exact UTF-8 systemd unit`);
  }
  let section = null;
  const observed = new Set();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(line);
    if (sectionMatch) {
      if (!Object.hasOwn(SEALED_UNIT_DIRECTIVES, sectionMatch[1])) {
        throw new Error(`${context} contains an unapproved section at line ${index + 1}`);
      }
      section = sectionMatch[1];
      continue;
    }
    const separator = line.indexOf("=");
    const name = separator > 0 ? line.slice(0, separator) : "";
    if (!section || !SEALED_UNIT_DIRECTIVES[section].has(name)) {
      throw new Error(`${context} contains an unapproved privilege-bearing directive at line ${index + 1}: ${name || line}`);
    }
    const key = `${section}.${name}`;
    if (observed.has(key) && !REPEATED_SEALED_UNIT_DIRECTIVES.has(name)) {
      throw new Error(`${context} contains a duplicate directive at line ${index + 1}: ${name}`);
    }
    observed.add(key);
    if (section === "Install" && (name !== "WantedBy" || line.slice(separator + 1) !== "multi-user.target")) {
      throw new Error(`${context} contains an unapproved install alias/target`);
    }
  }
  for (const section of Object.keys(SEALED_UNIT_DIRECTIVES)) {
    if (![...observed].some((key) => key.startsWith(`${section}.`))) {
      throw new Error(`${context} omits the required [${section}] section policy`);
    }
  }
}

function assertExternalSealedServicePolicy(policy, fragment) {
  if (!policy || canonicalJson(Object.keys(policy).sort()) !== canonicalJson([
    "schemaVersion", "templatePath", "templateSha256", "unknownDirectivePolicy",
  ])
    || policy.schemaVersion !== SEALED_SERVICE_POLICY_SCHEMA
    || policy.templatePath !== fragment.path
    || policy.templateSha256 !== fragment.sha256
    || policy.unknownDirectivePolicy !== "deny-unlisted-before-install-and-start") {
    throw new Error("Loaded sealed unit is not bound to the separately signed/pinned bootstrap policy");
  }
  assertAllowlistedSealedUnit(readFileSync(fragment.path), "Externally pinned sealed unit");
}
export const SEALED_SERVICE_PROPERTIES = Object.freeze([
  "AmbientCapabilities",
  "BindPaths",
  "BindReadOnlyPaths",
  "CacheDirectory",
  "CacheDirectoryMode",
  "CapabilityBoundingSet",
  "ConfigurationDirectory",
  "ConfigurationDirectoryMode",
  "Delegate",
  "DeviceAllow",
  "DevicePolicy",
  "DropInPaths",
  "DynamicUser",
  "Environment",
  "EnvironmentFiles",
  "ExecCondition",
  "ExecReload",
  "ExecStart",
  "ExecStartPost",
  "ExecStartPre",
  "ExecStop",
  "ExecStopPost",
  "FragmentPath",
  "Group",
  "IPAddressAllow",
  "IPAddressDeny",
  "ImportCredential",
  "InaccessiblePaths",
  "JoinsNamespaceOf",
  "KeyringMode",
  "LoadCredential",
  "LoadCredentialEncrypted",
  "LockPersonality",
  "LogsDirectory",
  "LogsDirectoryMode",
  "MemoryDenyWriteExecute",
  "NetworkNamespacePath",
  "NoNewPrivileges",
  "PassEnvironment",
  "PrivateDevices",
  "PrivateMounts",
  "PrivateNetwork",
  "PrivateTmp",
  "PrivateUsers",
  "ProtectClock",
  "ProtectControlGroups",
  "ProtectHome",
  "ProtectHostname",
  "ProtectKernelLogs",
  "ProtectKernelModules",
  "ProtectKernelTunables",
  "ProtectProc",
  "ProtectSystem",
  "ProcSubset",
  "ReadOnlyPaths",
  "ReadWritePaths",
  "RemoveIPC",
  "RestrictNamespaces",
  "RestrictAddressFamilies",
  "RestrictRealtime",
  "RestrictSUIDSGID",
  "RootDirectory",
  "RootImage",
  "RuntimeDirectory",
  "RuntimeDirectoryMode",
  "RuntimeDirectoryPreserve",
  "SecureBits",
  "SetCredential",
  "SetCredentialEncrypted",
  "StateDirectory",
  "StateDirectoryMode",
  "SupplementaryGroups",
  "SystemCallArchitectures",
  "SystemCallErrorNumber",
  "SystemCallFilter",
  "TemporaryFileSystem",
  "TimeoutStopUSec",
  "UMask",
  "UnsetEnvironment",
  "User",
  "WorkingDirectory",
]);

export const EMPTY_SEALED_SERVICE_PROPERTIES = Object.freeze([
  "AmbientCapabilities", "BindPaths", "BindReadOnlyPaths", "CacheDirectory",
  "ConfigurationDirectory", "DeviceAllow",
  "EnvironmentFiles", "ExecReload", "ExecStartPost", "ExecStartPre",
  "ExecStop", "ExecStopPost", "ImportCredential", "InaccessiblePaths", "JoinsNamespaceOf",
  "LoadCredential", "LoadCredentialEncrypted", "LogsDirectory", "NetworkNamespacePath",
  "PassEnvironment", "ReadOnlyPaths", "ReadWritePaths", "RootDirectory", "RootImage",
  "RuntimeDirectory", "SetCredential", "SupplementaryGroups",
  "SetCredentialEncrypted", "TemporaryFileSystem",
]);
const EMPTY_SERVICE_PROPERTIES = new Set(EMPTY_SEALED_SERVICE_PROPERTIES);

export const FIXED_SEALED_SERVICE_PROPERTIES = Object.freeze({
  User: "moddy",
  Group: "moddy",
  DynamicUser: "no",
  Delegate: "no",
  UMask: "0077",
  SecureBits: "0",
  RemoveIPC: "no",
  KeyringMode: "private",
  StateDirectory: "ltx-studio",
  StateDirectoryMode: "0700",
  RuntimeDirectoryMode: "0755",
  RuntimeDirectoryPreserve: "no",
  CacheDirectoryMode: "0755",
  LogsDirectoryMode: "0755",
  ConfigurationDirectoryMode: "0755",
  PrivateUsers: "no",
  MemoryDenyWriteExecute: "no",
  SystemCallFilter: "~",
  SystemCallErrorNumber: "2147483646",
  IPAddressDeny: "any",
  IPAddressAllow: "localhost",
  PrivateDevices: "no",
  PrivateMounts: "no",
  PrivateNetwork: "no",
  PrivateTmp: "yes",
  ProtectClock: "yes",
  ProtectControlGroups: "yes",
  ProtectHome: "read-only",
  ProtectHostname: "yes",
  ProtectKernelLogs: "yes",
  ProtectKernelModules: "yes",
  ProtectKernelTunables: "yes",
  ProtectProc: "default",
  ProcSubset: "all",
  ProtectSystem: "strict",
  LockPersonality: "yes",
  NoNewPrivileges: "no",
  RestrictRealtime: "yes",
  RestrictSUIDSGID: "no",
  DevicePolicy: "auto",
  SystemCallArchitectures: "native",
  RestrictNamespaces: "~cgroup ipc mnt net pid user uts",
  RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6",
  TimeoutStopUSec: "8min",
  CapabilityBoundingSet: "cap_chown cap_dac_override cap_dac_read_search cap_fowner cap_fsetid cap_kill cap_setgid cap_setuid cap_setpcap cap_linux_immutable cap_net_bind_service cap_net_broadcast cap_net_admin cap_net_raw cap_ipc_lock cap_ipc_owner cap_sys_module cap_sys_rawio cap_sys_chroot cap_sys_ptrace cap_sys_pacct cap_sys_admin cap_sys_boot cap_sys_nice cap_sys_resource cap_sys_time cap_sys_tty_config cap_mknod cap_lease cap_audit_write cap_audit_control cap_setfcap cap_mac_override cap_mac_admin cap_syslog cap_wake_alarm cap_block_suspend cap_audit_read cap_perfmon cap_bpf cap_checkpoint_restore",
});
const FIXED_SERVICE_PROPERTIES = FIXED_SEALED_SERVICE_PROPERTIES;

export const REQUIRED_SEALED_ENVIRONMENT = Object.freeze([
  "HF_HUB_OFFLINE=1",
  "LTX_STUDIO_DATA_DIR=/var/lib/ltx-studio",
  "LTX_STUDIO_SEALED_RELEASE=1",
  "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
  "PYTHONNOUSERSITE=1",
  "TRANSFORMERS_OFFLINE=1",
]);
const REQUIRED_ENVIRONMENT = REQUIRED_SEALED_ENVIRONMENT;

export const REQUIRED_SEALED_UNSET_ENVIRONMENT = Object.freeze([
  "DYLD_FRAMEWORK_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_AUDIT",
  "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_LIBRARY_PATH", "LD_PRELOAD", "NODE_OPTIONS",
  "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "PYTHONBREAKPOINT", "PYTHONHOME",
  "PYTHONINSPECT", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE", "VIRTUAL_ENV",
]);
const REQUIRED_UNSET_ENVIRONMENT = REQUIRED_SEALED_UNSET_ENVIRONMENT;

function systemdWords(value) {
  const words = [];
  let word = "";
  let quote = null;
  let escaped = false;
  for (const char of value) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) {
      if (word) { words.push(word); word = ""; }
    } else word += char;
  }
  if (escaped || quote) throw new Error("systemctl property uses malformed quoting");
  if (word) words.push(word);
  return words;
}

function exactRootPolicyFile(path, options = {}) {
  if (!isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error(`Deployment policy path is not canonical: ${path}`);
  }
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || details.uid !== (options.expectedUid ?? 0)
    || details.gid !== (options.expectedGid ?? 0) || (details.mode & 0o222) !== 0) {
    throw new Error(`Deployment policy file is not root-owned and read-only: ${path}`);
  }
  return { path, sha256: sha256StableRegularFile(path) };
}

function parseSystemdProperties(output, expectedAttestationSha256) {
  const properties = {};
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("systemctl returned a malformed property line");
    const name = line.slice(0, separator);
    let value = line.slice(separator + 1).trim();
    if (!SEALED_SERVICE_PROPERTIES.includes(name) || Object.hasOwn(properties, name)) {
      throw new Error(`systemctl returned an unexpected or duplicate property: ${name}`);
    }
    if (name === "Environment") {
      const words = systemdWords(value);
      const pin = words.filter((word) => word.startsWith("LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256="));
      if (expectedAttestationSha256
        ? pin.length !== 1 || pin[0] !== `LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256=${expectedAttestationSha256}`
        : pin.length !== 0) {
        throw new Error("systemctl environment does not contain the exact expected attestation pin");
      }
      value = words.filter((word) => !word.startsWith("LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256="))
        .sort().join(" ");
    }
    properties[name] = value;
  }
  if (Object.keys(properties).length !== SEALED_SERVICE_PROPERTIES.length) {
    throw new Error("systemctl did not return the complete sealed-service property set");
  }
  return properties;
}

function parseExecStart(value) {
  const match = /^\{\s*path=([^;]+?)\s*;\s*argv\[\]=([^;]+?)\s*;(.*)\}$/.exec(value);
  if (!match) throw new Error("Effective ExecStart has an unsupported representation");
  const tail = match[3].split(";").map((entry) => entry.trim()).filter(Boolean);
  const allowedTail = (entry) => entry === "ignore_errors=no"
    || /^(?:start_time|stop_time)=\[[^\]\r\n]{1,128}\]$/.test(entry)
    || /^pid=\d+$/.test(entry)
    || /^code=[A-Za-z()_-]+$/.test(entry)
    || /^status=\d+\/\d+$/.test(entry);
  if (tail.some((entry) => !allowedTail(entry))) throw new Error("Effective ExecStart contains unexpected fields");
  return { path: match[1].trim(), argv: systemdWords(match[2].trim()) };
}

function assertSafeEffectiveService(properties, releaseRoot, releaseDigest) {
  const releaseApp = join(releaseRoot, "apps", "ltx-studio");
  const node = join(releaseApp, "runtime", ".venv", "bin", "node");
  const entrypoint = join(releaseApp, "server", "index.js");
  const execStart = parseExecStart(properties.ExecStart);
  const execCondition = parseExecStart(properties.ExecCondition);
  const expectedEnvironment = [...REQUIRED_ENVIRONMENT, `LTX_STUDIO_EXPECTED_RELEASE_DIGEST=${releaseDigest}`].sort();
  const observedUnset = systemdWords(properties.UnsetEnvironment).sort();
  const expectedUnset = [...REQUIRED_UNSET_ENVIRONMENT].sort();
  if (properties.FragmentPath === ""
    || properties.WorkingDirectory !== releaseApp
    || execStart.path !== node
    || canonicalJson(execStart.argv) !== canonicalJson([node, entrypoint])
    || execCondition.path !== EXTERNAL_BOOTSTRAP_NODE
    || canonicalJson(execCondition.argv) !== canonicalJson([
      EXTERNAL_BOOTSTRAP_NODE,
      EXTERNAL_BOOTSTRAP_EXECUTABLE,
      "verify-start",
      "--release-digest",
      releaseDigest,
    ])
    || canonicalJson(systemdWords(properties.Environment).sort()) !== canonicalJson(expectedEnvironment)
    || canonicalJson(observedUnset) !== canonicalJson(expectedUnset)
    || Object.entries(FIXED_SERVICE_PROPERTIES).some(([name, value]) => properties[name] !== value)
    || [...EMPTY_SERVICE_PROPERTIES].some((name) => properties[name] !== "")) {
    throw new Error("Effective sealed systemd properties violate the fixed production policy");
  }
}

export function captureLoadedServicePolicy(releaseRootArgument, releaseDigest, options = {}) {
  if (!SHA256_PATTERN.test(releaseDigest)) throw new Error("Loaded service requires a release digest");
  const releaseRoot = resolve(releaseRootArgument);
  const execute = options.execute ?? execFileSync;
  const unit = `ltx-studio-sealed@${releaseDigest}.service`;
  const output = execute("/usr/bin/systemctl", [
    "show",
    unit,
    `--property=${SEALED_SERVICE_PROPERTIES.join(",")}`,
    "--no-pager",
  ], {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
  });
  const properties = parseSystemdProperties(output, options.expectedAttestationSha256);
  assertSafeEffectiveService(properties, releaseRoot, releaseDigest);
  const fragment = exactRootPolicyFile(properties.FragmentPath, options);
  assertExternalSealedServicePolicy(options.sealedServicePolicy, fragment);
  const expectedDropInPath = join(
    resolve(options.systemdRoot ?? "/etc/systemd/system"),
    `ltx-studio-sealed@${releaseDigest}.service.d`,
    HOST_TCB_PIN_DROP_IN,
  );
  let dropIn = null;
  if (options.expectedAttestationSha256) {
    const paths = systemdWords(properties.DropInPaths);
    if (canonicalJson(paths) !== canonicalJson([expectedDropInPath])) {
      throw new Error("Loaded sealed unit has an unexpected or incomplete drop-in inventory");
    }
    const exact = exactRootPolicyFile(expectedDropInPath, options);
    if (readFileSync(expectedDropInPath, "utf8") !== hostTcbPinDropIn(options.expectedAttestationSha256)) {
      throw new Error("Loaded Host-TCB pin drop-in is not exact");
    }
    dropIn = {
      path: expectedDropInPath,
      normalization: "exact-host-attestation-pin-token.v1",
      normalizedSha256: sha256Bytes(Buffer.from(hostTcbPinDropInNormalized())),
      mode: "0444",
    };
  } else if (properties.DropInPaths !== "") {
    throw new Error("Unattested sealed unit must not load any drop-in");
  }
  properties.DropInPaths = dropIn ? "<canonical-host-tcb-pin-drop-in>" : "";
  return {
    unit,
    fragment,
    dropIns: dropIn ? [dropIn] : [],
    bootstrapTemplate: {
      path: options.sealedServicePolicy.templatePath,
      sha256: options.sealedServicePolicy.templateSha256,
      policySchemaVersion: options.sealedServicePolicy.schemaVersion,
    },
    properties,
    propertiesSha256: sha256Bytes(Buffer.from(canonicalJson(properties))),
    privilegedControlPlaneIsolation: {
      schemaVersion: "ltx-studio-privileged-control-plane-isolation.v1",
      status: "hold",
      mechanism: "same-local-uid",
      serviceUser: properties.User,
      serviceGroup: properties.Group,
      dynamicUser: properties.DynamicUser,
      protectProc: properties.ProtectProc,
      procSubset: properties.ProcSubset,
      noNewPrivileges: properties.NoNewPrivileges,
      restrictSuidSgid: properties.RestrictSUIDSGID,
      sameUidProcFdTamperingExcluded: false,
      externalSignerSealedFdBrokerAttested: false,
      reasonCode: "same-uid-authority-not-authentic",
      qualificationImpact: "security-and-product-go-blocked",
    },
  };
}

function runtimeIdentityRecord(identity) {
  const result = {
    runtimeInstallSealSha256: identity.runtimeInstallSealSha256,
    runtimeTreeSha256: identity.runtimeTreeSha256,
    runtimePolicySha256: identity.runtimePolicySha256,
    nodeExecutableSha256: identity.nodeExecutableSha256,
  };
  if (!Object.values(result).every((value) => SHA256_PATTERN.test(value))) {
    throw new Error("Host-TCB attestation requires the complete runtime identity");
  }
  return result;
}

export function createHostTcbAttestation(options) {
  if (!SHA256_PATTERN.test(options.releaseDigest)) throw new Error("Invalid attested release digest");
  if (!SHA256_PATTERN.test(options.bootstrapAttestationPinSha256)
    || !SHA256_PATTERN.test(options.bootstrapAuthoritySha256)
    || !SHA256_PATTERN.test(options.manifest?.buildTcb?.sha256)
    || !options.trustPolicyDigests
    || !Object.values(options.trustPolicyDigests).every((value) => SHA256_PATTERN.test(value))) {
    throw new Error("Host-TCB attestation requires a separately authorized bootstrap and Build-TCB identity");
  }
  const observedHostTcb = verifyHostTcbContract(
    options.releaseRoot,
    options.manifest.hostTcb,
    { execute: options.execute, captureElfClosure: options.captureElfClosure },
  );
  const servicePolicy = captureLoadedServicePolicy(options.releaseRoot, options.releaseDigest, {
    execute: options.execute,
    expectedAttestationSha256: options.bootstrapAttestationPinSha256,
    systemdRoot: options.systemdRoot,
    expectedUid: options.expectedPolicyUid,
    expectedGid: options.expectedPolicyGid,
    sealedServicePolicy: options.sealedServicePolicy,
  });
  const postInstallHostClosure = (options.capturePostInstallHostClosure ?? capturePostInstallHostClosure)({
    captureElfClosure: options.captureElfClosure,
    execute: options.execute,
  });
  const closureQualification = postInstallHostClosure?.qualification;
  const closurePass = closureQualification?.status === "pass"
    && Array.isArray(closureQualification.blockers)
    && closureQualification.blockers.length === 0;
  const generatedAt = (options.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, "Z");
  const nonce = options.nonce ?? randomBytes(32).toString("hex");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(generatedAt)
    || !/^[0-9a-f]{64}$/.test(nonce)) {
    throw new Error("Host-TCB attestation timestamp or nonce is invalid");
  }
  return {
    schemaVersion: HOST_TCB_ATTESTATION_SCHEMA,
    releaseDigest: options.releaseDigest,
    runtimeIdentity: runtimeIdentityRecord(options.runtimeIdentity),
    hostTcbContractSha256: sha256Bytes(Buffer.from(canonicalJson(observedHostTcb))),
    postInstallHostClosure,
    postInstallHostClosureSha256: sha256Bytes(Buffer.from(canonicalJson(postInstallHostClosure))),
    servicePolicy,
    servicePolicySha256: sha256Bytes(Buffer.from(canonicalJson(servicePolicy))),
    buildTcbSha256: options.manifest.buildTcb.sha256,
    bootstrapAuthoritySha256: options.bootstrapAuthoritySha256,
    trustPolicyDigests: options.trustPolicyDigests,
    generatedAt,
    nonce,
    qualification: closurePass
      ? { status: "pass", blockers: [] }
      : {
          status: "hold",
          blockers: Array.isArray(closureQualification?.blockers)
            ? [...closureQualification.blockers]
            : ["post-install-host-closure-not-independently-qualified"],
        },
    verdict: closurePass ? "pass" : "hold",
  };
}

export function verifyHostTcbAttestation(bytes, options) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error("External Host-TCB attestation has an invalid size");
  }
  const digest = sha256Bytes(bytes);
  if (digest !== options.expectedAttestationSha256) {
    throw new Error("External Host-TCB attestation does not match its separate startup pin");
  }
  const text = Buffer.from(bytes).toString("utf8");
  const record = JSON.parse(text);
  if (canonicalJson(record) !== text || record.schemaVersion !== HOST_TCB_ATTESTATION_SCHEMA
    || record.releaseDigest !== options.releaseDigest || record.verdict !== "pass"
    || record.qualification?.status !== "pass"
    || !Array.isArray(record.qualification?.blockers)
    || record.qualification.blockers.length !== 0
    || !/^[0-9a-f]{64}$/.test(record.nonce ?? "")
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(record.generatedAt ?? "")
    || canonicalJson(record.runtimeIdentity) !== canonicalJson(runtimeIdentityRecord(options.runtimeIdentity))) {
    throw new Error("External Host-TCB attestation schema or release/runtime binding is invalid");
  }
  const observedHostTcb = verifyHostTcbContract(
    options.releaseRoot,
    options.manifest.hostTcb,
    { execute: options.execute, captureElfClosure: options.captureElfClosure },
  );
  if (record.hostTcbContractSha256 !== sha256Bytes(Buffer.from(canonicalJson(observedHostTcb)))) {
    throw new Error("External Host-TCB attestation is bound to a different host control plane");
  }
  if (options.revalidatePostInstallHostClosure === false) {
    throw new Error("Post-install host-closure revalidation cannot be disabled");
  }
  const observedClosure = (options.capturePostInstallHostClosure ?? capturePostInstallHostClosure)({
    captureElfClosure: options.captureElfClosure,
    execute: options.execute,
  });
  if (record.postInstallHostClosureSha256 !== sha256Bytes(Buffer.from(canonicalJson(observedClosure)))
    || canonicalJson(record.postInstallHostClosure) !== canonicalJson(observedClosure)) {
    throw new Error("Post-install Docker/systemd/sudo/PAM/NSS/loader host closure drifted");
  }
  const observedService = captureLoadedServicePolicy(options.releaseRoot, options.releaseDigest, {
    execute: options.execute,
    expectedAttestationSha256: options.expectedAttestationSha256,
    systemdRoot: options.pinDropInRoot,
    expectedUid: options.expectedPolicyUid,
    expectedGid: options.expectedPolicyGid,
    sealedServicePolicy: options.sealedServicePolicy,
  });
  if (canonicalJson(record.servicePolicy) !== canonicalJson(observedService)) {
    throw new Error("Loaded sealed unit or normalized effective properties drifted after attestation");
  }
  if (record.servicePolicySha256 !== sha256Bytes(Buffer.from(canonicalJson(record.servicePolicy)))
    || record.buildTcbSha256 !== options.manifest?.buildTcb?.sha256
    || record.bootstrapAuthoritySha256 !== options.expectedBootstrapAuthoritySha256
    || canonicalJson(record.trustPolicyDigests) !== canonicalJson(options.expectedTrustPolicyDigests)) {
    throw new Error("Host-TCB attestation Build-TCB, service-policy, or bootstrap-authority binding mismatch");
  }
  if (options.pinDropInRoot !== false) {
    const systemdRoot = resolve(options.pinDropInRoot ?? "/etc/systemd/system");
    const dropIn = join(
      systemdRoot,
      `ltx-studio-sealed@${options.releaseDigest}.service.d`,
      HOST_TCB_PIN_DROP_IN,
    );
    const expected = hostTcbPinDropIn(options.expectedAttestationSha256);
    const details = lstatSync(dropIn);
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
      || details.uid !== (options.expectedPolicyUid ?? 0)
      || details.gid !== (options.expectedPolicyGid ?? 0) || (details.mode & 0o222) !== 0
      || readFileSync(dropIn, "utf8") !== expected) {
      throw new Error("Host-TCB attestation SHA drop-in is missing, mutable, or not exact");
    }
  }
  return { record, attestationSha256: digest };
}

export function hostTcbPinDropIn(attestationSha256) {
  if (!SHA256_PATTERN.test(attestationSha256)) throw new Error("Invalid Host-TCB attestation SHA pin");
  return `[Service]\nEnvironment=LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256=${attestationSha256}\n`;
}

export function hostTcbPinDropInNormalized() {
  return "[Service]\nEnvironment=LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256=<HOST_TCB_ATTESTATION_SHA256>\n";
}

export function runtimeTrustBindingFromHostAttestation(options) {
  const record = options.record;
  const trustPolicyDigests = options.trustPolicyDigests;
  if (record?.schemaVersion !== HOST_TCB_ATTESTATION_SCHEMA
    || !SHA256_PATTERN.test(options.attestationSha256)
    || !record.servicePolicy
    || record.servicePolicySha256 !== sha256Bytes(Buffer.from(canonicalJson(record.servicePolicy)))
    || ![record.hostTcbContractSha256, record.servicePolicySha256, record.buildTcbSha256]
      .every((value) => SHA256_PATTERN.test(value ?? ""))
    || !trustPolicyDigests || !Object.values(trustPolicyDigests).every((value) => SHA256_PATTERN.test(value))) {
    throw new Error(
      "Cannot derive runtime trust: the pinned Host-TCB/service-policy record does not attest a complete exact authority posture",
    );
  }
  const isolation = record.servicePolicy?.privilegedControlPlaneIsolation;
  let authorityIsolation;
  if (isolation?.status === "hold"
    && isolation.mechanism === "same-local-uid"
    && isolation.sameUidProcFdTamperingExcluded === false
    && isolation.externalSignerSealedFdBrokerAttested === false
    && isolation.reasonCode === "same-uid-authority-not-authentic") {
    authorityIsolation = {
      schemaVersion: "ltx-studio-authority-isolation.v1",
      status: "hold",
      mechanism: "same-local-uid",
      attestationSha256: null,
      reasonCode: "same-uid-authority-not-authentic",
    };
  } else if (isolation?.status === "attested"
    && isolation.mechanism === "separate-studio-identity-proc-fd-isolation"
    && isolation.sameUidProcFdTamperingExcluded === true
    && Number.isSafeInteger(isolation.studioUid)
    && Number.isSafeInteger(isolation.authorityOwnerUid)
    && isolation.studioUid >= 0
    && isolation.authorityOwnerUid >= 0
    && isolation.studioUid !== isolation.authorityOwnerUid
    && isolation.protectProc === "invisible"
    && isolation.procSubset === "pid") {
    authorityIsolation = {
      schemaVersion: "ltx-studio-authority-isolation.v1",
      status: "attested",
      mechanism: "separate-studio-identity-proc-fd-isolation",
      hostTcbAttestationSha256: options.attestationSha256,
      brokerAttestationSha256: null,
      reasonCode: null,
    };
  } else if (isolation?.status === "attested"
    && isolation.mechanism === "external-signer-sealed-fd-broker"
    && isolation.externalSignerSealedFdBrokerAttested === true
    && SHA256_PATTERN.test(isolation.brokerAttestationSha256 ?? "")) {
    authorityIsolation = {
      schemaVersion: "ltx-studio-authority-isolation.v1",
      status: "attested",
      mechanism: "external-signer-sealed-fd-broker",
      hostTcbAttestationSha256: options.attestationSha256,
      brokerAttestationSha256: isolation.brokerAttestationSha256,
      reasonCode: null,
    };
  } else {
    throw new Error("Host-TCB service policy does not attest a recognized execution/publication authority isolation posture");
  }
  return {
    schemaVersion: "ltx-studio-runtime-trust-binding.v2",
    hostTcbAttestationSha256: options.attestationSha256,
    hostTcbContractSha256: record.hostTcbContractSha256,
    servicePolicySha256: record.servicePolicySha256,
    buildTcbSha256: record.buildTcbSha256,
    authorityIsolation,
    trustPolicyDigests,
  };
}

function assertWritableRootDirectory(path, expectedUid, expectedGid) {
  const details = lstatSync(path);
  if (!details.isDirectory() || details.isSymbolicLink() || realpathSync(path) !== path
    || details.uid !== expectedUid || details.gid !== expectedGid || (details.mode & 0o022) !== 0) {
    throw new Error(`Attestation output directory is unsafe: ${path}`);
  }
}

export function writeCanonicalRootRecord(directoryArgument, name, record, options = {}) {
  const directory = resolve(directoryArgument);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  if (basename(name) !== name || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error("Attestation output filename is invalid");
  }
  assertWritableRootDirectory(directory, expectedUid, expectedGid);
  const destination = join(directory, name);
  if (existsSync(destination)) throw new Error(`Attestation output already exists: ${destination}`);
  const temporary = join(directory, `.${name}.${randomBytes(12).toString("hex")}.tmp`);
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const bytes = Buffer.from(options.rawText === true ? String(record) : canonicalJson(record));
    writeSync(descriptor, bytes);
    fsyncSync(descriptor);
    fchownSync(descriptor, expectedUid, expectedGid);
    fchmodSync(descriptor, 0o444);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(descriptor);
  try {
    options.failpoint?.("before-rename");
    renameSync(temporary, destination);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
  fsyncDirectory(directory);
  return { path: destination, sha256: sha256StableRegularFile(destination) };
}

export function prepareRootDirectory(pathArgument, options = {}) {
  const path = resolve(pathArgument);
  const expectedUid = options.expectedUid ?? 0;
  const expectedGid = options.expectedGid ?? 0;
  mkdirSync(path, { recursive: true, mode: 0o755 });
  chownSync(path, expectedUid, expectedGid);
  chmodSync(path, 0o755);
  fsyncDirectory(path);
  fsyncDirectory(dirname(path));
  return path;
}

export function installHostTcbPinDropIn(systemdRootArgument, releaseDigest, attestationSha256, options = {}) {
  if (!SHA256_PATTERN.test(releaseDigest)) throw new Error("Invalid release digest for pin drop-in");
  const systemdRoot = resolve(systemdRootArgument);
  const directory = prepareRootDirectory(
    join(systemdRoot, `ltx-studio-sealed@${releaseDigest}.service.d`),
    options,
  );
  const destination = join(directory, HOST_TCB_PIN_DROP_IN);
  const expectedText = hostTcbPinDropIn(attestationSha256);
  if (existsSync(destination)) {
    const details = lstatSync(destination);
    if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
      || details.uid !== (options.expectedUid ?? 0)
      || details.gid !== (options.expectedGid ?? 0) || (details.mode & 0o222) !== 0
      || readFileSync(destination, "utf8") !== expectedText) {
      throw new Error("Existing Host-TCB pin drop-in is not the exact immutable requested pin");
    }
    return { path: destination, sha256: sha256StableRegularFile(destination) };
  }
  return writeCanonicalRootRecord(
    directory,
    HOST_TCB_PIN_DROP_IN,
    expectedText,
    { rawText: true, ...options },
  );
}

export function replaceHostTcbBootstrapPinDropIn(systemdRootArgument, releaseDigest, attestationSha256, options = {}) {
  if (!SHA256_PATTERN.test(releaseDigest) || !SHA256_PATTERN.test(attestationSha256)) {
    throw new Error("Invalid release or attestation digest for bootstrap pin replacement");
  }
  const directory = resolve(
    systemdRootArgument,
    `ltx-studio-sealed@${releaseDigest}.service.d`,
  );
  const destination = join(directory, HOST_TCB_PIN_DROP_IN);
  const details = lstatSync(destination);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || details.uid !== (options.expectedUid ?? 0) || details.gid !== (options.expectedGid ?? 0)
    || (details.mode & 0o222) !== 0
    || readFileSync(destination, "utf8") !== hostTcbPinDropIn(HOST_TCB_BOOTSTRAP_PLACEHOLDER_SHA256)) {
    throw new Error("Only the exact immutable bootstrap placeholder pin may be replaced");
  }
  const replacementName = `.${HOST_TCB_PIN_DROP_IN}.${randomBytes(12).toString("hex")}.replacement`;
  const replacement = writeCanonicalRootRecord(
    directory,
    replacementName,
    hostTcbPinDropIn(attestationSha256),
    { rawText: true, ...options },
  );
  try {
    renameSync(replacement.path, destination);
    fsyncDirectory(directory);
  } catch (error) {
    if (existsSync(replacement.path)) unlinkSync(replacement.path);
    throw error;
  }
  return { path: destination, sha256: sha256StableRegularFile(destination) };
}
