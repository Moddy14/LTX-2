from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from ltx_trainer.av_eval import ComparatorResultError, build_comparator_decision, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CONFIG_ROOT = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval"
MATRIX_PATH = CONFIG_ROOT / "comparator-matrix.v1.json"
LANDSCAPE_PATH = CONFIG_ROOT / "anchor-landscape.v1.json"
AS_OF = date(2026, 8, 11)
BASE_FAMILIES = ["artifact", "asr", "av-sync", "mouth-content", "mos", "sharpness", "vbench"]


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _contracts(*, targets: bool = True) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    landscape = copy.deepcopy(_load(LANDSCAPE_PATH))
    landscape["status"] = "verified"
    for index, candidate in enumerate(landscape["candidates"], start=1):
        marker = str(index)
        candidate["code_revision"] = marker * 40
        candidate["weights_revision"] = marker * 40
        candidate["code_license_sha256"] = marker * 64
        candidate["weights_license_sha256"] = marker * 64
        candidate["resource_profile_sha256"] = marker * 64

    matrix = copy.deepcopy(_load(MATRIX_PATH))
    matrix["status"] = "frozen"
    matrix["landscape_sha256"] = document_sha256(landscape)
    target_ids: list[str] = []
    for claim in matrix["claims"]:
        claim["claim_status"] = "sota-target" if targets else "local-only"
        claim["sota_anchor_arm_id"] = "mova" if targets else None
        if targets:
            target_ids.append(claim["claim_id"])
        landscape_index = {candidate["candidate_id"]: candidate for candidate in landscape["candidates"]}
        for arm in claim["arms"]:
            if arm["provider"] == "owned":
                arm.update(
                    {
                        "inclusion_status": "included",
                        "input_compatibility": "compatible",
                        "rights_status": "clear",
                        "technical_status": "pass",
                        "code_revision": "d" * 40,
                        "weights_revision": "e" * 40,
                    }
                )
            elif targets and arm["arm_id"] == "mova":
                candidate = landscape_index[arm["arm_id"]]
                arm.update(
                    {
                        "inclusion_status": "included",
                        "input_compatibility": "compatible",
                        "rights_status": "clear",
                        "technical_status": "pass",
                        "code_revision": candidate["code_revision"],
                        "weights_revision": candidate["weights_revision"],
                    }
                )
            else:
                arm.update(
                    {
                        "inclusion_status": "excluded",
                        "input_compatibility": "incompatible",
                        "rights_status": "clear",
                        "technical_status": "pass",
                        "exclusion_reason": "input-contract-incompatible",
                    }
                )
    matrix["target_sota_claim_ids"] = sorted(target_ids)
    gate_rows: list[dict[str, Any]] = []
    for claim_id in sorted(target_ids):
        families = [*BASE_FAMILIES, *( ["identity"] if claim_id != "native-generation.text-to-video" else [])]
        for family_index, family in enumerate(sorted(families)):
            gate_rows.append(
                {
                    "gate_id": f"gate-{len(gate_rows):02d}",
                    "claim_id": claim_id,
                    "gate_family": family,
                    "metric_id": f"metric-{family}",
                    "direction": "higher",
                    "test": "superiority" if family_index == 0 else "noninferiority",
                    "delta": 0.1,
                    "valid_min": 0.0,
                    "valid_max": 1.0,
                }
            )
    gates = {
        "schema_version": "ltx-av-eval-comparator-gates.v1",
        "status": "frozen",
        "gates": gate_rows,
    }
    for commitment in matrix["commitments"]:
        commitment["sha256"] = (
            document_sha256(gates) if commitment["artifact_id"] == "applicable_gates" else "c" * 64
        )
    return matrix, landscape, gates


def _results(matrix: dict[str, Any], *, candidate_value: float = 0.9) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    index = 0
    for claim in matrix["claims"]:
        included = sorted(arm["arm_id"] for arm in claim["arms"] if arm["inclusion_status"] == "included")
        claim_metrics = sorted(
            gate["metric_id"]
            for gate in _gates_for_matrix(matrix)
            if gate["claim_id"] == claim["claim_id"]
        )
        for component_index in range(2):
            for arm_id in included:
                owned = arm_id.startswith("ltx-")
                rows.append(
                    {
                        "row_id": f"row-{index:04d}",
                        "claim_id": claim["claim_id"],
                        "sample_id": f"sample-{component_index:02d}",
                        "leakage_component_id": f"component-{component_index:02d}",
                        "generation_seed": 7,
                        "arm_id": arm_id,
                        "status": "completed",
                        "measurements": (
                            dict.fromkeys(claim_metrics, candidate_value if owned else 0.5)
                            if claim["claim_status"] == "sota-target"
                            else {}
                        ),
                    }
                )
                index += 1
    return {
        "schema_version": "ltx-av-eval-comparator-results.v1",
        "release_digest": "a" * 64,
        "calibration_dataset_digest": "b" * 64,
        "preregistration_digest": "c" * 64,
        "comparator_matrix_digest": document_sha256(matrix),
        "q1_runner_digest": "d" * 64,
        "bootstrap": {"replicates": 10_000, "confidence_level": 0.95, "seed": 41},
        "rows": rows,
    }


def _gates_for_matrix(matrix: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for claim in matrix["claims"]:
        if claim["claim_status"] != "sota-target":
            continue
        families = [*BASE_FAMILIES, *( ["identity"] if claim["claim_id"] != "native-generation.text-to-video" else [])]
        for family_index, family in enumerate(sorted(families)):
            rows.append(
                {
                    "gate_id": f"gate-{len(rows):02d}",
                    "claim_id": claim["claim_id"],
                    "gate_family": family,
                    "metric_id": f"metric-{family}",
                    "direction": "higher",
                    "test": "superiority" if family_index == 0 else "noninferiority",
                    "delta": 0.1,
                    "valid_min": 0.0,
                    "valid_max": 1.0,
                }
            )
    return rows


def test_paired_q1_pilot_passes_registered_holm_gates() -> None:
    matrix, landscape, gates = _contracts()
    results = _results(matrix)

    first = build_comparator_decision(results, gates=gates, matrix=matrix, landscape=landscape, as_of=AS_OF)
    second = build_comparator_decision(
        copy.deepcopy(results),
        gates=copy.deepcopy(gates),
        matrix=copy.deepcopy(matrix),
        landscape=copy.deepcopy(landscape),
        as_of=AS_OF,
    )

    assert first == second
    assert first["status"] == "ready-to-freeze"
    assert first["sota_status"] == "anchor-pilot-pass"
    assert first["failed_rows"] == 0
    assert {claim["status"] for claim in first["claims"]} == {"sota-pilot-pass"}
    ranks = sorted(gate["holm_rank"] for claim in first["claims"] for gate in claim["gates"])
    assert ranks == list(range(1, 40))


def test_q1_itt_failure_and_material_shortfall_hold_the_freeze() -> None:
    matrix, landscape, gates = _contracts()
    failed = _results(matrix)
    failed["rows"][0]["status"] = "failed"
    failed["rows"][0]["measurements"] = None
    failed_report = build_comparator_decision(
        failed,
        gates=gates,
        matrix=matrix,
        landscape=landscape,
        as_of=AS_OF,
    )

    assert failed_report["status"] == "hold"
    assert failed_report["sota_status"] == "hold"
    assert any(blocker.startswith("claim-failed-itt:") for blocker in failed_report["blockers"])

    shortfall = _results(matrix, candidate_value=0.55)
    shortfall_report = build_comparator_decision(
        shortfall,
        gates=gates,
        matrix=matrix,
        landscape=landscape,
        as_of=AS_OF,
    )
    assert shortfall_report["status"] == "hold"
    assert all(claim["status"] == "sota-pilot-fail" for claim in shortfall_report["claims"])


def test_q1_rejects_unpaired_rows_and_post_commitment_gate_drift() -> None:
    matrix, landscape, gates = _contracts()
    unpaired = _results(matrix)
    unpaired["rows"].pop()
    with pytest.raises(ComparatorResultError, match="exact paired arm factorial"):
        build_comparator_decision(unpaired, gates=gates, matrix=matrix, landscape=landscape, as_of=AS_OF)

    drifted = copy.deepcopy(gates)
    drifted["gates"][0]["delta"] = 0.01
    with pytest.raises(ComparatorResultError, match="pre-result matrix commitment"):
        build_comparator_decision(
            _results(matrix),
            gates=drifted,
            matrix=matrix,
            landscape=landscape,
            as_of=AS_OF,
        )


def test_q1_requires_complete_quality_families_and_noninferiority_guardrails() -> None:
    matrix, landscape, gates = _contracts()
    incomplete = copy.deepcopy(gates)
    incomplete["gates"].pop(0)
    with pytest.raises(ComparatorResultError, match="every required gate family"):
        build_comparator_decision(
            _results(matrix),
            gates=incomplete,
            matrix=matrix,
            landscape=landscape,
            as_of=AS_OF,
        )

    no_guardrail = copy.deepcopy(gates)
    for gate in no_guardrail["gates"]:
        gate["test"] = "superiority"
    with pytest.raises(ComparatorResultError, match="non-inferiority guardrails"):
        build_comparator_decision(
            _results(matrix),
            gates=no_guardrail,
            matrix=matrix,
            landscape=landscape,
            as_of=AS_OF,
        )


def test_local_only_q1_can_freeze_but_never_claim_sota() -> None:
    matrix, landscape, gates = _contracts(targets=False)
    report = build_comparator_decision(
        _results(matrix),
        gates=gates,
        matrix=matrix,
        landscape=landscape,
        as_of=AS_OF,
    )

    assert report["status"] == "ready-to-freeze"
    assert report["sota_status"] == "hold"
    assert report["target_sota_claim_ids"] == []
    assert {claim["status"] for claim in report["claims"]} == {"local-only"}


def test_comparator_score_cli_emits_a_ready_report(tmp_path: Path) -> None:
    matrix, landscape, gates = _contracts()
    inputs = {
        "results": _results(matrix),
        "gates": gates,
        "matrix": matrix,
        "landscape": landscape,
    }
    paths: dict[str, Path] = {}
    for name, document in inputs.items():
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(document), encoding="utf-8")
        paths[name] = path
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "comparator-score",
            "--results",
            str(paths["results"]),
            "--gates",
            str(paths["gates"]),
            "--matrix",
            str(paths["matrix"]),
            "--landscape",
            str(paths["landscape"]),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["sota_status"] == "anchor-pilot-pass"
