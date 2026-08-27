export type RuntimeInstallSealResult = {
  seal: Record<string, unknown>;
  sealPath: string;
  sealSha256: string;
  ownership: null | {
    expectedUid: number;
    expectedGid: number;
    requireReadOnly: boolean;
    nodeCount: number;
  };
};

export const TRUSTED_RELEASE_PARENT: string;
export const RUNTIME_INSTALL_INVENTORY_SCHEMA: string;
export function readStableRegularFile(path: string, maximumBytes?: number): Buffer;
export function sha256StableRegularFile(path: string): string;

export function runtimeInstallIntegrityPolicy(): Record<string, unknown>;
export function digestRuntimeTree(runtimeRoot: string, options?: {
  canonicalInstalledModes?: boolean;
}): {
  algorithm: string;
  canonicalization: string;
  entryCount: number;
  fileCount: number;
  directoryCount: number;
  symlinkCount: number;
  totalFileBytes: number;
  treeSha256: string;
};
export function expectedRuntimeInstallInventory(runtimeRoot: string): {
  schemaVersion: string;
  tree: ReturnType<typeof digestRuntimeTree>;
};
export function verifyRuntimeInstallInventory(
  releaseRoot: string,
  manifest: unknown,
  options?: { installedModesApplied?: boolean },
): { schemaVersion: string; tree: ReturnType<typeof digestRuntimeTree> };
export function createRuntimeInstallSeal(
  releaseRoot: string,
  manifest: unknown,
  releaseDigest: string,
): Omit<RuntimeInstallSealResult, "ownership">;
export function materializeExternalInterpreterSymlinks(runtimeRoot: string): string[];
export function materializeTrustedExecutable(
  source: string,
  destination: string,
  expectedSha256: string,
): { path: string; sha256: string };
export function verifyTrustedReleaseParent(
  parent: string,
  options?: {
    expectedParent?: string;
    trustAnchor?: string;
    expectedUid?: number;
    expectedGid?: number;
    filesystem?: {
      realpathSync(path: string): string;
      lstatSync(path: string): {
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
        uid: number;
        gid: number;
        mode: number;
      };
    };
  },
): { parent: string; expectedUid: number; expectedGid: number; checked: string[] };
export function verifyTrustedReleaseRootLocation(
  releaseRoot: string,
  releaseDigest: string,
  options?: {
    expectedParent?: string;
    trustAnchor?: string;
    expectedUid?: number;
    expectedGid?: number;
    filesystem?: {
      realpathSync(path: string): string;
      lstatSync(path: string): {
        isDirectory(): boolean;
        isSymbolicLink(): boolean;
        uid: number;
        gid: number;
        mode: number;
      };
    };
  },
): {
  releaseRoot: string;
  releaseDigest: string;
  parentChain: ReturnType<typeof verifyTrustedReleaseParent>;
};
export function verifyReleaseOwnershipAndPermissions(
  releaseRoot: string,
  options?: {
    expectedUid?: number;
    expectedGid?: number;
    requireReadOnly?: boolean;
  },
): NonNullable<RuntimeInstallSealResult["ownership"]>;

export function verifyRuntimeInstallSeal(
  releaseRoot: string,
  manifest: unknown,
  releaseDigest: string,
  options?: {
    ownership?: {
      expectedUid?: number;
      expectedGid?: number;
      requireReadOnly?: boolean;
    };
  },
): RuntimeInstallSealResult;
