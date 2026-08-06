import logging
from collections.abc import Iterator

import torch

from ltx_core.components.guiders import (
    MultiModalGuiderFactory,
    MultiModalGuiderParams,
    create_multimodal_guider_factory,
)
from ltx_core.components.noisers import GaussianNoiser
from ltx_core.components.schedulers import LTX2Scheduler
from ltx_core.loader import LoraPathStrengthAndSDOps
from ltx_core.loader.registry import Registry
from ltx_core.model.transformer.compiling import CompilationConfig
from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
from ltx_core.quantization import QuantizationPolicy
from ltx_core.types import Audio, VideoPixelShape
from ltx_pipelines.utils.allocator_trim_strategy import AllocatorTrimStrategy
from ltx_pipelines.utils.args import (
    ImageConditioningInput,
    default_2_stage_arg_parser,
    resolve_cli_params,
)
from ltx_pipelines.utils.blocks import (
    AudioDecoder,
    DiffusionStage,
    ImageConditioner,
    PromptEncoder,
    VideoDecoder,
    VideoUpsampler,
)
from ltx_pipelines.utils.constants import (
    DISTILLED_SIGMAS,
    OFFICIAL_COMFY_STAGE_2_SEED,
    OFFICIAL_COMFY_STAGE_2_SIGMAS,
    STAGE_2_DISTILLED_SIGMAS,
)
from ltx_pipelines.utils.denoisers import FactoryGuidedDenoiser, SimpleDenoiser
from ltx_pipelines.utils.helpers import (
    assert_resolution,
    cap_image_conditioning_strength,
    combined_image_conditionings,
    get_device,
)
from ltx_pipelines.utils.media_io import encode_video
from ltx_pipelines.utils.types import Denoiser, ModalitySpec, OffloadMode


def _stage_1_denoiser(
    *,
    official_comfy_workflow: bool,
    v_context_p: torch.Tensor,
    a_context_p: torch.Tensor,
    v_context_n: torch.Tensor,
    a_context_n: torch.Tensor,
    video_guider_params: MultiModalGuiderParams | MultiModalGuiderFactory,
    audio_guider_params: MultiModalGuiderParams | MultiModalGuiderFactory,
) -> Denoiser:
    if official_comfy_workflow:
        return SimpleDenoiser(v_context_p, a_context_p)
    return FactoryGuidedDenoiser(
        v_context=v_context_p,
        a_context=a_context_p,
        video_guider_factory=create_multimodal_guider_factory(
            params=video_guider_params,
            negative_context=v_context_n,
        ),
        audio_guider_factory=create_multimodal_guider_factory(
            params=audio_guider_params,
            negative_context=a_context_n,
        ),
    )


def _stage_1_sigmas(
    *,
    official_comfy_workflow: bool,
    requested: torch.Tensor | None,
    scheduler: LTX2Scheduler,
    num_inference_steps: int,
) -> torch.Tensor:
    if requested is not None:
        return requested
    if official_comfy_workflow:
        return DISTILLED_SIGMAS
    return scheduler.execute(steps=num_inference_steps)


def _stage_2_schedule(
    *,
    official_comfy_workflow: bool,
    requested: torch.Tensor,
    noiser: GaussianNoiser,
    device: torch.device,
) -> tuple[torch.Tensor, GaussianNoiser]:
    if not official_comfy_workflow:
        return requested, noiser
    generator = torch.Generator(device=device).manual_seed(OFFICIAL_COMFY_STAGE_2_SEED)
    return OFFICIAL_COMFY_STAGE_2_SIGMAS, GaussianNoiser(generator=generator)


def _final_audio_latent(
    *,
    official_comfy_workflow: bool,
    stage_1_audio_latent: torch.Tensor,
    stage_2_audio_latent: torch.Tensor,
) -> torch.Tensor:
    return stage_2_audio_latent if official_comfy_workflow else stage_1_audio_latent


class TI2VidTwoStagesPipeline:
    """
    Two-stage text/image-to-video generation pipeline.
    Stage 1 generates video at half of the target resolution with CFG guidance (assuming
    full model is used), then Stage 2 upsamples by 2x and refines using a distilled
    LoRA for higher quality output. Supports optional image conditioning via the
    images parameter.
    """

    def __init__(  # noqa: PLR0913
        self,
        checkpoint_path: str,
        distilled_lora: list[LoraPathStrengthAndSDOps],
        spatial_upsampler_path: str,
        gemma_root: str,
        loras: list[LoraPathStrengthAndSDOps],
        gemma_loras: tuple[LoraPathStrengthAndSDOps, ...] = (),
        official_comfy_workflow: bool = False,
        device: torch.device | None = None,
        quantization: QuantizationPolicy | None = None,
        registry: Registry | None = None,
        compilation_config: CompilationConfig | None = None,
        offload_mode: OffloadMode = OffloadMode.NONE,
        alloc_trim_strategy: AllocatorTrimStrategy = AllocatorTrimStrategy.TRIM,
    ):
        self.device = device or get_device()
        self.dtype = torch.bfloat16
        self._scheduler = LTX2Scheduler()
        self._official_comfy_workflow = official_comfy_workflow

        self.prompt_encoder = PromptEncoder(
            checkpoint_path,
            gemma_root,
            self.dtype,
            self.device,
            gemma_loras=gemma_loras,
            registry=registry,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
            official_comfy_prompt_enhancement=official_comfy_workflow,
        )
        self.image_conditioner = ImageConditioner(
            checkpoint_path, self.dtype, self.device, registry=registry, alloc_trim_strategy=alloc_trim_strategy
        )
        self.upsampler = VideoUpsampler(
            checkpoint_path,
            spatial_upsampler_path,
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.video_decoder = VideoDecoder(
            checkpoint_path, self.dtype, self.device, registry=registry, alloc_trim_strategy=alloc_trim_strategy
        )
        self.audio_decoder = AudioDecoder(
            checkpoint_path, self.dtype, self.device, registry=registry, alloc_trim_strategy=alloc_trim_strategy
        )

        self.stage_1 = DiffusionStage.from_checkpoint(
            checkpoint_path,
            self.dtype,
            self.device,
            loras=(*tuple(loras), *distilled_lora) if official_comfy_workflow else tuple(loras),
            quantization=quantization,
            registry=registry,
            compilation_config=compilation_config,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.stage_2 = DiffusionStage.from_checkpoint(
            checkpoint_path,
            self.dtype,
            self.device,
            loras=(*tuple(loras), *distilled_lora),
            quantization=quantization,
            registry=registry,
            compilation_config=compilation_config,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
        )

    def __call__(  # noqa: PLR0913
        self,
        prompt: str,
        negative_prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        num_inference_steps: int,
        video_guider_params: MultiModalGuiderParams | MultiModalGuiderFactory,
        audio_guider_params: MultiModalGuiderParams | MultiModalGuiderFactory,
        images: list[ImageConditioningInput],
        tiling_config: TilingConfig | None = None,
        enhance_prompt: bool = False,
        max_batch_size: int = 1,
        stage_1_sigmas: torch.Tensor | None = None,
        stage_2_sigmas: torch.Tensor = STAGE_2_DISTILLED_SIGMAS,
    ) -> tuple[Iterator[torch.Tensor], Audio]:
        assert_resolution(height=height, width=width, is_two_stage=True)

        generator = torch.Generator(device=self.device).manual_seed(seed)
        noiser = GaussianNoiser(generator=generator)
        dtype = torch.bfloat16

        ctx_p, ctx_n = self.prompt_encoder(
            [prompt, negative_prompt],
            enhance_first_prompt=enhance_prompt,
            enhance_prompt_image=(
                None
                if self._official_comfy_workflow
                else images[0][0]
                if len(images) > 0
                else None
            ),
            enhance_prompt_seed=seed,
        )
        v_context_p, a_context_p = ctx_p.video_encoding, ctx_p.audio_encoding
        v_context_n, a_context_n = ctx_n.video_encoding, ctx_n.audio_encoding

        # Stage 1: Generate video at half resolution with CFG guidance.
        stage_1_output_shape = VideoPixelShape(
            batch=1,
            frames=num_frames,
            width=width // 2,
            height=height // 2,
            fps=frame_rate,
        )
        stage_1_images = (
            cap_image_conditioning_strength(images, 0.7)
            if self._official_comfy_workflow
            else images
        )
        stage_1_conditionings = self.image_conditioner(
            lambda enc: combined_image_conditionings(
                images=stage_1_images,
                height=stage_1_output_shape.height,
                width=stage_1_output_shape.width,
                video_encoder=enc,
                dtype=dtype,
                device=self.device,
            )
        )

        sigmas = _stage_1_sigmas(
            official_comfy_workflow=self._official_comfy_workflow,
            requested=stage_1_sigmas,
            scheduler=self._scheduler,
            num_inference_steps=num_inference_steps,
        ).to(dtype=torch.float32, device=self.device)

        stage_1_denoiser = _stage_1_denoiser(
            official_comfy_workflow=self._official_comfy_workflow,
            v_context_p=v_context_p,
            a_context_p=a_context_p,
            v_context_n=v_context_n,
            a_context_n=a_context_n,
            video_guider_params=video_guider_params,
            audio_guider_params=audio_guider_params,
        )

        video_state, audio_state = self.stage_1(
            denoiser=stage_1_denoiser,
            sigmas=sigmas,
            noiser=noiser,
            width=stage_1_output_shape.width,
            height=stage_1_output_shape.height,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(context=v_context_p, conditionings=stage_1_conditionings),
            audio=ModalitySpec(context=a_context_p),
            max_batch_size=max_batch_size,
        )
        if video_state is None or audio_state is None:
            raise RuntimeError("The first LTX-2.3 stage returned an incomplete AV latent.")

        # Stage 2: Upsample and refine the video at higher resolution with distilled LoRA.
        upscaled_video_latent = self.upsampler(video_state.latent[:1])

        stage_2_sigmas, stage_2_noiser = _stage_2_schedule(
            official_comfy_workflow=self._official_comfy_workflow,
            requested=stage_2_sigmas,
            noiser=noiser,
            device=self.device,
        )
        stage_2_sigmas = stage_2_sigmas.to(dtype=torch.float32, device=self.device)
        stage_2_conditionings = self.image_conditioner(
            lambda enc: combined_image_conditionings(
                images=images,
                height=height,
                width=width,
                video_encoder=enc,
                dtype=dtype,
                device=self.device,
            )
        )

        # The official ComfyUI template decodes audio from stage 2; the legacy path keeps
        # stage-1 audio because multi-GPU stage-2 audio runs under partial tiled/TDP context.
        video_state, stage_2_audio_state = self.stage_2(
            denoiser=SimpleDenoiser(v_context=v_context_p, a_context=a_context_p),
            sigmas=stage_2_sigmas,
            noiser=stage_2_noiser,
            width=width,
            height=height,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(
                context=v_context_p,
                conditionings=stage_2_conditionings,
                noise_scale=stage_2_sigmas[0].item(),
                initial_latent=upscaled_video_latent,
            ),
            audio=ModalitySpec(
                context=a_context_p,
                noise_scale=stage_2_sigmas[0].item(),
                initial_latent=audio_state.latent,
            ),
        )
        if video_state is None or stage_2_audio_state is None:
            raise RuntimeError("The second LTX-2.3 stage returned an incomplete AV latent.")

        decoded_video = self.video_decoder(video_state.latent, tiling_config, generator)
        decoded_audio = self.audio_decoder(
            _final_audio_latent(
                official_comfy_workflow=self._official_comfy_workflow,
                stage_1_audio_latent=audio_state.latent,
                stage_2_audio_latent=stage_2_audio_state.latent,
            )
        )
        return decoded_video, decoded_audio


@torch.inference_mode()
def main() -> None:
    logging.basicConfig(level=logging.INFO)
    params = resolve_cli_params()
    parser = default_2_stage_arg_parser(params=params)
    parser.add_argument(
        "--official-comfy-workflow",
        action="store_true",
        help="Use the official LTX-2.3 ComfyUI 8+3 schedule and apply the distilled LoRA in both stages.",
    )
    args = parser.parse_args()
    pipeline = TI2VidTwoStagesPipeline(
        checkpoint_path=args.checkpoint_path,
        distilled_lora=args.distilled_lora,
        spatial_upsampler_path=args.spatial_upsampler_path,
        gemma_root=args.gemma_root,
        loras=tuple(args.lora) if args.lora else (),
        gemma_loras=tuple(args.gemma_lora) if args.gemma_lora else (),
        official_comfy_workflow=args.official_comfy_workflow,
        quantization=args.quantization,
        compilation_config=args.compile,
        offload_mode=args.offload_mode,
    )
    tiling_config = None if args.disable_tiling else TilingConfig.default()
    video_chunks_number = get_video_chunks_number(args.num_frames, tiling_config)
    video, audio = pipeline(
        prompt=args.prompt,
        negative_prompt=args.negative_prompt,
        seed=args.seed,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        frame_rate=args.frame_rate,
        num_inference_steps=args.num_inference_steps,
        video_guider_params=MultiModalGuiderParams(
            cfg_scale=args.video_cfg_guidance_scale,
            stg_scale=args.video_stg_guidance_scale,
            rescale_scale=args.video_rescale_scale,
            modality_scale=args.a2v_guidance_scale,
            skip_step=args.video_skip_step,
            stg_blocks=args.video_stg_blocks,
        ),
        audio_guider_params=MultiModalGuiderParams(
            cfg_scale=args.audio_cfg_guidance_scale,
            stg_scale=args.audio_stg_guidance_scale,
            rescale_scale=args.audio_rescale_scale,
            modality_scale=args.v2a_guidance_scale,
            skip_step=args.audio_skip_step,
            stg_blocks=args.audio_stg_blocks,
        ),
        images=args.images,
        tiling_config=tiling_config,
        enhance_prompt=args.enhance_prompt,
        max_batch_size=args.max_batch_size,
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
