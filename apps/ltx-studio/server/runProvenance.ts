import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, release } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { GenerationRequest } from "../shared/pipelines.js";
import type {
  ProvenanceCodeEvidence,
  ProvenanceFileEntry,
  ProvenanceFileEvidence,
  ProvenanceRuntimeEvidence,
  RunProvenance,
} from "../shared/provenance.js";
import { releaseIdentity } from "./releaseIdentity.js";
import { upstreamWorkflowContractsForRequest } from "../shared/upstreamWorkflowContracts.js";
import type { CommandPlan, PathRequirement } from "./command.js";
import {
  appRoot,
  latentSyncCheckpointPath,
  latentSyncInsightFaceRoot,
  latentSyncVaeRoot,
  latentSyncWhisperPath,
  lipForcingModelRoot,
  longcatProjectRoot,
  museTalkModelRoot,
  provenanceCachePath,
  repoRoot,
} from "./config.js";

type FileRevision = {
  sizeBytes: number;
  modifiedAtMs: number;
  changedAtMs: number;
  fileId: string;
  deviceId: string;
};

type HashCacheRecord = FileRevision & {
  path: string;
  sha256: string;
  usedAt: string;
};

type HashCacheState = {
  schemaVersion: "ltx-studio-content-hash-cache.v1";
  records: Record<string, HashCacheRecord>;
};

const MAX_HASH_CACHE_RECORDS = 10_000;
const MAX_UNTRACKED_CODE_FILES = 512;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const REQUIRED_GEMMA_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer.model",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "added_tokens.json",
  "chat_template.json",
  "chat_template.jinja",
  "processor_config.json",
  "model.safetensors.index.json",
  "model.safetensors",
];

let hashCache: HashCacheState | null = null;

function sha256Text(value: string): string {
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
  return JSON.stringify(value);
}

function currentFileRevision(path: string): FileRevision {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0) {
    throw new Error(`Provenienzdatei ist keine lesbare reguläre Datei: ${path}`);
  }
  return {
    sizeBytes: stats.size,
    modifiedAtMs: stats.mtimeMs,
    changedAtMs: stats.ctimeMs,
    fileId: String(stats.ino),
    deviceId: String(stats.dev),
  };
}

function revisionsEqual(left: FileRevision, right: FileRevision): boolean {
  return left.sizeBytes === right.sizeBytes
    && Math.abs(left.modifiedAtMs - right.modifiedAtMs) < 1
    && Math.abs(left.changedAtMs - right.changedAtMs) < 1
    && left.fileId === right.fileId
    && left.deviceId === right.deviceId;
}

function cacheKey(revision: FileRevision): string {
  return [
    revision.deviceId,
    revision.fileId,
    revision.sizeBytes,
    revision.modifiedAtMs.toFixed(3),
    revision.changedAtMs.toFixed(3),
  ].join(":");
}

function loadHashCache(): HashCacheState {
  if (hashCache) return hashCache;
  try {
    const parsed = JSON.parse(readFileSync(provenanceCachePath, "utf8")) as Partial<HashCacheState>;
    if (parsed.schemaVersion === "ltx-studio-content-hash-cache.v1" && parsed.records) {
      hashCache = {
        schemaVersion: "ltx-studio-content-hash-cache.v1",
        records: Object.fromEntries(Object.entries(parsed.records).filter(([, value]) =>
          value
          && typeof value.path === "string"
          && typeof value.sha256 === "string"
          && HASH_PATTERN.test(value.sha256))),
      };
      return hashCache;
    }
  } catch {
    // A stale or truncated acceleration cache is safe to rebuild.
  }
  hashCache = { schemaVersion: "ltx-studio-content-hash-cache.v1", records: {} };
  return hashCache;
}

function persistHashCache(): void {
  const cache = loadHashCache();
  const trimmed = Object.entries(cache.records)
    .sort(([, left], [, right]) => right.usedAt.localeCompare(left.usedAt))
    .slice(0, MAX_HASH_CACHE_RECORDS);
  cache.records = Object.fromEntries(trimmed);
  const temporaryPath = `${provenanceCachePath}.tmp`;
  mkdirSync(dirname(provenanceCachePath), { recursive: true, mode: 0o700 });
  writeFileSync(temporaryPath, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, provenanceCachePath);
}

async function hashFile(path: string): Promise<{ revision: FileRevision; sha256: string }> {
  const before = currentFileRevision(path);
  const key = cacheKey(before);
  const cache = loadHashCache();
  const cached = cache.records[key];
  if (cached && revisionsEqual(cached, before) && cached.path === resolve(path)) {
    cached.usedAt = new Date().toISOString();
    return { revision: before, sha256: cached.sha256 };
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  const after = currentFileRevision(path);
  if (!revisionsEqual(before, after)) {
    throw new Error(`Datei wurde während der Provenienzerfassung verändert: ${path}`);
  }
  const sha256 = digest.digest("hex");
  cache.records[key] = {
    ...after,
    path: resolve(path),
    sha256,
    usedAt: new Date().toISOString(),
  };
  persistHashCache();
  return { revision: after, sha256 };
}

export async function captureProvenanceFile(
  path: string,
  role: string,
  relativePath = "",
): Promise<ProvenanceFileEvidence> {
  const resolvedPath = resolve(path);
  const { revision, sha256 } = await hashFile(resolvedPath);
  return {
    role,
    path: resolvedPath,
    kind: "file",
    sizeBytes: revision.sizeBytes,
    modifiedAtMs: revision.modifiedAtMs,
    changedAtMs: revision.changedAtMs,
    fileId: revision.fileId,
    sha256,
    entries: relativePath ? [{
      relativePath,
      sizeBytes: revision.sizeBytes,
      modifiedAtMs: revision.modifiedAtMs,
      changedAtMs: revision.changedAtMs,
      fileId: revision.fileId,
      sha256,
    }] : [],
  };
}

function safeGemmaRelativePath(root: string, value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsicherer Gemma-Manifestpfad: ${value}`);
  }
  const resolvedPath = resolve(root, normalized);
  if (!resolvedPath.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`Gemma-Manifestpfad verlässt das Modellverzeichnis: ${value}`);
  }
  return normalized;
}

function gemmaRelativeFiles(root: string): string[] {
  const files = new Set(
    REQUIRED_GEMMA_FILES.filter((name) => existsSync(join(root, name))),
  );
  const indexPath = join(root, "model.safetensors.index.json");
  if (existsSync(indexPath)) {
    const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as {
      weight_map?: Record<string, unknown>;
    };
    if (!parsed.weight_map || typeof parsed.weight_map !== "object") {
      throw new Error(`Gemma-Index enthält keine weight_map: ${indexPath}`);
    }
    for (const value of Object.values(parsed.weight_map)) {
      if (typeof value !== "string") throw new Error(`Gemma-Index enthält einen ungültigen Shard: ${indexPath}`);
      files.add(safeGemmaRelativePath(root, value));
    }
  }
  return [...files].sort();
}

export async function captureGemmaManifest(path: string, role = "model:gemma-root"): Promise<ProvenanceFileEvidence> {
  const root = resolve(path);
  const rootStats = statSync(root);
  if (!rootStats.isDirectory()) throw new Error(`Gemma Root ist kein Verzeichnis: ${root}`);
  const entries: ProvenanceFileEntry[] = [];
  for (const relativePath of gemmaRelativeFiles(root)) {
    const evidence = await captureProvenanceFile(join(root, relativePath), role, relativePath);
    entries.push(evidence.entries[0]);
  }
  if (entries.length === 0) throw new Error(`Gemma Root enthält keine verwendbaren Modelldateien: ${root}`);
  const sizeBytes = entries.reduce((total, entry) => total + entry.sizeBytes, 0);
  const sha256 = sha256Text(stableJson(entries));
  return {
    role,
    path: root,
    kind: "directory-manifest",
    sizeBytes,
    modifiedAtMs: rootStats.mtimeMs,
    changedAtMs: rootStats.ctimeMs,
    fileId: String(rootStats.ino),
    sha256,
    entries,
  };
}

function roleForRequirement(requirement: PathRequirement, index: number): string {
  const label = requirement.label.toLowerCase();
  if (label === "gemma root") return "model:gemma-root";
  if (label === "prompt-enhancer gemma root") return "model:prompt-enhancer-gemma-root";
  if (label.includes("ltx-2.5 transformer")) return "model:ltx-2.5-transformer";
  if (label.includes("ltx-2.5 textencoder")) return "model:ltx-2.5-text-encoder";
  if (label.includes("ltx-2.5 video-vae")) return "model:ltx-2.5-video-vae";
  if (label.includes("ltx-2.5 audio-vae")) return "model:ltx-2.5-audio-vae";
  if (label.includes("ltx-2.5 duration-head")) return "model:ltx-2.5-duration-head";
  if (label.includes("checkpoint")) return `model:checkpoint:${index}`;
  if (label.includes("upscaler")) return `model:spatial-upscaler:${index}`;
  if (label.includes("lora")) return `model:lora:${index}`;
  if (label.includes("amax")) return `model:amax:${index}`;
  if (label.includes("finale tonspur")) return "input:final-audio-mix";
  if (label.includes("audiodatei")) return "input:conditioning-audio";
  if (label.includes("referenzvideo")) return "input:reference-video";
  if (label.includes("quellvideo")) return "input:source-video";
  if (label.includes("kontrollvideo")) return `input:conditioning-video:${index}`;
  if (label.includes("kontrollmaske")) return "input:conditioning-mask";
  if (label.startsWith("bild ")) return `input:reference-image:${index}`;
  return `input:${label.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "file"}:${index}`;
}

async function captureRequiredFiles(requirements: readonly PathRequirement[]): Promise<ProvenanceFileEvidence[]> {
  const evidence: ProvenanceFileEvidence[] = [];
  const seen = new Set<string>();
  for (const [index, requirement] of requirements.entries()) {
    if (requirement.label.toLowerCase().startsWith("gemma prozessorkonfiguration")) {
      // The preprocessor is already an explicit member of the Gemma directory manifest.
      continue;
    }
    const role = roleForRequirement(requirement, index);
    const key = `${role}\0${resolve(requirement.path)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (requirement.kind === "directory") {
      evidence.push(await captureGemmaManifest(requirement.path, role));
    } else {
      const file = await captureProvenanceFile(requirement.path, role);
      if (requirement.expectedSizeBytes !== undefined && file.sizeBytes !== requirement.expectedSizeBytes) {
        throw new Error(
          `${requirement.label}: Größe ${file.sizeBytes} weicht vom gepinnten Wert `
          + `${requirement.expectedSizeBytes} ab.`,
        );
      }
      if (requirement.expectedSha256 !== undefined && file.sha256 !== requirement.expectedSha256) {
        throw new Error(
          `${requirement.label}: SHA-256 ${file.sha256} weicht vom gepinnten Wert `
          + `${requirement.expectedSha256} ab.`,
        );
      }
      evidence.push(file);
    }
  }
  return evidence;
}

function git(root: string, args: string[], maxBuffer = 64 * 1024 * 1024): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

async function captureCodeEvidence(repositoryRoot: string): Promise<ProvenanceCodeEvidence> {
  const root = resolve(repositoryRoot);
  if (root === resolve(repoRoot) && releaseIdentity.sealed) {
    if (!releaseIdentity.sourceCommit || !releaseIdentity.manifestSha256) {
      throw new Error("Versiegelte Release-Identität ist unvollständig.");
    }
    const base = {
      repositoryRoot: root,
      commit: releaseIdentity.sourceCommit,
      dirty: false,
      trackedDiffSha256: releaseIdentity.manifestSha256,
      untracked: [] as ProvenanceFileEvidence[],
    };
    return {
      ...base,
      fingerprint: sha256Text(stableJson({
        commit: base.commit,
        trackedDiffSha256: base.trackedDiffSha256,
        untracked: [],
      })),
    };
  }
  const commit = git(root, ["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Git-Commit ist nicht bestimmbar: ${root}`);
  const trackedDiff = git(root, ["diff", "--binary", "HEAD", "--", "."]);
  const allUntrackedPaths = git(root, ["ls-files", "--others", "--exclude-standard", "--", "."])
    .split("\n")
    .filter(Boolean);
  if (allUntrackedPaths.length > MAX_UNTRACKED_CODE_FILES) {
    throw new Error(
      `Code-Provenienz verweigert ${allUntrackedPaths.length} ungetrackte Dateien in ${root}; `
      + `zulässig sind höchstens ${MAX_UNTRACKED_CODE_FILES}.`,
    );
  }
  const untrackedPaths = allUntrackedPaths;
  const untracked: ProvenanceFileEvidence[] = [];
  for (const [index, path] of untrackedPaths.entries()) {
    untracked.push(await captureProvenanceFile(join(root, path), `code:untracked:${index}`, path));
  }
  const trackedDiffSha256 = sha256Text(trackedDiff);
  const fingerprint = sha256Text(stableJson({
    commit,
    trackedDiffSha256,
    untracked: untracked.map(({ path, sha256 }) => ({ path: relative(root, path), sha256 })),
  }));
  return {
    repositoryRoot: root,
    commit,
    dirty: trackedDiff.length > 0 || untracked.length > 0,
    trackedDiffSha256,
    untracked,
    fingerprint,
  };
}

function firstLine(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).split(/\r?\n/, 1)[0].trim() || null;
  } catch {
    return null;
  }
}

function captureRuntimeEvidence(executable: string): ProvenanceRuntimeEvidence {
  const resolvedExecutable = isAbsolute(executable)
    ? executable
    : firstLine("which", [executable]) ?? executable;
  const script = [
    "import importlib.metadata as m,json,platform,sys",
    "names=['torch','transformers','diffusers','safetensors','accelerate','ltx-pipelines','ltx-core']",
    "versions={}",
    "for name in names:",
    "  try: versions[name]=m.version(name)",
    "  except m.PackageNotFoundError: versions[name]=None",
    "print(json.dumps({'python':sys.version.split()[0],'packages':versions},sort_keys=True))",
  ].join("\n");
  const parsed = JSON.parse(execFileSync(resolvedExecutable, ["-I", "-c", script], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  })) as { python: string; packages: Record<string, string | null> };
  const base = {
    platform: platform(),
    architecture: arch(),
    kernelRelease: release(),
    nodeVersion: process.version,
    pythonExecutable: resolvedExecutable,
    pythonVersion: parsed.python,
    packages: parsed.packages,
    ffmpegVersion: firstLine("ffmpeg", ["-version"]),
  };
  const evidence: ProvenanceRuntimeEvidence = {
    ...base,
    fingerprint: sha256Text(stableJson(base)),
  };
  return evidence;
}

function provenanceFingerprint(value: Omit<RunProvenance, "fingerprint" | "verifiedAt">): string {
  return sha256Text(stableJson(value));
}

export async function captureRunProvenance(
  request: GenerationRequest,
  plan: CommandPlan,
): Promise<RunProvenance> {
  const files = await captureRequiredFiles(plan.requiredPaths);
  if (request.postprocess.longcatLipsync.enabled) {
    files.push(
      await captureProvenanceFile(join(appRoot, "scripts", "longcat-hybrid.py"), "code:longcat-adapter"),
      await captureProvenanceFile(join(appRoot, "models", "face_detection_yunet_2023mar.onnx"), "model:longcat-face-detector"),
    );
  }
  if (request.postprocess.latentSync.enabled) {
    files.push(
      await captureProvenanceFile(join(appRoot, "scripts", "latentsync-refiner.py"), "code:latentsync-adapter"),
      await captureProvenanceFile(join(appRoot, "scripts", "refiner_audio.py"), "code:refiner-audio-window"),
      await captureProvenanceFile(join(appRoot, "deploy", "latentsync", "Dockerfile"), "code:latentsync-dockerfile"),
      await captureProvenanceFile(join(appRoot, "deploy", "latentsync", "runner.py"), "code:latentsync-runner"),
      await captureProvenanceFile(join(appRoot, "deploy", "latentsync", "timeline.py"), "code:latentsync-timeline"),
      await captureProvenanceFile(
        join(appRoot, "deploy", "latentsync", "patch_arm64_decord.py"),
        "code:latentsync-arm64-patch",
      ),
      await captureProvenanceFile(
        join(appRoot, "deploy", "latentsync", "face_detector_insightface.py"),
        "code:latentsync-face-detector-adapter",
      ),
      await captureProvenanceFile(latentSyncCheckpointPath, "model:latentsync-unet"),
      await captureProvenanceFile(latentSyncWhisperPath, "model:latentsync-whisper"),
      await captureProvenanceFile(
        join(latentSyncVaeRoot, "diffusion_pytorch_model.safetensors"),
        "model:latentsync-vae",
      ),
      await captureProvenanceFile(join(latentSyncVaeRoot, "config.json"), "model:latentsync-vae-config"),
      await captureProvenanceFile(
        join(latentSyncInsightFaceRoot, "models", "buffalo_l", "det_10g.onnx"),
        "model:latentsync-face-detector",
      ),
      await captureProvenanceFile(
        join(latentSyncInsightFaceRoot, "models", "buffalo_l", "2d106det.onnx"),
        "model:latentsync-106-landmarks",
      ),
    );
  }
  if (request.postprocess.museTalk.enabled) {
    files.push(
      await captureProvenanceFile(join(appRoot, "scripts", "musetalk-refiner.py"), "code:musetalk-adapter"),
      await captureProvenanceFile(join(appRoot, "scripts", "refiner_audio.py"), "code:refiner-audio-window"),
      await captureProvenanceFile(join(appRoot, "deploy", "musetalk", "Dockerfile"), "code:musetalk-dockerfile"),
      await captureProvenanceFile(
        join(appRoot, "deploy", "musetalk", "container_runner.py"),
        "code:musetalk-container-runner",
      ),
      await captureProvenanceFile(
        join(appRoot, "deploy", "musetalk", "preprocessing_insightface.py"),
        "code:musetalk-insightface-adapter",
      ),
      await captureProvenanceFile(
        join(appRoot, "deploy", "musetalk", "patch_verified_legacy_weights.py"),
        "code:musetalk-pytorch-legacy-patch",
      ),
      await captureProvenanceFile(join(appRoot, "deploy", "musetalk", "timeline.py"), "code:musetalk-timeline"),
      await captureProvenanceFile(
        join(museTalkModelRoot, "musetalkV15", "musetalk.json"),
        "model:musetalk-unet-config",
      ),
      await captureProvenanceFile(
        join(museTalkModelRoot, "musetalkV15", "unet.pth"),
        "model:musetalk-unet",
      ),
      await captureProvenanceFile(join(museTalkModelRoot, "sd-vae", "config.json"), "model:musetalk-vae-config"),
      await captureProvenanceFile(
        join(museTalkModelRoot, "sd-vae", "diffusion_pytorch_model.bin"),
        "model:musetalk-vae",
      ),
      await captureProvenanceFile(join(museTalkModelRoot, "whisper", "config.json"), "model:musetalk-whisper-config"),
      await captureProvenanceFile(
        join(museTalkModelRoot, "whisper", "preprocessor_config.json"),
        "model:musetalk-whisper-preprocessor",
      ),
      await captureProvenanceFile(
        join(museTalkModelRoot, "whisper", "pytorch_model.bin"),
        "model:musetalk-whisper",
      ),
      await captureProvenanceFile(
        join(museTalkModelRoot, "face-parse-bisent", "79999_iter.pth"),
        "model:musetalk-face-parser",
      ),
      await captureProvenanceFile(
        join(museTalkModelRoot, "face-parse-bisent", "resnet18-5c106cde.pth"),
        "model:musetalk-face-parser-resnet",
      ),
      await captureProvenanceFile(
        join(latentSyncInsightFaceRoot, "models", "buffalo_l", "det_10g.onnx"),
        "model:musetalk-face-detector",
      ),
      await captureProvenanceFile(
        join(latentSyncInsightFaceRoot, "models", "buffalo_l", "2d106det.onnx"),
        "model:musetalk-106-landmarks",
      ),
    );
  }
  if (request.postprocess.lipForcing.enabled) {
    files.push(
      await captureProvenanceFile(
        join(appRoot, "scripts", "lipforcing-refiner.py"),
        "code:lipforcing-adapter",
      ),
      await captureProvenanceFile(
        join(appRoot, "deploy", "lipforcing", "Dockerfile"),
        "code:lipforcing-dockerfile",
      ),
      await captureProvenanceFile(
        join(appRoot, "deploy", "lipforcing", "container_runner.py"),
        "code:lipforcing-container-runner",
      ),
      await captureProvenanceFile(
        join(appRoot, "deploy", "lipforcing", "patch_verified_runtime.py"),
        "code:lipforcing-runtime-patch",
      ),
      await captureProvenanceFile(
        join(appRoot, "deploy", "lipforcing", "timeline.py"),
        "code:lipforcing-timeline",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "lipforcing_14b.pth"),
        "model:lipforcing-14b",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "Wan2.1_VAE.pth"),
        "model:lipforcing-wan-vae",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "wav2vec2-base-960h", "model.safetensors"),
        "model:lipforcing-wav2vec2",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "wav2vec2-base-960h", "config.json"),
        "model:lipforcing-wav2vec2-config",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "wav2vec2-base-960h", "preprocessor_config.json"),
        "model:lipforcing-wav2vec2-preprocessor",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "wav2vec2-base-960h", "feature_extractor_config.json"),
        "model:lipforcing-wav2vec2-feature-extractor",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "mask.png"),
        "model:lipforcing-mouth-mask",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "text_emb.pt"),
        "model:lipforcing-text-embedding",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "text-embedding-provenance.json"),
        "model:lipforcing-text-embedding-provenance",
      ),
      await captureProvenanceFile(
        join(lipForcingModelRoot, "ltx-studio-model-manifest.json"),
        "model:lipforcing-manifest",
      ),
      await captureProvenanceFile(
        join(latentSyncInsightFaceRoot, "models", "buffalo_l", "det_10g.onnx"),
        "model:lipforcing-face-detector",
      ),
      await captureProvenanceFile(
        join(latentSyncInsightFaceRoot, "models", "buffalo_l", "2d106det.onnx"),
        "model:lipforcing-106-landmarks",
      ),
    );
    if (request.postprocess.lipForcing.decoder === "streaming-taehv") {
      files.push(
        await captureProvenanceFile(
          join(lipForcingModelRoot, "taew2_1.pth"),
          "model:lipforcing-taehv",
        ),
      );
    }
  }
  const codeRoots = request.postprocess.longcatLipsync.enabled
    ? [repoRoot, longcatProjectRoot]
    : [repoRoot];
  const code: ProvenanceCodeEvidence[] = [];
  for (const root of codeRoots) code.push(await captureCodeEvidence(root));
  const runtime = captureRuntimeEvidence(plan.executable);
  const upstreamContracts = upstreamWorkflowContractsForRequest(request);
  const capturedAt = new Date().toISOString();
  const base = {
    schemaVersion: "ltx-studio-run-provenance.v2" as const,
    capturedAt,
    files,
    code,
    runtime,
    upstreamContracts,
    release: releaseIdentity,
  };
  return {
    ...base,
    verifiedAt: null,
    fingerprint: provenanceFingerprint(base),
  };
}

export async function bindRunProvenanceFile(
  evidence: RunProvenance,
  path: string,
  role: string,
): Promise<RunProvenance> {
  const file = await captureProvenanceFile(path, role);
  const base = {
    schemaVersion: evidence.schemaVersion,
    capturedAt: evidence.capturedAt,
    files: [
      ...evidence.files.filter((candidate) => candidate.role !== role),
      file,
    ],
    code: evidence.code,
    runtime: evidence.runtime,
    upstreamContracts: evidence.upstreamContracts ?? [],
    release: evidence.release,
  };
  return {
    ...base,
    verifiedAt: null,
    fingerprint: provenanceFingerprint(base),
  };
}

function revisionFromEvidence(evidence: ProvenanceFileEvidence | ProvenanceFileEntry): FileRevision {
  const stats = "path" in evidence ? lstatSync(evidence.path) : null;
  return {
    sizeBytes: evidence.sizeBytes,
    modifiedAtMs: evidence.modifiedAtMs,
    changedAtMs: evidence.changedAtMs,
    fileId: evidence.fileId,
    deviceId: stats ? String(stats.dev) : "",
  };
}

export function verifyProvenanceFileEvidence(evidence: ProvenanceFileEvidence): string | null {
  if (evidence.kind === "file") {
    const current = currentFileRevision(evidence.path);
    const expected = revisionFromEvidence(evidence);
    expected.deviceId = current.deviceId;
    return revisionsEqual(current, expected) ? null : `Dateirevision hat sich geändert: ${evidence.path}`;
  }
  const currentRelative = gemmaRelativeFiles(evidence.path);
  const expectedRelative = evidence.entries.map((entry) => entry.relativePath);
  if (stableJson(currentRelative) !== stableJson(expectedRelative)) {
    return `Gemma-Manifestdateien haben sich geändert: ${evidence.path}`;
  }
  for (const entry of evidence.entries) {
    const path = join(evidence.path, entry.relativePath);
    const current = currentFileRevision(path);
    if (current.sizeBytes !== entry.sizeBytes
      || Math.abs(current.modifiedAtMs - entry.modifiedAtMs) >= 1
      || Math.abs(current.changedAtMs - entry.changedAtMs) >= 1
      || current.fileId !== entry.fileId) {
      return `Gemma-Manifestrevision hat sich geändert: ${path}`;
    }
  }
  return null;
}

export async function verifyRunProvenance(
  evidence: RunProvenance,
  request: GenerationRequest,
): Promise<{ evidence: RunProvenance; error: string | null }> {
  try {
    if (evidence.schemaVersion === "ltx-studio-run-provenance.v2"
      && stableJson(evidence.release) !== stableJson(releaseIdentity)) {
      return { evidence, error: "Die gebundene Release-Identität stimmt nicht mit dem laufenden Server überein." };
    }
    if (evidence.upstreamContracts !== undefined) {
      const expectedContracts = upstreamWorkflowContractsForRequest(request);
      if (stableJson(evidence.upstreamContracts) !== stableJson(expectedContracts)) {
        return {
          evidence,
          error: "Der gebundene offizielle Workflow-Vertrag stimmt nicht mehr mit dem Auftrag überein.",
        };
      }
    }
    for (const file of evidence.files) {
      const error = verifyProvenanceFileEvidence(file);
      if (error) return { evidence, error };
    }
    const codeRoots = request.postprocess.longcatLipsync.enabled
      ? [repoRoot, longcatProjectRoot]
      : [repoRoot];
    if (codeRoots.length !== evidence.code.length) {
      return { evidence, error: "Die gebundenen Code-Repositories stimmen nicht mehr mit dem Auftrag überein." };
    }
    for (const [index, root] of codeRoots.entries()) {
      const current = await captureCodeEvidence(root);
      if (current.fingerprint !== evidence.code[index]?.fingerprint) {
        return { evidence, error: `Codezustand wurde nach der Provenienzerfassung verändert: ${root}` };
      }
    }
    const runtime = captureRuntimeEvidence(evidence.runtime.pythonExecutable);
    if (runtime.fingerprint !== evidence.runtime.fingerprint) {
      return { evidence, error: "Python-/Paket-/FFmpeg-Runtime wurde nach der Provenienzerfassung verändert." };
    }
    return {
      evidence: {
        ...evidence,
        verifiedAt: new Date().toISOString(),
      },
      error: null,
    };
  } catch (error) {
    return {
      evidence,
      error: error instanceof Error ? error.message : "Laufprovenienz konnte nicht verifiziert werden.",
    };
  }
}

function validFileEntry(value: unknown): value is ProvenanceFileEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProvenanceFileEntry>;
  return typeof item.relativePath === "string"
    && item.relativePath.length > 0
    && !isAbsolute(item.relativePath)
    && !item.relativePath.replaceAll("\\", "/").split("/").includes("..")
    && typeof item.sizeBytes === "number"
    && Number.isFinite(item.sizeBytes)
    && item.sizeBytes > 0
    && typeof item.modifiedAtMs === "number"
    && Number.isFinite(item.modifiedAtMs)
    && item.modifiedAtMs >= 0
    && typeof item.changedAtMs === "number"
    && Number.isFinite(item.changedAtMs)
    && item.changedAtMs >= 0
    && typeof item.fileId === "string"
    && /^\d{1,64}$/.test(item.fileId)
    && typeof item.sha256 === "string"
    && HASH_PATTERN.test(item.sha256);
}

function validFileEvidence(value: unknown): value is ProvenanceFileEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProvenanceFileEvidence>;
  return typeof item.role === "string"
    && item.role.length > 0
    && item.role.length <= 200
    && typeof item.path === "string"
    && isAbsolute(item.path)
    && ["file", "directory-manifest"].includes(item.kind ?? "")
    && typeof item.sizeBytes === "number"
    && Number.isFinite(item.sizeBytes)
    && item.sizeBytes > 0
    && typeof item.modifiedAtMs === "number"
    && Number.isFinite(item.modifiedAtMs)
    && item.modifiedAtMs >= 0
    && typeof item.changedAtMs === "number"
    && Number.isFinite(item.changedAtMs)
    && item.changedAtMs >= 0
    && typeof item.fileId === "string"
    && /^\d{1,64}$/.test(item.fileId)
    && typeof item.sha256 === "string"
    && HASH_PATTERN.test(item.sha256)
    && Array.isArray(item.entries)
    && item.entries.every(validFileEntry)
    && (item.kind === "file" ? item.entries.length <= 1 : item.entries.length > 0);
}

export function normalizeProvenanceFileEvidence(value: unknown): ProvenanceFileEvidence | null {
  return validFileEvidence(value) ? structuredClone(value) : null;
}

function validCodeEvidence(value: unknown): value is ProvenanceCodeEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProvenanceCodeEvidence>;
  return typeof item.repositoryRoot === "string"
    && typeof item.commit === "string"
    && /^[0-9a-f]{40}$/i.test(item.commit)
    && typeof item.dirty === "boolean"
    && typeof item.trackedDiffSha256 === "string"
    && HASH_PATTERN.test(item.trackedDiffSha256)
    && Array.isArray(item.untracked)
    && item.untracked.every(validFileEvidence)
    && typeof item.fingerprint === "string"
    && HASH_PATTERN.test(item.fingerprint);
}

function validRuntimeEvidence(value: unknown): value is ProvenanceRuntimeEvidence {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProvenanceRuntimeEvidence>;
  return typeof item.platform === "string"
    && typeof item.architecture === "string"
    && typeof item.kernelRelease === "string"
    && typeof item.nodeVersion === "string"
    && typeof item.pythonExecutable === "string"
    && typeof item.pythonVersion === "string"
    && item.packages !== null
    && typeof item.packages === "object"
    && Object.values(item.packages).every((version) => version === null || typeof version === "string")
    && (item.ffmpegVersion === null || typeof item.ffmpegVersion === "string")
    && typeof item.fingerprint === "string"
    && HASH_PATTERN.test(item.fingerprint);
}

function validUpstreamContract(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.role === "string"
    && item.role.length > 0
    && typeof item.repository === "string"
    && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(item.repository)
    && typeof item.commit === "string"
    && /^[0-9a-f]{40}$/i.test(item.commit)
    && typeof item.path === "string"
    && item.path.length > 0
    && typeof item.sha256 === "string"
    && HASH_PATTERN.test(item.sha256);
}

function validReleaseIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const nullableHash = (candidate: unknown) => candidate === null
    || (typeof candidate === "string" && HASH_PATTERN.test(candidate));
  const nullableCommit = (candidate: unknown) => candidate === null
    || (typeof candidate === "string" && /^[0-9a-f]{40}$/i.test(candidate));
  return typeof item.sealed === "boolean"
    && typeof item.verified === "boolean"
    && nullableHash(item.releaseDigest)
    && nullableHash(item.manifestSha256)
    && nullableCommit(item.sourceCommit)
    && (item.sealed
      ? item.verified === true && item.releaseDigest !== null && item.manifestSha256 === item.releaseDigest
      : item.verified === false && item.releaseDigest === null && item.manifestSha256 === null && item.sourceCommit === null);
}

export function normalizeRunProvenance(value: unknown): RunProvenance | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<RunProvenance>;
  if (!(["ltx-studio-run-provenance.v1", "ltx-studio-run-provenance.v2"] as const).includes(item.schemaVersion as never)
    || typeof item.capturedAt !== "string"
    || !Number.isFinite(Date.parse(item.capturedAt))
    || (item.verifiedAt !== null && (typeof item.verifiedAt !== "string" || !Number.isFinite(Date.parse(item.verifiedAt))))
    || !Array.isArray(item.files)
    || !item.files.every(validFileEvidence)
    || !Array.isArray(item.code)
    || !item.code.every(validCodeEvidence)
    || !validRuntimeEvidence(item.runtime)
    || (item.upstreamContracts !== undefined
      && (!Array.isArray(item.upstreamContracts) || !item.upstreamContracts.every(validUpstreamContract)))
    || (item.schemaVersion === "ltx-studio-run-provenance.v2" && !validReleaseIdentity(item.release))
    || (item.schemaVersion === "ltx-studio-run-provenance.v1" && item.release !== undefined)
    || typeof item.fingerprint !== "string"
    || !HASH_PATTERN.test(item.fingerprint)) return null;
  return structuredClone(item as RunProvenance);
}
