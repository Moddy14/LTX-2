import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureRawMuxPairFile } from "../server/rawMuxBaselineAuthority.js";
import {
  expectedRawMuxTimelineReplayCommand,
  RAW_MUX_REPLAY_TIMELINE_LIMITS,
  validRawMuxReplayTimeline,
  verifyRawMuxTimelineReplay,
  type RawMuxReplayTimeline,
  type RawMuxTimelineReplayFiles,
} from "../server/rawMuxTimelineReplay.js";

const roots: string[] = [];
const TIMELINE: RawMuxReplayTimeline = {
  frameRate: "25/1",
  frameCount: 5,
  width: 64,
  height: 64,
  hasAudio: true,
};

function runFfmpeg(argv: readonly string[]): void {
  execFileSync("/usr/bin/ffmpeg", argv, { stdio: ["ignore", "ignore", "pipe"] });
}

function makeSource(path: string): void {
  runFfmpeg([
    "-v", "error", "-n",
    "-f", "lavfi", "-i", "testsrc2=s=64x64:r=25:d=0.2",
    "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000:duration=0.2",
    "-map", "0:v:0", "-map", "1:a:0", "-frames:v", "5",
    "-c:v", "libx264", "-crf", "13", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", path,
  ]);
}

function makeRaw(path: string, color: "blue" | "red"): void {
  runFfmpeg([
    "-v", "error", "-n",
    "-f", "lavfi", "-i", `color=c=${color}:s=64x64:r=25:d=0.2`,
    "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000:duration=0.2",
    "-map", "0:v:0", "-map", "1:a:0", "-frames:v", "5",
    "-c:v", "libx264", "-crf", color === "blue" ? "18" : "13", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", path,
  ]);
}

function makeProgramAudio(path: string, frequency = 440): void {
  runFfmpeg([
    "-v", "error", "-n", "-f", "lavfi", "-i",
    `sine=frequency=${frequency}:sample_rate=48000:duration=0.2`,
    "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", path,
  ]);
}

function makeExpectedFinal(input: {
  refined: string;
  source: string;
  programAudio: string;
  output: string;
  delayMs: number;
}): void {
  const command = expectedRawMuxTimelineReplayCommand({
    timeline: TIMELINE,
    programAudioDelayMs: input.delayMs,
    refinedFdPath: "/proc/self/fd/4",
    sourceFdPath: "/proc/self/fd/5",
    programAudioFdPath: "/proc/self/fd/6",
    outputPath: input.output,
  });
  const replacements = new Map([
    ["/proc/self/fd/4", input.refined],
    ["/proc/self/fd/5", input.source],
    ["/proc/self/fd/6", input.programAudio],
  ]);
  runFfmpeg(command.slice(1).map((argument) => replacements.get(argument) ?? argument));
}

type Fixture = {
  root: string;
  verificationRoot: string;
  paths: {
    baselineRaw: string;
    candidateRaw: string;
    ltxBase: string;
    programAudio: string;
    baselineFinal: string;
    candidateFinal: string;
  };
  files: RawMuxTimelineReplayFiles;
  delayMs: number;
};

function bindFixturePaths(paths: Fixture["paths"]): RawMuxTimelineReplayFiles {
  for (const path of Object.values(paths)) chmodSync(path, 0o400);
  return {
    baselineRaw: captureRawMuxPairFile(paths.baselineRaw),
    candidateRaw: captureRawMuxPairFile(paths.candidateRaw),
    ltxBase: captureRawMuxPairFile(paths.ltxBase),
    programAudio: captureRawMuxPairFile(paths.programAudio),
    baselineFinal: captureRawMuxPairFile(paths.baselineFinal),
    candidateFinal: captureRawMuxPairFile(paths.candidateFinal),
  };
}

function fixture(delayMs = 0): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ltx-timeline-replay-test-"));
  roots.push(root);
  const verificationRoot = join(root, "verification");
  mkdirSync(verificationRoot, { mode: 0o700 });
  const paths = {
    baselineRaw: join(root, "baseline-raw.mp4"),
    candidateRaw: join(root, "candidate-raw.mp4"),
    ltxBase: join(root, "ltx-base.mp4"),
    programAudio: join(root, "program-audio.wav"),
    baselineFinal: join(root, "baseline-final.mp4"),
    candidateFinal: join(root, "candidate-final.mp4"),
  };
  makeSource(paths.ltxBase);
  makeRaw(paths.baselineRaw, "blue");
  makeRaw(paths.candidateRaw, "red");
  makeProgramAudio(paths.programAudio);
  makeExpectedFinal({
    refined: paths.baselineRaw,
    source: paths.ltxBase,
    programAudio: paths.programAudio,
    output: paths.baselineFinal,
    delayMs,
  });
  makeExpectedFinal({
    refined: paths.candidateRaw,
    source: paths.ltxBase,
    programAudio: paths.programAudio,
    output: paths.candidateFinal,
    delayMs,
  });
  return { root, verificationRoot, paths, files: bindFixturePaths(paths), delayMs };
}

function verify(subject: Fixture, overrides: Partial<Parameters<typeof verifyRawMuxTimelineReplay>[0]> = {}) {
  return verifyRawMuxTimelineReplay({
    verificationRoot: subject.verificationRoot,
    files: subject.files,
    timeline: TIMELINE,
    programAudioDelayMs: subject.delayMs,
    timeoutMs: 30_000,
    ...overrides,
  });
}

function replaceFinalWithProfile(
  subject: Fixture,
  profile: "extra-stream" | "codec" | "pixfmt" | "samplerate",
): void {
  const original = `${subject.paths.baselineFinal}.original`;
  chmodSync(subject.paths.baselineFinal, 0o600);
  renameSync(subject.paths.baselineFinal, original);
  if (profile === "extra-stream") {
    const subtitle = join(subject.root, "extra.srt");
    writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:00,100\nextra\n", "utf8");
    runFfmpeg([
      "-v", "error", "-n", "-i", original, "-i", subtitle,
      "-map", "0:v:0", "-map", "0:a:0", "-map", "1:s:0",
      "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", subject.paths.baselineFinal,
    ]);
  } else {
    const video = profile === "codec"
      ? ["-c:v", "mpeg4", "-pix_fmt", "yuv420p"]
      : profile === "pixfmt"
        ? ["-c:v", "libx264", "-pix_fmt", "yuv444p"]
        : ["-c:v", "libx264", "-pix_fmt", "yuv420p"];
    const audio = profile === "samplerate"
      ? ["-c:a", "aac", "-ar", "44100"]
      : ["-c:a", "aac", "-ar", "48000"];
    runFfmpeg([
      "-v", "error", "-n", "-i", original,
      "-map", "0:v:0", "-map", "0:a:0", ...video, ...audio,
      subject.paths.baselineFinal,
    ]);
  }
  chmodSync(original, 0o400);
  chmodSync(subject.paths.baselineFinal, 0o400);
  subject.files.baselineFinal = captureRawMuxPairFile(subject.paths.baselineFinal);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("raw mux timeline replay", () => {
  it("replays both arms deterministically through held FDs and removes all temporary outputs", () => {
    const subject = fixture(150);
    const first = verify(subject, { replayId: "1".repeat(32) });
    const second = verify(subject, { replayId: "2".repeat(32) });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: "ltx-studio-raw-mux-timeline-replay.v1",
      timeline: TIMELINE,
      programAudioDelayMs: 150,
      baselineFinalSha256: subject.files.baselineFinal.sha256,
      candidateFinalSha256: subject.files.candidateFinal.sha256,
    });
    expect(readdirSync(subject.verificationRoot)).toEqual([]);
  });

  it("reconstructs the exact registered positive, negative, and zero-delay grammar", () => {
    const command = (delay: number) => expectedRawMuxTimelineReplayCommand({
      timeline: TIMELINE,
      programAudioDelayMs: delay,
      refinedFdPath: "/proc/self/fd/4",
      sourceFdPath: "/proc/self/fd/5",
      programAudioFdPath: "/proc/self/fd/6",
      outputPath: "/tmp/replay.mp4",
    });
    expect(command(150)).toContain(
      "adelay=150:all=1,aresample=48000,apad,atrim=duration=0.200000000,asetpts=PTS-STARTPTS",
    );
    expect(command(-125)).toContain(
      "atrim=start=0.125000000,asetpts=PTS-STARTPTS,aresample=48000,apad,atrim=duration=0.200000000,asetpts=PTS-STARTPTS",
    );
    expect(command(0)).toContain(
      "aresample=48000,apad,atrim=duration=0.200000000,asetpts=PTS-STARTPTS",
    );
    expect(command(0)).toEqual([
      "/usr/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-n",
      "-i", "/proc/self/fd/4", "-i", "/proc/self/fd/5", "-i", "/proc/self/fd/6",
      "-map", "0:v:0", "-map", "2:a:0",
      "-vf", "fps=fps=25/1:round=near,tpad=stop_mode=clone:stop_duration=2,trim=end_frame=5,setpts=N/(25/1*TB)",
      "-frames:v", "5", "-c:v", "libx264", "-preset", "medium", "-crf", "8",
      "-pix_fmt", "yuv420p",
      "-af", "aresample=48000,apad,atrim=duration=0.200000000,asetpts=PTS-STARTPTS",
      "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "/tmp/replay.mp4",
    ]);
  });

  it("rejects timelines outside the GenerationRequest resource limits before FFmpeg", () => {
    expect(RAW_MUX_REPLAY_TIMELINE_LIMITS).toEqual({
      maxFrameCount: 2_049,
      maxWidth: 4_096,
      maxHeight: 4_096,
      minFrameRate: 1,
      maxFrameRate: 120,
    });
    expect(validRawMuxReplayTimeline({
      frameRate: "120/1",
      frameCount: 2_049,
      width: 4_096,
      height: 4_096,
      hasAudio: true,
    })).toBe(true);
    expect(validRawMuxReplayTimeline({ ...TIMELINE, frameRate: "24000/1001" })).toBe(true);

    const invalidTimelines: RawMuxReplayTimeline[] = [
      { ...TIMELINE, frameCount: 2_050 },
      { ...TIMELINE, width: 4_097 },
      { ...TIMELINE, height: 4_097 },
      { ...TIMELINE, frameRate: "121/1" },
      { ...TIMELINE, frameRate: "1/2" },
      { ...TIMELINE, frameRate: "9007199254740992/1" },
      { ...TIMELINE, frameRate: `${"1".repeat(1_000)}/1` },
    ];
    for (const timeline of invalidTimelines) {
      expect(validRawMuxReplayTimeline(timeline)).toBe(false);
      expect(() => expectedRawMuxTimelineReplayCommand({
        timeline,
        programAudioDelayMs: 0,
        refinedFdPath: "/proc/self/fd/4",
        sourceFdPath: "/proc/self/fd/5",
        programAudioFdPath: "/proc/self/fd/6",
        outputPath: "/tmp/replay.mp4",
      })).toThrow(/GenerationRequest-Grenzen/u);
    }
  });

  it("rejects cross-spliced and self-consistently rebound fake finals", () => {
    const crossSplice = fixture();
    expect(() => verify(crossSplice, {
      files: {
        ...crossSplice.files,
        baselineFinal: crossSplice.files.candidateFinal,
        candidateFinal: crossSplice.files.baselineFinal,
      },
    })).toThrow();

    const fake = fixture();
    chmodSync(fake.paths.baselineFinal, 0o600);
    copyFileSync(fake.paths.candidateFinal, fake.paths.baselineFinal);
    chmodSync(fake.paths.baselineFinal, 0o400);
    fake.files.baselineFinal = captureRawMuxPairFile(fake.paths.baselineFinal);
    expect(() => verify(fake)).toThrow(/Baseline.*byteidentisch/u);
  });

  it("rejects a different program audio, delay, or source timeline", () => {
    const subject = fixture();
    const wrongAudio = join(subject.root, "wrong-audio.wav");
    makeProgramAudio(wrongAudio, 880);
    chmodSync(wrongAudio, 0o400);
    expect(() => verify(subject, {
      files: { ...subject.files, programAudio: captureRawMuxPairFile(wrongAudio) },
    })).toThrow(/byteidentisch/u);
    expect(() => verify(subject, { programAudioDelayMs: 125 })).toThrow(/byteidentisch/u);
    expect(() => verify(subject, {
      timeline: { ...TIMELINE, frameCount: 4 },
    })).toThrow(/abweichende Timeline/u);
  });

  it("rejects symlinks, hardlinks, in-place drift, and path replacement", () => {
    const symlinked = fixture();
    const realRaw = `${symlinked.paths.baselineRaw}.real`;
    renameSync(symlinked.paths.baselineRaw, realRaw);
    symlinkSync(realRaw, symlinked.paths.baselineRaw);
    expect(() => verify(symlinked, {
      files: {
        ...symlinked.files,
        baselineRaw: { ...symlinked.files.baselineRaw, path: symlinked.paths.baselineRaw },
      },
    })).toThrow();

    const hardlinked = fixture();
    linkSync(hardlinked.paths.baselineRaw, `${hardlinked.paths.baselineRaw}.link`);
    expect(() => verify(hardlinked)).toThrow(/driftete/u);

    const inPlace = fixture();
    chmodSync(inPlace.paths.baselineRaw, 0o600);
    appendFileSync(inPlace.paths.baselineRaw, Buffer.from([0]));
    chmodSync(inPlace.paths.baselineRaw, 0o400);
    expect(() => verify(inPlace)).toThrow(/driftete/u);

    const swapped = fixture();
    renameSync(swapped.paths.baselineRaw, `${swapped.paths.baselineRaw}.original`);
    copyFileSync(swapped.paths.candidateRaw, swapped.paths.baselineRaw);
    chmodSync(swapped.paths.baselineRaw, 0o400);
    expect(() => verify(swapped)).toThrow(/driftete/u);
  });

  it.each(["extra-stream", "codec", "pixfmt", "samplerate"] as const)(
    "rejects a final with the invalid %s profile",
    (profile) => {
      const subject = fixture();
      replaceFinalWithProfile(subject, profile);
      expect(() => verify(subject)).toThrow(/Finalprofil|exakt eine Video/u);
      expect(readdirSync(subject.verificationRoot)).toEqual([]);
    },
  );

  it("never overwrites or removes an existing replay directory or output", () => {
    const subject = fixture();
    const replayId = "a".repeat(32);
    const existingDirectory = join(
      subject.verificationRoot,
      `.raw-mux-timeline-replay-${replayId}`,
    );
    mkdirSync(existingDirectory, { mode: 0o700 });
    const marker = join(existingDirectory, "baseline-final-replay.mp4");
    writeFileSync(marker, "foreign", { mode: 0o600 });

    expect(() => verify(subject, { replayId })).toThrow();
    expect(readFileSync(marker, "utf8")).toBe("foreign");
  });

  it("keeps FFmpeg on the held directory FD when the visible path is renamed and replaced", () => {
    const subject = fixture();
    const replayId = "b".repeat(32);
    const visibleDirectory = join(
      subject.verificationRoot,
      `.raw-mux-timeline-replay-${replayId}`,
    );
    const movedDirectory = `${visibleDirectory}.moved`;
    const marker = join(visibleDirectory, "foreign-marker.txt");
    const done = join(subject.root, "attacker-done");
    const attacker = spawn(process.execPath, [
      "-e",
      `const fs=require("node:fs");
const [visible,moved,marker,done]=process.argv.slice(1);
let attempts=0;
const timer=setInterval(()=>{
  attempts+=1;
  if(fs.existsSync(visible)){
    try{
      fs.renameSync(visible,moved);
      fs.mkdirSync(visible,{mode:0o700});
      fs.writeFileSync(marker,"foreign");
      fs.writeFileSync(done,"done");
      clearInterval(timer);
    }catch{}
  }
  if(attempts>5000){fs.writeFileSync(done,"timeout");clearInterval(timer);}
},1);`,
      visibleDirectory,
      movedDirectory,
      marker,
      done,
    ], { stdio: "ignore" });

    expect(() => verify(subject, { replayId })).toThrow(/Verzeichnispfad|fail-closed/u);
    const deadline = Date.now() + 2_000;
    while (!existsSync(done) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    if (!existsSync(done)) attacker.kill("SIGKILL");
    expect(readFileSync(marker, "utf8")).toBe("foreign");
    expect(readdirSync(visibleDirectory)).toEqual(["foreign-marker.txt"]);
  });

  it("removes only its own partial outputs after FFmpeg failure", () => {
    const subject = fixture();
    chmodSync(subject.paths.candidateRaw, 0o600);
    writeFileSync(subject.paths.candidateRaw, "not a media file");
    chmodSync(subject.paths.candidateRaw, 0o400);
    subject.files.candidateRaw = captureRawMuxPairFile(subject.paths.candidateRaw);

    expect(() => verify(subject, { replayId: "f".repeat(32) })).toThrow(/FFmpeg/u);
    expect(readdirSync(subject.verificationRoot)).toEqual([]);
  });
});
