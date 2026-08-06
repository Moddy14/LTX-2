from __future__ import annotations

from fractions import Fraction
from pathlib import Path

import av
import torch

from ltx_core.types import Audio
from ltx_pipelines.utils.media_io import encode_video


def test_encode_video_preserves_fractional_fps_and_matches_audio_duration(tmp_path: Path) -> None:
    output = tmp_path / "timeline.mp4"
    frames = 9
    fps = 30000 / 1001
    short_audio = Audio(
        waveform=torch.zeros((2, 4_800), dtype=torch.float32),
        sampling_rate=48_000,
    )

    encode_video(
        video=torch.zeros((frames, 64, 64, 3), dtype=torch.float32),
        fps=fps,
        audio=short_audio,
        output_path=str(output),
        video_chunks_number=1,
        preset="ultrafast",
    )

    with av.open(output) as container:
        video_stream = next(stream for stream in container.streams if stream.type == "video")
        audio_stream = next(stream for stream in container.streams if stream.type == "audio")
        video_duration = float(video_stream.duration * video_stream.time_base)
        audio_duration = float(audio_stream.duration * audio_stream.time_base)
        video_rate = video_stream.average_rate

    assert video_rate == Fraction(30000, 1001)
    assert abs(video_duration - audio_duration) <= 0.001
