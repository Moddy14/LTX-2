"""Deterministic control-video preprocessing for the LTX-2.3 Union-Control LoRA."""

from __future__ import annotations

import gc
import hashlib
import json
import logging
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING

import cv2
import numpy as np

if TYPE_CHECKING:
    import torch


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _revision(path: str) -> dict[str, int | str]:
    resolved = Path(path).resolve()
    details = resolved.stat()
    return {
        "path": str(resolved),
        "size": details.st_size,
        "mtime_ns": details.st_mtime_ns,
        "sha256": _sha256_file(resolved),
    }


def _cache_path(
    source_path: str,
    control_type: str,
    cache_dir: str,
    max_frames: int,
    moge_model_path: str | None,
) -> Path:
    payload: dict[str, object] = {
        "version": 2,
        "source": _revision(source_path),
        "control_type": control_type,
        "max_frames": max_frames,
    }
    if control_type == "depth" and moge_model_path:
        payload["moge"] = _revision(moge_model_path)
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return Path(cache_dir) / f"{control_type}-{digest}.mp4"


def _open_video(path: str) -> tuple[cv2.VideoCapture, float, int, int]:
    capture = cv2.VideoCapture(path)
    if not capture.isOpened():
        raise ValueError(f"Kontrollvideo ist nicht lesbar: {path}")
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if not np.isfinite(fps) or fps <= 0 or width <= 0 or height <= 0:
        capture.release()
        raise ValueError(f"Kontrollvideo besitzt keine verwertbaren Metadaten: {path}")
    return capture, fps, width, height


def _writer(path: Path, fps: float, width: int, height: int) -> cv2.VideoWriter:
    writer = cv2.VideoWriter(
        str(path),
        cv2.VideoWriter_fourcc(*"mp4v"),
        fps,
        (width, height),
    )
    if not writer.isOpened():
        raise RuntimeError(f"Kontrollvideo-Ausgabe konnte nicht geöffnet werden: {path}")
    return writer


def _frames(capture: cv2.VideoCapture, max_frames: int) -> Iterator[np.ndarray]:
    for _ in range(max_frames):
        ok, frame = capture.read()
        if not ok:
            break
        yield frame


def _write_canny(source_path: str, target_path: Path, max_frames: int) -> None:
    capture, fps, width, height = _open_video(source_path)
    writer = _writer(target_path, fps, width, height)
    written = 0
    try:
        for frame in _frames(capture, max_frames):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            median = float(np.median(gray))
            lower = int(max(0, 0.66 * median))
            upper = int(min(255, max(lower + 1, 1.33 * median)))
            edges = cv2.Canny(gray, lower, upper, L2gradient=True)
            writer.write(cv2.cvtColor(edges, cv2.COLOR_GRAY2BGR))
            written += 1
    finally:
        capture.release()
        writer.release()
    if written == 0:
        raise ValueError(f"Kontrollvideo enthält keine dekodierbaren Frames: {source_path}")


def _depth_to_u8(depth: torch.Tensor) -> list[np.ndarray]:
    import torch

    frames: list[np.ndarray] = []
    for frame in depth.float():
        valid = torch.isfinite(frame) & (frame > 0)
        if not bool(valid.any()):
            normalized = torch.zeros_like(frame)
        else:
            disparity = torch.where(valid, 1.0 / frame.clamp_min(1e-6), torch.zeros_like(frame))
            values = disparity[valid]
            low = torch.quantile(values, 0.001)
            high = torch.quantile(values, 0.999)
            normalized = ((disparity - low) / (high - low).clamp_min(1e-6)).clamp(0.0, 1.0)
            normalized = torch.where(valid, normalized, torch.zeros_like(normalized))
        gray = (normalized.mul(255).round().byte().cpu().numpy())
        frames.append(cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR))
    return frames


def _write_moge_depth(
    source_path: str,
    target_path: Path,
    max_frames: int,
    moge_model_path: str,
    comfy_root: str,
    batch_size: int = 4,
) -> None:
    import torch

    comfy_path = os.path.realpath(comfy_root)
    if comfy_path not in sys.path:
        sys.path.insert(0, comfy_path)
    import comfy.model_management
    import comfy.utils
    from comfy.ldm.moge.model import MoGeModel

    state_dict = comfy.utils.load_torch_file(moge_model_path, safe_load=True)
    model = MoGeModel(state_dict)
    del state_dict

    capture, fps, width, height = _open_video(source_path)
    writer = _writer(target_path, fps, width, height)
    batch: list[np.ndarray] = []
    written = 0

    def flush() -> None:
        nonlocal written
        if not batch:
            return
        rgb = np.stack([cv2.cvtColor(frame, cv2.COLOR_BGR2RGB) for frame in batch])
        tensor = torch.from_numpy(rgb).permute(0, 3, 1, 2).float().div_(255)
        result = model.infer(
            tensor,
            resolution_level=9,
            fov_x=None,
            force_projection=True,
            apply_mask=True,
        )
        for output in _depth_to_u8(result["depth"]):
            writer.write(output)
            written += 1
        batch.clear()

    try:
        for frame in _frames(capture, max_frames):
            batch.append(frame)
            if len(batch) >= batch_size:
                flush()
        flush()
    finally:
        capture.release()
        writer.release()
        model = None
        comfy.model_management.unload_all_models()
        comfy.model_management.soft_empty_cache()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    if written == 0:
        raise ValueError(f"Kontrollvideo enthält keine dekodierbaren Frames: {source_path}")


def preprocess_control_video(
    source_path: str,
    control_type: str,
    cache_dir: str,
    max_frames: int,
    *,
    moge_model_path: str | None = None,
    comfy_root: str = "/home/moddy/ComfyUI",
) -> str:
    if control_type in {"prepared", "pose"}:
        return source_path
    if control_type not in {"depth", "canny"}:
        raise ValueError(f"Unbekannte Kontrollaufbereitung: {control_type}")
    if control_type == "depth" and not moge_model_path:
        raise ValueError("MoGe-Modellpfad fehlt für die Tiefenaufbereitung.")

    output_path = _cache_path(source_path, control_type, cache_dir, max_frames, moge_model_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.is_file() and output_path.stat().st_size > 0:
        logging.info("[Union-Control] Wiederverwendete Kontrollmap: %s", output_path)
        return str(output_path)

    partial_path = output_path.with_name(f".{output_path.stem}.{os.getpid()}.partial.mp4")
    try:
        if control_type == "canny":
            _write_canny(source_path, partial_path, max_frames)
        else:
            _write_moge_depth(
                source_path,
                partial_path,
                max_frames,
                moge_model_path=moge_model_path or "",
                comfy_root=comfy_root,
            )
        if partial_path.stat().st_size <= 0:
            raise RuntimeError("Kontrollaufbereitung erzeugte eine leere Datei.")
        partial_path.replace(output_path)
    finally:
        partial_path.unlink(missing_ok=True)

    logging.info("[Union-Control] Kontrollmap erzeugt: %s", output_path)
    return str(output_path)
