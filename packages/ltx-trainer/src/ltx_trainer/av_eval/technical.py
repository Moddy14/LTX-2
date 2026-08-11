"""Fail-closed assembly of digest-bound R0/R3 technical evidence."""

from __future__ import annotations

from typing import Any

from .authorization import studio_sha256_document
from .design import document_sha256

OBSERVATIONS_SCHEMA = "ltx-studio-technical-observations.v1"
BUNDLE_SCHEMA = "ltx-av-eval-technical-qualification-bundle.v1"
QUALIFICATION_SCHEMA = "ltx-studio-qualification-report.v1"
R0_ACTIONS = ("continue_current", "resume_current", "wait_for_successor", "yield_to_waiting_job")
BOUNDARY_POSITIONS = ("early", "middle", "late")
TECHNICAL_GATES = ("cold-canary", "playable-output", "provenance")


class TechnicalEvidenceError(ValueError):
    """Raised when raw live qualification observations cannot prove R0/R3."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise TechnicalEvidenceError(f"{context}: missing={missing}, unknown={unknown}")


def _identifier(value: object, context: str) -> str:
    if not isinstance(value, str) or not 3 <= len(value) <= 128:
        raise TechnicalEvidenceError(f"{context} must contain 3 to 128 characters")
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if any(character not in allowed for character in value):
        raise TechnicalEvidenceError(f"{context} contains unsupported characters")
    return value


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise TechnicalEvidenceError(f"{context} must be a lowercase SHA-256")
    return value


def _surface_contract(
    raw: object,
    surface_digest: str,
) -> tuple[dict[str, set[str]], set[str], dict[str, str]]:
    if not isinstance(raw, dict) or raw.get("schemaVersion") != "candidate-release-surface.v1":
        raise TechnicalEvidenceError("candidate release surface schema mismatch")
    if studio_sha256_document(raw) != surface_digest:
        raise TechnicalEvidenceError("candidate release surface digest mismatch")
    entries = raw.get("entries")
    if not isinstance(entries, list):
        raise TechnicalEvidenceError("candidate release surface entries must be a list")
    candidates: dict[str, set[str]] = {}
    cooperative_modes: set[str] = set()
    entry_modes: dict[str, str] = {}
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict) or entry.get("targetStatus") != "candidate":
            continue
        entry_id = _identifier(entry.get("id"), f"surface entry {index}.id")
        gates = entry.get("applicableGates")
        request = entry.get("request")
        cooperative = entry.get("cooperativeCheckpoint")
        if not isinstance(gates, list) or not isinstance(request, dict) or not isinstance(cooperative, bool):
            raise TechnicalEvidenceError(f"surface entry {entry_id} has an incomplete capability contract")
        if entry_id in candidates:
            raise TechnicalEvidenceError(f"candidate release surface contains duplicate entry {entry_id}")
        if any(not isinstance(gate, str) for gate in gates):
            raise TechnicalEvidenceError(f"surface entry {entry_id} has a non-string applicable gate")
        mode = _identifier(request.get("mode"), f"surface entry {entry_id}.request.mode")
        candidates[entry_id] = set(gates)
        entry_modes[entry_id] = mode
        if cooperative:
            cooperative_modes.add(mode)
    if not candidates:
        raise TechnicalEvidenceError("candidate release surface is empty")
    return candidates, cooperative_modes, entry_modes


def _validate_r0(raw: object) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TechnicalEvidenceError("r0 must be an object")
    _exact_keys(
        raw,
        {
            "actions",
            "running_transport_failure",
            "paused_transport_failure",
            "api_restart_reconciled",
            "studio_restart_reconciled",
        },
        "r0",
    )
    actions = raw["actions"]
    if not isinstance(actions, list) or tuple(actions) != R0_ACTIONS:
        raise TechnicalEvidenceError("r0 actions must exactly match the sorted four-action contract")
    expected = {
        "running_transport_failure": "checkpoint-and-exit-75",
        "paused_transport_failure": "remain-paused-and-retry",
        "api_restart_reconciled": True,
        "studio_restart_reconciled": True,
    }
    if any(raw[field] != value for field, value in expected.items()):
        raise TechnicalEvidenceError("r0 failure or restart contract did not pass")
    return {"actions": list(R0_ACTIONS), **expected}


def _validate_canaries(
    raw: object,
    *,
    candidates: dict[str, set[str]],
    release_digest: str,
) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise TechnicalEvidenceError("canaries must be a list")
    observed: list[str] = []
    job_ids: list[str] = []
    for index, row in enumerate(raw):
        if not isinstance(row, dict):
            raise TechnicalEvidenceError(f"canary {index} must be an object")
        _exact_keys(
            row,
            {
                "surface_entry_id",
                "dgx_job_id",
                "release_digest",
                "output_sha256",
                "cold_start",
                "playable",
                "provenance_verified",
            },
            f"canary {index}",
        )
        entry_id = _identifier(row["surface_entry_id"], f"canary {index}.surface_entry_id")
        observed.append(entry_id)
        job_ids.append(_identifier(row["dgx_job_id"], f"canary {entry_id}.dgx_job_id"))
        _sha256(row["output_sha256"], f"canary {entry_id}.output_sha256")
        if row["release_digest"] != release_digest or any(
            row[field] is not True for field in ("cold_start", "playable", "provenance_verified")
        ):
            raise TechnicalEvidenceError(f"canary {entry_id} did not pass its technical contract")
    if observed != sorted(candidates):
        raise TechnicalEvidenceError("canaries must exactly cover the sorted candidate surface")
    if len(job_ids) != len(set(job_ids)):
        raise TechnicalEvidenceError("canary DGX job IDs must be unique")
    return raw


def _validate_pause_resume(  # noqa: PLR0912
    raw: object,
    *,
    candidates: dict[str, set[str]],
    cooperative_modes: set[str],
    entry_modes: dict[str, str],
) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or len(raw) != 20:
        raise TechnicalEvidenceError("pause_resume must contain exactly 20 cycles")
    cycle_ids: list[str] = []
    modes: set[str] = set()
    positions: set[str] = set()
    for index, row in enumerate(raw):
        if not isinstance(row, dict):
            raise TechnicalEvidenceError(f"pause/resume cycle {index} must be an object")
        _exact_keys(
            row,
            {
                "cycle_id",
                "surface_entry_id",
                "mode",
                "boundary_position",
                "comparison_kind",
                "comparison_passed",
                "equivalence_rule_sha256",
                "checkpoint_sha256",
                "output_sha256",
                "control_output_sha256",
                "orphaned",
            },
            f"pause/resume cycle {index}",
        )
        cycle_ids.append(_identifier(row["cycle_id"], f"pause/resume cycle {index}.cycle_id"))
        entry_id = _identifier(row["surface_entry_id"], f"pause/resume cycle {index}.surface_entry_id")
        if entry_id not in candidates:
            raise TechnicalEvidenceError(f"pause/resume cycle {index} references a non-candidate entry")
        mode = _identifier(row["mode"], f"pause/resume cycle {index}.mode")
        if entry_modes[entry_id] != mode:
            raise TechnicalEvidenceError(f"pause/resume cycle {index} mode does not match its surface entry")
        modes.add(mode)
        boundary_position = _identifier(
            row["boundary_position"], f"pause/resume cycle {index}.boundary_position"
        )
        if boundary_position not in BOUNDARY_POSITIONS:
            raise TechnicalEvidenceError(f"pause/resume cycle {index} has an unknown boundary position")
        positions.add(boundary_position)
        for field in ("checkpoint_sha256", "output_sha256", "control_output_sha256"):
            _sha256(row[field], f"pause/resume cycle {index}.{field}")
        kind = row["comparison_kind"]
        if kind == "bitwise":
            if row["equivalence_rule_sha256"] is not None or row["output_sha256"] != row["control_output_sha256"]:
                raise TechnicalEvidenceError(f"pause/resume cycle {index} is not bitwise equal")
        elif kind == "registered-equivalence":
            _sha256(row["equivalence_rule_sha256"], f"pause/resume cycle {index}.equivalence_rule_sha256")
        else:
            raise TechnicalEvidenceError(f"pause/resume cycle {index} has an unknown comparison kind")
        if row["comparison_passed"] is not True or row["orphaned"] is not False:
            raise TechnicalEvidenceError(f"pause/resume cycle {index} failed")
    if cycle_ids != sorted(set(cycle_ids)):
        raise TechnicalEvidenceError("pause/resume cycle IDs must be sorted and unique")
    if modes != cooperative_modes or positions != set(BOUNDARY_POSITIONS):
        raise TechnicalEvidenceError("pause/resume cycles do not cover every cooperative mode and boundary position")
    return raw


def _validate_soak(raw: object, *, candidates: dict[str, set[str]]) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or len(raw) != 50:
        raise TechnicalEvidenceError("soak must contain exactly 50 rows")
    row_ids: list[str] = []
    covered_entries: set[str] = set()
    for index, row in enumerate(raw):
        if not isinstance(row, dict):
            raise TechnicalEvidenceError(f"soak row {index} must be an object")
        _exact_keys(
            row,
            {
                "row_id",
                "surface_entry_id",
                "expected_state",
                "actual_state",
                "playable",
                "provenance_verified",
                "output_bound",
                "lost",
                "orphaned",
                "duplicate",
                "foreign_service_actions",
                "recovery_ms",
                "recovery_slo_ms",
            },
            f"soak row {index}",
        )
        row_ids.append(_identifier(row["row_id"], f"soak row {index}.row_id"))
        entry_id = _identifier(row["surface_entry_id"], f"soak row {index}.surface_entry_id")
        covered_entries.add(entry_id)
        expected_state = _identifier(row["expected_state"], f"soak row {index}.expected_state")
        actual_state = _identifier(row["actual_state"], f"soak row {index}.actual_state")
        if (
            entry_id not in candidates
            or expected_state not in {"cancelled", "completed", "failed", "recovered"}
            or actual_state != expected_state
        ):
            raise TechnicalEvidenceError(f"soak row {index} has a surface or state mismatch")
        if any(row[field] is not False for field in ("lost", "orphaned", "duplicate")):
            raise TechnicalEvidenceError(f"soak row {index} violates a zero-tolerance job gate")
        if isinstance(row["foreign_service_actions"], bool) or row["foreign_service_actions"] != 0:
            raise TechnicalEvidenceError(f"soak row {index} touched a foreign service")
        recovery_ms, recovery_slo_ms = row["recovery_ms"], row["recovery_slo_ms"]
        if (
            isinstance(recovery_ms, bool)
            or isinstance(recovery_slo_ms, bool)
            or not isinstance(recovery_ms, int)
            or not isinstance(recovery_slo_ms, int)
            or not 0 <= recovery_ms <= recovery_slo_ms
        ):
            raise TechnicalEvidenceError(f"soak row {index} violates its recovery SLO")
        if row["expected_state"] == "completed" and any(
            row[field] is not True for field in ("playable", "provenance_verified", "output_bound")
        ):
            raise TechnicalEvidenceError(f"soak row {index} completed without valid output evidence")
    if row_ids != sorted(set(row_ids)):
        raise TechnicalEvidenceError("soak row IDs must be sorted and unique")
    if covered_entries != set(candidates):
        raise TechnicalEvidenceError("soak rows do not cover every candidate surface entry")
    return raw


def build_technical_evidence_bundle(raw: object, *, surface: object) -> dict[str, Any]:
    """Validate raw live rows and emit detailed plus unsigned Studio qualification documents."""

    if not isinstance(raw, dict):
        raise TechnicalEvidenceError("technical observations must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "release_digest",
            "preregistration_digest",
            "surface_digest",
            "producer_id",
            "runner_digest",
            "r0",
            "canaries",
            "pause_resume",
            "soak",
        },
        "technical observations",
    )
    if raw["schema_version"] != OBSERVATIONS_SCHEMA:
        raise TechnicalEvidenceError("unsupported technical observations schema")
    release_digest = _sha256(raw["release_digest"], "release_digest")
    preregistration_digest = _sha256(raw["preregistration_digest"], "preregistration_digest")
    surface_digest = _sha256(raw["surface_digest"], "surface_digest")
    producer_id = _identifier(raw["producer_id"], "producer_id")
    runner_digest = _sha256(raw["runner_digest"], "runner_digest")
    candidates, cooperative_modes, entry_modes = _surface_contract(surface, surface_digest)
    r0 = _validate_r0(raw["r0"])
    canaries = _validate_canaries(raw["canaries"], candidates=candidates, release_digest=release_digest)
    pause_resume = _validate_pause_resume(
        raw["pause_resume"],
        candidates=candidates,
        cooperative_modes=cooperative_modes,
        entry_modes=entry_modes,
    )
    soak = _validate_soak(raw["soak"], candidates=candidates)
    detailed = {
        "r0-control-plane": {
            "schema_version": "ltx-studio-r0-control-plane-evidence.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "runner_digest": runner_digest,
            **r0,
        },
        "r3-canaries": {
            "schema_version": "ltx-studio-r3-canary-evidence.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "runner_digest": runner_digest,
            "candidate_entry_count": len(canaries),
            "candidate_entry_ids": [row["surface_entry_id"] for row in canaries],
            "failures": 0,
            "observations_digest": document_sha256(canaries),
        },
        "r3-pause-resume": {
            "schema_version": "ltx-studio-r3-pause-resume-evidence.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "runner_digest": runner_digest,
            "cycles": len(pause_resume),
            "mode_families": sorted(cooperative_modes),
            "boundary_positions": list(BOUNDARY_POSITIONS),
            "equivalence_failures": 0,
            "orphaned_jobs": 0,
            "observations_digest": document_sha256(pause_resume),
        },
        "r3-soak": {
            "schema_version": "ltx-studio-r3-soak-evidence.v1",
            "verdict": "pass",
            "release_digest": release_digest,
            "runner_digest": runner_digest,
            "jobs": len(soak),
            "lost_jobs": 0,
            "orphaned_jobs": 0,
            "duplicate_jobs": 0,
            "unbound_outputs": 0,
            "foreign_service_actions": 0,
            "recovery_slo_breaches": 0,
            "observations_digest": document_sha256(soak),
        },
    }
    qualification_reports = []
    for kind in ("r0-control-plane", "r3-canaries", "r3-pause-resume", "r3-soak"):
        coverage = []
        if kind == "r3-canaries":
            coverage = [
                {
                    "surfaceEntryId": entry_id,
                    "gates": [gate for gate in TECHNICAL_GATES if gate in candidates[entry_id]],
                }
                for entry_id in sorted(candidates)
            ]
        qualification_reports.append(
            {
                "schemaVersion": QUALIFICATION_SCHEMA,
                "kind": kind,
                "releaseDigest": release_digest,
                "preregistrationDigest": preregistration_digest,
                "surfaceDigest": surface_digest,
                "producerId": producer_id,
                "producerDigest": document_sha256(detailed[kind]),
                "verdict": "pass",
                "warnings": [],
                "coverage": coverage,
                "claimResults": [],
            }
        )
    return {
        "schema_version": BUNDLE_SCHEMA,
        "runner_digest": runner_digest,
        "detailed_reports": detailed,
        "qualification_reports": qualification_reports,
    }
