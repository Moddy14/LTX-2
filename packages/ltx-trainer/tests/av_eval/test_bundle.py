from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import D1BundleError, build_fixed_d1_report

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CATALOG_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "calibration-gates.v2.json"
BOOTSTRAP = {"replicates": 10000, "confidence_level": 0.95, "seed": 11082026}
SCHEMAS = {
    "artifact": "ltx-av-eval-artifact-measurements.v1",
    "asr": "ltx-av-eval-asr-measurements.v1",
    "content": "ltx-av-eval-content-measurements.v1",
    "identity": "ltx-av-eval-identity-measurements.v1",
    "offset": "ltx-av-eval-offset-measurements.v2",
    "sharpness": "ltx-av-eval-sharpness-measurements.v1",
}
PREFIXES = {
    "artifact": "artifact-",
    "asr": "asr-",
    "content": "content-",
    "identity": "identity-",
    "offset": "av-",
    "sharpness": "sharpness-",
}


def _catalog() -> dict[str, object]:
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    catalog["status"] = "frozen"
    catalog["design_digest"] = "a" * 64
    catalog["preregistration_digest"] = "b" * 64
    catalog["vbench_gate_catalog_digest"] = "c" * 64
    for fingerprint in catalog["evaluator_fingerprints"]:
        fingerprint["sha256"] = "d" * 64
    for gate in catalog["gates"]:
        gate["basis_evidence_sha256"] = "e" * 64
        if gate["threshold"] is None:
            gate["threshold"] = 0.75
    return catalog


def _metrics(catalog: dict[str, object], source: str) -> list[dict[str, object]]:
    result: list[dict[str, object]] = []
    for gate in catalog["gates"]:
        if gate["metric_id"].startswith(PREFIXES[source]):
            passing = 1.0 if gate["direction"] == "higher" else 0.0
            result.append(
                {
                    "metric_id": gate["metric_id"],
                    "estimate": passing,
                    "ci_lower": passing,
                    "ci_upper": passing,
                    "decision_stratum_id": "overall",
                    "independent_units": 40,
                }
            )
    return result


def _common(catalog: dict[str, object], source: str) -> dict[str, object]:
    return {
        "schema_version": SCHEMAS[source],
        "input_digest": "4" * 64,
        "dataset_digest": "1" * 64,
        "preregistration_digest": "b" * 64,
        "release_digest": "2" * 64,
        "strata_plan_digest": "3" * 64,
        "bootstrap": BOOTSTRAP,
        "metrics": _metrics(catalog, source),
    }


def _reports(catalog: dict[str, object]) -> dict[str, dict[str, object]]:
    artifact = {
        **_common(catalog, "artifact"),
        "evaluator_digest": "d" * 64,
        "frame_warp_limit": 0.04,
        "frames": 120,
        "independent_units": 40,
    }
    asr = {
        **_common(catalog, "asr"),
        "asr_model_digest": "d" * 64,
        "normalization_digest": "d" * 64,
        "independent_units": 40,
        "clips": 120,
        "strata": {},
    }
    content = {
        **_common(catalog, "content"),
        "content_evaluator_digest": "d" * 64,
        "annotation_policy_digest": "5" * 64,
        "frame_labels": ["bilabial-closure", "open", "other", "rounded"],
        "frames": 120,
        "transitions": 120,
    }
    identity = {
        **_common(catalog, "identity"),
        "sface_model_digest": "d" * 64,
        "preprocessing_digest": "d" * 64,
        "reference_gallery_digest": "6" * 64,
        "threshold_policy_digest": "7" * 64,
        "similarity_threshold": 0.5,
        "pairs": 120,
        "independent_probe_leakage_components": 40,
    }
    offset = {
        **_common(catalog, "offset"),
        "offset_evaluator_digest": "d" * 64,
        "control_deck_digest": "0" * 64,
        "dataset_manifest_digest": "5" * 64,
        "design_digest": "a" * 64,
        "design_report_digest": "6" * 64,
        "fit_split_manifest_digest": "7" * 64,
        "evaluation_split_manifest_digest": "8" * 64,
        "output_split_manifest_digest": "9" * 64,
        "calibration_policy_digest": "8" * 64,
        "operating_point_digest": "7" * 64,
        "power_report_digest": "6" * 64,
        "strata_quotas_digest": "3" * 64,
        "required_independent_units": 40,
        "raw_score_threshold": 0.5,
        "abstention_policy_digest": "9" * 64,
        "bootstrap_rng": "numpy-pcg64-derived-sha256-seeds.v1",
        "binomial_interval": "component-clopper-pearson-95-bonferroni-strata.v2",
        "uncertainty_method": "component-clopper-pearson-plus-cluster-bootstrap-simultaneous-strata.v2",
        "component_weighting": "equal-total-weight-per-transitive-component.v1",
        "calibration_abstention_semantics": (
            "conditional-on-non-abstained-with-separate-abstention-gates.v1"
        ),
        "grid_replicates_per_cell": 1,
        "ece_bins": 10,
        "calibration_cases": 120,
        "output_cases": 120,
    }
    sharpness = {
        **_common(catalog, "sharpness"),
        "sharpness_evaluator_digest": "d" * 64,
        "face_alignment_policy_digest": "f" * 64,
        "statistic": "p10-of-leakage-component-medians",
        "canonical_crop": {
            "width": 256,
            "height": 256,
            "color_space": "grayscale-linear",
            "interpolation": "area",
        },
        "observations": 120,
    }
    return {
        "artifact": artifact,
        "asr": asr,
        "content": content,
        "identity": identity,
        "offset": offset,
        "sharpness": sharpness,
    }


def _bundle(catalog: dict[str, object]) -> dict[str, object]:
    return {
        "schema_version": "ltx-av-eval-fixed-d1-bundle.v2",
        "bundle_id": "fixed-d1-candidate-01",
        "dataset_digest": "1" * 64,
        "preregistration_digest": "b" * 64,
        "release_digest": "2" * 64,
        "design_digest": "a" * 64,
        "surface_digest": "4" * 64,
        "candidate_surface_binding_digest": "5" * 64,
        "strata_plan_digest": "3" * 64,
        "bootstrap": BOOTSTRAP,
        "reports": _reports(catalog),
    }


def test_fixed_d1_bundle_is_deterministic_and_covers_all_44_gates() -> None:
    catalog = _catalog()
    bundle = _bundle(catalog)
    first = build_fixed_d1_report(bundle, calibration_catalog=catalog)
    second = build_fixed_d1_report(copy.deepcopy(bundle), calibration_catalog=copy.deepcopy(catalog))

    assert first == second
    assert first["verdict"] == "pass"
    assert len(first["metrics"]) == 44
    assert list(first["source_report_digests"]) == sorted(SCHEMAS)
    assert first["offset_contract"]["design_digest"] == bundle["design_digest"]
    assert first["offset_contract"]["output_split_manifest_digest"] == "9" * 64
    assert first["offset_contract"]["abstention_policy_digest"] == "9" * 64
    assert first["offset_contract"]["bootstrap"] == BOOTSTRAP
    assert all(metric["basis_evidence_sha256"] == "e" * 64 for metric in first["metrics"])


def test_fixed_d1_bundle_recomputes_estimate_and_bound_decisions() -> None:
    catalog = _catalog()
    bundle = _bundle(catalog)
    artifact = bundle["reports"]["artifact"]
    estimate_gate = next(
        metric for metric in artifact["metrics"] if metric["metric_id"] == "artifact-warp-residual-p95"
    )
    estimate_gate.update({"estimate": 0.03, "ci_lower": 0.02, "ci_upper": 0.2})
    bound_gate = next(metric for metric in artifact["metrics"] if metric["metric_id"] == "artifact-event-far-ci-upper")
    bound_gate.update({"estimate": 0.005, "ci_lower": 0.0, "ci_upper": 0.02})
    report = build_fixed_d1_report(bundle, calibration_catalog=catalog)
    results = {metric["metric_id"]: metric for metric in report["metrics"]}

    assert results["artifact-warp-residual-p95"]["decision"] == "pass"
    assert results["artifact-event-far-ci-upper"]["decision"] == "fail"
    assert report["verdict"] == "fail"


def test_fixed_d1_bundle_rejects_mixed_candidates_and_fingerprints() -> None:
    catalog = _catalog()
    mixed = _bundle(catalog)
    mixed["reports"]["asr"]["release_digest"] = "f" * 64
    with pytest.raises(D1BundleError, match="asr report release_digest mismatch"):
        build_fixed_d1_report(mixed, calibration_catalog=catalog)

    wrong_fingerprint = _bundle(catalog)
    wrong_fingerprint["reports"]["identity"]["sface_model_digest"] = "f" * 64
    with pytest.raises(D1BundleError, match="fingerprint sface-model"):
        build_fixed_d1_report(wrong_fingerprint, calibration_catalog=catalog)


def test_fixed_d1_bundle_rejects_missing_metrics_and_bootstrap_drift() -> None:
    catalog = _catalog()
    missing = _bundle(catalog)
    missing["reports"]["content"]["metrics"] = missing["reports"]["content"]["metrics"][:-1]
    with pytest.raises(D1BundleError, match="content metrics do not exactly cover"):
        build_fixed_d1_report(missing, calibration_catalog=catalog)

    drift = _bundle(catalog)
    drift["reports"]["offset"]["bootstrap"] = {**BOOTSTRAP, "seed": 7}
    with pytest.raises(D1BundleError, match="offset report bootstrap mismatch"):
        build_fixed_d1_report(drift, calibration_catalog=catalog)


def test_fixed_d1_bundle_rejects_offset_v2_contract_drift() -> None:
    catalog = _catalog()
    design_drift = _bundle(catalog)
    design_drift["reports"]["offset"]["design_digest"] = "f" * 64
    with pytest.raises(D1BundleError, match="offset report design_digest mismatch"):
        build_fixed_d1_report(design_drift, calibration_catalog=catalog)

    semantics_drift = _bundle(catalog)
    semantics_drift["reports"]["offset"]["calibration_abstention_semantics"] = "implicit-zero.v0"
    with pytest.raises(D1BundleError, match="uncertainty or abstention semantics"):
        build_fixed_d1_report(semantics_drift, calibration_catalog=catalog)


def test_fixed_d1_cli_emits_the_decided_bundle(tmp_path: Path) -> None:
    catalog = _catalog()
    bundle_path = tmp_path / "bundle.json"
    catalog_path = tmp_path / "catalog.json"
    bundle_path.write_text(json.dumps(_bundle(catalog)), encoding="utf-8")
    catalog_path.write_text(json.dumps(catalog), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "fixed-d1",
            "--bundle",
            str(bundle_path),
            "--catalog",
            str(catalog_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 0
    report = json.loads(result.stdout)
    assert report["schema_version"] == "ltx-av-eval-fixed-d1-report.v2"
    assert report["verdict"] == "pass"
