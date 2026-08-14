"""Official-style LTX-2.3 first/last-frame interpolation."""

import logging
from collections.abc import Iterator
from functools import partial

import torch

from ltx_core.allocator_trim_strategy import AllocatorTrimStrategy
from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep
from ltx_core.components.noisers import GaussianNoiser
from ltx_core.loader import LoraPathStrengthAndSDOps
from ltx_core.loader.registry import Registry
from ltx_core.model.transformer.compiling import CompilationConfig
from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
from ltx_core.quantization import QuantizationPolicy
from ltx_core.types import Audio
from ltx_pipelines.utils.args import (
    ImageConditioningInput,
    new_video_gen_arg_parser,
    resolve_cli_params,
)
from ltx_pipelines.utils.blocks import (
    AudioDecoder,
    DiffusionStage,
    ImageConditioner,
    PromptEncoder,
    VideoDecoder,
)
from ltx_pipelines.utils.constants import DISTILLED_SIGMAS
from ltx_pipelines.utils.denoisers import SimpleDenoiser
from ltx_pipelines.utils.helpers import (
    assert_resolution,
    get_device,
    image_conditionings_by_adding_guiding_latent,
)
from ltx_pipelines.utils.media_io import encode_video
from ltx_pipelines.utils.model_paths import ModelPaths
from ltx_pipelines.utils.samplers import euler_ancestral_denoising_loop
from ltx_pipelines.utils.types import ModalitySpec, OffloadMode


def _official_flf_stepper() -> EulerAncestralDiffusionStep:
    # The published FLF2V template runs SamplerEulerAncestral with eta=0:
    # deterministic steps without ancestral re-noising.
    return EulerAncestralDiffusionStep(eta=0.0, s_noise=1.0)


class FLF2VPipeline:
    """Single-stage distilled interpolation matching the official Comfy workflow."""

    def __init__(
        self,
        distilled_checkpoint_path: str | ModelPaths,
        gemma_root: str | None = None,
        loras: tuple[LoraPathStrengthAndSDOps, ...] = (),
        gemma_loras: tuple[LoraPathStrengthAndSDOps, ...] = (),
        device: torch.device | None = None,
        quantization: QuantizationPolicy | None = None,
        registry: Registry | None = None,
        compilation_config: CompilationConfig | None = None,
        offload_mode: OffloadMode = OffloadMode.NONE,
        alloc_trim_strategy: AllocatorTrimStrategy = AllocatorTrimStrategy.TRIM,
    ) -> None:
        model_paths = (
            distilled_checkpoint_path
            if isinstance(distilled_checkpoint_path, ModelPaths)
            else ModelPaths.from_monolith(distilled_checkpoint_path, gemma_root)
        )
        self.device = device or get_device()
        self.dtype = torch.bfloat16
        self.prompt_encoder = PromptEncoder(
            model_paths,
            self.dtype,
            self.device,
            gemma_loras=gemma_loras,
            registry=registry,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.image_conditioner = ImageConditioner(
            model_paths.video_vae(),
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.stage = DiffusionStage.from_checkpoint(
            model_paths.transformer(),
            self.dtype,
            self.device,
            loras=loras,
            quantization=quantization,
            registry=registry,
            compilation_config=compilation_config,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.video_decoder = VideoDecoder(
            model_paths.video_vae(),
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.audio_decoder = AudioDecoder(
            model_paths.audio_vae(),
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )

    def __call__(
        self,
        prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        images: list[ImageConditioningInput],
        tiling_config: TilingConfig | None = None,
        enhance_prompt: bool = False,
    ) -> tuple[Iterator[torch.Tensor], Audio]:
        assert_resolution(height=height, width=width, is_two_stage=False)
        if len(images) != 2:
            raise ValueError("FLF2V requires exactly a first and a last image")
        if images[0].frame_idx != 0 or images[1].frame_idx != num_frames - 1:
            raise ValueError("FLF2V images must target frame 0 and num_frames - 1")

        generator = torch.Generator(device=self.device).manual_seed(seed)
        noiser = GaussianNoiser(generator=generator)
        (context,) = self.prompt_encoder(
            [prompt],
            enhance_first_prompt=enhance_prompt,
            enhance_prompt_image=images[0].path,
            enhance_prompt_seed=seed,
        )
        conditionings = self.image_conditioner(
            lambda encoder: image_conditionings_by_adding_guiding_latent(
                images=images,
                height=height,
                width=width,
                video_encoder=encoder,
                dtype=self.dtype,
                device=self.device,
            )
        )
        video_state, audio_state = self.stage(
            denoiser=SimpleDenoiser(context.video_encoding, context.audio_encoding),
            sigmas=DISTILLED_SIGMAS.to(dtype=torch.float32, device=self.device),
            noiser=noiser,
            width=width,
            height=height,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(context=context.video_encoding, conditionings=conditionings),
            audio=ModalitySpec(context=context.audio_encoding),
            stepper=_official_flf_stepper(),
            loop=partial(euler_ancestral_denoising_loop, noise_seed=seed, model_dtype=self.dtype),
        )
        return (
            self.video_decoder(video_state.latent, tiling_config, generator),
            self.audio_decoder(audio_state.latent),
        )


@torch.inference_mode()
def main() -> None:
    logging.basicConfig(level=logging.INFO)
    params = resolve_cli_params(distilled=True)
    parser = new_video_gen_arg_parser(params=params, distilled=True)
    args = parser.parse_args()
    pipeline = FLF2VPipeline(
        distilled_checkpoint_path=args.model_paths,
        loras=tuple(args.lora) if args.lora else (),
        gemma_loras=tuple(args.gemma_lora) if args.gemma_lora else (),
        quantization=args.quantization,
        compilation_config=args.compile,
        offload_mode=args.offload_mode,
    )
    tiling_config = None if args.disable_tiling else TilingConfig.default()
    video_chunks_number = get_video_chunks_number(args.num_frames, tiling_config)
    video, audio = pipeline(
        prompt=args.prompt,
        seed=args.seed,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        frame_rate=args.frame_rate,
        images=args.images,
        tiling_config=tiling_config,
        enhance_prompt=args.enhance_prompt,
    )
    encode_video(
        video=video,
        fps=args.frame_rate,
        audio=audio,
        output_path=args.output_path,
        video_chunks_number=video_chunks_number,
    )


if __name__ == "__main__":
    main()
