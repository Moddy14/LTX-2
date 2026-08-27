#!/usr/bin/env python3
"""Run pinned MuseTalk 1.5 inside an existing LTX DGX queue allocation."""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid

from refiner_audio import prepare_driving_audio


MUSETALK_COMMIT = "0a89dec45a0192b824e3cf4daf96c239440c5ed8"
UNET_CONFIG_SHA256 = "5b6923aee04d71692e0e9846c471e0a4ea07a4f686d39545e472bd4ba17e1b47"
UNET_SHA256 = "7ebf6c98c181e20838e4c0054e96e944ac60d5d692cc01db42839fe11b787007"
VAE_CONFIG_SHA256 = "92d3dfb746fca211a2c9e019e285f8597412211728dce3c5bcf4eda0f2d62e7e"
VAE_SHA256 = "1b4889b6b1d4ce7ae320a02dedaeff1780ad77d415ea0d744b476155c6377ddc"
WHISPER_CONFIG_SHA256 = "ffdccec4f3211f4c63310f2b7098f309fe70f3952cedc5e4d11e43f5b2379b98"
WHISPER_PREPROCESSOR_SHA256 = "9b5cd03a36fbb8a627c64d98a5b5b126ead95a77720723944487311f0110b666"
WHISPER_SHA256 = "9607f98a2b22d9e229ae43c52ecea79dcede9e0c5cfae67e8da6eda86d8aac1d"
FACE_PARSER_SHA256 = "468e13ca13a9b43cc0881a9f99083a430e9c0a38abd935431d1c28ee94b26567"
FACE_PARSER_RESNET_SHA256 = "5c106cde386e87d4033832f2996f5493238eda96ccf559d1d62760c4de0613f8"
INSIGHTFACE_DETECTOR_SHA256 = "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91"
INSIGHTFACE_LANDMARK_SHA256 = "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf"


def log(message: str) -> None:
    print(f"MuseTalk: {message}", flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def require_file(path: Path, label: str, expected_sha256: str | None = None) -> Path:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise RuntimeError(f"{label} fehlt oder ist leer: {resolved}")
    if expected_sha256 is not None:
        actual = sha256_file(resolved)
        if actual != expected_sha256:
            raise RuntimeError(f"{label} hat eine unerwartete SHA-256-Prüfsumme: {resolved}")
    return resolved


def verify_image_revision(image: str) -> None:
    result = subprocess.run(
        [
            "docker", "image", "inspect",
            "--format", '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
            image,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    if result.stdout.strip() != MUSETALK_COMMIT:
        raise RuntimeError(
            f"MuseTalk-Container {image} ist nicht auf Revision {MUSETALK_COMMIT} gebaut."
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--audio")
    parser.add_argument("--audio-start", type=float, default=0)
    parser.add_argument("--audio-duration", type=float)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stage-root", required=True)
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--insightface-root", required=True)
    parser.add_argument("--image", default="ltx-studio-musetalk:1.5-cu131")
    parser.add_argument("--container-name")
    parser.add_argument("--extra-margin", type=int, default=10)
    parser.add_argument("--cheek-width", type=int, default=90)
    parser.add_argument("--audio-padding-left", type=int, default=2)
    parser.add_argument("--audio-padding-right", type=int, default=2)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--seed", type=int, default=1247)
    args = parser.parse_args()

    video = require_file(Path(args.video), "MuseTalk-Eingabevideo")
    output = Path(args.output).resolve()
    stage_root = Path(args.stage_root).resolve()
    model_root = Path(args.model_root).resolve()
    insightface_root = Path(args.insightface_root).resolve()
    stage_root.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)

    require_file(
        model_root / "musetalkV15" / "musetalk.json",
        "MuseTalk-UNet-Konfiguration",
        UNET_CONFIG_SHA256,
    )
    require_file(model_root / "musetalkV15" / "unet.pth", "MuseTalk-1.5-UNet", UNET_SHA256)
    require_file(
        model_root / "sd-vae" / "config.json",
        "MuseTalk-VAE-Konfiguration",
        VAE_CONFIG_SHA256,
    )
    require_file(
        model_root / "sd-vae" / "diffusion_pytorch_model.bin",
        "MuseTalk-VAE",
        VAE_SHA256,
    )
    require_file(
        model_root / "whisper" / "config.json",
        "MuseTalk-Whisper-Konfiguration",
        WHISPER_CONFIG_SHA256,
    )
    require_file(
        model_root / "whisper" / "preprocessor_config.json",
        "MuseTalk-Whisper-Vorverarbeitung",
        WHISPER_PREPROCESSOR_SHA256,
    )
    require_file(
        model_root / "whisper" / "pytorch_model.bin",
        "MuseTalk-Whisper-Tiny",
        WHISPER_SHA256,
    )
    require_file(
        model_root / "face-parse-bisent" / "79999_iter.pth",
        "MuseTalk-Gesichtsparser",
        FACE_PARSER_SHA256,
    )
    require_file(
        model_root / "face-parse-bisent" / "resnet18-5c106cde.pth",
        "MuseTalk-Gesichtsparser-ResNet18",
        FACE_PARSER_RESNET_SHA256,
    )
    require_file(
        insightface_root / "models" / "buffalo_l" / "det_10g.onnx",
        "InsightFace-SCRFD-Gesichtsmodell",
        INSIGHTFACE_DETECTOR_SHA256,
    )
    require_file(
        insightface_root / "models" / "buffalo_l" / "2d106det.onnx",
        "InsightFace-106-Punkt-Landmark-Modell",
        INSIGHTFACE_LANDMARK_SHA256,
    )
    verify_image_revision(args.image)

    external_audio = bool(args.audio)
    audio = stage_root / "musetalk-audio.wav"
    if external_audio:
        audio = prepare_driving_audio(
            Path(args.audio),
            video,
            audio,
            args.audio_start,
            args.audio_duration,
            "MuseTalk",
        )
    else:
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(video), "-map", "0:a:0", "-vn",
            "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(audio),
        ], check=True)
    require_file(audio, "MuseTalk-Audiospur")

    raw_name = args.container_name or f"ltx-musetalk-{os.environ.get('DGX_JOB_ID', uuid.uuid4().hex[:12])}"
    container_name = re.sub(r"[^a-zA-Z0-9_.-]", "-", raw_name)[:120]
    work_root = stage_root / "musetalk-work"
    work_root.mkdir(parents=True, exist_ok=True)
    raw_output = output.with_name(f".{output.name}.musetalk-raw-{uuid.uuid4().hex}.mp4")
    final_output = output.with_name(f".{output.name}.musetalk-final-{uuid.uuid4().hex}.mp4")
    raw_output.unlink(missing_ok=True)
    final_output.unlink(missing_ok=True)
    deploy_root = Path(__file__).resolve().parent.parent / "deploy" / "musetalk"
    timeline_script = require_file(deploy_root / "timeline.py", "MuseTalk-Zeitachsenmodul")
    container_runner = require_file(
        deploy_root / "container_runner.py",
        "MuseTalk-Container-Runner",
    )
    preprocessing = require_file(
        deploy_root / "preprocessing_insightface.py",
        "MuseTalk-InsightFace-Adapter",
    )

    command = [
        "docker", "run", "--rm", "--gpus", "all", "--ipc", "host", "--network", "none",
        "--name", container_name,
        "--label", "dgx.runtime=ltx2_native",
        "--label", f"dgx.job={os.environ.get('DGX_JOB_ID', 'unknown')}",
        "--label", "dgx.source_app=ltx-studio",
        "-e", "HF_HUB_OFFLINE=1",
        "-e", "TRANSFORMERS_OFFLINE=1",
        "-e", "NO_ALBUMENTATIONS_UPDATE=1",
        "-e", "HOME=/work",
        "-e", "MUSETALK_INSIGHTFACE_ROOT=/models/insightface",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "-v", f"{video}:/input/video.mp4:ro",
        "-v", f"{audio}:/input/audio.wav:ro",
        "-v", f"{raw_output.parent}:/output",
        "-v", f"{work_root}:/work",
        "-v", f"{model_root}:/models/musetalk:ro",
        "-v", f"{insightface_root}:/models/insightface:ro",
        "-v", f"{container_runner}:/opt/ltx-studio/musetalk-runner.py:ro",
        "-v", f"{preprocessing}:/workspace/MuseTalk/musetalk/utils/preprocessing.py:ro",
        args.image,
        "--video", "/input/video.mp4",
        "--audio", "/input/audio.wav",
        "--output", f"/output/{raw_output.name}",
        "--extra-margin", str(args.extra_margin),
        "--cheek-width", str(args.cheek_width),
        "--audio-padding-left", str(args.audio_padding_left),
        "--audio-padding-right", str(args.audio_padding_right),
        "--batch-size", str(args.batch_size),
        "--seed", str(args.seed),
    ]

    child: subprocess.Popen[str] | None = None
    try:
        log(f"Container {container_name} startet innerhalb der bestehenden LTX-Zuteilung.")
        child = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert child.stdout is not None
        for line in child.stdout:
            if line.rstrip():
                print(line.rstrip(), flush=True)
        code = child.wait()
        if code != 0:
            raise RuntimeError(f"MuseTalk-Container endete mit Code {code}.")
        require_file(raw_output, "MuseTalk-Rohausgabe")
        timeline_command = [
            sys.executable, str(timeline_script),
            "--refined", str(raw_output),
            "--source", str(video),
            "--output", str(final_output),
        ]
        if external_audio:
            timeline_command.extend(["--audio", str(audio)])
        subprocess.run(timeline_command, check=True)
        require_file(final_output, "MuseTalk-Ausgabe mit LTX-Zeitachse")
        final_output.replace(output)
        log(f"verfeinertes Video fertig: {output}")
        return 0
    finally:
        raw_output.unlink(missing_ok=True)
        final_output.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        log(f"Fehler: {error}")
        raise SystemExit(1)
