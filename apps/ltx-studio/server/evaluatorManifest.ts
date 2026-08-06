import { createHash, randomUUID } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  phonemeVisemeEvaluatorManifestSchema,
  unavailablePhonemeVisemeResult,
  visemeMappingSchema,
  type PhonemeVisemeBlockerCode,
  type PhonemeVisemeEvaluatorManifest,
  type PhonemeVisemeResult,
} from "../shared/phonemeVisemeEvaluator.js";
import {
  appRoot,
  phonemeVisemePythonExecutable as defaultPhonemeVisemePythonExecutable,
} from "./config.js";
import {
  capturePinnedPathRevision,
  openPinnedPaths,
  type PinnedPathRevision,
} from "./evaluatorBindings.js";
import {
  evaluatorRuntimeDirectory,
  evaluatorSandboxProperties,
  protectedRuntimeSockets,
} from "./evaluatorSandbox.js";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LEGAL_EVIDENCE_BYTES = 16 * 1024 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;
const MAX_ARTIFACT_CACHE_ENTRIES = 128;
const sha256Pattern = /^[0-9a-f]{64}$/;

type VerifiedRevision = {
  size: number;
  binding: PinnedPathRevision;
  sha256: string;
};

const artifactHashCache = new Map<string, VerifiedRevision>();

export type PhonemeVisemeExecution = {
  method: "mfa-mediapipe-de.v1" | "ctc-espeak-mediapipe-de.v1";
  sandbox: "systemd-system-sandbox.v1";
  artifactRoot: string;
  readOnlyPaths: string[];
  manifestPath: string;
  manifestSha256: string;
  legalApprovalSha256: string;
  runnerPath: string;
  runnerSha256: string;
  pythonExecutable: string;
  pythonRuntimeRoot: string;
  boundPathRevisions: PinnedPathRevision[];
  mfaExecutablePath?: string | null;
  acousticModelPath?: string | null;
  dictionaryPath?: string | null;
  g2pModelPath?: string | null;
  phonemeModelWeightsPath?: string | null;
  phonemeModelConfigPath?: string | null;
  phonemeVocabularyPath?: string | null;
  espeakExecutablePath?: string | null;
  faceLandmarkerPath: string;
  visemeMappingPath: string;
  runtime: {
    pythonVersion: string;
    mfaVersion?: "3.3.9";
    torchVersion?: string;
    transformersVersion?: string;
    phonemizerVersion?: string;
    espeakVersion?: string;
    mediaPipeVersion: string;
    openCvVersion: string;
    numpyVersion: string;
    ffmpegVersion: string;
    ffmpegSha256: string;
    ffprobeSha256: string;
  };
};

export function isPhonemeVisemeExecution(value: unknown): value is PhonemeVisemeExecution {
  if (!value || typeof value !== "object") return false;
  const execution = value as Record<string, unknown>;
  const commonAbsolutePathFields = [
    "artifactRoot",
    "manifestPath",
    "runnerPath",
    "pythonExecutable",
    "faceLandmarkerPath",
    "visemeMappingPath",
  ] as const;
  const methodAbsolutePathFields = execution.method === "mfa-mediapipe-de.v1"
    ? ["mfaExecutablePath", "acousticModelPath", "dictionaryPath"] as const
    : execution.method === "ctc-espeak-mediapipe-de.v1"
      ? [
          "phonemeModelWeightsPath",
          "phonemeModelConfigPath",
          "phonemeVocabularyPath",
          "espeakExecutablePath",
        ] as const
      : null;
  const absolutePathFields = methodAbsolutePathFields
    ? [...commonAbsolutePathFields, ...methodAbsolutePathFields]
    : [];
  if (!methodAbsolutePathFields
    || execution.sandbox !== "systemd-system-sandbox.v1"
    || !absolutePathFields.every((field) =>
      typeof execution[field] === "string"
      && execution[field].length > 0
      && isAbsolute(execution[field]))
    || !Array.isArray(execution.readOnlyPaths)
    || execution.readOnlyPaths.length === 0
    || !execution.readOnlyPaths.every((path) =>
      typeof path === "string" && path.length > 0 && isAbsolute(path))
    || typeof execution.manifestSha256 !== "string"
    || !sha256Pattern.test(execution.manifestSha256)
    || typeof execution.legalApprovalSha256 !== "string"
    || !sha256Pattern.test(execution.legalApprovalSha256)
    || typeof execution.runnerSha256 !== "string"
    || !sha256Pattern.test(execution.runnerSha256)
    || !(execution.g2pModelPath === null
      || (typeof execution.g2pModelPath === "string"
        && execution.g2pModelPath.length > 0
        && isAbsolute(execution.g2pModelPath)))
    || !execution.runtime
    || typeof execution.runtime !== "object") return false;
  const readOnlyPaths = new Set(execution.readOnlyPaths);
  if (!absolutePathFields
    .filter((field) => field !== "artifactRoot" && field !== "pythonExecutable")
    .every((field) => readOnlyPaths.has(execution[field] as string))
    || (typeof execution.g2pModelPath === "string"
      && !readOnlyPaths.has(execution.g2pModelPath))) return false;
  if (!(typeof execution.pythonRuntimeRoot === "string"
      && execution.pythonRuntimeRoot.length > 0
      && isAbsolute(execution.pythonRuntimeRoot))
    || !Array.isArray(execution.boundPathRevisions)
    || execution.boundPathRevisions.length !== execution.readOnlyPaths.length
      + 1
    || !execution.boundPathRevisions.every(isPinnedPathRevision)) return false;
  const pythonExecutable = execution.pythonExecutable as string;
  const pythonRuntimeRoot = execution.pythonRuntimeRoot as string;
  if (!(pythonExecutable === pythonRuntimeRoot
    || pythonExecutable.startsWith(`${pythonRuntimeRoot}/`))) return false;
  const revisionPaths = new Set(
    (execution.boundPathRevisions as PinnedPathRevision[]).map((revision) => revision.path),
  );
  if (![...readOnlyPaths].every((path) => revisionPaths.has(path))
    || !revisionPaths.has(execution.pythonRuntimeRoot)) return false;
  const runtime = execution.runtime as Record<string, unknown>;
  const commonRuntimeValid = typeof runtime.pythonVersion === "string"
    && runtime.pythonVersion.length > 0
    && typeof runtime.mediaPipeVersion === "string"
    && runtime.mediaPipeVersion.length > 0
    && typeof runtime.openCvVersion === "string"
    && runtime.openCvVersion.length > 0
    && typeof runtime.numpyVersion === "string"
    && runtime.numpyVersion.length > 0
    && typeof runtime.ffmpegVersion === "string"
    && runtime.ffmpegVersion.length > 0
    && typeof runtime.ffmpegSha256 === "string"
    && sha256Pattern.test(runtime.ffmpegSha256)
    && typeof runtime.ffprobeSha256 === "string"
    && sha256Pattern.test(runtime.ffprobeSha256);
  if (!commonRuntimeValid) return false;
  if (execution.method === "mfa-mediapipe-de.v1") {
    return runtime.mfaVersion === "3.3.9";
  }
  return typeof runtime.torchVersion === "string"
    && runtime.torchVersion.length > 0
    && typeof runtime.transformersVersion === "string"
    && runtime.transformersVersion.length > 0
    && typeof runtime.phonemizerVersion === "string"
    && runtime.phonemizerVersion.length > 0
    && typeof runtime.espeakVersion === "string"
    && runtime.espeakVersion.length > 0;
}

export type PhonemeVisemeEvaluatorState = {
  fingerprint: string;
  result: PhonemeVisemeResult;
  execution?: PhonemeVisemeExecution | null;
};

export type PhonemeVisemeTrustPins = {
  manifestSha256: string;
  legalApprovalSha256: string;
  runnerSha256: string;
};

function isPinnedPathRevision(value: unknown): value is PinnedPathRevision {
  if (!value || typeof value !== "object") return false;
  const revision = value as Record<string, unknown>;
  return typeof revision.path === "string"
    && isAbsolute(revision.path)
    && (revision.kind === "file" || revision.kind === "directory")
    && ["device", "inode", "size", "modifiedAtNs", "changedAtNs"].every(
      (field) => typeof revision[field] === "string" && /^[0-9]+$/u.test(revision[field]),
    );
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireSealedDynamicUserFile(
  path: string,
  label: string,
  executable = false,
): void {
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink()) {
    throw new Error(`${label} ist keine versiegelte reguläre Datei.`);
  }
  if ((details.mode & 0o004) === 0) {
    throw new Error(`${label} ist für die isolierte DynamicUser-Identität nicht lesbar.`);
  }
  if (executable && (details.mode & 0o001) === 0) {
    throw new Error(`${label} ist für die isolierte DynamicUser-Identität nicht ausführbar.`);
  }
  if ((details.mode & 0o222) !== 0) {
    throw new Error(`${label} ist nicht versiegelt: Schreibbits müssen vor der Freigabe entfernt werden.`);
  }
}

function resolveArtifactPath(root: string, relativePath: string): string {
  let current = realpathSync(root);
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`Symlink im Evaluator-Artefaktpfad ist nicht zulässig: ${relativePath}`);
    }
  }
  return current;
}

function readRegularFile(path: string, maximumBytes: number): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Evaluator-Artefakt ist keine reguläre Datei: ${path}`);
  }
  if (before.size <= 0 || before.size > maximumBytes) {
    throw new Error(`Evaluator-Artefaktgröße außerhalb des Limits: ${path}`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs) {
      throw new Error(`Evaluator-Artefakt wurde während der Prüfung verändert: ${path}`);
    }
    const result = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw new Error(`Evaluator-Artefakt wurde während des Lesens verändert: ${path}`);
    }
    return result;
  } finally {
    closeSync(descriptor);
  }
}

function hashRegularFile(path: string, maximumBytes: number): VerifiedRevision {
  const beforePath = lstatSync(path, { bigint: true });
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) {
    throw new Error(`Evaluator-Artefakt ist keine reguläre Datei: ${path}`);
  }
  if (beforePath.size <= 0n || beforePath.size > BigInt(maximumBytes)) {
    throw new Error(`Evaluator-Artefaktgröße außerhalb des Limits: ${path}`);
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()
      || opened.dev !== beforePath.dev
      || opened.ino !== beforePath.ino
      || opened.size !== beforePath.size
      || opened.mtimeNs !== beforePath.mtimeNs
      || opened.ctimeNs !== beforePath.ctimeNs) {
      throw new Error(`Evaluator-Artefakt wurde während der Prüfung verändert: ${path}`);
    }
    const key = [
      resolve(path),
      opened.dev.toString(),
      opened.ino.toString(),
      opened.size.toString(),
      opened.mtimeNs.toString(),
      opened.ctimeNs.toString(),
    ].join("\0");
    const cached = artifactHashCache.get(key);
    if (cached) {
      artifactHashCache.delete(key);
      artifactHashCache.set(key, cached);
      return cached;
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let offset = 0;
    while (true) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (bytes === 0) break;
      digest.update(bytes === buffer.length ? buffer : buffer.subarray(0, bytes));
      offset += bytes;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs
      || after.ctimeNs !== opened.ctimeNs
      || after.dev !== opened.dev
      || after.ino !== opened.ino) {
      throw new Error(`Evaluator-Artefakt wurde während des Lesens verändert: ${path}`);
    }
    const verified: VerifiedRevision = {
      size: Number(after.size),
      binding: {
        path,
        kind: "file",
        device: after.dev.toString(),
        inode: after.ino.toString(),
        size: after.size.toString(),
        modifiedAtNs: after.mtimeNs.toString(),
        changedAtNs: after.ctimeNs.toString(),
      },
      sha256: digest.digest("hex"),
    };
    artifactHashCache.set(key, verified);
    while (artifactHashCache.size > MAX_ARTIFACT_CACHE_ENTRIES) {
      const oldest = artifactHashCache.keys().next().value;
      if (oldest === undefined) break;
      artifactHashCache.delete(oldest);
    }
    return verified;
  } finally {
    closeSync(descriptor);
  }
}

function parseStrictJson(raw: Buffer): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  let cursor = 0;
  const skipWhitespace = () => {
    while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1;
  };
  const parseString = (): string => {
    const start = cursor;
    if (source[cursor] !== "\"") throw new Error(`String bei Position ${cursor} erwartet.`);
    cursor += 1;
    let escaped = false;
    while (cursor < source.length) {
      const character = source[cursor]!;
      cursor += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        return JSON.parse(source.slice(start, cursor)) as string;
      }
    }
    throw new Error("Nicht abgeschlossener JSON-String.");
  };
  const parseValue = (): void => {
    skipWhitespace();
    const character = source[cursor];
    if (character === "{") {
      cursor += 1;
      skipWhitespace();
      const keys = new Set<string>();
      if (source[cursor] === "}") {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        const key = parseString();
        if (keys.has(key)) throw new Error(`Doppelter JSON-Schlüssel: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (source[cursor] !== ":") throw new Error(`Doppelpunkt bei Position ${cursor} erwartet.`);
        cursor += 1;
        parseValue();
        skipWhitespace();
        if (source[cursor] === "}") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") throw new Error(`Komma bei Position ${cursor} erwartet.`);
        cursor += 1;
        skipWhitespace();
      }
      throw new Error("Nicht abgeschlossenes JSON-Objekt.");
    }
    if (character === "[") {
      cursor += 1;
      skipWhitespace();
      if (source[cursor] === "]") {
        cursor += 1;
        return;
      }
      while (cursor < source.length) {
        parseValue();
        skipWhitespace();
        if (source[cursor] === "]") {
          cursor += 1;
          return;
        }
        if (source[cursor] !== ",") throw new Error(`Komma bei Position ${cursor} erwartet.`);
        cursor += 1;
      }
      throw new Error("Nicht abgeschlossenes JSON-Array.");
    }
    if (character === "\"") {
      parseString();
      return;
    }
    const start = cursor;
    while (cursor < source.length && !/[\s,\]}]/u.test(source[cursor]!)) cursor += 1;
    if (start === cursor) throw new Error(`JSON-Wert bei Position ${cursor} erwartet.`);
    JSON.parse(source.slice(start, cursor));
  };
  parseValue();
  skipWhitespace();
  if (cursor !== source.length) throw new Error(`Unerwartete Daten bei Position ${cursor}.`);
  return JSON.parse(source) as unknown;
}

function blankStageResult(
  status: "failed" | "not-available",
  reason: string,
  manifest: PhonemeVisemeEvaluatorManifest | null,
  manifestSha256: string | null,
  blockerCode: Exclude<PhonemeVisemeBlockerCode, "none">,
): PhonemeVisemeResult {
  return {
    ...unavailablePhonemeVisemeResult(reason, blockerCode),
    status,
    manifestReleaseId: manifest?.releaseId ?? null,
    manifestSha256,
    preprocessingVersion: manifest?.preprocessing.version ?? null,
    visemeMapVersion: manifest?.visemeMap.version ?? null,
    gateVersion: manifest?.productGo.status === "release-candidate"
      && "calibration" in manifest
      && manifest.calibration
      ? manifest.calibration.gateVersion
      : null,
    productGo: {
      status: "blocked",
      reason,
    },
  };
}

class SandboxUnavailableError extends Error {}

const MAX_RUNTIME_TREE_ENTRIES = 200_000;

function requireRootOwnedPath(path: string, directory: boolean): void {
  const details = lstatSync(path);
  if (details.uid !== 0 || (details.mode & 0o022) !== 0) {
    throw new SandboxUnavailableError(
      `Evaluator-Python-Laufzeit ist nicht administrativ versiegelt: ${path}`,
    );
  }
  if (directory) {
    if (!details.isDirectory() || (details.mode & 0o005) !== 0o005) {
      throw new SandboxUnavailableError(
        `Evaluator-Python-Verzeichnis ist für DynamicUser nicht zugänglich: ${path}`,
      );
    }
  } else if (!details.isFile() || (details.mode & 0o005) !== 0o005) {
    throw new SandboxUnavailableError(
      `Evaluator-Python ist keine vertrauenswürdige ausführbare Datei: ${path}`,
    );
  }
}

function requireRootOwnedPathChain(path: string): void {
  const segments = resolve(path).split("/").filter(Boolean);
  let current = "/";
  requireRootOwnedPath(current, true);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const final = index === segments.length - 1;
    const details = lstatSync(current);
    if (details.isSymbolicLink()) {
      if (details.uid !== 0) {
        throw new SandboxUnavailableError(
          `Evaluator-Python-Symlink ist nicht administrativ kontrolliert: ${current}`,
        );
      }
      const target = realpathSync(current);
      if (target !== current) requireRootOwnedPathChain(target);
      continue;
    }
    requireRootOwnedPath(current, !final || details.isDirectory());
  }
}

function requireAdminSealedRuntimeTree(root: string): PinnedPathRevision {
  requireRootOwnedPath(root, true);
  const stack = [root];
  let visited = 0;
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_RUNTIME_TREE_ENTRIES) {
        throw new SandboxUnavailableError(
          `Evaluator-Python-Laufzeit überschreitet ${MAX_RUNTIME_TREE_ENTRIES} prüfbare Einträge.`,
        );
      }
      const path = join(directory, entry.name);
      const details = lstatSync(path);
      if (details.isSymbolicLink()) {
        if (details.uid !== 0) {
          throw new SandboxUnavailableError(
            `Evaluator-Python-Laufzeit enthält einen nicht administrativ kontrollierten Symlink: ${path}`,
          );
        }
        const target = realpathSync(path);
        if (!(target === root || target.startsWith(`${root}/`))) {
          requireRootOwnedPathChain(target);
        }
      } else if (details.uid !== 0 || (details.mode & 0o022) !== 0) {
        throw new SandboxUnavailableError(
          `Evaluator-Python-Laufzeit enthält eine nicht administrativ versiegelte Komponente: ${path}`,
        );
      } else if (details.isDirectory()) {
        if ((details.mode & 0o005) !== 0o005) {
          throw new SandboxUnavailableError(
            `Evaluator-Python-Verzeichnis ist für DynamicUser nicht zugänglich: ${path}`,
          );
        }
        stack.push(path);
      } else if (details.isFile()) {
        if ((details.mode & 0o004) === 0) {
          throw new SandboxUnavailableError(
            `Evaluator-Python-Datei ist für DynamicUser nicht lesbar: ${path}`,
          );
        }
      } else {
        throw new SandboxUnavailableError(
          `Evaluator-Python-Laufzeit enthält einen unzulässigen Dateityp: ${path}`,
        );
      }
    }
  }
  return capturePinnedPathRevision(root, "directory");
}

function resolveTrustedPythonRuntime(python: string): {
  pythonExecutable: string;
  pythonRuntimeRoot: string;
  runtimeRevision: PinnedPathRevision;
} {
  if (!isAbsolute(python)) {
    throw new SandboxUnavailableError(
      "Evaluator-Python muss als absoluter administrativ kontrollierter Pfad konfiguriert sein.",
    );
  }
  const pythonExecutable = resolve(python);
  const candidateRoot = dirname(dirname(pythonExecutable));
  if (!existsSync(join(candidateRoot, "pyvenv.cfg"))) {
    throw new SandboxUnavailableError(
      "Evaluator-Python muss aus einer dedizierten administrativ versiegelten virtuellen Umgebung stammen.",
    );
  }
  const pythonRuntimeRoot = realpathSync(candidateRoot);
  const runtimeRevision = requireAdminSealedRuntimeTree(pythonRuntimeRoot);
  const executableTarget = realpathSync(pythonExecutable);
  if (!(executableTarget === pythonRuntimeRoot || executableTarget.startsWith(`${pythonRuntimeRoot}/`))) {
    requireRootOwnedPathChain(executableTarget);
  }
  return { pythonExecutable, pythonRuntimeRoot, runtimeRevision };
}

export function verifyPhonemeVisemeExecutionRuntime(
  execution: PhonemeVisemeExecution,
): void {
  const trusted = resolveTrustedPythonRuntime(execution.pythonExecutable);
  if (trusted.pythonRuntimeRoot !== execution.pythonRuntimeRoot) {
    throw new SandboxUnavailableError(
      "Evaluator-Python-Laufzeit stimmt nicht mit der freigegebenen Umgebung überein.",
    );
  }
  const declared = execution.boundPathRevisions.find(
    (revision) => revision.path === execution.pythonRuntimeRoot && revision.kind === "directory",
  );
  if (!declared
    || declared.device !== trusted.runtimeRevision.device
    || declared.inode !== trusted.runtimeRevision.inode
    || declared.size !== trusted.runtimeRevision.size
    || declared.modifiedAtNs !== trusted.runtimeRevision.modifiedAtNs
    || declared.changedAtNs !== trusted.runtimeRevision.changedAtNs) {
    throw new SandboxUnavailableError(
      "Evaluator-Python-Laufzeitrevision stimmt nicht mit der administrativ versiegelten Umgebung überein.",
    );
  }
}

const SANDBOX_PROBE_CODE = [
  "import json, os, socket, sys",
  "runner, denied_path, gpu_path, host_net, host_uid, host_groups, mfa_path, bound_json, sockets_json = sys.argv[1:]",
  "bound_paths = json.loads(bound_json)",
  "runtime_sockets = json.loads(sockets_json)",
  "bound_inputs_readable = True",
  "for path in bound_paths:",
  "    try:",
  "        with open(path, 'rb') as handle:",
  "            handle.read(1)",
  "    except OSError:",
  "        bound_inputs_readable = False",
  "mfa_executable = os.access(mfa_path, os.X_OK)",
  "assert not os.path.exists(denied_path)",
  "assert not gpu_path or not os.path.exists(gpu_path)",
  "network_blocked = False",
  "try:",
  "    socket.socket(socket.AF_INET, socket.SOCK_STREAM)",
  "except OSError:",
  "    network_blocked = True",
  "runtime_socket_blocked = []",
  "for path in runtime_sockets:",
  "    candidate = None",
  "    try:",
  "        candidate = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
  "        candidate.settimeout(0.5)",
  "        candidate.connect(path)",
  "    except OSError:",
  "        runtime_socket_blocked.append(True)",
  "    else:",
  "        runtime_socket_blocked.append(False)",
  "    finally:",
  "        if candidate is not None:",
  "            candidate.close()",
  "groups = os.getgroups()",
  "host_group_set = {int(value) for value in host_groups.split(',') if value}",
  "identity_isolated = os.getuid() != int(host_uid) and set(groups).isdisjoint(host_group_set) and set(groups) <= {os.getgid()}",
  "net_namespace = os.readlink('/proc/self/ns/net')",
  "print(json.dumps({'networkBlocked': network_blocked, 'runtimeSocketsBlocked': all(runtime_socket_blocked), 'identityIsolated': identity_isolated, 'boundInputsReadable': bound_inputs_readable, 'mfaExecutable': mfa_executable, 'netNamespace': net_namespace, 'hostNetNamespace': host_net}))",
].join("\n");

function verifySystemSandbox(
  runnerPath: string,
  readOnlyPaths: string[],
  boundPathRevisions: PinnedPathRevision[],
  alignmentExecutablePath: string,
): void {
  for (const path of ["/usr/bin/sudo", "/usr/bin/systemd-run", "/usr/bin/systemctl"]) {
    const details = lstatSync(path);
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o111) === 0) {
      throw new SandboxUnavailableError(`Sandbox-Werkzeug ist nicht vertrauenswürdig verfügbar: ${path}`);
    }
  }
  const hostNetNamespace = readlinkSync("/proc/self/ns/net");
  const deniedPath = join(appRoot, "package.json");
  let gpuPath = "";
  try {
    if (lstatSync("/dev/nvidia0").isCharacterDevice()) gpuPath = "/dev/nvidia0";
  } catch {
    // A host without NVIDIA device nodes still exercises the remaining sandbox gates.
  }
  const unit = `ltx-pv-probe-${randomUUID()}`;
  const runtimeDirectory = evaluatorRuntimeDirectory(unit);
  const pinned = openPinnedPaths(boundPathRevisions);
  let probe: SpawnSyncReturns<string>;
  try {
    probe = spawnSync("/usr/bin/sudo", [
      "-n",
      "/usr/bin/systemd-run",
      "--system",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--service-type=exec",
      `--unit=${unit}`,
      `--working-directory=${runtimeDirectory}`,
      ...evaluatorSandboxProperties(unit),
      ...boundPathRevisions.map((revision) => pinned.bindReadOnlyProperty(revision.path)),
      "--property=MemoryMax=128M",
      "--property=TasksMax=8",
      "--property=LimitNOFILE=32",
      "--property=LimitFSIZE=1M",
      "--property=RuntimeMaxSec=10s",
      "--property=TimeoutStopSec=2s",
      "--property=KillMode=control-group",
      "/usr/bin/env",
      "-i",
      "PATH=/usr/bin:/bin",
      "LANG=C.UTF-8",
      "/usr/bin/python3",
      "-c",
      SANDBOX_PROBE_CODE,
      runnerPath,
      deniedPath,
      gpuPath,
      hostNetNamespace,
      String(process.getuid?.() ?? 0),
      (process.getgroups?.() ?? []).join(","),
      alignmentExecutablePath,
      JSON.stringify(readOnlyPaths),
      JSON.stringify(protectedRuntimeSockets),
    ], {
      shell: false,
      timeout: 15_000,
      encoding: "utf8",
      maxBuffer: 16 * 1024,
      env: { PATH: "/usr/bin:/bin" },
    });
    pinned.verifyUnchanged();
  } finally {
    pinned.close();
  }
  if (probe.status !== 0 || probe.signal || probe.error) {
    const detail = probe.error?.message
      ?? (probe.stderr.trim().slice(-300) || `Code ${probe.status ?? "?"}`);
    throw new SandboxUnavailableError(
      `System-Sandbox-Probe fehlgeschlagen: ${detail}`,
    );
  }
  let result: unknown;
  try {
    result = JSON.parse(probe.stdout);
  } catch {
    throw new SandboxUnavailableError("System-Sandbox-Probe lieferte keine gültige Antwort.");
  }
  if (!result
    || typeof result !== "object"
    || !("networkBlocked" in result)
    || result.networkBlocked !== true
    || !("runtimeSocketsBlocked" in result)
    || result.runtimeSocketsBlocked !== true
    || !("identityIsolated" in result)
    || result.identityIsolated !== true
    || !("boundInputsReadable" in result)
    || result.boundInputsReadable !== true
    || !("mfaExecutable" in result)
    || result.mfaExecutable !== true
    || !("netNamespace" in result)
    || result.netNamespace === hostNetNamespace) {
    throw new SandboxUnavailableError(
      "System-Sandbox-Probe konnte Identitäts-, Socket- und Netzwerkisolation nicht beweisen.",
    );
  }
}

type MeasurementManifest = Extract<
  PhonemeVisemeEvaluatorManifest,
  {
    schemaVersion:
      | "ltx-studio-phoneme-viseme-manifest.v2"
      | "ltx-studio-phoneme-viseme-manifest.v3";
  }
>;
type MeasurementArtifact = Extract<
  MeasurementManifest,
  { schemaVersion: "ltx-studio-phoneme-viseme-manifest.v2" }
>["components"]["mfaExecutable"];

function measurementManifestState(
  manifest: MeasurementManifest,
  configuredPath: string,
  manifestSha256: string,
  trustPins: PhonemeVisemeTrustPins,
  configuredPython: string,
  configuredRunner: string,
): PhonemeVisemeEvaluatorState {
  let manifestPath: string;
  let root: string;
  const componentEntries = Object.entries(manifest.components)
    .filter((entry) => entry[1] !== null) as Array<[string, MeasurementArtifact]>;
  const legalById = new Map(manifest.legalEvidence.map((entry) => [entry.evidenceId, entry]));
  const commercialScope =
    manifest.legalApproval.scope === "commercial-biometric-measurement-only";
  const allLegalScopesReviewed = manifest.legalEvidence.every(
    (entry) => entry.biometricProcessingReviewed
      && (!commercialScope || entry.commercialUseReviewed),
  );
  if (!allLegalScopesReviewed) {
    const reason = commercialScope
      ? "Evaluator-Lizenzbelege enthalten keine vollständige kommerzielle und biometrische Freigabe."
      : "Evaluator-Lizenzbelege enthalten keine vollständige Betreiberfreigabe für lokale biometrische Messung.";
    return {
      fingerprint: `manifest-v2-legal-hold:${manifestSha256}`,
      result: blankStageResult("not-available", reason, manifest, manifestSha256, "legal-hold"),
      execution: null,
    };
  }
  const approvalEvidence = legalById.get(manifest.legalApproval.evidenceId);
  if (!approvalEvidence || approvalEvidence.sha256 !== trustPins.legalApprovalSha256) {
    const reason = "Evaluator-Legal-Approval stimmt nicht mit dem administratorseitig gepinnten Freigabehash überein.";
    return {
      fingerprint: `manifest-v2-legal-approval-mismatch:${manifestSha256}`,
      result: blankStageResult("not-available", reason, manifest, manifestSha256, "legal-hold"),
      execution: null,
    };
  }
  try {
    manifestPath = realpathSync(resolve(configuredPath));
    root = realpathSync(dirname(manifestPath));
    requireSealedDynamicUserFile(manifestPath, "Evaluator-Manifest");
    const readOnlyPaths = new Set<string>([manifestPath]);
    const boundPathRevisions = new Map<string, PinnedPathRevision>();
    const manifestRevision = hashRegularFile(manifestPath, MAX_MANIFEST_BYTES);
    if (manifestRevision.sha256 !== manifestSha256) {
      throw new Error("Evaluator-Manifest änderte sich nach der Vertrauensprüfung.");
    }
    boundPathRevisions.set(manifestPath, manifestRevision.binding);
    for (const evidence of manifest.legalEvidence) {
      const path = resolveArtifactPath(root, evidence.path);
      requireSealedDynamicUserFile(path, `Lizenzbeleg ${evidence.evidenceId}`);
      const verified = hashRegularFile(path, MAX_LEGAL_EVIDENCE_BYTES);
      if (verified.sha256 !== evidence.sha256) {
        throw new Error(`Lizenzbeleg-Hash stimmt nicht: ${evidence.evidenceId}`);
      }
      readOnlyPaths.add(path);
      boundPathRevisions.set(path, verified.binding);
    }
    for (const [key, component] of componentEntries) {
      const path = resolveArtifactPath(root, component.path);
      requireSealedDynamicUserFile(
        path,
        `Evaluator-Komponente ${key}`,
        key === "mfaExecutable" || key === "espeakExecutable",
      );
      const verified = hashRegularFile(path, component.sizeBytes);
      if (verified.size !== component.sizeBytes) {
        throw new Error(`Komponentengröße stimmt nicht: ${key}`);
      }
      if (verified.sha256 !== component.sha256) {
        throw new Error(`Komponenten-Hash stimmt nicht: ${key}`);
      }
      readOnlyPaths.add(path);
      boundPathRevisions.set(path, verified.binding);
      for (const evidenceId of component.licenseEvidenceIds) {
        if (!legalById.has(evidenceId)) throw new Error(`Lizenzbeleg fehlt: ${evidenceId}`);
      }
    }
    const mappingPath = resolveArtifactPath(root, manifest.visemeMap.path);
    const mappingRaw = readRegularFile(mappingPath, MAX_MANIFEST_BYTES);
    if (sha256(mappingRaw) !== manifest.visemeMap.sha256) {
      throw new Error("Visem-Mapping-Hash stimmt nicht.");
    }
    visemeMappingSchema.parse(parseStrictJson(mappingRaw));
    if (!isAbsolute(configuredRunner)) {
      throw new Error("Phonem-/Visem-Runner muss als absoluter administrativ kontrollierter Pfad konfiguriert sein.");
    }
    const runnerPath = resolve(configuredRunner);
    requireRootOwnedPath(runnerPath, false);
    const runner = hashRegularFile(runnerPath, 2 * 1024 * 1024);
    if (runner.sha256 !== trustPins.runnerSha256) {
      throw new Error("Appseitiger Phonem-/Visem-Runner stimmt nicht mit dem Administrator-Pin überein.");
    }
    readOnlyPaths.add(runnerPath);
    boundPathRevisions.set(runnerPath, runner.binding);
    const trustedRuntime = resolveTrustedPythonRuntime(configuredPython);
    const allBoundRevisions = [
      ...boundPathRevisions.values(),
      trustedRuntime.runtimeRevision,
    ].sort((left, right) => left.path.localeCompare(right.path));
    const alignmentExecutable = manifest.schemaVersion === "ltx-studio-phoneme-viseme-manifest.v2"
      ? resolveArtifactPath(root, manifest.components.mfaExecutable.path)
      : resolveArtifactPath(root, manifest.components.espeakExecutable.path);
    verifySystemSandbox(
      runnerPath,
      [...readOnlyPaths].sort(),
      allBoundRevisions,
      alignmentExecutable,
    );
    const pathFor = (path: string) => resolveArtifactPath(root, path);
    const reason = "Die automatische Laut-/Lippenprüfung ist aktiv.";
    const bindingFingerprint = sha256(Buffer.from(JSON.stringify(allBoundRevisions)));
    const commonExecution = {
      method: manifest.method,
      sandbox: "systemd-system-sandbox.v1" as const,
      artifactRoot: root,
      readOnlyPaths: [...readOnlyPaths].sort(),
      manifestPath,
      manifestSha256,
      legalApprovalSha256: trustPins.legalApprovalSha256,
      runnerPath,
      runnerSha256: runner.sha256,
      pythonExecutable: trustedRuntime.pythonExecutable,
      pythonRuntimeRoot: trustedRuntime.pythonRuntimeRoot,
      boundPathRevisions: allBoundRevisions,
      faceLandmarkerPath: pathFor(manifest.components.faceLandmarker.path),
      visemeMappingPath: pathFor(manifest.components.visemeMapping.path),
      runtime: manifest.runtime,
    };
    const execution: PhonemeVisemeExecution =
      manifest.schemaVersion === "ltx-studio-phoneme-viseme-manifest.v2"
        ? {
            ...commonExecution,
            mfaExecutablePath: pathFor(manifest.components.mfaExecutable.path),
            acousticModelPath: pathFor(manifest.components.acousticModel.path),
            dictionaryPath: pathFor(manifest.components.dictionary.path),
            g2pModelPath: manifest.components.g2pModel
              ? pathFor(manifest.components.g2pModel.path)
              : null,
            phonemeModelWeightsPath: null,
            phonemeModelConfigPath: null,
            phonemeVocabularyPath: null,
            espeakExecutablePath: null,
          }
        : {
            ...commonExecution,
            mfaExecutablePath: null,
            acousticModelPath: null,
            dictionaryPath: null,
            g2pModelPath: null,
            phonemeModelWeightsPath: pathFor(manifest.components.phonemeModelWeights.path),
            phonemeModelConfigPath: pathFor(manifest.components.phonemeModelConfig.path),
            phonemeVocabularyPath: pathFor(manifest.components.phonemeVocabulary.path),
            espeakExecutablePath: pathFor(manifest.components.espeakExecutable.path),
          };
    return {
      fingerprint: `manifest-${manifest.schemaVersion.endsWith(".v3") ? "v3" : "v2"}-measurement-ready:${manifestSha256}:${runner.sha256}:${bindingFingerprint}`,
      result: blankStageResult("not-available", reason, manifest, manifestSha256, "product-go-pending"),
      execution,
    };
  } catch (error) {
    const reason = `Evaluator-Artefaktprüfung fehlgeschlagen: ${
      error instanceof Error ? error.message : String(error)
    }`;
    const sandboxUnavailable = error instanceof SandboxUnavailableError;
    return {
      fingerprint: `manifest-v2-artifact-invalid:${manifestSha256}:${sha256(Buffer.from(reason))}`,
      result: blankStageResult(
        sandboxUnavailable ? "not-available" : "failed",
        reason,
        manifest,
        manifestSha256,
        sandboxUnavailable ? "runner-unavailable" : "artifact-invalid",
      ),
      execution: null,
    };
  }
}

export function resolvePhonemeVisemeEvaluatorState(
  configuredPath = process.env.LTX_STUDIO_PHONEME_VISEME_MANIFEST?.trim() ?? "",
  trustPins: PhonemeVisemeTrustPins = {
    manifestSha256: process.env.LTX_STUDIO_PHONEME_VISEME_MANIFEST_SHA256?.trim() ?? "",
    legalApprovalSha256: process.env.LTX_STUDIO_PHONEME_VISEME_LEGAL_APPROVAL_SHA256?.trim() ?? "",
    runnerSha256: process.env.LTX_STUDIO_PHONEME_VISEME_RUNNER_SHA256?.trim() ?? "",
  },
  configuredPython = defaultPhonemeVisemePythonExecutable,
  configuredRunner = process.env.LTX_STUDIO_PHONEME_VISEME_RUNNER?.trim() ?? "",
): PhonemeVisemeEvaluatorState {
  if (!configuredPath) {
    const result = unavailablePhonemeVisemeResult();
    return { fingerprint: "manifest-missing.v1", result };
  }
  let raw: Buffer;
  try {
    raw = readRegularFile(resolve(configuredPath), MAX_MANIFEST_BYTES);
  } catch (error) {
    const reason = `Evaluator-Manifest nicht lesbar: ${error instanceof Error ? error.message : String(error)}`;
    return {
      fingerprint: `manifest-unreadable:${createHash("sha256").update(reason).digest("hex")}`,
      result: blankStageResult("failed", reason, null, null, "manifest-invalid"),
    };
  }
  const manifestSha256 = sha256(raw);
  let body: unknown;
  try {
    body = parseStrictJson(raw);
  } catch (error) {
    const reason = `Evaluator-Manifest enthält ungültiges JSON: ${error instanceof Error ? error.message : String(error)}`;
    return {
      fingerprint: `manifest-invalid-json:${manifestSha256}`,
      result: blankStageResult("failed", reason, null, manifestSha256, "manifest-invalid"),
    };
  }
  const parsed = phonemeVisemeEvaluatorManifestSchema.safeParse(body);
  if (!parsed.success) {
    const reason = `Evaluator-Manifest ungültig: ${parsed.error.issues[0]?.message ?? "Schemafehler"}`;
    return {
      fingerprint: `manifest-invalid:${manifestSha256}`,
      result: blankStageResult("failed", reason, null, manifestSha256, "manifest-invalid"),
    };
  }
  const manifest = parsed.data;
  if (manifest.schemaVersion === "ltx-studio-phoneme-viseme-manifest.v2"
    || manifest.schemaVersion === "ltx-studio-phoneme-viseme-manifest.v3") {
    if (!sha256Pattern.test(trustPins.manifestSha256)
      || !sha256Pattern.test(trustPins.legalApprovalSha256)
      || !sha256Pattern.test(trustPins.runnerSha256)
      || trustPins.manifestSha256 !== manifestSha256) {
      const reason = "Measurement-Manifest, Legal Approval oder Runner ist nicht administratorseitig per SHA-256 gepinnt.";
      return {
        fingerprint: `manifest-v2-trust-pin-missing:${manifestSha256}`,
        result: blankStageResult("not-available", reason, manifest, manifestSha256, "legal-hold"),
        execution: null,
      };
    }
    return measurementManifestState(
      manifest,
      configuredPath,
      manifestSha256,
      trustPins,
      configuredPython,
      configuredRunner,
    );
  }
  if (manifest.productGo.status === "blocked") {
    const reason = `Phonem-/Visem-Evaluator im Legal Hold: ${manifest.productGo.reason}`;
    return {
      fingerprint: `manifest-blocked:${manifestSha256}`,
      result: blankStageResult("not-available", reason, manifest, manifestSha256, "legal-hold"),
    };
  }
  if (!manifest.artifacts || !manifest.calibration || !manifest.legal) {
    const reason = "Evaluator-Release-Kandidat enthält keine vollständigen Kandidatenartefakte.";
    return {
      fingerprint: `manifest-candidate-incomplete:${manifestSha256}`,
      result: blankStageResult("failed", reason, manifest, manifestSha256, "manifest-invalid"),
    };
  }
  const reason = "Release-Kandidat erkannt; Product-GO-Prüfung und CPU-Inferenzrunner sind in diesem Build noch nicht aktiviert.";
  return {
    fingerprint: `manifest-runner-unavailable:${manifestSha256}`,
    result: blankStageResult("not-available", reason, manifest, manifestSha256, "runner-unavailable"),
  };
}
