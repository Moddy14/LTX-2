"""Identity-balanced sharpness measurements on canonical face crops."""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass
from typing import Any

from .design import document_sha256

SHARPNESS_OBSERVATIONS_SCHEMA = "ltx-av-eval-sharpness-observations.v1"
SHARPNESS_MEASUREMENTS_SCHEMA = "ltx-av-eval-sharpness-measurements.v1"
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
CANONICAL_CROP_PIXELS = 256
MAX_OBSERVATIONS = 1_000_000


class SharpnessMeasurementError(ValueError):
    """Raised when normalized face-sharpness evidence is incomplete."""


@dataclass(frozen=True)
class _Observation:
    observation_id: str
    component_id: str
    strata: tuple[str, ...]
    variance: float


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise SharpnessMeasurementError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise SharpnessMeasurementError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise SharpnessMeasurementError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise SharpnessMeasurementError(f"{context} must be a lowercase SHA-256")
    return value


def _number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise SharpnessMeasurementError(f"{context} must be a finite number")
    return float(value)


def _sorted_ids(raw: object, context: str) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise SharpnessMeasurementError(f"{context} must be a non-empty list")
    identifiers = [_identifier(value, f"{context}[{index}]") for index, value in enumerate(raw)]
    if identifiers != sorted(set(identifiers)):
        raise SharpnessMeasurementError(f"{context} must be unique and sorted")
    return identifiers


def _validate_bootstrap(raw: object) -> int:
    if not isinstance(raw, dict):
        raise SharpnessMeasurementError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or isinstance(seed, bool)
        or not isinstance(seed, int)
        or not 0 <= seed < 2**63
    ):
        raise SharpnessMeasurementError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return seed


def _validate_crop(raw: object) -> None:
    if not isinstance(raw, dict):
        raise SharpnessMeasurementError("canonical_crop must be an object")
    _exact_keys(raw, {"width", "height", "color_space", "interpolation"}, "canonical_crop")
    if raw != {
        "width": CANONICAL_CROP_PIXELS,
        "height": CANONICAL_CROP_PIXELS,
        "color_space": "grayscale-linear",
        "interpolation": "area",
    }:
        raise SharpnessMeasurementError("canonical_crop must use the fixed 256px grayscale-linear area contract")


def _validate_observations(raw: object, *, registered: list[str]) -> list[_Observation]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_OBSERVATIONS:
        raise SharpnessMeasurementError(f"observations must contain 2 to {MAX_OBSERVATIONS} face crops")
    observations: list[_Observation] = []
    identifiers: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise SharpnessMeasurementError(f"observation {index} must be an object")
        _exact_keys(
            item,
            {"observation_id", "leakage_component_id", "strata", "canonical_laplacian_variance"},
            f"observation {index}",
        )
        observation_id = _identifier(item["observation_id"], f"observation {index}.observation_id")
        identifiers.append(observation_id)
        component_id = _identifier(item["leakage_component_id"], f"observation {observation_id}.component")
        strata = _sorted_ids(item["strata"], f"observation {observation_id}.strata")
        if not set(strata).issubset(registered):
            raise SharpnessMeasurementError(f"observation {observation_id} contains an unregistered stratum")
        variance = _number(
            item["canonical_laplacian_variance"],
            f"observation {observation_id}.canonical_laplacian_variance",
        )
        if not 0 <= variance <= 1_000_000:
            raise SharpnessMeasurementError(f"observation {observation_id} sharpness is outside 0..1000000")
        observations.append(_Observation(observation_id, component_id, tuple(strata), variance))
    if identifiers != sorted(set(identifiers)):
        raise SharpnessMeasurementError("observations must have unique, sorted IDs")
    return observations


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    position = quantile * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _component_medians(observations: list[_Observation], *, label: str) -> dict[str, float]:
    grouped: dict[str, list[float]] = {}
    for observation in observations:
        grouped.setdefault(observation.component_id, []).append(observation.variance)
    if len(grouped) < 2:
        raise SharpnessMeasurementError(f"{label} needs at least two independent leakage components")
    return {component_id: _percentile(values, 0.5) for component_id, values in grouped.items()}


def _bootstrap_p10(
    observations: list[_Observation],
    *,
    seed: int,
    label: str,
) -> tuple[float, float, float, int]:
    medians = _component_medians(observations, label=label)
    component_ids = sorted(medians)
    point = _percentile(list(medians.values()), 0.1)
    derived_seed = int.from_bytes(hashlib.sha256(f"{seed}:{label}".encode()).digest()[:8], "big")
    generator = random.Random(derived_seed)
    samples = [
        _percentile([medians[generator.choice(component_ids)] for _component in component_ids], 0.1)
        for _replicate in range(BOOTSTRAP_REPLICATES)
    ]
    samples.sort()
    lower = samples[math.floor(0.025 * (BOOTSTRAP_REPLICATES - 1))]
    upper = samples[math.ceil(0.975 * (BOOTSTRAP_REPLICATES - 1))]
    return point, lower, upper, len(component_ids)


def build_sharpness_measurements(raw: object) -> dict[str, Any]:
    """Compute the worst-stratum lower confidence bound of identity-balanced p10 sharpness."""

    if not isinstance(raw, dict):
        raise SharpnessMeasurementError("sharpness observations must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "dataset_digest",
            "preregistration_digest",
            "sharpness_evaluator_digest",
            "face_alignment_policy_digest",
            "strata_plan_digest",
            "bootstrap",
            "canonical_crop",
            "registered_strata",
            "observations",
        },
        "sharpness observations",
    )
    if raw["schema_version"] != SHARPNESS_OBSERVATIONS_SCHEMA:
        raise SharpnessMeasurementError("unsupported sharpness observations schema")
    for field in (
        "dataset_digest",
        "preregistration_digest",
        "sharpness_evaluator_digest",
        "face_alignment_policy_digest",
        "strata_plan_digest",
    ):
        _sha256(raw[field], field)
    seed = _validate_bootstrap(raw["bootstrap"])
    _validate_crop(raw["canonical_crop"])
    registered = _sorted_ids(raw["registered_strata"], "registered_strata")
    observations = _validate_observations(raw["observations"], registered=registered)
    strata_results = {
        stratum: _bootstrap_p10(
            [observation for observation in observations if stratum in observation.strata],
            seed=seed,
            label=f"sharpness:{stratum}",
        )
        for stratum in registered
    }
    worst = min(strata_results, key=lambda key: (strata_results[key][1], key))
    estimate, lower, upper, units = strata_results[worst]
    return {
        "schema_version": SHARPNESS_MEASUREMENTS_SCHEMA,
        "input_digest": document_sha256(raw),
        "dataset_digest": raw["dataset_digest"],
        "preregistration_digest": raw["preregistration_digest"],
        "sharpness_evaluator_digest": raw["sharpness_evaluator_digest"],
        "face_alignment_policy_digest": raw["face_alignment_policy_digest"],
        "strata_plan_digest": raw["strata_plan_digest"],
        "bootstrap": raw["bootstrap"],
        "statistic": "p10-of-leakage-component-medians",
        "canonical_crop": raw["canonical_crop"],
        "observations": len(observations),
        "metrics": [
            {
                "metric_id": "sharpness-relative-face-ci-lower",
                "estimate": estimate,
                "ci_lower": lower,
                "ci_upper": upper,
                "decision_stratum_id": worst,
                "independent_units": units,
            }
        ],
    }
