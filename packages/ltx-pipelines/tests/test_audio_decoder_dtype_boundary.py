import sys
import types
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
import torch

sys.modules.setdefault("OpenImageIO", types.ModuleType("OpenImageIO"))

from ltx_core.types import AudioLatentShape, LatentState, VideoPixelShape  # noqa: E402
from ltx_pipelines.utils import blocks  # noqa: E402
from ltx_pipelines.utils.types import ModalitySpec  # noqa: E402


class _FakeModel:
    def eval(self) -> "_FakeModel":
        return self


class _FakeBuilder:
    checkpoint = "checkpoint"

    def build(self, **_kwargs: object) -> _FakeModel:
        return _FakeModel()


class _RecordingNoiser:
    def __init__(self) -> None:
        self.dtypes: list[torch.dtype] = []

    def __call__(self, state: LatentState, _noise_scale: float) -> LatentState:
        self.dtypes.append(state.latent.dtype)
        return state


def test_diffusion_stage_builds_initial_noise_state_in_explicit_dtype() -> None:
    @contextmanager
    def transformer_context() -> Iterator[_FakeModel]:
        yield _FakeModel()

    observed_loop_dtypes: list[torch.dtype] = []

    def passthrough_loop(
        *,
        sigmas: torch.Tensor,
        video_state: LatentState | None,
        audio_state: LatentState | None,
        stepper: object,
        transformer: object,
        denoiser: object,
    ) -> tuple[LatentState | None, LatentState | None]:
        del sigmas, stepper, transformer, denoiser
        assert video_state is None
        assert audio_state is not None
        observed_loop_dtypes.append(audio_state.latent.dtype)
        return video_state, audio_state

    stage = object.__new__(blocks.DiffusionStage)
    stage._transformer_builder = _FakeBuilder()
    stage._dtype = torch.bfloat16
    stage._device = torch.device("cpu")
    stage._quantization = None
    stage._compilation_config = None
    stage._alloc_trim_strategy = None
    stage._transformer_ctx = lambda **_kwargs: transformer_context()

    noiser = _RecordingNoiser()
    pixel_shape = VideoPixelShape(batch=1, frames=9, height=512, width=512, fps=24.0)
    audio_shape = AudioLatentShape.from_video_pixel_shape(pixel_shape)
    initial_audio = torch.zeros(*audio_shape.to_torch_shape(), dtype=torch.bfloat16)
    video_state, audio_state = stage(
        denoiser=object(),
        sigmas=torch.tensor([1.0, 0.0]),
        noiser=noiser,
        width=512,
        height=512,
        frames=9,
        fps=24.0,
        audio=ModalitySpec(initial_latent=initial_audio),
        loop=passthrough_loop,
        state_dtype=torch.float32,
    )

    assert video_state is None
    assert audio_state is not None
    assert noiser.dtypes == [torch.float32]
    assert observed_loop_dtypes == [torch.float32]
    assert audio_state.latent.dtype is torch.float32


def test_video_upsampler_casts_to_model_dtype_and_restores_sampler_dtype(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, torch.dtype] = {}

    @contextmanager
    def fake_gpu_model(model: object, **_kwargs: object) -> Iterator[object]:
        yield model

    def fake_upsample_video(
        *,
        latent: torch.Tensor,
        video_encoder: object,
        upsampler: object,
    ) -> torch.Tensor:
        del video_encoder, upsampler
        observed["model_input"] = latent.dtype
        return torch.ones_like(latent)

    monkeypatch.setattr(blocks, "gpu_model", fake_gpu_model)
    monkeypatch.setattr(blocks, "upsample_video", fake_upsample_video)

    video_upsampler = object.__new__(blocks.VideoUpsampler)
    video_upsampler._upsampler_path = "upsampler"
    video_upsampler._dtype = torch.bfloat16
    video_upsampler._device = torch.device("cpu")
    video_upsampler._encoder_builder = _FakeBuilder()
    video_upsampler._upsampler_builder = _FakeBuilder()
    video_upsampler._alloc_trim_strategy = None

    result = video_upsampler(torch.ones((1, 1, 1, 1, 1), dtype=torch.float32))

    assert observed["model_input"] is torch.bfloat16
    assert result.dtype is torch.float32


def test_audio_decoder_casts_fp32_sampler_output_to_model_dtype(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: dict[str, object] = {}

    @contextmanager
    def fake_gpu_model(model: object, **_kwargs: object) -> Iterator[object]:
        yield model

    expected_audio = object()

    def fake_decode_audio(latent: torch.Tensor, decoder: object, vocoder: object) -> object:
        observed["dtype"] = latent.dtype
        observed["decoder"] = decoder
        observed["vocoder"] = vocoder
        return expected_audio

    monkeypatch.setattr(blocks, "gpu_model", fake_gpu_model)
    monkeypatch.setattr(blocks, "vae_decode_audio", fake_decode_audio)

    audio_decoder = object.__new__(blocks.AudioDecoder)
    audio_decoder._checkpoint_path = "checkpoint"
    audio_decoder._dtype = torch.bfloat16
    audio_decoder._device = torch.device("cpu")
    audio_decoder._decoder_builder = _FakeBuilder()
    audio_decoder._vocoder_builder = _FakeBuilder()
    audio_decoder._alloc_trim_strategy = None

    result = audio_decoder(torch.ones(1, dtype=torch.float32))

    assert result is expected_audio
    assert observed["dtype"] is torch.bfloat16
    assert isinstance(observed["decoder"], _FakeModel)
    assert isinstance(observed["vocoder"], _FakeModel)
