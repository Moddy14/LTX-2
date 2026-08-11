"""Holm-controlled paired VBench measurements for D1."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from statistics import NormalDist, stdev
from typing import Any, Literal

from .design import DesignError, build_power_report, document_sha256

VBENCH_OBSERVATIONS_SCHEMA = "ltx-av-eval-vbench-observations.v1"
VBENCH_MEASUREMENTS_SCHEMA = "ltx-av-eval-vbench-measurements.v1"
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
FAMILYWISE_ALPHA = 0.05
MAX_OBSERVATIONS = 1_000_000


class VBenchMeasurementError(ValueError):
    """Raised when VBench evidence is incomplete, mixed, or invalid."""


@dataclass(frozen=True)
class _Observation:
    observation_id: str
    component_id: str
    claim_id: str
    dimension: str
    candidate_score: float
    anchor_score: float


@dataclass
class _Hypothesis:
    hypothesis_id: str
    endpoint_id: str
    kind: Literal["absolute", "relative"]
    estimate: float
    standard_error: float
    raw_p: float
    raw_ci_lower: float
    raw_ci_upper: float
    independent_units: int
    adjusted_p: float = 1.0
    holm_rank: int = 0
    holm_alpha: float = 0.0
    holm_ci_lower: float = -math.inf


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise VBenchMeasurementError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise VBenchMeasurementError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise VBenchMeasurementError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise VBenchMeasurementError(f"{context} must be a lowercase SHA-256")
    return value


def _score(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise VBenchMeasurementError(f"{context} must be a finite score")
    result = float(value)
    if not 0 <= result <= 1:
        raise VBenchMeasurementError(f"{context} must be between 0 and 1")
    return result


def _validate_bootstrap(raw: object) -> int:
    if not isinstance(raw, dict):
        raise VBenchMeasurementError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or isinstance(seed, bool)
        or not isinstance(seed, int)
        or not 0 <= seed < 2**63
    ):
        raise VBenchMeasurementError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return seed


def _validate_design(design: object, raw: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not isinstance(design, dict):
        raise VBenchMeasurementError("D0a design must be an object")
    try:
        report = build_power_report(design)
    except DesignError as error:
        raise VBenchMeasurementError(f"D0a design rejected: {error}") from error
    if report["status"] != "ready-to-freeze" or design["status"] != "frozen":
        raise VBenchMeasurementError("D0a design is not frozen and ready-to-freeze")
    if report["design_digest"] != raw["design_digest"]:
        raise VBenchMeasurementError("design_digest mismatch")
    if report["vbench_gate_catalog_digest"] != raw["vbench_gate_catalog_digest"]:
        raise VBenchMeasurementError("vbench_gate_catalog_digest mismatch")
    catalog = design["vbench_gate_catalog"]
    if catalog["commit"] != raw["repository_commit"] or catalog["config_sha256"] != raw["config_digest"]:
        raise VBenchMeasurementError("official VBench commit or config mismatch")
    gates = catalog["gates"]
    if any(gate["direction"] != "higher" for gate in gates):
        raise VBenchMeasurementError("VBench score gates must use higher-is-better semantics")
    if any(gate["test"] not in {"noninferiority", "superiority"} for gate in gates):
        raise VBenchMeasurementError("VBench relative gates must use noninferiority or superiority")
    return report, gates


def _validate_observations(raw: object, endpoint_ids: set[str]) -> list[_Observation]:
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_OBSERVATIONS:
        raise VBenchMeasurementError(f"observations must contain 2 to {MAX_OBSERVATIONS} rows")
    observations: list[_Observation] = []
    identifiers: list[str] = []
    covered: set[str] = set()
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise VBenchMeasurementError(f"observation {index} must be an object")
        _exact_keys(
            item,
            {
                "observation_id",
                "leakage_component_id",
                "claim_id",
                "dimension",
                "candidate_score",
                "anchor_score",
            },
            f"observation {index}",
        )
        observation_id = _identifier(item["observation_id"], f"observation {index}.observation_id")
        identifiers.append(observation_id)
        component_id = _identifier(item["leakage_component_id"], f"observation {observation_id}.component")
        claim_id = _identifier(item["claim_id"], f"observation {observation_id}.claim_id")
        dimension = _identifier(item["dimension"], f"observation {observation_id}.dimension")
        endpoint_id = f"vbench.{claim_id}.{dimension}"
        if endpoint_id not in endpoint_ids:
            raise VBenchMeasurementError(f"observation {observation_id} has an unregistered endpoint")
        covered.add(endpoint_id)
        observations.append(
            _Observation(
                observation_id,
                component_id,
                claim_id,
                dimension,
                _score(item["candidate_score"], f"observation {observation_id}.candidate_score"),
                _score(item["anchor_score"], f"observation {observation_id}.anchor_score"),
            )
        )
    if identifiers != sorted(set(identifiers)):
        raise VBenchMeasurementError("observations must have unique, sorted IDs")
    if covered != endpoint_ids:
        raise VBenchMeasurementError("observations do not cover every VBench endpoint")
    return observations


def _component_means(observations: list[_Observation]) -> dict[str, tuple[float, float]]:
    grouped: dict[str, list[_Observation]] = {}
    for observation in observations:
        grouped.setdefault(observation.component_id, []).append(observation)
    if len(grouped) < 2:
        raise VBenchMeasurementError("each VBench endpoint needs at least two independent leakage components")
    return {
        component_id: (
            sum(item.candidate_score for item in rows) / len(rows),
            sum(item.anchor_score for item in rows) / len(rows),
        )
        for component_id, rows in grouped.items()
    }


def _hypothesis(
    *,
    hypothesis_id: str,
    endpoint_id: str,
    kind: Literal["absolute", "relative"],
    point: float,
    samples: list[float],
    units: int,
) -> _Hypothesis:
    standard_error = stdev(samples) if len(set(samples)) > 1 else 0.0
    if standard_error == 0:
        raw_p = 1 / (BOOTSTRAP_REPLICATES + 1) if point > 0 else 1.0
    else:
        raw_p = max(1 / (BOOTSTRAP_REPLICATES + 1), NormalDist().cdf(-point / standard_error))
    z = NormalDist().inv_cdf(0.975)
    return _Hypothesis(
        hypothesis_id=hypothesis_id,
        endpoint_id=endpoint_id,
        kind=kind,
        estimate=point,
        standard_error=standard_error,
        raw_p=raw_p,
        raw_ci_lower=point - z * standard_error,
        raw_ci_upper=point + z * standard_error,
        independent_units=units,
    )


def _endpoint_hypotheses(
    observations: list[_Observation],
    *,
    gate: dict[str, Any],
    seed: int,
) -> tuple[_Hypothesis, _Hypothesis, int]:
    endpoint_id = f"vbench.{gate['claim_id']}.{gate['dimension']}"
    means = _component_means(observations)
    component_ids = sorted(means)
    candidate_point = sum(value[0] for value in means.values()) / len(means)
    difference_point = sum(value[0] - value[1] for value in means.values()) / len(means)
    relative_margin = (
        difference_point + gate["delta"] if gate["test"] == "noninferiority" else difference_point - gate["delta"]
    )
    absolute_margin = candidate_point - gate["absolute_minimum"]
    generator = random.Random(f"{seed}:{endpoint_id}")
    absolute_samples: list[float] = []
    relative_samples: list[float] = []
    for _replicate in range(BOOTSTRAP_REPLICATES):
        selected = [means[generator.choice(component_ids)] for _component in component_ids]
        candidate = sum(value[0] for value in selected) / len(selected)
        difference = sum(value[0] - value[1] for value in selected) / len(selected)
        absolute_samples.append(candidate - gate["absolute_minimum"])
        relative_samples.append(
            difference + gate["delta"] if gate["test"] == "noninferiority" else difference - gate["delta"]
        )
    units = len(component_ids)
    return (
        _hypothesis(
            hypothesis_id=f"{endpoint_id}:absolute",
            endpoint_id=endpoint_id,
            kind="absolute",
            point=absolute_margin,
            samples=absolute_samples,
            units=units,
        ),
        _hypothesis(
            hypothesis_id=f"{endpoint_id}:relative",
            endpoint_id=endpoint_id,
            kind="relative",
            point=relative_margin,
            samples=relative_samples,
            units=units,
        ),
        len(observations),
    )


def _apply_holm(hypotheses: list[_Hypothesis]) -> None:
    ordered = sorted(hypotheses, key=lambda hypothesis: (hypothesis.raw_p, hypothesis.hypothesis_id))
    running_adjusted = 0.0
    total = len(ordered)
    for index, hypothesis in enumerate(ordered):
        remaining = total - index
        running_adjusted = max(running_adjusted, min(1.0, remaining * hypothesis.raw_p))
        hypothesis.adjusted_p = running_adjusted
        hypothesis.holm_rank = index + 1
        hypothesis.holm_alpha = FAMILYWISE_ALPHA / remaining
        if hypothesis.standard_error == 0:
            hypothesis.holm_ci_lower = hypothesis.estimate
        else:
            critical = NormalDist().inv_cdf(1 - hypothesis.holm_alpha)
            hypothesis.holm_ci_lower = hypothesis.estimate - critical * hypothesis.standard_error


def _effect(hypothesis: _Hypothesis) -> dict[str, Any]:
    return {
        "estimate": hypothesis.estimate,
        "standard_error": hypothesis.standard_error,
        "raw_ci_lower": hypothesis.raw_ci_lower,
        "raw_ci_upper": hypothesis.raw_ci_upper,
        "raw_p": hypothesis.raw_p,
        "holm_adjusted_p": hypothesis.adjusted_p,
        "holm_rank": hypothesis.holm_rank,
        "holm_alpha": hypothesis.holm_alpha,
        "holm_ci_lower": hypothesis.holm_ci_lower,
        "independent_units": hypothesis.independent_units,
    }


def build_vbench_measurements(raw: object, *, design: object) -> dict[str, Any]:
    """Compute absolute-and-relative VBench gates under one Holm family."""

    if not isinstance(raw, dict):
        raise VBenchMeasurementError("VBench observations must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "dataset_digest",
            "preregistration_digest",
            "release_digest",
            "strata_plan_digest",
            "design_digest",
            "vbench_gate_catalog_digest",
            "repository_commit",
            "config_digest",
            "runtime_digest",
            "comparator_matrix_digest",
            "bootstrap",
            "observations",
        },
        "VBench observations",
    )
    if raw["schema_version"] != VBENCH_OBSERVATIONS_SCHEMA:
        raise VBenchMeasurementError("unsupported VBench observations schema")
    for field in (
        "dataset_digest",
        "preregistration_digest",
        "release_digest",
        "strata_plan_digest",
        "design_digest",
        "vbench_gate_catalog_digest",
        "repository_commit",
        "config_digest",
        "runtime_digest",
        "comparator_matrix_digest",
    ):
        _sha256(raw[field], field)
    seed = _validate_bootstrap(raw["bootstrap"])
    design_report, gates = _validate_design(design, raw)
    endpoint_ids = {f"vbench.{gate['claim_id']}.{gate['dimension']}" for gate in gates}
    observations = _validate_observations(raw["observations"], endpoint_ids)
    hypotheses: list[_Hypothesis] = []
    observations_by_endpoint: dict[str, int] = {}
    for gate in gates:
        endpoint_id = f"vbench.{gate['claim_id']}.{gate['dimension']}"
        endpoint_rows = [
            item for item in observations if item.claim_id == gate["claim_id"] and item.dimension == gate["dimension"]
        ]
        absolute, relative, count = _endpoint_hypotheses(endpoint_rows, gate=gate, seed=seed)
        hypotheses.extend((absolute, relative))
        observations_by_endpoint[endpoint_id] = count
    _apply_holm(hypotheses)
    by_endpoint: dict[str, dict[str, _Hypothesis]] = {}
    for hypothesis in hypotheses:
        by_endpoint.setdefault(hypothesis.endpoint_id, {})[hypothesis.kind] = hypothesis
    gates_by_endpoint = {f"vbench.{gate['claim_id']}.{gate['dimension']}": gate for gate in gates}
    metrics: list[dict[str, Any]] = []
    for endpoint_id in sorted(by_endpoint):
        gate = gates_by_endpoint[endpoint_id]
        absolute = by_endpoint[endpoint_id]["absolute"]
        relative = by_endpoint[endpoint_id]["relative"]
        adjusted_p = max(absolute.adjusted_p, relative.adjusted_p)
        metrics.append(
            {
                "metric_id": endpoint_id,
                "estimate": adjusted_p,
                "ci_lower": 0.0,
                "ci_upper": 1.0,
                "decision_stratum_id": "overall",
                "independent_units": absolute.independent_units,
                "source_observations": observations_by_endpoint[endpoint_id],
                "claim_id": gate["claim_id"],
                "dimension": gate["dimension"],
                "test": gate["test"],
                "absolute_minimum": gate["absolute_minimum"],
                "delta": gate["delta"],
                "basis_evidence_sha256": gate["basis_evidence_sha256"],
                "decision": "pass"
                if adjusted_p <= FAMILYWISE_ALPHA and absolute.holm_ci_lower > 0 and relative.holm_ci_lower > 0
                else "fail",
                "absolute": _effect(absolute),
                "relative": _effect(relative),
            }
        )
    return {
        "schema_version": VBENCH_MEASUREMENTS_SCHEMA,
        "input_digest": document_sha256(raw),
        "dataset_digest": raw["dataset_digest"],
        "preregistration_digest": raw["preregistration_digest"],
        "release_digest": raw["release_digest"],
        "strata_plan_digest": raw["strata_plan_digest"],
        "design_digest": raw["design_digest"],
        "vbench_gate_catalog_digest": raw["vbench_gate_catalog_digest"],
        "repository_commit": raw["repository_commit"],
        "config_digest": raw["config_digest"],
        "runtime_digest": raw["runtime_digest"],
        "comparator_matrix_digest": raw["comparator_matrix_digest"],
        "bootstrap": raw["bootstrap"],
        "multiplicity": "holm",
        "familywise_alpha": FAMILYWISE_ALPHA,
        "hypotheses": len(hypotheses),
        "verdict": "pass" if all(metric["decision"] == "pass" for metric in metrics) else "fail",
        "metrics": metrics,
        "design_report_digest": document_sha256(design_report),
    }
