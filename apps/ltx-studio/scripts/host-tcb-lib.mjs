import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { canonicalJson, sha256Bytes } from "./release-manifest-lib.mjs";
import { sha256StableRegularFile } from "./runtime-install-seal-lib.mjs";
import { captureElfDependencyClosure, captureLoaderResolutionPolicy } from "./elf-dependency-lib.mjs";
import {
  EXTERNAL_BOOTSTRAP_EXPECTED_PIN_SHA256,
  EXTERNAL_BOOTSTRAP_POLICY,
  EXTERNAL_SEALED_SERVICE_TEMPLATE,
  SEALED_SERVICE_POLICY_SCHEMA,
} from "./bootstrap-authority-lib.mjs";

export const HOST_TCB_SCHEMA = "ltx-studio-host-tcb.v2";

export const HOST_TOOL_SPECS = Object.freeze({
  ffmpeg: { path: "/usr/bin/ffmpeg", versionArgs: ["-version"], licensePath: "/usr/share/doc/ffmpeg/copyright" },
  ffprobe: { path: "/usr/bin/ffprobe", versionArgs: ["-version"], licensePath: "/usr/share/doc/ffmpeg/copyright" },
  docker: { path: "/usr/bin/docker", versionArgs: ["--version"], licensePath: "/usr/share/common-licenses/Apache-2.0" },
  sudo: { path: "/usr/bin/sudo", versionArgs: ["--version"], licensePath: "/usr/share/doc/sudo/copyright" },
  "systemd-run": { path: "/usr/bin/systemd-run", versionArgs: ["--version"], licensePath: "/usr/share/doc/systemd/copyright" },
  systemctl: { path: "/usr/bin/systemctl", versionArgs: ["--version"], licensePath: "/usr/share/doc/systemd/copyright" },
  env: { path: "/usr/bin/env", versionArgs: ["--version"], licensePath: "/usr/share/doc/coreutils/copyright" },
  python3: { path: "/usr/bin/python3.12", versionArgs: ["--version"], licensePath: "/usr/share/doc/python3.12-minimal/copyright" },
});

function exactRegularFile(path, executable, options = {}) {
  if (!isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error(`Host TCB path is not an exact canonical absolute path: ${path}`);
  }
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink() || details.nlink !== 1
    || (options.requireRootOwnership !== false && (details.uid !== 0 || details.gid !== 0))
    || (details.mode & 0o022) !== 0
    || (executable && (details.mode & 0o111) === 0)) {
    throw new Error(`Host TCB file identity, ownership, or mode is unsafe: ${path}`);
  }
  return { path, sha256: sha256StableRegularFile(path) };
}

function runVersion(path, args, execute) {
  const output = execute(path, args, {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (typeof output !== "string" || output.length === 0) {
    throw new Error(`Host TCB version probe returned no output: ${path}`);
  }
  return {
    args: [...args],
    outputSha256: sha256Bytes(Buffer.from(output)),
    firstLine: output.split(/\r?\n/, 1)[0],
  };
}

function captureDependencies(path, options = {}) {
  return (options.captureElfClosure ?? captureElfDependencyClosure)(path, {
    allowEntryNonRoot: options.allowEntryNonRoot === true,
    requireInterpreter: options.requireInterpreter !== false,
    ...(options.loaderPolicy ? { loaderPolicy: options.loaderPolicy } : {}),
  });
}

const SYSTEM_LIBRARY_DIRECTORIES = Object.freeze([
  "/lib/aarch64-linux-gnu",
  "/usr/lib/aarch64-linux-gnu",
  "/lib/x86_64-linux-gnu",
  "/usr/lib/x86_64-linux-gnu",
  "/lib64",
  "/usr/lib64",
  "/lib",
  "/usr/lib",
]);
const PAM_MODULE_DIRECTORIES = Object.freeze([
  "/usr/lib/aarch64-linux-gnu/security",
  "/usr/lib/x86_64-linux-gnu/security",
  "/lib/aarch64-linux-gnu/security",
  "/lib/x86_64-linux-gnu/security",
  "/usr/lib/security",
  "/lib/security",
]);
const SUDO_PLUGIN_DIRECTORIES = Object.freeze([
  "/usr/libexec/sudo",
  "/usr/lib/aarch64-linux-gnu/sudo",
  "/usr/lib/x86_64-linux-gnu/sudo",
]);

function discoverCanonicalFiles(directories, predicate, depthLimit = 4) {
  const captured = new Map();
  function walk(directory, depth) {
    if (!existsSync(directory) || depth > depthLimit) return;
    const details = lstatSync(directory);
    if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== 0 || details.gid !== 0
      || (details.mode & 0o022) !== 0) {
      throw new Error(`Host module directory is unsafe: ${directory}`);
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(path, depth + 1);
      } else if ((entry.isFile() || entry.isSymbolicLink()) && predicate(entry.name, path)) {
        const canonical = realpathSync(path);
        captured.set(canonical, exactRegularFile(canonical, false));
      }
    }
  }
  for (const directory of directories) walk(directory, 0);
  return [...captured.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function captureLoadableModules(files, captureOptions) {
  return files.map((file) => ({
    ...file,
    elfClosure: captureDependencies(file.path, { ...captureOptions, requireInterpreter: false }),
  }));
}

function buildElfCaptureOptions(options = {}) {
  if (options.captureElfClosure) return { captureElfClosure: options.captureElfClosure };
  return {
    loaderPolicy: options.loaderPolicy ?? captureLoaderResolutionPolicy({ execute: options.execute }),
  };
}

function captureTool(name, spec, execute, options = {}) {
  const resolvedFromFixedPath = ["/usr/sbin", "/usr/bin", "/sbin", "/bin"]
    .map((directory) => join(directory, name))
    .find((candidate) => existsSync(candidate));
  if (!resolvedFromFixedPath || realpathSync(resolvedFromFixedPath) !== spec.path) {
    throw new Error(`Fixed production PATH does not resolve ${name} to its Host-TCB path`);
  }
  const executable = exactRegularFile(spec.path, true);
  const license = exactRegularFile(spec.licensePath, false);
  return {
    name,
    ...executable,
    version: runVersion(spec.path, spec.versionArgs, execute),
    license,
    elfClosure: captureDependencies(spec.path, options),
  };
}

function captureRuntimeComponent(releaseRoot, options, execute, captureOptions = {}) {
  const path = resolve(releaseRoot, options.path);
  const licensePath = resolve(releaseRoot, options.licensePath);
  if (!path.startsWith(`${releaseRoot}/`) || !licensePath.startsWith(`${releaseRoot}/`)) {
    throw new Error(`Runtime TCB component escapes the release: ${options.name}`);
  }
  const executable = exactRegularFile(path, true, { requireRootOwnership: false });
  const license = exactRegularFile(licensePath, false, { requireRootOwnership: false });
  return {
    name: options.name,
    version: options.version,
    path: options.path,
    sha256: executable.sha256,
    license: { path: options.licensePath, sha256: license.sha256 },
    elfClosure: captureDependencies(path, { ...captureOptions, allowEntryNonRoot: true }),
  };
}

function captureDockerImage(name, requestedReference, execute) {
  if (typeof requestedReference !== "string" || requestedReference.length > 512) {
    throw new Error(`Docker image reference is invalid: ${name}`);
  }
  const output = execute(HOST_TOOL_SPECS.docker.path, [
    "image", "inspect", "--format", "{{json .RepoDigests}}\t{{.Id}}", requestedReference,
  ], {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
  const [repoDigestsJson, imageId] = output.split("\t");
  const repoDigests = JSON.parse(repoDigestsJson);
  const reference = Array.isArray(repoDigests)
    ? (/@sha256:[0-9a-f]{64}$/.test(requestedReference) && repoDigests.includes(requestedReference)
      ? requestedReference
      : repoDigests.find((value) => typeof value === "string" && /@sha256:[0-9a-f]{64}$/.test(value)))
    : undefined;
  if (!reference || !/^sha256:[0-9a-f]{64}$/.test(imageId ?? "")) {
    throw new Error(`Docker image has no immutable RepoDigest and image ID: ${name}`);
  }
  return { name, requestedReference, reference, imageId };
}

function optionalExactFile(path, executable = false) {
  return existsSync(path) ? exactRegularFile(realpathSync(path), executable) : null;
}

function exactDirectoryFiles(directory) {
  if (!existsSync(directory)) return [];
  const details = lstatSync(directory);
  if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== 0 || details.gid !== 0
    || (details.mode & 0o022) !== 0) {
    throw new Error(`Host policy directory is unsafe: ${directory}`);
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => exactRegularFile(join(directory, entry.name), false))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function captureIncludeClosure(entryPaths, includeDirectories = []) {
  const pending = entryPaths.filter((path) => existsSync(path)).map((path) => realpathSync(path));
  const captured = new Map();
  while (pending.length > 0) {
    const path = pending.shift();
    if (captured.has(path)) continue;
    const file = exactRegularFile(path, false);
    captured.set(path, file);
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:#include|@include)\s+([^\s#]+)\s*$/)
        ?? line.match(/^\s*(?:#includedir|@includedir)\s+([^\s#]+)\s*$/);
      if (!match) continue;
      const target = isAbsolute(match[1]) ? match[1] : join(dirname(path), match[1]);
      if (existsSync(target) && lstatSync(target).isDirectory()) {
        pending.push(...exactDirectoryFiles(target).map(({ path: child }) => child));
      } else if (existsSync(target)) pending.push(realpathSync(target));
    }
  }
  for (const directory of includeDirectories) {
    for (const file of exactDirectoryFiles(directory)) captured.set(file.path, file);
  }
  return [...captured.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function captureDockerHostClosure(captureOptions = {}) {
  const executables = [
    "/usr/bin/dockerd",
    "/usr/bin/containerd",
    "/usr/bin/containerd-shim-runc-v2",
    "/usr/bin/runc",
  ].map((path) => ({
    name: path.split("/").at(-1),
    ...exactRegularFile(path, true),
    elfClosure: captureDependencies(path, { ...captureOptions, requireInterpreter: false }),
  }));
  const configurationPaths = [
    "/etc/docker/daemon.json",
    "/etc/containerd/config.toml",
    "/usr/lib/systemd/system/docker.service",
    "/usr/lib/systemd/system/docker.socket",
    "/usr/lib/systemd/system/containerd.service",
  ];
  const configuration = configurationPaths.map((path) => optionalExactFile(path)).filter(Boolean);
  const dropIns = [
    ...exactDirectoryFiles("/etc/systemd/system/docker.service.d"),
    ...exactDirectoryFiles("/etc/systemd/system/docker.socket.d"),
    ...exactDirectoryFiles("/etc/systemd/system/containerd.service.d"),
  ];
  return { executables, configuration, dropIns };
}

function captureSudoDynamicClosure(captureOptions = {}) {
  const configuration = captureIncludeClosure(
    ["/etc/sudo.conf", "/etc/sudoers"],
    ["/etc/sudoers.d", "/etc/sudo.conf.d"],
  );
  const explicitPluginPaths = [];
  for (const file of configuration) {
    const text = readFileSync(file.path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*Plugin\s+\S+\s+(\/\S+)(?:\s|$)/i.exec(line);
      if (match) explicitPluginPaths.push(realpathSync(match[1]));
    }
  }
  const discovered = discoverCanonicalFiles(
    SUDO_PLUGIN_DIRECTORIES,
    (name) => name.endsWith(".so") || name.includes(".so."),
    2,
  );
  for (const path of explicitPluginPaths) {
    discovered.push(exactRegularFile(path, false));
  }
  const unique = [...new Map(discovered.map((file) => [file.path, file])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  return { configuration, modules: captureLoadableModules(unique, captureOptions) };
}

function capturePamDynamicClosure(captureOptions = {}) {
  const pamConfigurationEntries = exactDirectoryFiles("/etc/pam.d").map(({ path }) => path);
  const configuration = captureIncludeClosure(pamConfigurationEntries);
  const referencedNames = new Set();
  const explicitPaths = new Set();
  for (const file of configuration) {
    for (const rawLine of readFileSync(file.path, "utf8").split(/\r?\n/)) {
      const line = rawLine.replace(/\s+#.*$/, "").trim();
      if (!line || line.startsWith("#") || line.startsWith("@")) continue;
      for (const token of line.split(/\s+/)) {
        if (/^pam_[A-Za-z0-9_.+-]+\.so(?:\.\d+)*$/.test(token)) referencedNames.add(token);
        else if (/^\/\S*\/pam_[^/\s]+\.so(?:\.\d+)*$/.test(token)) explicitPaths.add(realpathSync(token));
      }
    }
  }
  const discovered = discoverCanonicalFiles(
    PAM_MODULE_DIRECTORIES,
    (name) => /^pam_[A-Za-z0-9_.+-]+\.so(?:\.\d+)*$/.test(name),
    1,
  );
  const byBasename = new Map();
  for (const file of discovered) {
    const name = file.path.split("/").at(-1);
    const values = byBasename.get(name) ?? [];
    values.push(file.path);
    byBasename.set(name, values);
  }
  for (const name of referencedNames) {
    if (!(byBasename.get(name)?.length > 0)) throw new Error(`Referenced PAM module is unresolved: ${name}`);
  }
  for (const path of explicitPaths) discovered.push(exactRegularFile(path, false));
  const unique = [...new Map(discovered.map((file) => [file.path, file])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    configuration,
    referencedModules: [...referencedNames].sort(),
    modules: captureLoadableModules(unique, captureOptions),
  };
}

function captureNssDynamicClosure(captureOptions = {}) {
  const configuration = exactRegularFile("/etc/nsswitch.conf", false);
  const requestedServices = new Set();
  for (const rawLine of readFileSync(configuration.path, "utf8").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, "").trim();
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const tokens = line.slice(separator + 1).match(/\[[^\]]+\]|[^\s]+/g) ?? [];
    for (const token of tokens) {
      if (!token.startsWith("[") && /^[A-Za-z0-9_-]+$/.test(token)) requestedServices.add(token);
    }
  }
  const discovered = discoverCanonicalFiles(
    SYSTEM_LIBRARY_DIRECTORIES,
    (name) => /^libnss_[A-Za-z0-9_-]+\.so(?:\.\d+)*$/.test(name),
    1,
  );
  const discoveredServices = new Set(discovered.map(({ path }) => {
    const match = /\/libnss_([A-Za-z0-9_-]+)\.so/.exec(path);
    return match?.[1];
  }).filter(Boolean));
  const glibcBuiltins = new Set(["compat", "dns", "files"]);
  const unresolved = [...requestedServices].filter((name) =>
    !discoveredServices.has(name) && !glibcBuiltins.has(name));
  if (unresolved.length > 0) throw new Error(`Referenced NSS modules are unresolved: ${unresolved.join(", ")}`);
  return {
    configuration,
    requestedServices: [...requestedServices].sort(),
    glibcBuiltins: [...requestedServices].filter((name) => glibcBuiltins.has(name)).sort(),
    modules: captureLoadableModules(discovered, captureOptions),
  };
}

function captureSystemPolicyClosure(captureOptions = {}) {
  const sudo = captureSudoDynamicClosure(captureOptions);
  const pam = capturePamDynamicClosure(captureOptions);
  const nss = captureNssDynamicClosure(captureOptions);
  const loaderConfiguration = [
    ...captureIncludeClosure(["/etc/ld.so.conf"], ["/etc/ld.so.conf.d"]),
    optionalExactFile("/etc/ld.so.cache"),
  ].filter(Boolean);
  const systemd = {
    manager: {
      ...exactRegularFile("/usr/lib/systemd/systemd", true),
      elfClosure: captureDependencies("/usr/lib/systemd/systemd", captureOptions),
    },
    configuration: [
      optionalExactFile("/etc/systemd/system.conf"),
      optionalExactFile("/etc/systemd/user.conf"),
    ].filter(Boolean),
    dropIns: [
      ...exactDirectoryFiles("/etc/systemd/system.conf.d"),
      ...exactDirectoryFiles("/etc/systemd/user.conf.d"),
    ],
  };
  return { sudo, pam, nss, loaderConfiguration, systemd };
}

function captureControlPlane(releaseRoot, execute, captureOptions = {}) {
  const dockerVersionOutput = execute(HOST_TOOL_SPECS.docker.path, [
    "version", "--format", "{{json .}}",
  ], {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
  const dockerVersion = JSON.parse(dockerVersionOutput);
  if (!dockerVersion?.Client?.Version || !dockerVersion?.Client?.ApiVersion
    || !dockerVersion?.Server?.Version || !dockerVersion?.Server?.ApiVersion) {
    throw new Error("Docker Client/Server/API version contract is incomplete");
  }
  const normalizedDockerVersion = canonicalJson(dockerVersion);
  const sudoPolicyOutput = execute(HOST_TOOL_SPECS.sudo.path, ["-n", "-l"], {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!sudoPolicyOutput.trim()) throw new Error("Effective sudo policy probe returned no output");

  const pid1Name = readFileSync("/proc/1/comm", "utf8").trim();
  const pid1Path = "/usr/lib/systemd/systemd";
  const pid1 = exactRegularFile(pid1Path, true);
  const managerVersion = execute(HOST_TOOL_SPECS.systemctl.path, [
    "show", "--property=Version", "--value",
  ], {
    encoding: "utf8",
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    maxBuffer: 4 * 1024 * 1024,
  }).trim();
  if (!managerVersion || pid1Name !== "systemd") {
    throw new Error("PID1 is not an attestable systemd manager");
  }

  return {
    dockerEngine: {
      clientVersion: dockerVersion.Client.Version,
      clientApiVersion: dockerVersion.Client.ApiVersion,
      serverVersion: dockerVersion.Server.Version,
      serverApiVersion: dockerVersion.Server.ApiVersion,
      versionDocumentSha256: sha256Bytes(Buffer.from(normalizedDockerVersion)),
    },
    sudoPolicy: {
      probe: ["-n", "-l"],
      outputSha256: sha256Bytes(Buffer.from(sudoPolicyOutput)),
    },
    systemdManager: {
      ...pid1,
      pid1Name,
      version: managerVersion,
      versionSha256: sha256Bytes(Buffer.from(`${managerVersion}\n`)),
    },
    deploymentPolicy: {
      status: "separate-bootstrap-policy-and-post-install-attestation-required",
      candidateReleaseMayAttestServicePolicy: false,
      bootstrapPolicyPath: EXTERNAL_BOOTSTRAP_POLICY,
      bootstrapExpectedPinSha256Path: EXTERNAL_BOOTSTRAP_EXPECTED_PIN_SHA256,
      serviceTemplate: {
        schemaVersion: SEALED_SERVICE_POLICY_SCHEMA,
        path: EXTERNAL_SEALED_SERVICE_TEMPLATE,
        digestSource: "separately-signed-and-out-of-band-pinned-bootstrap-policy",
      },
      attestationSchema: "ltx-studio-host-tcb-attestation.v2",
      startupRequirement: "separately-pinned-root-owned-post-install-attestation",
    },
    postInstallClosure: {
      status: "root-attestation-required",
      schemaVersion: "ltx-studio-post-install-host-closure.v1",
    },
    residualTrustBoundary: {
      schemaVersion: "ltx-studio-host-admin-boundary.v1",
      rootAdministratorCanReplacePinsAndTrustPolicies: true,
      tpmMeasuredBootRequired: false,
      tpmMeasuredBootObserved: false,
      qualificationImpact: "root-admin-or-offline-host-compromise-remains-outside-software-attestation",
    },
  };
}

export function capturePostInstallHostClosure(options = {}) {
  const captureOptions = buildElfCaptureOptions(options);
  return {
    schemaVersion: "ltx-studio-post-install-host-closure.v1",
    docker: captureDockerHostClosure(captureOptions),
    policy: captureSystemPolicyClosure(captureOptions),
    qualification: {
      status: "hold",
      blockers: [
        "sudo-plugin-inventory-not-proven-runtime-complete",
        "pam-module-inventory-not-proven-runtime-complete",
        "nss-module-inventory-not-proven-runtime-complete",
        "ld-so-cache-hwcaps-platform-resolution-unverified",
        "systemd-docker-runtime-plugin-closure-unresolved",
        "privileged-sudo-docker-control-plane-broker-missing",
        "sealed-service-process-isolation-insufficient-for-security-go",
        "same-uid-authority-archive-and-proc-fd-forgery-not-excluded",
        "separate-studio-identity-or-external-signer-sealed-fd-broker-missing",
        "tpm-measured-boot-evidence-missing",
      ],
    },
  };
}

export function captureHostTcbContract(releaseRootArgument, options = {}) {
  const releaseRoot = resolve(releaseRootArgument);
  const execute = options.execute ?? execFileSync;
  const captureOptions = buildElfCaptureOptions(options);
  const tools = Object.entries(HOST_TOOL_SPECS)
    .map(([name, spec]) => captureTool(name, spec, execute, captureOptions));
  const runtimeComponents = [
    captureRuntimeComponent(releaseRoot, {
      name: "node",
      version: options.nodeVersion,
      path: "apps/ltx-studio/runtime/.venv/bin/node",
      licensePath: "apps/ltx-studio/runtime/NODE-LICENSE",
    }, execute, captureOptions),
    captureRuntimeComponent(releaseRoot, {
      name: "uv",
      version: options.uvVersion,
      path: "apps/ltx-studio/runtime/toolchain/uv",
      licensePath: "apps/ltx-studio/runtime/UV-LICENSE",
    }, execute, captureOptions),
  ];
  const dockerImages = Object.entries(options.dockerImages ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, reference]) => captureDockerImage(name, reference, execute));
  const controlPlane = captureControlPlane(releaseRoot, execute, captureOptions);
  return { schemaVersion: HOST_TCB_SCHEMA, tools, runtimeComponents, dockerImages, controlPlane };
}

export function verifyHostTcbContract(releaseRootArgument, rawContract, options = {}) {
  const releaseRoot = resolve(releaseRootArgument);
  if (rawContract?.schemaVersion !== HOST_TCB_SCHEMA
    || !Array.isArray(rawContract.tools)
    || !Array.isArray(rawContract.runtimeComponents)
    || !Array.isArray(rawContract.dockerImages)
    || rawContract.controlPlane?.deploymentPolicy?.status
      !== "separate-bootstrap-policy-and-post-install-attestation-required"
    || rawContract.controlPlane.deploymentPolicy.candidateReleaseMayAttestServicePolicy !== false
    || rawContract.controlPlane.deploymentPolicy.serviceTemplate?.schemaVersion
      !== SEALED_SERVICE_POLICY_SCHEMA) {
    throw new Error("Host TCB contract schema is invalid");
  }
  const expectedNames = Object.keys(HOST_TOOL_SPECS).sort();
  const actualNames = rawContract.tools.map(({ name }) => name).sort();
  if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) {
    throw new Error("Host TCB tool set is incomplete or unexpected");
  }
  const execute = options.execute ?? execFileSync;
  const observed = captureHostTcbContract(releaseRoot, {
    execute,
    captureElfClosure: options.captureElfClosure,
    nodeVersion: rawContract.runtimeComponents.find(({ name }) => name === "node")?.version,
    uvVersion: rawContract.runtimeComponents.find(({ name }) => name === "uv")?.version,
    dockerImages: Object.fromEntries(rawContract.dockerImages.map(({ name, reference }) => [name, reference])),
  });
  for (const image of observed.dockerImages) {
    image.requestedReference = rawContract.dockerImages.find(({ name }) => name === image.name)
      ?.requestedReference;
  }
  if (canonicalJson(observed) !== canonicalJson(rawContract)) {
    throw new Error("Host TCB executable, version, license, dependency, or Docker image drift detected");
  }
  return observed;
}
