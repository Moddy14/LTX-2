from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import DesignError, build_power_report, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
LEGACY_DESIGN_PATH = (
    REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v1.json"
)
DESIGN_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v2.json"
SURFACE_PATH = REPOSITORY_ROOT / "apps" / "ltx-studio" / "release" / "candidate-release-surface.v1.json"
LEGACY_DESIGN_FILE_SHA256 = "bf573a01b2d4c11db2754dfa9ea4552022779251ebeb5322ed69922a6af3f695"
UNFROZEN_LTX25_VBENCH_HOLD_CLAIMS = {
    "audio-driven-video.ltx25.image-audio-to-video.two-stage",
    "controlled-video.ltx25.ic-lora.ingredients",
    "controlled-video.ltx25.ic-lora.motion-track",
    "controlled-video.ltx25.ic-lora.v2v-deblur",
    "native-generation.ltx25.image-to-video.single-stage",
    "native-generation.ltx25.image-to-video.two-stage",
}


def _draft() -> dict[str, object]:
    return json.loads(DESIGN_PATH.read_text(encoding="utf-8"))


def _legacy_draft() -> dict[str, object]:
    return json.loads(LEGACY_DESIGN_PATH.read_text(encoding="utf-8"))


def _surface_claims() -> set[str]:
    surface = json.loads(SURFACE_PATH.read_text(encoding="utf-8"))
    return {
        entry["claimId"]
        for entry in surface["entries"]
        if entry["targetStatus"] == "candidate" and "vbench-i2v" in entry["applicableGates"]
    }


def _ready_design() -> dict[str, object]:
    design = copy.deepcopy(_draft())
    design["status"] = "frozen"
    design["design_effect"] = 1.4
    evidence_digest = "a" * 64
    delta_catalog = design["delta_catalog"]
    assert isinstance(delta_catalog, dict)
    metrics = delta_catalog["metrics"]
    assert isinstance(metrics, list)
    for metric in metrics:
        metric["delta"] = 0.05
        metric["basis_evidence_sha256"] = evidence_digest
    vbench = design["vbench_gate_catalog"]
    assert isinstance(vbench, dict)
    vbench["commit"] = "b" * 40
    vbench["config_sha256"] = "c" * 64
    gates = vbench["gates"]
    assert isinstance(gates, list)
    for gate in gates:
        gate["absolute_minimum"] = 0.7
        gate["delta"] = 0.03
        gate["basis_evidence_sha256"] = evidence_digest
    endpoints = design["power_endpoints"]
    assert isinstance(endpoints, list)
    for endpoint in endpoints:
        endpoint["max_ci_width"] = 0.04
        if endpoint["model"] == "paired-mean":
            endpoint["effect"] = 0.1
            endpoint["variability"] = 0.2
        elif endpoint["model"] == "binomial-upper":
            endpoint["alternative"] = endpoint["null_value"] / 2
        else:
            endpoint["alternative"] = endpoint["null_value"] + (1 - endpoint["null_value"]) / 2
    quotas = design["strata_quotas"]
    assert isinstance(quotas, list)
    for quota in quotas:
        quota["minimum_independent_units"] = 5
    return design


def test_checked_in_design_is_an_explicit_hold_without_invented_pilot_values() -> None:
    design = _draft()
    report = build_power_report(design)

    assert report["status"] == "hold"
    assert report["required_independent_units"] is None
    assert report["required_clips"] is None
    assert report["schema_version"] == "ltx-sota-power-report.v2"
    assert report["vbench_claim_count"] == 21
    assert report["vbench_gate_count"] == 126
    assert report["planning_hypothesis_count"] == 265
    assert "design-effect-missing" in report["blockers"]
    assert "delta-missing:identity-similarity" in report["blockers"]
    assert "vbench-commit-missing" not in report["blockers"]
    assert "vbench-config-missing" not in report["blockers"]
    assert report["design_digest"] == document_sha256(design)


def test_frozen_design_computes_deterministic_power_and_precision_requirements() -> None:
    design = _ready_design()
    first = build_power_report(design)
    second = build_power_report(copy.deepcopy(design))

    assert first == second
    assert first["status"] == "ready-to-freeze"
    assert first["blockers"] == []
    assert first["required_independent_units"] >= 30
    assert first["required_clips"] == first["required_independent_units"] * 3
    assert len(first["endpoint_requirements"]) == len(design["power_endpoints"])
    assert first["planning_hypothesis_count"] == 265
    assert first["per_endpoint_planning_alpha"] == 0.05 / 265
    assert first["vbench_claim_count"] == 21
    assert first["vbench_gate_count"] == 126


@pytest.mark.parametrize("relationship", ["disjoint", "partition"])
def test_billion_unit_quota_is_hold_in_draft_and_denied_when_frozen(relationship: str) -> None:
    draft = _ready_design()
    draft["status"] = "draft"
    quotas = {quota["stratum_id"]: quota for quota in draft["strata_quotas"]}
    quotas["age.18-29"]["minimum_independent_units"] = 1_000_000_000
    semantics = draft["strata_quota_semantics"]
    age_group = next(group for group in semantics["groups"] if group["group_id"] == "age")
    age_group["relationship"] = relationship

    report = build_power_report(draft)

    assert semantics["maximum_independent_units"] == 50_000
    assert report["status"] == "hold"
    assert report["required_independent_units"] is None
    assert "strata-quota-exceeds-maximum:age.18-29" in report["blockers"]
    assert "strata-quota-group-exceeds-maximum:age" in report["blockers"]

    frozen = copy.deepcopy(draft)
    frozen["status"] = "frozen"
    with pytest.raises(DesignError, match=r"strata-quota-exceeds-maximum:age\.18-29"):
        build_power_report(frozen)


def test_disjoint_quota_sum_must_fit_even_when_each_quota_is_individually_feasible() -> None:
    design = _ready_design()
    quotas = {quota["stratum_id"]: quota for quota in design["strata_quotas"]}
    for stratum_id in ("age.18-29", "age.30-44", "age.45-59", "age.60-plus"):
        quotas[stratum_id]["minimum_independent_units"] = 20_000

    with pytest.raises(DesignError, match="strata-quota-group-exceeds-maximum:age"):
        build_power_report(design)


def test_v2_quota_semantics_must_cover_every_registered_quota_once() -> None:
    design = _ready_design()
    semantics = design["strata_quota_semantics"]
    age_group = next(group for group in semantics["groups"] if group["group_id"] == "age")
    age_group["stratum_ids"] = age_group["stratum_ids"][:-1]

    with pytest.raises(DesignError, match="cover every quota exactly once"):
        build_power_report(design)


def test_vbench_design_exactly_covers_candidate_surface_claims() -> None:
    design = _draft()
    surface = json.loads(SURFACE_PATH.read_text(encoding="utf-8"))
    catalog = design["vbench_gate_catalog"]
    assert isinstance(catalog, dict)
    design_claims = {gate["claim_id"] for gate in catalog["gates"]}
    binding = catalog["candidate_surface"]
    assert isinstance(binding, dict)

    assert design_claims == _surface_claims()
    assert binding["claim_ids"] == sorted(design_claims)
    assert binding["schema_version"] == "ltx-av-eval-candidate-vbench-surface-binding.v2"
    assert binding["surface_schema_version"] == "candidate-release-surface.v1"
    assert binding["surface_digest"] == "3a2de1641446a0ae053a9ea650ad14626cf57f938885188766575d06a94474fa"
    assert binding["projection_digest"] == "67ef51581695b3919b16a869b1dcf8d0209cae544121359048ff7c43af48aef5"
    assert binding["candidate_entry_count"] == 25
    assert {
        (gate["claim_id"], gate["dimension"])
        for gate in catalog["gates"]
    } == {
        (claim_id, dimension)
        for claim_id in design_claims
        for dimension in (
            "aesthetic-quality",
            "background-consistency",
            "dynamic-degree",
            "imaging-quality",
            "motion-smoothness",
            "subject-consistency",
        )
    }
    assert build_power_report(_ready_design(), release_surface=surface)["status"] == "ready-to-freeze"


def test_v2_design_rejects_fake_digests_and_a_partial_passed_surface() -> None:
    surface = json.loads(SURFACE_PATH.read_text(encoding="utf-8"))
    fake_digest = _ready_design()
    fake_digest["vbench_gate_catalog"]["candidate_surface"]["projection_digest"] = "f" * 64

    with pytest.raises(DesignError, match="candidate release surface binding rejected"):
        build_power_report(fake_digest, release_surface=surface)

    partial_surface = copy.deepcopy(surface)
    removed_claim = next(
        entry["claimId"]
        for entry in partial_surface["entries"]
        if entry["targetStatus"] == "candidate" and "vbench-i2v" in entry["applicableGates"]
    )
    partial_surface["entries"] = [
        entry for entry in partial_surface["entries"] if entry["claimId"] != removed_claim
    ]
    with pytest.raises(DesignError, match="exact current claim matrix"):
        build_power_report(_ready_design(), release_surface=partial_surface)


def test_new_ltx25_gates_remain_null_and_hold_pending_a_disjoint_pilot() -> None:
    design = _draft()
    legacy = _legacy_draft()
    legacy_claims = {gate["claim_id"] for gate in legacy["vbench_gate_catalog"]["gates"]}
    new_claims = {gate["claim_id"] for gate in design["vbench_gate_catalog"]["gates"]} - legacy_claims
    new_gates = [gate for gate in design["vbench_gate_catalog"]["gates"] if gate["claim_id"] in new_claims]
    report = build_power_report(design)

    assert new_claims == UNFROZEN_LTX25_VBENCH_HOLD_CLAIMS
    assert len(new_gates) == 36
    assert all(gate["absolute_minimum"] is None for gate in new_gates)
    assert all(gate["delta"] is None for gate in new_gates)
    assert all(gate["basis_evidence_sha256"] is None for gate in new_gates)
    assert report["status"] == "hold"
    assert report["required_independent_units"] is None
    assert report["required_clips"] is None


def test_frozen90_v1_artifact_remains_byte_stable_and_reports_only_legacy_scope() -> None:
    legacy = _legacy_draft()
    report = build_power_report(legacy)

    assert hashlib.sha256(LEGACY_DESIGN_PATH.read_bytes()).hexdigest() == LEGACY_DESIGN_FILE_SHA256
    assert legacy["schema_version"] == "ltx-sota-design-pilot.v1"
    assert legacy["vbench_gate_catalog"]["schema_version"] == "vbench-gates.v1"
    assert len(legacy["vbench_gate_catalog"]["gates"]) == 90
    assert report["schema_version"] == "ltx-sota-power-report.v1"
    assert report["planning_hypothesis_count"] == 193
    assert "vbench_claim_count" not in report
    assert "vbench_gate_count" not in report


def test_v2_catalog_rejects_an_incomplete_candidate_claim_matrix() -> None:
    design = _draft()
    design["vbench_gate_catalog"]["gates"] = design["vbench_gate_catalog"]["gates"][:-1]

    with pytest.raises(DesignError, match="exactly cover the candidate claim/dimension matrix"):
        build_power_report(design)


def test_design_rejects_outcome_driven_or_vacuous_freezes() -> None:
    incomplete = _draft()
    incomplete["status"] = "frozen"
    with pytest.raises(DesignError, match="frozen delta catalog is incomplete"):
        build_power_report(incomplete)

    unsorted = _ready_design()
    endpoints = unsorted["power_endpoints"]
    assert isinstance(endpoints, list)
    endpoints.reverse()
    with pytest.raises(DesignError, match="unique and sorted"):
        build_power_report(unsorted)

    wrong_revision = _draft()
    wrong_revision["vbench_gate_catalog"]["commit"] = "b" * 64
    with pytest.raises(DesignError, match="40-character Git revision"):
        build_power_report(wrong_revision)


def test_design_cannot_aggregate_critical_token_types() -> None:
    missing_delta = _ready_design()
    delta_catalog = missing_delta["delta_catalog"]
    assert isinstance(delta_catalog, dict)
    delta_catalog["metrics"] = [
        metric for metric in delta_catalog["metrics"] if metric["metric_id"] != "asr-critical-negation-accuracy"
    ]
    with pytest.raises(DesignError, match="names, numbers, and negations separately"):
        build_power_report(missing_delta)

    missing_endpoint = _ready_design()
    missing_endpoint["power_endpoints"] = [
        endpoint for endpoint in missing_endpoint["power_endpoints"] if endpoint["endpoint_id"] != "asr-critical-number"
    ]
    with pytest.raises(DesignError, match="names, numbers, and negations separately"):
        build_power_report(missing_endpoint)


def test_design_cannot_omit_a_vbench_power_dimension() -> None:
    design = _ready_design()
    design["power_endpoints"] = [
        endpoint
        for endpoint in design["power_endpoints"]
        if endpoint["endpoint_id"] != "vbench-motion-smoothness"
    ]

    with pytest.raises(DesignError, match="exactly cover every registered VBench dimension"):
        build_power_report(design)


def test_design_cli_reports_hold_with_a_nonzero_exit(tmp_path: Path) -> None:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "design-check",
            "--design",
            str(DESIGN_PATH),
            "--surface",
            str(SURFACE_PATH),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 2
    report = json.loads(result.stdout)
    assert report["status"] == "hold"
    assert report["required_independent_units"] is None
