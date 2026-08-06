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

describe("LatentSync refiner contract", () => {
  it("pins the official source revision and runs offline", () => {
    const dockerfile = source("deploy/latentsync/Dockerfile");
    const adapter = source("scripts/latentsync-refiner.py");

    expect(dockerfile).toContain("a229c3948406bc2cf6eaf4873e662e70c6a04746");
    expect(dockerfile).toContain("https://github.com/bytedance/LatentSync.git");
    expect(dockerfile).toContain("patch_arm64_decord.py");
    expect(dockerfile).not.toContain("decord==");
    expect(adapter).toContain('"--network", "none"');
    expect(adapter).toContain('"HF_HUB_OFFLINE=1"');
    expect(adapter).toContain('"TRANSFORMERS_OFFLINE=1"');
    expect(adapter).toContain("verify_image_revision(args.image)");
    expect(adapter).toContain(":/opt/ltx-studio/latentsync-runner.py:ro");
    expect(adapter).toContain(":/opt/ltx-studio/timeline.py:ro");
  });

  it("verifies every large model before starting its owned container", () => {
    const adapter = source("scripts/latentsync-refiner.py");

    for (const sha256 of [
      "0a478e89eb660f82da4c35dbdde8a5adfb27f99d1b4e50edd03729e1e98316d3",
      "65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9",
      "a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815",
      "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
      "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf",
    ]) {
      expect(adapter).toContain(sha256);
    }
    expect(adapter).toContain('"dgx.runtime=ltx2_native"');
    expect(adapter).toContain("temporary_output.replace(output)");
    expect(adapter).not.toContain("dgx_admission");
  });

  it("uses official 106-point face alignment rather than the legacy mouth-pixel composite", () => {
    const detector = source("deploy/latentsync/face_detector_insightface.py");
    const runner = source("deploy/latentsync/runner.py");

    expect(detector).toContain("FaceAnalysis");
    expect(detector).toContain('"landmark_2d_106"');
    expect(detector).toContain('"CPUExecutionProvider"');
    expect(runner).toContain("LipsyncPipeline");
    expect(runner).toContain("stage2_512.yaml");
    expect(runner).not.toContain("seamlessClone");
  });

  it("uses 25 fps internally but restores the exact LTX frame count, rate, resolution, and selected audio", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-latentsync-timeline-"));
    const sourceVideo = join(root, "source.mp4");
    const normalizedVideo = join(root, "normalized.mp4");
    const refinedVideo = join(root, "refined.mp4");
    const drivingAudio = join(root, "driving.wav");
    const restoredVideo = join(root, "restored.mp4");
    const restoredDrivingVideo = join(root, "restored-driving.mp4");
    const timelineScript = resolve(appRoot, "deploy/latentsync/timeline.py");
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
      run("python3", [
        timelineScript, "normalize",
        "--source", sourceVideo,
        "--output", normalizedVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-i", normalizedVideo,
        "-map", "0:v:0", "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p",
        refinedVideo,
      ]);
      run("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=16000:duration=2",
        "-af", `apad,atrim=duration=${97 / 24}`,
        "-c:a", "pcm_s16le", drivingAudio,
      ]);
      run("python3", [
        timelineScript, "restore",
        "--refined", refinedVideo,
        "--source", sourceVideo,
        "--output", restoredVideo,
      ]);
      run("python3", [
        timelineScript, "restore",
        "--refined", refinedVideo,
        "--source", sourceVideo,
        "--audio", drivingAudio,
        "--output", restoredDrivingVideo,
      ]);

      const normalized = JSON.parse(run("ffprobe", [
        "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate,nb_frames,width,height",
        "-of", "json", normalizedVideo,
      ])).streams[0];
      expect(normalized).toMatchObject({
        avg_frame_rate: "25/1",
        nb_frames: "101",
        width: 320,
        height: 240,
      });

      const restored = JSON.parse(run("ffprobe", [
        "-v", "error",
        "-show_entries", "stream=codec_type,avg_frame_rate,nb_frames,width,height",
        "-of", "json", restoredVideo,
      ])).streams;
      expect(restored.find((stream: { codec_type: string }) => stream.codec_type === "video")).toMatchObject({
        avg_frame_rate: "24/1",
        nb_frames: "97",
        width: 320,
        height: 240,
      });
      expect(restored.some((stream: { codec_type: string }) => stream.codec_type === "audio")).toBe(true);
      expect(pcmPeak(restoredDrivingVideo, 0.25, 0.5)).toBeGreaterThan(1_000);
      expect(pcmPeak(restoredDrivingVideo, 3, 0.5)).toBeLessThan(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds the exact external audio window in the Studio job", () => {
    const adapter = source("scripts/latentsync-refiner.py");
    const jobs = source("server/jobs.ts");
    expect(adapter).toContain("prepare_driving_audio(");
    expect(adapter).toContain('parser.add_argument("--audio-start"');
    expect(adapter).toContain('parser.add_argument("--audio-duration"');
    expect(jobs).toContain("latentSyncArgs.push(...latentSyncAudioArgs)");
  });
});
