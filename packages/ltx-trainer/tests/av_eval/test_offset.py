from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import OffsetMeasurementError, build_offset_measurements

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
OFFSETS = {
    "negative-multiframe": -80.0,
    "negative-one-frame": -40.0,
    "negative-subframe": -20.0,
    "positive-multiframe": 80.0,
    "positive-one-frame": 40.0,
    "positive-subframe": 20.0,
    "zero": 0.0,
}


def _input() -> dict[str, object]:
    cases: list[dict[str, object]] = []
    for suffix in ("a", "b"):
        for kind, offset in OFFSETS.items():
            cases.append(
                {
                    "case_id": f"id-{kind}-{suffix}",
                    "leakage_component_id": f"component-{suffix}",
                    "strata": ["fps.25"],
                    "in_domain": True,
                    "offset_kind": kind,
                    "expected_offset_ms": offset,
                    "predicted_offset_ms": offset,
                    "within_one_frame_probability": 1.0,
                    "frame_duration_ms": 40.0,
                }
            )
        cases.append(
            {
                "case_id": f"ood-{suffix}",
                "leakage_component_id": f"component-{suffix}",
                "strata": ["fps.25"],
                "in_domain": False,
                "offset_kind": "ood",
                "expected_offset_ms": None,
                "predicted_offset_ms": None,
                "within_one_frame_probability": None,
                "frame_duration_ms": 40.0,
            }
        )
    cases.sort(key=lambda item: item["case_id"])
    return {
        "schema_version": "ltx-av-eval-offset-observations.v1",
        "dataset_digest": "a" * 64,
        "preregistration_digest": "b" * 64,
        "offset_evaluator_digest": "c" * 64,
        "calibration_policy_digest": "d" * 64,
        "abstention_policy_digest": "e" * 64,
        "release_digest": "f" * 64,
        "strata_plan_digest": "1" * 64,
        "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 11082026},
        "registered_strata": ["fps.25"],
        "calibration_cases": cases,
        "output_cases": [
            {"output_id": "output-a", "leakage_component_id": "component-a", "estimated_offset_ms": 10.0},
            {"output_id": "output-b", "leakage_component_id": "component-b", "estimated_offset_ms": -20.0},
        ],
    }


def _metrics(report: dict[str, object]) -> dict[str, dict[str, object]]:
    metrics = report["metrics"]
    assert isinstance(metrics, list)
    return {metric["metric_id"]: metric for metric in metrics}


def test_offset_measurements_are_deterministic_and_cover_all_gates() -> None:
    first = build_offset_measurements(_input())
    second = build_offset_measurements(copy.deepcopy(_input()))

    assert first == second
    assert first["ece_bins"] == 10
    metrics = _metrics(first)
    assert len(metrics) == 9
    assert metrics["av-evaluator-p95-absolute-error-ms"]["estimate"] == 0
    assert metrics["av-evaluator-within-one-frame-ci-lower"]["ci_lower"] == 1
    assert metrics["av-brier-score"]["estimate"] == 0
    assert metrics["av-calibration-ece"]["estimate"] == 0
    assert metrics["av-ood-abstention-recall-ci-lower"]["ci_lower"] == 1
    assert metrics["av-output-offset-p95-ms"]["estimate"] == pytest.approx(19.5)


def test_offset_measurements_detect_errors_and_bad_abstention() -> None:
    evidence = _input()
    cases = evidence["calibration_cases"]
    assert isinstance(cases, list)
    first_id = next(case for case in cases if case["in_domain"])
    first_id["predicted_offset_ms"] = 200.0
    first_id["within_one_frame_probability"] = 0.99
    first_ood = next(case for case in cases if not case["in_domain"])
    first_ood["predicted_offset_ms"] = 0.0
    first_ood["within_one_frame_probability"] = 0.9
    metrics = _metrics(build_offset_measurements(evidence))

    assert metrics["av-evaluator-p95-absolute-error-ms"]["estimate"] > 0
    assert metrics["av-brier-score"]["estimate"] > 0
    assert metrics["av-ood-abstention-recall-ci-lower"]["estimate"] < 1


def test_offset_measurements_require_all_offset_kinds_and_independent_units() -> None:
    missing_kind = _input()
    cases = missing_kind["calibration_cases"]
    assert isinstance(cases, list)
    missing_kind["calibration_cases"] = [case for case in cases if case["offset_kind"] != "zero"]
    with pytest.raises(OffsetMeasurementError, match="all seven required offset kinds"):
        build_offset_measurements(missing_kind)

    one_component = _input()
    cases = one_component["calibration_cases"]
    assert isinstance(cases, list)
    for case in cases:
        case["leakage_component_id"] = "component-a"
    with pytest.raises(OffsetMeasurementError, match="needs at least two independent leakage components"):
        build_offset_measurements(one_component)


def test_offset_measurements_reject_mislabeled_offsets_and_probability_on_abstention() -> None:
    mislabeled = _input()
    cases = mislabeled["calibration_cases"]
    assert isinstance(cases, list)
    first_id = next(case for case in cases if case["offset_kind"] == "positive-subframe")
    first_id["offset_kind"] = "positive-multiframe"
    with pytest.raises(OffsetMeasurementError, match="offset_kind must be positive-subframe"):
        build_offset_measurements(mislabeled)

    probability_on_abstention = _input()
    cases = probability_on_abstention["calibration_cases"]
    assert isinstance(cases, list)
    first_ood = next(case for case in cases if not case["in_domain"])
    first_ood["within_one_frame_probability"] = 0.5
    with pytest.raises(OffsetMeasurementError, match="must not contain within-one-frame probability"):
        build_offset_measurements(probability_on_abstention)


def test_offset_cli_emits_digest_bound_measurements(tmp_path: Path) -> None:
    input_path = tmp_path / "observations.json"
    input_path.write_text(json.dumps(_input()), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "offset-score",
            "--observations",
            str(input_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 0
    report = json.loads(result.stdout)
    assert report["schema_version"] == "ltx-av-eval-offset-measurements.v1"
    assert report["offset_evaluator_digest"] == "c" * 64
