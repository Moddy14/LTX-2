import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { buildFinalAudioRemuxArgs } from "../server/audioRemux.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function run(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 15_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return result.stdout;
}

describe("final audio remux", () => {
  it("keeps the rendered video stream and binds an aligned AAC final mix", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-audio-remux-"));
    roots.push(root);
    const video = join(root, "base.mp4");
    const finalMix = join(root, "mix.wav");
    const output = join(root, "output.tmp");
    const durationSeconds = 25 / 24;

    run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=64x64:rate=24",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=2",
      "-frames:v",
      "25",
      "-t",
      durationSeconds.toFixed(6),
      "-c:v",
      "mpeg4",
      "-c:a",
      "aac",
      video,
    ]);
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:duration=2",
      "-c:a",
      "pcm_s16le",
      finalMix,
    ]);

    run("ffmpeg", buildFinalAudioRemuxArgs({
      sourceAudioPath: finalMix,
      sourceStartTime: 0.25,
      sourceMaxDuration: durationSeconds,
      videoPath: video,
      outputPath: output,
    }));
    const probe = JSON.parse(run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name,codec_type,start_time,duration",
      "-of",
      "json",
      output,
    ])) as {
      format: { duration: string };
      streams: Array<{ codec_name: string; codec_type: string; start_time: string; duration: string }>;
    };

    expect(probe.streams.find((stream) => stream.codec_type === "video")?.codec_name).toBe("mpeg4");
    expect(probe.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({
      codec_name: "aac",
      start_time: "0.000000",
    });
    expect(Number.parseFloat(probe.format.duration)).toBeCloseTo(durationSeconds, 2);
  });

  it("ends at the actual composite video instead of a requested frame duration", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-audio-remux-short-video-"));
    roots.push(root);
    const video = join(root, "93-frame-composite.mp4");
    const finalMix = join(root, "mix.wav");
    const output = join(root, "output.tmp");
    const actualVideoDuration = 93 / 24;

    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc=size=64x64:rate=24",
      "-frames:v", "93",
      "-c:v", "mpeg4",
      video,
    ]);
    run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=5",
      "-c:a", "pcm_s16le",
      finalMix,
    ]);

    run("ffmpeg", buildFinalAudioRemuxArgs({
      sourceAudioPath: finalMix,
      sourceStartTime: 0,
      sourceMaxDuration: 97 / 24,
      videoPath: video,
      outputPath: output,
    }));
    const probe = JSON.parse(run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,duration",
      "-of", "json",
      output,
    ])) as {
      format: { duration: string };
      streams: Array<{ codec_type: string; duration: string }>;
    };
    const videoDuration = Number.parseFloat(
      probe.streams.find((stream) => stream.codec_type === "video")?.duration ?? "NaN",
    );
    const audioDuration = Number.parseFloat(
      probe.streams.find((stream) => stream.codec_type === "audio")?.duration ?? "NaN",
    );

    expect(videoDuration).toBeCloseTo(actualVideoDuration, 2);
    expect(Number.parseFloat(probe.format.duration)).toBeLessThan(97 / 24);
    expect(audioDuration - videoDuration).toBeLessThan(1 / 24);
  });

  it("rejects invalid timing before spawning ffmpeg", () => {
    const valid = {
      sourceAudioPath: "/input/mix.wav",
      sourceStartTime: 0,
      sourceMaxDuration: null,
      videoPath: "/input/video.mp4",
      outputPath: "/output/video.tmp",
    };
    expect(() => buildFinalAudioRemuxArgs({ ...valid, sourceStartTime: -1 })).toThrow("Startzeit");
    expect(() => buildFinalAudioRemuxArgs({ ...valid, sourceMaxDuration: 0 })).toThrow("Maximale Dauer");
  });
});
