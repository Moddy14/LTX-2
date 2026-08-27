from __future__ import annotations

import copy
import hashlib
import json
import math
import os
import subprocess
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

import pytest

from ltx_trainer.av_eval import (
    OffsetApplicationCaseError,
    OffsetCalibrationError,
    apply_offset_calibrator,
    build_offset_control_deck,
    build_offset_observations,
    build_power_report,
    document_sha256,
    fit_speaker_disjoint_isotonic,
)
from ltx_trainer.av_eval.governance import GROUP_FIELDS, HASH_GROUP_FIELDS, build_transitive_components

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
DESIGN_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v2.json"
PREREGISTRATION_PATH = (
    REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "preregistration.v2.json"
)
OFFSETS = {
    "negative-multiframe": -2.0,
    "negative-one-frame": -1.0,
    "negative-subframe": -0.5,
    "positive-multiframe": 2.0,
    "positive-one-frame": 1.0,
    "positive-subframe": 0.5,
    "zero": 0.0,
}
PARTITIONS = {"fit": "tune", "evaluation": "calibration", "output": "test"}
AGE_BANDS = ("18-29", "30-44", "45-59", "60-plus")


def _governance_digest(value: object) -> str:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(payload).hexdigest()


def _sha(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


def _frozen_design() -> dict[str, Any]:
    """Build a synthetic complete v2 design for deterministic contract tests."""

    design = json.loads(DESIGN_PATH.read_text(encoding="utf-8"))
    design["status"] = "frozen"
    design["design_effect"] = 1.0
    evidence_digest = _sha("independent-pilot-evidence")
    for metric in design["delta_catalog"]["metrics"]:
        metric["delta"] = 0.05
        metric["basis_evidence_sha256"] = evidence_digest
    design["vbench_gate_catalog"]["commit"] = "b" * 40
    design["vbench_gate_catalog"]["config_sha256"] = "c" * 64
    for gate in design["vbench_gate_catalog"]["gates"]:
        gate["absolute_minimum"] = 0.7
        gate["delta"] = 0.03
        gate["basis_evidence_sha256"] = evidence_digest
    for endpoint in design["power_endpoints"]:
        endpoint["max_ci_width"] = 1.0
        if endpoint["model"] == "paired-mean":
            endpoint["effect"] = 1.0
            endpoint["variability"] = 0.01
        elif endpoint["model"] == "binomial-upper":
            endpoint["alternative"] = 0.0
        else:
            endpoint["alternative"] = 1.0
    for quota in design["strata_quotas"]:
        quota["minimum_independent_units"] = 5
    report = build_power_report(design)
    assert report["planning_hypothesis_count"] == 265
    return design


def _frozen_preregistration() -> dict[str, Any]:
    preregistration = json.loads(PREREGISTRATION_PATH.read_text(encoding="utf-8"))
    preregistration["status"] = "frozen"
    commitments = preregistration["holdout_commitments"]
    commitments["calibration_method"] = "speaker-disjoint-component-weighted-isotonic.v2"
    for field in (
        "model_recipe_sha256",
        "initial_weights_sha256",
        "training_runner_sha256",
        "evaluation_runner_sha256",
        "hyperparameter_search_space_sha256",
        "prompt_set_sha256",
        "rating_protocol_sha256",
        "baseline_matrix_sha256",
    ):
        commitments[field] = _sha(f"frozen-{field}")
    for arm in commitments["comparator_arms"]:
        if arm["code_revision"] is None:
            arm["code_revision"] = "d" * 40
        if arm["weights_revision"] is None:
            arm["weights_revision"] = "e" * 40
    preregistration["target_sota_claim_ids"] = ["owned-offset-evaluator-v2"]
    return preregistration


def _sample(partition: str, index: int) -> dict[str, Any]:
    stem = f"{partition}-{index:04d}"
    sample: dict[str, Any] = {
        "sample_id": f"sample-{stem}",
        "voice_speaker_id": f"speaker-{stem}",
        "face_identity_id": f"identity-{stem}",
        "recording_session_id": f"session-{stem}",
        "source_asset_id": f"asset-{stem}",
        "source_collection_id": f"collection-{stem}",
        "utterance_id": f"utterance-{stem}",
        "derivative_group_id": f"derivative-{stem}",
        "rights_source_id": f"rights-source-{stem}",
        "rights_bundle_id": f"rights-bundle-{stem}",
        "perceptual_duplicate_id": None,
        "parent_sample_id": None,
        "language": "de" if index % 2 == 0 else "en",
        "strata": {
            "lighting": "standard" if index % 2 == 0 else "difficult",
            "head_motion": "static" if index % 2 == 0 else "light",
            "skin_tone_fitzpatrick": index % 6 + 1,
            "age_band": AGE_BANDS[index % len(AGE_BANDS)],
            "source_domain": "consented-recording",
        },
    }
    for field in HASH_GROUP_FIELDS:
        sample[field] = _sha(f"{field}:{stem}")
    return sample


def _split(
    freeze: dict[str, Any],
    by_id: dict[str, dict[str, Any]],
    name: str,
) -> dict[str, Any]:
    assignments = freeze["core"]["assignments"]
    sample_ids = sorted(sample_id for sample_id, split in assignments.items() if split == name)
    return {
        "freeze_id": freeze["freeze_id"],
        "sample_ids": sample_ids,
        "samples": [by_id[sample_id] for sample_id in sample_ids],
    }


def _derived_strata(sample: dict[str, Any], fps: int) -> list[str]:
    strata = sample["strata"]
    return sorted(
        {
            f"age.{strata['age_band']}",
            f"fps.{fps}",
            f"language.{sample['language']}",
            f"lighting.{strata['lighting']}",
            f"motion.{strata['head_motion']}",
            f"skin.{strata['skin_tone_fitzpatrick']}",
        }
    )


def _case(
    sample: dict[str, Any],
    *,
    fps: int,
    kind: str,
    label: bool | None,
    in_domain: bool = True,
    abstained: bool = False,
) -> dict[str, Any]:
    sample_id = sample["sample_id"]
    replicate_id = f"rep-{fps}-{kind}-{'none' if label is None else int(label)}"
    expected = None if not in_domain else OFFSETS[kind] * 1000.0 / fps
    predicted = None if abstained else (0.0 if expected is None else expected)
    score = None if abstained else (0.9 if label is True else 0.1)
    return {
        "case_id": document_sha256(
            {
                "correspondence_label": label,
                "fps": fps,
                "offset_kind": kind,
                "replicate_id": replicate_id,
                "source_sample_id": sample_id,
            }
        ),
        "source_sample_id": sample_id,
        "replicate_id": replicate_id,
        "strata": _derived_strata(sample, fps),
        "in_domain": in_domain,
        "offset_kind": kind,
        "fps": fps,
        "expected_offset_ms": expected,
        "predicted_offset_ms": predicted,
        "raw_score": score,
        "correspondence_label": label,
        "abstained": abstained,
    }


def _grid(samples: list[dict[str, Any]], *, include_ood: bool) -> list[dict[str, Any]]:
    cases = [
        _case(sample, fps=fps, kind=kind, label=label)
        for sample in samples
        for fps in (24, 25, 30)
        for kind in OFFSETS
        for label in (False, True)
    ]
    if include_ood:
        cases.extend(
            _case(sample, fps=25, kind="ood", label=None, in_domain=False, abstained=True) for sample in samples
        )
    return sorted(cases, key=lambda case: case["case_id"])


@lru_cache(maxsize=1)
def _base_deck() -> tuple[dict[str, Any], str, str]:
    design = _frozen_design()
    power_report = build_power_report(design)
    required_units = power_report["required_independent_units"]
    preregistration = _frozen_preregistration()
    trusted_preregistration_digest = _governance_digest(preregistration)
    samples = sorted(
        [
            _sample(partition, index)
            for partition in PARTITIONS
            for index in range(required_units)
        ],
        key=lambda sample: sample["sample_id"],
    )
    assignments = {
        sample["sample_id"]: PARTITIONS[str(sample["sample_id"]).split("-")[1]] for sample in samples
    }
    manifest = {"schema_version": "ltx-av-eval-sample.v1", "samples": samples}
    components = [[sample["sample_id"]] for sample in samples]
    core = {
        "schema_version": "ltx-av-eval-dataset-freeze.v2",
        "profile": "product",
        "manifest_sha256": _governance_digest(samples),
        "rights_ledger_sha256": _sha("rights-ledger"),
        "mapping_sha256": preregistration["mapping_sha256"],
        "preregistration_sha256": trusted_preregistration_digest,
        "governance_code_sha256": _sha("governance-code"),
        "preprocessing_version": preregistration["preprocessing_version"],
        "preprocessing_tools": {"ffmpeg": {"sha256": _sha("ffmpeg-binary")}},
        "split_algorithm": "transitive-components-sha256.v1",
        "split_seed_sha256": preregistration["split_seed_sha256"],
        "group_fields": [*GROUP_FIELDS, *HASH_GROUP_FIELDS, "perceptual_duplicate_id", "parent_sample_id"],
        "artifact_sha256": [_sha("frozen-artifact")],
        "sample_count": len(samples),
        "component_count": len(components),
        "split_counts": {
            "train": 0,
            "tune": required_units,
            "design-pilot": 0,
            "calibration": required_units,
            "test": required_units,
            "ood-test": 0,
        },
        "assignments": assignments,
        "components": components,
        "snapshot_sha256": {
            "manifest.snapshot.json": _governance_digest(manifest),
            "preregistration.snapshot.json": trusted_preregistration_digest,
            "rights.snapshot.json": _sha("rights-snapshot"),
            "viseme-mapping.snapshot.json": _sha("mapping-snapshot"),
        },
    }
    freeze = {"freeze_id": _governance_digest(core), "core": core}
    by_id = {sample["sample_id"]: sample for sample in samples}
    fit_split = _split(freeze, by_id, "tune")
    registered = [quota["stratum_id"] for quota in design["strata_quotas"]]
    deck = {
        "schema_version": "ltx-av-eval-offset-control-deck.v2",
        "calibration_method": "speaker-disjoint-component-weighted-isotonic.v2",
        "split_algorithm": "transitive-components-sha256.v1",
        "raw_score_semantics": "uncalibrated-lag-peak-separation.v1",
        "dataset_freeze": freeze,
        "dataset_manifest": manifest,
        "preregistration": preregistration,
        "fit_split_manifest": fit_split,
        "design": design,
        "power_report": power_report,
        "operating_point": {
            "schema_version": "ltx-av-eval-offset-operating-point.v1",
            "status": "frozen",
            "classification_rule": "raw-score-greater-or-equal-is-correspondence.v1",
            "raw_score_threshold": 0.5,
            "target_far_max": 0.01,
            "target_frr_max": 0.05,
            "basis_evidence_sha256": _sha("operating-point-evidence"),
        },
        "offset_evaluator_digest": _sha("offset-evaluator"),
        "registered_strata": registered,
        "fit_cases": _grid(fit_split["samples"], include_ood=False),
    }
    return deck, freeze["freeze_id"], trusted_preregistration_digest


def _deck() -> dict[str, Any]:
    return copy.deepcopy(_base_deck()[0])


def _anchors() -> dict[str, str]:
    return {
        "expected_dataset_digest": _base_deck()[1],
        "trusted_preregistration_digest": _base_deck()[2],
    }


def _fit(deck: dict[str, Any]) -> dict[str, Any]:
    return fit_speaker_disjoint_isotonic(deck, **_anchors())


def _observation_deck(deck: dict[str, Any], calibrator: dict[str, Any]) -> dict[str, Any]:
    canonical = build_offset_control_deck(deck, **_anchors())
    freeze = deck["dataset_freeze"]
    by_id = {sample["sample_id"]: sample for sample in deck["dataset_manifest"]["samples"]}
    evaluation_split = _split(freeze, by_id, "calibration")
    output_split = _split(freeze, by_id, "test")
    output_cases = []
    for index, sample in enumerate(output_split["samples"]):
        replicate_id = "output-replicate"
        fps = (24, 25, 30)[index % 3]
        output_cases.append(
            {
                "output_id": document_sha256(
                    {"fps": fps, "replicate_id": replicate_id, "source_sample_id": sample["sample_id"]}
                ),
                "source_sample_id": sample["sample_id"],
                "replicate_id": replicate_id,
                "fps": fps,
                "strata": _derived_strata(sample, fps),
                "estimated_offset_ms": 8.0,
            }
        )
    output_cases.sort(key=lambda case: case["output_id"])
    return {
        "schema_version": "ltx-av-eval-offset-observation-deck.v2",
        "control_deck_digest": document_sha256(canonical),
        "dataset_digest": calibrator["dataset_digest"],
        "dataset_manifest_digest": calibrator["dataset_manifest_digest"],
        "design_digest": calibrator["design_digest"],
        "design_report_digest": calibrator["design_report_digest"],
        "fit_split_manifest_digest": calibrator["fit_split_manifest_digest"],
        "evaluation_split_manifest": evaluation_split,
        "output_split_manifest": output_split,
        "preregistration_digest": calibrator["preregistration_digest"],
        "offset_evaluator_digest": calibrator["offset_evaluator_digest"],
        "power_report_digest": calibrator["power_report_digest"],
        "operating_point_digest": calibrator["operating_point_digest"],
        "strata_quotas_digest": calibrator["strata_quotas_digest"],
        "required_independent_units": calibrator["required_independent_units"],
        "abstention_policy_digest": _sha("abstention-policy"),
        "release_digest": _sha("release"),
        "strata_plan_digest": calibrator["strata_quotas_digest"],
        "bootstrap": {"replicates": 10000, "confidence_level": 0.95, "seed": 25082026},
        "registered_strata": canonical["registered_strata"],
        "calibration_cases": _grid(evaluation_split["samples"], include_ood=True),
        "output_cases": output_cases,
    }


@lru_cache(maxsize=1)
def _built_context() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    deck = _deck()
    calibrator = _fit(deck)
    observation_deck = _observation_deck(deck, calibrator)
    observations = build_offset_observations(deck, calibrator, observation_deck, **_anchors())
    return deck, calibrator, observation_deck, observations


def _context() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    return copy.deepcopy(_built_context())


def _rebind_dataset(deck: dict[str, Any]) -> tuple[str, str]:
    manifest = deck["dataset_manifest"]
    freeze = deck["dataset_freeze"]
    core = freeze["core"]
    preregistration = deck["preregistration"]
    core["components"] = build_transitive_components(manifest["samples"])
    core["component_count"] = len(core["components"])
    core["manifest_sha256"] = _governance_digest(manifest["samples"])
    core["preregistration_sha256"] = _governance_digest(preregistration)
    core["snapshot_sha256"] = {
        "manifest.snapshot.json": _governance_digest(manifest),
        "preregistration.snapshot.json": _governance_digest(preregistration),
        "rights.snapshot.json": _sha("rights-snapshot"),
        "viseme-mapping.snapshot.json": _sha("mapping-snapshot"),
    }
    freeze["freeze_id"] = _governance_digest(core)
    by_id = {sample["sample_id"]: sample for sample in manifest["samples"]}
    deck["fit_split_manifest"] = _split(freeze, by_id, "tune")
    return freeze["freeze_id"], _governance_digest(preregistration)


def test_real_d0a_contract_builds_canonical_component_weighted_v2_evidence() -> None:
    deck, calibrator, _observation_deck_raw, observations = _context()
    canonical = build_offset_control_deck(deck, **_anchors())

    assert deck["power_report"] == build_power_report(deck["design"])
    assert deck["power_report"]["planning_hypothesis_count"] == 265
    required_units = deck["power_report"]["required_independent_units"]
    assert isinstance(required_units, int)
    assert calibrator["weight_semantics"] == "equal-total-weight-per-transitive-component.v1"
    assert sum(knot["component_equivalent_weight"] for knot in calibrator["knots"]) == pytest.approx(required_units)
    assert observations["control_deck_digest"] == document_sha256(canonical)
    assert observations["output_split_manifest_digest"] != observations["evaluation_split_manifest_digest"]
    assert len(observations["calibration_cases"]) == required_units * 43
    assert len(observations["output_cases"]) == required_units


def test_power_report_must_be_the_exact_recomputed_frozen_design_report() -> None:
    deck = _deck()
    deck["power_report"]["required_independent_units"] -= 1
    with pytest.raises(
        OffsetCalibrationError,
        match=r"understates an endpoint requirement|exact deterministic report",
    ):
        build_offset_control_deck(deck, **_anchors())


def test_dataset_and_preregistration_rehashes_cannot_replace_external_anchors() -> None:
    dataset_tamper = _deck()
    dataset_tamper["dataset_manifest"]["samples"][0]["language"] = "fr"
    new_dataset_digest, _trusted = _rebind_dataset(dataset_tamper)
    assert new_dataset_digest != _anchors()["expected_dataset_digest"]
    with pytest.raises(OffsetCalibrationError, match="externally expected dataset digest"):
        build_offset_control_deck(dataset_tamper, **_anchors())

    preregistration_tamper = _deck()
    preregistration_tamper["preregistration"]["target_sota_claim_ids"].append("second-offset-claim")
    new_dataset_digest, new_preregistration_digest = _rebind_dataset(preregistration_tamper)
    with pytest.raises(OffsetCalibrationError, match="Review-Digest"):
        build_offset_control_deck(
            preregistration_tamper,
            expected_dataset_digest=new_dataset_digest,
            trusted_preregistration_digest=_anchors()["trusted_preregistration_digest"],
        )
    assert new_preregistration_digest != _anchors()["trusted_preregistration_digest"]


@pytest.mark.parametrize("boundary", ["fit-calibration", "calibration-output"])
@pytest.mark.parametrize(
    "field",
    [
        "voice_speaker_id",
        "face_identity_id",
        "recording_session_id",
        "source_asset_id",
        "source_collection_id",
        "media_sha256",
    ],
)
def test_all_six_identity_dimensions_remain_component_disjoint(boundary: str, field: str) -> None:
    deck = _deck()
    samples = deck["dataset_manifest"]["samples"]
    left_name, right_name = boundary.split("-")
    split_alias = {"fit": "fit", "calibration": "evaluation", "output": "output"}
    left = next(sample for sample in samples if sample["sample_id"].startswith(f"sample-{split_alias[left_name]}-"))
    right = next(sample for sample in samples if sample["sample_id"].startswith(f"sample-{split_alias[right_name]}-"))
    right[field] = left[field]
    new_dataset_digest, trusted_preregistration_digest = _rebind_dataset(deck)
    with pytest.raises(OffsetCalibrationError, match="component spans multiple splits"):
        build_offset_control_deck(
            deck,
            expected_dataset_digest=new_dataset_digest,
            trusted_preregistration_digest=trusted_preregistration_digest,
        )


def test_exact_grid_rejects_missing_and_duplicated_cells() -> None:
    missing = _deck()
    missing["fit_cases"].pop()
    with pytest.raises(OffsetCalibrationError, match="exactly one control"):
        build_offset_control_deck(missing, **_anchors())

    duplicated = _deck()
    duplicate = copy.deepcopy(duplicated["fit_cases"][0])
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
    duplicated["fit_cases"].append(duplicate)
    with pytest.raises(OffsetCalibrationError, match="exactly one control"):
        build_offset_control_deck(duplicated, **_anchors())


def test_strata_catalog_and_quota_coverage_are_design_derived() -> None:
    omitted = _deck()
    omitted["registered_strata"].pop()
    with pytest.raises(OffsetCalibrationError, match="exactly equal the frozen D0a"):
        build_offset_control_deck(omitted, **_anchors())

    undercovered = _deck()
    for sample in undercovered["dataset_manifest"]["samples"]:
        if sample["sample_id"].startswith("sample-fit-"):
            sample["strata"]["skin_tone_fitzpatrick"] = 1
    new_dataset_digest, trusted_preregistration_digest = _rebind_dataset(undercovered)
    for case in undercovered["fit_cases"]:
        case["strata"] = [stratum for stratum in case["strata"] if not stratum.startswith("skin.")]
        case["strata"].append("skin.1")
        case["strata"].sort()
    with pytest.raises(OffsetCalibrationError, match="frozen quota requires"):
        build_offset_control_deck(
            undercovered,
            expected_dataset_digest=new_dataset_digest,
            trusted_preregistration_digest=trusted_preregistration_digest,
        )


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_non_finite_and_unknown_application_values_fail_closed(value: float) -> None:
    deck = _deck()
    deck["fit_cases"][0]["raw_score"] = value
    with pytest.raises(OffsetCalibrationError, match="finite number"):
        build_offset_control_deck(deck, **_anchors())

    _deck_raw, calibrator, _observation, _observations = _context()
    with pytest.raises(OffsetApplicationCaseError, match="missing="):
        apply_offset_calibrator(calibrator, {})


def test_application_case_count_has_a_hard_limit() -> None:
    _deck_raw, calibrator, _observation, _observations = _context()
    application = {
        "schema_version": "ltx-av-eval-offset-calibration-application.v2",
        "control_deck_digest": calibrator["control_deck_digest"],
        "dataset_digest": calibrator["dataset_digest"],
        "dataset_manifest_digest": calibrator["dataset_manifest_digest"],
        "design_digest": calibrator["design_digest"],
        "design_report_digest": calibrator["design_report_digest"],
        "fit_split_manifest_digest": calibrator["fit_split_manifest_digest"],
        "evaluation_split_manifest_digest": _sha("evaluation-split"),
        "preregistration_digest": calibrator["preregistration_digest"],
        "offset_evaluator_digest": calibrator["offset_evaluator_digest"],
        "power_report_digest": calibrator["power_report_digest"],
        "operating_point_digest": calibrator["operating_point_digest"],
        "strata_quotas_digest": calibrator["strata_quotas_digest"],
        "required_independent_units": calibrator["required_independent_units"],
        "registered_strata": _deck_raw["registered_strata"],
        "cases": [{}] * 900_001,
    }
    with pytest.raises(OffsetApplicationCaseError, match="2 to 900000"):
        apply_offset_calibrator(calibrator, application)


def test_offset_cli_requires_and_uses_external_anchors(tmp_path: Path) -> None:
    deck = _deck()
    calibrator = _fit(deck)
    observation_deck = _observation_deck(deck, calibrator)
    deck_path = tmp_path / "deck.json"
    calibrator_path = tmp_path / "calibrator.json"
    observation_path = tmp_path / "observation.json"
    deck_path.write_text(json.dumps(deck), encoding="utf-8")
    calibrator_path.write_text(json.dumps(calibrator), encoding="utf-8")
    observation_path.write_text(json.dumps(observation_deck), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    common = [
        "--expected-dataset-digest",
        _anchors()["expected_dataset_digest"],
        "--trusted-preregistration-digest",
        _anchors()["trusted_preregistration_digest"],
    ]
    fit_result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "offset-calibrate",
            "--deck",
            str(deck_path),
            *common,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )
    assert fit_result.returncode == 0, fit_result.stderr
    assert json.loads(fit_result.stdout) == calibrator
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "offset-observations-build",
            "--deck",
            str(deck_path),
            "--calibrator",
            str(calibrator_path),
            "--observation-deck",
            str(observation_path),
            *common,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["schema_version"] == "ltx-av-eval-offset-observations.v2"

    symlink_path = tmp_path / "deck-link.json"
    symlink_path.symlink_to(deck_path)
    rejected = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "offset-calibrate",
            "--deck",
            str(symlink_path),
            *common,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )
    assert rejected.returncode == 2

    deeply_nested_path = tmp_path / "deeply-nested.json"
    deeply_nested_path.write_text("[" * 2_000 + "]" * 2_000, encoding="utf-8")
    rejected = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "offset-calibrate",
            "--deck",
            str(deeply_nested_path),
            *common,
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )
    assert rejected.returncode == 2
    assert "nesting depth" in rejected.stdout + rejected.stderr
