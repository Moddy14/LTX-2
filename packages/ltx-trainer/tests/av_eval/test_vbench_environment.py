from __future__ import annotations

import copy
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from ltx_trainer.av_eval import VBenchEnvironmentError, build_vbench_runtime_report, document_sha256

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
CONFIG_ROOT = REPOSITORY_ROOT / "packages" / "ltx-trainer" / "configs" / "av_eval"
RUNTIME_CONFIG_PATH = CONFIG_ROOT / "vbench-i2v-runtime.v1.json"
SOURCE_CONFIG_PATH = CONFIG_ROOT / "vbench-i2v-source.v1.json"


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _source_checkout(tmp_path: Path) -> tuple[dict[str, Any], Path]:
    config = copy.deepcopy(_load(SOURCE_CONFIG_PATH))
    checkout = tmp_path / "vbench"
    checkout.mkdir(parents=True)
    for item in config["source_files"]:
        path = checkout / item["path"]
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = b"VALUE = 1\n" if path.suffix == ".py" else f"fixture:{item['path']}\n".encode()
        path.write_bytes(payload)
        item["sha256"] = hashlib.sha256(payload).hexdigest()
    top_level_modules = {
        module.split(".", maxsplit=1)[0] for module in _load(RUNTIME_CONFIG_PATH)["import_modules"]
    }
    for module in sorted(top_level_modules - {"vbench"}):
        (checkout / f"{module}.py").write_text("VALUE = 1\n", encoding="utf-8")
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
            "user.name=VBench Runtime Test",
            "-c",
            "user.email=vbench-runtime@example.invalid",
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


def _directory_digest(path: Path) -> str:
    inventory = [
        {
            "path": item.relative_to(path).as_posix(),
            "sha256": hashlib.sha256(item.read_bytes()).hexdigest(),
            "size": item.stat().st_size,
        }
        for item in sorted(path.rglob("*"))
        if item.is_file()
    ]
    return document_sha256(inventory)


def _distributions(python: Path) -> list[dict[str, str]]:
    script = """
import importlib.metadata
import json
import re

result = []
for distribution in importlib.metadata.distributions():
    name = distribution.metadata.get("Name")
    if name:
        result.append({
            "name": re.sub(r"[-_.]+", "-", name).lower(),
            "version": distribution.version,
        })
result.sort(key=lambda item: item["name"])
print(json.dumps(result))
"""
    output = subprocess.run(
        [str(python), "-I", "-c", script],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    result = json.loads(output)
    assert len({item["name"] for item in result}) == len(result)
    return result


def _sealed_runtime(tmp_path: Path) -> tuple[dict[str, Any], dict[str, Any], Path, Path, Path]:
    source, checkout = _source_checkout(tmp_path)
    config = copy.deepcopy(_load(RUNTIME_CONFIG_PATH))
    config["status"] = "sealed"
    config["source_contract_sha256"] = document_sha256(source)
    environment_root = tmp_path / "environment"
    subprocess.run([sys.executable, "-m", "venv", "--without-pip", str(environment_root)], check=True)
    python = environment_root / "bin" / "python"
    site_packages = Path(
        subprocess.run(
            [str(python), "-I", "-c", "import sysconfig; print(sysconfig.get_paths()['purelib'])"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
    )
    fixture_metadata = site_packages / "vbench_runtime_fixture-1.0.dist-info"
    fixture_metadata.mkdir()
    (fixture_metadata / "METADATA").write_text(
        "Metadata-Version: 2.1\nName: vbench-runtime-fixture\nVersion: 1.0\n",
        encoding="utf-8",
    )
    config["python_version"] = subprocess.run(
        [str(python), "-I", "-c", "import platform; print(platform.python_version())"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    config["python_executable_sha256"] = hashlib.sha256(python.resolve(strict=True).read_bytes()).hexdigest()
    config["network_policy_sha256"] = "a" * 64
    config["distributions"] = _distributions(python)
    runtime_root = tmp_path / "runtime"
    lock = runtime_root / config["dependency_lock"]["path"]
    lock.parent.mkdir(parents=True)
    lock.write_text("sealed fixture lock\n", encoding="utf-8")
    config["dependency_lock"]["sha256"] = hashlib.sha256(lock.read_bytes()).hexdigest()
    for artifact in config["artifacts"]:
        path = runtime_root / artifact["path"]
        if artifact["kind"] == "file":
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"fixture:{artifact['artifact_id']}\n".encode())
            artifact["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        else:
            path.mkdir(parents=True)
            (path / "hubconf.py").write_text("VALUE = 1\n", encoding="utf-8")
            (path / "vision_transformer.py").write_text("VALUE = 1\n", encoding="utf-8")
            artifact["sha256"] = _directory_digest(path)
    for path in runtime_root.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)
    runtime_root.chmod(0o755)
    return config, source, checkout, runtime_root, python


def test_checked_in_runtime_contract_is_an_explicit_hold() -> None:
    config = _load(RUNTIME_CONFIG_PATH)

    assert config["status"] == "draft"
    assert config["source_contract_sha256"] == document_sha256(_load(SOURCE_CONFIG_PATH))
    assert [artifact["artifact_id"] for artifact in config["artifacts"]] == sorted(
        artifact["artifact_id"] for artifact in config["artifacts"]
    )
    assert all(artifact["sha256"] is None for artifact in config["artifacts"])


def test_sealed_runtime_verifies_source_python_dependencies_imports_and_artifacts(tmp_path: Path) -> None:
    config, source, checkout, runtime_root, python = _sealed_runtime(tmp_path)

    first = build_vbench_runtime_report(
        config,
        source_contract=source,
        checkout=checkout,
        runtime_root=runtime_root,
        python=python,
    )
    second = build_vbench_runtime_report(
        copy.deepcopy(config),
        source_contract=copy.deepcopy(source),
        checkout=checkout,
        runtime_root=runtime_root,
        python=python,
    )

    assert first == second
    assert first["status"] == "runtime-verified"
    assert first["blockers"] == []
    assert len(first["runtime_digest"]) == 64
    assert first["runtime_contract_digest"] == document_sha256(config)


def test_runtime_rejects_checkpoint_extra_file_and_distribution_drift(tmp_path: Path) -> None:
    config, source, checkout, runtime_root, python = _sealed_runtime(tmp_path)
    (runtime_root / config["artifacts"][0]["path"]).write_text("mutated\n", encoding="utf-8")
    with pytest.raises(VBenchEnvironmentError, match="artifact aesthetic-linear digest mismatch"):
        build_vbench_runtime_report(
            config,
            source_contract=source,
            checkout=checkout,
            runtime_root=runtime_root,
            python=python,
        )

    config, source, checkout, runtime_root, python = _sealed_runtime(tmp_path / "extra")
    (runtime_root / "unexpected.bin").write_bytes(b"unexpected")
    with pytest.raises(VBenchEnvironmentError, match="missing or unexpected files"):
        build_vbench_runtime_report(
            config,
            source_contract=source,
            checkout=checkout,
            runtime_root=runtime_root,
            python=python,
        )

    config, source, checkout, runtime_root, python = _sealed_runtime(tmp_path / "writable")
    (runtime_root / "aesthetic_model").chmod(0o775)
    with pytest.raises(VBenchEnvironmentError, match="group- or world-writable parent"):
        build_vbench_runtime_report(
            config,
            source_contract=source,
            checkout=checkout,
            runtime_root=runtime_root,
            python=python,
        )

    config, source, checkout, runtime_root, python = _sealed_runtime(tmp_path / "distribution")
    config["distributions"][0]["version"] = "0.invalid"
    with pytest.raises(VBenchEnvironmentError, match="distribution inventory mismatch"):
        build_vbench_runtime_report(
            config,
            source_contract=source,
            checkout=checkout,
            runtime_root=runtime_root,
            python=python,
        )


def test_draft_runtime_cli_emits_hold_without_touching_gpu_or_runtime_root(tmp_path: Path) -> None:
    source, checkout = _source_checkout(tmp_path)
    config = copy.deepcopy(_load(RUNTIME_CONFIG_PATH))
    config["source_contract_sha256"] = document_sha256(source)
    config_path = tmp_path / "runtime.json"
    source_path = tmp_path / "source.json"
    config_path.write_text(json.dumps(config), encoding="utf-8")
    source_path.write_text(json.dumps(source), encoding="utf-8")
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "src")

    result = subprocess.run(
        [
            sys.executable,
            str(REPOSITORY_ROOT / "packages" / "ltx-trainer" / "scripts" / "av_eval.py"),
            "vbench-environment-check",
            "--runtime-config",
            str(config_path),
            "--source-config",
            str(source_path),
            "--checkout",
            str(checkout),
            "--runtime-root",
            str(tmp_path / "missing-runtime"),
            "--python",
            str(tmp_path / "missing-python"),
        ],
        check=False,
        capture_output=True,
        text=True,
        env=environment,
    )

    assert result.returncode == 2, result.stderr
    report = json.loads(result.stdout)
    assert report["status"] == "hold"
    assert report["runtime_digest"] is None
    assert "dependency-lock-digest-missing" in report["blockers"]
