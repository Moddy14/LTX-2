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
  };
  command: string;
};
