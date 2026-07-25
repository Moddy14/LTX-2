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

export type RunProvenance = {
  schemaVersion: "ltx-studio-run-provenance.v1";
  capturedAt: string;
  verifiedAt: string | null;
  files: ProvenanceFileEvidence[];
  code: ProvenanceCodeEvidence[];
  runtime: ProvenanceRuntimeEvidence;
  fingerprint: string;
};
