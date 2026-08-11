from __future__ import annotations

import json
import os
import tempfile
import time
from dataclasses import fields
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch

from ltx_core.types import LatentState

CHECKPOINT_SCHEMA = "ltx-cooperative-checkpoint.v1"
YIELD_REQUEST_SCHEMA = "ltx-cooperative-yield-request.v1"
BOUNDARY_READY_SCHEMA = "ltx-segment-boundary-ready.v1"
BOUNDARY_DECISION_SCHEMA = "ltx-segment-boundary-decision.v1"
YIELD_EXIT_CODE = 75

_loop_index = 0


def _next_loop_index() -> int:
    global _loop_index
    value = _loop_index
    _loop_index += 1
    return value


def _checkpoint_root() -> Path | None:
    raw = os.environ.get("LTX_COOPERATIVE_CHECKPOINT_DIR", "").strip()
    return Path(raw) if raw else None


def _job_fingerprint() -> str | None:
    value = os.environ.get("LTX_COOPERATIVE_JOB_FINGERPRINT", "").strip()
    return value or None


def _dgx_job_id() -> str | None:
    value = os.environ.get("DGX_JOB_ID", "").strip()
    return value or None


def _generation() -> int | None:
    raw = os.environ.get("LTX_COOPERATIVE_GENERATION", "").strip()
    if not raw:
        return None
    try:
        generation = int(raw)
    except ValueError as error:
        raise RuntimeError("Cooperative checkpoint generation is invalid") from error
    if generation < 0:
        raise RuntimeError("Cooperative checkpoint generation is invalid")
    return generation


def _boundary_timeout_seconds() -> float:
    raw = os.environ.get("LTX_SEGMENT_BOUNDARY_TIMEOUT_SECONDS", "10").strip()
    try:
        return max(0.05, float(raw))
    except ValueError as error:
        raise RuntimeError("Segment boundary timeout is invalid") from error


def _fsync_directory(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            json.dump(payload, handle, ensure_ascii=True, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        if fd >= 0:
            os.close(fd)
        temporary.unlink(missing_ok=True)


def _atomic_torch_save(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    os.close(fd)
    temporary = Path(temporary_name)
    try:
        os.chmod(temporary, 0o600)
        torch.save(payload, temporary)
        with temporary.open("rb") as handle:
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        if path.stat().st_size > 64 * 1024:
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return None
    return payload if isinstance(payload, dict) else None


def _state_to_cpu(state: LatentState | None) -> dict[str, torch.Tensor | None] | None:
    if state is None:
        return None
    return {
        field.name: (
            value.detach().to(device="cpu", copy=True)
            if isinstance((value := getattr(state, field.name)), torch.Tensor)
            else None
        )
        for field in fields(LatentState)
    }


def _state_from_cpu(
    payload: object,
    reference: LatentState | None,
    modality: str,
) -> LatentState | None:
    if payload is None and reference is None:
        return None
    if not isinstance(payload, dict) or reference is None:
        raise RuntimeError(f"Cooperative checkpoint {modality} modality does not match this pipeline run")

    restored: dict[str, torch.Tensor | None] = {}
    for field in fields(LatentState):
        saved = payload.get(field.name)
        expected = getattr(reference, field.name)
        if saved is None and expected is None:
            restored[field.name] = None
            continue
        if not isinstance(saved, torch.Tensor) or not isinstance(expected, torch.Tensor):
            raise RuntimeError(f"Cooperative checkpoint has invalid {modality}.{field.name}")
        if saved.shape != expected.shape:
            raise RuntimeError(
                f"Cooperative checkpoint shape mismatch for {modality}.{field.name}: "
                f"{tuple(saved.shape)} != {tuple(expected.shape)}"
            )
        restored[field.name] = saved.to(device=expected.device, dtype=expected.dtype)
    return LatentState(**restored)


def _clear_checkpoint(root: Path) -> None:
    for name in (
        "manifest.json",
        "state.pt",
        "yield-ready.json",
        "boundary-ready.json",
        "boundary-decision.json",
    ):
        (root / name).unlink(missing_ok=True)
    _fsync_directory(root)


def restore_euler_checkpoint(
    sigmas: torch.Tensor,
    video_state: LatentState | None,
    audio_state: LatentState | None,
) -> tuple[int, int, LatentState | None, LatentState | None]:
    """Restore the matching Euler loop, returning loop index and next step."""
    loop_index = _next_loop_index()
    root = _checkpoint_root()
    fingerprint = _job_fingerprint()
    if root is None or fingerprint is None:
        return loop_index, 0, video_state, audio_state

    manifest = _read_json(root / "manifest.json")
    if manifest is None:
        return loop_index, 0, video_state, audio_state
    if manifest.get("schema_version") != CHECKPOINT_SCHEMA:
        raise RuntimeError("Unsupported cooperative checkpoint schema")
    if manifest.get("job_fingerprint") != fingerprint:
        raise RuntimeError("Cooperative checkpoint fingerprint does not match this pipeline run")

    target_loop = manifest.get("loop_index")
    if not isinstance(target_loop, int) or target_loop < 0:
        raise RuntimeError("Cooperative checkpoint has an invalid loop index")
    if loop_index < target_loop:
        return loop_index, 0, video_state, audio_state
    if loop_index > target_loop:
        raise RuntimeError("Pipeline did not reach the cooperative checkpoint at the expected Euler loop")

    state_path = root / str(manifest.get("state_file", ""))
    try:
        payload = torch.load(state_path, map_location="cpu", weights_only=True)
    except (FileNotFoundError, OSError, RuntimeError, ValueError) as error:
        raise RuntimeError(f"Cooperative checkpoint state is unreadable: {error}") from error
    if not isinstance(payload, dict):
        raise RuntimeError("Cooperative checkpoint state is invalid")
    if payload.get("schema_version") != CHECKPOINT_SCHEMA or payload.get("job_fingerprint") != fingerprint:
        raise RuntimeError("Cooperative checkpoint state metadata does not match its manifest")
    if payload.get("loop_index") != loop_index:
        raise RuntimeError("Cooperative checkpoint state has an invalid loop index")

    next_step = payload.get("next_step_index")
    if not isinstance(next_step, int) or not 0 <= next_step <= len(sigmas) - 1:
        raise RuntimeError("Cooperative checkpoint has an invalid next step")
    saved_sigmas = payload.get("sigmas")
    if not isinstance(saved_sigmas, torch.Tensor) or not torch.equal(saved_sigmas, sigmas.detach().cpu()):
        raise RuntimeError("Cooperative checkpoint diffusion schedule does not match this pipeline run")

    restored_video = _state_from_cpu(payload.get("video_state"), video_state, "video")
    restored_audio = _state_from_cpu(payload.get("audio_state"), audio_state, "audio")
    return loop_index, next_step, restored_video, restored_audio


def _checkpoint_and_yield(
    *,
    root: Path,
    fingerprint: str,
    request_id: str,
    boundary_id: str | None,
    loop_index: int,
    next_step_index: int,
    sigmas: torch.Tensor,
    video_state: LatentState | None,
    audio_state: LatentState | None,
) -> None:
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    state_file = "state.pt"
    created_at = datetime.now(timezone.utc).isoformat()
    state_payload = {
        "schema_version": CHECKPOINT_SCHEMA,
        "job_fingerprint": fingerprint,
        "loop_index": loop_index,
        "next_step_index": next_step_index,
        "boundary_id": boundary_id,
        "sigmas": sigmas.detach().to(device="cpu", copy=True),
        "video_state": _state_to_cpu(video_state),
        "audio_state": _state_to_cpu(audio_state),
    }
    _atomic_torch_save(root / state_file, state_payload)
    manifest = {
        "schema_version": CHECKPOINT_SCHEMA,
        "job_fingerprint": fingerprint,
        "loop_index": loop_index,
        "next_step_index": next_step_index,
        "state_file": state_file,
        "request_id": request_id,
        "boundary_id": boundary_id,
        "created_at": created_at,
    }
    _atomic_json(root / "manifest.json", manifest)
    _atomic_json(
        root / "yield-ready.json",
        {
            "schema_version": "ltx-cooperative-yield-ready.v1",
            "job_fingerprint": fingerprint,
            "request_id": request_id,
            "boundary_id": boundary_id,
            "manifest": str(root / "manifest.json"),
            "created_at": created_at,
        },
    )
    print(
        f"LTX_COOPERATIVE_YIELD_READY request_id={request_id} "
        f"loop={loop_index} next_step={next_step_index}",
        flush=True,
    )
    raise SystemExit(YIELD_EXIT_CODE)


def checkpoint_and_yield_if_requested(
    *,
    loop_index: int,
    next_step_index: int,
    sigmas: torch.Tensor,
    video_state: LatentState | None,
    audio_state: LatentState | None,
) -> None:
    root = _checkpoint_root()
    fingerprint = _job_fingerprint()
    if root is None or fingerprint is None:
        return

    # Legacy/local safety requests remain readable during the migration, but
    # production scheduling is decided by the canonical boundary endpoint.
    request = _read_json(root / "yield-request.json")
    if (
        request is not None
        and request.get("schema_version") == YIELD_REQUEST_SCHEMA
        and request.get("job_fingerprint") == fingerprint
        and isinstance(request.get("request_id"), str)
        and request["request_id"]
    ):
        _checkpoint_and_yield(
            root=root,
            fingerprint=fingerprint,
            request_id=request["request_id"],
            boundary_id=None,
            loop_index=loop_index,
            next_step_index=next_step_index,
            sigmas=sigmas,
            video_state=video_state,
            audio_state=audio_state,
        )

    generation = _generation()
    if generation is None:
        return
    dgx_job_id = _dgx_job_id()
    if dgx_job_id is None:
        raise RuntimeError("DGX job id is required for cooperative segment decisions")
    boundary_id = f"{generation}:{loop_index}:{next_step_index}"
    ready_path = root / "boundary-ready.json"
    decision_path = root / "boundary-decision.json"
    decision_path.unlink(missing_ok=True)
    _atomic_json(
        ready_path,
        {
            "schema_version": BOUNDARY_READY_SCHEMA,
            "job_fingerprint": fingerprint,
            "dgx_job_id": dgx_job_id,
            "generation": generation,
            "boundary_id": boundary_id,
            "loop_index": loop_index,
            "next_step_index": next_step_index,
            "ready_at": datetime.now(timezone.utc).isoformat(),
        },
    )

    deadline = time.monotonic() + _boundary_timeout_seconds()
    while time.monotonic() < deadline:
        decision = _read_json(decision_path)
        if decision is None:
            time.sleep(0.05)
            continue
        matches_boundary = (
            decision.get("schema_version") == BOUNDARY_DECISION_SCHEMA
            and decision.get("job_fingerprint") == fingerprint
            and decision.get("dgx_job_id") == dgx_job_id
            and decision.get("generation") == generation
            and decision.get("boundary_id") == boundary_id
            and isinstance(decision.get("decision_id"), str)
            and bool(decision["decision_id"])
        )
        if matches_boundary and decision.get("action") == "continue_current":
            decision_path.unlink(missing_ok=True)
            ready_path.unlink(missing_ok=True)
            _fsync_directory(root)
            return
        request_id = (
            decision["decision_id"]
            if matches_boundary and decision.get("action") == "yield_to_waiting_job"
            else f"invalid:{boundary_id}"
        )
        _checkpoint_and_yield(
            root=root,
            fingerprint=fingerprint,
            request_id=request_id,
            boundary_id=boundary_id,
            loop_index=loop_index,
            next_step_index=next_step_index,
            sigmas=sigmas,
            video_state=video_state,
            audio_state=audio_state,
        )

    _checkpoint_and_yield(
        root=root,
        fingerprint=fingerprint,
        request_id=f"timeout:{boundary_id}",
        boundary_id=boundary_id,
        loop_index=loop_index,
        next_step_index=next_step_index,
        sigmas=sigmas,
        video_state=video_state,
        audio_state=audio_state,
    )


def complete_restored_euler_loop(loop_index: int, restored_from_step: int) -> None:
    if restored_from_step <= 0:
        return
    root = _checkpoint_root()
    if root is None:
        return
    manifest = _read_json(root / "manifest.json")
    if manifest is not None and manifest.get("loop_index") == loop_index:
        _clear_checkpoint(root)
