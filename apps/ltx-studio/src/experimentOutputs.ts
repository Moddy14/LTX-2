import type { PublicControlledExperiment as ControlledExperiment } from "../shared/outputPublic.js";
import type { StudioOutput } from "./types.js";

export function outputForArm(
  experiment: ControlledExperiment,
  arm: 0 | 1,
  outputs: StudioOutput[],
): StudioOutput | undefined {
  const selected = experiment.arms[arm];
  // An adopted baseline predates the experiment, so its sidecar can never carry
  // the experiment binding; its identity is pinned by the recorded provenance
  // fingerprint instead.
  const adopted = arm === 0 ? experiment.baselineEvidence : null;
  if (adopted) {
    return outputs.find((output) =>
      output.name === adopted.outputName
      && output.jobId === adopted.jobId
      && output.sizeBytes === adopted.sizeBytes
      && output.changedAt === adopted.changedAt
      && output.provenanceSummary?.status === "verified",
    );
  }
  return outputs.find((output) =>
    output.name === selected.request.outputName
    && output.jobId === selected.jobId
    && output.experiment?.experimentId === experiment.id
    && output.experiment.arm === selected.arm
    && output.experimentRequestVerified === true
    && output.provenanceSummary?.status === "verified",
  );
}
