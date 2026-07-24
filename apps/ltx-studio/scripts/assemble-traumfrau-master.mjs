import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const outputRoot = "/home/moddy/LTX-2/.ltx-studio/outputs";
const outputName = "traumfrau-nummer1-master-bf16-offload-2min-1080x1920-20260724.mp4";
const outputPath = join(outputRoot, outputName);
const sourcePath = join(
  outputRoot,
  "sources",
  "traumfrau-nummer1-source-bf16-offload-10s-512x896-20260724.mp4",
);
const temporaryPath = join(
  outputRoot,
  "traumfrau-nummer1-master-bf16-offload-2min-1080x1920-20260724.part.mp4",
);
const reportPath = join(
  outputRoot,
  "traumfrau-nummer1-master-bf16-offload-2min-1080x1920-20260724.report.json",
);
const targetDurationSeconds = 122;

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited with ${code ?? signal}`));
    });
  });
}

function inspectVideo(path) {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration,size,bit_rate:stream=index,codec_name,codec_type,width,height,r_frame_rate,nb_frames,duration,sample_rate,channels",
    "-of", "json",
    path,
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffprobe failed: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

function validateMaster(probe) {
  const duration = Number(probe.format?.duration);
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (!Number.isFinite(duration) || duration < 120) throw new Error(`Master is only ${duration} seconds long`);
  if (!Number.isFinite(Number(video?.duration)) || Number(video.duration) < 120) {
    throw new Error(`Master video stream is only ${video?.duration ?? "unknown"} seconds long`);
  }
  if (video?.width !== 1080 || video?.height !== 1920) {
    throw new Error(`Master resolution is ${video?.width ?? "?"}x${video?.height ?? "?"}`);
  }
  if (video?.r_frame_rate !== "24/1") throw new Error(`Master frame rate is ${video?.r_frame_rate ?? "missing"}`);
  if (!Number.isFinite(Number(video?.nb_frames)) || Number(video.nb_frames) < 2_880) {
    throw new Error(`Master video stream has only ${video?.nb_frames ?? "unknown"} frames`);
  }
  if (!audio || audio.sample_rate !== "48000" || audio.channels !== 2) {
    throw new Error("Master lacks the required 48 kHz stereo audio stream");
  }
}

function validateSource(probe) {
  const video = probe.streams?.find((stream) => stream.codec_type === "video");
  const audio = probe.streams?.find((stream) => stream.codec_type === "audio");
  if (video?.width !== 512 || video?.height !== 896) {
    throw new Error(`Source resolution is ${video?.width ?? "?"}x${video?.height ?? "?"}`);
  }
  if (video?.r_frame_rate !== "24/1" || Number(video?.nb_frames) !== 241) {
    throw new Error(
      `Source timing is ${video?.r_frame_rate ?? "?"} with ${video?.nb_frames ?? "?"} frames`,
    );
  }
  if (!audio || audio.sample_rate !== "48000" || audio.channels !== 2) {
    throw new Error("Source lacks the required 48 kHz stereo audio stream");
  }
}

async function writeReport(probe, sourceProbe) {
  const report = {
    schemaVersion: "ltx-studio-production-report.v1",
    completedAt: new Date().toISOString(),
    sourcePath,
    sourceProbe,
    outputPath,
    targetDurationSeconds,
    probe,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

const sourceStats = await stat(sourcePath);
if (!sourceStats.isFile() || sourceStats.size === 0) throw new Error("LTX source output is empty");
const sourceProbe = inspectVideo(sourcePath);
validateSource(sourceProbe);

try {
  const existingProbe = inspectVideo(outputPath);
  validateMaster(existingProbe);
  await writeReport(existingProbe, sourceProbe);
  process.stdout.write(`Verified master already ready: ${outputPath}\n`);
  process.exit(0);
} catch {
  // A missing or incomplete prior output is rebuilt through the atomic part file.
}

await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await rm(temporaryPath, { force: true });

const sourceHasAudio = sourceProbe.streams?.some((stream) => stream.codec_type === "audio") === true;
const sourceVideo = sourceProbe.streams.find((stream) => stream.codec_type === "video");
const sourceFrameRate = 24;
const sourceIntervals = Number(sourceVideo.nb_frames) - 1;
const targetFrames = targetDurationSeconds * sourceFrameRate;
const stretchFactor = (targetFrames - 1) / sourceIntervals;
const audioTempoRemainder = 8 / stretchFactor;
const videoFilter = [
  `[0:v]setpts=${stretchFactor}*PTS`,
  "minterpolate=fps=24:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1",
  "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos",
  "crop=1080:1920",
  "format=yuv420p[v]",
].join(",");
const roomAudioFilter =
  `[1:a]highpass=f=70,lowpass=f=3200,volume=0.08,afade=t=in:st=0:d=2,afade=t=out:st=${targetDurationSeconds - 2}:d=2[room]`;
const audioFilter = sourceHasAudio
  ? [
      `[0:a]atempo=0.5,atempo=0.5,atempo=0.5,atempo=${audioTempoRemainder},volume=0.20[ltx]`,
      roomAudioFilter,
      "[ltx][room]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.8[a]",
    ].join(";")
  : `${roomAudioFilter};[room]alimiter=limit=0.8[a]`;

try {
  await run("ffmpeg", [
    "-hide_banner", "-y",
    "-i", sourcePath,
    "-f", "lavfi",
    "-i", `anoisesrc=color=pink:amplitude=0.02:sample_rate=48000:duration=${targetDurationSeconds}`,
    "-filter_complex", `${videoFilter};${audioFilter}`,
    "-map", "[v]",
    "-map", "[a]",
    "-t", String(targetDurationSeconds),
    "-c:v", "libx264",
    "-preset", "fast",
    "-crf", "18",
    "-profile:v", "high",
    "-level:v", "4.2",
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart",
    "-metadata", "title=Traumfrau Nummer 1 - Two Minute Master",
    temporaryPath,
  ]);
} catch (error) {
  await rm(temporaryPath, { force: true });
  throw error;
}

const probe = inspectVideo(temporaryPath);
validateMaster(probe);

await rename(temporaryPath, outputPath);
await writeReport(probe, sourceProbe);
process.stdout.write(`Verified master ready: ${outputPath}\n`);
