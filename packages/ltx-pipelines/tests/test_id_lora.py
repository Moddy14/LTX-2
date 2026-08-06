from __future__ import annotations

import torch

from ltx_core.types import LatentState
from ltx_pipelines.id_lora import IdentityGuidedDenoiser


def _state(tokens: int, position_dims: int, reference_tokens: int = 0) -> LatentState:
    denoise_mask = torch.ones(1, tokens, 1)
    if reference_tokens:
        denoise_mask[:, -reference_tokens:] = 0
    return LatentState(
        latent=torch.zeros(1, tokens, 4),
        denoise_mask=denoise_mask,
        positions=torch.zeros(1, position_dims, tokens, 2),
        clean_latent=torch.zeros(1, tokens, 4),
        attention_mask=torch.ones(1, tokens, tokens),
    )


class _TokenCountTransformer:
    def __init__(self) -> None:
        self.audio_token_counts: list[int] = []
        self.audio_attention_shapes: list[tuple[int, ...] | None] = []

    def __call__(self, *, video, audio, perturbations):  # noqa: ANN001, ARG002
        audio_tokens = audio.latent.shape[1]
        self.audio_token_counts.append(audio_tokens)
        self.audio_attention_shapes.append(
            tuple(audio.attention_mask.shape) if audio.attention_mask is not None else None
        )
        return (
            torch.full_like(video.latent, float(audio_tokens)),
            torch.full_like(audio.latent, float(audio_tokens)),
        )


def test_identity_guidance_compares_conditioned_and_reference_free_passes() -> None:
    transformer = _TokenCountTransformer()
    denoiser = IdentityGuidedDenoiser(
        video_context=torch.zeros(1, 1, 4),
        audio_context=torch.zeros(1, 1, 4),
        reference_tokens=2,
        scale=3,
    )

    video_result, audio_result = denoiser(
        transformer,
        _state(tokens=2, position_dims=3),
        _state(tokens=5, position_dims=1, reference_tokens=2),
        torch.tensor([1.0, 0.0]),
        0,
    )

    assert transformer.audio_token_counts == [5, 3]
    assert transformer.audio_attention_shapes == [(1, 5, 5), (1, 3, 3)]
    assert video_result is not None
    assert audio_result is not None
    assert torch.all(video_result.denoised == 11)
    assert torch.all(audio_result.denoised[:, :3] == 11)
    assert torch.all(audio_result.denoised[:, 3:] == 5)


def test_identity_guidance_window_can_skip_the_extra_pass() -> None:
    transformer = _TokenCountTransformer()
    denoiser = IdentityGuidedDenoiser(
        video_context=torch.zeros(1, 1, 4),
        audio_context=torch.zeros(1, 1, 4),
        reference_tokens=2,
        scale=3,
        start_percent=0.5,
        end_percent=1,
    )

    video_result, audio_result = denoiser(
        transformer,
        _state(tokens=2, position_dims=3),
        _state(tokens=5, position_dims=1, reference_tokens=2),
        torch.tensor([1.0, 0.5, 0.0]),
        0,
    )

    assert transformer.audio_token_counts == [5]
    assert video_result is not None
    assert audio_result is not None
    assert torch.all(video_result.denoised == 5)
    assert torch.all(audio_result.denoised == 5)


def test_identity_guidance_window_uses_official_ltx_sigma_mapping() -> None:
    transformer = _TokenCountTransformer()
    denoiser = IdentityGuidedDenoiser(
        video_context=torch.zeros(1, 1, 4),
        audio_context=torch.zeros(1, 1, 4),
        reference_tokens=2,
        scale=3,
        start_percent=0.5,
        end_percent=1,
    )
    sigmas = torch.tensor([1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0])

    denoiser(
        transformer,
        _state(tokens=2, position_dims=3),
        _state(tokens=5, position_dims=1, reference_tokens=2),
        sigmas,
        4,
    )
    denoiser(
        transformer,
        _state(tokens=2, position_dims=3),
        _state(tokens=5, position_dims=1, reference_tokens=2),
        sigmas,
        7,
    )

    assert transformer.audio_token_counts == [5, 5, 3]
