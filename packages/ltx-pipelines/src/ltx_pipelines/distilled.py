import argparse
import logging
from collections.abc import Sequence
from functools import partial
from typing import Any, Literal, cast

import torch

from ltx_core.allocator_trim_strategy import AllocatorTrimStrategy
from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep, EulerDiffusionStep
from ltx_core.components.noisers import GaussianNoiser
from ltx_core.loader import LoraPathStrengthAndSDOps
from ltx_core.loader.registry import Registry
from ltx_core.model.transformer.compiling import CompilationConfig
from ltx_core.model.video_vae import AUTO_TILING, AutoTiling, TilingConfig, get_video_chunks_number
from ltx_core.model.video_vae.keyframes import DecodeKeyframes
from ltx_core.model.video_vae.transformer import DiffVAEMode
from ltx_core.quantization import QuantizationPolicy
from ltx_core.types import VideoPixelShape
from ltx_pipelines.utils.args import (
    ImageConditioningInput,
    add_generated_keyframes_arg,
    default_2_stage_distilled_arg_parser,
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
    detect_model_version,
)
from ltx_pipelines.utils.denoisers import SimpleDenoiser
from ltx_pipelines.utils.helpers import (
    assert_resolution,
    combined_image_conditionings,
    decode_keyframes_from_slots,
    ensure_tiling_config,
    generated_keyframe_conditionings,
    get_device,
    has_generated_keyframes,
    resolve_generated_keyframes,
    tiling_scale_factors_for_vae,
)
from ltx_pipelines.utils.media_io import (
    HDRColorSpace,
    encode_video,
    resolve_hdr_color_space,
    vae_dtype_for_hdr,
)
from ltx_pipelines.utils.model_paths import ModelPaths
from ltx_pipelines.utils.samplers import euler_ancestral_denoising_loop, euler_denoising_loop
from ltx_pipelines.utils.types import DEFAULT_AUTO_DURATION, AutoDuration, ModalitySpec, OffloadMode, PipelineOutput

# Generation from which stage 1 is sampled with the ancestral (SDE) Euler sampler instead of the
# deterministic one.
ANCESTRAL_SAMPLER_SINCE_VERSION = (2, 5)

# Fully ancestral noise injection: eta=0 is a plain Euler step, eta=1 injects the full
# variance-preserving amount at every step.
ANCESTRAL_ETA = 1.0
ANCESTRAL_S_NOISE = 1.0

# The loop's noise generator is seeded from the pipeline seed plus this offset. Without it the
# loop's first draw would be bit-identical to the initial latent noise: GaussianNoiser and the
# loop's ``_get_plain_noise`` both draw ``torch.randn`` at the same shape, dtype, and device from a
# freshly seeded generator. Mirrors the substep-seed offset in ``res2s_audio_video_denoising_loop``.
ANCESTRAL_NOISE_SEED_OFFSET = 10000

DistilledSamplerProfile = Literal["native", "official-comfy"]
DISTILLED_SAMPLER_PROFILES: tuple[DistilledSamplerProfile, ...] = ("native", "official-comfy")


def _validate_sampler_profile(profile: str) -> DistilledSamplerProfile:
    if profile not in DISTILLED_SAMPLER_PROFILES:
        choices = ", ".join(DISTILLED_SAMPLER_PROFILES)
        raise ValueError(f"Unsupported distilled sampler profile {profile!r}; expected one of: {choices}")
    return cast(DistilledSamplerProfile, profile)


def _distilled_stage_1_sampler_kwargs(
    *,
    profile: DistilledSamplerProfile,
    use_native_ancestral_sampler: bool,
    seed: int,
    model_input_dtype: torch.dtype,
) -> dict[str, Any]:
    """Resolve stage-1 sampler overrides without loading model weights.

    ``native`` preserves the checkpoint-generation behavior that predates the explicit profile:
    old checkpoints use :class:`DiffusionStage` defaults, while LTX 2.5+ uses BF16 ancestral
    sampling with the historical substep seed offset. ``official-comfy`` instead pins the
    published plain RF Euler ancestral sampler to the user seed and keeps its trajectory in FP32,
    casting only the transformer-bound latent to the BF16 model dtype.

    The official profile is an effective-contract match, not a bit-identity claim: the native
    pipeline and ComfyUI create their initial noise on different devices.
    """
    profile = _validate_sampler_profile(profile)
    if profile == "official-comfy":
        return {
            "state_dtype": torch.float32,
            "stepper": EulerAncestralDiffusionStep(eta=ANCESTRAL_ETA, s_noise=ANCESTRAL_S_NOISE),
            "loop": partial(
                euler_ancestral_denoising_loop,
                noise_seed=seed,
                model_dtype=torch.float32,
                model_input_dtype=model_input_dtype,
            ),
        }
    if not use_native_ancestral_sampler:
        return {}
    return {
        "stepper": EulerAncestralDiffusionStep(eta=ANCESTRAL_ETA, s_noise=ANCESTRAL_S_NOISE),
        "loop": partial(
            euler_ancestral_denoising_loop,
            noise_seed=seed + ANCESTRAL_NOISE_SEED_OFFSET,
            model_dtype=model_input_dtype,
        ),
    }


def _distilled_stage_1_schedule(
    *,
    profile: DistilledSamplerProfile,
    requested: torch.Tensor,
) -> torch.Tensor:
    """Return the caller's native schedule or the fixed official Comfy 8-step schedule."""
    profile = _validate_sampler_profile(profile)
    return DISTILLED_SIGMAS if profile == "official-comfy" else requested


def _distilled_stage_2_schedule(
    *,
    profile: DistilledSamplerProfile,
    requested: torch.Tensor,
    noiser: GaussianNoiser,
    device: torch.device,
) -> tuple[torch.Tensor, GaussianNoiser]:
    """Resolve stage 2; its sampler remains deterministic Euler for both profiles."""
    profile = _validate_sampler_profile(profile)
    if profile == "native":
        return requested, noiser
    generator = torch.Generator(device=device).manual_seed(OFFICIAL_COMFY_STAGE_2_SEED)
    return OFFICIAL_COMFY_STAGE_2_SIGMAS, GaussianNoiser(generator=generator)


def _distilled_stage_2_sampler_kwargs(
    *,
    profile: DistilledSamplerProfile,
    model_input_dtype: torch.dtype = torch.bfloat16,
) -> dict[str, Any]:
    """Pin deterministic Euler explicitly for Comfy while leaving native defaults untouched."""
    profile = _validate_sampler_profile(profile)
    if profile == "native":
        return {}
    return {
        "state_dtype": torch.float32,
        "stepper": EulerDiffusionStep(),
        "loop": partial(
            euler_denoising_loop,
            model_dtype=torch.float32,
            model_input_dtype=model_input_dtype,
        ),
    }


def add_distilled_sampler_profile_arg(parser: argparse.ArgumentParser) -> argparse.ArgumentParser:
    """Add the explicit sampler-contract selector while retaining the native default."""
    parser.add_argument(
        "--sampler-profile",
        choices=DISTILLED_SAMPLER_PROFILES,
        default="native",
        help=(
            "Sampler contract: native preserves checkpoint-dependent behavior; official-comfy "
            "pins the published LTX-2.5 8+3 schedules, stage seeds, and FP32 sampler trajectory."
        ),
    )
    return parser


def distilled_single_stage_keyframes(
    generated_latents: torch.Tensor | None,
    generated_keyframes: int | Sequence[int],
    num_frames: int,
) -> DecodeKeyframes | None:
    """Expose generated slots when the distilled preview already uses the final canvas."""
    return decode_keyframes_from_slots(
        generated_latents,
        resolve_generated_keyframes(generated_keyframes, num_frames),
        num_frames,
    )


def should_use_ancestral_sampler(transformer_path: str) -> bool:
    """Whether a checkpoint's generation calls for the ancestral stage-1 sampler.
    Takes the transformer checkpoint (``ModelPaths.transformer()``) since that is the component
    carrying ``model_version`` in both the monolith and split layouts.
    This is what :class:`DistilledPipeline` resolves at construction into
    ``self.use_ancestral_sampler``; a named function rather than an inline comparison so the rule
    can be tested, and reused, without loading a checkpoint's weights.
    """
    return detect_model_version(transformer_path) >= ANCESTRAL_SAMPLER_SINCE_VERSION


def distilled_stage_1_resolution(*, height: int, width: int, skip_stage_2: bool) -> tuple[int, int]:
    """Validate the selected official layout and return stage-1 ``(width, height)``."""
    assert_resolution(height=height, width=width, is_two_stage=not skip_stage_2)
    return (width, height) if skip_stage_2 else (width // 2, height // 2)


class DistilledPipeline:
    """
    Distilled video generation pipeline with official single- and two-stage layouts.
    Two-stage generation starts at half resolution, then spatially upsamples and refines.
    Single-stage generation samples and decodes directly at the requested resolution.
    """

    def __init__(  # noqa: PLR0913, PLR0917
        self,
        model_paths: ModelPaths,
        spatial_upsampler_path: str | None,
        loras: list[LoraPathStrengthAndSDOps],
        device: torch.device | None = None,
        quantization: QuantizationPolicy | None = None,
        registry: Registry | None = None,
        compilation_config: CompilationConfig | None = None,
        offload_mode: OffloadMode = OffloadMode.NONE,
        alloc_trim_strategy: AllocatorTrimStrategy = AllocatorTrimStrategy.TRIM,
        prompt_enhancer_gemma_root: str | None = None,
        diffvae_optimization: DiffVAEMode = DiffVAEMode.CHUNKED_EAGER,
        sampler_profile: DistilledSamplerProfile = "native",
    ):
        self.sampler_profile = _validate_sampler_profile(sampler_profile)
        self.device = device or get_device()
        self.dtype = torch.bfloat16

        self.prompt_encoder = PromptEncoder(
            model_paths,
            self.dtype,
            self.device,
            registry=registry,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
            prompt_enhancer_gemma_root=prompt_enhancer_gemma_root,
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
            loras=tuple(loras),
            quantization=quantization,
            registry=registry,
            compilation_config=compilation_config,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.upsampler = (
            VideoUpsampler(
                model_paths.video_vae(),
                spatial_upsampler_path,
                self.dtype,
                self.device,
                registry=registry,
                alloc_trim_strategy=alloc_trim_strategy,
            )
            if spatial_upsampler_path is not None
            else None
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
        self.use_ancestral_sampler = should_use_ancestral_sampler(model_paths.transformer())

    def _stage_1_sampler_kwargs(self, seed: int) -> dict[str, Any]:
        """Resolve stage 1's ``stepper`` / ``loop`` overrides for :class:`DiffusionStage`.
        Returns an empty dict for the deterministic sampler, letting ``DiffusionStage`` apply its
        own ``EulerDiffusionStep`` + ``euler_denoising_loop`` defaults rather than restating them.
        """
        return _distilled_stage_1_sampler_kwargs(
            profile=self.sampler_profile,
            use_native_ancestral_sampler=self.use_ancestral_sampler,
            seed=seed,
            model_input_dtype=self.dtype,
        )

    def __call__(  # noqa: PLR0913, PLR0917
        self,
        prompt: str,
        seed: int,
        height: int,
        width: int,
        frame_rate: float,
        images: list[ImageConditioningInput],
        num_frames: int | AutoDuration = DEFAULT_AUTO_DURATION,
        vae_dtype: torch.dtype | None = None,
        tiling_config: TilingConfig | AutoTiling | None = AUTO_TILING,
        enhance_prompt: bool = False,
        enhance_static_cache: bool = False,
        stage_1_sigmas: torch.Tensor = DISTILLED_SIGMAS,
        stage_2_sigmas: torch.Tensor = STAGE_2_DISTILLED_SIGMAS,
        color_space: HDRColorSpace | None = None,
        generated_keyframes: int | Sequence[int] = 0,
        skip_stage_2: bool = False,
    ) -> PipelineOutput:
        """Generate a video.
        Under the native profile, stage 1 selects ancestral (SDE) Euler or deterministic Euler from
        the detected checkpoint generation. The explicit official-Comfy profile pins ancestral
        stage 1 independently of that detection. With ``skip_stage_2=True`` stage 1 runs at output
        resolution and is decoded directly. Otherwise, stage 2 is always deterministic -- its
        3-step refinement schedule is too short to remove freshly injected noise.
        """
        require_num_frames_source(num_frames, self.duration_predictor)
        if not skip_stage_2 and self.upsampler is None:
            raise ValueError("Two-stage distilled generation requires a spatial upsampler.")
        images = self.image_conditioner.resolve_crf(images)
        stage_1_w, stage_1_h = distilled_stage_1_resolution(
            height=height,
            width=width,
            skip_stage_2=skip_stage_2,
        )
        if has_generated_keyframes(generated_keyframes):
            self.stage.assert_generated_keyframes_supported()

        generator = torch.Generator(device=self.device).manual_seed(seed)
        noiser = GaussianNoiser(generator=generator)
        dtype = torch.bfloat16
        if vae_dtype is None:
            vae_dtype = dtype

        (ctx_p,) = self.prompt_encoder(
            [prompt],
            enhance_first_prompt=enhance_prompt,
            enhance_static_cache=enhance_static_cache,
            enhance_prompt_image=images[0][0] if len(images) > 0 else None,
        )
        video_context, audio_context = ctx_p.video_encoding, ctx_p.audio_encoding

        num_frames = resolve_num_frames(
            num_frames,
            self.duration_predictor,
            video_encoding=video_context,
            audio_encoding=audio_context,
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

        # Stage 1: full resolution for the official preview graph, half resolution otherwise.
        stage_1_sigmas = _distilled_stage_1_schedule(
            profile=self.sampler_profile,
            requested=stage_1_sigmas,
        ).to(dtype=torch.float32, device=self.device)
        stage_1_conditionings = self.image_conditioner(
            lambda enc: combined_image_conditionings(
                images=images,
                height=stage_1_h,
                width=stage_1_w,
                video_encoder=enc,
                dtype=dtype,
                device=self.device,
                color_space=color_space,
            )
        )
        stage_1_conditionings.extend(generated_keyframe_conditionings(generated_keyframes, num_frames))

        video_state, audio_state = self.stage(
            denoiser=SimpleDenoiser(video_context, audio_context),
            sigmas=stage_1_sigmas,
            noiser=noiser,
            width=stage_1_w,
            height=stage_1_h,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(context=video_context, conditionings=stage_1_conditionings),
            audio=ModalitySpec(context=audio_context),
            **self._stage_1_sampler_kwargs(seed),
        )

        if skip_stage_2:
            decoded_video = self.video_decoder(video_state.latent, tiling_config, generator, dtype=vae_dtype)
            decoded_audio = self.audio_decoder(audio_state.latent)
            keyframes = distilled_single_stage_keyframes(
                video_state.generated_keyframes,
                generated_keyframes,
                num_frames,
            )
            return PipelineOutput(
                decoded_video, decoded_audio, num_frames, tiling_config, keyframes, video_state.latent
            )

        # Stage 2: Upsample and refine the video at higher resolution with distilled LORA.
        assert self.upsampler is not None
        upscaled_video_latent = self.upsampler(video_state.latent[:1])

        stage_2_sigmas, stage_2_noiser = _distilled_stage_2_schedule(
            profile=self.sampler_profile,
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

        video_state, audio_state = self.stage(
            denoiser=SimpleDenoiser(video_context, audio_context),
            sigmas=stage_2_sigmas,
            noiser=stage_2_noiser,
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
            **_distilled_stage_2_sampler_kwargs(
                profile=self.sampler_profile,
                model_input_dtype=self.dtype,
            ),
        )

        decoded_video = self.video_decoder(video_state.latent, tiling_config, generator, dtype=vae_dtype)
        decoded_audio = self.audio_decoder(audio_state.latent)
        return PipelineOutput(decoded_video, decoded_audio, num_frames, tiling_config, None, video_state.latent)


@torch.inference_mode()
def main() -> None:
    logging.basicConfig(level=logging.INFO)
    params = resolve_cli_params(distilled=True)
    parser = add_distilled_sampler_profile_arg(
        add_generated_keyframes_arg(default_2_stage_distilled_arg_parser(params=params, supports_auto_duration=True))
    )
    for action in parser._actions:
        if "--spatial-upsampler-path" in action.option_strings:
            action.required = False
            action.help = "Spatial upsampler for two-stage output; omit only with --skip-stage-2."
    parser.add_argument(
        "--skip-stage-2",
        action="store_true",
        help="Run the official single-stage distilled preview at the requested resolution.",
    )
    args = parser.parse_args()
    if not args.skip_stage_2 and args.spatial_upsampler_path is None:
        parser.error("--spatial-upsampler-path is required unless --skip-stage-2 is selected")
    pipeline = DistilledPipeline(
        model_paths=args.model_paths,
        spatial_upsampler_path=args.spatial_upsampler_path,
        loras=tuple(args.lora) if args.lora else (),
        quantization=args.quantization,
        compilation_config=args.compile,
        offload_mode=args.offload_mode,
        prompt_enhancer_gemma_root=args.prompt_enhancer_gemma_root,
        diffvae_optimization=args.diffvae_optimization,
        sampler_profile=args.sampler_profile,
    )
    hdr = resolve_hdr_color_space(images=args.images, hdr=args.hdr)
    vae_dtype = vae_dtype_for_hdr(hdr, torch.bfloat16)
    result = pipeline(
        prompt=args.prompt,
        seed=args.seed,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        frame_rate=args.frame_rate,
        images=args.images,
        vae_dtype=vae_dtype,
        color_space=hdr,
        enhance_prompt=args.enhance_prompt,
        enhance_static_cache=args.enhance_static_cache,
        tiling_config=None if args.disable_tiling else AUTO_TILING,
        generated_keyframes=args.num_generated_keyframes,
        skip_stage_2=args.skip_stage_2,
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
