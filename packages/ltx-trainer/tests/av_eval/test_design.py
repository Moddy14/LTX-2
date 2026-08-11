from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import DesignError, build_power_report, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
DESIGN_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v1.json"


def _draft() -> dict[str, object]:
    return json.loads(DESIGN_PATH.read_text(encoding="utf-8"))


def _ready_design() -> dict[str, object]:
    design = copy.deepcopy(_draft())
    design["status"] = "frozen"
    design["design_effect"] = 1.4
    evidence_digest = "a" * 64
    delta_catalog = design["delta_catalog"]
    assert isinstance(delta_catalog, dict)
    metrics = delta_catalog["metrics"]
    assert isinstance(metrics, list)
    for metric in metrics:
        metric["delta"] = 0.05
        metric["basis_evidence_sha256"] = evidence_digest
    vbench = design["vbench_gate_catalog"]
    assert isinstance(vbench, dict)
    vbench["commit"] = "b" * 64
    vbench["config_sha256"] = "c" * 64
    gates = vbench["gates"]
    assert isinstance(gates, list)
    for gate in gates:
        gate["absolute_minimum"] = 0.7
        gate["delta"] = 0.03
        gate["basis_evidence_sha256"] = evidence_digest
    endpoints = design["power_endpoints"]
    assert isinstance(endpoints, list)
    for endpoint in endpoints:
        endpoint["max_ci_width"] = 0.04
        if endpoint["model"] == "paired-mean":
            endpoint["effect"] = 0.1
            endpoint["variability"] = 0.2
        elif endpoint["model"] == "binomial-upper":
            endpoint["alternative"] = endpoint["null_value"] / 2
        else:
            endpoint["alternative"] = endpoint["null_value"] + (1 - endpoint["null_value"]) / 2
    quotas = design["strata_quotas"]
    assert isinstance(quotas, list)
    for quota in quotas:
        quota["minimum_independent_units"] = 5
    return design


def test_checked_in_design_is_an_explicit_hold_without_invented_pilot_values() -> None:
    design = _draft()
    report = build_power_report(design)

    assert report["status"] == "hold"
    assert report["required_independent_units"] is None
    assert report["required_clips"] is None
    assert "design-effect-missing" in report["blockers"]
    assert "delta-missing:identity-similarity" in report["blockers"]
    assert "vbench-commit-missing" in report["blockers"]
    assert report["design_digest"] == document_sha256(design)


def test_frozen_design_computes_deterministic_power_and_precision_requirements() -> None:
    design = _ready_design()
    first = build_power_report(design)
    second = build_power_report(copy.deepcopy(design))

    assert first == second
    assert first["status"] == "ready-to-freeze"
    assert first["blockers"] == []
    assert first["required_independent_units"] >= 30
    assert first["required_clips"] == first["required_independent_units"] * 3
    assert len(first["endpoint_requirements"]) == len(design["power_endpoints"])


def test_design_rejects_outcome_driven_or_vacuous_freezes() -> None:
    incomplete = _draft()
    incomplete["status"] = "frozen"
    with pytest.raises(DesignError, match="frozen delta catalog is incomplete"):
        build_power_report(incomplete)

    unsorted = _ready_design()
    endpoints = unsorted["power_endpoints"]
    assert isinstance(endpoints, list)
    endpoints.reverse()
    with pytest.raises(DesignError, match="unique and sorted"):
        build_power_report(unsorted)


def test_design_cli_reports_hold_with_a_nonzero_exit(tmp_path: Path) -> None:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "design-check",
            "--design",
            str(DESIGN_PATH),
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
    assert report["required_independent_units"] is None
