"""Leakage-component bootstrap measurements for mouth-content decisions."""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass
from typing import Any, Callable

from .design import document_sha256

CONTENT_OBSERVATIONS_SCHEMA = "ltx-av-eval-content-observations.v1"
CONTENT_MEASUREMENTS_SCHEMA = "ltx-av-eval-content-measurements.v1"
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
MAX_OBSERVATIONS = 1_000_000
FRAME_LABELS = ("bilabial-closure", "open", "other", "rounded")


class ContentMeasurementError(ValueError):
    """Raised when mouth-content evidence is incomplete or invalid."""


@dataclass(frozen=True)
class _Frame:
    observation_id: str
    component_id: str
    strata: tuple[str, ...]
    expected: str
    predicted: str


@dataclass(frozen=True)
class _Transition:
    observation_id: str
    component_id: str
    strata: tuple[str, ...]
    expected: bool
    predicted: bool


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise ContentMeasurementError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise ContentMeasurementError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise ContentMeasurementError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ContentMeasurementError(f"{context} must be a lowercase SHA-256")
    return value


def _sorted_ids(raw: object, context: str) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise ContentMeasurementError(f"{context} must be a non-empty list")
    identifiers = [_identifier(value, f"{context}[{index}]") for index, value in enumerate(raw)]
    if identifiers != sorted(set(identifiers)):
        raise ContentMeasurementError(f"{context} must be unique and sorted")
    return identifiers


def _validate_bootstrap(raw: object) -> int:
    if not isinstance(raw, dict):
        raise ContentMeasurementError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or isinstance(seed, bool)
        or not isinstance(seed, int)
        or not 0 <= seed < 2**63
    ):
        raise ContentMeasurementError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return seed


def _validate_frames(raw: object, *, registered: list[str]) -> list[_Frame]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_OBSERVATIONS:
        raise ContentMeasurementError(f"frames must contain 2 to {MAX_OBSERVATIONS} observations")
    frames: list[_Frame] = []
    identifiers: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ContentMeasurementError(f"frame {index} must be an object")
        _exact_keys(
            item,
            {"observation_id", "leakage_component_id", "strata", "expected_label", "predicted_label"},
            f"frame {index}",
        )
        observation_id = _identifier(item["observation_id"], f"frame {index}.observation_id")
        identifiers.append(observation_id)
        component_id = _identifier(item["leakage_component_id"], f"frame {observation_id}.component")
        strata = _sorted_ids(item["strata"], f"frame {observation_id}.strata")
        if not set(strata).issubset(registered):
            raise ContentMeasurementError(f"frame {observation_id} contains an unregistered stratum")
        expected = item["expected_label"]
        predicted = item["predicted_label"]
        if expected not in FRAME_LABELS or predicted not in FRAME_LABELS:
            raise ContentMeasurementError(f"frame {observation_id} must use the fixed mouth-content labels")
        frames.append(_Frame(observation_id, component_id, tuple(strata), expected, predicted))
    if identifiers != sorted(set(identifiers)):
        raise ContentMeasurementError("frames must have unique, sorted observation IDs")
    return frames


def _validate_transitions(raw: object, *, registered: list[str]) -> list[_Transition]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_OBSERVATIONS:
        raise ContentMeasurementError(f"transitions must contain 2 to {MAX_OBSERVATIONS} observations")
    transitions: list[_Transition] = []
    identifiers: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ContentMeasurementError(f"transition {index} must be an object")
        _exact_keys(
            item,
            {"observation_id", "leakage_component_id", "strata", "expected_transition", "predicted_transition"},
            f"transition {index}",
        )
        observation_id = _identifier(item["observation_id"], f"transition {index}.observation_id")
        identifiers.append(observation_id)
        component_id = _identifier(item["leakage_component_id"], f"transition {observation_id}.component")
        strata = _sorted_ids(item["strata"], f"transition {observation_id}.strata")
        if not set(strata).issubset(registered):
            raise ContentMeasurementError(f"transition {observation_id} contains an unregistered stratum")
        expected = item["expected_transition"]
        predicted = item["predicted_transition"]
        if not isinstance(expected, bool) or not isinstance(predicted, bool):
            raise ContentMeasurementError(f"transition {observation_id} decisions must be boolean")
        transitions.append(_Transition(observation_id, component_id, tuple(strata), expected, predicted))
    if identifiers != sorted(set(identifiers)):
        raise ContentMeasurementError("transitions must have unique, sorted observation IDs")
    return transitions


def _group(values: list[Any]) -> dict[str, list[Any]]:
    groups: dict[str, list[Any]] = {}
    for value in values:
        groups.setdefault(value.component_id, []).append(value)
    return groups


def _macro_f1(frames: list[_Frame]) -> float:
    scores: list[float] = []
    for label in FRAME_LABELS:
        true_positive = sum(frame.expected == label and frame.predicted == label for frame in frames)
        false_positive = sum(frame.expected != label and frame.predicted == label for frame in frames)
        false_negative = sum(frame.expected == label and frame.predicted != label for frame in frames)
        denominator = 2 * true_positive + false_positive + false_negative
        if denominator == 0:
            raise ContentMeasurementError(f"macro F1 has no denominator for {label}")
        scores.append(2 * true_positive / denominator)
    return sum(scores) / len(scores)


def _transition_f1(transitions: list[_Transition]) -> float:
    true_positive = sum(item.expected and item.predicted for item in transitions)
    false_positive = sum(not item.expected and item.predicted for item in transitions)
    false_negative = sum(item.expected and not item.predicted for item in transitions)
    denominator = 2 * true_positive + false_positive + false_negative
    if denominator == 0:
        raise ContentMeasurementError("transition F1 has no positive denominator")
    return 2 * true_positive / denominator


def _validate_component_coverage(groups: dict[str, list[Any]], *, kind: str) -> None:
    if len(groups) < 2:
        raise ContentMeasurementError(f"{kind} needs at least two independent leakage components")
    for component_id, values in groups.items():
        if kind == "frame":
            covered = {value.expected for value in values}
            if covered != set(FRAME_LABELS):
                raise ContentMeasurementError(f"frame component {component_id} does not cover all fixed labels")
        elif not {value.expected for value in values}.issuperset({False, True}):
            raise ContentMeasurementError(f"transition component {component_id} needs positive and negative controls")


def _bootstrap(
    groups: dict[str, list[Any]],
    *,
    statistic: Callable[[list[Any]], float],
    seed: int,
    label: str,
) -> tuple[float, float, float, int]:
    group_ids = sorted(groups)
    point = statistic([value for group_id in group_ids for value in groups[group_id]])
    derived_seed = int.from_bytes(hashlib.sha256(f"{seed}:{label}".encode()).digest()[:8], "big")
    generator = random.Random(derived_seed)
    samples: list[float] = []
    for _replicate in range(BOOTSTRAP_REPLICATES):
        selected_ids = [generator.choice(group_ids) for _group_id in group_ids]
        selected = [value for group_id in selected_ids for value in groups[group_id]]
        samples.append(statistic(selected))
    samples.sort()
    lower = samples[math.floor(0.025 * (BOOTSTRAP_REPLICATES - 1))]
    upper = samples[math.ceil(0.975 * (BOOTSTRAP_REPLICATES - 1))]
    return point, lower, upper, len(group_ids)


def _measure(
    values: list[Any],
    *,
    registered: list[str],
    kind: str,
    statistic: Callable[[list[Any]], float],
    seed: int,
) -> tuple[tuple[float, float, float, int], dict[str, tuple[float, float, float, int]]]:
    overall_groups = _group(values)
    _validate_component_coverage(overall_groups, kind=kind)
    overall = _bootstrap(overall_groups, statistic=statistic, seed=seed, label=f"{kind}:overall")
    strata_results: dict[str, tuple[float, float, float, int]] = {}
    for stratum in registered:
        groups = _group([value for value in values if stratum in value.strata])
        _validate_component_coverage(groups, kind=kind)
        strata_results[stratum] = _bootstrap(
            groups,
            statistic=statistic,
            seed=seed,
            label=f"{kind}:{stratum}",
        )
    return overall, strata_results


def _metric(metric_id: str, result: tuple[float, float, float, int], *, stratum: str) -> dict[str, Any]:
    estimate, lower, upper, units = result
    return {
        "metric_id": metric_id,
        "estimate": estimate,
        "ci_lower": lower,
        "ci_upper": upper,
        "decision_stratum_id": stratum,
        "independent_units": units,
    }


def build_content_measurements(raw: object) -> dict[str, Any]:
    """Compute overall and worst-stratum frame and transition F1."""

    if not isinstance(raw, dict):
        raise ContentMeasurementError("content observations must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "dataset_digest",
            "preregistration_digest",
            "release_digest",
            "content_evaluator_digest",
            "annotation_policy_digest",
            "strata_plan_digest",
            "bootstrap",
            "registered_strata",
            "frames",
            "transitions",
        },
        "content observations",
    )
    if raw["schema_version"] != CONTENT_OBSERVATIONS_SCHEMA:
        raise ContentMeasurementError("unsupported content observations schema")
    for field in (
        "dataset_digest",
        "preregistration_digest",
        "release_digest",
        "content_evaluator_digest",
        "annotation_policy_digest",
        "strata_plan_digest",
    ):
        _sha256(raw[field], field)
    seed = _validate_bootstrap(raw["bootstrap"])
    registered = _sorted_ids(raw["registered_strata"], "registered_strata")
    frames = _validate_frames(raw["frames"], registered=registered)
    transitions = _validate_transitions(raw["transitions"], registered=registered)
    frame_overall, frame_strata = _measure(
        frames,
        registered=registered,
        kind="frame",
        statistic=_macro_f1,
        seed=seed,
    )
    transition_overall, transition_strata = _measure(
        transitions,
        registered=registered,
        kind="transition",
        statistic=_transition_f1,
        seed=seed,
    )
    worst_frame = min(frame_strata, key=lambda key: (frame_strata[key][1], key))
    worst_transition = min(transition_strata, key=lambda key: (transition_strata[key][1], key))
    metrics = [
        _metric("content-frame-macro-f1-ci-lower", frame_overall, stratum="overall"),
        _metric("content-frame-macro-f1-ci-lower-worst-stratum", frame_strata[worst_frame], stratum=worst_frame),
        _metric("content-frame-macro-f1-estimate", frame_overall, stratum="overall"),
        _metric("content-frame-macro-f1-estimate-worst-stratum", frame_strata[worst_frame], stratum=worst_frame),
        _metric("content-transition-f1-ci-lower", transition_overall, stratum="overall"),
        _metric(
            "content-transition-f1-ci-lower-worst-stratum",
            transition_strata[worst_transition],
            stratum=worst_transition,
        ),
        _metric("content-transition-f1-estimate", transition_overall, stratum="overall"),
        _metric(
            "content-transition-f1-estimate-worst-stratum",
            transition_strata[worst_transition],
            stratum=worst_transition,
        ),
    ]
    metrics.sort(key=lambda metric: metric["metric_id"])
    return {
        "schema_version": CONTENT_MEASUREMENTS_SCHEMA,
        "input_digest": document_sha256(raw),
        "dataset_digest": raw["dataset_digest"],
        "preregistration_digest": raw["preregistration_digest"],
        "release_digest": raw["release_digest"],
        "content_evaluator_digest": raw["content_evaluator_digest"],
        "annotation_policy_digest": raw["annotation_policy_digest"],
        "strata_plan_digest": raw["strata_plan_digest"],
        "bootstrap": raw["bootstrap"],
        "frame_labels": list(FRAME_LABELS),
        "frames": len(frames),
        "transitions": len(transitions),
        "metrics": metrics,
    }
