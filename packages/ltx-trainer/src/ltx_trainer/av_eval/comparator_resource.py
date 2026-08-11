"""Fail-closed resource-fit evidence for external Q1 comparator arms."""

from __future__ import annotations

import math
from typing import Any

from .design import document_sha256

PROFILE_SCHEMA = "ltx-av-eval-comparator-resource-profile.v1"
REPORT_SCHEMA = "ltx-av-eval-comparator-resource-report.v1"
LANDSCAPE_SCHEMA = "ltx-av-eval-anchor-landscape.v1"
REQUIRED_RUNS = 3


class ComparatorResourceError(ValueError):
    """Raised when comparator resource evidence is malformed or unbound."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise ComparatorResourceError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise ComparatorResourceError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise ComparatorResourceError(f"{context} contains unsupported characters")
    return value


def _text(value: object, context: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 128 or any(ord(character) < 32 for character in value):
        raise ComparatorResourceError(f"{context} must be a printable string of at most 128 characters")
    return value


def _sha256(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ComparatorResourceError(f"{context} must be a lowercase SHA-256")
    return value


def _revision(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 40
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise ComparatorResourceError(f"{context} must be a lowercase 40-character content revision")
    return value


def _positive_int(value: object, context: str, *, allow_zero: bool = False) -> int:
    minimum = 0 if allow_zero else 1
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        qualifier = "non-negative" if allow_zero else "positive"
        raise ComparatorResourceError(f"{context} must be a {qualifier} integer")
    return value


def _number(value: object, context: str, *, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ComparatorResourceError(f"{context} must be a finite number")
    result = float(value)
    if result < minimum:
        raise ComparatorResourceError(f"{context} must be at least {minimum}")
    return result


def _candidate(landscape: object, candidate_id: str, claim_id: str) -> dict[str, Any]:
    if not isinstance(landscape, dict) or landscape.get("schema_version") != LANDSCAPE_SCHEMA:
        raise ComparatorResourceError("anchor landscape schema mismatch")
    candidates = landscape.get("candidates")
    if not isinstance(candidates, list):
        raise ComparatorResourceError("anchor landscape candidates must be a list")
    matches = [item for item in candidates if isinstance(item, dict) and item.get("candidate_id") == candidate_id]
    if len(matches) != 1:
        raise ComparatorResourceError("resource profile candidate must occur exactly once in the anchor landscape")
    candidate = matches[0]
    compatible_claim_ids = candidate.get("compatible_claim_ids")
    if not isinstance(compatible_claim_ids, list) or claim_id not in compatible_claim_ids:
        raise ComparatorResourceError("resource profile claim is not input-compatible in the anchor landscape")
    return candidate


def _hardware(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ComparatorResourceError("hardware must be an object")
    _exact_keys(
        raw,
        {"inventory_sha256", "gpu_model", "gpu_total_memory_bytes", "driver_version", "cuda_version"},
        "hardware",
    )
    return {
        "inventory_sha256": _sha256(raw["inventory_sha256"], "hardware.inventory_sha256"),
        "gpu_model": _text(raw["gpu_model"], "hardware.gpu_model"),
        "gpu_total_memory_bytes": _positive_int(
            raw["gpu_total_memory_bytes"], "hardware.gpu_total_memory_bytes"
        ),
        "driver_version": _text(raw["driver_version"], "hardware.driver_version"),
        "cuda_version": _text(raw["cuda_version"], "hardware.cuda_version"),
    }


def _limits(raw: object, *, total_memory: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ComparatorResourceError("limits must be an object")
    _exact_keys(
        raw,
        {
            "runs",
            "max_peak_gpu_memory_bytes",
            "min_free_gpu_memory_bytes_after_peak",
            "max_wall_time_seconds",
            "max_gpu_temperature_c",
        },
        "limits",
    )
    runs = _positive_int(raw["runs"], "limits.runs")
    if runs != REQUIRED_RUNS:
        raise ComparatorResourceError(f"limits.runs must be exactly {REQUIRED_RUNS}")
    peak = _positive_int(raw["max_peak_gpu_memory_bytes"], "limits.max_peak_gpu_memory_bytes")
    headroom = _positive_int(
        raw["min_free_gpu_memory_bytes_after_peak"], "limits.min_free_gpu_memory_bytes_after_peak"
    )
    if peak + headroom > total_memory:
        raise ComparatorResourceError("resource limits exceed total GPU memory")
    wall_time = _number(raw["max_wall_time_seconds"], "limits.max_wall_time_seconds", minimum=0.001)
    temperature = _number(raw["max_gpu_temperature_c"], "limits.max_gpu_temperature_c", minimum=1.0)
    if temperature > 95:
        raise ComparatorResourceError("limits.max_gpu_temperature_c cannot exceed 95")
    return {
        "runs": runs,
        "max_peak_gpu_memory_bytes": peak,
        "min_free_gpu_memory_bytes_after_peak": headroom,
        "max_wall_time_seconds": wall_time,
        "max_gpu_temperature_c": temperature,
    }


def _observation(  # noqa: PLR0912
    raw: object,
    *,
    index: int,
    input_digest: str,
    total_memory: int,
    limits: dict[str, Any],
) -> tuple[dict[str, Any], list[str]]:
    if not isinstance(raw, dict):
        raise ComparatorResourceError(f"observation {index} must be an object")
    _exact_keys(
        raw,
        {
            "run_id",
            "dgx_job_id",
            "orchestrator_evidence_sha256",
            "input_bundle_digest",
            "output_sha256",
            "provenance_sha256",
            "telemetry_sha256",
            "status",
            "cold_start",
            "offline_mode",
            "orchestrator_admitted",
            "single_gpu",
            "playable",
            "provenance_verified",
            "foreign_service_actions",
            "orphaned",
            "peak_gpu_memory_bytes",
            "wall_time_seconds",
            "max_gpu_temperature_c",
        },
        f"observation {index}",
    )
    run_id = _identifier(raw["run_id"], f"observation {index}.run_id")
    _identifier(raw["dgx_job_id"], f"observation {run_id}.dgx_job_id")
    for field in ("orchestrator_evidence_sha256", "telemetry_sha256"):
        _sha256(raw[field], f"observation {run_id}.{field}")
    if _sha256(raw["input_bundle_digest"], f"observation {run_id}.input_bundle_digest") != input_digest:
        raise ComparatorResourceError(f"observation {run_id} input bundle drifted")
    status = raw["status"]
    if status not in {"completed", "failed"}:
        raise ComparatorResourceError(f"observation {run_id}.status is unsupported")
    output = _sha256(raw["output_sha256"], f"observation {run_id}.output_sha256", nullable=True)
    provenance = _sha256(raw["provenance_sha256"], f"observation {run_id}.provenance_sha256", nullable=True)
    if status == "completed" and (output is None or provenance is None):
        raise ComparatorResourceError(f"completed observation {run_id} needs output and provenance digests")
    for field in (
        "cold_start",
        "offline_mode",
        "orchestrator_admitted",
        "single_gpu",
        "playable",
        "provenance_verified",
        "orphaned",
    ):
        if not isinstance(raw[field], bool):
            raise ComparatorResourceError(f"observation {run_id}.{field} must be boolean")
    foreign_actions = _positive_int(
        raw["foreign_service_actions"], f"observation {run_id}.foreign_service_actions", allow_zero=True
    )
    peak = _positive_int(raw["peak_gpu_memory_bytes"], f"observation {run_id}.peak_gpu_memory_bytes", allow_zero=True)
    if peak > total_memory:
        raise ComparatorResourceError(f"observation {run_id} peak memory exceeds the declared GPU")
    wall_time = _number(raw["wall_time_seconds"], f"observation {run_id}.wall_time_seconds", minimum=0.001)
    temperature = _number(raw["max_gpu_temperature_c"], f"observation {run_id}.max_gpu_temperature_c", minimum=1.0)
    blockers: list[str] = []
    expected_true = (
        "cold_start",
        "offline_mode",
        "orchestrator_admitted",
        "single_gpu",
        "playable",
        "provenance_verified",
    )
    if status != "completed":
        blockers.append(f"run-failed:{run_id}")
    blockers.extend(f"run-contract-failed:{run_id}:{field}" for field in expected_true if raw[field] is not True)
    if raw["orphaned"] is not False:
        blockers.append(f"run-orphaned:{run_id}")
    if foreign_actions:
        blockers.append(f"foreign-service-actions:{run_id}")
    if peak > limits["max_peak_gpu_memory_bytes"]:
        blockers.append(f"peak-memory-limit:{run_id}")
    if total_memory - peak < limits["min_free_gpu_memory_bytes_after_peak"]:
        blockers.append(f"memory-headroom-limit:{run_id}")
    if wall_time > limits["max_wall_time_seconds"]:
        blockers.append(f"wall-time-limit:{run_id}")
    if temperature > limits["max_gpu_temperature_c"]:
        blockers.append(f"temperature-limit:{run_id}")
    return dict(raw), blockers


def build_comparator_resource_report(raw: object, *, landscape: object) -> dict[str, Any]:
    """Bind three cold, offline, orchestrator-admitted runs to one external arm."""

    if not isinstance(raw, dict):
        raise ComparatorResourceError("comparator resource profile must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "candidate_id",
            "claim_id",
            "code_revision",
            "weights_revision",
            "runner_digest",
            "launch_manifest_digest",
            "input_bundle_digest",
            "normalization_digest",
            "measurement_policy_digest",
            "hardware",
            "limits",
            "observations",
        },
        "comparator resource profile",
    )
    if raw["schema_version"] != PROFILE_SCHEMA:
        raise ComparatorResourceError("unsupported comparator resource profile schema")
    candidate_id = _identifier(raw["candidate_id"], "candidate_id")
    claim_id = _identifier(raw["claim_id"], "claim_id")
    candidate = _candidate(landscape, candidate_id, claim_id)
    code_revision = _revision(raw["code_revision"], "code_revision")
    weights_revision = _revision(raw["weights_revision"], "weights_revision")
    if code_revision != candidate.get("code_revision") or weights_revision != candidate.get("weights_revision"):
        raise ComparatorResourceError("resource profile revisions do not match the anchor landscape")
    for field in (
        "runner_digest",
        "launch_manifest_digest",
        "input_bundle_digest",
        "normalization_digest",
        "measurement_policy_digest",
    ):
        _sha256(raw[field], field)
    hardware = _hardware(raw["hardware"])
    limits = _limits(raw["limits"], total_memory=hardware["gpu_total_memory_bytes"])
    observations = raw["observations"]
    if not isinstance(observations, list) or len(observations) != REQUIRED_RUNS:
        raise ComparatorResourceError(f"observations must contain exactly {REQUIRED_RUNS} attempted runs")
    validated: list[dict[str, Any]] = []
    blockers: list[str] = []
    for index, observation in enumerate(observations):
        row, row_blockers = _observation(
            observation,
            index=index,
            input_digest=raw["input_bundle_digest"],
            total_memory=hardware["gpu_total_memory_bytes"],
            limits=limits,
        )
        validated.append(row)
        blockers.extend(row_blockers)
    run_ids = [row["run_id"] for row in validated]
    job_ids = [row["dgx_job_id"] for row in validated]
    if run_ids != sorted(set(run_ids)):
        raise ComparatorResourceError("resource-profile run IDs must be sorted and unique")
    if len(job_ids) != len(set(job_ids)):
        raise ComparatorResourceError("resource-profile DGX job IDs must be unique")
    blockers = sorted(set(blockers))
    return {
        "schema_version": REPORT_SCHEMA,
        "status": "resource-fit-pass" if not blockers else "resource-fit-fail",
        "blockers": blockers,
        "profile_digest": document_sha256(raw),
        "landscape_digest": document_sha256(landscape),
        "candidate_id": candidate_id,
        "claim_id": claim_id,
        "code_revision": code_revision,
        "weights_revision": weights_revision,
        "hardware_inventory_sha256": hardware["inventory_sha256"],
        "runs": len(validated),
        "max_peak_gpu_memory_bytes": max(row["peak_gpu_memory_bytes"] for row in validated),
        "max_wall_time_seconds": max(float(row["wall_time_seconds"]) for row in validated),
        "max_gpu_temperature_c": max(float(row["max_gpu_temperature_c"]) for row in validated),
        "telemetry_digest": document_sha256(
            [
                {
                    "run_id": row["run_id"],
                    "orchestrator_evidence_sha256": row["orchestrator_evidence_sha256"],
                    "telemetry_sha256": row["telemetry_sha256"],
                }
                for row in validated
            ]
        ),
    }
