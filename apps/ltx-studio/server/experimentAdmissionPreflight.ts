import { statSync } from "node:fs";

import type {
  AdmissionPreflightReport,
  AdmissionPreflightStep,
} from "../shared/admissionPreflight.js";
import type {
  ControlledExperiment,
  ExperimentRunBinding,
} from "../shared/experiments.js";
import {
  supportsA2vGuidanceExperiment,
  supportsPositivePromptExperiment,
} from "../shared/experiments.js";
import type { StudioOutput } from "../shared/outputs.js";
import {
  publishedOutputIsReusableLipForcingVisual,
  reusableLipForcingOutputFromSidecars,
  type ReusableLtxBaseCandidate,
} from "./jobs.js";
import {
  outputVerifiesExperimentBaseline,
  sha256Json,
} from "./experimentStore.js";
import {
  admissionPreflight,
  qualificationHoldAdmissionPreflight,
} from "./admission.js";

type ExperimentArm = "baseline" | "candidate";

export type ExperimentAdmissionPreflightContext = {
  binding: ExperimentRunBinding;
  outputs: readonly StudioOutput[];
  reusableCandidates: readonly ReusableLtxBaseCandidate[];
  fileReady?: (path: string) => boolean;
  verifyRawMuxPairAuthority?: (
    request: ControlledExperiment["arms"][number]["request"],
    binding: ExperimentRunBinding,
  ) => { description: string } | { error: string };
};

function localFileReady(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

function audioOnlyReuseFailure(reason: string, checkedAt: string): AdmissionPreflightReport {
  const step: AdmissionPreflightStep = {
    label: "Audio-only-Reuse-Nachweis",
    estimatedMemoryGiB: 0,
    decision: "nicht-pruefbar",
    accepted: false,
    message: reason,
  };
  return {
    checkedAt,
    verdict: "nicht-pruefbar",
    notes: [
      `CPU-only wird nicht zugesagt: ${reason}`,
      "Ohne unveränderte gebundene Baseline- und Sidecar-Evidenz gilt für einen späteren Start wieder der reguläre DGX-Plan.",
    ],
    steps: [step],
  };
}

function rawMuxPairFailure(reason: string, checkedAt: string): AdmissionPreflightReport {
  return {
    checkedAt,
    verdict: "nicht-pruefbar",
    notes: [
      `CPU-only Raw-Mux-Promotion wird nicht zugesagt: ${reason}`,
      "Der Kandidat fällt niemals auf DGX oder einen zweiten Mux zurück; erforderlich ist eine neue, unverändert versiegelte gepaarte Baseline.",
    ],
    steps: [{
      label: "Gepaarte Raw-Mux-Artefakt-Promotion",
      estimatedMemoryGiB: 0,
      decision: "nicht-pruefbar",
      accepted: false,
      message: reason,
    }],
  };
}

export function unverifiableExperimentAdmissionPreflight(
  reason: string,
  options: { audioOnly?: boolean; rawMuxPair?: boolean; checkedAt?: string } = {},
): AdmissionPreflightReport {
  const checkedAt = options.checkedAt ?? new Date().toISOString();
  if (options.audioOnly) return audioOnlyReuseFailure(reason, checkedAt);
  if (options.rawMuxPair) return rawMuxPairFailure(reason, checkedAt);
  return {
    checkedAt,
    verdict: "nicht-pruefbar",
    notes: [
      `Die serverseitige Experimentprüfung wurde fail-closed beendet: ${reason}`,
      "Es wurde weder eine CPU-only-Zusage noch eine DGX-Startentscheidung abgeleitet.",
    ],
    steps: [{
      label: "Experimentprotokoll-Nachweis",
      estimatedMemoryGiB: 0,
      decision: "nicht-pruefbar",
      accepted: false,
      message: reason,
    }],
  };
}

export function isProgramAudioOnlyCandidate(experiment: ControlledExperiment, arm: ExperimentArm): boolean {
  return arm === "candidate"
    && experiment.candidate.variable === "lipforcing-program-audio-delay-ms"
    && experiment.changedRequestPaths.length === 1
    && experiment.changedRequestPaths[0] === "postprocess.lipForcing.programAudioDelayMs";
}

export function isRawMuxPairCandidate(experiment: ControlledExperiment, arm: ExperimentArm): boolean {
  return arm === "candidate"
    && experiment.candidate.variable === "lipforcing-raw-output-profile"
    && experiment.changedRequestPaths.length === 1
    && experiment.changedRequestPaths[0] === "postprocess.lipForcing.rawOutputProfile";
}

function verifyBoundAudioOnlyReuse(
  experiment: ControlledExperiment,
  context: ExperimentAdmissionPreflightContext,
): { description: string; deltaMs: number } | { error: string } {
  if (experiment.status !== "frozen" || !experiment.protocolSha256) {
    return { error: "Das Experiment ist nicht eingefroren und hashgebunden." };
  }
  const baseline = experiment.arms[0];
  const candidate = experiment.arms[1];
  const binding = context.binding;
  if (
    binding.experimentId !== experiment.id
    || binding.protocolSha256 !== experiment.protocolSha256
    || binding.arm !== "candidate"
    || binding.variableId !== experiment.candidate.variable
    || binding.changedRequestPaths.length !== 1
    || binding.changedRequestPaths[0] !== "postprocess.lipForcing.programAudioDelayMs"
    || binding.baselineRequestSha256 !== baseline.requestSha256
    || binding.requestSha256 !== candidate.requestSha256
    || binding.baselineJobId !== baseline.jobId
    || binding.baselineOutputName !== baseline.request.outputName
  ) {
    return { error: "Die serverseitige Arm-Bindung stimmt nicht mit dem eingefrorenen Audio-only-Protokoll überein." };
  }
  if (
    sha256Json(baseline.request) !== baseline.requestSha256
    || sha256Json(candidate.request) !== candidate.requestSha256
  ) {
    return { error: "Die eingefrorenen Arm-Requests stimmen nicht mehr mit ihren Hashes überein." };
  }
  if (!publishedOutputIsReusableLipForcingVisual(baseline.request, candidate.request)) {
    return { error: "Baseline und Kandidat unterscheiden sich nicht ausschließlich im hörbaren LipForcing-Tonversatz." };
  }
  const baselineOutput = context.outputs.find((output) =>
    outputVerifiesExperimentBaseline(output, experiment));
  if (!baselineOutput?.provenance?.verifiedAt) {
    return { error: "Die tatsächlich gebundene Baseline-Ausgabe ist nicht unverändert und provenienzverifiziert verfügbar." };
  }
  const sidecar = context.reusableCandidates.find((item) =>
    item.outputName === baselineOutput.name
    && item.jobId === baselineOutput.jobId
    && sha256Json(item.request) === baseline.requestSha256
    && item.runProvenance.fingerprint === baselineOutput.provenance?.fingerprint);
  if (!sidecar) {
    return { error: "Der aktuelle Baseline-Sidecar bindet Request, Datei, Identität und Laufprovenienz nicht vollständig." };
  }
  const reusable = reusableLipForcingOutputFromSidecars(
    [sidecar],
    {
      id: experiment.id,
      request: candidate.request,
      // The candidate references the exact same inputs. Reusing the verified
      // source evidence here proves the preflight predicate; the JobRunner
      // captures and verifies the candidate evidence again immediately before
      // the real retime.
      identityEvidence: sidecar.identityEvidence,
    },
    context.fileReady ?? localFileReady,
  );
  if (!reusable || reusable.id !== baseline.jobId) {
    return { error: "Die gebundene Baseline erfüllt den fail-closed Reuse-Prädikat des JobRunners nicht." };
  }
  const deltaMs = candidate.request.postprocess.lipForcing.programAudioDelayMs
    - reusable.programAudioDelayMs;
  if (!Number.isInteger(deltaMs) || deltaMs === 0 || deltaMs < -1_000 || deltaMs > 1_000) {
    return { error: "Die gebundene Tonversatzdifferenz ist für den Audio-only-Retime nicht gültig." };
  }
  return { description: reusable.description, deltaMs };
}

/**
 * Experiment-aware read-only start check. It never infers reuse from a browser
 * request: only the server's frozen protocol plus its current output sidecars
 * may establish the CPU-only path.
 */
export async function experimentAdmissionPreflight(
  experiment: ControlledExperiment,
  arm: ExperimentArm,
  context: ExperimentAdmissionPreflightContext,
  regularPreflight: typeof admissionPreflight = admissionPreflight,
  checkedAt = new Date().toISOString(),
): Promise<AdmissionPreflightReport> {
  const selected = experiment.arms[arm === "baseline" ? 0 : 1];
  const qualificationHold = qualificationHoldAdmissionPreflight(selected.request, checkedAt);
  if (qualificationHold) return qualificationHold;
  if (
    experiment.candidate.variable === "a2v-guidance"
    && !supportsA2vGuidanceExperiment(experiment.arms[0].request)
  ) {
    return unverifiableExperimentAdmissionPreflight(
      "Der eingefrorene A2V-Guidance-Arm ist für den offiziellen IA2V-8+3-Pfad nicht ausführbar: "
      + "dessen SimpleDenoiser-Vertrag konsumiert diesen Wert nicht.",
      { checkedAt },
    );
  }
  if (
    experiment.candidate.variable === "positive-prompt"
    && !supportsPositivePromptExperiment(experiment.arms[0].request)
  ) {
    return unverifiableExperimentAdmissionPreflight(
      "Der eingefrorene Positive-Beschreibung-Arm liegt außerhalb des freigegebenen "
      + "LTX-2.5-Split-IA2V-Prompt-Vertrags.",
      { checkedAt },
    );
  }
  if (isRawMuxPairCandidate(experiment, arm)) {
    const proof = context.verifyRawMuxPairAuthority?.(selected.request, context.binding)
      ?? { error: "Der Server besitzt keinen Raw-Mux-Paar-Authority-Prüfer." };
    if ("error" in proof) return rawMuxPairFailure(proof.error, checkedAt);
    return {
      checkedAt,
      verdict: "start-frei",
      executionClass: "cpu-only",
      notes: [
        `Serverseitig verifiziert: ${proof.description}`,
        "Der JobRunner recaptured Eingaben und Autorität beim Start; jede Drift beendet den Lauf ohne DGX-Fallback.",
      ],
      steps: [{
        label: "Gepaarte Raw-Mux-Artefakt-Promotion",
        estimatedMemoryGiB: 0,
        decision: "paired-artifact-promotion",
        accepted: true,
        message: "Der bereits mit der Baseline erzeugte private Kandidatenarm wird nach serverseitigem Replay-Beweis nur gesnapshottet und atomar publiziert; kein DGX-, Docker- oder produktiver Timeline-/Mux-Lauf.",
      }],
    };
  }
  if (!isProgramAudioOnlyCandidate(experiment, arm)) {
    return regularPreflight(selected.request);
  }
  const proof = verifyBoundAudioOnlyReuse(experiment, context);
  if ("error" in proof) return audioOnlyReuseFailure(proof.error, checkedAt);
  return {
    checkedAt,
    verdict: "start-frei",
    executionClass: "cpu-only",
    notes: [
      `Serverseitig verifiziert: ${proof.description} sowie Request-, Datei-, Identitäts- und Laufprovenienz sind an das eingefrorene Experiment gebunden.`,
      "Der JobRunner prüft dieselben Evidenzen beim Start erneut; bei Drift entfällt die CPU-only-Zusage.",
    ],
    steps: [{
      label: "CPU-only Audio-Retime",
      estimatedMemoryGiB: 0,
      decision: "cpu-only-provenance-reuse",
      accepted: true,
      message: `FFmpeg kopiert den verifizierten Bildstrom und verschiebt nur den hörbaren Ton relativ um ${proof.deltaMs >= 0 ? "+" : ""}${proof.deltaMs} ms; kein DGX-Lauf erforderlich.`,
    }],
  };
}
