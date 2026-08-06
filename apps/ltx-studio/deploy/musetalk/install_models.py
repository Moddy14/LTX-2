#!/usr/bin/env python3
"""Install the exact public MuseTalk 1.5 runtime artifacts and record provenance."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

from huggingface_hub import hf_hub_download


HUB_FILES = [
    (
        "TMElyralab/MuseTalk",
        "3ef28bc5cff08c90ad8178a25f1b570cd800170f",
        "musetalkV15/musetalk.json",
        "5b6923aee04d71692e0e9846c471e0a4ea07a4f686d39545e472bd4ba17e1b47",
        "creativeml-openrail-m",
    ),
    (
        "TMElyralab/MuseTalk",
        "3ef28bc5cff08c90ad8178a25f1b570cd800170f",
        "musetalkV15/unet.pth",
        "7ebf6c98c181e20838e4c0054e96e944ac60d5d692cc01db42839fe11b787007",
        "creativeml-openrail-m",
    ),
    (
        "stabilityai/sd-vae-ft-mse",
        "31f26fdeee1355a5c34592e401dd41e45d25a493",
        "config.json",
        "92d3dfb746fca211a2c9e019e285f8597412211728dce3c5bcf4eda0f2d62e7e",
        "mit",
    ),
    (
        "stabilityai/sd-vae-ft-mse",
        "31f26fdeee1355a5c34592e401dd41e45d25a493",
        "diffusion_pytorch_model.bin",
        "1b4889b6b1d4ce7ae320a02dedaeff1780ad77d415ea0d744b476155c6377ddc",
        "mit",
    ),
    (
        "openai/whisper-tiny",
        "169d4a4341b33bc18d8881c4b69c2e104e1cc0af",
        "config.json",
        "ffdccec4f3211f4c63310f2b7098f309fe70f3952cedc5e4d11e43f5b2379b98",
        "apache-2.0",
    ),
    (
        "openai/whisper-tiny",
        "169d4a4341b33bc18d8881c4b69c2e104e1cc0af",
        "preprocessor_config.json",
        "9b5cd03a36fbb8a627c64d98a5b5b126ead95a77720723944487311f0110b666",
        "apache-2.0",
    ),
    (
        "openai/whisper-tiny",
        "169d4a4341b33bc18d8881c4b69c2e104e1cc0af",
        "pytorch_model.bin",
        "9607f98a2b22d9e229ae43c52ecea79dcede9e0c5cfae67e8da6eda86d8aac1d",
        "apache-2.0",
    ),
]
FACE_PARSER_GDRIVE_ID = "154JgKpzCPW82qINcVieuPH3fZ2e0P812"
FACE_PARSER_URL = (
    "https://drive.usercontent.google.com/download"
    f"?id={FACE_PARSER_GDRIVE_ID}&export=download&confirm=t"
)
RESNET_URL = "https://download.pytorch.org/models/resnet18-5c106cde.pth"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_hash(path: Path, expected: str | None) -> str:
    if not path.is_file() or path.stat().st_size <= 0:
        raise RuntimeError(f"Downloaded model file is missing or empty: {path}")
    actual = sha256_file(path)
    if expected is not None and actual != expected:
        raise RuntimeError(f"SHA-256 mismatch for {path}: {actual} != {expected}")
    return actual


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/home/moddy/models/musetalk-1.5")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    artifacts: list[dict[str, object]] = []

    target_prefixes = {
        "TMElyralab/MuseTalk": root,
        "stabilityai/sd-vae-ft-mse": root / "sd-vae",
        "openai/whisper-tiny": root / "whisper",
    }
    for repository, revision, filename, expected, license_name in HUB_FILES:
        destination = Path(hf_hub_download(
            repo_id=repository,
            revision=revision,
            filename=filename,
            local_dir=target_prefixes[repository],
            force_download=args.force,
        ))
        artifacts.append({
            "source": f"https://huggingface.co/{repository}",
            "repository": repository,
            "revision": revision,
            "filename": filename,
            "path": str(destination.resolve()),
            "size_bytes": destination.stat().st_size,
            "sha256": require_hash(destination, expected),
            "license": license_name,
        })

    parser_root = root / "face-parse-bisent"
    parser_root.mkdir(parents=True, exist_ok=True)
    face_parser = parser_root / "79999_iter.pth"
    if args.force or not face_parser.is_file():
        temporary = face_parser.with_suffix(".tmp")
        urllib.request.urlretrieve(FACE_PARSER_URL, temporary)
        temporary.replace(face_parser)
    artifacts.append({
        "source": FACE_PARSER_URL,
        "revision": "official-musetalk-download-script",
        "filename": face_parser.name,
        "path": str(face_parser),
        "size_bytes": face_parser.stat().st_size,
        "sha256": require_hash(
            face_parser,
            "468e13ca13a9b43cc0881a9f99083a430e9c0a38abd935431d1c28ee94b26567",
        ),
        "license": "upstream-not-declared",
    })

    resnet = parser_root / "resnet18-5c106cde.pth"
    if args.force or not resnet.is_file():
        temporary = resnet.with_suffix(".tmp")
        urllib.request.urlretrieve(RESNET_URL, temporary)
        temporary.replace(resnet)
    artifacts.append({
        "source": RESNET_URL,
        "revision": "torchvision-resnet18-5c106cde",
        "filename": resnet.name,
        "path": str(resnet),
        "size_bytes": resnet.stat().st_size,
        "sha256": require_hash(
            resnet,
            "5c106cde386e87d4033832f2996f5493238eda96ccf559d1d62760c4de0613f8",
        ),
        "license": "bsd-3-clause",
    })

    manifest = {
        "schema_version": "ltx-studio-musetalk-models.v1",
        "artifacts": artifacts,
    }
    manifest_path = root / "ltx-studio-model-manifest.json"
    manifest_path.write_text(f"{json.dumps(manifest, indent=2, sort_keys=True)}\n", encoding="utf8")
    print(manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
