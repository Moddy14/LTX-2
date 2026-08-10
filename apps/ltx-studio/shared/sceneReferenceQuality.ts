export const MIN_SCENE_REFERENCE_FACE_SHARPNESS = 35;

export function sceneReferenceTooSoftMessage(measuredSharpness: number): string {
  return `Kein geeigneter Referenzframe: Das Gesicht ist im gesamten Video zu weich `
    + `(beste Schärfe ${measuredSharpness.toLocaleString("de-AT", { maximumFractionDigits: 1 })}, `
    + `benötigt mindestens ${MIN_SCENE_REFERENCE_FACE_SHARPNESS}). Verwende ein schärferes Ausgangsvideo oder ein Originalbild.`;
}
