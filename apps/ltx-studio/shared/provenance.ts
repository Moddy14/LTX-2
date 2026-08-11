export type ProvenanceFileKind = "file" | "directory-manifest";

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
  sourceCommit: string | null;
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
  fingerprint: string;
};
