export const A2V_TEMPORAL_GRID = 8;
export const A2V_MAX_DERIVED_RAW_FRAMES = 1024;
export const A2V_MAX_EXPLICIT_FRAMES = 2049;

export type A2vDurationInput = {
  mode: string;
  numFrames: number;
  frameRate: number;
  audio: {
    path?: string;
    startTime: number;
    maxDuration: number | null;
  };
};

export type A2vTimelineBasis =
  | "explicit-frames"
  | "audio-cap-upper-bound"
  | "audio-cap"
  | "audio-eof";

export type EffectiveA2vTimeline = {
  input: {
    numFrames: number;
    frameRate: number;
    audioPath: string;
    audioStartTimeSeconds: number;
    audioMaxDurationSeconds: number | null;
  };
  derivesFramesFromAudio: boolean;
  frameCount: number;
  durationSeconds: number;
  audioWindowSeconds: number;
  upperBoundFrameCount: number;
  upperBoundDurationSeconds: number;
  exact: boolean;
  basis: A2vTimelineBasis;
  sourceDurationSeconds: number | null;
};

export function isA2vMode(mode: string): boolean {
  return mode === "image-audio-to-video" || mode === "audio-to-video";
}

export function usesAudioDerivedA2vFrames(input: A2vDurationInput): boolean {
  return isA2vMode(input.mode) && input.audio.maxDuration !== null;
}

function safeFrameRate(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function safeExplicitFrames(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(A2V_MAX_EXPLICIT_FRAMES, Math.floor(value)));
}

function safeSeconds(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function timelineInput(input: A2vDurationInput): EffectiveA2vTimeline["input"] {
  return {
    numFrames: safeExplicitFrames(input.numFrames),
    frameRate: safeFrameRate(input.frameRate),
    audioPath: typeof input.audio.path === "string" ? input.audio.path : "",
    audioStartTimeSeconds: safeSeconds(input.audio.startTime),
    audioMaxDurationSeconds: input.audio.maxDuration === null
      ? null
      : safeSeconds(input.audio.maxDuration),
  };
}

export function a2vTimelineMatchesInput(
  timeline: EffectiveA2vTimeline,
  input: A2vDurationInput,
): boolean {
  const expected = timelineInput(input);
  return timeline.input.numFrames === expected.numFrames
    && timeline.input.frameRate === expected.frameRate
    && timeline.input.audioPath === expected.audioPath
    && timeline.input.audioStartTimeSeconds === expected.audioStartTimeSeconds
    && timeline.input.audioMaxDurationSeconds === expected.audioMaxDurationSeconds;
}

/** Mirrors LTX v1.3 num_frames_from_audio_duration exactly. */
export function a2vFramesFromAudioDuration(durationSeconds: number, frameRate: number): number {
  const fps = safeFrameRate(frameRate);
  const rawFrames = Math.max(
    1,
    Math.min(A2V_MAX_DERIVED_RAW_FRAMES, Math.floor(safeSeconds(durationSeconds) * fps)),
  );
  return Math.floor((rawFrames - 1) / A2V_TEMPORAL_GRID) * A2V_TEMPORAL_GRID + 1;
}

/**
 * Resolves the one LTX v1.3 A2V duration driver used by Studio.
 *
 * With an audio cap, the upstream pipeline derives frames from the decoded
 * window after applying start time and EOF, floors it to whole frames, caps it
 * at 1024 raw frames and snaps down to the 8k+1 temporal grid. A browser cannot
 * prove EOF for an arbitrary DGX path, so an omitted source duration produces
 * a conservative cap-based upper bound. The server can supply the probed
 * source duration to turn the same calculation into an exact EOF result.
 */
export function effectiveA2vTimeline(
  input: A2vDurationInput,
  audioSourceDurationSeconds?: number | null,
): EffectiveA2vTimeline | null {
  if (!isA2vMode(input.mode)) return null;

  const fps = safeFrameRate(input.frameRate);
  const inputBinding = timelineInput(input);
  if (!usesAudioDerivedA2vFrames(input)) {
    const frameCount = safeExplicitFrames(input.numFrames);
    const durationSeconds = frameCount / fps;
    return {
      input: inputBinding,
      derivesFramesFromAudio: false,
      frameCount,
      durationSeconds,
      audioWindowSeconds: durationSeconds,
      upperBoundFrameCount: frameCount,
      upperBoundDurationSeconds: durationSeconds,
      exact: true,
      basis: "explicit-frames",
      sourceDurationSeconds: null,
    };
  }

  const capSeconds = safeSeconds(input.audio.maxDuration ?? 0);
  const upperBoundFrameCount = a2vFramesFromAudioDuration(capSeconds, fps);
  const upperBoundDurationSeconds = upperBoundFrameCount / fps;
  const sourceDurationKnown = typeof audioSourceDurationSeconds === "number"
    && Number.isFinite(audioSourceDurationSeconds)
    && audioSourceDurationSeconds >= 0;
  if (!sourceDurationKnown) {
    return {
      input: inputBinding,
      derivesFramesFromAudio: true,
      frameCount: upperBoundFrameCount,
      durationSeconds: upperBoundDurationSeconds,
      audioWindowSeconds: capSeconds,
      upperBoundFrameCount,
      upperBoundDurationSeconds,
      exact: false,
      basis: "audio-cap-upper-bound",
      sourceDurationSeconds: null,
    };
  }

  const sourceDuration = audioSourceDurationSeconds as number;
  const remainingSeconds = Math.max(0, sourceDuration - safeSeconds(input.audio.startTime));
  const audioWindowSeconds = Math.min(capSeconds, remainingSeconds);
  const frameCount = a2vFramesFromAudioDuration(audioWindowSeconds, fps);
  return {
    input: inputBinding,
    derivesFramesFromAudio: true,
    frameCount,
    durationSeconds: frameCount / fps,
    audioWindowSeconds,
    upperBoundFrameCount,
    upperBoundDurationSeconds,
    exact: true,
    basis: remainingSeconds < capSeconds ? "audio-eof" : "audio-cap",
    sourceDurationSeconds: sourceDuration,
  };
}
