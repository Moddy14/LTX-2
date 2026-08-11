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

from ltx_trainer.av_eval.authorization import studio_canonical_json, studio_sha256_document
from ltx_trainer.av_eval.design import document_sha256
from ltx_trainer.av_eval.freeze_preflight import FreezePreflightError, build_f0_preflight_report

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PREREGISTRATION_PATH = (
    REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "preregistration.v2.json"
)
NOW = datetime(2026, 8, 11, 12, 0, tzinfo=UTC)
TARGETS = [
    "reference-video-redubbing.native-distilled",
    "reference-video-redubbing.official-comfy-hq",
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


def _timestamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _key() -> tuple[Ed25519PrivateKey, str]:
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return private, base64.b64encode(public).decode()


def _fixture(
    *,
    now: datetime = NOW,
    q1_sota_status: str = "anchor-pilot-pass",
    key_valid_hours: int = 48,
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
    surface_digest = studio_sha256_document(surface)

    design_digest = "7" * 64
    calibration_digest = "8" * 64
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
        },
        "d1-calibration": {
            "schema_version": "ltx-av-eval-complete-d1-report.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "preregistration_digest": preregistration_digest,
            "design_digest": design_digest,
            "dataset_digest": calibration_digest,
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
    }
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
    rights = {
        "schemaVersion": "ltx-studio-rights-attestation.v1",
        "releaseDigest": release_digest,
        "surfaceDigest": surface_digest,
        "evidenceCatalogDigest": "9" * 64,
        "policyVersion": "ltx-studio-release-rights.v1",
        "validAt": _timestamp(now - timedelta(hours=1)),
        "expiresAt": _timestamp(now + timedelta(hours=48)),
        "revocationState": "clear",
        "evidenceIds": ["rights.ltx-core"],
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
                {"surfaceEntryId": entry["id"], "gates": ownership} for entry in surface["entries"]
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


def test_complete_f0_preflight_binds_the_single_q2_authorization() -> None:
    fixture = _fixture()
    first = build_f0_preflight_report(**fixture)
    second = build_f0_preflight_report(**copy.deepcopy(fixture))

    assert first == second
    assert first["status"] == "f0-pass-ready-for-q2"
    assert first["q2_authorized"] is True
    assert first["production_authorized"] is False
    assert first["target_sota_claim_ids"] == TARGETS


def test_f0_rejects_rights_that_expire_during_q2() -> None:
    fixture = _fixture()
    fixture["rights_attestation"]["expiresAt"] = _timestamp(NOW + timedelta(hours=4))
    with pytest.raises(FreezePreflightError, match="rights window"):
        build_f0_preflight_report(**fixture)

    short_key_window = _fixture(key_valid_hours=4)
    with pytest.raises(FreezePreflightError, match="signing key expires"):
        build_f0_preflight_report(**short_key_window)


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


def test_f0_cli_emits_only_a_non_production_preflight(tmp_path: Path) -> None:
    fixture = _fixture(now=datetime.now(UTC).replace(microsecond=0))
    argument_names = {
        "candidate": "raw",
        "candidate-signature": "candidate_signature",
        "preregistration": "preregistration",
        "preregistration-signature": "preregistration_signature",
        "rights-attestation": "rights_attestation",
        "rights-signature": "rights_signature",
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
