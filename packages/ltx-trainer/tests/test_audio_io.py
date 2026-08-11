from __future__ import annotations

import math
from pathlib import Path

import pytest
import torch

from ltx_trainer.video_utils import load_audio, save_audio


def test_pcm_audio_round_trip_without_torchcodec(tmp_path: Path) -> None:
    sample_rate = 16_000
    time = torch.arange(800, dtype=torch.float32) / sample_rate
    waveform = torch.stack(
        (
            0.5 * torch.sin(2 * math.pi * 440 * time),
            0.25 * torch.sin(2 * math.pi * 660 * time),
        )
    )
    path = tmp_path / "round-trip.wav"

    save_audio(waveform, path, sample_rate)
    decoded = load_audio(path)

    assert decoded is not None
    actual, actual_rate = decoded
    assert actual_rate == sample_rate
    assert actual.shape == waveform.shape
    assert torch.allclose(actual, waveform, atol=1 / 32767)


def test_audio_loader_trims_and_rejects_invalid_duration(tmp_path: Path) -> None:
    path = tmp_path / "mono.wav"
    save_audio(torch.linspace(-1, 1, 1600), path, 16_000)

    decoded = load_audio(path, max_duration=0.025)

    assert decoded is not None
    waveform, sample_rate = decoded
    assert sample_rate == 16_000
    assert waveform.shape == (1, 400)
    with pytest.raises(ValueError, match="finite positive"):
        load_audio(path, max_duration=0)
