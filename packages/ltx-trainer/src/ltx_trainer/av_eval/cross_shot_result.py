"""Paired, ITT-safe Q0 cross-shot result evaluation."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from statistics import NormalDist, stdev
from typing import Any

from .cross_shot import (
    ARM_SPECS,
    CLAIM_IDS,
    COMPARISON_SPECS,
    ENDPOINT_SPECS,
    REQUIRED_MEASUREMENT_IDS,
    CrossShotProtocolError,
    build_cross_shot_protocol_report,
)
from .design import DesignError, build_power_report, document_sha256

LEGACY_CROSS_SHOT_RESULTS_SCHEMA = "ltx-av-eval-cross-shot-results.v1"
LEGACY_CROSS_SHOT_DECISION_SCHEMA = "ltx-av-eval-cross-shot-decision.v1"
CROSS_SHOT_RESULTS_SCHEMA = "ltx-av-eval-cross-shot-results.v2"
CROSS_SHOT_DECISION_SCHEMA = "ltx-av-eval-cross-shot-decision.v2"
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
FAMILYWISE_ALPHA = 0.05
ENDPOINT_MEASUREMENTS = {
    "asr-word-error-rate": "asr-word-error-rate",
    "identity-similarity": "cross-shot-min-identity-probability",
    "lip-sync-mos": "lip-sync-mos",
    "mouth-naturalness-mos": "mouth-naturalness-mos",
    "sharpness-relative-face": "face-sharpness-relative",
    "skin-stability": "skin-nose-mouth-stability",
}


class CrossShotResultError(ValueError):
    """Raised when Q0 result evidence breaks pairing or frozen decisions."""


@dataclass(frozen=True)
class _Row:
    row_id: str
    identity_id: str
    component_id: str
    claim_id: str
    shot_id: str
    seed: int
    arm_id: str
    status: str
    measurements: dict[str, float] | None


@dataclass
class _Hypothesis:
    hypothesis_id: str
    comparison_id: str
    claim_id: str
    endpoint_id: str
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
        raise CrossShotResultError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise CrossShotResultError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise CrossShotResultError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise CrossShotResultError(f"{context} must be a lowercase SHA-256")
    return value


def _measurement(value: object, metric_id: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CrossShotResultError(f"measurement {metric_id} must be finite")
    result = float(value)
    if metric_id.endswith("-mos") or metric_id == "asr-word-error-rate":
        valid = 0 <= result <= 10
    elif metric_id == "av-sync-offset-p95":
        valid = 0 <= result <= 5000
    elif metric_id == "face-sharpness-relative":
        valid = 0 <= result <= 1_000_000
    else:
        valid = 0 <= result <= 1
    if not valid:
        raise CrossShotResultError(f"measurement {metric_id} is outside its registered range")
    return result


def _validate_bootstrap(raw: object) -> int:
    if not isinstance(raw, dict):
        raise CrossShotResultError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or isinstance(seed, bool)
        or not isinstance(seed, int)
        or not 0 <= seed < 2**63
    ):
        raise CrossShotResultError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return seed


def _validate_measurements(raw: object, row_id: str) -> dict[str, float]:
    if not isinstance(raw, dict) or set(raw) != REQUIRED_MEASUREMENT_IDS:
        raise CrossShotResultError(f"row {row_id} measurements must exactly cover the Q0 inventory")
    return {metric_id: _measurement(raw[metric_id], metric_id) for metric_id in sorted(raw)}


def _validate_rows(raw: object) -> list[_Row]:
    if not isinstance(raw, list) or not raw:
        raise CrossShotResultError("rows must be a non-empty list")
    rows: list[_Row] = []
    identifiers: list[str] = []
    identity_components: dict[str, str] = {}
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise CrossShotResultError(f"row {index} must be an object")
        _exact_keys(
            item,
            {
                "row_id",
                "identity_id",
                "leakage_component_id",
                "claim_id",
                "shot_id",
                "generation_seed",
                "arm_id",
                "status",
                "measurements",
            },
            f"row {index}",
        )
        row_id = _identifier(item["row_id"], f"row {index}.row_id")
        identifiers.append(row_id)
        identity_id = _identifier(item["identity_id"], f"row {row_id}.identity_id")
        component_id = _identifier(item["leakage_component_id"], f"row {row_id}.component")
        previous = identity_components.setdefault(identity_id, component_id)
        if previous != component_id:
            raise CrossShotResultError(f"identity {identity_id} maps to multiple leakage components")
        claim_id = _identifier(item["claim_id"], f"row {row_id}.claim_id")
        shot_id = _identifier(item["shot_id"], f"row {row_id}.shot_id")
        arm_id = _identifier(item["arm_id"], f"row {row_id}.arm_id")
        seed = item["generation_seed"]
        status = item["status"]
        if claim_id not in CLAIM_IDS or arm_id not in ARM_SPECS:
            raise CrossShotResultError(f"row {row_id} has an unregistered claim or arm")
        if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
            raise CrossShotResultError(f"row {row_id} has an invalid generation seed")
        if status not in {"completed", "failed"}:
            raise CrossShotResultError(f"row {row_id} has an invalid ITT status")
        if status == "completed":
            measurements = _validate_measurements(item["measurements"], row_id)
        elif item["measurements"] is not None:
            raise CrossShotResultError(f"failed row {row_id} must not contain measurements")
        else:
            measurements = None
        rows.append(_Row(row_id, identity_id, component_id, claim_id, shot_id, seed, arm_id, status, measurements))
    if identifiers != sorted(set(identifiers)):
        raise CrossShotResultError("rows must have unique, sorted IDs")
    return rows


def _validate_factorial(rows: list[_Row], protocol: dict[str, Any]) -> None:
    plan = protocol["sample_plan"]
    identities = sorted({row.identity_id for row in rows})
    if len(identities) != plan["required_identities"]:
        raise CrossShotResultError("Q0 rows do not match the frozen identity count")
    if len({row.component_id for row in rows}) != plan["required_identities"]:
        raise CrossShotResultError("Q0 rows do not match the frozen independent-component count")
    expected_seeds = set(plan["generation_seeds"])
    expected_arms = set(ARM_SPECS)
    seen_cells: set[tuple[str, str, str, int, str]] = set()
    shots_by_identity: dict[tuple[str, str], set[str]] = {}
    for row in rows:
        cell = (row.claim_id, row.identity_id, row.shot_id, row.seed, row.arm_id)
        if cell in seen_cells:
            raise CrossShotResultError("Q0 rows contain a duplicate factorial cell")
        seen_cells.add(cell)
        shots_by_identity.setdefault((row.claim_id, row.identity_id), set()).add(row.shot_id)
    for claim_id in CLAIM_IDS:
        for identity_id in identities:
            shots = shots_by_identity.get((claim_id, identity_id), set())
            if len(shots) != plan["shots_per_identity"]:
                raise CrossShotResultError("Q0 rows do not match the frozen shots-per-identity count")
            expected = {
                (claim_id, identity_id, shot_id, seed, arm_id)
                for shot_id in shots
                for seed in expected_seeds
                for arm_id in expected_arms
            }
            if not expected.issubset(seen_cells):
                raise CrossShotResultError("Q0 rows do not form the complete paired factorial")
    expected_total = (
        len(CLAIM_IDS) * len(identities) * plan["shots_per_identity"] * len(expected_seeds) * len(expected_arms)
    )
    if len(rows) != expected_total:
        raise CrossShotResultError("Q0 rows contain cells outside the frozen factorial")


def _validate_absolute_evidence(raw: object) -> dict[tuple[str, str], dict[str, Any]]:
    if not isinstance(raw, list):
        raise CrossShotResultError("absolute_gate_evidence must be a list")
    results: dict[tuple[str, str], dict[str, Any]] = {}
    identities: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise CrossShotResultError(f"absolute evidence {index} must be an object")
        _exact_keys(
            item,
            {"claim_id", "arm_id", "evidence_digest", "passed_measurement_ids"},
            f"absolute evidence {index}",
        )
        claim_id = _identifier(item["claim_id"], f"absolute evidence {index}.claim_id")
        arm_id = _identifier(item["arm_id"], f"absolute evidence {index}.arm_id")
        identity = f"{claim_id}:{arm_id}"
        identities.append(identity)
        _sha256(item["evidence_digest"], f"absolute evidence {identity}.digest")
        passed = item["passed_measurement_ids"]
        if (
            not isinstance(passed, list)
            or passed != sorted(set(passed))
            or not set(passed).issubset(REQUIRED_MEASUREMENT_IDS)
        ):
            raise CrossShotResultError(f"absolute evidence {identity} has invalid passed measurements")
        results[(claim_id, arm_id)] = item
    expected = sorted(f"{claim_id}:{arm_id}" for claim_id in CLAIM_IDS for arm_id in ARM_SPECS)
    if identities != expected:
        raise CrossShotResultError("absolute evidence must exactly cover every claim and arm")
    return results


def _delta_map(design: dict[str, Any]) -> dict[str, float]:
    result: dict[str, float] = {}
    for metric in design["delta_catalog"]["metrics"]:
        if metric["metric_id"] in ENDPOINT_SPECS:
            result[metric["metric_id"]] = metric["delta"]
    if set(result) != set(ENDPOINT_SPECS):
        raise CrossShotResultError("D0a delta catalog does not cover every Q0 endpoint")
    return result


def _comparison_hypothesis(
    rows: list[_Row],
    *,
    comparison_id: str,
    claim_id: str,
    endpoint_id: str,
    delta: float,
    seed: int,
) -> _Hypothesis:
    challenger, comparator = COMPARISON_SPECS[comparison_id]
    by_cell = {(row.identity_id, row.shot_id, row.seed, row.arm_id): row for row in rows if row.claim_id == claim_id}
    component_values: dict[str, list[float]] = {}
    measurement_id = ENDPOINT_MEASUREMENTS[endpoint_id]
    test, direction = ENDPOINT_SPECS[endpoint_id]
    for identity_id, shot_id, generation_seed, arm_id in sorted(by_cell):
        if arm_id != challenger:
            continue
        candidate = by_cell[(identity_id, shot_id, generation_seed, challenger)]
        baseline = by_cell[(identity_id, shot_id, generation_seed, comparator)]
        if candidate.measurements is None or baseline.measurements is None:
            continue
        difference = candidate.measurements[measurement_id] - baseline.measurements[measurement_id]
        benefit = difference if direction == "higher" else -difference
        margin = benefit - delta if test == "superiority" else benefit + delta
        component_values.setdefault(candidate.component_id, []).append(margin)
    if len(component_values) < 2:
        raise CrossShotResultError(f"{comparison_id}/{claim_id}/{endpoint_id} lacks independent completed pairs")
    component_means = {component: sum(values) / len(values) for component, values in component_values.items()}
    components = sorted(component_means)
    point = sum(component_means.values()) / len(component_means)
    if len(set(component_means.values())) == 1:
        standard_error = 0.0
    else:
        generator = random.Random(f"{seed}:{comparison_id}:{claim_id}:{endpoint_id}")
        samples = [
            sum(component_means[generator.choice(components)] for _component in components) / len(components)
            for _replicate in range(BOOTSTRAP_REPLICATES)
        ]
        standard_error = stdev(samples) if len(set(samples)) > 1 else 0.0
    raw_p = (
        max(1 / (BOOTSTRAP_REPLICATES + 1), NormalDist().cdf(-point / standard_error))
        if standard_error
        else (1 / (BOOTSTRAP_REPLICATES + 1) if point > 0 else 1.0)
    )
    z = NormalDist().inv_cdf(0.975)
    return _Hypothesis(
        hypothesis_id=f"{claim_id}:{comparison_id}:{endpoint_id}",
        comparison_id=comparison_id,
        claim_id=claim_id,
        endpoint_id=endpoint_id,
        estimate=point,
        standard_error=standard_error,
        raw_p=raw_p,
        raw_ci_lower=point - z * standard_error,
        raw_ci_upper=point + z * standard_error,
        independent_units=len(components),
    )


def _apply_holm(hypotheses: list[_Hypothesis], *, family_size: int) -> None:
    ordered = sorted(hypotheses, key=lambda hypothesis: (hypothesis.raw_p, hypothesis.hypothesis_id))
    running = 0.0
    for index, hypothesis in enumerate(ordered):
        remaining = family_size - index
        running = max(running, min(1.0, remaining * hypothesis.raw_p))
        hypothesis.adjusted_p = running
        hypothesis.holm_rank = index + 1
        hypothesis.holm_alpha = FAMILYWISE_ALPHA / remaining
        critical = NormalDist().inv_cdf(1 - hypothesis.holm_alpha)
        hypothesis.holm_ci_lower = hypothesis.estimate - critical * hypothesis.standard_error


def _comparison_reports(
    rows: list[_Row],
    *,
    deltas: dict[str, float],
    absolute: dict[tuple[str, str], dict[str, Any]],
    seed: int,
) -> tuple[list[dict[str, Any]], dict[tuple[str, str], bool]]:
    hypotheses: list[_Hypothesis] = []
    failed: set[tuple[str, str]] = set()
    for claim_id in CLAIM_IDS:
        for comparison_id, (challenger, comparator) in COMPARISON_SPECS.items():
            relevant = [row for row in rows if row.claim_id == claim_id and row.arm_id in {challenger, comparator}]
            if any(row.status == "failed" for row in relevant):
                failed.add((claim_id, comparison_id))
                continue
            for endpoint_id in sorted(ENDPOINT_SPECS):
                hypotheses.append(
                    _comparison_hypothesis(
                        rows,
                        comparison_id=comparison_id,
                        claim_id=claim_id,
                        endpoint_id=endpoint_id,
                        delta=deltas[endpoint_id],
                        seed=seed,
                    )
                )
    family_size = len(CLAIM_IDS) * len(COMPARISON_SPECS) * len(ENDPOINT_SPECS)
    _apply_holm(hypotheses, family_size=family_size)
    by_comparison: dict[tuple[str, str], list[_Hypothesis]] = {}
    for hypothesis in hypotheses:
        by_comparison.setdefault((hypothesis.claim_id, hypothesis.comparison_id), []).append(hypothesis)
    reports: list[dict[str, Any]] = []
    decisions: dict[tuple[str, str], bool] = {}
    for claim_id in CLAIM_IDS:
        for comparison_id, (challenger, comparator) in COMPARISON_SPECS.items():
            key = (claim_id, comparison_id)
            endpoint_results = by_comparison.get(key, [])
            absolute_pass = all(
                set(absolute[(claim_id, arm_id)]["passed_measurement_ids"]) == REQUIRED_MEASUREMENT_IDS
                for arm_id in (challenger, comparator)
            )
            passed = (
                key not in failed
                and absolute_pass
                and len(endpoint_results) == len(ENDPOINT_SPECS)
                and all(item.adjusted_p <= FAMILYWISE_ALPHA and item.holm_ci_lower > 0 for item in endpoint_results)
            )
            decisions[key] = passed
            reports.append(
                {
                    "claim_id": claim_id,
                    "comparison_id": comparison_id,
                    "challenger_arm_id": challenger,
                    "comparator_arm_id": comparator,
                    "status": "pass" if passed else ("failed-itt" if key in failed else "fail"),
                    "absolute_gates_pass": absolute_pass,
                    "endpoints": [
                        {
                            "metric_id": item.endpoint_id,
                            "estimate": item.estimate,
                            "standard_error": item.standard_error,
                            "raw_ci_lower": item.raw_ci_lower,
                            "raw_ci_upper": item.raw_ci_upper,
                            "raw_p": item.raw_p,
                            "holm_adjusted_p": item.adjusted_p,
                            "holm_rank": item.holm_rank,
                            "holm_alpha": item.holm_alpha,
                            "holm_ci_lower": item.holm_ci_lower,
                            "independent_units": item.independent_units,
                        }
                        for item in sorted(endpoint_results, key=lambda result: result.endpoint_id)
                    ],
                }
            )
    return reports, decisions


def build_cross_shot_decision(raw: object, *, protocol: object, design: object) -> dict[str, Any]:
    """Evaluate the frozen Q0 factorial and select one strategy per claim."""

    if not isinstance(raw, dict) or not isinstance(protocol, dict) or not isinstance(design, dict):
        raise CrossShotResultError("Q0 results, protocol, and design must be objects")
    _exact_keys(
        raw,
        {"schema_version", "protocol_digest", "design_digest", "bootstrap", "absolute_gate_evidence", "rows"},
        "Q0 results",
    )
    if raw["schema_version"] != CROSS_SHOT_RESULTS_SCHEMA:
        raise CrossShotResultError("unsupported Q0 results schema")
    if raw["protocol_digest"] != document_sha256(protocol):
        raise CrossShotResultError("Q0 protocol digest mismatch")
    try:
        design_report = build_power_report(design)
        protocol_report = build_cross_shot_protocol_report(protocol, design_report=design_report)
    except (DesignError, CrossShotProtocolError) as error:
        raise CrossShotResultError(f"frozen Q0 contract rejected: {error}") from error
    if design["status"] != "frozen" or design_report["status"] != "ready-to-freeze":
        raise CrossShotResultError("D0a design must be frozen and ready-to-freeze")
    if protocol["status"] != "frozen" or protocol_report["status"] != "ready-to-freeze":
        raise CrossShotResultError("Q0 protocol must be frozen and ready-to-freeze")
    if raw["design_digest"] != design_report["design_digest"]:
        raise CrossShotResultError("Q0 design digest mismatch")
    seed = _validate_bootstrap(raw["bootstrap"])
    rows = _validate_rows(raw["rows"])
    _validate_factorial(rows, protocol)
    absolute = _validate_absolute_evidence(raw["absolute_gate_evidence"])
    comparisons, decisions = _comparison_reports(rows, deltas=_delta_map(design), absolute=absolute, seed=seed)
    binding_index = {binding["artifact_id"]: binding["sha256"] for binding in protocol["bindings"]}
    selections: list[dict[str, Any]] = []
    for claim_id in CLAIM_IDS:
        manual = decisions[(claim_id, "manual-vs-none")]
        automatic = decisions[(claim_id, "automatic-vs-none")] and decisions[(claim_id, "automatic-vs-manual")]
        selected = "automatic-scene-reference" if automatic else ("manual-scene-reference" if manual else None)
        selections.append(
            {
                "claim_id": claim_id,
                "decision": "winner" if selected is not None else "abstention",
                "selected_arm_id": selected,
                "automatic_default_enabled": selected == "automatic-scene-reference",
            }
        )
    return {
        "schema_version": CROSS_SHOT_DECISION_SCHEMA,
        "input_digest": document_sha256(raw),
        "protocol_digest": raw["protocol_digest"],
        "design_digest": raw["design_digest"],
        "surface_digest": design_report["surface_digest"],
        "candidate_surface_binding_digest": design_report["candidate_surface_binding_digest"],
        "release_digest": binding_index["release"],
        "preregistration_digest": binding_index["preregistration"],
        "dataset_digest": binding_index["dataset"],
        "calibration_catalog_digest": binding_index["calibration_catalog"],
        "calibration_report_digest": binding_index["calibration_report"],
        "evaluator_bundle_digest": binding_index["evaluator_bundle"],
        "generation_runner_digest": binding_index["generation_runner"],
        "prompt_set_digest": binding_index["prompt_set"],
        "rating_protocol_digest": binding_index["rating_protocol"],
        "bindings_digest": protocol_report["bindings_digest"],
        "comparisons_digest": protocol_report["comparisons_digest"],
        "bootstrap": raw["bootstrap"],
        "rows": len(rows),
        "failed_rows": sum(row.status == "failed" for row in rows),
        "comparisons": comparisons,
        "selections": selections,
        "verdict": "winner" if all(item["decision"] == "winner" for item in selections) else "abstention",
    }
