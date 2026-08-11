from __future__ import annotations

import base64
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ltx_trainer.av_eval.authorization import (
    AuthorizationError,
    canonical_json,
    record_consumption_event,
    sha256_document,
    validate_evaluation_authorization,
    validate_release_authorization,
    verify_detached_signature,
)

DIGESTS = {
    name: str(index) * 64
    for index, name in enumerate(
        ("release", "preregistration", "holdout", "runner", "nonce", "q2", "evidence", "rights"),
        start=1,
    )
}
NOW = datetime(2026, 8, 11, 12, 0, tzinfo=UTC)


def _timestamp(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def _evaluation_document() -> dict[str, object]:
    return {
        "schema_version": "ltx-av-eval-evaluation-authorization.v1",
        "release_digest": DIGESTS["release"],
        "preregistration_digest": DIGESTS["preregistration"],
        "holdout_digest": DIGESTS["holdout"],
        "q2_runner_digest": DIGESTS["runner"],
        "transaction_id": "q2-transaction-001",
        "nonce_sha256": DIGESTS["nonce"],
        "not_before": _timestamp(NOW - timedelta(minutes=5)),
        "start_by": _timestamp(NOW + timedelta(hours=2)),
        "complete_by": _timestamp(NOW + timedelta(hours=30)),
        "recovery_policy": "same-transaction-and-nonce-resume-until-complete-by.v1",
    }


def _release_document() -> dict[str, object]:
    return {
        "schema_version": "ltx-av-eval-release-authorization.v2",
        "release_digest": DIGESTS["release"],
        "preregistration_digest": DIGESTS["preregistration"],
        "q2_report_digest": DIGESTS["q2"],
        "release_evidence_digest": DIGESTS["evidence"],
        "rights_attestation_digest": DIGESTS["rights"],
        "not_before": _timestamp(NOW - timedelta(minutes=5)),
        "expires_at": _timestamp(NOW + timedelta(hours=2)),
    }


def _signed(document: object, *, role: str = "evaluation-authorizer") -> tuple[dict[str, object], dict[str, object]]:
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    signature = {
        "schema_version": "ltx-av-eval-detached-signature.v1",
        "algorithm": "ed25519",
        "key_id": "independent-key-01",
        "payload_sha256": sha256_document(document),
        "signature_base64": base64.b64encode(private_key.sign(canonical_json(document))).decode(),
    }
    policy = {
        "schema_version": "ltx-av-eval-trusted-keys.v1",
        "policy_id": "holdout-policy-01",
        "keys": [
            {
                "key_id": "independent-key-01",
                "algorithm": "ed25519",
                "public_key_base64": base64.b64encode(public_key).decode(),
                "roles": [role],
                "not_before": _timestamp(NOW - timedelta(days=1)),
                "not_after": _timestamp(NOW + timedelta(days=1)),
                "revoked_at": None,
            }
        ],
    }
    return signature, policy


def _validate_evaluation(document: object, *, now: datetime = NOW, started: bool = False) -> dict[str, object]:
    return validate_evaluation_authorization(
        document,
        now=now,
        release_digest=DIGESTS["release"],
        preregistration_digest=DIGESTS["preregistration"],
        holdout_digest=DIGESTS["holdout"],
        q2_runner_digest=DIGESTS["runner"],
        transaction_id="q2-transaction-001",
        nonce_sha256=DIGESTS["nonce"],
        started=started,
    )


def test_evaluation_authorization_is_detached_signed_and_exactly_bound() -> None:
    document = _evaluation_document()
    signature, policy = _signed(document)

    assert verify_detached_signature(
        document,
        signature,
        policy,
        required_role="evaluation-authorizer",
        now=NOW,
    ) == sha256_document(document)
    assert _validate_evaluation(document) == document

    tampered = {**document, "holdout_digest": "f" * 64}
    with pytest.raises(AuthorizationError, match="does not bind"):
        verify_detached_signature(
            tampered,
            signature,
            policy,
            required_role="evaluation-authorizer",
            now=NOW,
        )


def test_authorizer_role_and_revocation_are_fail_closed() -> None:
    document = _evaluation_document()
    signature, wrong_role = _signed(document, role="release-authorizer")
    with pytest.raises(AuthorizationError, match="required unique role"):
        verify_detached_signature(
            document,
            signature,
            wrong_role,
            required_role="evaluation-authorizer",
            now=NOW,
        )

    signature, revoked = _signed(document)
    revoked["keys"][0]["revoked_at"] = _timestamp(NOW - timedelta(seconds=1))  # type: ignore[index]
    with pytest.raises(AuthorizationError, match="revoked"):
        verify_detached_signature(
            document,
            signature,
            revoked,
            required_role="evaluation-authorizer",
            now=NOW,
        )


def test_evaluation_time_contract_distinguishes_start_resume_and_deadline() -> None:
    document = _evaluation_document()
    start_by = datetime.fromisoformat(str(document["start_by"]).replace("Z", "+00:00"))
    complete_by = datetime.fromisoformat(str(document["complete_by"]).replace("Z", "+00:00"))

    with pytest.raises(AuthorizationError, match="start deadline"):
        _validate_evaluation(document, now=start_by + timedelta(seconds=1), started=False)
    assert _validate_evaluation(document, now=start_by + timedelta(seconds=1), started=True) == document
    with pytest.raises(AuthorizationError, match="completion deadline"):
        _validate_evaluation(document, now=complete_by + timedelta(seconds=1), started=True)


def test_release_authorization_is_a_different_schema_and_binding() -> None:
    document = _release_document()
    assert (
        validate_release_authorization(
            document,
            now=NOW,
            release_digest=DIGESTS["release"],
            preregistration_digest=DIGESTS["preregistration"],
            q2_report_digest=DIGESTS["q2"],
            release_evidence_digest=DIGESTS["evidence"],
            rights_attestation_digest=DIGESTS["rights"],
        )
        == document
    )
    with pytest.raises(AuthorizationError, match="unsupported evaluation"):
        _validate_evaluation(document)


def test_consumption_events_are_monotonic_write_once_and_idempotent(tmp_path: Path) -> None:
    root = tmp_path / "consumption"
    root.mkdir(mode=0o700)
    arguments = {
        "authorization_digest": DIGESTS["release"],
        "transaction_id": "q2-transaction-001",
        "nonce_sha256": DIGESTS["nonce"],
        "writer_id": "independent-q2-runner",
    }

    with pytest.raises(AuthorizationError, match="before the started"):
        record_consumption_event(root, event="consumed", occurred_at=NOW, **arguments)
    started = record_consumption_event(root, event="started", occurred_at=NOW, **arguments)
    assert started.stat().st_mode & 0o777 == 0o600
    assert record_consumption_event(root, event="started", occurred_at=NOW, **arguments) == started
    consumed = record_consumption_event(
        root,
        event="consumed",
        occurred_at=NOW + timedelta(seconds=1),
        **arguments,
    )
    assert consumed.is_file()

    with pytest.raises(AuthorizationError, match="different content"):
        record_consumption_event(
            root,
            event="consumed",
            occurred_at=NOW + timedelta(seconds=2),
            **arguments,
        )


def test_consumption_resume_cannot_change_transaction_nonce_or_writer(tmp_path: Path) -> None:
    root = tmp_path / "consumption"
    root.mkdir(mode=0o700)
    record_consumption_event(
        root,
        event="started",
        authorization_digest=DIGESTS["release"],
        transaction_id="q2-transaction-001",
        nonce_sha256=DIGESTS["nonce"],
        occurred_at=NOW,
        writer_id="independent-q2-runner",
    )
    with pytest.raises(AuthorizationError, match="started transaction_id"):
        record_consumption_event(
            root,
            event="consumed",
            authorization_digest=DIGESTS["release"],
            transaction_id="q2-transaction-002",
            nonce_sha256=DIGESTS["nonce"],
            occurred_at=NOW + timedelta(seconds=1),
            writer_id="independent-q2-runner",
        )

    root.chmod(0o750)
    with pytest.raises(AuthorizationError, match="0700"):
        record_consumption_event(
            root,
            event="started",
            authorization_digest=DIGESTS["release"],
            transaction_id="q2-transaction-001",
            nonce_sha256=DIGESTS["nonce"],
            occurred_at=NOW,
            writer_id="independent-q2-runner",
        )
