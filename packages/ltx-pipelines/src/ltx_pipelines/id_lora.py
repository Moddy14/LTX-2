"""Official-style LTX-2.3 ID-LoRA pipeline for person and voice identity transfer."""

from __future__ import annotations

import argparse
import logging
from collections.abc import Iterator

import torch

from ltx_core.components.noisers import GaussianNoiser
from ltx_core.conditioning import AudioConditionByReferenceLatent, ConditioningItem
from ltx_core.loader import LoraPathStrengthAndSDOps
from ltx_core.loader.registry import Registry
from ltx_core.model.audio_vae import encode_audio as vae_encode_audio
from ltx_core.model.transformer import X0Model
from ltx_core.model.transformer.compiling import CompilationConfig
from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
from ltx_core.quantization import QuantizationPolicy
from ltx_core.types import Audio, LatentState, VideoPixelShape
from ltx_pipelines.lipdub import patchify_lipdub_audio_reference_latent
from ltx_pipelines.utils.allocator_trim_strategy import AllocatorTrimStrategy
from ltx_pipelines.utils.args import (
    ImageConditioningInput,
    LoraAction,
    default_2_stage_arg_parser,
    resolve_cli_params,
    resolve_existing_path,
)
from ltx_pipelines.utils.blocks import (
    AudioConditioner,
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
)
from ltx_pipelines.utils.denoisers import SimpleDenoiser
from ltx_pipelines.utils.helpers import (
    assert_resolution,
    cap_image_conditioning_strength,
    combined_image_conditionings,
    get_device,
    modality_from_latent_state,
)
from ltx_pipelines.utils.media_io import decode_audio_from_file, encode_video
from ltx_pipelines.utils.types import DenoisedLatentResult, ModalitySpec, OffloadMode

_COMFY_LTX_SIGMA_SHIFT = 2.37


def _identity_guidance_sigma(percent: float) -> float:
    """Mirror ComfyUI ModelSamplingDiscreteFlow.percent_to_sigma for LTX."""
    if percent <= 0.0:
        return 1.0
    if percent >= 1.0:
        return 0.0
    timestep = 1.0 - percent
    return (
        _COMFY_LTX_SIGMA_SHIFT
        * timestep
        / (1.0 + (_COMFY_LTX_SIGMA_SHIFT - 1.0) * timestep)
    )


def _without_reference_audio(state: LatentState, reference_tokens: int) -> LatentState:
    """Remove appended reference tokens for the identity-guidance comparison pass."""
    if reference_tokens <= 0 or reference_tokens >= state.latent.shape[1]:
        raise ValueError("Reference audio token count does not match the conditioned audio state.")
    target_tokens = state.latent.shape[1] - reference_tokens
    attention_mask = state.attention_mask
    if attention_mask is not None:
        attention_mask = attention_mask[:, :target_tokens, :target_tokens]
    return LatentState(
        latent=state.latent[:, :target_tokens],
        denoise_mask=state.denoise_mask[:, :target_tokens],
        positions=state.positions[:, :, :target_tokens],
        clean_latent=state.clean_latent[:, :target_tokens],
        attention_mask=attention_mask,
    )


class IdentityGuidedDenoiser:
    """Apply the Comfy LTXVReferenceAudio identity-guidance equation natively."""

    def __init__(
        self,
        video_context: torch.Tensor,
        audio_context: torch.Tensor,
        reference_tokens: int,
        scale: float = 3.0,
        start_percent: float = 0.0,
        end_percent: float = 1.0,
    ) -> None:
        self.video_context = video_context
        self.audio_context = audio_context
        self.reference_tokens = reference_tokens
        self.scale = scale
        self.start_percent = start_percent
        self.end_percent = end_percent

    def __call__(
        self,
        transformer: X0Model,
        video_state: LatentState | None,
        audio_state: LatentState | None,
        sigmas: torch.Tensor,
        step_index: int,
    ) -> tuple[DenoisedLatentResult | None, DenoisedLatentResult | None]:
        if video_state is None or audio_state is None:
            raise ValueError("ID-LoRA requires both video and audio latent states.")

        sigma = sigmas[step_index]
        video_modality = modality_from_latent_state(video_state, self.video_context, sigma)
        audio_modality = modality_from_latent_state(audio_state, self.audio_context, sigma)
        conditioned_video, conditioned_audio = transformer(
            video=video_modality,
            audio=audio_modality,
            perturbations=None,
        )

        sigma_value = float(sigma.item())
        sigma_start = _identity_guidance_sigma(self.start_percent)
        sigma_end = _identity_guidance_sigma(self.end_percent)
        active = self.scale != 0 and sigma_end <= sigma_value <= sigma_start
        if not active:
            return (
                DenoisedLatentResult.result_or_none(denoised=conditioned_video),
                DenoisedLatentResult.result_or_none(denoised=conditioned_audio),
            )

        no_reference_audio_state = _without_reference_audio(audio_state, self.reference_tokens)
        no_reference_audio = modality_from_latent_state(no_reference_audio_state, self.audio_context, sigma)
        no_reference_video, no_reference_audio_output = transformer(
            video=video_modality,
            audio=no_reference_audio,
            perturbations=None,
        )

        target_audio_tokens = no_reference_audio_state.latent.shape[1]
        guided_video = conditioned_video + (conditioned_video - no_reference_video) * self.scale
        guided_audio_target = conditioned_audio[:, :target_audio_tokens] + (
            conditioned_audio[:, :target_audio_tokens] - no_reference_audio_output
        ) * self.scale
        guided_audio = torch.cat(
            [guided_audio_target, conditioned_audio[:, target_audio_tokens:]],
            dim=1,
        )
        return (
            DenoisedLatentResult.result_or_none(
                denoised=guided_video,
                cond=conditioned_video,
            ),
            DenoisedLatentResult.result_or_none(
                denoised=guided_audio,
                cond=conditioned_audio,
            ),
        )


class IDLoraPipeline:
    """Two-stage image-to-video with TalkVid person and speaker identity."""

    def __init__(  # noqa: PLR0913
        self,
        checkpoint_path: str,
        distilled_lora: tuple[LoraPathStrengthAndSDOps, ...],
        id_lora: LoraPathStrengthAndSDOps,
        spatial_upsampler_path: str,
        gemma_root: str,
        loras: tuple[LoraPathStrengthAndSDOps, ...] = (),
        device: torch.device | None = None,
        quantization: QuantizationPolicy | None = None,
        registry: Registry | None = None,
        compilation_config: CompilationConfig | None = None,
        offload_mode: OffloadMode = OffloadMode.NONE,
        alloc_trim_strategy: AllocatorTrimStrategy = AllocatorTrimStrategy.TRIM,
    ) -> None:
        self.device = device or get_device()
        self.dtype = torch.bfloat16
        self.prompt_encoder = PromptEncoder(
            checkpoint_path,
            gemma_root,
            self.dtype,
            self.device,
            registry=registry,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.image_conditioner = ImageConditioner(
            checkpoint_path,
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.audio_conditioner = AudioConditioner(
            checkpoint_path,
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.stage_1 = DiffusionStage.from_checkpoint(
            checkpoint_path,
            self.dtype,
            self.device,
            loras=(*loras, *distilled_lora, id_lora),
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
            loras=(*loras, *distilled_lora),
            quantization=quantization,
            registry=registry,
            compilation_config=compilation_config,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
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
            checkpoint_path,
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.audio_decoder = AudioDecoder(
            checkpoint_path,
            self.dtype,
            self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )

    def _reference_audio_conditioning(
        self,
        reference_audio_path: str,
    ) -> tuple[AudioConditionByReferenceLatent, int]:
        audio = decode_audio_from_file(reference_audio_path, self.device)
        if audio is None:
            raise ValueError(f"No audio stream found in {reference_audio_path}")
        latent = self.audio_conditioner(lambda encoder: vae_encode_audio(audio, encoder, None))
        patchified, positions = patchify_lipdub_audio_reference_latent(
            latent,
            negative_positions=True,
            device=self.device,
        )
        return AudioConditionByReferenceLatent(patchified, positions, strength=1.0), patchified.shape[1]

    def _image_conditionings(
        self,
        images: list[ImageConditioningInput],
        height: int,
        width: int,
        strength_override: float | None = None,
    ) -> list[ConditioningItem]:
        stage_images = images
        if strength_override is not None:
            stage_images = [
                image._replace(strength=min(image.strength, strength_override))
                for image in images
            ]
        return self.image_conditioner(
            lambda encoder: combined_image_conditionings(
                images=stage_images,
                height=height,
                width=width,
                video_encoder=encoder,
                dtype=self.dtype,
                device=self.device,
            )
        )

    @torch.inference_mode()
    def __call__(  # noqa: PLR0913
        self,
        prompt: str,
        reference_audio_path: str,
        seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        images: list[ImageConditioningInput],
        identity_guidance_scale: float = 3.0,
        identity_guidance_start: float = 0.0,
        identity_guidance_end: float = 1.0,
        stage_1_image_strength: float = 0.7,
        tiling_config: TilingConfig | None = None,
    ) -> tuple[Iterator[torch.Tensor], Audio]:
        assert_resolution(height=height, width=width, is_two_stage=True)
        if not images:
            raise ValueError("ID-LoRA requires a reference image.")

        generator = torch.Generator(device=self.device).manual_seed(seed)
        noiser = GaussianNoiser(generator=generator)
        (context,) = self.prompt_encoder([prompt], enhance_first_prompt=False)
        video_context = context.video_encoding
        audio_context = context.audio_encoding
        reference_conditioning, reference_tokens = self._reference_audio_conditioning(reference_audio_path)

        stage_1_shape = VideoPixelShape(
            batch=1,
            frames=num_frames,
            height=height // 2,
            width=width // 2,
            fps=frame_rate,
        )
        stage_1_conditionings = self._image_conditionings(
            cap_image_conditioning_strength(images, stage_1_image_strength),
            stage_1_shape.height,
            stage_1_shape.width,
        )
        stage_1_sigmas = DISTILLED_SIGMAS.to(dtype=torch.float32, device=self.device)
        video_state, audio_state = self.stage_1(
            denoiser=IdentityGuidedDenoiser(
                video_context,
                audio_context,
                reference_tokens,
                scale=identity_guidance_scale,
                start_percent=identity_guidance_start,
                end_percent=identity_guidance_end,
            ),
            sigmas=stage_1_sigmas,
            noiser=noiser,
            width=stage_1_shape.width,
            height=stage_1_shape.height,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(context=video_context, conditionings=stage_1_conditionings),
            audio=ModalitySpec(context=audio_context, conditionings=[reference_conditioning]),
        )
        if video_state is None or audio_state is None:
            raise RuntimeError("ID-LoRA stage 1 did not produce both modalities.")

        stage_1_audio_latent = audio_state.latent.clone()
        upscaled_video_latent = self.upsampler(video_state.latent)
        stage_2_conditionings = self._image_conditionings(
            images,
            height,
            width,
        )
        stage_2_sigmas = OFFICIAL_COMFY_STAGE_2_SIGMAS.to(dtype=torch.float32, device=self.device)
        stage_2_generator = torch.Generator(device=self.device).manual_seed(
            OFFICIAL_COMFY_STAGE_2_SEED
        )
        stage_2_noiser = GaussianNoiser(generator=stage_2_generator)
        video_state, _ = self.stage_2(
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
                conditionings=[reference_conditioning],
                frozen=True,
                noise_scale=0.0,
                initial_latent=stage_1_audio_latent,
            ),
        )
        if video_state is None:
            raise RuntimeError("ID-LoRA stage 2 did not produce video.")

        video = self.video_decoder(video_state.latent, tiling_config, generator)
        audio = self.audio_decoder(stage_1_audio_latent)
        return video, audio


def id_lora_arg_parser() -> argparse.ArgumentParser:
    params = resolve_cli_params()
    parser = default_2_stage_arg_parser(params=params)
    parser.add_argument(
        "--reference-audio-path",
        type=resolve_existing_path,
        required=True,
        help="Short clean speaker-reference audio; about five seconds is recommended.",
    )
    parser.add_argument(
        "--id-lora",
        dest="id_lora",
        action=LoraAction,
        nargs="+",
        metavar=("PATH", "STRENGTH"),
        required=True,
        help="Official LTX-2.3 TalkVid ID-LoRA path and optional strength.",
    )
    parser.add_argument("--identity-guidance-scale", type=float, default=3.0)
    parser.add_argument("--identity-guidance-start", type=float, default=0.0)
    parser.add_argument("--identity-guidance-end", type=float, default=1.0)
    parser.add_argument(
        "--stage-1-image-strength",
        type=float,
        default=0.7,
        help="Reference-image strength in the low-resolution first stage (official workflow: 0.7).",
    )
    return parser


@torch.inference_mode()
def main() -> None:
    logging.basicConfig(level=logging.INFO)
    args = id_lora_arg_parser().parse_args()
    if len(args.id_lora) != 1:
        raise ValueError("ID-LoRA requires exactly one --id-lora model.")
    if not 0 <= args.identity_guidance_start <= args.identity_guidance_end <= 1:
        raise ValueError("Identity guidance requires 0 <= start <= end <= 1.")

    pipeline = IDLoraPipeline(
        checkpoint_path=args.checkpoint_path,
        distilled_lora=tuple(args.distilled_lora),
        id_lora=args.id_lora[0],
        spatial_upsampler_path=args.spatial_upsampler_path,
        gemma_root=args.gemma_root,
        loras=tuple(args.lora),
        quantization=args.quantization,
        compilation_config=args.compile,
        offload_mode=args.offload_mode,
    )
    tiling_config = None if args.disable_tiling else TilingConfig.default()
    video, audio = pipeline(
        prompt=args.prompt,
        reference_audio_path=args.reference_audio_path,
        seed=args.seed,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        frame_rate=args.frame_rate,
        images=args.images,
        identity_guidance_scale=args.identity_guidance_scale,
        identity_guidance_start=args.identity_guidance_start,
        identity_guidance_end=args.identity_guidance_end,
        stage_1_image_strength=args.stage_1_image_strength,
        tiling_config=tiling_config,
    )
    encode_video(
        video=video,
        fps=args.frame_rate,
        audio=audio,
        output_path=args.output_path,
        video_chunks_number=get_video_chunks_number(args.num_frames, tiling_config),
    )


if __name__ == "__main__":
    main()
