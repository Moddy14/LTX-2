"""Fail-closed Q2 holdout qualification assembly."""

from __future__ import annotations

import math
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

from .authorization import (
    AuthorizationError,
    studio_sha256_document,
    validate_consumption_events,
    validate_evaluation_authorization,
    verify_detached_signature,
)
from .calibration import CalibrationError, build_calibration_gate_report
from .comparator_result import ComparatorResultError, build_holdout_comparator_decision
from .complete import COMPLETE_D1_REPORT_SCHEMA
from .design import REPORT_SCHEMA as DESIGN_REPORT_SCHEMA
from .design import document_sha256
from .freeze_preflight import FreezePreflightError, validate_f0_candidate
from .governance import GovernanceError, validate_preregistration
from .product import ProductGovernanceError, validate_measurement_report

Q2_RESULTS_SCHEMA = "ltx-av-eval-q2-results.v1"
Q2_REPORT_SCHEMA = "ltx-studio-qualification-report.v1"
MOS_METRIC_IDS = (
    "audio-quality-absolute",
    "identity-mouth-absolute",
    "identity-mouth-margin",
    "lip-sync-absolute",
    "lip-sync-margin",
)
Q2_RELEASE_GATES = (
    "asr-critical-token",
    "audio-quality",
    "av-sync",
    "identity",
    "mos",
    "mouth-artifact",
    "phoneme-viseme",
    "sharpness",
    "vbench-i2v",
)
OBJECTIVE_GATE_PREFIXES = {
    "asr-critical-token": ("asr-",),
    "av-sync": ("av-",),
    "identity": ("identity-",),
    "mouth-artifact": ("artifact-",),
    "phoneme-viseme": ("content-",),
    "sharpness": ("sharpness-",),
}


class HoldoutDecisionError(ValueError):
    """Raised when Q2 evidence cannot produce an unqualified pass report."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise HoldoutDecisionError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise HoldoutDecisionError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise HoldoutDecisionError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise HoldoutDecisionError(f"{context} must be a lowercase SHA-256")
    return value


def _timestamp(value: object, context: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise HoldoutDecisionError(f"{context} must be a whole-second UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise HoldoutDecisionError(f"{context} is invalid") from error
    if parsed.tzinfo != UTC or parsed.microsecond:
        raise HoldoutDecisionError(f"{context} must be a whole-second UTC timestamp")
    return parsed


def _number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise HoldoutDecisionError(f"{context} must be finite")
    return float(value)


def _signature_key_id(signature: object, context: str) -> str:
    if not isinstance(signature, dict) or signature.get("schemaVersion") != "ltx-studio-detached-signature.v1":
        raise HoldoutDecisionError(f"{context} must use the canonical Studio signature schema")
    return _identifier(signature.get("keyId"), f"{context}.keyId")


def _candidate_entries(surface: object, *, surface_digest: str) -> tuple[dict[str, str], dict[str, list[str]]]:
    if not isinstance(surface, dict) or surface.get("schemaVersion") != "candidate-release-surface.v1":
        raise HoldoutDecisionError("Q2 surface schema is unsupported")
    if studio_sha256_document(surface) != surface_digest:
        raise HoldoutDecisionError("Q2 surface digest mismatch")
    entries = surface.get("entries")
    if not isinstance(entries, list):
        raise HoldoutDecisionError("Q2 surface entries must be a list")
    claims: dict[str, str] = {}
    gates: dict[str, list[str]] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or entry.get("targetStatus") not in {"candidate", "blocked"}:
            raise HoldoutDecisionError(f"surface entry {index} is invalid")
        if entry["targetStatus"] == "blocked":
            continue
        entry_id = _identifier(entry.get("id"), f"surface entry {index}.id")
        claim_id = _identifier(entry.get("claimId"), f"surface entry {entry_id}.claimId")
        applicable = entry.get("applicableGates")
        if not isinstance(applicable, list) or len(applicable) != len(set(applicable)):
            raise HoldoutDecisionError(f"surface entry {entry_id} has invalid applicable gates")
        q2_gates = sorted(set(applicable).intersection(Q2_RELEASE_GATES))
        if not q2_gates:
            raise HoldoutDecisionError(f"surface entry {entry_id} has no applicable Q2 quality gate")
        if entry_id in claims:
            raise HoldoutDecisionError("Q2 surface contains duplicate candidate entry IDs")
        claims[entry_id] = claim_id
        gates[entry_id] = q2_gates
    if not claims:
        raise HoldoutDecisionError("Q2 surface has no candidate entries")
    return claims, gates


def _required_measurement_gates(
    catalog: dict[str, Any],
    claim_id: str,
    applicable_gates: set[str],
) -> dict[str, tuple[str, str, float]]:
    required: dict[str, tuple[str, str, float]] = {}
    for gate in catalog["gates"]:
        if not any(
            gate["metric_id"].startswith(prefix)
            for release_gate in applicable_gates
            for prefix in OBJECTIVE_GATE_PREFIXES.get(release_gate, ())
        ):
            continue
        threshold = gate["threshold"]
        if threshold is None:
            raise HoldoutDecisionError(f"Q2 threshold is not frozen: {gate['metric_id']}")
        required[gate["metric_id"]] = (gate["direction"], gate["decision_value"], float(threshold))
    if "vbench-i2v" in applicable_gates:
        prefix = f"vbench.{claim_id}."
        for metric_id in catalog["vbench_metric_ids"]:
            if metric_id.startswith(prefix):
                required[metric_id] = ("lower", "estimate", 0.05)
        if not any(metric_id.startswith(prefix) for metric_id in required):
            raise HoldoutDecisionError(f"Q2 has no frozen VBench gates for claim {claim_id}")
    return required


def _validate_objective_reports(
    raw: object,
    *,
    entry_claims: dict[str, str],
    entry_gates: dict[str, list[str]],
    candidate: dict[str, Any],
    calibration_catalog: dict[str, Any],
    calibration_report: dict[str, Any],
    design_digest: str,
    required_units: int,
) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, list):
        raise HoldoutDecisionError("Q2 objective_reports must be a list")
    expected_entries = {
        entry_id
        for entry_id, applicable in entry_gates.items()
        if (set(applicable) - {"audio-quality", "mos"})
    }
    reports: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise HoldoutDecisionError(f"Q2 objective report {index} must be an object")
        _exact_keys(item, {"surface_entry_id", "report"}, f"Q2 objective report {index}")
        entry_id = _identifier(item["surface_entry_id"], f"Q2 objective report {index}.surface_entry_id")
        if entry_id not in expected_entries or entry_id in reports:
            raise HoldoutDecisionError(f"Q2 objective report entry is unknown or duplicated: {entry_id}")
        claim_id = entry_claims[entry_id]
        try:
            report = validate_measurement_report(
                item["report"],
                expected_kind="holdout",
                dataset_digest=candidate["holdout_digest"],
                preregistration_digest=candidate["preregistration_digest"],
                release_digest=candidate["release_digest"],
                design_digest=design_digest,
                runner_digest=candidate["q2_runner_digest"],
                evaluator_digest=calibration_report["evaluator_fingerprints_digest"],
                thresholds_digest=calibration_report["catalog_digest"],
                required_gates=_required_measurement_gates(
                    calibration_catalog,
                    claim_id,
                    set(entry_gates[entry_id]),
                ),
            )
        except ProductGovernanceError as error:
            raise HoldoutDecisionError(f"Q2 objective report rejected for {entry_id}: {error}") from error
        if report["verdict"] != "pass":
            raise HoldoutDecisionError(f"Q2 objective gates failed for {entry_id}")
        if any(metric["independent_units"] < required_units for metric in report["metrics"]):
            raise HoldoutDecisionError(f"Q2 objective evidence is underpowered for {entry_id}")
        reports[entry_id] = report
    if set(reports) != expected_entries:
        raise HoldoutDecisionError("Q2 objective reports do not exactly cover candidate surface entries")
    return reports


def _mos_thresholds(preregistration: dict[str, Any]) -> dict[str, float]:
    gates = preregistration["holdout_commitments"]["human_mos_gates"]
    return {
        "audio-quality-absolute": gates["audio_quality_min"],
        "identity-mouth-absolute": gates["identity_and_mouth_naturalness_min"],
        "identity-mouth-margin": gates["candidate_identity_and_mouth_margin_min"],
        "lip-sync-absolute": gates["lip_sync_min"],
        "lip-sync-margin": gates["candidate_lip_sync_margin_min"],
    }


def _validate_mos_reports(  # noqa: PLR0912, PLR0915
    raw: object,
    *,
    entry_claims: dict[str, str],
    entry_gates: dict[str, list[str]],
    preregistration: dict[str, Any],
    required_units: int,
) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, list):
        raise HoldoutDecisionError("Q2 mos_reports must be a list")
    thresholds = _mos_thresholds(preregistration)
    expected_entries = {
        entry_id
        for entry_id, applicable in entry_gates.items()
        if {"audio-quality", "mos"}.intersection(applicable)
    }
    reports: dict[str, dict[str, Any]] = {}
    all_ranks: list[int] = []
    hypothesis_count = 0
    for index, report in enumerate(raw):
        if not isinstance(report, dict):
            raise HoldoutDecisionError(f"MOS report {index} must be an object")
        _exact_keys(
            report,
            {
                "claim_id",
                "surface_entry_id",
                "rating_protocol_digest",
                "blinded",
                "randomized_arm_order",
                "normalization",
                "independent_units",
                "ratings",
                "metrics",
            },
            f"MOS report {index}",
        )
        claim_id = _identifier(report["claim_id"], f"MOS report {index}.claim_id")
        entry_id = _identifier(report["surface_entry_id"], f"MOS report {index}.surface_entry_id")
        if entry_id not in expected_entries or entry_id in reports or entry_claims[entry_id] != claim_id:
            raise HoldoutDecisionError(f"MOS report entry is unknown, duplicated, or claim-mismatched: {entry_id}")
        expected_metric_ids = (
            list(MOS_METRIC_IDS)
            if (set(entry_gates[entry_id]) - {"audio-quality", "mos"})
            else ["audio-quality-absolute"]
        )
        hypothesis_count += len(expected_metric_ids)
        _sha256(report["rating_protocol_digest"], f"MOS report {claim_id}.rating_protocol_digest")
        if report["rating_protocol_digest"] != preregistration["holdout_commitments"]["rating_protocol_sha256"]:
            raise HoldoutDecisionError(f"MOS report {claim_id} does not bind the frozen rating protocol")
        if report["blinded"] is not True or report["randomized_arm_order"] is not True:
            raise HoldoutDecisionError(f"MOS report {claim_id} is not blinded and randomized")
        if report["normalization"] != "identical-loudness-and-timeline.v1":
            raise HoldoutDecisionError(f"MOS report {claim_id} uses unsupported normalization")
        units = report["independent_units"]
        ratings = report["ratings"]
        if (
            isinstance(units, bool)
            or not isinstance(units, int)
            or units < required_units
            or isinstance(ratings, bool)
            or not isinstance(ratings, int)
            or ratings < units
        ):
            raise HoldoutDecisionError(f"MOS report {claim_id} has insufficient independent evidence")
        metrics = report["metrics"]
        if not isinstance(metrics, list):
            raise HoldoutDecisionError(f"MOS report {claim_id}.metrics must be a list")
        metric_ids: list[str] = []
        for metric_index, metric in enumerate(metrics):
            if not isinstance(metric, dict):
                raise HoldoutDecisionError(f"MOS metric {claim_id}/{metric_index} must be an object")
            _exact_keys(
                metric,
                {
                    "metric_id",
                    "estimate",
                    "ci_lower",
                    "ci_upper",
                    "threshold",
                    "holm_adjusted_p",
                    "holm_rank",
                    "decision",
                },
                f"MOS metric {claim_id}/{metric_index}",
            )
            metric_id = _identifier(metric["metric_id"], f"MOS metric {claim_id}/{metric_index}.metric_id")
            metric_ids.append(metric_id)
            estimate = _number(metric["estimate"], f"MOS metric {claim_id}/{metric_id}.estimate")
            lower = _number(metric["ci_lower"], f"MOS metric {claim_id}/{metric_id}.ci_lower")
            upper = _number(metric["ci_upper"], f"MOS metric {claim_id}/{metric_id}.ci_upper")
            threshold = _number(metric["threshold"], f"MOS metric {claim_id}/{metric_id}.threshold")
            adjusted_p = _number(metric["holm_adjusted_p"], f"MOS metric {claim_id}/{metric_id}.holm_adjusted_p")
            rank = metric["holm_rank"]
            if not lower <= estimate <= upper or threshold != thresholds.get(metric_id):
                raise HoldoutDecisionError(f"MOS metric {claim_id}/{metric_id} has invalid bounds or threshold")
            if not 0 <= adjusted_p <= 1 or isinstance(rank, bool) or not isinstance(rank, int) or rank < 1:
                raise HoldoutDecisionError(f"MOS metric {claim_id}/{metric_id} has invalid Holm evidence")
            expected = "pass" if lower >= threshold and adjusted_p <= 0.05 else "fail"
            if metric["decision"] != expected or expected != "pass":
                raise HoldoutDecisionError(f"MOS metric failed for {claim_id}: {metric_id}")
            all_ranks.append(rank)
        if metric_ids != expected_metric_ids:
            raise HoldoutDecisionError(f"MOS report {claim_id} does not exactly cover the sorted MOS gates")
        reports[entry_id] = report
    expected_ranks = list(range(1, hypothesis_count + 1))
    if sorted(all_ranks) != expected_ranks:
        raise HoldoutDecisionError("Q2 MOS Holm ranks do not form one global hypothesis family")
    if set(reports) != expected_entries:
        raise HoldoutDecisionError("Q2 MOS reports do not exactly cover candidate surface entries")
    return reports


def _anchor_digest(matrix: dict[str, Any], landscape: dict[str, Any], claim_id: str) -> str:
    claim = next(item for item in matrix["claims"] if item["claim_id"] == claim_id)
    anchor_id = claim["sota_anchor_arm_id"]
    candidates = [item for item in landscape["candidates"] if item["candidate_id"] == anchor_id]
    if len(candidates) != 1:
        raise HoldoutDecisionError(f"SOTA claim {claim_id} has no unique external anchor artifact")
    return document_sha256(candidates[0])


def build_q2_qualification_report(  # noqa: PLR0912, PLR0913, PLR0915
    raw: object,
    *,
    f0_candidate: object,
    candidate_signature: object,
    preregistration: object,
    preregistration_signature: object,
    evaluation_authorization: object,
    evaluation_signature: object,
    trust_policy: object,
    surface: object,
    d1_report: object,
    design_report: object,
    calibration_catalog: object,
    comparator_gates: object,
    comparator_matrix: object,
    landscape: object,
    consumption_root: Path,
    now: datetime,
) -> dict[str, Any]:
    """Verify Q2 inputs and emit the only report shape accepted by the Studio audit."""

    if now.tzinfo != UTC or now.microsecond:
        raise HoldoutDecisionError("Q2 verification time must be a whole-second UTC timestamp")
    if not isinstance(raw, dict):
        raise HoldoutDecisionError("Q2 results must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "producer_id",
            "writer_id",
            "generated_at",
            "release_digest",
            "surface_digest",
            "preregistration_digest",
            "holdout_digest",
            "q2_runner_digest",
            "evaluation_authorization_digest",
            "transaction_id",
            "nonce_sha256",
            "objective_reports",
            "comparator_results",
            "mos_reports",
        },
        "Q2 results",
    )
    if raw["schema_version"] != Q2_RESULTS_SCHEMA:
        raise HoldoutDecisionError("unsupported Q2 result schema")
    producer_id = _identifier(raw["producer_id"], "Q2 producer_id")
    writer_id = _identifier(raw["writer_id"], "Q2 writer_id")
    generated_at = _timestamp(raw["generated_at"], "Q2 generated_at")
    try:
        candidate = validate_f0_candidate(f0_candidate)
        candidate_digest = verify_detached_signature(
            candidate,
            candidate_signature,
            trust_policy,
            required_role="preregistration-freezer",
            now=now,
        )
        prereg = validate_preregistration(preregistration, mapping_sha256=candidate["mapping_sha256"])
        prereg_digest = verify_detached_signature(
            prereg,
            preregistration_signature,
            trust_policy,
            required_role="preregistration-freezer",
            now=now,
        )
        authorization_digest = verify_detached_signature(
            evaluation_authorization,
            evaluation_signature,
            trust_policy,
            required_role="evaluation-authorizer",
            now=now,
        )
    except (AuthorizationError, FreezePreflightError, GovernanceError) as error:
        raise HoldoutDecisionError(f"Q2 signed freeze evidence rejected: {error}") from error
    if _signature_key_id(candidate_signature, "candidate signature") == _signature_key_id(
        evaluation_signature, "evaluation signature"
    ):
        raise HoldoutDecisionError("Q2 freezer and evaluation authorizer must use independent keys")
    if prereg["status"] != "frozen" or prereg_digest != candidate["preregistration_digest"]:
        raise HoldoutDecisionError("Q2 preregistration is not frozen and candidate-bound")
    if prereg["target_sota_claim_ids"] != candidate["target_sota_claim_ids"]:
        raise HoldoutDecisionError("Q2 target claims do not match the signed F0 candidate")
    if prereg["holdout_commitments"]["evaluation_runner_sha256"] != candidate["q2_runner_digest"]:
        raise HoldoutDecisionError("Q2 runner does not match the frozen preregistration")
    if candidate_digest != studio_sha256_document(candidate):
        raise HoldoutDecisionError("Q2 candidate signature dialect is not canonical Studio JSON")
    if studio_sha256_document(trust_policy) != candidate["trust_policy_digest"]:
        raise HoldoutDecisionError("Q2 trusted-key policy does not match F0")
    bindings = {
        "release_digest": candidate["release_digest"],
        "surface_digest": candidate["surface_digest"],
        "preregistration_digest": candidate["preregistration_digest"],
        "holdout_digest": candidate["holdout_digest"],
        "q2_runner_digest": candidate["q2_runner_digest"],
        "evaluation_authorization_digest": candidate["evaluation_authorization_digest"],
        "transaction_id": candidate["transaction_id"],
        "nonce_sha256": candidate["nonce_sha256"],
    }
    for field, value in bindings.items():
        if raw[field] != value:
            raise HoldoutDecisionError(f"Q2 {field} does not match F0")
    if authorization_digest != candidate["evaluation_authorization_digest"]:
        raise HoldoutDecisionError("Q2 evaluation authorization digest mismatch")
    try:
        authorization = validate_evaluation_authorization(
            evaluation_authorization,
            now=now,
            release_digest=candidate["release_digest"],
            preregistration_digest=candidate["preregistration_digest"],
            holdout_digest=candidate["holdout_digest"],
            q2_runner_digest=candidate["q2_runner_digest"],
            transaction_id=candidate["transaction_id"],
            nonce_sha256=candidate["nonce_sha256"],
            started=True,
        )
        consumption = validate_consumption_events(
            consumption_root,
            authorization_digest=authorization_digest,
            transaction_id=candidate["transaction_id"],
            nonce_sha256=candidate["nonce_sha256"],
            writer_id=writer_id,
            complete_by=_timestamp(authorization["complete_by"], "authorization complete_by"),
            trust_policy=trust_policy,
            now=now,
        )
    except AuthorizationError as error:
        raise HoldoutDecisionError(f"Q2 consumption state rejected: {error}") from error
    if not _timestamp(consumption["consumed_at"], "consumption consumed_at") <= generated_at <= min(
        now,
        _timestamp(authorization["complete_by"], "authorization complete_by"),
    ):
        raise HoldoutDecisionError("Q2 report was generated before consumption or after complete_by")
    entry_claims, entry_gates = _candidate_entries(surface, surface_digest=candidate["surface_digest"])
    candidate_claims = set(entry_claims.values())
    if not set(candidate["target_sota_claim_ids"]).issubset(candidate_claims):
        raise HoldoutDecisionError("Q2 target claim has no candidate surface entry")
    if not isinstance(d1_report, dict) or d1_report.get("schema_version") != COMPLETE_D1_REPORT_SCHEMA:
        raise HoldoutDecisionError("Q2 D1 report schema is unsupported")
    if not isinstance(design_report, dict) or design_report.get("schema_version") != DESIGN_REPORT_SCHEMA:
        raise HoldoutDecisionError("Q2 D0a design report schema is unsupported")
    expected_design = next(
        (item["sha256"] for item in candidate["detailed_reports"] if item["report_id"] == "d0a-design"),
        None,
    )
    required_units = design_report.get("required_independent_units")
    if (
        document_sha256(design_report) != expected_design
        or design_report.get("status") != "ready-to-freeze"
        or design_report.get("blockers") != []
        or isinstance(required_units, bool)
        or not isinstance(required_units, int)
        or required_units < 30
    ):
        raise HoldoutDecisionError("Q2 D0a report is not the complete F0-bound power design")
    expected_d1 = next(
        (item["sha256"] for item in candidate["detailed_reports"] if item["report_id"] == "d1-calibration"),
        None,
    )
    if document_sha256(d1_report) != expected_d1 or d1_report.get("verdict") != "pass":
        raise HoldoutDecisionError("Q2 D1 report is not the passing F0-bound report")
    try:
        calibration_report = build_calibration_gate_report(calibration_catalog)
    except CalibrationError as error:
        raise HoldoutDecisionError(f"Q2 calibration catalog rejected: {error}") from error
    if not isinstance(calibration_catalog, dict) or calibration_catalog.get("status") != "frozen":
        raise HoldoutDecisionError("Q2 calibration catalog must be frozen")
    if d1_report.get("calibration_catalog_digest") != calibration_report["catalog_digest"]:
        raise HoldoutDecisionError("Q2 calibration catalog is not bound by D1")
    if (
        calibration_catalog.get("preregistration_digest") != candidate["preregistration_digest"]
        or d1_report.get("release_digest") != candidate["release_digest"]
        or d1_report.get("preregistration_digest") != candidate["preregistration_digest"]
        or d1_report.get("design_digest") != calibration_catalog.get("design_digest")
        or d1_report.get("design_digest") != design_report.get("design_digest")
    ):
        raise HoldoutDecisionError("Q2 D1/calibration bindings do not match the signed candidate")
    _validate_objective_reports(
        raw["objective_reports"],
        entry_claims=entry_claims,
        entry_gates=entry_gates,
        candidate=candidate,
        calibration_catalog=calibration_catalog,
        calibration_report=calibration_report,
        design_digest=d1_report["design_digest"],
        required_units=required_units,
    )
    _validate_mos_reports(
        raw["mos_reports"],
        entry_claims=entry_claims,
        entry_gates=entry_gates,
        preregistration=prereg,
        required_units=required_units,
    )
    if not isinstance(raw["comparator_results"], dict):
        raise HoldoutDecisionError("Q2 comparator_results must be an object")
    try:
        comparator = build_holdout_comparator_decision(
            raw["comparator_results"],
            gates=comparator_gates,
            matrix=comparator_matrix,
            landscape=landscape,
            as_of=date.fromisoformat(landscape["cutoff_date"]),
        )
    except (ComparatorResultError, KeyError, TypeError, ValueError) as error:
        raise HoldoutDecisionError(f"Q2 comparator evidence rejected: {error}") from error
    for field in ("release_digest", "holdout_digest", "preregistration_digest", "q2_runner_digest"):
        if comparator[field] != candidate[field]:
            raise HoldoutDecisionError(f"Q2 comparator {field} mismatch")
    if comparator["status"] != "pass" or comparator["sota_status"] != "anchor-holdout-pass":
        raise HoldoutDecisionError("Q2 comparator did not qualify every frozen SOTA target")
    if comparator["target_sota_claim_ids"] != candidate["target_sota_claim_ids"]:
        raise HoldoutDecisionError("Q2 comparator target claims do not match F0")
    if any(
        gate["independent_units"] < required_units
        for claim in comparator["claims"]
        if claim["claim_id"] in candidate["target_sota_claim_ids"]
        for gate in claim["gates"]
    ):
        raise HoldoutDecisionError("Q2 comparator evidence is below the frozen D0a power requirement")
    if comparator["comparator_matrix_digest"] != prereg["holdout_commitments"]["baseline_matrix_sha256"]:
        raise HoldoutDecisionError("Q2 comparator matrix is not the frozen preregistration baseline")
    comparator_claims = {item["claim_id"]: item for item in comparator["claims"]}
    claim_results: list[dict[str, Any]] = []
    for claim_id in sorted(candidate_claims):
        if claim_id in candidate["target_sota_claim_ids"]:
            decision = comparator_claims.get(claim_id)
            if not decision or decision["status"] != "sota-holdout-pass":
                raise HoldoutDecisionError(f"Q2 target claim is not SOTA-qualified: {claim_id}")
            anchor_digest: str | None = _anchor_digest(comparator_matrix, landscape, claim_id)
            status = "sota-qualified"
        else:
            anchor_digest = None
            status = "local-only"
        claim_results.append({"claimId": claim_id, "status": status, "sotaAnchorDigest": anchor_digest})
    coverage = [
        {"surfaceEntryId": entry_id, "gates": entry_gates[entry_id]}
        for entry_id in sorted(entry_claims)
    ]
    return {
        "schemaVersion": Q2_REPORT_SCHEMA,
        "kind": "q2-holdout",
        "releaseDigest": candidate["release_digest"],
        "preregistrationDigest": candidate["preregistration_digest"],
        "surfaceDigest": candidate["surface_digest"],
        "producerId": producer_id,
        "producerDigest": candidate["q2_runner_digest"],
        "verdict": "pass",
        "warnings": [],
        "coverage": coverage,
        "claimResults": claim_results,
    }
