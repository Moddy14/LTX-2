"""Fail-closed source verification for the pinned official VBench-I2V evaluator."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

from .design import document_sha256

SOURCE_SCHEMA = "ltx-av-eval-vbench-i2v-source.v1"
SOURCE_REPORT_SCHEMA = "ltx-av-eval-vbench-i2v-source-report.v1"
OFFICIAL_REPOSITORY = "https://github.com/Vchitect/VBench"
CUSTOM_INPUT_DIMENSIONS = {
    "aesthetic_quality",
    "background_consistency",
    "camera_motion",
    "dynamic_degree",
    "i2v_background",
    "i2v_subject",
    "imaging_quality",
    "motion_smoothness",
    "subject_consistency",
}
RELEASE_DIMENSIONS = {
    "aesthetic-quality",
    "background-consistency",
    "dynamic-degree",
    "imaging-quality",
    "motion-smoothness",
    "subject-consistency",
}
REQUIRED_SOURCE_FILES = {
    "LICENSE",
    "evaluate_i2v.py",
    "requirements.txt",
    "setup.py",
    "vbench/aesthetic_quality.py",
    "vbench/background_consistency.py",
    "vbench/dynamic_degree.py",
    "vbench/imaging_quality.py",
    "vbench/motion_smoothness.py",
    "vbench/subject_consistency.py",
    "vbench/utils.py",
    "vbench2_beta_i2v/__init__.py",
    "vbench2_beta_i2v/camera_motion.py",
    "vbench2_beta_i2v/i2v_background.py",
    "vbench2_beta_i2v/i2v_subject.py",
    "vbench2_beta_i2v/utils.py",
    "vbench2_beta_i2v/vbench2_i2v_full_info.json",
}


class VBenchRuntimeError(ValueError):
    """Raised when VBench source identity or invocation semantics drift."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise VBenchRuntimeError(f"{context}: missing={missing}, unknown={unknown}")


def _sha256(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise VBenchRuntimeError(f"{context} must be a lowercase SHA-256")
    return value


def _revision(value: object, context: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 40
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise VBenchRuntimeError(f"{context} must be a lowercase 40-character Git revision")
    return value


def _run_git(checkout: Path, *arguments: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(checkout), *arguments],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise VBenchRuntimeError(f"cannot inspect VBench Git checkout: {' '.join(arguments)}") from error
    return result.stdout.strip()


def _normalized_repository(value: str) -> str:
    return value.removesuffix(".git").rstrip("/")


def _validate_source_files(raw: object) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        raise VBenchRuntimeError("source_files must be a list")
    files: list[dict[str, str]] = []
    paths: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise VBenchRuntimeError(f"source file {index} must be an object")
        _exact_keys(item, {"path", "sha256"}, f"source file {index}")
        path = item["path"]
        if not isinstance(path, str):
            raise VBenchRuntimeError(f"source file {index}.path must be a string")
        pure_path = PurePosixPath(path)
        if pure_path.is_absolute() or ".." in pure_path.parts or str(pure_path) != path:
            raise VBenchRuntimeError(f"source file {index}.path is not a canonical relative path")
        paths.append(path)
        files.append({"path": path, "sha256": _sha256(item["sha256"], f"source file {path}.sha256")})
    if paths != sorted(REQUIRED_SOURCE_FILES):
        raise VBenchRuntimeError("source_files must exactly match the sorted VBench-I2V source inventory")
    return files


def _validate_dimensions(raw: object, expected: set[str], context: str) -> list[str]:
    if not isinstance(raw, list) or not all(isinstance(value, str) for value in raw):
        raise VBenchRuntimeError(f"{context} must be a string list")
    if raw != sorted(expected):
        raise VBenchRuntimeError(f"{context} must exactly match the sorted supported inventory")
    return raw


def _validate_contract(raw: object) -> tuple[dict[str, Any], list[dict[str, str]]]:
    if not isinstance(raw, dict):
        raise VBenchRuntimeError("VBench source contract must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "repository_url",
            "commit",
            "source_files",
            "custom_input_dimensions",
            "release_dimensions",
            "invocation",
        },
        "VBench source contract",
    )
    if raw["schema_version"] != SOURCE_SCHEMA or raw["repository_url"] != OFFICIAL_REPOSITORY:
        raise VBenchRuntimeError("unsupported VBench source schema or repository")
    _revision(raw["commit"], "VBench commit")
    files = _validate_source_files(raw["source_files"])
    _validate_dimensions(raw["custom_input_dimensions"], CUSTOM_INPUT_DIMENSIONS, "custom_input_dimensions")
    _validate_dimensions(raw["release_dimensions"], RELEASE_DIMENSIONS, "release_dimensions")
    invocation = raw["invocation"]
    if not isinstance(invocation, dict):
        raise VBenchRuntimeError("invocation must be an object")
    _exact_keys(
        invocation,
        {"entrypoint", "mode", "imaging_quality_preprocessing_mode", "aggregate_scores"},
        "invocation",
    )
    if invocation != {
        "entrypoint": "evaluate_i2v.py",
        "mode": "custom_input",
        "imaging_quality_preprocessing_mode": "longer",
        "aggregate_scores": False,
    }:
        raise VBenchRuntimeError("VBench invocation contract changed")
    return raw, files


def build_vbench_source_report(raw: object, *, checkout: Path) -> dict[str, Any]:
    """Verify an official checkout against the frozen, dimension-level I2V source contract."""

    contract, source_files = _validate_contract(raw)
    if checkout.is_symlink() or not checkout.is_dir():
        raise VBenchRuntimeError("VBench checkout must be a real directory, not a symlink")
    checkout = checkout.resolve(strict=True)
    head = _run_git(checkout, "rev-parse", "HEAD")
    if head != contract["commit"]:
        raise VBenchRuntimeError("VBench checkout revision does not match the source contract")
    remote = _run_git(checkout, "config", "--get", "remote.origin.url")
    if _normalized_repository(remote) != _normalized_repository(contract["repository_url"]):
        raise VBenchRuntimeError("VBench checkout remote is not the official repository")

    for item in source_files:
        path = checkout / item["path"]
        if path.is_symlink() or not path.is_file():
            raise VBenchRuntimeError(f"VBench source file is missing or symlinked: {item['path']}")
        try:
            path.resolve(strict=True).relative_to(checkout)
        except ValueError as error:
            raise VBenchRuntimeError(f"VBench source file escapes checkout: {item['path']}") from error
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != item["sha256"]:
            raise VBenchRuntimeError(f"VBench source hash mismatch: {item['path']}")

    dirty = _run_git(checkout, "status", "--porcelain", "--", *[item["path"] for item in source_files])
    if dirty:
        raise VBenchRuntimeError("VBench source inventory has tracked or untracked changes")
    return {
        "schema_version": SOURCE_REPORT_SCHEMA,
        "status": "source-verified",
        "source_contract_digest": document_sha256(contract),
        "repository_url": contract["repository_url"],
        "commit": head,
        "source_tree_digest": document_sha256(source_files),
        "verified_files": len(source_files),
        "custom_input_dimensions": contract["custom_input_dimensions"],
        "release_dimensions": contract["release_dimensions"],
        "invocation": contract["invocation"],
    }
