from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

from ltx_trainer.av_eval import ReadinessError, build_product_readiness_report

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
PACKAGE_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "product-readiness.v1.json"
NOW = datetime(2026, 8, 11, 14, 0, tzinfo=UTC)


def _draft() -> dict[str, object]:
    return json.loads(PACKAGE_PATH.read_text(encoding="utf-8"))


def _ready() -> dict[str, object]:
    package = copy.deepcopy(_draft())
    package["status"] = "ready-to-freeze"
    evidence = package["evidence"]
    commitments = package["artifact_commitments"]
    roles = package["role_bindings"]
    operational = package["operational"]
    assert isinstance(evidence, list)
    assert isinstance(commitments, list)
    assert isinstance(roles, list)
    assert isinstance(operational, dict)
    for entry in [*evidence, *commitments]:
        entry["sha256"] = "a" * 64
    for index, binding in enumerate(roles):
        binding["key_id"] = f"independent-key-{index + 1:02d}"
    operational.update(
        {
            "blind_scorer_uid": 5000,
            "blind_scorer_gid": 5000,
            "development_uids": [1000, 1001],
            "acl_status": "sealed",
            "access_log_status": "verified",
            "access_log_events": 0,
            "access_log_head_sha256": "0" * 64,
            "rights_valid_at": "2026-08-11T12:00:00Z",
            "rights_expires_at": "2026-08-12T12:00:00Z",
            "rights_revocation_state": "clear",
            "tune_report_verdict": "pass",
        }
    )
    return package


def test_checked_in_readiness_package_is_an_explicit_hold() -> None:
    report = build_product_readiness_report(_draft(), now=NOW)

    assert report["status"] == "hold"
    assert "digest-missing:dataset-freeze" in report["blockers"]
    assert "role-key-missing:holdout-scorer" in report["blockers"]
    assert "blind-scorer-uid-missing" in report["blockers"]
    assert "rights-expires-at-missing" in report["blockers"]


def test_complete_readiness_package_is_stable_and_ready_to_freeze() -> None:
    first = build_product_readiness_report(_ready(), now=NOW)
    second = build_product_readiness_report(copy.deepcopy(_ready()), now=NOW)

    assert first == second
    assert first["status"] == "ready-to-freeze"
    assert first["blockers"] == []


def test_readiness_rejects_shared_roles_and_scorer_access() -> None:
    shared_role = _ready()
    shared_role["role_bindings"][1]["key_id"] = shared_role["role_bindings"][0]["key_id"]  # type: ignore[index]
    with pytest.raises(ReadinessError, match="distinct key IDs"):
        build_product_readiness_report(shared_role, now=NOW)

    scorer_is_developer = _ready()
    scorer_is_developer["operational"]["development_uids"] = [1000, 5000]  # type: ignore[index]
    with pytest.raises(ReadinessError, match="blind scorer UID"):
        build_product_readiness_report(scorer_is_developer, now=NOW)


def test_readiness_requires_an_untouched_holdout_log() -> None:
    consumed = _ready()
    consumed["operational"]["access_log_events"] = 1  # type: ignore[index]
    with pytest.raises(ReadinessError, match="untouched holdout access log"):
        build_product_readiness_report(consumed, now=NOW)

    changed_head = _ready()
    changed_head["operational"]["access_log_head_sha256"] = "f" * 64  # type: ignore[index]
    with pytest.raises(ReadinessError, match="genesis digest"):
        build_product_readiness_report(changed_head, now=NOW)


def test_readiness_cli_reports_hold_with_a_nonzero_exit(tmp_path: Path) -> None:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")
    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "readiness-check",
            "--package",
            str(PACKAGE_PATH),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 2
    assert json.loads(result.stdout)["status"] == "hold"
