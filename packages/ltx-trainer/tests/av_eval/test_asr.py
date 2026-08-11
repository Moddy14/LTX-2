from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import AsrMeasurementError, build_asr_measurements

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]


def _token(token: str, critical_kind: str | None = None) -> dict[str, str | None]:
    return {"token": token, "critical_kind": critical_kind}


def _observations() -> dict[str, object]:
    reference_a = [_token("anna", "name"), _token("hat"), _token("nicht", "negation"), _token("42", "number")]
    reference_b = [_token("berta", "name"), _token("sagt"), _token("nie", "negation"), _token("7", "number")]
    return {
        "schema_version": "ltx-av-eval-asr-observations.v1",
        "dataset_digest": "a" * 64,
        "preregistration_digest": "b" * 64,
        "asr_model_digest": "c" * 64,
        "normalization_digest": "d" * 64,
        "strata_plan_digest": "e" * 64,
        "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 23072026},
        "registered_strata": ["language.de"],
        "critical_strata": {
            "name": ["language.de"],
            "negation": ["language.de"],
            "number": ["language.de"],
        },
        "observations": [
            {
                "sample_id": "sample-a",
                "leakage_component_id": "component-a",
                "strata": ["language.de"],
                "reference": reference_a,
                "hypothesis": [item["token"] for item in reference_a],
            },
            {
                "sample_id": "sample-b",
                "leakage_component_id": "component-b",
                "strata": ["language.de"],
                "reference": reference_b,
                "hypothesis": [item["token"] for item in reference_b],
            },
        ],
    }


def _metrics(report: dict[str, object]) -> dict[str, dict[str, object]]:
    metrics = report["metrics"]
    assert isinstance(metrics, list)
    return {metric["metric_id"]: metric for metric in metrics}


def test_asr_measurements_are_deterministic_and_keep_critical_types_separate() -> None:
    first = build_asr_measurements(_observations())
    second = build_asr_measurements(copy.deepcopy(_observations()))

    assert first == second
    assert first["independent_units"] == 2
    metrics = _metrics(first)
    assert set(metrics) == {
        "asr-critical-name-accuracy-ci-lower",
        "asr-critical-negation-accuracy-ci-lower",
        "asr-critical-number-accuracy-ci-lower",
        "asr-wer-ci-upper",
        "asr-wer-ci-upper-worst-stratum",
        "asr-wer-estimate",
        "asr-wer-estimate-worst-stratum",
    }
    assert metrics["asr-wer-estimate"]["estimate"] == 0
    assert metrics["asr-critical-name-accuracy-ci-lower"]["ci_lower"] == 1


def test_asr_alignment_counts_insertions_and_critical_substitutions() -> None:
    observations = _observations()
    rows = observations["observations"]
    assert isinstance(rows, list)
    rows[0]["hypothesis"] = ["anne", "hat", "doch", "41", "heute"]
    report = build_asr_measurements(observations)
    metrics = _metrics(report)

    assert metrics["asr-wer-estimate"]["estimate"] == 0.5
    assert metrics["asr-critical-name-accuracy-ci-lower"]["estimate"] == 0.5
    assert metrics["asr-critical-negation-accuracy-ci-lower"]["estimate"] == 0.5
    assert metrics["asr-critical-number-accuracy-ci-lower"]["estimate"] == 0.5


def test_asr_measurements_reject_missing_critical_coverage_and_pseudoreplication() -> None:
    missing = _observations()
    rows = missing["observations"]
    assert isinstance(rows, list)
    for row in rows:
        for token in row["reference"]:
            if token["critical_kind"] == "negation":
                token["critical_kind"] = None
    with pytest.raises(AsrMeasurementError, match="no critical-token denominator"):
        build_asr_measurements(missing)

    pseudoreplicated = _observations()
    rows = pseudoreplicated["observations"]
    assert isinstance(rows, list)
    rows[1]["leakage_component_id"] = "component-a"
    with pytest.raises(AsrMeasurementError, match="two independent leakage components"):
        build_asr_measurements(pseudoreplicated)

    one_critical_component = _observations()
    rows = one_critical_component["observations"]
    assert isinstance(rows, list)
    for token in rows[1]["reference"]:
        if token["critical_kind"] == "number":
            token["critical_kind"] = None
    with pytest.raises(AsrMeasurementError, match="two independent leakage components"):
        build_asr_measurements(one_critical_component)


def test_asr_measurements_reject_ambiguous_or_unnormalized_tokens() -> None:
    ambiguous = _observations()
    rows = ambiguous["observations"]
    assert isinstance(rows, list)
    rows[0]["reference"].append(_token("anna"))
    with pytest.raises(AsrMeasurementError, match="inconsistently"):
        build_asr_measurements(ambiguous)

    unnormalized = _observations()
    rows = unnormalized["observations"]
    assert isinstance(rows, list)
    rows[0]["hypothesis"][0] = "Anna"
    with pytest.raises(AsrMeasurementError, match="case-folded"):
        build_asr_measurements(unnormalized)


def test_asr_cli_emits_digest_bound_measurements(tmp_path: Path) -> None:
    input_path = tmp_path / "observations.json"
    input_path.write_text(json.dumps(_observations()), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "asr-score",
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
    assert report["schema_version"] == "ltx-av-eval-asr-measurements.v1"
    assert report["dataset_digest"] == "a" * 64
