import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  let peak = 0;
  for (let offset = 0; offset + 1 < result.stdout.length; offset += 2) {
    peak = Math.max(peak, Math.abs(result.stdout.readInt16LE(offset)));
  }
  return peak;
}

describe("MuseTalk 1.5 refiner contract", () => {
  it("pins upstream, stays offline at runtime, and uses ARM64-safe InsightFace alignment", () => {
    const dockerfile = source("deploy/musetalk/Dockerfile");
    const adapter = source("scripts/musetalk-refiner.py");
    const preprocessing = source("deploy/musetalk/preprocessing_insightface.py");
    const legacyPatch = source("deploy/musetalk/patch_verified_legacy_weights.py");

    expect(dockerfile).toContain("0a89dec45a0192b824e3cf4daf96c239440c5ed8");
    expect(dockerfile).toContain("https://github.com/TMElyralab/MuseTalk.git");
    expect(dockerfile).toContain("preprocessing_insightface.py");
    expect(dockerfile).not.toContain("mmpose");
    expect(dockerfile).not.toContain("mmcv");
    expect(preprocessing).toContain("landmark_2d_106");
    expect(preprocessing).toContain("CPUExecutionProvider");
    expect(preprocessing).not.toContain("DWPose");
    expect(legacyPatch).toContain("weights_only=False");
    expect(legacyPatch).toContain("hash-verified upstream legacy archive");
    expect(adapter).toContain('"--network", "none"');
    expect(adapter).toContain('"HF_HUB_OFFLINE=1"');
    expect(adapter).toContain('"TRANSFORMERS_OFFLINE=1"');
    expect(adapter).toContain(":/opt/ltx-studio/musetalk-runner.py:ro");
    expect(adapter).toContain(":/workspace/MuseTalk/musetalk/utils/preprocessing.py:ro");
    expect(adapter).not.toContain("dgx_admission");
  });

  it("verifies every large model and the exact container source revision", () => {
    const adapter = source("scripts/musetalk-refiner.py");
    for (const sha256 of [
      "7ebf6c98c181e20838e4c0054e96e944ac60d5d692cc01db42839fe11b787007",
      "1b4889b6b1d4ce7ae320a02dedaeff1780ad77d415ea0d744b476155c6377ddc",
      "9607f98a2b22d9e229ae43c52ecea79dcede9e0c5cfae67e8da6eda86d8aac1d",
      "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
      "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf",
    ]) {
      expect(adapter).toContain(sha256);
    }
    expect(adapter).toContain("org.opencontainers.image.revision");
    expect(adapter).toContain('"dgx.runtime=ltx2_native"');
    expect(adapter).toContain("final_output.replace(output)");
  });

  it("restores exact LTX frames, rate, resolution, and selected driving audio", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-musetalk-timeline-"));
    const sourceVideo = join(root, "source.mp4");
    const refinedVideo = join(root, "refined.mp4");
    const drivingAudio = join(root, "driving.wav");
    const restoredVideo = join(root, "restored.mp4");
    const timelineScript = resolve(appRoot, "deploy/musetalk/timeline.py");
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
        "-i", sourceVideo, "-map", "0:v:0", "-an",
        "-frames:v", "96", "-c:v", "libx264", "-crf", "8",
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

  it("binds the exact external audio window in the Studio job", () => {
    const adapter = source("scripts/musetalk-refiner.py");
    const jobs = source("server/jobs.ts");
    expect(adapter).toContain("prepare_driving_audio(");
    expect(adapter).toContain('parser.add_argument("--audio-start"');
    expect(adapter).toContain('parser.add_argument("--audio-duration"');
    expect(jobs).toContain("museTalkArgs.push(...museTalkAudioArgs)");
  });
});
