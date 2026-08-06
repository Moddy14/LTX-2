from pathlib import Path

import pytest
import torch

from ltx_pipelines.ic_lora import _audio_noise_scale, _build_arg_parser


@pytest.fixture
def cli_paths(tmp_path: Path) -> dict[str, str]:
    checkpoint = tmp_path / "checkpoint.safetensors"
    checkpoint.write_bytes(b"x")
    control = tmp_path / "control.mp4"
    control.write_bytes(b"x")
    return {
        "checkpoint": str(checkpoint),
        "gemma": str(tmp_path),
        "control": str(control),
        "output": str(tmp_path / "out.mp4"),
    }


def _base_args(cli_paths: dict[str, str]) -> list[str]:
    return [
        "--gemma-root",
        cli_paths["gemma"],
        "--prompt",
        "p",
        "--output-path",
        cli_paths["output"],
        "--video-conditioning",
        cli_paths["control"],
        "1",
    ]


def test_parser_accepts_the_studio_checkpoint_alias(cli_paths: dict[str, str]) -> None:
    args = _build_arg_parser().parse_args(
        ["--checkpoint-path", cli_paths["checkpoint"], *_base_args(cli_paths)],
    )

    assert args.distilled_checkpoint_path == cli_paths["checkpoint"]


def test_parser_keeps_the_distilled_checkpoint_flag(cli_paths: dict[str, str]) -> None:
    args = _build_arg_parser().parse_args(
        ["--distilled-checkpoint-path", cli_paths["checkpoint"], *_base_args(cli_paths)],
    )

    assert args.distilled_checkpoint_path == cli_paths["checkpoint"]


def test_parser_rejects_a_missing_checkpoint(cli_paths: dict[str, str]) -> None:
    with pytest.raises(SystemExit):
        _build_arg_parser().parse_args(_base_args(cli_paths))


def test_generated_audio_starts_from_full_noise() -> None:
    assert _audio_noise_scale(None) == 1.0


def test_frozen_audio_keeps_its_latent() -> None:
    assert _audio_noise_scale(torch.zeros((1, 4))) == 0.0
