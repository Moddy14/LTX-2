import torch

from ltx_pipelines.utils.helpers import conform_latent_length


def test_conform_latent_length_preserves_exact_length() -> None:
    latent = torch.ones((1, 2, 3, 4))

    result = conform_latent_length(latent, 3)

    assert result is latent


def test_conform_latent_length_truncates_extra_frames() -> None:
    latent = torch.arange(24).reshape(1, 2, 3, 4)

    result = conform_latent_length(latent, 2)

    assert result.shape == (1, 2, 2, 4)
    assert torch.equal(result, latent[:, :, :2])


def test_conform_latent_length_zero_pads_missing_frames() -> None:
    latent = torch.ones((1, 2, 2, 4), dtype=torch.bfloat16)

    result = conform_latent_length(latent, 4)

    assert result.shape == (1, 2, 4, 4)
    assert result.dtype == latent.dtype
    assert result.device == latent.device
    assert torch.equal(result[:, :, :2], latent)
    assert torch.count_nonzero(result[:, :, 2:]) == 0
