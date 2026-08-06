import torch

from ltx_pipelines.iclora_utils import repeat_static_reference_video
from ltx_pipelines.utils.args import ImageConditioningInput
from ltx_pipelines.utils.helpers import cap_image_conditioning_strength


def test_official_stage_one_caps_image_strength_without_mutating_input() -> None:
    images = [
        ImageConditioningInput("/input/strong.png", 0, 1.0, 33),
        ImageConditioningInput("/input/weak.png", 8, 0.4, 12),
    ]

    stage_one = cap_image_conditioning_strength(images, 0.7)

    assert [image.strength for image in stage_one] == [0.7, 0.4]
    assert [image.strength for image in images] == [1.0, 0.4]
    assert [(image.path, image.frame_idx, image.crf) for image in stage_one] == [
        ("/input/strong.png", 0, 33),
        ("/input/weak.png", 8, 12),
    ]


def test_ingredients_repeats_static_reference_across_every_output_frame() -> None:
    frame = torch.arange(12, dtype=torch.float32).reshape(1, 3, 1, 2, 2)

    repeated = repeat_static_reference_video(frame, 121)

    assert repeated.shape == (1, 3, 121, 2, 2)
    assert torch.equal(repeated[:, :, 0], frame[:, :, 0])
    assert torch.equal(repeated[:, :, -1], frame[:, :, 0])


def test_ingredients_does_not_repeat_an_existing_video() -> None:
    video = torch.zeros((1, 3, 9, 2, 2))

    assert repeat_static_reference_video(video, 121) is video
