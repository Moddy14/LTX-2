import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ProvenanceContainerImageArtifact,
  ProvenanceContainerImageEvidence,
} from "../shared/provenance.js";
import { appRoot } from "./config.js";

const DOCKER_EXECUTABLE = "/usr/bin/docker";
export const LIPFORCING_IMAGE_SOURCE_REVISION = "fc864771eb347ca3ccaaef9c0b583ff6ccc9f184";
export const LIPFORCING_IMAGE_PATCH_SET_ID = "ltx-studio-lipforcing-runtime.v4";
const LIPFORCING_UPSTREAM_REPOSITORY = "https://github.com/cvlab-kaist/LipForcing";
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CONTAINER_ID_PATTERN = /^[0-9a-f]{64}$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const REPOSITORY_COMPONENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|[-]+)[a-z0-9]+)*$/;
const REGISTRY_HOST_PATTERN = /^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[1-9][0-9]{0,4})?$/;
const MAX_IMAGE_REFERENCE_LENGTH = 512;
const MAX_COPIED_ARTIFACT_BYTES = 1024 * 1024;
const DOCKER_TIMEOUT_MS = 30_000;

export const LIPFORCING_IMAGE_ARTIFACT_PATHS = [
  "/opt/ltx-studio/raw_output_mux.py",
  "/opt/ltx-studio/runtime-patch-provenance.v1.json",
  "/workspace/LipForcing/scripts/inference/_loader.py",
  "/workspace/LipForcing/scripts/inference/_common.py",
  "/workspace/LipForcing/OmniAvatar/utils/latentsync/face_detector.py",
  "/workspace/LipForcing/LICENSE",
  "/opt/ltx-studio/lipforcing-runner.py",
] as const;

const LIPFORCING_PATCHED_IMAGE_PATHS = [
  {
    imagePath: LIPFORCING_IMAGE_ARTIFACT_PATHS[2],
    manifestPath: "scripts/inference/_loader.py",
  },
  {
    imagePath: LIPFORCING_IMAGE_ARTIFACT_PATHS[3],
    manifestPath: "scripts/inference/_common.py",
  },
  {
    imagePath: LIPFORCING_IMAGE_ARTIFACT_PATHS[4],
    manifestPath: "OmniAvatar/utils/latentsync/face_detector.py",
  },
] as const;

export type DockerImageInspection = {
  id: string;
  /** Forensic aliases returned by Docker. They are not fingerprint authority. */
  repoDigests: string[];
  labels: Record<string, string>;
};

export type LipForcingImageIdentityOperations = {
  inspect(reference: string): DockerImageInspection;
  copyArtifacts(
    executionReference: string,
    expectedImageId: string,
    paths: readonly string[],
  ): Map<string, Buffer>;
};

export type LipForcingHostArtifacts = {
  rawOutputMux: Buffer;
  containerRunner: Buffer;
  runtimePatchProvenance: Buffer;
};

export type DockerCommandOptions = {
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  shell: false;
  timeout: number;
  maxBuffer: number;
};

export type DockerCommandResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

export type DockerCommandRunner = (
  executable: string,
  args: readonly string[],
  options: DockerCommandOptions,
) => DockerCommandResult;

export type DockerImageIdentityFileSystem = {
  makeTemporaryDirectory(prefix: string): string;
  chmod(path: string, mode: number): void;
  open(path: string, flags: number): number;
  stat(descriptor: number): Pick<Stats, "isFile" | "nlink" | "size">;
  read(descriptor: number): Buffer;
  close(descriptor: number): void;
  removeTree(path: string): void;
};

export type DockerImageIdentityDependencies = {
  commandRunner?: DockerCommandRunner;
  fileSystem?: DockerImageIdentityFileSystem;
  temporaryDirectory?: () => string;
  randomId?: () => string;
};

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Containeridentität enthält einen nicht kanonisierbaren Wert.");
  return encoded;
}

function evidenceFingerprint(
  value: Omit<ProvenanceContainerImageEvidence, "fingerprint">,
): string {
  return sha256(stableJson(value));
}

function isRepositoryName(value: string): boolean {
  const components = value.split("/");
  if (components.length === 0 || components.some((component) => component.length === 0)) return false;
  return components.every((component, index) => {
    if (index === 0 && (component === "localhost" || component.includes(".") || component.includes(":"))) {
      return REGISTRY_HOST_PATTERN.test(component);
    }
    return REPOSITORY_COMPONENT_PATTERN.test(component);
  });
}

function isTaggedOrNamedReference(value: string): boolean {
  const unsafeCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return character === "@" || /\s/u.test(character) || codePoint <= 31 || codePoint === 127;
  });
  if (value.length === 0 || value.length > MAX_IMAGE_REFERENCE_LENGTH || unsafeCharacter) {
    return false;
  }
  const lastSlash = value.lastIndexOf("/");
  const lastColon = value.lastIndexOf(":");
  if (lastColon > lastSlash) {
    return isRepositoryName(value.slice(0, lastColon)) && TAG_PATTERN.test(value.slice(lastColon + 1));
  }
  return isRepositoryName(value);
}

function isRepoDigestReference(value: string): boolean {
  if (value.length === 0 || value.length > MAX_IMAGE_REFERENCE_LENGTH) return false;
  const separator = value.lastIndexOf("@sha256:");
  if (separator <= 0 || separator !== value.length - 72) return false;
  return isTaggedOrNamedReference(value.slice(0, separator))
    && HASH_PATTERN.test(value.slice(separator + "@sha256:".length));
}

function isDockerImageReference(value: string): boolean {
  return IMAGE_ID_PATTERN.test(value) || isRepoDigestReference(value) || isTaggedOrNamedReference(value);
}

function assertRequestedReference(value: string): void {
  if (!isDockerImageReference(value)) {
    throw new Error("LipForcing-Image-Referenz ist leer, mehrdeutig oder syntaktisch ungültig.");
  }
}

function assertExecutionReference(value: string): void {
  if (!IMAGE_ID_PATTERN.test(value) && !isRepoDigestReference(value)) {
    throw new Error("LipForcing-Ausführungsreferenz ist nicht unveränderlich gebunden.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const defaultCommandRunner: DockerCommandRunner = (executable, args, options) => {
  const result = spawnSync(executable, [...args], options);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: result.error } : {}),
  };
};

const defaultFileSystem: DockerImageIdentityFileSystem = {
  makeTemporaryDirectory: (prefix) => mkdtempSync(prefix),
  chmod: (path, mode) => chmodSync(path, mode),
  open: (path, flags) => openSync(path, flags),
  stat: (descriptor) => fstatSync(descriptor),
  read: (descriptor) => readFileSync(descriptor),
  close: (descriptor) => closeSync(descriptor),
  removeTree: (path) => rmSync(path, { recursive: true, force: true }),
};

function dockerEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    LC_ALL: "C",
  };
}

function dockerText(
  runner: DockerCommandRunner,
  args: readonly string[],
  maxBuffer = 1024 * 1024,
): string {
  const result = runner(DOCKER_EXECUTABLE, args, {
    encoding: "utf8",
    env: dockerEnvironment(),
    shell: false,
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr.trim() || `Exit ${String(result.status)}`;
    throw new Error(
      `Docker-Identitätsprüfung fehlgeschlagen (${args[0] ?? "?"} ${args[1] ?? ""}): ${detail}`,
    );
  }
  return result.stdout.trim();
}

function inspectDockerImage(runner: DockerCommandRunner, reference: string): DockerImageInspection {
  assertRequestedReference(reference);
  const raw = dockerText(runner, [
    "image",
    "inspect",
    "--format",
    "{{json .Id}}\t{{json .RepoDigests}}\t{{json .Config.Labels}}",
    reference,
  ]);
  const fields = raw.split("\t");
  if (fields.length !== 3) throw new Error("Docker image inspect lieferte kein eindeutiges Identitätsformat.");
  const id = JSON.parse(fields[0]) as unknown;
  const rawRepoDigests = JSON.parse(fields[1]) as unknown;
  const rawLabels = JSON.parse(fields[2]) as unknown;
  if (typeof id !== "string" || !IMAGE_ID_PATTERN.test(id)) {
    throw new Error("LipForcing-Image besitzt keine gültige unveränderliche Docker-Image-ID.");
  }
  const repoDigests = Array.isArray(rawRepoDigests)
    ? [...new Set(rawRepoDigests.filter((item): item is string =>
        typeof item === "string" && isRepoDigestReference(item)))].sort()
    : [];
  const labels = isRecord(rawLabels)
    ? Object.fromEntries(Object.entries(rawLabels).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"))
    : {};
  return { id, repoDigests, labels };
}

export function readCopiedRegularArtifact(
  path: string,
  fileSystem: DockerImageIdentityFileSystem = defaultFileSystem,
): Buffer {
  const descriptor = fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fileSystem.stat(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > MAX_COPIED_ARTIFACT_BYTES) {
      throw new Error(`Kopiertes Containerartefakt ist keine einzelne reguläre Datei: ${path}`);
    }
    const bytes = fileSystem.read(descriptor);
    const after = fileSystem.stat(descriptor);
    if (!after.isFile() || after.nlink !== 1 || after.size !== before.size || bytes.length !== before.size) {
      throw new Error(`Kopiertes Containerartefakt wurde während der Messung verändert: ${path}`);
    }
    return bytes;
  } finally {
    fileSystem.close(descriptor);
  }
}

function cleanupFailure(primary: unknown, cleanupErrors: Error[]): never {
  if (primary !== null) {
    throw new AggregateError(
      [primary, ...cleanupErrors],
      "Docker-Identitätsprüfung und anschließende Bereinigung sind fehlgeschlagen.",
    );
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  throw new AggregateError(cleanupErrors, "Bereinigung der Docker-Identitätsprüfung ist fehlgeschlagen.");
}

function removeDockerContainerIfPresent(
  runner: DockerCommandRunner,
  containerName: string,
): void {
  const args = ["container", "rm", "--force", "--", containerName] as const;
  const result = runner(DOCKER_EXECUTABLE, args, {
    encoding: "utf8",
    env: dockerEnvironment(),
    shell: false,
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  if (!result.error && result.status === 0) return;
  // A failed/ambiguous create legitimately leaves nothing to remove. LC_ALL=C
  // makes the daemon's exact absence response stable; every other outcome is
  // retained as a cleanup failure instead of silently assuming ownership ended.
  if (!result.error && result.status !== 0 && /\bNo such container\b/.test(result.stderr)) return;
  const detail = result.error?.message || result.stderr.trim() || `Exit ${String(result.status)}`;
  throw new Error(`Docker-Prüfcontainer konnte nicht entfernt werden: ${detail}`);
}

function copyDockerImageArtifacts(
  runner: DockerCommandRunner,
  fileSystem: DockerImageIdentityFileSystem,
  temporaryDirectory: () => string,
  randomId: () => string,
  executionReference: string,
  expectedImageId: string,
  paths: readonly string[],
): Map<string, Buffer> {
  assertExecutionReference(executionReference);
  if (!IMAGE_ID_PATTERN.test(expectedImageId)) {
    throw new Error("Erwartete LipForcing-Image-ID ist ungültig.");
  }
  if (
    paths.length !== LIPFORCING_IMAGE_ARTIFACT_PATHS.length
    || paths.some((path, index) => path !== LIPFORCING_IMAGE_ARTIFACT_PATHS[index])
  ) {
    throw new Error("LipForcing-In-Image-Artefaktliste ist nicht der freigegebene feste Pfadsatz.");
  }
  const temporaryRoot = fileSystem.makeTemporaryDirectory(
    join(temporaryDirectory(), "ltx-lipforcing-image-evidence-"),
  );
  let containerName: string | null = null;
  let containerCreateAttempted = false;
  let primaryError: unknown = null;
  try {
    fileSystem.chmod(temporaryRoot, 0o700);
    const randomSuffix = randomId();
    if (!/^[0-9a-f-]{36}$/i.test(randomSuffix)) {
      throw new Error("Interne Docker-Prüfcontainer-ID ist ungültig.");
    }
    containerName = `ltx-lipforcing-evidence-${randomSuffix}`;
    containerCreateAttempted = true;
    const containerId = dockerText(runner, [
      "create",
      "--pull", "never",
      "--network", "none",
      "--name", containerName,
      "--entrypoint", "/bin/false",
      executionReference,
    ]);
    if (!CONTAINER_ID_PATTERN.test(containerId)) {
      throw new Error("Docker create lieferte keine eindeutige Container-ID.");
    }
    const containerImageId = dockerText(runner, [
      "container", "inspect", "--format", "{{.Image}}", containerId,
    ]);
    if (containerImageId !== expectedImageId) {
      throw new Error("Der angelegte Prüfcontainer verweist auf eine andere Image-ID.");
    }
    const copied = new Map<string, Buffer>();
    for (const [index, sourcePath] of paths.entries()) {
      const destination = join(temporaryRoot, `artifact-${index}`);
      dockerText(runner, ["cp", `${containerId}:${sourcePath}`, destination], 4 * 1024 * 1024);
      copied.set(sourcePath, readCopiedRegularArtifact(destination, fileSystem));
    }
    return copied;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: Error[] = [];
    if (containerCreateAttempted && containerName) {
      try {
        removeDockerContainerIfPresent(runner, containerName);
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    try {
      fileSystem.removeTree(temporaryRoot);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    if (cleanupErrors.length > 0) cleanupFailure(primaryError, cleanupErrors);
  }
}

export function createLipForcingImageIdentityOperations(
  dependencies: DockerImageIdentityDependencies = {},
): LipForcingImageIdentityOperations {
  const runner = dependencies.commandRunner ?? defaultCommandRunner;
  const fileSystem = dependencies.fileSystem ?? defaultFileSystem;
  const temporaryDirectory = dependencies.temporaryDirectory ?? tmpdir;
  const randomId = dependencies.randomId ?? randomUUID;
  return {
    inspect: (reference) => inspectDockerImage(runner, reference),
    copyArtifacts: (executionReference, expectedImageId, paths) => copyDockerImageArtifacts(
      runner,
      fileSystem,
      temporaryDirectory,
      randomId,
      executionReference,
      expectedImageId,
      paths,
    ),
  };
}

const defaultOperations = createLipForcingImageIdentityOperations();

function defaultHostArtifacts(): LipForcingHostArtifacts {
  return {
    rawOutputMux: readFileSync(join(appRoot, "deploy", "lipforcing", "raw_output_mux.py")),
    containerRunner: readFileSync(join(appRoot, "deploy", "lipforcing", "container_runner.py")),
    runtimePatchProvenance: readFileSync(join(
      appRoot,
      "deploy",
      "lipforcing",
      "runtime-patch-provenance.v1.json",
    )),
  };
}

function artifact(path: string, bytes: Buffer): ProvenanceContainerImageArtifact {
  return { path, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

function manifestRecord(
  value: Record<string, unknown>,
  field: "localArtifacts" | "patchedFiles",
  path: string,
): Record<string, unknown> {
  const records = Array.isArray(value[field])
    ? value[field].filter((item): item is Record<string, unknown> => isRecord(item) && item.path === path)
    : [];
  if (records.length !== 1) {
    throw new Error(`In-Image Runtime-Patch-Provenienz bindet ${path} nicht eindeutig.`);
  }
  return records[0];
}

function parseAndVerifyImageArtifacts(
  copied: Map<string, Buffer>,
  host: LipForcingHostArtifacts,
): ProvenanceContainerImageArtifact[] {
  const muxPath = LIPFORCING_IMAGE_ARTIFACT_PATHS[0];
  const provenancePath = LIPFORCING_IMAGE_ARTIFACT_PATHS[1];
  const mux = copied.get(muxPath);
  const provenance = copied.get(provenancePath);
  if (
    !mux
    || !provenance
    || copied.size !== LIPFORCING_IMAGE_ARTIFACT_PATHS.length
    || LIPFORCING_IMAGE_ARTIFACT_PATHS.some((path) => !copied.has(path))
  ) {
    throw new Error("LipForcing-Image enthält nicht exakt die erwarteten Runtime-Artefakte.");
  }
  if (!mux.equals(host.rawOutputMux)) {
    throw new Error("In-Image raw_output_mux.py stimmt nicht bytegenau mit dem gebundenen Host-Helper überein.");
  }
  const runnerPath = LIPFORCING_IMAGE_ARTIFACT_PATHS[6];
  const containerRunner = copied.get(runnerPath)!;
  if (!containerRunner.equals(host.containerRunner)) {
    throw new Error("In-Image LipForcing-Runner stimmt nicht bytegenau mit dem gebundenen Host-Runner überein.");
  }
  if (!provenance.equals(host.runtimePatchProvenance)) {
    throw new Error("In-Image Runtime-Patch-Provenienz stimmt nicht bytegenau mit der Host-Provenienz überein.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(provenance.toString("utf8"));
  } catch {
    throw new Error("In-Image Runtime-Patch-Provenienz ist kein gültiges JSON.");
  }
  if (!isRecord(decoded)) throw new Error("In-Image Runtime-Patch-Provenienz ist kein Objekt.");
  if (
    decoded.schemaVersion !== "ltx-studio-lipforcing-runtime-patch.v1"
    || decoded.patchSetId !== LIPFORCING_IMAGE_PATCH_SET_ID
  ) {
    throw new Error("In-Image Runtime-Patch-Provenienz besitzt nicht das freigegebene Patchset.");
  }
  if (
    !isRecord(decoded.upstream)
    || decoded.upstream.repository !== LIPFORCING_UPSTREAM_REPOSITORY
    || decoded.upstream.commit !== LIPFORCING_IMAGE_SOURCE_REVISION
  ) {
    throw new Error("In-Image Runtime-Patch-Provenienz besitzt nicht den offiziellen LipForcing-Pin.");
  }
  const muxRecord = manifestRecord(decoded, "localArtifacts", "raw_output_mux.py");
  const muxHash = sha256(mux);
  if (
    muxRecord.role !== "paired-premux-export-and-legacy-audio-mux"
    || typeof muxRecord.sha256 !== "string"
    || !HASH_PATTERN.test(muxRecord.sha256)
    || muxRecord.sha256 !== muxHash
    || muxRecord.sha256 !== sha256(host.rawOutputMux)
  ) {
    throw new Error("In-Image Helper stimmt nicht mit seinem Patch-Provenienz-Hash überein.");
  }
  const runnerRecord = manifestRecord(decoded, "localArtifacts", "lipforcing-runner.py");
  const runnerHash = sha256(containerRunner);
  if (
    runnerRecord.role !== "verified-offline-container-entrypoint"
    || typeof runnerRecord.sha256 !== "string"
    || !HASH_PATTERN.test(runnerRecord.sha256)
    || runnerRecord.sha256 !== runnerHash
    || runnerRecord.sha256 !== sha256(host.containerRunner)
  ) {
    throw new Error("In-Image LipForcing-Runner stimmt nicht mit seinem Provenienz-Hash überein.");
  }
  for (const { imagePath, manifestPath } of LIPFORCING_PATCHED_IMAGE_PATHS) {
    const bytes = copied.get(imagePath)!;
    const record = manifestRecord(decoded, "patchedFiles", manifestPath);
    if (
      typeof record.patchedSha256 !== "string"
      || !HASH_PATTERN.test(record.patchedSha256)
      || record.patchedSha256 !== sha256(bytes)
    ) {
      throw new Error(`In-Image ${manifestPath} stimmt nicht mit dem deklarierten Patch-Ergebnis überein.`);
    }
  }
  const licensePath = LIPFORCING_IMAGE_ARTIFACT_PATHS[5];
  const license = copied.get(licensePath)!;
  const licenseRecord = isRecord(decoded.upstream.license) ? decoded.upstream.license : null;
  if (
    !licenseRecord
    || licenseRecord.path !== "LICENSE"
    || licenseRecord.spdx !== "Apache-2.0"
    || typeof licenseRecord.sha256 !== "string"
    || !HASH_PATTERN.test(licenseRecord.sha256)
    || licenseRecord.sha256 !== sha256(license)
  ) {
    throw new Error("In-Image LICENSE stimmt nicht mit der deklarierten Upstream-Lizenzprovenienz überein.");
  }
  return LIPFORCING_IMAGE_ARTIFACT_PATHS.map((path) => artifact(path, copied.get(path)!));
}

function validEvidenceShape(value: ProvenanceContainerImageEvidence): boolean {
  if (!value || typeof value !== "object") return false;
  if (
    typeof value.requestedReference !== "string"
    || typeof value.executionReference !== "string"
    || typeof value.imageId !== "string"
    || (value.repoDigest !== null && typeof value.repoDigest !== "string")
    || typeof value.sourceRevision !== "string"
    || typeof value.patchSetId !== "string"
    || typeof value.fingerprint !== "string"
  ) return false;
  const { fingerprint, ...base } = value;
  const requestedRepoDigest = isRepoDigestReference(value.requestedReference)
    ? value.requestedReference
    : null;
  return value.role === "container:lipforcing-runtime"
    && isDockerImageReference(value.requestedReference)
    && IMAGE_ID_PATTERN.test(value.imageId)
    && (!IMAGE_ID_PATTERN.test(value.requestedReference) || value.requestedReference === value.imageId)
    && value.repoDigest === requestedRepoDigest
    && value.executionReference === (requestedRepoDigest ?? value.imageId)
    && value.sourceRevision === LIPFORCING_IMAGE_SOURCE_REVISION
    && value.patchSetId === LIPFORCING_IMAGE_PATCH_SET_ID
    && Array.isArray(value.artifacts)
    && value.artifacts.length === LIPFORCING_IMAGE_ARTIFACT_PATHS.length
    && value.artifacts.every((item, index) =>
      item !== null
      && typeof item === "object"
      && typeof item.path === "string"
      && typeof item.sizeBytes === "number"
      && typeof item.sha256 === "string"
      && item.path === LIPFORCING_IMAGE_ARTIFACT_PATHS[index]
      && Number.isInteger(item.sizeBytes)
      && item.sizeBytes > 0
      && item.sizeBytes <= MAX_COPIED_ARTIFACT_BYTES
      && HASH_PATTERN.test(item.sha256))
    && HASH_PATTERN.test(fingerprint)
    && evidenceFingerprint(base) === fingerprint;
}

function validateInspection(inspection: DockerImageInspection): void {
  if (!IMAGE_ID_PATTERN.test(inspection.id)) {
    throw new Error("LipForcing-Image besitzt keine gültige unveränderliche Image-ID.");
  }
  if (
    inspection.labels["org.opencontainers.image.revision"] !== LIPFORCING_IMAGE_SOURCE_REVISION
    || inspection.labels["com.moddy.ltx-studio.lipforcing.patchset"] !== LIPFORCING_IMAGE_PATCH_SET_ID
  ) {
    throw new Error("LipForcing-Image besitzt nicht Pin und Patchset v2.");
  }
}

export function captureLipForcingImageIdentity(
  requestedReference: string,
  operations: LipForcingImageIdentityOperations = defaultOperations,
  hostArtifacts: LipForcingHostArtifacts = defaultHostArtifacts(),
): ProvenanceContainerImageEvidence {
  assertRequestedReference(requestedReference);
  const inspection = operations.inspect(requestedReference);
  validateInspection(inspection);
  if (IMAGE_ID_PATTERN.test(requestedReference) && inspection.id !== requestedReference) {
    throw new Error("Angeforderte LipForcing-Image-ID löst auf eine andere Image-ID auf.");
  }
  const requestedRepoDigest = isRepoDigestReference(requestedReference) ? requestedReference : null;
  if (requestedRepoDigest && !inspection.repoDigests.includes(requestedRepoDigest)) {
    throw new Error("Konfigurierter LipForcing-RepoDigest gehört nicht zur aufgelösten Image-ID.");
  }
  const executionReference = requestedRepoDigest ?? inspection.id;
  const copied = operations.copyArtifacts(
    executionReference,
    inspection.id,
    LIPFORCING_IMAGE_ARTIFACT_PATHS,
  );
  const base = {
    role: "container:lipforcing-runtime" as const,
    requestedReference,
    executionReference,
    imageId: inspection.id,
    // Mutable-tag aliases are forensic only. Only an explicitly selected
    // RepoDigest participates in execution authority.
    repoDigest: requestedRepoDigest,
    sourceRevision: LIPFORCING_IMAGE_SOURCE_REVISION,
    patchSetId: LIPFORCING_IMAGE_PATCH_SET_ID,
    artifacts: parseAndVerifyImageArtifacts(copied, hostArtifacts),
  };
  return { ...base, fingerprint: evidenceFingerprint(base) };
}

export function verifyLipForcingImageIdentity(
  evidence: ProvenanceContainerImageEvidence,
  operations: LipForcingImageIdentityOperations = defaultOperations,
  hostArtifacts: LipForcingHostArtifacts = defaultHostArtifacts(),
): string | null {
  try {
    if (!validEvidenceShape(evidence)) {
      return "Gebundene LipForcing-Containeridentität ist strukturell oder kryptografisch ungültig.";
    }
    const inspection = operations.inspect(evidence.executionReference);
    validateInspection(inspection);
    if (inspection.id !== evidence.imageId) {
      return "Gebundene LipForcing-Ausführungsreferenz löst auf eine andere Image-ID auf.";
    }
    if (evidence.repoDigest !== null && !inspection.repoDigests.includes(evidence.repoDigest)) {
      return "Gebundener LipForcing-RepoDigest ist an der Image-ID nicht mehr vorhanden.";
    }
    const copied = operations.copyArtifacts(
      evidence.executionReference,
      evidence.imageId,
      LIPFORCING_IMAGE_ARTIFACT_PATHS,
    );
    const currentArtifacts = parseAndVerifyImageArtifacts(copied, hostArtifacts);
    if (stableJson(currentArtifacts) !== stableJson(evidence.artifacts)) {
      return "Tatsächliche LipForcing-In-Image-Artefakte weichen von der gebundenen Identität ab.";
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "LipForcing-Containeridentität konnte nicht verifiziert werden.";
  }
}

export function lipForcingImageIdentity(
  images: readonly ProvenanceContainerImageEvidence[] | undefined,
): ProvenanceContainerImageEvidence | null {
  const matching = images?.filter((image) => image.role === "container:lipforcing-runtime") ?? [];
  return matching.length === 1 && validEvidenceShape(matching[0]) ? matching[0] : null;
}
