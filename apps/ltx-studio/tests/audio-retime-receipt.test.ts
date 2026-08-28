import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildPositiveAudioRetimePacketCopyArgs,
  createPositiveAudioRetimeReceipt,
  positiveAudioRetimeArgsSha256,
  POSITIVE_AUDIO_RETIME_FFPROBE_ARGS_SHA256,
  POSITIVE_AUDIO_RETIME_PROFILE,
  POSITIVE_AUDIO_RETIME_RECEIPT_SCHEMA,
  type BoundAudioRetimeExecutable,
  type PositiveAudioRetimeExecutionAuthority,
} from "../server/audioRetimeReceipt.js";
import type { ExecutionFileBinding, ExecutionFileRevision } from "../shared/jobExecution.js";

const roots: string[] = [];
let verificationSequence = 0;

const authority: PositiveAudioRetimeExecutionAuthority = {
  jobId: "10000000-0000-4000-8000-000000000001",
  experimentId: "20000000-0000-4000-8000-000000000002",
  protocolSha256: "3".repeat(64),
  candidateRequestSha256: "4".repeat(64),
  baselineJobId: "50000000-0000-4000-8000-000000000005",
  baselineOutputName: "native-ltx25-baseline.mp4",
  baselineRequestSha256: "6".repeat(64),
  sourceAuthorityRequestSha256: "8".repeat(64),
  sourceProvenanceFingerprint: "7".repeat(64),
};

function revision(stats: ReturnType<typeof fstatSync>): ExecutionFileRevision {
  if (stats.nlink !== 1) throw new Error("Testdatei besitzt unerwartete Hardlinks.");
  return {
    sizeBytes: Number(stats.size),
    modifiedAtMs: Number(stats.mtimeMs),
    changedAtMs: Number(stats.ctimeMs),
    fileId: stats.ino.toString(),
    deviceId: stats.dev.toString(),
    mode: Number(stats.mode),
    uid: Number(stats.uid),
    gid: Number(stats.gid),
    nlink: 1,
  };
}

function hashDescriptor(fd: number, size: number): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < size) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
    if (count <= 0) throw new Error("Testdatei endete während der Hashprüfung.");
    digest.update(buffer.subarray(0, count));
    position += count;
  }
  return digest.digest("hex");
}

function bindFile(path: string): ExecutionFileBinding {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    return { path, sha256: hashDescriptor(fd, stats.size), revision: revision(stats) };
  } finally {
    closeSync(fd);
  }
}

function bindExecutable(path: "/usr/bin/ffmpeg" | "/usr/bin/ffprobe"): BoundAudioRetimeExecutable {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(fd);
    const result = spawnSync("/proc/self/fd/3", ["-version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", fd],
    });
    const version = `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).find((line) => line.trim())?.trim();
    if (result.status !== 0 || !version) throw new Error(`Test konnte ${path} nicht binden.`);
    return {
      fd,
      binding: { path, sha256: hashDescriptor(fd, stats.size), revision: revision(stats) },
      version,
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function makeSource(path: string, frequency = 440, color = "blue"): void {
  execFileSync("/usr/bin/ffmpeg", [
    "-v", "error", "-nostdin", "-n",
    "-f", "lavfi", "-i", `color=c=${color}:s=96x64:r=25:d=0.6`,
    "-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=48000:duration=0.6`,
    "-map", "0:v:0", "-map", "1:a:0",
    "-frames:v", "15", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-ac", "2", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", path,
  ]);
}

function makeCandidate(
  ffmpeg: BoundAudioRetimeExecutable,
  sourcePath: string,
  candidatePath: string,
  delayMs: number,
): string[] {
  const sourceFd = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const args = buildPositiveAudioRetimePacketCopyArgs(
      "/proc/self/fd/4",
      candidatePath,
      delayMs,
    );
    const result = spawnSync("/proc/self/fd/3", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", ffmpeg.fd, sourceFd],
    });
    if (result.status !== 0 || result.signal !== null || result.error) {
      throw new Error(`Packet-Copy-Testtransform scheiterte: ${result.stderr}`);
    }
    return args;
  } finally {
    closeSync(sourceFd);
  }
}

type Fixture = {
  root: string;
  sourcePath: string;
  candidatePath: string;
  ffmpeg: BoundAudioRetimeExecutable;
  ffprobe: BoundAudioRetimeExecutable;
  transformArgs: string[];
};

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ltx-audio-retime-receipt-"));
  roots.push(root);
  const sourcePath = join(root, "source.mp4");
  const candidatePath = join(root, "candidate-plus-83ms.mp4");
  makeSource(sourcePath);
  const ffmpeg = bindExecutable("/usr/bin/ffmpeg");
  const ffprobe = bindExecutable("/usr/bin/ffprobe");
  const transformArgs = makeCandidate(ffmpeg, sourcePath, candidatePath, 83);
  return { root, sourcePath, candidatePath, ffmpeg, ffprobe, transformArgs };
}

function closeFixture(value: Fixture): void {
  closeSync(value.ffprobe.fd);
  closeSync(value.ffmpeg.fd);
}

function verificationRoot(value: Fixture): string {
  verificationSequence += 1;
  const path = join(value.root, `verification-${verificationSequence}`);
  mkdirSync(path, { mode: 0o700 });
  return path;
}

function verify(value: Fixture, sourcePath = value.sourcePath, candidatePath = value.candidatePath) {
  return createPositiveAudioRetimeReceipt({
    profile: POSITIVE_AUDIO_RETIME_PROFILE,
    requestedDelayMs: 83,
    authority,
    source: bindFile(sourcePath),
    candidate: bindFile(candidatePath),
    ffmpeg: value.ffmpeg,
    ffprobe: value.ffprobe,
    transformArgs: buildPositiveAudioRetimePacketCopyArgs(
      "/proc/self/fd/4",
      candidatePath,
      83,
    ),
    verificationRoot: verificationRoot(value),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("positive native audio-retime receipt", () => {
  it("proves a real H.264/AAC +83 ms packet-copy transform fail-closed", () => {
    const value = fixture();
    try {
      const replayRoot = verificationRoot(value);
      const receipt = createPositiveAudioRetimeReceipt({
        profile: POSITIVE_AUDIO_RETIME_PROFILE,
        requestedDelayMs: 83,
        authority,
        source: bindFile(value.sourcePath),
        candidate: bindFile(value.candidatePath),
        ffmpeg: value.ffmpeg,
        ffprobe: value.ffprobe,
        transformArgs: value.transformArgs,
        verificationRoot: replayRoot,
      });

      expect(receipt.schemaVersion).toBe(POSITIVE_AUDIO_RETIME_RECEIPT_SCHEMA);
      expect(receipt.profile).toBe("positive-delay-packet-copy.v1");
      expect(value.transformArgs).toContain("-n");
      expect(value.transformArgs).not.toContain("-y");
      expect(receipt.authority).toMatchObject(authority);
      expect(receipt.transform.measuredDelayMicroseconds).toBeGreaterThanOrEqual(82_000);
      expect(receipt.transform.measuredDelayMicroseconds).toBeLessThanOrEqual(84_000);
      expect(receipt.transform.absoluteErrorMicroseconds).toBeLessThanOrEqual(1_000);
      expect(receipt.packets.source.videoPacketSequenceSha256)
        .toBe(receipt.packets.candidate.videoPacketSequenceSha256);
      expect(receipt.packets.source.audioPayloadSequenceSha256)
        .toBe(receipt.packets.candidate.audioPayloadSequenceSha256);
      expect(receipt.packets.source.audioPacketCount)
        .toBe(receipt.packets.candidate.audioPacketCount);
      expect(receipt.pcm.leadingPrefixFrameCount).toBeGreaterThan(0);
      expect(receipt.pcm.leadingPrefixPeakAbsoluteS32).toBe(0);
      expect(receipt.pcm.alignedCandidateSha256).toBe(receipt.pcm.sourceSha256);
      expect(receipt.args.transformArgsSha256).toBe(positiveAudioRetimeArgsSha256(value.transformArgs));
      expect(receipt.args.ffprobeArgsSha256).toBe(POSITIVE_AUDIO_RETIME_FFPROBE_ARGS_SHA256);
      expect(receipt.transform.replayOutputSha256).toBe(bindFile(value.candidatePath).sha256);
      expect(receipt.checks.boundTransformReplayByteIdentical).toBe(true);
      expect(existsSync(replayRoot)).toBe(false);
      expect(Object.values(receipt.checks)).toEqual(
        Array.from({ length: Object.keys(receipt.checks).length }, () => true),
      );
      expect(receipt.evidenceSha256).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      closeFixture(value);
    }
  });

  it("rejects zero and negative delays before probing", () => {
    expect(() => buildPositiveAudioRetimePacketCopyArgs(
      "/proc/self/fd/4",
      "/tmp/candidate.mp4",
      0,
    )).toThrow(/zwischen 1 und 500 ms/u);
    expect(() => buildPositiveAudioRetimePacketCopyArgs(
      "/proc/self/fd/4",
      "/tmp/candidate.mp4",
      -83,
    )).toThrow(/zwischen 1 und 500 ms/u);
  });

  it("rejects an audio-payload packet drift", () => {
    const value = fixture();
    try {
      const driftSource = join(value.root, "audio-drift-source.mp4");
      const driftCandidate = join(value.root, "audio-drift-candidate.mp4");
      makeSource(driftSource, 880, "blue");
      makeCandidate(value.ffmpeg, driftSource, driftCandidate, 83);
      expect(() => verify(value, value.sourcePath, driftCandidate))
        .toThrow(/Audio-Payloadpaketfolge/u);
    } finally {
      closeFixture(value);
    }
  });

  it("rejects a video packet drift", () => {
    const value = fixture();
    try {
      const driftSource = join(value.root, "video-drift-source.mp4");
      const driftCandidate = join(value.root, "video-drift-candidate.mp4");
      makeSource(driftSource, 440, "red");
      makeCandidate(value.ffmpeg, driftSource, driftCandidate, 83);
      expect(() => verify(value, value.sourcePath, driftCandidate))
        .toThrow(/Videopaketfolge/u);
    } finally {
      closeFixture(value);
    }
  });

  it("rejects a semantically invisible MP4-container drift through the bound replay", () => {
    const value = fixture();
    try {
      const forged = join(value.root, "candidate-forged-container.mp4");
      copyFileSync(value.candidatePath, forged);
      const bytes = readFileSync(forged);
      const brand = bytes.indexOf(Buffer.from("mp41", "ascii"));
      if (brand < 0) throw new Error("Testfixture besitzt keine erwartete MP4-Compatible-Brand.");
      Buffer.from("mp42", "ascii").copy(bytes, brand);
      writeFileSync(forged, bytes);

      expect(() => verify(value, value.sourcePath, forged))
        .toThrow(/nicht byteidentisch.*FFmpeg-Replay/u);
    } finally {
      closeFixture(value);
    }
  });

  it("rejects display-aspect drift before attesting visual identity", () => {
    const value = fixture();
    try {
      const rotated = join(value.root, "candidate-display-aspect.mp4");
      execFileSync("/usr/bin/ffmpeg", [
        "-v", "error", "-nostdin", "-n",
        "-i", value.candidatePath,
        "-map", "0:v:0", "-map", "0:a:0",
        "-c", "copy", "-aspect:v", "3:1",
        "-movflags", "+faststart", rotated,
      ]);
      expect(() => verify(value, value.sourcePath, rotated))
        .toThrow(/Geometrie|Videopaketfolge/u);
    } finally {
      closeFixture(value);
    }
  });

  it("rejects a different positive PTS/DTS delta", () => {
    const value = fixture();
    try {
      const wrongDelay = join(value.root, "candidate-plus-125ms.mp4");
      makeCandidate(value.ffmpeg, value.sourcePath, wrongDelay, 125);
      expect(() => verify(value, value.sourcePath, wrongDelay))
        .toThrow(/angeforderten Versatz|PTS-\/DTS-Delta/u);
    } finally {
      closeFixture(value);
    }
  });

  it("rejects audio-tail packet loss", () => {
    const value = fixture();
    try {
      const truncated = join(value.root, "candidate-truncated.mp4");
      execFileSync("/usr/bin/ffmpeg", [
        "-v", "error", "-nostdin", "-n",
        "-t", "0.45", "-i", value.candidatePath,
        "-i", value.candidatePath,
        "-map", "1:v:0", "-map", "0:a:0",
        "-c", "copy",
        "-movflags", "+faststart", truncated,
      ]);
      expect(() => verify(value, value.sourcePath, truncated))
        .toThrow(/verlor oder ergänzte Audiopakete/u);
    } finally {
      closeFixture(value);
    }
  });

  it("rejects non-v1 authority keys and a noncanonical source FD claim", () => {
    const value = fixture();
    try {
      expect(() => createPositiveAudioRetimeReceipt({
        profile: POSITIVE_AUDIO_RETIME_PROFILE,
        requestedDelayMs: 83,
        authority: { ...authority, unexpected: true } as PositiveAudioRetimeExecutionAuthority,
        source: bindFile(value.sourcePath),
        candidate: bindFile(value.candidatePath),
        ffmpeg: value.ffmpeg,
        ffprobe: value.ffprobe,
        transformArgs: value.transformArgs,
        verificationRoot: verificationRoot(value),
      })).toThrow(/exakt das registrierte v1-Schema/u);

      expect(() => createPositiveAudioRetimeReceipt({
        profile: POSITIVE_AUDIO_RETIME_PROFILE,
        requestedDelayMs: 83,
        authority,
        source: bindFile(value.sourcePath),
        candidate: bindFile(value.candidatePath),
        ffmpeg: value.ffmpeg,
        ffprobe: value.ffprobe,
        transformArgs: buildPositiveAudioRetimePacketCopyArgs(
          "/proc/self/fd/5",
          value.candidatePath,
          83,
        ),
        verificationRoot: verificationRoot(value),
      })).toThrow(/Source-FD 4/u);
    } finally {
      closeFixture(value);
    }
  });

  it("rejects a tool identity that cannot execute the claimed FFmpeg contract", () => {
    const value = fixture();
    try {
      expect(() => createPositiveAudioRetimeReceipt({
        profile: POSITIVE_AUDIO_RETIME_PROFILE,
        requestedDelayMs: 83,
        authority,
        source: bindFile(value.sourcePath),
        candidate: bindFile(value.candidatePath),
        ffmpeg: value.ffprobe,
        ffprobe: value.ffmpeg,
        transformArgs: value.transformArgs,
        verificationRoot: verificationRoot(value),
      })).toThrow(/Gebundenes ffmpeg|Version/u);
    } finally {
      closeFixture(value);
    }
  });
});
