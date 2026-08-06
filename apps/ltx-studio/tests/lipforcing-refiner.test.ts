import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    expect(adapter).toContain(':/opt/ltx-studio/lipforcing-runner.py:ro"');
    expect(adapter).not.toContain("dgx_admission");
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
    expect(adapter).toContain("atrim=start=");
    expect(jobs).toContain("lipForcingArgs.push(...lipForcingAudioArgs)");
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
      "deploy/lipforcing/timeline.py",
      "scripts/lipforcing-refiner.py",
    ].map((path) => resolve(appRoot, path));
    const result = spawnSync("python3", ["-m", "py_compile", ...paths], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
