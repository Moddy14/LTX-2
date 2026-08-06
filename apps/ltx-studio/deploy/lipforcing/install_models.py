#!/usr/bin/env python3
"""Install and verify the exact public LipForcing 14B runtime artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import urllib.request

from huggingface_hub import hf_hub_download


LIPFORCING_REVISION = "49f1f15bdc0d266e6e6ef64ccaa1ee86367a8799"
WAN_REVISION = "a064a6c71f5be440641209c07bf2a5ce7a2ff5e4"
WAV2VEC_REVISION = "22aad52d435eb6dbaf354bdad9b0da84ce7d6156"
TAEHV_REVISION = "093b918971d59001a0bad6dfd6e0409b5e1752cf"
LATENTSYNC_REVISION = "a229c3948406bc2cf6eaf4873e662e70c6a04746"
LIPFORCING_CODE_COMMIT = "fc864771eb347ca3ccaaef9c0b583ff6ccc9f184"
TEXT_EMBEDDING_SCHEMA = "ltx-studio-lipforcing-text-embedding.v1"
TEXT_EMBEDDING_PROMPT = "a person talking"
TEXT_EMBEDDING_SHAPE = [1, 512, 4096]
TEXT_EMBEDDING_DTYPE = "bfloat16"
TEXT_ENCODER_SHA256 = "7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d"
MODEL_MANIFEST_SCHEMA = "ltx-studio-lipforcing-models.v1"

RUNTIME_HUB_FILES = (
    (
        "JinhyukJang/lipforcing",
        LIPFORCING_REVISION,
        "lipforcing_14b.pth",
        "lipforcing_14b.pth",
        28_588_528_943,
        "ea9f111f374a208a80b6604e2c698639f03ad666bb7cda72c727a93cd43e4307",
        "apache-2.0",
    ),
    (
        "Wan-AI/Wan2.1-T2V-14B",
        WAN_REVISION,
        "Wan2.1_VAE.pth",
        "Wan2.1_VAE.pth",
        507_609_880,
        "38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981",
        "apache-2.0",
    ),
    (
        "facebook/wav2vec2-base-960h",
        WAV2VEC_REVISION,
        "config.json",
        "wav2vec2-base-960h/config.json",
        1_596,
        "d3ec255c063d9f95057b553b19c20135b259875834a4fe9deb218a6be25b4cf3",
        "apache-2.0",
    ),
    (
        "facebook/wav2vec2-base-960h",
        WAV2VEC_REVISION,
        "preprocessor_config.json",
        "wav2vec2-base-960h/preprocessor_config.json",
        159,
        "b225d617c025463b9e157e06afea8b90dc7078fc70b013c533328423e0486b4a",
        "apache-2.0",
    ),
    (
        "facebook/wav2vec2-base-960h",
        WAV2VEC_REVISION,
        "feature_extractor_config.json",
        "wav2vec2-base-960h/feature_extractor_config.json",
        158,
        "d3de0c797bf9b65f90bc65c30cb7b303ebeda341f6fc80af33628c4b26b95632",
        "apache-2.0",
    ),
    (
        "facebook/wav2vec2-base-960h",
        WAV2VEC_REVISION,
        "model.safetensors",
        "wav2vec2-base-960h/model.safetensors",
        377_607_901,
        "8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a",
        "apache-2.0",
    ),
)

BOOTSTRAP_HUB_FILES = (
    (
        "models_t5_umt5-xxl-enc-bf16.pth",
        11_361_920_418,
        "7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d",
    ),
    (
        "google/umt5-xxl/special_tokens_map.json",
        6_623,
        "7b8a9f5040adb67b5805abdfd42c1f8d0f3d0e711f10726580eb3789cd0ad61d",
    ),
    (
        "google/umt5-xxl/spiece.model",
        4_548_313,
        "e3909a67b780650b35cf529ac782ad2b6b26e6d1f849d3fbb6a872905f452458",
    ),
    (
        "google/umt5-xxl/tokenizer.json",
        16_837_417,
        "6e197b4d3dbd71da14b4eb255f4fa91c9c1f2068b20a2de2472967ca3d22602b",
    ),
    (
        "google/umt5-xxl/tokenizer_config.json",
        61_728,
        "ed9a3a8b0faa71a70a32847e0435fe036e6e112d4df4edb7bb48a921e344dc05",
    ),
)

RAW_FILES = (
    (
        (
            "https://raw.githubusercontent.com/madebyollin/taehv/"
            f"{TAEHV_REVISION}/taew2_1.pth"
        ),
        TAEHV_REVISION,
        "taew2_1.pth",
        22_678_901,
        "d26151e76cdc2c9424bef988de874b33d9a53f30ef3060cd556c429c469c797e",
        "mit",
    ),
    (
        (
            "https://raw.githubusercontent.com/bytedance/LatentSync/"
            f"{LATENTSYNC_REVISION}/latentsync/utils/mask.png"
        ),
        LATENTSYNC_REVISION,
        "mask.png",
        1_871,
        "aa233251b9ff5691a1565a4108f0910ab1e5e7ad79a7bb2b741ab4d92c81053c",
        "apache-2.0",
    ),
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_file(path: Path, size: int, expected_sha256: str) -> str:
    if not path.is_file() or path.stat().st_size != size:
        raise RuntimeError(f"Unexpected model size for {path}: expected {size} bytes.")
    actual = sha256_file(path)
    if actual != expected_sha256:
        raise RuntimeError(f"SHA-256 mismatch for {path}: {actual} != {expected_sha256}")
    return actual


def download_to(
    repository: str,
    revision: str,
    filename: str,
    target: Path,
    force: bool,
) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    downloaded = Path(hf_hub_download(
        repo_id=repository,
        revision=revision,
        filename=filename,
        local_dir=target.parent if "/" not in filename else target.parents[len(Path(filename).parts) - 1],
        force_download=force,
    )).resolve()
    if downloaded != target.resolve():
        shutil.copyfile(downloaded, target)


def install_runtime_downloads(root: Path, force: bool) -> list[dict[str, object]]:
    artifacts: list[dict[str, object]] = []
    for repository, revision, filename, relative, size, expected, license_name in RUNTIME_HUB_FILES:
        target = root / relative
        if force or not target.is_file():
            download_to(repository, revision, filename, target, force)
        artifacts.append({
            "source": f"https://huggingface.co/{repository}",
            "repository": repository,
            "revision": revision,
            "filename": filename,
            "path": relative,
            "size_bytes": size,
            "sha256": require_file(target, size, expected),
            "license": license_name,
        })
        print(f"verified {target}", flush=True)

    for url, revision, relative, size, expected, license_name in RAW_FILES:
        target = root / relative
        if force or not target.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(f".{target.name}.download")
            urllib.request.urlretrieve(url, temporary)
            temporary.replace(target)
        artifacts.append({
            "source": url,
            "revision": revision,
            "filename": target.name,
            "path": relative,
            "size_bytes": size,
            "sha256": require_file(target, size, expected),
            "license": license_name,
        })
        print(f"verified {target}", flush=True)

    return artifacts


def install_bootstrap_downloads(root: Path, force: bool) -> None:
    bootstrap = root / "bootstrap" / "Wan2.1-T2V-14B"
    for filename, size, expected in BOOTSTRAP_HUB_FILES:
        target = bootstrap / filename
        if force or not target.is_file():
            download_to(
                "Wan-AI/Wan2.1-T2V-14B",
                WAN_REVISION,
                filename,
                target,
                force,
            )
        require_file(target, size, expected)
        print(f"verified bootstrap {target}", flush=True)


def install_downloads(root: Path, force: bool) -> list[dict[str, object]]:
    artifacts = install_runtime_downloads(root, force)
    install_bootstrap_downloads(root, force)
    return artifacts


def validate_text_embedding_provenance(
    root: Path,
    provenance_path: Path,
) -> tuple[dict[str, object], int, str]:
    try:
        provenance = json.loads(provenance_path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"LipForcing text embedding provenance is unreadable: {error}"
        ) from error
    if not isinstance(provenance, dict):
        raise RuntimeError("LipForcing text embedding provenance must be a JSON object.")

    expected_fields = {
        "schema_version": TEXT_EMBEDDING_SCHEMA,
        "prompt": TEXT_EMBEDDING_PROMPT,
        "shape": TEXT_EMBEDDING_SHAPE,
        "dtype": TEXT_EMBEDDING_DTYPE,
        "lipforcing_commit": LIPFORCING_CODE_COMMIT,
        "wan_revision": WAN_REVISION,
        "source_text_encoder_sha256": TEXT_ENCODER_SHA256,
    }
    for field, expected in expected_fields.items():
        if provenance.get(field) != expected:
            raise RuntimeError(
                f"Unexpected LipForcing text embedding provenance field {field!r}."
            )

    artifact = provenance.get("artifact")
    if not isinstance(artifact, dict):
        raise RuntimeError("LipForcing text embedding artifact metadata is missing.")
    if artifact.get("path") != "text_emb.pt":
        raise RuntimeError("LipForcing text embedding artifact path is unexpected.")
    embedding_size = artifact.get("size_bytes")
    if (
        not isinstance(embedding_size, int)
        or isinstance(embedding_size, bool)
        or embedding_size <= 0
    ):
        raise RuntimeError("LipForcing text embedding artifact size is invalid.")
    embedding_sha256 = artifact.get("sha256")
    if (
        not isinstance(embedding_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", embedding_sha256) is None
    ):
        raise RuntimeError("LipForcing text embedding artifact SHA-256 is invalid.")
    require_file(root / "text_emb.pt", embedding_size, embedding_sha256)
    return provenance, embedding_size, embedding_sha256


def remove_bootstrap(root: Path) -> None:
    bootstrap = root / "bootstrap"
    if not bootstrap.exists() and not bootstrap.is_symlink():
        return
    if bootstrap.is_symlink():
        raise RuntimeError(f"Refusing to delete symlinked bootstrap directory: {bootstrap}")
    if bootstrap.resolve().parent != root.resolve():
        raise RuntimeError(f"Refusing to delete bootstrap outside model root: {bootstrap}")
    if not bootstrap.is_dir():
        raise RuntimeError(f"Bootstrap path is not a directory: {bootstrap}")
    shutil.rmtree(bootstrap)


def finalize(root: Path, delete_bootstrap: bool) -> Path:
    provenance_path = root / "text-embedding-provenance.json"
    if not provenance_path.is_file():
        raise RuntimeError(
            "Text embedding provenance is missing. Run prepare-lipforcing-text-embedding.py first."
        )
    provenance, embedding_size, embedding_sha256 = validate_text_embedding_provenance(
        root,
        provenance_path,
    )

    # Finalization must remain idempotent after the temporary 11 GB encoder has
    # been removed. Only permanent runtime artifacts are needed here.
    artifacts = install_runtime_downloads(root, force=False)
    artifacts.append({
        "source": "locally derived from verified Wan UMT5-XXL",
        "revision": WAN_REVISION,
        "filename": "text_emb.pt",
        "path": "text_emb.pt",
        "size_bytes": embedding_size,
        "sha256": embedding_sha256,
        "license": "apache-2.0",
        "derivation": provenance,
    })
    manifest = {
        "schema_version": MODEL_MANIFEST_SCHEMA,
        "lipforcing_code_commit": LIPFORCING_CODE_COMMIT,
        "artifacts": artifacts,
    }
    manifest_path = root / "ltx-studio-model-manifest.json"
    temporary_manifest = manifest_path.with_name(f".{manifest_path.name}.tmp")
    temporary_manifest.write_text(
        f"{json.dumps(manifest, indent=2, sort_keys=True)}\n",
        encoding="utf8",
    )
    temporary_manifest.replace(manifest_path)
    if delete_bootstrap:
        remove_bootstrap(root)
    return manifest_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/home/moddy/models/lipforcing-14b")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--finalize", action="store_true")
    parser.add_argument("--delete-bootstrap", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if args.finalize:
        print(finalize(root, args.delete_bootstrap))
    else:
        install_downloads(root, args.force)
        print(root / "bootstrap" / "Wan2.1-T2V-14B" / "models_t5_umt5-xxl-enc-bf16.pth")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
