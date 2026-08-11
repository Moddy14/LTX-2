"""Cluster-bootstrap ASR measurements for D1 and Q2 evidence."""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass
from typing import Any

from .design import document_sha256

ASR_OBSERVATIONS_SCHEMA = "ltx-av-eval-asr-observations.v1"
ASR_MEASUREMENTS_SCHEMA = "ltx-av-eval-asr-measurements.v1"
CRITICAL_KINDS = ("name", "negation", "number")
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
MAX_OBSERVATIONS = 100_000
MAX_TOKENS_PER_OBSERVATION = 1_000


class AsrMeasurementError(ValueError):
    """Raised when ASR evidence is incomplete, ambiguous, or unbound."""


@dataclass(frozen=True)
class _Score:
    edits: int
    reference_tokens: int
    critical_correct: tuple[int, int, int]
    critical_total: tuple[int, int, int]

    def __add__(self, other: _Score) -> _Score:
        return _Score(
            edits=self.edits + other.edits,
            reference_tokens=self.reference_tokens + other.reference_tokens,
            critical_correct=tuple(
                left + right for left, right in zip(self.critical_correct, other.critical_correct, strict=True)
            ),
            critical_total=tuple(
                left + right for left, right in zip(self.critical_total, other.critical_total, strict=True)
            ),
        )


_ZERO_SCORE = _Score(0, 0, (0, 0, 0), (0, 0, 0))


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise AsrMeasurementError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        raise AsrMeasurementError(f"{context} must contain 1 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise AsrMeasurementError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise AsrMeasurementError(f"{context} must be a lowercase SHA-256")
    return value


def _token(value: object, context: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 128:
        raise AsrMeasurementError(f"{context} must contain 1 to 128 characters")
    if value != value.casefold() or any(character.isspace() for character in value):
        raise AsrMeasurementError(f"{context} must be a case-folded token without whitespace")
    return value


def _increment(values: tuple[int, int, int], index: int) -> tuple[int, int, int]:
    mutable = list(values)
    mutable[index] += 1
    return tuple(mutable)  # type: ignore[return-value]


def _alignment_score(reference: list[tuple[str, str | None]], hypothesis: list[str]) -> _Score:
    """Minimize word edits, then maximize exact critical-token matches."""

    rows = len(reference) + 1
    columns = len(hypothesis) + 1
    table: list[list[tuple[int, tuple[int, int, int]]]] = [
        [(0, (0, 0, 0)) for _ in range(columns)] for _ in range(rows)
    ]
    for row in range(1, rows):
        table[row][0] = (row, (0, 0, 0))
    for column in range(1, columns):
        table[0][column] = (column, (0, 0, 0))
    for row in range(1, rows):
        reference_token, critical_kind = reference[row - 1]
        for column in range(1, columns):
            exact = reference_token == hypothesis[column - 1]
            diagonal_edits, diagonal_correct = table[row - 1][column - 1]
            if exact and critical_kind is not None:
                diagonal_correct = _increment(diagonal_correct, CRITICAL_KINDS.index(critical_kind))
            candidates = [
                (diagonal_edits + (not exact), diagonal_correct, 0),
                (table[row - 1][column][0] + 1, table[row - 1][column][1], 1),
                (table[row][column - 1][0] + 1, table[row][column - 1][1], 2),
            ]
            edits, correct, _order = min(candidates, key=lambda item: (item[0], -sum(item[1]), item[2]))
            table[row][column] = (edits, correct)
    edits, critical_correct = table[-1][-1]
    critical_total = tuple(sum(kind == expected for _token_value, kind in reference) for expected in CRITICAL_KINDS)
    return _Score(edits, len(reference), critical_correct, critical_total)  # type: ignore[arg-type]


def _validate_reference(raw: object, context: str) -> list[tuple[str, str | None]]:
    if not isinstance(raw, list) or not raw or len(raw) > MAX_TOKENS_PER_OBSERVATION:
        raise AsrMeasurementError(f"{context} must contain 1 to {MAX_TOKENS_PER_OBSERVATION} tokens")
    reference: list[tuple[str, str | None]] = []
    kinds_by_token: dict[str, str | None] = {}
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise AsrMeasurementError(f"{context}[{index}] must be an object")
        _exact_keys(item, {"token", "critical_kind"}, f"{context}[{index}]")
        token = _token(item["token"], f"{context}[{index}].token")
        kind = item["critical_kind"]
        if kind is not None and kind not in CRITICAL_KINDS:
            raise AsrMeasurementError(f"{context}[{index}].critical_kind is unsupported")
        if token in kinds_by_token and kinds_by_token[token] != kind:
            raise AsrMeasurementError(f"{context} annotates repeated token {token!r} inconsistently")
        kinds_by_token[token] = kind
        reference.append((token, kind))
    return reference


def _validate_hypothesis(raw: object, context: str) -> list[str]:
    if not isinstance(raw, list) or len(raw) > MAX_TOKENS_PER_OBSERVATION:
        raise AsrMeasurementError(f"{context} must contain at most {MAX_TOKENS_PER_OBSERVATION} tokens")
    return [_token(value, f"{context}[{index}]") for index, value in enumerate(raw)]


def _sorted_identifiers(raw: object, context: str, *, nonempty: bool = True) -> list[str]:
    if not isinstance(raw, list) or (nonempty and not raw):
        raise AsrMeasurementError(f"{context} must be a{' non-empty' if nonempty else ''} list")
    identifiers = [_identifier(value, f"{context}[{index}]") for index, value in enumerate(raw)]
    if identifiers != sorted(set(identifiers)):
        raise AsrMeasurementError(f"{context} must be unique and sorted")
    return identifiers


def _bootstrap_rate(
    groups: dict[str, _Score],
    *,
    numerator: str,
    critical_index: int | None,
    seed: int,
    label: str,
) -> tuple[float, float, float, int]:
    if critical_index is not None:
        groups = {group_id: score for group_id, score in groups.items() if score.critical_total[critical_index] > 0}
    group_ids = sorted(groups)
    if not group_ids:
        raise AsrMeasurementError(f"{label} has no critical-token denominator")
    if len(group_ids) < 2:
        raise AsrMeasurementError(f"{label} needs at least two independent leakage components")

    def rate(score: _Score) -> float:
        if numerator == "wer":
            return score.edits / score.reference_tokens
        if critical_index is None or score.critical_total[critical_index] == 0:
            raise AsrMeasurementError(f"{label} has no critical-token denominator")
        return score.critical_correct[critical_index] / score.critical_total[critical_index]

    point = rate(sum(groups.values(), _ZERO_SCORE))
    derived_seed = int.from_bytes(hashlib.sha256(f"{seed}:{label}".encode()).digest()[:8], "big")
    generator = random.Random(derived_seed)
    samples: list[float] = []
    for _replicate in range(BOOTSTRAP_REPLICATES):
        sampled = _ZERO_SCORE
        for _group in group_ids:
            sampled += groups[generator.choice(group_ids)]
        samples.append(rate(sampled))
    samples.sort()
    lower_index = math.floor((1 - CONFIDENCE_LEVEL) / 2 * (BOOTSTRAP_REPLICATES - 1))
    upper_index = math.ceil((1 + CONFIDENCE_LEVEL) / 2 * (BOOTSTRAP_REPLICATES - 1))
    return point, samples[lower_index], samples[upper_index], len(group_ids)


def _group_scores(observations: list[dict[str, Any]], *, stratum: str | None = None) -> dict[str, _Score]:
    groups: dict[str, _Score] = {}
    for observation in observations:
        if stratum is not None and stratum not in observation["strata"]:
            continue
        component_id = observation["leakage_component_id"]
        groups[component_id] = groups.get(component_id, _ZERO_SCORE) + observation["score"]
    return groups


def _metric(metric_id: str, result: tuple[float, float, float, int], *, stratum_id: str) -> dict[str, Any]:
    estimate, ci_lower, ci_upper, independent_units = result
    return {
        "metric_id": metric_id,
        "estimate": estimate,
        "ci_lower": ci_lower,
        "ci_upper": ci_upper,
        "decision_stratum_id": stratum_id,
        "independent_units": independent_units,
    }


def _validate_bootstrap(raw: object) -> int:
    if not isinstance(raw, dict):
        raise AsrMeasurementError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or isinstance(seed, bool)
        or not isinstance(seed, int)
        or not 0 <= seed < 2**63
    ):
        raise AsrMeasurementError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return seed


def _validate_strata_contract(registered_raw: object, critical_raw: object) -> list[str]:
    registered_strata = _sorted_identifiers(registered_raw, "registered_strata")
    if not isinstance(critical_raw, dict):
        raise AsrMeasurementError("critical_strata must be an object")
    _exact_keys(critical_raw, set(CRITICAL_KINDS), "critical_strata")
    for kind in CRITICAL_KINDS:
        selected = _sorted_identifiers(critical_raw[kind], f"critical_strata.{kind}")
        if not set(selected).issubset(registered_strata):
            raise AsrMeasurementError(f"critical_strata.{kind} contains an unregistered stratum")
    return registered_strata


def _validate_observations(raw: object, *, registered_strata: list[str]) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_OBSERVATIONS:
        raise AsrMeasurementError(f"observations must contain 2 to {MAX_OBSERVATIONS} clips")
    checked: list[dict[str, Any]] = []
    sample_ids: list[str] = []
    for index, observation in enumerate(raw):
        if not isinstance(observation, dict):
            raise AsrMeasurementError(f"observation {index} must be an object")
        _exact_keys(
            observation,
            {"sample_id", "leakage_component_id", "strata", "reference", "hypothesis"},
            f"observation {index}",
        )
        sample_id = _identifier(observation["sample_id"], f"observation {index}.sample_id")
        sample_ids.append(sample_id)
        component_id = _identifier(observation["leakage_component_id"], f"observation {sample_id}.leakage_component_id")
        strata = _sorted_identifiers(observation["strata"], f"observation {sample_id}.strata")
        if not set(strata).issubset(registered_strata):
            raise AsrMeasurementError(f"observation {sample_id} contains an unregistered stratum")
        reference = _validate_reference(observation["reference"], f"observation {sample_id}.reference")
        hypothesis = _validate_hypothesis(observation["hypothesis"], f"observation {sample_id}.hypothesis")
        checked.append(
            {
                "sample_id": sample_id,
                "leakage_component_id": component_id,
                "strata": strata,
                "score": _alignment_score(reference, hypothesis),
            }
        )
    if sample_ids != sorted(set(sample_ids)):
        raise AsrMeasurementError("observations must have unique, sorted sample IDs")
    return checked


def _validate_input(raw: object) -> tuple[dict[str, Any], list[dict[str, Any]], int]:
    if not isinstance(raw, dict):
        raise AsrMeasurementError("ASR observations must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "dataset_digest",
            "preregistration_digest",
            "release_digest",
            "asr_model_digest",
            "normalization_digest",
            "strata_plan_digest",
            "bootstrap",
            "registered_strata",
            "critical_strata",
            "observations",
        },
        "ASR observations",
    )
    if raw["schema_version"] != ASR_OBSERVATIONS_SCHEMA:
        raise AsrMeasurementError("unsupported ASR observations schema")
    for field in (
        "dataset_digest",
        "preregistration_digest",
        "release_digest",
        "asr_model_digest",
        "normalization_digest",
        "strata_plan_digest",
    ):
        _sha256(raw[field], field)
    seed = _validate_bootstrap(raw["bootstrap"])
    registered_strata = _validate_strata_contract(raw["registered_strata"], raw["critical_strata"])
    checked = _validate_observations(raw["observations"], registered_strata=registered_strata)
    return raw, checked, seed


def build_asr_measurements(raw: object) -> dict[str, Any]:
    """Validate normalized transcripts and compute fixed cluster-bootstrap ASR metrics."""

    document, observations, seed = _validate_input(raw)
    registered_strata = document["registered_strata"]
    critical_strata = document["critical_strata"]
    overall_groups = _group_scores(observations)
    overall_wer = _bootstrap_rate(overall_groups, numerator="wer", critical_index=None, seed=seed, label="wer:overall")
    stratum_wer = {
        stratum: _bootstrap_rate(
            _group_scores(observations, stratum=stratum),
            numerator="wer",
            critical_index=None,
            seed=seed,
            label=f"wer:{stratum}",
        )
        for stratum in registered_strata
    }
    worst_wer_estimate_stratum = max(stratum_wer, key=lambda stratum: (stratum_wer[stratum][0], stratum))
    worst_wer_ci_stratum = max(stratum_wer, key=lambda stratum: (stratum_wer[stratum][2], stratum))
    metrics = [
        _metric("asr-wer-estimate", overall_wer, stratum_id="overall"),
        _metric("asr-wer-ci-upper", overall_wer, stratum_id="overall"),
        _metric(
            "asr-wer-estimate-worst-stratum",
            stratum_wer[worst_wer_estimate_stratum],
            stratum_id=worst_wer_estimate_stratum,
        ),
        _metric(
            "asr-wer-ci-upper-worst-stratum",
            stratum_wer[worst_wer_ci_stratum],
            stratum_id=worst_wer_ci_stratum,
        ),
    ]
    critical_results: dict[str, dict[str, tuple[float, float, float, int]]] = {}
    for index, kind in enumerate(CRITICAL_KINDS):
        results = {
            stratum: _bootstrap_rate(
                _group_scores(observations, stratum=stratum),
                numerator="critical",
                critical_index=index,
                seed=seed,
                label=f"critical:{kind}:{stratum}",
            )
            for stratum in critical_strata[kind]
        }
        critical_results[kind] = results
        worst_stratum = min(results, key=lambda stratum: (results[stratum][1], stratum))
        metrics.append(
            _metric(
                f"asr-critical-{kind}-accuracy-ci-lower",
                results[worst_stratum],
                stratum_id=worst_stratum,
            )
        )
    metrics.sort(key=lambda item: item["metric_id"])
    return {
        "schema_version": ASR_MEASUREMENTS_SCHEMA,
        "input_digest": document_sha256(document),
        "dataset_digest": document["dataset_digest"],
        "preregistration_digest": document["preregistration_digest"],
        "release_digest": document["release_digest"],
        "asr_model_digest": document["asr_model_digest"],
        "normalization_digest": document["normalization_digest"],
        "strata_plan_digest": document["strata_plan_digest"],
        "bootstrap": document["bootstrap"],
        "independent_units": len(overall_groups),
        "clips": len(observations),
        "metrics": metrics,
        "strata": {
            "wer": {stratum: list(values) for stratum, values in sorted(stratum_wer.items())},
            "critical": {
                kind: {stratum: list(values) for stratum, values in sorted(results.items())}
                for kind, results in sorted(critical_results.items())
            },
        },
    }
