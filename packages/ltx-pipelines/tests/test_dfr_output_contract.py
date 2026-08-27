import pytest

from ltx_pipelines.dfr_layout import output_frame_rate


@pytest.mark.parametrize(
    ("source_fps", "temporal_upscalings", "expected_fps"),
    [
        (24.0, 0, 24.0),
        (23.976, 1, 47.952),
        (29.97, 2, 119.88),
    ],
)
def test_output_frame_rate_preserves_fractional_playback_rates(
    source_fps: float,
    temporal_upscalings: int,
    expected_fps: float,
) -> None:
    assert output_frame_rate(source_fps, temporal_upscalings) == pytest.approx(expected_fps)


@pytest.mark.parametrize(
    ("source_fps", "temporal_upscalings"),
    [(0.0, 0), (-1.0, 0), (24.0, -1)],
)
def test_output_frame_rate_rejects_invalid_inputs(source_fps: float, temporal_upscalings: int) -> None:
    with pytest.raises(ValueError, match="must be"):
        output_frame_rate(source_fps, temporal_upscalings)
