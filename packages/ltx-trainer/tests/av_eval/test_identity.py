from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import IdentityMeasurementError, build_identity_measurements

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
STRATA = ["fitzpatrick.3", "lighting.standard", "pose.frontal"]


def _input() -> dict[str, object]:
    pairs: list[dict[str, object]] = []
    for suffix in ("a", "b"):
        pairs.extend(
            [
                {
                    "pair_id": f"genuine-{suffix}",
                    "probe_identity_id": f"identity-{suffix}",
                    "reference_identity_id": f"identity-{suffix}",
                    "probe_leakage_component_id": f"component-{suffix}",
                    "strata": STRATA,
                    "similarity": 0.9,
                },
                {
                    "pair_id": f"impostor-{suffix}",
                    "probe_identity_id": f"identity-{suffix}",
                    "reference_identity_id": "identity-gallery-other",
                    "probe_leakage_component_id": f"component-{suffix}",
                    "strata": STRATA,
                    "similarity": 0.1,
                },
            ]
        )
    pairs.sort(key=lambda item: item["pair_id"])
    return {
        "schema_version": "ltx-av-eval-identity-pairs.v1",
        "dataset_digest": "a" * 64,
        "preregistration_digest": "b" * 64,
        "release_digest": "2" * 64,
        "sface_model_digest": "c" * 64,
        "preprocessing_digest": "d" * 64,
        "reference_gallery_digest": "e" * 64,
        "threshold_policy_digest": "f" * 64,
        "strata_plan_digest": "1" * 64,
        "similarity_threshold": 0.5,
        "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 11082026},
        "strata": {"registered": STRATA, "far": STRATA, "frr": STRATA},
        "pairs": pairs,
    }


def _metrics(report: dict[str, object]) -> dict[str, dict[str, object]]:
    metrics = report["metrics"]
    assert isinstance(metrics, list)
    return {metric["metric_id"]: metric for metric in metrics}


def test_identity_measurements_are_deterministic_and_cover_all_gates() -> None:
    first = build_identity_measurements(_input())
    second = build_identity_measurements(copy.deepcopy(_input()))

    assert first == second
    metrics = _metrics(first)
    assert len(metrics) == 5
    assert metrics["identity-far-ci-upper"]["ci_upper"] == 0
    assert metrics["identity-frr-ci-upper-worst-stratum"]["ci_upper"] == 0
    assert metrics["identity-tar-ci-lower"]["ci_lower"] == 1
    assert metrics["identity-tar-ci-lower"]["independent_units"] == 2


def test_identity_measurements_derive_decisions_from_similarity_and_threshold() -> None:
    evidence = _input()
    pairs = evidence["pairs"]
    assert isinstance(pairs, list)
    pairs[0]["similarity"] = 0.2
    pairs[2]["similarity"] = 0.8
    metrics = _metrics(build_identity_measurements(evidence))

    assert metrics["identity-frr-ci-upper"]["estimate"] > 0
    assert metrics["identity-far-ci-upper"]["estimate"] > 0
    assert metrics["identity-tar-ci-lower"]["estimate"] < 1


def test_identity_measurements_require_critical_strata_and_independent_units() -> None:
    missing_skin_tone = _input()
    strata = missing_skin_tone["strata"]
    assert isinstance(strata, dict)
    for key in ("registered", "far", "frr"):
        strata[key] = [value for value in strata[key] if not value.startswith("fitzpatrick.")]
    pairs = missing_skin_tone["pairs"]
    assert isinstance(pairs, list)
    for pair in pairs:
        pair["strata"] = [value for value in pair["strata"] if not value.startswith("fitzpatrick.")]
    with pytest.raises(IdentityMeasurementError, match="registered fitzpatrick stratum"):
        build_identity_measurements(missing_skin_tone)

    one_component = _input()
    pairs = one_component["pairs"]
    assert isinstance(pairs, list)
    for pair in pairs:
        pair["probe_leakage_component_id"] = "component-a"
    with pytest.raises(IdentityMeasurementError, match="two independent probe leakage components"):
        build_identity_measurements(one_component)


def test_identity_measurements_reject_identity_component_drift_and_unbound_threshold() -> None:
    drift = _input()
    pairs = drift["pairs"]
    assert isinstance(pairs, list)
    matching_probe = pairs[0]["probe_identity_id"]
    peer = next(pair for pair in pairs if pair["probe_identity_id"] == matching_probe and pair is not pairs[0])
    peer["probe_leakage_component_id"] = "component-drift"
    with pytest.raises(IdentityMeasurementError, match="maps to multiple leakage components"):
        build_identity_measurements(drift)

    invalid_threshold = _input()
    invalid_threshold["similarity_threshold"] = 1.1
    with pytest.raises(IdentityMeasurementError, match="similarity_threshold must be between"):
        build_identity_measurements(invalid_threshold)


def test_identity_cli_emits_digest_bound_measurements(tmp_path: Path) -> None:
    input_path = tmp_path / "pairs.json"
    input_path.write_text(json.dumps(_input()), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "identity-score",
            "--pairs",
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
    assert report["schema_version"] == "ltx-av-eval-identity-measurements.v1"
    assert report["reference_gallery_digest"] == "e" * 64
