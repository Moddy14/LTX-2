export function fsyncDirectory(path: string): void;
export function applyCanonicalInstalledMetadata(
  root: string,
  options?: { expectedUid?: number; expectedGid?: number },
): { root: string; expectedUid: number; expectedGid: number; nodeCount: number };
export function sealRegularFileMetadata(
  path: string,
  options?: { expectedUid?: number; expectedGid?: number },
): void;
export function recoverOrphanedInstallStaging(
  parent: string,
  digest: string,
  options?: { expectedUid?: number; expectedGid?: number },
): string[];
export function createInstallStaging(parent: string, digest: string): string;
export function discardInstallStaging(staging: string, parent: string, digest: string): boolean;
export function publishStagedRelease(options: {
  staging: string;
  destination: string;
  parent: string;
  digest: string;
  verify?: () => void;
  failpoint?: (name: "after-verify-before-rename" | "after-rename-and-parent-fsync") => void;
}): string;
