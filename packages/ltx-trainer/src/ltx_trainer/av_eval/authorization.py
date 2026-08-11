"""Detached, role-bound authorizations for sealed holdout evaluation and release."""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import os
import stat
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

SHA256_LENGTH = 64
MAX_DOCUMENT_BYTES = 1024 * 1024
EVALUATION_SCHEMA = "ltx-av-eval-evaluation-authorization.v1"
RELEASE_SCHEMA = "ltx-av-eval-release-authorization.v2"
SIGNATURE_SCHEMA = "ltx-av-eval-detached-signature.v1"
TRUST_POLICY_SCHEMA = "ltx-av-eval-trusted-keys.v1"
STUDIO_RELEASE_SCHEMA = "ltx-studio-release-authorization.v1"
STUDIO_SIGNATURE_SCHEMA = "ltx-studio-detached-signature.v1"
STUDIO_TRUST_POLICY_SCHEMA = "ltx-studio-trusted-keys.v1"
CONSUMPTION_SCHEMA = "ltx-av-eval-holdout-consumption.v1"
TrustRole = Literal[
    "audit-finalizer",
    "evaluation-authorizer",
    "holdout-scorer",
    "preregistration-freezer",
    "qualification-attestor",
    "release-authorizer",
    "rights-attestor",
]


class AuthorizationError(ValueError):
    """Raised when an authorization, signature, time window, or consumption state is unsafe."""


def canonical_json(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def _javascript_number(value: float) -> str:
    if not math.isfinite(value):
        raise AuthorizationError("Studio canonical JSON rejects non-finite numbers")
    if value == 0:
        return "0"
    magnitude = abs(value)
    shortest = repr(value).lower()
    if 1e-6 <= magnitude < 1e21:
        fixed = format(Decimal(shortest), "f")
        return fixed.rstrip("0").rstrip(".") if "." in fixed else fixed
    mantissa, exponent = shortest.split("e")
    mantissa = mantissa.removesuffix(".0")
    exponent_value = int(exponent)
    exponent_text = f"+{exponent_value}" if exponent_value >= 0 else str(exponent_value)
    return f"{mantissa}e{exponent_text}"


def _studio_json_text(value: object, *, level: int = 0) -> str:  # noqa: PLR0911
    indentation = "  " * level
    child_indentation = "  " * (level + 1)
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _javascript_number(value)
    if isinstance(value, list):
        if not value:
            return "[]"
        items = [f"{child_indentation}{_studio_json_text(item, level=level + 1)}" for item in value]
        return "[\n" + ",\n".join(items) + f"\n{indentation}]"
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise AuthorizationError("Studio canonical JSON requires string object keys")
        if not value:
            return "{}"
        items = [
            f"{child_indentation}{json.dumps(key, ensure_ascii=False)}: "
            f"{_studio_json_text(value[key], level=level + 1)}"
            for key in sorted(value)
        ]
        return "{\n" + ",\n".join(items) + f"\n{indentation}}}"
    raise AuthorizationError(f"Studio canonical JSON does not support {type(value).__name__}")


def studio_canonical_json(value: object) -> bytes:
    """Match apps/ltx-studio/shared/canonicalJson.ts byte-for-byte for JSON data."""

    return f"{_studio_json_text(value)}\n".encode()


def sha256_document(value: object) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def studio_sha256_document(value: object) -> str:
    return hashlib.sha256(studio_canonical_json(value)).hexdigest()


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


def _normalize_trust_policy(policy: object) -> tuple[str, list[dict[str, Any]], dict[str, str]]:
    if not isinstance(policy, dict):
        raise AuthorizationError("trusted-key policy must be an object")
    if policy.get("schema_version") == TRUST_POLICY_SCHEMA:
        _expect_exact_keys(policy, {"schema_version", "policy_id", "keys"}, "trusted-key policy")
        fields = {
            "key_id": "key_id",
            "public_key": "public_key_base64",
            "not_before": "not_before",
            "not_after": "not_after",
            "revoked_at": "revoked_at",
        }
        policy_id = policy["policy_id"]
    elif policy.get("schemaVersion") == STUDIO_TRUST_POLICY_SCHEMA:
        _expect_exact_keys(policy, {"schemaVersion", "policyId", "keys"}, "trusted-key policy")
        fields = {
            "key_id": "keyId",
            "public_key": "publicKeyBase64",
            "not_before": "notBefore",
            "not_after": "notAfter",
            "revoked_at": "revokedAt",
        }
        policy_id = policy["policyId"]
    else:
        raise AuthorizationError("unsupported trusted-key policy schema")
    _expect_identifier(policy_id, "policy_id")
    if not isinstance(policy["keys"], list) or not policy["keys"]:
        raise AuthorizationError("trusted-key policy must contain keys")
    return policy_id, policy["keys"], fields


def _validate_trust_policy(policy: object, *, now: datetime, role: str, key_id: str) -> bytes:
    _policy_id, keys, fields = _normalize_trust_policy(policy)
    matches: list[dict[str, Any]] = []
    observed_ids: set[str] = set()
    for index, key in enumerate(keys):
        if not isinstance(key, dict):
            raise AuthorizationError(f"trusted key {index} must be an object")
        _expect_exact_keys(
            key,
            {
                fields["key_id"],
                "algorithm",
                fields["public_key"],
                "roles",
                fields["not_before"],
                fields["not_after"],
                fields["revoked_at"],
            },
            f"trusted key {index}",
        )
        current_id = _expect_identifier(key[fields["key_id"]], f"trusted key {index}.key_id")
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
    not_before = _parse_time(key[fields["not_before"]], "trusted key not_before")
    not_after = _parse_time(key[fields["not_after"]], "trusted key not_after")
    if not not_before <= now <= not_after:
        raise AuthorizationError("trusted key is outside its validity window")
    revoked_at = key[fields["revoked_at"]]
    if revoked_at is not None and _parse_time(revoked_at, "trusted key revoked_at") <= now:
        raise AuthorizationError("trusted key is revoked")
    return _decode_base64(key[fields["public_key"]], expected_bytes=32, context="trusted public key")


def _normalize_signature(signature: object) -> tuple[dict[str, Any], dict[str, str], bool]:
    if not isinstance(signature, dict):
        raise AuthorizationError("detached signature must be an object")
    if signature.get("schema_version") == SIGNATURE_SCHEMA:
        _expect_exact_keys(
            signature,
            {"schema_version", "algorithm", "key_id", "payload_sha256", "signature_base64"},
            "detached signature",
        )
        fields = {
            "key_id": "key_id",
            "payload": "payload_sha256",
            "signature": "signature_base64",
        }
        studio_dialect = False
    elif signature.get("schemaVersion") == STUDIO_SIGNATURE_SCHEMA:
        _expect_exact_keys(
            signature,
            {"schemaVersion", "algorithm", "keyId", "payloadSha256", "signatureBase64"},
            "detached signature",
        )
        fields = {
            "key_id": "keyId",
            "payload": "payloadSha256",
            "signature": "signatureBase64",
        }
        studio_dialect = True
    else:
        raise AuthorizationError("unsupported detached signature schema or algorithm")
    if signature["algorithm"] != "ed25519":
        raise AuthorizationError("unsupported detached signature schema or algorithm")
    return signature, fields, studio_dialect


def verify_detached_signature(
    document: object,
    signature: object,
    trust_policy: object,
    *,
    required_role: TrustRole,
    now: datetime,
) -> str:
    """Verify canonical document bytes against a current role-scoped Ed25519 key."""

    if now.tzinfo != UTC:
        raise AuthorizationError("verification time must be UTC")
    normalized_signature, fields, studio_dialect = _normalize_signature(signature)
    key_id = _expect_identifier(normalized_signature[fields["key_id"]], "signature key_id")
    expected_digest = _expect_sha256(normalized_signature[fields["payload"]], "signature payload_sha256")
    document_bytes = studio_canonical_json(document) if studio_dialect else canonical_json(document)
    actual_digest = hashlib.sha256(document_bytes).hexdigest()
    if actual_digest != expected_digest:
        raise AuthorizationError("detached signature does not bind this payload")
    public_key = _validate_trust_policy(trust_policy, now=now, role=required_role, key_id=key_id)
    signature_bytes = _decode_base64(
        normalized_signature[fields["signature"]],
        expected_bytes=64,
        context="signature",
    )
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
    rights_attestation_digest: str,
) -> dict[str, Any]:
    """Validate P4 bindings. This authorization is never accepted as Q2 access."""

    if not isinstance(document, dict):
        raise AuthorizationError("release authorization must be an object")
    if document.get("schema_version") == RELEASE_SCHEMA:
        fields = {
            "release_digest": "release_digest",
            "preregistration_digest": "preregistration_digest",
            "q2_report_digest": "q2_report_digest",
            "release_evidence_digest": "release_evidence_digest",
            "rights_attestation_digest": "rights_attestation_digest",
            "not_before": "not_before",
            "expires_at": "expires_at",
        }
        expected_keys = {"schema_version", *fields.values()}
    elif document.get("schemaVersion") == STUDIO_RELEASE_SCHEMA:
        fields = {
            "release_digest": "releaseDigest",
            "preregistration_digest": "preregistrationDigest",
            "q2_report_digest": "q2ReportDigest",
            "release_evidence_digest": "releaseEvidenceDigest",
            "rights_attestation_digest": "rightsAttestationDigest",
            "not_before": "notBefore",
            "expires_at": "expiresAt",
        }
        expected_keys = {"schemaVersion", *fields.values()}
    else:
        raise AuthorizationError("unsupported release authorization schema")
    _expect_exact_keys(document, expected_keys, "release authorization")
    for field, value in {
        "release_digest": release_digest,
        "preregistration_digest": preregistration_digest,
        "q2_report_digest": q2_report_digest,
        "release_evidence_digest": release_evidence_digest,
        "rights_attestation_digest": rights_attestation_digest,
    }.items():
        if document[fields[field]] != _expect_sha256(value, field):
            raise AuthorizationError(f"release authorization {field} mismatch")
    not_before = _parse_time(document[fields["not_before"]], "not_before")
    expires_at = _parse_time(document[fields["expires_at"]], "expires_at")
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
    document = build_consumption_event(
        event=event,
        authorization_digest=authorization_digest,
        transaction_id=transaction_id,
        nonce_sha256=nonce_sha256,
        occurred_at=occurred_at,
        writer_id=writer_id,
    )
    started_path = root / "started.json"
    if event == "consumed" and not started_path.is_file():
        raise AuthorizationError("holdout cannot be consumed before the started event is durable")
    if event == "consumed":
        started = _read_owner_event(started_path)
        _expect_exact_keys(started, set(document), "started consumption event")
        if started.get("schema_version") != CONSUMPTION_SCHEMA or started.get("event") != "started":
            raise AuthorizationError("started consumption event has an invalid schema or state")
        for field in ("authorization_digest", "transaction_id", "nonce_sha256", "writer_id"):
            if started.get(field) != document[field]:
                raise AuthorizationError(f"consumed event does not continue the started {field}")
        if _parse_time(started.get("occurred_at"), "started.occurred_at") > _parse_time(
            document["occurred_at"], "consumed.occurred_at"
        ):
            raise AuthorizationError("consumed event predates started event")
    path = root / f"{event}.json"
    _write_once(path, document)
    return path


def build_consumption_event(
    *,
    event: Literal["started", "consumed"],
    authorization_digest: str,
    transaction_id: str,
    nonce_sha256: str,
    occurred_at: datetime,
    writer_id: str,
) -> dict[str, Any]:
    """Build the canonical Q2 state transition payload before external signing."""

    if event not in {"started", "consumed"}:
        raise AuthorizationError("unsupported holdout consumption event")
    if occurred_at.tzinfo != UTC or occurred_at.microsecond:
        raise AuthorizationError("occurred_at must be a whole-second UTC timestamp")
    authorization_digest = _expect_sha256(authorization_digest, "authorization_digest")
    nonce_sha256 = _expect_sha256(nonce_sha256, "nonce_sha256")
    transaction_id = _expect_identifier(transaction_id, "transaction_id")
    writer_id = _expect_identifier(writer_id, "writer_id")
    occurred = _parse_time(occurred_at.strftime("%Y-%m-%dT%H:%M:%SZ"), "occurred_at")
    return {
        "schema_version": CONSUMPTION_SCHEMA,
        "event": event,
        "authorization_digest": authorization_digest,
        "transaction_id": transaction_id,
        "nonce_sha256": nonce_sha256,
        "occurred_at": occurred.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "writer_id": writer_id,
    }


def record_signed_consumption_event(
    root: Path,
    *,
    event: Literal["started", "consumed"],
    authorization_digest: str,
    transaction_id: str,
    nonce_sha256: str,
    occurred_at: datetime,
    writer_id: str,
    signature: object,
    trust_policy: object,
) -> Path:
    """Verify and durably record a holdout-scorer-signed consumption transition."""

    document = build_consumption_event(
        event=event,
        authorization_digest=authorization_digest,
        transaction_id=transaction_id,
        nonce_sha256=nonce_sha256,
        occurred_at=occurred_at,
        writer_id=writer_id,
    )
    verify_detached_signature(
        document,
        signature,
        trust_policy,
        required_role="holdout-scorer",
        now=occurred_at,
    )
    path = record_consumption_event(
        root,
        event=event,
        authorization_digest=authorization_digest,
        transaction_id=transaction_id,
        nonce_sha256=nonce_sha256,
        occurred_at=occurred_at,
        writer_id=writer_id,
    )
    if not isinstance(signature, dict):
        raise AuthorizationError("consumption signature must be an object")
    _write_once(root / f"{event}.signature.json", signature)
    return path


def validate_consumption_events(
    root: Path,
    *,
    authorization_digest: str,
    transaction_id: str,
    nonce_sha256: str,
    writer_id: str,
    complete_by: datetime,
    trust_policy: object,
    now: datetime,
) -> dict[str, Any]:
    """Validate the durable, irreversible Q2 ``started -> consumed`` state."""

    _secure_directory(root)
    expected = {
        "authorization_digest": _expect_sha256(authorization_digest, "authorization_digest"),
        "transaction_id": _expect_identifier(transaction_id, "transaction_id"),
        "nonce_sha256": _expect_sha256(nonce_sha256, "nonce_sha256"),
        "writer_id": _expect_identifier(writer_id, "writer_id"),
    }
    if complete_by.tzinfo != UTC or complete_by.microsecond:
        raise AuthorizationError("complete_by must be a whole-second UTC timestamp")
    documents: dict[str, dict[str, Any]] = {}
    signature_digests: dict[str, str] = {}
    for event in ("started", "consumed"):
        document = _read_owner_event(root / f"{event}.json")
        _expect_exact_keys(
            document,
            {
                "schema_version",
                "event",
                "authorization_digest",
                "transaction_id",
                "nonce_sha256",
                "occurred_at",
                "writer_id",
            },
            f"{event} consumption event",
        )
        if document["schema_version"] != CONSUMPTION_SCHEMA or document["event"] != event:
            raise AuthorizationError(f"{event} consumption event has an invalid schema or state")
        for field, value in expected.items():
            if document[field] != value:
                raise AuthorizationError(f"{event} consumption event {field} mismatch")
        documents[event] = document
        signature = _read_owner_event(root / f"{event}.signature.json")
        signature_digests[event] = verify_detached_signature(
            document,
            signature,
            trust_policy,
            required_role="holdout-scorer",
            now=now,
        )
    started_at = _parse_time(documents["started"]["occurred_at"], "started.occurred_at")
    consumed_at = _parse_time(documents["consumed"]["occurred_at"], "consumed.occurred_at")
    if not started_at <= consumed_at <= complete_by:
        raise AuthorizationError("holdout consumption is non-monotonic or exceeded complete_by")
    return {
        "schema_version": "ltx-av-eval-holdout-consumption-report.v1",
        "authorization_digest": expected["authorization_digest"],
        "transaction_id": expected["transaction_id"],
        "nonce_sha256": expected["nonce_sha256"],
        "writer_id": expected["writer_id"],
        "started_at": documents["started"]["occurred_at"],
        "consumed_at": documents["consumed"]["occurred_at"],
        "started_signature_digest": signature_digests["started"],
        "consumed_signature_digest": signature_digests["consumed"],
        "status": "consumed",
    }
