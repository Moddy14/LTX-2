from __future__ import annotations

import base64
import copy
import json
import os
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from ltx_trainer.av_eval import (
    ReadinessError,
    build_operational_readiness_evidence,
    build_product_readiness_report,
    document_sha256,
)

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


def _trust_policy(now: datetime = NOW) -> dict[str, object]:
    keys = []
    for index, role in enumerate(("evaluation-authorizer", "holdout-scorer", "release-authorizer"), start=1):
        public_key = Ed25519PrivateKey.generate().public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        keys.append(
            {
                "key_id": f"independent-key-{index:02d}",
                "algorithm": "ed25519",
                "public_key_base64": base64.b64encode(public_key).decode(),
                "roles": [role],
                "not_before": (now - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "not_after": (now + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "revoked_at": None,
            }
        )
    return {
        "schema_version": "ltx-av-eval-trusted-keys.v1",
        "policy_id": "independent-product-keys-01",
        "keys": keys,
    }


def _live_ready(tmp_path: Path) -> tuple[dict[str, object], dict[str, object]]:
    package = _ready()
    operational = package["operational"]
    assert isinstance(operational, dict)
    operational["blind_scorer_uid"] = os.geteuid()
    operational["blind_scorer_gid"] = os.getegid()
    operational["development_uids"] = [os.geteuid() + 1]
    holdout_root = tmp_path / "holdout"
    access_log_root = tmp_path / "audit"
    holdout_root.mkdir(mode=0o700)
    access_log_root.mkdir(mode=0o700)
    access_log = access_log_root / "access.jsonl"
    access_log.write_bytes(b"")
    access_log.chmod(0o600)
    evidence = build_operational_readiness_evidence(
        package,
        holdout_root=holdout_root,
        access_log_root=access_log_root,
        access_log_path=access_log,
        trust_policy=_trust_policy(),
        now=NOW,
    )
    operational.update(evidence["operational_updates"])
    digests = {entry["artifact_id"]: entry["sha256"] for entry in evidence["evidence"]}
    for entry in package["evidence"]:  # type: ignore[union-attr]
        if entry["artifact_id"] in digests:
            entry["sha256"] = digests[entry["artifact_id"]]
    return package, evidence


def test_checked_in_readiness_package_is_an_explicit_hold() -> None:
    report = build_product_readiness_report(_draft(), now=NOW)

    assert report["status"] == "hold"
    assert "digest-missing:dataset-freeze" in report["blockers"]
    assert "role-key-missing:holdout-scorer" in report["blockers"]
    assert "blind-scorer-uid-missing" in report["blockers"]
    assert "rights-expires-at-missing" in report["blockers"]


def test_complete_readiness_package_is_stable_and_ready_to_freeze(tmp_path: Path) -> None:
    package, operational_evidence = _live_ready(tmp_path)
    first = build_product_readiness_report(package, now=NOW, operational_evidence=operational_evidence)
    second = build_product_readiness_report(
        copy.deepcopy(package),
        now=NOW,
        operational_evidence=copy.deepcopy(operational_evidence),
    )

    assert first == second
    assert first["status"] == "ready-to-freeze"
    assert first["blockers"] == []
    assert first["live_operational_evidence_digest"] == document_sha256(operational_evidence)


def test_ready_to_freeze_rejects_missing_stale_or_unbound_live_evidence(tmp_path: Path) -> None:
    package, operational_evidence = _live_ready(tmp_path)
    with pytest.raises(ReadinessError, match="requires live operational evidence"):
        build_product_readiness_report(package, now=NOW)

    stale = copy.deepcopy(operational_evidence)
    stale["checked_at"] = "2026-08-11T13:54:59Z"
    with pytest.raises(ReadinessError, match="stale or from the future"):
        build_product_readiness_report(package, now=NOW, operational_evidence=stale)

    unbound = copy.deepcopy(operational_evidence)
    unbound["documents"]["empty-access-log-report"]["log_path"] = "/forged/access.jsonl"
    with pytest.raises(ReadinessError, match="digest mismatch"):
        build_product_readiness_report(package, now=NOW, operational_evidence=unbound)

    misplaced_package = copy.deepcopy(package)
    misplaced = copy.deepcopy(operational_evidence)
    misplaced_document = misplaced["documents"]["empty-access-log-report"]
    misplaced_document["log_path"] = str((tmp_path / "separate" / "access.jsonl").resolve())
    misplaced_digest = document_sha256(misplaced_document)
    for entry in misplaced["evidence"]:
        if entry["artifact_id"] == "empty-access-log-report":
            entry["sha256"] = misplaced_digest
    for entry in misplaced_package["evidence"]:
        if entry["artifact_id"] == "empty-access-log-report":
            entry["sha256"] = misplaced_digest
    with pytest.raises(ReadinessError, match="direct child"):
        build_product_readiness_report(
            misplaced_package,
            now=NOW,
            operational_evidence=misplaced,
        )


def test_readiness_rejects_shared_roles_and_scorer_access() -> None:
    shared_role = _ready()
    shared_role["role_bindings"][1]["key_id"] = shared_role["role_bindings"][0]["key_id"]  # type: ignore[index]
    with pytest.raises(ReadinessError, match="distinct key IDs"):
        build_product_readiness_report(shared_role, now=NOW)

    scorer_is_developer = _ready()
    scorer_is_developer["operational"]["development_uids"] = [1000, 5000]  # type: ignore[index]
    with pytest.raises(ReadinessError, match="blind scorer UID"):
        build_product_readiness_report(scorer_is_developer, now=NOW)

    boolean_uid = _ready()
    boolean_uid["operational"]["blind_scorer_uid"] = True  # type: ignore[index]
    with pytest.raises(ReadinessError, match="non-negative integer"):
        build_product_readiness_report(boolean_uid, now=NOW)


def test_readiness_requires_an_untouched_holdout_log() -> None:
    consumed = _ready()
    consumed["operational"]["access_log_events"] = 1  # type: ignore[index]
    with pytest.raises(ReadinessError, match="untouched holdout access log"):
        build_product_readiness_report(consumed, now=NOW)

    changed_head = _ready()
    changed_head["operational"]["access_log_head_sha256"] = "f" * 64  # type: ignore[index]
    with pytest.raises(ReadinessError, match="genesis digest"):
        build_product_readiness_report(changed_head, now=NOW)


def test_operational_evidence_is_live_hash_bound_and_least_privilege(tmp_path: Path) -> None:
    package = _ready()
    operational = package["operational"]
    assert isinstance(operational, dict)
    operational["blind_scorer_uid"] = os.geteuid()
    operational["blind_scorer_gid"] = os.getegid()
    operational["development_uids"] = [os.geteuid() + 1]
    holdout_root = tmp_path / "holdout"
    access_log_root = tmp_path / "audit"
    holdout_root.mkdir(mode=0o700)
    access_log_root.mkdir(mode=0o700)
    access_log = access_log_root / "access.jsonl"
    access_log.write_bytes(b"")
    access_log.chmod(0o600)
    policy = _trust_policy()

    first = build_operational_readiness_evidence(
        package,
        holdout_root=holdout_root,
        access_log_root=access_log_root,
        access_log_path=access_log,
        trust_policy=policy,
        now=NOW,
    )
    second = build_operational_readiness_evidence(
        copy.deepcopy(package),
        holdout_root=holdout_root,
        access_log_root=access_log_root,
        access_log_path=access_log,
        trust_policy=copy.deepcopy(policy),
        now=NOW,
    )

    assert first == second
    assert first["operational_updates"]["access_log_events"] == 0
    assert first["trusted_key_policy_digest"] == document_sha256(policy)
    assert {entry["artifact_id"] for entry in first["evidence"]} == {
        "empty-access-log-report",
        "sealed-acl-report",
        "trusted-key-policy",
    }
    first["documents"]["trusted-key-policy"]["keys"][0]["roles"].append("mutated")
    assert (
        build_operational_readiness_evidence(
            package,
            holdout_root=holdout_root,
            access_log_root=access_log_root,
            access_log_path=access_log,
            trust_policy=policy,
            now=NOW,
        )
        == second
    )

    overprivileged = copy.deepcopy(policy)
    overprivileged["keys"][0]["roles"].append("release-authorizer")  # type: ignore[index]
    with pytest.raises(ReadinessError, match="must be exclusive"):
        build_operational_readiness_evidence(
            package,
            holdout_root=holdout_root,
            access_log_root=access_log_root,
            access_log_path=access_log,
            trust_policy=overprivileged,
            now=NOW,
        )

    holdout_root.chmod(0o750)
    with pytest.raises(ReadinessError, match="0700"):
        build_operational_readiness_evidence(
            package,
            holdout_root=holdout_root,
            access_log_root=access_log_root,
            access_log_path=access_log,
            trust_policy=policy,
            now=NOW,
        )


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


def test_operational_readiness_cli_emits_live_evidence(tmp_path: Path) -> None:
    package = _ready()
    operational = package["operational"]
    assert isinstance(operational, dict)
    operational["blind_scorer_uid"] = os.geteuid()
    operational["blind_scorer_gid"] = os.getegid()
    operational["development_uids"] = [os.geteuid() + 1]
    package_path = tmp_path / "readiness.json"
    trust_path = tmp_path / "trust.json"
    current_now = datetime.now(UTC).replace(microsecond=0)
    package_path.write_text(json.dumps(package), encoding="utf-8")
    trust_path.write_text(
        json.dumps(_trust_policy(current_now)),
        encoding="utf-8",
    )
    holdout_root = tmp_path / "holdout"
    access_log_root = tmp_path / "audit"
    holdout_root.mkdir(mode=0o700)
    access_log_root.mkdir(mode=0o700)
    access_log = access_log_root / "access.jsonl"
    access_log.write_bytes(b"")
    access_log.chmod(0o600)
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")

    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "operational-readiness-check",
            "--package",
            str(package_path),
            "--holdout-root",
            str(holdout_root),
            "--access-log-root",
            str(access_log_root),
            "--access-log",
            str(access_log),
            "--trust-policy",
            str(trust_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert result.returncode == 0, result.stderr
    assert len(result.stdout.splitlines()) == 1
    operational_evidence = json.loads(result.stdout)
    assert operational_evidence["schema_version"] == "ltx-av-eval-operational-readiness-evidence.v1"

    operational.update(operational_evidence["operational_updates"])
    operational["rights_valid_at"] = (current_now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    operational["rights_expires_at"] = (current_now + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    evidence_digests = {
        entry["artifact_id"]: entry["sha256"] for entry in operational_evidence["evidence"]
    }
    for entry in package["evidence"]:  # type: ignore[union-attr]
        if entry["artifact_id"] in evidence_digests:
            entry["sha256"] = evidence_digests[entry["artifact_id"]]
    evidence_path = tmp_path / "operational-evidence.json"
    package_path.write_text(json.dumps(package), encoding="utf-8")
    evidence_path.write_text(json.dumps(operational_evidence), encoding="utf-8")

    ready = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "readiness-check",
            "--package",
            str(package_path),
            "--operational-evidence",
            str(evidence_path),
            "--holdout-root",
            str(holdout_root),
            "--access-log-root",
            str(access_log_root),
            "--access-log",
            str(access_log),
            "--trust-policy",
            str(trust_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
        cwd=tmp_path,
    )

    assert ready.returncode == 0, ready.stderr
    assert json.loads(ready.stdout)["status"] == "ready-to-freeze"
