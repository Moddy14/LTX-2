"""Prepare an exact, bounded driving-audio window for optional lip refiners."""

from __future__ import annotations

from fractions import Fraction
import json
import math
from pathlib import Path
import subprocess


def require_audio_source(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise RuntimeError(f"{label} fehlt oder ist leer: {resolved}")
    return resolved


def video_duration_seconds(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=avg_frame_rate,r_frame_rate,nb_frames,duration",
            "-of",
            "json",
            str(path.resolve()),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    streams = json.loads(result.stdout).get("streams", [])
    if len(streams) != 1:
        raise RuntimeError(f"Refiner-Eingabevideo hat keine eindeutige Videospur: {path}")
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
        raise RuntimeError(f"Refiner-Eingabevideo hat keine belastbare Dauer: {path}")
    return duration


def prepare_driving_audio(
    source_audio: Path,
    source_video: Path,
    output: Path,
    start_seconds: float,
    max_duration_seconds: float | None,
    label: str,
) -> Path:
    if not math.isfinite(start_seconds) or start_seconds < 0:
        raise RuntimeError(f"{label}-Audiostart muss eine endliche, nichtnegative Zahl sein.")
    if (
        max_duration_seconds is not None
        and (not math.isfinite(max_duration_seconds) or max_duration_seconds <= 0)
    ):
        raise RuntimeError(f"{label}-Audiodauer muss eine endliche, positive Zahl sein.")
    source = require_audio_source(source_audio, f"{label}-Führungsaudio")
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
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-map",
            "0:a:0",
            "-vn",
            "-af",
            audio_filter,
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(output),
        ],
        check=True,
    )
    return require_audio_source(output, f"vorbereitete {label}-Führungsaudiospur")
