import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  applyExperimentCandidate,
  controlledExperimentSchema,
  experimentCreateInputSchema,
  experimentKind,
  experimentRequiresFreshBaseline,
  experimentRunBindingSchema,
  supportsA2vGuidanceExperiment,
  supportsPositivePromptExperiment,
  type ControlledExperiment,
  type ExperimentBaselineEvidence,
  type ExperimentCreateInput,
  type ExperimentRunBinding,
  validateControlledExperimentDifference,
} from "../shared/experiments.js";
import type { GenerationRequest } from "../shared/pipelines.js";
import type { StudioOutput } from "../shared/outputs.js";
import { experimentJsonSha256V1 } from "./experimentDigest.js";

type ExperimentBoundJob = {
  id: string;
  status: string;
  startedAt: string | null;
  dgxJobId: string | null;
  experiment: ExperimentRunBinding | null;
};

const TERMINAL_ARCHIVE_RECONCILIATION_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * Request fields that were added after the first persisted experiment.v1
 * files had already been written by released/stable Studio builds.
 *
 * This is deliberately an exact allow-list, not a generic "missing field"
 * migration. A historical omission may make the whole frozen protocol an
 * immutable archive, while an absent/invalid value anywhere else remains a
 * startup-blocking integrity error. Never add a path here merely to make an
 * invalid experiment load.
 */
const LEGACY_REQUIRED_REQUEST_FIELDS = new Set([
  "models.layout",
  "models.generation",
  "models.transformerPath",
  "models.textEncoderPath",
  "models.videoVaePath",
  "models.audioVaePath",
  "models.durationHeadPath",
  "models.promptEnhancerGemmaRoot",
  "models.gemmaLora",
  "models.gemmaLora.enabled",
  "textToAudio",
  "distilled",
  "icLora.controlType",
  "icLora.lora",
  "icLora.mogeModelPath",
  "icLora.hdrTextEmbeddingsPath",
  "icLora.hdrHighQuality",
  "idLora",
  "lipDub.pipelineProfile",
  "postprocess.latentSync",
  "postprocess.museTalk",
  "postprocess.lipForcing",
  "postprocess.lipForcing.rawOutputProfile",
  "postprocess.lipForcing.mouthDelayMs",
  "postprocess.lipForcing.programAudioDelayMs",
]);

// Zod supplies this historical default before returning parsed data, so its
// omission cannot appear in parse issues. It still changes the frozen request
// bytes/hash and must therefore archive the protocol instead of silently
// upgrading it into an executable request.
const LEGACY_DEFAULTED_REQUEST_FIELDS = ["icLora.profile"] as const;

// Kept as the public store helper for existing callers/tests; its algorithm is
// explicitly frozen by experiment.v1 and implemented in one shared server module.
export const sha256Json = experimentJsonSha256V1;

export function requestSettingsSha256(request: GenerationRequest): string {
  const settings = structuredClone(request) as Partial<GenerationRequest>;
  delete settings.outputName;
  return sha256Json(settings);
}

export function outputVerifiesExperimentArmRun(
  output: StudioOutput,
  experiment: ControlledExperiment,
  arm: "baseline" | "candidate",
): boolean {
  if (arm === "baseline") return outputVerifiesExperimentBaseline(output, experiment);
  const selected = experiment.arms[1];
  const binding = output.experiment;
  return Boolean(
    experiment.status === "frozen"
    && experiment.protocolSha256
    && selected.jobId
    && output.name === selected.request.outputName
    && output.jobId === selected.jobId
    && binding?.experimentId === experiment.id
    && binding.protocolSha256 === experiment.protocolSha256
    && binding.arm === "candidate"
    && binding.requestSha256 === selected.requestSha256
    && output.experimentRequestVerified === true
    && output.provenance?.verifiedAt
    && output.provenance.fingerprint.length === 64,
  );
}

export function outputVerifiesExperimentBaseline(
  output: StudioOutput,
  experiment: ControlledExperiment,
): boolean {
  const baseline = experiment.arms[0];
  const binding = output.experiment;
  const adoptedEvidence = experiment.baselineEvidence;
  const bindingMatches = binding?.experimentId === experiment.id
    && binding.protocolSha256 === experiment.protocolSha256
    && binding.arm === "baseline"
    && binding.requestSha256 === baseline.requestSha256;
  const adoptedOutputMatches = adoptedEvidence !== null
    && output.name === adoptedEvidence.outputName
    && output.jobId === adoptedEvidence.jobId
    && output.sizeBytes === adoptedEvidence.sizeBytes
    && output.changedAt === adoptedEvidence.changedAt
    && output.fileId === adoptedEvidence.fileId
    && output.provenance?.fingerprint === adoptedEvidence.provenanceFingerprint;
  return Boolean(
    experiment.status === "frozen"
    && experiment.protocolSha256
    && baseline.jobId
    && output.name === baseline.request.outputName
    && output.jobId === baseline.jobId
    && output.settingsAvailable
    && output.request
    && sha256Json(output.request) === baseline.requestSha256
    && (bindingMatches || adoptedOutputMatches)
    && output.provenance?.verifiedAt
    && output.provenance.fingerprint.length === 64
  );
}

function experimentOutputName(source: string, experimentId: string, arm: "a" | "b"): string {
  const suffix = `-exp-${experimentId.slice(0, 8)}-${arm}.mp4`;
  const base = source.replace(/\.mp4$/i, "").slice(0, Math.max(1, 120 - suffix.length));
  return `${base}${suffix}`;
}

function protocolPayload(experiment: ControlledExperiment): unknown {
  return {
    schemaVersion: experiment.schemaVersion,
    id: experiment.id,
    title: experiment.title,
    claimScope: experiment.claimScope,
    kind: experiment.kind,
    candidate: experiment.candidate,
    changedRequestPaths: experiment.changedRequestPaths,
    createdAt: experiment.createdAt,
    ...(experiment.baselineEvidence ? { baselineEvidence: experiment.baselineEvidence } : {}),
    arms: experiment.arms.map((arm) => ({
      arm: arm.arm,
      request: arm.request,
      requestSha256: arm.requestSha256,
      settingsSha256: arm.settingsSha256,
    })),
  };
}

export class ExperimentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExperimentConflictError";
  }
}

class ArchivedExperimentConflictError extends ExperimentConflictError {
  constructor(id: string) {
    super(
      `Experiment ${id} stammt aus einer älteren Studio-Version und bleibt unverändert schreibgeschützt archiviert.`,
    );
    this.name = "ArchivedExperimentConflictError";
  }
}

export class ExperimentStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  list(): ControlledExperiment[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name))
      .flatMap((entry) => {
        const experiment = this.read(entry.name.slice(0, -5));
        return experiment ? [experiment] : [];
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  listAvailable(): { experiments: ControlledExperiment[]; warnings: string[] } {
    const warnings: string[] = [];
    const experiments = readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^[0-9a-f-]{36}\.json$/i.test(entry.name))
      .flatMap((entry) => {
        try {
          const experiment = this.read(entry.name.slice(0, -5));
          return experiment ? [experiment] : [];
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : `Experimentdatei ${entry.name} ist nicht lesbar.`);
          return [];
        }
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return { experiments, warnings };
  }

  get(id: string): ControlledExperiment | null {
    return this.read(id);
  }

  verifyFrozenIntegrity(id: string): ControlledExperiment {
    const current = this.require(id);
    if (current.status !== "frozen" || !current.protocolSha256) {
      throw new ExperimentConflictError("Das Experiment ist nicht vollständig eingefroren.");
    }
    this.assertFrozenIntegrity(current);
    return current;
  }

  create(
    input: ExperimentCreateInput,
    createdAt = new Date().toISOString(),
    baselineEvidence: ExperimentBaselineEvidence | null = null,
  ): ControlledExperiment {
    if (
      input.candidate.variable === "a2v-guidance"
      && !supportsA2vGuidanceExperiment(input.baselineRequest)
    ) {
      throw new ExperimentConflictError(
        "Der offizielle IA2V-8+3-Pfad verwendet einen guidance-freien SimpleDenoiser-Vertrag; "
        + "dafür darf kein A2V-Guidance-Experiment neu registriert werden.",
      );
    }
    if (
      input.candidate.variable === "positive-prompt"
      && !supportsPositivePromptExperiment(input.baselineRequest)
    ) {
      throw new ExperimentConflictError(
        "Die kontrollierte Positive-Beschreibung ist nur für den offiziellen LTX-2.5-Split-IA2V-Pfad freigegeben.",
      );
    }
    if (
      experimentRequiresFreshBaseline(input.candidate)
      && (input.baselineOutputName !== undefined || baselineEvidence !== null)
    ) {
      throw new ExperimentConflictError(
        "Dieses Experiment darf keine vorhandene Baseline übernehmen; ein frischer Baseline-Arm ist verpflichtend "
        + "und beide Arme müssen identische Ausführungsinputs, Code und Runtime verwenden.",
      );
    }
    const parsed = experimentCreateInputSchema.parse(input);
    const id = randomUUID();
    const baseline = structuredClone(parsed.baselineRequest);
    if (parsed.baselineOutputName) {
      if (!baselineEvidence || baselineEvidence.outputName !== parsed.baselineOutputName) {
        throw new ExperimentConflictError(
          "Die angeforderte vorhandene Baseline wurde nicht mit aktueller Ausgabenprovenienz belegt.",
        );
      }
      baseline.outputName = baselineEvidence.outputName;
    } else {
      if (baselineEvidence) {
        throw new ExperimentConflictError("Baseline-Evidenz ohne ausgewählte vorhandene Ausgabe ist nicht zulässig.");
      }
      baseline.outputName = experimentOutputName(parsed.baselineRequest.outputName, id, "a");
    }
    const candidateRequest = applyExperimentCandidate(baseline, parsed.candidate);
    candidateRequest.outputName = experimentOutputName(parsed.baselineRequest.outputName, id, "b");
    const changedRequestPaths = validateControlledExperimentDifference(
      baseline,
      candidateRequest,
      parsed.candidate,
    );
    const experiment = controlledExperimentSchema.parse({
      schemaVersion: "ltx-studio-experiment.v1",
      id,
      title: parsed.title,
      claimScope: "development",
      status: "draft",
      kind: experimentKind(parsed.candidate),
      candidate: parsed.candidate,
      changedRequestPaths,
      createdAt,
      frozenAt: null,
      supersededAt: null,
      supersededReason: null,
      replacementExperimentId: null,
      baselineEvidence,
      protocolSha256: null,
      arms: [
        {
          arm: "baseline",
          request: baseline,
          requestSha256: sha256Json(baseline),
          settingsSha256: requestSettingsSha256(baseline),
          jobId: baselineEvidence?.jobId ?? null,
          attemptJobIds: baselineEvidence ? [baselineEvidence.jobId] : [],
        },
        {
          arm: "candidate",
          request: candidateRequest,
          requestSha256: sha256Json(candidateRequest),
          settingsSha256: requestSettingsSha256(candidateRequest),
          jobId: null,
          attemptJobIds: [],
        },
      ],
    });
    this.write(experiment);
    return experiment;
  }

  freeze(id: string, frozenAt = new Date().toISOString()): ControlledExperiment {
    const current = this.require(id);
    if (current.status !== "draft") throw new ExperimentConflictError("Das Experiment ist bereits eingefroren.");
    if (
      current.candidate.variable === "a2v-guidance"
      && !supportsA2vGuidanceExperiment(current.arms[0].request)
    ) {
      throw new ExperimentConflictError(
        "Der offizielle IA2V-8+3-Pfad verwendet einen guidance-freien SimpleDenoiser-Vertrag; "
        + "dieser historische Draft darf nicht eingefroren werden.",
      );
    }
    if (
      current.candidate.variable === "positive-prompt"
      && !supportsPositivePromptExperiment(current.arms[0].request)
    ) {
      throw new ExperimentConflictError(
        "Die kontrollierte Positive-Beschreibung ist nur für den offiziellen LTX-2.5-Split-IA2V-Pfad freigegeben; "
        + "dieser Draft darf nicht eingefroren werden.",
      );
    }
    const candidate = applyExperimentCandidate(current.arms[0].request, current.candidate);
    candidate.outputName = current.arms[1].request.outputName;
    const changedRequestPaths = validateControlledExperimentDifference(
      current.arms[0].request,
      candidate,
      current.candidate,
    );
    if (
      sha256Json(current.arms[0].request) !== current.arms[0].requestSha256
      || sha256Json(current.arms[1].request) !== current.arms[1].requestSha256
      || sha256Json(candidate) !== current.arms[1].requestSha256
      || JSON.stringify(changedRequestPaths) !== JSON.stringify(current.changedRequestPaths)
    ) {
      throw new ExperimentConflictError("Der Experimentplan ist nicht mehr mit seinen Request-Hashes konsistent.");
    }
    const frozen = controlledExperimentSchema.parse({
      ...current,
      status: "frozen",
      frozenAt,
      protocolSha256: sha256Json(protocolPayload(current)),
    });
    this.write(frozen);
    return frozen;
  }

  supersede(
    id: string,
    reason: string,
    replacementExperimentId: string | null,
    supersededAt = new Date().toISOString(),
  ): ControlledExperiment {
    const current = this.require(id);
    if (current.status === "superseded") {
      throw new ExperimentConflictError("Das Experiment ist bereits stillgelegt.");
    }
    if (current.arms.some((arm) => arm.jobId || arm.attemptJobIds.length > 0)) {
      throw new ExperimentConflictError(
        "Ein Experiment mit gestarteten oder früher gebundenen Armen darf nicht stillgelegt werden.",
      );
    }
    if (replacementExperimentId === id) {
      throw new ExperimentConflictError("Ein Experiment kann sich nicht selbst ersetzen.");
    }
    if (replacementExperimentId) {
      const replacement = this.require(replacementExperimentId);
      if (replacement.status !== "frozen" || !replacement.protocolSha256) {
        throw new ExperimentConflictError("Das Ersatzexperiment muss bereits eingefroren sein.");
      }
      this.assertFrozenIntegrity(replacement);
    }
    const superseded = controlledExperimentSchema.parse({
      ...current,
      status: "superseded",
      supersededAt,
      supersededReason: reason,
      replacementExperimentId,
    });
    this.write(superseded);
    return superseded;
  }

  bindingFor(
    id: string,
    arm: "baseline" | "candidate",
  ): ExperimentRunBinding {
    const current = this.require(id);
    if (current.status !== "frozen" || !current.protocolSha256) {
      throw new ExperimentConflictError("Das Experiment muss vor dem Start eingefroren werden.");
    }
    this.assertFrozenIntegrity(current);
    this.assertRunnableTreatment(current);
    const armIndex = arm === "baseline" ? 0 : 1;
    const selected = current.arms[armIndex];
    if (selected.jobId) throw new ExperimentConflictError(`Der ${arm === "baseline" ? "Baseline" : "Kandidaten"}arm wurde bereits gestartet.`);
    return this.buildBinding(current, arm);
  }

  /**
   * Builds a non-persisted retry view after the caller has proven that the
   * bound terminal job no longer owns an active DGX queue record.
   *
   * The stored arm remains bound and its attempt history is untouched.  This
   * method exists so read-only preflight and launch can recompute the frozen
   * protocol binding before launch performs one atomic compare-and-swap.
   */
  retryPreflightView(
    id: string,
    arm: "baseline" | "candidate",
    failedJobId: string,
  ): { experiment: ControlledExperiment; binding: ExperimentRunBinding } {
    const current = this.require(id);
    if (current.status !== "frozen" || !current.protocolSha256) {
      throw new ExperimentConflictError("Das Experiment muss vor der Startprüfung eingefroren werden.");
    }
    this.assertFrozenIntegrity(current);
    this.assertRunnableTreatment(current);
    const armIndex = arm === "baseline" ? 0 : 1;
    if (current.arms[armIndex].jobId !== failedJobId) {
      throw new ExperimentConflictError("Der retryfähige Experimentarm hat sich zwischenzeitlich geändert.");
    }
    const arms = structuredClone(current.arms);
    arms[armIndex].jobId = null;
    const experiment = controlledExperimentSchema.parse({ ...current, arms });
    return { experiment, binding: this.buildBinding(experiment, arm) };
  }

  private buildBinding(
    current: ControlledExperiment,
    arm: "baseline" | "candidate",
  ): ExperimentRunBinding {
    const armIndex = arm === "baseline" ? 0 : 1;
    const selected = current.arms[armIndex];
    const baselineJobId = current.arms[0].jobId;
    if (arm === "candidate" && !baselineJobId) {
      throw new ExperimentConflictError("Der Baseline-Arm muss vor dem Kandidatenarm gestartet werden.");
    }
    const binding = experimentRunBindingSchema.parse({
      schemaVersion: "ltx-studio-experiment-run.v1",
      experimentId: current.id,
      protocolSha256: current.protocolSha256,
      arm,
      kind: current.kind,
      variableId: current.candidate.variable,
      changedRequestPaths: current.changedRequestPaths,
      baselineRequestSha256: current.arms[0].requestSha256,
      requestSha256: selected.requestSha256,
      baselineJobId: arm === "candidate" ? baselineJobId : null,
      baselineOutputName: current.arms[0].request.outputName,
      ...(arm === "candidate" && current.baselineEvidence
        ? { adoptedBaseline: true as const }
        : {}),
    });
    return binding;
  }

  private assertRunnableTreatment(experiment: ControlledExperiment): void {
    if (
      experiment.candidate.variable === "a2v-guidance"
      && !supportsA2vGuidanceExperiment(experiment.arms[0].request)
    ) {
      throw new ExperimentConflictError(
        "Der historische IA2V-Guidance-Arm bleibt als Evidenz lesbar, darf aber nicht gestartet werden: "
        + "der offizielle SimpleDenoiser-Vertrag konsumiert die kontrollierte Variable nicht.",
      );
    }
    if (
      experiment.candidate.variable === "positive-prompt"
      && !supportsPositivePromptExperiment(experiment.arms[0].request)
    ) {
      throw new ExperimentConflictError(
        "Der Positive-Beschreibung-Arm darf nicht gestartet werden: "
        + "nur der offizielle LTX-2.5-Split-IA2V-Pfad besitzt den belegten ausführbaren Prompt-Vertrag.",
      );
    }
  }

  reconcileJobs(jobs: readonly ExperimentBoundJob[]): void {
    for (const job of jobs) {
      const binding = job.experiment;
      if (!binding) continue;
      let current: ControlledExperiment;
      try {
        current = this.require(binding.experimentId);
      } catch (error) {
        // Historical terminal records are immutable audit history. A newly
        // required request field must neither rewrite their request/hash bytes
        // nor prevent the current store from starting. Active jobs remain
        // fail-closed, and corruption/unknown schema drift is never swallowed.
        if (
          error instanceof ArchivedExperimentConflictError
          && TERMINAL_ARCHIVE_RECONCILIATION_STATUSES.has(job.status)
        ) {
          continue;
        }
        throw error;
      }
      const armIndex = binding.arm === "baseline" ? 0 : 1;
      this.assertFrozenIntegrity(current);
      const expected = this.buildBinding(current, binding.arm);
      if (JSON.stringify(binding) !== JSON.stringify(expected)) {
        throw new ExperimentConflictError(
          `Job ${job.id} passt nicht zum eingefrorenen Experimentprotokoll.`,
        );
      }
      const boundJobId = current.arms[armIndex].jobId;
      if (boundJobId === job.id) continue;
      if (current.arms[armIndex].attemptJobIds.includes(job.id)) continue;
      if (
        job.status === "interrupted"
        && job.startedAt === null
        && job.dgxJobId === null
      ) {
        continue;
      }
      if (boundJobId) {
        throw new ExperimentConflictError(
          `Experiment ${current.id} enthält widersprüchliche Jobs für den ${binding.arm}-Arm.`,
        );
      }
      this.attachJob(current.id, binding.arm, job.id);
    }
  }

  attachJob(
    id: string,
    arm: "baseline" | "candidate",
    jobId: string,
  ): ControlledExperiment {
    const binding = this.bindingFor(id, arm);
    void binding;
    const current = this.require(id);
    const armIndex = arm === "baseline" ? 0 : 1;
    const arms = structuredClone(current.arms);
    arms[armIndex].jobId = jobId;
    if (!arms[armIndex].attemptJobIds.includes(jobId)) arms[armIndex].attemptJobIds.push(jobId);
    const experiment = controlledExperimentSchema.parse({ ...current, arms });
    this.write(experiment);
    return experiment;
  }

  releaseArmForRetry(
    id: string,
    arm: "baseline" | "candidate",
    failedJobId: string,
  ): ControlledExperiment {
    const current = this.require(id);
    this.assertFrozenIntegrity(current);
    const armIndex = arm === "baseline" ? 0 : 1;
    if (current.arms[armIndex].jobId !== failedJobId) {
      throw new ExperimentConflictError("Der fehlgeschlagene Experimentarm hat sich zwischenzeitlich geändert.");
    }
    const arms = structuredClone(current.arms);
    arms[armIndex].jobId = null;
    const experiment = controlledExperimentSchema.parse({ ...current, arms });
    this.write(experiment);
    return experiment;
  }

  /**
   * Atomically replaces one proven retryable arm binding without ever
   * persisting an unbound intermediate state.  The failed job remains in the
   * append-only attempt history.
   */
  replaceArmJobForRetry(
    id: string,
    arm: "baseline" | "candidate",
    failedJobId: string,
    nextJobId: string,
  ): ControlledExperiment {
    const current = this.require(id);
    if (current.status !== "frozen" || !current.protocolSha256) {
      throw new ExperimentConflictError("Das Experiment muss für einen Wiederanlauf eingefroren bleiben.");
    }
    this.assertFrozenIntegrity(current);
    const armIndex = arm === "baseline" ? 0 : 1;
    if (current.arms[armIndex].jobId !== failedJobId) {
      throw new ExperimentConflictError("Der fehlgeschlagene Experimentarm hat sich zwischenzeitlich geändert.");
    }
    const arms = structuredClone(current.arms);
    arms[armIndex].jobId = nextJobId;
    if (!arms[armIndex].attemptJobIds.includes(nextJobId)) {
      arms[armIndex].attemptJobIds.push(nextJobId);
    }
    const experiment = controlledExperimentSchema.parse({ ...current, arms });
    this.write(experiment);
    return experiment;
  }

  private require(id: string): ControlledExperiment {
    const value = this.read(id);
    if (!value) throw new ExperimentConflictError("Experiment nicht gefunden.");
    return value;
  }

  private assertFrozenIntegrity(experiment: ControlledExperiment): void {
    const candidate = applyExperimentCandidate(experiment.arms[0].request, experiment.candidate);
    candidate.outputName = experiment.arms[1].request.outputName;
    const changedRequestPaths = validateControlledExperimentDifference(
      experiment.arms[0].request,
      candidate,
      experiment.candidate,
    );
    const requestsMatch = sha256Json(experiment.arms[0].request) === experiment.arms[0].requestSha256
      && sha256Json(experiment.arms[1].request) === experiment.arms[1].requestSha256
      && sha256Json(candidate) === experiment.arms[1].requestSha256;
    const settingsMatch = requestSettingsSha256(experiment.arms[0].request) === experiment.arms[0].settingsSha256
      && requestSettingsSha256(experiment.arms[1].request) === experiment.arms[1].settingsSha256;
    const protocolMatches = experiment.protocolSha256 === sha256Json(protocolPayload(experiment));
    if (
      !requestsMatch
      || !settingsMatch
      || !protocolMatches
      || experiment.kind !== experimentKind(experiment.candidate)
      || JSON.stringify(changedRequestPaths) !== JSON.stringify(experiment.changedRequestPaths)
    ) {
      throw new ExperimentConflictError(
        "Das eingefrorene Experimentprotokoll ist nicht mehr hashkonsistent und wird nicht gestartet.",
      );
    }
  }

  private read(id: string): ControlledExperiment | null {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const path = join(this.root, `${id}.json`);
    if (!existsSync(path)) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new ExperimentConflictError(`Experimentdatei ${id} ist beschädigt und wird nicht verwendet.`);
    }
    const pathIsExactlyMissing = (path: readonly PropertyKey[]): boolean => {
      let current: unknown = decoded;
      for (const [index, key] of path.entries()) {
        if (!current || typeof current !== "object") return false;
        if (!Object.hasOwn(current, key)) return index === path.length - 1;
        current = (current as Record<PropertyKey, unknown>)[key];
      }
      return false;
    };
    const parsed = controlledExperimentSchema.safeParse(decoded);
    const hasDefaultedLegacyRequestOmission = (
      Array.isArray((decoded as { arms?: unknown } | null)?.arms)
      && (decoded as { arms: unknown[] }).arms.some((_arm, armIndex) =>
        LEGACY_DEFAULTED_REQUEST_FIELDS.some((field) =>
          pathIsExactlyMissing(["arms", armIndex, "request", ...field.split(".")]),
        ),
      )
    );
    if (parsed.success) {
      if (hasDefaultedLegacyRequestOmission) throw new ArchivedExperimentConflictError(id);
      return parsed.data;
    }
    const usesLegacyRequestSchema = parsed.error.issues.length > 0
      && parsed.error.issues.every((issue) => {
        if (issue.path[0] !== "arms" || typeof issue.path[1] !== "number" || issue.path[2] !== "request") {
          return false;
        }
        return (issue.code === "invalid_type" || issue.code === "invalid_value")
          && LEGACY_REQUIRED_REQUEST_FIELDS.has(issue.path.slice(3).join("."))
          && pathIsExactlyMissing(issue.path);
      });
    if (usesLegacyRequestSchema) {
      throw new ArchivedExperimentConflictError(id);
    }
    throw new ExperimentConflictError(`Experimentdatei ${id} ist ungültig und wird nicht verwendet.`);
  }

  private write(experiment: ControlledExperiment): void {
    const parsed = controlledExperimentSchema.parse(experiment);
    const path = join(this.root, `${parsed.id}.json`);
    const temporaryPath = join(this.root, `.${parsed.id}.${randomUUID()}.tmp`);
    let descriptor: number | null = null;
    let directoryDescriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, path);
      // The arm CAS is allowed to release JobManager's durable start fence
      // only after both file contents and the directory rename are stable
      // across a kernel/power loss.
      directoryDescriptor = openSync(this.root, "r");
      fsyncSync(directoryDescriptor);
      closeSync(directoryDescriptor);
      directoryDescriptor = null;
    } catch (error) {
      // Cleanup must never mask the persistence/fsync error that determines
      // whether the surrounding CAS commit is certain or ambiguous.
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original write/fsync/rename failure.
        }
      }
      if (directoryDescriptor !== null) {
        try {
          closeSync(directoryDescriptor);
        } catch {
          // Preserve the original durability failure.
        }
      }
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // The UUID temporary path is never authoritative; retain the original
        // failure so the route can reconcile the possibly committed arm.
      }
      throw error;
    }
  }
}
