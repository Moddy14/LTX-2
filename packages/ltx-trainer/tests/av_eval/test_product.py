from __future__ import annotations

import base64
import copy
import json
import os
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ltx_trainer.av_eval import (
    ProductGovernanceError,
    append_signed_access_event,
    validate_measurement_report,
    validate_sealed_directory,
    verify_access_log,
)
from ltx_trainer.av_eval.authorization import canonical_json, sha256_document

NOW = datetime(2026, 8, 11, 14, 0, tzinfo=UTC)
DIGESTS = dict(
    zip(
        ["dataset", "prereg", "release", "design", "runner", "evaluator", "thresholds", "strata", "auth", "holdout"],
        [character * 64 for character in "123456789a"],
        strict=True,
    )
)


def _timestamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _signing_material() -> tuple[Ed25519PrivateKey, dict[str, object]]:
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    policy = {
        "schema_version": "ltx-av-eval-trusted-keys.v1",
        "policy_id": "holdout-policy-01",
        "keys": [
            {
                "key_id": "holdout-scorer-key-01",
                "algorithm": "ed25519",
                "public_key_base64": base64.b64encode(public_key).decode(),
                "roles": ["holdout-scorer"],
                "not_before": _timestamp(NOW - timedelta(days=1)),
                "not_after": _timestamp(NOW + timedelta(days=1)),
                "revoked_at": None,
            }
        ],
    }
    return private_key, policy


def _event(event_id: str, action: str) -> dict[str, object]:
    return {
        "schema_version": "ltx-av-eval-access-event.v1",
        "event_id": event_id,
        "actor_id": "independent-scorer-01",
        "actor_uid": os.geteuid(),
        "action": action,
        "authorization_digest": DIGESTS["auth"],
        "holdout_digest": DIGESTS["holdout"],
        "transaction_id": "q2-transaction-001",
        "occurred_at": _timestamp(NOW),
    }


def _signature(private_key: Ed25519PrivateKey, document: object) -> dict[str, object]:
    return {
        "schema_version": "ltx-av-eval-detached-signature.v1",
        "algorithm": "ed25519",
        "key_id": "holdout-scorer-key-01",
        "payload_sha256": sha256_document(document),
        "signature_base64": base64.b64encode(private_key.sign(canonical_json(document))).decode(),
    }


def _report(kind: str = "holdout") -> dict[str, object]:
    return {
        "schema_version": "ltx-av-eval-measurement-report.v1",
        "kind": kind,
        "dataset_digest": DIGESTS["dataset"],
        "preregistration_digest": DIGESTS["prereg"],
        "release_digest": DIGESTS["release"] if kind == "holdout" else None,
        "design_digest": DIGESTS["design"],
        "runner_digest": DIGESTS["runner"],
        "evaluator_digest": DIGESTS["evaluator"],
        "thresholds_digest": DIGESTS["thresholds"],
        "producer_id": "independent-scorer-01",
        "generated_at": _timestamp(NOW),
        "verdict": "pass",
        "warnings": [],
        "metrics": [
            {
                "metric_id": "artifact-far",
                "estimate": 0.004,
                "ci_lower": 0.001,
                "ci_upper": 0.009,
                "threshold": 0.01,
                "direction": "lower",
                "decision": "pass",
                "independent_units": 40,
                "clips": 120,
                "strata_digest": DIGESTS["strata"],
            },
            {
                "metric_id": "identity-similarity",
                "estimate": 0.91,
                "ci_lower": 0.89,
                "ci_upper": 0.93,
                "threshold": 0.88,
                "direction": "higher",
                "decision": "pass",
                "independent_units": 40,
                "clips": 120,
                "strata_digest": DIGESTS["strata"],
            },
        ],
    }


def _validate_report(report: object, kind: str = "holdout") -> dict[str, object]:
    return validate_measurement_report(
        report,
        expected_kind=kind,  # type: ignore[arg-type]
        dataset_digest=DIGESTS["dataset"],
        preregistration_digest=DIGESTS["prereg"],
        release_digest=DIGESTS["release"] if kind == "holdout" else None,
        design_digest=DIGESTS["design"],
        runner_digest=DIGESTS["runner"],
        evaluator_digest=DIGESTS["evaluator"],
        thresholds_digest=DIGESTS["thresholds"],
        required_metric_ids={"artifact-far", "identity-similarity"},
    )


def test_sealed_directory_requires_an_independent_owner_only_acl(tmp_path: Path) -> None:
    root = tmp_path / "sealed"
    root.mkdir(mode=0o700)
    report = validate_sealed_directory(
        root,
        owner_uid=os.geteuid(),
        owner_gid=os.getegid(),
        development_uids={os.geteuid() + 1},
    )
    assert report["status"] == "sealed"

    with pytest.raises(ProductGovernanceError, match="development UID"):
        validate_sealed_directory(
            root,
            owner_uid=os.geteuid(),
            owner_gid=os.getegid(),
            development_uids={os.geteuid()},
        )
    root.chmod(0o750)
    with pytest.raises(ProductGovernanceError, match="0700"):
        validate_sealed_directory(
            root,
            owner_uid=os.geteuid(),
            owner_gid=os.getegid(),
            development_uids=set(),
        )


def test_signed_access_log_is_durable_ordered_and_tamper_evident(tmp_path: Path) -> None:
    root = tmp_path / "audit"
    root.mkdir(mode=0o700)
    log_path = root / "access.jsonl"
    private_key, policy = _signing_material()
    first = _event("event-001", "authorization-verified")
    second = _event("event-002", "holdout-opened")

    first_digest = append_signed_access_event(log_path, first, _signature(private_key, first), policy, now=NOW)
    second_digest = append_signed_access_event(log_path, second, _signature(private_key, second), policy, now=NOW)

    report = verify_access_log(log_path, policy)
    assert report == {"status": "verified", "events": 2, "head_sha256": second_digest}
    assert first_digest != second_digest
    lines = log_path.read_text(encoding="utf-8").splitlines()
    tampered = json.loads(lines[0])
    tampered["event"]["action"] = "scoring-completed"
    lines[0] = json.dumps(tampered, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    log_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    with pytest.raises(ProductGovernanceError, match="digest mismatch"):
        verify_access_log(log_path, policy)


def test_access_log_rejects_skipped_states_and_transaction_changes(tmp_path: Path) -> None:
    root = tmp_path / "audit"
    root.mkdir(mode=0o700)
    log_path = root / "access.jsonl"
    private_key, policy = _signing_material()
    first = _event("event-001", "authorization-verified")
    append_signed_access_event(log_path, first, _signature(private_key, first), policy, now=NOW)

    skipped = _event("event-002", "scoring-completed")
    with pytest.raises(ProductGovernanceError, match="invalid access transition"):
        append_signed_access_event(log_path, skipped, _signature(private_key, skipped), policy, now=NOW)

    changed = _event("event-003", "holdout-opened")
    changed["transaction_id"] = "q2-transaction-002"
    with pytest.raises(ProductGovernanceError, match="changes the transaction"):
        append_signed_access_event(log_path, changed, _signature(private_key, changed), policy, now=NOW)


def test_measurement_report_recomputes_confidence_bound_decisions() -> None:
    report = _report()
    assert _validate_report(report) == report

    misleading = copy.deepcopy(report)
    misleading["metrics"][0]["ci_upper"] = 0.02  # type: ignore[index]
    with pytest.raises(ProductGovernanceError, match="decision does not match"):
        _validate_report(misleading)

    wrong_release = copy.deepcopy(report)
    wrong_release["release_digest"] = "f" * 64
    with pytest.raises(ProductGovernanceError, match="release_digest mismatch"):
        _validate_report(wrong_release)


def test_tune_report_cannot_bind_a_release_or_hide_a_failed_metric() -> None:
    report = _report("tune")
    assert _validate_report(report, "tune") == report

    failed = copy.deepcopy(report)
    failed["metrics"][1]["ci_lower"] = 0.8  # type: ignore[index]
    failed["metrics"][1]["decision"] = "fail"  # type: ignore[index]
    with pytest.raises(ProductGovernanceError, match="verdict does not match"):
        _validate_report(failed, "tune")


def test_measurement_report_cannot_pass_with_omitted_required_metrics() -> None:
    report = _report()
    report["metrics"] = report["metrics"][:1]  # type: ignore[index]
    with pytest.raises(ProductGovernanceError, match="coverage mismatch"):
        _validate_report(report)
