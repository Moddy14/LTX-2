"""D1 calibration gate catalog validation."""

from __future__ import annotations

import math
from typing import Any

from .design import CURRENT_VBENCH_CLAIM_IDS, document_sha256

LEGACY_CALIBRATION_SCHEMA = "ltx-av-eval-calibration-gates.v1"
CALIBRATION_SCHEMA = "ltx-av-eval-calibration-gates.v2"
LEGACY_CALIBRATION_REPORT_SCHEMA = "ltx-av-eval-calibration-gate-report.v1"
CALIBRATION_REPORT_SCHEMA = "ltx-av-eval-calibration-gate-report.v2"
CALIBRATION_REPORT_SCHEMA_BY_CATALOG = {
    LEGACY_CALIBRATION_SCHEMA: LEGACY_CALIBRATION_REPORT_SCHEMA,
    CALIBRATION_SCHEMA: CALIBRATION_REPORT_SCHEMA,
}
FINGERPRINT_IDS = {
    "artifact-evaluator",
    "asr-model",
    "asr-normalization",
    "content-evaluator",
    "offset-evaluator",
    "sface-model",
    "sface-preprocessing",
    "sharpness-evaluator",
    "vbench-runtime",
}
LEGACY_VBENCH_CLAIMS = (
    "audio-driven-video.image-audio-to-video",
    "audio-driven-video.image-audio-to-video.refined.longcat-lipsync",
    "controlled-video.first-last-frame",
    "controlled-video.ic-lora.hdr",
    "controlled-video.ic-lora.ingredients",
    "controlled-video.ic-lora.inpainting",
    "controlled-video.ic-lora.motion-track",
    "controlled-video.ic-lora.outpainting",
    "controlled-video.ic-lora.pixel-upscaler",
    "controlled-video.ic-lora.union-control",
    "controlled-video.ic-lora.v2v-instant-shave",
    "native-generation.image-to-video",
    "reference-video-redubbing.native-distilled",
    "reference-video-redubbing.official-comfy-hq",
    "video-edit.retake",
)
VBENCH_CLAIMS = CURRENT_VBENCH_CLAIM_IDS
VBENCH_DIMENSIONS = (
    "aesthetic-quality",
    "background-consistency",
    "dynamic-degree",
    "imaging-quality",
    "motion-smoothness",
    "subject-consistency",
)
LEGACY_EXPECTED_VBENCH_METRIC_IDS = {
    f"vbench.{claim}.{dimension}" for claim in LEGACY_VBENCH_CLAIMS for dimension in VBENCH_DIMENSIONS
}
EXPECTED_VBENCH_METRIC_IDS = {
    f"vbench.{claim}.{dimension}" for claim in VBENCH_CLAIMS for dimension in VBENCH_DIMENSIONS
}
EXPECTED_VBENCH_METRIC_IDS_BY_SCHEMA = {
    LEGACY_CALIBRATION_SCHEMA: LEGACY_EXPECTED_VBENCH_METRIC_IDS,
    CALIBRATION_SCHEMA: EXPECTED_VBENCH_METRIC_IDS,
}
GATE_SPECS: dict[str, tuple[str, str, float | None, str]] = {
    "artifact-event-far-ci-upper": ("lower", "ci-upper", 0.01, "overall"),
    "artifact-event-far-ci-upper-worst-stratum": ("lower", "ci-upper", 0.01, "worst-registered-stratum"),
    "artifact-event-frr-ci-upper": ("lower", "ci-upper", 0.05, "overall"),
    "artifact-event-frr-ci-upper-worst-stratum": ("lower", "ci-upper", 0.05, "worst-registered-stratum"),
    "artifact-frames-within-warp-limit-ci-lower": ("higher", "ci-lower", 0.99, "overall"),
    "artifact-warp-residual-p95": ("lower", "estimate", 0.04, "overall"),
    "artifact-warp-residual-p95-worst-stratum": ("lower", "estimate", 0.06, "worst-registered-stratum"),
    "asr-critical-name-accuracy-ci-lower": ("higher", "ci-lower", 0.99, "worst-registered-stratum"),
    "asr-critical-negation-accuracy-ci-lower": ("higher", "ci-lower", 0.99, "worst-registered-stratum"),
    "asr-critical-number-accuracy-ci-lower": ("higher", "ci-lower", 0.99, "worst-registered-stratum"),
    "asr-wer-ci-upper": ("lower", "ci-upper", 0.06, "overall"),
    "asr-wer-ci-upper-worst-stratum": ("lower", "ci-upper", 0.12, "worst-registered-stratum"),
    "asr-wer-estimate": ("lower", "estimate", 0.05, "overall"),
    "asr-wer-estimate-worst-stratum": ("lower", "estimate", 0.10, "worst-registered-stratum"),
    "av-brier-score": ("lower", "estimate", 0.10, "overall"),
    "av-brier-score-worst-stratum": ("lower", "estimate", None, "worst-registered-stratum"),
    "av-calibration-ece": ("lower", "estimate", 0.05, "overall"),
    "av-calibration-ece-worst-stratum": ("lower", "estimate", None, "worst-registered-stratum"),
    "av-correspondence-far-ci-upper": ("lower", "ci-upper", 0.01, "overall"),
    "av-correspondence-far-ci-upper-worst-stratum": (
        "lower",
        "ci-upper",
        0.03,
        "worst-registered-stratum",
    ),
    "av-correspondence-frr-ci-upper": ("lower", "ci-upper", 0.05, "overall"),
    "av-correspondence-frr-ci-upper-worst-stratum": (
        "lower",
        "ci-upper",
        0.10,
        "worst-registered-stratum",
    ),
    "av-evaluator-bootstrap95-upper-ms": ("lower", "ci-upper", 40.0, "overall"),
    "av-evaluator-median-absolute-error-ms": ("lower", "estimate", 20.0, "overall"),
    "av-evaluator-p95-absolute-error-ms": ("lower", "estimate", 40.0, "overall"),
    "av-evaluator-within-one-frame-ci-lower": ("higher", "ci-lower", 0.95, "overall"),
    "av-evaluator-within-one-frame-ci-lower-worst-stratum": (
        "higher",
        "ci-lower",
        0.90,
        "worst-registered-stratum",
    ),
    "av-in-domain-false-abstention-ci-upper": ("lower", "ci-upper", 0.05, "overall"),
    "av-ood-abstention-recall-ci-lower": ("higher", "ci-lower", 0.95, "overall"),
    "av-output-offset-p95-ms": ("lower", "estimate", 80.0, "overall"),
    "content-frame-macro-f1-ci-lower": ("higher", "ci-lower", 0.82, "overall"),
    "content-frame-macro-f1-ci-lower-worst-stratum": (
        "higher",
        "ci-lower",
        0.72,
        "worst-registered-stratum",
    ),
    "content-frame-macro-f1-estimate": ("higher", "estimate", 0.85, "overall"),
    "content-frame-macro-f1-estimate-worst-stratum": (
        "higher",
        "estimate",
        0.75,
        "worst-registered-stratum",
    ),
    "content-transition-f1-ci-lower": ("higher", "ci-lower", 0.87, "overall"),
    "content-transition-f1-ci-lower-worst-stratum": (
        "higher",
        "ci-lower",
        0.77,
        "worst-registered-stratum",
    ),
    "content-transition-f1-estimate": ("higher", "estimate", 0.90, "overall"),
    "content-transition-f1-estimate-worst-stratum": (
        "higher",
        "estimate",
        0.80,
        "worst-registered-stratum",
    ),
    "identity-far-ci-upper": ("lower", "ci-upper", 0.01, "overall"),
    "identity-far-ci-upper-worst-stratum": ("lower", "ci-upper", 0.03, "worst-registered-stratum"),
    "identity-frr-ci-upper": ("lower", "ci-upper", 0.05, "overall"),
    "identity-frr-ci-upper-worst-stratum": ("lower", "ci-upper", 0.10, "worst-registered-stratum"),
    "identity-tar-ci-lower": ("higher", "ci-lower", 0.95, "overall"),
    "sharpness-relative-face-ci-lower": ("higher", "ci-lower", None, "worst-registered-stratum"),
}
V2_ONLY_GATE_IDS = frozenset(
    {
        "av-brier-score-worst-stratum",
        "av-calibration-ece-worst-stratum",
        "av-correspondence-far-ci-upper",
        "av-correspondence-far-ci-upper-worst-stratum",
        "av-correspondence-frr-ci-upper",
        "av-correspondence-frr-ci-upper-worst-stratum",
        "av-evaluator-within-one-frame-ci-lower-worst-stratum",
    }
)
LEGACY_GATE_SPECS = {
    metric_id: spec for metric_id, spec in GATE_SPECS.items() if metric_id not in V2_ONLY_GATE_IDS
}
GATE_SPECS_BY_SCHEMA = {
    LEGACY_CALIBRATION_SCHEMA: LEGACY_GATE_SPECS,
    CALIBRATION_SCHEMA: GATE_SPECS,
}


class CalibrationError(ValueError):
    """Raised when a D1 gate catalog is incomplete or outcome-adjustable."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise CalibrationError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise CalibrationError(f"{context} must contain 3 to 128 characters")
    if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in value):
        raise CalibrationError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise CalibrationError(f"{context} must be a lowercase SHA-256")
    return value


def _threshold(value: object, context: str, *, nullable: bool) -> float | None:
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise CalibrationError(f"{context} must be a finite number")
    return float(value)


def _validate_fingerprints(raw: object) -> list[str]:
    if not isinstance(raw, list):
        raise CalibrationError("evaluator_fingerprints must be a list")
    identifiers: list[str] = []
    blockers: list[str] = []
    for index, fingerprint in enumerate(raw):
        if not isinstance(fingerprint, dict):
            raise CalibrationError(f"fingerprint {index} must be an object")
        _exact_keys(fingerprint, {"evaluator_id", "sha256"}, f"fingerprint {index}")
        evaluator_id = _identifier(fingerprint["evaluator_id"], f"fingerprint {index}.evaluator_id")
        identifiers.append(evaluator_id)
        if _sha256(fingerprint["sha256"], f"fingerprint {evaluator_id}.sha256", nullable=True) is None:
            blockers.append(f"fingerprint-missing:{evaluator_id}")
    if identifiers != sorted(set(identifiers)) or set(identifiers) != FINGERPRINT_IDS:
        raise CalibrationError("evaluator fingerprints must exactly match the sorted D1 catalog")
    return blockers


def _validate_gates(raw: object, *, catalog_schema: str) -> tuple[list[str], list[str]]:
    if not isinstance(raw, list):
        raise CalibrationError("gates must be a list")
    gate_specs = GATE_SPECS_BY_SCHEMA[catalog_schema]
    identifiers: list[str] = []
    blockers: list[str] = []
    for index, gate in enumerate(raw):
        if not isinstance(gate, dict):
            raise CalibrationError(f"gate {index} must be an object")
        _exact_keys(
            gate,
            {"metric_id", "direction", "decision_value", "threshold", "scope", "basis_evidence_sha256"},
            f"gate {index}",
        )
        metric_id = _identifier(gate["metric_id"], f"gate {index}.metric_id")
        identifiers.append(metric_id)
        if metric_id not in gate_specs:
            raise CalibrationError(f"unknown D1 metric: {metric_id}")
        direction, decision_value, fixed_threshold, scope = gate_specs[metric_id]
        if (gate["direction"], gate["decision_value"], gate["scope"]) != (direction, decision_value, scope):
            raise CalibrationError(f"gate semantics changed for {metric_id}")
        threshold = _threshold(gate["threshold"], f"gate {metric_id}.threshold", nullable=True)
        if fixed_threshold is not None and threshold != fixed_threshold:
            raise CalibrationError(f"plan-fixed threshold changed for {metric_id}")
        if threshold is None:
            blockers.append(f"threshold-missing:{metric_id}")
        if _sha256(gate["basis_evidence_sha256"], f"gate {metric_id}.basis", nullable=True) is None:
            blockers.append(f"basis-evidence-missing:{metric_id}")
    if identifiers != sorted(set(identifiers)) or set(identifiers) != set(gate_specs):
        raise CalibrationError("gates must exactly match the sorted D1 metric catalog")
    return identifiers, blockers


def _validate_vbench_metric_ids(raw: object, *, catalog_schema: str) -> list[str]:
    if not isinstance(raw, list) or not raw:
        raise CalibrationError("vbench_metric_ids must be a non-empty list")
    identifiers = [_identifier(value, f"vbench_metric_ids[{index}]") for index, value in enumerate(raw)]
    if identifiers != sorted(EXPECTED_VBENCH_METRIC_IDS_BY_SCHEMA[catalog_schema]):
        raise CalibrationError("VBench metric IDs must exactly match the sorted D0a claim/dimension matrix")
    return identifiers


def _validate_vbench_decision(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise CalibrationError("vbench_decision must be an object")
    _exact_keys(
        raw,
        {"direction", "decision_value", "threshold", "multiplicity", "subtests"},
        "vbench_decision",
    )
    if raw != {
        "direction": "lower",
        "decision_value": "estimate",
        "threshold": 0.05,
        "multiplicity": "holm",
        "subtests": ["absolute", "relative"],
    }:
        raise CalibrationError("VBench decisions must use the fixed absolute-and-relative Holm contract")
    return raw


def build_calibration_gate_report(raw: object) -> dict[str, Any]:
    """Validate D1 gates and return the exact required measurement metric IDs."""

    if not isinstance(raw, dict):
        raise CalibrationError("calibration catalog must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "catalog_id",
            "design_digest",
            "preregistration_digest",
            "vbench_gate_catalog_digest",
            "vbench_decision",
            "vbench_metric_ids",
            "evaluator_fingerprints",
            "gates",
        },
        "calibration catalog",
    )
    catalog_schema = raw["schema_version"]
    if catalog_schema not in CALIBRATION_REPORT_SCHEMA_BY_CATALOG or raw["status"] not in {"draft", "frozen"}:
        raise CalibrationError("unsupported calibration schema or status")
    _identifier(raw["catalog_id"], "catalog_id")
    blockers = _validate_fingerprints(raw["evaluator_fingerprints"])
    for field in ("design_digest", "preregistration_digest", "vbench_gate_catalog_digest"):
        if _sha256(raw[field], field, nullable=True) is None:
            blockers.append(f"{field.replace('_', '-')}-missing")
    metric_ids, gate_blockers = _validate_gates(raw["gates"], catalog_schema=catalog_schema)
    vbench_metric_ids = _validate_vbench_metric_ids(raw["vbench_metric_ids"], catalog_schema=catalog_schema)
    vbench_decision = _validate_vbench_decision(raw["vbench_decision"])
    blockers.extend(gate_blockers)
    blockers = sorted(blockers)
    if raw["status"] == "frozen" and blockers:
        raise CalibrationError(f"frozen calibration catalog is incomplete: {blockers}")
    return {
        "schema_version": CALIBRATION_REPORT_SCHEMA_BY_CATALOG[catalog_schema],
        "catalog_digest": document_sha256(raw),
        "status": "ready-to-freeze" if not blockers else "hold",
        "blockers": blockers,
        "required_metric_ids": sorted([*metric_ids, *vbench_metric_ids]),
        "required_metric_ids_digest": document_sha256(sorted([*metric_ids, *vbench_metric_ids])),
        "vbench_decision_digest": document_sha256(vbench_decision),
        "evaluator_fingerprints_digest": document_sha256(raw["evaluator_fingerprints"]),
    }
