import {
  experimentRequiresFreshBaseline,
  type ExperimentCandidate,
  type ExperimentCreateInput,
} from "../shared/experiments.js";
import type { GenerationRequest } from "../shared/pipelines.js";

export function buildExperimentCreateInput(options: {
  title: string;
  baselineRequest: GenerationRequest;
  candidate: ExperimentCandidate;
  reusableBaselineOutputName: string | null;
}): ExperimentCreateInput {
  return {
    title: options.title,
    baselineRequest: options.baselineRequest,
    ...(options.reusableBaselineOutputName
      && !experimentRequiresFreshBaseline(options.candidate)
      ? { baselineOutputName: options.reusableBaselineOutputName }
      : {}),
    candidate: options.candidate,
  };
}
