import type { StudioJob } from "./types";

export function executionClassLabel(job: StudioJob): string {
  if (job.executionClass === "cpu-only") {
    return job.executionDecisionSummary?.cpuReuse?.operationKind === "paired-artifact-promotion"
      ? "CPU-only Paar-Promotion"
      : "CPU-only Audio-Retime";
  }
  if (job.executionClass === "dgx") return "DGX-Render";
  if (job.executionClass === "pending") return "Klassifizierung ausstehend";
  return "Nicht klassifiziert (Legacy)";
}
