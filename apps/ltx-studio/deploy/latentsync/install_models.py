#!/usr/bin/env python3
"""Download and verify the exact local artifacts used by LTX Studio LatentSync."""

from __future__ import annotations

import argparse
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

from huggingface_hub import hf_hub_download


FILES = (
    (
        "ByteDance/LatentSync-1.6",
        "latentsync_unet.pt",
        "LatentSync-1.6/latentsync_unet.pt",
        "0a478e89eb660f82da4c35dbdde8a5adfb27f99d1b4e50edd03729e1e98316d3",
    ),
    (
        "ByteDance/LatentSync-1.6",
        "whisper/tiny.pt",
        "LatentSync-1.6/whisper/tiny.pt",
        "65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9",
    ),
    (
        "stabilityai/sd-vae-ft-mse",
        "config.json",
        "sd-vae-ft-mse/config.json",
        None,
    ),
    (
        "stabilityai/sd-vae-ft-mse",
        "diffusion_pytorch_model.safetensors",
        "sd-vae-ft-mse/diffusion_pytorch_model.safetensors",
        "a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815",
    ),
)
BUFFALO_URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
BUFFALO_ZIP_SHA256 = "80ffe37d8a5940d59a7384c201a2a38d4741f2f3c51eef46ebb28218a7b0ca2f"
BUFFALO_FILES = {
    "det_10g.onnx": "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    "2d106det.onnx": "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf",
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default="/home/moddy/models/latentsync")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)

    for repo_id, filename, relative_path, expected_sha256 in FILES:
        target = root / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        downloaded = Path(hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            local_dir=target.parent if "/" not in filename else root / relative_path.split("/")[0],
        )).resolve()
        if downloaded != target:
            target.write_bytes(downloaded.read_bytes())
        if expected_sha256:
            actual = sha256_file(target)
            if actual != expected_sha256:
                raise RuntimeError(
                    f"SHA-256 mismatch for {target}: expected {expected_sha256}, got {actual}"
                )
        print(f"verified {target}", flush=True)

    archive = urllib.request.urlopen(BUFFALO_URL, timeout=120).read()
    if hashlib.sha256(archive).hexdigest() != BUFFALO_ZIP_SHA256:
        raise RuntimeError("SHA-256 mismatch for the official InsightFace buffalo_l v0.7 archive")
    insightface_root = root / "insightface" / "models" / "buffalo_l"
    insightface_root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        for filename, expected_sha256 in BUFFALO_FILES.items():
            target = insightface_root / filename
            target.write_bytes(package.read(filename))
            actual = sha256_file(target)
            if actual != expected_sha256:
                raise RuntimeError(
                    f"SHA-256 mismatch for {target}: expected {expected_sha256}, got {actual}"
                )
            print(f"verified {target}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
