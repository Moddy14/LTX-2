import { isAbsolute, normalize, relative, sep } from "node:path";

const protectedRuntimeSockets = [
  "/run/docker.sock",
  "/run/containerd/containerd.sock",
] as const;

export function evaluatorRuntimeDirectory(unitName: string): string {
  return `/run/${unitName}`;
}

export function evaluatorCredentialPath(unitName: string, credentialName: string): string {
  return `/run/credentials/${unitName}.service/${credentialName}`;
}

export function evaluatorSandboxProperties(
  unitName: string,
  options: { cpuTopologyRequired?: boolean } = {},
): string[] {
  return [
    "--property=DynamicUser=yes",
    `--property=RuntimeDirectory=${unitName}`,
    "--property=RuntimeDirectoryMode=0700",
    "--property=PrivateNetwork=yes",
    "--property=NoNewPrivileges=yes",
    "--property=PrivateDevices=yes",
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=tmpfs",
    "--property=PrivateTmp=yes",
    "--property=ProtectProc=invisible",
    // PyTorch/libcpuinfo requires the non-process /proc/cpuinfo interface.
    // ProtectProc=invisible still hides foreign process entries; all other
    // evaluators retain the stricter pid-only subset by default.
    `--property=ProcSubset=${options.cpuTopologyRequired ? "all" : "pid"}`,
    "--property=ProtectControlGroups=yes",
    "--property=ProtectKernelModules=yes",
    "--property=ProtectKernelTunables=yes",
    "--property=RestrictNamespaces=yes",
    "--property=RestrictSUIDSGID=yes",
    "--property=SystemCallArchitectures=native",
    "--property=TemporaryFileSystem=/run:ro",
    "--property=RestrictAddressFamilies=AF_UNIX",
  ];
}

export function evaluatorSandboxExecutableProperties(
  unitName: string,
  executablePaths: readonly string[],
): string[] {
  const root = evaluatorRuntimeDirectory(unitName);
  if (executablePaths.length === 0 || new Set(executablePaths).size !== executablePaths.length) {
    throw new Error("Evaluator-Sandbox benoetigt eine eindeutige, nicht leere Exec-Allowlist.");
  }
  for (const executablePath of executablePaths) {
    const child = relative(root, executablePath);
    if (!isAbsolute(executablePath)
      || normalize(executablePath) !== executablePath
      || child === ""
      || child === ".."
      || child.startsWith(`..${sep}`)
      || executablePath.includes(":")
      || /\s/u.test(executablePath)) {
      throw new Error("Evaluator-Exec-Allowlist darf den privaten Runtime-Bereich nicht verlassen.");
    }
  }
  // Deliberately do not use NoExecPaths=/ here: dynamically linked CPython,
  // Torch and Whisper need executable mappings from the host ELF TCB. T2A
  // separately marks every sensitive host tree noexec/inaccessible, while
  // this private FD-bound runtime stays noexec except for these exact targets.
  return [
    `--property=NoExecPaths=${root}`,
    ...executablePaths.map((path) => `--property=ExecPaths=${path}`),
  ];
}

function assertSeparatedHostPaths(
  unitName: string,
  paths: readonly string[],
  label: string,
): void {
  const root = evaluatorRuntimeDirectory(unitName);
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    throw new Error(`${label} benoetigt eindeutige, nicht leere Hostpfade.`);
  }
  for (const path of paths) {
    const rootBelowPath = relative(path, root);
    const pathBelowRoot = relative(root, path);
    const overlapsPrivateRuntime = rootBelowPath === ""
      || (!rootBelowPath.startsWith(`..${sep}`) && rootBelowPath !== "..")
      || pathBelowRoot === ""
      || (!pathBelowRoot.startsWith(`..${sep}`) && pathBelowRoot !== "..");
    if (!isAbsolute(path)
      || path === "/"
      || normalize(path) !== path
      || path.includes(":")
      || /\s/u.test(path)
      || overlapsPrivateRuntime) {
      throw new Error(
        `${label} muss absolut sein und vom privaten Runtime-Bereich getrennt bleiben.`,
      );
    }
  }
}

export function evaluatorSandboxInaccessibleProperties(
  unitName: string,
  inaccessiblePaths: readonly string[],
): string[] {
  assertSeparatedHostPaths(unitName, inaccessiblePaths, "Evaluator-Hostpfad-Maske");
  // A preceding ProtectHome=/PrivateTmp= mount may already have hidden a
  // source. The '-' is therefore an order-robust "already inaccessible" case,
  // not a relaxation while the host path is visible.
  return inaccessiblePaths.map((path) => `--property=InaccessiblePaths=-${path}`);
}

export function evaluatorSandboxNoExecHostProperties(
  unitName: string,
  noExecPaths: readonly string[],
): string[] {
  assertSeparatedHostPaths(unitName, noExecPaths, "Evaluator-Host-NoExec-Policy");
  return noExecPaths.map((path) => `--property=NoExecPaths=-${path}`);
}

export { protectedRuntimeSockets };
