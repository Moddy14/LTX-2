import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  m0BaselineSchema,
  m0ContractInventorySchema,
  m0VerificationSchema,
  type M0Baseline,
  type M0ContractInventory,
} from "../shared/m0Evidence.js";
import { candidateReleaseSurfaceSchema } from "../shared/releaseSurface.js";

const appRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(appRoot, "../..");

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function gitRaw(...args: string[]): string {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function repoPath(path: string): string {
  return relative(repositoryRoot, path).split("\\").join("/");
}

function fileDigest(path: string) {
  const bytes = readFileSync(path);
  return { path: repoPath(path), sha256: sha256Bytes(bytes), bytes: bytes.length };
}

function writeCanonical(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, canonicalJson(value), { mode: 0o644 });
  chmodSync(path, 0o644);
}

function lines(path: string): string[] {
  return readFileSync(path, "utf8").split(/\r?\n/);
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function discoverRoutes(path: string) {
  const routes: Array<{ method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT"; path: string; source: { path: string; line: number } }> = [];
  for (const [index, line] of lines(path).entries()) {
    const match = line.match(/\bapp\.(delete|get|patch|post|put)\(\s*["'`]([^"'`]+)["'`]/i);
    if (!match) continue;
    routes.push({
      method: match[1]!.toUpperCase() as (typeof routes)[number]["method"],
      path: match[2]!,
      source: { path: repoPath(path), line: index + 1 },
    });
  }
  return routes.sort((left, right) =>
    `${left.path}:${left.method}`.localeCompare(`${right.path}:${right.method}`));
}

function discoverSchemas(paths: string[]) {
  const schemas: Array<{ name: string; source: { path: string; line: number } }> = [];
  for (const path of paths) {
    for (const [index, line] of lines(path).entries()) {
      const match = line.match(/export\s+const\s+([A-Za-z][A-Za-z0-9]*Schema)\b/);
      if (match) schemas.push({ name: match[1]!, source: { path: repoPath(path), line: index + 1 } });
    }
  }
  return schemas.sort((left, right) =>
    `${left.source.path}:${left.name}`.localeCompare(`${right.source.path}:${right.name}`));
}

function filesUnder(root: string, suffix: string): string[] {
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(path, suffix));
    else if (entry.isFile() && path.endsWith(suffix)) output.push(path);
  }
  return output.sort();
}

function discoverCli(path: string): string[] {
  return sortedUnique(lines(path).flatMap((line) => {
    const match = line.match(/\.add_parser\(\s*["']([^"']+)["']/);
    return match ? [match[1]!] : [];
  }));
}

function discoverTypeScriptExports(path: string): string[] {
  return sortedUnique(lines(path).flatMap((line) => {
    const match = line.match(/^export\s+(?:async\s+)?(?:const|class|function|type|interface)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    return match ? [match[1]!] : [];
  }));
}

function discoverPythonExports(path: string): string[] {
  const content = readFileSync(path, "utf8");
  const allMatch = content.match(/__all__\s*=\s*\[([\s\S]*?)\]/m);
  if (allMatch) return sortedUnique([...allMatch[1]!.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!));
  return sortedUnique(lines(path).flatMap((line) => {
    const match = line.match(/^(?:class|def)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    return match && !match[1]!.startsWith("_") ? [match[1]!] : [];
  }));
}

function commandOutput(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

function runtimeEvidence(): M0Baseline["runtime"] {
  const serviceCandidates = ["ltx-studio-session.service", "ltx-studio.service"];
  const serviceUnit = serviceCandidates.find((unit) =>
    commandOutput("systemctl", ["--user", "show", unit, "--property=LoadState", "--value"]) === "loaded") ?? null;
  const activeEnterTimestamp = serviceUnit
    ? commandOutput("systemctl", ["--user", "show", serviceUnit, "--property=ActiveEnterTimestamp", "--value"])
    : null;
  const pidText = serviceUnit
    ? commandOutput("systemctl", ["--user", "show", serviceUnit, "--property=MainPID", "--value"])
    : null;
  const mainPid = pidText && /^\d+$/.test(pidText) ? Number(pidText) : null;
  const processStart = mainPid && mainPid > 0
    ? commandOutput("ps", ["-o", "lstart=", "-p", String(mainPid)])
    : null;
  let healthStatus: number | null = null;
  let healthBodySha256: string | null = null;
  try {
    const output = execFileSync("curl", ["-sS", "-w", "\n%{http_code}", "http://127.0.0.1:4318/api/health"], {
      encoding: "utf8",
    });
    const boundary = output.lastIndexOf("\n");
    healthBodySha256 = sha256Bytes(output.slice(0, boundary));
    healthStatus = Number(output.slice(boundary + 1));
  } catch {
    healthStatus = 0;
  }
  const releaseRoot = "/opt/ltx-studio/releases";
  const installedReleaseDigests = (() => {
    try {
      return readdirSync(releaseRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map(({ name }) => name)
        .sort();
    } catch {
      return [];
    }
  })();
  const currentPath = "/opt/ltx-studio/current";
  let currentReleaseTarget: string | null = null;
  try {
    currentReleaseTarget = lstatSync(currentPath).isSymbolicLink() ? readlinkSync(currentPath) : currentPath;
  } catch {
    currentReleaseTarget = null;
  }
  return {
    studioEndpoint: "http://127.0.0.1:4318",
    serviceUnit,
    activeEnterTimestamp,
    mainPid,
    processStart,
    healthStatus,
    healthBodySha256,
    currentReleaseTarget,
    installedReleaseDigests,
  };
}

function remoteUrls() {
  return git("remote").split("\n").filter(Boolean).sort().map((name) => ({
    name,
    fetchUrl: git("remote", "get-url", name),
    pushUrl: git("remote", "get-url", "--push", name),
  }));
}

function countRunningJobs(): number {
  try {
    const body = execFileSync("curl", ["-sS", "http://127.0.0.1:4318/api/jobs"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const parsed = JSON.parse(body) as unknown;
    const jobs = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { jobs?: unknown }).jobs)
        ? (parsed as { jobs: unknown[] }).jobs
        : null;
    if (!jobs) throw new Error("jobs response does not contain an array");
    return jobs.filter((job) => typeof job === "object" && job !== null
      && (job as { status?: unknown }).status === "running").length;
  } catch (error) {
    throw new Error(`cannot prove empty LTX job set: ${String(error)}`);
  }
}

function main(): void {
  const prePlan = git("rev-parse", `${argument("--pre-plan")}^{commit}`);
  const reviewedPlan = git("rev-parse", `${argument("--reviewed-plan")}^{commit}`);
  if (git("rev-parse", "HEAD") !== reviewedPlan) throw new Error("HEAD must equal reviewed plan commit");
  const evidenceWorktreeChanges = gitRaw("status", "--porcelain").split("\n").filter(Boolean).map((line) =>
    line.slice(3).split(" -> ").at(-1)!).sort();
  const allowedEvidencePaths = [
    ".gitignore",
    "apps/ltx-studio/package.json",
    "apps/ltx-studio/scripts/generate-m0-evidence.ts",
    "apps/ltx-studio/shared/m0Evidence.ts",
    "apps/ltx-studio/tests/m0-evidence.test.ts",
    "apps/ltx-studio/docs/evidence/m0-verification-2026-08-14.json",
    "apps/ltx-studio/docs/evidence/m0-baseline-2026-08-14.json",
    "apps/ltx-studio/docs/evidence/m0-contract-inventory-2026-08-14.json",
  ];
  const unrelatedChanges = evidenceWorktreeChanges.filter((path) => !allowedEvidencePaths.includes(path));
  if (unrelatedChanges.length > 0) {
    throw new Error(`unrelated M0 worktree changes: ${unrelatedChanges.join(", ")}`);
  }

  const verificationPath = resolve(repositoryRoot, argument("--verification"));
  const verificationBytes = readFileSync(verificationPath);
  const verification = m0VerificationSchema.parse(JSON.parse(verificationBytes.toString("utf8")));
  if (verification.reviewedPlanCommit !== reviewedPlan) {
    throw new Error("verification report does not bind reviewed plan commit");
  }

  const originMain = git("rev-parse", "origin/main^{commit}");
  const [aheadOfOriginMain, behindOriginMain] = git(
    "rev-list", "--left-right", "--count", `origin/main...${reviewedPlan}`,
  ).split(/\s+/).map(Number).reverse() as [number, number];
  const mergeBase = git("merge-base", originMain, reviewedPlan);

  const prePlanRef = "refs/heads/backup/feat-ltx-lipsync-lease-pre-plan-20260814";
  const reviewedPlanRef = "refs/heads/backup/feat-ltx-lipsync-lease-reviewed-plan-20260814";
  const remoteRefs = [
    { remote: "moddy-fork", ref: prePlanRef, commit: git("ls-remote", "moddy-fork", prePlanRef).split(/\s+/)[0]! },
    { remote: "moddy-fork", ref: reviewedPlanRef, commit: git("ls-remote", "moddy-fork", reviewedPlanRef).split(/\s+/)[0]! },
  ];
  if (remoteRefs[0]!.commit !== prePlan || remoteRefs[1]!.commit !== reviewedPlan) {
    throw new Error("M0 remote backup refs do not match their bound commits");
  }

  const dependencyCandidates = [
    resolve(repositoryRoot, "pyproject.toml"),
    resolve(repositoryRoot, "uv.lock"),
    resolve(appRoot, "package.json"),
    resolve(appRoot, "package-lock.json"),
    resolve(appRoot, "runtime/pyproject.toml"),
    resolve(appRoot, "runtime/uv.lock"),
  ].filter((path) => {
    try { return statSync(path).isFile(); } catch { return false; }
  });

  const baseline = m0BaselineSchema.parse({
    schemaVersion: "ltx-studio-m0-baseline.v1",
    capturedAt: verification.capturedAt,
    identities: [
      { role: "pre_plan_baseline", commit: prePlan, tree: git("rev-parse", `${prePlan}^{tree}`) },
      { role: "reviewed_plan_source_commit", commit: reviewedPlan, tree: git("rev-parse", `${reviewedPlan}^{tree}`) },
    ],
    repository: {
      branch: git("branch", "--show-current"),
      reviewedPlanWasClean: true,
      evidenceWorktreeChanges,
      originMain,
      aheadOfOriginMain,
      behindOriginMain,
      localCommitsSinceMergeBase: Number(git("rev-list", "--count", `${mergeBase}..${reviewedPlan}`)),
      remotes: remoteUrls(),
      remoteRefs,
    },
    activeJobs: { endpoint: "http://127.0.0.1:4318/api/jobs", running: countRunningJobs() },
    verification: {
      path: repoPath(verificationPath),
      sha256: sha256Bytes(verificationBytes),
      commands: verification.commands,
    },
    dependencyInputs: dependencyCandidates.map(fileDigest).sort((left, right) => left.path.localeCompare(right.path)),
    runtime: runtimeEvidence(),
  });

  const surfacePath = resolve(appRoot, "release/candidate-release-surface.v1.json");
  const surface = candidateReleaseSurfaceSchema.parse(JSON.parse(readFileSync(surfacePath, "utf8")));
  const sharedSources = filesUnder(resolve(appRoot, "shared"), ".ts");
  const serverSources = filesUnder(resolve(appRoot, "server"), ".ts");
  const testSources = filesUnder(resolve(appRoot, "tests"), ".ts");
  const routeSource = resolve(appRoot, "server/index.ts");
  const cliPrograms = [resolve(repositoryRoot, "packages/ltx-trainer/scripts/av_eval.py")]
    .map((path) => ({ path: repoPath(path), commands: discoverCli(path) }));
  const exportSources = [
    { language: "typescript" as const, path: resolve(appRoot, "shared/pipelines.ts"), symbols: discoverTypeScriptExports(resolve(appRoot, "shared/pipelines.ts")) },
    { language: "typescript" as const, path: resolve(appRoot, "shared/releaseSurface.ts"), symbols: discoverTypeScriptExports(resolve(appRoot, "shared/releaseSurface.ts")) },
    { language: "python" as const, path: resolve(repositoryRoot, "packages/ltx-pipelines/src/ltx_pipelines/__init__.py"), symbols: discoverPythonExports(resolve(repositoryRoot, "packages/ltx-pipelines/src/ltx_pipelines/__init__.py")) },
  ];
  const inventorySourcePaths = sortedUnique([
    ...sharedSources,
    ...serverSources,
    ...testSources,
    surfacePath,
    ...cliPrograms.map(({ path }) => resolve(repositoryRoot, path)),
    ...exportSources.map(({ path }) => path),
  ]);
  const contracts: M0ContractInventory["contracts"] = [
    { id: "capability-release-surface", sources: ["apps/ltx-studio/shared/pipelines.ts", "apps/ltx-studio/shared/releaseSurface.ts", "apps/ltx-studio/release/candidate-release-surface.v1.json"], tests: ["apps/ltx-studio/tests/pipelines.test.ts", "apps/ltx-studio/tests/release-surface.test.ts"] },
    { id: "http-api-routes", sources: ["apps/ltx-studio/server/index.ts"], tests: ["apps/ltx-studio/tests/projects.test.ts", "apps/ltx-studio/tests/jobs.test.ts", "apps/ltx-studio/tests/outputs.test.ts", "apps/ltx-studio/tests/uploads.test.ts"] },
    { id: "request-sidecar-schema", sources: ["apps/ltx-studio/shared/pipelines.ts", "apps/ltx-studio/shared/outputs.ts", "apps/ltx-studio/shared/provenance.ts"], tests: ["apps/ltx-studio/tests/pipelines.test.ts", "apps/ltx-studio/tests/output-state.test.ts", "apps/ltx-studio/tests/run-provenance.test.ts"] },
    { id: "scheduler-admission", sources: ["apps/ltx-studio/server/admission.ts", "apps/ltx-studio/server/orchestrator.ts", "apps/ltx-studio/server/jobs.ts"], tests: ["apps/ltx-studio/tests/admission.test.ts", "apps/ltx-studio/tests/orchestrator.test.ts", "apps/ltx-studio/tests/segment-boundary-scheduler.test.ts"] },
    { id: "release-provenance", sources: ["apps/ltx-studio/server/releaseIdentity.ts", "apps/ltx-studio/server/runProvenance.ts", "apps/ltx-studio/shared/provenance.ts"], tests: ["apps/ltx-studio/tests/release-identity.test.ts", "apps/ltx-studio/tests/run-provenance.test.ts"] },
    { id: "release-audit-rights", sources: ["apps/ltx-studio/shared/releaseAudit.ts", "apps/ltx-studio/shared/rightsEvidence.ts", "apps/ltx-studio/release/rights-evidence.v1.json"], tests: ["apps/ltx-studio/tests/release-audit.test.ts", "apps/ltx-studio/tests/rights-evidence.test.ts"] },
    { id: "evaluator-bindings", sources: ["apps/ltx-studio/server/evaluatorBindings.ts", "apps/ltx-studio/server/evaluatorManifest.ts", "apps/ltx-studio/shared/objectiveQuality.ts"], tests: ["apps/ltx-studio/tests/evaluator-bindings.test.ts", "apps/ltx-studio/tests/objective-quality.test.ts", "apps/ltx-studio/tests/objective-analysis-integration.test.ts"] },
    { id: "project-history", sources: ["apps/ltx-studio/server/projectStore.ts", "apps/ltx-studio/shared/projects.ts"], tests: ["apps/ltx-studio/tests/projects.test.ts"] },
    { id: "av-evaluator-cli", sources: ["packages/ltx-trainer/scripts/av_eval.py", "packages/ltx-trainer/src/ltx_trainer/av_eval"], tests: ["packages/ltx-trainer/tests/av_eval"] },
    { id: "pipeline-exports", sources: ["apps/ltx-studio/shared/pipelines.ts", "packages/ltx-pipelines/src/ltx_pipelines/__init__.py"], tests: ["apps/ltx-studio/tests/pipelines.test.ts", "packages/ltx-pipelines/tests"] },
  ];
  const inventory = m0ContractInventorySchema.parse({
    schemaVersion: "ltx-studio-m0-contract-inventory.v1",
    generatedAt: verification.capturedAt,
    reviewedPlan: { role: "reviewed_plan_source_commit", commit: reviewedPlan, tree: git("rev-parse", `${reviewedPlan}^{tree}`) },
    sourceFiles: inventorySourcePaths.map(fileDigest).sort((left, right) => left.path.localeCompare(right.path)),
    capabilitySurface: {
      path: repoPath(surfacePath),
      sha256: sha256Bytes(readFileSync(surfacePath)),
      entries: surface.entries.length,
      candidate: surface.entries.filter(({ targetStatus }) => targetStatus === "candidate").length,
      blocked: surface.entries.filter(({ targetStatus }) => targetStatus === "blocked").length,
      claimIds: sortedUnique(surface.entries.map(({ claimId }) => claimId)),
      modes: sortedUnique(surface.entries.map(({ request }) => request.mode)),
    },
    httpRoutes: discoverRoutes(routeSource),
    schemas: discoverSchemas([...sharedSources, ...serverSources]),
    cliPrograms,
    exports: exportSources.map(({ language, path, symbols }) => ({ language, path: repoPath(path), symbols })),
    contracts,
  });

  writeCanonical(resolve(repositoryRoot, argument("--baseline-output")), baseline);
  writeCanonical(resolve(repositoryRoot, argument("--contract-output")), inventory);
}

main();
