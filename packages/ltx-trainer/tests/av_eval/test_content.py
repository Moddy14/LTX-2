from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import ContentMeasurementError, build_content_measurements

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
FRAME_LABELS = ("bilabial-closure", "open", "other", "rounded")


def _input() -> dict[str, object]:
    frames: list[dict[str, object]] = []
    transitions: list[dict[str, object]] = []
    for suffix in ("a", "b"):
        for label in FRAME_LABELS:
            frames.append(
                {
                    "observation_id": f"frame-{label}-{suffix}",
                    "leakage_component_id": f"component-{suffix}",
                    "strata": ["lighting.standard"],
                    "expected_label": label,
                    "predicted_label": label,
                }
            )
        for expected in (False, True):
            name = "positive" if expected else "negative"
            transitions.append(
                {
                    "observation_id": f"transition-{name}-{suffix}",
                    "leakage_component_id": f"component-{suffix}",
                    "strata": ["lighting.standard"],
                    "expected_transition": expected,
                    "predicted_transition": expected,
                }
            )
    frames.sort(key=lambda item: item["observation_id"])
    transitions.sort(key=lambda item: item["observation_id"])
    return {
        "schema_version": "ltx-av-eval-content-observations.v1",
        "dataset_digest": "a" * 64,
        "preregistration_digest": "b" * 64,
        "content_evaluator_digest": "c" * 64,
        "annotation_policy_digest": "d" * 64,
        "strata_plan_digest": "e" * 64,
        "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 11082026},
        "registered_strata": ["lighting.standard"],
        "frames": frames,
        "transitions": transitions,
    }


def _metrics(report: dict[str, object]) -> dict[str, dict[str, object]]:
    metrics = report["metrics"]
    assert isinstance(metrics, list)
    return {metric["metric_id"]: metric for metric in metrics}


def test_content_measurements_are_deterministic_and_cover_all_gates() -> None:
    first = build_content_measurements(_input())
    second = build_content_measurements(copy.deepcopy(_input()))

    assert first == second
    assert first["frame_labels"] == list(FRAME_LABELS)
    metrics = _metrics(first)
    assert len(metrics) == 8
    assert metrics["content-frame-macro-f1-ci-lower"]["ci_lower"] == 1
    assert metrics["content-frame-macro-f1-estimate-worst-stratum"]["estimate"] == 1
    assert metrics["content-transition-f1-ci-lower-worst-stratum"]["ci_lower"] == 1


def test_content_measurements_detect_false_closures_and_missed_transitions() -> None:
    evidence = _input()
    frames = evidence["frames"]
    transitions = evidence["transitions"]
    assert isinstance(frames, list)
    assert isinstance(transitions, list)
    other = next(frame for frame in frames if frame["expected_label"] == "other")
    other["predicted_label"] = "bilabial-closure"
    positive = next(item for item in transitions if item["expected_transition"] is True)
    positive["predicted_transition"] = False
    metrics = _metrics(build_content_measurements(evidence))

    assert metrics["content-frame-macro-f1-estimate"]["estimate"] < 1
    assert metrics["content-transition-f1-estimate"]["estimate"] < 1


def test_content_measurements_require_balanced_independent_components() -> None:
    missing_label = _input()
    frames = missing_label["frames"]
    assert isinstance(frames, list)
    missing_label["frames"] = [
        frame
        for frame in frames
        if not (frame["leakage_component_id"] == "component-a" and frame["expected_label"] == "rounded")
    ]
    with pytest.raises(ContentMeasurementError, match="does not cover all fixed labels"):
        build_content_measurements(missing_label)

    one_component = _input()
    frames = one_component["frames"]
    transitions = one_component["transitions"]
    assert isinstance(frames, list)
    assert isinstance(transitions, list)
    for observation in [*frames, *transitions]:
        observation["leakage_component_id"] = "component-a"
    with pytest.raises(ContentMeasurementError, match="two independent leakage components"):
        build_content_measurements(one_component)


def test_content_measurements_reject_unregistered_strata_and_unknown_labels() -> None:
    unregistered = _input()
    frames = unregistered["frames"]
    assert isinstance(frames, list)
    frames[0]["strata"] = ["lighting.unknown"]
    with pytest.raises(ContentMeasurementError, match="unregistered stratum"):
        build_content_measurements(unregistered)

    unknown_label = _input()
    frames = unknown_label["frames"]
    assert isinstance(frames, list)
    frames[0]["predicted_label"] = "smile"
    with pytest.raises(ContentMeasurementError, match="fixed mouth-content labels"):
        build_content_measurements(unknown_label)


def test_content_cli_emits_digest_bound_measurements(tmp_path: Path) -> None:
    input_path = tmp_path / "observations.json"
    input_path.write_text(json.dumps(_input()), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "content-score",
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
    assert report["schema_version"] == "ltx-av-eval-content-measurements.v1"
    assert report["annotation_policy_digest"] == "d" * 64
