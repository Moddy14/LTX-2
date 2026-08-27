import type { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getgid, getuid } from "node:process";

import { afterEach, describe, expect, it } from "vitest";

import {
  createHostTcbAttestation,
  EMPTY_SEALED_SERVICE_PROPERTIES,
  FIXED_SEALED_SERVICE_PROPERTIES,
  HOST_TCB_BOOTSTRAP_PLACEHOLDER_SHA256,
  installHostTcbPinDropIn,
  prepareRootDirectory,
  replaceHostTcbBootstrapPinDropIn,
  REQUIRED_SEALED_ENVIRONMENT,
  REQUIRED_SEALED_UNSET_ENVIRONMENT,
  runtimeTrustBindingFromHostAttestation,
  SEALED_SERVICE_PROPERTIES,
  verifyHostTcbAttestation,
  writeCanonicalRootRecord,
} from "../scripts/host-tcb-attestation-lib.mjs";
import { captureHostTcbContract } from "../scripts/host-tcb-lib.mjs";
import {
  EXTERNAL_BOOTSTRAP_EXECUTABLE,
  EXTERNAL_BOOTSTRAP_NODE,
  SEALED_SERVICE_POLICY_SCHEMA,
} from "../scripts/bootstrap-authority-lib.mjs";
import { canonicalJson } from "../shared/canonicalJson.js";

const roots: string[] = [];
const uid = getuid!();
const gid = getgid!();
const digest = "a".repeat(64);
const trustPolicyDigests = {
  release: "1".repeat(64),
  activationWriter: "2".repeat(64),
  qualificationAuthorizer: "3".repeat(64),
  runtimeRights: "4".repeat(64),
  bootstrapAuthority: "c".repeat(64),
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ltx-host-tcb-attestation-"));
  roots.push(root);
  const app = join(root, "apps", "ltx-studio");
  const paths = {
    node: join(app, "runtime", ".venv", "bin", "node"),
    uv: join(app, "runtime", "toolchain", "uv"),
    nodeLicense: join(app, "runtime", "NODE-LICENSE"),
    uvLicense: join(app, "runtime", "UV-LICENSE"),
    template: join(app, "deploy", "ltx-studio-sealed@.service"),
    fragment: join(root, "installed", "ltx-studio-sealed@.service"),
  };
  for (const path of Object.values(paths)) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(paths.node, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(paths.uv, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(paths.nodeLicense, "node license\n", { mode: 0o444 });
  writeFileSync(paths.uvLicense, "uv license\n", { mode: 0o444 });
  const template = readFileSync(join(process.cwd(), "deploy", "ltx-studio-sealed@.service"));
  writeFileSync(paths.template, template, { mode: 0o444 });
  writeFileSync(paths.fragment, template, { mode: 0o444 });

  const imageDigests = {
    latentsync: `registry.invalid/latentsync@sha256:${"1".repeat(64)}`,
    lipforcing: `registry.invalid/lipforcing@sha256:${"2".repeat(64)}`,
    musetalk: `registry.invalid/musetalk@sha256:${"3".repeat(64)}`,
  };
  const state = {
    sudo: "effective sudo policy v1\n",
    dockerClientVersion: "29.2.1",
    imageId: `sha256:${"4".repeat(64)}`,
    workingDirectory: app,
    pinSha: HOST_TCB_BOOTSTRAP_PLACEHOLDER_SHA256,
    systemdRoot: join(root, "systemd"),
    conditionExtraArgument: "",
    dynamicModuleBytes: "pam-fixture-module-v1",
    dynamicConfiguration: "pam-fixture-config-v1",
    dynamicUser: "no",
    protectProc: "default",
    procSubset: "all",
  };
  const execute = ((path: string, args: readonly string[]) => {
    if (path === "/usr/bin/docker" && args[0] === "version") {
      return JSON.stringify({
        Client: { Version: state.dockerClientVersion, ApiVersion: "1.53" },
        Server: { Version: "29.2.1", ApiVersion: "1.53" },
      });
    }
    if (path === "/usr/bin/docker" && args[0] === "image") {
      const reference = args.at(-1)!;
      return `${JSON.stringify([reference])}\t${state.imageId}\n`;
    }
    if (path === "/usr/bin/sudo" && args[0] === "-n") return state.sudo;
    if (path === "/usr/bin/systemctl" && args[0] === "show" && args[1] === "--property=Version") {
      return "255.4-1ubuntu8.16\n";
    }
    if (path === "/usr/bin/systemctl" && args[0] === "show") {
      const values: Record<string, string> = Object.fromEntries(
        SEALED_SERVICE_PROPERTIES.map((name) => [name, ""]),
      );
      Object.assign(values, FIXED_SEALED_SERVICE_PROPERTIES);
      values.DynamicUser = state.dynamicUser;
      values.ProtectProc = state.protectProc;
      values.ProcSubset = state.procSubset;
      for (const name of EMPTY_SEALED_SERVICE_PROPERTIES) values[name] = "";
      values.Environment = [
        ...REQUIRED_SEALED_ENVIRONMENT,
        `LTX_STUDIO_EXPECTED_RELEASE_DIGEST=${digest}`,
        `LTX_STUDIO_EXPECTED_HOST_TCB_ATTESTATION_SHA256=${state.pinSha}`,
      ].join(" ");
      values.ExecStart = `{ path=${paths.node} ; argv[]=${paths.node} ${join(app, "server", "index.js")} ; ignore_errors=no ; }`;
      values.ExecCondition = `{ path=${EXTERNAL_BOOTSTRAP_NODE} ; argv[]=${EXTERNAL_BOOTSTRAP_NODE} ${EXTERNAL_BOOTSTRAP_EXECUTABLE} verify-start --release-digest ${digest}${state.conditionExtraArgument} ; ignore_errors=no ; }`;
      values.FragmentPath = paths.fragment;
      values.DropInPaths = join(
        state.systemdRoot,
        `ltx-studio-sealed@${digest}.service.d`,
        "10-host-tcb-attestation-pin.conf",
      );
      values.UnsetEnvironment = REQUIRED_SEALED_UNSET_ENVIRONMENT.join(" ");
      values.WorkingDirectory = state.workingDirectory;
      return SEALED_SERVICE_PROPERTIES.map((name) => `${name}=${values[name]}`).join("\n");
    }
    return `${path} fixture-version\n`;
  }) as unknown as typeof execFileSync;

  const captureElfClosure = (path: string) => ({
    schemaVersion: "ltx-studio-elf-dependency-closure.v1",
    executable: path,
    interpreter: "/lib/fixture-loader.so",
    objects: [{ path, sha256: createHash("sha256").update(path).digest("hex") }],
  });
  const systemdRoot = prepareRootDirectory(state.systemdRoot, { expectedUid: uid, expectedGid: gid });
  installHostTcbPinDropIn(systemdRoot, digest, HOST_TCB_BOOTSTRAP_PLACEHOLDER_SHA256, {
    expectedUid: uid,
    expectedGid: gid,
  });
  const hostTcb = captureHostTcbContract(root, {
    nodeVersion: "v24.0.0",
    uvVersion: "uv 0.12.2",
    dockerImages: imageDigests,
    execute,
    captureElfClosure,
  });
  const manifest = { hostTcb, buildTcb: { sha256: "b".repeat(64) } };
  const runtimeIdentity = {
    runtimeInstallSealSha256: "5".repeat(64),
    runtimeTreeSha256: "6".repeat(64),
    runtimePolicySha256: "7".repeat(64),
    nodeExecutableSha256: createHash("sha256").update("#!/bin/sh\nexit 0\n").digest("hex"),
  };
  const capturePostInstallHostClosure = () => ({
    schemaVersion: "ltx-studio-post-install-host-closure.v1",
    docker: { fixture: true },
    policy: {
      fixture: true,
      dynamicModuleSha256: createHash("sha256").update(state.dynamicModuleBytes).digest("hex"),
      dynamicConfigurationSha256: createHash("sha256").update(state.dynamicConfiguration).digest("hex"),
    },
    qualification: { status: "pass", blockers: [] },
  });
  const sealedServicePolicy = {
    schemaVersion: SEALED_SERVICE_POLICY_SCHEMA,
    templatePath: paths.fragment,
    templateSha256: createHash("sha256").update(template).digest("hex"),
    unknownDirectivePolicy: "deny-unlisted-before-install-and-start",
  };
  return { root, paths, state, execute, captureElfClosure, capturePostInstallHostClosure, manifest, runtimeIdentity, systemdRoot, sealedServicePolicy };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("post-install Host-TCB attestation", () => {
  it("binds the runtime, full Host-TCB, loaded unit, and separate root pin", () => {
    const value = fixture();
    const record = createHostTcbAttestation({
      releaseRoot: value.root,
      releaseDigest: digest,
      manifest: value.manifest,
      runtimeIdentity: value.runtimeIdentity,
      execute: value.execute,
      captureElfClosure: value.captureElfClosure,
      capturePostInstallHostClosure: value.capturePostInstallHostClosure,
      bootstrapAttestationPinSha256: HOST_TCB_BOOTSTRAP_PLACEHOLDER_SHA256,
      bootstrapAuthoritySha256: "c".repeat(64),
      trustPolicyDigests,
      systemdRoot: value.systemdRoot,
      expectedPolicyUid: uid,
      expectedPolicyGid: gid,
      sealedServicePolicy: value.sealedServicePolicy,
      now: new Date("2026-08-25T12:00:00Z"),
      nonce: "8".repeat(64),
    });
    const attestationRoot = prepareRootDirectory(join(value.root, "attestations"), {
      expectedUid: uid,
      expectedGid: gid,
    });
    const written = writeCanonicalRootRecord(attestationRoot, "attestation.json", record, {
      expectedUid: uid,
      expectedGid: gid,
    });
    replaceHostTcbBootstrapPinDropIn(value.systemdRoot, digest, written.sha256, {
      expectedUid: uid,
      expectedGid: gid,
    });
    value.state.pinSha = written.sha256;
    expect(verifyHostTcbAttestation(readFileSync(written.path), {
      releaseRoot: value.root,
      releaseDigest: digest,
      manifest: value.manifest,
      runtimeIdentity: value.runtimeIdentity,
      expectedAttestationSha256: written.sha256,
      execute: value.execute,
      captureElfClosure: value.captureElfClosure,
      capturePostInstallHostClosure: value.capturePostInstallHostClosure,
      expectedPolicyUid: uid,
      expectedPolicyGid: gid,
      pinDropInRoot: value.systemdRoot,
      expectedBootstrapAuthoritySha256: "c".repeat(64),
      expectedTrustPolicyDigests: trustPolicyDigests,
      sealedServicePolicy: value.sealedServicePolicy,
    }).record).toEqual(record);
    expect(record.servicePolicy).toMatchObject({
      privilegedControlPlaneIsolation: {
        status: "hold",
        mechanism: "same-local-uid",
        sameUidProcFdTamperingExcluded: false,
        externalSignerSealedFdBrokerAttested: false,
        qualificationImpact: "security-and-product-go-blocked",
      },
    });
    expect(runtimeTrustBindingFromHostAttestation({
      record,
      attestationSha256: written.sha256,
      trustPolicyDigests,
    }).authorityIsolation).toEqual({
      schemaVersion: "ltx-studio-authority-isolation.v1",
      status: "hold",
      mechanism: "same-local-uid",
      attestationSha256: null,
      reasonCode: "same-uid-authority-not-authentic",
    });
    const substitutedIsolation = structuredClone(record) as Record<string, unknown> & {
      servicePolicy: { privilegedControlPlaneIsolation: Record<string, unknown> };
    };
    substitutedIsolation.servicePolicy.privilegedControlPlaneIsolation.status = "attested";
    expect(() => runtimeTrustBindingFromHostAttestation({
      record: substitutedIsolation,
      attestationSha256: written.sha256,
      trustPolicyDigests,
    })).toThrow(/does not attest/i);
  });

  it("denies unit, sudo, daemon, image, attestation, and pin drift", () => {
    const value = fixture();
    const record = createHostTcbAttestation({
      releaseRoot: value.root,
      releaseDigest: digest,
      manifest: value.manifest,
      runtimeIdentity: value.runtimeIdentity,
      execute: value.execute,
      captureElfClosure: value.captureElfClosure,
      capturePostInstallHostClosure: value.capturePostInstallHostClosure,
      bootstrapAttestationPinSha256: HOST_TCB_BOOTSTRAP_PLACEHOLDER_SHA256,
      bootstrapAuthoritySha256: "c".repeat(64),
      trustPolicyDigests,
      systemdRoot: value.systemdRoot,
      expectedPolicyUid: uid,
      expectedPolicyGid: gid,
      now: new Date("2026-08-25T12:00:00Z"),
      nonce: "8".repeat(64),
      sealedServicePolicy: value.sealedServicePolicy,
    });
    const bytes = Buffer.from(canonicalJson(record));
    const expected = createHash("sha256").update(bytes).digest("hex");
    const pin = replaceHostTcbBootstrapPinDropIn(value.systemdRoot, digest, expected, {
      expectedUid: uid,
      expectedGid: gid,
    });
    value.state.pinSha = expected;
    const verify = () => verifyHostTcbAttestation(bytes, {
      releaseRoot: value.root,
      releaseDigest: digest,
      manifest: value.manifest,
      runtimeIdentity: value.runtimeIdentity,
      expectedAttestationSha256: expected,
      execute: value.execute,
      captureElfClosure: value.captureElfClosure,
      capturePostInstallHostClosure: value.capturePostInstallHostClosure,
      expectedPolicyUid: uid,
      expectedPolicyGid: gid,
      pinDropInRoot: value.systemdRoot,
      expectedBootstrapAuthoritySha256: "c".repeat(64),
      expectedTrustPolicyDigests: trustPolicyDigests,
      sealedServicePolicy: value.sealedServicePolicy,
    });

    value.state.workingDirectory = "/tmp/evil";
    expect(verify).toThrow(/systemd|policy|unit/i);
    value.state.workingDirectory = join(value.root, "apps", "ltx-studio");
    value.state.conditionExtraArgument = " --candidate-import";
    expect(verify).toThrow(/systemd|policy|unit/i);
    value.state.conditionExtraArgument = "";
    value.state.dynamicUser = "yes";
    expect(verify).toThrow(/systemd|policy|unit/i);
    value.state.dynamicUser = "no";
    value.state.protectProc = "invisible";
    expect(verify).toThrow(/systemd|policy|unit/i);
    value.state.protectProc = "default";
    value.state.procSubset = "pid";
    expect(verify).toThrow(/systemd|policy|unit/i);
    value.state.procSubset = "all";
    value.state.sudo = "different sudo policy\n";
    expect(verify).toThrow(/host|drift/i);
    value.state.sudo = "effective sudo policy v1\n";
    value.state.dockerClientVersion = "29.2.2";
    expect(verify).toThrow(/host|drift/i);
    value.state.dockerClientVersion = "29.2.1";
    value.state.imageId = `sha256:${"9".repeat(64)}`;
    expect(verify).toThrow(/host|drift/i);
    value.state.imageId = `sha256:${"4".repeat(64)}`;
    value.state.dynamicModuleBytes = "pam-fixture-module-v2";
    expect(verify).toThrow(/closure|drift/i);
    value.state.dynamicModuleBytes = "pam-fixture-module-v1";
    value.state.dynamicConfiguration = "pam-fixture-config-v2";
    expect(verify).toThrow(/closure|drift/i);
    value.state.dynamicConfiguration = "pam-fixture-config-v1";
    expect(() => verifyHostTcbAttestation(bytes, {
      releaseRoot: value.root,
      releaseDigest: digest,
      manifest: value.manifest,
      runtimeIdentity: value.runtimeIdentity,
      expectedAttestationSha256: expected,
      execute: value.execute,
      captureElfClosure: value.captureElfClosure,
      capturePostInstallHostClosure: value.capturePostInstallHostClosure,
      expectedPolicyUid: uid,
      expectedPolicyGid: gid,
      pinDropInRoot: value.systemdRoot,
      expectedBootstrapAuthoritySha256: "c".repeat(64),
      expectedTrustPolicyDigests: trustPolicyDigests,
      sealedServicePolicy: value.sealedServicePolicy,
      revalidatePostInstallHostClosure: false,
    })).toThrow(/cannot be disabled/i);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    expect(() => verifyHostTcbAttestation(changed, {
      releaseRoot: value.root,
      releaseDigest: digest,
      manifest: value.manifest,
      runtimeIdentity: value.runtimeIdentity,
      expectedAttestationSha256: expected,
    })).toThrow(/pin/i);
    chmodSync(pin.path, 0o644);
    writeFileSync(pin.path, "[Service]\nEnvironment=EVIL=1\n");
    chmodSync(pin.path, 0o444);
    expect(verify).toThrow(/drop-in/i);
  });

  it("rejects unlisted privilege-bearing, socket, credential, PAM, standard-I/O, and install directives", () => {
    for (const injected of [
      ["Service", "StandardInput=file:/tmp/input"],
      ["Service", "StandardOutput=truncate:/tmp/root-target"],
      ["Service", "StandardError=file:/tmp/error"],
      ["Service", "PAMName=attacker"],
      ["Service", "OpenFile=/etc/shadow:shadow"],
      ["Service", "Sockets=attacker.socket"],
      ["Service", "LoadCredential=secret:/tmp/secret"],
      ["Install", "Alias=attacker.service"],
      ["Install", "Also=attacker.socket"],
    ] as const) {
      const value = fixture();
      const original = readFileSync(value.paths.fragment, "utf8");
      const marker = `[${injected[0]}]`;
      const mutated = original.replace(marker, `${marker}\n${injected[1]}`);
      chmodSync(value.paths.fragment, 0o644);
      writeFileSync(value.paths.fragment, mutated);
      chmodSync(value.paths.fragment, 0o444);
      // Re-bind the separately pinned policy to the manipulated bytes so the
      // assertion below proves that the raw directive allowlist itself, not
      // the earlier template-digest check, rejects the injected directive.
      value.sealedServicePolicy.templateSha256 = createHash("sha256")
        .update(mutated)
        .digest("hex");
      const directive = injected[1].slice(0, injected[1].indexOf("="));
      expect(() => createHostTcbAttestation({
        releaseRoot: value.root,
        releaseDigest: digest,
        manifest: value.manifest,
        runtimeIdentity: value.runtimeIdentity,
        execute: value.execute,
        captureElfClosure: value.captureElfClosure,
        capturePostInstallHostClosure: value.capturePostInstallHostClosure,
        bootstrapAttestationPinSha256: HOST_TCB_BOOTSTRAP_PLACEHOLDER_SHA256,
        bootstrapAuthoritySha256: "c".repeat(64),
        trustPolicyDigests,
        systemdRoot: value.systemdRoot,
        expectedPolicyUid: uid,
        expectedPolicyGid: gid,
        sealedServicePolicy: value.sealedServicePolicy,
        now: new Date("2026-08-25T12:00:00Z"),
        nonce: "8".repeat(64),
      })).toThrow(new RegExp(
        `Externally pinned sealed unit contains (?:an unapproved privilege-bearing|a duplicate) directive.*${directive}`,
        "i",
      ));
    }
  });
});
