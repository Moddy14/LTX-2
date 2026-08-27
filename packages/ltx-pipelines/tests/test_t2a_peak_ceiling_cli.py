import argparse
import sys

import pytest
import torch

from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep, EulerCfgPpDiffusionStep
from ltx_pipelines import t2a_one_stage
from ltx_pipelines.t2a_one_stage import (
    _official_comfy_t2a_stage_kwargs,
    _parse_audio_peak_ceiling_dbfs,
    _resolve_official_comfy_t2a_sampler,
)
from ltx_pipelines.utils.model_paths import ModelPaths
from ltx_pipelines.utils.samplers import euler_ancestral_denoising_loop, euler_cfg_pp_denoising_loop


def test_official_ltx25_t2a_sampler_contract_is_plain_euler_ancestral() -> None:
    stage_kwargs = _official_comfy_t2a_stage_kwargs(
        seed=42,
        sampler="euler-ancestral",
    )

    assert isinstance(stage_kwargs["stepper"], EulerAncestralDiffusionStep)
    assert stage_kwargs["state_dtype"] is torch.float32
    loop = stage_kwargs["loop"]
    assert loop.func is euler_ancestral_denoising_loop
    assert loop.keywords == {
        "noise_seed": 42,
        "model_dtype": torch.float32,
        "model_input_dtype": torch.bfloat16,
    }


def test_official_ltx23_t2a_sampler_contract_remains_ancestral_cfg_pp() -> None:
    stage_kwargs = _official_comfy_t2a_stage_kwargs(
        seed=17,
        sampler="euler-ancestral-cfg-pp",
    )

    assert isinstance(stage_kwargs["stepper"], EulerCfgPpDiffusionStep)
    loop = stage_kwargs["loop"]
    assert loop.func is euler_cfg_pp_denoising_loop
    assert loop.keywords == {"noise_seed": 17}


def test_official_t2a_sampler_rejects_unknown_profile() -> None:
    with pytest.raises(ValueError, match="Unsupported official T2A sampler"):
        _official_comfy_t2a_stage_kwargs(seed=1, sampler="unknown")


def test_omitted_official_sampler_follows_model_generation_layout() -> None:
    split = ModelPaths.from_split(transformer_path="transformer.safetensors")
    monolith = ModelPaths.from_monolith("ltx-2.3.safetensors", "gemma")

    assert (
        _resolve_official_comfy_t2a_sampler(
            official_comfy_workflow=True,
            requested_sampler=None,
            model_paths=split,
        )
        == "euler-ancestral"
    )
    assert (
        _resolve_official_comfy_t2a_sampler(
            official_comfy_workflow=True,
            requested_sampler=None,
            model_paths=monolith,
        )
        == "euler-ancestral-cfg-pp"
    )


def test_explicit_official_sampler_requires_the_official_workflow_flag() -> None:
    split = ModelPaths.from_split(transformer_path="transformer.safetensors")

    with pytest.raises(SystemExit, match="requires --official-comfy-workflow"):
        _resolve_official_comfy_t2a_sampler(
            official_comfy_workflow=False,
            requested_sampler="euler-ancestral",
            model_paths=split,
        )


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("-60", -60.0),
        ("-3", -3.0),
        ("0", 0.0),
    ],
)
def test_peak_ceiling_cli_accepts_finite_supported_values(raw: str, expected: float) -> None:
    assert _parse_audio_peak_ceiling_dbfs(raw) == expected


@pytest.mark.parametrize("raw", ["not-a-number", "nan", "inf", "-inf", "-60.1", "0.1"])
def test_peak_ceiling_cli_rejects_invalid_values_before_pipeline_construction(raw: str) -> None:
    with pytest.raises(argparse.ArgumentTypeError, match="finite number between -60 and 0 dBFS"):
        _parse_audio_peak_ceiling_dbfs(raw)


def test_main_rejects_invalid_peak_ceiling_before_pipeline_construction(monkeypatch: pytest.MonkeyPatch) -> None:
    parser = argparse.ArgumentParser()

    def resolve_params() -> object:
        return object()

    def build_parser(*, params: object) -> argparse.ArgumentParser:
        del params
        return parser

    monkeypatch.setattr(t2a_one_stage, "resolve_cli_params", resolve_params)
    monkeypatch.setattr(t2a_one_stage, "default_1_stage_t2a_arg_parser", build_parser)

    class PipelineMustNotBeConstructed:
        def __init__(self, **_kwargs: object) -> None:
            raise AssertionError("invalid CLI input reached GPU pipeline construction")

    monkeypatch.setattr(t2a_one_stage, "T2AOneStagePipeline", PipelineMustNotBeConstructed)
    monkeypatch.setattr(sys, "argv", ["t2a-one-stage", "--audio-peak-ceiling-dbfs", "nan"])

    with pytest.raises(SystemExit) as error:
        t2a_one_stage.main()

    assert error.value.code == 2
