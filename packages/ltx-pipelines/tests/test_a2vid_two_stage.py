import torch

from ltx_core.components.guiders import MultiModalGuiderParams
from ltx_pipelines.a2vid_two_stage import _stage_1_denoiser
from ltx_pipelines.utils.args import default_2_stage_arg_parser
from ltx_pipelines.utils.denoisers import GuidedDenoiser, SimpleDenoiser


def test_official_stage_one_uses_a_single_callable_simple_denoiser() -> None:
    context = torch.zeros((1, 2, 3))

    denoiser = _stage_1_denoiser(
        official_comfy_workflow=True,
        v_context_p=context,
        a_context_p=context,
        v_context_n=context,
        video_guider_params=MultiModalGuiderParams(),
    )

    assert isinstance(denoiser, SimpleDenoiser)
    assert callable(denoiser)
    assert not isinstance(denoiser, tuple)


def test_legacy_stage_one_keeps_guided_denoising() -> None:
    context = torch.zeros((1, 2, 3))

    denoiser = _stage_1_denoiser(
        official_comfy_workflow=False,
        v_context_p=context,
        a_context_p=context,
        v_context_n=context,
        video_guider_params=MultiModalGuiderParams(),
    )

    assert isinstance(denoiser, GuidedDenoiser)
    assert callable(denoiser)


def test_split_a2v_parser_can_use_the_distilled_transformer_without_a_legacy_lora() -> None:
    parser = default_2_stage_arg_parser(requires_distilled_lora=False)
    action = parser._option_string_actions["--distilled-lora"]

    assert action.required is False
    assert action.default == []


def test_other_two_stage_pipelines_still_require_the_distilled_lora() -> None:
    parser = default_2_stage_arg_parser()

    assert parser._option_string_actions["--distilled-lora"].required is True
