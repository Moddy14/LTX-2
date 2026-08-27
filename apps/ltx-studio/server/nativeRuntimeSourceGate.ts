import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute, sep } from "node:path";

import type { GenerationRequest } from "../shared/pipelines.js";
import { experimentalLipForcingRawOutputProfile } from "../shared/pipelines.js";
import { canonicalJson } from "../shared/canonicalJson.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MAX_PROBE_OUTPUT_BYTES = 16 * 1024;
const MAX_MODULE_SOURCE_BYTES = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 15_000;

export type NativeRuntimeSourceContract = {
  id: "dfr" | "a2v";
  distribution: "ltx-pipelines";
  distributionVersion: "1.3.0";
  upstreamCommit: "598ab41247a77dbfe29b5186e915bcf4f9040ec7";
  moduleName: string;
  distributionRelativePath: string;
  modulePathSuffix: string;
  upstreamSourceSha256: string;
  runtimeSourceSha256: string;
  sources: readonly NativeRuntimeSourceEntry[];
  patchBinding: {
    patchId: string;
    bindingSha256: string;
  };
};

export type NativeRuntimeSourceEntry = {
  moduleName: string;
  distributionRelativePath: string;
  modulePathSuffix: string;
  upstreamSourceSha256: string;
  runtimeSourceSha256: string;
};

/**
 * The upstream hash is immutable historical provenance.  Runtime hashes bind
 * the exact locally reviewed source that importlib must actually execute.
 * `bindingSha256` is SHA-256 over canonical JSON containing the patch ID, the
 * reviewed upstream commit and every source entry sorted by distribution path.
 * The entry-module aliases remain solely for log/backward API compatibility;
 * verification and patch binding are authoritative over the complete `sources`
 * collection.
 */
export const NATIVE_RUNTIME_SOURCE_CONTRACTS: Readonly<Record<"dfr" | "a2v", NativeRuntimeSourceContract>> = {
  dfr: {
    id: "dfr",
    distribution: "ltx-pipelines",
    distributionVersion: "1.3.0",
    upstreamCommit: "598ab41247a77dbfe29b5186e915bcf4f9040ec7",
    moduleName: "ltx_pipelines.dfr_pipeline",
    distributionRelativePath: "ltx_pipelines/dfr_pipeline.py",
    modulePathSuffix: `${sep}ltx_pipelines${sep}dfr_pipeline.py`,
    upstreamSourceSha256: "227df4b2d0463bc543be87e8b7973ff76b0e2a423b2dd770ddd051f66e995e63",
    runtimeSourceSha256: "68f529e5386da30e6938fd5a0f26991f9db8798c9a652b6f8441425298e77d03",
    sources: [
      {
        moduleName: "ltx_pipelines.dfr_pipeline",
        distributionRelativePath: "ltx_pipelines/dfr_pipeline.py",
        modulePathSuffix: `${sep}ltx_pipelines${sep}dfr_pipeline.py`,
        upstreamSourceSha256: "227df4b2d0463bc543be87e8b7973ff76b0e2a423b2dd770ddd051f66e995e63",
        runtimeSourceSha256: "68f529e5386da30e6938fd5a0f26991f9db8798c9a652b6f8441425298e77d03",
      },
      {
        moduleName: "ltx_pipelines.utils.blocks",
        distributionRelativePath: "ltx_pipelines/utils/blocks.py",
        modulePathSuffix: `${sep}ltx_pipelines${sep}utils${sep}blocks.py`,
        upstreamSourceSha256: "413890d0a21e6005646b40e493f6f91bc38a55f935809c625d6e2b04173fe625",
        runtimeSourceSha256: "fc4cb85f6ef9973b325f7b7498af63ad65b41a3a3a88b258078cbf58d8f3cc22",
      },
      {
        moduleName: "ltx_pipelines.utils.samplers",
        distributionRelativePath: "ltx_pipelines/utils/samplers.py",
        modulePathSuffix: `${sep}ltx_pipelines${sep}utils${sep}samplers.py`,
        upstreamSourceSha256: "8effaeec711c0eaf29c32d127567fd1459be6cebd2b3e22fed7b432bd234504c",
        runtimeSourceSha256: "50e15ed1589f2347b9d66924159c1b0bc53ae11dc9a93af8da5dce3e0bb87a60",
      },
    ],
    patchBinding: {
      patchId: "ltx-studio-dfr-fractional-playback-fps.v1",
      bindingSha256: "2d85d8710f5faa80619284b19f7a9c4e273c453e2337d6fc790944d43190ca6f",
    },
  },
  a2v: {
    id: "a2v",
    distribution: "ltx-pipelines",
    distributionVersion: "1.3.0",
    upstreamCommit: "598ab41247a77dbfe29b5186e915bcf4f9040ec7",
    moduleName: "ltx_pipelines.a2vid_two_stage",
    distributionRelativePath: "ltx_pipelines/a2vid_two_stage.py",
    modulePathSuffix: `${sep}ltx_pipelines${sep}a2vid_two_stage.py`,
    upstreamSourceSha256: "7ef463bba074ef18e963bb77f1deff8c985335de9594c1e2ed9882ad07332b54",
    runtimeSourceSha256: "8d8b5d72a2c6747aa8f5369de35e1cf49ea2d339c90bada9d0edfd030294d5f1",
    sources: [
      {
        moduleName: "ltx_pipelines.a2vid_two_stage",
        distributionRelativePath: "ltx_pipelines/a2vid_two_stage.py",
        modulePathSuffix: `${sep}ltx_pipelines${sep}a2vid_two_stage.py`,
        upstreamSourceSha256: "7ef463bba074ef18e963bb77f1deff8c985335de9594c1e2ed9882ad07332b54",
        runtimeSourceSha256: "8d8b5d72a2c6747aa8f5369de35e1cf49ea2d339c90bada9d0edfd030294d5f1",
      },
      {
        moduleName: "ltx_pipelines.utils.blocks",
        distributionRelativePath: "ltx_pipelines/utils/blocks.py",
        modulePathSuffix: `${sep}ltx_pipelines${sep}utils${sep}blocks.py`,
        upstreamSourceSha256: "413890d0a21e6005646b40e493f6f91bc38a55f935809c625d6e2b04173fe625",
        runtimeSourceSha256: "fc4cb85f6ef9973b325f7b7498af63ad65b41a3a3a88b258078cbf58d8f3cc22",
      },
      {
        moduleName: "ltx_pipelines.utils.samplers",
        distributionRelativePath: "ltx_pipelines/utils/samplers.py",
        modulePathSuffix: `${sep}ltx_pipelines${sep}utils${sep}samplers.py`,
        upstreamSourceSha256: "8effaeec711c0eaf29c32d127567fd1459be6cebd2b3e22fed7b432bd234504c",
        runtimeSourceSha256: "50e15ed1589f2347b9d66924159c1b0bc53ae11dc9a93af8da5dce3e0bb87a60",
      },
    ],
    patchBinding: {
      patchId: "ltx-studio-ltx-pipelines-v1.3-a2v-split-official-comfy-fp32-frozen-audio.v1",
      bindingSha256: "ce37b549c8b6643af68847a1d74e3a8df397a5021e3bbff8bf936e0581a4fdee",
    },
  },
};

export type NativeRuntimeSourceProbeOptions = {
  encoding: "utf8";
  timeout: number;
  maxBuffer: number;
  shell: false;
  windowsHide: true;
  killSignal: "SIGKILL";
  env: NodeJS.ProcessEnv;
};

export type NativeRuntimeSourceProbeResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type NativeRuntimeSourceProbeOperations = {
  run(
    executable: string,
    args: readonly string[],
    options: NativeRuntimeSourceProbeOptions,
  ): NativeRuntimeSourceProbeResult;
};

const PROBE_SCRIPT = [
  "import hashlib,importlib.machinery,importlib.metadata,json,os,pathlib,stat,sys",
  "distribution=importlib.metadata.distribution('ltx-pipelines')",
  "source_requests=json.loads(sys.argv[1])",
  "assert distribution.metadata.get('Name')=='ltx-pipelines'",
  "assert isinstance(source_requests,list) and len(source_requests)==3",
  "assert source_requests==sorted(source_requests,key=lambda item:item['distributionRelativePath'])",
  "package_spec=importlib.machinery.PathFinder.find_spec('ltx_pipelines',sys.path)",
  "assert package_spec is not None and isinstance(package_spec.origin,str)",
  "locations=list(package_spec.submodule_search_locations or ())",
  "assert len(locations)==1",
  "package_root_path=pathlib.Path(locations[0])",
  "package_origin_path=pathlib.Path(package_spec.origin)",
  "located_package_origin_path=pathlib.Path(distribution.locate_file('ltx_pipelines/__init__.py'))",
  "assert package_root_path.is_absolute() and package_origin_path.is_absolute() and located_package_origin_path.is_absolute()",
  "for candidate in (package_root_path,package_origin_path,located_package_origin_path):",
  " current=candidate",
  " while True:",
  "  assert not current.is_symlink()",
  "  if current.parent==current: break",
  "  current=current.parent",
  "package_root=package_root_path.resolve(strict=True)",
  "package_origin=package_origin_path.resolve(strict=True)",
  "located_package_origin=located_package_origin_path.resolve(strict=True)",
  "assert package_origin==located_package_origin and package_origin.parent==package_root",
  "revision=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_nlink,value.st_size,value.st_mtime_ns,value.st_ctime_ns)",
  "source_results=[]",
  "for requested in source_requests:",
  " assert isinstance(requested,dict) and set(requested)=={'distributionRelativePath','moduleName'}",
  " module_name=requested['moduleName'];relative_path=requested['distributionRelativePath']",
  " assert isinstance(module_name,str) and isinstance(relative_path,str)",
  " relative=pathlib.PurePosixPath(relative_path)",
  " assert relative.as_posix()==relative_path and not relative.is_absolute() and relative.suffix=='.py'",
  " assert len(relative.parts)>=2 and relative.parts[0]=='ltx_pipelines' and all(part not in ('','.','..') for part in relative.parts)",
  " assert module_name=='.'.join(relative.with_suffix('').parts)",
  " located_path=pathlib.Path(distribution.locate_file(relative_path))",
  " expected_path=package_root_path.joinpath(*relative.parts[1:])",
  " assert located_path.is_absolute() and expected_path.is_absolute()",
  " for candidate in (located_path,expected_path):",
  "  current=candidate",
  "  while True:",
  "   assert not current.is_symlink()",
  "   if current.parent==current: break",
  "   current=current.parent",
  " source=located_path.resolve(strict=True);expected=expected_path.resolve(strict=True)",
  " assert source==expected and source.is_relative_to(package_root)",
  " descriptor=os.open(str(source),os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)",
  " before=os.fstat(descriptor)",
  " assert stat.S_ISREG(before.st_mode)",
  ` assert 0 < before.st_size <= ${MAX_MODULE_SOURCE_BYTES}`,
  " digest=hashlib.sha256()",
  " chunk=os.read(descriptor,1048576)",
  " while chunk:",
  "  digest.update(chunk);chunk=os.read(descriptor,1048576)",
  " after=os.fstat(descriptor);linked=os.lstat(str(source));os.close(descriptor)",
  " assert revision(before)==revision(after)==revision(linked)",
  " source_results.append({'distributionRelativePath':relative_path,'moduleName':module_name,'moduleFile':str(source),'moduleSizeBytes':before.st_size,'runtimeSourceSha256':digest.hexdigest()})",
  "payload={'schemaVersion':'ltx-studio-native-runtime-source-probe.v2','distribution':'ltx-pipelines','distributionVersion':distribution.version,'sources':source_results}",
  "sys.stdout.write(json.dumps(payload,sort_keys=True,separators=(',',':'),ensure_ascii=False))",
].join("\n");

const defaultProbeOperations: NativeRuntimeSourceProbeOperations = {
  run(executable, args, options) {
    const result = spawnSync(executable, [...args], options);
    return {
      status: result.status,
      signal: result.signal,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      ...(result.error ? { error: result.error } : {}),
    };
  },
};

export type VerifiedNativeRuntimeSource = {
  schemaVersion: "ltx-studio-native-runtime-source-gate.v2";
  contractId: "dfr" | "a2v";
  distribution: "ltx-pipelines";
  distributionVersion: "1.3.0";
  upstreamCommit: NativeRuntimeSourceContract["upstreamCommit"];
  moduleName: string;
  moduleFile: string;
  moduleSizeBytes: number;
  upstreamSourceSha256: string;
  runtimeSourceSha256: string;
  sources: readonly VerifiedNativeRuntimeSourceEntry[];
  patchBinding: NativeRuntimeSourceContract["patchBinding"];
};

export type VerifiedNativeRuntimeSourceEntry = {
  moduleName: string;
  distributionRelativePath: string;
  moduleFile: string;
  moduleSizeBytes: number;
  upstreamSourceSha256: string;
  runtimeSourceSha256: string;
};

type ProbePayload = {
  schemaVersion: "ltx-studio-native-runtime-source-probe.v2";
  distribution: string;
  distributionVersion: string;
  sources: ProbeSourcePayload[];
};

type ProbeSourcePayload = {
  moduleName: string;
  distributionRelativePath: string;
  moduleFile: string;
  moduleSizeBytes: number;
  runtimeSourceSha256: string;
};

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function parseProbePayload(stdout: string): ProbePayload {
  if (Buffer.byteLength(stdout, "utf8") === 0
    || Buffer.byteLength(stdout, "utf8") > MAX_PROBE_OUTPUT_BYTES
    || stdout !== stdout.trim()) {
    throw new Error("Native Runtime-Source-Probe lieferte keine einzelne begrenzte JSON-Antwort.");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Native Runtime-Source-Probe lieferte kein gültiges JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native Runtime-Source-Probe lieferte kein JSON-Objekt.");
  }
  const item = value as Record<string, unknown>;
  if (!exactKeys(item, [
    "schemaVersion",
    "distribution",
    "distributionVersion",
    "sources",
  ])
    || item.schemaVersion !== "ltx-studio-native-runtime-source-probe.v2"
    || typeof item.distribution !== "string"
    || typeof item.distributionVersion !== "string"
    || !Array.isArray(item.sources)
    || item.sources.length !== 3) {
    throw new Error("Native Runtime-Source-Probe-Antwort ist strukturell ungültig.");
  }
  const sources: ProbeSourcePayload[] = [];
  for (const value of item.sources) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Native Runtime-Source-Probe-Antwort ist strukturell ungültig.");
    }
    const source = value as Record<string, unknown>;
    if (!exactKeys(source, [
      "distributionRelativePath",
      "moduleName",
      "moduleFile",
      "moduleSizeBytes",
      "runtimeSourceSha256",
    ])
      || typeof source.distributionRelativePath !== "string"
      || source.distributionRelativePath.length === 0
      || source.distributionRelativePath.length > 4096
      || source.distributionRelativePath.includes("\0")
      || typeof source.moduleName !== "string"
      || source.moduleName.length === 0
      || source.moduleName.length > 4096
      || source.moduleName.includes("\0")
      || typeof source.moduleFile !== "string"
      || !isAbsolute(source.moduleFile)
      || source.moduleFile.includes("\0")
      || source.moduleFile.length > 4096
      || typeof source.moduleSizeBytes !== "number"
      || !Number.isSafeInteger(source.moduleSizeBytes)
      || source.moduleSizeBytes <= 0
      || source.moduleSizeBytes > MAX_MODULE_SOURCE_BYTES
      || typeof source.runtimeSourceSha256 !== "string"
      || !SHA256_PATTERN.test(source.runtimeSourceSha256)) {
      throw new Error("Native Runtime-Source-Probe-Antwort ist strukturell ungültig.");
    }
    sources.push(source as ProbeSourcePayload);
  }
  return { ...item, sources } as ProbePayload;
}

function compareSourcePaths(left: NativeRuntimeSourceEntry, right: NativeRuntimeSourceEntry): number {
  return left.distributionRelativePath < right.distributionRelativePath
    ? -1
    : left.distributionRelativePath > right.distributionRelativePath ? 1 : 0;
}

function patchBindingSourceEntries(contract: NativeRuntimeSourceContract) {
  return [...contract.sources].sort(compareSourcePaths).map((source) => ({
    moduleName: source.moduleName,
    path: source.distributionRelativePath,
    runtimeSourceSha256: source.runtimeSourceSha256,
    upstreamSourceSha256: source.upstreamSourceSha256,
  }));
}

function expectedPatchBindingSha256(contract: NativeRuntimeSourceContract): string {
  return createHash("sha256").update(canonicalJson({
    patchId: contract.patchBinding.patchId,
    sources: patchBindingSourceEntries(contract),
    upstreamCommit: contract.upstreamCommit,
  })).digest("hex");
}

function contractIsStructurallyValid(contract: NativeRuntimeSourceContract): boolean {
  const sources = [...contract.sources];
  const sorted = [...sources].sort(compareSourcePaths);
  const primary = sources[0];
  return sources.length === 3
    && sources.every((source, index) => source === sorted[index])
    && new Set(sources.map((source) => source.distributionRelativePath)).size === sources.length
    && new Set(sources.map((source) => source.moduleName)).size === sources.length
    && sources.every((source) => {
      const pathParts = source.distributionRelativePath.split("/");
      return pathParts.length >= 2
        && pathParts[0] === "ltx_pipelines"
        && pathParts.every((part) => part.length > 0 && part !== "." && part !== "..")
        && source.distributionRelativePath.endsWith(".py")
        && !source.distributionRelativePath.includes("\\")
        && !source.distributionRelativePath.includes("\0")
        && source.moduleName === source.distributionRelativePath.slice(0, -3).replaceAll("/", ".")
        && source.modulePathSuffix === `${sep}${pathParts.join(sep)}`
        && SHA256_PATTERN.test(source.upstreamSourceSha256)
        && SHA256_PATTERN.test(source.runtimeSourceSha256);
    })
    && primary !== undefined
    && contract.moduleName === primary.moduleName
    && contract.distributionRelativePath === primary.distributionRelativePath
    && contract.modulePathSuffix === primary.modulePathSuffix
    && contract.upstreamSourceSha256 === primary.upstreamSourceSha256
    && contract.runtimeSourceSha256 === primary.runtimeSourceSha256
    && SHA256_PATTERN.test(contract.patchBinding.bindingSha256);
}

export function nativeRuntimeSourceContractForRequest(
  request: Pick<GenerationRequest, "mode" | "postprocess">,
): NativeRuntimeSourceContract | null {
  if (request.postprocess.lipForcing.rawOutputProfile === experimentalLipForcingRawOutputProfile) {
    return null;
  }
  if (request.mode === "dfr") return NATIVE_RUNTIME_SOURCE_CONTRACTS.dfr;
  if (request.mode === "image-audio-to-video" || request.mode === "audio-to-video") {
    return NATIVE_RUNTIME_SOURCE_CONTRACTS.a2v;
  }
  return null;
}

export class NativeRuntimeSourceGateError extends Error {
  readonly statusCode = 409;

  constructor(message: string) {
    super(message);
    this.name = "NativeRuntimeSourceGateError";
  }
}

export function verifyNativeRuntimeSource(
  request: Pick<GenerationRequest, "mode" | "postprocess">,
  pythonExecutable: string,
  operations: NativeRuntimeSourceProbeOperations = defaultProbeOperations,
): VerifiedNativeRuntimeSource | null {
  const contract = nativeRuntimeSourceContractForRequest(request);
  if (!contract) return null;
  if (!isAbsolute(pythonExecutable) || pythonExecutable.includes("\0")) {
    throw new NativeRuntimeSourceGateError("Native Runtime-Source-Gate benötigt einen absoluten Python-Pfad.");
  }
  if (!contractIsStructurallyValid(contract)
    || expectedPatchBindingSha256(contract) !== contract.patchBinding.bindingSha256) {
    throw new NativeRuntimeSourceGateError("Native Runtime-Patchbindung ist intern widersprüchlich.");
  }
  let result: NativeRuntimeSourceProbeResult;
  try {
    result = operations.run(
      pythonExecutable,
      ["-I", "-c", PROBE_SCRIPT, JSON.stringify(contract.sources.map((source) => ({
        distributionRelativePath: source.distributionRelativePath,
        moduleName: source.moduleName,
      })))],
      {
        encoding: "utf8",
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: MAX_PROBE_OUTPUT_BYTES,
        shell: false,
        windowsHide: true,
        killSignal: "SIGKILL",
        env: {
          PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
          LC_ALL: "C.UTF-8",
          LANG: "C.UTF-8",
          PYTHONNOUSERSITE: "1",
        },
      },
    );
  } catch (error) {
    throw new NativeRuntimeSourceGateError(
      `Native Runtime-Source-Probe konnte nicht gestartet werden: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (result.error || result.status !== 0 || result.signal !== null) {
    throw new NativeRuntimeSourceGateError(
      `Native Runtime-Source-Probe scheiterte fail-closed (${result.error?.message ?? `Exit ${String(result.status)}`}).`,
    );
  }
  if (Buffer.byteLength(result.stderr, "utf8") > MAX_PROBE_OUTPUT_BYTES || result.stderr.length > 0) {
    throw new NativeRuntimeSourceGateError("Native Runtime-Source-Probe schrieb unerwartete Diagnostik.");
  }
  let payload: ProbePayload;
  try {
    payload = parseProbePayload(result.stdout);
  } catch (error) {
    throw new NativeRuntimeSourceGateError(error instanceof Error ? error.message : String(error));
  }
  if (payload.distribution !== contract.distribution
    || payload.distributionVersion !== contract.distributionVersion
    || payload.sources.length !== contract.sources.length) {
    throw new NativeRuntimeSourceGateError(
      `Native Runtime-Source-Gate verweigert ${contract.id}: erwartet ltx-pipelines ${contract.distributionVersion} `
        + `mit ${contract.sources.length} gebundenen Quellen, geladen wurden ${payload.distributionVersion} `
        + `mit ${payload.sources.length} Quellen.`,
    );
  }
  const verifiedSources: VerifiedNativeRuntimeSourceEntry[] = [];
  for (const [index, expected] of contract.sources.entries()) {
    const actual = payload.sources[index];
    if (!actual
      || actual.distributionRelativePath !== expected.distributionRelativePath
      || actual.moduleName !== expected.moduleName
      || !actual.moduleFile.endsWith(expected.modulePathSuffix)
      || actual.runtimeSourceSha256 !== expected.runtimeSourceSha256) {
      throw new NativeRuntimeSourceGateError(
        `Native Runtime-Source-Gate verweigert ${contract.id}: Quelle ${expected.distributionRelativePath} `
          + `erwartet Runtime-SHA ${expected.runtimeSourceSha256}, geladen wurde `
          + `${actual?.runtimeSourceSha256 ?? "keine passende Quelle"}.`,
      );
    }
    verifiedSources.push({
      moduleName: actual.moduleName,
      distributionRelativePath: actual.distributionRelativePath,
      moduleFile: actual.moduleFile,
      moduleSizeBytes: actual.moduleSizeBytes,
      upstreamSourceSha256: expected.upstreamSourceSha256,
      runtimeSourceSha256: actual.runtimeSourceSha256,
    });
  }
  const primary = verifiedSources[0];
  if (!primary) {
    throw new NativeRuntimeSourceGateError("Native Runtime-Source-Gate fand keine primäre Laufzeitquelle.");
  }
  return {
    schemaVersion: "ltx-studio-native-runtime-source-gate.v2",
    contractId: contract.id,
    distribution: contract.distribution,
    distributionVersion: contract.distributionVersion,
    upstreamCommit: contract.upstreamCommit,
    moduleName: primary.moduleName,
    moduleFile: primary.moduleFile,
    moduleSizeBytes: primary.moduleSizeBytes,
    upstreamSourceSha256: primary.upstreamSourceSha256,
    runtimeSourceSha256: primary.runtimeSourceSha256,
    sources: verifiedSources,
    patchBinding: structuredClone(contract.patchBinding),
  };
}
