import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const releaseRoot = join(appRoot, "build", "release-root");
const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");

if (!releaseRoot.startsWith(`${join(appRoot, "build")}${sep}`)) {
  throw new Error(`Unexpected release root: ${releaseRoot}`);
}
if (!existsSync(join(releaseAppRoot, "server", "index.js"))) {
  throw new Error("Compiled release server is missing; run release:emit first");
}
const dirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=no"], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (dirty.trim()) throw new Error("A sealed release stage requires a clean tracked worktree");

const allowedFiles = new Set([
  "LICENSE",
  "pyproject.toml",
  "apps/ltx-studio/package-lock.json",
  "apps/ltx-studio/package.json",
]);
const allowedPrefixes = [
  "apps/ltx-studio/deploy/",
  "apps/ltx-studio/evaluators/",
  "apps/ltx-studio/models/",
  "apps/ltx-studio/release/",
  "apps/ltx-studio/runtime/",
  "apps/ltx-studio/scripts/",
  "packages/ltx-core/",
  "packages/ltx-pipelines/",
];
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((path) => allowedFiles.has(path) || allowedPrefixes.some((prefix) => path.startsWith(prefix)))
  .filter((path) => !path.endsWith(".ts") && !path.endsWith(".tsx"));

for (const path of tracked) {
  const source = join(repoRoot, path);
  const destination = join(releaseRoot, path);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  cpSync(source, destination, { preserveTimestamps: false });
}
cpSync(join(appRoot, "dist"), join(releaseAppRoot, "dist"), {
  recursive: true,
  preserveTimestamps: false,
});

execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: releaseAppRoot,
  stdio: "inherit",
});
const runtimeRoot = join(releaseAppRoot, "runtime");
const releaseEnvironment = { ...process.env };
delete releaseEnvironment.VIRTUAL_ENV;
execFileSync("uv", [
  "sync",
  "--project", runtimeRoot,
  "--locked",
  "--no-dev",
  "--no-editable",
  "--compile-bytecode",
], { cwd: releaseRoot, env: releaseEnvironment, stdio: "inherit" });
const releasePython = join(runtimeRoot, ".venv", "bin", "python");
execFileSync(releasePython, [join(runtimeRoot, "normalize_cusparselt_wheel.py")], {
  cwd: releaseRoot,
  stdio: "inherit",
});
execFileSync("uv", ["pip", "check", "--python", releasePython], {
  cwd: releaseRoot,
  env: releaseEnvironment,
  stdio: "inherit",
});
execFileSync(releasePython, ["-I", join(runtimeRoot, "verify_runtime.py")], {
  cwd: releaseRoot,
  stdio: "inherit",
});
const packagePath = join(releaseAppRoot, "package.json");
const sourcePackage = JSON.parse(readFileSync(packagePath, "utf8"));
const productionPackage = {
  name: sourcePackage.name,
  version: sourcePackage.version,
  private: true,
  type: "module",
  scripts: {
    start: "node server/index.js",
    "audit:release": "node scripts/audit-release.mjs",
    "audit:finalize": "node scripts/finalize-release-audit.mjs",
  },
  dependencies: sourcePackage.dependencies,
};
writeFileSync(packagePath, `${JSON.stringify(productionPackage, null, 2)}\n`, { mode: 0o644 });

for (const forbidden of [
  join(releaseAppRoot, "node_modules", ".bin", "tsx"),
  join(releaseAppRoot, "server", "index.ts"),
]) {
  if (existsSync(forbidden)) throw new Error(`Forbidden production source/runtime found: ${relative(releaseRoot, forbidden)}`);
}
process.stdout.write(`${releaseRoot}\n`);
