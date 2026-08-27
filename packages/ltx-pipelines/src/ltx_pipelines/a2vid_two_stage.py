import argparse
import logging
from functools import partial

import torch

from ltx_core.allocator_trim_strategy import AllocatorTrimStrategy
from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep, EulerDiffusionStep
from ltx_core.components.guiders import MultiModalGuider, MultiModalGuiderParams
from ltx_core.components.noisers import GaussianNoiser
from ltx_core.components.schedulers import LTX2Scheduler
from ltx_core.loader import LoraPathStrengthAndSDOps
from ltx_core.loader.registry import Registry
from ltx_core.model.audio_vae import encode_audio as vae_encode_audio
from ltx_core.model.transformer.compiling import CompilationConfig
from ltx_core.model.video_vae import AUTO_TILING, AutoTiling, TilingConfig, get_video_chunks_number
from ltx_core.model.video_vae.transformer import DiffVAEMode
from ltx_core.quantization import QuantizationPolicy
from ltx_core.types import Audio, AudioLatentShape, VideoPixelShape
from ltx_pipelines.utils.args import (
    ImageConditioningInput,
    default_2_stage_arg_parser,
    resolve_cli_params,
)
from ltx_pipelines.utils.blocks import (
    AudioConditioner,
    DiffusionStage,
    ImageConditioner,
    PromptEncoder,
    VideoDecoder,
    VideoUpsampler,
)
from ltx_pipelines.utils.constants import (
    DISTILLED_SIGMAS,
    OFFICIAL_COMFY_STAGE_2_SEED,
    STAGE_2_DISTILLED_SIGMAS,
    PipelineParams,
)
from ltx_pipelines.utils.denoisers import GuidedDenoiser, SimpleDenoiser
from ltx_pipelines.utils.helpers import (
    assert_resolution,
    audio_duration_seconds,
    cap_image_conditioning_strength,
    combined_image_conditionings,
    conform_latent_length,
    ensure_tiling_config,
    get_device,
    num_frames_from_audio_duration,
    tiling_scale_factors_for_vae,
)
from ltx_pipelines.utils.media_io import (
    HDRColorSpace,
    decode_audio_from_file,
    encode_video,
    resolve_hdr_color_space,
    vae_dtype_for_hdr,
)
from ltx_pipelines.utils.model_paths import ModelPaths
from ltx_pipelines.utils.samplers import euler_ancestral_denoising_loop, euler_denoising_loop
from ltx_pipelines.utils.types import Denoiser, ModalitySpec, OffloadMode, PipelineOutput

logger = logging.getLogger(__name__)

# The published LTX-2.5 IA2V graph serializes 0.4219, not the higher precision
# 0.421875 used by the shared LTX-2.3 two-stage templates. Keep this local so
# tightening IA2V does not silently change the other official workflows.
A2V_OFFICIAL_COMFY_STAGE_2_SIGMAS = torch.tensor([0.85, 0.725, 0.4219, 0.0])


def _stage_1_denoiser(
    *,
    official_comfy_workflow: bool,
    v_context_p: torch.Tensor,
    a_context_p: torch.Tensor,
    v_context_n: torch.Tensor,
    video_guider_params: MultiModalGuiderParams,
) -> Denoiser:
    if official_comfy_workflow:
        return SimpleDenoiser(v_context_p, a_context_p)
    return GuidedDenoiser(
        v_context=v_context_p,
        a_context=a_context_p,
        video_guider=MultiModalGuider(
            params=video_guider_params,
            negative_context=v_context_n,
        ),
        audio_guider=MultiModalGuider(params=MultiModalGuiderParams()),
    )


def _stage_1_schedule(
    *,
    official_comfy_workflow: bool,
    requested: torch.Tensor | None,
    scheduler: LTX2Scheduler,
    num_inference_steps: int,
    seed: int,
) -> tuple[torch.Tensor, dict[str, object]]:
    if official_comfy_workflow:
        sigmas = DISTILLED_SIGMAS
    elif requested is not None:
        sigmas = requested
    else:
        sigmas = scheduler.execute(steps=num_inference_steps)
    if not official_comfy_workflow:
        return sigmas, {}
    return sigmas, {
        "stepper": EulerAncestralDiffusionStep(eta=1.0, s_noise=1.0),
        "state_dtype": torch.float32,
        "loop": partial(
            euler_ancestral_denoising_loop,
            noise_seed=seed,
            model_dtype=torch.float32,
            model_input_dtype=torch.bfloat16,
        ),
    }


def _stage_2_schedule(
    *,
    official_comfy_workflow: bool,
    requested: torch.Tensor,
    noiser: GaussianNoiser,
    device: torch.device,
) -> tuple[torch.Tensor, GaussianNoiser, dict[str, object]]:
    if not official_comfy_workflow:
        return requested, noiser, {}
    generator = torch.Generator(device=device).manual_seed(OFFICIAL_COMFY_STAGE_2_SEED)
    return A2V_OFFICIAL_COMFY_STAGE_2_SIGMAS, GaussianNoiser(generator=generator), {
        "stepper": EulerDiffusionStep(),
        "state_dtype": torch.float32,
        "loop": partial(
            euler_denoising_loop,
            model_dtype=torch.float32,
            model_input_dtype=torch.bfloat16,
        ),
    }


def _validate_a2vid_model_contract(
    model_paths: ModelPaths,
    distilled_lora: list[LoraPathStrengthAndSDOps],
) -> None:
    if model_paths.mode == "monolith" and not distilled_lora:
        raise ValueError("--distilled-lora is required with a monolithic checkpoint")


def _a2vid_tiling_config(disable_tiling: bool) -> TilingConfig | AutoTiling | None:
    return None if disable_tiling else AUTO_TILING


class A2VidPipelineTwoStage:
    """
    Two-stage audio to video generation pipeline.
    Stage 1 generates video at half the target resolution with audio conditioning
    (video-only denoising, audio frozen), then Stage 2 upsamples by 2x and refines
    the video using the distilled split transformer or monolith LoRA while
    preserving the input audio.
    When ``num_frames`` is omitted, the frame count is derived from the effective
    conditioning-audio duration (``min(audio_max_duration, remaining audio after
    audio_start_time)``) at ``frame_rate``, snapped to the VAE temporal grid.
    """

    def __init__(  # noqa: PLR0913,PLR0917
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
        _validate_a2vid_model_contract(model_paths, distilled_lora)
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
        self.audio_conditioner = AudioConditioner(
            model_paths.audio_vae(),
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.stage_1 = DiffusionStage.from_checkpoint(
            model_paths.transformer(),
            self.dtype,
            self.device,
            loras=(*tuple(loras), *tuple(distilled_lora)) if official_comfy_workflow else tuple(loras),
            quantization=quantization,
            registry=registry,
            compilation_config=compilation_config,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        stage_2_loras = (*tuple(loras), *tuple(distilled_lora))
        self.stage_2 = DiffusionStage.from_checkpoint(
            model_paths.transformer(),
            self.dtype,
            self.device,
            loras=stage_2_loras,
            quantization=quantization,
            registry=registry,
            compilation_config=compilation_config,
            offload_mode=offload_mode,
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

    def __call__(  # noqa: PLR0913,PLR0917
        self,
        prompt: str,
        negative_prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int | None,
        frame_rate: float,
        num_inference_steps: int,
        video_guider_params: MultiModalGuiderParams,
        images: list[ImageConditioningInput],
        audio_path: str,
        audio_start_time: float = 0.0,
        audio_max_duration: float | None = None,
        vae_dtype: torch.dtype | None = None,
        tiling_config: TilingConfig | AutoTiling | None = AUTO_TILING,
        enhance_prompt: bool = False,
        enhance_static_cache: bool = False,
        max_batch_size: int = 1,
        stage_1_sigmas: torch.Tensor | None = None,
        stage_2_sigmas: torch.Tensor = STAGE_2_DISTILLED_SIGMAS,
        color_space: HDRColorSpace | None = None,
    ) -> PipelineOutput:
        images = self.image_conditioner.resolve_crf(images)
        assert_resolution(height=height, width=width, is_two_stage=True)

        generator = torch.Generator(device=self.device).manual_seed(seed)
        noiser = GaussianNoiser(generator=generator)
        dtype = torch.bfloat16
        if vae_dtype is None:
            vae_dtype = dtype

        # Decode audio first so the frame count can follow the effective clip length
        # (``audio_max_duration`` capped by remaining audio after ``audio_start_time``).
        decoded_audio = decode_audio_from_file(audio_path, self.device, audio_start_time, audio_max_duration)
        if decoded_audio is None:
            raise ValueError(f"Failed to decode audio from {audio_path}. Please check the file and try again.")
        if num_frames is None:
            num_frames = num_frames_from_audio_duration(decoded_audio, frame_rate=frame_rate)
            logger.info(
                "Derived num_frames=%d from %.2fs of audio @ %.2f fps",
                num_frames,
                audio_duration_seconds(decoded_audio),
                frame_rate,
            )

        ctx_p, ctx_n = self.prompt_encoder(
            [prompt, negative_prompt],
            enhance_first_prompt=enhance_prompt,
            enhance_static_cache=enhance_static_cache,
            enhance_prompt_image=images[0][0] if len(images) > 0 else None,
        )
        v_context_p, a_context_p = ctx_p.video_encoding, ctx_p.audio_encoding
        v_context_n, _ = ctx_n.video_encoding, ctx_n.audio_encoding

        scale_factors = tiling_scale_factors_for_vae(self.video_decoder.checkpoint_path)
        tiling_config = ensure_tiling_config(
            tiling_config,
            scale_factors=scale_factors,
            vae_checkpoint_path=self.video_decoder.checkpoint_path,
            video_shape=VideoPixelShape(batch=1, frames=num_frames, height=height, width=width, fps=frame_rate),
            diffvae_optimization=self.video_decoder.diffvae_optimization,
            device=self.device,
        )

        encoded_audio_latent = self.audio_conditioner(lambda enc: vae_encode_audio(decoded_audio, enc, None))
        audio_shape = AudioLatentShape.from_duration(batch=1, duration=num_frames / frame_rate, channels=8, mel_bins=16)
        encoded_audio_latent = conform_latent_length(encoded_audio_latent, audio_shape.frames)

        # Stage 1: encode image conditionings with the VAE encoder, then denoise
        # video-only (audio frozen).
        stage_1_output_shape = VideoPixelShape(
            batch=1,
            frames=num_frames,
            width=width // 2,
            height=height // 2,
            fps=frame_rate,
        )
        stage_1_images = cap_image_conditioning_strength(images, 0.7) if self._official_comfy_workflow else images
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

        sigmas, stage_1_sampler = _stage_1_schedule(
            official_comfy_workflow=self._official_comfy_workflow,
            requested=stage_1_sigmas,
            scheduler=self._scheduler,
            num_inference_steps=num_inference_steps,
            seed=seed,
        )
        sigmas = sigmas.to(dtype=torch.float32, device=self.device)

        video_state, _ = self.stage_1(
            denoiser=_stage_1_denoiser(
                official_comfy_workflow=self._official_comfy_workflow,
                v_context_p=v_context_p,
                a_context_p=a_context_p,
                v_context_n=v_context_n,
                video_guider_params=video_guider_params,
            ),
            sigmas=sigmas,
            noiser=noiser,
            width=stage_1_output_shape.width,
            height=stage_1_output_shape.height,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(
                context=v_context_p,
                conditionings=stage_1_conditionings,
            ),
            audio=ModalitySpec(
                context=a_context_p,
                frozen=True,
                noise_scale=0.0,
                initial_latent=encoded_audio_latent,
            ),
            max_batch_size=max_batch_size,
            **stage_1_sampler,
        )

        # Stage 2: Upsample and refine with the distilled split transformer or monolith LoRA.
        # The sampler state is FP32, while the VAE/upsampler weights remain BF16.
        # Stage-2 state creation promotes the resulting latent back to FP32 before
        # its seed-42 Gaussian noise is sampled.
        upscaled_video_latent = self.upsampler(video_state.latent[:1].to(self.dtype))

        stage_2_sigmas, stage_2_noiser, stage_2_sampler = _stage_2_schedule(
            official_comfy_workflow=self._official_comfy_workflow,
            requested=stage_2_sigmas,
            noiser=noiser,
            device=self.device,
        )
        stage_2_sigmas = stage_2_sigmas.to(dtype=torch.float32, device=self.device)
        stage_2_output_shape = VideoPixelShape(batch=1, frames=num_frames, width=width, height=height, fps=frame_rate)
        stage_2_conditionings = self.image_conditioner(
            lambda enc: combined_image_conditionings(
                images=images,
                height=stage_2_output_shape.height,
                width=stage_2_output_shape.width,
                video_encoder=enc,
                dtype=dtype,
                device=self.device,
                color_space=color_space,
            )
        )

        video_state, _ = self.stage_2(
            denoiser=SimpleDenoiser(v_context_p, a_context_p),
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
                frozen=True,
                noise_scale=0.0,
                initial_latent=encoded_audio_latent,
            ),
            **stage_2_sampler,
        )

        decoded_video = self.video_decoder(video_state.latent, tiling_config, generator, dtype=vae_dtype)

        # Return the original input audio instead of VAE-decoded audio to preserve fidelity.
        # decode_audio_from_file already returns normalised [-1, 1] float values.
        # Trim to the snapped video duration so a slightly longer clip cannot freeze
        # the last frames. Floor so a half-sample leftover cannot outlast the video.
        video_samples = max(1, int((num_frames / frame_rate) * decoded_audio.sampling_rate))
        original_audio = Audio(
            waveform=decoded_audio.waveform.squeeze(0)[..., :video_samples],
            sampling_rate=decoded_audio.sampling_rate,
        )

        return PipelineOutput(decoded_video, original_audio, num_frames, tiling_config, None, video_state.latent)


def resolve_a2vid_cli_duration(
    *,
    num_frames: int | None,
    audio_max_duration: float | None,
    frame_rate: float,
    default_num_frames: int,
) -> tuple[int | None, float]:
    """Pick the single duration driver for the A2Vid CLI.
    ``--num-frames`` and ``--audio-max-duration`` are mutually exclusive. Returns
    ``(num_frames_for_pipeline, audio_max_duration)``:
    * only ``--audio-max-duration``: ``num_frames`` is ``None`` so the pipeline derives
      frames from the decoded clip (capped by remaining audio after start time).
    * only ``--num-frames``, or neither: use that frame count (defaulting to
      ``default_num_frames``) and clip audio to ``num_frames / frame_rate``.
    """
    if num_frames is not None and audio_max_duration is not None:
        raise ValueError("argument --num-frames: not allowed with argument --audio-max-duration")
    if audio_max_duration is not None:
        return None, audio_max_duration
    frames = default_num_frames if num_frames is None else num_frames
    return frames, frames / frame_rate


def build_a2vid_arg_parser(params: PipelineParams) -> argparse.ArgumentParser:
    """Two-stage parser plus A2Vid audio flags; ``--num-frames`` default is unset.
    Leaving ``--num-frames`` as ``None`` when omitted is what lets
    ``resolve_a2vid_cli_duration`` tell "user passed --audio-max-duration" apart from
    "user passed both" (the shared parser would otherwise fill in ``params.num_frames``).
    """
    parser = default_2_stage_arg_parser(params=params, requires_distilled_lora=False)
    parser.add_argument(
        "--official-comfy-workflow",
        action="store_true",
        help="Use the official IA2V 8+3 schedule and samplers with the reviewed local split-pack bridge.",
    )
    parser.add_argument(
        "--audio-path",
        type=str,
        required=True,
        help="Path to the audio file to condition the video generation.",
    )
    parser.add_argument(
        "--audio-start-time",
        type=float,
        default=0.0,
        help="Start time in seconds to read audio from (default: 0.0).",
    )
    parser.add_argument(
        "--audio-max-duration",
        type=float,
        default=None,
        help=(
            "Maximum audio duration in seconds, measured from --audio-start-time. "
            "The video length is derived from the effective clip "
            "(this value capped by remaining audio in the file) at --frame-rate. "
            "Mutually exclusive with --num-frames. "
            f"If neither is given, audio is clipped to the default "
            f"--num-frames / --frame-rate ({params.num_frames} frames)."
        ),
    )
    for action in parser._actions:
        if "--num-frames" in action.option_strings:
            action.default = None
            action.help = (
                "Number of frames to generate, num_frames = 8 * k + 1 "
                f"(default: {params.num_frames}). Mutually exclusive with --audio-max-duration; "
                "when set, audio is clipped to this length / --frame-rate."
            )
            break
    return parser


def resolve_a2vid_duration_or_exit(
    parser: argparse.ArgumentParser,
    args: argparse.Namespace,
    *,
    default_num_frames: int,
) -> tuple[int | None, float]:
    """Resolve duration knobs, or ``parser.error`` if both flags were given."""
    try:
        return resolve_a2vid_cli_duration(
            num_frames=args.num_frames,
            audio_max_duration=args.audio_max_duration,
            frame_rate=args.frame_rate,
            default_num_frames=default_num_frames,
        )
    except ValueError as e:
        parser.error(str(e))
        raise  # parser.error always exits; keep the type checker happy


@torch.inference_mode()
def main() -> None:
    logging.basicConfig(level=logging.INFO)
    params = resolve_cli_params()
    parser = build_a2vid_arg_parser(params)
    args = parser.parse_args()
    try:
        _validate_a2vid_model_contract(args.model_paths, list(args.distilled_lora or ()))
    except ValueError as error:
        parser.error(str(error))
    num_frames, audio_max_duration = resolve_a2vid_duration_or_exit(parser, args, default_num_frames=params.num_frames)
    pipeline = A2VidPipelineTwoStage(
        model_paths=args.model_paths,
        distilled_lora=list(args.distilled_lora or ()),
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
    result = pipeline(
        prompt=args.prompt,
        negative_prompt=args.negative_prompt,
        seed=args.seed,
        height=args.height,
        width=args.width,
        num_frames=num_frames,
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
        images=args.images,
        vae_dtype=vae_dtype,
        color_space=hdr,
        tiling_config=_a2vid_tiling_config(args.disable_tiling),
        enhance_prompt=args.enhance_prompt,
        enhance_static_cache=args.enhance_static_cache,
        audio_path=args.audio_path,
        audio_start_time=args.audio_start_time,
        audio_max_duration=audio_max_duration,
        max_batch_size=args.max_batch_size,
    )
    encode_video(
        video=result.video,
        fps=args.frame_rate,
        audio=result.audio,
        output_path=args.output_path,
        video_chunks_number=get_video_chunks_number(result.num_frames, result.tiling_config),
        color_space=hdr,
    )


if __name__ == "__main__":
    main()
