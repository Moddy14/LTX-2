#!/usr/bin/env python3
"""Run pinned LipForcing 14B inside an existing LTX DGX queue allocation."""

from __future__ import annotations

import argparse
from fractions import Fraction
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import uuid


LIPFORCING_COMMIT = "fc864771eb347ca3ccaaef9c0b583ff6ccc9f184"
MODEL_SHA256 = "ea9f111f374a208a80b6604e2c698639f03ad666bb7cda72c727a93cd43e4307"
VAE_SHA256 = "38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981"
WAV2VEC_MODEL_SHA256 = "8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a"
WAV2VEC_CONFIG_SHA256 = "d3ec255c063d9f95057b553b19c20135b259875834a4fe9deb218a6be25b4cf3"
WAV2VEC_PREPROCESSOR_SHA256 = "b225d617c025463b9e157e06afea8b90dc7078fc70b013c533328423e0486b4a"
WAV2VEC_FEATURE_EXTRACTOR_SHA256 = "d3de0c797bf9b65f90bc65c30cb7b303ebeda341f6fc80af33628c4b26b95632"
TAEHV_SHA256 = "d26151e76cdc2c9424bef988de874b33d9a53f30ef3060cd556c429c469c797e"
MASK_SHA256 = "aa233251b9ff5691a1565a4108f0910ab1e5e7ad79a7bb2b741ab4d92c81053c"
INSIGHTFACE_DETECTOR_SHA256 = "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91"
INSIGHTFACE_LANDMARK_SHA256 = "f001b856447c413801ef5c42091ed0cd516fcd21f2d6b79635b1e733a7109dbf"


def log(message: str) -> None:
    print(f"LipForcing: {message}", flush=True)


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
    if expected_sha256 is not None and sha256_file(resolved) != expected_sha256:
        raise RuntimeError(f"{label} hat eine unerwartete SHA-256-Prüfsumme: {resolved}")
    return resolved


def verify_text_embedding(model_root: Path) -> None:
    provenance_path = require_file(
        model_root / "text-embedding-provenance.json",
        "LipForcing-Text-Embedding-Provenienz",
    )
    provenance = json.loads(provenance_path.read_text(encoding="utf8"))
    if (
        provenance.get("schema_version") != "ltx-studio-lipforcing-text-embedding.v1"
        or provenance.get("prompt") != "a person talking"
        or provenance.get("lipforcing_commit") != LIPFORCING_COMMIT
    ):
        raise RuntimeError("LipForcing-Text-Embedding-Provenienz ist nicht freigegeben.")
    artifact = provenance.get("artifact")
    if not isinstance(artifact, dict):
        raise RuntimeError("LipForcing-Text-Embedding-Artefakt fehlt in der Provenienz.")
    embedding = require_file(model_root / "text_emb.pt", "LipForcing-Text-Embedding")
    if (
        embedding.stat().st_size != int(artifact.get("size_bytes", 0))
        or sha256_file(embedding) != artifact.get("sha256")
    ):
        raise RuntimeError("LipForcing-Text-Embedding stimmt nicht mit seiner Provenienz überein.")


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
    if result.stdout.strip() != LIPFORCING_COMMIT:
        raise RuntimeError(
            f"LipForcing-Container {image} ist nicht auf Revision {LIPFORCING_COMMIT} gebaut."
        )


def video_duration_seconds(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate,r_frame_rate,nb_frames,duration",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    streams = json.loads(result.stdout).get("streams", [])
    if len(streams) != 1:
        raise RuntimeError(f"LipForcing-Eingabevideo hat keine eindeutige Videospur: {path}")
    stream = streams[0]
    raw_rate = stream.get("avg_frame_rate")
    if not raw_rate or raw_rate == "0/0":
        raw_rate = stream.get("r_frame_rate")
    raw_count = stream.get("nb_frames")
    if raw_rate and raw_rate != "0/0" and raw_count and raw_count != "N/A":
        duration = float(Fraction(int(raw_count), 1) / Fraction(str(raw_rate)))
    else:
        duration = float(stream.get("duration") or 0)
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError(f"LipForcing-Eingabevideo hat keine belastbare Dauer: {path}")
    return duration


def prepare_source_video(source: Path, output: Path) -> Path:
    """Convert the source cadence to LipForcing's fixed 25 fps training domain."""
    source = require_file(source, "LipForcing-Eingabevideo")
    source_duration = video_duration_seconds(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source), "-map", "0:v:0", "-an",
        "-vf", "fps=fps=25:round=near",
        "-c:v", "libx264", "-preset", "medium", "-crf", "8",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
    ], check=True)
    normalized = require_file(output, "LipForcing-25-fps-CFR-Eingabe")
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate,r_frame_rate,nb_frames,duration",
            "-of", "json", str(normalized),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    stream = (json.loads(result.stdout).get("streams") or [{}])[0]
    raw_rate = stream.get("avg_frame_rate") or stream.get("r_frame_rate")
    if not raw_rate or Fraction(str(raw_rate)) != 25:
        raise RuntimeError("LipForcing-Eingabe konnte nicht auf exakt 25 fps CFR normalisiert werden.")
    frame_count = int(stream.get("nb_frames") or 0)
    normalized_duration = frame_count / 25 if frame_count > 0 else float(stream.get("duration") or 0)
    if abs(normalized_duration - source_duration) > (1 / 25) + 1e-6:
        raise RuntimeError("LipForcing-25-fps-Eingabe hat die Quellzeitachse verändert.")
    log(
        f"Quellvideo für die trainierte 25-fps-CFR-Domäne normalisiert "
        f"({frame_count} Frames, {normalized_duration:.3f} s)."
    )
    return normalized


def prepare_driving_audio(
    source_audio: Path,
    source_video: Path,
    output: Path,
    start_seconds: float,
    max_duration_seconds: float | None,
) -> Path:
    if not math.isfinite(start_seconds) or start_seconds < 0:
        raise RuntimeError("LipForcing-Audiostart muss eine endliche, nichtnegative Zahl sein.")
    if (
        max_duration_seconds is not None
        and (not math.isfinite(max_duration_seconds) or max_duration_seconds <= 0)
    ):
        raise RuntimeError("LipForcing-Audiodauer muss eine endliche, positive Zahl sein.")
    source_audio = require_file(source_audio, "LipForcing-Führungsaudio")
    target_duration = video_duration_seconds(source_video)
    trim = f"atrim=start={start_seconds:.9f}"
    if max_duration_seconds is not None:
        trim += f":duration={max_duration_seconds:.9f}"
    audio_filter = (
        f"{trim},asetpts=PTS-STARTPTS,apad,"
        f"atrim=duration={target_duration:.9f},asetpts=PTS-STARTPTS"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source_audio), "-map", "0:a:0", "-vn",
        "-af", audio_filter,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output),
    ], check=True)
    return require_file(output, "vorbereitete LipForcing-Führungsaudiospur")


def prepare_control_audio(
    program_audio: Path,
    output: Path,
    target_duration_seconds: float,
    mouth_delay_ms: int,
) -> Path:
    """Shift only model conditioning while leaving the audible program track intact."""
    if not isinstance(mouth_delay_ms, int) or isinstance(mouth_delay_ms, bool):
        raise RuntimeError("LipForcing-Lippenverzögerung muss eine ganze Millisekundenzahl sein.")
    if mouth_delay_ms < -500 or mouth_delay_ms > 500:
        raise RuntimeError("LipForcing-Lippenverzögerung muss zwischen -500 und 500 ms liegen.")
    program_audio = require_file(program_audio, "LipForcing-Programmaudio")
    if mouth_delay_ms == 0:
        return program_audio
    if mouth_delay_ms > 0:
        shift_filter = f"adelay={mouth_delay_ms}:all=1"
    else:
        shift_filter = f"atrim=start={abs(mouth_delay_ms) / 1000:.9f},asetpts=PTS-STARTPTS"
    audio_filter = (
        f"{shift_filter},apad,atrim=duration={target_duration_seconds:.9f},"
        "asetpts=PTS-STARTPTS"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.unlink(missing_ok=True)
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(program_audio), "-map", "0:a:0", "-vn",
        "-af", audio_filter,
        "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output),
    ], check=True)
    return require_file(output, "zeitkorrigierte LipForcing-Modellführung")


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
    parser.add_argument("--image", default="ltx-studio-lipforcing:14b-cu131")
    parser.add_argument("--container-name")
    parser.add_argument("--decoder", choices=["wan-vae", "streaming-taehv"], default="wan-vae")
    parser.add_argument("--mouth-delay-ms", type=int, default=0)
    parser.add_argument("--program-audio-delay-ms", type=int, default=0)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if args.program_audio_delay_ms < -500 or args.program_audio_delay_ms > 500:
        raise RuntimeError("LipForcing-Tonversatz muss zwischen -500 und 500 ms liegen.")

    video = require_file(Path(args.video), "LipForcing-Eingabevideo")
    output = Path(args.output).resolve()
    stage_root = Path(args.stage_root).resolve()
    model_root = Path(args.model_root).resolve()
    insightface_root = Path(args.insightface_root).resolve()
    stage_root.mkdir(parents=True, exist_ok=True)
    output.parent.mkdir(parents=True, exist_ok=True)

    require_file(model_root / "lipforcing_14b.pth", "LipForcing-14B-Modell", MODEL_SHA256)
    require_file(model_root / "Wan2.1_VAE.pth", "LipForcing-Wan-VAE", VAE_SHA256)
    require_file(
        model_root / "wav2vec2-base-960h" / "model.safetensors",
        "LipForcing-wav2vec2",
        WAV2VEC_MODEL_SHA256,
    )
    require_file(
        model_root / "wav2vec2-base-960h" / "config.json",
        "LipForcing-wav2vec2-Konfiguration",
        WAV2VEC_CONFIG_SHA256,
    )
    require_file(
        model_root / "wav2vec2-base-960h" / "preprocessor_config.json",
        "LipForcing-wav2vec2-Vorverarbeitung",
        WAV2VEC_PREPROCESSOR_SHA256,
    )
    require_file(
        model_root / "wav2vec2-base-960h" / "feature_extractor_config.json",
        "LipForcing-wav2vec2-Merkmalsextraktion",
        WAV2VEC_FEATURE_EXTRACTOR_SHA256,
    )
    require_file(model_root / "mask.png", "LipForcing-Mundmaske", MASK_SHA256)
    if args.decoder == "streaming-taehv":
        require_file(model_root / "taew2_1.pth", "LipForcing-TAEHV", TAEHV_SHA256)
    verify_text_embedding(model_root)
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

    program_audio = prepare_driving_audio(
        Path(args.audio).resolve() if args.audio else video,
        video,
        stage_root / "lipforcing-program-audio.wav",
        args.audio_start if args.audio else 0,
        args.audio_duration if args.audio else None,
    )
    control_audio = prepare_control_audio(
        program_audio,
        stage_root / "lipforcing-control-audio.wav",
        video_duration_seconds(video),
        args.mouth_delay_ms,
    )
    if args.mouth_delay_ms:
        log(
            f"Modellführung um {args.mouth_delay_ms:+d} ms verschoben; "
            "die hörbare Sprachspur bleibt unverändert."
        )
    normalized_video = prepare_source_video(
        video,
        stage_root / "lipforcing-source-25fps.mp4",
    )

    raw_name = args.container_name or f"ltx-lipforcing-{os.environ.get('DGX_JOB_ID', uuid.uuid4().hex[:12])}"
    container_name = re.sub(r"[^a-zA-Z0-9_.-]", "-", raw_name)[:120]
    work_root = stage_root / "lipforcing-work"
    work_root.mkdir(parents=True, exist_ok=True)
    raw_output = output.with_name(f".{output.name}.lipforcing-raw-{uuid.uuid4().hex}.mp4")
    final_output = output.with_name(f".{output.name}.lipforcing-final-{uuid.uuid4().hex}.mp4")
    raw_output.unlink(missing_ok=True)
    final_output.unlink(missing_ok=True)
    timeline_script = Path(__file__).resolve().parent.parent / "deploy" / "lipforcing" / "timeline.py"
    container_runner = require_file(
        Path(__file__).resolve().parent.parent / "deploy" / "lipforcing" / "container_runner.py",
        "LipForcing-Container-Runner",
    )

    command = [
        "docker", "run", "--rm", "--gpus", "all", "--ipc", "host", "--network", "none",
        "--name", container_name,
        "--label", "dgx.runtime=ltx2_native",
        "--label", f"dgx.job={os.environ.get('DGX_JOB_ID', 'unknown')}",
        "--label", "dgx.source_app=ltx-studio",
        "-e", "HF_HUB_OFFLINE=1",
        "-e", "TRANSFORMERS_OFFLINE=1",
        "-e", "TOKENIZERS_PARALLELISM=false",
        "-e", "NO_ALBUMENTATIONS_UPDATE=1",
        "-e", "HOME=/work",
        "-e", "LIPFORCING_INSIGHTFACE_ROOT=/models/insightface",
        "--user", f"{os.getuid()}:{os.getgid()}",
        "-v", f"{normalized_video}:/input/video.mp4:ro",
        "-v", f"{control_audio}:/input/audio.wav:ro",
        "-v", f"{raw_output.parent}:/output",
        "-v", f"{work_root}:/work",
        "-v", f"{model_root}:/models/lipforcing:ro",
        "-v", f"{insightface_root}:/models/insightface:ro",
        "-v", f"{container_runner}:/opt/ltx-studio/lipforcing-runner.py:ro",
        args.image,
        "--video", "/input/video.mp4",
        "--audio", "/input/audio.wav",
        "--output", f"/output/{raw_output.name}",
        "--model-root", "/models/lipforcing",
        "--decoder", args.decoder,
        "--seed", str(args.seed),
    ]

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
            if line.rstrip():
                print(line.rstrip(), flush=True)
        code = child.wait()
        if code != 0:
            raise RuntimeError(f"LipForcing-Container endete mit Code {code}.")
        require_file(raw_output, "LipForcing-Rohausgabe")
        timeline_command = [
            sys.executable, str(timeline_script),
            "--refined", str(raw_output),
            "--source", str(video),
            "--output", str(final_output),
        ]
        if args.audio:
            timeline_command.extend(["--audio", str(program_audio)])
        elif args.program_audio_delay_ms:
            timeline_command.extend(["--audio", str(program_audio)])
        timeline_command.extend([
            "--program-audio-delay-ms", str(args.program_audio_delay_ms),
        ])
        subprocess.run(timeline_command, check=True)
        if args.program_audio_delay_ms:
            log(
                f"hörbare Sprachspur im Endmix um {args.program_audio_delay_ms:+d} ms verschoben."
            )
        require_file(final_output, "LipForcing-Ausgabe mit LTX-Zeitachse")
        final_output.replace(output)
        log(f"verfeinertes Video fertig: {output}")
        return 0
    finally:
        for signum, handler in old_handlers.items():
            signal.signal(signum, handler)
        raw_output.unlink(missing_ok=True)
        final_output.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        log(f"Fehler: {error}")
        raise SystemExit(1)
