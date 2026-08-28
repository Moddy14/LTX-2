from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import (
    TechnicalEvidenceError,
    build_technical_evidence_bundle,
    document_sha256,
)
from ltx_trainer.av_eval.authorization import studio_sha256_document

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
SURFACE_PATH = REPOSITORY_ROOT / "apps" / "ltx-studio" / "release" / "candidate-release-surface.v1.json"


def _surface() -> dict[str, object]:
    return json.loads(SURFACE_PATH.read_text(encoding="utf-8"))


def _runtime_trust() -> dict[str, object]:
    return {
        "schemaVersion": "ltx-studio-runtime-trust-binding.v2",
        "hostTcbAttestationSha256": "a" * 64,
        "hostTcbContractSha256": "b" * 64,
        "servicePolicySha256": "c" * 64,
        "buildTcbSha256": "d" * 64,
        "authorityIsolation": {
            "schemaVersion": "ltx-studio-authority-isolation.v1",
            "status": "attested",
            "mechanism": "separate-studio-identity-proc-fd-isolation",
            "hostTcbAttestationSha256": "a" * 64,
            "brokerAttestationSha256": None,
            "reasonCode": None,
        },
        "trustPolicyDigests": {
            "release": "1" * 64,
            "activationWriter": "2" * 64,
            "qualificationAuthorizer": "3" * 64,
            "runtimeRights": "4" * 64,
            "bootstrapAuthority": "5" * 64,
        },
    }


def _observations(surface: dict[str, object]) -> dict[str, object]:
    candidates = [entry for entry in surface["entries"] if entry["targetStatus"] == "candidate"]  # type: ignore[index]
    cooperative = [entry for entry in candidates if entry["cooperativeCheckpoint"]]
    by_mode = {entry["request"]["mode"]: entry for entry in cooperative}
    modes = sorted(by_mode)
    canaries = [
        {
            "surface_entry_id": entry["id"],
            "dgx_job_id": f"dgx-job-canary-{index:02d}",
            "release_digest": "1" * 64,
            "output_sha256": f"{(index % 15) + 1:x}" * 64,
            "cold_start": True,
            "playable": True,
            "provenance_verified": True,
        }
        for index, entry in enumerate(candidates)
    ]
    canaries.sort(key=lambda row: row["surface_entry_id"])
    pause_resume = []
    for index in range(20):
        mode = modes[index % len(modes)]
        digest = f"{(index % 15) + 1:x}" * 64
        pause_resume.append(
            {
                "cycle_id": f"cycle-{index:02d}",
                "surface_entry_id": by_mode[mode]["id"],
                "mode": mode,
                "boundary_position": ("early", "middle", "late")[index % 3],
                "comparison_kind": "bitwise",
                "comparison_passed": True,
                "equivalence_rule_sha256": None,
                "checkpoint_sha256": "a" * 64,
                "output_sha256": digest,
                "control_output_sha256": digest,
                "orphaned": False,
            }
        )
    soak = []
    for index in range(50):
        entry = candidates[index % len(candidates)]
        soak.append(
            {
                "row_id": f"soak-{index:02d}",
                "surface_entry_id": entry["id"],
                "expected_state": "completed",
                "actual_state": "completed",
                "playable": True,
                "provenance_verified": True,
                "output_bound": True,
                "lost": False,
                "orphaned": False,
                "duplicate": False,
                "foreign_service_actions": 0,
                "recovery_ms": 100,
                "recovery_slo_ms": 1_000,
            }
        )
    return {
        "schema_version": "ltx-studio-technical-observations.v1",
        "release_digest": "1" * 64,
        "preregistration_digest": "2" * 64,
        "surface_digest": studio_sha256_document(surface),
        "producer_id": "technical-runner-01",
        "runner_digest": "3" * 64,
        "r0": {
            "actions": ["continue_current", "resume_current", "wait_for_successor", "yield_to_waiting_job"],
            "running_transport_failure": "checkpoint-and-exit-75",
            "paused_transport_failure": "remain-paused-and-retry",
            "api_restart_reconciled": True,
            "studio_restart_reconciled": True,
        },
        "canaries": canaries,
        "pause_resume": pause_resume,
        "soak": soak,
    }


def test_technical_bundle_is_deterministic_and_covers_the_release_surface() -> None:
    surface = _surface()
    candidate_count = sum(entry["targetStatus"] == "candidate" for entry in surface["entries"])
    observations = _observations(surface)
    runtime_trust = _runtime_trust()
    first = build_technical_evidence_bundle(observations, surface=surface, runtime_trust=runtime_trust)
    second = build_technical_evidence_bundle(
        copy.deepcopy(observations),
        surface=copy.deepcopy(surface),
        runtime_trust=copy.deepcopy(runtime_trust),
    )

    assert first == second
    assert first["schema_version"] == "ltx-av-eval-technical-qualification-bundle.v2"
    assert first["runner_digest"] == "3" * 64
    assert first["detailed_reports"]["r3-canaries"]["candidate_entry_count"] == candidate_count
    assert first["detailed_reports"]["r3-pause-resume"]["cycles"] == 20
    assert first["detailed_reports"]["r3-soak"]["jobs"] == 50
    assert [report["kind"] for report in first["qualification_reports"]] == [
        "r0-control-plane",
        "r3-canaries",
        "r3-pause-resume",
        "r3-soak",
    ]
    for report in first["qualification_reports"]:
        assert report["schemaVersion"] == "ltx-studio-qualification-report.v2"
        assert report["runtimeTrust"] == runtime_trust
        assert report["producerDigest"] == document_sha256(first["detailed_reports"][report["kind"]])
        assert first["detailed_reports"][report["kind"]]["runner_digest"] == first["runner_digest"]

    first["detailed_reports"]["r0-control-plane"]["actions"].append("mutated")
    assert build_technical_evidence_bundle(
        observations,
        surface=surface,
        runtime_trust=runtime_trust,
    ) == second


def test_technical_bundle_rejects_incomplete_or_false_live_evidence() -> None:
    surface = _surface()
    missing_canary = _observations(surface)
    missing_canary["canaries"] = missing_canary["canaries"][:-1]  # type: ignore[index]
    with pytest.raises(TechnicalEvidenceError, match="exactly cover"):
        build_technical_evidence_bundle(missing_canary, surface=surface, runtime_trust=_runtime_trust())

    short_cycles = _observations(surface)
    short_cycles["pause_resume"] = short_cycles["pause_resume"][:-1]  # type: ignore[index]
    with pytest.raises(TechnicalEvidenceError, match="exactly 20"):
        build_technical_evidence_bundle(short_cycles, surface=surface, runtime_trust=_runtime_trust())

    foreign_action = _observations(surface)
    foreign_action["soak"][0]["foreign_service_actions"] = 1  # type: ignore[index]
    with pytest.raises(TechnicalEvidenceError, match="foreign service"):
        build_technical_evidence_bundle(foreign_action, surface=surface, runtime_trust=_runtime_trust())

    wrong_mode = _observations(surface)
    wrong_mode["pause_resume"][0]["mode"] = "retake"  # type: ignore[index]
    with pytest.raises(TechnicalEvidenceError, match="mode does not match"):
        build_technical_evidence_bundle(wrong_mode, surface=surface, runtime_trust=_runtime_trust())


def test_technical_bundle_holds_without_external_release_authority() -> None:
    surface = _surface()
    with pytest.raises(TechnicalEvidenceError, match="qualification HOLD"):
        build_technical_evidence_bundle(_observations(surface), surface=surface)

    same_uid = _runtime_trust()
    same_uid["authorityIsolation"] = {
        "schemaVersion": "ltx-studio-authority-isolation.v1",
        "status": "hold",
        "mechanism": "same-local-uid",
        "attestationSha256": None,
        "reasonCode": "same-uid-authority-not-authentic",
    }
    with pytest.raises(TechnicalEvidenceError, match="qualification HOLD"):
        build_technical_evidence_bundle(
            _observations(surface),
            surface=surface,
            runtime_trust=same_uid,
        )


def test_technical_cli_emits_one_qualification_bundle(tmp_path: Path) -> None:
    surface = _surface()
    observations_path = tmp_path / "observations.json"
    surface_path = tmp_path / "surface.json"
    runtime_trust_path = tmp_path / "runtime-trust.json"
    observations_path.write_text(json.dumps(_observations(surface)), encoding="utf-8")
    surface_path.write_text(json.dumps(surface), encoding="utf-8")
    runtime_trust_path.write_text(json.dumps(_runtime_trust()), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "technical-score",
            "--observations",
            str(observations_path),
            "--surface",
            str(surface_path),
            "--runtime-trust",
            str(runtime_trust_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert len(result.stdout.splitlines()) == 1
    assert json.loads(result.stdout)["schema_version"] == "ltx-av-eval-technical-qualification-bundle.v2"
