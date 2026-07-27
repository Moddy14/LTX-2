from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest
import torch

from ltx_core.types import LatentState
from ltx_pipelines.utils import cooperative_checkpoint
from ltx_pipelines.utils.samplers import euler_denoising_loop
from ltx_pipelines.utils.types import DenoisedLatentResult


class AddOneStepper:
    def step(
        self,
        sample: torch.Tensor,
        denoised_sample: torch.Tensor,
        sigmas: torch.Tensor,
        step_index: int,
    ) -> torch.Tensor:
        del denoised_sample, sigmas, step_index
        return sample + 1


def state(value: float = 0) -> LatentState:
    latent = torch.tensor([value])
    return LatentState(
        latent=latent,
        denoise_mask=torch.ones_like(latent),
        positions=torch.zeros_like(latent),
        clean_latent=torch.zeros_like(latent),
    )


def denoiser(
    transformer: object,
    video_state: LatentState | None,
    audio_state: LatentState | None,
    sigmas: torch.Tensor,
    step_index: int,
) -> tuple[DenoisedLatentResult | None, DenoisedLatentResult | None]:
    del transformer, audio_state, sigmas, step_index
    assert video_state is not None
    return DenoisedLatentResult(video_state.latent), None


def reset_loop_counter() -> None:
    importlib.reload(cooperative_checkpoint)


def test_euler_loop_yields_and_resumes_from_committed_step(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LTX_COOPERATIVE_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "fingerprint")
    (tmp_path / "yield-request.json").write_text(
        json.dumps(
            {
                "schema_version": "ltx-cooperative-yield-request.v1",
                "job_fingerprint": "fingerprint",
                "request_id": "yield-1",
            }
        ),
        encoding="utf-8",
    )
    sigmas = torch.tensor([1.0, 0.5, 0.0])

    with pytest.raises(SystemExit) as yielded:
        euler_denoising_loop(sigmas, state(), None, AddOneStepper(), object(), denoiser)
    assert yielded.value.code == 75
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["next_step_index"] == 1

    (tmp_path / "yield-request.json").unlink()
    reset_loop_counter()
    video, audio = euler_denoising_loop(sigmas, state(), None, AddOneStepper(), object(), denoiser)

    assert audio is None
    assert video is not None
    assert video.latent.item() == 2
    assert not (tmp_path / "manifest.json").exists()
    assert not (tmp_path / "state.pt").exists()


def test_resume_rejects_a_different_job_fingerprint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LTX_COOPERATIVE_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "original")
    (tmp_path / "yield-request.json").write_text(
        json.dumps(
            {
                "schema_version": "ltx-cooperative-yield-request.v1",
                "job_fingerprint": "original",
                "request_id": "yield-1",
            }
        ),
        encoding="utf-8",
    )
    sigmas = torch.tensor([1.0, 0.0])
    with pytest.raises(SystemExit):
        euler_denoising_loop(sigmas, state(), None, AddOneStepper(), object(), denoiser)

    (tmp_path / "yield-request.json").unlink()
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "different")
    reset_loop_counter()
    with pytest.raises(RuntimeError, match="fingerprint"):
        euler_denoising_loop(sigmas, state(), None, AddOneStepper(), object(), denoiser)
