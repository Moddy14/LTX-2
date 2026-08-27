#!/usr/bin/env python3
"""Restore the exact LTX frame timeline and original audio after LipForcing."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from fractions import Fraction
import json
from math import ceil
import os
from pathlib import Path
import re
import stat
import subprocess


FFMPEG_EXECUTABLE = "/usr/bin/ffmpeg"
FFPROBE_EXECUTABLE = "/usr/bin/ffprobe"
FFMPEG_DESCRIPTOR: int | None = None
FFPROBE_DESCRIPTOR: int | None = None
INHERITED_INPUT_DESCRIPTORS: tuple[int, ...] = ()


def configure_paired_descriptors(
    ffmpeg_descriptor: int | None,
    ffprobe_descriptor: int | None,
    input_descriptors: list[int],
) -> None:
    global FFMPEG_DESCRIPTOR, FFPROBE_DESCRIPTOR, INHERITED_INPUT_DESCRIPTORS
    configured = (ffmpeg_descriptor is not None, ffprobe_descriptor is not None, bool(input_descriptors))
    if any(configured) and not all(configured):
        raise RuntimeError("Paired timeline descriptors must be configured together.")
    if not any(configured):
        return
    assert ffmpeg_descriptor is not None and ffprobe_descriptor is not None
    descriptors = (ffmpeg_descriptor, ffprobe_descriptor, *input_descriptors)
    if len(set(descriptors)) != len(descriptors) or any(descriptor < 3 for descriptor in descriptors):
        raise RuntimeError("Paired timeline descriptors must be unique inherited descriptors.")
    for descriptor in descriptors:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size <= 0:
            raise RuntimeError("Paired timeline descriptor is not a regular single-link file.")
    FFMPEG_DESCRIPTOR = ffmpeg_descriptor
    FFPROBE_DESCRIPTOR = ffprobe_descriptor
    INHERITED_INPUT_DESCRIPTORS = tuple(input_descriptors)


def _descriptor_arguments(executable_descriptor: int | None) -> dict[str, object]:
    if executable_descriptor is None:
        return {}
    return {
        "executable": f"/proc/self/fd/{executable_descriptor}",
        "pass_fds": (executable_descriptor, *INHERITED_INPUT_DESCRIPTORS),
    }


def _input_path(path: Path) -> str:
    raw = str(path)
    match = re.fullmatch(r"/proc/self/fd/([0-9]+)", raw)
    if match is None:
        return str(path.resolve())
    descriptor = int(match.group(1))
    if descriptor not in INHERITED_INPUT_DESCRIPTORS:
        raise RuntimeError(f"Timeline input FD is not bound by the parent: {raw}")
    return raw


@dataclass(frozen=True)
class VideoTimeline:
    frame_rate: Fraction
    frame_count: int
    width: int
    height: int
    has_audio: bool


def _probe(arguments: list[str]) -> dict:
    result = subprocess.run(
        [FFPROBE_EXECUTABLE, "-v", "error", *arguments, "-of", "json"],
        check=True,
        capture_output=True,
        **_descriptor_arguments(FFPROBE_DESCRIPTOR),
        text=True,
    )
    return json.loads(result.stdout)


def probe_video(path: Path) -> VideoTimeline:
    resolved = _input_path(path)
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
    program_audio_delay_ms: int = 0,
    *,
    overwrite: bool = True,
    command_evidence: list[list[str]] | None = None,
) -> VideoTimeline:
    if not isinstance(program_audio_delay_ms, int) or isinstance(program_audio_delay_ms, bool):
        raise RuntimeError("LipForcing program audio delay must be an integer number of milliseconds.")
    if program_audio_delay_ms < -500 or program_audio_delay_ms > 500:
        raise RuntimeError("LipForcing program audio delay must be between -500 and 500 ms.")
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
        FFMPEG_EXECUTABLE, "-hide_banner", "-loglevel", "error",
        "-y" if overwrite else "-n",
        "-i", _input_path(refined), "-i", _input_path(source),
    ]
    if driving_audio is None:
        command.extend(["-map", "0:v:0", "-map", "1:a:0"])
        audio_arguments = ["-c:a", "copy"]
    else:
        resolved_audio = _input_path(driving_audio)
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
        if program_audio_delay_ms > 0:
            timing_filter = f"adelay={program_audio_delay_ms}:all=1,"
        elif program_audio_delay_ms < 0:
            timing_filter = (
                f"atrim=start={abs(program_audio_delay_ms) / 1000:.9f},"
                "asetpts=PTS-STARTPTS,"
            )
        else:
            timing_filter = ""
        audio_arguments = [
            "-af",
            f"{timing_filter}aresample=48000,apad,"
            f"atrim=duration={duration_seconds:.9f},asetpts=PTS-STARTPTS",
            "-c:a", "aac", "-b:a", "192k",
        ]
    command.extend([
        "-vf", video_filter,
        "-frames:v", str(source_timeline.frame_count),
        "-c:v", "libx264", "-preset", "medium", "-crf", "8",
        "-pix_fmt", "yuv420p", *audio_arguments, "-movflags", "+faststart",
        str(output.resolve()),
    ])
    if command_evidence is not None:
        command_evidence.append(list(command))
    subprocess.run(command, check=True, **_descriptor_arguments(FFMPEG_DESCRIPTOR))
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
    parser.add_argument("--program-audio-delay-ms", type=int, default=0)
    parser.add_argument("--exclusive-output", action="store_true")
    parser.add_argument("--emit-command-evidence", action="store_true")
    parser.add_argument("--paired-ffmpeg-fd", type=int)
    parser.add_argument("--paired-ffprobe-fd", type=int)
    parser.add_argument("--paired-input-fd", type=int, action="append", default=[])
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    configure_paired_descriptors(
        args.paired_ffmpeg_fd,
        args.paired_ffprobe_fd,
        args.paired_input_fd,
    )
    command_evidence: list[list[str]] = []
    timeline = restore_timeline(
        Path(args.refined),
        Path(args.source),
        Path(args.output),
        Path(args.audio) if args.audio else None,
        args.program_audio_delay_ms,
        overwrite=not args.exclusive_output,
        command_evidence=command_evidence if args.emit_command_evidence else None,
    )
    payload: dict[str, object] = {
        "frame_rate": f"{timeline.frame_rate.numerator}/{timeline.frame_rate.denominator}",
        "frame_count": timeline.frame_count,
        "width": timeline.width,
        "height": timeline.height,
        "has_audio": timeline.has_audio,
    }
    if args.emit_command_evidence:
        if len(command_evidence) != 1:
            raise RuntimeError("Timeline command evidence is missing or ambiguous.")
        payload["command"] = command_evidence[0]
    print(json.dumps(payload), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
