import logging
from collections.abc import Iterator, Sequence

import torch

from ltx_core.allocator_trim_strategy import AllocatorTrimStrategy
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
from ltx_core.model.video_vae import AUTO_TILING, AutoTiling, TilingConfig, get_video_chunks_number
from ltx_core.model.video_vae.transformer import DiffVAEMode
from ltx_core.quantization import QuantizationPolicy
from ltx_core.types import Audio, VideoPixelShape
from ltx_pipelines.utils.args import (
    ImageConditioningInput,
    add_generated_keyframes_arg,
    default_2_stage_arg_parser,
    resolve_cli_params,
)
from ltx_pipelines.utils.blocks import (
    AudioDecoder,
    DiffusionStage,
    DurationPredictor,
    ImageConditioner,
    PromptEncoder,
    VideoDecoder,
    VideoUpsampler,
    require_num_frames_source,
    resolve_num_frames,
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
    ensure_tiling_config,
    generated_keyframe_conditionings,
    get_device,
    has_generated_keyframes,
    tiling_scale_factors_for_vae,
)
from ltx_pipelines.utils.media_io import (
    HDRColorSpace,
    encode_video,
    resolve_hdr_color_space,
    vae_dtype_for_hdr,
)
from ltx_pipelines.utils.model_paths import ModelPaths
from ltx_pipelines.utils.types import DEFAULT_AUTO_DURATION, AutoDuration, ModalitySpec, OffloadMode


def _stage_1_denoiser(
    *,
    official_comfy_workflow: bool,
    v_context_p: torch.Tensor,
    a_context_p: torch.Tensor,
    v_context_n: torch.Tensor,
    a_context_n: torch.Tensor,
    video_guider_params: MultiModalGuiderParams | MultiModalGuiderFactory,
    audio_guider_params: MultiModalGuiderParams | MultiModalGuiderFactory,
) -> SimpleDenoiser | FactoryGuidedDenoiser:
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
        model_paths: ModelPaths,
        distilled_lora: list[LoraPathStrengthAndSDOps],
        spatial_upsampler_path: str,
        loras: list[LoraPathStrengthAndSDOps],
        gemma_loras: tuple[LoraPathStrengthAndSDOps, ...] = (),
        official_comfy_workflow: bool = False,
        device: torch.device | None = None,
        quantization: QuantizationPolicy | None = None,
        registry: Registry | None = None,
        compilation_config: CompilationConfig | None = None,
        offload_mode: OffloadMode = OffloadMode.NONE,
        alloc_trim_strategy: AllocatorTrimStrategy = AllocatorTrimStrategy.TRIM,
        prompt_enhancer_gemma_root: str | None = None,
        diffvae_optimization: DiffVAEMode = DiffVAEMode.CHUNKED_EAGER,
    ):
        self.device = device or get_device()
        self.dtype = torch.bfloat16
        self._scheduler = LTX2Scheduler()
        self._official_comfy_workflow = official_comfy_workflow

        self.prompt_encoder = PromptEncoder(
            model_paths,
            self.dtype,
            self.device,
            gemma_loras=gemma_loras,
            registry=registry,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
            official_comfy_prompt_enhancement=official_comfy_workflow,
            prompt_enhancer_gemma_root=prompt_enhancer_gemma_root,
        )
        self.image_conditioner = ImageConditioner(
            model_paths.video_vae(),
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.upsampler = VideoUpsampler(
            model_paths.video_vae(),
            spatial_upsampler_path,
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.video_decoder = VideoDecoder(
            model_paths.video_vae(),
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
            diffvae_optimization=diffvae_optimization,
        )
        self.audio_decoder = AudioDecoder(
            model_paths.audio_vae(),
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        # None on checkpoints that predate DurationHead (LTX 2.5 / gemma4 only) -- __call__ requires
        # an explicit num_frames in that case instead of crashing deep in a forward pass.
        self.duration_predictor = DurationPredictor.from_checkpoint(
            model_paths.duration_head_path,
            self.dtype,
            self.device,
        )

        self.stage_1 = DiffusionStage.from_checkpoint(
            model_paths.transformer(),
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
            model_paths.transformer(),
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
        frame_rate: float,
        num_inference_steps: int,
        video_guider_params: MultiModalGuiderParams | MultiModalGuiderFactory,
        audio_guider_params: MultiModalGuiderParams | MultiModalGuiderFactory,
        images: list[ImageConditioningInput],
        num_frames: int | AutoDuration = DEFAULT_AUTO_DURATION,
        vae_dtype: torch.dtype | None = None,
        tiling_config: TilingConfig | AutoTiling | None = AUTO_TILING,
        enhance_prompt: bool = False,
        enhance_static_cache: bool = False,
        max_batch_size: int = 1,
        stage_1_sigmas: torch.Tensor | None = None,
        stage_2_sigmas: torch.Tensor = STAGE_2_DISTILLED_SIGMAS,
        color_space: HDRColorSpace | None = None,
        generated_keyframes: int | Sequence[int] = 0,
    ) -> tuple[Iterator[torch.Tensor], Audio, int, TilingConfig | None]:
        require_num_frames_source(num_frames, self.duration_predictor)
        images = self.image_conditioner.resolve_crf(images)
        assert_resolution(height=height, width=width, is_two_stage=True)
        if has_generated_keyframes(generated_keyframes):
            self.stage_1.assert_generated_keyframes_supported()

        generator = torch.Generator(device=self.device).manual_seed(seed)
        noiser = GaussianNoiser(generator=generator)
        dtype = torch.bfloat16
        if vae_dtype is None:
            vae_dtype = dtype

        ctx_p, ctx_n = self.prompt_encoder(
            [prompt, negative_prompt],
            enhance_first_prompt=enhance_prompt,
            enhance_static_cache=enhance_static_cache,
            enhance_prompt_image=images[0][0] if len(images) > 0 else None,
            enhance_prompt_seed=seed,
        )
        v_context_p, a_context_p = ctx_p.video_encoding, ctx_p.audio_encoding
        v_context_n, a_context_n = ctx_n.video_encoding, ctx_n.audio_encoding

        num_frames = resolve_num_frames(
            num_frames,
            self.duration_predictor,
            video_encoding=v_context_p,
            audio_encoding=a_context_p,
            frame_rate=frame_rate,
        )

        scale_factors = tiling_scale_factors_for_vae(self.video_decoder.checkpoint_path)
        tiling_config = ensure_tiling_config(
            tiling_config,
            scale_factors=scale_factors,
            vae_checkpoint_path=self.video_decoder.checkpoint_path,
            video_shape=VideoPixelShape(batch=1, frames=num_frames, height=height, width=width, fps=frame_rate),
            diffvae_optimization=self.video_decoder.diffvae_optimization,
            device=self.device,
        )

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
                color_space=color_space,
            )
        )
        stage_1_conditionings.extend(generated_keyframe_conditionings(generated_keyframes, num_frames))

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
                color_space=color_space,
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

        decoded_video = self.video_decoder(video_state.latent, tiling_config, generator, dtype=vae_dtype)
        decoded_audio = self.audio_decoder(
            _final_audio_latent(
                official_comfy_workflow=self._official_comfy_workflow,
                stage_1_audio_latent=audio_state.latent,
                stage_2_audio_latent=stage_2_audio_state.latent,
            )
        )
        return decoded_video, decoded_audio, num_frames, tiling_config


@torch.inference_mode()
def main() -> None:
    logging.basicConfig(level=logging.INFO)
    params = resolve_cli_params()
    parser = add_generated_keyframes_arg(default_2_stage_arg_parser(params=params, supports_auto_duration=True))
    parser.add_argument(
        "--official-comfy-workflow",
        action="store_true",
        help="Use the official LTX-2.3 8+3 schedule and distilled LoRA in both stages.",
    )
    args = parser.parse_args()
    pipeline = TI2VidTwoStagesPipeline(
        model_paths=args.model_paths,
        distilled_lora=args.distilled_lora,
        spatial_upsampler_path=args.spatial_upsampler_path,
        loras=tuple(args.lora) if args.lora else (),
        gemma_loras=tuple(args.gemma_lora) if args.gemma_lora else (),
        official_comfy_workflow=args.official_comfy_workflow,
        quantization=args.quantization,
        compilation_config=args.compile,
        offload_mode=args.offload_mode,
        prompt_enhancer_gemma_root=args.prompt_enhancer_gemma_root,
        diffvae_optimization=args.diffvae_optimization,
    )
    hdr = resolve_hdr_color_space(images=args.images, hdr=args.hdr)
    vae_dtype = vae_dtype_for_hdr(hdr, torch.bfloat16)
    video, audio, num_frames, tiling_config = pipeline(
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
        vae_dtype=vae_dtype,
        color_space=hdr,
        enhance_prompt=args.enhance_prompt,
        enhance_static_cache=args.enhance_static_cache,
        max_batch_size=args.max_batch_size,
        tiling_config=None if args.disable_tiling else AUTO_TILING,
        generated_keyframes=args.num_generated_keyframes,
    )

    encode_video(
        video=video,
        fps=args.frame_rate,
        audio=audio,
        output_path=args.output_path,
        video_chunks_number=get_video_chunks_number(num_frames, tiling_config),
        color_space=hdr,
    )


if __name__ == "__main__":
    main()
