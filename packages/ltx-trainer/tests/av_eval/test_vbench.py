from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import VBenchMeasurementError, build_vbench_measurements, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
DESIGN_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v1.json"


def _design() -> dict[str, object]:
    design = json.loads(DESIGN_PATH.read_text(encoding="utf-8"))
    design["status"] = "frozen"
    design["design_effect"] = 1.4
    for metric in design["delta_catalog"]["metrics"]:
        metric["delta"] = 0.05
        metric["basis_evidence_sha256"] = "a" * 64
    vbench = design["vbench_gate_catalog"]
    vbench["commit"] = "b" * 64
    vbench["config_sha256"] = "c" * 64
    for gate in vbench["gates"]:
        gate["absolute_minimum"] = 0.7
        gate["delta"] = 0.03
        gate["basis_evidence_sha256"] = "d" * 64
    for endpoint in design["power_endpoints"]:
        endpoint["max_ci_width"] = 0.04
        if endpoint["model"] == "paired-mean":
            endpoint["effect"] = 0.1
            endpoint["variability"] = 0.2
        elif endpoint["model"] == "binomial-upper":
            endpoint["alternative"] = endpoint["null_value"] / 2
        else:
            endpoint["alternative"] = endpoint["null_value"] + (1 - endpoint["null_value"]) / 2
    for quota in design["strata_quotas"]:
        quota["minimum_independent_units"] = 5
    return design


def _input(design: dict[str, object]) -> dict[str, object]:
    observations: list[dict[str, object]] = []
    gates = design["vbench_gate_catalog"]["gates"]  # type: ignore[index]
    for gate in gates:
        for suffix in ("a", "b"):
            observations.append(
                {
                    "observation_id": f"{gate['claim_id']}.{gate['dimension']}.{suffix}",
                    "leakage_component_id": f"component-{suffix}",
                    "claim_id": gate["claim_id"],
                    "dimension": gate["dimension"],
                    "candidate_score": 0.9,
                    "anchor_score": 0.8,
                }
            )
    observations.sort(key=lambda item: item["observation_id"])
    return {
        "schema_version": "ltx-av-eval-vbench-observations.v1",
        "dataset_digest": "1" * 64,
        "preregistration_digest": "2" * 64,
        "release_digest": "3" * 64,
        "strata_plan_digest": "4" * 64,
        "design_digest": document_sha256(design),
        "vbench_gate_catalog_digest": document_sha256(design["vbench_gate_catalog"]),
        "repository_commit": "b" * 64,
        "config_digest": "c" * 64,
        "runtime_digest": "5" * 64,
        "comparator_matrix_digest": "6" * 64,
        "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 11082026},
        "observations": observations,
    }


def test_vbench_measurements_are_deterministic_and_holm_controlled() -> None:
    design = _design()
    evidence = _input(design)
    first = build_vbench_measurements(evidence, design=design)
    second = build_vbench_measurements(copy.deepcopy(evidence), design=copy.deepcopy(design))

    assert first == second
    assert first["verdict"] == "pass"
    assert first["multiplicity"] == "holm"
    assert first["hypotheses"] == 24
    assert len(first["metrics"]) == 12
    assert all(metric["estimate"] <= 0.05 for metric in first["metrics"])
    assert all(metric["absolute"]["holm_ci_lower"] > 0 for metric in first["metrics"])
    assert all(metric["relative"]["holm_ci_lower"] > 0 for metric in first["metrics"])


def test_vbench_measurements_require_absolute_and_relative_success() -> None:
    design = _design()
    evidence = _input(design)
    observations = evidence["observations"]
    assert isinstance(observations, list)
    target_claim = observations[0]["claim_id"]
    target_dimension = observations[0]["dimension"]
    for observation in observations:
        if observation["claim_id"] == target_claim and observation["dimension"] == target_dimension:
            observation["candidate_score"] = 0.6
    report = build_vbench_measurements(evidence, design=design)
    failed = next(
        metric for metric in report["metrics"] if metric["metric_id"] == f"vbench.{target_claim}.{target_dimension}"
    )

    assert failed["decision"] == "fail"
    assert failed["absolute"]["holm_ci_lower"] < 0
    assert failed["relative"]["holm_ci_lower"] < 0
    assert report["verdict"] == "fail"


def test_vbench_measurements_reject_missing_endpoints_and_pseudoreplication() -> None:
    design = _design()
    missing = _input(design)
    observations = missing["observations"]
    assert isinstance(observations, list)
    target = (observations[0]["claim_id"], observations[0]["dimension"])
    missing["observations"] = [
        observation for observation in observations if (observation["claim_id"], observation["dimension"]) != target
    ]
    with pytest.raises(VBenchMeasurementError, match="do not cover every VBench endpoint"):
        build_vbench_measurements(missing, design=design)

    one_component = _input(design)
    observations = one_component["observations"]
    assert isinstance(observations, list)
    target = (observations[0]["claim_id"], observations[0]["dimension"])
    one_component["observations"] = [
        observation
        for observation in observations
        if (observation["claim_id"], observation["dimension"]) != target
        or observation["leakage_component_id"] == "component-a"
    ]
    with pytest.raises(VBenchMeasurementError, match="two independent leakage components"):
        build_vbench_measurements(one_component, design=design)


def test_vbench_measurements_reject_runtime_contract_drift() -> None:
    design = _design()
    evidence = _input(design)
    evidence["repository_commit"] = "f" * 64
    with pytest.raises(VBenchMeasurementError, match="official VBench commit or config mismatch"):
        build_vbench_measurements(evidence, design=design)


def test_vbench_cli_emits_digest_bound_measurements(tmp_path: Path) -> None:
    design = _design()
    observations_path = tmp_path / "observations.json"
    design_path = tmp_path / "design.json"
    observations_path.write_text(json.dumps(_input(design)), encoding="utf-8")
    design_path.write_text(json.dumps(design), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "vbench-score",
            "--observations",
            str(observations_path),
            "--design",
            str(design_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 0
    report = json.loads(result.stdout)
    assert report["schema_version"] == "ltx-av-eval-vbench-measurements.v1"
    assert report["verdict"] == "pass"
