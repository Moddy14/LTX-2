"""Detached, role-bound authorizations for sealed holdout evaluation and release."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import stat
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

SHA256_LENGTH = 64
MAX_DOCUMENT_BYTES = 1024 * 1024
EVALUATION_SCHEMA = "ltx-av-eval-evaluation-authorization.v1"
RELEASE_SCHEMA = "ltx-av-eval-release-authorization.v1"
SIGNATURE_SCHEMA = "ltx-av-eval-detached-signature.v1"
TRUST_POLICY_SCHEMA = "ltx-av-eval-trusted-keys.v1"
CONSUMPTION_SCHEMA = "ltx-av-eval-holdout-consumption.v1"


class AuthorizationError(ValueError):
    """Raised when an authorization, signature, time window, or consumption state is unsafe."""


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_document(value: object) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _expect_exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    extra = sorted(value.keys() - expected)
    if missing or extra:
        raise AuthorizationError(f"{context}: missing={missing}, unknown={extra}")


def _expect_identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise AuthorizationError(f"{context} must contain 3 to 128 characters")
    if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in value):
        raise AuthorizationError(f"{context} contains unsupported characters")
    return value


def _expect_sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != SHA256_LENGTH
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise AuthorizationError(f"{context} must be a lowercase SHA-256")
    return value


def _parse_time(value: object, context: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise AuthorizationError(f"{context} must be a UTC timestamp ending in Z")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise AuthorizationError(f"{context} is not a valid timestamp") from error
    if parsed.tzinfo != UTC or parsed.microsecond != 0:
        raise AuthorizationError(f"{context} must use whole UTC seconds")
    return parsed


def _decode_base64(value: object, *, expected_bytes: int, context: str) -> bytes:
    if not isinstance(value, str):
        raise AuthorizationError(f"{context} must be base64 text")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error) as error:
        raise AuthorizationError(f"{context} is not canonical base64") from error
    if len(decoded) != expected_bytes or base64.b64encode(decoded).decode() != value:
        raise AuthorizationError(f"{context} has the wrong size or non-canonical encoding")
    return decoded


def _validate_trust_policy(policy: object, *, now: datetime, role: str, key_id: str) -> bytes:
    if not isinstance(policy, dict):
        raise AuthorizationError("trusted-key policy must be an object")
    _expect_exact_keys(policy, {"schema_version", "policy_id", "keys"}, "trusted-key policy")
    if policy["schema_version"] != TRUST_POLICY_SCHEMA:
        raise AuthorizationError("unsupported trusted-key policy schema")
    _expect_identifier(policy["policy_id"], "policy_id")
    if not isinstance(policy["keys"], list) or not policy["keys"]:
        raise AuthorizationError("trusted-key policy must contain keys")
    matches: list[dict[str, Any]] = []
    observed_ids: set[str] = set()
    for index, key in enumerate(policy["keys"]):
        if not isinstance(key, dict):
            raise AuthorizationError(f"trusted key {index} must be an object")
        _expect_exact_keys(
            key,
            {"key_id", "algorithm", "public_key_base64", "roles", "not_before", "not_after", "revoked_at"},
            f"trusted key {index}",
        )
        current_id = _expect_identifier(key["key_id"], f"trusted key {index}.key_id")
        if current_id in observed_ids:
            raise AuthorizationError("trusted-key policy contains a duplicate key id")
        observed_ids.add(current_id)
        if current_id == key_id:
            matches.append(key)
    if len(matches) != 1:
        raise AuthorizationError("signature key is not uniquely trusted")
    key = matches[0]
    if key["algorithm"] != "ed25519":
        raise AuthorizationError("trusted key algorithm must be ed25519")
    if not isinstance(key["roles"], list) or role not in key["roles"] or len(set(key["roles"])) != len(key["roles"]):
        raise AuthorizationError("trusted key does not hold the required unique role")
    not_before = _parse_time(key["not_before"], "trusted key not_before")
    not_after = _parse_time(key["not_after"], "trusted key not_after")
    if not not_before <= now <= not_after:
        raise AuthorizationError("trusted key is outside its validity window")
    if key["revoked_at"] is not None and _parse_time(key["revoked_at"], "trusted key revoked_at") <= now:
        raise AuthorizationError("trusted key is revoked")
    return _decode_base64(key["public_key_base64"], expected_bytes=32, context="trusted public key")


def verify_detached_signature(
    document: object,
    signature: object,
    trust_policy: object,
    *,
    required_role: Literal["evaluation-authorizer", "release-authorizer"],
    now: datetime,
) -> str:
    """Verify canonical document bytes against a current role-scoped Ed25519 key."""

    if now.tzinfo != UTC:
        raise AuthorizationError("verification time must be UTC")
    if not isinstance(signature, dict):
        raise AuthorizationError("detached signature must be an object")
    _expect_exact_keys(
        signature,
        {"schema_version", "algorithm", "key_id", "payload_sha256", "signature_base64"},
        "detached signature",
    )
    if signature["schema_version"] != SIGNATURE_SCHEMA or signature["algorithm"] != "ed25519":
        raise AuthorizationError("unsupported detached signature schema or algorithm")
    key_id = _expect_identifier(signature["key_id"], "signature key_id")
    expected_digest = _expect_sha256(signature["payload_sha256"], "signature payload_sha256")
    document_bytes = canonical_json(document)
    actual_digest = hashlib.sha256(document_bytes).hexdigest()
    if actual_digest != expected_digest:
        raise AuthorizationError("detached signature does not bind this payload")
    public_key = _validate_trust_policy(trust_policy, now=now, role=required_role, key_id=key_id)
    signature_bytes = _decode_base64(signature["signature_base64"], expected_bytes=64, context="signature")
    try:
        Ed25519PublicKey.from_public_bytes(public_key).verify(signature_bytes, document_bytes)
    except InvalidSignature as error:
        raise AuthorizationError("detached signature is invalid") from error
    return actual_digest


def validate_evaluation_authorization(
    document: object,
    *,
    now: datetime,
    release_digest: str,
    preregistration_digest: str,
    holdout_digest: str,
    q2_runner_digest: str,
    transaction_id: str,
    nonce_sha256: str,
    started: bool,
) -> dict[str, Any]:
    """Validate exact Q2 bindings and the start/resume/deadline time contract."""

    if not isinstance(document, dict):
        raise AuthorizationError("evaluation authorization must be an object")
    if document.get("schema_version") != EVALUATION_SCHEMA:
        raise AuthorizationError("unsupported evaluation authorization schema")
    _expect_exact_keys(
        document,
        {
            "schema_version",
            "release_digest",
            "preregistration_digest",
            "holdout_digest",
            "q2_runner_digest",
            "transaction_id",
            "nonce_sha256",
            "not_before",
            "start_by",
            "complete_by",
            "recovery_policy",
        },
        "evaluation authorization",
    )
    expected = {
        "release_digest": release_digest,
        "preregistration_digest": preregistration_digest,
        "holdout_digest": holdout_digest,
        "q2_runner_digest": q2_runner_digest,
        "nonce_sha256": nonce_sha256,
    }
    for field, value in expected.items():
        if document[field] != _expect_sha256(value, field):
            raise AuthorizationError(f"evaluation authorization {field} mismatch")
    if document["transaction_id"] != _expect_identifier(transaction_id, "transaction_id"):
        raise AuthorizationError("evaluation authorization transaction_id mismatch")
    if document["recovery_policy"] != "same-transaction-and-nonce-resume-until-complete-by.v1":
        raise AuthorizationError("unsupported evaluation recovery policy")
    not_before = _parse_time(document["not_before"], "not_before")
    start_by = _parse_time(document["start_by"], "start_by")
    complete_by = _parse_time(document["complete_by"], "complete_by")
    if not not_before <= start_by < complete_by:
        raise AuthorizationError("evaluation authorization time window is inconsistent")
    if now.tzinfo != UTC or now < not_before:
        raise AuthorizationError("evaluation authorization is not active")
    if not started and now > start_by:
        raise AuthorizationError("evaluation authorization start deadline has passed")
    if now > complete_by:
        raise AuthorizationError("evaluation authorization completion deadline has passed")
    return document


def validate_release_authorization(
    document: object,
    *,
    now: datetime,
    release_digest: str,
    preregistration_digest: str,
    q2_report_digest: str,
    release_evidence_digest: str,
) -> dict[str, Any]:
    """Validate P4 bindings. This authorization is never accepted as Q2 access."""

    if not isinstance(document, dict):
        raise AuthorizationError("release authorization must be an object")
    if document.get("schema_version") != RELEASE_SCHEMA:
        raise AuthorizationError("unsupported release authorization schema")
    _expect_exact_keys(
        document,
        {
            "schema_version",
            "release_digest",
            "preregistration_digest",
            "q2_report_digest",
            "release_evidence_digest",
            "not_before",
            "expires_at",
        },
        "release authorization",
    )
    for field, value in {
        "release_digest": release_digest,
        "preregistration_digest": preregistration_digest,
        "q2_report_digest": q2_report_digest,
        "release_evidence_digest": release_evidence_digest,
    }.items():
        if document[field] != _expect_sha256(value, field):
            raise AuthorizationError(f"release authorization {field} mismatch")
    not_before = _parse_time(document["not_before"], "not_before")
    expires_at = _parse_time(document["expires_at"], "expires_at")
    if now.tzinfo != UTC or not not_before <= now <= expires_at:
        raise AuthorizationError("release authorization is outside its validity window")
    return document


def _secure_directory(root: Path) -> None:
    metadata = root.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise AuthorizationError("consumption root must be a real directory")
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o700:
        raise AuthorizationError("consumption root must be owner-only mode 0700")


def _write_once(path: Path, document: dict[str, Any]) -> None:
    payload = canonical_json(document)
    if len(payload) > MAX_DOCUMENT_BYTES:
        raise AuthorizationError("consumption document exceeds its size limit")
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    except FileExistsError:
        try:
            metadata = path.lstat()
            if (
                stat.S_ISLNK(metadata.st_mode)
                or not stat.S_ISREG(metadata.st_mode)
                or metadata.st_uid != os.geteuid()
                or stat.S_IMODE(metadata.st_mode) != 0o600
            ):
                raise AuthorizationError(f"existing consumption event is not an owner-only regular file: {path.name}")
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                existing = os.read(descriptor, MAX_DOCUMENT_BYTES + 1)
                after = os.fstat(descriptor)
            finally:
                os.close(descriptor)
        except OSError as error:
            raise AuthorizationError(f"existing consumption event is unsafe: {path.name}") from error
        if after.st_ino != metadata.st_ino or after.st_dev != metadata.st_dev or existing != payload:
            raise AuthorizationError(f"consumption event already exists with different content: {path.name}") from None
        return
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


def _read_owner_event(path: Path) -> dict[str, Any]:
    try:
        metadata = path.lstat()
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_size > MAX_DOCUMENT_BYTES
        ):
            raise AuthorizationError(f"consumption event is not an owner-only regular file: {path.name}")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            payload = os.read(descriptor, MAX_DOCUMENT_BYTES + 1)
            after = os.fstat(descriptor)
        finally:
            os.close(descriptor)
    except OSError as error:
        raise AuthorizationError(f"consumption event is unsafe: {path.name}") from error
    if after.st_ino != metadata.st_ino or after.st_dev != metadata.st_dev or after.st_size != len(payload):
        raise AuthorizationError(f"consumption event changed while reading: {path.name}")
    try:
        document = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise AuthorizationError(f"consumption event is not canonical JSON: {path.name}") from error
    if not isinstance(document, dict) or canonical_json(document) != payload:
        raise AuthorizationError(f"consumption event is not canonical JSON: {path.name}")
    return document


def record_consumption_event(
    root: Path,
    *,
    event: Literal["started", "consumed"],
    authorization_digest: str,
    transaction_id: str,
    nonce_sha256: str,
    occurred_at: datetime,
    writer_id: str,
) -> Path:
    """Persist monotonic started -> consumed events using immutable O_EXCL files."""

    _secure_directory(root)
    authorization_digest = _expect_sha256(authorization_digest, "authorization_digest")
    nonce_sha256 = _expect_sha256(nonce_sha256, "nonce_sha256")
    transaction_id = _expect_identifier(transaction_id, "transaction_id")
    writer_id = _expect_identifier(writer_id, "writer_id")
    occurred = _parse_time(occurred_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"), "occurred_at")
    started_path = root / "started.json"
    if event == "consumed" and not started_path.is_file():
        raise AuthorizationError("holdout cannot be consumed before the started event is durable")
    document = {
        "schema_version": CONSUMPTION_SCHEMA,
        "event": event,
        "authorization_digest": authorization_digest,
        "transaction_id": transaction_id,
        "nonce_sha256": nonce_sha256,
        "occurred_at": occurred.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "writer_id": writer_id,
    }
    if event == "consumed":
        started = _read_owner_event(started_path)
        _expect_exact_keys(started, set(document), "started consumption event")
        if started.get("schema_version") != CONSUMPTION_SCHEMA or started.get("event") != "started":
            raise AuthorizationError("started consumption event has an invalid schema or state")
        for field in ("authorization_digest", "transaction_id", "nonce_sha256", "writer_id"):
            if started.get(field) != document[field]:
                raise AuthorizationError(f"consumed event does not continue the started {field}")
        if _parse_time(started.get("occurred_at"), "started.occurred_at") > occurred:
            raise AuthorizationError("consumed event predates started event")
    path = root / f"{event}.json"
    _write_once(path, document)
    return path
