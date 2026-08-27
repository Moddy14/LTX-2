#!/usr/bin/env python3
"""Transcript fidelity and coarse word-window mouth-motion measurements."""

from __future__ import annotations

import hashlib
import importlib.metadata
import math
from collections import Counter
from pathlib import Path

import numpy as np

METHOD = "whisper-small-guided-word-motion.v1"
MODEL_NAME = "OpenAI Whisper small"
MAX_DURATION_SECONDS = 30.0
LAG_LIMIT_SECONDS = 0.5
LOW_WORD_PROBABILITY = 0.25
USABLE_WORD_PROBABILITY = 0.15
MAX_EXPECTED_WORDS = 200
MAX_WORD_TOKENS = 32
RAW_ASR_CONTENT_METHOD = "whisper-small-independent-raw-asr-token-edits.v1"
PHONEME_VERIFICATION_REASON = (
    "Kein unabhaengig gebundener Zweit-Recognizer oder Phonem-Scorer ist verfuegbar."
)


class TranscriptAlignmentLimitError(ValueError):
    """The exact target text cannot fit the bounded Whisper alignment contract."""


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def blank_result(
    status: str,
    error: str | None,
    *,
    expected_transcript_sha256: str | None,
    expected_word_count: int = 0,
) -> dict[str, object]:
    return {
        "status": status,
        "blockerCode": "none" if status == "measured" else "evaluator-failed",
        "error": error,
        "method": METHOD,
        "modelName": MODEL_NAME if status != "not-available" else None,
        "modelSha256": None,
        "packageVersion": None,
        "detectedLanguage": None,
        "expectedTranscriptSha256": expected_transcript_sha256,
        "expectedWordCount": expected_word_count,
        "recognizedWordCount": 0,
        "recognizedTranscript": None,
        "wordErrorRate": None,
        "substitutions": 0,
        "deletions": 0,
        "insertions": 0,
        "guidedAlignedWordCount": 0,
        "guidedWordCoverage": 0.0,
        "usableAlignedWordCount": 0,
        "usableGuidedWordCoverage": 0.0,
        "medianGuidedWordProbability": None,
        "p10GuidedWordProbability": None,
        "lowConfidenceAlignedWords": 0,
        "alignmentStatus": "not-applicable",
        "alignmentError": None,
        "timePrecisionMilliseconds": 20,
        "audioStartRelativeVideoSeconds": None,
        "guidedWords": [],
        "trackedWordCount": 0,
        "mouthTrackedWordCoverage": 0.0,
        "wordsWithMouthMotionRatio": None,
        "pauseMotionRatio": None,
        "estimatedWordActivityLeadMilliseconds": None,
        "lagResolutionMilliseconds": None,
        "correlationPeak": None,
        "nullP95Correlation": None,
        "wordMotionProxyStatus": "not-applicable",
    }


def normalized_words(text: str) -> list[str]:
    from whisper.normalizers import BasicTextNormalizer  # noqa: PLC0415

    return BasicTextNormalizer()(text).split()


def word_error_counts(
    expected: list[str],
    recognized: list[str],
) -> tuple[int, int, int]:
    """Return substitutions, deletions and insertions for minimum edit distance."""

    analysis = raw_asr_content_analysis(expected, recognized)
    return (
        len(analysis["substitutedWords"]),
        len(analysis["deletedExpectedWords"]),
        len(analysis["prefixInsertions"])
        + len(analysis["internalInsertions"])
        + len(analysis["suffixInsertions"]),
    )


def _word_edit_script(
    expected: list[str],
    recognized: list[str],
) -> list[dict[str, object]]:
    """Return a deterministic minimum-edit script with source positions."""

    rows = len(expected) + 1
    columns = len(recognized) + 1
    scores = [[(0, 0, 0, 0)] * columns for _ in range(rows)]
    backtrack: list[list[str | None]] = [[None] * columns for _ in range(rows)]
    for row in range(1, rows):
        scores[row][0] = (row, 0, row, 0)
        backtrack[row][0] = "deletion"
    for column in range(1, columns):
        scores[0][column] = (column, 0, 0, column)
        backtrack[0][column] = "insertion"
    for row in range(1, rows):
        for column in range(1, columns):
            if expected[row - 1] == recognized[column - 1]:
                scores[row][column] = scores[row - 1][column - 1]
                backtrack[row][column] = "match"
                continue
            candidates: list[tuple[tuple[int, int, int, int], str]] = []
            for previous, delta, operation in (
                (scores[row - 1][column - 1], (1, 1, 0, 0), "substitution"),
                (scores[row - 1][column], (1, 0, 1, 0), "deletion"),
                (scores[row][column - 1], (1, 0, 0, 1), "insertion"),
            ):
                candidates.append((
                    tuple(left + right for left, right in zip(previous, delta, strict=True)),
                    operation,
                ))
            scores[row][column], backtrack[row][column] = min(
                candidates,
                key=lambda item: (item[0][0], item[0][3], item[0][2], item[0][1]),
            )

    script: list[dict[str, object]] = []
    row = len(expected)
    column = len(recognized)
    while row > 0 or column > 0:
        operation = backtrack[row][column]
        if operation in {"match", "substitution"}:
            script.append({
                "operation": operation,
                "expectedIndex": row - 1,
                "recognizedIndex": column - 1,
                "expectedWord": expected[row - 1],
                "recognizedWord": recognized[column - 1],
            })
            row -= 1
            column -= 1
        elif operation == "deletion":
            script.append({
                "operation": operation,
                "expectedIndex": row - 1,
                "expectedWord": expected[row - 1],
            })
            row -= 1
        elif operation == "insertion":
            script.append({
                "operation": operation,
                "expectedPosition": row,
                "recognizedIndex": column - 1,
                "recognizedWord": recognized[column - 1],
            })
            column -= 1
        else:  # pragma: no cover - the initialized DP grid makes this unreachable
            raise RuntimeError("Die Raw-ASR-Editfolge ist unvollstaendig.")
    script.reverse()
    return script


def raw_asr_content_analysis(
    expected: list[str],
    recognized: list[str],
) -> dict[str, object]:
    """Classify literal Raw-ASR token edits without phonetic inference."""

    prefix_insertions: list[dict[str, object]] = []
    internal_insertions: list[dict[str, object]] = []
    suffix_insertions: list[dict[str, object]] = []
    deleted_words: list[dict[str, object]] = []
    substituted_words: list[dict[str, object]] = []
    repeated_insertions: list[dict[str, object]] = []
    expected_counts = Counter(expected)
    recognized_counts = Counter(recognized)
    for edit in _word_edit_script(expected, recognized):
        operation = edit["operation"]
        if operation == "deletion":
            deleted_words.append({
                "expectedIndex": edit["expectedIndex"],
                "word": edit["expectedWord"],
            })
        elif operation == "substitution":
            substituted_words.append({
                "expectedIndex": edit["expectedIndex"],
                "recognizedIndex": edit["recognizedIndex"],
                "expectedWord": edit["expectedWord"],
                "recognizedWord": edit["recognizedWord"],
            })
        elif operation == "insertion":
            insertion = {
                "recognizedIndex": edit["recognizedIndex"],
                "word": edit["recognizedWord"],
            }
            position = int(edit["expectedPosition"])
            if position == 0:
                prefix_insertions.append(insertion)
            elif position == len(expected):
                suffix_insertions.append(insertion)
            else:
                internal_insertions.append(insertion)
            word = str(edit["recognizedWord"])
            if recognized_counts[word] > max(1, expected_counts[word]):
                repeated_insertions.append(insertion)

    exact_match = expected == recognized
    return {
        "status": "passed" if exact_match else "failed",
        "method": RAW_ASR_CONTENT_METHOD,
        "targetConditioned": False,
        "exactTokenMatch": exact_match,
        "expectedNormalizedWords": expected,
        "recognizedNormalizedWords": recognized,
        "prefixInsertions": prefix_insertions,
        "internalInsertions": internal_insertions,
        "suffixInsertions": suffix_insertions,
        "deletedExpectedWords": deleted_words,
        "substitutedWords": substituted_words,
        "repeatedInsertions": repeated_insertions,
    }


def raw_asr_content_not_measured(expected: list[str]) -> dict[str, object]:
    return {
        "status": "not-measured",
        "method": RAW_ASR_CONTENT_METHOD,
        "targetConditioned": False,
        "exactTokenMatch": None,
        "expectedNormalizedWords": expected,
        "recognizedNormalizedWords": [],
        "prefixInsertions": [],
        "internalInsertions": [],
        "suffixInsertions": [],
        "deletedExpectedWords": [],
        "substitutedWords": [],
        "repeatedInsertions": [],
    }


def phoneme_verification_not_available() -> dict[str, object]:
    return {
        "status": "not-available",
        "method": None,
        "reason": PHONEME_VERIFICATION_REASON,
    }


def guided_word_timings(
    model: object,
    audio: np.ndarray,
    expected_transcript: str,
    language: str,
) -> list[dict[str, object]]:
    import torch  # noqa: PLC0415
    import whisper  # noqa: PLC0415
    from whisper.audio import N_FRAMES, N_SAMPLES  # noqa: PLC0415
    from whisper.timing import find_alignment  # noqa: PLC0415
    from whisper.tokenizer import get_tokenizer  # noqa: PLC0415

    tokenizer = get_tokenizer(
        model.is_multilingual,
        num_languages=model.num_languages,
        language=language,
        task="transcribe",
    )
    text_tokens = tokenizer.encode(expected_transcript)
    if not text_tokens:
        return []
    enforce_alignment_token_limits(model, tokenizer, text_tokens)
    clipped = audio[:N_SAMPLES]
    raw_mel = whisper.log_mel_spectrogram(
        clipped,
        n_mels=model.dims.n_mels,
    )
    num_frames = min(N_FRAMES, max(1, int(raw_mel.shape[-1])))
    mel = whisper.pad_or_trim(raw_mel, N_FRAMES).to(model.device).float()
    with torch.inference_mode():
        timings = find_alignment(model, tokenizer, text_tokens, mel, num_frames)
    return [
        {
            "word": timing.word.strip()[:80],
            "normalizedWord": " ".join(normalized_words(timing.word))[:80],
            "tokenIds": [int(token) for token in timing.tokens],
            "start": float(timing.start),
            "end": float(timing.end),
            "probability": float(timing.probability),
        }
        for timing in timings
        if normalized_words(timing.word) and float(timing.end) >= float(timing.start)
    ]


def enforce_alignment_token_limits(
    model: object,
    tokenizer: object,
    text_tokens: list[int],
) -> None:
    maximum_text_tokens = max(
        1,
        int(model.dims.n_text_ctx) - len(tokenizer.sot_sequence) - 2,
    )
    if len(text_tokens) > maximum_text_tokens:
        raise TranscriptAlignmentLimitError(
            f"Der Zieltext benötigt {len(text_tokens)} Whisper-Tokens; "
            f"höchstens {maximum_text_tokens} sind für die geführte Ausrichtung zulässig."
        )
    _, word_tokens = tokenizer.split_to_word_tokens([*text_tokens, tokenizer.eot])
    longest_word_tokens = max((len(tokens) for tokens in word_tokens[:-1]), default=0)
    if longest_word_tokens > MAX_WORD_TOKENS:
        raise TranscriptAlignmentLimitError(
            "Ein Zielwort überschreitet die Grenze von "
            f"{MAX_WORD_TOKENS} Whisper-Tokens für eine reproduzierbare Wortausrichtung."
        )


def word_motion_metrics(
    tracked_candidates: list[dict[str, object]],
    word_timings: list[dict[str, object]],
    audio_start_relative_video_seconds: float | None,
) -> dict[str, object]:
    from av_sync_proxy import motion_series, robust_unit  # noqa: PLC0415

    mouth_times, mouth_flow, mouth_appearance = motion_series(tracked_candidates)
    normalized_timings = [
        timing
        for timing in word_timings
        if bool(timing.get("usable"))
        and float(timing["endSeconds"]) > float(timing["startSeconds"])
    ]
    if (
        mouth_times.size < 12
        or not normalized_timings
        or audio_start_relative_video_seconds is None
    ):
        return {
            "trackedWordCount": 0,
            "mouthTrackedWordCoverage": 0.0,
            "wordsWithMouthMotionRatio": None,
            "pauseMotionRatio": None,
            "estimatedWordActivityLeadMilliseconds": None,
            "lagResolutionMilliseconds": None,
            "correlationPeak": None,
            "nullP95Correlation": None,
            "wordMotionProxyStatus": "insufficient",
        }

    combined_motion = (
        robust_unit(mouth_flow) + robust_unit(mouth_appearance)
    ) * 0.5
    motion_active = combined_motion >= 0.35
    word_masks = [
        (mouth_times >= float(timing["startSeconds"]) + audio_start_relative_video_seconds)
        & (mouth_times <= float(timing["endSeconds"]) + audio_start_relative_video_seconds)
        for timing in normalized_timings
    ]
    tracked_masks = [mask for mask in word_masks if bool(np.any(mask))]
    tracked_word_count = len(tracked_masks)
    words_with_motion = sum(bool(np.any(motion_active[mask])) for mask in tracked_masks)
    word_activity = np.zeros(mouth_times.shape, dtype=np.float64)
    for mask in word_masks:
        word_activity[mask] = 1.0
    pause_support = word_activity < 0.5
    pause_motion_ratio = (
        float(np.mean(motion_active[pause_support]))
        if int(np.count_nonzero(pause_support)) >= 4
        else None
    )

    lag_result = estimate_word_activity_lag(
        mouth_times,
        combined_motion,
        normalized_timings,
        audio_start_relative_video_seconds,
    )
    measured = tracked_word_count >= min(3, len(normalized_timings))
    return {
        "trackedWordCount": tracked_word_count,
        "mouthTrackedWordCoverage": tracked_word_count / len(normalized_timings),
        "wordsWithMouthMotionRatio": (
            words_with_motion / tracked_word_count if tracked_word_count else None
        ),
        "pauseMotionRatio": pause_motion_ratio,
        "wordMotionProxyStatus": "measured" if measured else "insufficient",
        **lag_result,
    }


def estimate_word_activity_lag(
    mouth_times: np.ndarray,
    mouth_motion: np.ndarray,
    word_timings: list[dict[str, object]],
    audio_start_relative_video_seconds: float,
) -> dict[str, object]:
    from av_sync_proxy import pearson  # noqa: PLC0415

    empty = {
        "estimatedWordActivityLeadMilliseconds": None,
        "lagResolutionMilliseconds": None,
        "correlationPeak": None,
        "nullP95Correlation": None,
    }
    if mouth_times.size < 24 or len(word_timings) < 3:
        return empty
    periods = np.diff(mouth_times)
    periods = periods[(periods > 0.005) & (periods <= 0.2)]
    if periods.size < 12:
        return empty
    period = float(np.median(periods))
    steps = max(1, math.floor(LAG_LIMIT_SECONDS / period))
    lags = np.arange(-steps, steps + 1, dtype=np.float64) * period
    support = (
        (mouth_times >= mouth_times[0] + LAG_LIMIT_SECONDS)
        & (mouth_times <= mouth_times[-1] - LAG_LIMIT_SECONDS)
    )
    if int(np.count_nonzero(support)) < 18:
        return empty

    def activity_at(times: np.ndarray) -> np.ndarray:
        activity = np.zeros(times.shape, dtype=np.float64)
        for timing in word_timings:
            start = float(timing["startSeconds"]) + audio_start_relative_video_seconds
            end = float(timing["endSeconds"]) + audio_start_relative_video_seconds
            activity[(times >= start) & (times <= end)] = 1.0
        return activity

    correlations = []
    for lag in lags:
        correlations.append(
            pearson(mouth_motion[support], activity_at(mouth_times[support] - lag))
        )
    finite = [
        (index, value)
        for index, value in enumerate(correlations)
        if value is not None and math.isfinite(value)
    ]
    if len(finite) < 5:
        return empty
    best_index, peak = max(finite, key=lambda item: item[1])

    base_activity = activity_at(mouth_times[support])
    null_peaks: list[float] = []
    rng = np.random.default_rng(0)
    if base_activity.size >= 24:
        minimum_roll = max(2, math.ceil(0.65 / period))
        if base_activity.size > minimum_roll * 2:
            for roll in rng.integers(
                minimum_roll,
                base_activity.size - minimum_roll,
                size=64,
            ):
                null_value = pearson(
                    mouth_motion[support],
                    np.roll(base_activity, int(roll)),
                )
                if null_value is not None:
                    null_peaks.append(null_value)
    null_p95 = (
        float(np.percentile(null_peaks, 95))
        if null_peaks
        else None
    )
    if null_p95 is None or peak < 0.15 or peak < null_p95 + 0.03:
        return {
            **empty,
            "lagResolutionMilliseconds": max(10, math.ceil(period * 1_000)),
            "correlationPeak": float(peak),
            "nullP95Correlation": null_p95,
        }
    return {
        "estimatedWordActivityLeadMilliseconds": round(float(lags[best_index]) * 1_000),
        "lagResolutionMilliseconds": max(10, math.ceil(period * 1_000)),
        "correlationPeak": float(peak),
        "nullP95Correlation": null_p95,
    }


def evaluate_dialogue(  # noqa: PLR0911, PLR0912, PLR0913, PLR0915, PLR0917
    video_path: Path,
    expected_transcript: str,
    tracked_candidates: list[dict[str, object]],
    duration_seconds: float | None,
    has_audio: bool | None,
    model_path: Path,
    expected_model_sha256: str,
    audio_start_relative_video_seconds: float | None,
    runtime_available: bool = True,
    runtime_error: str | None = None,
    unavailable_blocker: str = "runtime-unavailable",
    word_motion_enabled: bool = True,
    raw_asr_content_gate_enabled: bool = False,
) -> dict[str, object]:
    expected_sha256 = hashlib.sha256(expected_transcript.encode("utf-8")).hexdigest()
    expected_words_for_gate: list[str] = []
    raw_content_gate: dict[str, object] | None = None

    def finalize(result: dict[str, object]) -> dict[str, object]:
        if raw_asr_content_gate_enabled:
            result["rawAsrContentGate"] = (
                raw_content_gate
                if raw_content_gate is not None
                else raw_asr_content_not_measured(expected_words_for_gate)
            )
            result["phonemeVerification"] = phoneme_verification_not_available()
        return result

    if not expected_transcript.strip():
        result = blank_result(
            "not-applicable",
            "Im Dialogfeld ist kein auswertbarer exakter Wortlaut gespeichert.",
            expected_transcript_sha256=expected_sha256,
        )
        result["blockerCode"] = "target-transcript-missing"
        return finalize(result)
    if not runtime_available:
        result = blank_result(
            "not-available",
            runtime_error or "Die lokale Whisper-Laufzeit ist nicht verfügbar.",
            expected_transcript_sha256=expected_sha256,
        )
        result["blockerCode"] = (
            unavailable_blocker
            if unavailable_blocker in {"model-missing", "model-invalid", "runtime-unavailable"}
            else "runtime-unavailable"
        )
        return finalize(result)
    expected_words = normalized_words(expected_transcript)
    expected_words_for_gate = expected_words
    base = blank_result(
        "insufficient",
        None,
        expected_transcript_sha256=expected_sha256,
        expected_word_count=len(expected_words),
    )
    if not expected_words:
        result = blank_result(
            "not-applicable",
            "Im Dialogfeld ist kein auswertbarer exakter Wortlaut gespeichert.",
            expected_transcript_sha256=expected_sha256,
        )
        result["blockerCode"] = "target-transcript-missing"
        return finalize(result)
    if len(expected_words) > MAX_EXPECTED_WORDS:
        base["blockerCode"] = "target-transcript-too-long"
        base["error"] = f"Der Zieltext überschreitet {MAX_EXPECTED_WORDS} normalisierte Wörter."
        return finalize(base)
    if has_audio is not True:
        base["blockerCode"] = "audio-missing"
        base["error"] = "Die Ausgabe enthält keine auswertbare Audiospur."
        return finalize(base)
    if duration_seconds is None or not 0 < duration_seconds <= MAX_DURATION_SECONDS:
        base["blockerCode"] = "duration-out-of-range"
        base["error"] = (
            f"Die Wortauswertung unterstützt derzeit höchstens {MAX_DURATION_SECONDS:.0f} Sekunden."
        )
        return finalize(base)
    if not model_path.is_file():
        result = blank_result(
            "not-available",
            "Der lokale Whisper-small-Checkpoint ist nicht verfügbar.",
            expected_transcript_sha256=expected_sha256,
            expected_word_count=len(expected_words),
        )
        result["blockerCode"] = "model-missing"
        return finalize(result)
    actual_model_sha256 = file_sha256(model_path)
    if actual_model_sha256 != expected_model_sha256:
        result = blank_result(
            "not-available",
            "Der lokale Whisper-small-Checkpoint hat nicht die erwartete Prüfsumme.",
            expected_transcript_sha256=expected_sha256,
            expected_word_count=len(expected_words),
        )
        result["blockerCode"] = "model-invalid"
        return finalize(result)

    try:
        import whisper  # noqa: PLC0415

        package_version = importlib.metadata.version("openai-whisper")
        import torch  # noqa: PLC0415

        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        model = whisper.load_model(
            str(model_path),
            device="cpu",
        )
        audio = whisper.load_audio(str(video_path))
        audio = audio[: whisper.audio.N_SAMPLES]
        transcript = model.transcribe(
            audio,
            task="transcribe",
            fp16=False,
            temperature=0,
            condition_on_previous_text=False,
            word_timestamps=False,
            verbose=None,
        )
        recognized_transcript = str(transcript.get("text", "")).strip()
        recognized_words = normalized_words(recognized_transcript)
        raw_content_gate = raw_asr_content_analysis(expected_words, recognized_words)
        substitutions = len(raw_content_gate["substitutedWords"])
        deletions = len(raw_content_gate["deletedExpectedWords"])
        insertions = (
            len(raw_content_gate["prefixInsertions"])
            + len(raw_content_gate["internalInsertions"])
            + len(raw_content_gate["suffixInsertions"])
        )
        language = str(transcript.get("language") or "").strip().lower() or "en"
        base.update({
            "modelSha256": actual_model_sha256,
            "packageVersion": package_version,
            "detectedLanguage": language,
            "recognizedWordCount": len(recognized_words),
            "recognizedTranscript": recognized_transcript[:4_000],
            "wordErrorRate": (
                (substitutions + deletions + insertions) / len(expected_words)
            ),
            "substitutions": substitutions,
            "deletions": deletions,
            "insertions": insertions,
        })
        timings = guided_word_timings(
            model,
            audio,
            expected_transcript,
            language,
        )
        normalized_timings = []
        for timing in timings:
            word = str(timing["word"])
            normalized_word = str(timing["normalizedWord"])
            if not normalized_word:
                continue
            probability = float(timing["probability"])
            normalized_timings.append({
                "index": len(normalized_timings),
                "word": word[:80],
                "normalizedWord": normalized_word[:80],
                "tokenIds": [int(token) for token in timing["tokenIds"]],
                "startSeconds": float(timing["start"]),
                "endSeconds": float(timing["end"]),
                "probability": probability,
                "usable": (
                    probability >= USABLE_WORD_PROBABILITY
                    and float(timing["end"]) > float(timing["start"])
                    and 0 <= float(timing["start"]) <= MAX_DURATION_SECONDS
                    and 0 <= float(timing["end"]) <= MAX_DURATION_SECONDS
                ),
            })
        probabilities = [
            float(timing["probability"])
            for timing in normalized_timings
        ]
        usable_timings = [timing for timing in normalized_timings if bool(timing["usable"])]
        usable_coverage = min(1.0, len(usable_timings) / len(expected_words))
        minimum_usable = min(3, len(expected_words))
        alignment_measured = (
            len(usable_timings) >= minimum_usable
            and usable_coverage >= 0.7
        )
        motion = (
            word_motion_metrics(
                tracked_candidates,
                normalized_timings,
                audio_start_relative_video_seconds,
            )
            if word_motion_enabled
            else {
                "trackedWordCount": 0,
                "mouthTrackedWordCoverage": 0.0,
                "wordsWithMouthMotionRatio": None,
                "pauseMotionRatio": None,
                "estimatedWordActivityLeadMilliseconds": None,
                "lagResolutionMilliseconds": None,
                "correlationPeak": None,
                "nullP95Correlation": None,
                "wordMotionProxyStatus": "not-applicable",
            }
        )
        base.update({
            "status": "measured",
            "blockerCode": "none",
            "error": None,
            "guidedAlignedWordCount": len(normalized_timings),
            "guidedWordCoverage": min(
                1.0,
                len(normalized_timings) / len(expected_words),
            ),
            "usableAlignedWordCount": len(usable_timings),
            "usableGuidedWordCoverage": usable_coverage,
            "medianGuidedWordProbability": (
                float(np.median(probabilities)) if probabilities else None
            ),
            "p10GuidedWordProbability": (
                float(np.percentile(probabilities, 10)) if probabilities else None
            ),
            "lowConfidenceAlignedWords": sum(
                probability < LOW_WORD_PROBABILITY
                for probability in probabilities
            ),
            "alignmentStatus": "measured" if alignment_measured else "insufficient",
            "alignmentError": (
                None
                if alignment_measured
                else "Zu wenige hinreichend wahrscheinliche geführte Wortzeiten."
            ),
            "audioStartRelativeVideoSeconds": audio_start_relative_video_seconds,
            "guidedWords": normalized_timings[:MAX_EXPECTED_WORDS],
            **motion,
        })
        if not normalized_timings:
            base["alignmentStatus"] = "insufficient"
            base["alignmentError"] = "Whisper konnte keine geführten Wortzeiten bestimmen."
        if not alignment_measured:
            base["status"] = "insufficient"
            base["blockerCode"] = "alignment-insufficient"
            base["error"] = str(base["alignmentError"])
        elif file_sha256(model_path) != expected_model_sha256:
            raise RuntimeError("Whisper-small-Checkpoint wurde während der Analyse verändert.")
        return finalize(base)
    except TranscriptAlignmentLimitError as error:
        base["status"] = "insufficient"
        base["blockerCode"] = "target-transcript-too-long"
        base["error"] = str(error)[:500]
        base["alignmentStatus"] = "insufficient"
        base["alignmentError"] = str(error)[:500]
        return finalize(base)
    except Exception as error:
        base["status"] = "failed"
        base["blockerCode"] = "evaluator-failed"
        base["error"] = f"{type(error).__name__}: {error}"[:500]
        base["modelSha256"] = actual_model_sha256
        return finalize(base)
