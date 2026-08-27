import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { captureRawMuxPairFile } from "../server/rawMuxBaselineAuthority.js";
import {
  expectedRawMuxRawReplayCommand,
  validRawMuxDurationArg,
  verifyRawMuxRawReplay,
  type RawMuxRawReplayFiles,
  type RawMuxRawReplayReceipt,
} from "../server/rawMuxRawReplay.js";

const roots: string[] = [];

function ffmpeg(argv: readonly string[]): void {
  execFileSync("/usr/bin/ffmpeg", argv, { stdio: ["ignore", "ignore", "pipe"] });
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function commandSha256(argv: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(argv), "utf8").digest("hex");
}

function makePreMux(path: string): void {
  ffmpeg([
    "-v", "error", "-n", "-f", "lavfi", "-i", "testsrc2=s=64x64:r=25:d=0.2",
    "-frames:v", "5", "-c:v", "libx264", "-crf", "13", "-pix_fmt", "yuv420p",
    "-an", "-movflags", "+faststart", path,
  ]);
}

function makeAudio(path: string, frequency = 440): void {
  ffmpeg([
    "-v", "error", "-n", "-f", "lavfi", "-i",
    `sine=frequency=${frequency}:sample_rate=16000:duration=0.2`,
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path,
  ]);
}

function makeRaw(input: {
  arm: "baseline" | "candidate";
  preMux: string;
  audio: string;
  output: string;
  durationArg: string | null;
}): void {
  const command = expectedRawMuxRawReplayCommand({
    arm: input.arm,
    durationArg: input.durationArg,
    preMuxFdPath: "/proc/self/fd/4",
    audioFdPath: "/proc/self/fd/5",
    outputPath: input.output,
  });
  const replacements = new Map([
    ["/proc/self/fd/4", input.preMux],
    ["/proc/self/fd/5", input.audio],
  ]);
  ffmpeg(command.slice(1).map((argument) => replacements.get(argument) ?? argument));
}

type Fixture = {
  root: string;
  verificationRoot: string;
  paths: { preMux: string; audio: string; baselineRaw: string; candidateRaw: string };
  files: RawMuxRawReplayFiles;
  receipt: RawMuxRawReplayReceipt;
};

function bind(paths: Fixture["paths"]): RawMuxRawReplayFiles {
  for (const path of Object.values(paths)) chmodSync(path, 0o400);
  return {
    preMux: captureRawMuxPairFile(paths.preMux),
    audio: captureRawMuxPairFile(paths.audio),
    baselineRaw: captureRawMuxPairFile(paths.baselineRaw),
    candidateRaw: captureRawMuxPairFile(paths.candidateRaw),
  };
}

function fixture(durationArg: string | null = null): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ltx-raw-exact-replay-test-"));
  roots.push(root);
  const verificationRoot = join(root, "verification");
  mkdirSync(verificationRoot, { mode: 0o700 });
  const paths = {
    preMux: join(root, "pre-mux.mp4"),
    audio: join(root, "control.wav"),
    baselineRaw: join(root, "baseline-raw.mp4"),
    candidateRaw: join(root, "candidate-raw.mp4"),
  };
  makePreMux(paths.preMux);
  makeAudio(paths.audio);
  makeRaw({ arm: "baseline", ...paths, output: paths.baselineRaw, durationArg });
  makeRaw({ arm: "candidate", ...paths, output: paths.candidateRaw, durationArg });
  const files = bind(paths);
  const baselineCommand = expectedRawMuxRawReplayCommand({
    arm: "baseline",
    durationArg,
    preMuxFdPath: "/proc/self/fd/11",
    audioFdPath: "/proc/self/fd/12",
    outputPath: "/proc/self/fd/13/baseline-raw.mp4",
  });
  const candidateCommand = expectedRawMuxRawReplayCommand({
    arm: "candidate",
    durationArg,
    preMuxFdPath: "/proc/self/fd/11",
    audioFdPath: "/proc/self/fd/12",
    outputPath: "/proc/self/fd/13/candidate-raw.mp4",
  });
  const receipt: RawMuxRawReplayReceipt = {
    schemaVersion: "ltx-studio-lipforcing-raw-mux-pair-receipt.v1",
    profiles: {
      baseline: "h264-crf13-mux-crf18-v1",
      candidate: "h264-crf13-mux-copy-v1",
    },
    durationArg,
    ffmpeg: {
      path: "/usr/bin/ffmpeg",
      sha256: sha256("/usr/bin/ffmpeg"),
      version: execFileSync("/usr/bin/ffmpeg", ["-version"], { encoding: "utf8" }).split(/\r?\n/u)[0],
    },
    inputs: {
      preMuxSourceSha256: files.preMux.sha256,
      preMuxExportSha256: files.preMux.sha256,
      preMuxSizeBytes: files.preMux.revision.sizeBytes,
      audioSha256: files.audio.sha256,
      audioSizeBytes: files.audio.revision.sizeBytes,
    },
    commands: {
      baseline: { argv: baselineCommand, sha256: commandSha256(baselineCommand) },
      candidate: { argv: candidateCommand, sha256: commandSha256(candidateCommand) },
    },
    outputs: {
      baselineRaw: {
        sha256: files.baselineRaw.sha256,
        sizeBytes: files.baselineRaw.revision.sizeBytes,
      },
      candidateRaw: {
        sha256: files.candidateRaw.sha256,
        sizeBytes: files.candidateRaw.revision.sizeBytes,
      },
    },
  };
  return { root, verificationRoot, paths, files, receipt };
}

function verify(subject: Fixture, overrides: Partial<Parameters<typeof verifyRawMuxRawReplay>[0]> = {}) {
  return verifyRawMuxRawReplay({
    verificationRoot: subject.verificationRoot,
    files: subject.files,
    receipt: subject.receipt,
    timeoutMs: 30_000,
    ...overrides,
  });
}

function updateOutputReceipt(subject: Fixture, arm: "baseline" | "candidate"): void {
  const file = arm === "baseline" ? subject.files.baselineRaw : subject.files.candidateRaw;
  const key = arm === "baseline" ? "baselineRaw" : "candidateRaw";
  subject.receipt.outputs[key] = { sha256: file.sha256, sizeBytes: file.revision.sizeBytes };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("raw mux exact replay", () => {
  it("replays both registered raw arms byte-identically and deterministically", () => {
    const subject = fixture("0.2000");
    const first = verify(subject, { replayId: "1".repeat(32) });
    const second = verify(subject, { replayId: "2".repeat(32) });
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: "ltx-studio-raw-mux-exact-replay.v1",
      ffmpegSha256: subject.receipt.ffmpeg.sha256,
      durationArg: "0.2000",
      baselineRawSha256: subject.files.baselineRaw.sha256,
      candidateRawSha256: subject.files.candidateRaw.sha256,
    });
    expect(readdirSync(subject.verificationRoot)).toEqual([]);
  });

  it("freezes the exact CRF18/copy plus AAC pair grammar", () => {
    const baseline = expectedRawMuxRawReplayCommand({
      arm: "baseline",
      durationArg: null,
      preMuxFdPath: "/proc/self/fd/4",
      audioFdPath: "/proc/self/fd/5",
      outputPath: "/proc/self/fd/6/baseline-raw.mp4",
    });
    const candidate = expectedRawMuxRawReplayCommand({
      arm: "candidate",
      durationArg: "0.2000",
      preMuxFdPath: "/proc/self/fd/4",
      audioFdPath: "/proc/self/fd/5",
      outputPath: "/proc/self/fd/6/candidate-raw.mp4",
    });
    expect(baseline).toEqual([
      "/usr/bin/ffmpeg", "-n", "-loglevel", "error", "-nostdin",
      "-i", "/proc/self/fd/4", "-i", "/proc/self/fd/5",
      "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-crf", "18",
      "-c:a", "aac", "-q:v", "0", "-q:a", "0", "/proc/self/fd/6/baseline-raw.mp4",
    ]);
    expect(candidate.slice(-3)).toEqual(["-t", "0.2000", "/proc/self/fd/6/candidate-raw.mp4"]);
    expect(candidate).toContain("copy");
  });

  it("bounds duration grammar to finite canonical values through 86400 seconds", () => {
    expect(validRawMuxDurationArg(null)).toBe(true);
    expect(validRawMuxDurationArg("0.0001")).toBe(true);
    expect(validRawMuxDurationArg("86400.0000")).toBe(true);
    expect(expectedRawMuxRawReplayCommand({
      arm: "candidate",
      durationArg: "86400.0000",
      preMuxFdPath: "/proc/self/fd/4",
      audioFdPath: "/proc/self/fd/5",
      outputPath: "/proc/self/fd/6/candidate-raw.mp4",
    })).toContain("86400.0000");
    for (const durationArg of [
      "Infinity",
      `${"9".repeat(400)}.0000`,
      "86400.0001",
      "90000.0000",
      "086400.0000",
      "86400",
      "0.0000",
    ]) {
      expect(validRawMuxDurationArg(durationArg)).toBe(false);
      expect(() => expectedRawMuxRawReplayCommand({
        arm: "candidate",
        durationArg,
        preMuxFdPath: "/proc/self/fd/4",
        audioFdPath: "/proc/self/fd/5",
        outputPath: "/proc/self/fd/6/candidate-raw.mp4",
      })).toThrow(/Grammatik/u);
    }
  });

  it("rejects an unbounded duration in the receipt before any replay", () => {
    const subject = fixture();
    subject.receipt.durationArg = "9".repeat(400) + ".0000";
    expect(() => verify(subject)).toThrow(/strukturell/u);
    expect(readdirSync(subject.verificationRoot)).toEqual([]);
  });

  it("rejects an unregistered command even after its digest is recomputed", () => {
    const subject = fixture();
    const argv = [...subject.receipt.commands.candidate.argv];
    argv.splice(-1, 0, "-c:v", "copy");
    subject.receipt.commands.candidate = { argv, sha256: commandSha256(argv) };
    expect(() => verify(subject)).toThrow(/Grammatik/u);
    expect(readdirSync(subject.verificationRoot)).toEqual([]);
  });

  it("rejects FFmpeg identity drift before replay", () => {
    const subject = fixture();
    subject.receipt.ffmpeg.sha256 = "0".repeat(64);
    expect(() => verify(subject)).toThrow(/FFmpeg.*Receipt/u);
  });

  it("rejects wrong inputs, cross-splices, and a coherently rebound fake raw", () => {
    const wrongInput = fixture();
    const otherAudio = join(wrongInput.root, "other.wav");
    makeAudio(otherAudio, 880);
    chmodSync(otherAudio, 0o400);
    expect(() => verify(wrongInput, {
      files: { ...wrongInput.files, audio: captureRawMuxPairFile(otherAudio) },
    })).toThrow(/Receipt/u);

    const crossSplice = fixture();
    expect(() => verify(crossSplice, {
      files: {
        ...crossSplice.files,
        baselineRaw: crossSplice.files.candidateRaw,
        candidateRaw: crossSplice.files.baselineRaw,
      },
    })).toThrow(/Receipt|byteidentisch/u);

    const fake = fixture();
    chmodSync(fake.paths.baselineRaw, 0o600);
    copyFileSync(fake.paths.candidateRaw, fake.paths.baselineRaw);
    chmodSync(fake.paths.baselineRaw, 0o400);
    fake.files.baselineRaw = captureRawMuxPairFile(fake.paths.baselineRaw);
    updateOutputReceipt(fake, "baseline");
    expect(() => verify(fake)).toThrow(/Baseline.*byteidentisch/u);
  });

  it("rejects symlink, hardlink, in-place, and visible-path substitutions", () => {
    const symlinked = fixture();
    const real = `${symlinked.paths.preMux}.real`;
    renameSync(symlinked.paths.preMux, real);
    symlinkSync(real, symlinked.paths.preMux);
    expect(() => verify(symlinked, {
      files: { ...symlinked.files, preMux: { ...symlinked.files.preMux, path: symlinked.paths.preMux } },
    })).toThrow();

    const hardlinked = fixture();
    linkSync(hardlinked.paths.audio, `${hardlinked.paths.audio}.link`);
    expect(() => verify(hardlinked)).toThrow(/driftete/u);

    const inPlace = fixture();
    chmodSync(inPlace.paths.preMux, 0o600);
    appendFileSync(inPlace.paths.preMux, Buffer.from([0]));
    chmodSync(inPlace.paths.preMux, 0o400);
    expect(() => verify(inPlace)).toThrow(/driftete/u);

    const replaced = fixture();
    renameSync(replaced.paths.audio, `${replaced.paths.audio}.original`);
    copyFileSync(replaced.paths.preMux, replaced.paths.audio);
    chmodSync(replaced.paths.audio, 0o400);
    expect(() => verify(replaced)).toThrow(/driftete/u);
  });

  it.each(["extra-stream", "codec", "audio-codec"] as const)(
    "rejects the invalid %s raw stream profile",
    (profile) => {
      const subject = fixture();
      const original = `${subject.paths.baselineRaw}.original`;
      chmodSync(subject.paths.baselineRaw, 0o600);
      renameSync(subject.paths.baselineRaw, original);
      if (profile === "extra-stream") {
        const subtitle = join(subject.root, "extra.srt");
        writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:00,100\nextra\n", "utf8");
        ffmpeg([
          "-v", "error", "-n", "-i", original, "-i", subtitle,
          "-map", "0:v:0", "-map", "0:a:0", "-map", "1:s:0",
          "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", subject.paths.baselineRaw,
        ]);
      } else {
        ffmpeg([
          "-v", "error", "-n", "-i", original,
          "-map", "0:v:0", "-map", "0:a:0",
          "-c:v", profile === "codec" ? "mpeg4" : "libx264",
          "-c:a", profile === "audio-codec" ? "mp3" : "aac",
          subject.paths.baselineRaw,
        ]);
      }
      chmodSync(original, 0o400);
      chmodSync(subject.paths.baselineRaw, 0o400);
      subject.files.baselineRaw = captureRawMuxPairFile(subject.paths.baselineRaw);
      updateOutputReceipt(subject, "baseline");
      expect(() => verify(subject)).toThrow(/Streamprofil|Videoprofil/u);
      expect(readdirSync(subject.verificationRoot)).toEqual([]);
    },
  );

  it("does not overwrite or delete an existing replay directory", () => {
    const subject = fixture();
    const replayId = "a".repeat(32);
    const existing = join(subject.verificationRoot, `.raw-mux-exact-replay-${replayId}`);
    mkdirSync(existing, { mode: 0o700 });
    const marker = join(existing, "baseline-raw.mp4");
    writeFileSync(marker, "foreign", { mode: 0o600 });
    expect(() => verify(subject, { replayId })).toThrow();
    expect(readFileSync(marker, "utf8")).toBe("foreign");
  });

  it("keeps both raw outputs on the held directory after visible rename/replacement", () => {
    const subject = fixture();
    const replayId = "b".repeat(32);
    const visible = join(subject.verificationRoot, `.raw-mux-exact-replay-${replayId}`);
    const moved = `${visible}.moved`;
    const marker = join(visible, "foreign-marker.txt");
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
      fs.renameSync(visible,moved);fs.mkdirSync(visible,{mode:0o700});
      fs.writeFileSync(marker,"foreign");fs.writeFileSync(done,"done");clearInterval(timer);
    }catch{}
  }
  if(attempts>5000){fs.writeFileSync(done,"timeout");clearInterval(timer);}
},1);`,
      visible, moved, marker, done,
    ], { stdio: "ignore" });
    expect(() => verify(subject, { replayId })).toThrow(/Verzeichnispfad|fail-closed/u);
    const deadline = Date.now() + 2_000;
    while (!existsSync(done) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    if (!existsSync(done)) attacker.kill("SIGKILL");
    expect(readFileSync(marker, "utf8")).toBe("foreign");
    expect(readdirSync(visible)).toEqual(["foreign-marker.txt"]);
  });

  it("cleans outputs when a post-replay SHA comparison fails", () => {
    const subject = fixture();
    chmodSync(subject.paths.baselineRaw, 0o600);
    copyFileSync(subject.paths.candidateRaw, subject.paths.baselineRaw);
    chmodSync(subject.paths.baselineRaw, 0o400);
    subject.files.baselineRaw = captureRawMuxPairFile(subject.paths.baselineRaw);
    updateOutputReceipt(subject, "baseline");

    expect(() => verify(subject, { replayId: "f".repeat(32) }))
      .toThrow(/Baseline.*byteidentisch/u);
    expect(readdirSync(subject.verificationRoot)).toEqual([]);
    expect(statSync(subject.paths.baselineRaw).size).toBeGreaterThan(0);
  });
});
