from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

from ltx_pipelines.utils.control_preprocess import _cache_path, preprocess_control_video


def _write_test_video(path: Path) -> None:
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 24, (64, 64))
    assert writer.isOpened()
    try:
        for offset in (8, 16, 24):
            frame = np.zeros((64, 64, 3), dtype=np.uint8)
            cv2.rectangle(frame, (offset, 12), (offset + 24, 52), (255, 255, 255), -1)
            writer.write(frame)
    finally:
        writer.release()


def test_canny_control_preprocessor_is_cached_and_preserves_video_shape(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    cache = tmp_path / "cache"
    _write_test_video(source)

    first = preprocess_control_video(str(source), "canny", str(cache), max_frames=3)
    second = preprocess_control_video(str(source), "canny", str(cache), max_frames=3)

    assert first == second
    assert Path(first).is_file()
    capture = cv2.VideoCapture(first)
    try:
        assert capture.isOpened()
        assert int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)) == 64
        assert int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT)) == 64
        assert int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) == 3
    finally:
        capture.release()


def test_control_cache_key_tracks_content_when_size_and_mtime_match(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"first-version")
    original_stat = source.stat()
    first = _cache_path(str(source), "canny", str(tmp_path / "cache"), 3, None)

    source.write_bytes(b"other-version")
    os.utime(source, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    second = _cache_path(str(source), "canny", str(tmp_path / "cache"), 3, None)

    assert source.stat().st_size == original_stat.st_size
    assert source.stat().st_mtime_ns == original_stat.st_mtime_ns
    assert first != second
