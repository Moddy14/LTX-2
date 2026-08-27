"""D1 AV-offset, correspondence-calibration, and abstention measurements."""

from __future__ import annotations

import hashlib
import math
from collections import Counter
from dataclasses import dataclass
from typing import Any, Callable, Literal, TypeVar

import numpy as np

from .design import document_sha256

OFFSET_OBSERVATIONS_SCHEMA = "ltx-av-eval-offset-observations.v2"
OFFSET_MEASUREMENTS_SCHEMA = "ltx-av-eval-offset-measurements.v2"
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
ECE_BINS = 10
MAX_CASES = 900_000
MAX_COMPONENTS = 20_000
MAX_REGISTERED_STRATA = 64
GRID_REPLICATES_PER_CELL = 1
REQUIRED_FPS = (24, 25, 30)
REQUIRED_OFFSET_KINDS = (
    "negative-multiframe",
    "negative-one-frame",
    "negative-subframe",
    "positive-multiframe",
    "positive-one-frame",
    "positive-subframe",
    "zero",
)
GRID_MULTIPLIERS = {
    "negative-multiframe": -2.0,
    "negative-one-frame": -1.0,
    "negative-subframe": -0.5,
    "positive-multiframe": 2.0,
    "positive-one-frame": 1.0,
    "positive-subframe": 0.5,
    "zero": 0.0,
}
CALIBRATION_ABSTENTION_SEMANTICS = "conditional-on-non-abstained-with-separate-abstention-gates.v1"
COMPONENT_WEIGHTING = "equal-total-weight-per-transitive-component.v1"
UNCERTAINTY_METHOD = "component-clopper-pearson-plus-cluster-bootstrap-simultaneous-strata.v2"
BOOTSTRAP_RNG = "numpy-pcg64-derived-sha256-seeds.v1"


class OffsetMeasurementError(ValueError):
    """Raised when AV offset evidence is incomplete or statistically invalid."""


@dataclass(frozen=True)
class _CalibrationCase:
    case_id: str
    source_sample_id: str
    replicate_id: str
    component_id: str
    strata: tuple[str, ...]
    in_domain: bool
    correspondence_label: bool | None
    offset_kind: str
    fps: int
    expected_offset_ms: float | None
    predicted_offset_ms: float | None
    raw_score: float | None
    correspondence_probability: float | None
    frame_duration_ms: float

    @property
    def abstained(self) -> bool:
        return self.raw_score is None

    def predicted_correspondence(self, threshold: float) -> bool:
        return self.raw_score is not None and self.raw_score >= threshold


@dataclass(frozen=True)
class _OutputCase:
    output_id: str
    source_sample_id: str
    replicate_id: str
    component_id: str
    fps: int
    strata: tuple[str, ...]
    estimated_offset_ms: float


_Case = TypeVar("_Case")
_Aggregate = Literal["mean", "median", "p95", "max", "min"]


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
    result = float(value)
    return 0.0 if result == 0 else result


def _sorted_ids(raw: object, context: str, *, maximum: int) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise OffsetMeasurementError(f"{context} must be a non-empty list")
    if len(raw) > maximum:
        raise OffsetMeasurementError(f"{context} exceeds the {maximum}-identifier limit")
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


def _case_id(
    *,
    source_sample_id: str,
    replicate_id: str,
    fps: int,
    offset_kind: str,
    correspondence_label: bool | None,
) -> str:
    return document_sha256(
        {
            "correspondence_label": correspondence_label,
            "fps": fps,
            "offset_kind": offset_kind,
            "replicate_id": replicate_id,
            "source_sample_id": source_sample_id,
        }
    )


def _validate_prediction(item: dict[str, Any], *, case_id: str) -> tuple[float | None, float | None, float | None]:
    predicted_raw = item["predicted_offset_ms"]
    score_raw = item["raw_score"]
    probability_raw = item["correspondence_probability"]
    if predicted_raw is None or score_raw is None or probability_raw is None:
        if predicted_raw is not None or score_raw is not None or probability_raw is not None:
            raise OffsetMeasurementError(
                f"abstained calibration case {case_id} must use null prediction, raw score, and probability"
            )
        return None, None, None
    predicted = _number(predicted_raw, f"calibration case {case_id}.predicted_offset_ms")
    score = _number(score_raw, f"calibration case {case_id}.raw_score")
    probability = _number(probability_raw, f"calibration case {case_id}.correspondence_probability")
    if not -5000 <= predicted <= 5000:
        raise OffsetMeasurementError(f"calibration case {case_id}.predicted_offset_ms is outside -5000..5000")
    if not 0 <= probability <= 1:
        raise OffsetMeasurementError(f"calibration case {case_id}.correspondence_probability must be in 0..1")
    return predicted, score, probability


def _validate_calibration_case(item: object, *, index: int, registered: list[str]) -> _CalibrationCase:
    if not isinstance(item, dict):
        raise OffsetMeasurementError(f"calibration case {index} must be an object")
    _exact_keys(
        item,
        {
            "case_id",
            "source_sample_id",
            "replicate_id",
            "leakage_component_id",
            "strata",
            "in_domain",
            "correspondence_label",
            "offset_kind",
            "fps",
            "expected_offset_ms",
            "predicted_offset_ms",
            "raw_score",
            "correspondence_probability",
            "frame_duration_ms",
        },
        f"calibration case {index}",
    )
    case_id = _sha256(item["case_id"], f"calibration case {index}.case_id")
    source_id = _identifier(item["source_sample_id"], f"calibration case {case_id}.source_sample_id")
    replicate_id = _identifier(item["replicate_id"], f"calibration case {case_id}.replicate_id")
    component_id = _sha256(item["leakage_component_id"], f"calibration case {case_id}.component")
    strata = _sorted_ids(item["strata"], f"calibration case {case_id}.strata", maximum=MAX_REGISTERED_STRATA)
    if not set(strata).issubset(registered):
        raise OffsetMeasurementError(f"calibration case {case_id} contains an unregistered stratum")
    in_domain = item["in_domain"]
    if not isinstance(in_domain, bool):
        raise OffsetMeasurementError(f"calibration case {case_id}.in_domain must be boolean")
    fps = item["fps"]
    if isinstance(fps, bool) or not isinstance(fps, int) or fps not in REQUIRED_FPS:
        raise OffsetMeasurementError(f"calibration case {case_id}.fps must be one of {list(REQUIRED_FPS)}")
    frame_duration = _number(item["frame_duration_ms"], f"calibration case {case_id}.frame_duration_ms")
    if not math.isclose(frame_duration, 1000.0 / fps, rel_tol=0, abs_tol=1e-9):
        raise OffsetMeasurementError(f"calibration case {case_id}.frame_duration_ms must be derived from fps")
    if f"fps.{fps}" not in strata:
        raise OffsetMeasurementError(f"calibration case {case_id} must bind its fps stratum")
    label = item["correspondence_label"]
    offset_kind = item["offset_kind"]
    if in_domain:
        if not isinstance(label, bool) or offset_kind not in GRID_MULTIPLIERS:
            raise OffsetMeasurementError(f"calibration case {case_id} has invalid in-domain label or offset kind")
        expected = _number(item["expected_offset_ms"], f"calibration case {case_id}.expected_offset_ms")
        target = GRID_MULTIPLIERS[offset_kind] * frame_duration
        if not math.isclose(expected, target, rel_tol=0, abs_tol=1e-9):
            raise OffsetMeasurementError(f"calibration case {case_id}.expected_offset_ms is outside the fps grid")
    else:
        if label is not None or item["expected_offset_ms"] is not None or offset_kind != "ood":
            raise OffsetMeasurementError(f"OOD calibration case {case_id} must use null label/offset and ood kind")
        expected = None
    if case_id != _case_id(
        source_sample_id=source_id,
        replicate_id=replicate_id,
        fps=fps,
        offset_kind=offset_kind,
        correspondence_label=label,
    ):
        raise OffsetMeasurementError(f"calibration case {case_id} is not source-derived")
    predicted, score, probability = _validate_prediction(item, case_id=case_id)
    return _CalibrationCase(
        case_id,
        source_id,
        replicate_id,
        component_id,
        tuple(strata),
        in_domain,
        label,
        offset_kind,
        fps,
        expected,
        predicted,
        score,
        probability,
        frame_duration,
    )


def _validate_balanced_grid(cases: list[_CalibrationCase], required_units: int) -> set[str]:
    in_domain = [case for case in cases if case.in_domain]
    components = sorted({case.component_id for case in in_domain})
    if not required_units <= len(components) <= MAX_COMPONENTS:
        raise OffsetMeasurementError(
            f"calibration has {len(components)} independent units; D1 requires {required_units} "
            f"and permits at most {MAX_COMPONENTS}"
        )
    expected_cells = {
        (fps, kind, label) for fps in REQUIRED_FPS for kind in REQUIRED_OFFSET_KINDS for label in (False, True)
    }
    expected_counts = Counter(dict.fromkeys(expected_cells, GRID_REPLICATES_PER_CELL))
    for component_id in components:
        counts = Counter(
            (case.fps, case.offset_kind, case.correspondence_label)
            for case in in_domain
            if case.component_id == component_id
        )
        if counts != expected_counts:
            raise OffsetMeasurementError(
                f"component {component_id} must contain exactly one balanced 24/25/30-fps seven-point "
                "correspondence control per cell"
            )
    return set(components)


def _validate_calibration_cases(raw: object, *, registered: list[str], required_units: int) -> list[_CalibrationCase]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_CASES:
        raise OffsetMeasurementError(f"calibration_cases must contain 2 to {MAX_CASES} observations")
    cases = [_validate_calibration_case(item, index=index, registered=registered) for index, item in enumerate(raw)]
    identifiers = [case.case_id for case in cases]
    if identifiers != sorted(set(identifiers)):
        raise OffsetMeasurementError("calibration cases must have unique, sorted case IDs")
    components = _validate_balanced_grid(cases, required_units)
    ood_counts = Counter(case.component_id for case in cases if not case.in_domain)
    if set(ood_counts) != components or set(ood_counts.values()) != {1}:
        raise OffsetMeasurementError("calibration cases need exactly one OOD control per powered component")
    for component_id in components:
        non_abstained = [
            case
            for case in cases
            if case.in_domain and case.component_id == component_id and not case.abstained
        ]
        if {case.correspondence_label for case in non_abstained} != {False, True}:
            raise OffsetMeasurementError(
                f"component {component_id} must retain non-abstained examples of both labels "
                "for conditional calibration"
            )
    for stratum in registered:
        selected = [case for case in cases if case.in_domain and stratum in case.strata]
        labels = {case.correspondence_label for case in selected}
        if len({case.component_id for case in selected}) < 2 or labels != {False, True}:
            raise OffsetMeasurementError(f"registered stratum {stratum} lacks independent FAR/FRR evidence")
        non_abstained = [case for case in selected if not case.abstained]
        for label in (False, True):
            if len({case.component_id for case in non_abstained if case.correspondence_label is label}) < 2:
                raise OffsetMeasurementError(
                    f"registered stratum {stratum} lacks non-abstained independent evidence for label {label}"
                )
    return cases


def _validate_output_cases(raw: object, *, registered: list[str], required_units: int) -> list[_OutputCase]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_CASES:
        raise OffsetMeasurementError(f"output_cases must contain 2 to {MAX_CASES} observations")
    cases: list[_OutputCase] = []
    identifiers: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise OffsetMeasurementError(f"output case {index} must be an object")
        _exact_keys(
            item,
            {
                "output_id",
                "source_sample_id",
                "replicate_id",
                "leakage_component_id",
                "fps",
                "strata",
                "estimated_offset_ms",
            },
            f"output case {index}",
        )
        output_id = _sha256(item["output_id"], f"output case {index}.output_id")
        identifiers.append(output_id)
        source_id = _identifier(item["source_sample_id"], f"output case {output_id}.source_sample_id")
        replicate_id = _identifier(item["replicate_id"], f"output case {output_id}.replicate_id")
        component_id = _sha256(item["leakage_component_id"], f"output case {output_id}.component")
        fps = item["fps"]
        if isinstance(fps, bool) or not isinstance(fps, int) or fps not in REQUIRED_FPS:
            raise OffsetMeasurementError(f"output case {output_id}.fps must be one of {list(REQUIRED_FPS)}")
        strata = _sorted_ids(item["strata"], f"output case {output_id}.strata", maximum=MAX_REGISTERED_STRATA)
        if not set(strata).issubset(registered) or f"fps.{fps}" not in strata:
            raise OffsetMeasurementError(f"output case {output_id} has unregistered or fps-inconsistent strata")
        expected_id = document_sha256(
            {"fps": fps, "replicate_id": replicate_id, "source_sample_id": source_id}
        )
        if output_id != expected_id:
            raise OffsetMeasurementError(f"output case {output_id} is not source-derived")
        estimate = _number(item["estimated_offset_ms"], f"output case {output_id}.estimated_offset_ms")
        if not -5000 <= estimate <= 5000:
            raise OffsetMeasurementError(f"output case {output_id}.estimated_offset_ms is outside -5000..5000")
        cases.append(
            _OutputCase(output_id, source_id, replicate_id, component_id, fps, tuple(strata), estimate)
        )
    if identifiers != sorted(set(identifiers)):
        raise OffsetMeasurementError("output cases must have unique, sorted output IDs")
    component_counts = Counter(case.component_id for case in cases)
    units = len(component_counts)
    if not required_units <= units <= MAX_COMPONENTS:
        raise OffsetMeasurementError(
            f"output cases have {units} independent units; D1 requires {required_units} "
            f"and permits at most {MAX_COMPONENTS}"
        )
    if set(component_counts.values()) != {1}:
        raise OffsetMeasurementError("output cases must contain exactly one final output per independent component")
    for stratum in registered:
        if len({case.component_id for case in cases if stratum in case.strata}) < 2:
            raise OffsetMeasurementError(f"output cases lack independent coverage for registered stratum {stratum}")
    return cases


def _percentile(values: list[float], quantile: float) -> float:
    if not values:
        raise OffsetMeasurementError("percentile requires at least one observation")
    ordered = sorted(values)
    position = quantile * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _ece(values: list[tuple[float, float]]) -> float:
    if not values:
        raise OffsetMeasurementError("conditional ECE requires non-abstained observations")
    total = len(values)
    result = 0.0
    for bin_index in range(ECE_BINS):
        lower = bin_index / ECE_BINS
        upper = (bin_index + 1) / ECE_BINS
        selected = [
            value
            for value in values
            if lower <= value[0] < upper or (bin_index == ECE_BINS - 1 and value[0] == 1)
        ]
        if selected:
            confidence = sum(value[0] for value in selected) / len(selected)
            accuracy = sum(value[1] for value in selected) / len(selected)
            result += len(selected) / total * abs(accuracy - confidence)
    return result


def _group(values: list[_Case], component: Callable[[_Case], str]) -> dict[str, list[_Case]]:
    grouped: dict[str, list[_Case]] = {}
    for value in values:
        grouped.setdefault(component(value), []).append(value)
    return dict(sorted(grouped.items()))


def _aggregate(values: np.ndarray, method: _Aggregate, *, axis: int | None = None) -> np.ndarray | float:
    if method == "mean":
        return np.mean(values, axis=axis)
    if method == "median":
        return np.median(values, axis=axis)
    if method == "p95":
        return np.quantile(values, 0.95, axis=axis, method="linear")
    if method == "max":
        return np.max(values, axis=axis)
    return np.min(values, axis=axis)


def _derived_seed(seed: int, label: str) -> int:
    return int.from_bytes(hashlib.sha256(f"{seed}:{label}".encode()).digest()[:8], "big")


def _bootstrap_distribution(values: list[float], *, aggregate: _Aggregate, seed: int, label: str) -> np.ndarray:
    if len(values) < 2:
        raise OffsetMeasurementError(f"{label} needs at least two independent leakage components")
    array = np.asarray(values, dtype=np.float64)
    generator = np.random.Generator(np.random.PCG64(_derived_seed(seed, label)))
    samples = np.empty(BOOTSTRAP_REPLICATES, dtype=np.float64)
    maximum_selected_values = 2_000_000
    batch_size = max(1, min(256, maximum_selected_values // len(values)))
    for start in range(0, BOOTSTRAP_REPLICATES, batch_size):
        stop = min(start + batch_size, BOOTSTRAP_REPLICATES)
        indices = generator.integers(0, len(values), size=(stop - start, len(values)))
        samples[start:stop] = _aggregate(array[indices], aggregate, axis=1)
    return samples


def _bootstrap_bounds(samples: np.ndarray) -> tuple[float, float]:
    lower = float(np.quantile(samples, 0.025, method="lower"))
    upper = float(np.quantile(samples, 0.975, method="higher"))
    return lower, upper


def _component_metric(
    grouped: dict[str, list[_Case]],
    *,
    component_statistic: Callable[[list[_Case]], float],
    aggregate: _Aggregate,
    seed: int,
    label: str,
) -> tuple[float, float, float, int]:
    values = [component_statistic(grouped[component_id]) for component_id in sorted(grouped)]
    if not all(math.isfinite(value) for value in values):
        raise OffsetMeasurementError(f"{label} produced a non-finite component statistic")
    point = float(_aggregate(np.asarray(values, dtype=np.float64), aggregate))
    samples = _bootstrap_distribution(values, aggregate=aggregate, seed=seed, label=label)
    lower, upper = _bootstrap_bounds(samples)
    return point, min(point, lower), max(point, upper), len(values)


def _beta_continued_fraction(a: float, b: float, x: float) -> float:
    maximum_iterations = 300
    epsilon = 3e-14
    floor = 1e-300
    qab = a + b
    qap = a + 1.0
    qam = a - 1.0
    c = 1.0
    d = 1.0 - qab * x / qap
    if abs(d) < floor:
        d = floor
    d = 1.0 / d
    result = d
    for iteration in range(1, maximum_iterations + 1):
        doubled = 2 * iteration
        coefficient = iteration * (b - iteration) * x / ((qam + doubled) * (a + doubled))
        d = 1.0 + coefficient * d
        if abs(d) < floor:
            d = floor
        c = 1.0 + coefficient / c
        if abs(c) < floor:
            c = floor
        d = 1.0 / d
        result *= d * c
        coefficient = -(a + iteration) * (qab + iteration) * x / ((a + doubled) * (qap + doubled))
        d = 1.0 + coefficient * d
        if abs(d) < floor:
            d = floor
        c = 1.0 + coefficient / c
        if abs(c) < floor:
            c = floor
        d = 1.0 / d
        delta = d * c
        result *= delta
        if abs(delta - 1.0) <= epsilon:
            return result
    raise OffsetMeasurementError("exact binomial interval did not converge")


def _regularized_beta(x: float, a: float, b: float) -> float:
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    front = math.exp(
        math.lgamma(a + b)
        - math.lgamma(a)
        - math.lgamma(b)
        + a * math.log(x)
        + b * math.log1p(-x)
    )
    if x < (a + 1.0) / (a + b + 2.0):
        return front * _beta_continued_fraction(a, b, x) / a
    return 1.0 - front * _beta_continued_fraction(b, a, 1.0 - x) / b


def _beta_quantile(probability: float, a: float, b: float) -> float:
    lower = 0.0
    upper = 1.0
    for _iteration in range(100):
        midpoint = (lower + upper) / 2
        if _regularized_beta(midpoint, a, b) < probability:
            lower = midpoint
        else:
            upper = midpoint
    return (lower + upper) / 2


def _clopper_pearson(successes: int, total: int, *, confidence_level: float = CONFIDENCE_LEVEL) -> tuple[float, float]:
    if total < 1 or not 0 <= successes <= total or not 0 < confidence_level < 1:
        raise OffsetMeasurementError("binomial interval needs valid successes, total, and confidence")
    alpha = 1.0 - confidence_level
    lower = 0.0 if successes == 0 else _beta_quantile(alpha / 2, successes, total - successes + 1)
    upper = 1.0 if successes == total else _beta_quantile(1 - alpha / 2, successes + 1, total - successes)
    return lower, upper


def _conservative_component_rate(
    grouped: dict[str, list[_CalibrationCase]],
    *,
    event: Callable[[_CalibrationCase], bool],
    seed: int,
    label: str,
    event_mode: Literal["any-error", "all-success"],
    simultaneous_tests: int = 1,
) -> tuple[float, float, float, int]:
    result = _component_metric(
        grouped,
        component_statistic=lambda cases: sum(event(case) for case in cases) / len(cases),
        aggregate="mean",
        seed=seed,
        label=label,
    )
    component_events = sum(
        any(event(case) for case in cases) if event_mode == "any-error" else all(event(case) for case in cases)
        for cases in grouped.values()
    )
    confidence = 1.0 - (1.0 - CONFIDENCE_LEVEL) / simultaneous_tests
    exact_lower, exact_upper = _clopper_pearson(component_events, len(grouped), confidence_level=confidence)
    estimate, lower, upper, units = result
    if event_mode == "any-error":
        return estimate, min(estimate, lower), max(estimate, upper, exact_upper), units
    return estimate, min(estimate, lower, exact_lower), max(estimate, upper), units


def _simultaneous_component_metric(
    strata_groups: dict[str, dict[str, list[_CalibrationCase]]],
    *,
    component_statistic: Callable[[list[_CalibrationCase]], float],
    aggregate: _Aggregate,
    direction: Literal["higher-worse", "lower-worse"],
    seed: int,
    label: str,
) -> tuple[str, tuple[float, float, float, int]]:
    point_by_stratum: dict[str, float] = {}
    units: list[int] = []
    component_values_by_stratum: dict[str, dict[str, float]] = {}
    for stratum in sorted(strata_groups):
        grouped = strata_groups[stratum]
        component_values = {
            component: component_statistic(grouped[component]) for component in sorted(grouped)
        }
        if len(component_values) < 2:
            raise OffsetMeasurementError(f"{label}:{stratum} needs at least two independent components")
        point_by_stratum[stratum] = float(
            _aggregate(np.asarray(list(component_values.values())), aggregate)
        )
        units.append(len(component_values))
        component_values_by_stratum[stratum] = component_values
    choose = max if direction == "higher-worse" else min
    worst_stratum = choose(point_by_stratum, key=lambda key: (point_by_stratum[key], key))
    if aggregate != "mean":
        raise OffsetMeasurementError("simultaneous registered-stratum bootstrap currently requires component means")
    global_components = sorted(
        {component for values in component_values_by_stratum.values() for component in values}
    )
    arrays = {
        stratum: np.asarray(
            [values.get(component, math.nan) for component in global_components],
            dtype=np.float64,
        )
        for stratum, values in component_values_by_stratum.items()
    }
    generator = np.random.Generator(np.random.PCG64(_derived_seed(seed, label)))
    simultaneous = np.empty(BOOTSTRAP_REPLICATES, dtype=np.float64)
    maximum_selected_values = 2_000_000
    batch_size = max(1, min(256, maximum_selected_values // len(global_components)))
    for start in range(0, BOOTSTRAP_REPLICATES, batch_size):
        stop = min(start + batch_size, BOOTSTRAP_REPLICATES)
        indices = generator.integers(
            0,
            len(global_components),
            size=(stop - start, len(global_components)),
        )
        stratum_statistics: list[np.ndarray] = []
        for stratum in sorted(arrays):
            selected = arrays[stratum][indices]
            counts = np.sum(~np.isnan(selected), axis=1)
            if np.any(counts == 0):
                raise OffsetMeasurementError(
                    f"{label} produced an empty {stratum} resample; increase its frozen component quota"
                )
            stratum_statistics.append(np.nansum(selected, axis=1) / counts)
        stacked = np.vstack(stratum_statistics)
        simultaneous[start:stop] = (
            np.max(stacked, axis=0) if direction == "higher-worse" else np.min(stacked, axis=0)
        )
    lower, upper = _bootstrap_bounds(simultaneous)
    point = point_by_stratum[worst_stratum]
    return worst_stratum, (point, min(point, lower), max(point, upper), min(units))


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


def _subset(cases: list[_CalibrationCase], stratum: str | None) -> list[_CalibrationCase]:
    return [case for case in cases if stratum is None or stratum in case.strata]


def _groups_by_stratum(
    cases: list[_CalibrationCase], registered: list[str]
) -> dict[str, dict[str, list[_CalibrationCase]]]:
    return {stratum: _group(_subset(cases, stratum), lambda case: case.component_id) for stratum in registered}


def _exact_worst_bound(
    strata_groups: dict[str, dict[str, list[_CalibrationCase]]],
    *,
    event: Callable[[_CalibrationCase], bool],
    event_mode: Literal["any-error", "all-success"],
) -> tuple[float, float]:
    confidence = 1.0 - (1.0 - CONFIDENCE_LEVEL) / len(strata_groups)
    intervals: list[tuple[float, float]] = []
    for grouped in strata_groups.values():
        successes = sum(
            any(event(case) for case in cases) if event_mode == "any-error" else all(event(case) for case in cases)
            for cases in grouped.values()
        )
        intervals.append(_clopper_pearson(successes, len(grouped), confidence_level=confidence))
    return min(interval[0] for interval in intervals), max(interval[1] for interval in intervals)


def build_offset_measurements(  # noqa: PLR0915
    raw: object,
    *,
    control_deck: object,
    calibrator: object,
    expected_dataset_digest: str,
    trusted_preregistration_digest: str,
) -> dict[str, Any]:
    """Compute fixed D1 offset gates from a revalidated deck and calibrator."""

    if not isinstance(raw, dict):
        raise OffsetMeasurementError("offset observations must be an object")
    expected = {
        "schema_version",
        "control_deck_digest",
        "dataset_digest",
        "dataset_manifest_digest",
        "design_digest",
        "design_report_digest",
        "fit_split_manifest_digest",
        "evaluation_split_manifest_digest",
        "output_split_manifest_digest",
        "preregistration_digest",
        "offset_evaluator_digest",
        "calibration_policy_digest",
        "operating_point_digest",
        "power_report_digest",
        "strata_quotas_digest",
        "required_independent_units",
        "raw_score_threshold",
        "abstention_policy_digest",
        "release_digest",
        "strata_plan_digest",
        "bootstrap",
        "registered_strata",
        "calibration_cases",
        "output_cases",
    }
    _exact_keys(raw, expected, "offset observations")
    if raw["schema_version"] != OFFSET_OBSERVATIONS_SCHEMA:
        raise OffsetMeasurementError("unsupported offset observations schema")
    for field in (
        "control_deck_digest",
        "dataset_digest",
        "dataset_manifest_digest",
        "design_digest",
        "design_report_digest",
        "fit_split_manifest_digest",
        "evaluation_split_manifest_digest",
        "output_split_manifest_digest",
        "preregistration_digest",
        "offset_evaluator_digest",
        "calibration_policy_digest",
        "operating_point_digest",
        "power_report_digest",
        "strata_quotas_digest",
        "abstention_policy_digest",
        "release_digest",
        "strata_plan_digest",
    ):
        _sha256(raw[field], field)
    try:
        # Local import breaks the intentional constants-only offset_calibration -> offset cycle.
        from .offset_calibration import (  # noqa: PLC0415
            OffsetCalibrationError,
            validate_offset_scoring_contract,
        )

        validate_offset_scoring_contract(
            raw,
            control_deck=control_deck,
            calibrator=calibrator,
            expected_dataset_digest=expected_dataset_digest,
            trusted_preregistration_digest=trusted_preregistration_digest,
        )
    except OffsetCalibrationError as error:
        raise OffsetMeasurementError(f"offset scoring contract rejected: {error}") from error
    required_units = raw["required_independent_units"]
    if isinstance(required_units, bool) or not isinstance(required_units, int) or required_units < 2:
        raise OffsetMeasurementError("required_independent_units must be a non-null integer >= 2")
    threshold = _number(raw["raw_score_threshold"], "raw_score_threshold")
    seed = _validate_bootstrap(raw["bootstrap"])
    registered = _sorted_ids(raw["registered_strata"], "registered_strata", maximum=MAX_REGISTERED_STRATA)
    if not {f"fps.{fps}" for fps in REQUIRED_FPS}.issubset(registered):
        raise OffsetMeasurementError("registered_strata must include fps.24, fps.25, and fps.30")
    calibration = _validate_calibration_cases(
        raw["calibration_cases"], registered=registered, required_units=required_units
    )
    outputs = _validate_output_cases(raw["output_cases"], registered=registered, required_units=required_units)
    if {case.source_sample_id for case in calibration}.intersection(case.source_sample_id for case in outputs):
        raise OffsetMeasurementError("calibration/output source samples overlap")
    if {case.component_id for case in calibration}.intersection(case.component_id for case in outputs):
        raise OffsetMeasurementError("calibration/output leakage components overlap")
    in_domain = [case for case in calibration if case.in_domain]
    corresponding = [case for case in in_domain if case.correspondence_label is True and not case.abstained]
    non_abstained = [case for case in in_domain if not case.abstained]
    ood = [case for case in calibration if not case.in_domain]

    error_groups = _group(corresponding, lambda case: case.component_id)

    def absolute_errors(cases: list[_CalibrationCase]) -> list[float]:
        return [abs(case.predicted_offset_ms - case.expected_offset_ms) for case in cases]  # type: ignore[operator]

    error_median = _component_metric(
        error_groups,
        component_statistic=lambda cases: _percentile(absolute_errors(cases), 0.5),
        aggregate="median",
        seed=seed,
        label="offset-error-component-median",
    )
    error_p95 = _component_metric(
        error_groups,
        component_statistic=lambda cases: _percentile(absolute_errors(cases), 0.95),
        aggregate="p95",
        seed=seed,
        label="offset-error-component-p95",
    )

    def within(case: _CalibrationCase) -> bool:
        return abs(case.predicted_offset_ms - case.expected_offset_ms) <= case.frame_duration_ms  # type: ignore[operator]

    within_frame = _conservative_component_rate(
        error_groups,
        event=within,
        seed=seed,
        label="within-one-frame:overall",
        event_mode="all-success",
    )
    calibration_groups = _group(non_abstained, lambda case: case.component_id)
    brier = _component_metric(
        calibration_groups,
        component_statistic=lambda cases: sum(
            (case.correspondence_probability - float(bool(case.correspondence_label))) ** 2  # type: ignore[operator]
            for case in cases
        )
        / len(cases),
        aggregate="mean",
        seed=seed,
        label="conditional-brier:overall",
    )
    ece = _component_metric(
        calibration_groups,
        component_statistic=lambda cases: _ece(
            [
                (case.correspondence_probability, float(bool(case.correspondence_label)))  # type: ignore[arg-type]
                for case in cases
            ]
        ),
        aggregate="mean",
        seed=seed,
        label="conditional-ece-10-equal-width:overall",
    )

    negative_groups = _group(
        [case for case in in_domain if case.correspondence_label is False], lambda case: case.component_id
    )
    positive_groups = _group(
        [case for case in in_domain if case.correspondence_label is True], lambda case: case.component_id
    )

    def far_event(case: _CalibrationCase) -> bool:
        return case.predicted_correspondence(threshold)

    def frr_event(case: _CalibrationCase) -> bool:
        return not case.predicted_correspondence(threshold)

    overall_far = _conservative_component_rate(
        negative_groups,
        event=far_event,
        seed=seed,
        label="correspondence-far:overall",
        event_mode="any-error",
    )
    overall_frr = _conservative_component_rate(
        positive_groups,
        event=frr_event,
        seed=seed,
        label="correspondence-frr:overall",
        event_mode="any-error",
    )

    strata_negative = _groups_by_stratum(
        [case for case in in_domain if case.correspondence_label is False], registered
    )
    strata_positive = _groups_by_stratum(
        [case for case in in_domain if case.correspondence_label is True], registered
    )
    strata_non_abstained = _groups_by_stratum(non_abstained, registered)
    strata_corresponding = _groups_by_stratum(corresponding, registered)
    worst_far_id, worst_far = _simultaneous_component_metric(
        strata_negative,
        component_statistic=lambda cases: sum(far_event(case) for case in cases) / len(cases),
        aggregate="mean",
        direction="higher-worse",
        seed=seed,
        label="correspondence-far:simultaneous-worst-stratum",
    )
    _far_exact_lower, far_exact_upper = _exact_worst_bound(
        strata_negative, event=far_event, event_mode="any-error"
    )
    worst_far = (worst_far[0], worst_far[1], max(worst_far[0], worst_far[2], far_exact_upper), worst_far[3])
    worst_frr_id, worst_frr = _simultaneous_component_metric(
        strata_positive,
        component_statistic=lambda cases: sum(frr_event(case) for case in cases) / len(cases),
        aggregate="mean",
        direction="higher-worse",
        seed=seed,
        label="correspondence-frr:simultaneous-worst-stratum",
    )
    _frr_exact_lower, frr_exact_upper = _exact_worst_bound(
        strata_positive, event=frr_event, event_mode="any-error"
    )
    worst_frr = (worst_frr[0], worst_frr[1], max(worst_frr[0], worst_frr[2], frr_exact_upper), worst_frr[3])
    worst_brier_id, worst_brier = _simultaneous_component_metric(
        strata_non_abstained,
        component_statistic=lambda cases: sum(
            (case.correspondence_probability - float(bool(case.correspondence_label))) ** 2  # type: ignore[operator]
            for case in cases
        )
        / len(cases),
        aggregate="mean",
        direction="higher-worse",
        seed=seed,
        label="conditional-brier:simultaneous-worst-stratum",
    )
    worst_ece_id, worst_ece = _simultaneous_component_metric(
        strata_non_abstained,
        component_statistic=lambda cases: _ece(
            [
                (case.correspondence_probability, float(bool(case.correspondence_label)))  # type: ignore[arg-type]
                for case in cases
            ]
        ),
        aggregate="mean",
        direction="higher-worse",
        seed=seed,
        label="conditional-ece:simultaneous-worst-stratum",
    )
    worst_within_id, worst_within = _simultaneous_component_metric(
        strata_corresponding,
        component_statistic=lambda cases: sum(within(case) for case in cases) / len(cases),
        aggregate="mean",
        direction="lower-worse",
        seed=seed,
        label="within-one-frame:simultaneous-worst-stratum",
    )
    within_exact_lower, _within_exact_upper = _exact_worst_bound(
        strata_corresponding, event=within, event_mode="all-success"
    )
    worst_within = (
        worst_within[0],
        min(worst_within[0], worst_within[1], within_exact_lower),
        worst_within[2],
        worst_within[3],
    )

    false_abstention = _conservative_component_rate(
        _group(in_domain, lambda case: case.component_id),
        event=lambda case: case.abstained,
        seed=seed,
        label="in-domain-false-abstention",
        event_mode="any-error",
    )
    ood_recall = _conservative_component_rate(
        _group(ood, lambda case: case.component_id),
        event=lambda case: case.abstained,
        seed=seed,
        label="ood-abstention-recall",
        event_mode="all-success",
    )
    output_p95 = _component_metric(
        _group(outputs, lambda case: case.component_id),
        component_statistic=lambda cases: abs(cases[0].estimated_offset_ms),
        aggregate="p95",
        seed=seed,
        label="output-offset-component-p95",
    )
    metrics = [
        _metric("av-brier-score", brier, stratum="overall"),
        _metric("av-brier-score-worst-stratum", worst_brier, stratum=worst_brier_id),
        _metric("av-calibration-ece", ece, stratum="overall"),
        _metric("av-calibration-ece-worst-stratum", worst_ece, stratum=worst_ece_id),
        _metric("av-correspondence-far-ci-upper", overall_far, stratum="overall"),
        _metric("av-correspondence-far-ci-upper-worst-stratum", worst_far, stratum=worst_far_id),
        _metric("av-correspondence-frr-ci-upper", overall_frr, stratum="overall"),
        _metric("av-correspondence-frr-ci-upper-worst-stratum", worst_frr, stratum=worst_frr_id),
        _metric("av-evaluator-bootstrap95-upper-ms", error_p95, stratum="overall"),
        _metric("av-evaluator-median-absolute-error-ms", error_median, stratum="overall"),
        _metric("av-evaluator-p95-absolute-error-ms", error_p95, stratum="overall"),
        _metric("av-evaluator-within-one-frame-ci-lower", within_frame, stratum="overall"),
        _metric(
            "av-evaluator-within-one-frame-ci-lower-worst-stratum",
            worst_within,
            stratum=worst_within_id,
        ),
        _metric("av-in-domain-false-abstention-ci-upper", false_abstention, stratum="overall"),
        _metric("av-ood-abstention-recall-ci-lower", ood_recall, stratum="overall"),
        _metric("av-output-offset-p95-ms", output_p95, stratum="overall"),
    ]
    metrics.sort(key=lambda metric: metric["metric_id"])
    return {
        "schema_version": OFFSET_MEASUREMENTS_SCHEMA,
        "input_digest": document_sha256(raw),
        "control_deck_digest": raw["control_deck_digest"],
        "dataset_digest": raw["dataset_digest"],
        "dataset_manifest_digest": raw["dataset_manifest_digest"],
        "design_digest": raw["design_digest"],
        "design_report_digest": raw["design_report_digest"],
        "fit_split_manifest_digest": raw["fit_split_manifest_digest"],
        "evaluation_split_manifest_digest": raw["evaluation_split_manifest_digest"],
        "output_split_manifest_digest": raw["output_split_manifest_digest"],
        "preregistration_digest": raw["preregistration_digest"],
        "offset_evaluator_digest": raw["offset_evaluator_digest"],
        "calibration_policy_digest": raw["calibration_policy_digest"],
        "operating_point_digest": raw["operating_point_digest"],
        "power_report_digest": raw["power_report_digest"],
        "strata_quotas_digest": raw["strata_quotas_digest"],
        "required_independent_units": required_units,
        "raw_score_threshold": threshold,
        "abstention_policy_digest": raw["abstention_policy_digest"],
        "release_digest": raw["release_digest"],
        "strata_plan_digest": raw["strata_plan_digest"],
        "bootstrap": raw["bootstrap"],
        "bootstrap_rng": BOOTSTRAP_RNG,
        "binomial_interval": "component-clopper-pearson-95-bonferroni-strata.v2",
        "uncertainty_method": UNCERTAINTY_METHOD,
        "component_weighting": COMPONENT_WEIGHTING,
        "calibration_abstention_semantics": CALIBRATION_ABSTENTION_SEMANTICS,
        "grid_replicates_per_cell": GRID_REPLICATES_PER_CELL,
        "ece_bins": ECE_BINS,
        "calibration_cases": len(calibration),
        "output_cases": len(outputs),
        "metrics": metrics,
    }
