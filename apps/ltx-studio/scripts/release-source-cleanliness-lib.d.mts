export function releaseSourceStatus(
  repoRoot: string,
  execute?: typeof import("node:child_process").execFileSync,
): string;

export function assertCleanReleaseSource(
  repoRoot: string,
  execute?: typeof import("node:child_process").execFileSync,
): void;
export function ignoredProductiveReleaseInputs(
  repoRoot: string,
  execute?: typeof import("node:child_process").execFileSync,
): string[];
