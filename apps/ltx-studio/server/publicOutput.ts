import { createHmac, randomBytes } from "node:crypto";

import { canonicalJson } from "../shared/canonicalJson.js";
import type { ControlledExperiment, ExperimentRunBinding } from "../shared/experiments.js";
import type { OutputAnalysisRecord } from "../shared/objectiveQuality.js";
import type {
  PublicControlledExperiment,
  PublicExperimentRunSummary,
  PublicObjectiveQualityAnalysis,
  PublicOutputAnalysisRecord,
  PublicOutputProvenanceSummary,
  PublicProjectMutation,
  PublicProjectOutputEvidence,
  PublicProjectRevisionEnvelope,
  PublicProjectRunSummary,
  PublicStudioOutput,
} from "../shared/outputPublic.js";
import type {
  ProjectRevisionEnvelope,
  ProjectRunBinding,
} from "../shared/projects.js";
import type { JobQualityReview } from "../shared/quality.js";
import type { RunProvenance } from "../shared/provenance.js";
import type { StudioOutput } from "../shared/outputs.js";
import type { T2aAudioPublicAnalysisRecord } from "../shared/t2aAudioPublic.js";

const publicEqualityKey = randomBytes(32);

function equalityToken(domain: string, value: unknown): string {
  const digest = createHmac("sha256", publicEqualityKey)
    .update(domain)
    .update("\0")
    .update(canonicalJson(value))
    .digest("base64url")
    .slice(0, 32);
  return `eq1_${digest}`;
}

function publicText(value: string): string {
  return value
    .replace(/(^|[\s('"`])\/[\w@%+.,:=~-]+(?:\/[\w@%+.,:=~-]+)+/g, "$1<redacted-path>")
    .replace(/\b[A-Za-z]:\\[^\s'"`]+/g, "<redacted-path>")
    .replace(/\b[0-9a-f]{40}\b/gi, "<redacted-id>")
    .replace(/\b[0-9a-f]{64}\b/gi, "<redacted-digest>");
}

export function publicOutputRevisionToken(parts: {
  outputName: string;
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number;
  fileId: string;
  jobId: string | null;
}): string {
  return equalityToken("published-output-revision.v1", {
    outputName: parts.outputName,
    sizeBytes: parts.sizeBytes,
    // node:fs exposes sub-millisecond `*timeMs` values, while the paired
    // Stats Date objects round to the nearest millisecond before StudioOutput
    // serializes them. Canonicalize both private revision records and public
    // ISO timestamps to that same observable millisecond.
    modifiedAtMs: Math.round(parts.modifiedAtMs),
    changedAtMs: Math.round(parts.changedAtMs),
    fileId: parts.fileId,
    jobId: parts.jobId,
  });
}

function outputRevisionToken(output: StudioOutput): string {
  return publicOutputRevisionToken({
    outputName: output.name,
    sizeBytes: output.sizeBytes,
    modifiedAtMs: Date.parse(output.modifiedAt),
    changedAtMs: Date.parse(output.changedAt),
    fileId: output.fileId,
    jobId: output.jobId,
  });
}

function analysisRevisionToken(analysis: OutputAnalysisRecord): string {
  return publicOutputRevisionToken({
    outputName: analysis.outputName,
    sizeBytes: analysis.sizeBytes,
    modifiedAtMs: analysis.modifiedAtMs,
    changedAtMs: analysis.changedAtMs,
    fileId: analysis.fileId,
    jobId: analysis.jobId,
  });
}

const publicAnalysisKeys = new Set([
  "schemaVersion", "analyzerVersion", "createdAt", "status", "technical", "face", "identity",
  "avSync", "conditioningAvSync", "dialogue", "phonemeViseme", "capabilities", "findings",
  "limitations", "durationSeconds", "fps", "frames", "hasAudio", "constantFrameRate",
  "audioVideoDurationDeltaSeconds", "audioVideoStartDeltaSeconds", "sampledFrames", "detectedFrames",
  "validGeometryFrames", "detectionCoverage", "geometryCoverage", "medianConfidence",
  "medianEyeSpanPixels", "medianFaceAreaRatio", "noseVelocityP95PerSecond",
  "noseAccelerationP95PerSecond2", "mouthAngleMedianDegrees",
  "mouthAngleVelocityP95DegreesPerSecond", "mouthSpanCoefficientOfVariation", "mouthSkinPairCount",
  "mouthSkinPairCoverage", "mouthSkinWarpResidualMedian", "mouthSkinWarpResidualP95",
  "mouthSkinLuminanceDeltaP95", "mouthSkinFlowDeformationP95", "mouthSkinValidPixelCoverageP10",
  "error", "modelName", "preprocessingVersion", "embeddingDimensions", "referenceCount",
  "sampledReferenceFrames", "embeddedReferenceFrames", "sampledOutputFrames", "matchedOutputFrames",
  "outputCoverage", "ambiguousOutputFrames", "referenceSelfConsistencyMedian",
  "referenceSelfConsistencyP10", "cosineMedian", "cosineP10", "cosineMinimum",
  "outputTemporalConsistencyMedian", "method", "sampledVideoFrames", "validMotionPairs",
  "motionCoverage", "audioWindowCount", "audioActivityRatio", "usableAudioActivitySeconds",
  "mouthCoverageDuringAudioActivity", "usableWindowCount", "estimatedAudioLeadMilliseconds",
  "lagSearchLimitMilliseconds", "lagResolutionMilliseconds", "effectiveVideoSampleMilliseconds",
  "correlationPeak", "zeroLagCorrelation", "peakProminence", "peakWidthMilliseconds",
  "featureLagAgreementMilliseconds", "windowLagIqrMilliseconds", "nullP95Correlation", "blockerCode",
  "packageVersion", "detectedLanguage", "expectedWordCount", "recognizedWordCount",
  "recognizedTranscript", "wordErrorRate", "substitutions", "deletions", "insertions",
  "guidedAlignedWordCount", "guidedWordCoverage", "usableAlignedWordCount", "usableGuidedWordCoverage",
  "medianGuidedWordProbability", "p10GuidedWordProbability", "lowConfidenceAlignedWords",
  "alignmentStatus", "alignmentError", "timePrecisionMilliseconds", "audioStartRelativeVideoSeconds",
  "guidedWords", "trackedWordCount", "mouthTrackedWordCoverage", "wordsWithMouthMotionRatio",
  "pauseMotionRatio", "estimatedWordActivityLeadMilliseconds", "wordMotionProxyStatus", "index", "word",
  "normalizedWord", "tokenIds", "startSeconds", "endSeconds", "probability", "usable", "productGo",
  "offset", "content", "measurement", "reason", "gatePassed", "estimatedOffsetMilliseconds",
  "confidence", "frameMacroF1", "transitionF1", "globalAvLagMilliseconds", "lagConfidence",
  "bilabialClosureF1", "openingCorrelation", "roundingCorrelation", "speechMotionRecall", "pauseLeakRatio",
  "phoneCoverage", "unknownPhones", "faceTrackCoverage", "mouthTrackCoverage", "multiFaceFrameRatio",
  "medianBlurVariance", "yawP95Degrees", "pitchP95Degrees", "usableDurationSeconds", "code", "level",
  "message",
]);

function publicAnalysisValue(value: unknown): unknown {
  if (typeof value === "string") return publicText(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(publicAnalysisValue);
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!publicAnalysisKeys.has(key)) continue;
    result[key] = publicAnalysisValue(child);
  }
  return result;
}

function analysisEquality(analysis: OutputAnalysisRecord): PublicOutputAnalysisRecord["equality"] {
  const result = analysis.result;
  const identity = result && "identity" in result ? result.identity : null;
  const dialogue = result && "dialogue" in result && typeof result.dialogue === "object"
    ? result.dialogue
    : null;
  const evaluator = "evaluatorFingerprint" in analysis ? analysis.evaluatorFingerprint : null;
  const expectedDialogue = "expectedDialogueSha256" in analysis
    ? analysis.expectedDialogueSha256
    : dialogue?.expectedTranscriptSha256 ?? null;
  const identityModel = identity?.modelSha256
    ? {
        modelSha256: identity.modelSha256,
        modelRevision: identity.modelRevision,
        preprocessingVersion: identity.preprocessingVersion,
      }
    : null;
  return {
    evaluator: evaluator ? equalityToken("analysis-evaluator.v1", evaluator) : null,
    expectedDialogue: expectedDialogue
      ? equalityToken("analysis-expected-dialogue.v1", expectedDialogue)
      : null,
    identityModel: identityModel ? equalityToken("analysis-identity-model.v1", identityModel) : null,
  };
}

export function toPublicOutputAnalysis(
  analysis: OutputAnalysisRecord | null,
): PublicOutputAnalysisRecord | null {
  if (!analysis) return null;
  return {
    schemaVersion: "ltx-studio-public-output-analysis.v1",
    sourceSchemaVersion: analysis.schemaVersion,
    outputName: analysis.outputName,
    outputRevisionToken: analysisRevisionToken(analysis),
    jobId: analysis.jobId,
    analysisId: analysis.analysisId,
    attempt: analysis.attempt,
    status: analysis.status,
    progress: analysis.progress,
    createdAt: analysis.createdAt,
    startedAt: analysis.startedAt,
    finishedAt: analysis.finishedAt,
    updatedAt: analysis.updatedAt,
    error: analysis.error
      ? { code: publicText(analysis.error.code), message: publicText(analysis.error.message) }
      : null,
    equality: analysisEquality(analysis),
    result: analysis.result
      ? publicAnalysisValue(analysis.result) as PublicObjectiveQualityAnalysis
      : null,
  };
}

function provenanceEvidenceToken(
  provenance: RunProvenance,
  domain: string,
  rolePrefix: string,
): string | null {
  const evidence = provenance.files
    .filter((item) => item.role.startsWith(rolePrefix))
    .map((item) => ({ role: item.role, sha256: item.sha256 }))
    .sort((left, right) => left.role.localeCompare(right.role));
  return evidence.length > 0 ? equalityToken(domain, evidence) : null;
}

function summarizeProvenance(
  provenance: RunProvenance | null | undefined,
): PublicOutputProvenanceSummary | null {
  if (!provenance) return null;
  const code = provenance.code.map((item) => item.fingerprint);
  return {
    schemaVersion: "ltx-studio-public-output-provenance-summary.v1",
    status: provenance.verifiedAt ? "verified" : "captured-unverified",
    capturedAt: provenance.capturedAt,
    verifiedAt: provenance.verifiedAt,
    release: provenance.release
      ? { sealed: provenance.release.sealed, verified: provenance.release.verified }
      : null,
    equality: {
      run: equalityToken("run-provenance.v1", provenance.fingerprint),
      inputs: provenanceEvidenceToken(provenance, "run-input-evidence.v1", "input:"),
      models: provenanceEvidenceToken(provenance, "run-model-evidence.v1", "model:"),
      code: code.length > 0 ? equalityToken("run-code-evidence.v1", code) : null,
      runtime: equalityToken("run-runtime-evidence.v1", provenance.runtime.fingerprint),
    },
  };
}

export function toPublicExperimentRunSummary(
  binding: ExperimentRunBinding,
): PublicExperimentRunSummary {
  return {
    schemaVersion: "ltx-studio-public-experiment-run.v1",
    experimentId: binding.experimentId,
    arm: binding.arm,
    kind: binding.kind,
    variableId: binding.variableId,
    changedRequestPaths: [...binding.changedRequestPaths],
    baselineJobId: binding.baselineJobId,
    baselineOutputName: binding.baselineOutputName,
    ...(binding.adoptedBaseline === true ? { adoptedBaseline: true as const } : {}),
    protocolEqualityToken: equalityToken("experiment-protocol.v1", binding.protocolSha256),
    baselineRequestEqualityToken: equalityToken(
      "experiment-baseline-request.v1",
      binding.baselineRequestSha256,
    ),
    requestEqualityToken: equalityToken("experiment-arm-request.v1", binding.requestSha256),
  };
}

export function toPublicProjectRunSummary(binding: ProjectRunBinding): PublicProjectRunSummary {
  return {
    schemaVersion: "ltx-studio-public-project-run.v1",
    projectId: binding.projectId,
    projectRevision: binding.projectRevision,
    shotId: binding.shotId,
    requestRevisionId: binding.requestRevisionId,
    continuity: binding.continuity ? {
      predecessorShotId: binding.continuity.predecessorShotId,
      referenceOutputId: binding.continuity.referenceOutputId,
    } : null,
    projectRevisionEqualityToken: equalityToken(
      "project-revision.v1",
      binding.projectRevisionSha256,
    ),
    requestEqualityToken: equalityToken("project-request.v1", binding.requestSha256),
  };
}

function toPublicProjectMutation(
  mutation: ProjectRevisionEnvelope["mutation"],
): PublicProjectMutation {
  switch (mutation.type) {
    case "project-created":
      return { type: mutation.type };
    case "shot-added":
      return { type: mutation.type, shotId: mutation.shotId };
    case "shot-request-revised":
      return {
        type: mutation.type,
        shotId: mutation.shotId,
        requestRevisionId: mutation.requestRevisionId,
      };
    case "shot-output-recorded":
    case "shot-output-approved":
      return { type: mutation.type, shotId: mutation.shotId, outputId: mutation.outputId };
    case "project-archived":
      return { type: mutation.type };
  }
}

function toPublicProjectOutput(
  output: ProjectRevisionEnvelope["project"]["shots"][number]["outputHistory"][number],
): PublicProjectOutputEvidence {
  return {
    id: output.id,
    projectRun: toPublicProjectRunSummary(output.projectRun),
    requestRevisionId: output.requestRevisionId,
    jobId: output.jobId,
    outputName: output.outputName,
    sizeBytes: output.sizeBytes,
    changedAt: output.changedAt,
    recordedAt: output.recordedAt,
    revisionToken: equalityToken("project-output-revision.v1", {
      id: output.id,
      outputName: output.outputName,
      sizeBytes: output.sizeBytes,
      changedAt: output.changedAt,
      fileId: output.fileId,
      exportSha256: output.exportSha256,
    }),
    equality: {
      request: equalityToken("project-output-request.v1", output.requestSha256),
      provenance: equalityToken("project-output-provenance.v1", output.provenanceFingerprint),
      settings: equalityToken("project-output-settings.v1", output.settingsSidecarSha256),
      export: equalityToken("project-output-export.v1", output.exportSha256),
    },
  };
}

export function toPublicProjectRevisionEnvelope(
  envelope: ProjectRevisionEnvelope,
): PublicProjectRevisionEnvelope {
  return {
    schemaVersion: "ltx-studio-public-project-revision.v1",
    projectId: envelope.projectId,
    revision: envelope.revision,
    recordedAt: envelope.recordedAt,
    revisionToken: equalityToken("project-revision.v1", envelope),
    previousRevisionBound: envelope.previousRevisionSha256 !== null,
    mutation: toPublicProjectMutation(envelope.mutation),
    project: {
      schemaVersion: "ltx-studio-public-project.v1",
      id: envelope.project.id,
      title: envelope.project.title,
      description: envelope.project.description,
      status: envelope.project.status,
      createdAt: envelope.project.createdAt,
      updatedAt: envelope.project.updatedAt,
      shots: envelope.project.shots.map((shot) => ({
        id: shot.id,
        order: shot.order,
        title: shot.title,
        status: shot.status,
        continuity: shot.continuity ? {
          predecessorShotId: shot.continuity.predecessorShotId,
          referenceOutputId: shot.continuity.referenceOutputId,
        } : null,
        requestRevisions: shot.requestRevisions.map((revision) => ({
          id: revision.id,
          parentRevisionId: revision.parentRevisionId,
          reason: revision.reason,
          sourceOutputId: revision.sourceOutputId,
          // Deliberate local operator configuration, separate from authority.
          request: structuredClone(revision.request),
          requestEqualityToken: equalityToken(
            "project-request-revision.v1",
            revision.requestSha256,
          ),
          createdAt: revision.createdAt,
        })),
        currentRequestRevisionId: shot.currentRequestRevisionId,
        outputHistory: shot.outputHistory.map(toPublicProjectOutput),
        approvedOutputId: shot.approvedOutputId,
      })),
    },
  };
}

export function toPublicProjectRevisionEnvelopes(
  envelopes: readonly ProjectRevisionEnvelope[],
): PublicProjectRevisionEnvelope[] {
  return envelopes.map(toPublicProjectRevisionEnvelope);
}

export function publicProjectListResponse(value: {
  projects: ProjectRevisionEnvelope[];
  warnings: string[];
}): { projects: PublicProjectRevisionEnvelope[]; warnings: string[] } {
  return {
    projects: toPublicProjectRevisionEnvelopes(value.projects),
    warnings: value.warnings.map(publicText),
  };
}

export function publicProjectHistoryResponse(
  revisions: readonly ProjectRevisionEnvelope[],
): { revisions: PublicProjectRevisionEnvelope[] } {
  return { revisions: toPublicProjectRevisionEnvelopes(revisions) };
}

export function publicProjectResponse(
  project: ProjectRevisionEnvelope,
): { project: PublicProjectRevisionEnvelope } {
  return { project: toPublicProjectRevisionEnvelope(project) };
}

function publicQualityReview(review: JobQualityReview | null): JobQualityReview | null {
  if (!review) return null;
  return {
    scores: {
      lipSync: review.scores.lipSync,
      identity: review.scores.identity,
      mouthNaturalness: review.scores.mouthNaturalness,
      skinStability: review.scores.skinStability,
      motion: review.scores.motion,
      audio: review.scores.audio,
    },
    note: review.note,
    updatedAt: review.updatedAt,
  };
}

export function toPublicStudioOutput(
  output: StudioOutput,
  audioAnalysis: T2aAudioPublicAnalysisRecord | null = null,
): PublicStudioOutput {
  return {
    name: output.name,
    url: output.url,
    sizeBytes: output.sizeBytes,
    modifiedAt: output.modifiedAt,
    changedAt: output.changedAt,
    revisionToken: outputRevisionToken(output),
    jobId: output.jobId,
    jobStatus: output.jobStatus,
    // Deliberately local operator data; never confuse this with authority.
    request: output.request ? structuredClone(output.request) : null,
    settingsAvailable: output.settingsAvailable,
    qualityReview: publicQualityReview(output.qualityReview),
    analysis: toPublicOutputAnalysis(output.analysis),
    audioAnalysis,
    provenanceSummary: summarizeProvenance(output.provenance),
    experiment: output.experiment ? toPublicExperimentRunSummary(output.experiment) : null,
    project: output.project ? toPublicProjectRunSummary(output.project) : null,
    experimentRequestVerified: output.experimentRequestVerified === true,
    trustStatus: output.trustStatus,
  };
}

export function toPublicStudioOutputs(
  outputs: readonly StudioOutput[],
  audioAnalyses: ReadonlyMap<string, T2aAudioPublicAnalysisRecord> = new Map(),
): PublicStudioOutput[] {
  return outputs.map((output) => toPublicStudioOutput(
    output,
    audioAnalyses.get(output.name) ?? null,
  ));
}

export function publicStudioOutputsResponse(
  outputs: readonly StudioOutput[],
  audioAnalyses: ReadonlyMap<string, T2aAudioPublicAnalysisRecord> = new Map(),
): {
  outputs: PublicStudioOutput[];
} {
  return { outputs: toPublicStudioOutputs(outputs, audioAnalyses) };
}

export function publicStudioOutputResponse(
  output: StudioOutput,
  audioAnalysis: T2aAudioPublicAnalysisRecord | null = null,
): { output: PublicStudioOutput } {
  return { output: toPublicStudioOutput(output, audioAnalysis) };
}

export function publicOutputAnalysisResponse(analysis: OutputAnalysisRecord | null): {
  analysis: PublicOutputAnalysisRecord | null;
} {
  return { analysis: toPublicOutputAnalysis(analysis) };
}

export function toPublicControlledExperiment(
  experiment: ControlledExperiment,
): PublicControlledExperiment {
  const arm = (index: 0 | 1) => {
    const source = experiment.arms[index];
    return {
      arm: source.arm,
      request: structuredClone(source.request),
      jobId: source.jobId,
      attemptJobIds: [...source.attemptJobIds],
      requestEqualityToken: equalityToken("experiment-public-arm-request.v1", source.requestSha256),
      settingsEqualityToken: equalityToken("experiment-public-arm-settings.v1", source.settingsSha256),
    };
  };
  const baseline = arm(0);
  const candidate = arm(1);
  return {
    schemaVersion: "ltx-studio-public-experiment.v1",
    id: experiment.id,
    title: experiment.title,
    claimScope: experiment.claimScope,
    status: experiment.status,
    kind: experiment.kind,
    candidate: structuredClone(experiment.candidate),
    changedRequestPaths: [...experiment.changedRequestPaths],
    createdAt: experiment.createdAt,
    frozenAt: experiment.frozenAt,
    supersededAt: experiment.supersededAt,
    supersededReason: experiment.supersededReason,
    replacementExperimentId: experiment.replacementExperimentId,
    baselineEvidence: experiment.baselineEvidence ? {
      outputName: experiment.baselineEvidence.outputName,
      jobId: experiment.baselineEvidence.jobId,
      sizeBytes: experiment.baselineEvidence.sizeBytes,
      changedAt: experiment.baselineEvidence.changedAt,
    } : null,
    protocolEqualityToken: experiment.protocolSha256
      ? equalityToken("experiment-public-protocol.v1", experiment.protocolSha256)
      : null,
    arms: [
      { ...baseline, arm: "baseline" },
      { ...candidate, arm: "candidate" },
    ],
  };
}

export function toPublicControlledExperiments(
  experiments: readonly ControlledExperiment[],
): PublicControlledExperiment[] {
  return experiments.map(toPublicControlledExperiment);
}
