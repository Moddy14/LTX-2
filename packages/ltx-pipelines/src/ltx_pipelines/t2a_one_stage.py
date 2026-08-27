import argparse
import logging
import math
from functools import partial

import torch

from ltx_core.allocator_trim_strategy import AllocatorTrimStrategy
from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep, EulerCfgPpDiffusionStep
from ltx_core.components.guiders import (
    MultiModalGuiderFactory,
    MultiModalGuiderParams,
    create_multimodal_guider_factory,
)
from ltx_core.components.noisers import GaussianNoiser
from ltx_core.components.schedulers import LTX2Scheduler
from ltx_core.loader import LoraPathStrengthAndSDOps
from ltx_core.loader.registry import Registry
from ltx_core.model.transformer import LTXV_AUDIO_ONLY_MODEL_COMFY_RENAMING_MAP, LTXAudioOnlyModelConfigurator
from ltx_core.model.transformer.compiling import CompilationConfig
from ltx_core.quantization import QuantizationPolicy
from ltx_core.types import Audio
from ltx_pipelines.utils import get_device
from ltx_pipelines.utils.args import (
    default_1_stage_t2a_arg_parser,
    resolve_cli_params,
)
from ltx_pipelines.utils.blocks import (
    AudioDecoder,
    DiffusionStage,
    DurationPredictor,
    PromptEncoder,
    require_num_frames_source,
    resolve_num_frames,
)
from ltx_pipelines.utils.constants import DISTILLED_SIGMAS
from ltx_pipelines.utils.denoisers import FactoryGuidedDenoiser
from ltx_pipelines.utils.media_io import encode_audio
from ltx_pipelines.utils.model_paths import ModelPaths
from ltx_pipelines.utils.official_comfy import resolve_official_comfy_cli_sampler
from ltx_pipelines.utils.samplers import euler_ancestral_denoising_loop, euler_cfg_pp_denoising_loop
from ltx_pipelines.utils.types import DEFAULT_AUTO_DURATION, AutoDuration, ModalitySpec, OffloadMode

# Placeholder pixel dimensions used for ``VideoPixelShape`` construction.
# Audio-only generation reads ``frames`` and ``fps`` from the pixel shape via
# ``AudioLatentShape.from_video_pixel_shape`` (height/width are unused).
_AUDIO_ONLY_PLACEHOLDER_RES = 512


def _parse_audio_peak_ceiling_dbfs(value: str) -> float:
    """Reject invalid peak ceilings during CLI parsing, before model allocation."""
    try:
        ceiling = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be a finite number between -60 and 0 dBFS") from exc

    if not math.isfinite(ceiling) or not -60.0 <= ceiling <= 0.0:
        raise argparse.ArgumentTypeError("must be a finite number between -60 and 0 dBFS")
    return ceiling


def _official_comfy_t2a_stage_kwargs(
    seed: int,
    sampler: str,
) -> dict[str, object]:
    """Return the explicitly selected official 2.3 or 2.5 T2A sampler contract."""
    if sampler == "euler-ancestral":
        return {
            "stepper": EulerAncestralDiffusionStep(),
            "state_dtype": torch.float32,
            "loop": partial(
                euler_ancestral_denoising_loop,
                noise_seed=seed,
                # ComfyUI samples its latent trajectory in FP32 even when the
                # transformer weights are BF16.
                model_dtype=torch.float32,
                model_input_dtype=torch.bfloat16,
            ),
        }
    if sampler == "euler-ancestral-cfg-pp":
        return {
            "stepper": EulerCfgPpDiffusionStep(),
            "loop": partial(euler_cfg_pp_denoising_loop, noise_seed=seed),
        }
    raise ValueError(f"Unsupported official T2A sampler: {sampler}")


def _resolve_official_comfy_t2a_sampler(
    *,
    official_comfy_workflow: bool,
    requested_sampler: str | None,
    model_paths: ModelPaths,
) -> str:
    """Bind an omitted CLI sampler to the checkpoint-generation contract.

    Official LTX-2.3 T2A is distributed as a monolith and uses CFG++, whereas
    the official LTX-2.5 workflow is the split-pack path and uses plain RF
    Euler ancestral.  The GUI always passes an explicit value; this resolver
    closes the equivalent direct-CLI path without changing the programmatic
    pipeline default retained for older callers.
    """
    return resolve_official_comfy_cli_sampler(
        official_comfy_workflow=official_comfy_workflow,
        requested_sampler=requested_sampler,
        model_paths=model_paths,
        monolith_default="euler-ancestral-cfg-pp",
        split_default="euler-ancestral",
    )


class T2AOneStagePipeline:
    """
    Single-stage text-to-audio generation pipeline.
    Generates audio at the target duration in a single diffusion pass with
    classifier-free guidance (CFG) on the audio modality only. The video
    modality is fully absent — the transformer runs audio-only by passing
    ``video=None`` to the ``DiffusionStage``.
    Assumes full non distilled model is provided in the checkpoint_path.
    """

    def __init__(
        self,
        model_paths: ModelPaths,
        loras: list[LoraPathStrengthAndSDOps],
        device: torch.device | None = None,
        quantization: QuantizationPolicy | None = None,
        registry: Registry | None = None,
        compilation_config: CompilationConfig | None = None,
        offload_mode: OffloadMode = OffloadMode.NONE,
        alloc_trim_strategy: AllocatorTrimStrategy = AllocatorTrimStrategy.TRIM,
        prompt_enhancer_gemma_root: str | None = None,
    ):
        self.dtype = torch.bfloat16
        self.device = device or get_device()
        self._scheduler = LTX2Scheduler()
        self.prompt_encoder = PromptEncoder(
            model_paths,
            dtype=self.dtype,
            device=self.device,
            registry=registry,
            offload_mode=offload_mode,
            alloc_trim_strategy=alloc_trim_strategy,
            prompt_enhancer_gemma_root=prompt_enhancer_gemma_root,
        )
        # Audio-only: build an audio-only transformer (model_configurator) so the video
        # weights are never instantiated, plus a use-case-specific SDOps that restricts
        # checkpoint reads to the audio model's keys, so the video weights are never even
        # read from disk (the loader skips any key the SDOps maps to None).
        self.stage = DiffusionStage.from_checkpoint(
            model_paths.transformer(),
            dtype=self.dtype,
            device=self.device,
            loras=tuple(loras),
            quantization=quantization,
            registry=registry,
            compilation_config=compilation_config,
            offload_mode=offload_mode,
            model_configurator=LTXAudioOnlyModelConfigurator,
            model_sd_ops=LTXV_AUDIO_ONLY_MODEL_COMFY_RENAMING_MAP,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        self.audio_decoder = AudioDecoder(
            model_paths.audio_vae(),
            dtype=self.dtype,
            device=self.device,
            registry=registry,
            alloc_trim_strategy=alloc_trim_strategy,
        )
        # None on checkpoints that predate DurationHead (LTX 2.5 / gemma4 only) -- __call__ requires
        # an explicit num_frames in that case instead of crashing deep in a forward pass.
        self.duration_predictor = DurationPredictor.from_checkpoint(
            checkpoint_path=model_paths.duration_head_path,
            dtype=self.dtype,
            device=self.device,
        )

    def __call__(  # noqa: PLR0913, PLR0917
        self,
        prompt: str,
        negative_prompt: str,
        seed: int,
        frame_rate: float,
        num_inference_steps: int,
        audio_guider_params: MultiModalGuiderParams | MultiModalGuiderFactory,
        num_frames: int | AutoDuration = DEFAULT_AUTO_DURATION,
        enhance_prompt: bool = False,
        enhance_static_cache: bool = False,
        max_batch_size: int = 1,
        sigmas: torch.Tensor | None = None,
        official_comfy_workflow: bool = False,
        official_comfy_sampler: str = "euler-ancestral-cfg-pp",
    ) -> Audio:
        require_num_frames_source(num_frames, self.duration_predictor)
        generator = torch.Generator(device=self.device).manual_seed(seed)
        noiser = GaussianNoiser(generator=generator)

        ctx_p, ctx_n = self.prompt_encoder(
            [prompt, negative_prompt],
            enhance_first_prompt=enhance_prompt,
            enhance_static_cache=enhance_static_cache,
            enhance_prompt_image=None,
        )
        a_context_p = ctx_p.audio_encoding
        a_context_n = ctx_n.audio_encoding

        num_frames = resolve_num_frames(
            num_frames, self.duration_predictor, video_encoding=None, audio_encoding=a_context_p, frame_rate=frame_rate
        )

        resolved_sigmas = (
            sigmas
            if sigmas is not None
            else DISTILLED_SIGMAS
            if official_comfy_workflow
            else self._scheduler.execute(steps=num_inference_steps)
        ).to(dtype=torch.float32, device=self.device)

        # Normalize to a guider factory. Plain ``MultiModalGuiderParams`` (the default /
        # CLI case) becomes a simple sigma-independent guider, but callers may also pass
        # their own factory for sigma-dependent guidance; ``FactoryGuidedDenoiser`` always
        # consumes a factory.
        audio_guider_factory = create_multimodal_guider_factory(
            params=audio_guider_params,
            negative_context=a_context_n,
        )

        stage_kwargs = _official_comfy_t2a_stage_kwargs(seed, official_comfy_sampler) if official_comfy_workflow else {}

        _, audio_state = self.stage(
            denoiser=FactoryGuidedDenoiser(
                v_context=None,
                a_context=a_context_p,
                video_guider_factory=None,
                audio_guider_factory=audio_guider_factory,
                force_uncond_pass=(official_comfy_workflow and official_comfy_sampler == "euler-ancestral-cfg-pp"),
            ),
            sigmas=resolved_sigmas,
            noiser=noiser,
            width=_AUDIO_ONLY_PLACEHOLDER_RES,
            height=_AUDIO_ONLY_PLACEHOLDER_RES,
            frames=num_frames,
            fps=frame_rate,
            video=None,
            audio=ModalitySpec(context=a_context_p),
            max_batch_size=max_batch_size,
            **stage_kwargs,
        )

        return self.audio_decoder(audio_state.latent)


@torch.inference_mode()
def main() -> None:
    logging.basicConfig(level=logging.INFO)
    params = resolve_cli_params()
    parser = default_1_stage_t2a_arg_parser(params=params)
    parser.add_argument(
        "--official-comfy-workflow",
        action="store_true",
        help="Use the fixed official Comfy T2A 8-sigma schedule.",
    )
    parser.add_argument(
        "--official-comfy-sampler",
        choices=("euler-ancestral-cfg-pp", "euler-ancestral"),
        default=None,
        help=(
            "Sampler bound to the source workflow: CFG++ for LTX-2.3; "
            "plain Euler ancestral for LTX-2.5. When omitted, the checkpoint "
            "layout selects the matching official sampler."
        ),
    )
    parser.add_argument(
        "--audio-peak-ceiling-dbfs",
        type=_parse_audio_peak_ceiling_dbfs,
        default=None,
        metavar="DBFS",
        help=(
            "Attenuate decoded floating-point audio before PCM conversion so its sample peak does not "
            "exceed this dBFS ceiling. This is not a true-peak limiter; quiet audio is never amplified. "
            "Omit to preserve upstream behavior."
        ),
    )
    args = parser.parse_args()
    official_comfy_sampler = _resolve_official_comfy_t2a_sampler(
        official_comfy_workflow=args.official_comfy_workflow,
        requested_sampler=args.official_comfy_sampler,
        model_paths=args.model_paths,
    )
    pipeline = T2AOneStagePipeline(
        model_paths=args.model_paths,
        loras=tuple(args.lora) if args.lora else (),
        quantization=args.quantization,
        compilation_config=args.compile,
        offload_mode=args.offload_mode,
        prompt_enhancer_gemma_root=args.prompt_enhancer_gemma_root,
    )
    audio = pipeline(
        prompt=args.prompt,
        negative_prompt=args.negative_prompt,
        seed=args.seed,
        num_frames=args.num_frames,
        frame_rate=args.frame_rate,
        num_inference_steps=args.num_inference_steps,
        audio_guider_params=MultiModalGuiderParams(
            cfg_scale=args.audio_cfg_guidance_scale,
            stg_scale=args.audio_stg_guidance_scale,
            rescale_scale=args.audio_rescale_scale,
            # Audio-only generation has no video modality, so the video->audio
            # (v2a) cross-modal guidance is meaningless here. 1.0 disables it.
            modality_scale=1.0,
            skip_step=args.audio_skip_step,
            stg_blocks=args.audio_stg_blocks,
        ),
        enhance_prompt=args.enhance_prompt,
        enhance_static_cache=args.enhance_static_cache,
        max_batch_size=args.max_batch_size,
        official_comfy_workflow=args.official_comfy_workflow,
        official_comfy_sampler=official_comfy_sampler,
    )

    encode_audio(
        audio=audio,
        output_path=args.output_path,
        peak_ceiling_dbfs=args.audio_peak_ceiling_dbfs,
    )


if __name__ == "__main__":
    main()
