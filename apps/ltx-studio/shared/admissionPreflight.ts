import { estimateResources } from "./estimates.js";
import type { GenerationRequest } from "./pipelines.js";

export type AdmissionPreflightStepPlan = {
  label: string;
  estimatedMemoryGiB: number;
};

export type AdmissionPreflightStep = AdmissionPreflightStepPlan & {
  decision: string;
  accepted: boolean;
  message: string;
};

export type AdmissionPreflightVerdict = "start-frei" | "wartet" | "nicht-pruefbar";

export type AdmissionPreflightReport = {
  checkedAt: string;
  verdict: AdmissionPreflightVerdict;
  notes: string[];
  steps: AdmissionPreflightStep[];
};

// Single source for the refiner admission budget; the job runner submits the
// exact same figure to the DGX queue before the refiner stage starts.
export function refinerAdmissionMemoryGiB(request: GenerationRequest): number | null {
  const post = request.postprocess;
  if (!post.lipForcing.enabled && !post.latentSync.enabled && !post.museTalk.enabled) return null;
  return post.lipForcing.enabled ? 52 : post.latentSync.enabled ? 24 : 16;
}

export function admissionPreflightPlan(request: GenerationRequest): {
  steps: AdmissionPreflightStepPlan[];
  notes: string[];
} {
  const steps: AdmissionPreflightStepPlan[] = [{
    label: `LTX-Render (${request.mode})`,
    estimatedMemoryGiB: estimateResources(request).memoryGiB,
  }];
  const refiner = refinerAdmissionMemoryGiB(request);
  if (refiner !== null) {
    const name = request.postprocess.lipForcing.enabled
      ? "LipForcing"
      : request.postprocess.latentSync.enabled ? "LatentSync" : "MuseTalk";
    steps.push({ label: `${name}-Refiner`, estimatedMemoryGiB: refiner });
  }
  const notes: string[] = [];
  if (request.postprocess.longcatLipsync.enabled) {
    notes.push("Die LongCat-Stufe lässt der LongCat-Supervisor separat zu; sie ist hier nicht enthalten.");
  }
  notes.push(
    "Momentaufnahme ohne Reservierung: Die verbindliche Entscheidung fällt erneut beim Start-Fence des Orchestrators.",
  );
  return { steps, notes };
}
