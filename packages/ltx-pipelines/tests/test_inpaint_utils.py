import pytest
import torch

from ltx_pipelines.utils.inpaint import (
    dilate_video_mask,
    green_screen_inpaint,
    laplacian_pyramid_blend,
    resize_video,
)


def test_green_screen_inpaint_uses_official_training_color() -> None:
    video = torch.full((1, 3, 2, 4, 4), -1.0, dtype=torch.float32)
    mask = torch.zeros((1, 1, 2, 4, 4), dtype=torch.float32)
    mask[..., 1:3, 1:3] = 1

    result = green_screen_inpaint(video, mask)

    masked_rgb = (result[0, :, 0, 1, 1] + 1) / 2
    assert torch.allclose(masked_rgb, torch.tensor([102 / 255, 1.0, 0.0]))
    assert torch.equal(result[0, :, 0, 0, 0], torch.full((3,), -1.0))


def test_dilate_video_mask_expands_only_spatially() -> None:
    mask = torch.zeros((1, 1, 2, 7, 7), dtype=torch.float32)
    mask[0, 0, 0, 3, 3] = 1

    result = dilate_video_mask(mask, spatial_radius=1)

    assert result[0, 0, 0].sum().item() == 9
    assert result[0, 0, 1].sum().item() == 0


def test_resize_video_preserves_batch_channels_and_frames() -> None:
    video = torch.rand((2, 3, 5, 8, 12), dtype=torch.float32)

    result = resize_video(video, height=4, width=6)

    assert result.shape == (2, 3, 5, 4, 6)


@pytest.mark.parametrize("mask_value, expected_source", [(1.0, "generated"), (0.0, "preserved")])
def test_laplacian_pyramid_blend_respects_constant_masks(
    mask_value: float,
    expected_source: str,
) -> None:
    generated = torch.rand((3, 3, 32, 48), dtype=torch.float32)
    preserved = torch.rand((3, 3, 32, 48), dtype=torch.float32)
    mask = torch.full((3, 1, 32, 48), mask_value, dtype=torch.float32)

    result = laplacian_pyramid_blend(
        generated,
        preserved,
        mask,
        mask_low_res_dilation=0,
    )

    expected = generated if expected_source == "generated" else preserved
    assert torch.allclose(result, expected, atol=2e-5)
