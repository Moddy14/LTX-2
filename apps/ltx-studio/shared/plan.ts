import type { GenerationRequest } from "./pipelines.js";

export type PlanSuggestion = {
  id: "lipdub-reference-format";
  level: "info";
  label: string;
  message: string;
  patch: Partial<Pick<GenerationRequest, "width" | "height">>;
};
