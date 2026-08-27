import pytest
import torch

from ltx_pipelines.distilled import distilled_single_stage_keyframes, distilled_stage_1_resolution


def test_single_stage_samples_directly_at_output_resolution() -> None:
    assert distilled_stage_1_resolution(height=704, width=1280, skip_stage_2=True) == (1280, 704)


def test_two_stage_samples_at_half_output_resolution() -> None:
    assert distilled_stage_1_resolution(height=704, width=1280, skip_stage_2=False) == (640, 352)


def test_single_stage_accepts_32_grid_while_two_stage_requires_64_grid() -> None:
    assert distilled_stage_1_resolution(height=544, width=960, skip_stage_2=True) == (960, 544)
    with pytest.raises(ValueError, match="not divisible by 64"):
        distilled_stage_1_resolution(height=544, width=960, skip_stage_2=False)


def test_single_stage_exposes_generated_keyframes_on_the_final_canvas() -> None:
    latents = torch.arange(12, dtype=torch.float32).reshape(1, 2, 3, 1, 2)

    keyframes = distilled_single_stage_keyframes(latents, [8, 16, 24], 25)

    assert keyframes is not None
    assert keyframes.pixel_frame_indices.tolist() == [8, 16, 24]
    assert torch.equal(keyframes.latents, latents)


def test_single_stage_returns_no_keyframes_when_none_were_requested() -> None:
    assert distilled_single_stage_keyframes(None, 0, 25) is None
