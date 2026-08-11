"""Fail-closed Q0 cross-shot protocol validation."""

from __future__ import annotations

from typing import Any

from .design import document_sha256

CROSS_SHOT_SCHEMA = "ltx-av-eval-cross-shot-protocol.v1"
CROSS_SHOT_REPORT_SCHEMA = "ltx-av-eval-cross-shot-protocol-report.v1"
DESIGN_REPORT_SCHEMA = "ltx-sota-power-report.v1"
CLAIM_IDS = (
    "reference-video-redubbing.native-distilled",
    "reference-video-redubbing.official-comfy-hq",
)
INDEPENDENT_UNIT = "identity-speaker-and-transitive-leakage-component"
ARM_SPECS = {
    "automatic-scene-reference": ("automatic", False),
    "manual-scene-reference": ("manual", True),
    "no-reference": ("none", False),
}
BINDING_IDS = {
    "calibration_catalog",
    "calibration_report",
    "dataset",
    "design_report",
    "evaluator_bundle",
    "generation_runner",
    "preregistration",
    "prompt_set",
    "rating_protocol",
    "release",
}
INVARIANTS = {
    "dialogue": "identical",
    "duration": "identical",
    "generation_seeds": "identical",
    "input_normalization": "identical",
    "only_varying_factor": "reference-strategy",
    "render_revision": "identical",
    "timeline": "identical",
}
ENDPOINT_SPECS = {
    "asr-word-error-rate": ("noninferiority", "lower"),
    "identity-similarity": ("superiority", "higher"),
    "lip-sync-mos": ("noninferiority", "higher"),
    "mouth-naturalness-mos": ("noninferiority", "higher"),
    "sharpness-relative-face": ("noninferiority", "higher"),
    "skin-stability": ("noninferiority", "higher"),
}
REQUIRED_MEASUREMENT_IDS = {
    "asr-critical-name-accuracy",
    "asr-critical-negation-accuracy",
    "asr-critical-number-accuracy",
    "asr-word-error-rate",
    "av-sync-offset-p95",
    "cross-shot-min-identity-probability",
    "face-sharpness-relative",
    "face-track-coverage",
    "lip-sync-mos",
    "mouth-artifact-rate",
    "mouth-naturalness-mos",
    "mouth-opening-rounding",
    "phoneme-viseme-pbm",
    "skin-nose-mouth-stability",
    "vbench-aesthetic-quality",
    "vbench-background-consistency",
    "vbench-dynamic-degree",
    "vbench-imaging-quality",
    "vbench-motion-smoothness",
    "vbench-subject-consistency",
}
DESIGN_REPORT_KEYS = {
    "schema_version",
    "design_digest",
    "delta_catalog_digest",
    "vbench_gate_catalog_digest",
    "status",
    "blockers",
    "familywise_alpha",
    "per_endpoint_planning_alpha",
    "target_power",
    "endpoint_requirements",
    "required_independent_units",
    "required_clips",
    "strata_quotas_digest",
}


class CrossShotProtocolError(ValueError):
    """Raised when Q0 could become unpaired or outcome-adjustable."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise CrossShotProtocolError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise CrossShotProtocolError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise CrossShotProtocolError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise CrossShotProtocolError(f"{context} must be a lowercase SHA-256")
    return value


def _validate_bindings(raw: object) -> list[str]:
    if not isinstance(raw, list):
        raise CrossShotProtocolError("bindings must be a list")
    identifiers: list[str] = []
    blockers: list[str] = []
    for index, binding in enumerate(raw):
        if not isinstance(binding, dict):
            raise CrossShotProtocolError(f"binding {index} must be an object")
        _exact_keys(binding, {"artifact_id", "sha256"}, f"binding {index}")
        artifact_id = _identifier(binding["artifact_id"], f"binding {index}.artifact_id")
        identifiers.append(artifact_id)
        if _sha256(binding["sha256"], f"binding {artifact_id}.sha256", nullable=True) is None:
            blockers.append(f"binding-missing:{artifact_id}")
    if identifiers != sorted(BINDING_IDS):
        raise CrossShotProtocolError("bindings must exactly match the sorted Q0 inventory")
    return blockers


def _validate_arms(raw: object) -> list[str]:
    if not isinstance(raw, list):
        raise CrossShotProtocolError("arms must be a list")
    identifiers: list[str] = []
    blockers: list[str] = []
    for index, arm in enumerate(raw):
        if not isinstance(arm, dict):
            raise CrossShotProtocolError(f"arm {index} must be an object")
        _exact_keys(
            arm, {"arm_id", "reference_strategy", "strategy_artifact_sha256", "default_enabled"}, f"arm {index}"
        )
        arm_id = _identifier(arm["arm_id"], f"arm {index}.arm_id")
        identifiers.append(arm_id)
        if arm_id not in ARM_SPECS:
            raise CrossShotProtocolError(f"unknown Q0 arm: {arm_id}")
        strategy, default_enabled = ARM_SPECS[arm_id]
        if (arm["reference_strategy"], arm["default_enabled"]) != (strategy, default_enabled):
            raise CrossShotProtocolError(f"Q0 arm semantics changed for {arm_id}")
        digest = _sha256(arm["strategy_artifact_sha256"], f"arm {arm_id}.strategy_artifact", nullable=True)
        if strategy == "none" and digest is not None:
            raise CrossShotProtocolError("the no-reference arm must not bind a reference strategy artifact")
        if strategy != "none" and digest is None:
            blockers.append(f"strategy-artifact-missing:{arm_id}")
    if identifiers != sorted(ARM_SPECS):
        raise CrossShotProtocolError("arms must exactly match the sorted three-arm protocol")
    return blockers


def _validate_endpoints(raw: object) -> list[str]:
    if not isinstance(raw, list):
        raise CrossShotProtocolError("endpoint_bindings must be a list")
    identifiers: list[str] = []
    blockers: list[str] = []
    for index, endpoint in enumerate(raw):
        if not isinstance(endpoint, dict):
            raise CrossShotProtocolError(f"endpoint {index} must be an object")
        _exact_keys(endpoint, {"metric_id", "test", "direction", "delta_basis_sha256"}, f"endpoint {index}")
        metric_id = _identifier(endpoint["metric_id"], f"endpoint {index}.metric_id")
        identifiers.append(metric_id)
        if metric_id not in ENDPOINT_SPECS:
            raise CrossShotProtocolError(f"unknown Q0 endpoint: {metric_id}")
        if (endpoint["test"], endpoint["direction"]) != ENDPOINT_SPECS[metric_id]:
            raise CrossShotProtocolError(f"Q0 endpoint semantics changed for {metric_id}")
        if _sha256(endpoint["delta_basis_sha256"], f"endpoint {metric_id}.delta_basis", nullable=True) is None:
            blockers.append(f"delta-basis-missing:{metric_id}")
    if identifiers != sorted(ENDPOINT_SPECS):
        raise CrossShotProtocolError("endpoints must exactly match the sorted Q0 decision family")
    return blockers


def _validate_sample_plan(raw: object) -> list[str]:
    if not isinstance(raw, dict):
        raise CrossShotProtocolError("sample_plan must be an object")
    _exact_keys(
        raw, {"independent_unit", "required_identities", "shots_per_identity", "generation_seeds"}, "sample_plan"
    )
    if raw["independent_unit"] != INDEPENDENT_UNIT:
        raise CrossShotProtocolError("Q0 must use the transitive leakage-component independent unit")
    blockers: list[str] = []
    required = raw["required_identities"]
    if required is None:
        blockers.append("required-identities-missing")
    elif not isinstance(required, int) or isinstance(required, bool) or required < 30:
        raise CrossShotProtocolError("Q0 requires at least 30 independent identities")
    if not isinstance(raw["shots_per_identity"], int) or raw["shots_per_identity"] < 2:
        raise CrossShotProtocolError("Q0 requires at least two dialogue shots per identity")
    seeds = raw["generation_seeds"]
    if not isinstance(seeds, list) or not seeds:
        blockers.append("generation-seeds-missing")
    elif any(not isinstance(seed, int) or isinstance(seed, bool) or seed < 0 for seed in seeds):
        raise CrossShotProtocolError("generation seeds must be non-negative integers")
    elif seeds != sorted(set(seeds)):
        raise CrossShotProtocolError("generation seeds must be unique and sorted")
    return blockers


def _validate_design_report(raw: object, protocol: dict[str, Any]) -> list[str]:
    if raw is None:
        return ["design-report-unverified"]
    if not isinstance(raw, dict):
        raise CrossShotProtocolError("design report must be an object")
    _exact_keys(raw, DESIGN_REPORT_KEYS, "design report")
    if raw["schema_version"] != DESIGN_REPORT_SCHEMA or raw["status"] != "ready-to-freeze" or raw["blockers"] != []:
        raise CrossShotProtocolError("Q0 requires a complete ready-to-freeze D0a power report")
    required = raw["required_independent_units"]
    if not isinstance(required, int) or isinstance(required, bool) or required < 30:
        raise CrossShotProtocolError("D0a report has an invalid independent-unit requirement")
    bindings = {binding["artifact_id"]: binding["sha256"] for binding in protocol["bindings"]}
    report_digest = document_sha256(raw)
    if bindings["design_report"] is not None and bindings["design_report"] != report_digest:
        raise CrossShotProtocolError("design report digest does not match the Q0 binding")
    configured = protocol["sample_plan"]["required_identities"]
    if configured is not None and configured != max(30, required):
        raise CrossShotProtocolError("Q0 identity count does not match the D0a power report")
    if any(
        endpoint["delta_basis_sha256"] is not None and endpoint["delta_basis_sha256"] != raw["delta_catalog_digest"]
        for endpoint in protocol["endpoint_bindings"]
    ):
        raise CrossShotProtocolError("Q0 endpoints do not bind the frozen D0a delta catalog")
    return []


def build_cross_shot_protocol_report(raw: object, *, design_report: object | None = None) -> dict[str, Any]:
    """Validate the paired Q0 protocol before any strategy result is visible."""

    if not isinstance(raw, dict):
        raise CrossShotProtocolError("cross-shot protocol must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "protocol_id",
            "claim_ids",
            "bindings",
            "sample_plan",
            "arms",
            "paired_invariants",
            "endpoint_bindings",
            "required_measurement_ids",
            "selection_policy",
        },
        "cross-shot protocol",
    )
    if raw["schema_version"] != CROSS_SHOT_SCHEMA or raw["status"] not in {"draft", "frozen"}:
        raise CrossShotProtocolError("unsupported cross-shot schema or status")
    _identifier(raw["protocol_id"], "protocol_id")
    if raw["claim_ids"] != list(CLAIM_IDS) or raw["paired_invariants"] != INVARIANTS:
        raise CrossShotProtocolError("Q0 claims or paired invariants changed")
    if raw["required_measurement_ids"] != sorted(REQUIRED_MEASUREMENT_IDS):
        raise CrossShotProtocolError("required measurements must exactly match the sorted Q0 inventory")
    expected_policy = {
        "automatic_reference_default": "off-until-manual-noninferiority",
        "failure_outcome": "abstention",
        "multiplicity": "holm",
        "primary_rule": "positive-ci-lower-superiority-and-all-ni-and-absolute-gates-pass",
    }
    if raw["selection_policy"] != expected_policy:
        raise CrossShotProtocolError("Q0 selection policy changed")
    blockers = _validate_bindings(raw["bindings"])
    blockers.extend(_validate_sample_plan(raw["sample_plan"]))
    blockers.extend(_validate_arms(raw["arms"]))
    blockers.extend(_validate_endpoints(raw["endpoint_bindings"]))
    blockers.extend(_validate_design_report(design_report, raw))
    blockers = sorted(blockers)
    if raw["status"] == "frozen" and blockers:
        raise CrossShotProtocolError(f"frozen Q0 protocol is incomplete: {blockers}")
    required = raw["sample_plan"]["required_identities"]
    shots = raw["sample_plan"]["shots_per_identity"]
    return {
        "schema_version": CROSS_SHOT_REPORT_SCHEMA,
        "protocol_digest": document_sha256(raw),
        "status": "ready-to-freeze" if not blockers else "hold",
        "blockers": blockers,
        "bindings_digest": document_sha256(raw["bindings"]),
        "arms_digest": document_sha256(raw["arms"]),
        "endpoints_digest": document_sha256(raw["endpoint_bindings"]),
        "required_measurements_digest": document_sha256(raw["required_measurement_ids"]),
        "planned_renders": required * shots * len(ARM_SPECS) * len(CLAIM_IDS) if required is not None else None,
    }
