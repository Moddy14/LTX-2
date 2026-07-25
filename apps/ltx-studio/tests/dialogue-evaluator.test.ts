import { readFileSync } from "node:fs";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  resolveDialogueEvaluatorState,
  WHISPER_SMALL_SHA256,
} from "../server/dialogueEvaluator.js";
import { appRoot, pythonExecutable, whisperModelPath } from "../server/config.js";
import {
  dialogueEvaluationSchema,
  type DialogueEvaluation,
} from "../shared/dialogueEvaluator.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function measuredDialogue(): DialogueEvaluation {
  return dialogueEvaluationSchema.parse({
    status: "measured",
    blockerCode: "none",
    error: null,
    method: "whisper-small-guided-word-motion.v1",
    modelName: "OpenAI Whisper small",
    modelSha256: WHISPER_SMALL_SHA256,
    packageVersion: "20250625",
    detectedLanguage: "de",
    expectedTranscriptSha256: "a".repeat(64),
    expectedWordCount: 2,
    recognizedWordCount: 2,
    recognizedTranscript: "Grüße jetzt",
    wordErrorRate: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
    guidedAlignedWordCount: 2,
    guidedWordCoverage: 1,
    usableAlignedWordCount: 2,
    usableGuidedWordCoverage: 1,
    medianGuidedWordProbability: 0.9,
    p10GuidedWordProbability: 0.8,
    lowConfidenceAlignedWords: 0,
    alignmentStatus: "measured",
    alignmentError: null,
    timePrecisionMilliseconds: 20,
    audioStartRelativeVideoSeconds: 0,
    guidedWords: [
      {
        index: 0,
        word: "Grüße",
        normalizedWord: "grüße",
        tokenIds: [1],
        startSeconds: 0,
        endSeconds: 0.5,
        probability: 0.8,
        usable: true,
      },
      {
        index: 1,
        word: "jetzt",
        normalizedWord: "jetzt",
        tokenIds: [2],
        startSeconds: 0.5,
        endSeconds: 1,
        probability: 1,
        usable: true,
      },
    ],
    trackedWordCount: 2,
    mouthTrackedWordCoverage: 1,
    wordsWithMouthMotionRatio: 1,
    pauseMotionRatio: 0,
    estimatedWordActivityLeadMilliseconds: 20,
    lagResolutionMilliseconds: 42,
    correlationPeak: 0.5,
    nullP95Correlation: 0.2,
    wordMotionProxyStatus: "measured",
  });
}

describe("Whisper dialogue evaluator contract", () => {
  it("normalizes Unicode text and reports exact, substitution, deletion and insertion counts", () => {
    const code = [
      "import json, pathlib, sys",
      `sys.path.insert(0, ${JSON.stringify(join(appRoot, "scripts"))})`,
      "from dialogue_word_evaluator import normalized_words, word_error_counts",
      "expected = normalized_words('Grüße, WELT!')",
      "print(json.dumps({",
      "  'expected': expected,",
      "  'exact': word_error_counts(expected, normalized_words('grüße welt')),",
      "  'substitution': word_error_counts(expected, normalized_words('grüße heute')),",
      "  'deletion': word_error_counts(expected, normalized_words('grüße')),",
      "  'insertion': word_error_counts(expected, normalized_words('grüße schöne welt')),",
      "}, ensure_ascii=False))",
    ].join("\n");
    const result = spawnSync(pythonExecutable, ["-c", code], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      expected: ["grüße", "welt"],
      exact: [0, 0, 0],
      substitution: [1, 0, 0],
      deletion: [0, 1, 0],
      insertion: [0, 0, 1],
    });
  });

  it("rejects target token sequences that exceed the decoder or per-word contract", () => {
    const code = [
      "import pathlib, sys",
      "from types import SimpleNamespace",
      `sys.path.insert(0, ${JSON.stringify(join(appRoot, "scripts"))})`,
      "from dialogue_word_evaluator import enforce_alignment_token_limits, TranscriptAlignmentLimitError",
      "class Tokenizer:",
      "    sot_sequence = [1, 2]",
      "    eot = 3",
      "    def split_to_word_tokens(self, tokens): return ['word', ''], [tokens[:-1], [tokens[-1]]]",
      "tokenizer = Tokenizer()",
      "cases = [(8, [1, 2, 3, 4, 5]), (64, list(range(33)))]",
      "for text_context, tokens in cases:",
      "    try:",
      "        model = SimpleNamespace(dims=SimpleNamespace(n_text_ctx=text_context))",
      "        enforce_alignment_token_limits(model, tokenizer, tokens)",
      "    except TranscriptAlignmentLimitError:",
      "        continue",
      "    raise AssertionError('token limit was not enforced')",
    ].join("\n");
    const result = spawnSync(pythonExecutable, ["-c", code], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it("binds measured words, counts, timing order and WER algebra", () => {
    const valid = measuredDialogue();
    expect(valid.guidedWords).toHaveLength(2);

    expect(dialogueEvaluationSchema.safeParse({
      ...valid,
      wordErrorRate: 0.5,
    }).success).toBe(false);
    expect(dialogueEvaluationSchema.safeParse({
      ...valid,
      guidedWords: [
        valid.guidedWords[1],
        valid.guidedWords[0],
      ],
    }).success).toBe(false);
    expect(dialogueEvaluationSchema.safeParse({
      ...valid,
      blockerCode: "alignment-insufficient",
    }).success).toBe(false);
    expect(dialogueEvaluationSchema.safeParse({
      ...valid,
      alignmentError: "darf bei gemessenem Alignment nicht gesetzt sein",
    }).success).toBe(false);
    expect(dialogueEvaluationSchema.safeParse({
      ...valid,
      status: "insufficient",
      blockerCode: "alignment-insufficient",
      error: "nicht ausreichend",
      alignmentStatus: "insufficient",
      alignmentError: null,
    }).success).toBe(false);
  });

  it("resolves only the official local checkpoint and fingerprints code plus runtime", async () => {
    const ready = resolveDialogueEvaluatorState(whisperModelPath, pythonExecutable);
    expect(ready).toMatchObject({
      status: "ready",
      blockerCode: "none",
      modelSha256: WHISPER_SMALL_SHA256,
      packageVersion: "20250625",
    });
    expect(ready.runnerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ready.runtimeFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(resolveDialogueEvaluatorState(whisperModelPath, pythonExecutable).fingerprint)
      .toBe(ready.fingerprint);

    const root = await mkdtemp(join(tmpdir(), "ltx-dialogue-state-"));
    roots.push(root);
    const wrong = join(root, "wrong.pt");
    const link = join(root, "linked.pt");
    await writeFile(wrong, "not-a-whisper-checkpoint");
    await symlink(whisperModelPath, link);
    expect(resolveDialogueEvaluatorState(wrong, pythonExecutable)).toMatchObject({
      status: "not-available",
      blockerCode: "model-invalid",
      modelSha256: null,
      runnerSha256: ready.runnerSha256,
    });
    expect(resolveDialogueEvaluatorState(link, pythonExecutable)).toMatchObject({
      status: "not-available",
      blockerCode: "model-invalid",
      modelSha256: null,
      runnerSha256: ready.runnerSha256,
    });
    expect(resolveDialogueEvaluatorState(join(root, "missing.pt"), pythonExecutable)).toMatchObject({
      status: "not-available",
      blockerCode: "model-missing",
      runnerSha256: ready.runnerSha256,
    });
  });

  it("loads the verified path directly and contains no named-model download path", () => {
    const source = readFileSync(join(appRoot, "scripts", "dialogue_word_evaluator.py"), "utf8");
    expect(source).toContain('whisper.load_model(\n            str(model_path)');
    expect(source).not.toMatch(/load_model\(\s*["']small["']/);
    expect(source).not.toContain("download_root=");
  });
});
