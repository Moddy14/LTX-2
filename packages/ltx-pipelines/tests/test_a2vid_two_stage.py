from __future__ import annotations

import importlib
import json
from functools import partial
from pathlib import Path
from types import SimpleNamespace

import pytest
import torch

import ltx_pipelines.a2vid_two_stage as a2v
from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep, EulerDiffusionStep
from ltx_core.components.guiders import MultiModalGuiderParams
from ltx_core.components.noisers import GaussianNoiser
from ltx_core.components.patchifiers import AudioPatchifier
from ltx_core.components.schedulers import LTX2Scheduler
from ltx_core.tools import AudioLatentTools
from ltx_core.types import Audio, AudioLatentShape, LatentState, SpatioTemporalScaleFactors
from ltx_pipelines.a2vid_two_stage import (
    A2V_OFFICIAL_COMFY_STAGE_2_SIGMAS,
    A2VidPipelineTwoStage,
    _a2vid_tiling_config,
    _stage_1_denoiser,
    _stage_1_schedule,
    _stage_2_schedule,
    _validate_a2vid_model_contract,
    build_a2vid_arg_parser,
)
from ltx_pipelines.utils import cooperative_checkpoint
from ltx_pipelines.utils.args import ImageConditioningInput
from ltx_pipelines.utils.blocks import _build_state
from ltx_pipelines.utils.constants import DISTILLED_SIGMAS, OFFICIAL_COMFY_STAGE_2_SEED
from ltx_pipelines.utils.denoisers import GuidedDenoiser, SimpleDenoiser
from ltx_pipelines.utils.model_paths import ModelPaths
from ltx_pipelines.utils.samplers import euler_ancestral_denoising_loop, euler_denoising_loop
from ltx_pipelines.utils.types import DenoisedLatentResult, ModalitySpec

CPU = torch.device("cpu")


def _denoiser(official: bool) -> SimpleDenoiser | GuidedDenoiser:
    context = torch.zeros((1, 2, 3))
    return _stage_1_denoiser(
        official_comfy_workflow=official,
        v_context_p=context,
        a_context_p=context,
        v_context_n=context,
        video_guider_params=MultiModalGuiderParams(),
    )


def test_official_stage_one_uses_simple_denoising_and_legacy_keeps_guidance() -> None:
    assert isinstance(_denoiser(official=True), SimpleDenoiser)
    assert isinstance(_denoiser(official=False), GuidedDenoiser)


def test_official_stage_one_pins_distilled_sigmas_ancestral_fp32_and_request_seed() -> None:
    sigmas, sampler = _stage_1_schedule(
        official_comfy_workflow=True,
        requested=None,
        scheduler=LTX2Scheduler(),
        num_inference_steps=30,
        seed=12_345,
    )

    assert torch.equal(sigmas, DISTILLED_SIGMAS)
    assert torch.equal(
        sigmas,
        torch.tensor([1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0]),
    )
    assert isinstance(sampler["stepper"], EulerAncestralDiffusionStep)
    assert sampler["stepper"].eta == 1.0
    assert sampler["stepper"].s_noise == 1.0
    assert sampler["state_dtype"] is torch.float32
    loop = sampler["loop"]
    assert isinstance(loop, partial)
    assert loop.func is euler_ancestral_denoising_loop
    assert loop.keywords == {
        "noise_seed": 12_345,
        "model_dtype": torch.float32,
        "model_input_dtype": torch.bfloat16,
    }

    pinned_sigmas, _ = _stage_1_schedule(
        official_comfy_workflow=True,
        requested=torch.tensor([0.9, 0.0]),
        scheduler=LTX2Scheduler(),
        num_inference_steps=2,
        seed=12_345,
    )
    assert pinned_sigmas is DISTILLED_SIGMAS


def test_legacy_schedules_preserve_requested_values_and_existing_sampler_defaults() -> None:
    requested_stage_1 = torch.tensor([0.91, 0.0])
    requested_stage_2 = torch.tensor([0.82, 0.0])
    noiser = GaussianNoiser(torch.Generator(device=CPU).manual_seed(7))

    stage_1_sigmas, stage_1_sampler = _stage_1_schedule(
        official_comfy_workflow=False,
        requested=requested_stage_1,
        scheduler=LTX2Scheduler(),
        num_inference_steps=17,
        seed=123,
    )
    stage_2_sigmas, stage_2_noiser, stage_2_sampler = _stage_2_schedule(
        official_comfy_workflow=False,
        requested=requested_stage_2,
        noiser=noiser,
        device=CPU,
    )

    assert stage_1_sigmas is requested_stage_1
    assert stage_1_sampler == {}
    assert stage_2_sigmas is requested_stage_2
    assert stage_2_noiser is noiser
    assert stage_2_sampler == {}

    scheduled_stage_1, scheduled_sampler = _stage_1_schedule(
        official_comfy_workflow=False,
        requested=None,
        scheduler=LTX2Scheduler(),
        num_inference_steps=17,
        seed=123,
    )
    assert torch.equal(scheduled_stage_1, LTX2Scheduler().execute(steps=17))
    assert scheduled_sampler == {}


def test_official_stage_two_pins_template_sigmas_seed_euler_and_fp32() -> None:
    stage_1_noiser = GaussianNoiser(torch.Generator(device=CPU).manual_seed(7))

    sigmas, noiser, sampler = _stage_2_schedule(
        official_comfy_workflow=True,
        requested=torch.tensor([0.9, 0.4, 0.0]),
        noiser=stage_1_noiser,
        device=CPU,
    )

    assert torch.equal(sigmas, torch.tensor([0.85, 0.725, 0.4219, 0.0]))
    assert sigmas is A2V_OFFICIAL_COMFY_STAGE_2_SIGMAS
    assert sigmas[2:3].view(torch.int32).item() == 0x3ED80347
    assert noiser is not stage_1_noiser
    assert noiser.generator.initial_seed() == OFFICIAL_COMFY_STAGE_2_SEED
    assert isinstance(sampler["stepper"], EulerDiffusionStep)
    assert sampler["state_dtype"] is torch.float32
    loop = sampler["loop"]
    assert isinstance(loop, partial)
    assert loop.func is euler_denoising_loop
    assert loop.keywords == {
        "model_dtype": torch.float32,
        "model_input_dtype": torch.bfloat16,
    }


def test_fp32_stage_state_casts_an_existing_bf16_latent_before_gaussian_noise() -> None:
    initial_latent = torch.zeros((1, 8, 4, 16), dtype=torch.bfloat16)
    observed_noise_input_dtypes: list[torch.dtype] = []

    class RecordingGaussianNoiser(GaussianNoiser):
        def _sample_noise(self, latent_state: LatentState) -> torch.Tensor:
            observed_noise_input_dtypes.append(latent_state.latent.dtype)
            return super()._sample_noise(latent_state)

    state = _build_state(
        spec=ModalitySpec(initial_latent=initial_latent, noise_scale=0.85),
        tools=AudioLatentTools(AudioPatchifier(patch_size=1), AudioLatentShape.from_torch_shape(initial_latent.shape)),
        noiser=RecordingGaussianNoiser(torch.Generator(device=CPU).manual_seed(42)),
        dtype=torch.float32,
        device=CPU,
        cast_initial_latent=True,
    )
    legacy_state = _build_state(
        spec=ModalitySpec(initial_latent=initial_latent, noise_scale=0.85),
        tools=AudioLatentTools(AudioPatchifier(patch_size=1), AudioLatentShape.from_torch_shape(initial_latent.shape)),
        noiser=RecordingGaussianNoiser(torch.Generator(device=CPU).manual_seed(42)),
        dtype=torch.float32,
        device=CPU,
    )

    assert initial_latent.dtype is torch.bfloat16
    assert observed_noise_input_dtypes == [torch.float32, torch.bfloat16]
    assert state.latent.dtype is torch.float32
    assert state.clean_latent.dtype is torch.float32
    assert legacy_state.latent.dtype is torch.bfloat16


def test_generic_deterministic_sampler_dtype_bridge_is_opt_in_for_legacy_callers() -> None:
    observed_model_input_dtypes: list[torch.dtype] = []
    state = LatentState(
        latent=torch.ones(1, dtype=torch.bfloat16),
        denoise_mask=torch.ones(1),
        positions=torch.zeros(1),
        clean_latent=torch.zeros(1),
    )

    def denoiser(
        _transformer: object,
        video_state: LatentState | None,
        _audio_state: LatentState | None,
        _sigmas: torch.Tensor,
        _step_index: int,
    ) -> tuple[DenoisedLatentResult, None]:
        assert video_state is not None
        observed_model_input_dtypes.append(video_state.latent.dtype)
        return DenoisedLatentResult(torch.zeros_like(video_state.latent)), None

    importlib.reload(cooperative_checkpoint)
    try:
        video, audio = euler_denoising_loop(
            sigmas=torch.tensor([1.0, 0.5, 0.0]),
            video_state=state,
            audio_state=None,
            stepper=EulerDiffusionStep(),
            transformer=object(),  # type: ignore[arg-type]
            denoiser=denoiser,  # type: ignore[arg-type]
        )

        assert video is not None
        assert video.latent.dtype is torch.bfloat16
        assert audio is None
        assert observed_model_input_dtypes == [torch.bfloat16, torch.bfloat16]
    finally:
        importlib.reload(cooperative_checkpoint)


def test_deterministic_euler_loop_really_retains_an_fp32_trajectory() -> None:
    importlib.reload(cooperative_checkpoint)
    try:
        state = LatentState(
            latent=torch.ones((1, 1), dtype=torch.bfloat16),
            denoise_mask=torch.ones((1, 1)),
            positions=torch.zeros((1, 1)),
            clean_latent=torch.zeros((1, 1)),
        )

        observed_step_dtypes: list[torch.dtype] = []
        observed_model_input_dtypes: list[torch.dtype] = []

        class RecordingEulerStep(EulerDiffusionStep):
            def step(
                self,
                sample: torch.Tensor,
                denoised_sample: torch.Tensor,
                sigmas: torch.Tensor,
                step_index: int,
                **kwargs: object,
            ) -> torch.Tensor:
                observed_step_dtypes.append(sample.dtype)
                return super().step(sample, denoised_sample, sigmas, step_index, **kwargs)

        def denoiser(
            _transformer: object,
            video_state: LatentState | None,
            _audio_state: LatentState | None,
            _sigmas: torch.Tensor,
            _step_index: int,
        ) -> tuple[DenoisedLatentResult, None]:
            assert video_state is not None
            observed_model_input_dtypes.append(video_state.latent.dtype)
            return DenoisedLatentResult(torch.zeros((1, 1), dtype=torch.bfloat16)), None

        video, audio = euler_denoising_loop(
            sigmas=torch.tensor([1.0, 0.5, 0.0]),
            video_state=state,
            audio_state=None,
            stepper=RecordingEulerStep(),
            transformer=object(),  # type: ignore[arg-type]
            denoiser=denoiser,  # type: ignore[arg-type]
            model_dtype=torch.float32,
            model_input_dtype=torch.bfloat16,
        )

        assert video is not None
        assert observed_step_dtypes == [torch.float32, torch.float32]
        assert observed_model_input_dtypes == [torch.bfloat16, torch.bfloat16]
        assert video.latent.dtype is torch.float32
        assert audio is None
    finally:
        importlib.reload(cooperative_checkpoint)


def test_official_ancestral_loop_uses_request_seed_fp32_state_and_keeps_audio_frozen() -> None:
    observed_model_input_dtypes: list[tuple[torch.dtype, torch.dtype]] = []
    observed_noise_input_dtypes: list[torch.dtype] = []

    def state(value: float, *, frozen: bool) -> LatentState:
        latent = torch.tensor([value], dtype=torch.bfloat16)
        return LatentState(
            latent=latent,
            denoise_mask=torch.zeros_like(latent) if frozen else torch.ones_like(latent),
            positions=torch.zeros_like(latent),
            clean_latent=latent.clone(),
        )

    def denoiser(
        _transformer: object,
        video_state: LatentState | None,
        audio_state: LatentState | None,
        _sigmas: torch.Tensor,
        _step_index: int,
    ) -> tuple[DenoisedLatentResult, DenoisedLatentResult]:
        assert video_state is not None
        assert audio_state is not None
        observed_model_input_dtypes.append((video_state.latent.dtype, audio_state.latent.dtype))
        return (
            DenoisedLatentResult(video_state.latent * 0.5),
            DenoisedLatentResult(audio_state.latent * 0.5),
        )

    def noise(latent: torch.Tensor, generator: torch.Generator) -> torch.Tensor:
        observed_noise_input_dtypes.append(latent.dtype)
        return torch.randn(latent.shape, dtype=latent.dtype, generator=generator)

    def run(seed: int) -> tuple[LatentState, LatentState]:
        video, audio = euler_ancestral_denoising_loop(
            sigmas=torch.tensor([1.0, 0.725, 0.421875, 0.0]),
            video_state=state(0.0, frozen=False),
            audio_state=state(0.25, frozen=True),
            stepper=EulerAncestralDiffusionStep(eta=1.0, s_noise=1.0),
            transformer=object(),  # type: ignore[arg-type]
            denoiser=denoiser,  # type: ignore[arg-type]
            noise_seed=seed,
            new_noise_fn=noise,
            model_dtype=torch.float32,
            model_input_dtype=torch.bfloat16,
        )
        assert video is not None
        assert audio is not None
        return video, audio

    importlib.reload(cooperative_checkpoint)
    try:
        first_video, first_audio = run(9_876)
        second_video, second_audio = run(9_876)
        other_video, other_audio = run(9_877)

        torch.testing.assert_close(first_video.latent, second_video.latent)
        assert not torch.equal(first_video.latent, other_video.latent)
        for audio in (first_audio, second_audio, other_audio):
            assert audio.latent.dtype is torch.float32
            torch.testing.assert_close(audio.latent, torch.tensor([0.25]))
        assert first_video.latent.dtype is torch.float32
        assert observed_model_input_dtypes == [(torch.bfloat16, torch.bfloat16)] * 9
        assert observed_noise_input_dtypes == [torch.float32] * 12
    finally:
        importlib.reload(cooperative_checkpoint)


def test_deterministic_fp32_euler_trajectory_survives_cooperative_resume(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LTX_COOPERATIVE_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "a2v-fp32")
    (tmp_path / "yield-request.json").write_text(
        json.dumps({
            "schema_version": "ltx-cooperative-yield-request.v1",
            "job_fingerprint": "a2v-fp32",
            "request_id": "yield-a2v-fp32",
        }),
        encoding="utf-8",
    )
    sigmas = torch.tensor([1.0, 0.5, 0.0])

    class AddOneStep:
        def step(
            self,
            sample: torch.Tensor,
            _denoised_sample: torch.Tensor,
            _sigmas: torch.Tensor,
            _step_index: int,
        ) -> torch.Tensor:
            assert sample.dtype is torch.float32
            return sample + 1

    def initial_state() -> LatentState:
        return LatentState(
            latent=torch.zeros(1, dtype=torch.bfloat16),
            denoise_mask=torch.ones(1),
            positions=torch.zeros(1),
            clean_latent=torch.zeros(1),
        )

    def denoiser(*_args: object) -> tuple[DenoisedLatentResult, None]:
        video_state = _args[1]
        assert isinstance(video_state, LatentState)
        assert video_state.latent.dtype is torch.bfloat16
        return DenoisedLatentResult(torch.zeros(1, dtype=torch.bfloat16)), None

    importlib.reload(cooperative_checkpoint)
    try:
        with pytest.raises(SystemExit) as yielded:
            euler_denoising_loop(
                sigmas,
                initial_state(),
                None,
                AddOneStep(),  # type: ignore[arg-type]
                object(),  # type: ignore[arg-type]
                denoiser,  # type: ignore[arg-type]
                model_dtype=torch.float32,
                model_input_dtype=torch.bfloat16,
            )
        assert yielded.value.code == cooperative_checkpoint.YIELD_EXIT_CODE

        (tmp_path / "yield-request.json").unlink()
        importlib.reload(cooperative_checkpoint)
        video, audio = euler_denoising_loop(
            sigmas,
            initial_state(),
            None,
            AddOneStep(),  # type: ignore[arg-type]
            object(),  # type: ignore[arg-type]
            denoiser,  # type: ignore[arg-type]
            model_dtype=torch.float32,
            model_input_dtype=torch.bfloat16,
        )

        assert video is not None
        assert video.latent.dtype is torch.float32
        assert video.latent.item() == 2
        assert audio is None
    finally:
        importlib.reload(cooperative_checkpoint)


def test_ancestral_fp32_trajectory_resumes_from_a_bf16_model_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sigmas = torch.tensor([1.0, 0.725, 0.421875, 0.0])

    def state(value: float) -> LatentState:
        latent = torch.tensor([value], dtype=torch.bfloat16)
        return LatentState(
            latent=latent,
            denoise_mask=torch.ones_like(latent),
            positions=torch.zeros_like(latent),
            clean_latent=torch.zeros_like(latent),
        )

    def denoiser(
        _transformer: object,
        video_state: LatentState | None,
        audio_state: LatentState | None,
        _sigmas: torch.Tensor,
        _step_index: int,
    ) -> tuple[DenoisedLatentResult, DenoisedLatentResult]:
        assert video_state is not None
        assert audio_state is not None
        assert video_state.latent.dtype is torch.bfloat16
        assert audio_state.latent.dtype is torch.bfloat16
        return (
            DenoisedLatentResult(video_state.latent * 0.5),
            DenoisedLatentResult(audio_state.latent * 0.5),
        )

    def run() -> tuple[LatentState | None, LatentState | None]:
        return euler_ancestral_denoising_loop(
            sigmas=sigmas,
            video_state=state(0.0),
            audio_state=state(0.25),
            stepper=EulerAncestralDiffusionStep(eta=1.0, s_noise=1.0),
            transformer=object(),  # type: ignore[arg-type]
            denoiser=denoiser,  # type: ignore[arg-type]
            noise_seed=4_321,
            model_dtype=torch.float32,
            model_input_dtype=torch.bfloat16,
        )

    monkeypatch.delenv("LTX_COOPERATIVE_CHECKPOINT_DIR", raising=False)
    monkeypatch.delenv("LTX_COOPERATIVE_JOB_FINGERPRINT", raising=False)
    importlib.reload(cooperative_checkpoint)
    baseline_video, baseline_audio = run()

    monkeypatch.setenv("LTX_COOPERATIVE_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "a2v-fp32-ancestral")
    (tmp_path / "yield-request.json").write_text(
        json.dumps({
            "schema_version": "ltx-cooperative-yield-request.v1",
            "job_fingerprint": "a2v-fp32-ancestral",
            "request_id": "yield-a2v-fp32-ancestral",
        }),
        encoding="utf-8",
    )
    importlib.reload(cooperative_checkpoint)
    with pytest.raises(SystemExit) as yielded:
        run()
    assert yielded.value.code == cooperative_checkpoint.YIELD_EXIT_CODE

    saved = torch.load(tmp_path / "state.pt", map_location="cpu", weights_only=True)
    assert saved["video_state"]["latent"].dtype is torch.float32
    assert saved["audio_state"]["latent"].dtype is torch.float32

    (tmp_path / "yield-request.json").unlink()
    importlib.reload(cooperative_checkpoint)
    resumed_video, resumed_audio = run()

    assert baseline_video is not None
    assert baseline_audio is not None
    assert resumed_video is not None
    assert resumed_audio is not None
    torch.testing.assert_close(resumed_video.latent, baseline_video.latent)
    torch.testing.assert_close(resumed_audio.latent, baseline_audio.latent)
    importlib.reload(cooperative_checkpoint)


def test_split_runtime_needs_no_legacy_lora_but_monolith_still_does() -> None:
    split = ModelPaths.from_split(
        transformer_path="transformer.safetensors",
        text_encoder_path="text-encoder.safetensors",
        video_vae_path="video-vae.safetensors",
        audio_vae_path="audio-vae.safetensors",
    )
    monolith = ModelPaths.from_monolith("monolith.safetensors", "gemma")

    _validate_a2vid_model_contract(split, [])
    with pytest.raises(ValueError, match="distilled-lora"):
        _validate_a2vid_model_contract(monolith, [])
    _validate_a2vid_model_contract(monolith, [object()])  # type: ignore[list-item]
    with pytest.raises(ValueError, match="distilled-lora"):
        A2VidPipelineTwoStage(
            model_paths=monolith,
            distilled_lora=[],
            spatial_upsampler_path="upscaler.safetensors",
            loras=[],
            device=CPU,
        )

    parser = build_a2vid_arg_parser(a2v.PipelineParams())
    assert parser._option_string_actions["--distilled-lora"].required is False
    assert "--official-comfy-workflow" in parser._option_string_actions
    assert "--official-comfy-sampler" not in parser._option_string_actions


def test_constructor_forwards_gemma_and_handles_split_and_monolith_official_loras(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prompt_calls: list[dict[str, object]] = []
    stage_calls: list[dict[str, object]] = []
    normal_lora = object()
    distilled_lora = object()
    gemma_lora = object()

    monkeypatch.setattr(
        a2v,
        "PromptEncoder",
        lambda *_args, **kwargs: prompt_calls.append(kwargs) or object(),
    )
    monkeypatch.setattr(a2v, "ImageConditioner", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(a2v, "AudioConditioner", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(
        a2v,
        "DiffusionStage",
        SimpleNamespace(
            from_checkpoint=lambda *_args, **kwargs: stage_calls.append(kwargs) or object(),
        ),
    )
    monkeypatch.setattr(a2v, "VideoUpsampler", lambda *_args, **_kwargs: object())
    monkeypatch.setattr(
        a2v,
        "VideoDecoder",
        lambda *_args, **_kwargs: SimpleNamespace(
            checkpoint_path="video-vae.safetensors",
            diffvae_optimization=a2v.DiffVAEMode.CHUNKED_EAGER,
        ),
    )
    split_model_paths = ModelPaths.from_split(
        transformer_path="transformer.safetensors",
        text_encoder_path="text-encoder.safetensors",
        video_vae_path="video-vae.safetensors",
        audio_vae_path="audio-vae.safetensors",
    )

    A2VidPipelineTwoStage(
        model_paths=split_model_paths,
        distilled_lora=[],
        spatial_upsampler_path="upscaler.safetensors",
        loras=[normal_lora],  # type: ignore[list-item]
        gemma_loras=(gemma_lora,),  # type: ignore[arg-type]
        official_comfy_workflow=True,
        device=CPU,
    )

    assert prompt_calls == [{
        "gemma_loras": (gemma_lora,),
        "registry": None,
        "offload_mode": a2v.OffloadMode.NONE,
        "alloc_trim_strategy": a2v.AllocatorTrimStrategy.TRIM,
        "official_comfy_prompt_enhancement": True,
        "prompt_enhancer_gemma_root": None,
    }]
    assert [call["loras"] for call in stage_calls] == [
        (normal_lora,),
        (normal_lora,),
    ]

    prompt_calls.clear()
    stage_calls.clear()
    A2VidPipelineTwoStage(
        model_paths=ModelPaths.from_monolith("monolith.safetensors", "gemma"),
        distilled_lora=[distilled_lora],  # type: ignore[list-item]
        spatial_upsampler_path="upscaler.safetensors",
        loras=[normal_lora],  # type: ignore[list-item]
        gemma_loras=(gemma_lora,),  # type: ignore[arg-type]
        official_comfy_workflow=True,
        device=CPU,
    )
    assert [call["loras"] for call in stage_calls] == [
        (normal_lora, distilled_lora),
        (normal_lora, distilled_lora),
    ]


class _Conditioner:
    def resolve_crf(self, images: list[ImageConditioningInput]) -> list[ImageConditioningInput]:
        return images

    def __call__(self, callback: object) -> list[object]:
        return callback(object())  # type: ignore[operator,no-any-return]


class _CaptureStage:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []

    def __call__(self, **kwargs: object) -> tuple[SimpleNamespace, None]:
        self.calls.append(kwargs)
        return SimpleNamespace(latent=torch.zeros((1, 1, 2, 2, 2))), None


class _VideoDecoder:
    checkpoint_path = "video-vae.safetensors"
    diffvae_optimization = a2v.DiffVAEMode.CHUNKED_EAGER

    def __call__(self, *_args: object, **_kwargs: object) -> object:
        return iter([torch.zeros((1, 1, 3))])


def test_official_pipeline_freezes_the_same_conformed_audio_in_both_stages_and_returns_original_audio(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    decoded_audio = Audio(
        waveform=torch.arange(1_200, dtype=torch.float32).reshape(1, 2, 600),
        sampling_rate=100,
    )
    stage_1 = _CaptureStage()
    stage_2 = _CaptureStage()
    pipeline = object.__new__(A2VidPipelineTwoStage)
    pipeline.device = CPU
    pipeline.dtype = torch.bfloat16
    pipeline._scheduler = LTX2Scheduler()
    pipeline._official_comfy_workflow = True
    pipeline.prompt_encoder = lambda *_args, **_kwargs: (
        SimpleNamespace(video_encoding=torch.zeros((1, 2, 3)), audio_encoding=torch.zeros((1, 2, 3))),
        SimpleNamespace(video_encoding=torch.zeros((1, 2, 3)), audio_encoding=torch.zeros((1, 2, 3))),
    )
    pipeline.image_conditioner = _Conditioner()
    pipeline.audio_conditioner = lambda _callback: torch.ones((1, 8, 1, 16), dtype=torch.bfloat16)
    pipeline.stage_1 = stage_1
    pipeline.stage_2 = stage_2
    upscaler_input_dtypes: list[torch.dtype] = []

    def upsample(latent: torch.Tensor) -> torch.Tensor:
        upscaler_input_dtypes.append(latent.dtype)
        return latent

    pipeline.upsampler = upsample
    pipeline.video_decoder = _VideoDecoder()
    image_calls: list[list[ImageConditioningInput]] = []

    monkeypatch.setattr(a2v, "decode_audio_from_file", lambda *_args, **_kwargs: decoded_audio)
    monkeypatch.setattr(a2v, "assert_resolution", lambda **_kwargs: None)
    monkeypatch.setattr(a2v, "tiling_scale_factors_for_vae", lambda _path: SpatioTemporalScaleFactors.default())
    monkeypatch.setattr(a2v, "ensure_tiling_config", lambda config, **_kwargs: config)
    monkeypatch.setattr(
        a2v,
        "combined_image_conditionings",
        lambda **kwargs: image_calls.append(kwargs["images"]) or [],
    )

    result = pipeline(
        prompt="prompt",
        negative_prompt="negative",
        seed=9876,
        height=64,
        width=64,
        num_frames=9,
        frame_rate=2.0,
        num_inference_steps=30,
        video_guider_params=MultiModalGuiderParams(),
        images=[ImageConditioningInput("reference.png", 0, 1.0, 35)],
        audio_path="voice.wav",
        tiling_config=None,
    )

    stage_1_audio = stage_1.calls[0]["audio"]
    stage_2_audio = stage_2.calls[0]["audio"]
    assert stage_1_audio.frozen is True
    assert stage_2_audio.frozen is True
    assert stage_1_audio.noise_scale == 0.0
    assert stage_2_audio.noise_scale == 0.0
    assert stage_1_audio.initial_latent is stage_2_audio.initial_latent
    assert stage_1_audio.initial_latent.shape == (1, 8, 112, 16)
    assert stage_1.calls[0]["noiser"].generator.initial_seed() == 9876
    assert isinstance(stage_1.calls[0]["stepper"], EulerAncestralDiffusionStep)
    assert stage_1.calls[0]["loop"].keywords["noise_seed"] == 9876
    assert stage_1.calls[0]["loop"].keywords["model_dtype"] is torch.float32
    assert stage_1.calls[0]["loop"].keywords["model_input_dtype"] is torch.bfloat16
    assert stage_1.calls[0]["state_dtype"] is torch.float32
    assert isinstance(stage_2.calls[0]["stepper"], EulerDiffusionStep)
    assert stage_2.calls[0]["noiser"].generator.initial_seed() == OFFICIAL_COMFY_STAGE_2_SEED
    assert stage_2.calls[0]["loop"].keywords["model_dtype"] is torch.float32
    assert stage_2.calls[0]["loop"].keywords["model_input_dtype"] is torch.bfloat16
    assert stage_2.calls[0]["state_dtype"] is torch.float32
    assert upscaler_input_dtypes == [torch.bfloat16]
    assert [call[0].strength for call in image_calls] == [0.7, 1.0]
    assert torch.equal(result.audio.waveform, decoded_audio.waveform.squeeze(0)[..., :450])
    assert result.audio.sampling_rate == decoded_audio.sampling_rate


def test_disable_tiling_is_an_explicit_cli_contract() -> None:
    assert _a2vid_tiling_config(disable_tiling=True) is None
    assert _a2vid_tiling_config(disable_tiling=False) is a2v.AUTO_TILING
