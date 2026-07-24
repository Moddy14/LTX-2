export type FinalAudioRemuxInput = {
  sourceAudioPath: string;
  sourceStartTime: number;
  sourceMaxDuration: number | null;
  videoPath: string;
  outputPath: string;
};

export function buildFinalAudioRemuxArgs(input: FinalAudioRemuxInput): string[] {
  if (!Number.isFinite(input.sourceStartTime) || input.sourceStartTime < 0) {
    throw new Error("Startzeit der finalen Tonspur ist ungültig.");
  }
  if (input.sourceMaxDuration !== null
    && (!Number.isFinite(input.sourceMaxDuration) || input.sourceMaxDuration <= 0)) {
    throw new Error("Maximale Dauer der finalen Tonspur ist ungültig.");
  }
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-ss",
    input.sourceStartTime.toFixed(6),
  ];
  if (input.sourceMaxDuration !== null) {
    args.push("-t", input.sourceMaxDuration.toFixed(6));
  }
  args.push(
    "-i", input.sourceAudioPath,
    "-i", input.videoPath,
    "-map", "1:v:0",
    "-map", "0:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-af",
    "apad",
    "-shortest",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    input.outputPath,
  );
  return args;
}
