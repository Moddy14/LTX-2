"""Cluster-bootstrap AV offset, calibration, and abstention measurements."""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass
from typing import Any, Callable

from .design import document_sha256

OFFSET_OBSERVATIONS_SCHEMA = "ltx-av-eval-offset-observations.v1"
OFFSET_MEASUREMENTS_SCHEMA = "ltx-av-eval-offset-measurements.v1"
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
ECE_BINS = 10
MAX_CASES = 1_000_000
REQUIRED_OFFSET_KINDS = (
    "negative-multiframe",
    "negative-one-frame",
    "negative-subframe",
    "positive-multiframe",
    "positive-one-frame",
    "positive-subframe",
    "zero",
)


class OffsetMeasurementError(ValueError):
    """Raised when AV offset evidence is incomplete or statistically invalid."""


@dataclass(frozen=True)
class _CalibrationCase:
    case_id: str
    component_id: str
    strata: tuple[str, ...]
    in_domain: bool
    offset_kind: str
    expected_offset_ms: float | None
    predicted_offset_ms: float | None
    within_one_frame_probability: float | None
    frame_duration_ms: float

    @property
    def abstained(self) -> bool:
        return self.predicted_offset_ms is None


@dataclass(frozen=True)
class _OutputCase:
    output_id: str
    component_id: str
    estimated_offset_ms: float


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise OffsetMeasurementError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise OffsetMeasurementError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise OffsetMeasurementError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise OffsetMeasurementError(f"{context} must be a lowercase SHA-256")
    return value


def _number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise OffsetMeasurementError(f"{context} must be a finite number")
    return float(value)


def _sorted_ids(raw: object, context: str) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise OffsetMeasurementError(f"{context} must be a non-empty list")
    identifiers = [_identifier(value, f"{context}[{index}]") for index, value in enumerate(raw)]
    if identifiers != sorted(set(identifiers)):
        raise OffsetMeasurementError(f"{context} must be unique and sorted")
    return identifiers


def _validate_bootstrap(raw: object) -> int:
    if not isinstance(raw, dict):
        raise OffsetMeasurementError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or isinstance(seed, bool)
        or not isinstance(seed, int)
        or not 0 <= seed < 2**63
    ):
        raise OffsetMeasurementError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return seed


def _derived_offset_kind(offset: float, frame_duration: float) -> str:
    if offset == 0:
        return "zero"
    sign = "positive" if offset > 0 else "negative"
    magnitude = abs(offset)
    if math.isclose(magnitude, frame_duration, rel_tol=0, abs_tol=1e-6):
        return f"{sign}-one-frame"
    return f"{sign}-subframe" if magnitude < frame_duration else f"{sign}-multiframe"


def _validate_expected_offset(
    item: dict[str, Any], *, case_id: str, in_domain: bool, frame_duration: float
) -> tuple[str, float | None]:
    offset_kind = item["offset_kind"]
    expected_raw = item["expected_offset_ms"]
    if not in_domain:
        if expected_raw is not None or offset_kind != "ood":
            raise OffsetMeasurementError(f"OOD calibration case {case_id} must use null expected offset and ood kind")
        return "ood", None
    expected = _number(expected_raw, f"calibration case {case_id}.expected_offset_ms")
    if not -5000 <= expected <= 5000:
        raise OffsetMeasurementError(f"calibration case {case_id}.expected_offset_ms is outside -5000..5000")
    derived_kind = _derived_offset_kind(expected, frame_duration)
    if offset_kind != derived_kind:
        raise OffsetMeasurementError(f"calibration case {case_id}.offset_kind must be {derived_kind}")
    return derived_kind, expected


def _validate_prediction(item: dict[str, Any], *, case_id: str) -> tuple[float | None, float | None]:
    predicted_raw = item["predicted_offset_ms"]
    confidence_raw = item["within_one_frame_probability"]
    if predicted_raw is None:
        if confidence_raw is not None:
            raise OffsetMeasurementError(
                f"abstained calibration case {case_id} must not contain within-one-frame probability"
            )
        return None, None
    predicted = _number(predicted_raw, f"calibration case {case_id}.predicted_offset_ms")
    if not -5000 <= predicted <= 5000:
        raise OffsetMeasurementError(f"calibration case {case_id}.predicted_offset_ms is outside -5000..5000")
    confidence = _number(confidence_raw, f"calibration case {case_id}.within_one_frame_probability")
    if not 0 <= confidence <= 1:
        raise OffsetMeasurementError(f"calibration case {case_id}.within_one_frame_probability must be between 0 and 1")
    return predicted, confidence


def _validate_calibration_case(item: object, *, index: int, registered: list[str]) -> _CalibrationCase:
    if not isinstance(item, dict):
        raise OffsetMeasurementError(f"calibration case {index} must be an object")
    _exact_keys(
        item,
        {
            "case_id",
            "leakage_component_id",
            "strata",
            "in_domain",
            "offset_kind",
            "expected_offset_ms",
            "predicted_offset_ms",
            "within_one_frame_probability",
            "frame_duration_ms",
        },
        f"calibration case {index}",
    )
    case_id = _identifier(item["case_id"], f"calibration case {index}.case_id")
    component_id = _identifier(item["leakage_component_id"], f"calibration case {case_id}.component")
    strata = _sorted_ids(item["strata"], f"calibration case {case_id}.strata")
    if not set(strata).issubset(registered):
        raise OffsetMeasurementError(f"calibration case {case_id} contains an unregistered stratum")
    in_domain = item["in_domain"]
    if not isinstance(in_domain, bool):
        raise OffsetMeasurementError(f"calibration case {case_id}.in_domain must be boolean")
    frame_duration = _number(item["frame_duration_ms"], f"calibration case {case_id}.frame_duration_ms")
    if not 1 <= frame_duration <= 1000:
        raise OffsetMeasurementError(f"calibration case {case_id}.frame_duration_ms is outside 1..1000")
    offset_kind, expected = _validate_expected_offset(
        item, case_id=case_id, in_domain=in_domain, frame_duration=frame_duration
    )
    predicted, confidence = _validate_prediction(item, case_id=case_id)
    return _CalibrationCase(
        case_id,
        component_id,
        tuple(strata),
        in_domain,
        offset_kind,
        expected,
        predicted,
        confidence,
        frame_duration,
    )


def _validate_calibration_cases(raw: object, *, registered: list[str]) -> list[_CalibrationCase]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_CASES:
        raise OffsetMeasurementError(f"calibration_cases must contain 2 to {MAX_CASES} observations")
    cases = [_validate_calibration_case(item, index=index, registered=registered) for index, item in enumerate(raw)]
    identifiers = [case.case_id for case in cases]
    if identifiers != sorted(set(identifiers)):
        raise OffsetMeasurementError("calibration cases must have unique, sorted case IDs")
    covered = {case.offset_kind for case in cases if case.in_domain and not case.abstained}
    if covered != set(REQUIRED_OFFSET_KINDS):
        raise OffsetMeasurementError("non-abstained calibration cases must cover all seven required offset kinds")
    for kind in REQUIRED_OFFSET_KINDS:
        units = {case.component_id for case in cases if case.offset_kind == kind and not case.abstained}
        if len(units) < 2:
            raise OffsetMeasurementError(f"offset kind {kind} needs at least two independent leakage components")
    return cases


def _validate_output_cases(raw: object) -> list[_OutputCase]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_CASES:
        raise OffsetMeasurementError(f"output_cases must contain 2 to {MAX_CASES} observations")
    cases: list[_OutputCase] = []
    identifiers: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise OffsetMeasurementError(f"output case {index} must be an object")
        _exact_keys(item, {"output_id", "leakage_component_id", "estimated_offset_ms"}, f"output case {index}")
        output_id = _identifier(item["output_id"], f"output case {index}.output_id")
        identifiers.append(output_id)
        component_id = _identifier(item["leakage_component_id"], f"output case {output_id}.component")
        estimate = _number(item["estimated_offset_ms"], f"output case {output_id}.estimated_offset_ms")
        if not -5000 <= estimate <= 5000:
            raise OffsetMeasurementError(f"output case {output_id}.estimated_offset_ms is outside -5000..5000")
        cases.append(_OutputCase(output_id, component_id, estimate))
    if identifiers != sorted(set(identifiers)):
        raise OffsetMeasurementError("output cases must have unique, sorted output IDs")
    if len({case.component_id for case in cases}) < 2:
        raise OffsetMeasurementError("output cases need at least two independent leakage components")
    return cases


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    position = quantile * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _ece(values: list[tuple[float, float]]) -> float:
    total = len(values)
    result = 0.0
    for bin_index in range(ECE_BINS):
        lower = bin_index / ECE_BINS
        upper = (bin_index + 1) / ECE_BINS
        selected = [
            value for value in values if lower <= value[0] < upper or (bin_index == ECE_BINS - 1 and value[0] == 1)
        ]
        if selected:
            confidence = sum(value[0] for value in selected) / len(selected)
            accuracy = sum(value[1] for value in selected) / len(selected)
            result += len(selected) / total * abs(accuracy - confidence)
    return result


def _bootstrap_statistic(
    grouped: dict[str, list[Any]],
    *,
    statistic: Callable[[list[Any]], float],
    seed: int,
    label: str,
) -> tuple[float, float, float, int]:
    group_ids = sorted(grouped)
    if len(group_ids) < 2:
        raise OffsetMeasurementError(f"{label} needs at least two independent leakage components")
    point = statistic([value for group_id in group_ids for value in grouped[group_id]])
    derived_seed = int.from_bytes(hashlib.sha256(f"{seed}:{label}".encode()).digest()[:8], "big")
    generator = random.Random(derived_seed)
    samples: list[float] = []
    for _replicate in range(BOOTSTRAP_REPLICATES):
        selected_ids = [generator.choice(group_ids) for _group_id in group_ids]
        selected = [value for group_id in selected_ids for value in grouped[group_id]]
        samples.append(statistic(selected))
    samples.sort()
    lower = samples[math.floor(0.025 * (BOOTSTRAP_REPLICATES - 1))]
    upper = samples[math.ceil(0.975 * (BOOTSTRAP_REPLICATES - 1))]
    return point, lower, upper, len(group_ids)


def _group(values: list[Any], component: Callable[[Any], str]) -> dict[str, list[Any]]:
    grouped: dict[str, list[Any]] = {}
    for value in values:
        grouped.setdefault(component(value), []).append(value)
    return grouped


def _metric(metric_id: str, result: tuple[float, float, float, int]) -> dict[str, Any]:
    estimate, lower, upper, units = result
    return {
        "metric_id": metric_id,
        "estimate": estimate,
        "ci_lower": lower,
        "ci_upper": upper,
        "decision_stratum_id": "overall",
        "independent_units": units,
    }


def build_offset_measurements(raw: object) -> dict[str, Any]:
    """Compute all fixed D1 AV offset, calibration, and abstention gates."""

    if not isinstance(raw, dict):
        raise OffsetMeasurementError("offset observations must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "dataset_digest",
            "preregistration_digest",
            "offset_evaluator_digest",
            "calibration_policy_digest",
            "abstention_policy_digest",
            "output_release_digest",
            "strata_plan_digest",
            "bootstrap",
            "registered_strata",
            "calibration_cases",
            "output_cases",
        },
        "offset observations",
    )
    if raw["schema_version"] != OFFSET_OBSERVATIONS_SCHEMA:
        raise OffsetMeasurementError("unsupported offset observations schema")
    for field in (
        "dataset_digest",
        "preregistration_digest",
        "offset_evaluator_digest",
        "calibration_policy_digest",
        "abstention_policy_digest",
        "output_release_digest",
        "strata_plan_digest",
    ):
        _sha256(raw[field], field)
    seed = _validate_bootstrap(raw["bootstrap"])
    registered = _sorted_ids(raw["registered_strata"], "registered_strata")
    calibration = _validate_calibration_cases(raw["calibration_cases"], registered=registered)
    outputs = _validate_output_cases(raw["output_cases"])
    in_domain = [case for case in calibration if case.in_domain]
    scored = [case for case in in_domain if not case.abstained]
    ood = [case for case in calibration if not case.in_domain]
    if not ood:
        raise OffsetMeasurementError("calibration cases must contain OOD controls")
    errors = _group(scored, lambda case: case.component_id)
    id_abstention = _group(in_domain, lambda case: case.component_id)
    ood_abstention = _group(ood, lambda case: case.component_id)
    calibration_values = _group(scored, lambda case: case.component_id)
    output_values = _group(outputs, lambda case: case.component_id)

    def absolute_errors(cases: list[_CalibrationCase]) -> list[float]:
        return [abs(case.predicted_offset_ms - case.expected_offset_ms) for case in cases]  # type: ignore[operator]

    error_median = _bootstrap_statistic(
        errors,
        statistic=lambda cases: _percentile(absolute_errors(cases), 0.5),
        seed=seed,
        label="offset-error-median",
    )
    error_p95 = _bootstrap_statistic(
        errors,
        statistic=lambda cases: _percentile(absolute_errors(cases), 0.95),
        seed=seed,
        label="offset-error-p95",
    )
    within_frame = _bootstrap_statistic(
        errors,
        statistic=lambda cases: (
            sum(
                abs(case.predicted_offset_ms - case.expected_offset_ms) <= case.frame_duration_ms  # type: ignore[operator]
                for case in cases
            )
            / len(cases)
        ),
        seed=seed,
        label="within-one-frame",
    )
    brier = _bootstrap_statistic(
        calibration_values,
        statistic=lambda cases: (
            sum(
                (
                    case.within_one_frame_probability
                    - (abs(case.predicted_offset_ms - case.expected_offset_ms) <= case.frame_duration_ms)
                )
                ** 2  # type: ignore[operator]
                for case in cases
            )
            / len(cases)
        ),
        seed=seed,
        label="brier",
    )
    ece = _bootstrap_statistic(
        calibration_values,
        statistic=lambda cases: _ece(
            [
                (
                    case.within_one_frame_probability,  # type: ignore[arg-type]
                    float(abs(case.predicted_offset_ms - case.expected_offset_ms) <= case.frame_duration_ms),  # type: ignore[operator]
                )
                for case in cases
            ]
        ),
        seed=seed,
        label="ece-10-equal-width",
    )
    false_abstention = _bootstrap_statistic(
        id_abstention,
        statistic=lambda cases: sum(case.abstained for case in cases) / len(cases),
        seed=seed,
        label="in-domain-false-abstention",
    )
    ood_recall = _bootstrap_statistic(
        ood_abstention,
        statistic=lambda cases: sum(case.abstained for case in cases) / len(cases),
        seed=seed,
        label="ood-abstention-recall",
    )
    output_p95 = _bootstrap_statistic(
        output_values,
        statistic=lambda cases: _percentile([abs(case.estimated_offset_ms) for case in cases], 0.95),
        seed=seed,
        label="output-offset-p95",
    )
    metrics = [
        _metric("av-brier-score", brier),
        _metric("av-calibration-ece", ece),
        _metric("av-evaluator-bootstrap95-upper-ms", error_p95),
        _metric("av-evaluator-median-absolute-error-ms", error_median),
        _metric("av-evaluator-p95-absolute-error-ms", error_p95),
        _metric("av-evaluator-within-one-frame-ci-lower", within_frame),
        _metric("av-in-domain-false-abstention-ci-upper", false_abstention),
        _metric("av-ood-abstention-recall-ci-lower", ood_recall),
        _metric("av-output-offset-p95-ms", output_p95),
    ]
    metrics.sort(key=lambda metric: metric["metric_id"])
    return {
        "schema_version": OFFSET_MEASUREMENTS_SCHEMA,
        "input_digest": document_sha256(raw),
        "dataset_digest": raw["dataset_digest"],
        "preregistration_digest": raw["preregistration_digest"],
        "offset_evaluator_digest": raw["offset_evaluator_digest"],
        "calibration_policy_digest": raw["calibration_policy_digest"],
        "abstention_policy_digest": raw["abstention_policy_digest"],
        "output_release_digest": raw["output_release_digest"],
        "strata_plan_digest": raw["strata_plan_digest"],
        "bootstrap": raw["bootstrap"],
        "ece_bins": ECE_BINS,
        "calibration_cases": len(calibration),
        "output_cases": len(outputs),
        "metrics": metrics,
    }
