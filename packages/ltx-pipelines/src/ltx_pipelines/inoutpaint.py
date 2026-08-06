"""Official LTX-2.3 two-stage IC-LoRA inpainting and outpainting.

This native pipeline mirrors the published ComfyUI examples:

* Dev checkpoint with Distilled LoRA 1.1 at 0.5 and In/Outpainting IC-LoRA at 1.0
* ``#66FF00`` masked reference conditioning
* eight-step ancestral CFG++ sampling at half resolution
* Laplacian-pyramid preservation blend before the second stage
* deterministic CFG++ refinement at full resolution with sigmas
  ``[0.725, 0.421875, 0]``
* final Laplacian-pyramid blend and frozen source audio
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from functools import partial
from pathlib import Path
from typing import Literal

import torch

from ltx_core.components.diffusion_steps import EulerCfgPpDiffusionStep
from ltx_core.components.guiders import MultiModalGuiderParams, create_multimodal_guider_factory
from ltx_core.components.noisers import GaussianNoiser
from ltx_core.conditioning import ConditioningItem, VideoConditionByLatentIndex
from ltx_core.loader import LoraPathStrengthAndSDOps
from ltx_core.model.audio_vae import encode_audio as vae_encode_audio
from ltx_core.model.video_vae import TilingConfig, VideoEncoder
from ltx_core.types import Audio, AudioLatentShape, VideoPixelShape
from ltx_pipelines.iclora_utils import append_ic_lora_reference_tensor_conditioning
from ltx_pipelines.utils.allocator_trim_strategy import AllocatorTrimStrategy
from ltx_pipelines.utils.args import basic_arg_parser, resolve_cli_params, resolve_existing_path
from ltx_pipelines.utils.blocks import (
    AudioConditioner,
    AudioDecoder,
    DiffusionStage,
    ImageConditioner,
    PromptEncoder,
    VideoDecoder,
)
from ltx_pipelines.utils.constants import DISTILLED_SIGMAS
from ltx_pipelines.utils.denoisers import FactoryGuidedDenoiser
from ltx_pipelines.utils.helpers import assert_resolution, conform_latent_length, get_device
from ltx_pipelines.utils.inpaint import (
    dilate_video_mask,
    green_screen_inpaint,
    laplacian_pyramid_blend,
    resize_video,
)
from ltx_pipelines.utils.media_io import (
    decode_audio_from_file,
    decode_video_by_frame,
    encode_video,
    video_preprocess,
)
from ltx_pipelines.utils.samplers import euler_cfg_pp_denoising_loop
from ltx_pipelines.utils.types import ModalitySpec, OffloadMode

logger = logging.getLogger(__name__)

InOutMode = Literal["inpaint", "outpaint"]
STAGE_2_SIGMAS = torch.tensor([0.725, 0.421875, 0.0])


def _conform_pixel_frames(video: torch.Tensor, num_frames: int) -> torch.Tensor:
    if video.shape[2] >= num_frames:
        return video[:, :, :num_frames]
    if video.shape[2] == 0:
        raise ValueError("The source contains no decodable video frames.")
    return torch.cat(
        [video, video[:, :, -1:].expand(-1, -1, num_frames - video.shape[2], -1, -1)],
        dim=2,
    )


def _load_video_vae_range(
    path: str,
    *,
    height: int,
    width: int,
    num_frames: int,
    dtype: torch.dtype,
    device: torch.device,
) -> torch.Tensor:
    frames = decode_video_by_frame(path=path, frame_cap=num_frames, device=device)
    return _conform_pixel_frames(
        video_preprocess(frames, height, width, dtype, device),
        num_frames,
    )


def _load_mask(
    path: str,
    *,
    height: int,
    width: int,
    num_frames: int,
    device: torch.device,
) -> torch.Tensor:
    frames = decode_video_by_frame(path=path, frame_cap=num_frames, device=device)
    mask = video_preprocess(frames, height, width, torch.float32, device)
    mask = _conform_pixel_frames(mask, num_frames).mean(dim=1, keepdim=True)
    return ((mask + 1) / 2).clamp(0, 1)


def _center_pad_outpaint_source(
    source_path: str,
    *,
    height: int,
    width: int,
    num_frames: int,
    dtype: torch.dtype,
    device: torch.device,
) -> tuple[torch.Tensor, torch.Tensor]:
    frames = list(decode_video_by_frame(path=source_path, frame_cap=num_frames, device=device))
    if not frames:
        raise ValueError("The source contains no decodable video frames.")
    raw = torch.cat(frames, dim=0).permute(0, 3, 1, 2).float() / 255
    source_height, source_width = raw.shape[-2:]
    if source_height > height or source_width > width:
        scale = min(height / source_height, width / source_width)
        fitted_height = max(1, round(source_height * scale))
        fitted_width = max(1, round(source_width * scale))
        raw = torch.nn.functional.interpolate(
            raw,
            size=(fitted_height, fitted_width),
            mode="bilinear",
            align_corners=False,
        )
    fitted_height, fitted_width = raw.shape[-2:]
    top = (height - fitted_height) // 2
    left = (width - fitted_width) // 2
    bottom = height - fitted_height - top
    right = width - fitted_width - left
    padded = torch.nn.functional.pad(raw, (left, right, top, bottom))
    mask = torch.ones((raw.shape[0], 1, height, width), device=device)
    mask[..., top : top + fitted_height, left : left + fitted_width] = 0
    padded = padded.permute(1, 0, 2, 3).unsqueeze(0)
    mask = mask.permute(1, 0, 2, 3).unsqueeze(0)
    padded = _conform_pixel_frames(padded, num_frames).to(dtype=dtype)
    mask = _conform_pixel_frames(mask, num_frames)
    return padded * 2 - 1, mask


def _pixel_video(decoded: Iterator[torch.Tensor]) -> torch.Tensor:
    chunks = list(decoded)
    if not chunks:
        raise RuntimeError("The VAE decoder produced no video frames.")
    return torch.cat(chunks, dim=0).permute(3, 0, 1, 2).unsqueeze(0)


def _frames_first(video: torch.Tensor) -> torch.Tensor:
    return video.squeeze(0).permute(1, 0, 2, 3)


def _vae_range(video: torch.Tensor) -> torch.Tensor:
    return video.clamp(0, 1) * 2 - 1


class InOutpaintPipeline:
    def __init__(  # noqa: PLR0913
        self,
        checkpoint_path: str,
        gemma_root: str,
        loras: tuple[LoraPathStrengthAndSDOps, ...],
        *,
        device: torch.device | None = None,
        quantization=None,
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
            official_comfy_prompt_enhancement=True,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.image_conditioner = ImageConditioner(
            checkpoint_path,
            self.dtype,
            self.device,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.audio_conditioner = AudioConditioner(
            checkpoint_path,
            self.dtype,
            self.device,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.video_decoder = VideoDecoder(
            checkpoint_path,
            self.dtype,
            self.device,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.audio_decoder = AudioDecoder(
            checkpoint_path,
            self.dtype,
            self.device,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        stage_options = {
            "loras": loras,
            "quantization": quantization,
            "offload_mode": offload_mode,
            "alloc_trim_strategy": alloc_trim_strategy,
        }
        self.stage_1 = DiffusionStage.from_checkpoint(
            checkpoint_path,
            self.dtype,
            self.device,
            **stage_options,
        )
        self.stage_2 = DiffusionStage.from_checkpoint(
            checkpoint_path,
            self.dtype,
            self.device,
            **stage_options,
        )

    def _conditionings(
        self,
        encoder: VideoEncoder,
        *,
        first_frame: torch.Tensor,
        reference_video: torch.Tensor | None,
        image_strength: float,
        tiling_config: TilingConfig | None,
    ) -> list[ConditioningItem]:
        encoded_first_frame = encoder(first_frame[:, :, :1])
        conditionings: list[ConditioningItem] = [
            VideoConditionByLatentIndex(
                latent=encoded_first_frame,
                strength=image_strength,
                latent_idx=0,
            ),
        ]
        if reference_video is not None:
            append_ic_lora_reference_tensor_conditioning(
                conditionings,
                reference_video,
                strength=1.0,
                video_encoder=encoder,
                tiling_config=tiling_config,
            )
        return conditionings

    def __call__(  # noqa: PLR0913
        self,
        *,
        mode: InOutMode,
        source_video_path: str,
        mask_video_path: str | None,
        prompt: str,
        negative_prompt: str,
        seed: int,
        stage_2_seed: int,
        height: int,
        width: int,
        num_frames: int,
        frame_rate: float,
        enhance_prompt: bool,
        tiling_config: TilingConfig | None,
    ) -> tuple[torch.Tensor, Audio]:
        assert_resolution(height=height, width=width, is_two_stage=True)
        if mode == "inpaint" and not mask_video_path:
            raise ValueError("Inpainting requires --mask-video.")

        if mode == "outpaint":
            source, mask = _center_pad_outpaint_source(
                source_video_path,
                height=height,
                width=width,
                num_frames=num_frames,
                dtype=self.dtype,
                device=self.device,
            )
        else:
            source = _load_video_vae_range(
                source_video_path,
                height=height,
                width=width,
                num_frames=num_frames,
                dtype=self.dtype,
                device=self.device,
            )
            mask = _load_mask(
                mask_video_path or "",
                height=height,
                width=width,
                num_frames=num_frames,
                device=self.device,
            )

        contexts = self.prompt_encoder(
            [prompt, negative_prompt],
            enhance_first_prompt=enhance_prompt,
            enhance_prompt_image=source_video_path,
            enhance_prompt_seed=seed,
        )
        ctx_p, ctx_n = contexts
        guider_params = MultiModalGuiderParams(
            cfg_scale=1.0,
            stg_scale=0.0,
            rescale_scale=0.0,
            modality_scale=1.0,
            skip_step=0,
            stg_blocks=[],
        )
        denoiser = FactoryGuidedDenoiser(
            v_context=ctx_p.video_encoding,
            a_context=ctx_p.audio_encoding,
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

        output_shape = VideoPixelShape(
            batch=1,
            frames=num_frames,
            height=height,
            width=width,
            fps=frame_rate,
        )
        source_audio = decode_audio_from_file(
            source_video_path,
            self.device,
            0.0,
            num_frames / frame_rate,
        )
        initial_audio_latent = None
        if source_audio is not None:
            initial_audio_latent = self.audio_conditioner(
                lambda encoder: vae_encode_audio(source_audio, encoder, None),
            )
            initial_audio_latent = conform_latent_length(
                initial_audio_latent,
                AudioLatentShape.from_video_pixel_shape(output_shape).frames,
            )
        else:
            logger.warning("Source video has no audio; the model will generate an audio track.")

        half_height, half_width = height // 2, width // 2
        source_half = resize_video(source, half_height, half_width)
        mask_half = resize_video(mask, half_height, half_width)
        if mode == "inpaint":
            mask_half = dilate_video_mask(mask_half, spatial_radius=32)
        green_half = green_screen_inpaint(source_half, mask_half)
        stage_1_conditionings = self.image_conditioner(
            lambda encoder: self._conditionings(
                encoder,
                first_frame=source_half,
                reference_video=green_half,
                image_strength=0.7,
                tiling_config=tiling_config,
            ),
        )

        stage_1_seed = seed
        stage_1_noiser = GaussianNoiser(
            generator=torch.Generator(device=self.device).manual_seed(stage_1_seed),
        )
        stage_1_video, stage_1_audio = self.stage_1(
            denoiser=denoiser,
            sigmas=DISTILLED_SIGMAS.to(device=self.device, dtype=torch.float32),
            noiser=stage_1_noiser,
            width=half_width,
            height=half_height,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(
                context=ctx_p.video_encoding,
                conditionings=stage_1_conditionings,
            ),
            audio=ModalitySpec(
                context=ctx_p.audio_encoding,
                initial_latent=initial_audio_latent,
                frozen=initial_audio_latent is not None,
                noise_scale=0.0 if initial_audio_latent is not None else 1.0,
            ),
            stepper=EulerCfgPpDiffusionStep(eta=1.0, s_noise=1.0),
            loop=partial(euler_cfg_pp_denoising_loop, noise_seed=stage_1_seed),
        )
        if stage_1_video is None or stage_1_audio is None:
            raise RuntimeError("The first diffusion stage returned an incomplete result.")

        decoded_stage_1 = _pixel_video(
            self.video_decoder(
                stage_1_video.latent,
                tiling_config,
                torch.Generator(device=self.device).manual_seed(seed),
            ),
        )
        blended_half = laplacian_pyramid_blend(
            _frames_first(decoded_stage_1),
            _frames_first((green_half + 1) / 2),
            _frames_first(mask_half),
            mask_low_res_dilation=5,
        )
        blended_full = torch.nn.functional.interpolate(
            blended_half,
            size=(height, width),
            mode="bilinear",
            align_corners=False,
        ).permute(1, 0, 2, 3).unsqueeze(0)

        def encode_stage_2(encoder: VideoEncoder) -> tuple[torch.Tensor, list[ConditioningItem]]:
            stage_2_input = _vae_range(blended_full)
            stage_2_initial = (
                encoder.tiled_encode(stage_2_input, tiling_config)
                if tiling_config is not None
                else encoder(stage_2_input)
            )
            conditionings = self._conditionings(
                encoder,
                first_frame=source,
                reference_video=None,
                image_strength=1.0,
                tiling_config=tiling_config,
            )
            return stage_2_initial, conditionings

        stage_2_initial, stage_2_conditionings = self.image_conditioner(encode_stage_2)
        stage_2_noiser = GaussianNoiser(
            generator=torch.Generator(device=self.device).manual_seed(stage_2_seed),
        )
        sigmas_2 = STAGE_2_SIGMAS.to(device=self.device, dtype=torch.float32)
        stage_2_video, stage_2_audio = self.stage_2(
            denoiser=denoiser,
            sigmas=sigmas_2,
            noiser=stage_2_noiser,
            width=width,
            height=height,
            frames=num_frames,
            fps=frame_rate,
            video=ModalitySpec(
                context=ctx_p.video_encoding,
                conditionings=stage_2_conditionings,
                initial_latent=stage_2_initial,
                noise_scale=float(sigmas_2[0]),
            ),
            audio=ModalitySpec(
                context=ctx_p.audio_encoding,
                initial_latent=stage_1_audio.latent,
                frozen=initial_audio_latent is not None,
                noise_scale=0.0 if initial_audio_latent is not None else float(sigmas_2[0]),
            ),
            stepper=EulerCfgPpDiffusionStep(eta=0.0, s_noise=0.0),
            loop=partial(euler_cfg_pp_denoising_loop, noise_seed=stage_2_seed),
        )
        if stage_2_video is None or stage_2_audio is None:
            raise RuntimeError("The second diffusion stage returned an incomplete result.")

        decoded_stage_2 = _pixel_video(
            self.video_decoder(
                stage_2_video.latent,
                tiling_config,
                torch.Generator(device=self.device).manual_seed(stage_2_seed),
            ),
        )
        final_mask = dilate_video_mask(mask, spatial_radius=5) if mode == "inpaint" else mask
        green_full = green_screen_inpaint(source, final_mask)
        final_video = laplacian_pyramid_blend(
            _frames_first(decoded_stage_2),
            _frames_first((green_full + 1) / 2),
            _frames_first(final_mask),
            mask_low_res_dilation=6 if mode == "inpaint" else 2,
        ).permute(0, 2, 3, 1)
        if source_audio is not None:
            output_audio = Audio(
                waveform=source_audio.waveform.squeeze(0),
                sampling_rate=source_audio.sampling_rate,
            )
        else:
            output_audio = self.audio_decoder(stage_2_audio.latent)
        return final_video, output_audio


@torch.inference_mode()
def main() -> None:
    logging.basicConfig(level=logging.INFO)
    params = resolve_cli_params()
    parser = basic_arg_parser(params=params)
    parser.add_argument("--source-video", type=resolve_existing_path, required=True)
    parser.add_argument("--mask-video", type=resolve_existing_path)
    parser.add_argument("--edit-mode", choices=("inpaint", "outpaint"), required=True)
    parser.add_argument("--negative-prompt", default="")
    parser.add_argument("--height", type=int, default=params.stage_2_height)
    parser.add_argument("--width", type=int, default=params.stage_2_width)
    parser.add_argument("--num-frames", type=int, default=params.num_frames)
    parser.add_argument("--frame-rate", type=float, default=params.frame_rate)
    parser.add_argument("--stage-2-seed", type=int, default=42)
    args = parser.parse_args()
    if len(args.lora) < 2:
        parser.error(
            "The official path requires both Distilled LoRA 1.1 and "
            "In/Outpainting IC-LoRA via two --lora arguments.",
        )

    pipeline = InOutpaintPipeline(
        checkpoint_path=args.checkpoint_path,
        gemma_root=args.gemma_root,
        loras=tuple(args.lora),
        quantization=args.quantization,
        offload_mode=args.offload_mode,
    )
    video, audio = pipeline(
        mode=args.edit_mode,
        source_video_path=args.source_video,
        mask_video_path=args.mask_video,
        prompt=args.prompt,
        negative_prompt=args.negative_prompt,
        seed=args.seed,
        stage_2_seed=args.stage_2_seed,
        height=args.height,
        width=args.width,
        num_frames=args.num_frames,
        frame_rate=args.frame_rate,
        enhance_prompt=args.enhance_prompt,
        tiling_config=None if args.disable_tiling else TilingConfig.default(),
    )
    output = Path(args.output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    encode_video(
        video=video,
        fps=args.frame_rate,
        audio=audio,
        output_path=str(output),
        video_chunks_number=1,
    )


if __name__ == "__main__":
    main()
