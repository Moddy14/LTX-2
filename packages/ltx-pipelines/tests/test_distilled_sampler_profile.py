import argparse
import inspect

import pytest
import torch

from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep, EulerDiffusionStep
from ltx_core.components.noisers import GaussianNoiser
from ltx_pipelines.distilled import (
    ANCESTRAL_NOISE_SEED_OFFSET,
    DistilledPipeline,
    _distilled_stage_1_sampler_kwargs,
    _distilled_stage_1_schedule,
    _distilled_stage_2_sampler_kwargs,
    _distilled_stage_2_schedule,
    add_distilled_sampler_profile_arg,
)
from ltx_pipelines.utils.constants import (
    DISTILLED_SIGMAS,
    OFFICIAL_COMFY_STAGE_2_SEED,
    OFFICIAL_COMFY_STAGE_2_SIGMAS,
)
from ltx_pipelines.utils.samplers import euler_ancestral_denoising_loop, euler_denoising_loop

CPU = torch.device("cpu")


def _noiser(seed: int) -> GaussianNoiser:
    return GaussianNoiser(generator=torch.Generator(device=CPU).manual_seed(seed))


def test_official_comfy_stage_one_pins_plain_rf_ancestral_user_seed_and_dtype_boundary() -> None:
    kwargs = _distilled_stage_1_sampler_kwargs(
        profile="official-comfy",
        use_native_ancestral_sampler=False,
        seed=12255,
        model_input_dtype=torch.bfloat16,
    )

    stepper = kwargs["stepper"]
    assert kwargs["state_dtype"] is torch.float32
    assert isinstance(stepper, EulerAncestralDiffusionStep)
    assert stepper.eta == 1.0
    assert stepper.s_noise == 1.0
    loop = kwargs["loop"]
    assert loop.func is euler_ancestral_denoising_loop
    assert loop.keywords == {
        "noise_seed": 12255,
        "model_dtype": torch.float32,
        "model_input_dtype": torch.bfloat16,
    }


def test_native_ltx25_stage_one_preserves_historical_seed_and_bf16_state() -> None:
    kwargs = _distilled_stage_1_sampler_kwargs(
        profile="native",
        use_native_ancestral_sampler=True,
        seed=12255,
        model_input_dtype=torch.bfloat16,
    )

    assert isinstance(kwargs["stepper"], EulerAncestralDiffusionStep)
    loop = kwargs["loop"]
    assert loop.func is euler_ancestral_denoising_loop
    assert loop.keywords == {
        "noise_seed": 12255 + ANCESTRAL_NOISE_SEED_OFFSET,
        "model_dtype": torch.bfloat16,
    }


def test_native_pre_ltx25_stage_one_keeps_diffusion_stage_defaults() -> None:
    assert (
        _distilled_stage_1_sampler_kwargs(
            profile="native",
            use_native_ancestral_sampler=False,
            seed=12255,
            model_input_dtype=torch.bfloat16,
        )
        == {}
    )


def test_official_comfy_pins_both_published_schedules_and_stage_two_seed() -> None:
    requested_stage_1 = torch.tensor([1.0, 0.5, 0.0])
    requested_stage_2 = torch.tensor([0.9, 0.4, 0.0])
    stage_1_noiser = _noiser(12255)

    stage_1 = _distilled_stage_1_schedule(profile="official-comfy", requested=requested_stage_1)
    stage_2, stage_2_noiser = _distilled_stage_2_schedule(
        profile="official-comfy",
        requested=requested_stage_2,
        noiser=stage_1_noiser,
        device=CPU,
    )

    assert stage_1 is DISTILLED_SIGMAS
    assert stage_2 is OFFICIAL_COMFY_STAGE_2_SIGMAS
    assert torch.equal(
        stage_2,
        torch.tensor([0.85, 0.725, 0.4219, 0.0], dtype=torch.float32),
    )
    assert not torch.equal(
        stage_2,
        torch.tensor([0.85, 0.725, 0.421875, 0.0], dtype=torch.float32),
    )
    assert stage_2_noiser is not stage_1_noiser
    assert stage_2_noiser.generator.initial_seed() == OFFICIAL_COMFY_STAGE_2_SEED

    sampler_kwargs = _distilled_stage_2_sampler_kwargs(profile="official-comfy")
    assert sampler_kwargs["state_dtype"] is torch.float32
    assert isinstance(sampler_kwargs["stepper"], EulerDiffusionStep)
    loop = sampler_kwargs["loop"]
    assert loop.func is euler_denoising_loop
    assert loop.keywords == {
        "model_dtype": torch.float32,
        "model_input_dtype": torch.bfloat16,
    }


def test_native_profile_preserves_caller_schedules_and_shared_noiser() -> None:
    requested_stage_1 = torch.tensor([1.0, 0.5, 0.0])
    requested_stage_2 = torch.tensor([0.9, 0.4, 0.0])
    stage_1_noiser = _noiser(12255)

    stage_1 = _distilled_stage_1_schedule(profile="native", requested=requested_stage_1)
    stage_2, stage_2_noiser = _distilled_stage_2_schedule(
        profile="native",
        requested=requested_stage_2,
        noiser=stage_1_noiser,
        device=CPU,
    )

    assert stage_1 is requested_stage_1
    assert stage_2 is requested_stage_2
    assert stage_2_noiser is stage_1_noiser
    assert _distilled_stage_2_sampler_kwargs(profile="native") == {}


def test_cli_sampler_profile_defaults_to_native_and_selects_official_comfy() -> None:
    parser = add_distilled_sampler_profile_arg(argparse.ArgumentParser())

    assert parser.parse_args([]).sampler_profile == "native"
    assert parser.parse_args(["--sampler-profile", "official-comfy"]).sampler_profile == "official-comfy"
    with pytest.raises(SystemExit):
        parser.parse_args(["--sampler-profile", "unknown"])


def test_programmatic_sampler_profile_default_remains_native() -> None:
    parameter = inspect.signature(DistilledPipeline.__init__).parameters["sampler_profile"]

    assert parameter.default == "native"
