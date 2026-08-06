import type { LipDubReferenceDiagnostics, LipDubReferenceFinding } from "../shared/plan.js";
import { probeVideoMetadata, type VideoMetadata } from "./mediaProbe.js";

const LIPDUB_MIN_REFERENCE_SECONDS = 1;
const LIPDUB_MAX_REFERENCE_SECONDS = 20;
const LIPDUB_MIN_REFERENCE_FPS = 12;
const LIPDUB_MAX_REFERENCE_FPS = 60;
const LIPDUB_MIN_REFERENCE_DIMENSION = 256;
const LIPDUB_MAX_ASPECT_RATIO_DRIFT = 0.15;
const LIPDUB_MIN_DIALOGUE_WPM = 65;
const LIPDUB_MAX_DIALOGUE_WPM = 220;
const LIPDUB_OUTPUT_SIZE_MULTIPLE = 64;
const LIPDUB_OUTPUT_SIZE_CANDIDATE_RADIUS = 1;
export const OFFICIAL_COMFY_LIPDUB_OUTPUT_AREA = 1920 * 1088;

export type LipDubReferenceInspectionInput = {
  path: string;
  width: number;
  height: number;
  dialogue: string;
  prompt: string;
  pipelineProfile?: "official-comfy-hq" | "native-distilled";
};

export function snapLipDubFrames(frames: number): number {
  return Math.max(1, Math.floor((Math.max(1, frames) - 1) / 8) * 8 + 1);
}

function nearestMultiple(value: number, multiple: number): number {
  return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function sizeCandidatesAround(value: number): number[] {
  const center = nearestMultiple(value, LIPDUB_OUTPUT_SIZE_MULTIPLE);
  const candidates = new Set<number>();
  for (
    let offset = -LIPDUB_OUTPUT_SIZE_CANDIDATE_RADIUS;
    offset <= LIPDUB_OUTPUT_SIZE_CANDIDATE_RADIUS;
    offset += 1
  ) {
    const candidate = center + offset * LIPDUB_OUTPUT_SIZE_MULTIPLE;
    if (candidate >= LIPDUB_MIN_REFERENCE_DIMENSION && candidate <= 4096) candidates.add(candidate);
  }
  return [...candidates].sort((left, right) => left - right);
}

export function recommendedLipDubOutputSize(
  metadata: VideoMetadata,
  targetArea: number | null = null,
): { width: number; height: number } | null {
  if (metadata.width === null || metadata.height === null) return null;
  const referenceAspect = metadata.width / metadata.height;
  const referenceArea = metadata.width * metadata.height;
  const scale = targetArea === null ? 1 : Math.sqrt(targetArea / referenceArea);
  const targetWidth = metadata.width * scale;
  const targetHeight = metadata.height * scale;
  let best: { width: number; height: number; score: number } | null = null;

  for (const width of sizeCandidatesAround(targetWidth)) {
    for (const height of sizeCandidatesAround(targetHeight)) {
      const aspectDrift = Math.abs(Math.log((width / height) / referenceAspect));
      const areaDrift = Math.abs(Math.log((width * height) / (targetArea ?? referenceArea)));
      const score = aspectDrift * 100 + areaDrift;
      if (best === null || score < best.score) best = { width, height, score };
    }
  }

  return best ? { width: best.width, height: best.height } : null;
}

export function chooseLipDubConstantFps(fps: number | null): 24 | 25 | 30 {
  const supported = [24, 25, 30] as const;
  if (fps === null) return 24;
  return supported.reduce((best, candidate) =>
    Math.abs(candidate - fps) < Math.abs(best - fps) ? candidate : best,
  );
}

function metadataDurationSeconds(metadata: VideoMetadata): number | null {
  if (metadata.durationSeconds !== null) return metadata.durationSeconds;
  if (metadata.frames !== null && metadata.fps !== null && metadata.fps > 0) return metadata.frames / metadata.fps;
  return null;
}

function dialogueFromInput(input: LipDubReferenceInspectionInput): string {
  const explicit = input.dialogue.trim();
  if (explicit) return explicit;
  const quoted = [...input.prompt.matchAll(/["“]([^"”]{2,})["”]/g)]
    .map((match) => match[1].trim())
    .sort((left, right) => right.length - left.length);
  return quoted[0] ?? "";
}

function countDialogueWords(dialogue: string): number {
  return dialogue.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

function finding(code: string, level: LipDubReferenceFinding["level"], message: string): LipDubReferenceFinding {
  return { code, level, message };
}

export function inspectLipDubReference(input: LipDubReferenceInspectionInput): LipDubReferenceDiagnostics {
  const metadata = probeVideoMetadata(input.path);
  if (!metadata) {
    const findings = [
      finding(
        "reference-unreadable",
        "error",
        `LipDub-Referenzvideo konnte nicht dekodiert werden oder enthält keine lesbare Videospur (${input.path})`,
      ),
    ];
    return { status: "blocked", metadata: null, recommendedTarget: null, findings };
  }

  const findings: LipDubReferenceFinding[] = [];
  if (metadata.hasAudio === false) {
    findings.push(finding("audio-missing", "error", `LipDub-Referenzvideo enthält keine Audiospur (${input.path})`));
  } else if (metadata.hasAudio !== true) {
    findings.push(finding(
      "audio-unverified",
      "error",
      `LipDub-Referenzvideo-Audiospur konnte nicht verlässlich geprüft werden (${input.path})`,
    ));
  }

  const durationSeconds = metadataDurationSeconds(metadata);
  const dialogueWords = countDialogueWords(dialogueFromInput(input));
  const dialogueWordsPerMinute = durationSeconds !== null && dialogueWords > 0
    ? dialogueWords / (durationSeconds / 60)
    : null;
  if (durationSeconds === null) {
    findings.push(finding(
      "duration-unreadable",
      "error",
      `LipDub-Referenzvideo-Dauer konnte nicht verlässlich bestimmt werden (${input.path})`,
    ));
  } else {
    if (durationSeconds < LIPDUB_MIN_REFERENCE_SECONDS) {
      findings.push(finding(
        "duration-too-short",
        "error",
        `LipDub-Referenzvideo ist zu kurz (${durationSeconds.toFixed(2)} s); mindestens ${LIPDUB_MIN_REFERENCE_SECONDS.toFixed(0)} s verwenden.`,
      ));
    }
    if (durationSeconds > LIPDUB_MAX_REFERENCE_SECONDS) {
      findings.push(finding(
        "duration-too-long",
        "error",
        `LipDub-Referenzvideo ist zu lang (${durationSeconds.toFixed(2)} s); für reproduzierbare Tests maximal ${LIPDUB_MAX_REFERENCE_SECONDS.toFixed(0)} s verwenden.`,
      ));
    }
    if (dialogueWordsPerMinute !== null && dialogueWordsPerMinute < LIPDUB_MIN_DIALOGUE_WPM) {
      findings.push(finding(
        "dialogue-too-short",
        "error",
        `LipDub-Dialog ist für die Referenzdauer zu kurz (${dialogueWords} Wörter in ${durationSeconds.toFixed(2)} s, ca. ${dialogueWordsPerMinute.toFixed(0)} WPM).`,
      ));
    } else if (dialogueWordsPerMinute !== null && dialogueWordsPerMinute > LIPDUB_MAX_DIALOGUE_WPM) {
      findings.push(finding(
        "dialogue-too-long",
        "error",
        `LipDub-Dialog ist für die Referenzdauer zu lang (${dialogueWords} Wörter in ${durationSeconds.toFixed(2)} s, ca. ${dialogueWordsPerMinute.toFixed(0)} WPM).`,
      ));
    }
  }

  if (metadata.fps === null) {
    findings.push(finding(
      "fps-unreadable",
      "error",
      `LipDub-Referenzvideo-FPS konnte nicht verlässlich bestimmt werden (${input.path})`,
    ));
  } else {
    if (metadata.fps < LIPDUB_MIN_REFERENCE_FPS || metadata.fps > LIPDUB_MAX_REFERENCE_FPS) {
      findings.push(finding(
        "fps-out-of-range",
        "error",
        `LipDub-Referenzvideo hat ungeeignete FPS (${metadata.fps.toFixed(2)}); empfohlen sind ${LIPDUB_MIN_REFERENCE_FPS}-${LIPDUB_MAX_REFERENCE_FPS} FPS.`,
      ));
    }
    if (Math.abs(metadata.fps - Math.round(metadata.fps)) > 0.001) {
      findings.push(finding(
        "fractional-fps",
        "warning",
        `Referenz-FPS ist ${metadata.fps.toFixed(3)}. Die native Ausgabe kodiert derzeit mit ganzzahliger FPS; für präzisen LipSync vorher auf konstante 24, 25 oder 30 FPS transkodieren.`,
      ));
    }
  }
  if (metadata.constantFrameRate === false) {
    findings.push(finding(
      "variable-frame-rate",
      "warning",
      "Referenzvideo zeigt eine variable oder inkonsistente Bildrate; für präzisen LipSync auf konstante 24, 25 oder 30 FPS transkodieren.",
    ));
  }
  if ((metadata.videoStreamCount ?? 1) > 1) {
    findings.push(finding(
      "multiple-video-streams",
      "warning",
      `Referenzvideo enthält ${metadata.videoStreamCount} Videospuren; LipDub verwendet nur die erste Spur.`,
    ));
  }
  if ((metadata.audioStreamCount ?? (metadata.hasAudio ? 1 : 0)) > 1) {
    findings.push(finding(
      "multiple-audio-streams",
      "warning",
      `Referenzvideo enthält ${metadata.audioStreamCount} Audiospuren; LipDub verwendet nur die erste Spur.`,
    ));
  }
  if (
    metadata.audioVideoDurationDeltaSeconds !== null
    && metadata.audioVideoDurationDeltaSeconds !== undefined
    && metadata.audioVideoDurationDeltaSeconds > 0.04
  ) {
    findings.push(finding(
      "audio-video-duration-drift",
      "warning",
      `Audio- und Videospur unterscheiden sich um ${metadata.audioVideoDurationDeltaSeconds.toFixed(3)} s; `
      + "für präzisen LipSync beide Spuren gemeinsam neu muxen.",
    ));
  }
  if (
    metadata.audioVideoStartDeltaSeconds !== null
    && metadata.audioVideoStartDeltaSeconds !== undefined
    && metadata.audioVideoStartDeltaSeconds > 0.04
  ) {
    findings.push(finding(
      "audio-video-start-drift",
      "warning",
      `Audio- und Videospur starten ${metadata.audioVideoStartDeltaSeconds.toFixed(3)} s versetzt; `
      + "für präzisen LipSync beide Spuren auf denselben Nullpunkt setzen.",
    ));
  }
  if (
    metadata.sampleAspectRatio !== undefined
    && metadata.sampleAspectRatio !== null
    && metadata.sampleAspectRatio !== "1:1"
  ) {
    findings.push(finding(
      "non-square-pixels",
      "warning",
      `Referenzvideo verwendet ein Pixel-Seitenverhältnis von ${metadata.sampleAspectRatio}; vor LipDub auf quadratische Pixel normalisieren.`,
    ));
  }

  const snappedFrames = metadata.frames === null ? null : snapLipDubFrames(metadata.frames);
  if (snappedFrames !== null && snappedFrames < 9) {
    findings.push(finding(
      "insufficient-snapped-frames",
      "error",
      "LipDub-Referenzvideo liefert nach 8k+1-Snapping weniger als 9 Frames.",
    ));
  }

  const officialComfyHq = input.pipelineProfile === "official-comfy-hq";
  const recommendedSize = recommendedLipDubOutputSize(
    metadata,
    officialComfyHq ? OFFICIAL_COMFY_LIPDUB_OUTPUT_AREA : null,
  );
  if (metadata.width === null || metadata.height === null) {
    findings.push(finding(
      "dimensions-unreadable",
      "error",
      `LipDub-Referenzvideo-Maße konnten nicht verlässlich bestimmt werden (${input.path})`,
    ));
  } else {
    if (metadata.width < LIPDUB_MIN_REFERENCE_DIMENSION || metadata.height < LIPDUB_MIN_REFERENCE_DIMENSION) {
      findings.push(finding(
        "dimensions-too-small",
        "error",
        `LipDub-Referenzvideo ist zu klein (${metadata.width} x ${metadata.height}); mindestens ${LIPDUB_MIN_REFERENCE_DIMENSION} px pro Kante verwenden.`,
      ));
    }
    const referenceAspect = metadata.width / metadata.height;
    const outputAspect = input.width / input.height;
    const drift = Math.abs(Math.log(referenceAspect / outputAspect));
    if (drift > LIPDUB_MAX_ASPECT_RATIO_DRIFT) {
      findings.push(finding(
        "aspect-mismatch",
        "error",
        `LipDub-Ausgabeformat passt nicht zum Referenzvideo (${input.width} x ${input.height} vs. ${metadata.width} x ${metadata.height}); Seitenverhältnis angleichen oder Referenz passend zuschneiden.`,
      ));
    }

    const matchesRecommendedSize = recommendedSize !== null
      && recommendedSize.width === input.width
      && recommendedSize.height === input.height;
    if ((metadata.width !== input.width || metadata.height !== input.height) && !matchesRecommendedSize) {
      findings.push(finding(
        "output-size-mismatch",
        "warning",
        `LipDub-Referenz ist ${metadata.width} x ${metadata.height}, Ausgabe ist ${input.width} x ${input.height}. `
        + (officialComfyHq
          ? "Der offizielle Comfy-HQ-Pfad sollte die Referenz proportional auf etwa 1920 x 1088 Pixel Gesamtfläche skalieren."
          : "Für höchste Legacy-Qualität sollte die Ausgabe der Referenzauflösung oder dem nächstliegenden durch 64 teilbaren Format entsprechen."),
      ));
    }
    const aspectDelta = Math.abs(referenceAspect - outputAspect) / referenceAspect;
    if (aspectDelta > 0.02) {
      findings.push(finding(
        "aspect-drift",
        "warning",
        `LipDub-Seitenverhältnis weicht um ${(aspectDelta * 100).toFixed(1)} % ab; `
        + "das kann Gesicht, Mundposition und Identität sichtbar reskalieren.",
      ));
    }
  }

  if (metadata.frames !== null && snappedFrames !== metadata.frames) {
    findings.push(finding(
      "frame-snap",
      "warning",
      `Die native LipDub-Pipeline snappt ${metadata.frames} Referenzframes auf ${snappedFrames} Frames nach 8k+1; `
      + "das Clipende kann dadurch wegfallen.",
    ));
  }
  if (durationSeconds !== null && durationSeconds > 5) {
    findings.push(finding(
      "calibration-clip-recommended",
      "warning",
      `Referenzdauer ist ${durationSeconds.toFixed(1)} s. Für die Kalibrierung zuerst einen 2-5-s-Ausschnitt prüfen, `
      + "danach dieselben Einstellungen auf längere Clips übertragen.",
    ));
  }

  const hasErrors = findings.some((item) => item.level === "error");
  const hasWarnings = findings.some((item) => item.level === "warning");
  return {
    status: hasErrors ? "blocked" : hasWarnings ? "needs-preparation" : "ready",
    metadata: {
      width: metadata.width,
      height: metadata.height,
      frames: metadata.frames,
      snappedFrames,
      droppedFrames: metadata.frames !== null && snappedFrames !== null ? metadata.frames - snappedFrames : null,
      fps: metadata.fps,
      durationSeconds,
      modelDurationSeconds: snappedFrames !== null && metadata.fps !== null
        ? (snappedFrames - 1) / metadata.fps
        : null,
      hasAudio: metadata.hasAudio,
      dialogueWords,
      dialogueWordsPerMinute,
      videoCodec: metadata.videoCodec ?? null,
      pixelFormat: metadata.pixelFormat ?? null,
      constantFrameRate: metadata.constantFrameRate ?? null,
      audioCodec: metadata.audioCodec ?? null,
      audioSampleRate: metadata.audioSampleRate ?? null,
      audioChannels: metadata.audioChannels ?? null,
      audioVideoDurationDeltaSeconds: metadata.audioVideoDurationDeltaSeconds ?? null,
      audioVideoStartDeltaSeconds: metadata.audioVideoStartDeltaSeconds ?? null,
      videoStreamCount: metadata.videoStreamCount ?? 1,
      audioStreamCount: metadata.audioStreamCount ?? (metadata.hasAudio ? 1 : 0),
    },
    recommendedTarget: recommendedSize
      ? { ...recommendedSize, fps: chooseLipDubConstantFps(metadata.fps) }
      : null,
    findings,
  };
}
