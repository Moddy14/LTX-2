from __future__ import annotations

import base64
import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ltx_trainer.av_eval.authorization import (
    AuthorizationError,
    build_consumption_event,
    canonical_json,
    record_consumption_event,
    record_signed_consumption_event,
    sha256_document,
    studio_canonical_json,
    validate_consumption_events,
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


def _studio_payload(document: object) -> bytes:
    encoded = json.dumps(document, ensure_ascii=False, sort_keys=True, indent=2, separators=(",", ": "))
    return f"{encoded}\n".encode()


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


def _studio_signed(document: object, *, role: str) -> tuple[dict[str, object], dict[str, object]]:
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    payload = _studio_payload(document)
    signature = {
        "schemaVersion": "ltx-studio-detached-signature.v1",
        "algorithm": "ed25519",
        "keyId": "studio-independent-key-01",
        "payloadSha256": hashlib.sha256(payload).hexdigest(),
        "signatureBase64": base64.b64encode(private_key.sign(payload)).decode(),
    }
    policy = {
        "schemaVersion": "ltx-studio-trusted-keys.v1",
        "policyId": "studio-release-policy-01",
        "keys": [
            {
                "keyId": "studio-independent-key-01",
                "algorithm": "ed25519",
                "publicKeyBase64": base64.b64encode(public_key).decode(),
                "roles": [role],
                "notBefore": _timestamp(NOW - timedelta(days=1)),
                "notAfter": _timestamp(NOW + timedelta(days=1)),
                "revokedAt": None,
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


def test_q2_accepts_the_canonical_studio_trust_and_signature_envelope() -> None:
    document = _evaluation_document()
    signature, policy = _studio_signed(document, role="evaluation-authorizer")

    assert verify_detached_signature(
        document,
        signature,
        policy,
        required_role="evaluation-authorizer",
        now=NOW,
    ) == hashlib.sha256(_studio_payload(document)).hexdigest()
    assert _validate_evaluation(document) == document


def test_studio_canonical_json_matches_json_stringify_number_semantics() -> None:
    document = {"a": [9.0, 1e-7, 1e-6, 1e20, 1e21, -0.0, 1.2345678901234567]}

    assert studio_canonical_json(document).decode() == (
        "{\n"
        '  "a": [\n'
        "    9,\n"
        "    1e-7,\n"
        "    0.000001,\n"
        "    100000000000000000000,\n"
        "    1e+21,\n"
        "    0,\n"
        "    1.2345678901234567\n"
        "  ]\n"
        "}\n"
    )


def test_python_release_check_accepts_the_studio_p4_authorization() -> None:
    document = {
        "schemaVersion": "ltx-studio-release-authorization.v1",
        "releaseDigest": DIGESTS["release"],
        "preregistrationDigest": DIGESTS["preregistration"],
        "q2ReportDigest": DIGESTS["q2"],
        "releaseEvidenceDigest": DIGESTS["evidence"],
        "rightsAttestationDigest": DIGESTS["rights"],
        "notBefore": _timestamp(NOW - timedelta(minutes=5)),
        "expiresAt": _timestamp(NOW + timedelta(hours=2)),
    }

    assert validate_release_authorization(
        document,
        now=NOW,
        release_digest=DIGESTS["release"],
        preregistration_digest=DIGESTS["preregistration"],
        q2_report_digest=DIGESTS["q2"],
        release_evidence_digest=DIGESTS["evidence"],
        rights_attestation_digest=DIGESTS["rights"],
    ) == document


def test_consumption_events_are_monotonic_write_once_and_idempotent(tmp_path: Path) -> None:
    root = tmp_path / "consumption"
    root.mkdir(mode=0o700)
    arguments = {
        "authorization_digest": DIGESTS["release"],
        "transaction_id": "q2-transaction-001",
        "nonce_sha256": DIGESTS["nonce"],
        "writer_id": "independent-q2-runner",
    }
    private_key = Ed25519PrivateKey.generate()
    public_key = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    policy = {
        "schema_version": "ltx-av-eval-trusted-keys.v1",
        "policy_id": "holdout-consumption-policy-01",
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

    def signed(event: str, occurred_at: datetime) -> dict[str, object]:
        document = build_consumption_event(event=event, occurred_at=occurred_at, **arguments)  # type: ignore[arg-type]
        return {
            "schema_version": "ltx-av-eval-detached-signature.v1",
            "algorithm": "ed25519",
            "key_id": "holdout-scorer-key-01",
            "payload_sha256": sha256_document(document),
            "signature_base64": base64.b64encode(private_key.sign(canonical_json(document))).decode(),
        }

    with pytest.raises(AuthorizationError, match="before the started"):
        record_consumption_event(root, event="consumed", occurred_at=NOW, **arguments)
    started = record_signed_consumption_event(
        root,
        event="started",
        occurred_at=NOW,
        signature=signed("started", NOW),
        trust_policy=policy,
        **arguments,
    )
    assert started.stat().st_mode & 0o777 == 0o600
    assert record_consumption_event(root, event="started", occurred_at=NOW, **arguments) == started
    consumed_at = NOW + timedelta(seconds=1)
    consumed = record_signed_consumption_event(
        root,
        event="consumed",
        occurred_at=consumed_at,
        signature=signed("consumed", consumed_at),
        trust_policy=policy,
        **arguments,
    )
    assert consumed.is_file()
    started_digest = sha256_document(
        build_consumption_event(event="started", occurred_at=NOW, **arguments),  # type: ignore[arg-type]
    )
    consumed_digest = sha256_document(
        build_consumption_event(event="consumed", occurred_at=consumed_at, **arguments),  # type: ignore[arg-type]
    )
    assert validate_consumption_events(
        root,
        complete_by=NOW + timedelta(hours=1),
        trust_policy=policy,
        now=NOW + timedelta(seconds=2),
        **arguments,
    ) == {
        "schema_version": "ltx-av-eval-holdout-consumption-report.v1",
        **arguments,
        "started_at": _timestamp(NOW),
        "consumed_at": _timestamp(NOW + timedelta(seconds=1)),
        "started_signature_digest": started_digest,
        "consumed_signature_digest": consumed_digest,
        "status": "consumed",
    }

    with pytest.raises(AuthorizationError, match="exceeded complete_by"):
        validate_consumption_events(
            root,
            complete_by=NOW,
            trust_policy=policy,
            now=NOW + timedelta(seconds=2),
            **arguments,
        )

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
