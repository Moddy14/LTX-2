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

export function evaluatorSandboxProperties(unitName: string): string[] {
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
    "--property=ProcSubset=pid",
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

export { protectedRuntimeSockets };
