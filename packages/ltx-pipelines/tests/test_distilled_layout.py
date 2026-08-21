import pytest

from ltx_pipelines.distilled import distilled_stage_1_resolution


def test_single_stage_samples_directly_at_output_resolution() -> None:
    assert distilled_stage_1_resolution(height=704, width=1280, skip_stage_2=True) == (1280, 704)


def test_two_stage_samples_at_half_output_resolution() -> None:
    assert distilled_stage_1_resolution(height=704, width=1280, skip_stage_2=False) == (640, 352)


def test_single_stage_accepts_32_grid_while_two_stage_requires_64_grid() -> None:
    assert distilled_stage_1_resolution(height=544, width=960, skip_stage_2=True) == (960, 544)
    with pytest.raises(ValueError, match="not divisible by 64"):
        distilled_stage_1_resolution(height=544, width=960, skip_stage_2=False)
