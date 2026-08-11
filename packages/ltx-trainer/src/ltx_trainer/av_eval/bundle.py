"""Fail-closed assembly of the 37 fixed D1 measurements."""

from __future__ import annotations

import math
from typing import Any

from .artifact import ARTIFACT_MEASUREMENTS_SCHEMA
from .asr import ASR_MEASUREMENTS_SCHEMA
from .calibration import GATE_SPECS, CalibrationError, build_calibration_gate_report
from .content import CONTENT_MEASUREMENTS_SCHEMA
from .design import document_sha256
from .identity import IDENTITY_MEASUREMENTS_SCHEMA
from .offset import OFFSET_MEASUREMENTS_SCHEMA
from .sharpness import SHARPNESS_MEASUREMENTS_SCHEMA

FIXED_D1_BUNDLE_SCHEMA = "ltx-av-eval-fixed-d1-bundle.v1"
FIXED_D1_REPORT_SCHEMA = "ltx-av-eval-fixed-d1-report.v1"
SOURCE_SCHEMAS = {
    "artifact": ARTIFACT_MEASUREMENTS_SCHEMA,
    "asr": ASR_MEASUREMENTS_SCHEMA,
    "content": CONTENT_MEASUREMENTS_SCHEMA,
    "identity": IDENTITY_MEASUREMENTS_SCHEMA,
    "offset": OFFSET_MEASUREMENTS_SCHEMA,
    "sharpness": SHARPNESS_MEASUREMENTS_SCHEMA,
}
SOURCE_METRIC_IDS = {
    source: {metric_id for metric_id in GATE_SPECS if metric_id.startswith(prefix)}
    for source, prefix in {
        "artifact": "artifact-",
        "asr": "asr-",
        "content": "content-",
        "identity": "identity-",
        "offset": "av-",
        "sharpness": "sharpness-",
    }.items()
}
SOURCE_COUNTS = {
    "artifact": ("frames",),
    "asr": ("clips",),
    "content": ("frames", "transitions"),
    "identity": ("pairs",),
    "offset": ("calibration_cases", "output_cases"),
    "sharpness": ("observations",),
}
COMMON_REPORT_KEYS = {
    "schema_version",
    "input_digest",
    "dataset_digest",
    "preregistration_digest",
    "release_digest",
    "strata_plan_digest",
    "bootstrap",
    "metrics",
}
SOURCE_REPORT_KEYS = {
    "artifact": COMMON_REPORT_KEYS | {"evaluator_digest", "frame_warp_limit", "frames", "independent_units"},
    "asr": COMMON_REPORT_KEYS | {"asr_model_digest", "normalization_digest", "independent_units", "clips", "strata"},
    "content": COMMON_REPORT_KEYS
    | {"content_evaluator_digest", "annotation_policy_digest", "frame_labels", "frames", "transitions"},
    "identity": COMMON_REPORT_KEYS
    | {
        "sface_model_digest",
        "preprocessing_digest",
        "reference_gallery_digest",
        "threshold_policy_digest",
        "similarity_threshold",
        "pairs",
        "independent_probe_leakage_components",
    },
    "offset": COMMON_REPORT_KEYS
    | {
        "offset_evaluator_digest",
        "calibration_policy_digest",
        "abstention_policy_digest",
        "ece_bins",
        "calibration_cases",
        "output_cases",
    },
    "sharpness": COMMON_REPORT_KEYS
    | {
        "sharpness_evaluator_digest",
        "face_alignment_policy_digest",
        "statistic",
        "canonical_crop",
        "observations",
    },
}
FINGERPRINT_BINDINGS = {
    "artifact-evaluator": ("artifact", "evaluator_digest"),
    "asr-model": ("asr", "asr_model_digest"),
    "asr-normalization": ("asr", "normalization_digest"),
    "content-evaluator": ("content", "content_evaluator_digest"),
    "offset-evaluator": ("offset", "offset_evaluator_digest"),
    "sface-model": ("identity", "sface_model_digest"),
    "sface-preprocessing": ("identity", "preprocessing_digest"),
    "sharpness-evaluator": ("sharpness", "sharpness_evaluator_digest"),
}


class D1BundleError(ValueError):
    """Raised when D1 reports are incomplete, mixed, or outcome-adjustable."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise D1BundleError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise D1BundleError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise D1BundleError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise D1BundleError(f"{context} must be a lowercase SHA-256")
    return value


def _number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise D1BundleError(f"{context} must be a finite number")
    return float(value)


def _catalog_fingerprints(catalog: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in catalog["evaluator_fingerprints"]:
        evaluator_id = item["evaluator_id"]
        digest = item["sha256"]
        if evaluator_id != "vbench-runtime":
            result[evaluator_id] = _sha256(digest, f"fingerprint {evaluator_id}")
    if set(result) != set(FINGERPRINT_BINDINGS):
        raise D1BundleError("fixed D1 fingerprint inventory is incomplete")
    return result


def _source_observations(report: dict[str, Any], source: str) -> int:
    counts = [report.get(field) for field in SOURCE_COUNTS[source]]
    if any(isinstance(value, bool) or not isinstance(value, int) or value < 1 for value in counts):
        raise D1BundleError(f"{source} report has invalid observation counts")
    return sum(counts)


def _validate_metric(metric: object, *, source: str, observations: int) -> dict[str, Any]:
    if not isinstance(metric, dict):
        raise D1BundleError(f"{source} metric must be an object")
    _exact_keys(
        metric,
        {"metric_id", "estimate", "ci_lower", "ci_upper", "decision_stratum_id", "independent_units"},
        f"{source} metric",
    )
    metric_id = _identifier(metric["metric_id"], f"{source} metric_id")
    estimate = _number(metric["estimate"], f"metric {metric_id}.estimate")
    lower = _number(metric["ci_lower"], f"metric {metric_id}.ci_lower")
    upper = _number(metric["ci_upper"], f"metric {metric_id}.ci_upper")
    if not lower <= estimate <= upper:
        raise D1BundleError(f"metric {metric_id} has inconsistent confidence bounds")
    units = metric["independent_units"]
    if isinstance(units, bool) or not isinstance(units, int) or not 2 <= units <= observations:
        raise D1BundleError(f"metric {metric_id} has invalid independent-unit count")
    _identifier(metric["decision_stratum_id"], f"metric {metric_id}.decision_stratum_id")
    return dict(metric)


def _validate_source_report(
    report: object,
    *,
    source: str,
    bindings: dict[str, str],
) -> tuple[list[dict[str, Any]], int]:
    if not isinstance(report, dict) or report.get("schema_version") != SOURCE_SCHEMAS[source]:
        raise D1BundleError(f"{source} report schema mismatch")
    _exact_keys(report, SOURCE_REPORT_KEYS[source], f"{source} report")
    for field in ("input_digest", "dataset_digest", "preregistration_digest", "release_digest", "strata_plan_digest"):
        _sha256(report.get(field), f"{source}.{field}")
    for field in ("dataset_digest", "preregistration_digest", "release_digest", "strata_plan_digest"):
        if report[field] != bindings[field]:
            raise D1BundleError(f"{source} report {field} mismatch")
    if report["bootstrap"] != bindings["bootstrap"]:
        raise D1BundleError(f"{source} report bootstrap mismatch")
    observations = _source_observations(report, source)
    raw_metrics = report.get("metrics")
    if not isinstance(raw_metrics, list) or not raw_metrics:
        raise D1BundleError(f"{source} report must contain metrics")
    metrics = [_validate_metric(metric, source=source, observations=observations) for metric in raw_metrics]
    identifiers = [metric["metric_id"] for metric in metrics]
    if identifiers != sorted(set(identifiers)) or set(identifiers) != SOURCE_METRIC_IDS[source]:
        raise D1BundleError(f"{source} metrics do not exactly cover the fixed catalog")
    return metrics, observations


def _decision(metric: dict[str, Any], gate: dict[str, Any]) -> tuple[str, float]:
    values = {
        "estimate": metric["estimate"],
        "ci-lower": metric["ci_lower"],
        "ci-upper": metric["ci_upper"],
    }
    value = values[gate["decision_value"]]
    decision = (
        "pass"
        if (value >= gate["threshold"] if gate["direction"] == "higher" else value <= gate["threshold"])
        else "fail"
    )
    return decision, value


def _validate_bundle(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise D1BundleError("fixed D1 bundle must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "bundle_id",
            "dataset_digest",
            "preregistration_digest",
            "release_digest",
            "design_digest",
            "strata_plan_digest",
            "bootstrap",
            "reports",
        },
        "fixed D1 bundle",
    )
    if raw["schema_version"] != FIXED_D1_BUNDLE_SCHEMA:
        raise D1BundleError("unsupported fixed D1 bundle schema")
    _identifier(raw["bundle_id"], "bundle_id")
    for field in ("dataset_digest", "preregistration_digest", "release_digest", "design_digest", "strata_plan_digest"):
        _sha256(raw[field], field)
    bootstrap = raw["bootstrap"]
    if not isinstance(bootstrap, dict) or bootstrap != {
        "replicates": 10_000,
        "confidence_level": 0.95,
        "seed": bootstrap.get("seed") if isinstance(bootstrap, dict) else None,
    }:
        raise D1BundleError("bootstrap must use exactly 10000 replicates, 95% confidence, and a seed")
    seed = bootstrap["seed"]
    if isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**63:
        raise D1BundleError("bootstrap seed must be a 63-bit integer")
    return raw


def _validate_catalog(catalog: object, bundle: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    if not isinstance(catalog, dict):
        raise D1BundleError("calibration catalog must be an object")
    try:
        report = build_calibration_gate_report(catalog)
    except CalibrationError as error:
        raise D1BundleError(f"calibration catalog rejected: {error}") from error
    if report["status"] != "ready-to-freeze":
        raise D1BundleError("calibration catalog is not ready-to-freeze")
    if catalog["design_digest"] != bundle["design_digest"]:
        raise D1BundleError("calibration catalog design_digest mismatch")
    if catalog["preregistration_digest"] != bundle["preregistration_digest"]:
        raise D1BundleError("calibration catalog preregistration_digest mismatch")
    return catalog, report


def _assemble_metrics(
    source_metrics: dict[str, list[dict[str, Any]]],
    source_counts: dict[str, int],
    catalog: dict[str, Any],
) -> list[dict[str, Any]]:
    gates = {gate["metric_id"]: gate for gate in catalog["gates"]}
    assembled: list[dict[str, Any]] = []
    for source in sorted(source_metrics):
        for metric in source_metrics[source]:
            gate = gates[metric["metric_id"]]
            decision, decision_value = _decision(metric, gate)
            assembled.append(
                {
                    **metric,
                    "source": source,
                    "source_observations": source_counts[source],
                    "direction": gate["direction"],
                    "decision_value": gate["decision_value"],
                    "threshold": gate["threshold"],
                    "basis_evidence_sha256": gate["basis_evidence_sha256"],
                    "evaluated_value": decision_value,
                    "decision": decision,
                }
            )
    assembled.sort(key=lambda metric: metric["metric_id"])
    if {metric["metric_id"] for metric in assembled} != set(GATE_SPECS):
        raise D1BundleError("assembled metrics do not exactly cover all 37 fixed D1 gates")
    return assembled


def build_fixed_d1_report(raw: object, *, calibration_catalog: object) -> dict[str, Any]:
    """Assemble and decide exactly the 37 non-VBench D1 gates."""

    bundle = _validate_bundle(raw)
    catalog, catalog_report = _validate_catalog(calibration_catalog, bundle)
    reports = bundle["reports"]
    if not isinstance(reports, dict):
        raise D1BundleError("reports must be an object")
    _exact_keys(reports, set(SOURCE_SCHEMAS), "reports")
    if any(not isinstance(report, dict) for report in reports.values()):
        raise D1BundleError("every source report must be an object")
    fingerprints = _catalog_fingerprints(catalog)
    for evaluator_id, (source, field) in FINGERPRINT_BINDINGS.items():
        if reports[source].get(field) != fingerprints[evaluator_id]:
            raise D1BundleError(f"{source} report does not match fingerprint {evaluator_id}")
    bindings = {
        field: bundle[field]
        for field in ("dataset_digest", "preregistration_digest", "release_digest", "strata_plan_digest", "bootstrap")
    }
    source_metrics: dict[str, list[dict[str, Any]]] = {}
    source_counts: dict[str, int] = {}
    for source in sorted(SOURCE_SCHEMAS):
        source_metrics[source], source_counts[source] = _validate_source_report(
            reports[source],
            source=source,
            bindings=bindings,
        )
    assembled = _assemble_metrics(source_metrics, source_counts, catalog)
    return {
        "schema_version": FIXED_D1_REPORT_SCHEMA,
        "bundle_digest": document_sha256(bundle),
        "calibration_catalog_digest": catalog_report["catalog_digest"],
        "dataset_digest": bundle["dataset_digest"],
        "preregistration_digest": bundle["preregistration_digest"],
        "release_digest": bundle["release_digest"],
        "design_digest": bundle["design_digest"],
        "strata_plan_digest": bundle["strata_plan_digest"],
        "source_report_digests": {source: document_sha256(reports[source]) for source in sorted(reports)},
        "verdict": "pass" if all(metric["decision"] == "pass" for metric in assembled) else "fail",
        "metrics": assembled,
    }
