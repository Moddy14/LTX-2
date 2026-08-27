from __future__ import annotations

import copy
import json
import math
import os
import subprocess
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

import pytest
from test_offset_calibration import _anchors, _built_context, _context

from ltx_trainer.av_eval import OffsetMeasurementError, build_offset_measurements, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


def _score(
    observations: dict[str, Any],
    *,
    deck: dict[str, Any] | None = None,
    calibrator: dict[str, Any] | None = None,
) -> dict[str, Any]:
    base_deck, base_calibrator, _observation_deck, _observations = _built_context()
    return build_offset_measurements(
        observations,
        control_deck=base_deck if deck is None else deck,
        calibrator=base_calibrator if calibrator is None else calibrator,
        **_anchors(),
    )


@lru_cache(maxsize=1)
def _report() -> dict[str, Any]:
    deck, calibrator, _observation_deck, observations = _built_context()
    return build_offset_measurements(
        observations,
        control_deck=deck,
        calibrator=calibrator,
        **_anchors(),
    )


def _metrics(report: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {metric["metric_id"]: metric for metric in report["metrics"]}


def test_real_powered_measurements_are_deterministic_and_component_exact() -> None:
    first = _report()
    deck, calibrator, _observation_deck, observations = _built_context()
    second = build_offset_measurements(
        copy.deepcopy(observations),
        control_deck=deck,
        calibrator=calibrator,
        **_anchors(),
    )
    assert first == second
    required_units = deck["power_report"]["required_independent_units"]
    assert first["required_independent_units"] == required_units
    assert first["component_weighting"] == "equal-total-weight-per-transitive-component.v1"
    assert first["uncertainty_method"] == "component-clopper-pearson-plus-cluster-bootstrap-simultaneous-strata.v2"
    assert first["calibration_abstention_semantics"].startswith("conditional-on-non-abstained")
    assert first["grid_replicates_per_cell"] == 1
    metrics = _metrics(first)
    assert len(metrics) == 16
    assert metrics["av-correspondence-far-ci-upper"]["independent_units"] == required_units
    expected_zero_event_upper = 1 - math.pow(0.025, 1 / required_units)
    assert metrics["av-correspondence-far-ci-upper"]["ci_upper"] == pytest.approx(expected_zero_event_upper)
    assert metrics["av-correspondence-far-ci-upper-worst-stratum"]["independent_units"] == required_units // 6
    assert metrics["av-correspondence-far-ci-upper-worst-stratum"]["ci_upper"] > 0.03
    assert metrics["av-ood-abstention-recall-ci-lower"]["ci_lower"] > 0.99


@pytest.mark.parametrize("field", ["raw_score_threshold", "calibration_policy_digest", "design_report_digest"])
def test_scorer_rejects_tampered_threshold_calibrator_and_design_bindings(field: str) -> None:
    _deck, _calibrator, _observation_deck, observations = _context()
    observations[field] = 0.4 if field == "raw_score_threshold" else "f" * 64
    with pytest.raises(OffsetMeasurementError, match="scoring contract rejected"):
        _score(observations)


def test_scorer_recomputes_every_probability_from_the_bound_calibrator() -> None:
    _deck, _calibrator, _observation_deck, observations = _context()
    case = next(case for case in observations["calibration_cases"] if case["raw_score"] == 0.9)
    case["correspondence_probability"] = 0.25
    with pytest.raises(OffsetMeasurementError, match="probability is not calibrator-derived"):
        _score(observations)

    _deck, _calibrator, _observation_deck, observations = _context()
    case = next(case for case in observations["calibration_cases"] if case["raw_score"] == 0.9)
    case["raw_score"] = 0.1
    with pytest.raises(OffsetMeasurementError, match="probability is not calibrator-derived"):
        _score(observations)


def test_rehashed_calibrator_cannot_replace_the_canonical_deterministic_fit() -> None:
    deck, calibrator, _observation_deck, observations = _context()
    calibrator["knots"][0]["correspondence_probability"] = 0.2
    core = {key: value for key, value in calibrator.items() if key != "calibrator_sha256"}
    calibrator["calibrator_sha256"] = document_sha256(core)
    observations["calibration_policy_digest"] = calibrator["calibrator_sha256"]
    with pytest.raises(OffsetMeasurementError, match="not the canonical deterministic fit"):
        _score(observations, deck=deck, calibrator=calibrator)


def test_score_rejects_missing_or_duplicated_grid_cells_before_statistics() -> None:
    _deck, _calibrator, _observation_deck, missing = _context()
    missing["calibration_cases"].pop()
    with pytest.raises(OffsetMeasurementError, match="exactly one balanced"):
        _score(missing)

    _deck, _calibrator, _observation_deck, duplicated = _context()
    duplicate = copy.deepcopy(duplicated["calibration_cases"][0])
    duplicate["replicate_id"] += "-extra"
    duplicate["case_id"] = document_sha256(
        {
            "correspondence_label": duplicate["correspondence_label"],
            "fps": duplicate["fps"],
            "offset_kind": duplicate["offset_kind"],
            "replicate_id": duplicate["replicate_id"],
            "source_sample_id": duplicate["source_sample_id"],
        }
    )
    duplicated["calibration_cases"].append(duplicate)
    duplicated["calibration_cases"].sort(key=lambda case: case["case_id"])
    with pytest.raises(OffsetMeasurementError, match="exactly one balanced"):
        _score(duplicated)


def test_score_rejects_output_substitution_and_split_digest_substitution() -> None:
    _deck, _calibrator, _observation_deck, observations = _context()
    observations["output_split_manifest_digest"] = observations["evaluation_split_manifest_digest"]
    with pytest.raises(OffsetMeasurementError, match="output_split_manifest_digest mismatch"):
        _score(observations)

    _deck, _calibrator, _observation_deck, observations = _context()
    output = observations["output_cases"][0]
    calibration_source = observations["calibration_cases"][0]["source_sample_id"]
    output["source_sample_id"] = calibration_source
    with pytest.raises(OffsetMeasurementError, match="absent from the frozen test split"):
        _score(observations)


def test_abstentions_are_excluded_from_calibration_but_gated_separately() -> None:
    _deck, _calibrator, _observation_deck, observations = _context()
    case = next(
        case
        for case in observations["calibration_cases"]
        if case["in_domain"] and case["correspondence_label"] is True
    )
    case["predicted_offset_ms"] = None
    case["raw_score"] = None
    case["correspondence_probability"] = None
    report = _score(observations)
    metrics = _metrics(report)
    assert metrics["av-brier-score"]["estimate"] == 0
    assert metrics["av-calibration-ece"]["estimate"] == 0
    assert metrics["av-in-domain-false-abstention-ci-upper"]["estimate"] > 0
    assert metrics["av-in-domain-false-abstention-ci-upper"]["ci_upper"] > 0


def test_non_finite_unknown_and_oversized_score_inputs_fail_closed() -> None:
    _deck, _calibrator, _observation_deck, observations = _context()
    observations["calibration_cases"][0]["raw_score"] = float("nan")
    with pytest.raises(OffsetMeasurementError, match="finite number"):
        _score(observations)

    _deck, _calibrator, _observation_deck, observations = _context()
    observations["unexpected"] = True
    with pytest.raises(OffsetMeasurementError, match=r"unknown=.*unexpected"):
        _score(observations)

    _deck, _calibrator, _observation_deck, observations = _context()
    observations["calibration_cases"] = [{}] * 900_001
    with pytest.raises(OffsetMeasurementError, match="2 to 900000"):
        _score(observations)


def test_offset_score_cli_requires_deck_calibrator_and_external_anchors(tmp_path: Path) -> None:
    deck, calibrator, _observation_deck, observations = _built_context()
    paths = {
        "observations": tmp_path / "observations.json",
        "deck": tmp_path / "deck.json",
        "calibrator": tmp_path / "calibrator.json",
    }
    paths["observations"].write_text(json.dumps(observations), encoding="utf-8")
    paths["deck"].write_text(json.dumps(deck), encoding="utf-8")
    paths["calibrator"].write_text(json.dumps(calibrator), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "offset-score",
            "--observations",
            str(paths["observations"]),
            "--deck",
            str(paths["deck"]),
            "--calibrator",
            str(paths["calibrator"]),
            "--expected-dataset-digest",
            _anchors()["expected_dataset_digest"],
            "--trusted-preregistration-digest",
            _anchors()["trusted_preregistration_digest"],
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["schema_version"] == "ltx-av-eval-offset-measurements.v2"
    assert report["design_report_digest"] == document_sha256(deck["power_report"])
