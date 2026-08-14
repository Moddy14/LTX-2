from __future__ import annotations

import importlib
import json
from pathlib import Path

import pytest
import torch

from ltx_core.components.diffusion_steps import EulerAncestralDiffusionStep
from ltx_core.types import LatentState
from ltx_pipelines.utils import cooperative_checkpoint
from ltx_pipelines.utils.samplers import (
    euler_ancestral_rf_denoising_loop,
    euler_denoising_loop,
)
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


def joint_denoiser(
    transformer: object,
    video_state: LatentState | None,
    audio_state: LatentState | None,
    sigmas: torch.Tensor,
    step_index: int,
) -> tuple[DenoisedLatentResult | None, DenoisedLatentResult | None]:
    del transformer, sigmas, step_index
    assert video_state is not None
    assert audio_state is not None
    return (
        DenoisedLatentResult(video_state.latent * 0.5),
        DenoisedLatentResult(audio_state.latent * 0.5),
    )


def reset_loop_counter() -> None:
    importlib.reload(cooperative_checkpoint)


def boundary_decision(
    boundary_id: str,
    action: str,
    *,
    generation: int = 0,
    decision_id: str = "decision-1",
) -> dict[str, object]:
    return {
        "schema_version": "ltx-segment-boundary-decision.v1",
        "job_fingerprint": "fingerprint",
        "dgx_job_id": "dgx-job-test",
        "generation": generation,
        "boundary_id": boundary_id,
        "decision_id": decision_id,
        "action": action,
    }


def test_boundary_continue_is_consumed_for_the_exact_generation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LTX_COOPERATIVE_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "fingerprint")
    monkeypatch.setenv("LTX_COOPERATIVE_GENERATION", "4")
    monkeypatch.setenv("DGX_JOB_ID", "dgx-job-test")
    original_read = cooperative_checkpoint._read_json

    def read_with_decision(path: Path) -> dict[str, object] | None:
        if path.name == "boundary-decision.json":
            return boundary_decision("4:2:7", "continue_current", generation=4)
        return original_read(path)

    monkeypatch.setattr(cooperative_checkpoint, "_read_json", read_with_decision)
    cooperative_checkpoint.checkpoint_and_yield_if_requested(
        loop_index=2,
        next_step_index=7,
        sigmas=torch.tensor([1.0, 0.0]),
        video_state=state(),
        audio_state=None,
    )

    assert not (tmp_path / "boundary-ready.json").exists()
    assert not (tmp_path / "boundary-decision.json").exists()
    assert not (tmp_path / "manifest.json").exists()


def test_boundary_yield_commits_decision_id_and_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LTX_COOPERATIVE_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "fingerprint")
    monkeypatch.setenv("LTX_COOPERATIVE_GENERATION", "1")
    monkeypatch.setenv("DGX_JOB_ID", "dgx-job-test")
    original_read = cooperative_checkpoint._read_json

    def read_with_decision(path: Path) -> dict[str, object] | None:
        if path.name == "boundary-decision.json":
            return boundary_decision("1:0:1", "yield_to_waiting_job", generation=1, decision_id="yield-7")
        return original_read(path)

    monkeypatch.setattr(cooperative_checkpoint, "_read_json", read_with_decision)
    with pytest.raises(SystemExit) as yielded:
        cooperative_checkpoint.checkpoint_and_yield_if_requested(
            loop_index=0,
            next_step_index=1,
            sigmas=torch.tensor([1.0, 0.0]),
            video_state=state(),
            audio_state=None,
        )

    assert yielded.value.code == 75
    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["request_id"] == "yield-7"
    assert manifest["boundary_id"] == "1:0:1"


def test_stale_boundary_decision_fails_closed_to_a_checkpoint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LTX_COOPERATIVE_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "fingerprint")
    monkeypatch.setenv("LTX_COOPERATIVE_GENERATION", "2")
    monkeypatch.setenv("DGX_JOB_ID", "dgx-job-test")
    original_read = cooperative_checkpoint._read_json

    def read_stale(path: Path) -> dict[str, object] | None:
        if path.name == "boundary-decision.json":
            return boundary_decision("1:0:1", "continue_current", generation=1)
        return original_read(path)

    monkeypatch.setattr(cooperative_checkpoint, "_read_json", read_stale)
    with pytest.raises(SystemExit):
        cooperative_checkpoint.checkpoint_and_yield_if_requested(
            loop_index=0,
            next_step_index=1,
            sigmas=torch.tensor([1.0, 0.0]),
            video_state=state(),
            audio_state=None,
        )

    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["request_id"] == "invalid:2:0:1"


def test_missing_boundary_decision_times_out_fail_closed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LTX_COOPERATIVE_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "fingerprint")
    monkeypatch.setenv("LTX_COOPERATIVE_GENERATION", "3")
    monkeypatch.setenv("DGX_JOB_ID", "dgx-job-test")
    monkeypatch.setenv("LTX_SEGMENT_BOUNDARY_TIMEOUT_SECONDS", "0.05")

    with pytest.raises(SystemExit):
        cooperative_checkpoint.checkpoint_and_yield_if_requested(
            loop_index=0,
            next_step_index=1,
            sigmas=torch.tensor([1.0, 0.0]),
            video_state=state(),
            audio_state=None,
        )

    manifest = json.loads((tmp_path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["request_id"] == "timeout:3:0:1"


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


def test_ancestral_rf_loop_resumes_with_identical_rng_sequence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sigmas = torch.tensor([1.0, 0.725, 0.421875, 0.0])
    stepper = EulerAncestralDiffusionStep()

    monkeypatch.delenv("LTX_COOPERATIVE_CHECKPOINT_DIR", raising=False)
    monkeypatch.delenv("LTX_COOPERATIVE_JOB_FINGERPRINT", raising=False)
    reset_loop_counter()
    baseline_video, baseline_audio = euler_ancestral_rf_denoising_loop(
        sigmas,
        state(0.0),
        state(0.25),
        stepper,
        object(),
        joint_denoiser,
        noise_seed=1234,
    )

    monkeypatch.setenv("LTX_COOPERATIVE_CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setenv("LTX_COOPERATIVE_JOB_FINGERPRINT", "ancestral")
    (tmp_path / "yield-request.json").write_text(
        json.dumps(
            {
                "schema_version": "ltx-cooperative-yield-request.v1",
                "job_fingerprint": "ancestral",
                "request_id": "yield-ancestral",
            }
        ),
        encoding="utf-8",
    )
    reset_loop_counter()
    with pytest.raises(SystemExit) as yielded:
        euler_ancestral_rf_denoising_loop(
            sigmas,
            state(0.0),
            state(0.25),
            stepper,
            object(),
            joint_denoiser,
            noise_seed=1234,
        )
    assert yielded.value.code == 75

    (tmp_path / "yield-request.json").unlink()
    reset_loop_counter()
    resumed_video, resumed_audio = euler_ancestral_rf_denoising_loop(
        sigmas,
        state(0.0),
        state(0.25),
        stepper,
        object(),
        joint_denoiser,
        noise_seed=1234,
    )

    assert baseline_video is not None
    assert resumed_video is not None
    assert baseline_audio is not None
    assert resumed_audio is not None
    torch.testing.assert_close(resumed_video.latent, baseline_video.latent)
    torch.testing.assert_close(resumed_audio.latent, baseline_audio.latent)
