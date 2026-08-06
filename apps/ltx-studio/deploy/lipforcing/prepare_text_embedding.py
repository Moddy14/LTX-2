#!/usr/bin/env python3
"""Create the fixed LipForcing prompt embedding on CPU with verified weights."""

from __future__ import annotations

import argparse
import gc
import hashlib
import json
import os
from pathlib import Path
import tempfile

import torch


TEXT_ENCODER_SHA256 = "7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d"
PROMPT = "a person talking"
LIPFORCING_COMMIT = "fc864771eb347ca3ccaaef9c0b583ff6ccc9f184"
WAN_REVISION = "a064a6c71f5be440641209c07bf2a5ce7a2ff5e4"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--text-encoder", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--provenance", required=True)
    args = parser.parse_args()

    text_encoder_path = Path(args.text_encoder).resolve()
    output = Path(args.output).resolve()
    provenance = Path(args.provenance).resolve()
    if sha256_file(text_encoder_path) != TEXT_ENCODER_SHA256:
        raise RuntimeError("UMT5-XXL text encoder SHA-256 mismatch.")

    from OmniAvatar.models.wan_video_text_encoder import WanTextEncoder
    from OmniAvatar.prompters.wan_prompter import WanPrompter
    from lipforcing import preprocess as pp

    print(f"Encoding fixed LipForcing prompt on CPU: {PROMPT!r}", flush=True)
    encoder = WanTextEncoder()
    state = torch.load(text_encoder_path, map_location="cpu", weights_only=True)
    converter = WanTextEncoder.state_dict_converter()
    encoder.load_state_dict(converter.from_civitai(state), strict=True)
    encoder = encoder.to("cpu").eval()
    tokenizer_path = pp._resolve_tokenizer_path(str(text_encoder_path))
    prompter = WanPrompter(tokenizer_path=tokenizer_path, text_len=512)
    prompter.fetch_models(text_encoder=encoder)
    with torch.no_grad():
        embedding = prompter.encode_prompt(PROMPT, positive=True, device="cpu")
    if embedding.dim() == 2:
        embedding = embedding.unsqueeze(0)
    embedding = embedding.to(dtype=torch.bfloat16).contiguous().cpu()
    if tuple(embedding.shape) != (1, 512, 4096):
        raise RuntimeError(f"Unexpected text embedding shape: {tuple(embedding.shape)}")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".tmp", delete=False) as temporary:
        temporary_path = Path(temporary.name)
    try:
        torch.save({"context": embedding}, temporary_path)
        loaded = torch.load(temporary_path, map_location="cpu", weights_only=True)
        if tuple(loaded["context"].shape) != (1, 512, 4096):
            raise RuntimeError("Text embedding round-trip verification failed.")
        os.replace(temporary_path, output)
    finally:
        temporary_path.unlink(missing_ok=True)

    del embedding, encoder, prompter, state
    gc.collect()
    artifact_sha256 = sha256_file(output)
    payload = {
        "schema_version": "ltx-studio-lipforcing-text-embedding.v1",
        "prompt": PROMPT,
        "shape": [1, 512, 4096],
        "dtype": "bfloat16",
        "lipforcing_commit": LIPFORCING_COMMIT,
        "wan_revision": WAN_REVISION,
        "source_text_encoder_sha256": TEXT_ENCODER_SHA256,
        "artifact": {
            "path": output.name,
            "size_bytes": output.stat().st_size,
            "sha256": artifact_sha256,
        },
    }
    provenance.write_text(f"{json.dumps(payload, indent=2, sort_keys=True)}\n", encoding="utf8")
    print(json.dumps(payload, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
