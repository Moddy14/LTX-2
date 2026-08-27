#!/usr/bin/env python3
"""Deterministic raw IPA alignment with no threshold or release decision."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import math
import sys
import unicodedata
from pathlib import Path
from typing import NoReturn


REQUEST_SCHEMA = "ltx-studio-t2a-ipa-adjudicator-request.v1"
REFERENCE_SCHEMA = "ltx-studio-t2a-reference-ipa.v1"
RESULT_SCHEMA = "ltx-studio-t2a-ipa-adjudication-result.v1"
PHASE_SCHEMA = "ltx-studio-independent-ipa-phase.v2"
OBSERVATION_SCHEMA = "ltx-studio-independent-ipa-observation.v1"
G2P_RESULT_SCHEMA = "ltx-studio-t2a-german-g2p-result.v1"
CANONICALIZATION = "ltx-studio-canonical-json.v1"
DIGEST_ALGORITHM = "sha256"
MAX_REQUEST_BYTES = 1024 * 1024
MAX_PHASE_BYTES = 512 * 1024
MAX_REFERENCE_BYTES = 128 * 1024
MAX_TOKENS = 1_049
MAX_SAFE_INTEGER = 9_007_199_254_740_991
SHA256_CHARS = frozenset("0123456789abcdef")
IPA_VOCABULARY_SHA256 = "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0"
G2P_RUNNER_SHA256 = "a2f7259094b210c41a5ced987ed66ebfc7994736c3edb2141489ed782df831b8"
ESPEAK_BINARY_SHA256 = "89402b6a13d29ab2edb0570c809796751b22a5d031828897cfb1b370dafa9c29"
ESPEAK_DATA_MANIFEST_SHA256 = "a886ef7d07601c45d2982d91a546808f2cb1a99194ed07a443cb9d3839798658"
ESPEAK_RUNTIME_MANIFEST_SHA256 = "a29161e2a8d9ddc48735151319de1fcff03783262bbe63849ba2308bf0715939"
NORMALIZATION_POLICY_SHA256 = "c8ed3c0cb746212a9858bc028da8899ff411c1023c88b5b329e55e1e50c34563"
IPA_VOCABULARY_PATH = Path(
    "/var/lib/ltx-studio/models/facebook--wav2vec2-xlsr-53-espeak-cv-ft/"
    "2c733782da5604684829819a5eb744c193fe9398/vocab.json"
)
PHASE_FAILURE_CODES = frozenset({
    "arguments-invalid",
    "audio-snapshot-invalid",
    "audio-hash-mismatch",
    "wav-container-invalid",
    "wav-format-unsupported",
    "wav-data-invalid",
    "audio-silent",
    "ffmpeg-unverified",
    "offline-runtime-unverified",
    "independent-ipa-unverified",
    "independent-ipa-normalization-failed",
    "independent-ipa-failed",
    "independent-ipa-invalid",
    "independent-ipa-runner-failed",
    "internal-error",
})

ADJUDICATION_POLICY = {
    "schemaVersion": "ltx-studio-t2a-ipa-adjudication-policy.v1",
    "alignmentMethod": "levenshtein-unit-cost.v1",
    "hypothesisTokenSource": "independent-ipa-observation-token-symbols-exact.v1",
    "referenceTokenSource": "pinned-reference-ipa-tokens-exact.v1",
    "tokenNormalization": "none.v1",
    "tieBreak": "minimum-distance-insertions-deletions-substitutions.v1",
    "normalizedPhoneErrorRate": "edit-distance-divided-by-reference-token-count.v1",
    "maximumReferenceTokens": MAX_TOKENS,
    "maximumHypothesisTokens": MAX_TOKENS,
}


class AdjudicationError(RuntimeError):
    """The raw adjudication contract was not satisfied."""


def _canonical_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        indent=2,
        separators=(",", ": "),
        sort_keys=True,
    ) + "\n"


ADJUDICATION_POLICY_SHA256 = hashlib.sha256(
    _canonical_json(ADJUDICATION_POLICY).encode("utf-8"),
).hexdigest()


def _strict_json_loads(content: bytes, *, description: str) -> object:
    def reject_duplicates(pairs: list[tuple[str, object]]) -> dict[str, object]:
        value: dict[str, object] = {}
        for key, item in pairs:
            if key in value:
                raise AdjudicationError(f"Duplicate JSON key in {description}")
            value[key] = item
        return value

    def reject_constant(_value: str) -> NoReturn:
        raise AdjudicationError(f"Non-finite JSON number in {description}")

    try:
        return json.loads(
            content,
            object_pairs_hook=reject_duplicates,
            parse_constant=reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AdjudicationError(f"Invalid UTF-8 JSON in {description}") from error


def _expect_dict(value: object, keys: set[str], label: str) -> dict[str, object]:
    if not isinstance(value, dict) or set(value) != keys:
        raise AdjudicationError(f"Unexpected fields in {label}")
    return value


def _expect_sha256(value: object, label: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in SHA256_CHARS for character in value)
    ):
        raise AdjudicationError(f"Invalid SHA-256 in {label}")
    return value


def _expect_int(value: object, minimum: int, maximum: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise AdjudicationError(f"Invalid integer in {label}")
    return value


def _expect_number(value: object, minimum: float, maximum: float, label: str) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or not minimum <= value <= maximum
    ):
        raise AdjudicationError(f"Invalid finite number in {label}")
    return float(value)


def _expect_literal(value: object, expected: object, label: str) -> None:
    if type(value) is not type(expected) or value != expected:
        raise AdjudicationError(f"Unexpected literal in {label}")


def _decode_canonical_document(
    encoded: object,
    *,
    maximum_bytes: int,
    description: str,
) -> tuple[dict[str, object], str]:
    if not isinstance(encoded, str) or not encoded:
        raise AdjudicationError(f"Missing canonical {description}")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise AdjudicationError(f"Invalid canonical base64 for {description}") from error
    if not content or len(content) > maximum_bytes or base64.b64encode(content).decode("ascii") != encoded:
        raise AdjudicationError(f"Invalid canonical {description} size or encoding")
    value = _strict_json_loads(content, description=description)
    document = _expect_dict(value, set(value) if isinstance(value, dict) else set(), description)
    # The TypeScript authority validates and emits these exact canonical bytes.
    # Do not reserialize here: ECMAScript and CPython intentionally differ for
    # valid JSON numbers such as 1e-7, 1 versus 1.0, and negative zero. The
    # exact base64 bytes and their SHA-256 remain the cross-runtime authority.
    return document, hashlib.sha256(content).hexdigest()


def _validate_normalization(value: object) -> dict[str, object]:
    normalization = _expect_dict(value, {
        "method",
        "ffmpegSha256",
        "normalizedAudioSha256",
        "sampleRateHz",
        "channels",
        "durationMilliseconds",
    }, "phase normalization")
    _expect_literal(
        normalization["method"],
        "ffmpeg-pcm-s16le-mono-16khz-bitexact.v1",
        "normalization method",
    )
    _expect_literal(
        normalization["ffmpegSha256"],
        "9f126bd755615d8c5d9aa2e67c568626be05389feb795478e0f14d41217270f4",
        "ffmpeg digest",
    )
    _expect_sha256(normalization["normalizedAudioSha256"], "normalized audio")
    _expect_literal(normalization["sampleRateHz"], 16_000, "normalization sample rate")
    _expect_literal(normalization["channels"], 1, "normalization channels")
    _expect_int(normalization["durationMilliseconds"], 100, 21_000, "normalization duration")
    return normalization


def _validate_execution_boundary(value: object) -> None:
    boundary = _expect_dict(value, {
        "cpuOnly",
        "ipSocketFamiliesBlocked",
        "blockedNetworkErrno",
        "noNewPrivileges",
        "effectiveCapabilities",
        "memoryMaxBytes",
        "minimumCgroupHeadroomBytes",
        "swapMaxBytes",
        "pidsMax",
        "cpuMax",
    }, "execution boundary")
    expected = {
        "cpuOnly": True,
        "ipSocketFamiliesBlocked": ["AF_INET", "AF_INET6"],
        "blockedNetworkErrno": 97,
        "noNewPrivileges": True,
        "effectiveCapabilities": "0000000000000000",
        "memoryMaxBytes": 8 * 1024**3,
        "minimumCgroupHeadroomBytes": 6 * 1024**3,
        "swapMaxBytes": 0,
        "pidsMax": 64,
        "cpuMax": "200000 100000",
    }
    if boundary != expected:
        raise AdjudicationError("Execution-boundary evidence differs from phase v2")


def _validate_source_audio(value: object) -> dict[str, object]:
    source = _expect_dict(value, {
        "sha256",
        "sampleRateHz",
        "channels",
        "sampleCount",
        "durationMilliseconds",
    }, "normalized source audio")
    _expect_sha256(source["sha256"], "normalized source audio")
    _expect_literal(source["sampleRateHz"], 16_000, "source sample rate")
    _expect_literal(source["channels"], 1, "source channels")
    sample_count = _expect_int(source["sampleCount"], 1_600, 336_000, "source sample count")
    duration = _expect_int(source["durationMilliseconds"], 100, 21_000, "source duration")
    if duration != round(sample_count * 1_000 / 16_000):
        raise AdjudicationError("Source duration is not derived from sample count")
    return source


def _validate_token(
    value: object,
    frame_count: int,
    previous_end: int,
    vocabulary: dict[str, int],
) -> tuple[dict[str, object], int]:
    token = _expect_dict(value, {
        "tokenId",
        "symbol",
        "startFrame",
        "endFrameExclusive",
        "medianPosterior",
        "p10Posterior",
        "minimumTop1Margin",
        "unknown",
        "special",
    }, "IPA observation token")
    token_id = _expect_int(token["tokenId"], 0, 391, "IPA token ID")
    symbol = token["symbol"]
    if not isinstance(symbol, str) or not 1 <= len(symbol) <= 5:
        raise AdjudicationError("Invalid IPA observation token symbol")
    start = _expect_int(token["startFrame"], 0, MAX_SAFE_INTEGER, "IPA token start")
    end = _expect_int(token["endFrameExclusive"], 1, MAX_SAFE_INTEGER, "IPA token end")
    median = _expect_number(token["medianPosterior"], 0, 1, "median posterior")
    p10 = _expect_number(token["p10Posterior"], 0, 1, "p10 posterior")
    _expect_number(token["minimumTop1Margin"], 0, 1, "minimum top1 margin")
    if p10 > median or start < previous_end or end <= start or end > frame_count:
        raise AdjudicationError("Inconsistent IPA token observation")
    if not isinstance(token["unknown"], bool) or token["unknown"] != (token_id == 3):
        raise AdjudicationError("Unknown IPA token flag is inconsistent")
    if not isinstance(token["special"], bool) or token["special"] != (token_id in {1, 2}):
        raise AdjudicationError("Special IPA token flag is inconsistent")
    if token_id == 0:
        raise AdjudicationError("Blank token remained in IPA observation")
    if vocabulary.get(symbol) != token_id:
        raise AdjudicationError(
            "Independent IPA token ID and symbol differ from the pinned vocabulary"
        )
    return token, end


def _validate_observation_payload(
    value: object,
    vocabulary: dict[str, int],
) -> dict[str, object]:
    payload = _expect_dict(value, {
        "frameCount",
        "outputStrideSamples",
        "receptiveFieldSamples",
        "blankTokenId",
        "unknownTokenId",
        "decodedIpa",
        "unknownTokenCount",
        "specialTokenCount",
        "blankFrameRatio",
        "tokens",
    }, "IPA observation payload")
    frame_count = _expect_int(payload["frameCount"], 4, 1_049, "frame count")
    _expect_literal(payload["outputStrideSamples"], 320, "output stride")
    _expect_literal(payload["receptiveFieldSamples"], 400, "receptive field")
    _expect_literal(payload["blankTokenId"], 0, "blank token")
    _expect_literal(payload["unknownTokenId"], 3, "unknown token")
    _expect_number(payload["blankFrameRatio"], 0, 1, "blank-frame ratio")
    tokens_value = payload["tokens"]
    if not isinstance(tokens_value, list) or len(tokens_value) > MAX_TOKENS:
        raise AdjudicationError("Invalid IPA observation token sequence")
    tokens: list[dict[str, object]] = []
    previous_end = 0
    for value_token in tokens_value:
        token, previous_end = _validate_token(
            value_token, frame_count, previous_end, vocabulary
        )
        tokens.append(token)
    decoded = payload["decodedIpa"]
    if not isinstance(decoded, str) or len(decoded) > 256 * 1024:
        raise AdjudicationError("Invalid decoded IPA")
    if decoded != " ".join(str(token["symbol"]) for token in tokens):
        raise AdjudicationError("Decoded IPA differs from exact token symbols")
    unknown_count = _expect_int(payload["unknownTokenCount"], 0, MAX_SAFE_INTEGER, "unknown count")
    special_count = _expect_int(payload["specialTokenCount"], 0, MAX_SAFE_INTEGER, "special count")
    if unknown_count != sum(token["unknown"] is True for token in tokens):
        raise AdjudicationError("Unknown-token count mismatch")
    if special_count != sum(token["special"] is True for token in tokens):
        raise AdjudicationError("Special-token count mismatch")
    return payload


def _validate_measured_observation(
    value: object,
    vocabulary: dict[str, int],
) -> dict[str, object]:
    observation = _expect_dict(value, {
        "schemaVersion",
        "status",
        "error",
        "method",
        "decoderPolicy",
        "targetConditioned",
        "runnerSha256",
        "executionBoundary",
        "sourceAudio",
        "modelFingerprint",
        "modelManifestSha256",
        "modelWeightSha256",
        "runtime",
        "observation",
    }, "measured IPA observation")
    expected_literals = {
        "schemaVersion": OBSERVATION_SCHEMA,
        "status": "measured",
        "error": None,
        "method": "xlsr53-espeak-cv-free-ctc-greedy.v1",
        "decoderPolicy": "ctc-collapse-runs-then-remove-blank.v1",
        "targetConditioned": False,
    }
    for key, expected in expected_literals.items():
        _expect_literal(observation[key], expected, f"observation {key}")
    _expect_sha256(observation["runnerSha256"], "independent IPA runner")
    _expect_sha256(observation["modelFingerprint"], "IPA model fingerprint")
    _expect_sha256(observation["modelManifestSha256"], "IPA model manifest")
    _expect_sha256(observation["modelWeightSha256"], "IPA model weight")
    _validate_execution_boundary(observation["executionBoundary"])
    _validate_source_audio(observation["sourceAudio"])
    runtime = _expect_dict(
        observation["runtime"],
        {"python", "torch", "transformers", "safetensors"},
        "IPA runtime",
    )
    if runtime != {
        "python": "3.12.3",
        "torch": "2.13.0+cu132",
        "transformers": "5.14.1",
        "safetensors": "0.8.0",
    }:
        raise AdjudicationError("IPA runtime pins differ from phase v2")
    _validate_observation_payload(observation["observation"], vocabulary)
    return observation


def _validate_phase(
    value: dict[str, object],
    vocabulary: dict[str, int],
) -> dict[str, object]:
    phase = _expect_dict(value, {
        "schemaVersion",
        "status",
        "reasonCode",
        "authorityAudioSha256",
        "sourceAudioSha256",
        "normalization",
        "observation",
        "error",
    }, "independent IPA phase")
    _expect_literal(phase["schemaVersion"], PHASE_SCHEMA, "phase schema")
    authority = _expect_sha256(phase["authorityAudioSha256"], "authority audio")
    status = phase["status"]
    if status == "measured":
        _expect_literal(phase["reasonCode"], None, "measured reason")
        source = _expect_sha256(phase["sourceAudioSha256"], "source audio")
        if source != authority:
            raise AdjudicationError("Measured source and authority audio differ")
        normalization = _validate_normalization(phase["normalization"])
        observation = _validate_measured_observation(phase["observation"], vocabulary)
        _expect_literal(phase["error"], None, "measured error")
        source_audio = observation["sourceAudio"]
        if (
            normalization["normalizedAudioSha256"] != source_audio["sha256"]
            or normalization["durationMilliseconds"] != source_audio["durationMilliseconds"]
        ):
            raise AdjudicationError("Measured normalized-audio binding mismatch")
    elif status == "insufficient":
        _expect_literal(
            phase["reasonCode"],
            "duration-exceeds-independent-ipa-window",
            "insufficient reason",
        )
        source = _expect_sha256(phase["sourceAudioSha256"], "source audio")
        if source != authority:
            raise AdjudicationError("Insufficient source and authority audio differ")
        for key in ("normalization", "observation", "error"):
            _expect_literal(phase[key], None, f"insufficient {key}")
    elif status == "failed":
        reason = phase["reasonCode"]
        if not isinstance(reason, str) or reason not in PHASE_FAILURE_CODES:
            raise AdjudicationError("Invalid phase failure code")
        source = _expect_sha256(phase["sourceAudioSha256"], "source audio", nullable=True)
        if source is not None and source != authority:
            raise AdjudicationError("Failed source and authority audio differ")
        normalization = None
        if phase["normalization"] is not None:
            normalization = _validate_normalization(phase["normalization"])
        _expect_literal(phase["observation"], None, "failed observation")
        error = _expect_dict(phase["error"], {"code", "message"}, "phase error")
        if error["code"] != reason:
            raise AdjudicationError("Phase error code differs from reason")
        message = error["message"]
        if not isinstance(message, str) or not 1 <= len(message) <= 500:
            raise AdjudicationError("Invalid phase error message")
        if normalization is not None and source is None:
            raise AdjudicationError("Normalization lacks source-audio evidence")
        if reason == "independent-ipa-runner-failed" and (source is None or normalization is None):
            raise AdjudicationError("Runner failure lacks completed source and normalization evidence")
    else:
        raise AdjudicationError("Unsupported independent IPA phase status")
    return phase


def _is_default_ignorable_codepoint(codepoint: int) -> bool:
    return (
        codepoint in {0x00AD, 0x034F, 0x061C, 0x3164, 0xFEFF, 0xFFA0}
        or 0x115F <= codepoint <= 0x1160
        or 0x17B4 <= codepoint <= 0x17B5
        or 0x180B <= codepoint <= 0x180F
        or 0x200B <= codepoint <= 0x200F
        or 0x202A <= codepoint <= 0x202E
        or 0x2060 <= codepoint <= 0x206F
        or 0xFE00 <= codepoint <= 0xFE0F
        or 0xFFF0 <= codepoint <= 0xFFF8
        or 0x1BCA0 <= codepoint <= 0x1BCA3
        or 0x1D173 <= codepoint <= 0x1D17A
        or 0xE0000 <= codepoint <= 0xE0FFF
    )


def _valid_reference_token(value: object) -> bool:
    return (
        isinstance(value, str)
        and 1 <= len(value) <= 32
        and value == unicodedata.normalize("NFC", value)
        and all(
            not character.isspace()
            and ord(character) >= 0x21
            and ord(character) != 0x7F
            and not 0x80 <= ord(character) <= 0x9F
            and not 0xD800 <= ord(character) <= 0xDFFF
            and not _is_default_ignorable_codepoint(ord(character))
            for character in value
        )
    )


def _load_pinned_ipa_vocabulary() -> dict[str, int]:
    try:
        content = IPA_VOCABULARY_PATH.read_bytes()
    except OSError as error:
        raise AdjudicationError("Pinned IPA vocabulary is unavailable") from error
    if (
        not content
        or len(content) > 1024 * 1024
        or hashlib.sha256(content).hexdigest() != IPA_VOCABULARY_SHA256
    ):
        raise AdjudicationError("Pinned IPA vocabulary digest mismatch")
    raw = _strict_json_loads(content, description="IPA vocabulary")
    vocabulary = _expect_dict(raw, set(raw) if isinstance(raw, dict) else set(), "IPA vocabulary")
    if len(vocabulary) != 392:
        raise AdjudicationError("Pinned IPA vocabulary has the wrong size")
    ids: set[int] = set()
    for token, raw_id in vocabulary.items():
        token_id = _expect_int(raw_id, 0, 391, "IPA vocabulary token ID")
        if token_id in ids or not token:
            raise AdjudicationError("Pinned IPA vocabulary is not a token-ID bijection")
        ids.add(token_id)
    for token, expected_id in (("<pad>", 0), ("<s>", 1), ("</s>", 2), ("<unk>", 3), ("??", 85)):
        if vocabulary.get(token) != expected_id:
            raise AdjudicationError("Pinned IPA vocabulary authority differs")
    return {token: int(token_id) for token, token_id in vocabulary.items()}


def _validate_g2p_result(
    value: dict[str, object],
    vocabulary: dict[str, int],
) -> dict[str, object]:
    result = _expect_dict(value, {
        "schemaVersion", "status", "locale", "targetTextSha256",
        "normalizedTargetTextSha256", "g2pRunnerSha256", "espeakBinarySha256",
        "espeakDataManifestSha256", "espeakRuntimeManifestSha256",
        "ipaVocabularySha256", "normalizationPolicySha256", "espeakStdoutSha256",
        "tokenization", "referenceIpaTokens",
    }, "German G2P result")
    for key, expected in {
        "schemaVersion": G2P_RESULT_SCHEMA,
        "status": "generated",
        "locale": "de-DE",
        "g2pRunnerSha256": G2P_RUNNER_SHA256,
        "espeakBinarySha256": ESPEAK_BINARY_SHA256,
        "espeakDataManifestSha256": ESPEAK_DATA_MANIFEST_SHA256,
        "espeakRuntimeManifestSha256": ESPEAK_RUNTIME_MANIFEST_SHA256,
        "ipaVocabularySha256": IPA_VOCABULARY_SHA256,
        "normalizationPolicySha256": NORMALIZATION_POLICY_SHA256,
        "tokenization": "espeak-reference-ipa-token-sequence.v1",
    }.items():
        _expect_literal(result[key], expected, f"German G2P result {key}")
    for key in (
        "targetTextSha256", "normalizedTargetTextSha256", "g2pRunnerSha256",
        "espeakBinarySha256", "espeakDataManifestSha256",
        "espeakRuntimeManifestSha256", "ipaVocabularySha256",
        "normalizationPolicySha256", "espeakStdoutSha256",
    ):
        _expect_sha256(result[key], f"German G2P result {key}")
    tokens = result["referenceIpaTokens"]
    allowed_vocabulary = {
        token for token, token_id in vocabulary.items() if token_id >= 4
    }
    if (
        not isinstance(tokens, list)
        or not 1 <= len(tokens) <= MAX_TOKENS
        or any(
            not _valid_reference_token(token) or token not in allowed_vocabulary
            for token in tokens
        )
    ):
        raise AdjudicationError("Invalid pinned German G2P result tokens")
    return result


def _validate_reference(value: dict[str, object]) -> dict[str, object]:
    reference = _expect_dict(value, {
        "schemaVersion",
        "canonicalization",
        "digestAlgorithm",
        "locale",
        "authorityAudioSha256",
        "sourceAudioSha256",
        "normalizedAudioSha256",
        "targetTextSha256",
        "normalizedTargetTextSha256",
        "g2pRunnerSha256",
        "espeakBinarySha256",
        "espeakDataManifestSha256",
        "espeakRuntimeManifestSha256",
        "ipaVocabularySha256",
        "normalizationPolicySha256",
        "espeakStdoutSha256",
        "g2pResultSha256",
        "adjudicatorRunnerSha256",
        "adjudicationPolicySha256",
        "tokenization",
        "referenceIpaTokens",
    }, "reference IPA")
    literals = {
        "schemaVersion": REFERENCE_SCHEMA,
        "canonicalization": CANONICALIZATION,
        "digestAlgorithm": DIGEST_ALGORITHM,
        "locale": "de-DE",
        "g2pRunnerSha256": G2P_RUNNER_SHA256,
        "espeakBinarySha256": ESPEAK_BINARY_SHA256,
        "espeakDataManifestSha256": ESPEAK_DATA_MANIFEST_SHA256,
        "espeakRuntimeManifestSha256": ESPEAK_RUNTIME_MANIFEST_SHA256,
        "ipaVocabularySha256": IPA_VOCABULARY_SHA256,
        "normalizationPolicySha256": NORMALIZATION_POLICY_SHA256,
        "adjudicationPolicySha256": ADJUDICATION_POLICY_SHA256,
        "tokenization": "espeak-reference-ipa-token-sequence.v1",
    }
    for key, expected in literals.items():
        _expect_literal(reference[key], expected, f"reference {key}")
    _expect_sha256(reference["authorityAudioSha256"], "reference authority audio")
    source = _expect_sha256(reference["sourceAudioSha256"], "reference source audio", nullable=True)
    normalized = _expect_sha256(
        reference["normalizedAudioSha256"],
        "reference normalized audio",
        nullable=True,
    )
    if normalized is not None and source is None:
        raise AdjudicationError("Reference normalized audio lacks source binding")
    pin_keys = (
        "g2pRunnerSha256",
        "espeakBinarySha256",
        "espeakDataManifestSha256",
        "espeakRuntimeManifestSha256",
        "ipaVocabularySha256",
        "normalizationPolicySha256",
        "adjudicatorRunnerSha256",
        "adjudicationPolicySha256",
    )
    pins = [_expect_sha256(reference[key], f"reference {key}") for key in pin_keys]
    if len(set(pins)) != len(pins):
        raise AdjudicationError("Reference production and adjudication pins are not distinct")
    _expect_sha256(reference["targetTextSha256"], "target text")
    _expect_sha256(reference["normalizedTargetTextSha256"], "normalized target text")
    _expect_sha256(reference["espeakStdoutSha256"], "eSpeak stdout")
    _expect_sha256(reference["g2pResultSha256"], "German G2P result")
    tokens = reference["referenceIpaTokens"]
    if (
        not isinstance(tokens, list)
        or not 1 <= len(tokens) <= MAX_TOKENS
        or any(not _valid_reference_token(token) for token in tokens)
    ):
        raise AdjudicationError("Invalid bounded reference IPA token sequence")
    return reference


def _assert_audio_bindings(phase: dict[str, object], reference: dict[str, object]) -> None:
    normalization = phase["normalization"]
    normalized = (
        normalization["normalizedAudioSha256"]
        if isinstance(normalization, dict)
        else None
    )
    if (
        reference["authorityAudioSha256"] != phase["authorityAudioSha256"]
        or reference["sourceAudioSha256"] != phase["sourceAudioSha256"]
        or reference["normalizedAudioSha256"] != normalized
    ):
        raise AdjudicationError("IPA adjudication audio binding mismatch")


AlignmentState = tuple[int, int, int, int]


def _add_state(
    state: AlignmentState,
    substitutions: int,
    deletions: int,
    insertions: int,
) -> AlignmentState:
    return (
        state[0] + substitutions + deletions + insertions,
        state[1] + substitutions,
        state[2] + deletions,
        state[3] + insertions,
    )


def _raw_alignment(reference: list[str], hypothesis: list[str]) -> dict[str, int | float]:
    previous: list[AlignmentState] = [
        (index, 0, 0, index)
        for index in range(len(hypothesis) + 1)
    ]
    for row in range(1, len(reference) + 1):
        current: list[AlignmentState] = [(row, 0, row, 0)]
        for column in range(1, len(hypothesis) + 1):
            if reference[row - 1] == hypothesis[column - 1]:
                current.append(previous[column - 1])
                continue
            candidates = (
                (_add_state(previous[column - 1], 1, 0, 0), 0),
                (_add_state(previous[column], 0, 1, 0), 1),
                (_add_state(current[column - 1], 0, 0, 1), 2),
            )
            state, _rank = min(
                candidates,
                key=lambda item: (
                    item[0][0],
                    item[0][3],
                    item[0][2],
                    item[0][1],
                    item[1],
                ),
            )
            current.append(state)
        previous = current
    distance, substitutions, deletions, insertions = previous[len(hypothesis)]
    rate: int | float = distance / len(reference)
    if float(rate).is_integer():
        rate = int(rate)
    return {
        "substitutions": substitutions,
        "deletions": deletions,
        "insertions": insertions,
        "editDistance": distance,
        "referenceTokenCount": len(reference),
        "hypothesisTokenCount": len(hypothesis),
        "normalizedPhoneErrorRate": rate,
    }


def _read_request(*, expected_request_sha256: str) -> dict[str, object]:
    content = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not content or len(content) > MAX_REQUEST_BYTES:
        raise AdjudicationError("Adjudicator request is empty or too large")
    if hashlib.sha256(content).hexdigest() != expected_request_sha256:
        raise AdjudicationError("Adjudicator request digest mismatch")
    value = _strict_json_loads(content, description="adjudicator request")
    request = _expect_dict(value, {
        "schemaVersion",
        "phaseCanonicalJsonBase64",
        "referenceCanonicalJsonBase64",
        "g2pResultCanonicalJsonBase64",
        "phaseSha256",
        "referenceSha256",
        "runnerSha256",
        "policySha256",
        "g2pRunnerSha256",
        "espeakBinarySha256",
        "espeakDataManifestSha256",
        "espeakRuntimeManifestSha256",
        "ipaVocabularySha256",
        "normalizationPolicySha256",
        "targetTextSha256",
        "normalizedTargetTextSha256",
        "espeakStdoutSha256",
        "g2pResultSha256",
    }, "adjudicator request")
    try:
        canonical_request = _canonical_json(request).encode("utf-8")
    except UnicodeEncodeError as error:
        raise AdjudicationError("Invalid Unicode in adjudicator request") from error
    if canonical_request != content:
        raise AdjudicationError("Adjudicator request is not canonical JSON")
    _expect_literal(request["schemaVersion"], REQUEST_SCHEMA, "request schema")
    for key in (
        "runnerSha256",
        "phaseSha256",
        "referenceSha256",
        "policySha256",
        "g2pRunnerSha256",
        "espeakBinarySha256",
        "espeakDataManifestSha256",
        "espeakRuntimeManifestSha256",
        "ipaVocabularySha256",
        "normalizationPolicySha256",
        "targetTextSha256",
        "normalizedTargetTextSha256",
        "espeakStdoutSha256",
        "g2pResultSha256",
    ):
        _expect_sha256(request[key], f"request {key}")
    _expect_literal(request["policySha256"], ADJUDICATION_POLICY_SHA256, "request policy")
    for key, expected in {
        "g2pRunnerSha256": G2P_RUNNER_SHA256,
        "espeakBinarySha256": ESPEAK_BINARY_SHA256,
        "espeakDataManifestSha256": ESPEAK_DATA_MANIFEST_SHA256,
        "espeakRuntimeManifestSha256": ESPEAK_RUNTIME_MANIFEST_SHA256,
        "ipaVocabularySha256": IPA_VOCABULARY_SHA256,
        "normalizationPolicySha256": NORMALIZATION_POLICY_SHA256,
    }.items():
        _expect_literal(request[key], expected, f"request {key}")
    return request


def _adjudicate(
    request: dict[str, object],
    *,
    expected_runner_sha256: str,
    expected_phase_sha256: str,
    expected_reference_sha256: str,
    expected_g2p_result_sha256: str,
) -> dict[str, object]:
    phase, phase_sha256 = _decode_canonical_document(
        request["phaseCanonicalJsonBase64"],
        maximum_bytes=MAX_PHASE_BYTES,
        description="independent IPA phase",
    )
    reference, reference_sha256 = _decode_canonical_document(
        request["referenceCanonicalJsonBase64"],
        maximum_bytes=MAX_REFERENCE_BYTES,
        description="reference IPA",
    )
    g2p_result, g2p_result_sha256 = _decode_canonical_document(
        request["g2pResultCanonicalJsonBase64"],
        maximum_bytes=256 * 1024,
        description="German G2P result",
    )
    vocabulary = _load_pinned_ipa_vocabulary()
    _validate_phase(phase, vocabulary)
    _validate_reference(reference)
    _validate_g2p_result(g2p_result, vocabulary)
    actual_runner_sha256 = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    pin_pairs = (
        (reference["adjudicatorRunnerSha256"], request["runnerSha256"]),
        (reference["g2pRunnerSha256"], request["g2pRunnerSha256"]),
        (reference["espeakBinarySha256"], request["espeakBinarySha256"]),
        (reference["espeakDataManifestSha256"], request["espeakDataManifestSha256"]),
        (reference["espeakRuntimeManifestSha256"], request["espeakRuntimeManifestSha256"]),
        (reference["ipaVocabularySha256"], request["ipaVocabularySha256"]),
        (reference["normalizationPolicySha256"], request["normalizationPolicySha256"]),
        (reference["adjudicationPolicySha256"], request["policySha256"]),
        (reference["targetTextSha256"], request["targetTextSha256"]),
        (reference["normalizedTargetTextSha256"], request["normalizedTargetTextSha256"]),
        (reference["espeakStdoutSha256"], request["espeakStdoutSha256"]),
        (reference["g2pResultSha256"], request["g2pResultSha256"]),
    )
    result_pairs = (
        (g2p_result["targetTextSha256"], reference["targetTextSha256"]),
        (g2p_result["normalizedTargetTextSha256"], reference["normalizedTargetTextSha256"]),
        (g2p_result["g2pRunnerSha256"], reference["g2pRunnerSha256"]),
        (g2p_result["espeakBinarySha256"], reference["espeakBinarySha256"]),
        (g2p_result["espeakDataManifestSha256"], reference["espeakDataManifestSha256"]),
        (g2p_result["espeakRuntimeManifestSha256"], reference["espeakRuntimeManifestSha256"]),
        (g2p_result["ipaVocabularySha256"], reference["ipaVocabularySha256"]),
        (g2p_result["normalizationPolicySha256"], reference["normalizationPolicySha256"]),
        (g2p_result["espeakStdoutSha256"], reference["espeakStdoutSha256"]),
        (g2p_result["referenceIpaTokens"], reference["referenceIpaTokens"]),
    )
    if (
        actual_runner_sha256 != expected_runner_sha256
        or request["runnerSha256"] != expected_runner_sha256
        or phase_sha256 != expected_phase_sha256
        or request["phaseSha256"] != expected_phase_sha256
        or reference_sha256 != expected_reference_sha256
        or request["referenceSha256"] != expected_reference_sha256
        or g2p_result_sha256 != expected_g2p_result_sha256
        or request["g2pResultSha256"] != expected_g2p_result_sha256
        or any(reference_pin != request_pin for reference_pin, request_pin in pin_pairs)
        or any(result_value != reference_value for result_value, reference_value in result_pairs)
    ):
        raise AdjudicationError("Runner, policy, or reference-production digest mismatch")
    _assert_audio_bindings(phase, reference)
    status = phase["status"]
    result: dict[str, object] = {
        "schemaVersion": RESULT_SCHEMA,
        "phaseSha256": phase_sha256,
        "referenceSha256": reference_sha256,
        "targetTextSha256": request["targetTextSha256"],
        "normalizedTargetTextSha256": request["normalizedTargetTextSha256"],
        "espeakRuntimeManifestSha256": request["espeakRuntimeManifestSha256"],
        "ipaVocabularySha256": request["ipaVocabularySha256"],
        "espeakStdoutSha256": request["espeakStdoutSha256"],
        "g2pResultSha256": request["g2pResultSha256"],
        "runnerSha256": request["runnerSha256"],
        "policySha256": request["policySha256"],
    }
    if status == "measured":
        phase_observation = phase["observation"]
        if not isinstance(phase_observation, dict):
            raise AdjudicationError("Measured phase observation is unavailable")
        payload = phase_observation["observation"]
        if not isinstance(payload, dict) or not isinstance(payload["tokens"], list):
            raise AdjudicationError("Measured IPA token payload is unavailable")
        hypothesis = [str(token["symbol"]) for token in payload["tokens"] if isinstance(token, dict)]
        reference_tokens = reference["referenceIpaTokens"]
        if not isinstance(reference_tokens, list):
            raise AdjudicationError("Reference IPA token payload is unavailable")
        result.update({
            "status": "measured",
            "sourcePhaseStatus": "measured",
            "measurement": _raw_alignment(reference_tokens, hypothesis),
        })
    else:
        result.update({
            "status": "unavailable",
            "sourcePhaseStatus": status,
            "measurement": None,
        })
    return result


def _argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Compute a deterministic raw IPA edit measurement from canonical documents.",
    )
    parser.add_argument("--expected-runner-sha256", required=True)
    parser.add_argument("--expected-request-sha256", required=True)
    parser.add_argument("--expected-phase-sha256", required=True)
    parser.add_argument("--expected-reference-sha256", required=True)
    parser.add_argument("--expected-g2p-result-sha256", required=True)
    return parser


def main() -> int:
    arguments = _argument_parser().parse_args()
    try:
        expected_values = {
            "runner": _expect_sha256(
                arguments.expected_runner_sha256,
                "expected adjudicator runner",
            ),
            "request": _expect_sha256(
                arguments.expected_request_sha256,
                "expected adjudicator request",
            ),
            "phase": _expect_sha256(
                arguments.expected_phase_sha256,
                "expected independent IPA phase",
            ),
            "reference": _expect_sha256(
                arguments.expected_reference_sha256,
                "expected reference IPA",
            ),
            "g2p": _expect_sha256(
                arguments.expected_g2p_result_sha256,
                "expected German G2P result",
            ),
        }
        if not all(isinstance(value, str) for value in expected_values.values()):
            raise AdjudicationError("Expected adjudication authority is incomplete")
        result = _adjudicate(
            _read_request(expected_request_sha256=str(expected_values["request"])),
            expected_runner_sha256=str(expected_values["runner"]),
            expected_phase_sha256=str(expected_values["phase"]),
            expected_reference_sha256=str(expected_values["reference"]),
            expected_g2p_result_sha256=str(expected_values["g2p"]),
        )
    except AdjudicationError as error:
        sys.stderr.write(f"IPA adjudication rejected: {error}\n")
        return 2
    sys.stdout.write(_canonical_json(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
