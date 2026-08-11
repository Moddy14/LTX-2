"""Paired, fail-closed Q1 comparator-pilot evaluation."""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from datetime import date
from statistics import NormalDist, stdev
from typing import Any

from .comparator import CLAIM_SPECS, ComparatorMatrixError, build_comparator_matrix_report
from .design import document_sha256

RESULTS_SCHEMA = "ltx-av-eval-comparator-results.v1"
GATES_SCHEMA = "ltx-av-eval-comparator-gates.v1"
DECISION_SCHEMA = "ltx-av-eval-comparator-decision.v1"
BOOTSTRAP_REPLICATES = 10_000
CONFIDENCE_LEVEL = 0.95
FAMILYWISE_ALPHA = 0.05
BASE_GATE_FAMILIES = {
    "artifact",
    "asr",
    "av-sync",
    "mouth-content",
    "mos",
    "sharpness",
    "vbench",
}
REQUIRED_GATE_FAMILIES = {
    claim_id: BASE_GATE_FAMILIES | ({"identity"} if claim_id != "native-generation.text-to-video" else set())
    for claim_id in CLAIM_SPECS
}


class ComparatorResultError(ValueError):
    """Raised when Q1 evidence is unpaired, unregistered, or result-driven."""


@dataclass(frozen=True)
class _Gate:
    gate_id: str
    claim_id: str
    gate_family: str
    metric_id: str
    direction: str
    test: str
    delta: float
    valid_min: float
    valid_max: float


@dataclass(frozen=True)
class _Row:
    row_id: str
    claim_id: str
    sample_id: str
    component_id: str
    seed: int
    arm_id: str
    status: str
    measurements: dict[str, float] | None


@dataclass
class _Hypothesis:
    gate: _Gate
    benefit_estimate: float
    margin_estimate: float
    standard_error: float
    raw_p: float
    raw_ci_lower: float
    raw_ci_upper: float
    independent_units: int
    holm_adjusted_p: float = 1.0
    holm_rank: int = 0
    holm_alpha: float = 0.0
    holm_ci_lower: float = -math.inf


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise ComparatorResultError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise ComparatorResultError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise ComparatorResultError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ComparatorResultError(f"{context} must be a lowercase SHA-256")
    return value


def _finite_number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ComparatorResultError(f"{context} must be finite")
    return float(value)


def _validate_bootstrap(raw: object) -> int:
    if not isinstance(raw, dict):
        raise ComparatorResultError("bootstrap must be an object")
    _exact_keys(raw, {"replicates", "confidence_level", "seed"}, "bootstrap")
    seed = raw["seed"]
    if (
        raw["replicates"] != BOOTSTRAP_REPLICATES
        or raw["confidence_level"] != CONFIDENCE_LEVEL
        or isinstance(seed, bool)
        or not isinstance(seed, int)
        or not 0 <= seed < 2**63
    ):
        raise ComparatorResultError("bootstrap must use 10000 replicates, 95% confidence, and a 63-bit seed")
    return seed


def _validate_gate(raw: object, index: int) -> _Gate:
    if not isinstance(raw, dict):
        raise ComparatorResultError(f"gate {index} must be an object")
    _exact_keys(
        raw,
        {
            "gate_id",
            "claim_id",
            "gate_family",
            "metric_id",
            "direction",
            "test",
            "delta",
            "valid_min",
            "valid_max",
        },
        f"gate {index}",
    )
    gate_id = _identifier(raw["gate_id"], f"gate {index}.gate_id")
    claim_id = _identifier(raw["claim_id"], f"gate {gate_id}.claim_id")
    gate_family = _identifier(raw["gate_family"], f"gate {gate_id}.gate_family")
    metric_id = _identifier(raw["metric_id"], f"gate {gate_id}.metric_id")
    if claim_id not in CLAIM_SPECS:
        raise ComparatorResultError(f"gate {gate_id} has an unsupported claim")
    if gate_family not in REQUIRED_GATE_FAMILIES[claim_id]:
        raise ComparatorResultError(f"gate {gate_id} has an unsupported family for {claim_id}")
    if raw["direction"] not in {"higher", "lower"} or raw["test"] not in {"noninferiority", "superiority"}:
        raise ComparatorResultError(f"gate {gate_id} has unsupported decision semantics")
    delta = _finite_number(raw["delta"], f"gate {gate_id}.delta")
    if delta < 0 or (raw["test"] == "superiority" and delta == 0):
        raise ComparatorResultError(f"gate {gate_id} needs a non-negative, non-trivial decision delta")
    valid_min = _finite_number(raw["valid_min"], f"gate {gate_id}.valid_min")
    valid_max = _finite_number(raw["valid_max"], f"gate {gate_id}.valid_max")
    if valid_min >= valid_max:
        raise ComparatorResultError(f"gate {gate_id} has an invalid measurement range")
    return _Gate(
        gate_id,
        claim_id,
        gate_family,
        metric_id,
        raw["direction"],
        raw["test"],
        delta,
        valid_min,
        valid_max,
    )


def _validate_gates(raw: object, *, target_claims: set[str]) -> tuple[list[_Gate], str]:
    if not isinstance(raw, dict):
        raise ComparatorResultError("Q1 gate catalog must be an object")
    _exact_keys(raw, {"schema_version", "status", "gates"}, "Q1 gate catalog")
    if raw["schema_version"] != GATES_SCHEMA or raw["status"] != "frozen":
        raise ComparatorResultError("Q1 gate catalog must be frozen with the supported schema")
    if not isinstance(raw["gates"], list):
        raise ComparatorResultError("Q1 gates must be a list")
    gates = [_validate_gate(item, index) for index, item in enumerate(raw["gates"])]
    gate_ids = [gate.gate_id for gate in gates]
    identities = [(gate.claim_id, gate.metric_id) for gate in gates]
    if gate_ids != sorted(set(gate_ids)) or len(identities) != len(set(identities)):
        raise ComparatorResultError("Q1 gates must be uniquely sorted by gate_id and claim/metric")
    if {gate.claim_id for gate in gates} != target_claims:
        raise ComparatorResultError("Q1 gates must exactly cover the frozen SOTA target claims")
    for claim_id in target_claims:
        claim_gates = [gate for gate in gates if gate.claim_id == claim_id]
        families = {gate.gate_family for gate in claim_gates}
        if families != REQUIRED_GATE_FAMILIES[claim_id]:
            raise ComparatorResultError(f"SOTA target {claim_id} does not cover every required gate family")
        if not any(gate.test == "superiority" for gate in claim_gates):
            raise ComparatorResultError(f"SOTA target {claim_id} needs a positive superiority gate")
        if not any(gate.test == "noninferiority" for gate in claim_gates):
            raise ComparatorResultError(f"SOTA target {claim_id} needs non-inferiority guardrails")
    return gates, document_sha256(raw)


def _matrix_commitment(matrix: dict[str, Any], artifact_id: str) -> str:
    matches = [item for item in matrix["commitments"] if item["artifact_id"] == artifact_id]
    if len(matches) != 1:
        raise ComparatorResultError(f"matrix commitment {artifact_id} is not unique")
    return _sha256(matches[0]["sha256"], f"matrix commitment {artifact_id}")


def _claim_inventory(matrix: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {claim["claim_id"]: claim for claim in matrix["claims"]}


def _validate_measurements(raw: object, *, row_id: str, gates: list[_Gate]) -> dict[str, float]:
    expected = {gate.metric_id for gate in gates}
    if not isinstance(raw, dict) or set(raw) != expected:
        raise ComparatorResultError(f"row {row_id} measurements do not match its frozen Q1 gates")
    ranges = {gate.metric_id: (gate.valid_min, gate.valid_max) for gate in gates}
    measurements: dict[str, float] = {}
    for metric_id in sorted(raw):
        value = _finite_number(raw[metric_id], f"row {row_id}.{metric_id}")
        minimum, maximum = ranges[metric_id]
        if not minimum <= value <= maximum:
            raise ComparatorResultError(f"row {row_id}.{metric_id} is outside its frozen range")
        measurements[metric_id] = value
    return measurements


def _validate_rows(raw: object, *, matrix: dict[str, Any], gates: list[_Gate]) -> list[_Row]:
    if not isinstance(raw, list) or not raw:
        raise ComparatorResultError("Q1 rows must be a non-empty list")
    claims = _claim_inventory(matrix)
    gates_by_claim = {claim_id: [gate for gate in gates if gate.claim_id == claim_id] for claim_id in claims}
    rows: list[_Row] = []
    row_ids: list[str] = []
    sample_components: dict[tuple[str, str], str] = {}
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ComparatorResultError(f"row {index} must be an object")
        _exact_keys(
            item,
            {
                "row_id",
                "claim_id",
                "sample_id",
                "leakage_component_id",
                "generation_seed",
                "arm_id",
                "status",
                "measurements",
            },
            f"row {index}",
        )
        row_id = _identifier(item["row_id"], f"row {index}.row_id")
        claim_id = _identifier(item["claim_id"], f"row {row_id}.claim_id")
        if claim_id not in claims:
            raise ComparatorResultError(f"row {row_id} has an unknown claim")
        sample_id = _identifier(item["sample_id"], f"row {row_id}.sample_id")
        component_id = _identifier(item["leakage_component_id"], f"row {row_id}.component")
        previous = sample_components.setdefault((claim_id, sample_id), component_id)
        if previous != component_id:
            raise ComparatorResultError(f"sample {claim_id}/{sample_id} maps to multiple leakage components")
        seed = item["generation_seed"]
        if isinstance(seed, bool) or not isinstance(seed, int) or seed < 0:
            raise ComparatorResultError(f"row {row_id} has an invalid generation seed")
        arm_id = _identifier(item["arm_id"], f"row {row_id}.arm_id")
        included = {arm["arm_id"] for arm in claims[claim_id]["arms"] if arm["inclusion_status"] == "included"}
        if arm_id not in included:
            raise ComparatorResultError(f"row {row_id} uses an arm not included before quality evidence")
        status = item["status"]
        if status == "completed":
            measurements = _validate_measurements(item["measurements"], row_id=row_id, gates=gates_by_claim[claim_id])
        elif status == "failed" and item["measurements"] is None:
            measurements = None
        else:
            raise ComparatorResultError(f"row {row_id} has an invalid ITT status or measurement payload")
        row_ids.append(row_id)
        rows.append(_Row(row_id, claim_id, sample_id, component_id, seed, arm_id, status, measurements))
    if row_ids != sorted(set(row_ids)):
        raise ComparatorResultError("Q1 rows must have unique, sorted row IDs")
    return rows


def _validate_factorial(rows: list[_Row], *, matrix: dict[str, Any]) -> None:
    claims = _claim_inventory(matrix)
    for claim_id, claim in claims.items():
        included = sorted(arm["arm_id"] for arm in claim["arms"] if arm["inclusion_status"] == "included")
        claim_rows = [row for row in rows if row.claim_id == claim_id]
        if not claim_rows:
            raise ComparatorResultError(f"claim {claim_id} has no Q1 rows")
        cells_by_arm = {
            arm_id: {(row.sample_id, row.component_id, row.seed) for row in claim_rows if row.arm_id == arm_id}
            for arm_id in included
        }
        unique_cell_sets = {frozenset(cells) for cells in cells_by_arm.values()}
        if any(not cells for cells in cells_by_arm.values()) or len(unique_cell_sets) != 1:
            raise ComparatorResultError(f"claim {claim_id} does not form an exact paired arm factorial")
        expected = sum(len(cells) for cells in cells_by_arm.values())
        if len(claim_rows) != expected:
            raise ComparatorResultError(f"claim {claim_id} contains duplicate factorial cells")
        if claim["claim_status"] == "sota-target":
            components = {row.component_id for row in claim_rows}
            if len(components) < 2:
                raise ComparatorResultError(f"SOTA target {claim_id} needs at least two independent components")


def _hypothesis(rows: list[_Row], *, gate: _Gate, owned_arm: str, anchor_arm: str, seed: int) -> _Hypothesis:
    indexed = {
        (row.sample_id, row.component_id, row.seed, row.arm_id): row
        for row in rows
        if row.claim_id == gate.claim_id and row.arm_id in {owned_arm, anchor_arm}
    }
    component_benefits: dict[str, list[float]] = {}
    for sample_id, component_id, generation_seed, arm_id in sorted(indexed):
        if arm_id != owned_arm:
            continue
        candidate = indexed[(sample_id, component_id, generation_seed, owned_arm)]
        anchor = indexed[(sample_id, component_id, generation_seed, anchor_arm)]
        if candidate.measurements is None or anchor.measurements is None:
            continue
        difference = candidate.measurements[gate.metric_id] - anchor.measurements[gate.metric_id]
        benefit = difference if gate.direction == "higher" else -difference
        component_benefits.setdefault(component_id, []).append(benefit)
    if len(component_benefits) < 2:
        raise ComparatorResultError(f"gate {gate.gate_id} lacks two independent completed pairs")
    component_means = {
        component_id: sum(values) / len(values) for component_id, values in component_benefits.items()
    }
    components = sorted(component_means)
    benefit_estimate = sum(component_means.values()) / len(component_means)
    margin_estimate = (
        benefit_estimate - gate.delta if gate.test == "superiority" else benefit_estimate + gate.delta
    )
    if len(set(component_means.values())) == 1:
        standard_error = 0.0
    else:
        generator = random.Random(f"{seed}:{gate.gate_id}")
        bootstrap = [
            sum(component_means[generator.choice(components)] for _component in components) / len(components)
            for _replicate in range(BOOTSTRAP_REPLICATES)
        ]
        standard_error = stdev(bootstrap) if len(set(bootstrap)) > 1 else 0.0
    raw_p = (
        max(1 / (BOOTSTRAP_REPLICATES + 1), NormalDist().cdf(-margin_estimate / standard_error))
        if standard_error
        else (1 / (BOOTSTRAP_REPLICATES + 1) if margin_estimate > 0 else 1.0)
    )
    critical = NormalDist().inv_cdf(0.975)
    return _Hypothesis(
        gate,
        benefit_estimate,
        margin_estimate,
        standard_error,
        raw_p,
        margin_estimate - critical * standard_error,
        margin_estimate + critical * standard_error,
        len(components),
    )


def _apply_holm(hypotheses: list[_Hypothesis], *, family_size: int) -> None:
    ordered = sorted(hypotheses, key=lambda hypothesis: (hypothesis.raw_p, hypothesis.gate.gate_id))
    running = 0.0
    for index, hypothesis in enumerate(ordered):
        remaining = family_size - index
        running = max(running, min(1.0, remaining * hypothesis.raw_p))
        hypothesis.holm_adjusted_p = running
        hypothesis.holm_rank = index + 1
        hypothesis.holm_alpha = FAMILYWISE_ALPHA / remaining
        critical = NormalDist().inv_cdf(1 - hypothesis.holm_alpha)
        hypothesis.holm_ci_lower = hypothesis.margin_estimate - critical * hypothesis.standard_error


def _decision_reports(
    rows: list[_Row],
    *,
    matrix: dict[str, Any],
    gates: list[_Gate],
    seed: int,
) -> tuple[list[dict[str, Any]], list[str]]:
    claims = _claim_inventory(matrix)
    hypotheses: list[_Hypothesis] = []
    failed_claims = {
        claim_id for claim_id in claims if any(row.status == "failed" for row in rows if row.claim_id == claim_id)
    }
    for gate in gates:
        claim = claims[gate.claim_id]
        owned_arm = CLAIM_SPECS[gate.claim_id][2]
        anchor_arm = claim["sota_anchor_arm_id"]
        if gate.claim_id not in failed_claims:
            hypotheses.append(_hypothesis(rows, gate=gate, owned_arm=owned_arm, anchor_arm=anchor_arm, seed=seed))
    _apply_holm(hypotheses, family_size=len(gates))
    by_claim: dict[str, list[_Hypothesis]] = {}
    for hypothesis in hypotheses:
        by_claim.setdefault(hypothesis.gate.claim_id, []).append(hypothesis)
    reports: list[dict[str, Any]] = []
    blockers: list[str] = []
    for claim_id in sorted(claims):
        claim = claims[claim_id]
        outcomes = by_claim.get(claim_id, [])
        if claim_id in failed_claims:
            status = "failed-itt"
            blockers.append(f"claim-failed-itt:{claim_id}")
        elif claim["claim_status"] == "local-only":
            status = "local-only"
        else:
            passed = len(outcomes) == len([gate for gate in gates if gate.claim_id == claim_id]) and all(
                outcome.holm_adjusted_p <= FAMILYWISE_ALPHA and outcome.holm_ci_lower > 0 for outcome in outcomes
            )
            status = "sota-pilot-pass" if passed else "sota-pilot-fail"
            if not passed:
                blockers.append(f"sota-pilot-failed:{claim_id}")
        reports.append(
            {
                "claim_id": claim_id,
                "claim_status": claim["claim_status"],
                "owned_arm_id": CLAIM_SPECS[claim_id][2],
                "sota_anchor_arm_id": claim["sota_anchor_arm_id"],
                "status": status,
                "gates": [
                    {
                        "gate_id": outcome.gate.gate_id,
                        "gate_family": outcome.gate.gate_family,
                        "metric_id": outcome.gate.metric_id,
                        "direction": outcome.gate.direction,
                        "test": outcome.gate.test,
                        "delta": outcome.gate.delta,
                        "benefit_estimate": outcome.benefit_estimate,
                        "decision_margin_estimate": outcome.margin_estimate,
                        "standard_error": outcome.standard_error,
                        "raw_ci_lower": outcome.raw_ci_lower,
                        "raw_ci_upper": outcome.raw_ci_upper,
                        "raw_p": outcome.raw_p,
                        "holm_adjusted_p": outcome.holm_adjusted_p,
                        "holm_rank": outcome.holm_rank,
                        "holm_alpha": outcome.holm_alpha,
                        "holm_ci_lower": outcome.holm_ci_lower,
                        "independent_units": outcome.independent_units,
                        "verdict": (
                            "pass"
                            if outcome.holm_adjusted_p <= FAMILYWISE_ALPHA and outcome.holm_ci_lower > 0
                            else "fail"
                        ),
                    }
                    for outcome in sorted(outcomes, key=lambda item: item.gate.gate_id)
                ],
            }
        )
    return reports, sorted(blockers)


def build_comparator_decision(
    raw: object,
    *,
    gates: object,
    matrix: object,
    landscape: object,
    as_of: date,
) -> dict[str, Any]:
    """Evaluate the frozen Q1 pilot without allowing post-result arm selection."""

    if not isinstance(raw, dict) or not isinstance(matrix, dict):
        raise ComparatorResultError("Q1 results and comparator matrix must be objects")
    _exact_keys(
        raw,
        {
            "schema_version",
            "release_digest",
            "calibration_dataset_digest",
            "preregistration_digest",
            "comparator_matrix_digest",
            "q1_runner_digest",
            "bootstrap",
            "rows",
        },
        "Q1 results",
    )
    if raw["schema_version"] != RESULTS_SCHEMA:
        raise ComparatorResultError("unsupported Q1 result schema")
    for field in (
        "release_digest",
        "calibration_dataset_digest",
        "preregistration_digest",
        "comparator_matrix_digest",
        "q1_runner_digest",
    ):
        _sha256(raw[field], field)
    try:
        matrix_report = build_comparator_matrix_report(matrix, landscape=landscape, as_of=as_of)
    except ComparatorMatrixError as error:
        raise ComparatorResultError(f"frozen Q1 matrix rejected: {error}") from error
    if matrix["status"] != "frozen" or matrix_report["status"] != "ready-to-freeze":
        raise ComparatorResultError("Q1 matrix must be frozen and ready-to-freeze")
    if raw["comparator_matrix_digest"] != matrix_report["matrix_digest"]:
        raise ComparatorResultError("Q1 comparator matrix digest mismatch")
    target_claims = set(matrix_report["target_sota_claim_ids"])
    validated_gates, gates_digest = _validate_gates(gates, target_claims=target_claims)
    if gates_digest != _matrix_commitment(matrix, "applicable_gates"):
        raise ComparatorResultError("Q1 gates do not match the pre-result matrix commitment")
    seed = _validate_bootstrap(raw["bootstrap"])
    rows = _validate_rows(raw["rows"], matrix=matrix, gates=validated_gates)
    _validate_factorial(rows, matrix=matrix)
    claims, blockers = _decision_reports(rows, matrix=matrix, gates=validated_gates, seed=seed)
    target_reports = [claim for claim in claims if claim["claim_status"] == "sota-target"]
    sota_ready = bool(target_reports) and all(claim["status"] == "sota-pilot-pass" for claim in target_reports)
    return {
        "schema_version": DECISION_SCHEMA,
        "input_digest": document_sha256(raw),
        "release_digest": raw["release_digest"],
        "calibration_dataset_digest": raw["calibration_dataset_digest"],
        "preregistration_digest": raw["preregistration_digest"],
        "comparator_matrix_digest": raw["comparator_matrix_digest"],
        "gates_digest": gates_digest,
        "q1_runner_digest": raw["q1_runner_digest"],
        "bootstrap": raw["bootstrap"],
        "rows": len(rows),
        "failed_rows": sum(row.status == "failed" for row in rows),
        "target_sota_claim_ids": matrix_report["target_sota_claim_ids"],
        "claims": claims,
        "blockers": blockers,
        "status": "ready-to-freeze" if not blockers else "hold",
        "sota_status": "anchor-pilot-pass" if not blockers and sota_ready else "hold",
    }
