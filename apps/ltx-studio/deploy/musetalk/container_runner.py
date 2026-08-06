#!/usr/bin/env python3
"""Strict offline wrapper around the pinned official MuseTalk 1.5 inference."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import random
import shutil
import subprocess
import sys

import numpy as np
import torch


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--work-root", default="/work")
    parser.add_argument("--extra-margin", type=int, default=10)
    parser.add_argument("--cheek-width", type=int, default=90)
    parser.add_argument("--audio-padding-left", type=int, default=2)
    parser.add_argument("--audio-padding-right", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--seed", type=int, default=1247)
    args = parser.parse_args()

    video = Path(args.video).resolve()
    audio = Path(args.audio).resolve()
    output = Path(args.output).resolve()
    work_root = Path(args.work_root).resolve()
    for label, path in (("video", video), ("audio", audio)):
        if not path.is_file() or path.stat().st_size <= 0:
            raise RuntimeError(f"MuseTalk input {label} is missing: {path}")
    output.parent.mkdir(parents=True, exist_ok=True)
    work_root.mkdir(parents=True, exist_ok=True)

    random.seed(args.seed)
    np.random.seed(args.seed % (2**32))
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)

    results_root = work_root / "results"
    shutil.rmtree(results_root, ignore_errors=True)
    expected = results_root / "v15" / "raw.mp4"
    task_path = work_root / "task.json"
    task_path.write_text(
        json.dumps({
            "studio": {
                "video_path": str(video),
                "audio_path": str(audio),
                "result_name": "raw.mp4",
            },
        }),
        encoding="utf8",
    )

    command = [
        sys.executable,
        "scripts/inference.py",
        "--version", "v15",
        "--use_float16",
        "--inference_config", str(task_path),
        "--result_dir", str(results_root),
        "--unet_config", "/models/musetalk/musetalkV15/musetalk.json",
        "--unet_model_path", "/models/musetalk/musetalkV15/unet.pth",
        "--whisper_dir", "/models/musetalk/whisper",
        "--vae_type", "sd-vae",
        "--extra_margin", str(args.extra_margin),
        "--left_cheek_width", str(args.cheek_width),
        "--right_cheek_width", str(args.cheek_width),
        "--audio_padding_length_left", str(args.audio_padding_left),
        "--audio_padding_length_right", str(args.audio_padding_right),
        "--batch_size", str(args.batch_size),
    ]
    print("MuseTalk 1.5 official inference starts.", flush=True)
    result = subprocess.run(command, cwd="/workspace/MuseTalk", env=os.environ.copy())
    if result.returncode != 0:
        raise RuntimeError(f"MuseTalk inference exited with code {result.returncode}.")
    if not expected.is_file() or expected.stat().st_size <= 0:
        raise RuntimeError("MuseTalk reported completion but produced no playable output.")
    output.unlink(missing_ok=True)
    shutil.copyfile(expected, output)
    print(f"MuseTalk raw output ready: {output}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"MuseTalk error: {error}", flush=True)
        raise SystemExit(1)
