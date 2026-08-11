"""Fail-closed D0 contracts for sealed access and measurement reports."""

from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from .authorization import canonical_json, verify_detached_signature

ACCESS_EVENT_SCHEMA = "ltx-av-eval-access-event.v1"
ACCESS_ENVELOPE_SCHEMA = "ltx-av-eval-access-envelope.v1"
MEASUREMENT_REPORT_SCHEMA = "ltx-av-eval-measurement-report.v1"
GENESIS_DIGEST = "0" * 64
MAX_ACCESS_LOG_BYTES = 64 * 1024 * 1024
ACCESS_ACTIONS = {
    "authorization-verified",
    "holdout-opened",
    "scoring-started",
    "scoring-completed",
    "scoring-failed",
}


class ProductGovernanceError(ValueError):
    """Raised when D0 access or report evidence is incomplete or unsafe."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise ProductGovernanceError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise ProductGovernanceError(f"{context} must contain 3 to 128 characters")
    if any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-" for character in value):
        raise ProductGovernanceError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ProductGovernanceError(f"{context} must be a lowercase SHA-256")
    return value


def _timestamp(value: object, context: str) -> datetime:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ProductGovernanceError(f"{context} must be a whole-second UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00")
    except ValueError as error:
        raise ProductGovernanceError(f"{context} is invalid") from error
    if parsed.tzinfo != UTC or parsed.microsecond:
        raise ProductGovernanceError(f"{context} must be a whole-second UTC timestamp")
    return parsed


def _number(value: object, context: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ProductGovernanceError(f"{context} must be a finite number")
    return float(value)


def validate_sealed_directory(
    root: Path,
    *,
    owner_uid: int,
    owner_gid: int,
    development_uids: set[int],
) -> dict[str, Any]:
    """Prove the base POSIX ACL grants access only to the independent owner."""

    if owner_uid < 0 or owner_gid < 0 or any(uid < 0 for uid in development_uids):
        raise ProductGovernanceError("UID and GID values must be non-negative")
    if owner_uid in development_uids:
        raise ProductGovernanceError("sealed owner must not be a development UID")
    metadata = root.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
        raise ProductGovernanceError("sealed root must be a real directory")
    if metadata.st_uid != owner_uid or metadata.st_gid != owner_gid:
        raise ProductGovernanceError("sealed root owner does not match the independent scorer")
    if stat.S_IMODE(metadata.st_mode) != 0o700:
        raise ProductGovernanceError("sealed root must use mode 0700")
    if "system.posix_acl_access" in os.listxattr(root, follow_symlinks=False):
        raise ProductGovernanceError("sealed root must not contain an extended POSIX ACL")
    return {
        "status": "sealed",
        "root": str(root.resolve(strict=True)),
        "owner_uid": owner_uid,
        "owner_gid": owner_gid,
        "mode": "0700",
        "development_uids": sorted(development_uids),
    }


def _validate_access_event(raw: object, *, now: datetime | None = None) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ProductGovernanceError("access event must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "event_id",
            "actor_id",
            "actor_uid",
            "action",
            "authorization_digest",
            "holdout_digest",
            "transaction_id",
            "occurred_at",
        },
        "access event",
    )
    if raw["schema_version"] != ACCESS_EVENT_SCHEMA:
        raise ProductGovernanceError("unsupported access event schema")
    _identifier(raw["event_id"], "event_id")
    _identifier(raw["actor_id"], "actor_id")
    _identifier(raw["transaction_id"], "transaction_id")
    if not isinstance(raw["actor_uid"], int) or raw["actor_uid"] < 0:
        raise ProductGovernanceError("actor_uid must be a non-negative integer")
    if raw["action"] not in ACCESS_ACTIONS:
        raise ProductGovernanceError("access action is unsupported")
    _sha256(raw["authorization_digest"], "authorization_digest")
    _sha256(raw["holdout_digest"], "holdout_digest")
    occurred_at = _timestamp(raw["occurred_at"], "occurred_at")
    if now is not None:
        if now.tzinfo != UTC or occurred_at > now or now - occurred_at > timedelta(minutes=5):
            raise ProductGovernanceError("access event is outside the five-minute write window")
        if raw["actor_uid"] != os.geteuid():
            raise ProductGovernanceError("access event actor_uid does not match the writer process")
    return raw


def _envelope_digest(envelope: dict[str, Any]) -> str:
    core = {key: value for key, value in envelope.items() if key != "envelope_sha256"}
    return hashlib.sha256(canonical_json(core)).hexdigest()


def _validate_access_transition(envelopes: list[dict[str, Any]], event: dict[str, Any]) -> None:
    if not envelopes:
        if event["action"] != "authorization-verified":
            raise ProductGovernanceError("access log must begin with authorization-verified")
        return
    previous = envelopes[-1]["event"]
    for field in ("actor_id", "actor_uid", "authorization_digest", "holdout_digest", "transaction_id"):
        if event[field] != previous[field]:
            raise ProductGovernanceError(f"access event changes the transaction {field}")
    if _timestamp(event["occurred_at"], "occurred_at") < _timestamp(previous["occurred_at"], "occurred_at"):
        raise ProductGovernanceError("access event timestamps must be monotonic")
    allowed = {
        "authorization-verified": {"holdout-opened", "scoring-failed"},
        "holdout-opened": {"scoring-started", "scoring-failed"},
        "scoring-started": {"scoring-completed", "scoring-failed"},
        "scoring-completed": set(),
        "scoring-failed": set(),
    }
    if event["action"] not in allowed[previous["action"]]:
        raise ProductGovernanceError(f"invalid access transition: {previous['action']} -> {event['action']}")


def _parse_access_log(payload: bytes, trust_policy: object) -> list[dict[str, Any]]:
    if len(payload) > MAX_ACCESS_LOG_BYTES:
        raise ProductGovernanceError("access log exceeds its size limit")
    envelopes: list[dict[str, Any]] = []
    previous = GENESIS_DIGEST
    event_ids: set[str] = set()
    for line_number, line in enumerate(payload.splitlines(keepends=True), start=1):
        try:
            envelope = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ProductGovernanceError(f"access log line {line_number} is invalid JSON") from error
        if not isinstance(envelope, dict) or canonical_json(envelope) != line:
            raise ProductGovernanceError(f"access log line {line_number} is not canonical JSON")
        _exact_keys(
            envelope,
            {"schema_version", "sequence", "previous_sha256", "event", "signature", "envelope_sha256"},
            f"access envelope {line_number}",
        )
        if envelope["schema_version"] != ACCESS_ENVELOPE_SCHEMA or envelope["sequence"] != line_number:
            raise ProductGovernanceError(f"access envelope {line_number} has an invalid schema or sequence")
        if envelope["previous_sha256"] != previous:
            raise ProductGovernanceError(f"access envelope {line_number} breaks the hash chain")
        if envelope["envelope_sha256"] != _envelope_digest(envelope):
            raise ProductGovernanceError(f"access envelope {line_number} digest mismatch")
        event = _validate_access_event(envelope["event"])
        if event["event_id"] in event_ids:
            raise ProductGovernanceError("access log contains a duplicate event_id")
        event_ids.add(event["event_id"])
        _validate_access_transition(envelopes, event)
        verify_detached_signature(
            event,
            envelope["signature"],
            trust_policy,
            required_role="holdout-scorer",
            now=_timestamp(event["occurred_at"], "occurred_at"),
        )
        previous = envelope["envelope_sha256"]
        envelopes.append(envelope)
    return envelopes


def _read_locked_log(descriptor: int) -> bytes:
    size = os.fstat(descriptor).st_size
    if size > MAX_ACCESS_LOG_BYTES:
        raise ProductGovernanceError("access log exceeds its size limit")
    payload = os.pread(descriptor, size + 1, 0)
    if len(payload) != size:
        raise ProductGovernanceError("access log changed during locked read")
    return payload


def append_signed_access_event(
    log_path: Path,
    event: object,
    signature: object,
    trust_policy: object,
    *,
    now: datetime,
) -> str:
    """Append one externally signed access event to a durable hash chain."""

    validated_event = _validate_access_event(event, now=now)
    verify_detached_signature(
        validated_event,
        signature,
        trust_policy,
        required_role="holdout-scorer",
        now=now,
    )
    parent = log_path.parent
    validate_sealed_directory(
        parent,
        owner_uid=os.geteuid(),
        owner_gid=os.getegid(),
        development_uids=set(),
    )
    flags = os.O_RDWR | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(log_path, flags, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_nlink != 1
            or metadata.st_uid != os.geteuid()
            or metadata.st_gid != os.getegid()
            or stat.S_IMODE(metadata.st_mode) != 0o600
        ):
            raise ProductGovernanceError("access log must be an owner-only, single-link regular file")
        envelopes = _parse_access_log(_read_locked_log(descriptor), trust_policy)
        if any(item["event"]["event_id"] == validated_event["event_id"] for item in envelopes):
            raise ProductGovernanceError("access event_id already exists")
        _validate_access_transition(envelopes, validated_event)
        envelope = {
            "schema_version": ACCESS_ENVELOPE_SCHEMA,
            "sequence": len(envelopes) + 1,
            "previous_sha256": envelopes[-1]["envelope_sha256"] if envelopes else GENESIS_DIGEST,
            "event": validated_event,
            "signature": signature,
        }
        envelope["envelope_sha256"] = _envelope_digest(envelope)
        payload = canonical_json(envelope)
        if metadata.st_size + len(payload) > MAX_ACCESS_LOG_BYTES:
            raise ProductGovernanceError("access log would exceed its size limit")
        offset = 0
        while offset < len(payload):
            written = os.write(descriptor, payload[offset:])
            if written <= 0:
                raise ProductGovernanceError("access log append was incomplete")
            offset += written
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    directory_descriptor = os.open(parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)
    return envelope["envelope_sha256"]


def verify_access_log(log_path: Path, trust_policy: object) -> dict[str, Any]:
    """Verify file safety, every signature, and the complete access hash chain."""

    metadata = log_path.lstat()
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISREG(metadata.st_mode)
        or metadata.st_nlink != 1
        or stat.S_IMODE(metadata.st_mode) != 0o600
        or metadata.st_size > MAX_ACCESS_LOG_BYTES
    ):
        raise ProductGovernanceError("access log is not a safe owner-only regular file")
    descriptor = os.open(log_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        fcntl.flock(descriptor, fcntl.LOCK_SH)
        envelopes = _parse_access_log(_read_locked_log(descriptor), trust_policy)
    finally:
        os.close(descriptor)
    return {
        "status": "verified",
        "events": len(envelopes),
        "head_sha256": envelopes[-1]["envelope_sha256"] if envelopes else GENESIS_DIGEST,
    }


def _validate_report_header(
    raw: dict[str, Any],
    *,
    expected_kind: Literal["tune", "holdout"],
    dataset_digest: str,
    preregistration_digest: str,
    release_digest: str | None,
    design_digest: str,
    runner_digest: str,
    evaluator_digest: str,
    thresholds_digest: str,
) -> None:
    _exact_keys(
        raw,
        {
            "schema_version",
            "kind",
            "dataset_digest",
            "preregistration_digest",
            "release_digest",
            "design_digest",
            "runner_digest",
            "evaluator_digest",
            "thresholds_digest",
            "producer_id",
            "generated_at",
            "verdict",
            "warnings",
            "metrics",
        },
        "measurement report",
    )
    if raw["schema_version"] != MEASUREMENT_REPORT_SCHEMA or raw["kind"] != expected_kind:
        raise ProductGovernanceError("measurement report schema or kind mismatch")
    expected_digests = {
        "dataset_digest": dataset_digest,
        "preregistration_digest": preregistration_digest,
        "design_digest": design_digest,
        "runner_digest": runner_digest,
        "evaluator_digest": evaluator_digest,
        "thresholds_digest": thresholds_digest,
    }
    for field, expected in expected_digests.items():
        if raw[field] != _sha256(expected, field):
            raise ProductGovernanceError(f"measurement report {field} mismatch")
    if expected_kind == "holdout":
        if raw["release_digest"] != _sha256(release_digest, "release_digest"):
            raise ProductGovernanceError("measurement report release_digest mismatch")
    elif raw["release_digest"] is not None or release_digest is not None:
        raise ProductGovernanceError("tune reports must not bind a release")
    _identifier(raw["producer_id"], "producer_id")
    _timestamp(raw["generated_at"], "generated_at")
    if raw["verdict"] not in {"pass", "fail"}:
        raise ProductGovernanceError("measurement report verdict is invalid")
    if not isinstance(raw["warnings"], list) or any(not isinstance(item, str) for item in raw["warnings"]):
        raise ProductGovernanceError("measurement report warnings must be strings")
    if not isinstance(raw["metrics"], list) or not raw["metrics"]:
        raise ProductGovernanceError("measurement report must contain metrics")


def _validate_metric(
    metric: object,
    index: int,
    required_gates: dict[str, tuple[str, str, float]],
) -> tuple[str, str]:
    if not isinstance(metric, dict):
        raise ProductGovernanceError(f"metric {index} must be an object")
    _exact_keys(
        metric,
        {
            "metric_id",
            "estimate",
            "ci_lower",
            "ci_upper",
            "threshold",
            "direction",
            "decision_value",
            "decision",
            "independent_units",
            "clips",
            "strata_digest",
        },
        f"metric {index}",
    )
    metric_id = _identifier(metric["metric_id"], f"metric {index}.metric_id")
    if metric_id not in required_gates:
        raise ProductGovernanceError(f"measurement report contains unknown metric {metric_id}")
    estimate = _number(metric["estimate"], f"metric {metric_id}.estimate")
    lower = _number(metric["ci_lower"], f"metric {metric_id}.ci_lower")
    upper = _number(metric["ci_upper"], f"metric {metric_id}.ci_upper")
    threshold = _number(metric["threshold"], f"metric {metric_id}.threshold")
    if not lower <= estimate <= upper:
        raise ProductGovernanceError(f"metric {metric_id} has inconsistent confidence bounds")
    required_direction, required_decision_value, required_threshold = required_gates[metric_id]
    if (metric["direction"], metric["decision_value"], threshold) != (
        required_direction,
        required_decision_value,
        required_threshold,
    ):
        raise ProductGovernanceError(f"metric {metric_id} gate semantics do not match the frozen catalog")
    decision_values = {"estimate": estimate, "ci-lower": lower, "ci-upper": upper}
    if required_decision_value not in decision_values:
        raise ProductGovernanceError(f"metric {metric_id} decision_value is invalid")
    decision_value = decision_values[required_decision_value]
    if required_direction == "higher":
        expected_decision = "pass" if decision_value >= threshold else "fail"
    elif required_direction == "lower":
        expected_decision = "pass" if decision_value <= threshold else "fail"
    else:
        raise ProductGovernanceError(f"metric {metric_id} direction is invalid")
    if metric["decision"] != expected_decision:
        raise ProductGovernanceError(f"metric {metric_id} decision does not match its confidence bound")
    if (
        not isinstance(metric["independent_units"], int)
        or metric["independent_units"] < 1
        or not isinstance(metric["clips"], int)
        or metric["clips"] < metric["independent_units"]
    ):
        raise ProductGovernanceError(f"metric {metric_id} has invalid sample counts")
    _sha256(metric["strata_digest"], f"metric {metric_id}.strata_digest")
    return metric_id, expected_decision


def validate_measurement_report(
    raw: object,
    *,
    expected_kind: Literal["tune", "holdout"],
    dataset_digest: str,
    preregistration_digest: str,
    release_digest: str | None,
    design_digest: str,
    runner_digest: str,
    evaluator_digest: str,
    thresholds_digest: str,
    required_gates: dict[str, tuple[str, str, float]],
) -> dict[str, Any]:
    """Validate exact bindings and recompute every confidence-bound decision."""

    if not isinstance(raw, dict):
        raise ProductGovernanceError("measurement report must be an object")
    _validate_report_header(
        raw,
        expected_kind=expected_kind,
        dataset_digest=dataset_digest,
        preregistration_digest=preregistration_digest,
        release_digest=release_digest,
        design_digest=design_digest,
        runner_digest=runner_digest,
        evaluator_digest=evaluator_digest,
        thresholds_digest=thresholds_digest,
    )
    if not required_gates:
        raise ProductGovernanceError("required gates must not be empty")
    for metric_id, (direction, decision_value, threshold) in required_gates.items():
        _identifier(metric_id, "required metric_id")
        if direction not in {"higher", "lower"} or decision_value not in {"estimate", "ci-lower", "ci-upper"}:
            raise ProductGovernanceError(f"required gate semantics are invalid for {metric_id}")
        _number(threshold, f"required gate {metric_id}.threshold")
    validated_metrics = [_validate_metric(metric, index, required_gates) for index, metric in enumerate(raw["metrics"])]
    metric_ids = [metric_id for metric_id, _decision in validated_metrics]
    if metric_ids != sorted(set(metric_ids)):
        raise ProductGovernanceError("measurement metric IDs must be unique and sorted")
    required_metric_ids = set(required_gates)
    if set(metric_ids) != required_metric_ids:
        missing = sorted(required_metric_ids - set(metric_ids))
        unknown = sorted(set(metric_ids) - required_metric_ids)
        raise ProductGovernanceError(f"measurement metric coverage mismatch: missing={missing}, unknown={unknown}")
    decisions = [decision for _metric_id, decision in validated_metrics]
    expected_verdict = "pass" if all(decision == "pass" for decision in decisions) else "fail"
    if raw["verdict"] != expected_verdict:
        raise ProductGovernanceError("measurement verdict does not match metric decisions")
    if expected_verdict == "pass" and raw["warnings"]:
        raise ProductGovernanceError("a passing measurement report cannot contain warnings")
    return raw
