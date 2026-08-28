import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256,
  T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256,
  T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
  T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256,
  T2A_GERMAN_G2P_DATA_ROOT,
  T2A_GERMAN_G2P_ESPEAK_PATH,
  T2A_GERMAN_G2P_RUNNER_SHA256,
  T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
  T2A_GERMAN_G2P_VOCAB_PATH,
  buildT2aGermanG2pRequest,
  captureT2aGermanG2pDataManifest,
  captureT2aGermanG2pRuntimeManifest,
  parseT2aGermanG2pExecution,
  t2aGermanG2pDataManifestSha256,
  t2aGermanG2pRuntimeManifestSha256,
  t2aGermanG2pResultCanonicalJson,
  type T2aGermanG2pDataManifest,
  type T2aGermanG2pRequest,
  type T2aGermanG2pRuntimeManifest,
} from "../shared/t2aGermanG2p.js";
import {
  T2A_IPA_ADJUDICATION_POLICY_SHA256,
  adjudicateT2aIpa,
  buildT2aIpaAdjudicatorRequest,
  buildT2aReferenceIpaDocument,
} from "../shared/t2aIpaAdjudication.js";
import {
  T2A_FFMPEG_SHA256,
  T2A_WHISPER_SMALL_SHA256,
  deriveT2aPhonemeVerification,
  deriveT2aIa2vEligibility,
  t2aAudioQualitySchema,
  type T2aAudioClaimScope,
  type T2aAudioQuality,
} from "../shared/t2aAudioQuality.js";
import {
  analysisPythonExecutable,
  appRoot,
  dataRoot,
  hostTcbExecutables,
  sealedRelease,
  t2aDevelopmentMeasurementEnabled,
  whisperModelPath,
} from "./config.js";
import {
  capturePinnedPathRevision,
  openPinnedPaths,
  type PinnedPathRevision,
} from "./evaluatorBindings.js";
import {
  evaluatorRuntimeDirectory,
  evaluatorSandboxExecutableProperties,
  evaluatorSandboxInaccessibleProperties,
  evaluatorSandboxNoExecHostProperties,
  evaluatorSandboxProperties,
} from "./evaluatorSandbox.js";
import {
  releaseIdentity,
  revalidateSealedRuntimeTrustIdentity,
  type ReleaseIdentity,
} from "./releaseIdentity.js";
import {
  T2A_GERMAN_G2P_REQUEST_BASENAME,
  T2A_IPA_ADJUDICATOR_REQUEST_BASENAME,
  T2A_IPA_ADJUDICATION_RESULT_BASENAME,
  materializeT2aIpaAdjudicationResult,
  materializeT2aPrivatePhaseRequest,
  parseT2aIpaAdjudicationExecution,
  type ParsedT2aIpaAdjudicationExecution,
} from "./t2aIpaAdjudicationPhase.js";
import {
  materializeIndependentIpaPhaseObservation,
  parseIndependentIpaPhaseExecution,
  type ParsedIndependentIpaPhaseExecution,
} from "./t2aIndependentIpaPhase.js";

const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_WORKER_BYTES = 2 * 1024 * 1024;
const MAX_DIALOGUE_EVALUATOR_BYTES = 2 * 1024 * 1024;
const MAX_FFMPEG_BYTES = 64 * 1024 * 1024;
const MAX_WHISPER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 16 * 1024;
const MAX_G2P_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_ADJUDICATOR_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 420_000;
const INDEPENDENT_IPA_TIMEOUT_MS = 180_000;
const GERMAN_G2P_TIMEOUT_MS = 30_000;
const IPA_ADJUDICATOR_TIMEOUT_MS = 15_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_TIMEOUT_MS = 30 * 60 * 1_000;
const MAX_TERMINATION_GRACE_MS = 30_000;
const PREFLIGHT_TIMEOUT_MS = 15_000;
const SYSTEMD_CONTROL_TIMEOUT_MS = 2_000;
const SYSTEMD_STOP_DEADLINE_MS = 15_000;

// These are server-owned trust pins, not command arguments. Update them only
// together with a reviewed evaluator release and its tests.
export const T2A_AUDIO_WORKER_SHA256 = "80aff75d77d4597c92c3e9988b6573212607e17d5df95c4845585f510a025bb3";
export const T2A_DIALOGUE_EVALUATOR_SHA256 = "6ffcbdbb472305f8834d07675b77fe7c461fb960fd5b5a30f4ad6954b33712af";
export const T2A_AUDIO_QUALITY_SCHEMA_SHA256 = "7c7f07dd3b6da59d48b0271f5933606205dbf08d6a3fbe8b102cefc3def9ba1a";
export const T2A_AUDIO_BASE_CONTRACTS_SHA256 = "720dc089bdeaebbbe0e76831a88931bd7459c1ba6b7305174e2c0c6a6c2fc79b";
export const T2A_AUDIO_EVALUATOR_REVISION = "ltx-studio-t2a-audio-evaluator.v4";
export const T2A_INDEPENDENT_IPA_AUTHORITY_REVISION =
  "ltx-studio-independent-ipa-authority.v1" as const;
export const T2A_INDEPENDENT_IPA_RUNNER_SHA256 =
  "c18bc8353ba812a7edec034e571ab6622ebb6bfc32c18e866e6eae2b727d391c";
export const T2A_INDEPENDENT_IPA_MODEL_MANIFEST_SHA256 =
  "c401b4ecc2fe774a90e5c2acd6cfcb0bde5465e6c4672f2e5ef2574b47c264a0";
export const T2A_INDEPENDENT_IPA_MODEL_WEIGHT_SHA256 =
  "cd23ca5a57a252ee44abfea3b06d28020285015b83b8bb0e59293193ef8c2bd4";
export const T2A_INDEPENDENT_IPA_MODEL_DIRECTORY =
  "/var/lib/ltx-studio/models/facebook--wav2vec2-xlsr-53-espeak-cv-ft/2c733782da5604684829819a5eb744c193fe9398" as const;
const T2A_INDEPENDENT_IPA_MODEL_FILES = [
  "config.json",
  "conversion-manifest.v1.json",
  "model.safetensors",
  "preprocessor_config.json",
  "special_tokens_map.json",
  "tokenizer_config.json",
  "vocab.json",
] as const;
export const T2A_PRONUNCIATION_AUTHORITY_REVISION =
  "ltx-studio-t2a-pronunciation-authority.v1" as const;
export const T2A_IPA_ADJUDICATOR_RUNNER_SHA256 =
  "5e27fd4a86fd04c580fd756ad8be6daeab59b51c1fe8446d2cb82b514989ca53" as const;
export const T2A_GERMAN_G2P_CONTRACT_SHA256 =
  "e217dacb9b622804b9ad59988043b61ddadddd03a6a43ef2996066800c152212" as const;
export const T2A_IPA_ADJUDICATION_CONTRACT_SHA256 =
  "ed3e5a670b5a6c8fa89a38a3a97162bde5cefaf89a73c3b59bd475347c59edaa" as const;
const T2A_INDEPENDENT_IPA_AUXILIARY_SHA256 = {
  "config.json": "4609fb49b7e1d28aecb2840da1926c40bd915bc6f1120a940afacf7159bbfb13",
  "preprocessor_config.json": "a2254a5b58f72cd4de3632f8eee64f3f098b7c1402128d2f419e7d00ae13e335",
  "special_tokens_map.json": "bb7068de1150661a10b55f9e4b12a0e77af8bf91f5e45e1b58afaf1d0e17f675",
  "tokenizer_config.json": "d663833dacef7d29f563e23029d448fe41415dbe5e8e6d5a98b598a5258c18d8",
  "vocab.json": "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0",
} as const;
export const T2A_SANDBOX_UNSET_ENVIRONMENT = [
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_DEBUG",
  "LD_DEBUG_OUTPUT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "PYTHONBREAKPOINT",
  "PYTHONHOME",
  "PYTHONINSPECT",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "VIRTUAL_ENV",
] as const;
export const T2A_AUDIO_SANDBOX_NAMESPACE = createHash("sha256")
  .update(`ltx-studio-t2a-audio\0${resolve(dataRoot)}`, "utf8")
  .digest("hex")
  .slice(0, 16);
export const T2A_AUDIO_SANDBOX_UNIT_PREFIX = `ltx-t2a-${T2A_AUDIO_SANDBOX_NAMESPACE}`;
const DEVELOPMENT_SESSION_NONCE = randomBytes(32).toString("hex");
const PRIVATE_TRANSCRIPT_LOADER = [
  "import hashlib,json,runpy,sys",
  "p,s,e,w=sys.argv[1:5]",
  `b=open(p,'rb').read(${MAX_TRANSCRIPT_BYTES + 1})`,
  `assert 0<len(b)<=${MAX_TRANSCRIPT_BYTES} and hashlib.sha256(b).hexdigest()==s`,
  "v=json.loads(b.decode('utf-8'))",
  "assert isinstance(v,dict) and set(v)=={'schemaVersion','text'} and v['schemaVersion']=='ltx-studio-private-transcript.v1' and isinstance(v['text'],str)",
  "t=v['text']",
  "assert hashlib.sha256(t.encode('utf-8')).hexdigest()==e",
  "sys.argv=[w,*sys.argv[5:],'--transcript',t]",
  "runpy.run_path(w,run_name='__main__')",
].join(";");
const PRIVATE_FFMPEG_PREFLIGHT = [
  "import subprocess,sys,torch,whisper",
  "torch.set_num_threads(1)",
  "assert torch.backends.cpu.get_cpu_capability()",
  "assert float(torch.ones(1,dtype=torch.float32).item())==1.0",
  "p=subprocess.run([sys.argv[1],'-nostdin','-hide_banner','-version'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,timeout=5,check=False)",
  "assert p.returncode==0 and p.stdout.startswith('ffmpeg version ')",
  "print(p.stdout.splitlines()[0])",
].join(";");
const PRIVATE_REQUEST_LOADER = [
  "import hashlib,io,runpy,sys",
  "p,s,m,w=sys.argv[1:5]",
  "b=open(p,'rb').read(int(m)+1)",
  "assert 0<len(b)<=int(m) and hashlib.sha256(b).hexdigest()==s",
  "sys.stdin=io.TextIOWrapper(io.BytesIO(b),encoding='utf-8',errors='strict')",
  "sys.argv=[w,*sys.argv[5:]]",
  "runpy.run_path(w,run_name='__main__')",
].join(";");

export type T2aAudioEvaluatorPaths = {
  pythonExecutable: string;
  workerScript: string;
  dialogueEvaluatorScript: string;
  qualitySchemaModule: string;
  baseContractsModule: string;
  ffmpegExecutable: string;
  whisperModel: string;
  pythonBinary: string;
  runtimeRoot: string;
};

type T2aAudioEvaluatorAuthorityBase = {
  revision: typeof T2A_AUDIO_EVALUATOR_REVISION;
  fingerprint: string;
  paths: T2aAudioEvaluatorPaths;
  pinnedPaths: readonly PinnedPathRevision[];
  workerSha256: typeof T2A_AUDIO_WORKER_SHA256;
  dialogueEvaluatorSha256: typeof T2A_DIALOGUE_EVALUATOR_SHA256;
  ffmpegSha256: typeof T2A_FFMPEG_SHA256;
  whisperModelSha256: typeof T2A_WHISPER_SMALL_SHA256;
  pythonSha256: string;
  qualitySchemaSha256: typeof T2A_AUDIO_QUALITY_SCHEMA_SHA256;
  qualitySchemaModuleSha256: string;
  baseContractsSha256: typeof T2A_AUDIO_BASE_CONTRACTS_SHA256;
  baseContractsModuleSha256: string;
};

export type SealedT2aAudioEvaluatorAuthority = T2aAudioEvaluatorAuthorityBase & {
  claimScope: "sealed-release";
  releaseDigest: string;
  runtimeInstallSealSha256: string;
  runtimeTreeSha256: string;
  runtimePolicySha256: string;
  runtimeTrustSha256: string;
};

export type DevelopmentT2aAudioEvaluatorAuthority = T2aAudioEvaluatorAuthorityBase & {
  claimScope: "development";
};

export type T2aAudioEvaluatorAuthority =
  | SealedT2aAudioEvaluatorAuthority
  | DevelopmentT2aAudioEvaluatorAuthority;

export type T2aIndependentIpaAuthority = {
  revision: typeof T2A_INDEPENDENT_IPA_AUTHORITY_REVISION;
  fingerprint: string;
  runnerPath: string;
  modelDirectory: typeof T2A_INDEPENDENT_IPA_MODEL_DIRECTORY;
  modelManifestPath: string;
  modelWeightPath: string;
  pinnedPaths: readonly PinnedPathRevision[];
  runnerSha256: string;
  modelManifestSha256: string;
  modelWeightSha256: string;
};

export type T2aPronunciationAuthority = {
  revision: typeof T2A_PRONUNCIATION_AUTHORITY_REVISION;
  fingerprint: string;
  g2pFingerprint: string;
  adjudicatorFingerprint: string;
  g2pRunnerPath: string;
  adjudicatorRunnerPath: string;
  g2pContractModulePath: string;
  adjudicationContractModulePath: string;
  pinnedPaths: readonly PinnedPathRevision[];
  g2pRunnerSha256: typeof T2A_GERMAN_G2P_RUNNER_SHA256;
  adjudicatorRunnerSha256: typeof T2A_IPA_ADJUDICATOR_RUNNER_SHA256;
  g2pContractModuleSha256: string;
  adjudicationContractModuleSha256: string;
  dataManifest: T2aGermanG2pDataManifest;
  runtimeManifest: T2aGermanG2pRuntimeManifest;
};

export type T2aAudioEvaluatorBinding = Readonly<{
  evaluatorFingerprint: string;
  claimScope: T2aAudioClaimScope;
}>;

export type T2aAudioEvaluationTarget = {
  audioSnapshotPath: string;
  transcriptSnapshotPath: string;
  transcriptSnapshotSha256: string;
  audioSha256: string;
  dialogueSha256: string;
  peakCeilingDbfs: number;
};

export type T2aAudioEvaluatorOptions = {
  timeoutMs?: number;
  terminationGraceMs?: number;
  signal?: AbortSignal;
  spawnProcess?: typeof spawn;
  controlCommand?: typeof runControlCommand;
};

export class T2aAudioEvaluatorCancelledError extends Error {
  readonly code = "T2A_AUDIO_EVALUATOR_CANCELLED" as const;

  constructor() {
    super("T2A-Audioanalyse wurde nach bestaetigter Sandbox-Terminierung abgebrochen.");
    this.name = "T2aAudioEvaluatorCancelledError";
  }
}

export class T2aAudioEvaluatorTerminationError extends Error {
  readonly code = "T2A_AUDIO_EVALUATOR_TERMINATION_UNCONFIRMED" as const;

  constructor(message: string) {
    super(message);
    this.name = "T2aAudioEvaluatorTerminationError";
  }
}

function defaultEvaluatorPaths(claimScope: T2aAudioClaimScope): T2aAudioEvaluatorPaths {
  return {
    pythonExecutable: analysisPythonExecutable,
    workerScript: join(appRoot, "scripts", "analyze-t2a-audio.py"),
    dialogueEvaluatorScript: join(appRoot, "scripts", "dialogue_word_evaluator.py"),
    // Sealed releases contain emitted JavaScript only. The reviewed TypeScript
    // source digest remains an explicit contract pin below; the executed JS is
    // independently bound by this path and by the sealed release manifest.
    qualitySchemaModule: join(
      appRoot,
      "shared",
      claimScope === "sealed-release" ? "t2aAudioQuality.js" : "t2aAudioQuality.ts",
    ),
    baseContractsModule: join(
      appRoot,
      "shared",
      claimScope === "sealed-release"
        ? "t2aAudioBaseContracts.js"
        : "t2aAudioBaseContracts.ts",
    ),
    ffmpegExecutable: hostTcbExecutables.ffmpeg,
    whisperModel: whisperModelPath,
    pythonBinary: realpathSync(analysisPythonExecutable),
    runtimeRoot: dirname(dirname(analysisPythonExecutable)),
  };
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} ist keine gueltige SHA-256.`);
  }
}

function assertSealedIndependentIpaModelInstall(): void {
  const directory = lstatSync(T2A_INDEPENDENT_IPA_MODEL_DIRECTORY, { bigint: true });
  if (!directory.isDirectory()
    || directory.isSymbolicLink()
    || directory.uid !== 0n
    || directory.gid !== 0n
    || (directory.mode & 0o777n) !== 0o555n) {
    throw new Error(
      "Das unabhaengige IPA-Modell ist nicht als root:root/0555-Authority installiert.",
    );
  }
  const inventory = readdirSync(T2A_INDEPENDENT_IPA_MODEL_DIRECTORY).sort();
  if (JSON.stringify(inventory) !== JSON.stringify([...T2A_INDEPENDENT_IPA_MODEL_FILES])) {
    throw new Error("Das unabhaengige IPA-Modellinventar weicht von der Authority ab.");
  }
  for (const name of T2A_INDEPENDENT_IPA_MODEL_FILES) {
    const details = lstatSync(join(T2A_INDEPENDENT_IPA_MODEL_DIRECTORY, name), { bigint: true });
    if (!details.isFile()
      || details.isSymbolicLink()
      || details.nlink !== 1n
      || details.uid !== 0n
      || details.gid !== 0n
      || (details.mode & 0o777n) !== 0o444n) {
      throw new Error(`IPA-Modellartefakt ist nicht root:root/0444 versiegelt: ${name}.`);
    }
  }
}

export function resolveT2aIndependentIpaAuthority(
  ...unexpectedArguments: never[]
): T2aIndependentIpaAuthority {
  if (unexpectedArguments.length !== 0) {
    throw new Error("IPA-Evaluator-Authority akzeptiert keine aufrufergesteuerten Pfade.");
  }
  assertSha256(T2A_INDEPENDENT_IPA_RUNNER_SHA256, "IPA-Runner-Digest");
  assertSha256(T2A_INDEPENDENT_IPA_MODEL_MANIFEST_SHA256, "IPA-Modellmanifest-Digest");
  assertSha256(T2A_INDEPENDENT_IPA_MODEL_WEIGHT_SHA256, "IPA-Modellgewicht-Digest");
  assertSealedIndependentIpaModelInstall();

  const runnerPath = join(appRoot, "scripts", "independent_ipa_evaluator.py");
  const modelManifestPath = join(
    T2A_INDEPENDENT_IPA_MODEL_DIRECTORY,
    "conversion-manifest.v1.json",
  );
  const modelWeightPath = join(T2A_INDEPENDENT_IPA_MODEL_DIRECTORY, "model.safetensors");
  const pinnedPaths = [
    capturePinnedPathRevision(runnerPath, "file"),
    capturePinnedPathRevision(T2A_INDEPENDENT_IPA_MODEL_DIRECTORY, "directory"),
    ...T2A_INDEPENDENT_IPA_MODEL_FILES.map((name) => capturePinnedPathRevision(
      join(T2A_INDEPENDENT_IPA_MODEL_DIRECTORY, name),
      "file",
    )),
  ] as const;
  const pinned = openPinnedPaths([...pinnedPaths]);
  try {
    const runnerSha256 = pinned.sha256(runnerPath, MAX_WORKER_BYTES);
    const modelManifestSha256 = pinned.sha256(modelManifestPath, 256 * 1024);
    const modelWeightSha256 = pinned.sha256(modelWeightPath, 2 * 1024 * 1024 * 1024);
    if (runnerSha256 !== T2A_INDEPENDENT_IPA_RUNNER_SHA256
      || modelManifestSha256 !== T2A_INDEPENDENT_IPA_MODEL_MANIFEST_SHA256
      || modelWeightSha256 !== T2A_INDEPENDENT_IPA_MODEL_WEIGHT_SHA256) {
      throw new Error("IPA-Runner oder IPA-Modell stimmt nicht mit der Server-Authority ueberein.");
    }
    for (const [name, expectedSha256] of Object.entries(
      T2A_INDEPENDENT_IPA_AUXILIARY_SHA256,
    )) {
      if (pinned.sha256(join(T2A_INDEPENDENT_IPA_MODEL_DIRECTORY, name), 1024 * 1024)
        !== expectedSha256) {
        throw new Error(`IPA-Modellhilfsdatei stimmt nicht mit der Authority ueberein: ${name}.`);
      }
    }
    pinned.verifyUnchanged();
    assertSealedIndependentIpaModelInstall();
    const fingerprint = createHash("sha256").update(JSON.stringify({
      revision: T2A_INDEPENDENT_IPA_AUTHORITY_REVISION,
      runnerSha256,
      modelManifestSha256,
      modelWeightSha256,
      auxiliarySha256: T2A_INDEPENDENT_IPA_AUXILIARY_SHA256,
    })).digest("hex");
    return {
      revision: T2A_INDEPENDENT_IPA_AUTHORITY_REVISION,
      fingerprint,
      runnerPath,
      modelDirectory: T2A_INDEPENDENT_IPA_MODEL_DIRECTORY,
      modelManifestPath,
      modelWeightPath,
      pinnedPaths,
      runnerSha256,
      modelManifestSha256,
      modelWeightSha256,
    };
  } finally {
    pinned.close();
  }
}

function pronunciationContractModulePaths(claimScope: T2aAudioClaimScope): {
  g2p: string;
  adjudication: string;
} {
  const extension = claimScope === "sealed-release" ? "js" : "ts";
  return {
    g2p: join(appRoot, "shared", `t2aGermanG2p.${extension}`),
    adjudication: join(appRoot, "shared", `t2aIpaAdjudication.${extension}`),
  };
}

export function resolveT2aPronunciationAuthority(
  ...unexpectedArguments: never[]
): T2aPronunciationAuthority {
  if (unexpectedArguments.length !== 0) {
    throw new Error("T2A-Pronunciation-Authority akzeptiert keine aufrufergesteuerten Pfade.");
  }
  const claimScope: T2aAudioClaimScope = t2aDevelopmentMeasurementEnabled
    ? "development"
    : "sealed-release";
  const contracts = pronunciationContractModulePaths(claimScope);
  const g2pRunnerPath = join(appRoot, "scripts", "t2a_german_g2p.py");
  const adjudicatorRunnerPath = join(appRoot, "scripts", "t2a_ipa_adjudicator.py");
  const dataManifest = captureT2aGermanG2pDataManifest();
  const runtimeManifest = captureT2aGermanG2pRuntimeManifest(dataManifest);
  if (t2aGermanG2pDataManifestSha256(dataManifest)
      !== runtimeManifest.espeakDataManifestSha256
    || t2aGermanG2pRuntimeManifestSha256(runtimeManifest)
      !== T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256) {
    throw new Error("Installierte German-G2P-Runtime weicht von der Review-Authority ab.");
  }
  const pinnedPaths = [
    capturePinnedPathRevision(g2pRunnerPath, "file"),
    capturePinnedPathRevision(adjudicatorRunnerPath, "file"),
    capturePinnedPathRevision(contracts.g2p, "file"),
    capturePinnedPathRevision(contracts.adjudication, "file"),
    capturePinnedPathRevision(T2A_GERMAN_G2P_ESPEAK_PATH, "file"),
    capturePinnedPathRevision(T2A_GERMAN_G2P_DATA_ROOT, "directory"),
    capturePinnedPathRevision(T2A_GERMAN_G2P_VOCAB_PATH, "file"),
  ] as const;
  const pinned = openPinnedPaths([...pinnedPaths]);
  try {
    const g2pRunnerSha256 = pinned.sha256(g2pRunnerPath, MAX_WORKER_BYTES);
    const adjudicatorRunnerSha256 = pinned.sha256(adjudicatorRunnerPath, MAX_WORKER_BYTES);
    const g2pContractModuleSha256 = pinned.sha256(contracts.g2p, MAX_WORKER_BYTES);
    const adjudicationContractModuleSha256 = pinned.sha256(
      contracts.adjudication,
      MAX_WORKER_BYTES,
    );
    if (g2pRunnerSha256 !== T2A_GERMAN_G2P_RUNNER_SHA256
      || adjudicatorRunnerSha256 !== T2A_IPA_ADJUDICATOR_RUNNER_SHA256
      || (claimScope === "development"
        && (g2pContractModuleSha256 !== T2A_GERMAN_G2P_CONTRACT_SHA256
          || adjudicationContractModuleSha256 !== T2A_IPA_ADJUDICATION_CONTRACT_SHA256))) {
      throw new Error("G2P-/Adjudicator-Runner oder Vertragsmodul weicht von der Authority ab.");
    }
    pinned.verifyUnchanged();
    const g2pFingerprint = createHash("sha256").update(canonicalJson({
      authorityRevision: T2A_PRONUNCIATION_AUTHORITY_REVISION,
      runnerSha256: g2pRunnerSha256,
      contractSourceSha256: T2A_GERMAN_G2P_CONTRACT_SHA256,
      contractModuleSha256: g2pContractModuleSha256,
      runtimeManifestSha256: T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
    })).digest("hex");
    const adjudicatorFingerprint = createHash("sha256").update(canonicalJson({
      authorityRevision: T2A_PRONUNCIATION_AUTHORITY_REVISION,
      runnerSha256: adjudicatorRunnerSha256,
      contractSourceSha256: T2A_IPA_ADJUDICATION_CONTRACT_SHA256,
      contractModuleSha256: adjudicationContractModuleSha256,
      policySha256: T2A_IPA_ADJUDICATION_POLICY_SHA256,
    })).digest("hex");
    const fingerprint = createHash("sha256").update(canonicalJson({
      authorityRevision: T2A_PRONUNCIATION_AUTHORITY_REVISION,
      g2pFingerprint,
      adjudicatorFingerprint,
    })).digest("hex");
    return Object.freeze({
      revision: T2A_PRONUNCIATION_AUTHORITY_REVISION,
      fingerprint,
      g2pFingerprint,
      adjudicatorFingerprint,
      g2pRunnerPath,
      adjudicatorRunnerPath,
      g2pContractModulePath: contracts.g2p,
      adjudicationContractModulePath: contracts.adjudication,
      pinnedPaths,
      g2pRunnerSha256: T2A_GERMAN_G2P_RUNNER_SHA256,
      adjudicatorRunnerSha256: T2A_IPA_ADJUDICATOR_RUNNER_SHA256,
      g2pContractModuleSha256,
      adjudicationContractModuleSha256,
      dataManifest,
      runtimeManifest,
    });
  } finally {
    pinned.close();
  }
}

type SealedRuntimeAuthority = Pick<
  SealedT2aAudioEvaluatorAuthority,
  | "releaseDigest"
  | "runtimeInstallSealSha256"
  | "runtimeTreeSha256"
  | "runtimePolicySha256"
  | "runtimeTrustSha256"
>;

function requiredReleaseDigest(
  identity: ReleaseIdentity,
  key: "releaseDigest" | "runtimeInstallSealSha256" | "runtimeTreeSha256" | "runtimePolicySha256",
): string {
  const value = identity[key];
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`Versiegelte T2A-Runtime-Authority fehlt: ${key}.`);
  }
  return value;
}

function sealedRuntimeAuthority(): SealedRuntimeAuthority {
  if (!releaseIdentity.sealed || !releaseIdentity.verified || releaseIdentity.runtimeTrust === null) {
    throw new Error(
      "T2A-Audio-QA ist nur mit einer vollstaendig versiegelten Release-Runtime verfuegbar.",
    );
  }
  const runtimeTrust = revalidateSealedRuntimeTrustIdentity(releaseIdentity);
  return {
    releaseDigest: requiredReleaseDigest(releaseIdentity, "releaseDigest"),
    runtimeInstallSealSha256: requiredReleaseDigest(releaseIdentity, "runtimeInstallSealSha256"),
    runtimeTreeSha256: requiredReleaseDigest(releaseIdentity, "runtimeTreeSha256"),
    runtimePolicySha256: requiredReleaseDigest(releaseIdentity, "runtimePolicySha256"),
    runtimeTrustSha256: createHash("sha256").update(canonicalJson(runtimeTrust)).digest("hex"),
  };
}

function sameRuntimeAuthority(
  expected: SealedRuntimeAuthority,
  actual: SealedRuntimeAuthority,
): boolean {
  return canonicalJson(actual) === canonicalJson(expected);
}

function assertSealedRuntimePaths(paths: T2aAudioEvaluatorPaths): void {
  const expectedRuntimeRoot = join(appRoot, "runtime", ".venv");
  const expectedPython = join(expectedRuntimeRoot, "bin", "python");
  const realRuntimeRoot = realpathSync(expectedRuntimeRoot);
  const realPython = realpathSync(expectedPython);
  const relativePython = relative(realRuntimeRoot, realPython);
  if (analysisPythonExecutable !== expectedPython
    || paths.pythonExecutable !== expectedPython
    || paths.runtimeRoot !== expectedRuntimeRoot
    || paths.pythonBinary !== realPython
    || relativePython === ""
    || relativePython === ".."
    || relativePython.startsWith(`..${sep}`)) {
    throw new Error("T2A-Analyse-Python liegt nicht in der versiegelten Server-Runtime.");
  }
}

function assertDevelopmentRuntimePaths(paths: T2aAudioEvaluatorPaths): void {
  if (sealedRelease || !t2aDevelopmentMeasurementEnabled) {
    throw new Error(
      "T2A-Development-Messung ist nicht explizit fuer diese unversiegelte Server-Session aktiviert.",
    );
  }
  const expectedRuntimeRoot = join(appRoot, "runtime", ".venv");
  const expectedPython = join(expectedRuntimeRoot, "bin", "python");
  if (analysisPythonExecutable !== expectedPython
    || paths.pythonExecutable !== expectedPython
    || paths.runtimeRoot !== expectedRuntimeRoot
    || paths.pythonBinary !== realpathSync(expectedPython)
    || paths.qualitySchemaModule !== join(appRoot, "shared", "t2aAudioQuality.ts")
    || paths.baseContractsModule !== join(appRoot, "shared", "t2aAudioBaseContracts.ts")) {
    throw new Error("T2A-Development-Messruntime stimmt nicht mit der Serverkonfiguration ueberein.");
  }
}

export function resolveT2aAudioEvaluatorAuthority(
  ...unexpectedArguments: never[]
): SealedT2aAudioEvaluatorAuthority {
  if (unexpectedArguments.length !== 0) {
    throw new Error("T2A-Evaluator-Authority akzeptiert keine aufrufergesteuerten Pfade.");
  }
  const paths = defaultEvaluatorPaths("sealed-release");
  assertSealedRuntimePaths(paths);
  const common = resolveCommonEvaluatorAuthority(paths);
  const runtimeAuthority = sealedRuntimeAuthority();
  assertSealedRuntimePaths(paths);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    revision: T2A_AUDIO_EVALUATOR_REVISION,
    workerSha256: common.workerSha256,
    dialogueEvaluatorSha256: common.dialogueEvaluatorSha256,
    qualitySchemaSha256: common.qualitySchemaSha256,
    qualitySchemaModuleSha256: common.qualitySchemaModuleSha256,
    baseContractsSha256: common.baseContractsSha256,
    baseContractsModuleSha256: common.baseContractsModuleSha256,
    ffmpegSha256: common.ffmpegSha256,
    whisperModelSha256: common.whisperModelSha256,
    pythonSha256: common.pythonSha256,
    ...runtimeAuthority,
  })).digest("hex");
  return {
    ...common,
    claimScope: "sealed-release",
    fingerprint,
    ...runtimeAuthority,
  };
}

type CommonAuthorityWithoutFingerprint = Omit<
  T2aAudioEvaluatorAuthorityBase,
  "fingerprint"
>;

function resolveCommonEvaluatorAuthority(
  paths: T2aAudioEvaluatorPaths,
): CommonAuthorityWithoutFingerprint {
  const pinnedPaths = [
    capturePinnedPathRevision(paths.workerScript, "file"),
    capturePinnedPathRevision(paths.dialogueEvaluatorScript, "file"),
    capturePinnedPathRevision(paths.qualitySchemaModule, "file"),
    capturePinnedPathRevision(paths.baseContractsModule, "file"),
    capturePinnedPathRevision(paths.ffmpegExecutable, "file"),
    capturePinnedPathRevision(paths.whisperModel, "file"),
    capturePinnedPathRevision(paths.pythonBinary, "file"),
    capturePinnedPathRevision(paths.runtimeRoot, "directory"),
  ] as const;
  const pinned = openPinnedPaths([...pinnedPaths]);
  try {
    const workerSha256 = pinned.sha256(paths.workerScript, MAX_WORKER_BYTES);
    const dialogueEvaluatorSha256 = pinned.sha256(
      paths.dialogueEvaluatorScript,
      MAX_DIALOGUE_EVALUATOR_BYTES,
    );
    const qualitySchemaModuleSha256 = pinned.sha256(paths.qualitySchemaModule, MAX_WORKER_BYTES);
    const baseContractsModuleSha256 = pinned.sha256(
      paths.baseContractsModule,
      MAX_WORKER_BYTES,
    );
    const ffmpegSha256 = pinned.sha256(paths.ffmpegExecutable, MAX_FFMPEG_BYTES);
    const whisperModelSha256 = pinned.sha256(paths.whisperModel, MAX_WHISPER_BYTES);
    const pythonSha256 = pinned.sha256(paths.pythonBinary, 64 * 1024 * 1024);
    if (workerSha256 !== T2A_AUDIO_WORKER_SHA256
      || dialogueEvaluatorSha256 !== T2A_DIALOGUE_EVALUATOR_SHA256
      || ffmpegSha256 !== T2A_FFMPEG_SHA256
      || whisperModelSha256 !== T2A_WHISPER_SMALL_SHA256) {
      throw new Error(
        "T2A-Audio-Worker, Dialog-Evaluator, FFmpeg oder Whisper stimmt nicht mit der Server-Authority ueberein.",
      );
    }
    pinned.verifyUnchanged();
    return {
      revision: T2A_AUDIO_EVALUATOR_REVISION,
      paths,
      pinnedPaths,
      workerSha256: T2A_AUDIO_WORKER_SHA256,
      dialogueEvaluatorSha256: T2A_DIALOGUE_EVALUATOR_SHA256,
      qualitySchemaSha256: T2A_AUDIO_QUALITY_SCHEMA_SHA256,
      qualitySchemaModuleSha256,
      baseContractsSha256: T2A_AUDIO_BASE_CONTRACTS_SHA256,
      baseContractsModuleSha256,
      ffmpegSha256: T2A_FFMPEG_SHA256,
      whisperModelSha256: T2A_WHISPER_SMALL_SHA256,
      pythonSha256,
    };
  } finally {
    pinned.close();
  }
}

export function resolveDevelopmentT2aAudioEvaluatorAuthority(
  ...unexpectedArguments: never[]
): DevelopmentT2aAudioEvaluatorAuthority {
  if (unexpectedArguments.length !== 0) {
    throw new Error("T2A-Evaluator-Authority akzeptiert keine aufrufergesteuerten Pfade.");
  }
  const paths = defaultEvaluatorPaths("development");
  assertDevelopmentRuntimePaths(paths);
  const common = resolveCommonEvaluatorAuthority(paths);
  if (common.qualitySchemaModuleSha256 !== T2A_AUDIO_QUALITY_SCHEMA_SHA256
    || common.baseContractsModuleSha256 !== T2A_AUDIO_BASE_CONTRACTS_SHA256) {
    throw new Error(
      "T2A-Development-Qualitaetsvertraege stimmen nicht mit der Server-Authority ueberein.",
    );
  }
  assertDevelopmentRuntimePaths(paths);
  const fingerprint = createHash("sha256").update(JSON.stringify({
    revision: T2A_AUDIO_EVALUATOR_REVISION,
    claimScope: "development",
    developmentSessionNonce: DEVELOPMENT_SESSION_NONCE,
    workerSha256: common.workerSha256,
    dialogueEvaluatorSha256: common.dialogueEvaluatorSha256,
    qualitySchemaSha256: common.qualitySchemaSha256,
    qualitySchemaModuleSha256: common.qualitySchemaModuleSha256,
    baseContractsSha256: common.baseContractsSha256,
    baseContractsModuleSha256: common.baseContractsModuleSha256,
    ffmpegSha256: common.ffmpegSha256,
    whisperModelSha256: common.whisperModelSha256,
    pythonSha256: common.pythonSha256,
  })).digest("hex");
  return {
    ...common,
    claimScope: "development",
    fingerprint,
  };
}

export function resolveConfiguredT2aAudioEvaluatorAuthority(): T2aAudioEvaluatorAuthority {
  return t2aDevelopmentMeasurementEnabled
    ? resolveDevelopmentT2aAudioEvaluatorAuthority()
    : resolveT2aAudioEvaluatorAuthority();
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function terminateProcessGroup(child: ChildProcess, graceMs: number): Promise<void> {
  if (!child.pid) return;
  const processGroupId = child.pid;
  signalProcessGroup(child, "SIGTERM");
  const graceDeadline = Date.now() + graceMs;
  while (Date.now() < graceDeadline && processGroupExists(processGroupId)) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (!processGroupExists(processGroupId)) return;
  signalProcessGroup(child, "SIGKILL");
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && processGroupExists(processGroupId)) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  if (processGroupExists(processGroupId)) {
    throw new Error(`T2A-Sandbox-Prozessgruppe ${processGroupId} blieb nach SIGKILL aktiv.`);
  }
}

export function monitorT2aAudioControlProcess(
  child: ChildProcess,
  timeoutMs = SYSTEMD_CONTROL_TIMEOUT_MS,
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolvePromise) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null, trailingError = ""): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr: `${stderr}${trailingError}` });
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The bounded failure result below remains authoritative.
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
      try {
        child.unref();
      } catch {
        // The control promise is still bounded below.
      }
      finish(null, "Systemd-Steuerung ueberschritt ihr Zeitlimit.");
    }, timeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = boundedAppend(stdout, chunk, MAX_STDERR_BYTES);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, chunk, MAX_STDERR_BYTES);
    });
    child.once("error", (error) => {
      finish(null, error.message);
    });
    child.once("close", (code) => {
      finish(code);
    });
  });
}

function runControlCommand(args: string[], timeoutMs = SYSTEMD_CONTROL_TIMEOUT_MS): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn("/usr/bin/sudo", ["-n", ...args], {
    env: { PATH: "/usr/bin:/bin" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return monitorT2aAudioControlProcess(child, timeoutMs);
}

function controlTimeoutWithin(deadline: number): number {
  if (deadline === Number.POSITIVE_INFINITY) return SYSTEMD_CONTROL_TIMEOUT_MS;
  return Math.max(1, Math.min(SYSTEMD_CONTROL_TIMEOUT_MS, deadline - Date.now()));
}

export async function recoverT2aAudioSandboxUnits(
  controlCommand: typeof runControlCommand = runControlCommand,
  resultDeadline = Number.POSITIVE_INFINITY,
): Promise<void> {
  const assertRecoveryBudget = (): void => {
    if (Date.now() >= resultDeadline) {
      throw new Error("T2A-Audio-Evaluator hat waehrend der Sandbox-Recovery sein Gesamtzeitlimit erreicht.");
    }
  };
  assertRecoveryBudget();
  const listed = await controlCommand([
    "/usr/bin/systemctl",
    "list-units",
    "--all",
    "--plain",
    "--no-legend",
    `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-*.service`,
  ], controlTimeoutWithin(resultDeadline));
  if (listed.code !== 0) {
    throw new Error(`T2A-Sandbox-Recovery konnte Units nicht auflisten: ${listed.stderr.slice(-500)}`);
  }
  assertRecoveryBudget();
  const escapedPrefix = T2A_AUDIO_SANDBOX_UNIT_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const unitPattern = new RegExp(
    `^${escapedPrefix}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.service$`,
    "u",
  );
  const units = listed.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((unit) => unitPattern.test(unit));
  for (const unit of units) {
    assertRecoveryBudget();
    await stopT2aSandboxUnit(
      unit.slice(0, -".service".length),
      controlCommand,
      resultDeadline,
    );
    assertRecoveryBudget();
  }
}

let cachedEvaluatorAuthority: T2aAudioEvaluatorAuthority | null = null;
let cachedIndependentIpaAuthority: T2aIndependentIpaAuthority | null = null;
let cachedPronunciationAuthority: T2aPronunciationAuthority | null = null;

function independentIpaPinnedPathRevisions(authority: T2aIndependentIpaAuthority) {
  return [
    capturePinnedPathRevision(authority.runnerPath, "file"),
    capturePinnedPathRevision(authority.modelDirectory, "directory"),
    ...T2A_INDEPENDENT_IPA_MODEL_FILES.map((name) => capturePinnedPathRevision(
      join(authority.modelDirectory, name),
      "file",
    )),
  ];
}

export function getT2aIndependentIpaAuthorityState(): T2aIndependentIpaAuthority {
  if (cachedIndependentIpaAuthority) {
    try {
      assertSealedIndependentIpaModelInstall();
      const revisions = independentIpaPinnedPathRevisions(cachedIndependentIpaAuthority);
      if (JSON.stringify(revisions) === JSON.stringify(cachedIndependentIpaAuthority.pinnedPaths)) {
        return cachedIndependentIpaAuthority;
      }
    } catch {
      // A changed or unavailable path must be re-resolved and fail closed below.
    }
  }
  cachedIndependentIpaAuthority = resolveT2aIndependentIpaAuthority();
  return cachedIndependentIpaAuthority;
}

function pronunciationPinnedPathRevisions(authority: T2aPronunciationAuthority) {
  return [
    capturePinnedPathRevision(authority.g2pRunnerPath, "file"),
    capturePinnedPathRevision(authority.adjudicatorRunnerPath, "file"),
    capturePinnedPathRevision(authority.g2pContractModulePath, "file"),
    capturePinnedPathRevision(authority.adjudicationContractModulePath, "file"),
    capturePinnedPathRevision(T2A_GERMAN_G2P_ESPEAK_PATH, "file"),
    capturePinnedPathRevision(T2A_GERMAN_G2P_DATA_ROOT, "directory"),
    capturePinnedPathRevision(T2A_GERMAN_G2P_VOCAB_PATH, "file"),
  ];
}

export function getT2aPronunciationAuthorityState(): T2aPronunciationAuthority {
  if (cachedPronunciationAuthority) {
    try {
      const revisions = pronunciationPinnedPathRevisions(cachedPronunciationAuthority);
      if (JSON.stringify(revisions) === JSON.stringify(cachedPronunciationAuthority.pinnedPaths)) {
        return cachedPronunciationAuthority;
      }
    } catch {
      // A changed path is re-resolved and rejected by the reviewed pins below.
    }
  }
  cachedPronunciationAuthority = resolveT2aPronunciationAuthority();
  return cachedPronunciationAuthority;
}

function verifyPronunciationAuthorityPins(
  authority: T2aPronunciationAuthority,
  pinned: ReturnType<typeof openPinnedPaths>,
): void {
  const currentDataManifest = captureT2aGermanG2pDataManifest();
  const currentRuntimeManifest = captureT2aGermanG2pRuntimeManifest(currentDataManifest);
  if (authority.revision !== T2A_PRONUNCIATION_AUTHORITY_REVISION
    || authority.g2pRunnerSha256 !== T2A_GERMAN_G2P_RUNNER_SHA256
    || authority.adjudicatorRunnerSha256 !== T2A_IPA_ADJUDICATOR_RUNNER_SHA256
    || pinned.sha256(authority.g2pRunnerPath, MAX_WORKER_BYTES)
      !== T2A_GERMAN_G2P_RUNNER_SHA256
    || pinned.sha256(authority.adjudicatorRunnerPath, MAX_WORKER_BYTES)
      !== T2A_IPA_ADJUDICATOR_RUNNER_SHA256
    || pinned.sha256(authority.g2pContractModulePath, MAX_WORKER_BYTES)
      !== authority.g2pContractModuleSha256
    || pinned.sha256(authority.adjudicationContractModulePath, MAX_WORKER_BYTES)
      !== authority.adjudicationContractModuleSha256
    || canonicalJson(currentDataManifest) !== canonicalJson(authority.dataManifest)
    || canonicalJson(currentRuntimeManifest) !== canonicalJson(authority.runtimeManifest)) {
    throw new Error("T2A-Pronunciation-Authority ist nicht mehr gueltig.");
  }
  const expectedG2pFingerprint = createHash("sha256").update(canonicalJson({
    authorityRevision: authority.revision,
    runnerSha256: authority.g2pRunnerSha256,
    contractSourceSha256: T2A_GERMAN_G2P_CONTRACT_SHA256,
    contractModuleSha256: authority.g2pContractModuleSha256,
    runtimeManifestSha256: T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
  })).digest("hex");
  const expectedAdjudicatorFingerprint = createHash("sha256").update(canonicalJson({
    authorityRevision: authority.revision,
    runnerSha256: authority.adjudicatorRunnerSha256,
    contractSourceSha256: T2A_IPA_ADJUDICATION_CONTRACT_SHA256,
    contractModuleSha256: authority.adjudicationContractModuleSha256,
    policySha256: T2A_IPA_ADJUDICATION_POLICY_SHA256,
  })).digest("hex");
  const expectedFingerprint = createHash("sha256").update(canonicalJson({
    authorityRevision: authority.revision,
    g2pFingerprint: expectedG2pFingerprint,
    adjudicatorFingerprint: expectedAdjudicatorFingerprint,
  })).digest("hex");
  if (authority.g2pFingerprint !== expectedG2pFingerprint
    || authority.adjudicatorFingerprint !== expectedAdjudicatorFingerprint
    || authority.fingerprint !== expectedFingerprint) {
    throw new Error("T2A-Pronunciation-Fingerprint ist ungueltig.");
  }
  pinned.verifyUnchanged();
}

function verifyIndependentIpaAuthorityPins(
  authority: T2aIndependentIpaAuthority,
  pinned: ReturnType<typeof openPinnedPaths>,
): void {
  if (authority.revision !== T2A_INDEPENDENT_IPA_AUTHORITY_REVISION
    || authority.runnerSha256 !== T2A_INDEPENDENT_IPA_RUNNER_SHA256
    || authority.modelManifestSha256 !== T2A_INDEPENDENT_IPA_MODEL_MANIFEST_SHA256
    || authority.modelWeightSha256 !== T2A_INDEPENDENT_IPA_MODEL_WEIGHT_SHA256
    || authority.runnerPath !== join(appRoot, "scripts", "independent_ipa_evaluator.py")
    || authority.modelDirectory !== T2A_INDEPENDENT_IPA_MODEL_DIRECTORY) {
    throw new Error("Unabhaengige IPA-Evaluator-Authority ist nicht mehr gueltig.");
  }
  const expectedFingerprint = createHash("sha256").update(JSON.stringify({
    revision: authority.revision,
    runnerSha256: authority.runnerSha256,
    modelManifestSha256: authority.modelManifestSha256,
    modelWeightSha256: authority.modelWeightSha256,
    auxiliarySha256: T2A_INDEPENDENT_IPA_AUXILIARY_SHA256,
  })).digest("hex");
  if (authority.fingerprint !== expectedFingerprint) {
    throw new Error("Unabhaengiger IPA-Evaluator-Fingerprint ist ungueltig.");
  }
  assertSealedIndependentIpaModelInstall();
  pinned.verifyUnchanged();
}

function combinedT2aAudioEvaluatorFingerprint(
  authority: T2aAudioEvaluatorAuthority,
  independentIpaAuthority: T2aIndependentIpaAuthority,
  pronunciationAuthority: T2aPronunciationAuthority,
): string {
  return t2aAudioEvaluatorBindingFromAuthorities(
    authority,
    independentIpaAuthority,
    pronunciationAuthority,
  ).evaluatorFingerprint;
}

function t2aAudioEvaluatorBindingFromAuthorities(
  authority: T2aAudioEvaluatorAuthority,
  independentIpaAuthority: T2aIndependentIpaAuthority,
  pronunciationAuthority: T2aPronunciationAuthority,
): T2aAudioEvaluatorBinding {
  assertSha256(authority.fingerprint, "T2A-Quality-Evaluator-Fingerprint");
  assertSha256(independentIpaAuthority.fingerprint, "T2A-IPA-Evaluator-Fingerprint");
  assertSha256(pronunciationAuthority.g2pFingerprint, "T2A-G2P-Evaluator-Fingerprint");
  assertSha256(
    pronunciationAuthority.adjudicatorFingerprint,
    "T2A-IPA-Adjudicator-Fingerprint",
  );
  if (authority.claimScope !== "sealed-release" && authority.claimScope !== "development") {
    throw new Error("T2A-Evaluator-Claim-Scope ist ungueltig.");
  }
  const evaluatorFingerprint = createHash("sha256").update(canonicalJson({
    evaluatorRevision: T2A_AUDIO_EVALUATOR_REVISION,
    qualityEvaluatorFingerprint: authority.fingerprint,
    independentIpaEvaluatorFingerprint: independentIpaAuthority.fingerprint,
    germanG2pEvaluatorFingerprint: pronunciationAuthority.g2pFingerprint,
    ipaAdjudicatorFingerprint: pronunciationAuthority.adjudicatorFingerprint,
  })).digest("hex");
  return Object.freeze({
    evaluatorFingerprint,
    claimScope: authority.claimScope,
  });
}

/**
 * Resolves the single record/read authority for T2A audio QA. Callers cannot
 * select either evaluator path: both the quality evaluator and the independent
 * IPA authority are revalidated by their server-owned state resolvers.
 */
export function resolveT2aAudioEvaluatorBinding(
  ...unexpectedArguments: never[]
): T2aAudioEvaluatorBinding {
  if (unexpectedArguments.length !== 0) {
    throw new Error("T2A-Evaluator-Binding akzeptiert keine aufrufergesteuerten Authorities.");
  }
  return t2aAudioEvaluatorBindingFromAuthorities(
    getT2aAudioEvaluatorAuthorityState(),
    getT2aIndependentIpaAuthorityState(),
    getT2aPronunciationAuthorityState(),
  );
}

function assertT2aAudioEvaluatorBindingShape(
  binding: T2aAudioEvaluatorBinding,
  label: string,
): void {
  if (!binding
    || typeof binding !== "object"
    || Object.keys(binding).sort().join(",") !== "claimScope,evaluatorFingerprint"
    || !/^[0-9a-f]{64}$/u.test(binding.evaluatorFingerprint)
    || (binding.claimScope !== "sealed-release" && binding.claimScope !== "development")) {
    throw new Error(`${label} ist kein gueltiges kombiniertes T2A-Evaluator-Binding.`);
  }
}

export function assertMatchingT2aAudioEvaluatorBindings(
  expected: T2aAudioEvaluatorBinding,
  actual: T2aAudioEvaluatorBinding,
): void {
  assertT2aAudioEvaluatorBindingShape(expected, "Erwartetes Binding");
  assertT2aAudioEvaluatorBindingShape(actual, "Aktuelles Binding");
  if (expected.evaluatorFingerprint !== actual.evaluatorFingerprint
    || expected.claimScope !== actual.claimScope) {
    throw new Error("Kombiniertes T2A-Evaluator-Binding weicht von der Preflight-Authority ab.");
  }
}

export function getT2aAudioEvaluatorAuthorityState(): T2aAudioEvaluatorAuthority {
  const claimScope: T2aAudioClaimScope = t2aDevelopmentMeasurementEnabled
    ? "development"
    : "sealed-release";
  const paths = defaultEvaluatorPaths(claimScope);
  if (cachedEvaluatorAuthority) {
    try {
      const revisions = [
        capturePinnedPathRevision(paths.workerScript, "file"),
        capturePinnedPathRevision(paths.dialogueEvaluatorScript, "file"),
        capturePinnedPathRevision(paths.qualitySchemaModule, "file"),
        capturePinnedPathRevision(paths.baseContractsModule, "file"),
        capturePinnedPathRevision(paths.ffmpegExecutable, "file"),
        capturePinnedPathRevision(paths.whisperModel, "file"),
        capturePinnedPathRevision(paths.pythonBinary, "file"),
        capturePinnedPathRevision(paths.runtimeRoot, "directory"),
      ];
      if (cachedEvaluatorAuthority.claimScope === claimScope
        && JSON.stringify(revisions) === JSON.stringify(cachedEvaluatorAuthority.pinnedPaths)) {
        return cachedEvaluatorAuthority;
      }
    } catch {
      // A changed or unavailable path must be re-resolved and fail closed below.
    }
  }
  cachedEvaluatorAuthority = resolveConfiguredT2aAudioEvaluatorAuthority();
  return cachedEvaluatorAuthority;
}

async function stopT2aSandboxUnit(
  unitName: string,
  controlCommand: typeof runControlCommand,
  deadline = Date.now() + SYSTEMD_STOP_DEADLINE_MS,
): Promise<void> {
  let lastError = "";
  while (Date.now() < deadline) {
    const stopped = await controlCommand(
      ["/usr/bin/systemctl", "stop", `${unitName}.service`],
      controlTimeoutWithin(deadline),
    );
    if (stopped.code === 0) return;
    lastError = stopped.stderr.slice(-500);
    const state = await controlCommand([
      "/usr/bin/systemctl",
      "show",
      "--property=LoadState",
      "--property=ActiveState",
      `${unitName}.service`,
    ], controlTimeoutWithin(deadline));
    const unitState = Object.fromEntries(state.stdout.trim().split(/\r?\n/u)
      .map((line) => line.split("=", 2))
      .filter((entry): entry is [string, string] => entry.length === 2));
    if (state.code === 0
      && (unitState.LoadState === "not-found"
        || ["inactive", "failed"].includes(unitState.ActiveState ?? ""))) {
      return;
    }
    if (state.stderr) lastError = state.stderr.slice(-500);
    const retryDelayMs = Math.min(50, Math.max(0, deadline - Date.now()));
    if (retryDelayMs > 0) {
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, retryDelayMs));
    }
  }
  throw new Error(
    `T2A-Sandbox-Unit konnte bis zum gebundenen RuntimeMax-Ende nicht sicher gestoppt werden: ${lastError}`,
  );
}

function boundedAppend(current: string, chunk: Buffer, maximumBytes: number): string {
  const next = current + chunk.toString("utf8");
  return Buffer.byteLength(next) <= maximumBytes ? next : next.slice(-maximumBytes);
}

function assertResultBinding(
  result: T2aAudioQuality,
  target: T2aAudioEvaluationTarget,
  authority: T2aAudioEvaluatorAuthority,
  independentIpaPhase: ParsedIndependentIpaPhaseExecution,
  ipaAdjudication: ParsedT2aIpaAdjudicationExecution,
  pronunciationAuthority: T2aPronunciationAuthority,
): void {
  if (result.analysisStatus === "failed") {
    if (result.ia2vEligibility.blockers.length !== 1
      || result.ia2vEligibility.blockers[0] !== "analysis-failed") {
      throw new Error("T2A-Audio-Worker lieferte keine rohe technische Eligibility.");
    }
    return;
  }
  if (result.sourceSnapshot.sha256 !== target.audioSha256
    || result.policy.peakCeilingDbfs !== target.peakCeilingDbfs
    || result.loudness.ffmpegSha256 !== authority.ffmpegSha256
    || result.dialogueEvaluation.expectedTranscriptSha256 !== target.dialogueSha256
    || result.dialogueEvaluation.modelSha256 !== authority.whisperModelSha256
    || result.spokenContentGate.independentIpa.authorityAudioSha256 !== target.audioSha256
    || result.spokenContentGate.independentIpa.phaseDocumentSha256
      !== independentIpaPhase.sha256
    || canonicalJson(result.spokenContentGate.independentIpa.phase)
      !== canonicalJson(independentIpaPhase.phase)
    || result.spokenContentGate.ipaAdjudication === undefined
    || result.spokenContentGate.ipaAdjudication.resultDocumentSha256
      !== ipaAdjudication.sha256
    || canonicalJson(result.spokenContentGate.ipaAdjudication.result)
      !== canonicalJson(ipaAdjudication.result)
    || ipaAdjudication.result.phaseSha256 !== independentIpaPhase.sha256
    || ipaAdjudication.result.targetTextSha256 !== target.dialogueSha256
    || ipaAdjudication.result.runnerSha256 !== pronunciationAuthority.adjudicatorRunnerSha256
    || ipaAdjudication.result.policySha256 !== T2A_IPA_ADJUDICATION_POLICY_SHA256
    || canonicalJson(result.dialogueEvaluation.phonemeVerification)
      !== canonicalJson(deriveT2aPhonemeVerification(
        ipaAdjudication.sha256,
        ipaAdjudication.result,
      ))) {
    throw new Error("T2A-Audio-Messdaten widersprechen der gebundenen Server-Authority.");
  }
  if (canonicalJson(result.ia2vEligibility) !== canonicalJson(deriveT2aIa2vEligibility(result))) {
    throw new Error("T2A-Audio-Worker lieferte keine rohe technische Eligibility.");
  }
}

function verifyAuthorityPins(
  authority: T2aAudioEvaluatorAuthority,
  pinned: ReturnType<typeof openPinnedPaths>,
): void {
  if (authority.revision !== T2A_AUDIO_EVALUATOR_REVISION
    || authority.workerSha256 !== T2A_AUDIO_WORKER_SHA256
    || authority.dialogueEvaluatorSha256 !== T2A_DIALOGUE_EVALUATOR_SHA256
    || authority.qualitySchemaSha256 !== T2A_AUDIO_QUALITY_SCHEMA_SHA256
    || authority.baseContractsSha256 !== T2A_AUDIO_BASE_CONTRACTS_SHA256
    || authority.ffmpegSha256 !== T2A_FFMPEG_SHA256
    || authority.whisperModelSha256 !== T2A_WHISPER_SMALL_SHA256
    || authority.paths.pythonExecutable !== analysisPythonExecutable
    || authority.paths.runtimeRoot !== join(appRoot, "runtime", ".venv")
    || realpathSync(authority.paths.pythonExecutable) !== authority.paths.pythonBinary
    || pinned.sha256(authority.paths.workerScript, MAX_WORKER_BYTES) !== T2A_AUDIO_WORKER_SHA256
    || pinned.sha256(authority.paths.dialogueEvaluatorScript, MAX_DIALOGUE_EVALUATOR_BYTES)
      !== T2A_DIALOGUE_EVALUATOR_SHA256
    || pinned.sha256(authority.paths.qualitySchemaModule, MAX_WORKER_BYTES)
      !== authority.qualitySchemaModuleSha256
    || pinned.sha256(authority.paths.baseContractsModule, MAX_WORKER_BYTES)
      !== authority.baseContractsModuleSha256
    || pinned.sha256(authority.paths.ffmpegExecutable, MAX_FFMPEG_BYTES) !== T2A_FFMPEG_SHA256
    || pinned.sha256(authority.paths.whisperModel, MAX_WHISPER_BYTES) !== T2A_WHISPER_SMALL_SHA256
    || pinned.sha256(authority.paths.pythonBinary, 64 * 1024 * 1024) !== authority.pythonSha256) {
    throw new Error("T2A-Audio-Evaluator-Authority ist nicht mehr gueltig.");
  }
  let expectedFingerprint: string;
  if (authority.claimScope === "sealed-release") {
    assertSealedRuntimePaths(authority.paths);
    const currentRuntimeAuthority = sealedRuntimeAuthority();
    if (!sameRuntimeAuthority(authority, currentRuntimeAuthority)) {
      throw new Error("Versiegelte T2A-Paketlaufzeit aenderte sich waehrend der Authority-Pruefung.");
    }
    expectedFingerprint = createHash("sha256").update(JSON.stringify({
      revision: authority.revision,
      workerSha256: authority.workerSha256,
      dialogueEvaluatorSha256: authority.dialogueEvaluatorSha256,
      qualitySchemaSha256: authority.qualitySchemaSha256,
      qualitySchemaModuleSha256: authority.qualitySchemaModuleSha256,
      baseContractsSha256: authority.baseContractsSha256,
      baseContractsModuleSha256: authority.baseContractsModuleSha256,
      ffmpegSha256: authority.ffmpegSha256,
      whisperModelSha256: authority.whisperModelSha256,
      pythonSha256: authority.pythonSha256,
      releaseDigest: authority.releaseDigest,
      runtimeInstallSealSha256: authority.runtimeInstallSealSha256,
      runtimeTreeSha256: authority.runtimeTreeSha256,
      runtimePolicySha256: authority.runtimePolicySha256,
      runtimeTrustSha256: authority.runtimeTrustSha256,
    })).digest("hex");
  } else {
    assertDevelopmentRuntimePaths(authority.paths);
    if (authority.qualitySchemaModuleSha256 !== T2A_AUDIO_QUALITY_SCHEMA_SHA256
      || authority.baseContractsModuleSha256 !== T2A_AUDIO_BASE_CONTRACTS_SHA256) {
      throw new Error("T2A-Development-Evaluator-Vertragsauthority ist nicht mehr gueltig.");
    }
    expectedFingerprint = createHash("sha256").update(JSON.stringify({
      revision: authority.revision,
      claimScope: authority.claimScope,
      developmentSessionNonce: DEVELOPMENT_SESSION_NONCE,
      workerSha256: authority.workerSha256,
      dialogueEvaluatorSha256: authority.dialogueEvaluatorSha256,
      qualitySchemaSha256: authority.qualitySchemaSha256,
      qualitySchemaModuleSha256: authority.qualitySchemaModuleSha256,
      baseContractsSha256: authority.baseContractsSha256,
      baseContractsModuleSha256: authority.baseContractsModuleSha256,
      ffmpegSha256: authority.ffmpegSha256,
      whisperModelSha256: authority.whisperModelSha256,
      pythonSha256: authority.pythonSha256,
    })).digest("hex");
  }
  if (authority.fingerprint !== expectedFingerprint) {
    throw new Error("T2A-Audio-Evaluator-Fingerprint ist ungueltig.");
  }
  pinned.verifyUnchanged();
}

export function verifyT2aAudioEvaluatorAuthorityPins(
  authority: T2aAudioEvaluatorAuthority,
): void {
  const pinned = openPinnedPaths([...authority.pinnedPaths]);
  try {
    verifyAuthorityPins(authority, pinned);
  } finally {
    pinned.close();
  }
}

export type T2aAudioSandboxPaths = {
  root: string;
  worker: string;
  dialogueEvaluator: string;
  ipaRunner: string;
  ipaModel: string;
  g2pRunner: string;
  adjudicatorRunner: string;
  g2pRequest: string;
  adjudicatorRequest: string;
  adjudicationResult: string;
  espeak: string;
  espeakData: string;
  ipaVocabulary: string;
  audio: string;
  transcript: string;
  ipaObservation: string;
  whisper: string;
  ffmpeg: string;
  runtime: string;
  python: string;
};

function ownedUnitPattern(): RegExp {
  const escapedPrefix = T2A_AUDIO_SANDBOX_UNIT_PREFIX.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(
    `^${escapedPrefix}-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
    "u",
  );
}

export function t2aAudioSandboxPaths(unitName: string): T2aAudioSandboxPaths {
  if (!ownedUnitPattern().test(unitName)) {
    throw new Error("T2A-Sandbox-Unit gehoert nicht zur Serverinstanz.");
  }
  const root = evaluatorRuntimeDirectory(unitName);
  const runtime = join(root, "runtime");
  return {
    root,
    worker: join(root, "analyze-t2a-audio.py"),
    dialogueEvaluator: join(root, "dialogue_word_evaluator.py"),
    ipaRunner: join(root, "independent_ipa_evaluator.py"),
    ipaModel: join(root, "independent-ipa-model"),
    g2pRunner: join(root, "t2a_german_g2p.py"),
    adjudicatorRunner: join(root, "t2a_ipa_adjudicator.py"),
    g2pRequest: join(root, T2A_GERMAN_G2P_REQUEST_BASENAME),
    adjudicatorRequest: join(root, T2A_IPA_ADJUDICATOR_REQUEST_BASENAME),
    adjudicationResult: join(root, T2A_IPA_ADJUDICATION_RESULT_BASENAME),
    espeak: T2A_GERMAN_G2P_ESPEAK_PATH,
    espeakData: T2A_GERMAN_G2P_DATA_ROOT,
    ipaVocabulary: T2A_GERMAN_G2P_VOCAB_PATH,
    audio: join(root, "authority.wav"),
    transcript: join(root, "transcript.utf8"),
    ipaObservation: join(root, "independent-ipa-observation.json"),
    whisper: join(root, "whisper-small.pt"),
    ffmpeg: join(root, "ffmpeg"),
    runtime,
    python: join(runtime, "bin", "python"),
  };
}

export type T2aAudioSandboxBindings = {
  worker: string;
  dialogueEvaluator: string;
  audio: string;
  transcript: string;
  ipaObservation: string;
  whisper: string;
  ffmpeg: string;
  runtime: string;
  ipaAdjudication: string;
};

export type T2aIndependentIpaSandboxBindings = {
  worker: string;
  ipaRunner: string;
  audio: string;
  ipaModel: string;
  ffmpeg: string;
  runtime: string;
};

export type T2aGermanG2pSandboxBindings = {
  g2pRunner: string;
  g2pRequest: string;
  espeak: string;
  espeakData: string;
  ipaVocabulary: string;
  runtime: string;
};

export type T2aIpaAdjudicatorSandboxBindings = {
  adjudicatorRunner: string;
  adjudicatorRequest: string;
  ipaVocabulary: string;
  runtime: string;
};

export type T2aAudioSandboxResourceProfile =
  | "quality"
  | "independent-ipa"
  | "german-g2p"
  | "ipa-adjudicator";
const PINNED_READ_ONLY_BINDING_PREFIX = "--property=BindReadOnlyPaths=";

export function t2aAudioSandboxForbiddenHostPaths(
  resourceProfile: T2aAudioSandboxResourceProfile,
): string[] {
  // Scripts/runtimes and private studio data may enter only through the
  // process-pinned read-only FD destinations below. The final profile entry
  // closes the cross-phase model source which that phase must never observe.
  return [...new Set([
    resolve(appRoot),
    resolve(dataRoot),
    ...(resourceProfile === "quality"
      ? [T2A_INDEPENDENT_IPA_MODEL_DIRECTORY, T2A_GERMAN_G2P_DATA_ROOT]
      : [resolve(whisperModelPath)]),
    ...(resourceProfile === "german-g2p" || resourceProfile === "ipa-adjudicator"
      ? [T2A_INDEPENDENT_IPA_MODEL_DIRECTORY]
      : []),
  ])];
}

export function t2aAudioSandboxSensitiveNoExecHostPaths(): string[] {
  return [...new Set([
    resolve(appRoot),
    resolve(dataRoot),
    "/var/lib/ltx-studio",
    "/home",
    "/tmp",
  ])];
}

function assertPinnedReadOnlyBinding(
  property: string,
  expectedDestination: string,
  label: string,
): void {
  const binding = property.startsWith(PINNED_READ_ONLY_BINDING_PREFIX)
    ? property.slice(PINNED_READ_ONLY_BINDING_PREFIX.length)
    : "";
  const separator = binding.indexOf(":");
  const source = separator >= 0 ? binding.slice(0, separator) : "";
  const destination = separator >= 0 ? binding.slice(separator + 1) : "";
  if (!new RegExp(`^/proc/${process.pid}/fd/[0-9]+$`, "u").test(source)
    || destination !== expectedDestination) {
    throw new Error(`${label} benoetigt eine exakt zielgebundene, schreibgeschuetzte Authority-FD.`);
  }
}

function t2aAudioSandboxSystemdArguments(
  unitName: string,
  timeoutMs: number,
  terminationGraceMs: number,
  resourceProfile: T2aAudioSandboxResourceProfile,
): string[] {
  const sandbox = t2aAudioSandboxPaths(unitName);
  const runtimeMaxSeconds = Math.ceil(timeoutMs / 1_000) + 5;
  return [
    "-n",
    "/usr/bin/systemd-run",
    "--system",
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    `--unit=${unitName}`,
    `--working-directory=${sandbox.root}`,
    ...evaluatorSandboxProperties(unitName, {
      cpuTopologyRequired: resourceProfile === "quality" || resourceProfile === "independent-ipa",
    }),
    ...evaluatorSandboxInaccessibleProperties(
      unitName,
      t2aAudioSandboxForbiddenHostPaths(resourceProfile),
    ),
    ...evaluatorSandboxNoExecHostProperties(
      unitName,
      t2aAudioSandboxSensitiveNoExecHostPaths(),
    ),
    ...evaluatorSandboxExecutableProperties(
      unitName,
      resourceProfile === "quality" || resourceProfile === "independent-ipa"
        ? [sandbox.python, sandbox.ffmpeg]
        : [sandbox.python],
    ),
    "--property=PassEnvironment=",
    `--property=UnsetEnvironment=${T2A_SANDBOX_UNSET_ENVIRONMENT.join(" ")}`,
    `--property=MemoryMax=${resourceProfile === "quality"
      ? "16G"
      : resourceProfile === "independent-ipa"
        ? "8G"
        : "1G"}`,
    "--property=MemorySwapMax=0",
    "--property=CPUQuota=200%",
    "--property=TasksMax=64",
    "--property=LimitNOFILE=256",
    "--property=LimitFSIZE=1G",
    `--property=RuntimeMaxSec=${runtimeMaxSeconds}s`,
    `--property=TimeoutStopSec=${Math.ceil(terminationGraceMs / 1_000)}s`,
    "--property=KillMode=control-group",
  ];
}

export function buildT2aAudioSandboxArguments(
  unitName: string,
  target: T2aAudioEvaluationTarget,
  bindings: T2aAudioSandboxBindings,
  expectedIndependentIpaObservationSha256: string,
  expectedIpaAdjudicationResultSha256: string,
  timeoutMs: number,
  terminationGraceMs: number,
): string[] {
  const sandbox = t2aAudioSandboxPaths(unitName);
  assertSha256(
    expectedIndependentIpaObservationSha256,
    "Unabhaengiger IPA-Phasendokument-Digest",
  );
  assertSha256(
    expectedIpaAdjudicationResultSha256,
    "IPA-Adjudication-Ergebnis-Digest",
  );
  for (const [name, expectedDestination] of [
    ["worker", sandbox.worker],
    ["dialogueEvaluator", sandbox.dialogueEvaluator],
    ["audio", sandbox.audio],
    ["transcript", sandbox.transcript],
    ["ipaObservation", sandbox.ipaObservation],
    ["ipaAdjudication", sandbox.adjudicationResult],
    ["whisper", sandbox.whisper],
    ["ffmpeg", sandbox.ffmpeg],
    ["runtime", sandbox.runtime],
  ] as const) {
    assertPinnedReadOnlyBinding(bindings[name], expectedDestination, "T2A-Sandbox-Bindung");
  }
  return [
    ...t2aAudioSandboxSystemdArguments(
      unitName,
      timeoutMs,
      terminationGraceMs,
      "quality",
    ),
    bindings.worker,
    bindings.dialogueEvaluator,
    bindings.audio,
    bindings.transcript,
    bindings.ipaObservation,
    bindings.ipaAdjudication,
    bindings.whisper,
    bindings.ffmpeg,
    bindings.runtime,
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    `TMPDIR=${sandbox.root}`,
    "CUDA_VISIBLE_DEVICES=",
    "HF_HUB_OFFLINE=1",
    "TRANSFORMERS_OFFLINE=1",
    "PYTHONNOUSERSITE=1",
    "PYTHONSAFEPATH=1",
    "PYTHONDONTWRITEBYTECODE=1",
    "OMP_NUM_THREADS=2",
    "OPENBLAS_NUM_THREADS=2",
    "HTTP_PROXY=http://127.0.0.1:9",
    "HTTPS_PROXY=http://127.0.0.1:9",
    "ALL_PROXY=http://127.0.0.1:9",
    "NO_PROXY=",
    "no_proxy=",
    sandbox.python,
    "-I",
    "-c",
    PRIVATE_TRANSCRIPT_LOADER,
    sandbox.transcript,
    target.transcriptSnapshotSha256,
    target.dialogueSha256,
    sandbox.worker,
    "--audio",
    sandbox.audio,
    "--expected-audio-sha256",
    target.audioSha256,
    "--independent-ipa-observation",
    sandbox.ipaObservation,
    "--expected-independent-ipa-observation-sha256",
    expectedIndependentIpaObservationSha256,
    "--ipa-adjudication-result",
    sandbox.adjudicationResult,
    "--expected-ipa-adjudication-result-sha256",
    expectedIpaAdjudicationResultSha256,
    "--expected-ipa-adjudicator-runner-sha256",
    T2A_IPA_ADJUDICATOR_RUNNER_SHA256,
    "--expected-ipa-adjudication-policy-sha256",
    T2A_IPA_ADJUDICATION_POLICY_SHA256,
    "--whisper-model",
    sandbox.whisper,
    "--ffmpeg",
    sandbox.ffmpeg,
    "--peak-ceiling-dbfs",
    String(target.peakCeilingDbfs),
  ];
}

export function buildT2aGermanG2pSandboxArguments(
  unitName: string,
  bindings: T2aGermanG2pSandboxBindings,
  expectedRequestSha256: string,
  timeoutMs: number,
  terminationGraceMs: number,
): string[] {
  const sandbox = t2aAudioSandboxPaths(unitName);
  assertSha256(expectedRequestSha256, "German-G2P-Request-Digest");
  for (const [name, expectedDestination] of [
    ["g2pRunner", sandbox.g2pRunner],
    ["g2pRequest", sandbox.g2pRequest],
    ["espeak", sandbox.espeak],
    ["espeakData", sandbox.espeakData],
    ["ipaVocabulary", sandbox.ipaVocabulary],
    ["runtime", sandbox.runtime],
  ] as const) {
    assertPinnedReadOnlyBinding(bindings[name], expectedDestination, "T2A-G2P-Sandbox-Bindung");
  }
  return [
    ...t2aAudioSandboxSystemdArguments(
      unitName,
      timeoutMs,
      terminationGraceMs,
      "german-g2p",
    ),
    bindings.g2pRunner,
    bindings.g2pRequest,
    bindings.espeak,
    bindings.espeakData,
    bindings.ipaVocabulary,
    bindings.runtime,
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    "LANG=C",
    "LC_ALL=C",
    "TZ=UTC",
    `TMPDIR=${sandbox.root}`,
    "CUDA_VISIBLE_DEVICES=",
    "HF_HUB_OFFLINE=1",
    "TRANSFORMERS_OFFLINE=1",
    "PYTHONNOUSERSITE=1",
    "PYTHONSAFEPATH=1",
    "PYTHONDONTWRITEBYTECODE=1",
    "HTTP_PROXY=http://127.0.0.1:9",
    "HTTPS_PROXY=http://127.0.0.1:9",
    "ALL_PROXY=http://127.0.0.1:9",
    "NO_PROXY=",
    "no_proxy=",
    sandbox.python,
    "-I",
    "-c",
    PRIVATE_REQUEST_LOADER,
    sandbox.g2pRequest,
    expectedRequestSha256,
    String(MAX_G2P_REQUEST_BYTES),
    sandbox.g2pRunner,
  ];
}

export function buildT2aIpaAdjudicatorSandboxArguments(
  unitName: string,
  bindings: T2aIpaAdjudicatorSandboxBindings,
  expected: Readonly<{
    requestSha256: string;
    phaseSha256: string;
    referenceSha256: string;
    g2pResultSha256: string;
    runnerSha256: string;
  }>,
  timeoutMs: number,
  terminationGraceMs: number,
): string[] {
  const sandbox = t2aAudioSandboxPaths(unitName);
  for (const [value, label] of [
    [expected.requestSha256, "IPA-Adjudicator-Request-Digest"],
    [expected.phaseSha256, "IPA-Phasendokument-Digest"],
    [expected.referenceSha256, "Referenz-IPA-Digest"],
    [expected.g2pResultSha256, "German-G2P-Ergebnis-Digest"],
    [expected.runnerSha256, "IPA-Adjudicator-Runner-Digest"],
  ] as const) assertSha256(value, label);
  if (expected.runnerSha256 !== T2A_IPA_ADJUDICATOR_RUNNER_SHA256) {
    throw new Error("IPA-Adjudicator-Runner weicht von der Server-Authority ab.");
  }
  for (const [name, expectedDestination] of [
    ["adjudicatorRunner", sandbox.adjudicatorRunner],
    ["adjudicatorRequest", sandbox.adjudicatorRequest],
    ["ipaVocabulary", sandbox.ipaVocabulary],
    ["runtime", sandbox.runtime],
  ] as const) {
    assertPinnedReadOnlyBinding(
      bindings[name],
      expectedDestination,
      "T2A-IPA-Adjudicator-Sandbox-Bindung",
    );
  }
  return [
    ...t2aAudioSandboxSystemdArguments(
      unitName,
      timeoutMs,
      terminationGraceMs,
      "ipa-adjudicator",
    ),
    bindings.adjudicatorRunner,
    bindings.adjudicatorRequest,
    bindings.ipaVocabulary,
    bindings.runtime,
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    "LANG=C",
    "LC_ALL=C",
    "TZ=UTC",
    `TMPDIR=${sandbox.root}`,
    "CUDA_VISIBLE_DEVICES=",
    "HF_HUB_OFFLINE=1",
    "TRANSFORMERS_OFFLINE=1",
    "PYTHONNOUSERSITE=1",
    "PYTHONSAFEPATH=1",
    "PYTHONDONTWRITEBYTECODE=1",
    "HTTP_PROXY=http://127.0.0.1:9",
    "HTTPS_PROXY=http://127.0.0.1:9",
    "ALL_PROXY=http://127.0.0.1:9",
    "NO_PROXY=",
    "no_proxy=",
    sandbox.python,
    "-I",
    "-c",
    PRIVATE_REQUEST_LOADER,
    sandbox.adjudicatorRequest,
    expected.requestSha256,
    String(MAX_ADJUDICATOR_REQUEST_BYTES),
    sandbox.adjudicatorRunner,
    "--expected-runner-sha256",
    expected.runnerSha256,
    "--expected-request-sha256",
    expected.requestSha256,
    "--expected-phase-sha256",
    expected.phaseSha256,
    "--expected-reference-sha256",
    expected.referenceSha256,
    "--expected-g2p-result-sha256",
    expected.g2pResultSha256,
  ];
}

export function buildT2aIndependentIpaSandboxArguments(
  unitName: string,
  target: Pick<T2aAudioEvaluationTarget, "audioSha256">,
  bindings: T2aIndependentIpaSandboxBindings,
  expectedIndependentIpaRunnerSha256: string,
  timeoutMs: number,
  terminationGraceMs: number,
): string[] {
  const sandbox = t2aAudioSandboxPaths(unitName);
  assertSha256(target.audioSha256, "Audio-Snapshot-Digest");
  assertSha256(expectedIndependentIpaRunnerSha256, "IPA-Runner-Digest");
  for (const [name, expectedDestination] of [
    ["worker", sandbox.worker],
    ["ipaRunner", sandbox.ipaRunner],
    ["audio", sandbox.audio],
    ["ipaModel", sandbox.ipaModel],
    ["ffmpeg", sandbox.ffmpeg],
    ["runtime", sandbox.runtime],
  ] as const) {
    assertPinnedReadOnlyBinding(bindings[name], expectedDestination, "T2A-IPA-Sandbox-Bindung");
  }
  return [
    ...t2aAudioSandboxSystemdArguments(
      unitName,
      timeoutMs,
      terminationGraceMs,
      "independent-ipa",
    ),
    bindings.worker,
    bindings.ipaRunner,
    bindings.audio,
    bindings.ipaModel,
    bindings.ffmpeg,
    bindings.runtime,
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    `TMPDIR=${sandbox.root}`,
    "CUDA_VISIBLE_DEVICES=",
    "HF_HUB_OFFLINE=1",
    "TRANSFORMERS_OFFLINE=1",
    "HF_DATASETS_OFFLINE=1",
    "PYTHONNOUSERSITE=1",
    "PYTHONSAFEPATH=1",
    "PYTHONDONTWRITEBYTECODE=1",
    "OMP_NUM_THREADS=2",
    "MKL_NUM_THREADS=2",
    "OPENBLAS_NUM_THREADS=2",
    "TOKENIZERS_PARALLELISM=false",
    "HTTP_PROXY=http://127.0.0.1:9",
    "HTTPS_PROXY=http://127.0.0.1:9",
    "ALL_PROXY=http://127.0.0.1:9",
    "NO_PROXY=",
    "no_proxy=",
    sandbox.python,
    "-I",
    sandbox.worker,
    "--mode",
    "independent-ipa-observation",
    "--audio",
    sandbox.audio,
    "--expected-audio-sha256",
    target.audioSha256,
    "--ffmpeg",
    sandbox.ffmpeg,
    "--independent-ipa-runner",
    sandbox.ipaRunner,
    "--expected-independent-ipa-runner-sha256",
    expectedIndependentIpaRunnerSha256,
    "--independent-ipa-model",
    sandbox.ipaModel,
  ];
}

export function buildT2aAudioSandboxPreflightArguments(
  unitName: string,
  bindings: Pick<T2aAudioSandboxBindings, "ffmpeg" | "runtime">,
  timeoutMs = PREFLIGHT_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
): string[] {
  const sandbox = t2aAudioSandboxPaths(unitName);
  for (const [name, expectedDestination] of [
    ["ffmpeg", sandbox.ffmpeg],
    ["runtime", sandbox.runtime],
  ] as const) {
    assertPinnedReadOnlyBinding(
      bindings[name],
      expectedDestination,
      "T2A-Sandbox-Preflight",
    );
  }
  return [
    ...t2aAudioSandboxSystemdArguments(
      unitName,
      timeoutMs,
      terminationGraceMs,
      "quality",
    ),
    bindings.ffmpeg,
    bindings.runtime,
    "/usr/bin/env",
    "-i",
    "PATH=/usr/bin:/bin",
    "LANG=C.UTF-8",
    "LC_ALL=C.UTF-8",
    "CUDA_VISIBLE_DEVICES=",
    "HF_HUB_OFFLINE=1",
    "TRANSFORMERS_OFFLINE=1",
    "PYTHONNOUSERSITE=1",
    "PYTHONSAFEPATH=1",
    "PYTHONDONTWRITEBYTECODE=1",
    sandbox.python,
    "-I",
    "-c",
    PRIVATE_FFMPEG_PREFLIGHT,
    sandbox.ffmpeg,
  ];
}

export function monitorT2aAudioSandboxProcess(
  child: ChildProcess,
  unitName: string,
  options: {
    timeoutMs: number;
    resultDeadline: number;
    terminationGraceMs: number;
    runtimeTerminalDeadline: number;
    signal?: AbortSignal;
    controlCommand: typeof runControlCommand;
  },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  t2aAudioSandboxPaths(unitName);
  if (!Number.isSafeInteger(options.resultDeadline) || options.resultDeadline <= 0) {
    throw new Error("T2A-Evaluator-Ergebnisdeadline ist ungueltig.");
  }
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let outputOverflow = false;
    let timedOut = false;
    let aborted = false;
    let childFailure: Error | null = null;
    let settled = false;
    let termination: Promise<void> | null = null;
    const stopSandbox = (): Promise<void> => {
      if (!termination) {
        termination = Promise.allSettled([
          stopT2aSandboxUnit(unitName, options.controlCommand, options.runtimeTerminalDeadline),
          terminateProcessGroup(child, options.terminationGraceMs),
        ]).then((results) => {
          const failures = results.filter(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (failures.length > 0) {
            throw new T2aAudioEvaluatorTerminationError(
              `T2A-Sandbox konnte nicht sicher beendet werden: ${failures
              .map((failure) => failure.reason instanceof Error
                ? failure.reason.message
                : String(failure.reason))
              .join("; ")}`,
            );
          }
        });
      }
      return termination;
    };
    let timeout: NodeJS.Timeout | null = null;
    let abortListener: () => void = () => undefined;
    const settle = async (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortListener);
      try {
        if (termination) await termination;
      } catch (terminationError) {
        rejectPromise(terminationError);
        return;
      }
      if (error) rejectPromise(error);
      else resolvePromise({ code, stdout, stderr });
    };
    const stopAndSettle = (error: Error): void => {
      void stopSandbox().then(
        () => {
          void settle(error);
        },
        (terminationError: unknown) => {
          void settle(
            terminationError instanceof Error
              ? terminationError
              : new Error(String(terminationError)),
          );
        },
      );
    };
    const remainingResultBudget = Math.max(0, options.resultDeadline - Date.now());
    timeout = setTimeout(() => {
      timedOut = true;
      stopAndSettle(new Error(
        "T2A-Audio-Evaluator ueberschritt seine absolute Ergebnisdeadline.",
      ));
    }, Math.min(options.timeoutMs, remainingResultBudget));
    timeout.unref();
    abortListener = () => {
      aborted = true;
      stopAndSettle(new T2aAudioEvaluatorCancelledError());
    };
    options.signal?.addEventListener("abort", abortListener, { once: true });
    if (options.signal?.aborted) abortListener();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        outputOverflow = true;
        stdout = "";
        stopAndSettle(new Error("T2A-Audio-Evaluator-Ausgabe ueberschritt das Groessenlimit."));
        return;
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundedAppend(stderr, Buffer.from(stderrDecoder.write(chunk), "utf8"), MAX_STDERR_BYTES);
    });
    child.once("error", (error) => {
      childFailure = error;
      stopAndSettle(error);
    });
    child.once("close", (code, signal) => {
      if (!outputOverflow) stdout += stdoutDecoder.end();
      stderr = boundedAppend(stderr, Buffer.from(stderrDecoder.end(), "utf8"), MAX_STDERR_BYTES);
      if (aborted) return void settle(new T2aAudioEvaluatorCancelledError());
      if (timedOut) {
        return void settle(new Error(
          "T2A-Audio-Evaluator ueberschritt seine absolute Ergebnisdeadline.",
        ));
      }
      if (Date.now() >= options.resultDeadline) {
        timedOut = true;
        return void stopAndSettle(new Error(
          "T2A-Audio-Evaluator lieferte sein Ergebnis erst nach der absoluten Deadline.",
        ));
      }
      if (outputOverflow) {
        return void settle(new Error("T2A-Audio-Evaluator-Ausgabe ueberschritt das Groessenlimit."));
      }
      if (childFailure) return void stopAndSettle(childFailure);
      if (signal) {
        return void stopAndSettle(
          new Error(`T2A-Audio-Evaluator endete durch Signal ${signal}.`),
        );
      }
      if (code !== 0 && code !== 2) {
        return void stopAndSettle(new Error(
          `T2A-Audio-Evaluator endete mit Code ${code ?? "?"}: ${stderr.slice(-1_000)}`,
        ));
      }
      void settle(undefined, code);
    });
  });
}

export type T2aAudioSandboxPreflightOptions = {
  timeoutMs?: number;
  terminationGraceMs?: number;
  spawnProcess?: typeof spawn;
  controlCommand?: typeof runControlCommand;
};

export async function preflightT2aAudioEvaluatorSandbox(
  options: T2aAudioSandboxPreflightOptions = {},
): Promise<{
  evaluatorFingerprint: string;
  claimScope: T2aAudioClaimScope;
}> {
  const timeoutMs = options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
    || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0
    || terminationGraceMs > MAX_TERMINATION_GRACE_MS) {
    throw new Error("T2A-Preflight-Zeitgrenzen muessen positive ganze Millisekunden sein.");
  }
  const resultDeadline = Date.now() + timeoutMs;
  if (!Number.isSafeInteger(resultDeadline)) {
    throw new Error("T2A-Preflight-Ergebnisdeadline liegt ausserhalb des sicheren Bereichs.");
  }
  const remainingBudget = (): number => {
    const remaining = resultDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error("T2A-Sandbox-Preflight ueberschritt seine absolute Ergebnisdeadline.");
    }
    return remaining;
  };
  const authority = getT2aAudioEvaluatorAuthorityState();
  remainingBudget();
  const independentIpaAuthority = getT2aIndependentIpaAuthorityState();
  remainingBudget();
  const pronunciationAuthority = getT2aPronunciationAuthorityState();
  remainingBudget();
  const pinned = openPinnedPaths([...authority.pinnedPaths]);
  const independentIpaPinned = openPinnedPaths([...independentIpaAuthority.pinnedPaths]);
  const pronunciationPinned = openPinnedPaths([...pronunciationAuthority.pinnedPaths]);
  try {
    verifyAuthorityPins(authority, pinned);
    verifyIndependentIpaAuthorityPins(independentIpaAuthority, independentIpaPinned);
    verifyPronunciationAuthorityPins(pronunciationAuthority, pronunciationPinned);
    const executionBudgetMs = remainingBudget();
    const unitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${randomUUID()}`;
    const sandbox = t2aAudioSandboxPaths(unitName);
    const child = (options.spawnProcess ?? spawn)("/usr/bin/sudo", [
      ...buildT2aAudioSandboxPreflightArguments(
        unitName,
        {
          ffmpeg: pinned.bindReadOnlyProperty(authority.paths.ffmpegExecutable, sandbox.ffmpeg),
          runtime: pinned.bindReadOnlyProperty(authority.paths.runtimeRoot, sandbox.runtime),
        },
        executionBudgetMs,
        terminationGraceMs,
      ),
    ], {
      cwd: appRoot,
      detached: true,
      env: { PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const execution = await monitorT2aAudioSandboxProcess(child, unitName, {
      timeoutMs: executionBudgetMs,
      resultDeadline,
      terminationGraceMs,
      runtimeTerminalDeadline: resultDeadline + terminationGraceMs + 7_000,
      controlCommand: options.controlCommand ?? runControlCommand,
    });
    remainingBudget();
    if (execution.code !== 0 || !/^ffmpeg version [^\r\n]+/u.test(execution.stdout)) {
      throw new Error("T2A-Sandbox-Preflight konnte den gebundenen FFmpeg-Pfad nicht ausfuehren.");
    }
    verifyAuthorityPins(authority, pinned);
    verifyIndependentIpaAuthorityPins(independentIpaAuthority, independentIpaPinned);
    verifyPronunciationAuthorityPins(pronunciationAuthority, pronunciationPinned);
    remainingBudget();
    return {
      evaluatorFingerprint: combinedT2aAudioEvaluatorFingerprint(
        authority,
        independentIpaAuthority,
        pronunciationAuthority,
      ),
      claimScope: authority.claimScope,
    };
  } finally {
    pronunciationPinned.close();
    independentIpaPinned.close();
    pinned.close();
  }
}

export async function runT2aAudioEvaluator(
  target: T2aAudioEvaluationTarget,
  options: T2aAudioEvaluatorOptions = {},
): Promise<{
  result: T2aAudioQuality;
  evaluatorFingerprint: string;
  claimScope: T2aAudioClaimScope;
}> {
  if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
  assertSha256(target.audioSha256, "Audio-Snapshot-Digest");
  assertSha256(target.transcriptSnapshotSha256, "Dialog-Snapshot-Digest");
  assertSha256(target.dialogueSha256, "Dialog-Digest");
  if (!Number.isFinite(target.peakCeilingDbfs)
    || target.peakCeilingDbfs < -60
    || target.peakCeilingDbfs > 0) {
    throw new Error("T2A-Peak-Policy liegt ausserhalb des erlaubten Bereichs.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS
    || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0
    || terminationGraceMs > MAX_TERMINATION_GRACE_MS) {
    throw new Error("T2A-Evaluator-Zeitgrenzen muessen positive ganze Millisekunden sein.");
  }
  const commonDeadline = Date.now() + timeoutMs;
  if (!Number.isSafeInteger(commonDeadline)) {
    throw new Error("T2A-Evaluator-Ergebnisdeadline liegt ausserhalb des sicheren Bereichs.");
  }
  const remainingBudget = (phase: string): number => {
    const remaining = commonDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`T2A-Audio-Evaluator hat ${phase} sein Gesamtzeitlimit erreicht.`);
    }
    return remaining;
  };
  const authority = getT2aAudioEvaluatorAuthorityState();
  remainingBudget("bei der Quality-Authority-Aufloesung");
  const independentIpaAuthority = getT2aIndependentIpaAuthorityState();
  remainingBudget("bei der IPA-Authority-Aufloesung");
  const pronunciationAuthority = getT2aPronunciationAuthorityState();
  remainingBudget("bei der Aussprache-Authority-Aufloesung");
  if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
  await recoverT2aAudioSandboxUnits(options.controlCommand, commonDeadline);
  remainingBudget("bei der Sandbox-Recovery");
  if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
  const pinned = openPinnedPaths([...authority.pinnedPaths]);
  const independentIpaPinned = openPinnedPaths([...independentIpaAuthority.pinnedPaths]);
  const pronunciationPinned = openPinnedPaths([...pronunciationAuthority.pinnedPaths]);
  const audioRevision = capturePinnedPathRevision(target.audioSnapshotPath, "file");
  const transcriptRevision = capturePinnedPathRevision(target.transcriptSnapshotPath, "file");
  const snapshotsPinned = openPinnedPaths([audioRevision, transcriptRevision]);
  let independentIpaPhasePinned: ReturnType<typeof openPinnedPaths> | null = null;
  let g2pRequestPinned: ReturnType<typeof openPinnedPaths> | null = null;
  let adjudicatorRequestPinned: ReturnType<typeof openPinnedPaths> | null = null;
  let ipaAdjudicationResultPinned: ReturnType<typeof openPinnedPaths> | null = null;
  try {
    verifyAuthorityPins(authority, pinned);
    verifyIndependentIpaAuthorityPins(independentIpaAuthority, independentIpaPinned);
    verifyPronunciationAuthorityPins(pronunciationAuthority, pronunciationPinned);
    if (snapshotsPinned.sha256(target.audioSnapshotPath, 256 * 1024 * 1024)
        !== target.audioSha256
      || snapshotsPinned.sha256(target.transcriptSnapshotPath, MAX_TRANSCRIPT_BYTES)
        !== target.transcriptSnapshotSha256) {
      throw new Error("Privater T2A-Audio-Snapshot stimmt nicht mit der Output-Authority ueberein.");
    }
    remainingBudget("bei der Snapshot- und Authority-Verifikation");
    const independentIpaUnitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${randomUUID()}`;
    const independentIpaSandbox = t2aAudioSandboxPaths(independentIpaUnitName);
    if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
    const independentIpaTimeoutMs = Math.min(
      INDEPENDENT_IPA_TIMEOUT_MS,
      remainingBudget("vor der unabhaengigen IPA-Phase"),
    );
    const independentIpaRuntimeMaxSeconds = Math.ceil(independentIpaTimeoutMs / 1_000) + 5;
    const independentIpaResultDeadline = Math.min(
      commonDeadline,
      Date.now() + independentIpaTimeoutMs,
    );
    const independentIpaRuntimeTerminalDeadline = Math.min(
      commonDeadline,
      Date.now() + independentIpaRuntimeMaxSeconds * 1_000,
    ) + terminationGraceMs + 7_000;
    const command = "/usr/bin/sudo";
    const independentIpaArgs = buildT2aIndependentIpaSandboxArguments(
      independentIpaUnitName,
      target,
      {
        worker: pinned.bindReadOnlyProperty(
          authority.paths.workerScript,
          independentIpaSandbox.worker,
        ),
        ipaRunner: independentIpaPinned.bindReadOnlyProperty(
          independentIpaAuthority.runnerPath,
          independentIpaSandbox.ipaRunner,
        ),
        audio: snapshotsPinned.bindReadOnlyProperty(
          target.audioSnapshotPath,
          independentIpaSandbox.audio,
        ),
        ipaModel: independentIpaPinned.bindReadOnlyProperty(
          independentIpaAuthority.modelDirectory,
          independentIpaSandbox.ipaModel,
        ),
        ffmpeg: pinned.bindReadOnlyProperty(
          authority.paths.ffmpegExecutable,
          independentIpaSandbox.ffmpeg,
        ),
        runtime: pinned.bindReadOnlyProperty(
          authority.paths.runtimeRoot,
          independentIpaSandbox.runtime,
        ),
      },
      independentIpaAuthority.runnerSha256,
      independentIpaTimeoutMs,
      terminationGraceMs,
    );
    remainingBudget("beim Aufbau der unabhaengigen IPA-Phase");
    const independentIpaChild = (options.spawnProcess ?? spawn)(command, independentIpaArgs, {
      cwd: appRoot,
      detached: true,
      env: { PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const independentIpaExecution = await monitorT2aAudioSandboxProcess(
      independentIpaChild,
      independentIpaUnitName,
      {
        timeoutMs: independentIpaTimeoutMs,
        resultDeadline: independentIpaResultDeadline,
        terminationGraceMs,
        runtimeTerminalDeadline: independentIpaRuntimeTerminalDeadline,
        signal: options.signal,
        controlCommand: options.controlCommand ?? runControlCommand,
      },
    );
    remainingBudget("nach der unabhaengigen IPA-Phase");
    const parsedIndependentIpaPhase = parseIndependentIpaPhaseExecution(
      independentIpaExecution,
      {
        authorityAudioSha256: target.audioSha256,
        runnerSha256: independentIpaAuthority.runnerSha256,
        modelManifestSha256: independentIpaAuthority.modelManifestSha256,
        modelWeightSha256: independentIpaAuthority.modelWeightSha256,
      },
    );
    if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
    snapshotsPinned.verifyUnchanged();
    verifyAuthorityPins(authority, pinned);
    verifyIndependentIpaAuthorityPins(independentIpaAuthority, independentIpaPinned);
    const materializedIndependentIpaPhase = materializeIndependentIpaPhaseObservation({
      audioSnapshotPath: target.audioSnapshotPath,
      transcriptSnapshotPath: target.transcriptSnapshotPath,
      execution: parsedIndependentIpaPhase,
    });
    independentIpaPhasePinned = openPinnedPaths([materializedIndependentIpaPhase.revision]);
    if (independentIpaPhasePinned.sha256(
      materializedIndependentIpaPhase.path,
      MAX_STDOUT_BYTES,
    ) !== materializedIndependentIpaPhase.sha256) {
      throw new Error("Materialisierte unabhaengige IPA-Phase besitzt einen falschen Digest.");
    }
    remainingBudget("bei der IPA-Phasenmaterialisierung");

    let transcriptEnvelope: unknown;
    try {
      const transcriptBytes = readFileSync(
        snapshotsPinned.sourcePath(target.transcriptSnapshotPath),
      );
      const transcriptText = new TextDecoder("utf-8", { fatal: true }).decode(transcriptBytes);
      transcriptEnvelope = JSON.parse(transcriptText) as unknown;
    } catch (error) {
      throw new Error(`Privater T2A-Dialog-Snapshot ist kein gueltiges UTF-8-JSON: ${String(error)}`);
    }
    if (transcriptEnvelope === null
      || Array.isArray(transcriptEnvelope)
      || typeof transcriptEnvelope !== "object"
      || Object.keys(transcriptEnvelope).sort().join(",") !== "schemaVersion,text") {
      throw new Error("Privater T2A-Dialog-Snapshot besitzt kein eindeutiges Envelope.");
    }
    const privateTranscript = transcriptEnvelope as Record<string, unknown>;
    if (privateTranscript.schemaVersion !== "ltx-studio-private-transcript.v1"
      || typeof privateTranscript.text !== "string"
      || createHash("sha256").update(privateTranscript.text, "utf8").digest("hex")
        !== target.dialogueSha256) {
      throw new Error("Privater T2A-Dialog-Snapshot widerspricht der Zieltext-Authority.");
    }

    const g2pRequest: T2aGermanG2pRequest = buildT2aGermanG2pRequest({
      targetText: privateTranscript.text,
      g2pRunnerSha256: pronunciationAuthority.g2pRunnerSha256,
      dataManifest: pronunciationAuthority.dataManifest,
      runtimeManifest: pronunciationAuthority.runtimeManifest,
    });
    if (g2pRequest.targetTextSha256 !== target.dialogueSha256) {
      throw new Error("German-G2P-Request bindet nicht den autorisierten Zieltext.");
    }
    const g2pRequestCanonicalJson = canonicalJson(g2pRequest);
    const materializedG2pRequest = materializeT2aPrivatePhaseRequest({
      audioSnapshotPath: target.audioSnapshotPath,
      transcriptSnapshotPath: target.transcriptSnapshotPath,
      basename: T2A_GERMAN_G2P_REQUEST_BASENAME,
      canonicalJson: g2pRequestCanonicalJson,
      maximumBytes: MAX_G2P_REQUEST_BYTES,
    });
    g2pRequestPinned = openPinnedPaths([materializedG2pRequest.revision]);
    if (g2pRequestPinned.sha256(materializedG2pRequest.path, MAX_G2P_REQUEST_BYTES)
        !== materializedG2pRequest.sha256) {
      throw new Error("Materialisierter German-G2P-Request besitzt einen falschen Digest.");
    }
    let g2pUnitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${randomUUID()}`;
    while (g2pUnitName === independentIpaUnitName) {
      g2pUnitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${randomUUID()}`;
    }
    const g2pSandbox = t2aAudioSandboxPaths(g2pUnitName);
    if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
    const g2pTimeoutMs = Math.min(
      GERMAN_G2P_TIMEOUT_MS,
      remainingBudget("vor der privaten German-G2P-Phase"),
    );
    const g2pResultDeadline = Math.min(commonDeadline, Date.now() + g2pTimeoutMs);
    const g2pRuntimeTerminalDeadline = g2pResultDeadline + terminationGraceMs + 12_000;
    const g2pArgs = buildT2aGermanG2pSandboxArguments(
      g2pUnitName,
      {
        g2pRunner: pronunciationPinned.bindReadOnlyProperty(
          pronunciationAuthority.g2pRunnerPath,
          g2pSandbox.g2pRunner,
        ),
        g2pRequest: g2pRequestPinned.bindReadOnlyProperty(
          materializedG2pRequest.path,
          g2pSandbox.g2pRequest,
        ),
        espeak: pronunciationPinned.bindReadOnlyProperty(
          T2A_GERMAN_G2P_ESPEAK_PATH,
          g2pSandbox.espeak,
        ),
        espeakData: pronunciationPinned.bindReadOnlyProperty(
          T2A_GERMAN_G2P_DATA_ROOT,
          g2pSandbox.espeakData,
        ),
        ipaVocabulary: pronunciationPinned.bindReadOnlyProperty(
          T2A_GERMAN_G2P_VOCAB_PATH,
          g2pSandbox.ipaVocabulary,
        ),
        runtime: pinned.bindReadOnlyProperty(authority.paths.runtimeRoot, g2pSandbox.runtime),
      },
      materializedG2pRequest.sha256,
      g2pTimeoutMs,
      terminationGraceMs,
    );
    const g2pChild = (options.spawnProcess ?? spawn)(command, g2pArgs, {
      cwd: appRoot,
      detached: true,
      env: { PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const g2pExecution = await monitorT2aAudioSandboxProcess(g2pChild, g2pUnitName, {
      timeoutMs: g2pTimeoutMs,
      resultDeadline: g2pResultDeadline,
      terminationGraceMs,
      runtimeTerminalDeadline: g2pRuntimeTerminalDeadline,
      signal: options.signal,
      controlCommand: options.controlCommand ?? runControlCommand,
    });
    const g2pContractExecution = {
      status: g2pExecution.code,
      signal: null,
      stdout: Buffer.from(g2pExecution.stdout, "utf8"),
      stderr: Buffer.from(g2pExecution.stderr, "utf8"),
    } as const;
    const g2pResult = parseT2aGermanG2pExecution(g2pContractExecution, g2pRequest);
    if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
    g2pRequestPinned.verifyUnchanged();
    snapshotsPinned.verifyUnchanged();
    verifyAuthorityPins(authority, pinned);
    verifyIndependentIpaAuthorityPins(independentIpaAuthority, independentIpaPinned);
    verifyPronunciationAuthorityPins(pronunciationAuthority, pronunciationPinned);
    remainingBudget("nach der privaten German-G2P-Phase");

    const referenceBuild = buildT2aReferenceIpaDocument({
      phase: parsedIndependentIpaPhase.phase,
      g2pRequest,
      g2pExecution: g2pContractExecution,
      adjudicatorRunnerSha256: pronunciationAuthority.adjudicatorRunnerSha256,
    });
    const phaseCanonicalJson = parsedIndependentIpaPhase.canonicalBytes.toString("utf8");
    const referenceCanonicalJson = canonicalJson(referenceBuild.reference);
    const referenceSha256 = createHash("sha256")
      .update(referenceCanonicalJson, "utf8")
      .digest("hex");
    const g2pResultCanonicalJson = referenceBuild.g2pResultCanonicalJson;
    if (g2pResultCanonicalJson !== t2aGermanG2pResultCanonicalJson(g2pResult)) {
      throw new Error("German-G2P-Ergebnis ist zwischen Referenzaufbau und Authority abgewichen.");
    }
    const g2pResultSha256 = createHash("sha256")
      .update(g2pResultCanonicalJson, "utf8")
      .digest("hex");
    const adjudicationOptions = {
      phaseCanonicalJson,
      referenceCanonicalJson,
      g2pResultCanonicalJson,
      phaseSha256: materializedIndependentIpaPhase.sha256,
      referenceSha256,
      runnerSha256: pronunciationAuthority.adjudicatorRunnerSha256,
      policySha256: T2A_IPA_ADJUDICATION_POLICY_SHA256,
      g2pRunnerSha256: pronunciationAuthority.g2pRunnerSha256,
      espeakBinarySha256: T2A_GERMAN_G2P_ESPEAK_BINARY_SHA256,
      espeakDataManifestSha256: T2A_GERMAN_G2P_ESPEAK_DATA_MANIFEST_SHA256,
      espeakRuntimeManifestSha256: T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
      ipaVocabularySha256: T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
      normalizationPolicySha256: T2A_GERMAN_G2P_NORMALIZATION_POLICY_SHA256,
      targetTextSha256: g2pResult.targetTextSha256,
      normalizedTargetTextSha256: g2pResult.normalizedTargetTextSha256,
      espeakStdoutSha256: g2pResult.espeakStdoutSha256,
      g2pResultSha256,
    } as const;
    const expectedIpaAdjudication = adjudicateT2aIpa(adjudicationOptions);
    const adjudicatorRequest = buildT2aIpaAdjudicatorRequest(adjudicationOptions);
    const adjudicatorRequestCanonicalJson = canonicalJson(adjudicatorRequest);
    const materializedAdjudicatorRequest = materializeT2aPrivatePhaseRequest({
      audioSnapshotPath: target.audioSnapshotPath,
      transcriptSnapshotPath: target.transcriptSnapshotPath,
      basename: T2A_IPA_ADJUDICATOR_REQUEST_BASENAME,
      canonicalJson: adjudicatorRequestCanonicalJson,
      maximumBytes: MAX_ADJUDICATOR_REQUEST_BYTES,
    });
    adjudicatorRequestPinned = openPinnedPaths([materializedAdjudicatorRequest.revision]);
    if (adjudicatorRequestPinned.sha256(
      materializedAdjudicatorRequest.path,
      MAX_ADJUDICATOR_REQUEST_BYTES,
    ) !== materializedAdjudicatorRequest.sha256) {
      throw new Error("Materialisierter IPA-Adjudicator-Request besitzt einen falschen Digest.");
    }
    let adjudicatorUnitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${randomUUID()}`;
    while ([independentIpaUnitName, g2pUnitName].includes(adjudicatorUnitName)) {
      adjudicatorUnitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${randomUUID()}`;
    }
    const adjudicatorSandbox = t2aAudioSandboxPaths(adjudicatorUnitName);
    if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
    const adjudicatorTimeoutMs = Math.min(
      IPA_ADJUDICATOR_TIMEOUT_MS,
      remainingBudget("vor der getrennten IPA-Adjudicator-Phase"),
    );
    const adjudicatorResultDeadline = Math.min(
      commonDeadline,
      Date.now() + adjudicatorTimeoutMs,
    );
    const adjudicatorRuntimeTerminalDeadline =
      adjudicatorResultDeadline + terminationGraceMs + 12_000;
    const adjudicatorArgs = buildT2aIpaAdjudicatorSandboxArguments(
      adjudicatorUnitName,
      {
        adjudicatorRunner: pronunciationPinned.bindReadOnlyProperty(
          pronunciationAuthority.adjudicatorRunnerPath,
          adjudicatorSandbox.adjudicatorRunner,
        ),
        adjudicatorRequest: adjudicatorRequestPinned.bindReadOnlyProperty(
          materializedAdjudicatorRequest.path,
          adjudicatorSandbox.adjudicatorRequest,
        ),
        ipaVocabulary: pronunciationPinned.bindReadOnlyProperty(
          T2A_GERMAN_G2P_VOCAB_PATH,
          adjudicatorSandbox.ipaVocabulary,
        ),
        runtime: pinned.bindReadOnlyProperty(
          authority.paths.runtimeRoot,
          adjudicatorSandbox.runtime,
        ),
      },
      {
        requestSha256: materializedAdjudicatorRequest.sha256,
        phaseSha256: materializedIndependentIpaPhase.sha256,
        referenceSha256,
        g2pResultSha256,
        runnerSha256: pronunciationAuthority.adjudicatorRunnerSha256,
      },
      adjudicatorTimeoutMs,
      terminationGraceMs,
    );
    const adjudicatorChild = (options.spawnProcess ?? spawn)(command, adjudicatorArgs, {
      cwd: appRoot,
      detached: true,
      env: { PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const adjudicatorExecution = await monitorT2aAudioSandboxProcess(
      adjudicatorChild,
      adjudicatorUnitName,
      {
        timeoutMs: adjudicatorTimeoutMs,
        resultDeadline: adjudicatorResultDeadline,
        terminationGraceMs,
        runtimeTerminalDeadline: adjudicatorRuntimeTerminalDeadline,
        signal: options.signal,
        controlCommand: options.controlCommand ?? runControlCommand,
      },
    );
    const parsedIpaAdjudication = parseT2aIpaAdjudicationExecution(
      adjudicatorExecution,
      expectedIpaAdjudication,
    );
    if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
    const materializedIpaAdjudication = materializeT2aIpaAdjudicationResult({
      audioSnapshotPath: target.audioSnapshotPath,
      transcriptSnapshotPath: target.transcriptSnapshotPath,
      execution: parsedIpaAdjudication,
    });
    ipaAdjudicationResultPinned = openPinnedPaths([materializedIpaAdjudication.revision]);
    if (ipaAdjudicationResultPinned.sha256(
      materializedIpaAdjudication.path,
      MAX_STDOUT_BYTES,
    ) !== materializedIpaAdjudication.sha256) {
      throw new Error("Materialisiertes IPA-Adjudication-Ergebnis besitzt einen falschen Digest.");
    }
    adjudicatorRequestPinned.verifyUnchanged();
    g2pRequestPinned.verifyUnchanged();
    independentIpaPhasePinned.verifyUnchanged();
    snapshotsPinned.verifyUnchanged();
    verifyAuthorityPins(authority, pinned);
    verifyIndependentIpaAuthorityPins(independentIpaAuthority, independentIpaPinned);
    verifyPronunciationAuthorityPins(pronunciationAuthority, pronunciationPinned);
    remainingBudget("nach der getrennten IPA-Adjudicator-Phase");

    let qualityUnitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${randomUUID()}`;
    while ([independentIpaUnitName, g2pUnitName, adjudicatorUnitName].includes(qualityUnitName)) {
      qualityUnitName = `${T2A_AUDIO_SANDBOX_UNIT_PREFIX}-${randomUUID()}`;
    }
    const qualitySandbox = t2aAudioSandboxPaths(qualityUnitName);
    if (options.signal?.aborted) throw new T2aAudioEvaluatorCancelledError();
    const qualityTimeoutMs = remainingBudget("vor der zielgebundenen Qualitaetsphase");
    const qualityRuntimeMaxSeconds = Math.ceil(qualityTimeoutMs / 1_000) + 5;
    const qualityRuntimeTerminalDeadline = Math.min(
      commonDeadline,
      Date.now() + qualityRuntimeMaxSeconds * 1_000,
    ) + terminationGraceMs + 7_000;
    const qualityArgs = buildT2aAudioSandboxArguments(qualityUnitName, target, {
      worker: pinned.bindReadOnlyProperty(authority.paths.workerScript, qualitySandbox.worker),
      dialogueEvaluator: pinned.bindReadOnlyProperty(
        authority.paths.dialogueEvaluatorScript,
        qualitySandbox.dialogueEvaluator,
      ),
      audio: snapshotsPinned.bindReadOnlyProperty(
        target.audioSnapshotPath,
        qualitySandbox.audio,
      ),
      transcript: snapshotsPinned.bindReadOnlyProperty(
        target.transcriptSnapshotPath,
        qualitySandbox.transcript,
      ),
      ipaObservation: independentIpaPhasePinned.bindReadOnlyProperty(
        materializedIndependentIpaPhase.path,
        qualitySandbox.ipaObservation,
      ),
      ipaAdjudication: ipaAdjudicationResultPinned.bindReadOnlyProperty(
        materializedIpaAdjudication.path,
        qualitySandbox.adjudicationResult,
      ),
      whisper: pinned.bindReadOnlyProperty(authority.paths.whisperModel, qualitySandbox.whisper),
      ffmpeg: pinned.bindReadOnlyProperty(authority.paths.ffmpegExecutable, qualitySandbox.ffmpeg),
      runtime: pinned.bindReadOnlyProperty(authority.paths.runtimeRoot, qualitySandbox.runtime),
    },
    materializedIndependentIpaPhase.sha256,
    materializedIpaAdjudication.sha256,
    qualityTimeoutMs,
    terminationGraceMs);
    remainingBudget("beim Aufbau der zielgebundenen Qualitaetsphase");
    const qualityChild = (options.spawnProcess ?? spawn)(command, qualityArgs, {
      cwd: appRoot,
      detached: true,
      env: { PATH: "/usr/bin:/bin" },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await monitorT2aAudioSandboxProcess(qualityChild, qualityUnitName, {
      timeoutMs: qualityTimeoutMs,
      resultDeadline: commonDeadline,
      terminationGraceMs,
      runtimeTerminalDeadline: qualityRuntimeTerminalDeadline,
      signal: options.signal,
      controlCommand: options.controlCommand ?? runControlCommand,
    });
    remainingBudget("nach der zielgebundenen Qualitaetsphase");
    const lines = result.stdout.trim().split(/\r?\n/u);
    if (lines.length !== 1 || !lines[0]) {
      throw new Error("T2A-Audio-Evaluator lieferte nicht genau ein JSON-Dokument.");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(lines[0]);
    } catch (error) {
      throw new Error(`T2A-Audio-Evaluator lieferte ungueltiges JSON: ${String(error)}`);
    }
    const resultDocument = t2aAudioQualitySchema.parse(parsedJson);
    if ((result.code === 0) !== (resultDocument.analysisStatus === "measured")) {
      throw new Error("T2A-Audio-Evaluator-Exitcode und Ergebnisstatus widersprechen einander.");
    }
    assertResultBinding(
      resultDocument,
      target,
      authority,
      parsedIndependentIpaPhase,
      parsedIpaAdjudication,
      pronunciationAuthority,
    );
    ipaAdjudicationResultPinned.verifyUnchanged();
    adjudicatorRequestPinned.verifyUnchanged();
    g2pRequestPinned.verifyUnchanged();
    independentIpaPhasePinned.verifyUnchanged();
    snapshotsPinned.verifyUnchanged();
    verifyAuthorityPins(authority, pinned);
    verifyIndependentIpaAuthorityPins(independentIpaAuthority, independentIpaPinned);
    verifyPronunciationAuthorityPins(pronunciationAuthority, pronunciationPinned);
    remainingBudget("vor der Ergebnisannahme");
    return {
      result: resultDocument,
      evaluatorFingerprint: combinedT2aAudioEvaluatorFingerprint(
        authority,
        independentIpaAuthority,
        pronunciationAuthority,
      ),
      claimScope: authority.claimScope,
    };
  } finally {
    ipaAdjudicationResultPinned?.close();
    adjudicatorRequestPinned?.close();
    g2pRequestPinned?.close();
    independentIpaPhasePinned?.close();
    snapshotsPinned.close();
    independentIpaPinned.close();
    pronunciationPinned.close();
    pinned.close();
  }
}
