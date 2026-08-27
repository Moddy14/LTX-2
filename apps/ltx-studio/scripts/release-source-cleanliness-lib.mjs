import { execFileSync } from "node:child_process";

export function releaseSourceStatus(repoRoot, execute = execFileSync) {
  return execute(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: repoRoot, encoding: "utf8" },
  );
}

const productiveSourceRoots = [
  "apps/ltx-studio/server/",
  "apps/ltx-studio/shared/",
  "apps/ltx-studio/src/",
  "apps/ltx-studio/scripts/",
  "packages/ltx-core/src/",
  "packages/ltx-pipelines/src/",
];
const productiveSourceExtension = /\.(?:cjs|css|js|jsx|json|mjs|mts|ts|tsx)$/;

export function ignoredProductiveReleaseInputs(repoRoot, execute = execFileSync) {
  const ignored = execute(
    "git",
    ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8" },
  ).split("\0").filter(Boolean);
  return ignored.filter((path) => productiveSourceExtension.test(path)
    && productiveSourceRoots.some((root) => path.startsWith(root)));
}

export function assertCleanReleaseSource(repoRoot, execute = execFileSync) {
  const status = releaseSourceStatus(repoRoot, execute);
  const ignoredInputs = ignoredProductiveReleaseInputs(repoRoot, execute);
  if (status.length !== 0 || ignoredInputs.length !== 0) {
    throw new Error("A sealed release requires a clean source tree including all untracked files");
  }
}
