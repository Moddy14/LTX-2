#!/usr/bin/env python3
"""Restore the exact LTX frame timeline and original audio after LipForcing."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from fractions import Fraction
import json
from math import ceil
from pathlib import Path
import subprocess


@dataclass(frozen=True)
class VideoTimeline:
    frame_rate: Fraction
    frame_count: int
    width: int
    height: int
    has_audio: bool


def _probe(arguments: list[str]) -> dict:
    result = subprocess.run(
        ["ffprobe", "-v", "error", *arguments, "-of", "json"],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def probe_video(path: Path) -> VideoTimeline:
    resolved = path.resolve()
    payload = _probe([
        "-select_streams", "v:0",
        "-show_entries", "stream=avg_frame_rate,r_frame_rate,nb_frames,width,height",
        str(resolved),
    ])
    streams = payload.get("streams", [])
    if len(streams) != 1:
        raise RuntimeError(f"Video stream is missing or ambiguous: {resolved}")
    stream = streams[0]
    raw_rate = stream.get("avg_frame_rate")
    if not raw_rate or raw_rate == "0/0":
        raw_rate = stream.get("r_frame_rate")
    frame_rate = Fraction(str(raw_rate))
    if frame_rate <= 0:
        raise RuntimeError(f"Invalid frame rate in {resolved}: {raw_rate}")
    raw_count = stream.get("nb_frames")
    if not raw_count or raw_count == "N/A":
        counted = _probe([
            "-select_streams", "v:0", "-count_frames",
            "-show_entries", "stream=nb_read_frames", str(resolved),
        ])
        counted_streams = counted.get("streams", [])
        raw_count = counted_streams[0].get("nb_read_frames") if counted_streams else None
    if not raw_count or raw_count == "N/A":
        raise RuntimeError(f"Exact frame count is unavailable: {resolved}")
    audio = _probe([
        "-select_streams", "a:0", "-show_entries", "stream=index", str(resolved),
    ])
    return VideoTimeline(
        frame_rate=frame_rate,
        frame_count=int(raw_count),
        width=int(stream["width"]),
        height=int(stream["height"]),
        has_audio=bool(audio.get("streams")),
    )


def restore_timeline(
    refined: Path,
    source: Path,
    output: Path,
    driving_audio: Path | None = None,
) -> VideoTimeline:
    source_timeline = probe_video(source)
    refined_timeline = probe_video(refined)
    if not source_timeline.has_audio:
        raise RuntimeError("The LTX base has no original audio for LipForcing.")
    if (source_timeline.width, source_timeline.height) != (
        refined_timeline.width,
        refined_timeline.height,
    ):
        raise RuntimeError(
            "LipForcing changed the resolution: "
            f"{refined_timeline.width}x{refined_timeline.height} instead of "
            f"{source_timeline.width}x{source_timeline.height}."
        )
    rate = source_timeline.frame_rate
    rate_text = f"{rate.numerator}/{rate.denominator}"
    pad_seconds = ceil(float(Fraction(source_timeline.frame_count, 1) / rate)) + 1
    video_filter = (
        f"fps=fps={rate_text}:round=near,"
        f"tpad=stop_mode=clone:stop_duration={pad_seconds},"
        f"trim=end_frame={source_timeline.frame_count},"
        f"setpts=N/({rate_text}*TB)"
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(refined.resolve()), "-i", str(source.resolve()),
    ]
    if driving_audio is None:
        command.extend(["-map", "0:v:0", "-map", "1:a:0"])
        audio_arguments = ["-c:a", "copy"]
    else:
        resolved_audio = driving_audio.resolve()
        audio_stream = _probe([
            "-select_streams", "a:0", "-show_entries", "stream=index", str(resolved_audio),
        ])
        if not audio_stream.get("streams"):
            raise RuntimeError(f"LipForcing driving audio has no audio stream: {resolved_audio}")
        duration_seconds = float(Fraction(source_timeline.frame_count, 1) / rate)
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
        "-vf", video_filter,
        "-frames:v", str(source_timeline.frame_count),
        "-c:v", "libx264", "-preset", "medium", "-crf", "8",
        "-pix_fmt", "yuv420p", *audio_arguments, "-movflags", "+faststart",
        str(output.resolve()),
    ])
    subprocess.run(command, check=True)
    restored = probe_video(output)
    if (
        restored.frame_rate != source_timeline.frame_rate
        or restored.frame_count != source_timeline.frame_count
        or (restored.width, restored.height) != (source_timeline.width, source_timeline.height)
        or not restored.has_audio
    ):
        raise RuntimeError("LipForcing output does not match the exact LTX timeline.")
    return restored


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--refined", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--audio")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    timeline = restore_timeline(
        Path(args.refined),
        Path(args.source),
        Path(args.output),
        Path(args.audio) if args.audio else None,
    )
    print(json.dumps({
        "frame_rate": f"{timeline.frame_rate.numerator}/{timeline.frame_rate.denominator}",
        "frame_count": timeline.frame_count,
        "width": timeline.width,
        "height": timeline.height,
        "has_audio": timeline.has_audio,
    }), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
