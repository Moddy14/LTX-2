import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appRoot, pythonExecutable } from "../server/config.js";

function runSyntheticLag(
  lagSeconds: number,
  durationSeconds = 6,
): Record<string, number | boolean> | null {
  const scriptRoot = join(appRoot, "scripts");
  const centers = durationSeconds <= 2.1
    ? [0.56, 0.83, 1.17, 1.43]
    : [0.62, 1.13, 1.91, 2.35, 3.28, 4.11, 5.06];
  const code = [
    "import json, numpy as np",
    "from av_sync_proxy import estimate_lag",
    `audio_times = np.arange(0, ${durationSeconds}, 0.01)`,
    `centers = ${JSON.stringify(centers)}`,
    "audio_onset = sum(np.exp(-0.5 * ((audio_times - center) / 0.025) ** 2) for center in centers)",
    `mouth_times = np.arange(0.04, ${durationSeconds - 0.04}, 1 / 24)`,
    `mouth_flow = np.interp(mouth_times - (${lagSeconds}), audio_times, audio_onset)`,
    "mouth_flow += 0.01 * np.sin(mouth_times * 17)",
    "mouth_appearance = mouth_flow * 0.82 + 0.02 * np.cos(mouth_times * 11)",
    "activity = (audio_onset > 0.02).astype(float)",
    "activity = (np.convolve(activity, np.ones(11), mode='same') > 0).astype(float)",
    "result = estimate_lag(mouth_times, mouth_flow, mouth_appearance, audio_times, audio_onset, activity)",
    "print(json.dumps(result))",
  ].join("\n");
  const result = spawnSync(pythonExecutable, ["-c", code], {
    cwd: scriptRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, number | boolean> | null;
}

describe("checkpoint-free AV motion proxy", () => {
  it.each([
    { lagSeconds: 0.18, expectedMilliseconds: 180 },
    { lagSeconds: -0.12, expectedMilliseconds: -120 },
  ])("recovers a signed synthetic lag within one effective video sample", ({
    lagSeconds,
    expectedMilliseconds,
  }) => {
    const result = runSyntheticLag(lagSeconds);

    expect(result).not.toBeNull();
    expect(Math.abs(Number(result!.estimatedAudioLeadMilliseconds) - expectedMilliseconds)).toBeLessThanOrEqual(45);
    expect(result!.validated).toBe(true);
    expect(Number(result!.correlationPeak)).toBeGreaterThan(0.9);
    expect(Number(result!.peakProminence)).toBeGreaterThan(0.5);
    expect(Number(result!.peakWidthMilliseconds)).toBeLessThanOrEqual(126);
    expect(Number(result!.lagResolutionMilliseconds)).toBeGreaterThanOrEqual(41);
  });

  it("refuses a static mouth signal", () => {
    const scriptRoot = join(appRoot, "scripts");
    const code = [
      "import json, numpy as np",
      "from av_sync_proxy import estimate_lag",
      "times = np.arange(0, 4, 0.01)",
      "mouth_times = np.arange(0.04, 3.96, 1 / 24)",
      "static = np.ones_like(mouth_times)",
      "print(json.dumps(estimate_lag(mouth_times, static, static, times, np.sin(times) ** 2, np.ones_like(times))))",
    ].join("\n");
    const result = spawnSync(pythonExecutable, ["-c", code], {
      cwd: scriptRoot,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toBeNull();
  });

  it("can validate an unambiguous two-second calibration clip", () => {
    const result = runSyntheticLag(0.08, 2.04);

    expect(result).not.toBeNull();
    expect(result!.validated).toBe(true);
    expect(Math.abs(Number(result!.estimatedAudioLeadMilliseconds) - 80)).toBeLessThanOrEqual(42);
    expect(Number(result!.usableWindowCount)).toBeGreaterThanOrEqual(2);
  });

  it("rejects independent sparse mouth events under a circular-shift null model", () => {
    const scriptRoot = join(appRoot, "scripts");
    const code = [
      "import json, numpy as np",
      "from av_sync_proxy import estimate_lag",
      "rng = np.random.default_rng(7)",
      "audio_times = np.arange(0, 6, 0.01)",
      "mouth_times = np.arange(0.04, 5.96, 1 / 24)",
      "accepted = 0",
      "trials = 100",
      "for _ in range(trials):",
      "    audio_centers = rng.uniform(0.6, 5.4, size=8)",
      "    mouth_centers = rng.uniform(0.6, 5.4, size=8)",
      "    audio = sum(np.exp(-0.5 * ((audio_times - center) / 0.025) ** 2) for center in audio_centers)",
      "    flow = sum(np.exp(-0.5 * ((mouth_times - center) / 0.035) ** 2) for center in mouth_centers)",
      "    appearance = flow * 0.8 + rng.normal(0, 0.02, size=mouth_times.size)",
      "    activity = (audio > 0.02).astype(float)",
      "    activity = (np.convolve(activity, np.ones(11), mode='same') > 0).astype(float)",
      "    result = estimate_lag(mouth_times, flow, appearance, audio_times, audio, activity)",
      "    accepted += int(result is not None and result['validated'])",
      "print(json.dumps({'accepted': accepted, 'trials': trials}))",
    ].join("\n");
    const result = spawnSync(pythonExecutable, ["-c", code], {
      cwd: scriptRoot,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as { accepted: number; trials: number };
    expect(summary.trials).toBe(100);
    expect(summary.accepted).toBeLessThanOrEqual(5);
  });

  it("measures a calibrated AAC clip through the real decode and optical-flow path", () => {
    const scriptRoot = join(appRoot, "scripts");
    const code = [
      "import json, subprocess, tempfile, wave",
      "from pathlib import Path",
      "import cv2, numpy as np",
      "from av_sync_proxy import analyze_audio_motion_sync, decode_audio_features",
      "rng = np.random.default_rng(8128)",
      "duration = 6.0",
      "sample_rate = 16000",
      "sample_times = np.arange(int(duration * sample_rate)) / sample_rate",
      "control_times = [0.0, 0.35]",
      "cursor = 0.35",
      "while cursor < 5.55:",
      "    cursor += float(rng.uniform(0.12, 0.31))",
      "    control_times.append(min(cursor, 5.55))",
      "control_times += [5.65, 6.0]",
      "levels = np.asarray([0.0, 0.0] + rng.uniform(0.18, 0.95, len(control_times) - 4).tolist() + [0.0, 0.0])",
      "envelope = np.interp(sample_times, control_times, levels)",
      "samples = envelope * (0.72 * np.sin(2 * np.pi * 211 * sample_times) + 0.18 * np.sin(2 * np.pi * 397 * sample_times))",
      "pcm = np.int16(np.clip(samples, -1.0, 1.0) * 30000)",
      "with tempfile.TemporaryDirectory() as directory:",
      "    root = Path(directory)",
      "    wave_path = root / 'calibration.wav'",
      "    video_path = root / 'calibration.mp4'",
      "    with wave.open(str(wave_path), 'wb') as output:",
      "        output.setnchannels(1)",
      "        output.setsampwidth(2)",
      "        output.setframerate(sample_rate)",
      "        output.writeframes(pcm.tobytes())",
      "    mux = subprocess.run([",
      "        'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',",
      "        f'color=c=black:s=96x96:r=24:d={duration}', '-i', str(wave_path),",
      "        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',",
      "        '-shortest', str(video_path),",
      "    ], check=False, capture_output=True)",
      "    if mux.returncode != 0:",
      "        raise RuntimeError(mux.stderr.decode('utf-8', errors='replace'))",
      "    audio_times, audio_onset, _audio_activity = decode_audio_features(video_path, 0.0)",
      "    frames_per_second = 24",
      "    frame_count = int(duration * frames_per_second) + 1",
      "    injected_lag = 2 / frames_per_second",
      "    base = np.full((96, 96), 105, dtype=np.uint8)",
      "    rows, columns = np.indices((37, 64))",
      "    noise = rng.integers(20, 235, size=(37, 64), dtype=np.uint8)",
      "    texture = ((noise.astype(float) * 0.45 + rows * 5 + columns * 3) % 215 + 20).astype(np.uint8)",
      "    base[53:90, 16:80] = texture",
      "    state = 0.0",
      "    direction = 1.0",
      "    candidates = []",
      "    for frame_index in range(frame_count):",
      "        timestamp = frame_index / frames_per_second",
      "        patch = base.copy()",
      "        if frame_index > 0:",
      "            midpoint = (frame_index - 0.5) / frames_per_second",
      "            strength = float(np.interp(midpoint - injected_lag, audio_times, audio_onset, left=0.0, right=0.0))",
      "            delta = direction * (0.28 + 1.3 * strength) if strength > 0.03 else 0.0",
      "            if not -5.0 <= state + delta <= 5.0:",
      "                direction *= -1.0",
      "                delta = direction * (0.28 + 1.3 * strength)",
      "            state += delta",
      "        transform = np.asarray([[1.0, 0.0, 0.0], [0.0, 1.0, state]], dtype=np.float32)",
      "        patch[53:90, 16:80] = cv2.warpAffine(",
      "            texture, transform, (64, 37), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT_101,",
      "        )",
      "        candidates.append({'timestamp': timestamp, 'stabilized_patch': patch})",
      "    result = analyze_audio_motion_sync(video_path, candidates, frame_count, duration, True, 0.0)",
      "    print(json.dumps(result))",
    ].join("\n");
    const result = spawnSync(pythonExecutable, ["-c", code], {
      cwd: scriptRoot,
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    const analysis = JSON.parse(result.stdout) as Record<string, number | string | null>;
    expect(analysis.status).toBe("measured");
    expect(analysis.error).toBeNull();
    expect(Math.abs(Number(analysis.estimatedAudioLeadMilliseconds) - 83)).toBeLessThanOrEqual(42);
    expect(Number(analysis.validMotionPairs)).toBe(144);
    expect(Number(analysis.motionCoverage)).toBe(1);
    expect(Number(analysis.usableWindowCount)).toBeGreaterThanOrEqual(2);
    expect(Number(analysis.windowLagIqrMilliseconds)).toBeLessThanOrEqual(42);
    expect(Number(analysis.correlationPeak)).toBeGreaterThan(Number(analysis.nullP95Correlation) + 0.03);
  }, 35_000);
});
