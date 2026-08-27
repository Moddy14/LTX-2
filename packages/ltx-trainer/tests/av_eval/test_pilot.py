from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import (
    PilotError,
    build_design_pilot_binding_report,
    build_design_pilot_report,
    document_sha256,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
DESIGN_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v2.json"


def _observations(*, units: int = 3, repeats: int = 2) -> dict[str, object]:
    catalog = [
        {"endpoint_id": "artifact-false-accept", "model": "binomial-upper"},
        {"endpoint_id": "identity-superiority", "model": "paired-mean"},
    ]
    rows: list[dict[str, object]] = []
    for endpoint in catalog:
        endpoint_id = endpoint["endpoint_id"]
        for unit_index in range(units):
            unit_id = f"unit-{unit_index:02d}"
            for replicate_id in range(1, repeats + 1):
                if endpoint_id == "artifact-false-accept":
                    reference = float((unit_index + replicate_id) % 2)
                    candidate = 0.0
                else:
                    reference = 0.50 + unit_index * 0.01 + replicate_id * 0.001
                    candidate = reference + 0.04 + unit_index * 0.005 + replicate_id * 0.002
                for arm, value in (("candidate", candidate), ("reference", reference)):
                    rows.append(
                        {
                            "observation_id": f"{endpoint_id}.{unit_id}.{replicate_id}.{arm}",
                            "endpoint_id": endpoint_id,
                            "independent_unit_id": unit_id,
                            "leakage_component_id": f"component-{unit_index:02d}",
                            "replicate_id": replicate_id,
                            "arm": arm,
                            "value": value,
                        }
                    )
    rows.sort(
        key=lambda row: (
            row["endpoint_id"],
            row["independent_unit_id"],
            row["leakage_component_id"],
            row["replicate_id"],
            row["arm"],
            row["observation_id"],
        )
    )
    # IDs are a second canonical identity list and therefore have to be sorted too.
    for index, row in enumerate(rows):
        row["observation_id"] = f"observation-{index:04d}"
    return {
        "schema_version": "ltx-sota-design-pilot-observations.v2",
        "split_role": "design-pilot",
        "frozen_dataset_digest": "a" * 64,
        "split_assignment_digest": "b" * 64,
        "leakage_audit_digest": "c" * 64,
        "evaluator_bundle_digest": "d" * 64,
        "minimum_independent_units": units,
        "minimum_repeats_per_unit": repeats,
        "endpoint_catalog": catalog,
        "observations": rows,
    }


def _ready_design_and_observations() -> tuple[dict[str, object], dict[str, object]]:  # noqa: PLR0912
    design = json.loads(DESIGN_PATH.read_text(encoding="utf-8"))
    design["status"] = "frozen"
    design["design_effect"] = 2.0
    for metric in design["delta_catalog"]["metrics"]:
        metric["delta"] = 0.05
        metric["basis_evidence_sha256"] = "a" * 64
    vbench = design["vbench_gate_catalog"]
    vbench["commit"] = "b" * 40
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
        quota["minimum_independent_units"] = 3

    endpoint_catalog = [
        {"endpoint_id": endpoint["endpoint_id"], "model": endpoint["model"]}
        for endpoint in design["power_endpoints"]
    ]
    rows: list[dict[str, object]] = []
    for endpoint in endpoint_catalog:
        endpoint_id = endpoint["endpoint_id"]
        for unit_index in range(3):
            for replicate_id in range(1, 3):
                reference = float((unit_index + replicate_id) % 2)
                if endpoint["model"] == "binomial-upper":
                    candidate = 0.0
                elif endpoint["model"] == "binomial-lower":
                    candidate = 1.0
                else:
                    reference = 0.50 + unit_index * 0.01 + replicate_id * 0.001
                    candidate = reference + 0.04 + unit_index * 0.005 + replicate_id * 0.002
                for arm, value in (("candidate", candidate), ("reference", reference)):
                    rows.append(
                        {
                            "observation_id": "pending",
                            "endpoint_id": endpoint_id,
                            "independent_unit_id": f"unit-{unit_index:02d}",
                            "leakage_component_id": f"component-{unit_index:02d}",
                            "replicate_id": replicate_id,
                            "arm": arm,
                            "value": value,
                        }
                    )
    rows.sort(
        key=lambda row: (
            row["endpoint_id"],
            row["independent_unit_id"],
            row["leakage_component_id"],
            row["replicate_id"],
            row["arm"],
        )
    )
    for index, row in enumerate(rows):
        row["observation_id"] = f"observation-{index:04d}"
    observations = {
        "schema_version": "ltx-sota-design-pilot-observations.v2",
        "split_role": "design-pilot",
        "frozen_dataset_digest": "1" * 64,
        "split_assignment_digest": "2" * 64,
        "leakage_audit_digest": "3" * 64,
        "evaluator_bundle_digest": "4" * 64,
        "minimum_independent_units": 3,
        "minimum_repeats_per_unit": 2,
        "endpoint_catalog": endpoint_catalog,
        "observations": rows,
    }
    return design, observations


def test_pilot_report_is_deterministic_and_covers_repeatability_and_rates() -> None:
    raw = _observations()
    first = build_design_pilot_report(raw)
    second = build_design_pilot_report(copy.deepcopy(raw))

    assert first == second
    assert first["status"] == "evidence-complete"
    assert first["blockers"] == []
    assert first["pilot_evidence_digest"] == document_sha256(raw)
    assert first["conservative_design_effect"] >= 1
    assert first["freeze_policy"] == "descriptive-only-no-automatic-delta-or-sample-size-selection"
    endpoints = {endpoint["endpoint_id"]: endpoint for endpoint in first["endpoints"]}
    assert endpoints["identity-superiority"]["planning_variability"] > 0
    assert endpoints["identity-superiority"]["cluster"]["test_retest_sd"] > 0
    rate = endpoints["artifact-false-accept"]["rates"]["candidate"]
    assert rate["events"] == 0
    assert rate["wilson95_upper"] > 0


def test_pilot_report_holds_for_underpowered_or_incomplete_endpoint_coverage() -> None:
    raw = _observations(units=3)
    raw["minimum_independent_units"] = 4
    raw["endpoint_catalog"].append({"endpoint_id": "sface-far", "model": "binomial-upper"})

    report = build_design_pilot_report(raw)

    assert report["status"] == "hold"
    assert "pilot-endpoint-missing:sface-far" in report["blockers"]
    assert "pilot-independent-units-insufficient:identity-superiority:3" in report["blockers"]


def test_pilot_rejects_incomplete_pairs_component_drift_and_nonbinary_values() -> None:
    incomplete = _observations()
    incomplete["observations"].pop(0)
    with pytest.raises(PilotError, match="incomplete candidate/reference pairs"):
        build_design_pilot_report(incomplete)

    component_drift = _observations()
    component_drift["observations"][1]["leakage_component_id"] = "component-other"
    with pytest.raises(PilotError, match="crosses leakage components"):
        build_design_pilot_report(component_drift)

    nonbinary = _observations()
    nonbinary["observations"][0]["value"] = 0.5
    with pytest.raises(PilotError, match="accepts only 0/1"):
        build_design_pilot_report(nonbinary)


def test_pilot_rejects_noncanonical_order_and_duplicate_measurements() -> None:
    unsorted = _observations()
    unsorted["observations"][0], unsorted["observations"][1] = (
        unsorted["observations"][1],
        unsorted["observations"][0],
    )
    with pytest.raises(PilotError, match="canonically sorted"):
        build_design_pilot_report(unsorted)

    duplicate = _observations()
    duplicate["observations"][1]["arm"] = duplicate["observations"][0]["arm"]
    with pytest.raises(PilotError, match="duplicate arm measurement"):
        build_design_pilot_report(duplicate)


def test_pilot_cli_emits_machine_readable_evidence(tmp_path: Path) -> None:
    input_path = tmp_path / "pilot.json"
    input_path.write_text(json.dumps(_observations()), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")

    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "pilot-score",
            "--observations",
            str(input_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["status"] == "evidence-complete"


def test_pilot_freeze_binding_prevents_optimistic_power_inputs() -> None:
    design, observations = _ready_design_and_observations()
    report = build_design_pilot_binding_report(observations, design)

    assert report["status"] == "ready-to-freeze"
    assert report["blockers"] == []
    assert report["planning_hypothesis_count"] == 265
    assert report["required_independent_units"] >= 30

    understated_cluster = copy.deepcopy(design)
    understated_cluster["design_effect"] = 1.0
    report = build_design_pilot_binding_report(observations, understated_cluster)
    assert report["status"] == "hold"
    assert "design-effect-understates-pilot" in report["blockers"]

    optimistic_rates = copy.deepcopy(observations)
    for row in optimistic_rates["observations"]:
        if row["endpoint_id"] == "artifact-false-accept" and row["arm"] == "candidate":
            row["value"] = 1.0
    report = build_design_pilot_binding_report(optimistic_rates, design)
    assert report["status"] == "hold"
    assert "alternative-more-optimistic-than-pilot:artifact-false-accept" in report["blockers"]


def test_pilot_freeze_cli_is_fail_closed(tmp_path: Path) -> None:
    design, observations = _ready_design_and_observations()
    design_path = tmp_path / "design.json"
    observations_path = tmp_path / "observations.json"
    design_path.write_text(json.dumps(design), encoding="utf-8")
    observations_path.write_text(json.dumps(observations), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")

    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "pilot-freeze-check",
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

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["status"] == "ready-to-freeze"
