export const HOST_TCB_SCHEMA: string;
export const HOST_TOOL_SPECS: Readonly<Record<string, {
  path: string;
  versionArgs: readonly string[];
  licensePath: string;
  skipDependencies?: boolean;
}>>;
export function captureHostTcbContract(
  releaseRoot: string,
  options: {
    nodeVersion: string;
    uvVersion: string;
    dockerImages: Record<string, string>;
    execute?: typeof import("node:child_process").execFileSync;
    captureElfClosure?: (path: string, options?: unknown) => unknown;
  },
): Record<string, unknown>;
export function verifyHostTcbContract(
  releaseRoot: string,
  contract: unknown,
  options?: {
    execute?: typeof import("node:child_process").execFileSync;
    captureElfClosure?: (path: string, options?: unknown) => unknown;
  },
): Record<string, unknown>;
export function capturePostInstallHostClosure(options?: Record<string, unknown>): Record<string, unknown>;
