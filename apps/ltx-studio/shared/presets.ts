export type ResolutionPreset = {
  id: string;
  label: string;
  width: number;
  height: number;
  tier: "draft" | "production" | "hq";
};

export const RESOLUTION_PRESETS: readonly ResolutionPreset[] = [
  { id: "draft-landscape", label: "Entwurf quer", width: 1280, height: 704, tier: "draft" },
  { id: "production-landscape", label: "Produktion quer", width: 1536, height: 1024, tier: "production" },
  { id: "full-hd-landscape", label: "Full HD quer", width: 1920, height: 1088, tier: "hq" },
  { id: "production-portrait", label: "Produktion hoch", width: 1024, height: 1536, tier: "production" },
  { id: "full-hd-portrait", label: "Full HD hoch", width: 1088, height: 1920, tier: "hq" },
  { id: "square", label: "Quadrat", width: 1024, height: 1024, tier: "production" },
] as const;

export const DURATION_PRESETS = [5, 10, 20] as const;

export function framesForDuration(seconds: number, frameRate: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(frameRate) || frameRate <= 0) return 1;
  const intervals = Math.max(0, Math.round((seconds * frameRate) / 8) * 8);
  return intervals + 1;
}

export function videoDurationSeconds(numFrames: number, frameRate: number): number {
  if (!Number.isFinite(numFrames) || !Number.isFinite(frameRate) || frameRate <= 0) return 0;
  return Math.max(0, numFrames - 1) / frameRate;
}

export function matchingResolutionPreset(width: number, height: number): ResolutionPreset | null {
  return RESOLUTION_PRESETS.find((preset) => preset.width === width && preset.height === height) ?? null;
}

export function matchingDurationPreset(numFrames: number, frameRate: number): number | null {
  return DURATION_PRESETS.find((seconds) => framesForDuration(seconds, frameRate) === numFrames) ?? null;
}

export function formatDuration(seconds: number): string {
  return `${seconds.toLocaleString("de-AT", { maximumFractionDigits: 1 })} s`;
}
