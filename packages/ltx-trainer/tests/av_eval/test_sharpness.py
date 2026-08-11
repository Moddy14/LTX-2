from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import SharpnessMeasurementError, build_sharpness_measurements

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


def _input() -> dict[str, object]:
    return {
        "schema_version": "ltx-av-eval-sharpness-observations.v1",
        "dataset_digest": "a" * 64,
        "preregistration_digest": "b" * 64,
        "sharpness_evaluator_digest": "c" * 64,
        "face_alignment_policy_digest": "d" * 64,
        "strata_plan_digest": "e" * 64,
        "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 11082026},
        "canonical_crop": {
            "width": 256,
            "height": 256,
            "color_space": "grayscale-linear",
            "interpolation": "area",
        },
        "registered_strata": ["lighting.standard"],
        "observations": [
            {
                "observation_id": "face-a",
                "leakage_component_id": "component-a",
                "strata": ["lighting.standard"],
                "canonical_laplacian_variance": 90.0,
            },
            {
                "observation_id": "face-b",
                "leakage_component_id": "component-b",
                "strata": ["lighting.standard"],
                "canonical_laplacian_variance": 100.0,
            },
        ],
    }


def test_sharpness_measurements_are_deterministic_and_identity_balanced() -> None:
    first = build_sharpness_measurements(_input())
    second = build_sharpness_measurements(copy.deepcopy(_input()))

    assert first == second
    assert first["statistic"] == "p10-of-leakage-component-medians"
    metric = first["metrics"][0]
    assert metric["metric_id"] == "sharpness-relative-face-ci-lower"
    assert metric["estimate"] == pytest.approx(91.0)
    assert metric["ci_lower"] == 90.0
    assert metric["independent_units"] == 2


def test_sharpness_measurements_select_the_worst_registered_stratum() -> None:
    evidence = _input()
    evidence["registered_strata"] = ["lighting.difficult", "lighting.standard"]
    observations = evidence["observations"]
    assert isinstance(observations, list)
    observations.extend(
        [
            {
                "observation_id": "face-c",
                "leakage_component_id": "component-a",
                "strata": ["lighting.difficult"],
                "canonical_laplacian_variance": 70.0,
            },
            {
                "observation_id": "face-d",
                "leakage_component_id": "component-b",
                "strata": ["lighting.difficult"],
                "canonical_laplacian_variance": 80.0,
            },
        ]
    )
    metric = build_sharpness_measurements(evidence)["metrics"][0]

    assert metric["decision_stratum_id"] == "lighting.difficult"
    assert metric["ci_lower"] == 70.0


def test_sharpness_measurements_require_fixed_crop_and_independent_units() -> None:
    changed_crop = _input()
    changed_crop["canonical_crop"]["width"] = 512  # type: ignore[index]
    with pytest.raises(SharpnessMeasurementError, match="fixed 256px"):
        build_sharpness_measurements(changed_crop)

    one_component = _input()
    observations = one_component["observations"]
    assert isinstance(observations, list)
    observations[1]["leakage_component_id"] = "component-a"
    with pytest.raises(SharpnessMeasurementError, match="two independent leakage components"):
        build_sharpness_measurements(one_component)


def test_sharpness_measurements_reject_nonfinite_values_and_unregistered_strata() -> None:
    nonfinite = _input()
    nonfinite["observations"][0]["canonical_laplacian_variance"] = float("nan")  # type: ignore[index]
    with pytest.raises(SharpnessMeasurementError, match="finite number"):
        build_sharpness_measurements(nonfinite)

    unregistered = _input()
    unregistered["observations"][0]["strata"] = ["lighting.unknown"]  # type: ignore[index]
    with pytest.raises(SharpnessMeasurementError, match="unregistered stratum"):
        build_sharpness_measurements(unregistered)


def test_sharpness_cli_emits_digest_bound_measurements(tmp_path: Path) -> None:
    input_path = tmp_path / "observations.json"
    input_path.write_text(json.dumps(_input()), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "sharpness-score",
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
    assert report["schema_version"] == "ltx-av-eval-sharpness-measurements.v1"
    assert report["sharpness_evaluator_digest"] == "c" * 64
