from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import CrossShotProtocolError, build_cross_shot_protocol_report, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PROTOCOL_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "cross-shot-protocol.v1.json"


def _draft() -> dict[str, object]:
    return json.loads(PROTOCOL_PATH.read_text(encoding="utf-8"))


def _design_report(required: int = 40) -> dict[str, object]:
    return {
        "schema_version": "ltx-sota-power-report.v1",
        "design_digest": "1" * 64,
        "delta_catalog_digest": "2" * 64,
        "vbench_gate_catalog_digest": "3" * 64,
        "status": "ready-to-freeze",
        "blockers": [],
        "familywise_alpha": 0.05,
        "per_endpoint_planning_alpha": 0.001,
        "target_power": 0.9,
        "endpoint_requirements": [],
        "required_independent_units": required,
        "required_clips": required * 3,
        "strata_quotas_digest": "4" * 64,
    }


def _ready() -> tuple[dict[str, object], dict[str, object]]:
    protocol = copy.deepcopy(_draft())
    design_report = _design_report()
    protocol["status"] = "frozen"
    protocol["sample_plan"]["required_identities"] = 40  # type: ignore[index]
    bindings = protocol["bindings"]
    assert isinstance(bindings, list)
    for binding in bindings:
        binding["sha256"] = "a" * 64
        if binding["artifact_id"] == "design_report":
            binding["sha256"] = document_sha256(design_report)
    arms = protocol["arms"]
    assert isinstance(arms, list)
    for arm in arms:
        if arm["reference_strategy"] != "none":
            arm["strategy_artifact_sha256"] = "b" * 64
    endpoints = protocol["endpoint_bindings"]
    assert isinstance(endpoints, list)
    for endpoint in endpoints:
        endpoint["delta_basis_sha256"] = design_report["delta_catalog_digest"]
    return protocol, design_report


def test_checked_in_cross_shot_protocol_is_an_explicit_hold() -> None:
    report = build_cross_shot_protocol_report(_draft())

    assert report["status"] == "hold"
    assert report["planned_renders"] is None
    assert "required-identities-missing" in report["blockers"]
    assert "design-report-unverified" in report["blockers"]
    assert "strategy-artifact-missing:automatic-scene-reference" in report["blockers"]


def test_complete_cross_shot_protocol_binds_power_and_render_count() -> None:
    protocol, design_report = _ready()
    first = build_cross_shot_protocol_report(protocol, design_report=design_report)
    second = build_cross_shot_protocol_report(copy.deepcopy(protocol), design_report=copy.deepcopy(design_report))

    assert first == second
    assert first["status"] == "ready-to-freeze"
    assert first["blockers"] == []
    assert first["planned_renders"] == 240


def test_cross_shot_protocol_rejects_unpaired_or_result_driven_changes() -> None:
    changed, design_report = _ready()
    changed["paired_invariants"]["generation_seeds"] = "arm-specific"  # type: ignore[index]
    with pytest.raises(CrossShotProtocolError, match="paired invariants changed"):
        build_cross_shot_protocol_report(changed, design_report=design_report)

    automatic, design_report = _ready()
    automatic["arms"][0]["default_enabled"] = True  # type: ignore[index]
    with pytest.raises(CrossShotProtocolError, match="arm semantics changed"):
        build_cross_shot_protocol_report(automatic, design_report=design_report)


def test_cross_shot_protocol_rejects_power_mismatch() -> None:
    protocol, design_report = _ready()
    protocol["sample_plan"]["required_identities"] = 39  # type: ignore[index]
    with pytest.raises(CrossShotProtocolError, match="does not match"):
        build_cross_shot_protocol_report(protocol, design_report=design_report)

    changed_delta, design_report = _ready()
    changed_delta["endpoint_bindings"][0]["delta_basis_sha256"] = "f" * 64  # type: ignore[index]
    with pytest.raises(CrossShotProtocolError, match="frozen D0a delta catalog"):
        build_cross_shot_protocol_report(changed_delta, design_report=design_report)


def test_cross_shot_cli_reports_draft_hold(tmp_path: Path) -> None:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "cross-shot-check",
            "--protocol",
            str(PROTOCOL_PATH),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 2
    assert json.loads(result.stdout)["status"] == "hold"
