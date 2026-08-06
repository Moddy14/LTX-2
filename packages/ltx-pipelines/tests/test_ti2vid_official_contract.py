import torch

from ltx_core.components.guiders import MultiModalGuiderParams
from ltx_core.components.noisers import GaussianNoiser
from ltx_core.components.schedulers import LTX2Scheduler
from ltx_pipelines.ti2vid_two_stages import (
    _final_audio_latent,
    _stage_1_denoiser,
    _stage_1_sigmas,
    _stage_2_schedule,
)
from ltx_pipelines.utils.constants import (
    DISTILLED_SIGMAS,
    OFFICIAL_COMFY_STAGE_2_SEED,
    OFFICIAL_COMFY_STAGE_2_SIGMAS,
    STAGE_2_DISTILLED_SIGMAS,
)
from ltx_pipelines.utils.denoisers import FactoryGuidedDenoiser, SimpleDenoiser

CPU = torch.device("cpu")


def _denoiser(official: bool) -> SimpleDenoiser | FactoryGuidedDenoiser:
    context = torch.zeros((1, 2, 3))
    return _stage_1_denoiser(
        official_comfy_workflow=official,
        v_context_p=context,
        a_context_p=context,
        v_context_n=context,
        a_context_n=context,
        video_guider_params=MultiModalGuiderParams(),
        audio_guider_params=MultiModalGuiderParams(),
    )


def test_official_stage_one_uses_a_single_callable_simple_denoiser() -> None:
    denoiser = _denoiser(official=True)

    assert isinstance(denoiser, SimpleDenoiser)
    assert callable(denoiser)


def test_legacy_stage_one_keeps_factory_guided_denoising() -> None:
    denoiser = _denoiser(official=False)

    assert isinstance(denoiser, FactoryGuidedDenoiser)
    assert callable(denoiser)


def test_official_stage_one_defaults_to_the_distilled_schedule() -> None:
    sigmas = _stage_1_sigmas(
        official_comfy_workflow=True,
        requested=None,
        scheduler=LTX2Scheduler(),
        num_inference_steps=30,
    )

    assert torch.equal(sigmas, DISTILLED_SIGMAS)


def test_explicit_stage_one_sigmas_win_over_the_official_default() -> None:
    requested = torch.tensor([1.0, 0.5, 0.0])

    sigmas = _stage_1_sigmas(
        official_comfy_workflow=True,
        requested=requested,
        scheduler=LTX2Scheduler(),
        num_inference_steps=30,
    )

    assert sigmas is requested


def test_legacy_stage_one_uses_the_scheduler() -> None:
    steps = 4

    sigmas = _stage_1_sigmas(
        official_comfy_workflow=False,
        requested=None,
        scheduler=LTX2Scheduler(),
        num_inference_steps=steps,
    )

    assert torch.equal(sigmas, LTX2Scheduler().execute(steps=steps))
    assert not torch.equal(sigmas, DISTILLED_SIGMAS)


def test_official_stage_two_pins_the_published_schedule_and_seed() -> None:
    stage_1_noiser = GaussianNoiser(generator=torch.Generator(device=CPU).manual_seed(7))

    sigmas, noiser = _stage_2_schedule(
        official_comfy_workflow=True,
        requested=STAGE_2_DISTILLED_SIGMAS,
        noiser=stage_1_noiser,
        device=CPU,
    )

    assert torch.equal(sigmas, OFFICIAL_COMFY_STAGE_2_SIGMAS)
    assert noiser is not stage_1_noiser
    assert noiser.generator.initial_seed() == OFFICIAL_COMFY_STAGE_2_SEED


def test_legacy_stage_two_keeps_caller_schedule_and_noiser() -> None:
    stage_1_noiser = GaussianNoiser(generator=torch.Generator(device=CPU).manual_seed(7))
    requested = torch.tensor([0.9, 0.4, 0.0])

    sigmas, noiser = _stage_2_schedule(
        official_comfy_workflow=False,
        requested=requested,
        noiser=stage_1_noiser,
        device=CPU,
    )

    assert sigmas is requested
    assert noiser is stage_1_noiser


def test_official_audio_is_decoded_from_the_second_stage() -> None:
    stage_1 = torch.zeros((1, 4))
    stage_2 = torch.ones((1, 4))

    latent = _final_audio_latent(
        official_comfy_workflow=True,
        stage_1_audio_latent=stage_1,
        stage_2_audio_latent=stage_2,
    )

    assert latent is stage_2


def test_legacy_audio_keeps_the_first_stage_latent() -> None:
    stage_1 = torch.zeros((1, 4))
    stage_2 = torch.ones((1, 4))

    latent = _final_audio_latent(
        official_comfy_workflow=False,
        stage_1_audio_latent=stage_1,
        stage_2_audio_latent=stage_2,
    )

    assert latent is stage_1
