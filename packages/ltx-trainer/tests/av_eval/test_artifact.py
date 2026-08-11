from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import ArtifactMeasurementError, build_artifact_measurements

ARTIFACT_KINDS = ("flicker", "foreign-mouth", "nose-jump", "skewed-mouth", "skin-wobble")
REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


def _input() -> dict[str, object]:
    observations: list[dict[str, object]] = []
    for component in ("a", "b"):
        observations.append(
            {
                "observation_id": f"negative-{component}",
                "leakage_component_id": f"component-{component}",
                "strata": ["lighting.standard"],
                "annotation": None,
                "predicted_artifact": False,
                "warp_residual": 0.01,
            }
        )
        for kind in ARTIFACT_KINDS:
            observations.append(
                {
                    "observation_id": f"positive-{kind}-{component}",
                    "leakage_component_id": f"component-{component}",
                    "strata": [f"artifact-kind.{kind}", "lighting.standard"],
                    "annotation": kind,
                    "predicted_artifact": True,
                    "warp_residual": 0.02,
                }
            )
    observations.sort(key=lambda item: item["observation_id"])
    artifact_strata = [f"artifact-kind.{kind}" for kind in ARTIFACT_KINDS]
    return {
        "schema_version": "ltx-av-eval-artifact-observations.v1",
        "dataset_digest": "a" * 64,
        "preregistration_digest": "b" * 64,
        "release_digest": "e" * 64,
        "evaluator_digest": "c" * 64,
        "strata_plan_digest": "d" * 64,
        "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 23072026},
        "strata": {
            "registered": sorted([*artifact_strata, "lighting.standard"]),
            "far": ["lighting.standard"],
            "frr": sorted(artifact_strata),
            "warp": ["lighting.standard"],
        },
        "observations": observations,
    }


def _metrics(report: dict[str, object]) -> dict[str, dict[str, object]]:
    metrics = report["metrics"]
    assert isinstance(metrics, list)
    return {metric["metric_id"]: metric for metric in metrics}


def test_artifact_measurements_are_deterministic_and_cover_all_gates() -> None:
    first = build_artifact_measurements(_input())
    second = build_artifact_measurements(copy.deepcopy(_input()))

    assert first == second
    assert first["frame_warp_limit"] == 0.04
    metrics = _metrics(first)
    assert len(metrics) == 7
    assert metrics["artifact-event-far-ci-upper"]["ci_upper"] == 0
    assert metrics["artifact-event-frr-ci-upper-worst-stratum"]["ci_upper"] == 0
    assert metrics["artifact-frames-within-warp-limit-ci-lower"]["ci_lower"] == 1
    assert metrics["artifact-warp-residual-p95-worst-stratum"]["estimate"] == 0.02


def test_artifact_measurements_detect_false_events_and_warp_failures() -> None:
    evidence = _input()
    observations = evidence["observations"]
    assert isinstance(observations, list)
    observations[0]["predicted_artifact"] = True
    observations[-1]["predicted_artifact"] = False
    observations[-1]["warp_residual"] = 0.2
    metrics = _metrics(build_artifact_measurements(evidence))

    assert metrics["artifact-event-far-ci-upper"]["estimate"] > 0
    assert metrics["artifact-event-frr-ci-upper"]["estimate"] > 0
    assert metrics["artifact-frames-within-warp-limit-ci-lower"]["estimate"] < 1
    assert metrics["artifact-warp-residual-p95"]["estimate"] > 0.02


def test_artifact_measurements_require_every_artifact_kind_and_independent_units() -> None:
    missing_kind = _input()
    missing_kind["strata"]["frr"] = missing_kind["strata"]["frr"][:-1]  # type: ignore[index]
    with pytest.raises(ArtifactMeasurementError, match="all five required artifact kinds"):
        build_artifact_measurements(missing_kind)

    one_component = _input()
    observations = one_component["observations"]
    assert isinstance(observations, list)
    for observation in observations:
        observation["leakage_component_id"] = "component-a"
    with pytest.raises(ArtifactMeasurementError, match="two independent leakage components"):
        build_artifact_measurements(one_component)

    one_component_warp_stratum = _input()
    observations = one_component_warp_stratum["observations"]
    assert isinstance(observations, list)
    for observation in observations:
        if observation["leakage_component_id"] == "component-a":
            observation["strata"] = [*observation["strata"], "motion.fast"]
    strata = one_component_warp_stratum["strata"]
    assert isinstance(strata, dict)
    strata["registered"] = sorted([*strata["registered"], "motion.fast"])
    strata["warp"] = ["motion.fast"]
    with pytest.raises(ArtifactMeasurementError, match=r"warp:motion\.fast needs at least two"):
        build_artifact_measurements(one_component_warp_stratum)


def test_artifact_measurements_reject_unbound_labels_and_nonfinite_residuals() -> None:
    unbound = _input()
    observations = unbound["observations"]
    assert isinstance(observations, list)
    positive = next(item for item in observations if item["annotation"] is not None)
    positive["strata"] = ["lighting.standard"]
    with pytest.raises(ArtifactMeasurementError, match="does not bind its artifact-kind stratum"):
        build_artifact_measurements(unbound)

    nonfinite = _input()
    nonfinite["observations"][0]["warp_residual"] = float("nan")  # type: ignore[index]
    with pytest.raises(ArtifactMeasurementError, match="must be finite"):
        build_artifact_measurements(nonfinite)


def test_artifact_cli_emits_digest_bound_measurements(tmp_path: Path) -> None:
    input_path = tmp_path / "observations.json"
    input_path.write_text(json.dumps(_input()), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "artifact-score",
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
    assert report["schema_version"] == "ltx-av-eval-artifact-measurements.v1"
    assert report["dataset_digest"] == "a" * 64
