from __future__ import annotations

import base64
import copy
import json
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ltx_trainer.av_eval.authorization import (
    build_consumption_event,
    record_signed_consumption_event,
    studio_canonical_json,
    studio_sha256_document,
)
from ltx_trainer.av_eval.calibration import build_calibration_gate_report
from ltx_trainer.av_eval.design import document_sha256
from ltx_trainer.av_eval.freeze_preflight import FreezePreflightError, build_f0_preflight_report
from ltx_trainer.av_eval.holdout import HoldoutDecisionError, build_q2_qualification_report

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PREREGISTRATION_PATH = (
    REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "preregistration.v2.json"
)
CALIBRATION_PATH = (
    REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "calibration-gates.v1.json"
)
MATRIX_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "comparator-matrix.v1.json"
LANDSCAPE_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "anchor-landscape.v1.json"
RIGHTS_CATALOG_PATH = REPOSITORY_ROOT / "apps" / "ltx-studio" / "release" / "rights-evidence.v1.json"
NOW = datetime(2026, 8, 11, 12, 0, tzinfo=UTC)
TARGETS = [
    "audio-driven-video.image-audio-to-video",
]
QUALIFICATION_KINDS = [
    "d1-calibration",
    "q0-cross-shot",
    "q1-comparators",
    "r0-control-plane",
    "r1-reproducible-build",
    "r3-canaries",
    "r3-pause-resume",
    "r3-soak",
]
EVALUATOR_RIGHTS_IDS = [
    "evaluator-vbench-amt-noncommercial",
    "evaluator-vbench-permissive-components",
    "evaluator-vbench-pyiqa-noncommercial",
]


def _timestamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _key() -> tuple[Ed25519PrivateKey, str]:
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return private, base64.b64encode(public).decode()


def _rights_catalog(*, blocked_evaluator_id: str | None) -> dict[str, Any]:
    catalog = json.loads(RIGHTS_CATALOG_PATH.read_text(encoding="utf-8"))
    for entry in catalog["evidence"]:
        if entry["evidenceId"] not in EVALUATOR_RIGHTS_IDS or entry["evidenceId"] == blocked_evaluator_id:
            continue
        entry["decision"] = "conditional"
        for dimension in ("code", "weights", "commercialUse"):
            if entry["dimensions"][dimension] == "blocked":
                entry["dimensions"][dimension] = "conditional"
    return catalog


def _fixture(
    *,
    now: datetime = NOW,
    q1_sota_status: str = "anchor-pilot-pass",
    key_valid_hours: int = 48,
    baseline_matrix_digest: str = "6" * 64,
    holdout_signing_key: tuple[Ed25519PrivateKey, str] | None = None,
    include_holdout_scorer: bool = True,
    include_audio_candidate: bool = False,
    soak_jobs: int = 50,
    pause_mode_families: list[str] | None = None,
    evaluator_rights_failure: str | None = None,
) -> dict[str, Any]:
    release_digest = "1" * 64
    holdout_digest = "3" * 64
    q2_runner_digest = "4" * 64
    nonce_digest = "5" * 64
    mapping_digest = "97f14cc467ddbc2296ff634f7b5d315a1e02553c3527a911b6438569daf25760"
    preregistration = json.loads(PREREGISTRATION_PATH.read_text(encoding="utf-8"))
    preregistration["status"] = "frozen"
    preregistration["target_sota_claim_ids"] = TARGETS
    commitments = preregistration["holdout_commitments"]
    for field in (
        "model_recipe_sha256",
        "initial_weights_sha256",
        "training_runner_sha256",
        "evaluation_runner_sha256",
        "hyperparameter_search_space_sha256",
        "prompt_set_sha256",
        "rating_protocol_sha256",
        "baseline_matrix_sha256",
    ):
        commitments[field] = q2_runner_digest if field == "evaluation_runner_sha256" else "6" * 64
    commitments["baseline_matrix_sha256"] = baseline_matrix_digest
    for index, arm in enumerate(commitments["comparator_arms"], start=1):
        arm["code_revision"] = str(index) * 40
        arm["weights_revision"] = str(index) * 40
    preregistration_digest = studio_sha256_document(preregistration)
    surface = {
        "schemaVersion": "candidate-release-surface.v1",
        "entries": [
            {
                "id": f"surface-{index:02d}",
                "claimId": claim_id,
                "targetStatus": "candidate",
                "request": {"mode": "lipdub"},
                "cooperativeCheckpoint": True,
                "applicableGates": [
                    "runtime-import",
                    "cold-canary",
                    "playable-output",
                    "provenance",
                    "av-sync",
                    "phoneme-viseme",
                    "mouth-artifact",
                    "identity",
                    "sharpness",
                    "vbench-i2v",
                    "asr-critical-token",
                    "audio-quality",
                    "mos",
                ],
                "rights": {"status": "conditional", "evidenceIds": ["rights.ltx-core"]},
            }
            for index, claim_id in enumerate(TARGETS)
        ],
    }
    if include_audio_candidate:
        surface["entries"].append(
            {
                "id": "surface-audio",
                "claimId": "native-generation.text-to-audio",
                "targetStatus": "candidate",
                "request": {"mode": "text-to-audio"},
                "cooperativeCheckpoint": False,
                "applicableGates": [
                    "runtime-import",
                    "cold-canary",
                    "playable-output",
                    "provenance",
                    "audio-quality",
                    "mos",
                ],
                "rights": {"status": "conditional", "evidenceIds": ["rights.ltx-core"]},
            }
        )
    surface_digest = studio_sha256_document(surface)

    design_digest = "7" * 64
    calibration_digest = "8" * 64
    calibration_catalog = _frozen_calibration_catalog(preregistration_digest, design_digest)
    calibration_catalog_digest = build_calibration_gate_report(calibration_catalog)["catalog_digest"]
    detailed_reports: dict[str, dict[str, Any]] = {
        "d0-readiness": {
            "schema_version": "ltx-av-eval-product-readiness-report.v1",
            "status": "ready-to-freeze",
            "blockers": [],
        },
        "d0a-design": {
            "schema_version": "ltx-sota-power-report.v1",
            "status": "ready-to-freeze",
            "blockers": [],
            "design_digest": design_digest,
            "required_independent_units": 30,
            "planning_hypothesis_count": 193,
        },
        "d0a-pilot-binding": {
            "schema_version": "ltx-sota-design-pilot-binding.v1",
            "status": "ready-to-freeze",
            "blockers": [],
            "pilot_report_digest": "1" * 64,
            "pilot_evidence_digest": "2" * 64,
            "frozen_dataset_digest": "3" * 64,
            "leakage_audit_digest": "4" * 64,
            "evaluator_bundle_digest": "5" * 64,
            "design_digest": design_digest,
            "power_report_digest": "pending",
            "required_independent_units": 30,
            "required_clips": 90,
            "planning_hypothesis_count": 193,
        },
        "d1-calibration": {
            "schema_version": "ltx-av-eval-complete-d1-report.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "preregistration_digest": preregistration_digest,
            "design_digest": design_digest,
            "dataset_digest": calibration_digest,
            "calibration_catalog_digest": calibration_catalog_digest,
        },
        "q0-cross-shot": {
            "schema_version": "ltx-av-eval-cross-shot-decision.v1",
            "verdict": "winner",
            "release_digest": release_digest,
            "preregistration_digest": preregistration_digest,
            "design_digest": design_digest,
            "dataset_digest": calibration_digest,
            "prompt_set_digest": commitments["prompt_set_sha256"],
            "rating_protocol_digest": commitments["rating_protocol_sha256"],
        },
        "q1-comparators": {
            "schema_version": "ltx-av-eval-comparator-decision.v1",
            "status": "ready-to-freeze",
            "sota_status": q1_sota_status,
            "release_digest": release_digest,
            "preregistration_digest": preregistration_digest,
            "calibration_dataset_digest": calibration_digest,
            "target_sota_claim_ids": TARGETS,
            "comparator_matrix_digest": commitments["baseline_matrix_sha256"],
        },
        "r0-control-plane": {
            "schema_version": "ltx-studio-r0-control-plane-evidence.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "scheduler_actions": [
                "continue_current",
                "resume_current",
                "wait_for_successor",
                "yield_to_waiting_job",
            ],
            "running_transport_failure": "checkpoint-and-exit-75",
            "paused_transport_failure": "remain-paused-and-retry",
            "api_restart_reconciled": True,
            "studio_restart_reconciled": True,
        },
        "r3-canaries": {
            "schema_version": "ltx-studio-r3-canary-evidence.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "candidate_entry_count": len(surface["entries"]),
            "candidate_entry_ids": sorted(entry["id"] for entry in surface["entries"]),
            "failures": 0,
        },
        "r3-pause-resume": {
            "schema_version": "ltx-studio-r3-pause-resume-evidence.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "cycles": 20,
            "mode_families": ["lipdub"] if pause_mode_families is None else pause_mode_families,
            "boundary_positions": ["early", "middle", "late"],
            "equivalence_failures": 0,
            "orphaned_jobs": 0,
        },
        "r3-soak": {
            "schema_version": "ltx-studio-r3-soak-evidence.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "jobs": soak_jobs,
            "lost_jobs": 0,
            "orphaned_jobs": 0,
            "duplicate_jobs": 0,
            "unbound_outputs": 0,
            "foreign_service_actions": 0,
            "recovery_slo_breaches": 0,
        },
    }
    detailed_reports["d0a-pilot-binding"]["power_report_digest"] = document_sha256(
        detailed_reports["d0a-design"]
    )
    detailed_digests = {name: document_sha256(report) for name, report in detailed_reports.items()}

    keys: dict[str, Ed25519PrivateKey] = {}
    policy_keys: list[dict[str, Any]] = []
    for key_id, role in (
        ("freeze-key-01", "preregistration-freezer"),
        ("rights-key-01", "rights-attestor"),
        ("qualification-key-01", "qualification-attestor"),
        ("evaluation-key-01", "evaluation-authorizer"),
    ):
        private, public = _key()
        keys[key_id] = private
        policy_keys.append(
            {
                "keyId": key_id,
                "algorithm": "ed25519",
                "publicKeyBase64": public,
                "roles": [role],
                "notBefore": _timestamp(now - timedelta(days=1)),
                "notAfter": _timestamp(now + timedelta(hours=key_valid_hours)),
                "revokedAt": None,
            }
        )
    if include_holdout_scorer:
        holdout_private, holdout_public = holdout_signing_key or _key()
        keys["holdout-key-01"] = holdout_private
        policy_keys.append(
            {
                "keyId": "holdout-key-01",
                "algorithm": "ed25519",
                "publicKeyBase64": holdout_public,
                "roles": ["holdout-scorer"],
                "notBefore": _timestamp(now - timedelta(days=1)),
                "notAfter": _timestamp(now + timedelta(hours=key_valid_hours)),
                "revokedAt": None,
            }
        )
    trust_policy = {
        "schemaVersion": "ltx-studio-trusted-keys.v1",
        "policyId": "f0-trust-policy-01",
        "keys": policy_keys,
    }

    def sign(document: object, key_id: str) -> dict[str, Any]:
        payload = studio_canonical_json(document)
        return {
            "schemaVersion": "ltx-studio-detached-signature.v1",
            "algorithm": "ed25519",
            "keyId": key_id,
            "payloadSha256": studio_sha256_document(document),
            "signatureBase64": base64.b64encode(keys[key_id].sign(payload)).decode(),
        }

    evaluation_authorization = {
        "schema_version": "ltx-av-eval-evaluation-authorization.v1",
        "release_digest": release_digest,
        "preregistration_digest": preregistration_digest,
        "holdout_digest": holdout_digest,
        "q2_runner_digest": q2_runner_digest,
        "transaction_id": "q2-transaction-001",
        "nonce_sha256": nonce_digest,
        "not_before": _timestamp(now - timedelta(minutes=5)),
        "start_by": _timestamp(now + timedelta(hours=2)),
        "complete_by": _timestamp(now + timedelta(hours=30)),
        "recovery_policy": "same-transaction-and-nonce-resume-until-complete-by.v1",
    }
    blocked_evaluator_id = (
        "evaluator-vbench-amt-noncommercial" if evaluator_rights_failure == "blocked" else None
    )
    omitted_evaluator_id = (
        "evaluator-vbench-pyiqa-noncommercial" if evaluator_rights_failure == "unattested" else None
    )
    rights_catalog = _rights_catalog(blocked_evaluator_id=blocked_evaluator_id)
    rights = {
        "schemaVersion": "ltx-studio-rights-attestation.v1",
        "releaseDigest": release_digest,
        "surfaceDigest": surface_digest,
        "evidenceCatalogDigest": studio_sha256_document(rights_catalog),
        "policyVersion": "ltx-studio-release-rights.v1",
        "validAt": _timestamp(now - timedelta(hours=1)),
        "expiresAt": _timestamp(now + timedelta(hours=48)),
        "revocationState": "clear",
        "evidenceIds": [
            *(evidence_id for evidence_id in EVALUATOR_RIGHTS_IDS if evidence_id != omitted_evaluator_id),
            "rights.ltx-core",
        ],
        "warnings": [],
    }
    qualification_reports: list[dict[str, Any]] = []
    qualification_digests: dict[str, str] = {}
    for kind in QUALIFICATION_KINDS:
        ownership = {
            "d1-calibration": [
                "av-sync",
                "phoneme-viseme",
                "mouth-artifact",
                "identity",
                "sharpness",
                "vbench-i2v",
                "asr-critical-token",
                "audio-quality",
            ],
            "q0-cross-shot": [
                "av-sync",
                "phoneme-viseme",
                "mouth-artifact",
                "identity",
                "sharpness",
                "vbench-i2v",
            ],
            "q1-comparators": [
                "av-sync",
                "phoneme-viseme",
                "mouth-artifact",
                "identity",
                "sharpness",
                "vbench-i2v",
                "asr-critical-token",
                "audio-quality",
            ],
            "r1-reproducible-build": ["runtime-import"],
            "r3-canaries": ["cold-canary", "playable-output", "provenance"],
        }.get(kind, [])
        report = {
            "schemaVersion": "ltx-studio-qualification-report.v1",
            "kind": kind,
            "releaseDigest": release_digest,
            "preregistrationDigest": preregistration_digest,
            "surfaceDigest": surface_digest,
            "producerId": f"producer.{kind}",
            "producerDigest": detailed_digests.get(kind, "a" * 64),
            "verdict": "pass",
            "warnings": [],
            "coverage": [
                {
                    "surfaceEntryId": entry["id"],
                    "gates": [gate for gate in ownership if gate in entry["applicableGates"]],
                }
                for entry in surface["entries"]
                if any(gate in entry["applicableGates"] for gate in ownership)
            ]
            if ownership
            else [],
            "claimResults": [],
        }
        qualification_reports.append({"document": report, "signature": sign(report, "qualification-key-01")})
        qualification_digests[kind] = studio_sha256_document(report)
    candidate = {
        "schema_version": "ltx-av-eval-f0-candidate.v1",
        "candidate_id": "final-candidate-001",
        "release_digest": release_digest,
        "surface_digest": surface_digest,
        "mapping_sha256": mapping_digest,
        "rights_evidence_catalog_digest": rights["evidenceCatalogDigest"],
        "holdout_digest": holdout_digest,
        "q2_runner_digest": q2_runner_digest,
        "transaction_id": evaluation_authorization["transaction_id"],
        "nonce_sha256": nonce_digest,
        "trust_policy_digest": studio_sha256_document(trust_policy),
        "preregistration_digest": preregistration_digest,
        "rights_attestation_digest": studio_sha256_document(rights),
        "evaluation_authorization_digest": studio_sha256_document(evaluation_authorization),
        "target_sota_claim_ids": TARGETS,
        "detailed_reports": [
            {"report_id": name, "sha256": detailed_digests[name]} for name in sorted(detailed_digests)
        ],
        "qualification_reports": [
            {"kind": kind, "sha256": qualification_digests[kind]} for kind in QUALIFICATION_KINDS
        ],
        "invalidation_events": [],
    }
    return {
        "raw": candidate,
        "candidate_signature": sign(candidate, "freeze-key-01"),
        "preregistration": preregistration,
        "preregistration_signature": sign(preregistration, "freeze-key-01"),
        "rights_attestation": rights,
        "rights_signature": sign(rights, "rights-key-01"),
        "rights_evidence_catalog": rights_catalog,
        "evaluation_authorization": evaluation_authorization,
        "evaluation_signature": sign(evaluation_authorization, "evaluation-key-01"),
        "trust_policy": trust_policy,
        "surface": surface,
        "detailed_reports": detailed_reports,
        "qualification_bundle": {
            "schema_version": "ltx-av-eval-f0-qualification-bundle.v1",
            "reports": qualification_reports,
        },
        "now": now,
    }


def _frozen_calibration_catalog(preregistration_digest: str, design_digest: str) -> dict[str, Any]:
    catalog = json.loads(CALIBRATION_PATH.read_text(encoding="utf-8"))
    catalog["status"] = "frozen"
    catalog["design_digest"] = design_digest
    catalog["preregistration_digest"] = preregistration_digest
    catalog["vbench_gate_catalog_digest"] = "a" * 64
    for fingerprint in catalog["evaluator_fingerprints"]:
        fingerprint["sha256"] = "b" * 64
    for gate in catalog["gates"]:
        gate["basis_evidence_sha256"] = "c" * 64
        if gate["threshold"] is None:
            gate["threshold"] = 0.95
    return catalog


def _q2_comparator_contracts() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    landscape = json.loads(LANDSCAPE_PATH.read_text(encoding="utf-8"))
    landscape["status"] = "verified"
    for index, candidate in enumerate(landscape["candidates"], start=1):
        marker = str(index)
        for field in ("code_revision", "weights_revision"):
            candidate[field] = marker * 40
        for field in ("code_license_sha256", "weights_license_sha256"):
            candidate[field] = marker * 64
        if candidate["compatible_claim_ids"]:
            candidate["resource_profile_sha256"] = marker * 64
            candidate["resource_fit_status"] = "pass"
        else:
            candidate["resource_profile_sha256"] = None
            candidate["resource_fit_status"] = "not-applicable"
    landscape_index = {candidate["candidate_id"]: candidate for candidate in landscape["candidates"]}
    matrix = json.loads(MATRIX_PATH.read_text(encoding="utf-8"))
    matrix["status"] = "frozen"
    matrix["landscape_sha256"] = document_sha256(landscape)
    matrix["target_sota_claim_ids"] = TARGETS
    for claim in matrix["claims"]:
        target = claim["claim_id"] in TARGETS
        claim["claim_status"] = "sota-target" if target else "local-only"
        claim["sota_anchor_arm_id"] = "longcat-video-avatar-1.5" if target else None
        for arm in claim["arms"]:
            if arm["provider"] == "external":
                candidate = landscape_index[arm["arm_id"]]
                arm["code_revision"] = candidate["code_revision"]
                arm["weights_revision"] = candidate["weights_revision"]
            if arm["provider"] == "owned":
                arm.update(
                    inclusion_status="included",
                    input_compatibility="compatible",
                    rights_status="clear",
                    technical_status="pass",
                    code_revision="d" * 40,
                    weights_revision="e" * 40,
                )
            elif target and claim["claim_id"] in landscape_index[arm["arm_id"]]["compatible_claim_ids"]:
                candidate = landscape_index[arm["arm_id"]]
                arm.update(
                    inclusion_status="included",
                    input_compatibility="compatible",
                    rights_status="clear",
                    technical_status="pass",
                    code_revision=candidate["code_revision"],
                    weights_revision=candidate["weights_revision"],
                )
            else:
                arm.update(
                    inclusion_status="excluded",
                    input_compatibility="incompatible",
                    rights_status="clear",
                    technical_status="pass",
                    exclusion_reason="input-contract-incompatible",
                )
    families = [
        "artifact",
        "asr",
        "audio-quality",
        "av-sync",
        "identity",
        "mouth-content",
        "mos",
        "sharpness",
        "vbench",
    ]
    gates = {
        "schema_version": "ltx-av-eval-comparator-gates.v1",
        "status": "frozen",
        "gates": [
            {
                "gate_id": f"gate-{index:02d}",
                "claim_id": claim_id,
                "gate_family": family,
                "metric_id": f"metric-{family}",
                "direction": "higher",
                "test": "superiority" if family == "artifact" else "noninferiority",
                "delta": 0.1,
                "valid_min": 0.0,
                "valid_max": 1.0,
            }
            for index, (claim_id, family) in enumerate(
                (claim_id, family) for claim_id in TARGETS for family in families
            )
        ],
    }
    for commitment in matrix["commitments"]:
        commitment["sha256"] = document_sha256(gates) if commitment["artifact_id"] == "applicable_gates" else "f" * 64
    return matrix, landscape, gates


def test_complete_f0_preflight_binds_the_single_q2_authorization() -> None:
    fixture = _fixture()
    first = build_f0_preflight_report(**fixture)
    second = build_f0_preflight_report(**copy.deepcopy(fixture))

    assert first == second
    assert first["status"] == "f0-pass-ready-for-q2"
    assert first["q2_authorized"] is True
    assert first["production_authorized"] is False
    assert first["target_sota_claim_ids"] == TARGETS


def test_f0_rejects_a_signed_technical_pass_without_the_full_soak() -> None:
    fixture = _fixture(soak_jobs=49)

    with pytest.raises(FreezePreflightError, match="r3-soak detailed evidence fails jobs"):
        build_f0_preflight_report(**fixture)


def test_f0_rejects_pause_resume_evidence_for_the_wrong_mode_family() -> None:
    fixture = _fixture(pause_mode_families=["distilled"])

    with pytest.raises(FreezePreflightError, match="exactly cover cooperative candidate modes"):
        build_f0_preflight_report(**fixture)


def test_f0_rejects_rights_that_expire_during_q2() -> None:
    fixture = _fixture()
    fixture["rights_attestation"]["expiresAt"] = _timestamp(NOW + timedelta(hours=4))
    with pytest.raises(FreezePreflightError, match="rights window"):
        build_f0_preflight_report(**fixture)

    short_key_window = _fixture(key_valid_hours=4)
    with pytest.raises(FreezePreflightError, match="signing key expires"):
        build_f0_preflight_report(**short_key_window)


def test_f0_rejects_blocked_or_unattested_sota_evaluator_rights() -> None:
    blocked = _fixture(evaluator_rights_failure="blocked")
    with pytest.raises(FreezePreflightError, match="SOTA evaluator rights are blocked"):
        build_f0_preflight_report(**blocked)

    unattested = _fixture(evaluator_rights_failure="unattested")
    with pytest.raises(FreezePreflightError, match="misses SOTA evaluator evidence"):
        build_f0_preflight_report(**unattested)


def test_f0_rejects_any_change_to_the_signed_candidate_index() -> None:
    fixture = _fixture()
    fixture["raw"]["release_digest"] = "f" * 64

    with pytest.raises(FreezePreflightError, match="signed F0 candidate"):
        build_f0_preflight_report(**fixture)


def test_f0_rejects_q1_hold_and_detailed_report_drift() -> None:
    fixture = _fixture()
    fixture["detailed_reports"]["q1-comparators"]["sota_status"] = "hold"
    with pytest.raises(FreezePreflightError, match="detailed report digest mismatch"):
        build_f0_preflight_report(**fixture)

    fixture = _fixture(q1_sota_status="hold")
    with pytest.raises(FreezePreflightError, match="Q1 target comparator pilot"):
        build_f0_preflight_report(**fixture)


def test_f0_requires_a_separate_evaluation_authorizer_key() -> None:
    fixture = _fixture()
    fixture["evaluation_signature"] = fixture["preregistration_signature"]
    with pytest.raises(FreezePreflightError, match=r"evaluation authorization rejected|independent signing key"):
        build_f0_preflight_report(**fixture)

    fixture = _fixture()
    evaluation_key = next(
        key for key in fixture["trust_policy"]["keys"] if "evaluation-authorizer" in key["roles"]
    )
    evaluation_key["roles"].append("release-authorizer")
    with pytest.raises(FreezePreflightError, match="evaluation and release"):
        build_f0_preflight_report(**fixture)

    fixture = _fixture(include_holdout_scorer=False)
    with pytest.raises(FreezePreflightError, match="exactly one trusted holdout-scorer"):
        build_f0_preflight_report(**fixture)


def test_f0_cli_emits_only_a_non_production_preflight(tmp_path: Path) -> None:
    fixture = _fixture(now=datetime.now(UTC).replace(microsecond=0))
    argument_names = {
        "candidate": "raw",
        "candidate-signature": "candidate_signature",
        "preregistration": "preregistration",
        "preregistration-signature": "preregistration_signature",
        "rights-attestation": "rights_attestation",
        "rights-signature": "rights_signature",
        "rights-evidence-catalog": "rights_evidence_catalog",
        "evaluation-authorization": "evaluation_authorization",
        "evaluation-signature": "evaluation_signature",
        "trust-policy": "trust_policy",
        "surface": "surface",
        "detailed-reports": "detailed_reports",
        "qualifications": "qualification_bundle",
    }
    arguments: list[str] = []
    for argument, fixture_key in argument_names.items():
        path = tmp_path / f"{argument}.json"
        path.write_text(json.dumps(fixture[fixture_key]), encoding="utf-8")
        arguments.extend([f"--{argument}", str(path)])
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "f0-check",
            *arguments,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["q2_authorized"] is True
    assert report["production_authorized"] is False


def _passing_objective_report(
    claim_id: str,
    *,
    fixture: dict[str, Any],
    catalog: dict[str, Any],
) -> dict[str, Any]:
    catalog_report = build_calibration_gate_report(catalog)
    required = [*catalog["gates"]]
    required.extend(
        {
            "metric_id": metric_id,
            "direction": "lower",
            "decision_value": "estimate",
            "threshold": 0.05,
        }
        for metric_id in catalog["vbench_metric_ids"]
        if metric_id.startswith(f"vbench.{claim_id}.")
    )
    metrics: list[dict[str, Any]] = []
    for gate in sorted(required, key=lambda item: item["metric_id"]):
        threshold = float(gate["threshold"])
        if gate["direction"] == "higher":
            estimate, lower, upper = threshold + 0.02, threshold + 0.01, threshold + 0.03
        else:
            estimate, lower, upper = threshold * 0.5, threshold * 0.25, threshold * 0.75
        metrics.append(
            {
                "metric_id": gate["metric_id"],
                "estimate": estimate,
                "ci_lower": lower,
                "ci_upper": upper,
                "threshold": threshold,
                "direction": gate["direction"],
                "decision_value": gate["decision_value"],
                "decision": "pass",
                "independent_units": 30,
                "clips": 90,
                "strata_digest": "d" * 64,
            }
        )
    candidate = fixture["raw"]
    d1 = fixture["detailed_reports"]["d1-calibration"]
    return {
        "schema_version": "ltx-av-eval-measurement-report.v1",
        "kind": "holdout",
        "dataset_digest": candidate["holdout_digest"],
        "preregistration_digest": candidate["preregistration_digest"],
        "release_digest": candidate["release_digest"],
        "design_digest": d1["design_digest"],
        "runner_digest": candidate["q2_runner_digest"],
        "evaluator_digest": catalog_report["evaluator_fingerprints_digest"],
        "thresholds_digest": catalog_report["catalog_digest"],
        "producer_id": "independent-q2-scorer",
        "generated_at": _timestamp(NOW + timedelta(seconds=2)),
        "verdict": "pass",
        "warnings": [],
        "metrics": metrics,
    }


def _passing_q2_results(
    fixture: dict[str, Any],
    matrix: dict[str, Any],
    gates: dict[str, Any],
    catalog: dict[str, Any],
) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    row_index = 0
    for claim in matrix["claims"]:
        included = sorted(arm["arm_id"] for arm in claim["arms"] if arm["inclusion_status"] == "included")
        metrics = sorted(
            gate["metric_id"]
            for gate in gates["gates"]
            if gate["claim_id"] == claim["claim_id"]
        )
        for component_index in range(30):
            for arm_id in included:
                rows.append(
                    {
                        "row_id": f"row-{row_index:04d}",
                        "claim_id": claim["claim_id"],
                        "sample_id": f"sample-{component_index:02d}",
                        "leakage_component_id": f"component-{component_index:02d}",
                        "generation_seed": 7,
                        "arm_id": arm_id,
                        "status": "completed",
                        "measurements": dict.fromkeys(metrics, 0.9 if arm_id.startswith("ltx-") else 0.5),
                    }
                )
                row_index += 1
    candidate = fixture["raw"]
    mos_reports: list[dict[str, Any]] = []
    rank = 1
    thresholds = {
        "audio-quality-absolute": 9.0,
        "identity-mouth-absolute": 9.0,
        "identity-mouth-margin": 0.3,
        "lip-sync-absolute": 9.0,
        "lip-sync-margin": 0.5,
    }
    for surface_entry in fixture["surface"]["entries"]:
        claim_id = surface_entry["claimId"]
        metrics = []
        metric_ids = (
            sorted(thresholds)
            if set(surface_entry["applicableGates"]) - {
                "runtime-import",
                "cold-canary",
                "playable-output",
                "provenance",
                "audio-quality",
                "mos",
            }
            else ["audio-quality-absolute"]
        )
        for metric_id in metric_ids:
            threshold = thresholds[metric_id]
            metrics.append(
                {
                    "metric_id": metric_id,
                    "estimate": threshold + 0.2,
                    "ci_lower": threshold + 0.1,
                    "ci_upper": threshold + 0.3,
                    "threshold": threshold,
                    "holm_adjusted_p": 0.001,
                    "holm_rank": rank,
                    "decision": "pass",
                }
            )
            rank += 1
        mos_reports.append(
            {
                "claim_id": claim_id,
                "surface_entry_id": surface_entry["id"],
                "rating_protocol_digest": fixture["preregistration"]["holdout_commitments"][
                    "rating_protocol_sha256"
                ],
                "blinded": True,
                "randomized_arm_order": True,
                "normalization": "identical-loudness-and-timeline.v1",
                "independent_units": 30,
                "ratings": 90,
                "metrics": metrics,
            }
        )
    return {
        "schema_version": "ltx-av-eval-q2-results.v1",
        "producer_id": "independent-q2-scorer",
        "writer_id": "independent-q2-writer",
        "generated_at": _timestamp(NOW + timedelta(seconds=2)),
        "release_digest": candidate["release_digest"],
        "surface_digest": candidate["surface_digest"],
        "preregistration_digest": candidate["preregistration_digest"],
        "holdout_digest": candidate["holdout_digest"],
        "q2_runner_digest": candidate["q2_runner_digest"],
        "evaluation_authorization_digest": candidate["evaluation_authorization_digest"],
        "transaction_id": candidate["transaction_id"],
        "nonce_sha256": candidate["nonce_sha256"],
        "objective_reports": [
            {
                "surface_entry_id": f"surface-{entry_index:02d}",
                "report": _passing_objective_report(claim_id, fixture=fixture, catalog=catalog),
            }
            for entry_index, claim_id in enumerate(TARGETS)
        ],
        "comparator_results": {
            "schema_version": "ltx-av-eval-holdout-comparator-results.v1",
            "release_digest": candidate["release_digest"],
            "holdout_digest": candidate["holdout_digest"],
            "preregistration_digest": candidate["preregistration_digest"],
            "comparator_matrix_digest": document_sha256(matrix),
            "q2_runner_digest": candidate["q2_runner_digest"],
            "bootstrap": {"replicates": 10_000, "confidence_level": 0.95, "seed": 41},
            "rows": rows,
        },
        "mos_reports": mos_reports,
    }


def test_q2_assembles_only_consumed_objective_mos_and_anchor_passes(tmp_path: Path) -> None:
    matrix, landscape, gates = _q2_comparator_contracts()
    matrix_digest = document_sha256(matrix)
    holdout_signing_key = _key()
    fixture = _fixture(
        baseline_matrix_digest=matrix_digest,
        holdout_signing_key=holdout_signing_key,
        include_audio_candidate=True,
    )
    catalog = _frozen_calibration_catalog(
        fixture["raw"]["preregistration_digest"],
        fixture["detailed_reports"]["d1-calibration"]["design_digest"],
    )
    results = _passing_q2_results(fixture, matrix, gates, catalog)
    consumption_root = tmp_path / "consumption"
    consumption_root.mkdir(mode=0o700)
    event_args = {
        "authorization_digest": fixture["raw"]["evaluation_authorization_digest"],
        "transaction_id": fixture["raw"]["transaction_id"],
        "nonce_sha256": fixture["raw"]["nonce_sha256"],
        "writer_id": results["writer_id"],
    }
    holdout_private, _holdout_public = holdout_signing_key
    for event, occurred_at in (("started", NOW), ("consumed", NOW + timedelta(seconds=1))):
        document = build_consumption_event(event=event, occurred_at=occurred_at, **event_args)  # type: ignore[arg-type]
        signature = {
            "schemaVersion": "ltx-studio-detached-signature.v1",
            "algorithm": "ed25519",
            "keyId": "holdout-key-01",
            "payloadSha256": studio_sha256_document(document),
            "signatureBase64": base64.b64encode(holdout_private.sign(studio_canonical_json(document))).decode(),
        }
        record_signed_consumption_event(
            consumption_root,
            event=event,  # type: ignore[arg-type]
            occurred_at=occurred_at,
            signature=signature,
            trust_policy=fixture["trust_policy"],
            **event_args,
        )
    arguments = {
        "f0_candidate": fixture["raw"],
        "candidate_signature": fixture["candidate_signature"],
        "preregistration": fixture["preregistration"],
        "preregistration_signature": fixture["preregistration_signature"],
        "evaluation_authorization": fixture["evaluation_authorization"],
        "evaluation_signature": fixture["evaluation_signature"],
        "trust_policy": fixture["trust_policy"],
        "surface": fixture["surface"],
        "d1_report": fixture["detailed_reports"]["d1-calibration"],
        "design_report": fixture["detailed_reports"]["d0a-design"],
        "calibration_catalog": catalog,
        "comparator_gates": gates,
        "comparator_matrix": matrix,
        "landscape": landscape,
        "consumption_root": consumption_root,
        "now": NOW + timedelta(seconds=2),
    }

    report = build_q2_qualification_report(results, **arguments)

    assert report["kind"] == "q2-holdout"
    assert report["verdict"] == "pass"
    assert {result["status"] for result in report["claimResults"]} == {"local-only", "sota-qualified"}
    assert all(
        result["sotaAnchorDigest"]
        for result in report["claimResults"]
        if result["status"] == "sota-qualified"
    )

    failed_mos = copy.deepcopy(results)
    failed_mos["mos_reports"][0]["metrics"][0]["ci_lower"] = 0.0
    with pytest.raises(HoldoutDecisionError, match="MOS metric failed"):
        build_q2_qualification_report(failed_mos, **arguments)

    underpowered = copy.deepcopy(results)
    underpowered["comparator_results"]["rows"] = [
        row
        for row in underpowered["comparator_results"]["rows"]
        if row["leakage_component_id"] != "component-29"
    ]
    with pytest.raises(HoldoutDecisionError, match="power requirement"):
        build_q2_qualification_report(underpowered, **arguments)

    cli_inputs = {
        "results": results,
        "candidate": fixture["raw"],
        "candidate-signature": fixture["candidate_signature"],
        "preregistration": fixture["preregistration"],
        "preregistration-signature": fixture["preregistration_signature"],
        "evaluation-authorization": fixture["evaluation_authorization"],
        "evaluation-signature": fixture["evaluation_signature"],
        "trust-policy": fixture["trust_policy"],
        "surface": fixture["surface"],
        "d1-report": fixture["detailed_reports"]["d1-calibration"],
        "design-report": fixture["detailed_reports"]["d0a-design"],
        "calibration-catalog": catalog,
        "comparator-gates": gates,
        "comparator-matrix": matrix,
        "landscape": landscape,
    }
    cli_arguments: list[str] = []
    for name, document in cli_inputs.items():
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        cli_arguments.extend([f"--{name}", str(path)])
    cli_arguments.extend(["--consumption-root", str(consumption_root)])
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    cli = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "q2-score",
            *cli_arguments,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )
    assert cli.returncode == 0, cli.stderr
    assert json.loads(cli.stdout)["kind"] == "q2-holdout"
