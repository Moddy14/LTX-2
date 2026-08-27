from pathlib import Path

import pytest
import torch

from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep, EulerCfgPpDiffusionStep
from ltx_pipelines.ic_lora import (
    _audio_noise_scale,
    _audio_stage_spec,
    _build_arg_parser,
    _official_comfy_ic_stage_kwargs,
    _pipeline_prompt_arguments,
)
from ltx_pipelines.utils.samplers import euler_ancestral_denoising_loop, euler_cfg_pp_denoising_loop


@pytest.fixture
def cli_paths(tmp_path: Path) -> dict[str, str]:
    checkpoint = tmp_path / "checkpoint.safetensors"
    checkpoint.write_bytes(b"x")
    control = tmp_path / "control.mp4"
    control.write_bytes(b"x")
    return {
        "checkpoint": str(checkpoint),
        "gemma": str(tmp_path),
        "control": str(control),
        "output": str(tmp_path / "out.mp4"),
    }


def _base_args(cli_paths: dict[str, str]) -> list[str]:
    return [
        "--gemma-root",
        cli_paths["gemma"],
        "--prompt",
        "p",
        "--output-path",
        cli_paths["output"],
        "--video-conditioning",
        cli_paths["control"],
        "1",
    ]


def test_parser_accepts_the_studio_checkpoint_alias(cli_paths: dict[str, str]) -> None:
    args = _build_arg_parser().parse_args(
        ["--checkpoint-path", cli_paths["checkpoint"], *_base_args(cli_paths)],
    )

    assert args.distilled_checkpoint_path == cli_paths["checkpoint"]


def test_parser_keeps_the_distilled_checkpoint_flag(cli_paths: dict[str, str]) -> None:
    args = _build_arg_parser().parse_args(
        ["--distilled-checkpoint-path", cli_paths["checkpoint"], *_base_args(cli_paths)],
    )

    assert args.distilled_checkpoint_path == cli_paths["checkpoint"]


def test_parser_rejects_a_missing_checkpoint(cli_paths: dict[str, str]) -> None:
    with pytest.raises(SystemExit):
        _build_arg_parser().parse_args(_base_args(cli_paths))


def test_generated_audio_starts_from_full_noise() -> None:
    assert _audio_noise_scale(None) == 1.0


def test_frozen_audio_keeps_its_latent() -> None:
    assert _audio_noise_scale(torch.zeros((1, 4))) == 0.0


def test_frozen_control_audio_remains_frozen_in_later_stages() -> None:
    context = torch.ones((1, 2))
    latent = torch.zeros((1, 4))

    spec = _audio_stage_spec(
        context=context,
        initial_latent=latent,
        freeze=True,
        generated_noise_scale=0.8,
    )

    assert spec.context is context
    assert spec.initial_latent is latent
    assert spec.frozen is True
    assert spec.noise_scale == 0.0


def test_frozen_control_audio_requires_a_bound_latent() -> None:
    with pytest.raises(ValueError, match="requires an initial latent"):
        _audio_stage_spec(
            context=torch.ones((1, 2)),
            initial_latent=None,
            freeze=True,
            generated_noise_scale=0.8,
        )


def test_cli_negative_prompt_is_forwarded_to_the_pipeline(cli_paths: dict[str, str]) -> None:
    args = _build_arg_parser().parse_args(
        [
            "--checkpoint-path",
            cli_paths["checkpoint"],
            *_base_args(cli_paths),
            "--negative-prompt",
            "deformed mouth",
        ],
    )

    assert _pipeline_prompt_arguments(args) == {
        "prompt": "p",
        "negative_prompt": "deformed mouth",
    }


def test_plain_official_ic_sampler_keeps_fp32_state_around_bf16_model() -> None:
    kwargs = _official_comfy_ic_stage_kwargs(
        sampler="euler-ancestral-rf",
        seed=42,
        model_input_dtype=torch.bfloat16,
    )

    assert kwargs["state_dtype"] is torch.float32
    assert isinstance(kwargs["stepper"], EulerAncestralDiffusionStep)
    loop = kwargs["loop"]
    assert loop.func is euler_ancestral_denoising_loop
    assert loop.keywords == {
        "noise_seed": 42,
        "model_dtype": torch.float32,
        "model_input_dtype": torch.bfloat16,
    }


@pytest.mark.parametrize(
    ("sampler", "eta"),
    [("euler-ancestral-cfg-pp", 1.0), ("euler-cfg-pp", 0.0)],
)
def test_cfgpp_official_ic_sampler_keeps_fp32_state_around_bf16_model(
    sampler: str,
    eta: float,
) -> None:
    kwargs = _official_comfy_ic_stage_kwargs(
        sampler=sampler,
        seed=17,
        model_input_dtype=torch.bfloat16,
    )

    assert kwargs["state_dtype"] is torch.float32
    stepper = kwargs["stepper"]
    assert isinstance(stepper, EulerCfgPpDiffusionStep)
    assert stepper.eta == eta
    loop = kwargs["loop"]
    assert loop.func is euler_cfg_pp_denoising_loop
    assert loop.keywords == {
        "noise_seed": 17,
        "model_dtype": torch.float32,
        "model_input_dtype": torch.bfloat16,
    }
