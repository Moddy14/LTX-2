import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  assembleSequence,
  buildConcatFilter,
  collectSequenceShots,
  SequenceAssembleError,
} from "../server/sequenceAssemble.js";
import { probeVideoMetadata } from "../server/mediaProbe.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ltx-sequence-"));
  roots.push(root);
  return root;
}

/** Erzeugt einen Shot mit Bild und Ton, wie die Pipeline ihn liefert. */
function makeShot(
  path: string,
  { seconds = 1, width = 320, height = 176, withAudio = true } = {},
): void {
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=size=${width}x${height}:rate=25:duration=${seconds}`,
  ];
  if (withAudio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", String(seconds));
  if (withAudio) args.push("-c:a", "aac", "-shortest");
  args.push(path);
  const result = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 30_000 });
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

function untrimmedShot(outputName: string) {
  return {
    outputName,
    path: `/outputs/${outputName}`,
    width: 320,
    height: 176,
    frames: 125,
    durationSeconds: 5,
    trimStartSeconds: 0,
    trimEndSeconds: 0,
    usedSeconds: 5,
  };
}

describe("sequence assembly", () => {
  it("joins shots in the given order and keeps picture and sound", async () => {
    const root = await temporaryRoot();
    makeShot(join(root, "shot-a.mp4"), { seconds: 1 });
    makeShot(join(root, "shot-b.mp4"), { seconds: 2 });

    const prepared = await assembleSequence(
      { outputs: ["shot-a.mp4", "shot-b.mp4"], name: "mein film" },
      root,
      join(root, "uploads"),
    );

    expect(prepared.file.originalname).toBe("mein-film.mp4");
    expect(prepared.shots.map((shot) => shot.outputName)).toEqual(["shot-a.mp4", "shot-b.mp4"]);
    const metadata = probeVideoMetadata(prepared.file.path);
    expect(metadata).toMatchObject({ width: 320, height: 176, hasAudio: true });
    // Die Montage ist so lang wie die Summe der Shots, nicht wie der längste.
    expect(metadata?.durationSeconds ?? 0).toBeGreaterThan(2.6);
    expect(prepared.command).toContain("concat=n=2:v=1:a=1");
  });

  it("refuses a shot without a sound track instead of producing a silent gap", async () => {
    const root = await temporaryRoot();
    makeShot(join(root, "shot-a.mp4"));
    makeShot(join(root, "shot-mute.mp4"), { withAudio: false });

    await expect(assembleSequence(
      { outputs: ["shot-a.mp4", "shot-mute.mp4"] },
      root,
      join(root, "uploads"),
    )).rejects.toMatchObject({ name: SequenceAssembleError.name, statusCode: 400 });
  });

  it("names the mismatching shot when frame sizes differ", async () => {
    const root = await temporaryRoot();
    makeShot(join(root, "shot-a.mp4"), { width: 320, height: 176 });
    makeShot(join(root, "shot-wide.mp4"), { width: 640, height: 352 });

    await expect(assembleSequence(
      { outputs: ["shot-a.mp4", "shot-wide.mp4"] },
      root,
      join(root, "uploads"),
    )).rejects.toThrow(/shot-wide\.mp4 ist 640×352, aber shot-a\.mp4 ist 320×176/);
  });

  it("rejects a missing output, a single shot and an unsafe name", async () => {
    const root = await temporaryRoot();
    makeShot(join(root, "shot-a.mp4"));

    expect(() => collectSequenceShots(["shot-a.mp4"], root))
      .toThrow(/mindestens zwei Ausgaben/);
    expect(() => collectSequenceShots(["shot-a.mp4", "fehlt.mp4"], root))
      .toThrow(/nicht vorhanden/);
    expect(() => collectSequenceShots(["shot-a.mp4", "../escape.mp4"], root))
      .toThrow(/Unzulässiger Ausgabename/);
  });

  it("builds one concat pair per input", () => {
    const shots = [0, 1, 2].map((index) => untrimmedShot(`shot-${index}.mp4`));
    expect(buildConcatFilter(shots)).toBe("[0:v][0:a][1:v][1:a][2:v][2:a]concat=n=3:v=1:a=1[v][a]");
  });

  it("trims only the shots that ask for it and resets their timestamps", () => {
    const shots = [
      untrimmedShot("plain.mp4"),
      { ...untrimmedShot("trimmed.mp4"), trimStartSeconds: 0.5, trimEndSeconds: 0.25, usedSeconds: 4.25 },
    ];
    const filter = buildConcatFilter(shots);

    expect(filter).toContain("[1:v]trim=start=0.500:end=4.750,setpts=PTS-STARTPTS[v1]");
    expect(filter).toContain("[1:a]atrim=start=0.500:end=4.750,asetpts=PTS-STARTPTS[a1]");
    // Der ungeschnittene Shot bleibt unangetastet und geht direkt in concat.
    expect(filter).not.toContain("[0:v]trim");
    expect(filter).toContain("[0:v][0:a][v1][a1]concat=n=2:v=1:a=1[v][a]");
  });

  it("cuts a real shot down to the requested window", async () => {
    const root = await temporaryRoot();
    makeShot(join(root, "shot-a.mp4"), { seconds: 2 });
    makeShot(join(root, "shot-b.mp4"), { seconds: 2 });

    const prepared = await assembleSequence({
      outputs: ["shot-a.mp4", { output: "shot-b.mp4", trimStartSeconds: 1 }],
    }, root, join(root, "uploads"));

    expect(prepared.shots[1]).toMatchObject({ trimStartSeconds: 1, usedSeconds: expect.any(Number) });
    // Zwei Sekunden plus eine geschnittene Sekunde, nicht vier.
    const duration = probeVideoMetadata(prepared.file.path)?.durationSeconds ?? 0;
    expect(duration).toBeGreaterThan(2.7);
    expect(duration).toBeLessThan(3.4);
  });

  it("refuses a cut that would leave nothing of a shot", async () => {
    const root = await temporaryRoot();
    makeShot(join(root, "shot-a.mp4"), { seconds: 1 });
    makeShot(join(root, "shot-b.mp4"), { seconds: 1 });

    expect(() => collectSequenceShots(
      ["shot-a.mp4", { output: "shot-b.mp4", trimStartSeconds: 0.8, trimEndSeconds: 0.5 }],
      root,
    )).toThrow(/lassen von shot-b\.mp4 nichts übrig/);
  });
});
