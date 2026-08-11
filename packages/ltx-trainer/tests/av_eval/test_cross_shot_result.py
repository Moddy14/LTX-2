from __future__ import annotations

import json
from pathlib import Path

import pytest

from ltx_trainer.av_eval import CrossShotResultError, build_cross_shot_decision, build_power_report, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
DESIGN_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v1.json"
PROTOCOL_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "cross-shot-protocol.v1.json"
CLAIMS = ("reference-video-redubbing.native-distilled", "reference-video-redubbing.official-comfy-hq")
ARMS = ("automatic-scene-reference", "manual-scene-reference", "no-reference")


def _design() -> dict[str, object]:
    design = json.loads(DESIGN_PATH.read_text(encoding="utf-8"))
    design["status"] = "frozen"
    design["design_effect"] = 1.0
    for metric in design["delta_catalog"]["metrics"]:
        metric["delta"] = 0.05
        metric["basis_evidence_sha256"] = "a" * 64
    vbench = design["vbench_gate_catalog"]
    vbench["commit"] = "b" * 64
    vbench["config_sha256"] = "c" * 64
    for gate in vbench["gates"]:
        gate["absolute_minimum"] = 0.5
        gate["delta"] = 0.05
        gate["basis_evidence_sha256"] = "d" * 64
    for endpoint in design["power_endpoints"]:
        endpoint["max_ci_width"] = 0.5
        if endpoint["model"] == "paired-mean":
            endpoint["effect"] = 0.5
            endpoint["variability"] = 0.1
        elif endpoint["model"] == "binomial-upper":
            endpoint["alternative"] = 0.0
        else:
            endpoint["alternative"] = 1.0
    for quota in design["strata_quotas"]:
        quota["minimum_independent_units"] = 1
    return design


def _protocol(design: dict[str, object]) -> dict[str, object]:
    protocol = json.loads(PROTOCOL_PATH.read_text(encoding="utf-8"))
    report = build_power_report(design)
    required = report["required_independent_units"]
    assert isinstance(required, int)
    protocol["status"] = "frozen"
    protocol["sample_plan"]["required_identities"] = required
    for binding in protocol["bindings"]:
        binding["sha256"] = "e" * 64
        if binding["artifact_id"] == "design_report":
            binding["sha256"] = document_sha256(report)
    for arm in protocol["arms"]:
        if arm["reference_strategy"] != "none":
            arm["strategy_artifact_sha256"] = "f" * 64
    for endpoint in protocol["endpoint_bindings"]:
        endpoint["delta_basis_sha256"] = report["delta_catalog_digest"]
    return protocol


def _measurements(arm_id: str) -> dict[str, float]:
    level = {"no-reference": 0.6, "manual-scene-reference": 0.8, "automatic-scene-reference": 0.9}[arm_id]
    lower = {"no-reference": 0.1, "manual-scene-reference": 0.04, "automatic-scene-reference": 0.02}[arm_id]
    return {
        "asr-critical-name-accuracy": 0.99,
        "asr-critical-negation-accuracy": 0.99,
        "asr-critical-number-accuracy": 0.99,
        "asr-word-error-rate": lower,
        "av-sync-offset-p95": 40.0,
        "cross-shot-min-identity-probability": level,
        "face-sharpness-relative": level * 100,
        "face-track-coverage": 1.0,
        "lip-sync-mos": level * 10,
        "mouth-artifact-rate": 0.0,
        "mouth-naturalness-mos": level * 10,
        "mouth-opening-rounding": 0.95,
        "phoneme-viseme-pbm": 0.95,
        "skin-nose-mouth-stability": level,
        "vbench-aesthetic-quality": 0.9,
        "vbench-background-consistency": 0.9,
        "vbench-dynamic-degree": 0.9,
        "vbench-imaging-quality": 0.9,
        "vbench-motion-smoothness": 0.9,
        "vbench-subject-consistency": 0.9,
    }


def _results(protocol: dict[str, object], design: dict[str, object]) -> dict[str, object]:
    rows: list[dict[str, object]] = []
    seeds = protocol["sample_plan"]["generation_seeds"]  # type: ignore[index]
    identities = protocol["sample_plan"]["required_identities"]  # type: ignore[index]
    assert isinstance(identities, int)
    for claim_index, claim_id in enumerate(CLAIMS):
        for identity_index in range(identities):
            for shot_index in range(2):
                for seed in seeds:
                    for arm_index, arm_id in enumerate(ARMS):
                        rows.append(
                            {
                                "row_id": f"row-{claim_index}-{identity_index:02d}-{shot_index}-{seed}-{arm_index}",
                                "identity_id": f"identity-{identity_index:02d}",
                                "leakage_component_id": f"component-{identity_index:02d}",
                                "claim_id": claim_id,
                                "shot_id": f"shot-{shot_index}",
                                "generation_seed": seed,
                                "arm_id": arm_id,
                                "status": "completed",
                                "measurements": _measurements(arm_id),
                            }
                        )
    rows.sort(key=lambda row: row["row_id"])
    absolute = [
        {
            "claim_id": claim_id,
            "arm_id": arm_id,
            "evidence_digest": "9" * 64,
            "passed_measurement_ids": sorted(_measurements(arm_id)),
        }
        for claim_id in CLAIMS
        for arm_id in sorted(ARMS)
    ]
    return {
        "schema_version": "ltx-av-eval-cross-shot-results.v1",
        "protocol_digest": document_sha256(protocol),
        "design_digest": document_sha256(design),
        "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 11082026},
        "absolute_gate_evidence": absolute,
        "rows": rows,
    }


def test_cross_shot_decision_selects_automatic_only_after_all_three_comparisons() -> None:
    design = _design()
    protocol = _protocol(design)
    report = build_cross_shot_decision(_results(protocol, design), protocol=protocol, design=design)

    assert report["verdict"] == "winner"
    required = protocol["sample_plan"]["required_identities"]  # type: ignore[index]
    assert report["rows"] == required * 2 * 3 * 3 * 2
    assert report["failed_rows"] == 0
    assert len(report["comparisons"]) == 6
    assert all(comparison["status"] == "pass" for comparison in report["comparisons"])
    assert all(selection["selected_arm_id"] == "automatic-scene-reference" for selection in report["selections"])
    assert all(selection["automatic_default_enabled"] is True for selection in report["selections"])


def test_cross_shot_decision_falls_back_to_manual_on_automatic_itt_failure() -> None:
    design = _design()
    protocol = _protocol(design)
    evidence = _results(protocol, design)
    rows = evidence["rows"]
    assert isinstance(rows, list)
    failed = next(row for row in rows if row["claim_id"] == CLAIMS[0] and row["arm_id"] == "automatic-scene-reference")
    failed["status"] = "failed"
    failed["measurements"] = None
    report = build_cross_shot_decision(evidence, protocol=protocol, design=design)
    selections = {selection["claim_id"]: selection for selection in report["selections"]}

    assert report["failed_rows"] == 1
    assert selections[CLAIMS[0]]["selected_arm_id"] == "manual-scene-reference"
    assert selections[CLAIMS[0]]["automatic_default_enabled"] is False
    assert any(
        comparison["claim_id"] == CLAIMS[0] and comparison["status"] == "failed-itt"
        for comparison in report["comparisons"]
    )


def test_cross_shot_decision_rejects_incomplete_factorial_and_measurement_inventory() -> None:
    design = _design()
    protocol = _protocol(design)
    incomplete = _results(protocol, design)
    incomplete["rows"] = incomplete["rows"][:-1]  # type: ignore[index]
    with pytest.raises(CrossShotResultError, match="complete paired factorial"):
        build_cross_shot_decision(incomplete, protocol=protocol, design=design)

    missing_measurement = _results(protocol, design)
    rows = missing_measurement["rows"]
    assert isinstance(rows, list)
    rows[0]["measurements"].pop("face-track-coverage")
    with pytest.raises(CrossShotResultError, match="exactly cover the Q0 inventory"):
        build_cross_shot_decision(missing_measurement, protocol=protocol, design=design)

    pseudoreplicated = _results(protocol, design)
    rows = pseudoreplicated["rows"]
    assert isinstance(rows, list)
    for row in rows:
        if row["identity_id"] == "identity-01":
            row["leakage_component_id"] = "component-00"
    with pytest.raises(CrossShotResultError, match="independent-component count"):
        build_cross_shot_decision(pseudoreplicated, protocol=protocol, design=design)


def test_cross_shot_decision_rejects_result_protocol_drift() -> None:
    design = _design()
    protocol = _protocol(design)
    evidence = _results(protocol, design)
    evidence["protocol_digest"] = "0" * 64
    with pytest.raises(CrossShotResultError, match="protocol digest mismatch"):
        build_cross_shot_decision(evidence, protocol=protocol, design=design)
