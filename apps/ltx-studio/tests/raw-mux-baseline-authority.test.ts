import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  captureRawMuxPairFile,
  createRawMuxBaselineAuthority,
  pinRawMuxCandidateArtifact,
  rawMuxCommandSha256,
  rawMuxPairPaths,
  readVerifiedRawMuxBaselineAuthority,
} from "../server/rawMuxBaselineAuthority.js";
import { appRoot } from "../server/config.js";
import {
  defaultLipForcingRawOutputProfile,
  experimentalLipForcingRawOutputProfile,
} from "../shared/pipelines.js";

const roots: string[] = [];

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function executableEvidence(path: "/usr/bin/ffmpeg" | "/usr/bin/ffprobe") {
  const version = execFileSync(path, ["-version"], { encoding: "utf8" }).split(/\r?\n/u)[0];
  return { path, sha256: sha256(path), version };
}

function compactCommand(argv: string[]) {
  return { argv, sha256: rawMuxCommandSha256(argv) };
}

function hashSize(path: string) {
  return { sha256: sha256(path), sizeBytes: statSync(path).size };
}

function receiptRevision(path: string) {
  const stats = statSync(path, { bigint: true });
  return {
    deviceId: stats.dev.toString(),
    fileId: stats.ino.toString(),
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    nlink: 1,
    modifiedAtNs: stats.mtimeNs.toString(),
    changedAtNs: stats.ctimeNs.toString(),
  };
}

function decodedPcmSha256(path: string): string {
  const pcm = execFileSync("/usr/bin/ffmpeg", [
    "-v", "error", "-i", path,
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000",
    "-f", "s16le", "pipe:1",
  ], { maxBuffer: 32 * 1024 * 1024 });
  return createHash("sha256").update(pcm).digest("hex");
}

function makeVideo(path: string, frequency = 440): void {
  execFileSync("/usr/bin/ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=25:d=0.2",
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=0.2`,
    "-map", "0:v:0", "-map", "1:a:0",
    "-frames:v", "5", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", path,
  ]);
}

function makePreMux(path: string): void {
  execFileSync("/usr/bin/ffmpeg", [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=s=64x64:r=25:d=0.2",
    "-frames:v", "5", "-c:v", "libx264", "-crf", "13", "-pix_fmt", "yuv420p",
    "-an", "-movflags", "+faststart", path,
  ]);
}

function makeWav(path: string): void {
  execFileSync("/usr/bin/ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i",
    "sine=frequency=440:sample_rate=16000:duration=0.2",
    "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path,
  ]);
}

function makeRawMux(
  preMux: string,
  audio: string,
  output: string,
  codec: "baseline" | "candidate" | "candidate-transcoded",
): void {
  const videoCodec = codec === "baseline"
    ? ["-c:v", "libx264", "-crf", "18"]
    : codec === "candidate-transcoded"
      ? ["-c:v", "libx264", "-crf", "13"]
      : ["-c:v", "copy"];
  execFileSync("/usr/bin/ffmpeg", [
    "-v", "error", "-y", "-i", preMux, "-i", audio,
    "-map", "0:v:0", "-map", "1:a:0", ...videoCodec,
    "-c:a", "aac", "-q:v", "0", "-q:a", "0", output,
  ]);
}

function makeTimelineFinal(
  refined: string,
  source: string,
  programAudio: string,
  output: string,
): void {
  execFileSync("/usr/bin/ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", refined, "-i", source, "-i", programAudio,
    "-map", "0:v:0", "-map", "2:a:0",
    "-vf", "fps=fps=25/1:round=near,tpad=stop_mode=clone:stop_duration=2,trim=end_frame=5,setpts=N/(25/1*TB)",
    "-frames:v", "5", "-c:v", "libx264", "-preset", "medium", "-crf", "8",
    "-pix_fmt", "yuv420p",
    "-af", "aresample=48000,apad,atrim=duration=0.200000000,asetpts=PTS-STARTPTS",
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
  ]);
}

type FixtureOptions = {
  falseTimeline?: boolean;
  falseCandidatePcm?: boolean;
  rawCandidateExtraCodec?: boolean;
  timelineCandidateExtraFlag?: boolean;
  packetCandidateDrift?: boolean;
  extraCandidateStream?: boolean;
};

function fixture(options: FixtureOptions = {}) {
  const stageRoot = mkdtempSync(join(tmpdir(), "ltx-raw-mux-authority-"));
  roots.push(stageRoot);
  const paths = rawMuxPairPaths(stageRoot);
  mkdirSync(paths.root, { mode: 0o700 });
  const baselineFinal = join(stageRoot, "baseline-final.mp4");
  makeVideo(paths.ltxBase);
  makePreMux(paths.preMux);
  chmodSync(paths.preMux, 0o400);
  makeWav(paths.programAudio);
  copyFileSync(paths.programAudio, paths.controlAudio);
  makeRawMux(paths.preMux, paths.controlAudio, paths.baselineRaw, "baseline");
  makeRawMux(
    paths.preMux,
    paths.controlAudio,
    paths.candidateRaw,
    options.packetCandidateDrift ? "candidate-transcoded" : "candidate",
  );
  if (options.extraCandidateStream) {
    const subtitle = join(stageRoot, "unexpected.srt");
    const withSubtitle = join(stageRoot, "candidate-with-subtitle.mp4");
    writeFileSync(subtitle, "1\n00:00:00,000 --> 00:00:00,100\nunexpected\n", "utf8");
    execFileSync("/usr/bin/ffmpeg", [
      "-v", "error", "-y", "-i", paths.candidateRaw, "-i", subtitle,
      "-map", "0:v:0", "-map", "0:a:0", "-map", "1:s:0",
      "-c:v", "copy", "-c:a", "copy", "-c:s", "mov_text", withSubtitle,
    ]);
    renameSync(withSubtitle, paths.candidateRaw);
  }
  makeTimelineFinal(paths.baselineRaw, paths.ltxBase, paths.programAudio, baselineFinal);
  if (options.falseCandidatePcm) {
    const candidateProgramAudio = join(stageRoot, "candidate-program-audio.wav");
    execFileSync("/usr/bin/ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i",
      "sine=frequency=880:sample_rate=16000:duration=0.2",
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", candidateProgramAudio,
    ]);
    makeTimelineFinal(paths.candidateRaw, paths.ltxBase, candidateProgramAudio, paths.candidateFinal);
  } else {
    makeTimelineFinal(paths.candidateRaw, paths.ltxBase, paths.programAudio, paths.candidateFinal);
  }

  const ffmpeg = executableEvidence("/usr/bin/ffmpeg");
  const ffprobe = executableEvidence("/usr/bin/ffprobe");
  const preMuxCopyCommand = [
    "ltx-studio-internal-held-fd-copy-v1",
    "--source", "/proc/self/fd/10",
    "--output", "/paired/pre-mux-crf13.mp4",
    "--exclusive",
  ];
  const preMuxReceipt = {
    schemaVersion: "ltx-studio-lipforcing-premux-export-receipt.v1",
    durationArg: null,
    source: { ...hashSize(paths.preMux), revision: receiptRevision(paths.preMux) },
    export: { ...hashSize(paths.preMux), revision: receiptRevision(paths.preMux) },
    byteIdentical: true,
    copy: {
      method: "python-os-read-write-held-fd-exclusive-v1",
      command: compactCommand(preMuxCopyCommand),
    },
    code: {
      rawOutputMuxSha256: sha256(join(appRoot, "deploy", "lipforcing", "raw_output_mux.py")),
      containerRunnerSha256: sha256(join(appRoot, "deploy", "lipforcing", "container_runner.py")),
    },
  };
  writeFileSync(paths.preMuxReceipt, `${JSON.stringify(preMuxReceipt)}\n`, { mode: 0o400 });
  const rawBaselineCommand = [
    "/usr/bin/ffmpeg", "-n", "-loglevel", "error", "-nostdin",
    "-i", "/proc/self/fd/11", "-i", "/proc/self/fd/12",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "libx264", "-crf", "18",
    "-c:a", "aac", "-q:v", "0", "-q:a", "0",
    "/proc/self/fd/13/baseline-raw.mp4",
  ];
  const rawCandidateCommand = [
    "/usr/bin/ffmpeg", "-n", "-loglevel", "error", "-nostdin",
    "-i", "/proc/self/fd/11", "-i", "/proc/self/fd/12",
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-c:a", "aac", "-q:v", "0", "-q:a", "0",
    "/proc/self/fd/13/candidate-raw.mp4",
  ];
  if (options.rawCandidateExtraCodec) {
    rawCandidateCommand.splice(-1, 0, "-c:v", "copy");
  }
  const rawReceipt = {
    schemaVersion: "ltx-studio-lipforcing-raw-mux-pair-receipt.v1",
    profiles: {
      baseline: defaultLipForcingRawOutputProfile,
      candidate: experimentalLipForcingRawOutputProfile,
    },
    durationArg: null,
    ffmpeg,
    inputs: {
      preMuxSourceSha256: sha256(paths.preMux),
      preMuxExportSha256: sha256(paths.preMux),
      preMuxSizeBytes: statSync(paths.preMux).size,
      audioSha256: sha256(paths.controlAudio),
      audioSizeBytes: statSync(paths.controlAudio).size,
    },
    commands: {
      baseline: compactCommand(rawBaselineCommand),
      candidate: compactCommand(rawCandidateCommand),
    },
    outputs: {
      baselineRaw: hashSize(paths.baselineRaw),
      candidateRaw: hashSize(paths.candidateRaw),
    },
  };
  writeFileSync(paths.receipt, `${JSON.stringify(rawReceipt)}\n`, { mode: 0o400 });

  const frameCount = options.falseTimeline ? 6 : 5;
  const duration = (frameCount / 25).toFixed(9);
  const videoFilter = `fps=fps=25/1:round=near,tpad=stop_mode=clone:stop_duration=2,`
    + `trim=end_frame=${frameCount},setpts=N/(25/1*TB)`;
  const timelineCommand = (refinedFd: string, output: string) => [
    "/usr/bin/ffmpeg", "-hide_banner", "-loglevel", "error", "-n",
    "-i", refinedFd, "-i", "/proc/self/fd/23", "-i", "/proc/self/fd/24",
    "-map", "0:v:0", "-map", "2:a:0",
    "-vf", videoFilter, "-frames:v", String(frameCount),
    "-c:v", "libx264", "-preset", "medium", "-crf", "8", "-pix_fmt", "yuv420p",
    "-af", `aresample=48000,apad,atrim=duration=${duration},asetpts=PTS-STARTPTS`,
    "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", output,
  ];
  const baselinePcm = decodedPcmSha256(baselineFinal);
  const candidatePcm = decodedPcmSha256(paths.candidateFinal);
  const claimedCandidatePcm = options.falseCandidatePcm ? baselinePcm : candidatePcm;
  const timelineReceipt = {
    schemaVersion: "ltx-studio-lipforcing-paired-timeline-receipt.v1",
    rawMuxReceiptSha256: sha256(paths.receipt),
    programAudioDelayMs: 0,
    inputs: {
      source: hashSize(paths.ltxBase),
      programAudio: hashSize(paths.programAudio),
    },
    executables: {
      before: { ffmpeg, ffprobe },
      after: { ffmpeg, ffprobe },
    },
    commands: {
      baseline: compactCommand(timelineCommand("/proc/self/fd/21", baselineFinal)),
      candidate: compactCommand(options.timelineCandidateExtraFlag
        ? [
            ...timelineCommand("/proc/self/fd/22", paths.candidateFinal).slice(0, -1),
            "-movflags", "+faststart", paths.candidateFinal,
          ]
        : timelineCommand("/proc/self/fd/22", paths.candidateFinal)),
    },
    timeline: {
      baseline: { frameRate: "25/1", frameCount, width: 64, height: 64, hasAudio: true },
      candidate: { frameRate: "25/1", frameCount, width: 64, height: 64, hasAudio: true },
    },
    decodedPcm: {
      format: "s16le-mono-48000",
      commands: {
        baseline: compactCommand([
          "/usr/bin/ffmpeg", "-v", "error", "-i", "/proc/self/fd/25",
          "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1",
        ]),
        candidate: compactCommand([
          "/usr/bin/ffmpeg", "-v", "error", "-i", "/proc/self/fd/26",
          "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "pipe:1",
        ]),
      },
    },
    outputs: {
      baselineFinal: { ...hashSize(baselineFinal), decodedPcmSha256: baselinePcm },
      candidateFinal: {
        ...hashSize(paths.candidateFinal),
        decodedPcmSha256: claimedCandidatePcm,
      },
    },
  };
  writeFileSync(paths.timelineReceipt, `${JSON.stringify(timelineReceipt)}\n`, { mode: 0o400 });
  const expected = {
    experimentId: "22222222-2222-4222-8222-222222222222",
    protocolSha256: "a".repeat(64),
    baselineJobId: "11111111-1111-4111-8111-111111111111",
    baselineOutputName: "baseline-exp-22222222-a.mp4",
    baselineRequestSha256: "b".repeat(64),
    candidateRequestSha256: "c".repeat(64),
    containerImageFingerprint: "d".repeat(64),
    baselineFinalPath: baselineFinal,
    mouthDelayMs: 0,
    programAudioDelayMs: 0,
  };
  return { stageRoot, paths, baselineFinal, expected };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RawMuxBaselineAuthority", () => {
  it("uses the frozen compact cross-language argv digest", () => {
    expect(rawMuxCommandSha256([
      "/usr/bin/ffmpeg", "-n", "Grüße", "/paired/baseline-raw.mp4",
    ])).toBe("4cd572dc10b5e00b34aa8849292c75986273d27f8bf983f8ecd2c4f4fe506599");
  });

  it("seals and re-verifies one exact pair, rejects overwrite, and snapshots write-once", () => {
    const value = fixture();
    const authority = createRawMuxBaselineAuthority({
      paths: value.paths,
      ...value.expected,
      createdAt: "2026-08-26T12:00:00.000Z",
    });
    const verified = readVerifiedRawMuxBaselineAuthority(value.paths, value.expected);
    expect(verified?.authority.fingerprint).toBe(authority.fingerprint);
    expect(statSync(value.paths.authority).mode & 0o777).toBe(0o400);
    expect(() => createRawMuxBaselineAuthority({ paths: value.paths, ...value.expected })).toThrow(/existiert bereits/u);

    const candidateStage = join(value.stageRoot, "candidate-job");
    const pinned = pinRawMuxCandidateArtifact(
      authority,
      captureRawMuxPairFile(value.paths.authority),
      "e".repeat(64),
      candidateStage,
    );
    expect(pinned.source.snapshotCandidateFinal.sha256).toBe(authority.files.candidateFinal.sha256);
    expect(() => pinRawMuxCandidateArtifact(
      authority,
      captureRawMuxPairFile(value.paths.authority),
      "e".repeat(64),
      candidateStage,
    )).toThrow();
  });

  it("rejects a self-consistent false PCM claim after independent held-FD decode", () => {
    const value = fixture({ falseCandidatePcm: true });
    expect(() => createRawMuxBaselineAuthority({ paths: value.paths, ...value.expected }))
      .toThrow(/PCM|Timeline/u);
  });

  it("rejects false receipt frame metadata after independent held-FD frame counting", () => {
    const value = fixture({ falseTimeline: true });
    expect(() => createRawMuxBaselineAuthority({ paths: value.paths, ...value.expected }))
      .toThrow(/Timeline/u);
  });

  it("rejects an oversized timeline receipt before any replay workload", () => {
    const value = fixture();
    const receipt = JSON.parse(readFileSync(value.paths.timelineReceipt, "utf8")) as {
      timeline: { baseline: { frameCount: number } };
    };
    receipt.timeline.baseline.frameCount = 2_050;
    chmodSync(value.paths.timelineReceipt, 0o600);
    writeFileSync(value.paths.timelineReceipt, `${JSON.stringify(receipt)}\n`, { mode: 0o400 });
    chmodSync(value.paths.timelineReceipt, 0o400);

    expect(() => createRawMuxBaselineAuthority({ paths: value.paths, ...value.expected }))
      .toThrow(/Timeline-Receipt.*ungültig/u);
  });

  it("rejects recomputed raw and timeline command digests with duplicate override flags", () => {
    const raw = fixture({ rawCandidateExtraCodec: true });
    expect(() => createRawMuxBaselineAuthority({ paths: raw.paths, ...raw.expected }))
      .toThrow(/Receipt|Codecwechsel/u);

    const timeline = fixture({ timelineCandidateExtraFlag: true });
    expect(() => createRawMuxBaselineAuthority({ paths: timeline.paths, ...timeline.expected }))
      .toThrow(/Timeline/u);
  });

  it("rejects packet drift and unregistered candidate streams despite self-consistent file hashes", () => {
    const drift = fixture({ packetCandidateDrift: true });
    expect(() => createRawMuxBaselineAuthority({ paths: drift.paths, ...drift.expected }))
      .toThrow(/Paketstrom/u);

    const extraStream = fixture({ extraCandidateStream: true });
    expect(() => createRawMuxBaselineAuthority({ paths: extraStream.paths, ...extraStream.expected }))
      .toThrow(/spuranzahl|Streams/iu);
  });

  it("rejects symlink and hardlink substitutions before sealing", () => {
    const symlink = fixture();
    unlinkSync(symlink.paths.candidateRaw);
    symlinkSync(symlink.paths.preMux, symlink.paths.candidateRaw);
    expect(() => createRawMuxBaselineAuthority({ paths: symlink.paths, ...symlink.expected }))
      .toThrow();

    const hardlink = fixture();
    unlinkSync(hardlink.paths.candidateRaw);
    linkSync(hardlink.paths.preMux, hardlink.paths.candidateRaw);
    expect(() => createRawMuxBaselineAuthority({ paths: hardlink.paths, ...hardlink.expected }))
      .toThrow(/Link/u);
  });

  it("rejects in-place post-seal drift and authority path replacement or cross-splice", () => {
    const first = fixture();
    const firstAuthority = createRawMuxBaselineAuthority({
      paths: first.paths,
      ...first.expected,
      createdAt: "2026-08-26T12:00:00.000Z",
    });
    const verified = readVerifiedRawMuxBaselineAuthority(first.paths, first.expected);
    expect(verified).not.toBeNull();

    chmodSync(first.paths.candidateFinal, 0o600);
    appendFileSync(first.paths.candidateFinal, Buffer.from("drift", "utf8"));
    expect(readVerifiedRawMuxBaselineAuthority(first.paths, first.expected)).toBeNull();

    const second = fixture();
    createRawMuxBaselineAuthority({
      paths: second.paths,
      ...second.expected,
      createdAt: "2026-08-26T12:00:01.000Z",
    });
    expect(() => pinRawMuxCandidateArtifact(
      firstAuthority,
      captureRawMuxPairFile(second.paths.authority),
      "e".repeat(64),
      join(first.stageRoot, "cross-splice-candidate"),
    )).toThrow(/gehört nicht exakt/u);

    const pathSwap = fixture();
    const pathSwapAuthority = createRawMuxBaselineAuthority({
      paths: pathSwap.paths,
      ...pathSwap.expected,
      createdAt: "2026-08-26T12:00:02.000Z",
    });
    const pathSwapVerified = readVerifiedRawMuxBaselineAuthority(pathSwap.paths, pathSwap.expected);
    expect(pathSwapVerified).not.toBeNull();
    renameSync(pathSwap.paths.authority, `${pathSwap.paths.authority}.original`);
    copyFileSync(second.paths.authority, pathSwap.paths.authority);
    expect(() => pinRawMuxCandidateArtifact(
      pathSwapAuthority,
      pathSwapVerified!.authorityBinding,
      "e".repeat(64),
      join(pathSwap.stageRoot, "path-swap-candidate"),
    )).toThrow();
  });
});
