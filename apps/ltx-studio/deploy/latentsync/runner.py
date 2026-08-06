#!/usr/bin/env python3
"""Offline LatentSync 1.6 inference entrypoint for LTX Studio."""

from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

import torch
from accelerate.utils import set_seed
from diffusers import AutoencoderKL, DDIMScheduler
from omegaconf import OmegaConf

from latentsync.models.unet import UNet3DConditionModel
from latentsync.pipelines import lipsync_pipeline as lipsync_pipeline_module
from latentsync.pipelines.lipsync_pipeline import LipsyncPipeline
from latentsync.utils import util as latentsync_util
from latentsync.whisper.audio2feature import Audio2Feature
from timeline import normalize_for_latentsync, probe_video_timeline, restore_source_timeline


def run(command: list[str]) -> None:
    subprocess.run(command, check=True)


def regular_file(path: Path, label: str) -> Path:
    resolved = path.resolve()
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise RuntimeError(f"{label} fehlt oder ist leer: {resolved}")
    return resolved


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--checkpoint", default="/models/checkpoints/latentsync_unet.pt")
    parser.add_argument("--whisper", default="/models/checkpoints/whisper/tiny.pt")
    parser.add_argument("--vae", default="/models/vae")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--guidance", type=float, default=2.0)
    parser.add_argument("--seed", type=int, default=1247)
    parser.add_argument("--use-driving-audio", action="store_true")
    args = parser.parse_args()

    if not 20 <= args.steps <= 50:
        raise ValueError("--steps muss zwischen 20 und 50 liegen.")
    if not 1 <= args.guidance <= 3:
        raise ValueError("--guidance muss zwischen 1 und 3 liegen.")

    video = regular_file(Path(args.video), "Eingabevideo")
    audio = regular_file(Path(args.audio), "Eingabeton")
    checkpoint = regular_file(Path(args.checkpoint), "LatentSync-Checkpoint")
    whisper = regular_file(Path(args.whisper), "Whisper-Checkpoint")
    vae = Path(args.vae).resolve()
    if not (vae / "config.json").is_file():
        raise RuntimeError(f"VAE-Konfiguration fehlt: {vae}")

    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    work = Path("/work")
    normalized_video = work / "video-25fps.mp4"
    normalized_audio = work / "audio-16k.wav"
    temporary_output = work / "latentsync-output.mp4"
    for path in (normalized_video, normalized_audio, temporary_output):
        path.unlink(missing_ok=True)

    source_timeline = probe_video_timeline(video)
    normalized_timeline = normalize_for_latentsync(video, normalized_video)
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(audio),
        "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        str(normalized_audio),
    ])

    config = OmegaConf.load("configs/unet/stage2_512.yaml")
    dtype = torch.float16
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True
    set_seed(args.seed)

    scheduler = DDIMScheduler.from_pretrained("configs")
    audio_encoder = Audio2Feature(
        model_path=str(whisper),
        device="cuda",
        num_frames=config.data.num_frames,
        audio_feat_length=config.data.audio_feat_length,
    )
    vae_model = AutoencoderKL.from_pretrained(str(vae), torch_dtype=dtype, local_files_only=True)
    vae_model.config.scaling_factor = 0.18215
    vae_model.config.shift_factor = 0
    unet, _ = UNet3DConditionModel.from_pretrained(
        OmegaConf.to_container(config.model),
        str(checkpoint),
        device="cpu",
    )
    unet = unet.to(dtype=dtype)

    pipeline = LipsyncPipeline(
        vae=vae_model,
        audio_encoder=audio_encoder,
        unet=unet,
        scheduler=scheduler,
    ).to("cuda")
    pipeline.enable_vae_slicing()

    # The input was normalized safely with an argv-based FFmpeg call above.
    # Bypass the upstream shell-based second conversion.
    lipsync_pipeline_module.read_video = lambda path, use_decord=False: latentsync_util.read_video(
        path,
        change_fps=False,
        use_decord=use_decord,
    )

    print(
        f"LatentSync 1.6: 512 px, {args.steps} Schritte, Guidance {args.guidance:.2f}, "
        f"Seed {args.seed}. Interne Zeitachse {normalized_timeline.frame_count} Bilder @ 25 fps; "
        f"Ausgabe wird auf {source_timeline.frame_count} Bilder @ "
        f"{source_timeline.frame_rate.numerator}/{source_timeline.frame_rate.denominator} fps zurückgeführt.",
        flush=True,
    )
    pipeline(
        video_path=str(normalized_video),
        audio_path=str(normalized_audio),
        video_out_path=str(temporary_output),
        num_frames=config.data.num_frames,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance,
        weight_dtype=dtype,
        width=config.data.resolution,
        height=config.data.resolution,
        mask_image_path=config.data.mask_image_path,
        temp_dir=str(work / "pipeline-temp"),
    )
    regular_file(temporary_output, "LatentSync-Ausgabe")
    restore_source_timeline(
        temporary_output,
        video,
        output,
        normalized_audio if args.use_driving_audio else None,
    )
    print(f"LatentSync-Ausgabe fertig: {output}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
