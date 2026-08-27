from __future__ import annotations

import base64
import csv
import hashlib
import importlib.metadata
import json
import os
import subprocess
import sys
import tomllib
import warnings
from pathlib import Path

EXPECTED_NATTEN_VERSION = "0.21.7+torch2130cu132"
EXPECTED_NATTEN_URL = (
    "https://github.com/SHI-Labs/NATTEN/releases/download/v0.21.7/"
    "natten-0.21.7%2Btorch2130cu132-cp312-cp312-linux_aarch64.whl"
)
EXPECTED_NATTEN_SHA256 = "f2745ee3ad50f58b8aa3c4496b67461afcbdb088051eb929b090b88d241bcef1"
EXPECTED_NATTEN_MARKER = "platform_machine == 'aarch64' and sys_platform == 'linux'"
EXPECTED_NATTEN_REQUIREMENT = (
    f"natten @ {EXPECTED_NATTEN_URL}#sha256={EXPECTED_NATTEN_SHA256} ; "
    "sys_platform == 'linux' and platform_machine == 'aarch64'"
)
EXPECTED_TORCH_VERSION = "2.13.0+cu132"
EXPECTED_TORCH_URL = (
    "https://download-r2.pytorch.org/whl/cu132/"
    "torch-2.13.0%2Bcu132-cp312-cp312-manylinux_2_28_aarch64.whl"
)
EXPECTED_TORCH_SHA256 = "184f88e91546a2087aee2e5e71012ea6182aaf9d6bc81c28375be2816c349a49"
EXPECTED_TORCH_REQUIREMENT = f"torch @ {EXPECTED_TORCH_URL}#sha256={EXPECTED_TORCH_SHA256}"

EXPECTED_DISTRIBUTIONS = (
    "kornia",
    "ltx-core",
    "ltx-pipelines",
    "natten",
    "nvidia-cudnn-cu13",
    "openai-whisper",
    "requests",
    "setuptools",
    "torch",
    "torchaudio",
    "torchvision",
    "transformers",
)
EXPECTED_VERSIONS = {
    "kornia": "0.8.2",
    "ltx-core": "1.3.0",
    "ltx-pipelines": "1.3.0",
    "natten": EXPECTED_NATTEN_VERSION,
    "nvidia-cudnn-cu13": "9.24.0.43",
    "openai-whisper": "20250625",
    "requests": "2.34.2",
    "setuptools": "84.0.0",
    "torch": EXPECTED_TORCH_VERSION,
    "torchaudio": "2.11.0+cu132",
    "torchvision": "0.28.0+cu132",
    "transformers": "5.14.1",
}
EXPECTED_CUSPARSELT_VERSION = "0.8.1"
EXPECTED_CUSPARSELT_TAG = "Tag: py3-none-manylinux2014_aarch64\n"
EXPECTED_TORCH_CUDNN_REQUIREMENT = (
    'Requires-Dist: nvidia-cudnn-cu13==9.24.0.43; platform_system == "Linux"\n'
)


def _load_toml(path: Path, label: str) -> dict[str, object]:
    try:
        payload = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        raise SystemExit(f"unable to read {label}: {error}") from error
    if not isinstance(payload, dict):
        raise SystemExit(f"{label} must contain a TOML table")
    return payload


def _single_locked_package(lock: dict[str, object], name: str) -> dict[str, object]:
    packages = lock.get("package")
    if not isinstance(packages, list):
        raise SystemExit("native runtime lock has no package inventory")
    matches = [
        package
        for package in packages
        if isinstance(package, dict) and package.get("name") == name
    ]
    if len(matches) != 1:
        raise SystemExit(f"native runtime lock must contain exactly one {name} package")
    return matches[0]


def _project_requirements_named(dependencies: list[object], name: str) -> list[str]:
    matches: list[str] = []
    normalized_name = name.lower()
    for dependency in dependencies:
        if not isinstance(dependency, str):
            continue
        normalized = dependency.lstrip().lower()
        if normalized == normalized_name or (
            normalized.startswith(normalized_name)
            and normalized[len(normalized_name)] in " [<>=!~@;"
        ):
            matches.append(dependency)
    return matches


def verify_diffvae_lock_contract(
    pyproject_path: Path | None = None,
    lock_path: Path | None = None,
) -> None:
    runtime_root = Path(__file__).resolve().parent
    pyproject = _load_toml(pyproject_path or runtime_root / "pyproject.toml", "runtime pyproject")
    lock = _load_toml(lock_path or runtime_root / "uv.lock", "runtime lock")

    project = pyproject.get("project")
    dependencies = project.get("dependencies") if isinstance(project, dict) else None
    if not isinstance(dependencies, list) or dependencies.count(EXPECTED_NATTEN_REQUIREMENT) != 1:
        raise SystemExit("NATTEN must be an active, exact AArch64 runtime dependency")
    natten_requirements = _project_requirements_named(dependencies, "natten")
    if natten_requirements != [EXPECTED_NATTEN_REQUIREMENT]:
        raise SystemExit("runtime pyproject contains an unexpected NATTEN requirement")
    if _project_requirements_named(dependencies, "torch") != [EXPECTED_TORCH_REQUIREMENT]:
        raise SystemExit("NATTEN requires the exact direct Torch 2.13 CUDA 13.2 wheel pin")

    tool = pyproject.get("tool")
    uv = tool.get("uv") if isinstance(tool, dict) else None
    no_sources = uv.get("no-sources-package") if isinstance(uv, dict) else None
    if not isinstance(no_sources, list) or no_sources.count("natten") != 1:
        raise SystemExit("NATTEN must ignore inherited uv source overrides")

    root = _single_locked_package(lock, "ltx-studio-native-runtime")
    root_dependencies = root.get("dependencies")
    locked_root_natten = [
        dependency
        for dependency in root_dependencies
        if isinstance(dependency, dict) and dependency.get("name") == "natten"
    ] if isinstance(root_dependencies, list) else []
    if locked_root_natten != [{"name": "natten"}]:
        raise SystemExit("NATTEN is not an active root dependency in the runtime lock")
    metadata = root.get("metadata")
    requires_dist = metadata.get("requires-dist") if isinstance(metadata, dict) else None
    locked_natten_requirements = [
        requirement
        for requirement in requires_dist
        if isinstance(requirement, dict) and requirement.get("name") == "natten"
    ] if isinstance(requires_dist, list) else []
    if locked_natten_requirements != [{
        "name": "natten",
        "marker": EXPECTED_NATTEN_MARKER,
        "url": EXPECTED_NATTEN_URL,
    }]:
        raise SystemExit("runtime lock does not bind the exact active NATTEN requirement")
    locked_torch_requirements = [
        requirement
        for requirement in requires_dist
        if isinstance(requirement, dict) and requirement.get("name") == "torch"
    ] if isinstance(requires_dist, list) else []
    if locked_torch_requirements != [{"name": "torch", "url": EXPECTED_TORCH_URL}]:
        raise SystemExit("runtime lock does not bind the direct Torch wheel requirement")

    natten = _single_locked_package(lock, "natten")
    if natten.get("version") != EXPECTED_NATTEN_VERSION:
        raise SystemExit("runtime lock contains an unexpected NATTEN version")
    if natten.get("source") != {"url": EXPECTED_NATTEN_URL}:
        raise SystemExit("runtime lock contains an unexpected NATTEN source")
    if natten.get("wheels") != [{
        "url": EXPECTED_NATTEN_URL,
        "hash": f"sha256:{EXPECTED_NATTEN_SHA256}",
    }]:
        raise SystemExit("runtime lock does not bind the NATTEN AArch64 wheel SHA-256")

    torch = _single_locked_package(lock, "torch")
    if torch.get("version") != EXPECTED_TORCH_VERSION:
        raise SystemExit("NATTEN runtime is not paired with the exact Torch 2.13 CUDA 13.2 version")
    if torch.get("source") != {"url": EXPECTED_TORCH_URL} or torch.get("wheels") != [{
        "url": EXPECTED_TORCH_URL,
        "hash": f"sha256:{EXPECTED_TORCH_SHA256}",
    }]:
        raise SystemExit("NATTEN runtime is not paired with the hermetic Torch AArch64 wheel")


def verify_installed_distribution_versions() -> dict[str, str]:
    try:
        actual_versions = {
            name: importlib.metadata.version(name)
            for name in EXPECTED_DISTRIBUTIONS
        }
    except importlib.metadata.PackageNotFoundError as error:
        missing = error.name or "unknown"
        raise SystemExit(
            f"native release runtime is missing required distribution: {missing}"
        ) from error
    if actual_versions != EXPECTED_VERSIONS:
        raise SystemExit(
            "native release runtime version mismatch: "
            + json.dumps({"actual": actual_versions, "expected": EXPECTED_VERSIONS}, sort_keys=True)
        )
    return actual_versions


def verify_ltx25_cli_contract() -> None:
    result = subprocess.run(
        [sys.executable, "-I", "-m", "ltx_pipelines.distilled", "--help"],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit("LTX distilled CLI help smoke failed")
    if "[--skip-stage-2]" not in result.stdout:
        raise SystemExit("installed ltx-pipelines is missing the LTX 2.5 single-stage CLI contract")
    if "[--spatial-upsampler-path SPATIAL_UPSAMPLER_PATH]" not in result.stdout:
        raise SystemExit("installed ltx-pipelines still requires the stage-2 upsampler for single-stage runs")


def verify_cusparselt_metadata() -> None:
    distribution = importlib.metadata.distribution("nvidia-cusparselt-cu13")
    if distribution.version != EXPECTED_CUSPARSELT_VERSION:
        raise SystemExit("unexpected nvidia-cusparselt-cu13 version")
    files = distribution.files or ()
    wheel_relative = next((entry for entry in files if str(entry).endswith(".dist-info/WHEEL")), None)
    record_relative = next((entry for entry in files if str(entry).endswith(".dist-info/RECORD")), None)
    if wheel_relative is None or record_relative is None:
        raise SystemExit("cuSPARSELt wheel metadata is incomplete")
    wheel_content = Path(distribution.locate_file(wheel_relative)).read_bytes()
    if wheel_content.decode().count(EXPECTED_CUSPARSELT_TAG) != 1:
        raise SystemExit("cuSPARSELt wheel does not carry the normalized AArch64 tag")
    digest = base64.urlsafe_b64encode(hashlib.sha256(wheel_content).digest()).rstrip(b"=").decode()
    expected_record = (f"sha256={digest}", str(len(wheel_content)))
    with Path(distribution.locate_file(record_relative)).open(newline="") as handle:
        rows = [row for row in csv.reader(handle) if row and row[0] == str(wheel_relative)]
    if len(rows) != 1 or tuple(rows[0][1:]) != expected_record:
        raise SystemExit("cuSPARSELt normalized WHEEL hash is not bound in RECORD")


def verify_torch_cudnn_metadata() -> None:
    distribution = importlib.metadata.distribution("torch")
    files = distribution.files or ()
    metadata_relative = next((entry for entry in files if str(entry).endswith(".dist-info/METADATA")), None)
    record_relative = next((entry for entry in files if str(entry).endswith(".dist-info/RECORD")), None)
    if metadata_relative is None or record_relative is None:
        raise SystemExit("Torch wheel metadata is incomplete")
    metadata_content = Path(distribution.locate_file(metadata_relative)).read_bytes()
    if metadata_content.decode().count(EXPECTED_TORCH_CUDNN_REQUIREMENT) != 1:
        raise SystemExit("Torch does not carry the normalized cuDNN requirement")
    digest = base64.urlsafe_b64encode(hashlib.sha256(metadata_content).digest()).rstrip(b"=").decode()
    expected_record = (f"sha256={digest}", str(len(metadata_content)))
    with Path(distribution.locate_file(record_relative)).open(newline="") as handle:
        rows = [row for row in csv.reader(handle) if row and row[0] == str(metadata_relative)]
    if len(rows) != 1 or tuple(rows[0][1:]) != expected_record:
        raise SystemExit("Torch normalized METADATA hash is not bound in RECORD")


def main() -> None:
    verify_diffvae_lock_contract()
    verify_cusparselt_metadata()
    verify_torch_cudnn_metadata()
    verify_ltx25_cli_contract()
    for variable in ("HF_HUB_OFFLINE", "PYTHONNOUSERSITE", "TRANSFORMERS_OFFLINE"):
        if os.environ.get(variable) != "1":
            raise SystemExit(f"{variable}=1 is required in the native release runtime")
    if sys.flags.no_user_site != 1 or sys.flags.isolated != 1:
        raise SystemExit("native release runtime must run with isolated Python and no user site")

    actual_versions = verify_installed_distribution_versions()
    try:
        importlib.metadata.version("chardet")
    except importlib.metadata.PackageNotFoundError:
        pass
    else:
        raise SystemExit("chardet must not be installed in the native release runtime")

    with warnings.catch_warnings():
        warnings.simplefilter("error")
        import requests  # noqa: F401, PLC0415

    import cv2  # noqa: F401, PLC0415
    import torch  # noqa: PLC0415
    from torchvision.transforms.v2 import functional as torchvision_functional  # noqa: F401, PLC0415
    from transformers import Gemma4UnifiedProcessor  # noqa: F401, PLC0415
    import whisper  # noqa: F401, PLC0415

    import ltx_core  # noqa: F401, PLC0415
    import ltx_pipelines  # noqa: F401, PLC0415
    from ltx_pipelines.utils.cooperative_checkpoint import (  # noqa: PLC0415
        BOUNDARY_DECISION_SCHEMA,
        BOUNDARY_READY_SCHEMA,
    )

    if torch.tensor([1.0], device="cpu").add(1).item() != 2:
        raise SystemExit("torch CPU smoke failed")
    if not BOUNDARY_READY_SCHEMA.endswith(".v1") or not BOUNDARY_DECISION_SCHEMA.endswith(".v1"):
        raise SystemExit("cooperative boundary schema smoke failed")

    print(json.dumps({  # noqa: T201
        "python": sys.version.split()[0],
        "packages": actual_versions,
        "torch_cuda": torch.version.cuda,
        "verdict": "ok",
    }, sort_keys=True))


if __name__ == "__main__":
    main()
