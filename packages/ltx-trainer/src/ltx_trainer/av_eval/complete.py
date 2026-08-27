"""Complete fixed and claim-specific VBench D1 evidence assembly."""

from __future__ import annotations

import math
from datetime import UTC, datetime
from statistics import NormalDist
from typing import Any

from .bundle import FIXED_D1_REPORT_SCHEMA, OFFSET_CONTRACT_KEYS
from .calibration import CALIBRATION_REPORT_SCHEMA, CalibrationError, build_calibration_gate_report
from .design import (
    CURRENT_PLANNING_HYPOTHESIS_COUNT,
    CURRENT_VBENCH_CLAIM_COUNT,
    CURRENT_VBENCH_GATE_COUNT,
    DesignError,
    build_power_report,
    document_sha256,
)
from .design import REPORT_SCHEMA as DESIGN_REPORT_SCHEMA
from .offset import (
    BOOTSTRAP_RNG,
    CALIBRATION_ABSTENTION_SEMANTICS,
    COMPONENT_WEIGHTING,
    GRID_REPLICATES_PER_CELL,
    UNCERTAINTY_METHOD,
)
from .vbench import FAMILYWISE_ALPHA, VBENCH_MEASUREMENTS_SCHEMA
from .vbench_environment import VBenchEnvironmentError, validate_vbench_runtime_report

LEGACY_COMPLETE_D1_BUNDLE_SCHEMA = "ltx-av-eval-complete-d1-bundle.v1"
LEGACY_COMPLETE_D1_REPORT_SCHEMA = "ltx-av-eval-complete-d1-report.v1"
COMPLETE_D1_BUNDLE_SCHEMA = "ltx-av-eval-complete-d1-bundle.v2"
COMPLETE_D1_REPORT_SCHEMA = "ltx-av-eval-complete-d1-report.v2"
COMPLETE_D1_REPORT_KEYS = {
    "schema_version",
    "report_id",
    "producer_id",
    "generated_at",
    "runner_digest",
    "dataset_digest",
    "preregistration_digest",
    "release_digest",
    "design_digest",
    "design_report_digest",
    "surface_digest",
    "candidate_surface_binding_digest",
    "strata_plan_digest",
    "calibration_catalog_digest",
    "calibration_catalog",
    "fixed_report_digest",
    "vbench_report_digest",
    "vbench_runtime_report_digest",
    "offset_contract",
    "fixed_report",
    "vbench_report",
    "vbench_runtime_report",
    "vbench_gate_catalog",
    "verdict",
    "metrics",
}
FIXED_REPORT_KEYS = {
    "schema_version",
    "bundle_digest",
    "calibration_catalog_digest",
    "dataset_digest",
    "preregistration_digest",
    "release_digest",
    "design_digest",
    "surface_digest",
    "candidate_surface_binding_digest",
    "strata_plan_digest",
    "source_report_digests",
    "offset_contract",
    "verdict",
    "metrics",
}
VBENCH_REPORT_KEYS = {
    "schema_version",
    "input_digest",
    "dataset_digest",
    "preregistration_digest",
    "release_digest",
    "surface_digest",
    "candidate_surface_binding_digest",
    "strata_plan_digest",
    "design_digest",
    "vbench_gate_catalog_digest",
    "repository_commit",
    "config_digest",
    "runtime_digest",
    "comparator_matrix_digest",
    "bootstrap",
    "multiplicity",
    "familywise_alpha",
    "hypotheses",
    "verdict",
    "metrics",
    "design_report_digest",
}


class CompleteD1Error(ValueError):
    """Raised when complete D1 evidence is inconsistent or incomplete."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise CompleteD1Error(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise CompleteD1Error(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise CompleteD1Error(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise CompleteD1Error(f"{context} must be a lowercase SHA-256")
    return value


def _number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CompleteD1Error(f"{context} must be a finite number")
    return float(value)


def _timestamp(value: object, context: str) -> str:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise CompleteD1Error(f"{context} must be a whole-second UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise CompleteD1Error(f"{context} is invalid") from error
    if parsed.tzinfo != UTC or parsed.microsecond:
        raise CompleteD1Error(f"{context} must be a whole-second UTC timestamp")
    return value


def _validate_catalog_and_design(
    catalog: object,
    design: object,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    if not isinstance(catalog, dict) or not isinstance(design, dict):
        raise CompleteD1Error("calibration catalog and design must be objects")
    try:
        catalog_report = build_calibration_gate_report(catalog)
        design_report = build_power_report(design)
    except (CalibrationError, DesignError) as error:
        raise CompleteD1Error(f"frozen D1 contract rejected: {error}") from error
    if catalog_report["schema_version"] != CALIBRATION_REPORT_SCHEMA:
        raise CompleteD1Error("calibration catalog uses a legacy report schema")
    if design_report["schema_version"] != DESIGN_REPORT_SCHEMA:
        raise CompleteD1Error("D0a design uses a legacy power-report schema")
    if catalog_report["status"] != "ready-to-freeze" or design_report["status"] != "ready-to-freeze":
        raise CompleteD1Error("calibration catalog and D0a design must be ready-to-freeze")
    if catalog["status"] != "frozen" or design["status"] != "frozen":
        raise CompleteD1Error("calibration catalog and D0a design must be frozen")
    if catalog["design_digest"] != design_report["design_digest"]:
        raise CompleteD1Error("calibration catalog does not bind the supplied D0a design")
    if catalog["vbench_gate_catalog_digest"] != design_report["vbench_gate_catalog_digest"]:
        raise CompleteD1Error("calibration catalog does not bind the supplied VBench gates")
    gates = {gate["metric_id"]: gate for gate in catalog["gates"]}
    vbench_gates = {
        f"vbench.{gate['claim_id']}.{gate['dimension']}": gate for gate in design["vbench_gate_catalog"]["gates"]
    }
    return catalog_report, design_report, gates, vbench_gates


def _validate_shared_bindings(fixed: dict[str, Any], vbench: dict[str, Any]) -> None:
    for field in (
        "dataset_digest",
        "preregistration_digest",
        "release_digest",
        "design_digest",
        "surface_digest",
        "candidate_surface_binding_digest",
        "strata_plan_digest",
    ):
        _sha256(fixed.get(field), f"fixed.{field}")
        _sha256(vbench.get(field), f"vbench.{field}")
        if fixed[field] != vbench[field]:
            raise CompleteD1Error(f"fixed and VBench reports disagree on {field}")


def _validate_offset_contract(fixed: dict[str, Any], design_report: dict[str, Any]) -> dict[str, Any]:
    raw = fixed.get("offset_contract")
    if not isinstance(raw, dict):
        raise CompleteD1Error("fixed D1 report lacks the propagated offset-v2 contract")
    _exact_keys(raw, OFFSET_CONTRACT_KEYS, "fixed offset contract")
    for field in (
        "abstention_policy_digest",
        "control_deck_digest",
        "dataset_manifest_digest",
        "design_digest",
        "design_report_digest",
        "fit_split_manifest_digest",
        "evaluation_split_manifest_digest",
        "output_split_manifest_digest",
        "calibration_policy_digest",
        "operating_point_digest",
        "offset_evaluator_digest",
        "power_report_digest",
        "strata_quotas_digest",
    ):
        _sha256(raw[field], f"fixed offset contract.{field}")
    deterministic_report_digest = document_sha256(design_report)
    if (
        raw["design_digest"] != fixed["design_digest"]
        or raw["design_digest"] != design_report["design_digest"]
        or raw["design_report_digest"] != deterministic_report_digest
        or raw["power_report_digest"] != deterministic_report_digest
    ):
        raise CompleteD1Error("fixed offset contract does not bind the supplied deterministic D0a report")
    if (
        raw["required_independent_units"] != design_report["required_independent_units"]
        or raw["strata_quotas_digest"] != design_report["strata_quotas_digest"]
        or raw["strata_quotas_digest"] != fixed["strata_plan_digest"]
    ):
        raise CompleteD1Error("fixed offset contract does not retain the exact D0a units and strata quotas")
    _number(raw["raw_score_threshold"], "fixed offset contract.raw_score_threshold")
    bootstrap = raw["bootstrap"]
    if (
        not isinstance(bootstrap, dict)
        or set(bootstrap) != {"replicates", "confidence_level", "seed"}
        or bootstrap["replicates"] != 10_000
        or bootstrap["confidence_level"] != 0.95
        or isinstance(bootstrap["seed"], bool)
        or not isinstance(bootstrap["seed"], int)
        or not 0 <= bootstrap["seed"] < 2**63
    ):
        raise CompleteD1Error("fixed offset contract changed its frozen bootstrap contract")
    if (
        raw["bootstrap_rng"] != BOOTSTRAP_RNG
        or raw["binomial_interval"] != "component-clopper-pearson-95-bonferroni-strata.v2"
        or raw["uncertainty_method"] != UNCERTAINTY_METHOD
        or raw["component_weighting"] != COMPONENT_WEIGHTING
        or raw["calibration_abstention_semantics"] != CALIBRATION_ABSTENTION_SEMANTICS
        or raw["grid_replicates_per_cell"] != GRID_REPLICATES_PER_CELL
        or raw["ece_bins"] != 10
    ):
        raise CompleteD1Error("fixed offset contract changed its uncertainty, grid, or abstention semantics")
    return dict(raw)


def _validate_fixed_metrics(
    fixed: dict[str, Any],
    gates: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    raw_metrics = fixed.get("metrics")
    if not isinstance(raw_metrics, list) or not raw_metrics:
        raise CompleteD1Error("fixed D1 report must contain metrics")
    metrics: list[dict[str, Any]] = []
    identifiers: list[str] = []
    for index, metric in enumerate(raw_metrics):
        if not isinstance(metric, dict):
            raise CompleteD1Error(f"fixed metric {index} must be an object")
        _exact_keys(
            metric,
            {
                "metric_id",
                "estimate",
                "ci_lower",
                "ci_upper",
                "decision_stratum_id",
                "independent_units",
                "source",
                "source_observations",
                "direction",
                "decision_value",
                "threshold",
                "basis_evidence_sha256",
                "evaluated_value",
                "decision",
            },
            f"fixed metric {index}",
        )
        metric_id = _identifier(metric["metric_id"], f"fixed metric {index}.metric_id")
        identifiers.append(metric_id)
        if metric_id not in gates:
            raise CompleteD1Error(f"fixed report contains unknown metric {metric_id}")
        gate = gates[metric_id]
        estimate = _number(metric["estimate"], f"metric {metric_id}.estimate")
        lower = _number(metric["ci_lower"], f"metric {metric_id}.ci_lower")
        upper = _number(metric["ci_upper"], f"metric {metric_id}.ci_upper")
        if not lower <= estimate <= upper:
            raise CompleteD1Error(f"metric {metric_id} has inconsistent bounds")
        values = {"estimate": estimate, "ci-lower": lower, "ci-upper": upper}
        evaluated = values[gate["decision_value"]]
        expected = (
            "pass"
            if (evaluated >= gate["threshold"] if gate["direction"] == "higher" else evaluated <= gate["threshold"])
            else "fail"
        )
        if (
            metric["direction"] != gate["direction"]
            or metric["decision_value"] != gate["decision_value"]
            or metric["threshold"] != gate["threshold"]
            or metric["basis_evidence_sha256"] != gate["basis_evidence_sha256"]
            or metric["evaluated_value"] != evaluated
            or metric["decision"] != expected
        ):
            raise CompleteD1Error(f"fixed metric {metric_id} decision contract mismatch")
        units = metric["independent_units"]
        observations = metric["source_observations"]
        if (
            isinstance(units, bool)
            or not isinstance(units, int)
            or isinstance(observations, bool)
            or not isinstance(observations, int)
            or not 2 <= units <= observations
        ):
            raise CompleteD1Error(f"fixed metric {metric_id} has invalid sample counts")
        metrics.append(
            {
                "metric_id": metric_id,
                "estimate": estimate,
                "ci_lower": lower,
                "ci_upper": upper,
                "threshold": gate["threshold"],
                "direction": gate["direction"],
                "decision_value": gate["decision_value"],
                "decision": expected,
                "independent_units": units,
                "clips": observations,
                "strata_digest": fixed["strata_plan_digest"],
            }
        )
    if identifiers != sorted(set(identifiers)) or set(identifiers) != set(gates):
        raise CompleteD1Error("fixed report does not exactly cover the 44 local gates")
    return metrics


def _validate_current_design_report(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict) or raw.get("schema_version") != DESIGN_REPORT_SCHEMA:
        raise CompleteD1Error("D1 requires the current D0a power-report schema")
    if raw.get("status") != "ready-to-freeze" or raw.get("blockers") != []:
        raise CompleteD1Error("D1 requires a ready-to-freeze D0a power report")
    if (
        raw.get("planning_hypothesis_count") != CURRENT_PLANNING_HYPOTHESIS_COUNT
        or raw.get("vbench_claim_count") != CURRENT_VBENCH_CLAIM_COUNT
        or raw.get("vbench_gate_count") != CURRENT_VBENCH_GATE_COUNT
    ):
        raise CompleteD1Error("D1 D0a report does not cover the exact current planning family")
    for field in (
        "design_digest",
        "vbench_gate_catalog_digest",
        "strata_quotas_digest",
        "surface_digest",
        "candidate_surface_binding_digest",
    ):
        _sha256(raw.get(field), f"D0a report.{field}")
    return raw


def _validate_embedded_vbench_catalog(raw: object, design_report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict) or document_sha256(raw) != design_report["vbench_gate_catalog_digest"]:
        raise CompleteD1Error("D1 embedded VBench gate catalog does not match D0a")
    gates = raw.get("gates")
    if not isinstance(gates, list) or len(gates) != CURRENT_VBENCH_GATE_COUNT:
        raise CompleteD1Error(
            f"D1 embedded VBench catalog must contain exactly {CURRENT_VBENCH_GATE_COUNT} gates"
        )
    by_metric: dict[str, dict[str, Any]] = {}
    identities: list[str] = []
    for index, gate in enumerate(gates):
        if not isinstance(gate, dict):
            raise CompleteD1Error(f"D1 embedded VBench gate {index} must be an object")
        _exact_keys(
            gate,
            {"claim_id", "dimension", "direction", "absolute_minimum", "delta", "test", "basis_evidence_sha256"},
            f"D1 embedded VBench gate {index}",
        )
        metric_id = f"vbench.{gate['claim_id']}.{gate['dimension']}"
        identities.append(metric_id)
        by_metric[metric_id] = gate
    if len(identities) != len(set(identities)) or len(by_metric) != CURRENT_VBENCH_GATE_COUNT:
        raise CompleteD1Error("D1 embedded VBench gates must be unique")
    return by_metric


def validate_complete_d1_report(  # noqa: PLR0912, PLR0915
    raw: object,
    *,
    calibration_catalog: object | None = None,
    design_report: object,
) -> dict[str, Any]:
    """Fully revalidate the self-contained canonical D1-v2 report consumed by F0/Q2."""

    if not isinstance(raw, dict):
        raise CompleteD1Error("complete D1 report must be an object")
    _exact_keys(raw, COMPLETE_D1_REPORT_KEYS, "complete D1 report")
    if raw["schema_version"] != COMPLETE_D1_REPORT_SCHEMA:
        raise CompleteD1Error("unsupported complete D1 report schema")
    _identifier(raw["report_id"], "complete D1 report.report_id")
    _identifier(raw["producer_id"], "complete D1 report.producer_id")
    _timestamp(raw["generated_at"], "complete D1 report.generated_at")
    for field in (
        "runner_digest",
        "dataset_digest",
        "preregistration_digest",
        "release_digest",
        "design_digest",
        "design_report_digest",
        "surface_digest",
        "candidate_surface_binding_digest",
        "strata_plan_digest",
        "calibration_catalog_digest",
        "fixed_report_digest",
        "vbench_report_digest",
        "vbench_runtime_report_digest",
    ):
        _sha256(raw[field], f"complete D1 report.{field}")
    embedded_catalog = raw["calibration_catalog"]
    if calibration_catalog is None:
        calibration_catalog = embedded_catalog
    if not isinstance(calibration_catalog, dict) or calibration_catalog != embedded_catalog:
        raise CompleteD1Error("complete D1 calibration catalog must be an object")
    try:
        catalog_report = build_calibration_gate_report(calibration_catalog)
    except CalibrationError as error:
        raise CompleteD1Error(f"complete D1 calibration catalog rejected: {error}") from error
    if (
        catalog_report["schema_version"] != CALIBRATION_REPORT_SCHEMA
        or catalog_report["status"] != "ready-to-freeze"
        or calibration_catalog.get("status") != "frozen"
    ):
        raise CompleteD1Error("complete D1 requires a frozen current calibration catalog")
    current_design = _validate_current_design_report(design_report)
    fixed = raw["fixed_report"]
    vbench = raw["vbench_report"]
    if not isinstance(fixed, dict) or not isinstance(vbench, dict):
        raise CompleteD1Error("complete D1 embedded reports must be objects")
    _exact_keys(fixed, FIXED_REPORT_KEYS, "complete D1 fixed report")
    _exact_keys(vbench, VBENCH_REPORT_KEYS, "complete D1 VBench report")
    if fixed["schema_version"] != FIXED_D1_REPORT_SCHEMA or vbench["schema_version"] != VBENCH_MEASUREMENTS_SCHEMA:
        raise CompleteD1Error("complete D1 embedded report schema mismatch")
    try:
        runtime = validate_vbench_runtime_report(raw["vbench_runtime_report"])
    except VBenchEnvironmentError as error:
        raise CompleteD1Error(f"complete D1 VBench runtime rejected: {error}") from error
    fixed_gates = {gate["metric_id"]: gate for gate in calibration_catalog["gates"]}
    vbench_gates = _validate_embedded_vbench_catalog(raw["vbench_gate_catalog"], current_design)
    if sorted(vbench_gates) != calibration_catalog["vbench_metric_ids"]:
        raise CompleteD1Error("complete D1 VBench gates disagree with the calibration catalog")
    _validate_shared_bindings(fixed, vbench)
    for field in (
        "dataset_digest",
        "preregistration_digest",
        "release_digest",
        "design_digest",
        "surface_digest",
        "candidate_surface_binding_digest",
        "strata_plan_digest",
    ):
        if raw[field] != fixed[field]:
            raise CompleteD1Error(f"complete D1 top-level {field} disagrees with embedded evidence")
    if (
        raw["design_digest"] != current_design["design_digest"]
        or raw["design_report_digest"] != document_sha256(current_design)
        or raw["surface_digest"] != current_design["surface_digest"]
        or raw["candidate_surface_binding_digest"] != current_design["candidate_surface_binding_digest"]
        or raw["strata_plan_digest"] != current_design["strata_quotas_digest"]
    ):
        raise CompleteD1Error("complete D1 does not bind the supplied current D0a report")
    if (
        raw["calibration_catalog_digest"] != catalog_report["catalog_digest"]
        or fixed["calibration_catalog_digest"] != catalog_report["catalog_digest"]
        or calibration_catalog.get("design_digest") != current_design["design_digest"]
    ):
        raise CompleteD1Error("complete D1 calibration/design binding mismatch")
    if (
        raw["fixed_report_digest"] != document_sha256(fixed)
        or raw["vbench_report_digest"] != document_sha256(vbench)
        or raw["vbench_runtime_report_digest"] != document_sha256(runtime)
        or vbench["design_report_digest"] != document_sha256(current_design)
    ):
        raise CompleteD1Error("complete D1 embedded evidence digest mismatch")
    offset_contract = _validate_offset_contract(fixed, current_design)
    if raw["offset_contract"] != offset_contract:
        raise CompleteD1Error("complete D1 top-level offset contract mismatch")
    fingerprints = {item["evaluator_id"]: item["sha256"] for item in calibration_catalog["evaluator_fingerprints"]}
    if (
        offset_contract["offset_evaluator_digest"] != fingerprints["offset-evaluator"]
        or vbench["runtime_digest"] != fingerprints["vbench-runtime"]
        or vbench["runtime_digest"] != runtime["runtime_digest"]
    ):
        raise CompleteD1Error("complete D1 evaluator fingerprint mismatch")
    fixed_metrics = _validate_fixed_metrics(fixed, fixed_gates)
    vbench_metrics = _validate_vbench_metrics(vbench, vbench_gates)
    metrics = sorted([*fixed_metrics, *vbench_metrics], key=lambda metric: metric["metric_id"])
    if (
        len(metrics) != len(catalog_report["required_metric_ids"])
        or [metric["metric_id"] for metric in metrics] != catalog_report["required_metric_ids"]
    ):
        raise CompleteD1Error("complete D1 must contain exactly the current metric catalog")
    if raw["metrics"] != metrics:
        raise CompleteD1Error("complete D1 canonical metric projection mismatch")
    expected_verdict = "pass" if all(metric["decision"] == "pass" for metric in metrics) else "fail"
    expected_hypotheses = 2 * CURRENT_VBENCH_GATE_COUNT
    if raw["verdict"] != expected_verdict or vbench.get("hypotheses") != expected_hypotheses:
        raise CompleteD1Error(
            f"complete D1 verdict or {expected_hypotheses}-member Holm family mismatch"
        )
    return dict(raw)


def _validate_effect(
    effect: object,
    *,
    metric_id: str,
    kind: str,
    hypothesis_count: int,
) -> tuple[float, float, int, int]:
    if not isinstance(effect, dict):
        raise CompleteD1Error(f"VBench {metric_id} {kind} effect must be an object")
    _exact_keys(
        effect,
        {
            "estimate",
            "standard_error",
            "raw_ci_lower",
            "raw_ci_upper",
            "raw_p",
            "holm_adjusted_p",
            "holm_rank",
            "holm_alpha",
            "holm_ci_lower",
            "independent_units",
        },
        f"VBench {metric_id} {kind} effect",
    )
    values = {
        field: _number(effect[field], f"VBench {metric_id} {kind}.{field}")
        for field in (
            "estimate",
            "standard_error",
            "raw_ci_lower",
            "raw_ci_upper",
            "raw_p",
            "holm_adjusted_p",
            "holm_alpha",
            "holm_ci_lower",
        )
    }
    rank = effect["holm_rank"]
    units = effect["independent_units"]
    if isinstance(rank, bool) or not isinstance(rank, int) or not 1 <= rank <= hypothesis_count:
        raise CompleteD1Error(f"VBench {metric_id} {kind} has invalid Holm rank")
    if isinstance(units, bool) or not isinstance(units, int) or units < 2:
        raise CompleteD1Error(f"VBench {metric_id} {kind} has invalid independent units")
    if effect["holm_alpha"] != FAMILYWISE_ALPHA / (hypothesis_count - rank + 1):
        raise CompleteD1Error(f"VBench {metric_id} {kind} has invalid rank-specific alpha")
    if values["standard_error"] < 0:
        raise CompleteD1Error(f"VBench {metric_id} {kind} has a negative standard error")
    if not 0 <= values["raw_p"] <= values["holm_adjusted_p"] <= 1:
        raise CompleteD1Error(f"VBench {metric_id} {kind} has invalid probability values")
    raw_critical = NormalDist().inv_cdf(0.975)
    holm_critical = NormalDist().inv_cdf(1 - values["holm_alpha"])
    expected_raw_lower = values["estimate"] - raw_critical * values["standard_error"]
    expected_raw_upper = values["estimate"] + raw_critical * values["standard_error"]
    expected_holm_lower = values["estimate"] - holm_critical * values["standard_error"]
    if not (
        math.isclose(values["raw_ci_lower"], expected_raw_lower, rel_tol=1e-12, abs_tol=1e-12)
        and math.isclose(values["raw_ci_upper"], expected_raw_upper, rel_tol=1e-12, abs_tol=1e-12)
        and math.isclose(values["holm_ci_lower"], expected_holm_lower, rel_tol=1e-12, abs_tol=1e-12)
    ):
        raise CompleteD1Error(f"VBench {metric_id} {kind} confidence bounds are inconsistent")
    return values["holm_adjusted_p"], values["raw_p"], rank, units


def _validate_vbench_metrics(
    vbench: dict[str, Any],
    gates: dict[str, dict[str, Any]],
) -> list[dict[str, Any]]:
    raw_metrics = vbench.get("metrics")
    if not isinstance(raw_metrics, list) or not raw_metrics:
        raise CompleteD1Error("VBench report must contain metrics")
    metrics: list[dict[str, Any]] = []
    identifiers: list[str] = []
    ranks: list[int] = []
    ranked_p: list[tuple[int, float, float]] = []
    hypothesis_count = 2 * len(gates)
    for index, metric in enumerate(raw_metrics):
        if not isinstance(metric, dict):
            raise CompleteD1Error(f"VBench metric {index} must be an object")
        _exact_keys(
            metric,
            {
                "metric_id",
                "estimate",
                "ci_lower",
                "ci_upper",
                "decision_stratum_id",
                "independent_units",
                "source_observations",
                "claim_id",
                "dimension",
                "test",
                "absolute_minimum",
                "delta",
                "basis_evidence_sha256",
                "decision",
                "absolute",
                "relative",
            },
            f"VBench metric {index}",
        )
        metric_id = _identifier(metric["metric_id"], f"VBench metric {index}.metric_id")
        identifiers.append(metric_id)
        if metric_id not in gates:
            raise CompleteD1Error(f"VBench report contains unknown metric {metric_id}")
        gate = gates[metric_id]
        expected_gate = (
            gate["claim_id"],
            gate["dimension"],
            gate["test"],
            gate["absolute_minimum"],
            gate["delta"],
            gate["basis_evidence_sha256"],
        )
        actual_gate = (
            metric["claim_id"],
            metric["dimension"],
            metric["test"],
            metric["absolute_minimum"],
            metric["delta"],
            metric["basis_evidence_sha256"],
        )
        if actual_gate != expected_gate:
            raise CompleteD1Error(f"VBench metric {metric_id} gate contract mismatch")
        absolute_p, absolute_raw_p, absolute_rank, absolute_units = _validate_effect(
            metric["absolute"],
            metric_id=metric_id,
            kind="absolute",
            hypothesis_count=hypothesis_count,
        )
        relative_p, relative_raw_p, relative_rank, relative_units = _validate_effect(
            metric["relative"],
            metric_id=metric_id,
            kind="relative",
            hypothesis_count=hypothesis_count,
        )
        ranks.extend((absolute_rank, relative_rank))
        ranked_p.extend(
            (
                (absolute_rank, absolute_raw_p, absolute_p),
                (relative_rank, relative_raw_p, relative_p),
            )
        )
        estimate = max(absolute_p, relative_p)
        expected = (
            "pass"
            if estimate <= FAMILYWISE_ALPHA
            and metric["absolute"]["holm_ci_lower"] > 0
            and metric["relative"]["holm_ci_lower"] > 0
            else "fail"
        )
        observations = metric["source_observations"]
        if (
            metric["estimate"] != estimate
            or metric["ci_lower"] != 0
            or metric["ci_upper"] != 1
            or metric["decision_stratum_id"] != "overall"
            or metric["independent_units"] != absolute_units
            or relative_units != absolute_units
            or metric["decision"] != expected
            or isinstance(observations, bool)
            or not isinstance(observations, int)
            or observations < absolute_units
        ):
            raise CompleteD1Error(f"VBench metric {metric_id} decision or sample contract mismatch")
        metrics.append(
            {
                "metric_id": metric_id,
                "estimate": estimate,
                "ci_lower": 0.0,
                "ci_upper": 1.0,
                "threshold": FAMILYWISE_ALPHA,
                "direction": "lower",
                "decision_value": "estimate",
                "decision": expected,
                "independent_units": absolute_units,
                "clips": observations,
                "strata_digest": vbench["strata_plan_digest"],
            }
        )
    if identifiers != sorted(set(identifiers)) or set(identifiers) != set(gates):
        raise CompleteD1Error("VBench report does not exactly cover the registered claim/dimension gates")
    if sorted(ranks) != list(range(1, hypothesis_count + 1)):
        raise CompleteD1Error("VBench Holm ranks must cover every hypothesis exactly once")
    ordered = sorted(ranked_p)
    raw_probabilities = [raw_p for _rank, raw_p, _adjusted_p in ordered]
    if raw_probabilities != sorted(raw_probabilities):
        raise CompleteD1Error("VBench raw p-values must be monotonic by Holm rank")
    running_adjusted = 0.0
    for rank, raw_p, adjusted_p in ordered:
        running_adjusted = max(running_adjusted, min(1.0, (hypothesis_count - rank + 1) * raw_p))
        if not math.isclose(adjusted_p, running_adjusted, rel_tol=1e-12, abs_tol=1e-12):
            raise CompleteD1Error("VBench Holm-adjusted p-values are inconsistent")
    return metrics


def build_complete_d1_report(
    raw: object,
    *,
    calibration_catalog: object,
    design: object,
) -> dict[str, Any]:
    """Revalidate and merge every fixed and claim-specific VBench D1 gate."""

    if not isinstance(raw, dict):
        raise CompleteD1Error("complete D1 bundle must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "report_id",
            "producer_id",
            "generated_at",
            "runner_digest",
            "fixed_report",
            "vbench_report",
            "vbench_runtime_report",
        },
        "complete D1 bundle",
    )
    if raw["schema_version"] != COMPLETE_D1_BUNDLE_SCHEMA:
        raise CompleteD1Error("unsupported complete D1 bundle schema")
    _identifier(raw["report_id"], "report_id")
    _identifier(raw["producer_id"], "producer_id")
    _timestamp(raw["generated_at"], "generated_at")
    _sha256(raw["runner_digest"], "runner_digest")
    fixed = raw["fixed_report"]
    vbench = raw["vbench_report"]
    try:
        vbench_runtime = validate_vbench_runtime_report(raw["vbench_runtime_report"])
    except VBenchEnvironmentError as error:
        raise CompleteD1Error(f"VBench runtime report rejected: {error}") from error
    if not isinstance(fixed, dict) or fixed.get("schema_version") != FIXED_D1_REPORT_SCHEMA:
        raise CompleteD1Error("fixed D1 report schema mismatch")
    if not isinstance(vbench, dict) or vbench.get("schema_version") != VBENCH_MEASUREMENTS_SCHEMA:
        raise CompleteD1Error("VBench report schema mismatch")
    catalog_report, design_report, fixed_gates, vbench_gates = _validate_catalog_and_design(calibration_catalog, design)
    _validate_shared_bindings(fixed, vbench)
    if fixed["calibration_catalog_digest"] != catalog_report["catalog_digest"]:
        raise CompleteD1Error("fixed report calibration catalog mismatch")
    if vbench["design_report_digest"] != document_sha256(design_report):
        raise CompleteD1Error("VBench report D0a design report mismatch")
    if (
        fixed["surface_digest"] != design_report["surface_digest"]
        or fixed["candidate_surface_binding_digest"] != design_report["candidate_surface_binding_digest"]
        or fixed["strata_plan_digest"] != design_report["strata_quotas_digest"]
    ):
        raise CompleteD1Error("D1 evidence does not bind the D0a release surface and strata contract")
    offset_contract = _validate_offset_contract(fixed, design_report)
    fingerprints = {item["evaluator_id"]: item["sha256"] for item in calibration_catalog["evaluator_fingerprints"]}
    if offset_contract["offset_evaluator_digest"] != fingerprints["offset-evaluator"]:
        raise CompleteD1Error("fixed offset contract does not match the offset evaluator fingerprint")
    if vbench["runtime_digest"] != fingerprints["vbench-runtime"] or vbench["runtime_digest"] != vbench_runtime[
        "runtime_digest"
    ]:
        raise CompleteD1Error("VBench runtime does not match the calibration fingerprint")
    fixed_metrics = _validate_fixed_metrics(fixed, fixed_gates)
    vbench_metrics = _validate_vbench_metrics(vbench, vbench_gates)
    metrics = sorted([*fixed_metrics, *vbench_metrics], key=lambda metric: metric["metric_id"])
    if [metric["metric_id"] for metric in metrics] != catalog_report["required_metric_ids"]:
        raise CompleteD1Error("complete D1 report does not exactly cover the full gate catalog")
    report = {
        "schema_version": COMPLETE_D1_REPORT_SCHEMA,
        "report_id": raw["report_id"],
        "producer_id": raw["producer_id"],
        "generated_at": raw["generated_at"],
        "runner_digest": raw["runner_digest"],
        "dataset_digest": fixed["dataset_digest"],
        "preregistration_digest": fixed["preregistration_digest"],
        "release_digest": fixed["release_digest"],
        "design_digest": fixed["design_digest"],
        "design_report_digest": document_sha256(design_report),
        "surface_digest": fixed["surface_digest"],
        "candidate_surface_binding_digest": fixed["candidate_surface_binding_digest"],
        "strata_plan_digest": fixed["strata_plan_digest"],
        "calibration_catalog_digest": catalog_report["catalog_digest"],
        "calibration_catalog": calibration_catalog,
        "fixed_report_digest": document_sha256(fixed),
        "vbench_report_digest": document_sha256(vbench),
        "vbench_runtime_report_digest": document_sha256(vbench_runtime),
        "offset_contract": offset_contract,
        "fixed_report": fixed,
        "vbench_report": vbench,
        "vbench_runtime_report": vbench_runtime,
        "vbench_gate_catalog": design["vbench_gate_catalog"],
        "verdict": "pass" if all(metric["decision"] == "pass" for metric in metrics) else "fail",
        "metrics": metrics,
    }
    return validate_complete_d1_report(
        report,
        calibration_catalog=calibration_catalog,
        design_report=design_report,
    )
