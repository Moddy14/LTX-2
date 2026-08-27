import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { canonicalJson } from "../shared/canonicalJson.js";
import {
  INDEPENDENT_IPA_DECODER_POLICY,
  INDEPENDENT_IPA_FFMPEG_SHA256,
  INDEPENDENT_IPA_METHOD,
  INDEPENDENT_IPA_NORMALIZATION_METHOD,
  INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
  INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
  parseIndependentIpaPhase,
  type IndependentIpaPhase,
} from "../shared/independentIpa.js";
import {
  T2A_AUDIO_QUALITY_SCHEMA_VERSION,
  T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
} from "../shared/t2aAudioQuality.js";
import {
  adjudicateT2aIpa,
  t2aIpaAdjudicationCanonicalJson,
  t2aIpaAdjudicatorRequestSchema,
} from "../shared/t2aIpaAdjudication.js";
import { analysisPythonExecutable, appRoot, dataRoot } from "../server/config.js";
import {
  T2A_AUDIO_EVALUATOR_REVISION,
  T2A_AUDIO_SANDBOX_UNIT_PREFIX,
  T2aAudioEvaluatorCancelledError,
  getT2aAudioEvaluatorAuthorityState,
  getT2aIndependentIpaAuthorityState,
  getT2aPronunciationAuthorityState,
  resolveT2aAudioEvaluatorBinding,
  runT2aAudioEvaluator,
  t2aAudioSandboxPaths,
  type T2aAudioEvaluationTarget,
  type T2aAudioEvaluatorOptions,
} from "../server/t2aAudioEvaluator.js";

type SpawnRecord = {
  command: string;
  args: string[];
  unitName: string;
  phase: "ipa" | "g2p" | "adjudicator" | "quality";
  options: {
    cwd: unknown;
    detached: unknown;
    shell: unknown;
    stdio: unknown;
    env: unknown;
  };
};

type Harness = {
  events: string[];
  spawns: SpawnRecord[];
  controlCommand: NonNullable<T2aAudioEvaluatorOptions["controlCommand"]>;
  spawnProcess: NonNullable<T2aAudioEvaluatorOptions["spawnProcess"]>;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function failedQualityDocument(): string {
  return JSON.stringify({
    schemaVersion: T2A_AUDIO_QUALITY_SCHEMA_VERSION,
    mediaKind: "audio",
    analysisKind: "t2a-audio-qa",
    analysisStatus: "failed",
    error: {
      code: "internal-error",
      message: "synthetic fail-closed quality result",
    },
    ia2vEligibility: {
      schemaVersion: T2A_IA2V_ELIGIBILITY_SCHEMA_VERSION,
      status: "blocked",
      blockers: ["analysis-failed"],
    },
  });
}

async function createTarget(name: string): Promise<T2aAudioEvaluationTarget> {
  const root = join(dataRoot, name);
  await mkdir(root, { mode: 0o700 });
  await chmod(root, 0o700);
  const audioSnapshotPath = join(root, "authority.wav");
  const transcriptSnapshotPath = join(root, "transcript.utf8");
  const audio = Buffer.alloc(64);
  audio.write("RIFF", 0, "ascii");
  audio.writeUInt32LE(56, 4);
  audio.write("WAVEfmt ", 8, "ascii");
  const transcriptText = "Hallo Welt";
  const transcript = Buffer.from(`${JSON.stringify({
    schemaVersion: "ltx-studio-private-transcript.v1",
    text: transcriptText,
  })}\n`, "utf8");
  await writeFile(audioSnapshotPath, audio, { mode: 0o444, flag: "wx" });
  await writeFile(transcriptSnapshotPath, transcript, { mode: 0o444, flag: "wx" });
  await chmod(audioSnapshotPath, 0o444);
  await chmod(transcriptSnapshotPath, 0o444);
  return {
    audioSnapshotPath,
    transcriptSnapshotPath,
    transcriptSnapshotSha256: sha256(transcript),
    audioSha256: sha256(audio),
    dialogueSha256: sha256(transcriptText),
    peakCeilingDbfs: -3,
  };
}

function measuredIpaPhase(target: T2aAudioEvaluationTarget): {
  parsed: IndependentIpaPhase;
  deliberatelyNonCanonicalJson: string;
  canonicalBytes: string;
  canonicalSha256: string;
} {
  const authority = getT2aIndependentIpaAuthorityState();
  const normalizedAudioSha256 = sha256("normalized-audio-fixture");
  const observation = {
    schemaVersion: INDEPENDENT_IPA_OBSERVATION_SCHEMA_VERSION,
    status: "measured" as const,
    error: null,
    method: INDEPENDENT_IPA_METHOD,
    decoderPolicy: INDEPENDENT_IPA_DECODER_POLICY,
    targetConditioned: false as const,
    runnerSha256: authority.runnerSha256,
    executionBoundary: {
      cpuOnly: true as const,
      ipSocketFamiliesBlocked: ["AF_INET", "AF_INET6"] as const,
      blockedNetworkErrno: 97 as const,
      noNewPrivileges: true as const,
      effectiveCapabilities: "0000000000000000" as const,
      memoryMaxBytes: 8 * 1024 ** 3,
      minimumCgroupHeadroomBytes: 6 * 1024 ** 3,
      swapMaxBytes: 0 as const,
      pidsMax: 64 as const,
      cpuMax: "200000 100000" as const,
    },
    sourceAudio: {
      sha256: normalizedAudioSha256,
      sampleRateHz: 16_000 as const,
      channels: 1 as const,
      sampleCount: 1_600,
      durationMilliseconds: 100,
    },
    modelFingerprint: sha256(canonicalJson({
      manifest: authority.modelManifestSha256,
      weight: authority.modelWeightSha256,
    })),
    modelManifestSha256: authority.modelManifestSha256,
    modelWeightSha256: authority.modelWeightSha256,
    runtime: {
      python: "3.12.3" as const,
      torch: "2.13.0+cu132" as const,
      transformers: "5.14.1" as const,
      safetensors: "0.8.0" as const,
    },
    observation: {
      frameCount: 4,
      outputStrideSamples: 320 as const,
      receptiveFieldSamples: 400 as const,
      blankTokenId: 0 as const,
      unknownTokenId: 3 as const,
      decodedIpa: "a",
      unknownTokenCount: 0,
      specialTokenCount: 0,
      blankFrameRatio: 0.75,
      tokens: [{
        tokenId: 9,
        symbol: "a",
        startFrame: 0,
        endFrameExclusive: 1,
        medianPosterior: 0.9,
        p10Posterior: 0.8,
        minimumTop1Margin: 0.7,
        unknown: false,
        special: false,
      }],
    },
  };
  // Deliberately reverse the top-level insertion order. The orchestrator must
  // parse and canonicalize this untrusted stdout before handing it to phase 2.
  const rawPhase = {
    error: null,
    observation,
    normalization: {
      method: INDEPENDENT_IPA_NORMALIZATION_METHOD,
      ffmpegSha256: INDEPENDENT_IPA_FFMPEG_SHA256,
      normalizedAudioSha256,
      sampleRateHz: 16_000 as const,
      channels: 1 as const,
      durationMilliseconds: 100,
    },
    sourceAudioSha256: target.audioSha256,
    authorityAudioSha256: target.audioSha256,
    reasonCode: null,
    status: "measured" as const,
    schemaVersion: INDEPENDENT_IPA_PHASE_SCHEMA_VERSION,
  };
  const parsed = parseIndependentIpaPhase(rawPhase);
  const deliberatelyNonCanonicalJson = JSON.stringify(rawPhase);
  const canonicalBytes = canonicalJson(parsed);
  if (deliberatelyNonCanonicalJson === canonicalBytes) {
    throw new Error("Fixture IPA stdout unexpectedly was already canonical.");
  }
  return {
    parsed,
    deliberatelyNonCanonicalJson,
    canonicalBytes,
    canonicalSha256: sha256(canonicalBytes),
  };
}

function completedChild(
  payload: string,
  code: 0 | 2,
  afterClose: () => void,
): ChildProcess {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(emitter, {
    pid: undefined,
    stdout,
    stderr,
    kill: () => true,
    unref: () => undefined,
  }) as unknown as ChildProcess;
  setImmediate(() => {
    stdout.end(payload.endsWith("\n") ? payload : `${payload}\n`);
    stderr.end();
    emitter.emit("close", code, null);
    afterClose();
  });
  return child;
}

function unitNameFrom(args: readonly string[]): string {
  const unitArgument = args.find((argument) => argument.startsWith("--unit="));
  if (!unitArgument) throw new Error("Fake spawn did not receive a systemd unit name.");
  return unitArgument.slice("--unit=".length);
}

function readOnlyBindingSource(args: readonly string[], destination: string): string {
  const prefix = "--property=BindReadOnlyPaths=";
  for (const argument of args) {
    if (!argument.startsWith(prefix)) continue;
    const binding = argument.slice(prefix.length);
    const separator = binding.indexOf(":");
    if (separator >= 0 && binding.slice(separator + 1) === destination) {
      return binding.slice(0, separator);
    }
  }
  throw new Error(`Fake spawn did not receive binding for ${destination}.`);
}

function g2pPayload(args: readonly string[], unitName: string): string {
  const sandbox = t2aAudioSandboxPaths(unitName);
  const request = readFileSync(readOnlyBindingSource(args, sandbox.g2pRequest));
  const execution = spawnSync(
    analysisPythonExecutable,
    ["-I", join(appRoot, "scripts", "t2a_german_g2p.py")],
    {
      input: request,
      encoding: "utf8",
      timeout: 10_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" },
    },
  );
  if (execution.status !== 0 || execution.signal !== null || execution.stderr !== "") {
    throw new Error(`Fixture German G2P failed: ${execution.stderr}`);
  }
  return execution.stdout;
}

function adjudicatorPayload(args: readonly string[], unitName: string): string {
  const sandbox = t2aAudioSandboxPaths(unitName);
  const raw = JSON.parse(readFileSync(
    readOnlyBindingSource(args, sandbox.adjudicatorRequest),
    "utf8",
  )) as unknown;
  const request = t2aIpaAdjudicatorRequestSchema.parse(raw);
  return t2aIpaAdjudicationCanonicalJson(adjudicateT2aIpa({
    phaseCanonicalJson: Buffer.from(request.phaseCanonicalJsonBase64, "base64").toString("utf8"),
    referenceCanonicalJson: Buffer.from(
      request.referenceCanonicalJsonBase64,
      "base64",
    ).toString("utf8"),
    g2pResultCanonicalJson: Buffer.from(
      request.g2pResultCanonicalJsonBase64,
      "base64",
    ).toString("utf8"),
    phaseSha256: request.phaseSha256,
    referenceSha256: request.referenceSha256,
    runnerSha256: request.runnerSha256,
    policySha256: request.policySha256,
    g2pRunnerSha256: request.g2pRunnerSha256,
    espeakBinarySha256: request.espeakBinarySha256,
    espeakDataManifestSha256: request.espeakDataManifestSha256,
    espeakRuntimeManifestSha256: request.espeakRuntimeManifestSha256,
    ipaVocabularySha256: request.ipaVocabularySha256,
    normalizationPolicySha256: request.normalizationPolicySha256,
    targetTextSha256: request.targetTextSha256,
    normalizedTargetTextSha256: request.normalizedTargetTextSha256,
    espeakStdoutSha256: request.espeakStdoutSha256,
    g2pResultSha256: request.g2pResultSha256,
  }));
}

function createHarness(options: {
  phaseJson: string;
  abortController?: AbortController;
}): Harness {
  const events: string[] = [];
  const spawns: SpawnRecord[] = [];
  const controlCommand: Harness["controlCommand"] = async (args) => {
    if (!args.includes("list-units")) {
      throw new Error(`Unexpected control command: ${args.join(" ")}`);
    }
    events.push("recovery");
    return { code: 0, stdout: "", stderr: "" };
  };
  const fakeSpawn = ((
    command: string,
    rawArgs?: readonly string[],
    rawOptions?: SpawnOptions,
  ): ChildProcess => {
    const args = [...(rawArgs ?? [])];
    const unitName = unitNameFrom(args);
    const phase: SpawnRecord["phase"] = args.includes("independent-ipa-observation")
      ? "ipa"
      : args.includes("--expected-reference-sha256")
        ? "adjudicator"
        : args.some((argument) => argument.endsWith("/t2a_german_g2p.py"))
          ? "g2p"
          : "quality";
    events.push(phase);
    spawns.push({
      command,
      args,
      unitName,
      phase,
      options: {
        cwd: rawOptions?.cwd,
        detached: rawOptions?.detached,
        shell: rawOptions?.shell,
        stdio: rawOptions?.stdio,
        env: rawOptions?.env,
      },
    });
    const payload = phase === "ipa"
      ? options.phaseJson
      : phase === "g2p"
        ? g2pPayload(args, unitName)
        : phase === "adjudicator"
          ? adjudicatorPayload(args, unitName)
          : failedQualityDocument();
    return completedChild(
      payload,
      phase === "quality" ? 2 : 0,
      () => {
        events.push(`${phase}-close`);
        if (phase === "ipa" && options.abortController) {
          events.push("abort");
          options.abortController.abort();
        }
      },
    );
  }) as unknown as typeof spawn;
  return { events, spawns, controlCommand, spawnProcess: fakeSpawn };
}

function readOnlyBindingDestinations(args: readonly string[]): string[] {
  return args
    .filter((argument) => argument.startsWith("--property=BindReadOnlyPaths="))
    .map((argument) => {
      const binding = argument.slice("--property=BindReadOnlyPaths=".length);
      const separator = binding.indexOf(":");
      if (separator < 0) throw new Error("Malformed read-only binding in fixture.");
      return binding.slice(separator + 1);
    });
}

function argumentAfter(args: readonly string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

async function successfulFailClosedRun() {
  const target = await createTarget("successful");
  const phase = measuredIpaPhase(target);
  const expectedBinding = resolveT2aAudioEvaluatorBinding();
  const qualityAuthority = getT2aAudioEvaluatorAuthorityState();
  const ipaAuthority = getT2aIndependentIpaAuthorityState();
  const pronunciationAuthority = getT2aPronunciationAuthorityState();
  const independentlyCombinedFingerprint = sha256(canonicalJson({
    evaluatorRevision: T2A_AUDIO_EVALUATOR_REVISION,
    qualityEvaluatorFingerprint: qualityAuthority.fingerprint,
    independentIpaEvaluatorFingerprint: ipaAuthority.fingerprint,
    germanG2pEvaluatorFingerprint: pronunciationAuthority.g2pFingerprint,
    ipaAdjudicatorFingerprint: pronunciationAuthority.adjudicatorFingerprint,
  }));
  const harness = createHarness({ phaseJson: phase.deliberatelyNonCanonicalJson });
  const evaluated = await runT2aAudioEvaluator(target, {
    timeoutMs: 30_000,
    terminationGraceMs: 100,
    spawnProcess: harness.spawnProcess,
    controlCommand: harness.controlCommand,
  });
  if (harness.spawns.length !== 4) {
    throw new Error(`Expected four phase spawns, received ${harness.spawns.length}.`);
  }
  const ipaSpawn = harness.spawns[0];
  const g2pSpawn = harness.spawns[1];
  const adjudicatorSpawn = harness.spawns[2];
  const qualitySpawn = harness.spawns[3];
  const ipaSandbox = t2aAudioSandboxPaths(ipaSpawn.unitName);
  const g2pSandbox = t2aAudioSandboxPaths(g2pSpawn.unitName);
  const adjudicatorSandbox = t2aAudioSandboxPaths(adjudicatorSpawn.unitName);
  const qualitySandbox = t2aAudioSandboxPaths(qualitySpawn.unitName);
  const observationPath = join(dataRoot, "successful", "independent-ipa-observation.json");
  const observationBytes = await readFile(observationPath, "utf8");
  const observationStats = lstatSync(observationPath, { bigint: true });
  const adjudicationPath = join(dataRoot, "successful", "ipa-adjudication-result.json");
  const adjudicationBytes = await readFile(adjudicationPath, "utf8");
  const adjudicationStats = lstatSync(adjudicationPath, { bigint: true });
  const g2pRequestBytes = await readFile(
    join(dataRoot, "successful", "german-g2p-request.json"),
    "utf8",
  );
  const adjudicatorRequestBytes = await readFile(
    join(dataRoot, "successful", "ipa-adjudicator-request.json"),
    "utf8",
  );
  return {
    unitPrefix: T2A_AUDIO_SANDBOX_UNIT_PREFIX,
    events: harness.events,
    commands: harness.spawns.map((record) => record.command),
    units: harness.spawns.map((record) => record.unitName),
    phases: harness.spawns.map((record) => record.phase),
    privateIsolation: {
      g2pRequestContainsTarget: g2pRequestBytes.includes("Hallo Welt"),
      g2pRequestContainsAudioPath: g2pRequestBytes.includes(target.audioSnapshotPath),
      adjudicatorRequestContainsTarget: adjudicatorRequestBytes.includes("Hallo Welt"),
      adjudicatorRequestContainsTranscriptPath: adjudicatorRequestBytes.includes(
        target.transcriptSnapshotPath,
      ),
      adjudicationResultContainsTarget: adjudicationBytes.includes("Hallo Welt"),
      adjudicationResultContainsAnySnapshotPath: adjudicationBytes.includes(
        target.audioSnapshotPath,
      ) || adjudicationBytes.includes(target.transcriptSnapshotPath),
    },
    spawnOptions: harness.spawns.map((record) => record.options),
    ipa: {
      bindingDestinations: readOnlyBindingDestinations(ipaSpawn.args),
      expectedBindingDestinations: [
        ipaSandbox.worker,
        ipaSandbox.ipaRunner,
        ipaSandbox.audio,
        ipaSandbox.ipaModel,
        ipaSandbox.ffmpeg,
        ipaSandbox.runtime,
      ],
      hasTranscriptFlag: ipaSpawn.args.includes("--transcript"),
      hasWhisperFlag: ipaSpawn.args.includes("--whisper-model"),
      hasTranscriptBinding: readOnlyBindingDestinations(ipaSpawn.args)
        .includes(ipaSandbox.transcript),
      hasDialogueBinding: readOnlyBindingDestinations(ipaSpawn.args)
        .includes(ipaSandbox.dialogueEvaluator),
      hasWhisperBinding: readOnlyBindingDestinations(ipaSpawn.args)
        .includes(ipaSandbox.whisper),
    },
    g2p: {
      bindingDestinations: readOnlyBindingDestinations(g2pSpawn.args),
      expectedBindingDestinations: [
        g2pSandbox.g2pRunner,
        g2pSandbox.g2pRequest,
        g2pSandbox.espeak,
        g2pSandbox.espeakData,
        g2pSandbox.ipaVocabulary,
        g2pSandbox.runtime,
      ],
      hasAudioBinding: readOnlyBindingDestinations(g2pSpawn.args).includes(g2pSandbox.audio),
      hasTranscriptBinding: readOnlyBindingDestinations(g2pSpawn.args)
        .includes(g2pSandbox.transcript),
      hasWhisperBinding: readOnlyBindingDestinations(g2pSpawn.args)
        .includes(g2pSandbox.whisper),
      requestSha256: argumentAfter(g2pSpawn.args, g2pSandbox.g2pRequest),
    },
    adjudicator: {
      bindingDestinations: readOnlyBindingDestinations(adjudicatorSpawn.args),
      expectedBindingDestinations: [
        adjudicatorSandbox.adjudicatorRunner,
        adjudicatorSandbox.adjudicatorRequest,
        adjudicatorSandbox.ipaVocabulary,
        adjudicatorSandbox.runtime,
      ],
      hasAudioBinding: readOnlyBindingDestinations(adjudicatorSpawn.args)
        .includes(adjudicatorSandbox.audio),
      hasTranscriptBinding: readOnlyBindingDestinations(adjudicatorSpawn.args)
        .includes(adjudicatorSandbox.transcript),
      hasG2pRequestBinding: readOnlyBindingDestinations(adjudicatorSpawn.args)
        .includes(adjudicatorSandbox.g2pRequest),
      argvContainsTranscript: JSON.stringify(adjudicatorSpawn.args).includes("Hallo Welt"),
      phaseSha256: argumentAfter(adjudicatorSpawn.args, "--expected-phase-sha256"),
      referenceSha256: argumentAfter(adjudicatorSpawn.args, "--expected-reference-sha256"),
      g2pResultSha256: argumentAfter(adjudicatorSpawn.args, "--expected-g2p-result-sha256"),
    },
    quality: {
      bindingDestinations: readOnlyBindingDestinations(qualitySpawn.args),
      expectedBindingDestinations: [
        qualitySandbox.worker,
        qualitySandbox.dialogueEvaluator,
        qualitySandbox.audio,
        qualitySandbox.transcript,
        qualitySandbox.ipaObservation,
        qualitySandbox.adjudicationResult,
        qualitySandbox.whisper,
        qualitySandbox.ffmpeg,
        qualitySandbox.runtime,
      ],
      hasIpaRunnerFlag: qualitySpawn.args.includes("--independent-ipa-runner"),
      hasIpaModelFlag: qualitySpawn.args.includes("--independent-ipa-model"),
      hasIpaRunnerBinding: readOnlyBindingDestinations(qualitySpawn.args)
        .includes(qualitySandbox.ipaRunner),
      hasIpaModelBinding: readOnlyBindingDestinations(qualitySpawn.args)
        .includes(qualitySandbox.ipaModel),
      adjudicationSha256: argumentAfter(
        qualitySpawn.args,
        "--expected-ipa-adjudication-result-sha256",
      ),
    },
    canonicalHandoff: {
      emittedStdoutSha256: sha256(phase.deliberatelyNonCanonicalJson),
      canonicalSha256: phase.canonicalSha256,
      qualityExpectedSha256: argumentAfter(
        qualitySpawn.args,
        "--expected-independent-ipa-observation-sha256",
      ),
      observationSha256: sha256(observationBytes),
      observationIsCanonical: observationBytes === phase.canonicalBytes,
      observationMode: Number(observationStats.mode & 0o777n).toString(8).padStart(4, "0"),
      adjudicationSha256: sha256(adjudicationBytes),
      qualityAdjudicationSha256: argumentAfter(
        qualitySpawn.args,
        "--expected-ipa-adjudication-result-sha256",
      ),
      adjudicationIsCanonical: adjudicationBytes === canonicalJson(
        JSON.parse(adjudicationBytes) as unknown,
      ),
      adjudicationMode: Number(adjudicationStats.mode & 0o777n)
        .toString(8)
        .padStart(4, "0"),
    },
    result: {
      analysisStatus: evaluated.result.analysisStatus,
      eligibilityStatus: evaluated.result.ia2vEligibility.status,
      eligibilityBlockers: evaluated.result.ia2vEligibility.blockers,
      evaluatorFingerprint: evaluated.evaluatorFingerprint,
      expectedBindingFingerprint: expectedBinding.evaluatorFingerprint,
      independentlyCombinedFingerprint,
      qualityEvaluatorFingerprint: qualityAuthority.fingerprint,
      independentIpaEvaluatorFingerprint: ipaAuthority.fingerprint,
      germanG2pEvaluatorFingerprint: pronunciationAuthority.g2pFingerprint,
      ipaAdjudicatorFingerprint: pronunciationAuthority.adjudicatorFingerprint,
      claimScope: evaluated.claimScope,
    },
  };
}

async function abortedBetweenPhasesRun() {
  const target = await createTarget("aborted");
  const phase = measuredIpaPhase(target);
  const controller = new AbortController();
  const harness = createHarness({
    phaseJson: phase.deliberatelyNonCanonicalJson,
    abortController: controller,
  });
  let error: unknown;
  try {
    await runT2aAudioEvaluator(target, {
      timeoutMs: 30_000,
      terminationGraceMs: 100,
      signal: controller.signal,
      spawnProcess: harness.spawnProcess,
      controlCommand: harness.controlCommand,
    });
  } catch (caught) {
    error = caught;
  }
  return {
    events: harness.events,
    spawnCount: harness.spawns.length,
    phases: harness.spawns.map((record) => record.phase),
    errorName: error instanceof Error ? error.name : null,
    errorCode: error instanceof T2aAudioEvaluatorCancelledError ? error.code : null,
    observationMaterialized: existsSync(
      join(dataRoot, "aborted", "independent-ipa-observation.json"),
    ),
  };
}

async function main(): Promise<void> {
  const dataRootStats = lstatSync(dataRoot, { bigint: true });
  if (!dataRootStats.isDirectory()
    || dataRootStats.isSymbolicLink()
    || (dataRootStats.mode & 0o777n) !== 0o700n) {
    throw new Error("Fixture requires a caller-created private 0700 data root.");
  }
  const successful = await successfulFailClosedRun();
  const aborted = await abortedBetweenPhasesRun();
  if (![successful.result.evaluatorFingerprint,
    successful.result.expectedBindingFingerprint,
    successful.result.independentlyCombinedFingerprint]
    .every((value) => SHA256_PATTERN.test(value))) {
    throw new Error("Fixture produced an invalid combined fingerprint.");
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "ltx-studio-t2a-four-phase-orchestration-fixture.v1",
    successful,
    aborted,
  })}\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
