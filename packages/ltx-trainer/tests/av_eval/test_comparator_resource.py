from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from ltx_trainer.av_eval import ComparatorResourceError, build_comparator_resource_report, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
LANDSCAPE_PATH = (
    REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "anchor-landscape.v1.json"
)


def _landscape() -> dict[str, Any]:
    return json.loads(LANDSCAPE_PATH.read_text(encoding="utf-8"))


def _profile() -> dict[str, Any]:
    landscape = _landscape()
    candidate = landscape["candidates"][0]
    gibibyte = 1024**3
    observations = []
    for index in range(3):
        marker = str(index + 1)
        observations.append(
            {
                "run_id": f"cold-{index + 1:02d}",
                "dgx_job_id": f"dgx-comparator-{index + 1:02d}",
                "orchestrator_evidence_sha256": marker * 64,
                "input_bundle_digest": "6" * 64,
                "output_sha256": "7" * 64,
                "provenance_sha256": "8" * 64,
                "telemetry_sha256": "9" * 64,
                "status": "completed",
                "cold_start": True,
                "offline_mode": True,
                "orchestrator_admitted": True,
                "single_gpu": True,
                "playable": True,
                "provenance_verified": True,
                "foreign_service_actions": 0,
                "orphaned": False,
                "peak_gpu_memory_bytes": 80 * gibibyte + index,
                "wall_time_seconds": 90.0 + index,
                "max_gpu_temperature_c": 62.0 + index,
            }
        )
    return {
        "schema_version": "ltx-av-eval-comparator-resource-profile.v1",
        "candidate_id": candidate["candidate_id"],
        "claim_id": "audio-driven-video.image-audio-to-video",
        "code_revision": candidate["code_revision"],
        "weights_revision": candidate["weights_revision"],
        "runner_digest": "1" * 64,
        "launch_manifest_digest": "2" * 64,
        "input_bundle_digest": "6" * 64,
        "normalization_digest": "3" * 64,
        "measurement_policy_digest": "4" * 64,
        "hardware": {
            "inventory_sha256": "5" * 64,
            "gpu_model": "NVIDIA-GB10",
            "gpu_total_memory_bytes": 128 * gibibyte,
            "driver_version": "580.65.06",
            "cuda_version": "13.0",
        },
        "limits": {
            "runs": 3,
            "max_peak_gpu_memory_bytes": 96 * gibibyte,
            "min_free_gpu_memory_bytes_after_peak": 16 * gibibyte,
            "max_wall_time_seconds": 180.0,
            "max_gpu_temperature_c": 80.0,
        },
        "observations": observations,
    }


def test_three_cold_orchestrated_runs_produce_a_deterministic_pass() -> None:
    profile = _profile()
    landscape = _landscape()

    first = build_comparator_resource_report(profile, landscape=landscape)
    second = build_comparator_resource_report(copy.deepcopy(profile), landscape=copy.deepcopy(landscape))

    assert first == second
    assert first["status"] == "resource-fit-pass"
    assert first["blockers"] == []
    assert first["runs"] == 3
    assert first["profile_digest"] == document_sha256(profile)
    assert first["landscape_digest"] == document_sha256(landscape)


def test_failed_or_over_limit_attempts_remain_in_the_itt_profile() -> None:
    profile = _profile()
    failed = profile["observations"][1]
    failed.update(
        {
            "status": "failed",
            "output_sha256": None,
            "provenance_sha256": None,
            "playable": False,
            "peak_gpu_memory_bytes": 116 * 1024**3,
            "wall_time_seconds": 181.0,
            "max_gpu_temperature_c": 81.0,
        }
    )

    report = build_comparator_resource_report(profile, landscape=_landscape())

    assert report["status"] == "resource-fit-fail"
    assert report["blockers"] == [
        "memory-headroom-limit:cold-02",
        "peak-memory-limit:cold-02",
        "run-contract-failed:cold-02:playable",
        "run-failed:cold-02",
        "temperature-limit:cold-02",
        "wall-time-limit:cold-02",
    ]


def test_profile_rejects_revision_claim_and_attempt_inventory_drift() -> None:
    drift = _profile()
    drift["code_revision"] = "f" * 40
    with pytest.raises(ComparatorResourceError, match="revisions do not match"):
        build_comparator_resource_report(drift, landscape=_landscape())

    incompatible = _profile()
    incompatible["claim_id"] = "reference-video-redubbing.native-distilled"
    with pytest.raises(ComparatorResourceError, match="not input-compatible"):
        build_comparator_resource_report(incompatible, landscape=_landscape())

    missing = _profile()
    missing["observations"].pop()
    with pytest.raises(ComparatorResourceError, match="exactly 3 attempted runs"):
        build_comparator_resource_report(missing, landscape=_landscape())

    duplicate = _profile()
    duplicate["observations"][1]["dgx_job_id"] = duplicate["observations"][0]["dgx_job_id"]
    with pytest.raises(ComparatorResourceError, match="DGX job IDs must be unique"):
        build_comparator_resource_report(duplicate, landscape=_landscape())


def test_resource_profile_cli_emits_the_digest_bound_report(tmp_path: Path) -> None:
    profile_path = tmp_path / "profile.json"
    landscape_path = tmp_path / "landscape.json"
    profile_path.write_text(json.dumps(_profile()), encoding="utf-8")
    landscape_path.write_text(json.dumps(_landscape()), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")

    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "comparator-resource-check",
            "--profile",
            str(profile_path),
            "--landscape",
            str(landscape_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["status"] == "resource-fit-pass"
