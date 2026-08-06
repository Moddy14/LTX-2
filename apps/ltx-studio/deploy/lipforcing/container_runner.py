#!/usr/bin/env python3
"""Strict offline entry point for the pinned official LipForcing inference."""

from __future__ import annotations

import argparse
import hashlib
import json
from math import ceil
import os
from pathlib import Path
import random
import re
import subprocess
import sys

import numpy as np
import torch


OFFICIAL_FPS = 25
CHUNK_SIZE = 3
RELEASED_T_LIST = ("0.999", "0.769", "0.0")
LIPFORCING_CODE_COMMIT = "fc864771eb347ca3ccaaef9c0b583ff6ccc9f184"
WAN_REVISION = "a064a6c71f5be440641209c07bf2a5ce7a2ff5e4"
TEXT_ENCODER_SHA256 = "7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d"

PINNED_RUNTIME_ARTIFACTS = {
    "lipforcing_14b.pth": (
        28_588_528_943,
        "ea9f111f374a208a80b6604e2c698639f03ad666bb7cda72c727a93cd43e4307",
        "49f1f15bdc0d266e6e6ef64ccaa1ee86367a8799",
    ),
    "Wan2.1_VAE.pth": (
        507_609_880,
        "38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981",
        WAN_REVISION,
    ),
    "wav2vec2-base-960h/config.json": (
        1_596,
        "d3ec255c063d9f95057b553b19c20135b259875834a4fe9deb218a6be25b4cf3",
        "22aad52d435eb6dbaf354bdad9b0da84ce7d6156",
    ),
    "wav2vec2-base-960h/preprocessor_config.json": (
        159,
        "b225d617c025463b9e157e06afea8b90dc7078fc70b013c533328423e0486b4a",
        "22aad52d435eb6dbaf354bdad9b0da84ce7d6156",
    ),
    "wav2vec2-base-960h/feature_extractor_config.json": (
        158,
        "d3de0c797bf9b65f90bc65c30cb7b303ebeda341f6fc80af33628c4b26b95632",
        "22aad52d435eb6dbaf354bdad9b0da84ce7d6156",
    ),
    "wav2vec2-base-960h/model.safetensors": (
        377_607_901,
        "8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a",
        "22aad52d435eb6dbaf354bdad9b0da84ce7d6156",
    ),
    "taew2_1.pth": (
        22_678_901,
        "d26151e76cdc2c9424bef988de874b33d9a53f30ef3060cd556c429c469c797e",
        "093b918971d59001a0bad6dfd6e0409b5e1752cf",
    ),
    "mask.png": (
        1_871,
        "aa233251b9ff5691a1565a4108f0910ab1e5e7ad79a7bb2b741ab4d92c81053c",
        "a229c3948406bc2cf6eaf4873e662e70c6a04746",
    ),
}


def require_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise RuntimeError(f"{label} is missing or empty: {resolved}")
    return resolved


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_artifact(path: Path, size: int, expected_sha256: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size != size:
        raise RuntimeError(f"Unexpected model size for {resolved}: expected {size} bytes.")
    actual_sha256 = sha256_file(resolved)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f"SHA-256 mismatch for {resolved}: {actual_sha256} != {expected_sha256}"
        )
    return resolved


def load_json_object(path: Path, label: str) -> dict[str, object]:
    try:
        payload = json.loads(path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"{label} is unreadable: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError(f"{label} must be a JSON object.")
    return payload


def validate_text_embedding(
    model_root: Path,
    provenance: dict[str, object],
) -> tuple[Path, int, str]:
    expected = {
        "schema_version": "ltx-studio-lipforcing-text-embedding.v1",
        "prompt": "a person talking",
        "shape": [1, 512, 4096],
        "dtype": "bfloat16",
        "lipforcing_commit": LIPFORCING_CODE_COMMIT,
        "wan_revision": WAN_REVISION,
        "source_text_encoder_sha256": TEXT_ENCODER_SHA256,
    }
    for field, expected_value in expected.items():
        if provenance.get(field) != expected_value:
            raise RuntimeError(f"Unexpected text embedding provenance field {field!r}.")
    artifact = provenance.get("artifact")
    if not isinstance(artifact, dict) or artifact.get("path") != "text_emb.pt":
        raise RuntimeError("Text embedding provenance has invalid artifact metadata.")
    size = artifact.get("size_bytes")
    sha256 = artifact.get("sha256")
    if (
        not isinstance(size, int)
        or isinstance(size, bool)
        or size <= 0
        or not isinstance(sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", sha256) is None
    ):
        raise RuntimeError("Text embedding provenance has invalid size or SHA-256.")
    path = require_artifact(model_root / "text_emb.pt", size, sha256)
    payload = torch.load(path, map_location="cpu", weights_only=True)
    if not isinstance(payload, dict) or set(payload) != {"context"}:
        raise RuntimeError("Text embedding payload must contain only the context tensor.")
    context = payload["context"]
    if (
        not isinstance(context, torch.Tensor)
        or tuple(context.shape) != (1, 512, 4096)
        or context.dtype != torch.bfloat16
    ):
        raise RuntimeError("Text embedding tensor shape or dtype is invalid.")
    return path, size, sha256


def validate_model_manifest(model_root: Path) -> dict[str, Path]:
    manifest = load_json_object(
        require_file(
            model_root / "ltx-studio-model-manifest.json",
            "LipForcing model manifest",
        ),
        "LipForcing model manifest",
    )
    if manifest.get("schema_version") != "ltx-studio-lipforcing-models.v1":
        raise RuntimeError("Unexpected LipForcing model manifest schema.")
    if manifest.get("lipforcing_code_commit") != LIPFORCING_CODE_COMMIT:
        raise RuntimeError("LipForcing model manifest targets an unexpected code commit.")
    raw_artifacts = manifest.get("artifacts")
    if not isinstance(raw_artifacts, list):
        raise RuntimeError("LipForcing model manifest has no artifact list.")
    artifacts: dict[str, dict[str, object]] = {}
    for raw_artifact in raw_artifacts:
        if not isinstance(raw_artifact, dict):
            raise RuntimeError("LipForcing model manifest contains a non-object artifact.")
        relative = raw_artifact.get("path")
        if not isinstance(relative, str) or relative in artifacts:
            raise RuntimeError("LipForcing model manifest has an invalid or duplicate path.")
        artifacts[relative] = raw_artifact
    expected_paths = set(PINNED_RUNTIME_ARTIFACTS) | {"text_emb.pt"}
    if set(artifacts) != expected_paths:
        raise RuntimeError("LipForcing model manifest has missing or unexpected artifacts.")

    resolved: dict[str, Path] = {}
    for relative, (size, sha256, revision) in PINNED_RUNTIME_ARTIFACTS.items():
        artifact = artifacts[relative]
        if (
            artifact.get("size_bytes") != size
            or artifact.get("sha256") != sha256
            or artifact.get("revision") != revision
        ):
            raise RuntimeError(f"LipForcing manifest metadata mismatch for {relative}.")
        resolved[relative] = require_artifact(model_root / relative, size, sha256)

    provenance = load_json_object(
        require_file(
            model_root / "text-embedding-provenance.json",
            "LipForcing text embedding provenance",
        ),
        "LipForcing text embedding provenance",
    )
    text_embedding, embedding_size, embedding_sha256 = validate_text_embedding(
        model_root,
        provenance,
    )
    embedding_artifact = artifacts["text_emb.pt"]
    if (
        embedding_artifact.get("size_bytes") != embedding_size
        or embedding_artifact.get("sha256") != embedding_sha256
        or embedding_artifact.get("revision") != WAN_REVISION
        or embedding_artifact.get("derivation") != provenance
    ):
        raise RuntimeError("LipForcing text embedding manifest linkage is invalid.")
    resolved["text_emb.pt"] = text_embedding
    return resolved


def audio_duration_seconds(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "a:0",
            "-show_entries", "stream=duration:format=duration", "-of", "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(result.stdout)
    stream_duration = (payload.get("streams") or [{}])[0].get("duration")
    format_duration = (payload.get("format") or {}).get("duration")
    duration = float(stream_duration or format_duration or 0)
    if not np.isfinite(duration) or duration <= 0:
        raise RuntimeError(f"Driving audio has no usable duration: {path}")
    return duration


def covering_latent_frames(duration_seconds: float) -> int:
    # Upstream rounds down to complete AR chunks and can lose ~0.5 seconds.
    # Generate the next complete chunk instead; the host restores the exact
    # source timeline after inference.
    video_frames = max(1, ceil(duration_seconds * OFFICIAL_FPS))
    latent_frames = 1 + ceil(max(0, video_frames - 1) / 4)
    return max(CHUNK_SIZE, ceil(latent_frames / CHUNK_SIZE) * CHUNK_SIZE)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model-root", default="/models/lipforcing")
    parser.add_argument(
        "--decoder",
        choices=["wan-vae", "streaming-taehv"],
        default="wan-vae",
    )
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    video = require_file(Path(args.video), "LipForcing input video")
    audio = require_file(Path(args.audio), "LipForcing driving audio")
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    model_root = Path(args.model_root).resolve()

    verified = validate_model_manifest(model_root)
    checkpoint = verified["lipforcing_14b.pth"]
    vae = verified["Wan2.1_VAE.pth"]
    wav2vec = model_root / "wav2vec2-base-960h"
    mask = verified["mask.png"]
    text_embedding = verified["text_emb.pt"]
    taehv = verified["taew2_1.pth"]
    if args.decoder == "streaming-taehv":
        require_file(taehv, "TAEHV decoder")

    random.seed(args.seed)
    np.random.seed(args.seed % (2**32))
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)

    latent_frames = covering_latent_frames(audio_duration_seconds(audio))
    command = [
        sys.executable,
        "/workspace/LipForcing/scripts/inference/inference_streaming.py",
        "--ckpt_path", str(checkpoint),
        "--vae_path", str(vae),
        "--wav2vec_path", str(wav2vec),
        "--mask_path", str(mask),
        "--text_embeds_path", str(text_embedding),
        "--video_path", str(video),
        "--audio_path", str(audio),
        "--output_path", str(output),
        "--model_size", "14B",
        "--streaming_decoder",
        "wan_vae" if args.decoder == "wan-vae" else "streaming_taehv",
        "--num_latent_frames", str(latent_frames),
        "--chunk_size", str(CHUNK_SIZE),
        "--fps", str(OFFICIAL_FPS),
        "--dtype", "bf16",
        "--device", "cuda",
        "--seed", str(args.seed),
        "--t_list", *RELEASED_T_LIST,
        "--local_attn_size", "7",
        "--sink_size", "1",
        "--defer_composite",
    ]
    if args.decoder == "streaming-taehv":
        command.extend(["--taehv_ckpt", str(taehv)])

    print(
        f"LipForcing official 14B inference starts "
        f"({args.decoder}, {latent_frames} latent frames).",
        flush=True,
    )
    result = subprocess.run(command, cwd="/workspace/LipForcing", env=os.environ.copy())
    if result.returncode != 0:
        raise RuntimeError(f"LipForcing inference exited with code {result.returncode}.")
    require_file(output, "LipForcing raw output")
    print(f"LipForcing raw output ready: {output}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"LipForcing error: {error}", flush=True)
        raise SystemExit(1)
