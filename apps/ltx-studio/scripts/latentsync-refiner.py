#!/usr/bin/env python3
"""Run the pinned LatentSync container inside an existing LTX DGX allocation."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import signal
import subprocess
import sys
import uuid
from pathlib import Path

from refiner_audio import prepare_driving_audio


LATENTSYNC_COMMIT = "a229c3948406bc2cf6eaf4873e662e70c6a04746"
UNET_SHA256 = "0a478e89eb660f82da4c35dbdde8a5adfb27f99d1b4e50edd03729e1e98316d3"
WHISPER_SHA256 = "65147644a518d12f04e32d6f3b26facc3f8dd46e5390956a9424a650c0ce22b9"
VAE_SHA256 = "a1d993488569e928462932c8c38a0760b874d166399b14414135bd9c42df5815"
INSIGHTFACE_DETECTOR_SHA256 = "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91"
INSIGHTFACE_LANDMARK_SHA256 = "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf"


def log(message: str) -> None:
    print(f"LatentSync: {message}", flush=True)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(path: Path, expected: str, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise RuntimeError(f"{label} fehlt oder ist leer: {resolved}")
    actual = sha256_file(resolved)
    if actual != expected:
        raise RuntimeError(f"{label} hat eine unerwartete SHA-256-Prüfsumme: {resolved}")
    return resolved


def require_code_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise RuntimeError(f"{label} fehlt oder ist leer: {resolved}")
    return resolved


def verify_image_revision(image: str) -> None:
    result = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--entrypoint",
            "git",
            image,
            "-C",
            "/workspace/LatentSync",
            "rev-parse",
            "HEAD",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    if result.stdout.strip() != LATENTSYNC_COMMIT:
        raise RuntimeError(
            f"LatentSync-Container {image} enthält nicht Revision {LATENTSYNC_COMMIT}."
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--audio")
    parser.add_argument("--audio-start", type=float, default=0)
    parser.add_argument("--audio-duration", type=float)
    parser.add_argument("--output", required=True)
    parser.add_argument("--stage-root", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--whisper", required=True)
    parser.add_argument("--vae-root", required=True)
    parser.add_argument("--insightface-root", required=True)
    parser.add_argument("--image", default="ltx-studio-latentsync:1.6-cu131")
    parser.add_argument("--container-name")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--guidance", type=float, default=2.0)
    parser.add_argument("--seed", type=int, default=1247)
    args = parser.parse_args()

    video = Path(args.video).resolve()
    output = Path(args.output).resolve()
    stage_root = Path(args.stage_root).resolve()
    if not video.is_file():
        raise RuntimeError(f"Eingabevideo fehlt: {video}")
    stage_root.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)

    checkpoint = verify(Path(args.checkpoint), UNET_SHA256, "LatentSync-1.6-Checkpoint")
    whisper = verify(Path(args.whisper), WHISPER_SHA256, "LatentSync-Whisper-Tiny")
    insightface_root = Path(args.insightface_root).resolve()
    verify(
        insightface_root / "models" / "buffalo_l" / "det_10g.onnx",
        INSIGHTFACE_DETECTOR_SHA256,
        "InsightFace-SCRFD-Gesichtsmodell",
    )
    verify(
        insightface_root / "models" / "buffalo_l" / "2d106det.onnx",
        INSIGHTFACE_LANDMARK_SHA256,
        "InsightFace-106-Punkt-Landmark-Modell",
    )
    vae_root = Path(args.vae_root).resolve()
    verify(vae_root / "diffusion_pytorch_model.safetensors", VAE_SHA256, "Stable-Diffusion-VAE")
    if not (vae_root / "config.json").is_file():
        raise RuntimeError(f"VAE-Konfiguration fehlt: {vae_root / 'config.json'}")

    external_audio = bool(args.audio)
    audio = stage_root / "latentsync-audio.wav"
    if external_audio:
        audio = prepare_driving_audio(
            Path(args.audio),
            video,
            audio,
            args.audio_start,
            args.audio_duration,
            "LatentSync",
        )
    else:
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(video),
                "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
                str(audio),
            ],
            check=True,
        )
    if not audio.is_file() or audio.stat().st_size <= 0:
        raise RuntimeError(f"LatentSync benötigt eine verwertbare Tonspur: {audio}")

    raw_name = args.container_name or f"ltx-latentsync-{os.environ.get('DGX_JOB_ID', uuid.uuid4().hex[:12])}"
    container_name = re.sub(r"[^a-zA-Z0-9_.-]", "-", raw_name)[:120]
    work_root = stage_root / "latentsync-work"
    work_root.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_name(f".{output.name}.latentsync-{uuid.uuid4().hex}.tmp.mp4")
    temporary_output.unlink(missing_ok=True)
    deploy_root = Path(__file__).resolve().parent.parent / "deploy" / "latentsync"
    runner = require_code_file(deploy_root / "runner.py", "LatentSync-Runner")
    timeline = require_code_file(deploy_root / "timeline.py", "LatentSync-Zeitachsenmodul")
    face_detector = require_code_file(
        deploy_root / "face_detector_insightface.py",
        "LatentSync-InsightFace-Adapter",
    )
    verify_image_revision(args.image)

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
        "-e", "LATENTSYNC_INSIGHTFACE_ROOT=/models/insightface",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "-v", f"{video}:/input/video.mp4:ro",
        "-v", f"{audio}:/input/audio.wav:ro",
        "-v", f"{temporary_output.parent}:/output",
        "-v", f"{work_root}:/work",
        "-v", f"{checkpoint}:/models/checkpoints/latentsync_unet.pt:ro",
        "-v", f"{whisper}:/models/checkpoints/whisper/tiny.pt:ro",
        "-v", f"{vae_root}:/models/vae:ro",
        "-v", f"{insightface_root}:/models/insightface:ro",
        "-v", f"{runner}:/opt/ltx-studio/latentsync-runner.py:ro",
        "-v", f"{timeline}:/opt/ltx-studio/timeline.py:ro",
        "-v", f"{face_detector}:/workspace/LatentSync/latentsync/utils/face_detector.py:ro",
        args.image,
        "--video", "/input/video.mp4",
        "--audio", "/input/audio.wav",
        "--output", f"/output/{temporary_output.name}",
        "--steps", str(args.steps),
        "--guidance", str(args.guidance),
        "--seed", str(args.seed),
    ]
    if external_audio:
        command.append("--use-driving-audio")

    child: subprocess.Popen[str] | None = None

    def stop_owned_container(_signum: int, _frame: object) -> None:
        if child is not None and child.poll() is None:
            subprocess.run(
                ["docker", "stop", "--time", "20", container_name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
                timeout=40,
            )

    old_handlers = {
        signum: signal.signal(signum, stop_owned_container)
        for signum in (signal.SIGTERM, signal.SIGINT)
    }
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
            stripped = line.rstrip()
            if stripped:
                print(stripped, flush=True)
        code = child.wait()
        if code != 0:
            raise RuntimeError(f"LatentSync-Container endete mit Code {code}.")
        if not temporary_output.is_file() or temporary_output.stat().st_size <= 0:
            raise RuntimeError("LatentSync erzeugte keine gültige Ausgabedatei.")
        temporary_output.replace(output)
        log(f"verfeinertes Video fertig: {output}")
        return 0
    finally:
        for signum, handler in old_handlers.items():
            signal.signal(signum, handler)
        if temporary_output.exists():
            temporary_output.unlink()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        log(f"Fehler: {error}")
        raise SystemExit(1)
