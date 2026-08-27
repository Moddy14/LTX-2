import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { JobManager } from "../server/jobs.js";
import {
  NATIVE_RUNTIME_SOURCE_CONTRACTS,
  NativeRuntimeSourceGateError,
  nativeRuntimeSourceContractForRequest,
  verifyNativeRuntimeSource,
  type NativeRuntimeSourceContract,
  type NativeRuntimeSourceProbeOperations,
  type NativeRuntimeSourceProbeOptions,
  type NativeRuntimeSourceProbeResult,
} from "../server/nativeRuntimeSourceGate.js";
import { bootstrapJobStartEnforcer } from "../server/startEnforcer.js";
import { validRequest } from "./fixtures.js";

function successfulProbe(
  contract: NativeRuntimeSourceContract,
  overrides: {
    distributionVersion?: string;
    sourceIndex?: number;
    source?: Partial<Record<
      "distributionRelativePath" | "moduleName" | "moduleFile" | "runtimeSourceSha256",
      string
    >>;
  } = {},
): NativeRuntimeSourceProbeResult {
  const sources = contract.sources.map((source, index) => ({
    distributionRelativePath: source.distributionRelativePath,
    moduleName: source.moduleName,
    moduleFile: `/runtime/lib/python3.12/site-packages${source.modulePathSuffix}`,
    moduleSizeBytes: 42_000,
    runtimeSourceSha256: source.runtimeSourceSha256,
    ...(index === (overrides.sourceIndex ?? 0) ? overrides.source : {}),
  }));
  return {
    status: 0,
    signal: null,
    stdout: JSON.stringify({
      schemaVersion: "ltx-studio-native-runtime-source-probe.v2",
      distribution: "ltx-pipelines",
      distributionVersion: overrides.distributionVersion ?? contract.distributionVersion,
      sources,
    }),
    stderr: "",
  };
}

function operations(result: NativeRuntimeSourceProbeResult) {
  return {
    run: vi.fn((
      _executable: string,
      _args: readonly string[],
      _options: NativeRuntimeSourceProbeOptions,
    ) => {
      void _executable;
      void _args;
      void _options;
      return result;
    }),
  } satisfies NativeRuntimeSourceProbeOperations;
}

describe("native runtime source gate", () => {
  it("binds the reviewed v1.3 entry modules and both shared sampler helpers", () => {
    expect(NATIVE_RUNTIME_SOURCE_CONTRACTS.dfr).toMatchObject({
      distributionVersion: "1.3.0",
      upstreamCommit: "598ab41247a77dbfe29b5186e915bcf4f9040ec7",
      upstreamSourceSha256: "227df4b2d0463bc543be87e8b7973ff76b0e2a423b2dd770ddd051f66e995e63",
      runtimeSourceSha256: "68f529e5386da30e6938fd5a0f26991f9db8798c9a652b6f8441425298e77d03",
      patchBinding: {
        patchId: "ltx-studio-dfr-fractional-playback-fps.v1",
        bindingSha256: "2d85d8710f5faa80619284b19f7a9c4e273c453e2337d6fc790944d43190ca6f",
      },
    });
    expect(NATIVE_RUNTIME_SOURCE_CONTRACTS.a2v).toMatchObject({
      distributionVersion: "1.3.0",
      upstreamCommit: "598ab41247a77dbfe29b5186e915bcf4f9040ec7",
      upstreamSourceSha256: "7ef463bba074ef18e963bb77f1deff8c985335de9594c1e2ed9882ad07332b54",
      runtimeSourceSha256: "8d8b5d72a2c6747aa8f5369de35e1cf49ea2d339c90bada9d0edfd030294d5f1",
      patchBinding: {
        patchId: "ltx-studio-ltx-pipelines-v1.3-a2v-split-official-comfy-fp32-frozen-audio.v1",
        bindingSha256: "ce37b549c8b6643af68847a1d74e3a8df397a5021e3bbff8bf936e0581a4fdee",
      },
    });
    for (const contract of Object.values(NATIVE_RUNTIME_SOURCE_CONTRACTS)) {
      expect(contract.sources.map((source) => source.distributionRelativePath)).toEqual([
        contract.distributionRelativePath,
        "ltx_pipelines/utils/blocks.py",
        "ltx_pipelines/utils/samplers.py",
      ]);
      expect(contract.sources.every((source) => (
        source.runtimeSourceSha256 !== source.upstreamSourceSha256
      ))).toBe(true);
    }
  });

  it.each([
    ["dfr", "dfr"],
    ["image-audio-to-video", "a2v"],
    ["audio-to-video", "a2v"],
  ] as const)("selects the %s native source contract", (mode, contractId) => {
    expect(nativeRuntimeSourceContractForRequest(validRequest(mode))?.id).toBe(contractId);
  });

  it("does not impose a native-render dependency on the CPU-only paired RawMux candidate", () => {
    const request = validRequest("image-audio-to-video");
    request.postprocess.lipForcing.enabled = true;
    request.postprocess.lipForcing.rawOutputProfile = "h264-crf13-mux-copy-v1";
    const probe = operations(successfulProbe(NATIVE_RUNTIME_SOURCE_CONTRACTS.a2v));

    expect(verifyNativeRuntimeSource(request, "/runtime/bin/python", probe)).toBeNull();
    expect(probe.run).not.toHaveBeenCalled();
  });

  it("discovers and hashes all three exact sources without importing or executing package code", () => {
    const contract = NATIVE_RUNTIME_SOURCE_CONTRACTS.dfr;
    const probe = operations(successfulProbe(contract));

    expect(verifyNativeRuntimeSource(validRequest("dfr"), "/runtime/bin/python", probe)).toMatchObject({
      schemaVersion: "ltx-studio-native-runtime-source-gate.v2",
      contractId: "dfr",
      distributionVersion: "1.3.0",
      upstreamCommit: contract.upstreamCommit,
      upstreamSourceSha256: contract.upstreamSourceSha256,
      runtimeSourceSha256: contract.runtimeSourceSha256,
      sources: contract.sources.map((source) => ({
        moduleName: source.moduleName,
        distributionRelativePath: source.distributionRelativePath,
        upstreamSourceSha256: source.upstreamSourceSha256,
        runtimeSourceSha256: source.runtimeSourceSha256,
      })),
      patchBinding: contract.patchBinding,
    });
    expect(probe.run).toHaveBeenCalledTimes(1);
    const [executable, args, options] = probe.run.mock.calls[0];
    expect(executable).toBe("/runtime/bin/python");
    expect(args.slice(0, 2)).toEqual(["-I", "-c"]);
    expect(JSON.parse(args.at(-1) ?? "null")).toEqual(contract.sources.map((source) => ({
      distributionRelativePath: source.distributionRelativePath,
      moduleName: source.moduleName,
    })));
    expect(args[2]).toContain("PathFinder.find_spec('ltx_pipelines',sys.path)");
    expect(args[2]).toContain("distribution.locate_file(relative_path)");
    expect(args[2]).toContain("os.open(str(source),os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)");
    expect(args[2]).not.toMatch(/import_module|exec_module|__import__|run_module|run_path/);
    expect(options).toMatchObject({
      shell: false,
      timeout: 15_000,
      maxBuffer: 16 * 1024,
      killSignal: "SIGKILL",
      encoding: "utf8",
    });
    expect(options.env).not.toHaveProperty("PYTHONPATH");
    expect(options.env.PYTHONNOUSERSITE).toBe("1");
  });

  it("does not execute a package or module while resolving its source", async () => {
    const contract = NATIVE_RUNTIME_SOURCE_CONTRACTS.dfr;
    const probe = operations(successfulProbe(contract));
    verifyNativeRuntimeSource(validRequest("dfr"), "/runtime/bin/python", probe);
    const script = probe.run.mock.calls[0][1][2];
    const root = await mkdtemp(join(tmpdir(), "ltx-native-source-discovery-"));
    const packageRoot = join(root, "ltx_pipelines");
    const utilsRoot = join(packageRoot, "utils");
    const metadataRoot = join(root, "ltx_pipelines-1.3.0.dist-info");
    const packageMarker = join(root, "package-executed");
    const sourceMarkers = contract.sources.map((_, index) => join(root, `source-${index}-executed`));
    try {
      await mkdir(utilsRoot, { recursive: true });
      await mkdir(metadataRoot);
      await writeFile(
        join(packageRoot, "__init__.py"),
        `from pathlib import Path\nPath(${JSON.stringify(packageMarker)}).write_text('executed')\n`,
      );
      await writeFile(join(utilsRoot, "__init__.py"), "# probe must not execute this package\n");
      for (const [index, source] of contract.sources.entries()) {
        await writeFile(
          join(root, source.distributionRelativePath),
          `from pathlib import Path\nPath(${JSON.stringify(sourceMarkers[index])}).write_text('executed')\n`,
        );
      }
      await writeFile(join(metadataRoot, "METADATA"), "Metadata-Version: 2.1\nName: ltx-pipelines\nVersion: 1.3.0\n");
      const bootstrap = `import sys;sys.path.insert(0,${JSON.stringify(root)});exec(compile(${JSON.stringify(script)},'<native-source-probe>','exec'))`;
      const sourceRequests = JSON.stringify(contract.sources.map((source) => ({
        distributionRelativePath: source.distributionRelativePath,
        moduleName: source.moduleName,
      })));
      const payload = JSON.parse(execFileSync(
        join(process.cwd(), "runtime", ".venv", "bin", "python"),
        ["-I", "-c", bootstrap, sourceRequests],
        { encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024 },
      ));

      expect(payload).toMatchObject({
        distributionVersion: "1.3.0",
        sources: contract.sources.map((source) => ({
          distributionRelativePath: source.distributionRelativePath,
          moduleName: source.moduleName,
          moduleFile: join(root, source.distributionRelativePath),
        })),
      });
      await expect(access(packageMarker)).rejects.toThrow();
      for (const marker of sourceMarkers) await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["ltx-pipelines 1.2", { distributionVersion: "1.2.0" }],
    ["wrong DFR source", { source: { runtimeSourceSha256: "0".repeat(64) } }],
    ["wrong imported module", { source: { moduleName: "ltx_pipelines.distilled" } }],
    ["wrong module path", { source: { moduleFile: "/tmp/dfr_pipeline.py" } }],
  ] as const)("fails closed for %s", (_label, overrides) => {
    const contract = NATIVE_RUNTIME_SOURCE_CONTRACTS.dfr;
    expect(() => verifyNativeRuntimeSource(
      validRequest("dfr"),
      "/runtime/bin/python",
      operations(successfulProbe(contract, overrides)),
    )).toThrow(NativeRuntimeSourceGateError);
  });

  it.each([
    ["dfr", 0, "ltx_pipelines/dfr_pipeline.py"],
    ["dfr", 1, "ltx_pipelines/utils/blocks.py"],
    ["dfr", 2, "ltx_pipelines/utils/samplers.py"],
    ["a2v", 0, "ltx_pipelines/a2vid_two_stage.py"],
    ["a2v", 1, "ltx_pipelines/utils/blocks.py"],
    ["a2v", 2, "ltx_pipelines/utils/samplers.py"],
  ] as const)("fails closed when %s source %s (%s) drifts", (contractId, sourceIndex, _path) => {
    void _path;
    const contract = NATIVE_RUNTIME_SOURCE_CONTRACTS[contractId];
    const mode = contractId === "dfr" ? "dfr" : "audio-to-video";
    expect(() => verifyNativeRuntimeSource(
      validRequest(mode),
      "/runtime/bin/python",
      operations(successfulProbe(contract, {
        sourceIndex,
        source: { runtimeSourceSha256: "f".repeat(64) },
      })),
    )).toThrow(NativeRuntimeSourceGateError);
  });

  it.each([
    ["spawn error", { status: null, signal: null, stdout: "", stderr: "", error: new Error("ENOENT") }],
    ["timeout signal", { status: null, signal: "SIGKILL", stdout: "", stderr: "" }],
    ["stderr", { status: 0, signal: null, stdout: "{}", stderr: "warning" }],
    ["malformed JSON", { status: 0, signal: null, stdout: "not-json", stderr: "" }],
    ["leading output", { status: 0, signal: null, stdout: "  {}", stderr: "" }],
  ] as const)("fails closed on probe %s", (_label, result) => {
    expect(() => verifyNativeRuntimeSource(
      validRequest("audio-to-video"),
      "/runtime/bin/python",
      operations(result as NativeRuntimeSourceProbeResult),
    )).toThrow(NativeRuntimeSourceGateError);
  });

  it("rejects additional JSON keys instead of silently accepting a widened probe schema", () => {
    const contract = NATIVE_RUNTIME_SOURCE_CONTRACTS.a2v;
    const result = successfulProbe(contract);
    result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), unexpected: true });
    expect(() => verifyNativeRuntimeSource(
      validRequest("audio-to-video"),
      "/runtime/bin/python",
      operations(result),
    )).toThrow("strukturell ungültig");
  });

  it("keeps a held DFR out of JobManager before source probing or DGX admission", async () => {
    const contract = NATIVE_RUNTIME_SOURCE_CONTRACTS.dfr;
    const probe = operations(successfulProbe(contract, { distributionVersion: "1.2.0" }));
    const submit = vi.fn(async () => { throw new Error("Admission must not run"); });
    const root = await mkdtemp(join(tmpdir(), "ltx-native-source-gate-"));
    const manager = new JobManager(
      join(root, "jobs.json"),
      false,
      null,
      undefined,
      undefined,
      null,
      { submit } as never,
      undefined,
      undefined,
      undefined,
      bootstrapJobStartEnforcer(false),
      () => undefined,
      probe,
    );
    try {
      expect(() => manager.create(validRequest("dfr"), { deferStart: true }))
        .toThrow(/Qualification-HOLD/u);
      expect(manager.list()).toEqual([]);
      expect(probe.run).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
