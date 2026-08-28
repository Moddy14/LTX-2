import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  canonicalJson,
  canonicalDigestFile,
  DIGEST_NAME,
  MANIFEST_NAME,
  productionTcbLicenses,
  releaseArtifacts,
  sha256Bytes,
  sha256File,
  uniqueComponents,
} from "./release-manifest-lib.mjs";
import {
  createRuntimeInstallSeal,
  expectedRuntimeInstallInventory,
  runtimeInstallIntegrityPolicy,
  verifyRuntimeInstallSeal,
} from "./runtime-install-seal-lib.mjs";
import { captureHostTcbContract } from "./host-tcb-lib.mjs";
import {
  BUILD_TCB_POLICY_PATH,
  BUILD_TCB_SCHEMA,
  buildTcbSha256,
  readExternalBuildTcbPolicy,
  verifyBuildTcbPolicy,
} from "./build-tcb-lib.mjs";

const appRoot = resolve(import.meta.dirname, "..");
const repoRoot = resolve(appRoot, "../..");
const releaseRoot = resolve(appRoot, "build", "release-root");
const releaseAppRoot = join(releaseRoot, "apps", "ltx-studio");
const releasePython = join(releaseAppRoot, "runtime", ".venv", "bin", "python");
const releaseUv = join(releaseAppRoot, "runtime", "toolchain", "uv");

function command(executable, args, options = {}) {
  return execFileSync(executable, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: options.env ?? releaseCommandEnvironment,
  }).trim();
}

function requiredArgument(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? null : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} is required`);
  return value;
}

const expectedBuildTcbPolicySha256 = requiredArgument("--expected-build-tcb-policy-sha256");
if (!/^[0-9a-f]{64}$/.test(expectedBuildTcbPolicySha256)) {
  throw new Error("Separate Build-TCB policy pin must be an exact SHA-256 value");
}
const buildTcbPath = join(releaseAppRoot, "release", "build-tcb.v1.json");
const buildTcbText = readFileSync(buildTcbPath, "utf8");
const buildTcb = JSON.parse(buildTcbText);
if (buildTcb.schemaVersion !== BUILD_TCB_SCHEMA || canonicalJson(buildTcb) !== buildTcbText) {
  throw new Error("Generated Build-TCB record is absent, stale, or non-canonical");
}
const buildTcbPolicyPathIndex = process.argv.indexOf("--build-tcb-policy");
const buildTcbPolicyPath = buildTcbPolicyPathIndex < 0
  ? BUILD_TCB_POLICY_PATH
  : process.argv[buildTcbPolicyPathIndex + 1];
if (!buildTcbPolicyPath || buildTcbPolicyPath.startsWith("--")) {
  throw new Error("--build-tcb-policy requires an exact path");
}
const externalBuildTcbPolicy = readExternalBuildTcbPolicy(buildTcbPolicyPath, {
  expectedPath: buildTcbPolicyPath,
});
verifyBuildTcbPolicy(externalBuildTcbPolicy.policy, buildTcb, expectedBuildTcbPolicySha256);
const releaseCommandEnvironment = {
  PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
  LC_ALL: "C",
  LANG: "C",
  TZ: "UTC",
  HF_HUB_OFFLINE: "1",
  PYTHONNOUSERSITE: "1",
  PYTHONDONTWRITEBYTECODE: "1",
  TRANSFORMERS_OFFLINE: "1",
};

const pythonInventoryCode = [
  "import hashlib,importlib.metadata as m,json,pathlib,sys,tomllib",
  "items=sorted(({'name':(d.metadata.get('Name') or '').lower().replace('_','-'),'version':d.version} for d in m.distributions()),key=lambda x:(x['name'],x['version']))",
  "installed={(item['name'],item['version']) for item in items}",
  "lock=tomllib.loads(pathlib.Path('apps/ltx-studio/runtime/uv.lock').read_text())",
  "local=[]",
  "runtime_root=pathlib.Path('apps/ltx-studio/runtime').resolve()",
  "release_root=pathlib.Path.cwd().resolve()",
  "norm=lambda value:value.lower().replace('_','-')",
  "cuda=lambda name:name.startswith('nvidia-') or name.startswith('cuda-') or name=='triton'",
  "source_digest=lambda name,version,source:hashlib.sha256(json.dumps({'name':name,'version':version,'source':source},sort_keys=True,separators=(',',':')).encode()).hexdigest()",
  "wheel_digest=lambda package:(package.get('wheels',[{}])[0].get('hash','').removeprefix('sha256:') if len(package.get('wheels',[]))==1 else None)",
  "exec(\"for package in lock.get('package',[]):\\n name=norm(package.get('name',''))\\n version=str(package.get('version',''))\\n source=package.get('source',{})\\n if (name,version) not in installed: continue\\n kind='local-path' if ('editable' in source or 'virtual' in source) else ('cuda-runtime' if cuda(name) else ('direct-wheel' if 'url' in source else None))\\n if kind is None: continue\\n local_source=source.get('editable',source.get('virtual'))\\n locator=(runtime_root/pathlib.Path(local_source)).resolve().relative_to(release_root).as_posix() if kind=='local-path' else package.get('wheels',[{}])[0].get('url')\\n digest=source_digest(name,version,source) if kind=='local-path' else wheel_digest(package)\\n if not isinstance(locator,str) or digest is None or len(digest)!=64: raise RuntimeError('component has no unique locked SHA-256 wheel or source: '+name)\\n local.append({'name':name,'version':version,'source':{'kind':kind,'locator':locator,'sha256':digest}})\")",
  "local=sorted({(item['name'],item['version']):item for item in local}.values(),key=lambda x:(x['name'],x['version']))",
  "print(json.dumps({'python':sys.version.split()[0],'components':items,'localComponents':local},sort_keys=True,separators=(',',':')))",
].join(";");
const pythonInventory = JSON.parse(command(releasePython, ["-I", "-c", pythonInventoryCode], { cwd: releaseRoot }));

const nodeComponents = [];
function visitInstalledNodeModules(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const path = join(directory, entry.name);
    if (entry.name.startsWith("@")) {
      visitInstalledNodeModules(path);
      continue;
    }
    const packageJsonPath = join(path, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (typeof packageJson.name !== "string" || typeof packageJson.version !== "string") {
      throw new Error(`Installed Node package has no exact identity: ${path}`);
    }
    nodeComponents.push({ name: packageJson.name, version: packageJson.version });
    const nested = join(path, "node_modules");
    try {
      if (lstatSync(nested).isDirectory()) visitInstalledNodeModules(nested);
    } catch {
      // A package without a private dependency tree is complete at this level.
    }
  }
}
visitInstalledNodeModules(join(releaseAppRoot, "node_modules"));

const modelsModule = await import(pathToFileURL(join(releaseAppRoot, "shared", "models.js")));
const ltx25CatalogModule = await import(
  pathToFileURL(join(releaseAppRoot, "shared", "ltx25Catalog.js"))
);
const releaseSurfaceModule = await import(pathToFileURL(join(releaseAppRoot, "shared", "releaseSurface.js")));
const rightsEvidenceModule = await import(pathToFileURL(join(releaseAppRoot, "shared", "rightsEvidence.js")));
const models = modelsModule.recommendedModelAssets.map((asset) => ({
  id: asset.id,
  repository: asset.repoId,
  ...(asset.revision ? { revision: asset.revision } : {}),
  access: asset.access,
  mountPath: asset.localPath,
  ...(asset.expectedContents
    ? { files: asset.expectedContents.map((file) => ({
        path: file.relativePath,
        sizeBytes: file.expectedSizeBytes,
        sha256: file.expectedSha256,
      })) }
    : { files: [{
        path: asset.sourcePath ?? asset.filename,
        sizeBytes: asset.expectedSizeBytes,
        sha256: asset.expectedSha256,
      }] }),
}));
const workflows = {
  repository: ltx25CatalogModule.LTX25_WORKFLOW_REPOSITORY,
  revision: ltx25CatalogModule.LTX25_WORKFLOW_COMMIT,
  readme: {
    path: `${ltx25CatalogModule.LTX25_WORKFLOW_ROOT}/README.md`,
    sha256: ltx25CatalogModule.LTX25_WORKFLOW_README_SHA256,
  },
  files: ltx25CatalogModule.LTX25_WORKFLOW_CATALOG.map((workflow) => ({
    id: workflow.id,
    nativeStatus: workflow.nativeStatus,
    path: `${ltx25CatalogModule.LTX25_WORKFLOW_ROOT}/${workflow.filename}`,
    sha256: workflow.sha256,
  })),
};

const longcatRoot = externalBuildTcbPolicy.policy.releaseInputs.longcatRoot;
let longcat;
try {
  const sourceStatus = command(buildTcb.git.path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ".",
    ":(exclude)artifacts/**",
  ], { cwd: longcatRoot });
  const operationalArtifactStatus = command(buildTcb.git.path, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
    "--",
    "artifacts",
  ], { cwd: longcatRoot });
  longcat = {
    repository: "meituan-longcat/LongCat-Video",
    commit: command(buildTcb.git.path, ["rev-parse", "HEAD"], { cwd: longcatRoot }),
    tree: command(buildTcb.git.path, ["rev-parse", "HEAD^{tree}"], { cwd: longcatRoot }),
    clean: sourceStatus === "",
    sourceStatusExcludes: ["artifacts/**"],
    operationalArtifactsDirty: operationalArtifactStatus !== "",
    licenseSha256: sha256File(join(longcatRoot, "vendor", "LongCat-Video", "LICENSE")),
  };
} catch (error) {
  longcat = { repository: "meituan-longcat/LongCat-Video", error: error instanceof Error ? error.message : String(error) };
}

const sourceDateEpoch = Number(buildTcb.environment.sourceDateEpoch);
const surfacePath = join(releaseAppRoot, "release", "candidate-release-surface.v1.json");
const rightsEvidencePath = join(releaseAppRoot, "release", "rights-evidence.v1.json");
const surface = releaseSurfaceModule.candidateReleaseSurfaceSchema.parse(
  JSON.parse(readFileSync(surfacePath, "utf8")),
);
const rightsEvidence = rightsEvidenceModule.rightsEvidenceCatalogSchema.parse(
  JSON.parse(readFileSync(rightsEvidencePath, "utf8")),
);
const knownEvidenceIds = new Set(rightsEvidence.evidence.map(({ evidenceId }) => evidenceId));
for (const entry of surface.entries) {
  for (const evidenceId of entry.rights.evidenceIds) {
    if (!knownEvidenceIds.has(evidenceId)) {
      throw new Error(`Release surface ${entry.id} references unknown rights evidence ${evidenceId}`);
    }
  }
}
const artifacts = releaseArtifacts(releaseRoot);
const localComponents = pythonInventory.localComponents.map((component) => {
  if (component.source.kind !== "local-path") return component;
  const prefix = `${component.source.locator}/`;
  const sourceArtifacts = artifacts.filter(
    ({ path }) => path === component.source.locator || path.startsWith(prefix),
  );
  if (sourceArtifacts.length === 0) {
    throw new Error(
      `Local runtime component has no release artifacts: ${component.name}`,
    );
  }
  return {
    ...component,
    source: {
      ...component.source,
      sha256: sha256Bytes(Buffer.from(canonicalJson(sourceArtifacts))),
    },
  };
});
const hostTcb = captureHostTcbContract(releaseRoot, {
  nodeVersion: buildTcb.versions.node,
  uvVersion: command(releaseUv, ["--version"]),
  dockerImages: {
    latentsync: externalBuildTcbPolicy.policy.releaseInputs.dockerImages.latentsync,
    lipforcing: externalBuildTcbPolicy.policy.releaseInputs.dockerImages.lipforcing,
    musetalk: externalBuildTcbPolicy.policy.releaseInputs.dockerImages.musetalk,
  },
});
const manifest = {
  schemaVersion: "ltx-studio-release-manifest.v4",
  source: {
    gitCommit: buildTcb.source.gitCommit,
    gitTree: buildTcb.source.gitTree,
    clean: true,
    sourceDateEpoch,
  },
  tools: {
    node: {
      version: buildTcb.versions.node,
      sha256: buildTcb.node.sha256,
      runtimePath: "apps/ltx-studio/runtime/.venv/bin/node",
      licensePath: "apps/ltx-studio/runtime/NODE-LICENSE",
      licenseSha256: sha256File(join(releaseAppRoot, "runtime", "NODE-LICENSE")),
    },
    npm: buildTcb.versions.npm,
    uv: {
      version: command(releaseUv, ["--version"]),
      sha256: sha256File(releaseUv),
      runtimePath: "apps/ltx-studio/runtime/toolchain/uv",
      licensePath: "apps/ltx-studio/runtime/UV-LICENSE",
      licenseSha256: sha256File(join(releaseAppRoot, "runtime", "UV-LICENSE")),
    },
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
      interpreter: "apps/ltx-studio/runtime/.venv/bin/node",
      interpreterSha256: buildTcb.node.sha256,
      sourceTypeScriptAllowed: false,
      packages: uniqueComponents(nodeComponents),
    },
    longcat,
  },
  runtimeInstallIntegrity: runtimeInstallIntegrityPolicy(),
  runtimeInstallInventory: expectedRuntimeInstallInventory(
    join(releaseAppRoot, "runtime", ".venv"),
  ),
  hostTcb,
  buildTcb: {
    path: "apps/ltx-studio/release/build-tcb.v1.json",
    sha256: buildTcbSha256(buildTcb),
    externalPolicySha256: externalBuildTcbPolicy.sha256,
  },
  models,
  workflows,
  rights: {
    policyVersion: "ltx-studio-release-rights.v1",
    ltx2CommunityLicenseSha256: sha256File(join(releaseRoot, "LICENSE")),
    evidenceCatalog: {
      path: "apps/ltx-studio/release/rights-evidence.v1.json",
      sha256: sha256File(rightsEvidencePath),
    },
    productionTcbLicenses: productionTcbLicenses(hostTcb),
    status: "requires-current-signed-rights-attest",
  },
  sbom: {
    schemaVersion: "ltx-studio-static-sbom.v3",
    nodeComponents: uniqueComponents(nodeComponents),
    pythonComponents: uniqueComponents(pythonInventory.components),
    localComponents,
    runtimeTcbComponents: hostTcb.runtimeComponents,
    hostTcbTools: hostTcb.tools,
    hostTcbDockerImages: hostTcb.dockerImages,
    modelComponents: models.map(({ id, repository, revision, access, files }) => ({
      id,
      repository,
      ...(revision ? { revision } : {}),
      access,
      files,
    })),
    workflowComponents: workflows.files.map((workflow) => ({
      ...workflow,
      repository: workflows.repository,
      revision: workflows.revision,
    })),
    buildTcbComponents: buildTcb.nodeModules.packageTreeComponents,
    hostRuntimeComponents: [
      ...hostTcb.tools,
      ...hostTcb.runtimeComponents,
      hostTcb.controlPlane,
    ],
    containerRuntimeComponents: hostTcb.dockerImages,
  },
  artifacts,
  qualification: {
    releaseDecision: "hold",
    blockers: [
      "current-signed-rights-attest-missing",
      "signed-build-host-container-scan-reports-missing",
      "root-owned-post-install-host-attestation-missing",
      ...buildTcb.qualification.blockers,
      "privileged-sudo-docker-control-plane-broker-missing",
      ...(longcat.clean === false ? ["longcat-runtime-worktree-dirty"] : []),
      "digest-bound-cold-canary-missing",
      "quality-and-holdout-evidence-missing",
    ],
  },
};

const manifestBytes = Buffer.from(canonicalJson(manifest));
const digest = sha256Bytes(manifestBytes);
writeFileSync(join(releaseRoot, MANIFEST_NAME), manifestBytes, { mode: 0o644 });
writeFileSync(join(releaseRoot, DIGEST_NAME), canonicalDigestFile(digest), { mode: 0o644 });
function makeRuntimeReadOnly(path) {
  const details = lstatSync(path);
  if (details.isSymbolicLink()) return;
  if (details.isDirectory()) {
    for (const name of readdirSync(path)) makeRuntimeReadOnly(join(path, name));
    chmodSync(path, 0o555);
  } else if (details.isFile()) {
    chmodSync(path, (details.mode & 0o111) !== 0 ? 0o555 : 0o444);
  } else {
    throw new Error(`Unsupported runtime inventory node: ${path}`);
  }
}
makeRuntimeReadOnly(join(releaseAppRoot, "runtime", ".venv"));
const runtimeSeal = createRuntimeInstallSeal(releaseRoot, manifest, digest);
verifyRuntimeInstallSeal(releaseRoot, manifest, digest);
process.stdout.write(`${JSON.stringify({
  releaseDigest: digest,
  artifacts: artifacts.length,
  runtimeInstallSealSha256: runtimeSeal.sealSha256,
  blockers: manifest.qualification.blockers,
})}\n`);
