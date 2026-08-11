"""Sealed dependency and checkpoint fingerprint for the VBench-I2V runtime."""

from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

from .design import document_sha256
from .vbench_runtime import VBenchRuntimeError, build_vbench_source_report

RUNTIME_SCHEMA = "ltx-av-eval-vbench-i2v-runtime.v1"
RUNTIME_REPORT_SCHEMA = "ltx-av-eval-vbench-i2v-runtime-report.v1"
REQUIRED_IMPORTS = (
    "clip",
    "cv2",
    "decord",
    "numpy",
    "omegaconf",
    "pyiqa",
    "skimage",
    "torch",
    "torchvision",
    "transformers",
    "vbench.aesthetic_quality",
    "vbench.background_consistency",
    "vbench.dynamic_degree",
    "vbench.imaging_quality",
    "vbench.motion_smoothness",
    "vbench.subject_consistency",
    "vbench.utils",
    "yaml",
)
REQUIRED_ARTIFACTS = {
    "aesthetic-linear": ("file", "aesthetic_model/emb_reader/sa_0_4_vit_l_14_linear.pth"),
    "amt-s": ("file", "amt_model/amt-s.pth"),
    "clip-vit-b-32": ("file", "clip_model/ViT-B-32.pt"),
    "clip-vit-l-14": ("file", "clip_model/ViT-L-14.pt"),
    "dino-source": ("directory", "dino_model/facebookresearch_dino_main"),
    "dino-vitbase16": ("file", "dino_model/dino_vitbase16_pretrain.pth"),
    "musiq-spaq": ("file", "pyiqa_model/musiq_spaq_ckpt-358bb6af.pth"),
    "raft-things": ("file", "raft_model/models/raft-things.pth"),
}
MAX_DIRECTORY_FILES = 100_000
INVENTORY_MARKER = "LTX_VBENCH_RUNTIME_INVENTORY="


class VBenchEnvironmentError(ValueError):
    """Raised when the installed VBench evaluator runtime is mutable or drifted."""


def _exact_keys(value: dict[str, Any], expected: set[str], context: str) -> None:
    missing = sorted(expected - value.keys())
    unknown = sorted(value.keys() - expected)
    if missing or unknown:
        raise VBenchEnvironmentError(f"{context}: missing={missing}, unknown={unknown}")


def _sha256(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise VBenchEnvironmentError(f"{context} must be a lowercase SHA-256")
    return value


def _canonical_path(value: object, context: str) -> str:
    if not isinstance(value, str):
        raise VBenchEnvironmentError(f"{context} must be a string")
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value or not value:
        raise VBenchEnvironmentError(f"{context} must be a canonical relative path")
    return value


def _normalized_distribution(value: object, context: str) -> str:
    if not isinstance(value, str) or not value:
        raise VBenchEnvironmentError(f"{context} must be a distribution name")
    normalized = value.lower().replace("_", "-").replace(".", "-")
    if any(character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in normalized):
        raise VBenchEnvironmentError(f"{context} contains unsupported characters")
    return normalized


def _version(value: object, context: str, *, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not value or len(value) > 128 or any(ord(character) < 33 for character in value):
        raise VBenchEnvironmentError(f"{context} must be a compact printable version")
    return value


def _validate_distributions(raw: object, *, draft: bool) -> tuple[list[dict[str, str]], list[str]]:
    if not isinstance(raw, list):
        raise VBenchEnvironmentError("distributions must be a list")
    blockers: list[str] = []
    result: list[dict[str, str]] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise VBenchEnvironmentError(f"distribution {index} must be an object")
        _exact_keys(item, {"name", "version"}, f"distribution {index}")
        result.append(
            {
                "name": _normalized_distribution(item["name"], f"distribution {index}.name"),
                "version": _version(item["version"], f"distribution {index}.version"),
            }
        )
    if result != sorted(result, key=lambda item: item["name"]) or len({item["name"] for item in result}) != len(result):
        raise VBenchEnvironmentError("distributions must be sorted and unique by normalized name")
    if not result:
        if not draft:
            raise VBenchEnvironmentError("sealed runtime needs a complete distribution inventory")
        blockers.append("distribution-inventory-missing")
    return result, blockers


def _validate_artifacts(raw: object, *, draft: bool) -> tuple[list[dict[str, Any]], list[str]]:
    if not isinstance(raw, list):
        raise VBenchEnvironmentError("artifacts must be a list")
    result: list[dict[str, Any]] = []
    blockers: list[str] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise VBenchEnvironmentError(f"artifact {index} must be an object")
        _exact_keys(item, {"artifact_id", "kind", "path", "sha256"}, f"artifact {index}")
        artifact_id = item["artifact_id"]
        if artifact_id not in REQUIRED_ARTIFACTS:
            raise VBenchEnvironmentError(f"artifact {index}.artifact_id is unsupported")
        kind, path = REQUIRED_ARTIFACTS[artifact_id]
        if item["kind"] != kind or _canonical_path(item["path"], f"artifact {artifact_id}.path") != path:
            raise VBenchEnvironmentError(f"artifact {artifact_id} kind or path changed")
        digest = _sha256(item["sha256"], f"artifact {artifact_id}.sha256", nullable=True)
        if digest is None:
            if not draft:
                raise VBenchEnvironmentError(f"sealed runtime artifact {artifact_id} has no digest")
            blockers.append(f"artifact-digest-missing:{artifact_id}")
        result.append({"artifact_id": artifact_id, "kind": kind, "path": path, "sha256": digest})
    if [item["artifact_id"] for item in result] != sorted(REQUIRED_ARTIFACTS):
        raise VBenchEnvironmentError("artifacts must exactly match the sorted runtime inventory")
    return result, blockers


def _validate_contract(raw: object) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, str]], list[str]]:
    if not isinstance(raw, dict):
        raise VBenchEnvironmentError("VBench runtime contract must be an object")
    _exact_keys(
        raw,
        {
            "schema_version",
            "status",
            "source_contract_sha256",
            "python_version",
            "python_executable_sha256",
            "dependency_lock",
            "network_policy_sha256",
            "import_modules",
            "distributions",
            "artifacts",
        },
        "VBench runtime contract",
    )
    if raw["schema_version"] != RUNTIME_SCHEMA or raw["status"] not in {"draft", "sealed"}:
        raise VBenchEnvironmentError("unsupported VBench runtime schema or status")
    draft = raw["status"] == "draft"
    _sha256(raw["source_contract_sha256"], "source_contract_sha256")
    blockers: list[str] = []
    if _version(raw["python_version"], "python_version", nullable=True) is None:
        blockers.append("python-version-missing")
    if _sha256(raw["python_executable_sha256"], "python_executable_sha256", nullable=True) is None:
        blockers.append("python-executable-digest-missing")
    dependency_lock = raw["dependency_lock"]
    if not isinstance(dependency_lock, dict):
        raise VBenchEnvironmentError("dependency_lock must be an object")
    _exact_keys(dependency_lock, {"path", "sha256"}, "dependency_lock")
    _canonical_path(dependency_lock["path"], "dependency_lock.path")
    if _sha256(dependency_lock["sha256"], "dependency_lock.sha256", nullable=True) is None:
        blockers.append("dependency-lock-digest-missing")
    if _sha256(raw["network_policy_sha256"], "network_policy_sha256", nullable=True) is None:
        blockers.append("network-policy-digest-missing")
    modules = raw["import_modules"]
    if not isinstance(modules, list) or tuple(modules) != REQUIRED_IMPORTS:
        raise VBenchEnvironmentError("import_modules must exactly match the sorted release-dimension inventory")
    distributions, distribution_blockers = _validate_distributions(raw["distributions"], draft=draft)
    artifacts, artifact_blockers = _validate_artifacts(raw["artifacts"], draft=draft)
    blockers.extend(distribution_blockers)
    blockers.extend(artifact_blockers)
    if not draft and blockers:
        raise VBenchEnvironmentError(f"sealed VBench runtime is incomplete: {sorted(blockers)}")
    return raw, artifacts, distributions, sorted(blockers)


def _assert_sealed_path(path: Path, *, root: Path, kind: str, context: str) -> Path:
    if path.is_symlink():
        raise VBenchEnvironmentError(f"{context} cannot be a symlink")
    if (kind == "file" and not path.is_file()) or (kind == "directory" and not path.is_dir()):
        raise VBenchEnvironmentError(f"{context} is missing or has the wrong kind")
    resolved = path.resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as error:
        raise VBenchEnvironmentError(f"{context} escapes the runtime root") from error
    if stat.S_IMODE(path.stat().st_mode) & 0o022:
        raise VBenchEnvironmentError(f"{context} is group- or world-writable")
    parent = path.parent
    while path != root and parent != root.parent:
        if parent.is_symlink():
            raise VBenchEnvironmentError(f"{context} has a symlinked parent")
        if stat.S_IMODE(parent.stat().st_mode) & 0o022:
            raise VBenchEnvironmentError(f"{context} has a group- or world-writable parent")
        if parent == root:
            break
        parent = parent.parent
    return resolved


def _file_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _directory_inventory(path: Path, *, root: Path, context: str) -> tuple[str, list[Path]]:
    inventory: list[dict[str, Any]] = []
    files: list[Path] = []
    for entry in sorted(path.rglob("*")):
        relative = entry.relative_to(path).as_posix()
        if entry.is_symlink():
            raise VBenchEnvironmentError(f"{context} contains a symlink: {relative}")
        if entry.is_dir():
            _assert_sealed_path(entry, root=root, kind="directory", context=f"{context}/{relative}")
            continue
        resolved = _assert_sealed_path(entry, root=root, kind="file", context=f"{context}/{relative}")
        files.append(resolved)
        inventory.append({"path": relative, "sha256": _file_digest(resolved), "size": resolved.stat().st_size})
        if len(files) > MAX_DIRECTORY_FILES:
            raise VBenchEnvironmentError(f"{context} exceeds {MAX_DIRECTORY_FILES} files")
    if not inventory:
        raise VBenchEnvironmentError(f"{context} cannot be empty")
    return document_sha256(inventory), files


def _python_inventory(python: Path, *, checkout: Path, runtime_root: Path, modules: list[str]) -> dict[str, Any]:
    script = """
import importlib
import importlib.metadata
import json
import platform
import re
import sys

sys.path.insert(0, sys.argv[1])
modules = json.loads(sys.argv[2])
for module in modules:
    importlib.import_module(module)
distributions = []
for distribution in importlib.metadata.distributions():
    name = distribution.metadata.get("Name")
    if name:
        normalized = re.sub(r"[-_.]+", "-", name).lower()
        distributions.append({"name": normalized, "version": distribution.version})
distributions.sort(key=lambda item: item["name"])
print("LTX_VBENCH_RUNTIME_INVENTORY=" + json.dumps({
    "python_version": platform.python_version(),
    "distributions": distributions,
    "imports": modules,
}, sort_keys=True))
"""
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(runtime_root / "_runtime" / "home"),
        "VBENCH_CACHE_DIR": str(runtime_root),
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONNOUSERSITE": "1",
        "CUDA_VISIBLE_DEVICES": "",
    }
    try:
        result = subprocess.run(
            [str(python), "-I", "-B", "-W", "error", "-c", script, str(checkout), json.dumps(modules)],
            check=True,
            capture_output=True,
            text=True,
            timeout=120,
            env=environment,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise VBenchEnvironmentError("isolated VBench import smoke failed") from error
    lines = [line for line in result.stdout.splitlines() if line.startswith(INVENTORY_MARKER)]
    if len(lines) != 1:
        raise VBenchEnvironmentError("isolated VBench import smoke emitted no unique inventory")
    try:
        inventory = json.loads(lines[0].removeprefix(INVENTORY_MARKER))
    except json.JSONDecodeError as error:
        raise VBenchEnvironmentError("isolated VBench import inventory is invalid JSON") from error
    if not isinstance(inventory, dict):
        raise VBenchEnvironmentError("isolated VBench import inventory must be an object")
    return inventory


def build_vbench_runtime_report(  # noqa: PLR0912, PLR0915
    raw: object,
    *,
    source_contract: object,
    checkout: Path,
    runtime_root: Path,
    python: Path,
) -> dict[str, Any]:
    """Verify one clean source tree, exact environment, and sealed checkpoint cache."""

    contract, artifacts, distributions, blockers = _validate_contract(raw)
    try:
        source_report = build_vbench_source_report(source_contract, checkout=checkout)
    except VBenchRuntimeError as error:
        raise VBenchEnvironmentError(f"VBench source contract rejected: {error}") from error
    if contract["source_contract_sha256"] != source_report["source_contract_digest"]:
        raise VBenchEnvironmentError("runtime source contract digest mismatch")
    if contract["status"] == "draft":
        return {
            "schema_version": RUNTIME_REPORT_SCHEMA,
            "status": "hold",
            "blockers": blockers,
            "runtime_contract_digest": document_sha256(contract),
            "source_report_digest": document_sha256(source_report),
            "runtime_digest": None,
        }
    if runtime_root.is_symlink() or not runtime_root.is_dir():
        raise VBenchEnvironmentError("runtime root must be a real directory")
    runtime_root = runtime_root.resolve(strict=True)
    _assert_sealed_path(runtime_root, root=runtime_root, kind="directory", context="runtime root")
    expected_files: set[Path] = set()
    lock_path = _assert_sealed_path(
        runtime_root / contract["dependency_lock"]["path"],
        root=runtime_root,
        kind="file",
        context="dependency lock",
    )
    expected_files.add(lock_path)
    if _file_digest(lock_path) != contract["dependency_lock"]["sha256"]:
        raise VBenchEnvironmentError("dependency lock digest mismatch")
    artifact_digests: list[dict[str, str]] = []
    for artifact in artifacts:
        path = _assert_sealed_path(
            runtime_root / artifact["path"],
            root=runtime_root,
            kind=artifact["kind"],
            context=f"artifact {artifact['artifact_id']}",
        )
        if artifact["kind"] == "file":
            digest = _file_digest(path)
            expected_files.add(path)
        else:
            digest, directory_files = _directory_inventory(
                path,
                root=runtime_root,
                context=f"artifact {artifact['artifact_id']}",
            )
            expected_files.update(directory_files)
        if digest != artifact["sha256"]:
            raise VBenchEnvironmentError(f"artifact {artifact['artifact_id']} digest mismatch")
        artifact_digests.append({"artifact_id": artifact["artifact_id"], "sha256": digest})
    actual_files: set[Path] = set()
    for path in runtime_root.rglob("*"):
        if path.is_symlink():
            raise VBenchEnvironmentError(f"runtime root contains a symlink: {path.relative_to(runtime_root)}")
        if path.is_file():
            actual_files.add(path.resolve(strict=True))
    if actual_files != expected_files:
        raise VBenchEnvironmentError("runtime root contains missing or unexpected files")
    python_command = python
    python_binary = python.resolve(strict=True) if python.is_symlink() else python
    if not python_command.is_file() or not python_binary.is_file():
        raise VBenchEnvironmentError("runtime Python executable is missing")
    if _file_digest(python_binary) != contract["python_executable_sha256"]:
        raise VBenchEnvironmentError("runtime Python executable digest mismatch")
    inventory = _python_inventory(
        python_command,
        checkout=checkout.resolve(strict=True),
        runtime_root=runtime_root,
        modules=contract["import_modules"],
    )
    if inventory.get("python_version") != contract["python_version"]:
        raise VBenchEnvironmentError("runtime Python version mismatch")
    if inventory.get("imports") != contract["import_modules"]:
        raise VBenchEnvironmentError("runtime import inventory mismatch")
    if inventory.get("distributions") != distributions:
        raise VBenchEnvironmentError("runtime distribution inventory mismatch")
    try:
        post_import_source_report = build_vbench_source_report(source_contract, checkout=checkout)
    except VBenchRuntimeError as error:
        raise VBenchEnvironmentError(f"VBench import smoke mutated its source tree: {error}") from error
    if post_import_source_report != source_report:
        raise VBenchEnvironmentError("VBench source report changed during import smoke")
    post_import_files: set[Path] = set()
    for path in runtime_root.rglob("*"):
        if path.is_symlink():
            raise VBenchEnvironmentError(f"runtime import created a symlink: {path.relative_to(runtime_root)}")
        if path.is_file():
            post_import_files.add(path.resolve(strict=True))
    if post_import_files != expected_files or _file_digest(lock_path) != contract["dependency_lock"]["sha256"]:
        raise VBenchEnvironmentError("runtime import mutated the sealed file inventory")
    for artifact in artifacts:
        path = (runtime_root / artifact["path"]).resolve(strict=True)
        digest = (
            _file_digest(path)
            if artifact["kind"] == "file"
            else _directory_inventory(path, root=runtime_root, context=f"artifact {artifact['artifact_id']}")[0]
        )
        if digest != artifact["sha256"]:
            raise VBenchEnvironmentError(f"runtime import mutated artifact {artifact['artifact_id']}")
    fingerprint = {
        "runtime_contract_digest": document_sha256(contract),
        "source_report_digest": document_sha256(source_report),
        "python_executable_sha256": contract["python_executable_sha256"],
        "python_version": contract["python_version"],
        "dependency_lock_sha256": contract["dependency_lock"]["sha256"],
        "network_policy_sha256": contract["network_policy_sha256"],
        "distribution_inventory_digest": document_sha256(distributions),
        "artifact_inventory_digest": document_sha256(artifact_digests),
        "import_inventory_digest": document_sha256(contract["import_modules"]),
    }
    return {
        "schema_version": RUNTIME_REPORT_SCHEMA,
        "status": "runtime-verified",
        "blockers": [],
        **fingerprint,
        "runtime_digest": document_sha256(fingerprint),
    }
