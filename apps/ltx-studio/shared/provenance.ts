import type { JobExecutionDecision } from "./jobExecution.js";

export type ProvenanceFileKind = "file" | "directory-manifest" | "python-package-manifest";

export type ProvenanceFileEntry = {
  relativePath: string;
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number;
  fileId: string;
  sha256: string;
};

export type ProvenanceFileEvidence = {
  role: string;
  path: string;
  kind: ProvenanceFileKind;
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number;
  fileId: string;
  sha256: string;
  entries: ProvenanceFileEntry[];
};

export type ProvenanceCodeEvidence = {
  repositoryRoot: string;
  commit: string;
  dirty: boolean;
  trackedDiffSha256: string;
  untracked: ProvenanceFileEvidence[];
  fingerprint: string;
};

export type ProvenanceRuntimeEvidence = {
  platform: string;
  architecture: string;
  kernelRelease: string;
  nodeVersion: string;
  pythonExecutable: string;
  pythonVersion: string;
  packages: Record<string, string | null>;
  ffmpegVersion: string | null;
  fingerprint: string;
};

export type ProvenanceUpstreamContract = {
  role: string;
  repository: string;
  commit: string;
  path: string;
  sha256: string;
};

export type ProvenanceReleaseIdentity = {
  sealed: boolean;
  verified: boolean;
  releaseDigest: string | null;
  manifestSha256: string | null;
  surfaceDigest: string | null;
  sourceCommit: string | null;
  runtimeInstallSealSha256: string | null;
  runtimeTreeSha256: string | null;
  runtimePolicySha256: string | null;
  nodeExecutableSha256: string | null;
  expectedHostTcbAttestationSha256: string | null;
};

export type ProvenanceContainerImageArtifact = {
  path: string;
  sizeBytes: number;
  sha256: string;
};

export type ProvenanceContainerImageEvidence = {
  role: "container:lipforcing-runtime";
  requestedReference: string;
  executionReference: string;
  imageId: string;
  repoDigest: string | null;
  sourceRevision: string;
  patchSetId: string;
  artifacts: ProvenanceContainerImageArtifact[];
  fingerprint: string;
};

export type RunProvenance = {
  schemaVersion: "ltx-studio-run-provenance.v1" | "ltx-studio-run-provenance.v2";
  capturedAt: string;
  verifiedAt: string | null;
  files: ProvenanceFileEvidence[];
  code: ProvenanceCodeEvidence[];
  runtime: ProvenanceRuntimeEvidence;
  /** Present on newly captured runs; omitted only by legacy v1 sidecars. */
  upstreamContracts?: ProvenanceUpstreamContract[];
  /** Required for v2; absent only on legacy v1 sidecars. */
  release?: ProvenanceReleaseIdentity;
  /** Immutable runtime images; absent only on legacy evidence or runs without containers. */
  containerImages?: ProvenanceContainerImageEvidence[];
  /** Exact persisted execution decision; absent only on pre-v2-decision evidence. */
  executionDecision?: JobExecutionDecision;
  fingerprint: string;
};
