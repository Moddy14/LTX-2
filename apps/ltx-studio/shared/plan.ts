import type { GenerationRequest } from "./pipelines.js";
import type { StudioAsset } from "./assets.js";

export type PlanSuggestion = {
  id: "lipdub-reference-format";
  level: "info";
  label: string;
  message: string;
  patch: Partial<Pick<GenerationRequest, "width" | "height">>;
};

export type PreparedLipDubReference = {
  asset: StudioAsset;
  target: {
    width: number;
    height: number;
    fps: 24 | 25 | 30;
    frames: number;
    durationSeconds: number;
  };
  trim: {
    startSeconds: number;
    requestedDurationSeconds: number;
  } | null;
  command: string;
};

export type PreparedImageCrop = {
  asset: StudioAsset;
  source: {
    width: number;
    height: number;
  };
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  target: {
    width: number;
    height: number;
  };
  /**
   * "stretch" zieht den Ausschnitt auf die Zielmaße - richtig, wenn beide
   * Seitenverhältnisse passen. "bokeh" passt ihn stattdessen proportional ein
   * und füllt den Rest mit einer weichgezeichneten Fassung desselben
   * Ausschnitts, mit weich auslaufender Kante. Das ist der Weg, ein Porträt in
   * einen Breitbildrahmen zu setzen, ohne es zu quetschen und ohne harte
   * Balken: Ein Erstframe mit Balken ist für die Bildkonditionierung ein
   * Fremdkörper und schlägt als sichtbarer Sprung in den Clip durch.
   */
  fit: ImageCropFit;
  /** Nur bei "bokeh": Anteil der Zielhöhe, den der Ausschnitt einnimmt. */
  coverage: number | null;
  /** Nur bei "bokeh": Breite der weichen Kante in Pixeln. */
  feather: number | null;
  scaleFilter: "lanczos";
  command: string;
};

export type ImageCropFit = "stretch" | "bokeh";

export type LipDubReferenceFinding = {
  code: string;
  level: "error" | "warning";
  message: string;
};

export type LipDubReferenceDiagnostics = {
  status: "ready" | "needs-preparation" | "blocked";
  metadata: {
    width: number | null;
    height: number | null;
    frames: number | null;
    snappedFrames: number | null;
    droppedFrames: number | null;
    fps: number | null;
    durationSeconds: number | null;
    modelDurationSeconds: number | null;
    hasAudio: boolean | null;
    dialogueWords: number;
    dialogueWordsPerMinute: number | null;
    videoCodec: string | null;
    pixelFormat: string | null;
    constantFrameRate: boolean | null;
    audioCodec: string | null;
    audioSampleRate: number | null;
    audioChannels: number | null;
    audioVideoDurationDeltaSeconds: number | null;
    audioVideoStartDeltaSeconds: number | null;
    videoStreamCount: number;
    audioStreamCount: number;
  } | null;
  recommendedTarget: {
    width: number;
    height: number;
    fps: 24 | 25 | 30;
  } | null;
  findings: LipDubReferenceFinding[];
};
