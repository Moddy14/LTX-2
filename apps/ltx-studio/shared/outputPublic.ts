import type {
  ControlledExperiment,
  ExperimentRunBinding,
} from "./experiments.js";
import type {
  ObjectiveQualityAnalysis,
  OutputAnalysisRecord,
} from "./objectiveQuality.js";
import type { GenerationRequest } from "./pipelines.js";
import type {
  ProjectRevisionEnvelope,
  ProjectRunBinding,
} from "./projects.js";
import type { JobQualityReview } from "./quality.js";
import type { T2aAudioPublicAnalysisRecord } from "./t2aAudioPublic.js";

type PrivateAnalysisDetailKey =
  | "modelSha256"
  | "modelRevision"
  | "expectedTranscriptSha256"
  | "runnerFingerprint"
  | "expectedDialogueSha256"
  | "manifestReleaseId"
  | "manifestSha256";

type PublicAnalysisValue<T> = T extends readonly (infer Item)[]
  ? PublicAnalysisValue<Item>[]
  : T extends object
    ? {
        [Key in keyof T as Key extends PrivateAnalysisDetailKey ? never : Key]:
          PublicAnalysisValue<T[Key]>
      }
    : T;

/** Measurement values needed by the browser, with evaluator authority removed. */
export type PublicObjectiveQualityAnalysis = PublicAnalysisValue<ObjectiveQualityAnalysis>;

export type PublicAnalysisEquality = {
  evaluator: string | null;
  expectedDialogue: string | null;
  identityModel: string | null;
};

export type PublicOutputAnalysisRecord = {
  schemaVersion: "ltx-studio-public-output-analysis.v1";
  sourceSchemaVersion: OutputAnalysisRecord["schemaVersion"];
  outputName: string;
  outputRevisionToken: string;
  jobId: string;
  analysisId: string;
  attempt: number;
  status: OutputAnalysisRecord["status"];
  progress: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  error: { code: string; message: string } | null;
  equality: PublicAnalysisEquality;
  result: PublicObjectiveQualityAnalysis | null;
};

export type PublicOutputProvenanceSummary = {
  schemaVersion: "ltx-studio-public-output-provenance-summary.v1";
  status: "captured-unverified" | "verified";
  capturedAt: string;
  verifiedAt: string | null;
  release: { sealed: boolean; verified: boolean } | null;
  /**
   * Process-scoped, keyed equality tokens. They prove equality only inside the
   * current Studio browser session and are not persisted authority digests.
   */
  equality: {
    run: string;
    inputs: string | null;
    models: string | null;
    code: string | null;
    runtime: string;
  };
};

export type PublicExperimentRunSummary = Pick<
  ExperimentRunBinding,
  | "experimentId"
  | "arm"
  | "kind"
  | "variableId"
  | "changedRequestPaths"
  | "baselineJobId"
  | "baselineOutputName"
  | "adoptedBaseline"
> & {
  schemaVersion: "ltx-studio-public-experiment-run.v1";
  protocolEqualityToken: string;
  baselineRequestEqualityToken: string;
  requestEqualityToken: string;
};

export type PublicExperimentBaselineSummary = {
  outputName: string;
  jobId: string;
  sizeBytes: number;
  changedAt: string;
};

export type PublicExperimentArm = Pick<
  ControlledExperiment["arms"][number],
  "arm" | "request" | "jobId" | "attemptJobIds"
> & {
  requestEqualityToken: string;
  settingsEqualityToken: string;
};

/** Browser view of a controlled experiment; all persisted authority hashes are private. */
export type PublicControlledExperiment = Pick<
  ControlledExperiment,
  | "id"
  | "title"
  | "claimScope"
  | "status"
  | "kind"
  | "candidate"
  | "changedRequestPaths"
  | "createdAt"
  | "frozenAt"
  | "supersededAt"
  | "supersededReason"
  | "replacementExperimentId"
> & {
  schemaVersion: "ltx-studio-public-experiment.v1";
  baselineEvidence: PublicExperimentBaselineSummary | null;
  protocolEqualityToken: string | null;
  arms: [PublicExperimentArm & { arm: "baseline" }, PublicExperimentArm & { arm: "candidate" }];
};

export type PublicProjectRunSummary = Pick<
  ProjectRunBinding,
  | "projectId"
  | "projectRevision"
  | "shotId"
  | "requestRevisionId"
  | "continuity"
> & {
  schemaVersion: "ltx-studio-public-project-run.v1";
  projectRevisionEqualityToken: string;
  requestEqualityToken: string;
};

export type PublicProjectMutation =
  | { type: "project-created" }
  | { type: "shot-added"; shotId: string }
  | { type: "shot-request-revised"; shotId: string; requestRevisionId: string }
  | { type: "shot-output-recorded"; shotId: string; outputId: string }
  | { type: "shot-output-approved"; shotId: string; outputId: string }
  | { type: "project-archived" };

export type PublicProjectRequestRevision = Pick<
  ProjectRevisionEnvelope["project"]["shots"][number]["requestRevisions"][number],
  | "id"
  | "parentRevisionId"
  | "reason"
  | "sourceOutputId"
  | "request"
  | "createdAt"
> & {
  /** Process-scoped equality only; the persisted request digest remains private. */
  requestEqualityToken: string;
};

export type PublicProjectOutputEvidence = Pick<
  ProjectRevisionEnvelope["project"]["shots"][number]["outputHistory"][number],
  | "id"
  | "requestRevisionId"
  | "jobId"
  | "outputName"
  | "sizeBytes"
  | "changedAt"
  | "recordedAt"
> & {
  projectRun: PublicProjectRunSummary;
  revisionToken: string;
  equality: {
    request: string;
    provenance: string;
    settings: string;
    export: string;
  };
};

export type PublicProjectShot = Pick<
  ProjectRevisionEnvelope["project"]["shots"][number],
  | "id"
  | "order"
  | "title"
  | "status"
  | "continuity"
  | "currentRequestRevisionId"
  | "approvedOutputId"
> & {
  requestRevisions: PublicProjectRequestRevision[];
  outputHistory: PublicProjectOutputEvidence[];
};

export type PublicStudioProject = Pick<
  ProjectRevisionEnvelope["project"],
  "id" | "title" | "description" | "status" | "createdAt" | "updatedAt"
> & {
  schemaVersion: "ltx-studio-public-project.v1";
  shots: PublicProjectShot[];
};

/**
 * Browser view of a project revision. Generation requests remain deliberate
 * local operator data; file identity and persisted authority hashes do not.
 */
export type PublicProjectRevisionEnvelope = Pick<
  ProjectRevisionEnvelope,
  "projectId" | "revision" | "recordedAt"
> & {
  schemaVersion: "ltx-studio-public-project-revision.v1";
  revisionToken: string;
  previousRevisionBound: boolean;
  mutation: PublicProjectMutation;
  project: PublicStudioProject;
};

/**
 * Browser DTO for published outputs. This is an explicit allowlist and must
 * never be widened by spreading the internal StudioOutput record.
 *
 * `request` and `qualityReview` are deliberately retained local operator data:
 * the single-user GUI needs configured upload/model paths to reload settings
 * and the operator-authored scorecard. They are not execution, identity,
 * publication or provenance authority and are kept separate from all summaries.
 */
export type PublicStudioOutput = {
  name: string;
  url: string;
  sizeBytes: number;
  modifiedAt: string;
  changedAt: string;
  revisionToken: string;
  jobId: string | null;
  jobStatus: "completed" | "external";
  request: GenerationRequest | null;
  settingsAvailable: boolean;
  qualityReview: JobQualityReview | null;
  analysis: PublicOutputAnalysisRecord | null;
  audioAnalysis: T2aAudioPublicAnalysisRecord | null;
  provenanceSummary: PublicOutputProvenanceSummary | null;
  experiment: PublicExperimentRunSummary | null;
  project: PublicProjectRunSummary | null;
  experimentRequestVerified: boolean;
  trustStatus?: "verified-publication" | "legacy-unattested";
};
