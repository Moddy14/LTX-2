import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analysisPythonExecutable, appRoot } from "../server/config.js";
import { T2A_IPA_ADJUDICATOR_RUNNER_SHA256 } from "../server/t2aAudioEvaluator.js";
import {
  T2A_FFMPEG_SHA256,
  T2A_WHISPER_SMALL_SHA256,
  t2aAudioQualitySchema,
} from "../shared/t2aAudioQuality.js";
import {
  T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
  T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
} from "../shared/t2aGermanG2p.js";
import { T2A_IPA_ADJUDICATION_POLICY_SHA256 } from "../shared/t2aIpaAdjudication.js";

const runnerPath = join(appRoot, "scripts", "analyze-t2a-audio.py");
const roots: string[] = [];
const localFfmpeg = existsSync("/usr/bin/ffmpeg") ? realpathSync("/usr/bin/ffmpeg") : null;
const localFfmpegIt = localFfmpeg ? it : it.skip;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function wavBuffer(
  samples: readonly number[],
  options: { sampleRate?: number; channels?: number; bitsPerSample?: 8 | 16 } = {},
): Buffer {
  const sampleRate = options.sampleRate ?? 48_000;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const bytesPerSample = bitsPerSample / 8;
  const data = Buffer.alloc(samples.length * bytesPerSample);
  samples.forEach((sample, index) => {
    if (bitsPerSample === 16) data.writeInt16LE(sample, index * bytesPerSample);
    else data.writeUInt8(sample, index);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function dialogueFixture(): Record<string, unknown> {
  return {
    status: "measured",
    blockerCode: "none",
    error: null,
    method: "whisper-small-guided-word-motion.v1",
    modelName: "OpenAI Whisper small",
    modelSha256: T2A_WHISPER_SMALL_SHA256,
    packageVersion: "20250625",
    detectedLanguage: "de",
    expectedTranscriptSha256: sha256("Hallo"),
    expectedWordCount: 1,
    recognizedWordCount: 1,
    recognizedTranscript: "Hallo",
    wordErrorRate: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    rawAsrContentGate: {
      status: "passed",
      method: "whisper-small-independent-raw-asr-token-edits.v1",
      targetConditioned: false,
      exactTokenMatch: true,
      expectedNormalizedWords: ["hallo"],
      recognizedNormalizedWords: ["hallo"],
      prefixInsertions: [],
      internalInsertions: [],
      suffixInsertions: [],
      deletedExpectedWords: [],
      substitutedWords: [],
      repeatedInsertions: [],
    },
    phonemeVerification: {
      status: "not-available",
      method: null,
      reason: "Kein unabhaengig gebundener Zweit-Recognizer oder Phonem-Scorer ist verfuegbar.",
    },
    guidedAlignedWordCount: 1,
    guidedWordCoverage: 1,
    usableAlignedWordCount: 1,
    usableGuidedWordCoverage: 1,
    medianGuidedWordProbability: 0.9,
    p10GuidedWordProbability: 0.9,
    lowConfidenceAlignedWords: 0,
    alignmentStatus: "measured",
    alignmentError: null,
    timePrecisionMilliseconds: 20,
    audioStartRelativeVideoSeconds: null,
    guidedWords: [{
      index: 0,
      word: "Hallo",
      normalizedWord: "hallo",
      tokenIds: [1],
      startSeconds: 0,
      endSeconds: 0.8,
      probability: 0.9,
      usable: true,
    }],
    trackedWordCount: 0,
    mouthTrackedWordCoverage: 0,
    wordsWithMouthMotionRatio: null,
    pauseMotionRatio: null,
    estimatedWordActivityLeadMilliseconds: null,
    lagResolutionMilliseconds: null,
    correlationPeak: null,
    nullP95Correlation: null,
    wordMotionProxyStatus: "insufficient",
  };
}

function measuredIndependentIpaPhase(authorityAudioSha256: string): Record<string, unknown> {
  const normalizedAudioSha256 = "e".repeat(64);
  return {
    schemaVersion: "ltx-studio-independent-ipa-phase.v2",
    status: "measured",
    reasonCode: null,
    authorityAudioSha256,
    sourceAudioSha256: authorityAudioSha256,
    normalization: {
      method: "ffmpeg-pcm-s16le-mono-16khz-bitexact.v1",
      ffmpegSha256: T2A_FFMPEG_SHA256,
      normalizedAudioSha256,
      sampleRateHz: 16_000,
      channels: 1,
      durationMilliseconds: 100,
    },
    observation: {
      schemaVersion: "ltx-studio-independent-ipa-observation.v1",
      status: "measured",
      error: null,
      method: "xlsr53-espeak-cv-free-ctc-greedy.v1",
      decoderPolicy: "ctc-collapse-runs-then-remove-blank.v1",
      targetConditioned: false,
      runnerSha256: "1".repeat(64),
      executionBoundary: {
        cpuOnly: true,
        ipSocketFamiliesBlocked: ["AF_INET", "AF_INET6"],
        blockedNetworkErrno: 97,
        noNewPrivileges: true,
        effectiveCapabilities: "0000000000000000",
        memoryMaxBytes: 8 * 1024 ** 3,
        minimumCgroupHeadroomBytes: 6 * 1024 ** 3,
        swapMaxBytes: 0,
        pidsMax: 64,
        cpuMax: "200000 100000",
      },
      sourceAudio: {
        sha256: normalizedAudioSha256,
        sampleRateHz: 16_000,
        channels: 1,
        sampleCount: 1_600,
        durationMilliseconds: 100,
      },
      modelFingerprint: "2".repeat(64),
      modelManifestSha256: "3".repeat(64),
      modelWeightSha256: "4".repeat(64),
      runtime: {
        python: "3.12.3",
        torch: "2.13.0+cu132",
        transformers: "5.14.1",
        safetensors: "0.8.0",
      },
      observation: {
        frameCount: 4,
        outputStrideSamples: 320,
        receptiveFieldSamples: 400,
        blankTokenId: 0,
        unknownTokenId: 3,
        decodedIpa: "h",
        unknownTokenCount: 0,
        specialTokenCount: 0,
        blankFrameRatio: 0.75,
        tokens: [{
          tokenId: 4,
          symbol: "h",
          startFrame: 0,
          endFrameExclusive: 1,
          medianPosterior: 0.9,
          p10Posterior: 0.8,
          minimumTop1Margin: 0.5,
          unknown: false,
          special: false,
        }],
      },
    },
    error: null,
  };
}

function insufficientIndependentIpaPhase(authorityAudioSha256: string): Record<string, unknown> {
  return {
    schemaVersion: "ltx-studio-independent-ipa-phase.v2",
    status: "insufficient",
    reasonCode: "duration-exceeds-independent-ipa-window",
    authorityAudioSha256,
    sourceAudioSha256: authorityAudioSha256,
    normalization: null,
    observation: null,
    error: null,
  };
}

function dialogueWithTwoSubstitutions(): { transcript: string; dialogue: Record<string, unknown> } {
  const expectedWords = Array.from({ length: 43 }, (_, index) => `wort${index}`);
  expectedWords[10] = "reißt";
  expectedWords[20] = "schreie";
  const recognizedWords = [...expectedWords];
  recognizedWords[10] = "reist";
  recognizedWords[20] = "schreihe";
  const transcript = expectedWords.join(" ");
  const dialogue = dialogueFixture();
  return {
    transcript,
    dialogue: {
      ...dialogue,
      expectedTranscriptSha256: sha256(transcript),
      expectedWordCount: 43,
      recognizedWordCount: 43,
      recognizedTranscript: recognizedWords.join(" "),
      wordErrorRate: 2 / 43,
      substitutions: 2,
      rawAsrContentGate: {
        status: "failed",
        method: "whisper-small-independent-raw-asr-token-edits.v1",
        targetConditioned: false,
        exactTokenMatch: false,
        expectedNormalizedWords: expectedWords,
        recognizedNormalizedWords: recognizedWords,
        prefixInsertions: [],
        internalInsertions: [],
        suffixInsertions: [],
        deletedExpectedWords: [],
        substitutedWords: [{
          expectedIndex: 10,
          recognizedIndex: 10,
          expectedWord: "reißt",
          recognizedWord: "reist",
        }, {
          expectedIndex: 20,
          recognizedIndex: 20,
          expectedWord: "schreie",
          recognizedWord: "schreihe",
        }],
        repeatedInsertions: [],
      },
      guidedAlignedWordCount: 43,
      guidedWordCoverage: 1,
      usableAlignedWordCount: 43,
      usableGuidedWordCoverage: 1,
      medianGuidedWordProbability: 0.9,
      p10GuidedWordProbability: 0.9,
      guidedWords: expectedWords.map((word, index) => ({
        index,
        word,
        normalizedWord: word,
        tokenIds: [index + 1],
        startSeconds: index / 100,
        endSeconds: (index + 0.5) / 100,
        probability: 0.9,
        usable: true,
      })),
    },
  };
}

async function setupFiles(samples: readonly number[], bitsPerSample: 8 | 16 = 16) {
  const root = await mkdtemp(join(tmpdir(), "ltx-t2a-audio-qa-"));
  roots.push(root);
  const audio = join(root, "source.wav");
  const whisper = join(root, "caller-whisper.pt");
  const audioBytes = wavBuffer(samples, { bitsPerSample });
  const audioSha256 = sha256(audioBytes);
  const independentIpaObservation = join(root, "independent-ipa-phase.json");
  const phase = samples.length / 48_000 > 21
    ? insufficientIndependentIpaPhase(audioSha256)
    : measuredIndependentIpaPhase(audioSha256);
  const independentIpaObservationBytes = Buffer.from(JSON.stringify(phase));
  const independentIpaObservationSha256 = sha256(independentIpaObservationBytes);
  const ipaAdjudicationResult = join(root, "ipa-adjudication-result.json");
  const measured = phase.status === "measured";
  const ipaAdjudication = {
    schemaVersion: "ltx-studio-t2a-ipa-adjudication-result.v1",
    status: measured ? "measured" : "unavailable",
    sourcePhaseStatus: phase.status,
    phaseSha256: independentIpaObservationSha256,
    referenceSha256: "5".repeat(64),
    targetTextSha256: sha256("Hallo"),
    normalizedTargetTextSha256: "6".repeat(64),
    espeakRuntimeManifestSha256: T2A_GERMAN_G2P_RUNTIME_MANIFEST_SHA256,
    ipaVocabularySha256: T2A_GERMAN_G2P_IPA_VOCABULARY_SHA256,
    espeakStdoutSha256: "7".repeat(64),
    g2pResultSha256: "8".repeat(64),
    runnerSha256: T2A_IPA_ADJUDICATOR_RUNNER_SHA256,
    policySha256: T2A_IPA_ADJUDICATION_POLICY_SHA256,
    measurement: measured ? {
      substitutions: 0,
      deletions: 0,
      insertions: 0,
      editDistance: 0,
      referenceTokenCount: 1,
      hypothesisTokenCount: 1,
      normalizedPhoneErrorRate: 0,
    } : null,
  };
  const ipaAdjudicationResultBytes = Buffer.from(JSON.stringify(ipaAdjudication));
  await writeFile(audio, audioBytes);
  await writeFile(whisper, "caller-model-before-binding");
  await writeFile(independentIpaObservation, independentIpaObservationBytes);
  await writeFile(ipaAdjudicationResult, ipaAdjudicationResultBytes);
  return {
    root,
    audio,
    audioBytes,
    audioSha256,
    whisper,
    independentIpaObservation,
    independentIpaObservationBytes,
    independentIpaObservationSha256,
    ipaAdjudicationResult,
    ipaAdjudicationResultBytes,
    ipaAdjudicationResultSha256: sha256(ipaAdjudicationResultBytes),
    ffmpeg: localFfmpeg ?? "/usr/bin/ffmpeg",
    ffmpegSha256: T2A_FFMPEG_SHA256,
  };
}

function mockedAnalysisCode(
  files: Awaited<ReturnType<typeof setupFiles>>,
  loudness: readonly [number, number],
  options: { dialogue?: Record<string, unknown>; transcript?: string } = {},
): string {
  const dialogue = options.dialogue ?? dialogueFixture();
  const transcript = options.transcript ?? "Hallo";
  return [
    "import hashlib,importlib.util,json,os,pathlib",
    `runner=pathlib.Path(${JSON.stringify(runnerPath)})`,
    "spec=importlib.util.spec_from_file_location('ltx_t2a_audio_qa',runner)",
    "module=importlib.util.module_from_spec(spec)",
    "spec.loader.exec_module(module)",
    `source=pathlib.Path(${JSON.stringify(files.audio)})`,
    `caller_model=pathlib.Path(${JSON.stringify(files.whisper)})`,
    `bound_ffmpeg=pathlib.Path(${JSON.stringify(files.ffmpeg)})`,
    `expected_audio_hash=${JSON.stringify(files.audioSha256)}`,
    `dialogue=json.loads(${JSON.stringify(JSON.stringify(dialogue))})`,
    `transcript=${JSON.stringify(transcript)}`,
    `adjudication_path=pathlib.Path(${JSON.stringify(files.ipaAdjudicationResult)})`,
    "adjudication=json.loads(adjudication_path.read_text())",
    "adjudication['targetTextSha256']=hashlib.sha256(transcript.encode('utf-8')).hexdigest()",
    "adjudication_bytes=json.dumps(adjudication,ensure_ascii=False,allow_nan=False,separators=(',',':')).encode('utf-8')",
    "adjudication_path.write_bytes(adjudication_bytes)",
    "expected_adjudication_hash=hashlib.sha256(adjudication_bytes).hexdigest()",
    "real_reader=module._read_stable_regular_file",
    "bound_model=b'bound-whisper-small-snapshot'",
    "def snapshot_reader(path,**options):",
    "    if options['label'] == 'Whisper':",
    "        assert path == caller_model",
    "        assert options['expected_sha256'] == module.PINNED_WHISPER_SMALL_SHA256",
    "        caller_model.write_bytes(b'swapped-after-binding')",
    "        return bound_model,module.PINNED_WHISPER_SMALL_SHA256",
    "    return real_reader(path,**options)",
    "module._read_stable_regular_file=snapshot_reader",
    "def loudness_stub(audio_path,ffmpeg_path):",
    "    assert audio_path != source and audio_path.name == 'audio.wav'",
    "    assert audio_path.stat().st_mode & 0o777 == 0o400",
    "    assert hashlib.sha256(audio_path.read_bytes()).hexdigest() == expected_audio_hash",
    "    assert ffmpeg_path == bound_ffmpeg",
    "    assert ffmpeg_path != audio_path.parent / 'ffmpeg'",
    `    return (${loudness[0]},${loudness[1]})`,
    "def dialogue_stub(**values):",
    "    assert os.environ['PATH'] == str(bound_ffmpeg.parent)",
    "    assert values['video_path'] != source",
    "    assert values['tracked_candidates'] == []",
    "    assert values['audio_start_relative_video_seconds'] is None",
    "    assert values['has_audio'] is True",
    "    assert values['word_motion_enabled'] is False",
    `    assert values['expected_model_sha256'] == ${JSON.stringify(T2A_WHISPER_SMALL_SHA256)}`,
    "    assert values['model_path'] != caller_model",
    "    assert values['model_path'].name == 'whisper-small.pt'",
    "    assert values['model_path'].stat().st_mode & 0o777 == 0o400",
    "    assert values['model_path'].read_bytes() == bound_model",
    "    assert caller_model.read_bytes() == b'swapped-after-binding'",
    "    return dialogue",
    "result=module.analyze_audio(",
    "    audio_path=source,",
    "    expected_audio_sha256=expected_audio_hash,",
    "    transcript=transcript,",
    "    whisper_model_path=caller_model,",
    `    ffmpeg_path=pathlib.Path(${JSON.stringify(files.ffmpeg)}),`,
    `    independent_ipa_observation_path=pathlib.Path(${JSON.stringify(files.independentIpaObservation)}),`,
    `    expected_independent_ipa_observation_sha256=${JSON.stringify(files.independentIpaObservationSha256)},`,
    "    ipa_adjudication_result_path=adjudication_path,",
    "    expected_ipa_adjudication_result_sha256=expected_adjudication_hash,",
    `    expected_ipa_adjudicator_runner_sha256=${JSON.stringify(T2A_IPA_ADJUDICATOR_RUNNER_SHA256)},`,
    `    expected_ipa_adjudication_policy_sha256=${JSON.stringify(T2A_IPA_ADJUDICATION_POLICY_SHA256)},`,
    "    peak_ceiling_dbfs=-3,",
    "    dialogue_evaluator=dialogue_stub,",
    "    loudness_runner=loudness_stub,",
    ")",
    "print(json.dumps(result,ensure_ascii=False,allow_nan=False))",
  ].join("\n");
}

function runPython(source: string) {
  return spawnSync(analysisPythonExecutable, ["-I", "-c", source], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
  });
}

function runCli(
  audio: string,
  expectedAudioSha256: string,
  ffmpeg: string,
  options: {
    independentIpaObservation?: string;
    expectedIndependentIpaObservationSha256?: string;
    ipaAdjudicationResult?: string;
    expectedIpaAdjudicationResultSha256?: string;
    extra?: string[];
  } = {},
) {
  const independentIpaObservation = options.independentIpaObservation
    ?? join(audio, "..", "independent-ipa-phase.json");
  const expectedIndependentIpaObservationSha256 = options.expectedIndependentIpaObservationSha256
    ?? sha256(readFileSync(independentIpaObservation));
  const ipaAdjudicationResult = options.ipaAdjudicationResult
    ?? join(audio, "..", "ipa-adjudication-result.json");
  const expectedIpaAdjudicationResultSha256 = options.expectedIpaAdjudicationResultSha256
    ?? sha256(readFileSync(ipaAdjudicationResult));
  return spawnSync(analysisPythonExecutable, [
    "-I",
    runnerPath,
    "--audio", audio,
    "--expected-audio-sha256", expectedAudioSha256,
    "--transcript", "Hallo",
    "--whisper-model", join(audio, "..", "local-whisper.pt"),
    "--ffmpeg", ffmpeg,
    "--peak-ceiling-dbfs", "-3",
    "--independent-ipa-observation", independentIpaObservation,
    "--expected-independent-ipa-observation-sha256", expectedIndependentIpaObservationSha256,
    "--ipa-adjudication-result", ipaAdjudicationResult,
    "--expected-ipa-adjudication-result-sha256", expectedIpaAdjudicationResultSha256,
    "--expected-ipa-adjudicator-runner-sha256", T2A_IPA_ADJUDICATOR_RUNNER_SHA256,
    "--expected-ipa-adjudication-policy-sha256", T2A_IPA_ADJUDICATION_POLICY_SHA256,
    ...(options.extra ?? []),
  ], {
    encoding: "utf8",
    timeout: 20_000,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
  });
}

function runIndependentIpaCli(options: {
  audio: string;
  audioSha256: string;
  ffmpeg: string;
  runner: string;
  runnerSha256: string;
  model: string;
  extra?: string[];
}) {
  return spawnSync(analysisPythonExecutable, [
    "-I",
    runnerPath,
    "--mode", "independent-ipa-observation",
    "--audio", options.audio,
    "--expected-audio-sha256", options.audioSha256,
    "--ffmpeg", options.ffmpeg,
    "--independent-ipa-runner", options.runner,
    "--expected-independent-ipa-runner-sha256", options.runnerSha256,
    "--independent-ipa-model", options.model,
    ...(options.extra ?? []),
  ], {
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
  });
}

async function writeFakeIndependentIpaRunner(root: string, outcome: "measured" | "failed" = "measured") {
  const runner = join(root, "fake-independent-ipa.py");
  const marker = join(root, "fake-independent-ipa.started");
  const source = [
    "#!/usr/bin/env python3",
    "import hashlib,json,pathlib,sys,wave",
    `marker=pathlib.Path(${JSON.stringify(marker)})`,
    "marker.write_text('started')",
    "request=json.loads(sys.stdin.read())",
    "assert set(request)=={'schemaVersion','audioPath','audioSha256'}",
    "assert request['schemaVersion']=='ltx-studio-independent-ipa-request.v1'",
    "assert all('target' not in key.lower() and 'text' not in key.lower() for key in request)",
    `outcome=${JSON.stringify(outcome)}`,
    "if outcome=='failed':",
    "  print(json.dumps({'schemaVersion':'ltx-studio-independent-ipa-observation.v1','status':'failed','error':'fixture runner refused the bound audio','method':'fixture-free-ctc.v1','targetConditioned':False},separators=(',',':')))",
    "  raise SystemExit(2)",
    "audio=pathlib.Path(request['audioPath'])",
    "content=audio.read_bytes()",
    "assert hashlib.sha256(content).hexdigest()==request['audioSha256']",
    "with wave.open(str(audio),'rb') as source:",
    "  assert source.getnchannels()==1 and source.getframerate()==16000 and source.getsampwidth()==2",
    "  sample_count=source.getnframes()",
    "runner_sha=hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()",
    "result={",
    " 'schemaVersion':'ltx-studio-independent-ipa-observation.v1',",
    " 'status':'measured','error':None,'method':'fixture-free-ctc.v1',",
    " 'decoderPolicy':'ctc-collapse-runs-then-remove-blank.v1','targetConditioned':False,",
    " 'runnerSha256':runner_sha,'executionBoundary':{},",
    " 'sourceAudio':{'sha256':request['audioSha256'],'sampleRateHz':16000,'channels':1,'sampleCount':sample_count,'durationMilliseconds':round(sample_count/16)},",
    " 'modelFingerprint':'1'*64,'modelManifestSha256':'2'*64,'modelWeightSha256':'3'*64,",
    " 'runtime':{},'observation':{'requestFields':sorted(request)},",
    "}",
    "print(json.dumps(result,separators=(',',':')))",
  ].join("\n") + "\n";
  await writeFile(runner, source);
  return { runner, marker, runnerSha256: sha256(source) };
}

describe("T2A audio-quality Python worker", () => {
  localFfmpegIt("normalizes audio and invokes the independent IPA runner with no target fields", async () => {
    if (!localFfmpeg) throw new Error("FFmpeg-Prüfung wurde ohne FFmpeg gestartet");
    const samples = Array.from({ length: 4_800 }, (_, index) => [0, 12_000, -12_000, 6_000][index % 4]);
    const files = await setupFiles(samples);
    const fake = await writeFakeIndependentIpaRunner(files.root);
    const model = join(files.root, "sealed-model-fixture");
    await mkdir(model);
    const result = runIndependentIpaCli({
      audio: files.audio,
      audioSha256: files.audioSha256,
      ffmpeg: localFfmpeg,
      runner: fake.runner,
      runnerSha256: fake.runnerSha256,
      model,
    });

    expect(result.status, result.stderr).toBe(0);
    const phase = JSON.parse(result.stdout) as {
      normalization: { normalizedAudioSha256: string };
      [key: string]: unknown;
    };
    expect(phase).toMatchObject({
      schemaVersion: "ltx-studio-independent-ipa-phase.v2",
      status: "measured",
      reasonCode: null,
      authorityAudioSha256: files.audioSha256,
      sourceAudioSha256: files.audioSha256,
      normalization: {
        method: "ffmpeg-pcm-s16le-mono-16khz-bitexact.v1",
        ffmpegSha256: T2A_FFMPEG_SHA256,
        sampleRateHz: 16_000,
        channels: 1,
      },
      observation: {
        targetConditioned: false,
        observation: {
          requestFields: ["audioPath", "audioSha256", "schemaVersion"],
        },
      },
      error: null,
    });
    expect(phase.normalization.normalizedAudioSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(existsSync(fake.marker)).toBe(true);
  });

  it("rejects transcript, Whisper, and peak arguments before the independent IPA runner starts", async () => {
    const files = await setupFiles([0, 1_000, -1_000, 500]);
    const fake = await writeFakeIndependentIpaRunner(files.root);
    const model = join(files.root, "sealed-model-fixture");
    await mkdir(model);
    for (const extra of [
      ["--transcript", "dieser Text darf nicht sichtbar sein"],
      ["--whisper-model", "/kein-whisper-im-phase-1-vertrag.pt"],
      ["--peak-ceiling-dbfs", "-3"],
      ["--independent-ipa-observation", "/keine-phase-2-evidenz.json"],
      ["--expected-independent-ipa-observation-sha256", "a".repeat(64)],
    ]) {
      const result = runIndependentIpaCli({
        audio: files.audio,
        audioSha256: files.audioSha256,
        ffmpeg: files.ffmpeg,
        runner: fake.runner,
        runnerSha256: fake.runnerSha256,
        model,
        extra,
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: "ltx-studio-independent-ipa-phase.v2",
        status: "failed",
        reasonCode: "arguments-invalid",
        authorityAudioSha256: files.audioSha256,
        sourceAudioSha256: null,
        normalization: null,
        observation: null,
        error: { code: "arguments-invalid" },
      });
    }
    expect(existsSync(fake.marker)).toBe(false);
  });

  it("marks audio beyond 21 seconds insufficient without truncation or runner execution", async () => {
    const files = await setupFiles(new Array(48_000 * 22).fill(1_000));
    const fake = await writeFakeIndependentIpaRunner(files.root);
    const model = join(files.root, "sealed-model-fixture");
    await mkdir(model);
    const result = runIndependentIpaCli({
      audio: files.audio,
      audioSha256: files.audioSha256,
      ffmpeg: "/not-read-for-overlong-audio",
      runner: fake.runner,
      runnerSha256: fake.runnerSha256,
      model,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: "ltx-studio-independent-ipa-phase.v2",
      status: "insufficient",
      reasonCode: "duration-exceeds-independent-ipa-window",
      authorityAudioSha256: files.audioSha256,
      sourceAudioSha256: files.audioSha256,
      normalization: null,
      observation: null,
      error: null,
    });
    expect(existsSync(fake.marker)).toBe(false);
  });

  localFfmpegIt("removes a failed runner document from the phase observation while retaining bound failure evidence", async () => {
    if (!localFfmpeg) throw new Error("FFmpeg-Prüfung wurde ohne FFmpeg gestartet");
    const samples = Array.from({ length: 4_800 }, (_, index) => [0, 12_000, -12_000, 6_000][index % 4]);
    const files = await setupFiles(samples);
    const fake = await writeFakeIndependentIpaRunner(files.root, "failed");
    const model = join(files.root, "sealed-model-fixture");
    await mkdir(model);
    const result = runIndependentIpaCli({
      audio: files.audio,
      audioSha256: files.audioSha256,
      ffmpeg: localFfmpeg,
      runner: fake.runner,
      runnerSha256: fake.runnerSha256,
      model,
    });

    expect(result.status, result.stderr).toBe(2);
    const phase = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(phase).toMatchObject({
      schemaVersion: "ltx-studio-independent-ipa-phase.v2",
      status: "failed",
      reasonCode: "independent-ipa-runner-failed",
      authorityAudioSha256: files.audioSha256,
      sourceAudioSha256: files.audioSha256,
      normalization: {
        method: "ffmpeg-pcm-s16le-mono-16khz-bitexact.v1",
        ffmpegSha256: T2A_FFMPEG_SHA256,
        sampleRateHz: 16_000,
        channels: 1,
      },
      observation: null,
      error: {
        code: "independent-ipa-runner-failed",
        message: "fixture runner refused the bound audio",
      },
    });
    expect(existsSync(fake.marker)).toBe(true);
  });

  it("binds quality mode to the exact phase-v2 bytes and authority audio hash", async () => {
    const tampered = await setupFiles([0, 1_000, -1_000, 500]);
    const originalPhaseSha256 = tampered.independentIpaObservationSha256;
    await writeFile(
      tampered.independentIpaObservation,
      Buffer.concat([tampered.independentIpaObservationBytes, Buffer.from("\n")]),
    );
    const tamperResult = runCli(tampered.audio, tampered.audioSha256, tampered.ffmpeg, {
      expectedIndependentIpaObservationSha256: originalPhaseSha256,
    });

    expect(tamperResult.status).toBe(2);
    expect(t2aAudioQualitySchema.parse(JSON.parse(tamperResult.stdout))).toMatchObject({
      schemaVersion: "t2a-audio-quality.v2",
      analysisStatus: "failed",
      error: { code: "arguments-invalid" },
    });

    const rebound = await setupFiles([0, 1_000, -1_000, 500]);
    const wrongAuthority = measuredIndependentIpaPhase("a".repeat(64));
    const wrongAuthorityBytes = Buffer.from(JSON.stringify(wrongAuthority));
    await writeFile(rebound.independentIpaObservation, wrongAuthorityBytes);
    const bindingResult = runCli(rebound.audio, rebound.audioSha256, rebound.ffmpeg, {
      expectedIndependentIpaObservationSha256: sha256(wrongAuthorityBytes),
    });

    expect(bindingResult.status).toBe(2);
    expect(t2aAudioQualitySchema.parse(JSON.parse(bindingResult.stdout))).toMatchObject({
      analysisStatus: "failed",
      error: { code: "arguments-invalid" },
      ia2vEligibility: {
        schemaVersion: "t2a-ia2v-eligibility.v2",
        status: "blocked",
        blockers: ["analysis-failed"],
      },
    });

    const oversized = await setupFiles([0, 1_000, -1_000, 500]);
    const oversizedBytes = Buffer.alloc(512 * 1024 + 1, 0x20);
    await writeFile(oversized.independentIpaObservation, oversizedBytes);
    const oversizedResult = runCli(oversized.audio, oversized.audioSha256, oversized.ffmpeg, {
      expectedIndependentIpaObservationSha256: sha256(oversizedBytes),
    });
    expect(oversizedResult.status).toBe(2);
    expect(t2aAudioQualitySchema.parse(JSON.parse(oversizedResult.stdout))).toMatchObject({
      analysisStatus: "failed",
      error: { code: "arguments-invalid" },
    });
  });

  it("rejects duplicate, non-finite, target-conditioned, and phase-one-only quality inputs", async () => {
    const cases = [
      '{"schemaVersion":"ltx-studio-independent-ipa-phase.v2","schemaVersion":"ltx-studio-independent-ipa-phase.v2"}',
      '{"schemaVersion":"ltx-studio-independent-ipa-phase.v2","value":NaN}',
      JSON.stringify({
        ...measuredIndependentIpaPhase("AUTHORITY"),
        observation: {
          ...(measuredIndependentIpaPhase("AUTHORITY").observation as Record<string, unknown>),
          targetConditioned: true,
        },
      }),
    ];
    for (const phaseSource of cases) {
      const files = await setupFiles([0, 1_000, -1_000, 500]);
      const boundSource = phaseSource.replaceAll("AUTHORITY", files.audioSha256);
      await writeFile(files.independentIpaObservation, boundSource);
      const result = runCli(files.audio, files.audioSha256, files.ffmpeg, {
        expectedIndependentIpaObservationSha256: sha256(boundSource),
      });

      expect(result.status).toBe(2);
      expect(t2aAudioQualitySchema.parse(JSON.parse(result.stdout))).toMatchObject({
        analysisStatus: "failed",
      });
    }

    const extra = await setupFiles([0, 1_000, -1_000, 500]);
    const result = runCli(extra.audio, extra.audioSha256, extra.ffmpeg, {
      extra: ["--independent-ipa-runner", "/phase-one-runner-must-not-enter-quality"],
    });
    expect(result.status).toBe(2);
    expect(t2aAudioQualitySchema.parse(JSON.parse(result.stdout))).toMatchObject({
      analysisStatus: "failed",
      error: { code: "arguments-invalid" },
    });

    const missingPhase = spawnSync(analysisPythonExecutable, [
      "-I",
      runnerPath,
      "--audio", extra.audio,
      "--expected-audio-sha256", extra.audioSha256,
      "--transcript", "Hallo",
      "--whisper-model", extra.whisper,
      "--ffmpeg", extra.ffmpeg,
      "--peak-ceiling-dbfs", "-3",
    ], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
    });
    expect(missingPhase.status).toBe(2);
    expect(t2aAudioQualitySchema.parse(JSON.parse(missingPhase.stdout))).toMatchObject({
      analysisStatus: "failed",
      error: { code: "arguments-invalid" },
    });
  });

  it("exposes prefix, suffix, internal, delete, repeat, and orthographic substitution edits from raw ASR", () => {
    const source = [
      "import importlib.util,json,pathlib",
      `runner=pathlib.Path(${JSON.stringify(join(appRoot, "scripts", "dialogue_word_evaluator.py"))})`,
      "spec=importlib.util.spec_from_file_location('ltx_raw_content_gate',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "expected=['dein','befehl','durchströmen']",
      "cases={",
      " 'exact':expected,",
      " 'prefix':['durchströmen',*expected],",
      " 'suffix':[*expected,'jetzt'],",
      " 'internal':['dein','wirklich','befehl','durchströmen'],",
      " 'deletion':['dein','durchströmen'],",
      " 'homophone':['dein','befehl','durchsträumen'],",
      "}",
      "print(json.dumps({name:module.raw_asr_content_analysis(expected,words) for name,words in cases.items()},ensure_ascii=False))",
    ].join("\n");
    const result = runPython(source);

    expect(result.status, result.stderr).toBe(0);
    const cases = JSON.parse(result.stdout) as Record<string, Record<string, unknown>>;
    expect(cases.exact).toMatchObject({ status: "passed", exactTokenMatch: true });
    expect(cases.prefix).toMatchObject({
      status: "failed",
      prefixInsertions: [{ recognizedIndex: 0, word: "durchströmen" }],
      repeatedInsertions: [{ recognizedIndex: 0, word: "durchströmen" }],
    });
    expect(cases.suffix).toMatchObject({
      status: "failed",
      suffixInsertions: [{ recognizedIndex: 3, word: "jetzt" }],
    });
    expect(cases.internal).toMatchObject({
      status: "failed",
      internalInsertions: [{ recognizedIndex: 1, word: "wirklich" }],
    });
    expect(cases.deletion).toMatchObject({
      status: "failed",
      deletedExpectedWords: [{ expectedIndex: 1, word: "befehl" }],
    });
    expect(cases.homophone).toMatchObject({
      status: "failed",
      substitutedWords: [{ expectedWord: "durchströmen", recognizedWord: "durchsträumen" }],
    });
  });

  it("measures a private hash-bound PCM16 snapshot with mocked local dialogue and loudness engines", async () => {
    const samples = Array.from({ length: 4_800 }, (_, index) => [0, 16_384, -16_384, 8_192][index % 4]);
    const files = await setupFiles(samples);
    const result = runPython(mockedAnalysisCode(files, [-55, -1]));

    expect(result.status, result.stderr).toBe(0);
    const evidence = t2aAudioQualitySchema.parse(JSON.parse(result.stdout));
    expect(evidence).toMatchObject({
      analysisStatus: "measured",
      sourceSnapshot: { sha256: files.audioSha256, byteLength: files.audioBytes.length },
      wav: {
        container: "RIFF/WAVE",
        codec: "pcm_s16le",
        bitsPerSample: 16,
        channels: 1,
        sampleRateHz: 48_000,
        sampleFrames: 4_800,
        durationSeconds: 0.1,
      },
      pcm: {
        totalSamples: 4_800,
        samplePeakLinear: 0.5,
        fullScaleClippedSamples: 0,
        fullScaleClippedRatio: 0,
      },
      loudness: { integratedLufs: -55, truePeakDbtp: -1 },
      spokenContentGate: {
        schemaVersion: "t2a-spoken-content-gate.v1",
        evaluationMode: "measurement-only",
        releaseDecision: "blocked",
        blockerCodes: ["calibrated-holdout-not-qualified"],
        releaseQualification: {
          status: "not-qualified",
          requiredPositiveHoldoutCases: 300,
          requiredNegativeHoldoutCases: 300,
          maximumFalseAccepts: 0,
          evidenceSha256: null,
        },
        independentIpa: {
          authorityAudioSha256: files.audioSha256,
          phaseDocumentSha256: files.independentIpaObservationSha256,
          phase: { status: "measured", observation: { targetConditioned: false } },
        },
      },
      ia2vEligibility: {
        schemaVersion: "t2a-ia2v-eligibility.v2",
        status: "blocked",
        blockers: ["spoken-content-gate-not-passed"],
      },
    });
    if (evidence.analysisStatus !== "measured") throw new Error("Unerwarteter Analysezustand");
    expect(evidence.dialogueEvaluation).not.toHaveProperty("trackedWordCount");
    expect(evidence.dialogueEvaluation).not.toHaveProperty("wordMotionProxyStatus");
  });

  it("keeps the raw 2/43 Whisper edits immutable while adding only blocked measurement evidence", async () => {
    const files = await setupFiles(Array.from(
      { length: 4_800 },
      (_, index) => [0, 16_384, -16_384, 8_192][index % 4],
    ));
    const fixture = dialogueWithTwoSubstitutions();
    const before = structuredClone(fixture.dialogue);
    const result = runPython(mockedAnalysisCode(files, [-13.4, -3], fixture));

    expect(result.status, result.stderr).toBe(0);
    const evidence = t2aAudioQualitySchema.parse(JSON.parse(result.stdout));
    expect(evidence.analysisStatus).toBe("measured");
    if (evidence.analysisStatus !== "measured") throw new Error("Unerwarteter Analysezustand");
    expect(fixture.dialogue).toEqual(before);
    expect(evidence.dialogueEvaluation).toMatchObject({
      expectedWordCount: 43,
      recognizedWordCount: 43,
      wordErrorRate: 2 / 43,
      substitutions: 2,
      deletions: 0,
      insertions: 0,
      rawAsrContentGate: {
        status: "failed",
        exactTokenMatch: false,
        substitutedWords: [{
          expectedWord: "reißt",
          recognizedWord: "reist",
        }, {
          expectedWord: "schreie",
          recognizedWord: "schreihe",
        }],
      },
    });
    expect(evidence.spokenContentGate).toMatchObject({
      evaluationMode: "measurement-only",
      releaseDecision: "blocked",
      blockerCodes: [
        "calibrated-holdout-not-qualified",
        "raw-asr-substitution-unqualified",
      ],
    });
    expect(evidence.ia2vEligibility.blockers).toEqual([
      "raw-asr-content-gate-not-passed",
      "word-error-rate-not-zero",
      "word-edit-counts-not-zero",
      "spoken-content-gate-not-passed",
    ]);
  });

  it("rejects rehashed IPA adjudication that changes target, phase or adds cleartext", async () => {
    const files = await setupFiles(Array.from({ length: 4_800 }, (_, index) =>
      [0, 16_384, -16_384, 8_192][index % 4]));
    const original = JSON.parse(files.ipaAdjudicationResultBytes.toString("utf8")) as Record<
      string,
      unknown
    >;
    for (const mutation of [
      (value: Record<string, unknown>) => { value.targetTextSha256 = "9".repeat(64); },
      (value: Record<string, unknown>) => { value.phaseSha256 = "a".repeat(64); },
      (value: Record<string, unknown>) => { value.targetText = "Hallo"; },
    ]) {
      const changed = structuredClone(original);
      mutation(changed);
      const bytes = Buffer.from(JSON.stringify(changed));
      await writeFile(files.ipaAdjudicationResult, bytes);
      const result = runCli(files.audio, files.audioSha256, files.ffmpeg, {
        ipaAdjudicationResult: files.ipaAdjudicationResult,
        expectedIpaAdjudicationResultSha256: sha256(bytes),
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(t2aAudioQualitySchema.parse(JSON.parse(result.stdout))).toMatchObject({
        analysisStatus: "failed",
        error: { code: "arguments-invalid" },
        ia2vEligibility: { status: "blocked", blockers: ["analysis-failed"] },
      });
    }
  });

  localFfmpegIt("parses a real pinned ffmpeg ebur128 run without invoking Whisper", async () => {
    if (!localFfmpeg) throw new Error("FFmpeg-Prüfung wurde ohne FFmpeg gestartet");
    const samples = Array.from({ length: 48_000 }, (_, index) => [0, 16_384, -16_384, 8_192][index % 4]);
    const fixture = await setupFiles(samples);
    expect(sha256(readFileSync(localFfmpeg))).toBe(T2A_FFMPEG_SHA256);
    const source = mockedAnalysisCode(fixture, [-55, -1]).replace(
      "    loudness_runner=loudness_stub,\n",
      "",
    );
    const result = runPython(source);

    expect(result.status, result.stderr).toBe(0);
    const evidence = t2aAudioQualitySchema.parse(JSON.parse(result.stdout));
    expect(evidence).toMatchObject({
      analysisStatus: "measured",
      loudness: {
        method: "ffmpeg-ebur128-peak-true.v1",
        ffmpegSha256: T2A_FFMPEG_SHA256,
      },
    });
    if (evidence.analysisStatus !== "measured") throw new Error("Unerwarteter Analysezustand");
    expect(Number.isFinite(evidence.loudness.integratedLufs)).toBe(true);
    expect(Number.isFinite(evidence.loudness.truePeakDbtp)).toBe(true);
  });

  it("reports rail samples, ceiling excess and positive True Peak as technical blockers", async () => {
    const files = await setupFiles([0, 32_767, -32_768, 1_000]);
    const result = runPython(mockedAnalysisCode(files, [-8, 0.1]));

    expect(result.status, result.stderr).toBe(0);
    const evidence = t2aAudioQualitySchema.parse(JSON.parse(result.stdout));
    expect(evidence.analysisStatus).toBe("measured");
    if (evidence.analysisStatus !== "measured") throw new Error("Unerwarteter Analysezustand");
    expect(evidence.pcm).toMatchObject({
      samplePeakLinear: 1,
      samplePeakDbfs: 0,
      fullScaleClippedSamples: 2,
      fullScaleClippedRatio: 0.5,
    });
    expect(evidence.ia2vEligibility).toEqual({
      schemaVersion: "t2a-ia2v-eligibility.v2",
      status: "blocked",
      blockers: [
        "full-scale-clipping-detected",
        "sample-peak-ceiling-exceeded",
        "true-peak-above-zero-dbtp",
        "spoken-content-gate-not-passed",
      ],
    });
  });

  it("keeps audio beyond 30 seconds measured but ineligible for the bounded dialogue path", async () => {
    const files = await setupFiles(new Array(1_488_000).fill(1_000));
    const result = runPython(mockedAnalysisCode(files, [-20, -10]));

    expect(result.status, result.stderr).toBe(0);
    const evidence = t2aAudioQualitySchema.parse(JSON.parse(result.stdout));
    expect(evidence).toMatchObject({
      analysisStatus: "measured",
      wav: { durationSeconds: 31 },
      ia2vEligibility: {
        status: "blocked",
        blockers: [
          "duration-exceeds-dialogue-window",
          "spoken-content-gate-not-passed",
        ],
      },
    });
  });

  it("emits one strict failure JSON document for hash mismatch, non-PCM16 and silence", async () => {
    const normal = await setupFiles([0, 1_000, -1_000, 0]);
    const eightBit = await setupFiles([128, 129, 127, 128], 8);
    const silent = await setupFiles([0, 0, 0, 0]);
    const cases = [
      [normal, "f".repeat(64), "audio-hash-mismatch"],
      [eightBit, eightBit.audioSha256, "wav-format-unsupported"],
      [silent, silent.audioSha256, "audio-silent"],
    ] as const;

    for (const [files, expectedHash, code] of cases) {
      const result = runCli(files.audio, expectedHash, files.ffmpeg);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      const evidence = t2aAudioQualitySchema.parse(JSON.parse(result.stdout));
      expect(evidence).toMatchObject({
        analysisStatus: "failed",
        error: { code },
        ia2vEligibility: { status: "blocked", blockers: ["analysis-failed"] },
      });
    }
  });

  it("rejects an arbitrary executable even when a caller could compute its matching hash", async () => {
    const files = await setupFiles([0, 1_000, -1_000, 0]);
    const attacker = join(files.root, "attacker-ffmpeg");
    await writeFile(attacker, "#!/bin/sh\nexit 0\n");
    await chmod(attacker, 0o700);
    const result = runCli(files.audio, files.audioSha256, attacker);

    expect(result.status).toBe(2);
    expect(t2aAudioQualitySchema.parse(JSON.parse(result.stdout))).toMatchObject({
      analysisStatus: "failed",
      error: { code: "ffmpeg-unverified" },
    });
  });

  it("rejects a regular Whisper checkpoint that does not match the fixed v1 pin", async () => {
    const files = await setupFiles([0, 1_000, -1_000, 0]);
    await writeFile(join(files.root, "local-whisper.pt"), "caller-controlled-checkpoint");
    const result = runCli(files.audio, files.audioSha256, files.ffmpeg);

    expect(result.status).toBe(2);
    expect(t2aAudioQualitySchema.parse(JSON.parse(result.stdout))).toMatchObject({
      analysisStatus: "failed",
      error: { code: "whisper-unverified" },
    });
  });

  it("rejects symlinked and oversized Whisper candidates before deserialization", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-t2a-whisper-pin-"));
    roots.push(root);
    const target = join(root, "target.pt");
    const linked = join(root, "linked.pt");
    const oversized = join(root, "oversized.pt");
    await writeFile(target, "model");
    await symlink(target, linked);
    await writeFile(oversized, "xx");
    const source = [
      "import importlib.util,json,pathlib",
      `runner=pathlib.Path(${JSON.stringify(runnerPath)})`,
      "spec=importlib.util.spec_from_file_location('ltx_t2a_audio_qa',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      `paths=[(pathlib.Path(${JSON.stringify(linked)}),module.MAX_WHISPER_BYTES),(pathlib.Path(${JSON.stringify(oversized)}),1)]`,
      "failures=[]",
      "for path,maximum in paths:",
      "    try:",
      "        module._read_stable_regular_file(path,expected_sha256=module.PINNED_WHISPER_SMALL_SHA256,maximum_bytes=maximum,failure_code='whisper-unverified',label='Whisper')",
      "    except module.AnalysisError as error:",
      "        failures.append(module.failure_document(error))",
      "    else:",
      "        raise AssertionError('unsafe Whisper candidate was accepted')",
      "print(json.dumps(failures))",
    ].join("\n");
    const result = runPython(source);

    expect(result.status, result.stderr).toBe(0);
    const failures = JSON.parse(result.stdout) as unknown[];
    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(t2aAudioQualitySchema.parse(failure)).toMatchObject({
        analysisStatus: "failed",
        error: { code: "whisper-unverified" },
      });
    }
  });

  it("rejects serializable incomplete and coercible dialogue dictionaries inside Python", () => {
    const source = [
      "import importlib.util,json,pathlib",
      `runner=pathlib.Path(${JSON.stringify(runnerPath)})`,
      "spec=importlib.util.spec_from_file_location('ltx_t2a_audio_qa',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      `valid=json.loads(${JSON.stringify(JSON.stringify(dialogueFixture()))})`,
      "low_confidence=dict(valid)",
      "low_confidence['guidedWords']=[dict(valid['guidedWords'][0],probability=0.2)]",
      "low_confidence['medianGuidedWordProbability']=0.2",
      "low_confidence['p10GuidedWordProbability']=0.2",
      "false_usable=dict(valid)",
      "false_usable['guidedWords']=[dict(valid['guidedWords'][0],usable=False)]",
      "false_usable['usableAlignedWordCount']=0",
      "false_usable['usableGuidedWordCoverage']=0",
      "zero_window=dict(valid)",
      "zero_window['guidedWords']=[dict(valid['guidedWords'][0],endSeconds=0.0,usable=True)]",
      "quantile_lie=dict(valid,medianGuidedWordProbability=0.8)",
      "boolean_index=dict(valid)",
      "boolean_index['guidedWords']=[dict(valid['guidedWords'][0],index=False)]",
      "utf16_word=dict(valid)",
      "utf16_word['guidedWords']=[dict(valid['guidedWords'][0],word='😀'*80)]",
      "unsafe_token=dict(valid)",
      "unsafe_token['guidedWords']=[dict(valid['guidedWords'][0],tokenIds=[module.MAX_SAFE_INTEGER+1])]",
      "cases=[{'status':'measured','modelName':'OpenAI Whisper small','modelSha256':module.PINNED_WHISPER_SMALL_SHA256,'detectedLanguage':'de','wordErrorRate':0,'substitutions':0,'deletions':0,'insertions':0,'expectedWordCount':1,'guidedAlignedWordCount':1,'guidedWordCoverage':1,'usableAlignedWordCount':1,'usableGuidedWordCoverage':1,'lowConfidenceAlignedWords':0,'alignmentStatus':'measured'},dict(valid,expectedWordCount=True),dict(valid,expectedTranscriptSha256='f'*64),low_confidence,false_usable,zero_window,quantile_lie,boolean_index,utf16_word,unsafe_token]",
      "failures=[]",
      "for candidate in cases:",
      "    try:",
      "        module.project_audio_dialogue_evaluation(candidate,'Hallo')",
      "    except module.AnalysisError as error:",
      "        failures.append(module.failure_document(error))",
      "    else:",
      "        raise AssertionError('hostile dialogue dictionary was accepted')",
      "print(json.dumps(failures))",
    ].join("\n");
    const result = runPython(source);

    expect(result.status, result.stderr).toBe(0);
    const failures = JSON.parse(result.stdout) as unknown[];
    expect(failures).toHaveLength(10);
    for (const failure of failures) {
      expect(t2aAudioQualitySchema.parse(failure)).toMatchObject({
        analysisStatus: "failed",
        error: { code: "internal-error" },
      });
    }
  });

  it("clips structured failure messages to the shared UTF-16 code-unit boundary", () => {
    const source = [
      "import importlib.util,json,pathlib",
      `runner=pathlib.Path(${JSON.stringify(runnerPath)})`,
      "spec=importlib.util.spec_from_file_location('ltx_t2a_audio_qa',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "print(json.dumps(module.failure_document(module.AnalysisError('internal-error','😀'*500)),ensure_ascii=False))",
    ].join("\n");
    const result = runPython(source);

    expect(result.status, result.stderr).toBe(0);
    const failure = t2aAudioQualitySchema.parse(JSON.parse(result.stdout));
    expect(failure.analysisStatus).toBe("failed");
    if (failure.analysisStatus !== "failed") throw new Error("Unerwarteter Analysezustand");
    expect(failure.error.message).toHaveLength(500);
  });

  it("keeps av_sync_proxy unreachable in audio-only dialogue evaluation and lazy in the video branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "ltx-dialogue-audio-only-"));
    roots.push(root);
    const model = join(root, "model.pt");
    const audio = join(root, "audio.wav");
    await writeFile(model, "local-model");
    await writeFile(audio, wavBuffer([0, 1_000, -1_000, 0]));
    const source = [
      "import builtins,hashlib,importlib.util,json,pathlib,sys,types",
      "import numpy as np",
      `runner=pathlib.Path(${JSON.stringify(join(appRoot, "scripts", "dialogue_word_evaluator.py"))})`,
      `model_path=pathlib.Path(${JSON.stringify(model)})`,
      `audio_path=pathlib.Path(${JSON.stringify(audio)})`,
      "real_import=builtins.__import__",
      "def guarded_import(name,*args,**kwargs):",
      "    if name == 'av_sync_proxy': raise AssertionError('AV worker entered audio-only path')",
      "    return real_import(name,*args,**kwargs)",
      "builtins.__import__=guarded_import",
      "spec=importlib.util.spec_from_file_location('ltx_dialogue_audio_only',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.normalized_words=lambda text:text.lower().split()",
      "module.guided_word_timings=lambda *values:[{'word':'Hallo','normalizedWord':'hallo','tokenIds':[1],'start':0.0,'end':0.5,'probability':0.9}]",
      "class Model:",
      "    def transcribe(self,*args,**kwargs): return {'text':'Hallo','language':'de'}",
      "fake_whisper=types.SimpleNamespace(audio=types.SimpleNamespace(N_SAMPLES=480000),load_model=lambda *args,**kwargs:Model(),load_audio=lambda path:np.asarray([0.1],dtype=np.float32))",
      "fake_torch=types.SimpleNamespace(set_num_threads=lambda value:None,set_num_interop_threads=lambda value:None)",
      "sys.modules['whisper']=fake_whisper",
      "sys.modules['torch']=fake_torch",
      "module.importlib.metadata.version=lambda name:'20250625'",
      "model_hash=hashlib.sha256(model_path.read_bytes()).hexdigest()",
      "audio_result=module.evaluate_dialogue(audio_path,'Hallo',[],1.0,True,model_path,model_hash,None,word_motion_enabled=False,raw_asr_content_gate_enabled=True)",
      "builtins.__import__=real_import",
      "calls=[]",
      "fake_av=types.ModuleType('av_sync_proxy')",
      "fake_av.motion_series=lambda candidates:(calls.append(list(candidates)) or (np.asarray([]),np.asarray([]),np.asarray([])))",
      "fake_av.robust_unit=lambda values:values",
      "fake_av.pearson=lambda left,right:None",
      "sys.modules['av_sync_proxy']=fake_av",
      "video_motion=module.word_motion_metrics([],[],None)",
      "print(json.dumps({'audio':audio_result,'videoMotion':video_motion,'calls':calls}))",
    ].join("\n");
    const result = runPython(source);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      audio: Record<string, unknown>;
      videoMotion: Record<string, unknown>;
      calls: unknown[];
    };
    expect(parsed.audio).toMatchObject({
      status: "measured",
      rawAsrContentGate: {
        status: "passed",
        targetConditioned: false,
        exactTokenMatch: true,
      },
      phonemeVerification: {
        status: "not-available",
        method: null,
      },
      trackedWordCount: 0,
      mouthTrackedWordCoverage: 0,
      wordsWithMouthMotionRatio: null,
      pauseMotionRatio: null,
      estimatedWordActivityLeadMilliseconds: null,
      lagResolutionMilliseconds: null,
      correlationPeak: null,
      nullP95Correlation: null,
      wordMotionProxyStatus: "not-applicable",
    });
    expect(parsed.videoMotion).toMatchObject({
      trackedWordCount: 0,
      wordMotionProxyStatus: "insufficient",
    });
    expect(parsed.calls).toEqual([[]]);
  });

  it("pins the exact local ffmpeg ebur128 command and requires finite summary values", () => {
    const source = [
      "import importlib.util,json,pathlib",
      `runner=pathlib.Path(${JSON.stringify(runnerPath)})`,
      "spec=importlib.util.spec_from_file_location('ltx_t2a_audio_qa',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "command=module.ffmpeg_ebur128_command(pathlib.Path('/verified/ffmpeg'),pathlib.Path('/snapshot/audio.wav'))",
      "values=module.parse_ebur128_output('Integrated loudness:\\n I: -8.1 LUFS\\nTrue peak:\\n Peak: -0.2 dBFS')",
      "try:",
      "    module.parse_ebur128_output('I: -inf LUFS\\nPeak: -inf dBFS')",
      "except module.AnalysisError as error:",
      "    failure=module.failure_document(error)",
      "else:",
      "    raise AssertionError('non-finite loudness was accepted')",
      "print(json.dumps({'command':command,'values':values,'failure':failure}))",
    ].join("\n");
    const result = runPython(source);

    expect(result.status, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed.command).toEqual([
      "/verified/ffmpeg",
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-v",
      "info",
      "-protocol_whitelist",
      "file,pipe",
      "-i",
      "/snapshot/audio.wav",
      "-filter_complex",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ]);
    expect(parsed.values).toEqual([-8.1, -0.2]);
    expect(t2aAudioQualitySchema.parse(parsed.failure)).toMatchObject({
      analysisStatus: "failed",
      error: { code: "loudness-measurement-failed" },
    });
  });

  it("forwards only the explicit offline allowlist to measurement subprocesses", () => {
    const source = [
      "import importlib.util,json,os,pathlib",
      `runner=pathlib.Path(${JSON.stringify(runnerPath)})`,
      "spec=importlib.util.spec_from_file_location('ltx_t2a_audio_qa',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "os.environ.update({'LD_PRELOAD':'hostile','LD_LIBRARY_PATH':'hostile','PYTHONPATH':'hostile','PYTHONINSPECT':'1','HTTP_PROXY':'hostile'})",
      "environment=module._offline_environment(pathlib.Path('/bound-runtime'))",
      "print(json.dumps(environment,sort_keys=True))",
    ].join("\n");
    const result = runPython(source);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      CUDA_VISIBLE_DEVICES: "",
      HF_DATASETS_OFFLINE: "1",
      HF_HUB_OFFLINE: "1",
      LANG: "C",
      LC_ALL: "C",
      NO_PROXY: "",
      PATH: "/bound-runtime",
      PYTHONNOUSERSITE: "1",
      TRANSFORMERS_OFFLINE: "1",
      no_proxy: "",
    });
  });

  it("fails before file access when the process inherits a connected socket", () => {
    const source = [
      "import importlib.util,json,pathlib,socket",
      "inherited=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)",
      "inherited.connect(('127.0.0.1',9))",
      `runner=pathlib.Path(${JSON.stringify(runnerPath)})`,
      "spec=importlib.util.spec_from_file_location('ltx_t2a_audio_qa',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module._read_stable_regular_file=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('file access preceded inherited-FD gate'))",
      `arguments=['--audio','/unused.wav','--expected-audio-sha256','a'*64,'--transcript','Hallo','--whisper-model','/unused.pt','--ffmpeg','/unused-ffmpeg','--peak-ceiling-dbfs','-3','--independent-ipa-observation','/unused-phase.json','--expected-independent-ipa-observation-sha256','b'*64,'--ipa-adjudication-result','/unused-adjudication.json','--expected-ipa-adjudication-result-sha256','c'*64,'--expected-ipa-adjudicator-runner-sha256',${JSON.stringify(T2A_IPA_ADJUDICATOR_RUNNER_SHA256)},'--expected-ipa-adjudication-policy-sha256',${JSON.stringify(T2A_IPA_ADJUDICATION_POLICY_SHA256)}]`,
      "status=module.main(arguments)",
      "inherited.close()",
      "raise SystemExit(status)",
    ].join("\n");
    const result = runPython(source);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(t2aAudioQualitySchema.parse(JSON.parse(result.stdout))).toMatchObject({
      analysisStatus: "failed",
      error: { code: "offline-runtime-unverified" },
    });
  });

  it("denies Python DNS and new IP sockets after the inherited-FD gate", () => {
    const source = [
      "import importlib.util,json,pathlib,socket",
      `runner=pathlib.Path(${JSON.stringify(runnerPath)})`,
      "spec=importlib.util.spec_from_file_location('ltx_t2a_audio_qa',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.enforce_offline_runtime()",
      "operations=[lambda:socket.getaddrinfo('example.invalid',443),lambda:socket.socket(socket.AF_INET,socket.SOCK_STREAM),lambda:socket.socket(socket.AF_INET6,socket.SOCK_DGRAM)]",
      "denied=[]",
      "for operation in operations:",
      "    try:",
      "        operation()",
      "    except RuntimeError as error:",
      "        denied.append(str(error))",
      "    else:",
      "        raise AssertionError('IP network activity was not denied')",
      "print(json.dumps({'denied':denied}))",
    ].join("\n");
    const result = runPython(source);

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      denied: new Array(3).fill("Netzwerkzugriffe sind im T2A-Audio-QA-Worker deaktiviert."),
    });
  });

  it("contains no remote model locator and invokes dialogue analysis without visual tracks", () => {
    const source = readFileSync(runnerPath, "utf8");
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/load_model\(\s*["']small["']/);
    expect(source).toContain("tracked_candidates=[]");
    expect(source).toContain('"HF_HUB_OFFLINE": "1"');
    expect(source).toContain("sys.addaudithook(_deny_ip_network)");
    expect(source).not.toContain("--expected-ffmpeg-sha256");
    expect(source).not.toContain("--expected-whisper-model-sha256");
  });

  it("returns structured JSON for CLI help instead of escaping through SystemExit", () => {
    const result = spawnSync(analysisPythonExecutable, ["-I", runnerPath, "--help"], {
      encoding: "utf8",
      timeout: 20_000,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(t2aAudioQualitySchema.parse(JSON.parse(result.stdout))).toMatchObject({
      analysisStatus: "failed",
      error: { code: "arguments-invalid" },
    });
  });

  it("turns an unserializable measured payload into one structured CLI failure", () => {
    const source = [
      "import importlib.util,math,pathlib",
      `runner=pathlib.Path(${JSON.stringify(runnerPath)})`,
      "spec=importlib.util.spec_from_file_location('ltx_t2a_audio_qa',runner)",
      "module=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "module.analyze_audio=lambda **values: {'notFinite':math.nan}",
      `arguments=['--audio','/unused.wav','--expected-audio-sha256','a'*64,'--transcript','Hallo','--whisper-model','/unused.pt','--ffmpeg','/unused-ffmpeg','--peak-ceiling-dbfs','-3','--independent-ipa-observation','/unused-phase.json','--expected-independent-ipa-observation-sha256','b'*64,'--ipa-adjudication-result','/unused-adjudication.json','--expected-ipa-adjudication-result-sha256','c'*64,'--expected-ipa-adjudicator-runner-sha256',${JSON.stringify(T2A_IPA_ADJUDICATOR_RUNNER_SHA256)},'--expected-ipa-adjudication-policy-sha256',${JSON.stringify(T2A_IPA_ADJUDICATION_POLICY_SHA256)}]`,
      "raise SystemExit(module.main(arguments))",
    ].join("\n");
    const result = runPython(source);

    expect(result.status).toBe(2);
    expect(result.stderr).toBe("");
    expect(t2aAudioQualitySchema.parse(JSON.parse(result.stdout))).toMatchObject({
      analysisStatus: "failed",
      error: { code: "internal-error" },
      ia2vEligibility: { status: "blocked", blockers: ["analysis-failed"] },
    });
  });
});
