from __future__ import annotations

import wave
from array import array
from fractions import Fraction
from pathlib import Path

import av
import pytest
import torch

from ltx_core.types import Audio
from ltx_pipelines.utils.media_io import encode_audio, encode_video


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


def _wav_peak(path: Path) -> int:
    with wave.open(str(path), "rb") as wav_file:
        samples = array("h", wav_file.readframes(wav_file.getnframes()))
    return max(abs(sample) for sample in samples)


def test_encode_audio_applies_peak_ceiling_before_pcm_clipping(tmp_path: Path) -> None:
    output = tmp_path / "headroom.wav"
    audio = Audio(
        waveform=torch.tensor([[0.0, 0.5, 1.5, -2.0], [0.0, -0.5, -1.5, 2.0]]),
        sampling_rate=48_000,
    )

    encode_audio(audio, str(output), peak_ceiling_dbfs=-3.0)

    expected_peak = round((10.0 ** (-3.0 / 20.0)) * 32767.0)
    assert abs(_wav_peak(output) - expected_peak) <= 1


def test_encode_audio_peak_ceiling_never_amplifies_quiet_material(tmp_path: Path) -> None:
    output = tmp_path / "quiet.wav"
    audio = Audio(
        waveform=torch.tensor([[0.0, 0.1], [0.0, -0.1]]),
        sampling_rate=48_000,
    )

    encode_audio(audio, str(output), peak_ceiling_dbfs=-3.0)

    assert abs(_wav_peak(output) - round(0.1 * 32767.0)) <= 1


@pytest.mark.parametrize("ceiling", [float("nan"), float("inf"), -61.0, 0.1])
def test_encode_audio_rejects_invalid_peak_ceiling(tmp_path: Path, ceiling: float) -> None:
    audio = Audio(waveform=torch.zeros((2, 8)), sampling_rate=48_000)

    with pytest.raises(ValueError, match="peak_ceiling_dbfs"):
        encode_audio(audio, str(tmp_path / "invalid.wav"), peak_ceiling_dbfs=ceiling)
