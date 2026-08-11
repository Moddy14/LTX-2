from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path
from statistics import NormalDist

import pytest

from ltx_trainer.av_eval import (
    CompleteD1Error,
    build_calibration_gate_report,
    build_complete_d1_report,
    build_power_report,
    build_vbench_measurements,
    document_sha256,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CATALOG_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "calibration-gates.v1.json"
DESIGN_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v1.json"


def _design() -> dict[str, object]:
    design = json.loads(DESIGN_PATH.read_text(encoding="utf-8"))
    design["status"] = "frozen"
    design["design_effect"] = 1.4
    for metric in design["delta_catalog"]["metrics"]:
        metric["delta"] = 0.05
        metric["basis_evidence_sha256"] = "a" * 64
    vbench = design["vbench_gate_catalog"]
    vbench["commit"] = "b" * 40
    vbench["config_sha256"] = "c" * 64
    for gate in vbench["gates"]:
        gate["absolute_minimum"] = 0.7
        gate["delta"] = 0.03
        gate["basis_evidence_sha256"] = "e" * 64
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


def _runtime_report() -> dict[str, object]:
    fingerprint = {
        "runtime_contract_digest": "1" * 64,
        "source_report_digest": "2" * 64,
        "python_executable_sha256": "3" * 64,
        "python_version": "3.12.3",
        "dependency_lock_sha256": "4" * 64,
        "network_policy_sha256": "5" * 64,
        "distribution_inventory_digest": "6" * 64,
        "artifact_inventory_digest": "7" * 64,
        "import_inventory_digest": "8" * 64,
    }
    return {
        "schema_version": "ltx-av-eval-vbench-i2v-runtime-report.v1",
        "status": "runtime-verified",
        "blockers": [],
        **fingerprint,
        "runtime_digest": document_sha256(fingerprint),
    }


def _catalog(design: dict[str, object]) -> dict[str, object]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    catalog["status"] = "frozen"
    catalog["design_digest"] = document_sha256(design)
    catalog["preregistration_digest"] = "2" * 64
    catalog["vbench_gate_catalog_digest"] = document_sha256(design["vbench_gate_catalog"])
    for fingerprint in catalog["evaluator_fingerprints"]:
        fingerprint["sha256"] = (
            _runtime_report()["runtime_digest"] if fingerprint["evaluator_id"] == "vbench-runtime" else "d" * 64
        )
    for gate in catalog["gates"]:
        gate["basis_evidence_sha256"] = "e" * 64
        if gate["threshold"] is None:
            gate["threshold"] = 0.75
    return catalog


def _fixed_report(catalog: dict[str, object], design: dict[str, object]) -> dict[str, object]:
    metrics: list[dict[str, object]] = []
    for gate in catalog["gates"]:
        value = 1.0 if gate["direction"] == "higher" else 0.0
        metrics.append(
            {
                "metric_id": gate["metric_id"],
                "estimate": value,
                "ci_lower": value,
                "ci_upper": value,
                "decision_stratum_id": "overall",
                "independent_units": 40,
                "source": "synthetic-test-source",
                "source_observations": 120,
                "direction": gate["direction"],
                "decision_value": gate["decision_value"],
                "threshold": gate["threshold"],
                "basis_evidence_sha256": gate["basis_evidence_sha256"],
                "evaluated_value": value,
                "decision": "pass",
            }
        )
    return {
        "schema_version": "ltx-av-eval-fixed-d1-report.v1",
        "calibration_catalog_digest": build_calibration_gate_report(catalog)["catalog_digest"],
        "dataset_digest": "1" * 64,
        "preregistration_digest": "2" * 64,
        "release_digest": "3" * 64,
        "design_digest": document_sha256(design),
        "strata_plan_digest": "4" * 64,
        "metrics": metrics,
    }


def _effect(rank: int, hypothesis_count: int) -> dict[str, object]:
    adjusted_p = rank / 1_000_000
    standard_error = 0.01
    estimate = 0.1
    raw_critical = NormalDist().inv_cdf(0.975)
    remaining = hypothesis_count - rank + 1
    holm_alpha = 0.05 / remaining
    holm_critical = NormalDist().inv_cdf(1 - holm_alpha)
    return {
        "estimate": estimate,
        "standard_error": standard_error,
        "raw_ci_lower": estimate - raw_critical * standard_error,
        "raw_ci_upper": estimate + raw_critical * standard_error,
        "raw_p": adjusted_p / remaining,
        "holm_adjusted_p": adjusted_p,
        "holm_rank": rank,
        "holm_alpha": holm_alpha,
        "holm_ci_lower": estimate - holm_critical * standard_error,
        "independent_units": 40,
    }


def _vbench_report(design: dict[str, object]) -> dict[str, object]:
    metrics: list[dict[str, object]] = []
    rank = 1
    gates = design["vbench_gate_catalog"]["gates"]  # type: ignore[index]
    hypothesis_count = 2 * len(gates)
    for gate in gates:
        absolute = _effect(rank, hypothesis_count)
        relative = _effect(rank + 1, hypothesis_count)
        rank += 2
        metrics.append(
            {
                "metric_id": f"vbench.{gate['claim_id']}.{gate['dimension']}",
                "estimate": max(absolute["holm_adjusted_p"], relative["holm_adjusted_p"]),
                "ci_lower": 0.0,
                "ci_upper": 1.0,
                "decision_stratum_id": "overall",
                "independent_units": 40,
                "source_observations": 120,
                "claim_id": gate["claim_id"],
                "dimension": gate["dimension"],
                "test": gate["test"],
                "absolute_minimum": gate["absolute_minimum"],
                "delta": gate["delta"],
                "basis_evidence_sha256": gate["basis_evidence_sha256"],
                "decision": "pass",
                "absolute": absolute,
                "relative": relative,
            }
        )
    metrics.sort(key=lambda metric: metric["metric_id"])
    return {
        "schema_version": "ltx-av-eval-vbench-measurements.v1",
        "dataset_digest": "1" * 64,
        "preregistration_digest": "2" * 64,
        "release_digest": "3" * 64,
        "design_digest": document_sha256(design),
        "strata_plan_digest": "4" * 64,
        "runtime_digest": _runtime_report()["runtime_digest"],
        "design_report_digest": document_sha256(build_power_report(design)),
        "metrics": metrics,
    }


def _scored_vbench_report(design: dict[str, object]) -> dict[str, object]:
    observations: list[dict[str, object]] = []
    for gate in design["vbench_gate_catalog"]["gates"]:  # type: ignore[index]
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
    observations.sort(key=lambda observation: observation["observation_id"])
    return build_vbench_measurements(
        {
            "schema_version": "ltx-av-eval-vbench-observations.v1",
            "dataset_digest": "1" * 64,
            "preregistration_digest": "2" * 64,
            "release_digest": "3" * 64,
            "strata_plan_digest": "4" * 64,
            "design_digest": document_sha256(design),
            "vbench_gate_catalog_digest": document_sha256(design["vbench_gate_catalog"]),
            "repository_commit": "b" * 40,
            "config_digest": "c" * 64,
            "runtime_digest": _runtime_report()["runtime_digest"],
            "comparator_matrix_digest": "6" * 64,
            "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 11082026},
            "observations": observations,
        },
        design=design,
    )


def _bundle(catalog: dict[str, object], design: dict[str, object]) -> dict[str, object]:
    return {
        "schema_version": "ltx-av-eval-complete-d1-bundle.v1",
        "report_id": "complete-d1-candidate-01",
        "producer_id": "independent-calibration-scorer-01",
        "generated_at": "2026-08-11T18:00:00Z",
        "runner_digest": "f" * 64,
        "fixed_report": _fixed_report(catalog, design),
        "vbench_report": _vbench_report(design),
        "vbench_runtime_report": _runtime_report(),
    }


def test_complete_d1_report_is_deterministic_and_covers_the_full_surface_gate_matrix() -> None:
    design = _design()
    catalog = _catalog(design)
    bundle = _bundle(catalog, design)
    first = build_complete_d1_report(bundle, calibration_catalog=catalog, design=design)
    second = build_complete_d1_report(
        copy.deepcopy(bundle),
        calibration_catalog=copy.deepcopy(catalog),
        design=copy.deepcopy(design),
    )

    assert first == second
    assert first["verdict"] == "pass"
    assert len(first["metrics"]) == 127
    assert first["metrics"] == sorted(first["metrics"], key=lambda metric: metric["metric_id"])


def test_complete_d1_accepts_the_executable_vbench_scorer_output() -> None:
    design = _design()
    catalog = _catalog(design)
    bundle = _bundle(catalog, design)
    bundle["vbench_report"] = _scored_vbench_report(design)
    report = build_complete_d1_report(bundle, calibration_catalog=catalog, design=design)

    assert report["verdict"] == "pass"
    assert len(report["metrics"]) == 127


def test_complete_d1_report_recomputes_fixed_and_vbench_decisions() -> None:
    design = _design()
    catalog = _catalog(design)
    changed_fixed = _bundle(catalog, design)
    changed_fixed["fixed_report"]["metrics"][0]["decision"] = "fail"  # type: ignore[index]
    with pytest.raises(CompleteD1Error, match=r"fixed metric .* decision contract mismatch"):
        build_complete_d1_report(changed_fixed, calibration_catalog=catalog, design=design)

    changed_vbench = _bundle(catalog, design)
    changed_metric = changed_vbench["vbench_report"]["metrics"][0]  # type: ignore[index]
    changed_metric["absolute"].update(
        {
            "estimate": 0.0,
            "standard_error": 0.0,
            "raw_ci_lower": 0.0,
            "raw_ci_upper": 0.0,
            "raw_p": 1.0,
            "holm_adjusted_p": 1.0,
            "holm_ci_lower": 0.0,
        }
    )
    changed_metric["estimate"] = 1.0
    with pytest.raises(CompleteD1Error, match="decision or sample contract mismatch"):
        build_complete_d1_report(changed_vbench, calibration_catalog=catalog, design=design)


def test_complete_d1_report_rejects_rank_and_release_mixing() -> None:
    design = _design()
    catalog = _catalog(design)
    duplicate_rank = _bundle(catalog, design)
    duplicate_metric = duplicate_rank["vbench_report"]["metrics"][0]  # type: ignore[index]
    duplicate_metric["relative"] = copy.deepcopy(duplicate_metric["absolute"])
    duplicate_metric["estimate"] = duplicate_metric["absolute"]["holm_adjusted_p"]
    with pytest.raises(CompleteD1Error, match="Holm ranks must cover"):
        build_complete_d1_report(duplicate_rank, calibration_catalog=catalog, design=design)

    mixed_release = _bundle(catalog, design)
    mixed_release["vbench_report"]["release_digest"] = "9" * 64  # type: ignore[index]
    with pytest.raises(CompleteD1Error, match="disagree on release_digest"):
        build_complete_d1_report(mixed_release, calibration_catalog=catalog, design=design)


def test_complete_d1_recomputes_the_vbench_runtime_fingerprint() -> None:
    design = _design()
    catalog = _catalog(design)
    drift = _bundle(catalog, design)
    drift["vbench_runtime_report"]["runtime_digest"] = "f" * 64  # type: ignore[index]

    with pytest.raises(CompleteD1Error, match="runtime report digest is inconsistent"):
        build_complete_d1_report(drift, calibration_catalog=catalog, design=design)


def test_complete_d1_cli_emits_decided_report(tmp_path: Path) -> None:
    design = _design()
    catalog = _catalog(design)
    bundle_path = tmp_path / "bundle.json"
    catalog_path = tmp_path / "catalog.json"
    design_path = tmp_path / "design.json"
    bundle_path.write_text(json.dumps(_bundle(catalog, design)), encoding="utf-8")
    catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
    design_path.write_text(json.dumps(design), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "complete-d1",
            "--bundle",
            str(bundle_path),
            "--catalog",
            str(catalog_path),
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
    assert report["schema_version"] == "ltx-av-eval-complete-d1-report.v1"
    assert report["verdict"] == "pass"
