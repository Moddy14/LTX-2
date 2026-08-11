"""D0 ready-to-freeze package validation."""

from __future__ import annotations

import copy
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .authorization import AuthorizationError, validate_trust_policy_bindings
from .design import document_sha256
from .product import ProductGovernanceError, validate_sealed_directory, verify_access_log

READINESS_SCHEMA = "ltx-av-eval-product-readiness.v1"
READINESS_REPORT_SCHEMA = "ltx-av-eval-product-readiness-report.v1"
GENESIS_DIGEST = "0" * 64
EVIDENCE_IDS = {
    "blind-scorer-runner",
    "dataset-freeze",
    "dataset-rights-attestation",
    "design-pilot-binding",
    "design-power-report",
    "empty-access-log-report",
    "sealed-acl-report",
    "static-surface-rights-catalog",
    "trusted-key-policy",
    "tune-report",
}
ARTIFACT_IDS = {
    "baseline-matrix",
    "evaluation-runner",
    "hyperparameter-search-space",
    "initial-weights",
    "model-recipe",
    "prompt-set",
    "rating-protocol",
    "training-runner",
}
ROLE_IDS = {
    "evaluation-authorizer",
    "holdout-scorer",
    "release-authorizer",
}
LIVE_OPERATIONAL_EVIDENCE_IDS = {
    "empty-access-log-report",
    "sealed-acl-report",
    "trusted-key-policy",
}
LIVE_OPERATIONAL_MAX_AGE = timedelta(minutes=5)


class ReadinessError(ValueError):
    """Raised when a D0 package could bypass product-governance evidence."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise ReadinessError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise ReadinessError(f"{context} must contain 3 to 128 characters")
    if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in value):
        raise ReadinessError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ReadinessError(f"{context} must be a lowercase SHA-256")
    return value


def _timestamp(value: object, context: str, *, nullable: bool = False) -> datetime | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ReadinessError(f"{context} must be a whole-second UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ReadinessError(f"{context} is invalid") from error
    if parsed.tzinfo != UTC or parsed.microsecond:
        raise ReadinessError(f"{context} must be a whole-second UTC timestamp")
    return parsed


def _validate_digest_entries(raw: object, expected_ids: set[str], context: str) -> list[str]:
    if not isinstance(raw, list):
        raise ReadinessError(f"{context} must be a list")
    identifiers: list[str] = []
    blockers: list[str] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ReadinessError(f"{context} {index} must be an object")
        _exact_keys(entry, {"artifact_id", "sha256"}, f"{context} {index}")
        artifact_id = _identifier(entry["artifact_id"], f"{context} {index}.artifact_id")
        assert artifact_id is not None
        identifiers.append(artifact_id)
        if _sha256(entry["sha256"], f"{context} {artifact_id}.sha256", nullable=True) is None:
            blockers.append(f"digest-missing:{artifact_id}")
    if identifiers != sorted(expected_ids):
        raise ReadinessError(f"{context} must exactly match its sorted required inventory")
    return blockers


def _validate_roles(raw: object) -> list[str]:
    if not isinstance(raw, list):
        raise ReadinessError("role_bindings must be a list")
    role_ids: list[str] = []
    key_ids: list[str] = []
    blockers: list[str] = []
    for index, binding in enumerate(raw):
        if not isinstance(binding, dict):
            raise ReadinessError(f"role binding {index} must be an object")
        _exact_keys(binding, {"role", "key_id"}, f"role binding {index}")
        role = _identifier(binding["role"], f"role binding {index}.role")
        assert role is not None
        role_ids.append(role)
        key_id = _identifier(binding["key_id"], f"role binding {role}.key_id", nullable=True)
        if key_id is None:
            blockers.append(f"role-key-missing:{role}")
        else:
            key_ids.append(key_id)
    if role_ids != sorted(ROLE_IDS):
        raise ReadinessError("role bindings must exactly match the sorted independent roles")
    if len(key_ids) != len(set(key_ids)):
        raise ReadinessError("independent roles must use distinct key IDs")
    return blockers


def _validate_principals(raw: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    scorer_uid = raw["blind_scorer_uid"]
    scorer_gid = raw["blind_scorer_gid"]
    if scorer_uid is None:
        blockers.append("blind-scorer-uid-missing")
    elif isinstance(scorer_uid, bool) or not isinstance(scorer_uid, int) or scorer_uid < 0:
        raise ReadinessError("blind_scorer_uid must be a non-negative integer")
    if scorer_gid is None:
        blockers.append("blind-scorer-gid-missing")
    elif isinstance(scorer_gid, bool) or not isinstance(scorer_gid, int) or scorer_gid < 0:
        raise ReadinessError("blind_scorer_gid must be a non-negative integer")
    development_uids = raw["development_uids"]
    if not isinstance(development_uids, list) or any(
        isinstance(uid, bool) or not isinstance(uid, int) or uid < 0 for uid in development_uids
    ):
        raise ReadinessError("development_uids must be non-negative integers")
    if not development_uids:
        blockers.append("development-uids-missing")
    elif development_uids != sorted(set(development_uids)):
        raise ReadinessError("development_uids must be unique and sorted")
    if scorer_uid is not None and scorer_uid in development_uids:
        raise ReadinessError("blind scorer UID must not be a development UID")
    return blockers


def _validate_statuses(raw: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    for field, expected in (
        ("acl_status", "sealed"),
        ("access_log_status", "verified"),
        ("rights_revocation_state", "clear"),
        ("tune_report_verdict", "pass"),
    ):
        if raw[field] is None:
            blockers.append(f"{field.replace('_', '-')}-missing")
        elif raw[field] != expected:
            raise ReadinessError(f"{field} must equal {expected}")
    return blockers


def _validate_empty_access_log(raw: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    events = raw["access_log_events"]
    if events is None:
        blockers.append("access-log-events-missing")
    elif events != 0:
        raise ReadinessError("D0 requires an untouched holdout access log")
    head = _sha256(raw["access_log_head_sha256"], "access_log_head_sha256", nullable=True)
    if head is None:
        blockers.append("access-log-head-missing")
    elif head != GENESIS_DIGEST:
        raise ReadinessError("D0 access log must still be at its genesis digest")
    return blockers


def _validate_rights_window(raw: dict[str, Any], *, now: datetime) -> list[str]:
    blockers: list[str] = []
    valid_at = _timestamp(raw["rights_valid_at"], "rights_valid_at", nullable=True)
    expires_at = _timestamp(raw["rights_expires_at"], "rights_expires_at", nullable=True)
    if valid_at is None:
        blockers.append("rights-valid-at-missing")
    if expires_at is None:
        blockers.append("rights-expires-at-missing")
    if valid_at is not None and expires_at is not None and not valid_at <= now < expires_at:
        raise ReadinessError("rights attestation is not current")
    return blockers


def _validate_operational(raw: object, *, now: datetime) -> list[str]:
    if not isinstance(raw, dict):
        raise ReadinessError("operational evidence must be an object")
    _exact_keys(
        raw,
        {
            "blind_scorer_uid",
            "blind_scorer_gid",
            "development_uids",
            "acl_status",
            "access_log_status",
            "access_log_events",
            "access_log_head_sha256",
            "rights_valid_at",
            "rights_expires_at",
            "rights_revocation_state",
            "tune_report_verdict",
        },
        "operational evidence",
    )
    blockers = _validate_principals(raw)
    blockers.extend(_validate_statuses(raw))
    blockers.extend(_validate_empty_access_log(raw))
    blockers.extend(_validate_rights_window(raw, now=now))
    return blockers


def _utc_text(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def build_operational_readiness_evidence(
    raw: object,
    *,
    holdout_root: Path,
    access_log_root: Path,
    access_log_path: Path,
    trust_policy: object,
    now: datetime,
) -> dict[str, Any]:
    """Inspect the live D0 boundary and emit hash-ready operational evidence."""

    if now.tzinfo != UTC or now.microsecond:
        raise ReadinessError("operational evidence time must use whole UTC seconds")
    if not isinstance(raw, dict) or raw.get("schema_version") != READINESS_SCHEMA:
        raise ReadinessError("operational evidence requires a product-readiness package")
    operational = raw.get("operational")
    role_bindings = raw.get("role_bindings")
    if not isinstance(operational, dict):
        raise ReadinessError("operational evidence must be an object")
    _exact_keys(
        operational,
        {
            "blind_scorer_uid",
            "blind_scorer_gid",
            "development_uids",
            "acl_status",
            "access_log_status",
            "access_log_events",
            "access_log_head_sha256",
            "rights_valid_at",
            "rights_expires_at",
            "rights_revocation_state",
            "tune_report_verdict",
        },
        "operational evidence",
    )
    principal_blockers = _validate_principals(operational)
    role_blockers = _validate_roles(role_bindings)
    if principal_blockers or role_blockers:
        raise ReadinessError(
            f"operational identity is incomplete: {sorted([*principal_blockers, *role_blockers])}"
        )
    scorer_uid = operational["blind_scorer_uid"]
    scorer_gid = operational["blind_scorer_gid"]
    development_uids = set(operational["development_uids"])
    assert isinstance(scorer_uid, int)
    assert isinstance(scorer_gid, int)
    assert isinstance(role_bindings, list)
    bindings = {binding["role"]: binding["key_id"] for binding in role_bindings}
    try:
        holdout_acl = validate_sealed_directory(
            holdout_root,
            owner_uid=scorer_uid,
            owner_gid=scorer_gid,
            development_uids=development_uids,
        )
        log_acl = validate_sealed_directory(
            access_log_root,
            owner_uid=scorer_uid,
            owner_gid=scorer_gid,
            development_uids=development_uids,
        )
        resolved_holdout = Path(holdout_acl["root"])
        resolved_log_root = Path(log_acl["root"])
        resolved_log = access_log_path.resolve(strict=True)
        if (
            resolved_holdout == resolved_log_root
            or resolved_holdout.is_relative_to(resolved_log_root)
            or resolved_log_root.is_relative_to(resolved_holdout)
        ):
            raise ReadinessError("holdout and access-log roots must be separate directories")
        if resolved_log.parent != resolved_log_root:
            raise ReadinessError("access log must be a direct child of its sealed log root")
        log_metadata = resolved_log.lstat()
        if (
            stat.S_ISLNK(log_metadata.st_mode)
            or not stat.S_ISREG(log_metadata.st_mode)
            or log_metadata.st_uid != scorer_uid
            or log_metadata.st_gid != scorer_gid
        ):
            raise ReadinessError("access log owner must match the independent scorer")
        access_log = verify_access_log(resolved_log, trust_policy)
        policy_digest = validate_trust_policy_bindings(trust_policy, bindings, now=now)
    except (AuthorizationError, OSError, ProductGovernanceError) as error:
        raise ReadinessError(f"live operational evidence rejected: {error}") from error
    if access_log != {"status": "verified", "events": 0, "head_sha256": GENESIS_DIGEST}:
        raise ReadinessError("D0 operational evidence requires an untouched access log")
    checked_at = _utc_text(now)
    policy_document = copy.deepcopy(trust_policy)
    documents = {
        "empty-access-log-report": {
            "schema_version": "ltx-av-eval-empty-access-log-report.v1",
            "checked_at": checked_at,
            "log_path": str(resolved_log),
            **access_log,
        },
        "sealed-acl-report": {
            "schema_version": "ltx-av-eval-sealed-acl-report.v1",
            "checked_at": checked_at,
            "holdout_root": holdout_acl,
            "access_log_root": log_acl,
        },
        "trusted-key-policy": policy_document,
    }
    return {
        "schema_version": "ltx-av-eval-operational-readiness-evidence.v1",
        "checked_at": checked_at,
        "evidence": [
            {"artifact_id": artifact_id, "sha256": document_sha256(document)}
            for artifact_id, document in sorted(documents.items())
        ],
        "documents": documents,
        "operational_updates": {
            "blind_scorer_uid": scorer_uid,
            "blind_scorer_gid": scorer_gid,
            "development_uids": sorted(development_uids),
            "acl_status": "sealed",
            "access_log_status": "verified",
            "access_log_events": 0,
            "access_log_head_sha256": GENESIS_DIGEST,
        },
        "trusted_key_policy_digest": policy_digest,
    }


def _validate_live_inventory(raw: dict[str, Any], evidence: dict[str, Any]) -> dict[str, Any]:
    documents = evidence["documents"]
    if not isinstance(documents, dict) or set(documents) != LIVE_OPERATIONAL_EVIDENCE_IDS:
        raise ReadinessError("live operational documents must match the exact required inventory")
    rows = evidence["evidence"]
    if not isinstance(rows, list):
        raise ReadinessError("live operational evidence inventory must be a list")
    observed_ids: list[str] = []
    observed_digests: dict[str, str] = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ReadinessError(f"live operational evidence row {index} must be an object")
        _exact_keys(row, {"artifact_id", "sha256"}, f"live operational evidence row {index}")
        artifact_id = _identifier(row["artifact_id"], f"live operational evidence row {index}.artifact_id")
        assert artifact_id is not None
        digest = _sha256(row["sha256"], f"live operational evidence {artifact_id}.sha256")
        assert digest is not None
        observed_ids.append(artifact_id)
        observed_digests[artifact_id] = digest
    if observed_ids != sorted(LIVE_OPERATIONAL_EVIDENCE_IDS):
        raise ReadinessError("live operational evidence rows must be sorted and complete")
    package_digests = {entry["artifact_id"]: entry["sha256"] for entry in raw["evidence"]}
    for artifact_id, document in documents.items():
        digest = document_sha256(document)
        if observed_digests[artifact_id] != digest or package_digests[artifact_id] != digest:
            raise ReadinessError(f"live operational evidence digest mismatch: {artifact_id}")
    return documents


def _validate_empty_access_proof(access: object, *, checked_at: str) -> Path:
    if not isinstance(access, dict):
        raise ReadinessError("empty access-log report must be an object")
    _exact_keys(
        access,
        {"schema_version", "checked_at", "log_path", "status", "events", "head_sha256"},
        "empty access-log report",
    )
    if (
        access["schema_version"] != "ltx-av-eval-empty-access-log-report.v1"
        or access["checked_at"] != checked_at
        or access["status"] != "verified"
        or access["events"] != 0
        or access["head_sha256"] != GENESIS_DIGEST
        or not isinstance(access["log_path"], str)
        or not Path(access["log_path"]).is_absolute()
    ):
        raise ReadinessError("empty access-log report is not a current genesis proof")
    return Path(access["log_path"])


def _validate_live_updates(operational: dict[str, Any], updates: object) -> None:
    expected_update_fields = {
        "blind_scorer_uid",
        "blind_scorer_gid",
        "development_uids",
        "acl_status",
        "access_log_status",
        "access_log_events",
        "access_log_head_sha256",
    }
    if not isinstance(updates, dict):
        raise ReadinessError("live operational updates must be an object")
    _exact_keys(updates, expected_update_fields, "live operational updates")
    if any(updates[field] != operational[field] for field in expected_update_fields):
        raise ReadinessError("live operational updates do not match the readiness package")


def _validate_sealed_acl_proof(
    acl: object, operational: dict[str, Any], *, checked_at: str
) -> tuple[Path, Path]:
    if not isinstance(acl, dict):
        raise ReadinessError("sealed ACL report must be an object")
    _exact_keys(
        acl,
        {"schema_version", "checked_at", "holdout_root", "access_log_root"},
        "sealed ACL report",
    )
    if (
        acl["schema_version"] != "ltx-av-eval-sealed-acl-report.v1"
        or acl["checked_at"] != checked_at
    ):
        raise ReadinessError("sealed ACL report schema or timestamp mismatch")
    root_paths: list[Path] = []
    for field in ("holdout_root", "access_log_root"):
        root = acl[field]
        if not isinstance(root, dict):
            raise ReadinessError(f"sealed ACL report {field} must be an object")
        _exact_keys(
            root,
            {"status", "root", "owner_uid", "owner_gid", "mode", "development_uids"},
            f"sealed ACL report {field}",
        )
        if (
            root["status"] != "sealed"
            or root["mode"] != "0700"
            or root["owner_uid"] != operational["blind_scorer_uid"]
            or root["owner_gid"] != operational["blind_scorer_gid"]
            or root["development_uids"] != operational["development_uids"]
            or not isinstance(root["root"], str)
            or not Path(root["root"]).is_absolute()
        ):
            raise ReadinessError(f"sealed ACL report {field} does not match the independent boundary")
        root_paths.append(Path(root["root"]))
    if (
        root_paths[0] == root_paths[1]
        or root_paths[0].is_relative_to(root_paths[1])
        or root_paths[1].is_relative_to(root_paths[0])
    ):
        raise ReadinessError("sealed holdout and audit roots are not separate")
    return root_paths[0], root_paths[1]


def _validate_live_operational_binding(
    raw: dict[str, Any],
    evidence: object,
    *,
    now: datetime,
) -> str:
    if not isinstance(evidence, dict):
        raise ReadinessError("ready-to-freeze requires live operational evidence")
    _exact_keys(
        evidence,
        {
            "schema_version",
            "checked_at",
            "evidence",
            "documents",
            "operational_updates",
            "trusted_key_policy_digest",
        },
        "live operational evidence",
    )
    if evidence["schema_version"] != "ltx-av-eval-operational-readiness-evidence.v1":
        raise ReadinessError("unsupported live operational evidence schema")
    checked_at = _timestamp(evidence["checked_at"], "live operational evidence.checked_at")
    assert checked_at is not None
    if checked_at > now or now - checked_at > LIVE_OPERATIONAL_MAX_AGE:
        raise ReadinessError("live operational evidence is stale or from the future")
    documents = _validate_live_inventory(raw, evidence)
    operational = raw["operational"]
    access_log_path = _validate_empty_access_proof(
        documents["empty-access-log-report"], checked_at=evidence["checked_at"]
    )
    _validate_live_updates(operational, evidence["operational_updates"])
    _holdout_root, access_log_root = _validate_sealed_acl_proof(
        documents["sealed-acl-report"], operational, checked_at=evidence["checked_at"]
    )
    if access_log_path.parent != access_log_root:
        raise ReadinessError("bound access log is not a direct child of the sealed audit root")
    policy_digest = document_sha256(documents["trusted-key-policy"])
    if evidence["trusted_key_policy_digest"] != policy_digest:
        raise ReadinessError("trusted-key policy digest mismatch")
    return document_sha256(evidence)


def build_product_readiness_report(
    raw: object,
    *,
    now: datetime,
    operational_evidence: object | None = None,
) -> dict[str, Any]:
    """Validate the complete D0 package without granting F0/Q2/P4 authority."""

    if now.tzinfo != UTC:
        raise ReadinessError("readiness time must be UTC")
    if not isinstance(raw, dict):
        raise ReadinessError("readiness package must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "package_id",
            "evidence",
            "artifact_commitments",
            "role_bindings",
            "operational",
        },
        "readiness package",
    )
    if raw["schema_version"] != READINESS_SCHEMA or raw["status"] not in {"draft", "ready-to-freeze"}:
        raise ReadinessError("unsupported readiness schema or status")
    _identifier(raw["package_id"], "package_id")
    blockers = _validate_digest_entries(raw["evidence"], EVIDENCE_IDS, "evidence")
    blockers.extend(_validate_digest_entries(raw["artifact_commitments"], ARTIFACT_IDS, "artifact commitments"))
    blockers.extend(_validate_roles(raw["role_bindings"]))
    blockers.extend(_validate_operational(raw["operational"], now=now))
    blockers = sorted(blockers)
    if raw["status"] == "ready-to-freeze" and blockers:
        raise ReadinessError(f"ready-to-freeze package is incomplete: {blockers}")
    live_operational_digest = None
    if raw["status"] == "ready-to-freeze":
        live_operational_digest = _validate_live_operational_binding(raw, operational_evidence, now=now)
    return {
        "schema_version": READINESS_REPORT_SCHEMA,
        "package_digest": document_sha256(raw),
        "status": "ready-to-freeze" if not blockers else "hold",
        "blockers": blockers,
        "evidence_inventory_digest": document_sha256(raw["evidence"]),
        "artifact_commitments_digest": document_sha256(raw["artifact_commitments"]),
        "role_bindings_digest": document_sha256(raw["role_bindings"]),
        "operational_evidence_digest": document_sha256(raw["operational"]),
        "live_operational_evidence_digest": live_operational_digest,
    }
