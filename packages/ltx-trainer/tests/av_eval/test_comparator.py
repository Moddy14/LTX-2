from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from ltx_trainer.av_eval import ComparatorMatrixError, build_comparator_matrix_report, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CONFIG_ROOT = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval"
MATRIX_PATH = CONFIG_ROOT / "comparator-matrix.v1.json"
LANDSCAPE_PATH = CONFIG_ROOT / "anchor-landscape.v1.json"
AS_OF = date(2026, 8, 11)


def _load(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _ready(*, targets: bool = True) -> tuple[dict[str, object], dict[str, object]]:  # noqa: PLR0912
    landscape = copy.deepcopy(_load(LANDSCAPE_PATH))
    landscape["status"] = "verified"
    landscape["cutoff_date"] = "2026-08-11"
    landscape["search_protocol_sha256"] = "a" * 64
    landscape["rights_policy_sha256"] = "b" * 64
    candidates = landscape["candidates"]
    assert isinstance(candidates, list)
    for index, candidate in enumerate(candidates):
        character = str(index + 1)
        candidate["code_revision"] = character * 40
        candidate["weights_revision"] = character * 40
        for field in ("code_license_sha256", "weights_license_sha256"):
            candidate[field] = character * 64
        if candidate["compatible_claim_ids"]:
            candidate["resource_profile_sha256"] = character * 64
            candidate["resource_fit_status"] = "pass"
        else:
            candidate["resource_profile_sha256"] = None
            candidate["resource_fit_status"] = "not-applicable"

    matrix = copy.deepcopy(_load(MATRIX_PATH))
    matrix["status"] = "frozen"
    matrix["landscape_sha256"] = document_sha256(landscape)
    commitments = matrix["commitments"]
    assert isinstance(commitments, list)
    for commitment in commitments:
        commitment["sha256"] = "c" * 64
    candidate_index = {candidate["candidate_id"]: candidate for candidate in candidates}
    claims = matrix["claims"]
    assert isinstance(claims, list)
    target_ids: list[str] = []
    for claim in claims:
        target_claim = targets and claim["claim_id"] == "audio-driven-video.image-audio-to-video"
        claim["claim_status"] = "sota-target" if target_claim else "local-only"
        claim["sota_anchor_arm_id"] = "longcat-video-avatar-1.5" if target_claim else None
        if target_claim:
            target_ids.append(claim["claim_id"])
        for arm in claim["arms"]:
            if arm["provider"] == "external":
                candidate = candidate_index[arm["arm_id"]]
                arm["code_revision"] = candidate["code_revision"]
                arm["weights_revision"] = candidate["weights_revision"]
            if arm["provider"] == "owned":
                arm.update(
                    {
                        "inclusion_status": "included",
                        "input_compatibility": "compatible",
                        "rights_status": "clear",
                        "technical_status": "pass",
                        "code_revision": "d" * 40,
                        "weights_revision": "e" * 40,
                    }
                )
            elif claim["claim_id"] in candidate_index[arm["arm_id"]]["compatible_claim_ids"] and target_claim:
                candidate = candidate_index[arm["arm_id"]]
                arm.update(
                    {
                        "inclusion_status": "included",
                        "input_compatibility": "compatible",
                        "rights_status": "clear",
                        "technical_status": "pass",
                        "code_revision": candidate["code_revision"],
                        "weights_revision": candidate["weights_revision"],
                    }
                )
            elif claim["claim_id"] in candidate_index[arm["arm_id"]]["compatible_claim_ids"]:
                arm.update(
                    {
                        "inclusion_status": "excluded",
                        "input_compatibility": "compatible",
                        "rights_status": "blocked",
                        "technical_status": "pass",
                        "exclusion_reason": "rights-blocked",
                    }
                )
            else:
                arm.update(
                    {
                        "inclusion_status": "excluded",
                        "input_compatibility": "incompatible",
                        "rights_status": "clear",
                        "technical_status": "pass",
                        "exclusion_reason": "input-contract-incompatible",
                    }
                )
    matrix["target_sota_claim_ids"] = sorted(target_ids)
    return matrix, landscape


def test_checked_in_comparator_matrix_is_an_explicit_hold() -> None:
    report = build_comparator_matrix_report(_load(MATRIX_PATH), landscape=_load(LANDSCAPE_PATH), as_of=AS_OF)

    assert report["status"] == "hold"
    assert report["sota_status"] == "hold"
    assert "candidate-artifact-missing:mova:resource_profile_sha256" not in report["blockers"]
    assert "candidate-resource-fit-pending:mova" not in report["blockers"]
    assert "anchor-landscape-not-verified" in report["blockers"]
    assert "claim-undecided:audio-driven-video.image-audio-to-video" in report["blockers"]
    assert "arm-pending:longcat-video-avatar-1.5" in report["blockers"]
    assert "arm-pending:wan2.2-s2v-14b" in report["blockers"]
    assert "arm-pending:mova" not in report["blockers"]


def test_complete_matrix_is_anchor_ready_and_deterministic() -> None:
    matrix, landscape = _ready()
    first = build_comparator_matrix_report(matrix, landscape=landscape, as_of=AS_OF)
    second = build_comparator_matrix_report(copy.deepcopy(matrix), landscape=copy.deepcopy(landscape), as_of=AS_OF)

    assert first == second
    assert first["status"] == "ready-to-freeze"
    assert first["sota_status"] == "anchor-ready"
    assert first["target_sota_claim_ids"] == ["audio-driven-video.image-audio-to-video"]


def test_honest_local_only_matrix_cannot_be_sota_ready() -> None:
    matrix, landscape = _ready(targets=False)
    report = build_comparator_matrix_report(matrix, landscape=landscape, as_of=AS_OF)

    assert report["status"] == "ready-to-freeze"
    assert report["sota_status"] == "hold"
    assert report["target_sota_claim_ids"] == []


def test_matrix_rejects_result_driven_or_hidden_comparators() -> None:
    quality_seen, landscape = _ready()
    quality_seen["claims"][0]["arms"][0]["quality_evidence_seen"] = True  # type: ignore[index]
    with pytest.raises(ComparatorMatrixError, match="before quality evidence"):
        build_comparator_matrix_report(quality_seen, landscape=landscape, as_of=AS_OF)

    hidden, landscape = _ready()
    hidden["claims"][0]["arms"] = hidden["claims"][0]["arms"][:-1]  # type: ignore[index]
    with pytest.raises(ComparatorMatrixError, match="every landscape candidate"):
        build_comparator_matrix_report(hidden, landscape=landscape, as_of=AS_OF)


def test_matrix_rejects_unproven_exclusion_and_anchor_drift() -> None:
    unproven, landscape = _ready()
    unproven["claims"][0]["arms"][0]["input_compatibility"] = "incompatible"  # type: ignore[index]
    with pytest.raises(ComparatorMatrixError, match="contradicts the frozen landscape"):
        build_comparator_matrix_report(unproven, landscape=landscape, as_of=AS_OF)

    invented, landscape = _ready()
    invented["claims"][0]["arms"][2]["input_compatibility"] = "compatible"  # type: ignore[index]
    with pytest.raises(ComparatorMatrixError, match="contradicts the frozen landscape"):
        build_comparator_matrix_report(invented, landscape=landscape, as_of=AS_OF)

    drift, landscape = _ready()
    drift["claims"][0]["arms"][2]["code_revision"] = "f" * 40  # type: ignore[index]
    with pytest.raises(ComparatorMatrixError, match="does not match the anchor landscape"):
        build_comparator_matrix_report(drift, landscape=landscape, as_of=AS_OF)

    future, landscape = _ready()
    landscape["cutoff_date"] = "2026-08-12"
    future["landscape_sha256"] = document_sha256(landscape)
    with pytest.raises(ComparatorMatrixError, match="cannot be in the future"):
        build_comparator_matrix_report(future, landscape=landscape, as_of=AS_OF)


def test_landscape_rejects_unknown_or_unsorted_compatible_claims() -> None:
    matrix, landscape = _ready()
    landscape["candidates"][0]["compatible_claim_ids"] = [  # type: ignore[index]
        "native-generation.text-to-video",
        "audio-driven-video.image-audio-to-video",
    ]
    matrix["landscape_sha256"] = document_sha256(landscape)
    with pytest.raises(ComparatorMatrixError, match="sorted subset of Q1 claims"):
        build_comparator_matrix_report(matrix, landscape=landscape, as_of=AS_OF)

    matrix, landscape = _ready()
    landscape["candidates"][0]["compatible_claim_ids"] = ["unknown.claim"]  # type: ignore[index]
    matrix["landscape_sha256"] = document_sha256(landscape)
    with pytest.raises(ComparatorMatrixError, match="sorted subset of Q1 claims"):
        build_comparator_matrix_report(matrix, landscape=landscape, as_of=AS_OF)


def test_matrix_requires_resource_evidence_consistent_with_the_decision() -> None:
    matrix, landscape = _ready()
    landscape["candidates"][0]["resource_fit_status"] = "fail"  # type: ignore[index]
    matrix["landscape_sha256"] = document_sha256(landscape)
    with pytest.raises(ComparatorMatrixError, match="no passing resource profile"):
        build_comparator_matrix_report(matrix, landscape=landscape, as_of=AS_OF)

    matrix, landscape = _ready()
    landscape["candidates"][0]["resource_profile_sha256"] = None  # type: ignore[index]
    matrix["landscape_sha256"] = document_sha256(landscape)
    with pytest.raises(ComparatorMatrixError, match="digest and status are inconsistent"):
        build_comparator_matrix_report(matrix, landscape=landscape, as_of=AS_OF)

def test_comparator_cli_reports_draft_hold(tmp_path: Path) -> None:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "comparator-check",
            "--matrix",
            str(MATRIX_PATH),
            "--landscape",
            str(LANDSCAPE_PATH),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 2
    assert json.loads(result.stdout)["status"] == "hold"
