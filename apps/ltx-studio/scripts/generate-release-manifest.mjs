import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  DIGEST_NAME,
  MANIFEST_NAME,
  releaseArtifacts,
  sha256Bytes,
  sha256File,
  uniqueComponents,
} from "./release-manifest-lib.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const releaseRoot = resolve(appRoot, "build", "release-root");
const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");
const releasePython = join(releaseAppRoot, "runtime", ".venv", "bin", "python");

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
  }).trim();
}

const dirty = command("git", ["status", "--porcelain=v1", "--untracked-files=no"]);
if (dirty) throw new Error("A release manifest requires a clean tracked source tree");

const pythonInventoryCode = [
  "import importlib.metadata as m,json,sys",
  "items=sorted(({'name':(d.metadata.get('Name') or '').lower().replace('_','-'),'version':d.version} for d in m.distributions()),key=lambda x:(x['name'],x['version']))",
  "print(json.dumps({'python':sys.version.split()[0],'components':items},sort_keys=True,separators=(',',':')))",
].join(";");
const pythonInventory = JSON.parse(command(releasePython, ["-I", "-c", pythonInventoryCode], { cwd: releaseRoot }));

const npmTree = JSON.parse(command("npm", ["ls", "--omit=dev", "--all", "--json"], { cwd: releaseAppRoot }));
const nodeComponents = [];
function visitNodeDependencies(dependencies = {}) {
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (dependency && typeof dependency === "object" && typeof dependency.version === "string") {
      nodeComponents.push({ name, version: dependency.version });
      visitNodeDependencies(dependency.dependencies);
    }
  }
}
visitNodeDependencies(npmTree.dependencies);

const modelsModule = await import(pathToFileURL(join(releaseAppRoot, "shared", "models.js")));
const models = modelsModule.recommendedModelAssets.map((asset) => ({
  id: asset.id,
  repository: asset.repoId,
  access: asset.access,
  mountPath: asset.localPath,
  ...(asset.expectedContents
    ? { files: asset.expectedContents.map((file) => ({
        path: file.relativePath,
        sizeBytes: file.expectedSizeBytes,
        sha256: file.expectedSha256,
      })) }
    : { files: [{ path: asset.filename, sizeBytes: asset.expectedSizeBytes, sha256: asset.expectedSha256 }] }),
}));

const longcatRoot = process.env.LTX_STUDIO_LONGCAT_ROOT ?? "/home/moddy/projects/longcat-video-avatar-dgx";
let longcat;
try {
  longcat = {
    repository: "meituan-longcat/LongCat-Video",
    commit: command("git", ["rev-parse", "HEAD"], { cwd: longcatRoot }),
    clean: command("git", ["status", "--porcelain=v1", "--untracked-files=no"], { cwd: longcatRoot }) === "",
    licenseSha256: sha256File(join(longcatRoot, "vendor", "LongCat-Video", "LICENSE")),
  };
} catch (error) {
  longcat = { repository: "meituan-longcat/LongCat-Video", error: error instanceof Error ? error.message : String(error) };
}

const sourceDateEpoch = Number(command("git", ["show", "-s", "--format=%ct", "HEAD"]));
const surfacePath = join(releaseAppRoot, "release", "candidate-release-surface.v1.json");
const artifacts = releaseArtifacts(releaseRoot);
const manifest = {
  schemaVersion: "ltx-studio-release-manifest.v1",
  source: {
    gitCommit: command("git", ["rev-parse", "HEAD"]),
    gitTree: command("git", ["rev-parse", "HEAD^{tree}"]),
    clean: true,
    sourceDateEpoch,
  },
  tools: {
    node: process.version,
    npm: command("npm", ["--version"]),
    uv: command("uv", ["--version"]),
    python: pythonInventory.python,
  },
  surface: {
    path: "apps/ltx-studio/release/candidate-release-surface.v1.json",
    sha256: sha256File(surfacePath),
  },
  locks: {
    node: sha256File(join(releaseAppRoot, "package-lock.json")),
    python: sha256File(join(releaseAppRoot, "runtime", "uv.lock")),
  },
  runtimes: {
    renderer: {
      interpreter: "apps/ltx-studio/runtime/.venv/bin/python",
      isolated: true,
      packages: uniqueComponents(pythonInventory.components),
    },
    server: {
      entrypoint: "apps/ltx-studio/server/index.js",
      sourceTypeScriptAllowed: false,
      packages: uniqueComponents(nodeComponents),
    },
    longcat,
  },
  models,
  rights: {
    policyVersion: "ltx-studio-release-rights.v1",
    ltx2CommunityLicenseSha256: sha256File(join(releaseRoot, "LICENSE")),
    status: "requires-current-signed-rights-attest",
  },
  sbom: {
    schemaVersion: "ltx-studio-static-sbom.v1",
    nodeComponents: uniqueComponents(nodeComponents),
    pythonComponents: uniqueComponents(pythonInventory.components),
    modelComponents: models.map(({ id, repository, access, files }) => ({ id, repository, access, files })),
  },
  artifacts,
  qualification: {
    releaseDecision: "hold",
    blockers: [
      "current-signed-rights-attest-missing",
      ...(longcat.clean === false ? ["longcat-runtime-worktree-dirty"] : []),
      "digest-bound-cold-canary-missing",
      "quality-and-holdout-evidence-missing",
    ],
  },
};

const manifestBytes = Buffer.from(canonicalJson(manifest));
const digest = sha256Bytes(manifestBytes);
writeFileSync(join(releaseRoot, MANIFEST_NAME), manifestBytes, { mode: 0o644 });
writeFileSync(join(releaseRoot, DIGEST_NAME), `${digest}  ${MANIFEST_NAME}\n`, { mode: 0o644 });
process.stdout.write(`${JSON.stringify({ releaseDigest: digest, artifacts: artifacts.length, blockers: manifest.qualification.blockers })}\n`);
