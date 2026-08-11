from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import CalibrationError, build_calibration_gate_report

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CATALOG_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "calibration-gates.v1.json"
DESIGN_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v1.json"
SURFACE_PATH = REPOSITORY_ROOT / "apps" / "ltx-studio" / "release" / "candidate-release-surface.v1.json"


def _draft() -> dict[str, object]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))


def _ready() -> dict[str, object]:
    catalog = copy.deepcopy(_draft())
    catalog["status"] = "frozen"
    catalog["design_digest"] = "a" * 64
    catalog["preregistration_digest"] = "b" * 64
    catalog["vbench_gate_catalog_digest"] = "c" * 64
    fingerprints = catalog["evaluator_fingerprints"]
    assert isinstance(fingerprints, list)
    for fingerprint in fingerprints:
        fingerprint["sha256"] = "d" * 64
    gates = catalog["gates"]
    assert isinstance(gates, list)
    for gate in gates:
        gate["basis_evidence_sha256"] = "e" * 64
        if gate["threshold"] is None:
            gate["threshold"] = 0.75
    return catalog


def test_checked_in_calibration_catalog_is_an_explicit_hold() -> None:
    report = build_calibration_gate_report(_draft())

    assert report["status"] == "hold"
    assert len(report["required_metric_ids"]) == 127
    assert "threshold-missing:sharpness-relative-face-ci-lower" in report["blockers"]
    assert "fingerprint-missing:asr-model" in report["blockers"]
    assert "design-digest-missing" in report["blockers"]


def test_complete_catalog_freezes_all_required_metrics_deterministically() -> None:
    first = build_calibration_gate_report(_ready())
    second = build_calibration_gate_report(copy.deepcopy(_ready()))

    assert first == second
    assert first["status"] == "ready-to-freeze"
    assert first["blockers"] == []
    assert first["required_metric_ids"] == sorted(first["required_metric_ids"])
    assert "asr-critical-name-accuracy-ci-lower" in first["required_metric_ids"]
    assert "asr-critical-negation-accuracy-ci-lower" in first["required_metric_ids"]
    assert "asr-critical-number-accuracy-ci-lower" in first["required_metric_ids"]
    assert first["vbench_decision_digest"] == second["vbench_decision_digest"]


def test_vbench_catalog_exactly_covers_every_visual_candidate_claim() -> None:
    design = json.loads(DESIGN_PATH.read_text(encoding="utf-8"))
    surface = json.loads(SURFACE_PATH.read_text(encoding="utf-8"))
    expected_claims = {
        entry["claimId"]
        for entry in surface["entries"]
        if entry["targetStatus"] == "candidate" and "vbench-i2v" in entry["applicableGates"]
    }
    gates = design["vbench_gate_catalog"]["gates"]
    actual_claims = {gate["claim_id"] for gate in gates}
    actual_metric_ids = {
        f"vbench.{gate['claim_id']}.{gate['dimension']}"
        for gate in gates
    }

    assert actual_claims == expected_claims
    assert actual_metric_ids == set(_draft()["vbench_metric_ids"])


def test_catalog_rejects_missing_gates_and_changed_plan_thresholds() -> None:
    missing = _draft()
    missing["gates"] = missing["gates"][:-1]  # type: ignore[index]
    with pytest.raises(CalibrationError, match="exactly match"):
        build_calibration_gate_report(missing)

    changed = _draft()
    changed["gates"][0]["threshold"] = 0.02  # type: ignore[index]
    with pytest.raises(CalibrationError, match="plan-fixed threshold changed"):
        build_calibration_gate_report(changed)

    missing_vbench = _draft()
    missing_vbench["vbench_metric_ids"] = missing_vbench["vbench_metric_ids"][:-1]  # type: ignore[index]
    with pytest.raises(CalibrationError, match="D0a claim/dimension matrix"):
        build_calibration_gate_report(missing_vbench)

    changed_vbench_decision = _draft()
    changed_vbench_decision["vbench_decision"]["threshold"] = 0.1  # type: ignore[index]
    with pytest.raises(CalibrationError, match="absolute-and-relative Holm contract"):
        build_calibration_gate_report(changed_vbench_decision)


def test_calibration_cli_reports_hold_with_a_nonzero_exit(tmp_path: Path) -> None:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "calibration-check",
            "--catalog",
            str(CATALOG_PATH),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 2
    report = json.loads(result.stdout)
    assert report["status"] == "hold"
