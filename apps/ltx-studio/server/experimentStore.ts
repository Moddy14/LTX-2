import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  applyExperimentCandidate,
  controlledExperimentSchema,
  experimentCreateInputSchema,
  experimentKind,
  experimentRunBindingSchema,
  type ControlledExperiment,
  type ExperimentBaselineEvidence,
  type ExperimentCreateInput,
  type ExperimentRunBinding,
  validateControlledExperimentDifference,
} from "../shared/experiments.js";
import type { GenerationRequest } from "../shared/pipelines.js";
import type { StudioOutput } from "../shared/outputs.js";

type ExperimentBoundJob = {
  id: string;
  status: string;
  startedAt: string | null;
  dgxJobId: string | null;
  experiment: ExperimentRunBinding | null;
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

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

  create(
    input: ExperimentCreateInput,
    createdAt = new Date().toISOString(),
    baselineEvidence: ExperimentBaselineEvidence | null = null,
  ): ControlledExperiment {
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
    const armIndex = arm === "baseline" ? 0 : 1;
    const selected = current.arms[armIndex];
    if (selected.jobId) throw new ExperimentConflictError(`Der ${arm === "baseline" ? "Baseline" : "Kandidaten"}arm wurde bereits gestartet.`);
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

  reconcileJobs(jobs: readonly ExperimentBoundJob[]): void {
    for (const job of jobs) {
      const binding = job.experiment;
      if (!binding) continue;
      const current = this.require(binding.experimentId);
      const armIndex = binding.arm === "baseline" ? 0 : 1;
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
      const expected = this.bindingFor(current.id, binding.arm);
      if (JSON.stringify(binding) !== JSON.stringify(expected)) {
        throw new ExperimentConflictError(
          `Job ${job.id} passt nicht zum eingefrorenen Experimentprotokoll.`,
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
    const parsed = controlledExperimentSchema.safeParse(decoded);
    if (parsed.success) return parsed.data;
    const legacyRequestFields = new Set([
      "models.gemmaLora",
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
    ]);
    const usesLegacyRequestSchema = parsed.error.issues.length > 0
      && parsed.error.issues.every((issue) => {
        if (issue.path[0] !== "arms" || typeof issue.path[1] !== "number" || issue.path[2] !== "request") {
          return false;
        }
        return legacyRequestFields.has(issue.path.slice(3).join("."));
      });
    if (usesLegacyRequestSchema) {
      throw new ExperimentConflictError(
        `Experiment ${id} stammt aus einer älteren Studio-Version und bleibt unverändert schreibgeschützt archiviert.`,
      );
    }
    throw new ExperimentConflictError(`Experimentdatei ${id} ist ungültig und wird nicht verwendet.`);
  }

  private write(experiment: ControlledExperiment): void {
    const parsed = controlledExperimentSchema.parse(experiment);
    const path = join(this.root, `${parsed.id}.json`);
    const temporaryPath = `${path}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  }
}
