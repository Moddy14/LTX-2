import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const appRoot = resolve(process.cwd());

function source(path: string): string {
  return readFileSync(resolve(appRoot, path), "utf8");
}

function run(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function pcmPeak(path: string, startSeconds: number, durationSeconds: number): number {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-ss", String(startSeconds), "-t", String(durationSeconds),
    "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "16000",
    "-f", "s16le", "pipe:1",
  ]);
  expect(result.status, result.stderr?.toString()).toBe(0);
  const pcm = result.stdout;
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
    peak = Math.max(peak, Math.abs(pcm.readInt16LE(offset)));
  }
  return peak;
}

function decodedFrameMd5(path: string): string[] {
  return run("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", path, "-map", "0:v:0", "-an", "-f", "framemd5", "pipe:1",
  ])
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split(",").slice(-2).map((field) => field.trim()).join(":"));
}

function videoPacketEvidence(path: string): unknown {
  const payload = JSON.parse(run("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=time_base:packet=pts,dts,duration,size,data_hash",
    "-show_data_hash", "sha256", "-of", "json", path,
  ])) as { streams: unknown[]; packets: unknown[] };
  return { streams: payload.streams, packets: payload.packets };
}

describe("LipForcing 14B refiner contract", () => {
  it("pins the official source, refuses arbitrary pickle globals, and stays offline", () => {
    const dockerfile = source("deploy/lipforcing/Dockerfile");
    const patch = source("deploy/lipforcing/patch_verified_runtime.py");
    const adapter = source("scripts/lipforcing-refiner.py");

    expect(dockerfile).toContain("fc864771eb347ca3ccaaef9c0b583ff6ccc9f184");
    expect(dockerfile).toContain("https://github.com/cvlab-kaist/LipForcing.git");
    expect(patch).toContain('"weights_only=False"');
    expect(patch).toContain('"weights_only=True"');
    expect(patch).toContain("weights_only=True, mmap=True");
    expect(patch).toContain("strict=False, assign=True");
    expect(patch).toContain('with torch.device("meta"):');
    expect(patch).toContain("constructor_merge_lora = True");
    expect(patch).toContain("model.reset_parameters()");
    expect(patch).toContain("LIPFORCING_INSIGHTFACE_ROOT");
    expect(patch).toContain('del state_dict');
    expect(patch).toContain('if "ckpt" in locals():');
    expect(patch).toContain('if "prefixed_sd" in locals():');
    expect(patch).toContain(
      "gc.collect()\n\n    model.reset_parameters()\n    model = model.to(device=device, dtype=dtype)",
    );
    expect(adapter).toContain('"--network", "none"');
    expect(adapter).toContain('"HF_HUB_OFFLINE=1"');
    expect(adapter).toContain('"TRANSFORMERS_OFFLINE=1"');
    expect(adapter).not.toContain(':/opt/ltx-studio/lipforcing-runner.py:ro"');
    expect(dockerfile).toContain('ENTRYPOINT ["python", "/opt/ltx-studio/lipforcing-runner.py"]');
    expect(adapter).toContain('DOCKER_EXECUTABLE = "/usr/bin/docker"');
    expect(adapter).toContain('DOCKER_EXECUTABLE, "run", "--pull", "never"');
    expect(adapter).toContain('"PATH": "/usr/sbin:/usr/bin:/sbin:/bin"');
    expect(adapter.match(/env=DOCKER_ENV/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(adapter).not.toContain('["docker"');
    expect(adapter).not.toContain('"docker", "run"');
    expect(adapter).not.toContain("dgx_admission");
  });

  it("fails closed on exact-pin patch provenance and exposes the Apache modification notice", () => {
    const dockerfile = source("deploy/lipforcing/Dockerfile");
    const patch = source("deploy/lipforcing/patch_verified_runtime.py");
    const readme = source("deploy/lipforcing/README.md");
    const adapter = source("scripts/lipforcing-refiner.py");
    const runner = source("deploy/lipforcing/container_runner.py");
    const runProvenance = source("server/runProvenance.ts");
    const helperPath = resolve(appRoot, "deploy/lipforcing/raw_output_mux.py");
    const helper = readFileSync(helperPath);
    const runnerBytes = readFileSync(resolve(appRoot, "deploy/lipforcing/container_runner.py"));
    const provenance = JSON.parse(source(
      "deploy/lipforcing/runtime-patch-provenance.v1.json",
    )) as {
      patchSetId: string;
      upstream: { commit: string; tree: string; license: { spdx: string } };
      patchedFiles: Array<{
        sourceSha256: string;
        patchedSha256: string;
        modificationNotice: string;
      }>;
      localArtifacts: Array<{ path: string; sha256: string; role: string }>;
    };

    expect(provenance).toMatchObject({
      patchSetId: "ltx-studio-lipforcing-runtime.v4",
      upstream: {
        commit: "fc864771eb347ca3ccaaef9c0b583ff6ccc9f184",
        tree: "e89930c267ffe75d6d19a9d6a8fcad4afd6672c9",
        license: { spdx: "Apache-2.0" },
      },
    });
    expect(provenance.patchedFiles).toHaveLength(3);
    for (const record of provenance.patchedFiles) {
      expect(record.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record.patchedSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(record.patchedSha256).not.toBe("0".repeat(64));
      expect(record.sourceSha256).not.toBe(record.patchedSha256);
      expect(record.modificationNotice).toContain("Modified by LTX Studio");
    }
    expect(provenance.localArtifacts[0].sha256).toBe(
      createHash("sha256").update(helper).digest("hex"),
    );
    expect(statSync(helperPath).mode & 0o022).toBe(0);
    expect(provenance.localArtifacts.find(({ path }) => path === "raw_output_mux.py"))
      .toMatchObject({ role: "paired-premux-export-and-legacy-audio-mux" });
    expect(provenance.localArtifacts.find(({ path }) => path === "lipforcing-runner.py"))
      .toMatchObject({
        sha256: createHash("sha256").update(runnerBytes).digest("hex"),
        role: "verified-offline-container-entrypoint",
      });
    const firstPatchApplication = patch.indexOf("replace_exact(", patch.indexOf("def main"));
    expect(patch.indexOf('verify_patched_files(records, "sourceSha256")'))
      .toBeLessThan(firstPatchApplication);
    expect(patch.lastIndexOf('verify_patched_files(records, "patchedSha256")'))
      .toBeGreaterThan(patch.lastIndexOf("replace_exact("));
    expect(dockerfile).toContain("COPY --chmod=0444 raw_output_mux.py /opt/ltx-studio/raw_output_mux.py");
    expect(dockerfile).toContain("COPY --chmod=0444 container_runner.py /opt/ltx-studio/lipforcing-runner.py");
    expect(dockerfile).toContain("COPY --chmod=0444 runtime-patch-provenance.v1.json /opt/ltx-studio/runtime-patch-provenance.v1.json");
    expect(dockerfile).toContain('com.moddy.ltx-studio.lipforcing.patchset="ltx-studio-lipforcing-runtime.v4"');
    expect(dockerfile).toContain("PYTHONPATH=/opt/ltx-studio:/workspace/LipForcing");
    expect(readme).toContain("Apache-2.0 modification notice");
    expect(adapter).toContain("com.moddy.ltx-studio.lipforcing.patchset");
    expect(runner).toContain('child_environment["LTX_LIPFORCING_RAW_OUTPUT_PROFILE"]');
    expect(runProvenance).toContain('"code:lipforcing-runtime-patch-provenance"');
    expect(runProvenance).toContain('"code:lipforcing-raw-output-mux"');
  });

  it("keeps the default upstream mux command golden and changes only its video codec segment", () => {
    const helper = resolve(appRoot, "deploy/lipforcing/raw_output_mux.py");
    const script = [
      "import importlib.util,json,sys",
      "spec=importlib.util.spec_from_file_location('raw_output_mux',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "print(json.dumps(module.build_mux_command('ffmpeg','raw.mp4','audio.wav','output.mp4',sys.argv[2],1.25)))",
    ].join(";");
    const command = (profile: string) => JSON.parse(run("python3", [
      "-c", script, helper, profile,
    ])) as string[];
    const baseline = command("h264-crf13-mux-crf18-v1");
    const candidate = command("h264-crf13-mux-copy-v1");

    expect(baseline).toEqual([
      "ffmpeg", "-y", "-loglevel", "error", "-nostdin",
      "-i", "raw.mp4", "-i", "audio.wav",
      "-map", "0:v:0", "-map", "1:a:0",
      "-c:v", "libx264", "-crf", "18",
      "-c:a", "aac", "-q:v", "0", "-q:a", "0",
      "-t", "1.2500", "output.mp4",
    ]);
    expect(candidate).toEqual([
      ...baseline.slice(0, 13),
      "-c:v", "copy",
      ...baseline.slice(17),
    ]);
    const invalid = spawnSync("python3", [
      "-c", script, helper, "unregistered-mux-profile",
    ], { encoding: "utf8" });
    expect(invalid.status).not.toBe(0);
    expect(invalid.stderr).toContain("Unsupported LipForcing raw-output profile");
  });

  it("stream-copies the CRF-13 temporary video with decoded framemd5 and stream timeline identity", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-mux-copy-"));
    const rawVideo = join(root, "raw-crf13.mp4");
    const audio = join(root, "audio.wav");
    const output = join(root, "mux-copy.mp4");
    const rejectedOutput = join(root, "rejected.mp4");
    const helper = resolve(appRoot, "deploy/lipforcing/raw_output_mux.py");
    const invoke = [
      "import importlib.util,sys",
      "spec=importlib.util.spec_from_file_location('raw_output_mux',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.mux_video_with_audio('ffmpeg',sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5],2.0)",
    ].join(";");
    try {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25",
        "-frames:v", "50", "-an", "-c:v", "libx264", "-crf", "13",
        "-pix_fmt", "yuv420p", rawVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=2",
        "-c:a", "pcm_s16le", audio,
      ]);
      run("python3", [
        "-c", invoke, helper, rawVideo, audio, output, "h264-crf13-mux-copy-v1",
      ]);

      expect(decodedFrameMd5(output)).toEqual(decodedFrameMd5(rawVideo));
      const streams = JSON.parse(run("ffprobe", [
        "-v", "error", "-count_frames",
        "-show_entries", "stream=codec_type,codec_name,avg_frame_rate,nb_read_frames",
        "-of", "json", output,
      ])).streams as Array<Record<string, string>>;
      expect(streams.find(({ codec_type }) => codec_type === "video")).toMatchObject({
        codec_name: "h264",
        avg_frame_rate: "25/1",
        nb_read_frames: "50",
      });
      expect(streams.find(({ codec_type }) => codec_type === "audio")?.codec_name).toBe("aac");

      const invalid = spawnSync("python3", [
        "-c", invoke, helper, rawVideo, audio, rejectedOutput, "unregistered-mux-profile",
      ], { encoding: "utf8" });
      expect(invalid.status).not.toBe(0);
      expect(existsSync(rejectedOutput)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("exports only one held CRF13 pre-mux in-container, then derives both arms with held host FDs", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-paired-mux-"));
    const pair = join(root, "pair");
    const rawVideo = join(root, "raw-crf13.mp4");
    const audio = join(root, "audio.wav");
    const helper = resolve(appRoot, "deploy/lipforcing/raw_output_mux.py");
    const runner = resolve(appRoot, "deploy/lipforcing/container_runner.py");
    const adapter = resolve(appRoot, "scripts/lipforcing-refiner.py");
    mkdirSync(pair, { mode: 0o700 });
    chmodSync(pair, 0o700);
    const invoke = [
      "import importlib.util,os,pathlib,sys",
      "raw_spec=importlib.util.spec_from_file_location('raw_output_mux',sys.argv[1])",
      "raw=importlib.util.module_from_spec(raw_spec);raw_spec.loader.exec_module(raw)",
      "refiner_spec=importlib.util.spec_from_file_location('refiner',sys.argv[2])",
      "refiner=importlib.util.module_from_spec(refiner_spec);refiner_spec.loader.exec_module(refiner)",
      "pair=pathlib.Path(sys.argv[4])",
      "raw.PAIRED_ROOT=pair",
      "raw.CONTAINER_RUNNER=pathlib.Path(sys.argv[3])",
      "refiner.CONTAINER_PREMUX_OUTPUT=str(pair/'pre-mux-crf13.mp4')",
      "os.environ['LTX_LIPFORCING_PAIRED_PREMUX_OUTPUT']=str(pair/'pre-mux-crf13.mp4')",
      "os.environ['LTX_LIPFORCING_PAIRED_PREMUX_RECEIPT_OUTPUT']=str(pair/'pre-mux-receipt.json')",
      "raw.mux_video_with_audio('/usr/bin/ffmpeg',sys.argv[5],sys.argv[6],pair/'pre-mux-crf13.mp4',raw.BASELINE_PROFILE,2.0)",
      "duration,evidence=refiner.validate_pre_mux_export_receipt(pair)",
      "refiner.run_host_raw_mux_pair(pair,pathlib.Path(sys.argv[6]),duration,evidence)",
    ].join(";");
    try {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25",
        "-frames:v", "50", "-an", "-c:v", "libx264", "-crf", "13",
        "-pix_fmt", "yuv420p", rawVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=2",
        "-c:a", "pcm_s16le", audio,
      ]);
      run("python3", [
        "-c", invoke, helper, adapter, runner, pair, rawVideo, audio,
      ]);

      const preMux = join(pair, "pre-mux-crf13.mp4");
      const preMuxReceiptPath = join(pair, "pre-mux-receipt.json");
      const baseline = join(pair, "baseline-raw.mp4");
      const candidate = join(pair, "candidate-raw.mp4");
      const receiptPath = join(pair, "pair-receipt.json");
      const preMuxReceipt = JSON.parse(readFileSync(preMuxReceiptPath, "utf8")) as {
        schemaVersion: string;
        durationArg: string;
        byteIdentical: boolean;
        source: { sha256: string; sizeBytes: number; revision: Record<string, unknown> };
        export: { sha256: string; sizeBytes: number; revision: Record<string, unknown> };
        copy: { method: string; command: { argv: string[]; sha256: string } };
        code: { rawOutputMuxSha256: string; containerRunnerSha256: string };
      };
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
        schemaVersion: string;
        durationArg: string;
        ffmpeg: { path: string; sha256: string; version: string };
        inputs: Record<string, string | number>;
        commands: Record<string, { argv: string[]; sha256: string }>;
        outputs: Record<string, { sha256: string; sizeBytes: number }>;
      };
      const fileSha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(preMuxReceipt).toMatchObject({
        schemaVersion: "ltx-studio-lipforcing-premux-export-receipt.v1",
        durationArg: "2.0000",
        byteIdentical: true,
        copy: { method: "python-os-read-write-held-fd-exclusive-v1" },
      });
      expect(preMuxReceipt.source.sha256).toBe(preMuxReceipt.export.sha256);
      expect(preMuxReceipt.source.sizeBytes).toBe(preMuxReceipt.export.sizeBytes);
      expect(preMuxReceipt.export.revision).toMatchObject({ nlink: 1 });
      expect(preMuxReceipt.copy.command.argv).toEqual([
        "ltx-studio-internal-held-fd-copy-v1",
        "--source", expect.stringMatching(/^\/proc\/self\/fd\/[0-9]+$/),
        "--output", pair + "/pre-mux-crf13.mp4",
        "--exclusive",
      ]);
      expect(preMuxReceipt.copy.command.sha256).toBe(
        createHash("sha256").update(JSON.stringify(preMuxReceipt.copy.command.argv)).digest("hex"),
      );
      expect(preMuxReceipt.code).toEqual({
        rawOutputMuxSha256: fileSha256(helper),
        containerRunnerSha256: fileSha256(runner),
      });
      expect(receipt.schemaVersion).toBe("ltx-studio-lipforcing-raw-mux-pair-receipt.v1");
      expect(receipt.durationArg).toBe("2.0000");
      expect(receipt.ffmpeg).toMatchObject({
        path: "/usr/bin/ffmpeg",
        sha256: fileSha256("/usr/bin/ffmpeg"),
      });
      expect(fileSha256(preMux)).toBe(fileSha256(rawVideo));
      expect(receipt.inputs.preMuxSourceSha256).toBe(fileSha256(preMux));
      expect(receipt.inputs.preMuxExportSha256).toBe(fileSha256(preMux));
      expect(receipt.inputs.audioSha256).toBe(fileSha256(audio));
      expect(receipt.outputs.baselineRaw.sha256).toBe(fileSha256(baseline));
      expect(receipt.outputs.candidateRaw.sha256).toBe(fileSha256(candidate));
      expect(receipt.commands.baseline.sha256).toBe(
        createHash("sha256").update(JSON.stringify(receipt.commands.baseline.argv)).digest("hex"),
      );
      expect(receipt.commands.candidate.sha256).toBe(
        createHash("sha256").update(JSON.stringify(receipt.commands.candidate.argv)).digest("hex"),
      );
      expect(receipt.commands.baseline.argv[6]).toMatch(/^\/proc\/self\/fd\/[0-9]+$/);
      expect(receipt.commands.baseline.argv[8]).toMatch(/^\/proc\/self\/fd\/[0-9]+$/);
      expect(receipt.commands.candidate.argv[6]).toBe(receipt.commands.baseline.argv[6]);
      expect(receipt.commands.candidate.argv[8]).toBe(receipt.commands.baseline.argv[8]);
      expect(receipt.commands.baseline.argv.at(-1))
        .toMatch(/^\/proc\/self\/fd\/[0-9]+\/baseline-raw\.mp4$/);
      expect(receipt.commands.candidate.argv.at(-1))
        .toMatch(/^\/proc\/self\/fd\/[0-9]+\/candidate-raw\.mp4$/);
      expect(decodedFrameMd5(candidate)).toEqual(decodedFrameMd5(preMux));
      expect(videoPacketEvidence(candidate)).toEqual(videoPacketEvidence(preMux));

      const streamEvidence = (path: string) => JSON.parse(run("ffprobe", [
        "-v", "error", "-count_frames",
        "-show_entries", "stream=codec_type,avg_frame_rate,nb_read_frames,width,height,duration",
        "-of", "json", path,
      ])).streams as Array<Record<string, string>>;
      const baselineStreams = streamEvidence(baseline);
      const candidateStreams = streamEvidence(candidate);
      const baselineVideo = baselineStreams.find(({ codec_type }) => codec_type === "video");
      const candidateVideo = candidateStreams.find(({ codec_type }) => codec_type === "video");
      expect(baselineVideo).toMatchObject({
        avg_frame_rate: candidateVideo?.avg_frame_rate,
        nb_read_frames: candidateVideo?.nb_read_frames,
        width: candidateVideo?.width,
        height: candidateVideo?.height,
      });
      expect(Number(baselineStreams.find(({ codec_type }) => codec_type === "audio")?.duration))
        .toBeCloseTo(Number(candidateStreams.find(({ codec_type }) => codec_type === "audio")?.duration), 3);

      const receiptHashBefore = fileSha256(receiptPath);
      const preMuxReceiptHashBefore = fileSha256(preMuxReceiptPath);
      const baselineHashBefore = fileSha256(baseline);
      const candidateHashBefore = fileSha256(candidate);
      const repeat = spawnSync("python3", [
        "-c", invoke, helper, adapter, runner, pair, rawVideo, audio,
      ], { encoding: "utf8" });
      expect(repeat.status).not.toBe(0);
      expect(fileSha256(receiptPath)).toBe(receiptHashBefore);
      expect(fileSha256(preMuxReceiptPath)).toBe(preMuxReceiptHashBefore);
      expect(fileSha256(baseline)).toBe(baselineHashBefore);
      expect(fileSha256(candidate)).toBe(candidateHashBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the container pre-mux export closed on partial env, symlinks, hardlinks, and existing output", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-paired-reject-"));
    const helper = resolve(appRoot, "deploy/lipforcing/raw_output_mux.py");
    const rawVideo = join(root, "raw.mp4");
    const rawAlias = join(root, "raw-hardlink.mp4");
    const audio = join(root, "audio.wav");
    const runner = resolve(appRoot, "deploy/lipforcing/container_runner.py");
    const script = [
      "import importlib.util,os,pathlib,sys",
      "spec=importlib.util.spec_from_file_location('raw_output_mux',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "pair=pathlib.Path(sys.argv[2]);module.PAIRED_ROOT=pair",
      "module.CONTAINER_RUNNER=pathlib.Path(sys.argv[6])",
      "os.environ['LTX_LIPFORCING_PAIRED_PREMUX_OUTPUT']=str(pair/'pre-mux-crf13.mp4')",
      "mode=sys.argv[5]",
      "None if mode=='partial' else os.environ.__setitem__('LTX_LIPFORCING_PAIRED_PREMUX_RECEIPT_OUTPUT',str(pair/'pre-mux-receipt.json'))",
      "module.mux_video_with_audio('/usr/bin/ffmpeg',sys.argv[3],sys.argv[4],pair/'pre-mux-crf13.mp4',module.BASELINE_PROFILE,1.0)",
    ].join(";");
    const reject = (pair: string, video: string, mode: string) => spawnSync("python3", [
      "-c", script, helper, pair, video, audio, mode, runner,
    ], { encoding: "utf8" });
    try {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "testsrc2=size=80x64:rate=25", "-frames:v", "25", "-an", "-c:v",
        "libx264", "-crf", "13", "-pix_fmt", "yuv420p", rawVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i",
        "sine=frequency=440:sample_rate=16000:duration=1", "-c:a", "pcm_s16le", audio,
      ]);

      const partialPair = join(root, "partial");
      mkdirSync(partialPair, { mode: 0o700 });
      expect(reject(partialPair, rawVideo, "partial").status).not.toBe(0);

      const symlinkPair = join(root, "symlink");
      mkdirSync(symlinkPair, { mode: 0o700 });
      const sentinel = join(root, "sentinel");
      writeFileSync(sentinel, "unchanged");
      symlinkSync(sentinel, join(symlinkPair, "pre-mux-receipt.json"));
      expect(reject(symlinkPair, rawVideo, "complete").status).not.toBe(0);
      expect(readFileSync(sentinel, "utf8")).toBe("unchanged");

      const existingPair = join(root, "existing");
      mkdirSync(existingPair, { mode: 0o700 });
      writeFileSync(join(existingPair, "pre-mux-crf13.mp4"), "do-not-overwrite");
      expect(reject(existingPair, rawVideo, "complete").status).not.toBe(0);
      expect(readFileSync(join(existingPair, "pre-mux-crf13.mp4"), "utf8"))
        .toBe("do-not-overwrite");

      const hardlinkPair = join(root, "hardlink");
      mkdirSync(hardlinkPair, { mode: 0o700 });
      linkSync(rawVideo, rawAlias);
      expect(reject(hardlinkPair, rawVideo, "complete").status).not.toBe(0);
      expect(existsSync(join(hardlinkPair, "pre-mux-receipt.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses one cross-language compact-JSON command digest", () => {
    const argv = ["/usr/bin/ffmpeg", "-n", "Grüße", "/paired/baseline-raw.mp4"];
    const expected = "4cd572dc10b5e00b34aa8849292c75986273d27f8bf983f8ecd2c4f4fe506599";
    const adapter = resolve(appRoot, "scripts/lipforcing-refiner.py");
    const python = run("python3", [
      "-c",
      [
        "import importlib.util,json,sys",
        "spec=importlib.util.spec_from_file_location('refiner',sys.argv[1])",
        "module=importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "print(module.sha256_command(json.loads(sys.argv[2])))",
      ].join(";"),
      adapter,
      JSON.stringify(argv),
    ]).trim();
    expect(createHash("sha256").update(JSON.stringify(argv)).digest("hex")).toBe(expected);
    expect(python).toBe(expected);
  });

  it("verifies the official model graph and exact container source revision", () => {
    const adapter = source("scripts/lipforcing-refiner.py");
    const runner = source("deploy/lipforcing/container_runner.py");
    for (const sha256 of [
      "ea9f111f374a208a80b6604e2c698639f03ad666bb7cda72c727a93cd43e4307",
      "38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981",
      "8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a",
      "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
      "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf",
    ]) {
      expect(adapter).toContain(sha256);
    }
    expect(adapter).toContain("org.opencontainers.image.revision");
    expect(adapter).toContain('"dgx.runtime=ltx2_native"');
    expect(adapter).toContain("final_output.replace(output)");
    expect(runner).toContain("validate_model_manifest(model_root)");
    expect(runner).toContain('set(PINNED_RUNTIME_ARTIFACTS) | {"text_emb.pt"}');
    expect(runner).toContain("require_artifact(model_root / relative, size, sha256)");
    expect(runner).toContain("embedding_artifact.get(\"derivation\") != provenance");
    expect(runner).toContain("torch.bfloat16");
  });

  it("accepts only the exact immutable image identity handed to the adapter", () => {
    const adapter = resolve(appRoot, "scripts/lipforcing-refiner.py");
    const jobs = source("server/jobs.ts");
    const imageA = `sha256:${"a".repeat(64)}`;
    const imageB = `sha256:${"b".repeat(64)}`;
    const repoDigest = `ltx-studio-lipforcing@sha256:${"c".repeat(64)}`;
    const script = [
      "import importlib.util,json,sys,types",
      "spec=importlib.util.spec_from_file_location('lipforcing_refiner',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "inspection={'Id':sys.argv[3],'RepoDigests':[sys.argv[4]],'Config':{'Labels':{'org.opencontainers.image.revision':module.LIPFORCING_COMMIT,'com.moddy.ltx-studio.lipforcing.patchset':module.LIPFORCING_PATCHSET_ID}}}",
      "module.subprocess.run=lambda *args,**kwargs: types.SimpleNamespace(stdout=json.dumps(inspection))",
      "module.verify_image_revision(sys.argv[2])",
    ].join(";");
    const verify = (reference: string, inspectedId: string) => spawnSync("python3", [
      "-c", script, adapter, reference, inspectedId, repoDigest,
    ], { encoding: "utf8" });

    expect(verify(imageA, imageA).status).toBe(0);
    expect(verify(repoDigest, imageA).status).toBe(0);
    expect(verify("ltx-studio-lipforcing:14b-cu131", imageA).status).not.toBe(0);
    expect(verify(`-evil@sha256:${"d".repeat(64)}`, imageA).status).not.toBe(0);
    expect(verify(imageA, imageB).status).not.toBe(0);
    expect(jobs).toContain('"--image", lipForcingContainerIdentity.executionReference');
    expect(jobs).not.toContain('"--image", lipForcingImage,');
    expect(jobs).toContain("spawnSync(hostTcbExecutables.docker");
    expect(jobs).not.toMatch(/(?:spawnSync|executableAvailable)\("docker"/);
  });

  it("finalizes idempotently after deleting the temporary UMT5 bootstrap", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-model-finalize-"));
    const installer = resolve(appRoot, "deploy/lipforcing/install_models.py");
    const script = [
      "import hashlib, importlib.util, json, pathlib, sys, types",
      "hub=types.ModuleType('huggingface_hub')",
      "hub.hf_hub_download=lambda **kwargs: (_ for _ in ()).throw(RuntimeError('unexpected download'))",
      "sys.modules['huggingface_hub']=hub",
      "spec=importlib.util.spec_from_file_location('install_models', sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "root=pathlib.Path(sys.argv[2])",
      "root.mkdir(parents=True, exist_ok=True)",
      "embedding=b'verified-derived-embedding'",
      "(root/'text_emb.pt').write_bytes(embedding)",
      "sha=hashlib.sha256(embedding).hexdigest()",
      "provenance={",
      "  'schema_version': module.TEXT_EMBEDDING_SCHEMA,",
      "  'prompt': module.TEXT_EMBEDDING_PROMPT,",
      "  'shape': module.TEXT_EMBEDDING_SHAPE,",
      "  'dtype': module.TEXT_EMBEDDING_DTYPE,",
      "  'lipforcing_commit': module.LIPFORCING_CODE_COMMIT,",
      "  'wan_revision': module.WAN_REVISION,",
      "  'source_text_encoder_sha256': module.TEXT_ENCODER_SHA256,",
      "  'artifact': {'path':'text_emb.pt','size_bytes':len(embedding),'sha256':sha},",
      "}",
      "(root/'text-embedding-provenance.json').write_text(json.dumps(provenance))",
      "(root/'bootstrap').mkdir()",
      "(root/'bootstrap'/'temporary').write_text('temporary')",
      "module.install_runtime_downloads=lambda _root, force: []",
      "manifest=module.finalize(root, True)",
      "assert manifest.is_file()",
      "assert not (root/'bootstrap').exists()",
      "first=json.loads(manifest.read_text())",
      "assert [item['path'] for item in first['artifacts']] == ['text_emb.pt']",
      "module.finalize(root, True)",
      "assert not (root/'bootstrap').exists()",
      "provenance['shape']=[1,1,1]",
      "(root/'text-embedding-provenance.json').write_text(json.dumps(provenance))",
      "try:",
      "  module.finalize(root, False)",
      "except RuntimeError as error:",
      "  assert \"'shape'\" in str(error)",
      "else:",
      "  raise AssertionError('invalid provenance was accepted')",
    ].join("\n");
    try {
      const result = spawnSync("python3", ["-c", script, installer, root], {
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(root, "ltx-studio-model-manifest.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("covers the entire audio instead of accepting upstream chunk truncation", () => {
    const runner = source("deploy/lipforcing/container_runner.py");
    const timeline = source("deploy/lipforcing/timeline.py");
    const adapter = source("scripts/lipforcing-refiner.py");
    const jobs = source("server/jobs.ts");

    expect(runner).toContain("ceil(latent_frames / CHUNK_SIZE) * CHUNK_SIZE");
    expect(runner).toContain('"--num_latent_frames"');
    expect(timeline).toContain("trim=end_frame=");
    expect(timeline).toContain('"1:a:0"');
    expect(timeline).toContain("source_timeline.frame_count");
    expect(adapter).toContain("prepare_driving_audio(");
    expect(adapter).toContain("prepare_control_audio(");
    expect(adapter).toContain("atrim=start=");
    expect(jobs).toContain("lipForcingArgs.push(...lipForcingAudioArgs)");
    expect(jobs).toContain('"--mouth-delay-ms"');
    expect(jobs).toContain('"--program-audio-delay-ms"');
    expect(adapter).toContain('parser.add_argument("--program-audio-delay-ms"');
    expect(adapter).toContain("LipForcing-Tonversatz muss zwischen -500 und 500 ms liegen.");
  });

  it("normalizes LTX cadence to the official 25 fps input domain before face alignment", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-source-cfr-"));
    const sourceVideo = join(root, "source.mp4");
    const normalizedVideo = join(root, "normalized.mp4");
    const adapter = resolve(appRoot, "scripts/lipforcing-refiner.py");
    try {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
        "-frames:v", "97", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        sourceVideo,
      ]);
      const output = run("python3", [
        "-c",
        [
          "import importlib.util, pathlib, sys",
          "spec=importlib.util.spec_from_file_location('lipforcing_refiner', sys.argv[1])",
          "module=importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "module.prepare_source_video(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]))",
        ].join(";"),
        adapter,
        sourceVideo,
        normalizedVideo,
      ]);
      const stream = JSON.parse(run("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate,nb_frames,duration", "-of", "json",
        normalizedVideo,
      ])).streams[0];
      expect(output).toContain("25-fps-CFR-Domäne normalisiert");
      expect(stream.avg_frame_rate).toBe("25/1");
      expect(stream.nb_frames).toBe("101");
      expect(Number(stream.duration)).toBeCloseTo(97 / 24, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins the released student's matching two-step schedule", () => {
    const runner = source("deploy/lipforcing/container_runner.py");
    expect(runner).toContain('RELEASED_T_LIST = ("0.999", "0.769", "0.0")');
    expect(runner).toContain('"--t_list", *RELEASED_T_LIST');
    expect(runner).not.toContain('RELEASED_T_LIST = ("0.999", "0.833", "0.0")');
  });

  it("cuts clean conditioning audio and pads it to the exact LTX duration", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-audio-"));
    const sourceVideo = join(root, "source.mp4");
    const cleanAudio = join(root, "clean.wav");
    const preparedAudio = join(root, "prepared.wav");
    const adapter = resolve(appRoot, "scripts/lipforcing-refiner.py");
    try {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000",
        "-frames:v", "97", "-t", String(97 / 24),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", sourceVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=8",
        "-c:a", "pcm_s16le", cleanAudio,
      ]);
      run("python3", [
        "-c",
        [
          "import importlib.util, pathlib, sys",
          "spec=importlib.util.spec_from_file_location('lipforcing_refiner', sys.argv[1])",
          "module=importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "module.prepare_driving_audio(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]), 1.0, 2.0)",
        ].join(";"),
        adapter,
        cleanAudio,
        sourceVideo,
        preparedAudio,
      ]);
      const duration = Number(JSON.parse(run("ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "json", preparedAudio,
      ])).format.duration);
      expect(duration).toBeCloseTo(97 / 24, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delays only the model control audio by the measured correction", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-control-audio-"));
    const programAudio = join(root, "program.wav");
    const controlAudio = join(root, "control.wav");
    const adapter = resolve(appRoot, "scripts/lipforcing-refiner.py");
    try {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1",
        "-c:a", "pcm_s16le", programAudio,
      ]);
      run("python3", [
        "-c",
        [
          "import importlib.util, pathlib, sys",
          "spec=importlib.util.spec_from_file_location('lipforcing_refiner', sys.argv[1])",
          "module=importlib.util.module_from_spec(spec)",
          "spec.loader.exec_module(module)",
          "module.prepare_control_audio(pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3]), 1.0, 125)",
        ].join(";"),
        adapter,
        programAudio,
        controlAudio,
      ]);
      expect(pcmPeak(programAudio, 0.02, 0.05)).toBeGreaterThan(1_000);
      expect(pcmPeak(controlAudio, 0.02, 0.05)).toBeLessThan(100);
      expect(pcmPeak(controlAudio, 0.15, 0.05)).toBeGreaterThan(1_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("materializes a dedicated immutable control-audio copy for paired zero-delay runs", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-zero-delay-control-"));
    const sourceAudio = join(root, "program.wav");
    const controlAudio = join(root, "control.wav");
    const adapter = resolve(appRoot, "scripts/lipforcing-refiner.py");
    const invoke = [
      "import importlib.util,pathlib,sys",
      "spec=importlib.util.spec_from_file_location('refiner',sys.argv[1])",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.copy_file_exclusive(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),'paired zero-delay control audio')",
    ].join(";");
    try {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=16000:duration=1",
        "-c:a", "pcm_s16le", sourceAudio,
      ]);
      run("python3", ["-c", invoke, adapter, sourceAudio, controlAudio]);
      expect(readFileSync(controlAudio)).toEqual(readFileSync(sourceAudio));
      expect(statSync(controlAudio).nlink).toBe(1);
      expect(statSync(controlAudio).mode & 0o777).toBe(0o400);
      expect(source("scripts/lipforcing-refiner.py")).toContain(
        "args.paired_raw_experiment_dir is not None and control_audio == program_audio",
      );
      expect(spawnSync("python3", [
        "-c", invoke, adapter, sourceAudio, controlAudio,
      ]).status).not.toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("executes both paired timelines through held executable and input descriptors", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-held-timeline-"));
    const sourceVideo = join(root, "source.mp4");
    const rawVideo = join(root, "raw.mp4");
    const programAudio = join(root, "program.wav");
    const baselineRaw = join(root, "baseline-raw.mp4");
    const candidateRaw = join(root, "candidate-raw.mp4");
    const baselineFinal = join(root, "baseline-final.mp4");
    const candidateFinal = join(root, "candidate-final.mp4");
    const timelineScript = resolve(appRoot, "deploy/lipforcing/timeline.py");
    try {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-frames:v", "48", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", sourceVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=25",
        "-frames:v", "50", "-an", "-c:v", "libx264", "-crf", "13",
        "-pix_fmt", "yuv420p", rawVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=16000:duration=2",
        "-c:a", "pcm_s16le", programAudio,
      ]);
      run("python3", [
        "-c",
        [
          "import importlib.util,sys",
          "spec=importlib.util.spec_from_file_location('mux',sys.argv[1])",
          "module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)",
          "module.mux_video_with_audio('/usr/bin/ffmpeg',sys.argv[2],sys.argv[3],sys.argv[4],module.BASELINE_PROFILE,2.0)",
          "module.mux_video_with_audio('/usr/bin/ffmpeg',sys.argv[2],sys.argv[3],sys.argv[5],module.MUX_COPY_PROFILE,2.0)",
        ].join(";"),
        resolve(appRoot, "deploy/lipforcing/raw_output_mux.py"),
        rawVideo,
        programAudio,
        baselineRaw,
        candidateRaw,
      ]);
      const harness = [
        "import json,os,subprocess,sys",
        "timeline=sys.argv[1]",
        "paths=sys.argv[2:]",
        "ffmpeg_fd=os.open('/usr/bin/ffmpeg',os.O_RDONLY|os.O_NOFOLLOW)",
        "ffprobe_fd=os.open('/usr/bin/ffprobe',os.O_RDONLY|os.O_NOFOLLOW)",
        "source_fd=os.open(paths[0],os.O_RDONLY|os.O_NOFOLLOW)",
        "audio_fd=os.open(paths[1],os.O_RDONLY|os.O_NOFOLLOW)",
        "baseline_fd=os.open(paths[2],os.O_RDONLY|os.O_NOFOLLOW)",
        "candidate_fd=os.open(paths[3],os.O_RDONLY|os.O_NOFOLLOW)",
        "fds=(ffmpeg_fd,ffprobe_fd,source_fd,audio_fd,baseline_fd,candidate_fd)",
        "def arm(refined_fd,output):",
        "  command=[sys.executable,timeline,'--refined',f'/proc/self/fd/{refined_fd}','--source',f'/proc/self/fd/{source_fd}','--audio',f'/proc/self/fd/{audio_fd}','--program-audio-delay-ms','0','--exclusive-output','--emit-command-evidence','--paired-ffmpeg-fd',str(ffmpeg_fd),'--paired-ffprobe-fd',str(ffprobe_fd),'--output',output]",
        "  [command.extend(['--paired-input-fd',str(fd)]) for fd in (source_fd,audio_fd,baseline_fd,candidate_fd)]",
        "  return json.loads(subprocess.run(command,check=True,capture_output=True,text=True,pass_fds=fds).stdout)",
        "try:",
        "  print(json.dumps({'baseline':arm(baseline_fd,paths[4]),'candidate':arm(candidate_fd,paths[5])}))",
        "finally:",
        "  [os.close(fd) for fd in reversed(fds)]",
      ].join("\n");
      const evidence = JSON.parse(run("python3", [
        "-c", harness, timelineScript, sourceVideo, programAudio, baselineRaw, candidateRaw,
        baselineFinal, candidateFinal,
      ])) as Record<string, { command: string[]; [key: string]: unknown }>;
      const withoutCommand = (timeline: { command: string[]; [key: string]: unknown }) =>
        Object.fromEntries(Object.entries(timeline).filter(([key]) => key !== "command"));
      expect(withoutCommand(evidence.baseline)).toEqual(withoutCommand(evidence.candidate));
      const normalize = (argv: string[]) => {
        const copy = [...argv];
        copy[copy.indexOf("-i") + 1] = "<refined-fd>";
        copy[copy.length - 1] = "<output>";
        return copy;
      };
      expect(normalize(evidence.baseline.command)).toEqual(normalize(evidence.candidate.command));
      expect(evidence.baseline.command[0]).toBe("/usr/bin/ffmpeg");
      expect(evidence.baseline.command[evidence.baseline.command.indexOf("-i") + 1])
        .toMatch(/^\/proc\/self\/fd\/[0-9]+$/);
      const pcmHash = (path: string) => {
        const decoded = spawnSync("/usr/bin/ffmpeg", [
          "-v", "error", "-i", path, "-map", "0:a:0", "-vn", "-ac", "1",
          "-ar", "48000", "-f", "s16le", "pipe:1",
        ]);
        expect(decoded.status, decoded.stderr?.toString()).toBe(0);
        return createHash("sha256").update(decoded.stdout).digest("hex");
      };
      expect(pcmHash(baselineFinal)).toBe(pcmHash(candidateFinal));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores exact LTX frames, rate, resolution, and selected driving audio from the 25 fps result", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-lipforcing-timeline-"));
    const sourceVideo = join(root, "source.mp4");
    const refinedVideo = join(root, "refined.mp4");
    const drivingAudio = join(root, "driving.wav");
    const restoredVideo = join(root, "restored.mp4");
    const timelineScript = resolve(appRoot, "deploy/lipforcing/timeline.py");
    try {
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
        "-frames:v", "97", "-t", String(97 / 24),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k",
        sourceVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=25",
        "-frames:v", "105", "-c:v", "libx264", "-crf", "8",
        "-pix_fmt", "yuv420p", refinedVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=16000:duration=2",
        "-af", `apad,atrim=duration=${97 / 24}`,
        "-c:a", "pcm_s16le", drivingAudio,
      ]);
      run("python3", [
        timelineScript,
        "--refined", refinedVideo,
        "--source", sourceVideo,
        "--audio", drivingAudio,
        "--program-audio-delay-ms", "125",
        "--output", restoredVideo,
      ]);

      const streams = JSON.parse(run("ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_type,avg_frame_rate,nb_frames,width,height",
        "-of", "json", restoredVideo,
      ])).streams;
      expect(streams.find((stream: { codec_type: string }) => stream.codec_type === "video")).toMatchObject({
        avg_frame_rate: "24/1",
        nb_frames: "97",
        width: 320,
        height: 240,
      });
      expect(streams.some((stream: { codec_type: string }) => stream.codec_type === "audio")).toBe(true);
      expect(pcmPeak(restoredVideo, 0.02, 0.05)).toBeLessThan(100);
      expect(pcmPeak(restoredVideo, 0.25, 0.5)).toBeGreaterThan(1_000);
      expect(pcmPeak(restoredVideo, 3, 0.5)).toBeLessThan(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps every Python deployment entry point syntactically valid", () => {
    const paths = [
      "deploy/lipforcing/container_runner.py",
      "deploy/lipforcing/install_models.py",
      "deploy/lipforcing/patch_verified_runtime.py",
      "deploy/lipforcing/prepare_text_embedding.py",
      "deploy/lipforcing/raw_output_mux.py",
      "deploy/lipforcing/timeline.py",
      "scripts/lipforcing-refiner.py",
    ].map((path) => resolve(appRoot, path));
    const result = spawnSync("python3", ["-m", "py_compile", ...paths], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
