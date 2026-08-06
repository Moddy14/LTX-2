#!/usr/bin/env python3
"""Preserve the source-video timeline around LatentSync's required 25 fps pass."""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path


LATENTSYNC_FPS = Fraction(25, 1)


@dataclass(frozen=True)
class VideoTimeline:
    frame_rate: Fraction
    frame_count: int
    width: int
    height: int
    has_audio: bool


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def _probe_json(arguments: list[str]) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", *arguments, "-of", "json"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def _positive_fraction(value: str) -> Fraction:
    fraction = Fraction(value)
    if fraction <= 0:
        raise RuntimeError(f"Ungültige Video-Bildrate: {value}")
    return fraction


def probe_video_timeline(path: Path) -> VideoTimeline:
    resolved = path.resolve()
    payload = _probe_json([
        "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate,r_frame_rate,nb_frames,width,height",
        str(resolved),
    ])
    streams = payload.get("streams", [])
    if len(streams) != 1:
        raise RuntimeError(f"Video-Stream fehlt oder ist mehrdeutig: {resolved}")
    stream = streams[0]
    rate_value = stream.get("avg_frame_rate")
    if not rate_value or rate_value == "0/0":
        rate_value = stream.get("r_frame_rate")
    frame_rate = _positive_fraction(str(rate_value))

    raw_frame_count = stream.get("nb_frames")
    if not raw_frame_count or raw_frame_count == "N/A":
        counted = _probe_json([
            "-select_streams", "v:0",
            "-count_frames",
            "-show_entries", "stream=nb_read_frames",
            str(resolved),
        ])
        counted_streams = counted.get("streams", [])
        raw_frame_count = counted_streams[0].get("nb_read_frames") if counted_streams else None
    if not raw_frame_count or raw_frame_count == "N/A":
        raise RuntimeError(f"Exakte Video-Bildzahl ist nicht bestimmbar: {resolved}")
    frame_count = int(raw_frame_count)
    width = int(stream["width"])
    height = int(stream["height"])
    if frame_count <= 0 or width <= 0 or height <= 0:
        raise RuntimeError(f"Ungültige Video-Geometrie oder Bildzahl: {resolved}")

    audio_payload = _probe_json([
        "-select_streams", "a:0",
        "-show_entries", "stream=index",
        str(resolved),
    ])
    return VideoTimeline(
        frame_rate=frame_rate,
        frame_count=frame_count,
        width=width,
        height=height,
        has_audio=bool(audio_payload.get("streams")),
    )


def _rounded_frame_count(frame_count: int, source_rate: Fraction, target_rate: Fraction) -> int:
    exact = Fraction(frame_count) * target_rate / source_rate
    return max(1, int(exact + Fraction(1, 2)))


def _rate_filter(rate: Fraction, frame_count: int) -> str:
    rate_text = f"{rate.numerator}/{rate.denominator}"
    return (
        f"fps=fps={rate_text}:round=near,"
        f"trim=end_frame={frame_count},"
        f"setpts=N/({rate_text}*TB)"
    )


def normalize_for_latentsync(source: Path, output: Path) -> VideoTimeline:
    source_timeline = probe_video_timeline(source)
    target_frames = _rounded_frame_count(
        source_timeline.frame_count,
        source_timeline.frame_rate,
        LATENTSYNC_FPS,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source.resolve()),
        "-map", "0:v:0", "-an",
        "-vf", _rate_filter(LATENTSYNC_FPS, target_frames),
        "-frames:v", str(target_frames),
        "-c:v", "libx264", "-preset", "medium", "-crf", "8",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart",
        str(output.resolve()),
    ])
    normalized = probe_video_timeline(output)
    if normalized.frame_rate != LATENTSYNC_FPS or normalized.frame_count != target_frames:
        raise RuntimeError(
            "LatentSync-Normalisierung verletzte die berechnete 25-fps-Zeitachse: "
            f"{normalized.frame_count} Bilder @ {normalized.frame_rate} statt "
            f"{target_frames} Bilder @ {LATENTSYNC_FPS}."
        )
    return normalized


def restore_source_timeline(
    refined: Path,
    source: Path,
    output: Path,
    driving_audio: Path | None = None,
) -> VideoTimeline:
    source_timeline = probe_video_timeline(source)
    if driving_audio is None and not source_timeline.has_audio:
        raise RuntimeError("Das LTX-Basisvideo enthält keinen Originalton für die finale Ausgabe.")
    refined_timeline = probe_video_timeline(refined)
    if (refined_timeline.width, refined_timeline.height) != (
        source_timeline.width,
        source_timeline.height,
    ):
        raise RuntimeError(
            "LatentSync veränderte die Videoauflösung unerwartet: "
            f"{refined_timeline.width}x{refined_timeline.height} statt "
            f"{source_timeline.width}x{source_timeline.height}."
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(refined.resolve()),
        "-i", str(source.resolve()),
    ]
    if driving_audio is None:
        command.extend(["-map", "0:v:0", "-map", "1:a:0"])
        audio_arguments = ["-c:a", "copy"]
    else:
        resolved_audio = driving_audio.resolve()
        audio_payload = _probe_json([
            "-select_streams", "a:0",
            "-show_entries", "stream=index",
            str(resolved_audio),
        ])
        if not audio_payload.get("streams"):
            raise RuntimeError(f"LatentSync-Führungsaudio hat keine Audiospur: {resolved_audio}")
        duration_seconds = float(
            Fraction(source_timeline.frame_count, 1) / source_timeline.frame_rate
        )
        command.extend([
            "-i", str(resolved_audio),
            "-map", "0:v:0", "-map", "2:a:0",
        ])
        audio_arguments = [
            "-af",
            f"aresample=48000,apad,atrim=duration={duration_seconds:.9f},asetpts=PTS-STARTPTS",
            "-c:a", "aac", "-b:a", "192k",
        ]
    command.extend([
        "-vf", _rate_filter(source_timeline.frame_rate, source_timeline.frame_count),
        "-frames:v", str(source_timeline.frame_count),
        "-c:v", "libx264", "-preset", "medium", "-crf", "8",
        "-pix_fmt", "yuv420p",
        *audio_arguments,
        "-movflags", "+faststart",
        str(output.resolve()),
    ])
    run(command)
    restored = probe_video_timeline(output)
    if (
        restored.frame_rate != source_timeline.frame_rate
        or restored.frame_count != source_timeline.frame_count
        or (restored.width, restored.height) != (source_timeline.width, source_timeline.height)
        or not restored.has_audio
    ):
        raise RuntimeError(
            "LatentSync-Endausgabe stimmt nicht exakt mit der LTX-Basiszeitachse überein."
        )
    return restored


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    normalize_parser = subparsers.add_parser("normalize")
    normalize_parser.add_argument("--source", required=True)
    normalize_parser.add_argument("--output", required=True)

    restore_parser = subparsers.add_parser("restore")
    restore_parser.add_argument("--refined", required=True)
    restore_parser.add_argument("--source", required=True)
    restore_parser.add_argument("--audio")
    restore_parser.add_argument("--output", required=True)

    args = parser.parse_args()
    if args.command == "normalize":
        timeline = normalize_for_latentsync(Path(args.source), Path(args.output))
    else:
        timeline = restore_source_timeline(
            Path(args.refined),
            Path(args.source),
            Path(args.output),
            Path(args.audio) if args.audio else None,
        )
    print(
        json.dumps({
            "frame_rate": f"{timeline.frame_rate.numerator}/{timeline.frame_rate.denominator}",
            "frame_count": timeline.frame_count,
            "width": timeline.width,
            "height": timeline.height,
            "has_audio": timeline.has_audio,
        }),
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
