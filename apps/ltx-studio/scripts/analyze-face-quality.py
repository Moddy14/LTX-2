#!/usr/bin/env python3
"""Bounded CPU-only YuNet and SFace measurements for one Studio output."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import hashlib
import json
import math
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from pathlib import Path

FACE_MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
IDENTITY_MODEL_SHA256 = "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79"
IDENTITY_MODEL_REVISION = "3d7082438a6e4551e840c9b2bb60b71e8da4b524"
IDENTITY_MODEL_NAME = "OpenCV SFace 2021dec"
# OpenCV's published same-identity operating point. This is only a guard against
# combining unrelated references, never an output quality or SOTA threshold.
SFACE_REFERENCE_CONSISTENCY_FLOOR = 0.363
TRACK_IDENTITY_AMBIGUITY_MARGIN = 0.03
TRACK_MAX_MISSED_SAMPLES = 3
MAX_SNAPSHOT_FILE_BYTES = 2 * 1024**3
MAX_SNAPSHOT_TOTAL_BYTES = 4 * 1024**3
MIN_SNAPSHOT_FREE_RESERVE_BYTES = 512 * 1024**2


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    if lower == upper:
        return float(ordered[lower])
    weight = position - lower
    return float(ordered[lower] * (1 - weight) + ordered[upper] * weight)


def median(values: list[float]) -> float | None:
    return percentile(values, 0.5)


def coefficient_of_variation(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    center = sum(values) / len(values)
    if abs(center) < 1e-9:
        return None
    variance = sum((value - center) ** 2 for value in values) / len(values)
    return float(math.sqrt(variance) / abs(center))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular_file_size(path: Path, label: str) -> int:
    try:
        source_stat = path.lstat()
    except FileNotFoundError as error:
        raise FileNotFoundError(f"{label} missing: {path}") from error
    if stat.S_ISLNK(source_stat.st_mode) or not stat.S_ISREG(source_stat.st_mode):
        raise RuntimeError(f"{label} must be a regular non-symlink file: {path}")
    if source_stat.st_size <= 0:
        raise RuntimeError(f"{label} is empty: {path}")
    if source_stat.st_size > MAX_SNAPSHOT_FILE_BYTES:
        raise RuntimeError(
            f"{label} exceeds the {MAX_SNAPSHOT_FILE_BYTES}-byte analysis snapshot limit: {path}"
        )
    return source_stat.st_size


def enforce_snapshot_budget(
    sources: list[tuple[Path, str]],
    snapshot_root: Path,
) -> int:
    total_bytes = sum(regular_file_size(path, label) for path, label in sources)
    if total_bytes > MAX_SNAPSHOT_TOTAL_BYTES:
        raise RuntimeError(
            f"Analysis inputs require {total_bytes} snapshot bytes; "
            f"limit is {MAX_SNAPSHOT_TOTAL_BYTES}"
        )
    free_bytes = shutil.disk_usage(snapshot_root).free
    required_bytes = total_bytes + MIN_SNAPSHOT_FREE_RESERVE_BYTES
    if free_bytes < required_bytes:
        raise RuntimeError(
            f"Analysis snapshot needs {required_bytes} free bytes including reserve; "
            f"only {free_bytes} are available"
        )
    return total_bytes


@contextmanager
def analysis_snapshot_root():
    configured = os.environ.get("LTX_STUDIO_ANALYSIS_TEMP_DIR", "").strip()
    if not configured:
        with tempfile.TemporaryDirectory(prefix="ltx-objective-") as temporary_root:
            yield Path(temporary_root)
        return
    snapshot_root = Path(configured).expanduser().absolute()
    root_stat = snapshot_root.lstat()
    if stat.S_ISLNK(root_stat.st_mode) or not stat.S_ISDIR(root_stat.st_mode):
        raise RuntimeError("Configured analysis temp path must be a regular directory")
    os.chmod(snapshot_root, 0o700)
    yield snapshot_root


def snapshot_verified_file(
    source: Path,
    destination: Path,
    label: str,
    expected_sha256: str | None = None,
) -> tuple[Path, str]:
    regular_file_size(source, label)

    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(source, flags)
    digest = hashlib.sha256()
    try:
        before = os.fstat(descriptor)
        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with destination.open("xb") as target:
            os.chmod(destination, 0o600)
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)

    stable_revision = (
        before.st_dev == after.st_dev
        and before.st_ino == after.st_ino
        and before.st_size == after.st_size
        and before.st_mtime_ns == after.st_mtime_ns
        and before.st_ctime_ns == after.st_ctime_ns
        and destination.stat().st_size == after.st_size
    )
    if not stable_revision:
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"{label} changed while it was snapshotted: {source}")
    actual_sha256 = digest.hexdigest()
    if expected_sha256 is not None and actual_sha256 != expected_sha256:
        destination.unlink(missing_ok=True)
        raise RuntimeError(f"Unexpected {label} checksum: {source}")
    os.chmod(destination, 0o400)
    return destination, actual_sha256


def verify_snapshot(path: Path, expected_sha256: str, label: str) -> None:
    if file_sha256(path) != expected_sha256:
        raise RuntimeError(f"{label} snapshot changed during analysis")


def finite_number(value: object) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def positive_number(value: object) -> float | None:
    parsed = finite_number(value)
    return parsed if parsed is not None and parsed > 0 else None


def parse_rate(value: object) -> float | None:
    if not isinstance(value, str) or value == "0/0":
        return None
    parts = value.split("/", 1)
    if len(parts) == 1:
        return positive_number(parts[0])
    numerator = finite_number(parts[0])
    denominator = positive_number(parts[1])
    if numerator is None or denominator is None:
        return None
    return positive_number(numerator / denominator)


def probe_constant_frame_rate(video_path: Path) -> bool | None:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "frame=best_effort_timestamp_time",
            "-of",
            "json",
            str(video_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=20,
    )
    if result.returncode != 0:
        return None
    try:
        body = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    frames = body.get("frames") if isinstance(body.get("frames"), list) else []
    timestamps = [
        timestamp
        for frame in frames
        if isinstance(frame, dict)
        and (timestamp := finite_number(frame.get("best_effort_timestamp_time"))) is not None
    ]
    if len(timestamps) < 3:
        return None
    deltas = [right - left for left, right in zip(timestamps, timestamps[1:])]
    if len(deltas) != len(timestamps) - 1 or any(delta <= 0 for delta in deltas):
        return False
    center = median(deltas)
    if center is None or center <= 0:
        return None
    tolerance = max(0.0005, center * 0.02)
    return max(abs(delta - center) for delta in deltas) <= tolerance


def probe_technical(video_path: Path) -> dict[str, object]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-count_frames",
            "-show_entries",
            "format=duration:"
            "stream=codec_type,nb_read_frames,nb_frames,avg_frame_rate,r_frame_rate,"
            "duration,start_time",
            "-of",
            "json",
            str(video_path),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr[-500:]}")
    body = json.loads(result.stdout)
    streams = body.get("streams") if isinstance(body.get("streams"), list) else []
    video_streams = [item for item in streams if item.get("codec_type") == "video"]
    audio_streams = [item for item in streams if item.get("codec_type") == "audio"]
    if not video_streams:
        raise RuntimeError("Video stream missing")
    video = video_streams[0]
    audio = audio_streams[0] if audio_streams else None
    average_fps = parse_rate(video.get("avg_frame_rate"))
    nominal_fps = parse_rate(video.get("r_frame_rate"))
    fps = average_fps or nominal_fps
    format_body = body.get("format") if isinstance(body.get("format"), dict) else {}
    format_duration = positive_number(format_body.get("duration"))
    video_duration = positive_number(video.get("duration")) or format_duration
    audio_duration = positive_number(audio.get("duration")) if audio else None
    frames_value = (
        positive_number(video.get("nb_read_frames"))
        or positive_number(video.get("nb_frames"))
        or (video_duration * fps if video_duration is not None and fps is not None else None)
    )
    video_start = finite_number(video.get("start_time"))
    audio_start = finite_number(audio.get("start_time")) if audio else None
    return {
        "durationSeconds": video_duration,
        "fps": fps,
        "frames": int(round(frames_value)) if frames_value is not None else None,
        "hasAudio": bool(audio_streams),
        "constantFrameRate": probe_constant_frame_rate(video_path),
        "audioVideoDurationDeltaSeconds": (
            abs(video_duration - audio_duration)
            if video_duration is not None and audio_duration is not None
            else None
        ),
        "audioVideoStartDeltaSeconds": (
            abs(video_start - audio_start)
            if video_start is not None and audio_start is not None
            else None
        ),
    }


def normalized_geometry(points: object):
    import numpy as np

    landmarks = np.asarray(points, dtype=np.float64)
    if landmarks.shape != (5, 2) or not bool(np.isfinite(landmarks).all()):
        return None
    right_eye, left_eye, nose, right_mouth, left_mouth = landmarks
    eye_vector = left_eye - right_eye
    eye_span = float(np.linalg.norm(eye_vector))
    mouth_vector = left_mouth - right_mouth
    mouth_span = float(np.linalg.norm(mouth_vector))
    if eye_span < 8 or mouth_span < 6:
        return None
    eye_center = (right_eye + left_eye) * 0.5
    x_axis = eye_vector / eye_span
    y_axis = np.asarray([-x_axis[1], x_axis[0]], dtype=np.float64)

    def normalize(point: object):
        offset = np.asarray(point, dtype=np.float64) - eye_center
        return np.asarray(
            [float(np.dot(offset, x_axis) / eye_span), float(np.dot(offset, y_axis) / eye_span)],
            dtype=np.float64,
        )

    mouth_center = (right_mouth + left_mouth) * 0.5
    eye_angle = math.atan2(float(eye_vector[1]), float(eye_vector[0]))
    mouth_angle = math.atan2(float(mouth_vector[1]), float(mouth_vector[0]))
    relative_angle = math.atan2(
        math.sin(mouth_angle - eye_angle),
        math.cos(mouth_angle - eye_angle),
    )
    return {
        "nose": normalize(nose),
        "mouth_center": normalize(mouth_center),
        "mouth_span": mouth_span / eye_span,
        "mouth_angle_degrees": math.degrees(relative_angle),
        "eye_span": eye_span,
    }


def analyze(video_path: Path, model_path: Path, max_frames: int) -> dict[str, object]:
    import cv2
    import numpy as np

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Video cannot be decoded: {video_path}")
    total_frames = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT))))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if not math.isfinite(fps) or fps <= 0:
        fps = 24.0
    stride = max(1, math.ceil(total_frames / max_frames)) if total_frames > 0 else 1
    detector = cv2.FaceDetectorYN.create(str(model_path), "", (320, 320), 0.55, 0.3, 5000)

    sampled = 0
    detected = 0
    valid = 0
    confidences: list[float] = []
    eye_spans: list[float] = []
    face_areas: list[float] = []
    nose_positions: list[tuple[float, object]] = []
    mouth_angles: list[tuple[float, float]] = []
    mouth_spans: list[float] = []
    previous_center = None
    frame_index = 0

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % stride != 0:
                frame_index += 1
                continue
            sampled += 1
            position_ms = finite_number(capture.get(cv2.CAP_PROP_POS_MSEC))
            timestamp = (
                position_ms / 1000.0
                if position_ms is not None and position_ms >= 0
                else frame_index / fps
            )
            height, width = frame.shape[:2]
            detector.setInputSize((width, height))
            _result, faces = detector.detect(frame)
            if faces is not None and len(faces) > 0:
                candidates = [face for face in faces if float(face[14]) >= 0.55]
                if candidates:
                    if previous_center is None:
                        selected = max(candidates, key=lambda face: float(face[2] * face[3]))
                    else:
                        def candidate_score(face: object) -> float:
                            points = np.asarray(face[4:14], dtype=np.float64).reshape(5, 2)
                            center = points.mean(axis=0)
                            distance = float(np.linalg.norm(center - previous_center))
                            scale = max(float(face[2]), float(face[3]), 1.0)
                            return float(face[2] * face[3]) - distance * scale * 1.8

                        selected = max(candidates, key=candidate_score)
                    points = np.asarray(selected[4:14], dtype=np.float64).reshape(5, 2)
                    previous_center = points.mean(axis=0)
                    detected += 1
                    confidences.append(float(selected[14]))
                    face_areas.append(float(selected[2] * selected[3]) / max(float(width * height), 1.0))
                    geometry = normalized_geometry(points)
                    if geometry is not None:
                        valid += 1
                        eye_spans.append(float(geometry["eye_span"]))
                        nose_positions.append((timestamp, geometry["nose"]))
                        mouth_angles.append((timestamp, float(geometry["mouth_angle_degrees"])))
                        mouth_spans.append(float(geometry["mouth_span"]))
            frame_index += 1
            if sampled >= max_frames:
                break
    finally:
        capture.release()

    nose_velocities: list[float] = []
    for (time_a, point_a), (time_b, point_b) in zip(nose_positions, nose_positions[1:]):
        elapsed = time_b - time_a
        if elapsed > 0:
            nose_velocities.append(float(np.linalg.norm(point_b - point_a) / elapsed))
    nose_accelerations: list[float] = []
    velocity_times: list[float] = []
    for index, velocity in enumerate(nose_velocities):
        velocity_times.append((nose_positions[index][0] + nose_positions[index + 1][0]) * 0.5)
    for (time_a, velocity_a), (time_b, velocity_b) in zip(
        zip(velocity_times, nose_velocities),
        zip(velocity_times[1:], nose_velocities[1:]),
    ):
        elapsed = time_b - time_a
        if elapsed > 0:
            nose_accelerations.append(abs(velocity_b - velocity_a) / elapsed)
    mouth_angle_velocities: list[float] = []
    for (time_a, angle_a), (time_b, angle_b) in zip(mouth_angles, mouth_angles[1:]):
        elapsed = time_b - time_a
        if elapsed > 0:
            delta = (angle_b - angle_a + 180.0) % 360.0 - 180.0
            mouth_angle_velocities.append(abs(delta) / elapsed)

    return {
        "sampledFrames": sampled,
        "detectedFrames": detected,
        "validGeometryFrames": valid,
        "detectionCoverage": detected / sampled if sampled else 0.0,
        "geometryCoverage": valid / sampled if sampled else 0.0,
        "medianConfidence": median(confidences),
        "medianEyeSpanPixels": median(eye_spans),
        "medianFaceAreaRatio": median(face_areas),
        "noseVelocityP95PerSecond": percentile(nose_velocities, 0.95),
        "noseAccelerationP95PerSecond2": percentile(nose_accelerations, 0.95),
        "mouthAngleMedianDegrees": median([angle for _time, angle in mouth_angles]),
        "mouthAngleVelocityP95DegreesPerSecond": percentile(mouth_angle_velocities, 0.95),
        "mouthSpanCoefficientOfVariation": coefficient_of_variation(mouth_spans),
    }


def blank_identity(status: str) -> dict[str, object]:
    return {
        "status": status,
        "error": None,
        "modelName": None,
        "modelSha256": None,
        "modelRevision": None,
        "preprocessingVersion": None,
        "embeddingDimensions": None,
        "referenceCount": 0,
        "sampledReferenceFrames": 0,
        "embeddedReferenceFrames": 0,
        "sampledOutputFrames": 0,
        "matchedOutputFrames": 0,
        "outputCoverage": 0.0,
        "ambiguousOutputFrames": 0,
        "referenceSelfConsistencyMedian": None,
        "referenceSelfConsistencyP10": None,
        "cosineMedian": None,
        "cosineP10": None,
        "cosineMinimum": None,
        "outputTemporalConsistencyMedian": None,
    }


def normalized_embedding(recognizer: object, frame: object, face: object):
    import numpy as np

    aligned = recognizer.alignCrop(frame, np.asarray(face, dtype=np.float32))
    feature = np.asarray(recognizer.feature(aligned), dtype=np.float64).reshape(-1)
    if feature.shape != (128,) or not bool(np.isfinite(feature).all()):
        return None
    length = float(np.linalg.norm(feature))
    if length <= 1e-9:
        return None
    return feature / length


def detect_face_embeddings(detector: object, recognizer: object, frame: object):
    import numpy as np

    height, width = frame.shape[:2]
    detector.setInputSize((width, height))
    _result, faces = detector.detect(frame)
    candidates = []
    if faces is None:
        return candidates
    for face in faces:
        if float(face[14]) < 0.55:
            continue
        embedding = normalized_embedding(recognizer, frame, face)
        if embedding is None:
            continue
        x = float(face[0]) / max(float(width), 1.0)
        y = float(face[1]) / max(float(height), 1.0)
        box_width = float(face[2]) / max(float(width), 1.0)
        box_height = float(face[3]) / max(float(height), 1.0)
        candidates.append({
            "embedding": embedding,
            "landmarks": np.asarray(face[4:14], dtype=np.float64).reshape(5, 2),
            "confidence": float(face[14]),
            "area": float(face[2] * face[3]),
            "area_ratio": max(0.0, box_width * box_height),
            "box": np.asarray(
                [x, y, box_width, box_height],
                dtype=np.float64,
            ),
            "center": np.asarray([x + box_width * 0.5, y + box_height * 0.5], dtype=np.float64),
        })
    return candidates


def box_iou(left: object, right: object) -> float:
    import numpy as np

    left_box = np.asarray(left, dtype=np.float64)
    right_box = np.asarray(right, dtype=np.float64)
    left_end = left_box[:2] + left_box[2:]
    right_end = right_box[:2] + right_box[2:]
    intersection_start = np.maximum(left_box[:2], right_box[:2])
    intersection_end = np.minimum(left_end, right_end)
    intersection_size = np.maximum(intersection_end - intersection_start, 0.0)
    intersection = float(intersection_size[0] * intersection_size[1])
    union = float(left_box[2] * left_box[3] + right_box[2] * right_box[3] - intersection)
    return intersection / union if union > 1e-12 else 0.0


def normalized_center_distance(left: dict[str, object], right: dict[str, object]) -> float:
    import numpy as np

    scale = max(
        math.sqrt(float(left["area_ratio"])),
        math.sqrt(float(right["area_ratio"])),
        1e-6,
    )
    return float(np.linalg.norm(left["center"] - right["center"]) / scale)


def choose_initial_output_candidate(
    candidates: list[dict[str, object]],
    template: object,
) -> tuple[dict[str, object] | None, bool]:
    if not candidates:
        return None, False
    by_area = sorted(candidates, key=lambda item: float(item["area_ratio"]), reverse=True)
    if (
        len(by_area) == 1
        or float(by_area[0]["area_ratio"]) >= float(by_area[1]["area_ratio"]) * 1.5
    ):
        if cosine(by_area[0]["embedding"], template) >= SFACE_REFERENCE_CONSISTENCY_FLOOR:
            return by_area[0], False
    ranked = sorted(
        (
            (
                cosine(item["embedding"], template),
                math.sqrt(max(float(item["area_ratio"]), 0.0)),
                -math.dist(item["center"], [0.5, 0.5]),
                item,
            )
            for item in candidates
        ),
        key=lambda item: item[:3],
        reverse=True,
    )
    if len(ranked) > 1:
        identity_margin = ranked[0][0] - ranked[1][0]
        area_ratio = (
            float(ranked[0][3]["area_ratio"])
            / max(float(ranked[1][3]["area_ratio"]), 1e-9)
        )
        if identity_margin < TRACK_IDENTITY_AMBIGUITY_MARGIN and area_ratio < 1.5:
            return None, True
    return ranked[0][3], False


def choose_continuous_candidate(
    candidates: list[dict[str, object]],
    previous: dict[str, object],
    template: object,
    missed_samples: int,
) -> tuple[dict[str, object] | None, bool]:
    viable: list[tuple[float, dict[str, object]]] = []
    distance_limit = 1.6 + min(missed_samples, TRACK_MAX_MISSED_SAMPLES) * 0.45
    for candidate in candidates:
        overlap = box_iou(previous["box"], candidate["box"])
        center_distance = normalized_center_distance(previous, candidate)
        area_ratio = float(candidate["area_ratio"]) / max(float(previous["area_ratio"]), 1e-9)
        appearance = cosine(previous["embedding"], candidate["embedding"])
        if not 0.2 <= area_ratio <= 5.0:
            continue
        if overlap < 0.02 and center_distance > distance_limit:
            continue
        if appearance < -0.1 and overlap < 0.2:
            continue
        template_similarity = cosine(candidate["embedding"], template)
        score = (
            overlap * 0.45
            + appearance * 0.30
            + template_similarity * 0.20
            - min(center_distance, 4.0) * 0.05
        )
        viable.append((score, candidate))
    viable.sort(key=lambda item: item[0], reverse=True)
    if not viable:
        return None, bool(candidates)
    if len(viable) > 1 and viable[0][0] - viable[1][0] < 0.04:
        return None, True
    return viable[0][1], False


def track_output_identity(
    sampled_candidates: list[list[dict[str, object]]],
    template: object,
) -> tuple[list[dict[str, object]], int]:
    selected: list[dict[str, object]] = []
    previous: dict[str, object] | None = None
    missed_samples = 0
    ambiguous_frames = 0
    for candidates in sampled_candidates:
        if previous is None:
            candidate, ambiguous = choose_initial_output_candidate(candidates, template)
        else:
            candidate, ambiguous = choose_continuous_candidate(
                candidates,
                previous,
                template,
                missed_samples,
            )
        if ambiguous:
            ambiguous_frames += 1
        if candidate is None:
            missed_samples += 1
            if previous is not None and missed_samples > TRACK_MAX_MISSED_SAMPLES:
                # Never jump to a new face after losing the target. A shorter
                # trusted track is safer than a high score assembled from people.
                previous = None
            continue
        if previous is None and selected:
            ambiguous_frames += 1
            break
        selected.append(candidate)
        previous = candidate
        missed_samples = 0
    return selected, ambiguous_frames


def iter_sampled_video_frames_with_time(path: Path, max_frames: int):
    import cv2

    capture = cv2.VideoCapture(str(path))
    if not capture.isOpened():
        raise RuntimeError(f"Video cannot be decoded: {path}")
    total_frames = max(0, int(round(capture.get(cv2.CAP_PROP_FRAME_COUNT))))
    fps = float(capture.get(cv2.CAP_PROP_FPS))
    if not math.isfinite(fps) or fps <= 0:
        fps = 24.0
    stride = max(1, math.ceil(total_frames / max_frames)) if total_frames > 0 else 1
    sampled = 0
    frame_index = 0
    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                break
            if frame_index % stride == 0:
                position_ms = finite_number(capture.get(cv2.CAP_PROP_POS_MSEC))
                timestamp = (
                    position_ms / 1000.0
                    if position_ms is not None and position_ms >= 0
                    else frame_index / fps
                )
                yield frame, timestamp
                sampled += 1
                if sampled >= max_frames:
                    break
            frame_index += 1
    finally:
        capture.release()


def iter_sampled_video_frames(path: Path, max_frames: int):
    for frame, _timestamp in iter_sampled_video_frames_with_time(path, max_frames):
        yield frame


def face_metrics_from_tracked_candidates(
    sampled_frames: int,
    tracked_candidates: list[dict[str, object]],
) -> dict[str, object]:
    import numpy as np

    confidences: list[float] = []
    eye_spans: list[float] = []
    face_areas: list[float] = []
    nose_positions: list[tuple[float, object]] = []
    mouth_angles: list[tuple[float, float]] = []
    mouth_spans: list[float] = []
    valid = 0
    for candidate in tracked_candidates:
        confidences.append(float(candidate["confidence"]))
        face_areas.append(float(candidate["area_ratio"]))
        geometry = normalized_geometry(candidate["landmarks"])
        if geometry is None:
            continue
        valid += 1
        timestamp = float(candidate["timestamp"])
        eye_spans.append(float(geometry["eye_span"]))
        nose_positions.append((timestamp, geometry["nose"]))
        mouth_angles.append((timestamp, float(geometry["mouth_angle_degrees"])))
        mouth_spans.append(float(geometry["mouth_span"]))

    nose_velocities: list[float] = []
    for (time_a, point_a), (time_b, point_b) in zip(nose_positions, nose_positions[1:]):
        elapsed = time_b - time_a
        if elapsed > 0:
            nose_velocities.append(float(np.linalg.norm(point_b - point_a) / elapsed))
    nose_accelerations: list[float] = []
    velocity_times = [
        (nose_positions[index][0] + nose_positions[index + 1][0]) * 0.5
        for index in range(len(nose_velocities))
    ]
    for (time_a, velocity_a), (time_b, velocity_b) in zip(
        zip(velocity_times, nose_velocities),
        zip(velocity_times[1:], nose_velocities[1:]),
    ):
        elapsed = time_b - time_a
        if elapsed > 0:
            nose_accelerations.append(abs(velocity_b - velocity_a) / elapsed)
    mouth_angle_velocities: list[float] = []
    for (time_a, angle_a), (time_b, angle_b) in zip(mouth_angles, mouth_angles[1:]):
        elapsed = time_b - time_a
        if elapsed > 0:
            delta = (angle_b - angle_a + 180.0) % 360.0 - 180.0
            mouth_angle_velocities.append(abs(delta) / elapsed)

    detected = len(tracked_candidates)
    return {
        "sampledFrames": sampled_frames,
        "detectedFrames": detected,
        "validGeometryFrames": valid,
        "detectionCoverage": detected / sampled_frames if sampled_frames else 0.0,
        "geometryCoverage": valid / sampled_frames if sampled_frames else 0.0,
        "medianConfidence": median(confidences),
        "medianEyeSpanPixels": median(eye_spans),
        "medianFaceAreaRatio": median(face_areas),
        "noseVelocityP95PerSecond": percentile(nose_velocities, 0.95),
        "noseAccelerationP95PerSecond2": percentile(nose_accelerations, 0.95),
        "mouthAngleMedianDegrees": median([angle for _time, angle in mouth_angles]),
        "mouthAngleVelocityP95DegreesPerSecond": percentile(mouth_angle_velocities, 0.95),
        "mouthSpanCoefficientOfVariation": coefficient_of_variation(mouth_spans),
    }


def iter_reference_frames(path: Path, max_frames: int):
    import cv2

    if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}:
        frame = cv2.imread(str(path), cv2.IMREAD_COLOR)
        if frame is None:
            raise RuntimeError(f"Reference image cannot be decoded: {path}")
        yield frame
        return
    yield from iter_sampled_video_frames(path, max_frames)


def cosine(left: object, right: object) -> float:
    import numpy as np

    return float(np.clip(np.dot(left, right), -1.0, 1.0))


def embedding_medoid(embeddings: list[object]):
    import numpy as np

    matrix = np.stack(embeddings)
    similarities = matrix @ matrix.T
    return embeddings[int(np.argmax(np.mean(similarities, axis=1)))]


def build_reference_template(
    reference_groups: list[list[object]],
) -> tuple[object | None, list[float], bool]:
    if not reference_groups or any(not group for group in reference_groups):
        return None, [], False
    per_reference_templates = [embedding_medoid(group) for group in reference_groups]
    template = embedding_medoid(per_reference_templates)
    similarities = [
        cosine(embedding, template)
        for group in reference_groups
        for embedding in group
    ]
    consistent = bool(similarities) and min(similarities) >= SFACE_REFERENCE_CONSISTENCY_FLOOR
    return template, similarities, consistent


def choose_reference_candidate(candidates: list[dict[str, object]], anchor: object | None):
    if not candidates:
        return None
    if anchor is None:
        return candidates[0] if len(candidates) == 1 else None
    ranked = sorted(
        ((cosine(item["embedding"], anchor), item) for item in candidates),
        key=lambda pair: pair[0],
        reverse=True,
    )
    if len(ranked) > 1 and ranked[0][0] - ranked[1][0] < 0.03:
        return None
    return ranked[0][1]


def track_reference_identity(
    sampled_candidates: list[list[dict[str, object]]],
    anchor: object | None,
) -> tuple[list[dict[str, object]], int]:
    selected: list[dict[str, object]] = []
    previous: dict[str, object] | None = None
    template = anchor
    missed_samples = 0
    ambiguous_frames = 0
    for candidates in sampled_candidates:
        if previous is None:
            if selected:
                ambiguous_frames += 1
                break
            candidate = choose_reference_candidate(candidates, anchor)
            ambiguous = bool(candidates) and candidate is None
        else:
            candidate, ambiguous = choose_continuous_candidate(
                candidates,
                previous,
                template,
                missed_samples,
            )
        if ambiguous:
            ambiguous_frames += 1
        if candidate is None:
            missed_samples += 1
            if previous is not None and missed_samples > TRACK_MAX_MISSED_SAMPLES:
                previous = None
            continue
        selected.append(candidate)
        previous = candidate
        template = anchor if anchor is not None else candidate["embedding"]
        missed_samples = 0
    return selected, ambiguous_frames


def analyze_identity(
    video_path: Path,
    face_model_path: Path,
    identity_model_path: Path,
    identity_status: str,
    references: list[tuple[Path, str]],
    max_frames: int,
) -> tuple[dict[str, object], list[dict[str, object]], int]:
    import cv2

    if identity_status == "not-applicable":
        return blank_identity("not-applicable"), [], 0
    if identity_status != "available":
        return blank_identity("reference-provenance-missing"), [], 0

    detector = cv2.FaceDetectorYN.create(str(face_model_path), "", (320, 320), 0.55, 0.3, 5000)
    recognizer = cv2.FaceRecognizerSF.create(str(identity_model_path), "")
    reference_embeddings: list[object] = []
    reference_groups: list[list[object]] = []
    sampled_reference_frames = 0

    for reference_path, expected_sha256 in references:
        prior_templates = [embedding_medoid(group) for group in reference_groups if group]
        anchor = embedding_medoid(prior_templates) if prior_templates else None
        sampled_candidates = [
            detect_face_embeddings(detector, recognizer, frame)
            for frame in iter_reference_frames(reference_path, 16)
        ]
        sampled_reference_frames += len(sampled_candidates)
        tracked_reference, ambiguous_reference_frames = track_reference_identity(
            sampled_candidates,
            anchor,
        )
        reference_coverage = (
            len(tracked_reference) / len(sampled_candidates)
            if sampled_candidates
            else 0.0
        )
        per_reference_embeddings = [
            selected["embedding"]
            for selected in tracked_reference
        ] if ambiguous_reference_frames == 0 and reference_coverage >= 0.5 else []
        verify_snapshot(reference_path, expected_sha256, "Identity reference")
        if per_reference_embeddings:
            reference_embeddings.extend(per_reference_embeddings)
        reference_groups.append(per_reference_embeddings)

    base = blank_identity("insufficient")
    base.update({
        "modelName": IDENTITY_MODEL_NAME,
        "modelSha256": IDENTITY_MODEL_SHA256,
        "modelRevision": IDENTITY_MODEL_REVISION,
        "preprocessingVersion": "yunet5-aligncrop-112-track.v2",
        "embeddingDimensions": 128,
        "referenceCount": len(references),
        "sampledReferenceFrames": sampled_reference_frames,
        "embeddedReferenceFrames": len(reference_embeddings),
    })
    template, reference_similarities, references_consistent = build_reference_template(reference_groups)
    if template is None:
        base["error"] = "Nicht jede gebundene Referenz enthielt eine eindeutig verfolgbare Identität."
        return base, [], 0

    base.update({
        "referenceSelfConsistencyMedian": median(reference_similarities),
        "referenceSelfConsistencyP10": percentile(reference_similarities, 0.10),
    })
    if not references_consistent:
        base["error"] = (
            "Die gebundenen Referenzen enthalten keine konsistente einzelne Zielidentität."
        )
        return base, [], 0

    output_similarities: list[float] = []
    output_embeddings: list[object] = []
    sampled_output_candidates = []
    for frame, timestamp in iter_sampled_video_frames_with_time(video_path, max_frames):
        candidates = detect_face_embeddings(detector, recognizer, frame)
        for candidate in candidates:
            candidate["timestamp"] = timestamp
        sampled_output_candidates.append(candidates)
    tracked_candidates, ambiguous_output_frames = track_output_identity(
        sampled_output_candidates,
        template,
    )
    for selected in tracked_candidates:
        output_similarities.append(cosine(selected["embedding"], template))
        output_embeddings.append(selected["embedding"])

    temporal_similarities = [
        cosine(left, right)
        for left, right in zip(output_embeddings, output_embeddings[1:])
    ]
    matched = len(output_similarities)
    sampled_output_frames = len(sampled_output_candidates)
    coverage = matched / sampled_output_frames if sampled_output_frames else 0.0
    measured = matched >= 8 and coverage >= 0.5
    base.update({
        "status": "measured" if measured else "insufficient",
        "sampledOutputFrames": sampled_output_frames,
        "matchedOutputFrames": matched,
        "outputCoverage": coverage,
        "ambiguousOutputFrames": ambiguous_output_frames,
        "cosineMedian": median(output_similarities),
        "cosineP10": percentile(output_similarities, 0.10),
        "cosineMinimum": min(output_similarities) if output_similarities else None,
        "outputTemporalConsistencyMedian": median(temporal_similarities),
    })
    return base, tracked_candidates, sampled_output_frames


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--video", required=True)
    parser.add_argument("--face-model", required=True)
    parser.add_argument("--identity-model", required=True)
    parser.add_argument(
        "--identity-status",
        choices=["available", "not-applicable", "reference-provenance-missing"],
        required=True,
    )
    parser.add_argument("--identity-reference", nargs=2, action="append", default=[])
    parser.add_argument("--max-frames", type=int, default=240)
    args = parser.parse_args()
    video_path = Path(args.video).expanduser().absolute()
    model_path = Path(args.face_model).expanduser().absolute()
    identity_model_path = Path(args.identity_model).expanduser().absolute()
    if not 8 <= args.max_frames <= 1000:
        raise ValueError("--max-frames must be between 8 and 1000")
    references = [
        (Path(path).expanduser().absolute(), expected_sha256)
        for path, expected_sha256 in args.identity_reference
    ]
    if args.identity_status == "available" and not references:
        raise ValueError("available identity status requires at least one reference")
    if any(not re.fullmatch(r"[0-9a-f]{64}", expected) for _path, expected in references):
        raise ValueError("identity reference SHA-256 must contain 64 lowercase hexadecimal characters")
    with analysis_snapshot_root() as snapshot_root:
        snapshot_sources = [
            (video_path, "Output video"),
            (model_path, "YuNet model"),
        ]
        if args.identity_status == "available":
            snapshot_sources.append((identity_model_path, "SFace model"))
            snapshot_sources.extend(
                (reference_path, "Identity reference")
                for reference_path, _expected_sha256 in references
            )
        enforce_snapshot_budget(snapshot_sources, snapshot_root)
        video_snapshot, video_sha256 = snapshot_verified_file(
            video_path,
            snapshot_root / f"output{video_path.suffix.lower()}",
            "Output video",
        )
        face_model_snapshot, _face_model_sha256 = snapshot_verified_file(
            model_path,
            snapshot_root / "yunet.onnx",
            "YuNet model",
            FACE_MODEL_SHA256,
        )
        identity_model_snapshot = identity_model_path
        reference_snapshots: list[tuple[Path, str]] = []
        if args.identity_status == "available":
            identity_model_snapshot, _identity_model_sha256 = snapshot_verified_file(
                identity_model_path,
                snapshot_root / "sface.onnx",
                "SFace model",
                IDENTITY_MODEL_SHA256,
            )
            for index, (reference_path, expected_sha256) in enumerate(references):
                snapshot, _reference_sha256 = snapshot_verified_file(
                    reference_path,
                    snapshot_root / f"reference-{index}{reference_path.suffix.lower()}",
                    "Identity reference",
                    expected_sha256,
                )
                reference_snapshots.append((snapshot, expected_sha256))
        identity_track: list[dict[str, object]] = []
        identity_sampled_frames = 0
        try:
            identity, identity_track, identity_sampled_frames = analyze_identity(
                video_snapshot,
                face_model_snapshot,
                identity_model_snapshot,
                args.identity_status,
                reference_snapshots,
                args.max_frames,
            )
        except Exception as error:  # noqa: BLE001
            identity = blank_identity("failed")
            identity["error"] = f"{type(error).__name__}: {error}"[:500]
        result = {
            "technical": probe_technical(video_snapshot),
            "face": (
                face_metrics_from_tracked_candidates(
                    identity_sampled_frames,
                    identity_track,
                )
                if args.identity_status == "available" and identity_sampled_frames > 0
                else analyze(video_snapshot, face_model_snapshot, args.max_frames)
            ),
            "identity": identity,
        }
        verify_snapshot(video_snapshot, video_sha256, "Output video")
        verify_snapshot(face_model_snapshot, FACE_MODEL_SHA256, "YuNet model")
        if args.identity_status == "available":
            verify_snapshot(identity_model_snapshot, IDENTITY_MODEL_SHA256, "SFace model")
        for reference_snapshot, expected_sha256 in reference_snapshots:
            verify_snapshot(reference_snapshot, expected_sha256, "Identity reference")
    json.dump(result, sys.stdout, ensure_ascii=True, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
