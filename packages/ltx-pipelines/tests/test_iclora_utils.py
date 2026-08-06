import pytest
import torch

from ltx_core.types import VideoLatentShape
from ltx_pipelines.iclora_utils import (
    downsample_mask_video_to_latent,
    temporal_subsample,
)


def latent_shape(*, frames: int) -> VideoLatentShape:
    return VideoLatentShape(batch=1, channels=128, frames=frames, height=2, width=3)


def test_static_attention_mask_repeats_across_all_latent_frames() -> None:
    mask = torch.full((1, 1, 1, 8, 12), 0.75)

    result = downsample_mask_video_to_latent(mask, latent_shape(frames=4))

    assert result.shape == (1, 4 * 2 * 3)
    torch.testing.assert_close(result, torch.full_like(result, 0.75))


def test_attention_mask_rejects_an_incompatible_timeline() -> None:
    mask = torch.ones((1, 1, 10, 8, 12))

    with pytest.raises(ValueError, match="positive multiple"):
        downsample_mask_video_to_latent(mask, latent_shape(frames=3))


@pytest.mark.parametrize(
    "mask, message",
    [
        (torch.ones((1, 3, 9, 8, 12)), "shape"),
        (torch.full((1, 1, 9, 8, 12), 1.1), r"\[0, 1\]"),
        (torch.full((1, 1, 9, 8, 12), float("nan")), "non-finite"),
    ],
)
def test_attention_mask_rejects_invalid_content(mask: torch.Tensor, message: str) -> None:
    with pytest.raises(ValueError, match=message):
        downsample_mask_video_to_latent(mask, latent_shape(frames=2))


def test_temporal_subsample_rejects_non_positive_scale() -> None:
    with pytest.raises(ValueError, match="positive"):
        temporal_subsample(torch.zeros((1, 3, 9, 2, 2)), 0)
