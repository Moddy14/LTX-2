import argparse
import logging
from collections.abc import Iterator
from functools import partial
from typing import Literal

import torch

from ltx_core.allocator_trim_strategy import AllocatorTrimStrategy
from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep, EulerCfgPpDiffusionStep
from ltx_core.components.guiders import MultiModalGuiderParams, create_multimodal_guider_factory
from ltx_core.components.noisers import GaussianNoiser
from ltx_core.conditioning import ConditioningItem
from ltx_core.loader import LoraPathStrengthAndSDOps
from ltx_core.loader.registry import Registry
from ltx_core.model.audio_vae import encode_audio as vae_encode_audio
from ltx_core.model.transformer.compiling import CompilationConfig
from ltx_core.model.video_vae import AUTO_TILING, AutoTiling, TilingConfig, VideoEncoder, get_video_chunks_number
from ltx_core.model.video_vae.transformer import DiffVAEMode
from ltx_core.quantization import QuantizationPolicy
from ltx_core.types import Audio, AudioLatentShape, VideoPixelShape
from ltx_pipelines.iclora_utils import (
    append_ic_lora_reference_video_conditionings,
    read_lora_reference_downscale_factor,
    read_lora_reference_temporal_scale_factor,
)
from ltx_pipelines.utils.args import (
    ImageConditioningInput,
    VideoConditioningAction,
    VideoMaskConditioningAction,
    default_2_stage_distilled_arg_parser,
)
from ltx_pipelines.utils.blocks import (
    AudioDecoder,
    AudioConditioner,
    DiffusionStage,
    ImageConditioner,
    PromptEncoder,
    VideoDecoder,
    VideoUpsampler,
)
from ltx_pipelines.utils.constants import (
    DISTILLED_SIGMAS,
    LTX_2_3_PARAMS,
    STAGE_2_DISTILLED_SIGMAS,
)
from ltx_pipelines.utils.control_preprocess import preprocess_control_video
from ltx_pipelines.utils.denoisers import FactoryGuidedDenoiser, SimpleDenoiser
from ltx_pipelines.utils.helpers import (
    assert_resolution,
    combined_image_conditionings,
    conform_latent_length,
    ensure_tiling_config,
    get_device,
    tiling_scale_factors_for_vae,
)
from ltx_pipelines.utils.media_io import (
    HDRColorSpace,
    decode_audio_from_file,
    decode_video_by_frame,
    encode_video,
    resolve_hdr_color_space,
    vae_dtype_for_hdr,
    video_preprocess,
)
from ltx_pipelines.utils.model_paths import ModelPaths
from ltx_pipelines.utils.samplers import euler_ancestral_denoising_loop, euler_cfg_pp_denoising_loop
from ltx_pipelines.utils.types import ModalitySpec, OffloadMode

OfficialICLoraSampler = Literal[
    "euler-ancestral-rf",
    "euler-ancestral-cfg-pp",
    "euler-cfg-pp",
]


def _audio_noise_scale(initial_audio_latent: torch.Tensor | None) -> float:
    return 0.0 if initial_audio_latent is not None else 1.0


class ICLoraPipeline:
    """
    Two-stage video generation pipeline with In-Context (IC) LoRA support.
    Allows conditioning the generated video on control signals such as depth maps,
    human pose, or image edges via the video_conditioning parameter.
    The specific IC-LoRA model should be provided via the loras parameter.
    Stage 1 generates video at half of the target resolution, then Stage 2 upsamples
    by 2x and refines with additional denoising steps for higher quality output.
    Both stages use distilled models for efficiency.
    """

    def __init__(  # noqa: PLR0913
        self,
        model_paths: ModelPaths,
        spatial_upsampler_path: str | None,
        loras: list[LoraPathStrengthAndSDOps],
        gemma_loras: tuple[LoraPathStrengthAndSDOps, ...] = (),
        official_comfy_workflow: bool = False,
        official_comfy_sampler: OfficialICLoraSampler = "euler-ancestral-rf",
        device: torch.device | None = None,
        quantization: QuantizationPolicy | None = None,
        registry: Registry | None = None,
        compilation_config: CompilationConfig | None = None,
        offload_mode: OffloadMode = OffloadMode.NONE,
        alloc_trim_strategy: AllocatorTrimStrategy = AllocatorTrimStrategy.TRIM,
        prompt_enhancer_gemma_root: str | None = None,
        diffvae_optimization: DiffVAEMode = DiffVAEMode.CHUNKED_EAGER,
    ) -> None:
        self.device = device or get_device()
        self.dtype = torch.bfloat16
        self._official_comfy_workflow = official_comfy_workflow
        self._official_comfy_sampler = official_comfy_sampler
        if not official_comfy_workflow and official_comfy_sampler != "euler-ancestral-rf":
            raise ValueError("An official Comfy sampler can only be selected with official_comfy_workflow=True")

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
        self.stage_1 = DiffusionStage.from_checkpoint(
            model_paths.transformer(),
            self.dtype,
            self.device,
            loras=tuple(loras),
            quantization=quantization,
            registry=registry,
            compilation_config=compilation_config,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.stage_2 = None
        self.upsampler = None
        if not official_comfy_workflow:
            if spatial_upsampler_path is None:
                raise ValueError("The two-stage IC-LoRA path requires a spatial upsampler.")
            self.stage_2 = DiffusionStage.from_checkpoint(
                model_paths.transformer(),
                self.dtype,
                self.device,
                loras=(),
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
        self.audio_decoder = AudioDecoder(
            model_paths.audio_vae(),
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

        # Read reference scale factors from LoRA metadata.
        # IC-LoRAs trained with scaled reference videos store these factors
        # so inference can resize/subsample reference videos to match training conditions.
        self.reference_downscale_factor = 1
        self.reference_temporal_scale_factor = 1
        for lora in loras:
            scale = read_lora_reference_downscale_factor(lora.path)
            if scale != 1:
                if self.reference_downscale_factor not in (1, scale):
                    raise ValueError(
                        f"Conflicting reference_downscale_factor values in LoRAs: "
                        f"already have {self.reference_downscale_factor}, but {lora.path} "
                        f"specifies {scale}. Cannot combine LoRAs with different reference scales."
                    )
                self.reference_downscale_factor = scale
            temporal = read_lora_reference_temporal_scale_factor(lora.path)
            if temporal != 1:
                if self.reference_temporal_scale_factor not in (1, temporal):
                    raise ValueError(
                        f"Conflicting reference_temporal_scale_factor values in LoRAs: "
                        f"already have {self.reference_temporal_scale_factor}, but {lora.path} "
                        f"specifies {temporal}. Cannot combine LoRAs with different temporal scales."
                    )
                self.reference_temporal_scale_factor = temporal

    def __call__(  # noqa: PLR0913
        self,
        prompt: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        images: list[ImageConditioningInput],
        video_conditioning: list[tuple[str, float]],
        negative_prompt: str = "",
        enhance_prompt: bool = False,
        enhance_static_cache: bool = False,
        vae_dtype: torch.dtype | None = None,
        tiling_config: TilingConfig | AutoTiling | None = AUTO_TILING,
        conditioning_attention_strength: float = 1.0,
        skip_stage_2: bool = False,
        conditioning_attention_mask: torch.Tensor | None = None,
        repeat_static_video_conditioning: bool = False,
        freeze_control_audio_path: str | None = None,
        stage_1_sigmas: torch.Tensor = DISTILLED_SIGMAS,
        stage_2_sigmas: torch.Tensor = STAGE_2_DISTILLED_SIGMAS,
        color_space: HDRColorSpace | None = None,
    ) -> tuple[Iterator[torch.Tensor], Audio, TilingConfig | None]:
        """
        Generate video with IC-LoRA conditioning.
        Args:
            prompt: Text prompt for video generation.
            seed: Random seed for reproducibility.
            height: Output video height in pixels (must be divisible by 64).
            width: Output video width in pixels (must be divisible by 64).
            num_frames: Number of frames to generate.
            frame_rate: Output video frame rate.
            images: List of (path, frame_idx, strength) tuples for image conditioning.
            video_conditioning: List of (path, strength) tuples for IC-LoRA video conditioning.
            enhance_prompt: Whether to enhance the prompt with the Gemma text encoder before conditioning.
            tiling_config: Optional tiling configuration for VAE decoding.
            conditioning_attention_strength: Scale factor for IC-LoRA conditioning attention.
                Controls how strongly the conditioning video influences the output.
                0.0 = ignore conditioning, 1.0 = full conditioning influence. Default 1.0.
                When conditioning_attention_mask is provided, the mask is multiplied by
                this strength before being passed to the conditioning items.
            skip_stage_2: If True, skip Stage 2 upsampling and refinement. Output will be
                at half resolution (height//2, width//2). Default is False.
            conditioning_attention_mask: Optional pixel-space attention mask with the same
                spatial-temporal dimensions as the input reference video. Shape should be
                (B, 1, F, H, W) or (1, 1, F, H, W) where F, H, W match the reference
                video's pixel dimensions. Values in [0, 1].
                The mask is downsampled to latent space using VAE scale factors (with
                causal temporal handling for the first frame), then multiplied by
                conditioning_attention_strength.
                When None (default): scalar conditioning_attention_strength is used
                directly.
        Returns:
            Tuple of (video_iterator, audio_tensor).
        """
        images = self.image_conditioner.resolve_crf(images)
        assert_resolution(height=height, width=width, is_two_stage=not self._official_comfy_workflow)
        if not (0.0 <= conditioning_attention_strength <= 1.0):
            raise ValueError(
                f"conditioning_attention_strength must be in [0.0, 1.0], got {conditioning_attention_strength}"
            )

        generator = torch.Generator(device=self.device).manual_seed(seed)
        noiser = GaussianNoiser(generator=generator)
        if vae_dtype is None:
            vae_dtype = self.dtype

        cfg_pp = self._official_comfy_workflow and self._official_comfy_sampler in {
            "euler-ancestral-cfg-pp",
            "euler-cfg-pp",
        }
        contexts = self.prompt_encoder(
            [prompt, negative_prompt] if cfg_pp else [prompt],
            enhance_first_prompt=enhance_prompt,
            enhance_static_cache=enhance_static_cache,
            enhance_prompt_image=(
                images[0][0]
                if len(images) > 0
                else video_conditioning[0][0]
                if len(video_conditioning) > 0
                else None
            ),
            enhance_prompt_seed=seed,
        )
        ctx_p = contexts[0]
        ctx_n = contexts[1] if cfg_pp else None
        video_context, audio_context = ctx_p.video_encoding, ctx_p.audio_encoding

        scale_factors = tiling_scale_factors_for_vae(self.video_decoder.checkpoint_path)
        tiling_config = ensure_tiling_config(
            tiling_config,
            scale_factors=scale_factors,
            vae_checkpoint_path=self.video_decoder.checkpoint_path,
            video_shape=VideoPixelShape(batch=1, frames=num_frames, height=height, width=width, fps=frame_rate),
            diffvae_optimization=self.video_decoder.diffvae_optimization,
            device=self.device,
        )

        # Official examples are single-stage at target resolution; the native path
        # remains a half-resolution first stage followed by 2x refinement.
        scale = 1 if self._official_comfy_workflow else 2
        stage_1_output_shape = VideoPixelShape(
            batch=1,
            frames=num_frames,
            width=width // scale,
            height=height // scale,
            fps=frame_rate,
        )

        # Encode conditionings using the video encoder block
        stage_1_conditionings = self.image_conditioner(
            lambda enc: self._create_conditionings(
                images=images,
                video_conditioning=video_conditioning,
                height=stage_1_output_shape.height,
                width=stage_1_output_shape.width,
                video_encoder=enc,
                num_frames=num_frames,
                conditioning_attention_strength=conditioning_attention_strength,
                conditioning_attention_mask=conditioning_attention_mask,
                repeat_static_video_conditioning=repeat_static_video_conditioning,
                color_space=color_space,
            )
        )

        stage_1_sigmas = stage_1_sigmas.to(dtype=torch.float32, device=self.device)

        denoiser = SimpleDenoiser(video_context, audio_context)
        stepper = None
        loop = None
        if self._official_comfy_workflow:
            if self._official_comfy_sampler == "euler-ancestral-rf":
                stepper = EulerAncestralDiffusionStep()
                loop = partial(euler_ancestral_denoising_loop, noise_seed=seed, model_dtype=self.dtype)
            else:
                if ctx_n is None:
                    raise RuntimeError("CFG++ sampling requires negative text conditioning")
                guider_params = MultiModalGuiderParams(
                    cfg_scale=1.0,
                    stg_scale=0.0,
                    rescale_scale=0.0,
                    modality_scale=1.0,
                    skip_step=0,
                    stg_blocks=[],
                )
                denoiser = FactoryGuidedDenoiser(
                    v_context=video_context,
                    a_context=audio_context,
                    video_guider_factory=create_multimodal_guider_factory(
                        params=guider_params,
                        negative_context=ctx_n.video_encoding,
                    ),
                    audio_guider_factory=create_multimodal_guider_factory(
                        params=guider_params,
                        negative_context=ctx_n.audio_encoding,
                    ),
                    force_uncond_pass=True,
                )
                ancestral = self._official_comfy_sampler == "euler-ancestral-cfg-pp"
                stepper = EulerCfgPpDiffusionStep(
                    eta=1.0 if ancestral else 0.0,
                    s_noise=1.0 if ancestral else 0.0,
                )
                loop = partial(euler_cfg_pp_denoising_loop, noise_seed=seed)

        initial_audio_latent = None
        preserved_audio = None
        if freeze_control_audio_path:
            decoded_audio = decode_audio_from_file(
                freeze_control_audio_path,
                self.device,
                0.0,
                num_frames / frame_rate,
            )
            if decoded_audio is not None:
                preserved_audio = Audio(
                    waveform=decoded_audio.waveform.squeeze(0),
                    sampling_rate=decoded_audio.sampling_rate,
                )
                initial_audio_latent = self.audio_conditioner(
                    lambda enc: vae_encode_audio(decoded_audio, enc, None)
                )
                expected_audio_frames = AudioLatentShape.from_video_pixel_shape(stage_1_output_shape).frames
                initial_audio_latent = conform_latent_length(initial_audio_latent, expected_audio_frames)
            else:
                logging.warning(
                    "[IC-LoRA] Control video has no decodable audio; audio will be generated instead: %s",
                    freeze_control_audio_path,
                )

        video_state, audio_state = self.stage_1(
            denoiser=denoiser,
            sigmas=stage_1_sigmas,
            noiser=noiser,
            width=stage_1_output_shape.width,
            height=stage_1_output_shape.height,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(
                context=video_context,
                conditionings=stage_1_conditionings,
            ),
            audio=ModalitySpec(
                context=audio_context,
                frozen=initial_audio_latent is not None,
                noise_scale=_audio_noise_scale(initial_audio_latent),
                initial_latent=initial_audio_latent,
            ),
            stepper=stepper,
            loop=loop,
        )

        if self._official_comfy_workflow or skip_stage_2:
            logging.info(
                "[IC-LoRA] Decoding the official single-stage output"
                if self._official_comfy_workflow
                else "[IC-LoRA] Skipping Stage 2 (--skip-stage-2 enabled)"
            )
            decoded_video = self.video_decoder(video_state.latent, tiling_config, generator, dtype=vae_dtype)
            output_audio = preserved_audio or self.audio_decoder(audio_state.latent)
            return decoded_video, output_audio, tiling_config

        # Stage 2: Upsample and refine the video at higher resolution with distilled LORA.
        if self.upsampler is None or self.stage_2 is None:
            raise RuntimeError("IC-LoRA second-stage components were not initialized.")
        upscaled_video_latent = self.upsampler(video_state.latent[:1])

        stage_2_sigmas = stage_2_sigmas.to(dtype=torch.float32, device=self.device)
        stage_2_output_shape = VideoPixelShape(batch=1, frames=num_frames, width=width, height=height, fps=frame_rate)
        stage_2_conditionings = self.image_conditioner(
            lambda enc: combined_image_conditionings(
                images=images,
                height=stage_2_output_shape.height,
                width=stage_2_output_shape.width,
                video_encoder=enc,
                dtype=self.dtype,
                device=self.device,
                color_space=color_space,
            )
        )

        video_state, audio_state = self.stage_2(
            denoiser=SimpleDenoiser(video_context, audio_context),
            sigmas=stage_2_sigmas,
            noiser=noiser,
            width=width,
            height=height,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(
                context=video_context,
                conditionings=stage_2_conditionings,
                noise_scale=stage_2_sigmas[0].item(),
                initial_latent=upscaled_video_latent,
            ),
            audio=ModalitySpec(
                context=audio_context,
                noise_scale=stage_2_sigmas[0].item(),
                initial_latent=audio_state.latent,
            ),
        )

        decoded_video = self.video_decoder(video_state.latent, tiling_config, generator, dtype=vae_dtype)
        output_audio = preserved_audio or self.audio_decoder(audio_state.latent)
        return decoded_video, output_audio, tiling_config

    def _create_conditionings(
        self,
        images: list[ImageConditioningInput],
        video_conditioning: list[tuple[str, float]],
        height: int,
        width: int,
        num_frames: int,
        video_encoder: VideoEncoder,
        conditioning_attention_strength: float = 1.0,
        conditioning_attention_mask: torch.Tensor | None = None,
        repeat_static_video_conditioning: bool = False,
        color_space: HDRColorSpace | None = None,
    ) -> list[ConditioningItem]:
        """
        Create conditioning items for video generation.
        Args:
            conditioning_attention_strength: Scalar attention weight in [0, 1].
                If conditioning_attention_mask is also provided, the downsampled mask
                is multiplied by this strength. Otherwise this scalar is passed
                directly as the attention mask.
            conditioning_attention_mask: Optional pixel-space attention mask with shape
                (B, 1, F_pixel, H_pixel, W_pixel) matching the reference video's
                pixel dimensions. Downsampled to latent space with causal temporal
                handling, then multiplied by conditioning_attention_strength.
        Returns:
            List of conditioning items. IC-LoRA conditionings are appended last.
        """
        conditionings = combined_image_conditionings(
            images=images,
            height=height,
            width=width,
            video_encoder=video_encoder,
            dtype=self.dtype,
            device=self.device,
            color_space=color_space,
        )

        append_ic_lora_reference_video_conditionings(
            conditionings,
            video_conditioning,
            height=height,
            width=width,
            num_frames=num_frames,
            video_encoder=video_encoder,
            dtype=self.dtype,
            device=self.device,
            reference_downscale_factor=self.reference_downscale_factor,
            reference_temporal_scale_factor=self.reference_temporal_scale_factor,
            conditioning_attention_strength=conditioning_attention_strength,
            conditioning_attention_mask=conditioning_attention_mask,
            repeat_static_reference=repeat_static_video_conditioning,
            tiling_config=None,
            color_space=color_space,
        )

        if video_conditioning:
            logging.info("[IC-LoRA] Added %d video conditioning(s)", len(video_conditioning))

        return conditionings


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = default_2_stage_distilled_arg_parser(params=LTX_2_3_PARAMS)
    for action in parser._actions:
        if "--spatial-upsampler-path" in action.option_strings:
            action.required = False
        if "--distilled-checkpoint-path" in action.option_strings:
            # The alias must also live in argparse's option lookup; appending to
            # option_strings alone only changes the usage text.
            action.option_strings.append("--checkpoint-path")
            parser._option_string_actions["--checkpoint-path"] = action
    parser.add_argument(
        "--official-comfy-workflow",
        action="store_true",
        help="Use an official single-stage, eight-step LTX-2.3 IC-LoRA workflow.",
    )
    parser.add_argument(
        "--official-comfy-sampler",
        choices=("euler-ancestral-rf", "euler-ancestral-cfg-pp", "euler-cfg-pp"),
        default="euler-ancestral-rf",
        help=(
            "Sampler used by the selected official example. Native Union Control uses "
            "euler-ancestral-rf; Ingredients, Motion Track and V2V use euler-ancestral-cfg-pp; "
            "Pixel Spatial Upscaler uses euler-cfg-pp."
        ),
    )
    parser.add_argument(
        "--negative-prompt",
        type=str,
        default="",
        help="Negative prompt used by the official CFG++ IC-LoRA examples.",
    )
    parser.add_argument(
        "--repeat-static-control",
        action="store_true",
        help="Repeat a one-frame IC-LoRA reference across the full sequence, as in Ingredients.",
    )
    parser.add_argument(
        "--freeze-control-audio",
        type=str,
        default=None,
        help="Freeze and preserve the audio latent decoded from the selected source video.",
    )
    parser.add_argument(
        "--video-conditioning",
        action=VideoConditioningAction,
        nargs=2,
        metavar=("PATH", "STRENGTH"),
        required=True,
        help=(
            "IC-LoRA reference: video file (SDR) or directory of scene-linear *.exr frames (HDR), "
            "plus strength. Example: --video-conditioning ref.mp4 1.0  or  --video-conditioning exr_dir/ 1.0"
        ),
    )
    parser.add_argument(
        "--conditioning-attention-mask",
        action=VideoMaskConditioningAction,
        nargs=2,
        metavar=("MASK_PATH", "STRENGTH"),
        default=None,
        help=(
            "Optional spatial attention mask: path to a grayscale mask video and "
            "attention strength. The mask video pixel values in [0,1] control "
            "per-region conditioning attention strength. The strength scalar is "
            "multiplied with the spatial mask. "
            "0.0 = ignore IC-LoRA conditioning, 1.0 = full conditioning influence. "
            "When not provided, full conditioning strength (1.0) is used. "
            "Example: --conditioning-attention-mask path/to/mask.mp4 0.5"
        ),
    )
    parser.add_argument(
        "--skip-stage-2",
        action="store_true",
        help=(
            "Skip Stage 2 upsampling and refinement. Output will be at half resolution "
            "(height//2, width//2). Useful for faster iteration or when GPU memory is limited."
        ),
    )
    parser.add_argument(
        "--control-preprocessor",
        choices=("prepared", "depth", "canny", "pose"),
        default="prepared",
        help="Convert raw control videos to depth or Canny maps; prepared/pose inputs pass through unchanged.",
    )
    parser.add_argument(
        "--control-cache-dir",
        type=str,
        default=".ltx-control-cache",
        help="Persistent cache directory for deterministic control maps.",
    )
    parser.add_argument(
        "--moge-model-path",
        type=str,
        default=None,
        help="MoGe checkpoint required when --control-preprocessor=depth.",
    )
    parser.add_argument(
        "--comfy-root",
        type=str,
        default="/home/moddy/ComfyUI",
        help="ComfyUI root containing the native MoGe implementation.",
    )
    return parser


@torch.inference_mode()
def main() -> None:
    logging.basicConfig(level=logging.INFO)
    args = _build_arg_parser().parse_args()

    # Load mask video if provided via --conditioning-attention-mask
    conditioning_attention_mask = None
    conditioning_attention_strength = 1.0
    if args.conditioning_attention_mask is not None:
        mask_path, mask_strength = args.conditioning_attention_mask
        conditioning_attention_strength = mask_strength
        conditioning_attention_mask = _load_mask_video(
            mask_path=mask_path,
            height=args.height if args.official_comfy_workflow else args.height // 2,
            width=args.width if args.official_comfy_workflow else args.width // 2,
            num_frames=args.num_frames,
        )

    video_conditioning = [
        (
            preprocess_control_video(
                path,
                args.control_preprocessor,
                args.control_cache_dir,
                args.num_frames,
                moge_model_path=args.moge_model_path,
                comfy_root=args.comfy_root,
            ),
            strength,
        )
        for path, strength in args.video_conditioning
    ]

    pipeline = ICLoraPipeline(
        model_paths=args.model_paths,
        spatial_upsampler_path=args.spatial_upsampler_path,
        loras=tuple(args.lora) if args.lora else (),
        gemma_loras=tuple(args.gemma_lora) if args.gemma_lora else (),
        official_comfy_workflow=args.official_comfy_workflow,
        official_comfy_sampler=args.official_comfy_sampler,
        quantization=args.quantization,
        compilation_config=args.compile,
        offload_mode=args.offload_mode,
        prompt_enhancer_gemma_root=args.prompt_enhancer_gemma_root,
        diffvae_optimization=args.diffvae_optimization,
    )
    hdr = resolve_hdr_color_space(
        images=args.images,
        video_paths=[path for path, _ in args.video_conditioning],
        hdr=args.hdr,
    )
    vae_dtype = vae_dtype_for_hdr(hdr, torch.bfloat16)
    video, audio, tiling_config = pipeline(
        prompt=args.prompt,
        seed=args.seed,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        frame_rate=args.frame_rate,
        images=args.images,
        video_conditioning=video_conditioning,
        enhance_prompt=args.enhance_prompt,
        enhance_static_cache=args.enhance_static_cache,
        vae_dtype=vae_dtype,
        color_space=hdr,
        tiling_config=None if args.disable_tiling else AUTO_TILING,
        conditioning_attention_strength=conditioning_attention_strength,
        skip_stage_2=args.skip_stage_2,
        conditioning_attention_mask=conditioning_attention_mask,
        repeat_static_video_conditioning=args.repeat_static_control,
        freeze_control_audio_path=args.freeze_control_audio,
    )
    video_chunks_number = get_video_chunks_number(args.num_frames, tiling_config)

    encode_video(
        video=video,
        fps=args.frame_rate,
        audio=audio,
        output_path=args.output_path,
        video_chunks_number=video_chunks_number,
        color_space=hdr,
    )


def _load_mask_video(
    mask_path: str,
    height: int,
    width: int,
    num_frames: int,
) -> torch.Tensor:
    """Load a mask video and return a pixel-space tensor of shape (1, 1, F, H, W).
    The mask video is loaded, resized to (height, width), converted to
    grayscale, and normalised to [0, 1].
    Args:
        mask_path: Path to the mask video file.
        height: Target height in pixels.
        width: Target width in pixels.
        num_frames: Maximum number of frames to load.
    Returns:
        Tensor of shape ``(1, 1, F, H, W)`` with values in ``[0, 1]``.
    """
    device = get_device()
    frame_gen = decode_video_by_frame(path=mask_path, frame_cap=num_frames, device=device)
    mask_video = video_preprocess(frame_gen, height, width, torch.bfloat16, device)
    # mask_video shape: (1, C, F, H, W) — take mean over channels for grayscale
    mask = mask_video.mean(dim=1, keepdim=True)  # (1, 1, F, H, W)
    # Normalise to [0, 1] — video_preprocess applies normalize_latent,
    # so undo that: values are in [-1, 1], remap to [0, 1]
    mask = (mask + 1.0) / 2.0
    return mask.clamp(0.0, 1.0)


if __name__ == "__main__":
    main()
