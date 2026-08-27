import torch

from ltx_core.components.diffusion_steps import (
    EulerAncestralDiffusionStep,
    EulerCfgPpDiffusionStep,
    EulerDiffusionStep,
)
from ltx_core.types import LatentState
from ltx_pipelines.utils.samplers import (
    euler_ancestral_denoising_loop,
    euler_cfg_pp_denoising_loop,
    euler_denoising_loop,
)
from ltx_pipelines.utils.types import DenoisedLatentResult


def _state(dtype: torch.dtype) -> LatentState:
    latent = torch.tensor([0.25], dtype=dtype)
    return LatentState(
        latent=latent,
        denoise_mask=torch.ones_like(latent),
        positions=torch.zeros_like(latent),
        clean_latent=torch.zeros_like(latent),
    )


def test_fp32_sampler_state_uses_bf16_only_at_model_boundary() -> None:
    observed_model_input_dtypes: list[torch.dtype] = []
    observed_noise_input_dtypes: list[torch.dtype] = []

    def denoiser(
        _transformer: object,
        video_state: LatentState | None,
        _audio_state: LatentState | None,
        _sigmas: torch.Tensor,
        _step_index: int,
    ) -> tuple[DenoisedLatentResult | None, DenoisedLatentResult | None]:
        assert video_state is not None
        observed_model_input_dtypes.append(video_state.latent.dtype)
        return DenoisedLatentResult(video_state.latent), None

    def noise(latent: torch.Tensor, _generator: torch.Generator) -> torch.Tensor:
        observed_noise_input_dtypes.append(latent.dtype)
        return torch.zeros_like(latent)

    video_state, audio_state = euler_ancestral_denoising_loop(
        sigmas=torch.tensor([1.0, 0.5, 0.0]),
        video_state=_state(torch.bfloat16),
        audio_state=None,
        stepper=EulerAncestralDiffusionStep(),
        transformer=object(),
        denoiser=denoiser,
        noise_seed=42,
        model_dtype=torch.float32,
        model_input_dtype=torch.bfloat16,
        new_noise_fn=noise,
    )

    assert audio_state is None
    assert video_state is not None
    assert video_state.latent.dtype is torch.float32
    assert observed_model_input_dtypes == [torch.bfloat16, torch.bfloat16]
    assert observed_noise_input_dtypes == [torch.float32]


def test_deterministic_fp32_sampler_state_uses_bf16_only_at_model_boundary() -> None:
    observed_model_input_dtypes: list[torch.dtype] = []

    def denoiser(
        _transformer: object,
        video_state: LatentState | None,
        _audio_state: LatentState | None,
        _sigmas: torch.Tensor,
        _step_index: int,
    ) -> tuple[DenoisedLatentResult | None, DenoisedLatentResult | None]:
        assert video_state is not None
        observed_model_input_dtypes.append(video_state.latent.dtype)
        return DenoisedLatentResult(video_state.latent), None

    video_state, audio_state = euler_denoising_loop(
        sigmas=torch.tensor([1.0, 0.5, 0.0]),
        video_state=_state(torch.bfloat16),
        audio_state=None,
        stepper=EulerDiffusionStep(),
        transformer=object(),
        denoiser=denoiser,
        model_dtype=torch.float32,
        model_input_dtype=torch.bfloat16,
    )

    assert audio_state is None
    assert video_state is not None
    assert video_state.latent.dtype is torch.float32
    assert observed_model_input_dtypes == [torch.bfloat16, torch.bfloat16]


def test_cfgpp_fp32_sampler_state_uses_bf16_only_at_model_boundary() -> None:
    observed_model_input_dtypes: list[torch.dtype] = []

    def denoiser(
        _transformer: object,
        video_state: LatentState | None,
        _audio_state: LatentState | None,
        _sigmas: torch.Tensor,
        _step_index: int,
    ) -> tuple[DenoisedLatentResult | None, DenoisedLatentResult | None]:
        assert video_state is not None
        observed_model_input_dtypes.append(video_state.latent.dtype)
        result = DenoisedLatentResult(
            denoised=video_state.latent,
            uncond=video_state.latent,
        )
        return result, None

    video_state, audio_state = euler_cfg_pp_denoising_loop(
        sigmas=torch.tensor([1.0, 0.5, 0.0]),
        video_state=_state(torch.bfloat16),
        audio_state=None,
        stepper=EulerCfgPpDiffusionStep(eta=0.0, s_noise=0.0),
        transformer=object(),
        denoiser=denoiser,
        model_dtype=torch.float32,
        model_input_dtype=torch.bfloat16,
    )

    assert audio_state is None
    assert video_state is not None
    assert video_state.latent.dtype is torch.float32
    assert observed_model_input_dtypes == [torch.bfloat16, torch.bfloat16]
