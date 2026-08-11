"""Cluster-bootstrap artifact and motion-compensated residual measurements."""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass
from typing import Any, Literal

from .design import document_sha256

ARTIFACT_OBSERVATIONS_SCHEMA = "ltx-av-eval-artifact-observations.v1"
ARTIFACT_MEASUREMENTS_SCHEMA = "ltx-av-eval-artifact-measurements.v1"
ARTIFACT_KINDS = ("flicker", "foreign-mouth", "nose-jump", "skewed-mouth", "skin-wobble")
ARTIFACT_KIND_STRATA = {f"artifact-kind.{kind}" for kind in ARTIFACT_KINDS}
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
FRAME_WARP_LIMIT = 0.04


class ArtifactMeasurementError(ValueError):
    """Raised when artifact evidence is incomplete or statistically invalid."""


@dataclass(frozen=True)
class _Observation:
    observation_id: str
    component_id: str
    strata: tuple[str, ...]
    annotation: str | None
    predicted: bool
    warp_residual: float


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise ArtifactMeasurementError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise ArtifactMeasurementError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise ArtifactMeasurementError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ArtifactMeasurementError(f"{context} must be a lowercase SHA-256")
    return value


def _sorted_ids(raw: object, context: str) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise ArtifactMeasurementError(f"{context} must be a non-empty list")
    values = [_identifier(value, f"{context}[{index}]") for index, value in enumerate(raw)]
    if values != sorted(set(values)):
        raise ArtifactMeasurementError(f"{context} must be unique and sorted")
    return values


def _validate_bootstrap(raw: object) -> int:
    if not isinstance(raw, dict):
        raise ArtifactMeasurementError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or not isinstance(seed, int)
        or isinstance(seed, bool)
        or not 0 <= seed < 2**63
    ):
        raise ArtifactMeasurementError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return seed


def _validate_strata(raw: object) -> tuple[list[str], dict[str, list[str]]]:
    if not isinstance(raw, dict):
        raise ArtifactMeasurementError("strata contract must be an object")
    _exact_keys(raw, {"registered", "far", "frr", "warp"}, "strata contract")
    registered = _sorted_ids(raw["registered"], "strata.registered")
    decision = {name: _sorted_ids(raw[name], f"strata.{name}") for name in ("far", "frr", "warp")}
    for name, strata in decision.items():
        if not set(strata).issubset(registered):
            raise ArtifactMeasurementError(f"strata.{name} contains an unregistered stratum")
    if not ARTIFACT_KIND_STRATA.issubset(decision["frr"]):
        raise ArtifactMeasurementError("FRR strata must cover all five required artifact kinds")
    if set().union(*map(set, decision.values())) != set(registered):
        raise ArtifactMeasurementError("every registered stratum must have an explicit decision role")
    return registered, decision


def _validate_observations(raw: object, registered: list[str]) -> list[_Observation]:
    if not isinstance(raw, list) or len(raw) < 2:
        raise ArtifactMeasurementError("observations must contain at least two frames")
    checked: list[_Observation] = []
    identifiers: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ArtifactMeasurementError(f"observation {index} must be an object")
        _exact_keys(
            item,
            {"observation_id", "leakage_component_id", "strata", "annotation", "predicted_artifact", "warp_residual"},
            f"observation {index}",
        )
        observation_id = _identifier(item["observation_id"], f"observation {index}.observation_id")
        identifiers.append(observation_id)
        component_id = _identifier(item["leakage_component_id"], f"observation {observation_id}.component")
        strata = _sorted_ids(item["strata"], f"observation {observation_id}.strata")
        if not set(strata).issubset(registered):
            raise ArtifactMeasurementError(f"observation {observation_id} contains an unregistered stratum")
        annotation = item["annotation"]
        if annotation is not None and annotation not in ARTIFACT_KINDS:
            raise ArtifactMeasurementError(f"observation {observation_id} has an unsupported artifact annotation")
        if annotation is not None and f"artifact-kind.{annotation}" not in strata:
            raise ArtifactMeasurementError(f"observation {observation_id} does not bind its artifact-kind stratum")
        predicted = item["predicted_artifact"]
        residual = item["warp_residual"]
        if not isinstance(predicted, bool):
            raise ArtifactMeasurementError(f"observation {observation_id}.predicted_artifact must be boolean")
        if isinstance(residual, bool) or not isinstance(residual, (int, float)) or not math.isfinite(residual):
            raise ArtifactMeasurementError(f"observation {observation_id}.warp_residual must be finite")
        if not 0 <= residual <= 1:
            raise ArtifactMeasurementError(f"observation {observation_id}.warp_residual must be between 0 and 1")
        checked.append(
            _Observation(observation_id, component_id, tuple(strata), annotation, predicted, float(residual))
        )
    if identifiers != sorted(set(identifiers)):
        raise ArtifactMeasurementError("observations must have unique, sorted IDs")
    return checked


def _subset(observations: list[_Observation], stratum: str | None) -> list[_Observation]:
    return [item for item in observations if stratum is None or stratum in item.strata]


def _rate_parts(
    observation: _Observation,
    kind: Literal["far", "frr", "within-warp"],
) -> tuple[int, int]:
    if kind == "far":
        return (int(observation.predicted), 1) if observation.annotation is None else (0, 0)
    if kind == "frr":
        return (int(not observation.predicted), 1) if observation.annotation is not None else (0, 0)
    return int(observation.warp_residual <= FRAME_WARP_LIMIT), 1


def _bootstrap_rate(
    observations: list[_Observation],
    *,
    kind: Literal["far", "frr", "within-warp"],
    seed: int,
    label: str,
) -> tuple[float, float, float, int]:
    groups: dict[str, tuple[int, int]] = {}
    for observation in observations:
        numerator, denominator = _rate_parts(observation, kind)
        if denominator:
            old_numerator, old_denominator = groups.get(observation.component_id, (0, 0))
            groups[observation.component_id] = (old_numerator + numerator, old_denominator + denominator)
    group_ids = sorted(groups)
    if len(group_ids) < 2:
        raise ArtifactMeasurementError(f"{label} needs at least two independent leakage components")
    total_numerator = sum(groups[group_id][0] for group_id in group_ids)
    total_denominator = sum(groups[group_id][1] for group_id in group_ids)
    point = total_numerator / total_denominator
    derived_seed = int.from_bytes(hashlib.sha256(f"{seed}:{label}".encode()).digest()[:8], "big")
    generator = random.Random(derived_seed)
    samples: list[float] = []
    for _replicate in range(BOOTSTRAP_REPLICATES):
        selected = [groups[generator.choice(group_ids)] for _group_id in group_ids]
        samples.append(sum(value[0] for value in selected) / sum(value[1] for value in selected))
    samples.sort()
    lower = samples[math.floor(0.025 * (BOOTSTRAP_REPLICATES - 1))]
    upper = samples[math.ceil(0.975 * (BOOTSTRAP_REPLICATES - 1))]
    return point, lower, upper, len(group_ids)


def _percentile(values: list[float], quantile: float) -> float:
    ordered = sorted(values)
    position = quantile * (len(ordered) - 1)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1 - fraction) + ordered[upper] * fraction


def _warp_percentile(observations: list[_Observation], *, label: str) -> tuple[float, int]:
    units = len({item.component_id for item in observations})
    if units < 2:
        raise ArtifactMeasurementError(f"{label} needs at least two independent leakage components")
    return _percentile([item.warp_residual for item in observations], 0.95), units


def _metric(metric_id: str, values: tuple[float, float, float, int], stratum: str) -> dict[str, Any]:
    estimate, lower, upper, units = values
    return {
        "metric_id": metric_id,
        "estimate": estimate,
        "ci_lower": lower,
        "ci_upper": upper,
        "decision_stratum_id": stratum,
        "independent_units": units,
    }


def build_artifact_measurements(raw: object) -> dict[str, Any]:
    """Compute fixed artifact FAR/FRR and warp-residual D1 measurements."""

    if not isinstance(raw, dict):
        raise ArtifactMeasurementError("artifact observations must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "dataset_digest",
            "preregistration_digest",
            "release_digest",
            "evaluator_digest",
            "strata_plan_digest",
            "bootstrap",
            "strata",
            "observations",
        },
        "artifact observations",
    )
    if raw["schema_version"] != ARTIFACT_OBSERVATIONS_SCHEMA:
        raise ArtifactMeasurementError("unsupported artifact observations schema")
    for field in (
        "dataset_digest",
        "preregistration_digest",
        "release_digest",
        "evaluator_digest",
        "strata_plan_digest",
    ):
        _sha256(raw[field], field)
    seed = _validate_bootstrap(raw["bootstrap"])
    registered, decision = _validate_strata(raw["strata"])
    observations = _validate_observations(raw["observations"], registered)
    overall = {
        kind: _bootstrap_rate(observations, kind=kind, seed=seed, label=f"{kind}:overall")
        for kind in ("far", "frr", "within-warp")
    }
    stratum_rates = {
        kind: {
            stratum: _bootstrap_rate(
                _subset(observations, stratum),
                kind=kind,
                seed=seed,
                label=f"{kind}:{stratum}",
            )
            for stratum in decision[kind]
        }
        for kind in ("far", "frr")
    }
    worst_far = max(stratum_rates["far"], key=lambda key: (stratum_rates["far"][key][2], key))
    worst_frr = max(stratum_rates["frr"], key=lambda key: (stratum_rates["frr"][key][2], key))
    overall_p95, overall_warp_units = _warp_percentile(observations, label="warp:overall")
    stratum_p95 = {
        stratum: _warp_percentile(_subset(observations, stratum), label=f"warp:{stratum}")
        for stratum in decision["warp"]
    }
    worst_warp = max(stratum_p95, key=lambda key: (stratum_p95[key][0], key))
    metrics = [
        _metric("artifact-event-far-ci-upper", overall["far"], "overall"),
        _metric("artifact-event-far-ci-upper-worst-stratum", stratum_rates["far"][worst_far], worst_far),
        _metric("artifact-event-frr-ci-upper", overall["frr"], "overall"),
        _metric("artifact-event-frr-ci-upper-worst-stratum", stratum_rates["frr"][worst_frr], worst_frr),
        _metric("artifact-frames-within-warp-limit-ci-lower", overall["within-warp"], "overall"),
        {
            "metric_id": "artifact-warp-residual-p95",
            "estimate": overall_p95,
            "ci_lower": overall_p95,
            "ci_upper": overall_p95,
            "decision_stratum_id": "overall",
            "independent_units": overall_warp_units,
        },
        {
            "metric_id": "artifact-warp-residual-p95-worst-stratum",
            "estimate": stratum_p95[worst_warp][0],
            "ci_lower": stratum_p95[worst_warp][0],
            "ci_upper": stratum_p95[worst_warp][0],
            "decision_stratum_id": worst_warp,
            "independent_units": stratum_p95[worst_warp][1],
        },
    ]
    metrics.sort(key=lambda metric: metric["metric_id"])
    return {
        "schema_version": ARTIFACT_MEASUREMENTS_SCHEMA,
        "input_digest": document_sha256(raw),
        "dataset_digest": raw["dataset_digest"],
        "preregistration_digest": raw["preregistration_digest"],
        "release_digest": raw["release_digest"],
        "evaluator_digest": raw["evaluator_digest"],
        "strata_plan_digest": raw["strata_plan_digest"],
        "bootstrap": raw["bootstrap"],
        "frame_warp_limit": FRAME_WARP_LIMIT,
        "frames": len(observations),
        "independent_units": len({item.component_id for item in observations}),
        "metrics": metrics,
    }
