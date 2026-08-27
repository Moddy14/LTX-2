from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from ltx_trainer.av_eval import VBenchRuntimeError, build_vbench_source_report, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CONFIG_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "vbench-i2v-source.v1.json"
DESIGN_PATH = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval" / "design-pilot.v2.json"


def _load(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _fixture_checkout(tmp_path: Path) -> tuple[dict[str, object], Path]:
    config = copy.deepcopy(_load(CONFIG_PATH))
    checkout = tmp_path / "vbench"
    checkout.mkdir(parents=True)
    source_files = config["source_files"]
    assert isinstance(source_files, list)
    for item in source_files:
        path = checkout / item["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = f"fixture:{item['path']}\n".encode()
        path.write_bytes(payload)
        item["sha256"] = hashlib.sha256(payload).hexdigest()
    subprocess.run(["git", "init", "-q", str(checkout)], check=True)
    subprocess.run(
        ["git", "-C", str(checkout), "remote", "add", "origin", "https://github.com/Vchitect/VBench.git"],
        check=True,
    )
    subprocess.run(["git", "-C", str(checkout), "add", "."], check=True)
    subprocess.run(
        [
            "git",
            "-C",
            str(checkout),
            "-c",
            "user.name=VBench Test",
            "-c",
            "user.email=vbench-test@example.invalid",
            "commit",
            "-q",
            "-m",
            "fixture",
        ],
        check=True,
    )
    config["commit"] = subprocess.run(
        ["git", "-C", str(checkout), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    return config, checkout


def test_checked_in_vbench_contract_pins_official_source_and_design() -> None:
    config = _load(CONFIG_PATH)
    design = _load(DESIGN_PATH)
    catalog = design["vbench_gate_catalog"]
    assert isinstance(catalog, dict)

    assert config["repository_url"] == "https://github.com/Vchitect/VBench"
    assert config["commit"] == "45e79ec14e69a2187202c675d2dbce1a71843d53"
    assert len(config["source_files"]) == 17
    assert catalog["commit"] == config["commit"]
    assert catalog["config_sha256"] == document_sha256(config)


def test_vbench_source_report_verifies_revision_remote_files_and_invocation(tmp_path: Path) -> None:
    config, checkout = _fixture_checkout(tmp_path)

    first = build_vbench_source_report(config, checkout=checkout)
    second = build_vbench_source_report(copy.deepcopy(config), checkout=checkout)

    assert first == second
    assert first["status"] == "source-verified"
    assert first["verified_files"] == 17
    assert first["source_contract_digest"] == document_sha256(config)
    assert first["invocation"]["aggregate_scores"] is False


def test_vbench_source_report_fails_closed_on_source_or_remote_drift(tmp_path: Path) -> None:
    config, checkout = _fixture_checkout(tmp_path)
    (checkout / "evaluate_i2v.py").write_text("mutated\n", encoding="utf-8")
    with pytest.raises(VBenchRuntimeError, match="source hash mismatch"):
        build_vbench_source_report(config, checkout=checkout)

    config, checkout = _fixture_checkout(tmp_path / "remote")
    subprocess.run(
        ["git", "-C", str(checkout), "remote", "set-url", "origin", "https://example.invalid/VBench"],
        check=True,
    )
    with pytest.raises(VBenchRuntimeError, match="official repository"):
        build_vbench_source_report(config, checkout=checkout)

    config, checkout = _fixture_checkout(tmp_path / "untracked")
    (checkout / "vbench" / "third_party" / "runtime_override.py").parent.mkdir(parents=True)
    (checkout / "vbench" / "third_party" / "runtime_override.py").write_text("drift = True\n", encoding="utf-8")
    with pytest.raises(VBenchRuntimeError, match="tracked or untracked changes"):
        build_vbench_source_report(config, checkout=checkout)


def test_vbench_source_cli_emits_digest_bound_report(tmp_path: Path) -> None:
    config, checkout = _fixture_checkout(tmp_path)
    config_path = tmp_path / "source.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")

    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "vbench-runtime-check",
            "--config",
            str(config_path),
            "--checkout",
            str(checkout),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
    )

    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["status"] == "source-verified"
    assert report["source_contract_digest"] == document_sha256(config)
