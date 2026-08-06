import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const appRoot = resolve(process.cwd());

function run(executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("shared refiner audio window", () => {
  it("trims the selected source window and pads it to the exact LTX duration", () => {
    const root = mkdtempSync(join(tmpdir(), "ltx-refiner-audio-"));
    const sourceVideo = join(root, "source.mp4");
    const sourceAudio = join(root, "source.wav");
    const preparedAudio = join(root, "prepared.wav");
    const helperRoot = resolve(appRoot, "scripts");
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
        "-c:a", "pcm_s16le", sourceAudio,
      ]);
      run("python3", [
        "-c",
        [
          "import pathlib,sys",
          "sys.path.insert(0,sys.argv[1])",
          "from refiner_audio import prepare_driving_audio",
          "prepare_driving_audio(pathlib.Path(sys.argv[2]),pathlib.Path(sys.argv[3]),pathlib.Path(sys.argv[4]),1.0,2.0,'Test')",
        ].join(";"),
        helperRoot,
        sourceAudio,
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
});
